/** Execute the two real route seams, without starting Studio or a model. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { alignFrames } from "./workflow.js";
import { findShelfModel, requireModelName } from "./localmodels.js";

const source = (await readFile(new URL("./index.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const between = (start, end) => {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `Missing real route boundary: ${start}`);
  return source.slice(at, until);
};
const failure = between("const videoControlFailure =", "const art = new ArtRunner");
const check = between("        let videoControl = null, videoModels = null;", "      if (b.action === \"create\") {");
const create = between("        let videoControl;", "        /* What the render really carries:");
const clean = (value) => JSON.parse(JSON.stringify(value));
function call(kind, { body = {}, error = null, assigned = false } = {}) {
  const calls = [], receipt = { version: 1, source: { name: "take.mp4", sha256: "a".repeat(64) }, patch: "h3-control.safetensors" };
  const context = { b: body, optionalH3: { refMods: [] }, plan: { width: 1344, height: 768, seconds: 5, warnings: [] },
    gate: { engine: "h3" }, eng: "h3", config: { video: { enabled: true } }, control: { video: "take.mp4", patch: null },
    res: {}, picked: { models: null }, refImages: [], refAudios: [], alignFrames, videoEngine: () => ({ fps: 24 }), assignedTo: () => assigned,
    videoModelPatch: async () => ({ models: null }),
    videoControlService: { check: async (...args) => { calls.push(args); if (error) throw error; return receipt; } },
    json: (_res, status, body) => ({ status, body }) };
  const fragment = kind === "check" ? check.replace(/\n      }\s*$/, "") : create;
  const code = `${failure}\n(async () => {${fragment}\nreturn { videoControl, control };})()`;
  return { calls, receipt, result: vm.runInNewContext(code, context, { timeout: 1000 }) };
}

test("check and create call the same control validator with the actual aligned H3 plan", async () => {
  const body = { sourceVideo: "take.mp4", controlMode: "pose", controlStrength: 0.8, controlStart: 0.1, controlEnd: 0.9, modelFile: "singularity.safetensors" };
  const preview = call("check", { body, assigned: true }), render = call("create", { body, assigned: true });
  const checked = await preview.result, created = await render.result;
  assert.deepEqual(clean(preview.calls), clean(render.calls));
  assert.deepEqual(clean(preview.calls[0][1]), { engineKey: "h3", width: 1344, height: 768, fps: 24, frames: 124, customWorkflow: true, models: null, refImages: [], refAudios: [] });
  assert.equal(preview.calls[0][0].modelFile, "singularity.safetensors");
  assert.deepEqual(clean(checked.body.videoControl), render.receipt);
  assert.equal(created.control.patch, render.receipt.patch);
});

test("both routes carry the same model/node refusal and never queue after failed validation", async () => {
  const error = Object.assign(new Error("Get the Small depth model first."), { reason: "needs-model", needsModel: { id: "depthPreprocess", tool: "download_model" }, needsNodes: ["AiplayH3DepthGuide"] });
  const preview = await call("check", { error }).result, render = await call("create", { error }).result;
  assert.equal(preview.status, 200); assert.equal(preview.body.ok, false); assert.equal(render.status, 400);
  assert.deepEqual(clean(preview.body.refusal), clean(render.body));
  assert.equal(render.body.needsModel.id, "depthPreprocess");
});

test("a pre-existing video plan refusal stops before source inspection", async () => {
  const fragment = check.replace(/\n      }\s*$/, ""), calls = [];
  const result = await vm.runInNewContext(`${failure}\n(async () => {${fragment}})()`, {
    plan: { refusal: { error: "unsupported reference" }, warnings: [] }, gate: { engine: "h3" }, config: { video: { enabled: true } }, res: {},
    json: (_res, status, body) => ({ status, body }), videoModelPatch: async () => ({ models: null }), videoControlService: { check: async () => { calls.push(true); } },
  });
  assert.equal(result.body.ok, false); assert.equal(calls.length, 0);
});

test("check validates the real named checkpoint and parts resolver used by create before source work", async () => {
  const modelFunction = between("async function videoModelPatch(", "\n/**\n * What a family still needs");
  const shelf = [{ folder: "diffusion_models", name: "SingularityV2.safetensors", ok: true, engine: "h3", family: "H3", bytes: 10 },
    { folder: "diffusion_models", name: "ltx.safetensors", ok: true, engine: "ltx", family: "LTX", bytes: 10 }];
  const parts = { encoders: [{ folder: "text_encoders", name: "encoder.safetensors", fit: { h3: "yes" }, bytes: 10 }],
    vaes: [{ folder: "vae", name: "wrong.safetensors", fitVideo: { h3: "no" }, bytes: 10 }] };
  const context = { config: { video: { enabled: true } }, listVideoPickable: async () => shelf, listVideoParts: async () => parts, findShelfModel, requireModelName,
    plan: { width: 1344, height: 768, seconds: 5, warnings: [] }, gate: { engine: "h3" }, eng: "h3", res: {},
    optionalH3: {}, videoEngine: () => ({ fps: 24 }), alignFrames, assignedTo: () => false,
    json: (_res, status, body) => ({ status, body }) };
  const fragment = check.replace(/\n      }\s*$/, "");
  async function preview(body) {
    let inspected = 0;
    const result = await vm.runInNewContext(modelFunction + "\n" + failure + "\n(async () => {" + fragment + "})()", {
      ...context, b: body, videoControlService: { check: async () => { inspected++; return null; } },
    });
    return { result, inspected };
  }
  const body = { modelFile: "SingularityV2.safetensors", encoder: "encoder.safetensors" };
  const good = await preview(body);
  assert.equal(good.result.body.ok, true); assert.equal(good.inspected, 1);
  assert.deepEqual(clean(good.result.body.videoModels), { dit: body.modelFile, ditRef: body.modelFile, textEncoder: body.encoder });
  const picked = between("        const picked = await videoModelPatch(b, eng);", "\n        let videoControl;");
  const created = await vm.runInNewContext(modelFunction + "\n(async () => {" + picked + "\nreturn picked.models;})()", { ...context, b: body });
  assert.deepEqual(clean(created), clean(good.result.body.videoModels));
  for (const request of [{ modelFile: "missing.safetensors" }, { modelFile: "ltx.safetensors" }, { videoVae: "wrong.safetensors" }, { modelFile: "../escape" }]) {
    const refused = await preview(request);
    assert.equal(refused.result.status, 200); assert.equal(refused.result.body.ok, false);
    assert.equal(refused.result.body.refusal.reason, "video-model");
    assert.equal(refused.inspected, 0, "invalid selected model stops before source/preprocessor work");
  }
});
