/** Real make_clip handler, with an in-memory HTTP boundary only. */
import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./mcp.js";
import { videoLoraInput } from "./video-lora-validation.js";
import { h3OptionalMcpBody } from "./mcp-h3-refmods.js";
import { h3ControlOptions } from "./h3-video-control.js";
import { emptyResultNote } from "./art-wait.js";

const tool = TOOLS.find((entry) => entry.name === "make_clip");
const status = { config: { video: { enabled: true, ready: true, engine: "h3", engines: { h3: {} } } } };
const plan = { version: 1, mode: "pose", source: { name: "source.mp4", bytes: 64, sha256: "a".repeat(64) },
  target: { width: 1344, height: 768, frames: 124, fps: 24 }, strength: 0, start: 0, end: 0.8 };

function runWith(api, waitForArt = async () => ({ done: true })) {
  const run = String(tool.run).replace(/^async run\(/, "async function(");
  return new Function("api", "safeName", "waitForArt", "videoLoraInput", "emptyResultNote", "h3OptionalMcpBody", `return (${run});`)(
    api, (name) => name, waitForArt, videoLoraInput, emptyResultNote, h3OptionalMcpBody);
}

test("make_clip advertises all three explicit control modes", () => {
  assert.deepEqual(tool.inputSchema.properties.control_mode.enum, ["depth", "pose", "prepared"]);
});

test("make_clip forwards each exact mode and zero-valued controls, returning the checked plan", async () => {
  for (const mode of ["depth", "pose", "prepared"]) {
    const posts = [], returned = { ...plan, mode };
    const run = runWith(async (method, route, body) => {
      if (route === "/api/status") return status;
      assert.equal(method, "POST"); assert.equal(route, "/api/video");
      posts.push(body);
      return { engine: "h3", videoControl: returned };
    });
    const result = await run({ prompt: "a clay performer", check_only: true, source_video: "source.mp4",
      control_mode: mode, control_strength: 0, control_start: 0, control_end: 0.8 });
    assert.equal(posts.length, 1);
    assert.deepEqual(h3ControlOptions(posts[0]), { source: "source.mp4", mode, strength: 0, start: 0, end: 0.8 });
    assert.equal(posts[0].action, "check");
    assert.deepEqual(result.video_control, returned);
  }
});

test("make_clip preserves invalid and orphaned controls for the common validator to refuse", async () => {
  for (const args of [{ control_mode: "pose" }, { source_video: "source.mp4", control_strength: "1" },
    { source_video: "source.mp4", control_start: 0.9, control_end: 0.1 }]) {
    let checked = 0;
    const run = runWith(async (_method, route, body) => {
      if (route === "/api/status") return status;
      checked++;
      try { h3ControlOptions(body); } catch (error) { return { error: error.message }; }
      throw new Error("The invalid request unexpectedly passed the common validator.");
    });
    await assert.rejects(run({ prompt: "a clay performer", check_only: true, ...args }),
      /Choose a source|finite number|later than/);
    assert.equal(checked, 1);
  }
});

test("make_clip does not invent a source plan on an ordinary check", async () => {
  const run = runWith(async (_method, route, body) => {
    if (route === "/api/status") return status;
    assert.equal(h3ControlOptions(body), null);
    return { engine: "h3" };
  });
  assert.equal((await run({ prompt: "a clay performer", check_only: true })).video_control, null);
});

test("make_clip returns only actual newly saved control receipts after its own job settles", async () => {
  const receipt = { ...plan, normalizedSha256: "b".repeat(64), controlSha256: "c".repeat(64), preprocessRunId: "pose-fixture" };
  let lists = 0, waited = 0;
  const run = runWith(async (method, route, body) => {
    if (route === "/api/status") return status;
    if (method === "GET" && route === "/api/clips") {
      const rows = [{ name: "old.mp4", meta: { videoControl: { ...receipt, preprocessRunId: "old" } } }];
      return { clips: ++lists === 1 ? rows : [...rows,
        { name: "new.mp4", meta: { videoControl: receipt } }, { name: "legacy.mp4", meta: {} }] };
    }
    assert.equal(method, "POST"); assert.equal(route, "/api/video"); assert.equal(body.action, "create");
    assert.equal(body.controlMode, "pose"); assert.equal(body.sourceVideo, "source.mp4");
    return { job: { id: "control-job" } };
  }, async (_timeout, kind, id) => {
    assert.equal(kind, "video"); assert.equal(id, "control-job"); waited++;
    return { done: true };
  });
  const result = await run({ prompt: "a clay performer", source_video: "source.mp4", control_mode: "pose" });
  assert.equal(waited, 1); assert.equal(lists, 2);
  assert.deepEqual(result.clips, ["new.mp4", "legacy.mp4"]);
  assert.deepEqual(result.video_control_receipts, { "new.mp4": receipt });
});

// Append to server/h3-video-control-mcp_test.js after root adds model_file.
// Uses that suite's actual make_clip tool, runWith, status and plan fixtures.

test("make_clip exposes an optional installed checkpoint filename", () => {
  assert.equal(tool.inputSchema.properties.model_file?.type, "string");
  assert.equal(tool.inputSchema.required.includes("model_file"), false);
});

test("make_clip forwards the exact checkpoint for check and reports only the server-checked model", async () => {
  const model = "singularity-v2-int8-convrot.safetensors", verified = "h3/singularity-v2-int8-convrot.safetensors", posts = [];
  const run = runWith(async (method, route, body) => {
    if (route === "/api/status") return status;
    assert.equal(method, "POST"); assert.equal(route, "/api/video");
    posts.push(JSON.parse(JSON.stringify(body)));
    return { engine: "h3", videoControl: plan, videoModels: { dit: verified, ditRef: verified } };
  });
  const result = await run({ prompt: "a clay performer", check_only: true,
    model_file: model, source_video: "source.mp4", control_mode: "pose" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].action, "check");
  assert.equal(posts[0].modelFile, model);
  assert.equal(posts[0].controlMode, "pose");
  assert.equal(posts[0].sourceVideo, "source.mp4");
  assert.deepEqual(result.video_control, plan);
  assert.equal(result.model_file, verified, "return the validated server path, not an echo of the request");
});

test("make_clip does not invent a checked model when the server supplies no selected-model receipt", async () => {
  const run = runWith(async (_method, route, body) => {
    if (route === "/api/status") return status;
    assert.equal(body.modelFile, "singularity-v2-int8-convrot.safetensors");
    return { engine: "h3", videoControl: plan };
  });
  const result = await run({ prompt: "a clay performer", check_only: true,
    model_file: "singularity-v2-int8-convrot.safetensors" });
  assert.equal(result.model_file, null);
});

test("make_clip forwards the exact create checkpoint and returns its saved reference-path receipt", async () => {
  const model = "singularity-v2-int8-convrot.safetensors";
  const checkpoint = { requestedBuild: "auto", ranBuild: "auto", file: model, reference: true, fallback: null };
  const receipt = { ...plan, preprocessRunId: "pose-reference-fixture" };
  let lists = 0, waited = 0, submitted = 0;
  const run = runWith(async (method, route, body) => {
    if (route === "/api/status") return status;
    if (method === "GET" && route === "/api/clips") {
      return { clips: ++lists === 1 ? [] : [{ name: "selected-reference.mp4",
        meta: { h3Checkpoint: checkpoint, videoControl: receipt } }] };
    }
    assert.equal(method, "POST"); assert.equal(route, "/api/video");
    assert.equal(body.action, "create"); assert.equal(body.modelFile, model);
    assert.equal(body.controlMode, "pose");
    assert.deepEqual(body.refImages, ["reference.png"]);
    submitted++;
    return { job: { id: "selected-model-job" } };
  }, async (_timeout, kind, id) => {
    assert.equal(kind, "video"); assert.equal(id, "selected-model-job");
    waited++; return { done: true };
  });
  const result = await run({ prompt: "a clay performer", model_file: model,
    source_video: "source.mp4", control_mode: "pose", ref_images: ["reference.png"] });
  assert.equal(submitted, 1); assert.equal(waited, 1); assert.equal(lists, 2);
  assert.deepEqual(result.checkpoint_receipts, { "selected-reference.mp4": checkpoint });
  assert.deepEqual(result.video_control_receipts, { "selected-reference.mp4": receipt });
});

test("ordinary make_clip requests omit a checkpoint override on both wire paths", async () => {
  for (const checkOnly of [true, false]) {
    let posted = 0;
    const run = runWith(async (method, route, body) => {
      if (route === "/api/status") return status;
      if (method === "GET" && route === "/api/clips") return { clips: [] };
      assert.equal(method, "POST"); assert.equal(route, "/api/video");
      const wire = JSON.parse(JSON.stringify(body));
      assert.equal(Object.hasOwn(wire, "modelFile"), false);
      assert.equal(Object.hasOwn(wire, "model_file"), false);
      posted++;
      return checkOnly ? { engine: "h3" } : { job: { id: "ordinary-job" } };
    });
    await run({ prompt: "an ordinary forest", check_only: checkOnly });
    assert.equal(posted, 1);
  }
});

test("an uninstalled checkpoint reaches the server refusal without waiting or fabricating a clip", async () => {
  const missing = "not-installed.safetensors";
  let posts = 0, waits = 0, lists = 0;
  const run = runWith(async (method, route, body) => {
    if (route === "/api/status") return status;
    if (method === "GET" && route === "/api/clips") { lists++; return { clips: [] }; }
    assert.equal(method, "POST"); assert.equal(route, "/api/video");
    assert.equal(body.modelFile, missing); posts++;
    return { error: `No such video model: ${missing}. It must be in models/diffusion_models.` };
  }, async () => { waits++; throw new Error("A refused checkpoint must never be awaited as a render."); });
  await assert.rejects(run({ prompt: "a clay performer", model_file: missing }), /No such video model: not-installed/);
  assert.equal(posts, 1); assert.equal(waits, 0); assert.equal(lists, 1);
});

test("missing and incompatible check models return the server refusal without creating or waiting", async () => {
  for (const [model, error] of [["not-installed.safetensors", "No such video model: not-installed.safetensors."],
    ["ltx2-model.safetensors", "ltx2-model.safetensors is an LTX model; switch the engine or choose an H3 model."]]) {
    let posts = 0, waits = 0;
    const run = runWith(async (method, route, body) => {
      if (route === "/api/status") return status;
      assert.equal(method, "POST"); assert.equal(route, "/api/video");
      assert.equal(body.action, "check"); assert.equal(body.modelFile, model); posts++;
      return { engine: "h3", refusal: { error, reason: "video-model" }, videoModels: null };
    }, async () => { waits++; throw new Error("A check must not wait for a render."); });
    const result = await run({ prompt: "a clay performer", check_only: true, model_file: model });
    assert.equal(result.would_render, false); assert.equal(result.refusal, error);
    assert.equal(result.model_file, null); assert.equal(result.video_control, null);
    assert.equal(posts, 1); assert.equal(waits, 0);
  }
});

test("list_clips returns saved control and checkpoint receipts, with nulls for old/imported clips", async () => {
  const list = TOOLS.find((entry) => entry.name === "list_clips");
  const receipt = { ...plan, preprocessRunId: "saved-pose-fixture", controlSha256: "d".repeat(64) };
  const checkpoint = { requestedBuild: "auto", ranBuild: "auto", file: "singularity-v2-int8-convrot.safetensors", reference: true, fallback: null };
  const rows = [{ name: "controlled.mp4", meta: { videoControl: receipt, h3Checkpoint: checkpoint } },
    { name: "old.mp4", meta: {} }, { name: "imported.webm", meta: { source: "imported" } }];
  let calls = 0;
  const run = new Function("api", `return (${String(list.run).replace(/^async run\(/, "async function(")});`)(async (method, route) => {
    assert.equal(method, "GET"); assert.equal(route, "/api/clips"); calls++;
    return { clips: rows };
  });
  const result = await run({});
  assert.equal(calls, 1);
  assert.deepEqual(result[0].video_control, receipt); assert.deepEqual(result[0].h3_checkpoint, checkpoint);
  for (const row of result.slice(1)) {
    assert.equal(row.video_control, null); assert.equal(row.h3_checkpoint, null);
  }
});
