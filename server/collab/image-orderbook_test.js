import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findOrder, landOrderRow, rememberOrder, fillOrderRow, transitionOrderState, reconcileImageReturn } from "./orderbook.js";

test("two simultaneous landed-to-rendering claims spend one accepted image job only once", async () => {
  const temporaryRoot = path.resolve(tmpdir());
  const outDir = await mkdtemp(path.join(temporaryRoot, "aiplay-image-order-cas-"));
  assert.equal(path.dirname(path.resolve(outDir)), temporaryRoot);
  const id = "o_0123456789ab";
  try {
    await landOrderRow({ outDir, row: { id, at: 1, jobType: "image", state: "landed",
      imageJob: { job: { prompt: "A dancer" } } } });
    const attempts = await Promise.allSettled([
      transitionOrderState({ outDir, id, side: "in", from: "landed", to: "rendering",
        patch: { renderAttempt: "first" } }),
      transitionOrderState({ outDir, id, side: "in", from: "landed", to: "rendering",
        patch: { renderAttempt: "second" } }),
    ]);
    const accepted = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    assert.equal(accepted.length, 1, "exactly one click may claim the GPU work");
    assert.equal(rejected.length, 1, "the competing click must fail closed");
    assert.equal(rejected[0].reason.reason, "order-state-changed");
    assert.equal(rejected[0].reason.status, 409);
    assert.equal(accepted[0].value.state, "rendering");
    const saved = await findOrder({ outDir, side: "in", id });
    assert.equal(saved.state, "rendering");
    assert.equal(saved.renderAttempt, accepted[0].value.renderAttempt,
      "the losing patch must never overwrite the winner's record");
    await assert.rejects(
      transitionOrderState({ outDir, id, side: "in", from: "landed", to: "rendering" }),
      (error) => error.reason === "order-state-changed" && error.status === 409,
      "a subsequent retry also cannot queue a duplicate render",
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("two simultaneous send-back claims prepare one sealed image return", async () => {
  const temporaryRoot = path.resolve(tmpdir());
  const outDir = await mkdtemp(path.join(temporaryRoot, "aiplay-image-return-cas-"));
  assert.equal(path.dirname(path.resolve(outDir)), temporaryRoot);
  const id = "o_abcdef012345";
  try {
    await landOrderRow({ outDir, row: { id, at: 1, jobType: "image", state: "queued",
      imageId: "i123", imageJob: { job: { prompt: "A dancer" } } } });
    await fillOrderRow({ outDir, id, patch: { state: "queued" } });
    const claims = await Promise.allSettled([1, 2].map((attempt) =>
      transitionOrderState({ outDir, id, side: "in", from: "queued", to: "returning",
        patch: { returnAttempt: attempt } })));
    assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
    assert.equal(claims.find((claim) => claim.status === "rejected").reason.reason, "order-state-changed");
    assert.equal((await findOrder({ outDir, id, side: "in" })).state, "returning");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("replaying a quarantined image repairs the order in one write without duplicate returns", async () => {
  const temporaryRoot = path.resolve(tmpdir());
  const outDir = await mkdtemp(path.join(temporaryRoot, "aiplay-image-receive-repair-"));
  const id = "o_abcdef012345";
  const file = "peer_" + "a".repeat(32) + "_" + id + "_" + "b".repeat(64) + ".png";
  try {
    await rememberOrder({ outDir, row: { id, at: 1, jobType: "image", to: { fp: "a".repeat(32) } } });
    const entry = { ok: true, reason: null, file, kind: "image" };
    let row = await reconcileImageReturn({ outDir, id, entry, state: "returned" });
    assert.equal(row.state, "returned");
    assert.equal(row.returns.length, 1);
    row = await reconcileImageReturn({ outDir, id, entry, state: "returned" });
    assert.equal(row.returns.length, 1);
    row = await reconcileImageReturn({ outDir, id, entry, state: "adopted" });
    assert.equal(row.state, "adopted");
    row = await reconcileImageReturn({ outDir, id, entry, state: "returned" });
    assert.equal(row.state, "adopted", "a later file replay must not undo adoption");
    assert.equal(row.returns.length, 1);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
