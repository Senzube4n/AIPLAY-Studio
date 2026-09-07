/**
 * Fixture graphs for the record suite.
 *
 * NOT INVENTED. Every one of these is the shape a real caller in this
 * repository builds, with the real model filenames this rig holds — because a
 * record builder tested against a graph nobody renders proves nothing about the
 * graphs that actually cost money here. Each says where it came from.
 *
 * They are the three shapes §8-D names, plus two graphs whose only purpose is
 * to be ambiguous: the record's honesty rules are the part most likely to rot,
 * and a rule that is never handed something it must refuse is not a rule.
 */

/**
 * LTX 2.5, one guided clip with sound — server/workflow.js `restyleGraph`,
 * with one guide instead of eight so the fixture stays readable.
 *
 * ⚠ THE POINT OF THIS FIXTURE: there is no `KSampler` anywhere in it. The seed
 * is on `RandomNoise`, the sampler name on `KSamplerSelect`, the two cfgs on
 * `LTXVDualCFGGuider`, and the prompt is four link-hops upstream of the guider
 * through an `LTXVAddGuide` that takes BOTH conditionings. This is the most
 * expensive render the app performs (a guided 1344x768 H3 clip measured 2259 s;
 * an LTX 5 s clip about 121 s), and it is the one a naive rule records blank.
 *
 * The LoRA on node 5 is deliberately a file belonging to a DIFFERENT catalogue
 * entry (H3's turbo adapter). It is here so the fixture pins that a LoRA never
 * gets to name the model: `model` must resolve to `ltx` from the diffusion
 * weights on node 1 and be untroubled by an h3-shaped filename sitting beside
 * it, because what hangs off that answer is which licence gets stamped.
 */
export const LTX_VIDEO_GRAPH = {
  1: { class_type: "UNETLoader", inputs: { unet_name: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", weight_dtype: "default" } },
  2: { class_type: "CLIPLoader", inputs: { clip_name: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", type: "ltxv", device: "default" } },
  3: { class_type: "VAELoader", inputs: { vae_name: "ltx-2.5-video-vae-conv-bf16.safetensors" } },
  4: { class_type: "VAELoader", inputs: { vae_name: "ltx-2.5-audio-vae-bf16.safetensors" } },
  5: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", strength_model: 1 } },
  6: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "A long concrete corridor lit by cold overhead strip lights, a lone figure in a dark coat walking away from camera." } },
  7: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "blurry, watermark, text, low quality" } },
  8: { class_type: "LTXVConditioning", inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: 24 } },
  9: { class_type: "EmptyLTXVLatentVideo", inputs: { width: 1280, height: 704, length: 121, batch_size: 1 } },
  10: { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: 121, frame_rate: 24, batch_size: 1, audio_vae: ["4", 0] } },
  100: { class_type: "LoadImage", inputs: { image: "aiplay_ref_9f21.png" } },
  101: { class_type: "LTXVPreprocess", inputs: { image: ["100", 0], img_compression: 18 } },
  102: {
    class_type: "LTXVAddGuide",
    inputs: { positive: ["8", 0], negative: ["8", 1], vae: ["3", 0], latent: ["9", 0], image: ["101", 0], frame_idx: 0, strength: 0.3 },
  },
  11: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["102", 2], audio_latent: ["10", 0] } },
  12: { class_type: "RandomNoise", inputs: { noise_seed: 31337 } },
  13: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler_ancestral" } },
  14: { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.9, 0.75, 0.5, 0.2, 0.0" } },
  15: { class_type: "LTXVDualCFGGuider", inputs: { model: ["5", 0], positive: ["102", 0], negative: ["102", 1], video_cfg: 1, audio_cfg: 1 } },
  16: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["15", 0], sampler: ["13", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
  17: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["16", 1] } },
  18: { class_type: "LTXVCropGuides", inputs: { positive: ["102", 0], negative: ["102", 1], latent: ["17", 0] } },
  19: { class_type: "VAEDecodeTiled", inputs: { samples: ["18", 2], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
  20: { class_type: "CreateVideo", inputs: { images: ["19", 0], fps: 24 } },
  21: { class_type: "SaveVideo", inputs: { video: ["20", 0], filename_prefix: "gate/arm3", format: "auto", codec: "auto" } },
};

/**
 * FLUX.2 klein, one cover plus its thumbnail — server/workflow.js `coverGraph`.
 *
 * ⚠ THE POINT OF THIS FIXTURE: its negative conditioning is a
 * `ConditioningZeroOut` of the POSITIVE. Follow the links naively and the
 * record reports the cover's own prompt as its negative prompt. The honest
 * answer is "" — this graph HAS no negative prompt — and the difference
 * between "" and null is the difference between a fact and a gap.
 *
 * It also puts `steps` on a `Flux2Scheduler`, which is not a sampler by name.
 */
export const FLUX_IMAGE_GRAPH = {
  1: { class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-4b-fp8.safetensors", weight_dtype: "default" } },
  2: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "flux2", device: "default" } },
  3: { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
  4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "album cover, brutalist concrete, cold cyan rimlight, 35mm grain" } },
  5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
  6: { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: 1 } },
  7: { class_type: "Flux2Scheduler", inputs: { steps: 4, width: 1024, height: 1024 } },
  8: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  9: { class_type: "RandomNoise", inputs: { noise_seed: 884422 } },
  10: { class_type: "EmptyFlux2LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  11: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["6", 0], sampler: ["8", 0], sigmas: ["7", 0], latent_image: ["10", 0] } },
  12: { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
  13: { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "covers/aiplay_cover" } },
  14: { class_type: "ImageScale", inputs: { image: ["12", 0], upscale_method: "lanczos", width: 256, height: 256, crop: "center" } },
  15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: "covers/aiplay_cover_thumb" } },
};

/**
 * The local judge — server/mv/sfxcue.js `askQwen`, verbatim in shape.
 *
 * ⚠ THE POINT OF THIS FIXTURE: it writes NO FILE. No SaveImage, no SaveVideo,
 * no filename_prefix, no latent, no sampler, no seed. Before the door existed
 * this call left no trace whatsoever, several hundred times per audiobook.
 * Its record is its status and its elapsed time — and its prompt, which is the
 * only thing in it there is to record, and which no sampler walk can reach
 * because there is no sampler.
 */
export const TEXT_JUDGE_GRAPH = {
  1: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "flux2" } },
  2: { class_type: "TextGenerate", inputs: { clip: ["1", 0], prompt: "You judge sound-effect cues for an audiobook. Reply ONLY flat JSON.", max_length: 80, sampling_mode: "off" } },
  3: { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
};

/** Two samplers, two seeds. Nothing may be hoisted out of this one — and both
 *  seeds must survive, because "which seed made this" has two answers here and
 *  a record that picked one would be picking at random. */
export const TWO_SAMPLER_GRAPH = {
  1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "somebodys_own_sdxl.safetensors" } },
  2: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "a lighthouse" } },
  3: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "blurry" } },
  4: { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } },
  5: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: 111, steps: 20, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1 } },
  6: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["5", 0], seed: 222, steps: 12, cfg: 5, sampler_name: "euler", scheduler: "simple", denoise: 0.45 } },
  7: { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
  8: { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "probe/two" } },
};

/** A sampler whose conditioning arrives through a node that mixes two threads,
 *  so neither prompt can be claimed. Every text is still recorded. */
export const UNWALKABLE_GRAPH = {
  1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "somebodys_own_sdxl.safetensors" } },
  2: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "a lighthouse" } },
  3: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "a harbour at dusk" } },
  4: { class_type: "ConditioningCombine", inputs: { conditioning_1: ["2", 0], conditioning_2: ["3", 0] } },
  5: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  6: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["4", 0], latent_image: ["5", 0], seed: 9, steps: 8, cfg: 6, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
  7: { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
  8: { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "probe/unwalkable" } },
};

/** ComfyUI's EDITOR save, not the API format. The two files look equally like
 *  JSON and fail very differently; this is what the door must recognise and
 *  name before it spends anything. */
export const UI_FORMAT_GRAPH = {
  last_node_id: 21,
  last_link_id: 33,
  nodes: [{ id: 1, type: "UNETLoader", widgets_values: ["flux-2-klein-4b-fp8.safetensors", "default"] }],
  links: [],
  version: 0.4,
};
