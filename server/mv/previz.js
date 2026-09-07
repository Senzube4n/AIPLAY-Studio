/**
 * Video Workflow — BLOCKED SHOTS: a previz clip, a reference frame, and words.
 *
 * blender.js is the sheet path — one prop, many angles, identity held by a mesh
 * instead of by a sentence. This is the SHOT path: the camera moves, and what a
 * board can honestly be given from one.
 *
 * ── THREE ARTEFACTS, THREE DIFFERENT STANDINGS ─────────────────────────────
 * Conflating them is the whole hazard, so they are named apart the way the
 * toolkit names a reference apart from a contact sheet:
 *
 *   PREVIZ CLIP     grey boxes, real camera move, .mp4. use: HUMAN-REVIEW.
 *                   A director watches it to judge a shot BEFORE spending
 *                   twenty-eight minutes of H3 on it. It is never handed to a
 *                   model, and this module writes a sidecar beside it saying so.
 *   REFERENCE FRAME one single-panel .png, rendered by the toolkit's strict
 *                   reference path, from the ANGLE the blocked shot's camera
 *                   occupies. Goes through blender.js's referenceSafe() exactly
 *                   like any other reference, and is refused if it fails.
 *   SHOT PLAN       words. moves.js. The only one of the three that actually
 *                   reaches the model, and the only one available with no
 *                   Blender installed at all.
 *
 *   BLOCKOUT       the SAME geometry, rendered at the control-video contract and
 *                   marked use:vace-control. This one IS handed to a model — to
 *                   WAN 2.1 VACE's `control_video`, which is a different node
 *                   and a different mechanism from the one that failed. See the
 *                   next paragraph, which is the whole of the distinction.
 *
 * ⚠ THE FOURTH ARTEFACT, AND WHY IT IS NOT A REVERSAL. This module used to say
 * in so many words that nothing here wires a blocking clip in as a control
 * video, because a gate experiment had tested exactly that and LTX's sparse
 * appearance guides do NOT carry a blocked camera move into a clip: the arms
 * that appeared to follow the move did so by handing the grey boxes straight
 * back. That measurement stands and is unchanged. What changed is that a
 * SECOND gate ran on a DIFFERENT node: WAN 2.1 VACE leaves the latent as noise
 * and pushes it with a scaled additive residual (comfy/ldm/wan/model.py:854)
 * rather than writing pixels into the denoising latent, and arm W1 scored a
 * camera-motion agreement of 0.924 against a 0.50 floor while staying
 * GENERATED rather than reconstructed (SSIM_block 0.524 against a 0.736 bar).
 *
 * So both sentences are true about two different paths, and the difference is
 * the node. What that costs this file is precision: a PREVIZ and a BLOCKOUT
 * are the same grey boxes and have opposite standings, so they are rendered to
 * DIFFERENT NAMES, carry DIFFERENT sidecars, and the previz's sidecar still
 * says human-review in as many words. Nothing here quietly re-labels the clip
 * a director watched.
 *
 * The H3 path is untouched by all of it: H3 has no structural input at all, so
 * what steers an H3 clip is still the prompt and the reference images.
 *
 * ── WHY THE REFERENCE FRAME IS NOT A STILL OUT OF THE CLIP ─────────────────
 * Because a frame of a blocking render is a picture of a whole SET, and the
 * toolkit will not make one of those into a reference at all. Asked for one
 * directly it refuses before rendering anything — measured, 2026-09-02:
 *
 *     reference --scene street        (no object named)
 *     PropError: nothing named a subject, so this would frame the whole
 *     'street' set (13). A reference must contain the subject and NOTHING
 *     else — the set's ground plane, horizon wall and crates are identifiable
 *     environment, and identifiable environment is what bleeds into the render.
 *
 * So the move contributes the VIEWPOINT and nothing else: the camera track says
 * where the camera was, and the subject is then rendered from there through the
 * strict reference path — isolated, on a cyclorama, with a sidecar.
 *
 * ⚠ AND ISOLATION IS WHAT DOES THE WORK, not the border check that follows it.
 * Measured here on three builtins at az 35 / el 14: street:figure 0 seams,
 * atrium:core 0, and corridor:corridor — a piece of architecture — 1 seam and a
 * card_edge of 0.004. All three pass. That is the right answer (each one IS a
 * single subject on a neutral card once the rest of the set is deleted), and it
 * says plainly what the seam count is for: it is the backstop for a picture
 * that arrived from somewhere else, not the thing keeping sets out. The thing
 * keeping sets out is the refusal above.
 *
 * The licence boundary is blender.js's: subprocess only, files only, nothing
 * imported and no python copied in. This module adds no new crossing.
 */
import path from "node:path";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { assetsDir, readProject, updateProject, noteRun } from "./store.js";
import { blenderStatus, runPreviz, renderReference, referenceSafe, ANGLES,
         SETS, SETS_FALLBACK, BUILTINS, toolkitSets } from "./blender.js";
import { shotPlan, listMoves, resolveMove, MOVES, FRAMINGS } from "./moves.js";
/* THE FLOOR ITSELF, not a copy of it. See FRAMES_MIN below — this import is the
 * one-door pass's smallest change and the one that can never drift. */
import { CONTROL_SPEC } from "../control/control.js";

/**
 * The toolkit's gray-box sets — THE SAME ARRAY blender.js keeps live, not a copy.
 *
 * ⚠ THIS LINE USED TO BE THE SEVEN NAMES, TYPED. It was one of five copies of
 * the toolkit's set list in this app, and when the toolkit grew an eighth set
 * the guard below answered `No previz set called "stage"` for a set that was
 * sitting in the checkout. blender.js now asks the toolkit for the list
 * (`toolkitSets()`, one subprocess, cached under a version stamp) and replaces
 * the contents of SETS in place; exporting the same array under the old name
 * means every reader of SCENES gets the derived answer and nothing here holds a
 * second list to forget about.
 */
export const SCENES = SETS;

/**
 * THE BLOCKING SPEC'S VOCABULARY, and the same bargain SCENES has.
 *
 * previz/spec.py owns these — it is across the licence boundary and it is what
 * actually refuses a bad spec. These exist so a form can be built over the
 * shape without a Blender launch, exactly as SCENES exists so a typo costs
 * nothing. And, exactly like SCENES, `previzCatalogue({ probe: true })`
 * launches Blender once and reports the DISAGREEMENT, so a copy that has gone
 * stale is a finding rather than a mystery six weeks later.
 */
export const SPEC_VERSION = 1;
export const PROP_KINDS = ["box", "cylinder"];
export const FIGURE_HEIGHT_DEFAULT = 1.75;
export const FIGURE_HEIGHT_RANGE = [0.2, 4.0];

/**
 * Multi-beat composites previz/shots.py builds instead of a single move.
 * DERIVED from the vocabulary rather than listed, so a composite added to
 * moves.js cannot be missing here and a name cannot be spelled two ways.
 */
export const TAKES = Object.entries(MOVES).filter(([, m]) => m.take).map(([k]) => k);

/**
 * THE CONTROL-CLIP FORMAT, and why the floor is not mine to choose.
 *
 * The toolkit pins 1280x704 at 24 fps and VERIFIES every clip it writes against
 * that spec, with ffprobe, after the render. 144 frames is six seconds —
 * comfortably longer than the 4-15 second scenes this workflow cuts, and short
 * enough that judging a shot costs under a minute of wall clock.
 *
 * ⚠ 121 IS THE TOOLKIT'S NUMBER, NOT A TASTE. The first end-to-end run here
 * asked for 96 frames — a sensible-looking "make it quicker" — and the render
 * completed and was then thrown away:
 *
 *     CONTROL CLIP OUT OF SPEC: ...previz_s1_offset_follow.mp4
 *       - frame count is 96, must be at least 121 (short clips get clamped to
 *         their last frame downstream)
 *
 * A minute of render, spent, for nothing. So the floor is enforced HERE, before
 * anything is spawned, and it is the far side's CONTROL_MIN_FRAMES rather than
 * a guess. What "enforced" MEANS depends on which kind is being rendered, and
 * the two answers are opposite on purpose — see framesFor.
 */
export const FRAMES_DEFAULT = 144;
/**
 * A BLOCKOUT'S DEFAULT IS THE FLOOR, NOT SIX SECONDS, and that is not a
 * different taste — it is a different job. 144 frames is right for a clip a
 * director watches: six seconds is long enough to judge a move. A blockout is
 * spent on the far side at roughly sixteen seconds of GPU per frame, and the
 * gate that proved the path was measured at exactly 121, so every frame past
 * the floor is render time nobody asked for on a point nobody measured.
 * Imported, like the floor itself, so the two can never differ.
 */
export const BLOCKOUT_FRAMES_DEFAULT = CONTROL_SPEC.minFrames;

/**
 * How long to render, given what was asked for and which kind it is.
 *
 * A function rather than an expression because of a real bug it now
 * carries the fix for. `frames` defaults to null here so the two KINDS can
 * default differently, and the clamp below reads
 *
 *     const n = Number(v);
 *     return Number.isFinite(n) ? Math.max(lo, Math.min(hi, ...)) : dflt;
 *
 * — and `Number(null)` is 0, which IS finite. So an absent frame count fell
 * straight through the default and was clamped UP to the floor: every previz
 * rendered 121 frames instead of 144, silently, and looked entirely
 * plausible. Measured on the scratch instance: previz_shot with no `frames`
 * came back `frames: 121` and the file really had 121 of them.
 *
 * Absent is therefore decided BEFORE the clamp, and the clamp keeps its own
 * job: bounding a number somebody really sent.
 *
 * ⚠ AND A BLOCKOUT UNDER THE FLOOR IS REFUSED, NOT RAISED. This function used
 * to clamp both kinds alike, and for a blockout that was the wrong answer
 * dressed as a helpful one. MEASURED at the route: `previz_shot` with
 * `blockout: true, frames: 96` came back 200 with a real 121-frame render and
 * `frames: 121` on it, and the response said "96" nowhere — not in a note, not
 * in a warning. Somebody who wanted a shorter control clip got a longer one and
 * was told it was what they asked for. (It also meant blocking.py's own
 * BlockingError for a short blockout — the far side's version of this rule —
 * was unreachable from this app, because the clamp always ran first.)
 *
 * The two kinds differ because the number means different things to them:
 *
 *   PREVIZ    a clip a person watches. 96 frames is a taste, the floor is only
 *             there to stop a file that would be refused downstream, and
 *             rounding up costs a second of workbench render. CLAMPED, as it
 *             always was.
 *   BLOCKOUT  a CONTROL clip. 121 is the contract WAN 2.1 VACE was measured
 *             against and a shorter one is not a shorter control clip, it is
 *             not one: it gets clamped to its last frame downstream, so the end
 *             of the shot conditions on a frozen frame. There is no honest way
 *             to give a caller who asked for 96 what they asked for, and this
 *             repository's rule is that the refusal IS the feature. REFUSED,
 *             in a sentence that says the number, the contract and the way out.
 *
 * The refusal is thrown, so it reaches the route as the 400 every other refusal
 * on that route is, and it is thrown BEFORE blenderStatus — nothing is spawned
 * and no `render: false` caller gets a different answer from a rendering one.
 */
export function framesFor(frames, { blockout = false } = {}) {
  const dflt = blockout ? BLOCKOUT_FRAMES_DEFAULT : FRAMES_DEFAULT;
  if (frames === null || frames === undefined || frames === "") return dflt;
  const n = Math.round(Number(frames));
  if (blockout && Number.isFinite(n) && n < FRAMES_MIN) {
    throw new Error(
      `A blockout of ${n} frames is not a shorter control clip — it is not a control clip. `
      + `The contract WAN 2.1 VACE was measured against is ${CONTROL_SPEC.width}x`
      + `${CONTROL_SPEC.height} at ${CONTROL_SPEC.fps} fps and at least ${FRAMES_MIN} frames; `
      + `a clip shorter than that gets clamped to its last frame downstream, so the end of the `
      + `shot conditions on one frozen picture. Ask for ${FRAMES_MIN} or more, or leave `
      + "`frames` out and get the floor exactly. If what you wanted was a quick look rather "
      + `than a control clip, drop \`blockout\` — a previz has no floor to speak of and ${n} `
      + "frames is a fine length for one.");
  }
  return clamp(frames, FRAMES_MIN, FRAMES_MAX, dflt);
}
/**
 * ⚠ IMPORTED, NOT TYPED. This line used to read `const FRAMES_MIN = 121;` and
 * the number appeared three times in two repositories: here, in
 * server/control/control.js's CONTROL_SPEC, and in the Blender toolkit's own
 * CONTROL_MIN_FRAMES across a licence boundary.
 *
 * Three copies of a number is two too many. The toolkit's stays — it is across
 * the boundary and it is the authority, and it verifies every clip it writes
 * against its own spec after the render. What is gone is the SECOND copy on
 * this side of the boundary, which could drift from the gate that enforces it
 * without anything failing: a previz written at 121 while the control path had
 * moved to 129 would render, pass here, and be refused an hour later by
 * validateControlClip — which is the exact minute-of-GPU failure the comment
 * above describes, one layer up.
 */
const FRAMES_MIN = CONTROL_SPEC.minFrames;
const FRAMES_MAX = 480;

/** Written beside our own outputs, the way the toolkit writes one beside its. */
const SIDECAR_SUFFIX = ".previz.json";
const USE_HUMAN = "human-review";

/**
 * THE BLOCKOUT'S OWN SUFFIX AND ITS OWN USE, and both are load-bearing.
 *
 * A previz and a blockout are the same grey boxes with opposite standings, so
 * the one thing that must never happen is a reader picking up one and getting
 * the other's sidecar. `.previz.json` says human-review and `.blockout.json`
 * says vace-control; the toolkit's refcheck.py carries the same three-word
 * vocabulary (USE_REFERENCE / USE_HUMAN / USE_CONTROL) and refuses a file by
 * name when the `use` is not the one being asked for.
 */
const BLOCKOUT_SIDECAR_SUFFIX = ".blockout.json";
const USE_CONTROL = "vace-control";
/** The spec a blockout was staged from, written beside it and never inlined
 *  into the project document: it is the input, and the input belongs on disk
 *  next to the output it produced. */
const SPEC_SUFFIX = ".spec.json";

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
};

/* ─────────────────────────────────────────────────── what can be asked for */

/**
 * The vocabulary, and whether Blender agrees with it. -> the catalogue.
 *
 * The words are listed unconditionally, because moves.js needs no Blender and
 * a shot plan is worth having on a laptop. `probe` costs one Blender launch
 * (~4s) and asks the toolkit what IT knows, which is the only way the two lists
 * can be shown to have drifted — a move renamed on the far side would otherwise
 * fail one render at a time, months later, with a message about an unknown
 * move and no clue that this table is the stale half.
 */
export async function previzCatalogue({ probe = false } = {}) {
  const st = await blenderStatus();
  /* THE SETS ARE DERIVED BEFORE THE PAYLOAD IS BUILT, not only under `probe`.
   * This is the one fetch every surface reads to build its set picker, so it
   * has to carry the toolkit's list rather than this app's memory of it. It
   * costs one Blender launch (2.9 s, measured) on the first call of a process
   * and nothing afterwards — the answer is cached here and on disk under the
   * toolkit's version stamp. With no Blender installed it costs nothing and
   * comes back flagged `stale`, which is the honest laptop answer. */
  const sets = await toolkitSets();
  const out = {
    ...st,
    scenes: SCENES, takes: TAKES, angles: ANGLES, framings: FRAMINGS,
    /* WHERE THAT LIST CAME FROM, in the payload, because a surface that shows a
     * picker should be able to say whether it is showing the toolkit's answer
     * or the last thing this app remembered. `meshes` is the same table
     * /api/mv/blender serves, keyed by the same derived set names. */
    sets: {
      names: [...SETS], source: sets.source, stale: sets.stale, failed: sets.failed,
      stamp: sets.stamp, at: sets.at, why: sets.why || [],
      meshes: BUILTINS, meshesFrom: sets.meshesFrom,
    },
    /* THE TWO KINDS ANSWER `frames` DIFFERENTLY, and a surface has to be able
     * to read that rather than guess it. `below` is the whole difference: a
     * previz rounds up, a blockout refuses. A page or a tool that told somebody
     * "asking below 121 is rounded up, not refused" would be right about one
     * kind and wrong about the other, and the one it is wrong about is the one
     * that costs half an hour of GPU downstream. */
    frames: { default: FRAMES_DEFAULT, min: FRAMES_MIN, max: FRAMES_MAX,
              below: "rounded up to the floor" },
    /* WHAT A BLOCKOUT IS, from the data rather than from prose typed into a
     * page — the same rule the control catalogue already holds. A card that
     * held its own copy of "121" or its own list of prop kinds would go stale
     * in silence, which is the exact failure this whole fetch exists for. */
    blockout: {
      frames: BLOCKOUT_FRAMES_DEFAULT, use: USE_CONTROL,
      sidecar: BLOCKOUT_SIDECAR_SUFFIX,
      framesMin: FRAMES_MIN, framesBelow: "refused",
      framesWhy: `A blockout is a CONTROL clip, so ${FRAMES_MIN} is a contract rather than a `
        + "floor to round up to: a shorter clip gets clamped to its last frame downstream and "
        + "the end of the shot conditions on one frozen picture. Asking for fewer is refused, "
        + "in a sentence, before Blender is launched. A previz has no such rule — the same "
        + "number there is rounded up and rendered.",
      why: "The same grey boxes as a previz, rendered at the control-video contract and "
        + "marked for a model rather than for a person. It goes on WAN 2.1 VACE's "
        + "control_video, which is the measured path — a previz never does.",
    },
    spec: {
      version: SPEC_VERSION, propKinds: PROP_KINDS,
      figureHeight: FIGURE_HEIGHT_DEFAULT, figureHeightRange: FIGURE_HEIGHT_RANGE,
      units: "metres, +Z up; `at` is where the thing STANDS, not its centre",
      /* ⚠ THE PATH IS STRAIGHT; THE CLOCK IS NOT. This line used to stop at
       * "a straight walk", which a caller reads as "interpolate linearly" —
       * and the toolkit stages the walk on a smoothstep, so a linear guess is
       * out by up to 9.6% of the path (0.674 m on a 7 m walk). Said here as
       * well as in previz/spec.py because this string is what a surface shows
       * somebody writing the spec, and it was the half-sentence. */
      walk: "`to` is a STRAIGHT PATH from `at` on frame 1 to `to` on the last frame, walked "
        + "on a smoothstep clock: u = (frame-1)/(frames-1), s = u*u*(3-2*u), position = "
        + "at + (to-at)*s. Not a linear ramp — it starts and ends at rest. previz/spec.py's "
        + "walk_fraction() and walk_position() are that timing, executable.",
    },
    moves: listMoves().map((name) => {
      const { key, entry, via } = resolveMove(name);
      return { name, canonical: key, alias: !!via, label: entry.label, gist: entry.gist,
               board_move: entry.boardMove, board_move_exact: entry.boardMoveExact };
    }),
  };
  if (probe && st.installed) {
    const r = await runPreviz(["list"], { timeoutMs: 120e3 });
    out.blenderVersion = r.blender;
    out.toolkit = { scenes: r.scenes, moves: r.moves, takes: r.takes, angles: r.angles };
    /* THE DISAGREEMENT IS THE POINT OF PROBING. Either direction is a real
     * fault: a name here the toolkit does not know renders nothing, and a name
     * the toolkit has that is missing here is a move nobody can reach.
     *
     * The two vocabularies have to be compared against the RIGHT list. A
     * composite is a ShotList over there and answers on `takes`, not `moves`;
     * comparing everything against `moves` reported follow_orbit and crane_plan
     * as missing geometry on the first run of this check, which they are not. */
    const known = new Set([...r.moves, ...r.takes]);
    const names = [...new Set(out.moves.map((m) => m.name))];
    out.drift = {
      wordsWithoutGeometry: names.filter((m) => !known.has(m)),
      geometryWithoutWords: [...known].filter((m) => !names.includes(m)),
      /* ⚠ THE SET CHECK NOW LOOKS BOTH WAYS, and it used to look one way only:
       * `SCENES.filter(s => !r.scenes.includes(s))` could see a set that had
       * been DELETED over there and was blind to one that had been ADDED, which
       * is the direction that actually happened. A set the toolkit has and this
       * side never names is a set nobody can reach — worth exactly as much
       * noise as a set that has gone.
       *
       * Both directions are measured against SETS_FALLBACK rather than SETS,
       * deliberately: SETS is the toolkit's own answer copied into this process,
       * so comparing it with the toolkit would compare a thing to itself and
       * always agree. The fallback is the only hand-typed set list left in the
       * app, it is what a machine with no Blender shows, and previz_test.js
       * fails the commit when either direction is non-empty. */
      setsWithoutGeometry: SETS_FALLBACK.filter((s) => !r.scenes.includes(s)),
      geometryWithoutSets: r.scenes.filter((s) => !SETS_FALLBACK.includes(s)),
      /* A set that is reachable but whose mesh inventory nobody has. Not a
       * failure — the render is the authority and says what is in there — but
       * it is why a picker may have a set with no meshes under it. */
      setsWithoutMeshes: (sets.meshesFrom
        ? Object.keys(sets.meshesFrom).filter((k) => sets.meshesFrom[k] === "unknown") : []),
      /* THE SPEC VOCABULARY, COMPARED THE SAME WAY. A prop kind this side
       * offers and the toolkit refuses is a form field that always fails; a
       * kind the toolkit builds and this side never offers is a capability
       * nobody can reach. Both are reported, and so is a version bump — a spec
       * written against version 1 and read by version 2 is the silent kind of
       * wrong this whole block exists to make loud. */
      propKindsWithoutGeometry: PROP_KINDS.filter((k) => !(r.prop_kinds || []).includes(k)),
      geometryWithoutPropKinds: (r.prop_kinds || []).filter((k) => !PROP_KINDS.includes(k)),
      specVersion: r.spec_version === SPEC_VERSION ? null
        : { here: SPEC_VERSION, toolkit: r.spec_version ?? null },
      /* A toolkit too old to take a spec at all. Named rather than discovered
       * by an "unrecognized arguments: --spec" a minute into a render. */
      /* ⚠ "move_args" JOINS THE TWO THAT WERE ALREADY HERE, and it earns its
       * place the same way: a toolkit too old to take `--move-arg` answers an
       * unrecognized-argument error a minute into a render, and this names it
       * for free instead. The list is what THIS app sends, so a capability
       * added here and not there is caught by the same probe. */
      supportsMissing: ["spec", "blockout", "move_args"].filter((k) => !(r.supports || []).includes(k)),
      /* THE STEERING VOCABULARY, REPORTED RATHER THAN COPIED. `framings` and
       * `body_parts` are the legal VALUES of two move keywords, and they live
       * on the far side with the classes that read them. They are surfaced
       * under `probe` so a surface can build a menu out of the toolkit's own
       * answer; nothing here keeps a copy, because a copy of somebody else’s
       * list is the failure this whole block exists to catch. */
      moveArgVocabulary: {
        framings: r.framings || null, bodyParts: r.body_parts || null,
        bodyFractions: r.body_fractions || null, syntax: r.move_arg_syntax || null,
      },
    };
    out.agrees = !out.drift.wordsWithoutGeometry.length
      && !out.drift.geometryWithoutWords.length
      && !out.drift.setsWithoutGeometry.length && !out.drift.geometryWithoutSets.length
      && !out.drift.propKindsWithoutGeometry.length
      && !out.drift.geometryWithoutPropKinds.length
      && !out.drift.specVersion && !out.drift.supportsMissing.length;
  }
  return out;
}

/* ───────────────────────────────────── the camera angle, out of the track */

/*
 * props.py places a reference camera along
 *     dir = (cos(el)·sin(az), −cos(el)·cos(az), sin(el))
 * measured from the subject OUTWARDS, so azimuth 0 sits on −Y (its "front")
 * and elevation is height above the horizon. moves.py uses the same convention
 * for a move's bearing. Inverting it needs nothing from the toolkit but the
 * unit vector its own --track file already contains — which is why the track is
 * always written: recomputing the pose on this side of the boundary would be
 * the copy the licence forbids and the drift everything else here avoids.
 */
const DEG = 180 / Math.PI;

export function angleFromTrack(track, { u = 0.5 } = {}) {
  const fwd = track?.forward;
  if (!Array.isArray(fwd) || !fwd.length) {
    throw new Error("That camera track has no forward vectors — re-render the previz so it writes one.");
  }
  const uu = Math.max(0, Math.min(1, Number(u) || 0));
  const i = Math.round(uu * (fwd.length - 1));
  const [fx, fy, fz] = fwd[i];
  // subject → camera is the reverse of where the camera is looking.
  const dx = -fx, dy = -fy, dz = -fz;
  const len = Math.hypot(dx, dy, dz) || 1;
  return {
    u: uu,
    frame: track.frames?.[i] ?? i + 1,
    azimuth: Math.round(Math.atan2(dx, -dy) * DEG * 10) / 10,
    elevation: Math.round(Math.asin(Math.max(-1, Math.min(1, dz / len))) * DEG * 10) / 10,
    lens_mm: track.lens_mm?.[i] ?? null,
    eye: track.eye?.[i] ?? null,
    /* ⚠ THE HONEST LIMIT. This is the camera's view direction, which is the
     * subject→camera direction only while the camera is aiming AT the subject.
     * offset_follow aims at a null beside and behind it, deliberately, and a
     * crane at full tip is looking at the floor — for those the viewpoint is
     * approximate by exactly the aim offset. Said out loud rather than hidden,
     * because a number that is quietly wrong is worse than one that is
     * labelled. Pass an explicit angle when it matters. */
    aims_at_subject: !["offset_follow", "crane", "floor_rise"].includes(track.move || ""),
  };
}

/* ─────────────────────────────────────────────────────────── the renders */

/**
 * Deterministic, collision-free, and readable in a folder listing.
 *
 * ⚠ THE SET IS PART OF THE NAME, and it was not at first. Re-rendering the same
 * move in a different set then wrote to the same path — so blocking crane_plan
 * on 'street' (which works) and then on 'atrium' (which the toolkit refuses,
 * because the 24 m rise puts the lens through the cap) left the good clip
 * overwritten by the bad one, with the project document still pointing at it
 * and reporting success from the earlier run. Found by running both, in that
 * order. A deterministic name is only safe when it is a function of everything
 * that changes the picture.
 */
const stem = (kind, segKey, scene, move) =>
  [kind, segKey, scene, move].map((s) => String(s).replace(/[^\w-]+/g, "")).join("_");

/**
 * A sidecar of our own, beside the .mp4, in the shape the toolkit uses.
 *
 * The toolkit writes one beside every STILL and none beside a clip, because
 * nothing was ever going to mistake an mp4 for a reference. Writing one anyway
 * costs a few hundred bytes and means the mark travels with the file: anything
 * that later finds this clip and asks what it is for gets "human-review" from
 * the file system, not from remembering to look it up here.
 */
async function markHumanReview(outPath, payload) {
  await writeFile(outPath + SIDECAR_SUFFIX,
    JSON.stringify({ ...payload, path: outPath, use: USE_HUMAN, panels: null }, null, 2), "utf8");
  return path.basename(outPath) + SIDECAR_SUFFIX;
}

/**
 * THE BLOCKOUT'S SIDECAR — the provenance, and the ground truth beside it.
 *
 * Everything markHumanReview writes, plus the two things that make this clip a
 * measurement rather than a picture:
 *
 *   specSha256  the staging's identity, computed by the TOOLKIT and recorded
 *               here rather than recomputed. One authority for the number, on
 *               the side of the licence boundary that actually built the set —
 *               the same argument FRAMES_MIN makes one layer up.
 *   projection  for every figure, on every frame, the pixel position of its
 *               neck and its hip from the camera arithmetic, plus the worst
 *               disagreement between that arithmetic and Blender's own
 *               world_to_camera_view over the whole clip. THAT is what a
 *               consistency measurement reads: it is what "the figure was HERE
 *               on frame 47" means before any model has drawn anything.
 *
 * It is a file rather than a row in the project document on purpose. The table
 * is 121 frames times two points times however many figures, the document is
 * read and rewritten on every action in this workflow, and a measurement that
 * makes every unrelated write slower is a measurement people turn off.
 */
async function markBlockout(outPath, payload) {
  await writeFile(outPath + BLOCKOUT_SIDECAR_SUFFIX,
    JSON.stringify({ ...payload, path: outPath, use: USE_CONTROL, panels: null }, null, 2), "utf8");
  return path.basename(outPath) + BLOCKOUT_SIDECAR_SUFFIX;
}

/**
 * THE WHOLE SHOT PATH, in one call, because the three artefacts are one answer.
 *
 * Order matters and is not an accident: the WORDS are built first and returned
 * even when everything after them fails, because they are the part that reaches
 * the model and they cost nothing. Then the previz clip, which also writes the
 * track. Then — only if a subject was named — the reference frame, at the angle
 * the track says the camera was at.
 *
 * `reference` is opt-in and needs a subject (a builtin mesh or a model file),
 * for the reason at the top of this file: there is nothing in a grey-box set
 * worth handing to H3, and rendering the set itself is the failure the gate
 * exists to catch.
 */
export async function previzShot(slug, {
  segmentId = null, move = "push_in", scene = "corridor",
  frames = null, lens = null,
  /* `framing` defaults to NULL, not to "medium". It used to arrive as "medium"
   * on every call and shotPlan cannot tell a default from a choice, so it beat
   * `--move-arg framing=full` on every push-in that asked for one: the shot
   * recorded "cut at the waist on a figure" against a clip holding the whole
   * body. shotPlan still falls back to medium when nobody chose and no keyword
   * answers, so a caller that passes nothing sees no change. */
  framing = null, subject = null, third = null, angle = null,
  pronoun = null, side = null, action = null, lensFeel = null, lighting = null,
  render = true, reference = null, u = 0.5,
  blockout = false, spec = null, moveArgs = null,
} = {}) {
  /* `frames` defaults to NULL rather than to 144, so the two kinds can default
   * differently without the caller having to know which. A number that was
   * passed still wins either way — it is only the absence that is answered
   * per kind. */
  const wantBlockout = blockout === true || blockout === "true";
  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  if (doc.kind === "audiobook") throw new Error("Previz is for video projects.");

  const seg = segmentId
    ? doc.segments.find((s) => s.id === segmentId || s.index === segmentId || s.index === Number(segmentId))
    : null;
  if (segmentId && !seg) throw new Error(`No such segment: ${segmentId}`);
  /* ⚠ THE SET IS CHECKED AGAINST THE TOOLKIT, NOT AGAINST A LIST TYPED HERE.
   *
   * This guard is the one that broke: with seven names hard-coded above it, the
   * Studio refused `stage` — a set the toolkit had already built — with a
   * sentence naming the seven it did know. Now the list is asked for.
   *
   * And it only refuses when this side actually KNOWS the list. `failed` means
   * Blender is installed but would not answer (busy card, timeout); refusing on
   * a fallback in that state would reject a set that exists, so the request is
   * passed to the toolkit, which is the authority and answers with its own
   * list. A missing Blender is different — nothing can render at all — and a
   * typo there is still worth catching for free. */
  /* ⚠ THE DERIVE ONLY RUNS TO DECIDE A REFUSAL, never to decide an accept.
   * A set already in SETS is taken at once, so `render: false` keeps the
   * promise it makes ("only the words, spending nothing") and a rendering call
   * does not pay for a list it is about to launch Blender anyway. Only a name
   * this side does not recognise is worth 3 s of Blender to check, because
   * that is the only case where the answer could be a refusal — and refusing
   * out of a stale list is the whole bug. */
  if (!SETS.includes(scene)) {
    const known = await toolkitSets();
    if (!known.sets.includes(scene) && !known.failed) {
      throw new Error(`No previz set called "${scene}". The sets ${
        known.stale ? "this app last knew about" : "the toolkit reports"} are: ${known.sets.join(", ")}.`
        + (known.stale && known.why?.length ? `\n${known.why.join("\n")}` : ""));
    }
  }
  /* HOW LONG, DECIDED HERE — before blenderStatus, before the early return and
   * a long way before anything is spawned. It used to be computed just above
   * the render, which was fine while it only ever clamped; now that a blockout
   * under the floor is REFUSED (see framesFor) the position is the guarantee:
   * a request for 96 blockout frames is answered with a sentence, and no
   * Blender is launched to find that out. It also means `render: false` gives
   * the same verdict a real render would, instead of accepting a length that
   * could never have been rendered. */
  const nFrames = framesFor(frames, { blockout: wantBlockout });

  /* THE ONE COMBINATION THAT IS KNOWN TO FAIL, refused before it is spent.
   *
   * crane_plan's rise ends about 24 m up, so a capped set puts the lens through
   * the ceiling; the toolkit renders the whole clip, measures it, finds 46 of
   * 121 frames flat, and throws it away. Seventeen seconds for an answer that
   * was knowable. Swept the sets that existed on 2026-09-03 to find out which
   * ones this is true of, rather than guessing from their names: corridor,
   * room, street, turntable, dig and warship all rise clean, and ATRIUM ALONE
   * is capped. So exactly one pair is refused here and every other failure is
   * left to the toolkit, which now leads its message with the measurement. A
   * guard wider than the measurement would start refusing shots that work —
   * which is also why a set added SINCE that sweep ('stage') is not named here:
   * it has not been measured, and a guess would refuse a shot that works. */
  if (String(move).toLowerCase() === "crane_plan" && scene === "atrium") {
    throw new Error(
      "crane_plan cannot be blocked on the atrium set: the rise ends about 24 m up and the "
      + "atrium is capped, so the camera finishes inside the ceiling (measured — 46 of 121 "
      + "frames come back flat and the clip is refused as empty). Of the sets swept it is the "
      + "only closed one; corridor, room, street, turntable, dig and warship all rise clean. "
      + "Use one of those, or follow_orbit here.");
  }

  /* THE SPEC'S SET AND THE RENDER'S SET ARE ONE SET, checked here where it is
   * free rather than by the toolkit after Blender has launched.
   *
   * A spec with no `set` is FILLED IN from `scene` — a board that already
   * chose the set should not have to say it twice. A spec that names a
   * DIFFERENT set is refused rather than resolved: one of the two is a typo,
   * and picking a winner renders the set nobody asked for. */
  let staging = null;
  if (spec != null) {
    if (typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("`spec` is a blocking spec object — { set, figures, props }. "
        + "See the previz catalogue's `spec` entry for the shape.");
    }
    if (spec.set != null && String(spec.set).toLowerCase() !== scene) {
      throw new Error(`The blocking spec stages the "${spec.set}" set and this render is `
        + `building "${scene}". One of the two is a typo, and guessing which would render `
        + "the set nobody asked for — set them to the same thing, or leave the spec's `set` "
        + "out and it takes the render's.");
    }
    staging = { ...spec, set: scene };
  }

  /* 1 ── THE WORDS. Free, never fails, and the only artefact of the three that
   * is claimed to influence what the model draws. resolveMove throws with the
   * whole vocabulary when the name is wrong, before anything is spent.
   *
   * THE KEYWORDS ARE VALIDATED FIRST, above this line rather than below it,
   * and that ordering is a measured bug rather than a tidy-up. shotPlan used to
   * run before `moveArgs` had even been looked at and was never handed them, so
   * the sentence recorded against a steered shot described the UNSTEERED move:
   * "arcs 90°" against a measured 75.000° sweep, "cut at the waist" against a
   * whole body in frame, and the same paragraph word-for-word for the S1 crane
   * and its no-keyword control — two clips that differ in whether the subject
   * is in the shot at all. Only the composite refusal below still needs `plan`,
   * so only it stayed where it was. */

  /* ── THE MOVE'S OWN KEYWORDS ─────────────────────────────────────────────
   *
   * `move` names the class; `moveArgs` are the arguments that class takes —
   * how far an orbit sweeps, what a crane AIMS AT, which band a push-in has to
   * hold. Until this parameter existed the app could name a move and nothing
   * else, so every orbit on every set swept the toolkit's own default and a
   * crane aimed at a point in front of the lens rather than at the subject.
   * The toolkit takes them one at a time as `--move-arg KEY=VALUE` and states
   * its coercion rule in its own `list` payload: "KEY=VALUE, value parsed as
   * JSON or kept as a string".
   *
   * SO THE VALUE CROSSES AS JSON, ALWAYS. `JSON.stringify` here and
   * `json.loads` there is an exact round trip for every type a move class
   * takes, and it is the only mapping that is: sending the raw characters and
   * letting the far side coerce turns the STRING "75" into the NUMBER 75
   * somewhere in the middle, silently, in a value nobody would think to check.
   * A name still arrives as a name — "neck" goes over with its quotes and is
   * read back as `neck`.
   *
   * WHAT IS NOT CHECKED HERE, DELIBERATELY: which keys a move accepts. The
   * move classes live on the far side of the licence boundary, and a table of
   * their signatures typed into this file is a second vocabulary that goes
   * stale in silence — the exact failure the hard-coded set list already taught
   * this module. An unknown key comes back from the toolkit as a refusal
   * NAMING it, before a frame is rendered, and that is the better answer.
   */
  const moveArgPairs = [];
  if (moveArgs != null) {
    if (typeof moveArgs !== "object" || Array.isArray(moveArgs)) {
      throw new Error("`moveArgs` is an object of keyword arguments for the move — "
        + "{ \"aim_at\": \"neck\", \"rise\": 6.0 }. The toolkit takes each one as "
        + "--move-arg KEY=VALUE.");
    }
    for (const [k, v] of Object.entries(moveArgs)) {
      if (!/^[A-Za-z_]\w*$/.test(k)) {
        throw new Error(`\`moveArgs\` key "${k}" is not an identifier, so no move could ever `
          + "accept it as a keyword argument.");
      }
      if (v === undefined || typeof v === "function" || typeof v === "symbol"
          || typeof v === "bigint" || (typeof v === "number" && !Number.isFinite(v))) {
        throw new Error(`\`moveArgs.${k}\` is not a value that can cross the process boundary. `
          + "Give a number, a string, a boolean, or a list of them.");
      }
      moveArgPairs.push([k, JSON.stringify(v)]);
    }
  }
  /* Round-tripped through the same JSON that will cross the wire, so what gets
   * RECORDED as this shot's keywords is what the toolkit will really read —
   * not the object that was handed in. */
  const kwargs = Object.fromEntries(moveArgPairs.map(([k, v]) => [k, JSON.parse(v)]));
  const kwNote = moveArgPairs.length ? ` (${moveArgPairs.map((p) => p.join("=")).join(" ")})` : "";

  /* The keywords go in with the rest of the shot's description, so the four
   * sentences describe the shot that will be rendered rather than the move's
   * defaults. `framing` is passed through as it arrived — null when nobody
   * chose one — because shotPlan cannot otherwise tell a choice from a
   * default, and a default that looks like a choice silently overrode
   * `--move-arg framing=full` on every push-in that used it. */
  const plan = shotPlan(move, { framing, subject, third, angle, pronoun, side,
                                action, lensFeel, lighting, moveArgs: kwargs });

  /* A two-beat composite is a ShotList on the far side, not a Move, so the
   * toolkit takes it on a different flag. One `move` parameter either way:
   * from a board's point of view follow_orbit is a shot with a name, and
   * making callers know which of two tables it lives in would be this side's
   * implementation detail leaking into the vocabulary. */
  const take = MOVES[plan.move]?.take ? MOVES[plan.move].blender : null;

  /* A COMPOSITE HAS NO SINGLE MOVE TO ARGUE WITH. follow_orbit and crane_plan
   * are ShotLists on the far side, built out of two moves with their own
   * arguments, and the toolkit refuses `--move-arg` beside `--take` for exactly
   * that reason. Refused here as well so the answer costs no Blender launch —
   * and so `render: false` gives it too. */
  if (moveArgPairs.length && take) {
    throw new Error(`"${plan.requested}" is a two-beat composite — the toolkit builds it as `
      + `the shot list "${take}", not as one move — so there is no single move for `
      + `${moveArgPairs.map(([k]) => k).join(", ")} to reach. Block it with the single move `
      + "those keywords belong to (crane, orbit, push_in, floor_rise …), or drop them.");
  }

  const out = { plan, previz: null, blockout: null, reference: null, installed: true,
                moveArgs: kwargs };

  const st = await blenderStatus();
  if (!render || !st.installed) {
    out.installed = st.installed;
    /* NOT AN ERROR. A shot plan with no previz is the normal case on a machine
     * without Blender, and the words are the deliverable. Say which half is
     * missing and why, then hand back the half that worked. */
    out.note = st.installed
      ? "Words only — no render was asked for."
      : `Words only: ${st.why.join(" ")}`;
    return out;
  }

  const dir = assetsDir(slug);
  await mkdir(dir, { recursive: true });
  /* THE KIND IS PART OF THE NAME, for the reason the SET already is: a
   * deterministic name is only safe when it is a function of everything that
   * changes what the file IS. A previz and a blockout of the same move on the
   * same set are the same pixels with opposite standings, and sharing one
   * filename would let a re-render silently replace the clip a director
   * watched with a clip that is about to be handed to a model, or the reverse.
   * They are separate files, and both can exist at once. */
  const base = stem(wantBlockout ? "blockout" : "previz",
                    seg ? `s${seg.index + 1}` : "free", scene, plan.move);
  const mp4 = path.join(dir, `${base}.mp4`);
  const trackPath = path.join(dir, `${base}.track.json`);
  const specPath = path.join(dir, `${base}${SPEC_SUFFIX}`);

  /* 2 ── THE CLIP, plus its track. The track is written every time: it is free
   * (the poses are already in memory on the far side) and it is the only way
   * the reference frame can be put at the shot's own camera angle. */
  const args = ["blocking", "--out", mp4, "--scene", scene,
                "--frames", String(nFrames), "--aa", "8", "--track", trackPath];
  if (take) args.push("--take", take); else args.push("--move", plan.move);
  if (lens) args.push("--lens", String(Number(lens)));
  if (wantBlockout) args.push("--blockout");
  /* ONE FLAG PER KEYWORD, which is the shape the toolkit offers: repeatable,
   * and parsed on its side BEFORE Blender is launched, so a malformed pair
   * comes back as a sentence rather than as a traceback out of a render. */
  for (const [k, v] of moveArgPairs) args.push("--move-arg", `${k}=${v}`);
  /* THE SPEC GOES OVER AS A FILE, not as an argument. It is the toolkit's own
   * seam — a subprocess and a file handoff, never an import (LICENSE-NOTE.md)
   * — and a spec on a command line would be a JSON blob through two shells'
   * quoting rules. Written beside the clip it staged, so the input is on disk
   * next to its output and neither can be read without the other. */
  /* ⚠ WHAT WAS ALREADY HERE, BEFORE THIS ATTEMPT TOUCHES ANYTHING.
   *
   * The stem is a function of (segment, kind, scene, move) and nothing else, so
   * a re-render of the same shot lands on the same four filenames. The refusal
   * cleanup below used to remove them unconditionally, which meant a REFUSED
   * attempt destroyed the artefacts of the SUCCESSFUL one before it: MEASURED
   * on a scratch instance, one unknown key in a blocking spec — refused by the
   * toolkit before Blender staged a single object — deleted a gate-passing
   * 121-frame blockout, its track and its sidecar, and left the control route
   * answering "recorded as this shot's blockout but is not on disk any more".
   * A typo in a staging form cost a render that had already been accepted.
   *
   * So the cleanup is scoped to what THIS attempt produced: a path is removed
   * only if it did not exist beforehand, or if it has been rewritten since.
   * mtimeMs is the toolkit's own write, and the comparison is `>` on a number
   * we read a moment earlier — a file the run never touched cannot pass it. */
  const before = new Map();
  for (const p of [mp4, trackPath, specPath, mp4 + SIDECAR_SUFFIX,
                   mp4 + BLOCKOUT_SIDECAR_SUFFIX]) {
    try { before.set(p, (await stat(p)).mtimeMs); } catch { /* not there yet */ }
  }
  /* The spec of a render that SUCCEEDED is part of that render's record — it is
   * what `specFile` on the sidecar points at. Overwriting it with the staging
   * that was about to be refused would leave the surviving clip described by a
   * spec that never produced it, so the old bytes are held for the catch. */
  let priorSpec = null;
  if (staging && before.has(specPath)) {
    try { priorSpec = await readFile(specPath, "utf8"); } catch { /* gone; nothing to put back */ }
  }

  /* THE SPEC GOES OVER AS A FILE, not as an argument. It is the toolkit's own
   * seam — a subprocess and a file handoff, never an import (LICENSE-NOTE.md)
   * — and a spec on a command line would be a JSON blob through two shells'
   * quoting rules. Written beside the clip it staged, so the input is on disk
   * next to its output and neither can be read without the other. */
  if (staging) {
    await writeFile(specPath, JSON.stringify(staging, null, 2), "utf8");
    args.push("--spec", specPath);
  }

  /* Sized to a stalled process, not to the work: 144 workbench frames is
   * seconds, but a cold Blender launch on a loaded card is not instant. */
  let r;
  try {
    r = await runPreviz(args, { timeoutMs: 20 * 60e3 });
  } catch (err) {
    /* A REFUSED RENDER LEAVES A FILE, and the file is the dangerous part. The
     * toolkit writes the .mp4 and THEN verifies it, so a clip rejected as
     * "in spec but empty" (46 of 121 frames flat — the camera inside geometry)
     * is sitting on disk under a name that reads like a finished previz. The
     * error is the answer; the artefact is a trap. Take it away, and the
     * track with it, so nothing can pick either up later and believe them —
     * but only if it is THIS attempt's, per the snapshot above. */
    const mine = async (p) => {
      let now;
      try { now = (await stat(p)).mtimeMs; } catch { return false; }   // nothing there
      const was = before.get(p);
      if (was === undefined || now > was) {
        await rm(p, { force: true }).catch(() => {});
        return false;
      }
      return true;                                        // older than this attempt: not ours
    };
    const clipSurvived = await mine(mp4);
    await mine(trackPath);
    await mine(mp4 + SIDECAR_SUFFIX);
    await mine(mp4 + BLOCKOUT_SIDECAR_SUFFIX);
    /* The spec stays. It is the INPUT — the thing somebody has to edit before
     * asking again — and deleting the only copy of what was asked for is not
     * cleaning up after a refusal, it is throwing away the question. It stays
     * only while there is no earlier clip for it to misdescribe: when one
     * survived, that clip keeps the spec that really made it. */
    if (priorSpec !== null && clipSurvived) {
      await writeFile(specPath, priorSpec, "utf8").catch(() => {});
    }
    throw err;
  }

  const common = {
    move: plan.move, requested: plan.requested, scene, take,
    /* THE KEYWORDS ARE PART OF WHAT THIS CLIP IS, so they sit beside the move
     * in the sidecar. A blockout whose sidecar says `crane` and nothing else
     * cannot be told apart from the crane that aims somewhere else entirely,
     * and those are two different shots. */
    moveArgs: kwargs,
    frames: nFrames, verified: r.verified ?? null,
  };
  if (wantBlockout) {
    /* THE TABLE COMES OFF DISK, NOT OUT OF THE RESULT LINE.
     *
     * The toolkit writes the per-frame projection beside the clip and hands
     * back only a summary, because inlining it produced a 32,089-character
     * stdout line that interleaved with Blender's own banner and lost the
     * newline after the JSON — a finished render thrown away for one byte.
     * (previz/blocking.py carries the measurement.)
     *
     * So it is read here and folded into the sidecar, and the toolkit's copy
     * is then removed: ONE file describes this clip, it is named by this
     * app's convention, and a reader who finds the mp4 does not have to know
     * that two different halves each wrote a JSON beside it.
     */
    let table = null;
    if (r.projection_path) {
      try { table = JSON.parse(await readFile(r.projection_path, "utf8")); }
      catch { /* the summary below still stands; the table is the extra */ }
    }
    /* ⚠ THE TOOLKIT'S HASH, RECORDED — NOT ONE COMPUTED HERE. Two
     * implementations of a canonical form are two canonical forms, and the one
     * that matters is the one held by the side that actually built the set.
     * The same argument FRAMES_MIN makes one layer up: the far side is the
     * authority and this side quotes it. */
    const sidecar = await markBlockout(mp4, {
      ...common, kind: "previz-blockout", look: r.look ?? null,
      specFile: staging ? path.basename(specPath) : null,
      specSha256: r.spec_sha256 ?? null, spec: r.spec ?? null,
      staged: r.staged ?? null, projection: table ?? r.projection ?? null,
      why: "A CONTROL CLIP for WAN 2.1 VACE's control_video input — the measured path "
        + "(arm W1, CMA 0.924, still generating rather than reconstructing). It is NOT a "
        + "model reference and NOT the previz a director watches: those are different files "
        + "with different sidecars. `projection` is the per-frame pixel position of every "
        + "figure's neck and hip from the camera arithmetic, which is the ground truth a "
        + "consistency measurement reads.",
    });
    const rep = r.projection?.report || null;
    out.blockout = {
      file: path.basename(mp4), track: path.basename(trackPath), sidecar,
      spec: staging ? path.basename(specPath) : null,
      specSha256: r.spec_sha256 ?? null,
      frames: nFrames, scene, take, move: plan.move, moveArgs: kwargs, use: USE_CONTROL,
      look: r.look ?? null, verified: r.verified ?? null,
      /* SUMMARISED HERE, WHOLE IN THE SIDECAR. A card wants "two figures, both
       * on screen the whole way, camera arithmetic agreeing with Blender's own
       * to half a thousandth of a pixel"; nobody wants 121 pairs of numbers in
       * an HTTP response. */
      figures: (rep?.figures || []).map((f) => ({ id: f.id, onScreen: f.fraction })),
      projectionCheck: r.projection?.projection_check ?? null,
    };
  } else {
    /* ⚠ AND THE PREVIZ BRANCH REMOVES THE TOOLKIT'S TABLE TOO — see the block
     * below this if/else, which is where the removal now lives for both kinds.
     * It used to happen only here in the blockout half, and the invariant this
     * file states is "ONE FILE DESCRIBES THIS CLIP", not "one file describes a
     * blockout". MEASURED on the scratch instance: a previz rendered from a
     * spec left a 36,582-byte `previz_free_corridor_push_in.mp4.projection.json`
     * sitting in the project's assets folder, written by the other half of the
     * boundary, named by nobody, removed by nobody, and pointed at by nothing
     * in the project document.
     *
     * The table is DROPPED rather than folded into this sidecar, and that is
     * the decision, not an oversight:
     *
     *   1. It is the same invariant either way — a previz must not have two
     *      JSONs beside it any more than a blockout must. The orphan was the
     *      only genuinely wrong outcome of the three.
     *   2. This sidecar's whole job is to say `use: human-review`. A per-frame
     *      table of neck and hip pixels is the ground truth a CONSISTENCY
     *      MEASUREMENT reads — it is the blockout's payload — and putting it on
     *      the clip a director watches makes the two artefacts look alike in
     *      exactly the place this module spends forty lines keeping them apart.
     *   3. Nothing consumes it. Nothing measures a previz; a previz is
     *      disposable by nature (see the record step at the bottom, which keeps
     *      one row per shot and overwrites it). And it is not lost: the same
     *      staging with `blockout: true` renders the table and keeps it, which
     *      is the render you would already be doing if you wanted the numbers.
     *
     * Note that the toolkit writes this file for a previz WITH NO SPEC AT ALL —
     * blocking.py writes it whenever the set has figures in it, which corridor,
     * room and street all do — so this is not an edge case of the spec path. */
    const sidecar = await markHumanReview(mp4, {
      ...common, kind: "previz-blocking",
      why: "A director watches this to judge the shot. It is NOT a reference, and it is not "
        + "the blockout either — a blockout is rendered separately, to its own name, with "
        + "use:vace-control on it. This clip is for your eyes.",
    });
    out.previz = {
      file: path.basename(mp4), track: path.basename(trackPath), sidecar,
      frames: nFrames, scene, take, move: plan.move, moveArgs: kwargs, use: USE_HUMAN,
      verified: r.verified ?? null,
    };
  }

  /* ONE FILE DESCRIBES THIS CLIP — FOR BOTH KINDS, AND AFTER THE BRANCH SO A
   * THIRD KIND CANNOT FORGET IT. The blockout half above has already read the
   * table into its own sidecar; the previz half has decided not to want it.
   * Either way the toolkit's copy goes, and it goes from ONE line rather than
   * from one line per branch, which is the shape the missing half was.
   *
   * `.catch` and not `await rm(...)` bare: the clip is rendered, the sidecar is
   * written, and a file that will not delete is a tidiness problem. Failing the
   * whole call over it would throw away a good render — which is the same
   * mistake, one size up, that the refusal cleanup above exists to undo. */
  if (r.projection_path) await rm(r.projection_path, { force: true }).catch(() => {});

  /* 3 ── THE REFERENCE FRAME, at the shot's own camera angle. */
  if (reference && (reference.builtin || reference.asset)) {
    let track = null;
    try { track = JSON.parse(await readFile(trackPath, "utf8")); } catch { /* no track, use the named angle */ }
    const at = track ? angleFromTrack({ ...track, move: plan.move }, { u }) : null;
    const png = path.join(dir, `${base}_ref.png`);

    /* blender.js's renderReference, not a second copy of it. That function
     * already refuses a contact-sheet path, checks the builtin set and mesh
     * against the catalogue and the model file against the formats the importer
     * knows — all of which would otherwise be re-typed here and drift. The only
     * thing this path adds is WHERE the camera goes, and that is the azimuth /
     * elevation pair recovered from the track above. */
    const rr = await renderReference(png,
      reference.asset ? { asset: String(reference.asset) } : { builtin: String(reference.builtin) },
      { ...(at ? { azimuth: at.azimuth, elevation: at.elevation }
                : { angle: ANGLES.includes(reference.angle) ? reference.angle : "three_quarter" }),
        res: clamp(reference.res, 256, 2048, 1024),
        samples: clamp(reference.samples, 8, 256, 64) });
    /* THE SAME GATE AS ANY OTHER REFERENCE — blender.js's, not a second copy.
     * A frame that cannot prove it is a single-panel model reference is
     * reported as unsafe and is not offered as one. It stays on disk: an
     * unsafe frame is still a picture a human may want to look at. */
    const safe = await referenceSafe(png);
    out.reference = {
      file: path.basename(png), from: reference.asset ? { asset: reference.asset } : { builtin: reference.builtin },
      angle: at ? { azimuth: at.azimuth, elevation: at.elevation, frame: at.frame, u: at.u,
                    aims_at_subject: at.aims_at_subject }
                : { angle: reference.angle || "three_quarter", derived: false },
      safe: safe.safe, proven: safe.proven, why: safe.why,
      card_edge_seams: rr.exposure?.card_edge_seams ?? null,
      use: safe.proven ? "model-reference" : null,
    };
    if (!at) {
      out.reference.note = "No camera track, so this is the named angle rather than the shot's own.";
    } else if (!at.aims_at_subject) {
      out.reference.note = `${plan.move} aims off-subject by design, so this viewpoint is `
        + "approximate by the aim offset. Pass an explicit angle if the exact one matters.";
    }
  }

  /* 4 ── RECORD IT. One row per (segment, KIND, move), replaced on a re-render:
   * a previz is disposable by nature and keeping every attempt would fill the
   * assets folder with clips nobody will ever open twice. The id is derived
   * from `base`, which now carries the kind, so a blockout never replaces the
   * previz of the same move and the control route can find one without
   * accidentally resolving the other. */
  const made = out.blockout || out.previz;
  await updateProject(slug, (d) => {
    if (!Array.isArray(d.previz)) d.previz = [];
    const id = `pz_${base}`;
    const row = {
      id, segmentId: seg?.id ?? null, segmentIndex: seg?.index ?? null,
      kind: wantBlockout ? "blockout" : "previz",
      move: plan.move, requested: plan.requested, scene, take, frames: nFrames,
      moveArgs: kwargs,
      use: wantBlockout ? USE_CONTROL : USE_HUMAN,
      clipFile: made?.file ?? null, trackFile: made?.track ?? null,
      /* THE THREE THINGS THE CONTROL ROUTE NEEDS FROM A ROW, and nothing more.
       * `sidecarFile` is where the projection table lives, `specSha256` is the
       * staging's identity, `specFile` is what to edit to change it. The table
       * itself stays on disk — see markBlockout. */
      sidecarFile: made?.sidecar ?? null,
      specFile: out.blockout?.spec ?? null,
      specSha256: out.blockout?.specSha256 ?? null,
      figures: out.blockout?.figures ?? null,
      reference: out.reference, plan: { words: plan.words, board_shot: plan.board_shot },
      at: Date.now(),
    };
    const i = d.previz.findIndex((x) => x.id === id);
    if (i >= 0) d.previz[i] = row; else d.previz.push(row);
    noteRun(d, { tool: "previz_shot",
      outcome: `${seg ? `scene ${seg.index + 1}` : "free"}: ${wantBlockout ? "blockout" : "previz"} `
        + `${plan.move}${kwNote} on ${take || scene}`
        + `${out.reference ? ` + reference (${out.reference.safe ? "safe" : "REFUSED"})` : ""}` });
    return d;
  });

  return out;
}
