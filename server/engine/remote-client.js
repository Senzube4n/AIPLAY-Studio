/** Local side of remote rendering: durable IDs, provenance and verified downloads. */
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PROTOCOL, MAX_ASSET, MAX_JSON, TERMINAL, MEDIA_EXT, endpoint, jobId, hashFile,
  readJSON, jsonStore, relativeFile, validateGraph } from "./remote-common.js";
import { buildRecord } from "./record.js";
import { checkGraph, graphTexts } from "../safety/graph.js";
import { fingerprintOf } from "../safety/minors.js";
import { announceRefusal, safetyError } from "../safety/refusal.js";
import { stripPngText } from "../pngtext.js";

/* A private job's label keeps its kind, which the page finds its own jobs by
 * ("AIPLAY image · "), and loses its words. */
const wordlessLabel = (label) => {
  const kind = /^(AIPLAY (?:image|video|music)) · /.exec(String(label || ""))?.[1];
  return `${kind || "Remote render"} · prompt not recorded`;
};

/* WHAT ONE JOB MAY HAND BACK (review S5). The worker URL is typed by the
 * person, so what answers there is not trusted to be small: a JSON answer is
 * read up to MAX_JSON and refused past it, while reading (a heap abort is not
 * catchable, and it takes the Studio down); a job lists at most MAX_OUTPUTS
 * files, MAX_JOB_BYTES in all, each of a kind the worker itself reports. A
 * manifest that breaks any of these fails the job once, in words, instead of
 * filling the disk or being downloaded again at every tick. */
export const MAX_OUTPUTS = 64;
export const MAX_JOB_BYTES = 4 * MAX_ASSET;
export const MAX_MODELS_JSON = 64 * 1024 * 1024;
export const OUTPUT_KINDS = new Set(["images", "videos", "audio", "gifs", "3d"]);

/** The body of a worker answer as JSON, refused while reading once it passes `limit`. */
export async function readJsonCapped(response, limit = MAX_JSON) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`The worker's answer is larger than ${Math.round(limit / 1048576)} MiB; it was not read.`);
  }
  if (!response.body) return JSON.parse((await response.text()) || "null");
  const reader = response.body.getReader();
  const parts = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`The worker's answer is larger than ${Math.round(limit / 1048576)} MiB; it was not read.`);
    }
    parts.push(value);
  }
  return JSON.parse(Buffer.concat(parts.map((p) => Buffer.from(p))).toString("utf8") || "null");
}

const safeOutputName = (name) => {
  try { relativeFile(name); } catch { return false; }
  return !name.includes("/") && MEDIA_EXT.test(name);
};

/** Why a completed job's output list cannot be taken, or null. */
export function manifestProblem(outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return "Worker completed without an output manifest.";
  if (outputs.length > MAX_OUTPUTS) return `The worker listed ${outputs.length} outputs for one job; at most ${MAX_OUTPUTS} are taken. Nothing was downloaded.`;
  let total = 0;
  for (const file of outputs) {
    if (!file || typeof file !== "object" || typeof file.id !== "string" || !/^[0-9]+$/.test(file.id)
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_ASSET
        || typeof file.filename !== "string" || typeof file.kind !== "string" || !OUTPUT_KINDS.has(file.kind)
        || !safeOutputName(file.filename)) {
      return "Worker returned an invalid file manifest. Nothing was downloaded.";
    }
    total += file.bytes;
  }
  if (total > MAX_JOB_BYTES) return `The worker's outputs for one job add up to ${(total / 2 ** 30).toFixed(1)} GiB; at most ${MAX_JOB_BYTES / 2 ** 30} GiB are taken. Nothing was downloaded.`;
  return null;
}

export async function createRemoteClient({ dataDir, outputDir, getToken, setToken, append,
  adopt = async () => null, fetchFn = fetch, pollMs = 2500 }) {
  const dir = path.join(dataDir, "runpod");
  let connection = await readJSON(path.join(dir, "connection.json"), {});
  const jobs = await readJSON(path.join(dir, "jobs.json"), {});
  const saveJobs = jsonStore(path.join(dir, "jobs.json"));
  const saveConnection = jsonStore(path.join(dir, "connection.json"));
  let token = await getToken();
  let polling = false, closed = false, connecting = false;
  let lastError = null;
  const active = () => Object.values(jobs).some(j => !TERMINAL.has(j.state) && j.state !== "recording");
  const request = async (route, init = {}, target = connection, auth = token) => {
    if (!target.url || !auth) throw new Error("Connect a RunPod worker first.");
    let response;
    try {
      response = await fetchFn(`${endpoint(target.url)}${route}`, { ...init,
        headers: { ...init.headers, Authorization: `Bearer ${auth}` }, redirect: "error",
        signal: init.signal || AbortSignal.timeout(30000) });
    } catch { throw new Error("Cannot reach the RunPod worker. Check its URL, availability and connection."); }
    if (!response.ok) {
      const detail = await readJsonCapped(response).catch(() => ({})) || {};
      const error = new Error(response.status === 401 ? "Worker token was rejected. Update the connection token."
        : `Worker HTTP ${response.status}: ${String(detail.error || "request failed").slice(0, 500)}`);
      error.status = response.status; throw error;
    }
    return response;
  };
  const json = async (route, init, target, auth, limit = MAX_JSON) => readJsonCapped(await request(route, init, target, auth), limit);
  const post = (route, body) => json(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const snapshot = job => ({ id: job.id, runId: job.runId, label: job.label, state: job.state, remoteState: job.remoteState,
    createdAt: job.createdAt, finishedAt: job.finishedAt, error: job.error, outputs: job.outputs || [], cancelRequested: job.cancelRequested || false });
  async function verify(target = connection, auth = token) {
    const health = await json("/v1/health", undefined, target, auth);
    if (health.protocol !== PROTOCOL || !health.workerId || !health.ready) throw new Error("This is not a compatible, ready AIPLAY worker.");
    if (target.workerId && health.workerId !== target.workerId) throw new Error("The worker identity changed. Reconnect explicitly before sending work.");
    return health;
  }
  async function connect({ url, token: entered }) {
    if (connecting) throw new Error("The worker connection is already being updated.");
    connecting = true;
    try {
      const target = { url: endpoint(url) };
      if (active()) {
        if (target.url !== connection.url) throw new Error("Wait for active jobs before changing workers. You can refresh the token for the current worker.");
        target.workerId = connection.workerId;
      }
      // Never forward an old worker's key to a different endpoint.
      const auth = typeof entered === "string" && entered.trim() ? entered.trim() : target.url === connection.url ? token : null;
      if (!auth || auth.length < 32 || /[\r\n]/.test(auth)) throw new Error("Enter the worker's token (at least 32 characters). This is not your RunPod account API key.");
      const health = await verify(target, auth);
      target.workerId = health.workerId;
      if (active() && (target.url !== connection.url || target.workerId !== connection.workerId)) throw new Error("A job started while connecting. Wait for it before changing workers.");
      await setToken(auth); await saveConnection(target);
      connection = target; token = auth; lastError = null;
      return { ...health, url: connection.url };
    } finally { connecting = false; }
  }
  async function upload(name, stream) {
    if (connecting) throw new Error("Connection is changing; try again.");
    relativeFile(name);
    if (name.includes("/") || !MEDIA_EXT.test(name)) throw new Error("Unsupported reference file.");
    await verify();
    let bytes = 0;
    const body = Readable.from((async function* () {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > MAX_ASSET) throw new Error("Input exceeds 512 MiB.");
        yield chunk;
      }
    })());
    return json(`/v1/assets?name=${encodeURIComponent(name)}`, { method: "POST", body, duplex: "half",
      signal: AbortSignal.timeout(300000), headers: { "Content-Type": "application/octet-stream" } });
  }
  async function submit({ graph, bindings = [], label = "Remote render", actor = "system", private: isPrivate = false }) {
    if (connecting) throw new Error("Connection is changing; try again.");
    validateGraph(graph);
    /* ⚠ SEXUAL CONTENT INVOLVING MINORS IS NEVER SENT TO THE POD, AND NEVER
     * FILED. The same check the local engine door runs on every graph
     * (engine/client.js dispatch, server/safety/graph.js), here because a
     * RunPod render never passes through that door: the Images and Video
     * buttons in RunPod mode, the Advanced panel's imported graphs, a script's
     * POST /api/runpod/jobs and the music queue all come through submit(). It
     * runs before the worker is asked anything, before the job is recorded and
     * before the delegate line, so a refused graph leaves no copy of its words
     * here, in jobs.json or on the Pod: only a `refused` event that names the
     * door and the code (safety/refusal.js). There is no switch. The route
     * answers 422 with the sentence (remote-routes.js). */
    const safety = checkGraph(graph);
    if (!safety.ok) {
      announceRefusal({ door: "runpod.submit", via: "runpod", actor, code: safety.code });
      throw safetyError({ door: "runpod.submit", hint: safety.hint, code: safety.code, reason: safety.reason, found: safety.found });
    }
    await verify();
    if (connecting) throw new Error("Connection is changing; try again.");
    const id = randomUUID();
    const runId = `remote-${id}`;
    /* "Don't record the prompt" (the Images screen's private switch): the
     * delegate line keeps the shape and loses the words, as the local door's
     * does (record.js), the label keeps only its kind, and the graph leaves
     * jobs.json as soon as the worker has it (tick, complete). */
    const priv = isPrivate === true;
    const record = buildRecord(graph, { runId, via: "runpod", actor, label, private: priv, enginePort: "remote", appVersion: "AIPLAY RunPod protocol 1" });
    record.remote = { workerId: connection.workerId, protocol: PROTOCOL };
    record.inputBindings = bindings;
    /* WHAT THE RENDER IS MADE FROM, WITHOUT THE WORDS (safety/lineage.js): the
     * two booleans a local render stamps on its picture or clip (art.js
     * job.safety), computed here while the words are still in hand, since a
     * private job's graph leaves jobs.json once the worker has it. adopt()
     * stamps them on the row, so an edit or a restyle of a Pod picture back
     * in full mode is judged with what it was made as. */
    const print = fingerprintOf(graphTexts(graph).positive);
    const job = { id, runId, graph, bindings, label: priv ? wordlessLabel(label) : String(label).slice(0, 160), actor, record,
      safety: print,
      ...(priv ? { private: true } : {}),
      connection: { ...connection }, state: "recording", createdAt: Date.now(), outputs: [] };
    jobs[id] = job; await saveJobs(jobs);
    await append("library", { actor, type: "delegate", asset: `engine/${runId}`, data: record });
    job.state = "submitting"; await saveJobs(jobs);
    // Return a durable ID immediately. Network submissions happen in tick, after the ledger.
    return snapshot(job);
  }
  async function download(job, file) {
    if (!/^[0-9]+$/.test(file.id) || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_ASSET) throw new Error("Worker returned an invalid file manifest.");
    relativeFile(file.filename);
    if (file.filename.includes("/") || !MEDIA_EXT.test(file.filename)) throw new Error("Unsupported output filename.");
    const relative = `remote/${job.id}/${file.id}-${file.filename}`;
    const destination = path.join(outputDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    const previous = job.outputs.find(o => o.id === file.id && o.sha256 === file.sha256);
    if (previous?.localFile) {
      /* A private picture was stripped after its check (below): the bytes on
       * disk are the kept ones. */
      const saved = path.join(outputDir, previous.localFile);
      const bytes = previous.keptBytes ?? file.bytes, sha = previous.keptSha256 ?? file.sha256;
      if ((await stat(saved).catch(() => null))?.size === bytes && await hashFile(saved) === sha) return previous;
    }
    const tmp = `${destination}.${randomUUID()}.part`;
    try {
      const response = await request(`/v1/jobs/${job.id}/files/${file.id}`, { signal: AbortSignal.timeout(600000) });
      const hash = createHash("sha256"); let bytes = 0;
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, enc, cb) {
        bytes += chunk.length;
        if (bytes > file.bytes) return cb(new Error("Download exceeds its declared size."));
        hash.update(chunk); cb(null, chunk);
      } }), createWriteStream(tmp, { flags: "wx" }));
      if (bytes !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error("Download verification failed; it will be retried without rendering again.");
      /* "DON'T RECORD THE PROMPT" HOLDS IN THE PICTURE TOO. ComfyUI's SaveImage
       * on the Pod wrote the whole graph into the PNG's text chunks, so the
       * words would travel inside the file wherever it goes (a post, a zip, a
       * backup). Stripped here, after the worker's hash was checked and before
       * the picture is adopted, as art.js strips a local private render
       * (pngtext.js: the chunk list is rewritten, the pixels are untouched, and
       * the app's own XMP disclosure stays). A strip that fails fails the
       * download, which is retried: a private picture is never adopted with
       * its words. The kept size and hash go on the row. The .part file is
       * stripped BEFORE it takes its name, so a strip that fails (a virus
       * scanner's lock) leaves no named copy with the words in it; the .part
       * is removed below whatever happens. A worker that knows `private`
       * stripped it already, and this finds nothing to take out. */
      let kept = null;
      if (job.private === true && /\.png$/i.test(destination)) {
        await stripPngText(tmp);
        kept = { keptBytes: (await stat(tmp)).size, keptSha256: await hashFile(tmp) };
      }
      await rename(tmp, destination);
      const row = { ...file, ...(kept || {}), file: path.basename(relative), subfolder: path.posix.dirname(relative), type: "output", localFile: relative, kind: file.kind.replace(/s$/, "") };
      /* The job's fingerprint (submit), or for a job recorded before it was
       * kept, its graph's while the graph is still here. */
      const safety = job.safety ?? (job.graph ? fingerprintOf(graphTexts(job.graph).positive) : null);
      const adopted = await adopt({ runId: job.runId, record: job.record, output: row, actor: job.actor,
        spec: { private: job.private === true, safety } });
      row.adoptedAs = adopted || null;
      if (adopted) row.localFile = adopted;
      delete row.relative;
      return row;
    } finally { await unlink(tmp).catch(() => {}); }
  }
  /* A private job, once this PC holds what it will keep: the worker is asked
   * to forget it (runpod-worker.js forget: its outputs on the Pod's volume and
   * ComfyUI's history entry go). A worker from before this answers 404 for the
   * operation, which is said on the job and not asked again; a failure on the
   * way is asked again at the next tick. A job the worker never answered for
   * (refused at POST /v1/jobs: 400, 422, or 409 for an id that is another
   * request's) left nothing there, and asking would name someone else's. */
  async function forgetOnPod(job) {
    if (job.private !== true || !job.remoteState || (job.podForget && job.podForget !== "pending")) return;
    try {
      await post(`/v1/jobs/${job.id}/forget`, {});
      job.podForget = "done";
    } catch (e) {
      job.podForget = e.status === 404 ? (/Unknown job/.test(e.message) ? "done" : "unsupported") : "pending";
    }
    await saveJobs(jobs);
  }
  async function complete(job, remote) {
    if (remote.state === "completed") {
      /* The whole list is judged before one byte is fetched (review S5). */
      const problem = manifestProblem(remote.outputs);
      if (problem) remote = { ...remote, state: "failed", error: problem };
    }
    if (remote.state === "completed") {
      job.state = "downloading"; await saveJobs(jobs);
      for (const file of remote.outputs) {
        const row = await download(job, file);
        job.outputs = [...job.outputs.filter(o => o.id !== row.id), row];
        await saveJobs(jobs);
      }
    }
    const result = { runId: job.runId, promptId: remote.promptId, status: remote.state,
      error: remote.error || null, outputs: job.outputs, elapsedSec: (Date.now() - job.createdAt) / 1000,
      /* Not for a private job: the executed graph is the submitted one with
       * this job's id in its prefixes, a lookup key for a guessed prompt as
       * the delegate's graphHash is (record.js). A worker that knows
       * `private` sends none. */
      remote: { workerId: connection.workerId, jobId: job.id,
        executedGraphHash: job.private === true ? null : (remote.executedGraphHash || null) } };
    await append("library", { actor: job.actor, type: "generate", asset: `engine/${job.runId}`, data: result });
    job.state = remote.state; job.error = remote.error || null; job.finishedAt = Date.now();
    if (job.private) job.graph = null;
    await saveJobs(jobs);
    await forgetOnPod(job);
  }
  async function tick() {
    if (polling || closed || connecting) return;
    polling = true;
    try {
      for (const job of Object.values(jobs)) {
        if (TERMINAL.has(job.state) && job.podForget === "pending"
            && job.connection.workerId === connection.workerId && job.connection.url === connection.url) {
          await forgetOnPod(job).catch(() => {});
          continue;
        }
        if (TERMINAL.has(job.state) || job.state === "recording") continue;
        try {
          if (job.connection.workerId !== connection.workerId || job.connection.url !== connection.url) throw new Error("Reconnect to this job's original worker to recover its outputs.");
          await verify();
          let remote;
          if (job.state === "submitting") {
            /* `private` tells the worker too (runpod-worker.js: no graph kept
             * after ComfyUI accepts it, stripped PNGs, no executedGraphHash). */
            remote = await post("/v1/jobs", { id: job.id, graph: job.graph, bindings: job.bindings, ...(job.private ? { private: true } : {}) });
          } else remote = await json(`/v1/jobs/${job.id}`);
          if (remote.id !== job.id || !["queued", "submitting", "running", ...TERMINAL].includes(remote.state)) throw new Error("Worker returned an invalid job status.");
          job.remoteState = remote.state; job.error = null; lastError = null;
          /* The worker has it: a private job's words leave jobs.json. */
          if (job.private) job.graph = null;
          if (TERMINAL.has(remote.state)) await complete(job, remote);
          else { job.state = remote.state === "submitting" ? "running" : remote.state; await saveJobs(jobs); }
        } catch (e) {
          job.error = e.message; lastError = e.message;
          // A rejected request is definite; a lost response remains retryable with the SAME ID.
          /* 422: the worker's own minors check refused it (runpod-worker.js). */
          if (job.state === "submitting" && [400, 409, 422].includes(e.status)) {
            await complete(job, { state: "failed", error: e.message });
          } else await saveJobs(jobs);
        }
      }
    } finally { polling = false; }
  }
  async function cancel(id) {
    const job = jobs[jobId(id)];
    if (!job) throw new Error("Unknown local job.");
    if (TERMINAL.has(job.state)) return snapshot(job);
    if (job.state === "recording") throw new Error("Job was not submitted because its local record could not be completed.");
    await verify();
    const remote = await post(`/v1/jobs/${id}/cancel`, {});
    job.cancelRequested = true; await saveJobs(jobs);
    return { ...snapshot(job), remoteState: remote.state };
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, pollMs); timer.unref();
  return { connect, upload, submit, cancel, tick, verify,
    /* The Pod ComfyUI's /object_info, which grows with every custom node it has. */
    models: async () => { await verify(); return json("/v1/models", undefined, connection, token, MAX_MODELS_JSON); },
    setup: async () => { await verify(); return json("/v1/setup"); },
    installBundle: async (bundle, acceptLicense) => { await verify(); return post("/v1/setup/install", { bundle, acceptLicense }); },
    cancelInstall: async () => { await verify(); return post("/v1/setup/cancel", {}); },
    status: () => ({ configured: !!connection.url, url: connection.url || "", workerId: connection.workerId || null,
      hasToken: !!token, lastError, jobs: Object.values(jobs).map(snapshot).sort((a, b) => b.createdAt - a.createdAt) }),
    file: (id, fileId) => jobs[id]?.outputs.find(f => f.id === fileId)?.localFile || null,
    close: () => { closed = true; clearInterval(timer); } };
}
