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
