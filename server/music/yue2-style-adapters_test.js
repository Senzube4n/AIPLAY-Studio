import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { modelName } from "../localmodels.js";
import { YUE2_STYLE_ADAPTERS, yue2StyleAdapterFor, yue2StyleAdapterFromProbe, validateYue2StyleAdapter, yue2StyleAdapterGuide } from "./yue2-style-adapters.js";
import { detect } from "../detect.js";
import { CATALOG, songRights, songRightsStamp } from "../models.js";
import { buildYue2ComfyGraph } from "../workflow.js";

test("both published adapter families have individual, pinned, optional downloads", () => {
  assert.equal(YUE2_STYLE_ADAPTERS.filter((adapter) => adapter.family === "trbdr").length, 5);
  assert.equal(YUE2_STYLE_ADAPTERS.filter((adapter) => adapter.family === "grvl").length, 6);
  assert.equal(new Set(YUE2_STYLE_ADAPTERS.map((adapter) => adapter.file)).size, 11);
  for (const adapter of YUE2_STYLE_ADAPTERS) {
    assert.match(adapter.revision, /^[a-f0-9]{40}$/);
    assert.match(adapter.sha256, /^[a-f0-9]{64}$/);
    assert.ok(adapter.bytes > 100_000_000 && adapter.bytes < 180_000_000);
    assert.ok(adapter.url.includes(`/resolve/${adapter.revision}/${adapter.file}`));
    assert.equal(adapter.gated, false); assert.equal(adapter.fused, true);
    const row = CATALOG.find((cap) => cap.id === adapter.id);
    assert.equal(row.required, false); assert.equal(row.addonFor, "musicYue2Comfy");
    assert.equal(row.files.length, 1); assert.equal(row.files[0].bytes, adapter.bytes);
    assert.equal(row.files[0].sha256, adapter.sha256); assert.equal(row.files[0].alt, undefined);
  }
});

test("a fused style adapter requires the supported engine and both matched slots", () => {
  const file = "trbdr_lantern.safetensors";
  assert.equal(validateYue2StyleAdapter({ engine: "yue2-comfy", lora: file, loraClip: file }).file, file);
  for (const engine of ["yue2", "yue2-gguf", "ace-step15"]) {
    assert.throws(() => validateYue2StyleAdapter({ engine, lora: file, loraClip: file }),
      (error) => error.status === 400 && error.reason === "yue2-style-engine");
    assert.equal(validateYue2StyleAdapter({ engine, lora: file, loraClip: file, explicit: false }), null,
      "retained ComfyUI preferences cannot break a native generation");
  }
  for (const loraClip of [null, "grvl_thunder.safetensors", "another.safetensors"]) {
    assert.throws(() => validateYue2StyleAdapter({ engine: "yue2-comfy", lora: file, loraClip }), /same fused/);
  }
  assert.throws(() => validateYue2StyleAdapter({ engine: "yue2-comfy", lora: file, loraClip: file, cot: "off" }), /Thinking Full/);
  assert.equal(validateYue2StyleAdapter({ engine: "yue2-comfy", lora: "another.safetensors" }), null,
    "unrelated existing adapters keep their own support rules");
});

test("guidance follows the adapter family without rewriting a prompt or its strengths", () => {
  const guide = yue2StyleAdapterGuide({ loraClip: "grvl_tempest.safetensors" });
  assert.equal(guide.trigger, "grvl"); assert.match(guide.name, /Tempest/);
  assert.ok(guide.rules.some((rule) => /Thinking Full/.test(rule)));
  assert.equal(yue2StyleAdapterFor("loras/trbdr_porch.safetensors").trigger, "trbdr");
  assert.equal(yue2StyleAdapterGuide({ lora: "unlisted.safetensors" }), null);
});

test("the music graph carries both halves and refuses unsupported fused selections before queueing", () => {
  const opts = { caption: "grvl, English female soul ballad", lyrics: "[Verse]\nTurn the light", seed: 7,
    checkpoint: "yue2_3b_bf16.safetensors", lora: "grvl_thunder.safetensors", loraClip: "grvl_thunder.safetensors",
    loraStrength: 0.8, loraClipStrength: 1, cot: "full" };
  const graph = buildYue2ComfyGraph(opts);
  assert.equal(graph[2].inputs.lora_name, opts.lora);
  assert.equal(graph[2].inputs.strength_model, 0.8);
  assert.equal(graph[3].inputs.lora_name, opts.loraClip);
  assert.equal(graph[3].inputs.strength_clip, 1);
  assert.equal(graph[4].inputs.style, opts.caption);
  assert.throws(() => buildYue2ComfyGraph({ ...opts, loraClip: null }), /same fused/);
  assert.throws(() => buildYue2ComfyGraph({ ...opts, cot: "melody" }), /Thinking Full/);
});

test("adapter rights reach a song and its ledger without inheriting the base author's statement", () => {
  assert.equal(songRights({ engine: "yue2-comfy" }).class, "yours-with-conditions");
  for (const file of ["trbdr_broadside.safetensors", "grvl_thunder.safetensors"]) {
    const rights = songRights({ engine: "yue2-comfy", lora: file, loraClip: file });
    assert.equal(rights.class, "not-for-sale"); assert.equal(rights.sellable, false);
    assert.equal(rights.addOns.length, 1);
    assert.match(rights.attribution, /LoRAs by becausereasons/);
    assert.equal(songRightsStamp({ engine: "yue2-comfy", lora: file }).class, "not-for-sale");
    assert.equal(yue2StyleAdapterFor(file).outputRights.publisher, undefined);
  }
});

const audioKeys = ["diffusion_model.model.layers.0.self_attn.qkv_proj.lora_down.weight",
  "diffusion_model.model.layers.0.self_attn.qkv_proj.lora_up.weight"];
const plannerKeys = ["text_encoders.model.layers.0.mlp.gate_up_proj.lora_down.weight",
  "text_encoders.model.layers.0.mlp.gate_up_proj.lora_up.weight"];
const localProbe = (keys = [...audioKeys, ...plannerKeys], metadata = null) => ({ ...detect(new Set(keys), {}), metadata });

test("installed fused YuE2 files are discovered without a catalog name or invented recipe", () => {
  const name = path.join("voices", "qwwl-custom.safetensors");
  const adapter = yue2StyleAdapterFromProbe(name, localProbe());
  assert.equal(adapter.file, name); assert.equal(adapter.label, "qwwl-custom");
  assert.equal(adapter.engine, "yue2-comfy"); assert.equal(adapter.fused, true);
  assert.equal(adapter.installed, true); assert.equal(adapter.source, "local");
  assert.deepEqual(adapter.recipe, { audioStrength: 1, plannerStrength: 1 });
  for (const field of ["cot", "trigger", "licence", "outputRights", "revision", "url"])
    assert.equal(Object.hasOwn(field === "cot" ? adapter.recipe : adapter, field), false, `${field} must not be guessed`);
});

test("discovery requires actual audio and planner branches, not suggestive metadata", () => {
  for (const keys of [audioKeys, plannerKeys,
    ["text_encoders.qwen3.transformer.model.layers.0.self_attn.qkv_proj.lora_down.weight"],
    ["diffusion_model.double_blocks.0.img_attn.to_q.lora_down.weight"]]) {
    assert.equal(yue2StyleAdapterFromProbe("new.safetensors", localProbe(keys, { base_model: "YuE2", fused: "true", branch: "both" })), null);
  }
  assert.equal(yue2StyleAdapterFromProbe("new.safetensors", { ...localProbe(), family: "yue2" }), null);
  for (const name of ["../new.safetensors", "C:/models/new.safetensors", "/new.safetensors", "new.bin", null])
    assert.equal(yue2StyleAdapterFromProbe(name, localProbe()), null);
});

test("explicit local metadata is bounded, while missing licence and trigger stay unknown", () => {
  const adapter = yue2StyleAdapterFromProbe("new.safetensors", localProbe(undefined,
    { name: "Local\nVoice", trigger: "word\u0000", license: "CC-BY-4.0\r\n", score_mode: "off" }));
  assert.equal(adapter.label, "Local Voice"); assert.equal(adapter.trigger, "word");
  assert.equal(adapter.licence, "CC-BY-4.0"); assert.equal(Object.hasOwn(adapter, "outputRights"), false);
  assert.equal(Object.hasOwn(adapter.recipe, "cot"), false, "unverified score-mode metadata cannot change controls");
  const malformed = yue2StyleAdapterFromProbe("new.safetensors", localProbe(undefined,
    { name: {}, trigger: [], license: 4 }));
  assert.equal(malformed.label, "new"); assert.equal(Object.hasOwn(malformed, "trigger"), false);
  assert.equal(Object.hasOwn(malformed, "licence"), false);
});

test("known adapters enrich exact installed paths and dynamic lookup never conflates subfolders", () => {
  const known = yue2StyleAdapterFromProbe(path.join("styles", "grvl_thunder.safetensors"), localProbe());
  assert.equal(known.source, "catalog"); assert.equal(known.trigger, "grvl");
  assert.equal(known.recipe.cot, "full"); assert.equal(known.licence, "CC BY-NC 4.0");
  assert.equal(known.file, path.join("styles", "grvl_thunder.safetensors"));
  const first = yue2StyleAdapterFromProbe(path.join("a", "custom.safetensors"), localProbe(undefined, { name: "First" }));
  const second = yue2StyleAdapterFromProbe(path.join("b", "custom.safetensors"), localProbe(undefined, { name: "Second" }));
  const rows = [first, second];
  assert.equal(yue2StyleAdapterFor("a/custom.safetensors", rows), first);
  assert.equal(yue2StyleAdapterFor("b\\custom.safetensors", rows), second);
  assert.equal(yue2StyleAdapterFor("custom.safetensors", rows), null);
});

test("paired catalog adapters compare actual shelf paths rather than matching leaf names", () => {
  assert.throws(() => validateYue2StyleAdapter({ engine: "yue2-comfy",
    lora: "a/trbdr_porch.safetensors", loraClip: "b/trbdr_porch.safetensors" }),
    error => error.reason === "yue2-style-pair");
  assert.doesNotThrow(() => validateYue2StyleAdapter({ engine: "yue2-comfy",
    lora: "a/trbdr_porch.safetensors", loraClip: "a\\trbdr_porch.safetensors" }));
  assert.throws(() => validateYue2StyleAdapter({ engine: "yue2-comfy",
    lora: "trbdr_porch.safetensors", loraClip: "a/trbdr_porch.safetensors" }),
    error => error.reason === "yue2-style-pair");
});

test("portable path identity preserves Linux case and only resolves unambiguous Windows aliases", () => {
  // Execute the actual pure metadata module with each OS's path rules. This
  // exercises portability on Windows without changing process.platform.
  const source = readFileSync(new URL("./yue2-style-adapters.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/\bexport (?=const |function )/g, "")
    + "\n({ yue2StyleAdapterFor, validateYue2StyleAdapter });";
  const on = platform => vm.runInNewContext(source, { modelName, process: { platform } });
  const upper = { file: "voices/Custom.safetensors", label: "Upper" };
  const lower = { file: "voices/custom.safetensors", label: "Lower" };
  for (const platform of ["linux", "win32"]) {
    const api = on(platform);
    assert.equal(api.yue2StyleAdapterFor("voices/Custom.safetensors", [upper, lower]), upper);
    assert.equal(api.yue2StyleAdapterFor("voices\\custom.safetensors", [upper, lower]), lower);
    assert.equal(api.yue2StyleAdapterFor("voices/CUSTOM.safetensors", [upper, lower]), null,
      "a case variant cannot arbitrarily choose between distinct descriptors");
    assert.equal(api.yue2StyleAdapterFor("voices/custom.safetensors", [upper]), platform === "win32" ? upper : null);
    const pair = { engine: "yue2-comfy", lora: "voices/trbdr_porch.safetensors",
      loraClip: "voices/TRBDR_PORCH.safetensors" };
    if (platform === "win32") assert.doesNotThrow(() => api.validateYue2StyleAdapter(pair));
    else assert.throws(() => api.validateYue2StyleAdapter(pair), error => error.reason === "yue2-style-pair");
  }
});
