/**
 * AIPLAY Studio launcher — one window for both launch modes.
 *
 * A small local server (loopback only) that serves launcher/index.html in an
 * app-style browser window (Edge or Chrome `--app`, falling back to the default
 * browser), and does four things for it:
 *
 *   - SYSTEM CHECK: runs `scripts/setup.mjs --json` (graphics card, CUDA/ROCm
 *     torch, ComfyUI install, launch flags) and looks at the models on disk
 *     (YuE2 checkpoints, MiniMax weights, the native GGUF runtime).
 *   - LAUNCH: starts Studio as a child process — full (`server/index.js`) or
 *     music-only (`scripts/start-music.mjs`) — with its output streamed into
 *     the window's log.
 *   - WAIT FOR THE ENGINE: polls Studio's /api/status and opens the Studio UI
 *     only once ComfyUI reports ready (`engine.ready`). A music-only run that
 *     starts no ComfyUI (native GGUF) is opened as soon as the server answers.
 *   - STOP: ends Studio and its ComfyUI child together.
 *
 * Nothing here installs, downloads or changes a model or a torch build.
 */
import http from "node:http";
import { spawn, execFile, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanBases, extraBases, uniqueDirs, countByFolder, pickFolderDialog, MODELS_PROMPT } from "../server/localmodels.js";
import { appVersion, versionLine } from "../server/version.js";
import { checkUpdates, lastCheck, updateSentence } from "../server/updates.js";
import { selfUpdate, updateSource } from "../server/selfupdate.js";
import { musicCards } from "./musiccard.mjs";
import { availableOptions, cleanValues, buildLaunchArgs, effectiveValues, hasAmdMusicFix, OPTIONS_REV, FIX_MODES, fixMode, fixApplies, vendorOf, autoVramFlags } from "../server/comfyargs.js";
import { ffmpegPath, ffprobePath } from "../server/clipjoin.js";
/* What the system check SAYS (RAM, ffmpeg, a weak card, Music only, Studio's
 * packages): pure, so server/installer_test.js can call it. */
import { ramItem, ffmpegItem, cardAdvice, musicOnlyNote, studioPackagesItem, yue2ComfyVerdict } from "./checks.mjs";
/* "Try again" beside Studio's own packages: the engine installer's --studio-packages, the same run MCP's setup_feature makes. */
import { runStudioPackages } from "../server/setup/engine-packages.js";
/* Their names, from the one list the installer and the check use. */
import { STUDIO_MODULES, moduleWords } from "../server/setup/studio-packages.js";

/* The VRAM tiers' flags, for the Advanced settings preview. Static in
 * server/config.js; copied by name here rather than importing config.js, which
 * computes a whole Studio configuration at import time. */
const TIER_FLAGS = {
  auto: ["--lowvram", "--async-offload", "4"],   // replaced by tierFlags() from the card's memory
  high: ["--async-offload", "4"], mid: ["--lowvram", "--async-offload", "4"],
  low: ["--lowvram", "--async-offload", "2"], minimum: ["--lowvram", "--async-offload", "1", "--reserve-vram", "1.0"],
};

/* A tier's flags; Auto's come from the card setup recorded, as the server's do. */
const tierFlags = (tier, settings) => tier === "auto" || !TIER_FLAGS[tier]
  ? autoVramFlags(settings?.gpu?.totalMb) : TIER_FLAGS[tier];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPDATA = process.env.AIPLAY_APPDATA || path.join(homedir(), ".aiplay-studio");
const SETTINGS = path.join(APPDATA, "settings.json");
const STUDIO_PORT = Number(process.env.AIPLAY_UI_PORT || 4173);
const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}`;
const PREFERRED_PORT = Number(process.env.AIPLAY_LAUNCHER_PORT || 4170);
const APP_TAG = "aiplay-launcher";
const ENGINE_DEADLINE_MS = 6 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bare = (n) => String(n || "").replace(/\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i, "");

/* ── state ─────────────────────────────────────────────────────────────── */

const studio = {
  mode: null,          // "full" | "music"
  state: "idle",       // idle | starting | ready | failed | stopping | stopped | external
  stage: null,         // setup | server | engine | ready
  pid: null,
  startedAt: null,
  readyAt: null,
  error: null,
  engineExpected: null,
  url: STUDIO_URL,
};
let child = null;
const logLines = [];
const clients = new Set();

function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
function setState(patch) {
  Object.assign(studio, patch);
  emit("state", studio);
}
function addLog(text, stream = "out") {
  for (const raw of String(text).split(/\r?\n|\r/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!line.trim()) continue;
    const entry = { t: Date.now(), line, stream };
    logLines.push(entry);
    if (logLines.length > 1000) logLines.shift();
    emit("log", entry);
    watchLine(line);
  }
}
/* Studio's own words for an engine that will not come up. */
function watchLine(line) {
  if (!child) return;
  const failed = line.match(/engine failed to start: (.*)$/) || line.match(/(giving up after six restarts.*)$/);
  if (failed && studio.state === "starting") {
    setState({ state: "failed", error: `ComfyUI did not start: ${failed[1]}` });
  }
}

/* ── helpers ───────────────────────────────────────────────────────────── */

async function readJson(p) {
  try { return JSON.parse(await readFile(p, "utf-8")); } catch { return null; }
}

function runNode(args, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

/* ── installing an engine (a machine with no ComfyUI) ──────────────────────
 * The launcher asks "What should Studio run on?" and runs
 * scripts/install-engine.mjs for the answer. On failure the script removes the
 * half-built engine folder, keeps what it downloaded (so the next try is
 * quicker) and prints the exact error; this keeps its state for the page. */
/* The Update button (server/selfupdate.js): one at a time, never while Studio
 * or an engine install runs, its sentences in the window's log. */
const updating = { state: "idle", step: "", line: "", restart: false };
const install = { state: "idle", backend: null, step: null, n: 0, of: 10, error: null, errorStep: null, warning: null };
let installChild = null;
/* Studio's own packages again, into the engine Studio installed (the row's
 * "Try again" / "Install"). Its own state: it is not an engine install, and
 * the "What should Studio run on?" card must not reappear for it. */
const pkgRetry = { state: "idle", message: null };
let pkgChild = null;
const busyInstalling = () => !!installChild || install.state === "running" || !!pkgChild || pkgRetry.state === "running";

async function startStudioPackages() {
  if (updating.state === "running") throw new Error("Wait for the Studio update to finish.");
  if (busyInstalling()) throw new Error("An install is already running.");
  if (child || studio.state === "starting") throw new Error("Stop Studio first: its engine is using that python.");
  const settings = (await readJson(SETTINGS)) || {};
  if (!settings.engineInstall || !settings.rig) throw new Error("Studio adds its packages only to an engine it installed itself.");
  Object.assign(pkgRetry, { state: "running", message: null });
  emit("pkgretry", pkgRetry);
  addLog(`Installing Studio's own packages (${moduleWords(STUDIO_MODULES)}: only the ones that do not import) into its engine.`, "sys");
  runStudioPackages({ rig: settings.rig, appData: APPDATA, script: path.join(ROOT, "scripts", "install-engine.mjs"),
    onLine: (l) => addLog(l, "out"), onChild: (c) => { pkgChild = c; } })
    .then((out) => {
      pkgChild = null;
      checkCache = null;
      const message = out.ok ? `Studio's own packages are installed: ${moduleWords(STUDIO_MODULES)} import in the engine.`
        : out.studio?.warning || out.error || "The packages did not install.";
      addLog(message, out.ok ? "sys" : "err");
      Object.assign(pkgRetry, { state: out.ok ? "done" : "failed", message });
      emit("pkgretry", pkgRetry);
    });
}

function setInstall(patch) {
  Object.assign(install, patch);
  emit("install", install);
}

async function startInstall(backend) {
  if (updating.state === "running") throw new Error("Wait for the Studio update to finish.");
  if (busyInstalling()) throw new Error("An install is already running.");
  if (child || studio.state === "starting") throw new Error("Stop Studio first.");
  if (!["nvidia", "amd", "intel", "cpu"].includes(backend)) throw new Error("Choose NVIDIA, AMD, Intel or CPU.");
  setInstall({ state: "running", backend, step: "Starting", n: 0, error: null, errorStep: null, warning: null });
  const settings = (await readJson(SETTINGS)) || {};
  const gpuName = settings.gpu?.vendor === backend ? settings.gpu.name : "";
  addLog(`Installing Studio's own ComfyUI for ${backend.toUpperCase()}. This downloads several GB and can take a while.`, "sys");
  const args = [path.join(ROOT, "scripts", "install-engine.mjs"), "--backend", backend, ...(gpuName ? ["--gpu-name", gpuName] : [])];
  installChild = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: process.env });
  let buf = "", errorMsg = null, errorStep = null, done = false, warning = null;
  const onLine = (line) => {
    if (line.startsWith("@@step ")) { try { const st = JSON.parse(line.slice(7)); setInstall({ step: st.label, n: st.n, of: st.of }); } catch {} return; }
    /* The engine works either way; Studio's own packages (OpenCV, librosa,
     * soundfile, SciPy) not all installing is said, not hidden (install-engine.mjs). */
    if (line.startsWith("@@done ")) { done = true; try { warning = JSON.parse(line.slice(7)).studio?.warning || null; } catch {} return; }
    if (line.startsWith("@@error ")) { try { const e = JSON.parse(line.slice(8)); errorMsg = e.message; errorStep = e.step; } catch {} return; }
    addLog(line, "out");
  };
  for (const stream of [installChild.stdout, installChild.stderr]) {
    stream.on("data", (d) => {
      buf += d.toString();
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      parts.forEach(onLine);
    });
  }
  installChild.on("close", (code) => {
    if (buf) onLine(buf);
    installChild = null;
    checkCache = null;
    if (code === 0 && done) {
      addLog("The engine is installed. Launch Full Studio when you are ready.", "sys");
      if (warning) addLog(warning, "err");
      setInstall({ state: "done", step: "Done", warning });
    } else {
      const msg = errorMsg || `The installer stopped unexpectedly (exit code ${code}).`;
      addLog(`Install failed: ${msg}`, "err");
      setInstall({ state: "failed", error: msg, errorStep });
    }
  });
}

function which(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [cmd], { windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).split(/\r?\n/)[0].trim() || null));
  });
}

async function probeStudio() {
  try {
    const r = await fetch(`${STUDIO_URL}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const s = await r.json();
    return {
      engineReady: !!s.engine?.ready,
      engineExpected: s.config?.engineExpected ?? !s.config?.musicOnly,
      musicOnly: !!s.config?.musicOnly,
      cloudOnly: !!s.config?.cloudOnly,
      remoteOnly: !!s.config?.remoteOnly,
      torch: s.engine?.torch || null,
      device: s.engine?.device || null,
    };
  } catch {
    return null;
  }
}

function openInBrowser(url) {
  if (process.env.AIPLAY_LAUNCHER_NO_WINDOW === "1") return;   // headless test run
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

/* ── the system check ──────────────────────────────────────────────────── */

let checkCache = null;
let checkInFlight = null;

async function systemCheck({ redetect = false } = {}) {
  const setupArgs = [path.join(ROOT, "scripts", "setup.mjs"), "--json", ...(redetect ? ["--redetect"] : [])];
  const setup = await runNode(setupArgs);
  let report = null;
  try { report = JSON.parse(setup.stdout.trim().split(/\r?\n/).pop()); } catch { /* reported below */ }
  const settings = (await readJson(SETTINGS)) || {};

  const rig = report?.rig || settings.rig || null;
  const python = report?.python || settings.python || null;
  const gpu = report?.gpu || settings.gpu || null;
  const vendor = gpu?.vendor || null;
  const torchBackend = report?.torchBackend || settings.torchBackend || null;
  const torchVersion = report?.torchVersion || settings.torchVersion || null;
  const modelsDir = settings.modelsDir || report?.modelsDir || (rig ? path.join(rig, "ComfyUI", "models") : null);

  const bases = uniqueDirs([
    modelsDir,
    ...(await extraBases(settings.comfyExtraArgs || report?.comfyExtraArgs || [])),
    rig && path.join(rig, "ComfyUI", "models"),
  ].filter(Boolean));
  const files = bases.length ? await scanBases(bases) : [];
  const names = new Set(files.map((f) => f.name));
  const overrides = settings.modelOverrides || {};
  const has = (n) => names.has(n) || (!!overrides[n] && names.has(overrides[n]));

  const yue2 = [...new Set(files
    .filter((f) => f.folder === "checkpoints" && /yue2?/i.test(f.name) && /\.(safetensors|sft)$/i.test(f.name))
    .map((f) => f.name))];
  const minimaxReady = (has("minimax_music3_dit_int8_convrot.safetensors") || names.has("minimax_music3_dit_fp16.safetensors"))
    && has("minimax_music3_text_encoder_pruned_int8_convrot.safetensors") && has("minimax_music3_dav.safetensors");
  /* Native YuE2 GGUF runs on any card now: setup installs audio.cpp's CUDA
   * build on NVIDIA, its Vulkan build on AMD/Intel and its CPU build without a
   * card (server/music/gguf-setup.js). Installed means the runtime AND a model
   * file are there; which runtime it is comes from setup's own receipt. */
  const ggufCli = settings.audioCppCli || path.join(APPDATA, "yue2-gguf", "runtime", "audiocpp_cli.exe");
  const ggufModels = settings.yueGgufModelDir || path.join(APPDATA, "yue2-gguf", "models");
  const ggufInstalled = existsSync(ggufCli)
    && ["yue2-3b-q4_0.gguf", "yue2-3b-q8_0.gguf"].some((n) => existsSync(path.join(ggufModels, n)));
  const ggufKind = (await readJson(path.join(path.dirname(ggufCli), "installation.json")))?.runtimeKind
    || (ggufInstalled ? "cuda" : null);   // a receipt without the field predates Vulkan: the CUDA kit
  const GGUF_RUNS_ON = { cuda: "NVIDIA CUDA", vulkan: "Vulkan", cpu: "the CPU" };
  // Only a CUDA build on a card that is not NVIDIA is a problem (it would fall back to the CPU).
  const ggufMismatch = ggufInstalled && ggufKind === "cuda" && vendor && vendor !== "nvidia";
  /* Both programs, found the way Studio finds them (server/clipjoin.js):
   * AIPLAY_FFMPEG / AIPLAY_FFPROBE first, then PATH. */
  const findTool = async (p) => (path.isAbsolute(p) ? (existsSync(p) ? p : null) : which(p));
  const [ffmpeg, ffprobe] = await Promise.all([findTool(ffmpegPath()), findTool(ffprobePath())]);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const comfyOk = !!(rig && python);
  const engineInstall = settings.engineInstall || report?.engineInstall || null;
  const cpuChosen = engineInstall?.backend === "cpu";
  const running = await probeStudio();

  /* MiniMax on AMD renders when ComfyUI starts with PyTorch attention and CUDA
   * graphs off (Studio's default); warn only when this launch lacks them. */
  const cliText = rig ? await readFile(path.join(rig, "ComfyUI", "comfy", "cli_args.py"), "utf-8").catch(() => null) : null;
  const launchTier = TIER_FLAGS[settings.prefs?.tier] ? settings.prefs.tier : "auto";
  const amdMusicFixed = hasAmdMusicFix(buildLaunchArgs({
    tierFlags: tierFlags(launchTier, settings),
    installFlags: Array.isArray(settings.comfyExtraArgs) ? settings.comfyExtraArgs.map(String) : [],
    useInstallFlags: settings.comfyUseInstallFlags !== false,
    values: effectiveValues(settings.comfyOptions, settings.comfyOptionsRev, cliText, { fix: settings.comfyAmdFix, vendor }),
  }));
  const items = [
    { id: "node", label: "Node.js", status: nodeMajor >= 20 ? "ok" : "bad", value: process.version,
      detail: nodeMajor >= 20 ? "" : "Studio needs Node.js 20 or newer." },
    { id: "gpu", label: "Graphics card",
      status: gpu ? (vendor === "nvidia" || vendor === "amd" ? "ok" : "warn") : torchBackend ? "ok" : "warn",
      value: gpu ? `${gpu.name}${gpu.totalMb ? ` · ${(gpu.totalMb / 1024).toFixed(1)} GB` : ""}`
        : torchBackend ? `not read · ComfyUI runs ${torchBackend.toUpperCase()}` : "not detected",
      detail: gpu ? `read from ${gpu.source}` : torchBackend ? "" : "Choose what Studio should run on below." },
    ramItem(totalmem()),
    { id: "torch", label: "PyTorch in ComfyUI",
      status: !torchBackend ? "bad" : report?.mismatch ? "bad" : torchBackend === "cpu" ? (cpuChosen ? "warn" : "bad") : "ok",
      value: torchBackend ? `${torchVersion} · ${torchBackend.toUpperCase()}` : "not read",
      detail: report?.mismatch || (torchBackend === "rocm" ? "AMD ROCm build" : torchBackend === "cuda" ? "NVIDIA CUDA build"
        : torchBackend === "xpu" ? "Intel XPU build" : cpuChosen ? "CPU only, as chosen at install — renders are slow" : "") },
    /* `pick` puts a Change… button on the row. These two are the only settings
     * that can stop Studio starting at all, and the launcher is the screen
     * that is up when they are wrong. */
    { id: "comfy", label: "ComfyUI install", status: comfyOk ? "ok" : "bad", value: rig || "not found", pick: "comfy",
      detail: comfyOk ? `${report?.launchFrom ? `flags from ${report.launchFrom} · ` : ""}${python}` : (report?.error || "Install ComfyUI and run it once.") },
    { id: "models", label: "Models folder", status: files.length ? "ok" : "warn", value: modelsDir || "—", pick: "models",
      detail: `${files.length} model file${files.length === 1 ? "" : "s"}${bases.length > 1 ? ` across ${bases.length} folders` : ""}` },
    { id: "yue2", label: "YuE2 checkpoint (ComfyUI)", status: yue2.length ? "ok" : "warn",
      value: yue2.length ? yue2.map(bare).join(", ") : "none found",
      detail: yue2.length ? "renders through ComfyUI's own YuE2 nodes" : "Put a YuE2 checkpoint (e.g. yue2_3b_bf16) in models/checkpoints." },
    /* On AMD it renders once ComfyUI starts with PyTorch attention and CUDA
     * graphs off (Studio's default); the row warns only when this launch lacks them. */
    { id: "minimax", label: "MiniMax Music 3", status: !minimaxReady ? "off" : vendor === "amd" && !amdMusicFixed ? "warn" : "ok",
      value: minimaxReady ? "on disk" : "not downloaded",
      detail: !minimaxReady || vendor !== "amd" ? ""
        : amdMusicFixed ? "renders on AMD with PyTorch attention and CUDA graphs off (this launch)"
        : "Broken on AMD with this launch. Turn on PyTorch attention and Disable CUDA graphs under Advanced." },
    { id: "gguf", label: "Native YuE2 GGUF", status: !ggufInstalled ? "off" : ggufMismatch ? "warn" : "ok",
      value: ggufInstalled ? `installed · runs on ${GGUF_RUNS_ON[ggufKind] || ggufKind}` : "not installed",
      detail: ggufMismatch ? "This is the NVIDIA build on a non-NVIDIA card. Reinstall it from Models to get the Vulkan build."
        : ggufInstalled ? "no ComfyUI needed"
        : "Any card (CUDA on NVIDIA, Vulkan on AMD and Intel, or the CPU) · install from Models · no ComfyUI needed" },
    ffmpegItem({ ffmpeg, ffprobe }),
    /* Only for an engine Studio installed: whether OpenCV, librosa,
     * soundfile and SciPy went in, with Try again when they did not. */
    studioPackagesItem(engineInstall),
  ].filter(Boolean);

  /* The music model each card names: Studio's own answer (launcher/musiccard.mjs
   * asks server/music-default.js), so a fresh install that saved nothing is
   * told what Studio will actually run, and the MiniMax-on-AMD warning appears
   * only for somebody who saved MiniMax. */
  const ggufOk = ggufInstalled && !ggufMismatch;
  /* Card and RAM, judged by the function Studio asks (server/music-default.js
   * yue2ComfyFit); a card whose memory was not read is no reading, as there. */
  const comfyVerdict = yue2ComfyVerdict(gpu, totalmem());
  const cards = musicCards({
    prefs: settings.prefs || {}, api: settings.api || null, yue2, comfyOk, ggufOk,
    ggufPrecisions: ["q4_0", "q8_0"].filter((p) => existsSync(path.join(ggufModels, `yue2-3b-${p}.gguf`))),
    minimaxReady, vendor, cardRead: !!gpu?.totalMb, amdMusicFixed, comfyFits: comfyVerdict.fits, comfyShort: comfyVerdict.short,
  });
  const musicVia = cards.music.via;
  const modes = {
    full: {
      available: comfyOk && nodeMajor >= 20,
      engine: cards.full.engine,
      why: cards.full.why,
      warn: cards.full.warn,
      note: comfyOk ? "Every screen: music, images, video, the DAW and the rest. Starts ComfyUI." : "Needs a ComfyUI install.",
    },
    music: {
      available: nodeMajor >= 20,
      engine: cards.music.engine,
      warn: !musicVia
        ? (ggufMismatch ? "The installed GGUF runtime is the NVIDIA build. Reinstall it from the Models screen after launch."
          : "Install YuE2 GGUF from the Models screen after launch (any card), or put a YuE2 checkpoint in ComfyUI's models/checkpoints.")
        : null,
      note: musicOnlyNote(musicVia === "yue2-comfy"),
    },
    /* Hosted models through Comfy Router on the user's own Comfy key. Needs
     * nothing local but Node: no ComfyUI, no card, no model files. */
    cloud: {
      available: nodeMajor >= 20,
      engine: "Comfy Router (cloud)",
      warn: null,
      note: "Hosted image, video, audio, 3D and text models on your own Comfy API key, paid per run in Comfy credits. No ComfyUI needed.",
    },
    /* Images and Video on the person's own RunPod Pod through the AIPLAY worker
     * (server/engine/remote-*.js). Needs nothing local but Node; the Pod bills
     * by the hour while it runs. */
    runpod: {
      available: nodeMajor >= 20,
      engine: "Your RunPod Pod",
      warn: null,
      note: "Images and video render on your own RunPod GPU and come back to this PC. Billed by RunPod per hour while the Pod runs. No ComfyUI needed here.",
    },
  };

  return {
    at: Date.now(), items, modes, gpuVendor: vendor, gpuName: gpu?.name || null,
    /* A weak or missing card: a friend's card first (Collab), Comfy API second.
     * The floor is the catalogue's H3 row, the Models screen's own number. */
    cardAdvice: cardAdvice({ gpu, torchOnCard: !!torchBackend && torchBackend !== "cpu",
      fullAvailable: comfyOk && nodeMajor >= 20, needsEngine: !comfyOk && !report?.hits?.length }),
    pkgRetry,
    /* No ComfyUI at all: the page asks what to run on and offers to install. */
    needsEngine: !comfyOk && !report?.hits?.length,
    install,
    notes: report?.notes || [], hits: report?.hits || [],
    setupError: report ? (report.ok ? null : report.error) : (setup.stderr.trim().slice(-500) || "setup.mjs gave no report"),
    studioRunning: !!running,
  };
}

function getCheck(redetect) {
  if (checkInFlight) return checkInFlight;
  if (checkCache && !redetect) return Promise.resolve(checkCache);
  checkInFlight = systemCheck({ redetect })
    .then((c) => { checkCache = c; return c; })
    .finally(() => { checkInFlight = null; });
  return checkInFlight;
}

/* ── launch / wait / stop ──────────────────────────────────────────────── */

async function launch(mode) {
  if (updating.state === "running") throw new Error("Wait for the Studio update to finish.");
  if (existsSync(path.join(ROOT, ".aiplay-update-npm-pending"))) throw new Error("Press Update again to finish installing Studio's dependencies before starting.");
  if (studio.state === "starting") throw new Error("Studio is already starting.");
  if (child) throw new Error("Studio is already running from this launcher.");
  if (busyInstalling()) throw new Error("Wait for the engine install to finish.");
  if (!["full", "music", "cloud", "runpod"].includes(mode)) throw new Error("Unknown mode.");

  setState({ mode, state: "starting", stage: "setup", startedAt: Date.now(), readyAt: null, error: null, pid: null, engineExpected: null });
  const running = await probeStudio();
  if (running) {
    setState({ mode: running.cloudOnly ? "cloud" : running.remoteOnly ? "runpod" : running.musicOnly ? "music" : "full", state: "external", stage: null, error: null });
    addLog(`Studio is already running at ${STUDIO_URL} (started outside this launcher). Opening it.`, "sys");
    openInBrowser(STUDIO_URL);
    return;
  }

  if (mode === "full") {
    addLog("Checking the ComfyUI setup…", "sys");
    const r = await runNode([path.join(ROOT, "scripts", "setup.mjs"), "--quiet-if-ready"]);
    if (r.stdout.trim()) addLog(r.stdout);
    if (r.stderr.trim()) addLog(r.stderr, "err");
    if (r.code !== 0) {
      setState({ state: "failed", stage: null, error: "ComfyUI setup did not complete — see the log." });
      return;
    }
  }

  const script = mode === "music" ? path.join("scripts", "start-music.mjs")
    : mode === "cloud" ? path.join("scripts", "start-cloud.mjs")
    : mode === "runpod" ? path.join("scripts", "start-remote.mjs") : path.join("server", "index.js");
  const env = { ...process.env, AIPLAY_MUSIC_ONLY: mode === "music" ? "1" : "0", AIPLAY_CLOUD_ONLY: mode === "cloud" ? "1" : "0",
    AIPLAY_REMOTE_ONLY: mode === "runpod" ? "1" : "0" };
  delete env.AIPLAY_OPEN;   // the launcher opens Studio itself, once the engine is ready
  addLog(`Starting ${mode === "music" ? "music-only" : mode === "cloud" ? "Comfy API" : mode === "runpod" ? "RunPod GPU" : "full"} Studio…`, "sys");
  child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const me = child;
  setState({ stage: "server", pid: child.pid });
  child.stdout.on("data", (d) => addLog(d));
  child.stderr.on("data", (d) => addLog(d, "err"));
  child.on("exit", (code) => {
    if (child !== me) return;
    child = null;
    const stopping = studio.state === "stopping";
    addLog(`Studio ${stopping ? "stopped" : `exited with code ${code}`}.`, "sys");
    setState({
      state: stopping || studio.state === "ready" ? "stopped" : "failed",
      stage: null, pid: null,
      error: stopping || studio.state === "ready" ? null : (studio.error || `Studio exited (code ${code}) — see the log.`),
    });
  });
  waitForEngine(me);
}

async function waitForEngine(proc) {
  const deadline = Date.now() + ENGINE_DEADLINE_MS;
  let saidWaiting = false;
  while (child === proc && Date.now() < deadline) {
    if (studio.state !== "starting") return;
    const s = await probeStudio();
    if (s) {
      if (studio.engineExpected !== s.engineExpected) setState({ engineExpected: s.engineExpected });
      if (!s.engineExpected || s.engineReady) {
        if (child !== proc || studio.state !== "starting") return;
        setState({ state: "ready", stage: "ready", readyAt: Date.now(), error: null });
        addLog(s.engineExpected
          ? `ComfyUI reports ready (${s.device || s.torch || "engine up"}). Opening Studio.`
          : "Studio is up (no ComfyUI in this mode). Opening Studio.", "sys");
        openInBrowser(STUDIO_URL);
        return;
      }
      if (!saidWaiting) {
        saidWaiting = true;
        setState({ stage: "engine" });
        addLog("Studio server is up. Waiting for ComfyUI to report ready before opening…", "sys");
      }
    }
    await sleep(1000);
  }
  if (child === proc && studio.state === "starting") {
    setState({ state: "failed", error: "ComfyUI did not report ready within 6 minutes — see the log. Studio is still running; you can open it anyway or stop it." });
  }
}

function killTreeSync(pid) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGTERM");
  } catch { /* already gone */ }
}

async function stopStudio() {
  if (!child) return;
  setState({ state: "stopping" });
  addLog("Stopping Studio and ComfyUI…", "sys");
  const pid = child.pid;
  await new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      child.kill("SIGTERM");
      resolve();
    }
  });
}

/* ── the window ────────────────────────────────────────────────────────── */

function findAppBrowser() {
  const pf86 = process.env["ProgramFiles(x86)"], pf = process.env.ProgramFiles, local = process.env.LOCALAPPDATA;
  const candidates = process.platform === "win32" ? [
    pf86 && path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    pf && path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    pf && path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    pf86 && path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ] : [];
  return candidates.filter(Boolean).find((p) => existsSync(p)) || null;
}

function openWindow(url) {
  const exe = findAppBrowser();
  if (!exe) {
    openInBrowser(url);
    return null;
  }
  /* Its own profile folder, so the window is its own process: closing it is
   * noticed, and it never merges into a browser window you already have. */
  return spawn(exe, [
    `--app=${url}`,
    `--user-data-dir=${path.join(APPDATA, "launcher-window")}`,
    "--window-size=1120,800",
    "--no-first-run", "--no-default-browser-check",
  ], { stdio: "ignore" });
}

/* ── the HTTP side ─────────────────────────────────────────────────────── */

function send(res, code, body, type = "application/json") {
  const json = type === "application/json";
  res.writeHead(code, { "Content-Type": json ? "application/json; charset=utf-8" : type, "Cache-Control": "no-store" });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/* ── the two folders Studio cannot guess ────────────────────────────────
 *
 * Until now both were only changeable from inside Studio — the Models screen
 * and Settings — which is exactly the wrong place when the reason Studio will
 * not start is that it cannot find ComfyUI. The launcher is the screen that is
 * up when that is true, so it asks here, through the same native dialog the
 * Models screen uses.
 *
 * Nothing is moved, copied or downloaded: this writes two strings into
 * settings.json and re-runs the system check.
 */
async function saveSettings(patch, remove = []) {
  const next = { ...((await readJson(SETTINGS)) || {}), ...patch };
  for (const k of remove) delete next[k];
  await mkdir(path.dirname(SETTINGS), { recursive: true });
  await writeFile(SETTINGS, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

async function chooseFolder(what) {
  const settings = (await readJson(SETTINGS)) || {};
  const ask = (start, caption) => pickFolderDialog(start || "", caption);

  if (what === "models") {
    const r = await ask(settings.modelsDir, MODELS_PROMPT);
    if (r.unsupported) return { error: "The folder picker is Windows-only. Set \"modelsDir\" in settings.json." };
    if (r.error) return { error: r.error };
    if (!r.path) return { cancelled: true };
    const files = await scanBases([r.path]);
    /* PINNED. setup.mjs adopts the rig's own models folder on every run, and a
     * folder somebody chose by hand must survive that. */
    /* The folder being left keeps working, exactly as on the Models screen:
     * remembered in `modelsAlso`, still checked and still loaded from, so a
     * new folder for downloads never makes what is already there look missing. */
    const key = (d) => path.resolve(String(d)).replace(/[\\/]+$/, "").toLowerCase();
    const prev = settings.modelsDir || (settings.rig ? path.join(settings.rig, "ComfyUI", "models") : null);
    const also = [...(Array.isArray(settings.modelsAlso) ? settings.modelsAlso : []),
      ...(prev && existsSync(prev) ? [prev] : [])]
      .filter((d, i, all) => key(d) !== key(r.path) && all.findIndex((x) => key(x) === key(d)) === i);
    await saveSettings({ modelsDir: r.path, modelsDirPinned: true, modelsAlso: also });
    checkCache = null;
    return {
      path: r.path, files: files.length, folders: Object.keys(countByFolder(files)).length,
      note: files.length
        ? `${files.length} model file${files.length === 1 ? "" : "s"} found. Studio will load from here.`
        : "No models there yet: new downloads will go to this folder, and the models you already have keep working from where they are.",
    };
  }

  if (what === "comfy") {
    const r = await ask(settings.rig, "Choose your ComfyUI folder (the one that contains a ComfyUI folder with main.py)");
    if (r.unsupported) return { error: "The folder picker is Windows-only. Set \"rig\" in settings.json." };
    if (r.error) return { error: r.error };
    if (!r.path) return { cancelled: true };
    /* Both spellings, because both are what people see in Explorer: the folder
     * that CONTAINS ComfyUI, and ComfyUI itself. */
    const rig = [r.path, path.dirname(r.path)].find((c) => existsSync(path.join(c, "ComfyUI", "main.py")));
    if (!rig) return { error: `No ComfyUI in ${r.path} — expected ComfyUI\\main.py inside the folder you pick.` };
    /* `python` is derived from the rig, so it is dropped rather than left
     * pointing into the previous install's environment. */
    await saveSettings({ rig }, ["python", "comfyExtraArgs", "launchFrom", "torchBackend", "torchVersion"]);
    checkCache = null;
    return { path: rig, note: "Re-reading this install's python and launch flags…" };
  }

  return { error: "Unknown folder." };
}

/* ── the Advanced settings ─────────────────────────────────────────────────
 *
 * Folders separate from ComfyUI's defaults, and ComfyUI's own launch options
 * (server/comfyargs.js) — read from THIS install's cli_args.py, so nothing is
 * offered that the user's ComfyUI would reject at startup. Everything is
 * applied by Studio at its next start; the preview is the flags it will use. */
async function advancedState() {
  const s = (await readJson(SETTINGS)) || {};
  const rig = s.rig || null;
  const cli = rig ? await readFile(path.join(rig, "ComfyUI", "comfy", "cli_args.py"), "utf-8").catch(() => null) : null;
  const vendor = vendorOf(s.gpu, s.torchBackend);
  const amdFix = { mode: fixMode(s.comfyAmdFix), vendor, applies: fixApplies(s.comfyAmdFix, vendor) };
  const values = effectiveValues(s.comfyOptions, s.comfyOptionsRev, cli, { fix: amdFix.mode, vendor });
  const useInstallFlags = s.comfyUseInstallFlags !== false;
  const tier = TIER_FLAGS[s.prefs?.tier] ? s.prefs.tier : "auto";
  const installFlags = Array.isArray(s.comfyExtraArgs) ? s.comfyExtraArgs.map(String) : [];
  const def = (sub) => (rig ? path.join(rig, "ComfyUI", sub) : null);
  return {
    rig, cliFound: !!cli, options: availableOptions(cli), values, useInstallFlags, installFlags, tier, amdFix,
    folders: {
      models: { path: s.modelsDir || null, default: def("models") },
      output: { path: s.outputDir || null, default: def("output") },
      input: { path: s.inputDir || null, default: def("input") },
    },
    preview: buildLaunchArgs({ tierFlags: tierFlags(tier, s), installFlags, useInstallFlags, values }),
  };
}

async function saveAdvanced(b) {
  if (child || await probeStudio()) return { error: "Stop Studio first — ComfyUI reads these when it starts." };
  if (b.reset === true) await saveSettings({}, ["comfyOptions", "comfyOptionsRev", "comfyUseInstallFlags", "comfyAmdFix"]);
  if (FIX_MODES.includes(b.amdFix)) await saveSettings({ comfyAmdFix: b.amdFix });
  // Saved from a panel that showed Studio's defaults: taken as it is from now on.
  if (b.values && typeof b.values === "object") await saveSettings({ comfyOptions: cleanValues(b.values), comfyOptionsRev: OPTIONS_REV });
  if (typeof b.useInstallFlags === "boolean") await saveSettings({ comfyUseInstallFlags: b.useInstallFlags });
  const f = b.folder;
  if (f && ["models", "output", "input"].includes(f.what)) {
    const key = { models: "modelsDir", output: "outputDir", input: "inputDir" }[f.what];
    if (f.action === "reset") {
      await saveSettings({}, f.what === "models" ? ["modelsDir", "modelsDirPinned"] : [key]);
    } else if (f.what === "models") {
      const r = await chooseFolder("models");
      if (r.error) return r;
    } else {
      const s = (await readJson(SETTINGS)) || {};
      const r = await pickFolderDialog(s[key] || (s.rig ? path.join(s.rig, "ComfyUI", f.what) : ""),
        f.what === "output" ? "Choose the folder ComfyUI saves songs and pictures to" : "Choose the folder ComfyUI reads input files from");
      if (r.unsupported) return { error: "The folder picker is Windows-only." };
      if (r.error) return { error: r.error };
      if (r.path) await saveSettings({ [key]: r.path });
    }
    checkCache = null;
  }
  return advancedState();
}

function makeServer(portRef) {
  return http.createServer(async (req, res) => {
    /* Loopback only, and only for pages this launcher served: a web page
     * elsewhere must not be able to start or stop Studio. */
    const host = req.headers.host || "";
    const ownHosts = [`127.0.0.1:${portRef.port}`, `localhost:${portRef.port}`];
    if (!ownHosts.includes(host)) return send(res, 403, { error: "forbidden" });
    const origin = req.headers.origin;
    if (req.method === "POST" && origin && !ownHosts.some((h) => origin === `http://${h}`)) {
      return send(res, 403, { error: "forbidden" });
    }
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, await readFile(path.join(ROOT, "launcher", "index.html"), "utf-8"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/logo.png") {
        return send(res, 200, await readFile(path.join(ROOT, "web", "assets", "aiplay-logo.png")), "image/png");
      }
      if (url.pathname === "/api/ping") return send(res, 200, { app: APP_TAG });
      /* WHICH BUILD, AND IS THERE A NEWER ONE. The same two answers Studio's
       * own /api/version gives, from the same two modules, so the launcher and
       * the About page can never disagree. GET touches no network; the check
       * is a press, and its answer is kept for an hour. */
      if (url.pathname === "/api/version") {
        if (req.method === "POST") {
          const r = await checkUpdates({ force: true });
          return send(res, 200, { version: appVersion(), line: versionLine(), update: r, says: updateSentence(r) });
        }
        const last = lastCheck();
        return send(res, 200, { version: appVersion(), line: versionLine(), update: last, says: last ? updateSentence(last) : "" });
      }
      if (url.pathname === "/api/update") {
        if (req.method === "POST") {
          if (child) return send(res, 200, { ...updating, error: "Stop Studio first: its files are about to be replaced." });
          if (await probeStudio()) return send(res, 200, { ...updating, error: "Stop the Studio running outside this launcher before updating." });
          if (child || studio.state === "starting") return send(res, 200, { ...updating, error: "Wait for Studio to finish starting, then stop it before updating." });
          if (busyInstalling()) return send(res, 200, { ...updating, error: "Wait for the engine install to finish." });
          if (updating.state === "running") return send(res, 200, updating);
          Object.assign(updating, { state: "running", step: "Starting…", line: "", restart: false });
          selfUpdate({ root: ROOT, say: (t) => { updating.step = t; addLog(`update: ${t}`); } })
            .then((r) => { Object.assign(updating, { state: r.ok ? "done" : "failed", step: "", line: r.line, restart: !!r.restart }); addLog(`update: ${r.line}`, r.ok ? "out" : "err"); })
            .catch((e) => { Object.assign(updating, { state: "failed", step: "", line: `The update stopped: ${e.message}` }); addLog(updating.line, "err"); });
          return send(res, 200, updating);
        }
        return send(res, 200, { ...updating, source: await updateSource(ROOT).catch(() => null) });
      }
      if (url.pathname === "/api/state") {
        const saved = (await readJson(SETTINGS)) || {};
        return send(res, 200, { studio, install, pkgRetry, log: logLines.slice(-400), host: HOST,
          prefs: launcherPrefs(saved) });
      }
      /* Launcher preferences. One so far: whether the window's X also stops
       * Studio. Off by default — closing a window should not end a render
       * somebody left running on purpose. */
      if (req.method === "POST" && url.pathname === "/api/prefs") {
        const b = await readBody(req);
        if (typeof b.closeStopsStudio === "boolean") await saveSettings({ launcherCloseStopsStudio: b.closeStopsStudio });
        /* The favourite (the star on a card): one mode, or null to clear it. */
        if (b.autoLaunch === null) await saveSettings({}, ["launcherAutoLaunch"]);
        else if (b.autoLaunch !== undefined) {
          if (!LAUNCH_MODES.includes(b.autoLaunch)) return send(res, 400, { error: "Unknown mode." });
          await saveSettings({ launcherAutoLaunch: b.autoLaunch });
        }
        const saved = (await readJson(SETTINGS)) || {};
        return send(res, 200, { ok: true, prefs: launcherPrefs(saved) });
      }
      if (url.pathname === "/api/advanced") {
        if (req.method === "POST") return send(res, 200, await saveAdvanced(await readBody(req)));
        return send(res, 200, await advancedState());
      }
      if (req.method === "POST" && url.pathname === "/api/show") { showWindow(); return send(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/api/pick") {
        if (child) return send(res, 200, { error: "Stop Studio first — the folders are read when it starts." });
        return send(res, 200, await chooseFolder(String((await readBody(req)).what || "")));
      }
      if (url.pathname === "/api/install") {
        if (req.method === "POST") {
          const b = await readBody(req);
          try {
            /* { retry: "studio-packages" }: only Studio's own packages, into its engine. */
            if (b.retry === "studio-packages") { await startStudioPackages(); return send(res, 200, pkgRetry); }
            await startInstall(String(b.backend || ""));
          } catch (e) { return send(res, 200, { error: e.message }); }
        }
        return send(res, 200, install);
      }
      if (url.pathname === "/api/check") return send(res, 200, await getCheck(url.searchParams.get("refresh") === "1"));
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(studio)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/launch") {
        const b = await readBody(req);
        launch(String(b.mode || "")).catch((e) => {
          addLog(e.message, "err");
          setState({ state: "failed", error: e.message });
        });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/stop") { await stopStudio(); return send(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/api/open") { openInBrowser(STUDIO_URL); return send(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/api/quit") {
        send(res, 200, { ok: true });
        if (child) killTreeSync(child.pid);
        setTimeout(() => process.exit(0), 200);
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(server.address().port); });
  });
}

/* "exe" when AIPLAY Studio.exe runs this (no console; a tray icon instead). */
const HOST = process.env.AIPLAY_LAUNCHER_HOST === "exe" ? "exe" : "console";
let launcherUrl = null;
let windowProc = null;

/* Opens the launcher window, or a second one while the first is still open.
 * Only the first window's browser process is watched: a later spawn hands its
 * window to that process and exits at once, which is not "closed". */
/* AIPLAY_LAUNCHER_NO_WINDOW=1: serve the launcher page and API but open no
 * window — for install tests and CI, where nothing may appear on a desktop. */
const NO_WINDOW = process.env.AIPLAY_LAUNCHER_NO_WINDOW === "1";

function showWindow() {
  if (!launcherUrl || NO_WINDOW) return;
  if (windowProc && windowProc.exitCode === null) { openWindow(launcherUrl); return; }
  windowProc = openWindow(launcherUrl);
  windowProc?.on("exit", async () => {
    windowProc = null;
    if (!child) {
      console.log("  Launcher window closed.");
      process.exit(0);
    }
    /* Opt-in: the X ends everything, Studio and ComfyUI with it. */
    const saved = (await readJson(SETTINGS)) || {};
    if (saved.launcherCloseStopsStudio === true) {
      console.log("  Launcher window closed; stopping Studio (\"Closing this window also stops Studio\" is on).");
      await stopStudio();
      process.exit(0);
    }
    console.log("  Launcher window closed; Studio is still running.");
    console.log(HOST === "exe"
      ? "  Click the AIPLAY tray icon to reopen the window, or right-click it to stop Studio."
      : "  Run AIPLAY Studio.cmd again to reopen the window, or close this console to stop Studio.");
  });
}

/* The launch modes, and the launcher's own preferences as the page reads them.
 * `autoLaunch` is the favourite: the star on a card, started by main() below
 * every time the launcher starts (settings.json launcherAutoLaunch). */
const LAUNCH_MODES = ["full", "music", "cloud", "runpod"];
function launcherPrefs(saved) {
  return {
    closeStopsStudio: saved.launcherCloseStopsStudio === true,
    autoLaunch: LAUNCH_MODES.includes(saved.launcherAutoLaunch) ? saved.launcherAutoLaunch : null,
  };
}
/** Start the favourite, once, as the launcher opens. Not when Studio already
 *  runs (launch() finds it and opens it instead), not when the system check
 *  says the mode cannot run here: the log says why, and nothing starts. */
async function autoLaunch() {
  const mode = launcherPrefs((await readJson(SETTINGS)) || {}).autoLaunch;
  if (!mode) return;
  const c = await getCheck(false).catch(() => null);
  if (!c?.modes?.[mode]?.available) {
    addLog(`Your favourite (${mode}) cannot start on this PC right now; see System. Remove the star to stop trying.`, "sys");
    return;
  }
  addLog(`Starting your favourite. Remove the star on its card to stop this.`, "sys");
  await launch(mode).catch((e) => addLog(`The favourite did not start: ${e.message}`, "err"));
}

async function main() {
  /* One launcher at a time: a second double-click just shows the first. */
  try {
    const base = `http://127.0.0.1:${PREFERRED_PORT}`;
    const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(800) });
    if ((await r.json()).app === APP_TAG) {
      console.log("  The launcher is already running — showing its window.");
      await fetch(`${base}/api/show`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => {});
      return;
    }
  } catch { /* none running */ }

  const portRef = { port: PREFERRED_PORT };
  const server = makeServer(portRef);
  try {
    portRef.port = await listen(server, PREFERRED_PORT);
  } catch {
    portRef.port = await listen(server, 0);
  }
  launcherUrl = `http://127.0.0.1:${portRef.port}/`;
  console.log(`  launcher: ${launcherUrl}`);
  getCheck(false).catch(() => {});   // warm the system check while the window opens
  showWindow();
  autoLaunch();

  const shutdown = () => {
    if (child) killTreeSync(child.pid);
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, shutdown);
  process.on("exit", () => { if (child) killTreeSync(child.pid); });
}

main().catch((e) => {
  console.error(`  launcher failed: ${e.message}`);
  process.exit(1);
});
