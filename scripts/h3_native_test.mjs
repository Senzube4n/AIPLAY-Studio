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
import { postJSON } from "./lib/doorpost.mjs";
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:h3_native_test with its graph stored whole, its resolved
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
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:h3_native_test" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: true, pollMs: 3000, ...body }),
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
  const d = await door({ graph: g, label: `native ${a.tag}` });
  if (d.status !== "completed") {
    console.log(`  ${a.tag.padEnd(16)} ${d.status.toUpperCase()} ${String(d.error || "").slice(0, 200)}`);
    continue;
  }
  console.log(`  ${a.tag.padEnd(16)} ${frames} frames  ${a.w}x${a.h}  ${d.elapsedSec.toFixed(0)}s`
    + `  -> ${d.outputs[0]?.adoptedAs || d.outputs[0]?.file || ""}`);
}
