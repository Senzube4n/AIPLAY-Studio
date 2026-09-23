/**
 * Does YuE2 LoRA training actually LEARN, or does the loop merely run?
 *
 * Probe one (scripts/yue2_train_probe.mjs) proved the gradient can get through
 * once the rotary kernels have a derivative. It trains against an EMPTY latent
 * with conditioning for a freshly composed performance, so it teaches nothing
 * by construction, and it was never meant to. This is the pair that can:
 *
 *   target  = VAEEncodeAudio(a real recording, YuE2's own VAE)
 *   context = AiplayYuE2Continue(that same recording's semantic codes)
 *
 * ⚠ THE MATCHED PAIR IS THE WHOLE POINT. scripts/lora_selftest.mjs recorded the
 * wall this clears, in its own words: "For a real outside recording we cannot
 * produce matching conditioning — that needs the audio→RVQ tokenizer that was
 * never released." The catalogued tokenizer IS that encoder, so the conditioning
 * now describes the very performance being learned instead of a different one.
 *
 * ⚠ WHAT COUNTS AS AN ANSWER, AND WHY 60 STEPS IS NOT ONE. The trainer draws a
 * FRESH RANDOM NOISE LEVEL EVERY STEP (nodes_train.py:226,
 * `percent_to_sigma(torch.rand(...))`), so a step's loss is decided mostly by
 * which sigma came up: near-zero sigma has almost nothing to predict and scores
 * near zero, the top of the schedule scores high. The first real run bounced
 * between 0.00028 and 0.8447 across sixty steps. No trend of a few percent
 * survives that, and a short run's "the loss did not fall" means only that the
 * measurement is blind, never that the model learned nothing.
 *
 * A trend needs enough samples to average the sigma draw out -- several hundred
 * steps, read as a moving average. This prints the spread and says so, rather
 * than converting noise into a verdict.
 *
 *   node scripts/yue2_train_probe2.mjs [path-to-audio]
 *
 * Env: PROBE_STEPS (default 60), PROBE_RANK (default 8), PROBE_SECONDS (default
 * 24 — a slice, because the question is the trend and not the song).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import { tokenizeTrack, tokenizerStatus } from "../server/music/tokenize.js";

import { postJSON } from "./lib/doorpost.mjs";
const APP = process.env.AIPLAY_URL || "http://127.0.0.1:4173";
const STEPS = Number(process.env.PROBE_STEPS || 60);
const RANK = Number(process.env.PROBE_RANK || 8);
const SECONDS = Number(process.env.PROBE_SECONDS || 24);
const CKPT = process.env.PROBE_CKPT || "yue2_3b_int8_convrot.safetensors";
const SOURCE = process.argv[2] || path.join(config.outputDir, "Hex Appeal.wav");

async function post(body) {
  let r;
  try {
    r = await postJSON(`${APP}/api/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:yue2_train_probe2" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`start AIPLAY Studio first — nothing is answering at ${APP} (${e.cause?.code || e.message}).`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `AIPLAY Studio answered ${r.status}.`);
  return d;
}

/**
 * ⚠ SUBMIT AND POLL. NEVER HOLD ONE REQUEST OPEN FOR A TRAINING RUN.
 *
 * The first version passed `wait: true` and sat on the fetch. undici stops
 * waiting for headers at 300 s, so the script printed "RED after 306.7s" and
 * exited while the training was still running in the engine -- and kept running
 * for minutes afterwards. A timeout on the WATCHER dressed up as a failure of
 * the WORK, which is the most misleading shape a harness can take.
 *
 * Training takes as long as it takes. The harness does not get a ceiling.
 */
async function door(body) {
  const sub = await post({ action: "prompt", wait: false, adopt: false, ...body });
  if (sub.ok === false || sub.status === "error") throw new Error(String(sub.error || "the engine refused the graph"));
  const runId = sub.runId;
  if (!runId) throw new Error("the engine accepted the graph but named no run, so it cannot be followed");

  let lastSeen = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 6000));
    let rec;
    try {
      rec = await post({ action: "run", runId });
    } catch {
      continue;                      /* a blip while the card is busy is not a verdict */
    }
    const state = String(rec.state || rec.status || "");
    const secs = Math.round(Number(rec.runningSec || rec.elapsedSec || 0));
    if (secs >= lastSeen + 60) { lastSeen = secs; console.log(`  … still training, ${secs}s`); }
    if (state === "error" || rec.ok === false) throw new Error(String(rec.error || "the engine reported an error"));
    if (state === "completed" || state === "done" || state === "ok") return rec;
    if (state && !/running|queued|pending|starting/.test(state)) return rec;
  }
}

const sh = (cmd, args) => new Promise((res, rej) => {
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  c.on("error", rej);
  c.on("exit", (code) => (code === 0 ? res() : rej(new Error(err.slice(-400) || `${cmd} exited ${code}`))));
});

if (!existsSync(SOURCE)) {
  console.log(`No audio at ${SOURCE}. Pass one: node scripts/yue2_train_probe2.mjs "C:\\path\\to\\song.wav"`);
  process.exit(1);
}
const st = await tokenizerStatus();
if (!st.ready) {
  console.log("The real-audio tokenizer is not installed — download it on the Models screen.");
  console.log("Missing:\n  " + (st.missing || []).join("\n  "));
  process.exit(1);
}

console.log(`YuE2 LoRA training — does it LEARN?`);
console.log(`  ${path.basename(SOURCE)} · ${SECONDS}s slice · ${STEPS} steps · rank ${RANK}\n`);

/* A slice, into the engine's own input folder so LoadAudio can see it by name. */
const inputDir = config.inputDir || path.join(path.dirname(config.outputDir), "input");
mkdirSync(inputDir, { recursive: true });
const sliceName = `probe2_slice_${SECONDS}s.wav`;
const slice = path.join(inputDir, sliceName);
console.log(`Cutting ${SECONDS}s …`);
await sh("ffmpeg", ["-v", "error", "-y", "-i", SOURCE, "-t", String(SECONDS), "-ac", "2", "-ar", "44100", slice]);

console.log(`Reading it into YuE2's own codes (this is the encoder its authors never shipped) …`);
const tok = await tokenizeTrack({ source: slice });
console.log(`  ${tok.cached ? "cached" : "encoded"} · ${tok.frames ?? "?"} frames · ${tok.dir}\n`);

const graph = {
  1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CKPT } },
  2: { class_type: "LoadAudio", inputs: { audio: sliceName } },
  /* THE TARGET: the real recording, in the model's own latent space. */
  3: { class_type: "VAEEncodeAudio", inputs: { audio: ["2", 0], vae: ["1", 2] } },
  /* THE CONTEXT: that same recording, as the codes the model speaks. */
  4: {
    class_type: "AiplayYuE2Continue",
    inputs: {
      clip: ["1", 1], style: "", lyrics: "", abc: "", seed: 1234, mode: "off",
      codes_dir: String(tok.dir), prime_seconds: Math.max(1, SECONDS - 2),
      new_duration: 2, temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2,
    },
  },
  5: {
    class_type: "TrainLoraNode",
    inputs: {
      model: ["1", 0], latents: ["3", 0], positive: ["4", 0],
      batch_size: 1, grad_accumulation_steps: 1, steps: STEPS,
      learning_rate: 0.0002, rank: RANK, optimizer: "AdamW", loss_function: "MSE",
      seed: 0, training_dtype: "bf16", lora_dtype: "bf16", quantized_backward: false,
      algorithm: "LoRA", gradient_checkpointing: true, checkpoint_depth: 1,
      offloading: false, existing_lora: "[None]", bucket_mode: false, bypass_mode: false,
    },
  },
  6: { class_type: "AiplaySaveLossJson", inputs: { loss: ["5", 1], filename_prefix: "probe2_loss" } },
  7: { class_type: "SaveLoRA", inputs: { lora: ["5", 0], prefix: "probe2_yue2", steps: ["5", 2] } },
};

const before = new Set(readdirSync(config.outputDir).filter((f) => f.startsWith("probe2_loss")));
const started = Date.now();
try {
  await door({ graph });
} catch (e) {
  console.log(`RED after ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  console.log(String(e.message || e).slice(0, 1200));
  process.exit(1);
}
const secs = ((Date.now() - started) / 1000).toFixed(1);

const fresh = readdirSync(config.outputDir).filter((f) => f.startsWith("probe2_loss") && !before.has(f));
if (!fresh.length) {
  console.log(`The run finished in ${secs}s but wrote no loss file, so nothing can be concluded.`);
  process.exit(1);
}
const data = JSON.parse(readFileSync(path.join(config.outputDir, fresh.sort().pop()), "utf8"));
const loss = data.loss || [];
const head = loss.slice(0, Math.max(1, Math.floor(loss.length / 5)));
const tail = loss.slice(-Math.max(1, Math.floor(loss.length / 5)));
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const first = mean(head), last = mean(tail);
const drop = first ? ((first - last) / first) * 100 : 0;

console.log(`Ran ${data.steps} steps in ${secs}s.\n`);
console.log(`  first fifth, mean loss : ${first.toFixed(5)}`);
console.log(`  last  fifth, mean loss : ${last.toFixed(5)}`);
console.log(`  change                 : ${drop >= 0 ? "-" : "+"}${Math.abs(drop).toFixed(1)}%\n`);

/* ⚠ CAN THIS RUN ANSWER ITS OWN QUESTION? The noise level is redrawn every step,
 * so the loss series is mostly sigma and only slightly learning. Compare the
 * trend against the spread before believing either. */
const lo = Math.min(...loss), hi = Math.max(...loss);
const spread = lo > 0 ? hi / lo : Infinity;
const enough = data.steps >= 300;

console.log(`  spread, min..max       : ${lo.toFixed(5)} .. ${hi.toFixed(5)}`);
console.log(`  (the trainer redraws the noise level every step, so most of that is sampling)\n`);

if (!enough) {
  console.log(`TOO SHORT TO TELL, and that is a statement about the MEASUREMENT, not the model.`);
  console.log(`${data.steps} steps against a ${spread === Infinity ? "huge" : Math.round(spread) + "x"} spread cannot show a`);
  console.log(`few percent of learning. The loop ran, the gradient flowed and an adapter was`);
  console.log(`written — none of which is in doubt. Whether it LEARNS needs several hundred`);
  console.log(`steps so the random sigma averages out:\n`);
  console.log(`    PROBE_STEPS=600 node scripts/yue2_train_probe2.mjs\n`);
  console.log(`Do not read the percentage above as a verdict. It is noise either way.`);
  process.exitCode = 2;
} else if (drop > 5) {
  console.log(`LEARNING. Across ${data.steps} steps the loss fell ${drop.toFixed(1)}%, which is more than`);
  console.log(`the sigma draw explains. The adapter is being pulled toward this recording.`);
  console.log(`That is not the same as sounding good — only a render and a listen settle that.`);
} else {
  console.log(`NOT LEARNING, on ${data.steps} steps: ${drop.toFixed(1)}% is inside the sampling noise.`);
  console.log(`Suspect the conditioning/target pairing before the learning rate — the target is`);
  console.log(`VAEEncodeAudio over the recording and the context is that same recording's codes,`);
  console.log(`and if those two describe different spans of audio the model is being asked to`);
  console.log(`predict one thing from another.`);
  process.exitCode = 1;
}
