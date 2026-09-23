/**
 * First real H3 render on this rig — the int4_convrot set, no custom nodes.
 *
 * Wiring copied from the official template (video_minimax_h3_t2v.json,
 * subgraph "Image to Video (MiniMax H3)"), NOT reconstructed by hand:
 *   MiniMaxH3ImageToVideo -> BasicGuider -> SamplerCustomAdvanced
 *   (KSamplerSelect res_multistep, BasicScheduler simple)
 *   -> VAEDecode + VAEDecodeAudio off the SAME latent -> CreateVideo 24fps
 *
 * ⚠ length must satisfy n mod 17 == 5 (align_frame_count in nodes_minimax_h3.py).
 * 2 s at 24 fps -> 56 frames, and 56 % 17 == 5. Kept SHORT on purpose: this is a
 * does-it-run test, not a quality test.
 */
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:h3_smoke with its graph stored whole, its resolved
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
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:h3_smoke" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: true, pollMs: 2000, ...body }),
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
const steps = Number(process.env.STEPS || 8);
const len = Number(process.env.LEN || 56);
const W = Number(process.env.W || 864), H = Number(process.env.H || 480);

const g = {
  1: { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_pruned_int4_convrot.safetensors", weight_dtype: "default" } },
  2: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3-int4_convrot.safetensors", type: "minimax", device: "default" } },
  3: { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_int8_convrot.safetensors" } },
  4: { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_bf16.safetensors" } },
  5: { class_type: "MiniMaxH3ImageToVideo", inputs: {
        clip: ["2", 0], vae: ["3", 0],
        prompt: "A single brass key resting on dark weathered wood, slow push-in, strong directional light from the left, dust motes drifting, restrained warm palette, shallow depth of field.\n\nAudio: quiet room tone.",
        width: W, height: H, length: len } },
  6: { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["5", 0] } },
  7: { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps, denoise: 1 } },
  8: { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
  9: { class_type: "RandomNoise", inputs: { noise_seed: 424242 } },
  10: { class_type: "SamplerCustomAdvanced", inputs: {
        noise: ["9", 0], guider: ["6", 0], sampler: ["8", 0], sigmas: ["7", 0], latent_image: ["5", 1] } },
  11: { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["3", 0] } },
  12: { class_type: "VAEDecodeAudio", inputs: { samples: ["10", 0], vae: ["4", 0] } },
  13: { class_type: "CreateVideo", inputs: { images: ["11", 0], fps: 24, audio: ["12", 0] } },
  14: { class_type: "SaveVideo", inputs: { video: ["13", 0], filename_prefix: "h3_smoke", format: "auto", codec: "auto" } },
};

console.log(`submitting: ${W}x${H}, ${len} frames (${(len/24).toFixed(1)}s), ${steps} steps`);
const d = await door({ graph: g, label: `h3 smoke ${W}x${H} ${steps} steps` });
console.log(`run ${d.runId}${d.promptId ? ` (prompt ${d.promptId})` : ""}`);
if (d.status !== "completed") {
  console.error(`${d.status.toUpperCase()}: ${String(d.error || "").slice(0, 2500)}`);
  process.exit(1);
}
console.log(`DONE in ${d.elapsedSec.toFixed(1)}s`);
console.log(JSON.stringify(d.outputs).slice(0, 600));
process.exit(0);
