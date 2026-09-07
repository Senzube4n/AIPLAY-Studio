/**
 * Per-clip duration recommendation — AI Music Video Studio.
 *
 * PORTED BY HAND from the aiplay.live website (no build step, no compiler):
 *   source: devsnap0812/app/helpers/musicVideo/clipDuration.ts
 * The three original exports are byte-equivalent to the .ts — same names, same
 * branch order, same tolerance, same fallbacks — so `diff` against the source
 * stays a line-by-line read. Do not tidy them.
 *
 * ⚠ CLIP_DURATION_STEPS IS SEEDANCE'S LADDER, NOT THIS RIG'S. It encodes the
 * website's per-second billing plus its stitcher's trim-back, and it is kept
 * verbatim only so ported callers get the answer they were written against.
 * Nothing rendered locally may use it: 6, 10 and 12 seconds are all ILLEGAL
 * frame counts on MiniMax H3, and asking for one gets silently lengthened.
 * Local renders use `localClipSteps()` / `recommendedLocalClipSeconds()`.
 *
 * ⚠ ROUNDING IS ALWAYS UP, in every path here. A clip SHORTER than its slot
 * leaves black at the cut; a clip longer is trimmed back and costs only GPU
 * seconds. `build_music_video` already learned this the expensive way — see
 * mcp.js. The 50 ms tolerance forgives millisecond noise (a 12.04 s segment
 * still recommends 12 s, not 15 s) and is the one number that may look like
 * slack but is not.
 */

/* The local ladder is DERIVED from `alignFrames`, never re-derived from the
 * rule it implements. Two copies of `n mod 17 == 5` in one repo is precisely
 * the drift this port exists to avoid — if the engine rule ever changes, this
 * file must change with it silently and automatically.
 *
 * The ported block below this import has no dependencies of its own and stays
 * pure, exactly as the .ts was. */
import { alignFrames, videoEngine } from "../workflow.js";
import { config } from "../config.js";

/* ─── Ported verbatim from clipDuration.ts ─────────────────────────────────
 *
 * Seedance bills PER SECOND and exposes fixed duration steps (mirrors the
 * `durations` arrays for the Seedance models in helpers/visuals/modelConfig.ts).
 * The recommendation is the SMALLEST step that fully covers the segment
 * (round UP): a shorter clip would leave a hole in the cut, and the stitch
 * trims any excess back to the exact scene length. A 50ms tolerance forgives
 * millisecond rounding noise (a 12.04s segment still recommends 12s, not 15s).
 */

/** @type {number[]} was `as const` in the .ts; the tuple type is gone, the values are not. */
export const CLIP_DURATION_STEPS = [5, 6, 8, 10, 12, 15];

const TOLERANCE_SEC = 0.05;

/**
 * Smallest Seedance step that covers [startMs, endMs].
 * Falls back to 5 (the old prepare default) for empty/invalid spans and
 * caps at 15 for anything longer than the largest step.
 *
 * @param {number} startMs
 * @param {number} endMs
 * @returns {number} one of CLIP_DURATION_STEPS (was the `ClipDurationStep` union)
 */
export function recommendedClipSeconds(startMs, endMs) {
  const sec = (endMs - startMs) / 1000;
  if (!Number.isFinite(sec) || sec <= 0) return 5;
  return CLIP_DURATION_STEPS.find((d) => d >= sec - TOLERANCE_SEC) ?? 15;
}

/**
 * Guard for validating user-supplied duration overrides.
 * Was a TS type predicate (`n is ClipDurationStep`); at runtime it was always
 * just this membership test.
 *
 * @param {number} n
 * @returns {boolean}
 */
export function isClipDurationStep(n) {
  return CLIP_DURATION_STEPS.includes(n);
}

/* ─── Local engines — NEW, not in the website source ───────────────────────
 *
 * The website had one video vendor with one billing ladder. This rig has two
 * engines that disagree about what a legal clip length even is:
 *
 *   H3   `n mod 17 == 5` at 24 fps — a coarse 17-frame quantum, 0.708 s apart.
 *        Measured consequence: of the six Seedance steps only 8 s is legal.
 *        The other five get rounded UP inside `align_frame_count` with no
 *        error and no log line, so a "6 second" clip renders as 6.583 s.
 *   LTX  `fps * seconds + 1`, plainly. The quantum is one frame, so every
 *        whole second is already legal and all six steps survive untouched.
 *        LTX's list being identical to Seedance's is a real result, not a
 *        copy-paste — it is what "no quantum" looks like.
 */

/**
 * Does the engine render `sec` EXACTLY, with no silent round-up?
 *
 * Probed through `alignFrames` as a black box rather than by reimplementing
 * either rule. The probe: a duration is exact when asking for one frame MORE
 * comes back strictly longer. Just below a legal boundary H3's round-up hands
 * back the same frame count for both, so the test fails there and passes only
 * on the boundary itself. Under LTX's plain +1 every frame passes, which is
 * the correct answer for that engine.
 *
 * @param {number} sec
 * @param {number} fps
 * @param {string} engine  "h3" | "ltx" — must be explicit, see engineOf()
 * @returns {boolean}
 */
function landsOnFrameGrid(sec, fps, engine) {
  return alignFrames(sec, fps, engine) < alignFrames(sec + 1 / fps, fps, engine);
}

/**
 * Smallest exactly-legal duration at or above `sec`.
 *
 * ⚠ The 1e-6 is not decoration. `124 / 24 * 24` is 124.00000000000001 in
 * binary floating point, and a bare `Math.ceil` on that starts the walk one
 * frame too high — which skips a legal boundary and returns the NEXT one,
 * 0.708 s of wasted render per clip on H3.
 *
 * @param {number} sec
 * @param {number} fps
 * @param {string} engine
 * @returns {number} seconds
 */
function snapUpToFrameGrid(sec, fps, engine) {
  let k = Math.max(1, Math.ceil(sec * fps - 1e-6));
  for (let guard = 0; guard < 4096; guard++, k++) {
    const s = k / fps;
    if (landsOnFrameGrid(s, fps, engine)) return s;
  }
  return sec;
}

/**
 * Which engine name to hand `alignFrames`.
 *
 * ⚠ Never let `undefined` reach `alignFrames` — its own default is "h3", while
 * `config.video.engine` ships as "ltx" and is then overridden per machine by
 * `prefs.video.engine` in ~/.aiplay-studio/settings.json. An omitted argument
 * would therefore size the ladder for whichever engine is NOT running, and
 * which one that is varies by install. Both defaults are defensible on their
 * own terms; only the combination is wrong. Resolve it here, once, at call
 * time — never cache the result, the user can change the engine mid-session.
 *
 * @param {string} [engine]
 * @returns {string}
 */
function engineOf(engine) {
  return engine || config.video.engine;
}

/**
 * The Seedance ladder transposed onto a local engine's frame grid.
 *
 * Six steps in, six steps out (deduped if two ever collapse), each one snapped
 * UP so it is exactly legal AND never shorter than the Seedance step it
 * replaces — both directions of the round-up promise at once.
 *
 * Measured at 24 fps:
 *   h3   [5.1667, 6.5833, 8, 10.125, 12.25, 15.0833]  (frames 124/158/192/243/294/362)
 *   ltx  [5, 6, 8, 10, 12, 15]                        (unchanged — one-frame quantum)
 *
 * Note the top H3 step is 15.083 s, i.e. LONGER than the website's 15 s cap.
 * That is deliberate: 14.375 s is the legal value below it, and capping there
 * would leave 0.6 s of black under every 15-second scene.
 *
 * Values are exact `frames / fps` quotients, not rounded for display — 5.1667
 * is stored as 5.166666666666667 because that is what round-trips back to 124
 * frames. Format at the UI edge; do not round the stored value.
 *
 * @param {string} [engine] "h3" | "ltx"; defaults to the CONFIGURED engine
 * @param {number} [fps]    defaults to that engine's own fps
 * @returns {number[]} ascending seconds, every one exactly legal
 */
export function localClipSteps(engine, fps) {
  const name = engineOf(engine);
  const rate = fps ?? videoEngine(name).fps;
  const out = [];
  for (const step of CLIP_DURATION_STEPS) {
    const s = snapUpToFrameGrid(step, rate, name);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Smallest LOCAL step that covers [startMs, endMs].
 *
 * The ported `recommendedClipSeconds` with the engine's ladder substituted for
 * Seedance's — same branch order, same 50 ms tolerance, same round-UP, same
 * fall back to the first step on an empty/invalid span, same cap at the
 * largest step. Kept structurally identical so the two can be read side by
 * side and any future divergence is visible.
 *
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} [engine] "h3" | "ltx"; defaults to the CONFIGURED engine
 * @param {number} [fps]
 * @returns {number} one of localClipSteps(engine, fps)
 */
export function recommendedLocalClipSeconds(startMs, endMs, engine, fps) {
  const steps = localClipSteps(engine, fps);
  const sec = (endMs - startMs) / 1000;
  if (!Number.isFinite(sec) || sec <= 0) return steps[0];
  return steps.find((d) => d >= sec - TOLERANCE_SEC) ?? steps[steps.length - 1];
}
