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
const BASE = "http://127.0.0.1:8266";
const CAPTION = "solo piano, slow, sparse, close mic, warm room";
const LYRICS = "[Verse]\nSilver on the water\n\n[Chorus]\nThe long way home tonight\n";

async function run(model) {
  const g = buildGraph({
    caption: CAPTION, lyrics: LYRICS, seed: 31337, mixSeed: 31337,
    maxDuration: 40, model, prefix: `prec_${model}`,
  });
  const t0 = Date.now();
  const r = await fetch(`${BASE}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g }) });
  if (!r.ok) { console.log(`  ${model}: REJECTED ${(await r.text()).slice(0, 200)}`); return null; }
  const { prompt_id } = await r.json();
  for (;;) {
    await new Promise((s) => setTimeout(s, 3000));
    const e = (await (await fetch(`${BASE}/history/${prompt_id}`)).json())[prompt_id];
    if (e?.status?.status_str === "error") { console.log(`  ${model}: ERROR`); return null; }
    if (e?.status?.completed) {
      const f = Object.values(e.outputs || {}).flatMap((o) => o.audio || [])[0];
      console.log(`  ${String(model).padEnd(5)} ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${f?.filename}`);
      return f?.filename;
    }
  }
}
console.log("precision A/B — same seed and mix seed, only the weights differ\n");
for (const m of ["int8", "fp16", "fp32"]) await run(m);
