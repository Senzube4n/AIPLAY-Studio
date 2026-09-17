/**
 * A YuE2 score into the DAW, and out as a MIDI file, 2026-09-17.
 *
 * The planner's ABC (X:1 … V: Vocal / V: Ins, L:1/32, Q:1/4=bpm) already parses
 * to sounding notes per voice — parseScore() in mcp-music-score.js gives
 * [startTicks, midi, durTicks] at TICKS_PER_QUARTER = 1024, plus the bar map
 * each voice walked. This module turns that into
 *
 *   · a DAW PLAN: the project's tempo and meter, one track per voice, one clip
 *     spanning the score, and every note at bar.beat.tick with dur_ticks — the
 *     DAW's own grammar (TICKS_PER_BEAT = 960, a beat = the meter's denominator
 *     note), so a route can post it straight to /api/daw;
 *   · a STANDARD MIDI FILE (format 1, 480 ppq): tempo + meter on track 0, one
 *     track per voice with a programme, chord symbols as markers on the Ins
 *     track — for any other DAW.
 *
 * Nothing here interprets: a rest is a gap, a tie is one note (the parser
 * already joined it), and a chord symbol is text. The clock follows the bars
 * as WRITTEN, the same rule the checker applies.
 */
import { parseScore, TICKS_PER_QUARTER } from "../mcp-music-score.js";

export const DAW_TICKS_PER_BEAT = 960;
export const MIDI_PPQ = 480;
/** Where a voice lands by default. Both exist in the DAW's patch manifest. */
export const VOICE_PATCH = { Vocal: "salamander", Ins: "pluck" };
export const VOICE_PROGRAM = { Vocal: 52, Ins: 0 };   // GM: Choir Aahs, Acoustic Grand

/** The header's meter is the string as written ("4/4"); each voice carries {n, d}. */
function meterOf(p) {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(p.header.meter || "").trim());
  if (m) return { n: Number(m[1]), d: Number(m[2]) };
  const v = Object.values(p.voices).find((x) => x.meter && x.meter.n);
  return v ? { n: v.meter.n, d: v.meter.d } : { n: 4, d: 4 };
}

/** Bar/beat/tick for an absolute score tick, walking the voice's own bars. */
function place(bars, tick, fallbackMeter) {
  let bar = null, i = 0;
  for (; i < bars.length; i += 1) {
    const [start, held] = bars[i];
    if (tick < start + held) { bar = bars[i]; break; }
  }
  if (!bar) {
    // Past the last written bar (a held note runs over): keep counting in the last meter.
    const last = bars[bars.length - 1];
    const n = last ? last[3] : fallbackMeter.n, d = last ? last[4] : fallbackMeter.d;
    const barTicks = (4 * TICKS_PER_QUARTER * n) / d;
    const lastEnd = last ? last[0] + last[1] : 0;
    const extra = Math.floor((tick - lastEnd) / barTicks);
    bar = [lastEnd + extra * barTicks, barTicks, barTicks, n, d];
    i = bars.length + extra;
  }
  const [start, , , n, d] = bar;
  const beatTicks = (4 * TICKS_PER_QUARTER) / d;
  const into = tick - start;
  const beat = Math.floor(into / beatTicks);
  const rem = into - beat * beatTicks;
  return {
    bar: i + 1,
    beat: Math.min(beat + 1, Math.max(1, n)),
    tick: Math.round((rem / beatTicks) * DAW_TICKS_PER_BEAT),
    beatTicks,
  };
}

/**
 * The DAW plan. Refuses (throws) a score the checker would refuse, because a
 * project built from a broken score is a broken project with a nicer name.
 */
export function scoreToDawPlan(abc, { name = "score", patches = {} } = {}) {
  const p = parseScore(abc);
  if (p.fatal) throw new Error(`The score does not parse: ${p.fatal.says}`);
  const meter = meterOf(p);
  const bpm = Number(p.header.bpm) || 120;
  const voices = Object.entries(p.voices).filter(([, v]) => (v.notes || []).length || (v.bars || []).length);
  if (!voices.length) throw new Error("The score has no voices with bars.");
  let lengthBars = 1;
  const tracks = [], notes = [], markers = [];
  for (const [vname, v] of voices) {
    const bars = v.bars || [];
    const track = { name: vname, instrument: patches[vname] || VOICE_PATCH[vname] || "pluck", clipName: `${vname} · score` };
    tracks.push(track);
    for (const [start, midi, dur] of v.notes || []) {
      const at = place(bars, start, meter);
      const durTicks = Math.max(1, Math.round((dur / at.beatTicks) * DAW_TICKS_PER_BEAT));
      notes.push({ track: vname, bar: at.bar, beat: at.beat, tick: at.tick, dur_ticks: durTicks, pitch: midi, vel: 100 });
      const endAt = place(bars, start + dur - 1, meter);
      lengthBars = Math.max(lengthBars, endAt.bar);
    }
    if (bars.length) lengthBars = Math.max(lengthBars, bars.length);
    for (const [tick, symbol] of v.chords || []) {
      const at = place(bars, tick, meter);
      markers.push({ track: vname, bar: at.bar, beat: at.beat, tick: at.tick, symbol });
    }
  }
  return {
    name, bpm, num: meter.n, den: meter.d, key: p.header.key || null,
    lengthBars, tracks, notes, markers,
    counts: { notes: notes.length, chords: markers.length, voices: tracks.length },
  };
}

/* ── the MIDI file ─────────────────────────────────────────────────────── */
function vlq(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}
function be32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function be16(n) { return [(n >> 8) & 255, n & 255]; }
function meta(type, bytes) { return [0xff, type, ...vlq(bytes.length), ...bytes]; }
const text = (s) => [...Buffer.from(String(s), "utf8")];
function track(events) {
  // events: [{ at: absoluteTicks, bytes: [...] }], sorted here, deltas written.
  const sorted = [...events].sort((a, b) => a.at - b.at || a.order - b.order);
  const body = [];
  let last = 0;
  for (const e of sorted) { body.push(...vlq(e.at - last), ...e.bytes); last = e.at; }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, ...be32(body.length), ...body];
}

/** Standard MIDI File bytes for the score (format 1, 480 ppq). */
export function scoreToMidi(abc, { name = "score" } = {}) {
  const p = parseScore(abc);
  if (p.fatal) throw new Error(`The score does not parse: ${p.fatal.says}`);
  const meter = meterOf(p);
  const bpm = Number(p.header.bpm) || 120;
  const scale = MIDI_PPQ / TICKS_PER_QUARTER;
  const T = (ticks) => Math.round(ticks * scale);
  const tracks = [];
  // Track 0: name, tempo, meter (dd = log2(denominator)), key as text.
  const dd = Math.round(Math.log2(meter.d));
  const t0 = [
    { at: 0, order: 0, bytes: meta(0x03, text(name)) },
    { at: 0, order: 1, bytes: meta(0x51, be32(Math.round(60_000_000 / bpm)).slice(1)) },
    { at: 0, order: 2, bytes: meta(0x58, [meter.n, dd, 24, 8]) },
    ...(p.header.key ? [{ at: 0, order: 3, bytes: meta(0x01, text(`K:${p.header.key}`)) }] : []),
  ];
  tracks.push(track(t0));
  let ch = 0;
  for (const [vname, v] of Object.entries(p.voices)) {
    if (!(v.notes || []).length && !(v.chords || []).length) continue;
    // Name and programme first at tick 0, before any marker or off there.
    const ev = [
      { at: 0, order: -10, bytes: meta(0x03, text(vname)) },
      { at: 0, order: -9, bytes: [0xc0 | ch, VOICE_PROGRAM[vname] ?? 0] },
    ];
    let order = 2;
    for (const [start, midi, dur] of v.notes || []) {
      const on = T(start), off = Math.max(on + 1, T(start + dur));
      ev.push({ at: on, order: order++, bytes: [0x90 | ch, midi & 127, 100] });
      ev.push({ at: off, order: -1, bytes: [0x80 | ch, midi & 127, 0] });   // offs before ons at the same tick
    }
    for (const [tick, symbol] of v.chords || []) ev.push({ at: T(tick), order: -2, bytes: meta(0x06, text(symbol)) });
    tracks.push(track(ev));
    ch = (ch + 1) % 16;
    if (ch === 9) ch = 10;   // never the drum channel
  }
  const header = [0x4d, 0x54, 0x68, 0x64, ...be32(6), ...be16(1), ...be16(tracks.length), ...be16(MIDI_PPQ)];
  return Buffer.from([...header, ...tracks.flat()]);
}
