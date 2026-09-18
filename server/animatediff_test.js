/**
 * AnimateDiff v3 on SD1.5 — the graph's shape and the schedule's arithmetic.
 *
 * Pinned: the pieces are the ones whose licences allow them to ship (no
 * IPAdapter, no Advanced-ControlNet, no AnimateLCM, no LiquidAF); the look
 * changes on the bars through OUR per-frame schedule node; depth is the Small
 * estimator by licence; the two ControlNets carry Yvann's strengths and
 * windows; the working size is a multiple of 8; and ANIMATE_GATE says what
 * has been measured. Runs standalone and in the hook. No card.
 */
import fs from "node:fs";
import { animateGraph, scheduleFromBars, ANIMATE_WEIGHTS, ANIMATE_PRESET, ANIMATE_SIZES, ANIMATE_GATE, DEFAULT_NEGATIVE } from "./animatediff.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

console.log("\n§1  the schedule on the bars");
{
  const s = scheduleFromBars({ bars: [25.61, 27.47, 29.32], start: 25.6, fps: 12, frames: 61, looks: ["A", "B", "C"] });
  eq("a look per bar, held until five frames before the next, then blended across the bar line",
    s, { 0: "A", 17: "A", 22: "B", 40: "B", 45: "C" });
  eq("one look never blends: it holds", scheduleFromBars({ bars: [1, 2], start: 0, fps: 12, frames: 30, looks: ["A"] }), { 0: "A", 12: "A", 24: "A" });
  ok("no looks is a refusal", throwsWith(() => scheduleFromBars({ bars: [], frames: 10, looks: [] }), /at least one look/));
}

console.log("\n§2  the graph");
{
  const g = animateGraph({ source: "aiplay_ad_src.mp4", frames: 61, width: 768, height: 432, schedule: { 0: "A", 22: "B" }, seed: 7 });
  eq("the checkpoint, the v3 adapter, the v3 motion module — the Apache-2.0 pieces",
    [g[1].inputs.ckpt_name, g[2].inputs.lora_name, g[3].inputs.model_name], [ANIMATE_WEIGHTS.checkpoint, "v3_sd15_adapter.ckpt", "v3_sd15_mm.ckpt"]);
  eq("the motion module rides evolved sampling on the AnimateDiff beta schedule with looped-uniform 16/4 pyramid contexts",
    [g[6].class_type, g[6].inputs.beta_schedule, g[5].inputs.context_length, g[5].inputs.context_overlap, g[5].inputs.fuse_method],
    ["ADE_UseEvolvedSampling", "sqrt_linear (AnimateDiff)", 16, 4, "pyramid"]);
  eq("the look is OUR per-frame schedule, not a third-party pack", [g[7].class_type, JSON.parse(g[7].inputs.schedule), g[7].inputs.frames], ["AiplayPromptSchedule", { 0: "A", 22: "B" }, 61]);
  eq("depth is the Small estimator by licence, at the short side", [g[24].inputs.ckpt_name, g[24].inputs.resolution, g[25].inputs.resolution], ["depth_anything_v2_vits.pth", 432, 432]);
  ok("the ControlNet loaders are OURS (per-window hint), not core and not the GPL pack", g[30].class_type === "AiplayControlNetLoaderSliding" && g[31].class_type === "AiplayControlNetLoaderSliding");
  eq("the two ControlNets carry the decoded strengths and windows",
    [g[32].inputs.strength, g[32].inputs.end_percent, g[33].inputs.strength, g[33].inputs.end_percent, g[30].inputs.control_net_name, g[31].inputs.control_net_name],
    [0.3, 0.5, 0.5, 0.7, ANIMATE_WEIGHTS.depth, ANIMATE_WEIGHTS.lineart]);
  eq("the latent batch is the whole piece, the sampler on the preset, 12 fps out",
    [g[40].inputs.batch_size, g[41].inputs.steps, g[41].inputs.cfg, g[41].inputs.sampler_name, g[43].inputs.fps], [61, ANIMATE_PRESET.steps, ANIMATE_PRESET.cfg, "dpmpp_2m", 12]);
  ok("none of the GPL packs' nodes are in the graph", !Object.values(g).some((n) => /IPAdapter|ACN_|Fizz|BatchPromptSchedule/.test(n.class_type)));
  ok("a size off the VAE's stride is refused", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 770, height: 432, schedule: { 0: "A" }, seed: 1 }), /multiple of 8/));
  ok("no seed is refused, so a render can be reproduced", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 768, height: 432, schedule: { 0: "A" } }), /seed/));
  ok("no schedule is refused", throwsWith(() => animateGraph({ source: "x.mp4", frames: 8, width: 768, height: 432, schedule: {}, seed: 1 }), /schedule/));
  ok("the working sizes are all multiples of 8", Object.values(ANIMATE_SIZES).every(([w, h]) => w % 8 === 0 && h % 8 === 0));
  ok("the negative is a sentence, not empty", DEFAULT_NEGATIVE.length > 20);
}

console.log("\n§3  the gate says what it has measured");
{
  ok("ANIMATE_GATE has run once and says what it saw", ANIMATE_GATE.ran === true && ANIMATE_GATE.render_seconds > 0 && ANIMATE_GATE.frames === 60 && /watched, not scored/.test(ANIMATE_GATE.note));
  ok("...and never claims a score it has not computed", ANIMATE_GATE.scored === false);
  /* The two nodes the graph needs are OURS and ship in the repository: the
   * engine boot copies every file in server/comfy_nodes/ into custom_nodes. */
  const nodes = fs.readdirSync(new URL("./comfy_nodes/", import.meta.url));
  ok("the schedule node and the sliding ControlNet loader ship in server/comfy_nodes/",
    nodes.includes("aiplay_prompt_schedule.py") && nodes.includes("aiplay_sliding_controlnet.py"));
  const sliding = fs.readFileSync(new URL("./comfy_nodes/aiplay_sliding_controlnet.py", import.meta.url), "utf8");
  ok("...and the loader carries the attribute AnimateDiff-Evolved looks for, and slices the hint per window",
    /sub_idxs = None/.test(sliding) && /cond_hint_original = full\[keep\]/.test(sliding) && /NODE_CLASS_MAPPINGS = \{"AiplayControlNetLoaderSliding"/.test(sliding));
  const sched = fs.readFileSync(new URL("./comfy_nodes/aiplay_prompt_schedule.py", import.meta.url), "utf8");
  ok("...and the schedule node interpolates between keyframes and batches one conditioning per frame",
    /torch\.cat\(conds, dim=0\)/.test(sched) && /c0 \* \(1\.0 - t\) \+ c1 \* t/.test(sched) && /NODE_CLASS_MAPPINGS = \{"AiplayPromptSchedule"/.test(sched));
  ok("the module header names both as ours", /AiplayPromptSchedule\s+ours/.test(fs.readFileSync(new URL("./animatediff.js", import.meta.url), "utf8")) && /AiplayControlNetLoaderSliding ours/.test(fs.readFileSync(new URL("./animatediff.js", import.meta.url), "utf8")));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
