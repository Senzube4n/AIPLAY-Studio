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
  /* How the beat is detected, rather than what it drives.
   * `sens` 0..1 maps to the threshold multiplier; `band` picks the slice of the
   * spectrum that counts. Both used to be constants, and both are the usual
   * reason a track "does not react". */
  beatCfg: { sens: 0.5, band: "bass", drive: "pulse", smooth: 0.35 },
  /* Visualiser scale and opacity. Bars at a fixed 28% of frame height and a
   * fixed .75 alpha suited exactly one kind of video; over a busy clip they are
   * too loud and over a still they are too timid. */
  visSize: 0.4, visOpacity: 0.7,
  /* Which clip the Look panel is editing. null = the whole video. */
  fxTarget: null,
  // Beat detector state: a rolling mean of low-band energy and the last hit.
  beat: { hist: [], lastAt: -1, energy: 0, level: 0 },
  /* The song's OWN analysis — a real beat grid and per-band loudness over time,
   * measured once on the server rather than heard live in the browser.
   *
   * Why both exist. The live analyser can only describe what is audible at this
   * instant, which means it needs the tab visible and the timeline playing, and
   * it produces a slightly different answer every pass. This is measured from
   * the file, so a cut lands on the same frame every time, an export made in a
   * background tab is identical to the one you previewed, and effects can react
   * to a band the mix barely exposes.
   *
   * `mult` is the half/double control: tempo detection has to CHOOSE between a
   * beat and its octave, and on half-time material — which is most of what this
   * app generates — the honest answer is whichever one you would tap. */
  beats: null,
  beatMult: 1,
  beatSync: true,
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
  /* The measured grid wins when there is one.
   *
   * Not merely "better": it is the only version that works while the tab is in
   * the background, where Chrome suspends the frame loop and the analyser goes
   * flat — which is exactly when an unattended export runs. */
  if (S.beatSync) {
    /* Three ways to be driven by the music, and they are genuinely different
     * instruments rather than settings of one.
     *
     *   pulse    — decays from each beat. Punchy, rhythmic, obviously "on it".
     *   envelope — follows loudness continuously. Breathing, hypnotic, and the
     *              only one that can produce a slow morph.
     *   both     — whichever is higher, so a kick still lands inside a swell.
     *
     * The reference clips people describe as "audio reactive" are usually the
     * middle one, which is why it exists: measured against its own soundtrack,
     * that video's palette shifts are no closer to the beat than random times. */
    const mode = S.beatCfg.drive || "pulse";
    const pulse = mode === "envelope" ? null : offlineBeat(S.t);
    const env = mode === "pulse" ? null : offlineEnvelope(S.t);
    let v = null;
    if (pulse !== null && env !== null) v = Math.max(pulse, env);
    else if (pulse !== null) v = pulse;
    else if (env !== null) v = env;
    if (v !== null) { S.beat.level = v; return v; }
  }
  const b = S.beat;
  // Ease the previous hit down first, so a missed frame never leaves it stuck on.
  b.level = Math.max(0, b.level - 0.06);
  if (!S.analyser) return b.level;

  S.analyser.getByteFrequencyData(S.freq);
  /* Which part of the spectrum counts as "the beat".
   *
   * The bottom 8% (kick and low bass) is what people usually mean, and it is
   * still the default — but a track whose pulse lives in the snare or the hats
   * produces almost no movement down there, and the honest fix is to let the
   * band be chosen rather than to make the detector cleverer. */
  const len = S.freq.length;
  const BANDS = {
    bass: [0, 0.08],
    low: [0.02, 0.18],
    mid: [0.18, 0.45],
    high: [0.45, 0.9],
    full: [0, 1],
  };
  const [b0, b1] = BANDS[S.beatCfg.band] || BANDS.bass;
  const from = Math.floor(len * b0);
  const to = Math.max(from + 4, Math.floor(len * b1));
  let sum = 0;
  for (let i = from; i < to; i++) sum += S.freq[i];
  const energy = sum / (to - from) / 255;
  b.energy = energy;

  b.hist.push(energy);
  if (b.hist.length > 43) b.hist.shift();          // ~0.7 s at 60 fps
  const mean = b.hist.reduce((x, y) => x + y, 0) / b.hist.length;

  /* 1.35x the local mean, with a 120 ms refractory gap. The gap is what stops
   * the attack and the body of one kick registering as two hits, which is the
   * failure that makes naive detectors look jittery. */
  /* Sensitivity, inverted: dragging the slider UP lowers the bar the energy has
   * to clear. 1.6x (picky, only obvious hits) down to 1.12x (twitchy, catches a
   * soft kick). The floor moves with it too, or a quiet passage still reports
   * nothing at maximum sensitivity. */
  const sens = Math.min(Math.max(S.beatCfg.sens, 0), 1);
  const thresh = 1.6 - sens * 0.48;
  const floor = 0.18 - sens * 0.12;
  if (energy > mean * thresh && energy > floor && now - b.lastAt > 120) {
    b.lastAt = now;
    b.level = 1;
  }
  return b.level;
}

/**
 * The effect board that applies to ONE clip.
 *
 * The global board is the default; a clip may override any subset of it. Stored
 * as a partial rather than a full copy on purpose — a clip that only overrides
 * `look` still follows the global beat effect when you change it, which is what
 * "give this clip a different look" should mean.
 */
function effectiveFx(it) {
  return it && it.fx ? { ...S.fx, ...it.fx } : S.fx;
}

/**
 * Transform for one clip: the slow push, plus whatever the beat is driving.
 *
 * Deterministic throughout — `Math.sin(t * k)` rather than `Math.random()` —
 * because the export is a second real-time pass, and a random shake would make
 * the file differ from the preview you approved.
 */
function applyBeatTransform(ctx, fx, hit, t, total, W, H) {
  const amt = fx.amount;
  let scale = 1 + (fx.drift * 0.12) * (t / Math.max(total, 0.001));
  let dx = 0, dy = 0, rot = 0;
  if (fx.beat === "punch") scale *= 1 + hit * 0.09 * amt;
  if (fx.beat === "pull") scale *= 1 - hit * 0.06 * amt;
  if (fx.beat === "shake") {
    dx = Math.sin(t * 47) * hit * 22 * amt;
    dy = Math.cos(t * 61) * hit * 22 * amt;
  }
  if (fx.beat === "tilt") rot = Math.sin(t * 23) * hit * 0.03 * amt;
  if (scale !== 1 || dx || dy || rot) {
    ctx.translate(W / 2 + dx, H / 2 + dy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, -H / 2);
  }
}

/** Beat effects that are a FILTER rather than a transform, appended to the look. */
function beatFilter(fx, hit) {
  if (hit <= 0.01) return "";
  const amt = fx.amount;
  if (fx.beat === "blur") return ` blur(${(hit * 6 * amt).toFixed(2)}px)`;
  if (fx.beat === "hue") return ` hue-rotate(${Math.round(hit * 90 * amt)}deg)`;
  if (fx.beat === "sat") return ` saturate(${(1 + hit * 1.6 * amt).toFixed(2)})`;
  if (fx.beat === "strobe") return ` brightness(${(1 + hit * 0.9 * amt).toFixed(2)}) contrast(${(1 + hit * 0.5 * amt).toFixed(2)})`;
  return "";
}

/**
 * Fetch the beat grid and band envelopes for a track.
 *
 * Cached server-side, so this is a few milliseconds after the first time. A
 * failure is not an error worth interrupting anyone over — everything below
 * falls back to the live analyser, which is what happened before this existed.
 */
async function loadBeats(file) {
  try {
    const d = await (await fetch(`/api/beats/${encodeURIComponent(file)}`)).json();
    if (d.error || !Array.isArray(d.beats) || !d.beats.length) return;
    S.beats = d;
  } catch { /* the live analyser still works */ }
}

/**
 * Make sure the timeline's song has been analysed.
 *
 * `addSongTo` asks when a song is DROPPED, but a project opened from disk and
 * the crash-recovery autosave both rebuild tracks directly and never go through
 * it — so without this the ruler came back bare and every cut-to-the-beat was
 * refused on a timeline that plainly had music in it.
 */
async function ensureBeats() {
  if (S.beats) return;
  for (const tr of S.tracks) {
    if (tr.kind !== "audio") continue;
    for (const it of tr.items) {
      const m = /\/api\/audio\/([^?#]+)/.exec(it.src || "");
      if (!m) continue;
      await loadBeats(decodeURIComponent(m[1]));
      if (S.beats) { paintTimeline(); paintBeatInfo(); return; }
    }
  }
}

/**
 * The beat times as the user wants to count them.
 *
 * `mult` 0.5 keeps every other beat (half-time), 2 inserts one between each
 * pair (double-time). Needed because tempo estimation picks between a tempo and
 * its octave using a prior, and on half-time material it reliably picks the
 * fast one: this app's own "cloud rap, 72 BPM" render measures 154, which is
 * 77 doubled. Both are defensible readings of the same signal; only a listener
 * can say which one is the beat.
 */
function beatGrid() {
  const b = S.beats?.beats;
  if (!b?.length) return [];
  if (S.beatMult === 0.5) return b.filter((_, i) => i % 2 === 0);
  if (S.beatMult === 2) {
    const out = [];
    for (let i = 0; i < b.length; i++) {
      out.push(b[i]);
      if (i + 1 < b.length) out.push((b[i] + b[i + 1]) / 2);
    }
    return out;
  }
  return b;
}

/** Bar lines — every fourth beat of the grid actually in use. */
function barGrid() {
  return beatGrid().filter((_, i) => i % 4 === 0);
}

/** Index of the last grid entry at or before `t`, or -1. Binary, because this
 *  runs once a frame against a few hundred entries. */
function lastAtOrBefore(arr, t) {
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * Smooth an envelope, with NO phase lag.
 *
 * A one-pole filter run forwards delays everything by roughly its own time
 * constant — which on a visual means the picture reacts measurably after the
 * sound, and at 200 ms of smoothing that is plainly visible. Running the same
 * filter forwards and then backwards cancels the delay exactly, because the two
 * passes have equal and opposite phase. It costs one extra pass over an array
 * of a few thousand floats, once, when the setting changes.
 *
 * @param {number[]} a  the envelope
 * @param {number} tau  time constant in seconds; 0 returns the input untouched
 * @param {number} fps  samples per second
 */
function smoothEnvelope(a, tau, fps) {
  if (!a?.length || tau <= 0) return a;
  const k = Math.exp(-1 / (tau * fps));
  const out = new Float32Array(a.length);
  let v = a[0];
  for (let i = 0; i < a.length; i++) { v = v * k + a[i] * (1 - k); out[i] = v; }
  v = out[out.length - 1];
  for (let i = out.length - 1; i >= 0; i--) { v = v * k + out[i] * (1 - k); out[i] = v; }
  return out;
}

/**
 * Build the smoothed bands the envelope drive reads.
 *
 * Cached on the analysis object and rebuilt only when the smoothing changes,
 * because doing it per frame would mean filtering five thousand samples sixty
 * times a second to read ONE of them.
 */
function ensureSmoothed() {
  const B = S.beats;
  if (!B?.bands) return null;
  const tau = 0.04 + S.beatCfg.smooth * 0.9;
  if (B._smoothTau === tau) return B._smooth;
  const fps = B.envFps || 30;
  const out = {};
  for (const k of Object.keys(B.bands)) out[k] = smoothEnvelope(B.bands[k], tau, fps);
  B._smoothTau = tau;
  B._smooth = out;
  return out;
}

/**
 * The CONTINUOUS drive: how loud the chosen band is right now, 0..1.
 *
 * This is the half of audio-reactive that a beat grid cannot express. A pulse
 * says "something happened"; an envelope says "how much is happening", and a
 * look that breathes with the music rather than flinching on every kick needs
 * the second one.
 *
 * Normalised against the band's own 90th percentile so the full range of the
 * control is actually used — the envelopes arrive normalised to their 97th
 * percentile, which leaves a typical passage sitting around 0.5 and never
 * reaching the top of any effect.
 */
function offlineEnvelope(t) {
  const B = S.beats;
  const sm = ensureSmoothed();
  if (!sm) return null;
  const fps = B.envFps || 30;
  const at = (arr) => (arr?.length
    ? arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * fps)))]
    : 0);
  const raw = S.beatCfg.band === "full"
    ? (at(sm.bass) + at(sm.low) + at(sm.mid) + at(sm.high)) / 4
    : at(sm[S.beatCfg.band]);

  if (B._ref === undefined || B._refTau !== B._smoothTau || B._refBand !== S.beatCfg.band) {
    const src = S.beatCfg.band === "full" ? sm.mid : sm[S.beatCfg.band];
    const sorted = src ? Array.from(src).sort((a, b) => a - b) : [1];
    B._ref = Math.max(0.05, sorted[Math.floor(sorted.length * 0.9)] || 1);
    B._refTau = B._smoothTau;
    B._refBand = S.beatCfg.band;
  }
  // Sensitivity here is a GAIN, not a threshold — there is no event to accept
  // or reject, only a level to scale.
  const gain = 0.6 + S.beatCfg.sens * 1.2;
  return Math.min(1, (raw / B._ref) * gain);
}

/**
 * Beat strength at a TIMELINE time, from the measured analysis.
 *
 * Deterministic by construction: it depends only on `t`, so scrubbing to the
 * same frame twice gives the same picture, and an export renders what the
 * preview showed even if the tab was never in front.
 *
 * The pulse decays from each beat; its HEIGHT is the chosen band's loudness at
 * that moment, so a beat the mix leaves quiet moves the picture less than one
 * it leans on. Sensitivity sets how quiet a beat can be and still count.
 *
 * @returns {number|null} null when there is nothing measured to read
 */
function offlineBeat(t) {
  const B = S.beats;
  if (!B?.beats?.length) return null;
  const fps = B.envFps || 30;
  const at = (arr) => (arr?.length
    ? arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * fps)))]
    : 0);
  const bands = B.bands || {};
  const band = S.beatCfg.band === "full"
    ? (at(bands.bass) + at(bands.low) + at(bands.mid) + at(bands.high)) / 4
    : at(bands[S.beatCfg.band]);

  const grid = beatGrid();
  const i = lastAtOrBefore(grid, t);
  if (i < 0) return 0;

  // How quiet a beat may be and still register. Inverted like the live
  // detector's slider: dragging sensitivity up lowers the bar.
  const floor = 0.62 - S.beatCfg.sens * 0.55;
  const strength = at(bands[S.beatCfg.band === "full" ? "bass" : S.beatCfg.band]);
  if (strength < floor) return 0;

  // 180 ms of decay: long enough to see, short enough that two beats at 154 BPM
  // (390 ms apart) still read as two.
  const age = t - grid[i];
  const pulse = Math.max(0, 1 - age / 0.18);
  return Math.min(1, pulse * (0.45 + 0.75 * band));
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
    // Added because five looks is not a grade, it is a demo. All of these are
    // ctx.filter primitives, so they are GPU work and cost nothing per frame.
    case "noir":  return "grayscale(1) contrast(1.45) brightness(0.92)";
    case "dream": return "saturate(1.25) contrast(0.88) brightness(1.08) blur(0.4px)";
    case "vhs":   return "saturate(1.3) contrast(1.12) hue-rotate(6deg) brightness(1.04)";
    case "infra": return "invert(1) hue-rotate(150deg) saturate(1.6)";
    case "bleach": return "saturate(0.35) contrast(1.5) brightness(1.05)";
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
  // Every editing operation calls this, which makes it the one honest place to
  // notice that the project no longer matches what was saved.
  window.dispatchEvent(new CustomEvent("aiplay-studio-edited"));
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
        /* ⚠ Keep this list in step with `projDoc()`.
         *
         * It had drifted: a named project already carried the beat settings and
         * the visualiser size, and the crash-recovery copy did not — so
         * recovering from a lost tab quietly reset half the look to defaults,
         * which is the moment you are least able to tell what you had. */
        beatCfg: S.beatCfg, beatMult: S.beatMult, beatSync: S.beatSync,
        visSize: S.visSize, visOpacity: S.visOpacity,
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
  if (d.beatMult) S.beatMult = d.beatMult;
  if (typeof d.beatSync === "boolean") S.beatSync = d.beatSync;
  if (d.beatCfg) S.beatCfg = { ...S.beatCfg, ...d.beatCfg };
  if (Number.isFinite(d.visSize)) S.visSize = d.visSize;
  if (Number.isFinite(d.visOpacity)) S.visOpacity = d.visOpacity;
  await restore(d.tracks);
  S.t = d.t || 0;
  S.nextId = Math.max(S.nextId, ...S.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), 0) + 1;
  // Not awaited: recovery must not wait on a network round trip, and the ruler
  // repaints itself when the analysis lands.
  ensureBeats();
  return true;
}

async function restore(snap) {
  for (const tr of S.tracks) for (const it of tr.items) it.el?.pause?.();
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
  it.el?.pause?.();
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
      // 0.28 was the old fixed height; the slider spans roughly a third of that
      // to just over half the frame, which covers "barely there" to "this is
      // the visual".
      const bh = v * h * (0.1 + S.visSize * 0.45);
      g.fillStyle = `hsla(${190 + v * 90}, 90%, ${45 + v * 25}%, ${S.visOpacity})`;
      g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
    }
    g.restore();
  } else if (S.vis === "wave") {
    S.analyser.getByteTimeDomainData(S.wave);
    g.save();
    g.strokeStyle = `rgba(120,220,255,${S.visOpacity})`;
    g.lineWidth = 2 + S.visSize * 4;
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
      const r1 = r0 + v * Math.min(w, h) * (0.08 + S.visSize * 0.35);
      g.strokeStyle = `hsla(${200 + v * 100}, 95%, ${50 + v * 20}%, ${S.visOpacity})`;
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

/**
 * Size the monitor column TO the picture.
 *
 * The canvas is height-capped (the well gets whatever vertical space the fixed
 * rows leave), so on any wide window it cannot fill the column and sits centred
 * in a large gutter — measured at 651 px, with every control row underneath
 * aligned to the COLUMN rather than to the picture above it. Two alignment
 * systems on one axis is the whole of "it looks messy".
 *
 * Setting the column to the canvas's own width collapses both problems at once:
 * the gutter goes to the asset bin (Vegas gives its docks that space), and the
 * transport, presets and fine-tune all inherit the picture's width, so they
 * line up with it by construction rather than by coincidence.
 *
 * No circularity: the well's HEIGHT comes from the vertical flex and does not
 * depend on column width, so this resolves in one pass.
 */
function fitMonitor() {
  const well = $("stmonitorWell") || document.querySelector(".stmonitor");
  const main = document.querySelector(".stmain");
  const wrap = document.querySelector(".stwrap");
  if (!well || !main || !wrap) return;
  const h = well.clientHeight;
  if (h < 40) return;
  const aspect = (S.out.w || 16) / (S.out.h || 9);
  // Leave the bin its minimum; below that the canvas becomes width-constrained
  // instead and the gutter simply cannot be removed.
  /* What is left after the docks take theirs. The old flat `- 300` assumed one
   * dock of a fixed width; there are two now and either can be collapsed, so
   * the figure has to be measured rather than assumed or the picture is sized
   * against space that is not there. */
  const dockBin = document.querySelector(".stside");
  const dockProps = document.querySelector(".stprops");
  const taken = [dockBin, dockProps].reduce((a, el) => {
    if (!el || el.hidden || getComputedStyle(el).display === "none") return a;
    // Their minimum, not their current width — they are `1fr` and will give
    // back whatever the picture takes.
    return a + 240;
  }, 0);
  const avail = wrap.clientWidth - taken - 40;
  const w = Math.max(320, Math.min(h * aspect, avail));
  main.style.width = `${Math.round(w)}px`;

  /* Bind the TIMELINE to the same total width as the block above it.
   *
   * This used to compute the width of a CENTRED PAIR, because the monitor and
   * the bin sat in the middle with gutter either side and a full-bleed timeline
   * underneath made the top half look like it was floating. The three docks now
   * fill the row, so the honest answer is simply the row's own width — and the
   * old arithmetic would under-report it and reintroduce the gutter it was
   * written to remove. */
  document.querySelector("#studio")?.style.setProperty("--st-width", `${Math.round(wrap.clientWidth)}px`);
}

/* Last selection the panel was told about. `S.sel` is written from several
 * places — clicking a clip, splitting, duplicating, deleting — and wrapping
 * every one of them in a setter would be five edits that a sixth call site
 * could still bypass. Watching for the change instead cannot be bypassed.
 *
 * ⚠ Called from paintTimeline AS WELL AS render, and that is the whole point:
 * render() only runs on demand while the timeline is paused, so hanging this
 * off the frame loop alone meant selecting a clip did not reach the Look panel
 * until something happened to trigger a repaint. Measured: the "Selected clip"
 * button stayed disabled with a clip visibly selected. */
let lastSel = null;

function noteSelection() {
  if (S.sel === lastSel) return;
  lastSel = S.sel;
  window.dispatchEvent(new CustomEvent("aiplay-studio-select"));
}

function render() {
  const cv = $("stCanvas");
  if (!cv) return;
  fitMonitor();

  noteSelection();
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

  /* ── Per-clip effects ─────────────────────────────────────────────────────
   *
   * The save/filter/transform used to sit OUT HERE, wrapping the whole layer
   * loop, which is why an effect could only ever belong to the entire frame.
   * Each clip now draws inside its own save/restore with its own resolved
   * board, so "this look, on this clip only" is expressible.
   *
   * Bottom layer first. `videoTracks()` is in display order (top row first), so
   * reverse it to paint the bottom-most layer first and the top-most last. */
  const vts = videoTracks().slice().reverse();
  let drewAnything = false;

  /* Flash and vignette cover the whole frame, so they cannot be drawn per clip
   * without stacking. They are accumulated instead, each weighted by how
   * visible its clip currently is: one clip on screen gives exactly the old
   * result, and a crossfade blends the two clips' looks the way it blends the
   * pictures. */
  let flash = 0, vig = 0;

  for (const tr of vts) {
    if (!audible(tr)) continue;
    for (const it of [...tr.items].sort((a, b) => a.start - b.start)) {
      if (t < it.start || t > it.start + it.dur) continue;
      // An <img> has no readyState; `complete` is its equivalent.
      if (!it.el || (it.still ? !it.el.complete : it.el.readyState < 2)) continue;

      const fx = effectiveFx(it);
      // Track level is opacity for a video layer — the "less of that" control
      // that sits between full and muted.
      const a = itemAlpha(tr, it, t) * (tr.level ?? 1);

      ctx.save();
      /* ⚠ "none" does not compose. `filter: none blur(2px)` is invalid CSS and
       * the whole declaration is dropped — so a blur pulse on a clip with no
       * colour grade would have silently disabled both. Build the list, then
       * fall back to "none" only when it is empty. */
      const look = lookFilter(fx.look);
      const filter = (look === "none" ? "" : look) + beatFilter(fx, hit);
      ctx.filter = filter.trim() || "none";
      applyBeatTransform(ctx, fx, hit, t, total, W, H);
      ctx.globalAlpha = a;
      drawCover(ctx, it.el, W, H);

      /* RGB split: additive colour offset over this clip. Cheap, and it is the
       * effect people mean when they say "make it glitch". Scaled by the clip's
       * own alpha so it fades in and out with the picture it belongs to. */
      if (fx.beat === "rgb" && hit > 0.01) {
        const off = hit * 14 * fx.amount;
        ctx.globalCompositeOperation = "lighter";
        for (const [ch, sx] of [["#f00", -off], ["#0ff", off]]) {
          ctx.save();
          ctx.globalAlpha = 0.35 * hit * a;
          ctx.fillStyle = ch;
          ctx.translate(sx, 0);
          ctx.fillRect(0, 0, W, H);
          ctx.restore();
        }
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
      ctx.filter = "none";
      ctx.globalAlpha = 1;

      if (fx.beat === "flash" && hit > 0.01) flash = Math.max(flash, hit * 0.35 * fx.amount * a);
      if (fx.vignette > 0) vig = Math.max(vig, fx.vignette * a);
      drewAnything = true;
    }
  }

  // With nothing on screen the vignette still belongs to the frame, so it falls
  // back to the global board rather than disappearing on an empty timeline.
  if (!drewAnything) vig = S.fx.vignette;

  if (!drewAnything && !total) {
    ctx.fillStyle = "#16181c";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#5b6068";
    ctx.font = "400 28px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    // The bin moved to the LEFT in the three-dock layout; copy that names a
    // direction has to be corrected when the direction changes.
    ctx.fillText("Drag a clip from the bin onto a track below", W / 2, H / 2);
  }

  // Flash sits outside every clip transform so it covers the whole frame rather
  // than the scaled picture, which would leave unlit edges on a punch.
  if (flash > 0) {
    ctx.save();
    ctx.globalAlpha = flash;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  if (vig > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${vig * 0.85})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* The beat indicator. "It does not react to my song" is nearly always the
   * threshold or the band, and a dot you can watch while dragging the
   * sensitivity slider answers that without anyone having to ask. */
  const led = $("stBeatLed");
  if (led) led.classList.toggle("hit", hit > 0.45);

  drawVisualiser(ctx, W, H);
  drawKaraoke(ctx, W, H, t);
  drawTitle(ctx, W, H, t);

  $("stTime").textContent = `${fmt(t)} / ${fmt(total)}`;
  const st = $("stStatus");
  if (st) {
    const n = S.tracks.reduce((a, tr) => a + tr.items.length, 0);
    st.textContent = `${S.out.w}×${S.out.h} · ${S.out.fps}p · ${n} item${n === 1 ? "" : "s"}`;
  }
  const tot = $("stTotal");
  if (tot) tot.textContent = "";
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
      /* ⚠ A still has no clock to sync.
       *
       * Everything below calls play/pause/currentTime, and an <img> has none of
       * them — the first imported image threw `el.pause is not a function` out
       * of the rAF loop on every frame, which stopped the whole timeline and
       * left the monitor black. Introducing a third element type means auditing
       * every place that assumed two. */
      if (it.still) continue;
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
  /* ⚠ Reschedule in a `finally`.
   *
   * This used to be a bare `render(); S.raf = requestAnimationFrame(tick);` —
   * so ONE exception in any frame permanently stopped the editor: no playback,
   * no preview, no scrubbing, and no error visible unless the console happened
   * to be open. Measured exactly that when an imported still reached syncMedia
   * and threw `el.pause is not a function`.
   *
   * A dropped frame is worth far less than a dead editor, so the loop survives
   * and says what went wrong, once, rather than dying silently. */
  try {
    render();
  } catch (err) {
    if (!S.renderFailed) {
      S.renderFailed = true;
      console.error("[studio] render threw — the timeline keeps running:", err);
      toast("Something went wrong drawing the preview — see the console.");
    }
  } finally {
    S.raf = requestAnimationFrame(tick);
  }
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
    /* Finishing does two jobs, and the second one is the reason the caveat below
     * changes when it is on. A MediaRecorder WebM carries no duration in its
     * header; the enhance pass re-muxes through ComfyUI's PyAV on its way to
     * MP4, so a finished export has a real duration and the scrub-bar caveat
     * simply does not apply to it. Measured on a synthetic live WebM:
     * duration=N/A in, duration=2.979167 out. */
    const finish = $("stFinish")?.value || "";
    if (finish) {
      const M = {
        smooth: { interpolate: true, upscale: false, multiplier: 2, slow: false, scale: 1 },
        bigger: { interpolate: false, upscale: true, multiplier: 1, slow: false, scale: 2 },
        both:   { interpolate: true, upscale: true, multiplier: 2, slow: false, scale: 2 },
      }[finish];
      $("stExportNote").innerHTML = `Saved as <b>${esc(d.name)}</b> — now enhancing it…`;
      const q = await (await fetch("/api/clips", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enhance", name: d.name, ...M }),
      })).json();
      $("stExportNote").innerHTML = q.error
        // The recording is SAFE either way — say so, or a refusal here reads as
        // having lost the whole export.
        ? `Saved as <b>${esc(d.name)}</b>, but it could not be enhanced: ${esc(q.error)}`
        : `Saved as <b>${esc(d.name)}</b> — enhancing it now. `
          + `<span class="sp meta">The finished MP4 appears in your clip library when it is done; the recording is already safe.</span>`;
      return;
    }
    /* The duration caveat, stated once where it matters — and only when it is
     * true, which is when the export was NOT finished. */
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
/** Is this source a still? Decided from the URL, which is all we have before it loads. */
function isStill(src) {
  return /\.(png|jpg|jpeg|webp|gif)(\?|#|$)/i.test(src || "");
}

async function attach(it, kind, { keepTiming = false, knownDur = 0 } = {}) {
  /* Stills are a third kind of element.
   *
   * A video and an audio both report a duration the timeline can size a clip
   * from; an image reports none, never reaches readyState 2, and would sit
   * invisible forever in a loop that waits for one. `drawCover` already accepts
   * any of the three, because drawImage does. */
  if (isStill(it.src)) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    it.el = img;
    it.still = true;
    await new Promise((res) => {
      img.onload = res;
      img.onerror = res;
      setTimeout(res, 6000);
      img.src = it.src;
    });
    // An image has no length of its own, so it gets one. Five seconds is long
    // enough to read and short enough to trim rather than to fight.
    it.srcDur = it.srcDur || 3600;          // effectively unlimited source
    if (!keepTiming) it.dur = it.dur || 5;
    it.inPoint = it.inPoint || 0;
    return;
  }

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
  /* What the length was before we waited.
   *
   * `keepTiming` covers the case the CALLER knows about — a split, an undo, a
   * project reload. It cannot cover the case nobody knows about at call time:
   * loading metadata takes seconds over HTTP, and anything that changes this
   * clip's length in the meantime is silently reverted when the file finally
   * reports its duration. Measured: drop a clip, run "Cut to beat" before the
   * video had loaded, and the clip snapped back to its full five seconds while
   * its START stayed on the bar — a result that looks like the feature is
   * broken rather than like a race. */
  const durBefore = it.dur;
  await new Promise((res) => {
    el.onloadedmetadata = res;
    el.onerror = res;
    setTimeout(res, 6000);
  });
  const editedWhileLoading = it.dur !== durBefore;
  // srcDur is the file's real length; dur is how much of it this item uses.
  // Trimming changes dur (and inPoint), never srcDur, so a trim is undoable by
  // dragging the edge back out rather than by re-adding the clip.
  /* Five seconds is a reasonable guess for a CLIP and a terrible one for a
   * three-minute song — and the library already knows the answer, because the
   * server measured it when the file was tagged. So a caller that knows passes
   * it, and the guess is only reached when nothing else is available.
   *
   * Not hypothetical: a media element that never reports metadata leaves
   * `duration` as NaN with no error at all, which is what a browser does to a
   * tab it has decided to suspend. Silently truncating the music to five
   * seconds is the worst possible response to that. */
  const real = Number.isFinite(el.duration) && el.duration > 0
    ? el.duration
    : (knownDur > 0 ? knownDur : 5);
  it.srcDur = it.srcDur || real;
  // The source length is always worth learning — it is what bounds a trim — but
  // the item's own timing is only ours to set if nobody else has touched it.
  if (!keepTiming && !editedWhileLoading) {
    it.dur = real;
    it.inPoint = 0;
  } else if (editedWhileLoading) {
    // An edit made against a guessed length can exceed the real one.
    it.dur = Math.min(it.dur, Math.max(0.1, real - (it.inPoint || 0)));
  }
  if (kind === "audio") routeAudio(el);
  paintTimeline();
  render();
}

/** Drop a clip onto a video track at a given time. */
async function addClipTo(track, name, at) {
  /* ⚠ Adding media IS an edit.
   *
   * Neither of the two ways of doing it — dragging from the bin, or clicking a
   * thumbnail — recorded one, and `autosave()` is reached only through
   * `pushUndo()`. So assembling a whole timeline by dragging, which is how this
   * editor is meant to be used, was neither undoable nor recoverable: Ctrl+Z
   * skipped past the drop to whatever happened before it, and a closed tab took
   * the lot. Measured: a song dropped on the timeline, waited out the 800 ms
   * debounce, reloaded — the audio track came back empty.
   *
   * Recorded HERE rather than at the call sites, because there are four of them
   * and a fifth would silently opt out. */
  pushUndo();
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
  // After the guard: a drop that names a song no longer in the library changes
  // nothing, and an undo entry for nothing is worse than none.
  pushUndo();
  const it = {
    id: S.nextId++, name: t.title || file,
    src: `/api/audio/${encodeURIComponent(file)}`,
    start: Math.max(0, at), dur: t.durationSeconds || 30, el: null,
  };
  track.items.push(it);
  paintTimeline();

  /* ⚠ Started BEFORE the media attach, and deliberately not awaited.
   *
   * The analysis needs the file, not the decoded audio element — so queueing it
   * behind `attach` bought nothing and cost everything: attach waits for a
   * three-minute FLAC to report its duration, and until that resolved the ruler
   * had no beat lines and "Cut to beat" refused, on a timeline with the song
   * visibly on it. Measured exactly that: the request went out, the grid
   * arrived, and the ruler stayed bare for as long as decoding took.
   *
   * The `.then` repaints whenever it lands, so the ruler fills in on its own.
   *
   * The first song on the timeline owns the title card, the karaoke AND the
   * beat grid — the grid is a property of the music, so a second song dropped
   * underneath must not silently retime everything cut to the first. */
  if (!S.beats) {
    loadBeats(file).then(() => {
      if (S.beats) { paintTimeline(); paintBeatInfo(); }
    });
  }
  await attach(it, "audio", { knownDur: t.durationSeconds || 0 });

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
  /* The measured beat grid, under the second-ticks.
   *
   * Only when it is legible: at a low zoom a beat every 390 ms is a solid band
   * of lines that hides the ruler instead of explaining it, so the beats drop
   * out below 6 px apart and the bars carry on alone. */
  const grid = beatGrid();
  if (grid.length) {
    const bars = barGrid();
    const spacing = grid.length > 1 ? (grid[1] - grid[0]) * S.pps : 99;
    if (spacing >= 6) {
      for (const t of grid) h += `<span class="stbeat" style="left:${t * S.pps}px"></span>`;
    }
    for (const t of bars) h += `<span class="stbar" style="left:${t * S.pps}px" title="bar"></span>`;
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
        return `<div class="stclip${S.sel === it.id ? " sel" : ""}${tr.kind === "audio" ? " aud" : ""}${it.fx ? " hasfx" : ""}"
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
  // paintTimeline always runs when the selection changes; render() does not
  // while the timeline is paused, so the Look panel is told from here too.
  noteSelection();
}

/* A square placeholder with real dimensions, inline so it costs no request. */
const NO_ART = "data:image/svg+xml,"
  + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">'
    + '<rect width="256" height="256" fill="#1a1d24"/>'
    + '<text x="128" y="150" font-size="72" fill="#4a5160" text-anchor="middle">♪</text></svg>');

/** What is typed in the bin's search box, lowercased. "" means show everything. */
function binQuery() {
  return ($("stSearch")?.value || "").trim().toLowerCase();
}

function paintSongs() {
  const q = binQuery();
  const lib = (window.__aiplayLibrary || [])
    .filter((t) => !t.file.startsWith("clip:"))
    // Title AND filename: a song you never named is findable by the only string
    // it has, and one you did name is findable by the name you gave it.
    .filter((t) => !q || `${t.title || ""} ${t.file}`.toLowerCase().includes(q));
  $("stSongs").innerHTML = lib.length
    ? lib.map((t) => `<div class="stsong" draggable="true" data-song="${esc(t.file)}"
          title="${esc(t.title || t.file)}${t.lrc ? " · has timed lyrics" : ""}">
        <!-- width/height are REQUIRED, not decorative: the bin is a grid whose
             row height is measured from this element's intrinsic size, and a
             lazy image without them measures 0 and collapses the row. The
             placeholder is an <img> for the same reason. -->
        <img src="${t.thumb || t.cover
          ? `/api/cover/${encodeURIComponent(t.thumb || t.cover)}`
          : NO_ART}" alt="" width="256" height="256" loading="lazy">
        <span class="stsongbody">
          <b>${esc(t.title || t.file)}</b>
          <span>${t.durationSeconds ? fmt(t.durationSeconds) : ""}${t.lrc ? " · lyrics" : ""}</span>
        </span>
        ${t.lrc ? '<span class="stsongtag" title="Has timed lyrics">LRC</span>' : ""}
      </div>`).join("")
    : `<p class="clipempty">${q ? "Nothing matches that." : "No songs yet — make one on the Create page."}</p>`;
}

function paintPicker() {
  const q = binQuery();
  const clips = (window.__aiplayClips || [])
    .filter((c) => !q || `${c.title || ""} ${c.name}`.toLowerCase().includes(q));
  $("stPicker").innerHTML = clips.length
    ? clips.map((c) => {
        /* A still cannot be previewed with a <video>, and an audio file has no
         * picture at all — the bin holds three kinds of thing now, so it has to
         * render three. */
        const kind = /\.(png|jpg|jpeg|webp|gif)$/i.test(c.name) ? "image"
          : /\.(mp3|wav|flac|ogg|opus|m4a)$/i.test(c.name) ? "audio" : "video";
        const url = `/api/clip/${encodeURIComponent(c.name)}`;
        const media = kind === "image"
          ? `<img src="${url}" alt="" width="256" height="144" loading="lazy">`
          : kind === "audio"
            ? '<span class="stpickaud">♪</span>'
            : `<video src="${url}#t=0.1" muted preload="metadata"></video>`;
        return `<div class="stpick${kind !== "video" ? ` is${kind}` : ""}" draggable="true" data-clip="${esc(c.name)}">
        ${media}
        <span>${esc(c.title || c.name.replace(/\.[a-z0-9]+$/i, ""))}</span></div>`;
      }).join("")
    : `<p class="clipempty">${q ? "Nothing matches that." : "Render some clips on the Video page first."}</p>`;
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
  /* Bars first, then beats. Both are candidates rather than a separate mode:
   * on a music video the bar line IS where you want an edit, and having to
   * remember to switch a mode on before dragging is how a feature goes unused. */
  const cands = [0, S.t, ...sectionTimes(), ...barGrid(), ...beatGrid()];
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

/**
 * Re-time every clip on a track so each one starts on a bar line.
 *
 * This is the edit that turns a pile of clips into a music video, and doing it
 * by hand means dragging each one onto a line you have to read off the ruler.
 *
 * Deliberately NOT a split: it moves and trims what is already there, in the
 * order it is already in, so the result is the sequence you assembled rather
 * than something re-invented. A clip whose source is shorter than the span it
 * has been given keeps its own length and leaves a gap — silently stretching it
 * would mean either freezing a frame or changing its speed, and both are
 * decisions the editor should make rather than have made for it.
 *
 * @returns {{moved: number, short: number}|null}
 */
function cutToBeat(barsPer = 1) {
  const bars = barGrid();
  if (bars.length < 2) return null;
  const hit = findItem(S.sel);
  const track = hit?.tr?.kind === "video"
    ? hit.tr
    : S.tracks.find((t) => t.kind === "video" && t.items.length);
  if (!track?.items.length) return null;

  pushUndo();
  const items = [...track.items].sort((a, b) => a.start - b.start);
  let moved = 0, short = 0;
  for (let i = 0; i < items.length; i++) {
    const from = bars[Math.min(i * barsPer, bars.length - 1)];
    const to = bars[Math.min((i + 1) * barsPer, bars.length - 1)];
    const span = to - from;
    // The last clip has no bar after it to end on; give it the same span as the
    // one before rather than a zero-length slot.
    const want = span > 0.05 ? span : (items[i].dur || 2);
    const avail = Math.max(0.1, (it => it.srcDur - it.inPoint)(items[i]));
    items[i].start = from;
    items[i].dur = Math.min(want, avail);
    if (items[i].dur < want - 0.02) short++;
    moved++;
  }
  paintTimeline();
  render();
  return { moved, short };
}

/** Tempo readout under the beat controls. */
function paintBeatInfo() {
  const el = $("stBeatInfo");
  if (!el) return;
  const B = S.beats;
  if (!B) { el.textContent = "no analysis — drop a song on the timeline"; return; }
  const bpm = B.bpm * S.beatMult;
  const conf = Math.round((B.confidence || 0) * 100);
  el.textContent = `${bpm.toFixed(1)} BPM · ${beatGrid().length} beats · ${conf}% confident`;
}

export function initStudio() {
  if ($("stLanes")?.dataset.wired) return;
  $("stLanes").dataset.wired = "1";
  const cv = $("stCanvas");
  cv.width = S.out.w; cv.height = S.out.h;

  if (!S.tracks.length) {
    /* Seed OR restore — decided synchronously, never both. The first version
     * kicked off the async restore and then seeded anyway; restore replaces
     * S.tracks at its first await, the seeds land on top of the restored set,
     * and every reload grew the project by three tracks. The localStorage READ
     * is synchronous, so use it as the branch and let the slow part (media
     * re-attach) finish in the background. */
    let hasSave = false;
    try { hasSave = !!localStorage.getItem(SAVE_KEY); } catch { /* private mode */ }
    if (hasSave) {
      restoreAutosave().then((had) => {
        if (had) { paintTimeline(); render(); toast("Restored your last session"); }
        else {
          // The save was empty or corrupt — fall back to the seed after all.
          addTrack("video", "Video 2");
          addTrack("video", "Video 1");
          addTrack("audio", "Music");
          paintTimeline();
        }
      });
    } else {
      // Two video layers and one audio track: enough to show what the stack is
      // FOR without making an empty project look like homework.
      addTrack("video", "Video 2");
      addTrack("video", "Video 1");
      addTrack("audio", "Music");
    }
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
    fxSync();
  });

  /* The fold's summary carries a one-line digest, so a closed Fine-tune still
   * says what is active instead of hiding it. */
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

  /* The board the controls are currently editing.
   *
   * Reading is easy; WRITING is where the care is. A clip's override is stored
   * as a partial containing only the fields that differ from the global board,
   * so a clip you gave a different look to still follows the global beat effect
   * when you change that later. Storing a full copy would silently freeze every
   * other setting at whatever it happened to be the moment you first touched
   * that clip — which is the bug this shape exists to avoid. */
  const fxFields = ["beat", "amount", "look", "drift", "vignette"];

  /* Is an edit gesture already recorded? Closed by `change`, which fires once a
   * range is released and once a select is committed — so the NEXT drag starts
   * a fresh entry, and keyboard nudges (which fire change per press) stay
   * individually undoable. */
  let fxGestureOpen = false;

  const readControls = () => ({
    beat: $("stFxBeat").value,
    amount: Number($("stFxAmt").value) / 100,
    look: $("stFxLook").value,
    drift: Number($("stFxDrift").value) / 100,
    vignette: Number($("stFxVig").value) / 100,
  });

  const showControls = (fx) => {
    $("stFxBeat").value = fx.beat;
    $("stFxAmt").value = Math.round(fx.amount * 100);
    $("stFxLook").value = fx.look;
    $("stFxDrift").value = Math.round(fx.drift * 100);
    $("stFxVig").value = Math.round(fx.vignette * 100);
    $("stFxDriftV").textContent = fx.drift ? `${Math.round(fx.drift * 100)}%` : "off";
    $("stFxVigV").textContent = fx.vignette ? `${Math.round(fx.vignette * 100)}%` : "off";
  };

  /** The clip the panel is editing, or null when it is editing the whole video. */
  const fxClip = () => (S.fxTarget === "clip" ? findItem(S.sel)?.it || null : null);

  const fxApply = () => {
    const it = fxClip();
    if (!it) {
      // Whole video: the global board, exactly as before.
      Object.assign(S.fx, readControls());
    } else {
      /* ONE undo entry per gesture, not per pixel.
       *
       * `input` on a range fires continuously, so dragging Amount across its
       * span pushed on the order of a hundred snapshots — and the stack is
       * capped at 50, so a single drag threw away the whole real undo history
       * and then "undid" to somewhere in the middle of that same drag. */
      if (!fxGestureOpen) { pushUndo(); fxGestureOpen = true; }
      const now = readControls();
      // Only what actually differs from the global board is recorded.
      const diff = {};
      for (const k of fxFields) if (now[k] !== S.fx[k]) diff[k] = now[k];
      it.fx = Object.keys(diff).length ? diff : null;
      paintTimeline();
    }
    render();
    fxState();
  };

  /** Load whichever target is selected back into the controls. */
  const fxSync = () => {
    const it = fxClip();
    showControls(it ? effectiveFx(it) : S.fx);
    const has = !!findItem(S.sel);
    $("stFxTarget").querySelector('[data-target="clip"]').disabled = !has;
    $("stFxHint").textContent = S.fxTarget === "clip"
      ? (has
        ? (it?.fx ? "This clip overrides the settings below." : "Changing anything below affects only this clip.")
        : "Select a clip on the timeline first.")
      : "These settings apply to the whole video.";
    fxState();
  };

  /** Summary line on the Fine-tune fold, describing whatever is being edited. */
  const fxState = () => {
    const it = fxClip();
    const fx = it ? effectiveFx(it) : S.fx;
    const bits = [];
    if (fx.beat !== "none") bits.push(fx.beat);
    if (fx.look !== "none") bits.push(fx.look);
    if (fx.drift) bits.push("zoom");
    if (fx.vignette) bits.push("vignette");
    if (S.vis !== "off") bits.push(`vis:${S.vis}`);
    const el = $("stFineState");
    if (el) el.textContent = bits.join(" · ") || "all off";
  };

  $("stFxTarget").addEventListener("click", (e) => {
    const b = e.target.closest("[data-target]");
    if (!b || b.disabled) return;
    S.fxTarget = b.dataset.target === "clip" ? "clip" : null;
    for (const x of $("stFxTarget").querySelectorAll(".stfxt")) x.classList.toggle("on", x === b);
    fxSync();
  });

  // Selecting a different clip must refresh the panel, or it keeps showing the
  // previous clip's values while editing the new one.
  window.addEventListener("aiplay-studio-select", fxSync);

  /* Reactiveness: how the beat is FOUND. Separate from "how hard it reacts",
   * and global by nature — it describes the song, not a clip. */
  const beatRead = () => {
    S.beatCfg.sens = Number($("stBeatSens").value) / 100;
    S.beatCfg.band = $("stBeatBand").value;
    S.beatCfg.drive = $("stBeatDrive").value;
    S.beatCfg.smooth = Number($("stBeatSmooth").value) / 100;
    $("stBeatSensV").textContent = `${$("stBeatSens").value}%`;
    $("stBeatSmoothV").textContent = `${$("stBeatSmooth").value}%`;
    // Smoothing only means anything to the continuous drive.
    $("stBeatSmooth").disabled = S.beatCfg.drive === "pulse";
    // Sensitivity changes meaning between the two: a threshold for an event, a
    // gain for a level. Say so rather than leaving one label doing both jobs.
    const sl = document.querySelector('label[for="stBeatSens"]');
    if (sl) sl.textContent = S.beatCfg.drive === "envelope" ? "gain" : "sensitivity";
    render();
  };
  $("stBeatSens").oninput = beatRead;
  $("stBeatBand").onchange = beatRead;
  $("stBeatDrive").onchange = beatRead;
  $("stBeatSmooth").oninput = beatRead;
  beatRead();

  /* The controls have to SHOW what a reopened project restored, or the panel
   * describes a board it is not driving. Cheap enough to run on every sync. */
  const beatShow = () => {
    $("stBeatSens").value = Math.round(S.beatCfg.sens * 100);
    $("stBeatBand").value = S.beatCfg.band;
    $("stBeatDrive").value = S.beatCfg.drive || "pulse";
    $("stBeatSmooth").value = Math.round((S.beatCfg.smooth ?? 0.35) * 100);
    $("stBeatMult").value = String(S.beatMult);
    $("stBeatSync").checked = !!S.beatSync;
    beatRead();
  };
  window.addEventListener("aiplay-studio-beatcfg", beatShow);

  /* How the measured grid is counted, and whether it drives anything.
   *
   * Changing either repaints the ruler as well as the picture: the grid IS the
   * ruler's beat lines, so a half/double change that only redrew the canvas
   * would leave the timeline disagreeing with the effects. */
  $("stBeatMult").onchange = () => {
    S.beatMult = Number($("stBeatMult").value) || 1;
    paintTimeline(); paintBeatInfo(); render();
  };
  $("stBeatSync").onchange = () => {
    S.beatSync = $("stBeatSync").checked;
    render();
  };
  paintBeatInfo();

  $("stBeatCut").onclick = () => {
    const r = cutToBeat(Math.max(1, Number($("stBeatBars").value) || 1));
    if (!r) {
      // Two different reasons, and telling them apart is the difference between
      // "do something" and "this button is broken".
      toast(S.beats
        ? "Select a video track with clips on it first."
        : "No beat grid yet — drop the song on the timeline and let it analyse.");
      return;
    }
    toast(r.short
      ? `${r.moved} clips on the beat · ${r.short} were shorter than their slot`
      : `${r.moved} clips on the beat`);
  };

  /* Visualiser size and opacity. */
  const visRead = () => {
    S.visSize = Number($("stVisSize").value) / 100;
    S.visOpacity = Number($("stVisOpacity").value) / 100;
    $("stVisSizeV").textContent = `${$("stVisSize").value}%`;
    $("stVisOpacityV").textContent = `${$("stVisOpacity").value}%`;
    render();
  };
  $("stVisSize").oninput = visRead;
  $("stVisOpacity").oninput = visRead;
  visRead();
  for (const id of ["stFxBeat", "stFxAmt", "stFxLook", "stFxDrift", "stFxVig"]) {
    $(id).oninput = () => {
      // Hand-tuning leaves preset-land: the chip un-highlights so it cannot
      // claim to describe a board it no longer matches.
      for (const x of document.querySelectorAll(".stpreset")) x.classList.remove("on");
      fxApply();
    };
    // End of gesture. `blur` as well as `change`, because a drag that ends
    // outside the control still has to close the entry.
    $(id).onchange = () => { fxGestureOpen = false; };
    $(id).onblur = () => { fxGestureOpen = false; };
  }
  fxRead();
  fxSync();

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
    for (const tr of S.tracks) { for (const it of tr.items) it.el?.pause?.(); tr.items = []; }
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
      // The field is shared, so switching tabs must not carry a filter that
      // silently hides everything in the tab you just opened.
      if ($("stSearch")) $("stSearch").placeholder =
        tab.dataset.tab === "songs" ? "Search songs…" : "Search clips…";
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
      for (const it of t.items) it.el?.pause?.();
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
        if (it) { it.el?.pause?.(); tr.items = tr.items.filter((x) => x !== it); }
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

  /* Collapsible docks.
   *
   * Remembered, because hiding a panel is a preference rather than a gesture —
   * re-showing it on every reload would make it not worth using. fitMonitor
   * runs after each change because the picture's width is derived from the
   * space the docks leave it: collapsing without re-fitting would free the
   * space and then not use it. */
  const DOCKS = {
    bin:   { cls: "nobin",   hide: "stBinHide",   show: "stBinShow",   key: "aiplay-studio-nobin" },
    props: { cls: "noprops", hide: "stPropsHide", show: "stPropsShow", key: "aiplay-studio-noprops" },
  };
  const setDock = (d, hidden) => {
    const wrap = document.querySelector(".stwrap");
    wrap.classList.toggle(d.cls, hidden);
    /* Also on #studio, because the TIMELINE is a sibling of .stwrap and needs to
     * react too. Hiding a dock frees width, and the picture cannot use width —
     * it is height-bound (a 16:9 canvas in a 473 px well is 841 px wide however
     * much width you give it). So hiding BOTH docks is read as "focus the
     * picture" and the timeline gives up some height, which the canvas can
     * actually spend. */
    document.querySelector("#studio")?.classList.toggle(d.cls, hidden);
    const panel = d.cls === "nobin" ? ".stside" : ".stprops";
    document.querySelector(panel).hidden = hidden;
    $(d.show).hidden = !hidden;
    try { localStorage.setItem(d.key, hidden ? "1" : "0"); } catch { /* private mode */ }
    fitMonitor();
  };
  for (const d of Object.values(DOCKS)) {
    $(d.hide).onclick = () => setDock(d, true);
    $(d.show).onclick = () => setDock(d, false);
    let saved = "0";
    try { saved = localStorage.getItem(d.key) || "0"; } catch { /* private mode */ }
    setDock(d, saved === "1");
  }

  /* ── Projects ────────────────────────────────────────────────────────────
   *
   * Distinct from the autosave, which stays exactly as it was. Autosave answers
   * "the tab crashed"; a project answers "I want to come back to this
   * tomorrow", and conflating them would mean either losing the crash net or
   * demanding a filename before anyone has made anything. */
  const projName = () => $("stProjName").textContent.trim();
  const setProjName = (n) => { $("stProjName").textContent = n || "Untitled"; };

  /** Everything needed to rebuild this timeline later. Same shape as autosave. */
  const projDoc = () => ({
    v: 1,
    tracks: snapshot(), fx: S.fx, vis: S.vis, out: S.out,
    songTitle: S.songTitle, lrc: S.lrc, t: S.t,
    // Newer than the autosave format, and both readers tolerate their absence.
    beatCfg: S.beatCfg, visSize: S.visSize, visOpacity: S.visOpacity,
    /* How the beat is COUNTED travels with the project; the analysis itself
     * does not. The grid is re-fetched from the server cache in milliseconds,
     * and embedding a couple of hundred kilobytes of envelope in every saved
     * project would make the file mostly a copy of something already on disk. */
    beatMult: S.beatMult, beatSync: S.beatSync,
  });

  $("stSave").onclick = async () => {
    const has = S.tracks.some((t) => t.items.length);
    if (!has) { toast("Nothing to save yet."); return; }
    let name = projName();
    if (!name || name === "Untitled") {
      name = prompt("Name this project:", S.songTitle || "My video")?.trim();
      if (!name) return;
    }
    const r = await (await fetch("/api/studio/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", name, doc: projDoc() }),
    })).json();
    if (r.error) { toast(r.error); return; }
    setProjName(r.name);
    $("stProjName").classList.remove("dirty");
    toast(`Saved “${r.name}”`);
  };

  const paintProjects = async () => {
    const d = await (await fetch("/api/studio/projects")).json();
    const rows = d.projects || [];
    $("projList").innerHTML = rows.length
      ? rows.map((p) => `<div class="projrow">
          <b>${esc(p.name)}</b>
          <span class="meta">${p.items} item${p.items === 1 ? "" : "s"}</span>
          <button data-open="${esc(p.file)}">Open</button>
          <button class="warn" data-delp="${esc(p.file)}">Delete</button>
        </div>`).join("")
      : '<p class="hint">No saved projects yet. Build something and press Save.</p>';
  };

  $("stOpen").onclick = async () => { await paintProjects(); $("projOverlay").hidden = false; };
  $("projClose").onclick = () => { $("projOverlay").hidden = true; };
  $("projOverlay").addEventListener("click", (e) => {
    if (e.target.id === "projOverlay") $("projOverlay").hidden = true;
  });

  $("projList").addEventListener("click", async (e) => {
    const op = e.target.closest("[data-open]");
    const del = e.target.closest("[data-delp]");
    if (del) {
      if (!confirm("Delete this project? The clips and songs it used are not touched.")) return;
      await fetch("/api/studio/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", file: del.dataset.delp }),
      });
      await paintProjects();
      return;
    }
    if (!op) return;
    /* Opening replaces the timeline, so anything unsaved is about to go. Asked
     * once, plainly, rather than silently discarded. */
    if (S.tracks.some((t) => t.items.length) && $("stProjName").classList.contains("dirty")
        && !confirm("Open this project? Unsaved changes to the current one will be lost.")) return;
    const r = await (await fetch("/api/studio/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", file: op.dataset.open }),
    })).json();
    if (r.error) { toast(r.error); return; }
    const d = r.doc || {};
    S.fx = { ...S.fx, ...d.fx };
    S.vis = d.vis ?? S.vis;
    S.out = { ...S.out, ...d.out };
    S.beatCfg = { ...S.beatCfg, ...(d.beatCfg || {}) };
    if (d.beatMult) S.beatMult = d.beatMult;
    if (typeof d.beatSync === "boolean") S.beatSync = d.beatSync;
    // A reopened project has no analysis until its song is re-attached, and
    // `restore` does not go through addSongTo — so it is asked for here.
    S.beats = null;
    if (Number.isFinite(d.visSize)) S.visSize = d.visSize;
    if (Number.isFinite(d.visOpacity)) S.visOpacity = d.visOpacity;
    S.songTitle = d.songTitle || "";
    S.lrc = d.lrc || [];
    await restore(d.tracks || []);
    S.t = 0;
    S.nextId = Math.max(S.nextId, ...S.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), 0) + 1;
    ensureBeats();
    window.dispatchEvent(new CustomEvent("aiplay-studio-beatcfg"));
    setProjName(d.name || "Untitled");
    $("stProjName").classList.remove("dirty");
    $("projOverlay").hidden = true;
    paintTimeline(); render();
    toast(`Opened “${d.name || "project"}”`);
  });

  // Any edit marks the project dirty. pushUndo is the one thing every editing
  // operation already calls, so it is the honest place to hang this.
  window.addEventListener("aiplay-studio-edited", () => {
    $("stProjName").classList.add("dirty");
  });

  $("stSearch").addEventListener("input", () => { paintPicker(); paintSongs(); });

  /* ── Import your own media ───────────────────────────────────────────────
   *
   * Uploaded rather than kept as object URLs. A blob URL costs one line and
   * works until the page reloads, at which point the autosaved project points
   * at something that no longer exists — so an imported file is written into
   * the clip library and behaves like every other clip from then on. */
  async function importFiles(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    let ok = 0;
    const fails = [];
    for (const f of list) {
      toast(`Importing ${f.name}…`);
      try {
        const r = await fetch("/api/studio/import", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-Name": encodeURIComponent(f.name) },
          body: f,
        });
        const d = await r.json();
        if (d.error) fails.push(`${f.name}: ${d.error}`); else ok++;
      } catch (e) {
        fails.push(`${f.name}: ${e.message}`);
      }
    }
    /* Refresh the bin from the server so imports appear beside everything else.
     * Fetched here rather than asking app.js to re-run its loader: the studio
     * already knows how to paint from a clip list, and reaching back into the
     * other module for a refresh is the kind of coupling that breaks quietly. */
    try {
      const d = await (await fetch("/api/clips")).json();
      if (Array.isArray(d.clips)) window.__aiplayClips = d.clips;
    } catch { /* the toast below still reports what happened */ }
    paintPicker();
    // Every failure is named. "Some files failed" is the message that makes
    // people re-drag the whole folder to find out which.
    toast(fails.length
      ? `Imported ${ok}. Failed: ${fails.join(" · ")}`
      : `Imported ${ok} file${ok === 1 ? "" : "s"}`);
  }

  $("stImport").onclick = () => $("stImportFile").click();
  $("stImportFile").onchange = async (e) => {
    await importFiles(e.target.files);
    e.target.value = "";                      // so the same file can be picked twice
  };

  // The whole bin is a drop target. It only shows as one while a drag is over
  // it — a permanently outlined panel reads as an error state.
  const side = document.querySelector(".stside");
  let dragDepth = 0;
  side.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    dragDepth++; side.classList.add("dropping");
  });
  side.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  });
  side.addEventListener("dragleave", () => {
    // Counted, not toggled: dragging across a child fires leave on the parent,
    // and a plain toggle makes the highlight flicker on every internal border.
    if (--dragDepth <= 0) { dragDepth = 0; side.classList.remove("dropping"); }
  });
  side.addEventListener("drop", async (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    dragDepth = 0; side.classList.remove("dropping");
    await importFiles(e.dataTransfer.files);
  });

  // The well's height changes with the window, and the column width follows it.
  new ResizeObserver(() => fitMonitor()).observe(document.querySelector(".stmonitor"));

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
