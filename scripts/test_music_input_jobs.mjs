import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Run the actual class, preserving its private methods. Only network/filesystem
// collaborators are stubs; no live engine, service or model is loaded.
const src = readFileSync(new URL("../server/jobs.js", import.meta.url), "utf8");
const classSource = src.slice(src.indexOf("export class JobRunner")).replace("export class", "class");
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const submissions = [], cancellations = [];
const door = { on() {}, submit: async (spec) => {
  const pending = deferred(); submissions.push({ spec, pending }); return pending.promise;
}, cancelRun: async (spec) => { cancellations.push(spec); return { ok: true }; } };
const config = { api: { enabled: false }, speed: { realtimeRatio: 1 }, sampling: {} };
const JobRunner = new Function("EventEmitter", "config", "engine", "randomUUID", "buildGraph",
  "STAGE_OF_NODE", "STAGE_LABEL", "STAGE_WEIGHT", "ORDER", "STALL_MS", "path", "readdir", "stat", "generateViaApi",
  `${classSource}; return JobRunner;`)(EventEmitter, config, door, randomUUID, (spec) => spec,
  {}, {}, {}, [], 600000, path, async () => [], async () => ({}), async () => { throw Error("Unexpected API call"); });
const runner = () => { const r = new JobRunner({ ready: true, on() {} }); r.ws = { readyState: 1 }; return r; };

{
  const r = runner(); r.current = { id: "unrelated", state: "running" };
  const a = r.enqueue({ caption: "A" }), b = r.enqueue({ caption: "B" });
  await r.cancelById(a.id); await tick();
  assert.equal(r.current.id, "unrelated"); assert.deepEqual(r.queue.map((j) => j.id), [b.id]);
  assert.equal(cancellations.length, 0); assert.equal(r.history[0].state, "cancelled");
  assert.equal((await r.cancelById("unknown")).found, false);
}
{
  const r = runner(); const a = r.enqueue({ caption: "Submit in flight" }); await tick();
  assert.equal(submissions.length, 1);
  await r.cancelById(a.id);
  const b = r.enqueue({ caption: "Next song" }); await tick();
  assert.equal(submissions.length, 1); assert.equal(r.current.id, a.id);
  assert.equal(r.current.state, "cancelling", "Do not start another song before in-flight cancellation is confirmed");
  submissions[0].pending.resolve({ promptId: "old-prompt", runId: "old-run" }); await tick();
  assert.deepEqual(cancellations, [{ promptId: "old-prompt", runId: "old-run" }]);
  assert.equal(r.current.id, b.id, "A late old submit cannot clear the next current song");
  assert.equal(submissions.length, 2);
  submissions[1].pending.resolve({ promptId: "new-prompt", runId: "new-run" }); await tick();
  assert.equal(r.current.id, b.id); assert.equal(r.current.promptId, "new-prompt");
  await r.cancelById(b.id); await tick();
  assert.equal(cancellations.at(-1).promptId, "new-prompt");
}
{
  const r = runner(); r.current = { id: "saving", state: "done", file: null };
  const n = cancellations.length;
  assert.equal((await r.cancelById("saving")).state, "done");
  assert.equal(r.current.id, "saving"); assert.equal(cancellations.length, n);
}
{
  const r = runner(); r.current = { id: "old", state: "running", promptId: "old2", runId: "r2" };
  const pending = deferred(), originalCancel = door.cancelRun;
  door.cancelRun = () => pending.promise;
  const stopping = r.cancelById("old");
  r.current = { id: "new", state: "running", promptId: "new2" };
  pending.resolve({ ok: true }); await stopping;
  assert.equal(r.current.id, "new", "A slow cancellation cannot clear a newer current job");
  door.cancelRun = originalCancel;
}
{
  const r = runner(); r.current = { id: "refused", state: "running", promptId: "still-running", runId: "r3" };
  const originalCancel = door.cancelRun;
  door.cancelRun = async () => ({ ok: false, stopped: false, error: "Engine unavailable" });
  await assert.rejects(r.cancelById("refused"), /Engine unavailable/);
  assert.equal(r.current.id, "refused"); assert.equal(r.current.state, "running");
  assert.equal(r.current.cancelRequested, false); assert.equal(r.history.length, 0);
  assert.match(r.current.error, /not confirmed/);
  door.cancelRun = originalCancel;
}
{
  const r = runner(), previous = submissions.length;
  const a = r.enqueue({ caption: "In-flight refusal" }); await tick();
  await r.cancelById(a.id);
  const originalCancel = door.cancelRun;
  door.cancelRun = async () => ({ ok: false, error: "Refused" });
  submissions[previous].pending.resolve({ promptId: "uncancelled", runId: "r4" }); await tick();
  assert.equal(r.current.id, a.id); assert.equal(r.current.state, "running");
  assert.equal(r.current.cancelRequested, false); assert.match(r.current.error, /not confirmed/);
  door.cancelRun = originalCancel;
  await r.cancelById(a.id);
}
{
  const r = runner(); r.current = { id: "blocker", state: "running" };
  const a = r.enqueue({ caption: "External input", requiresLocal: true });
  const n = submissions.length;
  config.api.enabled = true;
  await r.cancelById("blocker"); await tick();
  assert.equal(r.history.find((j) => j.id === a.id).state, "failed");
  assert.match(r.history.find((j) => j.id === a.id).error, /no API request/);
  assert.equal(submissions.length, n);
  config.api.enabled = false;
}
console.log("ID-aware music cancellation passed: queued isolation, submit/cancel race, late cancellation, and finished-output preservation.");
