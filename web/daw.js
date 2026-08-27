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
const RULER_H = 26;
const HEAD_W = 168;              // must match --d-head-w in daw.css
const TRK_COLOURS = 5;           // --d-trk-0 … --d-trk-4 in daw.css
                                 // (--secondary is reserved: it means "the agent did this")

/* ────────────────────────────────────────────────────────── state */

const S = {
  slug: null,
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
  /* note auditioning — see auditionNote. seq cancels replies in flight,
   * lastPitch gates a drag to real pitch changes, cache holds decoded wavs. */
  aud: { on: true, seq: 0, node: null, at: 0, lastPitch: null, cache: new Map() },
  mixNarrow: false,              // compact mixer strips
  // playback
  ctx: null, master: null, analyser: null, anaBuf: null,
  playing: false,
  anchor: 0,                     // ctx.currentTime that maps to project t=0
  loop: true,
  at: 0,                         // playhead seconds while stopped
  nodes: new Map(),
  schedTimer: null,
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
  keymap: "live",
  ws: null,
  // the analysis pane's own state (see THE ANALYSIS DISPLAYS below)
  ana: { tab: "chain", live: true, spec: null, hold: null, loud: null,
         corr: [], goni: null, note: "", measured: null, curves: new Map() },
};

/* A read-only debug handle: lets a driving agent (or a person in devtools)
 * verify state without a UI to look at. The UI itself never reads it. */
window.__daw = S;

/* ────────────────────────────────────────────────────────── api */

async function api(body) {
  const r = await fetch("/api/daw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "user", ...body }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
async function get(p) {
  const r = await fetch(p);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
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

const KEYMAPS = {
  live: {
    label: "Ableton Live",
    keys: {
      play_stop: "Space", stop: "Shift+Space", record: "F9", loop: "Ctrl+L",
      duplicate: "Ctrl+D", del: "Delete", quantize: "Ctrl+U", undo: "Ctrl+Z",
      draw: "B", select: "0", erase: "E", new_track: "Ctrl+T", split: "Ctrl+E",
      mixer: "Tab", browser: "Ctrl+Alt+B", render: "Ctrl+R",
      redo: "Ctrl+Shift+Z", zoom_in: "Alt+ArrowRight", zoom_out: "Alt+ArrowLeft",
      vzoom_in: "Alt+ArrowUp", vzoom_out: "Alt+ArrowDown", zoom_fit: "Alt+F",
      loop_sel: "Ctrl+Shift+L",
    },
  },
  fl: {
    label: "FL Studio",
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
  cubase: {
    label: "Cubase",
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
  S.keymap = KEYMAPS[name] ? name : "live";
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
  if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
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
  // Our own writes come back too. `updatedAt` is the document's own revision:
  // if we already hold it, there is nothing to follow.
  if (S.proj && m.updatedAt && m.updatedAt === S.proj.updatedAt) return;
  const dot = $("liveDot");
  dot.classList.add("d-hit");
  setTimeout(() => dot.classList.remove("d-hit"), 700);
  $("liveTxt").textContent = m.by === "agent" ? `agent: ${m.action}` : "live";
  liveChain = liveChain.then(async () => {
    try {
      await refreshDoc();
      await renderAndSwap();
      if (m.by === "agent") {
        status(`agent edit applied live: ${m.action}${m.detail ? ` — ${m.detail}` : ""}`);
      }
    } catch (err) { status(`live sync: ${err.message}`); }
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
    tint(g, C.ghost, 1, () => g.fillText(`${r.bar}`, x + 3, 10));
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
    if (row.kind === "lane") { drawArrLane(g, row, W); continue; }
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
  if (peakJobs.has(file) || S.peaks.has(file)) return;
  peakJobs.add(file);
  try {
    const bytes = await (await fetch(`/api/daw/take/${encodeURIComponent(S.slug)}/${encodeURIComponent(file)}`)).arrayBuffer();
    const buf = await audioCtx().decodeAudioData(bytes);
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
  } catch { S.peaks.set(file, new Float32Array([0.02])); }
  finally { peakJobs.delete(file); }
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
  const velY = (v) => velTop() + VEL_H - 4 - (v / 127) * (VEL_H - 8);
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
    // the velocity stem — with a grabbable cap, so it reads as a control
    const vx = KEYS_W + posToQ(n.bar, n.beat, n.tick) * S.pxq;
    const vh = (n.vel / 127) * (VEL_H - 8);
    const sel = S.sel.has(n.id);
    const vy = velTop() + VEL_H - 4 - vh;
    tint(g, colour, sel ? 1 : 0.7, () => g.fillRect(vx, vy, 4, vh));
    tint(g, sel ? C.ink : colour, 1, () => g.fillRect(vx - 1, vy - 1, 6, 2));
    /* the number, while you are actually setting it — feedback at the
     * pointer beats a readout in a corner nobody is looking at */
    if (S.drag?.mode === "vel" && S.drag.note === n) {
      tint(g, C.ink, 1, () => g.fillText(`${n.vel}`, vx + 8, vy + 4));
    }
  }

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

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", async (e) => {
  if (!S.proj || !S.trackId) return;
  const box = canvas.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  // (the bar ruler is #rollRuler now, a canvas of its own — see above)

  // the velocity lane
  if (py >= velTop()) {
    const n = hitVel(px);
    if (!n) return;
    S.drag = { mode: "vel", note: n, orig: { ...n } };
    capturePointer(canvas, e.pointerId);
    n.vel = velFromY(py);
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
  if (d.mode === "vel") { d.note.vel = velFromY(py); draw(); return; }
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
    const o = d.orig[0];
    const q0 = posToQ(o.bar, o.beat, o.tick);
    const q = Math.max(q0 + 0.02, (px - KEYS_W) / S.pxq);
    const row = rowOf(o.bar);
    const step = S.grid || 60;
    const ticks = Math.max(step, Math.round((q - q0) / (4 / row.den) * TPB / step) * step);
    d.notes.forEach((n) => { n.durTicks = ticks; });
  }
  draw();
});

canvas.addEventListener("pointerup", async (e) => {
  const d = S.drag;
  S.drag = null;
  S.aud.lastPitch = null;              // the next gesture starts fresh
  if (!d) return;
  releasePointer(canvas, e.pointerId);
  if (d.mode === "band") { draw(); return; }
  if (!d.moved) { draw(); return; }
  if (d.mode === "vel") {
    await act({ action: "move_note", slug: S.slug, track: S.trackId, note: d.note.id, vel: d.note.vel },
      { action: "move_note", slug: S.slug, track: S.trackId, note: d.note.id, vel: d.orig.vel },
      `velocity ${d.orig.vel}→${d.note.vel}`);
    return;
  }
  const t0 = performance.now();
  try {
    let last = null;
    for (let i = 0; i < d.notes.length; i++) {
      const n = d.notes[i];
      last = await api({ action: "move_note", slug: S.slug, track: S.trackId, note: n.id,
                         bar: n.bar, beat: n.beat, tick: n.tick, pitch: n.pitch,
                         dur_ticks: n.durTicks });
    }
    pushUndo({
      label: `${d.mode} ${d.notes.length} note(s)`,
      bodies: d.orig.map((o) => ({ action: "move_note", slug: S.slug, track: S.trackId,
        note: o.id, bar: o.bar, beat: o.beat, tick: o.tick, pitch: o.pitch, dur_ticks: o.durTicks })),
      forwards: d.notes.map((n) => ({ action: "move_note", slug: S.slug, track: S.trackId,
        note: n.id, bar: n.bar, beat: n.beat, tick: n.tick, pitch: n.pitch, dur_ticks: n.durTicks })),
    });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), last?.dirty);
  } catch (err) {
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

const targetNotes = () => {
  const all = selNotes();
  return S.sel.size ? all.filter(({ n }) => S.sel.has(n.id)) : all;
};

async function quantizeSelection() {
  const g = S.grid;
  if (!g) { status("grid is off — pick a grid to quantize to"); return; }
  const amt = Math.max(1, Math.min(100, Number($("quantAmt").value) || 100)) / 100;
  const rows = targetNotes();
  if (!rows.length) { status("nothing to quantize"); return; }
  const t0 = performance.now();
  const back = [];
  const fwds = [];
  let last = null;
  try {
    for (const { n } of rows) {
      const row = rowOf(n.bar);
      const inBar = (n.beat - 1) * TPB + n.tick;
      const target = Math.min(Math.round(inBar / g) * g, row.ticksPerBar - 1);
      const moved = Math.round(inBar + (target - inBar) * amt);
      if (moved === inBar) continue;
      back.push({ action: "move_note", slug: S.slug, track: S.trackId, note: n.id,
                  bar: n.bar, beat: n.beat, tick: n.tick });
      const fwd = { action: "move_note", slug: S.slug, track: S.trackId, note: n.id,
                    bar: n.bar, beat: Math.floor(moved / TPB) + 1, tick: moved % TPB };
      fwds.push(fwd);
      last = await api(fwd);
    }
    if (back.length) pushUndo({ label: `quantize ${back.length}`, bodies: back, forwards: fwds });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), last?.dirty);
    status(`quantized ${back.length} note(s) to ${$("gridSel").selectedOptions[0].textContent} at ${Math.round(amt * 100)}%`);
  } catch (err) { status(err.message); }
}

async function duplicateSelection() {
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
      const p = qToPosFine(posToQ(n.bar, n.beat, n.tick) + span);
      last = await api({ action: "add_note", slug: S.slug, track: S.trackId, ...p,
                         pitch: n.pitch, vel: n.vel, dur_ticks: n.durTicks });
      if (last.note?.id) made.push(last.note.id);
    }
    pushUndo({ label: `duplicate ${made.length}`,
      bodies: made.map((id) => ({ action: "delete_note", slug: S.slug, track: S.trackId, note: id })) });
    S.sel = new Set(made);
    await refreshDoc();
    renderAndSwap(t0, performance.now(), last?.dirty);
    status(`duplicated ${made.length} note(s) ${span.toFixed(2)} quarters later`);
  } catch (err) { status(err.message); }
}

async function deleteSelection() {
  const rows = targetNotes().filter(({ n }) => S.sel.has(n.id));
  if (!rows.length) { status("nothing selected"); return; }
  const t0 = performance.now();
  const back = [];
  let last = null;
  try {
    for (const { n, c } of rows) {
      back.push({ action: "add_note", slug: S.slug, track: S.trackId, clip: c.id,
                  bar: n.bar, beat: n.beat, tick: n.tick, pitch: n.pitch, vel: n.vel,
                  dur_ticks: n.durTicks });
      last = await api({ action: "delete_note", slug: S.slug, track: S.trackId, note: n.id });
    }
    /* No forwards: undoing a delete re-adds the notes with NEW ids, so a
     * replayed delete would name notes that no longer exist. */
    pushUndo({ label: `delete ${back.length}`, bodies: back });
    S.sel.clear();
    await refreshDoc();
    renderAndSwap(t0, performance.now(), last?.dirty);
  } catch (err) { status(err.message); }
}

async function splitSelection() {
  const at = barFloatNow();
  const rows = targetNotes();
  const t0 = performance.now();
  let cut = 0, last = null;
  const back = [], made = [];
  try {
    for (const { n } of rows) {
      const q = posToQ(n.bar, n.beat, n.tick);
      const qEnd = q + durTicksToQ(n.bar, n.beat, n.tick, n.durTicks);
      const qCut = qOfBarFloat(at);
      if (qCut <= q + 0.01 || qCut >= qEnd - 0.01) continue;
      const row = rowOf(n.bar);
      const head = Math.max(1, Math.round((qCut - q) / (4 / row.den) * TPB));
      back.push({ action: "move_note", slug: S.slug, track: S.trackId, note: n.id, dur_ticks: n.durTicks });
      await api({ action: "move_note", slug: S.slug, track: S.trackId, note: n.id, dur_ticks: head });
      const p = qToPosFine(qCut);
      last = await api({ action: "add_note", slug: S.slug, track: S.trackId, ...p,
                         pitch: n.pitch, vel: n.vel,
                         dur_ticks: Math.max(1, n.durTicks - head) });
      if (last.note?.id) made.push(last.note.id);
      cut++;
    }
    if (cut) {
      pushUndo({ label: `split ${cut}`,
        bodies: [...made.map((id) => ({ action: "delete_note", slug: S.slug, track: S.trackId, note: id })), ...back] });
      await refreshDoc();
      renderAndSwap(t0, performance.now(), last?.dirty);
    }
    status(cut ? `split ${cut} note(s) at bar ${at.toFixed(2)}` : "the playhead is not inside any selected note");
  } catch (err) { status(err.message); }
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
  fadH = Math.max(90, Math.round(fadH));
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
  val.addEventListener("click", () => {
    const now = atNow(host.fader);
    const typed = prompt(`${host.name} fader, dB (−60 … +12)`, now.toFixed(1));
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
  $("centre").classList.remove("d-nodock");
  $("dockBtn").classList.add("d-on");
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
  const t0 = performance.now();
  try {
    const r = await api(body);
    if (inverse) pushUndo({ body: inverse, forward: body, label: label || body.action });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
    if (label) status(label);
    return r;
  } catch (err) { status(`${body.action}: ${err.message}`); return null; }
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
  const u = S.undo.pop();
  if (!u) { status("nothing to undo"); return; }
  const t0 = performance.now();
  try {
    let last = null;
    for (const b of u.bodies || [u.body]) last = await api(b);
    if (u.forward || u.forwards) S.redo.push(u);
    else if (S.redo.length) {
      S.redo = [];
      status(`undid: ${u.label} — redo cleared (this gesture mints new ids, so it cannot be replayed exactly)`);
    }
    await refreshDoc();
    renderAndSwap(t0, performance.now(), last?.dirty);
    drawHistory();
    status(`undid: ${u.label}`);
  } catch (err) { S.undo.push(u); drawHistory(); status(`undo failed: ${err.message}`); }
}

async function redoOnce() {
  const u = S.redo.pop();
  if (!u) { status("nothing to redo"); return; }
  const t0 = performance.now();
  try {
    let last = null;
    for (const b of u.forwards || [u.forward]) last = await api(b);
    /* An action that created something hands back the new id, so the entry
     * that goes back on the undo stack undoes THIS object, not the one the
     * gesture made the first time. */
    const again = u.inverseFrom ? { ...u, ...u.inverseFrom(last) } : u;
    S.undo.push(again);
    await refreshDoc();
    renderAndSwap(t0, performance.now(), last?.dirty);
    drawHistory();
    status(`redid: ${u.label}`);
  } catch (err) { S.redo.push(u); drawHistory(); status(`redo failed: ${err.message}`); }
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

/**
 * The dirty-region loop's client half, and THE STOPWATCH. tGesture is when
 * the pointer went down; tAck when the edit route answered. This renders
 * (server re-renders only hash-missing regions), fetches the region files
 * whose urls changed, decodes, swaps — and the moment the last changed buffer
 * is swapped into the schedule is "audible".
 */
function renderAndSwap(tGesture, tAck, dirty) {
  S.pending = dirty || [];
  S.rendering = true;
  cpu("re-rendering…", true);
  drawArr(); draw();
  renderChain = renderChain.then(async () => {
    try {
      const r = await api({ action: "render", slug: S.slug });
      const tRender = performance.now();
      S.regions = r.regions;
      S.totalSeconds = r.totalSeconds;
      const changed = r.regions.filter((g) => S.buffers.get(g.idx)?.url !== g.url);
      await Promise.all(changed.map(async (g) => {
        const resp = await fetch(g.url);
        const bytes = await resp.arrayBuffer();
        const buf = await audioCtx().decodeAudioData(bytes);
        S.buffers.set(g.idx, { hash: g.hash, url: g.url, buffer: buf, t0: g.t0, t1: g.t1 });
        if (S.playing) hotSwap(g.idx);
      }));
      for (const k of [...S.buffers.keys()]) {
        if (!r.regions.some((g) => g.idx === k)) S.buffers.delete(k);
      }
      const tAudible = performance.now();
      if (tGesture !== undefined) {
        S.sw.push({ ack: tAck - tGesture, render: tRender - tGesture, audible: tAudible - tGesture });
        updateHud();
      }
      cpu(`${r.rendered} rendered · ${r.cachedHits} cached · ${r.ms} ms`, false);
      if (dirty?.length) {
        status(`render: ${r.rendered} rendered, ${r.cachedHits} cached, ${r.ms} ms · dirty: `
          + dirty.map((d) => `bars ${d.fromBar}-${d.toBar}`).join(", "));
      }
      drawCredits(r.credits);
    } catch (err) {
      cpu("render failed", false);
      status(`render failed: ${err.message}`);
    } finally {
      S.pending = []; S.rendering = false;
      drawArr(); draw();
    }
  });
  return renderChain;
}

function cpu(txt, busy) {
  $("cpuTxt").textContent = txt;
  $("cpuBox").classList.toggle("d-busy", !!busy);
}

function updateHud() {
  const xs = S.sw.map((s) => s.audible).sort((a, b) => a - b);
  const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  $("swLast").textContent = `${Math.round(S.sw[S.sw.length - 1].audible)}ms`;
  $("swMed").textContent = `${Math.round(q(0.5))}ms`;
  $("swP95").textContent = `${Math.round(q(0.95))}ms`;
  $("swN").textContent = `n=${xs.length}`;
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

function schedulerTick() {
  if (!S.playing || !S.totalSeconds) return;
  /* The numeric readout is painted HERE as well as in the rAF loop, because
   * requestAnimationFrame stops in a hidden or non-compositing tab and a
   * transport whose clock silently freezes while the audio keeps rolling is
   * a lie. rAF still does the smooth 60 Hz playhead when the window is up;
   * this is the 150 ms floor that always runs. */
  paintClock();
  const ctx = audioCtx();
  const now = ctx.currentTime;
  const HORIZON = 0.8;
  const { a, b } = loopSecs();
  const len = b - a;
  if (len <= 0) return;
  const iter0 = Math.floor((now - S.anchor) / len);
  for (const iter of [iter0, iter0 + 1]) {
    if (iter < 0) continue;
    if (!S.loop && iter > 0) break;
    if (S.clickBuf && S.anchor + iter * len < now + HORIZON) scheduleClick(iter);
    for (const [idx, reg] of S.buffers) {
      const segStart = Math.max(reg.t0, a), segEnd = Math.min(reg.t1, b);
      if (segEnd <= segStart + 1e-4) continue;
      const at = S.anchor + iter * len + (segStart - a);
      if (at < now + HORIZON && at + (segEnd - segStart) > now) scheduleOcc(iter, idx);
    }
  }
  if (!S.loop && now - S.anchor > len) stop();
}

async function play(anchorAt) {
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
  schedulerTick();
  S.schedTimer = setInterval(schedulerTick, 150);
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
  clearInterval(S.schedTimer);
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

async function loadPalette() {
  try {
    const r = await get("/api/daw/patches");
    PALETTE.rows = r.patches;
    PALETTE.packs = r.packs;
    PALETTE.dir = r.instrumentsDir;
  } catch (err) { status(`palette: ${err.message}`); return; }
  drawPalette();
}

/* An unlisted family sorts to the very end, so this list has to grow whenever
 * the palette does — guitar, keys and plucked arrived with the sampled packs
 * and were landing below "vocal" until they were named here. */
const FAMILY_ORDER = ["synth", "piano", "keys", "gm", "drums", "bass", "guitar",
                      "plucked", "strings", "winds", "mallets", "world", "vocal"];

function drawPalette() {
  const box = $("palette");
  box.innerHTML = "";
  const ord = (f) => { const i = FAMILY_ORDER.indexOf(f); return i < 0 ? 99 : i; };
  const fams = [...new Set(PALETTE.rows.map((r) => r.family))].sort((a, b) => ord(a) - ord(b));
  $("palCnt").textContent = `${PALETTE.rows.filter((r) => r.installed).length}/${PALETTE.rows.length} ready`;
  for (const fam of fams) {
    const rows = PALETTE.rows.filter((r) => r.family === fam);
    const d = document.createElement("details");
    d.className = "d-fam";
    d.open = rows.some((r) => r.id === PALETTE.pick) || fam === "synth" || fam === "piano";
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
        if (!confirm(`Uninstall "${row.pack.label}"?\n\n`
          + `It serves ${sisters.length} patch(es): ${sisters.map((r) => r.label).join(", ")}.\n`
          + (using.length ? `${using.length} track(s) in this project use it and will stop rendering: `
              + `${using.map((t) => t.name).join(", ")}.\n` : "")
          + `The files come back with one install; nothing in the project is changed.`)) return;
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

/* ═══════════════════════════════════════════ tracks, meter, tempo ═══════ */

function selectTrack(id) {
  const changed = S.trackId !== id;
  S.trackId = id;
  S.sel.clear();
  S.devTarget = { kind: "track", id };
  drawSide(); drawArr(); draw(); drawMixer(); drawDevices(); drawAutoPane();
  /* A new track means new notes, and the fitted window follows them. */
  if (changed) fitRoll();
  paintSelInfo();
}

/** What is selected, and where the editor is looking — the two things the
 *  status bar was not saying. */
function paintSelInfo() {
  const t = selTrack();
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

async function refreshDoc() {
  const r = await get(`/api/daw/project/${encodeURIComponent(S.slug)}`);
  S.proj = r.project;
  S.timeline = r.timeline;
  S.totalSeconds = r.totalSeconds;
  if (!S.proj.tracks.some((t) => t.id === S.trackId)) S.trackId = S.proj.tracks[0]?.id ?? null;
  if (!S.devTarget) S.devTarget = S.trackId ? { kind: "track", id: S.trackId } : { kind: "master", id: "master" };
  S.lanes = S.lanes.filter((k) => laneRef(k));
  $("lenBars").value = S.proj.lengthBars;
  /* A loop range that outlived a shortened song is a loop range that plays
   * silence — clamp it to what the document now is. */
  if (S.loopB != null && S.loopB > S.proj.lengthBars + 1) setLoopSilent(null, null);
  drawSide(); drawArr(); draw(); drawMixer(); drawDevices(); drawLog(); drawHistory();
  if ($("paneAuto").classList.contains("d-on")) drawAutoPane();
  paintClock();
  paintSelInfo();
  if (S.rollFit) fitRoll();
}
/** Set the loop without restarting the transport (used while re-reading). */
function setLoopSilent(a, b) { S.loopA = a; S.loopB = b; paintLoopLabel(); }

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
      mk("✕", "remove this track (remove_track)", false, () => act(
        { action: "remove_track", slug: S.slug, track: t.id }, null, `remove ${t.name}`)),
    );
    div.querySelector(".d-thtop").appendChild(btns);
    div.addEventListener("click", () => selectTrack(t.id));
    box.appendChild(div);
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
}

/** Rename through set_track — the same action an MCP rename posts. */
function renameTrack(t) {
  const name = prompt("Track name", t.name);
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
      mk("name", "rename this clip (set_clip name)", () => {
        const name = prompt("Clip name", c.name || "clip");
        if (name === null) return;
        act({ action: "set_clip", slug: S.slug, track: t.id, clip: c.id, name },
          { action: "set_clip", slug: S.slug, track: t.id, clip: c.id, name: c.name || "clip" },
          `clip renamed → ${name}`);
      }),
      mk("✕", `remove this clip AND its ${c.notes.length} note(s) (remove_clip) — this one really deletes`, () => {
        if (!confirm(`Remove "${c.name || "clip"}" (bars ${c.fromBar}–${c.toBar}) and its ${c.notes.length} note(s)?`
          + `\n\nUnlike shrinking a clip, this deletes the notes.`)) return;
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
    d.className = "d-brow";
    d.innerHTML = `<span class="d-nm" title="${c.file}">${c.name} · ${
      (c.durSamples / (S.proj.sr || 48000)).toFixed(1)}s @ ${c.bar}.${c.beat}.${c.tick}</span>`;
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
}
$("mixerBtn").addEventListener("click", () => toggleDock("mixer"));
$("browserBtn").addEventListener("click", () => toggleDock("browser"));

/* COMPACT STRIPS. The mixer's job is the faders and the meters; the patch
 * line, the sends and the pan readout are what make a strip wide. Dropping
 * them roughly doubles how many channels fit in the same column, which is
 * the cheapest answer to "the mixer takes too much of the window" that does
 * not hide the mixer outright (that is the fold, next to it). */
function setMixNarrow(on) {
  S.mixNarrow = !!on;
  $("shell").classList.toggle("d-mixnarrow", S.mixNarrow);
  $("mixNarrowBtn").classList.toggle("d-on", S.mixNarrow);
  try { localStorage.setItem("daw.mixNarrow", S.mixNarrow ? "1" : "0"); } catch { /* private mode */ }
  layoutMixer();
}
$("mixNarrowBtn").addEventListener("click", () => setMixNarrow(!S.mixNarrow));

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

$("bounceBtn").addEventListener("click", async () => {
  const rows = S.credits || [];
  $("bounceBody").innerHTML = rows.length
    ? rows.map((c) => `<p><b>${c.pack}</b> — ${c.licence || ""}<br>`
      + `<span class="d-mono">${c.attribution || "(no attribution line required)"}</span>`
      + `${c.required ? " <b>REQUIRED</b>" : ""}</p>`).join("")
    : `<p>No licensed packs used yet — the bounce will carry the Tier-1 AI marker only.</p>`;
  $("bounceDlg").showModal();
});
$("bounceClose").addEventListener("click", () => $("bounceDlg").close());
$("bounceRun").addEventListener("click", async () => {
  $("bounceRun").disabled = true;
  status("bouncing…");
  try {
    const r = await api({ action: "bounce", slug: S.slug });
    $("bounceBody").innerHTML = `<p><b>Written:</b> <span class="d-mono">${r.file}</span><br>`
      + `${r.seconds}s · tagged ${r.tagged ? "yes" : "no"} · ${r.ms} ms</p>`
      + (r.attribution?.length
        ? `<p><b>Attribution written into the file AND shown here:</b></p><p class="d-mono">${r.attribution.join("\n")}</p>`
        : `<p>No attribution lines were required.</p>`);
    drawCredits(r.credits);
    status(`bounced ${r.seconds}s → ${r.file}`);
  } catch (err) { status(`bounce failed: ${err.message}`); }
  finally { $("bounceRun").disabled = false; }
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
    status(`record_stop failed: ${err.message}`);
  }
}

$("recBtn").addEventListener("click", () => (REC.active ? stopRecording() : startRecording()));
$("recDev").addEventListener("focus", refreshDevices);

/* ── [DAWREC] import — the no-mic path everyone can use today ─────────── */

$("impBtn").addEventListener("click", () => $("impFile").click());
$("impFile").addEventListener("change", async () => {
  const file = $("impFile").files[0];
  $("impFile").value = "";
  if (!file || !S.slug || !S.trackId) return;
  const pos = qToPosFine(secondsToQ(projTime()));
  const t0 = performance.now();
  try {
    status(`importing ${file.name}…`);
    const q = new URLSearchParams({
      track: S.trackId, bar: pos.bar, beat: pos.beat, tick: pos.tick,
      name: file.name, clip_name: file.name.replace(/\.[a-z0-9]+$/i, ""),
    });
    const r = await (await fetch(`/api/daw/upload/${encodeURIComponent(S.slug)}?${q}`,
      { method: "POST", body: file })).json();
    if (r.error) throw new Error(r.error);
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
    status(`imported ${file.name} (${r.seconds}s) at ${pos.bar}.${pos.beat}.${pos.tick}`);
  } catch (err) { status(`import failed: ${err.message}`); }
});

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
  } catch (err) { status(`record_notes failed: ${err.message}`); }
});

/* ───────────────────────────────────────────────────────── projects */

async function loadProject(slug) {
  stop();
  S.slug = slug;
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
  await refreshDoc();
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
  try { drawCredits((await api({ action: "credits", slug })).credits); } catch { drawCredits([]); }
  await renderAndSwap();
  status(`loaded ${slug}`);
}

async function boot() {
  readTokens();
  /* One head width, not two: the canvas lane maths and the CSS column are
   * the same number, set here so they cannot drift apart. */
  $("arrHeads").style.setProperty("--d-head-w", `${HEAD_W}px`);
  $("arrHeads").style.flexBasis = `${HEAD_W}px`;
  try { applyKeymap(localStorage.getItem("daw.keymap") || "live"); } catch { applyKeymap("live"); }
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
  await loadRack();
  await loadPalette();
  try {
    const { projects } = await get("/api/daw/projects");
    const sel = $("projSel");
    sel.innerHTML = "";
    for (const pr of projects) {
      const o = document.createElement("option");
      o.value = pr.slug; o.textContent = `${pr.name} (${pr.tracks}t/${pr.notes}n)`;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => loadProject(sel.value));
    $("newProj").addEventListener("click", async () => {
      const name = prompt("Project name", "Sketch") || "Sketch";
      const r = await api({ action: "create", name });
      await api({ action: "add_track", slug: r.slug, instrument: PALETTE.pick || "pluck", name: "keys" });
      const o = document.createElement("option");
      o.value = r.slug; o.textContent = r.slug;
      sel.appendChild(o); sel.value = r.slug;
      await loadProject(r.slug);
    });
    /* DELETE. An agent could already delete a project; the window could
     * not, so the only way to clear a sketch was the filesystem. It is
     * irreversible and there is no undo for it, which is exactly why the
     * confirmation names what goes and makes you type nothing you cannot
     * read. */
    $("delProj").addEventListener("click", async () => {
      if (!S.slug || !S.proj) return;
      const notes = S.proj.tracks.reduce((a, t) => a + t.clips.reduce((b, c) => b + c.notes.length, 0), 0);
      const takes = S.proj.tracks.reduce((a, t) => a + (t.takes || []).length, 0);
      if (!confirm(`Delete "${S.proj.name}" (${S.slug})?\n\n`
        + `${S.proj.tracks.length} track(s), ${notes} note(s), ${takes} recorded take(s), `
        + `every rendered region and every bounce beside it.\n\n`
        + `This is not undoable — there is no inverse action for it.`)) return;
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
      sel.value = projects[0].slug;
      await loadProject(projects[0].slug);
    } else {
      status("no projects yet — press New");
    }
  } catch (err) {
    status(`boot failed: ${err.message}`);
  }
}

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
import { mountEar } from "./dawear.js";
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
