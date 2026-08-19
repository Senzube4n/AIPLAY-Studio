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

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
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
const r = await fetch(`${BASE}/prompt`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: graph }),
});
const d = await r.json();
if (d.error) {
  console.log("\nREJECTED BEFORE RUNNING — the graph itself is wrong:");
  console.log(JSON.stringify(d.error, null, 2).slice(0, 1200));
  if (d.node_errors && Object.keys(d.node_errors).length) {
    console.log("\nnode errors:", JSON.stringify(d.node_errors, null, 2).slice(0, 1200));
  }
  process.exit(1);
}

console.log(`queued ${d.prompt_id} — waiting`);
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 4000));
  const h = await (await fetch(`${BASE}/history/${d.prompt_id}`)).json();
  const rec = h[d.prompt_id];
  if (!rec) {
    if (Date.now() - t0 > 20 * 60_000) { console.log("gave up after 20 min"); process.exit(1); }
    continue;
  }
  if (rec.status?.status_str === "error") {
    console.log(`\nFAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s. The real error:\n`);
    for (const m of rec.status.messages || []) {
      if (m[0] === "execution_error") {
        console.log("  node:", m[1]?.node_type, "-", m[1]?.exception_type);
        console.log("  msg :", String(m[1]?.exception_message || "").slice(0, 600));
        const tb = (m[1]?.traceback || []).slice(-6).join("");
        if (tb) console.log("  tail:\n" + tb.split("\n").slice(-8).join("\n"));
      }
    }
    process.exit(1);
  }
  if (rec.status?.completed) {
    console.log(`\nIT RAN. ${((Date.now() - t0) / 1000).toFixed(0)}s for one step at rank 4.`);
    console.log("Shapes are compatible — the trainer accepts a Music 3 model,");
    console.log("an audio flow latent and AR-derived conditioning.");
    console.log("\noutputs:", JSON.stringify(Object.keys(rec.outputs || {})));
    process.exit(0);
  }
}
