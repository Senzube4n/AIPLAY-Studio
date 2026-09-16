#!/usr/bin/env node
/**
 * INSTALL A PRIVATE COMFYUI FOR STUDIO — for a machine that has none.
 *
 *   node scripts/install-engine.mjs --backend nvidia|amd|intel|cpu [--gpu-name "<card>"]
 *
 * Studio normally drives a ComfyUI you already have and never touches it. This
 * runs only when you ask (the launcher's "What should Studio run on?" card),
 * and only into a folder Studio owns:
 *
 *   <app data>\engine\            (or AIPLAY_ENGINE_DIR)
 *     ComfyUI\                    the latest ComfyUI release
 *     venv\                       its python environment
 *     python\                     the python that venv was made from
 *     .aiplay-engine.json         marker: this folder is Studio's to replace
 *
 * WHAT IT RUNS is ComfyUI's own manual-install instructions, read out of the
 * README of the ComfyUI it just downloaded, so a new torch / ROCm / CUDA line
 * upstream is followed without a Studio update (the constants below are only
 * the fallback). Python comes from uv (astral-sh/uv), which fetches a standalone
 * interpreter, so no system Python is needed.
 *
 * ON FAILURE it deletes everything it made — the engine folder and its download
 * cache — and exits 1 with the exact error, so the next attempt starts clean.
 * It refuses to delete or reuse a folder without its own marker.
 *
 * Output: plain log lines, plus machine lines the launcher reads:
 *   @@step {"id":"torch","label":"Installing PyTorch","n":5,"of":9}
 *   @@done {"rig":"…","python":"…","backend":"amd","torch":"2.13.0+rocm10.0.0"}
 *   @@error {"message":"…","step":"torch"}
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, rename, readdir, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const run = promisify(execFile);
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };

const BACKEND = String(arg("backend") || "").toLowerCase();
const GPU_NAME = arg("gpu-name") || "";
const APPDATA = process.env.AIPLAY_APPDATA || path.join(homedir(), ".aiplay-studio");
const ROOT = path.resolve(process.env.AIPLAY_ENGINE_DIR || path.join(APPDATA, "engine"));
const CACHE = `${ROOT}-cache`;
const SETTINGS = path.join(APPDATA, "settings.json");
const MARKER = path.join(ROOT, ".aiplay-engine.json");
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

const STEPS = [
  ["space", "Checking disk space"],
  ["uv", "Getting the Python installer"],
  ["comfy", "Downloading ComfyUI"],
  ["python", "Installing Python"],
  ["torch", "Installing PyTorch"],
  ["deps", "Installing ComfyUI's requirements"],
  ["verify", "Checking PyTorch can see the hardware"],
  ["test", "Test-starting ComfyUI"],
  ["save", "Saving settings"],
];
let current = "start";
const log = (s) => process.stdout.write(`${s}\n`);
function step(id) {
  current = id;
  const n = STEPS.findIndex(([k]) => k === id);
  log(`@@step ${JSON.stringify({ id, label: STEPS[n][1], n: n + 1, of: STEPS.length })}`);
  log(`\n== ${STEPS[n][1]} ==`);
}

/* ── the commands ComfyUI's README gives, with today's text as the fallback ── */

const FALLBACK = {
  nvidia: "pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130",
  nvidiaOld: "pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu126",
  amdWin: 'pip install --index-url https://stable.repo.amd.com/rocm/whl-next/ "torch[device-all]==2.13.0+rocm10.0.0" "torchvision[device-all]==0.28.0+rocm10.0.0" "torchaudio==2.11.0.2+rocm10.0.0"',
  amdLinux: "pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm7.2",
  intel: "pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/xpu",
  cpu: MAC ? "pip install torch torchvision torchaudio"
    : "pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu",
};

/** The first stable `pip install` line under a README heading. */
function readmeCommand(readme, heading) {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && heading.test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) break;
    const m = lines[i].match(/(pip install [^`]+)/);
    if (m && !/--pre\b|nightly/.test(m[1])) return m[1].trim();
  }
  return null;
}

/** AMD on Windows: the README's GPU → device-extra table, so an RX 9060 XT
 *  downloads its own kernels rather than every supported card's. */
function amdDeviceExtra(readme, gpuName) {
  if (!gpuName) return null;
  const name = gpuName.toLowerCase();
  for (const row of readme.split(/\r?\n/)) {
    const m = row.match(/^\|\s*([^|]+?)\s*\|\s*`(device-[a-z0-9]+)`\s*\|/i);
    if (!m) continue;
    const nums = m[1].match(/\d{3,4}/g) || [];
    if (nums.some((n) => new RegExp(`\\b${n}\\b`).test(name))) return m[2];
    if (/strix halo|ai max/i.test(m[1]) && /ai max|strix|8060s|8050s/i.test(name)) return m[2];
  }
  return null;
}

/** "pip install a "b c"" → ["a", "b c"] */
function pipArgs(cmd) {
  return (cmd.replace(/^pip install\s+/, "").match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ""));
}

const OLD_NVIDIA = /\b(gtx\s*(9\d\d|10\d\d)|titan\s*(x|xp)\b|quadro\s*[pkm]\d|tesla\s*[pkm]\d)/i;

function torchCommand(readme) {
  if (BACKEND === "nvidia") {
    if (OLD_NVIDIA.test(GPU_NAME)) return { cmd: FALLBACK.nvidiaOld, python: "3.12", why: "older NVIDIA card: CUDA 12.6 build" };
    return { cmd: readmeCommand(readme, /NVIDIA/i) || FALLBACK.nvidia, python: "3.13" };
  }
  if (BACKEND === "amd") {
    if (!WIN) return { cmd: readmeCommand(readme, /AMD GPUs \(Linux\)/i) || FALLBACK.amdLinux, python: "3.13" };
    let cmd = readmeCommand(readme, /AMD GPUs \(Windows/i) || FALLBACK.amdWin;
    const extra = amdDeviceExtra(readme, GPU_NAME);
    if (extra) cmd = cmd.replaceAll("device-all", extra);
    return { cmd, python: "3.13", why: extra ? `kernels for this card only (${extra})` : "kernels for every supported AMD card" };
  }
  if (BACKEND === "intel") return { cmd: readmeCommand(readme, /Intel GPUs/i) || FALLBACK.intel, python: "3.13" };
  return { cmd: FALLBACK.cpu, python: "3.13" };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function download(url, file, label) {
  log(`Downloading ${label}: ${url}`);
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "AIPLAY-Studio-installer" } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, shown = -1;
  /* Counted in a transform inside the pipeline. A 'data' listener on the source
   * starts it flowing before the pipe is attached and loses the first chunks —
   * measured: a truncated uv zip that tar could not open. */
  const count = new Transform({
    transform(c, _enc, cb) {
      got += c.length;
      const pct = total ? Math.floor((got / total) * 10) * 10 : -1;
      if (pct !== shown && pct >= 0) { shown = pct; log(`  ${label}: ${pct}% of ${(total / 1048576).toFixed(0)} MB`); }
      cb(null, c);
    },
  });
  await mkdir(path.dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), count, createWriteStream(file));
  if (total && got !== total) throw new Error(`Download of ${label} was incomplete (${got} of ${total} bytes): ${url}`);
  if (!total) log(`  ${label}: ${(got / 1048576).toFixed(0)} MB`);
}

/** Windows' own bsdtar reads .zip and .tar.gz; Git's GNU tar earlier on PATH does not. */
async function extract(archive, dest) {
  await mkdir(dest, { recursive: true });
  const tar = WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  await run(tar, ["-xf", archive, "-C", dest], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** Run a command, streaming its output; the last lines of it are the error. */
function exec(cmd, args, { cwd, env, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    log(`> ${path.basename(cmd)} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    const tail = [];
    let lastPct = -1;
    const onLine = (line) => {
      if (!line.trim()) return;
      /* pip --progress-bar raw: "Progress 12345 of 67890" → one line per 10%. */
      const p = line.match(/^Progress (\d+) of (\d+)/);
      if (p) {
        const pct = Math.floor((Number(p[1]) / Number(p[2])) * 10) * 10;
        if (pct !== lastPct) { lastPct = pct; log(`  download ${pct}% of ${(Number(p[2]) / 1048576).toFixed(0)} MB`); }
        return;
      }
      lastPct = -1;
      log(line);
      tail.push(line);
      if (tail.length > 25) tail.shift();
    };
    for (const s of [child.stdout, child.stderr]) {
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        parts.forEach(onLine);
      });
      s.on("end", () => { if (buf) onLine(buf); });
    }
    const timer = timeoutMs ? setTimeout(() => { child.kill(); }, timeoutMs) : null;
    child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve();
      const why = signal ? `was stopped (${signal})` : `exited with code ${code}`;
      const err = new Error(`${path.basename(cmd)} ${why}.\n${tail.slice(-12).join("\n")}`);
      reject(err);
    });
  });
}

function uvAsset() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (WIN) return `uv-${arch}-pc-windows-msvc.zip`;
  if (MAC) return `uv-${arch}-apple-darwin.tar.gz`;
  return `uv-${arch}-unknown-linux-gnu.tar.gz`;
}

async function findFile(dir, name) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = await findFile(p, name); if (hit) return hit; }
  }
  return null;
}

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf-8")); } catch { return null; } }

/* ── the install ─────────────────────────────────────────────────────────── */

async function install() {
  if (!["nvidia", "amd", "intel", "cpu"].includes(BACKEND)) {
    throw new Error("Choose what to run on: --backend nvidia, amd, intel or cpu.");
  }
  const CACHE_MARK = path.join(CACHE, ".aiplay-engine-cache");
  if (existsSync(ROOT) && !existsSync(MARKER) && (await readdir(ROOT)).length) {
    throw new Error(`${ROOT} already exists and was not made by this installer, so it was left alone. Move it, or set AIPLAY_ENGINE_DIR to another folder.`);
  }
  /* A previous attempt that did not finish: start from nothing. */
  if (existsSync(MARKER) && (await readJson(MARKER))?.complete !== true) await clean();
  if ((await readJson(MARKER))?.complete === true) {
    log(`An engine installed by Studio is already at ${ROOT}; replacing it.`);
    await clean();
  }
  await mkdir(ROOT, { recursive: true });
  await writeFile(MARKER, JSON.stringify({ backend: BACKEND, complete: false, startedAt: new Date().toISOString() }, null, 2));
  await mkdir(CACHE, { recursive: true });
  await writeFile(CACHE_MARK, "made by scripts/install-engine.mjs; safe to delete");
  log(`Installing a private ComfyUI for Studio (${BACKEND.toUpperCase()}${GPU_NAME ? `, ${GPU_NAME}` : ""})`);
  log(`Folder: ${ROOT}`);

  step("space");
  const need = BACKEND === "cpu" ? 6 : 16;
  try {
    const fs = await statfs(ROOT);
    const free = (fs.bavail * fs.bsize) / 1024 ** 3;
    log(`${free.toFixed(1)} GB free; about ${need} GB needed.`);
    if (free < need) throw new Error(`Not enough disk space: ${free.toFixed(1)} GB free on the drive holding ${ROOT}, about ${need} GB needed. Free some space, or set AIPLAY_ENGINE_DIR to a folder on a bigger drive.`);
  } catch (e) { if (/Not enough disk space/.test(e.message)) throw e; log(`(could not read free space: ${e.message})`); }

  step("uv");
  const uvArchive = path.join(CACHE, uvAsset());
  await download(`https://github.com/astral-sh/uv/releases/latest/download/${uvAsset()}`, uvArchive, "uv");
  await extract(uvArchive, path.join(CACHE, "uv"));
  const uv = await findFile(path.join(CACHE, "uv"), WIN ? "uv.exe" : "uv");
  if (!uv) throw new Error("The uv download did not contain the uv program.");
  const uvEnv = { UV_PYTHON_INSTALL_DIR: path.join(ROOT, "python"), UV_CACHE_DIR: path.join(CACHE, "uv-cache"), UV_NO_CONFIG: "1" };

  step("comfy");
  let tag = null;
  try {
    const r = await fetch("https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest",
      { headers: { "User-Agent": "AIPLAY-Studio-installer", Accept: "application/vnd.github+json" } });
    if (r.ok) tag = (await r.json()).tag_name || null;
  } catch { /* fall back to the main branch */ }
  const srcUrl = tag
    ? `https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/${tag}.tar.gz`
    : "https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.tar.gz";
  log(tag ? `Latest ComfyUI release: ${tag}` : "Could not read the latest release; using the main branch.");
  const srcArchive = path.join(CACHE, "comfyui.tar.gz");
  await download(srcUrl, srcArchive, "ComfyUI");
  const unpack = path.join(CACHE, "comfyui-src");
  await extract(srcArchive, unpack);
  const top = (await readdir(unpack))[0];
  await rename(path.join(unpack, top), path.join(ROOT, "ComfyUI"));
  const comfyDir = path.join(ROOT, "ComfyUI");
  if (!existsSync(path.join(comfyDir, "main.py"))) throw new Error("The ComfyUI download has no main.py.");
  const readme = await readFile(path.join(comfyDir, "README.md"), "utf-8").catch(() => "");
  const plan = torchCommand(readme);

  step("python");
  const venv = path.join(ROOT, "venv");
  await exec(uv, ["python", "install", plan.python], { env: uvEnv });
  await exec(uv, ["venv", "--seed", "--python", plan.python, venv], { env: uvEnv });
  const py = WIN ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  if (!existsSync(py)) throw new Error(`The python environment was not created at ${venv}.`);
  const pipEnv = {
    PIP_CACHE_DIR: path.join(CACHE, "pip"), PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1",
  };
  const pip = (args) => exec(py, ["-m", "pip", "install", "--progress-bar", "raw", ...args], { env: pipEnv, cwd: comfyDir });

  step("torch");
  log(`Using: ${plan.cmd}${plan.why ? `  (${plan.why})` : ""}`);
  /* AIPLAY_ENGINE_TORCH_CMD replaces the command — for a card the README does
   * not cover, and for testing the failure path. */
  await pip(pipArgs(process.env.AIPLAY_ENGINE_TORCH_CMD || plan.cmd));

  step("deps");
  await pip(["-r", path.join(comfyDir, "requirements.txt")]);

  step("verify");
  const probe = [
    "import json, torch",
    "v = torch.version",
    "hip = getattr(v, 'hip', None) or getattr(v, 'rocm', None)",
    "xpu = hasattr(torch, 'xpu') and torch.xpu.is_available()",
    "mps = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()",
    "cuda = torch.cuda.is_available()",
    "name = torch.cuda.get_device_name(0) if cuda else (torch.xpu.get_device_name(0) if xpu else '')",
    "print('@@probe ' + json.dumps({'version': torch.__version__, 'backend': 'rocm' if hip else 'cuda' if v.cuda else 'xpu' if xpu else 'cpu', 'gpu': cuda or xpu or mps, 'name': name}))",
  ].join("\n");
  let probed = null;
  const out = await run(py, ["-s", "-c", probe], { env: { ...process.env, ...pipEnv }, timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    .catch((e) => { throw new Error(`PyTorch was installed but does not import:\n${String(e.stderr || e.message).trim().split("\n").slice(-12).join("\n")}`); });
  for (const l of out.stdout.split(/\r?\n/)) if (l.startsWith("@@probe ")) probed = JSON.parse(l.slice(8));
  if (!probed) throw new Error("PyTorch did not report its build.");
  log(`torch ${probed.version} (${probed.backend})${probed.name ? ` sees ${probed.name}` : ""}`);
  if (BACKEND !== "cpu" && !probed.gpu) {
    const hint = BACKEND === "nvidia" ? "Update the NVIDIA driver (CUDA 13 needs a 580-series driver or newer), then try again — or choose CPU."
      : BACKEND === "amd" ? "Update the AMD Adrenalin driver and use Windows 11 (or a ROCm-supported Linux), then try again — or choose CPU. RX 6000-series and older cards may not be supported by ROCm."
        : "Update the Intel Arc driver, then try again — or choose CPU.";
    throw new Error(`PyTorch ${probed.version} installed, but it cannot see a ${BACKEND.toUpperCase()} graphics card. ${hint}${out.stderr ? `\n${out.stderr.trim().split("\n").slice(-6).join("\n")}` : ""}`);
  }

  step("test");
  const flags = BACKEND === "cpu" && !MAC ? ["--cpu"] : [];
  await exec(py, ["-s", "main.py", "--quick-test-for-ci", "--disable-auto-launch", ...flags],
    { cwd: comfyDir, env: pipEnv, timeoutMs: 600_000 });

  step("save");
  const cur = (await readJson(SETTINGS)) || {};
  const gpu = cur.gpu && cur.gpu.vendor === BACKEND ? cur.gpu
    : BACKEND === "cpu" ? null
      : { vendor: BACKEND, name: probed.name || GPU_NAME || BACKEND.toUpperCase(), totalMb: cur.gpu?.totalMb || 0, source: "chosen at install" };
  const next = {
    ...cur, rig: ROOT, python: py,
    torchBackend: probed.backend, torchVersion: probed.version,
    comfyExtraArgs: flags, launchFrom: `Studio's own ComfyUI (${tag || "main"}, ${BACKEND})`,
    engineInstall: { backend: BACKEND, comfy: tag || "main", torch: probed.version, at: new Date().toISOString() },
  };
  if (gpu) next.gpu = gpu; else if (BACKEND === "cpu") next.gpu = { vendor: "cpu", name: "CPU only", totalMb: 0, source: "chosen at install" };
  await mkdir(APPDATA, { recursive: true });
  await writeFile(SETTINGS, JSON.stringify(next, null, 2));
  await writeFile(MARKER, JSON.stringify({ backend: BACKEND, complete: true, comfy: tag, torch: probed.version, finishedAt: new Date().toISOString() }, null, 2));
  /* The download cache is gigabytes of wheels nobody needs again. */
  await rm(CACHE, { recursive: true, force: true }).catch(() => {});
  log(`\nDone. ComfyUI ${tag || "(main)"} with torch ${probed.version} is ready at ${ROOT}.`);
  log(`@@done ${JSON.stringify({ rig: ROOT, python: py, backend: BACKEND, torch: probed.version, comfy: tag })}`);
}

/** Remove what this installer made — only ever a folder carrying its marker. */
async function clean() {
  if (existsSync(ROOT) && existsSync(MARKER)) await rm(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  if (existsSync(path.join(CACHE, ".aiplay-engine-cache"))) await rm(CACHE, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}

/* --plan <README.md>: print which PyTorch command this backend and card would
 * get from that README, and install nothing. */
if (process.argv.includes("--plan")) {
  const readme = await readFile(arg("plan"), "utf-8");
  log(JSON.stringify({ backend: BACKEND, gpu: GPU_NAME, ...torchCommand(readme), args: pipArgs(torchCommand(readme).cmd) }));
  process.exit(0);
}

try {
  await install();
  process.exit(0);
} catch (e) {
  const message = String(e?.message || e).trim();
  log(`\nFAILED at "${current}": ${message}`);
  let cleaned = true;
  try { await clean(); log("Removed the partial install and its download cache."); }
  catch (c) { cleaned = false; log(`Could not fully remove the partial install: ${c.message}`); }
  log(`@@error ${JSON.stringify({ message, step: current, cleaned })}`);
  process.exit(1);
}
