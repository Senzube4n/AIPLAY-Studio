/**
 * ROOM ON THE CARD FOR EVERYTHING ELSE (2026-09-27).
 *
 * Reported on an RX 9060 XT (16 GB, ROCm, Windows 11, two monitors): after a
 * long run of clips the AMD driver timed out and the second monitor flickered.
 * Windows logged it: LiveKernelEvent 141 (a GPU engine timeout) seven times in
 * two weeks, one of them escalating to bluescreen 0x116, and several landing
 * minutes into an H3 clip that then finished.
 *
 * Measured the same day with ComfyUI closed: the desktop already held 2.9 GB of
 * that card (Firefox 1.1 GB, the window manager 0.9 GB, Discord, launchers).
 * ComfyUI on Windows keeps back only 0.6 to 0.7 GB for other programs, and an
 * H3 clip put 14.1 GB on the card with 4.1 GB spilled to shared memory
 * (config.js video.freeBeforeClip). The two do not fit in 16 GB, so Windows
 * pages memory between the card and system RAM under a running render; the
 * window manager misses frames, and a GPU job stalled past Windows' 2-second
 * limit is a driver reset.
 *
 * Dynamic VRAM (comfy-aimdo) counts other programs' use through NVML, which
 * exists on NVIDIA only; on AMD and Intel it cannot see them. So at every
 * engine start, on Windows and a card that is not NVIDIA, this reads what the
 * other programs hold (Windows' "GPU Process Memory" counters, the numbers
 * Task Manager shows) and starts ComfyUI with --reserve-vram for that plus a
 * margin. The engine restart before each H3 clip reads it again, so a browser
 * that grew overnight is counted. A reserve chosen in the launcher's Advanced
 * settings wins; one the install's own flags carry (ComfyUI Desktop: 1.5 on
 * that PC) is kept unless the measured need is larger. settings.json
 * `comfyAutoReserve` "off" turns this off and "on" applies it on NVIDIA too.
 * Reports that match: ComfyUI #16502 (RX 9060 XT slowing after the first run),
 * comfy-aimdo #104 (RX 9070 XT desktop stalls at VAE decode, worse each run),
 * ROCm/TheRock #1320 (black screen on VRAM overflow; --reserve-vram helped).
 */
import { execFile } from "node:child_process";

/** Above what the other programs hold now: they grow while a render runs. */
export const RESERVE_MARGIN_GB = 1;
/** Never more than this, and never more than a quarter of the card. */
export const RESERVE_MAX_GB = 4;
/** ComfyUI's own reserve on Windows (model_management.py): below it, nothing to add. */
export const COMFY_DEFAULT_RESERVE_GB = 0.7;

/** Whether to measure at all. */
export function wantsAutoReserve({ mode = "auto", platform = process.platform, vendor = null } = {}) {
  if (mode === "off" || platform !== "win32") return false;
  return mode === "on" || vendor !== "nvidia";
}

/** Did the person choose a reserve in the launcher's Advanced settings? */
export function chosenReserve(options = {}) {
  const v = options?.reserveVram;
  return v !== undefined && v !== null && v !== "";
}

/** The reserve the install's own flags carry, in GB (ComfyUI Desktop adds
 * one: 1.5 on the PC above), or null. A larger measured need replaces it. */
export function installReserveGb(installFlags = [], useInstallFlags = true) {
  if (!useInstallFlags) return null;
  const f = (installFlags || []).map(String);
  const i = f.lastIndexOf("--reserve-vram");
  const n = i >= 0 ? Number(f[i + 1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Dedicated VRAM other processes hold, in MB, from the counter rows
 * `{ instance: "pid_123_luid_0x..._phys_0", bytes }`. Counted on the adapter
 * holding the most, which is the card the desktop and the engine share;
 * `excludePids` leaves out the engine itself when it is still running.
 */
export function othersDedicatedMb(rows, { excludePids = [] } = {}) {
  const skip = new Set(excludePids.map(Number));
  const byAdapter = new Map();
  for (const r of rows || []) {
    const m = /^pid_(\d+)_(luid_\w+?)_phys_\d+$/.exec(String(r?.instance || ""));
    const bytes = Number(r?.bytes);
    if (!m || !Number.isFinite(bytes) || bytes <= 0 || skip.has(Number(m[1]))) continue;
    byAdapter.set(m[2], (byAdapter.get(m[2]) || 0) + bytes);
  }
  if (!byAdapter.size) return null;
  return Math.round(Math.max(...byAdapter.values()) / 1024 / 1024);
}

/** The --reserve-vram value in GB, or null when ComfyUI's own is enough. */
export function autoReserveGb({ othersMb, totalMb } = {}) {
  if (!Number.isFinite(othersMb) || othersMb <= 0) return null;
  const cardGb = Number(totalMb) / 1024;
  const cap = Number.isFinite(cardGb) && cardGb > 0 ? Math.min(RESERVE_MAX_GB, cardGb / 4) : RESERVE_MAX_GB;
  const gb = Math.min(cap, othersMb / 1024 + RESERVE_MARGIN_GB);
  if (gb <= COMFY_DEFAULT_RESERVE_GB) return null;
  return Math.round(gb * 10) / 10;
}

/** Windows' per-process dedicated GPU memory, or null where it cannot be read. */
export function readGpuProcessMemory({ timeoutMs = 10_000 } = {}) {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = "(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples"
    + " | Where-Object { $_.CookedValue -gt 0 } | ForEach-Object { $_.InstanceName + ' ' + [int64]$_.CookedValue }";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const rows = String(stdout).split(/\r?\n/).map((l) => l.trim().split(/\s+/))
          .filter((p) => p.length === 2).map(([instance, bytes]) => ({ instance, bytes: Number(bytes) }));
        resolve(rows.length ? rows : null);
      });
  });
}

/**
 * The launch option to lay over this engine start (`{ reserveVram }`, as the
 * launcher's Advanced setting would, so it replaces the install's own flag),
 * and the sentence for the log. Never saved, and never throws: a machine
 * where the counters cannot be read starts as before.
 */
export async function desktopReserve({ mode, vendor, totalMb, options, installFlags, useInstallFlags,
  excludePids = [], read = readGpuProcessMemory, platform = process.platform } = {}) {
  const none = { values: {}, said: null };
  if (!wantsAutoReserve({ mode, platform, vendor }) || chosenReserve(options)) return none;
  let rows = null;
  try { rows = await read(); } catch { rows = null; }
  const othersMb = othersDedicatedMb(rows, { excludePids });
  const gb = autoReserveGb({ othersMb, totalMb });
  const install = installReserveGb(installFlags, useInstallFlags);
  if (gb === null || (install !== null && install >= gb)) return { ...none, othersMb };
  return {
    values: { reserveVram: gb }, othersMb, gb,
    said: `other programs hold ${(othersMb / 1024).toFixed(1)} GB of the card; reserving ${gb} GB for them`
      + (install !== null ? ` (the install's own flag said ${install})` : ""),
  };
}
