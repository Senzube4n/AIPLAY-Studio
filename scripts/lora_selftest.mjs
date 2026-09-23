/**
 * Does training a LoRA on Music 3 actually move the model?
 *
 * THE QUESTION. The shape test proved the trainer accepts a Music 3 model, an
 * audio flow latent and AR-derived conditioning, and produces a real adapter.
 * That is not the same as learning anything. This asks whether N steps of
 * training measurably pull a render toward its target.
 *
 * WHY A MATCHED PAIR. `MiniMaxMusic3TextEncode` runs the autoregressive stage,
 * so its conditioning embeds ONE specific composed performance. For a real
 * outside recording we cannot produce matching conditioning — that needs the
 * audio→RVQ tokenizer that was never released, which is the same wall the
 * "cover this exact song" idea hit. So training on outside audio necessarily
 * pairs conditioning for performance A with the acoustics of performance B.
 *
 * Whether that mismatch teaches style or teaches noise is the interesting
 * question, and it is unanswerable until we know the loop works at all. So this
 * removes the mismatch: the target is a song STUDIO ITSELF generated, whose AR
 * trajectory was captured, re-encoded through the DAV encoder. Conditioning and
 * latent describe the same performance. If training cannot move the model even
 * here, the mismatched case is hopeless and nobody needs to spend a night
 * finding that out.
 *
 * THE NOISE FLOOR COMES FIRST, for the same reason the video sweep needed one:
 * two renders at different seeds bound how much difference means nothing. A
 * LoRA effect smaller than the seed effect is not an effect.
 *
 *   node scripts/lora_selftest.mjs [steps] [rank]
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import { buildGraph } from "../server/workflow.js";

import { postJSON } from "./lib/doorpost.mjs";
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:lora_selftest with its graph stored whole, its resolved
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
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:lora_selftest" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 5000, ...body }),
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
const STEPS = Number(process.argv[2] || 150);
const RANK = Number(process.argv[3] || 16);
const OUT = path.join(config.outputDir, "_lora");

const DIT = "minimax_music3_dit_fp16.safetensors";
const TARGET_LATENT = "lora_target_43.latent";     // the song's own 60 s encoding
const CAPTION = "Global Metadata. BPM is 96. Key is A, scale is minor. Acoustic pop, intimate. "
  + "Production: close and dry, real room, wide stereo.";
const LYRICS = "[Intro]\n[Verse]\nMorning on the ring road, nothing moving yet\n[Chorus]\nStay a while\n[Outro]";
const AR_SEED = 20260818;                          // reproduces the captured trajectory

/** Conditioning, identical in every graph here so it is never the variable. */
const cond = (id, clipId) => ({
  [id]: {
    class_type: "MiniMaxMusic3TextEncode",
    inputs: {
      clip: [clipId, 0], caption: CAPTION, lyrics: LYRICS, seed: AR_SEED,
      max_duration: 60, cfg_scale: 1.0, top_k: 50, resume_from: "",
    },
  },
});

/**
 * A render, optionally through a freshly trained LoRA.
 *
 * Built by calling buildGraph — the SHIPPING builder — rather than by writing a
 * sampler here. The tuned sigma schedule, the sampler choice and the two-CFG
 * split are the whole reason renders sound the way they do, and a hand-rolled
 * copy would quietly measure a different program. Exactly the mistake the first
 * H3 shift sweep made.
 *
 * The LoRA is spliced in afterwards: insert LoraLoaderModelOnly and repoint
 * everything that reads the raw UNETLoader at it instead.
 */
function renderGraph({ flowSeed, lora, prefix }) {
  const g = buildGraph({
    caption: CAPTION, lyrics: LYRICS,
    seed: AR_SEED,          // fixes the AR trajectory: never the variable here
    mixSeed: flowSeed,      // the ONLY thing that differs between baselines
    maxDuration: 60,
    prefix,
  });
  // Force the fp16 DiT — training produced an adapter for that, not for the
  // int8 build that ships.
  g[1].inputs.unet_name = DIT;
  if (!lora) return g;

  const id = 99;
  g[id] = {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["1", 0], lora_name: lora, strength_model: 1.0 },
  };
  for (const [nid, node] of Object.entries(g)) {
    if (nid === String(id)) continue;
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (Array.isArray(v) && v[0] === "1" && k === "model") node.inputs[k] = [String(id), 0];
    }
  }
  return g;
}

function trainGraph() {
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: DIT, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: config.models.textEncoder, type: "minimax", device: "default" } },
    ...cond(3, "2"),
    4: { class_type: "LoadLatent", inputs: { latent: TARGET_LATENT } },
    5: {
      class_type: "TrainLoraNode",
      inputs: {
        model: ["1", 0], latents: ["4", 0], positive: ["3", 0],
        batch_size: 1, grad_accumulation_steps: 1, steps: STEPS,
        learning_rate: 0.0005, rank: RANK,
        optimizer: "AdamW", loss_function: "MSE", seed: 0,
        training_dtype: "bf16", lora_dtype: "bf16",
        quantized_backward: false, algorithm: "LoRA",
        /* checkpoint_depth 5 AND offloading are what make a 60-second latent fit
         * in 16 GB. At depth 1 even a 15-second window runs out of memory —
         * sequence length is the binding constraint here, not model size. */
        gradient_checkpointing: true, checkpoint_depth: 5, offloading: true,
        existing_lora: "[None]", bucket_mode: false, bypass_mode: false,
      },
    },
    6: { class_type: "SaveLoRA", inputs: { lora: ["5", 0], prefix: "selftest43", steps: STEPS } },
  };
}

/* adopt:false throughout — the training arm writes an adapter this script then
 * COPIES out of the output folder into models/loras, and the renders are scored
 * from where the graph put them by scripts/lora_score.py.
 *
 * The deadline is generous rather than the default half hour: training is the
 * one arm here that is measured in tens of minutes, and a bound that fires
 * mid-training would report a `timeout` on a run that was going perfectly. */
async function run(label, graph) {
  const d = await door({ graph, label, timeoutMs: Math.max(30, STEPS * 0.4) * 60_000 });
  if (d.status !== "completed") throw new Error(`${label} ${d.status}: ${String(d.error || "").slice(0, 300)}`);
  const files = d.outputs.map((o) => o.file);
  console.log(`  ${label.padEnd(22)} ${d.elapsedSec.toFixed(0)}s  ${files.join(", ")}`);
  return { secs: d.elapsedSec, files };
}

mkdirSync(OUT, { recursive: true });
console.log(`\nLoRA self-consistency — ${STEPS} steps, rank ${RANK}, 60 s matched pair\n`);

const results = {};
/* Baselines FIRST and two of them. If the LoRA render later differs from
 * baseline A by less than baseline A differs from baseline B, the LoRA did
 * nothing that a different seed would not also have done. */
results.baseA = await run("baseline seed 1", renderGraph({ flowSeed: 1, prefix: "lora_baseA" }));
results.baseB = await run("baseline seed 2", renderGraph({ flowSeed: 2, prefix: "lora_baseB" }));

console.log(`\n  training ${STEPS} steps (~${Math.round(STEPS * 12 / 60)} min expected)…`);
results.train = await run("train", trainGraph());

/* SaveLoRA writes into output/; LoraLoaderModelOnly only looks in models/loras/.
 * Nothing bridges those, so the adapter has to be moved before it can be used —
 * an easy hour to lose, because the render just reports a missing file long
 * after the training itself succeeded. */
const lora = `selftest43_${STEPS}_steps_00001_.safetensors`;
const src = path.join(config.outputDir, lora);
const dst = path.join(config.modelsDir, "loras", lora);
if (!existsSync(src)) throw new Error(`training finished but ${src} is not there`);
copyFileSync(src, dst);
console.log(`\n  copied adapter into models/loras, rendering through ${lora}`);
results.tuned = await run("with LoRA, seed 1", renderGraph({ flowSeed: 1, lora, prefix: "lora_tuned" }));

writeFileSync(path.join(OUT, "selftest.json"), JSON.stringify({ STEPS, RANK, results }, null, 2));
console.log(`\nwrote ${path.join(OUT, "selftest.json")}`);
console.log("now score it:  python scripts/lora_score.py");
