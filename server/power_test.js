/**
 * Battery Safe: the three platform readers and the countdown decision.
 * No processes, no timers: every case is a reading and a clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BatteryGuard, parseLinux, parseMac, parseWindows } from "./power.js";

test("Windows: mains, battery, a UPS, and a desktop with no battery", () => {
  assert.deepEqual(parseWindows("Online|High, Charging|1"), { known: true, onBattery: false, hasBattery: true, percent: 100 });
  assert.deepEqual(parseWindows("Offline|Low|0.23\r"), { known: true, onBattery: true, hasBattery: true, percent: 23 });
  // A UPS on USB reports exactly like a laptop battery.
  assert.equal(parseWindows("Offline|High|0.9").onBattery, true);
  assert.deepEqual(parseWindows("Online|NoSystemBattery|2.55"), { known: true, onBattery: false, hasBattery: false, percent: null });
  // Unreadable: treated as mains, never as a reason to stop.
  assert.equal(parseWindows("Unknown|Unknown|2.55").known, false);
  assert.equal(parseWindows("").onBattery, false);
});

test("Linux: mains online or not, and a battery alone", () => {
  assert.equal(parseLinux([{ type: "Mains", online: "1" }, { type: "Battery", status: "Charging", capacity: "80" }]).onBattery, false);
  const off = parseLinux([{ type: "Mains", online: "0" }, { type: "Battery", status: "Discharging", capacity: "41" }]);
  assert.deepEqual(off, { known: true, onBattery: true, hasBattery: true, percent: 41 });
  assert.equal(parseLinux([{ type: "Battery", status: "Discharging", capacity: "50" }]).onBattery, true);
  // A mouse battery (scope Device) is not the machine's.
  assert.equal(parseLinux([{ type: "Mains", online: "1" }, { type: "Battery", scope: "Device", status: "Discharging" }]).hasBattery, false);
  assert.equal(parseLinux([]).known, false);
});

test("macOS: pmset output", () => {
  const bat = parseMac("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t57%; discharging; 3:10 remaining");
  assert.deepEqual(bat, { known: true, onBattery: true, hasBattery: true, percent: 57 });
  assert.equal(parseMac("Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged").onBattery, false);
  assert.equal(parseMac("garbage").known, false);
});

const BAT = { known: true, onBattery: true, hasBattery: true, percent: 60 };
const AC = { known: true, onBattery: false, hasBattery: true, percent: 60 };

test("the countdown starts on battery while busy, and stops the work when it runs out", () => {
  const g = new BatteryGuard();
  const at = (now, extra = {}) => g.update({ power: BAT, busy: true, enabled: true, graceMs: 5 * 60_000, now, ...extra });
  assert.equal(at(0).stop, false);
  assert.equal(g.deadline, 5 * 60_000);
  assert.equal(g.snapshot(60_000).secondsLeft, 240);
  assert.equal(at(299_999).stop, false);
  assert.equal(at(300_000).stop, true);
  assert.equal(g.deadline, null);
});

test("no countdown when idle, when off, on mains, or with the person's go-ahead", () => {
  const g = new BatteryGuard();
  const base = { power: BAT, busy: true, enabled: true, graceMs: 1000 };
  assert.equal(g.update({ ...base, busy: false, now: 0 }).stop, false); assert.equal(g.deadline, null);
  assert.equal(g.update({ ...base, enabled: false, now: 0 }).stop, false); assert.equal(g.deadline, null);
  assert.equal(g.update({ ...base, power: AC, now: 0 }).stop, false); assert.equal(g.deadline, null);
  assert.equal(g.update({ ...base, power: { known: false, onBattery: true }, now: 0 }).stop, false);

  g.update({ ...base, now: 0 });
  assert.equal(g.deadline, 1000);
  g.allow(true);
  assert.equal(g.deadline, null);
  assert.equal(g.update({ ...base, now: 5000 }).stop, false);
});

test("the go-ahead lasts until the power comes back, then is forgotten", () => {
  const g = new BatteryGuard();
  const base = { busy: true, enabled: true, graceMs: 1000 };
  g.allow(true);
  g.update({ ...base, power: BAT, now: 0 });
  assert.equal(g.consent, true);
  g.update({ ...base, power: AC, now: 1 });
  assert.equal(g.consent, false);
  // The next outage counts down again.
  g.update({ ...base, power: BAT, now: 2 });
  assert.equal(g.deadline, 1002);
});

test("power returning mid-countdown cancels it", () => {
  const g = new BatteryGuard();
  const base = { busy: true, enabled: true, graceMs: 1000 };
  g.update({ ...base, power: BAT, now: 0 });
  g.update({ ...base, power: AC, now: 500 });
  assert.equal(g.deadline, null);
  assert.equal(g.update({ ...base, power: BAT, now: 1200 }).stop, false);
  assert.equal(g.deadline, 2200);
});

test("Battery Safe is on by default with five minutes, and both survive a restart", () => {
  const src = readFileSync(new URL("./config.js", import.meta.url), "utf8");
  assert.match(src, /power: \{\s*batterySafe: true,\s*graceMinutes: 5,/);
  assert.match(src, /\["power", "batterySafe",/);
  assert.match(src, /\["power", "graceMinutes",/);
});

test("the page loads battery.js before app.js, so its fetch wrapper is in place first", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const b = html.indexOf('src="battery.js"'), a = html.indexOf('src="app.js"');
  assert.ok(b > 0 && b < a);
  for (const id of ["qBatSafe", "qBatGrace"]) assert.ok(html.includes(`id="${id}"`), id);
});
