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
};

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
 *   ipadapter { pictures: [input-dir image names], schedule: ipScheduleFromPeaks(...), weight }
 *             the reference workflow's picture path: the pictures' tokens in
 *             every cross-attention layer, one or two live per frame. Optional.
 */
export function animateGraph({
  source, frames, width, height, schedule,
  negative = DEFAULT_NEGATIVE, seed, steps = ANIMATE_PRESET.steps, cfg = ANIMATE_PRESET.cfg,
  depth = ANIMATE_PRESET.depth, lineart = ANIMATE_PRESET.lineart, prefix = null,
  ipadapter = null,
} = {}) {
  if (typeof source !== "string" || !source.trim()) throw new Error("animateGraph needs `source`: a clip's filename in the engine's input directory.");
  const n = Number(frames);
  if (!Number.isInteger(n) || n < 1) throw new Error(`animateGraph: frames ${frames} is not a positive whole number.`);
  const w = Number(width), h = Number(height);
  if (!(w % 8 === 0 && h % 8 === 0)) throw new Error(`animateGraph: ${w}x${h} is not a multiple of 8 — SD1.5's VAE needs one.`);
  if (!schedule || typeof schedule !== "object" || !Object.keys(schedule).length) throw new Error("animateGraph needs a schedule: at least one frame → prompt.");
  if (!Number.isFinite(Number(seed))) throw new Error("animateGraph needs a numeric `seed`, so a render can be reproduced.");
  const short = Math.min(w, h);
  const c = ANIMATE_PRESET.context;
  const savePrefix = prefix || `animate/ad_${Number(seed)}`;
  const pics = Array.isArray(ipadapter?.pictures) ? ipadapter.pictures.map((s) => String(s)).filter(Boolean) : [];
  if (ipadapter && !pics.length) throw new Error("animateGraph: ipadapter needs at least one picture.");
  if (ipadapter && !(ipadapter.schedule?.per_frame?.length)) throw new Error("animateGraph: ipadapter needs a schedule from ipScheduleFromPeaks.");
  const g = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ANIMATE_WEIGHTS.checkpoint } },
    2: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: ANIMATE_WEIGHTS.adapter, strength_model: 1.0 } },
    3: { class_type: "ADE_LoadAnimateDiffModel", inputs: { model_name: ANIMATE_WEIGHTS.motion } },
    4: { class_type: "ADE_ApplyAnimateDiffModelSimple", inputs: { motion_model: ["3", 0] } },
    5: { class_type: "ADE_LoopedUniformContextOptions",
         inputs: { context_length: c.length, context_stride: c.stride, context_overlap: c.overlap, closed_loop: c.closedLoop, fuse_method: c.fuse } },
    6: { class_type: "ADE_UseEvolvedSampling",
         inputs: { model: ["2", 0], beta_schedule: ANIMATE_PRESET.betaSchedule, m_models: ["4", 0], context_options: ["5", 0] } },
    /* One conditioning per frame: the look on the bars, ours. */
    7: { class_type: "AiplayPromptSchedule", inputs: { clip: ["1", 1], frames: n, schedule: JSON.stringify(schedule), hold: false } },
    8: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: String(negative) } },
    /* The pixel chain, as the control path reads it. */
    20: { class_type: "LoadVideo", inputs: { file: String(source) } },
    21: { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
    22: { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: 0, length: n } },
    /* Structure: depth (Small, by licence — depth.js) and line art, both at the short side. */
    24: { class_type: "DepthAnythingV2Preprocessor", inputs: { image: ["22", 0], ckpt_name: ANIMATE_WEIGHTS.depthEstimator, resolution: short } },
    25: { class_type: "LineArtPreprocessor", inputs: { image: ["22", 0], coarse: "disable", resolution: short } },
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
          inputs: { model: ["6", 0], positive: ["33", 0], negative: ["33", 1], latent_image: ["40", 0],
                    seed: Number(seed), steps: Number(steps), cfg: Number(cfg),
                    sampler_name: ANIMATE_PRESET.sampler, scheduler: ANIMATE_PRESET.scheduler, denoise: ANIMATE_PRESET.denoise } },
    42: { class_type: "VAEDecode", inputs: { samples: ["41", 0], vae: ["1", 2] } },
    43: { class_type: "CreateVideo", inputs: { images: ["42", 0], fps: ANIMATE_PRESET.fps } },
    44: { class_type: "SaveVideo", inputs: { video: ["43", 0], filename_prefix: savePrefix, format: "auto", codec: "auto" } },
  };
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
              inputs: { model: ["2", 0], ipadapter: ["51", 0], clip_vision: ["50", 0], image: undefined, images: batch,
                        frames: n, schedule: JSON.stringify(ipadapter.schedule), weight: Number(ipadapter.weight ?? 1.0) } };
    delete g[70].inputs.image;
    g[6].inputs.model = ["70", 0];
  }
  return g;
}
