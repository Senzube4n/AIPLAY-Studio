import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The runner has no engine child in this process. The accepted local job starts
// and fails there, exercising the same catch event an H3 render uses.
const tmp = await mkdtemp(path.join(os.tmpdir(), "aiplay-art-failure-clock-"));
process.env.AIPLAY_OUTPUT = path.join(tmp, "output");
process.env.AIPLAY_APPDATA = path.join(tmp, "appdata");
const { ArtRunner } = await import("./art.js");

test("a started ArtRunner failure carries elapsed work; a queued stop does not", async () => {
  try {
    const runner = new ArtRunner({ ready: true }, { current: null, queue: [] });
    const observed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ArtRunner did not report a terminal outcome")), 8000);
      runner.once("failed", (event) => { clearTimeout(timer); resolve(event); });
    });
    const job = runner.request({ file: "image:failure-clock", title: "failure clock",
      kind: "cover", force: true, asked: true,
      video: { prompt: "a paper boat", engine: "flux2", count: 1 } });
    assert.ok(job, runner.lastRefusal || "The test job should enter the queue");
    const failed = await observed;
    assert.equal(failed.file, job.file);
    assert.equal(typeof failed.durationMs, "number");
    assert.ok(Number.isFinite(failed.durationMs) && failed.durationMs >= 0);

    const queuedRunner = new ArtRunner({ ready: false }, { current: null, queue: [] });
    const queued = queuedRunner.request({ file: "image:queued-stop-clock", title: "queued",
      kind: "cover", force: true, asked: true,
      video: { prompt: "a blue kite", engine: "flux2", count: 1 } });
    assert.ok(queued);
    const stopped = [];
    queuedRunner.on("failed", (event) => stopped.push(event));
    await queuedRunner.stopMine();
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].cancelled, true);
    assert.equal(stopped[0].durationMs, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
