/** Local VST3 effects inventory. Scanning never loads a plugin binary. */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, copyFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { ensureUv } from "../setup/uv.js";
import { UV_PRIVATE_ENV, UV_PYTHON_INSTALL_ARGS } from "../setup/pins.js";
import { killMeshProcessTree } from "../mesh/runner.js";

const WORKER = fileURLToPath(new URL("./plugin_worker.py", import.meta.url));
const MAX_FILES = 10000, MAX_BYTES = 1024 * 1024 * 1024;
const STATE_LIMIT = 4 * 1024 * 1024;
export const PLUGIN_ACTIONS = Object.freeze(["plugin_scan", "plugin_inspect", "plugin_install", "plugin_setup"]);
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = p => process.platform === "win32" ? p.toLowerCase() : p;
const idFor = p => "vst_" + createHash("sha256").update(canonical(p)).digest("hex");
const pyAt = root => path.join(root, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const plain = x => x && typeof x === "object" && !Array.isArray(x);

async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }).catch(() => {}); }
}

/** Shared byte-for-byte with plugin_worker.py, including all bundle files. */
export async function fingerprintPlugin(root) {
  const top = await lstat(root);
  if (top.isSymbolicLink()) throw new Error("Plugin bundles cannot contain symbolic links.");
  const files = [], hash = createHash("sha256");
  let total = 0;
  async function visit(file, rel) {
    const st = await lstat(file);
    if (st.isSymbolicLink()) throw new Error("Plugin bundles cannot contain symbolic links.");
    if (st.isDirectory()) {
      for (const name of (await readdir(file)).sort(lexical)) await visit(path.join(file, name), rel ? rel + "/" + name : name);
    } else if (st.isFile()) {
      total += st.size;
      if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error("Plugin bundle exceeds its file or 1 GiB size limit.");
      files.push({ file, rel, st });
    } else throw new Error("Plugin bundle contains a non-regular file.");
  }
  await visit(root, "");
  if (!files.length) throw new Error("Plugin bundle is empty.");
  // UTF-8 ordering matches Python's Unicode path order even for astral names.
  files.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)));
  for (const { file, rel, st } of files) {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    const after = await lstat(file);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error("Plugin changed while its contents were checked.");
    hash.update(rel + "\0" + st.size + ":" + digest.digest("hex") + "\0");
  }
  return hash.digest("hex");
}

export function normalizePluginParams(schema, raw = {}) {
  if (!plain(raw) || Object.keys(raw).length > 256) throw new Error("Use a plugin parameter object with at most 256 entries.");
  for (const key of Object.keys(raw)) if (!Object.hasOwn(schema, key)) throw new Error("Unknown plugin parameter: " + key);
  const params = {};
  for (const [key, spec] of Object.entries(schema)) {
    const value = Object.hasOwn(raw, key) ? raw[key] : spec.default;
    if (spec.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min || value > spec.max)
        throw new Error(`${key} requires a number from ${spec.min} to ${spec.max}.`);
      if (spec.step && Math.abs((value - spec.min) / spec.step - Math.round((value - spec.min) / spec.step)) > 1e-6)
        throw new Error(`${key} requires one of its supported numeric steps.`);
    } else if (spec.type === "bool") {
      if (typeof value !== "boolean") throw new Error(`${key} requires true or false.`);
    } else if (spec.type === "enum") {
      if (!spec.values.includes(value)) throw new Error(`${key} requires one of its listed values.`);
    } else throw new Error("Unsupported plugin parameter: " + key);
    Object.defineProperty(params, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return params;
}

function descriptorChecked(id, fingerprint, result) {
  if (!plain(result.parameters) || Object.keys(result.parameters).length > 256) throw new Error("Plugin returned an unsupported parameter catalog.");
  const parameters = {};
  for (const [key, spec] of Object.entries(result.parameters)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,119}$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key) || !plain(spec)) throw new Error("Plugin returned an invalid parameter name.");
    const s = { type: spec.type, label: String(spec.label || key).slice(0, 160), default: spec.default };
    if (s.type === "number") {
      if (![spec.min, spec.max, spec.default].every(x => typeof x === "number" && Number.isFinite(x)) || spec.min > spec.max)
        throw new Error("Plugin returned an invalid number range.");
      s.min = spec.min; s.max = spec.max;
      if (typeof spec.step === "number" && Number.isFinite(spec.step) && spec.step > 0) s.step = spec.step;
    } else if (s.type === "bool") {
      if (typeof s.default !== "boolean") throw new Error("Plugin returned an invalid switch.");
    } else if (s.type === "enum") {
      if (!Array.isArray(spec.values) || !spec.values.length || spec.values.length > 256
        || spec.values.some(x => typeof x !== "string" || x.length > 256 || /[\x00-\x1f\x7f]/.test(x))) throw new Error("Plugin returned an invalid choice list.");
      s.values = [...spec.values];
    } else throw new Error("Plugin returned an unsupported parameter type.");
    Object.defineProperty(parameters, key, { value: s, enumerable: true, configurable: true, writable: true });
  }
  normalizePluginParams(parameters);
  if (typeof result.state !== "string" || result.state.length > Math.ceil(STATE_LIMIT / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.state)
    || Buffer.from(result.state, "base64").length > STATE_LIMIT) throw new Error("Plugin returned invalid preset state.");
  if (typeof result.hostVersion !== "string" || !result.hostVersion || result.hostVersion.length > 80) throw new Error("Plugin host version is missing.");
  return { id, label: String(result.label || "VST3 effect").slice(0, 160), fingerprint,
    hostVersion: result.hostVersion, parameters, state: result.state,
    latencySamples: Number.isSafeInteger(result.latencySamples) && result.latencySamples >= 0 ? result.latencySamples : 0 };
}

function execute(cli, args, { env = process.env, timeoutMs = 60000, json = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure = null;
    const stop = reason => { failure ||= new Error(reason); killMeshProcessTree(proc.pid).catch(() => { proc.kill(); }); };
    const timer = setTimeout(() => stop("The VST host exceeded its time limit. This plugin may be incompatible."), timeoutMs);
    proc.stdout.on("data", data => { stdout += data; if (stdout.length > 8 * 1024 * 1024) stop("The VST host returned too much output."); });
    proc.stderr.on("data", data => { stderr = (stderr + data).slice(-32768); });
    proc.on("error", error => { failure = error; });
    proc.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      let result;
      if (json) for (const line of stdout.trim().split(/\r?\n/).reverse()) {
        try { const value = JSON.parse(line); if (plain(value) && typeof value.ok === "boolean") { result = value; break; } } catch {}
      }
      if (code !== 0 || (json && (!result || result.ok === false))) return reject(new Error(result?.error || stderr.slice(-2000) || `VST host exited (${code}).`));
      resolve(json ? result : { stdout, stderr });
    });
  });
}

export function createPluginManager({ config, runWorker, runCommand = execute, ensureUvImpl = ensureUv } = {}) {
  const appData = config?.paths?.appData || process.env.AIPLAY_APPDATA || path.join(os.homedir(), ".aiplay-studio");
  const root = path.join(appData, "daw-plugins"), registry = path.join(root, "registry.json");
  const installedDir = path.join(root, "installed"), stagingDir = path.join(root, "staging");
  const hostRoot = path.join(root, "host"), ownedPython = pyAt(path.join(hostRoot, "venv"));
  let hostCache, setupActive, pending = Promise.resolve();
  const runtimePython = () => process.env.AIPLAY_VST_PYTHON
    || (existsSync(ownedPython) ? ownedPython : pyAt(path.join(process.env.AIPLAY_MUSIC_TOOLS_ROOT || path.join(config?.rig || root, "community-tools"), "processing-venv")));
  const env = () => ({ AIPLAY_DAW_PLUGIN_REGISTRY: registry, AIPLAY_VST_PYTHON: runtimePython() });
  const serialize = fn => { const task = pending.then(fn); pending = task.catch(() => {}); return task; };
  async function readRegistry() {
    try {
      const content = await readFile(registry, "utf8");
      if (content.length > 32 * 1024 * 1024) throw new Error("Plugin registry exceeds its size limit.");
      const data = JSON.parse(content);
      if (data.version !== 1 || !plain(data.plugins)) throw new Error("Plugin registry format is invalid.");
      return data;
    } catch (error) { if (error.code === "ENOENT") return { version: 1, plugins: {}, folders: [] }; throw error; }
  }
  async function worker(job, { python = runtimePython(), timeoutMs = 60000 } = {}) {
    if (runWorker) return runWorker(job, { python, timeoutMs });
    await mkdir(stagingDir, { recursive: true });
    const file = path.join(stagingDir, randomUUID() + ".json");
    try {
      await writeFile(file, JSON.stringify(job), { mode: 0o600 });
      return await runCommand(python, [WORKER, "--request", file], { timeoutMs, json: true,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" } });
    } finally { await rm(file, { force: true }).catch(() => {}); }
  }
  async function host(refresh = false) {
    const python = runtimePython();
    if (!refresh && hostCache?.python === python && Date.now() - hostCache.at < 60000) return hostCache.value;
    let value;
    try { const result = await worker({ op: "probe" }, { python, timeoutMs: 15000 }); value = { ready: true, python, version: result.version }; }
    catch (error) { value = { ready: false, python, version: null, error: `Set up the VST3 host: ${String(error.message).slice(0, 300)}` }; }
    hostCache = { python, at: Date.now(), value };
    return value;
  }
  function defaultFolders() {
    if (process.platform === "win32") return [path.join(process.env.CommonProgramFiles || "C:/Program Files/Common Files", "VST3"),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "Programs/Common/VST3")];
    if (process.platform === "darwin") return ["/Library/Audio/Plug-Ins/VST3", path.join(os.homedir(), "Library/Audio/Plug-Ins/VST3")];
    return [path.join(os.homedir(), ".vst3"), "/usr/lib/vst3", "/usr/local/lib/vst3"];
  }
  function checkedFolders(value) {
    if (!Array.isArray(value) || value.length > 16 || value.some(x => typeof x !== "string" || !path.isAbsolute(x) || x.length > 4096
      || path.resolve(x) === path.parse(path.resolve(x)).root)) throw new Error("Choose up to 16 absolute plugin folders, below a drive root.");
    return [...new Set(value.map(x => path.resolve(x)))];
  }
  async function candidates(folders) {
    const found = [], visited = new Set();
    let nodes = 0;
    async function walk(dir, depth) {
      if (depth > 8 || ++nodes > 20000) return;
      let st; try { st = await lstat(dir); } catch { return; }
      if (st.isSymbolicLink()) return;
      if (/\.vst3$/i.test(dir)) {
        if (st.isFile() || st.isDirectory()) {
          const file = await realpath(dir);
          if (!visited.has(canonical(file))) { visited.add(canonical(file)); found.push(file); }
        }
        return;
      }
      if (!st.isDirectory()) return;
      for (const name of (await readdir(dir)).sort(lexical)) await walk(path.join(dir, name), depth + 1);
    }
    for (const folder of folders) await walk(folder, 0);
    return found;
  }
  async function list({ refresh = false, folders } = {}) {
    return serialize(async () => {
      const data = await readRegistry();
      if (folders !== undefined) data.folders = checkedFolders(folders);
      const roots = [...new Set([installedDir, ...defaultFolders(), ...(data.folders || [])])];
      const found = await candidates(roots);
      for (const file of found) {
        const id = idFor(file);
        data.plugins[id] ||= { path: file, status: "uninspected", name: path.basename(file).replace(/\.vst3$/i, "") };
      }
      const rows = [];
      for (const [id, entry] of Object.entries(data.plugins)) {
        let exists = false; try { exists = (await lstat(entry.path)).isFile() || (await lstat(entry.path)).isDirectory(); } catch {}
        const status = !exists ? "missing" : entry.status || "uninspected";
        const descriptor = entry.descriptor;
        rows.push({ id, name: descriptor?.label || entry.name || path.basename(entry.path), path: entry.path, status,
          ...(entry.error ? { error: entry.error } : {}), ...(descriptor ? {
            label: descriptor.label, fingerprint: descriptor.fingerprint, hostVersion: descriptor.hostVersion,
            parameters: descriptor.parameters, latencySamples: descriptor.latencySamples } : {}),
          ...(entry.warnings?.length ? { warnings: entry.warnings } : {}) });
      }
      await save(registry, data);
      return { ok: true, host: await host(refresh), plugins: rows.sort((a, b) => lexical(a.name, b.name)), folders: roots,
        configuredFolders: data.folders || [], installedDir };
    });
  }
  async function inspect({ path: selected, plugin } = {}) {
    const descriptor = await serialize(async () => {
      const ready = await host();
      if (!ready.ready) throw new Error(ready.error);
      const data = await readRegistry();
      let file = selected || data.plugins[plugin]?.path;
      if (typeof file !== "string" || !path.isAbsolute(file) || !/\.vst3$/i.test(file)) throw new Error("Choose an absolute VST3 file/bundle path or a scanned plugin id.");
      if ((await lstat(file)).isSymbolicLink()) throw new Error("Choose the actual plugin bundle, rather than a symbolic link.");
      file = await realpath(file);
      const id = idFor(file), fingerprint = await fingerprintPlugin(file);
      data.plugins[id] = { path: file, fingerprint, status: "uninspected", name: path.basename(file).replace(/\.vst3$/i, "") };
      await save(registry, data);
      try {
        const result = await worker({ op: "inspect", registry, id, fingerprint });
        if (await fingerprintPlugin(file) !== fingerprint) throw new Error("Plugin changed during inspection. Inspect it again.");
        const descriptor = descriptorChecked(id, fingerprint, result);
        data.plugins[id] = { ...data.plugins[id], status: "ready", descriptor, warnings: result.warnings || [] };
        await save(registry, data);
        return descriptor;
      } catch (error) {
        data.plugins[id].status = "error"; data.plugins[id].error = String(error.message).slice(0, 500);
        await save(registry, data); throw error;
      }
    });
    return { ...await list(), plugin: descriptor };
  }
  async function resolve(id) {
    if (typeof id !== "string" || !/^vst_[a-f0-9]{64}$/.test(id)) throw new Error("Choose a scanned and inspected VST3 effect.");
    const entry = (await readRegistry()).plugins[id];
    if (!entry || entry.status !== "ready" || !entry.descriptor) throw new Error("This plugin is unavailable. Scan and inspect it on this machine.");
    let fingerprint; try { fingerprint = await fingerprintPlugin(entry.path); }
    catch { throw new Error("Plugin files are missing. Locate and inspect the plugin again."); }
    if (fingerprint !== entry.fingerprint || fingerprint !== entry.descriptor.fingerprint) throw new Error("Plugin files changed. Inspect and add the updated plugin again.");
    if (canonical(await realpath(entry.path)) !== canonical(entry.path)) throw new Error("Plugin location changed. Scan and inspect it again.");
    const ready = await host();
    if (!ready.ready) throw new Error(ready.error);
    if (ready.version !== entry.descriptor.hostVersion) throw new Error("The VST host changed. Inspect and add this plugin again.");
    return structuredClone(entry.descriptor);
  }
  async function validateInsert(id, params = {}) {
    const plugin = await resolve(id);
    return { plugin, params: normalizePluginParams(plugin.parameters, params) };
  }
  async function validateProject(doc) {
    const solo = (doc.tracks || []).some(track => track.solo);
    const audible = (doc.tracks || []).filter(track => solo ? track.solo : !track.mute);
    const owners = [...audible, ...(doc.returns || []), doc.master].filter(Boolean);
    const checked = new Map();
    for (const owner of owners) for (const insert of owner.inserts || []) {
      if (insert.type !== "vst3" || insert.enabled === false) continue;
      const saved = insert.plugin;
      if (!saved?.id) throw new Error("This VST3 insert has no registered plugin. Remove or replace it.");
      if (!checked.has(saved.id)) checked.set(saved.id, await resolve(saved.id));
      const current = checked.get(saved.id);
      if (current.fingerprint !== saved.fingerprint || current.hostVersion !== saved.hostVersion)
        throw new Error(`${saved.label || "VST3 effect"} changed. Inspect and add it again, or bypass the insert.`);
    }
  }
  async function copyBundle(src, target) {
    const st = await lstat(src);
    if (st.isSymbolicLink()) throw new Error("Plugin bundles cannot contain symbolic links.");
    if (st.isDirectory()) {
      await mkdir(target);
      for (const name of await readdir(src)) await copyBundle(path.join(src, name), path.join(target, name));
    } else if (st.isFile()) await copyFile(src, target);
    else throw new Error("Plugin bundle contains a non-regular file.");
  }
  async function install({ path: source } = {}) {
    const installed = await serialize(async () => {
      if (typeof source !== "string" || !path.isAbsolute(source) || source.length > 4096 || !/\.(zip|vst3)$/i.test(source)) throw new Error("Choose a local ZIP or VST3 file/bundle path.");
      if ((await lstat(source)).isSymbolicLink()) throw new Error("Choose the actual plugin archive/bundle.");
      source = await realpath(source);
      await mkdir(stagingDir, { recursive: true }); await mkdir(installedDir, { recursive: true });
      const stage = path.join(stagingDir, "install-" + randomUUID());
      const final = path.join(installedDir, randomUUID());
      try {
        if (/\.zip$/i.test(source)) {
          const python = existsSync(runtimePython()) ? runtimePython() : config?.python;
          if (!python || !existsSync(python)) throw new Error("Set up the VST3 host before installing a ZIP.");
          await worker({ op: "extract", input: source, output: stage }, { python, timeoutMs: 60000 });
        } else {
          await fingerprintPlugin(source); // size/link refusal before copying
          await mkdir(stage);
          await copyBundle(source, path.join(stage, path.basename(source)));
          // Nearby notices belong with a directly copied plugin as well.
          const notices = (await readdir(path.dirname(source))).filter(name => /^(licen[sc]e|copying|notice|authors|readme)(?:[._ -]|$)/i.test(name)).slice(0, 20);
          for (const name of notices) {
            const file = path.join(path.dirname(source), name), st = await lstat(file);
            if (st.isFile() && !st.isSymbolicLink() && st.size <= 1024 * 1024) await copyFile(file, path.join(stage, name));
          }
        }
        const bundles = await candidates([stage]);
        if (!bundles.length || bundles.length > 64) throw new Error("The package must contain 1 to 64 VST3 effects. Executable installers are not run.");
        for (const file of bundles) await fingerprintPlugin(file);
        await rename(stage, final);
        return bundles.map(file => path.join(final, path.relative(stage, file)));
      } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
    });
    return { ...await list(), installed };
  }
  async function setup() {
    if (setupActive) return setupActive;
    setupActive = (async () => {
      if ((await host(true)).ready) return list();
      if (process.env.AIPLAY_VST_PYTHON) throw new Error("AIPLAY_VST_PYTHON selects a custom host. Install numpy and pedalboard there, or remove that override.");
      const deadline = Date.now() + 120000;
      const marker = path.join(hostRoot, ".aiplay-vst-host.json");
      if (existsSync(hostRoot) && !existsSync(marker)) throw new Error("The VST host folder has no Studio ownership marker; choose another data folder.");
      await mkdir(hostRoot, { recursive: true }); await save(marker, { owner: "aiplay-vst-host", version: 1 });
      const uv = await ensureUvImpl({ appData, fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }) });
      const environment = { ...process.env, ...UV_PRIVATE_ENV, UV_PYTHON_INSTALL_DIR: path.join(hostRoot, "python"), UV_CACHE_DIR: path.join(root, "cache"), PYTHONUTF8: "1" };
      const command = args => runCommand(uv, args, { env: environment, timeoutMs: Math.max(1000, deadline - Date.now()) });
      await command(["python", "install", ...UV_PYTHON_INSTALL_ARGS, "3.12"]);
      if (!existsSync(ownedPython)) await command(["venv", "--seed", "--python", "3.12", path.join(hostRoot, "venv")]);
      await command(["pip", "install", "--python", ownedPython, "numpy==2.2.6", "pedalboard==0.9.22"]);
      hostCache = null;
      const ready = await host(true);
      if (!ready.ready) throw new Error(ready.error);
      return list();
    })().finally(() => { setupActive = null; });
    return setupActive;
  }
  return { list, inspect, install, setup, resolve, validateInsert, validateProject, env, host, registry, installedDir, stagingDir };
}
