/**
 * VFX — instrument rigs: comps that PLAY the transcription.
 *
 * Two builders, one contract: notes in (server/vfx/notes.py's output — for the
 * fretboard they must carry the fingering's string/fret), LAYERS out, ready to
 * splice into an existing comp. PURE, templates.js's rule: no disk, no engine,
 * no library lookups — which is what lets rigs_test-style checks and the route
 * share one implementation, and what makes the output deterministic: the same
 * notes build byte-identical layers, and the engine renders byte-identical
 * frames from them (the e2e proves that with a sha).
 *
 * WHY SHAPE LAYERS AND KEYFRAMES rather than something clever: the audio→keys
 * precedent. A rig that is ordinary layers with ordinary keyframes can be
 * re-timed, re-coloured, masked, glowed, precomposed and rendered by every
 * tool that already exists, and the builder never has to be taught about any
 * of them. Layers come back FRONT-FIRST (layers[0] paints last — on top),
 * so the route splices them at index 0 in order.
 *
 * THE FRETBOARD (neck cam, tab convention: high e on top, low E at the
 * bottom; `leftHanded` mirrors the neck). Real fret spacing — each fret sits
 * at 1 - 2^(-k/12) of the scale, normalised to the neck the comp can show —
 * because equal spacing is the first thing that reads as "not a guitar".
 * Three layers, plus two more when the tab lane is on:
 *
 *   dots     one shape layer, a group per string. The group's own transform
 *            animates: position HOLD-keys onto (fret, string) at each onset
 *            (a fretting hand jumps, it does not glide), opacity HOLD-keys
 *            0/100 around each note. A bend note slides the dot ALONG the
 *            string from its fret toward fret+bend over `bendTime`, then
 *            holds — the visual the staircase collapse exists to feed.
 *   flash    one shape layer, a line per string that pulses opacity on each
 *            onset and decays over ~0.25 s. Reads as the string ringing.
 *   board    the static neck: wood, frets, nut, dot inlays (3/5/7/9, double
 *            at 12), wound and plain strings at their own gauges.
 *   tab      (optional) one Consolas six-line tab whose x-position keys pull
 *            each event's column under a fixed playhead at its onset — linear
 *            between events, so the lane scrolls at the music's own tempo.
 *            Consolas advances exactly 0.55 em (measured with FreeType, and
 *            it is metrically stable — it has shipped with Windows since
 *            Vista), which is what lets a pure builder place columns without
 *            asking the engine to measure text.
 *
 * THE PIANO: a keyboard across the bottom (white keys, black keys over the
 * gaps), a lit overlay per DISTINCT pitch (a group each, opacity hold-keyed
 * on that pitch's own notes), and a piano-roll lane falling INTO the keys —
 * one group whose y-position is two linear keys, because constant scroll is
 * one straight line, not a key per frame.
 *
 * LIMITS, honestly reported: shapes.py holds 32 groups per layer and 64 items
 * per group, so pitches beyond 32 spill onto extra lit layers and a roll
 * bigger than its group chunks across subgroups. What cannot fit is SKIPPED
 * AND COUNTED in `warnings` — a rig that silently drew fewer notes than the
 * song has would be the exact kind of quiet failure this codebase keeps
 * getting bitten by.
 */
import { blankLayer, blankMask } from "./store.js";

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi);

/** One keyframe; ease only when not linear (§1's economy rule). */
const K = (t, v, ease) => (ease === undefined ? { t: r3(t), v } : { t: r3(t), v, ease });

const GUITAR_COLORS = {
  board: [58, 40, 34],
  fret: [188, 188, 198],
  nut: [232, 227, 214],
  string: [186, 188, 196],
  inlay: [214, 203, 183],
  dot: [255, 196, 64],
  flash: [122, 212, 255],
  text: [232, 232, 238],
};

const PIANO_COLORS = {
  white: [242, 240, 235],
  black: [24, 24, 30],
  line: [120, 120, 130],
  lit: [255, 196, 64],
  roll: [122, 212, 255],
};

/** Caller colours over the defaults — only keys the palette knows. */
function palette(defaults, given) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(given || {})) {
    if (k in out && Array.isArray(v) && v.length >= 3) {
      out[k] = v.slice(0, 3).map((c) => clamp(Math.round(c), 0, 255));
    }
  }
  return out;
}

/**
 * Opacity pulses: 1 at each onset, decaying to 0 — flash's whole animation.
 * Keys stay strictly increasing even when onsets land inside the previous
 * decay (16ths at 140 BPM are 107 ms apart, under the 250 ms decay): the
 * decay-to-zero key is only written once the NEXT onset is far enough away.
 */
function pulseKeys(times, { hi = 100, decay = 0.25, pre = 0.03 } = {}) {
  const ts = [...times].sort((a, b) => a - b);
  const keys = [K(0, 0)];
  let lastT = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t <= lastT) continue;
    if (t - pre > lastT + 1e-6) keys.push(K(t - pre, 0));
    keys.push(K(t, hi));
    lastT = t;
    const next = ts[i + 1];
    if (next === undefined || next - t > decay + pre) {
      keys.push(K(t + decay, 0));
      lastT = t + decay;
    }
  }
  return keys;
}

/* ───────────────────────────────────────────────── the fretboard geometry */

function neckGeometry(W, H, frets, leftHanded) {
  const margin = W * 0.06;
  const boardW = W - 2 * margin;
  const boardH = clamp(H * 0.42, 60, 360);
  const inset = boardH / 7;                       // string inset from the edges
  const nutInset = boardW * 0.05;                 // headstock sliver, open-note home
  const nutX = -boardW / 2 + nutInset;
  const span = boardW - nutInset - boardW * 0.02;
  const total = 1 - 2 ** (-frets / 12);
  const mirror = leftHanded ? (x) => -x : (x) => x;
  const fretX = (k) => mirror(nutX + ((1 - 2 ** (-k / 12)) / total) * span);
  const stringY = (s) => (boardH / 2 - inset) - (s * (boardH - 2 * inset)) / 5;
  const noteX = (fret) =>
    fret <= 0 ? mirror(nutX - nutInset * 0.5)
      : r3((fretX(fret - 1) + fretX(fret)) / 2);
  return { boardW, boardH, inset, nutX, mirror, fretX, stringY, noteX,
           stringGap: (boardH - 2 * inset) / 5 };
}

/** Notes grouped per string, sorted; unfingered notes counted, never drawn. */
function perString(notes) {
  const strings = new Map();
  let skipped = 0;
  for (const n of notes) {
    const s = Number(n.string);
    if (!Number.isInteger(s) || s < 0 || s > 5 || !Number.isFinite(Number(n.fret))) {
      skipped++;
      continue;
    }
    if (!strings.has(s)) strings.set(s, []);
    strings.get(s).push(n);
  }
  for (const arr of strings.values()) arr.sort((a, b) => a.t - b.t);
  return { strings, skipped };
}

export function buildFretboardRig(doc, notes, opts = {}) {
  const W = doc.width, H = doc.height;
  const frets = clamp(Math.round(opts.frets ?? 12), 5, 24);
  const leftHanded = opts.leftHanded === true;
  const col = palette(GUITAR_COLORS, opts.colors);
  const bendVisual = opts.bendVisual !== false;
  const g = neckGeometry(W, H, frets, leftHanded);
  const warnings = [];

  const { strings, skipped } = perString(notes);
  if (skipped) {
    warnings.push(`${skipped} note(s) carry no string/fret and are not drawn — `
      + "run the transcription with fingering, or assign them first.");
  }
  const over = [...strings.values()].flat().filter((n) => n.fret > frets);
  if (over.length) {
    warnings.push(`${over.length} note(s) sit above fret ${frets}; their dots clamp to the last fret. `
      + "Raise `frets` to show them where they are played.");
  }

  /* ── the static neck ── */
  const board = blankLayer(doc, "shape", { name: opts.name || "fretboard" });
  const fretItems = [];
  for (let k = 1; k <= frets; k++) {
    fretItems.push({ type: "path", closed: false,
      points: [r3(g.fretX(k)), r3(-g.boardH / 2), r3(g.fretX(k)), r3(g.boardH / 2)] });
  }
  const inlayItems = [];
  const dotR = g.stringGap * 0.32;
  for (const k of [3, 5, 7, 9, 15, 17, 19, 21]) {
    if (k > frets) continue;
    inlayItems.push({ type: "ellipse", size: [r3(dotR * 2), r3(dotR * 2)],
                      position: [g.noteX(k), 0] });
  }
  if (frets >= 12) {
    for (const dy of [-g.stringGap, g.stringGap]) {
      inlayItems.push({ type: "ellipse", size: [r3(dotR * 2), r3(dotR * 2)],
                        position: [g.noteX(12), r3(dy)] });
    }
  }
  const stringLine = (s) => ({ type: "path", closed: false,
    points: [r3(-g.boardW / 2), r3(g.stringY(s)), r3(g.boardW / 2), r3(g.stringY(s))] });
  board.shapes = [
    { type: "group", name: "wood", items: [
      { type: "rect", size: [r3(g.boardW), r3(g.boardH)], position: [0, 0], roundness: 10 },
      { type: "fill", color: col.board },
    ] },
    { type: "group", name: "inlays", items: [
      ...inlayItems, { type: "fill", color: col.inlay, opacity: 55 },
    ] },
    { type: "group", name: "frets", items: [
      ...fretItems, { type: "stroke", color: col.fret, width: 3 },
    ] },
    { type: "group", name: "nut", items: [
      { type: "path", closed: false,
        points: [r3(g.mirror(g.nutX)), r3(-g.boardH / 2), r3(g.mirror(g.nutX)), r3(g.boardH / 2)] },
      { type: "stroke", color: col.nut, width: 9 },
    ] },
    /* Wound strings are visibly heavier than plain ones — one stroke per
     * gauge, because a stroke paints every path the group has accumulated. */
    { type: "group", name: "wound", items: [
      stringLine(0), stringLine(1), stringLine(2),
      { type: "stroke", color: col.string, width: 4 },
    ] },
    { type: "group", name: "plain", items: [
      stringLine(3), stringLine(4), stringLine(5),
      { type: "stroke", color: col.string, width: 2.2 },
    ] },
  ];

  /* ── the string flash ── */
  const flash = blankLayer(doc, "shape", { name: "string flash" });
  flash.shapes = [];
  for (const [s, arr] of [...strings.entries()].sort((a, b) => a[0] - b[0])) {
    flash.shapes.push({
      type: "group", name: `flash ${s}`,
      transform: { opacity: { keys: pulseKeys(arr.map((n) => n.t)) } },
      items: [stringLine(s), { type: "stroke", color: col.flash, width: 6, lineCap: "round" }],
    });
  }

  /* ── the finger dots ── */
  const dots = blankLayer(doc, "shape", { name: "finger dots" });
  dots.shapes = [];
  const dotD = r3(g.stringGap * 0.85);
  for (const [s, arr] of [...strings.entries()].sort((a, b) => a[0] - b[0])) {
    const y = r3(g.stringY(s));
    const pos = [];
    const opa = [K(0, 0, "hold")];
    let prevEnd = -1;
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      const t = Math.max(0, n.t);
      const end = t + Math.max(0.05, n.dur || 0.05);
      const fret = clamp(Math.round(n.fret), 0, frets);
      const x = g.noteX(fret);
      /* A fretting hand JUMPS between notes — hold, no glide. A bend is the
       * one exception: the dot slides along the string toward where the bent
       * pitch would be fretted, over the staircase's own measured ramp. */
      const bend = bendVisual && Number(n.bend) > 0
        ? clamp(Math.round(n.bend), 1, frets - fret) : 0;
      if (bend > 0) {
        const ramp = clamp(Number(n.bendTime) || 0.19, 0.05, Math.max(0.06, end - t));
        pos.push(K(t, [x, y]));                        // linear toward the target
        pos.push(K(t + ramp, [g.noteX(fret + bend), y], "hold"));
      } else {
        pos.push(K(t, [x, y], "hold"));
      }
      /* Legato on one string: the next note begins before this one ends —
       * the dot stays lit and simply moves, so no off/on flicker. */
      const next = arr[i + 1];
      if (prevEnd < t) opa.push(K(t, 100, "hold"));
      if (next === undefined || next.t > end + 1e-6) {
        opa.push(K(r3(end), 0, "hold"));
        prevEnd = -1;
      } else {
        prevEnd = end;
      }
    }
    dots.shapes.push({
      type: "group", name: `dot ${s}`,
      transform: { position: { keys: pos }, opacity: { keys: opa } },
      items: [
        { type: "ellipse", size: [dotD, dotD], position: [0, 0] },
        { type: "fill", color: col.dot },
        { type: "ellipse", size: [dotD, dotD], position: [0, 0] },
        { type: "stroke", color: [255, 255, 255], width: 1.5, opacity: 60 },
      ],
    });
  }

  const layers = [dots, flash, board];

  /* ── the tab lane (optional) ── */
  if (opts.tab) {
    const events = clusterEvents([...strings.values()].flat());
    const ts = clamp(Math.round(H * 0.032), 10, 24);
    const cw = ts * 0.55;                       // Consolas: exactly 0.55 em
    const NAMES = ["E", "A", "D", "G", "B", "e"];
    const rows = [5, 4, 3, 2, 1, 0].map((s) => {
      let line = `${NAMES[s]}|`;
      for (const ev of events) {
        const hit = ev.notes.find((n) => Number(n.string) === s);
        if (!hit) { line += "---"; continue; }
        const f = String(clamp(Math.round(hit.fret), 0, 24));
        line += (f + (Number(hit.bend) > 0 ? "b" : "-") + "--").slice(0, 3);
      }
      return line;
    });
    const laneY = r3(H - ts * 6 * 1.15 / 2 - H * 0.03);
    const playX = r3(W * 0.30);
    const tab = blankLayer(doc, "text", { name: "tab" });
    tab.text = {
      content: rows.join("\n"), font: "consola.ttf", size: ts,
      color: [...col.text, 255], align: "left",
      stroke: 0, strokeColor: [0, 0, 0, 255], lineHeight: 1.15, tracking: 0,
    };
    /* align "left": position.x is where the lines BEGIN. Column i's centre
     * sits (2 + 3i + 1.5) characters in; a key per event pulls it under the
     * playhead at that event's onset, linear between (the lane breathes with
     * the tempo instead of pretending it is constant). */
    const tabKeys = events.map((ev, i) =>
      K(ev.t, r3(playX - (2 + 3 * i + 1.5) * cw), i === events.length - 1 ? "hold" : undefined));
    if (!tabKeys.length || events[0].t > 0) tabKeys.unshift(K(0, r3(playX - 3.5 * cw)));
    tab.transform.position = { keys: tabKeys.map((k) => ({ ...k, v: [k.v, laneY] })) };

    /* Shape coords are centre-origin; the playhead line converts comp x/y. */
    const head = blankLayer(doc, "shape", { name: "tab playhead" });
    head.shapes = [{ type: "group", name: "playhead", items: [
      { type: "path", closed: false,
        points: [r3(playX - W / 2), r3(laneY - H / 2 - ts * 3.8),
                 r3(playX - W / 2), r3(laneY - H / 2 + ts * 3.8)] },
      { type: "stroke", color: col.dot, width: 2, opacity: 70 },
    ] }];
    layers.unshift(head);
    layers.unshift(tab);
  }

  return { layers, warnings, strings: strings.size,
           drawn: [...strings.values()].reduce((a, b) => a + b.length, 0) };
}

/** Notes within 40 ms are one chord event — the fingering DP's own rule. */
function clusterEvents(notes) {
  const srt = [...notes].sort((a, b) => a.t - b.t);
  const events = [];
  for (const n of srt) {
    const last = events[events.length - 1];
    if (last && n.t - last.t <= 0.04) last.notes.push(n);
    else events.push({ t: n.t, notes: [n] });
  }
  return events;
}

/* ─────────────────────────────────────────────────────────── the piano rig */

const WHITE_OF = [0, 2, 4, 5, 7, 9, 11];             // pitch classes on white keys
const isWhite = (m) => WHITE_OF.includes(((m % 12) + 12) % 12);

export function buildPianoRig(doc, notes, opts = {}) {
  const W = doc.width, H = doc.height;
  const col = palette(PIANO_COLORS, opts.colors);
  const warnings = [];
  const usable = notes.filter((n) => Number.isFinite(Number(n.midi)));
  if (!usable.length) throw new Error("The piano rig needs notes with midi numbers.");

  /* The keyboard shows the notes' own range, padded to white keys, capped at
   * five octaves — beyond that the keys are too thin to read at 1080p. */
  let lo = Math.min(...usable.map((n) => n.midi)) - 2;
  let hi = Math.max(...usable.map((n) => n.midi)) + 2;
  lo = clamp(lo, 21, 108); hi = clamp(hi, 21, 108);
  while (!isWhite(lo)) lo--;
  while (!isWhite(hi)) hi++;
  if (hi - lo > 60) {
    warnings.push(`The notes span ${hi - lo} semitones; the keyboard shows the lowest five octaves `
      + "and notes above it are skipped.");
    hi = lo + 60;
    while (!isWhite(hi)) hi--;
  }

  const whites = [];
  for (let m = lo; m <= hi; m++) if (isWhite(m)) whites.push(m);
  const margin = W * 0.05;
  const kw = (W - 2 * margin) / whites.length;
  const kh = clamp(H * 0.24, 40, 240);
  const keyTop = H / 2 - kh;                        // shape coords: centre origin, +y down
  const whiteX = new Map(whites.map((m, i) => [m, -W / 2 + margin + (i + 0.5) * kw]));
  const keyX = (m) => {
    if (isWhite(m)) return whiteX.get(m);
    return (whiteX.get(m - 1) ?? -W / 2) + kw / 2;  // a black key rides the gap
  };
  const bw = kw * 0.58, bh = kh * 0.62;

  const board = blankLayer(doc, "shape", { name: opts.name || "keyboard" });
  const whiteRect = (m) => ({ type: "rect", size: [r3(kw * 0.94), r3(kh)],
                              position: [r3(whiteX.get(m)), r3(keyTop + kh / 2)], roundness: 3 });
  const blackRect = (m) => ({ type: "rect", size: [r3(bw), r3(bh)],
                              position: [r3(keyX(m)), r3(keyTop + bh / 2)], roundness: 2 });
  const blacks = [];
  for (let m = lo; m <= hi; m++) if (!isWhite(m)) blacks.push(m);
  board.shapes = [
    { type: "group", name: "white keys", items: [
      ...whites.map(whiteRect), { type: "fill", color: col.white }] },
    { type: "group", name: "white edges", items: [
      ...whites.map(whiteRect), { type: "stroke", color: col.line, width: 1.5 }] },
    { type: "group", name: "black keys", items: [
      ...blacks.map(blackRect), { type: "fill", color: col.black }] },
  ];

  /* ── keys light on onsets: a group per DISTINCT pitch, opacity hold-keyed
   * on that pitch's own notes. 32 groups per layer is shapes.py's cap, so
   * pitches spill onto additional layers rather than silently vanishing. */
  const byPitch = new Map();
  let skipped = 0;
  for (const n of usable) {
    if (n.midi < lo || n.midi > hi) { skipped++; continue; }
    if (!byPitch.has(n.midi)) byPitch.set(n.midi, []);
    byPitch.get(n.midi).push(n);
  }
  if (skipped) warnings.push(`${skipped} note(s) fall outside the keyboard and are not drawn.`);

  const litLayers = [];
  const pitches = [...byPitch.keys()].sort((a, b) => a - b);
  for (let i = 0; i < pitches.length; i += 32) {
    const lit = blankLayer(doc, "shape",
      { name: litLayers.length ? `lit keys ${litLayers.length + 1}` : "lit keys" });
    lit.shapes = pitches.slice(i, i + 32).map((m) => {
      const arr = byPitch.get(m).sort((a, b) => a.t - b.t);
      const opa = [K(0, 0, "hold")];
      let lastOff = 0;
      for (const n of arr) {
        const t = Math.max(0, n.t), end = t + Math.max(0.08, n.dur || 0.08);
        if (t > lastOff) opa.push(K(t, 100, "hold"));
        if (end > Math.max(t, lastOff)) { opa.push(K(r3(end), 0, "hold")); lastOff = end; }
      }
      return {
        type: "group", name: `key ${m}`,
        transform: { opacity: { keys: opa } },
        items: [isWhite(m) ? whiteRect(m) : blackRect(m),
                { type: "fill", color: col.lit, opacity: isWhite(m) ? 85 : 100 }],
      };
    });
    litLayers.push(lit);
  }

  /* ── the roll: notes fall INTO the keyboard, arriving at their onset.
   * One group, two linear keys — constant scroll is a straight line. */
  const layers = [...litLayers, board];
  if (opts.roll !== false) {
    const pps = clamp(Number(opts.pixelsPerSecond) || (H - kh) / 3, 30, 1200);
    const CHUNK = 62;                        // + a fill = 63 items, under the 64 cap
    const chunks = [];
    const rollNotes = usable.filter((n) => n.midi >= lo && n.midi <= hi)
      .sort((a, b) => a.t - b.t);
    const MAXN = 62 * 30;
    if (rollNotes.length > MAXN) {
      warnings.push(`The roll draws the first ${MAXN} of ${rollNotes.length} notes.`);
      rollNotes.length = MAXN;
    }
    for (let i = 0; i < rollNotes.length; i += CHUNK) {
      chunks.push({
        type: "group", name: `bars ${1 + i / CHUNK}`,
        items: [
          ...rollNotes.slice(i, i + CHUNK).map((n) => {
            const hgt = Math.max(6, (n.dur || 0.1) * pps);
            return { type: "rect",
              size: [r3((isWhite(n.midi) ? kw : bw) * 0.7), r3(hgt)],
              position: [r3(keyX(n.midi)), r3(-(n.t * pps) - hgt / 2)], roundness: 3 };
          }),
          { type: "fill", color: col.roll, opacity: 80 },
        ],
      });
    }
    if (chunks.length) {
      const roll = blankLayer(doc, "shape", { name: "note roll" });
      const D = doc.duration;
      roll.shapes = [{
        type: "group", name: "roll",
        transform: { position: { keys: [K(0, [0, r3(keyTop)]), K(D, [0, r3(keyTop + D * pps)])] } },
        items: chunks,
      }];
      /* The lane must stop AT the keyboard, not pour through it: mask the
       * layer to the region above the keys. Mask points are comp pixels. */
      roll.masks = [blankMask(
        [[0, 0], [W, 0], [W, r3(H / 2 + keyTop)], [0, r3(H / 2 + keyTop)]])];
      layers.unshift(roll);
    }
  }

  return { layers, warnings, pitches: pitches.length,
           drawn: usable.length - skipped };
}
