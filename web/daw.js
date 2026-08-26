/**
 * DAW — the P0-1 browser half: a real (if minimal) piano roll over the same
 * /api/daw actions MCP drives, Web Audio playback that stitches the server's
 * bar-region renders gaplessly, hot-swaps a region's buffer when a re-render
 * lands mid-playback, and a stopwatch on every edit from gesture to audible.
 *
 * WHAT IS DELIBERATELY NOT HERE: an audio engine. The browser never
 * synthesises a note — it plays files the server rendered, so the monitor IS
 * the bounce (the report's non-negotiable). The only client-side audio math
 * is scheduling.
 *
 * TIME. The x-axis is QUARTER NOTES, not bars: bars are uneven in mixed
 * meter (a 7/8 bar is narrower than a 4/4 bar — that is the feature), and the
 * server's derived timeline rows carry each bar's quarter offset/length, so
 * the grid is drawn FROM the maps, never from an assumed 4/4. All positions
 * sent to the server are musical (bar.beat.tick); seconds appear only in the
 * playback scheduler, taken from the same rows the server rendered with.
 *
 * HOT SWAP. Region files are content-addressed, so "did this region change"
 * is a url comparison. A changed region that is currently sounding is
 * replaced under a 5 ms equal-gain crossfade — NOT because the seams need it
 * (region boundaries are bit-exact by construction, proven server-side) but
 * because old and new audio genuinely differ at the swap instant; 5 ms turns
 * that step into a fade nobody hears as a click.
 */

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

const TPB = 960;                 // ticks per beat (denominator unit)
const QUANT = 240;               // click quantum: a quarter of a beat
const PXQ = 56;                  // pixels per quarter note
const ROW_H = 12;                // pixels per semitone row
const PITCH_HI = 96, PITCH_LO = 24;
const KEYS_W = 44;               // the piano-key gutter
const TOP_H = 22;                // the bar-number lane

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
  // playback
  ctx: null,
  playing: false,
  anchor: 0,                     // ctx.currentTime that maps to project t=0 (iteration 0)
  loop: true,
  nodes: new Map(),              // `${iter}:${idx}` -> { src, gain, at, idx }
  schedTimer: null,
  // stopwatch
  sw: [],                        // per-edit { ack, render, audible } ms
};

/* A read-only debug handle: lets a driving agent (or a person in devtools)
 * verify the scheduler actually scheduled without a UI to look at. The UI
 * itself never reads it. */
window.__daw = S;

/* ────────────────────────────────────────────────────────── api */

async function api(body) {
  const r = await fetch("/api/daw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, by: "user" }),
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

/* ─────────────────────────────────────────────── musical time (mirror) */
/* Tiny mirrors over the SERVER's timeline rows — never recomputed from an
 * assumption. rowOf/posToQ/qToPos are pixel math; secondsAt is the scheduler's
 * clock map. The server remains the authority: every mutation round-trips. */

const rowOf = (bar) => S.timeline[Math.min(bar, S.timeline.length) - 1];

function posToQ(bar, beat, tick) {
  const r = rowOf(bar);
  if (!r) return 0;
  return r.qStart + ((beat - 1) * TPB + tick) / TPB * (4 / r.den);
}
function durTicksToQ(bar, beat, tick, durTicks) {
  let b = bar, ticksIn = (beat - 1) * TPB + tick, left = durTicks, q = 0;
  for (let guard = 0; guard < 4096 && left > 0; guard++) {
    const r = rowOf(b);
    const room = r.ticksPerBar - ticksIn;
    const take = Math.min(left, room);
    q += take / TPB * (4 / r.den);
    left -= take; b++; ticksIn = 0;
  }
  return q;
}
function qToPos(q) {
  let row = S.timeline[0];
  for (const r of S.timeline) { if (q >= r.qStart) row = r; else break; }
  const ticks = Math.max(0, Math.round((q - row.qStart) / (4 / row.den) * TPB));
  const snapped = Math.min(Math.round(ticks / QUANT) * QUANT, row.ticksPerBar - QUANT);
  return { bar: row.bar, beat: Math.floor(snapped / TPB) + 1, tick: snapped % TPB };
}
function secondsToQ(t) {
  let row = S.timeline[0];
  for (const r of S.timeline) { if (t >= r.sec) row = r; else break; }
  return row.qStart + Math.min(1, Math.max(0, (t - row.sec) / row.secLen)) * row.qLen;
}
const totalQ = () => {
  const last = S.timeline[S.timeline.length - 1];
  return last ? last.qStart + last.qLen : 0;
};

/* ────────────────────────────────────────────────────── the piano roll */

const canvas = $("roll");
const ctx2d = canvas.getContext("2d");

function noteRect(n) {
  const x = KEYS_W + posToQ(n.bar, n.beat, n.tick) * PXQ;
  const w = Math.max(4, durTicksToQ(n.bar, n.beat, n.tick, n.durTicks) * PXQ - 1);
  const y = TOP_H + (PITCH_HI - n.pitch) * ROW_H;
  return { x, y, w, h: ROW_H - 1 };
}

function draw() {
  if (!S.timeline.length) return;
  const W = KEYS_W + Math.ceil(totalQ() * PXQ) + 20;
  const H = TOP_H + (PITCH_HI - PITCH_LO + 1) * ROW_H;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const g = ctx2d;
  g.fillStyle = "#101014"; g.fillRect(0, 0, W, H);

  // pitch rows: shade the black keys, line each octave
  for (let p = PITCH_LO; p <= PITCH_HI; p++) {
    const y = TOP_H + (PITCH_HI - p) * ROW_H;
    if ([1, 3, 6, 8, 10].includes(p % 12)) { g.fillStyle = "#15151b"; g.fillRect(KEYS_W, y, W, ROW_H); }
    if (p % 12 === 0) { g.strokeStyle = "#26262f"; g.beginPath(); g.moveTo(KEYS_W, y + ROW_H); g.lineTo(W, y + ROW_H); g.stroke(); }
  }

  // the grid FROM the meter map: uneven bars drawn honestly
  for (const r of S.timeline) {
    const x0 = KEYS_W + r.qStart * PXQ;
    g.strokeStyle = "#3a3a4a"; g.lineWidth = r.bar === 1 ? 1 : 1.5;
    g.beginPath(); g.moveTo(x0, TOP_H); g.lineTo(x0, H); g.stroke();
    g.lineWidth = 1;
    const beatQ = 4 / r.den;
    for (let b = 1; b < r.num; b++) {
      const x = x0 + b * beatQ * PXQ;
      g.strokeStyle = "#22222c";
      g.beginPath(); g.moveTo(x, TOP_H); g.lineTo(x, H); g.stroke();
    }
    g.fillStyle = "#8b8b9a"; g.font = "10px system-ui";
    g.fillText(`${r.bar}`, x0 + 3, 10);
    if (r.bar === 1 || r.num !== rowOf(r.bar - 1)?.num || r.den !== rowOf(r.bar - 1)?.den
        || r.bpm !== rowOf(r.bar - 1)?.bpm) {
      g.fillStyle = "#f2a459";
      g.fillText(`${r.num}/${r.den} · ${r.bpm}`, x0 + 3, 20);
    }
  }

  // region boundaries — the render seams, made visible on purpose
  for (const r of S.regions) {
    const x = KEYS_W + secondsToQ(r.t0) * PXQ;
    g.strokeStyle = "rgba(89,184,242,.18)";
    g.beginPath(); g.moveTo(x, TOP_H); g.lineTo(x, H); g.stroke();
  }

  // notes: selected track solid, others ghosted
  for (const t of S.proj.tracks) {
    for (const c of t.clips) {
      for (const n of c.notes) {
        const r = noteRect(n);
        if (t.id !== S.trackId) {
          g.fillStyle = "rgba(139,139,154,.25)";
          g.fillRect(r.x, r.y, r.w, r.h);
          continue;
        }
        g.fillStyle = n.by === "agent" ? "#c58af2" : "#59b8f2";
        g.fillRect(r.x, r.y, r.w, r.h);
        g.fillStyle = "rgba(255,255,255,.35)";
        g.fillRect(r.x + r.w - 3, r.y, 3, r.h);      // the resize handle
      }
    }
  }

  // piano-key gutter
  g.fillStyle = "#17171d"; g.fillRect(0, TOP_H, KEYS_W, H);
  for (let p = PITCH_LO; p <= PITCH_HI; p++) {
    const y = TOP_H + (PITCH_HI - p) * ROW_H;
    if ([1, 3, 6, 8, 10].includes(p % 12)) { g.fillStyle = "#101014"; g.fillRect(0, y, KEYS_W - 8, ROW_H); }
    if (p % 12 === 0) {
      g.fillStyle = "#8b8b9a"; g.font = "9px system-ui";
      g.fillText(`C${Math.floor(p / 12) - 1}`, 4, y + ROW_H - 3);
    }
  }

  drawPlayhead();
}

let playheadX = -1;
function drawPlayhead() {
  if (!S.playing) return;
  const t = projTime();
  const x = KEYS_W + secondsToQ(t) * PXQ;
  const g = ctx2d;
  g.strokeStyle = "#f2a459"; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(x, TOP_H); g.lineTo(x, canvas.height); g.stroke();
  g.lineWidth = 1;
  playheadX = x;
}

/* ──────────────────────────────────────────────── pointer interactions */

function hitNote(px, py) {
  const t = S.proj.tracks.find((x) => x.id === S.trackId);
  if (!t) return null;
  for (const c of t.clips) {
    for (const n of c.notes) {
      const r = noteRect(n);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return { note: n, clip: c, rect: r, edge: px > r.x + r.w - 5 };
      }
    }
  }
  return null;
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", async (e) => {
  if (!S.proj || !S.trackId) return;
  const box = canvas.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  if (px < KEYS_W || py < TOP_H) return;
  const hit = hitNote(px, py);

  if (e.button === 2) {                                    // right-click: delete
    if (!hit) return;
    const t0 = performance.now();
    try {
      const r = await api({ action: "delete_note", slug: S.slug, track: S.trackId, note: hit.note.id });
      await refreshDoc();
      renderAndSwap(t0, performance.now(), r.dirty);
    } catch (err) { status(err.message); }
    return;
  }

  if (hit) {                                               // drag: move or resize
    S.drag = { note: hit.note, mode: hit.edge ? "resize" : "move",
               startPx: px, startPy: py, orig: { ...hit.note }, moved: false };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  // empty space: add a note
  const q = (px - KEYS_W) / PXQ;
  const pos = qToPos(q);
  const pitch = PITCH_HI - Math.floor((py - TOP_H) / ROW_H);
  if (pitch < PITCH_LO || pitch > PITCH_HI) return;
  const t0 = performance.now();
  try {
    const r = await api({ action: "add_note", slug: S.slug, track: S.trackId,
                          bar: pos.bar, beat: pos.beat, tick: pos.tick, pitch, vel: 100 });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
  } catch (err) { status(err.message); }
});

canvas.addEventListener("pointermove", (e) => {
  if (!S.drag) return;
  const box = canvas.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  const d = S.drag;
  d.moved = true;
  if (d.mode === "move") {
    const q = (px - KEYS_W) / PXQ;
    const pos = qToPos(Math.max(0, q));
    const pitch = Math.max(PITCH_LO, Math.min(PITCH_HI, PITCH_HI - Math.floor((py - TOP_H) / ROW_H)));
    Object.assign(d.note, pos, { pitch });                 // optimistic; server confirms on drop
  } else {
    const q0 = posToQ(d.note.bar, d.note.beat, d.note.tick);
    const q = Math.max(q0 + 0.05, (px - KEYS_W) / PXQ);
    // ticks back from quarters, walked in the note's own bar's beat unit —
    // close enough for a drag preview; the server's answer is the truth.
    const r = rowOf(d.note.bar);
    const ticks = Math.max(QUANT, Math.round((q - q0) / (4 / r.den) * TPB / QUANT) * QUANT);
    d.note.durTicks = ticks;
  }
  draw();
});

canvas.addEventListener("pointerup", async (e) => {
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  canvas.releasePointerCapture?.(e.pointerId);
  if (!d.moved) return;
  const t0 = performance.now();
  try {
    const r = await api({ action: "move_note", slug: S.slug, track: S.trackId, note: d.note.id,
                          bar: d.note.bar, beat: d.note.beat, tick: d.note.tick,
                          pitch: d.note.pitch, dur_ticks: d.note.durTicks });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
  } catch (err) {
    Object.assign(d.note, d.orig);                         // the server refused; put it back
    draw();
    status(err.message);
  }
});

/* ─────────────────────────────────── render → fetch → decode → hot swap */

let renderChain = Promise.resolve();

/**
 * The dirty-region loop's client half, and THE STOPWATCH. tGesture is when
 * the pointer went down; tAck when the edit route answered. This renders
 * (server re-renders only hash-missing regions), fetches the region files
 * whose urls changed, decodes, swaps — and the moment the last changed buffer
 * is swapped into the schedule is "audible".
 */
function renderAndSwap(tGesture, tAck, dirty) {
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
      // regions past a shortened project vanish from the manifest
      for (const k of [...S.buffers.keys()]) {
        if (!r.regions.some((g) => g.idx === k)) S.buffers.delete(k);
      }
      const tAudible = performance.now();
      if (tGesture !== undefined) {
        S.sw.push({ ack: tAck - tGesture, render: tRender - tGesture, audible: tAudible - tGesture });
        updateHud();
      }
      status(`render: ${r.rendered} rendered, ${r.cachedHits} cached, ${r.ms} ms`
        + (dirty ? ` · dirty: ${dirty.map((d) => `bars ${d.fromBar}-${d.toBar}`).join(", ") || "none"}` : ""));
    } catch (err) {
      status(`render failed: ${err.message}`);
    }
  });
  return renderChain;
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
  if (!S.ctx) S.ctx = new AudioContext({ sampleRate: 48000 });
  return S.ctx;
}
const projTime = () => {
  const t = audioCtx().currentTime - S.anchor;
  if (!S.loop || S.totalSeconds <= 0) return Math.max(0, t);
  return ((t % S.totalSeconds) + S.totalSeconds) % S.totalSeconds;
};

const FADE = 0.005;                                        // the 5 ms swap fade

function scheduleOcc(iter, idx) {
  const key = `${iter}:${idx}`;
  if (S.nodes.has(key)) return;
  const reg = S.buffers.get(idx);
  if (!reg?.buffer) return;
  const at = S.anchor + iter * S.totalSeconds + reg.t0;
  const ctx = audioCtx();
  const now = ctx.currentTime;
  if (at + (reg.t1 - reg.t0) <= now) return;               // already over
  const src = ctx.createBufferSource();
  src.buffer = reg.buffer;
  const gain = ctx.createGain();
  src.connect(gain).connect(ctx.destination);
  if (at >= now) {
    gain.gain.setValueAtTime(1, at);
    src.start(at);
  } else {
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE);
    src.start(now, now - at);                              // mid-region entry
  }
  src.onended = () => { S.nodes.delete(key); };
  S.nodes.set(key, { src, gain, at, idx });
}

function hotSwap(idx) {
  const ctx = audioCtx();
  const now = ctx.currentTime;
  for (const [key, n] of [...S.nodes]) {
    if (n.idx !== idx) continue;
    // fade the stale audio out over 5 ms, then let the node die
    try {
      n.gain.gain.setValueAtTime(n.gain.gain.value, now);
      n.gain.gain.linearRampToValueAtTime(0, now + FADE);
      n.src.stop(now + FADE);
    } catch { /* already stopped */ }
    S.nodes.delete(key);
    const iter = Number(key.split(":")[0]);
    scheduleOcc(iter, idx);                                // the replacement fades in
  }
}

function schedulerTick() {
  if (!S.playing || !S.totalSeconds) return;
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

async function play() {
  if (S.playing) return stop();
  const ctx = audioCtx();
  await ctx.resume();
  if (!S.buffers.size) await renderAndSwap();
  S.playing = true;
  S.anchor = ctx.currentTime + 0.08;
  S.loop = $("loopChk").checked;
  $("playBtn").textContent = "■ Stop";
  schedulerTick();
  S.schedTimer = setInterval(schedulerTick, 150);
  const raf = () => {
    if (!S.playing) return;
    draw();
    const t = projTime();
    const p = qToPos(secondsToQ(t));
    $("posLbl").textContent = `${p.bar}.${p.beat}.${p.tick}`;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}

function stop() {
  S.playing = false;
  clearInterval(S.schedTimer);
  for (const [, n] of S.nodes) { try { n.src.stop(); } catch { /* fine */ } }
  S.nodes.clear();
  $("playBtn").textContent = "▶ Play";
  draw();
}

$("playBtn").addEventListener("click", play);
$("loopChk").addEventListener("change", () => { S.loop = $("loopChk").checked; });

/* ─────────────────────────────────────────────────── sidebar wiring */

async function refreshDoc() {
  const r = await get(`/api/daw/project/${encodeURIComponent(S.slug)}`);
  S.proj = r.project;
  S.timeline = r.timeline;
  S.totalSeconds = r.totalSeconds;
  if (!S.proj.tracks.some((t) => t.id === S.trackId)) S.trackId = S.proj.tracks[0]?.id ?? null;
  drawSide();
  draw();
}

function drawSide() {
  const box = $("tracks");
  box.innerHTML = "";
  for (const t of S.proj.tracks) {
    const div = document.createElement("div");
    div.className = "track" + (t.id === S.trackId ? " sel" : "");
    const notes = t.clips.reduce((a, c) => a + c.notes.length, 0);
    div.innerHTML = `<div class="nm">${t.name}</div>
      <div class="meta"><span>${t.instrument}</span><span>${notes} notes</span>
      <button data-act="mute">${t.mute ? "unmute" : "mute"}</button>
      <button data-act="del">✕</button></div>`;
    div.addEventListener("click", async (e) => {
      const act = e.target?.dataset?.act;
      if (act === "mute") {
        const t0 = performance.now();
        const r = await api({ action: "set_track", slug: S.slug, track: t.id, mute: !t.mute });
        await refreshDoc();
        renderAndSwap(t0, performance.now(), r.dirty);
        return;
      }
      if (act === "del") {
        const t0 = performance.now();
        const r = await api({ action: "remove_track", slug: S.slug, track: t.id });
        await refreshDoc();
        renderAndSwap(t0, performance.now(), r.dirty);
        return;
      }
      S.trackId = t.id;
      drawSide(); draw();
    });
    box.appendChild(div);
  }

  const ev = $("events");
  ev.innerHTML = "";
  for (const m of S.proj.meterMap) {
    const d = document.createElement("div");
    d.innerHTML = `<span>bar ${m.atBar}: ${m.num}/${m.den}</span>`
      + (m.atBar > 1 ? `<button>✕</button>` : "");
    d.querySelector("button")?.addEventListener("click", async () => {
      const r = await api({ action: "remove_meter", slug: S.slug, at_bar: m.atBar });
      await refreshDoc(); renderAndSwap(undefined, undefined, r.dirty);
    });
    ev.appendChild(d);
  }
  for (const m of S.proj.tempoMap) {
    const d = document.createElement("div");
    d.innerHTML = `<span>bar ${m.atBar}: ${m.bpm} bpm</span>`
      + (m.atBar > 1 ? `<button>✕</button>` : "");
    d.querySelector("button")?.addEventListener("click", async () => {
      const r = await api({ action: "remove_tempo", slug: S.slug, at_bar: m.atBar });
      await refreshDoc(); renderAndSwap(undefined, undefined, r.dirty);
    });
    ev.appendChild(d);
  }
}

document.querySelectorAll("#side [data-inst]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      await api({ action: "add_track", slug: S.slug, instrument: btn.dataset.inst });
      await refreshDoc();
      S.trackId = S.proj.tracks[S.proj.tracks.length - 1].id;
      drawSide(); draw();
    } catch (err) { status(err.message); }
  });
});

$("mSet").addEventListener("click", async () => {
  const t0 = performance.now();
  try {
    const r = await api({ action: "set_meter", slug: S.slug,
                          at_bar: Number($("mBar").value), num: Number($("mNum").value), den: Number($("mDen").value) });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
  } catch (err) { status(err.message); }
});

$("tSet").addEventListener("click", async () => {
  const t0 = performance.now();
  try {
    const r = await api({ action: "set_tempo", slug: S.slug,
                          at_bar: Number($("tBar").value), bpm: Number($("tBpm").value) });
    await refreshDoc();
    renderAndSwap(t0, performance.now(), r.dirty);
  } catch (err) { status(err.message); }
});

/* ─────────────────────────────────────── P0-4: the loopback calibration */

$("calBtn").addEventListener("click", async () => {
  const note = $("calNote");
  try {
    note.textContent = "asking for the microphone…";
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // the three defaults that ruin music capture, off — report §13c
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
    const ctx = audioCtx();
    await ctx.resume();
    // fetch + decode the server's chirp, so both ends speak the same sweep
    const chirpBytes = await (await fetch("/api/daw/chirp.wav")).arrayBuffer();
    const chirp = await ctx.decodeAudioData(chirpBytes);
    // record via ScriptProcessor: prototype-grade, honest about it
    const srcNode = ctx.createMediaStreamSource(stream);
    const rec = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    rec.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    srcNode.connect(rec);
    rec.connect(ctx.destination);                          // SP needs a sink; it outputs silence
    note.textContent = "playing the chirp — keep quiet…";
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
    note.textContent = "estimating…";
    const r = await fetch(`/api/daw/calibrate?sr=${ctx.sampleRate}`, { method: "POST", body: pcm.buffer });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    note.textContent = j.confident
      ? `loopback offset: ${j.offset_ms} ms (peak ratio ${j.peak_ratio}) — recorded takes should shift earlier by this.`
      : `not confident (peak ratio ${j.peak_ratio}) — check the mic can hear the speakers and try again.`;
  } catch (err) {
    note.textContent = `calibration unavailable here: ${err.message}. The estimator itself is `
      + "proven on synthetic loopback (±1 ms, see engine_test.py); a real mic run remains unproven on this box.";
  }
});

/* ───────────────────────────────────────────────────────── projects */

async function loadProject(slug) {
  stop();
  S.slug = slug;
  S.buffers.clear();
  S.regions = [];
  S.sw = [];
  await refreshDoc();
  await renderAndSwap();
  status(`loaded ${slug}`);
}

async function boot() {
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
      await api({ action: "add_track", slug: r.slug, instrument: "pluck", name: "keys" });
      const o = document.createElement("option");
      o.value = r.slug; o.textContent = r.slug;
      sel.appendChild(o); sel.value = r.slug;
      await loadProject(r.slug);
    });
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
