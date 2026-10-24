/**
 * Battery Safe: the three platform readers and the countdown decision.
 * No real process readers: lifecycle cases inject a watcher or child process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { BatteryGuard, PowerMonitor, batterySafeEnabled, parseLinux, parseMac, parseWindows, watchPower } from "./power.js";

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
const UNKNOWN = { known: false, onBattery: false, hasBattery: false, percent: null };

function fakeWatcher() {
  const readers = [];
  return {
    readers,
    watch(report, options) {
      const reader = { report, options, stops: 0 };
      readers.push(reader);
      return () => { reader.stops++; };
    },
  };
}

test("Windows requires a new explicit opt-in; other platforms keep Battery Safe preferences", () => {
  for (const power of [undefined, {}, { batterySafe: true }, { batterySafe: true, windowsMonitoring: false }]) {
    assert.equal(batterySafeEnabled(power, "win32"), false);
  }
  assert.equal(batterySafeEnabled({ batterySafe: true, windowsMonitoring: true }, "win32"), true);
  assert.equal(batterySafeEnabled({ batterySafe: false, windowsMonitoring: true }, "win32"), false);
  assert.equal(batterySafeEnabled({ batterySafe: "true", windowsMonitoring: true }, "win32"), false);
  for (const platform of ["linux", "darwin"]) {
    assert.equal(batterySafeEnabled({ batterySafe: true }, platform), true);
    assert.equal(batterySafeEnabled({ batterySafe: false, windowsMonitoring: true }, platform), false);
  }
});

test("monitor construction and legacy Windows preferences start no reader", () => {
  const fake = fakeWatcher(), readings = [];
  const monitor = new PowerMonitor((p) => readings.push(p), { watch: fake.watch, platform: "win32" });
  assert.equal(monitor.enabled, false);
  assert.equal(monitor.state, "off");
  monitor.setEnabled(batterySafeEnabled({ batterySafe: true }, "win32"));
  assert.equal(fake.readers.length, 0);
  assert.deepEqual(readings, []);
  monitor.dispose();
  assert.equal(fake.readers.length, 0);
});

test("monitor owns one Windows reader, reports state, and ignores readings after disabling", () => {
  const fake = fakeWatcher(), readings = [], states = [];
  const monitor = new PowerMonitor((p) => { readings.push(p); states.push(monitor.state); }, {
    watch: fake.watch, platform: "win32", everySec: 17,
  });
  monitor.setEnabled(true);
  monitor.setEnabled(true);
  assert.equal(fake.readers.length, 1);
  assert.deepEqual(fake.readers[0].options, { platform: "win32", everySec: 17, windowsMonitoring: true });
  assert.equal(monitor.enabled, true);
  assert.equal(monitor.state, "checking");
  assert.deepEqual(states, ["checking"]); // the reset is not a failed reading
  fake.readers[0].report(BAT);
  assert.equal(monitor.state, "ready");
  fake.readers[0].report(UNKNOWN);
  assert.equal(monitor.state, "unavailable");
  monitor.setEnabled(false);
  assert.equal(fake.readers[0].stops, 1);
  assert.equal(monitor.enabled, false);
  assert.equal(monitor.state, "off");
  assert.deepEqual(readings.at(-1), UNKNOWN);
  const count = readings.length;
  fake.readers[0].report(BAT);
  monitor.setEnabled(false);
  assert.equal(readings.length, count);
  assert.equal(fake.readers[0].stops, 1);

  monitor.setEnabled(true);
  assert.equal(fake.readers.length, 2);
  assert.equal(monitor.state, "checking");
  fake.readers[0].report(BAT);
  assert.equal(monitor.state, "checking");
  fake.readers[1].report(AC);
  assert.equal(monitor.state, "ready");
  monitor.dispose();
  monitor.dispose();
  assert.equal(fake.readers[1].stops, 1);
  assert.equal(monitor.state, "off");
  const afterDispose = readings.length;
  fake.readers[1].report(BAT);
  monitor.setEnabled(true);
  assert.equal(readings.length, afterDispose);
  assert.equal(fake.readers.length, 2);
});

test("a failed factory stays unavailable until an explicit Off then On retry", () => {
  let starts = 0;
  const readings = [];
  const monitor = new PowerMonitor((p) => readings.push(p), {
    platform: "win32", watch() { starts++; throw new Error("blocked reader"); },
  });
  monitor.setEnabled(true);
  assert.equal(starts, 1);
  assert.equal(monitor.enabled, true);
  assert.equal(monitor.state, "unavailable");
  assert.deepEqual(readings, [UNKNOWN, UNKNOWN]);
  monitor.setEnabled(true);
  assert.equal(starts, 1);
  monitor.setEnabled(false);
  monitor.setEnabled(true);
  assert.equal(starts, 2);
  monitor.dispose();
});

test("synchronous reading callbacks can disable without stranding the newly returned stop handle", () => {
  let stops = 0, starts = 0;
  const monitor = new PowerMonitor((p) => { if (p.known) monitor.setEnabled(false); }, {
    platform: "linux",
    watch(report, options) {
      starts++;
      assert.equal(options.windowsMonitoring, false);
      report(BAT);
      return () => { stops++; };
    },
  });
  monitor.setEnabled(true);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(monitor.state, "off");
  monitor.dispose();
  assert.equal(stops, 1);
});

test("disabling resets BatteryGuard consent and countdown before any new sensor result", () => {
  const fake = fakeWatcher(), guard = new BatteryGuard();
  let last = UNKNOWN;
  const monitor = new PowerMonitor((reading) => {
    last = reading;
    guard.update({ power: last, busy: true, enabled: monitor.enabled, graceMs: 1000, now: 0 });
  }, { watch: fake.watch, platform: "win32" });
  monitor.setEnabled(true);
  fake.readers[0].report(BAT);
  assert.equal(guard.deadline, 1000);
  guard.allow(true);
  assert.equal(guard.consent, true);
  monitor.setEnabled(false);
  assert.equal(guard.consent, false);
  assert.equal(guard.deadline, null);
  assert.deepEqual(last, UNKNOWN);
  monitor.dispose();
});

test("direct Windows watchPower calls also require explicit opt-in", () => {
  for (const windowsMonitoring of [undefined, false, "true"]) {
    let starts = 0;
    const readings = [];
    const stop = watchPower((p) => readings.push(p), {
      platform: "win32", windowsMonitoring,
      spawnProcess() { starts++; throw new Error("must not run"); },
    });
    assert.equal(starts, 0);
    assert.deepEqual(readings, [UNKNOWN]);
    stop();
  }
});

function fakeWindowsChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kills = 0;
  child.kill = () => { child.kills++; };
  return child;
}

for (const failure of ["error", "exit"]) test(`Windows ${failure} immediately reports unknown without a restart timer`, (t) => {
  let starts = 0, timers = 0;
  t.mock.method(globalThis, "setTimeout", () => { timers++; return { unref() {} }; });
  const child = fakeWindowsChild(), readings = [];
  const stop = watchPower((p) => readings.push(p), {
    platform: "win32", windowsMonitoring: true,
    spawnProcess(command, args, options) {
      starts++;
      assert.equal(command, "powershell.exe");
      assert.ok(args.includes("-EncodedCommand"));
      assert.equal(options.windowsHide, true);
      return child;
    },
  });
  child.stdout.emit("data", "Offline|Low|0.2\n");
  assert.equal(readings.at(-1).known, true);
  child.emit(failure, failure === "error" ? new Error("blocked") : 1);
  assert.deepEqual(readings.at(-1), UNKNOWN);
  const count = readings.length;
  child.stdout.emit("data", "Offline|High|0.9\n");
  child.emit("exit", 1);
  assert.equal(readings.length, count);
  assert.equal(starts, 1);
  assert.equal(timers, 0);
  stop();
});

test("Windows spawn failure reports unknown, and cleanup suppresses late process events", () => {
  const failures = [];
  watchPower((p) => failures.push(p), {
    platform: "win32", windowsMonitoring: true,
    spawnProcess() { throw new Error("blocked spawn"); },
  })();
  assert.deepEqual(failures, [UNKNOWN]);
  const child = fakeWindowsChild(), readings = [];
  const stop = watchPower((p) => readings.push(p), {
    platform: "win32", windowsMonitoring: true, spawnProcess: () => child,
  });
  stop();
  stop();
  child.stdout.emit("data", "Offline|Low|0.2\n");
  child.emit("error", new Error("late"));
  child.emit("exit", 1);
  assert.equal(child.kills, 1);
  assert.deepEqual(readings, []);
});

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

test("Battery Safe keeps five minutes, but Windows monitoring defaults off; all three preferences persist", () => {
  const src = readFileSync(new URL("./config.js", import.meta.url), "utf8");
  const defaults = /power: \{([^}]+)\}/.exec(src)?.[1];
  assert.ok(defaults, "power defaults exist");
  assert.match(defaults, /batterySafe: true,/);
  assert.match(defaults, /windowsMonitoring: false,/);
  assert.match(defaults, /graceMinutes: 5,/);
  for (const key of ["batterySafe", "windowsMonitoring", "graceMinutes"]) {
    assert.ok(src.includes(`["power", "${key}",`), `${key} is persisted`);
  }
});

test("the page loads battery.js before app.js, so its fetch wrapper is in place first", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const b = html.indexOf('src="battery.js"'), a = html.indexOf('src="app.js"');
  assert.ok(b > 0 && b < a);
  for (const id of ["qBatSafe", "qBatGrace"]) assert.ok(html.includes(`id="${id}"`), id);
});
