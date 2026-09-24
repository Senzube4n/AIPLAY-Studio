/**
 * THE SIXTH INTERPRETER — a whole song from YuE2, in a python this app does not
 * own, behind a door shaped exactly like the mesh door.
 *
 * ══ WHY THERE IS ANOTHER DOOR ═════════════════════════════════════════════
 *
 * `docs/ENGINE_DOOR.md` says there is ONE way to the graphics card. It says it
 * because on 2026-09-02 the rig's output folder held 426 files written since the
 * previous noon and 424 of them had no ledger entry of any kind. Every door
 * added since has had to answer for itself in writing, and this is this one's
 * answer:
 *
 *   · The engine's interpreter is pinned at torch 2.13.0+cu130 because the music
 *     model's fused int8 kernels exist only on that build (`server/config.js`).
 *   · YuE2 runs in `venv-yue`: Python 3.10.6, torch 2.10.0+cu130,
 *     transformers 4.57.6, numpy 2.2.6, yue2_infer 0.1.6. MEASURED off
 *     `D:\AI\aiplay-studio-bench\venv-yue` on 2026-09-11.
 *   · `pip install yue2-infer` into the engine's venv does not fail. It
 *     succeeds, it moves torch, and the owner's next MiniMax render dies hours
 *     later inside a kernel, in a place that says nothing about YuE2.
 *
 * So: a subprocess, and the same discipline `server/mesh/runner.js` carries —
 * the SAME two ledger rows in the same order, a `delegate` before anything is
 * spent and a `generate` after, with the delegate AWAITED AND NO `.catch()`. A
 * song is exactly as capable of becoming an unattributable file in a folder as a
 * clip is.
 *
 * ⚠ AND IT IS NOT A LICENCE BOUNDARY. `server/mv/blender.js` is a subprocess
 * because `import bpy` would make this Apache-2.0 tree a derivative of a GPL
 * program. yue2_infer is the vendor's own pip package, imported by a driver that
 * ships in this repository. The boundary here is a torch build.
 *
 * ⚠ WHAT THE WEIGHTS' LICENCE SAYS, because the output of this door is a
 * RECORDING and somebody will want to sell it. YuE2-3B and YuE2-Vae weights are
 * CC BY-NC 4.0 — read from `models/YuE2-3B/LICENSE` on this disk on 2026-09-11,
 * not from a repo tag. See YUE2_RIGHTS below; it travels in every generate row.
 *
 * ══ WHAT IS IMPORTED RATHER THAN COPIED ═══════════════════════════════════
 *
 * `killMeshProcessTree()` and `freeVramMb()` come from `server/mesh/runner.js`,
 * and `jsonAfter()` from `server/mv/blender.js`, because two copies of a
 * hardened thing decay into one hardened thing and one that looks like it. Each
 * of the three exists because of a measured failure:
 *
 *   killMeshProcessTree  a plain stop left a python child rendering, which
 *                        contaminated every timing measurement by 3.3x-10.8x and
 *                        presented as a slow render rather than a stuck one.
 *   freeVramMb           a FRESH read, not `server/gpu.js`'s 3-second poller: a
 *                        refusal that passes because a cache had not filled is
 *                        not a refusal, and `null` means NO READING, never zero.
 *   jsonAfter            the driver's stdout is shared with whatever the vendor
 *                        package prints on it — `yue2/fast.py` `print()`s
 *                        "[YuE2] Flash Attention failed; retrying with
 *                        backend=torch-eager" straight to stdout — so the result
 *                        object is brace-matched after a marker instead of the
 *                        rest of a line being trusted.
 *
 * And `CATALOG`, for the same reason one level up: `server/models.js`'s
 * `musicYue2` row already holds both checkpoints' measured bytes and hashes, the
 * VRAM floor and the CC BY-NC verdict. This file reads them rather than restating
 * them — see the note at `YUE_CAP` — because a runner with its own opinion about
 * a byte count is how "the downloader writes to one folder and the runner reads
 * another" happens.
 *
 * ⚠ ONE HARDENED THING IS *NOT* IMPORTABLE and this file admits it: the exit-code
 * vocabulary's traceback hoist. It is inline in `server/mv/blender.js:505` and
 * again in `server/mesh/runner.js:634` — the decay has already happened once —
 * and neither is exported. `hoistPythonError()` below is that logic written as a
 * function so a consolidation has one callable to point at, and
 * the consolidation diff that makes the other two import it is a follow-up.
 * `yue_test.js` reads both files and fails if their regex literal ever differs
 * from this one, so the third copy cannot drift silently.
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stat, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { config } from "../config.js";
import * as provenance from "../provenance.js";
import { TOOL, normalizeActor } from "../provenance.js";
import { jsonAfter } from "../mv/blender.js";
import { freeVramMb, killMeshProcessTree, sha256File } from "../mesh/runner.js";
import { CATALOG } from "../models.js";
import { verifyReplayManifest, replayRuntime, replayModelIdentities } from "./yue-artifacts.js";

/**
 * ONE SENTENCE, CARRIED INTO EVERY RECORD THIS MODULE WRITES.
 *
 * Same reason `SECOND_DOOR` exists in the mesh runner: a reader three years from
 * now finds a ledger row that did not come through the engine door and has to be
 * able to tell a DELIBERATE door from somebody bypassing the record again.
 */
export const THIRD_DOOR =
  "server/music/yue.js — a THIRD door. YuE2 needs torch 2.10.0+cu130 and the engine's python is "
  + "pinned at 2.13.0+cu130 for MiniMax's fused int8 kernels, so this runs in venv-yue as a "
  + "subprocess. It writes the same delegate/generate pair the engine door writes.";

/** The marker the driver prints its answer after. Same shape as mesh's. */
const RESULT_MARKER = "YUE_RESULT_JSON:";
/** The prefix the driver's own milestone lines carry on stderr. */
const EVENT_MARKER = "YUE_EVENT:";

/** The ledger's name for this engine — the key `MODEL_TO_CAPABILITY` bridges, so
 *  `provenance.append()`'s stampRights() resolves the row and a generate lands
 *  stamped rather than `unknown`. */
export const YUE_MODEL = "yue2";
/** And the catalogue row it bridges to. */
export const YUE_CAP = "musicYue2";

/**
 * ⚠ THE CATALOGUE OWNS THE FILE FACTS AND THE HARDWARE FLOOR. THIS FILE OWNS
 * WHERE IT WAS TOLD TO LOOK.
 *
 * `server/models.js` gained a full `musicYue2` row while this door was being
 * written: both checkpoints with their measured bytes and sha256, `requires`
 * with a VRAM floor, and the first `not-for-sale` outputRights verdict in the
 * catalogue. So none of that is retyped here — a second opinion about the same
 * file is how "the downloader writes to one folder and the runner reads another"
 * happens, which is the defect `server/mesh/catalogue_test.js` exists to catch.
 *
 * The split is deliberate:
 *   · the ROW says how many bytes a checkpoint has, what it hashes to, what the
 *     card needs, and whether a song may be sold;
 *   · THIS FILE says which directory the interpreter was pointed at, because
 *     that is env-overridable and the row's `dest` is not;
 *   · and the row's numbers are joined to those paths by the `identifies` tail,
 *     which is exactly what that field is for.
 * When the row is absent (a trimmed catalogue, a fork) the measured fallbacks
 * below are used and every caller is told which source answered.
 */
const cap = (id) => CATALOG.find((c) => c.id === id) || null;

/* ───────────────────────────────────────────────── where any of this lives */

/**
 * The interpreter, the two checkpoints, and the package to import.
 *
 * ⚠ DERIVED FROM `config.rig`, NOT FROM A NEW `config.yue` BLOCK, because
 * `server/config.js` is a shared file and three other agents are in this repo
 * tonight. `config.yue?.x` is read FIRST so the moment the main session applies
 * the consolidation diff lands, this module starts honouring it with no edit here — and
 * until then the defaults name what is actually on this disk, which is the
 * defect a default is supposed to prevent (config.js:240 records the same
 * lesson: four invented mesh paths, none of which existed).
 */
export const YUE = {
  python: process.env.AIPLAY_YUE_PYTHON || config.yue?.python
    || path.join(config.rig, "venv-yue", "Scripts", "python.exe"),
  model: process.env.AIPLAY_YUE_MODEL || config.yue?.model
    || path.join(config.rig, "yue2-kit", "models", "YuE2-3B"),
  vae: process.env.AIPLAY_YUE_VAE || config.yue?.vae
    || path.join(config.rig, "yue2-kit", "models", "YuE2-Vae"),
};

/**
 * The two checkpoints: which role, which directory, and the file facts joined
 * from the catalogue row by its `identifies` tail.
 *
 * The FALLBACK numbers here are MEASURED — YuE2-3B model.safetensors 7261441640
 * bytes, sha256 1d55c42c…; YuE2-Vae model.safetensors 530512720 bytes, sha256
 * 807ce9d5… — read out of the receipt of the 2026-09-11 render (`result.json`
 * `weights`), which is itself the vendor's `weights_manifest.json` verified at
 * load time by `yue2/storage.py:model_identity()`. They agree with the
 * catalogue's, which is the point: `yue_test.js` fails if they ever stop
 * agreeing, so the fallback cannot quietly become a second answer.
 */
const WEIGHT_ROLES = [
  { role: "mot", label: "YuE2-3B", setting: "AIPLAY_YUE_MODEL",
    identifies: "YuE2-3B/model.safetensors", dir: () => YUE.model, file: "model.safetensors",
    bytes: 7261441640,
    sha256: "1d55c42c1a9875c34f5d736e15078449992b044e807ce2a138e6cf289a1e59e9" },
  { role: "vae", label: "YuE2-Vae", setting: "AIPLAY_YUE_VAE",
    identifies: "YuE2-Vae/model.safetensors", dir: () => YUE.vae, file: "model.safetensors",
    bytes: 530512720,
    sha256: "807ce9d5149fa27c5ad3e6582058469852e908f6c5acc8c8aa338e7ab7751346" },
];

/** The roles with the catalogue's file facts joined in, and a note saying which
 *  source answered — so a disagreement is visible rather than averaged. */
export function weightFiles() {
  const rows = cap(YUE_CAP)?.files || [];
  return WEIGHT_ROLES.map((w) => {
    const row = rows.find((f) => f.identifies === w.identifies) || null;
    return {
      ...w,
      dest: path.join(w.dir(), w.file),
      bytes: row?.bytes ?? w.bytes,
      sha256: row?.sha256 ?? w.sha256,
      factsFrom: row ? `server/models.js — ${YUE_CAP}` : "server/music/yue.js — measured fallback",
      /* ⚠ Kept separately so a drift is a FACT in the status rather than an
       * argument between two files that a reader has to referee. */
      fallbackBytes: w.bytes, fallbackSha256: w.sha256,
    };
  });
}

/* Deliberately NO `WEIGHT_FILES` export beside weightFiles(). A constant with
 * that name would be the fallback WITHOUT the catalogue's facts joined in, and
 * the first caller to reach for the shorter name would get the second answer
 * this module exists to avoid. One accessor, one answer. */

/** A refusal, so a caller can branch on the KIND without matching on prose. */
export class YueRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "YueRefusal";
    this.refusal = code;
    Object.assign(this, detail);
  }
}

/**
 * Is the interpreter here, are the weights here? -> {installed, why[], …}
 *
 * Written the way `meshStatus()` is written and for the same reason: it names the
 * missing file and the setting that moves it, so a route can hide a button it
 * cannot honour instead of offering one that dies in a subprocess. Every check
 * is a `stat()`; nothing is spawned, nothing is imported, no card is touched.
 */
export async function yueStatus() {
  const why = [];
  try { await stat(YUE.python); } catch {
    why.push(`The YuE2 python is not at ${YUE.python} — set AIPLAY_YUE_PYTHON to venv-yue's `
      + `python.exe. It must be its OWN virtual environment: yue2-infer's pins would move the `
      + `engine's torch, and the music model's fused int8 kernels exist only on 2.13.0+cu130.`);
  }
  const weights = [];
  for (const w of weightFiles()) {
    const dest = w.dest;
    let bytes = null;
    try { bytes = (await stat(dest)).size; } catch { /* reported below */ }
    weights.push({ role: w.role, dest, declaredBytes: w.bytes, bytes,
                   factsFrom: w.factsFrom, sha256: w.sha256 });
    if (bytes === null) {
      why.push(`${w.label} is not at ${dest} — set ${w.setting} to the kit's model folder, or `
        + `fetch "${cap(YUE_CAP)?.label || YUE_CAP}" from the Models screen `
        + `(${((cap(YUE_CAP)?.files || []).reduce((a, f) => a + (f.bytes || 0), 0) / 1e9).toFixed(2)} GB).`);
    } else if (bytes !== w.bytes) {
      /* A partial download is the failure this catches: the file exists, the
       * pipeline loads it, and safetensors raises somewhere that reads as a bug
       * in this feature. `storage.py:model_identity()` would catch it too, ~20 s
       * and one interpreter start later. */
      why.push(`${path.basename(dest)} for ${w.role} is ${bytes} bytes and the measured checkpoint `
        + `is ${w.bytes} — a partial or substituted download, so nothing was started.`);
    }
  }
  /* The generation config is read for the token caps the progress denominator
   * assumes. Its absence is not fatal — TOKEN_CAPS has the measured fallback —
   * so it is reported without joining `why`. */
  const capsFile = path.join(YUE.model, "yue2_generation_config.json");
  let capsPresent = true;
  try { await stat(capsFile); } catch { capsPresent = false; }
  return {
    installed: !why.length,
    python: YUE.python, model: YUE.model, vae: YUE.vae,
    weights, capsFile, capsPresent, why,
  };
}

/* ───────────────────────────────────────────────────────────────── the card */

const MIB_PER_GIB = 1024;   // nvidia-smi reports MiB

/**
 * ⚠ THE VRAM FLOOR IS DERIVED FROM THE MEASUREMENT, NOT FROM THE VENDOR.
 *
 * The vendor's own skill says: "BF16-capable NVIDIA GPU with 24 GB VRAM"
 * (`skills/yue2-music/SKILL.md`, the supported baseline). This card has 15.99
 * GiB usable — MEASURED — so a 24 GiB gate would refuse every run on the rig
 * that has already produced 167.0 s of finished 48 kHz audio. A gate that
 * forbids the thing it has watched succeed is not a safety property; it is a
 * broken feature with a citation.
 *
 * What the run actually cost: peak ~10.6 GiB of 15.99 usable. MEASURED,
 * 2026-09-11, 399.6 s end to end. The floor is that peak plus ESTIMATED 0.9 GiB
 * of headroom for allocator fragmentation, which is a guess and is labelled one.
 *
 * ⚠ AND THE PIPELINE KEEPS ITS OWN RESERVE ON TOP: pipeline.py:162-165 computes
 * `budget = min((memory_budget_gib - 2) * 2^30, total - 2*2^30)` and calls
 * `set_per_process_memory_fraction`. With `memory_budget_gib: 16` on this card
 * that caps torch at 13.99 GiB, which is above the floor here on purpose — the
 * driver asks for a high cap AND small VAE tiles, which is the combination the
 * CLI cannot express. See yue_driver.py's header for the OOM that taught it.
 */
export const PEAK_GIB = 10.6;        // MEASURED
export const HEADROOM_GIB = 0.9;     // ESTIMATED — allocator fragmentation
/* The arithmetic rather than its answer, so the derivation is checkable and a
 * change to either input cannot leave a stale total behind. `toFixed` because
 * 10.6 + 0.9 is 11.500000000000002 in IEEE doubles, and a floor that prints
 * fourteen decimal places in a refusal reads as a bug. */
export const DERIVED_MIN_GIB = Number((PEAK_GIB + HEADROOM_GIB).toFixed(2));
export const CARD_USABLE_GIB = 15.99; // MEASURED
export const VENDOR_RECOMMENDED_GIB = 24; // the vendor's figure, recorded and NOT used as the gate

/**
 * ⚠ TWO NUMBERS, AND THEY ARE NOT THE SAME QUESTION. This function used to read
 * the catalogue row on the principle that one floor in the repository beats two
 * that agree today — and that was right while the row meant "the smallest card
 * above the measured peak", because that reading also happened to be a sane
 * amount of FREE memory to demand before starting.
 *
 * It stopped being right on 2026-09-11, when the row was corrected from 12 to
 * 16. The correction is sound and is a fact about a PURCHASE: the pipeline
 * reserves 2 GiB off the top whatever budget it is handed (pipeline.py:162), so
 * a 12 GiB card leaves torch 10 GiB against a 10.6 GiB peak and cannot run this
 * at all. But "you need a 16 GiB card" is not "16 GiB must be free", and using
 * it as the runtime gate made the gate UNSATISFIABLE on the only machine that
 * has ever rendered a song here: a 16 GiB card never has 16 GiB free, because
 * the desktop is on it. MEASURED: the refusal fired at 14.0 GiB free, saying it
 * was waiting for 2.0 GiB more that will never arrive.
 *
 * So:
 *   vramMinGb (16, models.js)  — the card you must OWN. Includes the 2 GiB the
 *                                runtime takes before your song gets any.
 *   DERIVED_MIN_GIB (11.5)     — what must be FREE to start: measured peak plus
 *                                labelled headroom. This is the gate.
 *
 * The anti-drift property survives as a RELATION rather than as one shared
 * number, and `yue_test.js` holds it: the row must stay at or above this floor
 * plus the runtime's own reserve, which is the only way the two can contradict
 * each other. A row that promises a card too small to host the floor is the bug
 * this pair is watching for.
 */
export const PIPELINE_RESERVE_GIB = 2;   // MEASURED — pipeline.py:162, taken whatever the budget
export function vramFloorGib() {
  return { gib: DERIVED_MIN_GIB,
           from: `server/music/yue.js — ${PEAK_GIB} GiB measured peak + ${HEADROOM_GIB} headroom` };
}
/** The card the Models screen asks for — a different question; see above. */
export function vramCardGib() {
  const rowGb = Number(cap(YUE_CAP)?.requires?.vramMinGb);
  return Number.isFinite(rowGb) && rowGb > 0 ? rowGb : null;
}
/** The live answer, for callers and for a status panel. */
export const VRAM_MIN_GIB = vramFloorGib().gib;

/**
 * REFUSAL — free VRAM below the floor derived above.
 *
 * ⚠ THE READING IS SUPPLIED BY PRESENCE, NOT BY VALUE, exactly as
 * `refuseVram()` does it in the mesh runner: `null` is a LEGAL reading meaning
 * "there is no NVIDIA card to read", so a default of `free = null` would make an
 * explicit no-reading indistinguishable from "please go and look", and the
 * branch that matters most would be the one that could not be tested.
 *
 * NO READING IS NOT A REFUSAL. An AMD card, a laptop with no discrete GPU, a
 * driver mid-update — none of those is evidence of a full card.
 *
 * ⚠ AND IT SAYS WHAT IT IS WAITING FOR, WITH THE NUMBERS, AND WHERE THEY CAME
 * FROM. A resident model that cannot explain itself looks broken: "not enough
 * VRAM" sends somebody to close a browser; "waiting for 12 GiB, 7.0 GiB free
 * now, the floor is models.js's musicYue2 row, the engine is holding the card on
 * purpose" sends them to the Engine screen — and tells them which file to argue
 * with if they think the floor is wrong.
 */
export async function refuseVram(opts = {}) {
  const freeMb = "free" in opts ? opts.free : await freeVramMb();
  const floor = vramFloorGib();
  const needMb = Math.round(floor.gib * MIB_PER_GIB);
  if (freeMb === null) {
    return { free: null, needGib: floor.gib, floorFrom: floor.from, waitingFor: null };
  }
  if (freeMb < needMb) {
    throw new YueRefusal("vram",
      `Waiting for ${floor.gib} GiB of the graphics card to be free. `
      + `${(freeMb / MIB_PER_GIB).toFixed(1)} GiB is free right now, so nothing was started.\n`
      + `Where that figure comes from: a finished YuE2 render on this machine peaked at `
      + `${PEAK_GIB} GiB of ${CARD_USABLE_GIB} usable (measured, 167.0 s of audio in 399.6 s), and `
      + `the floor is ${floor.from}. The vendor recommends ${VENDOR_RECOMMENDED_GIB} GB; this `
      + `card does not have it and the successful render did not need it, so that figure is not the `
      + `gate.\n`
      + `The music and video engine is resident — that is what is holding the card, and it is `
      + `holding it on purpose. Unload it from the Models or Engine screen, or let whatever is `
      + `rendering finish, then ask again. Nothing here will evict it: a song is not worth `
      + `somebody's half-finished song.\n`
      + `This is a refusal rather than a CUDA out-of-memory two minutes in — which on this model `
      + `lands at nar.py:95 trying to allocate 3.86 GiB, in a traceback that says nothing about `
      + `memory being somebody else's.`,
      { freeMb, needMb, needGib: floor.gib, floorFrom: floor.from,
        waitingFor: `${((needMb - freeMb) / MIB_PER_GIB).toFixed(1)} GiB more` });
  }
  return { free: freeMb, needGib: floor.gib, floorFrom: floor.from, waitingFor: null };
}

/* ──────────────────────────────────────── refusals about the request itself */

/**
 * Every key a caller of THIS app might plausibly hand in meaning "sound like
 * this", taken from the vocabulary `server/music-input.js` already uses for
 * MiniMax's external-audio continuation (`reference_id`, `source`,
 * `source.path`, mode `external_audio_continuation`).
 *
 * They are listed rather than pattern-matched because a guess that catches
 * `audioTitle` and refuses a legitimate request is worse than missing one.
 */
const AUDIO_KEYS = [
  "audio", "audioPath", "audio_path", "audioUrl", "reference", "referenceAudio",
  "reference_id", "referenceId", "source", "stems", "voice", "voiceRef", "speaker",
  "continuation", "continueFrom", "prompt_audio", "promptAudio", "melodyAudio",
];

/**
 * REFUSAL — an audio reference was handed in, and there is nowhere to put it.
 *
 * ⚠ THIS IS AN ABSENCE, NOT A SETTING. `SongRequest` (protocol.py:82-88) has
 * exactly seven fields: style, lyrics, cot, seed, abc, cfg_scale, id. There is
 * no eighth. The vendor states the same thing in its own words in
 * `skills/yue2-music/SKILL.md`: "YuE2 exposes no audio-reference,
 * phoneme-alignment, or local-inpainting argument."
 *
 * The expensive version of this failure is not an error — it is a finished song
 * that ignored the reference, which listens like a bad model and is really a
 * silently dropped argument.
 */
export function refuseAudioInput(request = {}) {
  const found = AUDIO_KEYS.filter((k) => request[k] !== undefined && request[k] !== null
    && request[k] !== "" && request[k] !== false);
  const mode = String(request.mode || "");
  if (!found.length && mode !== "external_audio_continuation") return;
  throw new YueRefusal("no-audio-input",
    `YuE2 has no audio-reference argument, so ${found.length ? found.join(", ") : mode} cannot be `
    + `honoured and nothing was started.\n`
    + `Its request has seven fields and no eighth: style, lyrics, cot, seed, abc, cfg_scale, id `
    + `(protocol.py:82-88). The vendor's own skill says it plainly — "YuE2 exposes no `
    + `audio-reference, phoneme-alignment, or local-inpainting argument".\n`
    + `What CAN be handed in is a melody as NOTATION: pass \`abc\` with cot "melody" or "full" and `
    + `the score is retained verbatim (pipeline.py:260-264, which also skips the planning stage `
    + `entirely — measured at 0 s). A reference RECORDING would have to be transcribed to ABC `
    + `first, by something that is not this door.\n`
    + `Refused here rather than dropped silently: a song that ignored your reference sounds like a `
    + `bad model and is really a missing argument.`,
    { keys: found, mode: mode || null });
}

/**
 * Bracketed section labels, the shape a lyric sheet usually arrives in.
 * `[Verse]`, `[Chorus 2]`, `【副歌】` — the CJK brackets included, because a
 * Chinese lyric sheet uses them and PYTHONUTF8 means they now survive the trip.
 */
const SECTION_LABEL_RE = /^\s*(?:\[[^\]\n]{1,40}\]|【[^】\n]{1,40}】|\([Vv]erse[^)\n]{0,20}\)|\([Cc]horus[^)\n]{0,20}\))\s*$/;

/**
 * Section labels in lyrics are ALLOWED — they are YuE2's own lyric format.
 *
 * YuE2 is trained on lyrics structured with [Verse] / [Chorus] / [Bridge]
 * tags: the vendor's example request (skills/yue2-music/assets/prompt.json)
 * and ComfyUI's own "Text to Music (YuE2)" template both write them, and
 * MiniMax Music 3 documents the same tags as its lyric grammar. An earlier
 * version refused them on a single anecdote, which blocked ordinary songs; it
 * is gone. The labels are still reported, never refused, and the old
 * `allowSectionLabels` option is still accepted so older callers keep working.
 */
export function refuseLyrics(lyrics) {
  const text = String(lyrics ?? "");
  const hits = text.split(/\r?\n/).filter((l) => SECTION_LABEL_RE.test(l)).map((l) => l.trim());
  return { labels: hits, allowed: true };
}

/**
 * REFUSAL — an option this door does not have, named rather than dropped.
 *
 * ⚠ THE DEFECT THIS EXISTS FOR WAS FOUND BY `yue_test.js` ON THE WAY IN.
 * `renderSong()` destructures the options it knows, so `renderSong({ style,
 * lyrics, reference_id: "…" })` reached `refuseAudioInput()` with a request
 * object that no longer contained `reference_id` — and the audio refusal, the
 * whole point of which is that a dropped argument must never be silent, dropped
 * it silently. The rest parameter and this function close that: every key the
 * adapter does not recognise is either an audio reference (its own refusal) or
 * named here.
 *
 * `duration` gets its own sentence because it is the option people will reach
 * for first and its absence is structural: length is emergent from the lyrics
 * and the score, which is also why this module's progress denominator has to
 * label itself an assumption.
 */
const LENGTH_KEYS = ["duration", "durationSeconds", "length", "seconds", "bars", "tempo", "bpm"];

/**
 * ⚠ `tags` IS THE VENDOR'S ALIAS FOR `style` AND THIS DOOR TAKES ONE NAME.
 *
 * `_request` (pipeline.py:225-231) accepts either and raises "style and tags are
 * aliases and cannot disagree" when both arrive with different text. Carrying
 * that ambiguity through an adapter, a JSON file and a driver means three places
 * that can each resolve it differently; refusing it is one rename for the caller
 * and one name everywhere afterwards.
 */
const TAGS_SENTENCE =
  "⚠ `tags` is the vendor's ALIAS for `style` (pipeline.py:225-231 raises \"style and tags are "
  + "aliases and cannot disagree\" when both arrive saying different things). This door takes one "
  + "name: rename it to `style`. The genre, instruments, vocal character, language and intended "
  + "tempo all go in that one string.";

export function refuseUnknownOptions(extra = {}) {
  const keys = Object.keys(extra).filter((k) => extra[k] !== undefined);
  if (!keys.length) return;
  const lengths = keys.filter((k) => LENGTH_KEYS.includes(k));
  throw new YueRefusal("unknown-option",
    `renderSong was given ${keys.join(", ")}, which this door has no argument for, so nothing was `
    + `started.\n`
    + (keys.includes("tags") ? `${TAGS_SENTENCE}\n` : "")
    + (lengths.length
      ? `⚠ YuE2 has no duration argument at all. Length is emergent — it comes out of how many `
        + `words the lyrics have and what the planner does with them — so ${lengths.join(", ")} `
        + `cannot be honoured by anything downstream of here. Write shorter or longer lyrics, or `
        + `supply an \`abc\` score of the length you want. Pass \`audioSeconds\` if you only want `
        + `the progress bar to assume a target; it changes nothing about the render.\n`
      : "")
    + `The render takes: style, lyrics, cot, seed, abc, cfg_scale, id (the model's seven), plus `
    + `out, via, actor, project, subject, audioSeconds, allowSectionLabels, budgetGib, `
    + `vaeCoreFrames, backend, overwrite, timeoutMs, onProgress, dryRun.\n`
    + `Refused rather than ignored: an option that is quietly discarded produces a song that did `
    + `not do what you asked and looks like a bad model.`,
    { keys, lengths });
}

/** The seven fields `SongRequest` has, and the only ones the driver forwards. */
export const REQUEST_FIELDS = ["style", "lyrics", "cot", "seed", "abc", "cfg_scale", "id"];
const COT = new Set(["off", "melody", "full"]);
/** protocol.py:97 — `id` becomes a directory name, so it is filename-safe or it
 *  is refused. Copied as a REGEX rather than as a rule, so the two agree. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/;

/**
 * REFUSAL — the request cannot be built, checked here so it costs no interpreter.
 *
 * Each of these raises inside `SongRequest.__post_init__` about 20 s later (a
 * cold `from_pretrained` verifies 7.8 GB of checkpoints first), in a python
 * traceback. The same sentence for free, before anything starts, is the whole
 * point of the refusal block.
 */
export function refuseRequest(request = {}, opts = {}) {
  /* ONE NAME, and the alias refused rather than quietly resolved — see
   * TAGS_SENTENCE. Checked before the missing-style branch below, because
   * `tags` given alone would otherwise be reported as "no style", which is true
   * and unhelpful. */
  if (request.tags !== undefined) {
    throw new YueRefusal("request", `This door has no \`tags\` argument.\n${TAGS_SENTENCE}`);
  }
  const style = request.style;
  /* Empty lyrics are refused here although the vendor accepts them — its check
   * is `is None` (pipeline.py:230), and "" is a string. An instrumental is the
   * one caller that means it, and says so with `allowEmptyLyrics`; the style
   * carries the "no vocals" phrasing in that case, which is the model's only
   * instrumental control. */
  const lyricsOk = typeof request.lyrics === "string" && (request.lyrics.trim() || opts.allowEmptyLyrics);
  if (typeof style !== "string" || !style.trim() || !lyricsOk) {
    throw new YueRefusal("request",
      `YuE2 needs both a style and lyrics, so nothing was started. Its own error for this is `
      + `"Provide style and lyrics" (pipeline.py:230).\n`
      + `style: genre, instruments, vocal character, language and intended tempo, as prose. `
      + `lyrics: the actual words.\n`
      + `⚠ And they are passed as FIELDS, never as an assembled object: \`pipe(style=…, lyrics=…)\` `
      + `builds the SongRequest itself (pipeline.py:378-380 -> _request at :225-231), so handing a `
      + `SongRequest into the style slot raises that same sentence — which cost an hour once.`);
  }
  if (request.cot !== undefined && !COT.has(String(request.cot))) {
    throw new YueRefusal("request",
      `cot must be "off", "melody" or "full" — got ${JSON.stringify(request.cot)}. "full" plans a `
      + `chord-annotated score first and is the default; "melody" plans a melody-only one; "off" `
      + `skips symbolic planning and leaves no editable score behind.`);
  }
  if (request.seed !== undefined
      && (!Number.isInteger(request.seed) || request.seed < 0 || request.seed >= 2 ** 63)) {
    throw new YueRefusal("request", `seed must be an integer in [0, 2^63) — got ${request.seed}.`);
  }
  if (request.cfg_scale !== undefined && request.cfg_scale !== null
      && (!Number.isFinite(request.cfg_scale) || request.cfg_scale < 0 || request.cfg_scale > 20)) {
    throw new YueRefusal("request", `cfg_scale must be finite and in [0,20] — got ${request.cfg_scale}.`);
  }
  if (request.id !== undefined && !ID_RE.test(String(request.id))) {
    throw new YueRefusal("request",
      `id becomes a folder name, so it must match [A-Za-z0-9][A-Za-z0-9_.-]{0,179} — got `
      + `${JSON.stringify(request.id)} (protocol.py:97).`);
  }
  if (request.abc !== undefined && request.abc !== null) {
    if (typeof request.abc !== "string" || !request.abc.trim()) {
      throw new YueRefusal("request", "abc was supplied and is empty; pass the score text or omit it.");
    }
    if (String(request.cot ?? "full") === "off") {
      throw new YueRefusal("request",
        `An external score needs cot "melody" or "full" — "off" skips symbolic planning, so there `
        + `is nothing for the score to be (protocol.py:100).`);
    }
  }
}

/* ─────────────────────────────────────── reading the driver's progress lines */

/**
 * THE TOKEN CAPS, and what they are honestly good for.
 *
 * MEASURED: read from `YuE2-3B/yue2_generation_config.json` on 2026-09-11 —
 * `abc.max_tokens` 4096, `semantic.max_tokens` 9000. `readTokenCaps()` re-reads
 * them from the checkpoint at run time so a different one is honoured; these are
 * the fallback when the file cannot be read.
 *
 * ⚠ A CAP IS A CEILING, NOT A TARGET, and progress.py's own docstring says so in
 * as many words: "An unknown total stays unknown; a generation limit is not a
 * progress target." The measured 167 s track used 4177 of the 9000 semantic
 * tokens, so a bar against the cap tops out around 46% on a normal song. That is
 * why every event derived this way carries `assumed: true` and a basis.
 */
export const TOKEN_CAPS = { abc: 4096, semantic: 9000 };

export async function readTokenCaps(modelDir = YUE.model) {
  try {
    const raw = JSON.parse(await readFile(path.join(modelDir, "yue2_generation_config.json"), "utf8"));
    const abc = Number(raw?.abc?.max_tokens), semantic = Number(raw?.semantic?.max_tokens);
    return {
      abc: Number.isFinite(abc) && abc > 0 ? abc : TOKEN_CAPS.abc,
      semantic: Number.isFinite(semantic) && semantic > 0 ? semantic : TOKEN_CAPS.semantic,
      odeSteps: Number.isFinite(Number(raw?.ode_steps)) ? Number(raw.ode_steps) : null,
      read: true,
    };
  } catch {
    /* Not an error. The caps only shape an assumed denominator, and an assumed
     * denominator that fell back to the measured one is still assumed. */
    return { ...TOKEN_CAPS, odeSteps: null, read: false };
  }
}

/**
 * MEASURED: 4177 semantic output tokens for 167.0387 s of audio = 25.0 tokens
 * per second of finished audio (`run_fixed/result.json`, 2026-09-11).
 *
 * ⚠ IT IS STILL AN ASSUMPTION WHEN USED AS A DENOMINATOR, because YuE2 has no
 * duration argument — length is emergent from the lyrics and the score, so a
 * caller's "I wanted about three minutes" is an intention, not an input.
 */
export const TOKENS_PER_AUDIO_SECOND = 25.0;

/**
 * The nine stage labels `yue2/pipeline.py` can open, mapped to the keys this
 * module reports. Labels, not guesses: taken from the `_status()` call sites at
 * pipeline.py:184, :153, :212, :261, :240 (both AR phases), :300 and :321-:340.
 *
 * `seconds` is the MEASURED wall time each stage took in the 399.6 s run, and is
 * what makes an overall fraction possible at all:
 *   resolve+verify 6.6 | load 0.3 | plan 0 (a score was supplied) |
 *   semantic 281.0 | nar 106.3 | vae 5.7      — all MEASURED, result.json timing
 *
 * ⚠ THEY SUM TO 399.9 s AND THE WALL WAS 406.2 s (6.6 load + 399.6 e2e), so
 * about 6.3 s — tokenisation, prefix building, host/device copies — is
 * unattributed. The overall fraction is therefore an UNDERESTIMATE by up to
 * 1.6%, which is a better failure than a bar that reaches 100% and then waits.
 */
export const STAGES = {
  "Resolving model files":  { key: "resolve", seconds: 6.6 },
  "Verifying model files":  { key: "verify", seconds: 0 },
  "Loading model":          { key: "load", seconds: 0.3 },
  "Using provided score":   { key: "score-supplied", seconds: 0 },
  "Planning score":         { key: "plan", seconds: 0, tokens: "abc" },
  "Generating song":        { key: "semantic", seconds: 281.0, tokens: "semantic" },
  "Synthesizing audio":     { key: "nar", seconds: 106.3 },
  "Loading audio decoder":  { key: "decoder-load", seconds: 0 },
  "Decoding audio":         { key: "vae", seconds: 5.7 },
};
/** Order of appearance, so an overall fraction can count what is behind it. */
export const STAGE_ORDER = ["resolve", "verify", "load", "score-supplied", "plan",
                            "semantic", "nar", "decoder-load", "vae"];
/**
 * ESTIMATED share for the planning stage, which the measured run did not pay:
 * that render supplied a score, so `timing.abc.seconds` is 0.0. The one number
 * anyone here has for it is 111 s, recorded in the prototype's own comment
 * (the prototype renderer's own note: "the score we already paid 111 s to generate") —
 * a DIFFERENT run, hence ESTIMATED here rather than MEASURED.
 */
export const PLAN_SECONDS_ESTIMATED = 111.0;

/**
 * The five prefixes progress.py can print, and what each means.
 * `_STATUSES` (progress.py:19) plus the two live ones.
 */
export const PROGRESS_PREFIXES = {
  "Starting": "starting",
  "Running": "running",
  "Completed": "completed",
  "Failed": "failed",
  "Cancelled": "cancelled",
  "Finished (generation limit reached)": "truncated",
};

/**
 * ⚠ THREE SHAPES, NOT ONE. This regex is the reason this parser works, and a
 * single expression requiring an amount group silently matched NONE of the first
 * kind. Verified against real output on 2026-09-11 by running progress.py with a
 * non-TTY stream (no torch, no card):
 *
 *   1 · no unit, no total, no " | " at all — the whole suffix is the elapsed:
 *         [YuE2] Starting Loading model: elapsed 0.0s
 *   2 · an amount, with or without a total, and a rate only for tokens:
 *         [YuE2] Running Generating song: 4177 tokens | 14.9 tokens/s | elapsed 281.0s
 *         [YuE2] Starting Synthesizing audio: 0 steps | elapsed 0.0s
 *         [YuE2] Running Synthesizing audio: 7/32 steps (22%) | elapsed 12.0s
 *   3 · the final summary, which has NO LABEL before the colon:
 *         [YuE2] Completed: 167.0s audio in 399.6s
 *         [YuE2] Finished (generation limit reached): 167.0s audio in 399.6s
 *
 * The label group is optional and non-greedy so shape 3 leaves it undefined — an
 * absent label is how a summary is told from a finished stage, and both start
 * with the same word.
 */
export const PROGRESS_RE =
  /^\[YuE2\] (Finished \(generation limit reached\)|Starting|Running|Completed|Failed|Cancelled)(?: (.+?))?: (.+)$/;

/** Shape 3's suffix. */
const SUMMARY_RE = /^([\d.]+)s audio in ([\d.]+)s$/;

/**
 * One stderr line -> one event, or null.
 *
 * `null` for everything that is not progress, and that is a load-bearing
 * behaviour rather than a fallthrough: the vendor's `fast.py` prints its own
 * "[YuE2] Flash Attention failed" notices, the driver writes `YUE_EVENT:` lines,
 * and progress.py's heartbeat writes from a THREAD (progress.py:_heartbeat)
 * while the driver writes from the main one — so an interleaved half-line is
 * possible and must be ignored rather than half-parsed.
 */
export function parseProgressLine(line) {
  const m = PROGRESS_RE.exec(String(line).trim());
  if (!m) return null;
  const [, prefix, label, suffix] = m;
  const status = PROGRESS_PREFIXES[prefix];
  if (label === undefined) {
    const s = SUMMARY_RE.exec(suffix);
    if (!s) return null;
    return { kind: "summary", status,
             audioSeconds: Number(s[1]), elapsedSec: Number(s[2]),
             truncated: status === "truncated" };
  }
  const out = { kind: "stage", status, label, stage: STAGES[label]?.key || "other",
                completed: null, total: null, unit: null, rate: null, elapsedSec: null };
  /* ⚠ SPLIT ON " | " FIRST. Shape 1 has no separator at all, so it arrives here
   * as a single part and falls through to the elapsed branch with amount and
   * unit left null — which is exactly right, and is what a regex demanding an
   * amount group could not express. */
  for (const part of suffix.split(" | ").map((p) => p.trim())) {
    let p;
    if ((p = /^(\d+)\/(\d+) (\S+?)(?: \((\d+)%\))?$/.exec(part))) {
      out.completed = Number(p[1]); out.total = Number(p[2]); out.unit = p[3];
    } else if ((p = /^([\d.]+) tokens\/s$/.exec(part))) {
      out.rate = Number(p[1]);
    } else if ((p = /^(\d+) (\S+)$/.exec(part))) {
      out.completed = Number(p[1]); out.unit = p[2];
    } else if ((p = /^(?:elapsed )?([\d.]+)s$/.exec(part))) {
      out.elapsedSec = Number(p[1]);
    }
  }
  return out;
}

/**
 * The denominator for a stage that has none, and the admission that it is one.
 *
 * ⚠ pipeline.py:237 opens BOTH autoregressive stages with `unit="tokens"` and no
 * `total`, so progress.py emits no percentage for the two stages that are 70%
 * and (when it runs) most of the rest of the wall time. `Synthesizing audio` and
 * `Decoding audio` do carry real totals — 32 ODE steps and N VAE chunks — and
 * those are reported as `basis: "reported"` with `assumed: false`.
 *
 * Returns `{ total, basis, assumed, note }`. `total` may be null, which means
 * "no denominator exists" and must be rendered as an indeterminate spinner, not
 * as zero percent.
 */
export function assumedTokenTotal(stageKey, { audioSeconds = null, caps = TOKEN_CAPS } = {}) {
  const wants = stageKey === "semantic" ? "semantic" : stageKey === "plan" ? "abc" : null;
  if (!wants) return { total: null, basis: "none", assumed: false, note: null };
  if (wants === "semantic" && Number.isFinite(audioSeconds) && audioSeconds > 0) {
    return {
      total: Math.round(TOKENS_PER_AUDIO_SECOND * audioSeconds),
      basis: "measured-rate", assumed: true,
      note: `ASSUMPTION: ${TOKENS_PER_AUDIO_SECOND} semantic tokens per second of audio, measured `
        + `once (4177 tokens for 167.0 s), against a length you asked for. YuE2 has no duration `
        + `argument — length comes out of the lyrics and the score — so this bar can finish early `
        + `or overrun.`,
    };
  }
  return {
    total: caps[wants] ?? TOKEN_CAPS[wants], basis: "cap", assumed: true,
    note: `ASSUMPTION: the ${wants} token cap (${caps[wants] ?? TOKEN_CAPS[wants]}) stands in for a `
      + `total the model does not publish. It is a CEILING, not a target — progress.py says "a `
      + `generation limit is not a progress target" — and the measured song used 4177 of 9000, so `
      + `this bar normally stops near half and then completes.`,
  };
}

/**
 * A newline-buffered reader over the driver's stderr.
 *
 * Stateful because progress is: it keeps which stages have finished so an
 * overall fraction can count what is behind the current one, and it remembers a
 * total once a stage discovers one at run time (progress.py's `update(completed,
 * total=…)` path, which is how `Synthesizing audio` learns it has 32 steps).
 */
export function createProgressReader({ audioSeconds = null, caps = TOKEN_CAPS,
                                       onEvent = () => {} } = {}) {
  let buf = "";
  const done = new Set();
  let planRan = false, current = null, summary = null;
  const totals = new Map();

  /** Wall-clock budget of every stage, with the plan stage's ESTIMATED share
   *  added only once it is actually seen. */
  const budget = () => {
    const secondsOf = (key) => key === "plan"
      ? (planRan ? PLAN_SECONDS_ESTIMATED : 0)
      : (Object.values(STAGES).find((s) => s.key === key)?.seconds ?? 0);
    const total = STAGE_ORDER.reduce((a, k) => a + secondsOf(k), 0) || 1;
    return { secondsOf, total };
  };

  function line(raw) {
    const text = String(raw);
    if (text.startsWith(EVENT_MARKER)) {
      /* The driver's own milestones. Parsed defensively: a half-written line
       * from the interleaving described above must not throw here. */
      try {
        const ev = JSON.parse(text.slice(EVENT_MARKER.length));
        onEvent({ kind: "driver", ...ev });
      } catch { /* ignored on purpose — see parseProgressLine's note */ }
      return;
    }
    const ev = parseProgressLine(text);
    if (!ev) return;
    if (ev.kind === "summary") {
      summary = ev;
      onEvent({ ...ev, overall: 1, assumed: false });
      return;
    }
    if (ev.stage === "plan") planRan = true;
    if (ev.total !== null) totals.set(ev.stage, ev.total);
    current = ev.stage;

    /* THE STAGE'S OWN FRACTION. A reported total wins; otherwise an assumption,
     * labelled. A stage with neither (Loading model) has no fraction at all and
     * says so with null rather than with 0 — the difference between "nothing has
     * happened" and "there is nothing to count". */
    const reported = totals.get(ev.stage) ?? null;
    const assumption = reported !== null
      ? { total: reported, basis: "reported", assumed: false, note: null }
      : assumedTokenTotal(ev.stage, { audioSeconds, caps });
    let fraction = null;
    if (assumption.total && ev.completed !== null) {
      fraction = Math.min(1, ev.completed / assumption.total);
    }
    if (ev.status === "completed" || ev.status === "truncated") { fraction = 1; done.add(ev.stage); }

    const { secondsOf, total } = budget();
    const behind = STAGE_ORDER.slice(0, Math.max(0, STAGE_ORDER.indexOf(ev.stage)))
      .reduce((a, k) => a + secondsOf(k), 0);
    const mine = secondsOf(ev.stage);
    const overall = Math.min(1, (behind + mine * (fraction ?? 0)) / total);

    onEvent({
      ...ev,
      total: assumption.total, fraction,
      basis: assumption.basis, assumed: assumption.assumed, note: assumption.note,
      /* ⚠ `overall` is assumed whenever this stage's own fraction was, AND
       * whenever the planning stage ran — its share is the one number here that
       * comes from a different run. */
      overall, overallAssumed: assumption.assumed || planRan,
      etaSeconds: fraction !== null && ev.elapsedSec !== null && fraction > 0.02
        ? Number((ev.elapsedSec * (1 - fraction) / fraction).toFixed(1)) : null,
    });
  }

  return {
    push(chunk) {
      buf += String(chunk);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) line(l);
    },
    /** Flush a trailing partial line. Called when the pipe closes: the last line
     *  a killed python wrote has no newline, and it is often the useful one. */
    end() { const rest = buf; buf = ""; if (rest.trim()) line(rest); },
    line,
    state: () => ({ current, done: [...done], planRan, summary,
                    totals: Object.fromEntries(totals) }),
  };
}

/* ────────────────────────────────────────── the exit-code vocabulary, shared */

/**
 * ⚠ THE THIRD COPY OF EIGHT LINES, WRITTEN AS A FUNCTION SO IT CAN BE THE LAST.
 *
 * `server/mv/blender.js:505` and `server/mesh/runner.js:634` each hold this
 * inline and neither exports it — the decay the header warns about, already one
 * generation in. It is here as a callable, `yue_test.js` pins its regex against
 * both of theirs; the consolidation diff that deletes the other
 * two in favour of this one. Those files belong to other strands tonight.
 *
 * WHAT IT DOES, and the measured reason: a python traceback puts the stack first
 * and the one useful line last, and that last line is genuinely the answer
 * ("torch.OutOfMemoryError: Tried to allocate 3.86 GiB"). Buried under fourteen
 * frames starting at pipeline.py, nobody reads it. Hoisted to the front it IS
 * the error message. The traceback stays underneath for whoever wants it, and
 * everything FROM the exception line to the end is hoisted rather than that one
 * line, because these messages are often several lines of measurements.
 */
export const PY_ERROR_RE = /^[A-Za-z_][\w.]*(?:Error|Exception): \S/;

export function hoistPythonError(detail) {
  const text = String(detail || "").trim();
  const lines = text.split(/\r?\n/);
  const at = lines.findLastIndex((l) => PY_ERROR_RE.test(l));
  return at >= 0 ? `${lines.slice(at).join("\n").trim()}\n\n${text}` : text;
}

/**
 * The driver's exit codes, the same vocabulary the previz toolkit and the mesh
 * driver use so there is one to learn:
 *   0 answered · 2 REFUSED (a rule the python enforces) · 3 the run failed
 *
 * ⚠ EXIT 0 WITH NO RESULT LINE IS NOT A SUCCESS and the headline has to say so.
 * That is the shape of the most expensive failure of this whole strand: a
 * `hasattr` guard on the pipeline instead of on the result silently discarded a
 * finished 35-minute render and exited 0. A "finished without answering"
 * headline sends somebody to the traceback; "completed" sends them to look for a
 * file that was never written.
 */
export function explainExit(code, detail) {
  const d = hoistPythonError(detail);
  return code === 2 ? `The YuE2 runtime refused this render.\n${d}`
    : code === 3 ? `The YuE2 render failed.\n${d}`
    : code === 0 ? `YuE2 finished without answering — it raised instead:\n${d}`
    : `The YuE2 python exited ${code}.\n${d}`;
}

/* ───────────────────────────────────────────────────────── the subprocess */

/** The driver beside this file. `fileURLToPath`, not `new URL().pathname` —
 *  on Windows that yields "/C:/temp/…" and the spawn fails on a path that looks
 *  almost right (server/mesh/runner.js:588 records the same). */
export const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "yue_driver.py");

/**
 * THE FOUR WINDOWS ENVIRONMENT VARIABLES, and why they are set HERE.
 *
 * They must exist BEFORE the interpreter starts, which is the only form in which
 * PYTHONUTF8 is a fix at all — `os.environ["PYTHONUTF8"] = "1"` inside a running
 * python changes nothing about the stdio that was already configured. The defect
 * they close: `yue2/storage.py:28` calls `Path.write_text(json.dumps(…,
 * ensure_ascii=False))` with NO encoding, so on Windows the receipt is written
 * through cp1252 and a CJK lyric raises UnicodeEncodeError AFTER the render.
 *
 * The two HF_HUB ones come from the community node and matter for the same
 * class of reason: without them the hub layer tries to create symlinks in the
 * cache, fails without Developer Mode, and warns on every load.
 */
export const DRIVER_ENV = {
  HF_HUB_DISABLE_SYMLINKS: "1",
  HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

/**
 * Run the driver in venv-yue and read its one answer.
 *
 * ⚠ `spawnFn` AND `killTree` ARE SEAMS, and they exist because of what the mesh
 * suite could NOT test. `server/mesh/runner_test.js` opens by promising "every
 * check here is free — no GPU, no python, no venv" and therefore never drives
 * `runMeshCli()` at all: its timeout, its tree-kill and its exit-code branches
 * have no test. Those are precisely the paths that cost this strand a night
 * (a plain stop left a python rendering and contaminated every timing by
 * 3.3x-10.8x). Injected, they can be proven on any machine in milliseconds with
 * no interpreter; in production the default IS the mesh door's own hardened
 * function, and `yue_test.js` asserts that identity rather than trusting it.
 */
export function runYueDriver(args, {
  timeoutMs = 60 * 60e3, python = YUE.python, driver = DRIVER,
  onStderr = null, spawnFn = spawn, killTree = killMeshProcessTree,
} = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(python, ["-u", driver, ...args], {
        windowsHide: true,
        /* cwd is a scratch directory, not the repo: the vendor package writes
         * `runs/` relative to cwd in some paths, and a library that litters the
         * source tree is how a .gitignore becomes a maintenance task. */
        cwd: os.tmpdir(),
        /* POSIX only, and it is what makes killTree's `process.kill(-pid)`
         * branch legal. Matched to server/mesh/runner.js:594 deliberately. */
        detached: process.platform !== "win32",
        env: { ...process.env, ...DRIVER_ENV,
               AIPLAY_YUE_MODEL: YUE.model, AIPLAY_YUE_VAE: YUE.vae },
      });
    } catch (err) {
      reject(new Error(`Could not start the YuE2 python at ${python}: ${err.message}`));
      return;
    }
    let out = "", err = "", done = false, timedOut = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      timedOut = true;
      /* ⚠ TREE-KILL, NEVER `proc.kill()`. The measured failure: a plain stop
       * left the python child rendering on the card, which read as a slow
       * render rather than a stuck one and multiplied every later timing by
       * 3.3x-10.8x. taskkill /PID /T /F, via the mesh door's function. */
      killTree(proc).then((stopped) => finish(reject, new Error(
        `YuE2 did not finish in ${Math.round(timeoutMs / 1000)}s — `
        + (stopped ? "its owned process tree was stopped."
                   : "process-tree termination could not be confirmed; check for a stray python "
                     + "holding the card before starting anything else."))));
    }, timeoutMs);

    proc.stdout?.on("data", (d) => { out += d; });
    proc.stderr?.on("data", (d) => { err += d; if (onStderr) onStderr(String(d)); });
    proc.on("error", (e) => finish(reject, new Error(
      e.code === "ENOENT"
        ? `The YuE2 python is not at ${python}. Set AIPLAY_YUE_PYTHON to venv-yue's interpreter.`
        : `The YuE2 python failed to start: ${e.message}`)));
    proc.on("close", (code) => {
      if (timedOut) return;
      const marker = out.lastIndexOf(RESULT_MARKER);
      const payload = marker < 0 ? null : jsonAfter(out, marker + RESULT_MARKER.length);
      if (code === 0 && payload) {
        try { return finish(resolve, JSON.parse(payload)); }
        catch { return finish(reject, new Error("YuE2 answered with a result line that is not JSON.")); }
      }
      const detail = (err.trim() || out.split(/\r?\n/).slice(-8).join("\n")).trim();
      finish(reject, Object.assign(new Error(explainExit(code, detail)), { exitCode: code }));
    });
  });
}

/* ──────────────────────────────────── what actually landed on the disk */

/** What `save_artifacts()` writes (pipeline.py:103-118). audio.flac and
 *  result.json are REQUIRED; the rest is what makes a run reproducible. */
export const ARTIFACTS = ["audio.flac", "result.json", "semantic.npy", "latent.npy",
                          "request.json", "config.json", "plan.json", "plan_manifest.json",
                          "abc_tokens.npy", "prefix.npy"];

/**
 * ⚠ A RENDER THAT SUCCEEDED AND WROTE NOTHING IS A FAILURE, and this is the
 * function that says so.
 *
 * The most expensive defect of this whole strand, and it cost 35 minutes of
 * finished audio: `save_artifacts` is a method on the RESULT, not on the
 * pipeline (pipeline.py:103; cli.py:132 calls `result.save_artifacts(dir)`). A
 * `hasattr(pipe, "save_artifacts")` guard was false, the branch was skipped, and
 * the process exited 0 with an empty output directory and a cheerful log.
 *
 * So this checks the DISK, not the receipt's word for it:
 *   · audio.flac exists and is not zero bytes,
 *   · result.json exists, parses, and says status "complete",
 *   · the bytes on disk match the bytes the receipt claims for the same file.
 *
 * Zero bytes is called out separately from missing because they have different
 * causes — a killed VAE decode leaves a 0-byte flac, a skipped save leaves no
 * file — and a person debugging needs to know which one happened.
 */
export async function verifyArtifacts(outDir, { verifyHash = true } = {}) {
  const why = [];
  const audioPath = path.join(outDir, "audio.flac");
  let bytes = null;
  try { bytes = (await stat(audioPath)).size; } catch {
    why.push(`audio.flac is not in ${outDir}. The render reported success and wrote no audio — `
      + `which is what a save_artifacts() call that never happened looks like from out here.`);
  }
  if (bytes === 0) {
    why.push(`audio.flac is zero bytes. The file was created and nothing was written into it, `
      + `which is what an interrupted VAE decode leaves behind.`);
  }
  let receipt = null;
  const receiptPath = path.join(outDir, "result.json");
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (e) {
    why.push(`result.json could not be read from ${outDir} (${e.message}). Without it there is no `
      + `receipt: no timing, no weight hashes, no request identity.`);
  }
  if (receipt && receipt.status !== "complete") {
    why.push(`result.json says status "${receipt.status}", not "complete".`);
  }
  /* THE RECEIPT'S OWN CLAIM, CHECKED AGAINST THE DISK. collect_hashes()
   * (storage.py) hashes every artifact as it is written, so the receipt claims a
   * byte count for audio.flac; the disk is the evidence. They disagree when
   * something truncated the file after the hash — a full drive, most likely. */
  const claimed = receipt?.artifacts?.["audio.flac"] || null;
  if (claimed && bytes !== null && Number(claimed.bytes) !== bytes) {
    why.push(`result.json claims audio.flac is ${claimed.bytes} bytes and the file on disk is `
      + `${bytes}. Something changed or truncated it after the render.`);
  }
  let sha256 = null, sha256Agrees = null;
  if (verifyHash && claimed?.sha256 && bytes) {
    /* ~100 ms for 33 MB against a render measured in minutes. Worth it: this is
     * the only independent check that the audio in the ledger row is the audio
     * on the disk. */
    sha256 = (await sha256File(audioPath))?.replace(/^sha256:/, "") ?? null;
    sha256Agrees = sha256 !== null && sha256 === claimed.sha256;
    if (sha256Agrees === false) {
      why.push(`audio.flac hashes to ${sha256} and the receipt says ${claimed.sha256}.`);
    }
  }
  const present = [];
  try {
    const listed = new Set(await readdir(outDir));
    for (const f of ARTIFACTS) if (listed.has(f)) present.push(f);
  } catch { /* the missing-directory case is already a sentence above */ }
  return {
    ok: !why.length,
    why,
    audio: { path: audioPath, bytes },
    audioSeconds: Number(receipt?.audio_seconds) || null,
    sampleRate: Number(receipt?.sample_rate) || null,
    sha256, sha256Agrees,
    receipt, receiptPath, present,
    missing: ARTIFACTS.filter((f) => !present.includes(f)),
  };
}

/* ───────────────────────────────────────── the licence, in the record */

/** The catalogue's verdict, or null when the row is not there. */
export function catalogueRights() { return cap(YUE_CAP)?.outputRights || null; }

/**
 * ⚠ A SECOND, INDEPENDENT READING OF THE SAME LICENCE FILE — and that is all it
 * is for.
 *
 * This was written from `models/YuE2-3B/LICENSE` on this disk on 2026-09-11,
 * before `server/models.js` was known to carry a `musicYue2` row, and it reached
 * the same verdict by the same route: CC BY-NC's only grant that could cover a
 * generated recording is "for NonCommercial purposes only", and unlike Anima —
 * whose licence explicitly frees the output ("Outputs are not considered
 * Derivatives") — YuE2's never mentions output at all.
 *
 * It is KEPT rather than deleted because two independent readings agreeing is
 * evidence, and `yue_test.js` asserts the agreement: the catalogue row's
 * `licenceFile` must quote the same grant this reading quotes, so the file
 * cannot be misquoted beside the label without that lane failing.
 *
 * ⚠ WHAT CHANGED ON 2026-09-24, and why this is not a softened reading. A human
 * decided (the owner): Studio's LABEL for a YuE2 song now follows the authors'
 * statement of 15 Sep 2026 — sellable by individuals, companies need a
 * commercial licence — and the row says so in `basis: "authors-statement"`.
 * This reading of the FILE is unchanged, and it is still the right answer to
 * "what does the licence file say"; it is no longer the label's source.
 */
export const YUE2_LICENCE_READ = {
  class: "not-for-sale",
  sellable: false,
  quote: "produce, reproduce, and Share Adapted Material for NonCommercial purposes only",
  clause: "CC BY-NC 4.0 §2(a)(1)(b), as carried in models/YuE2-3B/LICENSE",
  url: "https://creativecommons.org/licenses/by-nc/4.0/legalcode.txt",
  note: "Read from the LICENSE shipped beside the weights on 2026-09-11. The vendor's own scope "
    + "paragraph limits the licence to \"the YuE2 checkpoint weights in model.safetensors\" and is "
    + "silent about generated audio; the only grant that could reach a recording is the "
    + "NonCommercial one quoted above. Whether a song is \"Adapted Material\" is not settled by "
    + "the text and has not been settled here — so this is the conservative reading, not a "
    + "verdict. Read §2(a)(1) and decide before you sell anything.",
  attribution: "YuE2 (YuE2-3B, YuE2-Vae) — https://huggingface.co/m-a-p/YuE2-3B. The weight "
    + "licence requires identifying the model and its source repository.",
};

/**
 * THE RIGHTS EVERY YuE2 RECORD CARRIES: the catalogue row (models.js
 * musicYue2 — the authors' statement, with the licence file beside it), and
 * this file's own reading only when there is no row. yue-gguf.js imports this
 * name, so the GGUF door's records and receipts say what the Models card says.
 */
export const YUE2_RIGHTS = catalogueRights() || YUE2_LICENCE_READ;

/* ───────────────────────────────────────── the render, with its record */

/** Sortable and collision-safe; the same shape the engine door's runIds have. */
const newRunId = () => `${Date.now().toString(36)}${createHash("sha1")
  .update(String(Math.random())).digest("hex").slice(0, 6)}`;

/** Everything that must be true before an interpreter starts, cheapest first. */
export async function refuse(request = {}, opts = {}) {
  const { allowSectionLabels = false, extra = null } = opts;
  /* 1 · THE REQUEST. Free, and a usage problem rather than a setup one.
   *     `extra` is whatever the caller handed in that this door does not know —
   *     scanned FIRST, because an audio reference hidden in an unrecognised key
   *     is the failure refuseAudioInput() exists for and the one that used to
   *     get past it (see refuseUnknownOptions). */
  refuseAudioInput({ ...(extra || {}), ...request });
  if (extra) refuseUnknownOptions(extra);
  refuseRequest(request, { allowEmptyLyrics: !!opts.allowEmptyLyrics });
  refuseLyrics(request.lyrics, { allowSectionLabels });
  /* 2 · THE RUNTIME. A stat() per file. */
  const st = await yueStatus();
  if (!st.installed) {
    throw new YueRefusal("runtime",
      `YuE2 is not set up on this machine, so nothing was started.\n`
      + st.why.map((w) => `  - ${w}`).join("\n")
      + `\nThe kit is an interpreter and two checkpoints: venv-yue (python 3.10.6, torch `
      + `2.10.0+cu130, transformers 4.57.6) and about 7.8 GB of weights. Nothing here will install `
      + `either.`,
      { status: st });
  }
  /* 3 · THE CARD. Last of the cheap checks and the valuable one. The reading is
   *     RETURNED as well as judged — paying nvidia-smi twice to answer two
   *     questions about the same instant is how those answers come to disagree. */
  /* ⚠ BY PRESENCE, NOT BY VALUE — `free: null` is a legal reading meaning "no
   * card to read", so it has to survive the hop from here to refuseVram()
   * distinguishable from "nobody passed one". */
  const vram = await refuseVram("free" in opts ? { free: opts.free } : {});
  return { ...st, vram };
}

/**
 * Style and lyrics in, one FLAC and a receipt out, with a ledger row on both
 * sides.
 *
 * ── THE RECORD, WRITTEN BY HAND ───────────────────────────────────────────
 *
 * The engine door builds its record from a graph, which this has none of. So it
 * is assembled here and carries the same things for the same reasons: what ran
 * (the interpreter, the package version, both checkpoints with their measured
 * sha256), what it was asked (every field and the seed), what it cost (the
 * driver's own stage split, because "six and a half minutes" answers a different
 * question from "four and a half of them were one autoregressive stage"), and
 * what came out (the file, its bytes, its hash, its duration).
 *
 * ⚠ THE DELEGATE APPEND IS AWAITED AND HAS NO `.catch()`. A run the ledger
 * refused never started. That inversion is the whole design at the engine door
 * and it is the whole design here.
 */
export async function renderSong({
  style, lyrics, cot = "full", seed = 831001, abc = null, cfg_scale = null, id = "song",
  out, allowSectionLabels = false, audioSeconds = null,
  /* An instrumental: empty lyrics on purpose, with the style saying so. The
   * only caller that may pass it is one that has phrased the style. */
  allowEmptyLyrics = false,
  budgetGib = 16, vaeCoreFrames = 512, backend = "torch-eager", overwrite = false,
  /* ⚠ THESE TWO DEFAULT FROM CONFIG, AND THAT IS THE FIX, NOT A CONVENIENCE.
   * `config.yue.offloadAr` has been `true` since the engine landed and was read
   * by NOTHING: this door did not take the option, the driver had no flag for
   * it, and pipeline.py's own default is False. So every song rendered so far
   * ran with the AR half resident, while the config file said otherwise. A
   * setting nothing consumes is worse than a missing one, because it is
   * believed. See the note on config.js:445. */
  offloadAr = config?.yue?.offloadAr ?? false,
  quantization = config?.yue?.quantization ?? "none",
  /* The attention block for the NAR prefill and solve (nar.py:70). 0 is the
   * package default — the whole sequence in one block, whose temp grows as
   * tokens² and is what OOM'd a 194 s render on 16 GiB. 512 bounds it under
   * 0.9 GiB up to the sampler's own 360 s stop, and is faster. MEASURED
   * 2026-09-11; the table is on the Long rung in yue_fit.js. */
  queryChunk = config?.yue?.queryChunk ?? 0,
  /* The NAR solver's step count. 32 is the vendor's (protocol.py:48). 16 was
   * MEASURED against it on one fixed score and seed (scratchpad narab_verdict,
   * 2026-09-11): correlation 0.9991, residual −27.6 dB relative to programme,
   * every octave band within 0.01 dB — the same render, half the synthesis
   * time. 8 is not (0.980, −14 dB). Anything else is unmeasured. */
  narSteps = config?.yue?.odeSteps ?? 32,
  /* The sampler's stop, in semantic tokens (25 per second). 0 keeps the
   * vendor's 9000 = 360 s. sampling.py:62 refuses prefix + max_tokens past
   * the 24576 context, so the driver clamps to what the plan's prefix leaves
   * — a longer request is an ATTEMPT past the vendor's default, and the
   * ledger records what was asked and what ran. */
  maxTokens = config?.yue?.maxTokens ?? 0,
  /* Continue a finished take: the run folder whose semantic tokens the driver
   * replays, and where the replay stops (seconds; 0 = the whole take). */
  extendFrom = null, fromSeconds = 0,
  /* Continue a RECORDING: a folder holding the codes the real-audio tokenizer
   * read off it (tokenize.js), replayed with no plan (--extend-codes). */
  extendCodes = null,
  artifactReplay = null,
  /* Leave a supplied score OPEN for the planner to continue (--abc-open). */
  abcOpen = false,
  /* The sampler's dials, as objects; null means the vendor's defaults. */
  sampling = null, planSampling = null,
  actor = "system", via = "music.yue", project = null, subject = null,
  timeoutMs = 60 * 60e3, prov = provenance, dryRun = false,
  onProgress = null, runner = runYueDriver,
  /* ⚠ THE REST PARAMETER IS A GUARD, NOT TIDINESS. Without it, an option this
   * door does not know is destructured into nothing and vanishes — which is how
   * `renderSong({ …, reference_id })` reached the audio refusal with the
   * reference already gone. Caught by yue_test.js before this shipped. */
  ...extra
} = {}) {
  const who = normalizeActor(actor);
  if (!out) throw new Error("renderSong needs an output directory.");
  if (!String(via || "").trim()) {
    throw new Error("renderSong needs `via`: a short caller id (mv.song, mcp.yue, api). It is what "
      + "lets the ledger answer which part of the app spent the card.");
  }
  const request = { style, lyrics, cot, seed, abc, cfg_scale, id };
  let replayManifest = null;
  if (artifactReplay) {
    if (extendFrom || extendCodes || abcOpen || sampling || planSampling || quantization !== "none")
      throw new YueRefusal("artifact-replay", "Prepared artifact replay cannot be combined with continuation, open scores, sampler overrides or quantization.");
    replayManifest = await verifyReplayManifest(artifactReplay, {
      runtime: await replayRuntime(YUE.python), weights: await replayModelIdentities(YUE.model, YUE.vae) });
    if (path.resolve(out) === path.resolve(artifactReplay.sourceDir)) throw new YueRefusal("artifact-replay", "Replay requires a fresh output directory; the source is retained.");
    for (const key of ["style", "lyrics", "cot", "abc", "cfg_scale"])
      if ((request[key] ?? null) !== (replayManifest.source.request[key] ?? null)) throw new YueRefusal("artifact-replay", `Replay cannot change frozen ${key}.`);
    if (seed !== replayManifest.options.seed || narSteps !== replayManifest.options.narSteps || vaeCoreFrames !== replayManifest.options.vaeCoreFrames)
      throw new YueRefusal("artifact-replay", "Replay controls differ from the prepared manifest.");
  }
  /* The source of a continuation must be a whole run — checked here, before
   * the ledger row and the python, and named by the file that is missing. */
  if (extendFrom) {
    for (const n of ["result.json", "semantic.npy", "plan.json", "plan_manifest.json", "prefix.npy"]) {
      try { await stat(path.join(extendFrom, n)); }
      catch {
        throw new YueRefusal("extend-source",
          `${extendFrom} has no ${n}, so it is not a finished YuE2 run and cannot be continued.`);
      }
    }
  }
  if (extendCodes) {
    if (extendFrom) throw new YueRefusal("extend-source", "extendFrom and extendCodes are two sources; name one.");
    try { await stat(path.join(extendCodes, "semantic.npy")); }
    catch {
      throw new YueRefusal("extend-source",
        `${extendCodes} has no semantic.npy, so no recording was tokenized there and nothing can be continued.`);
    }
  }

  /* ⚠ WHY A DRY RUN IS NOT REFUSED FOR A BUSY CARD. It spends nothing — no
   * interpreter, no card, no ledger row — so refusing it because something else
   * is rendering withholds the one answer that is free, on exactly the machine
   * where somebody most needs to plan around a busy card. Same call the engine
   * door and the mesh door both make. What it KEEPS is the request checks: a dry
   * run that blessed bracketed lyrics would be a promise the real run breaks. */
  let wouldRefuse = null, vramFree = null;
  if (dryRun) {
    refuseAudioInput({ ...extra, ...request });
    refuseUnknownOptions(extra);
    refuseRequest(request, { allowEmptyLyrics });
    refuseLyrics(lyrics, { allowSectionLabels });
    try { await refuse(request, { allowSectionLabels, extra, allowEmptyLyrics }); }
    catch (e) { wouldRefuse = { code: e.refusal || null, why: e.message }; }
  } else {
    const status = await refuse(request, { allowSectionLabels, extra, allowEmptyLyrics });
    vramFree = status.vram?.free ?? null;
  }

  const caps = await readTokenCaps();
  const runId = newRunId();
  const outDir = path.resolve(out);
  const args = {
    ...request, out: outDir,
    budgetGib: Number(budgetGib) || 16,
    vaeCoreFrames: Number(vaeCoreFrames) || 512,
    offloadAr: !!offloadAr,
    quantization: quantization === "fp8" ? "fp8" : "none",
    queryChunk: Math.max(0, Math.floor(Number(queryChunk) || 0)),
    narSteps: Math.max(1, Math.floor(Number(narSteps) || 32)),
    maxTokens: Math.max(0, Math.floor(Number(maxTokens) || 0)),
    backend: String(backend),
    allowSectionLabels: !!allowSectionLabels,
    extendFrom: extendFrom ? path.resolve(extendFrom) : null,
    extendCodes: extendCodes ? path.resolve(extendCodes) : null,
    artifactReplay: replayManifest ? { ...artifactReplay, sourceIdentity: replayManifest.source.identity,
      sourceRunId: replayManifest.sourceRecord.runId ?? null, runtime: replayManifest.source.runtime } : null,
    fromSeconds: Math.max(0, Number(fromSeconds) || 0),
    abcOpen: !!abcOpen && !!abc && cot !== "off",
    sampling: sampling && typeof sampling === "object" && Object.keys(sampling).length ? sampling : null,
    planSampling: planSampling && typeof planSampling === "object" && Object.keys(planSampling).length ? planSampling : null,
  };
  const record = {
    runId, via, actor: who, appVersion: TOOL,
    model: YUE_MODEL, models: [YUE_MODEL],
    project, subject,
    /* Lyrics are NOT copied into the ledger — they are the user's words and the
     * ledger is append-only. A length and a hash answer "was it this text?"
     * without publishing it, and `request.json` beside the audio has the rest. */
    args: { ...args, lyrics: undefined, style,
            lyricsChars: String(lyrics ?? "").length,
            lyricsSha256: createHash("sha256").update(String(lyrics ?? ""), "utf8").digest("hex"),
            abc: abc ? `supplied, ${String(abc).length} chars` : null },
    seed: Number(seed),
    runtime: {
      python: YUE.python, model: YUE.model, vae: YUE.vae,
      package: "yue2_infer", backend: args.backend,
      memoryBudgetGib: args.budgetGib, vaeCoreFrames: args.vaeCoreFrames,
      /* In the ledger because they change WHICH ARITHMETIC made the song, not
       * merely how fast: fp8 replaces 196 AR linears with 8-bit ones, and the
       * model's authors publish that path as experimental with no quality
       * claim. A song that used it must be identifiable as one that did. */
      offloadAr: args.offloadAr, quantization: args.quantization,
      /* The attention block, because 0 and 512 are different peaks at the same
       * length — and the same arithmetic. A row that says which one ran is
       * what lets a later OOM be compared against it. */
      queryChunk: args.queryChunk,
      /* Both change what the model computed, not only how fast: fewer solver
       * steps is a different ODE solution (measured the same at 16, not at 8),
       * and a raised stop is a song the vendor's default would have cut. */
      narSteps: args.narSteps, maxTokens: args.maxTokens,
      /* ⚠ RECORDED BECAUSE IT IS A REAL DIFFERENCE FROM THE VENDOR'S PIPELINE,
       * not a tuning knob: FLASH is omitted from the sdpa_kernel preference
       * because torch's Windows wheels advertise the op through its ATen schema
       * and then raise, and sampling.py:89 opens a `try` whose only handler is the `finally` at :151 — no `except`, so
       * there is no fallback. The measured run reports execution "eager",
       * attention "sdpa". */
      sdpaBackends: ["EFFICIENT_ATTENTION", "MATH"],
      vramFreeMbBefore: vramFree,
    },
    weights: await Promise.all(weightFiles().map(async (w) => ({
      role: w.role, file: w.file, dest: w.dest,
      declaredBytes: w.bytes,
      bytes: await stat(w.dest).then((s) => s.size, () => null),
      /* The manifest's hash, not a fresh one: re-hashing 7.8 GB on every render
       * would cost more than the VAE stage. The driver verifies it at load
       * time — storage.py:model_identity() — and the receipt carries what it
       * verified, which is the stronger claim anyway. */
      sha256: `sha256:${w.sha256}`,
      sha256Source: `${w.factsFrom}; verified against weights_manifest.json at load`,
    }))),
    /* ⚠ THE RIGHTS VERDICT IS THE CATALOGUE'S WHEN THERE IS A ROW, and this
     * module's own read of the LICENSE only when there is not.
     *
     * `server/models.js`'s `musicYue2` row (the first `not-for-sale` entry in
     * the catalogue until 2026-09-24, the authors' statement since) carries
     * reasoning that runs to a page — where the reach of "for
     * NonCommercial purposes only" sits, why `unknown` would be the wrong answer
     * rather than the modest one, and the YuE v1 route for somebody who needs to
     * sell. That is where every other rights verdict in this app lives and it is
     * not this door's to relitigate; `MODEL_TO_CAPABILITY["yue2"]` already
     * bridges to it, so stampRights() fills the field from the row.
     *
     * `YUE2_LICENCE_READ` stays as an INDEPENDENT read of the same licence file
     * on this disk, and `yue_test.js` fails if the row's `licenceFile` ever
     * quotes it differently — which is the only thing a second reading is good for. */
    ...(catalogueRights() ? {} : {
      /* No row: set it explicitly, because provenance.js:278 fills only an
       * undefined and `unknown` would be a worse answer than the one this file
       * can prove from the text beside the weights. */
      outputRights: { class: YUE2_LICENCE_READ.class, capability: null, url: YUE2_LICENCE_READ.url },
    }),
    rights: catalogueRights() || YUE2_LICENCE_READ,
    rightsSource: catalogueRights()
      ? `server/models.js — ${YUE_CAP}.outputRights`
      : "server/music/yue.js — read from models/YuE2-3B/LICENSE on this disk",
    door: THIRD_DOOR,
  };

  if (dryRun) {
    return { ok: true, dryRun: true, runId, status: "not-run", record, wouldRefuse,
             caps, plan: { outDir } };
  }

  const t0 = Date.now();
  // ⚠ AWAITED. NO .catch(). A throw here means nothing was spent.
  const delegate = await prov.append("library", {
    actor: who, type: "delegate", asset: `song/${runId}`, data: record,
  });

  await mkdir(outDir, { recursive: true });
  /* ⚠ THE REQUEST GOES THROUGH A FILE, NOT THROUGH ARGV. Lyrics contain
   * newlines and, on this rig, CJK; Windows argv quoting mangles both, and the
   * command line has a length limit a three-verse song can reach. Written UTF-8
   * explicitly, for the same reason storage.py:28's missing encoding is a trap. */
  const reqFile = path.join(os.tmpdir(), `aiplay-yue-${runId}.json`);
  const forDriver = {};
  for (const k of REQUEST_FIELDS) if (request[k] !== null && request[k] !== undefined) forDriver[k] = request[k];
  await writeFile(reqFile, JSON.stringify(forDriver, null, 2), "utf8");

  const reader = createProgressReader({
    audioSeconds, caps,
    onEvent: (ev) => { if (onProgress) { try { onProgress(ev); } catch { /* a UI callback
      must not be able to kill a render */ } } },
  });

  let answer, error = null;
  try {
    answer = await runner([
      "--request", reqFile, "--out", outDir,
      "--budget-gib", String(args.budgetGib),
      "--vae-core-frames", String(args.vaeCoreFrames),
      ...(args.offloadAr ? ["--offload-ar"] : []),
      ...(args.quantization === "fp8" ? ["--quantization", "fp8"] : []),
      ...(args.queryChunk ? ["--query-chunk", String(args.queryChunk)] : []),
      ...(args.narSteps !== 32 ? ["--nar-steps", String(args.narSteps)] : []),
      ...(args.maxTokens ? ["--max-tokens", String(args.maxTokens)] : []),
      ...(args.extendFrom ? ["--extend-from", args.extendFrom, "--from-seconds", String(args.fromSeconds)] : []),
      ...(args.extendCodes ? ["--extend-codes", args.extendCodes, "--from-seconds", String(args.fromSeconds)] : []),
      ...(args.artifactReplay ? ["--replay-manifest", args.artifactReplay.manifestPath, "--replay-sha256", args.artifactReplay.manifestSha256,
        "--replay-source", args.artifactReplay.sourceDir, "--replay-stage", args.artifactReplay.stage] : []),
      ...(args.abcOpen ? ["--abc-open"] : []),
      ...(args.sampling ? ["--sampling", JSON.stringify(args.sampling)] : []),
      ...(args.planSampling ? ["--plan-sampling", JSON.stringify(args.planSampling)] : []),
      "--backend", args.backend,
      ...(overwrite ? ["--overwrite"] : []),
    ], { timeoutMs, onStderr: (chunk) => reader.push(chunk) });
  } catch (e) {
    error = e.message;
  }
  reader.end();
  const elapsedSec = (Date.now() - t0) / 1000;

  /* WHAT ACTUALLY LANDED, checked rather than believed — see verifyArtifacts. */
  const landed = error ? { ok: false, why: [error], audio: { path: null, bytes: null },
                           missing: ARTIFACTS, present: [], receipt: null,
                           audioSeconds: null, sha256: null, sha256Agrees: null }
                       : await verifyArtifacts(outDir);
  const status_ = error ? "failed" : landed.ok ? "completed" : "failed";
  const progress = reader.state();

  const data = {
    ...record,
    status: status_,
    error: error || (landed.ok ? null : landed.why.join("; ")),
    elapsedSec: Number(elapsedSec.toFixed(3)),
    /* The driver's own split. MEASURED reference for a reader comparing a row to
     * the known-good run: load 6.6 s warm, ABC 0 s with a score supplied,
     * semantic 281.0 s / 4177 tokens / 14.87 tok/s, NAR 106.3 s, VAE 5.7 s,
     * 399.6 s end to end for 167.0 s of audio — 2.39x realtime. MiniMax on the
     * same card is 1.53x (config.js:398), so YuE2 is ~1.6x slower per second of
     * audio and plans a score nothing else here can edit. */
    timings: answer?.timing || null,
    /* The driver's what-RAN block: prefill peak and tokens, the solver steps,
     * the sampler stop after the clamp and the prefix it was clamped against.
     * Beside `args` (what was ASKED) so one row answers both questions. */
    driver: answer?.driver || null,
    truncated: answer?.truncated || null,
    requestIdentity: answer?.identity || null,
    progress: { stagesSeen: progress.done, planRan: progress.planRan,
                summary: progress.summary || null },
    output: {
      file: "audio.flac", path: landed.audio.path, kind: "audio",
      dir: outDir,
      bytes: landed.audio.bytes,
      sha256: landed.sha256 ? `sha256:${landed.sha256}` : null,
      sha256Agrees: landed.sha256Agrees,
      audioSeconds: landed.audioSeconds,
      sampleRate: landed.sampleRate,
      realtimeRatio: landed.audioSeconds ? Number((elapsedSec / landed.audioSeconds).toFixed(2)) : null,
      artifacts: landed.present,
      missing: landed.missing,
      why: landed.ok ? [] : landed.why,
    },
  };
  const generate = await prov.append("library", {
    actor: who, type: "generate", asset: `song/${runId}`, data,
  }).catch((e) => { console.warn(`  [yue] ${runId}: ledger append failed: ${e.message}`); return null; });

  if (error) { const e = new Error(error); e.runId = runId; throw e; }
  if (!landed.ok) {
    /* ⚠ AND THIS IS THE THROW THAT THE 35-MINUTE LOSS EARNED. Exit 0 plus an
     * empty directory used to be reported as success. */
    const e = new Error(`The YuE2 render reported success and wrote no usable audio:\n`
      + landed.why.map((w) => `  - ${w}`).join("\n"));
    e.runId = runId;
    throw e;
  }
  return {
    ok: true, runId, status: status_, elapsedSec: data.elapsedSec,
    out: landed.audio.path, dir: outDir, bytes: landed.audio.bytes,
    audioSeconds: landed.audioSeconds, sampleRate: landed.sampleRate,
    realtimeRatio: data.output.realtimeRatio,
    truncated: data.truncated,
    prefillPeakGib: answer?.driver?.prefillPeakGib ?? null,
    maxTokensRan: answer?.driver?.maxTokens ?? null,
    // A continuation's receipt: kept / new token counts and where it came from.
    extended: answer?.driver?.extended ?? null,
    artifactReplay: answer?.driver?.artifactReplay ?? null,
    rights: YUE2_RIGHTS,
    record: data, ledger: { delegate, generate },
  };
}

/**
 * The tree-kill, re-exported under this door's name.
 *
 * ⚠ IT IS THE SAME FUNCTION, NOT A COPY, and `yue_test.js` asserts the identity
 * (`killYueProcessTree === killMeshProcessTree`) rather than asserting that two
 * implementations behave alike — which is the assertion that keeps passing while
 * one of them rots.
 */
export const killYueProcessTree = killMeshProcessTree;
