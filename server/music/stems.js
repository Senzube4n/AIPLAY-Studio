/**
 * The vocal stem as a transcription source, 2026-09-17.
 *
 * SheetSage2 reads a whole mix; on a rap it filed the tune under the Ins
 * staff and left Vocal as rests (MEASURED 2026-09-17, aiplay_00095). The
 * separation the Studio already runs (demucs, art.js #separate) puts the
 * voice on its own — so a cover can transcribe THAT, and the melody the
 * planner gets is the one that was sung. This module finds the stem or has
 * it made, through the art queue's own door, and waits for the queue's own
 * "stems" event rather than polling the disk.
 *
 * 2026-09-24 (Tika's report): it also says, BEFORE anything is queued, when
 * the stem separation python cannot run demucs (stemsPreflight), joins a
 * separation of the same song that is already running or waiting instead of
 * queueing a second one, and reads demucs's own progress bars (demucsMeter).
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { config, systemPythonSource } from "../config.js";
import { CATALOG, modulesOf } from "../models.js";

/** Where demucs leaves the vocal stem for a library file. */
export function vocalStemPath(file, { outputDir, model = "htdemucs_ft" }) {
  return stemPath(file, "vocals", { outputDir, model });
}

/** The four stems htdemucs_ft writes, side by side in one folder per song. */
export const STEMS = ["vocals", "drums", "bass", "other"];

/** Where demucs leaves ANY stem for a library file. Reactive cuts on the drum
 *  stem's hits (the way Yvann's workflow detects peaks on "Drums Only"), the
 *  cover path reads the vocal one; same folder, same model. */
export function stemPath(file, stem, { outputDir, model = "htdemucs_ft" }) {
  if (!STEMS.includes(stem)) throw new Error(`No stem called "${stem}". Demucs writes: ${STEMS.join(", ")}.`);
  const base = path.basename(String(file)).replace(/\.(flac|mp3|opus|wav)$/i, "");
  return path.join(outputDir, "stems", model, base, `${stem}.flac`);
}

/* ───────────────────────────────────────────────────────── the preflight */

/** The modules a separation imports, by import name: demucs itself (the
 *  catalogue's needsPackage for "stems", read from there) and the torch it runs
 *  on. The "stems" setup's verify step reads this same list
 *  (server/setup/venv.js). */
export const STEMS_MODULES = [...new Set([...modulesOf(CATALOG.find((c) => c.id === "stems") || { needsPackage: "demucs" }), "torch"])];

/** The words that name the fixes, pinned beside the page's label and button. */
export const STEMS_SETTING_WORDS = 'Settings > Songs > "stem separation python"';
export const STEMS_SETUP_BUTTON = "Set up stem separation";

const PREFLIGHT_TTL_MS = 30_000;
/* A python that did not answer in time is asked again sooner: a cold start
 * behind an antivirus scan is not the same fact as "demucs is not there". */
const TIMEOUT_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 10_000;
const preflightCache = new Map();   // python -> { at, got }
/* Bumped by every clearStemsPreflight(): "the stems python may have changed".
 * The art queue ties what it learned about a python this session (a card its
 * PyTorch cannot run) to the epoch it was learned in, so a setup that rebuilt
 * the venv IN PLACE (same path, a new PyTorch) is not held to the old verdict. */
let stemsEpoch = 0;

/** Forget every cached answer. Call it after the stems python changes or a
 *  "stems" setup finishes, so the next door asks again. */
export function clearStemsPreflight() { preflightCache.clear(); stemsEpoch++; }
/** How many times the stems python may have changed this session. */
export const stemsPythonEpoch = () => stemsEpoch;

/** The pip line a person pastes, aimed at THIS interpreter (quoted: a path
 *  with spaces is the common case under C:\Users). */
export const stemsPipLine = (py) => `"${py}" -m pip install demucs`;

/* ─────────────────────────────────────────────────────────────── ffmpeg */

/** The PATH key of an environment as it is spelled there ("Path" on Windows). */
const pathKey = (env) => Object.keys(env || {}).find((k) => k.toUpperCase() === "PATH") || "PATH";

/**
 * The `ffmpeg` demucs would run, or null. demucs 4.1 writes FLAC through the
 * program named plain "ffmpeg" (demucs/audio.py encode_ffmpeg, read from the
 * installed 4.1.0 on 2026-09-24), and Studio always asks for --flac. Studio
 * itself finds ffmpeg through AIPLAY_FFMPEG, then PATH (clipjoin.js
 * ffmpegPath); demucsEnv() below puts an AIPLAY_FFMPEG folder on the child's
 * PATH, so either one counts here.
 */
export function findFfmpeg({ env = process.env, platform = process.platform } = {}) {
  const exe = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const named = env.AIPLAY_FFMPEG;
  if (named && path.isAbsolute(named) && path.basename(named).toLowerCase() === exe && existsSync(named)) return named;
  for (const raw of String(env[pathKey(env)] || "").split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The environment demucs runs in: Studio's own, with the folder of an
 * AIPLAY_FFMPEG that names an ffmpeg put first on PATH, so demucs's plain
 * "ffmpeg" finds the one Studio was told about. Null when nothing changes (the
 * child then inherits Studio's environment as before).
 */
export function demucsEnv({ env = process.env, platform = process.platform } = {}) {
  const named = env.AIPLAY_FFMPEG;
  const exe = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  if (!named || !path.isAbsolute(named) || path.basename(named).toLowerCase() !== exe) return null;
  const key = pathKey(env);
  return { ...env, [key]: [path.dirname(named), env[key]].filter(Boolean).join(path.delimiter) };
}

/** demucs from 4.1 on writes FLAC through ffmpeg; 4.0 wrote it through torchaudio. */
export function demucsNeedsFfmpeg(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ""));
  return !!m && (Number(m[1]) > 4 || (Number(m[1]) === 4 && Number(m[2]) >= 1));
}

/* The default probe: which modules import (find_spec, as index.js probeOne
 * does) and demucs's installed version, in one start of the interpreter.
 * Carried base64 so no argv quoting rule can touch the newlines. */
const probeScript = (mods) => [
  "import importlib.util as u, json",
  `m = {k: u.find_spec(k) is not None for k in ${JSON.stringify(mods)}}`,
  "v = None",
  "try:",
  "    import importlib.metadata as md",
  "    v = md.version('demucs') if m.get('demucs') else None",
  "except Exception:",
  "    v = None",
  "print(json.dumps({'m': m, 'v': v}))",
].join("\n");

/**
 * { file, modules, versions } for one interpreter. `file` is false when there
 * is nothing to run at that path (an absolute path with no file is answered
 * without spawning anything); a bare name ("python") is left to the spawn, and
 * a spawn that fails or prints no answer reads as no python. A probe slower
 * than PROBE_TIMEOUT_MS reads as "modules missing", marked timedOut.
 */
function probeModules(py, mods) {
  return new Promise((resolve) => {
    let proc;
    try {
      const code = Buffer.from(probeScript(mods)).toString("base64");
      proc = spawn(py, ["-c", `import base64;exec(base64.b64decode('${code}').decode())`], { windowsHide: true });
    } catch { return resolve({ file: false, modules: {} }); }
    let out = "", settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish({ file: true, modules: {}, timedOut: true }); }, PROBE_TIMEOUT_MS);
    proc.stdout?.on("data", (d) => { out += d; });
    proc.stderr?.resume?.();
    proc.on("error", () => finish({ file: false, modules: {} }));
    proc.on("close", () => {
      try {
        const got = JSON.parse(out.trim().split(/\r?\n/).pop() || "");
        finish({ file: true, modules: got.m || {}, versions: { demucs: got.v || null } });
      } catch { finish({ file: false, modules: {} }); }   // no JSON: not a python (the Store alias prints a sentence)
    });
  });
}

async function probeStemsPython(py, probe) {
  if (!py) return { file: false, modules: {} };
  if (path.isAbsolute(py) && !existsSync(py)) return { file: false, modules: {} };
  const got = await Promise.resolve(probe(py, STEMS_MODULES)).catch(() => null);
  if (!got || typeof got !== "object") return { file: true, modules: {} };
  /* A test's probe answers { module: bool } like index.js probeOne; the
   * default one answers { file, modules, versions, timedOut? }. Both are read here. */
  return "modules" in got
    ? { file: got.file !== false, modules: got.modules || {}, versions: got.versions || {}, ...(got.timedOut ? { timedOut: true } : {}) }
    : { file: true, modules: got, versions: {} };
}

/**
 * Can this machine separate stems at all? Asked by every door that makes a
 * stem (through ensureStem) and by /api/stems before it queues anything.
 *
 *   { ok: true, python }
 *   { ok: false, status: 409, error, python, missing, reason, setup?, pip? }
 *
 * The answer for each interpreter is kept 30 s, a refusal included, so a page
 * repainting on every tick does not start a python each time (5 s for a
 * python that did not answer in time). A missing file is answered without
 * spawning anything, in well under a second.
 *
 * Beyond the three reasons the doors were promised, one more: demucs 4.1 or
 * later with no ffmpeg to be found ("stems-ffmpeg-missing"). It writes its
 * FLAC files through ffmpeg, AFTER all four models have run, so without this a
 * separation spent minutes and then failed. It carries no `setup`: the stems
 * setup does not install ffmpeg. `ffmpeg` finds it (findFfmpeg by default).
 */
export async function stemsPreflight({ python = config.systemPython, source = systemPythonSource(), probe = probeModules, ffmpeg = findFfmpeg } = {}) {
  const py = String(python || "");
  const hit = preflightCache.get(py);
  let got;
  if (hit && Date.now() - hit.at < (hit.got.timedOut ? TIMEOUT_TTL_MS : PREFLIGHT_TTL_MS)) got = hit.got;
  else {
    got = await probeStemsPython(py, probe);
    preflightCache.set(py, { at: Date.now(), got });
  }
  const missing = !got.file ? ["python"] : STEMS_MODULES.filter((m) => got.modules?.[m] !== true);
  if (!missing.length) {
    const v = got.versions?.demucs;
    if (demucsNeedsFfmpeg(v) && !(await Promise.resolve().then(() => ffmpeg()).catch(() => null))) {
      return {
        ok: false, status: 409, python: py, missing: ["ffmpeg"], reason: "stems-ffmpeg-missing",
        error: "Stem separation needs ffmpeg, and none was found on PATH or in AIPLAY_FFMPEG."
          + ` demucs ${v} (in ${py}) writes its FLAC files with ffmpeg, which Studio does not install: put ffmpeg on PATH, or name it in AIPLAY_FFMPEG, then start Studio again.`,
      };
    }
    return { ok: true, python: py };
  }
  const env = source === "env";
  const pip = stemsPipLine(py);
  /* C1: a probe slower than 10 s counts as missing. Its sentence says what is
   * known (no answer), not that demucs is absent. */
  const [reason, first] = !got.file
    ? ["stems-python-missing", `Stem separation needs a Python with demucs. None was found at ${py}.`]
    : got.timedOut
      ? ["stems-demucs-missing", `Stem separation needs demucs, and ${py} did not answer within ${PROBE_TIMEOUT_MS / 1000} s, so Studio could not check for it.`]
      : missing.includes("demucs")
        ? ["stems-demucs-missing", `Stem separation needs demucs, and ${py} does not have it.`]
        : ["stems-torch-missing", `Stem separation needs PyTorch, and ${py} does not have it.`];
  const second = env
    ? ` AIPLAY_SYS_PYTHON names this python, so a Python Studio builds would not be used: install demucs there (${pip}), or remove the variable and start Studio again.`
    : ` Press "${STEMS_SETUP_BUTTON}", or name your own Python in ${STEMS_SETTING_WORDS}.`;
  return {
    ok: false, status: 409, error: first + second, python: py, missing, reason,
    ...(got.timedOut ? { timedOut: true } : {}),
    ...(env ? {} : { setup: "stems" }),
    ...(got.file ? { pip } : {}),
  };
}

/** A separation that cannot start on this machine, as an Error the doors
 *  relay field by field ({ error, setup, pip, python, reason } with 409). */
export class StemsRefusal extends Error {
  constructor(verdict = {}) {
    super(verdict.error || "Stem separation cannot run on this machine.");
    this.name = "StemsRefusal";
    this.status = verdict.status || 409;
    for (const k of ["python", "missing", "reason", "setup", "pip"]) {
      if (verdict[k] !== undefined) this[k] = verdict[k];
    }
  }
}

/* ────────────────────────────────────────────────────────────── the wait */

/**
 * The vocal stem's path — made first when it is not on disk. `art` is the
 * ArtRunner (request + "stems" events); `timeoutMs` bounds the wait.
 * Rejects by sentence when the queue refuses or the separation fails.
 */
export async function ensureVocalStem(file, opts = {}) {
  return ensureStem(file, "vocals", opts);
}

/**
 * Any stem's path — made first when it is not on disk. One separation writes
 * all four, so asking for the drums after the vocals costs nothing.
 *
 * ⚠ THE ACTOR DEFAULTS TO `system` AND MUST NOT GO BACK TO `user`. The ledger's
 * rule is that anything unattributable records `system` and never `user`: a
 * caller that forgot to say who it is has not become the person at the
 * keyboard, and a fabricated human edit promotes an asset's origin class from
 * ai-generated to ai-assisted-human-edited. Every door in server/index.js
 * already passes `prov.actorFrom(req)`, so this default only ever catches a
 * caller that named nobody — which is exactly the case it must not flatter.
 *
 * Before queueing, `preflight` (stemsPreflight) asks whether the stems python
 * can run demucs at all; when it cannot, this throws a StemsRefusal at once
 * rather than queueing a job that fails. A separation of the same song that is
 * already running or waiting is JOINED, never queued twice (Tika's report: a
 * Transcribe with "Voice only", a Create "Start from its voice" and the row's
 * "Separate stems" each queued their own).
 */
export async function ensureStem(file, stem, { art, outputDir, model = "htdemucs_ft", actor = "system", timeoutMs = 900_000, preflight = stemsPreflight } = {}) {
  const target = stemPath(file, stem, { outputDir, model });
  if (await stat(target).then((s) => s.isFile()).catch(() => false)) return { path: target, made: false };
  const name = path.basename(String(file));
  const ready = await preflight();
  if (!ready?.ok) throw new StemsRefusal(ready || {});
  const stopped = () => Object.assign(new Error(`the separation of ${name} was stopped before it finished`),
    { status: 409, reason: "stems-cancelled", cancelled: true });
  /* ⚠ A FAILED SEPARATION USED TO BE WAITED OUT. Only the success event was
   * heard; the art queue announces a failure as "failed", and a job the Stop
   * button dropped announces nothing, so either held the caller (a remix's
   * transcription) for the whole fifteen minutes. Now the failure ends the
   * wait with its own reason, and so does the job leaving the queue unfinished. */
  let job = null, end = null;
  const waited = new Promise((resolve, reject) => {
    let watch = null;
    const done = (err) => {
      clearTimeout(timer); clearInterval(watch);
      art.off("stems", onStems); art.off("failed", onFailed);
      if (err) reject(err); else resolve();
    };
    end = done;
    const timer = setTimeout(() => done(new Error(`the separation of ${name} did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    function onStems(ev) {
      if (ev?.file !== name) return;
      done(ev.stems?.length ? null : new Error(`the separation of ${name} produced no stems — see the console`));
    }
    function onFailed(ev) {
      if (ev?.file !== name || ev?.kind !== "stems") return;
      if (ev.cancelled) return done(stopped());
      done(new Error(`the separation of ${name} failed: ${ev.error || "no reason given"}`));
    }
    art.on("stems", onStems);
    art.on("failed", onFailed);
    watch = setInterval(() => {
      if (!job || art.current === job || (art.queue || []).includes(job)) return;
      if (job.cancelled) return done(stopped());
      if (job.error) return done(new Error(`the separation of ${name} failed: ${job.error}`));
      if (!job.stems) done(stopped());
    }, 2000);
  });
  /* Join first: a separation of this song already running or waiting is the
   * one this caller needs. `findJob` is typeof-guarded because older fakes (and
   * any runner without it) only have request(). */
  job = (typeof art.findJob === "function" ? art.findJob(name, "stems") : null)
    || art.request({ file: name, kind: "stems", force: true, actor })
    || art.lastRefusalJob
    || null;
  if (!job) {
    /* The listeners and the fifteen-minute timer go with the refusal; left
     * behind, they held the process open and heard strangers' events. */
    const refused = new Error(`the art queue refused to separate ${name}${art.lastRefusal ? `: ${art.lastRefusal}` : ""}`);
    end(refused);
    await waited.catch(() => {});
    throw refused;
  }
  await waited;
  if (!(await stat(target).then((s) => s.isFile()).catch(() => false))) {
    throw new Error(`the separation finished but ${target} is not there`);
  }
  return { path: target, made: true };
}

/* ───────────────────────────────────────────────────────────── progress */

/** How many progress bars demucs draws per track: a bag of models runs each
 *  one over the whole track in turn (htdemucs_ft is four fine-tuned models).
 *  demucs also says so on stdout ("Selected model is a bag of 4 models"), and
 *  that line wins when it is seen. */
export const BAG_SIZES = { htdemucs_ft: 4, mdx: 4, mdx_extra: 4, mdx_q: 4, mdx_extra_q: 4 };

/** The separation weights' size, from the catalogue's "stems" row (one source). */
export const STEMS_WEIGHTS_BYTES = CATALOG.find((c) => c.id === "stems")?.approxBytes || 0;

const PCT_RE = /(\d{1,3})%\|/;
const BAG_RE = /bag of (\d+) models/i;

/**
 * Reads demucs's own output into { progress, note } for the Jobs row.
 *
 * demucs draws one tqdm bar per model with unit "seconds" (of audio) on
 * stderr, redrawn after a carriage return. Overall = ((bar-1) + pct)/bars; a
 * bar starts when the percentage falls. The first run also fetches the weights:
 * torch.hub prints "Downloading: …" and a byte-sized bar (no "seconds"), and
 * that is said as its own note rather than read as separation progress.
 *
 * feed(text, stream) takes stderr or stdout chunks as they come (a line split
 * across two chunks is held until its end arrives, one held line PER STREAM:
 * a stdout chunk landing between two halves of a stderr bar must not splice
 * into it, or "\r 2" + "5%" would read as 5% and count as the next model) and
 * answers the new state, or null when nothing changed.
 */
export function demucsMeter({ model = "htdemucs_ft", weightsBytes = STEMS_WEIGHTS_BYTES } = {}) {
  let bars = BAG_SIZES[model] || 1, bar = 0, last = -1, progress = 0, note = null;
  const partials = new Map();   // stream -> the line not yet ended
  const fetching = `fetching the separation model${weightsBytes ? `, ${Math.round(weightsBytes / 1e6)} MB` : ""}, first run only`;
  const read = (line) => {
    const bag = BAG_RE.exec(line);
    if (bag) { bars = Math.max(1, Number(bag[1]) || bars); return true; }
    if (/^\s*Downloading\b/i.test(line)) { const was = note; note = fetching; return was !== note; }
    const m = PCT_RE.exec(line);
    if (!m) return false;
    if (!/seconds/i.test(line)) { const was = note; note = fetching; return was !== note; }   // a byte bar: the download
    const p = Math.min(100, Number(m[1]));
    if (bar === 0) bar = 1;
    else if (p < last) bar = Math.min(bar + 1, bars);
    last = p;
    const before = [progress, note];
    progress = Math.max(progress, Math.min(1, ((bar - 1) + p / 100) / bars));
    note = bars > 1 ? `model ${bar} of ${bars}` : null;
    return before[0] !== progress || before[1] !== note;
  };
  return {
    feed(chunk, stream = "stderr") {
      const text = (partials.get(stream) || "") + String(chunk ?? "");
      const parts = text.split(/\r\n|\r|\n/);
      let partial = parts.pop() ?? "";
      if (partial.length > 4096) partial = partial.slice(-4096);
      partials.set(stream, partial);
      let changed = false;
      for (const line of parts) changed = read(line) || changed;
      /* The bar being redrawn has no line end yet. tqdm closes every redraw
       * with "]", so it is read once that is there (half a bar would lack its
       * "seconds" unit and pass for a download); reading it twice changes nothing. */
      if (PCT_RE.test(partial) && /\]\s*$/.test(partial)) changed = read(partial) || changed;
      return changed ? { progress, note } : null;
    },
    get progress() { return progress; },
    get note() { return note; },
    get bars() { return bars; },
  };
}
