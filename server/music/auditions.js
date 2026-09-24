/** Persisted replacement auditions. Queueing, rendering and DSP stay in the
 * existing song pipeline; this store owns only review and the explicit choice. */
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
/* The sidecar's rights words, from the catalogue at write time (library rows recompute them). */
import { songRights, songRightsStamp } from "../models.js";
import { randomUUID, randomInt, createHash } from "node:crypto";

const active = new Set(["submitting", "queued", "generating", "composing", "cancelling"]);
const clone = value => structuredClone(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function audioName(value) {
  if (typeof value !== "string" || !value || /[/\\]|\.\./.test(value) || !/\.(flac|wav|mp3|opus)$/i.test(value)) throw fail("Choose a library audio filename.");
  return value;
}
export async function audioHash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
/** Match the submitted id, never another job that happens to be current. */
export function exactJobReceipt(job, snapshot) {
  return [snapshot.current, ...(snapshot.queue || []), ...(snapshot.history || [])].find(j => j?.id === job.id)
    || { id: job.id, state: job.state };
}
export function createAuditionSourceInspector({ library, outputDir, yueReady, minimaxReady, apiEnabled }) {
  return async (file, { hash = false, requireReplay = true } = {}) => {
    audioName(file);
    const m = library.meta.get(file), source = path.join(outputDir, file);
    const exists = await stat(source).catch(() => null);
    if (!m || !exists?.isFile()) throw fail("The original is no longer in the song library.", 404);
    const seconds = Number(m.durationSeconds) || await library.durationOf(file);
    const found = /^aiplay_yue2_([0-9a-f]{8})\.flac$/i.exec(file);
    const yueDir = m.yueDir || (found ? path.join(outputDir, "yue2", found[1]) : null);
    const info = { file, title: m.title || file, seconds, caption: m.caption || "", lyrics: m.lyrics || "",
      engine: yueDir || m.engine === "yue2" ? "yue2" : m.engine || "minimax-music3", cot: m.cot || "full", available: false };
    if (hash) info.sha256 = await audioHash(source);
    if (!requireReplay) return info;
    if (info.engine === "yue2" && yueDir) {
      const missing = [];
      for (const name of ["result.json", "semantic.npy", "plan.json", "plan_manifest.json", "prefix.npy"])
        if (!(await stat(path.join(yueDir, name)).catch(() => null))?.isFile()) missing.push(name);
      if (missing.length) info.reason = `The saved YuE2 performance is incomplete (${missing.join(", ")}). Nothing will be queued.`;
      else { const ready = await yueReady(); info.available = !!ready.installed; info.reason = info.available ? null : (ready.why || ["YuE2 Python is not installed."]).join(" "); }
    } else if (info.engine === "minimax-music3" && m.codes) {
      if (apiEnabled()) info.reason = "Saved MiniMax performances need the local music engine; API mode cannot replay them.";
      else if (!(await stat(m.codes).catch(() => null))?.isFile()) info.reason = "The saved MiniMax trajectory is missing.";
      else { info.available = await minimaxReady(); info.reason = info.available ? null : "The local MiniMax music model is not installed."; }
    } else info.reason = "Alternatives currently use saved YuE2 Python or MiniMax performances. This recording has no supported replay data; no extra model is installed automatically.";
    return info;
  };
}
/** The model's raw continuation is not the audition. Publish readiness only
 * after both seams, measured timing and provenance have been saved. */
export async function finishReplacement({ job, receipt: h, library, store, append, hashFile, modelName }) {
  const isYue = job.engine === "yue2", at = isYue ? (job.fromSeconds || 0) : (job.resumeFrames || 0) / 25;
  const base = { rawFile: h.file, runId: job.runId ?? null, seed: h.seed, engine: job.engine || "minimax-music3" };
  /* A replaced stretch of a RECORDING was read through the real-audio
   * tokenizer, whose weights are not for sale: both files keep the marker
   * songRights() reads, and the ledger row says so. */
  const tokenized = job.tokenized ? { tokenized: job.tokenized } : {};
  const stamp = songRightsStamp({ engine: base.engine, ...tokenized });
  const words = songRights({ engine: "yue2", ...tokenized }).label;
  try {
    await store.result(job.id, { ...base, state: "composing" });
    library.remember(h.file, { title: h.title, caption: job.caption, lyrics: job.lyrics, seed: h.seed,
      engine: base.engine, model: job.model, steps: h.steps, durationSeconds: h.audioSeconds,
      ...(isYue ? { yueDir: job.yue?.dir ?? null, cot: job.cot, quantization: job.quantization, rights: words } : { codes: h.codes }),
      ...tokenized, extendedFrom: job.extendedFrom, createdAt: Date.now() });
    await append({ actor: job.actor, type: "generate", asset: h.file,
      data: { model: modelName, modelVersion: isYue ? "3B" : job.model || "int8", seed: h.seed,
        runId: job.runId ?? null, extendedFrom: job.extendedFrom, op: "replace-render",
        params: { fromSeconds: at, toSeconds: job.replaceTo, cot: job.cot ?? null, narSteps: job.narSteps ?? null },
        ...(stamp ? { outputRights: stamp } : {}) } });
    const composed = await library.replaceSection(job.extendedFrom, h.file, at, job.replaceTo, { from: isYue ? at : 0, report: true });
    if (!composed?.file || !(composed.seconds > 0)) throw new Error("The replacement compositor returned no measured song.");
    const warnings = composed.shortfallSeconds > 0
      ? [`The new take is ${composed.shortfallSeconds.toFixed(2)} seconds short. The retained ending starts at ${composed.effectiveTo.toFixed(2)} seconds, earlier than the selected ${job.replaceTo.toFixed(2)} seconds.`] : [];
    library.remember(composed.file, { title: String(h.title || job.title || "Alternative").replace(/ · extended$/, " · replaced"),
      seed: h.seed, caption: job.caption, lyrics: job.lyrics, model: job.model, steps: h.steps, engine: base.engine,
      extendedFrom: job.extendedFrom, joinedAt: at, replacedTo: job.replaceTo,
      durationSeconds: composed.seconds, effectiveReplacedTo: composed.effectiveTo, shortfallSeconds: composed.shortfallSeconds,
      replacementRaw: h.file, replacementRunId: base.runId, warnings, createdAt: Date.now(), ...tokenized,
      ...(isYue ? { rights: words } : {}) });
    await append({ actor: job.actor, type: "edit", asset: composed.file,
      data: { op: "replace-section", model: modelName, derivedFrom: h.file, original: job.extendedFrom,
        runId: base.runId, seed: h.seed, requestedFrom: at, requestedTo: job.replaceTo,
        effectiveTo: composed.effectiveTo, shortfallSeconds: composed.shortfallSeconds, seconds: composed.seconds } });
    await library.save();
    return await store.result(job.id, { ...base, ...composed, warnings, sha256: await hashFile(composed.file), state: "ready" });
  } catch (e) {
    await library.save().catch(() => {});
    return store.result(job.id, { ...base, state: "failed", error: `Composition failed: ${e.message}. The original and raw render are retained.` });
  }
}
function summary(s) {
  const state = s.discarded ? "discarded" : s.chosen ? "kept" : s.takes.some(t => active.has(t.state)) ? "working"
    : s.takes.some(t => t.state === "ready") ? "review" : "failed";
  return { ...clone(s), state };
}

export function createAuditions({ dir, inspectSource, listSources = async () => [], enqueueReplacement,
  cancelJob, recordChoice = async () => {}, verifyCandidate = async () => true, now = Date.now }) {
  const file = path.join(dir, "auditions.json");
  let data, tail = Promise.resolve();
  const save = async () => {
    await mkdir(dir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, file);
  };
  const loaded = (async () => {
    try { data = JSON.parse(await readFile(file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw fail("The audition store could not be read; it was not overwritten.", 500); data = { v: 1, sessions: {}, results: {} }; }
    if (data.v !== 1 || !data.sessions || !data.results) throw fail("Unsupported audition store.", 500);
    let changed = false;
    for (const r of Object.values(data.results)) if (active.has(r.state)) {
      Object.assign(r, { state: "failed", error: "Studio restarted before this candidate finished. Its files were retained; it was not resubmitted." }); changed = true;
    }
    for (const s of Object.values(data.sessions)) for (const t of s.takes) if (active.has(t.state)) {
      Object.assign(t, { state: "failed", error: "Studio restarted before this candidate finished. Start a new audition to try again." }); s.revision++; changed = true;
    }
    if (changed) await save();
  })();
  loaded.catch(() => {}); // API calls still report it; avoid an unhandled startup rejection.
  function lock(fn) {
    const result = tail.then(async () => { await loaded; return fn(); });
    tail = result.catch(() => {}); return result;
  }
  const get = id => { const s = data.sessions[id]; if (!s) throw fail("No such audition session.", 404); return s; };
  const revision = (s, expected) => { if (!Number.isInteger(expected) || expected !== s.revision) throw fail("This audition changed. Refresh it before choosing or cancelling a take.", 409); };
  const touch = s => { s.revision++; s.updatedAt = now(); };
  function applyResult(jobId, result) {
    for (const s of Object.values(data.sessions)) for (const t of s.takes) if (t.jobId === jobId) {
      Object.assign(t, clone(result)); touch(s);
    }
  }
  async function result(jobId, patch) {
    if (typeof jobId !== "string" || !jobId) throw fail("Missing replacement job id.");
    return lock(async () => {
      const prior = data.results[jobId];
      if (prior?.state === "ready" && patch.state !== "ready") return clone(prior);
      if (prior && !active.has(prior.state) && active.has(patch.state)) return clone(prior);
      const next = { ...prior, ...clone(patch), jobId, updatedAt: now() };
      if (!active.has(next.state)) next.cancelError = null;
      if (next.state === "ready") { audioName(next.file); if (!Number.isFinite(next.seconds) || next.seconds <= 0) throw fail("A completed candidate needs a measured duration."); }
      data.results[jobId] = next; applyResult(jobId, next); await save(); return clone(next);
    });
  }
  async function create(b, actor) {
    const source = audioName(b.source);
    const info = await inspectSource(source, { hash: true });
    if (!info?.available) throw fail(info?.reason || "This source has no supported saved performance; nothing was queued.", 409);
    if (!/^[0-9a-f]{64}$/.test(info.sha256 || "")) throw fail("The source could not be fingerprinted; nothing was queued.", 409);
    const from = b.fromSeconds, to = b.toSeconds, count = b.count ?? 2;
    // The existing continuation driver clamps starts to 1..duration-1. Refuse
    // outside that interval here instead of moving the user's selected region.
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || from > info.seconds - 1 || to > info.seconds
      || to <= from + 0.5) throw fail("Choose a region inside the song, starting at least 1 second in, longer than half a second.");
    if (![2, 3].includes(count)) throw fail("Choose two or three alternatives.");
    const contextSeconds = b.contextSeconds ?? 3;
    if (!Number.isFinite(contextSeconds) || contextSeconds < 0 || contextSeconds > 15) throw fail("Seam context must be from 0 to 15 seconds.");
    const seeds = b.seeds ?? Array.from({ length: count }, () => randomInt(0, 4294967296));
    if (!Array.isArray(seeds) || seeds.length !== count || new Set(seeds).size !== count
      || seeds.some(n => !Number.isInteger(n) || n < 0 || n > 4294967295)) throw fail("Give one distinct seed per take, each from 0 to 4294967295.");
    const settings = {};
    for (const [key, max] of [["caption", 10000], ["lyrics", 20000], ["abc", 65536]]) {
      const value = b[key] ?? (key === "abc" ? undefined : info[key]);
      if (value !== undefined) { if (typeof value !== "string" || value.length > max) throw fail(`${key} is too long or is not text.`); settings[key] = value; }
    }
    if (settings.abc?.trim() && info.engine !== "yue2") throw fail("A supplied ABC score is supported only for a YuE2 Python source.");
    if (settings.abc?.trim() && info.cot === "off") throw fail("This source was made with score planning off. A supplied ABC score requires a source with cot full or melody.");
    const session = await lock(async () => {
      if (Object.keys(data.sessions).length >= 200) throw fail("The audition shelf has reached 200 sessions.", 409);
      const id = `aud_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const s = { id, revision: 1, source, sourceHash: info.sha256, title: info.title || source, engine: info.engine,
        sourceSeconds: info.seconds, fromSeconds: from, toSeconds: to, contextSeconds, settings, actor,
        createdAt: now(), updatedAt: now(), chosen: null, takes: seeds.map((seed, i) => ({ id: `take${i + 1}`, label: String.fromCharCode(65 + i), seed, state: "submitting", jobId: null })) };
      data.sessions[id] = s; await save(); return clone(s);
    });
    // Never hold the persistence lock while calling the API: it records the
    // job receipt and may finish a synthetic/cached job before replying.
    for (const take of session.takes) {
      const cancelled = await lock(() => !!get(session.id).cancelRequested);
      if (cancelled) {
        await lock(async () => { const s = get(session.id), t = s.takes.find(x => x.id === take.id); t.state = "cancelled"; touch(s); await save(); }); continue;
      }
      try {
        const current = await inspectSource(source, { hash: true });
        if (!current.available || current.sha256 !== session.sourceHash) throw fail("The source or its replay support changed while this audition was being queued.", 409);
        const reply = await enqueueReplacement({ file: source, fromSeconds: from, toSeconds: to, ...settings, seed: take.seed }, actor);
        const jobId = reply?.job?.id || reply?.id;
        if (!jobId) throw fail("The replacement request returned no exact job id. Check the queue before retrying.", 502);
        const stop = await lock(async () => {
          const s = get(session.id), t = s.takes.find(x => x.id === take.id);
          Object.assign(t, { jobId, state: "queued" }, clone(data.results[jobId] || {}));
          touch(s); await save(); return !!s.cancelRequested;
        });
        if (stop) {
          // A refused cancellation is not a failed render. Keep its exact
          // receipt live and let subsequent queue/composition updates land.
          try {
            const out = await cancelJob(jobId);
            if (["cancelled", "failed", "cancelling"].includes(out?.state)) await result(jobId, { state: out.state });
          } catch (e) {
            await lock(async () => { const s = get(session.id), t = s.takes.find(x => x.id === take.id);
              t.cancelError = `Cancellation was not confirmed: ${e.message}. This job may still be running.`; touch(s); await save(); });
          }
        }
      } catch (e) {
        await lock(async () => { const s = get(session.id), t = s.takes.find(x => x.id === take.id); Object.assign(t, { state: "failed", error: e.message }); touch(s); await save(); });
      }
    }
    return read(session.id);
  }
  const read = id => lock(() => summary(get(id)));
  async function observe(snapshot) {
    const jobs = [snapshot.current, ...(snapshot.queue || []), ...(snapshot.history || [])].filter(Boolean);
    for (const job of jobs) {
      const old = await lock(() => clone(data.results[job.id]));
      if (!old || !active.has(old.state)) continue;
      if (job.state === "done" && (!job.file || job.cached)) {
        await result(job.id, { state: "failed", error: job.cached ? "The model reused a cached render; no new alternative was generated. Start a fresh audition with new seeds." : "The model finished without an audio file; no candidate could be composed." });
        continue;
      }
      const state = job.state === "done" ? "composing" : job.state === "running" ? "generating"
        : ["failed", "cancelled", "cancelling"].includes(job.state) ? job.state : "queued";
      if (old.state !== state) await result(job.id, { state, ...(job.error ? { error: job.error } : {}) });
    }
  }
  async function keep(b, actor) {
    return lock(async () => {
      const s = get(b.id); revision(s, b.revision);
      if (s.discarded) throw fail("This session was discarded.", 409);
      const t = s.takes.find(x => x.id === b.takeId);
      if (!t || t.state !== "ready" || !t.file) throw fail("Only a fully composed, ready take can be kept.", 409);
      const source = await inspectSource(s.source, { hash: true, requireReplay: false });
      if (source.sha256 !== s.sourceHash) throw fail("The original source changed. Start a new audition rather than choosing against a different song.", 409);
      if (!(await verifyCandidate(t))) throw fail("The candidate file is missing or changed; it cannot be kept.", 409);
      if (t.shortfallSeconds > 0 && b.acknowledgeShort !== true) throw fail(`This take is ${t.shortfallSeconds.toFixed(2)} seconds short and its ending returns earlier. Listen and acknowledge that before keeping it.`, 409);
      if (s.chosen === t.id) return summary(s);
      await recordChoice({ sessionId: s.id, source: s.source, sourceHash: s.sourceHash, fromSeconds: s.fromSeconds,
        toSeconds: s.toSeconds, candidate: t.file, takeId: t.id, jobId: t.jobId, runId: t.runId, seed: t.seed,
        shortfallSeconds: t.shortfallSeconds || 0, seconds: t.seconds, acknowledgeShort: b.acknowledgeShort === true }, actor);
      s.chosen = t.id; s.chosenBy = actor; s.chosenAt = now(); touch(s); await save(); return summary(s);
    });
  }
  async function cancel(b) {
    const ids = await lock(async () => {
      const s = get(b.id); revision(s, b.revision); s.cancelRequested = true; touch(s); await save();
      return s.takes.filter(t => active.has(t.state) && t.jobId).map(t => t.jobId);
    });
    for (const id of ids) { const out = await cancelJob(id); if (["cancelled", "failed"].includes(out?.state)) await result(id, { state: out.state }); }
    return read(b.id);
  }
  async function discard(b) {
    return lock(async () => {
      const s = get(b.id); revision(s, b.revision);
      if (s.takes.some(t => active.has(t.state))) throw fail("Cancel or finish the pending takes before discarding this session.", 409);
      if (s.chosen) throw fail("This session has a kept take; its choice record is retained.", 409);
      s.discarded = true; touch(s); await save(); return summary(s);
    });
  }
  return { create, read, result, observe, keep, cancel, discard,
    jobResult: id => lock(() => clone(data.results[id] || null)),
    async list() { const sessions = await lock(() => Object.values(data.sessions).sort((a, b) => b.createdAt - a.createdAt).map(summary)); return { sessions, sources: await listSources() }; },
    inspect: source => inspectSource(audioName(source), { hash: false }),
  };
}

export function createAuditionRoutes({ store, readBody, json, actorFrom }) {
  return async (req, res, url) => {
    if (url.pathname !== "/api/music-auditions") return false;
    try {
      if (req.method === "GET") {
        const id = url.searchParams.get("id"), job = url.searchParams.get("jobId"), source = url.searchParams.get("source");
        const body = id ? { session: await store.read(id) } : job ? { result: await store.jobResult(job) } : source ? { source: await store.inspect(source) } : await store.list();
        json(res, 200, { ok: true, ...body }); return true;
      }
      if (req.method !== "POST") { json(res, 405, { error: "Use GET or POST." }); return true; }
      const b = await readBody(req), actor = actorFrom(req);
      if (!["create", "status", "keep", "cancel", "discard"].includes(b.action)) throw fail("Choose create, status, keep, cancel or discard.");
      const session = b.action === "status" ? await store.read(b.id) : await store[b.action](b, actor);
      json(res, 200, { ok: true, session });
    } catch (e) { json(res, Number.isInteger(e.status) ? e.status : 500, { error: e.message }); }
    return true;
  };
}
