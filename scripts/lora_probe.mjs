/**
 * Can ComfyUI's LoRA trainer touch MiniMax Music 3 at all?
 *
 * This answers ONE question and deliberately no others: do the shapes line up.
 * TrainLoraNode is written for image diffusion — 4-D latents, image
 * conditioning. Music 3's flow latent is (1, 128, T) and its conditioning comes
 * out of an autoregressive stage. Either of those could make this a non-starter,
 * and finding out costs one step at rank 4, not an afternoon.
 *
 * Fail fast, and fail with the actual error rather than a guess about it.
 *
 *   node scripts/lora_probe.mjs
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
 * the ledger as script:lora_probe with its graph stored whole, its resolved
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
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:lora_probe" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 4000, ...body }),
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
const LATENT = process.argv[2] || "aiplay_00043.latent";

/* fp16, not the int8 that ships. Backpropagating through a quantised,
 * convolution-rotated checkpoint is a second unknown stacked on the first, and
 * the point here is to isolate one. */
const DIT = "minimax_music3_dit_fp16.safetensors";

const graph = {
  1: { class_type: "UNETLoader", inputs: { unet_name: DIT, weight_dtype: "default" } },
  2: { class_type: "CLIPLoader", inputs: { clip_name: config.models.textEncoder, type: "minimax", device: "default" } },
  3: {
    class_type: "MiniMaxMusic3TextEncode",
    inputs: {
      clip: ["2", 0],
      caption: "warm lo-fi, brushed drums, close-mic vocal",
      lyrics: "[verse]\na short line to condition on",
      seed: 1234,
      // Short: the AR stage is the slow half and this probe does not care what
      // it composes, only that it produces a CONDITIONING the trainer accepts.
      max_duration: 20,
      cfg_scale: 1.0,
      top_k: 50,
      resume_from: "",
    },
  },
  4: { class_type: "LoadLatent", inputs: { latent: LATENT } },
  5: {
    class_type: "TrainLoraNode",
    inputs: {
      model: ["1", 0],
      latents: ["4", 0],
      positive: ["3", 0],
      batch_size: 1,
      grad_accumulation_steps: 1,
      steps: Number(process.env.PROBE_STEPS || 1),
      learning_rate: 0.0001,
      rank: Number(process.env.PROBE_RANK || 4),
      optimizer: "AdamW",
      loss_function: "MSE",
      seed: 0,
      training_dtype: "bf16",
      lora_dtype: "bf16",
      quantized_backward: false,
      algorithm: "LoRA",
      gradient_checkpointing: true,
      checkpoint_depth: Number(process.env.PROBE_CKPT || 1),
      offloading: process.env.PROBE_OFFLOAD === '1',
      existing_lora: "[None]",
      bucket_mode: false,
      bypass_mode: false,
    },
  },
  /* A terminal node, or ComfyUI refuses the graph outright with
   * "Prompt has no outputs" — TrainLoraNode returns a LORA_MODEL and nothing
   * consumes it otherwise. SaveLoRA takes that type directly; LoraSave is the
   * other one and wants a MODEL diff instead. */
  6: {
    class_type: "SaveLoRA",
    inputs: { lora: ["5", 0], prefix: "probe_music3", steps: Number(process.env.PROBE_STEPS || 1) },
  },
};

console.log(`probe: ${DIT} + ${LATENT}, ${process.env.PROBE_STEPS || 1} steps, rank ${process.env.PROBE_RANK || 4}`);
/* The 20-minute give-up is now the door's own bounded deadline, which also
 * writes a `timeout` result rather than exiting into silence. A graph the
 * engine refuses outright comes back as `rejected` with its node errors in the
 * message — and, unlike before, it is in the ledger. */
let d;
try {
  d = await door({ graph, label: "lora trainer shape probe", timeoutMs: 20 * 60_000 });
} catch (e) {
  console.log("\nREJECTED BEFORE RUNNING — the graph itself is wrong:");
  console.log(String(e.message).slice(0, 1400));
  process.exit(1);
}
console.log(`run ${d.runId}${d.promptId ? ` (prompt ${d.promptId})` : ""}`);
if (d.status !== "completed") {
  console.log(`\n${d.status.toUpperCase()} after ${d.elapsedSec.toFixed(0)}s. The real error:\n`);
  console.log(String(d.error || "").slice(0, 1400));
  process.exit(1);
}
console.log(`\nIT RAN. ${d.elapsedSec.toFixed(0)}s for one step at rank 4.`);
console.log("Shapes are compatible — the trainer accepts a Music 3 model,");
console.log("an audio flow latent and AR-derived conditioning.");
console.log("\noutputs:", JSON.stringify(d.outputs.map((o) => o.file)));
process.exit(0);
