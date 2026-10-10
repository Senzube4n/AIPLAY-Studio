import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createH3RefModService, refModExtractGraph } from "./h3-refmod.js";
import { REFMOD_NODES } from "./h3-refmod-options.js";
import { runRefMod } from "./refmod-run.js";

// Import the actual runner after redirecting all application output. Every engine
// operation is replaced before a job can be scheduled; no engine or GPU is used.
const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-refmod-art-"));
process.env.AIPLAY_OUTPUT = path.join(temp, "output");
process.env.AIPLAY_APPDATA = path.join(temp, "appdata");
const { ArtRunner } = await import("./art.js");
const { engine, createEngineClient } = await import("./engine/client.js");

function outcome(runner, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { runner.off(name, onEvent); reject(new Error(`Missing ${name} outcome`)); }, 8000);
    const onEvent = (event) => { clearTimeout(timer); resolve(event); };
    runner.once(name, onEvent);
  });
}

test("RefMod shares the art queue, releases queued Stop/Drop and holds a timed-out writer through targeted Stop", async () => {
  const original = { run: engine.run, socket: engine.socket, status: engine.status,
    queue: engine.queue, cancelRun: engine.cancelRun, interrupt: engine.interrupt };
  const calls = [], music = { current: { id: "song-running" }, queue: [], loaded: null };
  const comfy = { ready: true }, runner = new ArtRunner(comfy, music);
  let result = { runId: "refmod-cpu-1", status: "completed" };
  engine.run = async (spec) => { calls.push(spec); return result; };
  engine.socket = () => { throw new Error("No progress socket in a CPU mock"); };
  engine.status = async () => ({ running: [] });
  const options = { name: "singer", images: ["singer.png"] }, config = { video: { engines: { h3: { videoVae: "h3_vae.safetensors" } } } };
  const graph = refModExtractGraph(options, { videoVae: config.video.engines.h3.videoVae });
  const fields = Object.fromEntries(Object.keys(graph[2].inputs).filter((key) => !key.startsWith("refs_image.")).map((key) => [key, ["STRING"]]));
  const nodes = { [REFMOD_NODES.extract]: { output_node: true, input: { required: fields, optional: { refs_image: ["AUTOGROW"] } } } };
  const service = createH3RefModService({ config, roots: () => [], objectInfo: async (name) => ({ [name]: nodes[name] }),
    stageImage: async () => "aiplay_refmod_staged.png", submit: async (spec) => {
      const name = spec.graph[2].inputs.name;
      const job = runner.request({ file: `refmod:${name}`, title: spec.label, kind: "refmod", force: true, asked: true,
        actor: spec.actor, video: { refModGraph: spec.graph, refModName: name } });
      assert.ok(job, runner.lastRefusal || "The cache must enter the shared queue");
      return { id: job.id, file: job.file, state: "queued" };
    } });
  runner.on("refmod-ready", ({ name }) => service.complete(name));
  runner.on("failed", ({ file, kind }) => { if (kind === "refmod") service.complete(String(file).slice(7)); });
  try {
    const ready = outcome(runner, "refmod-ready");
    const accepted = await service.create(options, { actor: "user" });
    assert.equal(accepted.run.state, "queued");
    assert.equal(runner.queue[0].kind, "refmod");
    assert.equal(runner.queue[0].refModName, "singer");
    await assert.rejects(service.create(options), /already queued/);
    await new Promise((resolve) => setTimeout(resolve, 1350));
    assert.equal(calls.length, 0, "a running song keeps VAE extraction queued");
    assert.equal(runner.queue.length, 1);
    music.current = null;
    const completed = await ready;
    assert.equal(completed.name, "singer");
    assert.equal(completed.runId, "refmod-cpu-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].via, "art.refmod");
    assert.equal(calls[0].actor, "user");
    assert.equal(calls[0].adopt, false);
    assert.equal(calls[0].timeoutMs, 15 * 60 * 1000);
    assert.equal(calls[0].graph[2].inputs.name, "singer");
    assert.equal(calls[0].graph[10].inputs.image, "aiplay_refmod_staged.png");
    assert.equal(Object.values(calls[0].graph).some((node) => /UNET|Sampler|CLIP/.test(node.class_type)), false);
    assert.equal(runner.done[0].refModResult.status, "completed");
    assert.equal(music.artResident, true, "the music runner knows the VAE used the card");

    result = { runId: "refmod-cpu-2", status: "failed", error: "mock VAE failure" };
    const failed = outcome(runner, "failed");
    await service.create(options);
    const failure = await failed;
    assert.equal(failure.kind, "refmod");
    assert.equal(failure.file, "refmod:singer");
    assert.equal(failure.runId, "refmod-cpu-2");
    assert.equal(failure.error, "mock VAE failure");
    assert.ok(Number.isFinite(failure.durationMs));

    runner.paused = true;
    await service.create(options);
    const stopped = outcome(runner, "failed");
    assert.equal((await runner.stopMine()).dropped, 1);
    assert.equal((await stopped).cancelled, true);
    // No cache file was actually written by this mock, so its released name can
    // be queued again. Real successful creation instead refuses the saved file.
    comfy.ready = false;
    await service.create(options);
    assert.equal(runner.queue.length, 1, "a failed or stopped reservation can be retried immediately");
    assert.equal(calls.length, 2, "queueing while the engine is down performs no direct run");
    const dropped = outcome(runner, "failed");
    assert.deepEqual(runner.drop("refmod:singer"), { removed: 1, running: false });
    const dropEvent = await dropped;
    assert.equal(dropEvent.file, "refmod:singer");
    assert.equal(dropEvent.kind, "refmod");
    assert.equal(dropEvent.cancelled, true);
    assert.equal(dropEvent.runId, null);
    assert.equal(dropEvent.durationMs, undefined, "a queued Drop records no GPU time");
    await service.create(options);
    assert.equal(runner.queue.length, 1, "Drop releases the filename for an immediate retry");
    assert.equal(calls.length, 2, "the dropped attempt was never sent to the engine");
    const failedEvents = [];
    runner.on("failed", (event) => failedEvents.push(event));
    const cover = runner.request({ file: "image:drop-unrelated", kind: "cover", asked: true,
      video: { prompt: "a paper boat", engine: "flux2" } });
    assert.ok(cover);
    assert.deepEqual(runner.drop(cover.file), { removed: 1, running: false });
    assert.equal(failedEvents.length, 0, "Drop keeps the established behavior of non-RefMod jobs");
    await runner.stopMine();

    // The door has timed out and no longer lists this run. Its atomic cancel
    // acknowledges Stop while the engine is still finishing the writer.
    const cancels = [];
    let beginConfirmation, releaseQueue;
    const confirming = new Promise((resolve) => { beginConfirmation = resolve; });
    const queueGone = new Promise((resolve) => { releaseQueue = resolve; });
    result = { ok: false, runId: "refmod-cpu-timeout", promptId: "exact-cache-writer", status: "timeout", error: "mock deadline" };
    engine.cancelRun = async (target) => { cancels.push(target); beginConfirmation(); return { stopped: true, atomic: true }; };
    engine.queue = async () => { await queueGone; return { queue_running: [[0, "somebody-elses-prompt"]], queue_pending: [] }; };
    engine.status = async () => ({ running: [{ runId: "chat-owned", via: "chat.image" }] });
    engine.interrupt = async () => { throw new Error("RefMod Stop must not interrupt an unrelated prompt"); };
    comfy.ready = true; runner.paused = false;
    const timedOut = outcome(runner, "failed");
    await service.create(options);
    await confirming;
    assert.equal(runner.current.file, "refmod:singer");
    assert.equal(runner.current.refModPromptId, "exact-cache-writer");
    await assert.rejects(service.create(options), /already queued/, "a timeout cannot release the filename while the writer remains");
    assert.deepEqual(runner.drop("refmod:singer"), { removed: 0, running: true });
    assert.equal((await runner.stopCurrent()).stopping, true);
    const stop = await runner.stopMine();
    assert.equal(stop.engineCancelled, 1);
    assert.equal(stop.stopping, true);
    assert.equal(runner.current.kind, "refmod", "a Stop acknowledgement also retains the shared queue slot");
    assert.ok(cancels.length >= 3);
    assert.ok(cancels.every((target) => target.runId === "refmod-cpu-timeout" && target.promptId === "exact-cache-writer"));
    await assert.rejects(service.create(options), /already queued/);
    releaseQueue();
    const terminal = await timedOut;
    assert.equal(terminal.cancelled, true);
    assert.equal(terminal.runId, "refmod-cpu-timeout");
    assert.equal(runner.current, null);
    runner.paused = true;
    await service.create(options);
    assert.equal(runner.queue.length, 1, "proof that the original prompt is gone permits an immediate retry");
    await runner.stopMine();
  } finally {
    runner.paused = true;
    await runner.stopMine();
    Object.assign(engine, original);
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("aiplay-refmod-art-"));
    await rm(temp, { recursive: true, force: true });
  }
});

test("a real engine timeout retains its prompt identity and RefMod waits for queue proof after cancellation", async (t) => {
  const events = [], calls = [];
  let acknowledgement = false, release, observed;
  const proof = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const held = new Promise((resolve) => { observed = resolve; });
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const door = createEngineClient({ port: 12345, poll: { POLL_MS: 2, POLL_TIMEOUT_MS: 100, POST_TIMEOUT_MS: 100 },
    provenance: { append: async (_scope, event) => { events.push(event); return { hash: "cpu-only-ledger" }; } },
    store: { readSettings: async () => ({}), resolveRecordFiles: async () => {}, graphStoreBytes: async () => ({ files: 0, bytes: 0 }) },
    fetch: async (url) => {
      const pathname = new URL(url).pathname; calls.push(pathname);
      if (pathname === "/prompt") return reply({ prompt_id: "real-door-cache-prompt" });
      if (pathname.startsWith("/history/")) return reply({});
      if (pathname === "/queue") return reply({ queue_running: [[0, "real-door-cache-prompt"]], queue_pending: [] });
      if (pathname.endsWith("/cancel")) { acknowledgement = true; return reply({ cancelled: true }); }
      return reply({ armed: true });
    } });
  door.attachChild({ exitCode: null, signalCode: null });
  const description = "private_refmod_description_probe_20260930";
  const graph = refModExtractGraph({ name: "timeout_cpu", images: ["singer.png"], description }, { videoVae: "h3_vae.safetensors" });
  let done;
  const checkingDoor = { run: async (spec) => { done = await door.run(spec); return done; }, cancelRun: door.cancelRun,
    queue: async () => { observed(); await proof; return { queue_running: [], queue_pending: [[0, "unrelated-pending"]] }; } };
  let resolved = false;
  const running = runRefMod(checkingDoor, { graph, label: description, private: true, adopt: false, via: "art.refmod", timeoutMs: 1, pollMs: 100 })
    .then((result) => { resolved = true; return result; });
  await held;
  assert.equal(done.status, "timeout");
  assert.equal(done.ok, false);
  assert.equal(done.promptId, "real-door-cache-prompt");
  assert.match(done.error, /after this job STARTED/);
  assert.equal(events.at(-1).data.status, "timeout", "the real door wrote its timeout ledger result");
  assert.equal(events[0].data.label, null, "the private label is redacted in the actual delegate record");
  assert.equal(events[0].data.graphStored, null, "the private graph containing the description is never filed");
  assert.equal(JSON.stringify(events).includes(description), false, "no private engine ledger record contains the cache description");
  assert.equal((await door.status()).running.length, 0, "the door has already removed this timed-out run");
  assert.equal(acknowledgement, true, "cancel uses the surviving prompt id despite the absent live run");
  assert.ok(calls.includes("/api/jobs/real-door-cache-prompt/cancel"));
  assert.equal(resolved, false, "atomic Stop does not release the writer before queue proof");
  release();
  assert.equal(await running, done);
});

test("every noncompleted RefMod result holds through unknown, malformed and pending queue reads", async () => {
  for (const status of ["timeout", "failed", "error", "cancelled"]) {
    const done = { runId: `cpu-${status}`, promptId: "cache-prompt", status, error: "polling deadline" };
    const queues = [new Error("engine unavailable"), {}, { queue_running: [], queue_pending: null },
      { queue_running: [[0]], queue_pending: [] }, { queue_running: [[0, "cache-prompt"]], queue_pending: [] },
      { queue_running: [], queue_pending: [[0, "cache-prompt"]] }, { queue_running: [], queue_pending: [[0, "other-prompt"]] }];
    let pauses = 0, cancels = 0;
    const result = await runRefMod({ run: async () => done,
      cancelRun: async (target) => { assert.deepEqual(target, { runId: done.runId, promptId: done.promptId }); cancels++; throw new Error("cancel unavailable"); },
      queue: async () => { const queue = queues.shift(); if (queue instanceof Error) throw queue; return queue; } }, { pollMs: 1 },
      { sleep: async () => { pauses++; } });
    assert.equal(result, done);
    assert.equal(cancels, 1);
    assert.equal(pauses, 6, `${status}: only a complete read proving this exact prompt absent releases the job`);
  }
  const rejected = { status: "rejected", error: "preflight failure" };
  assert.equal(await runRefMod({ run: async () => rejected }, {}), rejected, "no prompt means there is no engine writer to lease");
  let reads = 0;
  const completed = { status: "completed", promptId: "finishing-writer", runId: "cpu-success" };
  assert.equal(await runRefMod({ run: async () => completed,
    cancelRun: async () => { assert.fail("completed work must not be cancelled"); },
    queue: async () => ({ queue_running: reads++ === 0 ? [[0, completed.promptId]] : [], queue_pending: [] }) },
  { pollMs: 1 }, { sleep: async () => {} }), completed);
  assert.equal(reads, 2, "even a completed history result waits for its final queue removal");
  for (const privacy of [true, false]) {
    const spec = { graph: {}, private: privacy, via: "art.refmod" };
    let forwarded;
    await runRefMod({ run: async (value) => { forwarded = value; return rejected; } }, spec);
    assert.equal(forwarded, spec, "the helper forwards the original dispatch spec wholesale");
    assert.equal(forwarded.private, privacy, "the caller's explicit privacy choice survives the helper");
  }
});

test("the API forwards normalized optional settings and owns both pending-completion handlers", async () => {
  const source = (await readFile(new URL("./index.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const art = (await readFile(new URL("./art.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(source, /stageImage: \(name\) => stageRefModImage\(name,/);
  assert.match(source, /kind: "refmod", force: true, asked: true,/);
  assert.match(source, /video: \{ refModGraph: spec\.graph, refModName: name \}/);
  assert.match(source, /art\.on\("refmod-ready", \(\{ name \}\) => h3RefModService\.complete\(name\)\)/);
  assert.match(source, /art\.on\("failed", \(\{ file, kind \}\) => \{ if \(kind === "refmod"\) h3RefModService\.complete\(String\(file\)\.slice\(7\)\)/);
  assert.match(source, /h3RefModService\.checkRender\(b, \{ engine: gate\.engine \}\)/, "preview validates the installed node and local cache");
  assert.match(source, /h3RefModService\.checkRender\(b, \{ engine: eng \}\)/, "create validates the installed node and local cache");
  for (const key of ["refMods", "refModOptions", "h3Tweaks"]) {
    assert.match(source, new RegExp(`${key}: optionalH3\\.${key}`), `${key} reaches the art queue`);
    assert.match(art, new RegExp(`${key}: job\\.${key}`), `${key} reaches the native graph`);
  }
});
