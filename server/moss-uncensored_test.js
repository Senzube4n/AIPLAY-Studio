/** Optional native adapter integration. Synthetic CPU contracts, no weights. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { MOSS_PRESETS, MOSS_UNCENSORED_ADAPTER as pin, mossRecipeIdentity } from "./moss-presets.js";
import { mossImageGraph, mossImageSettings, mossImageOptions, MOSS_IMAGE_FILES } from "./moss-image.js";
import { mossImageStatus } from "./moss-status.js";
import { mossGenerationProvenance } from "./moss-provenance.js";
import { CATALOG, isPictureModel } from "./models.js";
import { detect, loraFits, loraTarget } from "./detect.js";

const preset = "nsfw-uncensored";
function fixtures() {
  const graph = mossImageGraph({ prompt: "a clothed adult portrait", mossPreset: preset });
  const shelf = CATALOG.find((cap) => cap.id === "moss-image").files.map((f) => ({ name: path.basename(f.dest), folder: path.basename(path.dirname(f.dest)), bytes: f.bytes }));
  shelf.push({ name: pin.filename, folder: "loras", bytes: pin.bytes });
  const info = Object.fromEntries(Object.values(graph).map((n) => [n.class_type, {}]));
  info.CLIPLoader = { input: { required: { type: [["moss_image"]] } } };
  info.KSampler = { input: { required: { sampler_name: [["er_sde"]], scheduler: [["simple"]] } } };
  info.LoraLoaderModelOnly = { input: { required: { model: ["MODEL"], lora_name: [[pin.filename]], strength_model: ["FLOAT", { min: -100, max: 100 }] } } };
  return { options: { mossPreset: preset }, config: {}, bases: async () => [], scan: async () => shelf,
    engine: { objectInfo: async () => info }, adapterPin: async (_found, expected) => ({ ready: true, sha256: expected.sha256 }), shelf, info };
}

test("the optional download is the exact licensed native file, never a replacement engine", () => {
  const cap = CATALOG.find((row) => row.id === pin.catalogueId);
  assert.equal(cap.required, false); assert.equal(cap.addonFor, "moss-image"); assert.equal(isPictureModel(cap), false);
  assert.equal(cap.licence, "Apache-2.0"); assert.equal(cap.outputRights.class, "unrestricted");
  assert.ok(cap.outputRights.url.endsWith(`/${pin.revision}/LICENSE`));
  assert.equal(cap.files.length, 1); assert.equal(path.basename(cap.files[0].dest), pin.filename);
  assert.equal(cap.files[0].bytes, 74379584); assert.equal(cap.files[0].sha256, "f766c5774a3fb68caa490bbc3f8153e8b5ccacafc36a1ee7f9ad6ec230ff11a3");
  assert.equal(cap.files[0].url, pin.url); assert.ok(pin.url.includes(`/resolve/${pin.revision}/`));
  assert.equal(pin.trigger, "moss_xvstyle"); assert.equal(pin.strength, 0.7); assert.equal(pin.clipStrength, 0);
});

test("selecting the preset patches only the MODEL at 0.7 and preserves the raw prompt", () => {
  const prompt = "A clothed adult sitting in a sunlit cafe", graph = mossImageGraph({ prompt, mossPreset: preset, seed: 52 });
  assert.equal(graph[1].inputs.unet_name, MOSS_IMAGE_FILES.dit);
  assert.deepEqual(graph[6], { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: pin.filename, strength_model: 0.7 } });
  assert.deepEqual(graph[8].inputs.model, ["6", 0]);
  assert.deepEqual(graph[4].inputs.clip, ["2", 0]); assert.deepEqual(graph[5].inputs.clip, ["2", 0]);
  assert.equal(graph[4].inputs.text, prompt); assert.equal(graph[8].inputs.steps, 30); assert.equal(graph[8].inputs.cfg, 3);
  assert.equal(graph[8].inputs.sampler_name, "er_sde"); assert.equal(graph[8].inputs.scheduler, "simple");
  const meta = mossImageSettings(graph);
  assert.equal(meta.mossPreset, preset); assert.equal(meta.mossRecipe, mossRecipeIdentity(preset));
  assert.equal(meta.adapter.sha256, pin.sha256); assert.equal(meta.adapter.strength, 0.7); assert.equal(meta.adapter.clipStrength, 0);
  assert.equal(meta.skipLayerGuidance, false); assert.equal(meta.publisherBf16Equivalent, false);
  const standard = mossImageGraph({ prompt }); assert.equal(standard[6], undefined); assert.equal(standard[8].inputs.steps, 25);
  assert.equal(standard[8].inputs.cfg, 2.5); assert.equal(mossImageSettings(standard).adapter, undefined);
});

test("the optional adapter cannot unlock other checkpoints, custom stacks or unvalidated settings", () => {
  for (const extra of [{ dit: "kromoss_int8_convrot.safetensors" }, { loras: [{ name: "other.safetensors" }] },
    { steps: 8 }, { cfg: 1 }, { sampler: "euler" }, { width: 2048, height: 1024 }, { refImages: ["face.png"] }]) {
    assert.throws(() => mossImageOptions({ prompt: "adult portrait", mossPreset: preset, ...extra }));
  }
  assert.equal(Object.keys(MOSS_PRESETS)[0], "standard");
});

test("readiness refuses missing, corrupt or unsupported adapter instead of advertising an installed choice", async () => {
  const deps = fixtures(), good = await mossImageStatus(deps);
  assert.equal(good.ready, true); assert.equal(good.adapter.sha256, pin.sha256);
  const missing = await mossImageStatus({ ...deps, scan: async () => deps.shelf.filter((f) => f.folder !== "loras") });
  assert.equal(missing.ready, false); assert.equal(missing.needsModel, pin.catalogueId);
  const corrupt = await mossImageStatus({ ...deps, adapterPin: async () => ({ ready: false, error: "LoRA SHA256 mismatch" }) });
  assert.equal(corrupt.ready, false); assert.match(corrupt.error, /SHA256 mismatch/);
  const info = structuredClone(deps.info); delete info.LoraLoaderModelOnly.input.required.strength_model;
  assert.equal((await mossImageStatus({ ...deps, engine: { objectInfo: async () => info } })).ready, false);
});

test("native MOSS projection pairs are recognized narrowly, while PEFT and unrelated projections are not a fit", () => {
  const native = ["q", "ffn_up_gate"].flatMap((name) => ["A", "B"].map((side) => `diffusion_model.layers.0.proj.${name}.lora_${side}.weight`));
  const found = detect(new Set(native), {});
  assert.equal(found.family, "lora"); assert.equal(found.variant, "MOSS-Image"); assert.equal(found.confidence, "certain");
  assert.equal(loraFits(found.variant, "MOSS-Image").fit, "yes"); assert.equal(loraFits(found.variant, "MiniMax H3").fit, "no");
  const peft = native.map((name) => name.replace("diffusion_model.", "transformer."));
  assert.match(loraTarget(peft).variant, /convert/); assert.equal(loraFits(loraTarget(peft).variant, "MOSS-Image").fit, "no");
  assert.notEqual(loraTarget(native.filter((name) => name.includes(".q."))).variant, "MOSS-Image");
  assert.notEqual(loraTarget(native.map((name) => name.replace("ffn_up_gate", "ffn_up"))).variant, "MOSS-Image");
  assert.notEqual(loraTarget([native[0], native[2].replace("layers.0", "layers.1")]).variant, "MOSS-Image");
});

test("generation provenance names the selected adapter and its actual verification without changing old presets", () => {
  const options = { ...mossImageSettings(mossImageGraph({ prompt: "clothed portrait", mossPreset: preset })), adapterVerifiedSha256: pin.sha256 };
  const note = mossGenerationProvenance("moss-image", options);
  assert.equal(note.mossPreset, preset); assert.equal(note.mossRecipe, mossRecipeIdentity(preset));
  assert.equal(note.adapter.filename, pin.filename); assert.equal(note.adapter.trigger, pin.trigger);
  assert.equal(note.adapterVerifiedSha256, pin.sha256); assert.equal(note.outputRights.capability, pin.catalogueId);
  assert.equal(note.outputRights.class, "unrestricted"); assert.deepEqual(note.outputRights.addOns, [pin.catalogueId]);
  assert.equal(mossGenerationProvenance("moss-image", { mossPreset: preset }).adapterVerifiedSha256, null);
  assert.deepEqual(mossGenerationProvenance("moss-image", { mossPreset: "standard" }), {});
  assert.deepEqual(mossGenerationProvenance("qwen-image-2.1", options), {});
});

test("the UI exposes an optional named choice and trigger tip while leaving Standard selected", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const select = html.slice(html.indexOf('id="imgMossPreset"'), html.indexOf("</select>", html.indexOf('id="imgMossPreset"')));
  assert.match(select, /value="standard" selected/);
  assert.match(select, /value="nsfw-uncensored" title="[^"]*moss_xvstyle[^"]*">NSFW Uncensored<\/option>/);
});
