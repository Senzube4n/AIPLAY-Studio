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
const { QWEN_IMAGE_FILES, qwenImageGraph, QWEN_IMAGE_PRESET, QWEN_DRAFT, qwenImageSettings } = await import("./qwen-image.js");
const { applyPersona, personaFits } = await import("./personas.js");
const { safetyRefusal } = await import("./safety/refusal.js");
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
  const source = `import {config,prefsSnapshot,prefChosen} from ${JSON.stringify(new URL("./config.js", import.meta.url).href)}; console.log(JSON.stringify({image:config.image.engine,art:config.art.engine,prefs:prefsSnapshot().art,chosen:prefChosen("art","engine")}));`;
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

/* DEFAULTS FOLLOW THE DISK (UI_PLAN A1, INSTALLER_PLAN S5). A fresh install's
 * picture and cover engine is worked out from what is on this PC when it is
 * read (server/fit.js defaultFor, applied by index.js), and never written into
 * settings.json. config.js alone holds only the last resort, unchosen. What the
 * machine picks on each disk is server/defaults_test.js's. */
test("a fresh install saves no cover engine: config.js holds only the unchosen last resort", async () => {
  const snapshot = await configSnapshot();
  assert.equal(snapshot.image, "qwen-image-2.1", "the literal is the last resort");
  assert.equal(snapshot.art, "qwen-image-2.1");
  assert.equal(snapshot.chosen, false, "nobody chose it");
  assert.equal(snapshot.prefs?.engine, undefined, "so settings.json is not given one");
});

test("saved cover engine and disabled preference survive the fresh default", async () => {
  for (const selected of ["flux2", "ideogram4", "checkpoint"]) {
    const snapshot = await configSnapshot({ prefs: { art: { engine: selected, enabled: false } } });
    assert.equal(snapshot.art, selected);
    assert.equal(snapshot.prefs.engine, selected);
    assert.equal(snapshot.prefs.enabled, false);
    assert.equal(snapshot.chosen, true, "a saved engine is the person's, and always wins");
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
    qwenImageGraph, QWEN_IMAGE_PRESET, QWEN_DRAFT, qwenImageSettings, QWEN_IMAGE_ENGINE: "qwen-image-2.1",
    qwenImageStatus: async () => ({ ready: true }),
    hasWildcards: () => false, expand: (prompt) => ({ prompt, choices: [] }),
    personas: { get: async () => null }, applyPersona, personaFits,
    stageQwenReferences: async (names) => names,
    imageEditor: { flattenReferences: async (references) => references.map((row) => row.name) },
    COVER_DIR: path.join(config.outputDir, "covers"), IMAGE_DIR: path.join(config.outputDir, "images"),
    pendingImagePrompt: new Map(), pendingImageActor: new Map(), pendingImageWild: new Map(),
    /* The fourth side-map. This lane SLICES the cover handler out of index.js and
     * evals it against exactly these names, so a module-scope name the handler
     * starts using and this object does not list is a ReferenceError at render
     * time - which is how `private` announced itself here rather than in the
     * feature it belongs to. */
    pendingImagePrivate: new Map(),
    prov: { actorFrom: () => "agent:seed-test", sha256hex: () => "fixture-prompt-hash" },
    resolveRepeat: () => ({}), imageDupGuard: { remember() {} }, combinations: () => 1,
    art: runner, imageMeta: new Map(), ledger: [],
    saveImageStore() {}, push() {}, jobs: { snapshot: () => ({}) },
    /* The minors rule (server/safety): the REAL check, and no library lineage. */
    safetyRefusal, lineage: () => ({ texts: [], flags: [] }),
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

/* FAST DRAFT through the real runner and the production route and completion
 * handler: the LoRA graph is what reaches the engine, readiness is asked for a
 * draft, the picture's row and the ledger line both say draft with the LoRA,
 * and the runner remembers what the next Qwen render follows (the estimate). */
test("a Fast draft renders the LoRA graph and its picture and ledger line say so", async () => {
  readiness = { ready: true };
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const routeStart = source.indexOf('if (p === "/api/image" && req.method === "POST")');
  const routeEnd = source.indexOf('if (p === "/api/', routeStart + 20);
  const eventStart = source.indexOf('art.on("cover", ({ file, covers, seed, imageOptions, durationMs, engine, checkpoint, runId })');
  const eventEnd = source.indexOf('/* A stage that failed', eventStart);
  const deps = {
    p: "/api/image", req: { method: "POST" }, res: {}, config, path,
    json: (_, status, body) => ({ status, body }),
    qwenImageGraph, QWEN_IMAGE_PRESET, QWEN_DRAFT, qwenImageSettings, QWEN_IMAGE_ENGINE: "qwen-image-2.1",
    qwenImageStatus: async () => ({ ready: true }),
    hasWildcards: () => false, expand: (prompt) => ({ prompt, choices: [] }),
    personas: { get: async () => null }, applyPersona, personaFits,
    stageQwenReferences: async (names) => names,
    imageEditor: { flattenReferences: async (references) => references.map((row) => row.name) },
    COVER_DIR: path.join(config.outputDir, "covers"), IMAGE_DIR: path.join(config.outputDir, "images"),
    pendingImagePrompt: new Map(), pendingImageActor: new Map(), pendingImageWild: new Map(), pendingImagePrivate: new Map(),
    prov: { actorFrom: () => "agent:draft-test", sha256hex: () => "fixture-prompt-hash" },
    resolveRepeat: () => ({}), imageDupGuard: { remember() {} }, combinations: () => 1,
    art: runner, imageMeta: new Map(), ledger: [],
    saveImageStore() {}, push() {}, jobs: { snapshot: () => ({}) },
    safetyRefusal, lineage: () => ({ texts: [], flags: [] }),
  };
  deps.provNote = (_, event) => deps.ledger.push(event);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const bindings = `const { ${Object.keys(deps).join(", ")}, readBody }=deps;`;
  const runRoute = new AsyncFunction("deps", `${bindings} ${source.slice(routeStart, routeEnd)}`);
  const onCoverHandler = new Function("deps", `${bindings} ${source.slice(eventStart, eventEnd)}`);
  onCoverHandler(deps);
  const renderOf = async (body) => {
    const result = await runRoute({ ...deps, readBody: async () => ({ action: "create", dedupe: false, ...body }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const file = `image:${result.body.id}`;
    const event = await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); runner.off("cover", onCover); runner.off("failed", onFailure); };
      const onCover = (value) => { if (value.file === file) { cleanup(); resolve(value); } };
      const onFailure = (value) => { if (value.file === file) { cleanup(); reject(new Error(value.error)); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Image did not finish")); }, 8000);
      runner.on("cover", onCover); runner.on("failed", onFailure);
    });
    return { result, event, graph: submitted.at(-1), row: deps.imageMeta.get(event.covers[0]), line: deps.ledger.at(-1) };
  };

  const draft = await renderOf({ prompt: "board 3: the harbor at night", seed: 77, draft: true });
  assert.equal(draft.result.body.draft, true);
  assert.equal(preflights.at(-1).draft, true, "the runner's own readiness check is a draft check");
  assert.equal(draft.graph[5].class_type, "LoraLoaderModelOnly");
  assert.equal(draft.graph[5].inputs.lora_name, QWEN_DRAFT.lora);
  assert.equal(draft.graph[8].class_type, "SamplerCustomAdvanced");
  assert.equal(draft.graph[82].inputs.noise_seed, 77, "the recorded seed is the one that sampled");
  assert.equal(draft.row.draft, true);
  assert.equal(draft.row.lora, QWEN_DRAFT.lora);
  assert.equal(draft.row.loraStrength, 1);
  assert.equal(draft.row.steps, 5);
  assert.equal(draft.row.cfg, 1);
  assert.equal(draft.row.sigmas, "1.0, 0.9334, 0.8572, 0.6668, 0.4001, 0");
  assert.equal(draft.line.data.model, "qwen-image-2.1", "still Qwen Image 2.1: the rights follow the model");
  assert.equal(draft.line.data.draft, true);
  assert.equal(draft.line.data.lora, QWEN_DRAFT.lora);
  assert.deepEqual(runner.lastQwen && { draft: runner.lastQwen.draft, key: typeof runner.lastQwen.key }, { draft: true, key: "string" });

  const full = await renderOf({ prompt: "board 3: the harbor at night", seed: 78 });
  assert.equal(full.graph[8].class_type, "KSampler");
  assert.ok(!("draft" in full.row), "a full render's row has no draft field");
  assert.ok(!("lora" in full.row));
  assert.ok(!("draft" in full.line.data), "nor its ledger line");
  assert.equal(runner.lastQwen.draft, false);
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

/* THE WAITER JUDGES ITS OWN JOB. mcp.js's waitForArt waited for the whole queue
 * to empty and then threw `art.lastError`: the queue's LAST failure, which only
 * the constructor ever clears. One failed render made every later make_image /
 * make_clip / restyle_clip / extend_clip report failure and lose its file name
 * until a restart. Run as the real shared waiter (server/art-wait.js, which
 * mcp.js and the chat both call), against this real runner's status, with real
 * failing jobs and then a real succeeding one. */
test("an MCP render queued after a failed one is reported as the success it was", async () => {
  const { waitForArtJob, emptyResultNote } = await import("./art-wait.js");
  let shape = (st) => st;                         // what the "server" answers
  let statusOf = () => runner.status();
  const api = async (method, endpoint) => {
    assert.equal(`${method} ${endpoint}`, "GET /api/status");
    return shape(statusOf());
  };
  // The runner keeps real time (it drains 1.2 s after a request); the waiter polls fast.
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 20));
  let settledWith = null;                         // the reading the last wait resolved with
  const verdict = async (id) => {
    settledWith = null;
    try { settledWith = await waitForArtJob({ api, sleep, timeoutMs: 8000, kind: "image", jobId: id }); return "ok"; }
    catch (err) { return err.message; }
  };

  readiness = { ready: false, error: "Missing or incomplete Qwen Image files: waiter-fixture.safetensors." };
  const bad = runner.request({ file: "waiter-bad.flac", title: "waiter-bad", caption: "a red kite" });
  assert.match(await verdict(bad.id), /^waiter-bad: .*waiter-fixture\.safetensors/, "a failed job still fails, in its own words");

  /* ITS OWN WORDS, WHOLE. A finished row's error is cut to 200 characters on
   * the wire; the real every-file-missing message is longer and lost its
   * instruction mid-word ("Choose Downloa"). The file names are the real ones. */
  const every = Object.values(QWEN_IMAGE_FILES).join(", ");
  readiness = { ready: false, error: `Missing or incomplete Qwen Image files: ${every}. Choose Download in Models when ready.` };
  const long = runner.request({ file: "waiter-long.flac", title: "waiter-long", caption: "a grey kite" });
  const longSaid = await verdict(long.id);
  assert.ok(runner.status().art.recent[0].error.length === 200, "the wire row really is cut, or this case proves nothing");
  assert.ok(longSaid.length > 200 + "waiter-long: ".length, `the whole message, not the cut row: ${longSaid}`);
  assert.match(longSaid, /^waiter-long: .*Choose Download in Models when ready\.$/);

  readiness = { ready: true };
  const good = runner.request({ file: "waiter-good.flac", title: "waiter-good", caption: "a blue kite" });
  assert.equal(await verdict(good.id), "ok", "its own render succeeded; the earlier failure is not its verdict");
  /* A SUCCESS CLEARS IT (the 2026-09-23 audit found lastError sticky until a
   * restart, so Settings and studio_status kept a failure the next render had
   * put right). Each finished row still carries its own error. */
  assert.equal(runner.status().art.lastError, null, "a success clears the queue's last failure");
  assert.match(runner.status().art.recent.find((row) => row.title === "waiter-long")?.error || "", /Missing or incomplete/,
    "the failed row keeps its own error");
  assert.equal(runner.status().art.recent[0].id, good.id, "finished rows carry the id the routes return");
  /* ...AND ITS WHOLE WORDS SURVIVE THE CLEARING. A waiter that polls after a
   * quick success can no longer borrow the uncut text from lastError, so the
   * newest rows carry it themselves (fullError) and ownFailure reads it first. */
  const { ownFailure } = await import("./art-wait.js");
  const longRow = runner.status().art.recent.find((row) => row.title === "waiter-long");
  assert.match(longRow?.fullError || "", /Choose Download in Models when ready\.$/, "the newest failed row carries its uncut error");
  assert.match(ownFailure(longRow, runner.status().art.lastError, "image"), /^waiter-long: .*Choose Download in Models when ready\.$/,
    "a failure followed by a success still reads whole");
  assert.equal(runner.status().art.recent.find((row) => row.title === "waiter-bad")?.fullError, undefined, "a short error needs no second copy");

  /* THE EMPTY-RESULT NOTE IS ABOUT ITS OWN JOB. The four MCP render tools said
   * "Nothing new appeared — check studio_status for the last error" for an
   * empty result. Their own failure has already thrown by then (above), so a
   * followed job that reaches the note finished CLEAN; the last error on the
   * queue is waiter-long's, a stranger's, and the old note sent the agent to it. */
  const goodRow = settledWith.art.recent.find((row) => row.id === good.id);
  const cleanNote = emptyResultNote(settledWith, good.id, "list_images");
  assert.match(cleanNote, /^The job finished without an error of its own, but no new file appeared/);
  assert.ok(goodRow.covers?.length && cleanNote.includes(goodRow.covers[0]), `names the file its own row carries: ${cleanNote}`);
  assert.match(cleanNote, /See list_images for what is there\.$/);
  assert.doesNotMatch(cleanNote, /waiter-long|last error/, "never points at the queue's last failure");

  /* THE RUNNING ROW CARRIES THE ID TOO, and `current` is where a real render
   * spends its minutes. Every case above is over within a poll or two of
   * starting, so none of them showed the waiter a job while it RAN: with `id`
   * dropped from the running row in art.js status() they all stayed green,
   * while a real make_clip was told after two polls (about 4 s) that its
   * still-rendering job "was dropped from the queue or Studio restarted". So
   * this job is HELD in `current` (its Qwen preflight waits on a gate) while
   * the waiter polls, then released and judged. */
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const ungated = runner.qwenStatus;
  runner.qwenStatus = async (arg) => { await gate; return ungated(arg); };
  try {
    const held = runner.request({ file: "waiter-held.flac", title: "waiter-held", caption: "a white kite" });
    let pollsWhileRunning = 0, settled;
    statusOf = () => {
      // Counted off the runner itself, not the wire, so the sabotaged row cannot hide a poll.
      if (runner.current?.id === held.id) pollsWhileRunning++;
      return runner.status();
    };
    const waiting = verdict(held.id).then((said) => { settled = said; return said; });
    const until = Date.now() + 6000;
    while (pollsWhileRunning < 3 && settled === undefined && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(settled, undefined, `the waiter gave up on a job that was still rendering: ${settled}`);
    assert.ok(pollsWhileRunning >= 3, `the waiter polled ${pollsWhileRunning} times while the job ran, not 3`);
    assert.equal(runner.status().art.current?.id, held.id, "the running row carries the id the route returned");
    release();
    assert.equal(await waiting, "ok", "released, it is judged by its own outcome, not the queue's last failure");
    assert.equal(runner.status().art.lastError, null, "...and its success leaves no stale failure behind");
  } finally {
    release();
    runner.qwenStatus = ungated;
    statusOf = () => runner.status();
  }

  /* A Studio older than the ids (an MCP process newer than the server it talks
   * to): no `jobIds`, no `id` anywhere. The queue emptying is the only signal
   * left, and the sticky lastError must still not become this job's verdict. */
  shape = (st) => {
    const bare = ({ id, ...row }) => row;
    const { jobIds, ...art } = st.art;
    return { ...st, art: { ...art, current: art.current && bare(art.current), items: art.items.map(bare), recent: art.recent.map(bare) } };
  };
  const legacy = runner.request({ file: "waiter-legacy.flac", title: "waiter-legacy", caption: "a green kite" });
  assert.equal(await verdict(legacy.id), "ok", "no ids to follow is no licence to borrow lastError");
  /* Nothing about ITS outcome was read here, so the note must not claim a clean
   * finish, and still must not quote the queue's last failure as this job's. */
  const blindNote = emptyResultNote(settledWith, legacy.id, "list_clips");
  assert.match(blindNote, /could not follow its own job/);
  assert.doesNotMatch(blindNote, /finished without an error|waiter-long/);
  assert.match(blindNote, /see list_clips for what is there\.$/);

  // An id the server has never heard of, while it does report ids: said, not waited out.
  shape = (st) => st;
  assert.match(await verdict("gone1234"), /not running, not queued and not among the finished jobs/);

  /* A STUDIO JUST RESTARTED: nothing running, nothing queued, nothing finished.
   * That status has no rows to carry an id, and inferring "no ids" from it
   * returned success at once for a job the restart had lost. A fresh runner's
   * real status says `jobIds` itself. */
  const fresh = new ArtRunner(comfy, { current: null, queue: [] }, { qwenStatus: async () => readiness });
  statusOf = () => fresh.status();
  assert.equal(fresh.status().art.jobIds, true, "the runner says its rows carry ids");
  assert.match(await verdict(good.id), /not running, not queued and not among the finished jobs/,
    "an empty queue after a restart is not a success");
});

/* THE OVERNIGHT DISPATCHER, AGAINST THIS REAL RUNNER. overnight-image_test.js
 * drives renderMediaForBatch with a stub art, and a stub is how its failure
 * check survived: it read art.status().queued and .current at the top level,
 * which this runner's status() nests under .art, so it never fired and a
 * failed picture held the night for the three-hour ceiling. Had it fired, its
 * verdict was lastError, the queue's last failure, whoever's. Here the runner
 * is real: its own "failed" event, its real status shape, its real drop().
 * A stranger fails right behind the step, so lastError ends up the stranger's. */
test("an overnight step fails in its own words, and a dropped one is said, against the real runner", async () => {
  const { jobStanding, ownFailure } = await import("./art-wait.js");
  const source = (await readFile(new URL("./index.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("async function renderMediaForBatch(");
  const end = source.indexOf("const batch = new BatchRunner", start);
  assert.ok(start > 0 && end > start, "the dispatcher is where this lane slices it");
  const queued = [];
  // What /api/image queues: kind "cover" on a fresh image:<id> handle, asked for.
  const fetch = async (_, options) => ({ json: async () => {
    const body = JSON.parse(options.body);
    const id = `overnight-${queued.length + 1}`;
    const job = runner.request({ file: `image:${id}`, title: id, caption: body.prompt, asked: true, seed: 111 });
    queued.push({ id, job });
    return { id, job: job && { id: job.id } };
  } });
  const dispatch = new Function("config", "art", "fetch", "jobStanding", "ownFailure",
    `${source.slice(start, end)}; return renderMediaForBatch;`)({ uiPort: 4173 }, runner, fetch, jobStanding, ownFailure);
  // A verdict or a deadline, and the deadline's timer never outlives the verdict.
  const judged = (step, ms, what) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(`${what} was not judged within ${ms} ms`), ms);
    step.then((files) => `resolved ${JSON.stringify(files)}`, (err) => err.message)
      .then((said) => { clearTimeout(timer); resolve(said); });
  });
  const until = async (cond) => {
    for (const stop = Date.now() + 6000; !cond() && Date.now() < stop;) await new Promise((r) => setTimeout(r, 10));
  };
  const listeners = () => ["cover", "failed", "update"].map((e) => runner.listenerCount(e)).join("/");
  const baseline = listeners();
  const ungated = runner.qwenStatus;
  runner.qwenStatus = async ({ options }) => ({ ready: false,
    error: options.seed === 222 ? "the stranger's failure" : "this step's own failure" });
  try {
    const step = dispatch("image", { prompt: "a paper lantern" }, 0, "user");
    await until(() => queued.length === 1);
    runner.request({ file: "image:stranger", title: "stranger", caption: "a stone", asked: true, seed: 222 });
    const said = await judged(step, 8000, "the failed step");
    assert.match(said, /this step's own failure/, "its own words, as soon as it failed");
    assert.doesNotMatch(said, /stranger/);
    await until(() => runner.status().art.recent.some((row) => row.title === "stranger"));
    assert.match(runner.status().art.lastError, /the stranger's failure/,
      "the queue's last failure is the stranger's: what the old check would have quoted");
    assert.equal(listeners(), baseline, "the step's listeners are gone");

    runner.paused = true;                          // held in the queue, then dropped
    const dropped = dispatch("image", { prompt: "a paper boat" }, 0, "user");
    await until(() => queued.length === 2);
    assert.equal(runner.drop(`image:${queued[1].id}`).removed, 1);
    assert.match(await judged(dropped, 3000, "the dropped step"),
      /image job \S+ is no longer queued, running or finished: it was dropped from the queue/);
    assert.equal(listeners(), baseline, "...and so are the dropped step's");
  } finally {
    runner.paused = false;
    runner.qwenStatus = ungated;
  }
});

/* ALL FOUR TOOLS FOLLOW THEIR OWN JOB. Only extend_clip was pinned (by
 * clip_extend_test.js); dropping `r.job?.id` from make_image, make_clip or
 * restyle_clip sent it back to the id-less branch, where its own failure came
 * back as a success with an empty list, and every lane stayed green. */
test("every art wait in mcp.js passes the job id the route returned", async () => {
  const src = (await readFile(new URL("./mcp.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const calls = src.match(/await waitForArt\(/g) || [];
  const withId = src.match(/await waitForArt\([^;]*, r\.job\?\.id\);/g) || [];
  assert.equal(calls.length, 4, "make_image, make_clip, restyle_clip and extend_clip");
  assert.equal(withId.length, calls.length, "each one on its own job");
  /* ...and each one's empty result speaks about THAT job, from the reading its
   * own wait settled on, pointing at the listing that shows the files. The old
   * note sent the agent to the queue's last error, which is a stranger's once
   * the wait has thrown this job's own failure (see the waiter test above). */
  assert.doesNotMatch(src, /check studio_status for the last error/, "the old note is gone from all four");
  assert.equal((src.match(/const settled = await waitForArt\(/g) || []).length, 4, "each wait's reading is kept");
  const notes = src.match(/emptyResultNote\(settled, r\.job\?\.id, "list_(images|clips)"\)/g) || [];
  assert.equal(notes.length, 4, "each empty result is its own job's note");
  assert.equal(notes.filter((n) => n.includes("list_images")).length, 1, "make_image points at list_images, the three clip tools at list_clips");
  assert.match(src, /import \{ waitForArtJob, emptyResultNote \} from "\.\/art-wait\.js";/);
  assert.match(src, /async function waitForArt\(timeoutMs, kind, jobId\) \{\n\s+return waitForArtJob\(\{ api, sleep, timeoutMs, kind, jobId \}\);/,
    "and the MCP waiter is the shared one, not a copy");
});
