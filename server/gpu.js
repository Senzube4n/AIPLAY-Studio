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
 */
import { spawn } from "node:child_process";
import os from "node:os";

const QUERY = "name,memory.total,memory.used,utilization.gpu";
const MIN_GAP_MS = 3000;

let cached = null;
let lastAt = 0;
let inflight = false;

function read() {
  return new Promise((resolve) => {
    let out = "";
    let proc;
    try {
      proc = spawn("nvidia-smi", [`--query-gpu=${QUERY}`, "--format=csv,noheader,nounits"]);
    } catch {
      return resolve(null);
    }
    proc.stdout.on("data", (d) => (out += d));
    proc.on("error", () => resolve(null));
    proc.on("exit", (code) => {
      if (code !== 0) return resolve(null);
      const [name, total, used, util] = out.split("\n")[0].split(",").map((s) => s.trim());
      if (!total) return resolve(null);
      resolve({
        name,
        totalMb: Number(total),
        usedMb: Number(used),
        utilPct: Number(util),
        // Stated plainly so the UI cannot imply more precision than exists.
        note: "Driver-reported. PyTorch holds freed blocks, so this reads high.",
      });
    });
  });
}

/** Never blocks a request: returns the last reading and refreshes behind it. */
export function gpuStatus() {
  const now = Date.now();
  if (!inflight && now - lastAt > MIN_GAP_MS) {
    inflight = true;
    read().then((r) => {
      if (r) cached = r;
      lastAt = Date.now();
      inflight = false;
    });
  }
  return cached;
}

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
