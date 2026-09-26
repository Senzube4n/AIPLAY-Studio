/**
 * Whisper as a tool anything in Studio can call: POST/GET /api/whisper, and
 * through it the whisper_transcribe and whisper_status MCP tools.
 *
 * Timed lyrics were the only way in: a library song, its own lyrics, two LRC
 * files. An agent that needs the words of a clip, the lyrics of a song nobody
 * wrote down, or the timing of lyrics it was handed had no door. This is that
 * door, and it adds no second whisper:
 *
 *   - the SAME python (config.lyrics.python) and the same model
 *     (config.lyrics.model), so one Set up timed lyrics serves both;
 *   - the SAME runner (server/lrc.js runLrc over server/whisper.py, which
 *     imports lrc.py's device logic), so the failures read the same;
 *   - the SAME queue (art.js, kind "whisper", a program of its own like
 *     "lrc"): it waits for music, never runs beside a picture, clip or
 *     separation, and Stop kills its tree.
 *
 * WHAT IT MAY READ. A library song by file name, a clip or an imported file by
 * its name in the clips folder (/api/studio/import lands there), or a path
 * that resolves, symlinks followed, inside Studio's output folder. Nothing
 * else: a path is a way to name a stem or a render that has no library name,
 * never a way to read the rest of the disk. Every POST is same-origin local
 * JSON only (sameOriginLocalJson, the guard of the other doors that run a
 * program), so another web page cannot queue work or choose the model.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WHISPER_MODELS } from "./config.js";
import { whisperPythonMissing, pythonVerdict, installLines } from "./lrc.js";
import { actorFrom } from "./provenance.js";

/** What whisper.py (ffmpeg underneath) is handed. Pictures are not. */
export const WHISPER_AUDIO = /\.(flac|mp3|opus|wav|ogg|m4a|aac)$/i;
export const WHISPER_MEDIA = /\.(flac|mp3|opus|wav|ogg|m4a|aac|mp4|webm|mov|mkv|m4v)$/i;
/** Whisper's language codes are two letters, three for a few ("haw", "yue"). */
const LANGUAGE_RE = /^[a-z]{2,3}$/;
export const MAX_LYRICS = 20_000;

const badName = (s) => !s || s.includes("..") || s.includes("/") || s.includes("\\") || /[\r\n\0]/.test(s);

/**
 * The body of {action:"transcribe"} → { spec } or { error }. Checks shape only;
 * resolveWhisperInput() checks the disk.
 */
export function parseWhisperRequest(b = {}) {
  const named = ["file", "clip", "path"].filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== "");
  if (named.length !== 1) {
    return { error: "Name exactly one of file (a library song), clip (a clip or imported file) or path (a file inside Studio's output folder)." };
  }
  const by = named[0];
  const value = b[by];
  if (typeof value !== "string" || value.length > 1024) return { error: `${by} must be a name or path of up to 1024 characters.` };
  if (by !== "path" && badName(value)) return { error: `Bad ${by} name: ${JSON.stringify(value)}.` };
  if (b.lyrics !== undefined && b.lyrics !== null && typeof b.lyrics !== "string") return { error: "lyrics must be text." };
  const lyrics = String(b.lyrics || "").trim();
  if (lyrics.length > MAX_LYRICS) return { error: `lyrics are limited to ${MAX_LYRICS} characters.` };
  let language = b.language === undefined || b.language === null ? "" : String(b.language).trim().toLowerCase();
  if (language === "auto") language = "";
  if (language && !LANGUAGE_RE.test(language)) return { error: "language must be a whisper language code such as en, de or ja, or auto." };
  for (const k of ["words", "writeLrc", "vocals"]) {
    if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "boolean") return { error: `${k} must be true or false.` };
  }
  return {
    spec: {
      by, value, lyrics: lyrics || null, language: language || null,
      words: b.words === true, writeLrc: b.writeLrc === true,
      /* null: the timed-lyrics setting decides (config.lyrics.useVocalStem). */
      vocals: typeof b.vocals === "boolean" ? b.vocals : null,
    },
  };
}

/** Is `child` inside `root` (both already real paths)? */
export function insideFolder(root, child, p = path) {
  const rel = p.relative(root, child);
  return !!rel && !rel.startsWith("..") && !p.isAbsolute(rel);
}

async function isFile(f) {
  try { return (await stat(f)).isFile(); } catch { return false; }
}

/**
 * The spec → the file whisper.py reads, a stem for its LRC files, the vocal
 * stem when one is used, and a title. → { input, name, lrcBase, vocals, title }
 * or { error, status }. `dirs` = { outputDir, clipDir, stemsModel, useVocalStem }.
 */
export async function resolveWhisperInput(spec, dirs) {
  const { outputDir, clipDir, stemsModel = "htdemucs_ft", useVocalStem = true } = dirs;
  let input, name, lrcBase, vocals = null;
  if (spec.by === "file") {
    if (!WHISPER_AUDIO.test(spec.value)) return { error: `${spec.value} is not a library song (flac, mp3, opus or wav).`, status: 400 };
    input = path.join(outputDir, spec.value);
    name = spec.value;
    lrcBase = spec.value.replace(WHISPER_MEDIA, "");
    /* A clean vocal transcribes better than a mix, the reason timed lyrics use
     * it: the song's separated vocal when one exists, never separated for this. */
    const want = spec.vocals ?? useVocalStem;
    const stem = path.join(outputDir, "stems", stemsModel, lrcBase, "vocals.flac");
    if (want && await isFile(stem)) vocals = stem;
  } else if (spec.by === "clip") {
    if (!WHISPER_MEDIA.test(spec.value)) return { error: `${spec.value} is not audio or video.`, status: 400 };
    input = path.join(clipDir, spec.value);
    name = spec.value;
    lrcBase = spec.value.replace(WHISPER_MEDIA, "");
  } else {
    const raw = spec.value.trim().replace(/^"(.*)"$/, "$1").trim();
    /* \\server\share and \\?\ are absolute to path.win32: another machine's
     * file, or a device. Only this disk, only Studio's own folder. */
    if (/^[\\/]{2}/.test(raw) || !path.isAbsolute(raw) || /[\r\n\0]/.test(raw)) {
      return { error: "path must be the full path of a file inside Studio's output folder.", status: 400 };
    }
    if (!WHISPER_MEDIA.test(raw)) return { error: `${path.basename(raw)} is not audio or video.`, status: 400 };
    let real, root;
    try { real = await realpath(raw); } catch { return { error: `There is no file at ${raw}.`, status: 404 }; }
    try { root = await realpath(outputDir); } catch { root = path.resolve(outputDir); }
    if (!insideFolder(root, real)) {
      return { error: `Only files inside Studio's output folder (${root}) can be transcribed by path.`, status: 403 };
    }
    input = real;
    name = path.basename(real);
    /* The folders it sits in are part of its name here: every separated song
     * has a vocals.flac, and they must not write over each other's LRC. */
    lrcBase = path.relative(root, real).replace(WHISPER_MEDIA, "").replace(/[\\/]+/g, "_");
  }
  if (!await isFile(input)) return { error: `There is no file ${name}.`, status: 404 };
  /* Characters no Windows file name may hold become "_"; letters in any
   * script stay, as they do in the song's own file name. */
  return { input, name, lrcBase: lrcBase.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").slice(0, 160) || "whisper", vocals, title: `Transcribe ${name}` };
}

/** Where the runner's job for this id is: running, queued, finished or gone. */
export function whisperJob(art, id) {
  const mine = (j) => j && j.id === id && j.kind === "whisper";
  if (mine(art.current)) return { state: "running", job: art.current };
  const at = (art.queue || []).findIndex(mine);
  if (at >= 0) return { state: "queued", position: at + 1, job: art.queue[at] };
  const done = (art.done || []).find(mine);
  if (!done) return { state: "missing", job: null };
  if (done.error) return { state: done.cancelled ? "stopped" : "failed", job: done };
  return { state: "done", job: done };
}

/** A job as the door reports it: never the internals, the result when there is one. */
export function jobAnswer(id, found) {
  const j = found.job;
  return {
    id, state: found.state,
    ...(found.position ? { position: found.position } : {}),
    ...(j ? { title: j.title || null } : {}),
    ...(j?.error ? { error: String(j.error) } : {}),
    ...(found.state === "done" ? { result: j.transcript || null } : {}),
  };
}

/**
 * The /api/whisper door. index.js mounts it the way it mounts the prompt tools.
 * `probe(py, modules)` is index.js's probeOne; `modules` its LYRICS_MODULES.
 */
export function createWhisperRoutes({ json, readBody, sameOriginLocalJson, art, config, probe, modules, savePrefs, lrcDir, clipDir }) {
  async function status() {
    const py = config.lyrics.python;
    const got = whisperPythonMissing(py) ? {} : await probe(py, modules).catch(() => ({}));
    const v = pythonVerdict({ python: py, chosen: config.lyrics.whisperPython, modules: Object.fromEntries(modules.map((m) => [m, !!got[m]])) });
    const mine = [art.current, ...(art.queue || [])].filter((j) => j?.kind === "whisper");
    return {
      ...v,
      ...(v.ready ? {} : { install: installLines(py), ...(process.env.AIPLAY_WHISPER_PYTHON ? {} : { setup: "lyrics" }) }),
      model: config.lyrics.model,
      models: WHISPER_MODELS,
      device: String(process.env.AIPLAY_WHISPER_DEVICE || "auto").trim().toLowerCase(),
      jobs: mine.map((j) => ({ id: j.id, title: j.title, state: j === art.current ? "running" : "queued" })),
    };
  }

  return async function routes(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/whisper") return false;
    if (req.method === "GET") {
      const id = url.searchParams.get("job");
      if (id) {
        const found = whisperJob(art, id);
        if (found.state === "missing") {
          return json(res, 404, { error: `No whisper job ${id}: not running, not queued and not among the finished jobs (Studio may have restarted).` }), true;
        }
        return json(res, 200, { ok: true, job: jobAnswer(id, found) }), true;
      }
      return json(res, 200, { ok: true, whisper: await status() }), true;
    }
    if (req.method !== "POST") return json(res, 405, { error: "GET or POST." }), true;
    /* Every action runs a program or changes a setting: Studio's page and
     * local clients (MCP) only, the same guard as choosing the python. */
    if (!sameOriginLocalJson(req)) {
      return json(res, 403, { error: "Whisper requires a same-origin local JSON request." }), true;
    }
    const b = (await readBody(req)) || {};
    if (b.action === "status") return json(res, 200, { ok: true, whisper: await status() }), true;
    if (b.action === "model") {
      if (b.value !== undefined) {
        if (!WHISPER_MODELS.includes(b.value)) {
          return json(res, 400, { error: `The whisper model must be one of ${WHISPER_MODELS.join(", ")}.` }), true;
        }
        /* Read at every spawn (art.js), so the next job uses it: no restart. */
        config.lyrics.model = b.value;
        await savePrefs();
      }
      return json(res, 200, { ok: true, whisper: await status() }), true;
    }
    if (b.action === "transcribe") {
      const parsed = parseWhisperRequest(b);
      if (parsed.error) return json(res, 400, { error: parsed.error }), true;
      const spec = parsed.spec;
      const at = await resolveWhisperInput(spec, {
        outputDir: config.outputDir, clipDir,
        stemsModel: config.stems?.model, useVocalStem: config.lyrics.useVocalStem !== false,
      });
      if (at.error) return json(res, at.status || 400, { error: at.error }), true;
      /* Refused here, where the caller can act on it, rather than queued to
       * die: the same sentence and setup id as Time the lyrics. */
      const noPython = whisperPythonMissing(config.lyrics.python);
      if (noPython) return json(res, 400, { error: noPython, ...(process.env.AIPLAY_WHISPER_PYTHON ? {} : { setup: "lyrics" }) }), true;
      const job = art.request({
        file: `whisper:${randomUUID().slice(0, 8)}`, title: at.title, kind: "whisper", asked: true,
        actor: actorFrom(req),
        whisper: {
          input: at.input, vocals: at.vocals, lyrics: spec.lyrics, language: spec.language, words: spec.words,
          /* ".whisper" keeps these apart from the song's own timed lyrics
           * (<song>.lrc), which a transcription must never overwrite. */
          outStem: spec.writeLrc ? path.join(lrcDir, `${at.lrcBase}.whisper`) : null,
        },
      });
      if (!job) return json(res, 409, { error: `Not queued: ${art.lastRefusal || "the queue refused it"}.` }), true;
      return json(res, 200, {
        ok: true, jobId: job.id, job: { id: job.id, kind: job.kind, title: job.title },
        input: at.name, usesVocalStem: !!at.vocals, model: config.lyrics.model,
        ...(spec.writeLrc ? { lrc: `${at.lrcBase}.whisper.lrc`, wordLrc: `${at.lrcBase}.whisper.word.lrc` } : {}),
      }), true;
    }
    return json(res, 400, { error: "Unknown action. Try: transcribe, model, status." }), true;
  };
}
