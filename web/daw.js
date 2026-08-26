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
const ROW_H = 12;                // piano-roll pixels per semitone
const PITCH_HI = 96, PITCH_LO = 24;
const KEYS_W = 44;               // the piano-key gutter
const TOP_H = 22;                // the bar-number lane
const VEL_H = 64;                // the velocity lane at the bottom of the roll
const VEL_GAP = 8;
const LANE_H = 46;               // arrangement track lane height
const AUTO_H = 34;               // arrangement automation sub-lane height
const RULER_H = 26;
const HEAD_W = 168;              // must match --d-head-w in daw.css

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
  lanes: [],                     // open automation lanes (keys, see laneRef)
  laneCur: null,
  devTarget: null,               // { kind:"track"|"return"|"master", id }
  devInsert: null,
  autoWrite: false,
  meters: null,                  // last `meters` measurement
  paint: [],                     // strip repainters — automated values follow the playhead
  dragging: false,               // a control is under the pointer; leave it alone
  peaks: new Map(),              // audio file -> Float32Array of |peak| buckets
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
  // undo: inverse operations through the SAME actions
  undo: [],
  keymap: "live",
  ws: null,
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
}
/** Draw with a token colour at an alpha, without inventing a second colour. */
function tint(g, colour, alpha, fn) {
  const prev = g.globalAlpha;
  g.globalAlpha = prev * alpha;
  g.fillStyle = colour; g.strokeStyle = colour;
  fn();
  g.globalAlpha = prev;
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
    },
  },
  fl: {
    label: "FL Studio",
    keys: {
      play_stop: "Space", stop: "Shift+Space", record: "R", loop: "L",
      duplicate: "Ctrl+B", del: "Delete", quantize: "Alt+Q", undo: "Ctrl+Z",
      draw: "P", select: "E", erase: "D", new_track: "Ctrl+T", split: "C",
      mixer: "F9", browser: "F8", render: "Ctrl+R",
    },
  },
  cubase: {
    label: "Cubase",
    keys: {
      play_stop: "Space", stop: "Shift+Space", record: "*", loop: "/",
      duplicate: "Ctrl+D", del: "Delete", quantize: "Q", undo: "Ctrl+Z",
      draw: "8", select: "1", erase: "5", new_track: "Ctrl+T", split: "3",
      mixer: "F3", browser: "F5", render: "Ctrl+R",
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
  if (arrCv.width !== W || arrCv.height !== H) { arrCv.width = W; arrCv.height = H; }
  arrCv.style.height = `${H}px`;
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
    tint(g, C.hair, 0.6, () => g.fillRect(0, row.y + row.h - 1, W, 1));
    if (t.id === S.trackId) tint(g, C.primary, 0.05, () => g.fillRect(0, row.y, W, row.h));

    // MIDI clips: the clip's declared bounds, with its notes blocked inside
    for (const c of t.clips) {
      const q0 = rowOf(c.fromBar)?.qStart ?? 0;
      const rr = rowOf(c.toBar);
      const q1 = (rr?.qStart ?? 0) + (rr?.qLen ?? 0);
      const x = q0 * S.arrPxq, w = Math.max(6, (q1 - q0) * S.arrPxq);
      const on = t.id === S.trackId;
      tint(g, on ? C.primary : C.ghost, on ? 0.16 : 0.08,
        () => g.fillRect(x, row.y + 2, w, row.h - 5));
      tint(g, on ? C.primary : C.ghost, on ? 0.55 : 0.25, () => {
        g.strokeRect(x + 0.5, row.y + 2.5, w - 1, row.h - 6);
      });
      if (!c.notes.length) continue;
      let lo = 127, hi = 0;
      for (const n of c.notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
      const span = Math.max(6, hi - lo);
      for (const n of c.notes) {
        const nx = posToQ(n.bar, n.beat, n.tick) * S.arrPxq;
        const nw = Math.max(1.5, durTicksToQ(n.bar, n.beat, n.tick, n.durTicks) * S.arrPxq);
        const ny = row.y + row.h - 6 - ((n.pitch - lo) / span) * (row.h - 12);
        tint(g, n.by === "agent" ? C.secondary : (on ? C.primary : C.ghost), on ? 0.95 : 0.4,
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

  // the playhead
  const x = secondsToQ(projTime()) * S.arrPxq;
  tint(g, C.warn, 1, () => g.fillRect(x, 0, 1.5, H));
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
  if (py < RULER_H) { setPlayhead(secAtQ(px / S.arrPxq)); return; }
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
});
arrCv.addEventListener("pointermove", (e) => {
  if (!arrDrag) return;
  const box = arrCv.getBoundingClientRect();
  const px = e.clientX - box.left;
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

/** The pitch rows on screen: all of them, or — folded — only the used ones. */
function rollRows() {
  if (!$("foldChk").checked) {
    const out = [];
    for (let p = PITCH_HI; p >= PITCH_LO; p--) out.push(p);
    return out;
  }
  const used = new Set(selNotes().map(({ n }) => n.pitch));
  if (!used.size) { const o = []; for (let p = 72; p >= 48; p--) o.push(p); return o; }
  return [...used].sort((a, b) => b - a);
}
function inScale(pitch) {
  const sc = SCALES[$("scaleType").value];
  if (!sc) return true;
  const root = NOTE_NAMES.indexOf($("scaleRoot").value);
  return sc.includes((((pitch - root) % 12) + 12) % 12);
}

let ROWS = [];
const rowIdx = (p) => ROWS.indexOf(p);
const yOfPitch = (p) => TOP_H + rowIdx(p) * ROW_H;
const pitchAtY = (y) => ROWS[Math.floor((y - TOP_H) / ROW_H)] ?? null;
const velTop = () => TOP_H + ROWS.length * ROW_H + VEL_GAP;

function noteRect(n) {
  const x = KEYS_W + posToQ(n.bar, n.beat, n.tick) * S.pxq;
  const w = Math.max(4, durTicksToQ(n.bar, n.beat, n.tick, n.durTicks) * S.pxq - 1);
  const i = rowIdx(n.pitch);
  return { x, y: TOP_H + i * ROW_H, w, h: ROW_H - 1, off: i < 0 };
}

function draw() {
  if (!S.proj || !S.timeline.length) return;
  ROWS = rollRows();
  const W = KEYS_W + Math.ceil(totalQ() * S.pxq) + 20;
  const H = velTop() + VEL_H;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const g = ctx2d;
  g.clearRect(0, 0, W, H);
  g.font = "10px monospace";

  // pitch rows: black keys shaded, out-of-scale rows dimmed, octaves lined
  ROWS.forEach((p, i) => {
    const y = TOP_H + i * ROW_H;
    if ([1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12)) {
      tint(g, C.panel, 0.85, () => g.fillRect(KEYS_W, y, W, ROW_H));
    }
    if (!inScale(p)) tint(g, C.rail, 0.5, () => g.fillRect(KEYS_W, y, W, ROW_H));
    else if (SCALES[$("scaleType").value]) tint(g, C.primary, 0.045, () => g.fillRect(KEYS_W, y, W, ROW_H));
    if (p % 12 === 0) tint(g, C.hair, 1, () => g.fillRect(KEYS_W, y + ROW_H - 1, W, 1));
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
    tint(g, C.ghost, 1, () => g.fillText(`${r.bar}`, x0 + 3, 10));
    if (r.bar === 1 || r.num !== rowOf(r.bar - 1)?.num || r.den !== rowOf(r.bar - 1)?.den
        || r.bpm !== rowOf(r.bar - 1)?.bpm) {
      tint(g, C.warn, 1, () => g.fillText(`${r.num}/${r.den} · ${r.bpm}`, x0 + 3, 20));
    }
  }

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
  tint(g, C.ghost, 1, () => g.fillText("vel", 4, velTop() + 10));

  for (const { n } of selNotes()) {
    const r = noteRect(n);
    const colour = n.by === "agent" ? C.secondary : C.primary;
    if (!r.off) {
      const a = 0.35 + 0.65 * (n.vel / 127);
      tint(g, colour, a, () => g.fillRect(r.x, r.y, r.w, r.h));
      if (S.sel.has(n.id)) {
        tint(g, C.ink, 1, () => g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1));
      }
      tint(g, C.ink, 0.35, () => g.fillRect(r.x + r.w - 3, r.y, 3, r.h));
    }
    // the velocity stem
    const vx = KEYS_W + posToQ(n.bar, n.beat, n.tick) * S.pxq;
    const vh = (n.vel / 127) * (VEL_H - 8);
    tint(g, colour, S.sel.has(n.id) ? 1 : 0.6,
      () => g.fillRect(vx, velTop() + VEL_H - 4 - vh, 3, vh));
  }

  // the rubber band
  if (S.drag?.mode === "band") {
    const d = S.drag;
    tint(g, C.primary, 0.5, () => g.strokeRect(
      Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5,
      Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)));
  }

  // the piano-key gutter
  tint(g, C.panel, 1, () => g.fillRect(0, TOP_H, KEYS_W, H - TOP_H));
  ROWS.forEach((p, i) => {
    const y = TOP_H + i * ROW_H;
    if ([1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12)) {
      tint(g, C.rail, 1, () => g.fillRect(0, y, KEYS_W - 8, ROW_H));
    }
    if (p % 12 === 0 || $("foldChk").checked) {
      tint(g, C.ghost, 1, () => g.fillText(
        `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`, 4, y + ROW_H - 3));
    }
  });

  drawPlayhead();
}

function drawPlayhead() {
  const x = KEYS_W + secondsToQ(projTime()) * S.pxq;
  tint(ctx2d, C.warn, 1, () => ctx2d.fillRect(x, TOP_H, 1.5, canvas.height - TOP_H));
  followPlayhead(x);
}

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
  if (py < TOP_H) { setPlayhead(secAtQ(Math.max(0, (px - KEYS_W) / S.pxq))); return; }

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
  if (px < KEYS_W) {
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
  const r = await act(
    { action: "add_note", slug: S.slug, track: S.trackId, bar: pos.bar, beat: pos.beat,
      tick: pos.tick, pitch, vel: 100, dur_ticks: dur },
    null, `add note ${pitch}`);
  if (r?.note?.id) {
    S.sel.clear(); S.sel.add(r.note.id);
    S.undo.push({ body: { action: "delete_note", slug: S.slug, track: S.trackId, note: r.note.id },
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
    const dRow = Math.round((py - d.startPy) / ROW_H);
    d.notes.forEach((n, i) => {
      const o = d.orig[i];
      const q = Math.max(0, posToQ(o.bar, o.beat, o.tick) + dq);
      Object.assign(n, qToPos(q));
      const ri = ROWS.indexOf(o.pitch) + dRow;
      n.pitch = ROWS[Math.max(0, Math.min(ROWS.length - 1, ri))] ?? o.pitch;
    });
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
    S.undo.push({
      label: `${d.mode} ${d.notes.length} note(s)`,
      bodies: d.orig.map((o) => ({ action: "move_note", slug: S.slug, track: S.trackId,
        note: o.id, bar: o.bar, beat: o.beat, tick: o.tick, pitch: o.pitch, dur_ticks: o.durTicks })),
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
  status(`${m} mode`);
}
$("quantBtn").addEventListener("click", quantizeSelection);
$("modeDraw").addEventListener("click", () => setMode("draw"));
$("modeSel").addEventListener("click", () => setMode("select"));
$("modeErase").addEventListener("click", () => setMode("erase"));
$("gridSel").addEventListener("change", () => { S.grid = Number($("gridSel").value); draw(); });
$("foldChk").addEventListener("change", draw);
$("ghostChk").addEventListener("change", draw);
$("scaleRoot").addEventListener("change", draw);
$("scaleType").addEventListener("change", draw);

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
      last = await api({ action: "move_note", slug: S.slug, track: S.trackId, note: n.id,
                         bar: n.bar, beat: Math.floor(moved / TPB) + 1, tick: moved % TPB });
    }
    if (back.length) S.undo.push({ label: `quantize ${back.length}`, bodies: back });
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
    S.undo.push({ label: `duplicate ${made.length}`,
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
    S.undo.push({ label: `delete ${back.length}`, bodies: back });
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
      S.undo.push({ label: `split ${cut}`,
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
  if (autoCv.width !== W || autoCv.height !== H) { autoCv.width = W; autoCv.height = H; }
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
  $("devNote").textContent = RACK.agree === false
    ? `⚠ engine and store catalogs disagree: ${RACK.problems.join("; ")}`
    : RACK.agree === true ? "engine ⇄ store catalogs agree" : "";
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
    const card = document.createElement("div");
    card.className = "d-dev" + (ins.enabled ? "" : " d-bypass")
      + (S.devInsert === ins.id ? " d-cur" : "");
    const head = document.createElement("div");
    head.className = "d-devhead";
    head.innerHTML = `<span class="d-nm">${spec?.label || ins.type}</span>`;
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
    S.undo.push({ body: { action: "insert_remove", slug: S.slug, target: h.target, insert: r.insertId },
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

function drawMixer() {
  const box = $("mixStrips");
  box.innerHTML = "";
  S.paint = [];
  if (!S.proj) return;
  for (const t of S.proj.tracks) box.appendChild(strip("track", t));
  for (const r of S.proj.returns || []) box.appendChild(strip("return", r));
  box.appendChild(strip("master", { ...S.proj.master, id: "master", name: "Master" }));
}

function strip(kind, host) {
  const target = kind === "master" ? "master" : host.id;
  const el = document.createElement("div");
  el.className = "d-strip" + (kind === "master" ? " d-master" : "")
    + (S.devTarget?.id === target ? " d-cur" : "");
  const name = document.createElement("div");
  name.className = "d-snm";
  name.textContent = host.name;
  name.title = "click to point the device strip at this chain";
  name.addEventListener("click", () => {
    S.devTarget = { kind, id: target };
    if (kind === "track") selectTrack(host.id); else { drawMixer(); drawDevices(); }
  });
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
  const val = document.createElement("div");
  val.className = "d-fadval";
  const paint = (x) => {
    const p = dbToPos(x);
    fad.querySelector(".d-cap").style.top = `${(1 - p) * 100}%`;
    fad.querySelector(".d-fill").style.height = `${p * 100}%`;
    val.textContent = `${keyed ? "~" : ""}${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  };
  paint(db);
  if (keyed) S.paint.push(() => paint(atNow(host.fader)));
  wireFader(fad, kind, host, target, db, paint);

  const met = document.createElement("canvas");
  met.className = "d-meterc";
  met.width = 12; met.height = 120;
  met.title = kind === "master"
    ? "live peak from the audio this page is playing — 20 dB/s decay, 1.5 s peak hold"
    : "measured, not live: press ‘measure’ to run the engine's own metering over the visible bars";
  paintMeter(met, kind === "master" ? null : S.meters?.[kind === "return" ? "returns" : "tracks"]?.[host.id]);
  if (kind === "master") S.masterMeterEl = met;
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
    const ppaint = (x) => { pi.style.left = `${(x + 1) / 2 * 100}%`; pan.title = `pan ${x.toFixed(2)}`; };
    ppaint(pv);
    if (pk) S.paint.push(() => ppaint(atNow(host.pan)));
    wireBar(pan, pv, -1, 1, ppaint,
      (v, before) => act({ action: "mixer_set", slug: S.slug, target, pan: v },
        { action: "mixer_set", slug: S.slug, target, pan: before }, `${host.name} pan ${v.toFixed(2)}`),
      () => `${kind === "return" ? "ret" : "trk"}:${host.id}:pan`);
    el.appendChild(pan);
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

function paintMeter(cv, row) {
  const g = cv.getContext("2d");
  g.clearRect(0, 0, cv.width, cv.height);
  const yOf = (db) => cv.height * (1 - (Math.max(-60, Math.min(6, db)) + 60) / 66);
  tint(g, C.hair, 1, () => g.fillRect(0, yOf(0), cv.width, 1));
  if (!row) return;
  const peak = row.peak_db ?? -120, rms = row.rms_db ?? -120;
  tint(g, peak > -1 ? C.err : C.ok, 0.55, () => g.fillRect(1, yOf(peak), cv.width - 2, cv.height - yOf(peak)));
  tint(g, C.primary, 0.9, () => g.fillRect(1, yOf(rms), cv.width - 2, cv.height - yOf(rms)));
  tint(g, C.ink, 1, () => g.fillRect(0, yOf(peak), cv.width, 1));
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
  const dB = (v) => 20 * Math.log10(Math.max(1e-6, v));
  const yOf = (db) => cv.height * (1 - (Math.max(-60, Math.min(6, db)) + 60) / 66);
  g.clearRect(0, 0, cv.width, cv.height);
  tint(g, C.hair, 1, () => g.fillRect(0, yOf(0), cv.width, 1));
  const py = yOf(dB(S.mtr.peak));
  tint(g, S.mtr.peak > 0.99 ? C.err : C.ok, 0.5, () => g.fillRect(1, py, cv.width - 2, cv.height - py));
  const ry = yOf(dB(S.mtr.rms));
  tint(g, C.primary, 0.9, () => g.fillRect(1, ry, cv.width - 2, cv.height - ry));
  const hy = yOf(dB(S.mtr.hold));
  tint(g, S.mtr.hold > 0.99 ? C.err : C.ink, 1, () => g.fillRect(0, hy, cv.width, 1.5));
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

/* ═══════════════════════════════════════ the one write path + undo ══════
 * Every mutating gesture goes through `act`: POST the action, remember its
 * inverse (also an action), re-read the document, then re-render only what
 * the server says is dirty. Undo replays the inverse — so undo is not a
 * second code path either. */

async function act(body, inverse, label) {
  const t0 = performance.now();
  try {
    const r = await api(body);
    if (inverse) S.undo.push({ body: inverse, label: label || body.action });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
    if (label) status(label);
    return r;
  } catch (err) { status(`${body.action}: ${err.message}`); return null; }
}

async function undoOnce() {
  const u = S.undo.pop();
  if (!u) { status("nothing to undo"); return; }
  const t0 = performance.now();
  try {
    let last = null;
    for (const b of u.bodies || [u.body]) last = await api(b);
    await refreshDoc();
    renderAndSwap(t0, performance.now(), last?.dirty);
    status(`undid: ${u.label}`);
  } catch (err) { status(`undo failed: ${err.message}`); }
}

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
  }
  return S.ctx;
}
const projTime = () => {
  if (!S.playing) return S.at || 0;
  const t = audioCtx().currentTime - S.anchor;
  if (!S.loop || S.totalSeconds <= 0) return Math.max(0, t);
  return ((t % S.totalSeconds) + S.totalSeconds) % S.totalSeconds;
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
  const at = S.anchor + iter * S.totalSeconds + reg.t0;
  const ctx = audioCtx();
  const now = ctx.currentTime;
  if (at + (reg.t1 - reg.t0) <= now) return;
  const src = ctx.createBufferSource();
  src.buffer = reg.buffer;
  const gain = ctx.createGain();
  src.connect(gain).connect(S.master);
  if (at >= now) {
    gain.gain.setValueAtTime(1, at);
    src.start(at);
  } else {
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE);
    src.start(now, now - at);
  }
  src.onended = () => { S.nodes.delete(key); };
  S.nodes.set(key, { src, gain, at, idx });
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
  const iter0 = Math.floor((now - S.anchor) / S.totalSeconds);
  for (const iter of [iter0, iter0 + 1]) {
    if (iter < 0) continue;
    if (!S.loop && iter > 0) break;
    for (const [idx, reg] of S.buffers) {
      const at = S.anchor + iter * S.totalSeconds + reg.t0;
      if (at < now + HORIZON && at + (reg.t1 - reg.t0) > now) scheduleOcc(iter, idx);
    }
  }
  if (!S.loop && now - S.anchor > S.totalSeconds) stop();
}

async function play(anchorAt) {
  if (S.playing) return stop();
  const ctx = audioCtx();
  await ctx.resume();
  if (!S.buffers.size) await renderAndSwap();
  S.playing = true;
  S.anchor = typeof anchorAt === "number" ? anchorAt : ctx.currentTime + 0.08 - (S.at || 0);
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
  try { S.clickSrc?.stop(); } catch { /* fine */ }
  S.clickSrc = null;
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
    const resp = await fetch(`/api/daw/click/${encodeURIComponent(S.slug)}?from_bar=1&countin=0`);
    const buf = await ctx.decodeAudioData(await resp.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(g).connect(ctx.destination);               // the click is monitoring, not the mix
    src.loop = S.loop;
    src.start(S.anchor);
    S.clickSrc = src;
  } catch (err) { status(`click bed unavailable: ${err.message}`); }
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
  else { try { S.clickSrc?.stop(); } catch { /* fine */ } S.clickSrc = null; }
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

const FAMILY_ORDER = ["synth", "piano", "gm", "drums", "bass", "strings",
                      "winds", "mallets", "world", "vocal"];

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
  S.trackId = id;
  S.sel.clear();
  S.devTarget = { kind: "track", id };
  drawSide(); drawArr(); draw(); drawMixer(); drawDevices(); drawAutoPane();
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
  drawSide(); drawArr(); draw(); drawMixer(); drawDevices(); drawLog();
  if ($("paneAuto").classList.contains("d-on")) drawAutoPane();
  paintClock();
}

/** The arrangement's track heads, aligned row-for-row with the canvas. */
function drawSide() {
  const box = $("tracks");
  box.innerHTML = "";
  if (!S.proj) return;
  for (const t of S.proj.tracks) {
    const div = document.createElement("div");
    div.className = "d-th" + (t.id === S.trackId ? " d-cur" : "");
    div.style.height = `${LANE_H}px`;
    const notes = t.clips.reduce((a, c) => a + c.notes.length, 0);
    div.innerHTML = `<div class="d-thtop"><span class="d-nm" title="${t.name}">${t.name}</span></div>
      <div class="d-inst">${t.instrument?.patch ?? t.instrument} · ${notes}n${
        (t.audioClips || []).length ? ` · ${t.audioClips.length}a` : ""}</div>`;
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
  drawAudioClips();
}

async function addTrackFromBrowser() {
  const inst = PALETTE.pick || "pluck";
  const r = await act({ action: "add_track", slug: S.slug, instrument: inst }, null, `add ${inst} track`);
  if (r?.trackId) {
    S.undo.push({ body: { action: "remove_track", slug: S.slug, track: r.trackId }, label: `add ${inst} track` });
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

async function previewPitch(pitch) {
  if (!S.slug || !S.trackId) return;
  try {
    const r = await api({ action: "preview_note", slug: S.slug, track: S.trackId, pitch, vel: 100 });
    const ctx = audioCtx();
    await ctx.resume();
    const buf = await ctx.decodeAudioData(await (await fetch(r.url)).arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(S.master);
    src.start();
  } catch { /* an audition that fails is silence, not a dialog */ }
}

/* ═══════════════════════════════ docks, splitter, dialogs ═══════════════ */

function toggleDock(which) {
  const cls = which === "mixer" ? "d-nomixer" : "d-nobrowser";
  const on = !$("shell").classList.toggle(cls);
  $(which === "mixer" ? "mixerBtn" : "browserBtn").classList.toggle("d-on", on);
  drawArr();
}
$("mixerBtn").addEventListener("click", () => toggleDock("mixer"));
$("browserBtn").addEventListener("click", () => toggleDock("browser"));

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
  S.peaks.clear();
  S.at = 0;
  await refreshDoc();
  /* Automation that ALREADY EXISTS opens its lanes on load. A parameter
   * carrying keyframes with no lane on screen is automation you have to
   * already know about — which is how a fader mysteriously rides itself. */
  S.lanes = automatables().filter((k) => laneRef(k)?.keys().length);
  S.laneCur = S.lanes[0] || null;
  drawSide(); drawArr(); drawAutoPane();
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
  setMode("draw");
  S.grid = Number($("gridSel").value);
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
