// The microphone lifecycle, with deferred permission and recorder events.
// No real microphone, browser permission, timers or transcription service.
import test from "node:test";
import assert from "node:assert/strict";
import { wireMic } from "../web/voice.js";

function setup(t, options = {}) {
  const permissions = [], recorders = [], timers = new Map(), requests = [], notices = [];
  let nextTimer = 0, after = 0;
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) {
      if (options.failAt === "constructor") throw new Error("constructor failed");
      Object.assign(this, { stream, state: "inactive", mimeType: "audio/webm", stopCalls: 0 });
      recorders.push(this);
    }
    start() {
      this.state = "recording";
      if (options.failAt === "start") throw new Error("start failed");
    }
    stop() {
      this.stopCalls++;
      if (options.failAt === "stop") throw new Error("stop failed");
      this.state = "inactive";
    }
    finish() {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(1200)]) });
      this.onstop?.();
    }
  }
  const replacements = {
    navigator: { mediaDevices: { getUserMedia: () => { const d = deferred(); permissions.push(d); return d.promise; } } },
    window: { MediaRecorder: Recorder }, MediaRecorder: Recorder,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => ({ text: "spoken request" }) }; },
  };
  const original = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const listeners = new Map();
  const button = { dataset: {}, setAttribute() {}, querySelector() { return null; }, addEventListener(name, fn) { listeners.set(name, fn); } };
  const box = { value: "typed request", focus() {}, setSelectionRange() {} };
  wireMic(button, { box, say: (text, warn) => notices.push({ text, warn }), after: () => after++ });
  const grant = (index = permissions.length - 1) => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track] };
    permissions[index].resolve(stream);
    return track;
  };
  return { button, box, permissions, recorders, timers, requests, notices, grant, click: () => listeners.get("click")(), after: () => after };
}

const flushed = () => new Promise((resolve) => setImmediate(resolve));

test("repeated clicks while permission is pending open only one recorder", async (t) => {
  const f = setup(t);
  const opening = f.click();
  f.click(); f.click();
  assert.equal(f.button.dataset.state, "opening");
  assert.equal(f.button.disabled, true);
  assert.equal(f.permissions.length, 1);
  const track = f.grant();
  await opening;
  assert.equal(f.recorders.length, 1);
  assert.equal(f.button.dataset.state, "rec");
  f.click(); f.click();
  assert.equal(f.recorders[0].stopCalls, 1);
  assert.equal(track.stopped, true);
  assert.equal(f.timers.size, 0);
  f.recorders[0].finish();
  await flushed();
  assert.equal(f.requests.length, 1);
  assert.equal(f.box.value, "typed request spoken request");
  assert.equal(f.after(), 1);
  assert.equal(f.button.dataset.state, "idle");
});

test("denied microphone permission returns to idle and can be retried", async (t) => {
  const f = setup(t);
  const first = f.click();
  f.permissions[0].reject(new Error("permission denied"));
  await first;
  assert.equal(f.button.dataset.state, "idle");
  assert.equal(f.button.disabled, false);
  assert.match(f.notices.at(-1).text, /permission denied/);
  const retry = f.click();
  const track = f.grant();
  await retry;
  f.click(); f.recorders[0].finish();
  await flushed();
  assert.equal(track.stopped, true);
  assert.equal(f.requests.length, 1);
});

for (const failAt of ["constructor", "start", "stop"]) {
  test(`a recorder ${failAt} failure releases the microphone and allows retry`, async (t) => {
    const options = { failAt };
    const f = setup(t, options);
    const first = f.click();
    const failedTrack = f.grant();
    await first;
    if (failAt === "stop") f.click();
    assert.equal(failedTrack.stopped, true);
    assert.equal(f.button.dataset.state, "idle");
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests.length, 0);
    assert.match(f.notices.at(-1).text, new RegExp(`${failAt} failed`));
    options.failAt = null;
    const retry = f.click();
    const retryTrack = f.grant();
    await retry;
    f.click(); f.recorders.at(-1).finish();
    await flushed();
    assert.equal(retryTrack.stopped, true);
    assert.equal(f.requests.length, 1);
  });
}

test("automatic stop and duplicate stop events transcribe once", async (t) => {
  const f = setup(t);
  const opening = f.click();
  const track = f.grant();
  await opening;
  const timeout = [...f.timers.values()].find((timer) => timer.ms === 120_000).fn;
  timeout(); timeout(); f.click();
  assert.equal(f.recorders[0].stopCalls, 1);
  assert.equal(track.stopped, true);
  f.recorders[0].finish(); f.recorders[0].finish();
  await flushed();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/voice");
  assert.equal(f.timers.size, 0);
  assert.equal(f.after(), 1);
});

test("a recording error releases the track and does not upload a partial recording", async (t) => {
  const f = setup(t);
  const opening = f.click();
  const track = f.grant();
  await opening;
  f.recorders[0].onerror({ error: new Error("device disconnected") });
  f.recorders[0].finish();
  await flushed();
  assert.equal(track.stopped, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.button.dataset.state, "idle");
  assert.match(f.notices.at(-1).text, /device disconnected/);
});
