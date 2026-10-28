import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, unlink, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createH3VideoControl, h3ControlGraph, h3ControlOptions, videoControlSha, videoControlTerminal, resolveVideoControlModel, probeVideoControl } from "./h3-video-control.js";
import { ffmpegPath } from "./clipjoin.js";

const target = { width: 1344, height: 768, frames: 124, fps: 24 };
const sourceMedia = { width: 1280, height: 720, frames: 180, fps: 30, seconds: 6 };
const patchName = "MiniMax-H3-Fun-Controlnet-Union.safetensors";
function nodeSchemas() {
  const fields = (names) => Object.fromEntries(names.split(" ").map((key) => [key, ["IMAGE"]]));
  return {
    MiniMaxH3FunControlNetApply: { input: { required: fields("model model_patch vae strength start_percent end_percent"), optional: fields("control_video") } },
    ModelPatchLoader: { input: { required: { name: [[patchName]] } } },
    AiplayH3FullControlPatchLoader: { input: { required: { name: [[patchName]] } } },
    LoadVideo: { input: { required: fields("file") } }, GetVideoComponents: { input: { required: fields("video") } },
    ImageScale: { input: { required: fields("image upscale_method width height crop") } },
    ImageFromBatch: { input: { required: fields("image batch_index length") } },
    CreateVideo: { input: { required: fields("images fps") } }, SaveVideo: { input: { required: fields("video filename_prefix format codec") } },
    AiplayH3DepthGuide: { input: { required: { ...fields("images resolution"), model_name: [["depth_anything_v2_vits.pth"]] } } },
    AiplayH3PoseGuide: { input: { required: { ...fields("images resolution"), detector_name: ["COMBO", { options: ["yolox_l.torchscript.pt"] }],
      pose_name: [["dw-ll_ucoco_384_bs5.torchscript.pt"]] } } },
  };
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-h3-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clipDir = path.join(root, "clips"), inputDir = path.join(root, "input"), outputDir = path.join(root, "output");
  for (const dir of [clipDir, inputDir, path.join(outputDir, "h3control")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(clipDir, "source.mp4"), "the original video");
  const catalog = [];
  for (const [id, name] of [["videoH3FunControl", patchName], ["depthPreprocess", "depth.pth"], ["posePreprocess", "pose.pt"]]) {
    const dest = path.join(root, name); await writeFile(dest, "model");
    catalog.push({ id, label: id, files: [{ dest, bytes: 5 }] });
  }
  catalog.push({ ...catalog[0], id: "videoH3FunControlFull" });
  await mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  await writeFile(path.join(root, "models", "diffusion_models", "base.safetensors"), "metadata fixture");
  const log = [], schemas = nodeSchemas();
  let holds = 0;
  const engine = {
    objectInfo: async (name) => ({ [name]: schemas[name] }),
    hold: (label) => { holds++; log.push(["hold", label]); return () => { holds--; log.push(["release"]); }; },
    run: async (spec) => {
      assert.equal(holds, 1, "the same engine hold covers extraction");
      log.push(["run", spec]);
      const prefix = spec.graph[26].inputs.filename_prefix;
      const file = path.basename(prefix) + "_00001_.mp4";
      await writeFile(path.join(outputDir, "h3control", file), "the extracted control video");
      return { status: "completed", runId: "preprocess-cpu", outputs: [
        { type: "input", node: "20", file: spec.graph[20].inputs.file },
        { type: "output", node: "26", subfolder: "h3control", file },
      ] };
    },
  };
  const probe = async (file) => path.dirname(file) === clipDir || /_source\./.test(file) ? sourceMedia : { ...target, seconds: target.frames / target.fps };
  const conform = async (_src, dest) => writeFile(dest, "the normalized video");
  const serviceOptions = { clipDir, inputDir, outputDir, catalog, engine, probe, conform,
    selectCheckpoint: () => ({ file: "base.safetensors", reference: false }),
    inspectHeader: async (file) => { const s = await stat(file); return { form: "full", bytes: s.size, mtimeMs: s.mtimeMs, headerSha256: "f".repeat(64) }; },
    ...overrides, modelConfig: { modelsDir: path.join(root, "models"), comfy: { extraArgs: [] }, ...overrides.modelConfig } };
  const service = createH3VideoControl(serviceOptions);
  return { root, clipDir, inputDir, outputDir, catalog, schemas, engine, service, serviceOptions, log, holds: () => holds };
}

test("control options are explicit, finite and ordered; omitted mode is depth", () => {
  assert.equal(h3ControlOptions({}), null);
  assert.deepEqual(h3ControlOptions({ sourceVideo: "source.mp4" }), { source: "source.mp4", mode: "depth", strength: 1, start: 0, end: 1 });
  assert.equal(h3ControlOptions({ source_video: "source.mp4", control_mode: "prepared" }).mode, "prepared");
  for (const change of [{ controlMode: "raw" }, { controlStrength: "1" }, { controlStrength: NaN }, { controlStart: -1 },
    { controlEnd: 1.1 }, { controlStart: 0.5, controlEnd: 0.5 }, { controlStart: 1 }, { source_video: "other.mp4" }])
    assert.throws(() => h3ControlOptions({ sourceVideo: "source.mp4", ...change }), { reason: "control-options" });
  assert.throws(() => h3ControlOptions({ controlMode: "pose" }), /Choose a source/);
});

test("H3 extractors keep short aligned frame counts and explicit Small/TorchScript choices", () => {
  const depth = h3ControlGraph({ source: "owned.mp4", mode: "depth", ...target, frames: 56, prefix: "owned" });
  assert.equal(depth[22].inputs.length, 56, "no VACE 121-frame floor");
  assert.deepEqual(depth[23], { class_type: "AiplayH3DepthGuide", inputs: { images: ["22", 0], model_name: "depth_anything_v2_vits.pth", resolution: 768 } });
  assert.deepEqual(depth[24].inputs, { image: ["23", 0], upscale_method: "bilinear", width: 1344, height: 768, crop: "center" });
  const pose = h3ControlGraph({ source: "owned.mp4", mode: "pose", ...target, prefix: "owned" });
  assert.equal(pose[23].inputs.detector_name, "yolox_l.torchscript.pt");
  assert.equal(pose[23].inputs.pose_name, "dw-ll_ucoco_384_bs5.torchscript.pt");
  assert.equal(pose[25].inputs.fps, 24);
  assert.equal(JSON.stringify(pose).includes("onnx"), false);
});

test("the shared check hashes the real source without staging or spending a run", async (t) => {
  const f = await fixture(t);
  const plan = await f.service.check({ sourceVideo: "source.mp4" }, target);
  assert.equal(plan.source.sha256, await videoControlSha(path.join(f.clipDir, "source.mp4")));
  assert.deepEqual(plan.target, target);
  assert.equal(plan.patch, patchName);
  assert.equal(plan.mode, "depth");
  assert.deepEqual(await readdir(f.inputDir), []);
  assert.deepEqual(f.log, []);
  assert.equal(JSON.stringify(plan).includes(f.root), false, "no paths cross the route boundary");
});

test("paths, escaped links, short clips and incompatible instructions fail before staging or GPU", async (t) => {
  const f = await fixture(t);
  for (const name of ["../source.mp4", "C:\\source.mp4", "/source.mp4", "source.mp4:payload", "audio.wav", "missing.mp4"])
    await assert.rejects(f.service.check({ sourceVideo: name }, target));
  for (const request of [{ loop: true }, { refMods: [{ name: "cache" }] }, { continueFrom: { file: "x" } },
    { h3Tweaks: { detail: 1 } }, { bridge: "adapter" }, { blockCache: true }, { sparse: "sol-attn" }])
    await assert.rejects(f.service.check({ sourceVideo: "source.mp4", ...request }, target), { reason: "control-options" });
  await assert.rejects(f.service.check({ sourceVideo: "source.mp4" }, { ...target, engineKey: "fasth3" }), { reason: "control-engine" });
  await assert.rejects(f.service.check({ sourceVideo: "source.mp4" }, { ...target, customWorkflow: true }), { reason: "workflow-incompatible" });
  const short = await fixture(t, { probe: async () => ({ ...sourceMedia, seconds: 5 }) });
  await assert.rejects(short.service.check({ sourceVideo: "source.mp4" }, target), /124 frames.*not padded/);
  const outside = path.join(f.root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret.mp4"), "secret");
  // Directory junctions do not need Windows symlink privileges. Canonical containment
  // is exercised through an owned library alias; the source path itself remains a name.
  const linkedLibrary = path.join(f.clipDir, "directory-link.mp4");
  await symlink(outside, linkedLibrary, process.platform === "win32" ? "junction" : "dir");
  const service = createH3VideoControl({ clipDir: f.clipDir, engine: f.engine, catalog: f.catalog, probe: async () => sourceMedia });
  await assert.rejects(service.check({ sourceVideo: "directory-link.mp4" }, target), /regular file/);
  if (process.platform !== "win32") {
    await symlink(path.join(outside, "secret.mp4"), path.join(f.clipDir, "escape.mp4"));
    await assert.rejects(service.check({ sourceVideo: "escape.mp4" }, target), /regular file/);
  }
  assert.deepEqual(await readdir(f.inputDir), []);
  assert.deepEqual(f.log, []);
});

test("model/node readiness refuses missing or wrong-size files and exact model-name schemas", async (t) => {
  const f = await fixture(t);
  await writeFile(f.catalog[1].files[0].dest, "truncated");
  await assert.rejects(f.service.check({ sourceVideo: "source.mp4" }, target), (error) => error.needsModel.id === "depthPreprocess");
  await writeFile(f.catalog[1].files[0].dest, "model");
  delete f.schemas.AiplayH3DepthGuide;
  await assert.rejects(f.service.check({ sourceVideo: "source.mp4" }, target), (error) => error.needsNodes[0] === "AiplayH3DepthGuide");
  f.schemas.AiplayH3DepthGuide = nodeSchemas().AiplayH3DepthGuide;
  f.schemas.AiplayH3DepthGuide.input.required.model_name = ["COMBO", { options: ["depth_anything_v2_vitl.pth"] }];
  await assert.rejects(f.service.check({ sourceVideo: "source.mp4" }, target), /required depth_anything_v2_vits/);
  assert.equal((await f.service.check({ sourceVideo: "source.mp4", controlMode: "pose" }, target)).mode, "pose");
  assert.deepEqual(f.log, []);
});

test("catalogue readiness uses configured extra shelves and declared alternate builds, refusing ambiguous copies", async (t) => {
  const f = await fixture(t), modelsDir = path.join(f.root, "models"), extra = path.join(f.root, "extra");
  await mkdir(path.join(extra, "model_patches", "nested"), { recursive: true });
  const primary = path.join(extra, "model_patches", "nested", patchName);
  await writeFile(primary, "model");
  const file = { dest: path.join(modelsDir, "model_patches", patchName), bytes: 5, alt: ["h3_control_bf16.safetensors"] };
  const modelConfig = { modelsDir, modelsAlso: [extra], comfy: { extraArgs: [] } };
  assert.equal((await resolveVideoControlModel(file, { modelConfig })).name, path.join("nested", patchName));
  await writeFile(primary, "wrong primary size");
  assert.equal(await resolveVideoControlModel(file, { modelConfig }), null);
  const alternative = path.join(extra, "model_patches", "h3_control_bf16.safetensors");
  await writeFile(alternative, "allowed alternate build");
  assert.equal((await resolveVideoControlModel(file, { modelConfig })).name, "h3_control_bf16.safetensors");
  await unlink(primary);
  await mkdir(path.join(extra, "model_patches", "another"));
  await writeFile(path.join(extra, "model_patches", "another", patchName), "model");
  await writeFile(primary, "model");
  await assert.rejects(resolveVideoControlModel(file, { modelConfig }), /More than one/);
});

test("a queued source replacement is refused before hold, staging or preprocessing", async (t) => {
  const f = await fixture(t), plan = await f.service.check({ sourceVideo: "source.mp4" }, target);
  await writeFile(path.join(f.clipDir, "source.mp4"), "a replacement source");
  await assert.rejects(f.service.prepare(plan), /changed while.*queued/);
  assert.deepEqual(f.log, []); assert.deepEqual(await readdir(f.inputDir), []);
});

test("saved bridge and block-cache defaults cannot enter a controlled render implicitly", async (t) => {
  const f = await fixture(t, { modelConfig: { video: { engines: { h3: { bridge: "saved-adapter", bridgeAlpha: 0.4, blockCache: true } } } } });
  await assert.rejects(f.service.check({ sourceVideo: "source.mp4" }, target), { reason: "control-options" });
  assert.equal((await f.service.check({ sourceVideo: "source.mp4", bridge: "off", blockCache: false }, target)).mode, "depth");
  assert.deepEqual(f.log, []);
});

test("preparation binds normalized and extracted bytes and keeps its hold until final cleanup", async (t) => {
  const f = await fixture(t), plan = await f.service.check({ sourceVideo: "source.mp4" }, target);
  const before = await readFile(path.join(f.clipDir, "source.mp4"));
  const prepared = await f.service.prepare(plan, { actor: "agent:cpu-test", label: "owned shot" });
  const call = f.log.find(([kind]) => kind === "run")[1];
  assert.equal(call.actor, "agent:cpu-test"); assert.equal(call.via, "art.control.depth"); assert.equal(call.adopt, false);
  assert.equal(f.holds(), 1);
  assert.equal(prepared.receipt.preprocessRunId, "preprocess-cpu");
  assert.equal(prepared.receipt.patch, prepared.patch);
  assert.equal(prepared.receipt.controlSha256, await videoControlSha(path.join(f.inputDir, prepared.file)));
  assert.notEqual(prepared.receipt.normalizedSha256, prepared.receipt.source.sha256);
  assert.deepEqual(await readFile(path.join(f.clipDir, "source.mp4")), before);
  assert.equal((await readdir(f.inputDir)).length, 3);
  await prepared.cleanup(); await prepared.cleanup();
  assert.equal(f.holds(), 0); assert.deepEqual(await readdir(f.inputDir), []);
  assert.deepEqual(await readdir(path.join(f.outputDir, "h3control")), []);
});

test("simultaneous preparations use distinct exclusive files and independent cleanup", async (t) => {
  const f = await fixture(t), plan = await f.service.check({ sourceVideo: "source.mp4", controlMode: "prepared" }, target);
  const [a, b] = await Promise.all([f.service.prepare(plan), f.service.prepare(plan)]);
  assert.notEqual(a.file, b.file); assert.equal(f.holds(), 2);
  await a.cleanup(); assert.ok((await readFile(path.join(f.inputDir, b.file))).length);
  await b.cleanup(); assert.equal(f.holds(), 0);
  assert.equal(f.log.filter(([kind]) => kind === "run").length, 0);
});

test("cancellation before extraction and malformed conform output clean only owned stages", async (t) => {
  const f = await fixture(t), plan = await f.service.check({ sourceVideo: "source.mp4" }, target);
  let checks = 0;
  await writeFile(path.join(f.inputDir, "unrelated.mp4"), "keep");
  await assert.rejects(f.service.prepare(plan, { cancelled: () => ++checks > 1 }), /stopped/);
  assert.equal(f.holds(), 0); assert.deepEqual(await readdir(f.inputDir), ["unrelated.mp4"]);
  assert.equal(f.log.filter(([kind]) => kind === "run").length, 0);
  const broken = await fixture(t, { probe: async (file) => path.basename(file) === "source.mp4" ? sourceMedia : { ...target, frames: 123 } });
  const badPlan = await broken.service.check({ sourceVideo: "source.mp4" }, target);
  await assert.rejects(broken.service.prepare(badPlan), /does not match/);
  assert.equal(broken.holds(), 0); assert.deepEqual(await readdir(broken.inputDir), []);
  assert.equal(broken.log.filter(([kind]) => kind === "run").length, 0);
});

test("known native failure cleans; timeout preserves stages and never resubmits", async (t) => {
  for (const [status, known] of [["error", true], ["timeout", false]]) {
    const f = await fixture(t), plan = await f.service.check({ sourceVideo: "source.mp4" }, target);
    let runs = 0;
    f.engine.run = async () => { runs++; return { status, runId: "owned-failure", entry: known ? { status: { status_str: "error" } } : null }; };
    await assert.rejects(f.service.prepare(plan), (error) => known ? !error.controlRetained : error.controlRetained.length === 2);
    assert.equal(runs, 1); assert.equal(f.holds(), 0);
    assert.equal((await readdir(f.inputDir)).length, known ? 0 : 2);
  }
  assert.equal(videoControlTerminal({ status: "error", ledger: { generate: "exists" } }), false, "a recorded network error is not terminal engine proof");
});

test("a final render with unknown outcome retains prepared files for inspection", async (t) => {
  const f = await fixture(t), plan = await f.service.check({ sourceVideo: "source.mp4", controlMode: "prepared" }, target);
  const prepared = await f.service.prepare(plan);
  const kept = await prepared.cleanup({ known: false });
  assert.equal(kept.retained.length, 2); assert.equal(f.holds(), 0);
  assert.ok((await readFile(path.join(f.inputDir, prepared.file))).length);
});

test("cleanup does not delete a replacement at an owned staging name", async (t) => {
  const f = await fixture(t), plan = await f.service.check({ sourceVideo: "source.mp4", controlMode: "prepared" }, target);
  const prepared = await f.service.prepare(plan), file = path.join(f.inputDir, prepared.file);
  await unlink(file); await writeFile(file, "another owner");
  const result = await prepared.cleanup();
  assert.equal(await readFile(file, "utf8"), "another owner"); assert.ok(result.retained.includes(file));
});

test("real CPU conform produces the exact H3 frame count and leaves the source intact", async (t) => {
  const exec = promisify(execFile);
  try { await exec(ffmpegPath(), ["-version"], { windowsHide: true, timeout: 10_000 }); }
  catch (error) { if (error.code === "ENOENT") return t.skip("ffmpeg is not installed; mocked lifecycle and graph tests still ran"); throw error; }
  const f = await fixture(t), source = path.join(f.clipDir, "source.mp4");
  await exec(ffmpegPath(), ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=24", "-frames:v", "60", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { windowsHide: true, timeout: 30_000 });
  const before = await videoControlSha(source);
  const service = createH3VideoControl({ ...f.serviceOptions, probe: probeVideoControl, conform: null });
  const plan = await service.check({ sourceVideo: "source.mp4", controlMode: "prepared" }, { width: 64, height: 64, frames: 56, fps: 24 });
  const prepared = await service.prepare(plan);
  assert.equal(await videoControlSha(source), before);
  assert.equal(prepared.receipt.target.frames, 56); assert.equal(f.log.filter(([kind]) => kind === "run").length, 0);
  await prepared.cleanup(); assert.deepEqual(await readdir(f.inputDir), []);
});
