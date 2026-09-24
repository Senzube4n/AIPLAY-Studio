/**
 * STUDIO'S OWN PACKAGES, AGAIN — the retry behind "Try again" in the launcher,
 * the [Install what this needs] button a missing-module refusal offers, and
 * `setup_feature { id: "studio-packages" }` in MCP.
 *
 * The engine installer adds OpenCV, librosa, soundfile and SciPy after
 * ComfyUI's requirements (server/setup/studio-packages.js). When only those
 * fail, the engine is kept and the person is told; this is how they try just
 * that part again without a command prompt. Both doors run the same program
 * the installer is, `scripts/install-engine.mjs --studio-packages`, which
 * refuses any engine Studio did not install and deletes nothing of it. From
 * inside a running Studio it runs with --add-only: it adds what is missing
 * and replaces nothing the running engine holds open; putting back a package
 * that is installed but broken is the launcher's Try again, Studio stopped.
 *
 *   runStudioPackages()      spawn it and read its @@done / @@error line
 *                            (the launcher and the server both call this)
 *   createEnginePackagesRunner()   the { has, ids, run, status } shape
 *                            server/setup/routes.js serves, beside the venv
 *                            recipes of server/setup/venv.js
 *   engineModuleRefusal()    a script's "No module named 'x'" as the sentence
 *                            a person can act on: which module, which python,
 *                            the pip line, and the setup id only where the
 *                            setup would actually fix THIS python
 *
 * Node built-ins only: the launcher imports this before Studio's server runs.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STUDIO_PACKAGES, STUDIO_MODULES, MODULE_WORDS, PACKAGE_OF, STUDIO_USES, CONSTRAINTS_FILE,
  modulesProbe, probeLine, diskWords, moduleWords, missingModuleOf, ADDED_BY_STUDIO,
} from "./studio-packages.js";

export const ENGINE_SETUP_ID = "studio-packages";
/** The button once the engine record says the last try failed. */
export const ENGINE_SETUP_BUTTON = "Try again";
/** The button everywhere else: an engine made before Studio added the step
 *  (its record has no studioPackages), or one whose packages went in and a
 *  module broke later. Nobody there has tried anything yet. */
export const ENGINE_FIRST_BUTTON = "Install what this needs";
export const INSTALL_ENGINE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "install-engine.mjs");
const ENGINE_MARKER = ".aiplay-engine.json";

/** The modules a refusal may offer the setup for: the ones the setup installs. */
export const REPAIR_MODULES = STUDIO_MODULES;
export { PACKAGE_OF, missingModuleOf };
/** Import name ≠ pip name, for modules outside Studio's list, so the pip line
 *  a refusal prints installs something real. */
const PIP_NAME_OF = { PIL: "Pillow", yaml: "PyYAML", sklearn: "scikit-learn", skimage: "scikit-image", _cffi_backend: "cffi" };

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

/** The engine folder's marker says Studio installed it and the install finished. */
export async function studioOwnsEngine(rig) {
  if (!rig) return false;
  return (await readJson(path.join(rig, ENGINE_MARKER)))?.complete === true;
}

/** The python inside an engine folder, as scripts/install-engine.mjs makes it. */
export function venvPython(root, platform = process.platform) {
  if (!root) return null;
  return platform === "win32" ? path.win32.join(root, "venv", "Scripts", "python.exe") : path.posix.join(root, "venv", "bin", "python");
}

/** One file named two ways: resolved, and case-insensitive on Windows. */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  const norm = (x) => p.resolve(String(x));
  return platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** The last non-empty line of a text: where a python run says why it stopped. */
const finalLine = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";

/**
 * Which module a failed python run could not import, read from its FINAL
 * line only (the exception that stopped it, or the error line a script
 * printed), so a warning earlier in stderr (xformers' "No module named
 * 'triton'", a resampler's UserWarning) never stands in for the failure.
 * Three shapes:
 *
 *   No module named 'x.y'                                  → x
 *   cannot import name 'f' from 'x.y' (unknown location)   → x   a folder left with no __init__
 *   DLL load failed while importing x                      → x
 *
 * A module outside Studio's list that one of the four imports itself
 * (librosa's lazy_loader or numba, soundfile's _cffi_backend, scipy's
 * _ufuncs) is answered as that one, read from the failing traceback's
 * innermost site-packages frame: putting that package back, with its
 * requirements, is what fixes it.
 *
 * → { module, named } (`named`: what the line itself named), or null.
 */
export function failedModuleOf(text) {
  const all = String(text || "");
  const last = finalLine(all);
  const named = missingModuleOf(last)
    || /cannot import name ['"]?[\w.]+['"]? from ['"]([A-Za-z_][\w.]*)['"] \(unknown location\)/.exec(last)?.[1]?.split(".")[0]
    || /DLL load failed while importing ([A-Za-z_]\w*)/.exec(last)?.[1]
    || null;
  if (!named) return null;
  if (REPAIR_MODULES.includes(named)) return { module: named, named };
  const tb = all.lastIndexOf("Traceback (most recent call last)");
  const frames = tb < 0 ? [] : [...all.slice(tb).matchAll(/site-packages[\\/]([A-Za-z_]\w*)(?:[\\/]|\.py\b)/g)].map((f) => f[1]);
  const inner = frames.length ? frames[frames.length - 1] : null;
  return { module: inner && REPAIR_MODULES.includes(inner) ? inner : named, named };
}

/* ── the real import, cached ────────────────────────────────────────────── */

const IMPORT_TTL_MS = 30_000;
const importCache = new Map();   // python path → { at, value }
const importing = new Map();     // python path → the probe in flight

/**
 * A real import of each module in `py`: { module: true | "the reason" }, or
 * null when the probe itself could not run or ran past `timeoutMs`. A
 * find_spec answer is not enough here: a half-removed SciPy leaves a folder
 * find_spec finds, so the setup said "ready" beside a DAW that could not
 * start. 20 s at most, like index.js probeOne: a status read must not hold
 * the Models screen open (all four take ~3 s on the rig).
 */
export function importProbe(py, mods = STUDIO_MODULES, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let so = "", proc;
    try { proc = spawn(py, ["-s", "-c", modulesProbe(mods)], { windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" } }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve(null); }, timeoutMs);
    proc.stdout.on("data", (d) => { so += d; });
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
    proc.on("close", () => { clearTimeout(timer); resolve(probeLine(so, "modules")); });
  });
}

/** The real import for `py`, once per 30 s whatever it answered (a python
 *  that timed out is not asked again on every status read), and one probe
 *  at a time: concurrent reads share the one in flight. */
function cachedImports(py, imports) {
  const key = String(py).toLowerCase();
  const hit = importCache.get(key);
  if (hit && Date.now() - hit.at < IMPORT_TTL_MS) return Promise.resolve(hit.value);
  if (importing.has(key)) return importing.get(key);
  const p = Promise.resolve().then(() => imports(py, STUDIO_MODULES)).catch(() => null).then((v) => {
    const value = v && typeof v === "object" ? v : null;
    if (importing.get(key) === p) { importing.delete(key); importCache.set(key, { at: Date.now(), value }); }
    return value;
  });
  importing.set(key, p);
  return p;
}

/** Forget what the real import said about `py` (all pythons when omitted):
 *  after a repair, or when a feature has just proved a module missing. A
 *  probe already in flight is not kept either. */
export function forgetImports(py = null) {
  if (py) { const key = String(py).toLowerCase(); importCache.delete(key); importing.delete(key); }
  else { importCache.clear(); importing.clear(); }
}

/* ── a missing module, as a refusal ─────────────────────────────────────── */

/**
 * A feature's python run failed. When its final line says a module could
 * not be imported (failedModuleOf), the refusal a door answers with (HTTP
 * 409, the shape of R0):
 *
 *   { message, module, package, pip, python, status: 409, reason: "missing-module", setup? }
 *
 * `setup: "studio-packages"` only when all three hold: the module is one the
 * setup installs, `rig` is an engine Studio installed (its marker is
 * complete), and `python` is that engine's own venv python. Anywhere else
 * the setup would install into a python this feature does not run, or into a
 * ComfyUI that is not Studio's to change, so the sentence gives the pip line
 * for THIS python instead. null when the text names no missing module.
 *
 *   feature   "Hum to score", "The real-audio tokenizer", "The compositor",
 *             "The DAW render", "Clip posters", "The image editor"
 */
export async function engineModuleRefusal({ stderr, feature = "This feature", rig = null, python = null } = {}) {
  const failed = failedModuleOf(stderr);
  if (!failed) return null;
  const { module } = failed;
  const py = python || "the engine's python";
  const pkg = PACKAGE_OF[module] || PIP_NAME_OF[module] || module;
  const pip = `"${py}" -m pip install ${pkg}`;
  const inRig = !!(python && rig && samePath(python, venvPython(rig)));
  const owned = inRig && await studioOwnsEngine(rig);
  const listed = REPAIR_MODULES.includes(module);
  const word = MODULE_WORDS[module] || `the Python module "${module}"`;
  if (python) forgetImports(python);   // the next status probes again rather than repeat "ready"
  const base = { module, package: pkg, pip, python: python || null, status: 409, reason: "missing-module" };
  if (listed && owned) {
    return { ...base, setup: ENGINE_SETUP_ID,
      message: `${feature} needs ${word}, which the engine's python cannot import (${py}). `
        + `Studio can install it into the engine it set up, pinned to its torch and numpy: setup id "${ENGINE_SETUP_ID}" `
        + `(the Install button, or setup_feature for an agent). To do it by hand: ${pip}` };
  }
  if (!owned) {
    return { ...base,
      message: `${feature} needs ${word}, which ${py} cannot import. `
        + `Studio installs packages only into the engine it set up itself, so run this yourself: ${pip}` };
  }
  return { ...base,
    message: `${feature} needs the Python module "${module}", which ${py} cannot import. `
      + `It is not one of Studio's own packages, so Studio does not install it; to add it yourself: ${pip}` };
}

const REFUSAL_KEYS = ["setup", "pip", "python", "module", "reason"];

/** The refusal as an Error a door can throw: its message, status 409 and the
 *  R0 fields (setup only when present). */
export function refusalError(refusal) {
  const e = new Error(refusal.message);
  e.status = refusal.status || 409;
  for (const k of REFUSAL_KEYS) if (refusal[k] != null) e[k] = refusal[k];
  return e;
}

/** The R0 fields present on a thrown error, for a door's reply:
 *  json(res, e.status || 400, { error: e.message, ...engineRefusalFields(e) }). */
export function engineRefusalFields(e) {
  const out = {};
  for (const k of REFUSAL_KEYS) if (e?.[k] != null && e[k] !== "") out[k] = e[k];
  return out;
}

/* ── the setup ──────────────────────────────────────────────────────────── */

/**
 * Run `install-engine.mjs --studio-packages` against the engine at `rig`.
 * `addOnly` (a running Studio: the in-app button, MCP) adds --add-only, so
 * nothing installed is replaced; the launcher runs it without, Studio
 * stopped. Resolves { ok, studio, error, code }: `studio` is the @@done
 * line's { ok, missing, warning }, `error` the @@error line's message.
 * Every other line goes to onLine. Never rejects.
 */
export function runStudioPackages({ rig, appData, script = INSTALL_ENGINE_SCRIPT, nodePath = process.execPath, addOnly = false, onLine = () => {}, onChild = () => {} } = {}) {
  return new Promise((resolve) => {
    let studio = null, error = null, buf = "";
    const take = (line) => {
      if (line.startsWith("@@done ")) { try { studio = JSON.parse(line.slice(7)).studio || null; } catch { /* reported below */ } return; }
      if (line.startsWith("@@error ")) { try { error = JSON.parse(line.slice(8)).message || null; } catch { /* reported below */ } return; }
      if (line.startsWith("@@step ")) return;
      if (line.trim()) onLine(line);
    };
    let child;
    try {
      child = spawn(nodePath, [script, "--studio-packages", ...(addOnly ? ["--add-only"] : [])], {
        cwd: path.resolve(path.dirname(script), ".."), windowsHide: true,
        env: { ...process.env, AIPLAY_ENGINE_DIR: rig, ...(appData ? { AIPLAY_APPDATA: appData } : {}) },
      });
    } catch (e) { resolve({ ok: false, studio: null, error: `Could not start the installer (${e.code || e.message}).`, code: null }); return; }
    onChild(child);
    const onData = (d) => { buf += String(d); const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(take); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => resolve({ ok: false, studio, error: `Could not start the installer (${e.code || e.message}).`, code: null }));
    child.on("close", (code) => {
      if (buf) take(buf);
      resolve({ ok: code === 0 && studio?.ok === true, studio, error: error || (studio ? null : `The installer stopped unexpectedly (exit code ${code}).`), code });
    });
  });
}

/** "pip install" words for the modules named, from PACKAGE_OF; an OpenCV
 *  already there under another opencv-* name is put back, not doubled. */
function pipWords(py, mods) {
  const list = mods.length ? mods : STUDIO_MODULES;
  return `"${py || "<its python>"}" -m pip install ${list.map((m) => PACKAGE_OF[m] || m).join(" ")}`
    + (list.includes("cv2") ? " (if an opencv-* package is already installed there, reinstall that one instead of adding opencv-python-headless)" : "");
}

/**
 * The retry as a one-click setup, for POST /api/setup and MCP.
 *
 *   rig()      the engine folder Studio runs (config.rig)
 *   python()   its interpreter (config.python)
 *   probe(py, mods) → { module: bool }: index.js probeOne (find_spec: fast,
 *              and enough to say a module is MISSING)
 *   imports(py, mods) → { module: true | reason } | null: a real import, run
 *              only when find_spec finds them all, cached 30 s per python
 *   run(opts)  runStudioPackages, replaceable in tests; called with
 *              addOnly: true, since Studio is running whenever this runs
 *   appData    where settings.json keeps the engine record (engineInstall)
 *
 * While its own job runs, status probes nothing: a python importing SciPy
 * while pip replaces SciPy is how a half-removed "~cipy" is made.
 */
export function createEnginePackagesRunner({ appData, rig, python, probe = null, imports = importProbe, run = runStudioPackages, quickMs = 1500 } = {}) {
  let job = null;
  const snapshot = (j) => j && ({
    id: ENGINE_SETUP_ID, state: j.state, step: j.state === "running" ? "packages" : null,
    label: j.state === "running" ? `Installing ${moduleWords(j.mods?.length ? j.mods : STUDIO_MODULES)}` : null, n: j.state === "running" ? 1 : 0, of: 1,
    root: j.root, python: j.python || null, noop: !!j.noop, message: j.message || null, error: j.error || null,
    lines: j.lines.slice(-12), startedAt: j.startedAt, finishedAt: j.finishedAt || null,
  });

  /** Whether each module imports in `py`: find_spec first, then a real
   *  import once find_spec finds them all (a present-but-broken module).
   *  `real` says the answer came from the real import. */
  async function importsIn(py) {
    const spec = probe ? await Promise.resolve(probe(py, STUDIO_MODULES)).catch(() => ({})) : null;
    if (spec && !STUDIO_MODULES.every((m) => spec?.[m] === true)) return { got: spec, real: false };
    const real = imports ? await cachedImports(py, imports) : null;
    if (real) return { got: Object.fromEntries(STUDIO_MODULES.map((m) => [m, real[m] === true])), real: true };
    return { got: spec || {}, real: false };
  }

  /** What is true right now: whose engine, which python, and whether all four import. */
  async function read() {
    const root = rig() || null, py = python() || null;
    const owned = await studioOwnsEngine(root);
    const engPy = venvPython(root);
    const busy = job?.state === "running";
    const { got, real } = !busy && py && path.isAbsolute(py) && existsSync(py) ? await importsIn(py) : { got: {}, real: false };
    const missing = busy ? [...(job.mods?.length ? job.mods : STUDIO_MODULES)] : STUDIO_MODULES.filter((m) => got?.[m] !== true);
    /* Found by find_spec, yet not importing: installed but broken. Adding
     * cannot put those back; replacing them needs Studio stopped. */
    const broken = real ? missing : [];
    const record = appData ? (await readJson(path.join(appData, "settings.json")))?.engineInstall || null : null;
    const blocked = !root ? "No engine is set up yet, so there is nothing to add Studio's packages to."
      : !owned ? `The ComfyUI at ${root} was not installed by Studio, so Studio does not install into it. `
        + `To add them yourself, run its own python: ${pipWords(py, missing)}`
      : !samePath(py, engPy) ? `Studio runs its engine with ${py || "no python"}, not the engine's own ${engPy} `
        + "(AIPLAY_PYTHON, or a python saved in settings, names it), so installing into the engine would not reach what runs. "
        + `Add them to that python yourself: ${pipWords(py, missing)}`
      : null;
    return { root, py, owned, missing, broken, ready: !busy && !missing.length, blocked, record,
      constraintsFile: root ? path.join(root, CONSTRAINTS_FILE) : null };
  }

  const offer = (r) => {
    const mods = r.missing.length ? r.missing : ADDED_BY_STUDIO;
    const broken = (r.broken || []).filter((m) => mods.includes(m));
    const absent = mods.filter((m) => !broken.includes(m));
    const pinned = `every package already there is pinned first, in ${r.constraintsFile}`;
    if (!broken.length) {
      return `Studio can install ${moduleWords(mods)} into the engine it installed at ${r.root}. `
        + `Every package already there is pinned first, in ${r.constraintsFile}, so pip can only add: the engine's torch and numpy do not move. `
        + `${STUDIO_USES}. ${diskWords(mods)}`;
    }
    const one = broken.length === 1;
    return `${moduleWords(broken)} ${one ? "is" : "are"} installed in the engine at ${r.root} but ${one ? "does" : "do"} not import. `
      + `Studio can add what ${one ? "it is" : "they are"} missing${absent.length ? `, and install ${moduleWords(absent)},` : ""} without replacing anything: ${pinned}. `
      + `If that is not enough, putting ${moduleWords(broken)} back replaces files the running engine holds open, so Studio says so `
      + "and it is done with Studio stopped, from Try again beside \"Studio's own packages\" in the launcher. "
      + `${STUDIO_USES}.${absent.length ? ` ${diskWords(absent)}` : ""}`;
  };

  return {
    has: (id) => id === ENGINE_SETUP_ID,
    ids: [ENGINE_SETUP_ID],

    async run(id) {
      if (job?.state === "running") return { ...snapshot(job), already: true };
      const r = await read();
      const j = { state: "running", root: r.root, python: r.py, mods: r.missing, lines: [], startedAt: Date.now() };
      if (r.blocked) return snapshot(Object.assign(j, { state: "blocked", message: r.blocked, error: r.blocked, finishedAt: Date.now() }));
      if (r.ready) {
        job = Object.assign(j, { state: "ready", noop: true, finishedAt: Date.now(),
          message: `Studio's own packages already import in ${r.py} (${moduleWords(STUDIO_MODULES)}), so nothing was installed.` });
        return snapshot(job);
      }
      job = j;
      const done = run({ rig: r.root, appData, addOnly: true, onLine: (l) => { j.lines.push(l); if (j.lines.length > 200) j.lines.shift(); } })
        .then((out) => {
          forgetImports(r.py);
          const outcome = out.ok
            ? { state: "done", message: `Studio's own packages are installed in the engine: ${moduleWords(STUDIO_MODULES)} import in ${r.py}.` }
            : { state: "failed", error: out.studio?.warning || out.error || "The packages did not install.",
              message: out.studio?.warning || `Studio's own packages did not install: ${out.error || "no reason was given"}.` };
          Object.assign(j, outcome, { finishedAt: Date.now() });
        });
      await Promise.race([done, new Promise((res) => setTimeout(res, quickMs))]);
      return snapshot(j);
    },

    async status(id = null) {
      if (id && id !== ENGINE_SETUP_ID) return { setups: [] };
      const r = await read();
      return { setups: [{
        id: ENGINE_SETUP_ID, label: "Studio's own packages",
        button: r.record?.studioPackages?.ok === false ? ENGINE_SETUP_BUTTON : ENGINE_FIRST_BUTTON,
        title: "Studio's own packages in the engine", readyWords: "Studio's own packages import in the engine",
        capability: null, packages: STUDIO_PACKAGES, modules: STUDIO_MODULES, missing: r.missing,
        root: r.root, current: r.py, ready: r.ready, blocked: r.blocked, constraintsFile: r.constraintsFile,
        offer: r.blocked || offer(r), job: snapshot(job) || null,
      }] };
    },
  };
}
