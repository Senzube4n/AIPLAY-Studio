/**
 * Ideogram 4 pass-seed harvester.
 *
 * The open Ideogram 4 weights are noise-locked: only a sparse, DETERMINISTIC
 * set of seeds renders; the rest draw the model's trained-in refusal card
 * (measured: 1 pass in 23 probes). ComfyUI's noise is CPU-generated, so the
 * pass-set is the same on every machine — seeds found here work everywhere.
 *
 * Run it while the studio idles (it submits straight to the engine and yields
 * to nothing, so don't race a render batch):
 *
 *   node scripts/harvest_ideogram_seeds.mjs --count 100
 *
 * Passing seeds append to <outputDir>/ideogram_seeds.json, which the image
 * engine reads on every render.
 *
 * MEASURED, so you know what to expect: on an EASY prompt (a still life)
 * roughly 40% of random seeds render. On the hard probe prompt below —
 * text-heavy poster typography — **0 of 92 random seeds passed**, while 777
 * renders it every time. The filter is a (prompt, noise) joint and 777 may
 * simply be the seed the release was blessed with. Harvest overnight and
 * expect single-digit finds, not dozens; each one is a seed that carries
 * difficult prompts, which is the only kind worth adding.
 *
 * ⚠ RE-MEASURED 2026-08-27, and the advice above needs one correction. On the
 * hard poster prompt this machine is now at **0 passes in 99 random probes**
 * (93 from the run that left ideoharvest/ behind, 6 more since). That is not
 * a slow harvest, it is a harvest that does not terminate: a run against the
 * default prompt can burn a night of GPU and leave the ladder at one entry —
 * and a one-entry ladder is a retry that cannot retry (see nextIdeogramSeed
 * in workflow.js). On an ORDINARY prompt the same machine passes 12 of 24.
 * So:
 *
 *   --prompt "…"   harvest against something the model will actually draw.
 *   --seeds a,b,c  re-test specific seeds instead of rolling random ones —
 *                  this is how you check whether easy-harvested seeds also
 *                  carry the hard prompt. Nothing is appended in this mode
 *                  unless a seed passes.
 *
 * Harvesting on an easy prompt does collect weaker seeds, and the docstring
 * above is right that they are worth less. They are still worth more than
 * nothing: the ladder's job is to give a refused render a DIFFERENT noise to
 * try, and a second entry of any strength is the difference between a retry
 * and a re-run of the same deterministic failure.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
/* ONE implementation of "is this the card". This file used to carry its own
 * copy of the reader sampling every 8th pixel while the app sampled every
 * 4th — two different numbers for the same picture, so a seed could be
 * harvested as passing and then have its render deleted as a card. */
import { pngLumaStats, refusalCard } from "../server/art.js";

import { postJSON } from "./lib/doorpost.mjs";
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
/* The default stays the HARD poster prompt — a seed that renders it is worth
 * more than one that only renders a pear. `--prompt` exists because on this
 * machine the hard prompt has now returned 0 in 99 random probes, and a
 * harvester that never finds anything is not a harvester. */
const HARD_PROMPT = "a vintage travel poster, bold letters reading VISIT THE WHITE STUDIO, "
  + "minimalist midcentury design, cream and teal";
const PROMPT = arg("--prompt") || HARD_PROMPT;
/* Explicit seeds instead of random rolls: re-testing a known seed against a
 * different prompt is the only way to tell a strong seed from a weak one. */
/* ⚠ .filter(Boolean) BEFORE Number(): an absent --seeds splits to [""], and
 * Number("") is 0, which is finite — so the flag nobody passed silently
 * became "probe exactly seed 0" and a 24-probe harvest ran one probe. */
const SEEDS = (arg("--seeds") || "").split(",").map((s) => s.trim()).filter(Boolean)
  .map(Number).filter(Number.isFinite);
const COUNT = SEEDS.length || Number(arg("--count")) || 50;
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:harvest_ideogram_seeds with its graph stored whole, its resolved
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
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:harvest_ideogram_seeds" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 2000, ...body }),
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
const seedsFile = path.join(config.outputDir, "ideogram_seeds.json");
const known = new Set([777]);
try { for (const s of JSON.parse(fs.readFileSync(seedsFile, "utf8"))) known.add(s); } catch { /* fresh */ }

const graph = (seed) => ({
  1: { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_fp8_scaled.safetensors", weight_dtype: "default" } },
  2: { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_unconditional_fp8_scaled.safetensors", weight_dtype: "default" } },
  3: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_nvfp4.safetensors", type: "ideogram4", device: "default" } },
  /* A HARD probe prompt on purpose. The filter is a (prompt, noise) joint:
   * easy prompts pass ~40% of seeds, hard ones almost none — a seed that
   * renders THIS text-heavy poster (measured: ~13 straight refusals) is a
   * strong seed that will carry difficult prompts, which is the only kind
   * worth shipping. Harvesting on an easy prompt collects weak seeds. */
  4: { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: PROMPT } },
  5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
  6: { class_type: "CFGOverride", inputs: { model: ["1", 0], cfg: 3, start_percent: 0.7, end_percent: 1 } },
  7: { class_type: "DualModelGuider", inputs: { model: ["6", 0], positive: ["4", 0], cfg: 7, model_negative: ["2", 0], negative: ["5", 0] } },
  8: { class_type: "Ideogram4Scheduler", inputs: { steps: 20, width: 1024, height: 1024, mu: 0.0, std: 1.75 } },
  9: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
  11: { class_type: "EmptyFlux2LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  12: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["9", 0], sigmas: ["8", 0], latent_image: ["11", 0] } },
  16: { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
  17: { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["16", 0] } },
  13: { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: "ideoharvest/probe" } },
});

console.log(`probing ${COUNT} seed(s) against: "${PROMPT.slice(0, 72)}${PROMPT.length > 72 ? "…" : ""}"`);
const found = [];
for (let i = 0; i < COUNT; i++) {
  const seed = SEEDS.length ? SEEDS[i] : Math.floor(Math.random() * 4294967296);
  // A random roll that lands on a seed already in the ladder tells us nothing;
  // an EXPLICIT one is the whole point of --seeds, so it is not skipped.
  if (!SEEDS.length && known.has(seed)) continue;
  /* adopt:false — the probe is READ BACK below, out of the folder the graph
   * wrote it to, to measure whether it is the model's refusal card. Filing it
   * into the image library would move it out from under that read. */
  const d = await door({ graph: graph(seed), label: `ideogram seed ${seed}` });
  const img = d.status === "completed" ? d.outputs.find((o) => o.node === "13") : null;
  if (!img) continue;
  const buf = fs.readFileSync(path.join(config.outputDir, img.subfolder || "", img.file));
  const stats = pngLumaStats(buf);
  const card = refusalCard(buf);
  const pass = stats !== null && !card.isCard;
  console.log(`${String(i + 1).padStart(4)}/${COUNT} seed ${seed} -> ${pass ? "PASS" : "card"}`
    + ` (var ${stats?.variance?.toFixed(0)}, ${((stats?.flat ?? 0) * 100).toFixed(0)}% flat)`);
  if (pass) {
    found.push(seed); known.add(seed);
    fs.writeFileSync(seedsFile, JSON.stringify([...known].filter((s) => s !== 777)));
  }
}
console.log(`done: ${found.length} new passing seeds${found.length ? ` (${found.join(", ")})` : ""} — total known: ${known.size}`);
