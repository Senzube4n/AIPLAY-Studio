/**
 * PLAIN WORDS FOR A RUN (UI_PLAN B4).
 *
 * The music-video Activity feed prints each run's tool name, "generate_clip",
 * which is the agent's word for it and not a newcomer's. runWords(run) turns a
 * run record ({tool, outcome, at}, as server/mv/store.js noteRun writes it)
 * into "Rendered scene 12", and hands the tool name back as `title`, so it
 * moves into the row's tooltip instead of disappearing: the name is still what
 * the provenance ledger and an agent use.
 *
 * WIRED in renderRail() in web/mv.js, the <b> in `.feedhead`:
 *   const w = runWords(r);  →  <b title="${esc(w.title)}">${esc(w.text)}</b>
 * server/welcome/level_test.js holds this file to every tool noteRun writes,
 * so a new kind of run cannot reach the feed as snake_case.
 */

/* "scene 12" out of an outcome such as "scene 12 → clip_0012.mp4 (seed …)". */
const scene = (r) => {
  const m = /\bscene (\d+)/i.exec(String(r?.outcome || ""));
  return m ? `scene ${m[1]}` : "a scene";
};
/* "character Kaelith" out of "character Kaelith: 2 takes"; what a sheet was of. */
const subject = (r, fallback) => {
  const head = String(r?.outcome || "").split(/[:→(]/)[0].trim();
  return head && head.length <= 48 ? head : fallback;
};

const WORDS = {
  analyze: "Analysed the song",
  segment: "Cut the song into scenes",
  import_song: "Brought in the song",
  attach_song: "Attached the song",
  set_brief: "Saved the brief",
  set_bible: "Saved the script",
  mv_set_bible: "Saved the script",
  bible_spec: "Read the script's rules",
  lint: "Checked the script",
  set_board: "Saved a storyboard",
  mv_set_board: "Saved a storyboard",
  mv_set_shot: "Set a shot",
  generate_asset: (r) => `Drew ${subject(r, "a sheet")}`,
  blender_asset: (r) => `Drew ${subject(r, "a sheet")} in Blender`,
  generate_board_frames: "Drew storyboard frames",
  add_asset: (r) => `Added ${subject(r, "someone").replace(/ declared$/, "")} to the cast`,
  update_asset: (r) => `Changed ${subject(r, "a cast entry")}`,
  import_asset: (r) => {
    const who = String(r?.outcome || "").split(":")[1]?.trim();
    return `Brought in a picture${who ? ` for ${who}` : ""}`;
  },
  pick_take: "Picked a take",
  mesh_asset: "Made a 3D model",
  mesh_rig: "Rigged a 3D model",
  previz_shot: (r) => `Blocked out ${scene(r)}`,
  control_render: (r) => `Rendered ${scene(r)} from a control video`,
  generate_clip: (r) => `Rendered ${scene(r)}`,
  regen_clip: (r) => `Rendered ${scene(r)} again`,
  regen_by_clip_id: (r) => `Rendered ${scene(r)} again`,
  regen_stale: "Rendered the scenes that changed",
  mv_regen_stale: "Rendered the scenes that changed",
  import_clip: (r) => `Brought in a clip for ${scene(r)}`,
  /* server/mv/generate.js: a clip still rendering (or still queued) past the
   * two-hour wait, and one of those that then did not land. */
  clip_late: (r) => `Still waiting on ${scene(r)}`,
  clip_late_lost: (r) => `Lost the late render of ${scene(r)}`,
  build_timeline: "Built the timeline",
  read_timeline: "Read the timeline",
  render_video: "Rendered the video",
  studio_bounce: "Exported from Studio",
  plan_propose: "Proposed a plan",
  plan_discard: "Discarded a plan",
  plan_run: "Finished the plan",
  plan_step: "Ran a step of the plan",
};

/* Anything not in the table still reads as words: "ab_sfx_render" becomes
 * "Sfx render". Better than snake_case; the table is where it gets good. */
function words(tool) {
  const t = tool.replace(/^(mv|ab)_/, "").replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "A run";
}

/** {text, title}: what the row says, and the tool name for its tooltip. */
export function runWords(run) {
  const tool = String(run?.tool || "");
  const w = WORDS[tool];
  const text = typeof w === "function" ? w(run) : (w || words(tool));
  return { text, title: tool };
}

export const RUN_WORDS = Object.keys(WORDS);
