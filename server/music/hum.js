/**
 * A hummed melody → the two-voice ABC score YuE2 takes verbatim.
 *
 * The "hum only" half of Mothersuperior's YuE2-hum-to-song recipe, with a
 * pitch tracker in place of its 229 MB transcriber: hum_to_abc.py (librosa
 * pYIN, in the engine's own python, which already carries it) reads a
 * 22.05 kHz mono WAV and writes the layout the planner itself writes. The
 * other half — leaving the score OPEN so the planner continues it — is the
 * driver's --abc-open flag, reached through /api/generate's `abcOpen`.
 *
 * What arrives: a browser recording (audio/webm from MediaRecorder), a file
 * somebody dropped in (any container ffmpeg reads), a library file, or an
 * absolute path an agent names — the same three source shapes as
 * music_input_prepare. ffmpeg on this machine turns any of them into the WAV
 * the tracker reads; nothing here decodes audio itself.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, stat, realpath, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { config } from "../config.js";
import { engineModuleRefusal } from "../setup/engine-packages.js";

const MAX_BYTES = 50 * 1024 * 1024;
const SCRIPT = fileURLToPath(new URL("./hum_to_abc.py", import.meta.url));

/** A refusal by sentence. `extra` carries the R0 fields a door relays
 *  (setup, pip, python, module, reason): a missing module is status 409 with
 *  the pip line, and setup "studio-packages" where that setup would fix it. */
export class HumRefusal extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    for (const k of ["setup", "pip", "python", "module", "reason"]) if (extra?.[k] != null) this[k] = extra[k];
  }
}

function run(cmd, argv, { timeoutMs = 120e3 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "";
    const p = spawn(cmd, argv, { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out, err: `${err}\n${e.message}` }); });
    p.on("exit", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** One source, staged as bytes: an upload, a library file or an absolute path. */
export async function stageSource(source, dir, { libraryDir = config.outputDir } = {}) {
  if (!source || typeof source !== "object") throw new HumRefusal("Choose source.path, source.library_file or source.data_url.");
  const kinds = ["path", "library_file", "data_url"].filter((k) => source[k] !== undefined);
  if (kinds.length !== 1) throw new HumRefusal("Provide exactly one source: path, library_file or data_url.");
  let bytes, name;
  if (kinds[0] === "data_url") {
    const data = String(source.data_url);
    if (data.length > Math.ceil(MAX_BYTES * 4 / 3) + 200) throw new HumRefusal("The recording is over 50 MB.", 413);
    const m = /^data:(audio|video)\/[\w.+-]+(?:;codecs=[^;,]+)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
    if (!m) throw new HumRefusal("The upload must be an audio base64 data URL.");
    bytes = Buffer.from(m[2], "base64");
    name = path.basename(String(source.name || "hum.webm"));
  } else {
    let file;
    if (kinds[0] === "library_file") {
      name = String(source.library_file);
      if (!name || name !== path.basename(name) || name.includes("..")) throw new HumRefusal("Invalid library file name.");
      file = path.join(libraryDir, name);
    } else {
      if (!path.isAbsolute(String(source.path))) throw new HumRefusal("source.path must be an absolute local audio path.");
      file = String(source.path); name = path.basename(file);
    }
    const resolved = await realpath(file).catch(() => null);
    const info = resolved ? await stat(resolved).catch(() => null) : null;
    if (!info?.isFile()) throw new HumRefusal(`${name} is not a file this machine can read.`);
    if (info.size > MAX_BYTES) throw new HumRefusal("The recording is over 50 MB.", 413);
    bytes = await readFile(resolved);
  }
  if (!bytes.length) throw new HumRefusal("The recording is empty.");
  await mkdir(dir, { recursive: true });
  const ext = (path.extname(name) || ".bin").toLowerCase().replace(/[^.\w]/g, "");
  const dest = path.join(dir, `source${ext}`);
  await writeFile(dest, bytes);
  return { path: dest, name, kind: kinds[0], bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Transcribe one hum. Returns { abc, bpm, bpmFrom, key, keyFrom, seconds,
 * notes, bars, pitchRange, source }. Refuses, by sentence, what the tracker
 * refuses (under a second, over a minute, no pitched notes).
 */
export async function transcribeHum({ source, bpm = null, key = null, python = config.python, rig = config.rig, ffmpeg = "ffmpeg" } = {}) {
  const dir = path.join(os.tmpdir(), "aiplay-hum", randomUUID().slice(0, 8));
  try {
    const staged = await stageSource(source, dir);
    const wav = path.join(dir, "hum.wav");
    const conv = await run(ffmpeg, ["-y", "-v", "error", "-i", staged.path, "-ac", "1", "-ar", "22050", "-f", "wav", wav]);
    if (conv.code !== 0) {
      throw new HumRefusal(conv.code === 127
        ? "ffmpeg is not on this machine's PATH, so the recording cannot be converted for the pitch tracker."
        : `ffmpeg could not read the recording: ${(conv.err || "").trim().split("\n").pop() || "unknown container"}`);
    }
    const argv = [SCRIPT, wav, "--json"];
    if (Number.isFinite(Number(bpm)) && Number(bpm) > 0) argv.push("--bpm", String(Math.min(Math.max(Number(bpm), 40), 240)));
    if (typeof key === "string" && /^[A-G](b|#)?m?$/.test(key.trim())) argv.push("--key", key.trim());
    const r = await run(python, argv);
    if (r.code !== 0) {
      /* "No module named 'scipy'": which module, which python, the pip line,
       * and the Install button where Studio's own engine setup would fix it. */
      const refusal = await engineModuleRefusal({ stderr: r.err, feature: "Hum to score", rig, python });
      if (refusal) throw new HumRefusal(refusal.message, refusal.status, refusal);
      throw new HumRefusal((r.err || "").trim().split("\n").filter(Boolean).pop() || `the pitch tracker exited ${r.code}`);
    }
    const line = (r.out || "").trim().split("\n").pop();
    let answer;
    try { answer = JSON.parse(line); } catch { throw new HumRefusal("The pitch tracker answered with something that is not JSON."); }
    return { ...answer, source: { name: staged.name, kind: staged.kind, bytes: staged.bytes, sha256: staged.sha256 } };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
