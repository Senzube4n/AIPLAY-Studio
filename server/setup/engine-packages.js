/**
 * STUDIO'S OWN PACKAGES, AGAIN — the retry behind "Try again" in the launcher
 * and `setup_feature { id: "studio-packages" }` in MCP.
 *
 * The engine installer adds OpenCV, librosa and soundfile after ComfyUI's
 * requirements (server/setup/studio-packages.js). When only those fail, the
 * engine is kept and the person is told; this is how they try just that part
 * again without a command prompt. Both doors run the same program the
 * installer is, `scripts/install-engine.mjs --studio-packages`, which refuses
 * any engine Studio did not install and deletes nothing.
 *
 *   runStudioPackages()      spawn it and read its @@done / @@error line
 *                            (the launcher and the server both call this)
 *   createEnginePackagesRunner()   the { has, ids, run, status } shape
 *                            server/setup/routes.js serves, beside the venv
 *                            recipes of server/setup/venv.js
 *
 * Node built-ins only: the launcher imports this before Studio's server runs.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIO_PACKAGES, STUDIO_MODULES, MODULE_WORDS } from "./studio-packages.js";

export const ENGINE_SETUP_ID = "studio-packages";
export const ENGINE_SETUP_BUTTON = "Try again";
export const INSTALL_ENGINE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "install-engine.mjs");
const ENGINE_MARKER = ".aiplay-engine.json";

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

/** The engine folder's marker says Studio installed it and the install finished. */
export async function studioOwnsEngine(rig) {
  if (!rig) return false;
  return (await readJson(path.join(rig, ENGINE_MARKER)))?.complete === true;
}

const moduleWords = (mods) => mods.map((m) => MODULE_WORDS[m] || m).join(", ");

/**
 * Run `install-engine.mjs --studio-packages` against the engine at `rig`.
 * Resolves { ok, studio, error, code }: `studio` is the @@done line's
 * { ok, missing, warning }, `error` the @@error line's message. Every other
 * line goes to onLine. Never rejects.
 */
export function runStudioPackages({ rig, appData, script = INSTALL_ENGINE_SCRIPT, nodePath = process.execPath, onLine = () => {}, onChild = () => {} } = {}) {
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
      child = spawn(nodePath, [script, "--studio-packages"], {
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

/**
 * The retry as a one-click setup, for POST /api/setup and MCP.
 *
 *   rig()      the engine folder Studio runs (config.rig)
 *   python()   its interpreter (config.python)
 *   probe(py, mods) → { module: bool }: index.js probeOne
 *   run(opts)  runStudioPackages, replaceable in tests
 */
export function createEnginePackagesRunner({ appData, rig, python, probe, run = runStudioPackages, quickMs = 1500 } = {}) {
  let job = null;
  const snapshot = (j) => j && ({
    id: ENGINE_SETUP_ID, state: j.state, step: j.state === "running" ? "packages" : null,
    label: j.state === "running" ? `Installing ${moduleWords(STUDIO_MODULES)}` : null, n: j.state === "running" ? 1 : 0, of: 1,
    root: j.root, python: j.python || null, noop: !!j.noop, message: j.message || null, error: j.error || null,
    lines: j.lines.slice(-12), startedAt: j.startedAt, finishedAt: j.finishedAt || null,
  });

  /** What is true right now: whose engine, and whether all three import. */
  async function read() {
    const root = rig() || null, py = python() || null;
    const owned = await studioOwnsEngine(root);
    const got = py && path.isAbsolute(py) && existsSync(py) ? await Promise.resolve(probe(py, STUDIO_MODULES)).catch(() => ({})) : {};
    const missing = STUDIO_MODULES.filter((m) => got?.[m] !== true);
    const blocked = !root ? "No engine is set up yet, so there is nothing to add Studio's packages to."
      : !owned ? `The ComfyUI at ${root} was not installed by Studio, so Studio does not install into it. `
        + `To add them yourself, run its own python: "${py || "<its python>"}" -m pip install ${STUDIO_PACKAGES.join(" ")}`
      : null;
    return { root, py, owned, missing, ready: !missing.length, blocked };
  }

  const offer = (r) => `Studio can install its own packages (${moduleWords(r.missing.length ? r.missing : STUDIO_MODULES)}) into the engine it `
    + `installed at ${r.root}, pinned to the torch and numpy already there so neither moves. Clip posters, the compositor, `
    + "hum-to-score and the DAW bounce need them. The download size has not been measured here.";

  return {
    has: (id) => id === ENGINE_SETUP_ID,
    ids: [ENGINE_SETUP_ID],

    async run(id) {
      if (job?.state === "running") return { ...snapshot(job), already: true };
      const r = await read();
      const j = { state: "running", root: r.root, python: r.py, lines: [], startedAt: Date.now() };
      if (r.blocked) return snapshot(Object.assign(j, { state: "blocked", message: r.blocked, error: r.blocked, finishedAt: Date.now() }));
      if (r.ready) {
        job = Object.assign(j, { state: "ready", noop: true, finishedAt: Date.now(),
          message: `Studio's own packages already import in ${r.py} (${moduleWords(STUDIO_MODULES)}), so nothing was installed.` });
        return snapshot(job);
      }
      job = j;
      const done = run({ rig: r.root, appData, onLine: (l) => { j.lines.push(l); if (j.lines.length > 200) j.lines.shift(); } })
        .then((out) => {
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
        id: ENGINE_SETUP_ID, label: "Studio's own packages", button: ENGINE_SETUP_BUTTON,
        title: "Studio's own packages in the engine", readyWords: "Studio's own packages import in the engine",
        capability: null, packages: STUDIO_PACKAGES, modules: STUDIO_MODULES, missing: r.missing,
        root: r.root, current: r.py, ready: r.ready, blocked: r.blocked,
        offer: r.blocked || offer(r), job: snapshot(job) || null,
      }] };
    },
  };
}
