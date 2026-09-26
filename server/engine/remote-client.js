/** Local side of remote rendering: durable IDs, provenance and verified downloads. */
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PROTOCOL, MAX_ASSET, TERMINAL, MEDIA_EXT, endpoint, jobId, hashFile,
  readJSON, jsonStore, relativeFile, validateGraph } from "./remote-common.js";
import { buildRecord } from "./record.js";

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
      const detail = await response.json().catch(() => ({}));
      const error = new Error(response.status === 401 ? "Worker token was rejected. Update the connection token."
        : `Worker HTTP ${response.status}: ${String(detail.error || "request failed").slice(0, 500)}`);
      error.status = response.status; throw error;
    }
    return response;
  };
  const json = async (route, init, target, auth) => (await request(route, init, target, auth)).json();
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
  async function submit({ graph, bindings = [], label = "Remote render", actor = "system" }) {
    if (connecting) throw new Error("Connection is changing; try again.");
    validateGraph(graph);
    await verify();
    if (connecting) throw new Error("Connection is changing; try again.");
    const id = randomUUID();
    const runId = `remote-${id}`;
    const record = buildRecord(graph, { runId, via: "runpod", actor, label, enginePort: "remote", appVersion: "AIPLAY RunPod protocol 1" });
    record.remote = { workerId: connection.workerId, protocol: PROTOCOL };
    record.inputBindings = bindings;
    const job = { id, runId, graph, bindings, label: String(label).slice(0, 160), actor, record,
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
      const saved = path.join(outputDir, previous.localFile);
      if ((await stat(saved).catch(() => null))?.size === file.bytes && await hashFile(saved) === file.sha256) return previous;
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
      await rename(tmp, destination);
      const row = { ...file, file: path.basename(relative), subfolder: path.posix.dirname(relative), type: "output", localFile: relative, kind: file.kind.replace(/s$/, "") };
      const adopted = await adopt({ runId: job.runId, record: job.record, output: row, actor: job.actor, spec: {} });
      row.adoptedAs = adopted || null;
      if (adopted) row.localFile = adopted;
      delete row.relative;
      return row;
    } finally { await unlink(tmp).catch(() => {}); }
  }
  async function complete(job, remote) {
    if (remote.state === "completed") {
      job.state = "downloading"; await saveJobs(jobs);
      if (!remote.outputs?.length) throw new Error("Worker completed without an output manifest.");
      for (const file of remote.outputs) {
        const row = await download(job, file);
        job.outputs = [...job.outputs.filter(o => o.id !== row.id), row];
        await saveJobs(jobs);
      }
    }
    const result = { runId: job.runId, promptId: remote.promptId, status: remote.state,
      error: remote.error || null, outputs: job.outputs, elapsedSec: (Date.now() - job.createdAt) / 1000,
      remote: { workerId: connection.workerId, jobId: job.id, executedGraphHash: remote.executedGraphHash || null } };
    await append("library", { actor: job.actor, type: "generate", asset: `engine/${job.runId}`, data: result });
    job.state = remote.state; job.error = remote.error || null; job.finishedAt = Date.now(); await saveJobs(jobs);
  }
  async function tick() {
    if (polling || closed || connecting) return;
    polling = true;
    try {
      for (const job of Object.values(jobs)) {
        if (TERMINAL.has(job.state) || job.state === "recording") continue;
        try {
          if (job.connection.workerId !== connection.workerId || job.connection.url !== connection.url) throw new Error("Reconnect to this job's original worker to recover its outputs.");
          await verify();
          let remote;
          if (job.state === "submitting") {
            remote = await post("/v1/jobs", { id: job.id, graph: job.graph, bindings: job.bindings });
          } else remote = await json(`/v1/jobs/${job.id}`);
          if (remote.id !== job.id || !["queued", "submitting", "running", ...TERMINAL].includes(remote.state)) throw new Error("Worker returned an invalid job status.");
          job.remoteState = remote.state; job.error = null; lastError = null;
          if (TERMINAL.has(remote.state)) await complete(job, remote);
          else { job.state = remote.state === "submitting" ? "running" : remote.state; await saveJobs(jobs); }
        } catch (e) {
          job.error = e.message; lastError = e.message;
          // A rejected request is definite; a lost response remains retryable with the SAME ID.
          if (job.state === "submitting" && [400, 409].includes(e.status)) {
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
    models: async () => { await verify(); return json("/v1/models"); },
    status: () => ({ configured: !!connection.url, url: connection.url || "", workerId: connection.workerId || null,
      hasToken: !!token, lastError, jobs: Object.values(jobs).map(snapshot).sort((a, b) => b.createdAt - a.createdAt) }),
    file: (id, fileId) => jobs[id]?.outputs.find(f => f.id === fileId)?.localFile || null,
    close: () => { closed = true; clearInterval(timer); } };
}
