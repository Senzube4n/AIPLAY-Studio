/**
 * Unit tests for the graph builders in server/workflow.js.
 *
 * These functions decide what ComfyUI is actually asked to render, and a wrong
 * number here fails silently: a mis-snapped width renders SOMETHING, just not
 * what was asked, and a preset typo ships the wrong schedule to every install.
 * They are pure — options in, a JSON graph out — so unlike the timeline maths
 * they can simply be imported. config.js is import-safe (it reads settings
 * defensively and never throws), so no stubbing is needed; the one test that
 * touches disk (the seed harvest merge) points config.outputDir at a temp
 * directory and restores it.
 *
 *   node scripts/test_workflow.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import {
  ideogramGraph, checkpointGraph, ideogramPassSeeds, IDEOGRAM_PASS_SEEDS,
  coverPrompt,
} from "../server/workflow.js";

let pass = 0, fail = 0;
function eq(name, got, want, eps = 1e-9) {
  const ok = typeof want === "number" ? Math.abs(got - want) <= eps : got === want;
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got ${got}, wanted ${want}`); }
}

console.log("\nworkflow graphs\n");

/* ── ideogramGraph: the vendor presets ──────────────────────────────────────
 * Verbatim from the blueprint's preset table. A drifted number here is not an
 * error anyone sees — it is every install quietly rendering off-schedule. */
{
  const sched = (q) => ideogramGraph({ prompt: "p", seed: 777, quality: q })["8"].inputs;
  const d = sched("default");
  eq("default preset: 20 steps", d.steps, 20);
  eq("default preset: mu 0", d.mu, 0.0);
  eq("default preset: std 1.75", d.std, 1.75);
  const q = sched("quality");
  eq("quality preset: 48 steps", q.steps, 48);
  eq("quality preset: mu 0", q.mu, 0.0);
  eq("quality preset: std 1.5", q.std, 1.5);
  const t = sched("turbo");
  eq("turbo preset: 12 steps", t.steps, 12);
  eq("turbo preset: mu 0.5", t.mu, 0.5);
  eq("turbo preset: std 1.75", t.std, 1.75);
  eq("an unknown quality falls back to the default preset", sched("nonsense").steps, 20);
}

/* ── ideogramGraph: size snapping ───────────────────────────────────────────
 * Multiples of 16 with a 256 floor — and the SAME size must reach both the
 * scheduler and the latent, because Ideogram's sigma schedule is
 * resolution-dependent: a size passed to one but not the other silently
 * produces a mismatched schedule. */
{
  const at = (w, h) => {
    const g = ideogramGraph({ prompt: "p", seed: 777, width: w, height: h });
    return { s: g["8"].inputs, l: g["11"].inputs };
  };
  const a = at(1000, 100);
  eq("width snaps up to the next multiple of 16", a.s.width, 1008);
  eq("height floors at 256", a.s.height, 256);
  eq("scheduler and latent agree on width", a.s.width, a.l.width);
  eq("scheduler and latent agree on height", a.s.height, a.l.height);
  const b = at(1024, 512);
  eq("a multiple of 16 passes through untouched", b.s.width, 1024);
  eq("so does the height", b.s.height, 512);
  const c = at(undefined, undefined);
  eq("no width means the 1024 default", c.s.width, 1024);
  eq("no height means the 1024 default", c.s.height, 1024);
  eq("one pixel over snaps up, not down", at(1025, 1024).s.width, 1040);
}

/* ── ideogramGraph: batching and the fixed wiring ─────────────────────────── */
{
  const g = ideogramGraph({ prompt: "p", seed: 777, count: 3, prefix: "img" });
  eq("count becomes the latent batch size", g["11"].inputs.batch_size, 3);
  eq("count 0 still renders one image", ideogramGraph({ prompt: "p", seed: 1, count: 0 })["11"].inputs.batch_size, 1);
  // The dual-model guider is the engine's signature: conditional DiT plus a
  // SEPARATE unconditional DiT, both the fp8_scaled builds.
  eq("node 1 loads the conditional fp8_scaled DiT", g["1"].inputs.unet_name, "ideogram4_fp8_scaled.safetensors");
  eq("node 2 loads the unconditional fp8_scaled DiT", g["2"].inputs.unet_name, "ideogram4_unconditional_fp8_scaled.safetensors");
  eq("the guider's negative model is node 2", g["7"].inputs.model_negative.join(","), "2,0");
  // art.js reads COVER_NODES = { full: "13", thumb: "15" }; these ids are the
  // contract that lets the two SaveImage outputs be told apart when count > 1.
  eq("node 13 is the full-size SaveImage", g["13"].class_type, "SaveImage");
  eq("node 13 writes the prefix", g["13"].inputs.filename_prefix, "img");
  eq("node 15 is the thumbnail SaveImage", g["15"].class_type, "SaveImage");
  eq("node 15 writes prefix_thumb", g["15"].inputs.filename_prefix, "img_thumb");
  eq("the seed reaches the noise node", g["10"].inputs.noise_seed, 777);
}

/* ── checkpointGraph: bring-your-own SD ─────────────────────────────────────
 * The negative prompt is the reason this graph exists separately — the
 * distilled house models have no use for one, SD-class checkpoints do. So the
 * one wiring worth asserting is that the negative text actually reaches the
 * sampler's negative input rather than being encoded and dropped. */
{
  const g = checkpointGraph({ ckpt: "my.safetensors", prompt: "a cat", negative: "blurry, extra limbs", seed: 42 });
  eq("the checkpoint name reaches the loader", g["1"].inputs.ckpt_name, "my.safetensors");
  eq("the positive text is encoded", g["2"].inputs.text, "a cat");
  eq("the negative text is encoded", g["3"].inputs.text, "blurry, extra limbs");
  eq("the sampler's positive is the positive encode", g["5"].inputs.positive.join(","), "2,0");
  eq("the sampler's negative is the negative encode", g["5"].inputs.negative.join(","), "3,0");
  eq("no negative encodes as the empty string, not 'undefined'",
     checkpointGraph({ ckpt: "c", prompt: "p", seed: 1 })["3"].inputs.text, "");
  eq("default steps 28", g["5"].inputs.steps, 28);
  eq("default cfg 6", g["5"].inputs.cfg, 6);
  const h = checkpointGraph({ ckpt: "c", prompt: "p", seed: 1, steps: 40, cfg: 7.5 });
  eq("explicit steps pass through", h["5"].inputs.steps, 40);
  eq("explicit cfg passes through", h["5"].inputs.cfg, 7.5);
  eq("the seed reaches the sampler", g["5"].inputs.seed, 42);
  eq("node 13 is the full-size SaveImage", g["13"].class_type, "SaveImage");
  eq("node 15 is the thumbnail SaveImage", g["15"].class_type, "SaveImage");
}

/* ── ideogramPassSeeds: the noise-lock workaround ───────────────────────────
 * 777 is the one seed shipped as data; a harvest file in the output directory
 * extends the set. outputDir is settable on the live config object, so the
 * merge is tested against a temp directory rather than whatever a real rig has
 * harvested — and restored, because other tests read config too. */
{
  const realOut = config.outputDir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-seeds-"));
  try {
    config.outputDir = tmp;
    eq("no harvest yet: exactly the shipped set", ideogramPassSeeds().join(","), "777");
    eq("777 is in the shipped set itself", IDEOGRAM_PASS_SEEDS.includes(777), true);

    fs.writeFileSync(path.join(tmp, "ideogram_seeds.json"), JSON.stringify([999, 777, "bad", null, 3.5]));
    const merged = ideogramPassSeeds();
    eq("harvested seeds are merged in", merged.includes(999), true);
    eq("777 survives the merge", merged.includes(777), true);
    eq("a duplicate 777 is not doubled", merged.filter((s) => s === 777).length, 1);
    eq("non-numbers in the harvest are dropped", merged.length, 3);

    fs.writeFileSync(path.join(tmp, "ideogram_seeds.json"), "{ not json");
    eq("a corrupt harvest file falls back to the shipped set", ideogramPassSeeds().join(","), "777");
    fs.writeFileSync(path.join(tmp, "ideogram_seeds.json"), JSON.stringify({ seeds: [1] }));
    eq("a harvest that is not an array falls back too", ideogramPassSeeds().join(","), "777");
  } finally {
    config.outputDir = realOut;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ── coverPrompt: notation must never reach the image model ─────────────────
 * The regression this guards: captions like "Piano Melody: E4 E4 G4 A4 G4 E4,
 * quarter quarter half" produced covers with those exact symbols CARVED INTO
 * the object. The style half of the prompt varies per install (config.art.style
 * is a saved preference), so assertions read the subject half only. */
{
  const out = coverPrompt({ caption: "Piano Melody: E4 E4 G4 A4 G4 E4, quarter quarter half, rising then falling", seed: 0 });
  eq("note names do not appear verbatim", /\b[A-G]#?\d\b/.test(out), false);
  eq("rhythm words do not appear either", /quarter|eighth/i.test(out), false);
  eq("the one non-notation clause survives as the subject", out.endsWith("evoking rising then falling"), true);

  // Mostly-notation clauses are dropped whole; a clause under the 40% junk
  // threshold keeps its incidental note name. That is the tuned line between
  // scrubbing notation and eating real captions that mention a key.
  const mixed = coverPrompt({ caption: "a slow ballad in E4 for late nights that end well", seed: 0 });
  eq("a clause that merely mentions a note is kept", mixed.includes("a slow ballad"), true);

  const struct = coverPrompt({ caption: "Global Metadata, BPM is 96, dark synthwave with analog pads", seed: 0 });
  eq("structured-caption headings are dropped", /metadata/i.test(struct), false);
  eq("BPM markings are dropped", /96|bpm/i.test(struct), false);
  eq("the actual description survives", struct.includes("dark synthwave with analog pads"), true);
}

/* ── coverPrompt: fallbacks ─────────────────────────────────────────────────
 * A real title is a usable subject; a filename-derived one ("aiplay") is not —
 * eleven captionless tracks once rendered the word "aiplay" as a nondescript
 * rock. And the no-caption-no-title fallback ROTATES by seed, so a library of
 * captionless tracks does not collapse to one idea. */
{
  eq("a real title becomes the subject",
     coverPrompt({ caption: "", title: "Night Drive", seed: 0 }).endsWith("evoking Night Drive"), true);
  eq("a filename-derived title is rejected",
     /evoking aiplay/i.test(coverPrompt({ caption: "", title: "aiplay_00001", seed: 0 })), false);
  eq("so is a bare output prefix",
     /evoking preview/i.test(coverPrompt({ caption: "", title: "preview", seed: 0 })), false);

  const s3 = coverPrompt({ caption: "", title: "", seed: 3 });
  eq("the fallback is stable for a given seed", coverPrompt({ caption: "", title: "", seed: 3 }), s3);
  eq("and different seeds spread across the pool",
     s3 === coverPrompt({ caption: "", title: "", seed: 4 }), false);
  // An entirely-notation caption must land in the same fallback pool, not
  // produce "evoking " with nothing after it.
  const notation = coverPrompt({ caption: "E4 G4 A4, quarter quarter half", title: "", seed: 5 });
  eq("an all-notation caption falls through to the pool", /evoking\s*$/.test(notation), false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
