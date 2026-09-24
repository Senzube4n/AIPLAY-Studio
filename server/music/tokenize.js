/**
 * A RECORDING INTO YuE2'S OWN TOKENS — the door to `yue_tokenize.py`.
 *
 * YuE2 continues its own takes by replaying their semantic codes; nothing else
 * in the library had codes, because the model's authors published no encoder
 * from audio back into them. The catalogued real-audio tokenizer
 * (musicYue2Tokenizer: Mothersuperior's head over m-a-p's MERT-v2-FullSong,
 * both CC BY-NC 4.0) is that encoder, and this module runs it in the engine's
 * own python — on the CPU when asked or when the card is spoken for, on the
 * card otherwise — and keeps the codes beside the run folders, keyed by the
 * decoded audio (audioFingerprint below), so a track is read once however
 * many times it is continued and however the library retags the file.
 *
 * What comes out is approximate by the author's own measure (16 % exact codes,
 * round trips near 95 % by ear): the song as YuE2 would have written it,
 * close enough to continue, not a copy. The driver replays the codes with no
 * score and no old receipt (`--extend-codes`), which is the one difference
 * from continuing a take.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { CATALOG } from "../models.js";
import { engineModuleRefusal, refusalError } from "../setup/engine-packages.js";

export const TOKENIZER_ID = "musicYue2Tokenizer";
const SCRIPT = fileURLToPath(new URL("./yue_tokenize.py", import.meta.url));

/** The catalogue row's files, which is the one list of what must be on disk. */
export function tokenizerFiles() {
  return CATALOG.find((c) => c.id === TOKENIZER_ID)?.files ?? [];
}

/** { ready, missing: [dest…], head, mert } — the head's file and MERT's folder when ready. */
export async function tokenizerStatus() {
  const files = tokenizerFiles();
  const missing = [];
  for (const f of files) {
    const s = await stat(f.dest).catch(() => null);
    if (!s || s.size !== f.bytes) missing.push(f.dest);
  }
  const head = files.find((f) => /tokenizer_head/.test(f.dest))?.dest ?? null;
  const mert = files.find((f) => /model\.safetensors$/.test(f.dest))?.dest ?? null;
  return { ready: files.length > 0 && missing.length === 0, missing, head, mert: mert ? path.dirname(mert) : null };
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/**
 * THE KEY IS THE AUDIO, NOT THE FILE. The library rewrites a native WAV's tags
 * the moment it notices the file (library-wav.js), so a hash of the bytes
 * changed between the first tokenization and the next call — found on the
 * first probe: two folders for one recording. The decoded signal does not
 * move when a tag does: ffmpeg's 8 kHz mono 16-bit rendering of it is hashed
 * instead, and the file's own bytes only when ffmpeg is not there to decode.
 */
export function audioFingerprint(p, { ffmpeg = "ffmpeg" } = {}) {
  return new Promise((resolve) => {
    const h = createHash("sha256");
    let got = 0;
    let done = false;
    const finish = (viaFile) => {
      if (done) return;
      done = true;
      if (!viaFile && got > 0) resolve(h.digest("hex"));
      else sha256File(p).then(resolve, () => resolve(null));
    };
    let proc;
    try {
      proc = spawn(ffmpeg, ["-v", "error", "-i", p, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { windowsHide: true });
    } catch { return finish(true); }
    proc.stdout.on("data", (d) => { got += d.length; h.update(d); });
    proc.on("error", () => finish(true));
    proc.on("close", (code) => finish(code !== 0));
  });
}

/**
 * THE FOLDER A TRACK'S CODES LIVE IN, without rendering anything.
 *
 * Two kinds of track already carry codes. A YuE2 TAKE keeps them in its own
 * run folder (aiplay_yue2_<id>.flac -> output/yue2/<id>/semantic.npy), written
 * by the render itself. A RECORDING keeps them wherever the tokenizer put
 * them, under a fingerprint of its decoded audio. Returns null for a
 * recording that has not been read yet, so a caller can decide whether to
 * spend the time reading it.
 */
export async function codesDirFor(file, { outputDir = config.outputDir, ffmpeg = "ffmpeg" } = {}) {
  const take = /^aiplay_yue2_([0-9a-f]{8})\.flac$/i.exec(String(file || ""));
  if (take) {
    const dir = path.join(outputDir, "yue2", take[1]);
    const s = await stat(path.join(dir, "semantic.npy")).catch(() => null);
    if (s && s.size > 128) return { dir, kind: "take" };
  }
  const src = path.join(outputDir, String(file || ""));
  if (!(await stat(src).catch(() => null))) return null;
  const fp = await audioFingerprint(src, { ffmpeg });
  if (!fp) return null;
  const dir = path.join(outputDir, "yue2", `tok_${fp.slice(0, 12)}`);
  const s = await stat(path.join(dir, "semantic.npy")).catch(() => null);
  return s && s.size > 128 ? { dir, kind: "recording" } : null;
}

function run(cmd, argv, { timeoutMs = 30 * 60e3 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "";
    const p = spawn(cmd, argv, { windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e?.message || e) }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/**
 * Tokenize one recording. Returns { dir, codesFile, frames, seconds, device, cached, timing }.
 * `dir` holds semantic.npy (the codes) and source.json (what they came from),
 * under <outputDir>/yue2/tok_<sha12>, so `--extend-codes <dir>` finds them.
 *
 * `device`: "cpu" | "cuda" | null (null = the card when there is one). Callers
 * that know the card is busy pass "cpu": MERT in bf16 is 1.3 GB and a render
 * in flight has no room for it.
 */
export async function tokenizeTrack({ source, device = null, python = config.python, rig = config.rig, force = false, runner = run } = {}) {
  if (!source) throw new Error("tokenizeTrack needs a source file.");
  const st = await tokenizerStatus();
  if (!st.ready) {
    const e = new Error("The real-audio tokenizer is not on this machine: download it from the Models screen (YuE2 real-audio tokenizer).");
    e.status = 400; e.reason = "tokenizer-missing"; e.missing = st.missing;
    throw e;
  }
  const sha = await audioFingerprint(source);
  if (!sha) throw new Error(`${path.basename(source)} could not be read.`);
  const dir = path.join(config.outputDir, "yue2", `tok_${sha.slice(0, 12)}`);
  const codesFile = path.join(dir, "semantic.npy");
  const receipt = path.join(dir, "source.json");
  if (!force) {
    const have = await stat(codesFile).catch(() => null);
    if (have && have.size > 128) {
      let prior = {};
      try { prior = JSON.parse(await readFile(receipt, "utf8")); } catch { /* a receipt is a courtesy */ }
      return { dir, codesFile, cached: true, frames: prior.frames ?? null, seconds: prior.seconds ?? null, device: prior.device ?? null, timing: prior.timing ?? null };
    }
  }
  await mkdir(dir, { recursive: true });
  const argv = [SCRIPT, "--audio", source, "--out", codesFile, "--mert", st.mert, "--head", st.head,
    ...(device ? ["--device", device] : [])];
  const r = await runner(python, argv);
  const line = String(r.out || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { parsed = null; }
  if (!parsed || parsed.error || r.code !== 0) {
    const why = parsed?.error || (r.err || "").trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${r.code}`;
    /* A missing module is this machine not being ready (409), not a failed
     * run: the refusal names the module, the python and the pip line, and
     * carries setup "studio-packages" where Studio's engine setup fixes it.
     * The script's own error line goes last, so it is the one read. */
    const refusal = await engineModuleRefusal({ stderr: `${r.err || ""}\n${parsed?.error || ""}`,
      feature: "The real-audio tokenizer", rig, python });
    if (refusal) throw refusalError(refusal);
    const e = new Error(`The tokenizer failed: ${why}`);
    e.status = 500; e.reason = "tokenizer-failed";
    throw e;
  }
  const info = {
    source: path.basename(source), fingerprint: sha, frames: parsed.frames, seconds: parsed.seconds,
    framesPerSecond: parsed.framesPerSecond, distinctCodes: parsed.distinctCodes, device: parsed.device,
    timing: parsed.timing, head: path.basename(st.head), at: Date.now(),
  };
  await writeFile(receipt, JSON.stringify(info, null, 2));
  return { dir, codesFile, cached: false, ...info };
}
