/** Merge contracts: CPU-only helpers and mocked HTTP; never a live engine. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { videoLoraInput, validateVideoLoras } from "./video-lora-validation.js";
import { modelTools } from "./mcp-models.js";
import { TOOLS } from "./mcp.js";
import { ROUTABLE } from "./chat/router.js";
import { emptyResultNote } from "./art-wait.js";

const src = (file) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const index = src("./index.js"), app = src("../web/app.js");
const adapters = [{ name: "look.safetensors", strength: 0.6 }, { name: "motion.safetensors", strength: 0 }];
const tool = (name) => TOOLS.find((t) => t.name === name);
/* The tool's run() is evaluated against exactly these names, so every
 * module-scope name it calls must be listed here. emptyResultNote joined the
 * list when the four render tools stopped pointing an empty result at the
 * queue's last error; it is the REAL one from art-wait.js, not a stub, so the
 * note this lane sees is the note an agent sees. */
function mockedRun(name, api) {
  const code = String(tool(name).run).replace(/^async run\(/, "async function(");
  return new Function("api", "safeName", "waitForArt", "videoLoraInput", "emptyResultNote", `return (${code});`)(
    api, (v) => { if (/[/\\]|\.\./.test(v)) throw new Error("bad name"); return v; }, async () => {}, videoLoraInput, emptyResultNote);
}

test("video adapter input refuses silent drops, path rewriting and truncation", () => {
  assert.deepEqual(videoLoraInput(adapters), adapters);
  assert.deepEqual(videoLoraInput([{ name: "a.safetensors" }]), [{ name: "a.safetensors", strength: 1 }]);
  for (const bad of ["x", Array(9).fill(adapters[0]), [{ name: "C:\\x.safetensors" }], [{ name: "../x.safetensors" }],
    [{ name: "notes.txt" }], [{ name: "x.safetensors", strength: 5 }], [{ name: "x.safetensors", strength: "1" }],
    [{ name: "x.safetensors", strength: Infinity }], [adapters[0], adapters[0]], [{ ...adapters[0], ignored: true }]]) {
    assert.throws(() => videoLoraInput(bad));
  }
});

test("the API verifies shelf presence and architecture before queueing, including retained model folders", async () => {
  const files = adapters.map((a) => ({ name: a.name, folder: "loras", full: `old-models/loras/${a.name}` }));
  const read = [];
  const opts = { engine: "h3", loraBase: "MiniMax H3", shelf: async () => files, probe: async (p) => { read.push(p); return { family: "lora", variant: "MiniMax H3" }; } };
  assert.deepEqual(await validateVideoLoras(adapters, opts), adapters);
  assert.deepEqual(read, files.map(f => f.full));
  await assert.rejects(validateVideoLoras(adapters, { ...opts, engine: "ltx", loraBase: "LTX" }), /not LTX/);
  await assert.rejects(validateVideoLoras(adapters, { ...opts, shelf: async () => [] }), /No such file/);
  await assert.rejects(validateVideoLoras(adapters, { ...opts, probe: async () => ({ family: "checkpoint" }) }), /not a recognized LoRA/);
  await assert.rejects(validateVideoLoras(adapters, { ...opts, automatic: [adapters[0].name] }), /loads automatically/);
  assert.deepEqual(await validateVideoLoras(adapters, { ...opts, probe: async () => ({ family: "lora", variant: null }) }), adapters);
  assert.match(index, /shelf: async \(\) => scanBases\(await modelBases\(\)\)/);
  assert.match(index, /b\.loras = await checkedVideoLoras\(b\.loras, "h3"\)/);
  assert.match(index, /b\.loras = await checkedVideoLoras\(b\.loras, eng\)/);
});

test("typed MCP make/extend forward the ordered video stack unchanged", async () => {
  for (const name of ["make_clip", "extend_clip"]) {
    const calls = [];
    const api = async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === "/api/status") return { config: { video: { enabled: true, ready: true, engine: "h3" } } };
      if (path === "/api/clips") return { clips: [] };
      return { id: "v1" };
    };
    assert.equal(tool(name).inputSchema.properties.loras.maxItems, 8);
    await mockedRun(name, api)({ prompt: "a moving forest", clip: "source.mp4", loras: adapters });
    assert.deepEqual(calls.find(c => c.method === "POST").body.loras, adapters);
    assert.equal(calls.find(c => c.method === "POST").path, "/api/video");
  }
});

test("MCP can select installed H3 when the previously selected engine is absent", async () => {
  let chosen = "ltx";
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/api/status") return { config: { video: { enabled: true, ready: chosen === "h3", engine: chosen } } };
    if (body?.action === "engine") chosen = body.value;
    if (path === "/api/clips") return { clips: [] };
    return {};
  };
  await mockedRun("make_clip", api)({ prompt: "a forest", engine: "h3" });
  assert.deepEqual(calls.filter(c => c.method === "POST").map(c => c.body.action), ["engine", "create"]);
});

test("model-folder MCP exposes new-folder creation and removal without download or restart", async () => {
  const calls = [], api = async (...args) => { calls.push(args); return { ok: true }; };
  const t = modelTools(api).find(t => t.name === "models_folder");
  await t.run({ action: "use", dir: "F:\\Models", force: true, create: true });
  await t.run({ action: "drop", dir: "D:\\OldModels" });
  // The Models screen's "Add as extra", as a tool: plain control, number, tool.
  await t.run({ action: "also", dir: "E:\\MoreModels" });
  assert.deepEqual(calls, [
    ["POST", "/api/models", { action: "setModelsDir", dir: "F:\\Models", force: true, create: true }],
    ["POST", "/api/models", { action: "dropAlso", dir: "D:\\OldModels" }],
    ["POST", "/api/models", { action: "addAlso", dir: "E:\\MoreModels" }],
  ]);
  assert.ok(t.inputSchema.properties.action.enum.includes("also"));
  await assert.rejects(t.run({ action: "use", dir: "F:\\Missing", create: true }), /force/);
  await assert.rejects(t.run({ action: "drop", dir: " " }), /folder/);
  await assert.rejects(t.run({ action: "move", dir: "F:\\Models" }), /scan, use, also or drop/);
  assert.equal(calls.length, 3);
});

test("typed load/unload and video-enable actions preserve the API contracts and chat classification", async () => {
  const calls = [], api = async (...args) => { calls.push(args); return { ok: true }; };
  const memory = modelTools(api).find(t => t.name === "music_model_memory");
  for (const action of ["load", "unload"]) await memory.run({ action });
  await mockedRun("set_video_enabled", api)({ enabled: true });
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [
    ["POST", "/api/music", { action: "load" }], ["POST", "/api/music", { action: "unload" }],
    ["POST", "/api/video", { action: "enable", value: true }],
  ]);
  assert.equal(ROUTABLE.music_model_memory, "gpu");
  assert.equal(ROUTABLE.set_video_enabled, "writes");
});

test("catalogue replacements can use the retained folder but must stay on the correct shelf", async () => {
  const block = index.match(/const found = \(await scanBases\(await modelBases\(\)\)\)\s*\.find\(\(f\) => f\.name === useName && f\.shelf === shelfOf\(folder\)\);/);
  assert.ok(block, "the override route searches all configured bases with the same shelf guard");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const lookup = new AsyncFunction("scanBases", "modelBases", "shelfOf", "folder", "useName", block[0] + "return found;");
  const oldFile = { name: "custom.safetensors", shelf: "diffusion_models", full: "old/diffusion_models/custom.safetensors" };
  const scan = async (bases) => { assert.deepEqual(bases, ["new", "old"]); return [oldFile]; };
  assert.equal(await lookup(scan, async () => ["new", "old"], x => x, "diffusion_models", oldFile.name), oldFile);
  assert.equal(await lookup(scan, async () => ["new", "old"], x => x, "vae", oldFile.name), undefined);
});

test("manual unload refuses every active queue and fails closed if engine status is unavailable", async () => {
  const start = index.indexOf('if (b.action === "unload" || b.action === "load") {');
  const end = index.indexOf('if (config.music.engine === "ace-step15")', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("b", "jobs", "art", "comfy", "engineDoor", "json", "res", index.slice(start, end) + "return null; }");
  const good = { ready: true, running: [], queue: { running: 0, pending: 0 } };
  for (const scenario of [{ song: true }, { songQueue: true }, { art: true }, { artQueue: true },
    { card: { ...good, running: [{ via: "reactive" }] } }, { card: { ...good, queue: { pending: 1 } } }, { offline: true }, {}]) {
    let unloads = 0;
    const jobs = { current: scenario.song, queue: scenario.songQueue ? [{}] : [], unloadModels: async () => { unloads++; return {}; }, snapshot: () => ({}) };
    const art = { current: scenario.art, queue: scenario.artQueue ? [{}] : [] };
    const door = { status: async () => { if (scenario.offline) throw new Error("offline"); return scenario.card || good; } };
    const result = await run({ action: "unload" }, jobs, art, { ready: true }, door, (_, status, body) => ({ status, body }), {});
    const idle = !Object.keys(scenario).length;
    assert.equal(result.status, idle ? 200 : 409);
    assert.equal(unloads, idle ? 1 : 0);
  }
});

test("a late LoRA list cannot repaint the newly selected engine", async () => {
  const fn = app.match(/async function vidLoadLoras\(\) \{[\s\S]*?\n\}/)[0];
  const pending = [], els = { vidLoraPick: {}, vidEngine: { value: "h3" }, vidLoraNote: {} };
  const context = vm.createContext({ $: id => els[id], state: { video: { engines: {} } }, esc: x => x,
    vidLoraFit: () => "yes", vidPaintLoras: () => {},
    fetch: () => new Promise(resolve => pending.push(resolve)) });
  vm.runInContext(`let vidLoraRequest=0, vidLoraShelf=[]; ${fn}`, context);
  const old = vm.runInContext("vidLoadLoras()", context);
  els.vidEngine.value = "ltx";
  const next = vm.runInContext("vidLoadLoras()", context);
  pending[1]({ json: async () => ({ loras: [{ name: "new.safetensors", isLora: true }] }) }); await next;
  const current = els.vidLoraPick.innerHTML;
  pending[0]({ json: async () => ({ loras: [{ name: "old.safetensors", isLora: true }] }) }); await old;
  assert.equal(els.vidLoraPick.innerHTML, current);
  assert.match(current, /new/); assert.doesNotMatch(current, /old/);
});

test("cover backfill retains lyrics, Qwen defaults and native readiness remain wired", async () => {
  const { ArtRunner } = await import("./art.js");
  const asked = [], track = { file: "song.flac", lyrics: "Hold the light\nHold the light", seed: 42 };
  const count = await ArtRunner.prototype.backfill.call({ existing: async () => new Set(), request: (job) => { asked.push(job); return true; } }, [track]);
  assert.equal(count, 1); assert.equal(asked[0].lyrics, track.lyrics);
  assert.match(src("./config.js"), /image: \{ engine: "qwen-image-2\.1" \}/);
  assert.match(src("./art.js"), /const readiness = await this\.qwenStatus\(\{ options: qwenOptions \}\)/);
  assert.match(src("./art.js"), /loras: job\.loras\?\.length \? job\.loras : null/);
});
