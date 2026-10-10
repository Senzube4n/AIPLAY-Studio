import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as book from "./orderbook.js";
import * as lending from "./lending.js";
import { makeOrder } from "./order.js";

const fp = "ab".repeat(16);
const now = lending.startOfDay(Date.now()) + 12 * 3600_000;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const readProject = async () => { throw new Error("A claimed scene has no project yet"); };

function sceneOrder(id) {
  return makeOrder({
    shot: { v: 1, kind: "shot", segmentId: "s1_0", prompt: "a dancer", width: 1344, height: 768,
      seconds: 5, refs: [{ name: "Ref", sha256, bytes: png.length, file: "ref.png" }], guides: [], baseScale: null, songUnder: null },
    files: [{ file: "ref.png", b64: png.toString("base64") }],
    order: { segmentId: "s1_0", seed: 7, steps: 8, engineMode: "hybrid" },
    returnTo: { fp, nickname: "Friend" }, now, id,
  });
}

function jobs(peer) {
  const scene = sceneOrder("o_111111111111");
  const video = { id: "o_222222222222", job: { engine: "h3", width: 1280, height: 704, seconds: 5, steps: 20 } };
  const image = { id: "o_333333333333", job: { engine: "qwen-image-2.1", steps: 25,
    count: 1, width: 1024, height: 1024, cfg: 1, references: [] } };
  const from = { fp };
  return {
    scene: { id: scene.id, estimate: lending.estimateErrand(lending.resolveErrand(scene).doc).minutes,
      row: { id: scene.id, from, state: "claimed", slug: null, landedAt: now - 1000 },
      check: (rows) => lending.budgetCheck({ peer, orderDoc: scene, rows, readProject, now }) },
    video: { id: video.id, estimate: lending.estimateVideoJobMinutes(video),
      row: { id: video.id, from, jobType: "video", state: "landed", landedAt: now - 1000 },
      check: (rows) => lending.budgetCheckVideoJob({ peer, orderDoc: video, rows, readProject, now }) },
    image: { id: image.id, estimate: Math.ceil(lending.estimateImageJob(image).minutes * 10) / 10,
      row: { id: image.id, from, jobType: "image", imageJob: image, state: "claimed", landedAt: now - 1000 },
      check: (rows) => lending.budgetCheck({ peer, imageOrder: image, rows, readProject, now }) },
  };
}

test("scene, H3 and image claims reserve one shared allowance under concurrent accepts", async (t) => {
  for (const first of ["scene", "video", "image"]) {
    for (const second of ["scene", "video", "image"].filter((kind) => kind !== first)) {
      await t.test(first + " then " + second, async () => {
        const peer = { fp, nickname: "Friend", lendMinutesPerDay: 999 };
        const work = jobs(peer);
        peer.lendMinutesPerDay = Math.max(work[first].estimate, work[second].estimate)
          + Math.min(work[first].estimate, work[second].estimate) / 2;
        const outDir = await mkdtemp(path.join(os.tmpdir(), "aiplay-cross-kind-"));
        try {
          const accepted = await Promise.all([work[first], work[second]].map((job) => book.landOrderRowChecked({
            outDir, row: job.row, check: async (rows) => {
              const minutes = await job.check(rows);
              return minutes.over ? { refusal: { reason: minutes.reason } }
                : { patch: { renderEstimatedMinutes: minutes.thisOne } };
            },
          })));
          assert.deepEqual(accepted.map((result) => !!result.row), [true, false]);
          assert.equal(accepted[1].decision.refusal.reason, "budget-spent");
          const rows = await book.listOrders({ outDir, side: "in" });
          assert.equal(rows.length, 1);
          assert.equal(rows[0].id, work[first].id);
          assert.ok(rows[0].renderEstimatedMinutes > 0);
        } finally {
          assert.equal(path.dirname(path.resolve(outDir)), path.resolve(os.tmpdir()));
          assert.ok(path.basename(outDir).startsWith("aiplay-cross-kind-"));
          await rm(outDir, { recursive: true, force: true });
        }
      });
    }
  }
});

test("scene and image accept routes write reservations at the initial claim", async () => {
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const image = source.slice(source.indexOf('if (action === "image_accept")'), source.indexOf('if (action === "image_render")'));
  assert.match(image, /state: "claimed", consentAt: Date\.now\(\), landedAt: Date\.now\(\)/);
  const scene = source.slice(source.indexOf('if (action === "accept")'), source.indexOf('if (action === "send_back")'));
  assert.match(scene, /landOrderRowChecked\(\{/);
  assert.match(scene, /state: "claimed"[\s\S]*renderEstimatedMinutes: minutes\.thisOne/);
  assert.doesNotMatch(scene, /await book\.landOrderRow\(\{/);
});

test("a claimed but unpriced scene needs an explicit override for every job type", async () => {
  const peer = { fp, nickname: "Friend", lendMinutesPerDay: 120 };
  const work = jobs(peer);
  const unpriced = { ...work.scene.row, renderEstimatedMinutes: null };
  for (const job of Object.values(work)) {
    const result = await job.check([unpriced]);
    if (job.id === unpriced.id) {
      assert.equal(result.used.pending, 0, "the current order excludes its own reservation");
    } else {
      assert.equal(result.reason, "budget-unpriced");
      assert.equal(result.over, true);
      assert.equal(result.used.unpriced, 1);
    }
  }
});
