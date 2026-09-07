/**
 * THE REFERENCE OVERLAY, DRIVEN — the behavioural half of SPEC §7's web side.
 *
 * server/daw/voiceui_test.js is the STATIC census for web/voicelab.js: it
 * reads the source and holds it to shapes. That catches a knob name typed by
 * hand and a route with no dispatcher, and it cannot catch the one class of
 * bug this overlay is actually exposed to — a number that LOOKS measured.
 *
 * The first run of this file found one: the panel printed
 *
 *     t30   281 ms → —   ·   +281 ms
 *
 * differencing our real 281 ms against a reference t30 that was `null`,
 * because `Number(null)` is 0 and `Number.isFinite(0)` is true. A profile is
 * full of honest nulls — a t60 a kick never reaches, a loudness that could
 * not be measured — and turning one into a zero is exactly the gap-filling
 * the empty slot existed to prevent. No static check would ever have seen it.
 * So this file MOUNTS the real module in a stub browser and reads what it
 * drew.
 *
 * WHAT IS REAL HERE, AND WHAT IS A FIXTURE
 *   real       web/voicelab.js and web/dawear.js, unmodified, mounted and
 *              driven through their own listeners;
 *   real       the analysis block — `peaks.py voice` on a kick this file
 *              writes, so the nine bands, the 1/3-octave shares and the
 *              envelope are the server's own numbers, absent bands included;
 *   fixture    the profile, built here in the shape refprofile.py's
 *              ALLOWED_KEYS declares — but its band NAMES are lifted out of
 *              the real analysis rather than typed, so the alignment check
 *              is a real alignment and the mismatch case is a real mismatch;
 *   stub       the browser, and the four profile_* routes.
 *
 * The analysis half needs the rig's python (numpy) and SKIPS ITSELF LOUDLY
 * without it, as voicelab_test.js does.
 *
 * Run:  node server/daw/refui_test.js
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

/* The output root MUST be chosen before config.js is first imported, and
 * static imports hoist — so config and everything downstream of it (the real
 * profile store included) come in dynamically, below. voicelab_test.js does
 * the same thing for the same reason. */
const TMP = path.join(os.tmpdir(), `daw-refui-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = TMP;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "..", "web");
const { config } = await import("../config.js");
/* THE REAL ROUTE HALF. Three of the four profile actions are pure disk — list,
 * get, delete — so this suite drives the page against refprofile.js itself
 * rather than a stub of it, and the page's field reads (`profiles`, `dir`,
 * `profile`, and a list row's `name`/`seconds`) are checked against the shapes
 * the server really answers with. Only `profile_build` is stubbed, because it
 * runs demucs on the app's idle-drain queue. */
const rp = await import("./refprofile.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

/* ══════════════════════════ THE STUB BROWSER ═══════════════════════════
 * Not a DOM library and not trying to be. Enough of one that the real module
 * mounts, and every canvas call and every fetch is RECORDED, so an assertion
 * can be about the picture and the traffic rather than about the source. */

function makeDom() {
  const ops = [];
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.children = []; this.parentNode = null;
      this._text = ""; this._class = ""; this._html = "";
      this.value = "";                       // a real input/select has "", not undefined
      this.style = { setProperty() {}, cssText: "" };
      this.dataset = {}; this.hidden = false; this.disabled = false;
      this._on = new Map();
      this.classList = {
        add: (...c) => { for (const x of c) if (!this._cls().includes(x)) this._class = `${this._class} ${x}`.trim(); },
        remove: (...c) => { this._class = this._cls().filter((x) => !c.includes(x)).join(" "); },
        toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)),
        contains: (c) => this._cls().includes(c),
      };
    }
    _cls() { return this._class.split(/\s+/).filter(Boolean); }
    get className() { return this._class; }
    set className(v) { this._class = String(v ?? ""); }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; }
    set textContent(v) { this._text = String(v ?? ""); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v ?? ""); this._text = this._html.replace(/<[^>]*>/g, ""); this.children = []; }
    get childElementCount() { return this.children.length; }
    get options() { return this.children.filter((c) => c.tagName === "OPTION"); }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) if (c && typeof c === "object") this.appendChild(c); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
    setAttribute(k, v) { this[k] = v; }
    addEventListener(t, fn) { if (!this._on.has(t)) this._on.set(t, []); this._on.get(t).push(fn); }
    removeEventListener(t, fn) { this._on.set(t, (this._on.get(t) || []).filter((f) => f !== fn)); }
    dispatchEvent(e) { for (const fn of this._on.get(e.type) || []) fn(e); return true; }
    fire(t, e = {}) { return this.dispatchEvent({ type: t, preventDefault() {}, ...e }); }
    setPointerCapture() {} releasePointerCapture() {}
    getBoundingClientRect() { return { width: 480, height: 240, left: 0, top: 0 }; }
    getContext() {
      const rec = (name) => (...args) => ops.push({ cv: this.id, name, args });
      return {
        setTransform: rec("setTransform"), clearRect: rec("clearRect"), beginPath: rec("beginPath"),
        moveTo: rec("moveTo"), lineTo: rec("lineTo"), stroke: rec("stroke"), fillRect: rec("fillRect"),
        fillText: rec("fillText"), setLineDash: rec("setLineDash"), save: rec("save"),
        restore: rec("restore"), translate: rec("translate"),
        set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {}, set font(v) {}, set textAlign(v) {},
      };
    }
    all() { return [this, ...this.children.flatMap((c) => c.all())]; }
    find(p) { return this.all().find(p) || null; }
  }
  const doc = new Node("body");
  doc.head = new Node("head");
  doc.body = doc;
  doc.documentElement = new Node("html");
  doc.readyState = "loading";           // so the module does NOT self-mount
  doc.createElement = (t) => new Node(t);
  doc.getElementById = (id) => doc.find((n) => n.id === id) || doc.head.find((n) => n.id === id);
  doc.querySelector = (s) => (s.startsWith(".") ? doc.find((n) => n.classList.contains(s.slice(1)))
    : s.startsWith("link") ? doc.head.find((n) => n.tagName === "LINK") : null);
  doc.addEventListener = () => {};
  return { doc, ops };
}

function installGlobals(doc, fetchImpl, onConfirm) {
  const calls = [];
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.devicePixelRatio = 1;
  globalThis.innerHeight = 900;
  globalThis.confirm = onConfirm;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.setInterval = () => 0;      // the panels' 1 Hz follow never runs here
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const r = await fetchImpl(url, body);
    return { ok: true, status: 200, json: async () => r };
  };
  return calls;
}

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
/* Canvas ops carry an id only on the call that follows fitCanvas; walk them
 * in order and attribute each to the canvas last drawn on. */
const opsOn = (ops, id) => {
  const out = []; let cur = null;
  for (const o of ops) { if (o.cv) cur = o.cv; if (cur === id) out.push(o); }
  return out;
};
const textsOn = (ops, id) => opsOn(ops, id).filter((o) => o.name === "fillText").map((o) => o.args[0]);
const dashRuns = (ops, id) => {
  /* the module's own reference dash is [4, 3]; the dB grid uses [3, 3] and
   * [2, 4], so counting by the pattern separates ours from theirs */
  let on = false, pts = 0, runs = 0;
  for (const o of opsOn(ops, id)) {
    if (o.name === "setLineDash") {
      const isRef = o.args[0]?.[0] === 4 && o.args[0]?.[1] === 3;
      if (isRef && !on) runs++;
      on = isRef;
    } else if (on && (o.name === "lineTo" || o.name === "moveTo")) pts++;
  }
  return { runs, pts };
};

/* ═══════════════════════ THE REAL ANALYSIS BLOCK ═══════════════════════ */

mkdirSync(TMP, { recursive: true });

/** 16-bit mono PCM, written by hand — no dependency, and the bytes are ours. */
function writeWav(file, samples, sr = 48000) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  writeFileSync(file, b);
}

/** A kick: a swept fundamental, an exponential body, a short transient. */
function kick(seconds, decay) {
  const sr = 48000, n = Math.round(sr * seconds), x = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += 2 * Math.PI * (120 * Math.exp(-t / 0.02) + 42) / sr;
    x[i] = Math.tanh((Math.sin(ph) * Math.exp(-t / decay)) * 1.6) * 0.9;
  }
  return x;
}

const havePy = existsSync(config.python);
let LONG = null, SHORT = null;
if (!havePy) {
  console.log(`\n  -- SKIPPING: no python at ${config.python}`);
  console.log("     (the analysis block is measured by server/daw/peaks.py, which needs numpy;");
  console.log("      set AIPLAY_RIG or AIPLAY_PY to run this suite)");
} else {
  const analyse = (name, secs, dec) => {
    const f = path.join(TMP, `${name}.wav`);
    writeWav(f, kick(secs, dec));
    return JSON.parse(execFileSync(config.python, [path.join(HERE, "peaks.py"), "voice", f],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  };
  LONG = analyse("long", 0.75, 0.085);
  SHORT = analyse("short", 0.20, 0.030);
}

if (havePy) {
  console.log("\n  -- the analysis under test is the server's own measurement --");
  ok(`peaks.py measured a ${(LONG.samples / LONG.rate * 1000).toFixed(0)} ms kick: `
    + `nine bands, ${LONG.third_octave.mid.bands.length} third-octaves, an envelope`,
  LONG.spectrum.band_names.length === 9 && LONG.third_octave.mid.bands.length > 20
    && LONG.envelope.mid.db.length > 100);
  const absent = LONG.spectrum.per_channel.mid.bands.filter((b) => b.absent).length;
  ok(`...and a kick really does have absent bands (${absent} of 9), which is what makes `
    + "the absent-on-either-side case a real case and not a contrived one", absent >= 3);
  ok(`...and the short render's t60 is honestly null (${SHORT.envelope.mid.t60_ms}), which is `
    + "what makes the null-difference case real", SHORT.envelope.mid.t60_ms === null);
}

/* ═══════════════════════════ THE PROFILE ═══════════════════════════════
 * Built here, in refprofile.py's declared shape. Its band NAMES come out of
 * the real analysis rather than being typed, so `refBands`'s name alignment
 * is checked against the thing it will really meet. */

function makeProfile(analysis, over = {}) {
  const names = analysis.spectrum.band_names;
  const bandRows = (bias) => names.map((name, i) => ({
    band: analysis.spectrum.band_labels[i], band_index: i, name,
    observed_db: -20 + i, reference_db: -8, deviation_db: bias[i] ?? 0,
    level_db: -26, absent: (bias[i] ?? 0) === null,
  })).map((r) => (r.absent ? { ...r, deviation_db: -40 } : r));
  const thirds = analysis.third_octave.mid.bands
    .slice(0, analysis.third_octave.mid.bands.length - 1)      // theirs stops lower: 44.1 kHz
    .map((r) => ({ lo: r.lo, hi: r.hi, centre: r.hz, share_db: r.share_db - 2 }));
  const stem = (bias) => ({
    loudness: { lufs: -9.1, true_peak_db: -0.2, lufs_available: true, peak_db: -0.1,
      rms_db: -14.2, crest_db: 14.1 },
    level_rel_mix_db: -8, bands: { genre: "neutral", reference: "pink", loudest_band_db: -26,
      bands: bandRows(bias) },
    third_octave: thirds,
    stereo: { width: 0.123, correlation: 0.97, mid_rms_db: -24.2, side_rms_db: -42.4, mono_compatible: true },
    width_per_band: names.map((name, i) => ({ band: analysis.spectrum.band_labels[i], name, width: 0.05, side_over_mid_db: -25 })),
  });
  return {
    id: "fixture", name: "A Record", source: "demucs htdemucs_ft stems",
    sr: 48000, source_sr: 44100, resampled_from: 44100,
    resample_note: "resampled 44100 -> 48000 with scipy polyphase 160/147 before measuring, "
      + "because rack.k_weight is pinned at 48 kHz",
    seconds: 127.95, mix_source: "stem sum", warnings: [],
    stems: {
      /* one dB of difference per band, so every delta is a number this file
       * can also compute and compare against */
      drums: stem([1, -2, 3, -4, 5, -6, 7, -8, 9]),
      bass: stem([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      other: stem([2, 2, 2, 2, 2, 2, 2, 2, 2]),
      vocals: stem([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    },
    master: stem([0, 1, 0, 1, 0, 1, 0, 1, 0]),
    kick: {
      onsets: 75, f0_hz: 33.776, f0_hits: 75,
      shape: {
        hits: 75, ioi_s: 0.6415, implied_bpm: 93.52, attack_ms: 1.0,
        t10_ms: 117.7, t30_ms: null, t60_ms: null,     /* the honest nulls */
        envelope_db: Array.from({ length: 350 }, (_, i) => -(i / 349) * 44),
        envelope_hop_ms: 0.998,
      },
      click: { click_over_body_db: -19.19, hits: 75 },
      sub_over_kick_db: 2.18,
      /* THE GRID GATE'S VERDICT. Ungated flux peaks read 442 BPM on a real
       * track, and every number under this one depends on the beat — so the
       * panel treats `gated: false` as a warning on its face, and the case
       * below proves it does. */
      grid: { gated: true, period_s: 0.6415, implied_bpm: 93.52, tolerance_frac: 0.12,
        raw_peaks: 152, kept: 75, why: null, salience: 0.61 },
    },
    pump: { hits: 75, depth_db: -14.92, depth_mad_db: 12.08, recovery_ms: 120.7,
      recovery_frac_of_beat: 0.188, beat_s: 0.6415 },
    ...over,
  };
}

/* ═════════════════════════ DRIVE THE VOICE LAB ═════════════════════════ */

if (havePy) {
  /* THE FIXTURE CANNOT DRIFT INTO A SHAPE THE SERVER WOULD REFUSE TO EMIT.
   * refprofile.py's check_shape_only is the promise that a profile is a shape
   * and never a sample, and it runs on every real build; running it on this
   * file's fixture is what keeps the fixture a profile rather than a JSON
   * object that happens to look like one. */
  const fx = path.join(TMP, "fixture.json");
  writeFileSync(fx, JSON.stringify(makeProfile(LONG)), "utf8");
  let shapeOk = "";
  try {
    execFileSync(config.python, ["-c",
      "import json,sys; sys.path.insert(0, sys.argv[1]); import refprofile as R; "
      + "R.check_shape_only(json.load(open(sys.argv[2]))); print('ok')",
      HERE, fx], { encoding: "utf8" });
    shapeOk = "ok";
  } catch (err) { shapeOk = String(err.stderr || err.message).trim().split("\n").pop(); }
  console.log("\n  -- the fixture is a profile refprofile.py would agree to emit --");
  ok("every key in it is in refprofile.ALLOWED_KEYS and no array is longer than the cap "
     + "— checked by the python's OWN check_shape_only, not by a copy of its rules here",
  shapeOk === "ok", shapeOk);

  const { doc, ops } = makeDom();
  const pane = doc.createElement("div"); pane.id = "paneVoice"; doc.appendChild(pane);
  const tabEl = doc.createElement("button"); tabEl.id = "tabVoice"; doc.appendChild(tabEl);

  let PROFILE = makeProfile(LONG);
  let ANALYSIS = LONG;
  let confirmed = 0;
  /* The profile really goes on disk, under the temp output root, and the three
   * read/delete actions really go through refprofile.js. `writeOne` is the
   * only place this file touches that store. */
  const { mkdir, writeFile } = await import("node:fs/promises");
  const writeOne = async (prof) => {
    await mkdir(rp.profilesDir(), { recursive: true });
    await writeFile(path.join(rp.profilesDir(), `${prof.id}.json`), JSON.stringify(prof), "utf8");
  };
  await writeOne(PROFILE);
  const PROJECT = {
    slug: "ref-probe", updatedAt: "x",
    tracks: [{ id: "t_kick", name: "Kick", instrument: { patch: "hybrid_kick", params: {} } }],
  };
  const { PATCHES } = await import("./store.js");
  const rows = Object.entries(PATCHES).map(([id, r]) => ({
    id, family: r.family, params: r.params || null, presets: r.presets || null,
  }));

  let buildReply = null;                    // the one stubbed route
  const calls = installGlobals(doc, async (url, body) => {
    if (String(url).startsWith("/api/daw/patches")) return { patches: rows };
    if (String(url).startsWith("/api/daw/project/")) return { project: PROJECT };
    if (body?.action === "voice_lab") {
      return { ok: true, file: "pv.wav", cached: false, render_ms: 6, lane: "fast", analysis: ANALYSIS };
    }
    if (body?.action === "profile_build") return buildReply;
    /* THE REAL DISPATCHER, and its real errors: routes.js turns a throw into
     * {error}, so this does too — the page's failure paths are then the ones
     * a person would really meet. */
    try { return await rp.handleProfileAction(body.action, body, { config }); }
    catch (err) { return { error: err.message }; }
  }, () => { confirmed++; return true; });

  const { mountVoiceLab } = await import(pathToFileURL(path.join(WEB, "voicelab.js")).href);
  const H = mountVoiceLab({ host: pane, getSlug: () => "ref-probe", getTrackId: () => "t_kick" });
  const selBy = (re) => doc.find((n) => n.tagName === "SELECT" && re.test(n.title || ""));
  const profSel = selBy(/reference profile drawn behind/);
  const stemSel = selBy(/which of the reference's blocks/);
  const btn = (t) => doc.find((n) => n.tagName === "BUTTON" && n.textContent === t);
  const one = (c) => doc.find((n) => n.classList.contains(c));
  const overCv = doc.getElementById("vlOverlay");
  const pick = async (id) => { profSel.value = id; profSel.fire("change"); await wait(60); };
  const setStem = async (id) => { stemSel.value = id; stemSel.fire("change"); await wait(40); };

  console.log("\n  -- it mounts, and with no profile it draws nothing and says why --");
  ok("the panel mounted, and before the first open the picker is honestly empty — the "
     + "library is not read until the tab is opened", !!H
    && profSel.options.map((o) => o.value).join(",") === "");
  H.show(true);
  await wait(80);
  ok("opening it reads the library once, and the picker offers it plus `no reference`",
    profSel.options.map((o) => o.value).join(",") === ",fixture"
    && calls.filter((c) => c.body?.action === "profile_list").length === 1);
  ok("the overlay canvas is hidden and the slot is words", overCv.hidden
    && /Nothing measured to compare this against/.test(one("vl-slot").textContent));
  ok("...and those words name the route that would fill it and what it is made of",
    /profile_build/.test(one("vl-slot").textContent)
    && /demucs/.test(one("vl-slot").textContent));

  console.log("\n  -- picking one: ONE profile_get, and every curve is theirs --");
  ops.length = 0;
  const before = calls.length;
  await pick("fixture");
  ok("exactly one call, and it is profile_get",
    calls.length - before === 1 && calls[calls.length - 1].body.action === "profile_get");
  ok("the overlay canvas is no longer hidden", !overCv.hidden);
  {
    const d = dashRuns(ops, "vlSpec");
    ok(`the 1/3-octave curve behind ours has exactly the profile's own ${PROFILE.stems.drums.third_octave.length} `
      + `points (${d.pts}), in one run`, d.runs === 1 && d.pts === PROFILE.stems.drums.third_octave.length);
    ok("...and it is named on the picture, with which stem it is",
      textsOn(ops, "vlSpec").some((t) => /dashed = drums of A Record/.test(t)));
    ok("the nine bands carry the reference as a line, and the caption says so",
      textsOn(ops, "vlSpec").some((t) => /the line across each band is the reference/.test(t)));
  }

  console.log("\n  -- the distance is a subtraction this file can also do --");
  {
    const mine = LONG.spectrum.per_channel.mid.bands;
    const theirs = PROFILE.stems.drums.bands.bands;
    const hand = mine.map((m, i) => (m.absent || theirs[i].absent ? null : m.deviation_db - theirs[i].deviation_db));
    const live = hand.filter((d) => d !== null);
    const nearN = live.filter((d) => Math.abs(d) <= 3).length;
    const worst = live.reduce((a, d) => (Math.abs(d) > Math.abs(a) ? d : a), 0);
    const cap = textsOn(ops, "vlOverlay").find((t) => /within 3 dB/.test(t)) || "";
    ok(`the caption's count is the one computed here (${nearN} of ${live.length})`,
      cap.includes(`${nearN} of ${live.length} within 3 dB`), cap);
    const m = /worst ([a-z-]+) ([+-]?[\d.]+)/.exec(cap);
    ok(`...and so is the worst band (${mine[hand.indexOf(worst)].name} ${worst.toFixed(1)})`,
      !!m && m[1] === mine[hand.indexOf(worst)].name && near(Number(m[2]), worst, 0.06), cap);
    const bars = opsOn(ops, "vlOverlay").filter((o) => o.name === "fillRect").length;
    ok(`one bar per band that HAS a distance, and no bar for the ${9 - live.length} that do not`,
      bars === live.length, `${bars} bars, ${live.length} live deltas`);
    ok("...and the absent ones are marked rather than left blank",
      textsOn(ops, "vlOverlay").filter((t) => t === "—").length === 9 - live.length);
  }

  console.log("\n  -- THE BUG THIS FILE EXISTS FOR: a null is not a zero --");
  {
    /* BOTH tables: the differenced one and the targets one. Reading only the
     * first is how the width row went missing from this check's first draft. */
    const rowsOut = [];
    for (const t of doc.all().filter((n) => n.classList.contains("vl-nums"))) {
      for (let i = 0; i < t.children.length; i += 3) {
        rowsOut.push([t.children[i].textContent, t.children[i + 1].textContent, t.children[i + 2].textContent]);
      }
    }
    const t30 = rowsOut.find((r) => r[0] === "t30");
    const t10 = rowsOut.find((r) => r[0] === "t10");
    ok("their t30 is null, so the panel prints an em dash and NOT a difference",
      PROFILE.kick.shape.t30_ms === null && /→ —$/.test(t30[1]) && t30[2] === "not both measured",
      JSON.stringify(t30));
    ok("...while t10, which both sides really have, IS differenced, and correctly",
      near(Number(/(-?\d+) ms$/.exec(t10[2])[1]),
        Math.round(LONG.envelope.mid.t10_ms) - Math.round(PROFILE.kick.shape.t10_ms), 1.01),
      JSON.stringify(t10));
    const labels = rowsOut.map((r) => r[0]);
    ok("level, loudness and width appear as the reference's own numbers, never as a delta",
      ["width", "correlation", "level vs their mix"].every((k) => labels.includes(k))
      && rowsOut.filter((r) => ["width", "correlation", "level vs their mix"].includes(r[0]))
        .every((r) => !/^[+-]/.test(r[2])));
    ok("...and the mono render says its own width is exactly zero rather than leaving it blank",
      /ours is exactly 0/.test(rowsOut.find((r) => r[0] === "width")[2]));
    ok("the footer says in words why the two curves share an axis and the rest does not",
      /never differenced/.test(one("vl-foot").textContent)
      && /minutes of a finished record/.test(one("vl-foot").textContent));
  }

  console.log("\n  -- a render shorter than their envelope is CUT, and the cut is named --");
  ANALYSIS = SHORT;
  ops.length = 0;
  H.render();
  await wait(80);
  {
    const ourSpan = (SHORT.envelope.mid.db.length - 1) * SHORT.envelope.mid.db_hop_ms;
    const theirSpan = (PROFILE.kick.shape.envelope_db.length - 1) * PROFILE.kick.shape.envelope_hop_ms;
    const d = dashRuns(ops, "vlEnv");
    const want = PROFILE.kick.shape.envelope_db.filter((_, i) => i * PROFILE.kick.shape.envelope_hop_ms <= ourSpan).length;
    ok(`theirs is ${theirSpan.toFixed(0)} ms and our render is ${ourSpan.toFixed(0)} ms, so `
      + `${want} of ${PROFILE.kick.shape.envelope_db.length} points are drawn and the rest are not`,
    d.pts === want, `${d.pts} drawn, wanted ${want}`);
    ok("...and the label says it was cut, and to where it really runs",
      textsOn(ops, "vlEnv").some((t) => new RegExp(`cut at ${ourSpan.toFixed(0)} ms, it runs to ${theirSpan.toFixed(0)}`).test(t)));
  }
  ANALYSIS = LONG; H.render(); await wait(60);

  console.log("\n  -- which stem, and the three ways there is nothing to draw --");
  ok("auto followed the patch's family: hybrid_kick is a drums patch, so it reads drums",
    /vs drums \(auto, family drums\)/.test(one("vl-refnote").textContent));
  ops.length = 0;
  await setStem("bass");
  ok("forced to bass, the ENVELOPE overlay goes away and says why — a profile measures "
    + "one envelope, off its drums stem",
  dashRuns(ops, "vlEnv").pts === 0
    && textsOn(ops, "vlEnv").some((t) => /one envelope, off its drums stem/.test(t)));
  ok("...while the SPECTRUM still overlays, because bass is a stem it has",
    dashRuns(ops, "vlSpec").pts > 0);
  {
    const p2 = makeProfile(LONG);
    delete p2.stems.vocals;
    PROFILE = p2; await writeOne(p2);
    await pick("");
    await pick("fixture");
    ops.length = 0;
    await setStem("vocals");
    ok("a stem the profile does not carry draws nothing anywhere, and both the picture "
      + "and the provenance line name it",
    dashRuns(ops, "vlSpec").pts === 0 && overCv.hidden
      && textsOn(ops, "vlSpec").some((t) => /no vocals block in this profile/.test(t))
      && /no vocals block in this profile/.test(one("vl-refnote").textContent));
    ok("...and the slot goes back to the words rather than showing stale numbers",
      /Nothing measured to compare this against/.test(one("vl-slot").textContent));
  }
  {
    const p3 = makeProfile(LONG);
    p3.stems.drums.bands.bands = p3.stems.drums.bands.bands.slice(0, 7);   // not ear.py's nine
    PROFILE = p3; await writeOne(p3);
    await pick(""); await pick("fixture");
    ops.length = 0;
    await setStem("auto");
    ok("a profile whose nine bands are not ear.py's loses the LINE on the bars and the "
      + "distance card, and says so",
    opsOn(ops, "vlOverlay").filter((o) => o.name === "fillRect").length === 0 && overCv.hidden
      && textsOn(ops, "vlSpec").some((t) => /nine bands are not ear\.py's/.test(t)));
    ok("...but keeps the 1/3-octave curve, which is plotted by FREQUENCY and cannot be "
      + "put out of step by an index",
    dashRuns(ops, "vlSpec").pts === p3.stems.drums.third_octave.length);
  }
  PROFILE = makeProfile(LONG); await writeOne(PROFILE);
  await pick(""); await pick("fixture"); await setStem("auto");

  console.log("\n  -- the other two routes, and what they leave behind --");
  {
    const f = doc.find((n) => n.classList.contains("vl-file"));
    f.value = "D:/refs/example.wav";
    /* A build that is still separating: the server answers pending with a
     * sentence and writes nothing, and the panel must not claim a profile. */
    buildReply = { ok: true, built: false, pending: true, stem_dir: "…",
      note: "The separation is queued but had not finished after 90 s." };
    btn("build").fire("click");
    await wait(80);
    ok("a build that is still separating is NOT called built: the server's own "
       + "sentence is shown and the file stays in the box to ask again with",
    /separation is queued/.test(one("vl-refnote").textContent)
      && f.value === "D:/refs/example.wav"
      && !profSel.options.some((o) => o.value === "built"), one("vl-refnote").textContent);
    const built = makeProfile(LONG, { id: "built", name: "built", warnings: ["demucs ran on a 30 s clip"] });
    await writeOne(built);
    buildReply = { ok: true, built: true, id: "built", warnings: built.warnings };
    btn("build").fire("click");
    await wait(80);
    const b = calls.filter((c) => c.body?.action === "profile_build").pop();
    ok("build posts the file and nothing else, stamped by:\"user\"",
      JSON.stringify(b.body) === JSON.stringify({ by: "user", action: "profile_build", file: "D:/refs/example.wav" }),
      JSON.stringify(b.body));
    ok("...and the new profile is in the picker and is the one now picked",
      profSel.options.some((o) => o.value === "built") && profSel.value === "built");
    ok("...and the warnings the build carried are shown, not swallowed",
      /1 warning/.test(one("vl-refnote").textContent), one("vl-refnote").textContent);
  }
  {
    await pick("fixture");
    const c0 = confirmed;
    btn("✕").fire("click");
    await wait(60);
    ok("delete ASKS first, and the question is asked once", confirmed === c0 + 1);
    ok("...then the profile is really gone from the real store, and only that one",
      !existsSync(path.join(rp.profilesDir(), "fixture.json"))
      && existsSync(path.join(rp.profilesDir(), "built.json")));
    ok("...and the panel goes back to the words, with the canvas hidden",
      overCv.hidden && /Nothing measured/.test(one("vl-slot").textContent));
  }

  console.log("\n  -- the grid gate's verdict travels with every number under it --");
  {
    const ungated = makeProfile(LONG, { id: "ungated", name: "ungated" });
    ungated.kick.grid = { gated: false, why: "no lag in 0.30-1.00 s carried enough salience",
      raw_peaks: 152, kept: 152 };
    await writeOne(ungated);
    await pick(""); await pick("ungated");
    ok("a profile whose beat grid did not gate says so on its face — the 442-BPM read is "
       + "a warning a person sees, not a field somebody could go and look up",
    /the beat grid did not gate/.test(one("vl-refnote").textContent)
      && one("vl-refnote").className.includes("vl-warn"), one("vl-refnote").textContent);
    ok("...and the profiler's own explanation of WHY is in the tooltip, verbatim and "
       + "whole — on the line it is a paragraph that eats the pictures",
    /no lag in 0\.30-1\.00 s carried enough salience/.test(one("vl-refnote").title)
      && !/no lag in 0\.30-1\.00 s/.test(one("vl-refnote").textContent));
    await pick(""); await pick("fixture");
    ok("...and a gated one carries no such warning",
      !/did not gate/.test(one("vl-refnote").textContent));
  }

  console.log("\n  -- nothing off a profile is ever written as markup --");
  {
    const evil = makeProfile(LONG, { name: "<img src=x onerror=1>", source: "<script>" });
    PROFILE = evil; await writeOne(evil);
    await pick(""); await pick("fixture");
    const html = doc.all().map((n) => n.innerHTML).join("");
    ok("a profile whose name is markup lands as TEXT — the only innerHTML in the module "
      + "is its own literal empty-state paragraph",
    !html.includes("<img") && !html.includes("<script")
      && doc.all().filter((n) => n.innerHTML).length === 1);
    ok("...and the name is still shown, verbatim, where it belongs",
      one("vl-refnote").textContent.length > 0
      && doc.all().some((n) => n.textContent.includes("<img src=x onerror=1>")));
  }

  console.log(`\n        (traffic: ${(() => {
    const t = {}; for (const c of calls) { const k = c.body?.action || c.url; t[k] = (t[k] || 0) + 1; }
    return Object.entries(t).map(([k, v]) => `${k}×${v}`).join(", ");
  })()})`);
}

/* ═══════════════════════ DRIVE THE EAR'S ROW ═══════════════════════════
 * No python needed: the Ear's reference row is a picker and one field on a
 * body, and both are checked by driving the real panel. */

console.log("\n  -- the Ear's reference row: it changes nothing until it is used --");
{
  const runEar = async (lib) => {
    const { doc } = makeDom();
    let last = null;
    const calls = installGlobals(doc, (url, body) => {
      if (String(url).endsWith("/ear/status")) return { ok: true, ready: true };
      if (body?.action === "profile_list") {
        return lib === null ? { error: "unknown action profile_list" } : { ok: true, profiles: lib };
      }
      if (body?.action === "critique") { last = body; return { ok: true, run: "r", cards: [], notes: [], measure: {}, score: 1, ms: 1 }; }
      return { error: "no" };
    }, () => true);
    const { mountEar } = await import(`${pathToFileURL(path.join(WEB, "dawear.js")).href}?lib=${lib === null ? "none" : lib.length}`);
    mountEar({ getSlug: () => "s" });
    doc.find((n) => n.classList.contains("ear-fab")).fire("click");
    await wait(60);
    const listen = () => doc.find((n) => n.tagName === "BUTTON" && n.textContent === "Listen to this mix");
    const sel = () => doc.find((n) => n.tagName === "SELECT" && /reference profile/.test(n.title || ""));
    const notes = () => doc.all().filter((n) => n.classList.contains("ear-note")).map((n) => n.textContent);
    return { doc, calls, sel, listen, notes, body: () => last, wait };
  };

  const none = await runEar(null);
  none.listen().fire("click");
  await wait(60);
  ok("with no reference route on the tree there is no picker at all, and the note says "
    + "the critique measures against the pink null alone, as it always did",
  !none.sel() && none.notes().some((t) => /No reference library on this machine/.test(t)));
  ok("...and the critique body carries no `profile` key — picking nothing changes nothing",
    !!none.body() && !("profile" in none.body()),
    JSON.stringify(none.body()));

  const empty = await runEar([]);
  ok("with a library and nothing in it, the note names where profiles come from and what "
    + "a profile is not",
  !empty.sel() && empty.notes().some((t) => /No reference profiles yet/.test(t))
    && empty.notes().some((t) => /never its audio and never its melody/.test(t)));

  const two = await runEar([{ id: "a", name: "A Record" }, { id: "b", name: "Another" }]);
  ok("with two, the picker offers them plus `no reference`, and `no reference` is the default",
    two.sel().options.map((o) => o.value).join(",") === ",a,b" && two.sel().value === "");
  two.listen().fire("click");
  await wait(60);
  const plain = JSON.stringify(two.body());
  ok("a critique with nothing picked posts the body every critique before this posted",
    !("profile" in two.body()), plain);
  two.sel().value = "b";
  two.sel().fire("change");
  await wait(30);
  two.listen().fire("click");
  await wait(60);
  ok("a critique with one picked carries it as ONE id on that SAME body — no second call "
    + "that could disagree with it",
  two.body().profile === "b"
    && JSON.stringify({ ...two.body(), profile: undefined }) === JSON.stringify({ ...JSON.parse(plain), profile: undefined }),
  JSON.stringify(two.body()));
  ok("...and the note under it says what that means and what a profile is not",
    two.notes().some((t) => /style target, not a copy/.test(t)));
  ok("the library is read through /api/daw (the profile door), while everything else the "
    + "panel does still goes to /api/daw/ear",
  two.calls.filter((c) => c.url === "/api/daw").every((c) => c.body.action === "profile_list")
    && two.calls.some((c) => c.url === "/api/daw/ear" && c.body.action === "critique"));
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* a temp dir */ }

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
