/**
 * EVERY YuE2 ROW THE MUSIC PAGE SHOWS IS ONE THE CHOSEN BUILD TAKES (2026-09-24).
 *
 * A tester on YuE2 GGUF set Key, Tempo, Meter, the sampler dials and "Let the
 * planner continue"; none of it reached the render, because the GGUF spec never
 * sent those rows and the door would have refused them anyway. The ComfyUI
 * build dropped a supplied score the same way. The rule since: a row the build
 * cannot take is ABSENT on that build, and a row that is shown is sent.
 *
 * This lane runs the page's own code — musicEnginePaint(), paintHumRows(),
 * currentSpec() and yueSpec(), sliced out of web/app.js — over the real Music
 * markup parsed from web/index.html, once per YuE2 build, with a value in every
 * YuE2 row. Then:
 *   · a visible row's value is in the spec (nothing shown is dropped);
 *   · a hidden row's value is not (nothing unseen rides along);
 *   · the spec is accepted by that build's door: native GGUF through the real
 *     prepareGgufJob(); the Python kit by the fields its /api/generate branch
 *     reads; ComfyUI through the hotfix's yue2ComfyFields() when that module is
 *     on this branch, and otherwise by the fields the contract says it refuses.
 * A row that is shown but DISABLED (Planner temperature while a score is sung
 * as written on GGUF or ComfyUI) is held to the other half: it is not sent.
 * Plus the page ends of the same change: the example score parses, the melody
 * pointer, the refusal hooks, the stem-python row, the Jobs "stopping…" and
 * "stopped", the transcription's own Stop, and the rights chip words.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/* LF whatever the checkout: this machine's shared config has autocrlf=true,
 * and the markers below are written with \n. */
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const APP = read("../web/app.js");
const HTML = read("../web/index.html");
const between = (start, end) => {
  const a = APP.indexOf(start), b = APP.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `web/app.js still has ${JSON.stringify(start)} … ${JSON.stringify(end)}`);
  return APP.slice(a, b);
};

/* ── a small DOM over the Music form's markup ─────────────────────────────── */
const VOID = new Set(["input", "br", "img", "meta", "link", "hr", "source", "wbr"]);
function makeEl(tag, attrs, parent) {
  const dataset = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("data-")) dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return {
    tag, attrs, parent, children: [], dataset, id: attrs.id || null,
    hidden: Object.hasOwn(attrs, "hidden"), checked: Object.hasOwn(attrs, "checked"),
    disabled: Object.hasOwn(attrs, "disabled"), value: attrs.value ?? "", placeholder: attrs.placeholder ?? "",
    textContent: "", innerHTML: "", title: "", style: {}, options: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
    setAttribute() {}, removeAttribute(k) { delete this[k]; }, addEventListener() {}, dispatchEvent() {},
    scrollIntoView() {}, focus() {},
  };
}
function parse(html) {
  const root = makeEl("#root", {}, null);
  let cur = root;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  for (const m of html.matchAll(re)) {
    if (m[0].startsWith("<!--")) continue;
    const [, close, rawTag, attrText, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n) cur = n.parent || root;
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? "";
    const el = makeEl(tag, attrs, cur);
    cur.children.push(el);
    if (!VOID.has(tag) && !selfClose) cur = el;
  }
  return root;
}
const walk = (el, out = []) => { for (const c of el.children) { out.push(c); walk(c, out); } return out; };

/* The Music form, from the "More Options" fold to the end of "Melody & score". */
const FORM_START = HTML.indexOf('<details class="adv sbox">\n      <summary>More Options</summary>');
const FORM_END = HTML.indexOf("</details>", HTML.indexOf('id="yMusicPlan"')) + "</details>".length;
assert.ok(FORM_START > 0 && FORM_END > FORM_START, "the Music form's markup is locatable");
const SUPPORTED = /^\[([\w-]+)(?:="([^"]*)")?\](?::not\(\[([\w-]+)\]\))?$/;

function page(engineKey) {
  const root = parse(HTML.slice(FORM_START, FORM_END));
  const all = walk(root);
  const byId = new Map(all.filter((e) => e.id).map((e) => [e.id, e]));
  const stubs = new Map();
  const $ = (id) => byId.get(id) || stubs.get(id) || (stubs.set(id, makeEl("div", { id }, null)), stubs.get(id));
  const unsupported = [];
  const document = {
    querySelectorAll(sel) {
      const m = SUPPORTED.exec(sel);
      if (!m) { unsupported.push(sel); return []; }
      const [, attr, val, not] = m;
      return all.filter((e) => e.hasAttribute(attr) && (val === undefined || e.attrs[attr] === val) && !(not && e.hasAttribute(not)));
    },
    querySelector: () => null,
    getElementById: (id) => byId.get(id) || null,
  };
  const engines = {
    "minimax-music3": { runtime: "comfy", score: false, audioReference: true, label: "MiniMax Music 3" },
    yue2: { runtime: "python", cot: ["full", "melody", "off"], score: true, audioReference: false, label: "YuE2 3B" },
    "yue2-comfy": { runtime: "comfy", cot: ["full", "melody", "off"], score: false, audioReference: false, label: "YuE2 3B (ComfyUI)" },
    "yue2-gguf": { runtime: "audiocpp", cot: ["full", "melody", "off"], score: false, audioReference: false, label: "YuE2 GGUF", ready: true,
      variants: { q4_0: { quantization: "q4_0", ready: true }, q8_0: { quantization: "q8_0", ready: false } } },
  };
  const state = { musicEngine: engineKey, musicEngines: engines, musicEnginesPainted: true, musicModels: [], mode: "song",
    engineReady: true, tokenizerReady: true, library: [{ file: "cover.flac", title: "Cover" }], seedLocked: false };
  const ctx = vm.createContext({
    $, state, document, AbortController, Event, structuredClone, console,
    esc: (s) => String(s ?? ""), yueEngine: () => Array.isArray(engines[state.musicEngine]?.cot),
    aceEngine: () => !!engines[state.musicEngine]?.ace, captionValue: () => "warm folk",
    scaffold: () => "[Instrumental]", aceSpec: () => ({}),
    paintExamples() {}, paintChips() {}, setGuided() {}, musicFitPaint() {}, stopExtend() {}, setView() {},
    setMode(m) { state.mode = m; }, paintSeed() {}, countChars() {}, alert() {}, musicLoadLoras() {}, acePaintOptions() {},
    reusesConditioning() { return false; }, setTimeout: () => 0, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  });
  vm.runInContext([
    between("let ggufSetupStatus", "/* Ask the server which configuration"),
    between("function currentSpec(", "/* The YuE2 rows"),
    between("function yueSpec()", "/** A re-roll is:"),
    /* From paintCoverPrime() when the hotfix lane's split is here (it paints
     * the prime rows paintHumRows calls into), else from paintHumRows(). */
    between(APP.includes("function paintCoverPrime(") ? "function paintCoverPrime(" : "function paintHumRows(", '$("humEngine")?.addEventListener'),
  ].join("\n"), ctx);
  return { $, state, ctx, byId, all, unsupported };
}

/* Every YuE2 row the form has, and the spec field its value travels in. */
const ROWS = {
  yCot: ["cot", "melody"], ySteps: ["narSteps", "16"], yCfg: ["cfgScale", "2.5"], yPrecision: ["quantization", "fp8"],
  yGgufPrecision: ["quantization", "q4_0"], yKey: ["key", "Em"], yBpm: ["bpm", "96"], yMeter: ["meter", "3/4"],
  yTemp: ["temperature", "0.9"], yTopP: ["topP", "0.9"], yPlanTemp: ["planTemperature", "0.8"],
  yAbcOpen: ["abcOpen", true], covPrime: ["coverOf", "8"], covStem: ["coverOf.stem", "drums"],
};
const EXPECT_VALUE = { narSteps: 16, cfgScale: 2.5, bpm: 96, temperature: 0.9, topP: 0.9, planTemperature: 0.8 };
const SCORE = "X:1\nT:\nM:4/4\nL:1/32\nQ:1/4=96\nV: Vocal\nV: Ins\nK:C\n";
const fieldOf = (spec, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), spec);

/** The row's own wrapper (the `.pv` span, or the control itself) and every
 *  ancestor inside the form must be showing. */
function visible(el) {
  for (let e = el; e && e.tag !== "#root"; e = e.parent) if (e.hidden) return false;
  return true;
}

function fill(p, { withScore }) {
  for (const [id, [, v]] of Object.entries(ROWS)) {
    const el = p.byId.get(id);
    assert.ok(el, `#${id} is in the Music form`);
    if (v === true) el.checked = true; else el.value = v;
  }
  p.byId.get("humEngine").value = "song";
  p.byId.get("humSong").value = "cover.flac";
  p.byId.get("yAbc").value = withScore ? SCORE : "";
  p.byId.get("yAbcUse").checked = withScore;
  for (const id of ["title", "lyrics", "seed", "qSteps", "qArCfg", "qCfg", "qModel", "maxDur", "caption"]) {
    const el = p.$(id); el.value = id === "lyrics" ? "Sing softly" : id === "seed" ? "7" : el.value || "1";
  }
}

const BUILDS = ["yue2", "yue2-gguf", "yue2-comfy"];
/* What each build hides. Precision is two rows, one per runtime; key, tempo,
 * meter, "let the planner continue" and the cover prime are the Python kit's;
 * Guidance is not ComfyUI's (its graph samples at cfg 1). The sampler dials,
 * Thinking and Steps show on all three. */
const KIT_ONLY = ["yKey", "yBpm", "yMeter", "yAbcOpen", "covPrime", "covStem"];
const EXPECT_HIDDEN = {
  yue2: ["yGgufPrecision"],
  "yue2-gguf": ["yPrecision", ...KIT_ONLY],
  "yue2-comfy": ["yPrecision", "yGgufPrecision", "yCfg", ...KIT_ONLY],
};
const { prepareGgufJob } = await import("./music-gguf-input.js");
let comfyFields = null;
try { ({ yue2ComfyFields: comfyFields } = await import("./music/yue2-comfy-input.js")); } catch { /* the hotfix is not on this branch yet */ }
const INDEX = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

for (const build of BUILDS) {
  test(`${build}: every YuE2 row shown is sent, and none hidden is`, () => {
    for (const withScore of [false, true]) {
      const p = page(build);
      fill(p, { withScore });
      p.ctx.musicEnginePaint();
      p.ctx.paintHumRows(false);
      assert.deepEqual(p.unsupported.filter((s) => /data-/.test(s)), [], "every row selector the painter uses was evaluated");
      const spec = vm.runInContext("currentSpec(false)", p.ctx);
      const shown = [], hidden = [], off = [];
      for (const [id, [path]] of Object.entries(ROWS)) {
        const el = p.byId.get(id);
        const wrap = el.parent?.tag === "span" || el.parent?.tag === "label" ? el.parent : el;
        (!visible(wrap) ? hidden : el.disabled ? off : shown).push([id, path]);
      }
      /* Shown but off: the planner dial while a score is sung as written, on
       * the two builds whose doors refuse it then — with the reason beside it. */
      const planOff = build !== "yue2" && withScore;
      assert.deepEqual(off.map(([id]) => id), planOff ? ["yPlanTemp"] : [], `${build}${withScore ? " + score" : ""}: the rows shown but off`);
      assert.equal(p.byId.get("yPlanTempNote").hidden, !planOff, "the reason shows exactly when the dial is off");
      if (planOff) assert.match(p.byId.get("yPlanTempNote").textContent, /^off while your score is used: it is sung as written$/);
      for (const [id, path] of off) assert.equal(fieldOf(spec, path), undefined, `${build}: #${id} is off, so ${path} must not be sent`);
      // The table the page is held to (contracts §5 A2), row by row.
      assert.deepEqual(hidden.map(([id]) => id).sort(), EXPECT_HIDDEN[build].slice().sort(), `${build}: the rows it hides`);
      for (const [id, path] of shown) {
        if (["covPrime", "covStem", "yAbcOpen"].includes(id) && !withScore) continue;   // they ride with a score only
        const got = fieldOf(spec, path);
        assert.notEqual(got, undefined, `${build}: #${id} is shown, so ${path} must be sent`);
        if (Object.hasOwn(EXPECT_VALUE, path)) assert.equal(got, EXPECT_VALUE[path], `${build}: ${path} carries the row's value`);
      }
      for (const [id, path] of hidden) {
        const alsoShown = shown.some(([, p2]) => p2 === path);
        if (!alsoShown) assert.equal(fieldOf(spec, path), undefined, `${build}: #${id} is hidden, so ${path} must not be sent`);
      }
      if (build === "yue2-gguf") {
        // The real door, with the real spec: nothing it would refuse or drop.
        assert.doesNotThrow(() => prepareGgufJob(JSON.parse(JSON.stringify(spec)), "agent:test"), `${build}${withScore ? " + score" : ""}`);
        const job = prepareGgufJob(JSON.parse(JSON.stringify(spec)), "agent:test");
        assert.equal(job.ggufOptions?.semantic_temperature, 0.9, "Performance temperature reaches the runtime");
        assert.equal(job.ggufOptions?.semantic_top_p, 0.9, "Performance top-p reaches the runtime");
        assert.equal(job.ggufOptions?.abc_temperature, withScore ? undefined : 0.8, "Planner temperature reaches the runtime only while a score is planned");
      }
      if (build === "yue2") {
        // The Python kit's branch of /api/generate reads each field the page sends.
        for (const k of Object.keys(spec).filter((k) => ["key", "bpm", "meter", "temperature", "topP", "planTemperature", "abcOpen", "coverOf", "cfgScale", "quantization", "narSteps", "cot", "abc"].includes(k))) {
          assert.match(INDEX, new RegExp(`body\\.${k}\\b`), `the kit's door reads body.${k}`);
        }
      }
      if (build === "yue2-comfy") {
        for (const k of ["key", "bpm", "meter", "abcOpen", "coverOf", "cfgScale", "quantization"]) {
          assert.equal(spec[k], undefined, `yue2-comfy is never sent ${k} (refused, or dropped, by that build)`);
        }
        if (comfyFields) assert.doesNotThrow(() => comfyFields(JSON.parse(JSON.stringify(spec)), { cot: spec.cot }), "the ComfyUI door takes the page's spec");
        else console.log("  (the yue2-comfy door check waits for server/music/yue2-comfy-input.js, the hotfix lane)");
      }
    }
  });
}

test("the per-build rows: kit-only, not-on-ComfyUI, and the melody pointer on the engines without a melody box", () => {
  const kitOnly = ["yKey", "yBpm", "yMeter"].every((id) => new RegExp(`<label for="${id}" data-engine="yue2" data-python-yue hidden>`).test(HTML))
    && /id="yAbcOpenLabel" data-python-yue hidden/.test(HTML)
    && /<label for="covPrime" data-humsong data-python-yue hidden>/.test(HTML) && /<label for="covStem" data-humsong data-python-yue data-covstem hidden>/.test(HTML);
  assert.ok(kitOnly, "key, tempo, meter, let-the-planner-continue and the cover prime are the Python kit's rows");
  assert.match(HTML, /<label for="yCfg" data-engine="yue2" data-no-comfy-yue hidden>Guidance<\/label>/);
  // "Let YuE2 hear the original's first N s" shows only while there is a prime (it read "first 0 s").
  {
    const p = page("yue2");
    fill(p, { withScore: true });
    p.byId.get("covPrime").value = "0";
    p.ctx.musicEnginePaint(); p.ctx.paintHumRows(false);
    assert.equal(visible(p.byId.get("covStem").parent), false, "no prime: the layer row is not shown");
    assert.equal(visible(p.byId.get("covPrime").parent), true, "...while the prime slider is");
    assert.equal(vm.runInContext("currentSpec(false)", p.ctx).coverOf, undefined, "...and nothing primes");
  }
  // The planner dial is off, with its reason, while Thinking is off on GGUF too.
  {
    const p = page("yue2-gguf");
    fill(p, { withScore: false });
    p.byId.get("yCot").value = "off";
    p.ctx.musicEnginePaint();
    assert.equal(p.byId.get("yPlanTemp").disabled, true);
    assert.match(p.byId.get("yPlanTempNote").textContent, /^off while Thinking is off: no score is planned$/);
    assert.equal(vm.runInContext("currentSpec(false)", p.ctx).planTemperature, undefined);
  }
  for (const [engine, shows] of [["minimax-music3", true], ["yue2", false], ["yue2-gguf", false], ["yue2-comfy", false]]) {
    const p = page(engine);
    p.ctx.musicEnginePaint();
    assert.equal(p.$("melodyPointer").hidden, !shows, `${engine}: the "Want a song to follow a melody you hum?" line`);
  }
  assert.match(HTML, /id="melodyPointer" hidden>Want a song to follow a melody you hum\? That is YuE2: <button type="button" class="edtool" id="melodyUseYue">Use YuE2<\/button>/);
});

test("Melody & score: the name, three plain lines, a Stop, the hint, and an example the reader accepts", async () => {
  assert.match(HTML, /id="yMusicPlan">\s*<summary>Melody &amp; score<\/summary>/);
  assert.ok(!/Advanced Options/.test(HTML), "no second \"Advanced\" on the Music screen");
  assert.match(HTML, /id="yAbcHow">Easiest: with Transcriber on Hum, press ● Record above, hum, press Stop, and the notes land in this box, ticked for Create\./);
  assert.doesNotMatch(HTML.slice(FORM_START, FORM_END), /demucs splits/, "no program name in the newcomer's words");
  assert.match(HTML, /id="humCancel" hidden title="Stop reading the notes">■ Stop<\/button>/);
  assert.match(HTML, /id="humHint">Hum: seconds\. Whole song: a minute or more/);
  assert.match(HTML, /<label for="humStem" data-humsong hidden>Read the tune from<\/label>/);
  assert.match(HTML, /<input type="checkbox" id="humStem"> its separated voice/, "not ticked by default");
  assert.match(HTML, /<label for="covStem" data-humsong data-python-yue data-covstem hidden>Let YuE2 hear the original's first <span id="covStemSecs">8 s<\/span>, from its<\/label>/);
  const m = /const MELODY_EXAMPLE = \[([\s\S]*?)\]\.join\("\\n"\) \+ "\\n";/.exec(APP);
  assert.ok(m, "the example is one array in web/app.js");
  const example = vm.runInNewContext(`[${m[1]}].join("\\n") + "\\n"`);
  const { parseScore } = await import("./mcp-music-score.js");
  const s = parseScore(example);
  assert.equal(s.ok, true, JSON.stringify(s.problems));
  assert.equal(s.voices.Vocal.bars.length, 4, "four bars");
  assert.ok(s.voices.Vocal.notes.length > 0 && s.voices.Ins.notes.length > 0, "two voices, both sounding");
});

test("the refusal hooks, the stem-separation python row, and Voice only off until stems are ready", () => {
  assert.match(APP, /if \(r\.setup && typeof offerSetup === "function"\) offerSetup\(r\.setup, r\.error\);\n\s+humSay\(r\.error/, "humSendSource offers the setup, then says the sentence");
  assert.match(APP, /body: JSON\.stringify\(\{ action: "run", file: decodeURIComponent\(st\.dataset\.stems\) \}\),\n\s+\}\)\.then\(\(r\) => r\.json\(\)\)\.then\(\(r\) => \{\n\s+if \(r\.error && r\.setup && typeof offerSetup === "function"\) offerSetup\(r\.setup, r\.error\);\n\s+else if \(r\.error\) alert\(r\.error\);/);
  for (const re of [/id="qStemsPy" spellcheck="false" data-setup-python="stems"/, /id="btnStemsPy">Use<\/button>/,
    /id="btnSetupStems" data-setup-feature="stems">Set up stem separation<\/button>/, /id="qSetupStemsTorch" data-setup-torch="stems"/,
    /id="setupStemsNote" data-setup-note="stems"/, /id="stemsPyNote"/, /<label for="qStemsPy">stem separation python<\/label>/]) {
    assert.match(HTML, re);
  }
  assert.match(APP, /JSON\.stringify\(\{ action: "python", value: \$\("qStemsPy"\)\.value\.trim\(\) \}\)/);
  assert.match(APP, /s\.config\.stems\.pythonSource === "env"/);
  assert.match(APP, /JSON\.stringify\(\{ action: "status", id: "stems" \}\)/);
  // Run the real painter: off while not ready, on once ready, the person's own tick stands.
  const box = { checked: true }, note = { hidden: true, textContent: "" }, eng = { value: "song" };
  const ctx = vm.createContext({ $: (id) => ({ humStem: box, humStemNote: note, humEngine: eng })[id], fetch: async () => ({ json: async () => ({}) }) });
  vm.runInContext(`${between("let humStemReady", '$("humStem")?.addEventListener')}
    this.set = (r, t) => { humStemReady = r; humStemTouched = t; }; this.paint = paintHumStem;`, ctx);
  ctx.set(null, false); ctx.paint();
  assert.equal(box.checked, false, "not asked yet: off"); assert.equal(note.hidden, true, "no sentence before the answer");
  ctx.set(false, false); ctx.paint();
  assert.equal(box.checked, false); assert.equal(note.hidden, false);
  assert.match(note.textContent, /stem separation isn't set up on this PC yet, so the whole mix is read\. Set it up in Settings > Songs\./);
  ctx.set(true, false); ctx.paint();
  assert.equal(box.checked, true, "ready: on"); assert.equal(note.hidden, true);
  box.checked = false; ctx.set(true, true); ctx.paint();
  assert.equal(box.checked, false, "the person's untick stands");
  // The stems_test expression is kept exactly.
  assert.match(APP, /stem: \$\("humStem"\)\?\.checked && source\.library_file \? "vocals" : undefined/);
  // The stems row by its id, never another setup's; and re-read when a setup finishes.
  assert.match(APP, /const row = \(r\?\.setups \|\| \[\]\)\.find\(\(s\) => s\.id === "stems"\);\n/);
  assert.doesNotMatch(between("async function readStemsReady()", "function paintHumStem()"), /\[0\]/);
  assert.match(APP, /paintSetupButtons\(null, \{ refresh: \(\) => \{ if \(typeof readStemsReady === "function"\) readStemsReady\(\); \} \}\)/);
});

test("the transcription's Stop reaches its own work, names anything else first, and says what it did", () => {
  const ctx = vm.createContext({});
  vm.runInContext(between("function humStopPlan(", '$("humCancel")?.addEventListener'), ctx);
  const song = { song: true, stem: true, file: "Storm.flac" };
  // A hum: nothing on the server.
  assert.deepEqual(ctx.humStopPlan({ song: false }, {}, {}).door, null);
  assert.equal(ctx.humStoppedSentence(ctx.humStopPlan({ song: false }, {}, {}), null), "Stopped.");
  // This song's separation, running: stop_current, nothing asked, nothing else touched.
  const sep = ctx.humStopPlan(song, { current: { kind: "stems", file: "Storm.flac", title: "Storm" }, items: [{ kind: "video", file: "Clip.flac" }] }, { current: { title: "Other" } });
  assert.equal(sep.door, "/api/artqueue"); assert.deepEqual({ ...sep.body }, { action: "stop_current" }); assert.equal(sep.others.length, 0);
  assert.match(ctx.humStoppedSentence(sep, { ok: true, stopped: "Storm", kind: "stems", stopping: true }), /^Stopped\. The voice separation is stopping, so the notes will not be read; nothing else was touched\.$/);
  assert.match(ctx.humStoppedSentence(sep, { ok: true, stopped: null }), /had just finished/);
  assert.match(ctx.humStoppedSentence(sep, { ok: true, stopped: "Cover of X", kind: "cover" }), /the Stop reached Cover of X, which had started after it/);
  // ...waiting: a drop of the file, and another waiting job of that file is named first.
  const wait = ctx.humStopPlan(song, { current: { kind: "video", file: "Clip.flac" }, items: [{ kind: "stems", file: "Storm.flac" }, { kind: "cover", file: "Storm.flac", title: "Storm" }] }, {});
  assert.equal(wait.door, "/api/artqueue"); assert.deepEqual({ ...wait.body }, { action: "drop", file: "Storm.flac" });
  assert.deepEqual([...wait.others], ["Storm (cover, waiting)"]);
  assert.match(ctx.humStoppedSentence(wait, { ok: true, removed: 2 }), /dropped, with 1 other waiting job of this song; nothing else was touched\.$/);
  // Reading the notes: /api/cancel, and the song, the running clip and the queue are named first.
  const read = ctx.humStopPlan({ ...song, stem: false }, { current: { kind: "video", title: "Clip A" }, items: [{ kind: "cover" }, { kind: "video" }] }, { current: { title: "Night" } });
  assert.equal(read.door, "/api/cancel");
  assert.deepEqual([...read.others], ['the song being made ("Night")', "Clip A (video, in progress)", "2 waiting picture, clip or stem jobs"]);
  assert.equal(ctx.humStoppedSentence(read, { artStopped: { wasRunning: "Clip A", stopping: false, dropped: 2 } }),
    "Stopped reading the notes. The song being made was stopped too. Stopped Clip A. Dropped 2 waiting jobs.");
  assert.equal(ctx.humStopPlan({ ...song, stem: false }, { items: [] }, {}).others.length, 0, "nothing else running: nothing to ask");
  assert.match(ctx.humStoppedSentence(read, null), /^Stopped waiting\. Studio did not confirm the stop/);
  // The handler: asks only when something else would stop, and re-checks after the question.
  const handler = between('$("humCancel")?.addEventListener', '$("humFile")?.addEventListener');
  assert.match(handler, /if \(plan\.others\.length && typeof appConfirm === "function"/);
  assert.match(handler, /\)\)\) return;\n[\s\S]*?if \(humRun !== run\) return;\n\s+run\.stopped = true;/, "an answer that arrived while the question was open is kept");
  assert.doesNotMatch(handler, /The separation and the transcription were stopped too/);
});

test("the Jobs page: stopping… while a stop is under way, stopped (not failed) after", () => {
  const box = { innerHTML: "" };
  const ctx = vm.createContext({ $: (id) => (id === "jobQueue" ? box : null), esc: (s) => String(s ?? ""),
    JOB_LABEL: { stems: "stems" }, jobDur: (ms) => `${Math.round(ms / 1000)}s` });
  vm.runInContext(between("function paintJobQueue(s)", 'document.addEventListener("click", async (e) => {\n  const drop'), ctx);
  ctx.paintJobQueue({ art: { current: { kind: "stems", title: "Storm", progress: 0.4, elapsed: 30, note: "model 2 of 4" }, items: [] } });
  assert.match(box.innerHTML, /40% · model 2 of 4 · 30s/);
  assert.doesNotMatch(box.innerHTML, /stopping/);
  ctx.paintJobQueue({ art: { current: { kind: "stems", title: "Storm", progress: 0.4, elapsed: 31, stopping: true }, items: [] } });
  assert.match(box.innerHTML, /<span class="jobms" title="stopping…">stopping…<\/span>/);
  assert.match(box.innerHTML, /data-stopcurrent="1" disabled/);
  assert.match(APP, /\$\{j\.cancelled \? `<span class="jobstopped" title="\$\{esc\(j\.error \|\| "Stopped before it finished\."\)\}">stopped<\/span>`/);
  assert.match(APP, /const failed = jobs\.filter\(\(j\) => j\.error && !j\.cancelled\)\.length;/);
  assert.match(APP, /a\.stopping \? `stopping \$\{a\.wasRunning\}…` : `stopped \$\{a\.wasRunning\}`/);
});

test("rights: the catalogue's own chip, the licence-file line, the reason a label changed, and add-ons that raised it", () => {
  const ctx = vm.createContext({ esc: (s) => String(s ?? "") });
  vm.runInContext(`${between("const RIGHTS_WORDS = {", "/** A capability's short rights words")}
    ${between("function rightsChipHtml(stamp, cap", "/** Chip for an asset, straight from its ledger summary.")}`, ctx);
  const yue = {
    label: "YuE2 3B", outputRights: {
      class: "yours-with-conditions", sellable: true, basis: "authors-statement",
      chip: "Sellable by individuals (YuE2 authors' statement, 15 Sep 2026) · companies need a commercial licence",
      short: "sellable by individuals", quote: "individuals may use it", clause: "discussion #5",
      url: "https://huggingface.co/m-a-p/YuE2-3B/discussions/5", conditions: ["Individuals …", "Companies need a commercial licence."],
      licenceFile: { name: "CC BY-NC 4.0", url: "https://creativecommons.org/licenses/by-nc/4.0/" },
      changed: { from: "not-for-sale", on: "2026-09-24", why: "Studio's label now follows the YuE2 authors' statement of 15 Sep 2026." },
    },
  };
  const now = ctx.rightsChipHtml({ class: "yours-with-conditions", capability: "musicYue2" }, yue);
  assert.match(now, />Sellable by individuals \(YuE2 authors' statement, 15 Sep 2026\) · companies need a commercial licence<\/button>/, "the row's own chip");
  assert.match(now, /The licence file still reads <a href="https:\/\/creativecommons\.org\/licenses\/by-nc\/4\.0\/"[^>]*>CC BY-NC 4\.0<\/a>/);
  assert.match(now, /Studio's label follows that statement/);
  assert.doesNotMatch(now, /rdrift/);
  const old = ctx.rightsChipHtml({ class: "not-for-sale", capability: "musicYue2" }, yue);
  assert.match(old, /Studio's label now follows the YuE2 authors' statement of 15 Sep 2026\. This file was stamped/, "the reason, not the generic warning");
  assert.doesNotMatch(old, /the ledger keeps what was true at the time/);
  assert.match(old, />Sellable by individuals/, "today's label on the chip");
  const raised = ctx.rightsChipHtml({ class: "not-for-sale", capability: "musicYue2" }, yue,
    { label: "Not for sale (model licence)", addOns: ["musicYue2Tokenizer"], catalog: { musicYue2Tokenizer: { label: "YuE2 real-audio tokenizer" } } });
  assert.match(raised, />Not for sale \(model licence\)<\/button>/);
  assert.match(raised, /Made with YuE2 real-audio tokenizer, whose own licence is stricter/);
  assert.doesNotMatch(raised, /rdrift/, "an add-on is not the catalogue moving under an old file");
  // The song panel, the Models card, the queue line, the export note and the receipt read those words.
  assert.match(APP, /rightsChipHtml\(\{ class: t\.rights\.class, capability: t\.rights\.capability, url: t\.rights\.url \},\n\s+cat\[t\.rights\.capability\]/);
  assert.match(HTML, /<div class="sprights" id="spRights" hidden><\/div>/);
  assert.match(APP, /const rightsOf = \(c\) => \(c\.outputRights\?\.class/);
  // A card whose licence stops at a border says "Where licensed", and names where.
  const h3 = { label: "MiniMax H3", region: { excluded: ["European Union", "United States of America"] },
    outputRights: { class: "yours-with-conditions", conditions: ["a", "b", "c", "d"], url: "https://example.invalid/h3" } };
  const h3chip = ctx.rightsChipHtml({ class: "yours-with-conditions", capability: "video" }, h3);
  assert.match(h3chip, />Where licensed: yours to sell — 4 conditions<\/button>/);
  assert.match(h3chip, /Not licensed in European Union, United States of America: these words hold only outside them\./);
  // A server label in the other vocabulary gets no page line claiming the licence bans sale.
  const serverWords = ctx.rightsChipHtml({ class: "not-for-sale", capability: "musicYue2Tokenizer" }, { label: "YuE2 real-audio tokenizer", outputRights: { class: "not-for-sale" } },
    { label: "Noncommercial (Studio policy)", addOns: ["musicYue2Tokenizer"], catalog: { musicYue2Tokenizer: { label: "YuE2 real-audio tokenizer" } } });
  assert.match(serverWords, />Noncommercial \(Studio policy\)<\/button>/);
  assert.doesNotMatch(serverWords, /bans commercial use of the material it generates/);
  assert.match(serverWords, /Made with YuE2 real-audio tokenizer, whose own licence is stricter/);
  assert.match(ctx.rightsChipHtml({ class: "not-for-sale", capability: "x" }, { outputRights: { class: "not-for-sale" } }),
    /bans commercial use of the material it generates/, "the page's own chip keeps its own line");
  assert.doesNotMatch(APP, /Q4_0"\} · non-commercial ·/, "the queue line no longer types a rights word of its own");
  assert.match(APP, /const says = rights \? ` Rights: \$\{rights\}\.` : "";/);
  assert.match(read("../web/receipt.js"), /if \(f\.id === "rights"\) return el\.dataset\?\.rightsShort \|\| null;/);
  // The short words mirror the server's rule: short, else the whole chip with its conditions.
  const words = vm.createContext({ Date, esc: (s) => String(s ?? "") });
  vm.runInContext(`let rightsCatalogCache = null; let rightsCatalogAsked = 0; let asked = 0;
    async function rightsCatalog() { asked++; return {}; }
    ${between("const RIGHTS_WORDS = {", "/* The receipt under Create reads its rights word")}
    this.set = (c) => { rightsCatalogCache = c; }; this.asked = () => asked;`, words);
  assert.equal(words.rightsShortOf("musicMinimax"), null, "not read yet");
  assert.equal(words.rightsShortOf("musicMinimax"), null);
  assert.equal(words.asked(), 1, "asked once, not on every poll");
  words.set({ musicMinimax: { outputRights: { class: "yours-with-conditions", conditions: [1, 2, 3, 4] } },
    musicYue2: { outputRights: { class: "yours-with-conditions", short: "sellable by individuals", chip: "Sellable by individuals (…)" } } });
  assert.equal(words.rightsShortOf("musicMinimax"), "yours to sell — 4 conditions");
  assert.equal(words.rightsShortOf("musicYue2"), "sellable by individuals");
  assert.match(APP, /if \(!Array\.isArray\(d\?\.capabilities\)\) return \{\};/, "an error reply is not cached as an empty catalogue");
  assert.match(between("async function rightsCatalog()", "/**\n * WHAT THE VIDEO ENGINE COSTS"), /catch \{ return \{\}; \}/, "nor is a failed read");
  assert.match(HTML, /<h3>Studio takes no rights in what you make; each model&rsquo;s licence decides whether you can sell it<\/h3>/);
});

test("R2: the audio reference says it is not a melody control; the ACE cover says what it is", () => {
  assert.match(HTML, /id="arefWhat">Borrows the sound of a recording, not its tune\. To follow your melody, use YuE2 → Melody &amp; score\.<\/p>/);
  assert.match(HTML, /id="aCoverHint">The song you give becomes a timbre and style reference \(experimental/);
});
