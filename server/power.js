/**
 * BATTERY SAFE — notice when the machine is running on a battery, and stop the
 * graphics card from draining it.
 *
 * A generation takes the whole machine, and people leave them running all
 * night. When the mains goes out, a laptop or a PC on a UPS keeps rendering
 * off the battery until it dies mid-write, and a file half written at that
 * moment is a corrupted file. So while a generation runs on battery a countdown
 * starts (5 minutes by default); when it runs out the work is stopped cleanly.
 * The person can say "keep generating on battery" at any point, and that
 * answer lasts until the power comes back.
 *
 * Where the reading comes from:
 *   Windows  GetSystemPowerStatus, via .NET's SystemInformation.PowerStatus in
 *            one long-lived PowerShell. A UPS on USB reports through the same
 *            call (Windows shows it as a battery), which is the point: that is
 *            the desktop whose power actually goes out.
 *   Linux    /sys/class/power_supply: a "Mains" supply that is online, or a
 *            battery that is discharging.
 *   macOS    `pmset -g batt`.
 * Anything that cannot be read is `known: false` and is treated as mains: an
 * unreadable sensor must never stop someone's work.
 */
import { spawn, execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const UNKNOWN = Object.freeze({ known: false, onBattery: false, hasBattery: false, percent: null });

/** One line of the Windows reader: `PowerLineStatus|BatteryChargeStatus|BatteryLifePercent`. */
export function parseWindows(line) {
  const [lineStatus, charge = "", pct = ""] = String(line || "").trim().split("|");
  if (!["Online", "Offline"].includes(lineStatus)) return { ...UNKNOWN };
  const hasBattery = !/NoSystemBattery|Unknown/i.test(charge);
  const f = Number(pct);
  /* 255 (reported as 2.55) means "unknown"; anything above 1 is not a fraction. */
  const percent = hasBattery && Number.isFinite(f) && f >= 0 && f <= 1 ? Math.round(f * 100) : null;
  return { known: true, onBattery: lineStatus === "Offline", hasBattery, percent };
}

/** Linux power supplies, each `{ type, online, status, capacity }` as read from sysfs. */
export function parseLinux(supplies) {
  const list = Array.isArray(supplies) ? supplies : [];
  const mains = list.filter((s) => /^(Mains|USB|USB_C|USB_PD)$/i.test(s.type || ""));
  const bats = list.filter((s) => /^Battery$/i.test(s.type || "") && !/^(Device)$/i.test(s.scope || ""));
  if (!mains.length && !bats.length) return { ...UNKNOWN };
  const onMains = mains.some((s) => String(s.online).trim() === "1");
  const discharging = bats.some((s) => /Discharging/i.test(s.status || ""));
  const caps = bats.map((s) => Number(s.capacity)).filter(Number.isFinite);
  return {
    known: true,
    onBattery: mains.length ? !onMains && bats.length > 0 : discharging,
    hasBattery: bats.length > 0,
    percent: caps.length ? Math.round(Math.min(...caps)) : null,
  };
}

/** `pmset -g batt` output. */
export function parseMac(text) {
  const t = String(text || "");
  const src = /drawing from '([^']+)'/i.exec(t)?.[1];
  if (!src) return { ...UNKNOWN };
  const pct = /(\d{1,3})%/.exec(t);
  return {
    known: true,
    onBattery: /battery/i.test(src),
    hasBattery: /InternalBattery|UPS|%/i.test(t),
    percent: pct ? Number(pct[1]) : null,
  };
}

/**
 * The decision, kept free of timers and processes so it can be tested.
 *
 * update() is called with the latest reading and whether anything is running,
 * and answers whether to stop now. The countdown starts only when a
 * generation is running on battery without the person's say-so, and is
 * forgotten the moment the power returns or the work ends.
 */
export class BatteryGuard {
  constructor() {
    this.consent = false;   // "keep generating on battery", until the mains returns
    this.deadline = null;   // ms timestamp the countdown runs out, or null
    this.lastStop = null;   // { at, what } of the last stop Battery Safe made
  }

  allow(on = true) {
    this.consent = !!on;
    if (this.consent) this.deadline = null;
  }

  update({ power, busy, enabled, graceMs, now = Date.now() }) {
    if (!power?.known || !power.onBattery) {
      this.consent = false;
      this.deadline = null;
      return { stop: false };
    }
    if (!enabled || this.consent || !busy) {
      this.deadline = null;
      return { stop: false };
    }
    if (this.deadline == null) this.deadline = now + Math.max(0, graceMs);
    if (now >= this.deadline) {
      this.deadline = null;
      return { stop: true };
    }
    return { stop: false };
  }

  noteStop(what, now = Date.now()) {
    this.lastStop = { at: now, what };
  }

  snapshot(now = Date.now()) {
    return {
      consent: this.consent,
      deadline: this.deadline,
      secondsLeft: this.deadline == null ? null : Math.max(0, Math.ceil((this.deadline - now) / 1000)),
      lastStop: this.lastStop,
    };
  }
}

/* ── the readers ─────────────────────────────────────────────────────────── */

function windowsReader(onReading, everySec) {
  /* One PowerShell for the life of the app rather than one per reading: a
   * PowerShell start costs a noticeable burst of CPU, and this runs all day.
   * It watches the Studio's own process and leaves when that is gone, so a
   * crash cannot strand it. */
  const script = [
    `$pp = ${process.pid}`,
    "Add-Type -AssemblyName System.Windows.Forms",
    "while ($true) {",
    "  if (-not (Get-Process -Id $pp -ErrorAction SilentlyContinue)) { exit }",
    "  $s = [System.Windows.Forms.SystemInformation]::PowerStatus",
    "  [Console]::Out.WriteLine(\"$($s.PowerLineStatus)|$($s.BatteryChargeStatus)|$($s.BatteryLifePercent)\")",
    "  [Console]::Out.Flush()",
    `  Start-Sleep -Seconds ${everySec}`,
    "}",
  ].join("\n");
  let child = null, stopped = false, restarts = 0, buf = "";
  const start = () => {
    child = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) onReading(parseWindows(line));
      }
    });
    child.on("error", () => {});
    child.on("exit", () => {
      child = null;
      /* A few restarts, then give up and say "unknown": a reader that keeps
       * dying must not become a process spawned every minute forever. */
      if (!stopped && restarts++ < 5) setTimeout(() => { if (!stopped) start(); }, 60_000).unref();
      else if (!stopped) onReading({ ...UNKNOWN });
    });
  };
  start();
  return () => { stopped = true; try { child?.kill(); } catch { /* already gone */ } };
}

async function readLinux(root = "/sys/class/power_supply") {
  const names = await readdir(root).catch(() => []);
  const read = (n, f) => readFile(path.join(root, n, f), "utf8").then((s) => s.trim()).catch(() => "");
  return parseLinux(await Promise.all(names.map(async (n) => ({
    type: await read(n, "type"), online: await read(n, "online"), status: await read(n, "status"),
    capacity: await read(n, "capacity"), scope: await read(n, "scope"),
  }))));
}

const readMac = () => new Promise((resolve) => {
  execFile("pmset", ["-g", "batt"], { timeout: 5000 }, (err, out) => resolve(err ? { ...UNKNOWN } : parseMac(out)));
});

/**
 * Start reading the power state every `everySec` seconds. Calls `onReading`
 * with `{ known, onBattery, hasBattery, percent }`; returns a stop function.
 */
export function watchPower(onReading, { everySec = 10, platform = process.platform } = {}) {
  if (platform === "win32") return windowsReader(onReading, everySec);
  const read = platform === "darwin" ? readMac : platform === "linux" ? readLinux : null;
  if (!read) { onReading({ ...UNKNOWN }); return () => {}; }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { onReading(await read()); } catch { onReading({ ...UNKNOWN }); } finally { busy = false; }
  };
  tick();
  const t = setInterval(tick, everySec * 1000);
  t.unref();
  return () => clearInterval(t);
}
