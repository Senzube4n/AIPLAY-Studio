/**
 * TRAIN A LoRA ON A SONG YOU OWN.
 *
 * A recording goes in; an adapter comes out that can be selected on the Music
 * screen like any other. The chain is four links, and each was a wall until
 * recently:
 *
 *   target   VAEEncodeAudio(your recording, YuE2's own VAE)  -> LATENT
 *   context  AiplayYuE2Continue(encode_only, all source codes) -> CONDITIONING
 *   train    TrainLoraNode                                   -> LORA_MODEL
 *   keep     SaveLoRA, then moved into models/loras          -> selectable
 *
 * ⚠ WHY THIS COULD NOT EXIST BEFORE. Two separate walls came down this week and
 * both are worth remembering, because either one returning breaks the feature
 * silently rather than loudly.
 *
 *  1. THE CONDITIONING. scripts/lora_selftest.mjs recorded the older wall in its
 *     own words: "For a real outside recording we cannot produce matching
 *     conditioning — that needs the audio→RVQ tokenizer that was never
 *     released." Training with conditioning for performance A against the
 *     acoustics of performance B teaches the model to predict one thing from
 *     another. The catalogued tokenizer IS that encoder, so the context now
 *     describes the very audio being learned.
 *
 *  2. THE GRADIENT. comfy_kitchen's rotary-embedding kernels are registered
 *     forward-only, so backpropagation died in the first attention block of the
 *     DiT on every checkpoint and every card. server/comfy_nodes/
 *     aiplay_rope_autograd.py supplies the missing derivative. Without that file
 *     loaded, everything here raises "no autograd formula was registered".
 *
 * ⚠ WHAT IS NOT PROVEN, STATED HERE RATHER THAN DISCOVERED LATER. That the loop
 * RUNS is measured: a real adapter, 352 tensors, gradients reaching every site.
 * Whether N steps make a LoRA that audibly moves a render is NOT yet measured —
 * the trainer redraws the noise level every step (nodes_train.py:226), so a
 * short run's loss curve is mostly sigma and cannot answer it. The page says so
 * in plain words rather than implying a settled thing.
 */

import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { ffmpegPath, ffprobePath } from "../clipjoin.js";

/* Measured on this rig, not guessed: a rank-8 run on a 24 s slice took free VRAM
 * from 13841 MB to 4912 MB, so about 8.9 GB. The ceiling below leaves room for
 * the desktop and refuses BEFORE an hour of work rather than during it. */
export const TRAIN_VRAM_MB = 10_000;

export const STEPS_MIN = 50, STEPS_MAX = 4000, STEPS_DEFAULT = 600;
export const RANK_MIN = 2, RANK_MAX = 64, RANK_DEFAULT = 8;
export const LR_MIN = 0.000_01, LR_MAX = 0.01, LR_DEFAULT = 0.0002;
export const SECONDS_MIN = 8, SECONDS_MAX = 180, SECONDS_DEFAULT = 24;
export const START_SECONDS_MAX = 3600;
export const NAME_MAX = 48;

/** Where a finished adapter must land to be selectable anywhere else. */
export const lorasDir = () => path.join(config.rig, "ComfyUI", "models", "loras");

export function refuse(reason, message, status = 400) {
  const e = new Error(message);
  e.reason = reason;
  e.status = status;
  return e;
}

/**
 * A name a person typed becomes a filename on their disk, so it is rebuilt
 * rather than trusted — and it keeps a prefix, because an adapter that cannot
 * be told apart from a downloaded one in the same folder is a support question
 * waiting to happen.
 */
export function trainName(raw) {
  const stem = String(raw || "")
    .trim()
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, NAME_MAX);
  if (!stem) throw refuse("name", "Give the LoRA a name — it becomes the filename you pick later.");
  return `mine_${stem}`;
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Every number the trainer takes, clamped rather than refused: a slider that
 *  refuses is a slider somebody works around. */
export function trainSettings(b = {}) {
  const lr = Number(b.learningRate);
  const startSeconds = b.startSeconds === undefined ? 0 : Number(b.startSeconds);
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > START_SECONDS_MAX) throw refuse("region", `Training startSeconds must be between 0 and ${START_SECONDS_MAX}.`);
  return {
    steps: clampInt(b.steps, STEPS_MIN, STEPS_MAX, STEPS_DEFAULT),
    rank: clampInt(b.rank, RANK_MIN, RANK_MAX, RANK_DEFAULT),
    seconds: clampInt(b.seconds, SECONDS_MIN, SECONDS_MAX, SECONDS_DEFAULT),
    startSeconds,
    learningRate: Number.isFinite(lr) ? Math.min(LR_MAX, Math.max(LR_MIN, lr)) : LR_DEFAULT,
  };
}

/** Refuse an unavailable region before extracting audio or tokenizing it. */
export function trainRegion(settings, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw refuse("region", "The recording's audio duration could not be measured.");
  const startSeconds = Number(settings.startSeconds ?? 0), seconds = Number(settings.seconds);
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > START_SECONDS_MAX || !Number.isFinite(seconds) || seconds < SECONDS_MIN || seconds > SECONDS_MAX) throw refuse("region", "Choose a valid training start and an 8–180 second region.");
  if (startSeconds + seconds > duration + 0.001) throw refuse("region", `That region ends at ${(startSeconds + seconds).toFixed(2)}s, beyond the recording's ${duration.toFixed(2)}s. Choose an earlier start or a shorter region (at least ${SECONDS_MIN}s).`);
  return { ...settings, startSeconds, seconds, sourceDuration: duration };
}

export async function probeTrainAudio(file, { runner = promisify(execFile), ffprobe = ffprobePath() } = {}) {
  let result;
  try {
    result = await runner(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type,duration:format=duration", "-of", "json", file],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 });
  } catch (error) { throw refuse("region", `The recording's audio could not be measured: ${error.message}`); }
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw refuse("region", "The recording's duration probe returned invalid data."); }
  if (!info.streams?.some((stream) => stream.codec_type === "audio")) throw refuse("region", "That recording has no audio stream.");
  const streamDuration = Number(info.streams.find((stream) => stream.codec_type === "audio")?.duration);
  const duration = streamDuration > 0 ? streamDuration : Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw refuse("region", "The recording's audio duration could not be measured.");
  return duration;
}

export function trainSliceArgs(source, target, settings) {
  return ["-v", "error", "-y", "-ss", String(settings.startSeconds ?? 0), "-i", source,
    "-t", String(settings.seconds), "-map", "0:a:0", "-ac", "2", "-ar", "44100", target];
}
export const trainFfmpeg = () => ffmpegPath();

/**
 * Can this machine train right now, and if not, exactly why.
 *
 * ⚠ THE REFUSAL ORDER IS THE POINT. Each answer names one fixable thing, and the
 * VRAM check is last because it is the only one that can change minute to
 * minute — telling somebody to download a tokenizer they already have because a
 * render happened to be running would be the wrong sentence.
 */
export async function trainStatus({ tokenizer, checkpoints = [], freeVramMb = null, busy = false } = {}) {
  const ckpt = checkpoints.find((c) => /yue2/i.test(c)) || null;
  const out = {
    ready: false, reason: null, why: "",
    tokenizerReady: !!tokenizer?.ready,
    checkpoint: ckpt,
    freeVramMb, needVramMb: TRAIN_VRAM_MB, busy,
    defaults: { steps: STEPS_DEFAULT, rank: RANK_DEFAULT, seconds: SECONDS_DEFAULT, startSeconds: 0, learningRate: LR_DEFAULT },
    limits: { secondsMin: SECONDS_MIN, secondsMax: SECONDS_MAX, startSecondsMax: START_SECONDS_MAX, semanticFramesMax: SECONDS_MAX * 25 },
    /* Said on the screen, every time, not buried in a document. */
    licence: "The audio tokenizer uses Mothersuperior's YuE2 head and m-a-p's MERT backbone, which is licensed CC BY-NC 4.0 (non-commercial). "
      + "Review the checkpoint and tokenizer terms for your intended use; permission to use the source recording is separate. This page does not determine your adapter's licence.",
    honest: "That the loop runs is measured. Whether a given number of steps produces an adapter you can HEAR is not "
      + "measured yet — the trainer redraws its noise level every step, so a short run's loss curve cannot answer it.",
  };
  if (!tokenizer?.ready) {
    out.reason = "tokenizer-missing";
    out.why = "The real-audio tokenizer is not on this machine. It is the piece that reads your recording into the "
      + "codes the model speaks, and without it there is nothing to train against. Download it on the Models screen.";
    out.missing = tokenizer?.missing || [];
    return out;
  }
  if (!ckpt) {
    out.reason = "no-checkpoint";
    out.why = "No YuE2 checkpoint is on this machine, so there is no model to adapt. Download one on the Models screen.";
    return out;
  }
  if (busy) {
    out.reason = "busy";
    out.why = "Something is using the graphics card. Training takes it completely, so it waits for the card to be free.";
    return out;
  }
  if (Number.isFinite(freeVramMb) && freeVramMb < TRAIN_VRAM_MB) {
    out.reason = "vram";
    out.why = `Training needs about ${(TRAIN_VRAM_MB / 1024).toFixed(0)} GB of free video memory and this machine has `
      + `${(freeVramMb / 1024).toFixed(1)} GB free right now. Measured here: a rank-8 run on a 24-second slice used 8.9 GB. `
      + `Close what is holding the card, or train on a machine with more of it — a friend's, through Collab.`;
    return out;
  }
  out.ready = true;
  out.why = "This machine can train. Pick a song you own, give the adapter a name, and it will take the card for a while.";
  return out;
}

/**
 * The graph. Node ids match scripts/yue2_train_probe2.mjs deliberately, so a
 * failure on this screen and a failure in the harness are the same failure and
 * can be compared line for line.
 */
export function trainGraph({ ckpt, sliceName, codesDir, seconds, steps, rank, learningRate, name, seed = 0 }) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < SECONDS_MIN || Number(seconds) > SECONDS_MAX) {
    throw refuse("duration", `Training requires ${SECONDS_MIN}–${SECONDS_MAX} seconds. The actual recording and code-frame count are checked before conditioning.`);
  }
  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    2: { class_type: "LoadAudio", inputs: { audio: sliceName } },
    3: { class_type: "VAEEncodeAudio", inputs: { audio: ["2", 0], vae: ["1", 2] } },
    4: {
      class_type: "AiplayYuE2Continue",
      inputs: {
        clip: ["1", 1], style: "", lyrics: "", abc: "", seed, mode: "off",
        codes_dir: String(codesDir), prime_seconds: 0, encode_only: true, source_audio: ["2", 0],
        new_duration: 0, temperature: 1.0, top_p: 0.95, top_k: 100, repetition_penalty: 1.2,
      },
    },
    5: {
      class_type: "TrainLoraNode",
      inputs: {
        model: ["1", 0], latents: ["3", 0], positive: ["4", 0],
        batch_size: 1, grad_accumulation_steps: 1, steps, learning_rate: learningRate,
        rank, optimizer: "AdamW", loss_function: "MSE", seed,
        training_dtype: "bf16", lora_dtype: "bf16", quantized_backward: false,
        algorithm: "LoRA", gradient_checkpointing: true, checkpoint_depth: 1,
        offloading: false, existing_lora: "[None]", bucket_mode: false, bypass_mode: false,
      },
    },
    6: { class_type: "AiplaySaveLossJson", inputs: { loss: ["5", 1], filename_prefix: `${name}_loss` } },
    7: { class_type: "SaveLoRA", inputs: { lora: ["5", 0], prefix: name, steps: ["5", 2] } },
  };
}

/**
 * ⚠ SaveLoRA WRITES TO THE OUTPUT FOLDER, WHERE NOTHING CAN SELECT IT. Every
 * LoRA picker in this app reads models/loras, so an adapter left where the
 * trainer put it is an hour of somebody's electricity they cannot use. This is
 * the step that turns a file into a feature.
 *
 * Copy rather than move: the output folder is also the provenance trail, and a
 * run whose artefact vanished afterwards is a gap in it.
 */
export async function adoptLora(name, { outputDir = config.outputDir, dest = lorasDir(), outputPrefix = name, exact = false } = {}) {
  const names = await readdir(outputDir).catch(() => []);
  if (!/^mine_[A-Za-z0-9_-]+$/.test(name) || !/^mine_[A-Za-z0-9_-]+$/.test(outputPrefix)) throw refuse("name", "Invalid training output prefix.");
  const mine = names.filter((f) => f.startsWith(`${outputPrefix}_`) && f.endsWith(".safetensors"));
  if (exact && mine.length !== 1) throw refuse("ambiguous-adapter", "This training run must have exactly one matching adapter output; nothing was adopted.", 409);
  if (!mine.length) throw refuse("no-adapter", `Training finished but wrote no adapter named ${name}.`, 500);
  const dated = [];
  for (const f of mine) {
    const info = await stat(path.join(outputDir, f)).catch(() => null);
    if (info?.isFile()) dated.push({ f, at: info.mtimeMs, bytes: info.size });
  }
  dated.sort((a, b) => b.at - a.at);
  const newest = dated[0];
  if (!newest) throw refuse("no-adapter", `Training finished but wrote no adapter named ${name}.`, 500);
  await mkdir(dest, { recursive: true });
  const target = path.join(dest, `${name}.safetensors`);
  await cp(path.join(outputDir, newest.f), target);
  return { file: target, name: `${name}.safetensors`, bytes: newest.bytes, from: newest.f };
}

/** What this machine has trained, newest first — read from the folder that
 *  decides what is selectable, never from a list this module keeps. */
export async function listTrained({ dest = lorasDir() } = {}) {
  const names = await readdir(dest).catch(() => []);
  const rows = [];
  for (const f of names.filter((x) => x.startsWith("mine_") && x.endsWith(".safetensors"))) {
    const info = await stat(path.join(dest, f)).catch(() => null);
    if (info?.isFile()) rows.push({ name: f, bytes: info.size, at: Math.round(info.mtimeMs) });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows;
}
