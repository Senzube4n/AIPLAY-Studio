/**
 * ROOM ON THE CARD FOR EVERYTHING ELSE (server/vramreserve.js): on Windows
 * with an AMD or Intel card, the engine starts with --reserve-vram for what
 * the desktop and other programs hold, measured at that start.
 *
 *   node --test server/vramreserve_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoReserveGb, chosenReserve, desktopReserve, installReserveGb, othersDedicatedMb,
  wantsAutoReserve, RESERVE_MAX_GB } from "./vramreserve.js";
import { buildLaunchArgs } from "./comfyargs.js";

const MB = 1024 * 1024;
const row = (pid, mb, luid = "luid_0x00000000_0x00010e91") => ({ instance: `pid_${pid}_${luid}_phys_0`, bytes: mb * MB });

test("measured where Dynamic VRAM cannot see other programs: Windows, not NVIDIA", () => {
  assert.equal(wantsAutoReserve({ platform: "win32", vendor: "amd" }), true);
  assert.equal(wantsAutoReserve({ platform: "win32", vendor: "intel" }), true);
  assert.equal(wantsAutoReserve({ platform: "win32", vendor: "nvidia" }), false, "NVML already counts them");
  assert.equal(wantsAutoReserve({ platform: "linux", vendor: "amd" }), false, "no WDDM paging there");
  assert.equal(wantsAutoReserve({ platform: "win32", vendor: "nvidia", mode: "on" }), true);
  assert.equal(wantsAutoReserve({ platform: "win32", vendor: "amd", mode: "off" }), false);
});

test("other programs are summed on the busiest adapter, the engine left out", () => {
  const rows = [row(1, 1097), row(2, 944), row(3, 424), row(4, 5, "luid_0x00000000_0x000131ad"), row(9, 12000)];
  assert.equal(othersDedicatedMb(rows, { excludePids: [9] }), 1097 + 944 + 424);
  assert.equal(othersDedicatedMb([{ instance: "garbage", bytes: 5 }]), null);
  assert.equal(othersDedicatedMb(null), null);
});

test("the reserve: what they hold plus a margin, capped, and nothing below ComfyUI's own", () => {
  assert.equal(autoReserveGb({ othersMb: 2930, totalMb: 16304 }), 3.9);
  assert.equal(autoReserveGb({ othersMb: 3567, totalMb: 16304 }), RESERVE_MAX_GB, "capped");
  assert.equal(autoReserveGb({ othersMb: 3000, totalMb: 8192 }), 2, "a quarter of a small card at most");
  assert.equal(autoReserveGb({ othersMb: null, totalMb: 16304 }), null);
});

test("the person's own reserve wins; the install's is replaced only by a larger need", async () => {
  assert.equal(chosenReserve({ reserveVram: 2 }), true);
  assert.equal(chosenReserve({}), false);
  assert.equal(installReserveGb(["--use-ck-attention", "--reserve-vram", "1.5"]), 1.5);
  assert.equal(installReserveGb(["--reserve-vram", "1.5"], false), null, "install flags turned off");
  const read = async () => [row(1, 2930)];
  const base = { platform: "win32", vendor: "amd", totalMb: 16304, read };
  assert.deepEqual((await desktopReserve({ ...base, installFlags: ["--reserve-vram", "1.5"] })).values, { reserveVram: 3.9 });
  assert.deepEqual((await desktopReserve({ ...base, installFlags: ["--reserve-vram", "6"] })).values, {});
  assert.deepEqual((await desktopReserve({ ...base, options: { reserveVram: 1 } })).values, {});
  assert.deepEqual((await desktopReserve({ ...base, read: async () => { throw new Error("no counters"); } })).values, {},
    "a machine where the counters cannot be read starts as before");
});

test("laid over the install's flag as one --reserve-vram, the person's choices still on top", () => {
  const args = buildLaunchArgs({ tierFlags: ["--async-offload", "4"], installFlags: ["--reserve-vram", "1.5"],
    values: { reserveVram: 3.9 } });
  assert.deepEqual(args.filter((a) => a === "--reserve-vram").length, 1);
  assert.equal(args[args.indexOf("--reserve-vram") + 1], "3.9");
  const comfy = readFileSync(new URL("./comfy.js", import.meta.url), "utf8");
  assert.match(comfy, /values: \{ \.\.\.measured, \.\.\.effectiveValues\(/, "measured under the person's own values");
  assert.match(comfy, /\.\.\.studioLaunchArgs\(this\.flags \?\? config\.comfy\.flags, reserve\.values\),/);
  assert.ok(comfy.indexOf("await desktopReserve(") < comfy.indexOf("engine.reservePort()"), "read before the port is reserved");
});
