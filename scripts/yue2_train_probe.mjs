/**
 * Can ComfyUI's LoRA trainer touch YuE2 at all?
 *
 * ONE QUESTION, deliberately no others: do the tensors line up, and can
 * autograd get back through the checkpoint we actually have?
 *
 * ⚠ THE CHECKPOINT ON DISK IS `yue2_3b_int8_convrot.safetensors` — int8, and
 * convolution-rotated. scripts/lora_probe.mjs refused to run Music 3's probe on
 * exactly that kind of file, in its own words: "Backpropagating through a
 * quantised, convolution-rotated checkpoint is a second unknown stacked on the
 * first, and the point here is to isolate one." We have no fp16 YuE2, so the
 * unknown cannot be isolated by choosing a different file — it can only be
 * measured. If this fails at the backward pass, the finding is not "YuE2 cannot
 * be trained", it is "YuE2 cannot be trained from THIS file", and the fix is a
 * ~6 GB fp16 download rather than a redesign.
 *
 * WHAT THIS DOES NOT TEST. The latent here is an EMPTY one from
 * EmptyYuE2LatentAudio, and the conditioning is a freshly COMPOSED performance
 * from YuE2GenerateMusic. Training against that teaches nothing and is not
 * meant to: a shape probe asks whether the loop runs, never whether it learns.
 * The real-audio pair — VAEEncodeAudio over a recording, with conditioning from
 * AiplayYuE2Continue over that same recording's codes — is probe two, and it is
 * only worth building once this one is green.
 *
 *   node scripts/yue2_train_probe.mjs
 *
 * Env: PROBE_STEPS (default 1), PROBE_RANK (default 4), PROBE_SECONDS
 * (default 20 — the AR stage is the slow half and this does not care what it
 * composes).
 */

import { postJSON } from "./lib/doorpost.mjs";

const APP = process.env.AIPLAY_URL || "http://127.0.0.1:4173";

async function door(body) {
  let r;
  try {
    r = await postJSON(`${APP}/api/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:yue2_train_probe" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 4000, ...body }),
    });
  } catch (e) {
    /* The refusal IS the enforcement: a harness that cannot find the app cannot
     * find the engine either, because the engine's port is never published. */
    throw new Error(`start AIPLAY Studio first — nothing is answering at ${APP} `
      + `(${e.cause?.code || e.message}). Set AIPLAY_URL if the app is on another port.`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `AIPLAY Studio answered ${r.status} at ${APP}.`);
  /* ⚠ A 200 HERE MEANS THE REQUEST ARRIVED, NOT THAT THE GRAPH RAN. The door
   * answers `{ok:false, status:"error", error}` for a graph that threw, and the
   * first version of this probe read only `r.ok` — so a RuntimeError inside
   * TrainLoraNode came back as GREEN and the script printed a success banner
   * over the exact failure it exists to find. The work is what is being probed,
   * so the work's own verdict is the one that counts. */
  if (d.ok === false || d.status === "error") {
    const err = new Error(String(d.error || "the engine reported an error and gave no message"));
    err.engine = d;
    throw err;
  }
  return d;
}

const CKPT = process.env.PROBE_CKPT || "yue2_3b_int8_convrot.safetensors";
const STEPS = Number(process.env.PROBE_STEPS || 1);
const RANK = Number(process.env.PROBE_RANK || 4);
const SECONDS = Number(process.env.PROBE_SECONDS || 20);

/* The composing half is lifted from server/workflow.js's YuE2 graph verbatim,
 * so that a failure here is a failure of the TRAINER and not of a graph this
 * script invented. Node ids match that builder where they can. */
const graph = {
  1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CKPT } },
  5: {
    class_type: "YuE2GenerateMusic",
    inputs: {
      clip: ["1", 1],
      style: "warm lo-fi, brushed drums, close-mic vocal",
      lyrics: "a short line to condition on",
      abc: "", seed: 1234, mode: "full",
      max_duration: SECONDS,
      temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2,
    },
  },
  10: { class_type: "EmptyYuE2LatentAudio", inputs: { seconds: ["5", 1], batch_size: 1 } },
  20: {
    class_type: "TrainLoraNode",
    inputs: {
      model: ["1", 0],
      latents: ["10", 0],
      positive: ["5", 0],
      batch_size: 1,
      grad_accumulation_steps: 1,
      steps: STEPS,
      learning_rate: 0.0001,
      rank: RANK,
      optimizer: "AdamW",
      loss_function: "MSE",
      seed: 0,
      training_dtype: "bf16",
      lora_dtype: "bf16",
      quantized_backward: false,
      algorithm: "LoRA",
      gradient_checkpointing: true,
      checkpoint_depth: 1,
      offloading: false,
      existing_lora: "[None]",
      bucket_mode: false,
      bypass_mode: false,
    },
  },
  21: { class_type: "SaveLoRA", inputs: { lora: ["20", 0], prefix: "probe_yue2", steps: ["20", 2] } },
};

console.log(`YuE2 LoRA trainer probe — ${CKPT}`);
console.log(`  ${STEPS} step, rank ${RANK}, ${SECONDS}s of conditioning. Asking only whether the loop runs.\n`);

const started = Date.now();
try {
  const out = await door({ graph });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`GREEN — the trainer accepted YuE2 and produced an adapter. ${secs}s`);
  console.log(JSON.stringify(out, null, 2).slice(0, 1400));
  console.log(`\nNext: probe two — a real recording through VAEEncodeAudio, with conditioning`);
  console.log(`from AiplayYuE2Continue over that same recording's codes. That is the pair that`);
  console.log(`can actually teach something, and it is now worth building.`);
} catch (e) {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`RED after ${secs}s\n`);
  console.log(String(e.message || e));
  console.log(`\nRead the message above before concluding anything. The three failures that`);
  console.log(`mean different things:`);
  console.log(`  · a shape/dtype error at TrainLoraNode  → the trainer cannot hold YuE2's tensors`);
  console.log(`  · an autograd error through the weights → the int8 convrot file is the wall,`);
  console.log(`    and an fp16 YuE2 is the fix, not a redesign`);
  console.log(`  · CUDA out of memory                    → it may train on a bigger card;`);
  console.log(`    lower the rank and the loss head before believing otherwise`);
  process.exitCode = 1;
}
