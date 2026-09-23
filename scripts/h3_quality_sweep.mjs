/**
 * Now that the turbo LoRA is actually applied, find the settings that stop the
 * morphing.
 *
 * Three suspects, all plausible and all cheap to test:
 *  - STEPS. We run the 4-STEP LoRA at 8 steps, which is off its design point.
 *  - SHIFT. Ours (4.0) was swept on the un-LoRA'd model. The vendor note says
 *    6/3 for this 4-step 768p LoRA and 12/3 for the 8-step one.
 *  - RESOLUTION. The LoRA is the 768p build and we render 864x480.
 *
 * Same prompt and seed throughout, so only the variable moves.
 */
import { videoGraph } from "../server/workflow.js";
import { config } from "../server/config.js";
import { postJSON } from "./lib/doorpost.mjs";
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:h3_quality_sweep with its graph stored whole, its resolved
 * prompt, every seed and step count, the size, the model files, the wall time
 * and the digest of everything it wrote — and a FAILED arm is recorded too.
 * On the night this door was built, 424 files in the output folder had none of
 * that. See docs/ENGINE_DOOR.md.
 */
const APP = process.env.AIPLAY_URL || "http://127.0.0.1:4173";
async function door(body) {
  let r;
  try {
    r = await postJSON(`${APP}/api/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:h3_quality_sweep" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: true, pollMs: 2000, ...body }),
    });
  } catch (e) {
    /* THIS REFUSAL *IS* THE ENFORCEMENT, so it has to be readable. A harness
     * that cannot find the app can no longer find the engine either. */
    throw new Error(`start AIPLAY Studio first — nothing is answering at ${APP} `
      + `(${e.cause?.code || e.message}). Set AIPLAY_URL if the app is on another port.`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `AIPLAY Studio answered ${r.status} at ${APP}.`);
  return d;
}
const PROMPT = "a red vintage car driving along a coastal road at sunset, slow steady camera follow";
const SEED = 777;

const GRID = [
  { steps: 8, shift: 4,  w: 864, h: 480, tag: "s8_sh4_864"  },   // what ships now
  { steps: 4, shift: 6,  w: 864, h: 480, tag: "s4_sh6_864"  },   // vendor: 4-step LoRA
  { steps: 8, shift: 6,  w: 864, h: 480, tag: "s8_sh6_864"  },
  { steps: 8, shift: 12, w: 864, h: 480, tag: "s8_sh12_864" },   // vendor default
  { steps: 12, shift: 6, w: 864, h: 480, tag: "s12_sh6_864" },   // "more steps?"
  { steps: 8, shift: 6,  w: 768, h: 432, tag: "s8_sh6_768"  },   // nearer the LoRA's resolution
];

for (const g of GRID) {
  config.video.shiftVideo = g.shift;
  const graph = videoGraph({
    prompt: PROMPT, seed: SEED, seconds: 2, steps: g.steps,
    width: g.w, height: g.h, prefix: `clips/q_${g.tag}`, keepAudio: false,
  });
  const d = await door({ graph, label: `quality ${g.tag}`, shot: g.tag });
  if (d.status !== "completed") { console.log(`${g.tag}: ${d.status.toUpperCase()} ${d.error || ""}`); continue; }
  console.log(`  ${g.tag.padEnd(14)} ${d.elapsedSec.toFixed(0)}s`);
}
