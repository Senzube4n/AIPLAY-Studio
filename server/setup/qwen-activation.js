/**
 * Switch to a staged Qwen engine only while the engine door is idle. Settings
 * still name the old engine until the new process proves its Qwen nodes. A
 * crash during that test therefore starts the old engine on the next launch.
 * The journal and previousEngine record retain both selections for recovery.
 */
import * as fileSystem from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ENGINE_KEYS = ["rig", "python", "torchBackend", "torchVersion", "gpu", "comfyExtraArgs", "comfyUseInstallFlags", "launchFrom", "engineInstall"];
const SELECTION_KEYS = [...ENGINE_KEYS, "modelsDir", "modelsAlso", "outputDir", "inputDir"];
const CONFIG_KEYS = ["rig", "python", "comfyDir", "torchBackend", "torchVersion", "gpu", "modelsDir", "modelsAlso", "outputDir", "inputDir"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const uniquePaths = (paths) => {
  const seen = new Set();
  return paths.filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)).filter((value) => {
    const key = pathKey(value);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
};

function failure(message, code, props = {}) {
  return Object.assign(new Error(message), { code, ...props });
}

/** Relative Desktop/source YAML arguments must keep referring to the old rig. */
export function qwenActivationArgs(oldArgs = [], candidateArgs = [], oldComfyDir) {
  const args = oldArgs.map(String).filter((arg) => arg !== "--cpu");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user-directory" && i + 1 < args.length) {
      args[++i] = path.resolve(oldComfyDir, args[i]);
    } else if (args[i].startsWith("--user-directory=")) {
      args[i] = `--user-directory=${path.resolve(oldComfyDir, args[i].slice("--user-directory=".length))}`;
    } else if (args[i] === "--extra-model-paths-config") {
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        args[i] = path.resolve(oldComfyDir, args[i]);
      }
    } else if (args[i].startsWith("--extra-model-paths-config=")) {
      args[i] = `--extra-model-paths-config=${path.resolve(oldComfyDir, args[i].slice("--extra-model-paths-config=".length))}`;
    }
  }
  for (const arg of candidateArgs.map(String)) if (!args.includes(arg)) args.push(arg);
  return args;
}

export function createQwenActivation({ config, supervisor, engine, readiness, busy = async () => false, fs = fileSystem,
  purpose = "Qwen", operation = "repair", codePrefix = "QWEN", journalName = "qwen-activation.json", recordKey = null, keepUserDirectory = false }) {
  if (!config || !supervisor || !engine || typeof readiness !== "function") throw new TypeError("Qwen activation requires config, supervisor, engine and readiness.");
  const fail = (message, code, props) => failure(message, `${codePrefix}_${code}`, props);
  let switching = false;

  async function readSettings() {
    let text;
    try { text = await fs.readFile(config.settingsFile, "utf8"); }
    catch (cause) {
      if (cause.code === "ENOENT") return {};
      throw fail("Studio settings could not be read. Try again after restoring access to the settings file.", "SETTINGS_UNREADABLE", { cause });
    }
    let value;
    try { value = JSON.parse(text); }
    catch (cause) { throw fail(`Studio settings are not valid JSON. Restore the settings file before the ${purpose} ${operation}.`, "SETTINGS_UNREADABLE", { cause }); }
    if (!object(value)) throw fail(`Studio settings must contain a JSON object. Restore the settings file before the ${purpose} ${operation}.`, "SETTINGS_UNREADABLE");
    return value;
  }

  async function writeAtomic(file, value, beforeRename = null) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close(); handle = null;
      if (beforeRename) await beforeRename();
      await fs.rename(temporary, file);
    } catch (cause) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw cause;
    }
  }

  async function assertIdle() {
    const state = await busy();
    if (state && (typeof state !== "object" || state.busy || state.blocked)) {
      throw fail(typeof state === "string" ? state : state.message || `Studio is working. Try the ${purpose} ${operation} after it finishes.`, "ENGINE_BUSY");
    }
  }

  async function pauseDoor() {
    const until = Date.now() + 5000;
    for (;;) {
      try { return engine.pauseSubmissions(`${purpose} engine ${operation}`); }
      catch (cause) {
        // The assistant's repair tool returns before the turn releases its
        // own chat hold. Wait briefly for precisely that hold, never renders.
        if (cause.onlyChatHold !== true || Date.now() >= until) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  async function switchEngine(metadata, restoreSelection = null) {
    if (switching) throw fail(`A ${purpose} engine switch is already running.`, "ENGINE_BUSY");
    if (!object(metadata) || metadata.stageOnly !== true || typeof metadata.rig !== "string" || !path.isAbsolute(metadata.rig)
      || typeof metadata.python !== "string" || !path.isAbsolute(metadata.python) || !object(metadata.engineInstall)) {
      throw fail(`The ${purpose} installer did not return a completed staged engine.`, "STAGE_INVALID");
    }
    if (pathKey(metadata.rig) === pathKey(config.rig)) throw fail(`${purpose} ${operation} requires a separate engine folder.`, "STAGE_INVALID");
    switching = true;
    let release = null, original = null, previousEngine = null, stopped = false, committed = false;
    const journalFile = path.join(path.dirname(config.settingsFile), journalName);
    try {
      // This is synchronous: no dispatch can enter between checking and pausing.
      release = await pauseDoor();
      await assertIdle();
      const settings = await readSettings();
      if (recordKey && ((settings.rig && !same(pathKey(settings.rig), pathKey(config.rig)))
        || (settings.python && !same(pathKey(settings.python), pathKey(config.python))))) {
        throw fail("The saved engine selection changed. Restart Studio before updating it.", "STAGE_INVALID");
      }
      if (restoreSelection && (!recordKey || !same(settings.previousEngine, restoreSelection)
        || settings[recordKey]?.rig !== config.rig)) throw fail("The previous engine selection changed. Check again before restoring it.", "STAGE_INVALID");
      if (!(await fs.stat(metadata.python)).isFile() || !(await fs.stat(path.join(metadata.rig, "ComfyUI", "main.py"))).isFile()) {
        throw fail("The staged engine is missing its interpreter or main.py.", "STAGE_INVALID");
      }
      const descriptors = Object.fromEntries(CONFIG_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(config, key)]));
      const comfyDescriptors = Object.fromEntries(["extraArgs", "useInstallFlags"].map((key) => [key, Object.getOwnPropertyDescriptor(config.comfy, key)]));
      original = { descriptors, comfyDescriptors };
      const oldArgs = [...(config.comfy.extraArgs || [])];
      const modelsDir = config.modelsDir;
      const modelsAlso = uniquePaths([...(config.modelsAlso || []), path.join(config.comfyDir, "models")]).filter((value) => pathKey(value) !== pathKey(modelsDir));
      // A user who disabled the old install's flags must not unexpectedly
      // reactivate them. The new managed install always uses its own required
      // flags, especially --cpu on a machine with no supported graphics card.
      const extraArgs = qwenActivationArgs(config.comfy.useInstallFlags === false ? [] : oldArgs, metadata.comfyExtraArgs || [], config.comfyDir);
      let userCopy = null;
      if (keepUserDirectory && !restoreSelection) {
        let userDir = path.join(config.comfyDir, "user"), explicitUserDir = false;
        for (let i = 0; i < extraArgs.length; i++) {
          if (extraArgs[i] === "--user-directory") { explicitUserDir = true; userDir = extraArgs[i + 1]; extraArgs.splice(i, 2); i--; }
          else if (extraArgs[i].startsWith("--user-directory=")) { explicitUserDir = true; userDir = extraArgs[i].slice("--user-directory=".length); extraArgs.splice(i--, 1); }
        }
        let userInfo = null;
        try { userInfo = await fs.stat(userDir); }
        catch (cause) { if (cause.code !== "ENOENT" || explicitUserDir) throw new Error(`The existing ComfyUI user folder could not be read: ${cause.message}`); }
        if (userInfo && !userInfo.isDirectory()) throw new Error("The existing ComfyUI user path is not a folder.");
        if (userInfo) {
          const to = path.join(metadata.rig, `studio-user-${randomUUID()}`);
          userCopy = { from: userDir, to };
          extraArgs.push("--user-directory", to);
        }
      }
      previousEngine = {
        ...Object.fromEntries(ENGINE_KEYS.filter((key) => Object.hasOwn(settings, key)).map((key) => [key, clone(settings[key])])),
        rig: config.rig, python: config.python, comfyDir: config.comfyDir,
        torchBackend: config.torchBackend, gpu: clone(config.gpu), comfyExtraArgs: oldArgs,
        comfyUseInstallFlags: config.comfy.useInstallFlags !== false,
        modelsDir, modelsAlso: clone(config.modelsAlso || []), outputDir: config.outputDir, inputDir: config.inputDir,
        at: new Date().toISOString(),
      };
      const candidate = restoreSelection ? {
        ...Object.fromEntries(ENGINE_KEYS.map((key) => [key, clone(restoreSelection[key])])),
        modelsDir: restoreSelection.modelsDir, modelsDirPinned: true,
        modelsAlso: clone(restoreSelection.modelsAlso || []), outputDir: restoreSelection.outputDir, inputDir: restoreSelection.inputDir,
      } : {
        rig: metadata.rig, python: metadata.python, torchBackend: metadata.torchBackend,
        torchVersion: metadata.torch, gpu: clone(metadata.gpu), comfyExtraArgs: extraArgs,
        comfyUseInstallFlags: true,
        launchFrom: metadata.launchFrom, engineInstall: clone(metadata.engineInstall),
        modelsDir, modelsDirPinned: true, modelsAlso, outputDir: config.outputDir, inputDir: config.inputDir,
      };
      await writeAtomic(journalFile, { state: "verifying", at: new Date().toISOString(), previousEngine, candidate });
      // Jobs may have been queued during filesystem work; refuse before stopping.
      await assertIdle();
      stopped = true;
      await supervisor.stop();
      if (supervisor.proc) throw new Error("The previous engine did not stop.");
      // Copy only after shutdown so ComfyUI's database is closed. A new
      // release may migrate that database; the original must remain usable.
      if (userCopy) await fs.cp(userCopy.from, userCopy.to, { recursive: true, dereference: true, errorOnExist: true, force: false });
      for (const key of CONFIG_KEYS) {
        const value = key === "comfyDir" ? path.join(metadata.rig, "ComfyUI") : candidate[key];
        Object.defineProperty(config, key, { configurable: true, enumerable: true, writable: true, value });
      }
      config.comfy.extraArgs = candidate.comfyExtraArgs;
      config.comfy.useInstallFlags = candidate.comfyUseInstallFlags;
      await supervisor.start();
      const check = await readiness(metadata);
      if (check?.runtimeReady !== true) throw new Error(check?.error || (purpose === "Qwen"
        ? `The new engine could not load Qwen Image 2.1${check?.missingNodes?.length ? ` (${check.missingNodes.join(", ")})` : ""}.`
        : "The new ComfyUI engine did not pass its startup checks."));
      const fresh = await readSettings();
      if (SELECTION_KEYS.some((key) => !same(settings[key], fresh[key]))) throw new Error("The engine settings changed during repair. Try again with the current settings.");
      if (restoreSelection && (!same(fresh.previousEngine, restoreSelection) || !same(settings[recordKey], fresh[recordKey]))) {
        throw new Error("The previous engine selection changed during restoration. Check again before restoring it.");
      }
      await writeAtomic(config.settingsFile, { ...fresh, ...candidate, previousEngine,
        ...(recordKey ? { [recordKey]: restoreSelection ? null : { rig: metadata.rig, tag: metadata.comfy, at: new Date().toISOString() } } : {}) }, async () => {
        const latest = await readSettings();
        if (!same(fresh, latest)) throw new Error("Studio settings changed while saving the engine. Try again.");
      });
      committed = true;
      let warning;
      try { await fs.unlink(journalFile); }
      catch (cause) { if (cause.code !== "ENOENT") warning = `${purpose} is ready. The recovery record could not be removed.`; }
      return { ok: true, activated: true, runtimeReady: true, rig: metadata.rig, python: metadata.python, previousEngine, ...(warning ? { warning } : {}) };
    } catch (cause) {
      if (!stopped || !original || committed) throw cause;
      let rollbackCause = null;
      try {
        await supervisor.stop();
        if (supervisor.proc) throw new Error("The engine process did not stop.");
      } catch (error) { rollbackCause = error; }
      for (const key of CONFIG_KEYS) {
        if (original.descriptors[key]) Object.defineProperty(config, key, original.descriptors[key]);
        else delete config[key];
      }
      for (const [key, descriptor] of Object.entries(original.comfyDescriptors)) {
        if (descriptor) Object.defineProperty(config.comfy, key, descriptor);
        else delete config.comfy[key];
      }
      try {
        if (supervisor.proc) throw new Error("The engine process is still running.");
        await supervisor.start();
      } catch (error) { rollbackCause = rollbackCause || error; }
      if (rollbackCause) {
        await writeAtomic(journalFile, { state: "rollback-failed", at: new Date().toISOString(), previousEngine, error: cause.message, rollbackError: rollbackCause.message }).catch(() => {});
        throw fail(`${purpose} ${operation} failed: ${cause.message} The previous engine could not restart: ${rollbackCause.message}`, "ROLLBACK_FAILED", { cause, rollbackCause, rolledBack: false, previousEngine });
      }
      await fs.unlink(journalFile).catch(() => {});
      throw fail(`${purpose} ${operation} failed: ${cause.message} The previous engine was restored.`, "ACTIVATION_FAILED", { cause, rolledBack: true, previousEngine });
    } finally {
      if (release) release();
      switching = false;
    }
  }

  return {
    activate: (metadata) => switchEngine(metadata),
    // Only the update coordinator exposes this; its eligibility check verifies
    // the kept managed installation before handing us the saved selection.
    restore: (selection) => switchEngine({ ...selection, stageOnly: true,
      engineInstall: selection?.engineInstall || {}, comfy: selection?.engineInstall?.comfy,
      torch: selection?.torchVersion }, selection),
  };
}

export function createComfyActivation(options) {
  return createQwenActivation({ ...options, purpose: "ComfyUI", operation: "update", codePrefix: "COMFY",
    journalName: "comfy-activation.json", recordKey: "comfyUpdate", keepUserDirectory: true });
}
