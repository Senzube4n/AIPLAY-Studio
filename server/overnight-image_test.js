import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { cleanMediaItem } from "./batch.js";
import { TOOLS } from "./mcp.js";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const uiStart = app.indexOf("function ovImageIdea(prompt) {");
const uiEnd = app.indexOf("/* Take what is ON", uiStart);
assert.ok(uiStart > 0 && uiEnd > uiStart);
const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const dispatchStart = index.indexOf("async function renderMediaForBatch(");
const dispatchEnd = index.indexOf("const batch = new BatchRunner", dispatchStart);
assert.ok(dispatchStart > 0 && dispatchEnd > dispatchStart);

function imageForm(engine = "qwen-image-2.1", effective = engine) {
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
  });
  vm.runInContext(`${app.slice(uiStart, uiEnd)}; globalThis.idea = ovImageIdea('a {red|blue} coat');`, context);
  return { idea: JSON.parse(JSON.stringify(context.idea)), refs, loras };
}

async function dispatch(item, { error } = {}) {
  const art = new EventEmitter();
  art.status = () => ({ queued: 0, current: null });
  let request;
  const fetch = async (url, options) => ({ json: async () => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    if (error) return { error };
    setImmediate(() => art.emit("cover", { file: "image:test", covers: ["result.png"] }));
    return { id: "test" };
  } });
  const fn = new Function("config", "art", "fetch", `${index.slice(dispatchStart, dispatchEnd)}; return renderMediaForBatch;`)({ uiPort: 4173 }, art, fetch);
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

test("invalid refs/options are refused before persistence and image readiness errors remain visible", async () => {
  for (const invalid of [{ refImages: Array(11).fill("x.png") }, { refImages: [null] }, { refImages: ["../x.png"] },
    { refImages: "x.png" }, { transparent: "true" }, { refResolution: Infinity }, { loras: [{ name: "x", strength: NaN }] }]) {
    assert.throws(() => cleanMediaItem({ prompt: "x", ...invalid }, "image"));
  }
  await assert.rejects(dispatch(cleanMediaItem({ prompt: "x" }, "image"), { error: "Qwen runtime not ready" }), /Qwen runtime not ready/);
});

test("MCP overnight items declare every added render field", () => {
  const schema = TOOLS.find((tool) => tool.name === "overnight_start").inputSchema.properties.items.items.properties;
  for (const key of ["dit", "ditEngine", "encoder", "vae", "quality", "persona", "refImages", "refSizing", "refResolution", "transparent", "sampler", "scheduler", "clipSkip", "loras"]) assert.ok(schema[key], key);
});
