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

/**
 * Matched to the speed-up files on this disk. It was a literal 8, so a machine set up from the
 * Models screen (4-step files only) ran a 4-step distillation at 8 steps on
 * every scene left on "default", while the Video screen's Standard followed the
 * disk. Now both read config.js's answer:
 *
 *   without cast pictures  stepDefaults.standard (8 only where BOTH 8-step
 *                          files are on disk, else 4), as the Video screen.
 *   with cast pictures     the step count of the reference speed-up file on
 *                          disk (refTurboSteps), which h3TurboLoraFor loads at
 *                          that count; standard when there is none.
 *
 * generate.js sends it and the plan prices it, so both name the same number.
 * LTX ignores the step count.
 */
export function defaultClipSteps({ refs = false } = {}) {
  const h3 = config.video?.engines?.h3 ?? {};
  const standard = Number.isFinite(h3.stepDefaults?.standard) ? h3.stepDefaults.standard
    : Number.isFinite(h3.steps) ? h3.steps : 8;
  if (refs && (h3.refTurboSteps === 8 || h3.refTurboSteps === 4)) return h3.refTurboSteps;
  return standard;
}

/** The brief value if it names a count (a number, as generate.js has always
 *  read it), else the matched default above. */
export function clipStepsFor(brief, { refs = false } = {}) {
  return Number.isFinite(brief?.videoSteps) ? Number(brief.videoSteps) : defaultClipSteps({ refs });
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
  const withRefs = defaultClipSteps({ refs: true });
  const without = defaultClipSteps({ refs: false });
  const refFile = config.video?.engines?.h3?.refTurboSteps ?? null;
  const eightRef = refFile === 8;
  const anyFile = speedUpOnDisk();
  return {
    defaultWithRefs: withRefs,
    defaultWithoutRefs: without,
    eightStepRefFile: eightRef,
    speedUpOnDisk: anyFile,
    options: [
      { value: "", label: !anyFile
        ? `default: ${without}, the count of the speed-up files the Models screen fetches. None is on this PC yet: `
          + "get them there first, or choose 20, which needs none"
        : withRefs === without
          ? `default: ${without}, matched to the speed-up files on this PC`
          : `default: ${withRefs} with cast pictures, ${without} without, matched to the files on this PC` },
      { value: "4", label: `4: fast build (${timeWords("h3-4-native")})` },
      { value: "8", label: eightRef
        ? `8: matched reference build, the one to use with cast references (${timeWords("h3-8-native")})`
        : refFile === 4
          ? "8: the 8-step reference file is not on this PC, so 8 runs its 4-step file past its design point"
          : "8: needs the 8-step reference speed-up file, which is not on this PC" },
      { value: "20", label: `20: full model, no speed-up file (${timeWords("h3-bare-native")})` },
    ],
  };
}
