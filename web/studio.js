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
  rec: null, chunks: [], recording: false,
  vis: "bars", karaoke: true, showTitle: true,
  ac: null, analyser: null, freq: null, wave: null, mixBus: null,
  songTitle: "",
  lrc: [],
  pps: 60,          // pixels per second — the timeline's zoom
  sel: null,        // selected item id
};

const W = 1280, H = 720;
const SNAP = 0.15;   // seconds; drag snapping to clip edges and to zero

/* ─────────────────────────────────────────────────────────── track model */

function addTrack(kind, name) {
  const t = { id: S.nextId++, kind, name: name || (kind === "video" ? "Video" : "Audio"), muted: false, solo: false, items: [] };
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
  const sorted = [...track.items].sort((a, b) => a.start - b.start);
  const i = sorted.indexOf(it);
  if (i <= 0) return 1;
  const prev = sorted[i - 1];
  const overlap = prev.start + prev.dur - it.start;
  if (overlap <= 0) return 1;
  const into = t - it.start;
  return into < overlap ? clamp(into / overlap, 0, 1) : 1;
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

  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  // Bottom layer first. `videoTracks()` is in display order (top row first), so
  // reverse it to paint the bottom-most layer first and the top-most last.
  const vts = videoTracks().slice().reverse();
  let drewAnything = false;
  for (const tr of vts) {
    if (!audible(tr)) continue;
    for (const it of [...tr.items].sort((a, b) => a.start - b.start)) {
      if (t < it.start || t > it.start + it.dur) continue;
      if (!it.el || it.el.readyState < 2) continue;
      ctx.globalAlpha = itemAlpha(tr, it, t);
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

  drawVisualiser(ctx, W, H);
  drawKaraoke(ctx, W, H, t);
  drawTitle(ctx, W, H, t);

  $("stTime").textContent = `${fmt(t)} / ${fmt(total)}`;
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
        const want = clamp(local, 0, it.dur);
        if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
        el.muted = tr.kind === "video";     // video layers are picture only
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
      S.t = it ? it.start + clock.currentTime : clock.currentTime;
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

async function startExport() {
  if (!totalLength()) return;
  const stream = $("stCanvas").captureStream(30);
  ensureBus();
  // Tap the mix for the recording without unhooking the speakers.
  const dest = S.ac.createMediaStreamDestination();
  S.analyser.connect(dest);
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);

  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  S.chunks = [];
  S.rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  S.rec.ondataavailable = (e) => { if (e.data.size) S.chunks.push(e.data); };
  S.rec.onstop = saveExport;
  S.recording = true;
  seek(0);
  S.rec.start(250);
  play();
  $("stExport").textContent = "Stop recording";
  $("stExportNote").textContent = "Recording in real time — keep this window in front until it finishes.";
}

function stopExport() {
  if (!S.rec) return;
  S.recording = false;
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
    $("stExportNote").innerHTML = `Saved as <b>${esc(d.name)}</b> — it is in your clip library.`;
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
async function attach(it, kind) {
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
  it.dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 5;
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

function rulerHtml(total) {
  // A tick a second, a label every five. Denser than that is unreadable at any
  // zoom this timeline supports.
  const secs = Math.ceil(Math.max(total, 10)) + 5;
  let h = "";
  for (let i = 0; i <= secs; i++) {
    h += `<span class="sttick${i % 5 === 0 ? " maj" : ""}" style="left:${i * S.pps}px">${
      i % 5 === 0 ? `<b>${fmt(i)}</b>` : ""}</span>`;
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
      <span class="stkind">${tr.kind === "video" ? "▣" : "♪"}</span>
      <span class="stlabel" title="${esc(tr.name)}">${esc(tr.name)}</span>
      <button class="sttog${tr.muted ? " on" : ""}" data-mute="${tr.id}" title="${tr.kind === "video" ? "Hide this layer" : "Mute this track"}">M</button>
      <button class="sttog${tr.solo ? " on solo" : ""}" data-solo="${tr.id}" title="Solo">S</button>
      <button class="sttog warn" data-deltrack="${tr.id}" title="Remove this track">✕</button>
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
          <button class="stclipx" data-delitem="${it.id}" title="Remove">✕</button>
        </div>`;
      }).join("")}
    </div>`).join("");
  paintPlayhead();
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
  const cands = [0, S.t];
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
  cv.width = W; cv.height = H;

  if (!S.tracks.length) {
    // Two video layers and one audio track to start: enough to show what the
    // stack is FOR without making an empty project look like homework.
    addTrack("video", "Video 2");
    addTrack("video", "Video 1");
    addTrack("audio", "Music");
  }

  $("stPlay").onclick = () => (S.playing ? pause() : play());
  $("stVis").onchange = (e) => { S.vis = e.target.value; render(); };
  $("stKaraoke").onchange = (e) => { S.karaoke = e.target.checked; render(); };
  $("stTitleCard").onchange = (e) => { S.showTitle = e.target.checked; render(); };
  $("stExport").onclick = () => (S.recording ? stopExport() : startExport());
  $("stAddVideo").onclick = () => { addTrack("video", `Video ${videoTracks().length + 1}`); paintTimeline(); };
  $("stAddAudio").onclick = () => { addTrack("audio", `Audio ${audioTracks().length + 1}`); paintTimeline(); };
  $("stZoom").oninput = (e) => { S.pps = Number(e.target.value); paintTimeline(); };
  $("stClear").onclick = () => {
    for (const tr of S.tracks) { for (const it of tr.items) it.el?.pause(); tr.items = []; }
    S.lrc = []; S.songTitle = ""; S.t = 0;
    paintTimeline(); render();
  };

  $("stSongAdd").onchange = async (e) => {
    const file = e.target.value;
    e.target.value = "";
    if (!file) return;
    const tr = audioTracks()[0] || addTrack("audio", "Music");
    // Append after whatever is already on the track rather than stacking at 0.
    const at = tr.items.reduce((m, it) => Math.max(m, it.start + it.dur), 0);
    await addSongTo(tr, file, at);
  };

  /* ---- track header buttons ---- */
  $("stHeads").addEventListener("click", (e) => {
    const m = e.target.closest("[data-mute]"), s = e.target.closest("[data-solo]"), d = e.target.closest("[data-deltrack]");
    if (m) { const t = S.tracks.find((x) => x.id === +m.dataset.mute); t.muted = !t.muted; }
    else if (s) { const t = S.tracks.find((x) => x.id === +s.dataset.solo); t.solo = !t.solo; }
    else if (d) {
      const t = S.tracks.find((x) => x.id === +d.dataset.deltrack);
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
  let drag = null;
  $("stLanes").addEventListener("pointerdown", (e) => {
    const del = e.target.closest("[data-delitem]");
    if (del) {
      const id = +del.dataset.delitem;
      for (const tr of S.tracks) {
        const it = tr.items.find((x) => x.id === id);
        if (it) { it.el?.pause(); tr.items = tr.items.filter((x) => x !== it); }
      }
      paintTimeline(); render();
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
    drag = { it, from: tr, grabT: timeAt(e.clientX) - it.start };
    el.setPointerCapture(e.pointerId);
    paintTimeline();
  });

  $("stLanes").addEventListener("pointermove", (e) => {
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

  const endDrag = () => { if (drag) { drag = null; syncMedia(); render(); } };
  $("stLanes").addEventListener("pointerup", endDrag);
  $("stLanes").addEventListener("pointercancel", endDrag);

  $("stLanes").addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("text/aiplay-clip")) e.preventDefault();
  });
  $("stLanes").addEventListener("drop", async (e) => {
    const name = e.dataTransfer.getData("text/aiplay-clip");
    if (!name) return;
    e.preventDefault();
    const lane = e.target.closest("[data-lane]");
    const tr = lane ? S.tracks.find((x) => x.id === +lane.dataset.lane) : videoTracks()[videoTracks().length - 1];
    if (!tr || tr.kind !== "video") return;
    await addClipTo(tr, name, snap(timeAt(e.clientX)));
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

  document.addEventListener("keydown", (e) => {
    if ($("studio").hidden) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) return;
    if (e.code === "Space") { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.code === "Home") seek(0);
    if (e.code === "Delete" && S.sel != null) {
      for (const tr of S.tracks) {
        const it = tr.items.find((x) => x.id === S.sel);
        if (it) { it.el?.pause(); tr.items = tr.items.filter((x) => x !== it); }
      }
      S.sel = null; paintTimeline(); render();
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
  const sel = $("stSongAdd");
  const songs = (library || []).filter((t) => !t.file.startsWith("clip:"));
  sel.innerHTML = '<option value="">＋ Add a song…</option>' +
    songs.map((t) => `<option value="${esc(t.file)}"${t.lrc ? ' data-lrc="1"' : ""}>${esc(t.title || t.file)}${t.lrc ? " · lyrics" : ""}</option>`).join("");
  paintTimeline();
}
