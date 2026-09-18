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
 *
 * NOT here, on purpose: IPAdapter_plus and Advanced-ControlNet are GPL-3.0
 * and cannot ship inside this Apache-2.0 tree; AnimateLCM has no licence
 * text; the LiquidAF motion LoRA has no readable terms. So the look changes
 * by PROMPT per bar (our schedule node, the text half of what IPAdapter's
 * per-frame weights do) rather than by reference picture, and the sampler
 * runs the v3 module on its own schedule rather than LCM's four steps. What
 * that costs against his output is measured, not assumed: see ANIMATE_GATE.
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
   * the bar lines. NOT Yvann's liquid texture — his comes from IPAdapter
   * pictures and the LiquidAF LoRA, neither of which ships here. Unscored. */
  ran: true, scored: false, render_seconds: 199, frames: 60, size: [768, 432],
  note: "One render measured (199 s for 60 frames at 768x432); watched, not scored. The look "
    + "moves on the bars by prompt; the liquid-paint texture of the reference workflow needs "
    + "its IPAdapter pictures (GPL pack) or the LiquidAF LoRA (no licence), so it is not here.",
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
 */
export function animateGraph({
  source, frames, width, height, schedule,
  negative = DEFAULT_NEGATIVE, seed, steps = ANIMATE_PRESET.steps, cfg = ANIMATE_PRESET.cfg,
  depth = ANIMATE_PRESET.depth, lineart = ANIMATE_PRESET.lineart, prefix = null,
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
  return {
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
}
