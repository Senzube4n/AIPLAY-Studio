/**
 * 720P FIRST OFF NVIDIA (2026-09-25): on an AMD or Intel card, or the CPU, H3
 * and FastH3 start at 1280x720 and list it first; NVIDIA and an unrecorded
 * card keep the trained 1344x768. A full-size AMD or Intel card starts a music
 * video at 720p too. LTX already starts at 1280x704.
 *
 *   node --test server/video720_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { prefers720p, config } = await import("./config.js");
const sizes = await import("./mv/sizes.js");

test("which machines prefer 720p", () => {
  assert.equal(prefers720p({ torchBackend: "rocm" }), true);
  assert.equal(prefers720p({ torchBackend: "xpu" }), true);
  assert.equal(prefers720p({ torchBackend: "cpu" }), true);
  assert.equal(prefers720p({ gpu: { vendor: "amd" } }), true);
  assert.equal(prefers720p({ gpu: { vendor: "intel" } }), true);
  assert.equal(prefers720p({ gpu: { vendor: "nvidia" }, torchBackend: "cuda" }), false);
  assert.equal(prefers720p({}), false, "a card never recorded keeps the trained size");
});

test("H3 and FastH3 on this machine: the start size follows the rule, the trained size is kept", () => {
  const h3 = config.video.engines.h3, fast = config.video.engines.fasth3;
  assert.deepEqual([h3.nativeWidth, h3.nativeHeight], [1344, 768]);
  assert.deepEqual([h3.width, h3.height], [h3.sizes[0].w, h3.sizes[0].h], "the start size is the list's first");
  assert.deepEqual([fast.width, fast.height, fast.sizes[0].w], [h3.width, h3.height, h3.sizes[0].w], "FastH3 copies it");
  assert.ok(h3.sizes.some((z) => z.w === 1280 && z.h === 720), "720p is always offered");
  assert.ok(h3.sizes.some((z) => z.w === 1344 && z.h === 768), "and so is the trained size");
  assert.deepEqual([config.video.engines.ltx.width, config.video.engines.ltx.height], [1280, 704]);
  const cfg = read("./config.js");
  assert.match(cfg, /if \(PREFER_720P\) \{\s*h3\.width = 1280;\s*h3\.height = 720;/);
  assert.ok(cfg.indexOf("if (PREFER_720P)") < cfg.indexOf("config.video.engines.fasth3 = {"), "before FastH3 copies H3");
});

test("a music video on a full-size AMD or Intel card starts at 720p", () => {
  const pick = (vendor, totalMb) => sizes.sizeChoices({ gpu: { totalMb, vendor }, ram: { totalMb: 32768 } }).cardPick;
  assert.equal(pick("amd", 16376), "hd720");
  assert.equal(pick("intel", 16376), "hd720");
  assert.equal(pick("nvidia", 16376), "recommended");
  assert.equal(pick("amd", 8188), "small", "a smaller card keeps its measured size");
});
