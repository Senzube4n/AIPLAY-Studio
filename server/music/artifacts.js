/** Reviewed saved stages -> immutable prepared request -> ordinary tracked job. */
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import { REPLAY_RUNTIME, REPLAY_STAGES, replayRuntime, replayModelIdentities, inspectReplaySource, verifyReplayManifest } from "./yue-artifacts.js";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const safeSource = value => { if (typeof value !== "string" || !value || /[/\\]|\.\./.test(value)) throw fail("Choose a library song filename."); return value; };
const safeId = value => { if (!/^replay_[0-9a-f]{32}$/.test(value || "")) throw fail("Invalid prepared replay id."); return value; };
const clone = value => structuredClone(value);

export function createMusicArtifacts({ appData, resolveSource, listSources = async () => [], submitReplay, readJob,
  cancelJob, record = async () => {}, runtimeInfo = () => replayRuntime(config.yue.python),
  modelIdentities = () => replayModelIdentities(config.yue.model, config.yue.vae) }) {
  const root = path.join(appData, "music-artifacts"), locks = new Map();
  async function atomic(file, value) { await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(value, null, 2)); await rename(tmp, file); }
  function lock(id, work) {
    const result = (locks.get(id) || Promise.resolve()).then(work); const settled = result.catch(() => {});
    locks.set(id, settled); settled.finally(() => { if (locks.get(id) === settled) locks.delete(id); }); return result;
  }
  async function environment() { const [runtime, weights] = await Promise.all([runtimeInfo(), modelIdentities()]); return { runtime, weights }; }
  async function resolved(file) {
    const row = await resolveSource(safeSource(file));
    if (!row?.dir || row.engine && row.engine !== "yue2") throw fail("Only saved Python YuE2 runs have this reviewed replay adapter. GGUF and Comfy runs are not accepted.", 409);
    return { file, dir: path.resolve(row.dir), runId: row.runId ?? null, sourceHash: row.sourceHash ?? null, title: row.title || file };
  }
  async function inspect(file) {
    const sourceRecord = await resolved(file), env = await environment();
    const source = await inspectReplaySource(sourceRecord.dir, env);
    return { source: sourceRecord.file, sourceRunId: sourceRecord.runId, identity: source.identity, audioSeconds: source.audioSeconds,
      runtime: source.runtime, weights: source.weights, truncated: source.truncated, stages: REPLAY_STAGES,
      files: source.files, request: source.request, generation: source.config.generation,
      note: "The plan, words and style remain frozen. A new seed can change a plan/semantic replay. Latent replay decodes the same acoustic data with the installed listening VAE; no speed or quality gain is assumed." };
  }
  const stateFile = id => path.join(root, safeId(id), "state.json");
  async function load(id) { try { return JSON.parse(await readFile(stateFile(id), "utf8")); } catch (e) { if (e.code === "ENOENT") throw fail("Prepared replay not found.", 404); throw e; } }
  function view(state, manifest) {
    return { id: state.id, state: state.state, createdAt: state.createdAt, actor: state.actor, stage: state.stage,
      source: state.source, sourceRunId: manifest?.sourceRecord.runId ?? state.sourceRunId, sourceIdentity: manifest?.source.identity ?? state.sourceIdentity,
      manifestSha256: state.ref.manifestSha256, options: manifest?.options ?? state.options,
      stages: REPLAY_STAGES[state.stage], jobId: state.jobId || null, job: state.job || null,
      error: state.error || null, cancelError: state.cancelError || null };
  }
  async function prepare(body, actor = "system") {
    const allowed = new Set(["action", "source", "stage", "seed", "narSteps", "vaeCoreFrames"]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw fail(`Replay has no editable ${key} control.`);
    if (!Object.hasOwn(REPLAY_STAGES, body.stage)) throw fail("Choose plan, semantic or latent replay.");
    const sourceRecord = await resolved(body.source), env = await environment();
    const source = await inspectReplaySource(sourceRecord.dir, env);
    const seed = body.seed ?? source.request.seed;
    if (!Number.isSafeInteger(seed) || seed < 0) throw fail("The seed must be a nonnegative safe integer.");
    const narSteps = body.narSteps ?? source.config.generation.ode_steps;
    const vaeCoreFrames = body.vaeCoreFrames ?? 512;
    if (!Number.isInteger(vaeCoreFrames) || ![256, 512, 1024].includes(vaeCoreFrames)) throw fail("Decoder tile frames must be 256, 512 or 1024.");
    if (body.stage === "latent" && (body.seed !== undefined || body.narSteps !== undefined)) throw fail("Latent replay only decodes. Seed and synthesis-step controls are not accepted.");
    if (body.stage !== "latent" && ![16, 32].includes(narSteps)) throw fail("Reviewed synthesis uses 16 or 32 steps.");
    const id = `replay_${randomUUID().replaceAll("-", "")}`, dir = path.join(root, id);
    const options = { seed, narSteps, vaeCoreFrames };
    const manifest = { v: 1, stage: body.stage, sourceDir: source.sourceDir, sourceRecord, source, options };
    const raw = JSON.stringify(manifest, null, 2), manifestPath = path.join(dir, "manifest.json");
    const manifestSha256 = createHash("sha256").update(raw).digest("hex");
    await mkdir(dir, { recursive: true }); await writeFile(manifestPath, raw, { flag: "wx" });
    const ref = { stage: body.stage, sourceDir: source.sourceDir, manifestPath, manifestSha256 };
    const state = { id, source: sourceRecord.file, sourceRunId: sourceRecord.runId, sourceIdentity: source.identity,
      stage: body.stage, state: "prepared", ref, options, createdAt: Date.now(), actor };
    await record({ op: "artifact-replay-prepare", preparedId: id, source: state.source, sourceRunId: state.sourceRunId,
      sourceIdentity: source.identity, stage: body.stage, manifestSha256, options }, actor);
    await atomic(stateFile(id), state);
    return { prepared: view(state, manifest), request: { ...source.request, seed }, runtime: REPLAY_RUNTIME, weights: source.weights };
  }
  async function render(id, actor = "system") {
    return lock(safeId(id), async () => {
      const state = await load(id);
      if (state.jobId) return { prepared: view(state), job: await readJob(state.jobId) || state.job || { id: state.jobId } };
      if (state.state !== "prepared") throw fail("This request has already attempted dispatch. Inspect the queue; prepare a new replay only if you intend another run.", 409);
      const manifest = await verifyReplayManifest(state.ref, await environment());
      const current = await resolved(state.source);
      if (current.dir !== manifest.sourceRecord.dir || current.sourceHash !== manifest.sourceRecord.sourceHash || current.runId !== manifest.sourceRecord.runId)
        throw fail("The library source changed after preparation.", 409);
      const request = manifest.source.request, options = manifest.options;
      const spec = { engine: "yue2", title: `${manifest.sourceRecord.title} · ${state.stage} replay`,
        caption: request.style, lyrics: request.lyrics, cot: request.cot, abc: request.abc ?? null,
        cfgScale: request.cfg_scale ?? null, seed: options.seed, instrumental: !request.lyrics.trim(),
        quantization: "none", narSteps: options.narSteps, vaeCoreFrames: options.vaeCoreFrames,
        wantSeconds: manifest.source.audioSeconds, maxTokens: manifest.source.config.generation.semantic.max_tokens,
        artifactReplay: state.ref, artifactSource: state.source, artifactSourceRunId: state.sourceRunId };
      state.state = "dispatching"; state.requestedBy = actor; await atomic(stateFile(id), state);
      try {
        const out = await submitReplay({ spec, actor }); const job = out?.job || out;
        if (!job?.id) throw new Error("The normal queue returned no exact job id. Inspect its queue before retrying.");
        state.jobId = job.id; state.job = clone(job); state.state = job.state || "queued";
        await atomic(stateFile(id), state);
        return { prepared: view(state, manifest), job };
      } catch (e) { state.state = "dispatch-failed"; state.error = e.message; await atomic(stateFile(id), state); throw e; }
    });
  }
  async function status(id) {
    return lock(safeId(id), async () => {
      const state = await load(id);
      if (state.jobId && !["done", "failed", "cancelled"].includes(state.state)) {
        const job = await readJob(state.jobId);
        if (job) { state.job = clone(job); state.state = job.state; await atomic(stateFile(id), state); }
        else { state.error = "The queue no longer has this job. Its source and prepared request remain; nothing was resubmitted."; }
      }
      return { prepared: view(state) };
    });
  }
  async function cancel(id, actor) {
    return lock(safeId(id), async () => {
      const state = await load(id);
      if (!state.jobId) {
        if (state.state !== "prepared") throw fail("Dispatch has an unknown outcome. Inspect the queue before cancellation.", 409);
        state.state = "cancelled";
      } else if (!["done", "failed", "cancelled"].includes(state.state)) {
        try {
          const cancelled = await cancelJob(state.jobId, actor);
          if (cancelled?.state) state.state = cancelled.state;
          state.cancelError = null;
        } catch (e) { state.cancelError = `Cancellation was not confirmed: ${e.message}. The exact job may still be running.`; }
      }
      await atomic(stateFile(id), state); return { prepared: view(state) };
    });
  }
  async function list() {
    const ids = (await readdir(root).catch(() => [])).filter(n => /^replay_[0-9a-f]{32}$/.test(n));
    const prepared = (await Promise.all(ids.map(id => load(id).then(view).catch(() => null)))).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
    return { sources: await listSources(), prepared, stages: REPLAY_STAGES, runtime: REPLAY_RUNTIME };
  }
  return { list, inspect, prepare, render, status, cancel };
}

export function createMusicArtifactRoutes({ json, readBody, actorFrom, ...options }) {
  const store = createMusicArtifacts(options);
  const route = async (req, res, url) => {
    if (url.pathname !== "/api/music-artifacts") return false;
    try {
      let result;
      if (req.method === "GET") result = url.searchParams.has("id") ? await store.status(url.searchParams.get("id")) : await store.list();
      else if (req.method === "POST") {
        const body = await readBody(req), actor = actorFrom(req);
        if (body.action === "inspect") result = { inspection: await store.inspect(body.source) };
        else if (body.action === "prepare") result = await store.prepare(body, actor);
        else if (body.action === "render") result = await store.render(body.preparedId, actor);
        else if (body.action === "status") result = await store.status(body.preparedId);
        else if (body.action === "cancel") result = await store.cancel(body.preparedId, actor);
        else throw fail("Choose inspect, prepare, render, status or cancel.");
      } else throw fail("Use GET or POST.", 405);
      json(res, 200, { ok: true, ...result });
    } catch (e) { json(res, e.status || 400, { error: e.message }); }
    return true;
  };
  route.store = store;
  return route;
}
