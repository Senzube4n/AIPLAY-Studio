/**
 * Is fp32 actually better, or just bigger?
 *
 * config.js says int8 and fp16 measured IDENTICAL (4.2 dB SNR, +10.8 dB NMR
 * each) against a converged reference, and that fp32 "has NOT been compared" —
 * which is exactly the sort of untested claim that should not sit in a shipped
 * settings screen. This settles it.
 *
 * Same seed, same mix seed, same everything but precision. Identical inputs mean
 * ComfyUI would normally cache-hit, so each arm gets its own prefix and the
 * model change alone busts the cache.
 */
import { buildGraph } from "../server/workflow.js";
import { postJSON } from "./lib/doorpost.mjs";
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:fp32_audio_test with its graph stored whole, its resolved
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
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:fp32_audio_test" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 3000, ...body }),
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
const CAPTION = "solo piano, slow, sparse, close mic, warm room";
const LYRICS = "[Verse]\nSilver on the water\n\n[Chorus]\nThe long way home tonight\n";

async function run(model) {
  const g = buildGraph({
    caption: CAPTION, lyrics: LYRICS, seed: 31337, mixSeed: 31337,
    maxDuration: 40, model, prefix: `prec_${model}`,
  });
  const d = await door({ graph: g, label: `precision ${model}` });
  if (d.status !== "completed") { console.log(`  ${model}: ${d.status.toUpperCase()} ${d.error || ""}`); return null; }
  const f = d.outputs[0];
  console.log(`  ${String(model).padEnd(5)} ${d.elapsedSec.toFixed(0)}s -> ${f?.file}`);
  return f?.file;
}
console.log("precision A/B — same seed and mix seed, only the weights differ\n");
for (const m of ["int8", "fp16", "fp32"]) await run(m);
