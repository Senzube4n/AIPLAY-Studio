/**
 * THE VOICE LAB, THE PER-TRACK STEMS, AND THE PEAKS MIP-MAP — the route half.
 *
 * Three actions, one mount. `createDawRoutes` calls handleVoiceLabAction the
 * way it already calls handleMixerAction: before the switch, same `mutate`,
 * same catch, same ledger. Nothing in here writes a document.
 *
 *   voice_lab      render ONE note through a track's real patch, optionally
 *                  with knob values that are NOT written to the document, and
 *                  answer with the picture (peaks, spectrum, envelope).
 *   render_stems   the post-fader per-track buses of a region, keyed by the
 *                  SAME region hash, rendered LAZILY when a lane is opened.
 *   peaks          a slice of a file's four-stage waveform mip-map.
 *
 * ── voice_lab BESIDE preview_note, NOT INSTEAD OF IT ──────────────────────
 * routes.js's `preview_note` takes `params_override` and `analysis` itself,
 * and it is the right door for the ordinary case. `voice_lab` is the same
 * render reached the two ways that route cannot reach it:
 *
 *   stereo: true        through the rack with a NO-OP chain, which is the only
 *                       path to synth_note_stereo. `preview_note` sends the P0
 *                       mono job, so its wav has ONE channel — and a mono fold
 *                       cannot show a width knob at all. Four shipped knobs are
 *                       width knobs (bigroom_lead.spread, tr808.spread,
 *                       tr909.spread and tr909.hat_width), so without this the
 *                       panel would draw two identical channels and the knob
 *                       would look broken.
 *   through_chain: true the same, plus the track's own inserts, fader and pan.
 *
 * Everything else is deliberately identical, and provably so: with no override
 * and no stereo, `voice_lab` computes the SAME filename from the SAME recipe
 * into the SAME `_previews` directory, so the two actions share one cache
 * entry and one file. voicelab_test.js asserts the name, then deletes the file
 * and asserts the BYTES. And both doors draw their pictures by calling ONE
 * function, `analysePreview` below — which is what makes "the same spectrum"
 * a fact about the code rather than a hope about two panels.
 *
 * ── THE FOUR FACTS THIS FILE REFUSES TO HIDE ──────────────────────────────
 *  1. THE LANES SUM TO THE MIX, NOT TO THE MASTER. buses["tracks"] is
 *     post-fader and pre-master-chain; the master chain, the master fader and
 *     the tanh sit on top. rack.render_stems measures the residual and the
 *     master delta and both travel in the payload.
 *  2. A STEM RENDER IS A SECOND FULL GRAPH PASS. SPEC §0.1 applies to it
 *     exactly as it applies to a region: ~11 s at bar 125 of a chained
 *     128-bar project. That is why it is lazy, and why the reply carries `ms`.
 *  3. THE FAST LANE MAY NOT BE THERE. §3.4's second serve child belongs to
 *     the routes module; if the mount does not hand one over, voice_lab uses
 *     the shared lane and SAYS SO in `lane`, because a knob turn queued
 *     behind an 8.5 s region render is an 8.5 s knob and the panel should not
 *     pretend otherwise.
 *  4. A TRACK CAN BE AUDIBLE AND SILENT AT THE SAME TIME. The engine writes a
 *     bus for a track that SOUNDS in the window; a track that is unmuted with
 *     nothing in these bars has no stem and never will. The cache hit test is
 *     built from that rule and the reply NAMES the silent tracks, because an
 *     empty lane and a lane that failed look identical. Asking for the other
 *     set — every audible track — is what made a lane re-render in full on
 *     every open, forever, on any project with a silent track in the window.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { open, stat, mkdir, readdir, rename, unlink } from "node:fs/promises";

import {
  DAW_DIR, cacheDir, readProject, findTrack, buildTimeline,
  regionsOf, regionHashes, noteEvents, audioEvents, audioJobClips, noteSeed, normParams,
  TICKS_PER_BEAT, TAILS, PATCHES, LIMITS, clampInt,
} from "./store.js";
import { isDefaultMixer, mixerJobPayload, mixerAudible } from "./mixer.js";
import { instrumentsDir } from "./patches.js";
import { regionWavReady } from "./cache.js";

/* ── names ────────────────────────────────────────────────────────────────
 * A stem is named for the region it came out of, so it is invalidated by
 * exactly the edits that invalidate that region and by no others: same hash,
 * same bytes, no second cache to reason about. */
export const REGION_NAME_RE = /^reg\d+_[0-9a-f]{12}\.wav$/;
export const STEM_NAME_RE = /^reg\d+_[0-9a-f]{12}_(?:trk|ret)_[A-Za-z0-9_-]{1,40}\.wav$/;
export const PREVIEW_NAME_RE = /^pv_[a-z0-9_.-]+\.wav$/;

export const isStemName = (name) => STEM_NAME_RE.test(String(name || ""));
export const stemName = (idx, hash, trackId) => `reg${idx}_${hash}_trk_${trackId}.wav`;
export const returnStemName = (idx, hash, returnId) => `reg${idx}_${hash}_ret_${returnId}.wav`;

/** The actions this module dispatches — for the parity census. */
export const VOICELAB_ACTIONS = ["voice_lab", "render_stems", "peaks"];

/* The Voice Lab's hard ceiling. §3.4: the fast lane exists so a knob turn
 * cannot queue behind a region render, and it only stays fast if nothing long
 * is allowed onto it. Ten seconds at the project rate, refused AT THE ROUTE
 * with the ceiling named, so the refusal teaches rather than just fails. */
export const VOICE_CEILING_SECONDS = 10;

/* A drawing never wants more than this many peaks per channel in one reply;
 * past it the answer is a coarser stage, which is what the mip-map is for. */
const MAX_PEAKS_PER_CHANNEL = 4000;
const PK_MAGIC = "PKS1";
const SHIFTS = [3, 6, 9, 12];

const sha12 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const safeName = (v) => {
  const s = path.basename(String(v ?? ""));
  return s && !s.includes("..") ? s : null;
};
function inRange(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  if (n < lo || n > hi) throw new Error(`${label} must be between ${lo} and ${hi} — got ${n}.`);
  return n;
}

/**
 * THE MOUNT. One plain function, the handleMixerAction contract exactly:
 * returns a reply object for an action it owns, `null` for one it does not.
 *
 * ctx: { runEngineFast, runEngineVoice?, safe? }
 *   runEngineFast   the shared serve lane (required)
 *   runEngineVoice  §3.4's short-job lane, if the mount has one. Optional,
 *                   and its absence is reported rather than hidden.
 *
 * ── THE SEAM THAT WAS OPEN, AND WHY IT COST 28 SECONDS ────────────────────
 * This block declared `runEngineVoice` and routes.js hands `runEngineVoice`;
 * the code below read `ctx.runOneNote`, which is the name that lane has
 * INSIDE routes.js and not the name it arrives under. The key never matched,
 * so every Voice Lab render and every analysis fell through to the shared
 * render lane and the reply told the reader to mount a lane that was already
 * mounted. Measured on the real engine, a knob turn fired 250 ms into a cold
 * 16-bar region render of a chained 128-bar project: 28 661 ms, of which
 * 28 632 ms was the analysis job sitting in the FIFO — the note's own wav was
 * already cached and cost 0 ms to make. That is the exact hazard §3.4 exists
 * to remove, and it was removed in name only.
 *
 * `laneOf` is now the ONE place either name is resolved, both are accepted so
 * a rename on the routes side cannot reopen it, and the label it returns is
 * what the panel prints — so a reply that says "fast" is a reply that ran on
 * the short-job child.
 */
export function laneOf(ctx = {}) {
  const run = ctx.runEngineVoice || ctx.runOneNote || ctx.runEngineFast;
  return { run, lane: (ctx.runEngineVoice || ctx.runOneNote) ? "fast" : "shared" };
}

export async function handleVoiceLabAction(action, b, ctx) {
  if (!VOICELAB_ACTIONS.includes(action)) return null;
  const safe = ctx.safe || safeName;
  switch (action) {
    case "voice_lab": return voiceLab(b, ctx, safe);
    case "render_stems": return renderStems(b, ctx, safe);
    case "peaks": return peaksSlice(b, ctx, safe);
    default: return null;
  }
}

/* ══════════════════════════════════════════════════════════ voice_lab ════ */

/**
 * One note, this track's real patch, optionally with knobs the document has
 * never heard of.
 *
 * `params_override` is the whole point of the panel. It rides the SAME cache
 * key the params always rode, so a preview is still content-addressed and a
 * knob you come back to is still free — but nothing is written, there is no
 * ledger row, no dirty region and no undo entry. Seventeen knob turns cost
 * seventeen files and zero document versions.
 */
async function voiceLab(b, ctx, safe) {
  const slug = safe(b.slug);
  const doc = slug && await readProject(slug);
  if (!doc) throw new Error("No such project.");
  const t = findTrack(doc, b.track);
  const patch = t.instrument.patch;
  const base = t.instrument.params || {};

  /* No override is not the same as an EMPTY override, and both must answer
   * with the same bytes as `preview_note`. With nothing to merge we pass the
   * document's own params object through untouched — same JSON, same hash,
   * same filename, same file. With an override we normalise the merge through
   * store.normParams, which is what the document itself is normalised by, so
   * a knob at its declared default DROPS OUT and hashes as if untouched. */
  const ov = b.params_override;
  const hasOv = ov !== undefined && ov !== null;
  if (hasOv && (typeof ov !== "object" || Array.isArray(ov))) {
    throw new Error("params_override must be an object of parameter names to values.");
  }
  const params = hasOv ? normParams({ ...base, ...ov }, patch) : base;

  const pitch = clampInt(inRange(b.pitch === undefined ? 60 : b.pitch,
    LIMITS.pitch[0], LIMITS.pitch[1], "pitch"), 0, 127);
  const vel = clampInt(b.vel === undefined ? 100
    : inRange(b.vel, LIMITS.vel[0], LIMITS.vel[1], "vel"), 1, 127);
  const durTicks = clampInt(b.dur_ticks === undefined ? 480
    : inRange(b.dur_ticks, LIMITS.durTicks[0], LIMITS.durTicks[1], "dur_ticks"),
  1, TICKS_PER_BEAT * 8);

  const row = buildTimeline(doc, 1)[0];
  const durSec = durTicks / TICKS_PER_BEAT * (4 / row.den) * 60 / row.bpm;
  const durSamples = Math.max(1, Math.round(durSec * doc.sr));
  const nSamples = durSamples + Math.round((TAILS[patch] ?? 1.5) * doc.sr);

  /* THE CEILING, named in its own refusal. */
  const ceilSec = Number(ctx.fastLaneSeconds) || VOICE_CEILING_SECONDS;
  const ceiling = Math.round(ceilSec * doc.sr);
  if (nSamples > ceiling) {
    throw new Error(
      `A Voice Lab note is capped at ${ceilSec} s `
      + `(${ceiling} samples at ${doc.sr} Hz) and this one is `
      + `${(nSamples / doc.sr).toFixed(2)} s with ${patch}'s tail. `
      + "That cap is what keeps the short-job lane short — shorten dur_ticks, "
      + "or render the part through `render` instead.");
  }

  /* ── THE PATH, AND WHY THERE ARE THREE OF THEM ─────────────────────────
   * `preview_note`'s job carries no mixer, so it takes the P0 mono path:
   * synth_note_MONO, a one-channel wav. That is right for an audition in the
   * piano roll and WRONG for a Voice Lab knob rack, because three shipped
   * patches have a width knob (bigroom_lead.spread, tr808.spread, tr909.
   * spread and hat_width) and a mono fold cannot show any of them — the
   * panel would draw two identical channels and the knob would look broken.
   *
   * So: mono by default, byte-identical to `preview_note`; `stereo: true`
   * renders the same note through the rack with a NO-OP chain, which is the
   * only way to reach synth_note_stereo; `through_chain: true` adds the
   * track's own inserts, fader and pan on top of that. The tanh master curve
   * is applied on both paths (engine.render and rack.chain_graph each end
   * with np.tanh(0.7 * mix)), so the difference between them is the fold and
   * nothing else.
   *
   * The chain payload rides the cache key whenever it is used, and the mode
   * is a filename suffix, so the three caches can never collide and a knob
   * moved on an insert cannot answer from a stale file. */
  const wantChain = b.through_chain === true;
  const wantStereo = wantChain || b.stereo === true;
  const mode = wantChain ? "ch" : (wantStereo ? "st" : "");
  let mixerPayload = null;
  if (wantStereo) {
    const rows = buildTimeline(doc, 1);
    const full = wantChain ? mixerJobPayload(doc, buildTimeline(doc)) : null;
    const cfg = wantChain
      ? { ...(full.tracks[t.id] || {}), sends: [] }      // no returns are rendered
      : { inserts: [], fader: 0, pan: 0, sends: [] };
    mixerPayload = {
      tracks: { [t.id]: cfg }, returns: [],
      /* THE MASTER CHAIN IS DELIBERATELY LEFT OUT. It belongs to the mix, not
       * to the voice: auditioning one note through the project's limiter
       * would show the limiter, not the instrument. */
      master: { inserts: [], fader: 0 },
      stereo: true, spq: [[0, 60 / rows[0].bpm]],
    };
  }
  /* THE SAME NAME `preview_note` COMPUTES, in the default case. Byte-for-byte
   * the same recipe: patch, pitch, velocity, duration, the track's gain in
   * tenths of a dB, and a 12-hex digest of the params JSON. */
  const key = mixerPayload ? JSON.stringify([params, mixerPayload]) : JSON.stringify(params);
  const name = `pv_${patch}_${pitch}_${vel}_${durTicks}`
    + `_${Math.round((t.gainDb || 0) * 10)}_${sha12(key)}${mode ? `_${mode}` : ""}.wav`;
  const dir = path.join(DAW_DIR(), "_previews");
  await mkdir(dir, { recursive: true });
  const full = path.join(dir, name);
  let have = false;
  try { have = (await stat(full)).size > 44; } catch { /* render below */ }

  /* §3.4's short-job child, when the mount has one. routes.js calls it
   * runOneNote inside itself and hands it over as `runEngineVoice`, and it
   * enforces the same 10 s ceiling in its own body, so the two can never
   * drift: the check above is a nicer message, not a second rule. */
  const { run, lane } = laneOf(ctx);
  const t0 = Date.now();
  let renderMs = 0;
  if (!have) {
    const tmp = full + `.tmp-${process.pid}`;
    const rr = await run("render", {
      sr: doc.sr, start_sample: 0, n_samples: nSamples,
      instruments_dir: instrumentsDir(),
      notes: [{
        inst: patch, params, midi: pitch, vel,
        start_sample: 0, dur_samples: durSamples,
        gain_db: t.gainDb, seed: noteSeed(t.id, "preview", pitch, 0),
        ...(mixerPayload ? { track_id: t.id } : {}),
      }],
      ...(mixerPayload ? { mixer: mixerPayload } : {}),
      out: tmp,
    }, 60_000);
    await rename(tmp, full);
    renderMs = rr.ms ?? 0;
  }

  const out = {
    ok: true, url: `/api/daw/preview/${name}`, file: name,
    track: t.id, patch, params,
    params_overridden: hasOv, params_base: base,
    pitch, vel, dur_ticks: durTicks,
    seconds: Number((nSamples / doc.sr).toFixed(3)),
    cached: have, render_ms: renderMs, lane,
    path: wantChain ? "rack, this track's own chain" : (wantStereo ? "rack, no-op chain" : "P0 mono"),
    stereo: wantStereo, through_chain: wantChain,
    path_note: wantStereo
      ? (wantChain
        ? "Through the track's own inserts, fader and pan — but NOT the master "
          + "chain and not the sends, because a limiter set for the mix would "
          + "show you the limiter instead of the instrument."
        : "Through the rack with a no-op chain, which is the only way to reach "
          + "the stereo instrument stage. The audio is otherwise the voice alone.")
      : "The P0 mono path — the same job and the same bytes `preview_note` "
        + "renders. It folds to one channel, so a width knob (spread, "
        + "hat_width) cannot show here: ask for stereo: true to see it move.",
    /* The panel builds its knob rack from THIS, never from a hard-coded
     * name — the same table drums.py clamps against and daw_patches
     * publishes, so a knob cannot exist on one side only. */
    param_schema: PATCHES[patch]?.params || {},
    document_untouched: true,
    note: hasOv
      ? "Rendered with params the document has NOT been given: no ledger row, "
        + "no dirty region, no undo entry. The override rides the cache key, so "
        + "the same knob values answer from disk next time."
      : "The track's own params, exactly as `preview_note` would render them — "
        + "same filename, same file.",
  };
  if (lane === "shared") {
    out.lane_note = "This ran on the SHARED serve lane: if a region render is "
      + "already inside python, this call waited for it (SPEC §0.1 — up to ~11 s "
      + "at the end of a chained project). Mount a short-job lane as "
      + "`runEngineVoice` to make a knob turn cost only the knob turn.";
  }

  if (b.analysis) {
    /* THE SAME FUNCTION routes.js's preview_note calls. One implementation of
     * the pictures, reached from both doors — which is the only way the two
     * can be guaranteed to draw the same thing. */
    out.analysis = await analysePreview(
      { file: full, sr: doc.sr, patch, params, seconds: nSamples / doc.sr,
        columns: b.columns, genre: b.genre, third_octave: b.third_octave },
      ctx);
  }
  out.ms = Date.now() - t0;
  return out;
}

/* ═════════════════════════════════════════════════════ analysePreview ════ */

/**
 * THE PICTURES. One implementation, two doors: routes.js's `preview_note`
 * calls this when a caller asks for `analysis`, and `voice_lab` above calls
 * the same function on the same file. Two panels that could draw different
 * spectra of the same wav is the drift this shape exists to prevent.
 *
 *   job:  { file, sr?, patch?, params?, seconds?, columns?, genre?,
 *           third_octave? }
 *   deps: { runEngineVoice? | runOneNote?, runEngineFast } — §3.4's short-job
 *          lane if the mount has one, else the shared one. Resolved by laneOf,
 *          the one place either name is read.
 *
 * It never renders. The file is already on disk by the time this is called,
 * content-addressed, and this only measures it.
 *
 * WHY IT IS A SERVE-LANE JOB AND NOT A SPAWN. A knob turn's whole budget is
 * 100 ms and a cold python spends ~300 ms importing numpy before it reads a
 * sample. Measured on this machine, warm, over every builtin patch: 7-35 ms
 * for the analysis, 2-12 ms for the render it follows, 13-56 ms for the whole
 * round trip. tr909 is the worst of the eleven, at 39 ms.
 */
export async function analysePreview(job, deps = {}) {
  const { run } = laneOf(deps);
  if (!run) {
    throw new Error(
      "analysePreview needs a serve lane: `runEngineVoice` (the short-job child, "
      + "and the name routes.js hands it over under), `runOneNote` (the name that same "
      + "lane has inside routes.js, accepted so a rename cannot silently drop the "
      + "analysis onto the render lane), or `runEngineFast` (the shared one).");
  }
  if (!job?.file) throw new Error("analysePreview needs the rendered file's path.");
  const a = await run("voice_analyse", {
    file: job.file,
    columns: job.columns === undefined ? 900 : clampInt(job.columns, 16, 4000),
    genre: job.genre || "neutral",
    third_octave: job.third_octave !== false,
  }, 60_000);
  return {
    ...a,
    /* The knob rack is generated from THIS, so no parameter name is ever
     * hard-coded in the page — the rule ui_test.js already enforces on the
     * rack's device panel, applied to instrument params. */
    param_schema: (job.patch && PATCHES[job.patch]?.params) || {},
    source: "server/daw/peaks.py voice_analyse, on the warm serve lane",
    note: "Measured where the audio already is, so the browser never decodes a "
      + "WAV to draw a picture. The nine bands are ear.py's OWN constant — the "
      + "same one the Ear's cards are written from — and they come back per "
      + "CHANNEL as well as folded, because a mono fold cannot show a width "
      + "move and three shipped patches have one (bigroom_lead.spread, "
      + "tr808.spread, tr909.spread and hat_width).",
    ...(a.channels < 2 ? {
      mono_caveat: "This file is ONE channel: the P0 mono path is what "
        + "`preview_note` renders, so L, R and mid here are the same signal and "
        + "a width knob will not move any of them. Ask action:\"voice_lab\" with "
        + "stereo: true to see what spread actually does.",
    } : {}),
    zoom: "For an attack, ask action:\"peaks\" for this file — the four-stage "
      + "mip-map gives 8 samples a peak where these columns give hundreds.",
  };
}

/* ═══════════════════════════════════════════════════════ render_stems ════ */

/**
 * The per-track lanes' audio: a second pass through the SAME graph, captured
 * rather than summed, one wav per track, named for the region.
 *
 * LAZY, on the owner's decision: nothing renders until a lane is opened, so
 * every existing render stays exactly as fast as it is today. When a lane IS
 * opened, every track's bus is written from that one graph pass — the pass is
 * the cost, the extra files are disk — so opening the second lane is free.
 *
 * AND CACHED BY THE RULE THE ENGINE ACTUALLY USES: a stem exists for a track
 * that SOUNDS in the region, not for every track that is audible. Those are
 * different sets the moment a track has nothing in these bars, and asking for
 * the wrong one made the second open re-render everything, forever. The hit
 * test below is derived from the same note list the job carries, and the
 * engine's own answer is checked against it. See the block at `sounding`.
 */
async function renderStems(b, ctx, safe) {
  const slug = safe(b.slug);
  const doc = slug && await readProject(slug);
  if (!doc) throw new Error("No such project.");
  const t0 = Date.now();

  const regions = regionsOf(doc);
  const fromBar = b.from_bar === undefined ? 1
    : clampInt(inRange(b.from_bar, 1, LIMITS.lengthBars, "from_bar"), 1, doc.lengthBars);
  const toBar = b.to_bar === undefined ? doc.lengthBars
    : clampInt(inRange(b.to_bar, 1, LIMITS.lengthBars, "to_bar"), 1, doc.lengthBars);
  const want = regions.filter((r) => r.toBar >= fromBar && r.fromBar <= toBar);
  if (!want.length) throw new Error(`No region covers bars ${fromBar}–${toBar}.`);
  if (want.length > 16) {
    throw new Error(
      `That is ${want.length} regions of stems. A stem render is a FULL second `
      + "graph pass per region — SPEC §0.1 applies to it exactly as it applies "
      + "to a region render, so at the end of a chained project this would be "
      + "minutes. Ask for at most 16 regions (64 bars) at a time.");
  }

  const events = noteEvents(doc);
  const audio = audioEvents(doc);
  const hashes = regionHashes(doc, events, regions, audio);

  /* THE CHAIN JOB IS FORCED, AND SAID OUT LOUD. The P0 mono job carries no
   * track_id, so there is nothing to separate; a default mixer is a no-op
   * chain, so forcing it changes nothing audible. What it must not do is
   * change the REGION, and it cannot: this is a separate job with a separate
   * output, and `render`'s cache is never written by it. */
  const wasDefault = isDefaultMixer(doc);
  const mixer = mixerJobPayload(doc);
  const only = Array.isArray(b.tracks) && b.tracks.length
    ? b.tracks.map((x) => String(findTrack(doc, x).id)) : null;

  const dir = cacheDir(slug);
  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir).catch(() => []));
  const audible = (doc.tracks || []).filter((t) => mixerAudible(doc, t)).map((t) => t.id);
  const wanted = only || audible;
  const returnIds = (mixer.returns || []).map((r) => String(r.id));

  const rows = [];
  let rendered = 0;
  let drift = null;
  /* [DAWREC] which lanes carry a file-backed clip, across every region asked
   * for — filled on the cached branch too, because a cached region's lanes
   * carry the clips just as much as a freshly rendered one's. */
  const clipTracks = new Set();
  for (const r of want) {
    const hash = hashes[r.idx];
    const prefix = `reg${r.idx}_${hash}_`;
    const notes = events
      .filter((e) => e.reach0 < r.t1 && e.reach1 > r.t0)
      .map((e) => ({
        inst: e.inst, params: e.params, midi: e.midi, vel: e.vel,
        start_sample: e.startSample, dur_samples: e.durSamples,
        gain_db: e.gainDb, seed: e.seed, track_id: e.trackId,
      }));
    /* ── THE HIT TEST ASKS FOR WHAT THE ENGINE WRITES ────────────────────
     * A lane used to be re-rendered in full on EVERY open, forever, on any
     * project where a track is silent in the window — because the test
     * asked for a file per AUDIBLE track while rack.render_stems writes one
     * per track that SOUNDS: `for tid in sorted(buses["tracks"])`, and
     * chain_graph only makes a bus for a track that has a note in the job
     * (rack.py `_synth_notes` creates dry[tid] per NOTE). A track with
     * nothing in these bars gets no wav, so `missing` was never empty and
     * the cache never hit.
     *
     * Measured on an 8-track take, 4 tracks silent in bars 1-4, this
     * machine: three consecutive opens rendered 180.8 / 97.8 / 95.8 ms of
     * engine and cached NOTHING. SPEC §0.1 makes that ~11 s per open at the
     * end of a chained 128-bar project, every open, for the life of the
     * project.
     *
     * The rule is now read off the SAME note list this call is about to
     * send, so the two cannot drift apart silently — and where a render
     * does happen, the engine's own silent list is compared against this
     * prediction (`silent_disagreement` below) rather than trusted.
     *
     * The alternative — a zero-byte marker per silent track — was rejected:
     * it would need engine.py's new mode to write files that are not audio
     * into a directory whose whole contract is "every name here is a
     * content-addressed render", and both `size > 44` guards and the peaks
     * route would then have to learn about a wav that is not one. */
    /* [DAWREC] THE CLIPS ARE READ BEFORE THE HIT TEST, not after, because
     * they are now part of what sounds: rack.chain_graph builds a dry buffer
     * for a track with a clip in the window exactly as it does for a track
     * with a note (rack._mix_audio), so `render_stems` writes that track a
     * lane. Predicting silence for it would put this route and the engine in
     * permanent disagreement — the differential guard below would fire on
     * every open, and the lane would re-render forever, which is the bug the
     * block above was written to close. */
    const clips = audioJobClips(doc, slug, r.t0, r.t1, audio);
    for (const c of clips) clipTracks.add(c.track_id);
    const sounding = new Set([...notes.map((n) => n.track_id),
                              ...clips.map((c) => c.track_id)]);
    const expect = wanted.filter((tid) => sounding.has(tid));
    const silent = wanted.filter((tid) => !sounding.has(tid));
    const missing = [];
    for (const tid of expect) {
      const nm = stemName(r.idx, hash, tid);
      const ok = existing.has(nm) && await regionWavReady(path.join(dir, nm),
        { sr: doc.sr, nSamples: r.nSamples, channels: 2 });
      if (!ok) missing.push(tid);
    }
    for (const rid of returnIds) {
      const nm = returnStemName(r.idx, hash, rid);
      const ok = existing.has(nm) && await regionWavReady(path.join(dir, nm),
        { sr: doc.sr, nSamples: r.nSamples, channels: 2 });
      if (!ok) missing.push(`return:${rid}`);
    }
    if (!missing.length) {
      rows.push({
        idx: r.idx, fromBar: r.fromBar, toBar: r.toBar, hash,
        cached: true, ms: 0,
        stems: expect.map((tid) => stemRow(slug, r.idx, hash, tid)),
        returns: returnIds.map((rid) => returnStemRow(slug, r.idx, hash, rid)),
        /* Named on the cached branch too, and by the same rule — the lane
         * head says "silent here", and a cached region that reported none
         * would make a silence look like a lane that had not loaded yet. */
        silent_tracks: silent,
      });
      continue;
    }
    const rr = await ctx.runEngineFast("render_stems", {
      sr: doc.sr, start_sample: r.startSample, n_samples: r.nSamples,
      instruments_dir: instrumentsDir(),
      notes, ...(clips.length ? { audio: clips } : {}),
      mixer, out_dir: dir, prefix,
      ...(only ? { tracks: only } : {}),
    }, 600_000);
    rendered++;
    for (const s of rr.stems || []) existing.add(s.file);
    for (const s of rr.returns || []) existing.add(s.file);
    /* THE DIFFERENTIAL GUARD ON THE CACHE RULE. The hit test above predicts
     * which tracks the engine will write; here the engine has just said.
     * Compared on the same domain (the tracks this call asked for), because
     * the engine's list is over every configured track. A disagreement is
     * the cache lying again, and it travels in the reply rather than
     * waiting to be noticed as a lane that re-renders forever. */
    const engineSilent = (rr.silent_tracks || []).filter((t) => wanted.includes(t));
    const wrote = new Set((rr.stems || []).map((s) => s.track_id));
    const mismatch = [
      ...expect.filter((t) => !wrote.has(t)).map((t) => `${t}: predicted a stem, none written`),
      ...silent.filter((t) => wrote.has(t)).map((t) => `${t}: predicted silence, a stem was written`),
    ];
    if (mismatch.length && !drift) drift = mismatch;
    rows.push({
      idx: r.idx, fromBar: r.fromBar, toBar: r.toBar, hash,
      cached: false, ms: rr.ms ?? 0, engine: rr.engine,
      silent_tracks: silent,
      engine_silent_tracks: engineSilent,
      ...(mismatch.length ? { silent_disagreement: mismatch } : {}),
      sums_to_mix: rr.sums_to_mix, residual_db: rr.residual_db,
      exported_complete: rr.exported_complete, exported_residual_db: rr.exported_residual_db,
      master_delta_db: rr.master_delta_db,
      /* IN THE DOCUMENT'S TRACK ORDER, which is the order the lanes are
       * drawn in — and, more to the point, the order the CACHED branch
       * answers in. The engine writes in sorted(track_id) order, so leaving
       * it alone made a rendered region and a cached one hand back the same
       * four files in two different orders. */
      stems: orderBy(wanted, rr.stems || [], (s) => s.track_id).map((s) => ({
        ...stemRow(slug, r.idx, hash, s.track_id),
        peak: s.peak, rms_db: s.rms_db, sha1: s.sha1,
      })),
      returns: (rr.returns || []).map((s) => ({
        ...returnStemRow(slug, r.idx, hash, s.return_id),
        peak: s.peak, rms_db: s.rms_db, sha1: s.sha1,
      })),
    });
  }

  return {
    ok: true, slug, from_bar: fromBar, to_bar: toBar,
    regions: rows, rendered, cached: rows.length - rendered,
    tracks: wanted.map((id) => {
      const t = (doc.tracks || []).find((x) => x.id === id);
      return { id, name: t?.name, patch: t?.instrument?.patch };
    }),
    forced_chain: wasDefault,
    forced_chain_note: wasDefault
      ? "This project has a DEFAULT mixer, whose chain is a no-op, so the mix is "
        + "unchanged by running it — but the P0 mono job carries no track_id at "
        + "all, so the stems had to be rendered through the rack path. This is a "
        + "SEPARATE job: the region files and their hashes are untouched."
      : undefined,
    sums_to: "All track stems PLUS the separate `returns` files reconstruct the PRE-MASTER mix "
      + "up to float32 rounding. Shared return files include sends from the entire mix, even "
      + "when requesting only some tracks. Every lane is post-fader and pre-master-chain; "
      + "the master chain, the master fader and the tanh curve sit on top, so the "
      + "lanes do not add up to what you hear at the limiter.",
    cost_note: "A stem render is a full second graph pass, so SPEC §0.1 applies: "
      + "it costs what a region render of the same bars costs, again. Lanes are "
      + "lazy for that reason — nothing here ran until you opened one.",
    cache_rule: "A stem exists only for a track that SOUNDS in the region — the "
      + "engine writes one bus per track with a note OR a file-backed clip in the "
      + "job — so the second open of the same bars is `cached: true` and costs no "
      + "engine time even when half the tracks are silent there. `silent_tracks` "
      + "names the rest.",
    /* THE FLAG THAT USED TO STAND HERE SAID THE OPPOSITE, and it was true when
     * it was written: rack.chain_graph built its dry buffers from job["notes"]
     * and nothing else, so a recorded or imported take was in no lane and a
     * track carrying only clips read as silent. rack._mix_audio now mixes the
     * clips into the same buffers through engine.mix_clips — the mono path's
     * own placement — so the fact worth reporting is which lanes carry one.
     * Named only when there really are clips in the window, so it stays a fact
     * about this ask rather than a standing disclaimer. */
    ...(clipTracks.size ? { audio_clip_tracks: [...clipTracks].sort() } : {}),
    ...(drift ? {
      silent_disagreement: drift,
      silent_disagreement_note: "The engine wrote a different set of stems than "
        + "this route predicted, which means the cache hit test and rack.render_stems "
        + "no longer agree about what sounds. Until that is fixed, these lanes "
        + "re-render on every open. Report it — it is a seam, not a setting.",
    } : {}),
    ms: Date.now() - t0,
  };
}

/** Rows in a reference order, anything unlisted kept and put last. */
const orderBy = (ref, rows, keyOf) => {
  const at = (r) => { const i = ref.indexOf(keyOf(r)); return i < 0 ? ref.length : i; };
  return [...rows].sort((a, b) => at(a) - at(b));
};

const stemRow = (slug, idx, hash, trackId) => ({
  track_id: trackId,
  file: stemName(idx, hash, trackId),
  url: `/api/daw/audio/${encodeURIComponent(slug)}/${stemName(idx, hash, trackId)}`,
});

const returnStemRow = (slug, idx, hash, returnId) => ({
  return_id: returnId,
  file: returnStemName(idx, hash, returnId),
  url: `/api/daw/audio/${encodeURIComponent(slug)}/${returnStemName(idx, hash, returnId)}`,
});

/* ══════════════════════════════════════════════════════════════ peaks ════ */

/** Where a peaks request is allowed to point. Content-addressed names only,
 * so nothing here can be talked into reading a path of the caller's choosing. */
function resolveAudio(slug, name, safe) {
  const nm = safe(name);
  if (!nm) throw new Error("peaks needs a file `name`.");
  if (PREVIEW_NAME_RE.test(nm)) return path.join(DAW_DIR(), "_previews", nm);
  const sl = slug && safe(slug);
  if (!sl) throw new Error("peaks needs a `slug` for a region or stem file.");
  if (REGION_NAME_RE.test(nm) || STEM_NAME_RE.test(nm)) return path.join(cacheDir(sl), nm);
  throw new Error(
    `"${nm}" is not a name this serves. Peaks are built for region renders `
    + "(reg<idx>_<hash>.wav), their per-track stems (…_trk_<id>.wav) and Voice "
    + "Lab previews (pv_….wav) — every one of them content-addressed, so a "
    + "built mip-map is valid forever and never needs invalidating.");
}

/** The coarsest stage still giving at least one peak per pixel — and the
 * finest stage when the zoom is finer than that. Monotone in the zoom, which
 * is what stops a drag flickering between resolutions. Mirrors peaks.py's
 * stage_for exactly; peaks_test.js checks the two agree on a sweep. */
export function stageFor(samplesPerPixel) {
  const spp = Number(samplesPerPixel);
  let chosen = SHIFTS[0];
  for (const s of SHIFTS) if ((1 << s) <= spp) chosen = s;
  return chosen;
}

async function readPkHeader(fh) {
  const head = Buffer.alloc(8);
  await fh.read(head, 0, 8, 0);
  if (head.subarray(0, 4).toString("latin1") !== PK_MAGIC) {
    throw new Error("not a peaks sidecar");
  }
  const hlen = head.readUInt32LE(4);
  const hb = Buffer.alloc(hlen);
  await fh.read(hb, 0, hlen, 8);
  return { header: JSON.parse(hb.toString("utf8")), bodyAt: 8 + hlen };
}

async function peaksSlice(b, ctx, safe) {
  const t0 = Date.now();
  const file = resolveAudio(b.slug, b.name, safe);
  try { await stat(file); } catch {
    throw new Error(`No such render: ${path.basename(file)}. Render it first — a `
      + "peaks build reads the file, it does not make it.");
  }
  const side = file + ".pk1";
  let built = false;
  let buildMs = 0;
  let ok = false;
  try { ok = (await stat(side)).size > 12; } catch { /* build below */ }
  if (!ok) {
    const rr = await ctx.runEngineFast("peaks_mip", { file, out: side }, 120_000);
    built = !rr.cached;
    buildMs = rr.ms ?? 0;
  }

  const fh = await open(side, "r");
  try {
    const { header, bodyAt } = await readPkHeader(fh);
    const n = header.samples;
    const from = Math.max(0, Math.min(n, Math.round(Number(b.from_sample ?? 0)) || 0));
    const to = Math.max(from, Math.min(n, b.to_sample === undefined ? n
      : Math.round(Number(b.to_sample))));
    const cap = clampInt(b.max_peaks === undefined ? MAX_PEAKS_PER_CHANNEL
      : b.max_peaks, 16, MAX_PEAKS_PER_CHANNEL);

    /* Stage choice: what the caller's zoom asks for, then coarsened until the
     * reply fits the cap. Both steps are reported, because a picture drawn at
     * a coarser stage than requested is a different picture. */
    let shift = b.stage !== undefined ? clampInt(b.stage, SHIFTS[0], SHIFTS[SHIFTS.length - 1])
      : stageFor(b.samples_per_pixel === undefined
        ? Math.max(1, (to - from) / 900) : b.samples_per_pixel);
    shift = SHIFTS.reduce((acc, s) => (s <= shift ? s : acc), SHIFTS[0]);
    let coarsened = null;
    for (;;) {
      const st = header.stages.find((s) => s.shift === shift);
      const need = Math.ceil((to - from) / st.spp) || 1;
      if (need <= cap || shift === SHIFTS[SHIFTS.length - 1]) break;
      shift = SHIFTS[SHIFTS.indexOf(shift) + 1];
      coarsened = shift;
    }
    const stage = header.stages.find((s) => s.shift === shift);
    const p0 = Math.min(stage.count, Math.floor(from / stage.spp));
    const p1 = Math.min(stage.count, Math.max(p0 + 1, Math.ceil(to / stage.spp)));
    const count = Math.min(p1 - p0, cap);

    const chans = [];
    const k = header.scale / 32767;
    for (let c = 0; c < header.channels; c++) {
      const at = stage.offset + c * stage.count * 2 + p0 * 2;
      const buf = Buffer.alloc(count * 4);
      await fh.read(buf, 0, buf.length, bodyAt + at * 2);
      const min = new Array(count), max = new Array(count);
      for (let i = 0; i < count; i++) {
        min[i] = Number((buf.readInt16LE(i * 4) * k).toFixed(5));
        max[i] = Number((buf.readInt16LE(i * 4 + 2) * k).toFixed(5));
      }
      chans.push({ channel: c, min, max });
    }
    return {
      ok: true, file: path.basename(file), sidecar: path.basename(side),
      rate: header.rate, channels: header.channels, samples: n,
      seconds: header.seconds, scale: header.scale,
      stages: header.stages.map((s) => ({ shift: s.shift, spp: s.spp, count: s.count })),
      stage: { shift: stage.shift, spp: stage.spp, count: stage.count },
      from_sample: from, to_sample: to,
      from_peak: p0, peaks: count, data: chans,
      built, build_ms: buildMs, coarsened,
      coarsened_note: coarsened === null ? undefined
        : `The requested zoom needed more than ${cap} peaks, so this is stage `
          + `${coarsened} (${1 << coarsened} samples a peak) instead. Ask for a `
          + "narrower sample range to get the finer one.",
      note: "min AND max, per channel, from a four-stage mip-map built once per "
        + "file. Values decode as int16 × scale / 32767 — the scale is per file "
        + "because a post-fader stem can be louder than 1.0 and clamping it to "
        + "1.0 would draw a lie.",
      ms: Date.now() - t0,
    };
  } finally {
    await fh.close();
  }
}

/* ── housekeeping the mount may want ──────────────────────────────────────
 * The region cache prunes stale generations with
 *   existing.filter((f) => f.startsWith(`reg${idx}_`) && f !== name)
 * which matches a CURRENT stem as well (`reg0_<hash>_trk_…` starts with
 * `reg0_`). That costs a re-render, never correctness — stems are lazy and
 * content-addressed — but the fix is one predicate, and this is it. */
export const isPrunableRegion = (f, idx, keepName) => {
  /* A peaks sidecar is judged by the file it describes, not by its own name:
   * `reg5_<hash>_trk_x.wav.pk1` belongs to a LIVE stem, and pruning it just
   * makes the next lane-open rebuild a mip-map for audio that never moved. */
  const base = String(f).endsWith(".pk1") ? String(f).slice(0, -4) : String(f);
  return f.startsWith(`reg${idx}_`) && f !== keepName
    && base !== keepName && !isStemName(base);
};

/** Delete a region's stems — for a caller that closes every lane. */
export async function dropStems(slug, idx = null) {
  const dir = cacheDir(slug);
  const files = await readdir(dir).catch(() => []);
  const hit = files.filter((f) => isStemName(f)
    && (idx === null || f.startsWith(`reg${idx}_`)));
  await Promise.all(hit.map((f) => unlink(path.join(dir, f)).catch(() => {})));
  await Promise.all(hit.map((f) => unlink(path.join(dir, f + ".pk1")).catch(() => {})));
  return { ok: true, dropped: hit.length, files: hit };
}
