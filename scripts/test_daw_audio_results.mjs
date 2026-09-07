import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { audioResultDetails, stemResultDetails } from "../web/daw-audio-results.js";

const source = readFileSync(new URL("../web/daw.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, `Missing actual function ${name}`);
  const end = source.indexOf("\n}", start);
  assert(end > start);
  return source.slice(start, end + 2);
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`ok ${name}`); }
const project = { sr: 48000, tracks: [{ id: "p", name: "Piano" }, { id: "s", name: "Strings" }], returns: [{ id: "hall", name: "Shared hall" }] };
const region = (extra = {}) => ({ idx: 0, fromBar: 1, toBar: 4, hash: "h", stems: [{ track_id: "p" }, { track_id: "s" }],
  returns: [{ return_id: "hall", file: "return.wav", url: "/api/daw/audio/A/return.wav" }], ...extra });
const result = (regions = [region()], tracks = project.tracks) => ({ tracks, regions });

await test("stereo duration counts frames once and includes actual sample rate", () => {
  assert.equal(audioResultDetails({ channels: 2, durSamples: 96000, sr: 48000, format: "flac" }).summary, "Stereo · 2.0s · FLAC · 48 kHz");
});
await test("mono and unknown legacy channel metadata remain distinct", () => {
  assert.match(audioResultDetails({ channels: 1, seconds: 3, format: "flac" }).summary, /^Mono/);
  const legacy = audioResultDetails({ durSamples: 44100, file: "old.wav" }, 44100);
  assert.equal(legacy.summary, "1.0s · WAV");
  assert.doesNotMatch(legacy.summary, /Mono|Stereo/);
});
await test("above-full-scale float WAV explains preserved headroom without claiming normalization", () => {
  const view = audioResultDetails({ channels: 2, seconds: 5, format: "wav", peak: 2 });
  assert.equal(view.headroom, true); assert.match(view.summary, /float32 WAV/);
  assert.match(view.notice, /Peak \+6\.0 dBFS; float headroom preserved/);
});
await test("ordinary FLAC and silent assets do not invent headroom warnings", () => {
  for (const peak of [0, 0.5, 1]) assert.equal(audioResultDetails({ format: "flac", peak }).notice, "");
});
await test("multichannel downmix and encoder fallback notes remain visible", () => {
  const view = audioResultDetails({ source_channels: 6, channels: 2, format: "wav", note: "Encoder fallback." });
  assert.match(view.notice, /6-channel source downmixed to stereo/); assert.match(view.notice, /Encoder fallback/);
});
await test("fresh complete exports show measured exported residual, not graph residual or master gain", () => {
  const view = stemResultDetails(result([region({ exported_complete: true, exported_residual_db: -130, residual_db: -999, master_delta_db: 9 })]), project);
  assert.equal(view.complete, true); assert.match(view.summary, /track stems plus effect returns/);
  assert.match(view.summary, /-130\.0 dB/); assert.doesNotMatch(view.summary, /999|9\.0|on top/);
});
await test("selected tracks with full shared returns are still an incomplete mix", () => {
  const view = stemResultDetails(result([region({ stems: [{ track_id: "p" }] })], [project.tracks[0]]), project);
  assert.equal(view.complete, false); assert.match(view.summary, /does not reconstruct/);
  assert.match(view.summary, /sends from all tracks/);
});
await test("cached complete regions retain return files but never fabricate measurements", () => {
  const view = stemResultDetails(result([region({ cached: true })]), project);
  assert.equal(view.complete, true); assert.doesNotMatch(view.summary, /Measured/);
});
await test("missing return file and explicit server incompleteness prevent reconstruction claim", () => {
  for (const row of [region({ returns: [] }), region({ exported_complete: false })]) {
    assert.equal(stemResultDetails(result([row]), project).complete, false);
  }
});
await test("known silent tracks complete a region without fabricated silent audio files", () => {
  const view = stemResultDetails(result([region({ stems: [{ track_id: "p" }], silent_tracks: ["s"] })]), project);
  assert.equal(view.complete, true);
});
await test("worst measured residual and measured-region count are reported across regions", () => {
  const view = stemResultDetails(result([region({ exported_complete: true, exported_residual_db: -150 }), region({ idx: 1, exported_complete: true, exported_residual_db: -120 }), region({ idx: 2, cached: true })]), project);
  assert.match(view.summary, /-120\.0 dB or lower \(2\/3 regions\)/);
});

class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.value = ""; this.listeners = {}; this.attributes = {}; this.hidden = false; this.textContent = ""; this.paused = 0; }
  append(...children) { for (const child of children) { this.children.push(child); if (this.tagName === "select" && this.children.length === 1) this.value = child.value; } }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = []; if (this.tagName === "select") this.value = ""; this.append(...children); }
  querySelectorAll(tag) { return this.children.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute(key, value) { this.attributes[key] = value; }
  pause() { this.paused++; }
}
function harness(names) {
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, new Element(id === "dawReturnRegion" ? "select" : "div")); return nodes.get(id); };
  $("dawReturnStems").append($("dawReturnRegion"), $("dawReturnFiles"));
  const calls = { status: [], fetch: [], api: [], render: [], refresh: [], stop: 0 };
  const S = { slug: "A", projectEpoch: 1, trackId: "p", proj: structuredClone(project), playing: false,
    wave: { open: new Set(["p", "s"]), busy: new Set(), result: result(), error: "", previewKey: "" } };
  const ctx = vm.createContext({ S, $, document: { createElement: (tag) => new Element(tag) }, audioResultDetails, stemResultDetails,
    URLSearchParams, encodeURIComponent, performance: { now: () => 1 }, audioImportRequest: 0, auditionNode: null,
    stop: () => { calls.stop++; S.playing = false; }, status: (message) => calls.status.push(message),
    selTrack: () => S.proj.tracks.find((track) => track.id === S.trackId),
    qToPosFine: () => ({ bar: 3, beat: 2, tick: 120 }), secondsToQ: () => 0, projTime: () => 0,
    refreshDoc: async (session) => { calls.refresh.push(session); return true; },
    api: async (body) => { calls.api.push(body); return { channels: 2, seconds: 4, format: "wav", peak: 1.5, dirty: [0] }; },
    renderAndSwap: (...args) => calls.render.push(args),
    fetch: async (url, options) => { calls.fetch.push({ url, options }); return { ok: true, status: 200, json: async () => ({ channels: 2, seconds: 2, format: "flac", dirty: [0] }) }; },
  });
  vm.runInContext(["captureSession", "sessionCurrent", ...names].map(extract).join("\n"), ctx);
  return { ctx, S, $, calls, jump: () => { S.slug = "B"; S.projectEpoch++; ctx.audioImportRequest++; $("impBtn").disabled = false; } };
}
await test("actual return DOM displays cached stereo files and the inclusive bar range", () => {
  const h = harness(["drawReturnStems"]); h.ctx.drawReturnStems();
  assert.equal(h.$("dawReturnRegion").children[0].textContent, "Bars 1–4");
  const audio = h.$("dawReturnFiles").querySelectorAll("audio")[0];
  assert.equal(audio.src, "/api/daw/audio/A/return.wav"); assert.equal(audio.preload, "none");
  assert.match(audio.attributes["aria-label"], /Shared hall, bars 1–4/);
  assert.equal(h.$("dawReturnFiles").querySelectorAll("a")[0].download, "return.wav");
});
await test("preview starts stop transport, expose loading errors, and preserve a file download", () => {
  const h = harness(["drawReturnStems"]); h.ctx.drawReturnStems(); h.S.playing = true;
  const audio = h.$("dawReturnFiles").querySelectorAll("audio")[0]; audio.listeners.play();
  assert.equal(h.calls.stop, 1); audio.listeners.error(); assert.equal(h.$("dawStemRetry").hidden, false);
  assert.equal(h.$("dawReturnFiles").querySelectorAll("a").length, 1);
});
await test("project change clears and pauses old return audio", () => {
  const h = harness(["drawReturnStems"]); h.ctx.drawReturnStems();
  const audio = h.$("dawReturnFiles").querySelectorAll("audio")[0];
  h.jump(); h.S.wave.open.clear(); h.S.wave.result = null; h.ctx.drawReturnStems();
  assert.equal(audio.paused, 1); assert.equal(h.$("dawReturnStems").hidden, true);
  assert.equal(h.$("dawReturnFiles").querySelectorAll("audio").length, 0);
});
await test("unexpected external stem URL is not loaded into a preview or download", () => {
  const h = harness(["drawReturnStems"]); h.S.wave.result = result([region({ returns: [{ return_id: "hall", url: "https://example.invalid/audio.wav" }] })]);
  h.ctx.drawReturnStems(); assert.equal(h.$("dawReturnFiles").querySelectorAll("audio").length, 0);
  assert.equal(h.$("dawReturnFiles").querySelectorAll("a").length, 0);
});
await test("actual upload captures track, project and playhead and displays channel metadata", async () => {
  const h = harness(["importAudioFile"]); await h.ctx.importAudioFile({ name: "stereo.wav" });
  assert.match(h.calls.fetch[0].url, /\/upload\/A\?track=p&bar=3&beat=2&tick=120/);
  assert.match(h.$("dawImportNote").textContent, /Stereo · 2\.0s · FLAC onto Piano/);
  assert.equal(h.calls.render[0][3].slug, "A"); assert.equal(h.$("impBtn").disabled, false);
});
await test("upload errors show server explanation and restore the import button", async () => {
  const h = harness(["importAudioFile"]); h.ctx.fetch = async () => ({ ok: false, status: 415, json: async () => ({ error: "Unsupported codec." }) });
  await h.ctx.importAudioFile({ name: "bad.wav" });
  assert.match(h.$("dawImportNote").textContent, /Unsupported codec/); assert.equal(h.$("impBtn").disabled, false);
  assert.equal(h.calls.refresh.length, 0); assert.equal(h.calls.render.length, 0);
});
await test("non-JSON HTTP error remains actionable rather than a JSON parser failure", async () => {
  const h = harness(["importAudioFile"]); h.ctx.fetch = async () => ({ ok: false, status: 413, json: async () => { throw new Error("Unexpected HTML"); } });
  await h.ctx.importAudioFile({ name: "large.wav" }); assert.match(h.$("dawImportNote").textContent, /HTTP 413/);
});
await test("late upload response after project switch cannot refresh, render or overwrite new status", async () => {
  const h = harness(["importAudioFile"]); let resolve;
  h.ctx.fetch = () => new Promise((r) => { resolve = r; });
  const pending = h.ctx.importAudioFile({ name: "old.wav" }); h.jump(); h.$("dawImportNote").textContent = "New project";
  resolve({ ok: true, json: async () => ({ seconds: 2 }) }); await pending;
  assert.equal(h.calls.refresh.length, 0); assert.equal(h.calls.render.length, 0);
  assert.equal(h.$("dawImportNote").textContent, "New project"); assert.equal(h.$("impBtn").disabled, false);
});
await test("explicit generated result import uses the server path and the captured target through import_audio", async () => {
  const h = harness(["importAudioFile"]); await h.ctx.importAudioFile({ name: "extended.wav", path: "C:/output/extended.wav" });
  assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.api.length, 1);
  assert.equal(h.calls.api[0].action, "import_audio"); assert.equal(h.calls.api[0].path, "C:/output/extended.wav");
  assert.equal(h.calls.api[0].track, "p"); assert.equal(h.calls.api[0].bar, 3);
  assert.match(h.$("dawImportNote").textContent, /float headroom preserved/);
});
await test("generated result import with no selected track explains the missing target without changing a project", async () => {
  const h = harness(["importAudioFile"]); h.S.trackId = null;
  await h.ctx.importAudioFile({ name: "extended.wav", path: "C:/output/extended.wav" });
  assert.equal(h.calls.api.length, 0); assert.match(h.$("dawImportNote").textContent, /Select a DAW project and track/);
});

console.log(`${passed} DAW audio result checks passed; no server, project, provider or audio render touched.`);
