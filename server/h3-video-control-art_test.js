import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-h3-control-art-"));
process.env.AIPLAY_OUTPUT = path.join(root, "output");
process.env.AIPLAY_INPUT = path.join(root, "input");
process.env.AIPLAY_APPDATA = path.join(root, "appdata");
const { ArtRunner } = await import("./art.js");
const { engine } = await import("./engine/client.js");
const { config } = await import("./config.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("video control stays in the music-first art queue, holds through sampling, and carries its receipt", async () => {
  const keys = ["run", "socket", "status", "queue", "objectInfo", "ranSinceStart", "interrupt"];
  const originals = Object.fromEntries(keys.map((key) => [key, engine[key]]));
  const fetch = globalThis.fetch, freeBefore = config.video.freeBeforeClip, customWorkflows = config.customWorkflows;
  const calls = [], receipt = { mode: "depth", source: { name: "source.mp4", sha256: "a".repeat(64) }, normalizedSha256: "b".repeat(64),
    controlSha256: "c".repeat(64), preprocessRunId: "cpu-preprocess", target: { width: 64, height: 64, fps: 24, frames: 56 } };
  let held = false, outcome = "completed", restarts = 0, cpuWait = null, cpuStarted = null, assignDuring = false;
  const runner = new ArtRunner({ ready: true, restart: async () => { restarts++; throw new Error("a control hold must not restart its engine"); } },
    { current: { id: "song" }, queue: [], loaded: null }, { videoControl: {
      async prepare(plan, options) {
        assert.equal(plan.source.name, "source.mp4"); assert.equal(options.actor, "agent:control-test");
        assert.equal(options.private, true);
        options.onStage("cpu");
        if (cpuWait) { options.onStage("preprocess"); cpuStarted(); await cpuWait; if (options.cancelled()) throw new Error("stopped before GPU"); }
        assert.equal(options.cancelled(), false);
        calls.push("prepare"); held = true;
        if (assignDuring) config.customWorkflows = { video: "newly-assigned-workflow" };
        return { file: "owned-control.mp4", patch: "owned-patch.safetensors", receipt,
          async cleanup({ known }) { calls.push(["cleanup", known]); held = false; return { retained: known ? [] : [path.join(root, "input", "owned-control.mp4")] }; } };
      },
    } });
  const ended = (name) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No ${name} outcome`)), 8000);
    runner.once(name, (event) => { clearTimeout(timeout); resolve(event); });
  });
  try {
    globalThis.fetch = async () => { throw new Error("No network in this CPU queue fixture"); };
    engine.socket = () => new EventEmitter();
    engine.status = async () => ({ running: [] });
    engine.queue = async () => ({ queue_running: [], queue_pending: [] });
    engine.objectInfo = async () => ({});
    engine.interrupt = async () => { throw new Error("CPU staging must not interrupt another engine run"); };
    engine.ranSinceStart = () => 1;
    config.video.freeBeforeClip = "always";
    engine.run = async (spec) => {
      assert.equal(held, true, "the preprocessing hold remains active in the final sampler");
      calls.push(["sample", spec]);
      assert.equal(spec.graph[30].inputs.file, "owned-control.mp4");
      assert.equal(spec.graph[33].inputs.name, "owned-patch.safetensors");
      if (outcome !== "completed") return { status: "timeout", runId: "cpu-unknown", outputs: [] };
      const [id, save] = Object.entries(spec.graph).find(([, node]) => node.class_type === "SaveVideo");
      const folder = path.posix.dirname(save.inputs.filename_prefix), file = "cpu-control-output.mp4";
      await mkdir(path.join(root, "output", folder), { recursive: true });
      await writeFile(path.join(root, "output", folder, file), "CPU fixture only");
      return { status: "completed", runId: "cpu-render", cached: false, outputs: [{ node: id, type: "output", file, subfolder: folder }] };
    };
    const request = (id) => runner.request({ kind: "video", file: "clip:" + id, title: "a paper bird", actor: "agent:control-test", force: true, asked: true,
      private: true, seed: 42, video: { engine: "h3", prompt: "a paper bird", width: 64, height: 64, seconds: 2, steps: 20,
        attention: "pytorch", sparse: "off", blockCache: false, keepAudio: false,
        videoControl: { version: 1, source: { name: "source.mp4" } }, controlVideo: "source.mp4", controlPatch: "owned-patch.safetensors" } });
    const success = ended("clip"); const first = request("controlled-one"); assert.ok(first, runner.lastRefusal);
    await sleep(1350);
    assert.deepEqual(calls, [], "neither CPU staging nor an estimator starts under a running song");
    runner.jobs.current = null;
    const event = await success;
    assert.equal(event.runId, "cpu-render"); assert.deepEqual(event.meta.videoControl, receipt);
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["prepare", "sample", "cleanup"]);
    assert.deepEqual(calls.at(-1), ["cleanup", true]); assert.equal(held, false); assert.equal(restarts, 0);
    outcome = "timeout";
    const failure = ended("failed"); const second = request("controlled-two"); assert.ok(second);
    assert.equal((await failure).runId, "cpu-unknown");
    assert.deepEqual(calls.at(-1), ["cleanup", false]);
    assert.equal(second.controlRetained.length, 1);
    let releaseCpu;
    cpuWait = new Promise((resolve) => { releaseCpu = resolve; });
    const preparing = new Promise((resolve) => { cpuStarted = resolve; });
    const cancelled = ended("failed"); const third = request("controlled-stop"); assert.ok(third);
    await preparing;
    engine.status = async () => ({ running: [{ via: "mv.unrelated", runId: "leave-this-run-alone" }] });
    const stopped = await runner.stopCurrent();
    assert.equal(stopped.stopping, true); assert.equal(third.cancelled, true);
    releaseCpu();
    assert.equal((await cancelled).cancelled, true);
    assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "sample").length, 2, "stopping CPU staging submits no new graph");
    cpuWait = null; assignDuring = true;
    const reassigned = ended("failed"); request("controlled-reassigned");
    assert.match((await reassigned).error, /built-in H3 workflow/);
    assert.deepEqual(calls.at(-1), ["cleanup", true]);
    assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "sample").length, 2, "a custom workflow assigned during extraction cannot silently replace control");
  } finally {
    Object.assign(engine, originals); globalThis.fetch = fetch; config.video.freeBeforeClip = freeBefore; config.customWorkflows = customWorkflows;
    runner.setPaused(true);
    await rm(root, { recursive: true, force: true });
  }
});
