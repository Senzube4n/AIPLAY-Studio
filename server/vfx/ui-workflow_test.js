/** Behavioural regressions against the page's actual functions, without a
 * browser, live profiles, Python or GPU work. No duplicated implementation. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../web/vfx.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../web/vfx.css", import.meta.url), "utf8");
function section(from, to) {
  const i = source.indexOf(from), j = source.indexOf(to, i + from.length);
  assert.ok(i >= 0 && j > i, `source section ${from}`);
  return source.slice(i, j);
}
const pollSource = section("async function pollRender()", "function paintProps()");
function pollHarness(rows, extra = {}) {
  const notes = [], urls = [];
  const ctx = vm.createContext({
    V: { slug: "open-comp", job: { id: "mine", slug: "rendered-comp", polls: 0, pct: 0, watchedAt: Date.now() }, jobTimer: 4 },
    Date, Math, num: (x, d = 0) => Number.isFinite(+x) ? +x : d,
    clamp: (v, a, b) => Math.min(Math.max(v, a), b), clearInterval() {}, paintBar() {},
    note: (s) => notes.push(s), loadLibraries() {},
    getJson: async (url) => { urls.push(url); return { renders: rows, clips: [{ name: "unrelated.mp4" }] }; },
    ...extra,
  });
  vm.runInContext(pollSource, ctx);
  return { ctx, notes, urls };
}

test("failed/finalized render never reports success", async () => {
  const h = pollHarness([{ id: "mine", status: "failed", error: "encoder failed", finishedAt: 1, clip: "does-not-exist.mp4" }]);
  await h.ctx.pollRender();
  assert.match(h.notes[0], /Render failed.*encoder failed/);
  assert.equal(h.ctx.V.job, null);
  assert.doesNotMatch(h.notes.join(" "), /Rendered/);
});

test("queued zero progress retains exact job, comp and bounded poll counter", async () => {
  const h = pollHarness([{ id: "mine", status: "queued", progress: 0 }]);
  await h.ctx.pollRender(); await h.ctx.pollRender();
  assert.equal(h.ctx.V.job.id, "mine"); assert.equal(h.ctx.V.job.slug, "rendered-comp");
  assert.equal(h.ctx.V.job.polls, 2);
  assert.deepEqual(h.urls, ["/api/vfx/comp/rendered-comp", "/api/vfx/comp/rendered-comp"]);
});

test("unrelated clip or render cannot finish the tracked job", async () => {
  const h = pollHarness([{ id: "other", status: "done", clip: "unrelated.mp4" }]);
  await h.ctx.pollRender();
  assert.equal(h.ctx.V.job.id, "mine"); assert.equal(h.notes.length, 0);
  assert.equal(h.urls.some((url) => url.includes("/api/clips")), false);
});

test("only the exact successful job completes", async () => {
  const h = pollHarness([{ id: "other", status: "failed" }, { id: "mine", status: "done", clip: "mine.mp4", frames: 24 }]);
  await h.ctx.pollRender();
  assert.match(h.notes[0], /Rendered 24 frames — mine.mp4/); assert.equal(h.ctx.V.job, null);
});

test("cancelled and interrupted outcomes stay truthful", async () => {
  for (const status of ["cancelled", "interrupted", "stale"]) {
    const h = pollHarness([{ id: "mine", status, finishedAt: 123 }]);
    await h.ctx.pollRender(); assert.match(h.notes[0], new RegExp(`Render ${status}`));
  }
});

test("poll calls single-flight and stale response cannot clear a newer watcher", async () => {
  let resolve, calls = 0;
  const h = pollHarness([], { getJson: () => { calls++; return new Promise((r) => { resolve = r; }); } });
  const first = h.ctx.pollRender(); await h.ctx.pollRender(); assert.equal(calls, 1);
  h.ctx.V.job = { id: "newer" };
  resolve({ renders: [{ id: "mine", status: "done" }] }); await first;
  assert.equal(h.ctx.V.job.id, "newer"); assert.equal(h.notes.length, 0);
});

test("unavailable render has a bounded watch period", async () => {
  const h = pollHarness([]); h.ctx.V.job.watchedAt = Date.now() - 16 * 60 * 1000;
  await h.ctx.pollRender(); assert.equal(h.ctx.V.job, null);
  assert.match(h.notes[0], /15 minutes/);
});

const clockSource = section("function playbackTime(", "async function play()");
test("timeline clock skips slow frames, loops work area, preserves frame grid", () => {
  const ctx = vm.createContext({ Math }); vm.runInContext(clockSource, ctx);
  assert.equal(ctx.playbackTime(0, 1000, 0, 8, 30), 1);
  assert.equal(ctx.playbackTime(0, 1099, 0, 8, 30), 32 / 30);
  assert.equal(ctx.playbackTime(2, 3000, 2, 4, 30), 3);
  assert.equal(ctx.playbackTime(4, 0, 2, 4, 30), 2);
  assert.equal(ctx.playbackTime(2, 500, 2, 2, 30), 2);
});

function playHarness() {
  let now = 0, callback;
  const timers = [];
  const ctx = vm.createContext({
    V: { comp: { updatedAt: 10 }, slug: "a", t: 0, inT: 0, outT: 5, preview: {}, fpsSeen: [], playToken: 0 },
    performance: { now: () => now }, Math,
    fps: () => 30, dur: () => 5, clamp: (v, a, b) => Math.min(Math.max(v, a), b),
    clearTimeout() {}, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    queueFrame() {}, api: async () => ({}), paintTransport() {}, paintPlayhead() {}, note() {},
    requestFrame: (_, done) => { callback = done; },
    previewAudio: { play: async () => ({ hasAudio: false }), pause() {}, getTime: () => null },
  });
  vm.runInContext(clockSource + section("async function play()", "/* ── the viewer"), ctx);
  return { ctx, timers, advance: (value) => { now = value; }, complete: () => callback() };
}
test("preview waits only remaining frame deadline, not decode plus whole frame", async () => {
  const h = playHarness(); await h.ctx.play(); h.advance(27); h.complete();
  assert.ok(Math.abs(h.timers[0].delay - (1000 / 30 - 27)) < 0.001);
  h.advance(100); h.timers[0].fn(); assert.equal(h.ctx.V.t, 0.1);
  h.ctx.stop(); const count = h.timers.length; h.complete(); assert.equal(h.timers.length, count);
});
test("audio clock is authoritative when available", async () => {
  const h = playHarness(); h.ctx.previewAudio.getTime = () => 2.25;
  await h.ctx.play(); assert.equal(h.ctx.V.t, 2.25);
});
test("Stop while audio prepares cannot later start visual playback", async () => {
  const h = playHarness(); let ready;
  h.ctx.previewAudio.play = () => new Promise((resolve) => { ready = resolve; });
  const playing = h.ctx.play(); h.ctx.stop(); ready({ hasAudio: true }); await playing;
  assert.equal(h.ctx.V.playing, false); assert.equal(h.ctx.V.playHasAudio, false);
  assert.equal(h.timers.length, 0);
});
test("displayed FPS includes presentation gaps, not only render latency", () => {
  const ctx = vm.createContext({ V: { fpsSeen: [1000 / 30, 1000 / 30, 1000 / 30] } });
  vm.runInContext(section("function previewFps()", "function paintTransport()"), ctx);
  assert.ok(Math.abs(ctx.previewFps() - 30) < 1e-6);
});
test("later document media playback stops VFX without blocking unrelated events", () => {
  let listener, capture, stops = 0;
  const ctx = vm.createContext({ V: { playing: true }, document: { addEventListener: (name, fn, cap) => { assert.equal(name, "play"); listener = fn; capture = cap; } }, stop: () => { stops++; ctx.V.playing = false; } });
  vm.runInContext(section("function wireMediaExclusivity()", "/* ────────────────────────────────────────── how tall"), ctx);
  ctx.wireMediaExclusivity(); assert.equal(capture, true);
  listener({ target: { tagName: "BUTTON" } }); assert.equal(stops, 0);
  listener({ target: { tagName: "AUDIO" } }); assert.equal(stops, 1); assert.equal(ctx.V.playing, false);
  listener({ target: { tagName: "VIDEO" } }); assert.equal(stops, 1);
});

const apiSource = section("const VFX_READ_ACTIONS", "async function getJson(");
function apiHarness(fetch) {
  const latest = { slug: "a", updatedAt: 10, layers: [] };
  const ctx = vm.createContext({
    V: { slug: "a", comp: latest, props: new Map(), rev: 0, playing: false },
    Map, Set, Promise, JSON, Error, fetch,
    previewAudio: { invalidate() {} }, stop() {}, loadComp: async () => {},
    clampWork() {}, histReset: (comp) => { ctx.resetTo = comp; }, paint() {},
  });
  vm.runInContext(apiSource, ctx); return ctx;
}
test("queued GUI gestures use last acknowledged revision", async () => {
  const sent = [];
  const ctx = apiHarness(async (_, options) => {
    const b = JSON.parse(options.body); sent.push(b);
    return { ok: true, status: 200, json: async () => ({ comp: { slug: "a", updatedAt: b.expectedRevision + 1 } }) };
  });
  await Promise.all([ctx.api({ action: "set_prop", slug: "a" }), ctx.api({ action: "set_prop", slug: "a" })]);
  assert.deepEqual(sent.map((b) => b.expectedRevision), [10, 11]);
});
test("conflict preserves server document and rejects already queued stale gestures", async () => {
  let calls = 0;
  const ctx = apiHarness(async () => { calls++; return { ok: false, status: 409, json: async () => ({ error: "stale", code: "comp_conflict", currentRevision: 20, comp: { slug: "a", updatedAt: 20, layers: [{ id: "agent-added" }] } }) }; });
  const settled = await Promise.allSettled([ctx.api({ action: "set_comp", slug: "a", layers: [] }), ctx.api({ action: "set_prop", slug: "a" })]);
  assert.equal(calls, 1); assert.ok(settled.every((r) => r.status === "rejected" && r.reason.code === "comp_conflict"));
  assert.equal(ctx.V.comp.layers[0].id, "agent-added"); assert.equal(ctx.resetTo.updatedAt, 20);
});
test("read-only preview tools never acquire document revisions", async () => {
  let body;
  const ctx = apiHarness(async (_, options) => { body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({}) }; });
  await ctx.api({ action: "probe_pixel", slug: "a" }); assert.equal(body.expectedRevision, undefined);
});
test("nested analysis application carries the guarded composition revision", async () => {
  let body;
  const ctx = apiHarness(async (_, options) => { body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ comp: { slug: "a", updatedAt: 11 } }) }; });
  await ctx.api({ action: "audio_keys", audio: "song.wav", apply: { slug: "a", layerId: "one" } });
  assert.equal(body.slug, "a"); assert.equal(body.apply.slug, "a"); assert.equal(body.expectedRevision, 10);
});

test("music layer picker offers existing audio filenames, never path imports", () => {
  const ctx = vm.createContext({});
  vm.runInContext(section("function audioSourceRows(", "async function audioSourcePicker()"), ctx);
  const rows = ctx.audioSourceRows([{ file: "song.wav", title: "Original song" }, { file: "track.FLAC" }, { file: "../escape.wav" }, { file: "C:\\escape.mp3" }, { file: "still.png" }, { title: "missing file" }]);
  assert.deepEqual(Array.from(rows, (row) => row.name), ["song.wav", "track.FLAC"]);
  assert.equal(rows[0].label, "Original song");
  assert.match(source, /\["audio", "♪", "Audio"/);
  assert.match(source, /kind === "audio"\) audioSourcePicker\(\)/);
});
test("closing the audio picker while reading library cannot reopen it", async () => {
  let loading = {}, resolve, opened = 0;
  const ctx = vm.createContext({ V: { slug: "a", songs: [] }, $: () => loading, overlay() {}, getJson: (url) => { assert.equal(url, "/api/status"); return new Promise((r) => { resolve = r; }); }, sourcePicker: () => { opened++; } });
  vm.runInContext(section("async function audioSourcePicker()", "function sourcePicker("), ctx);
  const read = ctx.audioSourcePicker(); loading = null;
  resolve({ library: [{ file: "song.wav" }] }); await read;
  assert.equal(opened, 0);
});
test("audio source selection uses normal audio add-layer path", () => {
  let chosen, html = "";
  const button = { dataset: { src: "song.wav" } }, grid = { querySelectorAll: () => [button] }, search = { value: "" };
  const ctx = vm.createContext({
    V: { songs: [{ file: "song.wav", title: "Original song" }] },
    GLYPH: { audio: "♪" }, esc: (s) => String(s),
    $: (id) => id === "vfxSrcGrid" ? grid : search,
    overlay: (body, wire) => { html = body; wire(() => {}); },
    addLayer: (...args) => { chosen = args; },
  });
  vm.runInContext(section("function audioSourceRows(", "async function audioSourcePicker()") + section("function sourcePicker(", "/** Which comp"), ctx);
  ctx.sourcePicker("audio"); button.onclick();
  assert.deepEqual(chosen, ["audio", "song.wav"]); assert.match(html, /no upload or generation/);
});
test("timeline starts at 30 percent but preserves an existing user height", () => {
  const root = { hidden: false, clientHeight: 600 }, time = { clientHeight: 200, style: {} }, view = { clientHeight: 500 };
  let saved = null;
  const ctx = vm.createContext({ V: { tlH: 0, workspace: { maximized: false } }, Math, Number,
    $: (id) => id === "vfx" ? root : id === "vfxTime" ? time : view,
    clamp: (v, a, b) => Math.min(Math.max(v, a), b), localStorage: { getItem: () => saved }, fitViewer() {},
  });
  vm.runInContext(section("const TL_FRACTION", "function wireSplit()"), ctx);
  ctx.applyTlHeight(); assert.equal(time.style.height, "180px");
  ctx.V.tlH = 0; saved = "320"; ctx.applyTlHeight(); assert.equal(time.style.height, "320px");
});

test("workspace hides optional chrome rather than removing tools and maximizes independently", () => {
  const attrs = {}, classes = new Set();
  const els = { vfx: { classList: { toggle: (key, on) => on ? classes.add(key) : classes.delete(key) } } };
  for (const id of ["vfxInspectorToggle", "vfxToolsToggle", "vfxSettingsToggle", "vfxMaximize"]) els[id] = { setAttribute: (key, value) => { attrs[`${id}.${key}`] = value; }, classList: { toggle() {} } };
  const ctx = vm.createContext({
    V: { workspace: { inspector: false, tools: false, settings: false, maximized: false } },
    $: (id) => els[id], localStorage: { setItem() {} }, requestAnimationFrame: (fn) => fn(), applyTlHeight() {}, fitViewer() {},
  });
  vm.runInContext(section("function applyWorkspace()", "/** No comps"), ctx);
  ctx.toggleWorkspace("maximized"); assert.ok(classes.has("vfx-maximized"));
  assert.equal(attrs["vfxMaximize.aria-pressed"], "true");
  ctx.toggleWorkspace("inspector"); assert.equal(classes.has("vfx-maximized"), false); assert.ok(classes.has("vfx-inspector"));
  assert.match(css, /#vfx:not\(\.vfx-tools\) \.vfxtransport-extra/);
  assert.match(css, /#vfx\.vfx-maximized #vfxTime/);
  assert.match(source, /id="vfxGraphTog"/); assert.match(source, /id="vfxLin"/);
});
