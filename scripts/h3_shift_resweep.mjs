/**
 * H3 sigma-shift RE-sweep, on the distilled path.
 *
 * WHY THIS EXISTS AGAIN
 * The shift finding recorded in config.js (4.0 beats the 12.0 default, 4/4 on
 * loop closure and 4/4 on flicker) was measured on a graph that never loaded the
 * turbo LoRA. That graph ran the BASE model at 8 steps, which we now know
 * produces vague frames that barely follow the prompt. A schedule tuned on an
 * undercooked model says nothing about the distilled one, so the number shipped
 * on an invalid measurement. This re-runs it on what actually ships.
 *
 * METHOD — the same four rules the first sweep was built on, because they are
 * what stopped eight earlier hypotheses from surviving:
 *  1. Build the graph with videoGraphH3 ITSELF rather than a copy. A sweep that
 *     drifts from the shipping graph measures a program nobody runs. This is the
 *     one real change in method: the first sweep hand-copied the graph, and that
 *     is exactly how it kept the missing LoRA.
 *  2. Noise floor before effect. Two seeds at every shift bound how much
 *     difference means nothing; a gap between shifts smaller than the gap
 *     between seeds is not a finding.
 *  3. Vary something per run or ComfyUI's cache returns instantly and fakes it.
 *     Every run here differs in seed or in graph, so nothing short-circuits.
 *  4. Look at the frames. The high-frequency metric ranked a BROKEN render top
 *     once already — it cannot tell texture from artefact — so this writes a
 *     contact sheet per run and the numbers only narrow down what to look at.
 *
 * CANDIDATES
 *   4.0   what ships, and the only value anything was ever measured on
 *   6.0   what the LoRA's own model card recommends (6/3) for this family
 *  12.0   the node default, i.e. what an untouched install does
 *
 * COST ~11 min a clip at native size and 124 frames, so 6 runs is a little over
 * an hour. That is the price of measuring the thing that ships instead of a
 * cheap proxy for it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import { videoGraphH3 } from "../server/workflow.js";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const OUT = path.join(config.outputDir, "_sweep");
const SHIFTS = [4.0, 6.0, 12.0];
const SEEDS = [11111, 22222];

/* One prompt, chosen to make the failure modes visible rather than to look nice:
 * a face and a knit texture catch smearing, the lamp catches flicker, and a slow
 * push-in catches the morphing the user reported. A busy prompt would hide all
 * three. */
const PROMPT =
  "A woman sitting by a window in a knitted jumper, reading, slow camera push-in, " +
  "warm lamp light from the right, soft shadows, fine fabric texture, calm and still.\n\n" +
  "Audio: quiet room tone.";

const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })
    .then((r) => r.json());

async function run(shift, seed) {
  const tag = `shift${String(shift).replace(".", "p")}_s${seed}`;
  /* Mutating config rather than threading a parameter through videoGraphH3 is
   * deliberate: adding a sweep-only argument to the shipping function is how the
   * shipping function slowly becomes the test harness. */
  const engine = config.video.engines.h3;
  const was = engine.shiftVideo;
  engine.shiftVideo = shift;
  const g = videoGraphH3({
    prompt: PROMPT, seed,
    seconds: config.video.engines.h3.seconds,
    keepAudio: true,          // H3 renders it regardless; keeping it costs nothing
    prefix: `sweep_${tag}`,
  });
  engine.shiftVideo = was;

  const t0 = Date.now();
  const { prompt_id, error } = await post("/prompt", { prompt: g });
  if (error) throw new Error(`${tag}: ${JSON.stringify(error).slice(0, 300)}`);

  // Poll rather than open a websocket — this script's only job is to wait.
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
    const rec = h[prompt_id];
    if (!rec) continue;
    if (rec.status?.status_str === "error") {
      throw new Error(`${tag} failed: ${JSON.stringify(rec.status.messages).slice(0, 400)}`);
    }
    if (rec.status?.completed) {
      const secs = (Date.now() - t0) / 1000;
      const files = Object.values(rec.outputs ?? {}).flatMap((o) =>
        [...(o.gifs ?? []), ...(o.videos ?? []), ...(o.images ?? [])].map((f) => f.filename));
      console.log(`  ${tag}  ${secs.toFixed(0)}s  ${files.join(", ")}`);
      return { tag, shift, seed, seconds: secs, files };
    }
  }
}

mkdirSync(OUT, { recursive: true });
const results = [];
console.log(`H3 shift re-sweep — ${SHIFTS.length} shifts x ${SEEDS.length} seeds, on the LoRA'd graph`);
console.log(`size ${config.video.engines.h3.width}x${config.video.engines.h3.height}, ` +
            `${config.video.engines.h3.steps} steps, lora ${config.video.engines.h3.turboLora}`);
for (const shift of SHIFTS) {
  for (const seed of SEEDS) {
    try {
      results.push(await run(shift, seed));
    } catch (e) {
      console.error(`  ${e.message}`);
      results.push({ shift, seed, error: e.message });
    }
    writeFileSync(path.join(OUT, "resweep.json"), JSON.stringify(results, null, 2));
  }
}
console.log(`\nwrote ${path.join(OUT, "resweep.json")}`);
console.log("now score it:  python scripts/h3_shift_score.py");
