/** Actual source-picker controller and check/create handlers, without a server. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { isControlVideo, videoControlSpec, controlRouteIssue, mountH3VideoControl } from "../web/h3-video-control.js";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const fit = await readFile(new URL("../web/vidfit.js", import.meta.url), "utf8");
const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

class Element {
  constructor(value = "") { this.value = value; this.hidden = false; this.disabled = false; this.children = []; this.handlers = new Map(); this.dataset = {}; this.selectedOptions = [{ dataset: {} }]; this.checked = false; this.textContent = ""; this.classList = { add() {}, remove() {} }; }
  addEventListener(type, fn, capture) { const rows = this.handlers.get(type) || []; rows.push({ fn, capture }); this.handlers.set(type, rows); }
  async emit(type, event = {}) { for (const row of this.handlers.get(type) || []) await row.fn(event); }
  dispatchEvent(event) { this.lastEvent = event.type; return true; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  removeAttribute(name) { delete this[name]; }
  pause() { this.paused = true; }
  closest() { return { hidden: false }; }
  contains() { return false; }
}
function fixture(options = {}) {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  for (const id of [...html.matchAll(/\bid="(vidControl[^"]+)"/g)].map(m => m[1])) $(id);
  for (const [id, value] of Object.entries({ vidControlMode: "depth", vidControlStrength: "1", vidControlStart: "0", vidControlEnd: "1" })) $(id).value = value;
  $("vidControlMenu").hidden = true;
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element(), addEventListener() {} };
  const host = $("vidControlField"); host.querySelector = selector => $(selector.slice(1));
  let engine = "h3", remote = false, custom = false, recipe = false, changes = 0;
  const requests = [], offers = [];
  const control = mountH3VideoControl(host, {
    getEngine: () => engine, getRemote: () => remote, getCustom: () => custom, getRecipe: () => recipe,
    onChange: () => { changes++; }, offerModel: row => offers.push(row),
    request: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ name: "import_take.mp4", kind: "video" }) }; },
    ...options,
  });
  return { $, control, requests, offers, changes: () => changes,
    engine(value) { engine = value; control.paint(); }, remote(value) { remote = value; control.paint(); },
    custom(value) { custom = value; control.paint(); }, recipe(value) { recipe = value; control.paint(); },
    restore() { globalThis.document = oldDocument; } };
}
async function withFixture(fn, options) { const f = fixture(options); try { await fn(f); } finally { f.restore(); } }

test("an empty source omits every control field; a selected video preserves exact defaults and zeroes", () => {
  assert.deepEqual(videoControlSpec({ controlMode: "pose", controlStrength: 2 }), {});
  assert.deepEqual(videoControlSpec({ sourceVideo: "my take.mp4" }), { sourceVideo: "my take.mp4", controlMode: "depth", controlStrength: 1, controlStart: 0, controlEnd: 1 });
  assert.equal(videoControlSpec({ sourceVideo: "take.mp4", controlStrength: 0 }).controlStrength, 0);
});

test("source names, modes and denoising windows refuse invalid input", () => {
  for (const name of ["../take.mp4", "folder/take.mp4", "C:\\take.mp4", "https://host/take.mp4", "take.png", "song.wav", "take.mp4?x", "a\u0000.mp4"]) assert.equal(isControlVideo(name), false, name);
  for (const name of ["take.MP4", "my take.mov", "撮影.webm", "a.mkv", "a.m4v"]) assert.equal(isControlVideo(name), true, name);
  for (const patch of [{ controlMode: "prepared" }, { controlStrength: NaN }, { controlStrength: 2.1 }, { controlStart: -1 }, { controlEnd: 1.1 }, { controlStart: 0.7, controlEnd: 0.7 }]) assert.throws(() => videoControlSpec({ sourceVideo: "take.mp4", ...patch }));
});

test("only local built-in H3 accepts a source, without excluding a compatible checkpoint", () => {
  assert.equal(controlRouteIssue({ sourceVideo: "take.mp4", engine: "h3" }), "");
  assert.equal(controlRouteIssue({ engine: "ltx", remote: true }), "");
  for (const patch of [{ engine: "ltx" }, { engine: "fasth3" }, { remote: true }, { custom: true }, { recipe: true }]) assert.ok(controlRouteIssue({ sourceVideo: "take.mp4", engine: "h3", ...patch }));
});

test("engine switches preserve the selected source and clear removes conditioning", () => withFixture(async f => {
  f.control.choose({ name: "my take.mp4", title: "A <safe> title" });
  assert.equal(f.$("vidControlName").textContent, "A <safe> title");
  assert.equal(f.$("vidControlPreview").src, "/api/clip/my%20take.mp4");
  f.engine("ltx"); assert.equal(f.$("vidControlField").hidden, false);
  assert.throws(() => f.control.assertAllowed(), /MiniMax H3/);
  assert.equal(f.control.spec().sourceVideo, "my take.mp4");
  f.engine("h3"); assert.equal(f.control.assertAllowed().sourceVideo, "my take.mp4");
  f.control.clear(); assert.deepEqual(f.control.spec(), {}); assert.equal(f.$("vidControlPreview").src, undefined);
  f.engine("ltx"); assert.equal(f.$("vidControlField").hidden, true);
}));

test("library choices contain only local video rows and use text labels", () => withFixture(async f => {
  await f.$("vidControlLibrary").emit("click");
  const rows = f.$("vidControlMenu").children;
  assert.deepEqual(rows.map(row => row.textContent), ["<b>Take</b>", "other.webm"]);
  await rows[0].emit("click"); assert.equal(f.control.spec().sourceVideo, "take.mp4");
}, { getClips: () => [{ name: "take.mp4", title: "<b>Take</b>" }, { name: "other.webm", meta: { kind: "video" } }, { name: "image.png" }, { name: "song.wav" }, { name: "wrong.mp4", meta: { kind: "audio" } }] }));

test("upload uses the existing raw-byte import route and rejects a nonvideo result", () => withFixture(async f => {
  const file = { name: "my take.mov", size: 10, type: "video/quicktime" };
  await f.control.upload(file);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][0], "/api/studio/import");
  assert.equal(f.requests[0][1].body, file); assert.equal(f.requests[0][1].headers["x-name"], "my%20take.mov");
  assert.equal(f.control.spec().sourceVideo, "import_take.mp4");
  await assert.rejects(() => f.control.upload({ name: "image.png", size: 2 }), /video/);
}));

test("wrong-kind imports preserve the previous source", () => withFixture(async f => {
  f.control.choose({ name: "old.mp4" });
  await assert.rejects(() => f.control.upload({ name: "new.mp4", size: 10 }), /did not return a video/);
  assert.equal(f.control.spec().sourceVideo, "old.mp4");
}, { request: async () => ({ ok: true, json: async () => ({ name: "song.wav", kind: "audio" }) }) }));

test("a refused import preserves the previous source and returns its actual failure", () => withFixture(async f => {
  f.control.choose({ name: "old.mp4" });
  await assert.rejects(() => f.control.upload({ name: "new.mp4", size: 10 }), /Disk full/);
  assert.equal(f.control.spec().sourceVideo, "old.mp4");
}, { request: async () => ({ ok: false, json: async () => ({ error: "Disk full" }) }) }));

test("clearing during an upload prevents a late completion from restoring the source", async () => {
  let finish;
  await withFixture(async f => {
    const pending = f.control.upload({ name: "new.mp4", size: 10 });
    assert.throws(() => f.control.assertAllowed(), /finish/);
    f.control.clear(); finish({ ok: true, json: async () => ({ name: "new.mp4", kind: "video" }) });
    await pending; assert.deepEqual(f.control.spec(), {});
  }, { request: () => new Promise(resolve => { finish = resolve; }) });
});

test("readiness offers the returned model only after a press and ignores stale checks", () => withFixture(async f => {
  f.control.choose({ name: "take.mp4" });
  const requested = f.control.spec();
  f.control.readiness({ ok: false, refusal: { error: "Depth weights are missing.", reason: "needs-model", needsModel: { id: "depthPreprocess" } } }, requested);
  assert.equal(f.$("vidControlStatus").textContent, "Model missing");
  assert.equal(f.offers.length, 0); assert.equal(f.requests.length, 0);
  await f.$("vidControlGet").emit("click"); assert.equal(f.offers[0].needsModel.id, "depthPreprocess");
  f.$("vidControlMode").value = "pose"; await f.$("vidControlMode").emit("input");
  f.control.readiness({ ok: true }, requested);
  assert.equal(f.$("vidControlStatus").textContent, "Check source");
  f.control.readiness({ ok: true }, f.control.spec()); assert.equal(f.$("vidControlStatus").textContent, "Source ready");
}));

function renderContext(f, fetch) {
  for (const [id, value] of Object.entries({ vidEngine: "h3", vidSteps: "20", vidSecs: "5", vidPrompt: "A new look", vidAudio: "1", vidGuide: "1", vidPin: "70" })) f.$(id).value = value;
  const context = vm.createContext({ $: f.$, state: { video: { enabled: true, engine: "h3", engines: { h3: {} } } },
    h3VideoControl: f.control, h3RefModPanel: { spec: () => ({}) }, vidModelChoice: () => ({}), vidLoraChoice: () => ({}),
    vidWH: () => [1344, 768], vidSpeedupNeed: () => null, vidPaint() {}, fetch });
  const begin = app.indexOf('$("vidCreate").onclick = async () => {');
  const finish = app.indexOf("\nasync function loadClips()", begin);
  assert.ok(begin > 0 && finish > begin);
  vm.runInContext(app.slice(begin, finish), context);
  return context;
}
function checkContext(f, fetch) {
  const context = vm.createContext({ $: f.$, S: {}, asked: 0, sizeNow: () => [1344, 768], sparseToSend: () => undefined,
    refNames: () => [], document: { querySelectorAll: () => [] }, videoVaeChosen() {}, paintKeep() {}, paintSong() {}, fetch,
    aiplayH3VideoControl: () => f.control.spec(), aiplayH3VideoControlCheck: (result, request) => f.control.readiness(result, request) });
  f.$("vidPanel").hidden = false;
  const begin = fit.indexOf("async function check() {"); const finish = fit.indexOf("\n/* The decoder", begin);
  vm.runInContext(fit.slice(begin, finish), context);
  return context;
}

test("the actual check and Render handlers send the identical selected control recipe", () => withFixture(async f => {
  f.control.choose({ name: "take.mp4" }); f.$("vidControlMode").value = "pose"; f.$("vidControlStrength").value = "0.8";
  const bodies = [];
  const fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); return { json: async () => ({ ok: true }) }; };
  const render = renderContext(f, fetch);
  await f.$("vidCreate").onclick();
  const check = checkContext(f, fetch); await vm.runInContext("check()", check);
  assert.deepEqual(bodies.map(body => Object.fromEntries(Object.keys(f.control.spec()).map(key => [key, body[key]]))), [f.control.spec(), f.control.spec()]);
  f.remote(true); await f.$("vidCreate").onclick(); assert.equal(bodies.length, 2, "unsupported route did not submit a render");
  assert.match(f.$("clipNote").textContent, /local H3/);
  void render;
}));

test("an invalid current control value cannot be overwritten by an older readiness response", () => withFixture(async f => {
  f.control.choose({ name: "take.mp4" });
  let finish;
  const check = checkContext(f, () => new Promise(resolve => { finish = resolve; }));
  const pending = vm.runInContext("check()", check);
  f.$("vidControlStrength").value = "";
  await vm.runInContext("check()", check);
  assert.match(f.$("vidFitNote").textContent, /strength/);
  finish({ json: async () => ({ ok: true, notes: [{ text: "Stale ready note" }] }) });
  await pending;
  assert.match(f.$("vidFitNote").textContent, /strength/);
}));

test("the real capture guard blocks RunPod before its renderer can consume the click", () => withFixture(async f => {
  const begin = app.indexOf('$("vidCreate")?.addEventListener("click", event => {');
  const finish = app.indexOf("\n\nfunction videoFriendRecipe()", begin);
  vm.runInNewContext(app.slice(begin, finish), { $: f.$, h3VideoControl: f.control });
  const guard = f.$("vidCreate").handlers.get("click")[0]; assert.equal(guard.capture, true);
  f.control.choose({ name: "take.mp4" }); f.remote(true);
  const event = { preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  await guard.fn(event); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
}));

test("a source attachment is rejected by the actual text-only friend recipe", () => withFixture(async f => {
  f.control.choose({ name: "take.mp4" });
  const begin = app.indexOf("function videoFriendRecipe() {"); const finish = app.indexOf("\nfunction videoFriendJob()", begin);
  const context = vm.createContext({ aiplayH3VideoControl: () => f.control.spec() });
  vm.runInContext(app.slice(begin, finish), context);
  assert.throws(() => vm.runInContext("videoFriendRecipe()", context), /Remove the source clip/);
}));

test("Simple keeps the selected input while its control settings stay Advanced", async () => {
  const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  const scoped = await readFile(new URL("../web/h3-video-control.css", import.meta.url), "utf8");
  assert.match(css, /\.assist-on > [^{]*:not\(#vidControlField\)[^{]*\{ display: none !important; \}/);
  assert.match(scoped, /#vidPanel\.assist-on #vidControlOptions\s*\{ display: none !important; \}/);
  assert.match(html, /id="vidControlFile"[^>]*accept="video\//);
});
