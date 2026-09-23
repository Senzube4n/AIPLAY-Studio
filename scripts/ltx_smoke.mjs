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
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:ltx_smoke with its graph stored whole, its resolved
 * prompt, every seed and step count, the size, the model files, the wall time
 * and the digest of everything it wrote — and a FAILED arm is recorded too.
 * On the night this door was built, 424 files in the output folder had none of
 * that. See docs/ENGINE_DOOR.md.
 */
import { postJSON } from "./lib/doorpost.mjs";

const APP = process.env.AIPLAY_URL || "http://127.0.0.1:4173";
async function door(body) {
  let r;
  try {
    r = await postJSON(`${APP}/api/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:ltx_smoke" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: true, pollMs: 3000, ...body }),
    });
  } catch (e) {
    /* THIS REFUSAL *IS* THE ENFORCEMENT, so it has to be readable. A harness
     * that cannot find the app can no longer find the engine either. */
    throw new Error(`start AIPLAY Studio first — nothing is answering at ${APP} `
      + `(${e.cause?.code || e.message}). Set AIPLAY_URL if the app is on another port.`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `AIPLAY Studio answered ${r.status} at ${APP}.`);
  return d;
}

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
/* A rejection and a failure are one branch now. The door records both — a
 * graph the engine refused leaves a `rejected` result where it used to leave
 * nothing at all — and its message already names the node that objected. */
const d = await door({ graph: g, label: "ltx 2.5 smoke" });
if (d.status !== "completed") {
  console.log(`${d.status.toUpperCase()}:`, String(d.error || "").slice(0, 900));
  process.exit(1);
}
const f = d.outputs[0];
console.log(`done in ${d.elapsedSec.toFixed(0)}s -> ${f?.adoptedAs || f?.file}`);
