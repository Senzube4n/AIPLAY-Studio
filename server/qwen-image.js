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
/* Fast draft replaces KSampler with these; all are stock ComfyUI nodes. */
export const QWEN_DRAFT_NODES = Object.freeze([
  "LoraLoaderModelOnly", "BasicGuider", "KSamplerSelect", "RandomNoise", "ManualSigmas", "SamplerCustomAdvanced",
]);

/**
 * FAST DRAFT: Viggle's 5-step turbo LoRA on the same Qwen Image 2.1 files.
 *
 * Measured here on 2026-09-24 (lab/qwen_turbo, 302 renders, two blind judges):
 * about 3x quicker warm (3.1 s against 11.2 s at 1024²; batch 4 3.8x, 1920x1088
 * 4x, one-reference edit 4x, a new prompt about 1.9x because the text encode is
 * not sped up). The two-reference edit was only 2.3x (9.1 s against 20.8 s) and
 * both judges ranked it below the full render (it took image 2's background).
 * It LOSES on small text (a mirrored R, a reversed E), neon and stencil
 * lettering, and at 1 MP it can fuse fingers or melt a face in a crowd.
 * So it is a DRAFT: storyboards, board thumbnails, ideas. The base stays the
 * default and the only path for lettering, crowds, close hands, two-reference
 * style edits and finals.
 *
 * Wiring (arm C of the A/B, the one approved): the stock LoraLoaderModelOnly
 * at 1.0, SamplerCustomAdvanced fed by BasicGuider (CFG 1, no negative),
 * KSamplerSelect euler, RandomNoise and ManualSigmas. Arm D, the same five
 * sigmas without the LoRA, came last on 16 of 17 prompts: the LoRA does the
 * work, the schedule alone is mush.
 *
 * Switching between a draft and a final costs a model re-patch every time:
 * +8.8 s into a draft, +2.5 s into a final (the two share one VRAM copy under
 * the stock loader). art.js's estimate carries that.
 *
 * SIZE: the largest canvas measured was 1920x1088 (8,160 tokens), and the
 * shift formula below is Viggle's for 256 to 8,192 tokens. Past that it would
 * extrapolate (4096² ends 0.9365 -> 0: one Euler step removing ~94% of the
 * noise), so a larger canvas is refused rather than guessed at.
 */
export const QWEN_DRAFT = Object.freeze({
  capability: "imageQwenFastDraft",
  lora: "Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r128.safetensors",
  bytes: 679_604_800,
  strength: 1, steps: 5, cfg: 1, sampler: "euler", maxRefs: 3,
  /* (W/16) * (H/16) of the sampled latent: 2048x1024 is the largest at 8,192,
   * a reference size of 1440 (8,100) the largest square. */
  maxTokens: 8192,
  /* Viggle's raw student nodes; the resolution shift is applied per canvas. */
  nodes: Object.freeze([1.0, 0.875, 0.75, 0.5, 0.25]),
  label: "Fast draft",
  /* The one set of refusal sentences: the graph builder throws them, the
   * route answers them, make_image passes them on, and web/app.js keeps its
   * own copy of the greyed reasons (server/qwen-draft_test.js diffs the two). */
  refusals: Object.freeze({
    engine: "Fast draft is a speed setting for Qwen Image 2.1 only. Choose Qwen Image 2.1, or turn Fast draft off.",
    transparent: "Fast draft cannot make a transparent picture; that stays on the full Qwen Image 2.1 render. Turn off Transparent, or turn Fast draft off.",
    refs: "Fast draft takes up to 3 reference pictures (Viggle's own examples use 3; Studio measured 1 and 2). Remove some, or turn Fast draft off.",
    cfg: "Fast draft always runs at CFG 1; CFG above 1 needs the full render. Set CFG to 1, or turn Fast draft off.",
    negative: "Fast draft runs at CFG 1, where a negative prompt is never read, so it is refused rather than ignored. Clear it, or turn Fast draft off.",
    steps: "Fast draft always samples 5 steps on its own schedule. Leave steps out, or turn Fast draft off to choose them.",
    refSize: "Fast draft sizes its schedule from the canvas, and a reference kept at its own size gives it none. Set the reference size (1024 is what was tested), or turn Fast draft off.",
    size: "Fast draft was measured up to about 2 megapixels (1920x1088, or a reference size of 1440); larger canvases stay on the full render. Choose a smaller size, or turn Fast draft off.",
    masked: "Fast draft is not offered in the editor: masked, edit and style edits keep the full Qwen Image 2.1 render.",
    type: "draft must be true or false.",
  }),
});

/** Latent tokens of a canvas, (W/16) * (H/16): what sets the draft's shift. */
export function qwenDraftTokens(width, height) {
  return Math.round(height / 16) * Math.round(width / 16);
}

/* The canvas a draft would sample, sized the way qwenImageGraph sizes it (a
 * side clamped to 256-4096 and rounded up to 32; a reference-sized edit at
 * refResolution², null meaning the base's 1024), or null when a value is not
 * a number (the builder then refuses it in its own words). */
function draftCanvas({ width, height, refImages, refSizing, refResolution }) {
  const side = (value, min) => {
    const n = value == null ? QWEN_IMAGE_PRESET.size : value;
    return typeof n === "number" && Number.isFinite(n) ? Math.ceil(Math.min(4096, Math.max(min, Math.round(n))) / 32) * 32 : null;
  };
  if (Array.isArray(refImages) && refImages.length && refSizing !== "custom") {
    const r = side(refResolution, 0);
    return r == null ? null : [r, r];
  }
  const w = side(width, 256), h = side(height, 256);
  return w && h ? [w, h] : null;
}

/** The first base-only reason a Fast draft request carries, or null. */
export function qwenDraftRefusal({ transparent = false, refImages = [], cfg, negative = "", steps,
  refSizing = "reference", refResolution = 1024, width, height } = {}) {
  const R = QWEN_DRAFT.refusals;
  if (transparent === true) return R.transparent;
  if (Array.isArray(refImages) && refImages.length > QWEN_DRAFT.maxRefs) return R.refs;
  if (cfg != null && Number(cfg) > QWEN_DRAFT.cfg) return R.cfg;
  if (typeof negative === "string" && negative.trim()) return R.negative;
  if (steps != null && Number(steps) !== QWEN_DRAFT.steps) return R.steps;
  /* An explicit 0 keeps a reference at its own size; null follows the base's
   * own 1024 default, as bounded() treats it. */
  if (Array.isArray(refImages) && refImages.length && refSizing !== "custom"
    && refResolution != null && Number(refResolution) === 0) return R.refSize;
  const canvas = draftCanvas({ width, height, refImages, refSizing, refResolution });
  if (canvas && qwenDraftTokens(...canvas) > QWEN_DRAFT.maxTokens) return R.size;
  return null;
}

/**
 * THE ONE SIGMA HELPER. Viggle's ViggleTurboSigmas, in JS: the raw nodes
 * through the diffusers pipeline's dynamic exponential shift,
 * mu = 0.5 + 0.4 * (tokens - 256) / (8192 - 256), tokens = (H/16) * (W/16) of
 * the latent that is sampled, shift_terminal off, then a final 0. Rounded to
 * four places, which reproduces the three tables the A/B ran exactly:
 *   1024²     1.0, 0.9334, 0.8572, 0.6668, 0.4001, 0
 *   1344x768  1.0, 0.9332, 0.8568, 0.6660, 0.3993, 0
 *   1920x1088 1.0, 0.9450, 0.8805, 0.7106, 0.4501, 0
 * Sizes are on the 16/32 grid already (dimension() rounds to 32). Above 8,192
 * tokens it refuses rather than extrapolate (SIZE, above).
 */
export function qwenDraftSigmas(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError("Fast draft needs a finite canvas size to set its schedule.");
  }
  const tokens = qwenDraftTokens(width, height);
  if (tokens > QWEN_DRAFT.maxTokens) throw new RangeError(QWEN_DRAFT.refusals.size);
  const mu = 0.5 + (0.9 - 0.5) * (tokens - 256) / (8192 - 256);
  const shifted = QWEN_DRAFT.nodes.map((t) => Math.exp(mu) / (Math.exp(mu) + (1 / t - 1)));
  return [...shifted.map((s) => Number(s.toFixed(4))), 0];
}

/** ManualSigmas' text: "1.0, 0.9334, 0.8572, 0.6668, 0.4001, 0". */
export function qwenDraftSigmaText(sigmas) {
  return sigmas.map((s) => (s === 0 ? "0" : s === 1 ? "1.0" : s.toFixed(4))).join(", ");
}

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
  draft = false, draftLora = null,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("Qwen Image needs a prompt.");
  if (typeof negative !== "string") throw new TypeError("The negative prompt must be text.");
  if (typeof draft !== "boolean") throw new TypeError(QWEN_DRAFT.refusals.type);
  if (!Array.isArray(refImages) || refImages.length > QWEN_IMAGE_PRESET.maxRefs) {
    throw new RangeError("Qwen Image accepts up to 10 reference images.");
  }
  /* Before the base's own cfg/negative rule, so a draft hears the draft's
   * reason ("turn Fast draft off") rather than "raise CFG". */
  if (draft) {
    const refused = qwenDraftRefusal({ transparent, refImages, cfg, negative, steps, refSizing, refResolution, width, height });
    if (refused) throw new RangeError(refused);
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
  if (draft) {
    /* The same loaders, encoder, latent and decode as the base: only the
     * sampler changes (node 8 stays node 8, so the readers of the output are
     * untouched), and the model goes through the LoRA first. No
     * ModelSamplingAuraFlow: the base graph has none, and ManualSigmas carries
     * the already-shifted values, which ComfyUI uses as given. References take
     * the base's own edit path above. The canvas that sets the schedule is the
     * latent sampled: the requested size, or for a reference-sized edit
     * refResolution², standing in for the first reference resized to about
     * that area (aspect kept). That is an approximation: the A/B sized its
     * one-reference edits from the real 1344x768 reference latent, and this
     * schedule differs from those by at most 8e-4 (1.0, 0.9334, 0.8572,
     * 0.6668, 0.4001, 0 against 1.0, 0.9332, 0.8568, 0.6660, 0.3993, 0).
     * Text-to-image and the two-reference edit match the lab graphs exactly. */
    const sized = refs.length && refSizing === "reference";
    const sigmas = qwenDraftSigmas(sized ? refSize : w, sized ? refSize : h);
    const loraFile = filename(draftLora, QWEN_DRAFT.lora, "Fast draft LoRA");
    /* A name on the loras shelf (readiness passes a stand-in chosen in
     * Models), never a path: lora_name is a filename inside models/loras. */
    if (/[\\/]/.test(loraFile)) throw new TypeError("The Fast draft LoRA must be a filename from models/loras, not a path.");
    graph[5] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: loraFile, strength_model: QWEN_DRAFT.strength } };
    graph[80] = { class_type: "BasicGuider", inputs: { model: ["5", 0], conditioning: ["4", 0] } };
    graph[81] = { class_type: "KSamplerSelect", inputs: { sampler_name: QWEN_DRAFT.sampler } };
    graph[82] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
    graph[83] = { class_type: "ManualSigmas", inputs: { sigmas: qwenDraftSigmaText(sigmas) } };
    graph[8] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["82", 0], guider: ["80", 0], sampler: ["81", 0], sigmas: ["83", 0], latent_image: latent },
    };
  } else {
    graph[8] = {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["4", 0], negative: ["4", 1], latent_image: latent,
        seed, steps: bounded(steps, QWEN_IMAGE_PRESET.steps, 1, QWEN_IMAGE_PRESET.maxSteps, "steps"),
        cfg: guidance, sampler_name: sampler, scheduler, denoise: 1,
      },
    };
  }
  graph[17] = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } };
  graph[13] = { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: outputPrefix } };
  graph[14] = { class_type: "ImageScale", inputs: { image: ["17", 0], upscale_method: "lanczos", width: thumb, height: thumb, crop: "center" } };
  graph[15] = { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${outputPrefix}_thumb` } };
  return graph;
}

/** What a built graph samples with, read back from the graph itself: the
 * route and the queue record these, and a draft has no KSampler to read. */
export function qwenImageSettings(graph) {
  const node = graph?.[8];
  if (node?.class_type === "SamplerCustomAdvanced") {
    const sigmas = String(graph[83]?.inputs?.sigmas || "");
    return { draft: true, steps: sigmas.split(",").length - 1, cfg: QWEN_DRAFT.cfg,
      sampler: graph[81]?.inputs?.sampler_name, sigmas,
      lora: graph[5]?.inputs?.lora_name || null, loraStrength: graph[5]?.inputs?.strength_model ?? null };
  }
  return { draft: false, steps: node?.inputs?.steps, cfg: node?.inputs?.cfg,
    sampler: node?.inputs?.sampler_name, scheduler: node?.inputs?.scheduler };
}

/** Exact node set for readiness checks. */
export function qwenImageRequiredNodes(options = {}) {
  return [...new Set(Object.values(qwenImageGraph({ prompt: "readiness check", ...options })).map((node) => node.class_type))];
}
