import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { motionDials, motionRenderOptions, motionSourceArgs, motionRmsPeaks, preflightMotion, YVANN_DIALS } from "./reactive_motion.js";
import { animateGraph } from "./animatediff.js";
import { runReactive } from "./reactive.js";

let passed = 0;
async function test(label, body) { await body(); passed++; console.log(`  ok ${label}`); }

await test("standard keeps existing picture defaults and source timing", () => {
  const d = motionDials({}, { pictures: true });
  assert.deepEqual([d.profile, d.depth, d.cfg, d.steps, d.hintLift, d.sourceHold, d.anchorMode, d.sourceStart, d.sourceSpeed],
    ["standard", 0.4, 7, 20, 2.2, 0, "source", 0, 1]);
});
await test("Yvann applies one coherent model, conditioning and sampling profile", () => {
  const d = motionDials({ profile: "yvann" }, { pictures: true });
  for (const [key, value] of Object.entries(YVANN_DIALS)) assert.equal(d[key], value, key);
  assert.deepEqual([d.motionLoraStrength, d.steps, d.cfg, d.depthEnd, d.lineartEnd, d.sourceHoldEnd], [0.4, 8, 2, 0.5, 0.7, 0.5]);
  assert.deepEqual([d.domainAdapter, d.sourceHold, d.hires, d.ipWeight, d.hitsOn], [false, 0, false, 1, "rms"]);
  const g = animateGraph({ source: "dance.mp4", frames: 48, width: 768, height: 432, schedule: { 0: "art" }, seed: 1, ...motionRenderOptions(d) });
  assert.equal(g[2], undefined);
  assert.deepEqual(g[10].inputs.model, ["1", 0]);
  assert.equal(g[46], undefined);
  assert.deepEqual([g[24].inputs.resolution, g[25].inputs.resolution], [576, 576]);
});
await test("opting into Yvann detail uses LCM sampling and an MSE pixel pass with unchanged control windows", () => {
  const d = motionDials({ profile: "yvann", hires: true });
  const g = animateGraph({ source: "dance.mp4", frames: 48, width: 512, height: 288, schedule: { 0: "art" }, seed: d.seed,
    steps: d.steps, cfg: d.cfg, ...motionRenderOptions(d),
    depth: { strength: d.depth, start: 0, end: d.depthEnd }, lineart: { strength: d.lineart, start: 0, end: d.lineartEnd } });
  assert.deepEqual([g[6].inputs.beta_schedule, g[48].inputs.beta_schedule], ["lcm", "lcm"]);
  for (const node of [5, 47]) assert.deepEqual(
    [g[node].inputs.context_length, g[node].inputs.context_overlap, g[node].inputs.closed_loop], [16, 4, true]);
  assert.equal(g[13].inputs.vae_name, "vae-ft-mse-840000-ema-pruned.safetensors");
  assert.deepEqual([g[900].inputs.vae, g[45].inputs.vae], [["13", 0], ["13", 0]]);
  assert.deepEqual([g[901].inputs.upscale_method, g[901].inputs.scale_by, g[46].inputs.denoise], ["lanczos", 1.5, 0.55]);
  assert.deepEqual([g[34].inputs.start_percent, g[34].inputs.end_percent, g[35].inputs.end_percent], [0, 0.5, 0.7]);
  assert.deepEqual([g[24].inputs.resolution, g[25].inputs.resolution], [576, 576]);
});
await test("standard preserves latent 2x detail and its original context; detail remains optional", () => {
  const options = motionRenderOptions(motionDials({}));
  assert.deepEqual(options.hires, { scale: 2, denoise: 0.55 });
  const g = animateGraph({ source: "dance.mp4", frames: 48, width: 512, height: 288, schedule: { 0: "art" }, seed: 1, ...options });
  assert.equal(g[45].class_type, "LatentUpscaleBy");
  assert.deepEqual([g[5].inputs.closed_loop, g[47].inputs.context_length, g[47].inputs.context_overlap], [false, 8, 2]);
  assert.equal(motionRenderOptions(motionDials({ profile: "yvann", hires: false })).hires, null);
});
await test("explicit overrides keep independent timing and anchor choice", () => {
  const d = motionDials({ profile: "yvann", cfg: 3, steps: 10, anchorMode: "references", sourceHold: 1, sourceStart: 15.76, sourceSpeed: 1.25, hitsOn: "bars" });
  assert.deepEqual([d.cfg, d.steps, d.anchorMode, d.sourceHold, d.sourceStart, d.sourceSpeed, d.hitsOn], [3, 10, "references", 1, 15.76, 1.25, "rms"]);
});
await test("explicit empty model-LoRA selections disable recipe adapters", () => {
  const d = motionDials({ profile: "yvann", motionLora: "", modelLora: "", sourceHold: 0 });
  assert.deepEqual([d.motionLora, d.modelLora, d.sourceHold], ["", "", 0]);
});
await test("unknown recipes and anchor types fail explicitly", () => {
  assert.throws(() => motionDials({ profile: "invented" }), /profile/);
  assert.throws(() => motionDials({ anchorMode: "invented" }), /anchorMode/);
});
await test("source ffmpeg seek and speed do not use the song offset", () => {
  const args = motionSourceArgs({ srcPath: "dance.mp4", output: "out.mp4", seconds: 4, frames: 48, fps: 12, width: 512, height: 288, sourceStart: 15.76, sourceSpeed: 1.25 });
  assert.equal(args[args.indexOf("-ss") + 1], "15.76");
  assert.match(args[args.indexOf("-vf") + 1], /^setpts=\(PTS-STARTPTS\)\/1\.25,fps=12,/);
  assert.equal(args[args.indexOf("-t") + 1], "4");
});
await test("missing named model errors include the exact files", async () => {
  await assert.rejects(preflightMotion(motionDials({ profile: "yvann" }), { engine: { objectInfo: async () => ({}) }, exists: async () => false }),
    (err) => /AnimateLCM_sd15_t2v.ckpt/.test(err.message) && /LiquidAF-0-1.safetensors/.test(err.message) && /MTEED.pth/.test(err.message));
});
await test("standard without custom models needs no extra assets", async () => {
  await preflightMotion(motionDials({}), { engine: { objectInfo: async () => { throw new Error("should not query"); } } });
});
await test("the LCM remix does not require SparseCtrl weights until anchors are enabled", async () => {
  const d = motionDials({ profile: "yvann" });
  const options = [d.motionModel, d.motionLora, d.modelLora, d.vae];
  const engine = { objectInfo: async (cls) => ({ [cls]: { input: { required: Object.fromEntries(
    ["model_name", "name", "lora_name", "vae_name"].map((field) => [field, [options]])) } } }) };
  const exists = async (file) => !file.endsWith("v3_sd15_sparsectrl_rgb.ckpt");
  await preflightMotion(d, { engine, exists });
  await assert.rejects(preflightMotion(motionDials({ profile: "yvann", sourceHold: 1 }), { engine, exists }), /v3_sd15_sparsectrl_rgb.ckpt/);
});
await test("an offline engine is not diagnosed as a missing model installation", async () => {
  await assert.rejects(preflightMotion(motionDials({ profile: "yvann" }), { engine: { objectInfo: async () => { throw new Error("connection refused"); } } }),
    (error) => /Start or reconnect/.test(error.message) && !/Install them/.test(error.message));
});
await test("RMS wrapper passes the resolved drum window in video-frame units", async () => {
  let args;
  const result = await motionRmsPeaks({ rhythmPath: "trusted/drums.wav", start: 25.6, fps: 12, frames: 48 }, { runner: async (_, argv) => {
    args = argv; return { stdout: JSON.stringify({ peaks: [0, 7, 19], method: "drum-frame-rms" }), stderr: "", err: null };
  } });
  assert.equal(args[args.indexOf("--start") + 1], "25.6");
  assert.equal(args[args.indexOf("--frames") + 1], "48");
  assert.deepEqual(result.peaks, [0, 7, 19]);
});
await test("invalid RMS output cannot become sampler indexes", async () => {
  await assert.rejects(motionRmsPeaks({ rhythmPath: "trusted.wav", start: 0, fps: 12, frames: 48 }, {
    runner: async () => ({ stdout: '{"peaks":[0,48]}', stderr: "", err: null }),
  }), /invalid frame indexes/);
});
await test("Yvann forces drum analysis and forwards only its resolved path", async () => {
  let analysisOptions, motion;
  const result = await runReactive({ song: "song.wav", pictures: ["dance.mp4", "style.png"], style: "motion", hits: "mix", start: 20, seconds: 4,
    rhythmPath: "untrusted.wav", motion: { profile: "yvann", sourceStart: 15.76, sourceSpeed: 1.25, rhythmPath: "untrusted2.wav" } }, {
    analyse: async (_, __, opts) => { analysisOptions = opts; return { duration: 40, rhythmPath: "resolved/drums.wav", beats: [], bars: [], tracks: {} }; },
    motion: async (args) => { motion = args; return { file: "painted.mp4" }; },
    vfx: async (body) => body.action === "create" ? { slug: "test" } : body.action === "add_layer" ? { layerId: "L1" } : body.action === "add_effect" ? { effectId: "F1" } : { jobId: "test" },
  });
  assert.equal(analysisOptions.hits, "drums");
  assert.equal(motion.rhythmPath, "resolved/drums.wav");
  assert.deepEqual([motion.start, motion.dials.sourceStart, motion.dials.sourceSpeed], [20, 15.76, 1.25]);
  assert.equal(result.seconds, 4);
});
await test("Reactive controls load ahead of slow libraries and a failed clip refresh preserves its grid", async () => {
  const elements = new Map();
  const element = () => ({ value: "", innerHTML: "", textContent: "", options: [], hidden: false,
    setAttribute() {}, insertAdjacentElement(_, child) { elements.set(child.id, child); } });
  for (const id of ["reactSong", "reactStyles", "reactImgs", "reactClips", "reactMotionModel", "reactMotionLora", "reactModelLora", "reactMotionSampler", "reactMotionScheduler"]) elements.set(id, element());
  elements.get("reactClips").innerHTML = "previous clip choices";
  const requests = [], pending = new Map();
  const ctx = vm.createContext({
    $: (id) => elements.get(id), document: { createElement: element },
    state: { library: [], images: [] }, reactStyles: {}, reactStyle: "cuts", reactMotionProfileDefaults: {},
    esc: String, reactSetStyle() {}, reactPaintPicked() {},
    fetch: (url) => {
      requests.push(url);
      if (url === "/api/reactive/status") return Promise.resolve({ ok: true, json: async () => ({
        styles: { motion: { label: "Motion", note: "test" } }, motion: { profiles: [{ id: "yvann", defaults: { motionModel: "LCM" } }] },
      }) });
      return new Promise((resolve, reject) => pending.set(url, { resolve, reject }));
    },
  });
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("const reactLoaders = new Map();"), source.indexOf("\nfunction reactSetStyle(")), ctx);
  const loading = ctx.loadReactive();
  await new Promise(setImmediate);
  assert.match(elements.get("reactStyles").innerHTML, /data-style="motion"/);
  assert.equal(ctx.reactMotionProfileDefaults.motionModel, "LCM");
  assert.equal(pending.size, 2);
  assert.match(elements.get("reactClipsLoadNote").textContent, /Loading clips/);
  const reopened = ctx.loadReactive();
  assert.equal(requests.filter((url) => url === "/api/clips").length, 1);
  pending.get("/api/images").resolve({ ok: true, json: async () => ({ images: [] }) });
  pending.get("/api/clips").reject(new Error("temporary disk error"));
  await Promise.all([loading, reopened]);
  assert.equal(elements.get("reactClips").innerHTML, "previous clip choices");
  assert.match(elements.get("reactClipsLoadNote").textContent, /temporary disk error/);
  assert.match(elements.get("reactImgs").innerHTML, /No pictures/);
});

console.log(`${passed} passed, 0 failed`);
