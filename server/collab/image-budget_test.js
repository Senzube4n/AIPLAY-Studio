import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as book from "./orderbook.js";
import { budgetCheck, estimateImageJob, lentToday, startOfDay, usedSentence } from "./lending.js";

const fp = "a".repeat(32);
const peer = { fp, nickname: "Friend", lendMinutesPerDay: 5 };
const now = startOfDay(Date.now()) + 12 * 3600_000;
const imageOrder = (id, refs = 0) => ({ id, job: { engine: "qwen-image-2.1", steps: 25,
  count: 1, width: 1024, height: 1024, cfg: 1,
  references: Array.from({ length: refs }, (_, i) => ({ sha256: String(i) })) } });
const row = (id, refs = 0) => ({ id, jobType: "image", imageJob: imageOrder(id, refs),
  from: { fp }, state: "landed", landedAt: now - 1000 });
const check = (order, rows = [], person = peer) => budgetCheck({ peer: person, imageOrder: order,
  rows, readProject: async () => null, now });

test("image allowance uses the renderer estimate and reserves accepted jobs", async () => {
  const first = imageOrder("o_111111111111");
  const est = estimateImageJob(first);
  assert.ok(est.minutes > 2 && est.minutes < 4);
  const zero = await check(first, [], { ...peer, lendMinutesPerDay: 0 });
  assert.equal(zero.reason, "budget-zero");
  assert.equal(zero.thisOne, Math.ceil(est.minutes * 10) / 10,
    "a fractional image estimate reserves upward to the next tenth of a minute");
  const second = await check(imageOrder("o_222222222222"), [row(first.id)]);
  assert.equal(second.used.pendingImages, 1);
  assert.equal(second.used.pending, 1);
  assert.match(usedSentence(second.used), /image job accepted today/);
  assert.equal(second.over, true);
  assert.equal(second.reason, "budget-spent");
  const own = await check(first, [row(first.id)]);
  assert.equal(own.used.pending, 0, "render-time recheck replaces its own reservation with this job's estimate");
  assert.equal(own.over, false);
});

test("the card counts each measured attempt, including an earlier failed retry", async () => {
  const old = row("o_333333333333");
  old.state = "failed";
  old.imageRuns = [
    { imageId: "i1", at: now - 1000, durationMs: 120000, status: "failed" },
    { imageId: "i2", at: now - 500, durationMs: 90000, status: "stopped" },
    { imageId: "iold", at: startOfDay(now) - 1000, durationMs: 600000, status: "complete" },
  ];
  const used = await lentToday({ rows: [old], fp, readProject: async () => null, now });
  assert.equal(used.measuredMinutes, 3.5);
  assert.equal(used.pending, 0);
  const next = await check(imageOrder("o_444444444444"), [old]);
  assert.equal(next.reason, "budget-spent");
});

test("a completed image from before run timing keeps its reservation rather than becoming free", async () => {
  const old = row("o_555555555555");
  old.state = "queued"; old.renderStatus = "complete"; old.renderCompletedAt = now - 1000;
  old.renderEstimatedMinutes = 3.2;
  const used = await lentToday({ rows: [old], fp, readProject: async () => null, now });
  assert.equal(used.pending, 0);
  assert.equal(used.untimed, 1);
  assert.equal(used.untimedMinutes, 3.2);
  const next = await check(imageOrder("o_666666666666"), [old]);
  assert.equal(next.reason, "budget-spent");
  assert.equal(next.unknown, true);
});

test("two concurrent image accepts serialize allowance reservation in the orderbook", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "aiplay-image-budget-"));
  try {
    const orders = [imageOrder("o_aaaaaaaaaaaa"), imageOrder("o_bbbbbbbbbbbb")];
    const outcomes = await Promise.all(orders.map((order) => book.landOrderRowChecked({ outDir,
      row: row(order.id), check: async (rows) => {
        const minutes = await check(order, rows);
        return minutes.over ? { refusal: { reason: minutes.reason } }
          : { patch: { renderEstimatedMinutes: minutes.thisOne } };
      } })));
    assert.equal(outcomes.filter((result) => result.row).length, 1);
    assert.equal(outcomes.filter((result) => result.decision.refusal).length, 1);
    assert.equal((await book.listOrders({ outDir, side: "in" })).length, 1);
  } finally { await rm(outDir, { recursive: true, force: true }); }
});
