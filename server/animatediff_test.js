/**
 * AnimateDiff v3 on SD1.5 — the graph's shape and the schedule's arithmetic.
 *
 * Pinned: the pieces are the ones whose licences allow them to ship (no
 * IPAdapter, no Advanced-ControlNet, no AnimateLCM, no LiquidAF); the look
 * changes on the bars through OUR per-frame schedule node; depth is the Small
 * estimator by licence; the two ControlNets carry Yvann's strengths and
 * windows; the working size is a multiple of 8; and ANIMATE_GATE says what
 * has been measured. Runs standalone and in the hook. No card.
 */
import fs from "node:fs";
import { animateGraph, smoothGraph, SMOOTH_MODEL, scheduleFromBars, ipScheduleFromPeaks, IPADAPTER_WEIGHTS, ANIMATE_WEIGHTS, ANIMATE_PRESET, ANIMATE_SIZES, ANIMATE_SIZES_HIRES, HIRES_DEFAULTS, ANIMATE_GATE, DEFAULT_NEGATIVE } from "./animatediff.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

console.log("\n§1  the schedule on the bars");
{
  const s = scheduleFromBars({ bars: [25.61, 27.47, 29.32], start: 25.6, fps: 12, frames: 61, looks: ["A", "B", "C"] });
  eq("a look per bar, held until five frames before the next, then blended across the bar line",
    s, { 0: "A", 17: "A", 22: "B", 40: "B", 45: "C" });
  eq("one look never blends: it holds", scheduleFromBars({ bars: [1, 2], start: 0, fps: 12, frames: 30, looks: ["A"] }), { 0: "A", 12: "A", 24: "A" });
  ok("no looks is a refusal", throwsWith(() => scheduleFromBars({ bars: [], frames: 10, looks: [] }), /at least one look/));
}

console.log("\n§2  the graph");
{
  const g = animateGraph({ source: "aiplay_ad_src.mp4", frames: 61, width: 768, height: 432, schedule: { 0: "A", 22: "B" }, seed: 7 });
  eq("the checkpoint, the v3 adapter, the v3 motion module — the Apache-2.0 pieces",
    [g[1].inputs.ckpt_name, g[2].inputs.lora_name, g[3].inputs.model_name], [ANIMATE_WEIGHTS.checkpoint, "v3_sd15_adapter.ckpt", "v3_sd15_mm.ckpt"]);
  eq("the motion module rides evolved sampling on the AnimateDiff beta schedule with looped-uniform 16/4 pyramid contexts",
    [g[6].class_type, g[6].inputs.beta_schedule, g[5].inputs.context_length, g[5].inputs.context_overlap, g[5].inputs.fuse_method],
    ["ADE_UseEvolvedSampling", "sqrt_linear (AnimateDiff)", 16, 4, "pyramid"]);
  eq("the look is OUR per-frame schedule, not a third-party pack", [g[7].class_type, JSON.parse(g[7].inputs.schedule), g[7].inputs.frames], ["AiplayPromptSchedule", { 0: "A", 22: "B" }, 61]);
  eq("depth is the Small estimator by licence, at the short side", [g[24].inputs.ckpt_name, g[24].inputs.resolution, g[25].inputs.resolution], ["depth_anything_v2_vits.pth", 432, 432]);
  ok("the ControlNet loaders are OURS (per-window hint), not core and not the GPL pack", g[30].class_type === "AiplayControlNetLoaderSliding" && g[31].class_type === "AiplayControlNetLoaderSliding");
  eq("the two ControlNets carry the decoded strengths and windows",
    [g[32].inputs.strength, g[32].inputs.end_percent, g[33].inputs.strength, g[33].inputs.end_percent, g[30].inputs.control_net_name, g[31].inputs.control_net_name],
    [0.3, 0.5, 0.5, 0.7, ANIMATE_WEIGHTS.depth, ANIMATE_WEIGHTS.lineart]);
  eq("the latent batch is the whole piece, the sampler on the preset, 12 fps out",
    [g[40].inputs.batch_size, g[41].inputs.steps, g[41].inputs.cfg, g[41].inputs.sampler_name, g[43].inputs.fps], [61, ANIMATE_PRESET.steps, ANIMATE_PRESET.cfg, "dpmpp_2m", 12]);
  ok("none of the GPL packs' nodes are in the graph", !Object.values(g).some((n) => /IPAdapter|ACN_|Fizz|BatchPromptSchedule/.test(n.class_type)));
  ok("a size off the VAE's stride is refused", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 770, height: 432, schedule: { 0: "A" }, seed: 1 }), /multiple of 8/));
  ok("no seed is refused, so a render can be reproduced", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 768, height: 432, schedule: { 0: "A" } }), /seed/));
  ok("no schedule is refused", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 768, height: 432, schedule: {}, seed: 1 }), /schedule/));
  ok("the working sizes are all multiples of 8", Object.values(ANIMATE_SIZES).every(([w, h]) => w % 8 === 0 && h % 8 === 0));
  ok("...and so are the detail pass's first-pass sizes, whose doubles are the finished sizes", Object.values(ANIMATE_SIZES_HIRES).every(([w, h]) => w % 8 === 0 && h % 8 === 0 && w * 2 % 8 === 0) && HIRES_DEFAULTS.scale === 2 && HIRES_DEFAULTS.denoise === 0.55);
  {
    const h = animateGraph({ source: "x.mp4", frames: 8, width: 576, height: 320, schedule: { 0: "A" }, seed: 1, hires: HIRES_DEFAULTS });
    eq("the detail pass: the first pass's latent scaled 2x, sampled again at denoise 0.55 under the same model with its own held conditioning, and THAT is decoded",
      [h[45].class_type, h[45].inputs.scale_by, JSON.stringify(h[45].inputs.samples), h[46].class_type, h[46].inputs.denoise, JSON.stringify(h[46].inputs.latent_image), JSON.stringify(h[46].inputs.model), JSON.stringify(h[46].inputs.positive), JSON.stringify(h[42].inputs.samples)],
      ["LatentUpscaleBy", 2, '["41",0]', "KSampler", 0.55, '["45",0]', '["48",0]', '["35",0]', '["46",0]']);
    eq("...under its own evolved sampling with EIGHT-frame windows (sixteen at 1024x576 streamed weights from the CPU), on the same motion module and base model",
      [h[48].class_type, JSON.stringify(h[48].inputs.context_options), JSON.stringify(h[48].inputs.m_models), JSON.stringify(h[48].inputs.model), h[47].inputs.context_length, h[47].inputs.context_overlap],
      ["ADE_UseEvolvedSampling", '["47",0]', '["4",0]', '["2",0]', 8, 2]);
    const hp = animateGraph({ source: "x.mp4", frames: 8, width: 512, height: 288, schedule: { 0: "A" }, seed: 1, hires: HIRES_DEFAULTS, ipadapter: { pictures: ["p.png"], schedule: ipScheduleFromPeaks({ peaks: [], frames: 8, pictures: 1 }), weight: 1 } });
    ok("...and with pictures both passes sample the picture-patched model", JSON.stringify(hp[6].inputs.model) === '["70",0]' && JSON.stringify(hp[48].inputs.model) === '["70",0]');
    /* Bring your own: nothing shipped, names only — the graph shape is all
     * that can be pinned here (no such file was on the rig that built it). */
    const own = animateGraph({ source: "x.mp4", frames: 8, width: 512, height: 288, schedule: { 0: "A" }, seed: 1, hires: HIRES_DEFAULTS,
      own: { motionModel: "AnimateLCM_sd15_t2v.ckpt", motionLora: { name: "LiquidAF-0-1.safetensors", strength: 0.4 }, modelLora: { name: "AnimateLCM_sd15_t2v_lora.safetensors", strength: 1 }, sampler: "lcm", scheduler: "sgm_uniform" } });
    eq("bring your own: the motion module by name, its LoRA on the apply, an SD LoRA after the v3 adapter feeding BOTH passes and the picture patch, and the sampler pair on both samplers",
      [own[3].inputs.model_name, JSON.stringify(own[4].inputs.motion_lora), own[9].inputs.name, own[9].inputs.strength, own[10].class_type, own[10].inputs.lora_name, JSON.stringify(own[6].inputs.model), JSON.stringify(own[48].inputs.model), own[41].inputs.sampler_name, own[41].inputs.scheduler, own[46].inputs.sampler_name],
      ["AnimateLCM_sd15_t2v.ckpt", '["9",0]', "LiquidAF-0-1.safetensors", 0.4, "LoraLoaderModelOnly", "AnimateLCM_sd15_t2v_lora.safetensors", '["10",0]', '["10",0]', "lcm", "sgm_uniform", "lcm"]);
    const sg = animateGraph({ source: "x.mp4", frames: 48, width: 512, height: 288, schedule: { 0: "A" }, seed: 1, hires: HIRES_DEFAULTS, sparse: { keyframes: [0, 11, 22, 99], strength: 1.0, start: 0, end: 0.5 } });
    eq("the source on the hits: our SparseCtrl loader and apply on the source frames after the two holds, the keyframes clamped into the piece, both samplers reading it, the second pass's window mapped like the holds",
      [sg[26].class_type, sg[26].inputs.sparsectrl_file, sg[27].class_type, JSON.stringify(sg[27].inputs.positive), JSON.stringify(sg[27].inputs.images), sg[27].inputs.keyframes, sg[27].inputs.frames, sg[27].inputs.strength, sg[27].inputs.end_percent,
       JSON.stringify(sg[41].inputs.positive), JSON.stringify(sg[36].inputs.positive), sg[36].inputs.start_percent, sg[36].inputs.end_percent, JSON.stringify(sg[46].inputs.positive)],
      ["AiplaySparseCtrlLoader", ANIMATE_WEIGHTS.sparsectrl, "AiplaySparseCtrlApply", '["33",0]', '["22",0]', "[0,11,22,47]", 48, 1, 0.5, '["27",0]', '["35",0]', 0.45, 0.725, '["36",0]']);
    ok("...off, the samplers read the holds directly and no SparseCtrl node exists", !h[26] && !h[27] && !h[36] && JSON.stringify(h[41].inputs.positive) === '["33",0]');
    ok("...and sparse without keyframes is refused", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 512, height: 288, schedule: { 0: "A" }, seed: 1, sparse: { keyframes: [], strength: 1 } }), /keyframes/));
    const spnode = fs.readFileSync(new URL("./comfy_nodes/aiplay_sparsectrl.py", import.meta.url), "utf8");
    ok("our SparseCtrl node ships: the temporal transformer ported, the noisy latent zeroed at the door, the window's frames from sub_idxs, the mask channel, and the control merged the base class's way",
      /class _TemporalTransformer/.test(spnode) && /torch\.zeros_like\(x\)/.test(spnode) && /sub_idxs/.test(spnode) && /cond\[k, 4\] = 1\.0/.test(spnode) && /self\.control_merge\(control, control_prev/.test(spnode)
      && /NODE_CLASS_MAPPINGS = \{"AiplaySparseCtrlLoader"/.test(spnode));
    ok("...and with nothing of your own the graph is the shipped one: v3, no LoRA nodes, dpmpp_2m karras", h[3].inputs.model_name === "v3_sd15_mm.ckpt" && !h[9] && !h[10] && h[41].inputs.sampler_name === "dpmpp_2m" && h[41].inputs.scheduler === "karras" && JSON.stringify(h[6].inputs.model) === '["2",0]');
    eq("...and the hints are read at the source's short side, which is the second pass's", [h[24].inputs.resolution, h[25].inputs.resolution], [640, 640]);
    eq("...and the second pass is HELD: depth and line art applied again over the same fraction of its own steps (0.55 from 0.45: depth 0-0.5 → 0.45-0.725, line 0-0.7 → 0.45-0.835), and its sampler reads that conditioning",
      [h[34].class_type, JSON.stringify(h[34].inputs.control_net), h[34].inputs.strength, h[34].inputs.start_percent, h[34].inputs.end_percent, h[35].inputs.strength, h[35].inputs.start_percent, h[35].inputs.end_percent, JSON.stringify(h[35].inputs.positive), JSON.stringify(h[46].inputs.positive)],
      ["ControlNetApplyAdvanced", '["30",0]', 0.3, 0.45, 0.725, 0.5, 0.45, 0.835, '["34",0]', '["35",0]']);
    ok("without it the first pass is decoded and nodes 45/46 do not exist", JSON.stringify(g[42].inputs.samples) === '["41",0]' && !g[45] && !g[46] && g[24].inputs.resolution === 432);
    ok("a detail pass with no scale or a denoise past 1 is refused", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 576, height: 320, schedule: { 0: "A" }, seed: 1, hires: { scale: 1, denoise: 0.5 } }), /hires/)
      && throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 576, height: 320, schedule: { 0: "A" }, seed: 1, hires: { scale: 2, denoise: 1.5 } }), /hires/));
  }
  ok("the negative is a sentence, not empty", DEFAULT_NEGATIVE.length > 20);
}

console.log("\n§2b the pictures: a schedule on the peaks, and the graph with our IP-Adapter");
{
  const s = ipScheduleFromPeaks({ peaks: [0, 22, 45], frames: 50, pictures: 2, transition: 5 });
  eq("picture 0 holds, then cross-fades to picture 1 over the five frames ending ON the hit at 22, then holds picture 1",
    [s.per_frame[0], s.per_frame[16], s.per_frame[17], s.per_frame[21], s.per_frame[22], s.per_frame[45]],
    [[[0, 1]], [[0, 1]], [[0, 0.8333], [1, 0.1667]], [[0, 0.1667], [1, 0.8333]], [[1, 1]], [[0, 1]]]);
  eq("the pictures loop: with three pictures the third segment is picture 2, the fourth picture 0 again",
    ipScheduleFromPeaks({ peaks: [10, 20, 30], frames: 40, pictures: 3, transition: 0 }).per_frame.map((e) => e[0][0]).filter((_, f) => f % 10 === 5), [0, 1, 2, 0]);
  eq("min and max scale the weights", ipScheduleFromPeaks({ peaks: [], frames: 2, pictures: 1, min: 0.2, max: 0.8 }).per_frame[0], [[0, 0.8]]);
  const g = animateGraph({ source: "x.mp4", frames: 50, width: 768, height: 432, schedule: { 0: "A" }, seed: 1,
    ipadapter: { pictures: ["p1.png", "p2.png", "p3.png"], schedule: s, weight: 0.9 } });
  eq("with pictures: the CLIP tower and the adapter by licence, every picture loaded and batched, our apply on the model between the adapter LoRA and evolved sampling",
    [g[50].class_type, g[50].inputs.clip_name, g[51].class_type, g[51].inputs.ipadapter_file, g[52].inputs.image, g[54].inputs.image, g[82].class_type, g[70].class_type, g[70].inputs.model, g[70].inputs.images, g[70].inputs.weight, g[70].inputs.frames, g[6].inputs.model],
    ["CLIPVisionLoader", IPADAPTER_WEIGHTS.clipVision, "AiplayIPAdapterLoader", IPADAPTER_WEIGHTS.ipadapter, "p1.png", "p3.png", "ImageBatch", "AiplayIPAdapterApply", ["2", 0], ["82", 0], 0.9, 50, ["70", 0]]);
  eq("...and the schedule rides on the node as JSON", JSON.parse(g[70].inputs.schedule).per_frame.length, 50);
  ok("without pictures the model goes straight to evolved sampling", JSON.stringify(animateGraph({ source: "x.mp4", frames: 8, width: 768, height: 432, schedule: { 0: "A" }, seed: 1 })[6].inputs.model) === JSON.stringify(["2", 0]));
  ok("pictures without a schedule are refused", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 768, height: 432, schedule: { 0: "A" }, seed: 1, ipadapter: { pictures: ["p.png"] } }), /schedule/));
  const ipnode = fs.readFileSync(new URL("./comfy_nodes/aiplay_ipadapter.py", import.meta.url), "utf8");
  ok("our IP-Adapter node ships, weights the OUTPUT of each picture's attention term (never the tokens), reads the window's frames, and feeds the black picture to the unconditional half",
    /out = out \+ w \* optimized_attention\(q, k_ip, v_ip, heads\)/.test(ipnode) && /never a weight folded into the tokens/.test(ipnode) && /sub_idxs/.test(ipnode) && /tok_un\[0\] if which == 1/.test(ipnode)
    && /NODE_CLASS_MAPPINGS = \{"AiplayIPAdapterLoader"/.test(ipnode));
  ok("...and its Resampler is the reference's shape: 4 layers, 16 queries, 1280 in, 768 out", /_Resampler\(dim=dim, depth=depth, dim_head=64, heads=heads, num_queries=num_queries, embedding_dim=emb_dim, output_dim=out_dim\)/.test(ipnode));
  /* The projection cache is keyed on (device, dtype), which every layer
   * shares: it must live INSIDE the per-layer closure, or the first layer's
   * 320-wide projections reach all sixteen and every render is stripes. */
  ok("...and each layer keeps its own projection cache (a shared one painted stripes, 2026-09-19)",
    ipnode.split("cache = {}").length === 2
    && ipnode.indexOf("cache = {}") > ipnode.indexOf("def make_patch(k_w, v_w):")
    && ipnode.indexOf("cache = {}") < ipnode.indexOf("def patch(q, k, v, extra_options):"));
}

console.log("\n§2c the smoothing: RIFE through the engine, the enhancer's model");
{
  const s = smoothGraph({ file: "aiplay_motion_smooth_x.mp4", fps: 12, multiplier: 2, prefix: "animate/motion_x_24" });
  eq("the 12 fps render doubled by RIFE 4.26 (the catalogue's MIT row) to a 24 fps clip",
    [s[3].class_type, s[3].inputs.model_name, s[4].class_type, s[4].inputs.multiplier, JSON.stringify(s[4].inputs.images), s[5].inputs.fps, s[6].inputs.filename_prefix],
    ["FrameInterpolationModelLoader", SMOOTH_MODEL, "FrameInterpolate", 2, '["2",0]', 24, "animate/motion_x_24"]);
  ok("the model is the one the clip enhancer ships", /rife_v4\.26\.safetensors/.test(fs.readFileSync(new URL("./models.js", import.meta.url), "utf8")) && SMOOTH_MODEL === "rife_v4.26.safetensors");
  ok("no file is refused", throwsWith(() => smoothGraph({}), /file/));
  const rm = fs.readFileSync(new URL("./reactive_motion.js", import.meta.url), "utf8");
  ok("the Motion look tries RIFE first and falls back to ffmpeg, saying which in the ledger", /smoothedBy = "rife"/.test(rm) && /smoothedBy = "ffmpeg"/.test(rm) && /because RIFE was not available/.test(rm));
}

console.log("\n§3  the gate says what it has measured");
{
  ok("ANIMATE_GATE has run once and says what it saw", ANIMATE_GATE.ran === true && ANIMATE_GATE.render_seconds > 0 && ANIMATE_GATE.frames === 60 && /watched, not scored/.test(ANIMATE_GATE.note));
  ok("...and never claims a score it has not computed", ANIMATE_GATE.scored === false);
  /* The two nodes the graph needs are OURS and ship in the repository: the
   * engine boot copies every file in server/comfy_nodes/ into custom_nodes. */
  const nodes = fs.readdirSync(new URL("./comfy_nodes/", import.meta.url));
  ok("the schedule node and the sliding ControlNet loader ship in server/comfy_nodes/",
    nodes.includes("aiplay_prompt_schedule.py") && nodes.includes("aiplay_sliding_controlnet.py"));
  const sliding = fs.readFileSync(new URL("./comfy_nodes/aiplay_sliding_controlnet.py", import.meta.url), "utf8");
  ok("...and the loader carries the attribute AnimateDiff-Evolved looks for, and slices the hint per window",
    /sub_idxs = None/.test(sliding) && /cond_hint_original = full\[keep\]/.test(sliding) && /NODE_CLASS_MAPPINGS = \{"AiplayControlNetLoaderSliding"/.test(sliding));
  const sched = fs.readFileSync(new URL("./comfy_nodes/aiplay_prompt_schedule.py", import.meta.url), "utf8");
  ok("...and the schedule node interpolates between keyframes and batches one conditioning per frame",
    /torch\.cat\(conds, dim=0\)/.test(sched) && /c0 \* \(1\.0 - t\) \+ c1 \* t/.test(sched) && /NODE_CLASS_MAPPINGS = \{"AiplayPromptSchedule"/.test(sched));
  ok("the module header names both as ours", /AiplayPromptSchedule\s+ours/.test(fs.readFileSync(new URL("./animatediff.js", import.meta.url), "utf8")) && /AiplayControlNetLoaderSliding ours/.test(fs.readFileSync(new URL("./animatediff.js", import.meta.url), "utf8")));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
