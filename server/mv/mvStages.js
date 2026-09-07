/**
 * AI Music Video Studio — pipeline stage machine.
 *
 * PORTED BY HAND from the aiplay.live website (no build step, no compiler):
 *   source: devsnap0812/app/helpers/musicVideo/mvStages.ts
 * Types stripped, runtime logic unchanged. Pure helpers, no DB, no I/O.
 *
 * ⚠ MV_STAGES IS ORDER-SENSITIVE AND ITS IDS ARE PERSISTED. `stageIndex` and
 * `nextStage` are positional, and on the website the current stage is stored as
 * a string in `creator_projects.metadata.mvStage` (jsonb) — here it lands in
 * `project.json`. Reordering the array silently rewrites what every stored
 * value means; renaming an id orphans every project already at it. Add new
 * stages only at the end, before "complete".
 *
 * The numbered comments are the website's own stage numbers as shown in its UI.
 * "draft" and "complete" are bookends and carry no number, which is why the
 * thirteen ids only run to Stage 11.
 */
export const MV_STAGES = [
  "draft",
  "upload_analyze", // Stage 1
  "interview", // Stage 2
  "master_gen", // Stage 3
  "story_review", // Stage 4
  "characters", // Stage 5
  "backgrounds", // Stage 6
  "storyboards", // Stage 7
  "video", // Stage 8
  "rough_cut", // Stage 9
  "finish", // Stage 10
  "publish", // Stage 11
  "complete",
];

/** Display strings, keyed by stage id. Was `Record<MvStage, string>` — the
 *  exhaustiveness the compiler enforced is now on the reader, so a new entry in
 *  MV_STAGES needs a label added here in the same edit.
 *  @type {Record<string, string>} */
export const MV_STAGE_LABELS = {
  draft: "Draft",
  upload_analyze: "Upload & analyze",
  interview: "Creative interview",
  master_gen: "Script & direction",
  story_review: "Story review",
  characters: "Characters",
  backgrounds: "Backgrounds",
  storyboards: "Storyboards",
  video: "Video clips",
  rough_cut: "Rough cut",
  finish: "Finish & export",
  publish: "Publish",
  complete: "Complete",
};

/**
 * Position in the linear flow. An unknown stage reports 0 rather than -1, so
 * callers doing progress arithmetic on it degrade to "at the start" instead of
 * going negative.
 *
 * @param {string} s
 * @returns {number}
 */
export function stageIndex(s) {
  const i = MV_STAGES.indexOf(s);
  return i === -1 ? 0 : i;
}

/**
 * Was a TS type predicate (`v is MvStage`). The `typeof` check is load-bearing
 * at runtime, not a compiler formality — this reads untrusted stored metadata.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isStage(v) {
  return typeof v === "string" && MV_STAGES.includes(v);
}

/** The next stage in the linear flow (clamps at 'complete').
 * @param {string} s
 * @returns {string} */
export function nextStage(s) {
  const i = stageIndex(s);
  return MV_STAGES[Math.min(i + 1, MV_STAGES.length - 1)];
}

/** Read the stage from a project metadata bag, defaulting to 'draft'.
 * @param {unknown} metadata
 * @returns {string} */
export function stageOf(metadata) {
  const m = metadata ?? {};
  return isStage(m.mvStage) ? m.mvStage : "draft";
}
