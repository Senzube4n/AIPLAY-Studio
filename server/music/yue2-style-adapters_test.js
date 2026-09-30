import test from "node:test";
import assert from "node:assert/strict";
import { YUE2_STYLE_ADAPTERS, yue2StyleAdapterFor, validateYue2StyleAdapter, yue2StyleAdapterGuide } from "./yue2-style-adapters.js";
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
