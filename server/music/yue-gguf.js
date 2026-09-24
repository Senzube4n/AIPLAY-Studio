/** Experimental native audio.cpp YuE2 adapter; no Python or downloads. The only probe is `--version`. */
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, stat, open, writeFile, readFile, readdir } from "node:fs/promises";
import { config } from "../config.js";
import * as provenance from "../provenance.js";
import { TOOL, normalizeActor } from "../provenance.js";
import { killMeshProcessTree, sha256File } from "../mesh/runner.js";
import { YUE2_RIGHTS, refuseLyrics } from "./yue.js";
import { outputRightsFor, rightsStampFor } from "../models.js";

export const YUE_GGUF_MODEL = "yue2-gguf";

/* THE RIGHTS A GGUF RENDER CARRIES: the catalogue's own row for this engine
 * (musicYue2Gguf: the authors' statement, with its weights-vs-native-code
 * note), and yue.js's reading of the licence file only when there is none. */
function ggufRights() {
  const r = outputRightsFor(YUE_GGUF_MODEL);
  return r?.class && r.class !== "unknown" ? r : YUE2_RIGHTS;
}
/* The record's copy is the claim, not the whole page: the ledger appends the
 * record twice per render (delegate, generate), and the verbatim quotes and
 * notes stay in the catalogue, as models.js rightsStampFor says they must. */
export function rightsForRecord(r) {
  return { class: r.class, sellable: r.sellable ?? null, chip: r.chip || null, basis: r.basis || "licence", url: r.url || null,
    ...(r.licenceFile ? { licenceFile: { name: r.licenceFile.name, url: r.licenceFile.url || null } } : {}) };
}
export const MIN_FREE_VRAM_MB = null; // Native peak memory has not been measured.
export const killGgufProcessTree = killMeshProcessTree;
export const YUE_GGUF_RUNTIME = Object.freeze({
  repository: "https://github.com/0xShug0/audio.cpp",
  revision: "cda0e3a4762d855e865980506f934ec0e6928691",
  family: "yue2", task: "gen", backend: "cuda",
  experimental: true, binaryAttested: false,
});

/* WHICH CARD THE RUNTIME DRIVES — read from the runtime, not assumed.
 *
 * `--backend cuda` used to be hardcoded here, which made this engine NVIDIA-only
 * although audio.cpp itself is not: its official releases ship Windows Vulkan
 * and CPU builds, YuE2 is upstream since v0.8.0, and a community HIP build
 * covers ROCm. `audiocpp_cli --version` prints the backends a binary was built
 * with ("backends: cpu,vulkan" — CMakeLists.txt at v0.8.1), so the backend is
 * picked from that line and the card's vendor: the fastest one this binary has
 * for this card, and never CUDA on a card that cannot run it. */
export const YUE_GGUF_BACKENDS = Object.freeze(["cuda", "hip", "vulkan", "cpu"]);
const BACKEND_ORDER = Object.freeze({
  nvidia: ["cuda", "vulkan", "cpu"],
  amd: ["hip", "vulkan", "cpu"],
  intel: ["vulkan", "cpu"],
  unknown: ["cuda", "hip", "vulkan", "cpu"],
});
const atLeast08 = (v) => !!v && (v[0] > 0 || v[1] >= 8);
/** Pure: the `--version` text of an audio.cpp build -> what Studio needs from it. */
export function parseRuntimeVersion(text = "") {
  const t = String(text);
  const line = /backends:[ \t]*([^\r\n]*)/i.exec(t)?.[1] || "";
  const backends = [...new Set(line.toLowerCase().split(/[\s,;]+/)
    .map((b) => (b === "rocm" ? "hip" : b)).filter((b) => YUE_GGUF_BACKENDS.includes(b)))];
  const m = /audio\.cpp[ \t]+v?(\d+)\.(\d+)\.(\d+)/i.exec(t);
  const version = m ? m.slice(1, 4).map(Number) : null;
  const pinned = /cda0e/i.test(t);
  return { backends, version: version ? version.join(".") : null, pinned,
    // YuE2 merged upstream in v0.8.0; the pinned cda0e3a dev build predates that.
    yue2: pinned || atLeast08(version),
    // v0.8 renamed the YuE2 request option cfg_scale -> guidance_scale (model_specs/yue2.json).
    cfgKey: !pinned && atLeast08(version) ? "guidance_scale" : "cfg_scale" };
}
/** Pure: the backend to pass for this build on this card. `preferred` wins when the build has it. */
export function pickBackend(backends = [], { vendor = null, preferred = "auto" } = {}) {
  if (preferred && preferred !== "auto" && backends.includes(preferred)) return preferred;
  const order = BACKEND_ORDER[vendor] || BACKEND_ORDER.unknown;
  // An unreadable build is the pinned CUDA kit (the only one Studio installed before).
  return order.find((b) => backends.includes(b)) || backends[0] || "cuda";
}
const runtimeCache = new Map();
/** `--version` of the configured CLI, cached per file identity. Never throws. */
export async function readRuntime(cli, { statFn = stat, execFileFn = execFile } = {}) {
  let key;
  try { const s = await statFn(cli); key = `${cli}:${s.mtimeMs}:${s.size}`; }
  catch { return parseRuntimeVersion(""); }
  if (!runtimeCache.has(key)) {
    runtimeCache.set(key, new Promise((resolve) => {
      try {
        execFileFn(cli, ["--version"], { windowsHide: true, timeout: 10000, maxBuffer: 65536 },
          (err, stdout = "", stderr = "") => resolve(err ? null : parseRuntimeVersion(`${stdout}\n${stderr}`)));
      } catch { resolve(null); }
    }).then((r) => { if (!r) runtimeCache.delete(key); return r || parseRuntimeVersion(""); }));
  }
  return runtimeCache.get(key);
}
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
  backend: config.yueGguf?.backend || "auto",
  vendor: config.gpu?.vendor || null,
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
    rights: ggufRights(), experimental: true, minimumVramMb: MIN_FREE_VRAM_MB };
}

/* The sampler's own dials: the runtime's request option, the field the page
 * and make_song send for it (the Python kit's names), and its bounds. ONE list:
 * music-gguf-input.js maps the page's fields through it. The runtime names are
 * the same in model_specs/yue2.json of the pinned cda0e3a build and of the
 * official v0.8.1 (v0.8 renamed only cfg_scale → guidance_scale, cfgKey
 * below): performance = semantic, planner = abc. Bounds are the Python kit's
 * door's (index.js, protocol.py Sampling), inside the runtime's own
 * (temperature 0-5, top-p 0-1). */
export const GGUF_DIALS = Object.freeze({
  semantic_temperature: Object.freeze({ from: "temperature", range: [0, 5] }),
  semantic_top_p: Object.freeze({ from: "topP", range: [0.01, 1] }),
  abc_temperature: Object.freeze({ from: "planTemperature", range: [0, 5] }),
  abc_top_p: Object.freeze({ from: "planTopP", range: [0.01, 1] }),
});
const FIELDS = new Set(["style", "lyrics", "cot", "seed", "narSteps", "cfg_scale", "abc", "id",
  "out", "actor", "via", "project", "subject", "signal", "onProgress", "timeoutMs", "audioSeconds",
  "allowEmptyLyrics", "allowSectionLabels", "quantization", ...Object.keys(GGUF_DIALS)]);
/** Pure API/queue preflight. Unsupported Python/runtime/audio-reference options are never ignored. */
export function validateGgufRequest(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("request", "Expected a native YuE2 request object.");
  const unknown = Object.keys(request).filter((key) => !FIELDS.has(key));
  if (unknown.length) fail("unknown-option", `Native YuE2 does not support: ${unknown.join(", ")}.`);
  /* No seed: a new one, as every other engine rolls. It was 831001 every
   * time, so the same words made the same song (2026-09-24). */
  const r = { ...request, cot: request.cot ?? "full", seed: request.seed ?? Math.floor(Math.random() * 2 ** 32),
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
  for (const [key, { range: [lo, hi] }] of Object.entries(GGUF_DIALS)) {
    if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < lo || r[key] > hi)) {
      fail("sampling", `A sampler dial is out of range: ${key} must be a number from ${lo} to ${hi}. Temperature 0–5, top-p 0.01–1. Nothing was queued.`);
    }
  }
  /* The planner writes the score; with a score supplied, or the chain of
   * thought off, it does not run, and its dials would change nothing. Said,
   * not dropped: this engine never ignores what it was asked for. */
  const planDial = r.abc_temperature !== undefined || r.abc_top_p !== undefined;
  if (planDial && r.abc != null) fail("sampling", "With a supplied score the planner does not run, so Planner temperature and top-p do nothing. Clear them, or clear the score. Nothing was queued.");
  if (planDial && r.cot === "off") fail("sampling", "With Thinking off the planner does not run, so Planner temperature and top-p do nothing. Clear them, or set Thinking to full or melody. Nothing was queued.");
  if (typeof r.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(r.id)) fail("request", "id must be 1–80 filename-safe letters, digits, underscores, or hyphens.");
  if (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 6 * 60 * 60 * 1000) fail("request", "timeoutMs must be between 1 ms and 6 hours.");
  if (r.audioSeconds != null && (!Number.isFinite(r.audioSeconds) || r.audioSeconds <= 0)) fail("request", "audioSeconds is advisory only and must be positive if provided.");
  if (r.signal != null && (typeof r.signal.aborted !== "boolean" || typeof r.signal.addEventListener !== "function"
    || typeof r.signal.removeEventListener !== "function")) fail("request", "signal must be an AbortSignal.");
  if (r.onProgress != null && typeof r.onProgress !== "function") fail("request", "onProgress must be a function.");
  return r;
}

export function buildGgufArgs(r, { modelDir, threads, output, abcFile = null, cli = "",
  backend = "cuda", cfgKey = "cfg_scale" }) {
  const variant = ggufVariant(r.quantization);
  if (!YUE_GGUF_BACKENDS.includes(backend)) fail("request", `Unknown native backend: ${backend}.`);
  const args = ["--task", "gen", "--family", "yue2", "--model", modelDir,
    "--backend", backend, "--threads", String(threads),
    "--session-option", `yue2.model_gguf=${variant.modelFile}`,
    "--session-option", "yue2.vae_gguf=yue2-vae-f16.gguf",
    "--text", r.lyrics, "--request-option", `style=${r.style}`,
    "--request-option", `cot=${r.cot}`, "--seed", String(r.seed),
    "--request-option", `num_inference_steps=${r.narSteps}`];
  if (r.cfg_scale != null) args.push("--request-option", `${cfgKey}=${r.cfg_scale}`);
  if (abcFile) args.push("--request-option", `abc_file=${abcFile}`);
  for (const key of Object.keys(GGUF_DIALS)) if (r[key] !== undefined) args.push("--request-option", `${key}=${r[key]}`);
  // Phase timing lines on stdout (ggufLogPhase). They carry names and milliseconds, never lyrics.
  args.push("--log", "--out", output);
  // Quotes and backslashes can double under Windows command-line serialization.
  const upperBound = [cli, ...args].reduce((n, value) => n + 2 * String(value).length + 3, 0);
  if (upperBound > MAX_COMMAND) fail("request", "Native command exceeds the 24,000-character safety bound; shorten lyrics/style or configured paths.");
  return args;
}

/* LIVE PHASE AND ETA — from the runtime's own timing lines.
 *
 * The native render used to say "live phase unavailable" for its whole run.
 * audio.cpp has no per-token progress, but with `--log` it prints one
 * `[TIMING ts=…] <name> <ms>` line as each YuE2 phase ENDS (pipeline.cpp:
 * ar.init_ms inside the first model use, then plan_ms, semantic_ms, nar_ms,
 * vae_decode_ms — the same names in the pinned cda0e3a build and in v0.8.1).
 * Studio times each phase itself between those lines, and the ETA comes from
 * this machine's own previous native renders, scaled by lyric length: an
 * estimate from measurements here, never a figure typed into the code. With no
 * history yet the phase is live and the ETA honestly absent. */
export const GGUF_PHASES = Object.freeze(["load", "plan", "semantic", "nar", "decode"]);
const PHASE_ENDED_BY = Object.freeze({
  "yue2.ar.init_ms": "load", "yue2.plan_ms": "plan", "yue2.semantic_ms": "semantic",
  "yue2.nar_ms": "nar", "yue2.vae_decode_ms": "decode",
});
/** Pure: which phase a stdout line says has just ended, or null. */
export function ggufLogPhase(line) {
  const m = /^\[TIMING ts=[^\]]*\][ \t]+(\S+)[ \t]/.exec(String(line).trim() + " ");
  return m && Object.hasOwn(PHASE_ENDED_BY, m[1]) ? PHASE_ENDED_BY[m[1]] : null;
}
const TIMINGS_KEEP = 20;
const timingsFile = () => path.join(config.dataDir, "yue2-gguf", "timings.json");
export const ggufTimingStore = {
  async read() {
    try { const v = JSON.parse(await readFile(timingsFile(), "utf8")); return Array.isArray(v) ? v : []; }
    catch { return []; }
  },
  /* Renders from before phase timing existed still left receipts with their
   * total time and lyric length. Read once, when there is no history file, so
   * the very first render after an update already has an ETA to show. */
  async seed(runsRoot) {
    try {
      await readFile(timingsFile(), "utf8");
      return;   // history already exists: nothing to import
    } catch { /* no file yet */ }
    const rows = [];
    try {
      for (const job of await readdir(runsRoot)) {
        let runs = [];
        try { runs = await readdir(path.join(runsRoot, job)); } catch { continue; }
        for (const run of runs.filter((n) => n.startsWith("gguf-"))) {
          try {
            const d = JSON.parse(await readFile(path.join(runsRoot, job, run, "receipt.json"), "utf8"));
            if (d.status !== "completed" || !Number.isFinite(d.elapsedSec)) continue;
            rows.push({ at: null, quantization: d.quantization, backend: d.runtime?.backend || null,
              cot: d.args?.cot, narSteps: d.args?.num_inference_steps, lyricsChars: d.args?.lyricsChars,
              audioSeconds: d.output?.audioSeconds ?? null, elapsedSec: d.elapsedSec, phases: d.phaseSeconds || null });
          } catch { /* not a receipt */ }
        }
      }
    } catch { return; }
    if (!rows.length) return;
    try {
      await mkdir(path.dirname(timingsFile()), { recursive: true });
      await writeFile(timingsFile(), JSON.stringify(rows.slice(-TIMINGS_KEEP), null, 1) + "\n");
    } catch { /* a convenience only */ }
  },
  async add(row) {
    try {
      const rows = [...await this.read(), row].slice(-TIMINGS_KEEP);
      await mkdir(path.dirname(timingsFile()), { recursive: true });
      await writeFile(timingsFile(), JSON.stringify(rows, null, 1) + "\n");
    } catch { /* an estimate is a convenience; it can never fail a render */ }
  },
};
/** Pure: expected seconds per phase for this request, from earlier runs here, or null. */
export function estimateGgufPhases(history = [], { quantization, backend, cot, narSteps = 32, lyricsChars = 0 } = {}) {
  const ok = (h) => h && h.phases && typeof h.phases === "object" && GGUF_PHASES.every((p) => Number.isFinite(h.phases[p]));
  const rows = history.filter(ok);
  const pick = [
    rows.filter((h) => h.quantization === quantization && h.backend === backend && h.cot === cot),
    rows.filter((h) => h.quantization === quantization && h.backend === backend),
    rows.filter((h) => h.backend === backend),
  ].find((set) => set.length)?.slice(-5);
  // Song length follows the lyrics, so the phases that scale with it do too. A
  // tagged six-verse sheet is several times a short test lyric, so the ratio is
  // allowed to be large; it is only bounded against nonsense.
  const lenRatio = (chars) => chars > 0 && lyricsChars > 0 ? Math.min(12, Math.max(0.25, lyricsChars / chars)) : 1;
  if (!pick) {
    /* No run with phase times yet: runs with only a TOTAL (older receipts, or a
     * build without --log) still give a whole-render estimate, scaled the same way. */
    const totals = history.filter((h) => h && Number.isFinite(h.elapsedSec) && h.elapsedSec > 0);
    const same = [
      totals.filter((h) => h.quantization === quantization && h.backend === backend),
      totals.filter((h) => h.backend === backend),
    ].find((set) => set.length)?.slice(-5);
    if (!same) return null;
    const avg = (f) => same.reduce((n, h) => n + f(h), 0) / same.length;
    return { total: avg((h) => h.elapsedSec) * lenRatio(avg((h) => h.lyricsChars || 0)) };
  }
  const mean = (f) => pick.reduce((n, h) => n + f(h), 0) / pick.length;
  const len = lenRatio(mean((h) => h.lyricsChars || 0));
  const steps = narSteps / Math.max(1, mean((h) => h.narSteps || 32));
  return {
    load: mean((h) => h.phases.load),
    plan: cot === "off" ? 0 : mean((h) => h.phases.plan) * len,
    semantic: mean((h) => h.phases.semantic) * len,
    nar: mean((h) => h.phases.nar) * len * steps,
    decode: mean((h) => h.phases.decode) * len,
  };
}
/** Pure: overall fraction and seconds left, given the phase now running and how long it has run. */
export function ggufEta(estimate, phase, inPhaseSec, elapsedSec) {
  const at = GGUF_PHASES.indexOf(phase);
  if (!estimate || at < 0) return { overall: null, etaSeconds: null };
  if (Number.isFinite(estimate.total)) {
    const rest = Math.max(1, Math.round(estimate.total - elapsedSec));
    return { overall: Math.min(0.99, elapsedSec / (elapsedSec + rest)), etaSeconds: rest };
  }
  let left = Math.max(0, estimate[phase] - inPhaseSec);
  for (const p of GGUF_PHASES.slice(at + 1)) left += estimate[p];
  left = Math.max(1, Math.round(left));
  return { overall: Math.min(0.99, elapsedSec / (elapsedSec + left)), etaSeconds: left };
}

/** One owned process tree; abort and timeout settle only after its termination attempt. */
export function runGgufDriver(args, { cli = SETTINGS().cli, cwd, signal,
  timeoutMs = 60 * 60 * 1000, spawnFn = spawn, killTree = killGgufProcessTree,
  onStderr = null, onStdout = null } = {}) {
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
    proc.stdout?.on("data", (data) => {
      stdout = (stdout + String(data)).slice(-MAX_LOG);
      try { onStdout?.(String(data)); } catch { /* UI notification cannot fail a render. */ }
    });
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
  settings = SETTINGS(), statFn = stat, hashFile = sha256File, spawnFn, killTree, openSidecar = open,
  runtimeInfo = readRuntime, timings = ggufTimingStore } = {}) {
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
  const rt = await runtimeInfo(settings.cli);
  checkAbort(r.signal);
  const backend = pickBackend(rt.backends, { vendor: settings.vendor, preferred: settings.backend });
  const args = buildGgufArgs(r, { ...settings, output, abcFile, backend, cfgKey: rt.cfgKey });
  const actor = normalizeActor(r.actor ?? "system"), via = r.via ?? "music.yue-gguf";
  const record = { runId, actor, via, appVersion: TOOL, model: YUE_GGUF_MODEL, models: [YUE_GGUF_MODEL],
    project: r.project ?? null, subject: r.subject ?? null, runtime: { ...YUE_GGUF_RUNTIME, backend, version: rt.version, cli: settings.cli, threads: settings.threads },
    weights: status.weights, quantization: r.quantization, modelFile: status.modelFile,
    outputRights: rightsStampFor(YUE_GGUF_MODEL), rights: rightsForRecord(ggufRights()), dir, generationLimits,
    args: { style: r.style, lyricsChars: r.lyrics.length, lyricsSha256: digestText(r.lyrics), cot: r.cot,
      seed: r.seed, quantization: r.quantization, num_inference_steps: r.narSteps, cfg_scale: r.cfg_scale ?? null,
      ...Object.fromEntries(Object.keys(GGUF_DIALS).filter((k) => r[k] !== undefined).map((k) => [k, r[k]])),
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
  await timings.seed?.(path.dirname(parent));
  const estimate = estimateGgufPhases(await timings.read(), { quantization: r.quantization, backend, cot: r.cot,
    narSteps: r.narSteps, lyricsChars: r.lyrics.length });
  const phases = {};
  let phase = "load", phaseAt = started, pending = "";
  const progress = (stage) => {
    const now = Date.now();
    const eta = GGUF_PHASES.includes(stage)
      ? ggufEta(estimate, stage, (now - phaseAt) / 1000, (now - started) / 1000) : { overall: null, etaSeconds: null };
    try { r.onProgress?.({ stage, fraction: null, percent: null, ...eta }); } catch { /* notifier */ }
  };
  const onStdout = (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop().slice(-4096);
    for (const line of lines) {
      const ended = ggufLogPhase(line);
      if (!ended) continue;
      /* The ORDER is not fixed. Measured with v0.8.1 on 2026-09-18: with
       * cot=off, plan_ms (0.6 ms) is printed BEFORE ar.init_ms, because the
       * model loads lazily inside the singing phase. Requiring strict order
       * froze the display on the first phase for the whole render. So a line
       * moves the display FORWARD to just past the phase it names, phases it
       * overtook count as taking no separate time, and nothing moves it back. */
      const at = GGUF_PHASES.indexOf(phase), idx = GGUF_PHASES.indexOf(ended);
      if (idx < at || Number.isFinite(phases[ended])) continue;
      const now = Date.now();
      phases[phase] = (now - phaseAt) / 1000;
      for (let i = at + 1; i <= idx; i++) phases[GGUF_PHASES[i]] ??= 0;
      const next = GGUF_PHASES[idx + 1];
      phaseAt = now;
      if (!next) continue;   // decode ended: the WAV write and verify follow
      phase = next;
      progress(phase);
    }
  };
  progress("load");
  // The ETA counts down between phase lines, which can be minutes apart.
  const ticker = setInterval(() => progress(phase), 2000);
  ticker.unref?.();
  try {
    checkAbort(r.signal);
    try {
      await runner(args, { cli: settings.cli, cwd: dir, signal: r.signal, timeoutMs: r.timeoutMs, onStdout,
        ...(spawnFn ? { spawnFn } : {}), ...(killTree ? { killTree } : {}) });
    } finally { clearInterval(ticker); }
    if (phase === "decode" && !Number.isFinite(phases.decode)) phases.decode = (Date.now() - phaseAt) / 1000;
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
    const complete = GGUF_PHASES.every((p) => Number.isFinite(phases[p]));
    const data = { ...record, status: "completed", elapsedSec, warnings, phaseSeconds: complete ? phases : null,
      output: { path: output, sha256, ...audio } };
    const receipt = path.join(dir, "receipt.json");
    await writeFile(receipt, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    checkAbort(r.signal);
    const generate = await prov.append("library", { actor, type: "generate", asset: `song/${runId}`, data });
    // Every completed run teaches the total; one whose every phase was seen teaches the phases too.
    await timings.add({ at: new Date().toISOString(), quantization: r.quantization, backend, cot: r.cot,
      narSteps: r.narSteps, lyricsChars: r.lyrics.length, audioSeconds: audio.audioSeconds, elapsedSec,
      phases: complete ? phases : null });
    checkAbort(r.signal);
    return { ok: true, runId, status: "completed", out: output, dir, receipt, ...audio, sha256, elapsedSec,
      quantization: r.quantization, modelFile: status.modelFile, generationLimits, warnings,
      realtimeRatio: elapsedSec ? audio.audioSeconds / elapsedSec : null,
      rights: ggufRights(), record: data, ledger: { delegate, generate } };
  } catch (error) {
    error.runId = runId;
    error.dir = dir;
    throw error;
  }
}
