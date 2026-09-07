/**
 * DAW — the mixer document model and its routes. The CHAIN STAGE's JS half.
 *
 * ── THE SEAM CONTRACT (binding, shared with the instrument + capture stages)
 * Per-track render = INSTRUMENT STAGE (notes → dry track buffer, float32
 * stereo (2,N) @48k, P0 conventions) then CHAIN STAGE (this module + rack.py):
 * per-track insert chain → per-track fader/pan → sends → return tracks with
 * their own chains → master chain → master fader → the tanh master stays last.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * WHAT LIVES ON THE DOCUMENT (all migrated field-by-field, house rule):
 *
 *   track.inserts  [{ id, type, enabled, params }]   params fully populated
 *   track.fader    dB, number | { keys }             from the catalog, so a
 *   track.pan      -1..1, number | { keys }          document always says
 *   track.solo     bool                              what it sounds like
 *   track.sends    [{ to: returnId, level, pre }]
 *   doc.returns    [{ id, name, inserts, fader, pan }]
 *   doc.master     { inserts, fader, stereo?, target_lufs? }  stereo: the rack
 *                  renders each voice's own channels (new projects; absent =
 *                  the fold); target_lufs: the bounce aims at it (absent = off)
 *
 * AUTOMATION is the house keyframe shape — { keys: [{ t, v, ease? }] } — the
 * vfx format, normalised by the vfx normaliser and evaluated by the vfx
 * evaluator (imported below; no parallel format, no parallel maths). Key `t`
 * is a FLOAT BAR (3.5 = halfway through bar 3), so automation is pinned to
 * musical time and rides a tempo change; it becomes seconds only inside
 * mixerJobPayload, the render boundary, like every other second.
 *
 * ── THE DEPENDENCY-GRAPH RULE (the subtle part, so it is written once) ────
 * The region hash must cover everything that can reach a region's samples.
 * With a rack in the graph that is three additions:
 *
 *  1. CONFIG REACHES WHERE THE TRACK SOUNDS. Each region's hash folds in the
 *     mixer signature of every track with a note reaching it, the signatures
 *     of the returns those tracks send to, and the master signature. So: a
 *     chain edit dirties that track's sounding regions (+ everything the
 *     state rule below adds); a return edit dirties exactly its CONSUMERS'
 *     regions; a master edit dirties every sounding region. A fully default
 *     mixer contributes NOTHING — the hashes are byte-identical to P0's, old
 *     caches stay warm, and the P0 e2e gates hold unchanged.
 *
 *  2. STATE FLOWS FORWARD, SO SOUND REACHES FORWARD. A chain renders from
 *     absolute sample 0 (rack.py's determinism rule), so anything through a
 *     STATEFUL device (filter/comp/delay/reverb — the catalog's `stateful`
 *     flag) influences every later sample, in principle down at the
 *     last-ulp level. Truth over cache greed: such a source's reach is
 *     [start − 0.02 s, ∞) — the 0.02 covers a master limiter's lookahead
 *     reading backward. A track whose whole path is MEMORYLESS (utility,
 *     saturator, fader/pan/send automation, none of it stateful) keeps the
 *     P0 reach, which is what keeps the sub-second edit loop for plain
 *     level/pan mixing.
 *     "ANYTHING", not "a note": this clause said NOTES for as long as notes
 *     were the only thing the rack rendered. [DAWREC] rack._mix_audio mixes
 *     file-backed clips into the same dry buffers, so store.audioEvents takes
 *     its reach from mixerReach exactly as noteEvents does — and both the
 *     region hash and the region JOB test clips by it. A rule with one word
 *     wrong is how the take's reverb tail got cut out of the bounce.
 *
 *  3. SIDECHAIN IS AN EDGE. A track that keys another track's compressor is
 *     part of that compressor's input: it takes the stateful reach too, and
 *     the target's chain signature (which names the source id) does the
 *     rest.
 *
 * store.js calls into here from migrate/noteEvents/regionHashes so the rule
 * lives beside the catalog it depends on; mixer_test.js pins every clause.
 */
import { evalProp, normalizeKeys } from "../vfx/store.js";
import { newId, clamp, findTrack, buildTimeline } from "./store.js";
import { loudnessOptions } from "./bounce-options.js";

/* ───────────────────────────── the catalog mirror (rack.py is the DSP
 * truth; this table is what the store can validate and hash WITHOUT
 * spawning python). GET /api/daw/rack serves both and says whether they
 * agree — the TAILS-table pattern, applied to the rack. */

const N = (def, min, max) => ({ type: "number", default: def, min, max });
const B = (def) => ({ type: "bool", default: def });
const E = (def, values) => ({ type: "enum", default: def, values });
const T = (def) => ({ type: "track", default: def });

export const SYNC_QUARTERS = {
  "1/32": 0.125, "1/16t": 1 / 6, "1/16": 0.25, "1/16d": 0.375,
  "1/8t": 1 / 3, "1/8": 0.5, "1/8d": 0.75,
  "1/4t": 2 / 3, "1/4": 1.0, "1/4d": 1.5,
  "1/2t": 4 / 3, "1/2": 2.0, "1/2d": 3.0, "1/1": 4.0,
};
const SYNCS = Object.keys(SYNC_QUARTERS).sort((a, b) => SYNC_QUARTERS[a] - SYNC_QUARTERS[b]);

export const MIXER_CATALOG = {
  eq: {
    label: "Parametric EQ", stateful: true,
    params: {
      hp_on: B(false), hp_hz: N(80, 10, 1000),
      lp_on: B(false), lp_hz: N(12000, 200, 20000),
      b1_hz: N(120, 20, 20000), b1_gain_db: N(0, -18, 18), b1_q: N(1, 0.1, 12),
      b2_hz: N(500, 20, 20000), b2_gain_db: N(0, -18, 18), b2_q: N(1, 0.1, 12),
      b3_hz: N(2000, 20, 20000), b3_gain_db: N(0, -18, 18), b3_q: N(1, 0.1, 12),
      b4_hz: N(6000, 20, 20000), b4_gain_db: N(0, -18, 18), b4_q: N(1, 0.1, 12),
    },
  },
  compressor: {
    label: "Compressor", stateful: true,
    params: {
      threshold_db: N(-18, -60, 0), ratio: N(4, 1, 20),
      attack_ms: N(10, 0.1, 200), release_ms: N(120, 5, 2000),
      knee_db: N(6, 0, 24), makeup_db: N(0, -12, 24), sidechain: T(""),
    },
  },
  limiter: {
    label: "Limiter", stateful: true,
    params: {
      ceiling_db: N(-1, -20, 0), release_ms: N(80, 1, 1000),
      lookahead_ms: N(5, 1, 10),
    },
  },
  saturator: {
    label: "Saturator", stateful: false,
    params: {
      drive_db: N(8, 0, 36), character: E("tanh", ["tanh", "tape"]),
      mix: N(1, 0, 1), trim_db: N(0, -24, 24),
    },
  },
  chorus: {
    label: "Chorus", stateful: true,
    params: {
      rate_hz: N(0.8, 0.05, 8), depth_ms: N(3.5, 0, 12),
      mix: N(0.5, 0, 1), spread: N(1, 0, 1),
    },
  },
  delay: {
    label: "Stereo Delay", stateful: true,
    params: {
      sync: E("1/8", SYNCS), feedback: N(0.35, 0, 0.9), mix: N(0.3, 0, 1),
      pingpong: B(true), tone_hz: N(8000, 500, 18000),
    },
  },
  reverb: {
    label: "Reverb", stateful: true,
    params: {
      room_size: N(0.5, 0, 1), damp: N(0.5, 0, 1), width: N(1, 0, 1),
      mix: N(0.3, 0, 1), predelay_ms: N(10, 0, 100),
    },
  },
  gate: {
    label: "Gate", stateful: true,
    params: {
      threshold_db: N(-50, -80, 0), range_db: N(-80, -80, 0),
      attack_ms: N(1, 0.1, 100), hold_ms: N(50, 0, 1000),
      release_ms: N(150, 5, 2000),
    },
  },
  utility: {
    label: "Utility", stateful: false,
    params: {
      gain_db: N(0, -48, 24), pan: N(0, -1, 1), width: N(1, 0, 2),
      phase_invert: B(false), mono: B(false),
    },
  },

  /* ── THE MASTERING SUITE (agent/master) ─────────────────────────────────
   * server/daw/master.py is the DSP; this is its half of the two-table
   * mirror, exactly as the nine above mirror rack.py. `catalogsAgree()`
   * compares the two on every GET /api/daw/rack, so a default that drifts
   * here fails at the seam rather than in someone's master. Parameter
   * ORDER is the UI's reading order, so it follows the signal.            */
  multibandCompressor: {
    label: "Multiband Compressor", stateful: true,
    params: {
      bands: E("3", ["2", "3", "4"]),
      x1_hz: N(120, 30, 1000), x2_hz: N(900, 200, 6000), x3_hz: N(5000, 1000, 16000),
      knee_db: N(6, 0, 24),
      b1_threshold_db: N(-24, -60, 0), b1_ratio: N(3, 1, 20),
      b1_attack_ms: N(30, 0.5, 300), b1_release_ms: N(200, 5, 2000),
      b1_makeup_db: N(0, -12, 24), b1_solo: B(false), b1_bypass: B(false),
      b2_threshold_db: N(-24, -60, 0), b2_ratio: N(3, 1, 20),
      b2_attack_ms: N(15, 0.5, 300), b2_release_ms: N(150, 5, 2000),
      b2_makeup_db: N(0, -12, 24), b2_solo: B(false), b2_bypass: B(false),
      b3_threshold_db: N(-24, -60, 0), b3_ratio: N(3, 1, 20),
      b3_attack_ms: N(8, 0.5, 300), b3_release_ms: N(120, 5, 2000),
      b3_makeup_db: N(0, -12, 24), b3_solo: B(false), b3_bypass: B(false),
      b4_threshold_db: N(-24, -60, 0), b4_ratio: N(3, 1, 20),
      b4_attack_ms: N(5, 0.5, 300), b4_release_ms: N(100, 5, 2000),
      b4_makeup_db: N(0, -12, 24), b4_solo: B(false), b4_bypass: B(false),
    },
  },
  dynamicEq: {
    label: "Dynamic EQ", stateful: true,
    params: {
      d1_on: B(false), d1_hz: N(120, 20, 20000), d1_q: N(2, 0.2, 12),
      d1_threshold_db: N(-24, -60, 0), d1_ratio: N(4, 1, 20),
      d1_range_db: N(6, 0, 18), d1_mode: E("above", ["above", "below"]),
      d1_attack_ms: N(10, 0.5, 300), d1_release_ms: N(120, 5, 2000),
      d2_on: B(false), d2_hz: N(600, 20, 20000), d2_q: N(2, 0.2, 12),
      d2_threshold_db: N(-24, -60, 0), d2_ratio: N(4, 1, 20),
      d2_range_db: N(6, 0, 18), d2_mode: E("above", ["above", "below"]),
      d2_attack_ms: N(10, 0.5, 300), d2_release_ms: N(120, 5, 2000),
      d3_on: B(false), d3_hz: N(3000, 20, 20000), d3_q: N(2, 0.2, 12),
      d3_threshold_db: N(-24, -60, 0), d3_ratio: N(4, 1, 20),
      d3_range_db: N(6, 0, 18), d3_mode: E("above", ["above", "below"]),
      d3_attack_ms: N(5, 0.5, 300), d3_release_ms: N(80, 5, 2000),
      d4_on: B(false), d4_hz: N(8000, 20, 20000), d4_q: N(2, 0.2, 12),
      d4_threshold_db: N(-24, -60, 0), d4_ratio: N(4, 1, 20),
      d4_range_db: N(6, 0, 18), d4_mode: E("above", ["above", "below"]),
      d4_attack_ms: N(3, 0.5, 300), d4_release_ms: N(60, 5, 2000),
    },
  },
  stereoImager: {
    label: "Stereo Imager", stateful: true,
    params: {
      x1_hz: N(250, 40, 2000), x2_hz: N(3000, 500, 12000),
      w1_width: N(1, 0, 2), w2_width: N(1, 0, 2), w3_width: N(1, 0, 2),
      mono_below_hz: N(0, 0, 300),
    },
  },
  tiltEq: {
    label: "Tilt EQ", stateful: true,
    params: {
      tilt_db: N(0, -12, 12), pivot_hz: N(1000, 100, 8000), slope: N(0.7, 0.3, 1.5),
    },
  },
  maximizer: {
    label: "Maximizer", stateful: true,
    params: {
      gain_db: N(0, 0, 24), ceiling_db: N(-1, -20, 0), knee_db: N(3, 0, 12),
      attack_ms: N(1, 0.1, 50), release_ms: N(120, 1, 1000),
      lookahead_ms: N(5, 1, 10),
      character: E("clean", ["clean", "warm", "punch"]),
    },
  },
  exciter: {
    label: "Exciter", stateful: true,
    params: {
      freq_hz: N(3000, 200, 12000), drive_db: N(12, 0, 36),
      blend: N(0.5, 0, 1), mix: N(0.25, 0, 1), output_db: N(0, -24, 12),
    },
  },
  dither: {
    label: "Dither", stateful: true,
    params: {
      bits: N(16, 8, 24), noise_shape: E("shaped", ["flat", "shaped"]),
      seed: N(1, 0, 65535), auto_blank: B(true),
    },
  },
};

/* THE MASTERING SUITE, part 2: `stereo_mode` is added to the two EXISTING
 * devices it applies to, the same way master.py wraps them in python. The
 * default keeps both byte-identical to the pre-suite rack. */
for (const d of ["eq", "compressor"]) {
  MIXER_CATALOG[d].params.stereo_mode =
    E("stereo", ["stereo", "mid_side", "mid", "side"]);
}

export const MIXER_LIMITS = {
  returns: 4, insertsPerChain: 8, sendsPerTrack: 4, keysPerParam: 64,
  faderDb: [-60, 12], sendDb: [-60, 12],
};

/* ───────────────────────────────────────────── values: plain or keyed */

export const isKeyed = (v) => !!v && typeof v === "object" && Array.isArray(v.keys);

/** number | {keys} → migrated, clamped, key times (float bars) ≥ 1. */
export function normAuto(v, def, lo, hi, label = "value") {
  if (isKeyed(v)) {
    let keys;
    try {
      keys = normalizeKeys(v.keys, { arity: 1, label });
    } catch (err) {
      throw new Error(`${label}: ${err.message}`);
    }
    if (keys.length > MIXER_LIMITS.keysPerParam) {
      throw new Error(`${label}: at most ${MIXER_LIMITS.keysPerParam} keys.`);
    }
    return {
      keys: keys.map((k) => ({
        t: Math.max(1, k.t),
        v: clamp(Number(Array.isArray(k.v) ? k.v[0] : k.v) || 0, lo, hi),
        ...(k.ease === undefined ? {} : { ease: k.ease }),
      })),
    };
  }
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : def;
}

/** One insert's params: catalog-complete, catalog-clamped, unknowns dropped. */
export function normParams(type, raw) {
  const spec = MIXER_CATALOG[type]?.params;
  if (!spec) throw new Error(`Unknown device "${type}". The rack has: ${Object.keys(MIXER_CATALOG).join(", ")}.`);
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [name, d] of Object.entries(spec)) {
    const v = src[name];
    if (d.type === "number") {
      out[name] = v === undefined ? d.default
        : normAuto(v, d.default, d.min, d.max, `${type}.${name}`);
    } else if (d.type === "bool") {
      out[name] = v === undefined ? d.default : !!v;
    } else if (d.type === "enum") {
      if (v !== undefined && !d.values.includes(v)) {
        throw new Error(`${type}.${name} must be one of ${d.values.join(", ")} — got "${v}".`);
      }
      out[name] = v === undefined ? d.default : v;
    } else if (d.type === "track") {
      out[name] = v === undefined ? d.default : String(v);
    }
  }
  const unknown = Object.keys(src).filter((k) => !spec[k]);
  if (unknown.length) {
    throw new Error(`${type} has no parameter ${unknown.map((u) => `"${u}"`).join(", ")}. It has: ${Object.keys(spec).join(", ")}.`);
  }
  return out;
}

export function normInserts(list, label = "chain") {
  const rows = (Array.isArray(list) ? list : []).filter((i) => i && typeof i === "object");
  if (rows.length > MIXER_LIMITS.insertsPerChain) {
    throw new Error(`${label}: at most ${MIXER_LIMITS.insertsPerChain} inserts.`);
  }
  return rows.map((i) => ({
    id: i.id || newId("ins"),
    type: String(i.type),
    enabled: i.enabled !== false,
    params: normParams(String(i.type), i.params),
  }));
}

/* ─────────────────────────────────────────────────────────── migration */

/** Tolerant twin of normInserts for LOAD time: a malformed insert is
 * dropped, a malformed param falls back — repair, never refuse to open. */
function migrateInserts(list) {
  const out = [];
  for (const i of Array.isArray(list) ? list : []) {
    if (!i || typeof i !== "object" || !MIXER_CATALOG[i.type]) continue;
    const spec = MIXER_CATALOG[i.type].params;
    const params = {};
    for (const [name, d] of Object.entries(spec)) {
      try {
        params[name] = normParams(i.type, { [name]: i.params?.[name] })[name];
      } catch {
        params[name] = d.default;
      }
    }
    out.push({ id: i.id || newId("ins"), type: i.type, enabled: i.enabled !== false, params });
    if (out.length >= MIXER_LIMITS.insertsPerChain) break;
  }
  return out;
}

const migAuto = (v, def, lo, hi) => {
  try {
    return normAuto(v, def, lo, hi);
  } catch {
    return def;
  }
};

export function migrateTrackMixer(t) {
  t.inserts = migrateInserts(t.inserts);
  t.fader = migAuto(t.fader, 0, MIXER_LIMITS.faderDb[0], MIXER_LIMITS.faderDb[1]);
  t.pan = migAuto(t.pan, 0, -1, 1);
  t.solo = !!t.solo;
  t.sends = (Array.isArray(t.sends) ? t.sends : [])
    .filter((s) => s && s.to)
    .slice(0, MIXER_LIMITS.sendsPerTrack)
    .map((s) => ({
      to: String(s.to),
      level: migAuto(s.level, 0, MIXER_LIMITS.sendDb[0], MIXER_LIMITS.sendDb[1]),
      pre: !!s.pre,
    }));
  return t;
}

export function migrateDocMixer(doc) {
  doc.returns = (Array.isArray(doc.returns) ? doc.returns : [])
    .filter(Boolean)
    .slice(0, MIXER_LIMITS.returns)
    .map((r) => ({
      id: r.id || newId("ret"),
      name: String(r.name ?? "Return").slice(0, 80),
      inserts: migrateInserts(r.inserts),
      fader: migAuto(r.fader, 0, MIXER_LIMITS.faderDb[0], MIXER_LIMITS.faderDb[1]),
      pan: migAuto(r.pan, 0, -1, 1),
    }));
  const m = doc.master && typeof doc.master === "object" ? doc.master : {};
  doc.master = {
    inserts: migrateInserts(m.inserts),
    fader: migAuto(m.fader, 0, MIXER_LIMITS.faderDb[0], MIXER_LIMITS.faderDb[1]),
    /* THE STEREO SWITCH (rack.py: mixer.stereo). Only a literal `true` is
     * kept, and an absent key stays absent: a document written before the
     * switch existed keeps the fold and its bytes. blankProject sets it for
     * new projects; see the reason there. */
    ...(m.stereo === true ? { stereo: true } : {}),
    /* THE LOUDNESS TARGET (master.py: loudness_stage), a bounce-time
     * setting: absent = the bytes exactly as rendered. It is NOT part of
     * the master signature below, because it changes no region. */
    ...(Number.isFinite(Number(m.target_lufs)) && m.target_lufs !== null && m.target_lufs !== ""
      ? { target_lufs: clampLufs(m.target_lufs) } : {}),
  };
  return doc;
}

/** The loudness target's legal range, in LUFS: a club master at −6 is the
 * loud end anyone asks for, −30 is quieter than any delivery spec. */
export const TARGET_LUFS_RANGE = [-30, -6];
export const clampLufs = (v) =>
  Math.round(Math.min(Math.max(Number(v), TARGET_LUFS_RANGE[0]), TARGET_LUFS_RANGE[1]) * 100) / 100;

/** The switch, read in ONE place on the JS side (rack.stereo_on is the other). */
export const stereoOn = (doc) => doc?.master?.stereo === true;

/* ─────────────────────────── audibility, reach, and the hash signatures */

export function mixerAudible(doc, track) {
  const anySolo = (doc.tracks || []).some((x) => x.solo);
  return anySolo ? !!track.solo : !track.mute;
}

const defAuto = (v) => v === 0 || v === undefined;

/** True when NOTHING in the mixer would change a sample — the P0 case. */
export function isDefaultMixer(doc) {
  if ((doc.returns || []).length) return false;
  /* The stereo switch is a rack setting: with it on, even an otherwise empty
   * mixer must render through rack.py (the P0 path folds every voice). */
  if (stereoOn(doc)) return false;
  if (doc.master && ((doc.master.inserts || []).length || !defAuto(doc.master.fader))) return false;
  for (const t of doc.tracks || []) {
    if ((t.inserts || []).length || (t.sends || []).length) return false;
    if (!defAuto(t.fader) || !defAuto(t.pan) || t.solo) return false;
  }
  return true;
}

const statefulIns = (i) => i && i.enabled !== false && !!MIXER_CATALOG[i.type]?.stateful;
export const chainStateful = (inserts) => (inserts || []).some(statefulIns);

/** Does this track's signal (or its sidechain shadow) cross ANY stateful
 * device on the way to the master file? Clause 2 + 3 of the header rule. */
export function trackStatefulPath(doc, track) {
  if (chainStateful(track.inserts)) return true;
  if (chainStateful(doc.master?.inserts)) return true;
  for (const s of track.sends || []) {
    const r = (doc.returns || []).find((x) => x.id === s.to);
    if (r && chainStateful(r.inserts)) return true;
  }
  // Return compressors read the same dry sidechain bus as track compressors.
  // Their earlier key events must remain in later jobs and region hashes too.
  for (const o of [...(doc.tracks || []), ...(doc.returns || [])]) {
    for (const i of o.inserts || []) {
      if (i.enabled !== false && i.type === "compressor" && i.params?.sidechain === track.id) return true;
    }
  }
  return false;
}

/** The reach a note on this track adds beyond the P0 tail:
 * { back, fwd } seconds — fwd Infinity when state is in the path. */
export function mixerFutureSeconds(doc) {
  const chain = (rows) => (rows || []).reduce((seconds, i) => {
    if (i.enabled === false || !["limiter", "maximizer"].includes(i.type)) return seconds;
    const p = i.params?.lookahead_ms ?? 5;
    const values = typeof p === "object" ? (p.keys || []).map((k) => Number(k.v)) : [Number(p)];
    const v = Math.max(...(values.length ? values : [5]));
    return seconds + 2 * Math.min(10, Math.max(1, v)) / 1000 + 0.002;
  }, 0);
  const returns = Object.fromEntries((doc.returns || []).map((r) => [r.id, chain(r.inserts)]));
  const paths = (doc.tracks || []).map((t) => chain(t.inserts)
    + Math.max(0, ...(t.sends || []).map((s) => returns[s.to] || 0)));
  return Math.max(0, ...paths) + chain(doc.master?.inserts);
}

export function mixerReach(doc, track) {
  if (isDefaultMixer(doc)) return { back: 0, fwd: 0 };
  return trackStatefulPath(doc, track)
    ? { back: Math.max(0.02, mixerFutureSeconds(doc)), fwd: Infinity } : { back: 0, fwd: 0 };
}

/* Signatures are JSON over normalised structures our own migrate wrote, so
 * key order is deterministic. A fully-default piece signs as "" so the
 * default mixer adds nothing anywhere. */
const sigAuto = (v) => (isKeyed(v) ? JSON.stringify(v.keys) : String(v ?? 0));

export function trackMixSig(t) {
  const def = !(t.inserts || []).length && !(t.sends || []).length
    && defAuto(t.fader) && defAuto(t.pan);
  if (def) return "";
  return JSON.stringify({
    i: t.inserts || [],
    f: sigAuto(t.fader), p: sigAuto(t.pan),
    s: (t.sends || []).map((s) => ({ to: s.to, l: sigAuto(s.level), pre: !!s.pre })),
  });
}

export const returnMixSig = (r) => JSON.stringify({
  i: r.inserts || [], f: sigAuto(r.fader), p: sigAuto(r.pan),
});

export const masterMixSig = (m) => (
  !(m?.inserts || []).length && defAuto(m?.fader) && m?.stereo !== true ? ""
    : JSON.stringify({ i: m.inserts || [], f: sigAuto(m.fader),
                       ...(m.stereo === true ? { s: 1 } : {}) })
);

/** Everything regionHashes folds in, precomputed once per hash pass.
 * Null when the mixer is fully default — the P0-bytes-preserved case. */
export function mixerSigBundle(doc) {
  if (isDefaultMixer(doc)) return null;
  const tracks = {}, sendTargets = {};
  for (const t of doc.tracks || []) {
    tracks[t.id] = trackMixSig(t);
    sendTargets[t.id] = (t.sends || []).map((s) => s.to).sort();
  }
  const returns = {};
  for (const r of doc.returns || []) returns[r.id] = returnMixSig(r);
  // Retire cached regions rendered before the limiter could see their end.
  const context = mixerFutureSeconds(doc) > 0 ? "|future-context:1" : "";
  return { tracks, sendTargets, returns, master: masterMixSig(doc.master) + context };
}

/* ─────────────────────────────── the render boundary: bars → seconds */

function barToSec(rows, bar) {
  const b = Math.max(1, Number(bar) || 1);
  const i = Math.max(0, Math.min(Math.floor(b), rows.length) - 1);
  const row = rows[i];
  return row.sec + (b - row.bar) * row.secLen;
}

/** number stays a number; { keys } gets its float-bar times turned into
 * seconds — the only place automation meets the clock. */
function autoToSeconds(v, rows) {
  if (!isKeyed(v)) return v;
  return { keys: v.keys.map((k) => ({ ...k, t: barToSec(rows, k.t) })) };
}

const insertsToSeconds = (list, rows) => (list || []).map((i) => ({
  ...i,
  params: Object.fromEntries(Object.entries(i.params || {})
    .map(([k, v]) => [k, autoToSeconds(v, rows)])),
}));

/** The `mixer` object a render/meters job carries. Audible tracks only —
 * solo/mute already decided which notes exist, this must agree. */
export function mixerJobPayload(doc, rows = null) {
  rows = rows || buildTimeline(doc);
  const tracks = {};
  for (const t of doc.tracks || []) {
    if (!mixerAudible(doc, t)) continue;
    tracks[t.id] = {
      inserts: insertsToSeconds(t.inserts, rows),
      fader: autoToSeconds(t.fader, rows),
      pan: autoToSeconds(t.pan, rows),
      sends: (t.sends || []).map((s) => ({
        to: s.to, level: autoToSeconds(s.level, rows), pre: !!s.pre,
      })),
    };
  }
  return {
    tracks,
    returns: (doc.returns || []).map((r) => ({
      id: r.id,
      inserts: insertsToSeconds(r.inserts, rows),
      fader: autoToSeconds(r.fader, rows),
      pan: autoToSeconds(r.pan, rows),
    })),
    master: {
      inserts: insertsToSeconds(doc.master?.inserts, rows),
      fader: autoToSeconds(doc.master?.fader, rows),
    },
    /* rack.stereo_on reads exactly this key, and only a literal true. */
    stereo: stereoOn(doc),
    spq: doc.tempoMap.map((e) => [barToSec(rows, e.atBar), 60 / e.bpm]),
  };
}

/** The JS twin of the engine-side evaluation, for anything that wants to
 * draw an automation curve without a render: value at float-bar `t`. */
export function autoValueAt(v, t) {
  return isKeyed(v) ? evalProp(v, t) : Number(v) || 0;
}

/* ───────────────────────────────────────────── catalog parity (the two
 * tables must be one table — the TAILS pattern) */

export function catalogsAgree(engineDevices) {
  const problems = [];
  const mine = MIXER_CATALOG;
  const names = new Set([...Object.keys(mine), ...Object.keys(engineDevices || {})]);
  for (const name of names) {
    const a = mine[name], b = engineDevices?.[name];
    if (!a || !b) { problems.push(`${name}: only on one side`); continue; }
    if (!!a.stateful !== !!b.stateful) problems.push(`${name}: stateful differs`);
    const pn = new Set([...Object.keys(a.params), ...Object.keys(b.params || {})]);
    for (const p of pn) {
      const pa = a.params[p], pb = b.params?.[p];
      if (!pa || !pb) { problems.push(`${name}.${p}: only on one side`); continue; }
      if (pa.type !== pb.type) problems.push(`${name}.${p}: type differs`);
      if (pa.type === "number"
        && (pa.default !== pb.default || pa.min !== pb.min || pa.max !== pb.max)) {
        problems.push(`${name}.${p}: range/default differs`);
      }
      if (pa.type === "enum"
        && JSON.stringify(pa.values) !== JSON.stringify([...(pb.values || [])])) {
        problems.push(`${name}.${p}: enum values differ`);
      }
      if (pa.type === "bool" && !!pa.default !== !!pb.default) {
        problems.push(`${name}.${p}: default differs`);
      }
    }
  }
  return problems;
}

/* ─────────────────────────────────────────────────────── route actions
 *
 * Called from routes.js's action dispatcher BEFORE its own switch; returns
 * null for actions it does not own, a reply object for the ones it does,
 * throws for a caller error (routes.js turns that into the 400 it already
 * makes). ctx: { mutate, readProject, runEngineFast, safe, byOf }. */

function resolveChainHost(doc, ref) {
  const id = String(ref ?? "");
  if (id === "master") return { host: doc.master, kind: "master", id: "master" };
  const ret = (doc.returns || []).find((r) => r.id === id || r.name === id);
  if (ret) return { host: ret, kind: "return", id: ret.id };
  const t = findTrack(doc, id);         // throws with the full track list
  return { host: t, kind: "track", id: t.id };
}

function findInsert(host, ref) {
  const id = String(ref ?? "");
  const ins = (host.inserts || []).find((i) => i.id === id);
  if (ins) return ins;
  throw new Error(`No such insert: ${id}. This chain has ${(host.inserts || [])
    .map((i) => `${i.id} (${i.type})`).join(", ") || "no inserts"}.`);
}

const chainOut = (host) => (host.inserts || []).map((i) => ({
  id: i.id, type: i.type, enabled: i.enabled,
}));

export async function handleMixerAction(action, b, ctx) {
  const { mutate, readProject, runEngineFast, safe } = ctx;
  const slug = safe(b.slug);

  switch (action) {
    case "insert_add": {
      const type = String(b.type || "");
      if (!MIXER_CATALOG[type]) {
        throw new Error(`Unknown device "${type}". The rack has: ${Object.keys(MIXER_CATALOG).join(", ")}.`);
      }
      const m = await mutate(slug, b, "insert_add", (d) => {
        const { host, id } = resolveChainHost(d, b.target);
        host.inserts = host.inserts || [];
        if (host.inserts.length >= MIXER_LIMITS.insertsPerChain) {
          throw new Error(`This chain already has ${MIXER_LIMITS.insertsPerChain} inserts.`);
        }
        const ins = {
          id: newId("ins"), type,
          enabled: b.enabled !== false,
          params: normParams(type, b.params),
        };
        const at = b.index === undefined
          ? host.inserts.length
          : Math.max(0, Math.min(Math.round(Number(b.index)), host.inserts.length));
        host.inserts.splice(at, 0, ins);
        return { insertId: ins.id, target: id, chain: chainOut(host),
                 ledger: { detail: `${type} on ${id}` } };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "insert_set": {
      const m = await mutate(slug, b, "insert_set", (d) => {
        const { host, id } = resolveChainHost(d, b.target);
        const ins = findInsert(host, b.insert);
        if (b.params !== undefined) {
          ins.params = normParams(ins.type, { ...ins.params, ...b.params });
        }
        if (b.enabled !== undefined) ins.enabled = !!b.enabled;
        if (b.index !== undefined) {
          const from = host.inserts.indexOf(ins);
          host.inserts.splice(from, 1);
          const at = Math.max(0, Math.min(Math.round(Number(b.index)), host.inserts.length));
          host.inserts.splice(at, 0, ins);
        }
        return { insert: ins, target: id, chain: chainOut(host) };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "insert_remove": {
      const m = await mutate(slug, b, "insert_remove", (d) => {
        const { host, id } = resolveChainHost(d, b.target);
        const ins = findInsert(host, b.insert);
        host.inserts = host.inserts.filter((i) => i.id !== ins.id);
        return { removed: ins.id, target: id, chain: chainOut(host),
                 ledger: { detail: `${ins.type} off ${id}` } };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "mixer_set": {
      const m = await mutate(slug, b, "mixer_set", (d) => {
        const { host, kind, id } = resolveChainHost(d, b.target);
        if (b.fader !== undefined) {
          host.fader = normAuto(b.fader, 0, MIXER_LIMITS.faderDb[0], MIXER_LIMITS.faderDb[1], "fader");
        }
        if (b.pan !== undefined) {
          if (kind === "master") throw new Error("The master has no pan — it is the room.");
          host.pan = normAuto(b.pan, 0, -1, 1, "pan");
        }
        if (b.solo !== undefined) {
          if (kind !== "track") throw new Error("Only tracks solo.");
          host.solo = !!b.solo;
        }
        /* The master's two rack/bounce settings — one door with the fader. */
        if (b.stereo !== undefined) {
          if (kind !== "master") throw new Error("`stereo` is the master's switch: target \"master\".");
          if (b.stereo === true || b.stereo === "true") host.stereo = true;
          else delete host.stereo;
        }
        if (b.target_lufs !== undefined) {
          if (kind !== "master") throw new Error("`target_lufs` is the master's setting: target \"master\".");
          if (b.target_lufs === null || b.target_lufs === "" || b.target_lufs === false) delete host.target_lufs;
          else if (!Number.isFinite(Number(b.target_lufs))) throw new Error("target_lufs must be a number of LUFS, or null to switch the stage off.");
          else host.target_lufs = clampLufs(b.target_lufs);
        }
        return { target: id, kind,
                 fader: host.fader, pan: host.pan ?? null, solo: host.solo ?? null,
                 ...(kind === "master" ? { stereo: host.stereo === true, target_lufs: host.target_lufs ?? null } : {}),
                 ...(b.stereo !== undefined || b.target_lufs !== undefined
                   ? { ledger: { detail: `master ${b.stereo !== undefined ? `stereo ${host.stereo === true ? "on" : "off"}` : ""}`
                       + `${b.target_lufs !== undefined ? ` target ${host.target_lufs ?? "off"} LUFS` : ""}`.trim() } } : {}) };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "send_set": {
      const m = await mutate(slug, b, "send_set", (d) => {
        const t = findTrack(d, b.track);
        const ret = (d.returns || []).find((r) => r.id === String(b.to) || r.name === String(b.to));
        if (!ret) {
          throw new Error(`No such return: ${b.to}. Returns: ${(d.returns || [])
            .map((r) => `${r.id} (${r.name})`).join(", ") || "none — return_add first"}.`);
        }
        t.sends = t.sends || [];
        let s = t.sends.find((x) => x.to === ret.id);
        if (!s) {
          if (t.sends.length >= MIXER_LIMITS.sendsPerTrack) {
            throw new Error(`Track ${t.id} already has ${MIXER_LIMITS.sendsPerTrack} sends.`);
          }
          s = { to: ret.id, level: 0, pre: false };
          t.sends.push(s);
        }
        if (b.level !== undefined) {
          s.level = normAuto(b.level, 0, MIXER_LIMITS.sendDb[0], MIXER_LIMITS.sendDb[1], "send level");
        }
        if (b.pre !== undefined) s.pre = !!b.pre;
        return { track: t.id, send: s, ledger: { detail: `${t.id} → ${ret.id}` } };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "send_remove": {
      const m = await mutate(slug, b, "send_remove", (d) => {
        const t = findTrack(d, b.track);
        const before = (t.sends || []).length;
        t.sends = (t.sends || []).filter((s) => s.to !== String(b.to));
        if (t.sends.length === before) {
          throw new Error(`Track ${t.id} has no send to ${b.to}. Its sends: ${
            (t.sends || []).map((s) => s.to).join(", ") || "none"}.`);
        }
        return { track: t.id, sends: t.sends };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "return_add": {
      const m = await mutate(slug, b, "return_add", (d) => {
        d.returns = d.returns || [];
        if (d.returns.length >= MIXER_LIMITS.returns) {
          throw new Error(`This project already has ${MIXER_LIMITS.returns} returns.`);
        }
        const r = {
          id: newId("ret"),
          name: String(b.name || `Return ${String.fromCharCode(65 + d.returns.length)}`).slice(0, 80),
          inserts: [], fader: 0, pan: 0,
        };
        d.returns.push(r);
        return { returnId: r.id, name: r.name, ledger: { detail: r.name } };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "return_remove": {
      const m = await mutate(slug, b, "return_remove", (d) => {
        const id = String(b.return ?? "");
        const r = (d.returns || []).find((x) => x.id === id || x.name === id);
        if (!r) {
          throw new Error(`No such return: ${id}. Returns: ${(d.returns || [])
            .map((x) => `${x.id} (${x.name})`).join(", ") || "none"}.`);
        }
        d.returns = d.returns.filter((x) => x.id !== r.id);
        let cut = 0;
        for (const t of d.tracks) {
          const n = (t.sends || []).length;
          t.sends = (t.sends || []).filter((s) => s.to !== r.id);
          cut += n - t.sends.length;
        }
        return { removed: r.id, sendsRemoved: cut, ledger: { detail: r.name } };
      });
      return { ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty, ...stripLedger(m.extra) };
    }

    case "meters": {
      const doc = slug && await readProject(slug);
      if (!doc) throw new Error("No such project.");
      const fromBar = b.from_bar === undefined ? 1
        : Math.max(1, Math.min(Math.round(Number(b.from_bar)), doc.lengthBars));
      const toBar = b.to_bar === undefined ? doc.lengthBars
        : Math.max(fromBar, Math.min(Math.round(Number(b.to_bar)), doc.lengthBars));
      const job = metersJob(doc, fromBar, toBar, ctx.noteEvents, ctx.buildTimeline,
                            slug, ctx.audioJobClips);
      const r = await runEngineFast("meters", job, 180_000);
      const nameOf = Object.fromEntries(doc.tracks.map((t) => [t.id, t.name]));
      const retName = Object.fromEntries((doc.returns || []).map((x) => [x.id, x.name]));
      return {
        ok: true, fromBar, toBar, sr: doc.sr, engine: r.engine,
        master: r.master,
        tracks: Object.fromEntries(Object.entries(r.tracks || {})
          .map(([id, v]) => [id, { name: nameOf[id] ?? id, ...v }])),
        returns: Object.fromEntries(Object.entries(r.returns || {})
          .map(([id, v]) => [id, { name: retName[id] ?? id, ...v }])),
        ms: r.ms,
      };
    }

    /* ══ THE MASTERING SUITE (agent/master) ═════════════════════════════
     * Four read-only actions. They MUTATE NOTHING -- no document write, no
     * ledger entry, no dirty regions -- so they share this dispatcher for
     * the job builder and the engine lane and nothing else. Each one is a
     * thin shell over an engine mode in server/daw/master.py, which is
     * where the maths and the payload shape are documented. */

    case "analyze": {
      const { doc, job, fromBar, toBar } = await analysisJob(action, b, ctx);
      if (b.file) job.file = String(b.file);
      if (b.goniometer === false) job.goniometer = false;
      if (b.device && typeof b.device === "object") {
        const type = String(b.device.type || "");
        if (!MIXER_CATALOG[type]) {
          throw new Error(`device.type "${type}" is not in the rack. It has: ${Object.keys(MIXER_CATALOG).join(", ")}.`);
        }
        job.device = { type, params: normParams(type, b.device.params) };
      }
      const r = await runEngineFast("analyze", job, 600_000);
      return { ok: true, slug: doc?.slug, fromBar, toBar, engine: r.engine, ...r };
    }

    case "device_response": {
      /* Either an EXPLICIT (type, params) pair, or a LIVE insert named by
       * slug/target/insert -- the EQ panel wants the curve of the device
       * the user is actually turning, and looking its params up here means
       * the client never has to send them back. */
      let type = String(b.type || "");
      let params = b.params;
      if (b.slug && b.insert) {
        const doc = await readProject(safe(b.slug));
        if (!doc) throw new Error("No such project.");
        const { host } = resolveChainHost(doc, b.target);
        const ins = findInsert(host, b.insert);
        type = ins.type;
        params = ins.params;
      }
      if (!MIXER_CATALOG[type]) {
        throw new Error(`Unknown device "${type}". The rack has: ${Object.keys(MIXER_CATALOG).join(", ")}.`);
      }
      const r = await runEngineFast("device_response", {
        type, params: normParams(type, params), sr: 48000,
        points: b.points === undefined ? undefined : clamp(Math.round(Number(b.points)), 32, 2048),
      }, 60_000);
      return { ok: true, engine: r.engine, ...r };
    }

    case "reference": {
      if (!b.reference) {
        throw new Error("reference: give `reference` — a server-local audio file to compare the master against.");
      }
      const { doc, job, fromBar, toBar } = await analysisJob(action, b, ctx);
      if (b.file) job.file = String(b.file);
      job.reference = String(b.reference);
      if (b.match) job.match = String(b.match);
      const r = await runEngineFast("reference", job, 600_000);
      return { ok: true, slug: doc?.slug, fromBar, toBar, engine: r.engine, ...r };
    }

    case "check_delivery": {
      // The same validation/plan inputs as bounce, before any render work.
      const settings = loudnessOptions(b);
      const { doc, job, fromBar, toBar } = await analysisJob(action, b, ctx);
      if (b.file) job.file = String(b.file);
      if (Array.isArray(b.targets)) job.targets = b.targets.map(String);
      if (settings.target_lufs !== null) Object.assign(job, settings);
      const r = await runEngineFast("check_delivery", job, 600_000);
      return { ok: true, slug: doc?.slug, fromBar, toBar, engine: r.engine, ...r };
    }

    case "delivery_targets": {
      const r = await runEngineFast("delivery_targets", {}, 30_000);
      return { ok: true, engine: r.engine, ...r };
    }

    default:
      return null;
  }
}

/** The window job the four analysis actions share.
 *
 * A `file` call (a bounce, a reference track) needs no project at all, so
 * the slug is optional there and the job carries only the rate; anything
 * else builds the SAME job `meters` builds, which is what keeps "what the
 * analyser measures" and "what the render writes" one thing. */
async function analysisJob(action, b, ctx) {
  const { readProject, safe } = ctx;
  if (b.file && !b.slug) {
    return { doc: null, job: { sr: 48000 }, fromBar: null, toBar: null };
  }
  const doc = await readProject(safe(b.slug));
  if (!doc) throw new Error("No such project.");
  const fromBar = b.from_bar === undefined ? 1
    : Math.max(1, Math.min(Math.round(Number(b.from_bar)), doc.lengthBars));
  const toBar = b.to_bar === undefined ? doc.lengthBars
    : Math.max(fromBar, Math.min(Math.round(Number(b.to_bar)), doc.lengthBars));
  const job = b.file
    ? { sr: doc.sr }
    : metersJob(doc, fromBar, toBar, ctx.noteEvents, ctx.buildTimeline,
                safe(b.slug), ctx.audioJobClips);
  return { doc, job, fromBar, toBar };
}

const stripLedger = ({ ledger, ...rest }) => rest;

/** The meters job for a bar window: same notes, CLIPS and mixer a render
 * would carry. Works on a default mixer too — the payload is simply
 * all-defaults.
 *
 * [DAWREC] The clips are here for the reason the params are: this job's whole
 * claim is that it measures the render the bounce makes. Without them, a
 * project whose vocal is a recorded take had that take in the wav and not in
 * a single meter, LUFS or delivery check — the analyser passing a master it
 * had never heard. `audioJobClips` is store.js's one clip-to-job mapping, and
 * it is passed in rather than imported because this module takes its document
 * helpers from the caller (routes.js) by design. */
function metersJob(doc, fromBar, toBar, noteEvents, buildRows, slug = null, audioJobClips = null) {
  const rows = buildRows(doc);
  const t0 = rows[fromBar - 1].sec;
  const last = rows[toBar - 1];
  const t1 = last.sec + last.secLen;
  const startSample = Math.round(t0 * doc.sr);
  const nSamples = Math.round(t1 * doc.sr) - startSample;
  const events = noteEvents(doc);
  const notes = events
    .filter((e) => e.reach0 < t1 && e.reach1 > t0)
    .map((e) => ({
      /* `params` as ensureRegions sends it — the track's instrument knobs.
       * Left out, meters/analyze/check_delivery measured a render the bounce
       * never made (a kick with default knobs instead of its preset). */
      inst: e.inst, params: e.params, midi: e.midi, vel: e.vel,
      start_sample: e.startSample, dur_samples: e.durSamples,
      gain_db: e.gainDb, seed: e.seed, track_id: e.trackId,
    }));
  const clips = slug && audioJobClips ? audioJobClips(doc, slug, t0, t1) : [];
  return {
    sr: doc.sr, start_sample: startSample, n_samples: nSamples,
    notes, ...(clips.length ? { audio: clips } : {}),
    mixer: mixerJobPayload(doc, rows),
  };
}

/** The action names this module owns — routes.js quotes them in its
 * unknown-action error so a caller sees ONE list. */
export const MIXER_ACTIONS = [
  "insert_add", "insert_set", "insert_remove",
  "mixer_set", "send_set", "send_remove", "return_add", "return_remove",
  "meters",
  /* the mastering suite: read-only, mutate nothing */
  "analyze", "device_response", "reference", "check_delivery", "delivery_targets",
];
