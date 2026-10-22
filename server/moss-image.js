/** Native MOSS-Image SFT text-to-image. Pure validation and graph construction.
 * Recipe: ComfyUI 0.42.1's bundled image_moss_image_t2i template. Prompt
 * upsampling and skip-layer guidance are deliberately off: the recorded prompt
 * is exactly what the encoder receives. Editing remains on Qwen Image 2.1. */
import { requireModelName, modelLeaf } from "./localmodels.js";

export const MOSS_IMAGE_ENGINE = "moss-image";
export const MOSS_IMAGE_FILES = Object.freeze({
  dit: "moss_image_sft_int8_convrot.safetensors",
  encoder: "qwen3.5_9b_w4a8_gptq.safetensors",
  vae: "flux2-vae_small.safetensors",
});
export const MOSS_IMAGE_PRESET = Object.freeze({
  steps: 25, maxSteps: 50, cfg: 2.5, sampler: "er_sde", scheduler: "simple",
  size: 1024, maxCount: 4,
});
export const MOSS_IMAGE_NODES = Object.freeze({ full: "13", thumb: "15" });

const number = (value, fallback, min, max, name, integer = false) => {
  const n = value ?? fallback;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) {
    throw new RangeError(name + " must be " + (integer ? "an integer" : "a number") + " from " + min + " to " + max + ".");
  }
  return n;
};
const side = (value, name) => {
  const n = number(value, MOSS_IMAGE_PRESET.size, 256, 2048, name, true);
  if (n % 16) throw new RangeError(name + " must be a multiple of 16.");
  return n;
};
const model = (value, fallback, name) => {
  const file = requireModelName(value || fallback);
  if (!/\.safetensors$/i.test(file)) throw new TypeError(name + " needs a native safetensors file; MOSS GGUF has not been validated.");
  if (modelLeaf(file) !== fallback) throw new TypeError(name + " must use the verified MOSS-Image SFT bundle (" + fallback + "); other files have not been validated.");
  return file;
};

/** Unsupported inputs fail before queueing rather than being silently dropped. */
export function mossImageOptions(options = {}) {
  const o = options;
  if (typeof o.prompt !== "string" || !o.prompt.trim()) throw new TypeError("MOSS-Image needs a prompt.");
  if (o.refImages !== undefined && !Array.isArray(o.refImages)) throw new TypeError("refImages must be an array.");
  if (o.refImages?.length || o.persona || o.personas?.length) throw new Error("MOSS-Image currently makes pictures from text only. Choose Qwen Image 2.1 or FLUX.2 for references or personas.");
  if (o.transparent === true) throw new Error("MOSS-Image does not generate transparency. Choose Qwen Image 2.1 for transparent pictures.");
  if (o.draft === true) throw new Error("Fast draft is a Qwen Image 2.1 setting. Turn it off for MOSS-Image.");
  if (o.loras?.length || o.clipSkip !== undefined) throw new Error("Custom LoRAs and CLIP skip are not supported by this MOSS-Image preset.");
  if (o.mode || o.selection || o.source || o.documentId) throw new Error("MOSS-Image is text-to-image only. Use the Qwen image editor for edits.");
  const sampler = o.sampler ?? MOSS_IMAGE_PRESET.sampler;
  const scheduler = o.scheduler ?? MOSS_IMAGE_PRESET.scheduler;
  if (sampler !== MOSS_IMAGE_PRESET.sampler || scheduler !== MOSS_IMAGE_PRESET.scheduler) throw new Error("The MOSS-Image preset uses er_sde / simple.");
  const cfg = number(o.cfg, MOSS_IMAGE_PRESET.cfg, 1, 10, "cfg");
  const negative = o.negative ?? "";
  if (typeof negative !== "string" || negative.length > 2000) throw new TypeError("negative must be a string of at most 2000 characters.");
  if (negative.trim() && cfg === 1) throw new Error("A MOSS-Image negative prompt needs CFG above 1.");
  for (const flag of ["transparent", "draft"]) if (o[flag] !== undefined && typeof o[flag] !== "boolean") throw new TypeError(flag + " must be true or false.");
  return {
    prompt: o.prompt, negative,
    width: side(o.width, "width"), height: side(o.height, "height"),
    steps: number(o.steps, MOSS_IMAGE_PRESET.steps, 1, MOSS_IMAGE_PRESET.maxSteps, "steps", true),
    cfg, count: number(o.count, 1, 1, MOSS_IMAGE_PRESET.maxCount, "count", true),
    seed: number(o.seed, 0, 0, Number.MAX_SAFE_INTEGER, "seed", true),
    sampler, scheduler,
    dit: model(o.dit, MOSS_IMAGE_FILES.dit, "Diffusion model"),
    encoder: model(o.encoder, MOSS_IMAGE_FILES.encoder, "Text encoder"),
    vae: model(o.vae, MOSS_IMAGE_FILES.vae, "VAE"),
    prefix: typeof o.prefix === "string" && o.prefix ? o.prefix : "aiplay_image",
    thumbSize: number(o.thumbSize, 256, 64, 1024, "thumbSize", true),
  };
}

export function mossImageGraph(options = {}) {
  const o = mossImageOptions(options);
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: o.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: o.encoder, type: "moss_image", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: o.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: o.prompt } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: o.negative } },
    7: { class_type: "EmptyFlux2LatentImage", inputs: { width: o.width, height: o.height, batch_size: o.count } },
    8: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0], seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: o.sampler, scheduler: o.scheduler, denoise: 1 } },
    12: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    13: { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: o.prefix } },
    14: { class_type: "ImageScale", inputs: { image: ["12", 0], upscale_method: "area", width: o.thumbSize, height: o.thumbSize, crop: "center" } },
    15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: o.prefix + "_thumb" } },
  };
}

export function mossImageSettings(graph) {
  const n = graph[8].inputs;
  return { steps: n.steps, cfg: n.cfg, sampler: n.sampler_name, scheduler: n.scheduler,
    shift: 5, shiftSource: "native-model-default", promptUpsampler: false, skipLayerGuidance: false };
}
