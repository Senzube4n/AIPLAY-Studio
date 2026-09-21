/**
 * Native Qwen Image 2.1 generation and editing. Pure graph construction only.
 *
 * Schemas checked against Comfy-Org/ComfyUI b0f4b7b294ce482a2e071d9d762c133d38c7aa07:
 *   comfy_extras/nodes_qwen.py (TextEncodeQwenImage21)
 *   comfy_extras/nodes_compositing.py (JoinImageWithAlpha)
 *   nodes.py (load/save, latent batch and sampling nodes).
 * Recipe: Comfy-Org/workflow_templates 371a7b7171bbd11e9cc92ef615ba5ad223d7e5b4,
 * templates/image_qwen_image_2_1_{t2i,image_edit}.json.
 *
 * The edit node's THIRD output is the empty latent matching reference one.
 * Using an independently sized latent can shift an edit, so changing its size
 * requires refSizing: "custom". References are separate autogrow inputs, not
 * an ImageBatch: the encoder consumes only the first image of each input.
 */
export const QWEN_IMAGE_FILES = Object.freeze({
  dit: "qwen_image_2.1_int8_convrot.safetensors",
  encoder: "qwen3vl_8b_int8_convrot.safetensors",
  vae: "qwen_image_2.1_vae_bf16.safetensors",
});

export const QWEN_IMAGE_PRESET = Object.freeze({
  steps: 25, cfg: 1, cfgs: true, sampler: "euler", scheduler: "simple",
  size: 1024, maxRefs: 10, maxSteps: 50, maxCount: 4,
});

// Same output IDs as COVER_NODES: the existing result reader can consume both.
export const QWEN_IMAGE_NODES = Object.freeze({ full: "13", thumb: "15" });
export const QWEN_IMAGE_REQUIRED_NODES = Object.freeze([
  "UNETLoader", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21",
  "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage", "ImageScale",
]);
export const QWEN_IMAGE_REFERENCE_NODES = Object.freeze([
  "LoadImage", "JoinImageWithAlpha", "RepeatLatentBatch",
]);

function bounded(value, fallback, min, max, label, integer = true) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return Math.min(max, Math.max(min, integer ? Math.round(value) : value));
}

function dimension(value, fallback, label) {
  return Math.ceil(bounded(value, fallback, 256, 4096, label) / 32) * 32;
}

function filename(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty filename.`);
  }
  return value.trim();
}

/**
 * refImages are names already uploaded to ComfyUI's input directory.
 * transparent requests native RGBA through the publisher's prompt format;
 * PNG saving preserves every decoded channel. It is a model request, not a
 * postprocessing promise that every generated pixel will have useful alpha.
 *
 * Only native safetensors are supported here. GGUF needs separate backend
 * validation; the linked publisher's current Q8_0 also has a sampling defect.
 */
export function qwenImageGraph({
  prompt, negative = "", seed = 0, width, height, steps, cfg,
  count = 1, prefix = "image", thumbSize = 256,
  refImages = [], refSizing = "reference", refResolution = 1024,
  transparent = false, dit = null, encoder = null, vae = null,
  sampler = QWEN_IMAGE_PRESET.sampler, scheduler = QWEN_IMAGE_PRESET.scheduler,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("Qwen Image needs a prompt.");
  if (typeof negative !== "string") throw new TypeError("The negative prompt must be text.");
  if (!Array.isArray(refImages) || refImages.length > QWEN_IMAGE_PRESET.maxRefs) {
    throw new RangeError("Qwen Image accepts up to 10 reference images.");
  }
  const refs = refImages.map((name) => filename(name, null, "Reference image"));
  if (refs.some((name) => name == null)) throw new TypeError("Reference images must be non-empty filenames.");
  if (!["reference", "custom"].includes(refSizing)) throw new TypeError("refSizing must be reference or custom.");
  if (typeof transparent !== "boolean") throw new TypeError("transparent must be a boolean.");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError("seed must be a non-negative safe integer.");
  if (sampler !== QWEN_IMAGE_PRESET.sampler || scheduler !== QWEN_IMAGE_PRESET.scheduler) {
    throw new RangeError("The Qwen Image preset uses the verified euler / simple sampler.");
  }
  const guidance = bounded(cfg, QWEN_IMAGE_PRESET.cfg, 1, 10, "cfg", false);
  if (negative.trim() && guidance === 1) {
    throw new RangeError("A negative prompt needs cfg greater than 1; at cfg 1 it is not evaluated.");
  }
  const batch = bounded(count, 1, 1, QWEN_IMAGE_PRESET.maxCount, "count");
  const w = dimension(width, QWEN_IMAGE_PRESET.size, "width");
  const h = dimension(height, QWEN_IMAGE_PRESET.size, "height");
  const refSize = Math.ceil(bounded(refResolution, 1024, 0, 4096, "refResolution") / 32) * 32;
  const thumb = bounded(thumbSize, 256, 32, 1024, "thumbSize");
  const modelFile = filename(dit, QWEN_IMAGE_FILES.dit, "Diffusion model");
  const clipFile = filename(encoder, QWEN_IMAGE_FILES.encoder, "Text encoder");
  const vaeFile = filename(vae, QWEN_IMAGE_FILES.vae, "VAE");
  for (const name of [modelFile, clipFile, vaeFile]) {
    if (!/\.safetensors$/i.test(name)) throw new TypeError("Qwen Image 2.1 currently supports native .safetensors files only; GGUF has not been validated.");
  }
  const outputPrefix = filename(prefix, "image", "Output prefix");
  const text = transparent
    ? `This is an RGBA format image with transparency. ${prompt.trim()} The image has an alpha channel and a transparent background.`
    : prompt;
  const conditioning = { clip: ["2", 0], prompt: text, negative_prompt: negative, resolution: refSize };
  const graph = {
    1: { class_type: "UNETLoader", inputs: { unet_name: modelFile, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: clipFile, type: "qwen_image", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: vaeFile } },
    4: { class_type: "TextEncodeQwenImage21", inputs: conditioning },
  };

  if (refs.length) {
    conditioning.vae = ["3", 0];
    refs.forEach((image, i) => {
      const load = String(40 + i * 2), join = String(41 + i * 2);
      graph[load] = { class_type: "LoadImage", inputs: { image } };
      // LoadImage returns RGB and an inverted-alpha mask. JoinImageWithAlpha
      // consumes that mask convention and reconstructs RGBA, including opaque
      // JPEGs. No extra inversion and no image batching here.
      graph[join] = { class_type: "JoinImageWithAlpha", inputs: { image: [load, 0], alpha: [load, 1] } };
      conditioning[`images.image_${i + 1}`] = [join, 0];
    });
  }

  let latent = ["7", 0];
  if (refs.length && refSizing === "reference") {
    latent = ["4", 2];
    if (batch > 1) {
      graph[7] = { class_type: "RepeatLatentBatch", inputs: { samples: latent, amount: batch } };
      latent = ["7", 0];
    }
  } else {
    // The official template uses EmptyLatentImage; ComfyUI fixes its channel
    // and spatial format to QwenImage21 before sampling. Do not substitute an
    // old Qwen/FLUX latent by guessing the architecture from the model name.
    graph[7] = { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: batch } };
  }
  graph[8] = {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0], positive: ["4", 0], negative: ["4", 1], latent_image: latent,
      seed, steps: bounded(steps, QWEN_IMAGE_PRESET.steps, 1, QWEN_IMAGE_PRESET.maxSteps, "steps"),
      cfg: guidance, sampler_name: sampler, scheduler, denoise: 1,
    },
  };
  graph[17] = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } };
  graph[13] = { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: outputPrefix } };
  graph[14] = { class_type: "ImageScale", inputs: { image: ["17", 0], upscale_method: "lanczos", width: thumb, height: thumb, crop: "center" } };
  graph[15] = { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${outputPrefix}_thumb` } };
  return graph;
}

/** Exact node set for readiness checks. */
export function qwenImageRequiredNodes(options = {}) {
  return [...new Set(Object.values(qwenImageGraph({ prompt: "readiness check", ...options })).map((node) => node.class_type))];
}
