/** The update coordinator. Checking is read-only; installing requires a local
 * button/tool press and a completed Studio-owned engine without custom nodes. */
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { STUDIO_NODES_DIR, VENDORED_NODES, MARKER as STUDIO_COPY_MARKER } from "../comfy_nodes.js";
import { createComfyReleaseChecker, compareComfyVersions } from "../comfy-updates.js";
import { COMFY_TAG } from "./pins.js";
import { samePath, venvPython } from "./engine-packages.js";
import { createComfyEngineRunner, COMFY_SETUP_ID } from "./comfy-engine.js";
import { createComfyActivation } from "./qwen-activation.js";

const GUIDE = "https://docs.comfy.org/installation/update_comfyui";
const STANDARD_NODES = new Set(["example_node.py.example", "websocket_image_save.py", "__pycache__", ".gitkeep"]);
const CORE_NODES = ["CheckpointLoaderSimple", "KSampler", "EmptyLatentImage", "VAEDecode", "SaveImage",
  "AiplaySafetyRefusal", "AiplayH3ConditioningBridge", "AiplayHintLift", "AiplayIPAdapterLoader", "AiplayIPAdapterApply",
  "AiplaySaveLossJson", "AiplayPromptSchedule", "AiplayYuE2Score", "AiplayYuE2Continue", "AiplaySparseCtrlLoader",
  "AiplaySparseCtrlApply", "AiplayControlNetLoaderSliding"];
async function readJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }
const isFile = async (file) => typeof file === "string" && (await stat(file).catch(() => null))?.isFile() === true;

/** Ownership never follows from who launched the child process. We only build
 * beside a private installation with its original, matching interpreter. */
export async function comfyUpdateEligibility(config, env = process.env) {
  const marker = await readJson(path.join(config.rig, ".aiplay-engine.json"));
  const managed = marker?.complete === true;
  const result = (blocked) => ({ managed, marker, blocked, guideUrl: GUIDE });
  if (config.remoteOnly || config.cloudOnly || config.musicOnly) return result("Open Full Studio with a local engine to update ComfyUI.");
  if (env.AIPLAY_RIG || env.AIPLAY_PYTHON) return result("A launch override selects this engine. Remove the override before updating it through Studio.");
  if (!managed) return result("Managed by your ComfyUI installer. Use its updater for Desktop, portable or source installations.");
  if (!samePath(config.comfyDir, path.join(config.rig, "ComfyUI")) || !samePath(config.python, venvPython(config.rig))) {
    return result("This installation uses a different interpreter or engine folder. Use its own updater.");
  }
  if (config.comfy.extraArgs?.some((arg) => /^--(?:base-directory|extra-custom-node-paths|custom-node-paths)(?:=|$)/.test(arg))) {
    return result("This engine uses a custom folder layout. Update it with its own tools to preserve that layout.");
  }
  for (const file of [config.rig, config.comfyDir, path.join(config.rig, ".aiplay-engine.json")]) {
    if ((await lstat(file).catch(() => null))?.isSymbolicLink()) return result("This engine uses linked installation folders. Use its own updater.");
  }
  if (!await isFile(config.python) || !await isFile(path.join(config.comfyDir, "main.py"))) return result("The current engine is incomplete. Repair its installation before updating.");
  const nodeRoot = path.join(config.comfyDir, "custom_nodes");
  let nodes;
  try {
    if ((await lstat(nodeRoot)).isSymbolicLink()) return result("This engine uses linked custom-node folders. Use its own updater.");
    nodes = await readdir(nodeRoot);
  }
  catch (error) { if (error.code !== "ENOENT") return result("Studio could not check custom nodes. Restore access to the engine folder first."); nodes = []; }
  const foreign = () => result("This engine has custom nodes. Update it with its own tools so those nodes and their packages stay together.");
  try {
    const bundled = new Set((await readdir(STUDIO_NODES_DIR)).filter(name => /^aiplay_[a-z0-9_]+\.py$/.test(name)));
    const sameFile = async (installed, source) => (await lstat(installed)).isFile()
      && (await readFile(installed)).equals(await readFile(source));
    async function studioFolder(name) {
      const folder = path.join(nodeRoot, name), source = path.join(STUDIO_NODES_DIR, name);
      if (!(await lstat(folder)).isDirectory()) return false;
      const markerFile = path.join(folder, STUDIO_COPY_MARKER);
      if (!(await lstat(markerFile)).isFile()) return false;
      const copy = await readJson(markerFile);
      if (!copy || typeof copy.createdFolder !== "boolean" || !copy.files || typeof copy.files !== "object" || Array.isArray(copy.files)) return false;
      const shipped = (await readdir(source)).filter(file => /\.py$|^LICENSE$/.test(file));
      if (!shipped.length || Object.keys(copy.files).length !== shipped.length) return false;
      for (const file of shipped) {
        const original = await readFile(path.join(source, file));
        const digest = createHash("sha256").update(original).digest("hex");
        if (copy.files[file] !== digest || !await sameFile(path.join(folder, file), path.join(source, file))) return false;
      }
      for (const file of await readdir(folder)) {
        if (file === STUDIO_COPY_MARKER || shipped.includes(file)) continue;
        if (file !== "__pycache__") return false;
        const cache = path.join(folder, file);
        if (!(await lstat(cache)).isDirectory()) return false;
        const stems = shipped.filter(file => file.endsWith(".py")).map(file => file.slice(0, -3));
        for (const bytecode of await readdir(cache)) {
          if (!bytecode.endsWith(".pyc") || !stems.some(stem => bytecode.startsWith(`${stem}.`))
            || !(await lstat(path.join(cache, bytecode))).isFile()) return false;
        }
      }
      return true;
    }
    for (const name of nodes) {
      if (STANDARD_NODES.has(name)) continue;
      if (bundled.has(name) && await sameFile(path.join(nodeRoot, name), path.join(STUDIO_NODES_DIR, name))) continue;
      if (VENDORED_NODES.includes(name) && await studioFolder(name)) continue;
      return foreign();
    }
  } catch { return foreign(); }
  return result(null);
}

export function createComfyMaintenance({ config, engine, supervisor, busy = async () => false,
  vendor = () => "cpu", gpuName = () => "", env = process.env,
  checker = createComfyReleaseChecker({ cacheFile: path.join(config.dataDir, "comfy-release.json") }),
  runnerFactory = createComfyEngineRunner, activationFactory = createComfyActivation } = {}) {
  let checking = 0, restoring = false;
  async function check({ force = false } = {}) {
    checking++;
    try { return await checker.check({ force }); }
    finally { checking--; }
  }
  async function installedVersion(marker) {
    // The release file is authoritative even before ComfyUI finishes starting;
    // reading it runs no Python and also works for external installations.
    try {
      const text = await readFile(path.join(config.comfyDir, "comfyui_version.py"), "utf8");
      const version = text.match(/__version__\s*=\s*["'](\d+\.\d+\.\d+)["']/)?.[1];
      if (version) return version;
    } catch { /* older or external engine: use its runtime/installation record */ }
    const state = await engine.status().catch(() => null);
    return state?.version || marker?.comfy || null;
  }
  async function readiness(metadata = null) {
    const facts = await engine.refreshFacts();
    const state = await engine.status();
    if (!state.ready) return { runtimeReady: false, version: facts?.version || null, error: "The engine did not become ready." };
    if (metadata?.comfy && compareComfyVersions(facts?.version, metadata.comfy) !== 0) {
      return { runtimeReady: false, version: facts?.version || null, error: "The running ComfyUI version does not match the downloaded release." };
    }
    if (!metadata) return { runtimeReady: true, version: facts?.version || state.version || null };
    const nodes = await engine.objectInfo();
    const missing = CORE_NODES.filter((name) => !nodes?.[name]);
    return { runtimeReady: missing.length === 0, version: facts?.version || state.version || null,
      ...(missing.length ? { error: `The engine could not load required nodes: ${missing.join(", ")}.` } : {}) };
  }
  const activation = activationFactory({ config, supervisor, engine, readiness, busy });
  async function blockedBy() {
    if (restoring) return "The previous engine is being restored.";
    return (await comfyUpdateEligibility(config, env)).blocked;
  }
  const runner = runnerFactory({ appData: config.dataDir, readiness, vendor, gpuName, busy, blockedBy,
    targetCached: async () => { const release = await checker.cached(); return release?.ok ? release.latest?.tag || null : null; },
    selection: () => ({ rig: config.rig, python: config.python }),
    target: async () => {
      const release = await check({ force: true });
      if (!release.ok || !release.latest) throw new Error(release.error || "Check for a stable ComfyUI release first.");
      const marker = (await comfyUpdateEligibility(config, env)).marker;
      const version = await installedVersion(marker);
      const order = compareComfyVersions(version, release.latest.tag);
      if (order === null) throw new Error("Studio could not identify this engine's release. Use its own updater.");
      if (order >= 0) throw new Error("This engine is already on the latest stable release or newer.");
      return release.latest.tag;
    }, activate: (metadata) => activation.activate(metadata) });

  async function previousSelection() {
    if (env.AIPLAY_RIG || env.AIPLAY_PYTHON || config.remoteOnly || config.cloudOnly || config.musicOnly) return null;
    const settings = await readJson(config.settingsFile);
    const old = settings?.previousEngine;
    if (!samePath(settings?.comfyUpdate?.rig, config.rig) || !old || typeof old.rig !== "string"
      || !path.isAbsolute(old.rig) || samePath(old.rig, config.rig) || !samePath(old.python, venvPython(old.rig))) return null;
    for (const key of ["modelsDir", "outputDir", "inputDir"]) if (typeof old[key] !== "string" || !path.isAbsolute(old[key])) return null;
    if ((await readJson(path.join(old.rig, ".aiplay-engine.json")))?.complete !== true
      || !await isFile(old.python) || !await isFile(path.join(old.rig, "ComfyUI", "main.py"))) return null;
    return old;
  }
  async function status({ force = false } = {}) {
    if (force) await check({ force: true });
    const [release, eligibility, setups, previous] = await Promise.all([
      checker.cached(), comfyUpdateEligibility(config, env), runner.status(COMFY_SETUP_ID), previousSelection(),
    ]);
    const installed = await installedVersion(eligibility.marker);
    const order = compareComfyVersions(installed, release?.latest?.tag);
    const job = setups?.setups?.[0]?.job || null;
    const rendering = await Promise.resolve().then(busy).catch(() => "Studio could not check the render queue.");
    const wait = rendering ? typeof rendering === "string" ? rendering : "Wait for the current work to finish." : null;
    const active = job?.state === "running" || restoring;
    const updateAvailable = release?.ok === true && order === -1;
    return { ok: true, installed, tested: COMFY_TAG, latest: release?.latest || null, checkedAt: release?.checkedAt ?? null,
      checking: checking > 0, checkOk: release?.ok === true, error: release?.error || null,
      restoring,
      checkUpdatesOnStart: config.comfy.checkUpdatesOnStart !== false,
      managed: eligibility.managed, guideUrl: eligibility.guideUrl, updateAvailable,
      blocked: active ? "An engine update is running." : eligibility.blocked || wait
        || (!release?.ok ? "Check for a stable release before updating." : order === null ? "Studio could not identify the installed release."
          : !updateAvailable ? "This engine is already on the latest stable release or newer." : null),
      canRestore: !!previous, restoreBlocked: active ? "An engine update is running." : wait,
      job, setup: setups?.setups?.[0] || null };
  }
  async function restore() {
    if (restoring) throw new Error("The previous engine is already being restored.");
    restoring = true;
    try {
      const state = await runner.status(COMFY_SETUP_ID);
      if (state?.setups?.[0]?.job?.state === "running") throw new Error("Wait for the engine update to finish before restoring.");
      const previous = await previousSelection();
      if (!previous) throw new Error("There is no verified previous Studio engine to restore.");
      return await activation.restore(previous);
    } finally { restoring = false; }
  }
  return { runner, status, check, readiness, restore,
    async start() {
      if (config.comfy.checkUpdatesOnStart === false || config.remoteOnly || config.cloudOnly
        || !await isFile(path.join(config.comfyDir, "main.py"))) return null;
      return check();
    },
    async update() { return runner.run(COMFY_SETUP_ID); },
  };
}
