/**
 * How long does ONE img2img frame cost on this machine?
 *
 * Everything about the feedback renderer — resolution, frame rate, how many
 * seconds of video is affordable — follows from this number, so it is measured
 * before anything is built on top of it rather than estimated afterwards.
 *
 *   node scripts/img2img_probe.mjs [denoise] [width] [height] [steps]
 *
 * Also answers the question the node names do not: `SplitSigmasDenoise` emits
 * `high_sigmas` and `low_sigmas`, and which of the two is "the part you run" for
 * img2img is convention rather than something the schema states. The probe
 * reports how far the output moved from the input at several denoise values, so
 * the answer is read off behaviour instead of guessed.
 */
import { config } from "../server/config.js";

import { postJSON } from "./lib/doorpost.mjs";
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:img2img_probe with its graph stored whole, its resolved
 * prompt, every seed and step count, the size, the model files, the wall time
 * and the digest of everything it wrote — and a FAILED arm is recorded too.
 * On the night this door was built, 424 files in the output folder had none of
 * that. See docs/ENGINE_DOOR.md.
 */
const APP = process.env.AIPLAY_URL || "http://127.0.0.1:4173";
async function door(body) {
  let r;
  try {
    r = await postJSON(`${APP}/api/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:img2img_probe" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 400, ...body }),
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
const [, , dArg, wArg, hArg, sArg] = process.argv;
const DENOISE = Number(dArg) || 0.5;
const W = Number(wArg) || 1024;
const H = Number(hArg) || 576;
const STEPS = Number(sArg) || config.art.steps;

const PROMPT =
  "thick glossy liquid enamel paint, marbled ink swirling, saturated magenta "
  + "cyan and gold, high contrast, fluid art macro photography";

/**
 * The graph. Same loaders and guider as coverGraph, with two changes:
 * the latent comes from a real image instead of an empty one, and the sigma
 * schedule is cut so only its tail runs — which is what "denoise" means when
 * the sampler is SamplerCustomAdvanced, since that node has no denoise input.
 */
function graph({ image, denoise, seed }) {
  const a = config.art;
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: a.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: a.textEncoder, type: "flux2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: a.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: PROMPT } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    6: { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: a.cfg } },
    7: { class_type: "Flux2Scheduler", inputs: { steps: STEPS, width: W, height: H } },
    // low_sigmas is the TAIL of the schedule — the part that runs when you are
    // starting from a picture rather than from noise.
    8: { class_type: "SplitSigmasDenoise", inputs: { sigmas: ["7", 0], denoise } },
    9: { class_type: "KSamplerSelect", inputs: { sampler_name: a.sampler } },
    10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    11: { class_type: "LoadImage", inputs: { image } },
    12: { class_type: "ImageScale", inputs: { image: ["11", 0], upscale_method: "lanczos", width: W, height: H, crop: "disabled" } },
    13: { class_type: "VAEEncode", inputs: { pixels: ["12", 0], vae: ["3", 0] } },
    14: {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["10", 0], guider: ["6", 0], sampler: ["9", 0], sigmas: ["8", 1], latent_image: ["13", 0] },
    },
    15: { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["3", 0] } },
    16: { class_type: "SaveImage", inputs: { images: ["15", 0], filename_prefix: "probe/i2i" } },
  };
}

async function run(image, denoise, seed) {
  const d = await door({ graph: graph({ image, denoise, seed }), label: `i2i denoise ${denoise}` });
  if (d.status !== "completed") throw new Error(`${d.status}: ${String(d.error || "").slice(0, 600)}`);
  return { seconds: d.elapsedSec, file: d.outputs[0] };
}

const SRC = "aiplay_src/src_0001.png";
console.log(`img2img probe — ${W}x${H}, ${STEPS} steps, source ${SRC}\n`);

for (const d of [0.25, 0.5, 0.75]) {
  try {
    const { seconds, file } = await run(SRC, d, 12345);
    console.log(`  denoise ${d.toFixed(2)}  ${seconds.toFixed(1)}s  -> ${file?.subfolder}/${file?.filename}`);
  } catch (err) {
    console.log(`  denoise ${d.toFixed(2)}  FAILED: ${String(err.message).slice(0, 300)}`);
  }
}

// Warm cost is what a long render actually pays; the first frame carries the
// model load.
const warm = await run(SRC, 0.5, 999);
console.log(`\n  warm frame at denoise 0.50: ${warm.seconds.toFixed(1)}s`);
for (const [fps, secs] of [[8, 20], [12, 20], [12, 30], [24, 30]]) {
  const frames = fps * secs;
  console.log(`  ${secs}s at ${fps}fps = ${frames} frames = ${(frames * warm.seconds / 60).toFixed(1)} min`);
}
