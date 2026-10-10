import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as book from "./orderbook.js";
import { recordVideoFailure, videoIdFromArtFile } from "./video-lifecycle.js";

const AT = new Date(2026, 8, 26, 12, 0, 0).getTime();
const FP = "ab".repeat(16);

async function withBook(run) {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "aiplay-video-failure-"));
  try { await run(outDir); }
  finally { await rm(outDir, { recursive: true, force: true }); }
}

async function landed(outDir, id) {
  await book.landOrderRow({ outDir, row: { id, jobType: "video", from: { fp: FP },
    state: "landed", landedAt: AT - 1000, renderEstimatedMinutes: 4 } });
  return book.transitionOrderState({ outDir, id, from: "landed", to: "queued",
    patch: { renderStatus: "requested", renderRequestedAt: AT - 60 * 60_000 } });
}

test("failed H3 event records elapsed work and cannot overwrite a completed clip", async () => {
  await withBook(async (outDir) => {
    const id = "o_" + "a".repeat(12);
    await landed(outDir, id);
    const row = await recordVideoFailure({ book, outDir, file: `clip:collab_${id}`,
      kind: "video", durationMs: 90_000, runId: "engine-run-1", now: AT });
    assert.deepEqual([row.state, row.renderStatus, row.renderFailedAt, row.renderRunMs, row.renderRunId],
      ["failed", "failed", AT, 90_000, "engine-run-1"]);
    assert.equal(await recordVideoFailure({ book, outDir, file: `clip:collab_${id}`,
      kind: "video", durationMs: 999_000, now: AT + 1 }), null,
    "a repeated event cannot bill the same failed attempt twice");

    const doneId = "o_" + "b".repeat(12);
    await landed(outDir, doneId);
    await book.fillOrderRow({ outDir, id: doneId, patch: { renderStatus: "complete", renderRunMs: 80_000 } });
    await assert.rejects(book.transitionOrderState({ outDir, id: doneId, from: "queued", to: "failed",
      expected: { renderStatus: "requested" }, patch: { renderStatus: "failed" } }),
    (error) => error.reason === "order-state-changed",
    "a stale failure observer cannot overwrite a completion while state remains queued");
    assert.equal(await recordVideoFailure({ book, outDir, file: `clip:collab_${doneId}`,
      kind: "video", durationMs: 999_000, now: AT }), null);
    assert.equal((await book.findOrder({ outDir, id: doneId, side: "in" })).renderStatus, "complete");
  });
});

test("a video stopped before its turn has no render clock", async () => {
  await withBook(async (outDir) => {
    const id = "o_" + "c".repeat(12);
    await landed(outDir, id);
    const row = await recordVideoFailure({ book, outDir, file: `clip:collab_${id}`,
      kind: "video", cancelled: true, durationMs: null, now: AT });
    assert.deepEqual([row.state, row.renderStatus, row.renderRunMs], ["failed", "stopped", null]);
    assert.equal(videoIdFromArtFile(`clip:collab_${id}`), id);
    assert.equal(videoIdFromArtFile("clip:collab_o_not-an-id"), null);
    assert.equal(await recordVideoFailure({ book, outDir, file: `image:${id}`,
      kind: "cover", durationMs: 1000, now: AT }), null);
  });
});

test("a pre-queue refusal does not turn the unqueued order into a failed render", async () => {
  await withBook(async (outDir) => {
    const id = "o_" + "d".repeat(12);
    await book.landOrderRow({ outDir, row: { id, jobType: "video", from: { fp: FP },
      state: "landed", landedAt: AT - 1000 } });
    await book.transitionOrderState({ outDir, id, from: "landed", to: "rendering",
      patch: { renderStatus: "requested" } });
    assert.equal(await recordVideoFailure({ book, outDir, file: `clip:collab_${id}`,
      kind: "video", durationMs: null, now: AT }), null);
    assert.equal((await book.findOrder({ outDir, id, side: "in" })).state, "rendering");
    const started = await recordVideoFailure({ book, outDir, file: `clip:collab_${id}`,
      kind: "video", durationMs: 2000, now: AT });
    assert.deepEqual([started.state, started.renderRunMs], ["failed", 2000]);
  });
});
