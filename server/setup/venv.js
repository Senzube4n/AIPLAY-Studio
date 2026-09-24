/**
 * ONE-CLICK PYTHON ENVIRONMENTS — "Set up timed lyrics", and the recipes after it.
 *
 * WHY. Timed lyrics run lrc.py in their own interpreter (config.lyrics.python),
 * and nothing ever created one: a newcomer on Discord (Zoepie) needed Python
 * 3.11+ on PATH and three pasted commands, and on a PC without Python the
 * `python` they typed opened the Microsoft Store. 37ea42f made the failure say
 * so; this makes the fix one button.
 *
 * WHAT A JOB DOES, per recipe `{ id, python, torchIndex, packages, modules }`:
 *
 *   check     the python the feature runs in today already imports every module
 *             → nothing is installed (a no-op, said as one); Studio's own venv
 *             from an earlier run is complete → it is chosen, nothing rebuilt
 *   uv        the KEPT uv (server/setup/uv.js): pinned, checksum-checked, at
 *             <app data>\tools\uv — no system Python anywhere in this
 *   python    `uv python install --no-bin --no-registry 3.12` into
 *             <app data>\venvs\<id>\python: no python3.12.exe in ~/.local/bin
 *             and no registry entry (server/setup/pins.js), so the Python
 *             exists only inside the folder a failed build deletes
 *   venv      `uv venv --seed` at <app data>\venvs\<id>\venv (pip seeded, so the
 *             install lines lrc.js prints still work by hand)
 *   torch     PyTorch from the CUDA 12.6 index on an NVIDIA card, the CPU index
 *             everywhere else — lrc.js's own TORCH_PIP, index swapped
 *   packages  the catalogue's line for the feature (lrc.js whisperPip())
 *   verify    the SAME both-modules probe the Models row and Settings run
 *   save      only now: the interpreter is chosen through the same door as
 *             Settings > Songs > "timed lyrics python"
 *
 * The folder carries a marker (.aiplay-venv.json). Only a folder with it is
 * ever deleted: a failed build removes it, and keeps the download cache beside
 * it (<id>-cache), so trying again does not fetch PyTorch twice. A folder
 * there WITHOUT the marker is somebody else's and is refused, not reused.
 * Network shares and device paths are refused before anything is fetched.
 *
 * A job never blocks its request: run() answers within a second or two with
 * the job's state, and status() reports the step, the last lines of output and
 * the final sentence. Every dependency that touches the world (uv, the probe,
 * saving the setting, the drive-type read) is a parameter, so
 * server/setup_venv_test.js runs the whole thing with a fake uv.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { TORCH_PIP, whisperPip, mask, PIP_NAME } from "../lrc.js";
import { CATALOG, modulesOf } from "../models.js";
import { ensureUv } from "./uv.js";
import { UV_PYTHON_INSTALL_ARGS, UV_PRIVATE_ENV } from "./pins.js";

const MARKER = ".aiplay-venv.json";
const GB = 1e9;

/* ─────────────────────────────────────────────────────────── the recipes */

/** "-m pip install a b --index-url X" → { packages: [a, b], indexUrl: X }. */
export function pipWords(line) {
  const toks = String(line || "").replace(/^(?:python3?\s+)?-m\s+pip\s+install\s+/, "").split(/\s+/).filter(Boolean);
  const packages = [];
  let indexUrl = null;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "--index-url") { indexUrl = toks[++i] || null; continue; }
    if (!toks[i].startsWith("-")) packages.push(toks[i]);
  }
  return { packages, indexUrl };
}

/** The PyTorch builds a recipe can take, by the index's last path segment,
 *  with the words the page's "PyTorch build" choice shows. */
export const TORCH_BUILDS = { cu126: "CUDA 12.6, for an NVIDIA card", cpu: "the CPU build" };

/** Why "auto" picked what it picked, in words a person can check. */
function autoReason(vendor) {
  const WORD = { amd: "AMD", intel: "Intel", apple: "Apple" };
  if (vendor === "nvidia") return "an NVIDIA card was read on this PC";
  if (vendor && vendor !== "cpu") return `this PC's card is ${WORD[vendor] || vendor}, and PyTorch's CUDA build needs NVIDIA`;
  return "no NVIDIA card was read on this PC";
}
export const TORCH_CHOICES = ["auto", ...Object.keys(TORCH_BUILDS)];

/** lrc.js's CUDA index with its build swapped: .../whl/cu126 → .../whl/cpu. */
export const torchIndexUrl = (indexUrl, build) => String(indexUrl).replace(/\/[^/]+\/?$/, `/${build}`);

/**
 * Timed lyrics. Every string that names a package comes from where the rest of
 * Studio reads it (lrc.js, the catalogue), so a person who installs by hand
 * and one who presses the button get the same environment.
 * `torch` "auto" is cu126 on an NVIDIA card and the CPU build otherwise;
 * "cu126" or "cpu" choose it.
 */
export function lyricsRecipe({ vendor = null, torch = "auto" } = {}) {
  const t = pipWords(TORCH_PIP);
  const cap = CATALOG.find((c) => c.id === "lyrics") || {};
  const torchIndex = TORCH_BUILDS[torch] ? torch : vendor === "nvidia" ? "cu126" : "cpu";
  return {
    id: "lyrics", capability: "lyrics", label: "timed lyrics", button: "Set up timed lyrics",
    title: "Timed lyrics need their own Python", readyWords: "Timed lyrics work here",
    python: "3.12",
    torchIndex, torchAuto: !TORCH_BUILDS[torch], torchChosenBy: TORCH_BUILDS[torch] ? "you chose it" : autoReason(vendor),
    torch: { packages: t.packages, indexUrl: torchIndexUrl(t.indexUrl, torchIndex) },
    packages: pipWords(whisperPip()).packages,
    modules: modulesOf(cap),
    modelBytes: cap.approxBytes || 0,
    /* The numbers behind the button. The only measurement is NVIDIA's disk
     * figure (one venv: 4.9 GB, torch 2.5.1+cu121, Python 3.10); every
     * download size is an estimate and says so. */
    sizes: torchIndex === "cu126"
      ? { downloadGb: 2.6, diskGb: 5, basis: "the download is an estimate; 4.9 GB on disk was measured on one NVIDIA venv" }
      : { downloadGb: 0.5, diskGb: 1.5, basis: "an estimate: the CPU build has not been measured here" },
  };
}

export const RECIPES = { lyrics: lyricsRecipe };
export const RECIPE_IDS = Object.keys(RECIPES);

const gbText = (n) => `about ${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)} GB`;

/**
 * The sentence beside the button: what it builds, where, how big, what it
 * replaces, and what it does not touch. `replaces` is the interpreter the
 * feature runs in today when that one exists but lacks a module: the new one
 * is chosen in its place, and the person is told before, not after.
 */
export function offerSentence(recipe, root, { replaces = null } = {}) {
  const s = recipe.sizes;
  const build = recipe.torchIndex === "cu126"
    ? (recipe.torchAuto ? "PyTorch for your NVIDIA card (CUDA 12.6)" : "PyTorch's CUDA 12.6 build (you chose it; it needs an NVIDIA card)")
    : `the CPU build of PyTorch (${recipe.torchAuto ? "because " : ""}${recipe.torchChosenBy}; timing then runs on the processor, which is slower)`;
  const names = recipe.packages.join(" and ");
  return `Studio can set up ${recipe.label} for you: it builds a private Python ${recipe.python} in ${root} with ${build} and ${names}. `
    + `${gbText(s.downloadGb)[0].toUpperCase()}${gbText(s.downloadGb).slice(1)} to download and ${gbText(s.diskGb)} on disk (${s.basis})`
    + (recipe.modelBytes ? `; the first timing then fetches the whisper model, ${gbText(recipe.modelBytes / GB)}` : "")
    + ". "
    + (replaces ? `It then becomes the ${recipe.label} python, in place of ${replaces}. ` : "")
    + "No system Python is needed, and nothing else on this PC changes.";
}

/* ───────────────────────────────────────────────────── where it may build */

async function defaultDriveType(letter) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[System.IO.DriveInfo]::new('${letter}').DriveType`],
      { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

/**
 * Null when `dir` is on this computer's own disk; else the sentence refusing it.
 * A share (\\server\share), a device path (\\?\, \\.\) or a mapped network
 * drive would put a program Studio runs on another machine, and a venv on a
 * share is slow and breaks when the share is gone.
 */
export async function localDiskProblem(dir, { platform = process.platform, driveType = defaultDriveType } = {}) {
  const s = String(dir || "");
  const fix = "Studio builds this Python on this computer's own disk: set AIPLAY_APPDATA to a folder on a local drive, then start Studio again.";
  if (/^[\\/]{2}/.test(s)) return `${s} is a network or device path. ${fix}`;
  if (platform === "win32") {
    const m = /^([A-Za-z]):/.exec(s);
    if (m && (await Promise.resolve(driveType(m[1].toUpperCase())).catch(() => null)) === "Network") {
      return `${m[1].toUpperCase()}: is a network drive. ${fix}`;
    }
  }
  return null;
}

export const venvPython = (root, platform = process.platform) =>
  platform === "win32" ? path.join(root, "venv", "Scripts", "python.exe") : path.join(root, "venv", "bin", "python");

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

/* ──────────────────────────────────────────────────────────── the runner */

/** An error whose message is already the sentence a person reads. */
class SetupError extends Error {}

const STEPS = [
  ["check", "Checking what is already there"],
  ["uv", "Getting the Python installer (uv)"],
  ["python", "Installing Python"],
  ["venv", "Making the environment"],
  ["torch", "Installing PyTorch"],
  ["packages", "Installing the packages"],
  ["verify", "Checking that everything imports"],
  ["save", "Choosing it"],
];

/**
 * The runner behind POST /api/setup and the MCP tools.
 *
 *   appData        Studio's data folder (config.dataDir)
 *   vendor()       "nvidia" | "amd" | "intel" | … | null — the card as read now
 *   probe(py, mods) → { module: bool } — index.js probeOne, the Models row's probe
 *   currentPython(id) → the interpreter the feature runs in today, or null
 *   save(id, py)   → choose it; resolves the verdict ({ note }) to say afterwards
 *   getUv(say)     → the uv program: a path, or [program, ...leading args]
 *   blockedBy(id)  → null, or the sentence saying why building would not
 *                    change what the feature runs in (AIPLAY_WHISPER_PYTHON
 *                    names the interpreter, and the environment wins)
 *   commandTimeoutMs  0 (the default): no limit. PyTorch's CUDA wheel is one
 *                    ~2.5 GB file that uv does not resume, and uv prints nothing
 *                    while it downloads, so neither a wall-clock nor an idle
 *                    limit can tell a slow line from a stuck one; the engine
 *                    installer sets none either. Tests set one.
 */
export function createSetupRunner({
  appData, vendor = () => null, probe, currentPython = () => null, save,
  getUv = (say) => ensureUv({ appData, log: say }), blockedBy = () => null,
  driveType, platform = process.platform, quickMs = 1500, commandTimeoutMs = 0,
} = {}) {
  if (!appData) throw new Error("createSetupRunner needs Studio's data folder.");
  const jobs = new Map();
  /* "Does the feature work today?" for status(): the same probe, kept for 30 s
   * (the Models screen repaints on every download tick), and dropped whenever a
   * job finishes. */
  const readyCache = new Map();
  async function readyNow(id, recipe) {
    const py = currentPython(id);
    if (!py || !path.isAbsolute(py) || !existsSync(py)) return false;
    const hit = readyCache.get(py);
    if (hit && Date.now() - hit.at < 30_000) return hit.ok;
    const got = await Promise.resolve(probe(py, recipe.modules)).catch(() => ({}));
    const ok = recipe.modules.every((m) => got?.[m] === true);
    readyCache.set(py, { at: Date.now(), ok });
    return ok;
  }
  const rootOf = (id) => path.join(appData, "venvs", id);
  const cacheOf = (id) => path.join(appData, "venvs", `${id}-cache`);
  const recipeFor = (id, torch = "auto") => RECIPES[id]({ vendor: vendor() || null, torch });

  const snapshot = (j) => j && ({
    id: j.id, state: j.state, step: j.step, label: j.label, n: j.n, of: STEPS.length,
    torchIndex: j.torchIndex, root: j.root, python: j.python || null, noop: !!j.noop,
    message: j.message || null, error: j.error || null, lines: j.lines.slice(-12),
    startedAt: j.startedAt, finishedAt: j.finishedAt || null,
  });

  /** One command, its output kept as the job's lines; rejects with the last of them. */
  function exec(j, uv, args, env) {
    const [cmd, ...lead] = Array.isArray(uv) ? uv : [uv];
    return new Promise((resolve, reject) => {
      j.lines.push(`> uv ${args.join(" ")}`);
      let child;
      try { child = spawn(cmd, [...lead, ...args], { env: { ...process.env, ...env }, windowsHide: true }); }
      catch (e) { reject(new SetupError(`Could not start uv (${e.code || e.message}).`)); return; }
      const onText = (d) => {
        for (const raw of String(d).split(/\r?\n|\r/)) {
          const line = mask(raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd()).slice(0, 300);
          if (!line.trim()) continue;
          j.lines.push(line);
          if (j.lines.length > 200) j.lines.shift();
        }
      };
      child.stdout?.on("data", onText);
      child.stderr?.on("data", onText);
      const timer = commandTimeoutMs > 0 ? setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, commandTimeoutMs) : null;
      child.on("error", (e) => { clearTimeout(timer); reject(new SetupError(`Could not start uv (${e.code || e.message}).`)); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const last = [...j.lines].reverse().find((l) => !l.startsWith("> ")) || "";
        reject(new SetupError(`uv ${args.slice(0, 2).join(" ")} ${signal ? `was stopped (${signal})` : `exited with code ${code}`}${last ? `: ${last}` : ""}`));
      });
    });
  }

  async function build(j, recipe) {
    const step = (id) => {
      const n = STEPS.findIndex(([k]) => k === id);
      j.step = id; j.n = n + 1;
      j.label = id === "torch" ? `Installing PyTorch (${recipe.torchIndex === "cu126" ? "CUDA 12.6" : "CPU"})`
        : id === "packages" ? `Installing ${recipe.packages.join(" and ")}`
        : id === "python" ? `Installing Python ${recipe.python}` : STEPS[n][1];
    };
    const root = j.root, cache = cacheOf(recipe.id), marker = path.join(root, MARKER);
    const py = venvPython(root, platform);
    const allImport = (got) => recipe.modules.every((m) => got?.[m] === true);

    step("check");
    const now = currentPython(recipe.id);
    if (now && path.isAbsolute(now) && existsSync(now) && allImport(await probe(now, recipe.modules))) {
      return { state: "ready", noop: true, python: now,
        message: `${recipe.readyWords}, so nothing was installed: ${now} has ${recipe.packages.join(" and ")}.` };
    }
    const where = await localDiskProblem(appData, { platform, driveType });
    if (where) throw new SetupError(where);
    const mark = await readJson(marker);
    if (mark?.complete === true && existsSync(py) && allImport(await probe(py, recipe.modules))) {
      step("save");
      const verdict = await save(recipe.id, py);
      return { state: "done", noop: true, python: py,
        message: verdict?.note || `Studio's own ${recipe.label} Python was already built, and ${recipe.label} use it now: ${py}.` };
    }
    if (existsSync(root) && !existsSync(marker) && (await readdir(root)).length) {
      throw new SetupError(`${root} already exists and was not made by Studio, so it was left alone. Move it away, then press ${recipe.button} again.`);
    }
    if (existsSync(marker)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    await mkdir(root, { recursive: true });
    await writeFile(marker, `${JSON.stringify({ id: recipe.id, complete: false, python: recipe.python, torchIndex: recipe.torchIndex, startedAt: new Date().toISOString() }, null, 2)}\n`);
    await mkdir(cache, { recursive: true });

    step("uv");
    const uv = await getUv((line) => j.lines.push(mask(String(line))));
    const env = { ...UV_PRIVATE_ENV, UV_PYTHON_INSTALL_DIR: path.join(root, "python"), UV_CACHE_DIR: cache, PYTHONUTF8: "1" };
    step("python");
    await exec(j, uv, ["python", "install", ...UV_PYTHON_INSTALL_ARGS, recipe.python], env);
    step("venv");
    await exec(j, uv, ["venv", "--seed", "--python", recipe.python, path.join(root, "venv")], env);
    if (!existsSync(py)) throw new SetupError(`The environment was not created: there is no ${py}.`);
    step("torch");
    await exec(j, uv, ["pip", "install", "--python", py, ...recipe.torch.packages, "--index-url", recipe.torch.indexUrl], env);
    step("packages");
    await exec(j, uv, ["pip", "install", "--python", py, ...recipe.packages], env);

    step("verify");
    const got = await probe(py, recipe.modules);
    const missing = recipe.modules.filter((m) => got?.[m] !== true);
    if (missing.length) {
      const word = (m) => PIP_NAME[m] ? `${PIP_NAME[m]} (${m})` : m;
      const have = recipe.modules.filter((m) => !missing.includes(m)).map(word);
      throw new SetupError(`${have.length ? `${have.join(" and ")} installed, but ` : ""}${missing.map(word).join(" and ")} `
        + `${missing.length > 1 ? "do" : "does"} not import in ${py}, so it was not chosen for ${recipe.label}.`);
    }
    await writeFile(marker, `${JSON.stringify({ ...(await readJson(marker)), complete: true, finishedAt: new Date().toISOString() }, null, 2)}\n`);

    step("save");
    const verdict = await save(recipe.id, py);
    await rm(cache, { recursive: true, force: true }).catch(() => {});
    return { state: "done", python: py,
      message: `${recipe.label[0].toUpperCase()}${recipe.label.slice(1)} are set up. ${verdict?.note || `They run in ${py}.`}`
        + (recipe.modelBytes ? ` The first timing fetches the whisper model (${gbText(recipe.modelBytes / GB)}).` : "") };
  }

  /* The outcome is assembled first and published in ONE assignment, last:
   * a status read between "failed" and its sentence (or before the cleanup and
   * the log) would report a finished job that has not finished. */
  async function runJob(j, recipe) {
    let outcome;
    try {
      outcome = await build(j, recipe);
    } catch (e) {
      const stoppedAt = j.label || "the start";
      const reason = e instanceof SetupError ? e.message : `${e?.message || e}`;
      let cleaned = "";
      if (j.step !== "check" && existsSync(path.join(j.root, MARKER)) && (await readJson(path.join(j.root, MARKER)))?.complete !== true) {
        await rm(j.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
        cleaned = ` The half-built environment was removed; its download cache (${cacheOf(recipe.id)}) is kept, so trying again does not fetch the same files twice.`;
      }
      outcome = { state: "failed", error: mask(reason), message: mask(`Setting up ${recipe.label} stopped at "${stoppedAt}": ${reason}${cleaned}`) };
    }
    readyCache.clear();
    /* The whole log, for Details and Copy report; the status carries its tail.
     * Not for a refusal at "check": that may be a network path, which this
     * must not write to either. */
    if (!(outcome.state === "failed" && j.step === "check")) {
      await mkdir(path.join(appData, "logs"), { recursive: true }).catch(() => {});
      await writeFile(path.join(appData, "logs", `setup-${recipe.id}.log`), `${j.lines.join("\n")}\n\n${outcome.message || ""}\n`).catch(() => {});
    }
    Object.assign(j, outcome, { finishedAt: Date.now() });
  }

  return {
    has: (id) => Object.prototype.hasOwnProperty.call(RECIPES, id),
    ids: RECIPE_IDS,

    /** Start (or report) a setup. Resolves within `quickMs`: with the final
     *  state when the job is that quick (a no-op), else with it running. */
    async run(id, { torch = "auto" } = {}) {
      const running = jobs.get(id);
      if (running?.state === "running") return { ...snapshot(running), already: true };
      /* Refused before anything is fetched: building would change nothing the
       * feature runs in, and the answer would say "set up" when it is not. */
      const blocked = blockedBy(id);
      if (blocked) return { id, state: "blocked", message: blocked, error: blocked, lines: [], of: STEPS.length, n: 0 };
      const recipe = recipeFor(id, torch);
      const j = { id, state: "running", step: null, label: null, n: 0, lines: [], root: rootOf(id),
        torchIndex: recipe.torchIndex, startedAt: Date.now() };
      jobs.set(id, j);
      const done = runJob(j, recipe);
      await Promise.race([done, new Promise((r) => setTimeout(r, quickMs))]);
      return snapshot(j);
    },

    /** Every recipe (or one): what the button would build, and the job's state. */
    async status(id = null) {
      const ids = id ? [id] : RECIPE_IDS;
      const out = [];
      for (const k of ids) {
        if (!RECIPES[k]) continue;
        const recipe = recipeFor(k);
        const root = rootOf(k);
        const current = currentPython(k) || null;
        const ready = await readyNow(k, recipe);
        const blocked = blockedBy(k) || null;
        /* The interpreter the build would replace: one that exists but lacks a module. */
        const replaces = !ready && current && path.isAbsolute(current) && existsSync(current) ? current : null;
        /* One offer per PyTorch choice, so the page's "PyTorch build" shows the
         * sentence for the build it will post, and decides nothing itself. */
        const offers = Object.fromEntries(TORCH_CHOICES.map((t) => [t, offerSentence(recipeFor(k, t), root, { replaces })]));
        out.push({
          id: k, label: recipe.label, button: recipe.button, title: recipe.title, readyWords: recipe.readyWords,
          capability: recipe.capability,
          python: recipe.python, torchIndex: recipe.torchIndex, torchChoices: TORCH_CHOICES,
          torchBuilds: { auto: `Auto: ${TORCH_BUILDS[recipe.torchIndex]} (${recipe.torchChosenBy})`, ...TORCH_BUILDS },
          packages: recipe.packages, modules: recipe.modules, sizes: recipe.sizes,
          root, venvPython: venvPython(root, platform), current,
          ready, blocked,
          offer: blocked || offers.auto, offers,
          job: snapshot(jobs.get(k)) || null,
        });
      }
      return { setups: out };
    },
  };
}
