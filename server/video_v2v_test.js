/**
 * VIDEO-TO-VIDEO: THE WIRE, AND THE FOUR PLACES IT COULD VANISH.
 *
 * A whole clip drives the render frame by frame instead of one opening
 * picture. The node for it (`MiniMaxH3FunControlNetApply`) was in the engine
 * from the start with `control_video` and `source_video` inputs and nothing to
 * load into `model_patch`; the union patch is catalogued now, so the option is
 * real.
 *
 * ⚠ EVERY LAYER HERE DROPS WHAT IT DOES NOT NAME, and art.js:1367 says so in its
 * own words: "This call names every field rather than spreading the job, so a
 * new option that is not listed here is dropped in silence." That already cost
 * this app every MCP clip's opening still for weeks — the tool sent
 * `firstFrame`, the route read `fromCover`, and the response looked like
 * success. A control video lost the same way would render an ordinary clip and
 * read as the model ignoring the footage.
 *
 * So the lane follows one value through all four: the tool's parameter, the
 * body it posts, the job the route builds, and the graph the engine runs.
 */
import assert from "node:assert";
import fs from "node:fs";
import { videoGraphH3 } from "./workflow.js";

let passed = 0, failed = 0;
const ok = (what, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${extra ? `\n        ${extra}` : ""}`); }
};
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const art = src("./art.js"), index = src("./index.js"), mcp = src("./mcp.js");

console.log("\nVIDEO-TO-VIDEO");

const PATCH = "minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors";
const base = { prompt: "a lego version", seed: 1, seconds: 5, width: 1344, height: 768, steps: 8 };

/* ── the graph ───────────────────────────────────────────────────────────── */
{
  const g = videoGraphH3({ ...base, controlVideo: "take.mp4", controlPatch: PATCH, controlStrength: 0.9 });
  ok("a control video becomes a decode, a scale and a patch load",
    g[30]?.class_type === "LoadVideo" && g[31]?.class_type === "GetVideoComponents"
    && g[32]?.class_type === "ImageScale" && g[33]?.class_type === "ModelPatchLoader");
  ok("...the footage is scaled to the render frame, and CROPPED rather than stretched",
    g[32]?.inputs?.width === 1344 && g[32]?.inputs?.height === 768 && g[32]?.inputs?.crop === "center",
    "control footage of another aspect ratio arrives skewed otherwise, and a skewed depth map steers the picture skewed");
  ok("...and the apply is fed the scaled frames and the patch",
    g[34]?.class_type === "MiniMaxH3FunControlNetApply"
    && JSON.stringify(g[34].inputs.control_video) === JSON.stringify(["32", 0])
    && JSON.stringify(g[34].inputs.model_patch) === JSON.stringify(["33", 0]));

  /* ⚠ THE ONE PLACE IT CAN GO. The sigma shift feeds BOTH the guider and the
   * scheduler, so patching after it leaves the scheduler on an unpatched model;
   * patching before the LoRA puts the distillation on top of the control. */
  ok("the patch sits between the LoRA and the sigma shift, and the shift reads it",
    JSON.stringify(g[34].inputs.model) === JSON.stringify(["18", 0])
    && JSON.stringify(g[6].inputs.model) === JSON.stringify(["34", 0]),
    JSON.stringify({ apply: g[34].inputs.model, shift: g[6].inputs.model }));
  ok("...and the strength the caller asked for is the strength in the graph",
    g[34].inputs.strength === 0.9);
}
{
  const g = videoGraphH3({ ...base });
  ok("no control video means no control nodes at all — a bypass, not a node doing nothing",
    !g[30] && !g[33] && !g[34] && JSON.stringify(g[6].inputs.model) === JSON.stringify(["18", 0]));
}
{
  /* Half an instruction is not an instruction: a clip with no patch (or the
   * reverse) must render as an ordinary clip rather than half-applying. */
  const a = videoGraphH3({ ...base, controlVideo: "take.mp4" });
  const b = videoGraphH3({ ...base, controlPatch: PATCH });
  ok("a control video without its patch, or a patch without a video, applies neither",
    !a[34] && !b[34]);
}

/* ── the layers that drop what they do not name ──────────────────────────── */
ok("art.js names every control field, because it names every field or loses it",
  ["controlVideo", "controlPatch", "controlStrength", "controlStart", "controlEnd"]
    .every((f) => new RegExp(`${f}: job\\.${f}`).test(art)));
ok("...and the route puts them on the job",
  /controlVideo: control\.video/.test(index) && /controlPatch: control\.patch/.test(index));
ok("...and make_clip sends the field the route actually reads (`sourceVideo`)",
  /body\.sourceVideo = safeName\(a\.source_video, "clip"\)/.test(mcp));
ok("...and offers the numbers behind it",
  ["source_video", "control_strength", "control_start", "control_end"]
    .every((p) => new RegExp(`${p}: \\{ type:`).test(mcp)));

/* ── the refusal is where the model gets offered ─────────────────────────── */
/* ⚠ THE OWNER'S RULE: "if you want to use a functionality it proposes you the
 * model to download to enable it, so that you only get it when you need it."
 * Asking for this without the patch IS that moment, so the refusal has to carry
 * the row and the tool rather than call the option unsupported. */
ok("asking without the patch is refused with the catalogue row, its size and the tool",
  /reason: "needs-model"/.test(index) && /download_model` id videoH3FunControl/.test(index)
  && /needsModel: \{ id: "videoH3FunControl"/.test(index));
ok("...and the refusal names the territory clause BEFORE 2.3 GB is fetched",
  /territory clause/.test(index) && /region: row\?\.region\?\.excluded/.test(index));
ok("...and a path where a clip name belongs is refused",
  /Name a clip on this machine, not a path/.test(index));
ok("...and LTX, which has no structural video input, is told which engine does",
  /Video-to-video is H3's path/.test(index) && /reason: "control-engine"/.test(index));

console.log(`\n  ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} video-to-video pins failed`);
