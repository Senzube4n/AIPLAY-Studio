import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { requestImageAndWait } from "./image-job.js";

test("cached output arriving before API response is retained with the actual seed/run", async () => {
  const art = new EventEmitter();
  const result = await requestImageAndWait({ art, options: { prompt: "tree", seed: 12 }, actor: "agent:test",
    submit: async (body, actor) => {
      assert.equal(actor, "agent:test"); assert.equal(body.dedupe, false);
      assert.equal(body.action, "create"); assert.equal(body.prompt, "tree");
      art.emit("cover", { file: "image:a", covers: ["a.png"], runId: "run-a", seed: 12 });
      return { ok: true, id: "a", job: { id: "art-a" } };
    } });
  assert.deepEqual(result, { name: "a.png", runId: "run-a", seed: 12 });
  assert.equal(art.listenerCount("cover"), 0); assert.equal(art.listenerCount("failed"), 0);
});

test("other queue failures do not fail this request; own late output completes it", async () => {
  const art = new EventEmitter();
  const done = requestImageAndWait({ art, options: {}, submit: async () => {
    art.emit("failed", { file: "image:other", error: "unrelated failure" });
    return { ok: true, id: "b", job: { id: "art-b" } };
  } });
  await new Promise(resolve => setImmediate(resolve));
  art.emit("cover", { file: "image:b", covers: ["b.png"], seed: 55 });
  assert.equal((await done).name, "b.png");
});

test("matching GPU failure and API refusal clean up listeners", async () => {
  for (const failure of ["gpu", "api"]) {
    const art = new EventEmitter();
    const done = requestImageAndWait({ art, options: {}, submit: async () => {
      if (failure === "api") return { error: "missing weights" };
      art.emit("failed", { file: "image:c", error: "GPU error" });
      return { ok: true, id: "c", job: { id: "art-c" } };
    } });
    await assert.rejects(done, /missing weights|GPU error/);
    assert.equal(art.listenerCount("cover"), 0); assert.equal(art.listenerCount("failed"), 0);
  }
});

test("missing completion has a bounded wait without claiming GPU cancellation", async () => {
  const art = new EventEmitter();
  await assert.rejects(requestImageAndWait({ art, options: {}, timeoutMs: 10,
    submit: async () => ({ ok: true, id: "d", job: { id: "art-d" } }) }), /inspect the job queue/);
  assert.equal(art.listenerCount("cover"), 0); assert.equal(art.listenerCount("failed"), 0);
});
