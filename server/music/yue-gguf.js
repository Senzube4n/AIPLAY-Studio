/** Experimental native audio.cpp YuE2 adapter; no Python, downloads, or runtime probes. */
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, stat, open, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import * as provenance from "../provenance.js";
import { TOOL, normalizeActor } from "../provenance.js";
import { killMeshProcessTree, sha256File } from "../mesh/runner.js";
import { YUE2_RIGHTS, refuseLyrics } from "./yue.js";

export const YUE_GGUF_MODEL = "yue2-gguf";
export const MIN_FREE_VRAM_MB = null; // Native peak memory has not been measured.
export const killGgufProcessTree = killMeshProcessTree;
export const YUE_GGUF_RUNTIME = Object.freeze({
  repository: "https://github.com/0xShug0/audio.cpp",
  revision: "cda0e3a4762d855e865980506f934ec0e6928691",
  family: "yue2", task: "gen", backend: "cuda",
  experimental: true, binaryAttested: false,
});
export const YUE_GGUF_VARIANTS = Object.freeze({
  q4_0: Object.freeze({ label: "Q4_0", modelFile: "yue2-3b-q4_0.gguf" }),
  q8_0: Object.freeze({ label: "Q8_0", modelFile: "yue2-3b-q8_0.gguf" }),
});
// Backwards-compatible default manifest. Both variants share the F16 VAE and sidecars.
export const YUE_GGUF_FILES = Object.freeze([
  { name: "yue2-3b-q4_0.gguf", role: "model", declaredBytes: 2665632320,
    declaredSha256: "97af67d7f800b362faee6e6bec806bddfcccb93f25fd3f9a1012724d95af6f4a" },
  { name: "yue2-vae-f16.gguf", role: "vae", declaredBytes: 265218656,
    declaredSha256: "d4f4a05d8f291ae820cd1e43609da3fa91b56465810091a2b08c3350b751719d" },
  { name: "sidecars/yue2-model-config.json", role: "model-config", declaredBytes: 959,
    gitBlob: "9584e50ba9d6e487690544e14dd7555edbe27973" },
  { name: "sidecars/yue2-generation-config.json", role: "generation-config", declaredBytes: 466,
    gitBlob: "f8214009f5bb5425319e4519b12e4853ad72acf3" },
  { name: "sidecars/yue2-qwen.tiktoken", role: "tokenizer", declaredBytes: 2561218,
    gitBlob: "9b9b0e0416d84d7c88333eb261c77e5fe2d7f7be" },
  { name: "sidecars/yue2-vae-config.json", role: "vae-config", declaredBytes: 1378,
    gitBlob: "f68832bef1b99f53dd70460f6b0d336971a664b8" },
].map(Object.freeze));
const Q8_FILES = Object.freeze([
  Object.freeze({ name: "yue2-3b-q8_0.gguf", role: "model", declaredBytes: 4264186432,
    declaredSha256: "f3a9e3b197bfd05aa4ae6ab2d4b93f6d57c8cc0ea39a4af7d151f58697c7cfb6" }),
  ...YUE_GGUF_FILES.slice(1),
]);
export const YUE_GGUF_WEIGHTS = Object.freeze({
  repository: "https://huggingface.co/audio-cpp/Yue2-3B-GGUF",
  revision: "eb116220931de5f373d024d48800338178c7de51",
  factsFrom: "Hugging Face repository metadata; declared hashes are not locally verified",
});
const SETTINGS = () => ({
  enabled: config.yueGguf?.enabled === true,
  cli: config.yueGguf?.cli || "",
  modelDir: config.yueGguf?.modelDir || path.join(config.dataDir, "yue2-gguf", "models"),
  threads: config.yueGguf?.threads ?? 8,
});
const MAX_LOG = 32 * 1024;
const MAX_COMMAND = 24000;
const MAX_SIDECAR_BYTES = 8 * 1024;
const digestText = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

export class YueGgufRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = code === "cancelled" ? "AbortError" : "YueGgufRefusal";
    this.refusal = code;
    Object.assign(this, detail);
  }
}
const fail = (code, text) => { throw new YueGgufRefusal(code, text); };
const ggufVariant = (quantization = "q4_0") => {
  if (typeof quantization !== "string" || !Object.hasOwn(YUE_GGUF_VARIANTS, quantization)) {
    fail("request", "quantization must be q4_0 (Q4_0) or q8_0 (Q8_0); Python BF16/FP8 settings do not apply.");
  }
  return YUE_GGUF_VARIANTS[quantization];
};
export function ggufFilesFor(quantization = "q4_0") {
  ggufVariant(quantization);
  return quantization === "q8_0" ? Q8_FILES : YUE_GGUF_FILES;
}
const checkAbort = (signal) => {
  if (signal?.aborted) fail("cancelled", "Native YuE2 generation was cancelled.");
};

// Optional evidence only. Read a fixed, small amount even if a sidecar grows after stat.
async function readBoundedSidecar(file, openFn) {
  const handle = await openFn(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1
      || info.size > MAX_SIDECAR_BYTES) return null;
    const buffer = Buffer.alloc(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes !== info.size || (await handle.stat()).size !== info.size) return null;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } finally { await handle.close(); }
}

async function readGenerationLimitFacts(modelDir, openFn) {
  try {
    const generation = await readBoundedSidecar(path.join(modelDir, "sidecars/yue2-generation-config.json"), openFn);
    const vae = await readBoundedSidecar(path.join(modelDir, "sidecars/yue2-vae-config.json"), openFn);
    const semantic = generation?.semantic;
    const maxTokens = semantic && typeof semantic === "object" && !Array.isArray(semantic)
      ? semantic.max_tokens : null;
    const rate = vae?.sample_rate, ratio = vae?.downsampling_ratio;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1
      || !Number.isInteger(rate) || rate < 8000 || rate > 192000
      || !Number.isSafeInteger(ratio) || ratio < 1 || ratio > rate
      || !Number.isSafeInteger(maxTokens * ratio)) return null;
    return { sampleRate: rate, generationLimits: { semanticMaxTokens: maxTokens,
      approxMaxAudioSeconds: maxTokens * ratio / rate, source: "installed-sidecars" } };
  } catch { return null; } // Missing/invalid evidence must not turn valid audio into failure.
}

/** A duration match is a suspicion, never a claim that the native sampler reported truncation. */
export function ggufGenerationWarnings(audioSeconds, generationLimits) {
  const { semanticMaxTokens, approxMaxAudioSeconds, source } = generationLimits ?? {};
  if (source !== "installed-sidecars" || !Number.isSafeInteger(semanticMaxTokens) || semanticMaxTokens < 1
    || !Number.isFinite(approxMaxAudioSeconds) || approxMaxAudioSeconds <= 0
    || !Number.isFinite(audioSeconds) || audioSeconds <= 0) return [];
  const frameSeconds = approxMaxAudioSeconds / semanticMaxTokens;
  if (Math.abs(audioSeconds - approxMaxAudioSeconds) > frameSeconds + Number.EPSILON * approxMaxAudioSeconds) return [];
  return [{ code: "possible_semantic_limit",
    message: "This take is near the configured generation limit. Check the ending and lyrics; the runtime did not confirm whether it stopped at the limit.",
    evidence: "duration_near_configured_limit", semanticMaxTokens, approxMaxAudioSeconds }];
}

/** Stats only: neither a binary version check nor a CUDA/weight-integrity claim. */
export async function yueGgufStatus({ settings = SETTINGS(), statFn = stat, quantization = "q4_0" } = {}) {
  const variant = ggufVariant(quantization);
  const why = [];
  if (!settings.enabled) why.push("Native YuE2 GGUF is explicitly disabled by AIPLAY_YUE_GGUF_ENABLED=0.");
  const cli = settings.cli;
  const nativePath = typeof cli === "string" && path.isAbsolute(cli)
    && !/\.(?:py|js|mjs|cjs|cmd|bat|ps1|sh)$/i.test(cli)
    && (process.platform !== "win32" || /\.exe$/i.test(cli));
  let cliPresent = false;
  if (nativePath) {
    try { const s = await statFn(cli); cliPresent = s.isFile() && s.size > 0; } catch { /* missing */ }
  }
  if (!cliPresent) why.push("Configure an absolute path to an installed native audio.cpp CLI executable; no PATH or Python fallback is used.");
  if (!Number.isInteger(settings.threads) || settings.threads < 1 || settings.threads > 64) why.push("Native threads must be an integer from 1 to 64.");
  const modelDir = typeof settings.modelDir === "string" && path.isAbsolute(settings.modelDir)
    ? settings.modelDir : null;
  if (!modelDir) why.push("Configure an absolute native YuE2 model directory.");
  const weights = await Promise.all(ggufFilesFor(quantization).map(async (file) => {
    const dest = modelDir ? path.join(modelDir, file.name) : null;
    let bytes = 0, present = false;
    try { if (dest) { const s = await statFn(dest); bytes = s.size; present = s.isFile() && bytes === file.declaredBytes; } } catch { /* missing */ }
    if (!present) why.push(`Missing or incomplete native YuE2 file: ${file.name}.`);
    return { ...file, ...YUE_GGUF_WEIGHTS, dest, bytes, present, hashVerified: false };
  }));
  return { enabled: !!settings.enabled, installed: why.length === 0, cli, cliPresent,
    modelDir, threads: settings.threads, quantization, modelFile: variant.modelFile, weights, why, runtime: YUE_GGUF_RUNTIME,
    rights: YUE2_RIGHTS, experimental: true, minimumVramMb: MIN_FREE_VRAM_MB };
}

const FIELDS = new Set(["style", "lyrics", "cot", "seed", "narSteps", "cfg_scale", "abc", "id",
  "out", "actor", "via", "project", "subject", "signal", "onProgress", "timeoutMs", "audioSeconds",
  "allowEmptyLyrics", "allowSectionLabels", "quantization"]);
/** Pure API/queue preflight. Unsupported Python/runtime/audio-reference options are never ignored. */
export function validateGgufRequest(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("request", "Expected a native YuE2 request object.");
  const unknown = Object.keys(request).filter((key) => !FIELDS.has(key));
  if (unknown.length) fail("unknown-option", `Native YuE2 does not support: ${unknown.join(", ")}.`);
  const r = { ...request, cot: request.cot ?? "full", seed: request.seed ?? 831001,
    narSteps: request.narSteps ?? 32, id: request.id ?? "song", timeoutMs: request.timeoutMs ?? 60 * 60 * 1000,
    quantization: request.quantization === undefined ? "q4_0" : request.quantization };
  ggufVariant(r.quantization);
  for (const [key, max] of [["style", 2000], ["lyrics", 8000]]) {
    if (typeof r[key] !== "string" || r[key].length > max || r[key].includes("\0") || !r[key].trim()) {
      fail("request", `${key} must be nonempty text of at most ${max} characters, without NUL.`);
    }
  }
  if (r.allowEmptyLyrics !== undefined && typeof r.allowEmptyLyrics !== "boolean") fail("request", "allowEmptyLyrics must be boolean.");
  if (r.allowEmptyLyrics) fail("request", "The pinned native YuE2 runtime requires lyrics; instrumental/empty-lyrics mode is not supported.");
  if (r.allowSectionLabels !== undefined && typeof r.allowSectionLabels !== "boolean") fail("request", "allowSectionLabels must be boolean.");
  refuseLyrics(r.lyrics, { allowSectionLabels: r.allowSectionLabels === true });
  // The pinned CLI scans option values too: refuse a lyric that is itself a flag.
  if (/^--[a-z0-9-]+$/i.test(r.lyrics)) fail("request", "Lyrics cannot consist of a native command-line flag.");
  if (!["off", "melody", "full"].includes(r.cot)) fail("request", "cot must be off, melody, or full.");
  if (!Number.isSafeInteger(r.seed) || r.seed < 0) fail("request", "seed must be a nonnegative safe integer.");
  if (!Number.isInteger(r.narSteps) || r.narSteps < 1 || r.narSteps > 256) fail("request", "narSteps must be an integer from 1 to 256.");
  if (r.cfg_scale != null && (!Number.isFinite(r.cfg_scale) || r.cfg_scale < 0 || r.cfg_scale > 20)) fail("request", "cfg_scale must be finite and between 0 and 20.");
  if (r.abc != null && (typeof r.abc !== "string" || !r.abc.trim() || r.abc.includes("\0")
    || Buffer.byteLength(r.abc) > 65536 || r.cot === "off")) fail("request", "abc must be nonempty text up to 64 KiB with cot melody or full.");
  if (typeof r.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(r.id)) fail("request", "id must be 1–80 filename-safe letters, digits, underscores, or hyphens.");
  if (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 6 * 60 * 60 * 1000) fail("request", "timeoutMs must be between 1 ms and 6 hours.");
  if (r.audioSeconds != null && (!Number.isFinite(r.audioSeconds) || r.audioSeconds <= 0)) fail("request", "audioSeconds is advisory only and must be positive if provided.");
  if (r.signal != null && (typeof r.signal.aborted !== "boolean" || typeof r.signal.addEventListener !== "function"
    || typeof r.signal.removeEventListener !== "function")) fail("request", "signal must be an AbortSignal.");
  if (r.onProgress != null && typeof r.onProgress !== "function") fail("request", "onProgress must be a function.");
  return r;
}

export function buildGgufArgs(r, { modelDir, threads, output, abcFile = null, cli = "" }) {
  const variant = ggufVariant(r.quantization);
  const args = ["--task", "gen", "--family", "yue2", "--model", modelDir,
    "--backend", "cuda", "--threads", String(threads),
    "--session-option", `yue2.model_gguf=${variant.modelFile}`,
    "--session-option", "yue2.vae_gguf=yue2-vae-f16.gguf",
    "--text", r.lyrics, "--request-option", `style=${r.style}`,
    "--request-option", `cot=${r.cot}`, "--seed", String(r.seed),
    "--request-option", `num_inference_steps=${r.narSteps}`];
  if (r.cfg_scale != null) args.push("--request-option", `cfg_scale=${r.cfg_scale}`);
  if (abcFile) args.push("--request-option", `abc_file=${abcFile}`);
  args.push("--out", output);
  // Quotes and backslashes can double under Windows command-line serialization.
  const upperBound = [cli, ...args].reduce((n, value) => n + 2 * String(value).length + 3, 0);
  if (upperBound > MAX_COMMAND) fail("request", "Native command exceeds the 24,000-character safety bound; shorten lyrics/style or configured paths.");
  return args;
}

/** One owned process tree; abort and timeout settle only after its termination attempt. */
export function runGgufDriver(args, { cli = SETTINGS().cli, cwd, signal,
  timeoutMs = 60 * 60 * 1000, spawnFn = spawn, killTree = killGgufProcessTree,
  onStderr = null } = {}) {
  return new Promise((resolve, reject) => {
    let proc, timer, settled = false, stopping = false, stdout = "", stderr = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(value);
    };
    const stop = (code) => {
      if (settled || stopping) return;
      stopping = true;
      Promise.resolve().then(() => killTree(proc)).catch(() => false).then((stopped) => {
        finish(new YueGgufRefusal(code,
          `Native YuE2 ${code === "cancelled" ? "was cancelled" : "timed out"}; `
          + (stopped ? "its owned process tree was stopped." : "process-tree termination could not be confirmed."),
          { terminationConfirmed: !!stopped }));
      });
    };
    const aborted = () => stop("cancelled");
    try {
      checkAbort(signal);
      proc = spawnFn(cli, args, { cwd, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { finish(error); return; }
    proc.stdout?.on("data", (data) => { stdout = (stdout + String(data)).slice(-MAX_LOG); });
    proc.stderr?.on("data", (data) => {
      const tail = String(data).slice(-MAX_LOG);
      stderr = (stderr + tail).slice(-MAX_LOG);
      try { onStderr?.(tail); } catch { /* UI notification cannot fail a render. */ }
    });
    proc.once("error", (error) => { if (!stopping) finish(new YueGgufRefusal("driver", `Native audio.cpp could not start: ${error.message}`)); });
    proc.once("close", (code) => {
      if (stopping) return;
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new YueGgufRefusal("driver", `Native audio.cpp exited ${code}.\n${stderr || stdout}`));
    });
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/** The pinned native sink emits PCM16 RIFF. Parse bounded headers, not the whole recording. */
export async function inspectGgufWav(file) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 46) fail("output", "Native output is missing or empty WAV audio.");
    const read = async (size, at) => {
      const data = Buffer.alloc(size);
      if ((await handle.read(data, 0, size, at)).bytesRead !== size) fail("output", "Native WAV is truncated.");
      return data;
    };
    const header = await read(12, 0);
    const end = header.readUInt32LE(4) + 8;
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE"
      || end !== info.size) fail("output", "Native output is not a complete RIFF/WAVE file.");
    let offset = 12, format = null, dataBytes = null, chunks = 0;
    while (offset + 8 <= end && chunks++ < 256) {
      const chunk = await read(8, offset);
      const name = chunk.toString("ascii", 0, 4), size = chunk.readUInt32LE(4);
      if (offset + 8 + size + (size % 2) > end) fail("output", "Native WAV chunk exceeds the file.");
      if (name === "fmt ") {
        if (format || size < 16 || size > 4096) fail("output", "Native WAV has invalid format metadata.");
        const f = await read(16, offset + 8);
        format = { codec: f.readUInt16LE(0), channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4),
          byteRate: f.readUInt32LE(8), blockAlign: f.readUInt16LE(12), bits: f.readUInt16LE(14) };
      } else if (name === "data") {
        if (dataBytes !== null || !size) fail("output", "Native WAV audio is empty or ambiguous.");
        dataBytes = size;
      }
      offset += 8 + size + (size % 2);
    }
    if (offset !== end || !format || dataBytes === null || format.codec !== 1 || format.bits !== 16
      || ![1, 2].includes(format.channels) || format.sampleRate < 8000 || format.sampleRate > 192000
      || format.blockAlign !== format.channels * 2 || format.byteRate !== format.sampleRate * format.blockAlign
      || dataBytes % format.blockAlign !== 0) fail("output", "Native output must contain complete PCM16 audio frames.");
    return { bytes: info.size, audioSeconds: dataBytes / format.byteRate,
      sampleRate: format.sampleRate, channels: format.channels, dataBytes };
  } finally { await handle.close(); }
}

/** Delegate is durable before execution; success evidence requires actual validated, hashed audio. */
export async function renderGgufSong(request = {}, { runner = runGgufDriver, prov = provenance,
  settings = SETTINGS(), statFn = stat, hashFile = sha256File, spawnFn, killTree, openSidecar = open } = {}) {
  const r = validateGgufRequest(request);
  if (typeof r.out !== "string" || !r.out.trim()) fail("request", "A native output directory is required.");
  if (r.via !== undefined && (typeof r.via !== "string" || !r.via.trim())) fail("request", "via must identify the requesting door.");
  checkAbort(r.signal);
  const status = await yueGgufStatus({ settings, statFn, quantization: r.quantization });
  checkAbort(r.signal);
  if (!status.installed) throw new YueGgufRefusal(status.enabled ? "not-installed" : "disabled", status.why.join("\n"), { status });
  const limitFacts = await readGenerationLimitFacts(settings.modelDir, openSidecar);
  checkAbort(r.signal);
  const generationLimits = limitFacts?.generationLimits ?? null;
  const runId = `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
  const parent = path.resolve(r.out), dir = path.join(parent, `gguf-${runId}`);
  const output = path.join(dir, `${r.id}.wav`), abcFile = r.abc ? path.join(dir, "melody.abc") : null;
  const args = buildGgufArgs(r, { ...settings, output, abcFile });
  const actor = normalizeActor(r.actor ?? "system"), via = r.via ?? "music.yue-gguf";
  const record = { runId, actor, via, appVersion: TOOL, model: YUE_GGUF_MODEL, models: [YUE_GGUF_MODEL],
    project: r.project ?? null, subject: r.subject ?? null, runtime: { ...YUE_GGUF_RUNTIME, cli: settings.cli, threads: settings.threads },
    weights: status.weights, quantization: r.quantization, modelFile: status.modelFile,
    outputRights: YUE2_RIGHTS, rights: YUE2_RIGHTS, dir, generationLimits,
    args: { style: r.style, lyricsChars: r.lyrics.length, lyricsSha256: digestText(r.lyrics), cot: r.cot,
      seed: r.seed, quantization: r.quantization, num_inference_steps: r.narSteps, cfg_scale: r.cfg_scale ?? null,
      abcChars: r.abc?.length ?? 0, abcSha256: r.abc ? digestText(r.abc) : null,
      id: r.id, audioSecondsAdvisory: r.audioSeconds ?? null, allowEmptyLyrics: r.allowEmptyLyrics === true,
      allowSectionLabels: r.allowSectionLabels === true } };
  const delegate = await prov.append("library", { actor, type: "delegate", asset: `song/${runId}`, data: record });
  checkAbort(r.signal);
  await mkdir(parent, { recursive: true });
  await mkdir(dir); // Never reuse an existing directory or the native sink's replace behavior.
  if (abcFile) await writeFile(abcFile, r.abc, { encoding: "utf8", flag: "wx", mode: 0o600 });
  checkAbort(r.signal);
  const started = Date.now();
  const progress = (stage) => { try { r.onProgress?.({ stage, fraction: null, percent: null, etaSeconds: null }); } catch { /* notifier */ } };
  progress("load");
  try {
    checkAbort(r.signal);
    await runner(args, { cli: settings.cli, cwd: dir, signal: r.signal, timeoutMs: r.timeoutMs,
      ...(spawnFn ? { spawnFn } : {}), ...(killTree ? { killTree } : {}) });
    checkAbort(r.signal);
    progress("verify");
    const audio = await inspectGgufWav(output);
    checkAbort(r.signal);
    const sha256 = await hashFile(output);
    if (!/^sha256:[a-f0-9]{64}$/.test(sha256 || "")) fail("output", "Native WAV could not be hashed; success was not recorded.");
    checkAbort(r.signal);
    const elapsedSec = (Date.now() - started) / 1000;
    const warnings = audio.sampleRate === limitFacts?.sampleRate
      ? ggufGenerationWarnings(audio.audioSeconds, generationLimits) : [];
    const data = { ...record, status: "completed", elapsedSec, warnings, output: { path: output, sha256, ...audio } };
    const receipt = path.join(dir, "receipt.json");
    await writeFile(receipt, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    checkAbort(r.signal);
    const generate = await prov.append("library", { actor, type: "generate", asset: `song/${runId}`, data });
    checkAbort(r.signal);
    return { ok: true, runId, status: "completed", out: output, dir, receipt, ...audio, sha256, elapsedSec,
      quantization: r.quantization, modelFile: status.modelFile, generationLimits, warnings,
      realtimeRatio: elapsedSec ? audio.audioSeconds / elapsedSec : null,
      rights: YUE2_RIGHTS, record: data, ledger: { delegate, generate } };
  } catch (error) {
    error.runId = runId;
    error.dir = dir;
    throw error;
  }
}
