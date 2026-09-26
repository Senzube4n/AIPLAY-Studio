/**
 * A CLIP'S DEADLINE ON A CARD THE ESTIMATE WAS NOT MEASURED ON.
 *
 * The clip deadline is 4x the cost curve's estimate plus five minutes, and the
 * curve is fitted on an NVIDIA card. On an RX 9060 XT (2026-09-24) H3 at
 * 1344x768, 124 frames, 8 steps took 1617 s against a 299 s estimate: the
 * deadline gave up at 1497 s and the finished clip was never filed.
 *
 *   node --test server/clip-budget_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { clipBudgetMs } = await import("./art.js");

test("NVIDIA keeps the old deadline", () => {
  assert.equal(clipBudgetMs(299, "nvidia"), (299 * 4 + 300) * 1000);
  assert.equal(clipBudgetMs(50, "nvidia"), 900_000, "never under 15 minutes");
});

test("any other card gets three times the room", () => {
  for (const vendor of ["amd", "intel", null]) {
    assert.equal(clipBudgetMs(299, vendor), (299 * 12 + 300) * 1000, `${vendor}`);
  }
  assert.ok(clipBudgetMs(299, "amd") > 1617_000, "the measured AMD render fits inside it");
});

test("the clip job uses it, with the card's vendor", () => {
  const art = readFileSync(new URL("./art.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(art, /const budgetMs = clipBudgetMs\(expected, vendorOf\(config\.gpu, config\.torchBackend\), videoSpeed\.factor\(engine\)\);/);
});
