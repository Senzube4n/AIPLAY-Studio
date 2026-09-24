/**
 * DAW — the arrangement window's browser half.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE BINDING PRINCIPLE (the owner's words, and the only rule that matters
 * here): everything MCP-controllable AND completely human-adjustable, ONE
 * document model behind both. So every gesture in this file posts one of the
 * SAME /api/daw actions server/mcp-daw.js posts. There is no second write
 * path — not one optimistic local mutation that skips the server, not one
 * "UI-only" field. When you find yourself wanting one, you have found a
 * missing action, not a shortcut.
 *
 * The visible consequence, and the reason `live sync` exists below: an agent
 * editing this project over MCP writes the same project.json this page is
 * looking at. The server broadcasts that on the existing /live websocket and
 * the page re-reads and redraws — the note appears, the fader moves, the
 * region shimmers while it re-renders. No refresh, no "AI mode", and every
 * change carries `by: agent|user` into the session log.
 *
 * WHAT IS DELIBERATELY NOT HERE: an audio engine. The browser never
 * synthesises a note — it plays files the server rendered, so the monitor IS
 * the bounce (the report's non-negotiable). The only client-side audio maths
 * is scheduling and, for the master meter, reading the samples we are
 * already playing.
 *
 * TIME. The x-axis is QUARTER NOTES, not bars: bars are uneven in mixed
 * meter (a 7/8 bar is narrower than a 4/4 bar — that is the feature), and the
 * server's derived timeline rows carry each bar's quarter offset/length, so
 * every grid in this file is drawn FROM the maps, never from an assumed 4/4.
 * All positions sent to the server are musical (bar.beat.tick); seconds
 * appear only in the playback scheduler and the clock readout.
 *
 * AUTOMATION. Keyframe times are FLOAT BARS (3.5 = halfway through bar 3),
 * the shape mixer.js already stores and rack.py already evaluates. The lanes
 * below read and write that exact shape; nothing is converted, mirrored or
 * re-invented.
 *
 * COLOUR. Every canvas colour is read at boot from the CSS custom properties
 * in web/styles.css (see `C` below). This file never spells a colour.
 */

import { resizeNoteDurations } from "./daw-editing.js";
import { EXPORT_PRESETS, exportSettings, exportFacts, exportDownloadUrl } from "./daw-export.js";
import { audioResultDetails, stemResultDetails } from "./daw-audio-results.js";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

const TPB = 960;                 // ticks per beat (the denominator unit)
const ROW_H = 12;                // DEFAULT piano-roll pixels per semitone (S.rowH zooms it)
const ROW_MIN = 5, ROW_MAX = 34; // the vertical-zoom limits
const PXQ_MIN = 6, PXQ_MAX = 320;    // the roll's horizontal-zoom limits
const APXQ_MIN = 2, APXQ_MAX = 160;  // the arrangement's
const PITCH_HI = 96, PITCH_LO = 24;
const KEYS_W = 44;               // the piano-key gutter
/* THE ROLL'S TOP PAD IS ZERO. It used to be a 22 px bar-number lane drawn
 * INSIDE the roll canvas — which scrolled away the moment you looked at a
 * low note, so the editor had no ruler exactly when you needed one. The bar
 * numbers now live in #rollRuler, a canvas of their own that is sticky to
 * the top of the editor's scroll box (and carries the loop range). */
const TOP_H = 0;
const ROLL_RULER_H = 26;         // the piano roll's own ruler
const VEL_H = 64;                // the velocity lane at the bottom of the roll
const VEL_GAP = 8;
const LANE_H = 46;               // arrangement track lane height
const AUTO_H = 34;               // arrangement automation sub-lane height
const WAVE_H = 38;               // arrangement per-track WAVEFORM lane height (§4)

/* ── THE TRANSPORT'S CLOCK, in three numbers ──────────────────────────────
 * TICK_MS is the wake interval; LOOKAHEAD is how far ahead of the audio
 * clock each wake fills the schedule; AHEAD_EVERY is how many wakes apart
 * the look-ahead render runs (7 x 150 ms ≈ 1 Hz, which is the rate §1 asks
 * for and is nowhere near often enough to matter to the scheduler). */
const TICK_MS = 150;
const LOOKAHEAD = 0.8;
const AHEAD_EVERY = 7;
/* How many regions ahead of the playhead the readiness badge judges when no
 * loop range is set. It is a PROMISE WINDOW, not a song audit: four regions
 * is sixteen bars — about thirty seconds at 128 BPM — which is as far ahead
 * as a rolling monitor can be asked to answer for. See aheadWindow(). */
const AHEAD_REGIONS = 4;
const RULER_H = 26;
const HEAD_W = 168;              // must match --d-head-w in daw.css
const TRK_COLOURS = 5;           // --d-trk-0 … --d-trk-4 in daw.css
                                 // (--secondary is reserved: it means "the agent did this")

/* ────────────────────────────────────────────────────────── state */

const S = {
  slug: null,
  projectEpoch: 0, docRead: 0, renderRequest: 0,
  proj: null,
  timeline: [],                  // server-derived bar rows
  totalSeconds: 0,
  regions: [],                   // last render manifest rows
  buffers: new Map(),            // region idx -> { hash, buffer, url }
  trackId: null,
  drag: null,
  sel: new Set(),                // selected note ids (piano roll)
  mode: "draw",                  // draw | select | erase
  grid: 480,                     // snap/quantize ticks; 0 = off
  pxq: 56,                       // piano-roll pixels per quarter
  arrPxq: 22,                    // arrangement pixels per quarter
  rowH: ROW_H,                   // piano-roll pixels per semitone (vertical zoom)
  rollLo: PITCH_LO,              // the pitch window the roll canvas spans …
  rollHi: PITCH_HI,              // … so an empty octave is not half the window
  rollFit: true,                 // fit-to-content stays armed until you zoom by hand
  loopA: null, loopB: null,      // the loop range in FLOAT BARS; null = the whole song
  colours: {},                   // trackId -> colour index override (local, see colourOf)
  lanes: [],                     // open automation lanes (keys, see laneRef)
  laneCur: null,
  devTarget: null,               // { kind:"track"|"return"|"master", id }
  devInsert: null,
  autoWrite: false,
  meters: null,                  // last `meters` measurement
  paint: [],                     // strip repainters — automated values follow the playhead
  dragging: false,               // a control is under the pointer; leave it alone
  peaks: new Map(),              // audio file -> Float32Array of |peak| buckets
  /* §2 the velocity gesture in force. Nothing in the document is touched
   * while one is live: every velocity on the page is READ through it. */
  velStrategy: null,
  /* §1 the look-ahead: the last render_plan, and what the badge is saying. */
  ahead: { plan: null, at: null, busy: false, asking: false,
           state: "idle", txt: "ahead —", why: "", painted: "" },
  /* §4 the per-track waveform lanes: which tracks are open, the stem rows
   * render_stems answered with, and the mip-map slices drawn from them. */
  wave: { open: new Set(), stems: new Map(), peaks: new Map(), busy: new Set(), note: "", result: null, error: "", previewKey: "" },
  /* note auditioning — see auditionNote. seq cancels replies in flight,
   * lastPitch gates a drag to real pitch changes, cache holds decoded wavs. */
  aud: { on: true, seq: 0, node: null, at: 0, lastPitch: null, cache: new Map() },
  mixNarrow: false,              // compact mixer strips
  /* WHERE THE PANELS ARE — the project's own `view`, exactly as the server
   * normalised it. Not a browser preference: it arrives with the document and
   * an agent can move it (daw_layout), so this mirrors the server rather than
   * deciding anything. `viewApplied` below is what is on screen. */
  view: null,
  // playback
  ctx: null, master: null, analyser: null, anaBuf: null,
  playing: false,
  anchor: 0,                     // ctx.currentTime that maps to project t=0
  loop: true,
  at: 0,                         // playhead seconds while stopped
  nodes: new Map(),
  /* THE TICKER, and the two numbers that make it self-healing. `ticker` is
   * the Worker (or the setTimeout fallback) — see makeTicker; `lastUpdate`
   * is the end of the window the last wake scheduled, so a late wake WIDENS
   * the window instead of stepping over a region boundary. */
  ticker: null,
  lastUpdate: 0,
  tickN: 0,
  clickBuf: null, clickSrc: null,
  // metering ballistics (master, from the audio we are actually playing)
  mtr: { peak: 0, hold: 0, holdAt: 0, rms: 0, at: 0 },
  // stopwatch + render honesty
  sw: [],
  pending: [],                   // dirty ranges currently being re-rendered
  rendering: false,
  // undo/redo: inverse operations through the SAME actions, both ways
  undo: [],
  redo: [],
  keymap: "ctrl",
  ws: null,
  // the analysis pane's own state (see THE ANALYSIS DISPLAYS below)
  ana: { tab: "chain", live: true, spec: null, hold: null, loud: null,
         corr: [], goni: null, note: "", measured: null, curves: new Map() },
};

/* A read-only debug handle: lets a driving agent (or a person in devtools)
 * verify state without a UI to look at. The UI itself never reads it. */
window.__daw = S;

/** A reload of the same slug starts a new session too. */
function captureSession() { return { epoch: S.projectEpoch, slug: S.slug }; }
function sessionCurrent(session) {
  return !!session && session.slug === S.slug && session.epoch === S.projectEpoch;
}

/* ────────────────────────────────────────────────────────── api */

/** A refusal that names a one-click setup (R0 `setup`: SciPy missing from
 *  Studio's own engine, which engine.py imports at the top) offers it with
 *  the dialog from web/setup-feature.js, loaded only when one arrives. At
 *  most once a minute per setup: a broken engine fails every render the
 *  same way. The error still reaches the status line as before. */
const setupOffered = new Map();
function offerRefusalSetup(j) {
  if (!j?.setup || Date.now() - (setupOffered.get(j.setup) || 0) < 60_000) return;
  setupOffered.set(j.setup, Date.now());
  import("./setup-feature.js").then((m) => m.offerSetup(j.setup, j.error)).catch(() => {});
}

async function api(body) {
  const r = await fetch("/api/daw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "user", ...body }),
  });
  const j = await r.json();
  if (j.error) {
    if (typeof offerRefusalSetup === "function") offerRefusalSetup(j);
    throw new Error(j.error);
  }
  return j;
}
async function get(p) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let r, j;
  try {
    r = await fetch(p, { signal: controller.signal });
    j = await r.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("The server took too long to respond. Please retry.");
    throw err;
  } finally { clearTimeout(timeout); }
  if (!r.ok || j.error) {
    if (typeof offerRefusalSetup === "function") offerRefusalSetup(j);
    throw new Error(j.error || `Request failed (${r.status})`);
  }
  return j;
}

/* Pointer capture, hardened. `setPointerCapture` / `releasePointerCapture`
 * throw InvalidPointerId whenever the pointer is already gone — a real
 * browser does that on pointercancel (a touch turning into a scroll, a
 * window losing focus mid-drag), and the throw lands INSIDE the listener,
 * so everything after it in that handler is skipped. The commit-on-release
 * lives after it, which means a cancelled drag would silently never write.
 * One try/catch each, and the gesture always finishes. */
function capturePointer(el, id) { try { el.setPointerCapture(id); } catch { /* already gone */ } }
function releasePointer(el, id) { try { el.releasePointerCapture?.(id); } catch { /* already gone */ } }

/* ────────────────────────────────────────── the palette, read once */

const C = {};
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["primary", "secondary", "accent", "ink", "dim", "faint",
                   "ghost", "ok", "err", "warn", "edge", "edge-s", "hair",
                   "panel", "raise", "rail", "on"]) {
    C[k] = (cs.getPropertyValue(`--${k}`) || "").trim() || "#8b8b9a";
  }
  /* The track colour set, resolved once. daw.css defines --d-trk-0…5 as
   * aliases of tokens this app already owns, so a track's colour is never
   * a colour this file invented — it is one of the six the Studio has. */
  const sh = getComputedStyle($("shell"));
  C.trk = [];
  for (let i = 0; i < TRK_COLOURS; i++) {
    const raw = (sh.getPropertyValue(`--d-trk-${i}`) || "").trim();
    C.trk.push(raw.startsWith("var(")
      ? (cs.getPropertyValue(raw.slice(4, -1).trim()) || "").trim() || C.primary
      : raw || C.primary);
  }
}

/* ─────────────────────────────────────────────── TRACK COLOUR ───────────
 * A DAW leans on colour for orientation, and every track being one colour
 * is the reason the arrangement reads as a spreadsheet. The default is
 * DERIVED FROM THE TRACK ID, not stored: an agent that adds a track over
 * MCP gets a colour without anybody having to write one, and both hands
 * compute the same one for the same track, so the two views cannot drift.
 *
 * ⚠ SERVER GAP, reported rather than worked around: `set_track` ignores
 * fields it does not know, so a hand-picked override CANNOT be persisted
 * into the document — it lives in localStorage, is per-browser, and says so
 * in its own tooltip. When set_track grows a `colour` field this becomes one
 * more act() call and the override joins the document like everything else. */
/* By POSITION in the track list, not by a hash of the id. Both are
 * derived-from-the-document and so agree between the two hands, but with
 * only five colours a hash collides constantly — and two ADJACENT tracks
 * sharing a colour is precisely the failure the colours exist to prevent.
 * The cost is that deleting a track re-letters the ones below it; the
 * per-track override below is the answer for anyone that bothers. */
const colourIx = (id) => {
  const i = (S.proj?.tracks || []).findIndex((t) => t.id === id);
  if (i >= 0) return i % TRK_COLOURS;
  const s = String(id || "");
  let h = 0;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
  return h % TRK_COLOURS;
};
const colourOfIx = (i) => C.trk?.[i % TRK_COLOURS] || C.primary;
/** The colour index a track wears: the local override, else the derived one. */
function colourIxOf(id) {
  const over = S.colours[id];
  return Number.isInteger(over) ? over : colourIx(id);
}
const colourOf = (id) => colourOfIx(colourIxOf(id));
function loadColours() {
  try { S.colours = JSON.parse(localStorage.getItem(`daw.colours.${S.slug}`) || "{}"); }
  catch { S.colours = {}; }
}
function saveColours() {
  try { localStorage.setItem(`daw.colours.${S.slug}`, JSON.stringify(S.colours)); }
  catch { /* private mode: the derived colours still work */ }
}
/** Draw with a token colour at an alpha, without inventing a second colour. */
function tint(g, colour, alpha, fn) {
  const prev = g.globalAlpha;
  g.globalAlpha = prev * alpha;
  g.fillStyle = colour; g.strokeStyle = colour;
  fn();
  g.globalAlpha = prev;
}

/* ═════════════════════════════════════════════════ CANVAS GEOMETRY ══════
 * Every canvas here is a BITMAP that the browser then scales into the
 * element's CSS box. Leave either half of that implicit and two separate
 * things go wrong — this page had both.
 *
 *   1. devicePixelRatio. A 200-CSS-px canvas carrying a 200-px bitmap is
 *      resampled by the compositor wherever dpr ≠ 1, and 8px monospace
 *      does not survive resampling. Windows' 110 % display scaling makes
 *      dpr 1.1, which is the worst case there is: a non-integer ratio
 *      ghosts every stem it touches.
 *
 *   2. THE INTRINSIC RATIO — the one that actually disfigured the mixer.
 *      A canvas carrying width/height ATTRIBUTES but no CSS width/height
 *      is a replaced element with an intrinsic aspect ratio. Stretch it in
 *      a flex row and the cross axis wins, then the ratio recomputes the
 *      main axis and blows straight past its own flex-basis. The mixer's
 *      14×160 meter became 58.5×668 and its 20×160 dB scale became
 *      83.5×668: a 4.18× upscale of an 8px font, and 168 px of children
 *      inside an 84 px row — exactly 100 % overflow, silently clipped by
 *      `overflow: hidden`. That is what "blurry stuff in the mixer" and
 *      "the scroll section is a bit overlapping" both were.
 *
 * fitCanvas answers both at once: the bitmap is sized in DEVICE pixels,
 * the element is PINNED in CSS pixels (which is what kills the intrinsic
 * ratio dead), and the context is pre-scaled so every drawing routine in
 * this file goes on speaking plain CSS pixels.
 *
 * fitLive is the variant for canvases whose box CSS already decides
 * (width:100% in a flex figure): it measures rather than pins, because
 * pinning those would freeze a layout that is supposed to respond.
 */
const DPR = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

/* Chrome's per-axis canvas limit. Over it a canvas does not clamp — it
 * comes back BLANK. The roll and the arrangement draw a WHOLE SONG into one
 * bitmap, so at a high zoom they are already near it before any scaling
 * (16 bars at PXQ_MAX is 20 544 CSS px today). Multiplying by dpr must not
 * be the thing that tips one over, so the ratio is backed off instead: a
 * canvas that has to draw softer than its display is still a canvas you can
 * see, and a blank one is not. */
const MAX_BITMAP = 16384;
const fitRatio = (w, h) => Math.max(0.1, Math.min(DPR(), MAX_BITMAP / Math.max(w, h)));

function fitCanvas(cv, cssW, cssH) {
  const w = Math.max(1, Math.round(cssW)), h = Math.max(1, Math.round(cssH));
  const dpr = fitRatio(w, h);
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  if (cv.style.width !== `${w}px`) cv.style.width = `${w}px`;
  if (cv.style.height !== `${h}px`) cv.style.height = `${h}px`;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);          // after any width write — it resets state
  cv._cw = w; cv._ch = h;                        // the CSS size, for repainters on a timer
  return { g, w, h };
}

function fitLive(cv, minW = 40, minH = 30) {
  const r = cv.getBoundingClientRect();
  const w = Math.max(minW, Math.round(r.width)), h = Math.max(minH, Math.round(r.height));
  const dpr = fitRatio(w, h);
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  cv._cw = w; cv._ch = h;
  return { g, w, h };
}

/* ─────────────────────────────────────────────── musical time (mirror) */
/* Tiny mirrors over the SERVER's timeline rows — never recomputed from an
 * assumption. The server remains the authority: every mutation round-trips. */

const rowOf = (bar) => S.timeline[Math.min(Math.max(1, bar), S.timeline.length) - 1];

function posToQ(bar, beat, tick) {
  const r = rowOf(bar);
  if (!r) return 0;
  return r.qStart + ((beat - 1) * TPB + tick) / TPB * (4 / r.den);
}
function durTicksToQ(bar, beat, tick, durTicks) {
  let b = bar, ticksIn = (beat - 1) * TPB + tick, left = durTicks, q = 0;
  for (let guard = 0; guard < 4096 && left > 0; guard++) {
    const r = rowOf(b);
    if (!r) break;
    const room = r.ticksPerBar - ticksIn;
    const take = Math.min(left, room);
    q += take / TPB * (4 / r.den);
    left -= take; b++; ticksIn = 0;
  }
  return q;
}
/** quarters → bar.beat.tick at FULL tick resolution (no snap). */
function qToPosFine(q) {
  let row = S.timeline[0];
  for (const r of S.timeline) { if (q >= r.qStart) row = r; else break; }
  if (!row) return { bar: 1, beat: 1, tick: 0 };
  const ticks = Math.max(0, Math.round((q - row.qStart) / (4 / row.den) * TPB));
  const capped = Math.min(ticks, row.ticksPerBar - 1);
  return { bar: row.bar, beat: Math.floor(capped / TPB) + 1, tick: capped % TPB };
}
/** quarters → bar.beat.tick, snapped to the editor grid (0 = no snap). */
function qToPos(q, grid = S.grid) {
  const p = qToPosFine(q);
  if (!grid) return p;
  const row = rowOf(p.bar);
  const ticksIn = (p.beat - 1) * TPB + p.tick;
  const snapped = Math.min(Math.round(ticksIn / grid) * grid, row.ticksPerBar - 1);
  return { bar: p.bar, beat: Math.floor(snapped / TPB) + 1, tick: snapped % TPB };
}
function secondsToQ(t) {
  let row = S.timeline[0];
  for (const r of S.timeline) { if (t >= r.sec) row = r; else break; }
  if (!row) return 0;
  return row.qStart + Math.min(1, Math.max(0, (t - row.sec) / row.secLen)) * row.qLen;
}
function posSecs(bar, beat, tick) {
  const r = rowOf(bar);
  if (!r) return 0;
  return r.sec + ((beat - 1) * TPB + tick) / TPB * (4 / r.den) * 60 / r.bpm;
}
const totalQ = () => {
  const last = S.timeline[S.timeline.length - 1];
  return last ? last.qStart + last.qLen : 0;
};
/** FLOAT BAR (the automation key unit) ⇄ quarters. 3.5 = halfway thru bar 3. */
function qOfBarFloat(t) {
  const bar = Math.max(1, Math.floor(t));
  const row = rowOf(bar);
  if (!row) return 0;
  return row.qStart + Math.min(1, Math.max(0, t - bar)) * row.qLen;
}
function barFloatOfQ(q) {
  let row = S.timeline[0];
  for (const r of S.timeline) { if (q >= r.qStart) row = r; else break; }
  if (!row) return 1;
  return row.bar + Math.min(1, Math.max(0, (q - row.qStart) / row.qLen));
}
const barFloatNow = () => barFloatOfQ(secondsToQ(projTime()));

/* ═════════════════════════════════════════════════ KEYMAP PROFILES ══════
 * The muscle-memory layer (report §13b). Three profiles over ONE action
 * table; the active binding is printed into the tooltip of the control it
 * drives, so the profile is discoverable rather than folklore. These are the
 * CORE gestures only — an honest subset, not a claim to have cloned three
 * DAWs' full key charts. */

const KM_ACTIONS = {
  play_stop:  { label: "Play / stop",            run: () => play() },
  stop:       { label: "Stop to start",          run: () => { stop(); setPlayhead(0); } },
  record:     { label: "Record",                 run: () => (REC.active ? stopRecording() : startRecording()) },
  loop:       { label: "Loop on/off",            run: () => toggleLoop() },
  duplicate:  { label: "Duplicate selection",    run: () => duplicateSelection() },
  del:        { label: "Delete selection",       run: () => deleteSelection() },
  quantize:   { label: "Quantize to the grid",   run: () => quantizeSelection() },
  undo:       { label: "Undo (inverse action)",  run: () => undoOnce() },
  redo:       { label: "Redo (replay the action)", run: () => redoOnce() },
  zoom_in:    { label: "Zoom in (time)",         run: () => zoomTime(1) },
  zoom_out:   { label: "Zoom out (time)",        run: () => zoomTime(-1) },
  vzoom_in:   { label: "Taller rows",            run: () => zoomRows(1) },
  vzoom_out:  { label: "Shorter rows",           run: () => zoomRows(-1) },
  zoom_fit:   { label: "Fit to the content",     run: () => fitBoth() },
  loop_sel:   { label: "Loop the selection",     run: () => loopAroundSelection() },
  draw:       { label: "Draw mode",              run: () => setMode("draw") },
  select:     { label: "Select mode",            run: () => setMode("select") },
  erase:      { label: "Erase mode",             run: () => setMode("erase") },
  new_track:  { label: "New track",              run: () => addTrackFromBrowser() },
  split:      { label: "Split at the playhead",  run: () => splitSelection() },
  mixer:      { label: "Show / hide the mixer",  run: () => toggleDock("mixer") },
  browser:    { label: "Show / hide the browser", run: () => toggleDock("browser") },
  render:     { label: "Render dirty regions",   run: () => renderAndSwap() },
};

/* ⚠ BOTH THE KEYS AND THE LABELS WERE THREE OTHER COMPANIES' PRODUCTS.
 *
 * A mark used as the NAME OF A THING WE SHIP is a different matter from the
 * nominative "Photoshop's ctrl-click" in a tooltip: that one describes a gesture
 * so a reader recognises ours, and it stays (see NOTICE, TRADEMARKS). These were
 * the first kind, in both the label a person reads and the identifier in the
 * source, so both changed.
 *
 * Each name now says what actually DIFFERS between the profiles, which turns out
 * to be more useful than a brand was — somebody hunting for the idiom their
 * fingers know can still press the ⌨ button beside the picker, which has always
 * shown the whole map.
 *
 * ⚠ THE RENAME IS ONLY FREE BECAUSE OF THE MIGRATION. The choice lives in
 * localStorage and nowhere else — no saved project carries it — but applyKeymap()
 * falls back to the default for a name it does not know, so without the KM_RENAMED
 * map at the read site anybody who had chosen a profile would be moved quietly
 * back to the first one. */
const KEYMAPS = {
  ctrl: {
    label: "Ctrl edits",                    // Ctrl+D duplicate, Ctrl+E split
    keys: {
      play_stop: "Space", stop: "Shift+Space", record: "F9", loop: "Ctrl+L",
      duplicate: "Ctrl+D", del: "Delete", quantize: "Ctrl+U", undo: "Ctrl+Z",
      draw: "B", select: "0", erase: "E", new_track: "Ctrl+T", split: "Ctrl+E",
      mixer: "Ctrl+Alt+M", browser: "Ctrl+Alt+B", render: "Ctrl+R",
      redo: "Ctrl+Shift+Z", zoom_in: "Alt+ArrowRight", zoom_out: "Alt+ArrowLeft",
      vzoom_in: "Alt+ArrowUp", vzoom_out: "Alt+ArrowDown", zoom_fit: "Alt+F",
      loop_sel: "Ctrl+Shift+L",
    },
  },
  fkeys: {
    label: "Function keys",                 // F9 mixer, F8 browser, R record
    keys: {
      play_stop: "Space", stop: "Shift+Space", record: "R", loop: "L",
      duplicate: "Ctrl+B", del: "Delete", quantize: "Alt+Q", undo: "Ctrl+Z",
      draw: "P", select: "E", erase: "D", new_track: "Ctrl+T", split: "C",
      mixer: "F9", browser: "F8", render: "Ctrl+R",
      redo: "Ctrl+Shift+Z", zoom_in: "Alt+ArrowRight", zoom_out: "Alt+ArrowLeft",
      vzoom_in: "Alt+ArrowUp", vzoom_out: "Alt+ArrowDown", zoom_fit: "Alt+F",
      loop_sel: "Ctrl+Shift+L",
    },
  },
  numeric: {
    label: "Number tools",                  // 8 draw, 1 select, 5 erase, 3 split
    keys: {
      play_stop: "Space", stop: "Shift+Space", record: "*", loop: "/",
      duplicate: "Ctrl+D", del: "Delete", quantize: "Q", undo: "Ctrl+Z",
      draw: "8", select: "1", erase: "5", new_track: "Ctrl+T", split: "3",
      mixer: "F3", browser: "F5", render: "Ctrl+R",
      redo: "Ctrl+Shift+Z", zoom_in: "Alt+ArrowRight", zoom_out: "Alt+ArrowLeft",
      vzoom_in: "Alt+ArrowUp", vzoom_out: "Alt+ArrowDown", zoom_fit: "Alt+F",
      loop_sel: "Ctrl+Shift+L",
    },
  },
};

/** The canonical name of a keyboard event, matched against the profile. */
function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let k = e.key;
  if (k === " ") k = "Space";
  else if (k === "Escape") k = "Esc";
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join("+");
}
const binding = (act) => KEYMAPS[S.keymap]?.keys[act] || "";

/** Tooltips carry the ACTIVE binding, so switching profiles re-labels the UI. */
const TIP_BINDINGS = [
  ["playBtn", "play_stop", "play / stop"],
  ["stopBtn", "stop", "stop and return to the start"],
  ["recBtn", "record", "record onto the armed track"],
  ["loopBtn", "loop", "loop the project"],
  ["modeDraw", "draw", "draw notes"],
  ["modeSel", "select", "select / drag"],
  ["modeErase", "erase", "erase"],
  ["quantBtn", "quantize", "quantize the selection to the grid"],
  ["mixerBtn", "mixer", "fold the mixer"],
  ["browserBtn", "browser", "fold the browser"],
  ["addTrackBtn", "new_track", "add a track with the browser's selected instrument"],
  ["undoBtn", "undo", "undo the last edit by posting its inverse action"],
  ["redoBtn", "redo", "redo: post the edit again"],
  ["azIn", "zoom_in", "zoom the arrangement in"],
  ["azOut", "zoom_out", "zoom the arrangement out"],
  ["rzIn", "zoom_in", "wider bars in the roll"],
  ["rzOut", "zoom_out", "narrower bars in the roll"],
  ["rvIn", "vzoom_in", "taller rows in the roll"],
  ["rvOut", "vzoom_out", "shorter rows in the roll"],
  ["rFit", "zoom_fit", "fit the notes this track plays to the height of the editor"],
  ["azFit", "zoom_fit", "fit the whole song to the window"],
];
function applyKeymap(name) {
  S.keymap = KEYMAPS[name] ? name : "ctrl";
  try { localStorage.setItem("daw.keymap", S.keymap); } catch { /* private mode */ }
  $("kmSel").value = S.keymap;
  for (const [id, act, base] of TIP_BINDINGS) {
    const el = $("shell").querySelector(`#${id}`);
    if (el) el.title = `${base} — ${binding(act) || "unbound"}`;
  }
  drawKeymapTable();
}
function drawKeymapTable() {
  const t = $("kmBody");
  const names = Object.keys(KEYMAPS);
  t.innerHTML = `<tr><th>Gesture</th>${names
    .map((n) => `<th>${KEYMAPS[n].label}${n === S.keymap ? " ●" : ""}</th>`).join("")}</tr>`
    + Object.entries(KM_ACTIONS).map(([act, def]) =>
      `<tr><td>${def.label}</td>${names
        .map((n) => `<td class="d-k">${KEYMAPS[n].keys[act] || "—"}</td>`).join("")}</tr>`).join("");
}

document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (e.key === "Tab" || t?.isContentEditable || t?.closest('[contenteditable="true"]')) return;
  if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
  if ((e.key === " " || e.key === "Enter") && t?.closest('button, a, summary, [role="button"]')) return;
  if (document.querySelector("dialog[open]") && comboOf(e) !== "Esc") return;
  const combo = comboOf(e);
  const map = KEYMAPS[S.keymap].keys;
  for (const [act, key] of Object.entries(map)) {
    if (key === combo) {
      e.preventDefault();
      try { KM_ACTIONS[act].run(); } catch (err) { status(err.message); }
      return;
    }
  }
});

/* ═══════════════════════════════════════════════════════ LIVE SYNC ══════
 * The studio already runs one websocket (server/index.js, path /live) for
 * job state. server/daw/live.js watches the project documents and pushes a
 * `{type:"daw"}` frame whenever one is written — by THIS page, by an agent
 * over MCP in another process, by anything. We re-read and redraw.
 *
 * Why a document watch and not a callback inside the route: an MCP tool call
 * is a separate PROCESS talking HTTP to this server, and one day it may be a
 * separate server. A watch on the document catches every writer there will
 * ever be, and it cannot go stale when a new action is added. */

function connectLive() {
  const dot = $("liveDot");
  let ws;
  try {
    ws = new WebSocket(`ws://${location.host}/live`);
  } catch { $("liveTxt").textContent = "ws off"; return; }
  S.ws = ws;
  ws.onopen = () => { dot.classList.add("d-up"); $("liveTxt").textContent = "live"; };
  ws.onclose = () => {
    dot.classList.remove("d-up"); $("liveTxt").textContent = "reconnecting…";
    setTimeout(connectLive, 1500);
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== "daw" || m.slug !== S.slug) return;
    onRemoteChange(m);
  };
}

let liveChain = Promise.resolve();
function onRemoteChange(m) {
  const session = captureSession();
  if (m.slug && m.slug !== session.slug) return;
  // Our own writes come back too. `updatedAt` is the document's own revision:
  // if we already hold it, there is nothing to follow.
  if (S.proj && m.updatedAt && m.updatedAt === S.proj.updatedAt) return;
  const dot = $("liveDot");
  dot.classList.add("d-hit");
  setTimeout(() => { if (sessionCurrent(session)) dot.classList.remove("d-hit"); }, 700);
  $("liveTxt").textContent = m.by === "agent" ? `agent: ${m.action}` : "live";
  liveChain = liveChain.catch(() => {}).then(async () => {
    if (!sessionCurrent(session)) return;
    try {
      await refreshDoc(session);
      if (!sessionCurrent(session)) return;
      /* ⚠ A MOVED PANEL IS NOT A RENDER. set_view dirties no region, so this
       * render would be a total cache hit — no wav fetched, no DSP — but it
       * still costs a round trip and still flashes "re-rendering…" in the CPU
       * readout, which is a lie about what the other window just did. The
       * re-read above is the whole of the work: refreshDoc() applies the view.
       * Every other action falls through to the render as before, because any
       * of them CAN have dirtied something. */
      if (m.action !== "set_view") {
        await renderAndSwap(undefined, undefined, undefined, session);
        if (!sessionCurrent(session)) return;
      }
      if (m.by === "agent") {
        status(`agent edit applied live: ${m.action}${m.detail ? ` — ${m.detail}` : ""}`);
      }
    } catch (err) { if (sessionCurrent(session)) status(`live sync: ${err.message}`); }
  });
}

/* ═════════════════════════════════════════════════════ THE ARRANGEMENT ══ */

const arrCv = $("arrCanvas");
const arrG = arrCv.getContext("2d");

/** Row layout: which y each track lane and each of its open lanes occupies. */
function arrLayout() {
  const rows = [];
  let y = RULER_H;
  for (const t of S.proj?.tracks || []) {
    rows.push({ kind: "track", id: t.id, y, h: LANE_H, track: t });
    y += LANE_H;
    /* §4: the per-track waveform lane sits directly under its track, above
     * any automation lanes — it is a second view of the same audio, not a
     * parameter, so it belongs next to the clips it is made of. */
    if (S.wave.open.has(t.id)) {
      rows.push({ kind: "wave", id: t.id, y, h: WAVE_H, track: t });
      y += WAVE_H;
    }
    for (const key of S.lanes) {
      if (!key.startsWith(`trk:${t.id}:`)) continue;
      rows.push({ kind: "lane", id: t.id, key, y, h: AUTO_H });
      y += AUTO_H;
    }
  }
  return { rows, height: Math.max(y + 8, 120) };
}

function drawArr() {
  if (!S.proj || !S.timeline.length) return;
  const lay = arrLayout();
  const W = Math.ceil(totalQ() * S.arrPxq) + 40;
  const H = lay.height;
  fitCanvas(arrCv, W, H);
  const g = arrG;
  g.clearRect(0, 0, W, H);

  let nextBarLabel = -Infinity;
  /* the ruler, drawn FROM the meter map: uneven bars, honestly uneven */
  g.font = "10px var(--mono, monospace)";
  for (const r of S.timeline) {
    const x = r.qStart * S.arrPxq;
    tint(g, C.hair, 1, () => { g.fillRect(x, 0, 1, H); });
    const changed = r.bar === 1 || r.num !== rowOf(r.bar - 1)?.num
      || r.den !== rowOf(r.bar - 1)?.den || r.bpm !== rowOf(r.bar - 1)?.bpm;
    if (changed) {
      tint(g, C.warn, 1, () => {
        g.fillRect(x, 0, 1.6, RULER_H);
        g.fillText(`${r.num}/${r.den} ${r.bpm}`, x + 4, RULER_H - 3);
      });
    }
    if (x >= nextBarLabel) {
      tint(g, C.ghost, 1, () => g.fillText(`${r.bar}`, x + 3, 10));
      nextBarLabel = x + Math.max(28, g.measureText(`${r.bar}`).width + 12);
    }
    // beat ticks inside the bar — 7 of them in a 7/8 bar
    const beatQ = 4 / r.den;
    for (let b = 1; b < r.num; b++) {
      tint(g, C.hair, 0.5, () => g.fillRect(x + b * beatQ * S.arrPxq, RULER_H, 1, H - RULER_H));
    }
  }
  tint(g, C.edge, 1, () => g.fillRect(0, RULER_H - 1, W, 1));

  /* THE LOOP RANGE, drawn where it is dragged. A brace across the ruler and
   * a wash over the bars it covers, so "what will repeat" is a shape rather
   * than two numbers in the transport. */
  drawLoopBand(g, S.arrPxq, 0, 0, H);

  /* the regions being re-rendered right now — the dirty system, visible */
  for (const d of S.pending) {
    const x0 = (rowOf(d.fromBar)?.qStart ?? 0) * S.arrPxq;
    const rr = rowOf(d.toBar);
    const x1 = ((rr?.qStart ?? 0) + (rr?.qLen ?? 0)) * S.arrPxq;
    tint(g, C.warn, 0.13, () => g.fillRect(x0, RULER_H, x1 - x0, H - RULER_H));
  }

  for (const row of lay.rows) {
    if (row.kind !== "track") { drawArrRow(g, row, W); continue; }
    const t = row.track;
    const col = colourOf(t.id);
    tint(g, C.hair, 0.6, () => g.fillRect(0, row.y + row.h - 1, W, 1));
    if (t.id === S.trackId) tint(g, col, 0.07, () => g.fillRect(0, row.y, W, row.h));

    // MIDI clips: the clip's declared bounds, with its notes blocked inside
    for (const c of t.clips) {
      const q0 = rowOf(c.fromBar)?.qStart ?? 0;
      const rr = rowOf(c.toBar);
      const q1 = (rr?.qStart ?? 0) + (rr?.qLen ?? 0);
      const x = q0 * S.arrPxq, w = Math.max(6, (q1 - q0) * S.arrPxq);
      const on = t.id === S.trackId;
      tint(g, col, on ? 0.18 : 0.09, () => g.fillRect(x, row.y + 2, w, row.h - 5));
      tint(g, col, on ? 0.7 : 0.3, () => {
        g.strokeRect(x + 0.5, row.y + 2.5, w - 1, row.h - 6);
      });
      // the clip's own title bar, so a clip is a named object, not a smear
      tint(g, col, on ? 0.3 : 0.14, () => g.fillRect(x, row.y + 2, w, 10));
      /* THE EDGE GRIPS. A clip you can drag needs to look draggable, and
       * the two edges do different things (move vs trim). */
      if (on && w > 18) {
        tint(g, C.ink, 0.35, () => {
          g.fillRect(x + 1.5, row.y + 4, 2, row.h - 9);
          g.fillRect(x + w - 3.5, row.y + 4, 2, row.h - 9);
        });
      }
      /* Shrinking a clip SILENCES the notes outside it instead of deleting
       * them (set_clip's container rule). Silent-but-present is exactly the
       * kind of state a window must say out loud. */
      const outside = c.notes.filter((n) => n.bar < c.fromBar || n.bar > c.toBar).length;
      const title = `${c.name || t.name}`;
      tint(g, on ? C.ink : C.faint, on ? 0.95 : 0.5,
        () => g.fillText(title.slice(0, Math.max(1, Math.floor(w / 6))), x + 3, row.y + 10));
      if (outside) {
        tint(g, C.warn, 0.9, () => {
          g.fillRect(x + w - 3, row.y + 2, 3, row.h - 5);
          g.fillText(`${outside} silent`, x + Math.max(4, w - 58), row.y + row.h - 4);
        });
      }
      if (!c.notes.length) continue;
      let lo = 127, hi = 0;
      for (const n of c.notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
      const span = Math.max(6, hi - lo);
      for (const n of c.notes) {
        const nx = posToQ(n.bar, n.beat, n.tick) * S.arrPxq;
        const nw = Math.max(1.5, durTicksToQ(n.bar, n.beat, n.tick, n.durTicks) * S.arrPxq);
        const ny = row.y + row.h - 6 - ((n.pitch - lo) / span) * (row.h - 20);
        tint(g, n.by === "agent" ? C.secondary : (on ? C.ink : col), on ? 0.95 : 0.5,
          () => g.fillRect(nx, ny, nw, 2.4));
      }
    }

    // audio clips: real waveform density from the file we can already fetch
    for (const c of t.audioClips || []) {
      const t0 = posSecs(c.bar, c.beat, c.tick) + c.shiftSamples / (S.proj.sr || 48000);
      const t1 = t0 + c.durSamples / (S.proj.sr || 48000);
      const x = secondsToQ(Math.max(0, t0)) * S.arrPxq;
      const w = Math.max(4, secondsToQ(Math.max(0, t1)) * S.arrPxq - x);
      const on = t.id === S.trackId;
      tint(g, C.ok, on ? 0.16 : 0.07, () => g.fillRect(x, row.y + 2, w, row.h - 5));
      tint(g, C.ok, on ? 0.6 : 0.25, () => g.strokeRect(x + 0.5, row.y + 2.5, w - 1, row.h - 6));
      drawWave(g, c.file, x, row.y + 3, w, row.h - 7, on ? 0.85 : 0.35);
      tint(g, C.ok, on ? 1 : 0.4, () => g.fillText(c.name.slice(0, 26), x + 3, row.y + 12));
    }
    // takes: dashed, because a take auditions but never renders into the mix
    for (const k of t.takes || []) {
      const t0 = posSecs(k.bar, k.beat, k.tick) + k.shiftSamples / (k.sr || 48000);
      const t1 = t0 + k.samples / (k.sr || 48000);
      const x = secondsToQ(Math.max(0, t0)) * S.arrPxq;
      const w = Math.max(4, secondsToQ(Math.max(0, t1)) * S.arrPxq - x);
      tint(g, C.warn, t.id === S.trackId ? 0.8 : 0.3, () => {
        g.setLineDash([3, 2]);
        g.strokeRect(x + 0.5, row.y + row.h - 12.5, w - 1, 9);
        g.setLineDash([]);
      });
    }
  }

  // the playhead, with a grabbable head in the ruler
  const x = secondsToQ(projTime()) * S.arrPxq;
  tint(g, C.warn, 1, () => {
    g.fillRect(x, 0, 1.5, H);
    g.beginPath();
    g.moveTo(x - 5, 0); g.lineTo(x + 6.5, 0); g.lineTo(x + 0.75, 8);
    g.closePath(); g.fill();
  });
}

/** THE LOOP RANGE, in whichever timeline asks for it. `pxq` is that
 *  timeline's pixels-per-quarter and `x0` its left pad (the roll has a
 *  key gutter; the arrangement does not). */
function drawLoopBand(g, pxq, x0, yTop, yBot) {
  if (S.loopA == null || S.loopB == null) return;
  const xa = x0 + qOfBarFloat(S.loopA) * pxq;
  const xb = x0 + qOfBarFloat(S.loopB) * pxq;
  tint(g, C.warn, 0.07, () => g.fillRect(xa, yTop, xb - xa, yBot - yTop));
  tint(g, C.warn, 0.85, () => {
    g.fillRect(xa, yTop, 2, yBot - yTop);
    g.fillRect(xb - 2, yTop, 2, yBot - yTop);
    g.fillRect(xa, yTop, xb - xa, 3);              // the brace across the ruler
  });
}

/** The loop range as seconds — the transport's actual play window.
 *  With no range set this is the whole song, which is what it always was. */
function loopSecs() {
  const total = S.totalSeconds || 0;
  if (S.loopA == null || S.loopB == null) return { a: 0, b: total };
  const a = Math.max(0, Math.min(total, secAtQ(qOfBarFloat(S.loopA))));
  const b = Math.max(0, Math.min(total, secAtQ(qOfBarFloat(S.loopB))));
  return b - a > 0.05 ? { a, b } : { a: 0, b: total };
}

/** Set (or clear) the loop range, in float bars, and tell everything. */
function setLoop(a, b) {
  if (a == null || b == null || Math.abs(b - a) < 0.02) { S.loopA = S.loopB = null; }
  else { S.loopA = Math.max(1, Math.min(a, b)); S.loopB = Math.max(a, b); }
  paintLoopLabel();
  if (S.playing) { const at = S.at; stop(); S.at = at; play(); }
  /* The loop IS the readiness window (see aheadWindow), so dragging one over
   * bars 81-84 must turn the badge red without waiting for the transport. */
  paintAhead();
  drawArr(); draw(); drawRollRuler();
}
function paintLoopLabel() {
  const el = $("loopLbl");
  el.classList.toggle("d-set", S.loopA != null);
  if (S.loopA == null) { el.textContent = "loop: whole song"; return; }
  el.innerHTML = `loop ${S.loopA.toFixed(2)} → ${S.loopB.toFixed(2)}`;
  const x = document.createElement("button");
  x.textContent = "✕"; x.title = "clear the loop range";
  x.addEventListener("click", () => setLoop(null, null));
  el.appendChild(x);
}

/** Loop around whatever is selected — the gesture you actually want when
 *  you are working a phrase. Falls back to the selected clip's bounds. */
function loopAroundSelection() {
  const rows = targetNotes();
  if (!rows.length) { status("nothing selected to loop"); return; }
  let q0 = Infinity, q1 = -Infinity;
  for (const { n } of rows) {
    const a = posToQ(n.bar, n.beat, n.tick);
    q0 = Math.min(q0, a);
    q1 = Math.max(q1, a + durTicksToQ(n.bar, n.beat, n.tick, n.durTicks));
  }
  setLoop(barFloatOfQ(q0), barFloatOfQ(q1));
  status(`loop: bars ${S.loopA.toFixed(2)} → ${S.loopB.toFixed(2)} (${rows.length} note(s))`);
}

/** One automation lane, drawn inside the arrangement under its track. */
function drawArrRow(g, row, W) {
  if (row.kind === "wave") return drawWaveLane(g, row, W);
  return drawArrLane(g, row, W);
}

function drawArrLane(g, row, W) {
  const ref = laneRef(row.key);
  tint(g, C.hair, 0.5, () => g.fillRect(0, row.y + row.h - 1, W, 1));
  if (!ref) return;
  tint(g, C.secondary, 0.05, () => g.fillRect(0, row.y, W, row.h));
  tint(g, C.ghost, 1, () => {
    g.font = "9px monospace";
    g.fillText(ref.label, 4, row.y + 10);
  });
  const keys = ref.keys();
  const yOf = (v) => row.y + row.h - 4 - ((v - ref.min) / (ref.max - ref.min)) * (row.h - 12);
  g.beginPath();
  if (!keys.length) {
    const y = yOf(ref.plain());
    g.moveTo(0, y); g.lineTo(W, y);
  } else {
    keys.forEach((k, i) => {
      const x = qOfBarFloat(k.t) * S.arrPxq;
      if (i === 0) { g.moveTo(0, yOf(k.v)); }
      g.lineTo(x, yOf(k.v));
      if (i === keys.length - 1) g.lineTo(W, yOf(k.v));
    });
  }
  tint(g, C.secondary, 0.9, () => g.stroke());
  for (const k of keys) {
    const x = qOfBarFloat(k.t) * S.arrPxq;
    tint(g, C.secondary, 1, () => g.fillRect(x - 2, yOf(k.v) - 2, 4, 4));
  }
}

/** Waveform peaks, computed once per file in the browser (Chrome decodes
 *  FLAC), then cached. No new server endpoint for a picture. */
const WAVE_BUCKETS = 900;
function drawWave(g, file, x, y, w, h, alpha) {
  const pk = S.peaks.get(file);
  if (!pk) { loadPeaks(file); return; }
  const mid = y + h / 2;
  tint(g, C.ok, alpha, () => {
    for (let i = 0; i < w; i++) {
      const v = pk[Math.min(pk.length - 1, Math.floor(i / w * pk.length))];
      g.fillRect(x + i, mid - v * h / 2, 1, Math.max(1, v * h));
    }
  });
}
const peakJobs = new Set();
async function loadPeaks(file) {
  const session = captureSession();
  const jobKey = `${session.epoch}:${session.slug}:${file}`;
  if (peakJobs.has(jobKey) || S.peaks.has(file)) return;
  peakJobs.add(jobKey);
  try {
    const response = await fetch(`/api/daw/take/${encodeURIComponent(session.slug)}/${encodeURIComponent(file)}`);
    if (!sessionCurrent(session)) return;
    const bytes = await response.arrayBuffer();
    if (!sessionCurrent(session)) return;
    const buf = await audioCtx().decodeAudioData(bytes);
    if (!sessionCurrent(session)) return;
    const ch = buf.getChannelData(0);
    const n = Math.min(WAVE_BUCKETS, Math.max(1, Math.floor(ch.length / 32)));
    const out = new Float32Array(n);
    const per = ch.length / n;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) m = Math.max(m, Math.abs(ch[j]));
      out[i] = m;
    }
    S.peaks.set(file, out);
    drawArr();
  } catch { if (sessionCurrent(session)) S.peaks.set(file, new Float32Array([0.02])); }
  finally { peakJobs.delete(jobKey); }
}


/* ══════════════════════════════════════════════════════════════════════════
 * §4 PER-TRACK WAVEFORM LANES — from the stems the mix already computes
 *
 * THE HONEST CONSTRAINT FIRST. The buffers this page holds are the MIXDOWN:
 * regionsOf returns {idx, fromBar, toBar, t0, t1, startSample, nSamples} with
 * no track dimension at all, and renderAndSwap decodes one buffer per region.
 * A per-track lane cannot be derived from anything in memory here. It has to
 * be asked for.
 *
 * WHERE THE AUDIO COMES FROM, AND WHAT IT IS NOT. `render_stems` returns the
 * post-fader per-track buses out of the SAME graph pass the mix comes from
 * (rack.chain_graph(capture=True)) — nothing is re-synthesised and nothing is
 * modelled. Two things about that are true and are said in the lane's own
 * head rather than left for someone to discover:
 *
 *   1. ALL TRACK LANES PLUS THE SEPARATE EFFECT RETURNS sum to the pre-master
 *      mix. Master processing and the master fader are excluded. Return files
 *      appear in the Audio browser, including when only a subset of tracks
 *      was requested. A subset cannot reconstruct the complete mix.
 *   2. A STEM RENDER IS A SECOND FULL GRAPH PASS. §0.1 applies to it exactly
 *      as it applies to a region — about 11 s at bar 125 of a chained
 *      128-bar project. Which is why lanes are LAZY: off by default, one
 *      track at a time, and the cost is shown when it is paid. (The owner
 *      chose lazy over eager for this reason: eager would roughly double
 *      every cold render for a view that is usually closed.)
 *
 * THE PICTURE comes from the mip-map, not from decoding a wav in the browser:
 * min AND max per peak (a rectified envelope hides asymmetry and DC), both
 * channels, four stages, built once per file and served by sample range. The
 * old 900-bucket cache gave TEN buckets for one bar of a three-minute take;
 * the finest stage gives 11 250.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The route refuses more than 16 regions of stems in one ask, and says why.
 *  The page asks for no more than that and says the same thing first. */
const WAVE_REGION_CAP = 16;

/** The regions a lane would draw: the play window, in render-manifest rows. */
function waveRegions() {
  const { a, b } = loopSecs();
  const rows = (S.regions || []).filter((r) => r.t1 > a + 1e-6 && r.t0 < b - 1e-6);
  return rows.slice(0, WAVE_REGION_CAP);
}

/** Open or close one track's waveform lane. Opening pays for it. */
function toggleWaveLane(trackId) {
  if (S.wave.open.has(trackId)) {
    S.wave.open.delete(trackId);
    S.wave.stems.delete(trackId);
    S.wave.result = null;
    S.wave.error = "";
    if (S.wave.open.size) refreshWaveLanes();
    status(`waveform lane closed for ${S.proj?.tracks.find((t) => t.id === trackId)?.name || trackId}`);
  } else {
    S.wave.open.add(trackId);
    refreshWaveLanes(true);
  }
  drawSide(); drawArr();
}

/**
 * Ask for the stems the open lanes need, then for their mip-map slices.
 * Called when a lane opens and after every render — a region that was
 * re-rendered has a new hash, so its stems have new names and the old ones
 * are simply not asked for again.
 */
async function refreshWaveLanes(announce = false) {
  const session = captureSession();
  const renderRequest = S.renderRequest;
  const key = [...S.wave.open].sort().join(",");
  const current = () => sessionCurrent(session) && renderRequest === S.renderRequest
    && key === [...S.wave.open].sort().join(",");
  if (!S.slug || !S.wave.open.size) return;
  const want = waveRegions();
  if (!want.length) {
    /* Nothing has been rendered yet, so there are no regions to take stems
     * from. Said out loud: a lane that opens and stays blank with no message
     * is the exact failure this whole panel is supposed to be the opposite of. */
    status("waveform lane: nothing is rendered yet — press play, or edit a note, "
      + "and the lane fills as the regions land");
    return;
  }
  if (S.wave.busy.has(key)) return;
  S.wave.busy.add(key);
  S.wave.result = null;
  S.wave.error = "";
  drawReturnStems();
  const t0 = performance.now();
  try {
    if (announce) status(`Rendering ${S.wave.open.size} track lane(s) and shared effect returns… This needs a second audio pass.`);
    const r = await api({
      action: "render_stems", slug: session.slug,
      from_bar: want[0].fromBar, to_bar: want[want.length - 1].toBar,
      tracks: [...S.wave.open],
    });
    if (!current()) return;
    for (const tid of S.wave.open) S.wave.stems.set(tid, new Map());
    for (const reg of r.regions || []) {
      for (const st of reg.stems || []) {
        const m = S.wave.stems.get(st.track_id);
        if (m) m.set(reg.idx, { ...st, hash: reg.hash, t0: rowSecs(reg.fromBar), idx: reg.idx });
      }
    }
    const rows = r.regions || [];
    S.wave.result = r;
    const details = stemResultDetails(r, S.proj);
    S.wave.note = details.note;
    /* Truncated means the CAP clipped the ask, not that the play window is
     * short — a four-region project inside a two-bar loop is not "the first 16
     * of many", and saying so would be a warning about nothing. */
    const win = loopSecs();
    const inWindow = (S.regions || []).filter((x) => x.t1 > win.a + 1e-6 && x.t0 < win.b - 1e-6).length;
    const truncated = inWindow > WAVE_REGION_CAP;
    /* A track that is silent in this window is NAMED, not dropped: an empty
     * lane and a lane that failed look the same, and only one of them is fine.
     * Counted per region, and only for lanes that are actually open — a closed
     * track's silence is not this view's business. */
    const silentIn = new Map();
    for (const x of rows) for (const tid of x.silent_tracks || []) silentIn.set(tid, (silentIn.get(tid) || 0) + 1);
    const nameOf = (tid) => (S.proj?.tracks || []).find((t) => t.id === tid)?.name || tid;
    const silent = [...silentIn].filter(([tid]) => S.wave.open.has(tid))
      .map(([tid, n]) => `${nameOf(tid)} in ${n} of ${rows.length} region(s)`);
    status(`Stems: ${r.rendered} rendered, ${r.cached} cached · ${details.note}. `
      + (details.complete ? "Complete track and return set." : "Partial track set; see Audio for return files and scope.")
      + (truncated ? ` · showing the first ${WAVE_REGION_CAP} regions — set a shorter loop range for the rest` : "")
      + (silent.length ? ` · silent here: ${silent.join(", ")}` : ""));
    S.sw.push({ ahead: true, regionIdx: null, estMs: null, actualMs: r.ms,
                audible: performance.now() - t0 });
    updateHud();
    /* the heads carry the measured note, so they are redrawn with it */
    drawSide(); drawArr();
    fetchWavePeaks(session);
  } catch (err) {
    if (!current()) return;
    S.wave.note = "";
    S.wave.result = null;
    S.wave.error = `Stem preview failed: ${err.message}`;
    status(S.wave.error);
  } finally {
    if (sessionCurrent(session)) { S.wave.busy.delete(key); drawReturnStems(); }
  }
}

/** Return previews are the actual post-fader files from render_stems. */
function drawReturnStems() {
  const panel = $("dawReturnStems");
  if (!panel) return;
  const regions = S.wave.result?.regions || [];
  const signature = JSON.stringify([S.slug, S.wave.open.size, S.wave.error,
    S.wave.busy.has([...S.wave.open].sort().join(",")),
    regions.map((region) => [region.idx, region.hash, region.returns]), S.proj?.returns]);
  if (signature === S.wave.previewKey) return;
  S.wave.previewKey = signature;
  panel.querySelectorAll("audio").forEach((audio) => audio.pause());
  panel.hidden = !S.slug || !S.wave.open.size;
  const select = $("dawReturnRegion"), files = $("dawReturnFiles");
  const previous = select.value;
  select.replaceChildren(); files.replaceChildren();
  $("dawStemRetry").hidden = !S.wave.error;
  $("dawStemMessage").textContent = S.wave.error || (regions.length
    ? stemResultDetails(S.wave.result, S.proj).summary
    : S.wave.busy.has([...S.wave.open].sort().join(","))
      ? "Rendering track stems and effect returns…"
      : "Press play or edit a note to render this range, then open a waveform lane.");
  select.hidden = !regions.length;
  for (const region of regions) {
    const option = document.createElement("option");
    option.value = String(region.idx);
    option.textContent = `Bars ${region.fromBar}–${region.toBar}`;
    select.appendChild(option);
  }
  if (regions.some((region) => String(region.idx) === previous)) select.value = previous;
  const renderFiles = () => {
    files.querySelectorAll("audio").forEach((audio) => audio.pause());
    files.replaceChildren();
    const region = regions.find((row) => String(row.idx) === select.value);
    if (!region) return;
    const returns = region.returns || [];
    if (!returns.length) {
      const note = document.createElement("p"); note.className = "d-note";
      note.textContent = S.proj?.returns?.length ? "No effect return files were supplied. Retry the stem render." : "This project has no effect returns.";
      files.appendChild(note);
    }
    for (const stem of returns) {
      const row = document.createElement("div"); row.className = "d-return-stem";
      const label = document.createElement("div"); label.className = "d-return-stem-name";
      const name = (S.proj?.returns || []).find((ret) => ret.id === stem.return_id)?.name || stem.return_id;
      label.textContent = `${name} · stereo`;
      row.appendChild(label);
      if (typeof stem.url !== "string" || !stem.url.startsWith("/api/daw/audio/")) {
        const error = document.createElement("span"); error.textContent = "No playable return file URL.";
        row.appendChild(error); files.appendChild(row); continue;
      }
      const audio = document.createElement("audio");
      audio.controls = true; audio.preload = "none"; audio.src = stem.url;
      audio.setAttribute("aria-label", `${name}, bars ${region.fromBar}–${region.toBar}, pre-master return preview`);
      audio.addEventListener("play", () => {
        if (S.playing) stop();
        try { auditionNode?.stop(); } catch { /* already stopped */ }
        panel.querySelectorAll("audio").forEach((other) => { if (other !== audio) other.pause(); });
        status(`Previewing ${name} alone · post-fader, pre-master · bars ${region.fromBar}–${region.toBar}`);
      });
      const note = document.createElement("span"); note.className = "d-return-stem-error"; note.setAttribute("role", "status");
      audio.addEventListener("error", () => { note.textContent = "Preview unavailable. Download the WAV or retry rendering stems."; $("dawStemRetry").hidden = false; });
      const link = document.createElement("a"); link.href = stem.url; link.download = stem.file || "";
      link.textContent = "Download return WAV";
      row.append(audio, link, note); files.appendChild(row);
    }
  };
  select.onchange = renderFiles;
  renderFiles();
}

$("dawStemRetry").addEventListener("click", () => refreshWaveLanes(true));

/** The seconds a bar starts at — the lane's x is the arrangement's x. */
const rowSecs = (bar) => rowOf(bar)?.sec ?? 0;

/** How wide, in device-independent pixels, one region's lane is right now. */
function regionPixels(reg) {
  const x0 = secondsToQ(reg.t0) * S.arrPxq;
  const x1 = secondsToQ(reg.t1) * S.arrPxq;
  return Math.max(1, x1 - x0);
}

/**
 * The mip-map slices, one per (stem file, zoom). Re-asked only when the
 * drawing is finer than the stage we hold — coarsening is free (a fine stage
 * strides down perfectly well) and re-asking on every scroll would make a
 * zoom gesture chatty for no picture at all.
 */
async function fetchWavePeaks(session = captureSession()) {
  if (!sessionCurrent(session)) return;
  const jobs = [];
  for (const tid of S.wave.open) {
    for (const [idx, st] of S.wave.stems.get(tid) || []) {
      const reg = (S.regions || []).find((x) => x.idx === idx);
      if (!reg) continue;
      const spp = Math.max(1, (reg.nSamples || 0) / regionPixels(reg));
      const held = S.wave.peaks.get(st.file);
      if (held && !(spp < held.stage.spp / 2)) continue;
      if (S.wave.busy.has(st.file)) continue;
      S.wave.busy.add(st.file);
      jobs.push((async () => {
        try {
          const r = await api({ action: "peaks", slug: session.slug, name: st.file, samples_per_pixel: spp });
          if (!sessionCurrent(session)) return;
          S.wave.peaks.set(st.file, r);
        } catch (err) {
          if (!sessionCurrent(session)) return;
          S.wave.peaks.set(st.file, null);
          status(`peaks: ${err.message}`);
        } finally { if (sessionCurrent(session)) S.wave.busy.delete(st.file); }
      })());
    }
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (sessionCurrent(session)) drawArr();
}

/**
 * Draw one track's stems across the arrangement. Two sub-lanes, left above
 * right, because the mip-map carries both channels and a fold to one would
 * hide exactly what the width knobs do — the same reading error the sound
 * pass found in the Ear's own spectral balance.
 */
function drawWaveLane(g, row, W) {
  const tid = row.id;
  const stems = S.wave.stems.get(tid);
  const col = colourOf(tid);
  tint(g, C.hair, 0.5, () => g.fillRect(0, row.y + row.h - 1, W, 1));
  if (!stems?.size) {
    tint(g, C.ghost, 1, () => {
      g.font = "9px monospace";
      g.fillText("〜 rendering the stem for this track…", 4, row.y + 12);
    });
    return;
  }
  const half = (row.h - 4) / 2;
  for (const [idx, st] of stems) {
    const reg = (S.regions || []).find((x) => x.idx === idx);
    const pk = S.wave.peaks.get(st.file);
    if (!reg) continue;
    const x0 = secondsToQ(reg.t0) * S.arrPxq;
    const wpx = regionPixels(reg);
    tint(g, C.primary, 0.1, () => g.fillRect(x0, row.y + 1, 1, row.h - 3));
    if (!pk?.data?.length) continue;
    for (const ch of pk.data) {
      const mid = row.y + 2 + half * (ch.channel === 0 ? 0.5 : 1.5);
      const n = ch.min.length;
      if (!n) continue;
      const per = n / wpx;
      tint(g, col, 0.85, () => {
        for (let i = 0; i < wpx; i++) {
          const j0 = Math.floor(i * per);
          const j1 = Math.max(j0 + 1, Math.floor((i + 1) * per));
          let lo = 0, hi = 0;
          for (let j = j0; j < j1 && j < n; j++) { lo = Math.min(lo, ch.min[j]); hi = Math.max(hi, ch.max[j]); }
          const yTop = mid - hi * (half / 2 - 1);
          const yBot = mid - lo * (half / 2 - 1);
          g.fillRect(x0 + i, yTop, 1, Math.max(1, yBot - yTop));
        }
      });
      tint(g, C.hair, 0.6, () => g.fillRect(x0, mid, wpx, 1));
    }
  }
}

/* ── arrangement pointer: playhead, clip select, audio-clip move/resize ── */

let arrDrag = null;
arrCv.addEventListener("contextmenu", (e) => e.preventDefault());
arrCv.addEventListener("pointerdown", (e) => {
  if (!S.proj) return;
  const box = arrCv.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  /* THE RULER: click to place the playhead, DRAG to set the loop range.
   * The one gesture the window did not have and every DAW does. */
  if (py < RULER_H) {
    arrDrag = { mode: "ruler", px0: px, moved: false, q0: px / S.arrPxq };
    capturePointer(arrCv, e.pointerId);
    return;
  }
  const lay = arrLayout();
  const row = lay.rows.find((r) => py >= r.y && py < r.y + r.h);
  if (!row) return;
  if (row.kind === "lane") { laneClick(row, px / S.arrPxq, py - row.y, row.h, e); return; }
  /* A waveform lane is a picture, not a control: clicking it selects the
   * track it belongs to and places the playhead, which is the one thing a
   * hand reaches for in a stem view. */
  if (row.kind === "wave") { selectTrack(row.id); setPlayhead(secAtQ(Math.max(0, px / S.arrPxq))); return; }
  selectTrack(row.id);
  // an audio clip under the pointer: drag to move, drag its right edge to trim
  const t = row.track;
  for (const c of [...(t.audioClips || [])].reverse()) {
    const sr = S.proj.sr || 48000;
    const t0 = posSecs(c.bar, c.beat, c.tick) + c.shiftSamples / sr;
    const x0 = secondsToQ(Math.max(0, t0)) * S.arrPxq;
    const x1 = secondsToQ(Math.max(0, t0 + c.durSamples / sr)) * S.arrPxq;
    if (px < x0 - 2 || px > x1 + 2) continue;
    arrDrag = { clip: c, track: t.id, mode: px > x1 - 6 ? "trim" : "move",
                px0: px, orig: { ...c } };
    capturePointer(arrCv, e.pointerId);
    return;
  }

  /* A MIDI CLIP under the pointer: drag the body to move it (its notes ride
   * along), drag an EDGE to trim it. Until `set_clip` existed a clip's
   * fromBar/toBar were write-once, so moving a four-bar section meant
   * dragging every note in it; these three gestures are that action's three
   * documented shapes and nothing else. */
  for (const c of [...t.clips].reverse()) {
    const x0 = (rowOf(c.fromBar)?.qStart ?? 0) * S.arrPxq;
    const rr = rowOf(c.toBar);
    const x1 = ((rr?.qStart ?? 0) + (rr?.qLen ?? 0)) * S.arrPxq;
    if (px < x0 - 3 || px > x1 + 3) continue;
    const edge = px > x1 - 7 ? "right" : px < x0 + 7 ? "left" : null;
    arrDrag = { midiClip: c, track: t.id, mode: edge ? `clip-${edge}` : "clip-move",
                px0: px, orig: { fromBar: c.fromBar, toBar: c.toBar } };
    capturePointer(arrCv, e.pointerId);
    return;
  }
});
arrCv.addEventListener("pointermove", (e) => {
  if (!arrDrag) return;
  const box = arrCv.getBoundingClientRect();
  const px = e.clientX - box.left;
  if (arrDrag.mode === "ruler") {
    if (Math.abs(px - arrDrag.px0) < 4 && !arrDrag.moved) return;
    arrDrag.moved = true;
    const a = barFloatOfQ(Math.max(0, arrDrag.q0));
    const b = barFloatOfQ(Math.max(0, px / S.arrPxq));
    S.loopA = Math.min(a, b); S.loopB = Math.max(a, b);
    paintLoopLabel(); drawArr(); drawRollRuler();
    return;
  }
  if (arrDrag.mode?.startsWith("clip-")) {
    /* Snapped to BARS, because that is the unit set_clip speaks. */
    const c = arrDrag.midiClip;
    const o = arrDrag.orig;
    const dBars = qToPosFine(Math.max(0, px / S.arrPxq)).bar
      - qToPosFine(Math.max(0, arrDrag.px0 / S.arrPxq)).bar;
    const last = S.proj.lengthBars;
    if (arrDrag.mode === "clip-move") {
      const from = Math.max(1, Math.min(last, o.fromBar + dBars));
      c.fromBar = from;
      c.toBar = Math.min(last, from + (o.toBar - o.fromBar));
    } else if (arrDrag.mode === "clip-right") {
      c.toBar = Math.max(c.fromBar, Math.min(last, o.toBar + dBars));
    } else {
      c.fromBar = Math.max(1, Math.min(o.toBar, o.fromBar + dBars));
      c.toBar = o.toBar;
    }
    arrDrag.moved = arrDrag.moved || c.fromBar !== o.fromBar || c.toBar !== o.toBar;
    drawArr();
    return;
  }
  const c = arrDrag.clip;
  const sr = S.proj.sr || 48000;
  if (arrDrag.mode === "move") {
    const q = Math.max(0, posToQ(arrDrag.orig.bar, arrDrag.orig.beat, arrDrag.orig.tick)
      + (px - arrDrag.px0) / S.arrPxq);
    Object.assign(c, qToPos(q));
  } else {
    const dq = (px - arrDrag.px0) / S.arrPxq;
    const secPerQ = 60 / (rowOf(c.bar)?.bpm || 120);
    c.durSamples = Math.max(1, Math.round(arrDrag.orig.durSamples + dq * secPerQ * sr));
  }
  drawArr();
});
arrCv.addEventListener("pointerup", async (e) => {
  const d = arrDrag; arrDrag = null;
  if (!d) return;
  releasePointer(arrCv, e.pointerId);
  if (d.mode === "ruler") {
    if (d.moved) {
      setLoop(S.loopA, S.loopB);
      status(`loop range: bars ${S.loopA.toFixed(2)} → ${S.loopB.toFixed(2)}`);
    } else {
      setPlayhead(secAtQ(d.q0));
    }
    return;
  }
  if (d.mode?.startsWith("clip-")) {
    const c = d.midiClip;
    const o = d.orig;
    if (!d.moved || (c.fromBar === o.fromBar && c.toBar === o.toBar)) { drawArr(); return; }
    /* The three shapes, exactly as set_clip documents them:
     *   body   → from_bar only (length kept, notes ride along)
     *   right  → to_bar only   (never moves notes)
     *   left   → from_bar + move_notes:false (right edge untouched) */
    const body = d.mode === "clip-move" ? { from_bar: c.fromBar }
      : d.mode === "clip-right" ? { to_bar: c.toBar }
      : { from_bar: c.fromBar, move_notes: false };
    const back = d.mode === "clip-move" ? { from_bar: o.fromBar }
      : d.mode === "clip-right" ? { to_bar: o.toBar }
      : { from_bar: o.fromBar, move_notes: false };
    const label = d.mode === "clip-move"
      ? `clip → bars ${c.fromBar}-${c.toBar}`
      : `clip ${d.mode === "clip-right" ? "right" : "left"} edge → bars ${c.fromBar}-${c.toBar}`;
    const r = await act(
      { action: "set_clip", slug: S.slug, track: d.track, clip: c.id, ...body },
      { action: "set_clip", slug: S.slug, track: d.track, clip: c.id, ...back }, label);
    /* Shrinking SILENCES notes rather than deleting them, and the reply
     * counts them — a number the window would be dishonest to swallow. */
    if (r) {
      const bits = [];
      if (r.notesMoved) bits.push(`${r.notesMoved} note(s) rode along`);
      if (r.notesClamped) bits.push(`${r.notesClamped} beat-clamped by a meter change`);
      if (r.notesOutside) bits.push(`${r.notesOutside} note(s) now SILENT outside the clip — widen it to bring them back`);
      if (bits.length) status(`${label} · ${bits.join(" · ")}`);
    }
    return;
  }
  const c = d.clip;
  const body = d.mode === "move"
    ? { bar: c.bar, beat: c.beat, tick: c.tick }
    : { dur_samples: c.durSamples };
  const back = d.mode === "move"
    ? { bar: d.orig.bar, beat: d.orig.beat, tick: d.orig.tick }
    : { dur_samples: d.orig.durSamples };
  await act({ action: "set_audio_clip", slug: S.slug, track: d.track, clip: c.id, ...body },
    { action: "set_audio_clip", slug: S.slug, track: d.track, clip: c.id, ...back },
    `audio clip ${d.mode}`);
});

const secAtQ = (q) => {
  let row = S.timeline[0];
  for (const r of S.timeline) { if (q >= r.qStart) row = r; else break; }
  if (!row) return 0;
  return row.sec + Math.min(1, Math.max(0, (q - row.qStart) / row.qLen)) * row.secLen;
};

/* ═══════════════════════════════════════════════════ THE PIANO ROLL ═════ */

const canvas = $("roll");
const ctx2d = canvas.getContext("2d");

const SCALES = {
  off: null,
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  penta: [0, 2, 4, 7, 9],
};
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function selTrack() { return S.proj?.tracks.find((t) => t.id === S.trackId) || null; }
function selNotes() {
  const t = selTrack();
  if (!t) return [];
  return t.clips.flatMap((c) => c.notes.map((n) => ({ n, c })));
}

/** The pitch rows on screen: the fitted window, all of them, or — folded —
 *  only the used ones. The WINDOW is the fix for the single most visible
 *  flaw the owner named: the roll used to span all 73 semitones whatever
 *  the music did, so a bass line lived in a thin band with two thirds of
 *  the editor empty above it. */
function rollRows() {
  if ($("foldChk").checked) {
    const used = new Set(selNotes().map(({ n }) => n.pitch));
    if (!used.size) { const o = []; for (let p = 72; p >= 48; p--) o.push(p); return o; }
    return [...used].sort((a, b) => b - a);
  }
  const out = [];
  for (let p = S.rollHi; p >= S.rollLo; p--) out.push(p);
  return out;
}

/** The pitch span the selected track actually plays, padded, clamped. */
function usedPitchSpan() {
  const ns = selNotes();
  if (!ns.length) return null;
  let lo = 127, hi = 0;
  for (const { n } of ns) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  return { lo, hi };
}

/**
 * FIT THE ROLL TO ITS CONTENT — the pitch window AND the row height — and
 * scroll to where the notes are. Called on load, on track change, and by
 * the ✓fit button; any manual zoom disarms it (S.rollFit) so the editor
 * never fights the hand.
 */
function fitRoll(force) {
  if (!force && !S.rollFit) return;
  const wrap = $("rollWrap");
  const spanUsed = usedPitchSpan();
  const pad = 3;
  let lo = spanUsed ? spanUsed.lo - pad : 48;
  let hi = spanUsed ? spanUsed.hi + pad : 72;
  if (hi - lo < 11) {                       // never fit into a slit
    const mid = Math.round((hi + lo) / 2);
    lo = mid - 6; hi = mid + 6;
  }
  S.rollLo = Math.max(PITCH_LO, Math.min(lo, PITCH_HI - 11));
  S.rollHi = Math.min(PITCH_HI, Math.max(hi, S.rollLo + 11));
  const rows = S.rollHi - S.rollLo + 1;
  const room = Math.max(80, wrap.clientHeight - ROLL_RULER_H - VEL_H - VEL_GAP - 4);
  S.rowH = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor(room / rows) || ROW_H));
  S.rollFit = true;
  $("rFit").classList.add("d-on");
  draw();
  scrollRollToNotes();
  paintSelInfo();
}

/** Put the notes in the middle of the editor when they do not already fit.
 *  Deliberately a NO-OP when everything is on screen: an editor that
 *  re-scrolls on every document revision fights the hand that is working. */
function scrollRollToNotes() {
  const wrap = $("rollWrap");
  const spanUsed = usedPitchSpan();
  if (!spanUsed) return;
  if (wrap.scrollHeight <= wrap.clientHeight + 1) return;
  const yTop = yOfPitch(Math.min(S.rollHi, spanUsed.hi)) + ROLL_RULER_H;
  const yBot = yOfPitch(Math.max(S.rollLo, spanUsed.lo)) + S.rowH + ROLL_RULER_H;
  const seen0 = wrap.scrollTop, seen1 = seen0 + wrap.clientHeight;
  if (yTop >= seen0 && yBot <= seen1) return;             // already in view
  wrap.scrollTop = Math.max(0, (yTop + yBot) / 2 - wrap.clientHeight / 2);
}

/** Vertical zoom. Any hand-driven zoom disarms fit — that is the contract. */
function zoomRows(dir) {
  S.rollFit = false;
  $("rFit").classList.remove("d-on");
  const wrap = $("rollWrap");
  const anchor = (wrap.scrollTop - ROLL_RULER_H + wrap.clientHeight / 2) / Math.max(1, S.rowH);
  S.rowH = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.round(S.rowH * (dir > 0 ? 1.25 : 0.8))));
  if (S.rowH === ROW_MIN || S.rowH === ROW_MAX) { /* clamped, still redraw */ }
  /* Zooming out past the fitted window re-opens it, so you can always get
   * back to the whole keyboard by zooming out. */
  if (dir < 0) {
    S.rollLo = Math.max(PITCH_LO, S.rollLo - 2);
    S.rollHi = Math.min(PITCH_HI, S.rollHi + 2);
  }
  draw();
  wrap.scrollTop = Math.max(0, anchor * S.rowH + ROLL_RULER_H - wrap.clientHeight / 2);
  paintSelInfo();
  status(`rows ${S.rowH} px · pitches ${S.rollLo}–${S.rollHi}`);
}

/** Horizontal zoom, on whichever timeline the pointer is over. */
function zoomTime(dir, which) {
  const f = dir > 0 ? 1.3 : 1 / 1.3;
  const w = which || ($("paneRoll").classList.contains("d-on") ? "roll" : "arr");
  if (w === "roll") {
    const wrap = $("rollWrap");
    const anchor = (wrap.scrollLeft + wrap.clientWidth / 2 - KEYS_W) / S.pxq;
    S.pxq = Math.max(PXQ_MIN, Math.min(PXQ_MAX, S.pxq * f));
    draw(); drawRollRuler();
    wrap.scrollLeft = Math.max(0, anchor * S.pxq + KEYS_W - wrap.clientWidth / 2);
    paintSelInfo();
    status(`roll zoom: ${S.pxq.toFixed(1)} px per quarter`);
  } else {
    const wrap = $("arrWrap");
    const anchor = (wrap.scrollLeft + wrap.clientWidth / 2) / S.arrPxq;
    S.arrPxq = Math.max(APXQ_MIN, Math.min(APXQ_MAX, S.arrPxq * f));
    drawArr(); drawAutoCanvas();
    wrap.scrollLeft = Math.max(0, anchor * S.arrPxq - wrap.clientWidth / 2);
    status(`arrangement zoom: ${S.arrPxq.toFixed(1)} px per quarter`);
  }
}

/** Fit the whole song into the arrangement's width. */
function fitArr() {
  const wrap = $("arrWrap");
  const room = Math.max(120, wrap.clientWidth - HEAD_W - 24);
  const q = totalQ();
  if (q > 0) S.arrPxq = Math.max(APXQ_MIN, Math.min(APXQ_MAX, room / q));
  wrap.scrollLeft = 0;
  drawArr(); drawAutoCanvas();
  status(`arrangement fit: ${totalQ().toFixed(0)} quarters across ${Math.round(room)} px`);
}
function fitBoth() { fitArr(); fitRoll(true); }
function inScale(pitch) {
  const sc = SCALES[$("scaleType").value];
  if (!sc) return true;
  const root = NOTE_NAMES.indexOf($("scaleRoot").value);
  return sc.includes((((pitch - root) % 12) + 12) % 12);
}

let ROWS = [];
const rowIdx = (p) => ROWS.indexOf(p);
const yOfPitch = (p) => TOP_H + rowIdx(p) * S.rowH;
const pitchAtY = (y) => ROWS[Math.floor((y - TOP_H) / S.rowH)] ?? null;
const velTop = () => TOP_H + ROWS.length * S.rowH + VEL_GAP;

function noteRect(n) {
  const x = KEYS_W + posToQ(n.bar, n.beat, n.tick) * S.pxq;
  const w = Math.max(4, durTicksToQ(n.bar, n.beat, n.tick, n.durTicks) * S.pxq - 1);
  const i = rowIdx(n.pitch);
  return { x, y: TOP_H + i * S.rowH, w, h: S.rowH - 1, off: i < 0 };
}

function draw() {
  if (!S.proj || !S.timeline.length) return;
  paintSelInfo();
  ROWS = rollRows();
  const W = KEYS_W + Math.ceil(totalQ() * S.pxq) + 20;
  const H = velTop() + VEL_H;
  fitCanvas(canvas, W, H);
  const g = ctx2d;
  g.clearRect(0, 0, W, H);
  g.font = "10px monospace";

  // pitch rows: black keys shaded, out-of-scale rows dimmed, octaves lined
  ROWS.forEach((p, i) => {
    const y = TOP_H + i * S.rowH;
    if ([1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12)) {
      tint(g, C.panel, 0.85, () => g.fillRect(KEYS_W, y, W, S.rowH));
    }
    if (!inScale(p)) tint(g, C.rail, 0.5, () => g.fillRect(KEYS_W, y, W, S.rowH));
    else if (SCALES[$("scaleType").value]) tint(g, C.primary, 0.045, () => g.fillRect(KEYS_W, y, W, S.rowH));
    if (p % 12 === 0) tint(g, C.hair, 1, () => g.fillRect(KEYS_W, y + S.rowH - 1, W, 1));
  });

  // the grid FROM the meter map: uneven bars drawn honestly, plus the
  // editor's own snap grid inside each bar (7 beats in 7/8, not 8)
  for (const r of S.timeline) {
    const x0 = KEYS_W + r.qStart * S.pxq;
    tint(g, C.edge, 1, () => g.fillRect(x0, TOP_H, r.bar === 1 ? 1 : 1.5, H - TOP_H));
    const beatQ = 4 / r.den;
    for (let b = 1; b < r.num; b++) {
      tint(g, C.hair, 0.9, () => g.fillRect(x0 + b * beatQ * S.pxq, TOP_H, 1, H - TOP_H));
    }
    if (S.grid && S.grid < TPB) {
      const stepQ = S.grid / TPB * beatQ;
      for (let q = stepQ; q < r.qLen - 1e-9; q += stepQ) {
        if (Math.abs(q / beatQ - Math.round(q / beatQ)) < 1e-9) continue;
        tint(g, C.hair, 0.35, () => g.fillRect(x0 + q * S.pxq, TOP_H, 1, H - TOP_H));
      }
    }
  }

  // the loop range, the same shape the ruler above it shows
  drawLoopBand(g, S.pxq, KEYS_W, 0, H);

  // region boundaries — the render seams, made visible on purpose
  for (const r of S.regions) {
    tint(g, C.primary, 0.18, () => g.fillRect(KEYS_W + secondsToQ(r.t0) * S.pxq, TOP_H, 1, H - TOP_H));
  }
  for (const d of S.pending) {
    const x0 = KEYS_W + (rowOf(d.fromBar)?.qStart ?? 0) * S.pxq;
    const rr = rowOf(d.toBar);
    const x1 = KEYS_W + ((rr?.qStart ?? 0) + (rr?.qLen ?? 0)) * S.pxq;
    tint(g, C.warn, 0.1, () => g.fillRect(x0, TOP_H, x1 - x0, H - TOP_H));
  }

  // ghost notes from the other tracks
  if ($("ghostChk").checked) {
    for (const t of S.proj.tracks) {
      if (t.id === S.trackId) continue;
      for (const c of t.clips) for (const n of c.notes) {
        const r = noteRect(n);
        if (r.off) continue;
        tint(g, C.ghost, 0.28, () => g.fillRect(r.x, r.y, r.w, r.h));
      }
    }
  }

  // the selected track's notes, and the velocity lane below
  tint(g, C.panel, 0.7, () => g.fillRect(KEYS_W, velTop() - VEL_GAP, W, VEL_H + VEL_GAP));
  tint(g, C.hair, 1, () => g.fillRect(KEYS_W, velTop() - 1, W, 1));
  /* THE LANE HAS A SCALE NOW. It was a row of 3 px stems against nothing,
   * so a stem's height was not a number and the lane read as decoration —
   * the same fault the meters had before they were given a dB gutter, and
   * the same fix. 127 / 96 / 64 / 32 are ruled across it and labelled in
   * the pinned key gutter, so a velocity can be READ and not just dragged. */
  const velY = velLaneY;                        // one geometry, named once (see velLaneY)
  const velLabelX = S.keysX || 0;
  /* ruled at four velocities, NUMBERED at two: 56 px of lane cannot carry
   * four 10 px labels without them colliding with each other and with the
   * caption, and 127/64 are the two a hand actually aims for. */
  for (const v of [127, 96, 64, 32]) {
    const y = Math.round(velY(v));
    tint(g, C.hair, v === 64 ? 0.9 : 0.4, () => g.fillRect(KEYS_W, y, W, 1));
    if (v === 127 || v === 64) {
      tint(g, C.ghost, 0.9, () => g.fillText(`${v}`, velLabelX + KEYS_W - 24, y + 3));
    }
  }
  tint(g, C.ghost, 1, () => g.fillText("vel", velLabelX + 3, velTop() + VEL_H - 2));

  const trkCol = colourOf(S.trackId);
  for (const { n, c } of selNotes()) {
    const r = noteRect(n);
    const colour = n.by === "agent" ? C.secondary : trkCol;
    /* A note outside its clip's bounds is KEPT and SILENT (set_clip's
     * container rule). Drawn hollow, because a note that looks like every
     * other note and makes no sound is the worst thing a roll can do. */
    const silent = n.bar < c.fromBar || n.bar > c.toBar;
    if (!r.off && silent) {
      tint(g, colour, 0.22, () => {
        g.setLineDash([3, 2]);
        g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        g.setLineDash([]);
      });
    } else if (!r.off) {
      const a = 0.35 + 0.65 * (n.vel / 127);
      tint(g, colour, a, () => g.fillRect(r.x, r.y, r.w, r.h));
      /* The agent's hand, marked twice over: the secondary colour AND a
       * cap along the top edge, so it survives colour-blindness, a small
       * zoom and a screenshot. */
      if (n.by === "agent") tint(g, C.ink, 0.85, () => g.fillRect(r.x, r.y, r.w, 2));
      if (S.sel.has(n.id)) {
        tint(g, C.ink, 1, () => g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1));
      }
      tint(g, C.ink, 0.35, () => g.fillRect(r.x + r.w - 3, r.y, 3, r.h));
    }
    /* THE VELOCITY STEM, READ THROUGH THE GESTURE. velOf() is the strategy's
     * computed value while one is live and the note's own the rest of the
     * time — which is the whole of "the ramp is visible before anything is
     * written": this loop is the only thing that changes during a drag. */
    const vx = KEYS_W + posToQ(n.bar, n.beat, n.tick) * S.pxq;
    const shown = velOf(n);
    const vh = (shown / 127) * (VEL_H - 8);
    const sel = S.sel.has(n.id);
    const vy = velTop() + VEL_H - 4 - vh;
    /* a stem the live gesture is moving is drawn against its stored height,
     * so you can see what you are changing it FROM as well as to */
    if (S.velStrategy && shown !== n.vel) {
      const oh = (n.vel / 127) * (VEL_H - 8);
      tint(g, C.ghost, 0.45, () => g.fillRect(vx, velTop() + VEL_H - 4 - oh, 4, oh));
    }
    tint(g, colour, sel ? 1 : 0.7, () => g.fillRect(vx, vy, 4, vh));
    tint(g, sel ? C.ink : colour, 1, () => g.fillRect(vx - 1, vy - 1, 6, 2));
  }
  /* the gesture's own guide, drawn last so it is on top of every stem */
  if (S.velStrategy) S.velStrategy.paint(g);

  // the rubber band
  if (S.drag?.mode === "band") {
    const d = S.drag;
    tint(g, C.primary, 0.5, () => g.strokeRect(
      Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5,
      Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)));
  }

  /* THE PIANO-KEY GUTTER, PINNED. It is drawn last, at the scroll offset,
   * so it stays under your eye when the roll is scrolled right — the same
   * thing every DAW's keyboard does. (Drawn in-canvas rather than as a
   * second element: one canvas, one coordinate system, no drift.) */
  S.keysX = Math.max(0, $("rollWrap").scrollLeft);
  const gx = S.keysX;
  tint(g, C.panel, 1, () => g.fillRect(gx, TOP_H, KEYS_W, H - TOP_H));
  tint(g, C.edge, 0.8, () => g.fillRect(gx + KEYS_W - 1, TOP_H, 1, H - TOP_H));
  ROWS.forEach((p, i) => {
    const y = TOP_H + i * S.rowH;
    const black = [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    if (black) tint(g, C.rail, 1, () => g.fillRect(gx, y, KEYS_W - 8, S.rowH));
    else tint(g, C.hair, 0.6, () => g.fillRect(gx, y + S.rowH - 1, KEYS_W, 1));
    // every C is named; so is every row once the rows are tall enough to read
    if (p % 12 === 0 || $("foldChk").checked || S.rowH >= 11) {
      tint(g, p % 12 === 0 ? C.dim : C.ghost, 1, () => g.fillText(
        `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`, gx + 4, y + S.rowH - 3));
    }
  });

  drawPlayhead();
  drawRollRuler();
}

function drawPlayhead() {
  const x = KEYS_W + secondsToQ(projTime()) * S.pxq;
  tint(ctx2d, C.warn, 1, () => ctx2d.fillRect(x, TOP_H, 1.5, canvas.height - TOP_H));
  followPlayhead(x);
}

/* ══════════════════ THE PIANO ROLL'S OWN RULER ══════════════════════════
 * Its own canvas, sticky to the top of the editor's scroll box. It carries
 * the bar numbers, the meter/tempo changes, the loop range and the
 * playhead — the four things you look up at the arrangement for when the
 * editor has no ruler, which is what the owner saw. */

const rulerCv = $("rollRuler");
const rulerG = rulerCv.getContext("2d");

function drawRollRuler() {
  if (!S.proj || !S.timeline.length) return;
  const W = KEYS_W + Math.ceil(totalQ() * S.pxq) + 20;
  const H = ROLL_RULER_H;
  fitCanvas(rulerCv, W, H);
  const g = rulerG;
  g.clearRect(0, 0, W, H);
  g.font = "10px monospace";
  tint(g, C.rail, 1, () => g.fillRect(0, 0, W, H));

  for (const r of S.timeline) {
    const x0 = KEYS_W + r.qStart * S.pxq;
    const changed = r.bar === 1 || r.num !== rowOf(r.bar - 1)?.num
      || r.den !== rowOf(r.bar - 1)?.den || r.bpm !== rowOf(r.bar - 1)?.bpm;
    tint(g, C.edge, 1, () => g.fillRect(x0, 0, 1, H));
    const beatQ = 4 / r.den;
    for (let b = 1; b < r.num; b++) {
      tint(g, C.hair, 0.9, () => g.fillRect(x0 + b * beatQ * S.pxq, H - 7, 1, 7));
    }
    /* Bar numbers thin out as you zoom out, instead of turning into a
     * smear of overlapping digits. */
    const every = S.pxq * r.qLen < 26 ? (S.pxq * r.qLen < 11 ? 8 : 4) : 1;
    if (r.bar % every === 0 || r.bar === 1 || changed) {
      tint(g, changed ? C.warn : C.dim, 1, () => g.fillText(`${r.bar}`, x0 + 3, 11));
    }
    if (changed) {
      tint(g, C.warn, 1, () => {
        g.fillRect(x0, 0, 1.6, H);
        g.fillText(`${r.num}/${r.den} · ${r.bpm}`, x0 + 3, H - 3);
      });
    }
  }
  drawLoopBand(g, S.pxq, KEYS_W, 0, H);
  const px = KEYS_W + secondsToQ(projTime()) * S.pxq;
  tint(g, C.warn, 1, () => {
    g.fillRect(px, 0, 1.5, H);
    g.beginPath();
    g.moveTo(px - 5, 0); g.lineTo(px + 6.5, 0); g.lineTo(px + 0.75, 8);
    g.closePath(); g.fill();
  });
  // the corner label, pinned over the key gutter
  const gx = Math.max(0, $("rollWrap").scrollLeft);
  tint(g, C.rail, 1, () => g.fillRect(gx, 0, KEYS_W, H));
  tint(g, C.edge, 0.8, () => g.fillRect(gx + KEYS_W - 1, 0, 1, H));
  tint(g, C.ghost, 1, () => g.fillText("bar", gx + 4, 11));
  tint(g, C.edge, 1, () => g.fillRect(0, H - 1, W, 1));
}

/* The ruler's own gestures: click to place the playhead, drag to set the
 * loop range — the same two the arrangement ruler has, because a second
 * idiom for the same gesture is how a program feels improvised. */
let rulerDrag = null;
rulerCv.addEventListener("contextmenu", (e) => e.preventDefault());
rulerCv.addEventListener("pointerdown", (e) => {
  if (!S.proj) return;
  const box = rulerCv.getBoundingClientRect();
  const q = Math.max(0, (e.clientX - box.left - KEYS_W) / S.pxq);
  rulerDrag = { q0: q, moved: false };
  capturePointer(rulerCv, e.pointerId);
});
rulerCv.addEventListener("pointermove", (e) => {
  if (!rulerDrag) return;
  const box = rulerCv.getBoundingClientRect();
  const q = Math.max(0, (e.clientX - box.left - KEYS_W) / S.pxq);
  if (!rulerDrag.moved && Math.abs(q - rulerDrag.q0) * S.pxq < 4) return;
  rulerDrag.moved = true;
  const a = barFloatOfQ(rulerDrag.q0), b = barFloatOfQ(q);
  S.loopA = Math.min(a, b); S.loopB = Math.max(a, b);
  paintLoopLabel(); drawRollRuler(); drawArr();
});
rulerCv.addEventListener("pointerup", (e) => {
  const d = rulerDrag; rulerDrag = null;
  if (!d) return;
  releasePointer(rulerCv, e.pointerId);
  if (d.moved) {
    setLoop(S.loopA, S.loopB);
    status(`loop range: bars ${S.loopA.toFixed(2)} → ${S.loopB.toFixed(2)}`);
  } else {
    setPlayhead(secAtQ(d.q0));
  }
});

/* Keep the playhead on screen while the transport rolls — the scroll the
 * editor pane does for you, and the one reason the wrapper is reached for. */
function followPlayhead(x) {
  if (!S.playing) return;
  const wrap = $("rollWrap");
  const left = wrap.scrollLeft, right = left + wrap.clientWidth;
  if (x < left + KEYS_W || x > right - 40) wrap.scrollLeft = Math.max(0, x - wrap.clientWidth * 0.35);
}

/* ── roll pointer interactions ─────────────────────────────────────── */

function hitNote(px, py) {
  for (const { n, c } of selNotes()) {
    const r = noteRect(n);
    if (r.off) continue;
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
      return { note: n, clip: c, rect: r, edge: px > r.x + r.w - 5 };
    }
  }
  return null;
}
/** In the velocity lane, the nearest note stem within 6 px. */
function hitVel(px) {
  let best = null, bd = 7;
  for (const { n } of selNotes()) {
    const vx = KEYS_W + posToQ(n.bar, n.beat, n.tick) * S.pxq;
    const d = Math.abs(px - vx);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
const velFromY = (py) => Math.max(1, Math.min(127,
  Math.round((1 - (py - velTop() - 4) / (VEL_H - 8)) * 127)));

/* ══════════════════════════════════════════════════════════════════════════
 * §2 THE VELOCITY LANE — read-through gestures
 *
 * WHAT WAS WRONG. The lane had exactly one gesture: pointer-down found the
 * nearest stem within 6 px, MUTATED that note's `vel` on every pointermove,
 * and committed the one note on pointer-up. So there was no ramp, no draw,
 * no way to move a chord's velocities together, no numbers and no humanize —
 * and the live mutation meant a failed write had to be rolled back by hand.
 *
 * THE MECHANISM, taken from openDAW's property modifiers (LGPL — the shape
 * was read, the code was not): during a drag the strategy COMPUTES each
 * note's velocity from the drag geometry. Nothing is written to the document
 * and nothing is posted. The painter draws THROUGH the strategy, so the ramp
 * is visible at 60 fps with zero traffic. On pointer-up `approve()` returns
 * the whole gesture and it leaves as ONE edit_notes. `cancel()` — Escape —
 * drops the object and nothing ever happened, so there is no rollback path
 * to get wrong.
 *
 * The three implementations share one interface:
 *
 *     { read(note) -> vel,   computed, never stored
 *       move(q, vel),        the pointer, in quarters and velocity
 *       paint(g),            the gesture's own guide
 *       approve() -> [{id, vel}] }
 *
 * WHICH NOTES A GESTURE MAY TOUCH is one rule for all three, and it is the
 * rule the rest of this editor already uses (targetNotes): with a selection,
 * the selection; with none, whatever the gesture's own geometry covers. A
 * gesture that quietly reached outside a selection would be the velocity
 * equivalent of an edit you did not ask for.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The velocity a NEW note gets — store.js's own default for a note that
 *  arrives without one (`num(n.vel, 100)`), and the value this page's draw
 *  gesture sends. Right-button drag resets to it, GridSound-style. */
const DEFAULT_VEL = 100;
const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));

/** The lane's y for a velocity — the one place the lane's geometry is spelled,
 *  so the stems, the rules and every gesture's guide cannot disagree. */
const velLaneY = (v) => velTop() + VEL_H - 4 - (Math.max(1, Math.min(127, v)) / 127) * (VEL_H - 8);

/** EVERY velocity read on this page goes through here. That is what makes
 *  "the model is not touched until pointer-up" true rather than intended. */
const velOf = (n) => (S.velStrategy ? S.velStrategy.read(n) : n.vel);

/** The notes a velocity gesture is allowed to move, as a Set of ids.
 *  null means "no selection — whatever the gesture's geometry covers". */
const velScope = () => (S.sel.size ? new Set(S.sel) : null);

/** VelLine — Shift+drag. A straight ramp between the two ends of the drag,
 *  interpolated across each note's own position. Signal's
 *  updateVelocitiesInRange is the same arithmetic; the difference here is
 *  that nothing is written until the end. */
function VelLine(q0, v0) {
  const scope = velScope();
  let q1 = q0, v1 = v0;
  return {
    kind: "line",
    move(q, v) { q1 = q; v1 = v; },
    read(n) {
      if (scope && !scope.has(n.id)) return n.vel;
      const q = posToQ(n.bar, n.beat, n.tick);
      const lo = Math.min(q0, q1), hi = Math.max(q0, q1);
      if (q < lo - 1e-9 || q > hi + 1e-9) return n.vel;
      const span = q1 - q0;
      const f = Math.abs(span) < 1e-9 ? 1 : (q - q0) / span;
      return clampVel(v0 + (v1 - v0) * f);
    },
    paint(g) {
      tint(g, C.primary, 0.9, () => {
        g.beginPath();
        g.moveTo(KEYS_W + q0 * S.pxq, velLaneY(v0));
        g.lineTo(KEYS_W + q1 * S.pxq, velLaneY(v1));
        g.stroke();
      });
    },
    label: () => `ramp ${v0} to ${v1}`,
  };
}

/** VelDraw — Alt/Ctrl+drag, and (with a fixed value) the right-button reset.
 *  A map of painted columns; a note reads the nearest painted column when it
 *  lies under the stroke, and its own stored value when it does not. */
function VelDraw(fixed) {
  const scope = velScope();
  const cols = new Map();                 // column index -> velocity
  const COL = 96;                         // columns per quarter note (~10 ticks)
  let lo = Infinity, hi = -Infinity;
  return {
    kind: fixed === undefined ? "draw" : "reset",
    move(q, v) {
      const c = Math.round(q * COL);
      cols.set(c, fixed === undefined ? clampVel(v) : fixed);
      lo = Math.min(lo, c); hi = Math.max(hi, c);
    },
    read(n) {
      if (scope && !scope.has(n.id)) return n.vel;
      if (!cols.size) return n.vel;
      const c = Math.round(posToQ(n.bar, n.beat, n.tick) * COL);
      if (c < lo || c > hi) return n.vel;
      let best = null, bd = Infinity;
      for (const [k, v] of cols) { const d = Math.abs(k - c); if (d < bd) { bd = d; best = v; } }
      return best ?? n.vel;
    },
    paint(g) {
      tint(g, C.primary, 0.75, () => {
        for (const [c, v] of cols) g.fillRect(KEYS_W + (c / COL) * S.pxq - 1, velLaneY(v) - 1, 2, 2);
      });
    },
    label: () => (fixed === undefined ? `painted ${cols.size} column(s)` : `reset to ${fixed}`),
  };
}

/** VelNode — the plain drag, generalised. It applies a RELATIVE delta to the
 *  whole selection, so a chord's shape survives being made louder; with an
 *  empty selection the scope is the one note under the pointer and the read
 *  is the absolute value from y, which is exactly what this lane did before. */
function VelNode(anchor) {
  const scope = S.sel.size ? new Set(S.sel) : new Set([anchor.id]);
  const orig = new Map();
  for (const { n } of selNotes()) if (scope.has(n.id)) orig.set(n.id, n.vel);
  const base = orig.get(anchor.id) ?? anchor.vel;
  let target = base;
  return {
    kind: "node",
    move(q, v) { target = clampVel(v); },
    read(n) {
      if (!scope.has(n.id)) return n.vel;
      if (n.id === anchor.id) return target;
      return clampVel((orig.get(n.id) ?? n.vel) + (target - base));
    },
    paint(g) {
      const vx = KEYS_W + posToQ(anchor.bar, anchor.beat, anchor.tick) * S.pxq;
      tint(g, C.ink, 1, () => g.fillText(`${target}`, vx + 8, velLaneY(target) + 4));
    },
    label: () => (scope.size > 1
      ? `${scope.size} velocities by ${target - base >= 0 ? "+" : ""}${target - base}`
      : `velocity ${base} to ${target}`),
  };
}

/** What the live gesture would change, as edit_notes entries. Notes whose
 *  computed value equals their stored one are dropped — the route refuses an
 *  entry that names no change, and it is right to. */
function velChanges(strat) {
  const out = [];
  for (const { n } of selNotes()) {
    const v = clampVel(strat.read(n));
    if (v !== n.vel) out.push({ note: n.id, vel: v });
  }
  return out;
}

/**
 * ONE POST PER GESTURE. A velocity drag used to be one note and one round
 * trip; a twelve-note ramp under the old code would have been twelve. This is
 * one document write, one ledger row, one dirty-region computation and one
 * undo step — and the undo is the ROUTE's own inverse body, snapshotted
 * server-side before the write and posted straight back.
 */
async function commitVel(strat, label) {
  const session = captureSession();
  const notes = velChanges(strat);
  S.velStrategy = null;
  if (!notes.length) { draw(); status("velocity: nothing changed"); return; }
  const t0 = performance.now();
  const body = { action: "edit_notes", slug: S.slug, track: S.trackId, notes };
  try {
    const r = await api(body);
    if (!sessionCurrent(session)) return;
    if (r.undo) pushUndo({ body: r.undo, forward: body, label });
    await refreshDoc(session);
    if (!sessionCurrent(session)) return;
    renderAndSwap(t0, performance.now(), r.dirty, session);
    status(`${label} — ${notes.length} note(s), one edit_notes`);
  } catch (err) {
    if (!sessionCurrent(session)) return;
    draw();
    status(`velocity: ${err.message}`);
  }
}

/* Escape cancels a live gesture. It is a listener of its own rather than a
 * keymap entry because it must fire while the pointer is captured, and a
 * cancelled gesture must never reach the server at all. */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !S.velStrategy) return;
  S.velStrategy = null;
  S.drag = null;
  e.preventDefault();
  draw();
  status("velocity gesture cancelled — nothing was sent");
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", async (e) => {
  if (!S.proj || !S.trackId) return;
  const box = canvas.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  // (the bar ruler is #rollRuler now, a canvas of its own — see above)

  /* THE VELOCITY LANE — §2's three read-through gestures, chosen by the
   * modifier the way every DAW chooses them. Nothing below writes to a note:
   * the strategy is installed, the painter reads through it, and the whole
   * gesture leaves as one edit_notes on release. */
  if (py >= velTop()) {
    const q = Math.max(0, (px - KEYS_W) / S.pxq);
    const v = velFromY(py);
    let strat = null;
    if (e.button === 2) strat = VelDraw(DEFAULT_VEL);                 // right-drag: reset
    else if (e.shiftKey) strat = VelLine(q, v);                       // shift-drag: ramp
    else if (e.altKey || e.ctrlKey || e.metaKey) strat = VelDraw();   // alt-drag: paint
    else {
      /* the plain drag still needs a stem to grab, because with no selection
       * it IS the old single-note gesture and there is nothing else to aim at */
      const n = hitVel(px);
      if (!n) return;
      strat = VelNode(n);
    }
    strat.move(q, v);
    S.velStrategy = strat;
    S.drag = { mode: "vel", strat };
    capturePointer(canvas, e.pointerId);
    draw();
    return;
  }
  // the pinned key gutter follows the scroll, so its hit box does too
  if (px >= (S.keysX || 0) && px < (S.keysX || 0) + KEYS_W) {
    const p = pitchAtY(py);
    if (p != null) previewPitch(p);
    return;
  }

  const hit = hitNote(px, py);
  const erase = e.button === 2 || S.mode === "erase" || (e.altKey && S.mode !== "select");

  if (erase) {
    if (!hit) return;
    S.sel.delete(hit.note.id);
    await act(
      { action: "delete_note", slug: S.slug, track: S.trackId, note: hit.note.id },
      { action: "add_note", slug: S.slug, track: S.trackId, clip: hit.clip.id,
        bar: hit.note.bar, beat: hit.note.beat, tick: hit.note.tick,
        pitch: hit.note.pitch, vel: hit.note.vel, dur_ticks: hit.note.durTicks },
      `delete note ${hit.note.pitch}`);
    return;
  }

  if (hit) {
    /* THE ASK: clicking a note plays it, through this track's own patch and
     * at the note's own velocity and length — so it is the note you are
     * pointing at, not a generic beep. */
    auditionNote(hit.note.pitch, hit.note.vel, hit.note.durTicks);
    S.aud.lastPitch = hit.note.pitch;      // a drag from here starts gated
    if (!S.sel.has(hit.note.id)) {
      if (!e.shiftKey) S.sel.clear();
      S.sel.add(hit.note.id);
    } else if (e.shiftKey) { S.sel.delete(hit.note.id); draw(); return; }
    const moving = [...S.sel].map((id) => selNotes().find((x) => x.n.id === id)?.n).filter(Boolean);
    S.drag = {
      mode: hit.edge ? "resize" : "move",
      note: hit.note, notes: moving, startPx: px, startPy: py,
      orig: moving.map((n) => ({ ...n })), moved: false,
    };
    capturePointer(canvas, e.pointerId);
    draw();
    return;
  }

  if (S.mode === "select") {                              // rubber band
    if (!e.shiftKey) S.sel.clear();
    S.drag = { mode: "band", x0: px, y0: py, x1: px, y1: py };
    capturePointer(canvas, e.pointerId);
    draw();
    return;
  }

  // draw mode on empty space: a note at the grid, one grid step long
  const pos = qToPos(Math.max(0, (px - KEYS_W) / S.pxq));
  const pitch = pitchAtY(py);
  if (pitch == null) return;
  const dur = S.grid || TPB;
  /* a drawn note sounds AS IT LANDS — the audition is fired before the
   * write so the ear and the eye agree, and it does not wait on add_note. */
  auditionNote(pitch, 100, dur);
  S.aud.lastPitch = pitch;
  const r = await act(
    { action: "add_note", slug: S.slug, track: S.trackId, bar: pos.bar, beat: pos.beat,
      tick: pos.tick, pitch, vel: 100, dur_ticks: dur },
    null, `add note ${pitch}`);
  if (r?.note?.id) {
    S.sel.clear(); S.sel.add(r.note.id);
    pushUndo({ body: { action: "delete_note", slug: S.slug, track: S.trackId, note: r.note.id },
               forward: { action: "add_note", slug: S.slug, track: S.trackId, bar: pos.bar,
                          beat: pos.beat, tick: pos.tick, pitch, vel: 100, dur_ticks: dur },
               inverseFrom: (rr) => ({ body: { action: "delete_note", slug: S.slug,
                                               track: S.trackId, note: rr?.note?.id } }),
               label: `add note ${pitch}` });
    draw();
  }
});

canvas.addEventListener("pointermove", (e) => {
  const d = S.drag;
  if (!d) return;
  const box = canvas.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  d.moved = true;
  if (d.mode === "vel") {
    d.strat.move(Math.max(0, (px - KEYS_W) / S.pxq), velFromY(py));
    draw();
    return;
  }
  if (d.mode === "band") { d.x1 = px; d.y1 = py; bandSelect(d); draw(); return; }
  if (d.mode === "move") {
    const dq = (px - d.startPx) / S.pxq;
    const dRow = Math.round((py - d.startPy) / Math.max(1, S.rowH));
    d.notes.forEach((n, i) => {
      const o = d.orig[i];
      const q = Math.max(0, posToQ(o.bar, o.beat, o.tick) + dq);
      Object.assign(n, qToPos(q));
      const ri = ROWS.indexOf(o.pitch) + dRow;
      n.pitch = ROWS[Math.max(0, Math.min(ROWS.length - 1, ri))] ?? o.pitch;
    });
    /* the standard console behaviour: dragging a note VERTICALLY sounds
     * each new pitch as you cross into it. Dragging it along time is
     * silent — auditionDrag only fires when the pitch really changed. */
    auditionDrag(d.note.pitch, d.note.vel, d.note.durTicks);
  } else {                                                // resize
    const changes = resizeNoteDurations({ notes: d.orig, anchorId: d.note.id,
      deltaQ: (px - d.startPx) / S.pxq, timeline: S.timeline, grid: S.grid, ticksPerBeat: TPB });
    const durations = new Map(changes.map(n => [n.note, n.durTicks]));
    d.notes.forEach(n => { if (durations.has(n.id)) n.durTicks = durations.get(n.id); });
  }
  draw();
});

canvas.addEventListener("pointerup", async (e) => {
  const session = captureSession();
  const d = S.drag;
  S.drag = null;
  S.aud.lastPitch = null;              // the next gesture starts fresh
  if (!d) return;
  releasePointer(canvas, e.pointerId);
  if (d.mode === "band") { draw(); return; }
  /* The velocity branch sits ABOVE the moved gate on purpose: a click in the
   * lane with no movement is still a velocity being set, and always was. */
  if (d.mode === "vel") { await commitVel(d.strat, d.strat.label()); return; }
  if (!d.moved) { draw(); return; }
  const t0 = performance.now();
  /* ONE POST, NOT N. This commit used to be an awaited move_note PER NOTE
   * inside a loop: dragging a 24-note chord was 24 serialised round trips,
   * 24 document writes and 24 ledger rows for one gesture, and the render
   * that followed each one. edit_notes takes the whole array, so it is one
   * write, one ledger row, one dirty set and one undo — and the undo is the
   * route's own inverse, snapshotted before the write. */
  /* A note the drag put back where it started names no change, and the route
   * refuses an entry that names none — rightly, since it would make the undo
   * it returns wrong. A drag that snapped back to its own grid position is an
   * ordinary thing to do with a pointer, so it is filtered here rather than
   * refused there. */
  const moved = d.notes.filter((n, i) => {
    const o = d.orig[i];
    return n.bar !== o.bar || n.beat !== o.beat || n.tick !== o.tick
      || n.pitch !== o.pitch || n.durTicks !== o.durTicks;
  });
  if (!moved.length) { draw(); return; }
  const body = {
    action: "edit_notes", slug: S.slug, track: S.trackId,
    notes: moved.map((n) => ({ note: n.id, bar: n.bar, beat: n.beat, tick: n.tick,
                               pitch: n.pitch, dur_ticks: n.durTicks })),
  };
  try {
    const last = await api(body);
    if (!sessionCurrent(session)) return;
    pushUndo({
      label: `${d.mode} ${moved.length} note(s)`,
      body: last.undo || { action: "edit_notes", slug: body.slug, track: body.track,
        notes: d.orig.filter((o) => moved.some((n) => n.id === o.id))
          .map((o) => ({ note: o.id, bar: o.bar, beat: o.beat, tick: o.tick,
                         pitch: o.pitch, dur_ticks: o.durTicks })) },
      forward: body,
    });
    await refreshDoc(session);
    if (!sessionCurrent(session)) return;
    renderAndSwap(t0, performance.now(), last?.dirty, session);
  } catch (err) {
    if (!sessionCurrent(session)) return;
    d.notes.forEach((n, i) => Object.assign(n, d.orig[i]));
    draw();
    status(err.message);
  }
});

function bandSelect(d) {
  const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
  const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
  for (const { n } of selNotes()) {
    const r = noteRect(n);
    if (r.off) continue;
    if (r.x + r.w >= x0 && r.x <= x1 && r.y + r.h >= y0 && r.y <= y1) S.sel.add(n.id);
  }
}

/* ── piano-roll commands (also the keymap's targets) ────────────────── */

function setMode(m) {
  S.mode = m;
  for (const [id, k] of [["modeDraw", "draw"], ["modeSel", "select"], ["modeErase", "erase"]]) {
    $("shell").querySelector(`#${id}`)?.classList.toggle("d-on", m === k);
  }
  paintSelInfo();
  status(`${m} mode`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §2 THE TWO VELOCITY COMMANDS THAT CANNOT BE A DRAG
 *
 * Both are strategies like the three above — same `read(note)`, same
 * velChanges(), same one edit_notes on the way out — so there is one code
 * path from "what should this note's velocity be" to "what leaves the page",
 * and a number typed into a box cannot behave differently from a number
 * dragged with a pointer.
 *
 * WHICH NOTES: only the selection. Select all explicitly targets the track;
 * an empty selection leaves every note alone, as quantize and duplicate do.
 * ═════════════════════════════════════════════════════════════════════════ */

/** set / + / × over the target. `×` is read in hundredths so the spinner can
 *  stay an integer: 100 is unchanged, 120 is a fifth louder, 80 quieter. */
function VelNumber(mode, raw) {
  const scope = new Set(S.sel);
  return {
    kind: "number",
    move() {}, paint() {},
    read(n) {
      if (scope && !scope.has(n.id)) return n.vel;
      if (mode === "set") return clampVel(raw);
      if (mode === "add") return clampVel(n.vel + raw);
      return clampVel(n.vel * raw / 100);
    },
    label: () => (mode === "set" ? `velocity = ${clampVel(raw)}`
      : mode === "add" ? `velocity ${raw >= 0 ? "+" : ""}${raw}`
        : `velocity × ${(raw / 100).toFixed(2)}`),
  };
}

/**
 * A NOTE'S OWN NUMBER — and why humanize does not call Math.random().
 *
 * store.js gives every rendered note a seed, `noteSeed(trackId, noteId,
 * pitch, startSample)`, so a synth's noise is reproducible and a region's
 * bytes are a function of the document. Humanize has to obey the same rule
 * for a sharper reason: a random scatter writes different velocities on every
 * press, so a "humanized" part would re-render differently every time anybody
 * touched it, and the region hash — the thing that makes the monitor the
 * bounce — would move under it.
 *
 * THIS IS NOT THAT FUNCTION, and the difference is worth stating rather than
 * blurring. `noteSeed` is a SHA-1 over the note's absolute START SAMPLE, and
 * this page does not hold a start sample: it is the server's tempo-map
 * arithmetic, and re-deriving it here would be exactly the second
 * implementation this program refuses to keep. So the seed is the note's
 * identity as the page really holds it — track, note id, pitch, bar.beat.tick
 * — through the integer hash below (FNV-1a plus one avalanche round, so two
 * note ids differing by a character do not land on adjacent velocities).
 *
 * The property that matters is the one that is testable, and ui_test.js tests
 * it: the same notes give the same numbers, every press, on every machine.
 */
function velJitter(trackId, n) {
  const key = `${trackId}:${n.id}:${n.pitch}:${n.bar}.${n.beat}.${n.tick}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295 * 2 - 1;                       // −1 … +1, uniform
}

/** ± `amount` velocity steps, scattered deterministically. */
function VelHumanize(amount) {
  const scope = new Set(S.sel);
  const trackId = S.trackId;
  return {
    kind: "humanize",
    move() {}, paint() {},
    read(n) {
      if (scope && !scope.has(n.id)) return n.vel;
      return clampVel(n.vel + Math.round(velJitter(trackId, n) * amount));
    },
    label: () => `humanized ±${amount}`,
  };
}

$("velApply").addEventListener("click", () => {
  if (!S.slug || !S.trackId) { status("select a track first"); return; }
  const mode = $("velMode").value;
  const raw = Math.round(Number($("velNum").value) || 0);
  commitVel(VelNumber(mode, raw), VelNumber(mode, raw).label());
});
$("velHuman").addEventListener("click", () => {
  if (!S.slug || !S.trackId) { status("select a track first"); return; }
  const amt = Math.max(1, Math.min(63, Math.round(Number($("velAmt").value) || 8)));
  commitVel(VelHumanize(amt), VelHumanize(amt).label());
});
/* The number box's range follows the mode, because -127 is meaningful for +
 * and meaningless for set, and a spinner that lets you type a value the mode
 * cannot use is a spinner that teaches the wrong thing. */
$("velMode").addEventListener("change", () => {
  const m = $("velMode").value;
  const box = $("velNum");
  box.min = m === "add" ? -127 : m === "mul" ? 1 : 1;
  box.max = m === "mul" ? 400 : 127;
  if (m === "mul" && Number(box.value) > 400) box.value = 100;
  status(m === "set" ? "velocity: set the selection to this value"
    : m === "add" ? "velocity: add this much to the selection (negative subtracts)"
      : "velocity: scale the selection by this, in hundredths (100 = unchanged)");
});

$("quantBtn").addEventListener("click", quantizeSelection);
$("modeDraw").addEventListener("click", () => setMode("draw"));
$("modeSel").addEventListener("click", () => setMode("select"));
$("modeErase").addEventListener("click", () => setMode("erase"));
$("gridSel").addEventListener("change", () => { S.grid = Number($("gridSel").value); draw(); });
$("foldChk").addEventListener("change", draw);
$("ghostChk").addEventListener("change", draw);
/* auditioning is a taste, so it is remembered per browser (same place and
 * the same caveat as the keymap and the track colours). */
$("audChk").addEventListener("change", () => {
  S.aud.on = $("audChk").checked;
  if (!S.aud.on) auditionStop();
  try { localStorage.setItem("daw.audition", S.aud.on ? "1" : "0"); } catch { /* private mode */ }
  status(S.aud.on
    ? "note auditioning on — a click, a drawn note or a vertical drag plays through this track's patch (an audition render: a server round trip, tens of ms)"
    : "note auditioning off");
});
$("scaleRoot").addEventListener("change", draw);
$("scaleType").addEventListener("change", draw);

/* ── zoom: buttons, wheel, keys — on both timelines, both axes ───────── */

$("rzIn").addEventListener("click", () => zoomTime(1, "roll"));
$("rzOut").addEventListener("click", () => zoomTime(-1, "roll"));
$("rvIn").addEventListener("click", () => zoomRows(1));
$("rvOut").addEventListener("click", () => zoomRows(-1));
$("rFit").addEventListener("click", () => fitRoll(true));
$("azIn").addEventListener("click", () => zoomTime(1, "arr"));
$("azOut").addEventListener("click", () => zoomTime(-1, "arr"));
$("azFit").addEventListener("click", fitArr);

/* Ctrl+wheel = zoom time, Alt+wheel (or Ctrl+Shift) = zoom rows. Both are
 * passive:false because zooming must not also scroll the page. */
$("rollWrap").addEventListener("wheel", (e) => {
  if (e.ctrlKey && !e.shiftKey) { e.preventDefault(); zoomTime(e.deltaY < 0 ? 1 : -1, "roll"); }
  else if (e.altKey || (e.ctrlKey && e.shiftKey)) { e.preventDefault(); zoomRows(e.deltaY < 0 ? 1 : -1); }
}, { passive: false });
$("arrWrap").addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomTime(e.deltaY < 0 ? 1 : -1, "arr");
}, { passive: false });

/* The pinned key gutter and the sticky ruler are painted at the scroll
 * offset, so a horizontal scroll has to repaint them. */
let scrollRaf = 0;
$("rollWrap").addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; draw(); });
}, { passive: true });

$("notesAll").addEventListener("click", () => {
  S.sel = new Set(selNotes().map(({ n }) => n.id));
  setMode("select"); draw(); paintSelInfo();
});
$("notesClear").addEventListener("click", () => { S.sel.clear(); draw(); paintSelInfo(); });
$("notesDuplicate").addEventListener("click", duplicateSelection);
$("notesDelete").addEventListener("click", deleteSelection);

const targetNotes = () => {
  const all = selNotes();
  return all.filter(({ n }) => S.sel.has(n.id));
};

async function quantizeSelection() {
  const session = captureSession();
  const g = S.grid;
  if (!g) { status("grid is off — pick a grid to quantize to"); return; }
  const amt = Math.max(1, Math.min(100, Number($("quantAmt").value) || 100)) / 100;
  const rows = targetNotes();
  if (!rows.length) { status("nothing to quantize"); return; }
  const t0 = performance.now();
  /* ONE POST. Quantizing 64 notes was 64 awaited move_note calls and 64
   * ledger rows; the arithmetic below is unchanged, and only the delivery is. */
  const moves = [];
  for (const { n } of rows) {
    const row = rowOf(n.bar);
    const inBar = (n.beat - 1) * TPB + n.tick;
    const target = Math.min(Math.round(inBar / g) * g, row.ticksPerBar - 1);
    const moved = Math.round(inBar + (target - inBar) * amt);
    if (moved === inBar) continue;
    moves.push({ note: n.id, bar: n.bar, beat: Math.floor(moved / TPB) + 1, tick: moved % TPB });
  }
  if (!moves.length) { status("every note is already on the grid"); return; }
  const body = { action: "edit_notes", slug: S.slug, track: S.trackId, notes: moves };
  try {
    const last = await api(body);
    if (!sessionCurrent(session)) return;
    pushUndo({ label: `quantize ${moves.length}`, body: last.undo, forward: body });
    await refreshDoc(session);
    if (!sessionCurrent(session)) return;
    renderAndSwap(t0, performance.now(), last?.dirty, session);
    status(`quantized ${moves.length} note(s) to ${$("gridSel").selectedOptions[0].textContent} at ${Math.round(amt * 100)}%`);
  } catch (err) { if (sessionCurrent(session)) status(err.message); }
}

async function duplicateSelection() {
  const session = captureSession(), track = S.trackId;
  const rows = targetNotes();
  if (!rows.length) { status("nothing to duplicate"); return; }
  let q0 = Infinity, q1 = 0;
  for (const { n } of rows) {
    const a = posToQ(n.bar, n.beat, n.tick);
    q0 = Math.min(q0, a);
    q1 = Math.max(q1, a + durTicksToQ(n.bar, n.beat, n.tick, n.durTicks));
  }
  const row = rowOf(qToPosFine(q0).bar);
  const span = Math.max(row.qLen, q1 - q0);              // at least one bar
  const t0 = performance.now();
  const made = [];
  let last = null;
  try {
    for (const { n } of rows) {
      if (!sessionCurrent(session)) return;
      const p = qToPosFine(posToQ(n.bar, n.beat, n.tick) + span);
      last = await api({ action: "add_note", slug: session.slug, track, ...p,
                         pitch: n.pitch, vel: n.vel, dur_ticks: n.durTicks });
      if (!sessionCurrent(session)) return;
      if (last.note?.id) made.push(last.note.id);
    }
    pushUndo({ label: `duplicate ${made.length}`,
      bodies: made.map((id) => ({ action: "delete_note", slug: session.slug, track, note: id })) });
    if (S.trackId === track) S.sel = new Set(made);
    await refreshDoc(session);
    if (!sessionCurrent(session)) return;
    renderAndSwap(t0, performance.now(), last?.dirty, session);
    status(`duplicated ${made.length} note(s) ${span.toFixed(2)} quarters later`);
  } catch (err) { if (sessionCurrent(session)) status(err.message); }
}

async function deleteSelection() {
  const session = captureSession(), track = S.trackId;
  const rows = targetNotes().filter(({ n }) => S.sel.has(n.id));
  if (!rows.length) { status("nothing selected"); return; }
  const t0 = performance.now();
  const back = [];
  let last = null;
  try {
    for (const { n, c } of rows) {
      if (!sessionCurrent(session)) return;
      back.push({ action: "add_note", slug: session.slug, track, clip: c.id,
                  bar: n.bar, beat: n.beat, tick: n.tick, pitch: n.pitch, vel: n.vel,
                  dur_ticks: n.durTicks });
      last = await api({ action: "delete_note", slug: session.slug, track, note: n.id });
      if (!sessionCurrent(session)) return;
    }
    /* No forwards: undoing a delete re-adds the notes with NEW ids, so a
     * replayed delete would name notes that no longer exist. */
    pushUndo({ label: `delete ${back.length}`, bodies: back });
    if (S.trackId === track) S.sel.clear();
    await refreshDoc(session);
    if (!sessionCurrent(session)) return;
    renderAndSwap(t0, performance.now(), last?.dirty, session);
  } catch (err) { if (sessionCurrent(session)) status(err.message); }
}

async function splitSelection() {
  const session = captureSession(), track = S.trackId;
  const at = barFloatNow();
  const rows = targetNotes();
  const t0 = performance.now();
  let last = null;
  const back = [], made = [];
  /* THE SHORTENING HALF LEAVES THE LOOP. A split is two things — trim the
   * head, add the tail — and only the second can mint an id, so only the
   * second has to be one call per note. Every trim goes in one edit_notes. */
  const heads = [], tails = [];
  for (const { n } of rows) {
    const q = posToQ(n.bar, n.beat, n.tick);
    const qEnd = q + durTicksToQ(n.bar, n.beat, n.tick, n.durTicks);
    const qCut = qOfBarFloat(at);
    if (qCut <= q + 0.01 || qCut >= qEnd - 0.01) continue;
    const row = rowOf(n.bar);
    const head = Math.max(1, Math.round((qCut - q) / (4 / row.den) * TPB));
    heads.push({ note: n.id, dur_ticks: head });
    back.push({ note: n.id, dur_ticks: n.durTicks });
    tails.push({ ...qToPosFine(qCut), pitch: n.pitch, vel: n.vel,
                 dur_ticks: Math.max(1, n.durTicks - head) });
  }
  const cut = heads.length;
  try {
    if (cut) {
      await api({ action: "edit_notes", slug: session.slug, track, notes: heads });
      if (!sessionCurrent(session)) return;
      for (const t of tails) {
        if (!sessionCurrent(session)) return;
        last = await api({ action: "add_note", slug: session.slug, track, ...t });
        if (!sessionCurrent(session)) return;
        if (last.note?.id) made.push(last.note.id);
      }
    }
    if (cut) {
      /* The inverse is: delete the tails, then give every head its length
       * back — the second half in ONE post, matching the forward. */
      pushUndo({ label: `split ${cut}`,
        bodies: [...made.map((id) => ({ action: "delete_note", slug: session.slug, track, note: id })),
                 { action: "edit_notes", slug: session.slug, track, notes: back }] });
      await refreshDoc(session);
      if (!sessionCurrent(session)) return;
      renderAndSwap(t0, performance.now(), last?.dirty, session);
    }
    status(cut ? `split ${cut} note(s) at bar ${at.toFixed(2)}` : "the playhead is not inside any selected note");
  } catch (err) { if (sessionCurrent(session)) status(err.message); }
}

/* ═════════════════════════════════════════════ AUTOMATION LANES ═════════
 * One lane per automatable parameter. The lane reads and writes the exact
 * keyframe shape the store already holds — { keys: [{ t, v }] }, t in FLOAT
 * BARS — through the exact action that owns the parameter. There is no
 * automation "format" in this file. */

const isKeyed = (v) => !!v && typeof v === "object" && Array.isArray(v.keys);
/** A keyed value's plain form — what an inverse action can carry back. */
const plainOf = (v) => (isKeyed(v) ? (v.keys[0]?.v ?? 0) : Number(v ?? 0));

/** Resolve a lane key to everything the UI needs and the action that writes it.
 * key = trk:<id>:fader | trk:<id>:pan | trk:<id>:send:<retId>
 *     | trk:<id>:ins:<insId>:<param> | ret:<id>:… | mst:master:fader */
function laneRef(key) {
  if (!S.proj) return null;
  const p = key.split(":");
  const kind = p[0], hostId = p[1];
  const host = kind === "mst" ? S.proj.master
    : kind === "ret" ? (S.proj.returns || []).find((r) => r.id === hostId)
    : S.proj.tracks.find((t) => t.id === hostId);
  if (!host) return null;
  const target = kind === "mst" ? "master" : hostId;
  const hostName = kind === "mst" ? "Master" : (host.name || hostId);

  const mk = (label, min, max, unit, getter, writer) => ({
    key, label, min, max, unit, host, hostId, kind,
    plain: () => (isKeyed(getter()) ? (getter().keys[0]?.v ?? 0) : Number(getter() ?? 0)),
    keys: () => (isKeyed(getter()) ? getter().keys : []),
    value: getter,
    write: writer,
  });

  if (p[2] === "fader") {
    return mk(`${hostName} · fader`, -60, 12, "dB", () => host.fader,
      (v) => ({ action: "mixer_set", slug: S.slug, target, fader: v }));
  }
  if (p[2] === "pan") {
    return mk(`${hostName} · pan`, -1, 1, "", () => host.pan,
      (v) => ({ action: "mixer_set", slug: S.slug, target, pan: v }));
  }
  if (p[2] === "send") {
    const ret = (S.proj.returns || []).find((r) => r.id === p[3]);
    const s = (host.sends || []).find((x) => x.to === p[3]);
    if (!ret || !s) return null;
    return mk(`${hostName} → ${ret.name}`, -60, 12, "dB", () => s.level,
      (v) => ({ action: "send_set", slug: S.slug, track: hostId, to: p[3], level: v }));
  }
  if (p[2] === "ins") {
    const ins = (host.inserts || []).find((i) => i.id === p[3]);
    const pname = p[4];
    const spec = RACK.devices?.[ins?.type]?.params?.[pname];
    if (!ins || !spec) return null;
    return mk(`${hostName} · ${RACK.devices[ins.type].label} · ${pname}`,
      spec.min, spec.max, spec.unit || "", () => ins.params[pname],
      (v) => ({ action: "insert_set", slug: S.slug, target, insert: ins.id, params: { [pname]: v } }));
  }
  return null;
}

/** Every parameter that could carry a lane on the current selection. */
function automatables() {
  const out = [];
  if (!S.proj) return out;
  const push = (kind, host, prefix) => {
    out.push(`${kind}:${host.id || "master"}:fader`);
    if (kind !== "mst") out.push(`${kind}:${host.id}:pan`);
    for (const s of host.sends || []) out.push(`${kind}:${host.id}:send:${s.to}`);
    for (const i of host.inserts || []) {
      for (const [pn, spec] of Object.entries(RACK.devices?.[i.type]?.params || {})) {
        if (spec.type === "number" && spec.animatable !== false) out.push(`${kind}:${host.id}:ins:${i.id}:${pn}`);
      }
    }
  };
  const t = selTrack();
  if (t) push("trk", t);
  for (const r of S.proj.returns || []) push("ret", r);
  push("mst", { ...S.proj.master, id: "master", sends: [] });
  return out;
}

function toggleLane(key) {
  const i = S.lanes.indexOf(key);
  if (i >= 0) S.lanes.splice(i, 1); else S.lanes.push(key);
  S.laneCur = S.lanes.includes(key) ? key : (S.lanes[0] || null);
  drawAutoPane(); drawArr();
}

const autoCv = $("autoCanvas");
const autoG = autoCv.getContext("2d");

function drawAutoPane() {
  const list = $("autoList");
  const opts = automatables();
  list.innerHTML = "";
  const head = document.createElement("div");
  head.className = "d-autorow";
  head.innerHTML = `<span class="d-nm">Add a lane</span>`;
  const sel = document.createElement("select");
  sel.className = "d-sel";
  sel.innerHTML = `<option value="">choose a parameter…</option>`
    + opts.map((k) => `<option value="${k}">${laneRef(k)?.label ?? k}</option>`).join("");
  sel.addEventListener("change", () => { if (sel.value) toggleLane(sel.value); sel.value = ""; });
  head.appendChild(sel);
  list.appendChild(head);

  for (const key of S.lanes) {
    const ref = laneRef(key);
    if (!ref) continue;
    const row = document.createElement("div");
    row.className = "d-autorow" + (key === S.laneCur ? " d-cur" : "");
    const keys = ref.keys();
    row.innerHTML = `<span class="d-nm">${ref.label}</span>`
      + `<span class="d-keys">${keys.length ? `${keys.length} keys` : `static ${fmt(ref.plain())}${ref.unit}`}</span>`;
    const edit = document.createElement("button");
    edit.className = "d-btn d-sm"; edit.textContent = "edit";
    edit.addEventListener("click", () => { S.laneCur = key; drawAutoPane(); });
    const flat = document.createElement("button");
    flat.className = "d-btn d-sm"; flat.textContent = "flatten";
    flat.title = "drop the keys and keep the value at the playhead — the same action, a plain number";
    flat.addEventListener("click", () => flattenLane(key));
    const off = document.createElement("button");
    off.className = "d-btn d-sm"; off.textContent = "✕";
    off.addEventListener("click", () => toggleLane(key));
    row.append(edit, flat, off);
    list.appendChild(row);
  }
  drawAutoCanvas();
}

function drawAutoCanvas() {
  const ref = S.laneCur && laneRef(S.laneCur);
  const W = Math.ceil(totalQ() * S.arrPxq) + 40;
  const H = 190;
  fitCanvas(autoCv, W, H);
  const g = autoG;
  g.clearRect(0, 0, W, H);
  g.font = "10px monospace";
  if (!ref) {
    tint(g, C.ghost, 1, () => g.fillText("pick a parameter above — every automatable one is listed", 8, 22));
    return;
  }
  for (const r of S.timeline) {
    const x = r.qStart * S.arrPxq;
    tint(g, C.hair, 1, () => g.fillRect(x, 0, 1, H));
    tint(g, C.ghost, 1, () => g.fillText(`${r.bar}`, x + 3, 10));
  }
  const yOf = (v) => H - 16 - ((v - ref.min) / (ref.max - ref.min)) * (H - 30);
  // gridlines at min / unity-ish / max
  for (const v of [ref.min, (ref.min + ref.max) / 2, ref.max, 0].filter((v) => v >= ref.min && v <= ref.max)) {
    tint(g, C.hair, 0.8, () => g.fillRect(0, yOf(v), W, 1));
    tint(g, C.ghost, 1, () => g.fillText(`${fmt(v)}${ref.unit}`, 3, yOf(v) - 2));
  }
  const keys = ref.keys();
  g.beginPath();
  if (!keys.length) {
    const y = yOf(ref.plain());
    g.moveTo(0, y); g.lineTo(W, y);
  } else {
    keys.forEach((k, i) => {
      const x = qOfBarFloat(k.t) * S.arrPxq;
      if (i === 0) g.moveTo(0, yOf(k.v));
      g.lineTo(x, yOf(k.v));
      if (i === keys.length - 1) g.lineTo(W, yOf(k.v));
    });
  }
  tint(g, C.secondary, 1, () => { g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1; });
  for (const k of keys) {
    const x = qOfBarFloat(k.t) * S.arrPxq;
    tint(g, C.secondary, 1, () => g.fillRect(x - 3, yOf(k.v) - 3, 6, 6));
    tint(g, C.ink, 1, () => g.strokeRect(x - 3.5, yOf(k.v) - 3.5, 7, 7));
  }
  tint(g, C.warn, 1, () => g.fillRect(secondsToQ(projTime()) * S.arrPxq, 0, 1.5, H));
  tint(g, C.ghost, 1, () => g.fillText(
    `${ref.label} — click to add a breakpoint, drag to move, right-click to delete`, 8, H - 4));
}

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** Write a lane's keys through the parameter's own action. */
async function writeLane(ref, keys) {
  const sorted = [...keys].sort((a, b) => a.t - b.t)
    .map((k) => ({ t: Math.max(1, Number(k.t.toFixed(4))),
                   v: Math.max(ref.min, Math.min(ref.max, Number(k.v.toFixed(4)))) }));
  const before = ref.value();
  const body = ref.write(sorted.length ? { keys: sorted } : ref.plain());
  await act(body, ref.write(before), `${ref.label}: ${sorted.length} keys`);
}
async function flattenLane(key) {
  const ref = laneRef(key);
  if (!ref) return;
  const at = barFloatNow();
  await act(ref.write(evalKeys(ref, at)), ref.write(ref.value()), `${ref.label}: flattened`);
}
/** The keyframe evaluator's client mirror: linear between keys, held outside.
 * Used only for DRAWING, for the strip readouts and for flatten; the render
 * evaluates server-side, so this never decides what anything sounds like. */
function evalKeyList(keys, fallback, t) {
  if (!keys?.length) return fallback;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      return a.v + (b.v - a.v) * ((t - a.t) / Math.max(1e-9, b.t - a.t));
    }
  }
  return keys[keys.length - 1].v;
}
const evalKeys = (ref, t) => evalKeyList(ref.keys(), ref.plain(), t);

/** What a mixer value IS right now. An automated fader that reads its first
 * keyframe forever is a lying fader: the strip shows the value under the
 * playhead, which is the one the render would use there. */
const atNow = (v, def = 0) => (isKeyed(v)
  ? evalKeyList(v.keys, def, barFloatNow())
  : (Number.isFinite(Number(v)) ? Number(v) : def));

let autoDrag = null;
autoCv.addEventListener("contextmenu", (e) => e.preventDefault());
autoCv.addEventListener("pointerdown", async (e) => {
  const ref = S.laneCur && laneRef(S.laneCur);
  if (!ref) return;
  const box = autoCv.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  const H = autoCv.height;
  const vOf = (y) => ref.min + (1 - (y - 16) / (H - 30)) * (ref.max - ref.min);
  const keys = ref.keys().map((k) => ({ ...k }));
  const hitI = keys.findIndex((k) => Math.abs(qOfBarFloat(k.t) * S.arrPxq - px) < 6);
  if (e.button === 2) {
    if (hitI < 0) return;
    keys.splice(hitI, 1);
    await writeLane(ref, keys);
    return;
  }
  if (hitI >= 0) {
    autoDrag = { ref, keys, i: hitI };
    capturePointer(autoCv, e.pointerId);
    return;
  }
  keys.push({ t: barFloatOfQ(px / S.arrPxq), v: Math.max(ref.min, Math.min(ref.max, vOf(py))) });
  await writeLane(ref, keys);
});
autoCv.addEventListener("pointermove", (e) => {
  if (!autoDrag) return;
  const box = autoCv.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  const { ref, keys, i } = autoDrag;
  const H = autoCv.height;
  keys[i] = { t: Math.max(1, barFloatOfQ(px / S.arrPxq)),
              v: Math.max(ref.min, Math.min(ref.max, ref.min + (1 - (py - 16) / (H - 30)) * (ref.max - ref.min))) };
  // preview only — the write happens on release, one action per gesture
  const g = autoG;
  drawAutoCanvasPreview(keys);
});
function drawAutoCanvasPreview(keys) {
  const ref = laneRef(S.laneCur);
  if (!ref) return;
  const saved = ref.value();
  const g = autoG;
  drawAutoCanvas();
  const H = autoCv.height;
  const yOf = (v) => H - 16 - ((v - ref.min) / (ref.max - ref.min)) * (H - 30);
  g.beginPath();
  [...keys].sort((a, b) => a.t - b.t).forEach((k, i, arr) => {
    const x = qOfBarFloat(k.t) * S.arrPxq;
    if (i === 0) g.moveTo(0, yOf(k.v));
    g.lineTo(x, yOf(k.v));
    if (i === arr.length - 1) g.lineTo(autoCv.width, yOf(k.v));
  });
  tint(g, C.ink, 0.8, () => g.stroke());
  void saved;
}
autoCv.addEventListener("pointerup", async (e) => {
  const d = autoDrag; autoDrag = null;
  if (!d) return;
  releasePointer(autoCv, e.pointerId);
  await writeLane(d.ref, d.keys);
});

/** A click on an arrangement lane strip: add / move a breakpoint in place. */
async function laneClick(row, q, dy, h, e) {
  const ref = laneRef(row.key);
  if (!ref) return;
  S.laneCur = row.key;
  const keys = ref.keys().map((k) => ({ ...k }));
  const v = ref.min + (1 - (dy - 4) / (h - 12)) * (ref.max - ref.min);
  if (e.button === 2) {
    const i = keys.findIndex((k) => Math.abs(qOfBarFloat(k.t) - q) * S.arrPxq < 6);
    if (i < 0) return;
    keys.splice(i, 1);
  } else {
    keys.push({ t: barFloatOfQ(q), v: Math.max(ref.min, Math.min(ref.max, v)) });
  }
  await writeLane(ref, keys);
}

$("tabRoll").addEventListener("click", () => showPane("roll"));
$("tabAuto").addEventListener("click", () => showPane("auto"));
function showPane(p) {
  $("tabRoll").classList.toggle("d-on", p === "roll");
  $("tabAuto").classList.toggle("d-on", p === "auto");
  $("paneRoll").classList.toggle("d-on", p === "roll");
  $("paneAuto").classList.toggle("d-on", p === "auto");
  if (p === "auto") drawAutoPane(); else draw();
}

/* ═════════════════════════════════════════════════════ THE RACK ═════════
 * The device strip is CATALOG-DRIVEN: every control below is generated from
 * GET /api/daw/rack, which serves rack.py's own table (labels, ranges, units,
 * `why`, and whether a parameter can be keyframed). Nothing here hard-codes a
 * parameter name; adding a device to rack.py grows this panel for free. */

const RACK = { devices: null, agree: null };

async function loadRack() {
  try {
    const r = await get("/api/daw/rack");
    RACK.devices = r.catalog?.devices || r.store || null;
    RACK.agree = r.tables_agree;
    RACK.problems = r.problems || [];
  } catch (err) {
    RACK.devices = null;
    status(`rack catalog unavailable: ${err.message}`);
  }
  const sel = $("devAdd");
  sel.innerHTML = `<option value="">＋ insert…</option>`
    + Object.entries(RACK.devices || {}).map(([id, d]) => `<option value="${id}">${d.label || id}</option>`).join("");
  /* A CATALOG DISAGREEMENT HAS ONE CAUSE IN PRACTICE.
   * mixer.js (the store's device table) and rack.py (the engine's) are
   * read from the same tree, so they only differ when the running server
   * loaded its JS before someone changed the Python beside it — i.e. the
   * process is older than the disk. The old line printed the raw diff
   * ("eq.stereo_mode: only on one side; …") which is evidence, not an
   * answer, and taught nobody what to do. Say the cause; keep the diff for
   * whoever is actually debugging the rack. */
  const dn = $("devNote");
  dn.textContent = "";
  if (RACK.agree === false) {
    const det = document.createElement("details");
    det.className = "d-catmis";
    const sum = document.createElement("summary");
    sum.textContent = "⚠ the server is running older code than the engine on disk — restart the studio.";
    const body = document.createElement("div");
    body.className = "d-catdiff";
    body.textContent = RACK.problems.join("; ");
    det.append(sum, body);
    dn.appendChild(det);
  } else if (RACK.agree === true) {
    dn.textContent = "engine ⇄ store catalogs agree";
  }
}

function chainHost() {
  const t = S.devTarget;
  if (!t || !S.proj) return null;
  if (t.kind === "master") return { host: S.proj.master, name: "Master", target: "master" };
  if (t.kind === "return") {
    const r = (S.proj.returns || []).find((x) => x.id === t.id);
    return r ? { host: r, name: r.name, target: r.id } : null;
  }
  const tr = S.proj.tracks.find((x) => x.id === t.id);
  return tr ? { host: tr, name: tr.name, target: tr.id } : null;
}

function drawDevices() {
  const box = $("devChain");
  box.innerHTML = "";
  const h = chainHost();
  $("devTarget").textContent = h ? h.name : "—";
  if (!h) return;
  const inserts = h.host.inserts || [];
  if (!inserts.length) {
    const empty = document.createElement("div");
    empty.className = "d-note";
    empty.style.padding = "10px";
    empty.innerHTML = `No inserts on <b>${h.name}</b>. Add one from the picker above — `
      + `every device is the engine's own, and its parameters are drawn from the served catalog.`;
    box.appendChild(empty);
    return;
  }
  inserts.forEach((ins, idx) => {
    const spec = RACK.devices?.[ins.type];
    if (idx) {
      /* THE CHAIN, READ LEFT TO RIGHT. The order of a chain is the whole
       * of what it does, so it gets an arrow rather than a gap. */
      const flow = document.createElement("div");
      flow.className = "d-flow";
      flow.textContent = "▸";
      flow.title = `${RACK.devices?.[inserts[idx - 1].type]?.label || inserts[idx - 1].type}`
        + ` feeds ${spec?.label || ins.type}`;
      box.appendChild(flow);
    }
    const card = document.createElement("div");
    card.className = "d-dev" + (ins.enabled ? "" : " d-bypass")
      + (S.devInsert === ins.id ? " d-cur" : "");
    const head = document.createElement("div");
    head.className = "d-devhead";
    head.innerHTML = `<span class="d-ix" title="position in the chain">${idx + 1}</span>`
      + `<span class="d-nm">${spec?.label || ins.type}</span>`;
    const mkBtn = (txt, title, fn) => {
      const b = document.createElement("button");
      b.className = "d-btn d-sm"; b.textContent = txt; b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    head.append(
      mkBtn(ins.enabled ? "on" : "off", "bypass (insert_set enabled)", () =>
        act({ action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, enabled: !ins.enabled },
          { action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, enabled: ins.enabled },
          `${ins.type} ${ins.enabled ? "bypassed" : "enabled"}`)),
      mkBtn("◀", "move earlier in the chain (insert_set index)", () =>
        act({ action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, index: Math.max(0, idx - 1) },
          { action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, index: idx }, "reorder")),
      mkBtn("▶", "move later in the chain", () =>
        act({ action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, index: idx + 1 },
          { action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, index: idx }, "reorder")),
      mkBtn("✕", "remove (insert_remove)", () =>
        act({ action: "insert_remove", slug: S.slug, target: h.target, insert: ins.id },
          { action: "insert_add", slug: S.slug, target: h.target, type: ins.type,
            index: idx, params: plainParams(ins.params) },
          `remove ${ins.type}`)),
    );
    if (ins.enabled) head.querySelector(".d-btn").classList.add("d-on");
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "d-devbody";
    if (spec?.why) {
      const why = document.createElement("div");
      why.className = "d-why"; why.textContent = spec.why;
      body.appendChild(why);
    }
    /* THE RESPONSE CURVE. Not "the EQ's curve" — no device is named here.
     * Any insert the server can answer a magnitude response for gets one,
     * and the answer is the SERVER's own, so what is drawn is what the
     * render does rather than a client-side re-implementation of it that
     * would drift the first time a filter changed. */
    const curve = document.createElement("canvas");
    curve.className = "d-curve";                 /* its height is CSS's now */
    curve.title = "the device's magnitude response, measured by the engine (device_response)";
    body.appendChild(curve);
    const note = document.createElement("div");
    note.className = "d-curvenote";
    body.appendChild(note);
    wantCurve(h, ins, curve, note);

    for (const [pname, pspec] of Object.entries(spec?.params || {})) {
      body.appendChild(paramControl(h, ins, pname, pspec));
    }
    card.appendChild(body);
    card.addEventListener("pointerdown", () => { S.devInsert = ins.id; }, true);
    box.appendChild(card);
  });
}

/** Keyed params can't ride back into insert_add; take their first value. */
const plainParams = (params) => Object.fromEntries(Object.entries(params || {})
  .map(([k, v]) => [k, isKeyed(v) ? (v.keys[0]?.v ?? 0) : v]));

/* ── the device response curve ───────────────────────────────────────────
 * A mastering-capable EQ with no visible curve is a column of numbers you
 * are asked to hear in your head — the owner's fourth complaint, and the
 * fair one. The magnitude response is asked of the SERVER (device_response,
 * landing on a concurrent branch); nothing here models a filter.
 *
 * Every shape the endpoint might reasonably answer in is accepted, because
 * guessing wrong about a key name should not cost a display:
 *     { freq: [Hz…], db: [dB…] }
 *     { curve: [[hz, db], …] }        { points: [{ hz, db }, …] }
 *     { response: { freq, db } }
 * Anything else, or no endpoint at all, prints what it is waiting for. */

function curvePoints(r) {
  if (!r) return null;
  const R = r.response || r;
  if (Array.isArray(R.freq) && Array.isArray(R.db)) {
    return R.freq.map((f, i) => [f, R.db[i]]).filter((p) => Number.isFinite(p[1]));
  }
  if (Array.isArray(R.curve)) {
    return R.curve.map((p) => (Array.isArray(p) ? p : [p.hz ?? p.freq, p.db]))
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }
  if (Array.isArray(R.points)) {
    return R.points.map((p) => [p.hz ?? p.freq, p.db ?? p.gain_db])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }
  return null;
}

const curveJobs = new Set();
async function wantCurve(h, ins, cv, note) {
  const key = `${h.target}:${ins.id}:${JSON.stringify(plainParams(ins.params))}`;
  const cached = S.ana.curves.get(key);
  if (cached !== undefined) { drawCurve(cv, note, cached); return; }
  drawCurve(cv, note, undefined);                     // "asking…"
  if (curveJobs.has(key)) return;
  curveJobs.add(key);
  try {
    const r = await tryDeferred(DEFERRED.response,
      { slug: S.slug, target: h.target, insert: ins.id, points: 240 });
    const pts = curvePoints(r);
    S.ana.curves.set(key, pts && pts.length ? pts : null);
    if (S.ana.curves.size > 60) S.ana.curves.delete(S.ana.curves.keys().next().value);
    drawCurve(cv, note, S.ana.curves.get(key));
  } catch (err) {
    S.ana.curves.set(key, null);
    drawCurve(cv, note, null, err.message);
  } finally { curveJobs.delete(key); }
}

/** pts === undefined → asking · null → no curve for this device · [] → draw */
function drawCurve(cv, note, pts, err) {
  /* Un-hide BEFORE measuring: fitLive reads the live box, and a display:none
   * canvas measures zero — which would pin the next visible curve to the
   * fallback size instead of its real one. */
  cv.style.display = "";
  /* the box is CSS's (.d-curve carries the height); this only fixes the
   * bitmap to it at device resolution. */
  const { g, w, h } = fitLive(cv, 80, 40);
  g.clearRect(0, 0, w, h);
  if (!pts) {
    cv.style.display = "none";
    note.textContent = pts === undefined ? "response: asking the engine…"
      : err ? `response: ${err}`
      : DEFER_OK.get(DEFERRED.response) === false
        ? deferredNote(DEFERRED.response)
        : "this device reports no magnitude response";
    return;
  }
  cv.style.display = "";
  note.textContent = `magnitude response · ${pts.length} points · measured by the engine`;
  g.font = "8px monospace";
  const F0 = 20, F1 = 20000;
  const xOf = (f) => (Math.log10(Math.max(F0, Math.min(F1, f))) - Math.log10(F0))
    / (Math.log10(F1) - Math.log10(F0)) * w;
  let lo = 0, hi = 0;
  for (const [, db] of pts) { lo = Math.min(lo, db); hi = Math.max(hi, db); }
  const span = Math.max(6, Math.ceil(Math.max(Math.abs(lo), Math.abs(hi)) / 6) * 6);
  const yOf = (db) => h / 2 - (db / span) * (h / 2 - 6);
  for (const f of [100, 1000, 10000]) {
    tint(g, C.hair, 1, () => g.fillRect(xOf(f), 0, 1, h));
    tint(g, C.ghost, 1, () => g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, xOf(f) + 2, h - 2));
  }
  for (const db of [span, span / 2, 0, -span / 2, -span]) {
    tint(g, db === 0 ? C.edge : C.hair, 1, () => g.fillRect(0, yOf(db), w, 1));
    tint(g, C.ghost, 1, () => g.fillText(`${db > 0 ? "+" : ""}${db}`, 2, yOf(db) - 1));
  }
  tint(g, C.primary, 1, () => {
    g.lineWidth = 1.6;
    g.beginPath();
    pts.forEach(([f, db], i) => (i ? g.lineTo(xOf(f), yOf(db)) : g.moveTo(xOf(f), yOf(db))));
    g.stroke();
    g.lineWidth = 1;
  });
}

function paramControl(h, ins, pname, pspec) {
  const wrap = document.createElement("div");
  wrap.className = "d-param";
  const raw = ins.params[pname];
  const keyed = isKeyed(raw);
  if (keyed) wrap.classList.add("d-keyed");
  const lab = document.createElement("div");
  lab.className = "d-plab";
  lab.textContent = pname.replace(/_/g, " ");
  lab.title = `${pspec.desc || pname}${pspec.unit ? ` (${pspec.unit})` : ""}`
    + (pspec.animatable ? " — automatable" : "");

  if (pspec.type === "bool") {
    const t = document.createElement("div");
    t.className = "d-toggle" + (raw ? " d-on" : "");
    t.innerHTML = "<i></i>";
    t.addEventListener("click", () => setParam(h, ins, pname, !raw, !!raw));
    wrap.append(t, lab);
    return wrap;
  }
  if (pspec.type === "enum" || pspec.type === "track") {
    wrap.classList.add("d-wide");
    const s = document.createElement("select");
    s.className = "d-sel";
    const values = pspec.type === "enum" ? pspec.values
      : ["", ...(S.proj?.tracks || []).map((t) => t.id)];
    s.innerHTML = values.map((v) => {
      const label = pspec.type === "track"
        ? (v ? (S.proj.tracks.find((t) => t.id === v)?.name ?? v) : "— none —") : v;
      return `<option value="${v}"${v === raw ? " selected" : ""}>${label}</option>`;
    }).join("");
    s.addEventListener("change", () => setParam(h, ins, pname, s.value, raw));
    wrap.append(s, lab);
    return wrap;
  }

  // number → a knob, dragged vertically; shift = fine; double-click = default
  const v = keyed ? atNow(raw, pspec.default) : Number(raw);
  const k = document.createElement("div");
  k.className = "d-knob" + (keyed ? " d-keyed" : "");
  const val = document.createElement("div");
  val.className = "d-pval";
  const norm = (x) => (x - pspec.min) / (pspec.max - pspec.min);
  const paint = (x) => {
    k.style.setProperty("--d-k", `${norm(x) * 0.75}turn`);
    k.style.setProperty("--d-ka", `${-140 + norm(x) * 280}deg`);
    val.textContent = `${fmt(x)}${pspec.unit ? ` ${pspec.unit}` : ""}`;
  };
  paint(v);
  let drag = null;
  k.addEventListener("pointerdown", (e) => {
    drag = { y: e.clientY, v0: v, cur: v, ride: [] };
    S.dragging = true;
    capturePointer(k, e.pointerId);
  });
  k.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const span = pspec.max - pspec.min;
    const step = span / (e.shiftKey ? 900 : 180);
    drag.cur = Math.max(pspec.min, Math.min(pspec.max, drag.cur - (e.clientY - drag.y) * step));
    drag.y = e.clientY;
    paint(drag.cur);
    if (S.autoWrite && S.playing) drag.ride.push({ t: barFloatNow(), v: drag.cur });
  });
  k.addEventListener("pointerup", async (e) => {
    const d = drag; drag = null;
    S.dragging = false;
    if (!d) return;
    releasePointer(k, e.pointerId);
    if (S.autoWrite && d.ride.length > 1) {
      const key = `${h.target === "master" ? "mst:master" : (h.host.id ? (S.proj.returns || []).some((r) => r.id === h.host.id) ? `ret:${h.host.id}` : `trk:${h.host.id}` : "mst:master")}:ins:${ins.id}:${pname}`;
      const ref = laneRef(key);
      if (ref) { await writeRide(ref, d.ride); return; }
    }
    await setParam(h, ins, pname, d.cur, d.v0);
  });
  k.addEventListener("dblclick", () => setParam(h, ins, pname, pspec.default, v));
  wrap.append(k, val, lab);
  return wrap;
}

const setParam = (h, ins, pname, value, before) => act(
  { action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, params: { [pname]: value } },
  { action: "insert_set", slug: S.slug, target: h.target, insert: ins.id, params: { [pname]: before } },
  `${ins.type}.${pname} → ${typeof value === "number" ? fmt(value) : value}`);

$("devAdd").addEventListener("change", async () => {
  const type = $("devAdd").value;
  $("devAdd").value = "";
  const h = chainHost();
  if (!type || !h) return;
  const r = await act({ action: "insert_add", slug: S.slug, target: h.target, type }, null, `add ${type}`);
  if (r?.insertId) {
    pushUndo({ body: { action: "insert_remove", slug: S.slug, target: h.target, insert: r.insertId },
               forward: { action: "insert_add", slug: S.slug, target: h.target, type },
               inverseFrom: (rr) => ({ body: { action: "insert_remove", slug: S.slug,
                                               target: h.target, insert: rr?.insertId } }),
               label: `add ${type}` });
    S.devInsert = r.insertId;
  }
});

/* ═══════════════════════════════════════════════════ THE MIXER ══════════
 * Channel strips with a real dB-law fader, pan, sends, solo/mute/arm.
 *
 * THE FADER LAW, written down because a fader with a linear-in-dB taper
 * feels wrong to everyone who has touched a console: travel expands near
 * unity. Four piecewise segments over [-60, +12] dB with 0 dB at 75 % of the
 * throw — the top quarter carries 12 dB, the next 35 % carries 20, and the
 * bottom two bands carry 20 each. Monotonic, exactly invertible, and pinned
 * by server/daw/ui_test.js so a "tidy-up" cannot quietly linearise it.
 *
 * THE METERS. Two kinds, labelled as such, because one of them cannot exist:
 *  · MASTER is live and ballistic — it reads the samples this page is
 *    actually playing (an AnalyserNode on the master bus), 20 dB/s decay
 *    with a 1.5 s peak hold.
 *  · PER-TRACK is MEASURED, not live: the browser only ever receives the
 *    mixed master, so a per-track meter that moved during playback would be
 *    invented. "measure" runs the engine's own `meters` over the visible bar
 *    range and shows peak / RMS / LUFS. The UI says which is which.
 */

const FADER_SEGS = [
  [0.00, 0.15, -60, -40],
  [0.15, 0.40, -40, -20],
  [0.40, 0.75, -20, 0],
  [0.75, 1.00, 0, 12],
];
function posToDb(pos) {
  const p = Math.max(0, Math.min(1, pos));
  for (const [p0, p1, d0, d1] of FADER_SEGS) {
    if (p <= p1 || p1 === 1) return d0 + (d1 - d0) * (p - p0) / (p1 - p0);
  }
  return 12;
}
function dbToPos(db) {
  const d = Math.max(-60, Math.min(12, db));
  for (const [p0, p1, d0, d1] of FADER_SEGS) {
    if (d <= d1 || d1 === 12) return p0 + (p1 - p0) * (d - d0) / (d1 - d0);
  }
  return 1;
}

/**
 * THE MASTER IS PINNED. The strips scroll in #mixStrips; the master lives
 * in #mixMaster beside them and never moves. The old single scroller put
 * the one bus you always need at the far right of a list that grows with
 * every track, so the master was the first thing the window edge ate.
 */
function drawMixer() {
  const box = $("mixStrips");
  const pin = $("mixMaster");
  box.innerHTML = "";
  pin.innerHTML = "";
  S.paint = [];
  if (!S.proj) return;
  for (const t of S.proj.tracks) box.appendChild(strip("track", t));
  for (const r of S.proj.returns || []) box.appendChild(strip("return", r));
  pin.appendChild(strip("master", { ...S.proj.master, id: "master", name: "Master" }));
  layoutMixer();
  /* The readout counts strips and measures a fader, so it can only be true once
   * both exist: applyViewFromDoc() runs while the mixer is still empty (it has
   * to — the boxes it sizes are what the strips are then drawn into), and on its
   * own it would leave the strip count permanently blank on a fresh load. */
  paintViewNum();
}

/**
 * The tallest fader every strip's own container can hold, or Infinity when
 * there is nothing measurable to hold it.
 *
 * A strip is its content: chrome (name, patch line, pan, sends, the three
 * buttons) plus the fader row. Subtract the chrome from the room the container
 * gives, and that is what the fader may have. The container is .d-strips for a
 * track and .d-mixpin for the master, and each has its own padding — read, not
 * assumed, because the two differ and a wrong constant here is a strip clipped
 * by a few pixels, which reads as a rendering bug rather than as a bound.
 *
 * clientHeight already excludes the horizontal scrollbar, so the deck's own
 * scroller is paid for without a second measurement.
 */
function fadRoom(rows) {
  let room = Infinity;
  for (const [strip, row] of rows) {
    const host = strip.parentElement;
    if (!host) continue;
    const cs = getComputedStyle(host);
    const inner = host.clientHeight
      - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    if (!(inner > 0)) continue;          // cannot see the box: no measurement
    room = Math.min(room, inner - (strip.offsetHeight - row.offsetHeight));
  }
  return room;
}

/* ── the mixer's geometry ────────────────────────────────────────────────
 * Runs after the strips are in the document, because all three things it
 * does need a real box: every meter must be the SAME height (one shared
 * scale can only be honest if the bars it labels line up), each meter's
 * bitmap is then fitted to that box at device resolution, and the gutter's
 * scale is positioned against the meters it describes.
 *
 * The master strip carries less below its fader than a track does (no pan,
 * no sends), so equal meter heights are bought by giving every fadrow the
 * height the BUSIEST strip can afford. The slack lands under the master —
 * which is what a console looks like anyway.
 */
function layoutMixer() {
  const box = $("mixStrips"), pin = $("mixMaster"), cv = $("mixScale");
  /* A HIDDEN MIXER HAS NO BOX TO MEASURE. Folding the column and then
   * doing anything that relayouts (a resize, an agent's edit) used to read
   * every strip as zero-height, clamp the fadrows to the 90 px floor and
   * PIN them there — so unfolding gave back a mixer whose meters had
   * permanently shrunk from 705 px to 90. Measure only what is on screen. */
  if (!box.offsetParent && !pin.offsetParent) return;
  const strips = [...box.children, ...pin.children];
  if (!strips.length) { cv.style.display = "none"; return; }

  const rows = [];
  for (const s of strips) {
    const row = s.querySelector(".d-fadrow");
    if (row) { row.style.flex = ""; row.style.height = ""; rows.push([s, row]); }
  }
  if (!rows.length) { cv.style.display = "none"; return; }

  /* With the inline height cleared above, each fadrow is back to flex:1 and
   * has grown into whatever its own strip had spare. The SMALLEST of those
   * is the only height every strip can afford — the master's box is taller
   * than a scroller strip's (the scroller spends rows on its scrollbar) and
   * a track's chrome is deeper than the master's, so the minimum is what
   * makes one shared scale true for all of them. */
  let fadH = Infinity;
  for (const [, row] of rows) fadH = Math.min(fadH, row.offsetHeight);
  /* ⚠ A FLOOR AND NO CEILING IS WHAT MADE THE FADER 600px. `.d-fadrow` is
   * flex:1 1 auto inside a strip that `.d-strips` stretches to the column's
   * full height, so it absorbs every spare pixel and this line pinned the
   * result. Nothing asked for it; it was residue. Measured in a 1920x889
   * window with nine tracks: 600px, 67% of the window.
   *
   * ⚠ AND THE CEILING HAS TO BE HERE, NOT IN THE STYLESHEET. The loop below
   * fits every meter canvas to fadH and paintScale() draws the shared dB
   * gutter for it; a CSS-only cap would leave oversized canvases in a short
   * box and a scale whose numbers no longer land on the fader they describe.
   *
   * The floor rises 90 -> 108 to agree with .d-fadrow's own min-height: below
   * about 110px the nine dB labels at 9px collide. The ceiling is a TOKEN so a
   * layout preset can change it in one place — a deck mixer wants a shorter
   * fader than a side column does. 180 is Ableton's, chosen out of the bracket
   * (Reaper ~160, Ableton ~180, Logic ~200); it is a taste choice and it is
   * meant to be easy to change. */
  /* ⚠ READ THE TOKEN OFF THE ELEMENT THAT DECLARES IT. This asked
   * document.documentElement for `--d-fader-h`, and daw.css declares it on
   * .d-shell: custom properties inherit DOWNWARD, so <html> never had one, the
   * parse was NaN and the fallback 180 was the only ceiling this function ever
   * used. Nothing looked wrong because 180 is also the default — but it made
   * the token a control that appeared to work and did nothing, which is exactly
   * what a preset needs it for (the deck's fader is 132). */
  const capRaw = parseFloat(getComputedStyle($("shell")).getPropertyValue("--d-fader-h"));
  const cap = Number.isFinite(capRaw) && capRaw >= 108 ? capRaw : 180;
  /* ⚠ AND A TOKEN IS NOT THE ONLY CEILING: THE BOX IS ONE TOO. A strip is
   * content-height (.d-strips is align-items:flex-start), so a 320px fader makes
   * a 410px strip whatever the mixer's box measures — and .d-strip is
   * overflow:hidden, so in a 300px deck the solo/mute/arm row lands below the
   * visible edge where it cannot be clicked. Not ugly: unusable. So the fader is
   * also capped by the room the strip's own container actually has.
   *
   * ⚠ AND "NO ROOM" MUST NOT MEAN "A TINY BOX". A hidden or not-yet-laid-out
   * container measures zero, and a zero here would clamp every fader to the
   * 108px floor and PIN it — the same failure the offsetParent guard at the top
   * of this function was written for, arriving by a different door. fadRoom()
   * returns Infinity for a box it cannot see, which is the honest answer:
   * "no measurement", not "no space". */
  fadH = Math.max(108, Math.round(Math.min(cap, fadRoom(rows), fadH)));
  for (const [, row] of rows) row.style.flex = `0 0 ${fadH}px`;

  for (const [, row] of rows) {
    const met = row.querySelector(".d-meterc");
    if (!met) continue;
    fitCanvas(met, MTR_W, fadH);
    if (met === S.masterMeterEl) meterTick(); else paintMeter(met, met._row);
  }

  const ref = rows[0][1].querySelector(".d-meterc");
  if (!ref) { cv.style.display = "none"; return; }
  cv.style.display = "block";
  const wrapTop = cv.parentElement.getBoundingClientRect().top;
  cv.style.top = `${Math.round(ref.getBoundingClientRect().top - wrapTop)}px`;
  paintScale(cv, fadH);
}

function strip(kind, host) {
  const target = kind === "master" ? "master" : host.id;
  const el = document.createElement("div");
  el.className = "d-strip" + (kind === "master" ? " d-master" : "")
    + (S.devTarget?.id === target ? " d-cur" : "");
  if (kind === "track") el.style.setProperty("--d-trk", colourOf(host.id));
  const name = document.createElement("div");
  name.className = "d-snm";
  name.textContent = host.name;
  name.title = "click to point the device strip at this chain"
    + (kind === "track" ? " · double-click to rename (set_track)" : "");
  name.addEventListener("click", () => {
    S.devTarget = { kind, id: target };
    showDock("chain");
    if (kind === "track") selectTrack(host.id); else { drawMixer(); drawDevices(); }
  });
  if (kind === "track") name.addEventListener("dblclick", () => renameTrack(host));
  el.appendChild(name);

  const sub = document.createElement("div");
  sub.className = "d-sub";
  sub.textContent = `${(host.inserts || []).length} fx`
    + (kind === "track" ? ` · ${host.instrument?.patch ?? ""}` : "");
  el.appendChild(sub);

  // fader + meter
  const row = document.createElement("div");
  row.className = "d-fadrow";
  const keyed = isKeyed(host.fader);
  const db = atNow(host.fader);
  const fad = document.createElement("div");
  fad.className = "d-fader" + (keyed ? " d-auto" : "");
  fad.style.setProperty("--d-unity", `${(1 - dbToPos(0)) * 100}%`);
  fad.innerHTML = `<div class="d-fill"></div><div class="d-cap"></div>`;
  /* THE NUMBER. A fader you can only read by eye is a fader you cannot
   * set: this prints the dB to one decimal and accepts a typed one. */
  const val = document.createElement("div");
  val.className = "d-fadval" + (keyed ? " d-auto" : "");
  val.title = "the fader in dB — click to type an exact value (mixer_set)";
  const paint = (x) => {
    const p = dbToPos(x);
    fad.querySelector(".d-cap").style.top = `${(1 - p) * 100}%`;
    fad.querySelector(".d-fill").style.height = `${p * 100}%`;
    const sign = Math.abs(x) < 0.05 ? "" : x > 0 ? "+" : "";
    val.innerHTML = `${keyed ? "~" : ""}${sign}${x.toFixed(1)}<small>dB</small>`;
  };
  paint(db);
  if (keyed) S.paint.push(() => paint(atNow(host.fader)));
  wireFader(fad, kind, host, target, db, paint);
  val.addEventListener("click", async () => {
    const now = atNow(host.fader);
    const typed = (await appPrompt(`${host.name} fader, dB (−60 … +12)`, now.toFixed(1)));
    if (typed === null) return;
    const v = Number(typed);
    if (!Number.isFinite(v)) { status(`"${typed}" is not a number`); return; }
    const c = Math.max(-60, Math.min(12, v));
    act({ action: "mixer_set", slug: S.slug, target, fader: c },
      { action: "mixer_set", slug: S.slug, target, fader: now },
      `${host.name} fader ${c.toFixed(1)} dB`);
  });

  const met = document.createElement("canvas");
  met.className = "d-meterc";
  met.title = kind === "master"
    ? "live peak from the audio this page is playing — 20 dB/s decay, 1.5 s peak hold"
    : "measured, not live: press ‘measure’ to run the engine's own metering over the visible bars";
  /* The row it will be measured against is stashed on the element: the
   * meters are SIZED AND PAINTED after the strips are in the document
   * (layoutMixer), because a canvas that is not laid out yet has no box to
   * fit its bitmap to. */
  met._row = kind === "master" ? null : S.meters?.[kind === "return" ? "returns" : "tracks"]?.[host.id];
  if (kind === "master") S.masterMeterEl = met;
  /* THE SCALE used to be a canvas PER STRIP — nine copies of the same nine
   * numbers, 20 px of strip width each, and the thing the owner read as
   * "doubled". There is one now, in the gutter between the scroller and the
   * pinned master, where it reads for both. */
  row.append(met, fad);
  el.append(row, val);

  // pan (not on the master — it is the room)
  if (kind !== "master") {
    const pk = isKeyed(host.pan);
    const pv = atNow(host.pan);
    const pan = document.createElement("div");
    pan.className = "d-pan" + (pk ? " d-auto" : "");
    pan.innerHTML = "<i></i>";
    pan.title = `pan ${pv.toFixed(2)} — equal-power, centre-unity`;
    const pi = pan.querySelector("i");
    const pval = document.createElement("div");
    pval.className = "d-panval";
    const panWord = (x) => (Math.abs(x) < 0.005 ? "C"
      : `${x < 0 ? "L" : "R"}${Math.round(Math.abs(x) * 100)}`);
    const ppaint = (x) => {
      pi.style.left = `${(x + 1) / 2 * 100}%`;
      pan.title = `pan ${x.toFixed(2)}`;
      pval.textContent = panWord(x);
    };
    ppaint(pv);
    if (pk) S.paint.push(() => ppaint(atNow(host.pan)));
    wireBar(pan, pv, -1, 1, ppaint,
      (v, before) => act({ action: "mixer_set", slug: S.slug, target, pan: v },
        { action: "mixer_set", slug: S.slug, target, pan: before }, `${host.name} pan ${v.toFixed(2)}`),
      () => `${kind === "return" ? "ret" : "trk"}:${host.id}:pan`);
    el.append(pan, pval);
  }

  // sends (tracks only)
  if (kind === "track" && (S.proj.returns || []).length) {
    const sends = document.createElement("div");
    sends.className = "d-sends";
    for (const ret of S.proj.returns) {
      const s = (host.sends || []).find((x) => x.to === ret.id);
      const lv = s ? atNow(s.level) : -60;
      const rowEl = document.createElement("div");
      rowEl.className = "d-send";
      rowEl.innerHTML = `<span class="d-sname" title="${ret.name}">${ret.name.slice(0, 4)}</span>`;
      const bar = document.createElement("div");
      bar.className = "d-pan d-nodetent";
      bar.style.flex = "1 1 auto";
      bar.innerHTML = "<i></i>";
      const bi = bar.querySelector("i");
      const bpaint = (x) => { bi.style.left = `${dbToPos(x) * 100}%`; bar.title = `send ${x.toFixed(1)} dB`; };
      bpaint(lv);
      if (s && isKeyed(s.level)) S.paint.push(() => bpaint(atNow(s.level)));
      wireBar(bar, lv, -60, 12, bpaint,
        (v, before) => act({ action: "send_set", slug: S.slug, track: host.id, to: ret.id, level: v },
          { action: "send_set", slug: S.slug, track: host.id, to: ret.id, level: before },
          `${host.name} → ${ret.name} ${v.toFixed(1)} dB`),
        () => `trk:${host.id}:send:${ret.id}`, true);
      rowEl.appendChild(bar);
      /* The strip could ADD a send and never remove one — send_remove was
       * an agent-only action. A send at −60 dB is not a removed send: it is
       * still a row in the document and still a dependency in the graph. */
      if (s) {
        const x = document.createElement("button");
        x.className = "d-btn d-sm d-sx";
        x.textContent = "✕";
        x.title = `remove ${host.name} → ${ret.name} entirely (send_remove) — not the same as pulling it to −60`;
        x.addEventListener("click", () => act(
          { action: "send_remove", slug: S.slug, track: host.id, to: ret.id },
          { action: "send_set", slug: S.slug, track: host.id, to: ret.id, level: plainOf(s.level) },
          `removed ${host.name} → ${ret.name}`));
        rowEl.appendChild(x);
      }
      sends.appendChild(rowEl);
    }
    el.appendChild(sends);
  }

  // solo / mute / arm
  const btns = document.createElement("div");
  btns.className = "d-sbtns";
  const mk = (txt, cls, on, title, fn) => {
    const b = document.createElement("button");
    b.className = `d-btn d-sm ${cls}` + (on ? " d-on" : "");
    b.textContent = txt; b.title = title;
    b.addEventListener("click", fn);
    return b;
  };
  if (kind === "track") {
    btns.append(
      mk("S", "d-solo", host.solo, "solo (mixer_set)", () =>
        act({ action: "mixer_set", slug: S.slug, target, solo: !host.solo },
          { action: "mixer_set", slug: S.slug, target, solo: !!host.solo },
          `${host.name} solo ${host.solo ? "off" : "on"}`)),
      mk("M", "d-mute", host.mute, "mute (set_track)", () =>
        act({ action: "set_track", slug: S.slug, track: host.id, mute: !host.mute },
          { action: "set_track", slug: S.slug, track: host.id, mute: !!host.mute },
          `${host.name} mute ${host.mute ? "off" : "on"}`)),
      mk("●", host.armed ? "d-arm d-on" : "", false, "arm for recording (record_arm)", async () => {
        await api({ action: "record_arm", slug: S.slug, track: host.id, armed: !host.armed });
        await refreshDoc();
      }),
    );
  } else if (kind === "return") {
    btns.append(mk("✕", "", false, "remove this return (return_remove)", () =>
      act({ action: "return_remove", slug: S.slug, return: host.id }, null, `remove ${host.name}`)));
  }
  /* THE MASTER'S TWO SETTINGS (mixer_set target "master"): the rack's
   * stereo switch and the loudness the bounce aims at. A human's hand on
   * both, because an agent has them through daw_mixer op=set. */
  if (kind === "master") {
    const on = host.stereo === true;
    btns.append(mk("ST", "d-stereo", on,
      on ? "stereo ON: the rack renders each voice's own channels (mixer_set stereo) — off folds every voice to (L+R)/2, the byte-identical past; flipping re-renders every region"
         : "stereo OFF: every voice folds to (L+R)/2 before the first insert (mixer_set stereo) — on renders each voice's own channels; flipping re-renders every region",
      () => act({ action: "mixer_set", slug: S.slug, target: "master", stereo: !on },
        { action: "mixer_set", slug: S.slug, target: "master", stereo: on },
        `master stereo ${on ? "off" : "on"}`)));
    const tl = document.createElement("div");
    tl.className = "d-fadval d-lufs";
    const cur = host.target_lufs;
    tl.innerHTML = cur == null ? `<small>LUFS</small> off` : `${Number(cur).toFixed(1)}<small>LUFS</small>`;
    tl.title = "the loudness the BOUNCE aims at (mixer_set target_lufs): -8 club, -14 streaming, blank = off — the bounce reports reached or short";
    tl.addEventListener("click", async () => {
      const typed = (await appPrompt("bounce target, LUFS (−30 … −6; blank = off)", cur == null ? "" : String(cur)));
      if (typed === null) return;
      const v = typed.trim() === "" ? null : Number(typed);
      if (v !== null && !Number.isFinite(v)) { status(`"${typed}" is not a number`); return; }
      act({ action: "mixer_set", slug: S.slug, target: "master", target_lufs: v === null ? null : Math.max(-30, Math.min(-6, v)) },
        { action: "mixer_set", slug: S.slug, target: "master", target_lufs: cur ?? null },
        v === null ? "bounce target off" : `bounce target ${v} LUFS`);
    });
    btns.appendChild(tl);
  }
  el.appendChild(btns);
  return el;
}

/** The fader: drag with a unity detent, double-click to unity, and — while
 *  A-write is armed and the transport rolls — a RIDE that becomes keys. */
function wireFader(fad, kind, host, target, db0, paint) {
  let drag = null;
  fad.addEventListener("pointerdown", (e) => {
    const box = fad.getBoundingClientRect();
    drag = { db: db0, box, ride: [] };
    S.dragging = true;
    capturePointer(fad, e.pointerId);
    if (S.autoWrite && S.playing) fad.classList.add("d-writing");
  });
  fad.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = 1 - (e.clientY - drag.box.top) / drag.box.height;
    let db = posToDb(p);
    if (!e.shiftKey && Math.abs(db) < 0.7) db = 0;          // the unity detent
    drag.db = db;
    paint(db);
    if (S.autoWrite && S.playing) drag.ride.push({ t: barFloatNow(), v: db });
  });
  fad.addEventListener("pointerup", async (e) => {
    const d = drag; drag = null;
    S.dragging = false;
    fad.classList.remove("d-writing");
    if (!d) return;
    releasePointer(fad, e.pointerId);
    const key = `${kind === "master" ? "mst:master" : kind === "return" ? `ret:${host.id}` : `trk:${host.id}`}:fader`;
    if (S.autoWrite && d.ride.length > 1) {
      const ref = laneRef(key);
      if (ref) { await writeRide(ref, d.ride); return; }
    }
    await act({ action: "mixer_set", slug: S.slug, target, fader: d.db },
      { action: "mixer_set", slug: S.slug, target, fader: db0 },
      `${host.name} fader ${d.db.toFixed(1)} dB`);
  });
  fad.addEventListener("dblclick", () => act(
    { action: "mixer_set", slug: S.slug, target, fader: 0 },
    { action: "mixer_set", slug: S.slug, target, fader: db0 }, `${host.name} fader to unity`));
}

/** A horizontal bar control (pan, sends). Same ride behaviour. */
function wireBar(el, v0, min, max, paint, commit, keyOf, dbLaw = false) {
  let drag = null;
  el.addEventListener("pointerdown", (e) => {
    const box = el.getBoundingClientRect();
    drag = { v: v0, box, ride: [] };
    S.dragging = true;
    capturePointer(el, e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = Math.max(0, Math.min(1, (e.clientX - drag.box.left) / drag.box.width));
    let v = dbLaw ? posToDb(p) : min + p * (max - min);
    if (!e.shiftKey && !dbLaw && Math.abs(v) < 0.04) v = 0;
    drag.v = v;
    paint(v);
    if (S.autoWrite && S.playing) drag.ride.push({ t: barFloatNow(), v });
  });
  el.addEventListener("pointerup", async (e) => {
    const d = drag; drag = null;
    S.dragging = false;
    if (!d) return;
    releasePointer(el, e.pointerId);
    if (S.autoWrite && d.ride.length > 1) {
      const ref = laneRef(keyOf());
      if (ref) { await writeRide(ref, d.ride); return; }
    }
    await commit(d.v, v0);
  });
  el.addEventListener("dblclick", () => commit(dbLaw ? 0 : 0, v0));
}

/** Turn a recorded ride into keyframes: thinned to ~12 per bar, then written
 *  through the parameter's own action as { keys } — the same shape an MCP
 *  automation call writes, because it IS the same action. */
async function writeRide(ref, ride) {
  const keys = [];
  for (const s of ride) {
    const last = keys[keys.length - 1];
    if (last && Math.abs(s.t - last.t) < 1 / 12 && Math.abs(s.v - last.v) < (ref.max - ref.min) / 200) continue;
    keys.push({ t: s.t, v: s.v });
  }
  const merged = [...ref.keys().filter((k) => k.t < keys[0].t - 1e-6 || k.t > keys[keys.length - 1].t + 1e-6), ...keys];
  await writeLane(ref, merged);
  if (!S.lanes.includes(ref.key)) toggleLane(ref.key);
  status(`rode ${ref.label}: ${keys.length} keyframes written (bars ${keys[0].t.toFixed(2)}–${keys[keys.length - 1].t.toFixed(2)})`);
}

/* ── meters ─────────────────────────────────────────────────────────── */

/* ONE SCALE, shared by the meter and its labels. −60 … +6 dBFS. */
const MTR_LO = -60, MTR_HI = 6;
const MTR_TICKS = [6, 0, -6, -12, -18, -24, -36, -48, -60];
const meterY = (h, db) => h * (1 - (Math.max(MTR_LO, Math.min(MTR_HI, db)) - MTR_LO) / (MTR_HI - MTR_LO));

const MTR_W = 14;                // the meter bar's CSS width
const MIX_SCALE_W = 26;          // the shared dB gutter's CSS width

/** The one dB scale, in the gutter: ticks and numbers, the same map above. */
function paintScale(cv, h) {
  const { g, w } = fitCanvas(cv, MIX_SCALE_W, h);
  g.clearRect(0, 0, w, h);
  g.font = "9px monospace";
  g.textBaseline = "middle";
  for (const db of MTR_TICKS) {
    /* the tick is snapped to a whole CSS pixel so a 1 px rule lands on a
     * device pixel rather than straddling two and going grey. */
    const y = Math.round(Math.min(h - 1, Math.max(1, meterY(h, db)))) + 0.5;
    tint(g, db === 0 ? C.warn : C.hair, db === 0 ? 0.9 : 1,
      () => g.fillRect(0, y - 0.5, db % 12 === 0 ? 5 : 3, 1));
    tint(g, db === 0 ? C.warn : C.ghost, 1,
      () => g.fillText(db > 0 ? `+${db}` : `${db}`, 7, Math.min(h - 4, Math.max(4, y))));
  }
  g.textBaseline = "alphabetic";
}

function paintMeter(cv, row) {
  const g = cv.getContext("2d");
  const w = cv._cw || MTR_W, h = cv._ch || 160;
  g.clearRect(0, 0, w, h);
  const yOf = (db) => meterY(h, db);
  for (const db of MTR_TICKS) tint(g, C.hair, 0.55, () => g.fillRect(0, Math.round(yOf(db)), w, 1));
  tint(g, C.warn, 0.55, () => g.fillRect(0, Math.round(yOf(0)), w, 1));
  if (!row) return;
  const peak = row.peak_db ?? -120, rms = row.rms_db ?? -120;
  tint(g, peak > -1 ? C.err : C.ok, 0.55, () => g.fillRect(1, yOf(peak), w - 2, h - yOf(peak)));
  tint(g, C.primary, 0.9, () => g.fillRect(1, yOf(rms), w - 2, h - yOf(rms)));
  tint(g, C.ink, 1, () => g.fillRect(0, Math.round(yOf(peak)), w, 1));
}

/** The live master meter: real ballistics over the audio actually playing. */
function meterTick() {
  const cv = S.masterMeterEl;
  if (!cv || !S.analyser) return;
  const now = performance.now();
  const dt = Math.min(0.25, (now - (S.mtr.at || now)) / 1000);
  S.mtr.at = now;
  let peak = 0, sum = 0;
  if (S.playing) {
    S.analyser.getFloatTimeDomainData(S.anaBuf);
    for (let i = 0; i < S.anaBuf.length; i++) {
      const a = Math.abs(S.anaBuf[i]);
      if (a > peak) peak = a;
      sum += S.anaBuf[i] * S.anaBuf[i];
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, S.anaBuf.length));
  // 20 dB/s decay = a factor of 10^(-20*dt/20)
  const decay = Math.pow(10, -dt);
  S.mtr.peak = Math.max(peak, S.mtr.peak * decay);
  S.mtr.rms = Math.max(rms, S.mtr.rms * Math.pow(10, -0.6 * dt));
  if (peak >= S.mtr.hold) { S.mtr.hold = peak; S.mtr.holdAt = now; }
  else if (now - S.mtr.holdAt > 1500) S.mtr.hold = Math.max(peak, S.mtr.hold * decay);

  const g = cv.getContext("2d");
  /* the CSS box, not the bitmap: the context is pre-scaled by dpr */
  const w = cv._cw || MTR_W, h = cv._ch || 160;
  const dB = (v) => 20 * Math.log10(Math.max(1e-6, v));
  const yOf = (db) => meterY(h, db);
  g.clearRect(0, 0, w, h);
  for (const db of MTR_TICKS) tint(g, C.hair, 0.55, () => g.fillRect(0, Math.round(yOf(db)), w, 1));
  tint(g, C.warn, 0.55, () => g.fillRect(0, Math.round(yOf(0)), w, 1));
  const py = yOf(dB(S.mtr.peak));
  tint(g, S.mtr.peak > 0.99 ? C.err : C.ok, 0.5, () => g.fillRect(1, py, w - 2, h - py));
  const ry = yOf(dB(S.mtr.rms));
  tint(g, C.primary, 0.9, () => g.fillRect(1, ry, w - 2, h - ry));
  const hy = yOf(dB(S.mtr.hold));
  tint(g, S.mtr.hold > 0.99 ? C.err : C.ink, 1, () => g.fillRect(0, Math.round(hy), w, 1.5));
}
setInterval(meterTick, 50);

$("metersBtn").addEventListener("click", async () => {
  if (!S.slug) return;
  $("metersBtn").disabled = true;
  status("measuring through the real render path…");
  try {
    const from = 1, to = S.proj.lengthBars;
    const r = await api({ action: "meters", slug: S.slug, from_bar: from, to_bar: to });
    S.meters = r;
    drawMixer();
    const m = r.master;
    /* lufs_short is a SERIES (one short-term window per 100 ms), so it is
     * summarised as a range - printing the raw array is how a meter panel
     * turns into a wall of numbers nobody reads. */
    const st = Array.isArray(m.lufs_short)
      ? m.lufs_short.map((x) => (Array.isArray(x) ? x[1] : x)).filter(Number.isFinite) : [];
    $("meterNote").innerHTML = `<b>measured</b> bars ${from}–${to}: master peak `
      + `${m.peak_db} dBFS · true peak ${m.true_peak_db} dBTP · ${m.lufs} LUFS-I`
      + (st.length ? ` · short-term ${Math.min(...st).toFixed(1)}…${Math.max(...st).toFixed(1)} LUFS over ${st.length} windows` : "")
      + ` · ${r.ms} ms. Per-track bars above are this measurement, not a live meter.`;
    status(`meters: master ${m.peak_db} dBFS / ${m.lufs} LUFS in ${r.ms} ms`);
  } catch (err) { status(`meters failed: ${err.message}`); }
  finally { $("metersBtn").disabled = false; }
});

$("autoWriteBtn").addEventListener("click", () => {
  S.autoWrite = !S.autoWrite;
  $("autoWriteBtn").classList.toggle("d-on", S.autoWrite);
  status(S.autoWrite
    ? "automation WRITE armed — ride a fader, a pan, a send or a knob while the transport rolls and the gesture becomes keyframes"
    : "automation write off");
});

$("returnAddBtn").addEventListener("click", () => act(
  { action: "return_add", slug: S.slug }, null, "add return"));

/* ══════════════════════ THE ANALYSIS DISPLAYS ═══════════════════════════
 * Four displays the window did not have: a spectrum analyser with a peak
 * hold, a loudness history (LUFS-S over time against the integrated value
 * and the two targets anybody actually delivers to), a correlation meter
 * and a goniometer.
 *
 * WHERE EACH ONE'S NUMBERS COME FROM, because a display that invents its
 * data is worse than no display:
 *
 *   spectrum      LIVE   an FFT of the samples this page is playing (the
 *                        master AnalyserNode). It is the bounce, because
 *                        the page only ever plays engine-rendered regions.
 *                 MEASURED  `analyze`.spectrum when the server serves it.
 *   loudness      MEASURED  `meters`.master.lufs_short — the engine's own
 *                        K-weighted 3 s/1 s series, which already exists —
 *                        upgraded to `analyze`.loudness when that lands.
 *   correlation   LIVE   Σlr / √(Σl²·Σr²) over the two channels actually
 *                        leaving the master bus.
 *   goniometer    LIVE   the same two channels, plotted mid/side.
 *
 * The live three go STILL when the transport is stopped and say so; they
 * are never filled in with a shape nobody measured. The measured ones show
 * a placeholder naming the exact call they are waiting for.
 *
 * ⚠ DEFERRED ACTIONS. `analyze` and `device_response` are being added on a
 * concurrent branch and do not exist in this tree yet. They are named in
 * DEFERRED below rather than written inline as `action: "…"` literals for
 * one reason: server/daw/ui_test.js's parity gate proves every literal the
 * page posts is an action THIS tree dispatches, and an action that does not
 * exist yet would fail that gate — which is the gate doing its job. The
 * property the gate protects is enforced here at RUNTIME instead: `probe`
 * asks the server once, remembers the answer, and the page never posts one
 * of these unless the server said it dispatches it. When the sibling lands,
 * inline the two strings and delete this note; the gate then covers them
 * statically again, which is where they belong. */

const DEFERRED = { analyze: "analyze", response: "device_response" };
/* action -> true | false. Probed once, and FORGOTTEN whenever a project is
 * opened: the server can grow the endpoint while this page is open (it is
 * landing on another branch right now), and a page that cached "unknown"
 * forever would never notice it arrive. */
const DEFER_OK = new Map();

/* One probe in flight per action, ever. A chain of five inserts asking at
 * once would otherwise send five identical requests and take five 400s in
 * the console before the first answer cached. */
const DEFER_PROBE = new Map();

/** Post a deferred action, once we know the server has it. Returns null —
 *  never throws — when the server does not dispatch it. */
async function tryDeferred(name, body) {
  if (DEFER_OK.get(name) === false) return null;
  if (DEFER_OK.get(name) === undefined) {
    if (!DEFER_PROBE.has(name)) {
      /* I am the prober: my own call is the probe, so I get my own answer
       * and nobody else's body is ever confused for mine. */
      const p = api({ ...body, action: name })
        .then((r) => { DEFER_OK.set(name, true); return r; })
        .catch((err) => {
          if (/^Unknown action/i.test(err.message)) { DEFER_OK.set(name, false); return null; }
          throw err;
        })
        .finally(() => DEFER_PROBE.delete(name));
      DEFER_PROBE.set(name, p);
      return p;
    }
    await DEFER_PROBE.get(name).catch(() => { /* the verdict is what matters */ });
    if (DEFER_OK.get(name) !== true) return null;
  }
  return api({ ...body, action: name });
}
const deferredNote = (name) =>
  `not available yet — this display is waiting for POST /api/daw {"action":"${name}"}`;

/* ── the dock's three tabs ───────────────────────────────────────────── */

function showDock(tab) {
  S.ana.tab = tab;
  /* Opening a tab UNFOLDS the dock, so the project has to hear about it —
   * otherwise a reload folds away the pane that was just asked for. Only on the
   * transition, and only with a project open: this function is also called by
   * boot() and by every click on a strip's name. */
  const wasFolded = $("centre").classList.contains("d-nodock");
  $("centre").classList.remove("d-nodock");
  $("dockBtn").classList.add("d-on");
  if (wasFolded && viewOf()?.dock?.folded) saveView({ dock: { folded: false } });
  for (const [id, pane, t] of [["tabChain", "paneChain", "chain"],
                               ["tabAnalysis", "paneAnalysis", "analysis"],
                               ["tabEar", "paneEar", "ear"]]) {
    $(id).classList.toggle("d-on", tab === t);
    $(pane).classList.toggle("d-on", tab === t);
  }
  $("chainHead").style.display = tab === "chain" ? "" : "none";
  /* The Ear is a column of cards; giving it the chain's 208 px would be
   * moving it out of a corner and into a slot. It gets room the first time
   * it is opened, and keeps whatever you drag it to after that. */
  if (tab === "ear" && $("dock").getBoundingClientRect().height < 300) {
    $("centre").style.setProperty("--d-dock-h", `${Math.min(420, Math.round(innerHeight * 0.42))}px`);
  }
  if (tab === "analysis") { sizeAnalysis(); drawAnalysis(); }
  if (tab === "ear") document.querySelector(".ear-fab")?.setAttribute("data-open", "1");
}
$("tabChain").addEventListener("click", () => showDock("chain"));
$("tabAnalysis").addEventListener("click", () => showDock("analysis"));
$("tabEar").addEventListener("click", () => {
  showDock("ear");
  /* The Ear opens itself the first time, through its OWN button, so its
   * own state machine (status load, tab render) runs exactly as it does
   * when the button is clicked — this page never reaches inside it. */
  const fab = document.querySelector(".ear-fab");
  if (fab && fab.dataset.open !== "1") fab.click();
});
$("dockBtn").addEventListener("click", () => {
  const off = $("centre").classList.toggle("d-nodock");
  $("dockBtn").classList.toggle("d-on", !off);
  drawArr();
  if (!off) { sizeAnalysis(); drawAnalysis(); }
  if (viewOf()) saveView({ dock: { folded: off } }, `dock ${off ? "folded" : "open"}`);
});

/* ── canvas sizing: one device-pixel per CSS pixel, whatever the DPR ─── */

/* The analysis displays are laid out BY CSS (width:100% inside a flex
 * figure), so they measure rather than pin — see fitLive. */
function sizeCanvas(cv) {
  return fitLive(cv);
}
function sizeAnalysis() {
  for (const id of ["specCv", "loudCv", "corrCv", "goniCv"]) sizeCanvas($(id));
}
/* Every canvas is fitted to a MEASURED box at the CURRENT device pixel
 * ratio, so both of those changing has to reach all of them. A resize is
 * the obvious trigger; dragging the window onto a monitor with different
 * scaling is the one that gets forgotten, and it fires no resize at all —
 * hence the resolution media query, which is the only event for it. */
function refitAll() {
  if (S.ana.tab === "analysis") { sizeAnalysis(); drawAnalysis(); }
  if (S.rollFit) fitRoll();
  drawArr();                     // else the arrangement keeps a stale bitmap
  layoutMixer();
}
addEventListener("resize", refitAll);

let dprWatch = null;
function watchDpr() {
  dprWatch?.removeEventListener?.("change", onDpr);
  dprWatch = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprWatch.addEventListener("change", onDpr);
}
function onDpr() { watchDpr(); refitAll(); }
try { watchDpr(); } catch { /* older engines: the resize path still covers most of it */ }

/* ── the measured pass ───────────────────────────────────────────────── */

$("anaRun").addEventListener("click", runAnalysis);
$("anaLive").addEventListener("change", () => {
  S.ana.live = $("anaLive").checked;
  drawAnalysis();
});

async function runAnalysis() {
  if (!S.slug) return;
  const btn = $("anaRun");
  btn.disabled = true;
  const { a, b } = loopSecs();
  const fromBar = qToPosFine(secondsToQ(a)).bar;
  const toBar = Math.max(fromBar, qToPosFine(Math.max(0, secondsToQ(b) - 1e-6)).bar);
  $("anaNote").textContent = `measuring bars ${fromBar}–${toBar} through the render path…`;
  try {
    /* First choice: the one call that returns all of it. */
    const r = await tryDeferred(DEFERRED.analyze,
      { slug: S.slug, from_bar: fromBar, to_bar: toBar });
    if (r) {
      S.ana.measured = r;
      S.ana.note = `analyze: bars ${fromBar}–${toBar}${r.ms ? ` · ${r.ms} ms` : ""}`;
    } else {
      /* Second choice, and real today: the engine's own metering already
       * returns a K-weighted short-term LUFS series. */
      const m = await api({ action: "meters", slug: S.slug, from_bar: fromBar, to_bar: toBar });
      S.meters = m;
      drawMixer();
      S.ana.measured = {
        loudness: { short: m.master.lufs_short || [], integrated: m.master.lufs },
        peak_db: m.master.peak_db, true_peak_db: m.master.true_peak_db,
        from: fromBar, to: toBar, ms: m.ms, via: "meters",
      };
      S.ana.note = `meters: bars ${fromBar}–${toBar} · ${m.master.lufs} LUFS-I · `
        + `peak ${m.master.peak_db} dBFS · true peak ${m.master.true_peak_db} dBTP · ${m.ms} ms`;
    }
    $("anaNote").textContent = S.ana.note;
    drawAnalysis();
  } catch (err) {
    $("anaNote").textContent = `measurement failed: ${err.message}`;
  } finally { btn.disabled = false; }
}

/* ── the live pass ───────────────────────────────────────────────────── */

function analysisTick() {
  if (S.ana.tab !== "analysis" || $("centre").classList.contains("d-nodock")) return;
  if (S.ana.live && S.playing && S.analyser) {
    S.analyser.getFloatFrequencyData(S.freqBuf);
    S.spec = S.freqBuf;
    S.anL.getFloatTimeDomainData(S.bufL);
    S.anR.getFloatTimeDomainData(S.bufR);
    let ll = 0, rr = 0, lr = 0;
    for (let i = 0; i < S.bufL.length; i++) {
      ll += S.bufL[i] * S.bufL[i];
      rr += S.bufR[i] * S.bufR[i];
      lr += S.bufL[i] * S.bufR[i];
    }
    const den = Math.sqrt(ll * rr);
    const r = den > 1e-12 ? lr / den : null;
    if (r !== null) {
      S.ana.corr.push(r);
      if (S.ana.corr.length > 240) S.ana.corr.shift();
    }
  }
  drawAnalysis();
}
setInterval(analysisTick, 60);

function drawAnalysis() {
  if (S.ana.tab !== "analysis") return;
  drawSpectrum();
  drawLoudness();
  drawCorrelation();
  drawGoniometer();
}

/** A one-line honest placeholder inside an empty display. */
function emptyPanel(cv, lines) {
  const g = cv.getContext("2d");
  const { w, h } = sizeCanvas(cv);
  g.clearRect(0, 0, w, h);
  tint(g, C.panel, 0.7, () => g.fillRect(0, 0, w, h));
  g.font = "10px monospace";
  lines.forEach((t, i) => tint(g, C.ghost, 1, () => g.fillText(t, 8, 18 + i * 13)));
}

/* SPECTRUM — log frequency, 20 Hz … 20 kHz, with a peak hold that decays. */
function drawSpectrum() {
  const cv = $("specCv");
  const { w, h } = sizeCanvas(cv);
  const g = cv.getContext("2d");
  const measured = S.ana.measured?.spectrum;
  const haveLive = S.ana.live && S.playing && S.spec;
  $("specSrc").textContent = haveLive ? "live · this page's output"
    : measured ? "measured" : "idle";
  if (!haveLive && !measured) {
    emptyPanel(cv, [
      "no spectrum yet.",
      "press play — the live analyser reads the audio this page plays,",
      `or ${deferredNote(DEFERRED.analyze)}.spectrum`,
    ]);
    return;
  }
  g.clearRect(0, 0, w, h);
  tint(g, C.panel, 0.7, () => g.fillRect(0, 0, w, h));
  g.font = "8px monospace";
  const F0 = 20, F1 = 20000;
  const xOf = (f) => (Math.log10(Math.max(F0, Math.min(F1, f))) - Math.log10(F0))
    / (Math.log10(F1) - Math.log10(F0)) * w;
  const DB0 = -96, DB1 = 0;
  const yOf = (db) => h - (Math.max(DB0, Math.min(DB1, db)) - DB0) / (DB1 - DB0) * h;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    tint(g, C.hair, 0.8, () => g.fillRect(xOf(f), 0, 1, h));
    tint(g, C.ghost, 1, () => g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, xOf(f) + 2, h - 2));
  }
  for (const db of [-12, -24, -36, -48, -60, -72]) {
    tint(g, C.hair, 0.5, () => g.fillRect(0, yOf(db), w, 1));
    tint(g, C.ghost, 1, () => g.fillText(`${db}`, 2, yOf(db) - 1));
  }

  const nyq = (S.ctx?.sampleRate || 48000) / 2;
  const pts = [];
  if (haveLive) {
    const n = S.spec.length;
    for (let i = 1; i < n; i++) pts.push([i / n * nyq, S.spec[i]]);
  } else {
    const f = measured.freq || measured.hz || [];
    const d = measured.db || measured.mag_db || [];
    for (let i = 0; i < Math.min(f.length, d.length); i++) pts.push([f[i], d[i]]);
  }
  if (!pts.length) { emptyPanel(cv, ["the spectrum came back empty"]); return; }

  /* Column max, so a 2048-bin FFT does not draw 2048 hairlines. */
  const cols = new Float32Array(w).fill(-Infinity);
  for (const [f, db] of pts) {
    const x = Math.max(0, Math.min(w - 1, Math.round(xOf(f))));
    if (db > cols[x]) cols[x] = db;
  }
  if (!S.ana.hold || S.ana.hold.length !== w) S.ana.hold = new Float32Array(w).fill(-Infinity);
  for (let x = 0; x < w; x++) {
    if (cols[x] > S.ana.hold[x]) S.ana.hold[x] = cols[x];
    else S.ana.hold[x] -= 0.12;                       // the hold falls, slowly
  }

  tint(g, C.primary, 0.75, () => {
    g.beginPath();
    let started = false;
    for (let x = 0; x < w; x++) {
      if (!Number.isFinite(cols[x])) continue;
      const y = yOf(cols[x]);
      if (!started) { g.moveTo(x, h); g.lineTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  });
  tint(g, C.warn, 0.85, () => {
    for (let x = 0; x < w; x++) {
      if (Number.isFinite(S.ana.hold[x]) && S.ana.hold[x] > DB0) g.fillRect(x, yOf(S.ana.hold[x]), 1, 1.5);
    }
  });
  tint(g, C.ghost, 1, () => g.fillText("peak hold", w - 54, 9));
}

/* LOUDNESS HISTORY — LUFS-S over time, the integrated value, and the two
 * targets people actually deliver to. */
function drawLoudness() {
  const cv = $("loudCv");
  const { w, h } = sizeCanvas(cv);
  const g = cv.getContext("2d");
  const L = S.ana.measured?.loudness;
  const short = (L?.short || L?.lufs_short || []).map((k) => (Array.isArray(k) ? k : [k.t, k.v]))
    .filter((k) => Number.isFinite(k[1]));
  $("loudSrc").textContent = L ? (S.ana.measured.via === "meters" ? "measured · meters" : "measured · analyze") : "—";
  if (!short.length) {
    emptyPanel(cv, [
      "no loudness history yet.",
      "press measure — the engine's own K-weighted LUFS-S series (3 s / 1 s)",
      `is plotted here; ${deferredNote(DEFERRED.analyze)}.loudness upgrades it`,
      "to momentary + integrated in one call.",
    ]);
    return;
  }
  g.clearRect(0, 0, w, h);
  tint(g, C.panel, 0.7, () => g.fillRect(0, 0, w, h));
  g.font = "8px monospace";
  const LO = -40, HI = -5;
  const yOf = (v) => h - (Math.max(LO, Math.min(HI, v)) - LO) / (HI - LO) * h;
  const t1 = Math.max(1e-6, short[short.length - 1][0]);
  const xOf = (t) => t / t1 * (w - 34) + 30;
  for (const v of [-9, -14, -23]) {
    tint(g, v === -14 ? C.ok : C.hair, v === -14 ? 0.6 : 1,
      () => g.fillRect(30, yOf(v), w - 34, 1));
    tint(g, v === -14 ? C.ok : C.ghost, 1, () => g.fillText(`${v}`, 2, yOf(v) + 3));
  }
  const momentary = (L.momentary || []).map((k) => (Array.isArray(k) ? k : [k.t, k.v]))
    .filter((k) => Number.isFinite(k[1]));
  if (momentary.length) {
    tint(g, C.secondary, 0.5, () => {
      g.beginPath();
      momentary.forEach(([t, v], i) => (i ? g.lineTo(xOf(t), yOf(v)) : g.moveTo(xOf(t), yOf(v))));
      g.stroke();
    });
  }
  tint(g, C.primary, 1, () => {
    g.lineWidth = 1.5;
    g.beginPath();
    short.forEach(([t, v], i) => (i ? g.lineTo(xOf(t), yOf(v)) : g.moveTo(xOf(t), yOf(v))));
    g.stroke();
    g.lineWidth = 1;
  });
  const I = L.integrated ?? L.lufs;
  if (Number.isFinite(I)) {
    tint(g, C.warn, 0.9, () => {
      g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(30, yOf(I)); g.lineTo(w, yOf(I)); g.stroke();
      g.setLineDash([]);
    });
    tint(g, C.warn, 1, () => g.fillText(`I ${I.toFixed(1)} LUFS`, 34, yOf(I) - 3));
  }
  tint(g, C.ghost, 1, () => {
    g.fillText("LUFS-S", 2, 9);
    g.fillText(`${t1.toFixed(1)}s`, w - 26, h - 2);
    g.fillText("−14 target", w - 60, 9);
  });
}

/* CORRELATION — +1 mono-identical, 0 uncorrelated, −1 out of phase. */
function drawCorrelation() {
  const cv = $("corrCv");
  const { w, h } = sizeCanvas(cv);
  const g = cv.getContext("2d");
  const hist = S.ana.corr;
  const live = S.ana.live && S.playing;
  const measured = S.ana.measured?.correlation;
  $("corrSrc").textContent = live ? "live" : (Number.isFinite(measured) ? "measured" : "idle");
  const r = live && hist.length ? hist[hist.length - 1]
    : (Number.isFinite(measured) ? measured : null);
  if (r === null) {
    emptyPanel(cv, ["press play for the live", "phase correlation of the two",
                    "channels leaving the master."]);
    return;
  }
  g.clearRect(0, 0, w, h);
  tint(g, C.panel, 0.7, () => g.fillRect(0, 0, w, h));
  g.font = "8px monospace";
  const barY = 12, barH = 14;
  const xOf = (v) => (v + 1) / 2 * (w - 8) + 4;
  tint(g, C.hair, 1, () => g.fillRect(4, barY, w - 8, barH));
  tint(g, C.hair, 1, () => g.fillRect(xOf(0), barY - 3, 1, barH + 6));
  const x0 = Math.min(xOf(0), xOf(r)), x1 = Math.max(xOf(0), xOf(r));
  tint(g, r < 0 ? C.err : C.ok, 0.85, () => g.fillRect(x0, barY, Math.max(1, x1 - x0), barH));
  tint(g, C.ink, 1, () => g.fillRect(xOf(r) - 1, barY - 2, 2, barH + 4));
  tint(g, C.ghost, 1, () => {
    g.fillText("−1", 4, barY - 4);
    g.fillText("0", xOf(0) - 2, barY - 4);
    g.fillText("+1", w - 14, barY - 4);
  });
  tint(g, r < -0.2 ? C.err : C.dim, 1, () => {
    g.font = "13px monospace";
    g.fillText(r.toFixed(2), 6, barY + barH + 18);
    g.font = "8px monospace";
  });
  tint(g, C.ghost, 1, () => g.fillText(r < -0.2 ? "out of phase" : r < 0.2 ? "wide" : "mono-safe",
    6, barY + barH + 29));
  // the trail: where it has been over the last few seconds
  if (hist.length > 1) {
    const y0 = barY + barH + 34;
    const hh = Math.max(6, h - y0 - 2);
    tint(g, C.hair, 1, () => g.fillRect(4, y0 + hh / 2, w - 8, 1));
    tint(g, C.primary, 0.8, () => {
      g.beginPath();
      hist.forEach((v, i) => {
        const x = 4 + i / Math.max(1, hist.length - 1) * (w - 8);
        const y = y0 + hh / 2 - v * hh / 2;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    });
  }
}

/* GONIOMETER — mid up, side across: the classic 45°-rotated Lissajous. */
function drawGoniometer() {
  const cv = $("goniCv");
  const { w, h } = sizeCanvas(cv);
  const g = cv.getContext("2d");
  const live = S.ana.live && S.playing && S.bufL;
  $("goniSrc").textContent = live ? "live" : "idle";
  if (!live) {
    emptyPanel(cv, ["press play for the", "stereo field of the audio", "this page is playing."]);
    return;
  }
  g.clearRect(0, 0, w, h);
  tint(g, C.panel, 0.7, () => g.fillRect(0, 0, w, h));
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;
  tint(g, C.hair, 1, () => {
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.stroke();
  });
  g.font = "8px monospace";
  tint(g, C.ghost, 1, () => {
    g.fillText("M", cx + 3, cy - R + 8);
    g.fillText("L", 2, cy - 3);
    g.fillText("R", w - 9, cy - 3);
  });
  const n = S.bufL.length;
  const step = Math.max(1, Math.floor(n / 700));
  tint(g, C.ok, 0.65, () => {
    for (let i = 0; i < n; i += step) {
      const l = S.bufL[i], r = S.bufR[i];
      const mid = (l + r) * 0.7071, side = (r - l) * 0.7071;
      g.fillRect(cx + side * R - 0.5, cy - mid * R - 0.5, 1.4, 1.4);
    }
  });
}

/* ═══════════════════════════════════════ the one write path + undo ══════
 * Every mutating gesture goes through `act`: POST the action, remember its
 * inverse (also an action), re-read the document, then re-render only what
 * the server says is dirty. Undo replays the inverse — so undo is not a
 * second code path either. */

async function act(body, inverse, label) {
  const session = captureSession();
  if (body.slug && body.slug !== session.slug) return null;
  const t0 = performance.now();
  try {
    const r = await api(body);
    if (!sessionCurrent(session)) return null;
    if (inverse) pushUndo({ body: inverse, forward: body, label: label || body.action });
    await refreshDoc(session);
    if (!sessionCurrent(session)) return null;
    renderAndSwap(t0, performance.now(), r.dirty, session);
    if (label) status(label);
    return r;
  } catch (err) { if (sessionCurrent(session)) status(`${body.action}: ${err.message}`); return null; }
}

/**
 * THE HISTORY, VISIBLE. The undo stack was already real — inverse actions
 * posted through the same route — but it had no affordance and no list, so
 * the only way to know what Ctrl+Z would do was to press it.
 *
 * An entry carries the inverse (`body` / `bodies`) and, when the forward
 * gesture can be replayed exactly, the forward too (`forward` / `forwards`),
 * which is what makes REDO possible without a second code path: redo posts
 * the same action the gesture posted. Gestures whose replay would mint new
 * ids (duplicate, split) carry no forward, and undoing one CLEARS the redo
 * stack rather than letting redo replay an older entry out of order — an
 * out-of-order redo is worse than no redo.
 */
function pushUndo(entry) {
  S.undo.push(entry);
  if (S.redo.length) S.redo = [];
  drawHistory();
}

async function undoOnce() {
  const session = captureSession();
  const u = S.undo.pop();
  if (!u) { status("nothing to undo"); return; }
  const t0 = performance.now();
  try {
    let last = null;
    for (const b of u.bodies || [u.body]) {
      if (!sessionCurrent(session) || (b?.slug && b.slug !== session.slug)) return;
      last = await api(b);
      if (!sessionCurrent(session)) return;
    }
    if (u.forward || u.forwards) S.redo.push(u);
    else if (S.redo.length) {
      S.redo = [];
      status(`undid: ${u.label} — redo cleared (this gesture mints new ids, so it cannot be replayed exactly)`);
    }
    await refreshDoc(session);
    if (!sessionCurrent(session)) return;
    renderAndSwap(t0, performance.now(), last?.dirty, session);
    drawHistory();
    status(`undid: ${u.label}`);
  } catch (err) { if (sessionCurrent(session)) { S.undo.push(u); drawHistory(); status(`undo failed: ${err.message}`); } }
}

async function redoOnce() {
  const session = captureSession();
  const u = S.redo.pop();
  if (!u) { status("nothing to redo"); return; }
  const t0 = performance.now();
  try {
    let last = null;
    for (const b of u.forwards || [u.forward]) {
      if (!sessionCurrent(session) || (b?.slug && b.slug !== session.slug)) return;
      last = await api(b);
      if (!sessionCurrent(session)) return;
    }
    /* An action that created something hands back the new id, so the entry
     * that goes back on the undo stack undoes THIS object, not the one the
     * gesture made the first time. */
    const again = u.inverseFrom ? { ...u, ...u.inverseFrom(last) } : u;
    S.undo.push(again);
    await refreshDoc(session);
    if (!sessionCurrent(session)) return;
    renderAndSwap(t0, performance.now(), last?.dirty, session);
    drawHistory();
    status(`redid: ${u.label}`);
  } catch (err) { if (sessionCurrent(session)) { S.redo.push(u); drawHistory(); status(`redo failed: ${err.message}`); } }
}

/** The stack, named, newest first — undo above the line, redo below it. */
function drawHistory() {
  const box = $("histBox");
  if (!box) return;
  box.innerHTML = "";
  $("histCnt").textContent = `${S.undo.length} undo · ${S.redo.length} redo`;
  $("undoBtn").disabled = !S.undo.length;
  $("redoBtn").disabled = !S.redo.length;
  $("undoN").textContent = S.undo.length ? String(S.undo.length) : "";
  $("redoN").textContent = S.redo.length ? String(S.redo.length) : "";
  $("undoBtn").title = S.undo.length
    ? `undo ${S.undo[S.undo.length - 1].label} — ${binding("undo")}`
    : `nothing to undo — ${binding("undo")}`;
  $("redoBtn").title = S.redo.length
    ? `redo ${S.redo[S.redo.length - 1].label} — ${binding("redo")}`
    : `nothing to redo — ${binding("redo")}`;
  if (!S.undo.length && !S.redo.length) {
    box.innerHTML = `<div class="d-note">Nothing yet. Every edit lands here with its inverse; `
      + `undo posts that inverse through the same route an MCP tool posts.</div>`;
    return;
  }
  const row = (cls, n, label, title, fn) => {
    const d = document.createElement("div");
    d.className = `d-histrow${cls}`;
    d.title = title;
    d.innerHTML = `<span class="d-hn">${n}</span><span class="d-hl">${label}</span>`;
    d.addEventListener("click", fn);
    box.appendChild(d);
  };
  [...S.redo].reverse().forEach((u, i) =>
    row(" d-redo", "↷", u.label, "click to redo up to here",
      () => { (async () => { for (let k = 0; k <= i; k++) await redoOnce(); })(); }));
  [...S.undo].reverse().forEach((u, i) =>
    row("", "↶", u.label, "click to undo back to here",
      () => { (async () => { for (let k = 0; k <= i; k++) await undoOnce(); })(); }));
}
$("undoBtn").addEventListener("click", undoOnce);
$("redoBtn").addEventListener("click", redoOnce);

/* ─────────────────────────────── render → fetch → decode → hot swap */

let renderChain = Promise.resolve();

/* ══════════════════════════════════════════════════════════════════════════
 * §1 THE ROLLING MONITOR — a look-ahead render, and a badge that tells the
 * truth about it.
 *
 * THE MEASUREMENT THIS IS BUILT ON, because it decides the whole design. A
 * chained render costs O(prefix), not O(window): rack.chain_graph processes
 * from absolute sample 0 every time, deliberately, because that is what makes
 * a region's bytes identical to the bounce's bytes. Measured on this repo's
 * own 128-bar reference project, the SAME four-bar region job costs
 *
 *      bars   1–4    305 ms
 *      bars  21–24 2 607 ms
 *      bars  61–64 6 219 ms      ← still inside its own 7 500 ms of audio
 *      bars  85–88 8 498 ms      ← past it
 *      bars 125–128 11 068 ms    ← half as long again as the audio it covers
 *
 * So a rolling monitor that renders the next region while the current one
 * plays HOLDS to about bar 80 of a chained project and cannot hold after it.
 * There is no truncation that rescues it either: rendering bar 65 with only
 * the last four bars of history differs from the truth on 48.82 % of its
 * samples at −4.74 dB error-to-signal, because a long tail and a compressor
 * envelope reach across, while bar 87 tolerates no history at all. There is
 * no safe constant, so the monitor renders whole regions with the full note
 * list — the same artefact the bounce writes — or it renders nothing.
 *
 * WHICH LEAVES ONE HONEST DESIGN: say so. The badge is not a spinner and not
 * a promise; it is a measurement, made before the boundary arrives, with the
 * bars named. `render_plan` answers it and renders nothing at all, so asking
 * is free and the window can ask on every load and after every edit.
 * ═════════════════════════════════════════════════════════════════════════ */

/** One region file, fetched, decoded and swapped into the schedule. The one
 *  place a buffer enters this page — renderAndSwap and the look-ahead both
 *  go through it, so "the browser plays the file the server made" has a
 *  single door rather than two that could drift. */
async function swapRegion(g, session = captureSession(), renderRequest = S.renderRequest) {
  const current = () => sessionCurrent(session) && renderRequest === S.renderRequest;
  if (!current()) return false;
  if (!g?.url || S.buffers.get(g.idx)?.url === g.url) return false;
  const response = await fetch(g.url);
  if (!current()) return false;
  const bytes = await response.arrayBuffer();
  if (!current()) return false;
  const buf = await audioCtx().decodeAudioData(bytes);
  if (!current()) return false;
  S.buffers.set(g.idx, { hash: g.hash, url: g.url, buffer: buf, t0: g.t0, t1: g.t1 });
  if (S.playing) hotSwap(g.idx);
  return true;
}

/* ═══ THE BADGE IS RELATIVE — and that is the whole of this section ═══════
 *
 * The first version of this badge scanned EVERY region in the song and went
 * red if any one of them was late. On the projects it exists for that badge
 * can never be green: a chained 128-bar take has late regions past bar ~80
 * by arithmetic (§0.1), so the window said "will arrive late" from the first
 * frame after load, forever, whatever you were doing. A warning that is
 * always on is a warning nobody reads.
 *
 * It was also saying something untrue. Bars 1-4 of that same project render
 * in 305 ms against 7 500 ms of audio. They ARE ready, and a monitor that
 * refuses to say so while you are working on the intro is wrong about the
 * thing you can hear. What is not ready is bars 81-84, and only once you are
 * heading for them.
 *
 * So the badge judges THE STRETCH THE PLAYHEAD WILL ACTUALLY REACH:
 *
 *   • A LOOP RANGE is a closed window. Every region inside it is judged,
 *     because the playhead returns to all of them — and the wrap counts: the
 *     region to have ready while the loop's last bar plays is the loop's
 *     FIRST. That is aheadAt().
 *   • NO LOOP: the next AHEAD_REGIONS regions from where the playhead is,
 *     because that is as far ahead as a rolling monitor can answer for.
 *
 * What falls outside the window is not dropped silently — that would just be
 * a nicer lie. The tooltip names how many of the song's remaining regions are
 * expected to be late and where the first one is, so "ahead ✓" here never
 * reads as "fine everywhere". beyondNote() writes that sentence.
 * ═════════════════════════════════════════════════════════════════════════ */

/** One region's length in seconds, from whatever rows are in hand. Used only
 *  to turn "the next N regions" into the `lead_seconds` the route takes. When
 *  nothing is in hand yet it answers 0 and the ask goes out unbounded — the
 *  window is then applied to the reply instead, so the badge is never wrong
 *  while it waits, only the payload is bigger once. */
function regionSecs() {
  const r = S.ahead.plan?.regions?.[0] || S.regions?.[0];
  const len = r ? r.t1 - r.t0 : 0;
  return len > 0.05 ? len : 0;
}

/** THE WINDOW THE BADGE IS ABOUT. One definition, used by the ask and by the
 *  paint, so the stretch measured and the stretch spoken about are the same
 *  stretch. `lead` null means "not bounded yet" (no region length known). */
function aheadWindow() {
  const total = S.totalSeconds || 0;
  const { a, b } = loopSecs();
  const looping = S.loop && S.loopA != null && S.loopB != null && (b - a) > 0.05;
  if (looping) {
    return { from: a, lead: b - a, wrap: true,
             scope: `the loop, bars ${S.loopA.toFixed(2)}-${S.loopB.toFixed(2)}` };
  }
  const one = regionSecs();
  return { from: Math.max(0, Math.min(projTime(), total)),
           lead: one ? one * AHEAD_REGIONS : null, wrap: false,
           scope: `the next ${AHEAD_REGIONS} regions from the playhead` };
}

/** The plan's rows cut to that window. The route cuts them too when it is
 *  given a lead; this cut is what makes the badge right on the FIRST reply,
 *  before any region length is known, and what makes "the next N regions"
 *  exactly N rather than "however many fit in N × the first one's length". */
function windowRows(all, w) {
  const rows = (all || []).filter((r) => r.t1 > w.from + 1e-6
    && (w.lead == null || r.t0 < w.from + w.lead - 1e-6));
  return w.wrap ? rows : rows.slice(0, AHEAD_REGIONS);
}

/** Ask for the verdict table over the window the playhead is heading into.
 *  Renders nothing — that is the point of it. */
async function refreshPlan(session = captureSession()) {
  if (!sessionCurrent(session)) return null;
  if (!S.slug || S.ahead.asking) return null;
  const w = aheadWindow();
  S.ahead.asking = true;
  S.ahead.at = w.from;
  try {
    const r = await api({ action: "render_plan", slug: session.slug,
                          from_seconds: w.from, lead_seconds: w.lead ?? undefined });
    if (!sessionCurrent(session)) return null;
    S.ahead.plan = r;
    paintAhead();
    return r;
  } catch (err) {
    if (!sessionCurrent(session)) return null;
    S.ahead.plan = null;
    S.ahead.state = "idle";
    S.ahead.txt = "ahead —";
    S.ahead.why = `render_plan: ${err.message}`;
    paintBadge();
    return null;
  } finally {
    if (sessionCurrent(session)) S.ahead.asking = false;
  }
}

/** The region a moment falls in, from the plan's own rows. Total and
 *  boundary-exact, and a seam belongs to the LATER region — the same rule
 *  routes.js's regionAt uses, because the two must agree about which region
 *  the playhead is "in" or the badge would count a different run than the
 *  renderer renders. */
function planRegionAt(rows, seconds) {
  if (!rows?.length) return null;
  if (seconds <= rows[0].t0) return rows[0];
  for (const r of rows) if (seconds >= r.t0 && seconds < r.t1) return r;
  return rows[rows.length - 1];
}

/** How many regions from here forward are already on disk, contiguously —
 *  counted inside the window only, and WRAPPING when the window is a loop,
 *  because in a loop the region after the last one is the first one. */
function aheadCount(rows, seconds, wrap) {
  const here = planRegionAt(rows, seconds);
  if (!here) return 0;
  const start = rows.findIndex((r) => r.idx === here.idx);
  let n = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[wrap ? (start + k) % rows.length : start + k];
    if (!r) break;
    if (!(r.cached || S.buffers.get(r.idx)?.hash === r.hash)) break;
    n++;
  }
  return n;
}

/** Where the playhead will be `lead` seconds from `at`. Inside a loop the
 *  future is CIRCULAR: a second past the loop's end is a second past its
 *  start, and a look-ahead that did not know that would spend the last bar
 *  of every loop rendering a region the transport is never going to play. */
function aheadAt(at, lead) {
  const { a, b } = loopSecs();
  const len = b - a;
  if (!S.loop || len <= 0) return at + lead;
  return a + ((((at - a + lead) % len) + len) % len);
}

/** WHAT THE BADGE DID NOT JUDGE, said out loud. A green badge over a four-
 *  region window on a song with twenty late regions is only honest if it
 *  says where the twenty are — so this sentence goes in every tooltip,
 *  including the green one. */
function beyondNote(plan, rows) {
  const last = rows[rows.length - 1];
  const held = (plan.regions || []).filter((r) => r.idx > last.idx);
  const heldLate = held.filter((r) => r.verdict === "late");
  const n = Math.max(heldLate.length, plan.beyondLateCount || 0);
  const first = heldLate[0] || plan.beyondLate || null;
  const of = plan.songRegions ? ` of this project's ${plan.songRegions}` : "";
  if (!n || !first) {
    return `Nothing after it${of ? ` (${plan.songRegions} regions in all)` : ""} is expected to be late either.`;
  }
  return `Beyond this window, ${n}${of} region${n === 1 ? " is" : "s are"} expected to arrive late — `
    + `the first is bars ${first.fromBar}-${first.toBar}. Play or loop there and the badge will say so.`;
}

/**
 * THE BADGE, in its three states. The third is the feature — and every one
 * of them is now about the window, not the song.
 *
 *   ahead ✓ 3/4 regions                    bars 1-5 of a chained take, honestly
 *                                          (3 of the 4 ahead are already on disk)
 *   ahead ⏱ 1 region · 8.5 s for 7.5 s     the render is slower than its audio
 *   ahead ✗ bars 81-84 · will arrive late  when the loop actually covers them
 *
 * The verdict per region is the SERVER's (regionVerdict, held to the cost
 * model by ahead_test.js). This function chooses which regions to read it
 * from and says which those were; it never forms an opinion of its own.
 */
function paintAhead() {
  const plan = S.ahead.plan;
  if (!plan?.regions?.length) {
    S.ahead.state = "idle"; S.ahead.txt = "ahead —";
    S.ahead.why = "no plan yet — click to measure (render_plan renders nothing)";
    return paintBadge();
  }
  const at = projTime();
  const w = aheadWindow();
  const rows = windowRows(plan.regions, w);
  if (!rows.length) {
    S.ahead.state = "idle"; S.ahead.txt = "ahead —";
    S.ahead.why = `the plan in hand does not cover ${w.scope} — measuring it now `
      + "(render_plan renders nothing)";
    paintBadge();
    /* The playhead has walked out of the stretch the last ask covered. Ask
     * again for where it is NOW, once — guarded on the position that ask was
     * made from, so a reply that still does not cover it cannot spin. */
    if (Math.abs(w.from - (S.ahead.at ?? -1)) > 1e-3) refreshPlan();
    return;
  }
  const late = rows.find((r) => r.verdict === "late");
  const tight = rows.find((r) => r.verdict === "tight");
  const lateN = rows.filter((r) => r.verdict === "late").length;
  const tightN = rows.filter((r) => r.verdict === "tight").length;
  const model = plan.model?.ms ? ` · model ${plan.model.ms}` : "";
  const cal = plan.calibration?.calibrated
    ? `fitted from ${plan.calibration.samples} of this project's own renders on this machine`
    : "the shipped line — this project has not rendered enough regions here to refit it";
  /* WHICH REGIONS THIS VERDICT IS ABOUT, first line of every tooltip. */
  const scope = `Judged: ${w.scope} — bars ${rows[0].fromBar}-${rows[rows.length - 1].toBar}, `
    + `${rows.length} region${rows.length === 1 ? "" : "s"}.`;
  if (late) {
    const lateSay = lateN === 1
      ? `bars ${late.fromBar}-${late.toBar} are expected to take longer than the audio they cover`
      : `${lateN} of them are expected to take longer than the audio they cover — the first is `
        + `bars ${late.fromBar}-${late.toBar}`;
    S.ahead.state = "late";
    S.ahead.txt = `ahead ✗ bars ${late.fromBar}-${late.toBar} · will arrive late`;
    S.ahead.why = `${scope}\n${lateSay}, `
      + `${(late.estimatedMs / 1000).toFixed(1)} s of render for `
      + `${(late.deadlineMs / 1000).toFixed(1)} s of music.\n${plan.note}\n${cal}${model}`;
  } else if (tight) {
    S.ahead.state = "tight";
    S.ahead.txt = `ahead ⏱ ${tightN} region${tightN === 1 ? "" : "s"} · `
      + `${(tight.estimatedMs / 1000).toFixed(1)} s for ${(tight.deadlineMs / 1000).toFixed(1)} s`;
    S.ahead.why = `${scope}\nNothing here is late, but bars ${tight.fromBar}-${tight.toBar} spend more `
      + `than four fifths of their own length rendering. ${beyondNote(plan, rows)}\n`
      + `${plan.note}\n${cal}${model}`;
  } else {
    /* BOTH numbers, because they answer different questions: how much of the
     * window is already on disk, and how much of it there is. "ahead ✓ 0/4"
     * on a freshly opened project is the true reading — nothing prefetched
     * yet, and all four expected to make it. */
    const n = aheadCount(rows, at, w.wrap);
    S.ahead.state = "ok";
    S.ahead.txt = `ahead ✓ ${n}/${rows.length} region${rows.length === 1 ? "" : "s"}`;
    S.ahead.why = `${scope}\n${n} of them ${n === 1 ? "is" : "are"} already rendered, and every one is `
      + `expected to render inside its own length. ${beyondNote(plan, rows)}\n`
      + `${plan.note}\n${cal}${model}`;
  }
  paintBadge();
}

/** One DOM write per real change. paintAhead is cheap and is called from the
 *  transport, the loop controls and the playhead, so the guard is what makes
 *  calling it from all of them free. */
function paintBadge() {
  const key = `${S.ahead.state} ${S.ahead.txt} ${S.ahead.why}`;
  if (key === S.ahead.painted) return;
  S.ahead.painted = key;
  const box = $("aheadBox");
  $("aheadTxt").textContent = S.ahead.txt;
  for (const k of ["d-ok", "d-tight", "d-late"]) box.classList.remove(k);
  if (S.ahead.state !== "idle") box.classList.add(`d-${S.ahead.state}`);
  box.title = S.ahead.why || "look-ahead readiness";
}
$("aheadBox").addEventListener("click", () => {
  refreshPlan();
  status("measuring the look-ahead — render_plan renders nothing, it only predicts");
});

/**
 * THE LOOK-AHEAD RENDER, one wake in seven off the transport's own Worker.
 *
 * It renders exactly ONE region: the one the playhead reaches in `lead`
 * seconds, where `lead` is the region's own measured estimate rather than a
 * guessed constant — asking for a constant is how a monitor promises a region
 * it cannot have. When the region is already on disk with the hash the plan
 * expects, nothing is posted at all.
 *
 * It looks inside the same window the badge judges, and it seeks through
 * aheadAt(), so a loop's last bar prefetches the loop's FIRST region rather
 * than a region the transport will never reach.
 */
async function aheadTick() {
  const session = captureSession();
  const renderRequest = S.renderRequest;
  const current = () => sessionCurrent(session) && renderRequest === S.renderRequest;
  if (!S.playing || !S.slug || S.ahead.busy) return;
  const w = aheadWindow();
  const rows = windowRows(S.ahead.plan?.regions, w);
  if (!rows.length) { refreshPlan(); return; }
  const at = projTime();
  const here = planRegionAt(rows, at);
  const lead = Math.min(30, (here?.estimatedMs ?? 0) / 1000);
  const seek = aheadAt(at, lead);
  const target = planRegionAt(rows, seek);
  if (!target) return;
  if (S.buffers.get(target.idx)?.hash === target.hash) { paintAhead(); return; }
  S.ahead.busy = true;
  const t0 = performance.now();
  try {
    /* at_seconds is the WRAPPED moment and the lead is spent, so the route
     * resolves exactly the region this page already decided on — one region,
     * chosen once, by whichever of us knows about the loop. */
    const r = await api({ action: "render_ahead", slug: session.slug,
                          at_seconds: seek, lead_seconds: 0 });
    if (!current()) return;
    if (r.region) await swapRegion(r.region, session, renderRequest);
    if (!current()) return;
    /* THE HUD LEARNS TO TELL THEM APART. `S.sw` measured gesture→audible for
     * EDITS; a region that arrived late is a different event with a different
     * cause, and averaging the two makes both numbers meaningless. */
    S.sw.push({ ahead: true, regionIdx: r.region?.idx ?? null,
                estMs: r.estimatedMs ?? null, actualMs: r.ms ?? null,
                audible: performance.now() - t0 });
    updateHud();
    /* the plan is now stale by exactly one region: patch that row rather than
     * re-measuring the whole song on a 1 Hz timer */
    const row = rows.find((x) => x.idx === r.region?.idx);
    if (row) { row.cached = true; row.verdict = "ready"; }
    if (r.verdict === "late" || (r.ms > r.deadlineMs && !r.region?.cached)) {
      S.ahead.state = "late";
      S.ahead.txt = `ahead ✗ bars ${r.region?.fromBar}-${r.region?.toBar} · arrived late`;
      S.ahead.why = `That region took ${(r.ms / 1000).toFixed(1)} s to render against `
        + `${(r.deadlineMs / 1000).toFixed(1)} s of audio — measured, not predicted.`;
      paintBadge();
    } else paintAhead();
  } catch (err) {
    if (current()) status(`look-ahead: ${err.message}`);
  } finally {
    if (sessionCurrent(session)) S.ahead.busy = false;
  }
}

/**
 * The dirty-region loop's client half, and THE STOPWATCH. tGesture is when
 * the pointer went down; tAck when the edit route answered. This renders
 * (server re-renders only hash-missing regions), fetches the region files
 * whose urls changed, decodes, swaps — and the moment the last changed buffer
 * is swapped into the schedule is "audible".
 */
function renderAndSwap(tGesture, tAck, dirty, session = captureSession()) {
  if (!sessionCurrent(session) || !session.slug) return Promise.resolve(false);
  const request = ++S.renderRequest;
  const current = () => sessionCurrent(session) && request === S.renderRequest;
  S.pending = dirty || [];
  S.rendering = true;
  cpu("re-rendering…", true);
  drawArr(); draw();
  renderChain = renderChain.catch(() => {}).then(async () => {
    if (!current()) return false;
    try {
      const r = await api({ action: "render", slug: session.slug });
      if (!current()) return false;
      const tRender = performance.now();
      S.regions = r.regions;
      S.totalSeconds = r.totalSeconds;
      const changed = r.regions.filter((g) => S.buffers.get(g.idx)?.url !== g.url);
      await Promise.all(changed.map((g) => swapRegion(g, session, request)));
      if (!current()) return false;
      for (const k of [...S.buffers.keys()]) {
        if (!r.regions.some((g) => g.idx === k)) S.buffers.delete(k);
      }
      const tAudible = performance.now();
      if (tGesture !== undefined) {
        S.sw.push({ ahead: false, ack: tAck - tGesture, render: tRender - tGesture,
                    audible: tAudible - tGesture });
        updateHud();
      }
      cpu(`${r.rendered} rendered · ${r.cachedHits} cached · ${r.ms} ms`, false);
      if (dirty?.length) {
        status(`render: ${r.rendered} rendered, ${r.cachedHits} cached, ${r.ms} ms · dirty: `
          + dirty.map((d) => `bars ${d.fromBar}-${d.toBar}`).join(", "));
      }
      drawCredits(r.credits);
      /* THE VERDICT FOLLOWS THE EDIT. What is dirty has just changed, so what
       * is cached has changed with it, and a badge still showing the previous
       * document's readiness would be worse than no badge. render_plan renders
       * nothing, so this is free. */
      refreshPlan(session);
      if (S.wave.open.size) refreshWaveLanes();
    } catch (err) {
      if (!current()) return false;
      cpu("render failed", false);
      status(`render failed: ${err.message}`);
    } finally {
      if (current()) {
        S.pending = []; S.rendering = false;
        drawArr(); draw();
      }
    }
  });
  return renderChain;
}

function cpu(txt, busy) {
  $("cpuTxt").textContent = txt;
  $("cpuBox").classList.toggle("d-busy", !!busy);
}

/* The transport bar's own sentence about this readout, read once so the HUD
 * can add numbers under it without owning the words. */
const HUD_TIP = $("cpuBox").title;

/**
 * THE STOPWATCH, WITH THE TWO EVENTS KEPT APART.
 *
 * `S.sw` measured one thing — gesture → audible, for an edit. The look-ahead
 * pushes a second kind of record, a region boundary arriving, and the two have
 * different causes: an edit is slow because the dirty region is expensive, a
 * boundary is slow because the chain renders from sample 0. Averaged together
 * neither number means anything, so the p95 on the bar stays the EDIT's and
 * the look-ahead's arrivals are counted beside it in the tooltip.
 */
function updateHud() {
  const edits = S.sw.filter((r) => !r.ahead);
  const ah = S.sw.filter((r) => r.ahead);
  const xs = edits.map((r) => r.audible).sort((a, b) => a - b);
  if (xs.length) {
    const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    $("swLast").textContent = `${Math.round(edits[edits.length - 1].audible)}ms`;
    $("swMed").textContent = `${Math.round(q(0.5))}ms`;
    $("swP95").textContent = `${Math.round(q(0.95))}ms`;
    $("swN").textContent = `n=${xs.length}`;
  }
  const lateN = ah.filter((r) => r.actualMs != null && r.estMs != null && r.actualMs > r.estMs).length;
  $("cpuBox").title = `${HUD_TIP}\n\nlast / med / p95 are EDITS: gesture → audible, n=${xs.length}.`
    + (ah.length ? `\nLook-ahead arrivals: ${ah.length}, ${lateN} of them slower than the estimate.`
      : "\nNo look-ahead renders yet — the badge beside this says whether they will be needed.");
}

/* ─────────────────────────────────────────────── playback + hot swap */

function audioCtx() {
  if (!S.ctx) {
    S.ctx = new AudioContext({ sampleRate: 48000 });
    S.master = S.ctx.createGain();
    S.analyser = S.ctx.createAnalyser();
    S.analyser.fftSize = 2048;
    S.anaBuf = new Float32Array(S.analyser.fftSize);
    S.master.connect(S.analyser).connect(S.ctx.destination);
    /* THE STEREO TAP. The mono analyser above is the master meter's; a
     * goniometer and a correlation meter need the two channels apart, so
     * the master is also split into one analyser per side. These read the
     * SAME samples the speakers get — nothing here is modelled or guessed,
     * which is why they are labelled "live" and go still when you stop. */
    const split = S.ctx.createChannelSplitter(2);
    S.master.connect(split);
    S.anL = S.ctx.createAnalyser(); S.anL.fftSize = 2048;
    S.anR = S.ctx.createAnalyser(); S.anR.fftSize = 2048;
    split.connect(S.anL, 0);
    split.connect(S.anR, 1);
    S.bufL = new Float32Array(S.anL.fftSize);
    S.bufR = new Float32Array(S.anR.fftSize);
    S.freqBuf = new Float32Array(S.analyser.frequencyBinCount);
  }
  return S.ctx;
}
/**
 * THE PLAY WINDOW. There is now exactly one: [a, b) from loopSecs(), which
 * is the whole song until you drag a range on a ruler. Every clock, every
 * scheduled buffer and the click bed are expressed in it, so a loop range
 * is not a second transport bolted on beside the first — it is the same
 * one with different ends.
 */
const projTime = () => {
  if (!S.playing) return S.at || 0;
  const { a, b } = loopSecs();
  const len = b - a;
  const t = audioCtx().currentTime - S.anchor;
  if (!S.loop || len <= 0) return Math.max(0, a + t);
  return a + (((t % len) + len) % len);
};
function setPlayhead(sec) {
  S.at = Math.max(0, sec);
  if (S.playing) { stop(); play(); return; }
  paintClock();
  /* The badge is playhead-RELATIVE with no loop set, so moving the playhead
   * re-judges it. Repaint only — no ask: paintAhead re-asks by itself when
   * the plan in hand no longer covers where you have landed. */
  paintAhead();
  drawArr(); draw(); drawAutoCanvas();
}
function paintClock() {
  refreshStrips();
  const t = projTime();
  const p = qToPosFine(secondsToQ(t));
  $("posLbl").textContent = `${p.bar}.${p.beat}.${p.tick}`;
  const row = rowOf(p.bar);
  $("posSec").textContent = `${t.toFixed(3)} s · ${row ? `${row.num}/${row.den} ${row.bpm}bpm` : ""}`;
}

/** An automated fader must READ what it is doing, not what it did at its
 *  first keyframe — so every keyed readout follows the playhead. Skipped
 *  while a control is under the pointer: a repaint mid-drag fights the hand. */
function refreshStrips() {
  if (S.dragging || !S.paint.length) return;
  for (const f of S.paint) { try { f(); } catch { /* the strip was rebuilt */ } }
}

const FADE = 0.005;                                        // the 5 ms swap fade

function scheduleOcc(iter, idx) {
  const key = `${iter}:${idx}`;
  if (S.nodes.has(key)) return;
  const reg = S.buffers.get(idx);
  if (!reg?.buffer) return;
  const { a, b } = loopSecs();
  const len = b - a;
  /* The region is TRIMMED to the play window: a two-bar loop inside a
   * four-bar region plays two bars, not four. Without this the loop range
   * would be a lie the moment it did not land on a region boundary. */
  const segStart = Math.max(reg.t0, a), segEnd = Math.min(reg.t1, b);
  if (segEnd <= segStart + 1e-4) return;
  const at = S.anchor + iter * len + (segStart - a);
  const ctx = audioCtx();
  const now = ctx.currentTime;
  if (at + (segEnd - segStart) <= now) return;
  const src = ctx.createBufferSource();
  src.buffer = reg.buffer;
  const gain = ctx.createGain();
  src.connect(gain).connect(S.master);
  if (at >= now) {
    gain.gain.setValueAtTime(1, at);
    src.start(at, segStart - reg.t0, segEnd - segStart);
  } else {
    const skip = now - at;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE);
    src.start(now, segStart - reg.t0 + skip, Math.max(0.01, segEnd - segStart - skip));
  }
  src.onended = () => { S.nodes.delete(key); };
  S.nodes.set(key, { src, gain, at, idx });
}

/** The click bed, scheduled in the same window and from the same buffer —
 *  the engine's own bed, trimmed rather than restarted, so it cannot drift
 *  from the render inside a loop. */
function scheduleClick(iter) {
  const key = `c:${iter}`;
  if (S.nodes.has(key) || !S.clickBuf) return;
  const { a, b } = loopSecs();
  const len = b - a;
  const ctx = audioCtx();
  const now = ctx.currentTime;
  const at = S.anchor + iter * len;
  if (at + len <= now) return;
  const src = ctx.createBufferSource();
  src.buffer = S.clickBuf;
  const g = ctx.createGain();
  g.gain.value = 0.5;
  src.connect(g).connect(ctx.destination);        // monitoring, not the mix
  const dur = Math.min(len, Math.max(0.01, S.clickBuf.duration - a));
  if (at >= now) src.start(at, Math.min(a, S.clickBuf.duration), dur);
  else {
    const skip = now - at;
    if (skip >= dur) return;
    src.start(now, Math.min(a + skip, S.clickBuf.duration), dur - skip);
  }
  src.onended = () => { S.nodes.delete(key); };
  S.nodes.set(key, { src, gain: g, at, idx: -1 });
}

function hotSwap(idx) {
  const ctx = audioCtx();
  const now = ctx.currentTime;
  for (const [key, n] of [...S.nodes]) {
    if (n.idx !== idx) continue;
    try {
      n.gain.gain.setValueAtTime(n.gain.gain.value, now);
      n.gain.gain.linearRampToValueAtTime(0, now + FADE);
      n.src.stop(now + FADE);
    } catch { /* already stopped */ }
    S.nodes.delete(key);
    scheduleOcc(Number(key.split(":")[0]), idx);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE TICKER — a Worker, because setInterval is not a floor.
 *
 * The comment that used to sit in schedulerTick called `setInterval(…, 150)`
 * "the 150 ms floor that always runs". It is not one, and the measurement is
 * the reason this function exists: in a hidden tab the gap between wakes was
 * measured at 1 090 ms against a LOOKAHEAD of 0.8 s. A wake 1.09 s late
 * arrives AFTER a region boundary should have started, and scheduleOcc's late
 * branch then starts that buffer part-way in behind a 5 ms fade — so the
 * attack on the downbeat is clipped, in exactly the situation (tab in the
 * background, listening while you work) where nobody is looking at the window
 * to see why. A Worker's timer is not throttled the same way: the same test
 * against a Blob-URL Worker never exceeded 165 ms.
 *
 * It is ~30 lines and depends on nothing. The shape is Tone.js's Ticker
 * (MIT, read for shape, written fresh): build the worker from a Blob URL so
 * there is no second file to serve, and keep a setTimeout fallback for the
 * hosts that refuse to construct one — a page with a throttled clock is worth
 * far more than a page with no clock.
 * ═════════════════════════════════════════════════════════════════════════ */
function makeTicker(fn, ms) {
  let stopped = false;
  let worker = null;
  let timer = null;
  try {
    /* The worker's whole program: wake on an interval and say so. It holds no
     * state and reads nothing, so there is no message protocol to get wrong. */
    const src = `let h=setInterval(()=>postMessage(0),${Number(ms)});`
      + `onmessage=(e)=>{if(e.data==="stop"){clearInterval(h);close();}};`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);                       // the worker holds its own reference
    worker.onmessage = () => { if (!stopped) fn(); };
  } catch (err) {
    /* THE FALLBACK, in this same function on purpose: a reader who wants to
     * know what happens where Worker construction throws (a strict CSP, a
     * sandboxed frame) should not have to look for a second function. A
     * chained setTimeout rather than setInterval, so a slow tick cannot
     * stack up wakes behind itself. */
    worker = null;
    const loop = () => { if (stopped) return; try { fn(); } finally { timer = setTimeout(loop, ms); } };
    timer = setTimeout(loop, ms);
  }
  return {
    kind: worker ? "worker" : "timeout",
    stop() {
      stopped = true;
      if (worker) { try { worker.postMessage("stop"); } catch { /* already gone */ } worker.terminate(); }
      if (timer) clearTimeout(timer);
      worker = null; timer = null;
    },
  };
}

/**
 * THE SELF-HEALING WINDOW.
 *
 * The old loop recomputed `iter0` from `now` and scheduled anything starting
 * inside `[now, now + 0.8]`. That has one failure and it is silent: a wake
 * that arrives late has already stepped PAST a boundary, so the boundary is
 * either dropped or picked up by the late branch with its attack clipped.
 *
 * This one carries `S.lastUpdate` — the end of the window the previous wake
 * filled — and schedules `[S.lastUpdate, now + LOOKAHEAD]`. A late wake makes
 * that window WIDER rather than moving it, so nothing between two wakes can
 * fall through the gap however long the gap was. (Tone.js's Clock keeps its
 * `_nextTick` for the same reason; same idea, our units.) scheduleOcc is
 * idempotent per (iteration, region), so re-covering ground costs nothing.
 */
function schedulerTick() {
  if (!S.playing || !S.totalSeconds) return;
  /* The numeric readout is painted HERE as well as in the rAF loop, because
   * requestAnimationFrame stops in a hidden or non-compositing tab and a
   * transport whose clock silently freezes while the audio keeps rolling is
   * a lie. rAF still does the smooth 60 Hz playhead when the window is up;
   * this runs whether or not the tab is composited. */
  paintClock();
  const ctx = audioCtx();
  const now = ctx.currentTime;
  const { a, b } = loopSecs();
  const len = b - a;
  if (len <= 0) return;
  const to = now + LOOKAHEAD;
  const from = Math.min(S.lastUpdate || now, to);
  const i0 = Math.max(0, Math.floor((from - S.anchor) / len));
  const i1 = Math.floor((to - S.anchor) / len);
  for (let iter = i0; iter <= i1; iter++) {
    if (!S.loop && iter > 0) break;
    if (S.clickBuf && S.anchor + iter * len < to) scheduleClick(iter);
    for (const [idx, reg] of S.buffers) {
      const segStart = Math.max(reg.t0, a), segEnd = Math.min(reg.t1, b);
      if (segEnd <= segStart + 1e-4) continue;
      const at = S.anchor + iter * len + (segStart - a);
      if (at < to && at + (segEnd - segStart) > from) scheduleOcc(iter, idx);
    }
  }
  S.lastUpdate = to;
  /* THE LOOK-AHEAD RENDER rides the same clock, one wake in seven. It is its
   * own function and it is allowed to be slow: it never blocks this one. */
  if ((S.tickN++ % AHEAD_EVERY) === 0) aheadTick();
  if (!S.loop && now - S.anchor > len) stop();
}

async function play(anchorAt) {
  $("dawReturnStems")?.querySelectorAll("audio").forEach((audio) => audio.pause());
  if (S.playing) return stop();
  const ctx = audioCtx();
  await ctx.resume();
  if (!S.buffers.size) await renderAndSwap();
  S.playing = true;
  const { a, b } = loopSecs();
  const from = (S.at || 0) >= a && (S.at || 0) < b ? (S.at || 0) : a;
  S.anchor = typeof anchorAt === "number" ? anchorAt : ctx.currentTime + 0.08 - (from - a);
  S.loop = $("loopChk").checked;
  $("playBtn").textContent = "■";
  $("playBtn").classList.add("d-on");
  if ($("clickChk").checked) startClick();
  /* The window starts HERE, at the audio clock — so the first wake schedules
   * the occurrence already under the playhead (that one legitimately uses
   * scheduleOcc's late branch, because starting mid-region is what "play
   * from bar 47" means) and every wake after it only ever looks forward. */
  S.lastUpdate = ctx.currentTime;
  S.tickN = 0;
  schedulerTick();
  S.ticker = makeTicker(schedulerTick, TICK_MS);
  const raf = () => {
    if (!S.playing) return;
    draw(); drawArr();
    if ($("paneAuto").classList.contains("d-on")) drawAutoCanvas();
    paintClock();
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}

function stop() {
  S.at = projTime();
  S.playing = false;
  S.ticker?.stop();
  S.ticker = null;
  S.lastUpdate = 0;
  for (const [, n] of S.nodes) { try { n.src.stop(); } catch { /* fine */ } }
  S.nodes.clear();
  stopClick();
  $("playBtn").textContent = "▶";
  $("playBtn").classList.remove("d-on");
  paintClock();
  draw(); drawArr();
}

/** The click bed is RENDERED BY THE ENGINE from the meter map — there is no
 *  second clock in this program, so the click cannot drift from the render. */
async function startClick() {
  try {
    const ctx = audioCtx();
    if (!S.clickBuf) {
      const resp = await fetch(`/api/daw/click/${encodeURIComponent(S.slug)}?from_bar=1&countin=0`);
      S.clickBuf = await ctx.decodeAudioData(await resp.arrayBuffer());
    }
    /* The scheduler places it, iteration by iteration, in the same play
     * window the regions use. */
    schedulerTick();
  } catch (err) { status(`click bed unavailable: ${err.message}`); }
}
function stopClick() {
  for (const [key, n] of [...S.nodes]) {
    if (!key.startsWith("c:")) continue;
    try { n.src.stop(); } catch { /* already gone */ }
    S.nodes.delete(key);
  }
}

function toggleLoop() {
  const c = $("loopChk");
  c.checked = !c.checked;
  S.loop = c.checked;
  $("loopBtn").classList.toggle("d-on", c.checked);
  /* looping on makes the range the window; looping off makes it the next
   * AHEAD_REGIONS from the playhead. Different question, different verdict. */
  paintAhead();
  status(`loop ${c.checked ? "on" : "off"}`);
}
$("playBtn").addEventListener("click", () => play());
$("stopBtn").addEventListener("click", () => { stop(); setPlayhead(0); });
$("loopBtn").addEventListener("click", toggleLoop);
$("clickChk").addEventListener("change", () => {
  if (!S.playing) return;
  if ($("clickChk").checked) startClick();
  else stopClick();
});

/* ═════════════════════════════════════════════ the left browser ═════════ */

const PALETTE = { rows: [], packs: [], pick: "pluck" };
$("paletteSearch").addEventListener("input", drawPalette);
$("paletteReady").addEventListener("change", drawPalette);

async function loadPalette() {
  try {
    const r = await get("/api/daw/patches");
    PALETTE.rows = r.patches;
    PALETTE.packs = r.packs;
    PALETTE.dir = r.instrumentsDir;
  } catch (err) { status(`palette: ${err.message}`); return; }
  drawPalette();
  drawKnobs();
}

/* An unlisted family sorts to the very end, so this list has to grow whenever
 * the palette does — guitar, keys and plucked arrived with the sampled packs
 * and were landing below "vocal" until they were named here. */
const FAMILY_ORDER = ["synth", "fx", "piano", "keys", "gm", "drums", "bass", "guitar",
                      "plucked", "strings", "winds", "mallets", "world", "vocal"];

function drawPalette() {
  const box = $("palette");
  box.innerHTML = "";
  const query = $("paletteSearch").value.trim().toLowerCase();
  const visible = PALETTE.rows.filter(r => (!$("paletteReady").checked || r.installed)
    && (!query || `${r.label} ${r.id} ${r.family} ${r.pack?.label || ""}`.toLowerCase().includes(query)));
  if (!visible.length) {
    const empty = document.createElement("p"); empty.className = "d-note";
    empty.textContent = "No matching instruments. Try another search or turn off Ready to play only.";
    box.appendChild(empty);
  }
  const ord = (f) => { const i = FAMILY_ORDER.indexOf(f); return i < 0 ? 99 : i; };
  const fams = [...new Set(visible.map((r) => r.family))].sort((a, b) => ord(a) - ord(b));
  $("palCnt").textContent = `${PALETTE.rows.filter((r) => r.installed).length}/${PALETTE.rows.length} ready`;
  for (const fam of fams) {
    const rows = visible.filter((r) => r.family === fam);
    const d = document.createElement("details");
    d.className = "d-fam";
    d.open = !!query || rows.some((r) => r.id === PALETTE.pick) || fam === "synth" || fam === "piano";
    d.innerHTML = `<summary>${fam}<span class="d-cnt">${rows.filter((r) => r.installed).length}/${rows.length}</span></summary>`;
    for (const row of rows) d.appendChild(patchRow(row));
    box.appendChild(d);
  }
}

function patchRow(row) {
  const el = document.createElement("div");
  const gen = row.kind === "generate";
  el.className = "d-brow" + (gen ? " d-off" : "") + (row.id === PALETTE.pick ? " d-cur" : "");
  const lic = row.pack?.licence?.spdx || (row.kind === "builtin" ? "built-in" : gen ? "n/a" : "");
  el.innerHTML = `<span class="d-nm" title="${row.label}">${row.label}</span>`
    + (lic ? `<span class="d-lic${row.pack?.attribution_required ? " d-req" : ""}" title="${
      row.pack?.licence?.name || (row.kind === "builtin" ? "ships with the Studio" : "")}${
      row.pack?.attribution_required ? " — attribution REQUIRED and shown in the credits panel" : ""}">${lic}</span>` : "");
  if (gen) {
    const note = document.createElement("div");
    note.className = "d-refusal";
    note.textContent = row.refusal || "generate this part with Music 3.0 instead.";
    const w = document.createElement("div");
    w.append(el, note);
    return w;
  }
  if (!row.installed) {
    const b = document.createElement("button");
    b.className = "d-btn d-sm";
    b.textContent = row.pack?.downloading ? "…" : "install";
    b.title = `${row.pack?.label || row.id} — ${
      row.pack?.bytes ? `${(row.pack.bytes / 1e6).toFixed(0)} MB` : "size unknown"}. `
      + "The licence is shown before a single byte moves.";
    b.addEventListener("click", (e) => { e.stopPropagation(); offerInstall(row); });
    el.appendChild(b);
  }
  el.addEventListener("click", () => {
    PALETTE.pick = row.id;
    drawPalette();
    const t = selTrack();
    status(t
      ? `${row.label} selected — “＋” adds a track with it; “use” re-patches ${t.name}`
      : `${row.label} selected — press ＋ in the track column to add a track with it`);
  });
  if (row.installed) {
    const use = document.createElement("button");
    use.className = "d-btn d-sm";
    use.textContent = "use";
    use.title = "point the selected track at this patch (set_track instrument)";
    use.addEventListener("click", async (e) => {
      e.stopPropagation();
      const t = selTrack();
      if (!t) { status("select a track first"); return; }
      await act({ action: "set_track", slug: S.slug, track: t.id, instrument: row.id },
        { action: "set_track", slug: S.slug, track: t.id, instrument: t.instrument.patch },
        `${t.name} → ${row.label}`);
    });
    el.appendChild(use);
    /* The browser could install a pack and never uninstall one — the disk
     * only ever grew. A pack usually serves several patches, so the button
     * names how many it is about to take away. */
    if (row.pack?.id) {
      const sisters = PALETTE.rows.filter((r) => r.pack?.id === row.pack.id);
      const un = document.createElement("button");
      un.className = "d-btn d-sm";
      un.textContent = "✕";
      un.title = `uninstall the ${row.pack.label} pack — ${sisters.length} patch(es), `
        + `${row.pack.bytes ? `${(row.pack.bytes / 1e6).toFixed(0)} MB` : "size unknown"} off the disk (uninstall_pack)`;
      un.addEventListener("click", async (e) => {
        e.stopPropagation();
        const using = (S.proj?.tracks || []).filter((t) => sisters.some((r) => r.id === t.instrument?.patch));
        if (!(await appConfirm(`Uninstall "${row.pack.label}"?\n\n`
          + `It serves ${sisters.length} patch(es): ${sisters.map((r) => r.label).join(", ")}.\n`
          + (using.length ? `${using.length} track(s) in this project use it and will stop rendering: `
              + `${using.map((t) => t.name).join(", ")}.\n` : "")
          + `The files come back with one install; nothing in the project is changed.`))) return;
        try {
          await api({ action: "uninstall_pack", pack: row.pack.id });
          await loadPalette();
          status(`uninstalled ${row.pack.label} — install brings it back, licence gate and all`);
        } catch (err) { status(`uninstall failed: ${err.message}`); }
      });
      el.appendChild(un);
    }
  }
  return el;
}

/* The licence gate, in the UI: nothing downloads before the terms are on
 * screen. The route refuses without accept_licence and hands back the
 * licences it would have accepted — we show exactly those. */
let licPending = null;
async function offerInstall(row) {
  const r = await api({ action: "install_patch", patch: row.id });
  if (r.installed === true || r.ready) { await loadPalette(); status(`${row.label} ready.`); return; }
  if (!r.needsAccept) { await loadPalette(); return; }
  licPending = row;
  $("licTitle").textContent = `${row.label} — licence`;
  $("licBody").innerHTML = (r.licences || []).map((g) => `
    <p><b>${g.label || g.pack}</b><br>
    ${g.licence?.name || ""} <span class="d-mono">${g.licence?.spdx || ""}</span><br>
    ${g.attribution ? `<i>Attribution:</i> ${g.attribution}<br>` : ""}
    ${g.licence?.url ? `<a href="${g.licence.url}" target="_blank" rel="noreferrer">${g.licence.url}</a>` : ""}
    ${g.attribution_required ? `<br><b>Attribution is required</b> — it will be shown in the Credits panel and written into every bounce.` : ""}
    </p>`).join("");
  $("licSize").textContent = `${(r.bytes / 1e6).toFixed(0)} MB to download. ${r.note || ""}`;
  $("licDlg").showModal();
}
$("licCancel").addEventListener("click", () => { licPending = null; $("licDlg").close(); });
$("licAccept").addEventListener("click", async () => {
  const row = licPending;
  $("licDlg").close();
  if (!row) return;
  status(`downloading ${row.label}… (the request completes when the pack is on disk)`);
  try {
    await api({ action: "install_patch", patch: row.id, accept_licence: true });
    await loadPalette();
    status(`${row.label} installed.`);
  } catch (err) { status(`install failed: ${err.message}`); }
});

/* ── the credits the instrument column accumulates, given a home ─────── */

function drawCredits(credits) {
  if (credits) S.credits = credits;
  const rows = S.credits || [];
  $("credCnt").textContent = rows.length ? `${rows.length}` : "none yet";
  const box = $("credits");
  box.innerHTML = rows.length ? "" : `<div class="d-note">Nothing licensed in this project yet.
    Attribution-required packs (Salamander, the AVL kits) add a line here the moment a render uses them.</div>`;
  for (const c of rows) {
    const d = document.createElement("div");
    d.className = "d-credit" + (c.required ? " d-req" : "");
    d.innerHTML = `<div class="d-nm">${c.pack} <span class="d-mono">${c.spdx || ""}</span></div>`
      + `<div>${c.licence || ""}</div>`
      + (c.attribution ? `<div class="d-att">${c.attribution}</div>` : "")
      + (c.source ? `<a href="${c.source}" target="_blank" rel="noreferrer">${c.source}</a>` : "")
      + (c.required ? `<div class="d-att"><b>Attribution required</b> — this line must travel with the audio.</div>` : "");
    box.appendChild(d);
  }
}

/* ── the session log: who did what, agent or human ──────────────────── */

function drawLog() {
  const box = $("logBox");
  const rows = (S.proj?.ledger || []).slice(0, 40);
  $("logCnt").textContent = `${(S.proj?.ledger || []).length}`;
  box.innerHTML = "";
  for (const e of rows) {
    const d = document.createElement("div");
    d.className = `d-logrow d-${e.by === "agent" ? "agent" : "user"}`;
    const at = new Date(e.at);
    d.innerHTML = `<span class="d-la">${e.by === "agent" ? "AI" : "you"}</span>`
      + `<span class="d-ld" title="${e.detail || ""}">${e.action}${e.detail ? ` · ${e.detail}` : ""}</span>`
      + `<span>${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}</span>`;
    box.appendChild(d);
  }
}

/* ── presets: the four generate rows are shown honestly elsewhere; here
 *    live the project-shaped starting points, all built from real actions. */

const PRESETS = [
  { id: "fourfour", label: "16 bars · 4/4 · 120", note: "the default sketch",
    build: async (slug) => { await api({ action: "set_meter", slug, at_bar: 1, num: 4, den: 4 }); } },
  { id: "seveneight", label: "7/8 from bar 1", note: "the odd-meter grid, honestly uneven",
    build: async (slug) => { await api({ action: "set_meter", slug, at_bar: 1, num: 7, den: 8 }); } },
  { id: "midsong", label: "4/4 → 7/8 at bar 9", note: "a meter change mid-song",
    build: async (slug) => {
      await api({ action: "set_meter", slug, at_bar: 1, num: 4, den: 4 });
      await api({ action: "set_meter", slug, at_bar: 9, num: 7, den: 8 });
    } },
  { id: "verbbus", label: "Reverb return + sends", note: "a return with a reverb, and every track sending to it",
    build: async (slug) => {
      const r = await api({ action: "return_add", slug, name: "Verb" });
      await api({ action: "insert_add", slug, target: r.returnId, type: "reverb" });
      for (const t of S.proj.tracks) {
        await api({ action: "send_set", slug, track: t.id, to: r.returnId, level: -12 });
      }
    } },
  { id: "masterbus", label: "Master glue", note: "compressor + limiter on the master chain",
    build: async (slug) => {
      await api({ action: "insert_add", slug, target: "master", type: "compressor",
                  params: { threshold_db: -14, ratio: 2, attack_ms: 20, release_ms: 200 } });
      await api({ action: "insert_add", slug, target: "master", type: "limiter", params: { ceiling_db: -1 } });
    } },
];

function drawPresets() {
  const box = $("presetList");
  box.innerHTML = "";
  for (const p of PRESETS) {
    const el = document.createElement("div");
    el.className = "d-brow";
    el.innerHTML = `<span class="d-nm" title="${p.note}">${p.label}</span>`;
    el.addEventListener("click", async () => {
      if (!S.slug) return;
      const t0 = performance.now();
      try {
        await p.build(S.slug);
        await refreshDoc();
        renderAndSwap(t0, performance.now(), null);
        status(`${p.label} — ${p.note}`);
      } catch (err) { status(err.message); }
    });
    box.appendChild(el);
  }
}

/* ═════════════════════════════════════ the knob panel (agent/dawparity) ══
 *
 * A patch DECLARES its knobs in patches.json — min, max, default, unit, doc
 * — the one table store.js clamps against, drums.py and synths.py resolve
 * against and daw_patches publishes. daw_set_track forwards a params object,
 * so an agent could open the lead's filter or shorten the kick while a
 * person had no knob to turn: eight patches, sixty-odd knobs, one hand.
 *
 * This panel is the human hand. It is drawn FROM the served row (no knob
 * name lives in this file — a knob synths.py grows renders for free, exactly
 * as the device strip renders a device rack.py grows), and every turn writes
 * set_track with the track's params merged, because set_track REPLACES
 * params. Defaults are not stored (the store drops a value equal to the
 * declared default so an untouched track hashes as {}), so a knob reads the
 * track's own value and falls back to the declared default. A turn is
 * undoable: the previous params are the inverse. Presets are the row's own
 * data (hybrid_kick's measured `bigroom`), sent as params by a button —
 * nothing applies one for you, here or on the agent's side.
 *
 * Params are part of the region hash, so a turn re-renders exactly the
 * regions the track sounds in; the render honesty display shows it. */

/* The two knobs EVERY patch accepts (store.js normParams): whole-track
 * transpose and an instrument gain. ui_test.js holds this table to the
 * store's own clamps. */
const TRACK_KNOBS = {
  transpose: { min: -48, max: 48, default: 0, unit: "st",
               doc: "Whole-track pitch offset in semitones, applied at render — the notes stay where they are." },
  gain_db: { min: -24, max: 24, default: 0, unit: "dB",
             doc: "Instrument gain inside the note render, before the mixer strip. Part of the region hash." },
};

function drawKnobs() {
  const box = $("knobs");
  box.innerHTML = "";
  const t = selTrack();
  const pid = t?.instrument?.patch;
  const row = pid ? PALETTE.rows.find((r) => r.id === pid) : null;
  if (!t) {
    $("knobCnt").textContent = "";
    $("knobNote").textContent = "Select a track — its patch's declared knobs appear here, read from the served row, "
      + "and a turn writes set_track params: the same knobs, through the same action, an agent turns with daw_set_track.";
    return;
  }
  const declared = row?.params || {};
  const all = { ...TRACK_KNOBS, ...declared };
  const n = Object.keys(declared).length;
  $("knobCnt").textContent = `${t.name} · ${n ? `${n} declared + 2` : "2 universal"}`;
  for (const [pname, pspec] of Object.entries(all)) box.appendChild(knobControl(t, pname, pspec));
  const presets = Object.entries(row?.presets || {});
  if (presets.length) {
    const pr = document.createElement("div");
    pr.className = "d-presets";
    for (const [pname, p] of presets) {
      const b = document.createElement("button");
      b.className = "d-btn d-sm";
      b.textContent = pname;
      b.title = `${p.doc || "a named knob setting on this row"}\n\nsends as params: ${JSON.stringify(p.params)}`;
      b.onclick = () => setTrackParams(t, p.params, `${t.name} ← ${pid} preset “${pname}”`);
      pr.appendChild(b);
    }
    box.appendChild(pr);
  }
  const set = Object.keys(t.instrument?.params || {}).filter((k) => all[k]);
  $("knobNote").innerHTML = `<b>${row?.label ?? pid}</b>${n ? "" : " declares no knobs of its own"}. `
    + (set.length ? `Set: ${set.join(", ")} — the rest sit at their declared defaults and are not stored. `
                  : "Everything at its declared default; nothing stored. ")
    + "Drag a knob vertically (shift = fine), double-click for the default. Each turn is a set_track with params "
    + "and re-renders only the regions this track sounds in.";
}

function knobControl(t, pname, pspec) {
  const wrap = document.createElement("div");
  wrap.className = "d-param";
  /* One integer-valued knob exists (the lead's unison count); an integer
   * range under two dozen wide with a unit of nothing is stepped whole. */
  const whole = pspec.unit === "" && pspec.max - pspec.min > 1 && pspec.max - pspec.min < 24
    && [pspec.min, pspec.max, pspec.default].every(Number.isInteger);
  const lab = document.createElement("div");
  lab.className = "d-plab";
  lab.textContent = pname.replace(/_/g, " ");
  lab.title = `${pname} ${pspec.min}..${pspec.max} (default ${pspec.default}${pspec.unit ? ` ${pspec.unit}` : ""})`
    + ` — ${pspec.doc || ""} Drag vertically; shift = fine; double-click = default. Writes set_track params.`;
  const v = Number(t.instrument?.params?.[pname] ?? pspec.default);
  const k = document.createElement("div");
  k.className = "d-knob";
  const val = document.createElement("div");
  val.className = "d-pval";
  const norm = (x) => (x - pspec.min) / (pspec.max - pspec.min);
  const show = (x) => `${whole ? String(Math.round(x)) : fmt(x)}${pspec.unit ? ` ${pspec.unit}` : ""}`;
  const paint = (x) => {
    k.style.setProperty("--d-k", `${norm(x) * 0.75}turn`);
    k.style.setProperty("--d-ka", `${-140 + norm(x) * 280}deg`);
    val.textContent = show(x);
  };
  paint(v);
  let drag = null;
  k.addEventListener("pointerdown", (e) => {
    drag = { y: e.clientY, cur: v };
    S.dragging = true;
    capturePointer(k, e.pointerId);
  });
  k.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const step = (pspec.max - pspec.min) / (e.shiftKey ? 900 : 180);
    drag.cur = Math.max(pspec.min, Math.min(pspec.max, drag.cur - (e.clientY - drag.y) * step));
    drag.y = e.clientY;
    paint(whole ? Math.round(drag.cur) : drag.cur);
  });
  k.addEventListener("pointerup", async (e) => {
    const d = drag; drag = null;
    S.dragging = false;
    if (!d) return;
    releasePointer(k, e.pointerId);
    const nv = whole ? Math.round(d.cur) : d.cur;
    if (nv === v) { paint(v); return; }
    await setTrackParams(t, { [pname]: nv }, `${t.name} ${pname} → ${show(nv)}`);
  });
  k.addEventListener("dblclick", () => setTrackParams(t, { [pname]: pspec.default }, `${t.name} ${pname} → default`));
  wrap.append(k, val, lab);
  return wrap;
}

/** THE ONE WRITER: set_track with the track's params merged (set_track
 *  replaces params), the previous params as the inverse. */
function setTrackParams(t, patch, label) {
  const before = { ...(t.instrument?.params || {}) };
  return act(
    { action: "set_track", slug: S.slug, track: t.id, params: { ...before, ...patch } },
    { action: "set_track", slug: S.slug, track: t.id, params: before },
    label || `${t.name} params`);
}

/* ═══════════════════════════════════════════ tracks, meter, tempo ═══════ */

function selectTrack(id) {
  const changed = S.trackId !== id;
  S.trackId = id;
  S.sel.clear();
  S.devTarget = { kind: "track", id };
  drawSide(); drawArr(); draw(); drawMixer(); drawDevices(); drawAutoPane(); drawKnobs();
  /* A new track means new notes, and the fitted window follows them. */
  if (changed) fitRoll();
  paintSelInfo();
}

/** What is selected, and where the editor is looking — the two things the
 *  status bar was not saying. */
function paintSelInfo() {
  const t = selTrack();
  const count = selNotes().filter(({ n }) => S.sel.has(n.id)).length;
  $("noteSelection").textContent = t ? (count ? `${count} selected · ${t.name}` : `${t.name} · Select notes to edit`) : "Select a track to edit notes";
  for (const id of ["notesDuplicate", "notesDelete", "notesClear", "quantBtn", "velApply", "velHuman"]) $(id).disabled = !count;
  $("notesAll").disabled = !t || !selNotes().length;
  const el = $("selInfo");
  if (el) {
    el.textContent = t
      ? `${t.name} · ${S.sel.size ? `${S.sel.size} selected` : `${selNotes().length} notes`}`
        + ` · grid ${$("gridSel").selectedOptions[0]?.textContent ?? ""} · ${S.mode}`
      : "no track";
  }
  const info = $("edInfo");
  if (info) {
    info.textContent = `pitches ${NOTE_NAMES[S.rollLo % 12]}${Math.floor(S.rollLo / 12) - 1}`
      + `–${NOTE_NAMES[S.rollHi % 12]}${Math.floor(S.rollHi / 12) - 1}`
      + ` · ${S.rowH}px/row · ${S.pxq.toFixed(0)}px/quarter`;
  }
}

async function refreshDoc(session = captureSession()) {
  if (!sessionCurrent(session) || !session.slug) return false;
  const read = ++S.docRead;
  let r;
  try { r = await get(`/api/daw/project/${encodeURIComponent(session.slug)}`); }
  catch (err) { if (!sessionCurrent(session) || read !== S.docRead) return false; throw err; }
  if (!sessionCurrent(session) || read !== S.docRead) return false;
  S.proj = r.project;
  S.timeline = r.timeline;
  S.totalSeconds = r.totalSeconds;
  /* WHERE THE PANELS ARE, RESTORED — and followed. This is the only place the
   * page reads the view, which is what makes opening a project, an agent's
   * daw_layout and this page's own echo one code path instead of three.
   * repaint:false because every canvas it would re-fit is redrawn below. */
  S.view = S.proj.view || null;
  applyViewFromDoc();
  if (!S.proj.tracks.some((t) => t.id === S.trackId)) S.trackId = S.proj.tracks[0]?.id ?? null;
  if (!S.devTarget) S.devTarget = S.trackId ? { kind: "track", id: S.trackId } : { kind: "master", id: "master" };
  S.lanes = S.lanes.filter((k) => laneRef(k));
  $("lenBars").value = S.proj.lengthBars;
  /* A loop range that outlived a shortened song is a loop range that plays
   * silence — clamp it to what the document now is. */
  if (S.loopB != null && S.loopB > S.proj.lengthBars + 1) setLoopSilent(null, null);
  drawSide(); drawArr(); draw(); drawMixer(); drawDevices(); drawLog(); drawHistory(); drawKnobs();
  if ($("paneAuto").classList.contains("d-on")) drawAutoPane();
  paintClock();
  paintSelInfo();
  if (S.rollFit) fitRoll();
  return true;
}
/** Set the loop without restarting the transport (used while re-reading). */
function setLoopSilent(a, b) { S.loopA = a; S.loopB = b; paintLoopLabel(); paintAhead(); }

/** The arrangement's track heads, aligned row-for-row with the canvas. */
function drawSide() {
  const box = $("tracks");
  box.innerHTML = "";
  if (!S.proj) return;
  for (const t of S.proj.tracks) {
    const div = document.createElement("div");
    div.className = "d-th" + (t.id === S.trackId ? " d-cur" : "");
    div.style.height = `${LANE_H}px`;
    div.style.setProperty("--d-trk", colourOf(t.id));
    const notes = t.clips.reduce((a, c) => a + c.notes.length, 0);
    div.innerHTML = `<div class="d-thtop"><span class="d-nm" title="${t.name} — double-click to rename (set_track)">${t.name}</span></div>
      <div class="d-inst">${t.instrument?.patch ?? t.instrument} · ${notes}n${
        (t.audioClips || []).length ? ` · ${t.audioClips.length}a` : ""}</div>`;
    div.querySelector(".d-nm").addEventListener("dblclick", (e) => {
      e.stopPropagation();
      renameTrack(t);
    });
    const chip = document.createElement("span");
    chip.className = "d-chip";
    chip.title = "track colour — click to pick one";
    chip.addEventListener("click", (e) => { e.stopPropagation(); openColour(t); });
    div.querySelector(".d-thtop").insertBefore(chip, div.querySelector(".d-nm"));
    const btns = document.createElement("div");
    btns.className = "d-thbtns";
    const mk = (txt, title, on, fn) => {
      const b = document.createElement("button");
      b.className = "d-btn d-sm" + (on ? " d-on" : "");
      b.textContent = txt; b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    btns.append(
      mk("M", "mute (set_track)", t.mute, () => act(
        { action: "set_track", slug: S.slug, track: t.id, mute: !t.mute },
        { action: "set_track", slug: S.slug, track: t.id, mute: !!t.mute }, `${t.name} mute`)),
      mk("S", "solo (mixer_set)", t.solo, () => act(
        { action: "mixer_set", slug: S.slug, target: t.id, solo: !t.solo },
        { action: "mixer_set", slug: S.slug, target: t.id, solo: !!t.solo }, `${t.name} solo`)),
      mk("●", "arm for recording (record_arm)", t.armed, async () => {
        await api({ action: "record_arm", slug: S.slug, track: t.id, armed: !t.armed });
        await refreshDoc();
      }),
      mk("〜", "Render this track's post-fader waveform. Shared effect return previews appear in Audio. "
        + "All track stems plus returns reconstruct the pre-master mix; master processing is excluded.",
        S.wave.open.has(t.id), () => toggleWaveLane(t.id)),
      mk("✕", "remove this track (remove_track)", false, () => act(
        { action: "remove_track", slug: S.slug, track: t.id }, null, `remove ${t.name}`)),
    );
    div.querySelector(".d-thtop").appendChild(btns);
    div.addEventListener("click", () => selectTrack(t.id));
    box.appendChild(div);
    /* Track waveforms exclude the shared returns and master processing. */
    if (S.wave.open.has(t.id)) {
      const wl = document.createElement("div");
      wl.className = "d-th d-wavehead";
      wl.style.height = `${WAVE_H}px`;
      wl.title = "Post-fader track stem, before master processing. Add all tracks and the separate "
        + "effect returns to reconstruct the pre-master mix. Left channel above, right below; "
        + "waveform height uses the same scale for every track.";
      wl.innerHTML = `<div class="d-wavenote">〜 ${S.wave.note || "stem · pre-master"}</div>`;
      wl.addEventListener("click", () => toggleWaveLane(t.id));
      box.appendChild(wl);
    }
    // spacers keeping the heads aligned with any open automation lanes
    for (const key of S.lanes) {
      if (!key.startsWith(`trk:${t.id}:`)) continue;
      const lane = document.createElement("div");
      lane.className = "d-th";
      lane.style.height = `${AUTO_H}px`;
      lane.innerHTML = `<div class="d-inst" title="${laneRef(key)?.label || key}">↳ ${
        (laneRef(key)?.label || key).split("·").pop().trim()}</div>`;
      lane.addEventListener("click", () => { S.laneCur = key; showPane("auto"); });
      box.appendChild(lane);
    }
  }

  const ev = $("events");
  ev.innerHTML = "";
  const evRow = (txt, onDel) => {
    const d = document.createElement("div");
    d.className = "d-brow";
    d.innerHTML = `<span class="d-nm">${txt}</span>`;
    if (onDel) {
      const b = document.createElement("button");
      b.className = "d-btn d-sm"; b.textContent = "✕";
      b.addEventListener("click", onDel);
      d.appendChild(b);
    }
    ev.appendChild(d);
  };
  evRow(`${S.proj.lengthBars} bars · ${S.totalSeconds.toFixed(2)} s`);
  for (const m of S.proj.meterMap) {
    evRow(`bar ${m.atBar}: ${m.num}/${m.den}`, m.atBar > 1
      ? () => act({ action: "remove_meter", slug: S.slug, at_bar: m.atBar }, null, "remove meter change")
      : null);
  }
  for (const m of S.proj.tempoMap) {
    evRow(`bar ${m.atBar}: ${m.bpm} bpm`, m.atBar > 1
      ? () => act({ action: "remove_tempo", slug: S.slug, at_bar: m.atBar }, null, "remove tempo change")
      : null);
  }
  drawTakes();
  drawClips();
  drawAudioClips();
  drawReturnStems();
}

/** Rename through set_track — the same action an MCP rename posts. */
async function renameTrack(t) {
  const name = (await appPrompt("Track name", t.name));
  if (name === null || name === t.name) return;
  act({ action: "set_track", slug: S.slug, track: t.id, name },
    { action: "set_track", slug: S.slug, track: t.id, name: t.name },
    `renamed ${t.name} → ${name}`);
}

/* ── the track colour picker ─────────────────────────────────────────── */

let colTrack = null;
function openColour(t) {
  colTrack = t;
  const box = $("colBody");
  box.innerHTML = "";
  const cur = colourIxOf(t.id);
  for (let i = 0; i < TRK_COLOURS; i++) {
    const sw = document.createElement("div");
    sw.className = "d-sw" + (i === cur ? " d-cur" : "");
    sw.style.setProperty("--d-trk", colourOfIx(i));
    sw.title = `colour ${i + 1}`;
    sw.addEventListener("click", () => {
      S.colours[t.id] = i;
      saveColours();
      drawSide(); drawArr(); draw(); drawMixer();
      openColour(t);
    });
    box.appendChild(sw);
  }
  $("colNote").innerHTML = `<b>${t.name}</b> — derived colour ${colourIx(t.id) + 1}`
    + (Number.isInteger(S.colours[t.id]) ? `, overridden to ${S.colours[t.id] + 1}.` : ".")
    + ` The override is stored in this browser only: <span class="d-mono">set_track</span> `
    + `has no colour field yet, and this page will not invent a second place to `
    + `keep part of the document.`;
  $("colDlg").showModal();
}
$("colReset").addEventListener("click", () => {
  if (!colTrack) return;
  delete S.colours[colTrack.id];
  saveColours();
  drawSide(); drawArr(); draw(); drawMixer();
  openColour(colTrack);
});
$("colClose").addEventListener("click", () => $("colDlg").close());

async function addTrackFromBrowser() {
  const inst = PALETTE.pick || "pluck";
  const r = await act({ action: "add_track", slug: S.slug, instrument: inst }, null, `add ${inst} track`);
  if (r?.trackId) {
    pushUndo({ body: { action: "remove_track", slug: S.slug, track: r.trackId },
               forward: { action: "add_track", slug: S.slug, instrument: inst },
               inverseFrom: (rr) => ({ body: { action: "remove_track", slug: S.slug, track: rr?.trackId } }),
               label: `add ${inst} track` });
    selectTrack(r.trackId);
  }
}
$("addTrackBtn").addEventListener("click", addTrackFromBrowser);

$("mSet").addEventListener("click", () => act(
  { action: "set_meter", slug: S.slug, at_bar: Number($("mBar").value),
    num: Number($("mNum").value), den: Number($("mDen").value) },
  null, `meter ${$("mNum").value}/${$("mDen").value} at bar ${$("mBar").value}`));
$("tSet").addEventListener("click", () => act(
  { action: "set_tempo", slug: S.slug, at_bar: Number($("tBar").value), bpm: Number($("tBpm").value) },
  null, `${$("tBpm").value} bpm at bar ${$("tBar").value}`));
$("lenSet").addEventListener("click", () => act(
  { action: "set_length", slug: S.slug, length_bars: Number($("lenBars").value) },
  { action: "set_length", slug: S.slug, length_bars: S.proj.lengthBars }, "project length"));

/* ── [DAWREC] the take lane of the selected track ─────────────────────── */

function drawTakes() {
  const box = $("takes");
  box.innerHTML = "";
  const t = selTrack();
  if (!t) return;
  const takes = t.takes || [];
  if (!takes.length) {
    box.innerHTML = `<div class="d-note">no takes on ${t.name} — arm it and press ●</div>`;
    return;
  }
  for (const k of takes) {
    const d = document.createElement("div");
    d.className = "d-brow";
    const secs = (k.samples / (k.sr || 48000)).toFixed(1);
    d.innerHTML = `<span class="d-nm" title="${k.device || ""} · shift ${k.shiftSamples}">${k.name} · ${secs}s</span>`;
    const mk = (txt, title, fn) => {
      const b = document.createElement("button");
      b.className = "d-btn d-sm"; b.textContent = txt; b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    d.append(
      mk("▶", "audition this take alone", () => auditionTake(k)),
      mk("use", "comp the whole take onto the track (it then renders in the mix)", () => act(
        { action: "take_comp", slug: S.slug, track: t.id, whole_take: k.id, name: `${k.name} (comp)` },
        null, `comped ${k.name}`)),
      mk("✕", "delete take + file", async () => {
        await api({ action: "take_delete", slug: S.slug, track: t.id, take: k.id });
        await refreshDoc();
      }),
    );
    box.appendChild(d);
  }
}

/* ── MIDI CLIPS: the container that decides what sounds ──────────────────
 * `add_clip` / `remove_clip` / `set_clip` were agent-only, so a human could
 * never make a four-bar section clip — the window relied on the automatic
 * full-length clip and nothing else. This list is the human half of them;
 * the arrangement's drag-to-move and drag-to-trim are the other half, and
 * both post the same three actions an MCP tool posts. */
function drawClips() {
  const box = $("clipList");
  box.innerHTML = "";
  const t = selTrack();
  $("clipCnt").textContent = t ? `${t.clips.length} on ${t.name}` : "";
  if (!t) return;
  if (!t.clips.length) {
    box.innerHTML = `<div class="d-note">no clips on ${t.name} — press ＋ to add one at the playhead</div>`;
    return;
  }
  for (const c of t.clips) {
    const outside = c.notes.filter((n) => n.bar < c.fromBar || n.bar > c.toBar).length;
    const d = document.createElement("div");
    d.className = "d-brow";
    d.innerHTML = `<span class="d-nm" title="${c.id} — drag its body in the arrangement to move it, its edges to trim it">`
      + `${c.name || "clip"} · bars ${c.fromBar}–${c.toBar} · ${c.notes.length}n`
      + (outside ? ` · <b>${outside} silent</b>` : "") + `</span>`;
    const mk = (txt, title, fn) => {
      const b = document.createElement("button");
      b.className = "d-btn d-sm"; b.textContent = txt; b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    d.append(
      mk("↦", "move this clip to the playhead's bar (set_clip from_bar — its notes ride along)", () => {
        const at = Math.max(1, Math.floor(barFloatNow()));
        act({ action: "set_clip", slug: S.slug, track: t.id, clip: c.id, from_bar: at },
          { action: "set_clip", slug: S.slug, track: t.id, clip: c.id, from_bar: c.fromBar },
          `clip → bar ${at}`);
      }),
      mk("name", "rename this clip (set_clip name)", async () => {
        const name = (await appPrompt("Clip name", c.name || "clip"));
        if (name === null) return;
        act({ action: "set_clip", slug: S.slug, track: t.id, clip: c.id, name },
          { action: "set_clip", slug: S.slug, track: t.id, clip: c.id, name: c.name || "clip" },
          `clip renamed → ${name}`);
      }),
      mk("✕", `remove this clip AND its ${c.notes.length} note(s) (remove_clip) — this one really deletes`, async () => {
        if (!(await appConfirm(`Remove "${c.name || "clip"}" (bars ${c.fromBar}–${c.toBar}) and its ${c.notes.length} note(s)?`
          + `\n\nUnlike shrinking a clip, this deletes the notes.`))) return;
        act({ action: "remove_clip", slug: S.slug, track: t.id, clip: c.id }, null,
          `removed clip ${c.name || c.id}`);
      }),
    );
    d.addEventListener("click", () => {
      setPlayhead(secAtQ(rowOf(c.fromBar)?.qStart ?? 0));
      status(`${c.name || "clip"}: bars ${c.fromBar}–${c.toBar}, ${c.notes.length} note(s)`
        + (outside ? `, ${outside} outside the clip and therefore silent` : ""));
    });
    box.appendChild(d);
  }
}
$("clipAdd").addEventListener("click", async () => {
  const t = selTrack();
  if (!t) { status("select a track first"); return; }
  const from = Math.max(1, Math.floor(barFloatNow()));
  const r = await act({ action: "add_clip", slug: S.slug, track: t.id, from_bar: from, bars: 4 },
    null, `clip at bars ${from}–${from + 3}`);
  if (r?.clipId) {
    pushUndo({ body: { action: "remove_clip", slug: S.slug, track: t.id, clip: r.clipId },
               forward: { action: "add_clip", slug: S.slug, track: t.id, from_bar: from, bars: 4 },
               inverseFrom: (rr) => ({ body: { action: "remove_clip", slug: S.slug, track: t.id, clip: rr?.clipId } }),
               label: `clip at bars ${from}–${from + 3}` });
  }
});

function drawAudioClips() {
  const box = $("audioList");
  box.innerHTML = "";
  const t = selTrack();
  const clips = t?.audioClips || [];
  if (!clips.length) return;
  for (const c of clips) {
    const d = document.createElement("div");
    d.className = "d-brow d-audio-clip";
    const label = document.createElement("span"); label.className = "d-audio-clip-info";
    const name = document.createElement("span"); name.className = "d-nm";
    name.textContent = c.name; name.title = c.file;
    const details = audioResultDetails(c, S.proj.sr || 48000);
    const meta = document.createElement("span"); meta.className = "d-audio-clip-meta";
    meta.textContent = `${details.summary} @ ${c.bar}.${c.beat}.${c.tick}`;
    label.append(name, meta);
    if (details.notice) {
      const notice = document.createElement("span"); notice.className = "d-audio-clip-notice";
      notice.textContent = details.notice; label.appendChild(notice);
    }
    d.appendChild(label);
    const b = document.createElement("button");
    b.className = "d-btn d-sm"; b.textContent = "✕";
    b.title = "remove this audio clip (remove_audio_clip)";
    b.addEventListener("click", () => act(
      { action: "remove_audio_clip", slug: S.slug, track: t.id, clip: c.id }, null, `removed ${c.name}`));
    d.appendChild(b);
    box.appendChild(d);
  }
}

let auditionNode = null;
async function auditionTake(k) {
  const ctx = audioCtx();
  await ctx.resume();
  try { auditionNode?.stop(); } catch { /* fine */ }
  const bytes = await (await fetch(`/api/daw/take/${encodeURIComponent(S.slug)}/${encodeURIComponent(k.file)}`)).arrayBuffer();
  const buf = await ctx.decodeAudioData(bytes);            // Chrome decodes FLAC
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(S.master);
  src.start();
  auditionNode = src;
  status(`auditioning ${k.name} (${buf.duration.toFixed(1)}s) — solo, out of context`);
}

/* ═══════════════════════════════════════════ AUDITIONING A NOTE ═════════
 * `preview_note` renders ONE note through the track's real patch — the
 * same instrument stage the mix uses, so what you hear is what will be
 * printed — and answers a wav url. It is a SERVER ROUND TRIP: tens of
 * milliseconds, not low-latency monitoring. The UI says so rather than
 * implying a keyboard.
 *
 * Everything below exists to keep that from becoming annoying, which is
 * the only reason auditioning gets switched off in other editors:
 *
 *   ONE VOICE      a new audition stops the one still ringing, so dragging
 *                  across an octave is a glissando and not a chord.
 *   NO BACKLOG     every request takes a sequence number and only the
 *                  newest may be heard. A reply that lands after a newer
 *                  request was made is dropped on arrival — a burst of
 *                  twenty drags plays the note you STOPPED on, not twenty
 *                  notes queued behind it.
 *   PITCH-GATED    a drag auditions when the pitch actually CHANGES, and
 *                  no more often than AUDITION_MS. Moving a note along the
 *                  time axis is silent, which is what a console does.
 *   CACHED         decoded buffers are kept by url. The server caches the
 *                  render, so a note you have heard before is a Map hit
 *                  and a fetch of nothing.
 *   OPTIONAL       some people hate it: the roll's `audition` box turns
 *                  the whole thing off and is remembered.
 */
const AUDITION_MS = 90;                 // the floor between two drag auditions
const AUD_CACHE_MAX = 96;               // decoded buffers kept, by url

function auditionEnabled() { return S.aud.on; }

/** Stop whatever is ringing. Silence is always a legal audition. */
function auditionStop() {
  try { S.aud.node?.stop(); } catch { /* already ended */ }
  S.aud.node = null;
}

async function auditionNote(pitch, vel = 100, durTicks = null) {
  if (!S.aud.on || !S.slug || !S.trackId || pitch == null) return;
  /* the sequence number IS the cancellation: taking a new one invalidates
   * every reply still in flight, at both await points below. */
  const seq = ++S.aud.seq;
  try {
    const body = { action: "preview_note", slug: S.slug, track: S.trackId,
                   pitch: Math.max(0, Math.min(127, Math.round(pitch))),
                   vel: Math.max(1, Math.min(127, Math.round(vel || 100))) };
    if (durTicks) body.dur_ticks = Math.max(1, Math.min(TPB * 8, Math.round(durTicks)));

    const ctx = audioCtx();
    let buf = null;
    /* try the decode cache before the network: the key is the url the
     * server would answer with, so this only skips work already done. */
    const r = await api(body);
    if (seq !== S.aud.seq) return;                 // a newer note is already coming
    buf = S.aud.cache.get(r.url);
    if (!buf) {
      buf = await ctx.decodeAudioData(await (await fetch(r.url)).arrayBuffer());
      if (S.aud.cache.size >= AUD_CACHE_MAX) S.aud.cache.delete(S.aud.cache.keys().next().value);
      S.aud.cache.set(r.url, buf);
    }
    if (seq !== S.aud.seq) return;                 // …and it arrived while we decoded
    await ctx.resume();
    if (seq !== S.aud.seq) return;
    auditionStop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(S.master);
    src.onended = () => { if (S.aud.node === src) S.aud.node = null; };
    src.start();
    S.aud.node = src;
  } catch { /* an audition that fails is silence, not a dialog */ }
}

/** The drag variant: pitch-gated and throttled, per the note above. */
function auditionDrag(pitch, vel, durTicks) {
  if (!S.aud.on || pitch == null || pitch === S.aud.lastPitch) return;
  const now = performance.now();
  if (now - S.aud.at < AUDITION_MS) return;
  S.aud.at = now;
  S.aud.lastPitch = pitch;
  auditionNote(pitch, vel, durTicks);
}

/* the piano-key gutter and MIDI input both audition too — one path, so
 * the toggle, the cancellation and the cache cover all three. */
function previewPitch(pitch) { auditionNote(pitch); }

/* ═══════════════════════════════ docks, splitter, dialogs ═══════════════ */

function toggleDock(which) {
  const cls = which === "mixer" ? "d-nomixer" : "d-nobrowser";
  const on = !$("shell").classList.toggle(cls);
  $(which === "mixer" ? "mixerBtn" : "browserBtn").classList.toggle("d-on", on);
  drawArr();
  /* unfolding gives the mixer a box again — re-fit it to the one it got */
  if (which === "mixer" && on) layoutMixer();
  paintViewNum();                // also covers the no-project case, where saveView cannot
  /* … and the project remembers it. The class above has already moved the
   * panel, so the button answers the click rather than the round trip; the
   * server's reply re-applies the same view and nothing moves twice. A fold
   * with no project open is still a fold — it simply has nowhere to be kept. */
  if (viewOf()) {
    saveView(which === "mixer" ? { mixer: { folded: !on } } : { browser: { folded: !on } },
      `${which} ${on ? "open" : "folded"}`);
  }
}
$("mixerBtn").addEventListener("click", () => toggleDock("mixer"));
$("browserBtn").addEventListener("click", () => toggleDock("browser"));

/* COMPACT STRIPS. The mixer's job is the faders and the meters; the patch
 * line, the sends and the pan readout are what make a strip wide. Dropping
 * them roughly doubles how many channels fit in the same column, which is
 * the cheapest answer to "the mixer takes too much of the window" that does
 * not hide the mixer outright (that is the fold, next to it). */
function setMixNarrow(on, save = true) {
  S.mixNarrow = !!on;
  $("shell").classList.toggle("d-mixnarrow", S.mixNarrow);
  $("mixNarrowBtn").classList.toggle("d-on", S.mixNarrow);
  /* `save` is false when a project's own view is being applied: that is the
   * document speaking, not a choice, and it must not overwrite the taste this
   * browser falls back to before any project is open. */
  if (save) { try { localStorage.setItem("daw.mixNarrow", S.mixNarrow ? "1" : "0"); } catch { /* private mode */ } }
  layoutMixer();
}
$("mixNarrowBtn").addEventListener("click", () => {
  const on = !S.mixNarrow;
  setMixNarrow(on);
  if (viewOf()) saveView({ mixer: { compact: on } }, `strips ${on ? "compact" : "full"}`);
});

/* ═══════════════════════════════════ WHERE THE PANELS ARE ══════════════
 * A layout is part of the project, not something this browser happens to
 * remember: `doc.view` is normalised and persisted by server/daw/store.js, the
 * one write is POST /api/daw {action:"set_view"}, and daw_layout is the same
 * edit over MCP. This page is a VIEW of that document — it reads the view on
 * load, follows it when somebody else changes it, and writes it back on commit.
 *
 * WHAT THE WHOLE THING IS FOR, measured in the owner's own window: 1920x889,
 * nine tracks, the mixer a 268px column — three strips on screen and six off
 * the edge. A column is the wrong axis for a list that grows with every track.
 * The deck preset lays the same mixer across the bottom instead, where the same
 * nine fit at once.
 *
 * ⚠ EVERY CONTROL FOR CHANGING THE LAYOUT MUST LIVE OUTSIDE THE LAYOUT. The
 * `wide` preset folds the browser, the mixer and the dock, the view is restored
 * on load, and an agent can send one over MCP — so a picker that lived in the
 * mixer would be a picker somebody could save their way out of reaching. The
 * three chips, the readout and the three fold buttons are all in the transport
 * bar, which is a row of the shell's grid and is not foldable by anything here.
 */

const VIEW_CHIPS = [["vpDefault", "default"], ["vpDeck", "deck"], ["vpWide", "wide"]];

/* The bounds are server/daw/store.js's, mirrored, because a drag has to clamp
 * between frames and there is no round trip inside a drag. They are a PREVIEW
 * of the server's answer and never the answer itself: every commit applies the
 * view that comes BACK, so if these ever drift from the store's the release
 * snaps to the true value in front of you instead of leaving a lie on screen. */
const VIEW_BOUNDS = { browserW: [160, 480], mixerW: [180, 640], deckH: [260, 520] };
const clampTo = ([lo, hi], n) => Math.max(lo, Math.min(hi, Math.round(n)));

/** The view this page is showing — the document's, once one is open. */
const viewOf = () => S.view;

let viewApplied = "";    // JSON of the view last put on screen
let viewDrag = null;     // a resize handle is under the pointer

/**
 * Put a view on screen. Classes and custom properties only — the numbers are
 * already clamped by whoever produced them (the server, or clampTo in a drag).
 *
 * ⚠ THE WIDTHS GO TO THE `-pref` VARIABLES, NOT TO `--d-mixer-w`. Writing
 * --d-mixer-w inline beats every rule in daw.css, including .d-nomixer's, so a
 * folded mixer left its 420px column standing empty. See the comment on
 * .d-shell in daw.css: the fold has to be able to overrule the width.
 */
function applyView(v, repaint = true) {
  if (!v) return;
  const shell = $("shell");
  shell.classList.toggle("d-deck", v.mixer.mode === "deck");
  shell.classList.toggle("d-nomixer", v.mixer.folded);
  shell.classList.toggle("d-nobrowser", v.browser.folded);
  $("centre").classList.toggle("d-nodock", v.dock.folded);
  shell.style.setProperty("--d-browser-pref", `${v.browser.width}px`);
  shell.style.setProperty("--d-mixer-pref", `${v.mixer.width}px`);
  shell.style.setProperty("--d-deck-pref", `${v.mixer.height}px`);
  /* read by layoutMixer(), which caps the fader, the meter canvases and the one
   * shared dB scale together — a deck cannot afford the column's 180px fader */
  shell.style.setProperty("--d-fader-h", `${v.faderH}px`);
  $("mixerBtn").classList.toggle("d-on", !v.mixer.folded);
  $("browserBtn").classList.toggle("d-on", !v.browser.folded);
  $("dockBtn").classList.toggle("d-on", !v.dock.folded);
  for (const [id, name] of VIEW_CHIPS) $(id).classList.toggle("d-on", v.preset === name);
  setMixNarrow(v.mixer.compact, false);
  viewApplied = JSON.stringify(v);
  if (repaint) viewRepaint();
  paintViewNum();
}

/* The three canvases that are sized from the boxes this just moved. Skipped
 * when refreshDoc() is about to redraw all of them anyway. */
function viewRepaint() {
  drawArr();
  layoutMixer();
  if (S.rollFit) fitRoll();
  if (S.ana.tab === "analysis" && !$("centre").classList.contains("d-nodock")) {
    sizeAnalysis(); drawAnalysis();
  }
}

/**
 * Follow the document. Called from refreshDoc(), so it covers three arrivals
 * with one path: opening a project, an agent's daw_layout over MCP, and the
 * echo of this page's own write.
 *
 * ⚠ NOT WHILE A HANDLE IS UNDER THE POINTER. A remote view landing mid-drag
 * would snap the panel out from under the pointer and then be overwritten by
 * the commit anyway. The drag's own release re-reads and re-applies.
 */
function applyViewFromDoc() {
  const v = viewOf();
  if (!v || viewDrag) return;
  if (JSON.stringify(v) === viewApplied) return;   // already on screen
  applyView(v, false);
}

/**
 * How many strips are FULLY visible — the measurement the deck exists for.
 * Counts only the scroller's children: the master is pinned beside them and is
 * never the one off the edge. A strip clipped at the bottom of a short deck is
 * not visible either, which is why both axes are tested.
 */
function stripsVisible() {
  const box = $("mixStrips");
  if (!box || !box.offsetParent) return null;
  const kids = [...box.children];
  if (!kids.length) return null;
  const view = box.getBoundingClientRect();
  let n = 0;
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    if (r.left >= view.left - 0.5 && r.right <= view.right + 0.5
      && r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5) n++;
  }
  return { n, total: kids.length };
}

/**
 * THE NUMBER BEHIND THE CHIPS, and it is MEASURED rather than reported. Every
 * value here is read back off the laid-out page, so it cannot claim a width the
 * grid did not give — which is the failure mode this whole panel is guarding
 * against (a media query out-ranked the width for months without anyone being
 * able to see it from the UI).
 */
function paintViewNum() {
  const el = $("viewNum");
  if (!el) return;
  const shell = $("shell");
  const deck = shell.classList.contains("d-deck");
  const bits = [];
  if (shell.classList.contains("d-nomixer")) bits.push("mixer folded");
  else {
    const box = $("mixer").getBoundingClientRect();
    bits.push(deck ? `deck ${Math.round(box.height)}px` : `mixer ${Math.round(box.width)}px`);
    const vis = stripsVisible();
    if (vis) bits.push(`${vis.n}/${vis.total} strips`);
  }
  bits.push(shell.classList.contains("d-nobrowser")
    ? "browser folded"
    : `browser ${Math.round($("browser").getBoundingClientRect().width)}px`);
  /* A FOLDED MIXER HAS NO FADER, AND "fader 0px" IS NOT A MEASUREMENT OF ONE.
   * display:none measures zero for everything, so the term is only true while
   * there is a mixer on screen to measure — which is the same reason the strip
   * count above is inside the same branch. */
  if (!shell.classList.contains("d-nomixer")) {
    const fad = $("mixStrips").querySelector(".d-fadrow") || $("mixMaster").querySelector(".d-fadrow");
    if (fad) bits.push(`fader ${Math.round(fad.getBoundingClientRect().height)}px`);
  }
  el.textContent = bits.join(" · ");
}

/**
 * The one write. Not through act(): moving a panel dirties no region, renders
 * nothing and has no business on the undo stack beside a note edit.
 *
 * ⚠ THE REPLY'S `updatedAt` IS TAKEN. Our own write comes back over the live
 * socket like anybody else's, and onRemoteChange() drops a frame whose revision
 * we already hold — so recording it here is what stops a drag from costing a
 * re-read per release.
 */
async function saveView(patch, label) {
  const session = captureSession();
  if (!session.slug) { status("no project open — this layout is not saved"); return null; }
  try {
    const r = await api({ action: "set_view", slug: session.slug, view: patch });
    if (!sessionCurrent(session)) return null;
    S.view = r.view;
    if (S.proj) { S.proj.view = r.view; S.proj.updatedAt = r.updatedAt ?? S.proj.updatedAt; }
    applyView(r.view);
    if (label) status(`${label} — ${$("viewNum").textContent}`);
    return r.view;
  } catch (err) {
    if (sessionCurrent(session)) status(`The layout was not saved: ${err.message}`);
    return null;
  }
}

/* THE PRESET CHIPS. Clicking the chip you are already on re-applies that
 * preset's own numbers — which is the way back from a layout you have dragged
 * somewhere unhelpful, and the reason these are buttons rather than a <select>
 * (a select fires nothing when you pick the value it is already showing). */
for (const [id, name] of VIEW_CHIPS) {
  $(id).addEventListener("click", () => saveView({ preset: name }, `layout: ${name}`));
}

/* ── the resize handles ──────────────────────────────────────────────────
 * One gesture, three meanings, decided by which handle and which mode: the
 * browser's width, the mixer column's width, or the deck's height.
 *
 * ⚠ THE SERVER HEARS ABOUT IT ON RELEASE, NOT PER FRAME. A drag is sixty
 * pointermoves a second and set_view goes through mutate() — file lock, ledger
 * entry, a live frame to every other window. The pixels move locally on every
 * frame (a custom property, no round trip); the document hears one sentence.
 */
function viewDragBegin(el, e, kind) {
  const mixBox = $("mixer").getBoundingClientRect();
  viewDrag = {
    el, kind, id: e.pointerId,
    x: e.clientX, y: e.clientY,
    deck: $("shell").classList.contains("d-deck"),
    browserW: $("browser").getBoundingClientRect().width,
    mixerW: mixBox.width,
    deckH: mixBox.height,
    value: null, raf: 0,
  };
  el.classList.add("d-drag");
  capturePointer(el, e.pointerId);
}

function viewDragMove(e) {
  if (!viewDrag) return;
  const shell = $("shell");
  if (viewDrag.kind === "browser") {
    const w = clampTo(VIEW_BOUNDS.browserW, viewDrag.browserW + (e.clientX - viewDrag.x));
    shell.style.setProperty("--d-browser-pref", `${w}px`);
    viewDrag.value = w;
  } else if (viewDrag.deck) {
    /* the handle is the deck's TOP edge: dragging up makes the deck taller */
    const h = clampTo(VIEW_BOUNDS.deckH, viewDrag.deckH - (e.clientY - viewDrag.y));
    shell.style.setProperty("--d-deck-pref", `${h}px`);
    viewDrag.value = h;
    /* the deck's height is the faders' and the meters' height, and layoutMixer
     * is the only thing that knows that — one call per FRAME, not per event */
    if (!viewDrag.raf) {
      viewDrag.raf = requestAnimationFrame(() => { viewDrag && (viewDrag.raf = 0); layoutMixer(); paintViewNum(); });
    }
  } else {
    const w = clampTo(VIEW_BOUNDS.mixerW, viewDrag.mixerW - (e.clientX - viewDrag.x));
    shell.style.setProperty("--d-mixer-pref", `${w}px`);
    viewDrag.value = w;
  }
  paintViewNum();
}

function viewDragEnd(e) {
  if (!viewDrag) return;
  const { el, kind, deck, value, id, raf } = viewDrag;
  if (raf) cancelAnimationFrame(raf);
  viewDrag = null;
  el.classList.remove("d-drag");
  releasePointer(el, id ?? e.pointerId);
  viewRepaint();
  paintViewNum();
  if (value == null) return;             // a click, not a drag: nothing to save
  const patch = kind === "browser" ? { browser: { width: value } }
    : deck ? { mixer: { height: value } } : { mixer: { width: value } };
  const what = kind === "browser" ? "browser" : deck ? "deck height" : "mixer width";
  saveView(patch, `${what} ${value}px`);
}

for (const [id, kind] of [["splitB", "browser"], ["splitM", "mixer"]]) {
  const el = $(id);
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); viewDragBegin(el, e, kind); });
  el.addEventListener("pointermove", viewDragMove);
  el.addEventListener("pointerup", viewDragEnd);
  el.addEventListener("pointercancel", viewDragEnd);
  /* Double-click resets that edge to the preset's own number — the same way
   * back the chips give, without leaving the handle. */
  el.addEventListener("dblclick", () => {
    const v = viewOf();
    if (v) saveView({ preset: v.preset }, `layout: ${v.preset}`);
  });
}

/* The readout is measured, so anything that changes a box has to re-read it.
 * refitAll() already runs on resize and on a DPR change; this is the same
 * event reaching the same number. */
addEventListener("resize", paintViewNum);

let splitDrag = null;
$("splitH").addEventListener("pointerdown", (e) => {
  splitDrag = { y: e.clientY, h: $("centre").getBoundingClientRect().height,
                arr: $("arrWrap").getBoundingClientRect().height };
  capturePointer($("splitH"), e.pointerId);
});
$("splitH").addEventListener("pointermove", (e) => {
  if (!splitDrag) return;
  const arr = Math.max(80, Math.min(splitDrag.h - 120, splitDrag.arr + (e.clientY - splitDrag.y)));
  $("centre").style.setProperty("--d-arr-fr", `${arr}px`);
  $("centre").style.setProperty("--d-ed-fr", "1fr");
});
$("splitH").addEventListener("pointerup", (e) => {
  splitDrag = null;
  releasePointer($("splitH"), e.pointerId);
  if (S.rollFit) fitRoll();
});

/* the dock's own splitter: drag the bar above it to give the chain, the
 * analysis displays or the Ear as much room as they need */
let dockDrag = null;
$("splitD").addEventListener("pointerdown", (e) => {
  dockDrag = { y: e.clientY, h: $("dock").getBoundingClientRect().height };
  capturePointer($("splitD"), e.pointerId);
});
$("splitD").addEventListener("pointermove", (e) => {
  if (!dockDrag) return;
  const h = Math.max(0, Math.min(window.innerHeight - 240, dockDrag.h - (e.clientY - dockDrag.y)));
  $("centre").style.setProperty("--d-dock-h", `${Math.round(h)}px`);
});
$("splitD").addEventListener("pointerup", (e) => {
  dockDrag = null;
  releasePointer($("splitD"), e.pointerId);
  if (S.rollFit) fitRoll();
  if (S.ana.tab === "analysis") { sizeAnalysis(); drawAnalysis(); }
});

$("kmSel").addEventListener("change", () => {
  applyKeymap($("kmSel").value);
  status(`keymap: ${KEYMAPS[S.keymap].label} — play/stop ${binding("play_stop")}, `
    + `draw ${binding("draw")}, duplicate ${binding("duplicate")}, quantize ${binding("quantize")}`);
});
$("kmHelp").addEventListener("click", () => { drawKeymapTable(); $("kmDlg").showModal(); });
$("kmClose").addEventListener("click", () => $("kmDlg").close());

let bounceSession = null, bounceBusy = false;
$("musicInputBtn").addEventListener("click", () => $("musicInputDlg").showModal());
$("musicInputClose").addEventListener("click", () => $("musicInputDlg").close());
function paintBounceControls() {
  const mode = $("bounceMode").value;
  $("bounceTarget").disabled = mode !== "custom";
  const inactive = mode === "off" || (mode === "project" && S.proj?.master?.target_lufs == null);
  $("bounceCeiling").disabled = inactive;
  $("bounceLimiting").disabled = inactive;
  const projectTarget = S.proj?.master?.target_lufs;
  $("bounceHint").textContent = `${mode === "project" ? `Project target: ${projectTarget == null ? "off" : `${projectTarget} LUFS`}. ` : ""}`
    + (inactive ? "No added loudness stage. Master inserts and fader still apply; bit-depth conversion still applies."
      : "The limiter budget protects dynamics; a mix may finish below the loudness target. Always audition the export.");
}
function paintBounceCredits(rows) {
  const box = $("bounceBody"); box.replaceChildren();
  for (const c of rows || []) {
    const p = document.createElement("p");
    p.textContent = `${c.pack} · ${c.licence || "licence not reported"}\n${c.attribution || "No attribution line required"}${c.required ? " · REQUIRED" : ""}`;
    box.append(p);
  }
  if (!box.childElementCount) box.textContent = "No licensed-pack attribution lines are currently listed. The export records its reported origin.";
}
function showBounceResult(r, session) {
  const box = $("bounceResult"); box.replaceChildren(); box.hidden = false;
  const title = document.createElement("strong"); title.textContent = "Export ready"; box.append(title);
  const facts = document.createElement("dl"); facts.className = "d-export-facts";
  for (const [label, value] of exportFacts(r)) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = label; dd.textContent = value; facts.append(dt, dd);
  }
  box.append(facts);
  for (const note of [r.loudness?.advice, r.tagged?.error, r.tagged?.warning]) {
    if (note) { const p = document.createElement("p"); p.textContent = note; box.append(p); }
  }
  const file = document.createElement("p"); file.className = "d-mono"; file.textContent = r.file; box.append(file);
  const url = exportDownloadUrl(r.url, session.slug);
  if (url) {
    const link = document.createElement("a"); link.className = "d-btn"; link.href = url;
    link.download = r.name || ""; link.textContent = `Download ${String(r.format).toUpperCase()}`; box.append(link);
    const audio = document.createElement("audio"); audio.controls = true; audio.preload = "none"; audio.src = url;
    audio.setAttribute("aria-label", "Audition exported mix"); box.append(audio);
    const use = document.createElement("button"); use.className = "d-btn"; use.textContent = "Use as Music3 input";
    use.addEventListener("click", () => {
      $("bounceDlg").close(); $("musicInputDlg").showModal();
      $("musicInputDlg").querySelector("[data-music-input]").dispatchEvent(new CustomEvent("music-input-source", { detail: { path: r.file, name: r.name } }));
    });
    box.append(use);
  }
  paintBounceCredits(r.credits);
}
$("bounceBtn").addEventListener("click", () => {
  if (!S.slug || !S.proj) return status("Open a project before exporting.");
  if (!bounceBusy) {
    bounceSession = captureSession();
    $("bounceProject").textContent = S.proj.name || S.slug;
    $("bouncePreset").value = "project"; $("bounceMode").value = "project";
    $("bounceTarget").value = S.proj.master?.target_lufs ?? -14;
    $("bounceCeiling").value = -1; $("bounceLimiting").value = 3;
    $("bounceError").hidden = true; $("bounceResult").hidden = true;
    $("bounceResult").replaceChildren();
    paintBounceCredits(S.credits); paintBounceControls();
  }
  $("bounceDlg").showModal();
});
$("bouncePreset").addEventListener("change", () => {
  const p = EXPORT_PRESETS[$("bouncePreset").value]; if (!p) return;
  $("bounceMode").value = p.mode; $("bounceTarget").value = p.mode === "project" ? S.proj?.master?.target_lufs ?? p.target : p.target;
  $("bounceCeiling").value = p.ceiling; $("bounceLimiting").value = p.limiting; paintBounceControls();
});
$("bounceMode").addEventListener("change", paintBounceControls);
$("bounceClose").addEventListener("click", () => $("bounceDlg").close());
$("bounceDlg").addEventListener("close", () => $("bounceResult").querySelector("audio")?.pause());
$("bounceRun").addEventListener("click", async () => {
  if (bounceBusy) return;
  const session = bounceSession;
  $("bounceError").hidden = true;
  if (!sessionCurrent(session)) {
    $("bounceError").textContent = "The project changed. Close and reopen Export mix to use the current project.";
    $("bounceError").hidden = false; return;
  }
  try {
    const options = exportSettings({ format: $("bounceFormat").value, depth: $("bounceDepth").value,
      mode: $("bounceMode").value, target: $("bounceTarget").value,
      ceiling: $("bounceCeiling").value, limiting: $("bounceLimiting").value });
    bounceBusy = true; $("bounceRun").disabled = true; $("bounceControls").disabled = true;
    $("bounceRun").textContent = "Exporting…"; $("bounceResult").hidden = true;
    $("bounceResult").querySelector("audio")?.pause();
    status("Exporting mix and measuring loudness…");
    const r = await api({ action: "bounce", slug: session.slug, ...options });
    if (!sessionCurrent(session)) {
      $("bounceError").textContent = "Export finished for the previous project and was saved in its bounces folder.";
      $("bounceError").hidden = false; return;
    }
    showBounceResult(r, session); drawCredits(r.credits);
    status(`Exported ${r.seconds}s → ${r.file}`);
  } catch (err) {
    $("bounceError").textContent = `Export failed: ${err.message}`; $("bounceError").hidden = false;
    if (sessionCurrent(session)) status(`Export failed: ${err.message}`);
  } finally {
    bounceBusy = false; $("bounceRun").disabled = false; $("bounceControls").disabled = false;
    $("bounceRun").textContent = "Export mix"; paintBounceControls();
  }
});

/* ── THE ARRANGER: a whole big-room song, through the same actions ──────
 * One POST (arrange_bigroom) — the server composes add_track / add_clip /
 * record_notes / insert_add / mixer_set through its own dispatcher, so what
 * lands is a document this window could have built click by click, and can
 * edit as one. It always makes a NEW project: an arrangement dropped onto
 * existing tracks would be a half-song, and the route refuses that. */
/** The form field: "intro 8 | build 16 | drop 32 …" → the route's `structure`
 *  ([{type, bars}]); blank means the arranger's default form. Sections and
 *  bar counts are validated by the server (a multiple of 4, at least one
 *  drop), so this only parses. */
function parseForm(text) {
  const parts = String(text || "").split(/[|,\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.map((part) => {
    const m = part.match(/^([a-z]+)\s+(\d+)$/i);
    if (!m) throw new Error(`form: "${part}" is not "<section> <bars>" — intro|build|drop|break|outro and a multiple of 4`);
    return { type: m[1].toLowerCase(), bars: Number(m[2]) };
  });
}
$("arrBtn").addEventListener("click", () => { $("arrBody").innerHTML = ""; $("arrDlg").showModal(); });
$("arrClose").addEventListener("click", () => $("arrDlg").close());
$("arrRun").addEventListener("click", async () => {
  $("arrRun").disabled = true;
  status("arranging…");
  const t0 = performance.now();
  try {
    const r = await api({
      action: "arrange_bigroom",
      name: $("arrName").value || "Big room",
      seed: Math.max(1, Math.round(Number($("arrSeed").value) || 1)),
      key: $("arrKey").value,
      tempo: Number($("arrTempo").value) || 128,
      structure: parseForm($("arrForm").value),
    });
    const sel = $("projSel");
    const o = document.createElement("option");
    o.value = r.slug; o.textContent = `${r.slug} (${r.tracks.length}t/${r.notes}n)`;
    sel.appendChild(o); sel.value = r.slug;
    $("arrBody").innerHTML = `<p><b>${r.slug}</b> — ${r.bars} bars · ${r.tempo} bpm · ${r.key} minor · seed ${r.seed}`
      + ` · ${r.notes} notes on ${r.tracks.length} tracks in ${r.steps} steps (${r.ms} ms)</p>`
      + `<p class="d-mono">${r.structure.map((s) => `${s.type} ${s.bars}`).join(" · ")}</p>`
      + `<p class="d-mono">${r.tracks.map((t) => `${t.name}: ${t.patch} · ${t.notes} notes · ${t.inserts.map((i) => i.type).join(" + ") || "no inserts"}`).join("\n")}</p>`
      + `<p>Sidechain release ${r.sidechain_release_ms} ms — one eighth at ${r.tempo}. ${r.note}</p>`;
    await loadProject(r.slug);
    status(`arranged ${r.slug}: ${r.notes} notes in ${Math.round(performance.now() - t0)} ms`);
  } catch (err) {
    status(`arrange failed: ${err.message}`);
    $("arrBody").innerHTML = `<p>${err.message}</p>`;
  } finally { $("arrRun").disabled = false; }
});

/* ── [DAWREC] P0-4 grown up: the calibration WIZARD ───────────────────── */

const CAL = { last: null };

async function calEstimate(pcmBuffer, sr, how) {
  $("calResult").textContent = "estimating…";
  const r = await fetch(`/api/daw/calibrate?sr=${sr}`, { method: "POST", body: pcmBuffer });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  CAL.last = { ...j, how };
  $("calResult").textContent = j.confident
    ? `${how}: offset ${j.offset_ms} ms (peak ratio ${j.peak_ratio}) — takes will be placed earlier by this once stored.`
    : `${how}: NOT confident (peak ratio ${j.peak_ratio}) — the mic likely cannot hear the speakers. Fix levels and rerun.`;
  $("calStore").disabled = !j.confident;
  return j;
}

async function calShowStored() {
  try {
    const j = await api({ action: "set_latency" });        // no offset_ms = a read
    const rows = Object.entries(j.latency || {});
    const txt = rows.length ? rows.map(([d, ms]) => `${d}: ${ms} ms`).join(" · ") : "no offsets stored yet";
    $("calStored").textContent = `stored: ${txt}`;
    $("calNote").textContent = rows.length
      ? `stored offsets — ${txt}. Recording subtracts the matching offset automatically.`
      : "No latency offset stored yet — open the wizard from the transport (latency…).";
  } catch { /* the browser note keeps its default */ }
}

$("calOpen").addEventListener("click", () => { $("calDlg").showModal(); calShowStored(); });
$("calClose").addEventListener("click", () => $("calDlg").close());

$("calRunMic").addEventListener("click", async () => {
  try {
    $("calResult").textContent = "asking for the microphone…";
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: $("recDev").value ? { exact: $("recDev").value } : undefined,
        // the three defaults that ruin music capture, off — report §13c
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
    await refreshDevices();
    const ctx = audioCtx();
    await ctx.resume();
    const chirpBytes = await (await fetch("/api/daw/chirp.wav")).arrayBuffer();
    const chirp = await ctx.decodeAudioData(chirpBytes);
    const srcNode = ctx.createMediaStreamSource(stream);
    const rec = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    rec.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    srcNode.connect(rec);
    rec.connect(ctx.destination);
    $("calResult").textContent = "playing the chirp — keep quiet…";
    const player = ctx.createBufferSource();
    player.buffer = chirp;
    player.connect(ctx.destination);
    player.start(ctx.currentTime + 0.15);
    await new Promise((r) => setTimeout(r, 1800));
    rec.disconnect(); srcNode.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { pcm.set(c, off); off += c.length; }
    await calEstimate(pcm.buffer, ctx.sampleRate, "microphone run");
  } catch (err) {
    $("calResult").textContent = `mic run unavailable here: ${err.message}. Use the synthetic test — `
      + "it proves the identical pipeline; only your hardware stays unmeasured.";
  }
});

$("calRunSyn").addEventListener("click", async () => {
  try {
    $("calResult").textContent = "injecting a synthetic 87.3 ms capture…";
    const cap = await (await fetch("/api/daw/testcap.f32?offset_ms=87.3&sr=48000")).arrayBuffer();
    const j = await calEstimate(cap, 48000, "synthetic injection (true offset 87.3 ms)");
    if (j.confident) {
      $("calResult").textContent += Math.abs(j.offset_ms - 87.3) <= 1
        ? " ✓ recovered within ±1 ms." : " ⚠ recovery is off by more than 1 ms — report this.";
    }
  } catch (err) { $("calResult").textContent = `synthetic test failed: ${err.message}`; }
});

$("calStore").addEventListener("click", async () => {
  if (!CAL.last?.confident) return;
  const dev = deviceLabel();
  await api({ action: "set_latency", device: dev, offset_ms: CAL.last.offset_ms });
  await calShowStored();
  status(`latency for "${dev}" stored: ${CAL.last.offset_ms} ms`);
});

/* ═══════════════════ [DAWREC] the recording transport ═══════════════════
 *
 * Capture is an AudioWorklet that stamps every 128-frame block with the
 * context's own `currentFrame`, so alignment to the transport is FRAME-EXACT
 * inside the context clock. What the context clock cannot see — speakers →
 * air → mic → driver — is exactly what the calibration wizard measured, and
 * the server subtracts it at placement.
 */

const REC = { active: null, workletReady: null };

function deviceLabel() {
  const sel = $("recDev");
  return sel.selectedOptions[0]?.textContent === "default mic" ? "default"
    : (sel.selectedOptions[0]?.textContent || "default");
}

async function refreshDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const sel = $("recDev");
    const keep = sel.value;
    sel.innerHTML = `<option value="">default mic</option>`;
    for (const d of devs.filter((x) => x.kind === "audioinput" && x.deviceId && x.label)) {
      const o = document.createElement("option");
      o.value = d.deviceId; o.textContent = d.label;
      sel.appendChild(o);
    }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  } catch { /* no device API here; "default mic" stands */ }
}

function ensureWorklet(ctx) {
  if (!REC.workletReady) {
    const src = `
      class DawrecCap extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) {
            const data = new Float32Array(ch);
            this.port.postMessage({ frame: currentFrame, data }, [data.buffer]);
          }
          return true;
        }
      }
      registerProcessor("dawrec-cap", DawrecCap);`;
    const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
    REC.workletReady = ctx.audioWorklet.addModule(url);
  }
  return REC.workletReady;
}

async function startRecording() {
  const track = S.proj.tracks.find((t) => t.armed);
  if (!track) { status("arm a track first (the ● button on its head or strip)"); return; }
  const ctx = audioCtx();
  await ctx.resume();
  await ensureWorklet(ctx);

  status("asking for the microphone…");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: $("recDev").value ? { exact: $("recDev").value } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    },
  });
  await refreshDevices();
  const device = stream.getAudioTracks()[0]?.label || deviceLabel();

  const wasPlaying = S.playing;
  const pos = wasPlaying ? qToPosFine(secondsToQ(projTime())) : { bar: 1, beat: 1, tick: 0 };
  const countin = wasPlaying ? 0 : Number($("cntIn").value);

  let j;
  try {
    j = await api({ action: "record_start", slug: S.slug, track: track.id,
                    bar: pos.bar, beat: pos.beat, tick: pos.tick,
                    countin_bars: countin, device });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    status(err.message);
    return;
  }

  let clickSrc = null;
  let anchorTime;
  const posSec = posSecs(pos.bar, pos.beat, pos.tick);
  if (wasPlaying) {
    anchorTime = ctx.currentTime;
  } else {
    const t0 = ctx.currentTime + 0.25;
    anchorTime = t0 + j.countin_seconds;
    try {
      const clickBytes = await (await fetch(j.click_url)).arrayBuffer();
      const clickBuf = await ctx.decodeAudioData(clickBytes);
      clickSrc = ctx.createBufferSource();
      clickSrc.buffer = clickBuf;
      const g = ctx.createGain(); g.gain.value = 0.7;
      clickSrc.connect(g).connect(ctx.destination);
      clickSrc.start(t0);
    } catch { status("click bed unavailable — recording without it"); }
    play(anchorTime - posSec);
  }

  const anchorFrame = Math.round(anchorTime * ctx.sampleRate);
  const srcNode = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "dawrec-cap");
  srcNode.connect(node);

  const rec = {
    recId: j.rec_id, node, srcNode, stream, clickSrc,
    trackId: track.id, seq: 0, pending: [], pendingSamples: 0, posts: [],
    anchorFrame, offsetMs: j.offset_ms,
  };
  REC.active = rec;

  node.port.onmessage = (e) => {
    if (REC.active !== rec) return;
    const { frame, data } = e.data;
    if (frame + data.length <= anchorFrame) return;
    const cut = Math.max(0, anchorFrame - frame);
    const part = cut ? data.subarray(cut) : data;
    rec.pending.push(part);
    rec.pendingSamples += part.length;
    if (rec.pendingSamples >= ctx.sampleRate / 2) flushChunk(rec);
  };

  $("recBtn").classList.add("d-rec");
  status(countin
    ? `count-in (${j.countin_seconds.toFixed(2)}s, ${countin} bar${countin > 1 ? "s" : ""}) → recording on ${track.name}`
    + (j.offset_ms ? ` · latency −${j.offset_ms} ms` : " · no latency offset stored (run the wizard)")
    : `recording on ${track.name} from ${pos.bar}.${pos.beat}.${pos.tick}`);
}

function flushChunk(rec) {
  if (!rec.pendingSamples) return;
  const buf = new Float32Array(rec.pendingSamples);
  let off = 0;
  for (const p of rec.pending) { buf.set(p, off); off += p.length; }
  rec.pending = []; rec.pendingSamples = 0;
  const seq = rec.seq++;
  rec.posts.push(
    fetch(`/api/daw/record/chunk?rec=${encodeURIComponent(rec.recId)}&seq=${seq}`,
      { method: "POST", body: buf.buffer })
      .then((r) => r.json())
      .then((r) => { if (r.error) throw new Error(`chunk ${seq}: ${r.error}`); }),
  );
}

async function stopRecording() {
  const rec = REC.active;
  if (!rec) return;
  REC.active = null;
  try { rec.node.port.onmessage = null; rec.node.disconnect(); rec.srcNode.disconnect(); } catch { /* fine */ }
  rec.stream.getTracks().forEach((t) => t.stop());
  try { rec.clickSrc?.stop(); } catch { /* fine */ }
  $("recBtn").classList.remove("d-rec");
  try {
    flushChunk(rec);
    status("uploading the take…");
    await Promise.all(rec.posts);
    if (rec.seq === 0) {
      await api({ action: "record_stop", slug: S.slug, rec_id: rec.recId, cancel: true });
      status("recording canceled — it never reached the count-in's end");
      return;
    }
    const r = await api({ action: "record_stop", slug: S.slug, rec_id: rec.recId });
    await refreshDoc();
    status(`take landed: ${r.take.name} (${r.seconds}s) at sample ${r.start_sample}`
      + (rec.offsetMs ? ` (latency −${rec.offsetMs} ms applied)` : ""));
  } catch (err) {
    status(`The recording did not stop: ${err.message}`);
  }
}

$("recBtn").addEventListener("click", () => (REC.active ? stopRecording() : startRecording()));
$("recDev").addEventListener("focus", refreshDevices);

/* ── [DAWREC] import — the no-mic path everyone can use today ─────────── */

$("impBtn").addEventListener("click", () => $("impFile").click());
let audioImportRequest = 0;
$("impFile").addEventListener("change", () => {
  const file = $("impFile").files[0];
  $("impFile").value = "";
  importAudioFile(file);
});
// The model dialog dispatches this only after an explicit Import button click.
window.addEventListener("music-input-result", (event) => {
  if (typeof event.detail?.path !== "string" || !event.detail.path.trim()) {
    const message = "Import unavailable: the completed result has no local audio path.";
    $("dawImportNote").textContent = message; status(message); return;
  }
  importAudioFile({ name: event.detail.file || "Generated audio", path: event.detail.path });
});
async function importAudioFile(file) {
  if (!file) return;
  if (!S.slug || !S.trackId) {
    const message = "Select a DAW project and track before importing audio.";
    $("dawImportNote").textContent = message; status(message); return;
  }
  const session = captureSession(), track = S.trackId;
  const trackName = selTrack()?.name || track;
  const request = ++audioImportRequest;
  const pos = qToPosFine(secondsToQ(projTime()));
  const t0 = performance.now();
  const current = () => sessionCurrent(session) && request === audioImportRequest;
  $("impBtn").disabled = true;
  try {
    status(`importing ${file.name}…`);
    $("dawImportNote").textContent = `Importing ${file.name} onto ${trackName}…`;
    const q = new URLSearchParams({
      track, bar: pos.bar, beat: pos.beat, tick: pos.tick,
      name: file.name, clip_name: file.name.replace(/\.[a-z0-9]+$/i, ""),
    });
    let r;
    if (typeof file.path === "string" && file.path.trim()) {
      r = await api({ action: "import_audio", slug: session.slug, track, ...pos,
        path: file.path, name: file.name });
    } else {
      const response = await fetch(`/api/daw/upload/${encodeURIComponent(session.slug)}?${q}`,
        { method: "POST", body: file });
      if (!current()) return;
      r = await response.json().catch(() => { throw new Error(`Upload returned HTTP ${response.status}; try a supported audio file.`); });
      if (!response.ok || r.error) throw new Error(r.error || `Upload failed (HTTP ${response.status}).`);
    }
    if (!current()) return;
    if (r.error) throw new Error(r.error);
    if (!(await refreshDoc(session)) || !current()) return;
    renderAndSwap(t0, performance.now(), r.dirty, session);
    const details = audioResultDetails(r, S.proj.sr);
    const message = `Imported ${file.name} · ${details.summary} onto ${trackName} at ${pos.bar}.${pos.beat}.${pos.tick}.`;
    $("dawImportNote").textContent = `${message}${details.notice ? ` ${details.notice}` : ""}`;
    status(message);
  } catch (err) {
    if (!current()) return;
    const message = `Import failed: ${err.message}`;
    $("dawImportNote").textContent = message; status(message);
  } finally { if (current()) $("impBtn").disabled = false; }
}

/* ── [DAWREC] WebMIDI — performed notes into the note model ───────────── */

const MIDI = { access: null, notes: [], open: new Map(), on: false, previews: new Map() };

async function initMidi() {
  if (MIDI.access) return true;
  if (!navigator.requestMIDIAccess) { status("WebMIDI is not available in this browser"); return false; }
  try {
    MIDI.access = await navigator.requestMIDIAccess();
  } catch (err) { status(`MIDI refused: ${err.message}`); return false; }
  const fill = () => {
    const sel = $("midiDev");
    const keep = sel.value;
    sel.innerHTML = `<option value="">no MIDI</option>`;
    for (const inp of MIDI.access.inputs.values()) {
      const o = document.createElement("option");
      o.value = inp.id; o.textContent = inp.name;
      sel.appendChild(o);
    }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  };
  fill();
  for (const inp of MIDI.access.inputs.values()) inp.onmidimessage = onMidi;
  MIDI.access.onstatechange = () => {
    fill();
    for (const inp of MIDI.access.inputs.values()) inp.onmidimessage = onMidi;
  };
  return true;
}

function finePos(tSec) {
  let row = S.timeline[0];
  for (const r of S.timeline) { if (tSec >= r.sec) row = r; else break; }
  const beatSec = (4 / row.den) * 60 / row.bpm;
  const ticks = Math.max(0, Math.round((tSec - row.sec) / beatSec * TPB));
  const capped = Math.min(ticks, row.ticksPerBar - 1);
  return { bar: row.bar, beat: Math.floor(capped / TPB) + 1, tick: capped % TPB, beatSec };
}

function onMidi(e) {
  const [st, d1, d2] = e.data;
  const kind = st & 0xf0;
  const sel = $("midiDev");
  if (sel.value && e.target?.id && e.target.id !== sel.value) return;
  if (kind === 0x90 && d2 > 0) {
    previewPitch(d1);
    if (MIDI.on && S.playing) MIDI.open.set(d1, { t: projTime(), vel: d2 });
  } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
    const o = MIDI.open.get(d1);
    if (o !== undefined && MIDI.on) {
      MIDI.open.delete(d1);
      const p = finePos(o.t);
      const durSec = Math.max(0.05, projTime() - o.t);
      const durTicks = Math.max(60, Math.round(durSec / p.beatSec * TPB));
      MIDI.notes.push({ bar: p.bar, beat: p.beat, tick: p.tick,
                        dur_ticks: durTicks, pitch: d1, vel: o.vel });
      status(`MIDI: ${MIDI.notes.length} note(s) held for the drop`);
    }
  }
}

$("midiDev").addEventListener("focus", initMidi);
$("midiRecBtn").addEventListener("click", async () => {
  if (!MIDI.on) {
    if (!(await initMidi())) return;
    MIDI.on = true;
    MIDI.notes = [];
    MIDI.open.clear();
    $("midiRecBtn").classList.add("d-rec");
    status("MIDI rec ON — play the transport and perform; toggling off drops the notes onto the selected track. "
      + "Note previews are AUDITION renders (a server round trip), not low-latency monitoring.");
    return;
  }
  MIDI.on = false;
  $("midiRecBtn").classList.remove("d-rec");
  if (!MIDI.notes.length) { status("MIDI rec off — nothing captured"); return; }
  const t0 = performance.now();
  try {
    const r = await api({ action: "record_notes", slug: S.slug, track: S.trackId,
                          notes: MIDI.notes,
                          quantize_ticks: $("midiQuant").checked ? (S.grid || 240) : 0 });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
    status(`dropped ${r.added.length} performed note(s)${$("midiQuant").checked ? " (quantized)" : " (unquantized)"}`);
    MIDI.notes = [];
  } catch (err) { status(`The played notes were not added: ${err.message}`); }
});

/* ───────────────────────────────────────────────────────── projects */

async function loadProject(slug) {
  ++S.projectEpoch;
  stop();
  ++S.aud.seq;
  auditionStop();
  S.slug = slug;
  const session = captureSession();
  renderChain = Promise.resolve();
  liveChain = Promise.resolve();
  ++S.docRead; ++S.renderRequest;
  S.proj = null; S.timeline = []; S.totalSeconds = 0;
  S.view = null;                 // the outgoing project's layout is not the incoming one's
  S.trackId = null; S.devTarget = null; S.devInsert = null;
  S.drag = null; S.dragging = false; S.velStrategy = null;
  S.pending = []; S.rendering = false;
  S.buffers.clear();
  S.regions = [];
  S.sw = [];
  S.sel.clear();
  S.lanes = [];
  S.undo = [];
  S.redo = [];
  S.peaks.clear();
  S.at = 0;
  S.clickBuf = null;
  S.loopA = S.loopB = null;
  S.rollFit = true;
  S.ana.curves.clear();
  DEFER_OK.clear();
  S.ana.measured = null;
  S.ana.corr = [];
  S.ana.hold = null;
  S.meters = null;
  loadColours();
  paintLoopLabel();
  S.ahead = { plan: null, at: null, busy: false, asking: false,
    state: "idle", txt: "ahead —", why: "", painted: "" };
  S.wave.open.clear(); S.wave.stems.clear(); S.wave.peaks.clear(); S.wave.busy.clear(); S.wave.note = "";
  S.wave.result = null; S.wave.error = ""; S.wave.previewKey = "";
  drawReturnStems();
  ++audioImportRequest; $("impBtn").disabled = false; $("dawImportNote").textContent = "";
  paintAhead();
  if (!(await refreshDoc(session)) || !sessionCurrent(session)) return false;
  try { localStorage.setItem("daw.lastProject", session.slug); } catch { /* private mode */ }
  try {
    const link = new URL(location.href);
    link.searchParams.set("project", session.slug);
    history.replaceState(null, "", link.pathname + link.search + link.hash);
  } catch { /* A project remains usable when navigation state is unavailable. */ }
  /* Automation that ALREADY EXISTS opens its lanes on load. A parameter
   * carrying keyframes with no lane on screen is automation you have to
   * already know about — which is how a fader mysteriously rides itself. */
  S.lanes = automatables().filter((k) => laneRef(k)?.keys().length);
  S.laneCur = S.lanes[0] || null;
  drawSide(); drawArr(); drawAutoPane(); drawHistory();
  /* Open on something you can read: the whole song across the arrangement,
   * the notes filling the editor. */
  fitArr();
  fitRoll(true);
  try {
    const credits = await api({ action: "credits", slug: session.slug });
    if (!sessionCurrent(session)) return false;
    drawCredits(credits.credits);
  } catch { if (sessionCurrent(session)) drawCredits([]); }
  if (!sessionCurrent(session)) return false;
  /* THE VERDICT BEFORE THE WORK, not after it. render_plan renders nothing, so
   * asking first costs nothing — and it means somebody opening a heavy chained
   * project is told what the opening of it will do while the render is still
   * going, rather than after it has finished making them wait. The playhead is
   * at zero here, so the window is the first four regions and a heavy project
   * opens on "ahead ✓" with the late bars named in the tooltip — which is the
   * true answer, and the one the old song-wide scan could never give. */
  refreshPlan(session);
  await renderAndSwap(undefined, undefined, undefined, session);
  if (!sessionCurrent(session)) return false;
  status(`loaded ${slug}`);
  return true;
}

async function boot() {
  readTokens();
  /* One head width, not two: the canvas lane maths and the CSS column are
   * the same number, set here so they cannot drift apart. */
  $("arrHeads").style.setProperty("--d-head-w", `${HEAD_W}px`);
  $("arrHeads").style.flexBasis = `${HEAD_W}px`;
  /* ⚠ A RENAME WITHOUT THIS IS A SMALL THEFT. applyKeymap() falls back to
   * the default for a name it does not know, so anybody who had chosen a
   * profile would be moved quietly back to the first one and would have to
   * notice and re-pick. The old names were three other companies' products
   * (see NOTICE, TRADEMARKS); these lines are what makes changing them free
   * for the person using it. The map can go once nobody's browser still
   * holds an old value, which is a thing nobody can know — so it stays. */
  const KM_RENAMED = { live: "ctrl", fl: "fkeys", cubase: "numeric" };
  try {
    const saved = localStorage.getItem("daw.keymap") || "ctrl";
    applyKeymap(KM_RENAMED[saved] || saved);
  } catch { applyKeymap("ctrl"); }
  /* remembered tastes: auditioning and the compact mixer */
  try { S.aud.on = localStorage.getItem("daw.audition") !== "0"; } catch { /* private mode */ }
  $("audChk").checked = S.aud.on;
  try { setMixNarrow(localStorage.getItem("daw.mixNarrow") === "1"); } catch { setMixNarrow(false); }
  setMode("draw");
  S.grid = Number($("gridSel").value);
  showDock("chain");
  drawHistory();
  paintLoopLabel();
  drawPresets();
  connectLive();
  await Promise.allSettled([loadRack(), loadPalette()]);
  try {
    const { projects } = await get("/api/daw/projects");
    const sel = $("projSel");
    sel.innerHTML = "";
    for (const pr of projects) {
      const o = document.createElement("option");
      o.value = pr.slug; o.textContent = `${pr.name} (${pr.tracks}t/${pr.notes}n)`;
      sel.appendChild(o);
    }
    /* DELETE. An agent could already delete a project; the window could
     * not, so the only way to clear a sketch was the filesystem. It is
     * irreversible and there is no undo for it, which is exactly why the
     * confirmation names what goes and makes you type nothing you cannot
     * read. */
    $("delProj").addEventListener("click", async () => {
      if (!S.slug || !S.proj) return;
      const notes = S.proj.tracks.reduce((a, t) => a + t.clips.reduce((b, c) => b + c.notes.length, 0), 0);
      const takes = S.proj.tracks.reduce((a, t) => a + (t.takes || []).length, 0);
      if (!(await appConfirm(`Delete "${S.proj.name}" (${S.slug})?\n\n`
        + `${S.proj.tracks.length} track(s), ${notes} note(s), ${takes} recorded take(s), `
        + `every rendered region and every bounce beside it.\n\n`
        + `This is not undoable — there is no inverse action for it.`))) return;
      const gone = S.slug;
      try {
        await api({ action: "delete", slug: gone });
      } catch (err) { status(`delete failed: ${err.message}`); return; }
      [...sel.options].filter((o) => o.value === gone).forEach((o) => o.remove());
      stop();
      S.slug = null; S.proj = null;
      if (sel.options.length) { sel.value = sel.options[0].value; await loadProject(sel.value); }
      else status("deleted — no projects left; press New");
      status(`deleted ${gone}`);
    });
    calShowStored();
    if (projects.length) {
      let remembered;
      try { remembered = localStorage.getItem("daw.lastProject"); } catch {}
      const requested = new URLSearchParams(location.search).get("project");
      sel.value = projects.some(p => p.slug === requested) ? requested
        : projects.some(p => p.slug === remembered) ? remembered : projects[0].slug;
      await loadProject(sel.value);
    } else {
      status("no projects yet — press New");
    }
  } catch (err) {
    status(`Could not load DAW: ${err.message}`);
    $("retryProjects").hidden = false;
  } finally { $("newProj").disabled = false; }
}

$("retryProjects").addEventListener("click", () => location.reload());
$("projSel").addEventListener("change", () => {
  loadProject($("projSel").value).catch(err => {
    status(`Could not open project: ${err.message}`); $("retryProjects").hidden = false;
  });
});
$("newProj").addEventListener("click", () => {
  $("newProjectError").textContent = "";
  $("newProjectDlg").showModal(); $("newProjectName").select();
});
$("newProjectCancel").addEventListener("click", () => $("newProjectDlg").close());
$("newProjectForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("newProjectName").value.trim();
  if (!name || $("newProjectCreate").disabled) return;
  $("newProjectCreate").disabled = true;
  $("newProjectCancel").disabled = true;
  try {
    const r = await api({ action: "create", name });
    const instrument = PALETTE.rows.find(p => p.id === PALETTE.pick && p.installed)?.id || "pluck";
    let trackWarning = "";
    try { await api({ action: "add_track", slug: r.slug, instrument, name: "Keys" }); }
    catch (err) { trackWarning = `Project created; instrument track could not be added: ${err.message}`; }
    const option = document.createElement("option"); option.value = r.slug; option.textContent = name;
    $("projSel").appendChild(option); $("projSel").value = r.slug;
    $("newProjectDlg").close();
    setMode("draw");
    await loadProject(r.slug);
    if (trackWarning && S.slug === r.slug) status(trackWarning);
  } catch (err) {
    $("newProjectError").textContent = err.message;
    status(`Could not finish opening the project: ${err.message}`);
    $("retryProjects").hidden = false;
  } finally { $("newProjectCreate").disabled = false; $("newProjectCancel").disabled = false; }
});
$("newProjectDlg").addEventListener("cancel", e => { if ($("newProjectCreate").disabled) e.preventDefault(); });

boot();

/* ══════════════════════════════════════════════════════════════════════════
 * [DAWEAR] THE EAR PANEL — the agent/dawear mount point.
 *
 * This block is the WHOLE of the Ear's footprint in this file: one import and
 * one call. Every pixel it draws, every route it calls and all of its state
 * live in web/dawear.js + web/dawear.css, which nothing else imports. To move
 * the panel into a rebuilt arrangement UI, move these two statements and pass
 * whatever that UI uses for "the open project" as getSlug.
 * ══════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════
 * [DAWINFO] §5 THE ⓘ — the one screen in the Studio that did not have one.
 *
 * It was recorded rather than accidental: server/welcome/ui_test.js carried a
 * NO_MOUNT exemption saying the DAW "owns web/daw.html, which this surface
 * does not touch". True, and it stopped being a reason the moment somebody
 * asked what this page needs — because the answer already existed. The
 * catalogue entry, the lead copy, `makes`, `start`, `needs` (numpy),
 * `needsNote` (scipy and soundfile, which Studio cannot check for you) and
 * `cant` were all written in server/welcome/catalogue.js and served by
 * /api/welcome; the only missing piece was the mount.
 *
 * So this is one import and one call, and the panel is correct by
 * construction: web/info.js writes no copy of its own. Everything in it —
 * including the readiness badge and the machine-fit verdict — comes from the
 * same document `studio_screen_info` hands an agent. The exemption is deleted,
 * and the suite's own "stale NO_MOUNT exemption" check now guards against it
 * coming back.
 * ═════════════════════════════════════════════════════════════════════════ */
import { mountInfo } from "./info.js";
mountInfo("daw", "#dawInfoHost");

import { mountEar } from "./dawear.js";
import { appConfirm, appPrompt } from "./dialog.js";
mountEar({
  getSlug: () => S.slug,
  onEdited: () => { refreshDoc().then(() => renderAndSwap()).catch(() => {}); },
});

/* THE EAR GETS A HOME. mountEar appends a floating pill bottom-right and a
 * fixed overlay panel — the last thing on this page that was not a panel
 * like the others. Nothing inside it is touched: the two elements are MOVED
 * (its own listeners ride along on the nodes) into the transport bar and
 * into the dock's third pane, and four scoped rules in daw.css stop the
 * panel being an overlay. If dawear.js ever stops mounting, every line
 * below is a no-op and the rest of the page is unchanged. */
(function dockTheEar() {
  const fab = document.querySelector(".ear-fab");
  const panel = document.querySelector(".ear-panel");
  if (!fab || !panel) return;
  const host = $("paneEar");
  /* next to the other panel toggles, because that is what it now is */
  const group = $("dockBtn").parentElement;
  group.insertBefore(fab, $("bounceBtn"));
  host.appendChild(panel);
  panel.dataset.open = panel.dataset.open || "0";
  /* The Ear owns its own open/closed state; the dock follows it rather
   * than second-guessing it, which is why this is an observer and not a
   * reimplementation of its toggle. */
  new MutationObserver(() => {
    if (panel.dataset.open === "1") { if (S.ana.tab !== "ear") showDock("ear"); }
    else if (S.ana.tab === "ear") showDock("chain");
  }).observe(panel, { attributes: true, attributeFilter: ["data-open"] });
})();
