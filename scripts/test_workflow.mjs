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
  nextIdeogramSeed, isRefusalCard, ideogramRefusalMessage, IDEOGRAM_CARD,
  coverGraph, coverPrompt,
  zImageGraph, ZIMAGE_PRESET, ZIMAGE_DITS,
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

/* ── zImageGraph: the vendor presets, verbatim ──────────────────────────────
 * Every number here was read out of ComfyUI's own bundled templates on this
 * rig — image_z_image_turbo.json and image_z_image.json, definitions.
 * subgraphs[0], the KSampler's widgets_values — not remembered and not
 * inferred from a blog post. A preset typo ships the wrong schedule to every
 * install, and 8-vs-25 steps is the difference between a picture and mush. */
{
  const t = zImageGraph({ prompt: "p", seed: 7 });
  eq("turbo is the default variant", t["1"].inputs.unet_name, ZIMAGE_DITS.turbo);
  eq("turbo: 8 steps", t["8"].inputs.steps, 8);
  eq("turbo: cfg 1.0", t["8"].inputs.cfg, 1.0);
  eq("res_multistep, from the template", t["8"].inputs.sampler_name, "res_multistep");
  eq("simple scheduler, from the template", t["8"].inputs.scheduler, "simple");
  eq("denoise 1", t["8"].inputs.denoise, 1);
  eq("the seed reaches the sampler", t["8"].inputs.seed, 7);

  const b = zImageGraph({ prompt: "p", seed: 7, variant: "base" });
  eq("base loads the OTHER checkpoint", b["1"].inputs.unet_name, ZIMAGE_DITS.base);
  eq("base: 25 steps", b["8"].inputs.steps, 25);
  eq("base: cfg 4.0", b["8"].inputs.cfg, 4.0);
  eq("...and the two checkpoints are genuinely different files",
     ZIMAGE_DITS.turbo === ZIMAGE_DITS.base, false);

  /* 🔴 THE FOOTGUN, in executable form. qwen_3_4b.safetensors serves BOTH
   * Z-Image and FLUX.2 klein, and comfy/sd.py picks the wrapper from this one
   * string: FLUX/FLUX2 -> klein's three-layer tap, anything else -> Z-Image's
   * penultimate-layer path. Measured 2026-08-27 with the string flipped and
   * nothing else changed: "lumina2" rendered a photograph in 4.5 s, "flux2"
   * threw at the KSampler — `normalized_shape=[2560] ... got input of size
   * [1, 512, 7680]`, because 7680 is klein's 3 x 2560 against Z-Image's
   * cap_feat_dim of 2560. Nothing warns at load or encode time; both of those
   * nodes succeed. This assertion is the reason a future tidy-up that
   * "unifies" the two CLIPLoader type strings in this file fails here. */
  eq("the encoder type is lumina2 — NEVER flux2, see the block comment",
     t["2"].inputs.type, "lumina2");
  eq("...and both variants agree on it", b["2"].inputs.type, "lumina2");
  eq("both load the SAME encoder file as FLUX.2 klein",
     t["2"].inputs.clip_name, "qwen_3_4b.safetensors");
  eq("the VAE is FLUX.1's ae, not FLUX.2's 32-channel one",
     t["3"].inputs.vae_name, "ae.safetensors");

  /* The shift node is absent from no template and easy to read as decoration.
   * Without it the schedule falls back to the Lumina2 parent's shift 6.0. */
  eq("ModelSamplingAuraFlow sits between the loader and the sampler",
     t["6"].class_type, "ModelSamplingAuraFlow");
  eq("...at shift 3.0, the value ZImage's own model class declares", t["6"].inputs.shift, 3.0);
  eq("...and the sampler takes the PATCHED model, not the raw one",
     t["8"].inputs.model.join(","), "6,0");

  /* Turbo's negative is a zeroed copy because ComfyUI never evaluates the
   * uncond branch at cfg 1.0; base gets a real encode. The UI, the route and
   * the MCP description all lean on this being true. */
  eq("turbo's negative is a zeroed copy of the positive", t["5"].class_type, "ConditioningZeroOut");
  eq("...fed from the positive encode", t["5"].inputs.conditioning.join(","), "4,0");
  eq("base's negative is a REAL text encode", b["5"].class_type, "CLIPTextEncode");
  eq("a negative handed to turbo cannot reach the graph at all",
     zImageGraph({ prompt: "p", negative: "blurry", seed: 1 })["5"].class_type, "ConditioningZeroOut");
  eq("...while base encodes it",
     zImageGraph({ prompt: "p", negative: "blurry", seed: 1, variant: "base" })["5"].inputs.text, "blurry");
  eq("no negative on base encodes as the empty string, not 'undefined'",
     b["5"].inputs.text, "");

  /* cfg is the caller's on base and NOT the caller's on turbo: raising it
   * there would switch the uncond pass back on and sample a distilled model
   * the way it was distilled not to be. */
  eq("base honours an explicit cfg",
     zImageGraph({ prompt: "p", seed: 1, variant: "base", cfg: 3.5 })["8"].inputs.cfg, 3.5);
  eq("turbo pins cfg at 1.0 whatever the caller asks",
     zImageGraph({ prompt: "p", seed: 1, cfg: 7 })["8"].inputs.cfg, 1.0);
  eq("an explicit step count passes through",
     zImageGraph({ prompt: "p", seed: 1, variant: "base", steps: 40 })["8"].inputs.steps, 40);
  eq("an unknown variant falls back to turbo rather than throwing",
     zImageGraph({ prompt: "p", seed: 1, variant: "nonsense" })["8"].inputs.steps, ZIMAGE_PRESET.turbo.steps);

  /* EmptySD3LatentImage declares step 16 on both dimensions, and the latent is
   * 8x-compressed then 2x-patchified — 16 is the real grid. Snapped UP so a
   * requested size is never silently cropped. */
  for (const [w, h, ew, eh] of [[1000, 1000, 1008, 1008], [1024, 1024, 1024, 1024],
                                [1281, 721, 1296, 736], [10, 10, 256, 256]]) {
    const g = zImageGraph({ prompt: "p", seed: 1, width: w, height: h });
    eq(`${w}x${h} snaps up to ${ew}x${eh}`, `${g["7"].inputs.width}x${g["7"].inputs.height}`, `${ew}x${eh}`);
  }
  eq("the latent node is SD3's, which is what the Lumina2 family uses",
     t["7"].class_type, "EmptySD3LatentImage");
  eq("count 0 still renders one image",
     zImageGraph({ prompt: "p", seed: 1, count: 0 })["7"].inputs.batch_size, 1);
  eq("count 4 batches four", zImageGraph({ prompt: "p", seed: 1, count: 4 })["7"].inputs.batch_size, 4);

  /* Same output contract as every other image graph: art.js reads the two
   * SaveImage nodes BY NODE ID, so 13/15 are load-bearing, not cosmetic. */
  eq("node 13 is the full-size SaveImage", t["13"].class_type, "SaveImage");
  eq("node 15 is the thumbnail SaveImage", t["15"].class_type, "SaveImage");
  eq("...and the thumbnail is scaled from the decode, not from disk",
     t["14"].inputs.image.join(","), "17,0");
  eq("the prefix reaches both",
     zImageGraph({ prompt: "p", seed: 1, prefix: "img" })["15"].inputs.filename_prefix, "img_thumb");
}

/* ── imageDeadlineMs: THE DEADLINE MUST COVER THE JOB SPACE THE ROUTE ACCEPTS
 *
 * This was a flat 180 s, justified by a comment reading "it is three seconds",
 * which was true when the only image engine was 4-step distilled FLUX.2 klein.
 * Two things broke it. Z-Image base is 25 steps with real CFG and measured
 * still-running at 13 minutes on a RAM-starved box — the deadline fired, the
 * library marked the job failed, and ComfyUI carried on rendering the picture.
 * And /api/image accepts 2048² x 60 steps x count 4 on a checkpoint, with
 * `count` batching inside ONE prompt, so all four render under this one
 * deadline: a job the old constant could not have completed under any
 * circumstances. That is not a slow path, it is an unreachable one.
 *
 * So the property pinned here is not a magic number. It is: **the deadline
 * exceeds a realistic render time for the largest job the route will accept.**
 * The realistic figure is rebuilt below from the rate MEASURED on this rig,
 * independently of the constants the function itself uses — so lowering the
 * function's own padding fails this, which is the whole point. */
{
  const { imageDeadlineMs, imageCostSeconds } = await import("../server/art.js");

  /* The route's clamps, from server/index.js: width/height 256..2048, steps
   * 60 on a checkpoint, count 1..4. This is the biggest thing it will take. */
  const WORST = { engine: "checkpoint", steps: 60, count: 4, width: 2048, height: 2048 };

  /* Realistic seconds for WORST, from measurement rather than from the
   * function under test: Z-Image base ran 1024² at 0.85 s a step with two
   * model passes (7.2 s at 6 steps, 23.3 s at 25 — the difference is the
   * per-step rate), so 0.42 s per model pass per megapixel. WORST is
   * 60 steps x 4 slots x 2 passes x 4 MP = 1920 pass-megapixels, plus a cold
   * SDXL load. */
  const MEASURED_PER_PASS_MP = 0.42;
  const COLD_LOAD = 60;
  const realisticWorst = COLD_LOAD + MEASURED_PER_PASS_MP * 60 * 4 * 2 * 4;   // ~866 s
  eq("the largest job the route accepts really is ~15 minutes of work",
     Math.round(realisticWorst / 60) >= 12 && Math.round(realisticWorst / 60) <= 18, true,
     `${Math.round(realisticWorst)}s`);
  eq("THE BUG: the old flat 180 s could not have covered it",
     180_000 > realisticWorst * 1000, false);
  eq("the deadline covers it outright",
     imageDeadlineMs(WORST) > realisticWorst * 1000, true,
     `${Math.round(imageDeadlineMs(WORST) / 1000)}s vs ${Math.round(realisticWorst)}s`);
  /* ...and with room for the contention this box actually exhibits: two
   * resident ComfyUI instances holding 15,749 of 16,376 MiB turned a 41 s
   * render into a 13-minute one. Three times the honest cost is the floor of
   * what "sits above the worst case" can mean here. */
  eq("...with at least 3x headroom for a contended machine",
     imageDeadlineMs(WORST) > realisticWorst * 3 * 1000, true,
     `${Math.round(imageDeadlineMs(WORST) / 1000)}s vs ${Math.round(realisticWorst * 3)}s`);

  /* Each term pinned on its own, and measured as SAMPLING work rather than as
   * a total: the cold-load allowance differs per engine (Ideogram loads 25 GB,
   * Z-Image 6), so subtracting a literal would pin the wrong thing and break
   * the moment a load figure is revised. Shrinking the picture to one pixel
   * leaves the load term and nothing else, so `work()` is the sampling half. */
  const loadOf = (j) => imageCostSeconds({ ...j, width: 1, height: 1 });
  const work = (j) => imageCostSeconds(j) - loadOf(j);

  /* SIZE is the term the first version of this function missed entirely. */
  const big = { engine: "checkpoint", steps: 28, width: 2048, height: 2048 };
  const small = { engine: "checkpoint", steps: 28, width: 1024, height: 1024 };
  /* eps because `loadOf` shrinks to ONE PIXEL rather than to zero pixels —
   * a millionth of a megapixel of sampling work rides along in each term and
   * does not cancel exactly across a 4x size change. */
  eq("2048² costs four times 1024², because pixels are the work", work(big), work(small) * 4, 1e-3);
  eq("...and the deadline moves with it", imageDeadlineMs(big) > imageDeadlineMs(small), true);

  /* The other three terms. */
  eq("steps are linear",
     work({ engine: "zimage-base", steps: 50 }), work({ engine: "zimage-base", steps: 25 }) * 2);
  eq("count is linear — a batch samples every slot",
     work({ engine: "zimage-base", count: 4 }), work({ engine: "zimage-base", count: 1 }) * 4);
  eq("a CFG engine pays for every step twice",
     work({ engine: "zimage-base", steps: 8 }), work({ engine: "zimage", steps: 8 }) * 2);
  eq("count is clamped, so a bad caller cannot buy an afternoon",
     imageDeadlineMs({ engine: "zimage-base", count: 999 }),
     imageDeadlineMs({ engine: "zimage-base", count: 4 }));

  /* A distilled 4-step cover must still FAIL FAST — the point of scaling
   * rather than raising the constant for everything. Its deadline is a small
   * multiple of the floor while the worst job is measured in hours. */
  const klein = imageDeadlineMs({ engine: "flux2", width: 1024, height: 1024 });
  eq("a 4-step FLUX cover keeps at least the old 180 s", klein >= 180_000, true);
  eq("...and stays under ten minutes, so a real hang there is still caught quickly",
     klein < 600_000, true, `${Math.round(klein / 1000)}s`);
  eq("...while the worst job gets at least twenty times that",
     imageDeadlineMs(WORST) > klein * 20, true);
  eq("Z-Image Turbo lands with the distilled engines, not the CFG ones",
     imageDeadlineMs({ engine: "zimage" }) < imageDeadlineMs({ engine: "zimage-base" }), true);
  eq("nothing is ever given less than the old constant",
     imageDeadlineMs({ engine: "flux2", steps: 1, count: 1, width: 256, height: 256 }) >= 180_000, true);
  eq("an unknown engine still gets a sane budget",
     imageDeadlineMs({ engine: "whatever-2031" }) >= 180_000, true);

  /* IDEOGRAM'S STEPS COME FROM ITS PRESET, NOT FROM `steps`. ideogramGraph
   * puts 20 or 48 into its own scheduler and never reads the request's step
   * field — but the route fills that field in for every engine, so a Quality
   * render arrives carrying config.art.steps (4). Costing it at 4 gives it a
   * twelfth of the budget it needs: the same shape as costing 2048² as 1024².
   * These pin that the preset wins over the number that was passed. */
  const ideoDefault = { engine: "ideogram4", steps: 4, quality: "default", width: 1024, height: 1024 };
  const ideoQuality = { engine: "ideogram4", steps: 4, quality: "quality", width: 1024, height: 1024 };
  eq("a passed step count cannot shrink an Ideogram job below its preset",
     imageCostSeconds(ideoQuality) > imageCostSeconds({ ...ideoQuality, steps: 60 }), false);
  eq("Quality (48 steps) costs more than Default (20), whatever `steps` said",
     imageCostSeconds(ideoQuality) > imageCostSeconds(ideoDefault), true);
  eq("...in exactly the ratio the vendor presets differ by (48 against 20)",
     work(ideoQuality) / work(ideoDefault), 48 / 20, 1e-9);
  eq("Ideogram pays two model passes a step — DualModelGuider drives a second DiT",
     work({ ...ideoDefault, quality: "turbo" }) / work({ engine: "zimage", steps: 12, width: 1024, height: 1024 }), 2, 1e-9);
  eq("and its 25 GB of weights buy a bigger cold-load allowance than Z-Image's 6",
     loadOf(ideoDefault) > loadOf({ engine: "zimage" }), true);
  eq("a Quality render gets a deadline in the tens of minutes, not the five it had",
     imageDeadlineMs(ideoQuality) > 900_000, true, `${Math.round(imageDeadlineMs(ideoQuality) / 1000)}s`);

  /* WIRE IT OR IT DOES NOT EXIST: the call site has to actually pass the size
   * AND the quality, or every 2048² job is costed as a 1024² one and every
   * Ideogram job as a 4-step one — the same silent field-drop that motivated
   * the census in server/mcp-image_test.js. */
  const artSrc = fs.readFileSync(new URL("../server/art.js", import.meta.url), "utf8");
  const call = artSrc.slice(artSrc.indexOf("const budget = imageDeadlineMs("),
                            artSrc.indexOf("const deadline = Date.now() + budget"));
  for (const field of ["engine", "steps", "count", "width", "height", "quality"]) {
    eq(`the render loop passes ${field} to imageDeadlineMs`,
       new RegExp(`\\b${field}\\b`).test(call), true);
  }
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

/* ── nextIdeogramSeed: THE RETRY THAT COULD NOT RETRY ───────────────────────
 * The bug this replaces: art.js re-picked with `ladder[attempt % length]`, so
 * on the one-entry ladder every machine ships with, the "retry" was
 * `ladder[1 % 1]` — the same seed, the same deterministic render, a wasted
 * pass and then a rename ENOENT off ComfyUI's node cache. The question is
 * which seeds are UNTRIED, never how many attempts have happened. */
{
  eq("a fresh job gets the first ladder entry", nextIdeogramSeed([], [777]), 777);
  eq("a ONE-entry ladder is exhausted after that one seed — no second attempt exists",
     nextIdeogramSeed([777], [777]), undefined);
  eq("...and specifically never re-offers the seed that just drew the card",
     nextIdeogramSeed([777], [777]) === 777, false);
  eq("a longer ladder walks forward", nextIdeogramSeed([777], [777, 999, 4242]), 999);
  eq("...and keeps walking", nextIdeogramSeed([777, 999], [777, 999, 4242]), 4242);
  eq("an exhausted long ladder gives up rather than wrapping",
     nextIdeogramSeed([777, 999, 4242], [777, 999, 4242]), undefined);
  eq("burned seeds out of ladder order are still respected",
     nextIdeogramSeed([999], [777, 999, 4242]), 777);
  eq("a junk tried-list does not crash the pick", nextIdeogramSeed(null, [777]), 777);
  // The old arithmetic, kept here as the thing that must never come back.
  eq("the old modulo would have re-picked 777; this does not",
     [777][1 % 1] === nextIdeogramSeed([777], [777]), false);

  /* ── and the OTHER half of a one-entry ladder ──────────────────────────
   * Before the requested seed was allowed to choose, the answer was always
   * `free[0]`, and free[0] is always 777 — so 777 painted every Ideogram
   * picture and every Ideogram cover that has ever been rendered, whatever
   * seed was asked for. Harvesting more seeds changed nothing until this. */
  const L = [777, 111, 222, 333];
  eq("a requested seed chooses which pass-seed paints", nextIdeogramSeed([], L, 1), 111);
  eq("...so two different rolls are two different pictures",
     nextIdeogramSeed([], L, 1) === nextIdeogramSeed([], L, 2), false);
  eq("...deterministically, so the same roll reproduces",
     nextIdeogramSeed([], L, 987654), nextIdeogramSeed([], L, 987654));
  eq("...spread over the WHOLE ladder, not just the front",
     new Set([0, 1, 2, 3, 4, 5, 6, 7].map((n) => nextIdeogramSeed([], L, n))).size, 4);
  eq("a negative seed still lands on a real entry",
     L.includes(nextIdeogramSeed([], L, -7)), true);
  eq("the choice indexes the UNTRIED subset, so a burned seed is unreachable",
     [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].some((n) => nextIdeogramSeed([777, 111], L, n) === 777), false);
  eq("...and a retry (no requested seed) still walks from the front — 777 is the backstop",
     nextIdeogramSeed([111], L), 777);
  eq("a one-entry ladder has nothing to spread over and still answers",
     nextIdeogramSeed([], [777], 12345), 777);
}

/* ── isRefusalCard: the card, in numbers ────────────────────────────────────
 * MEASURED over 116 refusal cards and 101 real renders on this machine:
 *
 *                      variance      flat    modal luma   modal chroma
 *   116 refusal cards   77 – 127   90 – 99%   108 – 111      1.0 – 2.0
 *   101 real renders   183 – 8179    0 – 96%     2 – 250      1.3 – 98
 *
 * 🔑 BOTH single-signal rules are wrong, in opposite directions, and both
 * failures were observed rather than imagined:
 *   variance < 120 alone MISSES 27 of the 116 cards;
 *   flat >= 0.9 alone DELETES 4 of the 101 real renders, one of them a
 *   minimalist poster (a flat green field with cream lettering, 96% flat) —
 *   the exact thing this engine is for.
 * The card is a flat NEUTRAL MID-GREY field, so the flat shade's colour is
 * what tells the two apart. Against the corpus the combined rule disagrees
 * with ground truth zero times. */
{
  const card = (v, flat, luma = 110, chroma = 1.5) =>
    isRefusalCard({ variance: v, flat, modalLuma: luma, modalChroma: chroma });
  eq("the card in the owner's library is a card", card(77.4, 0.968).isCard, true);
  eq("...caught by flatness, and said so", /neutral grey/.test(card(77.4, 0.968).why), true);
  eq("a card whose variance CLEARS the old 120 cut is still caught",
     card(127, 0.981).isCard, true);

  // The false positive that mattered: minimalist flat-colour design.
  const greenPoster = card(365, 0.96, 81, 98.3);
  eq("a flat COLOURED poster is not a card — this one was being deleted",
     greenPoster.isCard, false);
  const whitePoster = card(2775, 0.915, 250, 1.9);
  eq("...nor is a poster on a flat WHITE ground, neutral though it is",
     whitePoster.isCard, false);

  eq("the flattest real render measured (50% flat) survives", card(765.6, 0.505).isCard, false);
  eq("a busy render survives", card(2775, 0.07, 27, 30).isCard, false);
  eq("a near-black real render survives", card(1266, 0.5, 2, 4.1).isCard, false);
  eq("a flat grey field that is NOT the card's grey survives",
     card(90, 0.97, 200, 1.0).isCard, false);
  eq("an unreadable png is not called a card", isRefusalCard(null).isCard, false);
  eq("...nor is one whose variance did not compute",
     isRefusalCard({ variance: NaN, flat: 0.99 }).isCard, false);

  /* Stats with no colour in them at all (an older reader, a stub) fall back to
   * the SHIPPED rule rather than to "never a card" — a detector that silently
   * stops detecting is the failure this whole change is about. */
  eq("colourless stats still apply the variance rule",
     isRefusalCard({ variance: 90, flat: 0.97 }).isCard, true);

  eq("the thresholds are the measured ones", IDEOGRAM_CARD.maxVariance, 120);
  eq("...the flat cut sits between 50.5% (real) and 90% (card)",
     IDEOGRAM_CARD.minFlat > 0.505 && IDEOGRAM_CARD.minFlat <= 0.9, true);
  eq("...the chroma cut sits between the card's 2.0 and the green poster's 98",
     IDEOGRAM_CARD.maxChroma > 2 && IDEOGRAM_CARD.maxChroma < 98, true);
  eq("...and the luma band brackets the card's 108-111 without reaching white",
     IDEOGRAM_CARD.luma[0] < 108 && IDEOGRAM_CARD.luma[1] > 111 && IDEOGRAM_CARD.luma[1] < 250, true);
}

/* ── ideogramRefusalMessage: the failure has to name the real constraint ────
 * "refused on every known-good seed" was true and useless on a machine where
 * "every" is one. The ladder length and the harvester are both actionable, so
 * both are in the sentence. */
{
  const one = ideogramRefusalMessage(1, 1);
  eq("it names the harvester script", one.includes("harvest_ideogram_seeds.mjs"), true);
  eq("it names the file the harvest writes", one.includes("ideogram_seeds.json"), true);
  eq("it says the ladder has ONE entry", /ladder has 1 entry/.test(one), true);
  eq("...and that this means no retry was possible",
     /no second seed to retry on/.test(one), true);
  eq("it still offers the engines that would work", /FLUX\.2/.test(one), true);
  const many = ideogramRefusalMessage(9, 3);
  eq("a long ladder reports how many seeds were actually burned",
     /all 3 seeds tried/.test(many), true);
  eq("...and pluralises the ladder", /ladder has 9 entries/.test(many), true);
  eq("...without claiming there was no retry", /no second seed/.test(many), false);
}

/* ── coverGraph: reference images (FLUX.2 in-context editing) ───────────────
 * The capability the Images form could not reach until now. Each reference is
 * VAE-encoded and threaded through BOTH conditioning chains; the prompt then
 * calls them "image 1", "image 2" IN THIS ORDER, so the chain order is the
 * feature and a reordered list must produce a reordered graph. */
{
  const bare = coverGraph({ prompt: "p", seed: 1 });
  eq("no references: the guider reads the plain conditioning",
     JSON.stringify(bare["6"].inputs.positive), '["4",0]');
  eq("...and no reference nodes exist at all", bare["40"], undefined);

  const two = coverGraph({ prompt: "p", seed: 1, refImages: ["a.png", "b.png"] });
  eq("one LoadImage per reference, first at node 40", two["40"].inputs.image, "a.png");
  eq("...striding by ten so the fixed nodes can never collide", two["50"].inputs.image, "b.png");
  eq("each reference is VAE-encoded", two["41"].class_type, "VAEEncode");
  eq("...through the graph's own VAE", JSON.stringify(two["41"].inputs.vae), '["3",0]');
  eq("the positive chain threads reference 1 then 2",
     JSON.stringify(two["52"].inputs.conditioning), '["42",0]');
  eq("the guider ends on the LAST reference's positive",
     JSON.stringify(two["6"].inputs.positive), '["52",0]');
  eq("...and on the last reference's negative, so both chains carry them",
     JSON.stringify(two["6"].inputs.negative), '["53",0]');

  // Order is meaning: swapping the list must swap what "image 1" points at.
  const swapped = coverGraph({ prompt: "p", seed: 1, refImages: ["b.png", "a.png"] });
  eq("reordering the list reorders the graph", swapped["40"].inputs.image, "b.png");

  const many = coverGraph({ prompt: "p", seed: 1, refImages: new Array(14).fill("x.png") });
  eq("the list is capped at ten", many["130"] !== undefined && many["140"] === undefined, true);
  const dirty = coverGraph({ prompt: "p", seed: 1, refImages: ["a.png", null, "", "b.png"] });
  eq("blanks are dropped rather than becoming a LoadImage of nothing",
     dirty["50"].inputs.image, "b.png");
  eq("a non-array refImages is ignored, not crashed on",
     coverGraph({ prompt: "p", seed: 1, refImages: "a.png" })["40"], undefined);
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
