/** Authenticated, durable ComfyUI worker. Run beside ComfyUI on a dedicated Pod. */
import http from "node:http";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { PROTOCOL, MAX_ASSET, TERMINAL, MEDIA_EXT, jobId, relativeFile, containedFile,
  hashFile, digest, readJSON, jsonStore, readBody, sendJSON, validateGraph } from "../server/engine/remote-common.js";
import { checkComfyLoopback } from "./check-comfy-loopback.js";
import { createModelManager } from "./model-manager.js";
/* The Studio's minors check, dependency-free, so the Pod refuses too: a
 * Studio of another version, or anything else holding the token, still
 * cannot have it render (the Studio's own submit refuses first). */
import { checkGraph } from "../server/safety/graph.js";
import { REFUSAL } from "../server/safety/minors.js";
/* Dependency-free too: "Don't record the prompt" holds on the Pod's disk. */
import { stripPngText } from "../server/pngtext.js";

export async function createWorker({ token, comfyURL, inputDir, outputDir, stateDir,
  modelsDir = path.join(path.dirname(inputDir), "models"), fetchFn = fetch, pollMs = 2000, modelBundles }) {
  if (typeof token !== "string" || token.length < 32 || /[\r\n]/.test(token)) throw new Error("AIPLAY_WORKER_TOKEN must contain at least 32 characters.");
  const backend = new URL(comfyURL);
  if (backend.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname)) throw new Error("ComfyUI must be on the worker's loopback interface.");
  const base = backend.href.replace(/\/+$/, "");
  const secretHash = createHash("sha256").update(`Bearer ${token}`).digest();
  /* "DON'T RECORD THE PROMPT" ON THE POD (`private` on POST /v1/jobs). The
   * state file sits on the persistent /workspace volume with no expiry, so a
   * private job keeps its graph only until ComfyUI has accepted it, its
   * request is remembered by a KEYED hash (sha256 of a graph that holds a
   * prompt is a lookup key for a guessed prompt, the reason record.js drops
   * promptHash), it reports no executedGraphHash, its PNGs lose ComfyUI's
   * text chunks before they are hashed, and the Studio asks the worker to
   * forget the job once it holds its own verified copies (POST
   * /v1/jobs/<id>/forget: the output files and ComfyUI's history entry go).
   * An open job keeps what it always kept. */
  const requestKey = (body) => body?.private === true
    ? createHmac("sha256", token).update(digest(body)).digest("hex") : digest(body);
  const dropWords = (job) => { if (job.private === true) job.graph = null; };
  await Promise.all([inputDir, outputDir, stateDir].map(dir => mkdir(dir, { recursive: true })));
  const assetsDir = path.join(inputDir, "aiplay_remote");
  await mkdir(assetsDir, { recursive: true });
  const stateFile = path.join(stateDir, "jobs.json");
  const state = await readJSON(stateFile, { workerId: randomUUID(), jobs: {} });
  const save = jsonStore(stateFile);
  await save(state);
  const modelManager = await createModelManager({ modelsDir, fetchFn, ...(modelBundles ? { bundles: modelBundles } : {}) });
  let busy = false, closed = false;
  const request = async (route, init = {}) => {
    const response = await fetchFn(`${base}${route}`, { ...init, redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`ComfyUI returned HTTP ${response.status}.`);
    return response.json();
  };
  const post = (route, body) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const publicJob = job => ({ id: job.id, state: job.state, createdAt: job.createdAt, startedAt: job.startedAt,
    finishedAt: job.finishedAt, error: job.error || null, outputs: job.outputs || [], promptId: job.promptId || null,
    executedGraphHash: job.private === true ? null : digest(job.graph),
    ...(job.private === true ? { private: true } : {}), ...(job.forgotten ? { forgotten: true } : {}) });

  async function finish(job, stateName, error = null) {
    job.state = stateName; job.error = error; job.finishedAt = Date.now(); dropWords(job); await save(state);
  }
  async function findSubmitted(id) {
    const [q, h] = await Promise.all([request("/queue"), request("/history")]);
    return [...(q.queue_running || []), ...(q.queue_pending || []), ...Object.values(h).map(e => e.prompt)]
      .find(row => row?.[3]?.aiplay_remote_id === id)?.[1] || null;
  }
  async function outputs(job, entry) {
    const found = []; const seen = new Set();
    for (const [node, types] of Object.entries(entry.outputs || {})) {
      for (const kind of ["images", "videos", "audio", "gifs", "3d"]) {
        for (const file of types[kind] || []) {
          if (!file?.filename || (file.type && file.type !== "output")) continue;
          const relative = relativeFile([file.subfolder, file.filename].filter(Boolean).join("/"));
          if (!MEDIA_EXT.test(relative) || seen.has(relative)) continue;
          seen.add(relative);
          const full = await containedFile(outputDir, relative);
          /* A private job's picture loses ComfyUI's text chunks (the graph,
           * with its words) here, before it is hashed, so neither the copy on
           * the Pod nor the one the Studio downloads holds them. pngtext.js
           * keeps the app's own XMP disclosure; a file that is not a PNG is
           * left as it is and goes when the Studio has its copy (forget). */
          if (job.private === true && /\.png$/i.test(relative)) await stripPngText(full);
          const size = (await stat(full)).size;
          if (size > MAX_ASSET) throw new Error("A result exceeds the 512 MiB transfer limit.");
          found.push({ id: String(found.length), filename: path.basename(relative), kind, node,
            bytes: size, sha256: await hashFile(full), relative });
        }
      }
    }
    if (!found.length) throw new Error("Workflow completed without supported saved outputs. Use an output/save node.");
    // The manifest freezes output hashes; the download route checks for changed files.
    job.outputs = found;
    await finish(job, "completed");
  }
  async function tick() {
    if (busy || closed) return;
    busy = true;
    try {
      const job = Object.values(state.jobs).find(j => !TERMINAL.has(j.state));
      if (!job) return;
      if (job.state === "queued") {
        try {
          const info = await request("/object_info");
          validateGraph(job.graph, info);
        } catch (e) { await finish(job, "failed", e.message); return; }
        if (job.state !== "queued") return;
        // Persist before submission. After an ambiguous response/restart, reconcile only.
        job.state = "submitting"; job.startedAt = Date.now(); await save(state);
        try {
          const submitted = await post("/prompt", { prompt: job.graph, client_id: `aiplay-remote-${job.id}`, extra_data: { aiplay_remote_id: job.id } });
          if (!submitted.prompt_id) throw new Error("ComfyUI did not return a prompt ID.");
          job.promptId = submitted.prompt_id; job.state = "running"; dropWords(job); await save(state);
        } catch { job.error = "Submission response was lost. Reconciling with ComfyUI; the render will not be resubmitted."; await save(state); }
        return;
      }
      if (job.state === "submitting") {
        const existing = await findSubmitted(job.id);
        if (!existing) {
          await finish(job, "uncertain", "Cannot establish whether ComfyUI accepted the job. Check the Pod before creating another render; no automatic resubmission occurred.");
          return;
        }
        job.promptId = existing; job.state = "running"; job.error = null; dropWords(job); await save(state);
      }
      const entry = (await request(`/history/${encodeURIComponent(job.promptId)}`))[job.promptId];
      if (entry?.status?.status_str === "error") {
        await finish(job, job.cancelRequested ? "cancelled" : "failed", "ComfyUI reported an execution error. Inspect the worker's ComfyUI log.");
      } else if (entry?.status?.completed) {
        try { await outputs(job, entry); } catch (e) { await finish(job, "failed", e.message); }
      } else if (!entry) {
        const q = await request("/queue");
        const present = [...(q.queue_running || []), ...(q.queue_pending || [])].some(row => row[1] === job.promptId);
        job.missing = present ? 0 : (job.missing || 0) + 1;
        if (job.missing >= 3) await finish(job, job.cancelRequested ? "cancelled" : "uncertain", job.cancelRequested ? null : "Job is absent from ComfyUI queue and history. Check the Pod; it may have restarted.");
      }
    } catch {
      // A network outage is not proof of render failure. Keep the durable ID for recovery.
    } finally { busy = false; }
  }

  /* THE STUDIO HAS ITS COPIES (it asks this for a private job): the outputs
   * on this volume, the job's own output folder and ComfyUI's history entry
   * (which holds the graph in ComfyUI's memory until it restarts) go. The
   * state row stays, wordless, so a later status read still answers. */
  async function forget(job) {
    if (!TERMINAL.has(job.state)) throw new Error("Only a finished job can be forgotten.");
    for (const file of job.outputs || []) {
      const full = await containedFile(outputDir, file.relative).catch(() => null);
      if (full) await unlink(full).catch(() => {});
    }
    await rm(path.join(outputDir, "aiplay_remote", jobId(job.id)), { recursive: true, force: true }).catch(() => {});
    if (job.promptId) {
      await fetchFn(`${base}/history`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [job.promptId] }), redirect: "error", signal: AbortSignal.timeout(30000) }).catch(() => null);
    }
    job.outputs = []; job.graph = null; job.forgotten = true; await save(state);
    return publicJob(job);
  }

  async function cancel(job) {
    if (TERMINAL.has(job.state)) return publicJob(job);
    if (job.state === "queued") { await finish(job, "cancelled"); return publicJob(job); }
    if (!job.promptId) throw new Error("Submission is being reconciled; cancellation is not yet addressable.");
    const q = await request("/queue");
    if ((q.queue_pending || []).some(row => row[1] === job.promptId)) {
      await post("/queue", { delete: [job.promptId] });
    } else {
      // No global /interrupt fallback: it could stop a different person's workflow.
      await post(`/api/jobs/${encodeURIComponent(job.promptId)}/cancel`, {});
    }
    job.cancelRequested = true; await save(state);
    return publicJob(job);
  }

  const server = http.createServer(async (req, res) => {
    const supplied = createHash("sha256").update(String(req.headers.authorization || "")).digest();
    if (!timingSafeEqual(secretHash, supplied)) return sendJSON(res, 401, { error: "Worker authentication failed." });
    if (req.headers.origin) return sendJSON(res, 403, { error: "Connect through the local AIPLAY backend." });
    try {
      const url = new URL(req.url, "http://worker");
      if (req.method === "GET" && url.pathname === "/v1/health") {
        const stats = await request("/system_stats");
        return sendJSON(res, 200, { protocol: PROTOCOL, workerId: state.workerId, ready: true,
          version: stats.system?.comfyui_version || null, devices: stats.devices || [], maxAssetBytes: MAX_ASSET,
          modelSetupVersion: 1 });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") return sendJSON(res, 200, await request("/object_info"));
      if (req.method === "GET" && url.pathname === "/v1/setup") return sendJSON(res, 200, modelManager.status());
      if (req.method === "POST" && url.pathname === "/v1/setup/install") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        return sendJSON(res, 202, await modelManager.install(body.bundle, body.acceptLicense));
      }
      if (req.method === "POST" && url.pathname === "/v1/setup/cancel") return sendJSON(res, 200, modelManager.cancel());
      if (req.method === "POST" && url.pathname === "/v1/assets") {
        const name = relativeFile(url.searchParams.get("name"));
        if (name.includes("/") || !MEDIA_EXT.test(name)) throw new Error("Unsupported input filename.");
        const tmp = path.join(assetsDir, `${randomUUID()}.upload`);
        const hash = createHash("sha256"); let bytes = 0;
        try {
          await pipeline(req, new Transform({ transform(chunk, enc, cb) {
            bytes += chunk.length;
            if (bytes > MAX_ASSET) return cb(new Error("Input exceeds 512 MiB."));
            hash.update(chunk); cb(null, chunk);
          } }), createWriteStream(tmp, { flags: "wx" }));
          if (!bytes) throw new Error("Input is empty.");
          const sha256 = hash.digest("hex");
          const asset = `${sha256}${path.extname(name).toLowerCase()}`;
          await rename(tmp, path.join(assetsDir, asset));
          return sendJSON(res, 200, { asset, sha256, bytes });
        } finally { await unlink(tmp).catch(() => {}); }
      }
      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const id = jobId(body.id);
        validateGraph(body.graph);
        /* Refused before anything is kept: no state row, no graph on disk. */
        const safety = checkGraph(body.graph);
        if (!safety.ok) return sendJSON(res, 422, { error: REFUSAL, code: safety.code });
        const requestHash = requestKey(body);
        if (state.jobs[id]) {
          if (state.jobs[id].requestHash !== requestHash) return sendJSON(res, 409, { error: "This job ID belongs to a different request." });
          return sendJSON(res, 200, publicJob(state.jobs[id]));
        }
        if (Object.values(state.jobs).filter(j => !TERMINAL.has(j.state)).length >= 20) return sendJSON(res, 429, { error: "The worker queue is full." });
        const graph = structuredClone(body.graph);
        if (!Array.isArray(body.bindings || []) || (body.bindings || []).length > 30) throw new Error("Invalid input bindings.");
        for (const binding of body.bindings || []) {
          if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(binding.asset) || !graph[binding.node]?.inputs || !(binding.input in graph[binding.node].inputs)) throw new Error("Invalid input binding.");
          await containedFile(assetsDir, binding.asset);
          graph[binding.node].inputs[binding.input] = `aiplay_remote/${binding.asset}`;
        }
        // Unique output prefixes prevent cached names and simultaneous clients overwriting results.
        for (const node of Object.values(graph)) {
          if (typeof node.inputs.filename_prefix === "string") node.inputs.filename_prefix = `aiplay_remote/${id}/${path.posix.basename(node.inputs.filename_prefix.replaceAll("\\", "/"))}`;
        }
        // Bindings require awaits. Recheck after them so concurrent retries cannot enqueue twice.
        if (state.jobs[id]) {
          if (state.jobs[id].requestHash !== requestHash) return sendJSON(res, 409, { error: "This job ID belongs to a different request." });
          return sendJSON(res, 200, publicJob(state.jobs[id]));
        }
        const job = { id, graph, requestHash, state: "queued", createdAt: Date.now(), outputs: [],
          ...(body.private === true ? { private: true } : {}) };
        state.jobs[id] = job;
        try { await save(state); } catch (e) { delete state.jobs[id]; throw e; }
        return sendJSON(res, 202, publicJob(job));
      }
      const match = /^\/v1\/jobs\/([a-zA-Z0-9_-]+)(?:\/(cancel|forget|files)(?:\/([0-9]+))?)?$/.exec(url.pathname);
      if (match) {
        const job = state.jobs[match[1]];
        if (!job) return sendJSON(res, 404, { error: "Unknown job." });
        if (req.method === "GET" && !match[2]) return sendJSON(res, 200, publicJob(job));
        if (req.method === "POST" && match[2] === "cancel") return sendJSON(res, 200, await cancel(job));
        if (req.method === "POST" && match[2] === "forget") return sendJSON(res, 200, await forget(job));
        if (req.method === "GET" && match[2] === "files") {
          const file = job.outputs?.find(f => f.id === match[3]);
          if (!file || job.state !== "completed") return sendJSON(res, 404, { error: "Output is not available." });
          const full = await containedFile(outputDir, file.relative);
          if ((await stat(full)).size !== file.bytes || await hashFile(full) !== file.sha256) return sendJSON(res, 409, { error: "The remote output changed after completion." });
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": file.bytes, "X-Content-Type-Options": "nosniff" });
          await pipeline(createReadStream(full), res); return;
        }
      }
      sendJSON(res, 404, { error: "Unknown worker operation." });
    } catch (e) {
      if (!res.headersSent && !res.destroyed) sendJSON(res, 400, { error: e.message });
      else res.destroy();
    }
  });
  const timer = setInterval(() => { tick(); }, pollMs); timer.unref();
  return { server, tick, close: async () => { closed = true; clearInterval(timer); await new Promise(r => server.close(r)); }, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkComfyLoopback();
  const root = process.env.AIPLAY_COMFY_DIR || "/workspace/ComfyUI";
  const worker = await createWorker({ token: process.env.AIPLAY_WORKER_TOKEN,
    comfyURL: process.env.AIPLAY_WORKER_COMFY_URL || "http://127.0.0.1:8188",
    inputDir: process.env.AIPLAY_WORKER_INPUT || path.join(root, "input"),
    outputDir: process.env.AIPLAY_WORKER_OUTPUT || path.join(root, "output"),
    stateDir: process.env.AIPLAY_WORKER_STATE || "/workspace/aiplay-worker",
    modelsDir: process.env.AIPLAY_MODELS_DIR || path.join(root, "models") });
  worker.server.listen(Number(process.env.AIPLAY_WORKER_PORT || 8787), "0.0.0.0", () => console.log("AIPLAY remote worker listening; authentication required."));
}
