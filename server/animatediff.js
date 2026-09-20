/**
 * AnimateDiff v3 on SD1.5 — the graph that repaints a clip with a look that
 * changes on the bars. 2026-09-19.
 *
 * WHAT THIS IS. Yvann's VideoToVideo workflow, decoded from its JSON on
 * 2026-09-18: SD1.5 (dreamshaper_8) + an AnimateDiff motion module, the
 * source video through ControlNet Depth (0.3, 0–0.5) and LineArt (0.5,
 * 0–0.7) so the figure and the room survive, and the LOOK switched per drum
 * hit — in his graph by IPAdapter reference pictures with per-frame weights.
 * Built here from the pieces whose licences allow it to ship:
 *
 *   ComfyUI-AnimateDiff-Evolved   Apache-2.0   the motion module's host
 *   v3_sd15_mm.ckpt + v3 adapter  Apache-2.0   guoyww/animatediff, hash-checked
 *   ControlNet v1.1 depth/lineart openrail     lllyasviel, fp16 repack
 *   dreamshaper_8                 CreativeML OpenRAIL-M (an SD1.5 checkpoint)
 *   AiplayPromptSchedule          ours         one conditioning per frame
 *   AiplayControlNetLoaderSliding ours         core ControlNet, per-window hint
 *   AiplayIPAdapterApply          ours         IP-Adapter's METHOD (Apache-2.0
 *                                              reference) on ComfyUI's attn2
 *                                              hook, a picture schedule per frame
 *   ip-adapter-plus_sd15 + ViT-H  Apache-2.0 / MIT  h94's weights, laion's tower
 *   AiplaySparseCtrlApply         ours         SparseCtrl's METHOD (Apache-2.0
 *                                              reference) on ComfyUI's ControlNet
 *                                              network, keyframes per window
 *   v3_sd15_sparsectrl_rgb        Apache-2.0   guoyww/animatediff, hash-checked
 *
 * NOT here, on purpose: the IPAdapter_plus and Advanced-ControlNet node
 * PACKS are GPL-3.0 and cannot ship inside this Apache-2.0 tree (the method
 * and the weights are not, hence our node); AnimateLCM has no licence text;
 * the LiquidAF motion LoRA has no readable terms. So the sampler runs the v3
 * module on its own schedule rather than LCM's four steps, and there is no
 * liquid motion LoRA. With pictures the look switches per drum hit exactly
 * as his does; without, it changes by PROMPT per bar (our schedule node).
 * What that costs against his output is measured, not assumed: ANIMATE_GATE.
 *
 * THE GRAPH IS DATA. animateGraph() returns the JSON ComfyUI's /prompt takes;
 * the caller posts it through engine.dispatch(). Node ids 20-22 are the
 * control path's pixel chain, on purpose.
 */

export const ANIMATE_WEIGHTS = {
  checkpoint: "dreamshaper_8.safetensors",
  adapter: "v3_sd15_adapter.ckpt",              // models/loras — the v3 domain adapter LoRA
  motion: "v3_sd15_mm.ckpt",                    // models/animatediff_models
  depth: "control_v11f1p_sd15_depth_fp16.safetensors",
  lineart: "control_v11p_sd15_lineart_fp16.safetensors",
  depthEstimator: "depth_anything_v2_vits.pth", // Small, Apache-2.0 — see server/control/depth.js
  sparsectrl: "v3_sd15_sparsectrl_rgb.ckpt",     // models/controlnet — the source frames on the hits
};

/** The frame-rate doubling after the render: RIFE 4.26 (MIT, the catalogue's
 *  "Smooth motion" row, the same model the clip enhancer runs) through the
 *  ComfyUI-Frame-Interpolation pack — cleaner on a dancer's limbs than
 *  ffmpeg's motion compensation, and on the card. `file` is a clip in the
 *  engine's input folder; the result is saved under `prefix`. */
export const SMOOTH_MODEL = "rife_v4.26.safetensors";
export function smoothGraph({ file, fps = 12, multiplier = 2, prefix }) {
  if (typeof file !== "string" || !file.trim()) throw new Error("smoothGraph needs `file`: a clip's filename in the engine's input directory.");
  const mult = Math.min(Math.max(Math.round(Number(multiplier) || 2), 2), 8);
  return {
    1: { class_type: "LoadVideo", inputs: { file: String(file) } },
    2: { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
    3: { class_type: "FrameInterpolationModelLoader", inputs: { model_name: SMOOTH_MODEL } },
    4: { class_type: "FrameInterpolate", inputs: { interp_model: ["3", 0], images: ["2", 0], multiplier: mult } },
    5: { class_type: "CreateVideo", inputs: { images: ["4", 0], fps: Number(fps) * mult } },
    6: { class_type: "SaveVideo", inputs: { video: ["5", 0], filename_prefix: prefix || "animate/smooth", format: "auto", codec: "auto" } },
  };
}

/** Sampler settings. Yvann's graph runs AnimateLCM at 8 steps, cfg 2, "lcm";
 *  without a licensed LCM the v3 module runs a plain schedule. */
export const ANIMATE_PRESET = {
  fps: 12,
  steps: 20, cfg: 7.0, sampler: "dpmpp_2m", scheduler: "karras", denoise: 1.0,
  betaSchedule: "sqrt_linear (AnimateDiff)",
  context: { length: 16, stride: 1, overlap: 4, closedLoop: false, fuse: "pyramid" },
  depth: { strength: 0.3, start: 0, end: 0.5 },
  lineart: { strength: 0.5, start: 0, end: 0.7 },
  transitionFrames: 5,                          // his "Audio IPAdapter Transitions": linear, 5
};

/** Working sizes: SD1.5's, not the comp's. The compositor fills the frame. */
export const ANIMATE_SIZES = { landscape: [768, 432], portrait: [432, 768], square: [576, 576] };

/** With the DETAIL PASS on, the first pass runs small and the second at twice
 *  the size — the reference workflow's two passes (its first is 384 square,
 *  its second 2x at denoise 0.55). The small first pass lets the motion module
 *  and the pictures settle the composition; the second paints the detail.
 *  Measured 2026-09-19 on the 16 GB card under --lowvram: a second pass at
 *  1152x640 (48 frames) ran at 83 s a step against 3 s for the first — the
 *  card thrashing, 16 % busy — so the doubles stop at 1024x576. */
export const ANIMATE_SIZES_HIRES = { landscape: [512, 288], portrait: [288, 512], square: [384, 384] };
/* The second pass slides EIGHT-frame windows, not sixteen: the batch a window
 * puts through the UNet is its frames times two (the guidance pair), and at
 * 1024x576 sixteen frames' worth of activations pushed the 16 GB card into
 * streaming weights from the CPU (114 s a step, 4 % busy — measured
 * 2026-09-19); the first pass has already settled the motion, the second
 * repaints 0.55 of the way down, so the shorter window costs it little. */
export const HIRES_DEFAULTS = { scale: 2, denoise: 0.55, context: { length: 8, stride: 1, overlap: 2, closedLoop: false, fuse: "pyramid" } };

export const DEFAULT_NEGATIVE = "blurry, deformed, extra limbs, disfigured, text, watermark, low quality, jpeg artifacts";

/** What has been run. Updated by hand when a render is measured. */
export const ANIMATE_GATE = {
  /* 2026-09-19, the generated high-heels dance clip, 60 frames at 768x432,
   * three looks on the drum-stem bars, seed 424242, depth 0.3 + lineart 0.5:
   * 199 s engine clock through the door. Watched: no flicker, the dancer held
   * on every frame, the palette travelling magenta → blue → cyan → green on
   * the bar lines. Then, the same day, with three PICTURES through our
   * IP-Adapter node switching on every drum hit (eleven in five seconds,
   * five-frame cross-fades): 208 s. Watched: the paint pictures' palette
   * on every surface and on the dancer's suit, the neon-street picture
   * pulling its frames photographic under warm lamps, the dancer held
   * throughout — the reference workflow's mechanic. Still no LiquidAF
   * (no licence), so the paint does not FLOW between hits. Unscored. */
  ran: true, scored: false, render_seconds: 199, frames: 60, size: [768, 432],
  with_pictures: { render_seconds: 208, frames: 60, pictures: 3, hits: 11 },
  note: "Two renders measured at 768x432, 60 frames: 199 s with the look by prompt, 208 s with "
    + "three pictures through our IP-Adapter node switching on every drum hit; watched, not scored. "
    + "The LiquidAF motion LoRA (no licence) is the one piece of the reference not here.",
};

/**
 * scheduleFromBars({ bars, start, fps, frames, looks, transition }) -> { "<frame>": "<prompt>" }
 *
 * The look changes on the BARS (a new one every 0.87 s at 128 bpm would be a
 * strobe): each bar line inside the piece takes the next prompt, held until
 * `transition` frames before the following bar and blended into the next
 * across those frames — the shape of Yvann's 5-frame linear transition.
 * `bars` are song times in seconds, `start` the second the piece begins at.
 */
export function scheduleFromBars({ bars = [], start = 0, fps = 12, frames, looks, transition = ANIMATE_PRESET.transitionFrames }) {
  if (!Array.isArray(looks) || !looks.length) throw new Error("scheduleFromBars needs at least one look (a prompt).");
  const n = Math.max(1, Math.round(frames));
  const barFrames = bars.map((b) => Math.round((b - start) * fps)).filter((f) => f > 0 && f < n);
  const cuts = [0, ...barFrames];
  const out = {};
  for (let i = 0; i < cuts.length; i++) {
    const look = looks[i % looks.length];
    const at = cuts[i];
    const next = cuts[i + 1];
    out[String(at)] = look;
    if (next !== undefined && looks.length > 1) {
      /* hold this look until `transition` frames before the next bar, then
       * the interpolation to the next key carries it across the bar line. */
      const hold = Math.max(at, next - transition);
      if (hold > at) out[String(hold)] = look;
    }
  }
  return out;
}

/** The picture-reference weights, by licence: IP-Adapter Plus for SD1.5
 *  (h94/IP-Adapter, Apache-2.0) and the CLIP ViT-H tower it reads with
 *  (laion's MIT model, the copy in the same repository). Both hash-matched. */
export const IPADAPTER_WEIGHTS = {
  ipadapter: "ip-adapter-plus_sd15.safetensors",
  clipVision: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
};

/** The reference workflow's transition: a picture per peak segment, the
 *  pictures looping, a linear cross-fade of `transition` frames ending on
 *  each peak, weights between `min` and `max` ("Audio IPAdapter Transitions":
 *  linear, 5, 0.0, 1.0). */
export const IP_TRANSITION = { frames: 5, min: 0, max: 1 };

/**
 * ipScheduleFromPeaks({ peaks, frames, pictures, transition, min, max })
 *   -> { per_frame: [[[picture, weight], ...], ...] }
 *
 * `peaks` are FRAME indices (the drum-stem hits, as the reference's Audio
 * Peaks Detection gives them: threshold 0.4, at least 5 frames apart). Frame 0
 * is always a peak. Segment k (peak k up to peak k+1) shows picture k mod
 * `pictures`; over the last `transition` frames before peak k+1 the weight
 * crosses linearly to the next picture, so the switch LANDS on the hit.
 */
export function ipScheduleFromPeaks({ peaks = [], frames, pictures, transition = IP_TRANSITION.frames, min = IP_TRANSITION.min, max = IP_TRANSITION.max }) {
  const n = Math.max(1, Math.round(frames));
  const p = Math.max(1, Math.round(pictures));
  const cuts = [0, ...peaks.map((f) => Math.round(f)).filter((f) => f > 0 && f < n)].filter((f, i, a) => a.indexOf(f) === i).sort((a, b) => a - b);
  const R = (v) => Number(v.toFixed(4));
  const w = (t) => R(min + (max - min) * t);
  const per_frame = [];
  for (let f = 0; f < n; f++) {
    let k = 0;
    while (k + 1 < cuts.length && cuts[k + 1] <= f) k++;
    const cur = k % p;
    const next = cuts[k + 1];
    if (next !== undefined && transition > 0 && f >= next - transition) {
      const t = (f - (next - transition) + 1) / (transition + 1);   // 0 < t < 1, reaching 1 ON the peak
      per_frame.push([[cur, w(1 - t)], [(k + 1) % p, w(t)]]);
    } else {
      per_frame.push([[cur, w(1)]]);
    }
  }
  return { per_frame };
}

/**
 * animateGraph(opts) -> a ComfyUI /prompt graph.
 *
 *   source    the clip's filename in the ENGINE'S INPUT DIRECTORY, already at
 *             `fps` and at width x height (the caller conforms it with ffmpeg;
 *             LoadVideo gives frames as they are).
 *   frames    how many frames to read (the whole piece; context windows slide).
 *   width/height  the working size, from ANIMATE_SIZES.
 *   schedule  { "<frame>": "<prompt>" } from scheduleFromBars.
 *   negative, seed, steps, cfg, depth, lineart, prefix
 *   own             BRING YOUR OWN, none shipped: { motionModel, motionLora:
 *                   { name, strength }, modelLora: { name, strength }, sampler,
 *                   scheduler } — files in the engine's animatediff_models,
 *                   animatediff_motion_lora and loras folders, by name. The
 *                   reference workflow runs AnimateLCM (its motion module and
 *                   its SD LoRA, sampler lcm / sgm_uniform, 8 steps, cfg 2) and
 *                   the LiquidAF motion LoRA at 0.4; neither has licence text,
 *                   so the app does not fetch or list them in its catalogue —
 *                   a person who has them drops them in and names them here.
 *                   ⚠ UNVERIFIED on this rig (2026-09-19): no such file was on
 *                   it, so the graph shape is pinned and nothing else.
 *   sparse          { keyframes: [frame, ...], strength, start, end } — the
 *                   SOURCE frames at those indices as SparseCtrl keyframes
 *                   through our own node: the reference workflow anchors the
 *                   render to the source on every drum hit at strength 1.0
 *                   for the first half of sampling. Applied on both passes,
 *                   the window mapped onto the second like the holds.
 *   hires           { scale, denoise } — a second pass over the latent at
 *                   `scale` times the size, repainting `denoise` of it
 *                   (HIRES_DEFAULTS); the source frames are expected at that
 *                   larger size so the hints are sharp for the second pass
 *   ipadapter { pictures: [input-dir image names], schedule: ipScheduleFromPeaks(...), weight }
 *             the reference workflow's picture path: the pictures' tokens in
 *             every cross-attention layer, one or two live per frame. Optional.
 */
export function animateGraph({
  source, frames, width, height, schedule,
  negative = DEFAULT_NEGATIVE, seed, steps = ANIMATE_PRESET.steps, cfg = ANIMATE_PRESET.cfg,
  depth = ANIMATE_PRESET.depth, lineart = ANIMATE_PRESET.lineart, hintLift = 1, prefix = null,
  ipadapter = null, hires = null, own = null, sparse = null,
  /* HOW HARD THE PICTURE MOVES. AnimateDiff's motion module has a scale on it
   * (ADE_ApplyAnimateDiffModelSimple's `scale_multival`, fed by a plain float
   * through ADE_MultivalDynamic) and we were not sending one, so every piece
   * ran at the module's own 1.0. The reference workflow's animation changes far
   * harder between frames than ours did, and it reaches that partly through a
   * sampler we cannot ship (AnimateLCM at cfg 2, no licence text) — this is the
   * lever that is ours to turn. Above about 1.5 the motion stops being motion
   * and becomes churn; that ceiling is where the node's own range ends, and
   * where it stops looking like a dancer is not measured. */
  motionScale = 1,
} = {}) {
  if (typeof source !== "string" || !source.trim()) throw new Error("animateGraph needs `source`: a clip's filename in the engine's input directory.");
  const n = Number(frames);
  if (!Number.isInteger(n) || n < 1) throw new Error(`animateGraph: frames ${frames} is not a positive whole number.`);
  const w = Number(width), h = Number(height);
  if (!(w % 8 === 0 && h % 8 === 0)) throw new Error(`animateGraph: ${w}x${h} is not a multiple of 8 — SD1.5's VAE needs one.`);
  if (!schedule || typeof schedule !== "object" || !Object.keys(schedule).length) throw new Error("animateGraph needs a schedule: at least one frame → prompt.");
  if (!Number.isFinite(Number(seed))) throw new Error("animateGraph needs a numeric `seed`, so a render can be reproduced.");
  const short = Math.min(w, h);
  /* 1 is the module's own scale, so at 1 the node is not added at all and the
   * graph is byte-identical to the one every earlier piece rendered — which is
   * what lets an old render still be compared against a new one. */
  const ms = Number(motionScale);
  if (!(Number.isFinite(ms) && ms > 0 && ms <= 3)) throw new Error(`animateGraph: motionScale must be in (0, 3] — got ${motionScale}.`);
  const useMotionScale = ms !== 1;
  if (hires && !(Number(hires.scale) > 1 && Number(hires.denoise) > 0 && Number(hires.denoise) <= 1)) {
    throw new Error("animateGraph: hires needs scale > 1 and denoise in (0, 1].");
  }
  /* The hints are read at the SOURCE's short side: the source is staged at
   * the second pass's size when there is one, so the hints are sharp there
   * and core ControlNet scales them down for the first. */
  const hintShort = hires ? short * Number(hires.scale) : short;

  /* ⚠ THE PREPROCESSORS ARE BEING SHOWN A NEAR-BLACK FRAME, AND THAT IS THE
   * WHOLE OF THIS OPTION. Measured on a real dance clip (aiplay_zoom_s1_24.mp4,
   * frame 24, 512x293): 83.5% of the frame sits below luminance 0.05 and the
   * FIGURE's own column averages 0.068 — the dancer lives inside the bottom
   * five per cent of an eight-bit range, where the gradients a depth estimator
   * reads have already been quantised away. Raising the hint branch by 1/gamma
   * before the estimator sees it multiplies the edge energy inside that column
   * by 2.2 at gamma 2.2 (9.32 -> 20.10) and by 1.3 on an already-lit frame.
   *
   * ⚠ IT GOES ON THE HINT BRANCH ONLY. The frames the sampler paints keep their
   * own blacks; this is a lie told to the preprocessors on purpose. Lifting what
   * the sampler sees returns a washed-out render and the fault looks like the
   * model's. See server/comfy_nodes/aiplay_hint_lift.py for the gamma sweep and
   * for why a global stretch does nothing here (the frame's maximum is already
   * 0.949: the darkness is not a scaling problem).
   *
   * At 1 no node is added and the graph is byte-identical to the old one, so an
   * A/B against anything rendered before 2026-09-20 stays honest. */
  const lift = Number(hintLift);
  if (!(Number.isFinite(lift) && lift >= 1 && lift <= 4)) throw new Error(`animateGraph: hintLift must be in [1, 4] — got ${hintLift}.`);
  const useLift = lift !== 1;
  const hintFrom = useLift ? "23" : "22";
  const sp = sparse && Number(sparse.strength) > 0 ? sparse : null;
  if (sp && !(Array.isArray(sp.keyframes) && sp.keyframes.length)) throw new Error("animateGraph: sparse needs keyframes: the source frame indices to anchor on.");
  const c = ANIMATE_PRESET.context;
  const o = own && typeof own === "object" ? own : {};
  const sampler = String(o.sampler || ANIMATE_PRESET.sampler);
  const scheduler = String(o.scheduler || ANIMATE_PRESET.scheduler);
  const motionModel = String(o.motionModel || ANIMATE_WEIGHTS.motion);
  const motionLora = o.motionLora && o.motionLora.name ? { name: String(o.motionLora.name), strength: Number(o.motionLora.strength ?? 1) } : null;
  const modelLora = o.modelLora && o.modelLora.name ? { name: String(o.modelLora.name), strength: Number(o.modelLora.strength ?? 1) } : null;
  const savePrefix = prefix || `animate/ad_${Number(seed)}`;
  const pics = Array.isArray(ipadapter?.pictures) ? ipadapter.pictures.map((s) => String(s)).filter(Boolean) : [];
  if (ipadapter && !pics.length) throw new Error("animateGraph: ipadapter needs at least one picture.");
  if (ipadapter && !(ipadapter.schedule?.per_frame?.length)) throw new Error("animateGraph: ipadapter needs a schedule from ipScheduleFromPeaks.");
  const g = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ANIMATE_WEIGHTS.checkpoint } },
    2: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: ANIMATE_WEIGHTS.adapter, strength_model: 1.0 } },
    3: { class_type: "ADE_LoadAnimateDiffModel", inputs: { model_name: motionModel } },
    4: { class_type: "ADE_ApplyAnimateDiffModelSimple",
         inputs: { motion_model: ["3", 0], ...(motionLora ? { motion_lora: ["9", 0] } : {}),
                   ...(useMotionScale ? { scale_multival: ["11", 0] } : {}) } },
    ...(useMotionScale ? { 11: { class_type: "ADE_MultivalDynamic", inputs: { float_val: Number(motionScale) } } } : {}),
    ...(motionLora ? { 9: { class_type: "ADE_AnimateDiffLoRALoader", inputs: { name: motionLora.name, strength: motionLora.strength } } } : {}),
    /* A model LoRA of the person's own (AnimateLCM's, say) rides after the v3 adapter. */
    ...(modelLora ? { 10: { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: modelLora.name, strength_model: modelLora.strength } } } : {}),
    5: { class_type: "ADE_LoopedUniformContextOptions",
         inputs: { context_length: c.length, context_stride: c.stride, context_overlap: c.overlap, closed_loop: c.closedLoop, fuse_method: c.fuse } },
    6: { class_type: "ADE_UseEvolvedSampling",
         inputs: { model: [modelLora ? "10" : "2", 0], beta_schedule: ANIMATE_PRESET.betaSchedule, m_models: ["4", 0], context_options: ["5", 0] } },
    /* One conditioning per frame: the look on the bars, ours. */
    7: { class_type: "AiplayPromptSchedule", inputs: { clip: ["1", 1], frames: n, schedule: JSON.stringify(schedule), hold: false } },
    8: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: String(negative) } },
    /* The pixel chain, as the control path reads it. */
    20: { class_type: "LoadVideo", inputs: { file: String(source) } },
    21: { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
    22: { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: 0, length: n } },
    /* Structure: depth (Small, by licence — depth.js) and line art, both at the short side. */
    ...(useLift ? { 23: { class_type: "AiplayHintLift", inputs: { image: ["22", 0], gamma: lift } } } : {}),
    24: { class_type: "DepthAnythingV2Preprocessor", inputs: { image: [hintFrom, 0], ckpt_name: ANIMATE_WEIGHTS.depthEstimator, resolution: hintShort } },
    25: { class_type: "LineArtPreprocessor", inputs: { image: [hintFrom, 0], coarse: "disable", resolution: hintShort } },
    /* OUR loader, not core's: AnimateDiff-Evolved refuses a core ControlNet
     * under a sliding context window and points at the GPL Advanced-ControlNet
     * pack (measured 2026-09-19, KSampler: "may not support required features
     * for sliding context window"). aiplay_sliding_controlnet.py re-classes
     * the same object so it serves each window its own frames of the hint. */
    30: { class_type: "AiplayControlNetLoaderSliding", inputs: { control_net_name: ANIMATE_WEIGHTS.depth } },
    31: { class_type: "AiplayControlNetLoaderSliding", inputs: { control_net_name: ANIMATE_WEIGHTS.lineart } },
    32: { class_type: "ControlNetApplyAdvanced",
          inputs: { positive: ["7", 0], negative: ["8", 0], control_net: ["30", 0], image: ["24", 0],
                    strength: depth.strength, start_percent: depth.start, end_percent: depth.end, vae: ["1", 2] } },
    33: { class_type: "ControlNetApplyAdvanced",
          inputs: { positive: ["32", 0], negative: ["32", 1], control_net: ["31", 0], image: ["25", 0],
                    strength: lineart.strength, start_percent: lineart.start, end_percent: lineart.end, vae: ["1", 2] } },
    40: { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: n } },
    41: { class_type: "KSampler",
          inputs: { model: ["6", 0], positive: [sp ? "27" : "33", 0], negative: [sp ? "27" : "33", 1], latent_image: ["40", 0],
                    seed: Number(seed), steps: Number(steps), cfg: Number(cfg),
                    sampler_name: sampler, scheduler, denoise: ANIMATE_PRESET.denoise } },
    42: { class_type: "VAEDecode", inputs: { samples: ["41", 0], vae: ["1", 2] } },
    43: { class_type: "CreateVideo", inputs: { images: ["42", 0], fps: ANIMATE_PRESET.fps } },
    44: { class_type: "SaveVideo", inputs: { video: ["43", 0], filename_prefix: savePrefix, format: "auto", codec: "auto" } },
  };
  /* THE SOURCE ON THE HITS: SparseCtrl keyframes through our own node — the
   * source frames at the hit indices, VAE-encoded, with a mask that says
   * which frames are keyframes; the network's own temporal layers carry
   * them across the window. Yvann's vid2vid runs it at 1.0 for 0–0.5. */
  if (sp) {
    g[26] = { class_type: "AiplaySparseCtrlLoader", inputs: { sparsectrl_file: ANIMATE_WEIGHTS.sparsectrl } };
    g[27] = { class_type: "AiplaySparseCtrlApply",
              inputs: { positive: ["33", 0], negative: ["33", 1], sparsectrl: ["26", 0], vae: ["1", 2], image: undefined, images: ["22", 0],
                        keyframes: JSON.stringify(sp.keyframes.map((k) => Math.max(0, Math.min(n - 1, Math.round(Number(k)))))), frames: n,
                        strength: Number(sp.strength), start_percent: Number(sp.start ?? 0), end_percent: Number(sp.end ?? 0.5) } };
    delete g[27].inputs.image;
  }
  /* THE DETAIL PASS: the first pass's latent, scaled up, sampled again from
   * `denoise` of the way down under the same model, pictures and controls —
   * the reference workflow's second KSampler (0.55, 2x). */
  if (hires) {
    const hc = hires.context || HIRES_DEFAULTS.context;
    /* THE HOLDS IN THE SECOND PASS. ControlNet windows are fractions of the
     * whole noise schedule, and a pass at denoise d starts (1 - d) of the way
     * down it: with depth ending at 0.5 and d = 0.55 the second pass began at
     * 0.45 and lost its depth five percent later, then repainted the figure
     * unheld — the dancer came out a blob (2026-09-19). Each control's window
     * is mapped onto the second pass's own range, so it holds the same
     * fraction of that pass as it held of the first. */
    const d = Number(hires.denoise);
    const onto = (p) => Number(((1 - d) + Math.min(Math.max(Number(p) || 0, 0), 1) * d).toFixed(4));
    g[34] = { class_type: "ControlNetApplyAdvanced",
              inputs: { positive: ["7", 0], negative: ["8", 0], control_net: ["30", 0], image: ["24", 0],
                        strength: depth.strength, start_percent: onto(depth.start), end_percent: onto(depth.end), vae: ["1", 2] } };
    g[35] = { class_type: "ControlNetApplyAdvanced",
              inputs: { positive: ["34", 0], negative: ["34", 1], control_net: ["31", 0], image: ["25", 0],
                        strength: lineart.strength, start_percent: onto(lineart.start), end_percent: onto(lineart.end), vae: ["1", 2] } };
    g[47] = { class_type: "ADE_LoopedUniformContextOptions",
              inputs: { context_length: hc.length, context_stride: hc.stride, context_overlap: hc.overlap, closed_loop: hc.closedLoop, fuse_method: hc.fuse } };
    g[48] = { class_type: "ADE_UseEvolvedSampling",
              inputs: { model: g[6].inputs.model, beta_schedule: ANIMATE_PRESET.betaSchedule, m_models: ["4", 0], context_options: ["47", 0] } };
    if (sp) {
      g[36] = { class_type: "AiplaySparseCtrlApply",
                inputs: { positive: ["35", 0], negative: ["35", 1], sparsectrl: ["26", 0], vae: ["1", 2], images: ["22", 0],
                          keyframes: g[27].inputs.keyframes, frames: n,
                          strength: Number(sp.strength), start_percent: onto(sp.start ?? 0), end_percent: onto(sp.end ?? 0.5) } };
    }
    g[45] = { class_type: "LatentUpscaleBy", inputs: { samples: ["41", 0], upscale_method: "bislerp", scale_by: Number(hires.scale) } };
    g[46] = { class_type: "KSampler",
              inputs: { model: ["48", 0], positive: [sp ? "36" : "35", 0], negative: [sp ? "36" : "35", 1], latent_image: ["45", 0],
                        seed: Number(seed), steps: Number(steps), cfg: Number(cfg),
                        sampler_name: sampler, scheduler, denoise: Number(hires.denoise) } };
    g[42].inputs.samples = ["46", 0];
  }
  /* THE PICTURES, when given: the CLIP tower, the adapter weights, each
   * picture loaded and batched, and our per-frame apply patched onto the
   * model between the adapter LoRA and evolved sampling — where the
   * reference workflow's IPAdapterBatch sits. */
  if (pics.length) {
    g[50] = { class_type: "CLIPVisionLoader", inputs: { clip_name: IPADAPTER_WEIGHTS.clipVision } };
    g[51] = { class_type: "AiplayIPAdapterLoader", inputs: { ipadapter_file: IPADAPTER_WEIGHTS.ipadapter } };
    pics.forEach((name, i) => { g[52 + i] = { class_type: "LoadImage", inputs: { image: name } }; });
    let batch = ["52", 0];
    for (let i = 1; i < pics.length; i++) {
      g[80 + i] = { class_type: "ImageBatch", inputs: { image1: batch, image2: [String(52 + i), 0] } };
      batch = [String(80 + i), 0];
    }
    g[70] = { class_type: "AiplayIPAdapterApply",
              inputs: { model: [modelLora ? "10" : "2", 0], ipadapter: ["51", 0], clip_vision: ["50", 0], image: undefined, images: batch,
                        frames: n, schedule: JSON.stringify(ipadapter.schedule), weight: Number(ipadapter.weight ?? 1.0) } };
    delete g[70].inputs.image;
    g[6].inputs.model = ["70", 0];
    if (g[48]) g[48].inputs.model = ["70", 0];
  }
  return g;
}
