/** Actual queue/library rendering functions, isolated from Studio and the GPU. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} remains locatable`);
  return source.slice(a, b);
}
const controllerSource = [
  between("const STAGES =", "function art(seed)"),
  between("const KIND_FALLBACK =", "// Use the real mark"),
  // The row's model badge reads its name from here (MiniMax rows record only a precision).
  between("function songModelLabel(t)", "function openSongRefMenu()"),
  between("function rowHtml(j)", "/* ── row overflow menu"),
  between("function openSong(file)", "/* ── output rights"),
].join("\n");

function element() {
  const classes = new Set();
  return {
    hidden: false, textContent: "", innerHTML: "", style: {}, attributes: {},
    classList: {
      add: (...names) => names.forEach((s) => classes.add(s)),
      remove: (...names) => names.forEach((s) => classes.delete(s)),
      contains: (s) => classes.has(s),
      toggle(s, on) { if (on) classes.add(s); else classes.delete(s); },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    load() {},
  };
}
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function harness() {
  const nodes = new Map();
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const state = { library: [], playingFile: "", realtimeRatio: 1.53 };
  const controller = runInNewContext(`${controllerSource}\n({ renderNow, renderQueue, rowHtml, openSong, musicWarningHtml })`, {
    $, state, esc: escapeHtml, dur: (s) => `${Math.round(s)}s`, fmt: (s) => `${Math.round(s)}s`, clock: () => "CLOCK",
    artBg: () => "#000", stamp: () => "", when: () => "just now", extendIndex: () => null, STAGE_WORD: {},
    paintLineage() {}, renderMerge() {}, paintExtend() {}, paintProvenance() {},
    fetch() { throw new Error("Unexpected network access"); },
  }, { timeout: 1000 });
  return { ...controller, $, state };
}
const native = (extra = {}) => ({ engine: "yue2-gguf", state: "running", title: "Take", stage: "load", seed: 1, ...extra });
const warning = { code: "possible_semantic_limit", message: "This take is near the configured generation limit. Check the ending and lyrics; the runtime did not confirm whether it stopped at the limit." };

test("native phases are the runtime's own, and a measured ETA drives the bar", () => {
  const h = harness();
  h.renderNow(native({ stage: "semantic", stageProgress: .87, overall: .63, etaSeconds: 17, elapsedSeconds: 121 }), 1);
  assert.match(h.$("nowStages").innerHTML, /✓ Load model.*✓ Score.*◆ Sing/);
  assert.doesNotMatch(h.$("nowStages").innerHTML, /87%/, "no invented within-phase percentage");
  assert.match(h.$("nowEta").textContent, /1 of 2.*121s elapsed.*~17 s left/);
  assert.equal(h.$("nowBar").classList.contains("indeterminate"), false);
  assert.equal(h.$("nowBar").style.width, "63%");
  assert.equal(h.$("nowProgress").attributes["aria-valuenow"], "63");
});

test("before any native render has been measured, the phase is live and the ETA says why it is missing", () => {
  const h = harness();
  h.renderNow(native({ stage: "load", overall: 0, etaSeconds: null, elapsedSeconds: 121 }), 1);
  assert.match(h.$("nowStages").innerHTML, /◆ Load model/);
  assert.match(h.$("nowEta").textContent, /1 of 2.*121s elapsed.*ETA after the first native render/);
  assert.doesNotMatch(h.$("nowEta").textContent, /left/);
  assert.equal(h.$("nowBar").classList.contains("indeterminate"), true);
  assert.equal(h.$("nowProgress").attributes["aria-valuenow"], undefined);
  assert.match(h.$("nowProgress").attributes["aria-label"], /unavailable/);
});

test("native missing elapsed is unknown, while real zero elapsed is retained", () => {
  const h = harness();
  for (const elapsedSeconds of [undefined, null, NaN, -1, "12"]) {
    h.renderNow(native({ elapsedSeconds }));
    assert.equal(h.$("nowEta").textContent, "ETA after the first native render");
  }
  h.renderNow(native({ elapsedSeconds: 0 }));
  assert.match(h.$("nowEta").textContent, /^0s elapsed/);
});

test("native waiting and verify stages render, and stale progress resets", () => {
  const h = harness();
  h.renderNow({ engine: "minimax-music3", state: "running", stage: "mixing", overall: .5, etaSeconds: 40, seed: 3 });
  assert.equal(h.$("nowProgress").attributes["aria-valuenow"], "50");
  h.renderNow(native({ stage: "waiting", stageProgress: null }));
  assert.match(h.$("nowStages").innerHTML, /◆ Waiting for GPU/);
  assert.equal(h.$("nowProgress").attributes["aria-valuenow"], undefined);
  h.renderNow(native({ stage: "verify" }));
  assert.match(h.$("nowStages").innerHTML, /◆ Verify audio/);
  assert.doesNotMatch(h.$("nowStages").innerHTML, /%/);
});

test("Python YuE2 and MiniMax retain their stages and estimate behavior", () => {
  const h = harness();
  h.renderNow(native());
  h.renderNow({ engine: "yue2", state: "running", stage: "nar", stageProgress: .25, overall: .75, etaSeconds: 80, seed: 5 });
  assert.match(h.$("nowStages").innerHTML, /synthesising 25%/);
  assert.equal(h.$("nowBar").classList.contains("indeterminate"), false);
  assert.equal(h.$("nowBar").style.width, "75%");
  assert.match(h.$("nowEta").textContent, /~1 min 20 s left/);
  h.renderNow({ engine: "minimax-music3", state: "running", stage: "mixing", overall: .5, etaSeconds: 40, seed: 3 });
  assert.match(h.$("nowStages").innerHTML, /mixing down/);
  assert.match(h.$("nowEta").textContent, /~40 s left/);
});

test("native queue-only work never inherits a MiniMax duration or a completion clock", () => {
  const h = harness();
  h.renderQueue({ queue: [native({ state: "queued", etaSeconds: 999 })] });
  assert.equal(h.$("wbState").textContent, "queued");
  assert.equal(h.$("wbEta").textContent, "ETA unknown");
  assert.doesNotMatch(h.$("wbEta").textContent, /CLOCK|999/);
  assert.match(h.$("wbNow").textContent, /waiting to start/);
  assert.match(h.$("wbRest").textContent, /then 1 song/);
});

test("mixed queues retain known row estimates but cannot promise a total ETA", () => {
  const h = harness();
  const s = { current: native({ etaSeconds: null }), queue: [{ engine: "minimax-music3", title: "Other", etaSeconds: 120 }], art: { queued: 1, queuedKinds: { clip: 1 } } };
  h.renderQueue(s);
  assert.equal(h.$("wbEta").textContent, "ETA unknown");
  assert.match(h.$("wbNow").textContent, /song · Take · ETA unknown/);
  assert.doesNotMatch(h.$("wbEta").textContent, /by CLOCK/);
  // What is behind it is still counted, by kind: a cover is seconds, a clip minutes.
  assert.match(h.$("wbRest").textContent, /then 1 song, 1 clip/);
  // A measured native ETA is a real estimate and counts like any other.
  h.renderQueue({ current: native({ etaSeconds: 90 }), queue: [] });
  assert.doesNotMatch(h.$("wbNow").textContent, /unknown/);
  assert.doesNotMatch(h.$("wbEta").textContent, /unknown/);
});

test("non-native queues still use their existing estimates", () => {
  const h = harness();
  h.renderQueue({ queue: [{ engine: "yue2", title: "Score", etaSeconds: 120 }] });
  assert.equal(h.$("wbState").textContent, "queued");
  assert.equal(h.$("wbEta").textContent, "~2m · by CLOCK");
  assert.doesNotMatch(h.$("wbEta").textContent, /unknown/);
});

test("one box, and it says what is being made, what waits, and the day's tally", () => {
  const h = harness();
  const midday = new Date(); midday.setHours(12, 0, 0, 0);
  h.state.library = [{ createdAt: midday.getTime() }, { createdAt: midday.getTime() }];
  h.state.images = [{ at: midday.getTime() }];
  h.state.clips = [{ at: 1 }];   // last year: not today
  h.renderQueue({ current: { engine: "minimax-music3", title: "Cheese On My Mind", etaSeconds: 240 } });
  assert.equal(h.$("wbState").textContent, "working");
  assert.match(h.$("wbNow").textContent, /^song · Cheese On My Mind · ~4m$/);
  assert.match(h.$("wbEta").textContent, /~4m · by CLOCK/);
  assert.equal(h.$("wbRest").textContent, "3 done today");
  assert.equal(h.$("wbBox")?.hidden ?? false, false);
});

test("library warning is compact and opens the existing song details", () => {
  const h = harness();
  const markup = h.rowHtml({ file: "Take 1.wav", title: "Take", warnings: [warning] });
  assert.match(markup, /class="badge generation-warning" data-info="Take%201.wav"/);
  assert.match(markup, />Check ending<\/button>/);
  assert.match(markup, /runtime did not confirm/);
  assert.doesNotMatch(markup, /confirmed truncated/);
});

test("warnings are escaped in the library attribute and the expanded panel", () => {
  const h = harness();
  const malicious = { file: "x.wav", title: "x", lyrics: "words", warnings: [{ code: "possible_semantic_limit", message: '<img src=x onerror="bad()"> & check' }] };
  h.state.library = [malicious];
  const markup = h.rowHtml(malicious);
  assert.ok(markup.includes("&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; check"));
  assert.doesNotMatch(markup, /<img src=x/);
  h.openSong("x.wav");
  assert.equal(h.$("spWarnings").hidden, false);
  assert.doesNotMatch(h.$("spWarnings").innerHTML, /<img src=x/);
  assert.match(h.$("spWarnings").innerHTML, /&lt;img/);
});

test("older rows do not gain warnings and switching songs clears a prior warning", () => {
  const h = harness();
  h.state.library = [{ file: "a.wav", lyrics: "words", warnings: [warning] }, { file: "b.wav", lyrics: "words" }];
  h.openSong("a.wav");
  assert.equal(h.$("spWarnings").hidden, false);
  h.openSong("b.wav");
  assert.equal(h.$("spWarnings").hidden, true);
  assert.equal(h.$("spWarnings").innerHTML, "");
  assert.doesNotMatch(h.rowHtml({ file: "b.wav", title: "Old" }), /Check ending|generation-warning/);
  assert.equal(h.musicWarningHtml({ warnings: [null, {}, { message: "" }] }), "");
});

test("progress accessibility and warning targets exist in the shipped page", () => {
  assert.match(html, /id="nowProgress" role="progressbar"/);
  assert.match(html, /id="spWarnings" hidden/);
});
