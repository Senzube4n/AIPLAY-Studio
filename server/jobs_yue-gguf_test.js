/** Queue-only native GGUF regressions. All engine/driver/ledger collaborators
 * are fakes; only disposable WAV placeholders and queue copies touch disk.
 * Extract the real class to avoid importing config, GPU probes or services. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, realpathSync, rmSync } from "node:fs";
import { mkdir, copyFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const scratch = mkdtempSync(path.join(tmpdir(), "aiplay-jobs-gguf-test-"));
try {
const source = readFileSync(new URL("./jobs.js", import.meta.url), "utf8");
const classSource = source.slice(source.indexOf("export class JobRunner")).replace("export class", "class");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const waitFor = async (predicate, message = "queue condition") => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out awaiting ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
const cancelled = () => Object.assign(new Error("Fake owned child was cancelled"), {
  name: "AbortError", refusal: "cancelled", terminationConfirmed: true,
});

function harness({ ready = true, api = false, copy = copyFile } = {}) {
  const config = { outputDir: scratch, api: { enabled: api }, speed: { realtimeRatio: 1.53 }, sampling: {} };
  const door = new EventEmitter(), forbidden = [];
  for (const name of ["submit", "cancelRun", "interrupt", "clearQueue", "history", "queue"]) {
    door[name] = async () => { forbidden.push(name); throw Error(`Unexpected ${name}`); };
  }
  let socket = null;
  door.socket = () => {
    socket = new EventEmitter(); socket.readyState = 1; socket.close = () => socket.emit("close");
    queueMicrotask(() => socket.emit("open")); return socket;
  };
  const JobRunner = new Function("EventEmitter", "config", "engine", "randomUUID", "path", "mkdir", "copyFile",
    "readdir", "stat", "buildGraph", "generateViaApi", "STAGE_OF_NODE", "STAGE_LABEL", "STAGE_WEIGHT", "ORDER", "STALL_MS", "VRAM_MIN_GIB",
    `${classSource}; return JobRunner;`)(EventEmitter, config, door, randomUUID, path, mkdir, copy, readdir, stat,
    () => { forbidden.push("graph"); throw Error("Unexpected graph"); },
    async () => { forbidden.push("api"); throw Error("Unexpected API"); }, {}, { saving: "Saving", loading: "Loading" }, {}, [], 600000, 11.5);
  const comfy = Object.assign(new EventEmitter(), { ready });
  return { JobRunner, config, comfy, forbidden, socket: () => socket,
    runner: (native = {}, python = {}) => new JobRunner(comfy, { yueGguf: native, yue: python }) };
}

function fakeNative({ queue = null, freeResult = { freed: true }, budget = null,
  freeMb = 8192, ledgerGate = null, spawnGate = null, childGate = null,
  refusal = null, result = null, uncertainTermination = false } = {}) {
  const events = [], calls = { requests: [], spawns: [], options: [], kills: 0, queue: 0, free: 0, memory: 0 };
  let activeChild = null;
  const native = {
    calls, events, minFreeVramMb: budget,
    engine: {
      queue: async () => {
        calls.queue++; events.push("queue");
        return queue ? queue(calls.queue) : { queue_running: [], queue_pending: [] };
      },
      freeMemory: async (options) => {
        assert.deepEqual(options, { unloadModels: true }); calls.free++; events.push("free"); return freeResult;
      },
    },
    freeVram: async () => { calls.memory++; events.push("memory"); return typeof freeMb === "function" ? freeMb(calls.memory) : freeMb; },
    spawn: (command, args, options) => {
      activeChild = new EventEmitter(); activeChild.pid = 4100 + calls.spawns.length;
      calls.spawns.push({ command, args, options, child: activeChild }); events.push("spawn"); return activeChild;
    },
    runDriver: async (args, options) => {
      calls.options.push(options);
      if (spawnGate) await spawnGate.promise;
      const child = options.spawnFn("fake-audio-cli.exe", args, { shell: false, windowsHide: true });
      const stop = () => { calls.kills++; events.push("kill-owned-child"); };
      options.signal.addEventListener("abort", stop, { once: true });
      try {
        if (childGate) await childGate.promise;
        if (options.signal.aborted && uncertainTermination) throw Object.assign(cancelled(), { terminationConfirmed: false });
        child.emit("close", options.signal.aborted ? 1 : 0);
        if (options.signal.aborted) throw cancelled();
        return { stdout: "", stderr: "" };
      } finally { options.signal.removeEventListener("abort", stop); }
    },
    renderSong: async (request, deps) => {
      calls.requests.push(request); events.push("render-door");
      if (ledgerGate) await ledgerGate.promise;
      if (refusal) throw refusal;
      events.push("ledger-ack"); // A fake durable acknowledgement, no actual ledger call.
      request.onProgress({ stage: "load", percent: null, etaSeconds: null });
      await deps.runner(["--task", "gen"], { signal: request.signal });
      const out = path.join(request.out, "native.wav");
      writeFileSync(out, "RIFF-fake-WAVE");
      request.onProgress({ stage: "verify", percent: null, etaSeconds: null });
      return { ok: true, status: "completed", out, dir: request.out, runId: `native-${calls.requests.length}`,
        audioSeconds: 12.3, sampleRate: 44100, bytes: 14,
        rights: { commercialUse: false }, record: { model: "yue2-gguf" }, ledger: { delegate: "fake-delegate", generate: "fake-generate" },
        ...result };
    },
    close: () => activeChild?.emit("close", 1),
  };
  return native;
}
const spec = (extra = {}) => ({ engine: "yue2-gguf", title: "Fake native song", caption: "Warm folk", lyrics: "Sing softly", seed: 17, ...extra });
const complete = async (runner, job) => {
  await waitFor(() => runner.history.some((row) => row.id === job.id), "job filing");
  return runner.history.find((row) => row.id === job.id);
};

await test("native WAV and separate provenance land once; no Python estimate, rung or receipt", async () => {
  const h = harness(), native = fakeNative(), runner = h.runner(native);
  const views = [];
  runner.on("update", (s) => { if (s.current) views.push(s.current); });
  const job = runner.enqueue(spec({ wantSeconds: 200, cot: "melody", cfgScale: 2.2, narSteps: 16, abc: "X:1\nK:C\nC", actor: "user" }));
  assert.equal(job.etaSeconds, null);
  await complete(runner, job);
  assert.equal(job.state, "done"); assert.equal(job.file, `aiplay_yue2_gguf_${job.id}.wav`);
  assert.ok(existsSync(path.join(scratch, job.file)));
  assert.ok(existsSync(path.join(scratch, "yue2-gguf", job.id, "native.wav")), "copy retains the source receipt's WAV");
  assert.equal(job.yue, undefined); assert.equal(job.codes, undefined);
  assert.equal(job.yueGguf.runId, job.runId); assert.equal(job.yueGguf.record.model, "yue2-gguf");
  assert.equal(job.yueGguf.ledger.delegate, "fake-delegate"); assert.equal(job.yueGguf.sampleRate, 44100);
  assert.equal(job.yueGguf.realtimeRatio, undefined); assert.equal(job.yueGguf.rung, undefined);
  const r = native.calls.requests[0];
  assert.equal(r.style, "Warm folk"); assert.equal(r.seed, 17); assert.equal(r.cfg_scale, 2.2);
  assert.equal(r.narSteps, 16); assert.equal(r.cot, "melody"); assert.equal(r.via, "jobs.music");
  assert.equal(r.audioSeconds, 200); assert.ok(r.signal instanceof AbortSignal);
  assert.equal(r.quantization, "q4_0"); assert.equal(r.offloadAr, undefined); assert.equal(r.queryChunk, undefined);
  assert.equal(native.calls.free, 1); assert.equal(native.calls.memory, 0, "unmeasured budget does not read Python floor");
  assert.ok(native.events.indexOf("free") < native.events.indexOf("ledger-ack"));
  assert.ok(native.events.indexOf("ledger-ack") < native.events.indexOf("spawn"));
  assert.ok(views.every((v) => v.etaSeconds === null));
  assert.equal(runner.snapshot().history[0].engine, "yue2-gguf");
  assert.equal(runner.history.length, 1); assert.equal(job.proc, null); assert.equal(job.abortController, null);
  assert.deepEqual(h.forbidden, []);
});

await test("native works without Comfy readiness, and stays local even with hosted API enabled", async () => {
  for (const api of [false, true]) {
    const h = harness({ ready: false, api }), native = fakeNative({ queue: async () => { throw Error("offline"); } });
    const runner = h.runner(native), job = runner.enqueue(spec());
    await complete(runner, job);
    assert.equal(job.state, "done"); assert.equal(native.calls.free, 0); assert.equal(native.calls.memory, 0);
    assert.deepEqual(h.forbidden, []);
  }
});

await test("native elapsed time and qualified warnings survive queue completion without an ETA", async () => {
  const warnings = [{ code: "possible_semantic_limit", message: "Check the ending; truncation is not confirmed.",
    evidence: "duration_near_configured_limit", semanticMaxTokens: 9000, approxMaxAudioSeconds: 360 }];
  const generationLimits = { semanticMaxTokens: 9000, approxMaxAudioSeconds: 360, source: "installed-sidecars" };
  const h = harness(), gate = deferred(), native = fakeNative({ childGate: gate, result: { warnings, generationLimits } });
  const runner = h.runner(native), job = runner.enqueue(spec());
  const queued = runner.enqueue(spec());
  assert.equal(runner.snapshot().queue.find((j) => j.id === queued.id).elapsedSeconds, null);
  await runner.cancelById(queued.id);
  await waitFor(() => !!job.proc);
  job.startedAt = Date.now() - 12_000;
  const progress = native.calls.requests[0].onProgress;
  progress({ stage: "load", fraction: null });
  let current = runner.snapshot().current;
  assert.equal(current.stageProgress, null, "unknown is not zero percent");
  assert.equal(current.etaSeconds, null); assert.equal(current.overall, 0);
  assert.ok(current.elapsedSeconds >= 12 && current.elapsedSeconds < 15);
  assert.match(current.stageLabel, /Generating audio/);
  assert.deepEqual(current.warnings, []); assert.equal(current.generationLimits, null);
  gate.resolve(); await complete(runner, job);
  const done = runner.snapshot().history.find((j) => j.id === job.id);
  assert.deepEqual(done.warnings, warnings); assert.deepEqual(done.generationLimits, generationLimits);
  assert.equal(done.state, "done"); assert.ok(done.file, "a qualified warning does not lose valid audio");
  assert.equal(done.etaSeconds, null);
  assert.equal(done.elapsedSeconds, Math.floor((job.finishedAt - job.startedAt) / 1000));
  job.finishedAt = job.startedAt + 9000;
  assert.equal(runner.snapshot().history.find((j) => j.id === job.id).elapsedSeconds, 9, "history elapsed is frozen at finish");
  assert.deepEqual(h.forbidden, []);
});

await test("Q8 selection reaches the native driver and survives the queue snapshot", async () => {
  const h = harness(), native = fakeNative({ result: { quantization: "q8_0" } }), runner = h.runner(native);
  const job = runner.enqueue(spec({ quantization: "q8_0", model: "YuE2 GGUF Q8" }));
  await complete(runner, job);
  assert.equal(native.calls.requests[0].quantization, "q8_0");
  assert.equal(job.quantization, "q8_0");
  assert.equal(runner.snapshot().history[0].quantization, "q8_0");
  assert.deepEqual(h.forbidden, []);
});

await test("music-only mode never contacts a Comfy queue, unload endpoint, or VRAM gate", async () => {
  const h = harness({ ready: false }); h.config.musicOnly = true;
  const native = fakeNative({ queue: () => { throw Error("Standalone mode must not contact Comfy"); } });
  const runner = h.runner(native), job = runner.enqueue(spec()); await complete(runner, job);
  assert.equal(job.state, "done"); assert.equal(native.calls.queue, 0);
  assert.equal(native.calls.free, 0); assert.equal(native.calls.memory, 0);
  assert.deepEqual(h.forbidden, []);
});

await test("busy Comfy drains before idle unload; native explicit budget is not Python's 11.5 GiB", async () => {
  const h = harness(); h.JobRunner.sleep = async () => { await tick(); };
  const native = fakeNative({ budget: 6000, freeMb: (n) => n === 1 ? 4000 : 8192,
    queue: (n) => n < 3 ? { queue_running: n === 1 ? [[0, "image"]] : [], queue_pending: n === 2 ? [[0, "video"]] : [] }
      : { queue_running: [], queue_pending: [] } });
  const runner = h.runner(native), job = runner.enqueue(spec()); await complete(runner, job);
  assert.equal(job.state, "done"); assert.equal(native.calls.queue, 3); assert.equal(native.calls.free, 1); assert.equal(native.calls.memory, 2);
  assert.deepEqual(native.events.slice(0, 6), ["queue", "queue", "queue", "free", "memory", "memory"]);
});

await test("bounded card wait refuses without unloading/spawning; ready but unreadable queue fails closed", async () => {
  for (const queue of [() => ({ queue_running: [[0, "other"]], queue_pending: [] }), () => null, () => ({ queue_running: [] })]) {
    const h = harness(); h.JobRunner.CARD_WAIT_MS = -1;
    const native = fakeNative({ queue }), runner = h.runner(native), job = runner.enqueue(spec());
    await complete(runner, job);
    assert.equal(job.state, "failed"); assert.equal(native.calls.free, 0); assert.equal(native.calls.spawns.length, 0);
    assert.equal(native.calls.requests.length, 0); assert.deepEqual(h.forbidden, []);
  }
  for (const options of [{ freeResult: { freed: false } }, { budget: NaN }, { budget: -1 }]) {
    const h = harness(), native = fakeNative(options), runner = h.runner(native), job = runner.enqueue(spec());
    await complete(runner, job); assert.equal(job.state, "failed"); assert.equal(native.calls.spawns.length, 0);
  }
});

await test("missing native door and unknown IDs refuse without MiniMax/Python/API fallback", async () => {
  for (const engine of ["yue2-gguf", "yue2-guff", "unknown", ""]) {
    const h = harness({ ready: false, api: true }), runner = h.runner();
    const job = runner.enqueue(spec({ engine })); await complete(runner, job);
    assert.equal(job.state, "failed"); assert.match(job.error, /[Nn]o other engine/);
    assert.deepEqual(h.forbidden, []);
  }
});

await test("an explicit native memory budget cannot be bypassed by timeout or unavailable readings", async () => {
  for (const freeMb of [1000, null, NaN, "8192"]) {
    const h = harness(); h.JobRunner.CARD_SETTLE_MS = -1;
    const native = fakeNative({ budget: 6000, freeMb }), runner = h.runner(native), job = runner.enqueue(spec());
    await complete(runner, job); assert.equal(job.state, "failed"); assert.match(job.error, /memory budget/);
    assert.equal(native.calls.spawns.length, 0); assert.equal(native.calls.requests.length, 0);
  }
});

await test("unsupported native continuation/preview flags fail before card or driver work", async () => {
  for (const flags of [{ preview: true }, { reusesConditioning: true }, { resumeFrom: "latent" }, { musicInput: { id: "audio" } }, { instrumental: true }]) {
    const h = harness(), native = fakeNative(), runner = h.runner(native), job = runner.enqueue(spec(flags));
    await complete(runner, job); assert.equal(job.state, "failed"); assert.equal(native.calls.queue, 0);
    assert.equal(native.calls.spawns.length, 0); assert.deepEqual(h.forbidden, []);
  }
});

await test("native section-label intent is explicit and no empty-lyrics bypass is requested", async () => {
  const h = harness(), native = fakeNative(), runner = h.runner(native);
  const job = runner.enqueue(spec({ allowSectionLabels: true }));
  await complete(runner, job);
  assert.equal(native.calls.requests[0].allowEmptyLyrics, false);
  assert.equal(native.calls.requests[0].allowSectionLabels, true);
});

await test("ledger rejection and noncompleted output never start/adopt an alternative", async () => {
  for (const options of [{ refusal: Object.assign(Error("Fake ledger unavailable"), { refusal: "ledger" }) },
    { result: { status: "failed" } }, { result: { audioSeconds: 0 } }, { result: { out: "wrong.flac" } }]) {
    const h = harness(), native = fakeNative(options), runner = h.runner(native), job = runner.enqueue(spec());
    await complete(runner, job); assert.equal(job.state, "failed"); assert.equal(job.file, null); assert.equal(job.yueGguf, undefined);
    if (options.refusal) assert.equal(native.calls.spawns.length, 0);
    assert.equal(runner.history.length, 1); assert.deepEqual(h.forbidden, []);
  }
});

await test("queued cancellation is isolated and never visits the native door", async () => {
  const h = harness(), gate = deferred(), native = fakeNative({ childGate: gate }), runner = h.runner(native);
  const a = runner.enqueue(spec()), b = runner.enqueue(spec());
  await waitFor(() => native.calls.spawns.length === 1);
  const cancelledJob = await runner.cancelById(b.id);
  assert.equal(cancelledJob.state, "cancelled"); assert.equal(runner.current, a); assert.equal(native.calls.kills, 0);
  gate.resolve(); await complete(runner, a);
  assert.equal(native.calls.requests.length, 1); assert.equal(runner.history.filter((j) => j.id === b.id).length, 1);
});

await test("abort waits for owned termination; repeated stop cannot advance or duplicate the queue", async () => {
  const h = harness(), gate = deferred(), native = fakeNative({ childGate: gate }), runner = h.runner(native);
  const a = runner.enqueue(spec()), b = runner.enqueue(spec());
  await waitFor(() => native.calls.spawns.length === 1);
  assert.equal((await runner.cancelById(a.id)).pending, true);
  await runner.cancelById(a.id); await tick();
  assert.equal(native.calls.kills, 1); assert.equal(runner.current, a); assert.equal(native.calls.spawns.length, 1);
  assert.equal(a.state, "cancelling"); assert.ok(a.proc); assert.equal(runner.history.length, 0);
  gate.resolve(); await complete(runner, a); await complete(runner, b);
  assert.equal(a.state, "cancelled"); assert.equal(a.file, null); assert.equal(b.state, "done");
  assert.equal(runner.history.filter((j) => j.id === a.id).length, 1); assert.equal(a.proc, null);
  assert.deepEqual(h.forbidden, []);
});

await test("unconfirmed child-tree termination keeps the slot until observed close", async () => {
  const h = harness(), gate = deferred(), native = fakeNative({ childGate: gate, uncertainTermination: true }), runner = h.runner(native);
  const a = runner.enqueue(spec()), b = runner.enqueue(spec());
  await waitFor(() => native.calls.spawns.length === 1); const child = a.proc;
  await runner.cancelById(a.id); gate.resolve();
  await waitFor(() => /could not be confirmed/.test(a.error || ""));
  assert.equal(runner.current, a); assert.equal(native.calls.spawns.length, 1); assert.equal(runner.history.length, 0);
  child.emit("close", 1); await complete(runner, a); await complete(runner, b);
  assert.equal(a.state, "cancelled"); assert.equal(b.state, "done"); assert.equal(native.calls.kills, 1);
});

await test("abort before ledger acknowledgement or actual spawn cannot start a late child", async () => {
  for (const kind of ["ledgerGate", "spawnGate"]) {
    const gate = deferred(), h = harness(), native = fakeNative({ [kind]: gate }), runner = h.runner(native);
    const job = runner.enqueue(spec());
    await waitFor(() => native.calls.requests.length === 1 && (kind !== "spawnGate" || native.calls.options.length === 1));
    await runner.cancelById(job.id); gate.resolve(); await complete(runner, job);
    assert.equal(job.state, "cancelled"); assert.equal(native.calls.spawns.length, 0);
    assert.equal(native.calls.kills, 0); assert.equal(job.file, null); assert.deepEqual(h.forbidden, []);
  }
});

await test("a timed-out driver remains failed, not user-cancelled; close-before-error does not stall the queue", async () => {
  const h = harness(), native = fakeNative();
  const run = native.runDriver;
  native.runDriver = async (...args) => {
    await run(...args); // The owned close happened before the rejection reaches the queue.
    throw Object.assign(Error("Fake native timeout"), { refusal: "timeout", terminationConfirmed: false });
  };
  const runner = h.runner(native), a = runner.enqueue(spec()), b = runner.enqueue(spec());
  await complete(runner, a); await complete(runner, b);
  assert.equal(a.state, "failed"); assert.match(a.error, /timeout/); assert.equal(a.cancelRequested, undefined);
  assert.equal(b.state, "failed"); assert.equal(runner.history.length, 2); assert.equal(runner.current, null);
  assert.equal(native.calls.kills, 0); assert.deepEqual(h.forbidden, []);
});

await test("abort while waiting for busy Comfy never unloads or interrupts another actor", async () => {
  const h = harness(), sleep = deferred(); h.JobRunner.sleep = () => sleep.promise;
  const native = fakeNative({ queue: () => ({ queue_running: [[0, "somebody-else"]], queue_pending: [] }) });
  const runner = h.runner(native), job = runner.enqueue(spec());
  await waitFor(() => job.stage === "waiting"); await runner.cancelById(job.id); sleep.resolve();
  await complete(runner, job); assert.equal(job.state, "cancelled"); assert.equal(native.calls.free, 0);
  assert.equal(native.calls.spawns.length, 0); assert.deepEqual(h.forbidden, []);
});

await test("Comfy death/progress/error events cannot finish native work or fabricate ETA", async () => {
  const h = harness(), gate = deferred(), native = fakeNative({ childGate: gate }), runner = h.runner(native);
  await runner.connect(); const job = runner.enqueue(spec()); await waitFor(() => !!job.proc);
  h.comfy.emit("died", { code: 1 });
  h.socket().emit("message", JSON.stringify({ type: "progress", data: { value: 90, max: 100 } }), false);
  h.socket().emit("message", JSON.stringify({ type: "execution_error", data: { exception_message: "unrelated" } }), false);
  h.socket().emit("message", JSON.stringify({ type: "executing", data: { node: null } }), false);
  assert.equal(runner.current, job); assert.equal(job.state, "running"); assert.equal(job.overall, 0);
  const progress = native.calls.requests[0].onProgress;
  progress({ stage: "nar", fraction: 9, overall: 0.9, etaSeconds: 1, status: "completed" });
  assert.equal(job.stageProgress, 1); assert.equal(job.overall, 0); assert.equal(job.etaSeconds, null);
  progress({ stage: "nar", fraction: -9 }); assert.equal(job.stageProgress, 0);
  progress({ stage: "__proto__", fraction: 1 }); assert.equal(job.stage, "nar");
  gate.resolve(); await complete(runner, job); assert.equal(job.state, "done");
});

await test("native copy failures file once; stopping already-completed output preserves its filing", async () => {
  {
    const h = harness({ copy: async () => { throw Error("Fake disk full"); } }), native = fakeNative(), runner = h.runner(native);
    const job = runner.enqueue(spec()); await complete(runner, job);
    assert.equal(job.state, "failed"); assert.match(job.error, /disk full/); assert.equal(job.file, null);
    assert.equal(runner.history.length, 1);
  }
  {
    const gate = deferred(); let copying = false;
    const h = harness({ copy: async (...args) => { copying = true; await gate.promise; return copyFile(...args); } });
    const runner = h.runner(fakeNative()), job = runner.enqueue(spec()); await waitFor(() => copying);
    assert.equal((await runner.cancelById(job.id)).state, "done"); assert.equal(job.cancelRequested, undefined);
    gate.resolve(); await complete(runner, job); assert.equal(job.state, "done"); assert.ok(job.file);
  }
});

await test("Python door/receipt/11.5 GiB handoff remains separate", async () => {
  const h = harness(); h.JobRunner.sleep = async () => tick();
  const native = fakeNative(), python = fakeNative({ freeMb: (n) => n === 1 ? 8192 : 14000 });
  python.renderSong = async (request) => {
    python.calls.requests.push(request);
    const out = path.join(request.out, "audio.flac"); writeFileSync(out, "fLaC-fake");
    return { out, audioSeconds: 14, runId: "python-run", realtimeRatio: 2.6, truncated: null };
  };
  const runner = h.runner(native, python), job = runner.enqueue(spec({ engine: "yue2", wantSeconds: 200,
    rung: { id: "long", offloadAr: true, queryChunk: 512, quantization: "none" } }));
  assert.equal(job.etaSeconds, Math.round(200 * 2.65 + 111)); await complete(runner, job);
  assert.equal(job.state, "done"); assert.equal(job.file, `aiplay_yue2_${job.id}.flac`);
  assert.equal(job.yue.runId, "python-run"); assert.equal(job.yueGguf, undefined);
  assert.equal(python.calls.memory, 2); assert.equal(native.calls.requests.length, 0);
  assert.equal(python.calls.requests[0].offloadAr, true); assert.equal(python.calls.requests[0].queryChunk, 512);
});
} finally {
  // Sequential top-level awaited tests can let a root after hook fire early.
  // Own this fixture's lifetime explicitly, and delete only its exact resolved
  // path; older test directories and application data are never enumerated.
  const resolved = realpathSync.native(scratch);
  assert.equal(resolved, path.resolve(scratch));
  assert.equal(path.dirname(resolved), realpathSync.native(tmpdir()));
  assert.match(path.basename(resolved), /^aiplay-jobs-gguf-test-/);
  rmSync(resolved, { recursive: true, force: true });
  assert.equal(existsSync(resolved), false, "this run's fixture was removed");
}
