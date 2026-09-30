import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { H3_W6A8_FILES, h3W6a8Compatibility, probeH3W6a8, resolveH3Checkpoint } from "./h3-w6a8.js";
import { fitFor } from "./fit.js";
import { config, PREF_PATHS, prefsSnapshot, sessionOverride, overrideForSession, forgetPref } from "./config.js";
import { CATALOG, ModelManager, rightsStampFor } from "./models.js";
import { videoGraphH3 } from "./workflow.js";
import { knobRows, setKnob } from "./videolab/catalog.js";
import { modelKeyFromFiles } from "./engine/record.js";
import { createEngineClient } from "./engine/client.js";
import { append, read, verify } from "./provenance.js";

const compatible = { gpu: { vendor: "nvidia", name: "RTX 4070 Ti SUPER" }, torchBackend: "cuda",
  loader: true, kitchenSixbit: true, kitchenVersion: "0.2.36", torchCuda: "13.0" };

test("optional W6 files retain exact published identities and ordinary defaults", () => {
  assert.equal(H3_W6A8_FILES.length, 2);
  for (const build of H3_W6A8_FILES) {
    assert.equal(build.bytes, 15_983_746_636);
    assert.match(build.sha256, /^[a-f0-9]{64}$/);
    const row = CATALOG.find((entry) => entry.id === build.id);
    assert.equal(row.required, false);
    assert.equal(row.experimental, true);
    assert.equal(row.region, CATALOG.find((entry) => entry.id === "video").region);
    assert.equal(row.files[0].sha256, build.sha256);
    assert.equal(row.files[0].alt, undefined);
  }
  assert.equal(resolveH3Checkpoint({ current: "ordinary.safetensors", runtime: compatible, installed: true }).file,
    "ordinary.safetensors", "a downloaded experiment never becomes the automatic choice");
});

test("W6 readiness distinguishes NVIDIA eligibility, loader, kitchen and CUDA evidence", () => {
  assert.equal(h3W6a8Compatibility(compatible).ready, true);
  for (const vendor of ["amd", "intel", "apple"]) {
    const verdict = h3W6a8Compatibility({ ...compatible, gpu: { vendor } });
    assert.equal(verdict.ready, false);
    assert.equal(verdict.downloadable, false);
    assert.equal(verdict.state, "unsupported");
  }
  assert.equal(h3W6a8Compatibility({ ...compatible, torchBackend: "cpu" }).ready, false);
  assert.equal(h3W6a8Compatibility({ ...compatible, gpu: null }).ready, false);
  assert.equal(h3W6a8Compatibility({ ...compatible, loader: false }).ready, false);
  assert.equal(h3W6a8Compatibility({ ...compatible, kitchenSixbit: false, kitchenVersion: "0.2.34" }).ready, false);
  for (const torchCuda of [null, "None", "12.8"]) assert.equal(h3W6a8Compatibility({ ...compatible, torchCuda }).ready, false);
});

test("explicit W6 selections resolve each path and keep a missing or incompatible fallback", () => {
  const current = "existing_int8.safetensors";
  const w6 = resolveH3Checkpoint({ modelBuild: "w6a8", current, runtime: compatible, installed: true });
  assert.equal(w6.file, H3_W6A8_FILES[0].file);
  assert.equal(w6.fallback, null);
  assert.equal(resolveH3Checkpoint({ modelBuild: "w6a8", current, reference: true,
    runtime: compatible, installed: true }).file, H3_W6A8_FILES[1].file);
  const unavailable = resolveH3Checkpoint({ modelBuild: "w6a8", current, runtime: { ...compatible, kitchenSixbit: false } });
  assert.equal(unavailable.file, current);
  assert.equal(unavailable.requested, true);
  assert.match(unavailable.fallback, /six-bit/);
  const missing = resolveH3Checkpoint({ modelBuild: "w6a8", current, runtime: compatible });
  assert.equal(missing.file, current);
  assert.match(missing.fallback, /not installed/);
});

test("probe follows only the configured interpreter, including its plain .pth imports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiplay-w6-probe-"));
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  try {
    const comfyDir = path.join(root, "ComfyUI");
    const pkg = path.join(root, "engine-venv", "Lib", "site-packages");
    const inherited = path.join(root, "inherited", "Lib", "site-packages");
    await write(path.join(comfyDir, "comfy", "quant_ops.py"), 'QUANT_ALGOS["w6a8_int8"] = {}');
    await write(path.join(comfyDir, "comfy", "ops.py"), '_GROUPED_INT8_FORMATS = {"asym_w4a8_int8": 4, "w6a8_int8": 6}');
    await write(path.join(pkg, "comfy_kitchen", "tensor", "w4a8_int8.py"), 'bits: int = 4\n# 6-bit supported\ndef bits(cls): pass');
    await write(path.join(pkg, "comfy_kitchen-0.2.36.dist-info", "METADATA"), 'Version: 0.2.36\n');
    await write(path.join(pkg, "inherit.pth"), `${inherited}\nimport must_never_execute\n`);
    await write(path.join(inherited, "torch", "version.py"), 'cuda: str = "13.0"\n');
    const settings = { comfyDir, python: path.join(root, "engine-venv", "Scripts", "python.exe"),
      gpu: compatible.gpu, torchBackend: "cuda", modelsDir: path.join(root, "models") };
    const result = probeH3W6a8(settings);
    assert.equal(result.ready, true);
    assert.equal(result.kitchenVersion, "0.2.36");
    assert.equal(result.torchCuda, "13.0");
    assert.equal(result.packageRoot, pkg);
    assert.equal(result.files.fl2va.present, false);
    assert.equal(probeH3W6a8({ ...settings, python: path.join(root, "another-venv", "Scripts", "python.exe") }).ready,
      false, "an unconfigured working venv cannot certify the actual engine");
    await write(path.join(pkg, "comfy_kitchen", "tensor", "w4a8_int8.py"), '# old four-bit only\n');
    assert.equal(probeH3W6a8(settings).ready, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("NVIDIA-only W6 downloads refuse incompatible hardware before fetching", async () => {
  const before = { gpu: config.gpu, backend: config.torchBackend };
  try {
    config.gpu = { vendor: "amd" }; config.torchBackend = "rocm";
    await assert.rejects(new ModelManager().download("videoW6A8", { acceptRegion: true }), /NVIDIA CUDA/);
    const fit = fitFor(CATALOG.find((row) => row.id === "videoW6A8").requires,
      { gpu: { vendor: "intel", vramGb: 16 }, ram: { totalGb: 32 } });
    assert.equal(fit.state, "wont-run");
    assert.equal(fit.recommendable, false);
  } finally { config.gpu = before.gpu; config.torchBackend = before.backend; }
});

test("catalog status distinguishes installed files from a compatible runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiplay-w6-status-"));
  const before = { gpu: config.gpu, backend: config.torchBackend };
  const id = "test-w6-runtime-readiness";
  try {
    const dest = path.join(root, "small-test-fixture.safetensors");
    await fs.writeFile(dest, "abc");
    CATALOG.push({ id, label: "Fixture", compatibilityKind: "h3-w6a8", files: [{ dest, bytes: 3 }] });
    config.gpu = { vendor: "intel" }; config.torchBackend = "xpu";
    const row = (await new ModelManager().status()).find((entry) => entry.id === id);
    assert.equal(row.installed, true);
    assert.equal(row.haveBytes, 3);
    assert.equal(row.ready, false);
    assert.equal(row.compatibility.state, "unsupported");
  } finally {
    CATALOG.splice(CATALOG.findIndex((entry) => entry.id === id), 1);
    config.gpu = before.gpu; config.torchBackend = before.backend;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a W6 preference can retain its saved value while a session uses a fallback", () => {
  const validator = PREF_PATHS.find(([group, key]) => group === "video" && key === "h3ModelBuild")[2];
  assert.equal(validator("auto"), true); assert.equal(validator("w6a8"), true); assert.equal(validator("fp4"), false);
  const before = config.video.h3ModelBuild;
  try {
    config.video.h3ModelBuild = "w6a8";
    assert.equal(overrideForSession("video", "h3ModelBuild", "auto", "loader missing"), true);
    assert.equal(config.video.h3ModelBuild, "auto");
    assert.equal(prefsSnapshot().video.h3ModelBuild, "w6a8");
    assert.equal(sessionOverride("video", "h3ModelBuild").saved, "w6a8");
  } finally { config.video.h3ModelBuild = before; forgetPref("video", "h3ModelBuild"); }
});

test("the H3 graph records an unavailable selection without changing its prompt nodes", () => {
  const before = { gpu: config.gpu, backend: config.torchBackend };
  const opts = { prompt: "A train passes a farmhouse", seed: 7, seconds: 4, width: 832, height: 480, steps: 20 };
  try {
    config.gpu = { vendor: "amd" }; config.torchBackend = "rocm";
    const normal = videoGraphH3({ ...opts, h3ModelBuild: "auto" });
    const fallback = videoGraphH3({ ...opts, h3ModelBuild: "w6a8" });
    assert.equal(JSON.stringify(fallback), JSON.stringify(normal));
    assert.equal(fallback.h3CheckpointChoice.requestedBuild, "w6a8");
    assert.equal(fallback.h3CheckpointChoice.ranBuild, "auto");
    assert.match(fallback.h3CheckpointChoice.fallback, /NVIDIA CUDA/);
    assert.equal(Object.keys(fallback).includes("h3CheckpointChoice"), false, "receipt metadata must not be a Comfy node");
    const custom = videoGraphH3({ ...opts, h3ModelBuild: "w6a8", models: { dit: "custom_h3.safetensors" } });
    assert.equal(custom[1].inputs.unet_name, "custom_h3.safetensors");
    assert.equal(custom.h3CheckpointChoice.ranBuild, "custom");
    assert.throws(() => videoGraphH3({ ...opts, models: { dit: H3_W6A8_FILES[0].file } }), /cannot run/);
    const fast = videoGraphH3({ ...opts, engine: "fasth3", h3ModelBuild: "w6a8" });
    assert.equal(fast[1].inputs.unet_name, config.video.engines.fasth3.dit);
    assert.equal(fast.h3CheckpointChoice.selected, false);
  } finally { config.gpu = before.gpu; config.torchBackend = before.backend; }
});

test("an explicit checkpoint is preserved when pictures select the reference path", () => {
  const graph = videoGraphH3({ prompt: "A person waves", seed: 7, seconds: 4, width: 832, height: 480,
    steps: 20, refImages: ["reference.png"], models: { dit: "owner_reference_h3.safetensors" }, h3ModelBuild: "auto" });
  assert.equal(graph[1].inputs.unet_name, "owner_reference_h3.safetensors");
  assert.equal(graph.h3CheckpointChoice.file, graph[1].inputs.unet_name);
  assert.equal(graph.h3CheckpointChoice.ranBuild, "custom");
});

test("the shared Lab and MCP knob writes the requested build and reads both fallbacks", () => {
  const before = config.video.h3ModelBuild;
  try {
    const result = setKnob("h3_model_build", "w6a8");
    assert.equal(result.value, "w6a8");
    assert.equal(result.buildStatus.requestedBuild, "w6a8");
    assert.equal(knobRows("h3").find((row) => row.id === "h3_model_build").path, "video.h3ModelBuild");
    assert.ok(result.buildStatus.fl2va.file);
    assert.ok(result.buildStatus.ref2va.file);
    assert.throws(() => setKnob("h3_model_build", "fp4"), /must be one of/);
    assert.equal(config.video.h3ModelBuild, "w6a8");
  } finally { config.video.h3ModelBuild = before; forgetPref("video", "h3ModelBuild"); }
});

test("official W6 checkpoints produce H3 engine receipts with the canonical output-rights stamp", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aiplay-w6-receipts-"));
  const scope = { dir: temp };
  const posted = [];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const client = createEngineClient({ port: 12345, poll: { POLL_MS: 1 },
    provenance: { append: (_scope, event) => append(scope, event) },
    store: { readSettings: async () => ({}), resolveRecordFiles: async () => {},
      putGraph: async () => ({ path: null, existed: false }) },
    fetch: async (url, opts) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/prompt") { posted.push(JSON.parse(opts.body).prompt); return reply({ prompt_id: "w6-cpu-fixture" }); }
      if (pathname === "/history/w6-cpu-fixture") return reply({ "w6-cpu-fixture": { status: { completed: true }, outputs: {} } });
      throw new Error(`Unexpected mocked W6 engine request: ${pathname}`);
    } });
  client.attachChild({ exitCode: null, signalCode: null });
  try {
    for (const build of H3_W6A8_FILES) {
      assert.equal(CATALOG.find((cap) => cap.id === build.id).model, "h3");
      assert.equal(modelKeyFromFiles([{ file: build.file }]), "h3");
      assert.equal(modelKeyFromFiles([{ file: `diffusion_models\\${build.file.toUpperCase()}` }]), "h3");
      // Use the actual native graph builder, then swap only its checkpoint as
      // the paired benchmark does. No weights or GPU are loaded by this test.
      const graph = videoGraphH3({ prompt: "A red paper kite floats above a grassy hill", seed: 7,
        seconds: 3, width: 832, height: 480, steps: 8, h3ModelBuild: "auto",
        ...(build.role === "ref2va" ? { refImages: ["singer.png"] } : {}) });
      graph[1].inputs.unet_name = build.file;
      const result = await client.run({ graph, actor: "agent:w6-cpu-proof", via: "art.clip", adopt: false });
      assert.equal(result.status, "completed");
      assert.equal(posted.at(-1)[1].inputs.unet_name, build.file);
      assert.equal(result.record.model, "h3");
      const { events } = await read(scope, { asset: `engine/${result.runId}` });
      assert.deepEqual(events.map((event) => event.type), ["delegate", "generate"]);
      assert.equal(events[0].data.model, "h3");
      assert.equal(events[1].data.model, "h3");
      assert.deepEqual(events[1].data.outputRights, rightsStampFor("h3"), "the existing H3 rule supplies the rights");
      assert.equal(events[1].data.outputRights.capability, "video");
      assert.equal(events[1].data.outputRights.class, "yours-with-conditions");
    }
    assert.equal(modelKeyFromFiles([{ file: "owner_h3_w6a8.safetensors" }]), null, "an unknown filename stays unknown");
    assert.equal(modelKeyFromFiles([{ file: H3_W6A8_FILES[0].file },
      { file: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" }]), null, "competing generators stay ambiguous");
    assert.equal((await verify(scope)).ok, true);
  } finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("aiplay-w6-receipts-"));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
