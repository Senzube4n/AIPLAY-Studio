/**
 * The video studio — a multi-track timeline, a karaoke overlay and a visualiser.
 *
 * SHAPE. Modelled on Vegas Pro, deliberately: stacked tracks, clips you drag
 * along a time ruler, and per-track mute/solo. The one behaviour that makes that
 * model worth copying is that a CROSSFADE IS AN OVERLAP — you drag one clip so
 * it sits on top of the end of another and the dissolve appears, rather than
 * selecting a junction and typing a duration. There is no crossfade control in
 * this UI for the same reason there is none in Vegas: the timeline already says
 * it.
 *
 * WHAT IT IS NOT. No keyframes, no effects rack, no nested compositions, no
 * ripple edit. Every one of those is where a "simple editor" stops being simple,
 * and there are excellent free editors for people who want them.
 *
 * WHY EVERYTHING IS ONE CANVAS. Compositing in the DOM (stacked <video> with CSS
 * opacity) previews fine and cannot be exported — nothing can record what the
 * browser's compositor produced. Drawing every layer into one <canvas> means the
 * preview and the export are the SAME pixels, so what you approve is what you
 * get. It also makes both the crossfade and the track stack a globalAlpha and a
 * draw order, instead of a CSS problem nobody can seek.
 *
 * WHY MediaRecorder AND NOT ffmpeg. ffmpeg exists on the machine this was
 * written on, and assuming that is how you ship software that works for exactly
 * one person. `canvas.captureStream()` + MediaRecorder is already in the browser
 * Studio runs in, needs nothing installed, and cannot break on someone else's
 * PATH. The cost is WebM rather than MP4, which is stated in the UI rather than
 * discovered afterwards.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(Math.max(s, 0) % 60)).padStart(2, "0")}`;

/* A track is { id, kind, name, muted, solo, items[] }.
 * An item is { id, src, name, start, dur, el } — `start` in timeline seconds.
 *
 * Video tracks composite BOTTOM-UP, so the last track in this array is the one
 * you see. That is the opposite of how they are drawn in the UI (topmost row is
 * the topmost layer), and the render loop reverses once rather than every read. */
const S = {
  tracks: [],
  nextId: 1,
  playing: false,
  t: 0,
  raf: null, last: 0,
  rec: null, chunks: [], recording: false, recTimer: null, recHidden: false, onVis: null,
  vis: "bars", karaoke: true, showTitle: true,
  ac: null, analyser: null, freq: null, wave: null, mixBus: null,
  songTitle: "",
  lrc: [],
  pps: 60,          // pixels per second — the timeline's zoom
  sel: null,        // selected item id
  snap: true,
  undo: [], redo: [],
  /* Export settings. MediaRecorder records in REAL TIME, so these change what
   * the file is, never how long it takes to make. */
  out: { w: 1280, h: 720, fps: 30, mbps: 8, codec: "auto" },
  /* Effects. `beat` is what reacts, `amount` how hard, `drift` is the slow
   * Ken Burns push, `look` a colour grade, `vignette` the corner falloff. */
  fx: { beat: "punch", amount: 0.5, drift: 0, look: "none", vignette: 0 },
  // Beat detector state: a rolling mean of low-band energy and the last hit.
  beat: { hist: [], lastAt: -1, energy: 0, level: 0 },
};

/* ──────────────────────────────────────────────────────────── beat detect */

/**
 * Low-band energy against its own rolling mean.
 *
 * Adaptive rather than a fixed threshold, because a quiet intro and a loud
 * chorus have nothing in common in absolute terms and a fixed number would fire
 * constantly in one and never in the other.
 *
 * `level` decays rather than switching off, so an effect can ease out instead of
 * snapping — a hard on/off reads as a glitch, an eased one reads as a pulse.
 */
function detectBeat(now) {
  const b = S.beat;
  // Ease the previous hit down first, so a missed frame never leaves it stuck on.
  b.level = Math.max(0, b.level - 0.06);
  if (!S.analyser) return b.level;

  S.analyser.getByteFrequencyData(S.freq);
  // The bottom ~8% of the spectrum: kick and low bass, which is what people
  // actually hear as "the beat".
  const n = Math.max(4, Math.floor(S.freq.length * 0.08));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += S.freq[i];
  const energy = sum / n / 255;
  b.energy = energy;

  b.hist.push(energy);
  if (b.hist.length > 43) b.hist.shift();          // ~0.7 s at 60 fps
  const mean = b.hist.reduce((x, y) => x + y, 0) / b.hist.length;

  /* 1.35x the local mean, with a 120 ms refractory gap. The gap is what stops
   * the attack and the body of one kick registering as two hits, which is the
   * failure that makes naive detectors look jittery. */
  if (energy > mean * 1.35 && energy > 0.12 && now - b.lastAt > 120) {
    b.lastAt = now;
    b.level = 1;
  }
  return b.level;
}

/** CSS filter string for the chosen look. ctx.filter is GPU-accelerated, so a
 *  colour grade costs essentially nothing per frame. */
function lookFilter(look) {
  switch (look) {
    case "warm":  return "saturate(1.15) sepia(0.18) contrast(1.05)";
    case "cool":  return "saturate(1.1) hue-rotate(-12deg) contrast(1.08) brightness(0.98)";
    case "mono":  return "grayscale(1) contrast(1.15)";
    case "vivid": return "saturate(1.5) contrast(1.18)";
    case "faded": return "saturate(0.75) contrast(0.9) brightness(1.06)";
    default:      return "none";
  }
}

/* ─────────────────────────────────────────────────────────── undo / redo */

/**
 * Snapshot the timeline before a destructive edit.
 *
 * Structural clone of the tracks WITHOUT their media elements — those are live
 * <video>/<audio> objects, they cannot be cloned, and they are recoverable from
 * `src` anyway. Undo rebuilds them.
 *
 * A depth of 50 is plenty for a timeline of a few dozen clips and costs nothing:
 * each entry is a small array of plain objects.
 */
function snapshot() {
  return S.tracks.map((t) => ({
    ...t,
    items: t.items.map(({ el, ...rest }) => ({ ...rest })),
  }));
}

function pushUndo() {
  S.undo.push(snapshot());
  if (S.undo.length > 50) S.undo.shift();
  // Any new edit invalidates the redo branch, exactly as it does everywhere else.
  S.redo.length = 0;
  autosave();
}

/* ──────────────────────────────────────────────────────────────── autosave */

const SAVE_KEY = "aiplay-studio-project";

/**
 * The whole project, to localStorage, debounced.
 *
 * The timeline lived only in memory: a closed tab was a lost afternoon, and this
 * editor has no project file to have forgotten to save. snapshot() already
 * strips the unserialisable media elements and restore() already rebuilds them
 * from their stable /api/ URLs, so persistence is the ten lines left over.
 */
let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 1, at: Date.now(),
        tracks: snapshot(), fx: S.fx, vis: S.vis, out: S.out,
        songTitle: S.songTitle, lrc: S.lrc, t: S.t,
      }));
    } catch { /* quota or private mode — losing autosave must not break editing */ }
  }, 800);
}

/** Bring a saved project back, if one exists. Returns whether it did. */
async function restoreAutosave() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch { /* corrupt */ }
  if (!d || d.v !== 1 || !Array.isArray(d.tracks)) return false;
  if (!d.tracks.some((t) => t.items?.length)) return false;   // empty saves are noise
  S.fx = { ...S.fx, ...d.fx };
  S.vis = d.vis ?? S.vis;
  S.out = { ...S.out, ...d.out };
  S.songTitle = d.songTitle || "";
  S.lrc = d.lrc || [];
  await restore(d.tracks);
  S.t = d.t || 0;
  S.nextId = Math.max(S.nextId, ...S.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), 0) + 1;
  return true;
}

async function restore(snap) {
  for (const tr of S.tracks) for (const it of tr.items) it.el?.pause();
  S.tracks = snap.map((t) => ({ ...t, items: t.items.map((i) => ({ ...i })) }));
  // Re-attach media. Items keep their src, so this is a reload rather than a
  // re-upload, and the browser serves it from cache.
  await Promise.all(S.tracks.flatMap((tr) =>
    tr.items.map((it) => attach(it, tr.kind, { keepTiming: true }))));
  paintTimeline();
  render();
}

/** A transient "that happened — Undo" strip.
 *
 * The point is not decoration: it is the promise, made at the moment of the
 * destructive act, that the act is reversible. CapCut's forgiveness in one div. */
let toastTimer = null;
function toast(msg) {
  let el = $("stToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "stToast";
    el.innerHTML = `<span></span><button type="button">Undo</button>`;
    el.querySelector("button").onclick = () => { undo(); el.classList.remove("show"); };
    document.querySelector(".sttimeline")?.appendChild(el);
  }
  el.querySelector("span").textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

async function undo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  await restore(S.undo.pop());
}

async function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  await restore(S.redo.pop());
}

/* ───────────────────────────────────────────────────────────── operations */

const allItems = () => S.tracks.flatMap((t) => t.items.map((it) => ({ tr: t, it })));
const findItem = (id) => allItems().find((x) => x.it.id === id);

/**
 * Split every item under the playhead into two.
 *
 * The halves share a source and split its in-point, so the audio and video keep
 * playing continuously across the cut — which is what makes a split feel like a
 * cut rather than like two separate clips that happen to be adjacent.
 *
 * Splits everything under the cursor rather than only the selection: that is
 * what the S key does in Vegas, and needing to select first is a step nobody
 * wants when they are cutting to a beat.
 */
function splitAtPlayhead() {
  const t = S.t;
  const hits = allItems().filter(({ it }) => t > it.start + 0.05 && t < it.start + it.dur - 0.05);
  if (!hits.length) return;
  pushUndo();
  for (const { tr, it } of hits) {
    const into = t - it.start;
    const right = {
      ...it,
      id: S.nextId++,
      start: t,
      dur: it.dur - into,
      inPoint: (it.inPoint || 0) + into,
      el: null,
      // A fade belongs to the edge it was drawn on: the left half keeps the
      // fade-in, the right half keeps the fade-out.
      fadeIn: 0,
      fadeOut: it.fadeOut || 0,
    };
    it.dur = into;
    it.fadeOut = 0;
    tr.items.push(right);
    attach(right, tr.kind, { keepTiming: true });
  }
  paintTimeline();
  render();
}

/** Remove the selection. `ripple` also closes the gap it leaves behind. */
function deleteSelected(ripple = false) {
  const hit = findItem(S.sel);
  if (!hit) return;
  pushUndo();
  const { tr, it } = hit;
  it.el?.pause();
  tr.items = tr.items.filter((x) => x !== it);
  if (ripple) {
    // Only later items on the SAME track move. Rippling every track would
    // silently desynchronise the song from the picture.
    for (const other of tr.items) if (other.start >= it.start) other.start -= it.dur;
  }
  S.sel = null;
  paintTimeline();
  render();
}

function duplicateSelected() {
  const hit = findItem(S.sel);
  if (!hit) return;
  pushUndo();
  const { tr, it } = hit;
  const copy = { ...it, id: S.nextId++, start: it.start + it.dur, el: null };
  tr.items.push(copy);
  attach(copy, tr.kind, { keepTiming: true });
  S.sel = copy.id;
  paintTimeline();
  render();
}

/** Move a video layer up or down the stack. */
function moveTrack(id, dir) {
  const i = S.tracks.findIndex((t) => t.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.tracks.length) return;
  if (S.tracks[i].kind !== S.tracks[j].kind) return;   // video and audio do not interleave
  pushUndo();
  [S.tracks[i], S.tracks[j]] = [S.tracks[j], S.tracks[i]];
  paintTimeline();
  render();
}

/** Fit the whole project across the visible width. */
function zoomToFit() {
  const total = totalLength();
  if (!total) return;
  const w = $("stLanes").parentElement.clientWidth - 24;
  S.pps = Math.max(10, Math.min(200, w / total));
  $("stZoom").value = Math.round(S.pps);
  paintTimeline();
}

/* Kept as the DEFAULT output size only. The live values are S.out.w/h, which the
 * render settings change — a module constant here would silently override the
 * user's choice everywhere except inside render(). */
const W = 1280, H = 720;
const SNAP = 0.15;   // seconds; drag snapping to clip edges and to zero

/* ─────────────────────────────────────────────────────────── track model */

function addTrack(kind, name) {
  const t = {
    id: S.nextId++, kind,
    name: name || (kind === "video" ? "Video" : "Audio"),
    muted: false, solo: false, level: 1, items: [],
  };
  // New video layers go ON TOP, which is what "add a layer" means everywhere
  // else; new audio tracks go at the bottom of the audio group.
  if (kind === "video") S.tracks.unshift(t); else S.tracks.push(t);
  return t;
}

const videoTracks = () => S.tracks.filter((t) => t.kind === "video");
const audioTracks = () => S.tracks.filter((t) => t.kind === "audio");

/** Solo wins over mute, exactly as it does on a mixing desk: the moment anything
 * in a group is soloed, everything else in that group is silent regardless of
 * its own mute button. */
function audible(track) {
  const group = S.tracks.filter((t) => t.kind === track.kind);
  const anySolo = group.some((t) => t.solo);
  return anySolo ? track.solo : !track.muted;
}

function totalLength() {
  let end = 0;
  for (const t of S.tracks) for (const it of t.items) end = Math.max(end, it.start + it.dur);
  return end;
}

/** Alpha for one item at time t, from its overlap with the item before it ON THE
 * SAME TRACK. This is the whole crossfade implementation. */
function itemAlpha(track, it, t) {
  const into = t - it.start;
  const left = it.dur - into;

  /* Three things can dim an event, and they MULTIPLY rather than override each
   * other. A clip can be fading in from black at the same moment it is
   * dissolving from its neighbour, and picking one would make the other stop
   * working exactly when both were asked for. */
  let a = 1;

  // The crossfade: an overlap with the previous item on this track.
  const sorted = [...track.items].sort((x, y) => x.start - y.start);
  const i = sorted.indexOf(it);
  if (i > 0) {
    const overlap = sorted[i - 1].start + sorted[i - 1].dur - it.start;
    if (overlap > 0 && into < overlap) a *= clamp(into / overlap, 0, 1);
  }

  // The event's own fades, which exist for the top and tail where there is no
  // neighbour to dissolve with.
  if (it.fadeIn > 0 && into < it.fadeIn) a *= clamp(into / it.fadeIn, 0, 1);
  if (it.fadeOut > 0 && left < it.fadeOut) a *= clamp(left / it.fadeOut, 0, 1);

  return a;
}

/* ─────────────────────────────────────────────────────────────────── LRC */

function parseLrc(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (!m) continue;
    const s = m[3].trim();
    if (s) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: s });
  }
  return out;
}

function mergeWords(lines, words) {
  if (!words?.length) return lines;
  return lines.map((ln, i) => {
    const end = lines[i + 1]?.t ?? Infinity;
    return { ...ln, words: words.filter((w) => w.t >= ln.t - 0.05 && w.t < end) };
  });
}

/* ───────────────────────────────────────────────────────────────── audio */

/** One AudioContext, one analyser, and every audio element routed through it.
 *
 * ⚠ `createMediaElementSource` REROUTES an element: once it exists the sound
 * only reaches the speakers through the graph, so a missing connect to
 * `destination` makes playback silently mute. Calling it twice on the same
 * element throws, hence the per-element flag. */
function ensureBus() {
  if (S.ac) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  S.ac = new AC();
  S.analyser = S.ac.createAnalyser();
  S.analyser.fftSize = 2048;
  S.analyser.smoothingTimeConstant = 0.8;
  S.mixBus = S.ac.createGain();
  S.mixBus.connect(S.analyser);
  S.analyser.connect(S.ac.destination);
  S.freq = new Uint8Array(S.analyser.frequencyBinCount);
  S.wave = new Uint8Array(S.analyser.fftSize);
}

function routeAudio(el) {
  ensureBus();
  if (el.__routed) return;
  el.__routed = true;
  try {
    S.ac.createMediaElementSource(el).connect(S.mixBus);
  } catch {
    // Already routed by someone else, or the element is not eligible. Losing the
    // visualiser for one clip is not worth failing playback over.
  }
}

/* ─────────────────────────────────────────────────────────────── drawing */

function drawCover(ctx, el, w, h) {
  const vw = el.videoWidth || 0, vh = el.videoHeight || 0;
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawVisualiser(ctx, w, h) {
  if (!S.analyser || S.vis === "off") return;
  const g = ctx;
  if (S.vis === "bars") {
    S.analyser.getByteFrequencyData(S.freq);
    // Only the low 60% of the bins: the top of an FFT on music is nearly empty,
    // and a bar chart that is 40% flat reads as broken rather than as quiet.
    const n = Math.floor(S.freq.length * 0.6), bars = 64, bw = w / bars;
    g.save();
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < bars; i++) {
      const v = S.freq[Math.floor((i / bars) * n)] / 255;
      const bh = v * h * 0.28;
      g.fillStyle = `hsla(${190 + v * 90}, 90%, ${45 + v * 25}%, .75)`;
      g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
    }
    g.restore();
  } else if (S.vis === "wave") {
    S.analyser.getByteTimeDomainData(S.wave);
    g.save();
    g.strokeStyle = "rgba(120,220,255,.85)";
    g.lineWidth = 3;
    g.beginPath();
    for (let i = 0; i < S.wave.length; i++) {
      const x = (i / S.wave.length) * w;
      const y = h * 0.5 + ((S.wave[i] - 128) / 128) * h * 0.22;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.restore();
  } else if (S.vis === "radial") {
    S.analyser.getByteFrequencyData(S.freq);
    const cx = w / 2, cy = h / 2, r0 = Math.min(w, h) * 0.18, spokes = 96;
    g.save();
    g.globalCompositeOperation = "lighter";
    g.lineWidth = 3;
    for (let i = 0; i < spokes; i++) {
      const v = S.freq[Math.floor((i / spokes) * S.freq.length * 0.6)] / 255;
      const a = (i / spokes) * Math.PI * 2 - Math.PI / 2;
      const r1 = r0 + v * Math.min(w, h) * 0.22;
      g.strokeStyle = `hsla(${200 + v * 100}, 95%, ${50 + v * 20}%, .8)`;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
    }
    g.restore();
  }
}

function drawKaraoke(ctx, w, h, t) {
  if (!S.karaoke || !S.lrc.length) return;
  let i = -1;
  for (let k = 0; k < S.lrc.length; k++) if (S.lrc[k].t <= t) i = k; else break;
  if (i < 0) return;
  const cur = S.lrc[i], next = S.lrc[i + 1];

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // A scrim, because lyrics over a bright frame are unreadable and "add a text
  // shadow" only works until the frame is white.
  const gy = h * 0.62;
  const grad = ctx.createLinearGradient(0, gy - 60, 0, h);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,.72)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, gy - 60, w, h - gy + 60);

  ctx.font = `600 ${Math.round(h * 0.062)}px ui-sans-serif, system-ui, sans-serif`;
  if (cur.words?.length) {
    /* Word level: draw the line twice — once dim, once bright but CLIPPED to the
     * words already sung. Clipping rather than drawing word by word preserves
     * the kerning of the real line, which is what stops it looking like a row of
     * separate words. */
    const full = cur.words.map((x) => x.text).join(" ");
    const done = cur.words.filter((x) => x.t <= t).length;
    const upto = cur.words.slice(0, done).map((x) => x.text).join(" ");
    const wFull = ctx.measureText(full).width;
    const wDone = done ? ctx.measureText(upto + (done < cur.words.length ? " " : "")).width : 0;
    const x0 = (w - wFull) / 2, y = h * 0.78;
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.fillText(full, w / 2, y);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y - h * 0.06, wDone, h * 0.12);
    ctx.clip();
    ctx.fillStyle = "#7fdcff";
    ctx.fillText(full, w / 2, y);
    ctx.restore();
  } else {
    ctx.fillStyle = "#fff";
    ctx.fillText(cur.text, w / 2, h * 0.78);
  }
  if (next) {
    ctx.font = `400 ${Math.round(h * 0.036)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,.4)";
    ctx.fillText(next.text, w / 2, h * 0.88);
  }
  ctx.restore();
}

function drawTitle(ctx, w, h, t) {
  // First few seconds only. A title that never leaves is a watermark, and nobody
  // asked for a watermark.
  if (!S.showTitle || !S.songTitle || t > 4.5) return;
  ctx.save();
  ctx.globalAlpha = clamp(t < 3.5 ? 1 : 1 - (t - 3.5), 0, 1);
  ctx.textAlign = "left";
  ctx.font = `600 ${Math.round(h * 0.055)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.fillText(S.songTitle, w * 0.06 + 2, h * 0.14 + 2);
  ctx.fillStyle = "#fff";
  ctx.fillText(S.songTitle, w * 0.06, h * 0.14);
  ctx.restore();
}

function render() {
  const cv = $("stCanvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const t = S.t, total = totalLength();

  const W = S.out.w, H = S.out.h;
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  /* Effects wrap only the PICTURE. Lyrics, the title card and the visualiser are
   * drawn afterwards, outside this save/restore — a karaoke line that shakes
   * with the kick is unreadable, and a vignette over the text just dims it. */
  const hit = detectBeat(performance.now());
  const amt = S.fx.amount;
  ctx.save();
  ctx.filter = lookFilter(S.fx.look);

  // Ken Burns: a slow push across the whole timeline. Not reactive — it exists
  // so a still or a short loop is not visually dead between beats.
  // `total` is already in scope from the top of render(); redeclaring it here is
  // a SyntaxError that kills the whole module, not a shadow.
  const drift = 1 + (S.fx.drift * 0.12) * (t / Math.max(total, 0.001));

  let scale = drift, dx = 0, dy = 0;
  if (S.fx.beat === "punch") scale *= 1 + hit * 0.09 * amt;
  if (S.fx.beat === "shake") {
    // Deterministic wobble rather than Math.random: a random shake differs
    // between the preview and the export, so what you approved is not what you
    // get. Driven by the clock, it is identical both times.
    dx = Math.sin(t * 47) * hit * 22 * amt;
    dy = Math.cos(t * 61) * hit * 22 * amt;
  }
  if (scale !== 1 || dx || dy) {
    ctx.translate(W / 2 + dx, H / 2 + dy);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, -H / 2);
  }

  // Bottom layer first. `videoTracks()` is in display order (top row first), so
  // reverse it to paint the bottom-most layer first and the top-most last.
  const vts = videoTracks().slice().reverse();
  let drewAnything = false;
  for (const tr of vts) {
    if (!audible(tr)) continue;
    for (const it of [...tr.items].sort((a, b) => a.start - b.start)) {
      if (t < it.start || t > it.start + it.dur) continue;
      if (!it.el || it.el.readyState < 2) continue;
      // Track level is opacity for a video layer — the "less of that" control
      // that sits between full and muted.
      ctx.globalAlpha = itemAlpha(tr, it, t) * (tr.level ?? 1);
      drawCover(ctx, it.el, W, H);
      ctx.globalAlpha = 1;
      drewAnything = true;
    }
  }
  if (!drewAnything && !total) {
    ctx.fillStyle = "#16181c";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#5b6068";
    ctx.font = "400 28px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Drag clips from the right onto a track below", W / 2, H / 2);
  }

  /* RGB split: the same frame drawn twice more, offset and additively blended.
   * Cheap, and it is the effect people mean when they say "make it glitch". */
  if (S.fx.beat === "rgb" && hit > 0.01) {
    const off = hit * 14 * amt;
    ctx.globalCompositeOperation = "lighter";
    for (const [ch, sx] of [["#f00", -off], ["#0ff", off]]) {
      ctx.save();
      ctx.globalAlpha = 0.35 * hit;
      ctx.fillStyle = ch;
      ctx.translate(sx, 0);
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
  ctx.filter = "none";

  // Flash sits outside the transform so it covers the whole frame rather than
  // the scaled picture, which would leave unlit edges on a punch.
  if (S.fx.beat === "flash" && hit > 0.01) {
    ctx.save();
    ctx.globalAlpha = hit * 0.35 * amt;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  if (S.fx.vignette > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${S.fx.vignette * 0.85})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  drawVisualiser(ctx, W, H);
  drawKaraoke(ctx, W, H, t);
  drawTitle(ctx, W, H, t);

  $("stTime").textContent = `${fmt(t)} / ${fmt(total)}`;
  const sk = $("stSeekFill");
  if (sk) sk.style.width = total ? `${(clamp(t / total, 0, 1)) * 100}%` : "0%";
  paintPlayhead();
}

/* ───────────────────────────────────────────────────────── transport */

/** Keep every media element pointing at the right moment.
 *
 * Returns the element that should act as the master clock: the first audible
 * audio element that is genuinely playing. */
function syncMedia() {
  let clock = null;
  for (const tr of S.tracks) {
    const on = audible(tr);
    for (const it of tr.items) {
      const el = it.el;
      if (!el) continue;
      const local = S.t - it.start;
      const live = on && local >= -0.15 && local <= it.dur;
      if (live) {
        // Only correct a clip's own clock when it has genuinely drifted. Writing
        // currentTime every frame restarts decoding and produces exactly the
        // stutter this feature exists to avoid.
        const want = clamp(local + (it.inPoint || 0), 0, it.srcDur || it.dur);
        if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
        el.muted = tr.kind === "video";     // video layers are picture only
        /* An audio event's fades and its track level are applied to the ELEMENT
         * rather than to the mix bus, because they are per-item and per-track
         * while the bus is shared. Video gets the same numbers as opacity in
         * render(), so a fade means the same thing on both kinds of track. */
        if (tr.kind === "audio") {
          el.volume = clamp(itemAlpha(tr, it, S.t) * (tr.level ?? 1), 0, 1);
        }
        if (S.playing && el.paused) el.play().catch(() => {});
        if (!S.playing && !el.paused) el.pause();
        if (tr.kind === "audio" && !el.paused && !clock) clock = el;
      } else if (!el.paused) {
        el.pause();
      }
    }
  }
  return clock;
}

function tick(now) {
  const dt = S.last ? (now - S.last) / 1000 : 0;
  S.last = now;
  const clock = syncMedia();
  if (S.playing) {
    /* An AUDIO TRACK is the clock whenever one is playing.
     *
     * Accumulating requestAnimationFrame deltas drifts: every dropped frame is
     * time the timeline never counts, so the lyrics slide further behind the
     * vocal the longer the song runs — which is the one thing karaoke is judged
     * on. An audio element's currentTime is driven by the sound card and cannot
     * drift against what you are hearing. Delta accumulation is the fallback for
     * a picture-only timeline, where there is nothing to be out of sync with. */
    if (clock && Number.isFinite(clock.currentTime)) {
      const it = itemOf(clock);
      S.t = it ? it.start + clock.currentTime - (it.inPoint || 0) : clock.currentTime;
    } else {
      S.t += dt;
    }
  }
  const total = totalLength();
  if (S.t >= total && total > 0) {
    S.t = total;
    if (S.recording) stopExport(); else pause();
  }
  render();
  S.raf = requestAnimationFrame(tick);
}

function itemOf(el) {
  for (const tr of S.tracks) for (const it of tr.items) if (it.el === el) return it;
  return null;
}

function play() {
  if (!totalLength()) return;
  ensureBus();
  if (S.ac?.state === "suspended") S.ac.resume();
  S.playing = true;
  $("stPlay").textContent = "❚❚";
}
function pause() {
  S.playing = false;
  $("stPlay").textContent = "▶";
  syncMedia();
}
function seek(t) {
  S.t = clamp(t, 0, Math.max(totalLength(), 0.001));
  syncMedia();
  render();
}

/* ───────────────────────────────────────────────────────────── export */

/**
 * Read the render settings and say what they will cost.
 *
 * The estimate is bitrate x duration and nothing cleverer, because that IS what
 * a constant-bitrate recording produces. Quoting a number from a model of VP9's
 * rate control would be a guess dressed as a figure.
 */
function readRenderOpts() {
  const [w, h] = ($("stResW").value || "1280x720").split("x").map(Number);
  S.out = {
    w, h,
    fps: Number($("stFps").value),
    mbps: Number($("stMbps").value),
    codec: $("stCodec").value,
  };
  $("stMbpsV").textContent = `${S.out.mbps} Mbps`;

  const total = totalLength();
  const mb = (S.out.mbps * total) / 8;
  const cv = $("stCanvas");
  if (cv && (cv.width !== w || cv.height !== h)) {
    // The canvas IS the output. Resizing it here rather than at export time
    // means the preview shows the framing you will actually get — a 16:9 preview
    // that exports vertical would be a trap.
    cv.width = w; cv.height = h;
    render();
  }
  $("stRenderNote").textContent = total
    ? `${w}×${h} at ${S.out.fps} fps — about ${mb.toFixed(0)} MB for ${fmt(total)}, `
      + `and it takes ${fmt(total)} to record because the capture is real time.`
    : "Add something to the timeline to see an estimate.";
}

async function startExport() {
  if (!totalLength()) return;
  /* captureStream(0), NOT captureStream(30).
   *
   * An automatic capture rate only samples the canvas when the browser paints
   * it, and the browser stops painting a background tab entirely — measured
   * here: requestAnimationFrame fired ZERO times in 800 ms with the window
   * unfocused, and a 2.5-second recording produced 0 chunks and 0 bytes. A
   * silently empty export after waiting out a real-time render is about the
   * worst outcome this feature has available.
   *
   * Rate 0 means "only the frames I hand you". Driving them from a timer and
   * calling requestFrame() ourselves keeps the recording alive when the tab is
   * hidden — the same test then produced 10 chunks and 48 KB. Timers are still
   * throttled in the background, so it degrades to a low frame rate rather than
   * staying perfect, and the warning below says so instead of letting it look
   * fine. */
  readRenderOpts();
  const stream = $("stCanvas").captureStream(0);
  ensureBus();
  // Tap the mix for the recording without unhooking the speakers.
  const dest = S.ac.createMediaStreamDestination();
  S.analyser.connect(dest);
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);

  /* Honour the chosen codec, but fall back rather than fail: a browser that
   * cannot do VP9 should still produce a file, and finding that out after a
   * real-time render would be the worst possible moment. */
  const wanted = S.out.codec === "vp9" ? ["video/webm;codecs=vp9,opus"]
    : S.out.codec === "vp8" ? ["video/webm;codecs=vp8,opus"]
    : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"];
  const types = [...wanted, "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  S.chunks = [];
  S.rec = new MediaRecorder(stream, mime
    ? { mimeType: mime, videoBitsPerSecond: S.out.mbps * 1_000_000 }
    : undefined);
  S.rec.ondataavailable = (e) => { if (e.data.size) S.chunks.push(e.data); };
  S.rec.onstop = saveExport;
  S.recording = true;
  seek(0);
  S.rec.start(250);
  play();

  /* Hand the recorder a frame on a fixed cadence, independent of rAF. */
  const track = stream.getVideoTracks()[0];
  S.recTimer = setInterval(() => {
    if (!S.recording) return;
    // When rAF is alive it has already advanced and drawn this frame; when it is
    // not, this is the only thing keeping the export moving.
    if (document.hidden) { S.t += 1 / S.out.fps; syncMedia(); render(); }
    track.requestFrame?.();
  }, 1000 / S.out.fps);

  /* Say it, rather than letting a quiet export look like a good one. */
  S.recHidden = false;
  S.onVis = () => {
    if (!S.recording) return;
    if (document.hidden) {
      S.recHidden = true;
      $("stExportNote").textContent = "⚠ This window went to the background — the browser throttles it, so the export is still recording but at a lower frame rate. Bring it back to the front.";
    } else if (S.recHidden) {
      $("stExportNote").textContent = "Recording again at full rate. Some earlier frames were captured slowly.";
    }
  };
  document.addEventListener("visibilitychange", S.onVis);

  $("stExport").textContent = "Stop recording";
  $("stExportNote").textContent = "Recording in real time — keep this window in front until it finishes.";
  // visibilitychange only fires on a CHANGE, so starting while already hidden
  // would otherwise record a throttled export and say nothing about it.
  if (document.hidden) S.onVis();
}

function stopExport() {
  if (!S.rec) return;
  S.recording = false;
  clearInterval(S.recTimer);
  S.recTimer = null;
  if (S.onVis) { document.removeEventListener("visibilitychange", S.onVis); S.onVis = null; }
  pause();
  S.rec.stop();
  $("stExport").textContent = "Export video";
}

async function saveExport() {
  const blob = new Blob(S.chunks, { type: S.chunks[0]?.type || "video/webm" });
  $("stExportNote").textContent = `Saving ${(blob.size / 1048576).toFixed(1)} MB…`;
  try {
    const r = await fetch("/api/studio/save", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Title": encodeURIComponent(S.songTitle || "timeline") },
      body: blob,
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    /* The duration caveat, stated once where it matters.
     *
     * MediaRecorder writes a live WebM stream, and a live stream has no duration
     * in its header — ffprobe reports `duration=N/A`. Players handle it, but the
     * scrub bar can misbehave until the file has been played through once or
     * remuxed. Studio will not remux it: that would mean depending on ffmpeg,
     * which is exactly the dependency this whole export path exists to avoid. */
    $("stExportNote").innerHTML = `Saved as <b>${esc(d.name)}</b> — it is in your clip library. `
      + `<span class="sp meta">WebM from a live recording, so some players show no duration until it has been played once.</span>`;
  } catch (e) {
    // Fall back to a browser download rather than losing the render: the
    // recording already cost real time and should not evaporate on a bad route.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(S.songTitle || "timeline").replace(/[^\w-]+/g, "_")}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    $("stExportNote").textContent = `Could not save to the library (${e.message}) — downloaded instead.`;
  }
}

/* ────────────────────────────────────────────────────── media loading */

/** Attach a media element to an item and learn its real duration. */
/**
 * Give an item a media element.
 *
 * `keepTiming` is the whole reason this has an options bag. On a FRESH clip we
 * want the file's own length; on a split half, a duplicate or anything restored
 * by undo, the timing is already correct and overwriting it would silently undo
 * the edit that just happened — a split would snap back to full length the
 * moment its media loaded.
 */
async function attach(it, kind, { keepTiming = false } = {}) {
  const el = document.createElement(kind === "audio" ? "audio" : "video");
  el.src = it.src;
  el.preload = "auto";
  el.playsInline = true;
  el.muted = kind === "video";
  el.crossOrigin = "anonymous";
  /* Repaint when a seek lands. Setting currentTime is asynchronous, so drawing
   * straight after a scrub paints the PREVIOUS position — while playing the next
   * animation frame hides it, but on a paused scrub, which is most of how a
   * timeline is used, the picture would sit one seek behind the handle. */
  el.addEventListener("seeked", () => render());
  it.el = el;
  await new Promise((res) => {
    el.onloadedmetadata = res;
    el.onerror = res;
    setTimeout(res, 6000);
  });
  // srcDur is the file's real length; dur is how much of it this item uses.
  // Trimming changes dur (and inPoint), never srcDur, so a trim is undoable by
  // dragging the edge back out rather than by re-adding the clip.
  const real = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 5;
  it.srcDur = it.srcDur || real;
  if (!keepTiming) {
    it.dur = real;
    it.inPoint = 0;
  }
  if (kind === "audio") routeAudio(el);
  paintTimeline();
  render();
}

/** Drop a clip onto a video track at a given time. */
async function addClipTo(track, name, at) {
  const it = {
    id: S.nextId++, name,
    src: `/api/clip/${encodeURIComponent(name)}`,
    start: Math.max(0, at), dur: 5, el: null,
  };
  track.items.push(it);
  paintTimeline();
  await attach(it, "video");
}

/** Put a song on an audio track, and load its lyrics if it has any. */
async function addSongTo(track, file, at) {
  const t = (window.__aiplayLibrary || []).find((x) => x.file === file);
  if (!t) return;
  const it = {
    id: S.nextId++, name: t.title || file,
    src: `/api/audio/${encodeURIComponent(file)}`,
    start: Math.max(0, at), dur: t.durationSeconds || 30, el: null,
  };
  track.items.push(it);
  paintTimeline();
  await attach(it, "audio");

  // The first song on the timeline owns the title card and the karaoke.
  if (!S.songTitle) S.songTitle = t.title || file;
  if (t.lrc && !S.lrc.length) {
    $("stLrcNote").textContent = "Loading timed lyrics…";
    try {
      const [lines, words] = await Promise.all([
        fetch(`/api/lrc/${encodeURIComponent(t.lrc)}`).then((r) => r.text()),
        t.wordLrc ? fetch(`/api/lrc/${encodeURIComponent(t.wordLrc)}`).then((r) => r.text()).catch(() => "") : Promise.resolve(""),
      ]);
      const w = parseLrc(words);
      S.lrc = mergeWords(parseLrc(lines), w);
      const conf = t.lrcConfidence != null ? ` · ${Math.round(t.lrcConfidence * 100)}% of words timed by measurement` : "";
      $("stLrcNote").textContent = `${S.lrc.length} lines${w.length ? ", word level" : ""}${conf}.`;
      /* The ruler's section ticks read S.lrc, which has only just arrived — the
       * timeline was painted before this fetch resolved, so without a repaint
       * the song's structure never appears until some unrelated edit. */
      paintTimeline();
    } catch {
      $("stLrcNote").textContent = "Could not read the lyrics file.";
    }
  } else if (!t.lrc) {
    $("stLrcNote").textContent = "This song has no timed lyrics — turn them on in Settings and run it again.";
  }
  render();
}

/* ────────────────────────────────────────────────────────────── the UI */

function paintPlayhead() {
  const ph = $("stPlayhead");
  if (!ph) return;
  ph.style.transform = `translateX(${S.t * S.pps}px)`;
}

/** Where the song's sections start: the lyric lines that follow a gap.
 *
 * The LRC is already loaded for karaoke, so structure is free. Only lines
 * preceded by ≥1.5 s of silence count — every line would be tick soup; the ones
 * after a breath are verses and choruses, which is where people actually cut. */
function sectionTimes() {
  const out = [];
  for (let i = 0; i < S.lrc.length; i++) {
    const prev = i ? S.lrc[i - 1].t : -10;
    if (S.lrc[i].t - prev >= 1.5) out.push(S.lrc[i].t);
  }
  return out;
}

function rulerHtml(total) {
  // A tick a second, a label every five. Denser than that is unreadable at any
  // zoom this timeline supports.
  const secs = Math.ceil(Math.max(total, 10)) + 5;
  let h = "";
  for (let i = 0; i <= secs; i++) {
    h += `<span class="sttick${i % 5 === 0 ? " maj" : ""}" style="left:${i * S.pps}px">${
      i % 5 === 0 ? `<b>${fmt(i)}</b>` : ""}</span>`;
  }
  // Section marks ride above the second-ticks, in the accent colour, so the
  // song's shape is visible on the ruler without a marker system to manage.
  for (const t of sectionTimes()) {
    h += `<span class="stsection" style="left:${t * S.pps}px" title="section starts here"></span>`;
  }
  return h;
}

function paintTimeline() {
  const total = totalLength();
  const width = Math.max((total + 6) * S.pps, 900);
  $("stTotal").textContent = total
    ? `${S.tracks.reduce((n, t) => n + t.items.length, 0)} item${S.tracks.reduce((n, t) => n + t.items.length, 0) === 1 ? "" : "s"} · ${fmt(total)}`
    : "";

  $("stHeads").innerHTML = S.tracks.map((tr) => `
    <div class="sthead2${audible(tr) ? "" : " off"}" data-track="${tr.id}">
      <div class="sthrow">
        <span class="stkind">${tr.kind === "video" ? "▣" : "♪"}</span>
        <span class="stlabel" title="${esc(tr.name)}">${esc(tr.name)}</span>
        <button class="sttog" data-up="${tr.id}" title="Move this layer up">▲</button>
        <button class="sttog" data-down="${tr.id}" title="Move this layer down">▼</button>
        <button class="sttog${tr.muted ? " on" : ""}" data-mute="${tr.id}" title="${tr.kind === "video" ? "Hide this layer" : "Mute this track"}">M</button>
        <button class="sttog${tr.solo ? " on solo" : ""}" data-solo="${tr.id}" title="Solo">S</button>
        <button class="sttog warn" data-deltrack="${tr.id}" title="Remove this track">✕</button>
      </div>
      <input class="stlevel" type="range" min="0" max="100" value="${Math.round((tr.level ?? 1) * 100)}"
             data-level="${tr.id}" title="${tr.kind === "video" ? "Layer opacity" : "Track volume"}">
    </div>`).join("");

  $("stRuler").style.width = `${width}px`;
  $("stRuler").innerHTML = rulerHtml(total);
  $("stLanes").style.width = `${width}px`;
  $("stLanes").innerHTML = S.tracks.map((tr) => `
    <div class="stlane${audible(tr) ? "" : " off"}" data-lane="${tr.id}">
      ${[...tr.items].sort((a, b) => a.start - b.start).map((it, i, arr) => {
        const prev = arr[i - 1];
        const ov = prev ? prev.start + prev.dur - it.start : 0;
        return `<div class="stclip${S.sel === it.id ? " sel" : ""}${tr.kind === "audio" ? " aud" : ""}"
             data-item="${it.id}" data-track="${tr.id}"
             style="left:${it.start * S.pps}px;width:${Math.max(it.dur * S.pps, 18)}px">
          ${ov > 0 ? `<span class="stxf" style="width:${ov * S.pps}px" title="Crossfade ${ov.toFixed(1)}s — drag to change"></span>` : ""}
          <span class="stclipname">${esc(it.name.replace(/\.(mp4|webm)$/, ""))}</span>
          <span class="sttrim l" data-trim="${it.id}" data-edge="l" title="Trim the start"></span>
          <span class="sttrim r" data-trim="${it.id}" data-edge="r" title="Trim the end"></span>
          <!-- Fade handles, drawn as the wedge they produce. Top corners, like
               Vegas, so they never collide with the trim edges below them. -->
          <span class="stfade in" data-fade="${it.id}" data-edge="in"
                style="width:${Math.max((it.fadeIn || 0) * S.pps, 0)}px" title="Drag to fade in"></span>
          <span class="stfade out" data-fade="${it.id}" data-edge="out"
                style="width:${Math.max((it.fadeOut || 0) * S.pps, 0)}px" title="Drag to fade out"></span>
          <button class="stclipx" data-delitem="${it.id}" title="Remove">✕</button>
        </div>`;
      }).join("")}
    </div>`).join("");
  paintPlayhead();
}

function paintSongs() {
  const lib = (window.__aiplayLibrary || []).filter((t) => !t.file.startsWith("clip:"));
  $("stSongs").innerHTML = lib.length
    ? lib.map((t) => `<div class="stsong" draggable="true" data-song="${esc(t.file)}"
          title="${esc(t.title || t.file)}${t.lrc ? " · has timed lyrics" : ""}">
        ${t.thumb || t.cover
          ? `<img src="/api/cover/${encodeURIComponent(t.thumb || t.cover)}" alt="" loading="lazy">`
          : '<span class="stsongart">♪</span>'}
        <span class="stsongbody">
          <b>${esc(t.title || t.file)}</b>
          <span>${t.durationSeconds ? fmt(t.durationSeconds) : ""}${t.lrc ? " · lyrics" : ""}</span>
        </span>
      </div>`).join("")
    : '<p class="clipempty">No songs yet — make one on the Create page.</p>';
}

function paintPicker() {
  const clips = window.__aiplayClips || [];
  $("stPicker").innerHTML = clips.length
    ? clips.map((c) => `<div class="stpick" draggable="true" data-clip="${esc(c.name)}">
        <video src="/api/clip/${encodeURIComponent(c.name)}#t=0.1" muted preload="metadata"></video>
        <span>${esc(c.title || c.name.replace(/\.(mp4|webm)$/, ""))}</span></div>`).join("")
    : '<p class="clipempty">Render some clips on the Video page first.</p>';
}

/** Where in the timeline a pointer event landed, in seconds. */
function timeAt(clientX) {
  const box = $("stLanes").getBoundingClientRect();
  return Math.max(0, (clientX - box.left) / S.pps);
}

/** Snap to zero, to the playhead, and to any clip edge — the three places you
 * actually want to land. Without this, butting two clips together by hand is
 * fiddly and leaves one-pixel gaps that flash black on playback. */
function snap(t, ignoreId) {
  if (!S.snap) return t;
  const cands = [0, S.t, ...sectionTimes()];
  for (const tr of S.tracks) for (const it of tr.items) {
    if (it.id === ignoreId) continue;
    cands.push(it.start, it.start + it.dur);
  }
  let best = t, bestD = SNAP;
  for (const c of cands) {
    const d = Math.abs(c - t);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

export function initStudio() {
  if ($("stLanes")?.dataset.wired) return;
  $("stLanes").dataset.wired = "1";
  const cv = $("stCanvas");
  cv.width = S.out.w; cv.height = S.out.h;

  if (!S.tracks.length) {
    // A saved project beats the seed layout. The seed only exists to show what
    // the track stack is FOR; a returning user already knows.
    restoreAutosave().then((had) => {
      if (had) { paintTimeline(); render(); toast("Restored your last session"); }
    });
    addTrack("video", "Video 2");
    addTrack("video", "Video 1");
    addTrack("audio", "Music");
  }

  $("stPlay").onclick = () => (S.playing ? pause() : play());
  /* The monitor's own scrub strip. The ruler also scrubs, but once a few tracks
   * exist the ruler is below the fold, and "watch it back" should never require
   * scrolling away from the picture. */
  {
    const bar = $("stSeek");
    let seeking = false;
    const to = (e) => {
      const b = bar.getBoundingClientRect();
      seek(clamp((e.clientX - b.left) / b.width, 0, 1) * totalLength());
    };
    bar.addEventListener("pointerdown", (e) => { seeking = true; bar.setPointerCapture(e.pointerId); to(e); });
    bar.addEventListener("pointermove", (e) => { if (seeking) to(e); });
    bar.addEventListener("pointerup", () => { seeking = false; });
  }
  $("stVis").onchange = (e) => { S.vis = e.target.value; render(); };
  $("stKaraoke").onchange = (e) => { S.karaoke = e.target.checked; render(); };
  $("stTitleCard").onchange = (e) => { S.showTitle = e.target.checked; render(); };
  $("stExport").onclick = () => (S.recording ? stopExport() : startExport());
  $("stAddVideo").onclick = () => { addTrack("video", `Video ${videoTracks().length + 1}`); paintTimeline(); };
  $("stAddAudio").onclick = () => { addTrack("audio", `Audio ${audioTracks().length + 1}`); paintTimeline(); };
  $("stZoom").oninput = (e) => { S.pps = Number(e.target.value); paintTimeline(); };
  /* Presets: named boards, applied by writing the CONTROLS and re-reading them.
   * Going through the controls rather than S.fx directly means Fine-tune always
   * shows the truth of what a preset chose, and tweaking one slider afterwards
   * just works — the preset is a starting point, not a mode. */
  const PRESETS = {
    clean: { beat: "none", amt: 50, look: "none", drift: 0, vig: 0, vis: "off", karaoke: true },
    mv:    { beat: "punch", amt: 55, look: "vivid", drift: 20, vig: 25, vis: "bars", karaoke: true },
    retro: { beat: "rgb", amt: 45, look: "faded", drift: 15, vig: 45, vis: "wave", karaoke: true },
    hype:  { beat: "shake", amt: 70, look: "vivid", drift: 30, vig: 15, vis: "radial", karaoke: true },
    film:  { beat: "none", amt: 50, look: "warm", drift: 25, vig: 55, vis: "off", karaoke: true },
  };
  $("stPresets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    const pz = PRESETS[b.dataset.preset];
    if (!pz) return;
    for (const x of document.querySelectorAll(".stpreset")) x.classList.toggle("on", x === b);
    $("stFxBeat").value = pz.beat;
    $("stFxAmt").value = pz.amt;
    $("stFxLook").value = pz.look;
    $("stFxDrift").value = pz.drift;
    $("stFxVig").value = pz.vig;
    $("stVis").value = pz.vis;
    $("stKaraoke").checked = pz.karaoke;
    S.vis = pz.vis;
    fxRead();
    fineState();
  });

  /* The fold's summary carries a one-line digest, so a closed Fine-tune still
   * says what is active instead of hiding it. */
  const fineState = () => {
    const bits = [];
    if (S.fx.beat !== "none") bits.push(S.fx.beat);
    if (S.fx.look !== "none") bits.push(S.fx.look);
    if (S.fx.drift) bits.push("zoom");
    if (S.fx.vignette) bits.push("vignette");
    if (S.vis !== "off") bits.push(`vis:${S.vis}`);
    $("stFineState").textContent = bits.join(" · ") || "all off";
  };

  /* Effects. Repaint on change so a paused timeline still shows the look —
   * having to press play to see whether you like a grade is the kind of thing
   * that makes people not bother. */
  const fxRead = () => {
    S.fx.beat = $("stFxBeat").value;
    S.fx.amount = Number($("stFxAmt").value) / 100;
    S.fx.look = $("stFxLook").value;
    S.fx.drift = Number($("stFxDrift").value) / 100;
    S.fx.vignette = Number($("stFxVig").value) / 100;
    $("stFxDriftV").textContent = S.fx.drift ? `${Math.round(S.fx.drift * 100)}%` : "off";
    $("stFxVigV").textContent = S.fx.vignette ? `${Math.round(S.fx.vignette * 100)}%` : "off";
    render();
  };
  for (const id of ["stFxBeat", "stFxAmt", "stFxLook", "stFxDrift", "stFxVig"]) {
    $(id).oninput = () => {
      // Hand-tuning leaves preset-land: the chip un-highlights so it cannot
      // claim to describe a board it no longer matches.
      for (const x of document.querySelectorAll(".stpreset")) x.classList.remove("on");
      fxRead(); fineState();
    };
  }
  fxRead();
  fineState();

  $("stSplit").onclick = splitAtPlayhead;
  $("stDup").onclick = duplicateSelected;
  $("stDel").onclick = (e) => deleteSelected(e.ctrlKey || e.metaKey);
  $("stUndo").onclick = undo;
  $("stRedo").onclick = redo;
  $("stFit").onclick = zoomToFit;
  $("stSnap").onchange = (e) => { S.snap = e.target.checked; };
  $("stRenderOpts").onclick = () => {
    const p = $("stRenderPanel");
    p.hidden = !p.hidden;
    $("stRenderOpts").textContent = p.hidden ? "Render settings ▾" : "Render settings ▴";
  };
  for (const id of ["stResW", "stFps", "stMbps", "stCodec"]) $(id).oninput = readRenderOpts;
  readRenderOpts();
  $("stClear").onclick = () => {
    pushUndo();
    for (const tr of S.tracks) { for (const it of tr.items) it.el?.pause(); tr.items = []; }
    S.lrc = []; S.songTitle = ""; S.t = 0;
    paintTimeline(); render();
    toast("Timeline cleared");
  };

  /* The asset tabs. One visible at a time; the bin stays the same size either
   * way, which is what keeps the panel compact. */
  for (const tab of document.querySelectorAll(".sttab")) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll(".sttab")) t.classList.toggle("on", t === tab);
      $("stPicker").hidden = tab.dataset.tab !== "clips";
      $("stSongs").hidden = tab.dataset.tab !== "songs";
    };
  }

  /* Songs: click appends to the first audio track (creating one if none),
   * drag places at the drop point. Clips get the same click-to-add below, for
   * the same reason: click is the verb everyone tries first. */
  $("stSongs").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-song]");
    if (!el) return;
    const tr = audioTracks()[0] || addTrack("audio", "Music");
    const at = tr.items.reduce((m, it) => Math.max(m, it.start + it.dur), 0);
    await addSongTo(tr, el.dataset.song, at);
  });
  $("stSongs").addEventListener("dragstart", (e) => {
    const el = e.target.closest("[data-song]");
    if (!el) return;
    e.dataTransfer.setData("text/aiplay-song", el.dataset.song);
    e.dataTransfer.effectAllowed = "copy";
  });

  $("stPicker").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-clip]");
    if (!el) return;
    const tr = videoTracks()[videoTracks().length - 1] || addTrack("video", "Video 1");
    const at = tr.items.reduce((m, it) => Math.max(m, it.start + it.dur), 0);
    await addClipTo(tr, el.dataset.clip, at);
  });

  /* ---- track header buttons ---- */
  $("stHeads").addEventListener("input", (e) => {
    const l = e.target.closest("[data-level]");
    if (!l) return;
    const t = S.tracks.find((x) => x.id === +l.dataset.level);
    if (!t) return;
    t.level = Number(l.value) / 100;
    // No undo entry: a level drag fires continuously, and one snapshot per
    // pixel would bury every real edit under a hundred slider positions.
    syncMedia();
    render();
  });

  $("stHeads").addEventListener("click", (e) => {
    const m = e.target.closest("[data-mute]"), s = e.target.closest("[data-solo]"), d = e.target.closest("[data-deltrack]");
    const up = e.target.closest("[data-up]"), dn = e.target.closest("[data-down]");
    if (up) return moveTrack(+up.dataset.up, -1);
    if (dn) return moveTrack(+dn.dataset.down, +1);
    if (m) { const t = S.tracks.find((x) => x.id === +m.dataset.mute); t.muted = !t.muted; }
    else if (s) { const t = S.tracks.find((x) => x.id === +s.dataset.solo); t.solo = !t.solo; }
    else if (d) {
      const t = S.tracks.find((x) => x.id === +d.dataset.deltrack);
      pushUndo();
      for (const it of t.items) it.el?.pause();
      S.tracks = S.tracks.filter((x) => x !== t);
    } else return;
    paintTimeline(); syncMedia(); render();
  });

  /* ---- drop a clip from the picker onto a lane ---- */
  $("stPicker").addEventListener("dragstart", (e) => {
    const p = e.target.closest("[data-clip]");
    if (!p) return;
    e.dataTransfer.setData("text/aiplay-clip", p.dataset.clip);
    e.dataTransfer.effectAllowed = "copy";
  });

  /* ---- move a clip already on the timeline ---- */
  let drag = null, trim = null, fade = null;
  $("stLanes").addEventListener("pointerdown", (e) => {
    const del = e.target.closest("[data-delitem]");
    if (del) {
      /* This ✕ and the Clear button were the ONLY destructive operations that
       * bypassed the undo stack — found by the design review, not by use, which
       * is exactly backwards of how it should have gone. One unrecoverable
       * misclick teaches a first-timer to fear the whole editor. */
      pushUndo();
      const id = +del.dataset.delitem;
      for (const tr of S.tracks) {
        const it = tr.items.find((x) => x.id === id);
        if (it) { it.el?.pause(); tr.items = tr.items.filter((x) => x !== it); }
      }
      paintTimeline(); render();
      toast("Removed");
      return;
    }
    const fh = e.target.closest("[data-fade]");
    if (fh) {
      const id = +fh.dataset.fade;
      const hit = findItem(id);
      if (hit) { pushUndo(); fade = { it: hit.it, edge: fh.dataset.edge }; S.sel = id; }
      fh.setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }
    const grab = e.target.closest("[data-trim]");
    if (grab) {
      /* Trimming, rather than moving. The right edge shortens the tail; the left
       * edge moves the in-point INTO the source and slides the start to match,
       * so the frames under the cursor stay put — which is what makes a trim
       * feel like a trim rather than like a nudge. */
      const id = +grab.dataset.trim;
      for (const tr of S.tracks) {
        const it = tr.items.find((x) => x.id === id);
        if (it) { pushUndo(); trim = { it, edge: grab.dataset.edge }; S.sel = id; }
      }
      grab.setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }
    const el = e.target.closest("[data-item]");
    if (!el) {
      // Clicking empty timeline moves the playhead, which is what every editor
      // does and what people try first.
      seek(timeAt(e.clientX));
      return;
    }
    const id = +el.dataset.item;
    const tr = S.tracks.find((x) => x.id === +el.dataset.track);
    const it = tr.items.find((x) => x.id === id);
    S.sel = id;
    pushUndo();
    drag = { it, from: tr, grabT: timeAt(e.clientX) - it.start };
    el.setPointerCapture(e.pointerId);
    paintTimeline();
  });

  $("stLanes").addEventListener("pointermove", (e) => {
    if (fade) {
      /* Measured from the edge the handle sits on, and capped at the item's own
       * length — a fade longer than its clip is not a thing, and letting one be
       * dragged there produces an event that never reaches full opacity. */
      const t = timeAt(e.clientX);
      const it = fade.it;
      const len = fade.edge === "in" ? t - it.start : it.start + it.dur - t;
      const capped = clamp(len, 0, it.dur * 0.9);
      if (fade.edge === "in") it.fadeIn = capped; else it.fadeOut = capped;
      paintTimeline(); render();
      return;
    }
    if (trim) {
      const t = snap(timeAt(e.clientX), trim.it.id);
      const it = trim.it, srcDur = it.srcDur || it.dur;
      if (trim.edge === "r") {
        // At most what is left of the source after the in-point, and never zero.
        it.dur = clamp(t - it.start, 0.2, srcDur - (it.inPoint || 0));
      } else {
        const end = it.start + it.dur;
        const newStart = clamp(t, Math.max(0, it.start - (it.inPoint || 0)), end - 0.2);
        it.inPoint = (it.inPoint || 0) + (newStart - it.start);
        it.start = newStart;
        it.dur = end - newStart;
      }
      paintTimeline(); render();
      return;
    }
    if (!drag) return;
    const want = timeAt(e.clientX) - drag.grabT;
    drag.it.start = Math.max(0, snap(want, drag.it.id));
    // Moving between lanes: whichever lane the pointer is over wins, as long as
    // it takes this kind of media.
    const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-lane]");
    if (lane) {
      const to = S.tracks.find((x) => x.id === +lane.dataset.lane);
      const isAudio = drag.it.src.includes("/api/audio/");
      if (to && to !== drag.from && to.kind === (isAudio ? "audio" : "video")) {
        drag.from.items = drag.from.items.filter((x) => x !== drag.it);
        to.items.push(drag.it);
        drag.from = to;
      }
    }
    paintTimeline();
    render();
  });

  const endDrag = () => {
    if (drag || trim || fade) { drag = null; trim = null; fade = null; syncMedia(); render(); }
  };
  $("stLanes").addEventListener("pointerup", endDrag);
  $("stLanes").addEventListener("pointercancel", endDrag);

  $("stLanes").addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("text/aiplay-clip")
     || e.dataTransfer.types.includes("text/aiplay-song")) e.preventDefault();
  });
  $("stLanes").addEventListener("drop", async (e) => {
    const clip = e.dataTransfer.getData("text/aiplay-clip");
    const song = e.dataTransfer.getData("text/aiplay-song");
    if (!clip && !song) return;
    e.preventDefault();
    const lane = e.target.closest("[data-lane]");
    let tr = lane ? S.tracks.find((x) => x.id === +lane.dataset.lane) : null;
    const at = snap(timeAt(e.clientX));
    if (clip) {
      /* A clip dropped on an audio lane lands on the nearest VIDEO track rather
       * than vanishing. Forgiving the miss beats teaching lane discipline — the
       * lanes are 54 px tall and people drop where the pointer happens to be. */
      if (!tr || tr.kind !== "video") tr = videoTracks()[videoTracks().length - 1] || addTrack("video", "Video 1");
      await addClipTo(tr, clip, at);
    } else {
      if (!tr || tr.kind !== "audio") tr = audioTracks()[0] || addTrack("audio", "Music");
      await addSongTo(tr, song, at);
    }
  });

  /* Scrubbing on the ruler. */
  let ruling = false;
  $("stRuler").addEventListener("pointerdown", (e) => {
    ruling = true;
    $("stRuler").setPointerCapture(e.pointerId);
    seek(timeAt(e.clientX));
  });
  $("stRuler").addEventListener("pointermove", (e) => { if (ruling) seek(timeAt(e.clientX)); });
  $("stRuler").addEventListener("pointerup", () => { ruling = false; });

  /* Keyboard. These are Vegas's bindings, not invented ones: anyone who has
   * used an editor already has them in their fingers, and a new set to learn is
   * a cost with no benefit. */
  document.addEventListener("keydown", (e) => {
    if ($("studio").hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); return void (e.shiftKey ? redo() : undo()); }
    if (ctrl && e.key.toLowerCase() === "y") { e.preventDefault(); return void redo(); }
    if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); return duplicateSelected(); }

    if (e.code === "Space") { e.preventDefault(); return S.playing ? pause() : play(); }
    if (e.code === "Home") return seek(0);
    if (e.code === "End") return seek(totalLength());
    if (e.key.toLowerCase() === "s" && !ctrl) { e.preventDefault(); return splitAtPlayhead(); }
    if (e.key.toLowerCase() === "f") { e.preventDefault(); return zoomToFit(); }
    // Nudge by a frame at 30 fps, or by a second with shift.
    if (e.code === "ArrowLeft") { e.preventDefault(); return seek(S.t - (e.shiftKey ? 1 : 1 / 30)); }
    if (e.code === "ArrowRight") { e.preventDefault(); return seek(S.t + (e.shiftKey ? 1 : 1 / 30)); }
    if (e.code === "Delete" || e.code === "Backspace") {
      e.preventDefault();
      // Ctrl+Delete closes the gap; plain Delete leaves it. Both are wanted
      // about half the time, which is why Vegas binds both.
      return deleteSelected(ctrl);
    }
  });

  if (!S.raf) S.raf = requestAnimationFrame(tick);
  paintTimeline();
  render();
}

/** Called by app.js when the Studio view opens, with data it already holds. */
export function studioRefresh(clips, library) {
  window.__aiplayClips = clips || [];
  window.__aiplayLibrary = library || [];
  paintPicker();
  paintSongs();
  paintTimeline();
}
