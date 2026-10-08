/**
 * THE STEP COUNT A MUSIC-VIDEO SCENE RUNS AT WHEN THE BRIEF NAMES NONE.
 *
 * Its own small file, because three readers need the same answer: generate.js
 * sends it, plan.js prices it, and the brief's step control is worded from it.
 *
 * ⚠ NOT THE LENDER'S. A friend's render is sized on the friend's PC, so the
 * collab packet does not read this: the count matched to THIS disk says
 * nothing about theirs (server/collab/packet.js keeps its own usual 8 for a
 * brief left on default, and the lender's speedUpCheck names a mismatch).
 */
import { config } from "../config.js";
import { COST_ROWS } from "./plancost.js";
import { H3_LAB_CARD_GB } from "../h3tier.js";
import { h3MatchedSteps, referenceSteps } from "../workflow.js";

/**
 * Matched to the speed-up files on this disk. It was a literal 8, so a machine set up from the
 * Models screen (4-step files only) ran a 4-step distillation at 8 steps on
 * every scene left on "default", while the Video screen's Standard followed the
 * disk. Now both read config.js's answer:
 *
 *   without cast pictures  stepDefaults.standard (config.js resolveH3Steps: 8
 *                          or 4 where that speed-up is on disk, else the full
 *                          model's 20), as the Video screen.
 *   with cast pictures     the step count of the reference speed-up file on
 *                          disk (refTurboSteps), which h3TurboLoraFor loads at
 *                          that count; standard when there is none.
 *
 * generate.js sends it and the plan prices it, so both name the same number.
 * LTX ignores the step count. With cast pictures the answer is workflow.js
 * referenceSteps, the same one /api/status and the Video screen's Keep my
 * character read (read live, so a test that moves refTurboSteps moves it).
 */
export function defaultClipSteps({ refs = false } = {}) {
  const h3 = config.video?.engines?.h3 ?? {};
  const standard = Number.isFinite(h3.stepDefaults?.standard) ? h3.stepDefaults.standard
    : Number.isFinite(h3.steps) ? h3.steps : 8;
  if (refs) return referenceSteps(h3) ?? standard;
  return standard;
}

/** The count the brief names, as a number, or null. */
const briefSteps = (brief) => (Number.isFinite(brief?.videoSteps) ? Number(brief.videoSteps) : null);

/** A count the brief names that runs the reference build below its own count
 *  (the Fast band, workflow.js h3MatchedSteps): Hex Appeal v1 ran 3 steps on
 *  the 4-step reference file and came back "burned" (the REWIND CONFIGS). */
function raisedOnRefs(brief, refs) {
  const asked = briefSteps(brief);
  if (!refs || asked === null) return null;
  const h3 = config.video?.engines?.h3 ?? {};
  const m = h3MatchedSteps(h3, { steps: asked, refs: true });
  if (m.raised) return m;
  /* ...AND NOT ABOVE IT IN THE 8-STEP BAND WHERE NO 8-STEP REFERENCE BUILD IS
   * HERE (NVIDIA and a card nobody could read, where config.js judges each
   * path by its own file). The reference path then loads a 4-step file there
   * (the "Video references" row's ref2v v0.1, or the fl2v 4-step), which the
   * Video screen and every door refuse at 8 (config.js refBuilds, review of
   * the port, 2026-10-08), so a brief's 8 failed every scene with cast
   * pictures. It runs the reference build's own 4 instead, and the shot says
   * so, as the brief's 3 is raised to 4 above. AMD, Intel and the CPU keep
   * main's rule (no per-path reading): the brief's count stands. */
  const own = referenceSteps(h3);
  if (h3.plainBuilds && h3.refBuilds && h3.refBuilds.eight === false && h3.refBuilds.four === true && own === 4
      && asked > (h3.turbo4MaxSteps ?? 5) && asked <= (h3.turboMaxSteps ?? 12)) {
    return { steps: 4, asked, raised: false, lowered: true, lora: h3.refTurboLora4 ?? null, made: 4 };
  }
  return null;
}

/** The brief value if it names a count (a number, as generate.js has always
 *  read it), else the matched default above. A scene with cast pictures never
 *  runs below the loaded reference file's own count: the brief's 3 becomes the
 *  4-step file's 4, and clipStepsNote says so on the shot. */
export function clipStepsFor(brief, { refs = false } = {}) {
  const asked = briefSteps(brief);
  if (asked === null) return defaultClipSteps({ refs });
  const m = raisedOnRefs(brief, refs);
  return m ? m.steps : asked;
}

/** The sentence when clipStepsFor raised (or, on NVIDIA without an 8-step
 *  reference build, lowered) the brief's count on a scene with cast pictures
 *  (videoPlan's "steps" warning, in the music video's words), else null. */
export function clipStepsNote(brief, { refs = false } = {}) {
  const m = raisedOnRefs(brief, refs);
  if (!m) return null;
  return `With cast pictures this scene runs ${m.steps} steps, not the brief's ${m.asked}: the reference build that `
    + `loads is ${m.made === 8 ? "an" : "a"} ${m.made}-step file, and it runs at its own step count.`;
}

/** Is any H3 speed-up file on this disk? The rule server/fit.js's videoSteps
 *  default uses (any build config.js found), plus the reference file alone. */
function speedUpOnDisk() {
  const h3 = config.video?.engines?.h3 ?? {};
  return Object.values(h3.turboBuilds || {}).some(Boolean) || h3.refTurboSteps === 8 || h3.refTurboSteps === 4;
}

/** "about 2.6 min per 5 s scene at 1344x768, measured on a 16 GB card", from
 *  plancost.js's own measured row, so the label and the plan price one number. */
function timeWords(rowId) {
  const r = COST_ROWS.find((x) => x.id === rowId);
  if (!r) return "";
  const min = r.wall / 60;
  return `about ${min < 10 ? Math.round(min * 10) / 10 : Math.round(min)} min per ${Math.round(r.seconds)} s scene `
    + `at ${r.w}x${r.h}, measured on a ${H3_LAB_CARD_GB} GB card`;
}

/**
 * The brief's step choices, worded from what is on this disk: the page shows
 * these labels and mv_open_project returns them. "8" only calls itself the
 * reference build to use when the 8-step reference file is here, and
 * "default" says so when no speed-up file is here at all.
 */
export function stepChoices() {
  const h3 = config.video?.engines?.h3 ?? {};
  const withRefs = defaultClipSteps({ refs: true });
  const without = defaultClipSteps({ refs: false });
  const refFile = h3.refTurboSteps ?? null;
  const eightRef = refFile === 8;
  const anyFile = speedUpOnDisk();
  /* A count above the speed-up range is the full model, which no speed-up
   * file is made for. Since every speed-up became optional (2026-09-25) the
   * default on a disk without one is that 20, and the old words called it
   * "the count of the speed-up files the Models screen fetches" (no file), or
   * "matched to the speed-up files on this PC" (TaoMate alone, Fast's file). */
  const full = (n) => Number(n) > (h3.turboMaxSteps ?? 12);
  const say = (n) => (full(n) ? `${n} (the full model)` : `${n}`);
  /* AMD, Intel and the CPU keep main's words exactly (Bucky's rule):
   * config.js makes no per-path reading there (plainBuilds null).
   * mv/cardfit_test.js pins both branches. */
  const defaultLabel = !h3.plainBuilds
    ? (!anyFile
      ? `default: ${without}, the count of the speed-up files the Models screen fetches. None is on this PC yet: `
        + "get them there first, or choose 20, which needs none"
      : withRefs === without
        ? `default: ${without}, matched to the speed-up files on this PC`
        : `default: ${withRefs} with cast pictures, ${without} without, matched to the files on this PC`)
    : !anyFile
    ? full(without)
      ? `default: ${without}, the full model: no speed-up file is on this PC yet (the Models screen offers them, for fewer steps)`
      : `default: ${without}: no speed-up file is on this PC yet. Get them on the Models screen first, or choose 20, which needs none`
    : withRefs === without
      ? full(without)
        ? `default: ${without}, the full model: no speed-up file on this PC is made for a scene's default (the Models screen offers the 8-step one)`
        : `default: ${without}, matched to the speed-up files on this PC`
      : `default: ${say(withRefs)} with cast pictures, ${say(without)} without`
        + (full(withRefs) || full(without) ? "" : ", matched to the files on this PC");
  /* "4" loads a 4-step file on either path (config.js plainBuilds, refBuilds):
   * said when neither is here, since the render is refused without one. */
  const noFour = h3.plainBuilds?.four === false && h3.refBuilds?.four === false;
  /* "8", BY THE FILE THE REFERENCE PATH LOADS THERE (NVIDIA and a card
   * nobody could read; AMD, Intel and the CPU keep main's words below). A
   * fresh NVIDIA install has the H3 row's fl2v 8-step file and no reference
   * build, and refTurboLora falls back to it: "8: matched reference build"
   * named a build that is not on the PC (review of the port, 2026-10-08). With
   * a 4-step reference file only, a scene with cast pictures runs 4 there
   * (clipStepsFor), which the label now says. */
  const refName = String(h3.refTurboLora || "");
  const eightPerPath = () => {
    if (eightRef && /ref2v/i.test(refName)) return `8: matched reference build, the one to use with cast references (${timeWords("h3-8-native")})`;
    if (eightRef) return `8: the 8-step speed-up, with cast pictures too (${timeWords("h3-8-native")}); the 8-step reference build, `
      + "measured for keeping a character, is not on this PC";
    const plain = h3.plainBuilds?.eight === true ? "" : "; needs the 8-step speed-up file, which is not on this PC";
    if (refFile === 4) return `8: without cast pictures${plain}; a scene with cast pictures runs 4, its reference build's own count `
      + "(the 8-step reference build is not on this PC)";
    return `8: needs the 8-step speed-up file${h3.plainBuilds?.eight === true ? " for cast pictures" : ""}, which is not on this PC`;
  };
  return {
    defaultWithRefs: withRefs,
    defaultWithoutRefs: without,
    eightStepRefFile: eightRef,
    speedUpOnDisk: anyFile,
    options: [
      { value: "", label: defaultLabel },
      { value: "4", label: `4: fast build (${timeWords("h3-4-native")})`
        + (noFour ? "; needs the 4-step speed-up file, which is not on this PC (the Models screen offers it)" : "") },
      { value: "8", label: h3.plainBuilds ? eightPerPath() : eightRef
        ? `8: matched reference build, the one to use with cast references (${timeWords("h3-8-native")})`
        : refFile === 4
          ? "8: the 8-step reference file is not on this PC, so 8 runs its 4-step file past its design point"
          : "8: needs the 8-step reference speed-up file, which is not on this PC" },
      { value: "20", label: `20: full model, no speed-up file (${timeWords("h3-bare-native")})` },
    ],
  };
}
