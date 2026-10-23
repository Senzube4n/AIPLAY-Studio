/** Explicit experimental recipes. No mutable defaults, custom graph or adapter stacks. */
import { createHash } from "node:crypto";
const freeze = value => { if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; };
export const MOSS_SPECTRUM = freeze({
  "repository": "https://github.com/Rkkss/ComfyUI-Spectrum-MOSS",
  "commit": "d3f7e243ea2db6cc3ff26f42b935b167f938b599",
  "version": "0.8.1",
  "license": "GPL-3.0-only",
  "files": [
    {
      "file": "__init__.py",
      "bytes": 155,
      "sha256": "d8d2d6755ff44a48f987e2f109ca61ff561e2b32c726fd34e3a1bed052824e82"
    },
    {
      "file": "CHANGELOG.md",
      "bytes": 382,
      "sha256": "9d2ce4bb7712d601e1b52fc1ec37e404aa91c668a5391fa68fa419e44ba382c4"
    },
    {
      "file": "er_sde_bridge.py",
      "bytes": 20635,
      "sha256": "a643934373bbb85846b7bacb130c607571b019d511368b8fc545448146b4007f"
    },
    {
      "file": "LICENSE",
      "bytes": 35149,
      "sha256": "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"
    },
    {
      "file": "node_list.json",
      "bytes": 258,
      "sha256": "e74b87a8b7efce12e58fd81fe2c96dedfcf250a427d6e374658b53cfcb3cb061"
    },
    {
      "file": "nodes.py",
      "bytes": 64445,
      "sha256": "d546280fa333e32fe75c8b46f9da1d8c1142cafbcd334f007bd4b189710e2f45"
    },
    {
      "file": "pyproject.toml",
      "bytes": 534,
      "sha256": "93d1b254e9914e53d51b61fe9826d5904cec5f00ad04b11068bf8deff52b9c86"
    },
    {
      "file": "README.md",
      "bytes": 2354,
      "sha256": "82912449f196c8cb4cc4282c4d1aa7f264c6312a6ce7118d8989e8a82db29a35"
    }
  ],
  "folder": "ComfyUI-Spectrum-MOSS",
  "marker": ".aiplay-source-pin.json"
});
export const MOSS_ADAPTERS = freeze([
  {
    "repo": "akhaliq/MOSS-Image-SFT-4-steps",
    "revision": "2ded95c37a029360245926fe72e475e30039bbfb",
    "bytes": 1189176752,
    "sha256": "154c7f1455c3bf9925945c2f1ea2e4f09d0d0c67256081384a094b2b585f913f",
    "url": "https://huggingface.co/akhaliq/MOSS-Image-SFT-4-steps/resolve/2ded95c37a029360245926fe72e475e30039bbfb/moss_image_sft_4step_v2.0.safetensors",
    "steps": 4,
    "strength": 1,
    "cfg": 1,
    "sampler": "euler",
    "scheduler": "simple",
    "upstreamFilename": "moss_image_sft_4step_v2.0.safetensors",
    "filename": "moss_image_sft_4step_v2.0.safetensors"
  },
  {
    "repo": "lodestones/MOSS-Image-SFT-8-steps-dmd",
    "revision": "f95df83b5e90ae91ea412434b3f9b7f1c8c6314f",
    "bytes": 1189176800,
    "sha256": "4abb14e39c1a59018907581e609f43616ec6810126144ec2b1d2e6f8969628fe",
    "url": "https://huggingface.co/lodestones/MOSS-Image-SFT-8-steps-dmd/resolve/f95df83b5e90ae91ea412434b3f9b7f1c8c6314f/lora.safetensors",
    "steps": 8,
    "strength": 1,
    "cfg": 1,
    "sampler": "euler",
    "scheduler": "simple",
    "upstreamFilename": "lora.safetensors",
    "filename": "moss_image_sft_8step_dmd_strength1.safetensors"
  }
]);
export const MOSS_KROMOSS_MODEL = freeze({
  repo: "lodestones/Kromoss", revision: "7f9bb7b06d7b6c27d294b0bab5a2b3056c379279",
  filename: "kromoss_int8_convrot.safetensors", bytes: 5413698958,
  sha256: "cacff0dd25cd2cf531e1f5ddae7872c3d57a54dbf66f1a1279f2f118514e7905",
  url: "https://huggingface.co/lodestones/Kromoss/resolve/7f9bb7b06d7b6c27d294b0bab5a2b3056c379279/diffusion_models/kromoss_int8_convrot.safetensors",
  catalogueId: "moss-image-kromoss",
});
export const MOSS_DMD2_ADAPTER = freeze({
  repo: "lodestones/Kromoss", revision: "7f9bb7b06d7b6c27d294b0bab5a2b3056c379279",
  filename: "kromoss_dmd2_8step.safetensors", upstreamFilename: "8-steps-dmd2-lora.safetensors",
  bytes: 1189176800, sha256: "7683fe1fb51f73f5d690f24dd6b7f46f31ab9a9873729a854ac5c9a420ffe6f2",
  url: "https://huggingface.co/lodestones/Kromoss/resolve/7f9bb7b06d7b6c27d294b0bab5a2b3056c379279/8-steps-dmd2-lora.safetensors",
  strength: 1, catalogueId: "moss-image-kromoss-dmd2-8",
});
export const MOSS_HIRES_ADAPTER = freeze({
  repo: "comfyanonymous/MOSS_image_MAX_ULTRA_hires_lora_test", revision: "9af7b1f3d135ce132cc6c4b8147030efff19507f",
  filename: "moss_hires_lora_test_v0.3.safetensors", bytes: 182195248,
  sha256: "98e8abcc25016d17a4ca41dec4063abe2ff2b0a12da42e0483c522ce36f8430b",
  url: "https://huggingface.co/comfyanonymous/MOSS_image_MAX_ULTRA_hires_lora_test/resolve/9af7b1f3d135ce132cc6c4b8147030efff19507f/moss_hires_lora_test_v0.3.safetensors",
  strength: 1, catalogueId: "moss-image-hires-v03",
});
/** The native ComfyUI conversion, not the PEFT file or merged model. */
export const MOSS_UNCENSORED_ADAPTER = freeze({
  repo: "axiomofmind/Moss-image-nsfw-uncensored-lora", revision: "7f8c6953c6a88af8cbc8daeb34633c237dd1a7bb",
  filename: "MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI.safetensors", bytes: 74379584,
  sha256: "f766c5774a3fb68caa490bbc3f8153e8b5ccacafc36a1ee7f9ad6ec230ff11a3",
  url: "https://huggingface.co/axiomofmind/Moss-image-nsfw-uncensored-lora/resolve/7f8c6953c6a88af8cbc8daeb34633c237dd1a7bb/MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI.safetensors",
  strength: 0.7, clipStrength: 0, trigger: "moss_xvstyle", catalogueId: "moss-image-nsfw-uncensored",
});
export const MOSS_PRESETS = freeze({
  standard: { steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple" },
  "spectrum-manual-h1": { steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple", node: "SpectrumMOSSImageManual", policy: {
  "warmup_steps": 8,
  "tail_actual_steps": 1,
  "window_size": 2.0,
  "flex_window": 0.75,
  "max_consecutive_forecasts": 1,
  "history_points": 8,
  "chebyshev_degree": 4,
  "ridge_lambda": 0.1,
  "blend_weight": 0.5,
  "cache_device": "main_device",
  "force_actual_on_control": true,
  "debug": true,
  "warn_unverified_sampler": true
} },
  "spectrum-adaptive-h2": { steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple", node: "SpectrumMOSSImageAdaptive", policy: {
  "warmup_steps": 8,
  "detail_guard_steps": 8,
  "tail_actual_steps": 1,
  "post_guard_horizon_cap": 6,
  "window_size": 2.0,
  "flex_window": 0.5,
  "cache_device": "main_device",
  "error_tolerance": 1.0,
  "debug": true,
  "warn_unverified_sampler": true
}, erSdeInternal: {
  "window_size": 2.0,
  "flex_window": 0.0,
  "post_guard_horizon_cap": 2,
  "history_points": 8,
  "chebyshev_degree": 4,
  "ridge_lambda": 0.1,
  "blend_weight": 0.5,
  "er_sde_sync": true,
  "er_sde_h2": true
} },
  "turbo-4": { steps: 4, cfg: 1, sampler: "euler", scheduler: "simple", node: "LoraLoaderModelOnly", adapter: MOSS_ADAPTERS[0] },
  "dmd-8": { steps: 8, cfg: 1, sampler: "euler", scheduler: "simple", node: "LoraLoaderModelOnly", adapter: MOSS_ADAPTERS[1] },
  "kromoss-standard": { steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple", base: MOSS_KROMOSS_MODEL },
  "kromoss-dmd2-8": { steps: 8, cfg: 1, sampler: "euler", scheduler: "simple", base: MOSS_KROMOSS_MODEL,
    node: "LoraLoaderModelOnly", adapter: MOSS_DMD2_ADAPTER },
  "moss-hires-v03": { steps: 25, cfg: 4, sampler: "er_sde", scheduler: "simple", node: "LoraLoaderModelOnly",
    adapter: MOSS_HIRES_ADAPTER, size: 2048, exactSize: 2048, maxPixels: 2048 * 2048, maxSide: 2048, maxCount: 1, vaeDecode: "native" },
  "nsfw-uncensored": { steps: 30, cfg: 3, sampler: "er_sde", scheduler: "simple", node: "LoraLoaderModelOnly",
    adapter: MOSS_UNCENSORED_ADAPTER },
});
export const MOSS_PRESET_NAMES = Object.freeze(Object.keys(MOSS_PRESETS));
export function mossPreset(name = "standard") {
  if (typeof name !== "string" || !Object.hasOwn(MOSS_PRESETS, name)) throw new TypeError("mossPreset must be " + MOSS_PRESET_NAMES.join(" | ") + ".");
  return MOSS_PRESETS[name];
}
/** Includes the pinned implementation and adapter, not just a display label. */
export function mossRecipeIdentity(name = "standard") {
  const recipe = mossPreset(name);
  return createHash("sha256").update(JSON.stringify({ name, recipe, base: recipe.base?.filename || "moss_image_sft_int8_convrot.safetensors", shift: 5,
    ...(recipe.policy ? { spectrum: MOSS_SPECTRUM } : {}), precision: recipe.adapter ? "experimental-int8-native-lora-requantization" : "native-int8" })).digest("hex");
}
