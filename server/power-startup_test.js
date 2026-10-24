/** Execute the real server's battery setup/routes/start/exit wiring, with only
 * the OS reader and unrelated services replaced. No server, shell or engine is
 * started; even an accidental process call has no implementation in the VM. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { BatteryGuard, PowerMonitor, batterySafeEnabled } from "./power.js";

const INDEX = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WEB = readFileSync(new URL("../web/battery.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const imports = /import\s*\{([^}]+)\}\s*from\s*["']\.\/power\.js["']/.exec(INDEX)?.[1] || "";
for (const name of ["BatteryGuard", "PowerMonitor", "batterySafeEnabled"]) assert.ok(imports.split(",").map((s) => s.trim()).includes(name), `${name} is actually imported by the production server`);
function between(source, open, close, from = 0) {
  const start = source.indexOf(open, from), end = source.indexOf(close, start + open.length);
  assert.ok(start >= from && end > start, `actual production seam: ${open}`);
  return source.slice(start, end);
}
const setup = between(INDEX, "/* ── Battery Safe ─", "/* A port someone else holds");
const route = between(INDEX, 'if (p === "/api/power") {', "/* Fast covers (server/fastcover.js)");
assert.ok(route.length < 2500, "only the battery route is executed, never subsequent server routes");
const genericSave = between(INDEX, 'if (p === "/api/provenance/settings" && req.method === "POST") {', "/* Reactive —");
const guard = between(INDEX, "function sameOriginLocalJson(req) {", "/* ⚠ A SIZE CAP");
const startup = between(INDEX, "powerMonitor.setEnabled(batterySafeEnabled(config.power));", 'if (process.env.AIPLAY_OPEN === "1")', INDEX.indexOf("server.listen(config.uiPort"));
const shutdown = INDEX.slice(INDEX.indexOf('for (const sig of ["SIGINT", "SIGTERM"])'));
assert.ok(shutdown.startsWith("for (const sig"));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const BATTERY = { known: true, onBattery: true, hasBattery: true, percent: 47 };

function fixture({ platform = "win32", power = {}, readerThrows = false, engineStatus, saveResult = true } = {}) {
  const calls = { starts: 0, stops: 0, reads: 0, saves: [], events: [], engine: 0, artStops: 0, readers: [], intervals: [] };
  const config = { uiPort: 4173, power: { batterySafe: true, graceMinutes: 5, ...power }, provenance: { showBadges: true, embedRecord: true } };
  const handlers = new Map(); let persist = saveResult;
  const watch = (callback) => {
    calls.starts++;
    if (readerThrows) throw new Error("fixture reader cannot start");
    calls.readers.push(callback);
    return () => { calls.stops++; calls.events.push("reader-stop"); };
  };
  class InjectedMonitor extends PowerMonitor {
    constructor(callback, options) { super(callback, { ...options, platform, watch }); }
  }
  const context = vm.createContext({
    config, BatteryGuard, PowerMonitor: InjectedMonitor,
    batterySafeEnabled: (settings) => batterySafeEnabled(settings, platform),
    process: { platform, env: {}, on: (name, fn) => handlers.set(name, fn), once: (name, fn) => handlers.set(name, fn), exit: (code) => calls.events.push(`exit:${code}`) },
    console: { log() {} },
    setInterval: (callback, delay) => { calls.intervals.push({ callback, delay }); return { unref() {} }; },
    jobs: { current: null, queue: [], cancel: async () => {}, cancelById: async () => {} },
    art: { current: null, queue: [], stopAll: async () => { calls.artStops++; } }, batch: { run: null, stop() {} },
    engineDoor: { status: async () => { calls.engine++; return engineStatus ? engineStatus() : { running: [] }; } },
    comfy: { stop: async () => { calls.events.push("engine-stop"); } }, wss: { clients: [] },
    readBody: async (req) => { calls.reads++; return req.body; },
    savePrefs: () => { calls.saves.push(JSON.parse(JSON.stringify(config))); return typeof persist === "function" ? persist() : persist; },
    json: (_res, status, body) => ({ status, body }),
  });
  vm.runInContext(`${guard}\n${setup}\n${shutdown}\n globalThis.actual = {
    start() { ${startup} }, snapshot: powerSnapshot, tick: powerTick,
    monitor: powerMonitor, batteryGuard,
    async request(req) { const p = req.url; const res = null; ${route}\n${genericSave}\nthrow new Error("unexpected fixture route"); }
  };`, context, { timeout: 1000 });
  const request = (method = "GET", body = {}, extra = {}) => context.actual.request({
    method, url: "/api/power", body,
    headers: { host: "127.0.0.1:4173", "content-type": "application/json" }, ...extra,
  });
  return { calls, config, context, actual: context.actual, handlers, request, persistence: (next) => { persist = next; }, emit: (data, index = calls.readers.length - 1) => calls.readers[index](data) };
}

test("actual Windows startup ignores both default and legacy saved Battery Safe=true", async () => {
  for (const power of [{}, { batterySafe: true }, { batterySafe: true, windowsMonitoring: false }]) {
    const f = fixture({ power }); f.actual.start();
    for (let i = 0; i < 3; i++) assert.equal((await f.request()).body.batterySafe, false);
    assert.equal(f.calls.starts, 0); assert.equal(f.actual.snapshot().monitoring.state, "off");
    assert.equal(f.config.power.batterySafe, true, "retains the old countdown preference without treating it as consent");
  }
});

test("actual config loader and preference round trips retain the Windows opt-in boundary", () => {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(path.join(parent, "aiplay-power-prefs-")));
  const script = `
    import child from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    let attempted = 0;
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
      child[name] = () => { attempted++; throw new Error('No child process is allowed while loading preferences'); };
    }
    syncBuiltinESMExports();
    const { config, prefsSnapshot } = await import(${JSON.stringify(new URL("./config.js", import.meta.url).href)});
    process.stdout.write(JSON.stringify({ power: config.power, prefs: prefsSnapshot(), attempted }));
  `;
  const load = (dir) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: { ...process.env, AIPLAY_APPDATA: dir, AIPLAY_RIG: path.join(root, "empty-rig"), AIPLAY_MODELS_DIR: path.join(root, "empty-models") },
    });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout); assert.equal(state.attempted, 0);
    return state;
  };
  try {
    const cases = [
      ["new", null, false, 5],
      ["legacy", { batterySafe: true, graceMinutes: 12 }, false, 12],
      ["opted-in", { batterySafe: true, windowsMonitoring: true, graceMinutes: 7 }, true, 7],
      ["invalid-opt-in", { batterySafe: true, windowsMonitoring: "true" }, false, 5],
    ];
    for (const [name, saved, expected, minutes] of cases) {
      const dir = path.join(root, name); mkdirSync(dir);
      if (saved) writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ prefs: { power: saved } }));
      const state = load(dir);
      assert.equal(state.power.batterySafe, true); assert.equal(state.power.windowsMonitoring, expected);
      assert.equal(state.power.graceMinutes, minutes); assert.equal(batterySafeEnabled(state.power, "win32"), expected);
      assert.equal(batterySafeEnabled(state.power, "linux"), true);
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ prefs: state.prefs }));
      const restored = load(dir);
      assert.deepEqual(restored.power, state.power, `${name}: actual prefsSnapshot survives a generic save/reload`);
    }
  } finally {
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^aiplay-power-prefs-/);
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET, unrelated power actions and real generic preference saving cannot opt Windows in", async () => {
  const f = fixture(); f.actual.start();
  for (const body of [{ graceMinutes: 10 }, { allow: true }, { allow: false }, { stopNow: true }, { windowsMonitoring: true }]) await f.request("POST", body);
  await f.request("POST", { showBadges: false }, { url: "/api/provenance/settings" });
  assert.equal(f.calls.starts, 0); assert.equal(f.config.power.windowsMonitoring, undefined);
  assert.ok(f.calls.saves.length >= 2);
  assert.ok(f.calls.saves.every((saved) => saved.power.windowsMonitoring !== true));
  assert.equal(f.config.provenance.showBadges, false);
});

test("only the explicit local switch enables one reader, persists consent and survives a restart", async () => {
  const f = fixture(); f.actual.start();
  await f.request("POST", { batterySafe: true }); await f.request("POST", { batterySafe: true }); await f.request();
  assert.equal(f.calls.starts, 1); assert.equal(f.config.power.windowsMonitoring, true);
  const restored = fixture({ power: f.calls.saves.at(-1).power }); restored.actual.start();
  assert.equal(restored.calls.starts, 1); assert.equal(restored.actual.snapshot().batterySafe, true);
  f.actual.monitor.dispose(); restored.actual.monitor.dispose();
});

test("live Off is immediate while saving is pending; a failed write remains visible until a successful save", async () => {
  let resolveSave; const pendingSave = new Promise((resolve) => { resolveSave = resolve; });
  const f = fixture({ power: { windowsMonitoring: true }, saveResult: () => pendingSave }); f.actual.start();
  let finished = false; const request = f.request("POST", { batterySafe: false }).then((value) => { finished = true; return value; });
  await flush();
  assert.equal(finished, false); assert.equal(f.calls.stops, 1); assert.equal(f.actual.snapshot().batterySafe, false);
  assert.equal((await f.request()).body.monitoring.state, "off");
  resolveSave(false); const failure = await request;
  assert.equal(failure.status, 500); assert.equal(failure.body.batterySafe, false);
  assert.match(failure.body.settingsError, /previous setting may return after restart/);
  assert.equal((await f.request()).body.settingsError, failure.body.settingsError);
  f.persistence(true);
  const success = await f.request("POST", { graceMinutes: 10 });
  assert.equal(success.status, 200); assert.equal(success.body.settingsError, null);
  assert.equal(success.body.batterySafe, false); assert.equal(f.calls.starts, 1);
});

test("foreign, non-JSON and admitted LAN requests are refused before their body or reader is touched", async () => {
  const bad = [
    { headers: { host: "127.0.0.1:4173", origin: "https://foreign.example", "content-type": "application/json" } },
    { headers: { host: "rebound.example:4173", "content-type": "application/json" } },
    { headers: { host: "127.0.0.1:4173", "content-type": "text/plain" } },
    { lanClient: true, headers: { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173", "content-type": "application/json" } },
  ];
  for (const extra of bad) {
    const f = fixture(); f.actual.start();
    assert.equal((await f.request("POST", { batterySafe: true }, extra)).status, 403);
    assert.equal(f.calls.reads, 0); assert.equal(f.calls.starts, 0); assert.equal(f.calls.saves.length, 0);
  }
});

test("Linux and macOS retain default monitoring without the Windows opt-in", () => {
  for (const platform of ["linux", "darwin"]) {
    const f = fixture({ platform }); f.actual.start();
    assert.equal(f.calls.starts, 1); assert.equal(f.actual.snapshot().batterySafe, true);
    f.actual.monitor.dispose();
  }
});

test("live disable clears countdown/consent and cannot be undone by a late old reading", async () => {
  const f = fixture(); f.actual.start(); await f.request("POST", { batterySafe: true });
  f.context.jobs.current = { title: "fixture song" }; f.emit(BATTERY); await flush();
  assert.ok(f.actual.snapshot().deadline != null);
  await f.request("POST", { batterySafe: false });
  assert.equal(f.calls.stops, 1); assert.equal(f.actual.snapshot().deadline, null);
  f.emit(BATTERY, 0); await flush();
  assert.equal(f.actual.snapshot().known, false); assert.equal(f.actual.snapshot().monitoring.state, "off");
  await f.request("POST", { batterySafe: true }); f.actual.batteryGuard.allow(true);
  await f.request("POST", { batterySafe: false });
  assert.equal(f.actual.snapshot().consent, false); assert.equal(f.calls.stops, 2);
});

test("disable during a pending real powerTick cannot leak an expired countdown or stop work", async () => {
  let resolveStatus; const status = new Promise((resolve) => { resolveStatus = resolve; });
  const f = fixture({ engineStatus: () => status }); f.actual.start(); await f.request("POST", { batterySafe: true });
  f.actual.batteryGuard.deadline = Date.now() - 1; f.emit(BATTERY); await Promise.resolve();
  assert.equal(f.calls.engine, 1);
  await f.request("POST", { batterySafe: false });
  assert.equal(f.actual.snapshot().deadline, null, "reset is synchronous while the older tick awaits the engine");
  resolveStatus({ running: ["fixture"] }); await flush();
  assert.equal(f.calls.artStops, 0); assert.equal(f.actual.snapshot().deadline, null); assert.equal(f.actual.snapshot().known, false);
  assert.equal(f.actual.snapshot().busy, false, "a stale engine result cannot overwrite the live Off reset");
});

test("sensor loss during a pending real powerTick retains unknown and not-busy state", async () => {
  let resolveStatus; const status = new Promise((resolve) => { resolveStatus = resolve; });
  const f = fixture({ engineStatus: () => status }); f.actual.start(); await f.request("POST", { batterySafe: true });
  f.actual.batteryGuard.deadline = Date.now() - 1; f.emit(BATTERY); await Promise.resolve();
  f.emit({ known: false, onBattery: false, hasBattery: false, percent: null });
  assert.equal(f.actual.snapshot().deadline, null); assert.equal(f.actual.snapshot().busy, false);
  resolveStatus({ running: ["fixture"] }); await flush();
  assert.equal(f.calls.artStops, 0); assert.equal(f.actual.snapshot().known, false);
  assert.equal(f.actual.snapshot().busy, false, "a stale engine result cannot overwrite the unknown sensor reset");
  assert.equal(f.actual.snapshot().monitoring.state, "unavailable");
});

test("an unavailable reader stays unknown without automatic restart or a fabricated mains reading", async () => {
  const f = fixture({ readerThrows: true }); f.actual.start(); await f.request("POST", { batterySafe: true });
  const state = (await f.request()).body;
  assert.equal(state.known, false); assert.equal(state.monitoring.state, "unavailable");
  assert.equal(f.calls.starts, 1); assert.equal(f.calls.engine, 0); assert.equal(f.calls.artStops, 0);
});

test("actual signal and exit handlers dispose the reader before engine shutdown, once", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const f = fixture({ power: { windowsMonitoring: true } }); f.actual.start();
    await f.handlers.get(signal)(); f.handlers.get("exit")();
    assert.deepEqual(f.calls.events, ["reader-stop", "engine-stop", "exit:0"]);
    assert.equal(f.calls.stops, 1);
    f.emit(BATTERY); await flush(); assert.equal(f.actual.snapshot().known, false);
  }
});

function settingsFixture(initial) {
  const calls = { fetches: [], paint: 0 }; let reply = initial, ok = true, failure = null;
  const safe = { value: "1" }, grace = { value: "5", options: [{ value: "5" }], add(option) { this.options.push(option); } };
  const monitor = {}, note = {}; const elements = { qBatSafe: safe, qBatGrace: grace, batMonitor: monitor, batNote: note };
  const context = vm.createContext({
    document: { activeElement: null, getElementById: (id) => elements[id] },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    rawFetch: async (url, options) => {
      calls.fetches.push({ url, options });
      if (failure === "network") throw new Error("fixture internal network diagnostic");
      return { ok, json: async () => { if (failure === "json") throw new Error("fixture internal JSON diagnostic"); return reply; } };
    },
    paint: () => { calls.paint++; }, initial,
  });
  const send = between(WEB, "async function send(patch) {", "window.fetch =");
  const settings = between(WEB, "let settingsWired = false;", "/* Every five seconds");
  vm.runInContext(`let power = initial; ${send}\n${settings}\nglobalThis.actual = { paintSettings, send };`, context, { timeout: 1000 });
  return { calls, safe, grace, monitor, note, document: context.document, actual: context.actual,
    fail: (kind) => { failure = kind; }, reply: (next, successful = true) => { reply = next; ok = successful; failure = null; } };
}

test("actual Settings paint discloses Windows monitoring off without sending a request", () => {
  const f = settingsFixture({ batterySafe: false, graceMinutes: 5, monitoring: { platform: "win32", state: "off" } });
  f.actual.paintSettings();
  assert.equal(f.safe.value, "0"); assert.equal(f.grace.disabled, true);
  assert.equal(f.monitor.textContent, "Monitoring off"); assert.match(f.note.textContent, /PowerShell/);
  assert.equal(f.calls.fetches.length, 0);
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const select = between(html, '<select id="qBatSafe"', "</select>");
  assert.match(select, /<option value="0" selected>Off<\/option>/, "before the first GET the page must not suggest monitoring is already on");
});

test("actual dropdown send immediately repaints the effective result and unavailable state", async () => {
  const f = settingsFixture({ batterySafe: false, graceMinutes: 5, monitoring: { platform: "win32", state: "off" } });
  f.actual.paintSettings(); f.safe.value = "1";
  f.reply({ batterySafe: true, graceMinutes: 5, monitoring: { platform: "win32", state: "unavailable" } });
  await f.safe.onchange();
  assert.equal(f.calls.fetches.length, 1);
  assert.deepEqual(JSON.parse(f.calls.fetches[0].options.body), { batterySafe: true });
  assert.equal(f.monitor.textContent, "Battery status unavailable"); assert.match(f.note.textContent, /automatic stopping is inactive/);
  f.reply({ batterySafe: false, graceMinutes: 5, monitoring: { platform: "win32", state: "off" } });
  await f.actual.send({ batterySafe: false });
  assert.equal(f.safe.value, "0"); assert.equal(f.grace.disabled, true); assert.equal(f.monitor.textContent, "Monitoring off");
});

test("actual failed settings responses restore the focused control and retain a truthful power snapshot", async () => {
  const initial = { batterySafe: false, graceMinutes: 5, monitoring: { platform: "win32", state: "off" } };
  const f = settingsFixture(initial); f.actual.paintSettings(); f.document.activeElement = f.safe;
  f.safe.value = "1";
  const message = "Settings could not be saved; the previous setting may return after restart.";
  f.reply({ ...initial, settingsError: message, error: message }, false);
  await f.safe.onchange();
  assert.equal(f.safe.value, "0"); assert.equal(f.grace.disabled, true);
  assert.equal(f.monitor.textContent, "Settings error"); assert.equal(f.note.textContent, message);
  f.safe.value = "1"; f.reply({ error: "Battery Safe changes require Studio on this PC." }, false);
  const preserved = await f.safe.onchange();
  assert.equal(preserved.batterySafe, false); assert.equal(preserved.monitoring.platform, "win32");
  assert.equal(f.safe.value, "0"); assert.match(f.note.textContent, /require Studio on this PC/);
});

test("network and JSON failures in the actual send function cannot leave a focused control falsely On", async () => {
  for (const kind of ["network", "json"]) {
    const f = settingsFixture({ batterySafe: false, graceMinutes: 5, monitoring: { platform: "win32", state: "off" } });
    f.actual.paintSettings(); f.document.activeElement = f.safe; f.safe.value = "1"; f.fail(kind);
    const state = await f.safe.onchange();
    assert.equal(state.batterySafe, false); assert.equal(state.monitoring.state, "off");
    assert.equal(f.safe.value, "0"); assert.equal(f.grace.disabled, true); assert.equal(f.monitor.textContent, "Settings error");
    assert.match(f.note.textContent, /could not be confirmed/); assert.doesNotMatch(f.note.textContent, /fixture internal/);
    assert.equal(f.calls.fetches.length, 1);
  }
});
