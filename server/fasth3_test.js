/**
 * FASTH3: FastVideo's 8-step distillation of MiniMax H3, as a third video engine.
 *
 * The graph is H3's with FastH3's settings, copied from ComfyUI's own
 * video_fastvideo_fasth3 templates: the FastH3 DiT, H3's encoder and VAEs, 8
 * steps of res_multistep at shift 10/3, no turbo LoRA, and the attention pair
 * (ModelAttentionBackend, then BlockSparseAttention in VSA mode at 10%). No
 * engine, no weights: graphs and source only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { config } = await import("./config.js");
const { videoGraph } = await import("./workflow.js");
const { CATALOG, MODEL_TO_CAPABILITY } = await import("./models.js");
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("FastH3 is an engine after H3 and LTX, built on H3's parts", () => {
  const keys = Object.keys(config.video.engines);
  assert.deepEqual(keys.slice(0, 3), ["h3", "ltx", "fasth3"]);
  const f = config.video.engines.fasth3, h = config.video.engines.h3;
  assert.match(f.dit, /^fastvideo_fasth3_8step_v2_pruned_/);
  assert.equal(f.textEncoder, h.textEncoder, "the same text encoder");
  assert.equal(f.videoVae, h.videoVae);
  assert.equal(f.audioVae, h.audioVae);
  assert.equal(f.turboLora, null, "a distillation already: no turbo LoRA on top");
  assert.equal(f.attention, "pytorch", "PyTorch attention unless the render asks for Kitchen");
});

test("the graph matches the template: 8 steps, shift 10/3, the attention pair feeding the sampler", () => {
  const g = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, steps: 20 });
  assert.equal(g[1].inputs.unet_name, config.video.engines.fasth3.dit);
  assert.equal(g[18], undefined, "no LoRA loader");
  assert.deepEqual(g[6].inputs, { model: ["1", 0], shift_video: 10, shift_audio: 3 });
  assert.deepEqual(g[80], { class_type: "ModelAttentionBackend", inputs: { model: ["6", 0], attention: "pytorch attention" } });
  assert.equal(g[81].class_type, "BlockSparseAttention");
  assert.deepEqual(g[81].inputs.model, ["80", 0]);
  assert.equal(g[81].inputs.selection, "vsa");
  assert.equal(g[81].inputs["selection.keep_percent"], 10, "the percentage FastH3 was trained at");
  assert.deepEqual(g[7].inputs.model, ["81", 0], "the guider samples the patched model");
  assert.deepEqual(g[8].inputs.model, ["81", 0], "and so does the scheduler");
  assert.equal(g[8].inputs.steps, 8, "20 asked, 8 run: the trained schedule is fixed");
  assert.equal(g[9].inputs.sampler_name, "res_multistep");
  const k = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, attention: "kitchen" });
  assert.equal(k[80].inputs.attention, "comfy kitchen attention");
});

test("H3's own graph is untouched", () => {
  const g = videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 2, steps: 8, attention: "kitchen" });
  assert.equal(g[80], undefined);
  assert.equal(g[81], undefined);
  assert.deepEqual(g[7].inputs.model, ["6", 0]);
  assert.equal(g[8].inputs.steps, 8);
  assert.ok(g[18]?.inputs.lora_name, "H3's turbo LoRA still loads on the fast path");
});

test("the download row shares H3's encoder and VAEs, so only the DiT is new", () => {
  assert.equal(MODEL_TO_CAPABILITY.fasth3, "videoFastH3");
  const fast = CATALOG.find((c) => c.id === "videoFastH3");
  const h3 = CATALOG.find((c) => c.id === "video");
  const names = (c) => c.files.map((f) => path.basename(f.dest));
  assert.equal(names(fast)[0], "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors");
  for (const n of names(fast).slice(1)) assert.ok(names(h3).includes(n), `${n} is H3's file too`);
  assert.ok(fast.region?.excluded?.length === 4, "H3's territory clause travels with it");
  assert.equal(fast.outputRights.class, "yours-with-conditions");
});

test("the route, the job and the Video screen carry the attention choice; references stay on H3", () => {
  const index = read("./index.js");
  assert.match(index, /attention: b\.attention === "kitchen" \|\| b\.attention === "pytorch" \? b\.attention : undefined,/);
  assert.match(index, /steps: videoEngine\(eng\)\.fixedSteps \|\|/);
  assert.match(index, /eng === "fasth3"\n\s+\? "References need MiniMax H3\. FastH3 was distilled without them/);
  assert.match(read("./art.js"), /attention: job\.attention,/);
  const html = read("../web/index.html"), app = read("../web/app.js");
  assert.match(html, /<select id="vidAttn" class="sel2"[\s\S]*?<option value="pytorch">PyTorch<\/option>\s*<option value="kitchen">Kitchen INT8<\/option>/);
  assert.match(app, /el\.hidden = !eng\.attention;/, "the picker shows only for an engine with the choice");
  assert.match(app, /attention: state\.video\?\.engines\?\.\[state\.video\?\.engine\]\?\.attention \? \$\("vidAttn"\)\.value : undefined,/);
  assert.match(app, /\$\("vidRefWrap"\)\.hidden = cur !== "h3";/, "references hide on FastH3 as on LTX");
});
