import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, open, writeFile, rename, rm } from "node:fs/promises";

const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-h3-control-engine-"));
after(() => rm(root, { recursive: true, force: true }));
process.env.AIPLAY_APPDATA = path.join(root, "appdata");
const { createEngineClient } = await import("./engine/client.js");
const { TEXT_JUDGE_GRAPH } = await import("./engine/fixtures.js");
const { createStore } = await import("./engine/store.js");
const { buildRecord } = await import("./engine/record.js");
const { resolveGraphModels, applyModelOverrides } = await import("./localmodels.js");
const { H3_CONTROL_MODEL_INPUTS, isH3ControlModelInput } = await import("./h3-control-models.js");

test("Stop during deferred ledger preparation writes a rejected result and makes zero engine POSTs", async () => {
  let release, entered, cancelled = false;
  const waiting = new Promise((resolve) => { release = resolve; });
  const delegated = new Promise((resolve) => { entered = resolve; });
  const events = [], calls = [];
  const client = createEngineClient({ port: 47821,
    store: { readSettings: async () => ({}), resolveRecordFiles: async () => {}, graphStoreBytes: async () => ({ bytes: 0, count: 0 }), putGraph: async () => ({ path: "fixture.json", existed: false }) },
    provenance: { append: async (_scope, event) => { events.push(event); if (event.type === "delegate") { entered(); await waiting; } return { id: events.length }; } },
    fetch: async (...args) => { calls.push(args); throw new Error("No HTTP request is allowed after pre-submit Stop"); },
  });
  client.attachChild({ exitCode: null, signalCode: null });
  const running = client.run({ graph: TEXT_JUDGE_GRAPH, via: "art.control.depth", actor: "agent:cpu-test", cancelled: () => cancelled });
  await delegated; cancelled = true; release();
  const done = await running;
  assert.equal(done.status, "rejected"); assert.match(done.error, /Stopped before engine submission/);
  assert.equal(calls.length, 0);
  assert.deepEqual(events.map((event) => event.type), ["delegate", "generate"]);
  assert.equal(events[1].data.status, "rejected");
  assert.equal((await client.status()).running.length, 0);
});

test("ordinary callers without the internal cancellation callback retain their POST path", async () => {
  let posts = 0;
  const client = createEngineClient({ port: 47821,
    store: { readSettings: async () => ({}), resolveRecordFiles: async () => {}, putGraph: async () => ({ path: "fixture.json", existed: false }) },
    provenance: { append: async () => ({ id: "cpu-event" }) },
    fetch: async () => { posts++; return { ok: false, text: async () => "CPU fixture rejects intentional submission" }; },
  });
  client.attachChild({ exitCode: null, signalCode: null });
  await assert.rejects(client.run({ graph: TEXT_JUDGE_GRAPH, via: "art.clip", actor: "agent:cpu-test" }), /ComfyUI rejected/);
  assert.equal(posts, 1);
});

test("the last pre-submit guard receives the actual resolved graph and fails closed without a POST", async () => {
  let posts = 0, checked = false;
  const client = createEngineClient({ port: 47821,
    store: { readSettings: async () => ({}), resolveRecordFiles: async () => {}, graphStoreBytes: async () => ({ bytes: 0, count: 0 }), putGraph: async () => ({ path: "fixture.json", existed: false }) },
    provenance: { append: async () => ({ id: "cpu-event" }) },
    fetch: async () => { posts++; throw new Error("No POST permitted"); },
  });
  client.attachChild({ exitCode: null, signalCode: null });
  const done = await client.run({ graph: TEXT_JUDGE_GRAPH, via: "art.clip", actor: "agent:cpu-test", cancelled(graph) {
    checked = true; assert.deepEqual(graph, TEXT_JUDGE_GRAPH); throw new Error("The final selected checkpoint changed");
  } });
  assert.equal(checked, true); assert.equal(posts, 0); assert.equal(done.status, "rejected");
  assert.equal((await client.status()).running.length, 0);
});

test("guide model inputs stay fixed while ordinary upscaler model_name inputs still resolve", () => {
  assert.equal(isH3ControlModelInput("toString", "name"), false);
  assert.equal(isH3ControlModelInput("__proto__", "toString"), false);
  const depth = H3_CONTROL_MODEL_INPUTS.AiplayH3DepthGuide.model_name.name;
  const graph = { 1: { class_type: "AiplayH3DepthGuide", inputs: { model_name: depth } },
    2: { class_type: "ImageUpscaleWithModel", inputs: { model_name: "upscale.pth" } } };
  const files = [{ folder: "upscale_models", name: "wrong/" + depth, full: "/fixture/upscale/wrong-depth", bytes: 10 },
    { folder: "upscale_models", name: "nested/upscale.pth", full: "/fixture/upscale/right", bytes: 10 }];
  const rewritten = resolveGraphModels(graph, files);
  assert.equal(rewritten[1].inputs.model_name, depth);
  assert.equal(rewritten[2].inputs.model_name, "nested/upscale.pth");
  const overridden = applyModelOverrides(graph, { [depth]: "unrelated.pth", "upscale.pth": "chosen-upscale.pth" });
  assert.equal(overridden[1].inputs.model_name, depth);
  assert.equal(overridden[2].inputs.model_name, "chosen-upscale.pth");
});

test("the record names all three class-scoped guide weights", () => {
  const record = buildRecord({
    1: { class_type: "AiplayH3DepthGuide", inputs: { model_name: "depth_anything_v2_vits.pth" } },
    2: { class_type: "AiplayH3PoseGuide", inputs: { detector_name: "yolox_l.torchscript.pt", pose_name: "dw-ll_ucoco_384_bs5.torchscript.pt" } },
  });
  assert.deepEqual(record.engineFiles.map((file) => [file.class, file.input, file.file]), [
    ["AiplayH3DepthGuide", "model_name", "depth_anything_v2_vits.pth"],
    ["AiplayH3PoseGuide", "detector_name", "yolox_l.torchscript.pt"],
    ["AiplayH3PoseGuide", "pose_name", "dw-ll_ucoco_384_bs5.torchscript.pt"],
  ]);
});

test("guide records resolve only exact modern or legacy paths, never unrelated basename matches", async () => {
  const dir = path.join(root, "model-attribution"), models = path.join(dir, "models"), core = path.join(dir, "core");
  const field = H3_CONTROL_MODEL_INPUTS.AiplayH3DepthGuide.model_name;
  const modern = path.join(models, "controlnet", "aiplay_preprocessors", field.relative);
  const legacy = path.join(core, "custom_nodes", "comfyui_controlnet_aux", "ckpts", field.relative);
  await mkdir(path.dirname(modern), { recursive: true });
  // Only a zero-filled length fixture, never a model loaded or hashed. Its real
  // stat distinguishes an incomplete file from the node's exact size contract.
  const handle = await open(modern, "wx"); await handle.truncate(field.bytes); await handle.close();
  const store = createStore({ bases: [models], comfyDir: core, graphDir: path.join(dir, "graphs"), hashCacheFile: path.join(dir, "hashes.json") });
  assert.equal(await store.findModel(field.name, "model_name", "AiplayH3DepthGuide"), modern);
  const record = buildRecord({ 1: { class_type: "AiplayH3DepthGuide", inputs: { model_name: field.name } } });
  await store.resolveRecordFiles(record);
  assert.equal(record.engineFiles[0].bytes, field.bytes); assert.equal(record.engineFiles[0].resolvedPath, modern);
  assert.equal(record.engineFiles[0].sha256, null);
  await mkdir(path.dirname(legacy), { recursive: true }); await rename(modern, legacy);
  assert.equal(await store.findModel(field.name, "model_name", "AiplayH3DepthGuide"), legacy);
  const wrong = path.join(models, "upscale_models", field.name); await mkdir(path.dirname(wrong), { recursive: true }); await writeFile(wrong, "unrelated");
  await rm(legacy);
  assert.equal(await store.findModel(field.name, "model_name", "AiplayH3DepthGuide"), null);
  assert.equal(await store.findModel("an_arbitrary.pth", "model_name", "AiplayH3DepthGuide"), null);
});

test("ModelPatchLoader.name is recorded and resolves only its typed model_patches shelf", async () => {
  const dir = path.join(root, "patch-attribution"), models = path.join(dir, "models");
  const patch = path.join(models, "model_patches", "nested", "funcontrol.safetensors");
  const wrong = path.join(models, "diffusion_models", "nested", "funcontrol.safetensors");
  for (const file of [patch, wrong]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, file === patch ? "real patch fixture" : "wrong shelf"); }
  const graph = { 1: { class_type: "ModelPatchLoader", inputs: { name: "nested/funcontrol.safetensors" } },
    2: { class_type: "UnrelatedCustomNode", inputs: { name: "not-a-model" } } };
  const record = buildRecord(graph);
  assert.deepEqual(record.engineFiles.map(f => [f.class, f.input, f.file]), [["ModelPatchLoader", "name", "nested/funcontrol.safetensors"]]);
  const store = createStore({ bases: [models], graphDir: path.join(dir, "graphs"), hashCacheFile: path.join(dir, "hashes.json") });
  await store.resolveRecordFiles(record, { hashModels: true });
  assert.equal(record.engineFiles[0].resolvedPath, patch);
  assert.equal(record.engineFiles[0].bytes, 18);
  assert.match(record.engineFiles[0].sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await store.findModel("../funcontrol.safetensors", "name", "ModelPatchLoader"), null);
  await rm(patch);
  assert.equal(await store.findModel("nested/funcontrol.safetensors", "name", "ModelPatchLoader"), null, "never fall back to same-named DiT");
});

test("the bundled full-width loader name has the same precise model-patch attribution", async () => {
  const dir = path.join(root, "full-patch-attribution"), models = path.join(dir, "models");
  const full = path.join(models, "model_patches", "original.safetensors");
  await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, "original raw patch");
  const record = buildRecord({ 1: { class_type: "AiplayH3FullControlPatchLoader", inputs: { name: "original.safetensors" } } });
  const store = createStore({ bases: [models], graphDir: path.join(dir, "graphs"), hashCacheFile: path.join(dir, "hashes.json") });
  await store.resolveRecordFiles(record);
  assert.equal(record.engineFiles.length, 1);
  assert.equal(record.engineFiles[0].resolvedPath, full);
  assert.equal(record.engineFiles[0].bytes, 18);
});

test("only the two typed patch loaders resolve name aliases onto model_patches", () => {
  const graph = { 1: { class_type: "ModelPatchLoader", inputs: { name: "patch.safetensors" } },
    2: { class_type: "AiplayH3FullControlPatchLoader", inputs: { name: "patch.safetensors" } },
    3: { class_type: "UnrelatedNode", inputs: { name: "patch.safetensors" } } };
  const files = [{ folder: "model_patches", name: "nested/patch.safetensors", full: "/fixture/patch", bytes: 10 },
    { folder: "diffusion_models", name: "other/patch.safetensors", full: "/fixture/dit", bytes: 10 }];
  const resolved = resolveGraphModels(graph, files);
  assert.equal(resolved[1].inputs.name, "nested/patch.safetensors");
  assert.equal(resolved[2].inputs.name, "nested/patch.safetensors");
  assert.equal(resolved[3].inputs.name, "patch.safetensors");
});
