/** Real Q4/Q8 browser setup/generation controllers; no server or GPU calls. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
function slice(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const code = [
  slice("let ggufSetupStatus", "/* Ask the server which configuration"),
  slice("function currentSpec(", "/* The YuE2 rows"),
  slice("async function generate(", "/* Takes per generation"),
  slice("async function reusePrompt(", "/* ── extend, in the input panel"),
].join("\n");
const response = (body) => ({ ok: true, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const variants = (q4 = true, q8 = false) => ({
  q4_0: { quantization: "q4_0", ready: q4, installed: q4, downloadBytes: q4 ? 0 : 3771000123, label: "Q4_0" },
  q8_0: { quantization: "q8_0", ready: q8, installed: q8, downloadBytes: q8 ? 0 : 5888000456, label: "Q8_0" },
});
const setup = (precision = "q4_0", choices = variants(), extra = {}) => ({
  ok: true, state: "idle", message: "Setup status", ...choices[precision],
  selected: choices[precision], variants: choices, activeQuantization: null, ...extra,
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness(respond) {
  const nodes = new Map(), calls = [], alerts = [], timers = new Map(); let timer = 0;
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, hidden: false, disabled: false, textContent: "", innerHTML: "", style: {}, listeners: {},
      classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; }, removeAttribute(key) { delete this[key]; },
      scrollIntoView() {}, dispatchEvent() {}, oninput() {}, focus() {},
    });
    return nodes.get(id);
  };
  for (const [id, value] of Object.entries({ title: "Test", lyrics: "Plain words", caption: "Folk", seed: "7", yCot: "full", ySteps: "32", yCfg: "", yGgufPrecision: "q4_0", ggufSetupPrecision: "q4_0", yPrecision: "fp8" })) $(id).value = value;
  const state = { musicEngine: "yue2-gguf", musicEnginesPainted: true, musicOnly: false, mode: "song", takes: 1, engineReady: false, library: [],
    musicEngines: { "yue2-gguf": { runtime: "audiocpp", ready: true, variants: variants(), cot: ["full", "melody", "off"], score: false, renderPath: true } } };
  const controller = runInNewContext(`${code}\n({ ggufPrecision, nativeMusicReady, selectGgufPrecision, refreshGgufSetup, actGgufSetup, paintGgufSetup, musicEnginePaint, currentSpec, generate, reusePrompt, applyGgufSetupStatus, get:()=>ggufSetupStatus })`, {
    $, state, AbortController, Event,
    esc: (s) => String(s ?? ""), document: { querySelectorAll: () => [], querySelector: () => null },
    yueEngine: () => true, captionValue: () => $("caption").value,
    paintExamples() {}, paintChips() {}, setGuided() {}, musicFitPaint() {},
    stopExtend() {}, setView() {}, setMode(mode) { state.mode = mode; }, paintSeed() {}, countChars() {},
    alert: (s) => alerts.push(s), reusesConditioning() { throw Error("Wrong backend"); },
    setTimeout(fn, ms) { if (ms === 400) { fn(); return 0; } timers.set(++timer, fn); return timer; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      const call = { url, options, body: options?.body ? JSON.parse(options.body) : null }; calls.push(call);
      if (respond) return respond(call);
      if (url.startsWith("/api/music-gguf/setup?")) return response(setup(new URL(url, "http://localhost").searchParams.get("precision"), state.musicEngines["yue2-gguf"].variants));
      if (url === "/api/generate") return response({ job: { id: "fake-q8" }, engine: "yue2-gguf" });
      throw new Error(`Unexpected request ${url}`);
    },
  }, { timeout: 1000 });
  return { ...controller, $, state, calls, alerts, timers };
}

test("Q4 is the default; selecting Q8 synchronizes both controls and only reads setup", async () => {
  const h = harness();
  assert.equal(h.ggufPrecision(), "q4_0");
  h.$("ggufSetupAccept").checked = true;
  h.$("yGgufPrecision").listeners.change({ target: { value: "q8_0" } });
  await flush();
  assert.equal(h.$("yGgufPrecision").value, "q8_0");
  assert.equal(h.$("ggufSetupPrecision").value, "q8_0");
  assert.equal(h.$("ggufSetupAccept").checked, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/music-gguf/setup?precision=q8_0");
  assert.equal(h.calls[0].options.method, "GET");
  assert.equal(h.calls[0].body, null);
});

test("Q8 missing blocks Create even when Q4 makes the aggregate engine ready", async () => {
  const h = harness(); h.selectGgufPrecision("q8_0"); await flush();
  assert.equal(h.state.musicEngines["yue2-gguf"].ready, true);
  assert.equal(h.$("btnCreate").disabled, true);
  assert.match(h.$("musicEngineWarn").textContent, /Q8_0 is not ready/);
  const before = h.calls.length;
  await h.generate(false);
  assert.equal(h.calls.length, before);
  assert.match(h.alerts[0], /Q8_0 is not ready/);
});

test("a legacy aggregate ready flag enables Q4 only, not an unreported Q8 variant", async () => {
  const h = harness((call) => response({ ok: true, ready: true, state: "ready", message: "Legacy Q4" }));
  h.state.musicEngines["yue2-gguf"] = { runtime: "audiocpp", ready: true, cot: ["full"] };
  assert.equal(h.nativeMusicReady(h.state.musicEngines["yue2-gguf"]), true);
  h.selectGgufPrecision("q8_0"); await flush();
  assert.equal(h.nativeMusicReady(h.state.musicEngines["yue2-gguf"]), false);
  assert.equal(h.$("btnCreate").disabled, true);
  assert.match(h.$("ggufSetupBytes").textContent, /not confirmed/);
});

test("ready Q8 uses q8_0 per take and re-enables independently of Comfy", async () => {
  const h = harness(); h.state.musicEngines["yue2-gguf"].variants = variants(true, true);
  h.selectGgufPrecision("q8_0"); await flush();
  assert.equal(h.$("btnCreate").disabled, false);
  assert.equal(h.currentSpec(false).quantization, "q8_0");
  await h.generate(false);
  const posted = h.calls.filter((c) => c.url === "/api/generate");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.engine, "yue2-gguf");
  assert.equal(posted[0].body.quantization, "q8_0");
  assert.equal(h.$("btnCreate").disabled, false);
  assert.deepEqual(h.alerts, []);
});

test("Q8-only installation does not make the default Q4 selection ready", () => {
  const h = harness(); h.state.musicEngines["yue2-gguf"].variants = variants(false, true);
  assert.equal(h.nativeMusicReady(h.state.musicEngines["yue2-gguf"]), false);
  delete h.state.musicEngines["yue2-gguf"].variants.q4_0;
  assert.equal(h.nativeMusicReady(h.state.musicEngines["yue2-gguf"]), false, "a partial variant map is not legacy Q4-only readiness");
});

test("Q8 install requires reviewed exact bytes and a fresh explicit licence acceptance", async () => {
  const h = harness((call) => {
    if (call.options.method === "GET") return response(setup("q8_0"));
    assert.equal(call.url, "/api/music-gguf/setup");
    return response(setup("q8_0", variants(), { state: "downloading", activeQuantization: "q8_0" }));
  });
  h.selectGgufPrecision("q8_0"); await flush();
  assert.ok(h.$("ggufSetupBytes").textContent.includes(`${(5888000456).toLocaleString()} bytes`));
  assert.equal(h.$("ggufSetupInstall").disabled, true);
  await h.actGgufSetup("install"); assert.equal(h.calls.length, 1);
  h.$("ggufSetupAccept").checked = true; h.paintGgufSetup();
  assert.equal(h.$("ggufSetupInstall").disabled, false);
  await h.actGgufSetup("install");
  assert.deepEqual(h.calls[1].body, { action: "install", quantization: "q8_0", acceptLicense: true });
  assert.equal(h.$("ggufSetupAccept").checked, false);
  assert.equal(h.$("ggufSetupCancel").hidden, false);
  assert.match(h.$("ggufSetupMessage").textContent, /Active download: Q8_0/);
  await h.actGgufSetup("install"); assert.equal(h.calls.length, 2);
});

test("unknown size or an active global verification cannot trigger a duplicate download", async () => {
  const h = harness();
  h.applyGgufSetupStatus({ quantization: "q4_0", ready: false, state: "idle" });
  h.$("ggufSetupAccept").checked = true;
  await h.actGgufSetup("install"); assert.equal(h.calls.length, 0);
  h.applyGgufSetupStatus({ quantization: "q4_0", ready: false, installed: true, downloadBytes: 0, state: "verifying" });
  await h.actGgufSetup("install"); assert.equal(h.calls.length, 0);
});

test("installed files with a failing runtime allow explicit repair, never automatic repair", async () => {
  const h = harness((call) => response(setup("q4_0", variants(), { state: "verifying", activeQuantization: "q4_0" })));
  h.applyGgufSetupStatus({ quantization: "q4_0", ready: false, installed: true, downloadBytes: 3771000123, state: "idle", message: "Runtime version check failed" });
  h.paintGgufSetup();
  assert.equal(h.$("ggufSetupInstall").disabled, true);
  assert.match(h.$("ggufSetupInstall").textContent, /Verify \/ repair Q4_0/);
  assert.equal(h.calls.length, 0);
  h.$("ggufSetupAccept").checked = true; h.paintGgufSetup();
  assert.equal(h.$("ggufSetupInstall").disabled, false);
  await h.actGgufSetup("install");
  assert.deepEqual(h.calls[0].body, { action: "install", quantization: "q4_0", acceptLicense: true });
});

test("switching precision while an old GET is pending discards its selected state", async () => {
  const pending = deferred(); let reads = 0;
  const h = harness((call) => ++reads === 1 ? pending.promise : response(setup("q8_0")));
  const first = h.refreshGgufSetup();
  h.selectGgufPrecision("q8_0");
  pending.resolve(response(setup("q4_0"))); await first; await flush();
  assert.equal(h.ggufPrecision(), "q8_0");
  assert.equal(h.get().selected.quantization, "q8_0");
  assert.match(h.$("ggufSetupBytes").textContent, /^Q8_0/);
  assert.equal(h.$("btnCreate").disabled, true);
  assert.equal(h.calls.every((c) => c.options.method === "GET"), true);
});

test("cancel remains a global explicit action, without install consent or precision", async () => {
  const h = harness((call) => response(setup("q8_0", variants(), { state: "cancelled" })));
  await h.actGgufSetup("cancel");
  assert.deepEqual(h.calls[0].body, { action: "cancel" });
});

test("reusing Q8 restores native engine and precision without installing or generating", async () => {
  const h = harness();
  h.state.musicEngine = "minimax-music3";
  h.state.library = [{ file: "q8.wav", title: "Q8 take", engine: "yue2-gguf", quantization: "q8_0", caption: "Metal", lyrics: "Original words", cot: "melody", steps: 32, cfg: 1.2 }];
  await h.reusePrompt("q8.wav"); await flush();
  assert.equal(h.state.musicEngine, "yue2-gguf");
  assert.equal(h.ggufPrecision(), "q8_0");
  assert.equal(h.$("yGgufPrecision").value, "q8_0");
  assert.equal(h.$("lyrics").value, "Original words");
  assert.equal(h.$("yCot").value, "melody");
  assert.equal(h.$("yPrecision").value, "fp8", "native reuse must not overwrite Python precision");
  assert.equal(h.calls.every((c) => c.options.method === "GET"), true);
});

test("legacy Q8 model label is reusable and an old native Q4 take resets Q8", async () => {
  const h = harness();
  h.state.library = [
    { file: "q8.wav", model: "YuE2 GGUF Q8", caption: "Folk", lyrics: "words" },
    { file: "q4.wav", model: "YuE2 GGUF Q4", caption: "Folk", lyrics: "words" },
    { file: "exact.wav", model: "YuE2 GGUF Q8", quantization: "q4_0", caption: "Folk", lyrics: "words" },
  ];
  await h.reusePrompt("q8.wav"); await flush(); assert.equal(h.ggufPrecision(), "q8_0");
  await h.reusePrompt("q4.wav"); await flush(); assert.equal(h.ggufPrecision(), "q4_0");
  await h.reusePrompt("q8.wav"); await flush();
  await h.reusePrompt("exact.wav"); await flush(); assert.equal(h.ggufPrecision(), "q4_0", "saved quantization is authoritative over a stale display label");
});

test("both selectors expose only Q4/Q8 and warn that precision is not proven audio quality", () => {
  for (const id of ["yGgufPrecision", "ggufSetupPrecision"]) {
    const select = html.match(new RegExp(`<select id="${id}"[\\s\\S]*?<\\/select>`))?.[0];
    assert.ok(select);
    assert.equal((select.match(/<option/g) || []).length, 2);
    assert.match(select, /value="q4_0"/); assert.match(select, /value="q8_0"/);
  }
  assert.match(html, /Higher precision does not establish better audio quality/);
  assert.doesNotMatch(html, /About 3\.77 GB total/);
});
