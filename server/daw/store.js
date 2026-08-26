/**
 * DAW — the project store. P0-1 of the DAW plan (daw_research REPORT §7/§14).
 *
 * One JSON document per project:
 *   <outputDir>/daw/<slug>/project.json
 *   <outputDir>/daw/<slug>/cache/        rendered bar-region audio, disposable
 *
 * SINGLE WRITER, the same discipline as server/vfx/store.js and for the same
 * reason: HTTP routes, MCP tools and a render that finishes at some arbitrary
 * moment all write here. Every mutation goes through one promise chain per
 * slug and lands via write-temp-then-rename, and updatedAt bumps MONOTONICALLY
 * (the frame-cache lesson: Date.now() has millisecond resolution, and a stale
 * region served for a fresh edit is the worst failure this subsystem has).
 *
 * ── TIME IS MUSICAL, §12 of the report — the day-one requirement ──────────
 *
 * Meter and tempo are FIRST-CLASS EVENT LISTS on the project; a bar is a
 * DERIVED object. Nothing in this file, the routes, or the MCP tools assumes
 * bars are equal length or four beats. Seconds exist only at the render
 * boundary (regionsOf / posToSeconds, called when a job is built).
 *
 *   meterMap: [{ atBar: 1, num: 4, den: 4 }, { atBar: 17, num: 7, den: 8 }]
 *   tempoMap: [{ atBar: 1, bpm: 120 }]           bpm is QUARTER-NOTE bpm
 *
 * A position is `{ bar, beat, tick }`: bar and beat 1-based, tick 0..959.
 * TICKS_PER_BEAT = 960 where a BEAT is the meter's DENOMINATOR unit — a
 * quarter in 4/4, an eighth in 7/8 — so `bar 3, beat 2` always names what a
 * musician counting the bar would call "two", and a 7/8 bar has exactly 7
 * beats of 960 ticks. Tempo, by contrast, is pinned to the QUARTER NOTE (the
 * MIDI SMF convention): 120 bpm means quarters last 500 ms in every meter, so
 * a 4/4→7/8 change does not silently halve the pulse. The two conventions
 * meet in one line: a beat in x/den lasts (4/den) quarters.
 *
 * Durations (`durTicks`) are in ticks of the LOCAL beat unit and are walked
 * through the meter map bar by bar, so a note that crosses a meter change is
 * exactly as long as the bars it crosses say it is.
 *
 * ── DIRTY REGIONS ARE CONTENT HASHES ──────────────────────────────────────
 *
 * The render is chunked into fixed REGION_BARS-bar regions. Each region's
 * identity is a sha1 over everything that can reach its samples: the region's
 * absolute sample window, and every note whose SOUNDING interval — start to
 * end-plus-instrument-tail — intersects it, with the note's absolute sample
 * placement, pitch, velocity, instrument, track gain and seed. An edit in bar
 * 9 changes only the hashes of the regions bar 9's sound can reach; every
 * other region keeps its hash and therefore its cache file. There is no
 * separate "mark dirty" bookkeeping to drift out of sync with the truth —
 * the hash IS the dirty bit, and diffing hashes before/after a mutation is
 * how the routes answer "what did this edit touch".
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { config } from "../config.js";
/* CHAIN STAGE (agent/dawrack): the mixer model lives in mixer.js — this file
 * only calls its migrate/audibility/reach/signature hooks so the dirty-region
 * truth stays in one place. A fully default mixer must leave every hash
 * byte-identical to P0's; mixer_test.js pins that. */
import {
  migrateTrackMixer, migrateDocMixer, mixerAudible, mixerReach, mixerSigBundle,
} from "./mixer.js";

export const DAW_DIR = () => path.join(config.outputDir, "daw");
export const projectDir = (slug) => path.join(DAW_DIR(), slug);
export const cacheDir = (slug) => path.join(projectDir(slug), "cache");
/* [DAWREC] where a project's recorded takes, imports and comps live —
 * write-once files (tk_/imp_/cmp_ names are minted, never reused), so the
 * file NAME is the content identity the region hasher leans on. */
export const audioDir = (slug) => path.join(projectDir(slug), "audio");
const docPath = (slug) => path.join(projectDir(slug), "project.json");

/** Document version. Bump only with a migration in `migrate()`. */
export const DOC_VERSION = 1;

/* ─────────────────────────────────────────────── the vocabulary and limits */

export const TICKS_PER_BEAT = 960;
export const SR = 48000;               // the render boundary's sample rate
export const REGION_BARS = 4;          // the dirty-render chunk, ≤ the 1 s gate's range

/* ── THE PATCH TABLE — server/daw/patches.json, read by BOTH sides ────────
 *
 * One manifest is the whole vocabulary: registry rows (family, label,
 * licence, attribution) AND engine facts (backend kind, file, tail).
 * server/daw/instruments.py reads the same file, so a patch added on one
 * side only cannot exist; engine.py's probe reports the python view
 * (patch_tails) and the e2e holds the two views to byte-equality. */
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PATCH_MANIFEST = JSON.parse(
  readFileSync(path.join(HERE_DIR, "patches.json"), "utf8"));
export const PATCHES = PATCH_MANIFEST.patches;

/** Patch ids a track may hold: everything that can render. `generate` rows
 * exist in the registry so the gap has a name, but refuse assignment with
 * their own honest message (routes surface it). */
export const PATCH_IDS = Object.keys(PATCHES).filter((p) => PATCHES[p].kind !== "generate");

/** The P0 prototype synths — still first-class patches (zero-download sound). */
export const INSTRUMENTS = Object.keys(PATCHES).filter((p) => PATCHES[p].kind === "builtin");

/**
 * How long each patch can still be heard AFTER its note ends, seconds.
 * This is the region hasher's reach: a note in bar 4 whose tail crosses into
 * bar 5 must dirty bar 5's region too. Derived from the manifest — the same
 * numbers instruments.py gates every voice to (the seam-equality proof
 * depends on a voice being EXACTLY silent past this bound); probe reports
 * the python view so the e2e can assert the two tables agree.
 */
export const TAILS = Object.fromEntries(
  PATCH_IDS.map((p) => [p, PATCHES[p].tail]));

/** Instrument params a track may carry — anything else is dropped on write.
 * These reach the engine per note and are part of every region hash. */
export function normParams(params, patch) {
  const src = params && typeof params === "object" ? params : {};
  const out = {};
  if (src.transpose !== undefined) {
    const t = clampInt(num(src.transpose, 0), -48, 48);
    if (t) out.transpose = t;
  }
  if (src.gain_db !== undefined) {
    const g = clamp(num(src.gain_db, 0), -24, 24);
    if (g) out.gain_db = g;
  }
  if (PATCHES[patch]?.gm_programs) {
    if (src.program !== undefined) out.program = clampInt(num(src.program, 0), 0, 127);
    if (src.drum_kit) out.drum_kit = true;
  }
  return out;
}

export const LIMITS = {
  lengthBars: 256,
  tracks: 32,
  clipsPerTrack: 64,
  notesPerClip: 4096,
  meterNum: [1, 32],
  meterDen: [1, 2, 4, 8, 16, 32],       // the legal denominators
  bpm: [20, 400],
  pitch: [0, 127],
  vel: [1, 127],
  durTicks: [1, TICKS_PER_BEAT * 256],
  gainDb: [-48, 12],
  ledger: 300,
  /* [DAWREC] the capture additions. shiftSamples is the fine (sub-tick)
   * placement: latency compensation and sample-anchored comps both live
   * there, bounded at ±1 h of project audio (a comp anchored at 1.1.0
   * carries its whole absolute start in the shift, so the bound must cover
   * the longest legal project, not just a latency offset). */
  audioClipsPerTrack: 64,
  takesPerTrack: 64,
  shiftSamples: [-3600 * SR, 3600 * SR],
};

/* ─────────────────────────────────────────────────────────────── identity */

export function slugify(title) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "untitled";
}

export const newId = (prefix, n = 4) =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, n)}`;

export const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi);
export const clampInt = (v, lo, hi) => Math.round(clamp(v, lo, hi));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/* ─────────────────────────────────────────────────────── blank documents */

export function blankProject(name, opts = {}) {
  const now = Date.now();
  const title = String(name || "Untitled").slice(0, 80);
  return {
    v: DOC_VERSION,
    id: newId("prj", 6),
    slug: slugify(title),
    name: title,
    sr: SR,
    lengthBars: clampInt(num(opts.lengthBars, 16), 1, LIMITS.lengthBars),
    meterMap: [{
      atBar: 1,
      num: clampInt(num(opts.num, 4), LIMITS.meterNum[0], LIMITS.meterNum[1]),
      den: LIMITS.meterDen.includes(Number(opts.den)) ? Number(opts.den) : 4,
    }],
    tempoMap: [{ atBar: 1, bpm: clamp(num(opts.bpm, 120), LIMITS.bpm[0], LIMITS.bpm[1]) }],
    tracks: [],
    /* CHAIN STAGE: return tracks and the master chain (mixer.js migrates). */
    returns: [],
    master: { inserts: [], fader: 0 },
    /* Every mutation appends here with its author — `by: "agent" | "user"` —
     * the dual-control ledger §13a asks for. Stored, shown nowhere yet. */
    ledger: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function blankTrack(name, instrument, patch = {}) {
  const pid = typeof instrument === "object" ? instrument?.patch : instrument;
  const chosen = PATCH_IDS.includes(pid) ? pid : "pluck";
  return {
    id: newId("trk"),
    name: String(name || chosen || "track").slice(0, 80),
    /* A track's instrument is { patch, params }: the patch id from the
     * registry plus per-track params (transpose, gain_db, and program/
     * drum_kit for the GM bank). Both halves reach the engine per note and
     * both are hashed — an instrument change dirties what it re-voices. */
    instrument: {
      patch: chosen,
      params: normParams(typeof instrument === "object" ? instrument?.params : patch.params, chosen),
    },
    gainDb: 0,
    mute: false,
    /* CHAIN STAGE: the mixer strip (mixer.js owns the shapes and limits). */
    inserts: [],
    fader: 0,
    pan: 0,
    solo: false,
    sends: [],
    clips: [],
    /* [DAWREC] the capture surfaces. armed is transport state (never hashed,
     * never dirties a region); audioClips render, takes only audition. */
    armed: false,
    audioClips: [],
    takes: [],
    ...patch,
  };
}

/**
 * [DAWREC] An audio clip: a file placed on the timeline. Placement is one
 * formula everywhere —
 *
 *   startSample = round(posToSeconds({bar,beat,tick}) * sr) + shiftSamples
 *
 * — a MUSICAL anchor plus a SIGNED sample shift. A recorded take's clip uses
 * the anchor it was recorded at and shift = −(calibrated latency); an import
 * uses the anchor it was dropped at and shift 0; a comp anchors at 1.1.0 and
 * carries its absolute start in the shift. offsetSamples trims into the
 * file; durSamples is how much of it plays (stamped from the decode at
 * creation — the store never opens audio files).
 */
export function blankAudioClip(file, patch = {}) {
  const c = {
    id: newId("aud", 6),
    name: "audio",
    file: String(file),
    bar: 1, beat: 1, tick: 0,
    shiftSamples: 0,
    offsetSamples: 0,
    durSamples: 1,
    gainDb: 0,
    ...patch,
  };
  c.name = String(c.name || "audio").slice(0, 80);
  c.by = patch.by === "agent" ? "agent" : "user";
  return c;
}

/** [DAWREC] A take: a captured lane entry. Same placement formula as a clip;
 * takes never render into the mix — they audition, and comps flatten them. */
export function blankTake(file, patch = {}) {
  const t = {
    id: newId("tk", 6),
    name: "take",
    file: String(file),
    bar: 1, beat: 1, tick: 0,
    shiftSamples: 0,
    samples: 0,
    sr: SR,
    device: "",
    recordedAt: Date.now(),
    ...patch,
  };
  t.name = String(t.name || "take").slice(0, 80);
  t.device = String(t.device || "").slice(0, 120);
  t.by = patch.by === "agent" ? "agent" : "user";
  return t;
}

export function blankClip(fromBar, toBar, patch = {}) {
  return {
    id: newId("clp"),
    name: String(patch.name || "clip").slice(0, 80),
    fromBar: Math.max(1, Math.round(fromBar)),
    toBar: Math.max(1, Math.round(toBar)),
    notes: [],
  };
}

/* ──────────────────────────────────────────── the single-writer queue */

const chains = new Map();

function enqueue(slug, fn) {
  const prev = chains.get(slug) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(slug, next.then(() => {}, () => {}));
  return next;
}

async function writeDoc(slug, doc) {
  await mkdir(projectDir(slug), { recursive: true });
  const tmp = docPath(slug) + `.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await rename(tmp, docPath(slug));
  return doc;
}

/* ─────────────────────────────────────────────────────────────── migrate */

/**
 * Repair rather than reject, the house rule: a project with one malformed
 * note should open with that note sane, not refuse to open at all. What
 * cannot be repaired (a missing id) is minted; nonsense falls back.
 * Normalised FIELD-BY-FIELD, never by rebuilding the doc from a key list —
 * that is how five fields have been silently erased in this repo before.
 */
export function migrate(doc) {
  if (!doc || typeof doc !== "object") return null;
  doc.v = DOC_VERSION;
  doc.id ||= newId("prj", 6);
  doc.name = String(doc.name ?? "Untitled").slice(0, 80);
  doc.slug ||= slugify(doc.name);
  doc.sr = SR;                                 // one rate; not negotiable in v0
  doc.lengthBars = clampInt(num(doc.lengthBars, 16), 1, LIMITS.lengthBars);

  /* The meter map: sorted, deduplicated by bar, and ALWAYS anchored at bar 1 —
   * a map whose first event is at bar 5 leaves bars 1-4 meterless, which is
   * not a meter map, it is a bug the whole timeline would be derived from. */
  doc.meterMap = normalizeMeterMap(doc.meterMap);
  doc.tempoMap = normalizeTempoMap(doc.tempoMap);

  if (!Array.isArray(doc.ledger)) doc.ledger = [];
  doc.ledger = doc.ledger.slice(0, LIMITS.ledger);

  if (!Array.isArray(doc.tracks)) doc.tracks = [];
  doc.tracks = doc.tracks.filter(Boolean).slice(0, LIMITS.tracks).map((t) => migrateTrack(t, doc));

  migrateDocMixer(doc);                     // CHAIN STAGE: returns + master

  doc.createdAt = num(doc.createdAt, Date.now());
  doc.updatedAt = num(doc.updatedAt, doc.createdAt);
  return doc;
}

export function normalizeMeterMap(list) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((m) => m && Number.isFinite(Number(m.atBar)))
    .map((m) => ({
      atBar: Math.max(1, Math.round(Number(m.atBar))),
      num: clampInt(num(m.num, 4), LIMITS.meterNum[0], LIMITS.meterNum[1]),
      den: LIMITS.meterDen.includes(Number(m.den)) ? Number(m.den) : 4,
    }))
    .sort((a, b) => a.atBar - b.atBar);
  const dedup = [];
  for (const r of rows) {
    if (dedup.length && dedup[dedup.length - 1].atBar === r.atBar) dedup[dedup.length - 1] = r;
    else dedup.push(r);
  }
  if (!dedup.length || dedup[0].atBar !== 1) dedup.unshift({ atBar: 1, num: 4, den: 4 });
  return dedup;
}

export function normalizeTempoMap(list) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((m) => m && Number.isFinite(Number(m.atBar)))
    .map((m) => ({
      atBar: Math.max(1, Math.round(Number(m.atBar))),
      bpm: clamp(num(m.bpm, 120), LIMITS.bpm[0], LIMITS.bpm[1]),
    }))
    .sort((a, b) => a.atBar - b.atBar);
  const dedup = [];
  for (const r of rows) {
    if (dedup.length && dedup[dedup.length - 1].atBar === r.atBar) dedup[dedup.length - 1] = r;
    else dedup.push(r);
  }
  if (!dedup.length || dedup[0].atBar !== 1) dedup.unshift({ atBar: 1, bpm: 120 });
  return dedup;
}

function migrateTrack(t, doc) {
  t.id ||= newId("trk");
  t.name = String(t.name ?? "track").slice(0, 80);
  /* P0 documents stored a bare string; the palette stores { patch, params }.
   * Repair either shape; an unknown patch falls back to the P0 pluck. */
  const pid = typeof t.instrument === "object" && t.instrument
    ? t.instrument.patch : t.instrument;
  t.instrument = {
    patch: PATCH_IDS.includes(pid) ? pid : "pluck",
    params: normParams(typeof t.instrument === "object" ? t.instrument?.params : undefined,
      PATCH_IDS.includes(pid) ? pid : "pluck"),
  };
  t.gainDb = clamp(num(t.gainDb, 0), LIMITS.gainDb[0], LIMITS.gainDb[1]);
  t.mute = !!t.mute;
  migrateTrackMixer(t);                     // CHAIN STAGE: inserts/fader/pan/sends
  if (!Array.isArray(t.clips)) t.clips = [];
  t.clips = t.clips.filter(Boolean).slice(0, LIMITS.clipsPerTrack).map((c) => migrateClip(c, doc));
  /* [DAWREC] the capture fields, same repair-not-reject rule. A clip or take
   * whose file name is unusable is dropped — a row that cannot name its
   * samples names nothing. */
  t.armed = !!t.armed;
  if (!Array.isArray(t.audioClips)) t.audioClips = [];
  t.audioClips = t.audioClips.filter((c) => c && typeof c.file === "string" && c.file)
    .slice(0, LIMITS.audioClipsPerTrack).map((c) => migrateAudioClip(c));
  if (!Array.isArray(t.takes)) t.takes = [];
  t.takes = t.takes.filter((k) => k && typeof k.file === "string" && k.file)
    .slice(0, LIMITS.takesPerTrack).map((k) => migrateTake(k));
  return t;
}

/* [DAWREC] */
function migrateAudioClip(c) {
  c.id ||= newId("aud", 6);
  c.name = String(c.name ?? "audio").slice(0, 80);
  c.file = String(c.file);
  c.bar = Math.max(1, Math.round(num(c.bar, 1)));
  c.beat = Math.max(1, Math.round(num(c.beat, 1)));
  c.tick = clampInt(num(c.tick, 0), 0, TICKS_PER_BEAT - 1);
  c.shiftSamples = clampInt(num(c.shiftSamples, 0), LIMITS.shiftSamples[0], LIMITS.shiftSamples[1]);
  c.offsetSamples = Math.max(0, Math.round(num(c.offsetSamples, 0)));
  c.durSamples = Math.max(1, Math.round(num(c.durSamples, 1)));
  c.gainDb = clamp(num(c.gainDb, 0), LIMITS.gainDb[0], LIMITS.gainDb[1]);
  c.by = c.by === "agent" ? "agent" : "user";
  return c;
}

/* [DAWREC] */
function migrateTake(k) {
  k.id ||= newId("tk", 6);
  k.name = String(k.name ?? "take").slice(0, 80);
  k.file = String(k.file);
  k.bar = Math.max(1, Math.round(num(k.bar, 1)));
  k.beat = Math.max(1, Math.round(num(k.beat, 1)));
  k.tick = clampInt(num(k.tick, 0), 0, TICKS_PER_BEAT - 1);
  k.shiftSamples = clampInt(num(k.shiftSamples, 0), LIMITS.shiftSamples[0], LIMITS.shiftSamples[1]);
  k.samples = Math.max(0, Math.round(num(k.samples, 0)));
  k.sr = Math.max(1, Math.round(num(k.sr, SR)));
  k.device = String(k.device ?? "").slice(0, 120);
  k.by = k.by === "agent" ? "agent" : "user";
  k.recordedAt = num(k.recordedAt, Date.now());
  return k;
}

function migrateClip(c, doc) {
  c.id ||= newId("clp");
  c.name = String(c.name ?? "clip").slice(0, 80);
  c.fromBar = clampInt(num(c.fromBar, 1), 1, LIMITS.lengthBars);
  c.toBar = clampInt(num(c.toBar, c.fromBar), c.fromBar, LIMITS.lengthBars);
  if (!Array.isArray(c.notes)) c.notes = [];
  c.notes = c.notes.filter(Boolean).slice(0, LIMITS.notesPerClip).map((n) => ({
    id: n.id || newId("nt", 6),
    bar: Math.max(1, Math.round(num(n.bar, c.fromBar))),
    beat: Math.max(1, Math.round(num(n.beat, 1))),
    tick: clampInt(num(n.tick, 0), 0, TICKS_PER_BEAT - 1),
    durTicks: clampInt(num(n.durTicks, TICKS_PER_BEAT), LIMITS.durTicks[0], LIMITS.durTicks[1]),
    pitch: clampInt(num(n.pitch, 60), LIMITS.pitch[0], LIMITS.pitch[1]),
    vel: clampInt(num(n.vel, 100), LIMITS.vel[0], LIMITS.vel[1]),
    by: n.by === "agent" ? "agent" : "user",
  }));
  return c;
}

/* ─────────────────────────────────────────────────────────────── CRUD */

export async function readProject(slug) {
  try {
    return migrate(JSON.parse(await readFile(docPath(slug), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Read, mutate, write — atomically against every other writer of this slug.
 * `fn` mutates in place or returns a replacement; `false` abandons the write.
 * updatedAt is MONOTONIC, not merely current — see the header.
 */
export async function updateProject(slug, fn) {
  return enqueue(slug, async () => {
    const doc = await readProject(slug);
    if (!doc) throw new Error(`No such project: ${slug}`);
    const out = await fn(doc);
    if (out === false) return doc;
    const next = out && typeof out === "object" ? out : doc;
    next.updatedAt = Math.max(Date.now(), (doc.updatedAt || 0) + 1);
    return writeDoc(slug, next);
  });
}

export async function createProject(name, opts = {}) {
  const doc = blankProject(name, opts);
  let slug = doc.slug, n = 2;
  while (await readProject(slug)) slug = `${doc.slug}-${n++}`;
  doc.slug = slug;
  return enqueue(slug, () => writeDoc(slug, doc));
}

export async function deleteProject(slug) {
  return enqueue(slug, async () => {
    await rm(projectDir(slug), { recursive: true, force: true });
    return true;
  });
}

export async function listProjects() {
  let names = [];
  try {
    names = (await readdir(DAW_DIR(), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];                                  // no daw folder yet is not an error
  }
  const rows = await Promise.all(names.map(async (slug) => {
    const doc = await readProject(slug);
    if (!doc) return null;
    return {
      slug: doc.slug, id: doc.id, name: doc.name,
      lengthBars: doc.lengthBars,
      tracks: doc.tracks.length,
      notes: doc.tracks.reduce((a, t) => a + t.clips.reduce((b, c) => b + c.notes.length, 0), 0),
      meterMap: doc.meterMap, tempoMap: doc.tempoMap,
      createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    };
  }));
  return rows.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Append a ledger entry — the dual-control audit trail. Bounded. */
export function noteLedger(doc, entry) {
  if (!Array.isArray(doc.ledger)) doc.ledger = [];
  doc.ledger.unshift({ at: Date.now(), by: entry.by === "agent" ? "agent" : "user", ...entry });
  doc.ledger = doc.ledger.slice(0, LIMITS.ledger);
  return doc;
}

/* ─────────────────────────────── finding things, by id or unambiguous name */

export function findTrack(doc, ref) {
  const id = String(ref ?? "");
  const byId = doc.tracks.find((t) => t.id === id);
  if (byId) return byId;
  const byName = doc.tracks.filter((t) => t.name === id);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`${byName.length} tracks are called "${id}" — use the id: ${byName.map((t) => t.id).join(", ")}`);
  }
  throw new Error(`No such track: ${id}. This project has ${doc.tracks.map((t) => `${t.id} (${t.name})`).join(", ") || "no tracks"}.`);
}

export function findClip(track, ref) {
  const id = String(ref ?? "");
  const clip = track.clips.find((c) => c.id === id);
  if (clip) return clip;
  throw new Error(`No such clip on ${track.id}: ${id}. It has ${track.clips.map((c) => `${c.id} (bars ${c.fromBar}-${c.toBar})`).join(", ") || "no clips"}.`);
}

/** The clip whose bar range covers `bar`, when the caller did not name one. */
export function clipCovering(track, bar) {
  const hits = track.clips.filter((c) => bar >= c.fromBar && bar <= c.toBar);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`${hits.length} clips on ${track.id} cover bar ${bar} — name one: ${hits.map((c) => c.id).join(", ")}.`);
  }
  throw new Error(`No clip on ${track.id} covers bar ${bar}. Its clips: ${track.clips.map((c) => `${c.id} (bars ${c.fromBar}-${c.toBar})`).join(", ") || "none — add_clip first"}.`);
}

export function findNote(clip, ref) {
  const id = String(ref ?? "");
  const note = clip.notes.find((n) => n.id === id);
  if (note) return note;
  throw new Error(`No such note in ${clip.id}: ${id}. It holds ${clip.notes.length} note(s).`);
}

/* [DAWREC] */
export function findAudioClip(track, ref) {
  const id = String(ref ?? "");
  const clip = (track.audioClips || []).find((c) => c.id === id);
  if (clip) return clip;
  throw new Error(`No such audio clip on ${track.id}: ${id}. It has ${(track.audioClips || []).map((c) => `${c.id} (${c.name})`).join(", ") || "no audio clips"}.`);
}

/* [DAWREC] */
export function findTake(track, ref) {
  const id = String(ref ?? "");
  const take = (track.takes || []).find((t) => t.id === id);
  if (take) return take;
  throw new Error(`No such take on ${track.id}: ${id}. It has ${(track.takes || []).map((t) => `${t.id} (${t.name})`).join(", ") || "no takes"}.`);
}

/* ────────────────────────────── the derived timeline — bars from the maps */

/**
 * One row per bar, 1..uptoBar: meter, tempo, quarter-note offset and length,
 * and the SECONDS the render boundary needs. This is the only place bars are
 * turned into time; everything else reads these rows.
 *
 * The maps may point past `lengthBars` (a meter event at bar 40 of a 16-bar
 * project is stored, not lost); rows simply stop at uptoBar.
 */
export function buildTimeline(doc, uptoBar = doc.lengthBars) {
  const rows = [];
  let mi = 0, ti = 0;
  let q = 0, sec = 0;
  for (let bar = 1; bar <= uptoBar; bar++) {
    while (mi + 1 < doc.meterMap.length && doc.meterMap[mi + 1].atBar <= bar) mi++;
    while (ti + 1 < doc.tempoMap.length && doc.tempoMap[ti + 1].atBar <= bar) ti++;
    const { num: n, den: d } = doc.meterMap[mi];
    const bpm = doc.tempoMap[ti].bpm;
    const qLen = n * 4 / d;                     // a beat in x/den is 4/den quarters
    const secLen = qLen * 60 / bpm;             // bpm is quarter-note bpm
    rows.push({ bar, num: n, den: d, bpm, qStart: q, qLen, sec, secLen,
                ticksPerBar: n * TICKS_PER_BEAT });
    q += qLen; sec += secLen;
  }
  return rows;
}

/** Total project seconds — the last bar's end. */
export function projectSeconds(doc) {
  const rows = buildTimeline(doc);
  const last = rows[rows.length - 1];
  return last ? last.sec + last.secLen : 0;
}

/** Validate a position against the doc's own meter. Throws naming the fix. */
export function normPos(doc, pos, label = "position") {
  const bar = Math.round(Number(pos?.bar));
  const beat = Math.round(Number(pos?.beat ?? 1));
  const tick = Math.round(Number(pos?.tick ?? 0));
  if (!Number.isFinite(bar) || bar < 1) throw new Error(`${label}: bar must be a whole number ≥ 1.`);
  if (bar > doc.lengthBars) throw new Error(`${label}: bar ${bar} is past the project's ${doc.lengthBars} bars — extend it with set_length first.`);
  const row = buildTimeline(doc, bar)[bar - 1];
  if (!Number.isFinite(beat) || beat < 1 || beat > row.num) {
    throw new Error(`${label}: beat ${beat} does not exist — bar ${bar} is in ${row.num}/${row.den}, so beats run 1..${row.num}.`);
  }
  if (!Number.isFinite(tick) || tick < 0 || tick >= TICKS_PER_BEAT) {
    throw new Error(`${label}: tick must be 0..${TICKS_PER_BEAT - 1}.`);
  }
  return { bar, beat, tick };
}

/** A position in seconds — the render boundary. */
export function posToSeconds(doc, pos, rows = null) {
  rows = rows || buildTimeline(doc, Math.max(pos.bar, 1));
  const row = rows[pos.bar - 1];
  const ticksIn = (pos.beat - 1) * TICKS_PER_BEAT + pos.tick;
  const beatSec = (4 / row.den) * 60 / row.bpm;
  return row.sec + ticksIn / TICKS_PER_BEAT * beatSec;
}

/**
 * How long `durTicks` lasts starting at `pos`, in seconds — walked bar by bar
 * because ticks are LOCAL beat ticks and a beat's length changes with the
 * meter. Past the last bar the final meter and tempo simply continue: a note
 * ringing off the end of the project is a note, not an error.
 */
export function durationSeconds(doc, pos, durTicks, rows = null) {
  rows = rows || buildTimeline(doc);
  let bar = pos.bar;
  let ticksIn = (pos.beat - 1) * TICKS_PER_BEAT + pos.tick;
  let left = Math.max(1, Math.round(durTicks));
  let sec = 0;
  for (;;) {
    const row = rows[Math.min(bar, rows.length) - 1];   // last row extends
    const beatSec = (4 / row.den) * 60 / row.bpm;
    const barTicks = row.num * TICKS_PER_BEAT;
    const room = barTicks - ticksIn;
    const take = Math.min(left, room);
    sec += take / TICKS_PER_BEAT * beatSec;
    left -= take;
    if (left <= 0) return sec;
    bar++; ticksIn = 0;
  }
}

/* ──────────────────────────── regions — the dirty-render chunks, derived */

/**
 * The project chopped into REGION_BARS-bar regions with ABSOLUTE sample
 * windows. Sample boundaries are computed once, from the same float seconds,
 * and each region's nSamples is the DIFFERENCE of adjacent boundaries — so
 * regions abut sample-exactly by construction and their lengths sum to the
 * whole, which is what the seam-equality proof stitches against.
 */
export function regionsOf(doc) {
  const rows = buildTimeline(doc);
  const total = rows.length ? rows[rows.length - 1].sec + rows[rows.length - 1].secLen : 0;
  const out = [];
  const bounds = [];                            // sample index of each region start
  for (let from = 1; from <= doc.lengthBars; from += REGION_BARS) {
    bounds.push(Math.round(rows[from - 1].sec * doc.sr));
  }
  bounds.push(Math.round(total * doc.sr));
  let idx = 0;
  for (let from = 1; from <= doc.lengthBars; from += REGION_BARS, idx++) {
    const to = Math.min(from + REGION_BARS - 1, doc.lengthBars);
    out.push({
      idx, fromBar: from, toBar: to,
      t0: rows[from - 1].sec,
      t1: to < doc.lengthBars ? rows[to].sec : total,
      startSample: bounds[idx],
      nSamples: bounds[idx + 1] - bounds[idx],
    });
  }
  return out;
}

/** Deterministic per-note seed — the ±cents realism must survive a re-render. */
export function noteSeed(trackId, noteId, pitch, startSample) {
  const h = createHash("sha1").update(`${trackId}:${noteId}:${pitch}:${startSample}`).digest();
  return h.readUInt32BE(0);
}

/**
 * Every audible note, flattened to what the renderer needs: absolute sample
 * placement, instrument, velocity, gain, seed. Muted tracks contribute
 * nothing (and therefore fall out of every region hash, which is what makes
 * un-muting a dirty edit). endSec includes the instrument tail — the reach
 * the region hasher tests against.
 */
export function noteEvents(doc) {
  const rows = buildTimeline(doc);
  const out = [];
  for (const track of doc.tracks) {
    /* CHAIN STAGE: audibility composes solo with the P0 mute (any solo →
     * only solo tracks sound), and a note's REACH grows by the mixer's
     * rule — [start − back, ∞) through a stateful chain, unchanged when
     * the path is memoryless. See mixer.js's header for the whole rule. */
    if (!mixerAudible(doc, track)) continue;
    const reach = mixerReach(doc, track);
    for (const clip of track.clips) {
      for (const n of clip.notes) {
        const pos = { bar: n.bar, beat: n.beat, tick: n.tick };
        if (pos.bar > doc.lengthBars) continue;         // stored but out of the song
        const startSec = posToSeconds(doc, pos, rows);
        const durSec = durationSeconds(doc, pos, n.durTicks, rows);
        const startSample = Math.round(startSec * doc.sr);
        const durSamples = Math.max(1, Math.round(durSec * doc.sr));
        const endSec = startSec + durSec + (TAILS[track.instrument.patch] ?? 1.5);
        out.push({
          trackId: track.id, clipId: clip.id, noteId: n.id,
          inst: track.instrument.patch,
          params: track.instrument.params || {},
          gainDb: track.gainDb,
          midi: n.pitch, vel: n.vel,
          startSample, durSamples,
          startSec,
          endSec,
          reach0: startSec - reach.back,
          reach1: reach.fwd === Infinity ? Infinity : endSec + reach.fwd,
          seed: noteSeed(track.id, n.id, n.pitch, startSample),
        });
      }
    }
  }
  // Deterministic order: the same events must hash the same way every time.
  out.sort((a, b) => a.startSample - b.startSample || a.midi - b.midi
    || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0)
    || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
  return out;
}

/**
 * [DAWREC] The absolute sample where an audio clip (or take) starts — THE
 * placement formula, written once: the musical anchor through the maps, plus
 * the signed sample shift (latency compensation / sample anchoring).
 */
export function audioStartSample(doc, c, rows = null) {
  rows = rows || buildTimeline(doc, Math.max(c.bar, 1));
  const pos = { bar: Math.min(c.bar, doc.lengthBars), beat: c.beat, tick: c.tick };
  return Math.round(posToSeconds(doc, pos, rows) * doc.sr) + (c.shiftSamples | 0);
}

/**
 * [DAWREC] Every audible audio clip, flattened for the renderer and the
 * region hasher: absolute start sample, file identity, trim, gain. Audio has
 * no synth tail — its reach is exactly its samples. Muted tracks contribute
 * nothing, exactly like notes. Takes are NOT here: a take auditions and gets
 * comped, but never renders into the mix.
 */
export function audioEvents(doc) {
  const rows = buildTimeline(doc);
  const out = [];
  for (const track of doc.tracks) {
    if (track.mute) continue;
    for (const c of track.audioClips || []) {
      const startSample = audioStartSample(doc, c, rows);
      const startSec = startSample / doc.sr;
      out.push({
        trackId: track.id, clipId: c.id,
        file: c.file, offsetSamples: c.offsetSamples, durSamples: c.durSamples,
        gainDb: (track.gainDb || 0) + (c.gainDb || 0),
        startSample, startSec,
        endSec: startSec + c.durSamples / doc.sr,
      });
    }
  }
  out.sort((a, b) => a.startSample - b.startSample
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0));
  return out;
}

/**
 * One sha1 per region over everything that can reach its samples. THE dirty
 * mechanism: compare these before and after a mutation and the changed ones
 * are the regions that need re-rendering — and the hash doubles as the cache
 * key, so "not dirty" and "already on disk" are the same test.
 *
 * [DAWREC] Audio clips are hashed by file NAME plus placement — legal
 * because take/import/comp files are write-once under minted names, so the
 * name IS the content identity (see audioDir's note).
 */
export function regionHashes(doc, events = null, regions = null, audio = null) {
  events = events || noteEvents(doc);
  regions = regions || regionsOf(doc);
  audio = audio || audioEvents(doc);
  /* CHAIN STAGE: with a non-default mixer, a region's identity also covers
   * the chains its sound crosses — the sending tracks' strips, the returns
   * they feed, the master — per the rule in mixer.js. `sigs` is null on a
   * default mixer and then NOTHING below changes: hashes stay byte-identical
   * to P0's, which is what keeps old caches warm and the P0 gates honest. */
  const sigs = mixerSigBundle(doc);
  return regions.map((r) => {
    const h = createHash("sha1");
    h.update(`sr=${doc.sr};w=${r.startSample}+${r.nSamples};`);
    const touched = sigs ? new Set() : null;
    for (const e of events) {
      if (e.reach0 >= r.t1 || e.reach1 <= r.t0) continue;
      // params ride the hash: normParams builds them key-by-key in a fixed
      // order, so JSON.stringify is stable and a transpose/program change
      // dirties exactly the regions that patch sounds in.
      h.update(`${e.inst}|${JSON.stringify(e.params || {})}|${e.midi}|${e.vel}|`
        + `${e.startSample}|${e.durSamples}|${e.gainDb.toFixed(3)}|${e.seed};`);
      if (touched) touched.add(e.trackId);
    }
    if (touched && touched.size) {
      for (const tid of [...touched].sort()) {
        h.update(`MX|${tid}|${sigs.tracks[tid] ?? ""};`);
        for (const rid of sigs.sendTargets[tid] ?? []) {
          h.update(`RT|${rid}|${sigs.returns[rid] ?? ""};`);
        }
      }
      h.update(`MASTER|${sigs.master};`);
    }
    for (const a of audio) {
      if (a.startSec >= r.t1 || a.endSec <= r.t0) continue;
      h.update(`A|${a.file}|${a.offsetSamples}|${a.durSamples}|${a.startSample}|`
        + `${a.gainDb.toFixed(3)};`);
    }
    return h.digest("hex").slice(0, 12);
  });
}

/** The regions whose hashes differ between two hash lists (same project shape). */
export function dirtyBetween(before, after, regions) {
  const out = [];
  for (let i = 0; i < after.length; i++) {
    if (before[i] !== after[i]) {
      const r = regions[i];
      out.push({ idx: i, fromBar: r.fromBar, toBar: r.toBar });
    }
  }
  // A meter/tempo/length change can change the region COUNT; every region
  // past the old list's end is new and therefore dirty.
  for (let i = before.length; i < after.length; i++) {
    const r = regions[i];
    out.push({ idx: i, fromBar: r.fromBar, toBar: r.toBar });
  }
  return out;
}
