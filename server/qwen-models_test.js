import assert from "node:assert/strict";
import path from "node:path";
import { CATALOG, MODEL_TO_CAPABILITY, isPictureModel, modelLabel, modelPageUrl,
  engineFromModelFile, outputRightsFor, rightsStampFor } from "./models.js";
import { QWEN_IMAGE_FILES } from "./qwen-image.js";

// Publisher metadata, not measured hardware claims. No engine, network or weights.
const id = "qwen-image-2.1";
const cap = CATALOG.find((row) => row.id === id);
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok    ${label}`); };

check("the image engine has one downloadable picture capability", () => {
  assert.equal(CATALOG.filter((row) => row.id === id).length, 1);
  assert.equal(MODEL_TO_CAPABILITY[id], id);
  assert.equal(isPictureModel(cap), true);
  assert.equal(cap.required, false);
  assert.equal(Boolean(cap.gated || cap.awaiting || cap.needsPackage), false);
});

check("downloads provide exactly the three components the native graph loads", () => {
  assert.deepEqual(cap.files.map((f) => path.basename(f.dest)).sort(), Object.values(QWEN_IMAGE_FILES).sort());
  assert.deepEqual(cap.files.map((f) => path.basename(path.dirname(f.dest))), ["diffusion_models", "text_encoders", "vae"]);
  assert.ok(cap.files.every((f) => f.url.endsWith(path.basename(f.dest)) && !f.alt));
});

check("all files pin the verified publisher revision, byte count and SHA256", () => {
  assert.ok(cap.files.every((f) => f.url.startsWith("https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/ace0edeb3791a594ddfa36ed5f41a178a394e921/")));
  assert.deepEqual(cap.files.map((f) => [f.bytes, f.sha256]), [
    [7_256_783_064, "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d"],
    [9_350_798_360, "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f"],
    [675_509_688, "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"],
  ]);
  assert.equal(cap.files.reduce((sum, f) => sum + f.bytes, 0), 17_283_091_112);
});

check("native Qwen is identified by its diffusion file, not another model's encoder", () => {
  assert.equal(engineFromModelFile(QWEN_IMAGE_FILES.dit), id);
  assert.notEqual(engineFromModelFile(QWEN_IMAGE_FILES.encoder), id);
  assert.equal(modelLabel({ engine: id }), "Qwen Image 2.1");
  assert.equal(modelPageUrl({ engine: id }), "https://huggingface.co/Comfy-Org/Qwen-Image-2.1");
});

check("provenance records the research licence and does not infer commercial rights", () => {
  const rights = outputRightsFor(id);
  assert.equal(rights.class, "not-for-sale");
  assert.equal(rights.sellable, false);
  assert.equal(rightsStampFor(id).class, "not-for-sale");
  assert.match(rights.quote, /research or evaluation purposes only/);
  assert.match(rights.url, /Qwen\/Qwen-Image-2\.1\/blob\/[a-f0-9]{40}\/LICENSE$/);
});

check("hardware suitability remains unmeasured and no GGUF substitute is advertised", () => {
  assert.equal(cap.requires.experimental, true);
  assert.equal(cap.requires.vramMinGb, undefined);
  assert.equal(cap.requires.ramMinGb, undefined);
  assert.ok(cap.files.every((f) => f.dest.endsWith(".safetensors")));
});

console.log(`\n${passed} passed, 0 failed`);
