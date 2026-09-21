import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("const tr = (body)"), app.indexOf("/* ── Collab ─"));
const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
function fixture() {
  const nodes = new Map(), remembered = new Map(), calls = [];
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", hidden: false, disabled: false, textContent: "", handlers: {}, dataset: {}, currentTime: 0, duration: NaN,
      classList: { toggle() {} }, addEventListener(event, fn) { this.handlers[event] = fn; },
      pause() { this.paused = true; }, async play() { this.paused = false; },
      getBoundingClientRect() { return { left: 0, width: 600 }; },
      set innerHTML(value) { this.markup = value; const m = /<option[^>]+value="([^"]*)"/.exec(value); if (m) this.value = m[1]; },
      get innerHTML() { return this.markup || ""; },
    });
    return nodes.get(id);
  };
  $("trSeconds").value = "24"; $("trStartSeconds").value = "0"; $("trName").value = "my piano";
  $("trSteps").value = "600"; $("trRank").value = "8"; $("trLr").value = "0.0002";
  const defaults = (url, body) => {
    if (url === "/api/status") return { library: [{ file: "source.wav", title: "Source" }] };
    if (url.startsWith("/api/peaks/")) return { ok: true, seconds: 40, peaks: [-0.2, 0.3, -0.5, 0.7], rate: 44100 };
    if (body?.action === "status") return { ready: true, checkpoint: "YuE2.safetensors", tokenizerReady: true, freeVramMb: 12000, needVramMb: 10000, trained: [] };
    if (body?.action === "start") return { runId: "run-1", name: "mine_piano", settings: { startSeconds: body.startSeconds, seconds: body.seconds } };
    if (body?.action === "check") return { done: false, state: "running", runningSec: 12 };
    return { trained: [] };
  };
  const context = vm.createContext({ $, document: {}, esc: String, cbCount() {}, setView() {},
    localStorage: { getItem: (k) => remembered.get(k) || null, setItem: (k, v) => remembered.set(k, v), removeItem: (k) => remembered.delete(k) },
    navigator: { clipboard: { writeText: async () => {} } }, setTimeout: () => 0, clearTimeout() {},
    respond: defaults, fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null; calls.push({ url, body });
      const result = await context.respond(url, body); return { json: async () => result };
    },
  });
  vm.runInContext(source, context);
  return { $, remembered, calls, defaults, context, run: (code) => vm.runInContext(code, context), fire: (id, event = "click") => $(id).handlers[event]?.({ target: $(id) }) };
}

test("actual source duration controls a region; unknown, short or out-of-bounds input is refused", async () => {
  const f = fixture();
  assert.match(f.run("trRegionIssue({start:0,seconds:24,duration:null})"), /duration/);
  assert.match(f.run("trRegionIssue({start:0,seconds:7,duration:40})"), /8 to 180/);
  assert.match(f.run("trRegionIssue({start:20,seconds:24,duration:40})"), /past/);
  await f.run("paintTraining()");
  assert.equal(f.$("trSourceAudio").src, "/api/audio/source.wav");
  assert.match(f.$("trWave").innerHTML, /<path/);
  assert.equal(f.$("trStart").disabled, false);
  f.$("trStartSeconds").value = "30"; await f.fire("trStartSeconds", "input");
  assert.equal(f.$("trStart").disabled, true);
  await f.fire("trStart");
  assert.equal(f.calls.filter((c) => c.body?.action === "start").length, 0);
});

test("audition seeks to the same offset that training receives and stops at the selected end", async () => {
  const f = fixture(); await f.run("paintTraining()");
  f.$("trStartSeconds").value = "10";
  await f.fire("trListen");
  assert.equal(f.$("trSourceAudio").currentTime, 10);
  assert.equal(f.$("trSourceAudio").paused, false);
  f.$("trSourceAudio").currentTime = 34; await f.fire("trSourceAudio", "timeupdate");
  assert.equal(f.$("trSourceAudio").paused, true);
  await f.fire("trStart");
  const request = f.calls.find((c) => c.body?.action === "start").body;
  assert.equal(request.startSeconds, 10); assert.equal(request.seconds, 24);
  assert.equal(f.$("trStart").disabled, true);
  assert.match(f.$("trRunDetails").textContent, /10s start/);
});

test("a failed completed run is cleared so it cannot permanently block another run", async () => {
  const f = fixture(); await f.run("paintTraining()");
  f.run('trRemember({runId:"failed-run",name:"mine_piano"})');
  f.context.respond = (url, body) => body?.action === "check" ? { done: true, failed: true, error: "out of memory" } : f.defaults(url, body);
  await f.run("trCheckRun()");
  assert.equal(f.run("trRecall()"), null);
  assert.match(f.$("trLiveState").textContent, /out of memory/);
  assert.equal(f.$("trStart").disabled, false);
});

test("hardware blocks training but keeps source review available; no quality result is invented", async () => {
  const f = fixture();
  f.context.respond = (url, body) => body?.action === "status" ? { ...f.defaults(url, body), ready: false, why: "GPU busy", busy: true } : f.defaults(url, body);
  await f.run("paintTraining()");
  assert.equal(f.$("trForm").hidden, false);
  assert.equal(f.$("trBlocked").hidden, false);
  assert.equal(f.$("trStart").disabled, true);
  assert.equal(f.$("trListen").disabled, false);
  assert.match(html, /audible improvement is not validated/);
  assert.doesNotMatch(html, /Twenty-four seconds is usually enough/);
});

test("late waveform response cannot replace the newly chosen source", async () => {
  const f = fixture(); let finish;
  f.context.respond = (url, body) => url.endsWith("first.wav") ? new Promise((resolve) => { finish = resolve; }) : f.defaults(url, body);
  f.$("trFile").value = "first.wav"; const pending = f.run("trLoadSource()");
  f.$("trFile").value = "second.wav"; await f.run("trLoadSource()");
  finish({ ok: true, seconds: 999, peaks: [0, 1] }); await pending;
  assert.equal(f.run("trSource.file"), "second.wav");
  assert.equal(f.run("trSource.duration"), 40);
});
