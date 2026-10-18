// A temporary voice recording belongs to one Whisper job, even after timeout.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVoiceTranscriber } from "./voice.js";

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-voice-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 0;
  const art = new EventEmitter();
  Object.assign(art, { current: options.running ? null : { id: "unrelated", file: "picture.png", kind: "cover" },
    queue: [], done: [], drops: [], stops: [], own: null });
  art.request = (spec) => {
    if (options.refuse) { art.lastRefusal = "queue unavailable"; return null; }
    const job = { ...spec, id: "voice-job" };
    art.own = job;
    if (options.running) { art.current = job; job.startedAt = clock; }
    else art.queue.push(job);
    if (options.requestThrows) throw new Error(`listener failed for ${job.whisper.input}`);
    return job;
  };
  art.drop = (file) => {
    art.drops.push(file);
    art.queue = art.queue.filter((job) => job.file !== file);
    art.emit("update");
    if (options.dropThrows) throw new Error("drop update listener failed");
    return { removed: 1, running: art.current?.file === file };
  };
  art.finish = (job, { error = null, text = "spoken request" } = {}) => {
    art.queue = art.queue.filter((queued) => queued !== job);
    if (art.current === job) art.current = null;
    job.finishedAt = clock;
    if (error) job.error = error;
    else job.transcript = { text };
    art.done.unshift(job);
    art.emit("update");
  };
  art.stopCurrent = async () => {
    const job = art.current;
    art.stops.push(job);
    assert.equal(job, art.own, "only this recording's job may be stopped");
    if (options.stop === "throw") throw new Error("worker stop failed");
    if (options.stop === "pending") return { stopped: job.title, killed: false, stopping: true };
    art.finish(job, { error: "stopped" });
    if (options.successor) art.current = options.successor;
    return { stopped: job.title, killed: true, stopping: false };
  };
  const transcribe = createVoiceTranscriber({ art, dir, timeoutMs: 3, pollMs: 1,
    now: () => clock,
    sleep: async (ms) => { clock += ms; await options.onSleep?.(art, clock); },
  });
  return { art, dir, transcribe, input: () => art.own?.whisper.input };
}

async function removed(file) {
  for (let i = 0; i < 100; i++) {
    try { await access(file); }
    catch (e) {
      if (e.code === "ENOENT") return;
      // Windows can report delete-pending as EPERM until unlink completes.
      if (e.code !== "EPERM") throw e;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("recording was not removed after its job became terminal");
}

test("a completed transcription returns its text and removes only its input", async (t) => {
  const f = await setup(t, { onSleep: async (art) => {
    assert.equal(await readFile(art.own.whisper.input, "utf8"), "recorded audio");
    art.finish(art.own, { text: "  hello from whisper  " });
  } });
  const other = f.art.current;
  assert.equal(await f.transcribe(Buffer.from("recorded audio"), "webm", "human:browser"), "hello from whisper");
  assert.equal(f.art.own.actor, "human:browser");
  assert.equal(f.art.current, other);
  assert.equal(existsSync(f.input()), false);
  assert.deepEqual(f.art.stops, []);
  assert.equal(f.art.listenerCount("update"), 0);
});

test("queue refusal removes the unused recording", async (t) => {
  const f = await setup(t, { refuse: true });
  await assert.rejects(f.transcribe(Buffer.from("audio"), "webm", "human:browser"), /queue unavailable/);
  assert.deepEqual(await readdir(f.dir), []);
  assert.deepEqual(f.art.stops, []);
});

test("a queued timeout drops only its own voice job before removing the input", async (t) => {
  const f = await setup(t);
  const current = f.art.current;
  const queued = { id: "other", file: "another-picture.png", kind: "cover" };
  f.art.queue.push(queued);
  await assert.rejects(f.transcribe(Buffer.from("audio"), "webm", "human:browser"), /longer than 3 ms/);
  assert.deepEqual(f.art.drops, [f.art.own.file]);
  assert.deepEqual(f.art.queue, [queued]);
  assert.equal(f.art.current, current);
  assert.deepEqual(f.art.stops, []);
  assert.equal(existsSync(f.input()), false);
  assert.equal(f.art.listenerCount("update"), 0);
});

test("a running timeout waits for confirmed termination before deleting input", async (t) => {
  const f = await setup(t, { running: true });
  await assert.rejects(f.transcribe(Buffer.from("audio"), "ogg", "human:browser"), /longer than 3 ms/);
  assert.deepEqual(f.art.stops, [f.art.own]);
  assert.equal(existsSync(f.input()), false);
  assert.equal(f.art.listenerCount("update"), 0);
});

for (const stop of ["pending", "throw"]) {
  test(`an unconfirmed running stop (${stop}) retains input until that job is terminal`, async (t) => {
    const f = await setup(t, { running: true, stop });
    await assert.rejects(f.transcribe(Buffer.from("audio"), "webm", "human:browser"), /longer than 3 ms/);
    assert.equal(existsSync(f.input()), true);
    assert.equal(f.art.current, f.art.own);
    assert.deepEqual(f.art.stops, [f.art.own]);
    assert.equal(f.art.listenerCount("update"), 1);
    f.art.emit("update");
    assert.equal(existsSync(f.input()), true, "progress does not confirm termination");
    f.art.finish(f.art.own, { error: "worker finally closed" });
    await removed(f.input());
    assert.equal(f.art.listenerCount("update"), 0);
  });
}

test("a running job disappearing from current does not alone prove its worker is terminal", async (t) => {
  const f = await setup(t, { running: true, stop: "pending" });
  await assert.rejects(f.transcribe(Buffer.from("audio"), "webm", "human:browser"), /longer than 3 ms/);
  const successor = { id: "next", file: "next-picture.png", kind: "cover" };
  f.art.current = successor;
  f.art.emit("update");
  assert.equal(existsSync(f.input()), true);
  assert.deepEqual(f.art.stops, [f.art.own]);
  f.art.finish(f.art.own, { error: "worker closed" });
  await removed(f.input());
  assert.equal(f.art.current, successor);
  assert.equal(f.art.listenerCount("update"), 0);
});

test("a successor starting during stop is left alone", async (t) => {
  const successor = { id: "next", file: "next-picture.png", kind: "cover" };
  const f = await setup(t, { running: true, successor });
  await assert.rejects(f.transcribe(Buffer.from("audio"), "webm", "human:browser"), /longer than 3 ms/);
  assert.equal(f.art.current, successor);
  assert.deepEqual(f.art.stops, [f.art.own]);
  assert.equal(existsSync(f.input()), false);
});

test("finishing at the deadline never cancels the next job", async (t) => {
  const successor = { id: "next", file: "next-picture.png", kind: "cover" };
  const f = await setup(t, { running: true, onSleep: (art, clock) => {
    if (clock === 3) { art.finish(art.own); art.current = successor; }
  } });
  assert.equal(await f.transcribe(Buffer.from("audio"), "webm", "human:browser"), "spoken request");
  assert.equal(f.art.current, successor);
  assert.deepEqual(f.art.stops, []);
  assert.equal(existsSync(f.input()), false);
});

test("an enqueue listener failure still removes its queued job and redacts the input path", async (t) => {
  const f = await setup(t, { requestThrows: true });
  await assert.rejects(f.transcribe(Buffer.from("audio"), "webm", "human:browser"), (error) => {
    assert.match(error.message, /listener failed for the recording/);
    assert.equal(error.message.includes(f.dir), false);
    return true;
  });
  assert.deepEqual(f.art.queue, []);
  assert.deepEqual(f.art.drops, [f.art.own.file]);
  assert.deepEqual(f.art.stops, []);
  assert.equal(existsSync(f.input()), false);
});

test("a drop listener failure after removal does not stop unrelated work", async (t) => {
  const f = await setup(t, { dropThrows: true });
  const current = f.art.current;
  await assert.rejects(f.transcribe(Buffer.from("audio"), "webm", "human:browser"), /longer than 3 ms/);
  assert.deepEqual(f.art.queue, []);
  assert.equal(f.art.current, current);
  assert.deepEqual(f.art.stops, []);
  assert.equal(existsSync(f.input()), false);
});
