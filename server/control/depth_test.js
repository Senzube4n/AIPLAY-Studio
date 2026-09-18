/**
 * Depth Anything V2 — the two settings that are not preferences, and the shape
 * around them. The same discipline pose_test.js applies to DWPose:
 *
 *   ckpt_name defaults to the LARGE model, which is CC-BY-NC-4.0. Taking the
 *   default puts a non-commercial estimator in a sellable clip's chain without
 *   anybody choosing it. The graph must pick Small unless asked.
 *
 *   resolution defaults to 512, which turns 1280x704 into 931x512, and libx264
 *   refuses the odd width at the very end of the extraction.
 *
 * Both are pinned against the node's OWN declared defaults, so the test fails
 * if the pin is ever quietly removed. DEPTH_GATE is pinned as UNSCORED: the
 * day an arm is measured, this file changes with it, and a surface cannot
 * borrow the pose gate's number for a path that has none.
 *
 * Runs standalone (`node server/control/depth_test.js`) and in the hook.
 */
import fs from "node:fs";
import {
  depthGraph, depthResolution, depthHash, depthModelFor,
  DEPTH_MODELS, DEPTH_DEFAULT, DEPTH_NODE_DEFAULTS, DEPTH_GATE,
} from "./depth.js";
import { CONTROL_SPEC } from "./control.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the models, by licence");
{
  eq("the default is the Apache-2.0 Small model, not the node's Large default",
    [DEPTH_DEFAULT, DEPTH_MODELS.small.licence, DEPTH_MODELS.small.commercial], ["small", "Apache-2.0", true]);
  eq("Large is offered, and it says NON-COMMERCIAL", [DEPTH_MODELS.large.licence, DEPTH_MODELS.large.commercial], ["CC-BY-NC-4.0", false]);
  ok("the node's own default is the Large ckpt — which is why the graph must not inherit it",
    DEPTH_NODE_DEFAULTS.ckpt_name === DEPTH_MODELS.large.ckpt);
  eq("a model is found by key or by ckpt name", [depthModelFor("small").ckpt, depthModelFor("depth_anything_v2_vitl.pth").key], ["depth_anything_v2_vits.pth", "large"]);
  ok("an unknown model is refused with the list, never silently the default",
    throwsWith(() => depthModelFor("giant"), /No depth model called "giant".*small \(Apache-2\.0\).*large \(CC-BY-NC-4\.0\)/));
  ok("every model row carries the bytes and the sha256 the catalogue downloads by",
    Object.values(DEPTH_MODELS).every((m) => m.bytes > 0 && /^[0-9a-f]{64}$/.test(m.sha256) && m.repo && m.revision));
}

console.log("\n§2  the resolution rule");
{
  eq("the short side of the contract size", depthResolution(1280, 704), { ok: true, resolution: 704, why: null });
  ok("an odd side is refused, naming libx264", !depthResolution(931, 512).ok && /libx264/.test(depthResolution(931, 512).why));
  ok("a missing size is refused", !depthResolution(undefined, 704).ok);
}

console.log("\n§3  the graph");
{
  const g = depthGraph({ source: "aiplay_ctl_src_abc.mp4" });
  eq("one pixel chain, the same ids as the VACE and pose graphs",
    [g[20].class_type, g[21].class_type, g[22].class_type, g[23].class_type, g[24].class_type, g[25].class_type],
    ["LoadVideo", "GetVideoComponents", "ImageFromBatch", "DepthAnythingV2Preprocessor", "CreateVideo", "SaveVideo"]);
  eq("the control floor of frames, from 0", [g[22].inputs.length, g[22].inputs.batch_index], [CONTROL_SPEC.minFrames, 0]);
  eq("the Small ckpt and the short side — neither is the node's default",
    [g[23].inputs.ckpt_name, g[23].inputs.resolution], [DEPTH_MODELS.small.ckpt, 704]);
  ok("...and both really differ from the node's defaults",
    g[23].inputs.ckpt_name !== DEPTH_NODE_DEFAULTS.ckpt_name && g[23].inputs.resolution !== DEPTH_NODE_DEFAULTS.resolution);
  eq("24 fps, hard, and a control/ prefix", [g[24].inputs.fps, g[25].inputs.filename_prefix.startsWith("control/depth_")], [24, true]);
  const big = depthGraph({ source: "x.mp4", model: "large" });
  eq("asked for large, the graph loads large", big[23].inputs.ckpt_name, DEPTH_MODELS.large.ckpt);
  ok("the hash changes with the model, so Small and Large never share a cached file",
    depthHash({ source: "a", frames: 121, resolution: 704, ckpt: "s" }) !== depthHash({ source: "a", frames: 121, resolution: 704, ckpt: "l" }));
  ok("a short clip is refused, naming the floor and the mid-gray padding",
    throwsWith(() => depthGraph({ source: "x.mp4", frames: 96 }), /below the control floor of 121.*mid-gray/));
  ok("no source is refused, naming the COMBO", throwsWith(() => depthGraph({}), /COMBO/));
  ok("an odd source size is refused before any graph exists", throwsWith(() => depthGraph({ source: "x.mp4", width: 931, height: 512 }), /libx264/));
}

console.log("\n§4  the gate is unscored and says so");
{
  ok("DEPTH_GATE has run once, is NOT scored, and says so", DEPTH_GATE.ran === true && DEPTH_GATE.scored === false
    && DEPTH_GATE.extraction_seconds > 0 && DEPTH_GATE.render_seconds > 0 && /watched, not measured/.test(DEPTH_GATE.note));
  const ctl = src("../mv/control.js");
  ok("control.js offers depth, extract_depth and conform as modes",
    /\{ mode: "depth", renders: 2/.test(ctl) && /\{ mode: "extract_depth", renders: 1/.test(ctl) && /\{ mode: "conform", renders: 0/.test(ctl));
  ok("...runs the depth graph through the one door with its own via", /via: "mv\.control\.depth"/.test(ctl) && /depthGraph\(\{/.test(ctl));
  ok("...and a depth video goes through the same clip gate before VACE sees it", /const dep = await validateControlClip\(at\)/.test(ctl));
  ok("...and conform is ffmpeg: cover-scale, centre-crop, 24 fps, sound dropped",
    /force_original_aspect_ratio=increase/.test(ctl) && /crop=\$\{W\}:\$\{H\}/.test(ctl) && /fps=\$\{FPS\}/.test(ctl) && /"-an"/.test(ctl));
  ok("...and writes exactly the contract's frames from a chosen second, never the whole clip",
    /"-frames:v", String\(N\)/.test(ctl) && /\["-ss", String\(from\)\]/.test(ctl),
    "a 1099-frame conform sat the GPU at 2 % while LoadVideo decoded 46 s it would then discard");
  ok("...and the run's output is what the graph WROTE, never LoadVideo's echo of its input",
    /\(o\.type \|\| "output"\) !== "input"/.test(ctl),
    "ComfyUI 0.36 lists the input clip as an output row of type \"input\" ahead of SaveVideo; the first "
    + "finished depth extraction answered CONTROL CLIP MISSING for the staged source that finally had deleted");
  ok("...and the catalogue hands the card the depth licence as its OWN answer",
    /depth: \{ class: depth\?\.outputRights\?\.class/.test(ctl) && /appliesTo: \["depth", "extract_depth"\]/.test(ctl));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
