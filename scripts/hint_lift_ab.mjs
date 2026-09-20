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
 * It prints where each file landed. Look at them; the number this produces
 * (edge energy inside the figure column, on the OUTPUT) is a hint and not a
 * verdict, because a repaint that invents detail scores well and looks wrong.
 */
import path from "node:path";
import { animateGraph, ANIMATE_SIZES } from "../server/animatediff.js";
import { engine } from "../server/engine/client.js";
import config from "../server/config.js";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const source = arg("source", "aiplay_zoom_s1_24.mp4");
const frames = Number(arg("frames", 48));
const seed = Number(arg("seed", 424242));
const [width, height] = ANIMATE_SIZES.landscape;

/* One look for the whole clip: a schedule that changes would move the
 * comparison as much as the lift does. */
const schedule = [{ frame: 0, text: "a dancer in a red room, thick oil paint, heavy impasto, dark background" }];

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
  const done = await engine.run({
    graph, actor: "script:hint_lift_ab", via: "hint_lift_ab", clientId: "aiplay-ab",
    label: `hint lift ${lift}`, project: "reactive", shot: null,
    adopt: false, timeoutMs: 40 * 60_000, pollMs: 3_000,
  });
  if (done.status !== "completed") throw new Error(done.error || `lift ${lift} did not finish (${done.status})`);
  const out = (done.outputs || []).filter((r) => (r.type || "output") !== "input")
    .find((r) => /\.(mp4|webm|mov|mkv)$/i.test(r.file || ""));
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`  lift ${lift}: ${out ? path.join(config.outputDir, out.file) : "(no clip written)"}  ${secs}s`);
  return out?.file || null;
};

console.log(`source ${source}, ${frames} frames at ${width}x${height}, seed ${seed}`);
console.log("rendering the pair — the second one is the only thing that changed:");
const off = await runOne(1);
const on = await runOne(2.2);
console.log("\nnow look at them side by side:");
console.log(`  off  ${off}`);
console.log(`  on   ${on}`);
