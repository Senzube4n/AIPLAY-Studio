import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { cleanMediaItem } from "./batch.js";
import { TOOLS } from "./mcp.js";
import { jobStanding, ownFailure } from "./art-wait.js";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const uiStart = app.indexOf("function ovImageIdea(prompt) {");
const uiEnd = app.indexOf("/* Take what is ON", uiStart);
assert.ok(uiStart > 0 && uiEnd > uiStart);
const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const dispatchStart = index.indexOf("async function renderMediaForBatch(");
const dispatchEnd = index.indexOf("const batch = new BatchRunner", dispatchStart);
assert.ok(dispatchStart > 0 && dispatchEnd > dispatchStart);

function imageForm(engine = "qwen-image-2.1", effective = engine, { draft } = {}) {
  const fields = {
    imgEngine: engine, imgCkpt: "chosen.safetensors", imgSize: "custom", imgW: "4096", imgH: "1024",
    imgSteps: "25", imgCount: "2", imgPersona: "Lead", imgCfg: "2", imgNeg: "blur",
    imgRefSizing: "custom", imgTransparent: "", imgDitKind: effective, imgEncoder: "encoder.safetensors",
    imgVae: "vae.safetensors", imgSampler: "dpmpp_2m", imgSched: "karras", imgClipSkip: "2",
  };
  const refs = [{ name: "first.png" }, { name: "second.webp" }];
  const loras = [{ name: "style.safetensors", strength: 0.8 }];
  const context = vm.createContext({
    $: (id) => ({ value: fields[id] || "", checked: id === "imgTransparent", hidden: false }),
    imgEffectiveEngine: () => effective, imgRefs: refs, imgLoraStack: loras,
    /* The Fast draft chip, only when a test puts it on the page: the idea
     * reads it typeof-guarded, so a harness without it sends no draft. */
    ...(draft === undefined ? {} : { imgDraftOn: () => draft }),
  });
  vm.runInContext(`${app.slice(uiStart, uiEnd)}; globalThis.idea = ovImageIdea('a {red|blue} coat');`, context);
  return { idea: JSON.parse(JSON.stringify(context.idea)), refs, loras };
}

/* THE RUNNER'S REAL STATUS SHAPE: everything under `.art`, as art.js
 * status() returns it. This stub used to answer { queued, current } at the top
 * level, the same wrong shape the dispatcher's failure check read, so the lane
 * agreed with a check that could never fire (qwen-cover_test.js drives the
 * dispatcher against a real runner for that). */
const artStatus = (art = {}) => ({ art: { jobIds: true, queued: 0, current: null, items: [], recent: [], lastError: null, ...art } });

/* The dispatcher, sliced out of index.js and run against exactly these names;
 * `jobStanding` and `ownFailure` are the real ones from art-wait.js. */
const dispatcherWith = (art, fetch) => new Function("config", "art", "fetch", "jobStanding", "ownFailure",
  `${index.slice(dispatchStart, dispatchEnd)}; return renderMediaForBatch;`)({ uiPort: 4173 }, art, fetch, jobStanding, ownFailure);

async function dispatch(item, { error } = {}) {
  const art = new EventEmitter();
  art.status = () => artStatus();
  let request;
  const fetch = async (url, options) => ({ json: async () => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    if (error) return { error };
    setImmediate(() => art.emit("cover", { file: "image:test", covers: ["result.png"] }));
    return { id: "test" };
  } });
  const fn = dispatcherWith(art, fetch);
  const files = await fn("image", item, 0, "agent:overnight-test");
  return { request, files, art };
}

test("Qwen form -> persisted whitelist -> real overnight dispatch retains ordered refs and editing settings", async () => {
  const { idea } = imageForm();
  const item = cleanMediaItem({ ...idea, ignored: "cannot reach route" }, "image");
  const { request, files, art } = await dispatch(item);
  assert.deepEqual(request.body, {
    action: "create", prompt: "a {red|blue} coat", engine: "qwen-image-2.1", negative: "blur",
    width: 4096, height: 1024, steps: 25, cfg: 2, count: 2,
    persona: "Lead", refImages: ["first.png", "second.webp"], refSizing: "custom", refResolution: 1024,
    transparent: true, sampler: "euler", scheduler: "simple",
  });
  assert.equal(request.headers["x-aiplay-actor"], "agent:overnight-test");
  assert.equal(request.url, "http://127.0.0.1:4173/api/image");
  assert.deepEqual(files, ["result.png"]);
  assert.equal(art.listenerCount("cover"), 0);
  assert.equal(Object.hasOwn(request.body, "seed"), false, "every take still rolls its own seed");
});

test("picked native Qwen companions survive, while ordinary checkpoint LoRAs keep independent copies", async () => {
  const chosen = cleanMediaItem(imageForm("checkpoint", "qwen-image-2.1").idea, "image");
  const { request } = await dispatch(chosen);
  assert.equal(request.body.checkpoint, "chosen.safetensors");
  assert.equal(request.body.ditEngine, "qwen-image-2.1");
  assert.equal(request.body.encoder, "encoder.safetensors");
  assert.equal(request.body.vae, "vae.safetensors");
  assert.equal(request.body.sampler, "euler");
  assert.equal(request.body.loras, undefined);
  const source = imageForm("checkpoint").idea;
  const cleaned = cleanMediaItem(source, "image");
  source.loras[0].strength = 3; source.refImages.reverse();
  assert.equal(cleaned.loras[0].strength, 0.8);
  assert.equal(cleaned.refImages[0], "first.png");
  assert.equal(cleaned.clipSkip, 2);
});

test("Qwen's Fast draft chip reaches every take; off, or on another engine, nothing is sent", async () => {
  const on = cleanMediaItem(imageForm("qwen-image-2.1", "qwen-image-2.1", { draft: true }).idea, "image");
  assert.equal(on.draft, true);
  const { request } = await dispatch(on);
  assert.equal(request.body.draft, true, "forwarded to /api/image, which judges it per take");
  assert.equal(imageForm("qwen-image-2.1", "qwen-image-2.1", { draft: false }).idea.draft, undefined);
  assert.equal(imageForm("flux2", "flux2", { draft: true }).idea.draft, undefined, "only a Qwen idea carries it");
  const plain = await dispatch(cleanMediaItem(imageForm().idea, "image"));
  assert.equal(Object.hasOwn(plain.request.body, "draft"), false);
});

test("invalid refs/options are refused before persistence and image readiness errors remain visible", async () => {
  for (const invalid of [{ refImages: Array(11).fill("x.png") }, { refImages: [null] }, { refImages: ["../x.png"] },
    { refImages: "x.png" }, { transparent: "true" }, { draft: "true" }, { refResolution: Infinity }, { loras: [{ name: "x", strength: NaN }] }]) {
    assert.throws(() => cleanMediaItem({ prompt: "x", ...invalid }, "image"));
  }
  await assert.rejects(dispatch(cleanMediaItem({ prompt: "x" }, "image"), { error: "Qwen runtime not ready" }), /Qwen runtime not ready/);
});

/* AN OVERNIGHT STEP IS JUDGED BY ITS OWN JOB. The failure check waited for an
 * idle queue it read at the wrong depth, so a failed picture held the night for
 * three hours; and its verdict was `art.lastError`, the queue's last failure,
 * whoever's. Now: the runner's own "failed" event for this step's file, and
 * the route's job.id through jobStanding() for a job no event will name. */
function ownJobArt(state) {
  const art = new EventEmitter();
  art.status = () => artStatus(state());
  const fetch = async () => ({ json: async () => ({ id: "mine", job: { id: "j-mine" } }) });
  return { art, run: () => dispatcherWith(art, fetch)("image", { prompt: "x" }, 0, "user") };
}
/* What the step said within a short deadline: its error, "resolved <files>",
 * or "pending". A deadline rather than a bare await, because the failure this
 * lane exists for is a step that never settles, and a bare await would hang
 * the lane for the dispatcher's three-hour ceiling instead of failing it. */
const saidBy = (step, ms = 500) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve("pending"), ms);
  step.then((files) => `resolved ${JSON.stringify(files)}`, (err) => err.message)
    .then((said) => { clearTimeout(timer); resolve(said); });
});

test("a failed overnight step carries its OWN error at once, never a stranger's", async () => {
  let state = { current: { id: "j-mine" }, lastError: "someone-else: the stranger's failure" };
  const { art, run } = ownJobArt(() => state);
  const step = run();
  await new Promise((resolve) => setImmediate(resolve));
  art.emit("failed", { file: "image:other", error: "the stranger's failure" });
  art.emit("update");
  assert.equal(await saidBy(step, 50), "pending", "another job's failure is not this step's");
  /* Its own row is finished now, but no "update" follows: only the runner's
   * own "failed" event for this file can settle it, and it must, at once. */
  state = { recent: [{ id: "j-mine", title: "x", error: "its own words, whole" }], lastError: "someone-else: the stranger's failure" };
  art.emit("failed", { file: "image:mine", error: "its own words, whole" });
  assert.equal(await saidBy(step), "its own words, whole");
  for (const e of ["cover", "failed", "update"]) assert.equal(art.listenerCount(e), 0, `${e} listener cleaned up`);
});

test("a step dropped from the queue is said at once, not waited out for three hours", async () => {
  let state = { items: [{ id: "j-mine" }], queued: 1 };
  const { art, run } = ownJobArt(() => state);
  const step = run();
  await new Promise((resolve) => setImmediate(resolve));
  state = {};                                   // drop(): gone from every list, no event for it
  art.emit("update");
  assert.match(await saidBy(step), /^the image job j-mine is no longer queued, running or finished: it was dropped/);
});

test("a step that finished before the dispatcher listened is read from its own row", async () => {
  const done = ownJobArt(() => ({ recent: [{ id: "j-mine", covers: ["mine.png"] }] }));
  assert.equal(await saidBy(done.run()), 'resolved ["mine.png"]');
  const failedEarly = ownJobArt(() => ({
    recent: [{ id: "j-mine", title: "x", error: "cut at two hundred" }],
    lastError: "x: cut at two hundred characters, and here is the rest",
  }));
  assert.equal(await saidBy(failedEarly.run()), "x: cut at two hundred characters, and here is the rest",
    "its own row's error, quoted whole from lastError only because lastError is provably its own");
  const strangerLast = ownJobArt(() => ({
    recent: [{ id: "j-mine", title: "x", error: "its own words" }, { id: "j-other", title: "y", error: "boom" }],
    lastError: "y: boom",
  }));
  assert.equal(await saidBy(strangerLast.run()), "x: its own words", "and never the queue's last failure when that is a stranger's");
});

test("MCP overnight items declare every added render field", () => {
  const schema = TOOLS.find((tool) => tool.name === "overnight_start").inputSchema.properties.items.items.properties;
  for (const key of ["dit", "ditEngine", "encoder", "vae", "quality", "persona", "refImages", "refSizing", "refResolution", "transparent", "draft", "sampler", "scheduler", "clipSkip", "loras"]) assert.ok(schema[key], key);
});
