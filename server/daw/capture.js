/**
 * DAW — the capture path. [DAWREC]
 *
 * Everything between "samples arrive" and "a take sits on the timeline",
 * kept PURE where the maths lives so the pre-commit suite can prove it
 * without a disk or a microphone:
 *
 *   record sessions   an in-memory registry of in-flight captures. Chunks
 *                     arrive numbered; assembly is strict — every seq
 *                     0..n-1 present exactly once, concatenated in order —
 *                     so a dropped POST is an error that names the missing
 *                     chunk, never a silently shorter take.
 *
 *   placement         ONE formula, shared with store.js (audioStartSample):
 *                     musical anchor through the maps + a signed sample
 *                     shift. The calibrated latency offset becomes
 *                     shift = −round(offsetMs/1000 × sr): the capture is
 *                     placed EARLIER by exactly what the loopback measured.
 *
 *   comping           a comp is an ORDERED list of take-region picks in
 *                     absolute project samples, flattened to one buffer —
 *                     later picks win where they overlap, silence where
 *                     nothing covers. That buffer becomes an ordinary audio
 *                     clip; the takes stay on their lane untouched.
 *
 *   the click         beat events derived from the SERVER's timeline rows
 *                     (buildTimeline — the meter map is the only clock) as
 *                     absolute samples; engine.py's click mode just puts
 *                     blips where it is told. Count-in replicates the meter
 *                     of the bar being counted into: 7/8 counts in 7.
 *
 *   actor honesty     the provenance event for a finished capture depends on
 *                     WHO drove it (provenance.js D1.0): a browser capture
 *                     (actor "user") records type "record" — the strongest
 *                     human-origin class, human-recorded. The SAME route
 *                     driven by MCP-supplied samples logs type "import"
 *                     (origin third-party/existing): an agent cannot mint
 *                     human-performed provenance by calling the record API,
 *                     no matter what samples it supplies.
 */
import path from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildTimeline, posToSeconds, TICKS_PER_BEAT } from "./store.js";

/* ─────────────────────────────────────────────── record sessions */

/** Caps: a take longer than this is a mistake, not a performance. */
export const MAX_TAKE_BYTES = 256 * 1024 * 1024;   // ~22 min of 48 kHz f32
export const MAX_CHUNKS = 8192;

const SESSIONS = new Map();

export function beginSession(s) {
  const id = `rec_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const session = {
    id,
    slug: s.slug, trackId: s.trackId,
    sr: s.sr,
    at: s.at,                        // { bar, beat, tick } — the anchor
    startSample: s.startSample,      // round(posToSeconds(at) * sr)
    shiftSamples: s.shiftSamples,    // −(latency), applied at placement
    punchIn: s.punchIn ?? null,      // absolute project samples, or null
    punchOut: s.punchOut ?? null,
    countinBars: s.countinBars,
    countinSeconds: s.countinSeconds,
    device: s.device || "",
    by: s.by === "agent" ? "agent" : "user",
    chunks: new Map(),
    bytes: 0,
    startedAt: Date.now(),
  };
  SESSIONS.set(id, session);
  return session;
}

export function getSession(id) {
  const s = SESSIONS.get(String(id ?? ""));
  if (!s) throw new Error(`No such recording session: ${id}. Sessions do not survive a server restart — start again.`);
  return s;
}

export function endSession(id) {
  return SESSIONS.delete(String(id ?? ""));
}

export function listSessions(slug) {
  const out = [];
  for (const s of SESSIONS.values()) {
    if (slug && s.slug !== slug) continue;
    out.push({
      recId: s.id, trackId: s.trackId, sr: s.sr, at: s.at,
      chunks: s.chunks.size, samples: s.bytes / 4,
      seconds: Number((s.bytes / 4 / s.sr).toFixed(3)),
      startedAt: s.startedAt, device: s.device, by: s.by,
    });
  }
  return out;
}

/** One numbered chunk of little-endian float32 PCM. Idempotence is refused
 * loudly: the same seq twice means the client's bookkeeping is broken and a
 * silent overwrite would hide it. */
export function addChunk(session, seq, buf) {
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_CHUNKS) {
    throw new Error(`chunk seq must be an integer 0..${MAX_CHUNKS - 1} — got ${seq}.`);
  }
  if (!buf || !buf.length) throw new Error(`chunk ${n} is empty.`);
  if (buf.length % 4 !== 0) {
    throw new Error(`chunk ${n} is ${buf.length} bytes — not a whole number of float32 samples.`);
  }
  if (session.chunks.has(n)) throw new Error(`chunk ${n} was already received.`);
  if (session.bytes + buf.length > MAX_TAKE_BYTES) {
    throw new Error(`the take exceeds ${Math.round(MAX_TAKE_BYTES / 1048576)} MB — stop and comp what you have.`);
  }
  session.chunks.set(n, Buffer.from(buf));
  session.bytes += buf.length;
  return { seq: n, samples: buf.length / 4, totalSamples: session.bytes / 4 };
}

/**
 * Concatenate the chunks into one Float32Array — SAMPLE-EXACT across chunk
 * boundaries because it is bytes end-to-end in seq order, with every gap in
 * the numbering an error that names itself.
 */
export function assembleSession(session) {
  const seqs = [...session.chunks.keys()].sort((a, b) => a - b);
  if (!seqs.length) throw new Error("no chunks were received — nothing to assemble.");
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i) throw new Error(`chunk ${i} is missing (got seqs ${seqs.slice(0, 8).join(", ")}${seqs.length > 8 ? "…" : ""}).`);
  }
  const out = Buffer.concat(seqs.map((q) => session.chunks.get(q)));
  return new Float32Array(out.buffer, out.byteOffset, out.length / 4);
}

/* ───────────────────────────────────────────────── placement maths */

/** The calibrated offset as a placement shift: the capture reached the disk
 * offsetMs late, so it sits on the timeline that much EARLIER. */
export function latencyShift(offsetMs, sr) {
  const ms = Number(offsetMs) || 0;
  return -Math.round(ms / 1000 * sr);
}

/** Where a session's take starts and how it is anchored, before any punch:
 * startSample honours the shift; the stored take keeps the musical anchor
 * and carries the shift separately (store.audioStartSample re-derives). */
export function takePlacement(session) {
  return {
    at: session.at,
    shiftSamples: session.shiftSamples,
    startSample: session.startSample + session.shiftSamples,
  };
}

/**
 * Punch in/out as a pure trim: keep only the samples inside
 * [punchIn, punchOut) in ABSOLUTE project samples. Returns the trimmed
 * samples plus how far the take's start moved (the extra shift).
 */
export function punchTrim(samples, startSample, punchIn, punchOut) {
  const end = startSample + samples.length;
  const from = punchIn == null ? startSample : Math.max(startSample, Math.round(punchIn));
  const to = punchOut == null ? end : Math.min(end, Math.round(punchOut));
  if (to <= from) {
    throw new Error(`the punch window [${punchIn}, ${punchOut}) leaves nothing of the take [${startSample}, ${end}).`);
  }
  return {
    samples: samples.subarray(from - startSample, to - startSample),
    startSample: from,
    extraShift: from - startSample,
  };
}

/* ─────────────────────────────────────────────────────── comping */

/**
 * Flatten ordered picks into one buffer.
 *
 *   picks:   [{ take, fromSample, toSample }]  absolute project samples
 *   takes:   Map(takeId -> { start, samples })  start absolute, Float32Array
 *
 * Later picks overwrite earlier ones where they overlap (order IS the
 * priority — that is the whole comping model); where a pick reaches past its
 * take's samples, silence stays. Returns { samples, startSample }.
 */
export function flattenComp(picks, takes) {
  if (!Array.isArray(picks) || !picks.length) throw new Error("a comp needs at least one pick.");
  let lo = Infinity, hi = -Infinity;
  for (const [i, p] of picks.entries()) {
    const from = Math.round(Number(p.fromSample));
    const to = Math.round(Number(p.toSample));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      throw new Error(`pick ${i}: from_sample/to_sample must be numbers with to > from.`);
    }
    if (!takes.has(String(p.take))) throw new Error(`pick ${i} names an unknown take: ${p.take}.`);
    lo = Math.min(lo, from); hi = Math.max(hi, to);
  }
  if (hi - lo > MAX_TAKE_BYTES / 4) throw new Error("the comp window is longer than the take cap.");
  const out = new Float32Array(hi - lo);
  for (const p of picks) {
    const take = takes.get(String(p.take));
    const from = Math.round(Number(p.fromSample));
    const to = Math.round(Number(p.toSample));
    const a = Math.max(from, take.start);
    const b = Math.min(to, take.start + take.samples.length);
    for (let s = a; s < b; s++) out[s - lo] = take.samples[s - take.start];
    // outside [a, b) the pick asked for samples the take never had: silence,
    // and honestly so — a comp is picks over what was performed.
  }
  return { samples: out, startSample: lo };
}

/* ─────────────────────────────────────────────────────── the click */

/**
 * Click events for a record pass: `countinBars` bars counted in the METER OF
 * THE STARTING BAR (7/8 counts in 7), then the real timeline from `fromBar`
 * for `bars` bars. Everything is derived from buildTimeline — the one clock.
 * Sample 0 of the click is the START OF THE COUNT-IN; the transport position
 * `fromBar` sounds at exactly countinSeconds.
 */
export function clickEvents(doc, fromBar, bars, countinBars, sr) {
  const rows = buildTimeline(doc);
  const from = Math.min(Math.max(1, Math.round(fromBar)), rows.length);
  const count = Math.min(Math.max(0, Math.round(countinBars ?? 1)), 4);
  const span = Math.min(Math.max(1, Math.round(bars ?? rows.length - from + 1)), rows.length - from + 1);
  const row0 = rows[from - 1];
  const beat0 = (4 / row0.den) * 60 / row0.bpm;
  const countinSeconds = count * row0.num * beat0;
  const events = [];
  for (let k = 0; k < count * row0.num; k++) {
    events.push({ sample: Math.round(k * beat0 * sr), accent: k % row0.num === 0 });
  }
  let spanSec = 0;
  for (let b = from; b < from + span; b++) {
    const row = rows[b - 1];
    const beatSec = (4 / row.den) * 60 / row.bpm;
    const barOff = countinSeconds + (row.sec - row0.sec);
    for (let k = 0; k < row.num; k++) {
      events.push({ sample: Math.round((barOff + k * beatSec) * sr), accent: k === 0 });
    }
    spanSec = barOff + row.secLen - countinSeconds;
  }
  const nSamples = Math.round((countinSeconds + spanSec + 0.2) * sr);
  return { countinSeconds, countinSamples: Math.round(countinSeconds * sr), nSamples, events };
}

/* ───────────────────────────────────────── per-device latency store */

/** dawLatency: { "<device label>": offsetMs } inside the app settings file —
 * the same file the Settings screen owns; this touches only its own key. */
export async function readLatency(config) {
  try {
    const j = JSON.parse(await readFile(config.settingsFile, "utf8"));
    return j && typeof j.dawLatency === "object" && j.dawLatency ? j.dawLatency : {};
  } catch {
    return {};
  }
}

export async function writeLatency(config, device, offsetMs) {
  let cur = {};
  try { cur = JSON.parse(await readFile(config.settingsFile, "utf8")) || {}; } catch { /* first write */ }
  const table = (cur.dawLatency && typeof cur.dawLatency === "object") ? cur.dawLatency : {};
  const key = String(device || "default").slice(0, 120);
  table[key] = Math.round(Number(offsetMs) * 1000) / 1000;
  cur.dawLatency = table;
  await mkdir(path.dirname(config.settingsFile), { recursive: true });
  const tmp = config.settingsFile + `.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cur, null, 2), "utf8");
  await rename(tmp, config.settingsFile);
  return table;
}

/** The stored offset for a device: exact label, else "default", else 0. */
export function offsetFor(table, device) {
  const key = String(device || "").slice(0, 120);
  if (key && Number.isFinite(Number(table[key]))) return Number(table[key]);
  if (Number.isFinite(Number(table.default))) return Number(table.default);
  return 0;
}

/* ─────────────────────────────────────── actor honesty at the seam */

/**
 * The provenance event for a finished capture. actor "user" — the browser,
 * which never sets the actor header — is a human performance: type "record",
 * folding to human-recorded, the strongest human-origin class. ANY other
 * actor (agent:*, system) logs type "import" with the channel named: the
 * samples existed before this API call, and no API call turns an agent into
 * a microphone. This is a pure function so the pre-commit suite can pin it.
 */
export function captureEvent(actor, kind, data = {}) {
  if (actor === "user") {
    return { type: "record", data: { kind, ...data } };
  }
  return { type: "import", data: { kind, via: "daw_record", origin: "third-party/existing", ...data } };
}

/* ─────────────────────────────────────────── misc shared helpers */

/** Minimal float32 mono RIFF reader (the chirp file, for the synthetic
 * capture route). Mirrors engine.py's writer. */
export function parseWavF32(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error("not RIFF");
  let pos = 12, sr = 0, samples = null;
  while (pos + 8 <= buf.length) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") sr = dv.getUint32(pos + 12, true);
    if (id === "data") {
      const s = buf.subarray(pos + 8, pos + 8 + size);
      samples = new Float32Array(s.buffer.slice(s.byteOffset, s.byteOffset + s.length));
    }
    pos += 8 + size + (size & 1);
  }
  if (!sr || !samples) throw new Error("wav missing fmt/data");
  return { sr, samples };
}

/** Quantize a note position to a tick grid inside its bar (pure). Returns
 * { beat, tick } — the bar never changes (minimal, predictable). */
export function quantizePos(beat, tick, grid, beatsInBar) {
  const g = Math.max(1, Math.round(grid));
  const total = (beat - 1) * TICKS_PER_BEAT + tick;
  const barTicks = beatsInBar * TICKS_PER_BEAT;
  const snapped = Math.min(Math.round(total / g) * g, barTicks - 1);
  return { beat: Math.floor(snapped / TICKS_PER_BEAT) + 1, tick: snapped % TICKS_PER_BEAT };
}

/** Seconds of a musical position — re-exported convenience for routes. */
export function posSeconds(doc, pos) {
  return posToSeconds(doc, pos, buildTimeline(doc, Math.max(pos.bar, 1)));
}
