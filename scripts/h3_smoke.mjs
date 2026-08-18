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
const BASE = "http://127.0.0.1:8266";
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
const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g }) });
if (!r.ok) { console.error("REJECTED:", (await r.text()).slice(0, 2000)); process.exit(1); }
const { prompt_id } = await r.json();
console.log("accepted", prompt_id);
for (let i = 0; i < 600; i++) {
  await new Promise((s) => setTimeout(s, 2000));
  const e = (await (await fetch(`${BASE}/history/${prompt_id}`)).json())[prompt_id];
  if (!e) { if (i % 15 === 0) console.log(`  ${((Date.now()-t0)/1000).toFixed(0)}s…`); continue; }
  if (e.status?.status_str === "error") {
    console.error("ERROR:", JSON.stringify(e.status.messages).slice(0, 2500)); process.exit(1);
  }
  if (e.status?.completed) {
    console.log(`DONE in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    console.log(JSON.stringify(e.outputs).slice(0, 600));
    process.exit(0);
  }
}
console.error("timed out"); process.exit(1);
