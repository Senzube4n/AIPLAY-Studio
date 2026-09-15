import test from "node:test";
import assert from "node:assert/strict";
import { createVfxAudio } from "../../web/vfx-audio.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const spec = { slug: "fixture", revision: 1, from: 2, to: 6, time: 3 };
const response = (over = {}) => ({ ok: true, revision: 1, hasAudio: true,
  from: 2, to: 6, duration: 4, url: `/api/vfx/audio-preview/fixture/${"a".repeat(64)}.wav`, ...over });
const reply = body => ({ ok: true, json: async () => body });
class FakeAudio extends EventTarget {
  constructor() { super(); this.currentTime = 0; this.duration = 4; this.readyState = 0; this.src = ""; this.playCalls = 0; this.pauseCalls = 0; this.paused = true; this.autoReady = true; }
  load() { if (this.src && this.autoReady) { this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata"))); } }
  play() { this.playCalls++; this.paused = false; return this.playPromise || Promise.resolve(); }
  pause() { this.pauseCalls++; this.paused = true; }
  removeAttribute(name) { if (name === "src") { this.src = ""; this.readyState = 0; } }
}
function fixture(t, options = {}) {
  const state = { audios: [], fetches: [], states: [], errors: [], before: 0 };
  const ctl = createVfxAudio({
    audioFactory: () => { const a = new FakeAudio(); options.setupAudio?.(a); state.audios.push(a); return a; },
    fetchFn: async (...args) => { state.fetches.push(args); return options.fetchFn ? options.fetchFn(...args) : reply(response()); },
    beforePlay: () => state.before++, onState: s => state.states.push(s), onError: e => state.errors.push(e),
    ...options.controller,
  });
  t.after(() => ctl.dispose());
  return { ctl, state };
}
test("construction/load never autoplay; explicit play waits for preparation and browser audio start", async t => {
  const prepared = deferred(), started = deferred();
  const { ctl, state } = fixture(t, { fetchFn: () => prepared.promise, setupAudio: a => a.playPromise = started.promise });
  assert.equal(state.audios.length, 0); assert.equal(state.fetches.length, 0); assert.equal(ctl.getTime(), null);
  const playing = ctl.play(spec);
  assert.equal(state.before, 1); assert.equal(state.audios[0].playCalls, 0); assert.equal(ctl.getTime(), null);
  prepared.resolve(reply(response())); await tick();
  assert.equal(state.audios[0].playCalls, 1); assert.equal(ctl.getTime(), null);
  started.resolve(); assert.deepEqual(await playing, { hasAudio: true });
  assert.equal(ctl.getTime(), 3); assert.equal(state.audios[0].loop, true); assert.equal(state.audios[0].autoplay, false);
  assert.deepEqual(JSON.parse(state.fetches[0][1].body), { slug: "fixture", expectedRevision: 1, from: 2, to: 6 });
  assert.equal(state.fetches[0][1].credentials, "same-origin");
});
test("audio time is authoritative for visual sync, including seek and work-area loop", async t => {
  const { ctl, state } = fixture(t);
  await ctl.play(spec);
  state.audios[0].currentTime = 2.75; assert.equal(ctl.getTime(), 4.75);
  assert.equal(ctl.seek(5), true); assert.equal(state.audios[0].currentTime, 3); assert.equal(ctl.getTime(), 5);
  assert.equal(ctl.seek(6), true); assert.equal(ctl.getTime(), 2);
  state.audios[0].currentTime = 0.02; assert.equal(ctl.getTime(), 2.02);
});
test("seek while preparing is remembered and does not start sound early", async t => {
  const gate = deferred();
  const { ctl, state } = fixture(t, { fetchFn: () => gate.promise });
  const playing = ctl.play(spec); assert.equal(ctl.seek(4.5), true);
  assert.equal(state.audios[0].playCalls, 0);
  gate.resolve(reply(response())); await playing; assert.equal(ctl.getTime(), 4.5);
});
test("pause during preparation aborts request and fences a late successful response", async t => {
  const gate = deferred();
  const { ctl, state } = fixture(t, { fetchFn: () => gate.promise });
  const playing = ctl.play(spec); ctl.pause();
  const rejected = assert.rejects(playing, e => e.name === "AbortError");
  assert.equal(state.fetches[0][1].signal.aborted, true);
  gate.resolve(reply(response())); await rejected;
  assert.equal(state.audios[0].playCalls, 0); assert.equal(ctl.getTime(), null); assert.equal(state.errors.length, 0);
});
test("stop/unmount during browser play promise detaches media and fences late start", async t => {
  const started = deferred();
  const { ctl, state } = fixture(t, { setupAudio: a => a.playPromise = started.promise });
  const playing = ctl.play(spec); await tick(); ctl.dispose();
  const rejected = assert.rejects(playing, e => e.name === "AbortError");
  assert.equal(state.audios[0].src, ""); assert.equal(state.audios[0].paused, true);
  started.resolve(); await rejected;
  assert.equal(state.audios[0].paused, true); assert.equal(ctl.getTime(), null);
  await assert.rejects(ctl.play(spec), /disposed/);
});
test("new revision replaces old pending request and never creates duplicate music", async t => {
  const first = deferred(); let n = 0;
  const { ctl, state } = fixture(t, { fetchFn: () => ++n === 1 ? first.promise : reply(response({ revision: 2 })) });
  const old = ctl.play(spec); const rejected = assert.rejects(old, e => e.name === "AbortError");
  await ctl.play({ ...spec, revision: 2 });
  first.resolve(reply(response())); await rejected;
  assert.equal(state.audios[0].playCalls, 0); assert.equal(state.audios[0].src, "");
  assert.equal(state.audios[1].playCalls, 1); assert.equal(state.before, 2);
  ctl.invalidate(); assert.equal(state.audios[1].paused, true); assert.equal(ctl.getTime(), null);
});
test("confirmed no-audio result is explicit silent mode, not fabricated synchronized sound", async t => {
  const { ctl, state } = fixture(t, { fetchFn: () => reply(response({ hasAudio: false, url: null })) });
  assert.deepEqual(await ctl.play(spec), { hasAudio: false });
  assert.equal(state.audios[0].playCalls, 0); assert.equal(ctl.getTime(), null);
  assert.equal(state.states.at(-1).status, "silent"); assert.equal(state.errors.length, 0);
});
test("source errors and browser playback rejection fail closed with no silent fallback", async t => {
  const { ctl, state } = fixture(t, { fetchFn: () => ({ ok: false, json: async () => ({ ok: false, error: "Source is time-remapped" }) }) });
  await assert.rejects(ctl.play(spec), /time-remapped/);
  assert.equal(state.audios[0].playCalls, 0); assert.equal(state.states.at(-1).status, "error");
  const other = fixture(t, { setupAudio: a => { a.play = () => Promise.reject(Object.assign(new Error("Press Play again to allow sound"), { name: "NotAllowedError" })); } });
  await assert.rejects(other.ctl.play(spec), /allow sound/);
  assert.equal(other.ctl.getTime(), null); assert.equal(other.state.errors.length, 1);
  assert.equal(other.state.audios[0].src, "");
});
test("mismatched revision/range or arbitrary URL never loads into the media element", async t => {
  for (const over of [{ revision: 2 }, { from: 1 }, { duration: 500 }, { url: "https://example.com/audio.wav" },
    { url: `/api/vfx/audio-preview/other/${"a".repeat(64)}.wav` }, { hasAudio: false }]) {
    const { ctl, state } = fixture(t, { fetchFn: () => reply(response(over)) });
    await assert.rejects(ctl.play(spec), /does not match/);
    assert.equal(state.audios[0].src, ""); assert.equal(state.audios[0].playCalls, 0);
  }
});
test("invalid range refuses before fetching, outside-range seek stops current audio", async t => {
  const { ctl, state } = fixture(t);
  await assert.rejects(ctl.play({ ...spec, to: 123 }), /120 seconds/);
  assert.equal(state.fetches.length, 0);
  await ctl.play(spec); assert.equal(ctl.seek(1), false);
  assert.equal(state.audios[0].paused, true); assert.equal(ctl.getTime(), null);
});
test("runtime media error stops the audio clock and tells the visual host", async t => {
  const { ctl, state } = fixture(t); await ctl.play(spec);
  state.audios[0].dispatchEvent(new Event("error"));
  assert.equal(ctl.getTime(), null); assert.equal(state.errors.length, 1); assert.equal(state.audios[0].src, "");
  assert.equal(state.states.at(-1).status, "error");
});
test("preparation deadline aborts, clears playback, and reports an honest error", async t => {
  const timers = new Map(); let id = 0;
  const { ctl, state } = fixture(t, { fetchFn: (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }), controller: { setTimer: fn => { timers.set(++id, fn); return id; }, clearTimer: key => timers.delete(key) } });
  const playing = ctl.play(spec); const rejected = assert.rejects(playing, /timed out/);
  [...timers.values()][0](); await rejected;
  assert.equal(state.errors.length, 1); assert.equal(state.states.at(-1).status, "error");
  assert.equal(state.audios[0].playCalls, 0); assert.equal(ctl.getTime(), null); assert.equal(timers.size, 0);
});
test("metadata deadline and wrong WAV duration refuse before audio starts", async t => {
  const timers = new Map(); let id = 0;
  const { ctl, state } = fixture(t, { setupAudio: a => a.autoReady = false,
    controller: { setTimer: fn => { timers.set(++id, fn); return id; }, clearTimer: key => timers.delete(key) } });
  const playing = ctl.play(spec); const rejected = assert.rejects(playing, /timed out/);
  await tick(); [...timers.values()][0](); await rejected;
  assert.equal(state.audios[0].playCalls, 0); assert.equal(ctl.getTime(), null);
  const wrong = fixture(t, { setupAudio: a => a.duration = 300 });
  await assert.rejects(wrong.ctl.play(spec), /duration/); assert.equal(wrong.state.audios[0].playCalls, 0);
});
