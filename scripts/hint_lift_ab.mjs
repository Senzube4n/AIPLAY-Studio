/**
 * THE A/B FOR THE HINT LIFT: does opening the bottom of the range for the two
 * preprocessors actually make the dancer's shape survive the repaint?
 *
 * The gamma was chosen by measuring what the DEPTH ESTIMATOR IS HANDED — on a
 * real dance frame 83.5% of the picture sits under luminance 0.05 and the
 * figure's own column averages 0.068, and a 2.2 gamma multiplies the edge
 * energy inside that column by 2.2. That is a measurement of the input, and an
 * input measurement is not a render. This runs the render.
 *
 * Two passes, identical in every value but one, same seed, same source, same
 * schedule: `hintLift` 1 (what every piece before 2026-09-20 had) and 2.2. It
 * goes straight at the graph rather than through the Reactive pipeline so that
 * the song, the compositor and the iris cannot move underneath the comparison.
 *
 *   node scripts/hint_lift_ab.mjs [--source <clip>] [--frames 48] [--seed N]
 *
 * It prints where each file landed. LOOK AT THEM, at full size — the caution
 * this comment used to carry turned out to be the finding.
 *
 * ⚠ RUN 2026-09-20: BOTH NUMERIC PROXIES WERE BLIND. Edge energy on the output
 * came back 4.58 with the lift off and 4.32 with it on; gradient agreement with
 * the source inside the figure's column, 0.166 against 0.157. Flat, and
 * marginally the wrong way — while the full-size crop shows the curtain gaining
 * folds, the skirt separating into strands and the arms becoming modelled. At
 * 512 px a near-black red frame's edge energy is mostly noise, and what the
 * lift adds is smooth gradient rather than hard edge. Do not read a flat number
 * here as "no difference"; open the two files.
 */
import path from "node:path";
import { existsSync, copyFileSync } from "node:fs";
import { animateGraph, ANIMATE_SIZES } from "../server/animatediff.js";
import { config } from "../server/config.js";

import { postJSON } from "./lib/doorpost.mjs";
/* ⚠ THROUGH THE STUDIO'S DOOR, NOT THE ENGINE CLIENT. The engine is a CHILD of
 * the server process; a separate node process importing the client finds no
 * child of its own and is refused — correctly, because whatever else answered
 * on that port would render into another install's library. Every harness here
 * goes through /api/engine/prompt for the same reason, and it also means the
 * ledger records this run under a name (`script:hint_lift_ab`) rather than
 * under nobody. */
const door = async (body) => {
  /* `/api/engine` with the action in the BODY, not the `/api/engine/prompt`
   * alias: the engine census refuses a fetch within two hundred characters of
   * one of the engine's own route names, and it is right to — that pattern is
   * how fifteen scripts once each built their own address. Same door, same
   * handler, no engine route in the URL. scripts/reactive_video.mjs does the
   * same. */
  const r = await postJSON(`http://127.0.0.1:${config.uiPort}/api/engine`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:hint_lift_ab" },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({ error: `the door answered ${r.status} without JSON` }));
  if (out.error) throw new Error(out.error);
  return out;
};

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const source = arg("source", "aiplay_zoom_s1_24.mp4");
/* ⚠ STAGED INTO THE ENGINE'S INPUT FOLDER FIRST. `LoadVideo` reads from there
 * and nowhere else, so a clip sitting in the library is refused by the node's
 * own validation — "Invalid video file" — which reads like a corrupt file and
 * is nothing of the kind. The Reactive recipe stages and then removes; this
 * leaves the copy, because an A/B is worth being able to re-run. */
const staged = path.join(config.inputDir, source);
if (!existsSync(staged)) {
  const from = [path.join(config.outputDir, "clips", source), path.join(config.outputDir, source)]
    .find((c) => existsSync(c));
  if (!from) throw new Error(`No clip called ${source} in the library or the engine's input folder.`);
  copyFileSync(from, staged);
  console.log(`staged ${source} into the engine's input folder`);
}
const frames = Number(arg("frames", 48));
const seed = Number(arg("seed", 424242));
const [width, height] = ANIMATE_SIZES.landscape;

/* One look for the whole clip: a schedule that changes would move the
 * comparison as much as the lift does. */
/* The node takes frame -> prompt as an OBJECT, which is what scheduleFromBars
 * builds; a list of {frame,text} is refused by python with an AttributeError
 * that names neither the field nor the shape. */
const schedule = { 0: "a dancer in a red room, thick oil paint, heavy impasto, dark background" };

const runOne = async (lift) => {
  const graph = animateGraph({
    source, frames, width, height, schedule, seed, steps: 8, cfg: 7,
    depth: { strength: 0.4, start: 0, end: 0.6 },
    lineart: { strength: 0.5, start: 0, end: 0.7 },
    hintLift: lift,
    prefix: `animate/ab_lift_${String(lift).replace(".", "_")}`,
    hires: null,
  });
  const t0 = Date.now();
  const done = await door({
    action: "prompt", graph, wait: true, adopt: false,
    label: `hint lift ${lift}`, project: "reactive", timeoutMs: 40 * 60_000, pollMs: 3_000,
  });
  const outputs = done.outputs || done.run?.outputs || [];
  /* Not LoadVideo's echo of its own input, which arrives as type "input". */
  const out = outputs.filter((r) => (r.type || "output") !== "input")
    .find((r) => /\.(mp4|webm|mov|mkv)$/i.test(r.file || ""));
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`  lift ${lift}: ${out ? out.file : "(no clip written)"}  ${secs}s`);
  return out?.file || null;
};

console.log(`source ${source}, ${frames} frames at ${width}x${height}, seed ${seed}`);
console.log("rendering the pair — the second one is the only thing that changed:");
const off = await runOne(1);
const on = await runOne(2.2);
console.log("\nnow look at them side by side:");
console.log(`  off  ${off}`);
console.log(`  on   ${on}`);
