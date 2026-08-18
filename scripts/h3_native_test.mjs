/**
 * Are we simply asking the model for something it was never trained to make?
 *
 * Two suspects, both structural rather than tuning:
 *   LENGTH — the node's own tooltip says "trained range is ~124-362" frames.
 *            We render 56. That is less than HALF the shortest length it ever
 *            saw, and short-clip incoherence is exactly the reported symptom.
 *   SIZE   — the node defaults to 1344x768. We render 864x480, 40% of the pixels.
 *
 * Same prompt, same seed. One arm per hypothesis, then both together.
 */
import { videoGraph, alignFrames } from "../server/workflow.js";
const BASE = "http://127.0.0.1:8266";
const PROMPT = "a woman in a dark room turning slowly to look at the camera, warm lamplight, shallow depth of field";
const SEED = 4242;

const ARMS = [
  { tag: "now_2s_864",    secs: 2, w: 864,  h: 480 },
  { tag: "long_5s_864",   secs: 5, w: 864,  h: 480 },
  { tag: "native_2s_1344", secs: 2, w: 1344, h: 768 },
  { tag: "both_5s_1344",  secs: 5, w: 1344, h: 768 },
];

for (const a of ARMS) {
  const frames = alignFrames(a.secs, 24);
  const g = videoGraph({ prompt: PROMPT, seed: SEED, seconds: a.secs, steps: 8,
    width: a.w, height: a.h, prefix: `clips/n_${a.tag}`, keepAudio: false });
  const t0 = Date.now();
  const r = await fetch(`${BASE}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g }) });
  if (!r.ok) { console.log(`${a.tag}: REJECTED ${(await r.text()).slice(0, 200)}`); continue; }
  const { prompt_id } = await r.json();
  for (;;) {
    await new Promise((s) => setTimeout(s, 3000));
    const e = (await (await fetch(`${BASE}/history/${prompt_id}`)).json())[prompt_id];
    if (e?.status?.status_str === "error") {
      console.log(`  ${a.tag.padEnd(16)} ERROR ${JSON.stringify(e.status.messages).slice(0, 200)}`); break;
    }
    if (e?.status?.completed) {
      console.log(`  ${a.tag.padEnd(16)} ${frames} frames  ${a.w}x${a.h}  ${((Date.now()-t0)/1000).toFixed(0)}s`);
      break;
    }
  }
}
