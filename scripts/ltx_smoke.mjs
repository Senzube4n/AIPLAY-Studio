/**
 * Does LTX 2.5 actually run here, and how fast against H3?
 *
 * The graph is the vendor template's own pipeline, resolved to API format:
 *   pass 1  — sample 8 steps at HALF resolution (cheap)
 *   upscale — LTXVLatentUpsampler x2, in latent space
 *   pass 2  — re-sample only 3 steps at full resolution, starting at sigma 0.85
 * That two-pass split is the entire speed story; there is no faster model, only
 * a schedule that spends almost nothing at full size.
 *
 * ⚠ The editor template runs its prompt through a Gemma-4 rewriter
 * (TextGenerateLTX2Prompt) which is ON by default. This graph omits it, so
 * output is NOT directly comparable to running the template in the ComfyUI
 * editor unless you switch prompt_enhance off there too.
 */
const BASE = "http://127.0.0.1:8266";

// Final size is the low-res pass doubled. 640x352 -> 1280x704.
const LOW_W = 640, LOW_H = 352;
const FPS = 24, SECONDS = 5;
const FRAMES = FPS * SECONDS + 1;          // LTX rule, NOT H3's n mod 17 == 5

const PROMPT = process.argv[2]
  || "a woman in a dark room turning slowly to look at the camera, warm lamplight, shallow depth of field";

const g = {
  1: { class_type: "UNETLoader", inputs: { unet_name: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", weight_dtype: "default" } },
  2: { class_type: "CLIPLoader", inputs: { clip_name: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", type: "ltxv", device: "default" } },
  // ⚠ "-conv-" in the name. The template's widget says ltx-2.5-video-vae-bf16 and
  // that file does not exist in the ComfyUI build of the repo.
  3: { class_type: "VAELoader", inputs: { vae_name: "ltx-2.5-video-vae-conv-bf16.safetensors" } },
  4: { class_type: "VAELoader", inputs: { vae_name: "ltx-2.5-audio-vae-bf16.safetensors" } },
  5: { class_type: "LatentUpscaleModelLoader", inputs: { model_name: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" } },

  6: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: PROMPT } },
  7: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "pc game, console game, video game, cartoon, childish, ugly" } },
  8: { class_type: "LTXVConditioning", inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: FPS } },

  9:  { class_type: "EmptyLTXVLatentVideo", inputs: { width: LOW_W, height: LOW_H, length: FRAMES, batch_size: 1 } },
  10: { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: FRAMES, frame_rate: FPS, batch_size: 1, audio_vae: ["4", 0] } },
  11: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["9", 0], audio_latent: ["10", 0] } },

  12: { class_type: "RandomNoise", inputs: { noise_seed: 4242 } },
  13: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler_ancestral" } },
  14: { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0" } },
  // ⚠ video_cfg MUST equal audio_cfg. When they differ, nodes_lt.py takes a
  // dual-guidance path that doubles the forward passes on every step.
  15: { class_type: "LTXVDualCFGGuider", inputs: { model: ["1", 0], positive: ["8", 0], negative: ["8", 1], video_cfg: 1.0, audio_cfg: 1.0 } },
  16: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["15", 0], sampler: ["13", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },

  17: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["16", 0] } },
  18: { class_type: "LTXVLatentUpsampler", inputs: { samples: ["17", 0], upscale_model: ["5", 0], vae: ["3", 0] } },
  19: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["18", 0], audio_latent: ["17", 1] } },

  20: { class_type: "RandomNoise", inputs: { noise_seed: 42 } },
  21: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler_ancestral" } },
  // Starts at 0.85, not 1.0 — a partial re-denoise. Only 3 steps at full size.
  22: { class_type: "ManualSigmas", inputs: { sigmas: "0.85, 0.7250, 0.4219, 0.0" } },
  23: { class_type: "LTXVDualCFGGuider", inputs: { model: ["1", 0], positive: ["8", 0], negative: ["8", 1], video_cfg: 1.0, audio_cfg: 1.0 } },
  24: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["20", 0], guider: ["23", 0], sampler: ["21", 0], sigmas: ["22", 0], latent_image: ["19", 0] } },

  25: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["24", 0] } },
  26: { class_type: "VAEDecodeTiled", inputs: { samples: ["25", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
  27: { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["25", 1], audio_vae: ["4", 0] } },
  28: { class_type: "CreateVideo", inputs: { images: ["26", 0], audio: ["27", 0], fps: FPS } },
  29: { class_type: "SaveVideo", inputs: { video: ["28", 0], filename_prefix: "clips/ltx", format: "auto", codec: "auto" } },
};

console.log(`LTX 2.5 · ${LOW_W}x${LOW_H} -> ${LOW_W * 2}x${LOW_H * 2} · ${FRAMES} frames @ ${FPS}fps · 8+3 steps`);
const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g }) });
if (!r.ok) {
  const e = JSON.parse(await r.text());
  console.log("REJECTED:", e.error?.message || "");
  for (const [n, ne] of Object.entries(e.node_errors || {})) {
    console.log(`  node ${n} (${g[n]?.class_type}):`, ne.errors?.map((x) => `${x.message} ${x.details || ""}`).join("; "));
  }
  process.exit(1);
}
const { prompt_id } = await r.json();
for (;;) {
  await new Promise((s) => setTimeout(s, 3000));
  const e = (await (await fetch(`${BASE}/history/${prompt_id}`)).json())[prompt_id];
  if (e?.status?.status_str === "error") {
    console.log("ERROR:", JSON.stringify(e.status.messages).slice(0, 700)); break;
  }
  if (e?.status?.completed) {
    const f = Object.values(e.outputs || {}).flatMap((o) => o.images || o.videos || [])[0];
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${f?.filename}`);
    break;
  }
}
