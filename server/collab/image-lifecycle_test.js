import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as book from "./orderbook.js";
import { imageIdFromArtFile, recentImageOutcome, recordImageOutcome } from "./image-lifecycle.js";

const id = "o_0123456789ab";
const imageId = "i0123456789abcdef";

async function fixture(fn) {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "aiplay-image-life-"));
  try {
    await book.landOrderRow({ outDir, row: { id, jobType: "image", from: { fp: "friend" }, state: "landed" } });
    await book.transitionOrderState({ outDir, id, from: "landed", to: "queued",
      patch: { imageId, queuedAt: 100, renderStatus: "queued" } });
    await fn(outDir);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

test("only the exact queued image's completed PNG marks the order complete", async () => fixture(async (outDir) => {
  assert.equal(imageIdFromArtFile(`image:${imageId}`), imageId);
  assert.equal(imageIdFromArtFile("clip:i0123456789abcdef"), null);
  assert.equal(await recordImageOutcome({ book, outDir, file: "image:iother", outcome: { type: "complete", cover: "iother.png" } }), null);
  assert.equal(await recordImageOutcome({ book, outDir, file: `image:${imageId}`, outcome: { type: "complete", cover: "wrong.png" } }), null);
  assert.equal((await book.findOrder({ outDir, id, side: "in" })).renderStatus, "queued");
  await recordImageOutcome({ book, outDir, file: `image:${imageId}`,
    outcome: { type: "complete", cover: `${imageId}.png` }, now: 123 });
  const row = await book.findOrder({ outDir, id, side: "in" });
  assert.equal(row.state, "queued"); // existing explicit Send back contract
  assert.equal(row.renderStatus, "complete");
  assert.equal(row.renderCompletedAt, 123);
}));

test("confirmed failure or Stop allows retry but never invents a completed result", async () => fixture(async (outDir) => {
  await recordImageOutcome({ book, outDir, file: `image:${imageId}`,
    outcome: { type: "failed", cancelled: true }, now: 456 });
  const row = await book.findOrder({ outDir, id, side: "in" });
  assert.equal(row.state, "failed");
  assert.equal(row.renderStatus, "stopped");
  assert.equal(row.imageId, imageId);
  assert.equal(row.renderFailedAt, 456);
  assert.equal(await recordImageOutcome({ book, outDir, file: `image:${imageId}`,
    outcome: { type: "complete", cover: `${imageId}.png` } }), null);
}));

test("uncertain render and an already claimed return are never made retryable", async () => fixture(async (outDir) => {
  await book.transitionOrderState({ outDir, id, from: "queued", to: "returning" });
  assert.equal(await recordImageOutcome({ book, outDir, file: `image:${imageId}`,
    outcome: { type: "failed" } }), null);
  assert.equal((await book.findOrder({ outDir, id, side: "in" })).state, "returning");
  await book.transitionOrderState({ outDir, id, from: "returning", to: "rendering" });
  assert.equal(await recordImageOutcome({ book, outDir, file: `image:${imageId}`,
    outcome: { type: "failed" } }), null);
  assert.equal((await book.findOrder({ outDir, id, side: "in" })).state, "rendering");
}));

test("recent ArtRunner result can reconcile a terminal event that beat the queue receipt", () => {
  assert.deepEqual(recentImageOutcome({ art: { recent: [{ file: `image:${imageId}`, kind: "cover",
    covers: [`${imageId}.png`] }] } }, imageId), { type: "complete" });
  assert.deepEqual(recentImageOutcome({ art: { recent: [{ file: `image:${imageId}`, kind: "cover",
    error: "Stopped", cancelled: true }] } }, imageId), { type: "failed", cancelled: true });
  assert.equal(recentImageOutcome({ art: { recent: [] } }, imageId), null);
});
