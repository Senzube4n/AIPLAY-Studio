/** Paired listening experiments use Studio's normal music queue. Ratings are
 * human observations, never conclusions inferred from loss or file metrics. */
import { mkdir, readFile, readdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, randomInt } from "node:crypto";

const active = new Set(["submitting", "queued", "running", "cancelling"]);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = value => structuredClone(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (v, name, max = 2000, empty = false) => {
  if (typeof v !== "string" || v.includes("\0") || v.length > max || (!empty && !v.trim())) fail(`${name} must be ${empty ? "" : "nonempty "}text, at most ${max} characters.`);
  return v;
};
const number = (v, name, min, max, integer = false) => {
  if (!Number.isFinite(v) || v < min || v > max || integer && !Number.isInteger(v)) fail(`${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
  return v;
};
const key = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : fail("Use an idempotency key of 1–100 letters, numbers, _ or -.");
const id = v => typeof v === "string" && /^lab-[a-f0-9]{24}$/.test(v) ? v : fail("Choose a valid listening experiment id.");
const audio = v => typeof v === "string" && !/[/\\]|\.\./.test(v) && /\.(flac|wav|mp3|opus)$/i.test(v) ? v : fail("Choose a library audio filename.");
const digest = v => /^[a-f0-9]{64}$/i.test(v || "");
function only(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Expected an experiment request.");
  const extra = Object.keys(body).filter(k => !fields.includes(k));
  if (extra.length) fail(`Unsupported listening lab fields: ${extra.join(", ")}.`);
}
export const LISTENING_NOTE = "This compares new renders using the same prompts, seed and settings. It does not preserve a singer or source waveform, prove adapter quality, or guarantee identical audio length. Labels are hidden inside this lab; Studio's queue and provenance still expose render settings.";

export function listeningCase(input, index) {
  only(input, ["name", "caption", "lyrics", "seed", "maxDuration", "narSteps", "cot", "instrumental", "reference"]);
  const instrumental = input.instrumental ?? false;
  if (typeof instrumental !== "boolean") fail("instrumental must be boolean.");
  const lyrics = text(input.lyrics ?? "", "Evaluation lyrics", 8000, true);
  if (instrumental && lyrics.trim()) fail("Clear evaluation lyrics before selecting Instrumental.");
  if (!instrumental && !lyrics.trim()) fail("Each vocal evaluation needs lyrics; choose Instrumental explicitly otherwise.");
  const cot = input.cot ?? "full";
  if (!["full", "melody", "off"].includes(cot)) fail("Choose full, melody or off planning.");
  return { id: `case${index + 1}`, name: text(input.name, "Evaluation name", 120),
    caption: text(input.caption, "Evaluation style", 2000), lyrics, instrumental, cot,
    seed: number(input.seed, "Seed", 0, 4294967295, true),
    maxDuration: number(input.maxDuration ?? 60, "Duration ceiling", 30, 300),
    narSteps: number(input.narSteps ?? 32, "Solver steps", 8, 64, true),
    ...(input.reference ? { reference: input.reference } : {}) };
}

/** Explicit empty adapters prevent saved Music choices contaminating the base. */
export function listeningPairRequests(experiment, evaluation) {
  const shared = { engine: "yue2-comfy", checkpoint: experiment.checkpoint.name,
    caption: evaluation.caption, lyrics: evaluation.lyrics, seed: evaluation.seed, mixSeed: evaluation.seed,
    maxDuration: evaluation.maxDuration, narSteps: evaluation.narSteps, cot: evaluation.cot,
    instrumental: evaluation.instrumental, preview: false, loraClip: "", loraClipStrength: 0 };
  return { base: { ...shared, lora: "", loraStrength: 0 },
    adapter: { ...shared, lora: experiment.adapter.name, loraStrength: experiment.strength } };
}

export function createListeningLab({ appData, capabilities, inspectSource, submitGenerate, readJob, cancelJob,
  recordEvent = async () => {}, now = Date.now, random = () => randomInt(2) }) {
  const directory = path.join(appData, "music-listening-lab"), locks = new Map(), initialized = new Set();
  const file = value => path.join(directory, `${id(value)}.json`);
  async function save(row) {
    await mkdir(directory, { recursive: true }); const temp = `${file(row.id)}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(row, null, 2)); await rename(temp, file(row.id)); }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  async function load(value) {
    let row;
    try { row = JSON.parse(await readFile(file(value), "utf8")); }
    catch (error) { if (error.code === "ENOENT") fail("No such listening experiment.", 404); fail("The experiment could not be read; it was not overwritten.", 500); }
    if (row.v !== 1 || row.id !== value || !Array.isArray(row.cases)) fail("Unsupported experiment record.", 500);
    if (!initialized.has(value)) {
      initialized.add(value); let changed = false;
      for (const take of row.takes) if (active.has(take.state)) {
        take.state = "interrupted"; take.error = "Studio restarted before this job was reconciled. Refresh to recover its exact job if available; no render was resubmitted."; changed = true;
      }
      if (changed) { touch(row); await save(row); }
    }
    return row;
  }
  function lock(value, fn) {
    const prior = locks.get(value) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn); locks.set(value, next);
    next.finally(() => { if (locks.get(value) === next) locks.delete(value); }).catch(() => {});
    return next;
  }
  const touch = row => { row.revision++; row.updatedAt = now(); };
  const revision = (row, expected) => { if (row.revision !== expected) fail("This experiment changed. Refresh before applying your action.", 409); };
  function view(row) {
    const out = clone(row); delete out.createHash;
    out.takes = out.takes.map(take => {
      if (!row.revealed) { delete take.role; delete take.request; }
      return take;
    });
    out.state = row.takes.some(t => active.has(t.state)) ? "working"
      : row.takes.some(t => ["submission_unknown", "interrupted"].includes(t.state)) ? "attention"
        : row.takes.every(t => t.state === "planned") ? "planned"
          : row.takes.every(t => t.state === "ready") ? "review"
            : row.cancelRequested ? "cancelled" : "incomplete";
    out.note = LISTENING_NOTE; return out;
  }
  async function region(input, name) {
    only(input, ["file", "startSeconds", "seconds"]);
    const filename = audio(input.file), source = await inspectSource(filename);
    if (!source || !digest(source.sha256) || !Number.isFinite(source.seconds) || source.seconds <= 0) fail(`${name} could not be measured and fingerprinted.`, 409);
    const startSeconds = number(input.startSeconds, `${name} start`, 0, source.seconds);
    const seconds = number(input.seconds, `${name} length`, .25, source.seconds);
    if (startSeconds + seconds > source.seconds + .001) fail(`${name} ends outside the recording.`);
    return { file: filename, startSeconds, seconds, sourceSeconds: source.seconds, sha256: source.sha256, title: source.title || filename };
  }
  async function selected(adapterName, checkpointName) {
    const cap = await capabilities({ adapter: adapterName, checkpoint: checkpointName });
    if (cap.engine !== "yue2-comfy" || !cap.ready) fail(cap.reason || "The installed ComfyUI YuE2 adapter path is not ready.", 409);
    const adapter = cap.adapters?.find(a => a.name === adapterName), checkpoint = cap.checkpoints?.find(c => c.name === checkpointName);
    if (!adapter?.identity || !checkpoint?.identity) fail("Choose an installed compatible training adapter and checkpoint with verified identities.", 409);
    return { adapter: clone(adapter), checkpoint: clone(checkpoint) };
  }
  async function verify(row) {
    const assets = await selected(row.adapter.name, row.checkpoint.name);
    if (assets.adapter.identity !== row.adapter.identity || assets.checkpoint.identity !== row.checkpoint.identity) fail("Adapter or checkpoint changed since review. Create a new experiment.", 409);
    for (const source of [row.trainingSource, ...row.cases.map(c => c.reference).filter(Boolean)]) {
      if ((await inspectSource(source.file))?.sha256 !== source.sha256) fail("A saved training or evaluation recording changed. Create a new experiment.", 409);
    }
  }
  const event = (row, actor, op, data = {}) => recordEvent({ actor, type: "choice", asset: row.trainingSource.file,
    data: { op, experimentId: row.id, adapter: row.adapter.name, adapterIdentity: row.adapter.identity,
      checkpoint: row.checkpoint.name, checkpointIdentity: row.checkpoint.identity, sourceSha256: row.trainingSource.sha256, ...data } });
  async function create(body, actor) {
    only(body, ["action", "idempotencyKey", "name", "purpose", "adapter", "checkpoint", "strength", "trainingSource", "cases"]);
    const value = `lab-${hash(key(body.idempotencyKey)).slice(0, 24)}`, inputHash = hash(body);
    return lock(value, async () => {
      const prior = await load(value).catch(error => { if (error.status !== 404) throw error; return null; });
      if (prior) { if (prior.createHash !== inputHash) fail("This creation key already describes a different experiment.", 409); return { experiment: view(prior), replayed: true }; }
      const assets = await selected(text(body.adapter, "Adapter filename", 255), text(body.checkpoint, "Checkpoint filename", 255));
      const training = assets.adapter.training;
      const sourceInput = body.trainingSource || (training?.file ? { file: training.file, startSeconds: training.startSeconds, seconds: training.seconds } : null);
      if (!sourceInput) fail("Choose the actual training recording and region. Without a training receipt this is recorded as your declaration.");
      const trainingSource = await region(sourceInput, "Training region");
      const verified = training?.file === trainingSource.file && training.startSeconds === trainingSource.startSeconds
        && training.seconds === trainingSource.seconds && training.sourceSha256 === trainingSource.sha256;
      trainingSource.evidence = verified ? "verified_training_receipt" : "user_declared";
      if (verified) trainingSource.runId = training.runId || null;
      if (!Array.isArray(body.cases) || !body.cases.length || body.cases.length > 8) fail("Give 1–8 separate evaluation cases.");
      const cases = [];
      for (let i = 0; i < body.cases.length; i++) {
        const c = listeningCase(body.cases[i], i);
        if (c.reference) {
          c.reference = await region(c.reference, "Evaluation reference");
          if (c.reference.file === trainingSource.file && c.reference.startSeconds < trainingSource.startSeconds + trainingSource.seconds
              && trainingSource.startSeconds < c.reference.startSeconds + c.reference.seconds) fail("The evaluation reference overlaps the training region. Choose held-out audio or a separate recording.");
        }
        cases.push(c);
      }
      const strength = number(body.strength ?? 1, "Adapter strength", -4, 4);
      if (strength === 0) fail("Use a nonzero adapter strength for a comparison.");
      const row = { v: 1, id: value, revision: 1, createHash: inputHash, name: text(body.name, "Experiment name", 120),
        purpose: text(body.purpose, "Evaluation purpose"), ...assets, strength, trainingSource, cases,
        createdAt: now(), updatedAt: now(), createdBy: actor, revealed: false, cancelRequested: false, submission: null, takes: [], ratings: [] };
      for (const c of cases) {
        const requests = listeningPairRequests(row, c), roles = random() ? ["adapter", "base"] : ["base", "adapter"];
        roles.forEach((role, i) => { const label = i ? "B" : "A";
          row.takes.push({ id: `${c.id}-${label}`, caseId: c.id, label, role, state: "planned", jobId: null,
            request: { ...requests[role], title: `Listening lab ${value.slice(-6)} · ${c.name} · ${label}` } });
        });
      }
      await event(row, actor, "listening-lab-create", { caseCount: cases.length, trainingEvidence: trainingSource.evidence });
      await save(row); initialized.add(value); return { experiment: view(row) };
    });
  }
  async function updateTake(value, takeId, patch) {
    return lock(value, async () => {
      const row = await load(value), take = row.takes.find(t => t.id === takeId);
      // A faulty/older API can return the active job instead of the newly
      // queued one. Claim each receipt only once, atomically with saving it.
      if (patch.jobId && row.takes.some(t => t.id !== takeId && t.jobId === patch.jobId))
        throw new Error(`Duplicate queue receipt: job ${patch.jobId} already belongs to another take. The new submission is uncertain; inspect Studio's queue before starting another experiment.`);
      if (take.state === "ready" && ["submitting", "queued", "running", "cancelled", "cancelling"].includes(patch.state)) return row;
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(take[key]) === JSON.stringify(value))) return row;
      Object.assign(take, patch); touch(row); await save(row); return row;
    });
  }
  async function cancelOne(value, take) {
    try {
      const result = await cancelJob(take.jobId);
      if (["cancelled", "failed", "cancelling"].includes(result?.state)) await updateTake(value, take.id, { state: result.state, cancelError: null });
    } catch (error) { await updateTake(value, take.id, { cancelError: `Cancellation was not confirmed: ${error.message}. This exact job may still be running.` }); }
  }
  async function start(body, actor) {
    only(body, ["action", "id", "expectedRevision", "idempotencyKey"]); const value = id(body.id), token = key(body.idempotencyKey);
    const started = await lock(value, async () => {
      const row = await load(value);
      if (row.submission) { if (row.submission.key !== token) fail("This experiment already has a submission. Refresh it; create another experiment for new renders.", 409); return { row, replayed: true }; }
      revision(row, body.expectedRevision); await verify(row);
      if (row.cancelRequested) fail("This experiment was cancelled; create another to render.", 409);
      await event(row, actor, "listening-lab-start", { cases: row.cases.map(c => ({ id: c.id, seed: c.seed })), jobs: row.takes.length });
      row.submission = { key: token, actor, at: now() }; touch(row); await save(row); return { row };
    });
    if (started.replayed) return { experiment: view(started.row), replayed: true };
    for (const planned of started.row.takes) {
      const row = await lock(value, () => load(value));
      if (row.cancelRequested) { await updateTake(value, planned.id, { state: "cancelled" }); continue; }
      let submitting = false;
      try {
        await verify(row); await updateTake(value, planned.id, { state: "submitting" });
        submitting = true;
        const receipt = await submitGenerate({ request: clone(planned.request), actor, requestId: `${value}/${planned.id}` });
        const jobId = receipt?.job?.id || receipt?.id;
        if (typeof jobId !== "string" || !jobId) throw new Error("No exact job receipt returned. Check Studio's queue before starting another experiment.");
        const latest = await updateTake(value, planned.id, { state: "queued", jobId });
        if (latest.cancelRequested) await cancelOne(value, { ...planned, jobId });
      } catch (error) {
        await updateTake(value, planned.id, { state: !submitting || error.definitelyNotQueued ? "failed" : "submission_unknown", error: error.message });
        // An uncertain enqueue is never retried; stop the remaining submissions.
        await lock(value, async () => { const latest = await load(value); latest.cancelRequested = true;
          for (const t of latest.takes) if (t.state === "planned") t.state = "cancelled"; touch(latest); await save(latest); });
        break;
      }
    }
    return get(value);
  }
  async function refresh(value) {
    const row = await lock(value, () => load(value));
    for (const take of row.takes.filter(t => t.jobId && t.state !== "cancelled")) {
      const job = await readJob(take.jobId);
      if (!job) continue;
      if (job.id !== take.jobId) fail("Queue returned a different job; this experiment was not changed.", 502);
      const state = job.state || job.status;
      if (state === "done" || state === "ready") {
        const seconds = job.seconds ?? job.audioSeconds;
        if (!job.file || !Number.isFinite(seconds) || seconds <= 0 || !digest(job.sha256)) {
          if (take.state !== "ready") await updateTake(value, take.id, { state: "running", error: "Waiting for measured audio and its fingerprint." });
          continue;
        }
        audio(job.file);
        if (take.sha256 && (take.file !== job.file || take.sha256 !== job.sha256)) {
          await updateTake(value, take.id, { state: "failed", error: "The audition file changed after completion; its earlier ratings are retained as history." }); continue;
        }
        await updateTake(value, take.id, { state: "ready", file: job.file, seconds, sha256: job.sha256, runId: job.runId || null, cached: !!job.cached, error: null });
      } else if (["queued", "running", "failed", "cancelled", "cancelling"].includes(state) && take.state !== "ready")
        await updateTake(value, take.id, { state, error: job.error || null });
    }
    return get(value);
  }
  async function mutate(body, actor) {
    const value = id(body.id);
    return lock(value, async () => {
      const row = await load(value); revision(row, body.expectedRevision);
      if (body.action === "reveal") {
        only(body, ["action", "id", "expectedRevision"]);
        if (!row.revealed) { await event(row, actor, "listening-lab-reveal"); row.revealed = true; row.revealedAt = now(); row.revealedBy = actor; }
      } else if (body.action === "rate") {
        only(body, ["action", "id", "expectedRevision", "caseId", "preference", "ratings", "unwantedChanges", "notes"]);
        const takes = row.takes.filter(t => t.caseId === body.caseId);
        if (takes.length !== 2 || takes.some(t => t.state !== "ready")) fail("Both takes must have measured, completed audio before rating this pair.", 409);
        for (const take of takes) {
          const actual = await inspectSource(take.file);
          if (actual?.sha256 !== take.sha256) fail("A take is missing or changed; refresh before rating.", 409);
        }
        if (!["A", "B", "tie", "neither"].includes(body.preference)) fail("Choose A, B, tie or neither.");
        only(body.ratings || {}, ["A", "B"]); only(body.unwantedChanges || {}, ["A", "B"]);
        const rating = { caseId: body.caseId, preference: body.preference,
          ratings: { A: number(body.ratings?.A, "A rating", 1, 5, true), B: number(body.ratings?.B, "B rating", 1, 5, true) },
          unwantedChanges: { A: text(body.unwantedChanges?.A || "", "A unwanted changes", 2000, true), B: text(body.unwantedChanges?.B || "", "B unwanted changes", 2000, true) },
          notes: text(body.notes || "", "Listening notes", 4000, true), blinded: !row.revealed, actor, at: now(),
          takes: takes.map(t => ({ label: t.label, jobId: t.jobId, sha256: t.sha256 })) };
        await event(row, actor, "listening-lab-rating", rating); row.ratings.push(rating);
      } else fail("Choose rate or reveal.");
      touch(row); await save(row); return { experiment: view(row) };
    });
  }
  async function cancel(body, actor) {
    only(body, ["action", "id", "expectedRevision"]); const value = id(body.id);
    const row = await lock(value, async () => {
      const row = await load(value); revision(row, body.expectedRevision);
      await event(row, actor, "listening-lab-cancel"); row.cancelRequested = true;
      for (const take of row.takes) if (take.state === "planned") take.state = "cancelled";
      touch(row); await save(row); return row;
    });
    for (const take of row.takes.filter(t => t.jobId && active.has(t.state))) await cancelOne(value, take);
    return get(value);
  }
  const get = value => lock(id(value), async () => ({ experiment: view(await load(value)) }));
  async function list() {
    const names = await readdir(directory).catch(() => []), experiments = [], errors = [];
    for (const name of names.filter(n => /^lab-[a-f0-9]{24}\.json$/.test(n)).slice(0, 300)) {
      try { const row = (await get(name.slice(0, -5))).experiment; experiments.push({ id: row.id, name: row.name, revision: row.revision, state: row.state, createdAt: row.createdAt, revealed: row.revealed }); }
      catch (e) { errors.push({ id: name.slice(0, -5), error: e.message }); }
    }
    return { experiments: experiments.sort((a, b) => b.createdAt - a.createdAt), capabilities: await capabilities(), errors, note: LISTENING_NOTE };
  }
  async function request(body, actor = "system") {
    const action = body?.action;
    if (action === "list") { only(body, ["action"]); return list(); }
    if (action === "get" || action === "refresh") { only(body, ["action", "id"]); return action === "get" ? get(body.id) : refresh(id(body.id)); }
    if (action === "create") return create(body, actor);
    if (action === "start") return start(body, actor);
    if (action === "cancel") return cancel(body, actor);
    if (action === "rate" || action === "reveal") return mutate(body, actor);
    fail("Choose list, get, create, start, refresh, cancel, rate or reveal.");
  }
  return { request, get, list, refresh };
}

export function createListeningLabRoutes({ json, readBody, actorFrom, ...dependencies }) {
  const store = createListeningLab(dependencies);
  const route = async (req, res, url) => {
    if (url.pathname !== "/api/music-listening-lab") return false;
    try {
      const body = req.method === "GET" ? url.searchParams.has("id") ? { action: "get", id: url.searchParams.get("id") } : { action: "list" }
        : req.method === "POST" ? await readBody(req, 192 * 1024) : fail("Use GET or POST.", 405);
      json(res, 200, { ok: true, ...await store.request(body, actorFrom(req)) });
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
    return true;
  };
  route.store = store; return route;
}
