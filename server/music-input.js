/** Shared, opt-in external-audio continuation. CPU preparation; normal music queue for generation. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat, realpath, readdir, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/music_input_encode.py", import.meta.url));
const MAX_BYTES = 50 * 1024 * 1024;
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const finite = (v, fallback, min, max, name) => {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw fault(`${name} must be between ${min} and ${max}.`);
  return n;
};
const seedValue = (v) => v === undefined ? Math.floor(Math.random() * 4294967296)
  : finite(v, 0, 0, 4294967295, "seed");

/** Cancellation kills this CPU helper only; no engine address or global interrupt exists here. */
export function runMusicInputPython(python, args, { signal, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fault("Preparation cancelled.", 409));
    const child = spawn(python, [SCRIPT, ...args], {
      windowsHide: true, env: { ...process.env, CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1" },
    });
    let stdout = "", stderr = "", timedOut = false;
    const abort = () => child.kill();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (error, value) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    child.stdout.on("data", (s) => { stdout = (stdout + s).slice(-1024 * 1024); });
    child.stderr.on("data", (s) => { stderr = (stderr + s).slice(-8192); });
    child.once("error", (e) => finish(e));
    child.once("close", (code) => {
      if (signal?.aborted) return finish(fault("Preparation cancelled.", 409));
      if (timedOut) return finish(fault("CPU preparation exceeded five minutes; its subprocess was stopped.", 504));
      let result;
      try { result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); } catch { /* report below */ }
      if (code !== 0 || !result?.ok) return finish(fault(result?.error
        || (result?.missing?.length ? `Missing runtime dependencies: ${result.missing.join(", ")}` : null) || stderr.trim().slice(-600)
        || `Audio encoder exited ${code} without a result.`, 422));
      finish(null, result);
    });
  });
}

export function createMusicInputService(options) {
  const { directory, libraryDirectory, settings, localMode = () => true,
    enqueue, getRenderJob, cancelRenderJob, runPython = runMusicInputPython } = options;
  const rows = new Map(), controllers = new Map(), saves = new Map(), admissions = new Set();
  let pumpRunning = false, capabilityCache = null;
  const save = (row) => {
    const body = JSON.stringify(row, null, 2);
    const pending = (saves.get(row.id) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(path.join(directory, row.id), { recursive: true });
      await writeFile(path.join(directory, row.id, "job.json"), body);
    });
    saves.set(row.id, pending); return pending;
  };
  const initialized = (async () => {
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (!/^mi_[a-f0-9-]+$/.test(name)) continue;
      try {
        const row = JSON.parse(await readFile(path.join(directory, name, "job.json"), "utf8"));
        if (row.id !== name) continue;
        if (["queued", "preparing"].includes(row.state)) {
          row.state = "failed"; row.stage = "interrupted";
          row.error = "Studio stopped during preparation. Prepare the source again.";
          await save(row);
        }
        rows.set(row.id, row);
      } catch { /* an incomplete job is not a ready reference */ }
    }
  })();
  const publicPrep = (row) => ({
    id: row.id, reference_id: row.state === "ready" ? row.id : null,
    state: row.state, stage: row.stage, experimental: true, device: "cpu",
    source: row.source, start_seconds: row.start_seconds, duration_seconds: row.duration_seconds,
    created_at: row.created_at, finished_at: row.finished_at ?? null,
    error: row.error ?? null, encoding: row.encoding ?? null,
    render_jobs: row.render_jobs || [],
  });
  async function capabilities() {
    const cfg = settings();
    const base = {
      experimental: true, available: false, preparation_device: "cpu",
      limits: { max_source_bytes: MAX_BYTES, formats: ["wav", "flac"],
        min_reference_seconds: .25, max_reference_seconds: 15, max_continuation_seconds: 30 },
      requirements: ["Opt in with musicInput.enabled=true in Studio settings or AIPLAY_MUSIC_INPUT=1.",
        "Set musicInput.runtimeFile or AIPLAY_MUSIC_INPUT_RUNTIME to an installed runtime manifest.",
        "The manifest needs python, adapter, rvq_config, rvq_weights, dav_weights, encoder_repo and encoder_revision.",
        "Python needs torch, torchaudio, numpy, soundfile and safetensors. No automatic downloads are performed.",
        "Local Music3 with the installed resume_from node is required; hosted API mode is unsupported."],
      runtime_file: cfg.runtimeFile || null,
      modes: {
        external_audio_continuation: { status: "experimental", available: false,
          description: "Approximate HOT-Step RVQ prefix, then new Music3 audio. Source audio is unchanged; no automatic join or musical-coherence guarantee." },
        latent_refinement: { status: "research_only", available: false,
          reason: "An isolated v0.10 experiment ran; there is no supported Studio refiner job." },
        inpainting: { status: "research_only", available: false,
          reason: "Only a captured-conditioning mask experiment ran. Arbitrary-song inpainting and restoration quality are not established." },
      },
    };
    if (!cfg.enabled) return { ...base, reason: "Experimental audio-input continuation is not enabled." };
    if (!localMode()) return { ...base, reason: "Audio-input continuation requires local Music3; hosted API mode is active." };
    if (!cfg.runtimeFile) return { ...base, reason: "No optional audio-input runtime manifest is configured." };
    const cacheKey = JSON.stringify(cfg);
    if (capabilityCache?.key === cacheKey && Date.now()-capabilityCache.at < 30_000) {
      return { ...base, ...capabilityCache.value };
    }
    let value;
    try {
      const runtime = JSON.parse(await readFile(cfg.runtimeFile, "utf8"));
      for (const key of ["python", "adapter", "rvq_config", "rvq_weights", "dav_weights"]) {
        if (!path.isAbsolute(runtime[key] || "") || !(await stat(runtime[key])).isFile()) {
          throw new Error(`Runtime setting '${key}' must name an installed absolute file path.`);
        }
      }
      if (!runtime.encoder_repo || !runtime.encoder_revision) throw new Error("Runtime manifest needs encoder_repo and encoder_revision for provenance.");
      if (options.resumeSupported && !await options.resumeSupported()) throw new Error("The installed Music3 node does not expose resume_from.");
      const probe = await runPython(runtime.python, ["--runtime", cfg.runtimeFile, "--probe"], { timeoutMs: 30_000 });
      if (!probe.ok) throw new Error(`Runtime is missing: ${(probe.missing || []).join(", ")}`);
      value = { available: true, reason: null, encoder: { repo: runtime.encoder_repo, revision: runtime.encoder_revision },
        modes: { ...base.modes, external_audio_continuation: { ...base.modes.external_audio_continuation, available: true } } };
    } catch (e) { value = { available: false, reason: `Optional runtime unavailable: ${e.message}` }; }
    capabilityCache = { key: cacheKey, at: Date.now(), value };
    return { ...base, ...value };
  }
  async function stageSource(source, dir) {
    if (!source || typeof source !== "object") throw fault("Choose source.path, source.library_file or source.data_url.");
    const kinds = ["path", "library_file", "data_url"].filter((k) => source[k] !== undefined);
    if (kinds.length !== 1) throw fault("Provide exactly one source: path, library_file or data_url.");
    let bytes, name;
    if (kinds[0] === "data_url") {
      const data = String(source.data_url);
      if (data.length > Math.ceil(MAX_BYTES*4/3)+200) throw fault("Source exceeds 50 MB.", 413);
      const match = data.match(/^data:audio\/[\w.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/);
      if (!match) throw fault("Upload must be an audio base64 data URL.");
      bytes = Buffer.from(match[1], "base64"); name = path.basename(String(source.name || "upload.wav"));
    } else {
      let file;
      if (kinds[0] === "library_file") {
        name = String(source.library_file);
        if (!name || name !== path.basename(name) || /[\\/]/.test(name) || name.includes("..")) throw fault("Invalid library filename.");
        file = path.join(libraryDirectory, name);
      } else {
        if (!path.isAbsolute(String(source.path))) throw fault("source.path must be an absolute local audio path.");
        file = String(source.path); name = path.basename(file);
      }
      const resolved = await realpath(file);
      const info = await stat(resolved);
      if (!info.isFile() || info.size > MAX_BYTES) throw fault("Source must be an audio file under 50 MB.", 413);
      bytes = await readFile(resolved);
    }
    if (!bytes.length || bytes.length > MAX_BYTES) throw fault("Source must contain audio and be under 50 MB.", 413);
    const ext = path.extname(name).toLowerCase();
    if (![".wav", ".flac"].includes(ext)) throw fault("Experimental preparation currently accepts WAV or FLAC only.");
    const wave = ["RIFF", "RF64"].includes(bytes.toString("ascii", 0, 4)) && bytes.toString("ascii", 8, 12) === "WAVE";
    const flac = bytes.toString("ascii", 0, 4) === "fLaC";
    if (!(ext === ".wav" ? wave : flac)) throw fault("The file contents do not match WAV/FLAC audio.");
    await mkdir(dir, { recursive: true });
    const dest = path.join(dir, `source${ext}`);
    await writeFile(dest, bytes);
    return { path: dest, name, kind: kinds[0], bytes: bytes.length, sha256: hash(bytes) };
  }
  async function pump() {
    if (pumpRunning) return;
    pumpRunning = true;
    try {
      for (const row of rows.values()) {
        if (row.state !== "queued") continue;
        const controller = new AbortController(); controllers.set(row.id, controller);
        row.state = "preparing"; row.stage = "encoding";
        await save(row);
        try {
          const runtime = JSON.parse(await readFile(row.runtime_file, "utf8"));
          if (controller.signal.aborted) throw fault("Preparation cancelled.", 409);
          const result = await runPython(runtime.python, ["--runtime", row.runtime_file,
            "--source", row.source_path, "--output", row.codes_path,
            "--start", String(row.start_seconds), "--seconds", String(row.duration_seconds)],
          { signal: controller.signal });
          if (controller.signal.aborted || row.state === "cancelled") continue;
          if (!Number.isInteger(result.frames) || result.frames < 1 || result.codebooks !== 8) throw fault("Encoder returned invalid trajectory metadata.", 422);
          const encoded = await readFile(row.codes_path);
          if (!encoded.length || hash(encoded) !== result.output_sha256) throw fault("Encoded trajectory integrity check failed.", 422);
          if (result.source_sha256 !== row.source.sha256) throw fault("Source changed during preparation.", 422);
          row.encoding = result; row.state = "ready"; row.stage = "ready";
        } catch (e) {
          if (row.state !== "cancelled") { row.state = "failed"; row.stage = "failed"; row.error = e.message; }
        } finally {
          controllers.delete(row.id); row.finished_at = Date.now(); await save(row);
        }
      }
    } finally { pumpRunning = false; }
  }
  async function prepare(body, actor) {
    await initialized;
    if (body.mode && body.mode !== "continuation") throw fault("Only experimental continuation is implemented; refiner and inpainting are research-only.", 422);
    const cap = await capabilities();
    if (!cap.available) throw fault(cap.reason, 503);
    const start = finite(body.start_seconds, 0, 0, 86400, "start_seconds");
    const duration = finite(body.duration_seconds, 7.5, .25, 15, "duration_seconds");
    if ([...rows.values()].filter((r) => ["queued", "preparing"].includes(r.state)).length + admissions.size >= 4) throw fault("Four preparations are already queued; wait or cancel one.", 429);
    const reservation = Symbol(); admissions.add(reservation);
    try {
      const id = `mi_${randomUUID()}`, dir = path.join(directory, id);
      const staged = await stageSource(body.source, dir);
      // Freeze settings; later manifest edits cannot silently relabel this job.
      const runtimeFile = path.join(dir, "runtime.json");
      await copyFile(settings().runtimeFile, runtimeFile);
      const row = { id, actor, state: "queued", stage: "queued", created_at: Date.now(),
        source: { name: staged.name, kind: staged.kind, bytes: staged.bytes, sha256: staged.sha256 },
        source_path: staged.path, codes_path: path.join(dir, "reference.npz"), runtime_file: runtimeFile,
        start_seconds: start, duration_seconds: duration, render_jobs: [] };
      rows.set(id, row); admissions.delete(reservation); await save(row);
      const result = publicPrep(row);
      queueMicrotask(() => pump().catch(() => {}));
      return { job: result };
    } finally { admissions.delete(reservation); }
  }
  const parentFor = (id) => [...rows.values()].find((r) => (r.render_jobs || []).some((j) => j.id === id));
  function renderView(row, id) {
    const current = getRenderJob(id);
    const recorded = row.render_jobs.find((j) => j.id === id);
    if (current) {
      const state = current.state === "done" && !current.file
        ? (current.pendingOutput ? "running" : "failed") : current.state;
      Object.assign(recorded, { state, stage: current.pendingOutput ? "saving" : current.stage, file: current.file || null,
        error: current.state === "done" && !current.file && !current.pendingOutput
          ? "The render finished without a library output file." : current.error || null,
        stageProgress: current.stageProgress, overall: current.overall });
    }
    return { ...recorded, reference_id: row.id, experimental: true, kind: "continuation",
      url: recorded.file ? `/api/audio/${encodeURIComponent(recorded.file)}` : null,
      path: recorded.file ? path.join(libraryDirectory, recorded.file) : null,
      ...(current ? {} : !TERMINAL.has(recorded.state) ? { state: "unknown", error: "The render is no longer in this Studio session. Check the music library; it was not restarted automatically." } : {}) };
  }
  async function status(id) {
    await initialized;
    const row = rows.get(id);
    if (row) {
      for (const job of row.render_jobs) renderView(row, job.id);
      await save(row); return { job: publicPrep(row) };
    }
    const parent = parentFor(id);
    if (!parent) throw fault("Unknown music-input job.", 404);
    const job = renderView(parent, id); await save(parent); return { job };
  }
  async function continueAudio(body, actor) {
    await initialized;
    if (body.mode && body.mode !== "continuation") throw fault("Only experimental continuation is implemented; refiner and inpainting are research-only.", 422);
    const cap = await capabilities();
    if (!cap.available) throw fault(cap.reason, 503);
    const row = rows.get(String(body.reference_id));
    if (!row || row.state !== "ready") throw fault("Choose a successfully prepared reference.", 409);
    const caption = String(body.caption || "").trim();
    if (!caption || caption.length > 12000) throw fault("A caption between 1 and 12000 characters is required.");
    const seconds = finite(body.seconds, 7.5, .25, 30, "seconds");
    const seed = seedValue(body.seed), mixSeed = body.mix_seed === undefined ? seed : seedValue(body.mix_seed);
    if (!Number.isInteger(seed) || !Number.isInteger(mixSeed)) throw fault("Seeds must be integers.");
    if (hash(await readFile(row.codes_path)) !== row.encoding.output_sha256) throw fault("Prepared reference changed; prepare it again.", 409);
    const metadata = { experimental: true, mode: "external_audio_continuation", reference_id: row.id,
      source: row.source, start_seconds: row.start_seconds, selected_seconds: row.encoding.selected_seconds,
      prefix_frames: row.encoding.frames, encoder: row.encoding.encoder, revision: row.encoding.revision,
      encoding_sha256: row.encoding.output_sha256, dependency_sha256: row.encoding.dependency_sha256,
      preparation_device: "cpu", output: "new_segment_only", musical_coherence_verified: false };
    const spec = { actor, title: String(body.title || "Audio-input continuation").slice(0, 120),
      caption, lyrics: String(body.lyrics ?? "[Instrumental]").slice(0, 12000),
      instrumental: !body.lyrics || String(body.lyrics).trim() === "[Instrumental]",
      seed, mixSeed, maxDuration: seconds, steps: 20, arCfg: 1.5, flowCfg: 1.7, model: "int8",
      resumeFrom: row.codes_path, requiresLocal: true, musicInput: metadata };
    const job = enqueue(spec);
    row.render_jobs.push({ id: job.id, state: job.state, stage: job.stage, file: null,
      seed, mix_seed: mixSeed, seconds, created_at: Date.now() });
    await save(row);
    return { job: renderView(row, job.id) };
  }
  async function cancel(id) {
    await initialized;
    const row = rows.get(id);
    if (row) {
      if (["queued", "preparing"].includes(row.state)) {
        row.state = "cancelled"; row.stage = "cancelled"; row.finished_at = Date.now();
        controllers.get(id)?.abort(); await save(row);
      }
      return { job: publicPrep(row) };
    }
    const parent = parentFor(id);
    if (!parent) throw fault("Unknown music-input job.", 404);
    await cancelRenderJob(id);
    return status(id);
  }
  async function list() {
    await initialized;
    const items = [];
    for (const row of rows.values()) {
      const before = JSON.stringify(row.render_jobs);
      items.push(publicPrep(row));
      for (const child of row.render_jobs) items.push(renderView(row, child.id));
      if (JSON.stringify(row.render_jobs) !== before) await save(row);
    }
    return items.sort((a, b) => b.created_at-a.created_at).slice(0, 40);
  }
  return { capabilities, prepare, status, continue: continueAudio, cancel, list };
}

export function createMusicInputRoutes({ json, config, jobs, provenance }) {
  const service = createMusicInputService({
    directory: path.join(config.inputDir, ".music-input"), libraryDirectory: config.outputDir,
    settings: () => config.musicInput || {}, localMode: () => !config.api?.enabled,
    resumeSupported: async () => (await readFile(path.join(config.comfyDir, "comfy_extras", "nodes_minimax_music.py"), "utf8")).includes("resume_from"),
    enqueue: (spec) => jobs.enqueue(spec),
    getRenderJob: (id) => {
      const row = [jobs.current, ...jobs.queue, ...jobs.history].find((j) => j?.id === id);
      return row && { ...row, pendingOutput: jobs.current === row && row.state === "done" && !row.file };
    },
    cancelRenderJob: (id) => jobs.cancelById(id),
  });
  jobs.on?.("update", () => { service.list().catch((e) => console.warn(`  [music-input] status persistence: ${e.message}`)); });
  return async (req, res, url) => {
    if (url.pathname !== "/api/music-input") return false;
    try {
      if (req.method === "GET") { json(res, 200, { ...await service.capabilities(), jobs: await service.list() }); return true; }
      if (req.method !== "POST") { json(res, 405, { error: "Use GET or POST." }); return true; }
      // Browsers may send a cross-origin text/plain POST without preflight.
      // Refuse it before reading/uploading files or launching CPU preparation.
      // Native MCP clients have no Origin and remain valid JSON callers.
      const origin = req.headers.origin;
      if (req.headers["sec-fetch-site"] === "cross-site") throw fault("Music-input requests must come from this Studio window.", 403);
      let here;
      const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
      try {
        const host = req.headers.host;
        if (typeof host !== "string" || !host) throw new Error();
        here = new URL(`http://${host}`);
        if (!local.has(here.hostname) || here.username || here.password
          || here.pathname !== "/" || here.search || here.hash
          || host.toLowerCase() !== here.host.toLowerCase()
          || (req.socket?.localPort && Number(here.port || 80) !== req.socket.localPort)) throw new Error();
      } catch { throw fault("Music-input requests require this Studio's loopback Host and port.", 403); }
      if (origin !== undefined) {
        let allowed = false;
        try {
          const from = new URL(origin);
          allowed = typeof origin === "string" && from.protocol === "http:"
            && !from.username && !from.password && !from.search && !from.hash
            && from.pathname === "/" && origin === from.origin
            && local.has(from.hostname) && from.origin === here.origin;
        } catch { /* reject malformed or opaque origins */ }
        if (!allowed) throw fault("Music-input requests must come from this Studio window.", 403);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw fault("Music-input POST requires application/json.", 415);
      const maxRequestBytes = Math.ceil(MAX_BYTES*4/3)+4096;
      if (Number(req.headers["content-length"]) > maxRequestBytes) throw fault("Request exceeds the 50 MB audio upload limit.", 413);
      const chunks = []; let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > maxRequestBytes) throw fault("Request exceeds the 50 MB audio upload limit.", 413);
        chunks.push(part);
      }
      let b;
      try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fault("Invalid JSON request."); }
      if (!b || typeof b !== "object" || Array.isArray(b)) throw fault("Request must be a JSON object.");
      let result;
      if (b.action === "prepare") result = await service.prepare(b, provenance.actorFrom(req));
      else if (b.action === "continue") result = await service.continue(b, provenance.actorFrom(req));
      else if (b.action === "status") result = await service.status(String(b.job_id));
      else if (b.action === "cancel") result = await service.cancel(String(b.job_id));
      else throw fault("action must be prepare, continue, status or cancel. Refiner and inpainting are research-only.");
      json(res, b.action === "prepare" || b.action === "continue" ? 202 : 200, result);
    } catch (e) { json(res, e.status || 500, { error: e.message }); }
    return true;
  };
}
