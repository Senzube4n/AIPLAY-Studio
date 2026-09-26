/**
 * DOES A TEXT ENCODER OR VAE FIT THE SLOT THE ENGINE'S OWN FILE OCCUPIES?
 *
 * The Video screen's four dropdowns used to list the whole shelf: fourteen model
 * files to choose three from, and for the text encoder and the two VAE rows no
 * judgement at all — eleven encoders and fifteen VAEs offered as if any of them
 * would do, with the failure arriving much later and from inside ComfyUI.
 *
 * The verdict comes from the tensors, anchored on the file each engine came
 * with. These tests build the tensor trees by hand rather than reading this
 * machine's shelf: a suite that needs a 5 GB VAE on disk is a suite that gets
 * deleted, and the SHAPES are the thing being pinned, not the files.
 *
 * ⚠ TWO SIGNALS, AND THE REASON IS THE POINT. The first draft used one —
 * containment — and it was wrong for text encoders in a way that measured 0.997
 * on a file that does not fit. Both halves are pinned here with the case that
 * broke them, because a single-signal rewrite would pass a test that only
 * checked the easy direction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { containment, partFits, SAME_TREE } from "./partfit.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** A print as readPart() builds one, from a list of module paths. */
const print = (modules, emb = null, layers = 0) => ({ modules: new Set(modules), emb, layers });

/** A VAE's module tree, as `decoder.up.N` / `encoder.down.N` families. */
function vae(prefixDec, prefixEnc, n) {
  const m = [];
  for (let i = 0; i < n; i++) { m.push(`${prefixDec}.${i}.conv`); m.push(`${prefixEnc}.${i}.conv`); }
  return m;
}

test("a quantised rebuild fits where its original does — containment, not equality", () => {
  /* ⚠ THIS IS WHY IT IS NOT AN EXACT FINGERPRINT. Measured on the real shelf:
   * minimax_h3_video_vae_fp16 has 355 modules and minimax_h3_video_vae_int8_convrot
   * has 499 — `convrot` inserts rotation layers. An exact match grouped the two
   * H3 AUDIO VAEs correctly and would have hidden H3's own int8 VIDEO VAE. */
  const original = print(vae("decoder.transformer_blocks", "encoder.down", 40));
  const rebuilt = print([...vae("decoder.transformer_blocks", "encoder.down", 40),
    ...Array.from({ length: 40 }, (_, i) => `decoder.transformer_blocks.${i}.rot`)]);
  assert.equal(rebuilt.modules.size > original.modules.size * 1.4, true, "the rebuild really is bigger");
  assert.equal(containment(original, rebuilt), 1, "every module of the original is in the rebuild");
  assert.equal(partFits(rebuilt, original, "videoVae"), "yes");
});

test("a different autoencoder does not fit, and the gap is not a hair", () => {
  const h3 = print(vae("decoder.transformer_blocks", "encoder.down", 40));
  const flux = print(vae("decoder.up", "encoder.down", 40));
  const score = containment(flux, h3);
  assert.ok(score < SAME_TREE, `a FLUX-shaped VAE scores ${score.toFixed(3)}, under the line`);
  /* The encoder half is shared, so this is genuinely a partial match rather
   * than two trees with nothing in common — which is the case a threshold has
   * to survive. Measured on the real files: 0.328. */
  assert.ok(score > 0, "and it is a partial match, not a trivially empty one");
  assert.equal(partFits(flux, h3, "videoVae"), "no");
});

test("⚠ a SMALL model of the same family does not fit a big one's slot", () => {
  /* The bug this exists for. Containment divides by the smaller tree, so a 0.6B
   * qwen3 is almost entirely contained in a 32B qwen3 and scored 0.997 against
   * H3's own encoder. Both qwen_3_4b and qwen_3_06b_base would have been offered
   * as H3's text encoder. What has to line up is the width the DiT's
   * cross-attention was built for. */
  const layersOf = (n) => Array.from({ length: n }, (_, i) => `model.layers.${i}.mlp.down_proj`);
  const anchor = print(["model.embed_tokens", ...layersOf(50)], [151936, 5120], 50);
  const small = print(["model.embed_tokens", ...layersOf(28)], [151936, 1024], 28);

  assert.ok(containment(small, anchor) > 0.9,
    "containment says yes — which is exactly why the encoder slot must not use it");
  assert.equal(partFits(small, anchor, "textEncoder"), "no", "width decides, and 1024 is not 5120");

  const requant = print(["model.embed_tokens", ...layersOf(50)], [151936, 5120], 50);
  assert.equal(partFits(requant, anchor, "textEncoder"), "yes", "the same encoder rebuilt still fits");

  const sameWidthDifferentDepth = print(["model.embed_tokens", ...layersOf(36)], [151936, 5120], 36);
  assert.equal(partFits(sameWidthDifferentDepth, anchor, "textEncoder"), "no", "depth counts too");
});

test("⚠ what cannot be read is UNKNOWN, and unknown is never a refusal", () => {
  /* A .gguf encoder cannot be read the way a safetensors can, and two files on
   * the real shelf carry no embedding tensor to measure. Hiding a file because
   * we failed to read it is the failure the old show-everything behaviour
   * existed to prevent; it is the one thing this must not reintroduce. */
  const anchor = print(["model.embed_tokens"], [151936, 5120], 50);
  assert.equal(partFits(null, anchor, "textEncoder"), "unknown", "unreadable file");
  assert.equal(partFits(print(["model.layers.0.mlp"], null, 36), anchor, "textEncoder"), "unknown",
    "no embedding tensor to compare");
  assert.equal(partFits(print(["decoder.up.0.conv"]), null, "videoVae"), "unknown",
    "no anchor: the engine's own file is not on disk, so nothing is judged");
});

test("⚠ the anchor is the engine's own file, and no engine fact is copied here", () => {
  const pf = src("./partfit.js");
  /* A table of "h3 wants qwen3vl" would be a second copy of something config.js
   * already holds, and the copy is what goes stale. It would also be WRONG:
   * H3's own encoder is named qwen3vl_… and carries no `model.visual` tensors
   * at all — the vision tower is pruned — so a rule keyed on that name would
   * hide the engine's own file and offer three encoders that do not fit. */
  const code = pf.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["qwen3vl", "minimax", "gemma", "umt5", "flux", "h3", "ltx"]) {
    assert.ok(!new RegExp(`["'\`][^"'\`]*${name}`, "i").test(code),
      `partfit.js must not name ${name}: the engine's own file is the anchor, not a table here`);
  }
  const mp = src("./modelpick.js");
  assert.match(mp, /for \(const slot of \["textEncoder", "videoVae", "audioVae"\]\)/,
    "the anchors are read per slot out of config's engine entries");
  assert.match(mp, /anchors\[eng\]\[slot\] = f \? await printOf\(f\) : null/,
    "and a slot whose file is not on disk gets no anchor, so nothing is hidden");
});

test("a VAE is judged twice, because one file feeds two different rows", () => {
  const mp = src("./modelpick.js");
  /* The video VAE and the audio VAE read the same folder, and on the real shelf
   * nothing is ever right for both. One list for both rows is what made the old
   * dropdown useless. */
  assert.match(mp, /fitVideo: await judge\(r, "videoVae"\), fitAudio: await judge\(r, "audioVae"\)/);
  assert.match(src("../web/app.js"), /r\.fitVideo\?\.\[eng\]/, "the screen reads the video verdict");
  assert.match(src("../web/app.js"), /r\.fitAudio\?\.\[eng\]/, "and the audio one separately");
});

test("H3 reaches for the int8 video VAE first, because it is the faster one", () => {
  /* ComfyUI 0.36 shipped three MiniMax H3 VAE speedups: a fused encoder kernel
   * (automatic), fp16 accumulation behind `--fast`, and an int8 decoder as a
   * drop-in weights swap. Both VAE files were already on this rig and config
   * listed the fp16 one FIRST, so `pick()` took it and the faster build sat
   * unused.
   *
   * MEASURED HERE, not quoted from the post, because the post's headline is 2x
   * on encode+decode and that is not this machine's bottleneck: a clip is ~350 s
   * of DiT sampling around a ~25 s VAE stage, and the encoder only ever sees two
   * small reference images.
   *
   *     fp16 VAE     24 samples   median 360.9 s   (up to 464 s)
   *     int8 VAE      5 samples   median  317.4 s   (287-347)
   *
   * About 12%, with every int8 sample under the fp16 median. Quality compared
   * frame to frame on a face close-up: skin texture, hair strands, eye detail
   * and the lip highlight all hold, no banding.
   *
   * `--fast fp16_accumulation` was tested too and is NOT set: 365.8 s with it
   * against a 356 s median without, and 332 s for int8 without it against a
   * 317 s median with. No measurable gain on a DiT-bound workload, and ComfyUI
   * calls it "untested and potentially quality deteriorating" - so it buys
   * nothing and carries risk.
   *
   * The int8 file is also 3,171 MB against fp16's 5,207 MB, which is 2 GB of
   * headroom on a 16 GB card running --lowvram. */
  const cfg = src("./config.js");
  /* Two picks since 2026-09-25 (config.js LIGHT_H3): a light machine is also
   * told to fetch the int8 when neither is on disk. Both name int8 first. */
  const block = /videoVae: LIGHT_H3\s*\?([\s\S]*?)\n\s*:([\s\S]*?\),)/.exec(cfg);
  assert.ok(block, "the H3 videoVae is one pick per kind of machine");
  for (const arm of [block[1], block[2]]) {
    const order = /pick\("vae",[\s\S]{0,40}?"([^"]+)",[\s\S]{0,40}?"([^"]+)"/.exec(arm);
    assert.ok(order, "each arm is a pick()");
    assert.match(order[1], /int8/, "the int8 build is named FIRST — pick() takes the first that exists");
    assert.match(order[2], /fp16/, "and the fp16 build stays as the fallback for a rig without it");
  }
});

test("the screen lists what fits, keeps unknowns, and says what it left out", () => {
  const app = src("../web/app.js"), html = src("../web/index.html");
  assert.match(app, /const fits = \(v\) => v !== "no";/,
    "only a positive 'no' is dropped — unknown stays in the list");
  assert.ok(!/cannot drive a video render/.test(app),
    "the greyed-out rows are gone from the model list");
  assert.match(app, /vaeAll\.filter\(\(r\) => !fits\(r\.fitVideo\?\.\[eng\]\) && !fits\(r\.fitAudio\?\.\[eng\]\)\)/,
    "DISTINCT files are counted, not rows: summing the four rows said 44 on a shelf of 29");
  assert.match(app, /vidLoraShelf\.filter\(\(l\) => vidLoraFit\(l, eng\) !== "no"\)/,
    "a LoRA for another engine is not offered either");
  /* Collapsed, because "auto" is right until you have a model of your own and
   * four dropdowns held open push the prompt box off the screen. */
  assert.match(html, /<details class="adv sbox" id="vidEngineBox">/, "one collapsed section");
  assert.ok(!/<details class="adv sbox" id="vidEngineBox" open>/.test(html), "and it starts closed");
});
