/** A verified stable ComfyUI release, staged beside the working engine.
 * The caller verifies ownership/custom nodes and owns activation/rollback. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { runQwenInstaller, availableEngineBytes, engineProcessAlive, writeEngineJobRecord } from "./qwen-engine.js";
import { samePath, venvPython } from "./engine-packages.js";
import { STUDIO_MODULES } from "./studio-packages.js";

export const COMFY_SETUP_ID = "comfy-update";
export const stableComfyTag = (tag) => typeof tag === "string"
  && /^v(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(tag);
const MARKER = ".aiplay-engine.json";
const STEPS = { space: "Checking disk space", uv: "Getting Python", comfy: "Downloading ComfyUI",
  python: "Installing Python", torch: "Installing PyTorch", deps: "Installing packages", studio: "Checking Studio packages",
  verify: "Checking hardware", test: "Checking ComfyUI", save: "Preparing engine", activate: "Restarting engine", check: "Checking update" };
const clean = value => String(value || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().slice(0, 600);
const readJson = async file => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const versionTag = version => stableComfyTag(`v${String(version || "").replace(/^v/, "")}`) ? `v${String(version).replace(/^v/, "")}` : null;
function atLeast(version, target) {
  const tag = versionTag(version);
  if (!tag) return false;
  const have = tag.slice(1).split(".").map(Number), want = target.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}
export const comfyStagePath = (root, appData) => typeof root === "string"
  && /^comfy-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path.basename(root))
  && samePath(path.dirname(root), path.join(appData, "engines"));

/** Marker, installer answer, target and real files must all name one stage. */
export async function validatedComfyStage(metadata, { root, appData, backend, tag }) {
  if (!stableComfyTag(tag) || !comfyStagePath(root, appData)) return null;
  const mark = await readJson(path.join(root, MARKER)), python = venvPython(root);
  const packages = value => value?.ok === true && Array.isArray(value.missing) && !value.missing.length
    && Array.isArray(value.checked) && STUDIO_MODULES.every(mod => value.checked.includes(mod));
  const valid = value => value?.stageOnly === true && value.comfy === tag && value.backend === backend
    && samePath(value.rig, root) && samePath(value.python, python)
    && typeof value.torch === "string" && !!value.torch
    && value.torchBackend === ({ nvidia: "cuda", amd: "rocm", intel: "xpu", cpu: "cpu" })[backend]
    && value.gpu?.vendor === backend && Array.isArray(value.comfyExtraArgs) && value.comfyExtraArgs.every(arg => typeof arg === "string")
    && value.studio?.ok === true && Array.isArray(value.studio.missing) && !value.studio.missing.length
    && value.engineInstall?.backend === backend && value.engineInstall?.comfy === tag && value.engineInstall?.torch === value.torch
    && packages(value.engineInstall?.studioPackages);
  if (!valid(metadata) || mark?.complete !== true || mark.stageOnly !== true || mark.comfy !== tag
    || mark.backend !== backend || mark.torch !== metadata.torch || !packages(mark.studio)
    || !valid(mark.metadata) || JSON.stringify(metadata) !== JSON.stringify(mark.metadata)) return null;
  if ((await lstat(path.join(appData, "engines")).catch(() => null))?.isSymbolicLink()
    || (await lstat(root).catch(() => null))?.isSymbolicLink()) return null;
  const resolvedRoot = await realpath(root).catch(() => null);
  if (!resolvedRoot) return null;
  for (const file of [python, path.join(root, "ComfyUI", "main.py")]) {
    const info = await stat(file).catch(() => null), resolved = await realpath(file).catch(() => null);
    if (!info?.isFile() || !resolved) return null;
    const relative = path.relative(resolvedRoot, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  }
  return metadata;
}

/** Reuse the installer's bounded protocol reader, with a separate stable tag. */
export function runComfyInstaller({ tag, ...options }) {
  if (!stableComfyTag(tag)) return Promise.resolve({ ok: false, error: "Choose a verified stable ComfyUI version." });
  return runQwenInstaller({ ...options, installerArgs: ["--stage-only", "--comfy-tag", tag] });
}

export function createComfyEngineRunner({ appData, target, targetCached = () => null, readiness, vendor = () => "cpu", gpuName = () => "",
  blockedBy = () => null, busy = () => false, selection = () => null, activate, install = runComfyInstaller,
  spawnImpl = spawn, freeBytes = availableEngineBytes, isProcessAlive = engineProcessAlive,
  writeRecord = writeEngineJobRecord, quickMs = 1500 } = {}) {
  if (!appData || typeof target !== "function" || typeof readiness !== "function" || typeof activate !== "function")
    throw new Error("ComfyUI update needs appData, target, readiness and activate.");
  appData = path.resolve(appData);
  const recordFile = path.join(appData, "setup", `${COMFY_SETUP_ID}.json`);
  let job = null, active = null, restoredJob = null, writes = Promise.resolve(), lastSaved = 0;
  const snapshot = value => value && ({ id: COMFY_SETUP_ID, state: value.state, step: value.step || null,
    label: value.label || null, n: value.n || 0, of: 12, root: value.root || null, backend: value.backend || null,
    tag: value.tag || null, noop: !!value.noop, retryable: value.state === "failed", message: value.message || null,
    error: value.error || null, lines: (value.lines || []).slice(-12), startedAt: value.startedAt || null, finishedAt: value.finishedAt || null });
  const persist = value => {
    const record = { ...snapshot(value), installerPid: value.installerPid || null };
    writes = writes.catch(() => {}).then(() => writeRecord(recordFile, record));
    return writes;
  };
  const restored = (async () => {
    const kept = await readJson(recordFile);
    if (kept?.id !== COMFY_SETUP_ID || !["running", "done", "failed", "blocked", "ready"].includes(kept.state)) return;
    restoredJob = { ...kept, root: comfyStagePath(kept.root, appData) ? kept.root : null,
      tag: stableComfyTag(kept.tag) ? kept.tag : null, lines: Array.isArray(kept.lines) ? kept.lines.slice(-12).map(clean) : [] };
    if (kept.state === "running") {
      Object.assign(restoredJob, { state: "failed", step: null, label: null, finishedAt: Date.now(),
        message: "The update was interrupted. Try again to continue.", error: "The update was interrupted. Try again to continue." });
      await persist(restoredJob).catch(() => {});
    }
  })();
  const blockedJob = (value, message) => Object.assign(value, { state: "blocked", message, error: message, finishedAt: Date.now() });
  async function checkedTarget() {
    const tag = await target();
    if (!stableComfyTag(tag)) throw new Error("The latest stable ComfyUI version could not be verified. Check again.");
    return tag;
  }
  async function read(tag) {
    const [status, blocked, rendering, backendValue, name, bytes] = await Promise.all([
      readiness(), blockedBy(), busy(), vendor(), gpuName(), freeBytes(appData),
    ]);
    const backend = String(backendValue || "cpu").toLowerCase(), ready = stableComfyTag(tag) && atLeast(status?.version, tag);
    const reason = blocked ? clean(blocked) : !["nvidia", "amd", "intel", "cpu"].includes(backend)
      ? "Studio could not choose a supported engine for this hardware." : rendering
        ? typeof rendering === "string" ? clean(rendering) : "Wait for the current work to finish before updating ComfyUI."
        : !versionTag(status?.version) ? "Studio could not verify the installed ComfyUI version. Start the engine and check again." : null;
    return { tag, version: status?.version || null, ready, blocked: reason, backend, name: clean(name),
      freeGb: Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes / 1024 ** 3 * 10) / 10 : null,
      diskGb: backend === "cpu" ? 6 : 16, downloadGb: backend === "cpu" ? "3-5" : "6-15" };
  }
  async function reusable(root, backend, tag) {
    if (!comfyStagePath(root, appData)) return null;
    const mark = await readJson(path.join(root, MARKER));
    return validatedComfyStage(mark?.metadata, { root, appData, backend, tag });
  }
  async function chooseRoot(previous, recipe) {
    if (previous?.tag === recipe.tag && comfyStagePath(previous?.root, appData)) {
      const info = await lstat(previous.root).catch(() => null), mark = await readJson(path.join(previous.root, MARKER));
      if (!info || !info.isSymbolicLink() && mark?.stageOnly === true && mark.complete === false
        && mark.backend === recipe.backend && mark.comfy === recipe.tag) return previous.root;
    }
    return path.join(appData, "engines", `comfy-${randomUUID()}`);
  }
  async function runJob(value, previous) {
    try {
      await restored; previous ||= restoredJob;
      const originalSelection = JSON.stringify(await selection()), recipe = await read(await checkedTarget());
      Object.assign(value, { recipe, backend: recipe.backend, tag: recipe.tag });
      if (recipe.blocked) { blockedJob(value, recipe.blocked); return; }
      if (recipe.ready) { Object.assign(value, { state: "ready", noop: true, message: "ComfyUI is already up to date.", finishedAt: Date.now() }); return; }
      // A live interrupted installer protects its folder even if the target changed.
      if (previous?.installerPid && await isProcessAlive(previous.installerPid)) {
        value.root = previous.root; value.installerPid = previous.installerPid;
        blockedJob(value, "The previous update is still finishing. Try again shortly."); return;
      }
      let metadata = await reusable(previous?.root, recipe.backend, recipe.tag);
      if (!metadata && recipe.freeGb !== null && recipe.freeGb < recipe.diskGb) {
        blockedJob(value, `Free about ${recipe.diskGb} GB on Studio's drive before updating ComfyUI (${recipe.freeGb} GB available).`); return;
      }
      await mkdir(path.join(appData, "engines"), { recursive: true });
      if ((await lstat(path.join(appData, "engines"))).isSymbolicLink()) throw new Error("Studio's engine folder is a link. Choose an ordinary Studio data folder before updating.");
      value.root = metadata ? previous.root : await chooseRoot(previous, recipe);
      await persist(value);
      if (!metadata) {
        const result = await install({ root: value.root, appData, tag: recipe.tag, backend: recipe.backend, gpuName: recipe.name, spawnImpl,
          onLine: line => { value.lines.push(clean(line)); if (value.lines.length > 60) value.lines.shift();
            if (Date.now() - lastSaved > 1000) { lastSaved = Date.now(); void persist(value).catch(() => {}); } },
          onStep: step => { if (!Object.hasOwn(STEPS, step.id)) return; value.step = step.id; value.label = STEPS[step.id];
            value.n = Number.isFinite(step.n) ? Math.max(0, Math.min(10, step.n)) : value.n; void persist(value).catch(() => {}); },
          onChild: child => { value.installerPid = child.pid || null; void persist(value).catch(() => {}); } });
        value.installerPid = null;
        if (!result?.ok) throw new Error(result?.error || "The ComfyUI update did not install. Try again.");
        metadata = await validatedComfyStage(result.metadata, { root: value.root, appData, backend: recipe.backend, tag: recipe.tag });
        if (!metadata) throw new Error("The new engine did not pass its installation checks. Try again.");
      }
      const blocked = await blockedBy(), working = await busy();
      if (blocked || working) throw new Error(clean(blocked || (typeof working === "string" ? working : "The engine is ready; wait for the current work, then try again.")));
      if (await checkedTarget() !== recipe.tag) throw new Error("A different ComfyUI release is now available. Review the update and try again.");
      value.step = "activate"; value.label = STEPS.activate; value.n = 11; await persist(value);
      if (JSON.stringify(await selection()) !== originalSelection) throw new Error("The selected engine changed during installation. Review the update and try again.");
      // Activation owns runtime/version verification and rollback before it
      // commits settings. A second probe after commit could mislabel a working
      // update as failed merely because a later status request timed out.
      await activate(metadata);
      value.step = "check"; value.label = STEPS.check; value.n = 12;
      Object.assign(value, { state: "done", message: `ComfyUI ${recipe.tag} is ready.`, finishedAt: Date.now() });
    } catch (error) {
      const message = clean(error?.message || error) || "The ComfyUI update stopped. Try again.";
      Object.assign(value, { state: "failed", message, error: message, finishedAt: Date.now() });
    } finally { await persist(value).catch(() => {}); }
  }
  return {
    ids: [COMFY_SETUP_ID], has: id => id === COMFY_SETUP_ID,
    async run(id) {
      if (id !== COMFY_SETUP_ID) return snapshot(blockedJob({ lines: [] }, "Unknown ComfyUI setup."));
      while (active && job?.state !== "running") await active;
      if (active) { await Promise.race([active, sleep(quickMs)]); return { ...snapshot(job), already: true }; }
      const previous = job, value = { state: "running", step: "space", label: STEPS.space, n: 0, lines: [], startedAt: Date.now() };
      job = value; active = runJob(value, previous).finally(() => { active = null; });
      await Promise.race([active, sleep(quickMs)]); return snapshot(value);
    },
    async status(id = null) {
      if (id && id !== COMFY_SETUP_ID) return { setups: [] };
      await restored; job ||= restoredJob;
      while (active && job?.state !== "running") await active;
      let recipe;
      if (active) recipe = { diskGb: 16, downloadGb: "6-15", freeGb: null, ...job.recipe, ready: false, blocked: null };
      // Polling reads local state only. target() is the explicit run's verified
      // release check; a cached callback must never perform discovery itself.
      else try { const tag = await targetCached(); recipe = await read(stableComfyTag(tag) ? tag : null); }
      catch (error) { recipe = { ready: false, blocked: clean(error?.message || error), diskGb: 16, downloadGb: "6-15", freeGb: null }; }
      if (!active && !recipe.blocked && !recipe.ready && recipe.freeGb !== null && recipe.freeGb < recipe.diskGb
        && !await reusable(job?.root, recipe.backend, recipe.tag)) recipe.blocked = `Free about ${recipe.diskGb} GB on Studio's drive before updating ComfyUI.`;
      return { setups: [{ id: COMFY_SETUP_ID, label: "ComfyUI update", title: "ComfyUI update", button: job?.state === "failed" ? "Try again" : "Update ComfyUI",
        readyWords: "ComfyUI is up to date", capability: COMFY_SETUP_ID, ready: recipe.ready, blocked: recipe.blocked || null,
        offer: recipe.blocked || `Installs ${recipe.tag ? `ComfyUI ${recipe.tag}` : "a verified ComfyUI update"} beside the current engine and keeps the previous engine.`,
        tag: recipe.tag || null, version: recipe.version || null, backend: recipe.backend || null,
        downloadGb: recipe.downloadGb, diskGb: recipe.diskGb, freeGb: recipe.freeGb,
        progressOnly: true, sizeWords: `About ${recipe.downloadGb} GB download · ${recipe.diskGb} GB disk space`,
        root: job?.root || null, missing: [], job: snapshot(job) }] };
    },
  };
}
