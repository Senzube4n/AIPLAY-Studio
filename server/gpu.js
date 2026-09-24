/**
 * GPU readout.
 *
 * ⚠ READ BEFORE TRUSTING THE NUMBER. `memory.used` is what the DRIVER has handed
 * out, and PyTorch's caching allocator keeps blocks it is no longer using. So
 * "used" is an upper bound on what is needed, not a measurement of it — a run
 * showing 12 GB may only require 8. An earlier round of VRAM tier claims was
 * withdrawn for exactly this reason.
 *
 * What it IS good for: spotting that something else (a game, a browser, another
 * model) is eating the card, and showing which tier the user actually has.
 *
 * Polled on a timer rather than per request — nvidia-smi costs ~40 ms and the
 * status endpoint is hit every four seconds by every open tab.
 *
 * NOT NVIDIA. nvidia-smi does not exist for AMD (ROCm) or Intel cards. Those
 * are read from what the operating system itself keeps:
 *
 *   WINDOWS   server/gpu-win.ps1, one long-lived helper: DXGI names each
 *             adapter and its memory, and the "GPU Adapter Memory" / "GPU
 *             Engine" performance counters give memory in use and load, the
 *             same counters Task Manager's GPU page shows. Any vendor.
 *   LINUX     amdgpu's own files under /sys/class/drm (mem_info_vram_total,
 *             mem_info_vram_used, gpu_busy_percent). Intel on Linux has no
 *             such file and keeps the total-only reading below.
 *
 * Without either, the reading is TOTAL-only: the engine's own startup log
 * ("Total VRAM … MB", which torch reports on CUDA and ROCm alike), then the card
 * first-run setup recorded in settings.json. Used memory and utilisation stay
 * null there rather than being invented.
 *
 * ⚠ DISPLAY ONLY, ON PURPOSE. The free-VRAM gates that refuse to start a render
 * (YuE2's floor in music/yue.js, the 3D runner, native GGUF's settle) read
 * nvidia-smi through mesh/runner.js freeVramMb() and are left exactly as they
 * were: on AMD they have always answered "no reading, nothing to wait for", and
 * turning a new counter into a refusal on a machine that renders today would be
 * a regression. This module feeds the meter, the Models screen's machine line
 * and Collab's resource card.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const QUERY = "name,memory.total,memory.used,utilization.gpu";
const MIN_GAP_MS = 3000;

let cached = null;
let lastAt = 0;
let inflight = false;
/* nvidia-smi is not on this machine (the spawn could not find it). Asked once:
 * spawning a missing program every three seconds buys nothing. */
let smiMissing = false;
/** Set from the engine's startup log by comfy.js. */
let engineReading = null;

/** Called by the engine supervisor once torch has named the card. */
export function setGpuFallback(g) {
  if (g && Number(g.totalMb) > 0) engineReading = { ...g, totalMb: Number(g.totalMb) };
}

function fallback() {
  const g = engineReading || config.gpu;
  if (!g || !(Number(g.totalMb) > 0)) return null;
  return {
    name: g.name || "GPU",
    totalMb: Number(g.totalMb),
    usedMb: null,
    utilPct: null,
    vendor: g.vendor || config.gpu?.vendor || null,
    source: g.source || "settings.json",
    note: "Total only — nvidia-smi is not available for this card, so used memory is not read.",
  };
}

/* ── AMD, Intel, anything: what the operating system keeps ────────────────── */

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "gpu-win.ps1");
const HELPER_STALE_MS = 10_000;
let helper = null;          // the running gpu-win.ps1
let helperReading = null;   // { at, adapters: [...] }
let helperStarts = 0;

/* Off in unit tests (node --test marks its children) and on request, so a test
 * that touches the status never leaves a PowerShell running behind it. */
const helperAllowed = () => process.platform === "win32" && process.env.AIPLAY_GPU_HELPER !== "0"
  && !process.env.NODE_TEST_CONTEXT;

function startHelper() {
  if (helper || helperStarts >= 3 || !helperAllowed() || !existsSync(HELPER)) return;
  helperStarts++;
  let proc;
  try {
    proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER,
      "-IntervalMs", "2000", "-ParentPid", String(process.pid)], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return; }
  helper = proc;
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try {
        const j = JSON.parse(line);
        if (Array.isArray(j.adapters)) helperReading = { at: Date.now(), adapters: j.adapters };
      } catch { /* a torn line; the next one is two seconds away */ }
    }
  });
  const gone = () => { if (helper === proc) helper = null; };
  proc.on("error", gone);
  proc.on("exit", gone);
  /* Never what keeps Studio (or a test) alive. The helper also exits by itself
   * once this process is gone (-ParentPid). */
  proc.unref();
  proc.stdout.unref?.();
  process.once("exit", () => { try { proc.kill(); } catch { /* gone */ } });
}

/** The adapter Studio renders on: the one the engine or setup named, else the
 *  card with the most dedicated memory (the discrete card beside an iGPU). */
export function pickAdapter(adapters, wantName = "") {
  const real = (adapters || []).filter((a) => a && Number(a.totalMb) > 0);
  if (!real.length) return null;
  const want = String(wantName || "").toLowerCase().trim();
  if (want) {
    const hit = real.find((a) => { const n = String(a.name).toLowerCase(); return n.includes(want) || want.includes(n); });
    if (hit) return hit;
  }
  return real.slice().sort((a, b) => Number(b.totalMb) - Number(a.totalMb))[0];
}

/** A helper reading as a gpuStatus() row, or null when there is none or it is stale. */
export function fromAdapters(reading, wantName = "", now = Date.now()) {
  if (!reading || now - reading.at > HELPER_STALE_MS) return null;
  const a = pickAdapter(reading.adapters, wantName);
  if (!a) return null;
  const n = (v) => (v !== null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return {
    name: a.name,
    totalMb: Number(a.totalMb),
    usedMb: n(a.usedMb),
    utilPct: n(a.utilPct),
    vendor: a.vendor || null,
    source: "Windows GPU counters",
    note: "Driver-reported, the same counters Task Manager shows. PyTorch holds freed blocks, so this reads high.",
  };
}

/** amdgpu on Linux keeps the numbers in plain files. */
export function readAmdSysfs(root = "/sys/class/drm", name = "") {
  if (process.platform !== "linux" && root === "/sys/class/drm") return null;
  let cards = [];
  try { cards = readdirSync(root).filter((c) => /^card\d+$/.test(c)); } catch { return null; }
  let best = null;
  for (const c of cards) {
    const dev = path.join(root, c, "device");
    const num = (f) => { try { return Number(readFileSync(path.join(dev, f), "utf8").trim()); } catch { return NaN; } };
    const total = num("mem_info_vram_total");
    if (!(total > 0)) continue;
    const used = num("mem_info_vram_used"), busy = num("gpu_busy_percent");
    const row = { totalMb: Math.round(total / 1048576), usedMb: used >= 0 ? Math.round(used / 1048576) : null,
      utilPct: busy >= 0 ? busy : null };
    if (!best || row.totalMb > best.totalMb) best = row;
  }
  if (!best) return null;
  return { name: name || "AMD GPU", ...best, vendor: "amd", source: "amdgpu (sysfs)",
    note: "Driver-reported. PyTorch holds freed blocks, so this reads high." };
}

/** The best reading without nvidia-smi: the OS's own, else total-only. */
function noSmi() {
  startHelper();
  const want = (engineReading || config.gpu)?.name || "";
  return fromAdapters(helperReading, want) || readAmdSysfs(undefined, want) || fallback();
}

function read() {
  if (smiMissing) return Promise.resolve(noSmi());
  return new Promise((resolve) => {
    let out = "";
    let proc;
    try {
      proc = spawn("nvidia-smi", [`--query-gpu=${QUERY}`, "--format=csv,noheader,nounits"], { windowsHide: true });
    } catch {
      smiMissing = true;
      return resolve(noSmi());
    }
    proc.stdout.on("data", (d) => (out += d));
    proc.on("error", (e) => { if (e?.code === "ENOENT") smiMissing = true; resolve(noSmi()); });
    proc.on("exit", (code) => {
      if (code !== 0) return resolve(noSmi());
      const [name, total, used, util] = out.split("\n")[0].split(",").map((s) => s.trim());
      if (!total) return resolve(noSmi());
      resolve({
        name,
        totalMb: Number(total),
        usedMb: Number(used),
        utilPct: Number(util),
        vendor: "nvidia",
        source: "nvidia-smi",
        // Stated plainly so the UI cannot imply more precision than exists.
        note: "Driver-reported. PyTorch holds freed blocks, so this reads high.",
      });
    });
  });
}

/** Never blocks a request: returns the last reading and refreshes behind it. */
let pending = null;
export function gpuStatus() {
  const now = Date.now();
  if (!inflight && now - lastAt > MIN_GAP_MS) {
    inflight = true;
    pending = read().then((r) => {
      if (r) cached = r;
      lastAt = Date.now();
      inflight = false;
    });
  }
  return cached;
}

/**
 * THE FIRST READING, WAITED FOR. gpuStatus() answers null until nvidia-smi
 * (or the AMD read) has come back once, about 2.5 s after start, and a
 * decision taken in that window treats every card as no card: the defaults
 * (server/fit.js defaultFor) picked native GGUF on NVIDIA and the int8 YuE2
 * build on AMD. Resolves with the reading, or null for a machine with no card
 * once the read has finished; never waits longer than `maxMs`. Instant after
 * the first read.
 */
export function gpuFirstReading(maxMs = 8000) {
  gpuStatus();
  if (lastAt) return Promise.resolve(cached);
  return Promise.race([
    (pending || Promise.resolve()).then(() => cached),
    new Promise((resolve) => setTimeout(() => resolve(cached), maxMs).unref?.()),
  ]);
}
/** Whether the first reading has finished (a null gpuStatus() then means no card). */
export const gpuReadOnce = () => lastAt > 0;

/**
 * System memory, alongside the card.
 *
 * Worth showing next to VRAM rather than instead of it, because on this engine
 * the two are directly coupled: every `--lowvram` tier works by keeping less of
 * the model resident and STREAMING the rest from system RAM. So a machine that
 * is short on RAM is slow for a completely different reason than one short on
 * VRAM, and the VRAM bar alone cannot tell those apart.
 *
 * `os.freemem()` on Windows reports genuinely free pages and ignores the file
 * cache, so it reads pessimistically — the note says so rather than dressing it
 * up. No child process here: this is a couple of syscalls, unlike nvidia-smi.
 */
export function ramStatus() {
  const totalMb = Math.round(os.totalmem() / 1048576);
  const freeMb = Math.round(os.freemem() / 1048576);
  return {
    totalMb,
    usedMb: totalMb - freeMb,
    note: "System RAM. The low-VRAM tiers stream model weights from here, so "
        + "headroom matters as much as the card.",
  };
}

/* ── the processor ────────────────────────────────────────────────────────
 *
 * The rail shows VRAM and system RAM because both explain "why is this slow".
 * The CPU is the third answer, and on the CPU builds (audio.cpp without a
 * usable card, ffmpeg, Demucs) it is the ONLY one.
 *
 * `os.loadavg()` is always 0 on Windows, so the figure comes from the busy /
 * idle split of `os.cpus()` DIFFERENCED between calls: the absolute numbers are
 * totals since boot, which say nothing about now. The first call has nothing to
 * difference against and reports null rather than a made-up number. No child
 * process: this is one syscall, unlike nvidia-smi.
 */
let cpuMark = null;
export function cpuStatus() {
  const cores = os.cpus() || [];
  const sum = cores.reduce((acc, c) => {
    for (const [k, v] of Object.entries(c.times || {})) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});
  const total = Object.values(sum).reduce((a, b) => a + b, 0);
  const idle = sum.idle || 0;
  const was = cpuMark;
  cpuMark = { total, idle };
  const dTotal = was ? total - was.total : 0;
  const dIdle = was ? idle - was.idle : 0;
  return {
    cores: cores.length,
    model: cores[0]?.model?.trim() || null,
    /* Between two polls with no time in between there is nothing to measure;
     * null means "not yet", which the bar draws as empty rather than as 0%. */
    percent: dTotal > 0 ? Math.min(100, Math.max(0, Math.round((1 - dIdle / dTotal) * 100))) : null,
    note: `${cores.length} logical core${cores.length === 1 ? "" : "s"}. Busy since the last reading, `
        + "not since boot. The CPU builds (audio.cpp with no usable card, ffmpeg, stem splitting) live here.",
  };
}
