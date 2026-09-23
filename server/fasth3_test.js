/**
 * FASTH3: FastVideo's 8-step distillation of MiniMax H3, as a third video engine.
 *
 * The graph is H3's with FastH3's settings, copied from ComfyUI's own
 * video_fastvideo_fasth3 templates: the FastH3 DiT, H3's encoder and VAEs, 8
 * steps of res_multistep at shift 10/3, no turbo LoRA, and BlockSparseAttention
 * in VSA mode at 10% after the shift. The dense backend under it is H3's own
 * node 85 (Comfy Kitchen, before the shift) when Kitchen is picked, and
 * nothing otherwise. No engine, no weights: graphs and source only.
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

/* ONE attention backend per graph, and it is node 85, before the shift, the
 * node H3 uses (94b97ba). The graph's `attention` is only ever "ck" or null:
 * art.js videoAttention() turns FastH3's per-render pick ("kitchen" |
 * "pytorch") into that. The sparse node 81 follows the shift, because it turns
 * its start/end percents into sigmas from the shifted schedule. A second
 * ModelAttentionBackend after the shift would replace 85's override, so there
 * is none: no node 80. */
test("the graph matches the template: 8 steps, shift 10/3, the sparse node feeding the sampler", () => {
  const g = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, steps: 20 });
  assert.equal(g[1].inputs.unet_name, config.video.engines.fasth3.dit);
  assert.equal(g[18], undefined, "no LoRA loader");
  assert.deepEqual(g[6].inputs, { model: ["1", 0], shift_video: 10, shift_audio: 3 });
  assert.equal(g[85], undefined, "no Kitchen asked: no backend node, the launcher's attention is the dense path");
  assert.equal(g[80], undefined, "node 80 is retired");
  assert.equal(g[81].class_type, "BlockSparseAttention");
  assert.deepEqual(g[81].inputs.model, ["6", 0], "the sparse patch follows the shift");
  assert.equal(g[81].inputs.selection, "vsa");
  assert.equal(g[81].inputs["selection.keep_percent"], 10, "the percentage FastH3 was trained at");
  assert.deepEqual(g[7].inputs.model, ["81", 0], "the guider samples the patched model");
  assert.deepEqual(g[8].inputs.model, ["81", 0], "and so does the scheduler");
  assert.equal(g[8].inputs.steps, 8, "20 asked, 8 run: the trained schedule is fixed");
  assert.equal(g[9].inputs.sampler_name, "res_multistep");
  const k = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, attention: "ck" });
  assert.deepEqual(k[85], { class_type: "ModelAttentionBackend", inputs: { model: ["1", 0], attention: "comfy kitchen attention" } });
  assert.deepEqual(k[6].inputs.model, ["85", 0], "Kitchen wraps the model before the shift");
  assert.deepEqual(k[81].inputs.model, ["6", 0], "and the sparse patch still follows the shift");
  assert.equal(k[80], undefined);
  const raw = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, attention: "kitchen" });
  assert.equal(raw[85], undefined, "the picker's word is not the graph's: art.js translates it, the graph never does");
});

test("H3's own graph is untouched", () => {
  const g = videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 2, steps: 8, attention: "ck" });
  assert.equal(g[80], undefined);
  assert.equal(g[81], undefined);
  assert.deepEqual(g[6].inputs.model, ["85", 0], "Kitchen on H3 as before");
  assert.deepEqual(g[7].inputs.model, ["6", 0]);
  assert.equal(g[8].inputs.steps, 8);
  assert.ok(g[18]?.inputs.lora_name, "H3's turbo LoRA still loads on the fast path");
});

test("FastH3 does not carry H3's step chips or turbo builds", () => {
  const f = config.video.engines.fasth3, h = config.video.engines.h3;
  assert.equal(f.stepDefaults, null, "no fast/standard/best: its steps are fixed");
  assert.equal(f.turboBuilds, null, "no turbo LoRA builds load on a distillation");
  assert.equal(f.fixedSteps, 8);
  assert.ok(h.stepDefaults && h.turboBuilds, "H3 keeps its own");
});

/* The user's rule: a plain control, the number behind it, and a tool. The
 * Video screen has the picker; make_clip is the tool. Run against a mocked
 * door with exactly the module names run() calls (bucky-integration_test.js
 * does the same). */
test("make_clip carries FastH3's attention pick, and its refusals name the engine that is selected", async () => {
  const { TOOLS } = await import("./mcp.js");
  const { videoLoraInput } = await import("./video-lora-validation.js");
  const { emptyResultNote } = await import("./art-wait.js");
  const t = TOOLS.find((x) => x.name === "make_clip");
  assert.deepEqual(t.inputSchema.properties.attention.enum, ["pytorch", "kitchen"]);
  const run = (api) => new Function("api", "safeName", "waitForArt", "videoLoraInput", "emptyResultNote",
    `return (${String(t.run).replace(/^async run\(/, "async function(")});`)(api, (v) => v, async () => {}, videoLoraInput, emptyResultNote);
  const calls = [];
  const api = async (method, p, body) => {
    calls.push({ method, p, body });
    if (p === "/api/status") return { config: { video: { enabled: true, ready: true, engine: "fasth3", engines: { fasth3: { label: "FastH3" } } } } };
    if (p === "/api/clips") return { clips: [] };
    return { job: { id: "v1" } };
  };
  await run(api)({ prompt: "a forest", attention: "kitchen" });
  assert.equal(calls.find((c) => c.method === "POST").body.attention, "kitchen", "the pick reaches the route");
  await assert.rejects(run(api)({ prompt: "a forest", ref_images: ["a.png"] }), /but FastH3 is selected/);
  await assert.rejects(run(api)({ prompt: "a forest", mid_frames: ["a.png"] }), /and FastH3 is selected/);
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
  const art = read("./art.js");
  assert.match(art, /attention: await this\.videoAttention\(job\),/);
  const va = art.slice(art.indexOf("async videoAttention(job)"), art.indexOf("async videoAttention(job)") + 600);
  assert.match(va, /const want = job\.attention \?\? eng\.attention;/, "the person's pick, else the engine's default");
  assert.match(va, /return this\.h3Attention\(\);/, "a Kitchen pick passes H3's launcher and engine checks");
  /* A second `attention:` key in the videoGraph({...}) call is not an error:
   * the later one wins in silence, and the picker is dead. Exactly one. */
  const call = art.slice(art.indexOf("if (!graph) graph = videoGraph({"), art.indexOf("const key = graphHash(graph);"));
  assert.ok(call.length > 100, "the videoGraph call was found");
  assert.equal((call.match(/^\s+attention:/gm) || []).length, 1, "exactly one attention key reaches the graph");
  const html = read("../web/index.html"), app = read("../web/app.js");
  assert.match(html, /<select id="vidAttn" class="sel2"[\s\S]*?<option value="pytorch">PyTorch<\/option>\s*<option value="kitchen">Kitchen INT8<\/option>/);
  assert.match(app, /el\.hidden = !eng\.attention;/, "the picker shows only for an engine with the choice");
  assert.match(app, /attention: state\.video\?\.engines\?\.\[state\.video\?\.engine\]\?\.attention \? \$\("vidAttn"\)\.value : undefined,/);
  assert.match(app, /\$\("vidRefWrap"\)\.hidden = cur !== "h3";/, "references hide on FastH3 as on LTX");
});
