/**
 * MiniMax-H3-Image: text to image and reference edits, on ComfyUI's own core
 * nodes (comfy_extras/nodes_minimax_h3.py, MiniMaxH3ImageConditioning).
 *
 *   UNETLoader ----------------------------------------------> KSampler.model
 *   CLIPLoader(type minimax) -> MiniMaxH3ImageConditioning -+-> KSampler.positive
 *   VAELoader --------------^ (refs anchored as latents)    +-> ConditioningZeroOut -> .negative
 *   LoadImage x N -> images.image_1..N                      +-> LATENT -> .latent_image
 *   KSampler -> VAEDecode -> SaveImage (+ thumbnail)
 *
 * The recipe is the one ComfyUI's "MiniMax-H3-Image" templates ship and the
 * one measured on a 16 GB RTX 4070 Ti SUPER: 6 steps, CFG 1, euler (the
 * template) or lcm (the most natural skin), scheduler simple. At CFG 1 the
 * negative branch is never evaluated, so a negative prompt is refused rather
 * than ignored; things to avoid go at the end of the prompt.
 *
 * The prompt refers to the references as <Picture 1>, <Picture 2>, … in the
 * order they arrive. image_1 is the picture being edited, and without an
 * explicit size the canvas follows it (the node's own rule for width/height 0).
 */
import { requireModelName } from "./localmodels.js";

export const H3_IMAGE_ENGINE = "h3-image";
export const H3_IMAGE_CAPABILITY = "imageH3";

export const H3_IMAGE_FILES = Object.freeze({
  dit: "minimax_h3_image_pruned_int8_convrot.safetensors",
  vae: "minimax_h3_image_vae_fp16.safetensors",
  /* The image model reads the same Qwen3-VL 32B encoder as H3 video; the
   * caller passes whichever build is on disk (config.video.engines.h3). */
  encoder: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
});

export const H3_IMAGE_PRESET = Object.freeze({
  steps: 6, cfg: 1, sampler: "lcm", scheduler: "simple",
  /* The model is tuned for 2048x2048 of area; the node's canvas step is 32. */
  size: 2048, multiple: 32, minSide: 256, maxSide: 4096,
  maxRefs: 10, maxCount: 4, maxSteps: 30,
});

export const H3_IMAGE_NODES = Object.freeze({ full: "13", thumb: "15" });

const snap = (v, fallback) => {
  const n = Number(v);
  const x = Number.isFinite(n) && n > 0 ? n : fallback;
  const m = H3_IMAGE_PRESET.multiple;
  return Math.min(H3_IMAGE_PRESET.maxSide, Math.max(H3_IMAGE_PRESET.minSide, Math.round(x / m) * m));
};

const fileName = (value, fallback, what) => {
  const v = value == null || value === "" ? fallback : value;
  if (typeof v !== "string" || !v.trim()) throw new TypeError(`${what} must be a file name.`);
  return requireModelName(v.trim());
};

/**
 * Build the API-format graph. Throws a sentence (TypeError / RangeError) for
 * anything the model cannot honour, so the route can answer 400 with it.
 *
 * `width`/`height` null or 0 with references: the canvas follows image_1.
 * Without references and without a size: 2048 x 2048.
 */
export function h3ImageGraph({
  prompt, negative = "", seed = 0, width, height, steps, cfg,
  count = 1, prefix = "image", thumbSize = 256,
  refImages = [], sampler, scheduler,
  dit = null, encoder = null, vae = null,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("H3 Image needs a prompt.");
  if (typeof negative !== "string") throw new TypeError("The negative prompt must be text.");
  if (negative.trim()) {
    throw new RangeError("H3 Image samples at CFG 1, where a negative prompt is never evaluated. Put what to avoid at the end of the prompt instead.");
  }
  if (cfg != null && Number(cfg) !== 1) throw new RangeError("H3 Image runs at CFG 1 only (its distilled recipe).");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError("seed must be a non-negative safe integer.");
  if (!Array.isArray(refImages) || refImages.length > H3_IMAGE_PRESET.maxRefs) {
    throw new RangeError(`H3 Image accepts up to ${H3_IMAGE_PRESET.maxRefs} reference images.`);
  }
  const refs = refImages.map((n) => (typeof n === "string" ? n.trim() : ""));
  if (refs.some((n) => !n || /[\\/]|\.\./.test(n))) throw new TypeError("Reference images must be plain file names in ComfyUI's input folder.");

  const stepCount = steps == null ? H3_IMAGE_PRESET.steps : Math.round(Number(steps));
  if (!(stepCount >= 1 && stepCount <= H3_IMAGE_PRESET.maxSteps)) throw new RangeError(`steps must be 1 to ${H3_IMAGE_PRESET.maxSteps}.`);
  const samplerName = sampler || H3_IMAGE_PRESET.sampler;
  const schedulerName = scheduler || H3_IMAGE_PRESET.scheduler;
  /* Any ComfyUI sampler / scheduler name is passed through (the screen lists
   * the engine's own); lcm and euler are the two measured on this model. */
  if (!/^[a-z0-9_]{1,40}$/.test(String(samplerName))) throw new RangeError("The sampler must be a ComfyUI sampler name, e.g. lcm or euler.");
  if (!/^[a-z0-9_]{1,40}$/.test(String(schedulerName))) throw new RangeError("The scheduler must be a ComfyUI scheduler name, e.g. simple.");
  const batch = Math.round(Number(count) || 1);
  if (!(batch >= 1 && batch <= H3_IMAGE_PRESET.maxCount)) throw new RangeError(`count must be 1 to ${H3_IMAGE_PRESET.maxCount}.`);
  const thumb = Math.min(1024, Math.max(32, Math.round(Number(thumbSize) || 256)));

  const followRef = refs.length > 0 && !(Number(width) > 0 && Number(height) > 0);
  const w = followRef ? 0 : snap(width, H3_IMAGE_PRESET.size);
  const h = followRef ? 0 : snap(height, H3_IMAGE_PRESET.size);

  const modelFile = fileName(dit, H3_IMAGE_FILES.dit, "Diffusion model");
  const clipFile = fileName(encoder, H3_IMAGE_FILES.encoder, "Text encoder");
  const vaeFile = fileName(vae, H3_IMAGE_FILES.vae, "VAE");

  const cond = { clip: ["2", 0], vae: ["3", 0], prompt, width: w, height: h };
  const graph = {
    1: { class_type: "UNETLoader", inputs: { unet_name: modelFile, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: clipFile, type: "minimax", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: vaeFile } },
    4: { class_type: "MiniMaxH3ImageConditioning", inputs: cond },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
  };
  refs.forEach((image, i) => {
    const id = String(40 + i);
    graph[id] = { class_type: "LoadImage", inputs: { image } };
    cond[`images.image_${i + 1}`] = [id, 0];
  });
  let latent = ["4", 1];
  if (batch > 1) {
    graph[7] = { class_type: "RepeatLatentBatch", inputs: { samples: latent, amount: batch } };
    latent = ["7", 0];
  }
  graph[8] = { class_type: "KSampler",
    inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: latent,
              seed, steps: stepCount, cfg: 1, sampler_name: samplerName, scheduler: schedulerName, denoise: 1 } };
  graph[17] = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } };
  graph[13] = { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: String(prefix || "image") } };
  graph[14] = { class_type: "ImageScale",
    inputs: { image: ["17", 0], upscale_method: "lanczos", width: thumb, height: thumb, crop: "center" } };
  graph[15] = { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${prefix || "image"}_thumb` } };
  return graph;
}

/** What a built graph will actually sample with, for the picture's record. */
export function h3ImageSettings(graph) {
  const k = graph[8].inputs;
  const c = graph[4].inputs;
  return {
    steps: k.steps, cfg: k.cfg, sampler: k.sampler_name, scheduler: k.scheduler,
    count: graph[7]?.inputs?.amount || 1,
    refImages: Object.keys(c).filter((key) => key.startsWith("images.image_"))
      .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()))
      .map((key) => graph[c[key][0]].inputs.image),
    requestedWidth: c.width || null, requestedHeight: c.height || null,
    sizeSource: c.width ? "requested" : "first-reference",
    dit: graph[1].inputs.unet_name, encoder: graph[2].inputs.clip_name, vae: graph[3].inputs.vae_name,
  };
}

/** The node types a ComfyUI must have for this graph (all ship in core). */
export const H3_IMAGE_REQUIRED_NODES = Object.freeze([
  "UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3ImageConditioning", "ConditioningZeroOut",
  "KSampler", "VAEDecode", "SaveImage", "ImageScale",
]);
