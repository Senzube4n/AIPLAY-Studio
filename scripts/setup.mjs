/**
 * First-run setup: find the engine, or explain exactly what is missing.
 *
 * Studio drives a ComfyUI install; it does not contain one. That is a deliberate
 * split — ComfyUI is 6 GB of python before any weights, it has its own update
 * story, and most people who want this already have one. Bundling a second copy
 * would be the single largest thing in the download and the most likely to rot.
 *
 * So the one question this asks is "where is it", and it tries hard to answer
 * that itself before asking. Run with --quiet-if-ready and it prints nothing at
 * all once things work, which is what makes it safe to call on every launch.
 *
 * NVIDIA OR AMD. It also records which graphics card this is and which torch
 * build the engine's python carries (CUDA or ROCm), and says so when the two do
 * not match. It never installs or replaces torch: a working engine python is the
 * user's, and the fix for a mismatch is the matching ComfyUI build.
 *
 * COMFYUI DESKTOP. The Desktop app (including its AMD/ROCm build) keeps its
 * installs under %LOCALAPPDATA%\Comfy-Desktop and its python in
 * `ComfyUI\.venv`. When the chosen rig is one of those, the Desktop's own model
 * paths and launch flags are copied into settings.json, so Studio launches the
 * engine exactly the way the Desktop app does. A portable build's flags are read
 * from its own run_nvidia_gpu.bat / run_amd_gpu.bat the same way. Set
 * "launchFlagsSync": false in settings.json to manage those by hand.
 */
import { stat, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import path from "node:path";
import { COMFY_TAG, comfyPinNote } from "../server/setup/pins.js";

const run = promisify(execFile);

/* AIPLAY_APPDATA, honoured here for exactly the reason server/config.js honours
 * it — and it did not, which made the promise attached to that variable false in
 * the one place it mattered most.
 *
 * config.js says of it: "exists for tests: an isolated e2e run must not read or
 * write the real user's settings". config.js READS through it. This file is the
 * one that WRITES, and it went to the home directory regardless. So rehearsing
 * the first-run experience the way a newcomer actually meets it — an empty
 * profile, no recorded rig, the question genuinely asked — could not be done
 * without overwriting the settings of whoever was rehearsing it.
 *
 * Which is its own explanation for why that path is under-walked. Same variable,
 * same meaning, both halves of it now. */
const SETTINGS = path.join(
  process.env.AIPLAY_APPDATA || path.join(homedir(), ".aiplay-studio"),
  "settings.json");
const QUIET = process.argv.includes("--quiet-if-ready");
const REDETECT = process.argv.includes("--redetect");
/* --json: never prompt; print one JSON report on stdout (what the launcher's
 * system check reads). Human-readable lines go to stderr instead. */
const JSON_OUT = process.argv.includes("--json");
if (JSON_OUT) console.log = (...a) => process.stderr.write(`${a.join(" ")}\n`);
let report = { ok: false };

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const isEngine = async (rig) => exists(path.join(rig, "ComfyUI", "main.py"));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** A ComfyUI needs a python that can actually run it. */
async function pythonFor(rig) {
  for (const rel of [["venv", "Scripts", "python.exe"], ["venv", "bin", "python"],
                     ["python_embeded", "python.exe"], [".venv", "Scripts", "python.exe"],
                     // ComfyUI Desktop: the venv sits INSIDE the ComfyUI folder.
                     ["ComfyUI", ".venv", "Scripts", "python.exe"],
                     ["ComfyUI", ".venv", "bin", "python"]]) {
    const p = path.join(rig, ...rel);
    if (await exists(p)) return p;
  }
  return null;
}

/* ── ComfyUI Desktop ───────────────────────────────────────────────────── */

const DESKTOP_DIR = path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"),
  "Comfy Desktop");

/** Local installs the Desktop app knows about, newest launch first. */
async function desktopInstalls() {
  let list;
  try { list = JSON.parse(await readFile(path.join(DESKTOP_DIR, "installations.json"), "utf-8")); }
  catch { return []; }
  const out = [];
  for (const i of Array.isArray(list) ? list : []) {
    if (!i?.installPath || i.sourceId === "cloud") continue;
    if (!(await isEngine(i.installPath))) continue;
    const yaml = path.join(DESKTOP_DIR, "instance-model-paths", `${i.id}.yaml`);
    out.push({
      rig: i.installPath, id: i.id, variant: i.variant || null,
      launchArgs: typeof i.launchArgs === "string" ? i.launchArgs : "",
      modelPaths: (await exists(yaml)) ? yaml : null,
      lastLaunchedAt: i.lastLaunchedAt || 0,
    });
  }
  return out.sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt);
}

/** The `is_default` base_path of an extra_model_paths YAML — where the Desktop
 *  app puts downloaded weights, and so where Studio should look and download. */
async function defaultModelsDir(yamlPath) {
  try {
    const t = await readFile(yamlPath, "utf-8");
    const m = t.match(/base_path:\s*['"]?([^'"\r\n]+?)['"]?\s*\r?\n\s*is_default:\s*true/)
      || t.match(/base_path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/* Flags Studio sets itself, or that belong to the Desktop shell rather than the
 * engine. Value = how many arguments follow the flag. */
const OWNED_FLAGS = new Map([
  ["--port", 1], ["--listen", 1], ["--output-directory", 1], ["--input-directory", 1],
  ["--user-directory", 1], ["--base-directory", 1], ["--extra-model-paths-config", 1],
  ["--disable-auto-launch", 0], ["--auto-launch", 0], ["--enable-manager", 0],
  ["--feature-flag", 1], ["--front-end-version", 1], ["--front-end-root", 1],
  // Portable builds: this one turns browser auto-launch back on.
  ["--windows-standalone-build", 0],
]);

/** The Desktop install's launch flags, minus the ones Studio owns. */
function passThroughArgs(s) {
  const toks = (s.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ""));
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const flag = t.split("=")[0];
    if (OWNED_FLAGS.has(flag)) {
      if (!t.includes("=")) {
        for (let n = OWNED_FLAGS.get(flag); n > 0 && toks[i + 1] && !toks[i + 1].startsWith("--"); n--) i++;
      }
      continue;
    }
    out.push(t);
  }
  return out;
}

/** A portable build's own launcher (run_nvidia_gpu.bat / run_amd_gpu.bat): the
 *  flags its double-click uses, matching card first. null when there is none. */
async function portableLaunchArgs(rig, vendor) {
  const names = [`run_${vendor}_gpu.bat`, "run_nvidia_gpu.bat", "run_amd_gpu.bat", "run_intel_gpu.bat"];
  for (const name of [...new Set(names)]) {
    try {
      const m = (await readFile(path.join(rig, name), "utf-8")).match(/main\.py([^\r\n]*)/i);
      if (m) return { file: name, args: passThroughArgs(m[1]) };
    } catch { /* not this one */ }
  }
  return null;
}

/* ── Which card, which torch ───────────────────────────────────────────── */

const vendorOf = (s) => /nvidia/i.test(s) ? "nvidia"
  : /\bamd\b|radeon|advanced micro/i.test(s) ? "amd"
  : /intel/i.test(s) ? "intel" : null;

/** The discrete card: nvidia-smi if it answers, else Windows' display-adapter
 *  registry (Win32_VideoController.AdapterRAM is a 32-bit field capped at 4 GB,
 *  so it cannot be used for a 16 GB card). */
async function detectGpu() {
  try {
    const { stdout: o } = await run("nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 8000, windowsHide: true });
    const [name, total] = o.split(/\r?\n/)[0].split(",").map((x) => x.trim());
    if (Number(total) > 0) return { vendor: "nvidia", name, totalMb: Number(total), source: "nvidia-smi" };
  } catch { /* not NVIDIA, or no driver */ }
  if (process.platform !== "win32") return null;
  const ps = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' "
    + "-ErrorAction SilentlyContinue | ForEach-Object { $v = $_.'HardwareInformation.qwMemorySize'; "
    + "if ($v -is [byte[]]) { $v = [BitConverter]::ToUInt64($v, 0) }; "
    + "if ($v) { '{0}|{1}|{2}' -f $_.DriverDesc, $v, $_.ProviderName } }";
  try {
    const { stdout: o } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 20000, windowsHide: true });
    const best = o.split(/\r?\n/).filter(Boolean).map((l) => {
      const [name = "", bytes = "0", prov = ""] = l.split("|");
      return { name: name.trim(), totalMb: Math.round(Number(bytes) / 1048576), vendor: vendorOf(`${name} ${prov}`) };
    }).filter((c) => c.vendor && c.totalMb > 0).sort((a, b) => b.totalMb - a.totalMb)[0];
    if (best) return { ...best, source: "Windows display-adapter registry" };
  } catch { /* no reading is not an error */ }
  return null;
}

/** Which torch build the engine python carries. Imports torch (a few seconds),
 *  so it runs only when the python changes. */
async function torchBackend(py) {
  const code = "import torch;v=torch.version;"
    + "print(torch.__version__);print(getattr(v,'hip',None) or getattr(v,'rocm',None) or '');print(v.cuda or '')";
  try {
    const { stdout: o } = await run(py, ["-s", "-c", code], { timeout: 180000, windowsHide: true });
    const [version = "", rocm = "", cuda = ""] = o.split(/\r?\n/).map((x) => x.trim());
    return { version, backend: rocm ? "rocm" : cuda ? "cuda" : version.includes("+xpu") ? "xpu" : "cpu" };
  } catch (e) {
    return { version: null, backend: null, error: String(e.message || e).split("\n")[0] };
  }
}

function mismatch(gpu, tb, chosen = null) {
  if (!tb?.backend) return null;
  /* Studio's own engine, installed for CPU on purpose: slow, not wrong. */
  if (chosen === "cpu" && tb.backend === "cpu") return null;
  if (chosen && chosen !== "cpu" && tb.backend === "cpu") {
    return `Studio's own ComfyUI has a CPU-only torch (${tb.version}). Remove the engine folder and install again for ${chosen.toUpperCase()}.`;
  }
  if (tb.backend === "cpu") {
    return `The engine's torch (${tb.version}) is a CPU-only build — every render would run on the processor.`
      + (gpu?.vendor === "amd" ? " Use the AMD build of ComfyUI (ComfyUI Desktop → AMD, or the _amd portable build)."
        : gpu?.vendor === "nvidia" ? " Use the NVIDIA build of ComfyUI (the plain _nvidia portable build)." : "");
  }
  if (gpu?.vendor === "amd" && tb.backend === "cuda") {
    return `This is an AMD card (${gpu.name}) but the engine's torch (${tb.version}) is a CUDA build. `
      + "Use the AMD build of ComfyUI (ComfyUI Desktop → AMD, or the _amd portable build).";
  }
  if (gpu?.vendor === "nvidia" && tb.backend === "rocm") {
    return `This is an NVIDIA card (${gpu.name}) but the engine's torch (${tb.version}) is a ROCm build. `
      + "Use the NVIDIA build of ComfyUI (the plain _nvidia portable build).";
  }
  return null;
}

/* ── Search ────────────────────────────────────────────────────────────── */

/**
 * Look where ComfyUI actually ends up.
 *
 * Ordered by likelihood, and every drive is checked because "big AI folder on
 * the second disk" is the normal shape of these installs — the C: drive is
 * rarely where 34 GB of weights lives.
 */
async function guess() {
  const home = homedir();
  const roots = [
    path.join(home, "ComfyUI"), path.join(home, "Documents", "ComfyUI"),
    path.join(home, "Desktop", "ComfyUI"),
    /* AppData, because the ComfyUI Desktop installer does not put itself on a
     * drive root or in Documents the way the portable build does. These are the
     * parent folders; the one-level-down scan below finds whatever it named the
     * install, so this does not depend on knowing that layout exactly. */
    process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
    path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs"),
    process.env.APPDATA || path.join(home, "AppData", "Roaming"),
    path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Comfy-Desktop", "ComfyUI-Installs"),
    ...["C", "D", "E", "F"].flatMap((d) => [
      `${d}:\\ComfyUI`, `${d}:\\AI`, `${d}:\\AI\\ComfyUI`,
      `${d}:\\ComfyUI_windows_portable`, `${d}:\\StabilityMatrix`,
    ]),
  ];
  // The Desktop app's own record first: it is exact, and it is most recent-first.
  const found = (await desktopInstalls()).map((d) => d.rig);
  for (const r of roots) {
    if (!(await exists(r))) continue;
    if (await isEngine(r)) { found.push(r); continue; }
    // One level down, so `D:\AI\<anything>\ComfyUI\main.py` is caught too.
    try {
      for (const e of await readdir(r, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const c = path.join(r, e.name);
        if (await isEngine(c)) found.push(c);
      }
    } catch { /* unreadable drive */ }
  }
  const uniq = [];
  for (const f of found) if (!uniq.some((u) => samePath(u, f))) uniq.push(f);
  return uniq;
}

async function saved() {
  try { return JSON.parse(await readFile(SETTINGS, "utf-8")); } catch { return {}; }
}

/**
 * Record everything the launch needs for this rig: python, and — once, or with
 * --redetect — the card and the torch build. Writes only when something changed.
 */
async function finalize(rig, cur, { announce }) {
  const py = await pythonFor(rig);
  if (!py) {
    console.log(`\n  Found ComfyUI at ${rig}, but no python environment inside it.`);
    console.log(`  Looked for venv\\Scripts\\python.exe, python_embeded\\python.exe and ComfyUI\\.venv.`);
    console.log(`  Start ComfyUI once on its own first — that is what creates it.\n`);
    report = { ok: false, rig, error: `Found ComfyUI at ${rig}, but no python environment inside it.` };
    return 1;
  }
  const next = { ...cur, rig, python: py };
  const notes = [];

  const pythonChanged = cur.python !== py;
  if (REDETECT || pythonChanged || !cur.gpu) {
    const gpu = await detectGpu();
    if (gpu) next.gpu = gpu;
  }

  /* Launch the engine the way its own launcher does. ComfyUI Desktop records
   * its flags and model paths; a portable build keeps them in its .bat. A plain
   * from-source install has neither, and gets Studio's defaults. */
  if (cur.launchFlagsSync !== false) {
    const desk = (await desktopInstalls()).find((d) => samePath(d.rig, rig));
    if (desk) {
      const args = passThroughArgs(desk.launchArgs);
      if (desk.modelPaths) {
        args.push("--extra-model-paths-config", desk.modelPaths);
        const md = await defaultModelsDir(desk.modelPaths);
        // A folder picked on the Models screen wins over the Desktop default.
        if (md && !cur.modelsDirPinned) next.modelsDir = md;
      }
      next.comfyExtraArgs = args;
      next.launchFrom = `ComfyUI Desktop (${desk.variant || "install"} ${desk.id})`;
    } else {
      const bat = await portableLaunchArgs(rig, next.gpu?.vendor);
      if (bat) { next.comfyExtraArgs = bat.args; next.launchFrom = bat.file; }
    }
  }
  if (REDETECT || pythonChanged || !cur.torchBackend) {
    if (!QUIET || pythonChanged) console.log("  Checking which torch build the engine uses (a few seconds)…");
    const tb = await torchBackend(py);
    if (tb.backend) { next.torchBackend = tb.backend; next.torchVersion = tb.version; }
    else notes.push(`Could not import torch with ${py}: ${tb.error}`);
    const warn = mismatch(next.gpu, tb, next.engineInstall?.backend);
    if (warn) notes.push(warn);
  }
  /* Studio's own engine on another ComfyUI than the pinned tag (one installed
   * before the pin). Read from the engine folder's own marker, so a ComfyUI the
   * person installed is never judged. One small file, so every run. */
  const engineMark = await readFile(path.join(rig, ".aiplay-engine.json"), "utf-8").then(JSON.parse).catch(() => null);
  const pinWarn = comfyPinNote(engineMark);
  if (pinWarn) notes.push(pinWarn);

  if (announce || !QUIET || notes.length) {
    console.log(`  engine: ${rig}\n  python: ${py}`);
    if (next.gpu) console.log(`  card:   ${next.gpu.name} (${(next.gpu.totalMb / 1024).toFixed(1)} GB, ${next.gpu.vendor})`);
    if (next.torchBackend) console.log(`  torch:  ${next.torchVersion} (${next.torchBackend})`);
    if (next.launchFrom) console.log(`  flags:  ${(next.comfyExtraArgs || []).join(" ") || "(none)"}  — from ${next.launchFrom}`);
    if (next.modelsDir) console.log(`  models: ${next.modelsDir}`);
    for (const n of notes) console.log(`\n  ⚠ ${n}`);
    if (notes.length) console.log("");
  }

  if (JSON.stringify(next) !== JSON.stringify(cur)) {
    /* ONLY WHAT THIS RUN CHANGED, merged into the file as it is NOW. The
     * launcher runs this check while its window is open, and a preference saved
     * meanwhile (the favourite star, closing stops Studio, a folder) was put back
     * to the copy read at the start when `next` was written whole. */
    const latest = await saved();
    const out = { ...latest };
    for (const k of new Set([...Object.keys(cur), ...Object.keys(next)])) {
      if (JSON.stringify(cur[k]) === JSON.stringify(next[k])) continue;
      if (next[k] === undefined) delete out[k];
      else out[k] = next[k];
    }
    await mkdir(path.dirname(SETTINGS), { recursive: true });
    await writeFile(SETTINGS, JSON.stringify(out, null, 2));
    if (announce) console.log(`\n  Saved to ${SETTINGS}`);
  }
  report = {
    ok: true, rig, python: py, gpu: next.gpu || null,
    torchBackend: next.torchBackend || null, torchVersion: next.torchVersion || null,
    launchFrom: next.launchFrom || null, comfyExtraArgs: next.comfyExtraArgs || [],
    modelsDir: next.modelsDir || null, notes,
    mismatch: mismatch(next.gpu, next.torchBackend ? { backend: next.torchBackend, version: next.torchVersion } : null, next.engineInstall?.backend),
    engineInstall: next.engineInstall || null,
    comfyPin: engineMark?.complete ? { pinned: COMFY_TAG, installed: engineMark.comfy || null } : null,
  };
  return 0;
}

async function main() {
  let cur = await saved();
  /* THE CARD FIRST, whatever else is missing. This used to be read only once a
   * ComfyUI was found, so a machine with no ComfyUI yet reported "No NVIDIA or
   * AMD card could be read" while the card sat right there — and the launcher's
   * "What should Studio run on?" choice had nothing to preselect. */
  if (!cur.gpu || REDETECT) {
    const gpu = await detectGpu();
    if (gpu && JSON.stringify(gpu) !== JSON.stringify(cur.gpu)) {
      cur = { ...cur, gpu };
      await mkdir(path.dirname(SETTINGS), { recursive: true });
      await writeFile(SETTINGS, JSON.stringify(cur, null, 2));
    }
  }
  /* No hardcoded fallback. This used to end in "D:\\AI\\aiplay-studio-bench",
   * which is one specific development machine -- meaningless to every other
   * user, and it shipped that path in a public repo. Empty string simply fails
   * the isEngine() check below and drops into the search, which is what should
   * happen on a machine that has never been configured. */
  const rig = process.env.AIPLAY_RIG || cur.rig || "";

  // Already working: say nothing and get out of the way.
  // `rig &&` matters: path.join("", ...) yields a RELATIVE "ComfyUI\main.py",
  // which stat would happily resolve against Studio's own folder.
  if (rig && await isEngine(rig)) return finalize(rig, cur, { announce: false });

  console.log("\n  AIPLAY Studio needs a ComfyUI install to drive.");
  console.log("  It does not ship one: ComfyUI is gigabytes on its own, updates on its");
  console.log("  own schedule, and you very likely already have it.\n");

  const hits = await guess();
  if (hits.length) {
    console.log("  Found:");
    hits.forEach((h, i) => console.log(`    ${i + 1}. ${h}`));
    console.log("");
  } else {
    console.log("  Could not find one automatically.");
    console.log("  If you have none: https://github.com/comfyanonymous/ComfyUI");
    console.log("  Install it, run it once, then start Studio again.\n");
  }

  // Non-interactive (double-clicked, or piped): report and stop rather than
  // hanging on a prompt nobody can see.
  if (!stdin.isTTY || JSON_OUT) {
    if (hits.length === 1) {
      console.log(`  Using ${hits[0]}.`);
      return finalize(hits[0], cur, { announce: true });
    }
    report = {
      ok: false, hits, gpu: cur.gpu || null, needsEngine: !hits.length,
      error: hits.length
        ? "Several ComfyUI installs were found. Choose one: press Change… beside \"ComfyUI install\" in the launcher, or set \"rig\" in settings.json."
        : "No ComfyUI install was found.",
    };
    console.log(`  Set the folder in ${SETTINGS}:\n    { "rig": "D:\\\\path\\\\to\\\\parent-of-ComfyUI" }\n`);
    return 1;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(
    hits.length ? "  Pick a number, or paste a path: " : "  Paste the path to your ComfyUI folder: ")).trim();
  rl.close();
  if (!answer) return 1;

  let chosen = /^\d+$/.test(answer) ? hits[Number(answer) - 1] : answer;
  if (!chosen) return 1;
  // Accept either the folder CONTAINING ComfyUI or ComfyUI itself — both are
  // reasonable things to paste, and guessing wrong here is a bad first minute.
  if (!(await isEngine(chosen)) && await exists(path.join(chosen, "main.py"))) {
    chosen = path.dirname(chosen);
  }
  if (!(await isEngine(chosen))) {
    console.log(`\n  No ComfyUI/main.py under ${chosen}.\n`);
    return 1;
  }

  const code = await finalize(chosen, cur, { announce: true });
  if (code === 0) {
    console.log("  Open the Models screen once Studio starts — it lists what each");
    console.log("  feature needs, how large it is, and fetches it when you ask.\n");
  }
  return code;
}

const exitCode = await main();
if (JSON_OUT) process.stdout.write(`${JSON.stringify({ hits: [], ...report })}\n`);
process.exit(exitCode);
