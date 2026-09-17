/**
 * THE VOICE LAB — the panel. "maybe it would be good to have a visual wave of
 * each of the sounds you can tweak them" (SPEC §3), literally.
 *
 * Pick a track, and one note of its real instrument is rendered on the server
 * and drawn four ways: the WAVEFORM, the SPECTRUM (the Ear's own nine bands
 * plus a 1/3-octave curve), the dB ENVELOPE with t10/t30/t60 marked, and — once
 * a reference PROFILE is picked — the DISTANCE between this voice and that
 * reference's matching stem, band by band. Every knob the patch declares is a
 * slider; turning one re-renders and redraws, and the panel prints how long
 * that took.
 *
 * ── THE PATTERN, from web/dawear.js ───────────────────────────────────────
 * One self-contained module. It builds its own DOM, loads its own stylesheet,
 * draws its own pixels and talks only to routes the MCP tools also call. It is
 * NOT imported by daw.js — that file is 241 KB already — so daw.html loads it
 * as its own module script and it mounts itself into the dock pane left for
 * it. A host that would rather drive it can `import { mountVoiceLab }` and
 * call it; the guard below makes the two safe together.
 *
 * ── THE FOUR THINGS THIS PANEL REFUSES TO PRETEND ─────────────────────────
 *
 *  1. A KNOB HERE IS NOT AN EDIT. Every render goes through `params_override`,
 *     which the server renders with and does not write: no ledger row, no
 *     dirty region, no undo entry, no document version. Seventeen knob turns
 *     cost seventeen cached files and zero revisions. The document changes at
 *     exactly one moment — when you press Apply — and that press goes through
 *     `set_track`, the same action daw_set_track posts and the same action the
 *     instrument column's knobs post. One door.
 *
 *  2. THE DEFAULT PATH IS MONO, AND MONO CANNOT SHOW A WIDTH KNOB. The P0
 *     preview job renders one channel, so `spread` and `hat_width` move
 *     nothing you can see. The panel says so, in the server's own words, and
 *     offers the stereo path (`stereo: true`) that can show them. It does not
 *     quietly draw two identical channels and let a knob look broken.
 *
 *  3. THE NUMBER IS MEASURED, NOT PROMISED. The clock in the second bar is
 *     wall time from the gesture that caused the render to the frame that
 *     finished drawing it, taken in the browser, with the median and the p95
 *     of the session beside it. If it is over budget it says so in orange.
 *
 *  4. THE OVERLAY DRAWS A MEASUREMENT OR IT DRAWS NOTHING. With no profile
 *     picked the fourth slot is words, not a curve: an invented target is
 *     worse than a blank one, because a knob gets set to it. With a profile
 *     picked, everything behind our lines came out of `profile_get` and
 *     nothing was interpolated to make it fit.
 *
 *  5. A PROFILE IS A SHAPE, NEVER A SAMPLE — and this panel could not draw a
 *     sample if it wanted to. What it reads is dB shares, dB deviations from
 *     the pink null, times in milliseconds and counts. There is no audio, no
 *     invertible spectrogram frame and no note sequence anywhere in a profile,
 *     which is what makes "get closer to that record" a style target rather
 *     than a copy. The panel says so on the picker.
 *
 * ── WHAT IS COMPARABLE, AND WHAT IS NOT ───────────────────────────────────
 * We render ONE NOTE. A reference stem is minutes of a finished record. Two
 * of the numbers survive that gap and the rest do not, and the panel is built
 * around exactly that line:
 *
 *   · COMPARABLE — the 1/3-octave curve (a dB SHARE of the file's own total)
 *     and the nine bands (a dB DEVIATION from the pink null). Both are
 *     gain-invariant and rate-invariant by construction, so a quiet 44.1 kHz
 *     reference and our loud 48 kHz note are on one axis honestly.
 *   · NOT COMPARABLE — absolute level, LUFS, and anything per-bar. Those are
 *     printed as the reference's own numbers, labelled as targets, and never
 *     subtracted from ours. The Ear measures our side of those on the real
 *     mix; a single note has no loudness worth the name.
 *
 * The decay times sit in between: t10/t30/t60 are measured on both sides, so
 * they ARE differenced — but theirs is the average shape of N kick hits and
 * ours is one note, and the panel prints the hit count so that is visible.
 *
 * ── THE ONE COUPLING TO THE PAGE, IN ONE PLACE ────────────────────────────
 * daw.js publishes `window.__daw` as a read-only handle. This module reads
 * three fields off it — the open project, the selected track and the
 * document's revision — through `pageState()` below and nowhere else, so the
 * whole coupling is four lines and is trivially replaced by passing `getSlug`
 * / `getTrackId` to mountVoiceLab. It never writes to it.
 */
import { appConfirm, appPrompt } from "./dialog.js";

/* ── the small helpers, the same shapes dawear.js uses ─────────────────── */

const EL = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Every mutating call carries by:"user" — the provenance ledger's honesty
 *  rests on this page never claiming to be the agent. */
async function post(body) {
  const r = await fetch("/api/daw", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "user", ...body }),
  });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
}
async function get(p) {
  const r = await fetch(p);
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
}

const fmt = (v, dp = 1, unit = "") =>
  (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? "—" : `${Number(v).toFixed(dp)}${unit}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * IS THERE A NUMBER HERE AT ALL — and `Number(null)` is 0, which is why this
 * exists rather than a bare `Number.isFinite(Number(v))`.
 *
 * A profile is FULL of honest nulls: a t60 the render never reached, a t30 a
 * kick decays past, a loudness that could not be measured. Coercing one to
 * zero turns "not measured" into a measurement — the first run of the
 * reference overlay printed `t30 281 ms → — · +281 ms`, differencing our real
 * 281 ms against a null that had become 0. That is precisely the gap-filling
 * this panel exists to refuse, so the guard is one function and every read of
 * a profile number goes through it.
 */
const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

/** The percentile of a small sample, nearest-rank. Printed beside the median
 *  because one slow render in twenty is what a hand actually notices. */
function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[clamp(Math.ceil(p * s.length) - 1, 0, s.length - 1)];
}

/** THE ONE READ OF THE PAGE'S STATE. Nothing else in this file touches it. */
function pageState() {
  const S = typeof window !== "undefined" ? window.__daw : null;
  return {
    slug: S?.slug ?? null,
    trackId: S?.trackId ?? null,
    updatedAt: S?.proj?.updatedAt ?? null,
  };
}

/* Canvas ink comes from the SAME custom properties voicelab.css paints the
 * chrome with, read at runtime, so a theme change moves both together and the
 * module invents no colour of its own. ONE fallback for all of them, the shape
 * daw.js's readTokens uses and for its reason: a per-token fallback is a second
 * palette that nothing checks, and a single grey makes a missing token obvious
 * instead of plausible. */
const NO_TOKEN = "#8b8b9a";
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const of = (k) => (cs.getPropertyValue(`--${k}`) || "").trim() || NO_TOKEN;
  return {
    ink: of("ink"), dim: of("dim"), faint: of("faint"), ghost: of("ghost"),
    line: of("hair"), edge: of("edge"),
    primary: of("primary"), secondary: of("secondary"), accent: of("accent"),
    ok: of("ok"), warn: of("warn"), err: of("err"),
    mono: (cs.getPropertyValue("--mono") || "").trim() || "ui-monospace, monospace",
  };
}

/** One device pixel per CSS pixel at any DPR, and the context pre-cleared. */
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const w = Math.max(2, Math.round(r.width));
  const h = Math.max(2, Math.round(r.height));
  const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/* The dock's other three tabs. Named here because this module has to clear
 * them when it opens and be cleared when they do — daw.js's showDock() knows
 * about three panes and cannot be asked about a fourth without editing a
 * 241 KB file. Two listeners each way is the whole of the coordination. */
const DOCK = [["tabChain", "paneChain"], ["tabAnalysis", "paneAnalysis"], ["tabEar", "paneEar"]];

/* The budget the owner named, and the one the clock is coloured against.
 * SPEC §0.3 measured 4-12 ms of DSP per note, so everything above this line
 * is round trip, queue and drawing — which is exactly what the clock is for. */
const BUDGET_MS = 100;

/* ── THE REFERENCE OVERLAY'S ONE TABLE (SPEC §7) ───────────────────────────
 *
 * demucs splits a record into four: drums, bass, other, vocals. A profile
 * carries one measurement block per stem plus one for the master. Which of
 * them a track argues with is decided by `family` on the row
 * /api/daw/patches serves — the SAME row the knob rack is built from — so a
 * voice synths.py grows lands in the right column without this file ever
 * learning its name. "other" is where demucs puts everything that is not
 * drums, bass or a voice, which is why a lead and a riser share it.
 *
 * This is a DEFAULT, not a claim: the picker beside it can override it, and
 * it says which stem it chose. A kick sample loaded on a track called "lead"
 * is a real thing people do. */
const FAMILY_STEM = { drums: "drums", bass: "bass", synth: "other", fx: "other" };
/* The five blocks a profile can be read against. `master` is the whole
 * reference rather than a stem — useful for a pad or a bus, useless for a
 * kick, and named as itself so nobody mistakes it for a fifth demucs part. */
const STEMS = ["drums", "bass", "other", "vocals", "master"];
/* The reference's kick shape is measured ONCE, off the drums stem, so it is
 * only an honest thing to draw behind a drums-family voice. Written down here
 * rather than checked inline, because "why is there no envelope behind my
 * pad" is a question the panel should answer rather than a blank it should
 * leave. */
const KICK_STEM = "drums";
/* A band is "matched" when our shape and theirs are within this many dB of
 * each other. Not a rule and not a target — a counting threshold, so the
 * caption can say 6 of 9 rather than making the eye do it. */
const BAND_NEAR_DB = 3;

/* ═══════════════════════════════════════════════════════════ THE PANEL ══ */

export function mountVoiceLab(opts = {}) {
  if (typeof document === "undefined") return null;         // node / trace_load
  if (document.querySelector(".vl-wrap")) return null;       // never mount twice
  const host = opts.host || document.getElementById("paneVoice");
  if (!host) return null;

  if (!document.querySelector("link[data-vl-css]")) {
    const link = EL("link");
    link.rel = "stylesheet";
    link.href = "voicelab.css";
    link.setAttribute("data-vl-css", "1");
    document.head.appendChild(link);
  }

  const getSlug = opts.getSlug || (() => pageState().slug);
  const getTrackId = opts.getTrackId || (() => pageState().trackId);

  const V = {
    slug: null, doc: null, rows: null,        // rows: /api/daw/patches
    trackId: null, patch: null, base: {}, schema: {}, presets: null,
    knob: {},                                  // the widget state: name -> value
    pitch: 60, vel: 100, dur: 480,
    path: "mono",                              // mono | stereo | chain
    last: null,                                // the last voice_lab reply
    trips: [], totals: [], cold: 0, hits: 0,   // the measured clock
    view: null,                                // waveform zoom, in samples
    mip: null, mipSeq: 0,                      // the mip-map slice on screen
    applied: null,                             // the inverse of the last Apply
    seenAt: null, pageTrack: null, open: false, family: null,
    /* the reference overlay: the library, the pick, the fetched shape, and
     * which of its five blocks this track is being read against */
    profiles: null, profId: "", prof: null, stem: "auto",
    profBusy: false, profAsked: false, refNews: "",
  };
  const near = (a, b) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) < 1e-9;

  /* ── chrome ─────────────────────────────────────────────────────────── */

  host.classList.add("vl-host");
  const wrap = EL("div", "vl-wrap");
  host.appendChild(wrap);

  const bar1 = EL("div", "vl-bar");
  const trackSel = EL("select");
  trackSel.title = "the track whose instrument this renders — its real patch and its real params";
  const pitchIn = numField("pitch", 0, 127, 60);
  const velIn = numField("vel", 1, 127, 100);
  const durIn = numField("dur_ticks", 1, 3840, 480);
  const paths = EL("div", "vl-paths");
  const pathBtn = {};
  for (const [id, label, tip] of [
    ["mono", "mono", "The P0 path: the same job, the same bytes and the same cached file `preview_note` renders. One channel."],
    ["stereo", "stereo", "The same note through the rack with a NO-OP chain — the only way to reach the stereo instrument stage, and the only way a width knob (spread, hat_width) moves anything you can see."],
    ["chain", "+ chain", "Stereo, plus this track's own inserts, fader and pan. NOT the master chain: a limiter set for the mix would show you the limiter instead of the instrument."],
  ]) {
    const b = EL("button", "vl-btn", label);
    b.title = tip;
    b.addEventListener("click", () => { V.path = id; paintPaths(); V.view = null; bump(`path ${id}`); });
    pathBtn[id] = b;
    paths.appendChild(b);
  }
  const goBtn = EL("button", "vl-btn vl-go", "render");
  goBtn.title = "render this note again (a cached one answers from disk — the clock says which)";
  goBtn.addEventListener("click", () => bump("render"));
  const reloadBtn = EL("button", "vl-btn", "⟲");
  reloadBtn.title = "re-read the project and the palette";
  reloadBtn.addEventListener("click", () => { V.slug = null; sync(true); loadProfiles(V.profId); });
  bar1.append(
    lab("track", trackSel), lab("pitch", pitchIn), lab("vel", velIn), lab("dur", durIn),
    paths, goBtn, reloadBtn);

  const bar2 = EL("div", "vl-bar");
  const clock = EL("span", "vl-clock", "no render yet");
  const applyBtn = EL("button", "vl-btn", "apply to track");
  applyBtn.title = "write these params to the track through set_track — the same action daw_set_track posts";
  applyBtn.addEventListener("click", apply);
  const revertBtn = EL("button", "vl-btn", "revert knobs");
  revertBtn.title = "put every slider back to what the document says (renders again; writes nothing)";
  revertBtn.addEventListener("click", () => { V.knob = { ...V.base }; drawKnobs(); V.view = null; bump("revert"); });
  const undoBtn = EL("button", "vl-btn", "undo apply");
  undoBtn.title = "post the previous params back through set_track";
  undoBtn.hidden = true;
  undoBtn.addEventListener("click", undoApply);
  const note = EL("span", "vl-note");
  bar2.append(clock, EL("span", "vl-spacer"), note, revertBtn, applyBtn, undoBtn);

  /* ── THE REFERENCE BAR (SPEC §7) ────────────────────────────────────────
   * Four routes, one row: list them, get one, build one, delete one. The
   * profile itself is built and stored on the server; nothing here holds a
   * copy beyond the one it is drawing. */
  const bar3 = EL("div", "vl-bar vl-refbar");
  const profSel = EL("select");
  profSel.title = "the reference profile drawn behind this voice — shape only: dB shares, "
    + "dB off the pink null, decay times in ms, counts. A profile carries no audio and no "
    + "melody, so it is a style target and never a copy.";
  const stemSel = EL("select");
  stemSel.title = "which of the reference's blocks this track is read against. `auto` "
    + "follows the patch's family: a drums patch reads the drums stem, a bass patch the "
    + "bass stem, everything else demucs' `other`.";
  for (const id of ["auto", ...STEMS]) {
    const o = EL("option", null, id);
    o.value = id;
    stemSel.appendChild(o);
  }
  const buildIn = EL("input");
  buildIn.type = "text";
  buildIn.className = "vl-file";
  buildIn.placeholder = "a server-local audio file…";
  buildIn.title = "a path on THIS machine. Building runs demucs over it (four stems) and "
    + "measures each — a few seconds per 30 s of audio the first time, then it is cached "
    + "under the profile's id. The file is never read again afterwards and never leaves "
    + "the machine.";
  const buildBtn = EL("button", "vl-btn", "build");
  buildBtn.title = "measure that file and keep the SHAPE — profile_build, the same action "
    + "daw_profile_build posts";
  buildBtn.addEventListener("click", buildProfile);
  const delBtn = EL("button", "vl-btn", "✕");
  delBtn.title = "delete the picked profile from this machine (profile_delete)";
  delBtn.addEventListener("click", deleteProfile);
  const refNote = EL("span", "vl-refnote");
  profSel.addEventListener("change", () => pickProfile(profSel.value));
  stemSel.addEventListener("change", () => { V.stem = stemSel.value; redraw(); });
  bar3.append(
    EL("span", "vl-reflabel", "reference"), profSel, delBtn,
    lab("vs", stemSel), buildIn, buildBtn, refNote);

  const body = EL("div", "vl-body");
  const knobCol = EL("div", "vl-knobs");
  const cvs = EL("div", "vl-cvs");
  body.append(knobCol, cvs);

  const figs = {};
  const cap = {};
  function figure(id, title, zoomable) {
    const f = EL("figure", `vl-fig${zoomable ? " vl-zoomable" : ""}`);
    const c = EL("figcaption");
    c.append(EL("span", null, title), (cap[id] = EL("span", "vl-cap")));
    const cv = EL("canvas");
    cv.id = id;
    f.append(c, cv);
    cvs.appendChild(f);
    figs[id] = { fig: f, cv };
    return cv;
  }
  const waveCv = figure("vlWave", "Waveform", true);
  const specCv = figure("vlSpec", "Spectrum", false);
  const envCv = figure("vlEnv", "Envelope", false);
  const overCv = figure("vlOverlay", "Reference overlay", false);

  /* THE SLOT under the fourth canvas. With no profile it is the whole of the
   * fourth picture and it is WORDS; with one it is the numbers that a knob can
   * be set to, built element by element with textContent — never innerHTML,
   * because everything in it came off a file somebody else made. The canvas
   * stays in the DOM at its declared id either way. */
  overCv.hidden = true;
  const slot = EL("div", "vl-slot");
  const EMPTY_SLOT =
    "<b>Nothing measured to compare this against — so nothing is drawn.</b><br>"
    + "Pick a reference profile in the bar above and its matching stem lands behind these "
    + "pictures: its 1/3-octave curve behind the spectrum, its kick envelope behind ours, "
    + "and the band-by-band distance here — so \"more like that kick\" becomes a number you "
    + "can close.<br><br>"
    + "A <b>profile</b> is shape measurements only, never audio and never a melody: band "
    + "levels, <code>t10/t30/t60</code>, kick <code>f0</code>, sidechain depth and recovery. "
    + "Building one runs demucs over the reference and measures each stem "
    + "(<code>profile_build</code>).<br><br>"
    + "With none picked this stays blank on purpose. "
    + "A target drawn from an assumption is worse than no target, because a knob gets set to it.";
  slot.innerHTML = EMPTY_SLOT;
  figs.vlOverlay.fig.classList.add("vl-reffig");
  figs.vlOverlay.fig.appendChild(slot);

  wrap.append(bar1, bar2, bar3, body);
  drawProfiles();     // an honest empty picker before the first profile_list

  /* ── the dock tab ───────────────────────────────────────────────────── */

  const tabBtn = document.getElementById("tabVoice");
  if (tabBtn) {
    tabBtn.addEventListener("click", () => showVoice(true));
    /* Getting out of the way is an OBSERVER, not three click listeners.
     * daw.js calls showDock() from places that are not a click — the Ear's own
     * open/closed state drives one through a MutationObserver of its own — and
     * a listener on the buttons would miss those and leave two panes lit at
     * once. Watching the panes themselves catches every route in. */
    const others = DOCK.map(([, pid]) => document.getElementById(pid)).filter(Boolean);
    const mo = new MutationObserver(() => {
      if (V.open && others.some((p) => p.classList.contains("d-on"))) showVoice(false);
    });
    for (const p of others) mo.observe(p, { attributes: true, attributeFilter: ["class"] });
  }

  function showVoice(on) {
    V.open = !!on;
    host.classList.toggle("d-on", V.open);
    tabBtn?.classList.toggle("d-on", V.open);
    if (!V.open) return;
    /* The reference library is read on the FIRST open, not at boot: a page
     * that never opens this tab must not cost a request, and a machine with
     * no profile library must not print an error at load. */
    if (!V.profAsked) { V.profAsked = true; loadProfiles(); }
    for (const [tid, pid] of DOCK) {
      document.getElementById(tid)?.classList.remove("d-on");
      document.getElementById(pid)?.classList.remove("d-on");
    }
    /* the chain's own header belongs to the chain pane; showDock() hides it
     * for the other two tabs and this is the fourth */
    const ch = document.getElementById("chainHead");
    if (ch) ch.style.display = "none";
    const centre = document.getElementById("centre");
    centre?.classList.remove("d-nodock");
    document.getElementById("dockBtn")?.classList.add("d-on");
    /* Four pictures in 208 px is four strips. The Ear takes room the first
     * time it opens and keeps whatever you drag it to; so does this. */
    if (centre && document.getElementById("dock").getBoundingClientRect().height < 360) {
      centre.style.setProperty("--d-dock-h", `${Math.min(560, Math.round(innerHeight * 0.52))}px`);
    }
    sync().then(() => { if (!V.last) bump("opened"); else redraw(); });
  }

  /* ── loading the project and the palette ────────────────────────────── */

  /**
   * Follow the page, without ever redrawing something a hand is holding.
   *
   * This runs once a second while the pane is open, and the knob rack is real
   * DOM: rebuilding it under a slider mid-drag replaces the element the
   * pointer is captured on and the drag dies. So it does exactly nothing
   * unless something actually moved — the open project, the document's own
   * revision, or the page's selection (and only when the PAGE moved it, so a
   * track picked here is not yanked back a second later).
   */
  async function sync(force) {
    const slug = getSlug();
    if (!slug) { say("open a project first", "bad"); return; }
    const p = pageState();
    /* The comparison is the PAGE's revision against the page's revision as it
     * was a second ago — never against the revision of the copy this module
     * fetched. A page that has not loaded a document yet reports null, and
     * null-against-my-own-hash is a difference that never resolves: it would
     * refetch and rebuild the rack every single second, for ever. */
    const pageMovedDoc = !!(p.updatedAt && p.updatedAt !== V.seenAt);
    const docMoved = force || slug !== V.slug || pageMovedDoc;
    const pageMoved = !!(p.trackId && p.trackId !== V.pageTrack);
    if (pageMoved) V.pageTrack = p.trackId;
    if (!docMoved && !pageMoved) return;
    if (docMoved) {
      try {
        if (!V.rows) V.rows = (await get("/api/daw/patches")).patches || [];
        const r = await get(`/api/daw/project/${encodeURIComponent(slug)}`);
        V.slug = slug;
        V.doc = r.project;
        V.seenAt = p.updatedAt ?? r.project?.updatedAt ?? null;
      } catch (err) { say(err.message, "bad"); return; }
      drawTracks();
    }
    const want = (pageMoved ? p.trackId : null) || V.trackId || p.trackId
      || V.doc?.tracks?.[0]?.id || null;
    if (want && want !== trackSel.value) trackSel.value = want;
    loadTrack(trackSel.value || want);
  }

  function drawTracks() {
    const keep = trackSel.value;
    trackSel.textContent = "";
    for (const t of V.doc?.tracks || []) {
      const o = EL("option", null, `${t.name} — ${t.instrument?.patch || "?"}`);
      o.value = t.id;
      trackSel.appendChild(o);
    }
    if (keep && [...trackSel.options].some((o) => o.value === keep)) trackSel.value = keep;
  }

  /** Adopt a track: its patch, its stored params, and the knob rack that
   *  comes with them. The widget state starts as the document's own values. */
  function loadTrack(id) {
    const t = (V.doc?.tracks || []).find((x) => x.id === id) || V.doc?.tracks?.[0];
    if (!t) { say("this project has no tracks", "warn"); return; }
    const fresh = t.id !== V.trackId || t.instrument?.patch !== V.patch;
    const base = { ...(t.instrument?.params || {}) };
    const settled = !fresh && knobCol.childElementCount
      && JSON.stringify(base) === JSON.stringify(V.base);
    V.trackId = t.id;
    V.patch = t.instrument?.patch || null;
    V.base = base;
    const row = (V.rows || []).find((r) => r.id === V.patch);
    V.schema = row?.params || {};
    V.presets = row?.presets || null;
    /* the ONE field the reference overlay needs off this row: which of
     * demucs' four stems this voice argues with, by family rather than by
     * patch id, so a new voice inherits the mapping instead of needing one */
    V.family = row?.family || null;
    if (fresh) { V.knob = { ...base }; V.view = null; V.applied = null; undoBtn.hidden = true; }
    /* Nothing moved and the rack is already on screen: leave the DOM alone.
     * The slider under the pointer is the one being dragged. */
    if (!settled) drawKnobs();
  }

  trackSel.addEventListener("change", () => { V.trackId = trackSel.value; loadTrack(trackSel.value); bump("track"); });
  for (const [el, key] of [[pitchIn, "pitch"], [velIn, "vel"], [durIn, "dur"]]) {
    el.addEventListener("input", () => {
      const n = Number(el.value);
      if (!Number.isFinite(n)) return;
      V[key] = n; V.view = null; bump(key);
    });
  }

  /* ── the knob rack, generated from the patch's declared table ─────────
   * Not one parameter name is written in this file. The table is the row
   * /api/daw/patches serves, which is patches.json — the same table the
   * store clamps against, drums.py and synths.py resolve against, and
   * daw_patches publishes. A knob synths.py grows appears here for free, and
   * a knob this page could not send would be a knob the agent has and the
   * person does not. */

  function drawKnobs() {
    knobCol.textContent = "";
    const names = Object.keys(V.schema);
    const h = EL("h4", null, V.patch || "no patch");
    h.append(EL("span", null, `  ${names.length} knob${names.length === 1 ? "" : "s"}`));
    knobCol.appendChild(h);

    if (!names.length) {
      knobCol.appendChild(EL("div", "vl-empty",
        "This patch declares no parameters — a sampled instrument is what its samples are. "
        + "Pitch, velocity and duration above still change what you hear."));
    }

    for (const pname of names) {
      const spec = V.schema[pname] || {};
      const lo = Number(spec.min ?? 0), hi = Number(spec.max ?? 1);
      const def = Number(spec.default ?? lo);
      const val = Number(V.knob[pname] ?? def);
      const span = hi - lo;
      /* A whole-number range (semitones, cents) steps by one; everything else
       * gets 200 steps of its own span, which is finer than a hand is. */
      const whole = Number.isInteger(lo) && Number.isInteger(hi) && Number.isInteger(def) && span >= 4;
      const step = whole ? 1 : span / 200;

      const box = EL("div", `vl-knob${near(val, V.base[pname] ?? def) ? "" : " vl-dirty"}`);
      const row = EL("div", "vl-krow");
      const nm = EL("span", "vl-kname", pname);
      const vv = EL("span", "vl-kval", whole ? String(Math.round(val)) : val.toFixed(3));
      row.append(nm, vv, EL("span", "vl-kunit", spec.unit || ""));
      const sl = EL("input");
      sl.type = "range";
      sl.min = String(lo); sl.max = String(hi); sl.step = String(step);
      sl.value = String(val);
      /* patches.json's own words, its own range, its own default — never a
       * sentence this page wrote about someone else's parameter. */
      sl.title = `${pname} — ${spec.doc || "no doc on this row"}\n${lo}..${hi}${spec.unit ? ` ${spec.unit}` : ""}, default ${def}`
        + `\ndouble-click to put it back to ${def}`;
      sl.addEventListener("input", () => {
        const n = Number(sl.value);
        V.knob[pname] = n;
        vv.textContent = whole ? String(Math.round(n)) : n.toFixed(3);
        box.classList.toggle("vl-dirty", !near(n, V.base[pname] ?? def));
        V.view = null;
        bump(pname);
      });
      sl.addEventListener("dblclick", () => {
        sl.value = String(def);
        sl.dispatchEvent(new Event("input"));
      });
      box.append(row, sl);
      knobCol.appendChild(box);
    }

    /* Presets are the row's OWN params, applied to the sliders — a preview,
     * not a write. The doc that ships with each one is its tooltip, because
     * it is where the measurement that chose those values is written down. */
    if (V.presets && Object.keys(V.presets).length) {
      knobCol.appendChild(EL("h4", null, "presets"));
      const strip = EL("div", "vl-presets");
      for (const [pid, p] of Object.entries(V.presets)) {
        const b = EL("button", "vl-btn", pid);
        b.title = p.doc || `${pid}: ${Object.keys(p.params || {}).join(", ")}`;
        b.addEventListener("click", () => {
          V.knob = { ...V.base, ...(p.params || {}) };
          drawKnobs(); V.view = null; bump(`preset ${pid}`);
        });
        strip.appendChild(b);
      }
      knobCol.appendChild(strip);
    }

    knobCol.appendChild(EL("div", "vl-empty",
      "transpose and gain_db belong to the track, not the patch, so they are set in the "
      + "instrument column. Nothing here writes anything until you press apply."));
  }


  /** The override to send: the sliders, minus everything the document already
   *  says. Empty means send NO override at all — which is what keeps the
   *  first render byte-identical to `preview_note` and sharing its cached
   *  file rather than minting a second name for the same audio. */
  function overrideBody() {
    const ov = {};
    for (const [k, v] of Object.entries(V.knob)) if (!near(v, V.base[k] ?? V.schema[k]?.default)) ov[k] = v;
    for (const k of Object.keys(V.base)) if (!(k in V.knob)) ov[k] = V.base[k];
    return Object.keys(ov).length ? ov : null;
  }

  /* ── THE RENDER LOOP, and the clock on it ─────────────────────────────
   * One request per gesture, and only one in the air at a time: a slider
   * dragged across its range fires an input event a frame, and thirty
   * requests would queue thirty renders to draw the last one. `bump` marks
   * the panel dirty and stamps the time; `pump` serves the LATEST state when
   * the lane is free, and re-fires if the hand moved while it was away.
   *
   * The clock is stamped at the gesture, not at the fetch, so a coalesced
   * burst reports the wait it really cost — which is the number a hand feels.
   * The round trip is reported separately for the same reason. */

  let busy = false, dirty = false, dirtyAt = 0, dirtyWhy = "";

  function bump(why) {
    if (!dirty) { dirty = true; dirtyAt = performance.now(); dirtyWhy = why; }
    pump();
  }

  async function pump() {
    if (busy || !dirty) return;
    if (!V.slug || !V.trackId) { dirty = false; return; }
    busy = true;
    const t0 = dirtyAt, why = dirtyWhy;
    dirty = false;
    try {
      const ov = overrideBody();
      const t1 = performance.now();
      const r = await post({
        action: "voice_lab",
        slug: V.slug, track: V.trackId,
        pitch: Math.round(V.pitch), vel: Math.round(V.vel), dur_ticks: Math.round(V.dur),
        ...(ov ? { params_override: ov } : {}),
        ...(V.path === "stereo" ? { stereo: true } : {}),
        ...(V.path === "chain" ? { through_chain: true } : {}),
        analysis: true,
        /* one column a pixel: the picture is measured at the width it is
         * drawn at instead of at a constant somebody picked once */
        columns: clamp(Math.round(waveCv.getBoundingClientRect().width) || 900, 16, 4000),
      });
      const t2 = performance.now();
      V.last = r;
      redraw();
      const t3 = performance.now();
      record(t2 - t1, t3 - t0, r, why);
    } catch (err) {
      say(err.message, "bad");
      clock.textContent = "render failed";
    } finally {
      busy = false;
      if (dirty) pump();
    }
  }

  /**
   * THE CLOCK. The first render of a session pays for a python that has never
   * been asked anything — SPEC §0.3 measured 10-58 ms of cold start against
   * 4-12 ms warm — and the owner's ≤100 ms is about turning a knob, not about
   * the first note. So the first sample is COUNTED and SHOWN and kept out of
   * the median, and the panel says it did that rather than quietly dropping a
   * number it did not like.
   */
  function record(trip, total, r, why) {
    if (V.totals.length === 0 && V.cold === 0) { V.cold = Math.round(total); }
    else { V.trips.push(trip); V.totals.push(total); }
    if (r.cached) V.hits++;
    if (V.trips.length > 200) { V.trips.shift(); V.totals.shift(); }
    const med = pct(V.totals, 0.5), p95 = pct(V.totals, 0.95);
    const a = r.analysis || {};
    clock.textContent = "";
    const b = EL("b", null, `${Math.round(total)} ms`);
    if (total > BUDGET_MS) b.className = "vl-over";
    clock.append(
      b,
      document.createTextNode(
        ` gesture→drawn (${Math.round(trip)} round trip)`
        + (V.totals.length
          ? ` · warm median ${fmt(med, 0)} · p95 ${fmt(p95, 0)} · n=${V.totals.length}`
          : " · first render of the session, cold")
        + (V.cold ? ` · cold was ${V.cold}` : "")
        + ` · server ${fmt(r.render_ms, 1)} render + ${fmt(a.ms, 1)} analyse`
        + ` · lane ${r.lane}${r.cached ? ` · cached (${V.hits})` : ""}`
        + ` · ${why}`));
    b.title = `The budget is ${BUDGET_MS} ms, and it is measured here in the browser: `
      + "from the gesture that dirtied the panel to the frame that finished drawing it, "
      + "including any wait while an earlier render of the same knob was still in the air. "
      + "The median excludes only the first render of the session, which is shown separately "
      + "as `cold`. `lane fast` means §3.4's short-job serve child answered it; `lane shared` "
      + "means it queued behind whatever else the engine was doing.";
  }

  function say(msg, kind) {
    note.textContent = msg || "";
    note.className = `vl-note${kind ? ` vl-${kind}` : ""}`;
  }

  /* ── writing: ONE door, and it is the one the agent uses ─────────────── */

  async function apply() {
    const ov = overrideBody();
    if (!ov) { say("the sliders already say what the document says", "warn"); return; }
    const before = { ...V.base };
    applyBtn.disabled = true;
    try {
      /* The same body daw_set_track posts and the same body the instrument
       * column's knobs post: set_track REPLACES params, so the override is
       * merged onto the track's other knobs first. */
      await post({ action: "set_track", slug: V.slug, track: V.trackId, params: { ...before, ...ov } });
      V.applied = before;
      undoBtn.hidden = false;
      say(`written to ${V.trackId}: ${Object.keys(ov).join(", ")} — the page follows over the live channel`, "");
      await sync(true);
      bump("applied");
    } catch (err) { say(err.message, "bad"); }
    finally { applyBtn.disabled = false; }
  }

  async function undoApply() {
    if (!V.applied) return;
    try {
      await post({ action: "set_track", slug: V.slug, track: V.trackId, params: V.applied });
      say("put back", "");
      V.applied = null; undoBtn.hidden = true;
      await sync(true);
      V.knob = { ...V.base };
      drawKnobs(); bump("undone");
    } catch (err) { say(err.message, "bad"); }
  }

  /* ── THE REFERENCE LIBRARY: four routes, and nothing kept behind them ──
   *
   * profile_list  → what this machine has measured
   * profile_get   → the shape of one of them (the only thing ever drawn)
   * profile_build → measure a server-local file and keep the shape
   * profile_delete→ forget one
   *
   * The same four daw_profile_list / _get / _build / _delete post. Nothing is
   * cached here beyond the profile currently on screen, so deleting one on
   * another tab and reloading the list is the whole of the invalidation. */

  async function loadProfiles(keep) {
    try {
      const r = await post({ action: "profile_list" });
      V.profiles = Array.isArray(r.profiles) ? r.profiles : [];
      /* The server's OWN folder, printed as the placeholder — this page never
       * types a path of its own, so a machine that keeps its references
       * somewhere else says so rather than being contradicted. */
      if (r.dir) buildIn.placeholder = `profiles live in ${r.dir} — give any audio file`;
      drawProfiles();
      if (keep && V.profiles.some((p) => p.id === keep)) { profSel.value = keep; }
      drawRefNote();
    } catch (err) {
      V.profiles = null;
      drawProfiles();
      sayRef(`no reference library on this tree — ${err.message}`, "warn");
    }
  }

  function drawProfiles() {
    const keep = V.profId;
    profSel.textContent = "";
    const none = EL("option", null,
      V.profiles === null ? "reference: unavailable"
        : V.profiles.length ? "no reference" : "no profiles built yet");
    none.value = "";
    profSel.appendChild(none);
    for (const p of V.profiles || []) {
      const o = EL("option", null,
        `${p.name || p.id}${isNum(p.seconds) ? ` — ${Number(p.seconds).toFixed(0)}s` : ""}`);
      o.value = p.id;
      profSel.appendChild(o);
    }
    profSel.value = keep && (V.profiles || []).some((p) => p.id === keep) ? keep : "";
    profSel.disabled = !V.profiles?.length;
    delBtn.disabled = !V.profId;
  }

  /** Fetch ONE profile's shape and redraw against it. "" means none, which
   *  puts every picture back to what it was before a reference existed. */
  async function pickProfile(id) {
    V.profId = id || "";
    V.refNews = "";                    // a new pick is new news
    delBtn.disabled = !V.profId;
    if (!V.profId) { V.prof = null; drawRefNote(); redraw(); return; }
    sayRef("reading the profile…");
    try {
      /* `profile`, which is the name daw_profile_get declares and posts. This
       * panel said `id`; the route accepted both (b.profile ?? b.id), so
       * nothing was broken and nothing said so either — two hands calling one
       * capability by two names, past a parameter-level gate that covered
       * voice_lab and peaks and had never heard of this family. */
      const r = await post({ action: "profile_get", profile: V.profId });
      V.prof = r.profile || (r.stems ? r : null);
      if (!V.prof) throw new Error("that profile carries no stems");
    } catch (err) {
      V.prof = null; V.profId = ""; profSel.value = "";
      sayRef(err.message, "bad");
    }
    drawRefNote();
    redraw();
  }

  async function buildProfile() {
    const file = buildIn.value.trim();
    if (!file) { sayRef("give a server-local audio file to measure", "warn"); return; }
    if (V.profBusy) return;
    V.profBusy = true;
    buildBtn.disabled = true;
    sayRef("running demucs and measuring — a first build is tens of seconds…");
    try {
      const r = await post({ action: "profile_build", file });
      /* SEPARATION IS A QUEUE, NOT A CALL. demucs runs on the same idle-drain
       * queue as cover art, so a build can come back `pending: true` with
       * nothing written and the stems still to come. Saying "built" then would
       * be a lie with a picker entry attached, so the server's own sentence is
       * shown and the file is left in the box to ask again with. */
      if (r.pending || r.built === false) {
        sayRef(String(r.note || "the separation is queued — ask again when it has run"), "warn");
        return;
      }
      const id = r.id || r.profile?.id || null;
      buildIn.value = "";
      await loadProfiles(id);
      if (id) { profSel.value = id; await pickProfile(id); }
      /* The build's own news rides IN the provenance line rather than being
       * written over it a millisecond later: pickProfile redraws that line,
       * and the first draft of this called sayRef and then drawRefNote, so
       * "built · 1 warning" was on screen for one frame and then gone. */
      const warned = (r.warnings || V.prof?.warnings || []).length;
      V.refNews = `built${id ? ` ${id}` : ""}${warned ? ` · ${warned} warning${warned === 1 ? "" : "s"}` : ""}`;
      if (V.prof) drawRefNote(); else sayRef(V.refNews);
    } catch (err) { sayRef(err.message, "bad"); }
    finally { V.profBusy = false; buildBtn.disabled = false; }
  }

  async function deleteProfile() {
    if (!V.profId) return;
    const id = V.profId;
    /* One confirm, and it names what goes: a profile is minutes of somebody's
     * listening turned into forty numbers, and rebuilding it means running
     * demucs again. */
    if (!(await appConfirm(`Delete the reference profile "${id}"? Rebuilding it means running demucs over the file again.`))) return;
    try {
      await post({ action: "profile_delete", profile: id });   // daw_profile_delete's own name
      V.profId = ""; V.prof = null;
      await loadProfiles();
      sayRef(`deleted ${id}`);
      redraw();
    } catch (err) { sayRef(err.message, "bad"); }
  }

  /**
   * THE PROVENANCE LINE — one line, and its paragraphs in the tooltip.
   *
   * Measured live, on a 776 px dock: the profiler's Q2 sentence and the grid
   * gate's `why` are both real paragraphs, and putting them on the bar wrapped
   * it to 105 px, which left 89 px of a 345 px pane for the four pictures. So
   * the FACT goes on the line ("48000 Hz (resampled from 44100)") and the
   * paragraph that explains it goes in `title`, verbatim and complete. Nothing
   * is dropped; what changes is which of the two a glance costs.
   */
  function sayRef(msg, kind, detail) {
    refNote.textContent = msg || "";
    refNote.className = `vl-refnote${kind ? ` vl-${kind}` : ""}`;
    refNote.title = detail || msg || "";
  }

  /**
   * WHICH BLOCK OF THE PROFILE THIS TRACK IS BEING READ AGAINST.
   *
   * Returns null when there is no profile, when the pick resolves to a block
   * the profile does not carry, or when the block has no band measurement —
   * all three of which are "draw nothing", never "draw something near".
   */
  function refStem() {
    if (!V.prof) return null;
    const auto = FAMILY_STEM[V.family] || "other";
    const id = V.stem === "auto" ? auto : V.stem;
    const block = id === "master" ? V.prof.master : V.prof.stems?.[id];
    if (!block?.bands?.bands?.length) return null;
    return { id, block, auto, chosen: V.stem === "auto" };
  }

  /** The reference's kick shape — measured once, off the drums stem, so it is
   *  only honest behind a drums-family voice. */
  function refKick() {
    const s = refStem();
    if (!s || s.id !== KICK_STEM) return null;
    const k = V.prof?.kick;
    return k?.shape?.envelope_db?.length ? k : null;
  }

  /** Their nine bands, aligned to OURS by name. A profile built against a
   *  different band table is refused rather than drawn a band out of step —
   *  which would look like a real difference and be an indexing bug. */
  function refBands(sp) {
    const s = refStem();
    if (!s || !sp?.band_names) return null;
    const rows = s.block.bands.bands;
    if (rows.length !== sp.band_names.length) return null;
    if (!rows.every((r, i) => r.name === sp.band_names[i])) return null;
    return rows;
  }

  /** THE PROVENANCE LINE. Everything a reader needs to distrust the overlay
   *  correctly: where the profile came from, how long it was, what rate it
   *  was measured at (and whether it had to be resampled to get there), what
   *  the grid gate thought the tempo was, and every warning verbatim. */
  function drawRefNote() {
    /* With no profile the line belongs to whichever of the four routes spoke
     * last — a build failure must not be wiped by a redraw. */
    if (!V.prof) return;
    const p = V.prof;
    const s = refStem();
    const bits = V.refNews ? [V.refNews] : [];
    if (s) bits.push(`vs ${s.id}${s.chosen ? ` (auto, family ${V.family || "?"})` : ""}`);
    else bits.push(`no ${V.stem === "auto" ? FAMILY_STEM[V.family] || "other" : V.stem} block in this profile`);
    if (p.source) bits.push(String(p.source));
    if (isNum(p.seconds)) bits.push(`${Number(p.seconds).toFixed(0)}s`);
    /* THE RATE, AND WHETHER IT WAS CHANGED TO GET THERE. Owner decision Q2:
     * a 44.1 kHz reference is resampled to 48 kHz inside the profiler so that
     * loudness can be measured at all, and the profile says it did — because
     * resampling moves the numbers slightly and a measurement that hides what
     * it did to its input is not one. Both fields are printed here verbatim
     * rather than summarised. */
    if (p.sr) {
      bits.push(p.resampled_from
        ? `${p.sr} Hz (resampled from ${p.resampled_from})`
        : `${p.sr} Hz`);
    }
    const bpm = p.kick?.shape?.implied_bpm;
    if (isNum(bpm)) bits.push(`grid ${Number(bpm).toFixed(1)} BPM`);
    /* THE GRID GATE'S VERDICT, because every number below it depends on the
     * beat. Ungated flux peaks read 442 BPM on a real track, and a wrong beat
     * makes the decay window, the IOI and the whole pump wrong while looking
     * perfectly plausible. `gated: false` is therefore a warning on the face
     * of the panel, not a field somebody could go and look up. */
    const grid = p.kick?.grid;
    const warn = [
      ...(grid && grid.gated !== true
        ? ["the beat grid did not gate — the beat, the decay window and the pump are "
          + "read off raw flux peaks"] : []),
      ...(Array.isArray(p.warnings) ? p.warnings : []),
      ...(s && s.block.loudness && s.block.loudness.lufs_available === false
        ? [String(s.block.loudness.lufs_absent_because || "LUFS unavailable")] : []),
    ].map(String);
    /* The paragraphs, in the tooltip: the profiler's own sentences, complete
     * and unedited. A summary of a sentence that exists to explain what was
     * done to the input would be a second, worse version of it. */
    const detail = [
      ...bits, ...warn,
      ...(p.resample_note ? [String(p.resample_note)] : []),
      ...(grid?.why ? [`beat grid: ${grid.why}`] : []),
      ...(p.shape_only_note ? [String(p.shape_only_note)] : []),
    ].join("\n\n");
    sayRef(bits.join(" · ") + (warn.length ? ` · ${warn.join(" · ")}` : ""),
      warn.length ? "warn" : "", detail);
  }

  /* ── the pictures ───────────────────────────────────────────────────── */

  function redraw() {
    const r = V.last;
    if (!r) return;
    paintPaths();
    const a = r.analysis || {};
    say(a.mono_caveat || r.path_note || "", a.mono_caveat ? "warn" : "");
    drawWave(a);
    drawSpec(a);
    drawEnv(a);
    drawOverlay(a);
    drawRefNote();
  }

  function paintPaths() {
    for (const [id, b] of Object.entries(pathBtn)) b.classList.toggle("vl-on", V.path === id);
  }

  /* THE WAVEFORM. The whole note is drawn from the analysis reply's own
   * columns — free, already in the answer. Zoom in and it switches to the
   * four-stage mip-map (`peaks`), which gives 8 samples a peak: an attack
   * drawn from eight hundred samples is a vertical line, and the point of
   * this panel is to see the attack. Both sources give min AND max, because
   * a rectified envelope hides asymmetry and DC. */
  function drawWave(a) {
    const { g, w, h } = fitCanvas(waveCv);
    const P = palette();
    const src = V.mip && V.view ? V.mip : null;
    const total = a.samples || 0;
    const view = V.view || { from: 0, to: total };
    const chans = src
      ? src.data.map((c) => ({ min: c.min, max: c.max }))
      : Object.entries(a.peaks?.channels || {})
        .filter(([k]) => k === "L" || k === "R")
        .slice(0, a.channels > 1 ? 2 : 1)
        .map(([, c]) => c);
    cap.vlWave.textContent = total
      ? `${(view.from / (a.rate || 1) * 1000).toFixed(0)}–${(view.to / (a.rate || 1) * 1000).toFixed(0)} ms · `
        + (src ? `mip stage ${src.stage.shift} (${src.stage.spp} spl/peak) · ${src.peaks} peaks`
          : `${a.peaks?.columns || 0} columns (${a.peaks?.samples_per_column || 0} spl) · wheel to zoom`)
      : "";
    if (!chans.length || !total) return;

    const rowH = h / chans.length;
    g.strokeStyle = P.line;
    g.lineWidth = 1;
    chans.forEach((c, ci) => {
      const y0 = ci * rowH, mid = y0 + rowH / 2;
      g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(w, mid + 0.5); g.stroke();
      const n = Math.min(c.min.length, c.max.length);
      if (!n) return;
      g.fillStyle = ci === 0 ? P.primary : P.accent;
      const amp = (rowH / 2 - 2);
      for (let x = 0; x < w; x++) {
        const i0 = Math.floor(x / w * n), i1 = Math.max(i0 + 1, Math.floor((x + 1) / w * n));
        let lo = 1, hi = -1;
        for (let i = i0; i < i1 && i < n; i++) { if (c.min[i] < lo) lo = c.min[i]; if (c.max[i] > hi) hi = c.max[i]; }
        if (hi < lo) continue;
        const yTop = mid - clamp(hi, -1.5, 1.5) * amp;
        const yBot = mid - clamp(lo, -1.5, 1.5) * amp;
        g.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
      g.fillStyle = P.ghost;
      g.font = `10px ${P.mono}`;
      g.fillText(chans.length > 1 ? (ci === 0 ? "L" : "R") : "mono", 4, y0 + 11);
    });
  }

  /* Zoom is a wheel on the canvas, anchored where the pointer is; a drag
   * pans; a double-click goes back to the whole note. Every change asks the
   * server for the mip slice that fits, at most once every animation frame's
   * worth of wheel — the sidecar is built once per file and cached, so this
   * is a read, not a render. */
  waveCv.addEventListener("wheel", (e) => {
    const a = V.last?.analysis;
    if (!a?.samples) return;
    e.preventDefault();
    const rect = waveCv.getBoundingClientRect();
    const v = V.view || { from: 0, to: a.samples };
    const at = v.from + (e.clientX - rect.left) / rect.width * (v.to - v.from);
    const k = e.deltaY > 0 ? 1.35 : 1 / 1.35;
    const span = clamp((v.to - v.from) * k, 64, a.samples);
    let from = Math.round(at - (at - v.from) * (span / (v.to - v.from)));
    from = clamp(from, 0, a.samples - span);
    V.view = { from, to: Math.round(from + span) };
    if (V.view.to - V.view.from >= a.samples) V.view = null;
    askMip();
  }, { passive: false });
  waveCv.addEventListener("dblclick", () => { V.view = null; V.mip = null; drawWave(V.last?.analysis || {}); });
  waveCv.addEventListener("pointerdown", (e) => {
    const a = V.last?.analysis;
    if (!a?.samples || !V.view) return;
    const rect = waveCv.getBoundingClientRect();
    const per = (V.view.to - V.view.from) / rect.width;
    const x0 = e.clientX, v0 = { ...V.view };
    try { waveCv.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    const move = (m) => {
      const d = Math.round((x0 - m.clientX) * per);
      const from = clamp(v0.from + d, 0, a.samples - (v0.to - v0.from));
      V.view = { from, to: from + (v0.to - v0.from) };
      askMip();
    };
    const up = () => {
      waveCv.removeEventListener("pointermove", move);
      waveCv.removeEventListener("pointerup", up);
      try { waveCv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    };
    waveCv.addEventListener("pointermove", move);
    waveCv.addEventListener("pointerup", up);
  });

  let mipTimer = null;
  function askMip() {
    if (!V.view) { V.mip = null; drawWave(V.last?.analysis || {}); return; }
    drawWave(V.last?.analysis || {});          // redraw now, refine when it lands
    clearTimeout(mipTimer);
    mipTimer = setTimeout(async () => {
      const seq = ++V.mipSeq;
      const w = Math.max(2, Math.round(waveCv.getBoundingClientRect().width));
      try {
        const r = await post({
          action: "peaks", slug: V.slug, name: V.last?.file,
          from_sample: V.view.from, to_sample: V.view.to,
          samples_per_pixel: Math.max(1, (V.view.to - V.view.from) / w),
          max_peaks: 4000,
        });
        if (seq !== V.mipSeq) return;                   // a later zoom won
        V.mip = r;
        drawWave(V.last?.analysis || {});
      } catch (err) { say(`peaks: ${err.message}`, "warn"); }
    }, 60);
  }

  /* THE SPECTRUM, two readings of the same measurement on one log-frequency
   * axis. Above: the 1/3-octave curve as a dB SHARE of the total, so it does
   * not move when the gain does. Below: the Ear's nine bands, each as a bar
   * of its deviation from the pink null — equal energy per octave, derived
   * from the band edges rather than asserted. The band edges are parsed out
   * of the server's own labels, so there is no second copy of BANDS here.
   *
   * L and R are drawn separately whenever they differ. On the mono path they
   * are the same samples and the panel says so rather than drawing one line
   * twice and calling it stereo. */
  function drawSpec(a) {
    const { g, w, h } = fitCanvas(specCv);
    const P = palette();
    const sp = a.spectrum;
    if (!sp) { cap.vlSpec.textContent = ""; return; }
    const rate = a.rate || 48000;
    const nyq = rate / 2;
    const F0 = 20, F1 = nyq;
    const xOf = (f) => (Math.log2(clamp(f, F0, F1) / F0) / Math.log2(F1 / F0)) * (w - 26) + 22;
    const splitY = Math.round(h * 0.60);
    const stereo = !a.mono;
    cap.vlSpec.textContent = stereo
      ? `L/R differ · widest ${sp.widest_band} ${fmt(Math.max(...sp.l_minus_r_db.map(Math.abs)), 2, " dB")}`
      : "one channel — L, R and mid are the same samples";

    /* THE REFERENCE, resolved once for both halves of this picture. `null`
     * everywhere below means "no profile, or none that lines up" — and every
     * branch that reads it draws nothing at all rather than something near. */
    const ref = refStem();
    const refRows = refBands(sp);

    /* ── the 1/3-octave curve ── */
    const to = a.third_octave;
    if (to?.mid?.bands?.length) {
      const rows = to.mid.bands;
      /* Their curve is a dB SHARE of their own total, exactly as ours is a
       * share of ours. That is the ONE reason a 44.1 kHz record and a 48 kHz
       * note can share a y-axis: neither number moves when the gain does, and
       * neither is a level. The band centres are ISO thirds on both sides, so
       * the two curves are drawn against frequency and never against index —
       * theirs stops at their Nyquist and simply ends there. */
      const refTo = Array.isArray(ref?.block?.third_octave) ? ref.block.third_octave : null;
      const vals = [];
      for (const k of stereo ? ["L", "R", "mid"] : ["mid"]) for (const r of to[k].bands) vals.push(r.share_db);
      /* their curve is fitted INTO the scale, not clipped by it — a target
       * drawn hard against the top of the box is a target you cannot aim at */
      for (const r of refTo || []) vals.push(r.share_db);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = Math.max(2, (hi - lo) * 0.08);
      const yOf = (v) => splitY - 14 - (clamp(v, lo - pad, hi + pad) - (lo - pad)) / ((hi - lo) + 2 * pad) * (splitY - 26);
      /* the dB grid, labelled — a curve without a scale is a decoration */
      g.strokeStyle = P.line; g.fillStyle = P.ghost; g.font = `9px ${P.mono}`;
      for (const v of niceTicks(lo - pad, hi + pad, 4)) {
        const y = Math.round(yOf(v)) + 0.5;
        g.beginPath(); g.moveTo(22, y); g.lineTo(w, y); g.stroke();
        g.fillText(`${v > 0 ? "+" : ""}${v.toFixed(0)}`, 1, y + 3);
      }
      /* THEIRS FIRST, so ours is never hidden behind it: dashed, in the
       * secondary ink, and it stops where their measurement stops. */
      if (refTo?.length) {
        g.strokeStyle = P.secondary; g.lineWidth = 1.4;
        g.setLineDash([4, 3]);
        g.beginPath();
        refTo.forEach((r, i) => {
          const x = xOf(r.centre ?? r.hz), y = yOf(r.share_db);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.stroke();
        g.setLineDash([]);
      }
      for (const [k, col, wid] of stereo
        ? [["L", P.primary, 1], ["R", P.accent, 1], ["mid", P.ink, 1.6]]
        : [["mid", P.primary, 1.6]]) {
        g.strokeStyle = col; g.lineWidth = wid; g.beginPath();
        to[k].bands.forEach((r, i) => {
          const x = xOf(r.hz), y = yOf(r.share_db);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.stroke();
      }
      g.lineWidth = 1;
      g.fillStyle = P.faint;
      g.fillText(`1/3 octave, dB share (${rows.length} bands)`
        + (refTo?.length ? ` · dashed = ${ref.id} of ${V.prof?.name || V.profId} (${refTo.length})` : ""),
      26, 11);
    }

    /* ── the nine bands, as deviation bars under the frequencies they measure ── */
    const bands = sp.band_labels.map((l, i) => {
      const m = /(\d+)-(\d+)/.exec(l) || [];
      return { lo: Number(m[1]) || F0, hi: Number(m[2]) || F1, name: sp.band_names[i], i };
    });
    const zero = splitY + (h - splitY) * 0.5;
    g.strokeStyle = P.line;
    g.beginPath(); g.moveTo(22, Math.round(zero) + 0.5); g.lineTo(w, Math.round(zero) + 0.5); g.stroke();

    /* THE SCALE IS FITTED, AND THE ABSENT BANDS ARE LEFT OUT OF FITTING IT.
     * A mix sits within a few dB of the null and a fixed ±8 dB reads well; ONE
     * NOTE does not. A kick has nothing at all above 8 kHz, and ear.py marks
     * that band `absent` — its −37 dB is "there is no air here", not "the air
     * is 37 dB wrong". Fitting the scale to it would squash the eight bands
     * that carry the instrument into two pixels each. So absent bands are
     * drawn in ghost, hard against the floor where they honestly are, and the
     * scale is fitted to the bands that hold something. The number is printed,
     * because a bar chart whose scale moves and does not say so is a lie that
     * looks like a measurement. */
    const rowsOf = (b) => (stereo
      ? [sp.per_channel.L.bands[b.i], sp.per_channel.R.bands[b.i]]
      : [sp.per_channel.mid.bands[b.i]]);
    const present = bands.flatMap(rowsOf).filter((r) => !r.absent).map((r) => Math.abs(r.deviation_db));
    /* THEIR bands are fitted into the same scale for the same reason — but
     * only the ones they actually have. A reference stem with no air is a
     * band with no target, and a target line at −40 dB would read as "aim
     * here" rather than "there is nothing here". */
    const refPresent = (refRows || []).filter((r) => !r.absent).map((r) => Math.abs(r.deviation_db));
    const SCALE = clamp(Math.ceil(Math.max(6, ...present, ...refPresent, 0)), 6, 30);
    const half = (h - splitY) / 2 - 10;
    for (const b of bands) {
      const x0 = xOf(b.lo), x1 = xOf(b.hi);
      const bar = (row, col, x, wd) => {
        const dy = clamp(row.deviation_db / SCALE, -1, 1) * half;
        g.fillStyle = row.absent ? P.ghost : col;
        g.fillRect(x, dy < 0 ? zero : zero - dy, wd, Math.max(1, Math.abs(dy)));
      };
      const wd = Math.max(2, (x1 - x0) - 3);
      const [L, R] = rowsOf(b);
      if (stereo) {
        bar(L, P.primary, x0 + 1, wd / 2 - 1);
        bar(R, P.accent, x0 + 1 + wd / 2, wd / 2 - 1);
      } else {
        bar(L, Math.abs(L.deviation_db) > 3 ? P.warn : P.ok, x0 + 1, wd);
      }
      /* THEIR band, as a line across the width of the band rather than a
       * second bar: a bar is a thing you made, a line is a thing to reach. */
      const rr = refRows?.[b.i];
      if (rr && !rr.absent) {
        const y = Math.round(zero - clamp(rr.deviation_db / SCALE, -1, 1) * half) + 0.5;
        g.strokeStyle = P.secondary; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x0 + 1, y); g.lineTo(x0 + 1 + wd, y); g.stroke();
        g.lineWidth = 1;
      }
      g.fillStyle = P.ghost; g.font = `9px ${P.mono}`;
      g.save();
      g.translate(x0 + (x1 - x0) / 2, h - 2);
      g.textAlign = "center";
      g.fillText(b.name, 0, 0);
      g.restore();
    }
    g.fillStyle = P.faint; g.font = `9px ${P.mono}`;
    const gone = bands.filter((b) => rowsOf(b).every((r) => r.absent)).length;
    g.fillText(`nine bands, dB off the pink null · ±${SCALE} dB full scale`
      + (gone ? ` · ${gone} band${gone === 1 ? "" : "s"} absent (grey, and not in the scale)` : "")
      + (refRows ? " · the line across each band is the reference" : ""),
    26, splitY + 10);
    /* A profile IS picked and these bars have no line on them: say which of
     * the two reasons it is, because "the overlay is missing" is a bug report
     * and "that profile has no bass stem" is an answer. */
    if (V.prof && !refRows) {
      g.fillStyle = P.warn;
      /* Two different absences, and they are not the same news. A profile with
       * no such stem has nothing anywhere; a profile whose NINE BANDS are not
       * ear.py's still has a usable 1/3-octave curve, because that one is
       * plotted against frequency and cannot be put out of step by an index.
       * Only the bars lose their line. */
      g.fillText(ref
        ? "the profile's nine bands are not ear.py's — no line on these bars "
          + "(the curve above is still theirs, plotted by frequency)"
        : `no ${V.stem === "auto" ? FAMILY_STEM[V.family] || "other" : V.stem} block in this profile`,
      26, splitY + 21);
    }
  }

  /* THE ENVELOPE, in dB, because that is the unit decay is heard in. The
   * three decay times are drawn where they were measured — and when a note is
   * too short to fall 60 dB, t60 is written as not reached rather than drawn
   * at the end of the buffer. A made-up t60 is how a knob gets set to a
   * number nobody measured. */
  function drawEnv(a) {
    const { g, w, h } = fitCanvas(envCv);
    const P = palette();
    const env = a.envelope;
    if (!env?.mid?.db?.length) { cap.vlEnv.textContent = ""; return; }
    const stereo = !a.mono;
    const e = env.mid;
    const hop = e.db_hop_ms || 1;
    const span = Math.max(1, (e.db.length - 1) * hop);
    const FLOOR = -72;
    const xOf = (ms) => 30 + (clamp(ms, 0, span) / span) * (w - 36);
    const yOf = (db) => 10 + (clamp(db, FLOOR, 0) / FLOOR) * (h - 26);

    /* WHERE THE SOUND ACTUALLY STOPS. The render is `dur + TAILS[patch]` long
     * and the tail table is one number per patch, so a voice whose knobs make
     * it short goes silent long before the buffer ends — this lead runs out at
     * 303 ms of a 734 ms render. That flat line along the floor is real
     * silence, not a broken plot, and saying which is the difference between
     * "the picture is odd" and "the reserved tail is twice what this patch
     * needs at these settings". */
    const last = e.db.reduce((acc, v, i) => (v > FLOOR ? i : acc), 0);
    const silentAt = last < e.db.length - 2 ? last * hop : null;

    /* THEIR KICK, and only theirs — a profile carries ONE envelope, measured
     * off the drums stem as the average shape of N hits, so it is honest
     * behind a drums-family voice and meaningless behind a pad. `refKick`
     * returns null for every other stem rather than this function guessing. */
    const rk = refKick();
    const rs = rk?.shape;

    cap.vlEnv.textContent =
      `peak ${fmt(e.peak_db, 1, " dB")} · attack ${fmt(e.attack_ms, 1, " ms")} · `
      + `t10 ${fmt(e.t10_ms, 0, " ms")} · t30 ${fmt(e.t30_ms, 0, " ms")} · t60 ${e.t60_ms == null ? "not reached" : `${e.t60_ms.toFixed(0)} ms`}`
      + (silentAt == null ? "" : ` · silent from ${silentAt.toFixed(0)} of ${span.toFixed(0)} ms`)
      + (rs ? ` · ref t10 ${fmt(rs.t10_ms, 0, " ms")} over ${rs.hits ?? "?"} hits` : "");

    g.strokeStyle = P.line; g.fillStyle = P.ghost; g.font = `9px ${P.mono}`;
    for (const db of [0, -10, -30, -60]) {
      const y = Math.round(yOf(db)) + 0.5;
      g.setLineDash(db === 0 ? [] : [3, 3]);
      g.beginPath(); g.moveTo(30, y); g.lineTo(w, y); g.stroke();
      g.fillText(`${db}`, 4, y + 3);
    }
    g.setLineDash([]);

    /* THEIRS, BEHIND OURS AND ON OUR CLOCK. Both curves are dB below their
     * own peak, so the y-axis is shared without a gain match; the x-axis is
     * ours, and where their measurement runs longer than our render it is cut
     * at the edge and the cut is named rather than squeezed to fit. */
    let refPast = null;
    if (rs?.envelope_db?.length) {
      const rhop = rs.envelope_hop_ms || 1;
      const rspan = (rs.envelope_db.length - 1) * rhop;
      refPast = rspan > span ? rspan : null;
      g.strokeStyle = P.secondary; g.lineWidth = 1.4;
      g.setLineDash([4, 3]);
      g.beginPath();
      let started = false;
      rs.envelope_db.forEach((v, i) => {
        const t = i * rhop;
        if (t > span) return;
        const x = xOf(t), y = yOf(v);
        started ? g.lineTo(x, y) : g.moveTo(x, y);
        started = true;
      });
      g.stroke();
      g.setLineDash([]);
      /* their decay times as short ticks on the same grid lines ours uses */
      g.strokeStyle = P.secondary;
      for (const [t, db] of [[rs.t10_ms, -10], [rs.t30_ms, -30], [rs.t60_ms, -60]]) {
        if (t == null || t > span) continue;
        const x = Math.round(xOf(t)) + 0.5;
        g.beginPath(); g.moveTo(x, yOf(db) - 4); g.lineTo(x, yOf(db) + 4); g.stroke();
      }
    }

    for (const [k, col, wid] of stereo
      ? [["L", P.primary, 1], ["R", P.accent, 1], ["mid", P.ink, 1.5]]
      : [["mid", P.primary, 1.5]]) {
      const row = env[k];
      if (!row?.db?.length) continue;
      g.strokeStyle = col; g.lineWidth = wid; g.beginPath();
      row.db.forEach((v, i) => {
        const x = xOf(i * (row.db_hop_ms || hop)), y = yOf(v);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    }
    g.lineWidth = 1;
    if (rs) {
      g.fillStyle = P.secondary; g.font = `9px ${P.mono}`;
      g.fillText(`dashed: ${V.prof?.name || V.profId} kick, ${rs.hits ?? "?"} hits averaged`
        + (refPast ? ` — cut at ${span.toFixed(0)} ms, it runs to ${refPast.toFixed(0)}` : ""),
      34, 11);
    } else if (V.prof && refStem()) {
      g.fillStyle = P.ghost; g.font = `9px ${P.mono}`;
      g.fillText("a profile measures one envelope, off its drums stem — nothing to draw here",
        34, 11);
    }

    /* the three markers, each labelled with what it measured */
    for (const [key, db, label] of [["t10_ms", -10, "t10"], ["t30_ms", -30, "t30"], ["t60_ms", -60, "t60"]]) {
      const t = e[key];
      if (t == null) continue;
      const x = Math.round(xOf(t)) + 0.5;
      g.strokeStyle = P.secondary;
      g.beginPath(); g.moveTo(x, yOf(0)); g.lineTo(x, yOf(db)); g.stroke();
      g.fillStyle = P.secondary; g.font = `9px ${P.mono}`;
      g.fillText(`${label} ${t.toFixed(0)}`, Math.min(x + 3, w - 46), yOf(db) - 3);
    }
    if (silentAt != null) {
      const x = Math.round(xOf(silentAt)) + 0.5;
      g.strokeStyle = P.ghost;
      g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(x, 8); g.lineTo(x, h - 12); g.stroke();
      g.setLineDash([]);
      g.fillStyle = P.ghost; g.font = `9px ${P.mono}`;
      g.fillText(`silent from here — ${(span - silentAt).toFixed(0)} ms of reserved tail unused`,
        Math.min(x + 3, w - 250), 18);
    }
    if (e.t60_ms == null) {
      g.fillStyle = P.ghost;
      g.fillText(`t60 not reached in ${fmt(e.measured_over_ms, 0, " ms")}`, 34, h - 4);
    }
    g.fillStyle = P.faint;
    g.fillText(`dB below peak · ${span.toFixed(0)} ms`, w - 118, h - 4);
  }

  /**
   * THE DISTANCE. The other three pictures put their curve behind ours; this
   * one is the subtraction, which is the thing you actually turn a knob
   * against — nine bars of (ours − theirs) in dB, and under them the
   * reference's own numbers, each labelled as what it is.
   *
   * WHAT IS SUBTRACTED AND WHAT IS NOT. Only two families of number survive
   * the gap between one note and a finished record: deviation from the pink
   * null (both gain-invariant) and decay times (both measured the same way).
   * Those are differenced. Loudness, level and width are printed as the
   * reference's own numbers and never subtracted, because our side of them
   * does not exist on a single note — the Ear measures those on the mix. A
   * panel that differenced them would produce a confident number with no
   * meaning, which is the exact failure the empty slot was protecting against.
   */
  function drawOverlay(a) {
    const ref = refStem();
    const sp = a.spectrum;
    const refRows = refBands(sp);
    overCv.hidden = !refRows;
    if (!ref) {
      slot.hidden = false;
      slot.innerHTML = EMPTY_SLOT;
      cap.vlOverlay.textContent = V.prof ? "profile picked, no matching block" : "no profile picked";
      return;
    }
    slot.hidden = false;
    cap.vlOverlay.textContent = `${V.prof?.name || V.profId} · ${ref.id}`;

    /* ── the nine deltas ── */
    const mine = sp?.per_channel?.mid?.bands;
    const deltas = refRows && mine
      ? refRows.map((r, i) => ({
        name: r.name,
        /* an absent band on EITHER side has no distance: "there is none
         * here" minus "there is none here" is not zero, it is undefined */
        d: (r.absent || mine[i].absent) ? null : mine[i].deviation_db - r.deviation_db,
      }))
      : [];
    const live = deltas.filter((x) => x.d !== null);
    const near_ = live.filter((x) => Math.abs(x.d) <= BAND_NEAR_DB).length;
    const worst = live.reduce((acc, x) => (!acc || Math.abs(x.d) > Math.abs(acc.d) ? x : acc), null);

    if (refRows) {
      const { g, w, h } = fitCanvas(overCv);
      const P = palette();
      const SPAN = clamp(Math.ceil(Math.max(6, ...live.map((x) => Math.abs(x.d)), 0)), 6, 36);
      const zero = Math.round(h * 0.52) + 0.5;
      const half = h * 0.52 - 16;
      const cw = (w - 8) / Math.max(1, deltas.length);
      g.strokeStyle = P.line;
      g.beginPath(); g.moveTo(4, zero); g.lineTo(w - 4, zero); g.stroke();
      deltas.forEach((x, i) => {
        const cx = 4 + i * cw;
        if (x.d === null) {
          g.fillStyle = P.ghost; g.font = `9px ${P.mono}`;
          g.save(); g.translate(cx + cw / 2, zero - 4); g.textAlign = "center";
          g.fillText("—", 0, 0); g.restore();
        } else {
          const dy = clamp(x.d / SPAN, -1, 1) * half;
          g.fillStyle = Math.abs(x.d) <= BAND_NEAR_DB ? P.ok : P.warn;
          g.fillRect(cx + 2, dy < 0 ? zero : zero - dy, cw - 5, Math.max(1, Math.abs(dy)));
        }
        g.fillStyle = P.ghost; g.font = `9px ${P.mono}`;
        g.save(); g.translate(cx + cw / 2, h - 3); g.textAlign = "center";
        g.fillText(x.name, 0, 0); g.restore();
      });
      g.fillStyle = P.faint; g.font = `9px ${P.mono}`;
      g.fillText(`ours − ${ref.id}, dB off the pink null · ±${SPAN} dB · `
        + `above the line = we have more`, 6, 11);
      g.fillText(`${near_} of ${live.length} within ${BAND_NEAR_DB} dB`
        + (worst ? ` · worst ${worst.name} ${worst.d > 0 ? "+" : ""}${worst.d.toFixed(1)}` : "")
        + (live.length < deltas.length ? ` · ${deltas.length - live.length} band(s) absent on one side` : ""),
      6, 22);
    }

    /* ── the numbers, as text, built element by element ── */
    slot.textContent = "";
    const e = a.envelope?.mid;
    const rk = refKick();
    const rows = [];
    const num = (v, dp, unit) => (isNum(v) ? `${Number(v).toFixed(dp)}${unit || ""}` : "—");

    if (rk?.shape && e) {
      const rs = rk.shape;
      for (const [label, ours, theirs] of [
        ["t10", e.t10_ms, rs.t10_ms], ["t30", e.t30_ms, rs.t30_ms], ["t60", e.t60_ms, rs.t60_ms],
      ]) {
        const both = isNum(ours) && isNum(theirs);
        rows.push([label, `${num(ours, 0, " ms")} → ${num(theirs, 0, " ms")}`,
          both ? `${ours - theirs > 0 ? "+" : ""}${(ours - theirs).toFixed(0)} ms` : "not both measured"]);
      }
    }
    const targets = [];
    if (rk) {
      targets.push(["kick f0", num(rk.f0_hz, 1, " Hz"), `over ${rk.f0_hits ?? "?"} hits`]);
      targets.push(["sub over kick", num(rk.sub_over_kick_db, 2, " dB"), "how far the sub sits under the kick's own band"]);
      const cl = rk.click;
      if (cl) targets.push(["transient over body", num(cl.click_over_body_db, 2, " dB"), `over ${cl.hits ?? "?"} hits`]);
    }
    const pu = V.prof?.pump;
    if (pu) {
      targets.push(["sidechain depth", num(pu.depth_db, 2, " dB"), `± ${num(pu.depth_mad_db, 2, " dB")} across ${pu.hits ?? "?"} hits`]);
      targets.push(["recovery", num(pu.recovery_ms, 1, " ms"), `${num(pu.recovery_frac_of_beat, 3, "")} of a ${num(pu.beat_s, 4, " s")} beat`]);
    }
    const st = ref.block.stereo;
    if (st) {
      targets.push(["width", num(st.width, 3, ""),
        a.mono ? "ours is exactly 0 — this render is one channel (try the stereo path)" : "ours is not measured on one note"]);
      targets.push(["correlation", num(st.correlation, 3, ""), st.mono_compatible ? "mono-compatible" : "not mono-compatible"]);
    }
    if (isNum(ref.block.level_rel_mix_db)) {
      targets.push(["level vs their mix", num(ref.block.level_rel_mix_db, 2, " dB"), "a fader target for the whole track, not for one note"]);
    }

    if (rows.length) {
      slot.append(EL("b", null, "measured on both sides"));
      slot.append(table(rows));
    }
    if (targets.length) {
      slot.append(EL("b", null, "the reference's own numbers — targets, never subtracted"));
      slot.append(table(targets));
    }
    const foot = EL("div", "vl-foot");
    foot.textContent =
      "We render one note; a stem is minutes of a finished record. The two curves above "
      + "are dB shares and dB off the pink null, which is why they share an axis at all — "
      + "loudness, level and width are printed as theirs and never differenced. A profile "
      + "is shape only: no audio, no melody, nothing that could be played back.";
    slot.append(foot);
  }

  /** A two-column read-out. textContent everywhere: every string below came
   *  off a file this machine did not write. */
  function table(rows) {
    const t = EL("div", "vl-nums");
    for (const [label, value, note2] of rows) {
      t.append(EL("span", "vl-nk", label), EL("span", "vl-nv", value), EL("span", "vl-nn", note2 || ""));
    }
    return t;
  }

  /* ── small builders ─────────────────────────────────────────────────── */

  function lab(text, el) {
    const l = EL("label", null, text);
    l.appendChild(el);
    return l;
  }
  function numField(name, lo, hi, val) {
    const i = EL("input");
    i.type = "number"; i.min = String(lo); i.max = String(hi); i.value = String(val);
    i.title = `${name}: ${lo}..${hi}`;
    return i;
  }
  function niceTicks(lo, hi, want) {
    const raw = (hi - lo) / Math.max(1, want);
    const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
  }

  /* Redraw at the size the pane actually is. A dock drag changes every
   * canvas's width, and a canvas drawn at yesterday's width is a blurred
   * picture of the right numbers. */
  const ro = new ResizeObserver(() => { if (V.open && V.last) redraw(); });
  ro.observe(cvs);

  /* The page has no "selection changed" event and no "document changed"
   * event this module can hear, so while the pane is OPEN it reads three
   * fields off the handle once a second and follows them. Closed, it costs
   * nothing at all. */
  setInterval(() => { if (V.open) sync(); }, 1000);

  say("pick a track and press render — nothing here writes to the document until you press apply");
  return { show: showVoice, render: () => bump("api"), state: () => V };
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE MOUNT. daw.html loads this file as its own module script rather than
 * daw.js importing it, so it mounts itself the moment the pane it belongs in
 * exists. The guard at the top of mountVoiceLab makes a host that would
 * rather call it directly safe to do so — the second call is a no-op.
 * ══════════════════════════════════════════════════════════════════════════ */
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountVoiceLab(), { once: true });
  } else {
    mountVoiceLab();
  }
}
