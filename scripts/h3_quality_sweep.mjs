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
const BASE = "http://127.0.0.1:8266";
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
  const t0 = Date.now();
  const r = await fetch(`${BASE}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) });
  if (!r.ok) { console.log(`${g.tag}: REJECTED ${(await r.text()).slice(0, 160)}`); continue; }
  const { prompt_id } = await r.json();
  for (;;) {
    await new Promise((s) => setTimeout(s, 2000));
    const e = (await (await fetch(`${BASE}/history/${prompt_id}`)).json())[prompt_id];
    if (e?.status?.status_str === "error") { console.log(`${g.tag}: ERROR`); break; }
    if (e?.status?.completed) {
      console.log(`  ${g.tag.padEnd(14)} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      break;
    }
  }
}
