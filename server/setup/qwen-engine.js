/**
 * A compatible Qwen engine, installed beside the current engine. The installer
 * stages only; the caller owns the transactional settings switch and restart.
 * This setup never writes model folders or installs into the person's engine.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { QWEN_COMFY_TAG } from "./pins.js";
import { INSTALL_ENGINE_SCRIPT, samePath, venvPython } from "./engine-packages.js";
import { STUDIO_MODULES } from "./studio-packages.js";

export const QWEN_SETUP_ID = "qwen-engine";
export const QWEN_ENGINE_NODES = ["TextEncodeQwenImage21", "QwenImage21Cache"];
const CAPABILITY = "qwen-image-2.1";
const MARKER = ".aiplay-engine.json";
const STEPS = {
  space: "Checking disk space", uv: "Getting Python", comfy: "Downloading engine",
  python: "Installing Python", torch: "Installing PyTorch", deps: "Installing packages",
  studio: "Installing Studio packages", verify: "Checking hardware", test: "Checking engine",
  qwen: "Checking Qwen", save: "Preparing engine", activate: "Restarting engine", check: "Checking Qwen",
};
const clean = (value, max = 600) => String(value || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().slice(0, max);
async function readJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }
const isFile = async (file) => (await stat(file).catch(() => null))?.isFile() === true;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The only roots this runner may reuse: a direct, unique child of engines. */
function stagePath(root, appData) {
  return typeof root === "string" && /^qwen-[a-f0-9-]{36}$/.test(path.basename(root))
    && samePath(path.dirname(root), path.join(appData, "engines"));
}

/** Strictly bind the installer's answer to the folder requested. Its marker,
 * Python, ComfyUI entry point and package checks must agree before switching. */
export async function validatedQwenStage(metadata, { root, appData, backend }) {
  if (!stagePath(root, appData) || !metadata || typeof metadata !== "object") return null;
  const mark = await readJson(path.join(root, MARKER));
  const py = venvPython(root);
  const valid = (m) => m?.stageOnly === true && m.comfy === QWEN_COMFY_TAG
    && m.backend === backend && samePath(m.rig, root) && samePath(m.python, py)
    && typeof m.torch === "string" && !!m.torch && typeof m.torchBackend === "string" && !!m.torchBackend
    && Array.isArray(m.comfyExtraArgs) && m.comfyExtraArgs.every((arg) => typeof arg === "string")
    && m.studio?.ok === true && Array.isArray(m.studio.missing) && m.studio.missing.length === 0
    && Array.isArray(m.qwenNodes) && QWEN_ENGINE_NODES.every((node) => m.qwenNodes.includes(node))
    && m.engineInstall?.backend === backend && m.engineInstall?.comfy === QWEN_COMFY_TAG
    && m.engineInstall?.torch === m.torch && m.engineInstall?.studioPackages?.ok === true
    && STUDIO_MODULES.every((mod) => m.engineInstall?.studioPackages?.checked?.includes(mod));
  if (!valid(metadata) || mark?.complete !== true || mark.stageOnly !== true
    || mark.comfy !== QWEN_COMFY_TAG || mark.backend !== backend || mark.torch !== metadata.torch
    || mark.studio?.ok !== true || !valid(mark.metadata)
    || JSON.stringify(metadata) !== JSON.stringify(mark.metadata)) return null;
  // Reject directory links: a marker in an arbitrary target does not confer ownership.
  if ((await lstat(path.join(appData, "engines")).catch(() => null))?.isSymbolicLink()
    || (await lstat(root).catch(() => null))?.isSymbolicLink()) return null;
  if (!await isFile(py) || !await isFile(path.join(root, "ComfyUI", "main.py"))) return null;
  return metadata;
}

/** Run the existing installer, with independent, bounded stdout/stderr buffers.
 * Resolves on every spawn/exit/protocol failure; callers never leak a rejection. */
export function runQwenInstaller({ root, appData, backend, gpuName = "", onLine = () => {},
  onStep = () => {}, onChild = () => {}, spawnImpl = spawn, script = INSTALL_ENGINE_SCRIPT } = {}) {
  return new Promise((resolve) => {
    let settled = false, metadata = null, error = null;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };
    const emit = (callback, value) => { try { callback(value); } catch { /* progress cannot stop the installer */ } };
    const take = (raw) => {
      if (raw.startsWith("@@done ")) {
        try { metadata = JSON.parse(raw.slice(7)); } catch { error = "The installer returned an unreadable result."; }
      } else if (raw.startsWith("@@error ")) {
        try { error = clean(JSON.parse(raw.slice(8)).message); } catch { error = "The installer returned an unreadable error."; }
      } else if (raw.startsWith("@@step ")) {
        try { const step = JSON.parse(raw.slice(7)); if (Object.hasOwn(STEPS, step.id)) emit(onStep, step); } catch { /* ordinary output below is enough */ }
      } else if (raw.trim()) emit(onLine, clean(raw));
    };
    let child;
    try {
      child = spawnImpl(process.execPath, [script, "--backend", backend, ...(gpuName ? ["--gpu-name", gpuName] : []),
        "--qwen-compatible", "--stage-only"], {
        cwd: path.resolve(path.dirname(script), ".."), windowsHide: true,
        env: { ...process.env, AIPLAY_APPDATA: appData, AIPLAY_ENGINE_DIR: root },
      });
      emit(onChild, child);
      const flushes = [];
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream?.on) continue;
        let buffer = "";
        const decoder = new StringDecoder("utf8");
        const flush = () => { buffer += decoder.end(); if (buffer) take(buffer); buffer = ""; };
        flushes.push(flush);
        stream.on("data", (chunk) => {
          buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          const parts = buffer.split(/\r?\n|\r/);
          buffer = parts.pop();
          for (const line of parts) take(line.slice(0, 65_536));
          if (buffer.length > 65_536) { emit(onLine, clean(buffer)); buffer = ""; }
        });
        stream.on("end", flush);
      }
      child.on("error", (e) => finish({ ok: false, error: `Could not start the installer (${clean(e.code || e.message)}).` }));
      child.on("close", (code) => {
        flushes.forEach((flush) => flush());
        finish({ ok: code === 0 && !!metadata && !error, metadata, error: error
          || (code !== 0 ? `The installer stopped (exit ${code}).` : !metadata ? "The installer did not finish its checks." : null) });
      });
    } catch (e) { finish({ ok: false, error: `Could not start the installer (${clean(e.code || e.message)}).` }); }
  });
}

async function availableBytes(appData) {
  let folder = path.resolve(appData);
  for (;;) {
    try { const disk = await statfs(folder); return Number(disk.bavail) * Number(disk.bsize); }
    catch { const parent = path.dirname(folder); if (parent === folder) return null; folder = parent; }
  }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function writeJobRecord(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2));
  await rename(temp, file);
}

/**
 * activate(metadata) must switch settings, restart, verify runtimeReady and
 * restore the previous engine on failure before rejecting. Model/download
 * readiness is separate: this setup fixes the engine only.
 */
export function createQwenEngineRunner({ appData, readiness, vendor = () => "cpu", gpuName = () => "",
  blockedBy = () => null, busy = () => false, activate, install = runQwenInstaller,
  spawnImpl = spawn, freeBytes = availableBytes, isProcessAlive = processAlive,
  writeRecord = writeJobRecord, quickMs = 1500 } = {}) {
  if (!appData || typeof readiness !== "function" || typeof activate !== "function") {
    throw new Error("Qwen setup needs appData, readiness and activate.");
  }
  appData = path.resolve(appData);
  const recordFile = path.join(appData, "setup", `${QWEN_SETUP_ID}.json`);
  let job = null, active = null, writes = Promise.resolve(), restoredJob = null, lastSaved = 0;
  const snapshot = (j) => j && ({
    id: QWEN_SETUP_ID, state: j.state, step: j.step || null, label: j.label || null,
    n: j.n || 0, of: 13, root: j.root || null, backend: j.backend || null,
    noop: !!j.noop, retryable: j.state === "failed", message: j.message || null, error: j.error || null,
    lines: (j.lines || []).slice(-12), startedAt: j.startedAt || null, finishedAt: j.finishedAt || null,
  });
  const persist = (j) => {
    const record = { ...snapshot(j), installerPid: j.installerPid || null };
    writes = writes.catch(() => {}).then(() => writeRecord(recordFile, record));
    return writes;
  };
  const restored = (async () => {
    const kept = await readJson(recordFile);
    if (kept?.id !== QWEN_SETUP_ID || !["running", "done", "failed", "blocked", "ready"].includes(kept.state)) return;
    restoredJob = { ...kept, root: stagePath(kept.root, appData) ? kept.root : null,
      lines: Array.isArray(kept.lines) ? kept.lines.slice(-12).map((line) => clean(line)) : [] };
    if (restoredJob.state === "running") {
      Object.assign(restoredJob, { state: "failed", finishedAt: Date.now(), step: null, label: null,
        error: "The repair was interrupted. Try again to continue.", message: "The repair was interrupted. Try again to continue." });
      await persist(restoredJob).catch(() => {});
    }
  })();

  const blockedJob = (j, message) => Object.assign(j, { state: "blocked", message, error: message, finishedAt: Date.now() });
  async function read() {
    const [status, blocked, rendering, backendValue, name, bytes] = await Promise.all([
      readiness(), blockedBy(), busy(), vendor(), gpuName(), freeBytes(appData),
    ]);
    const backend = String(backendValue || "cpu").toLowerCase();
    const knownMissing = Array.isArray(status?.missingNodes) && status.missingNodes.some((node) => QWEN_ENGINE_NODES.includes(node));
    const unknownMissing = Array.isArray(status?.missingNodes) && status.missingNodes.length > 0 && !knownMissing;
    const freeGb = Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes / 1024 ** 3 * 10) / 10 : null;
    const diskGb = backend === "cpu" ? 6 : 16;
    const downloadGb = backend === "cpu" ? "3-5" : "6-15";
    const reason = blocked ? clean(blocked)
      : !["nvidia", "amd", "intel", "cpu"].includes(backend) ? "Studio could not choose a supported engine for this hardware."
      : rendering ? (typeof rendering === "string" ? clean(rendering) : "Wait for the current render to finish, then choose Fix Qwen.")
      : status?.runtimeReady === true ? null
      : unknownMissing ? "The engine is missing other required nodes. Check the engine before repairing Qwen."
      : !knownMissing ? "Start the local engine so Studio can check Qwen support."
      : null;
    return { ready: status?.runtimeReady === true, knownMissing, blocked: reason, backend, name: clean(name, 200), freeGb, diskGb, downloadGb };
  }

  async function reusable(root, backend) {
    if (!stagePath(root, appData)) return null;
    const mark = await readJson(path.join(root, MARKER));
    return validatedQwenStage(mark?.metadata, { root, appData, backend });
  }
  async function chooseRoot(previous, backend) {
    if (stagePath(previous?.root, appData)) {
      const mark = await readJson(path.join(previous.root, MARKER));
      const rootInfo = await lstat(previous.root).catch(() => null);
      if (!rootInfo?.isSymbolicLink() && ((!rootInfo)
        || (mark?.stageOnly === true && mark.complete !== true && mark.backend === backend))) return previous.root;
    }
    return path.join(appData, "engines", `qwen-${randomUUID()}`);
  }

  async function runJob(j, previous) {
    try {
      await restored;
      previous ||= restoredJob;
      j.root = stagePath(previous?.root, appData) ? previous.root : null;
      j.installerPid = previous?.installerPid || null;
      const r = await read();
      j.backend = r.backend;
      j.recipe = r;
      if (r.blocked) { blockedJob(j, r.blocked); return; }
      if (r.ready) {
        Object.assign(j, { state: "ready", noop: true, message: "Qwen support is already ready.", finishedAt: Date.now() });
        return;
      }
      if (previous?.installerPid && await isProcessAlive(previous.installerPid)) {
        blockedJob(j, "The previous repair is still finishing. Try again shortly."); return;
      }
      const metadataKept = await reusable(previous?.root, r.backend);
      if (!metadataKept && r.freeGb !== null && r.freeGb < r.diskGb) {
        blockedJob(j, `Free about ${r.diskGb} GB on Studio's drive, then choose Fix Qwen (${r.freeGb} GB available).`); return;
      }
      await mkdir(path.join(appData, "engines"), { recursive: true });
      if ((await lstat(path.join(appData, "engines")))?.isSymbolicLink()) {
        throw new Error("Studio's engine folder is a link. Choose an ordinary Studio data folder before repairing Qwen.");
      }
      j.root = metadataKept ? previous.root : await chooseRoot(previous, r.backend);
      await persist(j); // If persistence fails, nothing large has been downloaded.
      let metadata = metadataKept;
      if (!metadata) {
        const out = await install({ root: j.root, appData, backend: r.backend, gpuName: r.name, spawnImpl,
          onLine: (line) => {
            j.lines.push(clean(line)); if (j.lines.length > 60) j.lines.shift();
            if (Date.now() - lastSaved > 1000) { lastSaved = Date.now(); void persist(j).catch(() => {}); }
          },
          onStep: (step) => {
            j.step = step.id; j.label = STEPS[step.id] || "Installing engine";
            j.n = Number.isFinite(step.n) ? Math.max(0, Math.min(11, step.n)) : j.n;
            void persist(j).catch(() => {});
          },
          onChild: (child) => { j.installerPid = child.pid || null; void persist(j).catch(() => {}); },
        });
        j.installerPid = null;
        if (!out?.ok) throw new Error(out?.error || "The compatible engine did not install. Try again.");
        metadata = await validatedQwenStage(out.metadata, { root: j.root, appData, backend: r.backend });
        if (!metadata) throw new Error("The compatible engine did not pass its installation checks. Try again.");
      }
      // A render or machine override may have appeared during the download.
      const nowBlocked = await blockedBy();
      if (nowBlocked) throw new Error(clean(nowBlocked));
      const nowBusy = await busy();
      if (nowBusy) throw new Error(typeof nowBusy === "string" ? clean(nowBusy) : "The engine is ready; wait for the current render, then try again.");
      j.step = "activate"; j.label = STEPS.activate; j.n = 12; await persist(j);
      await activate(metadata);
      j.step = "check"; j.label = STEPS.check; j.n = 13; await persist(j);
      const status = await readiness();
      if (status?.runtimeReady !== true) throw new Error("The engine restarted but Qwen support could not be verified. Try again.");
      Object.assign(j, { state: "done", message: "The compatible engine is ready for Qwen.", finishedAt: Date.now() });
    } catch (e) {
      const message = clean(e?.message || e) || "The repair stopped. Try again.";
      Object.assign(j, { state: "failed", message, error: message, installerPid: null, finishedAt: Date.now() });
    } finally {
      // Store final state even on preflight refusal; status remains readable if disk writes fail.
      await persist(j).catch(() => {});
    }
  }

  return {
    ids: [QWEN_SETUP_ID], has: (id) => id === QWEN_SETUP_ID,
    async run(id) {
      if (id !== QWEN_SETUP_ID) return snapshot(blockedJob({ lines: [] }, "Unknown Qwen setup."));
      // The terminal state is visible while its final disk write is still in
      // flight. A retry waits for that write, then claims a new job instead of
      // answering with the old failure. Concurrent retries recheck this lock.
      while (active && job?.state !== "running") await active;
      if (active) { await Promise.race([active, sleep(quickMs)]); return { ...snapshot(job), already: true }; }
      const previous = job;
      // Claim before any async read: simultaneous assistant/button presses share this job.
      const j = { state: "running", step: "space", label: STEPS.space, n: 0, lines: [], startedAt: Date.now() };
      job = j;
      active = runJob(j, previous).finally(() => { active = null; });
      await Promise.race([active, sleep(quickMs)]);
      return snapshot(j);
    },
    async status(id = null) {
      if (id && id !== QWEN_SETUP_ID) return { setups: [] };
      await restored;
      job ||= restoredJob;
      // A terminal snapshot also waits for final persistence; otherwise a
      // finished job can still hide readiness behind the restart placeholder.
      while (active && job?.state !== "running") await active;
      let r;
      if (active) r = { diskGb: 16, downloadGb: "6-15", freeGb: null, ...job?.recipe, ready: false, blocked: null };
      else {
        try { r = await read(); }
        catch { r = { ready: false, blocked: "Studio could not check the local engine. Check again shortly.", diskGb: 16, downloadGb: "6-15", freeGb: null }; }
      }
      if (!active && !r.blocked && !r.ready && r.freeGb !== null && r.freeGb < r.diskGb
        && !await reusable(job?.root, r.backend)) r.blocked = `Free about ${r.diskGb} GB on Studio's drive, then choose Fix Qwen (${r.freeGb} GB available).`;
      return { setups: [{
        id: QWEN_SETUP_ID, label: "Qwen engine", title: "Qwen engine", button: job?.state === "failed" ? "Try again" : "Fix Qwen",
        readyWords: "Qwen support is ready", capability: CAPABILITY, ready: r.ready,
        blocked: r.blocked || null, offer: r.blocked || "Studio will install a compatible engine and restart it automatically.",
        downloadGb: r.downloadGb, diskGb: r.diskGb, freeGb: r.freeGb, backend: r.backend || null,
        progressOnly: true, sizeWords: `About ${r.downloadGb} GB download · ${r.diskGb} GB disk space`,
        root: job?.root || null, missing: [], job: snapshot(job),
      }] };
    },
  };
}
