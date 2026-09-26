/**
 * FASTH3: FastVideo's 8-step distillation of MiniMax H3, as a third video engine.
 *
 * The graph is H3's with FastH3's settings, copied from ComfyUI's own
 * video_fastvideo_fasth3 templates: the FastH3 DiT, H3's encoder and VAEs, 8
 * steps of res_multistep at shift 10/3, no turbo LoRA, and BlockSparseAttention
 * in VSA mode at 10% after the shift. The dense backend under it is H3's own
 * node 85 (before the shift), set to whichever backend the person picked:
 * Comfy Kitchen or PyTorch, never the launcher's global attention flag. No
 * engine, no weights: graphs and source only (the engine's answer is stubbed).
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
  /* The H3 lab (2026-09-24) timed FastH3 with Kitchen INT8; PyTorch was a
   * default nobody had measured. */
  assert.equal(f.attention, "kitchen", "Kitchen attention unless the render asks for PyTorch");
  /* ...named as the model it is, with the lab's caveat (an Advanced "More
   * motion" switch until 2026-09-25). */
  assert.equal(f.advanced?.label, "FastH3 (experimental)");
  assert.doesNotMatch(f.advanced?.note || "", /motion/i, "no motion claim: its card makes none");
  assert.match(f.advanced?.note || "", /About 1\.4x the wait of Fast\. Can change the subject's colour or add a white blob; check the take\./);
});

/* ONE attention backend per graph, and it is node 85, before the shift, the
 * node H3 uses (94b97ba). The graph's `attention` is only ever "ck",
 * "pytorch" or null: art.js videoAttention() turns FastH3's per-render pick
 * ("kitchen" | "pytorch") into one of the first two. The sparse node 81 follows the shift, because it turns
 * its start/end percents into sigmas from the shifted schedule. A second
 * ModelAttentionBackend after the shift would replace 85's override, so there
 * is none: no node 80. */
test("the graph matches the template: 8 steps, shift 10/3, the sparse node feeding the sampler", () => {
  const g = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, steps: 20 });
  assert.equal(g[1].inputs.unet_name, config.video.engines.fasth3.dit);
  assert.equal(g[18], undefined, "no LoRA loader");
  assert.deepEqual(g[6].inputs, { model: ["1", 0], shift_video: 10, shift_audio: 3 });
  assert.equal(g[85], undefined, "no attention named, no node: art.js always names one for FastH3");
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
  /* A PyTorch pick is a node too. Without it the dense part (the first 20% of
   * the schedule and the audio rows) ran under whatever the launcher started
   * ComfyUI with: Sage or CK int8 under a picker that said PyTorch. */
  const pt = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, attention: "pytorch" });
  assert.deepEqual(pt[85], { class_type: "ModelAttentionBackend", inputs: { model: ["1", 0], attention: "pytorch attention" } });
  assert.deepEqual(pt[6].inputs.model, ["85", 0], "PyTorch wraps the model before the shift, as Kitchen does");
  assert.deepEqual(pt[81].inputs.model, ["6", 0]);
  const raw = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, attention: "kitchen" });
  assert.equal(raw[85], undefined, "the picker's word is not the graph's: art.js translates it, the graph never does");
});

/* THE PICK IS WHAT RUNS, whatever the launcher's Advanced > Attention says.
 * The real ArtRunner, with only the engine's answer stubbed: a launcher on
 * Sage must not turn a PyTorch pick into Sage, and a launcher on an explicit
 * PyTorch must not turn a Kitchen pick into PyTorch. H3, which has no picker,
 * keeps the launcher veto. */
test("FastH3's attention pick reaches the graph whatever the launcher's attention flag is", async () => {
  const { ArtRunner } = await import("./art.js");
  const { engine } = await import("./engine/client.js");
  const offers = (list) => async () => ({ ModelAttentionBackend: { input: { required: { attention: ["COMBO", { options: list }] } } } });
  const keepInfo = engine.objectInfo;
  config.comfy.options = config.comfy.options || {};
  const had = Object.hasOwn(config.comfy.options, "attention"), keepAttn = config.comfy.options.attention;
  const launcher = (flag) => { if (flag === undefined) delete config.comfy.options.attention; else config.comfy.options.attention = flag; };
  try {
    engine.objectInfo = offers(["pytorch attention", "comfy kitchen attention"]);
    const art = new ArtRunner(null, null);
    launcher("--use-sage-attention");
    assert.equal(await art.videoAttention({ engine: "fasth3", attention: "pytorch" }), "pytorch", "Sage launcher, PyTorch pick: PyTorch");
    assert.equal(await art.videoAttention({ engine: "fasth3" }), "ck", "no pick: the engine's default, Kitchen, where the engine offers it");
    assert.equal(await art.videoAttention({ engine: "fasth3", attention: "kitchen" }), "ck", "Sage launcher, Kitchen pick: Kitchen");
    assert.equal(await art.videoAttention({ engine: "h3" }), null, "H3 has no picker: the launcher's explicit choice still wins there");
    launcher("--use-pytorch-cross-attention");
    assert.equal(await art.videoAttention({ engine: "fasth3", attention: "kitchen" }), "ck", "explicit PyTorch launcher, Kitchen pick: Kitchen");
    launcher("--use-ck-attention");
    assert.equal(await art.videoAttention({ engine: "fasth3", attention: "pytorch" }), "pytorch", "CK launcher, PyTorch pick: PyTorch");
    assert.equal(await art.videoAttention({ engine: "ltx", attention: "kitchen" }), null, "LTX: none");
    const g = videoGraph({ engine: "fasth3", prompt: "p", seed: 1, seconds: 2, attention: await art.videoAttention({ engine: "fasth3", attention: "pytorch" }) });
    assert.equal(g[85].inputs.attention, "pytorch attention", "and the graph carries it");
    /* An engine whose COMBO lacks Kitchen: the pick becomes an explicit
     * PyTorch node, never a value the engine would refuse. */
    engine.objectInfo = offers(["pytorch attention"]);
    launcher(undefined);
    const without = new ArtRunner(null, null);
    assert.equal(await without.videoAttention({ engine: "fasth3", attention: "kitchen" }), "pytorch", "Kitchen not offered: PyTorch, said in the graph");
    assert.equal(await without.videoAttention({ engine: "fasth3" }), "pytorch", "...and so is the Kitchen default");
  } finally {
    engine.objectInfo = keepInfo;
    if (had) config.comfy.options.attention = keepAttn; else delete config.comfy.options.attention;
  }
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
  /* The reference sentence is the server's (video-plain.js), sent per engine on
   * the status: the one the Video screen's reference slots show. */
  const { refsIgnored } = await import("./video-plain.js");
  const said = refsIgnored("fasth3", "FastH3");
  const api = async (method, p, body) => {
    calls.push({ method, p, body });
    if (p === "/api/status") return { config: { video: { enabled: true, ready: true, engine: "fasth3", engines: { fasth3: { label: "FastH3", refsIgnored: said } } } } };
    if (p === "/api/clips") return { clips: [] };
    return { job: { id: "v1" } };
  };
  await run(api)({ prompt: "a forest", attention: "kitchen" });
  assert.equal(calls.find((c) => c.method === "POST").body.attention, "kitchen", "the pick reaches the route");
  await assert.rejects(run(api)({ prompt: "a forest", ref_images: ["a.png"] }),
    (e) => e.message.startsWith(said) && /FastH3 is selected: pass engine:"h3"/.test(e.message));
  await assert.rejects(run(api)({ prompt: "a forest", mid_frames: ["a.png"] }), /and FastH3 is selected/);
});

/* YOUR OWN LoRAs ON FASTH3. The picker had its own two-engine list and so did
 * /api/video: on FastH3 the picker offered every LoRA as "unverified" and
 * Render refused each one with "Choose H3 or LTX", with FastH3 selected. One
 * value now, config's loraBase, which FastH3 inherits from H3 (the graph stacks
 * your LoRAs on its DiT as on H3's). */
test("FastH3 takes H3 LoRAs: the picker and the route read one base, and agree", async () => {
  const { validateVideoLoras } = await import("./video-lora-validation.js");
  const f = config.video.engines.fasth3;
  assert.equal(f.loraBase, "MiniMax H3", "inherited from H3");
  assert.equal(config.video.engines.ltx.loraBase, "LTX");
  const rows = [{ name: "mine.safetensors", strength: 1 }];
  const opts = (variant, e = f) => ({ engine: "fasth3", loraBase: e.loraBase, label: e.label,
    shelf: async () => [{ name: "mine.safetensors", folder: "loras", full: "x/loras/mine.safetensors" }],
    probe: async () => ({ family: "lora", variant }) });
  assert.deepEqual(await validateVideoLoras(rows, opts("MiniMax H3")), rows, "an H3 LoRA goes on FastH3");
  await assert.rejects(validateVideoLoras(rows, opts("LTX")), /made for LTX, not MiniMax H3/, "an LTX one is refused by name");
  await assert.rejects(validateVideoLoras(rows, opts("MiniMax H3", { label: "FutureEngine" })), /FutureEngine takes no LoRAs of your own/,
    "an engine with no base refuses by its own name, not 'Choose H3 or LTX'");
  /* The Video screen's judge, lifted, reading the same value from status. */
  const app = read("../web/app.js");
  const fitSrc = /function vidLoraFit\(l, eng = [^\n]*\n[\s\S]*?\n\}/.exec(app)[0];
  const state = { video: { engine: "fasth3", engines: Object.fromEntries(Object.entries(config.video.engines).map(([k, e]) => [k, { loraBase: e.loraBase ?? null }])) } };
  const vidLoraFit = new Function("$", "state", `${fitSrc}\nreturn vidLoraFit;`)(() => ({ value: "fasth3" }), state);
  assert.equal(vidLoraFit({ base: "MiniMax H3" }, "fasth3"), "yes", "the picker offers an H3 LoRA on FastH3 as fitting");
  assert.equal(vidLoraFit({ base: "LTX" }, "fasth3"), "no", "and does not offer an LTX one");
  assert.equal(vidLoraFit({ base: "LTX" }, "ltx"), "yes");
  const index = read("./index.js");
  assert.match(index, /loraBase: e\.loraBase \?\? null,/, "/api/status carries each engine's base");
  assert.match(index, /engine, loraBase: e\.loraBase, label: e\.label, shelf:/, "and the route checks the same one");
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
  /* References on FastH3 or LTX: refused by the plan (server/video-plain.js),
   * in the one sentence the page and make_clip show. */
  assert.match(index, /const plan = videoPlan\(\{ \.\.\.b, refImages, refAudios \}/);
  assert.match(index, /if \(plan\.refusal\) return json\(res, 400, \{ error: plan\.refusal\.error, reason: plan\.refusal\.reason,\s*\.\.\.\(plan\.refusal\.needsModel \? \{ needsModel: plan\.refusal\.needsModel \} : \{\}\) \}\);/);
  const art = read("./art.js");
  assert.match(art, /attention: await this\.videoAttention\(job\),/);
  const va = art.slice(art.indexOf("async videoAttention(job)"), art.indexOf("async videoAttention(job)") + 600);
  assert.match(va, /const want = job\.attention \?\? eng\.attention;/, "the person's pick, else the engine's default");
  assert.match(va, /if \(want !== "kitchen" && want !== "ck"\) return "pytorch";/, "a PyTorch pick is written out, not left to the launcher");
  assert.match(va, /return \(await this\.#kitchenOffered\(\)\) \? "ck" : "pytorch";/,
    "a Kitchen pick passes the engine-offers probe, not H3's launcher veto");
  assert.match(va, /return this\.h3Attention\(\);/, "H3 still goes through h3Attention()");
  /* A second `attention:` key in the videoGraph({...}) call is not an error:
   * the later one wins in silence, and the picker is dead. Exactly one. */
  const call = art.slice(art.indexOf("if (!graph) graph = videoGraph({"), art.indexOf("const key = graphHash(graph);"));
  assert.ok(call.length > 100, "the videoGraph call was found");
  assert.equal((call.match(/^\s+attention:/gm) || []).length, 1, "exactly one attention key reaches the graph");
  const html = read("../web/index.html"), app = read("../web/app.js");
  assert.match(html, /<select id="vidAttn" class="sel2"[\s\S]*?<option value="pytorch">PyTorch<\/option>\s*<option value="kitchen">Kitchen INT8<\/option>/);
  assert.match(app, /el\.hidden = !eng\.attention;/, "the picker shows only for an engine with the choice");
  assert.match(app, /attention: state\.video\?\.engines\?\.\[state\.video\?\.engine\]\?\.attention \? \$\("vidAttn"\)\.value : undefined,/);
  assert.match(app, /\$\("vidRefWrap"\)\.hidden = cur !== "h3" && !\(\(state\.refImages \|\| \[\]\)\.length \+ \(state\.refAudios \|\| \[\]\)\.length\);/,
    "references hide on FastH3 as on LTX, unless some are attached: then the slots stay and say so");
});
