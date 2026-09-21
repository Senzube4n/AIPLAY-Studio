/** Automatic-cover readiness and saved preferences, without a GPU/runtime. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "qwen-cover-"));
process.env.AIPLAY_APPDATA = path.join(temp, "settings");
process.env.AIPLAY_OUTPUT = path.join(temp, "output");
process.env.AIPLAY_RIG = path.join(temp, "rig");
process.env.AIPLAY_MODELS_DIR = path.join(temp, "models");
const { config } = await import("./config.js");
const { ArtRunner } = await import("./art.js");
const { engine } = await import("./engine/client.js");
const { QWEN_IMAGE_FILES, qwenImageGraph, QWEN_IMAGE_PRESET } = await import("./qwen-image.js");
const { applyPersona, personaFits } = await import("./personas.js");
const original = { run: engine.run, socket: engine.socket };
const submitted = [], preflights = [];
const savedGraphs = new Map();
let readiness = { ready: true };
engine.socket = () => Object.assign(new EventEmitter(), { readyState: 1, close() {} });
engine.run = async ({ graph }) => {
  submitted.push(graph);
  const cacheKey = JSON.stringify(graph);
  // Model ComfyUI's SaveImage cache: repeating an identical graph returns its
  // old filename without recreating files the application has already moved.
  if (savedGraphs.has(cacheKey)) return savedGraphs.get(cacheKey);
  const file = `fake-full-${submitted.length}.png`;
  const thumb = `fake-thumb-${submitted.length}.png`;
  await mkdir(config.outputDir, { recursive: true });
  await writeFile(path.join(config.outputDir, file), "CPU fixture output");
  await writeFile(path.join(config.outputDir, thumb), "CPU fixture thumbnail");
  const result = { status: "completed", runId: "fixture", outputs: [
    { node: "13", file }, { node: "15", file: thumb },
  ] };
  savedGraphs.set(cacheKey, result);
  return result;
};
const comfy = { ready: true };
const runner = new ArtRunner(comfy, { current: null, queue: [] }, {
  qwenStatus: async ({ options }) => { preflights.push(options); return readiness; },
});

after(async () => {
  for (const item of [...runner.queue]) runner.drop(item.file);
  Object.assign(engine, original);
  await rm(temp, { recursive: true, force: true });
});

async function configSnapshot(settings) {
  const dir = await mkdtemp(path.join(temp, "prefs-"));
  if (settings) await writeFile(path.join(dir, "settings.json"), JSON.stringify(settings));
  const source = `import {config,prefsSnapshot} from ${JSON.stringify(new URL("./config.js", import.meta.url).href)}; console.log(JSON.stringify({image:config.image.engine,art:config.art.engine,prefs:prefsSnapshot().art}));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, AIPLAY_APPDATA: dir }, encoding: "utf8", timeout: 10_000,
  }));
}

function cover(file, extra = {}) {
  return new Promise((resolve, reject) => {
    const finish = (type) => (event) => {
      if (event.file !== file) return;
      clearTimeout(timer);
      runner.off("cover", success); runner.off("failed", failure);
      resolve({ type, event });
    };
    const success = finish("cover"), failure = finish("failed");
    const timer = setTimeout(() => {
      runner.off("cover", success); runner.off("failed", failure);
      reject(new Error(`Cover ${file} did not finish`));
    }, 8000);
    runner.on("cover", success); runner.on("failed", failure);
    assert.ok(runner.request({ file, title: file, caption: "blue harbor", ...extra }));
  });
}

test("fresh installs default both image generation and covers to Qwen", async () => {
  const snapshot = await configSnapshot();
  assert.equal(snapshot.image, "qwen-image-2.1");
  assert.equal(snapshot.art, "qwen-image-2.1");
  assert.equal(snapshot.prefs.engine, "qwen-image-2.1");
});

test("saved cover engine and disabled preference survive the fresh default", async () => {
  for (const selected of ["flux2", "ideogram4", "checkpoint"]) {
    const snapshot = await configSnapshot({ prefs: { art: { engine: selected, enabled: false } } });
    assert.equal(snapshot.art, selected);
    assert.equal(snapshot.prefs.engine, selected);
    assert.equal(snapshot.prefs.enabled, false);
    assert.equal(snapshot.image, "qwen-image-2.1");
  }
});

test("offline engine reports deferred work and leaves it cancellable without dispatch", () => {
  comfy.ready = false;
  const item = runner.request({ file: "offline.flac" });
  assert.ok(item);
  const status = runner.status().art;
  assert.equal(status.deferred.reason, "engine");
  assert.match(status.deferred.message, /readiness has not been verified/);
  assert.equal(preflights.length, 0);
  assert.equal(submitted.length, 0);
  assert.deepEqual(runner.drop(item.file), { removed: 1, running: false });
  assert.equal(runner.status().art.deferred, null);
  comfy.ready = true;
});

test("missing Qwen weights finish with an actionable error and no substitute graph", async () => {
  readiness = { ready: false, error: "Missing or incomplete Qwen Image files: qwen_image_2.1_int8_convrot.safetensors. Choose Download in Models when ready." };
  const result = await cover("missing-files.flac");
  assert.equal(result.type, "failed");
  assert.match(result.event.error, /Qwen Image 2.1 is unavailable.*Choose Download in Models/);
  assert.equal(submitted.length, 0);
  assert.equal(runner.queue.length, 0);
  assert.match(runner.status().art.lastError, /missing-files/);
  assert.match(runner.status().art.recent[0].error, /Missing or incomplete/);
  assert.equal(runner.stats?.cover, undefined, "a readiness failure is not a speed measurement");
});

test("unsupported Qwen runtime records a failed cover instead of an unusable engine job", async () => {
  readiness = { ready: false, error: "ComfyUI is missing TextEncodeQwenImage21. Qwen Image 2.1 needs a compatible runtime; this check does not update it." };
  const result = await cover("old-runtime.flac");
  assert.equal(result.type, "failed");
  assert.match(result.event.error, /TextEncodeQwenImage21/);
  assert.equal(result.event.runId, null);
  assert.equal(submitted.length, 0);
  assert.equal(runner.current, null);
});

test("ready automatic cover dispatches Qwen with its own 25-step preset and provenance", async () => {
  readiness = { ready: true };
  const result = await cover("ready.flac");
  assert.equal(result.type, "cover");
  assert.equal(result.event.engine, "qwen-image-2.1");
  assert.deepEqual(result.event.covers, ["ready.png"]);
  const graph = submitted.at(-1);
  assert.equal(graph[1].inputs.unet_name, QWEN_IMAGE_FILES.dit);
  assert.equal(graph[4].class_type, "TextEncodeQwenImage21");
  assert.equal(graph[8].inputs.steps, 25);
  assert.equal(graph[8].inputs.cfg, 1);
  assert.equal(graph[8].inputs.sampler_name, "euler");
  assert.equal(graph[8].inputs.scheduler, "simple");
  assert.equal(runner.stats.cover.n, 1);
});

test("an explicit alternate engine bypasses Qwen readiness and preserves its graph", async () => {
  const checks = preflights.length;
  readiness = { ready: false, error: "Qwen missing" };
  const result = await cover("explicit-flux.flac", { video: { engine: "flux2" } });
  assert.equal(result.type, "cover");
  assert.equal(result.event.engine, "flux2");
  assert.equal(preflights.length, checks);
  assert.equal(Object.values(submitted.at(-1)).some((node) => node.class_type === "TextEncodeQwenImage21"), false);
});

test("Qwen custom native filenames and sampling choices reach both preflight and graph", async () => {
  readiness = { ready: true };
  const options = { engine: "qwen-image-2.1", dit: "custom-21.safetensors", encoder: "custom-encoder.safetensors", vae: "custom-vae.safetensors", steps: 30, cfg: 2, sampler: "euler", scheduler: "simple" };
  const result = await cover("custom-native.flac", { video: options });
  assert.equal(result.type, "cover");
  for (const key of ["dit", "encoder", "vae", "steps", "cfg", "sampler", "scheduler"]) assert.equal(preflights.at(-1)[key], options[key]);
  const graph = submitted.at(-1);
  assert.equal(graph[1].inputs.unet_name, options.dit);
  assert.equal(graph[2].inputs.clip_name, options.encoder);
  assert.equal(graph[3].inputs.vae_name, options.vae);
  assert.equal(graph[8].inputs.steps, 30);
  assert.equal(graph[8].inputs.cfg, 2);
});

test("API response, real queue, sampler and saved image provenance keep the same seed across new IDs", async () => {
  readiness = { ready: true };
  // Exercise the production route and completion handler with the real runner.
  // Only runtime/filesystem outputs are fixtures; a stub queue would miss the
  // original bug because request() is exactly where the seed was rehashed.
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const routeStart = source.indexOf('if (p === "/api/image" && req.method === "POST")');
  const routeEnd = source.indexOf('if (p === "/api/', routeStart + 20);
  const eventStart = source.indexOf('art.on("cover", ({ file, covers, seed, imageOptions, durationMs, engine, checkpoint, runId })');
  const eventEnd = source.indexOf('/* A stage that failed', eventStart);
  assert.ok(routeStart > 0 && routeEnd > routeStart && eventStart > 0 && eventEnd > eventStart);
  const deps = {
    p: "/api/image", req: { method: "POST" }, res: {}, config, path,
    json: (_, status, body) => ({ status, body }),
    qwenImageGraph, QWEN_IMAGE_PRESET, QWEN_IMAGE_ENGINE: "qwen-image-2.1",
    qwenImageStatus: async () => ({ ready: true }),
    hasWildcards: () => false, expand: (prompt) => ({ prompt, choices: [] }),
    personas: { get: async () => null }, applyPersona, personaFits,
    stageQwenReferences: async (names) => names,
    COVER_DIR: path.join(config.outputDir, "covers"), IMAGE_DIR: path.join(config.outputDir, "images"),
    pendingImagePrompt: new Map(), pendingImageActor: new Map(), pendingImageWild: new Map(),
    prov: { actorFrom: () => "agent:seed-test", sha256hex: () => "fixture-prompt-hash" },
    resolveRepeat: () => ({}), imageDupGuard: { remember() {} }, combinations: () => 1,
    art: runner, imageMeta: new Map(), ledger: [],
    saveImageStore() {}, push() {}, jobs: { snapshot: () => ({}) },
  };
  deps.provNote = (_, event) => deps.ledger.push(event);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const bindings = `const { ${Object.keys(deps).join(", ")}, readBody }=deps;`;
  const runRoute = new AsyncFunction("deps", `${bindings} ${source.slice(routeStart, routeEnd)}`);
  new Function("deps", `${bindings} ${source.slice(eventStart, eventEnd)}`)(deps);
  const ids = new Set();
  const replayGraphs = [];
  for (const requested of [210921, 0, 4294967301, 210921]) {
    const result = await runRoute({ ...deps, readBody: async () => ({ action: "create", prompt: "a harbor", seed: requested, dedupe: false }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.seed, requested);
    assert.equal(ids.has(result.body.id), false);
    ids.add(result.body.id);
    const file = `image:${result.body.id}`;
    const queued = runner.queue.find((job) => job.file === file);
    assert.equal(queued.seed, requested);
    const event = await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); runner.off("cover", onCover); runner.off("failed", onFailure); };
      const onCover = (value) => { if (value.file === file) { cleanup(); resolve(value); } };
      const onFailure = (value) => { if (value.file === file) { cleanup(); reject(new Error(value.error)); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Image did not finish")); }, 8000);
      runner.on("cover", onCover); runner.on("failed", onFailure);
    });
    assert.equal(submitted.at(-1)[8].inputs.seed, requested);
    if (requested === 210921) replayGraphs.push(structuredClone(submitted.at(-1)));
    assert.equal(preflights.at(-1).seed, requested);
    assert.equal(event.seed, requested);
    assert.equal(deps.imageMeta.get(event.covers[0]).seed, requested);
    assert.equal(deps.ledger.at(-1).data.seed, requested);
    assert.equal(deps.ledger.at(-1).data.runId, "fixture");
    assert.equal(deps.ledger.at(-1).actor, "agent:seed-test");
    assert.equal(event.covers[0], `${result.body.id}.png`);
    assert.equal(await readFile(path.join(config.outputDir, "images", event.covers[0]), "utf8"), "CPU fixture output");
  }
  assert.equal(replayGraphs.length, 2);
  for (const id of ["13", "15"]) {
    assert.equal(replayGraphs[0][id].class_type, "SaveImage");
    assert.notEqual(replayGraphs[0][id].inputs.filename_prefix, replayGraphs[1][id].inputs.filename_prefix);
    delete replayGraphs[0][id].inputs.filename_prefix;
    delete replayGraphs[1][id].inputs.filename_prefix;
  }
  assert.deepEqual(replayGraphs[0], replayGraphs[1], "replay changes only output prefixes, never sampling/conditioning");
});

test("song covers retain stable filename mixing while video and SFX preserve explicit seeds", () => {
  runner.paused = true;
  const a = runner.request({ file: "mix-a.flac", seed: 210921 });
  const b = runner.request({ file: "mix-b.flac", seed: 210921 });
  assert.notEqual(a.seed, 210921);
  assert.notEqual(a.seed, b.seed);
  runner.drop(a.file); runner.drop(b.file);
  const same = runner.request({ file: "mix-a.flac", seed: 210921 });
  assert.equal(same.seed, a.seed);
  const video = runner.request({ kind: "video", file: "clip:seed-fixture", seed: 0 });
  const sfx = runner.request({ kind: "sfx", file: "sfx:seed-fixture", seed: 4294967301 });
  assert.equal(video.seed, 0);
  assert.equal(sfx.seed, 4294967301);
  for (const item of [same, video, sfx]) runner.drop(item.file);
  runner.paused = false;
});
