/** Exercise the actual /api/image handler with a stub queue and runtime. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { qwenImageGraph, QWEN_IMAGE_PRESET } from "./qwen-image.js";
import { QWEN_IMAGE_ENGINE } from "./qwen-status.js";
import { applyPersona, personaFits } from "./personas.js";
import { jobIdentity } from "./wildcards.js";

const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const start = source.indexOf('if (p === "/api/image" && req.method === "POST")');
const end = source.indexOf('if (p === "/api/', start + 20);
assert.ok(start > 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("deps", `const { p,req,res,readBody,json,config,path,qwenImageGraph,QWEN_IMAGE_PRESET,QWEN_IMAGE_ENGINE,qwenImageStatus,hasWildcards,expand,personas,personaFits,stageQwenReferences,COVER_DIR,IMAGE_DIR,applyPersona,pendingImagePrompt,pendingImageActor,pendingImageWild,prov,resolveRepeat,imageDupGuard,art,combinations }=deps; ${source.slice(start, end)}`);

async function request(body, { ready = true, persona = null, stageError = null } = {}) {
  const queued = [], preflights = [], staged = [];
  const deps = {
    p: "/api/image", req: { method: "POST" }, res: {}, readBody: async () => ({ action: "create", ...body }),
    json: (_, status, result) => ({ status, body: result }), path,
    config: { image: { engine: QWEN_IMAGE_ENGINE }, art: { size: 1024, steps: 4 }, inputDir: "input" },
    qwenImageGraph, QWEN_IMAGE_PRESET, QWEN_IMAGE_ENGINE,
    qwenImageStatus: async ({ options } = {}) => { preflights.push(options); return { ready, filesReady: ready, runtimeReady: ready, missingFiles: [], missingNodes: ready ? [] : ["TextEncodeQwenImage21"], error: ready ? null : "Missing runtime" }; },
    hasWildcards: () => false, expand: (prompt) => ({ prompt, choices: [] }),
    personas: { get: async () => persona }, personaFits, applyPersona,
    stageQwenReferences: async (names) => { staged.push(names); if (stageError) throw new Error(stageError); return names.map((name) => `staged-${name}`); },
    COVER_DIR: "covers", IMAGE_DIR: "images",
    pendingImagePrompt: new Map(), pendingImageActor: new Map(), pendingImageWild: new Map(),
    prov: { actorFrom: () => "agent:test" }, resolveRepeat: () => ({}), imageDupGuard: { remember() {} },
    art: { request: (shot) => { queued.push(shot); return { id: "job" }; }, status: () => ({}) }, combinations: () => 1,
  };
  return { ...await run(deps), queued, preflights, staged };
}

test("omitted engine chooses Qwen, keeps its own preset, and refuses unavailable runtime before queueing", async () => {
  const blocked = await request({ prompt: "a lighthouse" }, { ready: false });
  assert.equal(blocked.status, 400); assert.equal(blocked.queued.length, 0);
  assert.deepEqual(blocked.body.missingNodes, ["TextEncodeQwenImage21"]);
  const ok = await request({ prompt: "a lighthouse", seed: 8 });
  assert.equal(ok.status, 200);
  const shot = ok.queued[0];
  assert.equal(shot.video.engine, "qwen-image-2.1");
  assert.equal(shot.video.steps, 25, "never inherits FLUX's four steps");
  assert.equal(shot.video.cfg, 1);
  assert.equal(shot.actor, "agent:test");
});

test("reference/alpha settings and persona ordering reach the queue; missing refs do not", async () => {
  const result = await request({ prompt: "Alex in a forest", persona: "Alex", refImages: ["scene.png"], refSizing: "custom", refResolution: 1536, transparent: true, width: 1536, height: 1024, negative: "blur", cfg: 2 }, { persona: { name: "Alex", fragment: "red coat", refImages: ["face.png"] } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.staged[0], ["face.png", "scene.png"]);
  const video = result.queued[0].video;
  assert.deepEqual(video.refImages, ["staged-face.png", "staged-scene.png"]);
  assert.equal(video.refSizing, "custom"); assert.equal(video.refResolution, 1536); assert.equal(video.transparent, true);
  const graph = qwenImageGraph({ ...video, seed: result.queued[0].seed });
  assert.deepEqual(graph[7].inputs, { width: 1536, height: 1024, batch_size: 1 });
  assert.equal(result.preflights.at(-1).refImages.length, 2);
  const missing = await request({ prompt: "x", refImages: ["gone.png"] }, { stageError: "Reference image is missing" });
  assert.equal(missing.status, 400); assert.equal(missing.queued.length, 0);
});

test("invalid native options never reach the queue and Qwen image identities include edit settings", async () => {
  for (const extra of [{ engine: "unknown" }, { dit: "qwen.gguf" }, { negative: "blur" }, { refImages: Array(11).fill("x.png") }, { refImages: "x.png" }, { sampler: "wrong" }, { transparent: "true" }]) {
    const result = await request({ prompt: "x", ...extra });
    assert.equal(result.status, 400); assert.equal(result.queued.length, 0);
  }
  const job = { engine: "qwen-image-2.1", prompt: "x", seed: 1 };
  const base = jobIdentity(job);
  for (const extra of [{ transparent: true }, { refSizing: "custom" }, { refResolution: 2048 }, { dit: "other.safetensors" }]) assert.notEqual(jobIdentity({ ...job, ...extra }), base);
});
