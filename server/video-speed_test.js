/**
 * THIS PC'S CLIP SPEED, AND THE SPARSE ATTENTION A PERSON OPTS INTO.
 *
 * The cost curve every clip estimate comes from was fitted on the lab's
 * NVIDIA card; on an RX 9060 XT it was 5x out. video-speed.js keeps the ratio
 * of each real render to the curve, and the page and the clip deadline use
 * the median. And sol-attn, measured by the lab on the Fast setting only,
 * can be switched on for every step count and given its own tau, off and at
 * the lab's 1.3 until a person says otherwise.
 *
 *   node --test server/video-speed_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { createVideoSpeed } = await import("./video-speed.js");
const { clipBudgetMs } = await import("./art.js");
const { config } = await import("./config.js");
const { h3SparseFor } = await import("./workflow.js");

test("the factor is the median of the last renders, kept across a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vspeed-"));
  try {
    const s = createVideoSpeed({ dir });
    assert.equal(s.factor("h3"), null, "no render yet: no factor, the curve stands");
    assert.equal(s.record("h3", 1617, 299).toFixed(2), "5.41");
    s.record("h3", 600, 299);
    s.record("h3", 900, 299);
    assert.equal(s.factor("h3"), 3.01, "the median of 5.41, 2.01 and 3.01");
    assert.equal(s.samples("h3"), 3);
    assert.equal(s.record("h3", 0.1, 299), null, "a broken measurement is not a speed");
    assert.equal(s.record("h3", 1, 0), null);
    for (let i = 0; i < 10; i++) s.record("ltx", 240, 120);
    assert.equal(s.samples("ltx"), 8, "only the last eight are kept");
    const again = createVideoSpeed({ dir });
    assert.equal(again.factor("h3"), 3.01, "read back after a restart");
    assert.equal(again.factor("ltx"), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the clip deadline allows for this PC's own speed", () => {
  assert.equal(clipBudgetMs(299, "nvidia"), (299 * 4 + 300) * 1000, "no factor: as before");
  assert.equal(clipBudgetMs(299, "nvidia", 5.4), Math.round((299 * 5.4 * 4 + 300) * 1000), "a slow PC gets its measured room");
  assert.equal(clipBudgetMs(299, "amd", 0.5), clipBudgetMs(299, "amd"), "never less than the vendor's allowance");
  const art = read("./art.js");
  assert.match(art, /const budgetMs = clipBudgetMs\(expected, vendorOf\(config\.gpu, config\.torchBackend\), videoSpeed\.factor\(engine\)\);/);
  assert.match(art, /if \(!done\.cached\) videoSpeed\.record\(engine, done\.runningSec \?\? done\.elapsedSec, expected\);/,
    "a real render is measured; a cache hit is not a speed");
});

test("the status sends it and the page's estimate uses it", () => {
  assert.match(read("./index.js"), /speedFactor: videoSpeed\.factor\(k\), speedSamples: videoSpeed\.samples\(k\),/);
  const app = read("../web/app.js");
  assert.match(app, /const secs = Math\.round\(curveSecs \* \(measured \? Number\(eng\.speedFactor\) : 1\)\);/);
  assert.match(app, /"about " \+ fmt\(secs\) \+ \(measured \? " on this PC" : ""\) \+ " once the engine is idle/);
});

test("sparse attention everywhere and its tau are opt-in, and the defaults are the lab's", () => {
  const h3 = config.video.engines.h3;
  assert.equal(h3.sparseAll, false, "off until a person switches it on");
  assert.equal(h3.solAttnTau, null, "the lab's tau until a person sets one");
  const eng = (over) => ({ ...h3, ...over });
  assert.equal(h3SparseFor(eng({}), { steps: 8 }), null, "8 steps stays dense by default");
  assert.equal(h3SparseFor(eng({ sparseAll: true }), { steps: 8 })?.method, "sol-attn", "opted in: 8 steps");
  assert.equal(h3SparseFor(eng({ sparseAll: true }), { steps: 20 })?.method, "sol-attn", "and Best");
  assert.equal(h3SparseFor(eng({ sparseAll: true }), { steps: 8, refs: true }), null, "references stay dense");
  assert.equal(h3SparseFor(eng({ sparseAll: true }), { steps: 8, control: true }), null, "video-to-video stays dense");
  assert.equal(h3SparseFor(eng({ sparseAll: true, sparse: "off" }), { steps: 8 }), null, "the main switch still wins");
  assert.equal(h3SparseFor(eng({ solAttnTau: 1.8 }), { steps: 8 }), null, "a tau alone switches nothing on");
  assert.equal(h3SparseFor(eng({ sparseAll: true, solAttnTau: 1.8 }), { steps: 8 }).tau, 1.8);
  assert.equal(h3SparseFor(eng({ sparseAll: true, solAttnTau: 7 }), { steps: 8 }).tau, h3.solAttn.tau, "out of range: the lab's");
  assert.equal(h3.solAttn.tau, 1.3, "the recipe itself is untouched");
  const cat = read("./videolab/catalog.js");
  assert.match(cat, /id: "sparse_everywhere",[\s\S]{0,120}kind: "bool", onValue: true, offValue: false,\s*path: \["video", "engines", "h3", "sparseAll"\],/);
  assert.match(cat, /id: "sparse_tau",[\s\S]{0,120}kind: "number", min: 1, max: 2, step: 0\.1,\s*path: \["video", "engines", "h3", "solAttnTau"\],/);
});
