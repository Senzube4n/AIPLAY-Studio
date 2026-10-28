import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";
import { CATALOG } from "./models.js";
import { videoPlan } from "./video-plain.js";
import { createH3VideoControl } from "./h3-video-control.js";
import { h3ControlHeader, h3ControlCheckpointSelection, effectiveH3ControlCheckpoint, validateFullH3ControlHeader, validateFullH3ControlRawHeader } from "./h3-control-compat.js";
const officialHeader = JSON.parse(await readFile(new URL("./fixtures/h3-full-control-header.json", import.meta.url), "utf8"));

const tensor = (shape) => ({ shape, dtype: "BF16", data_offsets: [0, 2] });
function baseHeader(width = 2688) {
  const h = { "video_patch_proj.weight": tensor([5376, 96]), "blocks.0.attn.qkv_proj.weight": tensor([21504, 5376]) };
  for (let i = 0; i < 50; i++) h[`blocks.${i}.adaln_proj.linear.weight`] = tensor([96768, width]);
  if (width === 2688) {
    h["time_embedder.proj_in.weight"] = tensor([5376, 256]); h["time_embedder.proj_out.weight"] = tensor([2688, 5376]);
  } else h.adaln_t_table = { shape: [1025, 8], dtype: "F32", data_offsets: [0, 32800] };
  return h;
}
function patchHeader(width = 2688) {
  const h = { __metadata__: width === 8 ? { minimax_h3_fun_controlnet: "adaln_basis" } : { format: "pt" },
    "control_proj_in.weight": tensor([5376, 196]) };
  for (let i = 0; i < 5; i++) h[`control_blocks.${i}.adaln_proj.linear.weight`] = tensor([96768, width]);
  const keys = width === 8 ? ["attn.qkv_proj.weight", "mlp.fc1.weight"] : ["attn.to_q.weight", "attn.to_k.weight", "attn.to_v.weight", "ff.net.0.proj.weight"];
  for (const key of keys) h["control_blocks.0." + key] = tensor([1, 1]);
  return h;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-h3-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function header(name, h, data = Buffer.alloc(2)) {
    const bytes = Buffer.from(JSON.stringify(h)), prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(bytes.length));
    const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true });
    // Deliberately tiny metadata fixtures. No estimator or diffusion weights
    // are loaded; only the small table range is a real numerical payload.
    await writeFile(file, Buffer.concat([prefix, bytes, data])); return file;
  }
  return { root, header };
}

test("the actual graph selector respects plain/reference, per-render parts and saved choices", () => {
  const old = { dit: config.video.engines.h3.dit, ditRef: config.video.engines.h3.ditRef, build: config.video.h3ModelBuild };
  try {
    Object.assign(config.video.engines.h3, { dit: "saved-plain.safetensors", ditRef: "saved-ref.safetensors" }); config.video.h3ModelBuild = "auto";
    const ctx = { width: 1344, height: 768, fps: 24, frames: 124 };
    assert.equal(h3ControlCheckpointSelection({}, ctx).file, "saved-plain.safetensors");
    assert.equal(h3ControlCheckpointSelection({}, { ...ctx, refImages: ["person.png"] }).file, "saved-ref.safetensors");
    assert.equal(h3ControlCheckpointSelection({}, { ...ctx, refAudios: [{ name: "song.wav" }] }).file, "saved-ref.safetensors");
    assert.equal(h3ControlCheckpointSelection({ firstFrame: "first.png", lastFrame: "last.png", midFrames: ["mid.png"], audioTrack: { name: "song.wav" } }, ctx).file, "saved-plain.safetensors");
    const plan = videoPlan({ prompt: "Nia turns.", steps: 20 }, { engineKey: "h3", eng: config.video.engines.h3,
      persona: { name: "Nia", refImages: ["persona.png"] }, control: true });
    assert.equal(h3ControlCheckpointSelection({}, { ...ctx, refImages: plan.refImages }).file, "saved-ref.safetensors");
    assert.equal(h3ControlCheckpointSelection({}, { ...ctx, refImages: ["person.png"], models: { dit: "picked.safetensors", ditRef: "picked-ref.safetensors" } }).file, "picked-ref.safetensors");
    assert.equal(h3ControlCheckpointSelection({}, { ...ctx, refImages: ["person.png"], models: { dit: "picked.safetensors" } }).file, "picked.safetensors");
  } finally { Object.assign(config.video.engines.h3, { dit: old.dit, ditRef: old.ditRef }); config.video.h3ModelBuild = old.build; }
});

test("effective checkpoint selection uses the same one-hop override and shelf-relative resolver as dispatch", () => {
  const shelf = [{ folder: "diffusion_models", name: "nested/effective.safetensors", full: "/fixture/effective", bytes: 2 }];
  const chosen = effectiveH3ControlCheckpoint("saved.safetensors", { "saved.safetensors": "effective.safetensors", "effective.safetensors": "ignored-second-hop" }, shelf);
  assert.deepEqual(chosen, { requested: "saved.safetensors", overridden: "effective.safetensors", name: "nested/effective.safetensors", file: "/fixture/effective" });
  assert.throws(() => effectiveH3ControlCheckpoint("missing", {}, shelf), { reason: "control-compatibility" });
});

test("full base/patch headers are recognized by actual keys and all modulation shapes", async t => {
  const f = await fixture(t);
  const base = await f.header("full-base.safetensors", baseHeader()), patch = await f.header("full-patch.safetensors", patchHeader());
  assert.equal((await h3ControlHeader(base)).form, "full");
  await assert.rejects(h3ControlHeader(patch, { patch: true }), /supported original v1 tensor layout/);
  assert.doesNotThrow(() => validateFullH3ControlHeader(officialHeader, 8184, 6806843904));
  const mixed = baseHeader(); mixed["blocks.32.adaln_proj.linear.weight"] = tensor([96768, 8]);
  await assert.rejects(h3ControlHeader(await f.header("mixed.safetensors", mixed)), /inconsistent AdaLN/);
  const wrong = patchHeader(); wrong.__metadata__.minimax_h3_fun_controlnet = "adaln_basis";
  await assert.rejects(h3ControlHeader(await f.header("wrong-metadata.safetensors", wrong), { patch: true }), /unknown H3 modulation/);
});

test("the exact original full-patch layout rejects missing/extra/different tensors, metadata, offsets and length", () => {
  for (const mutate of [h => { delete h["control_blocks.4.attn.to_v.weight"]; },
    h => { h["control_blocks.5.attn.to_q.weight"] = tensor([7168, 5376]); },
    h => { h["control_proj_in.weight"].dtype = "BF16"; },
    h => { h["control_blocks.0.adaln_proj.linear.weight"].shape[1] = 8; },
    h => { h["control_proj_in.weight"].data_offsets[0]++; },
    h => { h.__metadata__.minimax_h3_fun_controlnet = "adaln_basis"; }]) {
    const changed = structuredClone(officialHeader); mutate(changed);
    assert.throws(() => validateFullH3ControlHeader(changed, 8184, 6806843904), /supported original v1 tensor layout/);
  }
  assert.throws(() => validateFullH3ControlHeader(officialHeader, 8184, 6806843903));
  assert.throws(() => validateFullH3ControlHeader(officialHeader, 8183, 6806843904));
  const raw = Buffer.from(JSON.stringify(officialHeader).padEnd(8184, " "));
  assert.doesNotThrow(() => validateFullH3ControlRawHeader(raw));
  const altered = Buffer.from(raw); altered[8183] = 9;
  assert.throws(() => validateFullH3ControlRawHeader(altered), /header bytes/);
});

test("8-wide headers alone cannot establish basis compatibility; the bounded table digest must be pinned", async t => {
  const f = await fixture(t), table = Buffer.alloc(32800), signature = createHash("sha256").update(table).digest("hex");
  const file = await f.header("unproven-curve.safetensors", baseHeader(8), table);
  await assert.rejects(h3ControlHeader(file), /unverified curve basis/);
  const allowedFixture = await h3ControlHeader(file, { stockTables: { [signature]: "synthetic-test-only" } });
  assert.equal(allowedFixture.form, "stock-curve"); assert.equal(allowedFixture.tableSha256, signature);
  const truncated = await f.header("truncated-table.safetensors", baseHeader(8));
  await assert.rejects(h3ControlHeader(truncated), /truncated or out of bounds/);
  const incompatible = baseHeader(8); incompatible.adaln_t_table.dtype = "F16";
  await assert.rejects(h3ControlHeader(await f.header("wrong-table-type.safetensors", incompatible, table)), /unsupported table layout/);
});

test("full checkpoints offer the separate matching download before any staging and bind the queued selection", async t => {
  const f = await fixture(t), models = path.join(f.root, "models"), clips = path.join(f.root, "clips"), input = path.join(f.root, "input");
  await mkdir(clips); await mkdir(input); await writeFile(path.join(clips, "source.mp4"), "source video");
  const base = await f.header("models/diffusion_models/Singularity.safetensors", baseHeader());
  const originalName = "MiniMax-H3-Fun-Controlnet-Union.safetensors";
  const patch = await f.header("models/model_patches/" + originalName, patchHeader());
  const patchSize = (await stat(patch)).size, source = { width: 64, height: 64, fps: 24, frames: 56, seconds: 3 };
  const target = { width: 64, height: 64, fps: 24, frames: 56 };
  const schemas = Object.fromEntries(Object.entries({ AiplayH3FullControlPatchLoader: ["name"], MiniMaxH3FunControlNetApply: ["model", "model_patch", "vae", "strength", "start_percent", "end_percent", "control_video"],
    LoadVideo: ["file"], GetVideoComponents: ["video"], ImageScale: ["image", "upscale_method", "width", "height", "crop"] }).map(([name, fields]) => [name, { input: { required: Object.fromEntries(fields.map(key => [key, key === "name" ? [[originalName]] : ["IMAGE"]])) } }]));
  const modelConfig = { modelsDir: models, comfy: { extraArgs: [] }, modelOverrides: {} }, catalog = [{ id: "videoH3FunControlFull", label: "Full-width control", files: [{ dest: patch, bytes: patchSize }] }];
  let spent = 0;
  const service = createH3VideoControl({ clipDir: clips, inputDir: input, outputDir: path.join(f.root, "output"), modelConfig, catalog,
    selectCheckpoint: () => ({ file: "Singularity.safetensors", reference: true }), probe: async () => source,
    inspectHeader: async (file, options) => options?.patch ? { form: "full", bytes: patchSize, mtimeMs: (await stat(file)).mtimeMs, headerSha256: "f".repeat(64) } : h3ControlHeader(file),
    engine: { objectInfo: async name => ({ [name]: schemas[name] }), run: async () => { spent++; }, hold: () => { spent++; } } });
  const plan = await service.check({ sourceVideo: "source.mp4", controlMode: "prepared" }, target);
  assert.equal(plan.patchId, "videoH3FunControlFull"); assert.equal(plan.patchLoader, "AiplayH3FullControlPatchLoader");
  assert.equal(plan.checkpoint.name, "Singularity.safetensors"); assert.equal(JSON.stringify(plan).includes(f.root), false);
  assert.deepEqual(await readdir(input), []); assert.equal(spent, 0);
  const removed = catalog.pop();
  await assert.rejects(service.check({ sourceVideo: "source.mp4", controlMode: "prepared" }, target), e => e.needsModel?.id === "videoH3FunControlFull");
  catalog.push(removed);
  modelConfig.modelOverrides[originalName] = "renamed-raw.safetensors";
  await assert.rejects(service.check({ sourceVideo: "source.mp4", controlMode: "prepared" }, target), /original.*filename/);
  delete modelConfig.modelOverrides[originalName];
  await service.revalidate(plan);
  const checkedGraph = { 1: { class_type: "UNETLoader", inputs: { unet_name: plan.checkpoint.name } },
    33: { class_type: plan.patchLoader, inputs: { name: plan.patchName } } };
  assert.doesNotThrow(() => service.assertSelection(plan, checkedGraph));
  assert.throws(() => service.assertSelection(plan, { ...checkedGraph, 1: { inputs: { unet_name: "alias-changed.safetensors" } } }), /final engine graph/);
  assert.throws(() => service.assertSelection(plan, { ...checkedGraph, 33: { class_type: "ModelPatchLoader", inputs: { name: plan.patchName } } }), /final engine graph/);
  modelConfig.modelOverrides["Singularity.safetensors"] = "another.safetensors";
  assert.throws(() => service.assertSelection(plan), /override changed/);
  await assert.rejects(service.prepare(plan), /override changed/);
  delete modelConfig.modelOverrides["Singularity.safetensors"];
  await writeFile(base, "replaced checkpoint");
  await assert.rejects(service.prepare(plan), { reason: "control-compatibility" });
  assert.equal(spent, 0); assert.deepEqual(await readdir(input), []);
});

test("the original full-width download is a separately pinned optional H3 capability", () => {
  const full = CATALOG.find(row => row.id === "videoH3FunControlFull"), curve = CATALOG.find(row => row.id === "videoH3FunControl");
  assert.ok(full && curve); assert.equal(full.required, false);
  assert.equal(full.files[0].bytes, 6806843904);
  assert.equal(full.files[0].sha256, "919a48acb525dc8fc70287fcd94ec1f5e5e289a77f1df14d01099c6ce204eb02");
  assert.match(full.files[0].url, /\/resolve\/[a-f0-9]{40}\//);
  assert.equal(curve.files[0].bytes, 2296635360);
  assert.deepEqual(full.region.excluded, curve.region.excluded);
  assert.match(full.note, /half swap/);
});
