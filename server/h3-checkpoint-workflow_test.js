import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// No live engine or user output: even the custom workflow's dispatch is mocked.
const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-checkpoint-workflow-"));
process.env.AIPLAY_OUTPUT = path.join(temp, "output");
process.env.AIPLAY_INPUT = path.join(temp, "input");
process.env.AIPLAY_APPDATA = path.join(temp, "appdata");
const { ArtRunner } = await import("./art.js");
const { config } = await import("./config.js");
const { engine } = await import("./engine/client.js");
const { CUSTOM_DIR } = await import("./customWorkflows.js");

test("a custom workflow assigned while a checkpoint job waits refuses explicit choices and preserves saved defaults", async () => {
  const before = { build: config.video.h3ModelBuild, workflows: config.customWorkflows,
    run: engine.run, socket: engine.socket, objectInfo: engine.objectInfo, fetch: globalThis.fetch };
  const workflowId = `checkpoint_cpu_${process.pid}_${Date.now().toString(36)}`;
  const workflowFile = path.join(CUSTOM_DIR, `${workflowId}.json`);
  const dispatched = [], terminal = [];
  const music = { current: { id: "waiting-for-music" }, queue: [], loaded: null };
  const runner = new ArtRunner({ ready: true }, music);
  let networkCalls = 0, nodeReads = 0;
  try {
    config.video.h3ModelBuild = "w6a8";
    config.customWorkflows = {};
    engine.socket = () => { throw new Error("No progress socket in a CPU fixture"); };
    engine.objectInfo = async () => { nodeReads++; throw new Error("No native discovery expected"); };
    engine.run = async (spec) => {
      dispatched.push(spec);
      return { runId: `checkpoint-cpu-${dispatched.length}`, status: "failed", error: "CPU fixture dispatch completed." };
    };
    globalThis.fetch = async () => { networkCalls++; throw new Error("The CPU fixture must never contact an engine"); };
    const queue = (id, extra = {}) => runner.request({ file: `clip:${id}`, title: id, kind: "video", force: true, seed: 7,
      video: { engine: "h3", prompt: "A paper boat passes a garden", seconds: 2, width: 512, height: 320, ...extra } });
    const explicitAuto = queue("explicit-auto", { h3ModelBuild: "auto", h3ModelBuildExplicit: true });
    const explicitW6 = queue("explicit-w6", { h3ModelBuild: "w6a8", h3ModelBuildExplicit: true });
    const omitted = queue("omitted-selector");
    // The API resolves the saved build before queueing. This supplied value is
    // still a default, and must not turn into an explicit per-render request.
    const routeDefault = queue("resolved-saved-selector", { h3ModelBuild: "w6a8", h3ModelBuildExplicit: false });
    assert.ok(explicitAuto && explicitW6 && omitted && routeDefault, runner.lastRefusal);
    assert.equal(runner.queue.length, 4);
    assert.equal(explicitAuto.h3ModelBuildExplicit, true);
    assert.equal(explicitW6.h3ModelBuildExplicit, true);
    assert.equal(omitted.h3ModelBuild, "w6a8");
    assert.equal(omitted.h3ModelBuildExplicit, false);
    assert.equal(routeDefault.h3ModelBuildExplicit, false);
    assert.equal(config.video.h3ModelBuild, "w6a8", "per-render choices do not change the saved build");

    await mkdir(CUSTOM_DIR, { recursive: true });
    await writeFile(workflowFile, JSON.stringify({ 1: { class_type: "CheckpointCpuFixture", inputs: { prompt: "%prompt%", seed: "%seed%" } } }));
    config.customWorkflows = { video: workflowId };
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The CPU queue did not finish")), 8000);
      runner.on("failed", (event) => {
        terminal.push(event);
        if (terminal.length === 4) { clearTimeout(timer); resolve(); }
      });
    });
    music.current = null;
    await completed;
    for (const id of ["explicit-auto", "explicit-w6"]) {
      const failure = terminal.find((event) => event.file === `clip:${id}`);
      assert.match(failure.error, /checkpoint choice requires the built-in H3 workflow.*Unassign the custom Video workflow/);
      assert.equal(failure.runId, null, "the explicit choice never reaches the engine");
    }
    assert.equal(dispatched.length, 2, "both default jobs retain the assigned custom workflow");
    for (const spec of dispatched) {
      assert.equal(spec.graph[1].class_type, "CheckpointCpuFixture", "the unchanged custom graph is dispatched");
    }
    assert.equal(nodeReads, 0, "refusal and custom defaults need no native loader discovery");
    assert.equal(networkCalls, 0, "all engine interactions were mocked");
    assert.equal(config.video.h3ModelBuild, "w6a8");
  } finally {
    runner.paused = true;
    runner.queue = [];
    config.video.h3ModelBuild = before.build;
    config.customWorkflows = before.workflows;
    engine.run = before.run;
    engine.socket = before.socket;
    engine.objectInfo = before.objectInfo;
    globalThis.fetch = before.fetch;
    assert.equal(path.dirname(workflowFile), path.resolve(CUSTOM_DIR));
    await rm(workflowFile, { force: true });
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("aiplay-checkpoint-workflow-"));
    await rm(temp, { recursive: true, force: true });
  }
});
