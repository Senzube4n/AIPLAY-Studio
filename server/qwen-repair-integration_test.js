import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { setupTools } from "./mcp-setup.js";
import { adaptTool, chooseTools, ROUTABLE } from "./chat/router.js";
import { newSession, runTurn } from "./chat/loop.js";
import { createSetupRoutes } from "./setup/routes.js";
import { createChatRoutes } from "./chat/routes.js";
import { withImageRepairTools, createFormTools } from "./chat/form-tools.js";

test("the Images Simple assistant can repair Qwen and inspect its progress through its actual chat route", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwen-simple-repair-"));
  const calls = [], events = [];
  const helpers = setupTools(async (method, path, body) => {
    calls.push({ method, path, body });
    return { job: { id: "qwen-engine", state: "running" }, setups: [{ id: "qwen-engine" }] };
  }).filter((tool) => ["qwen_engine_repair", "setup_status"].includes(tool.name))
    .map((tool) => adaptTool(tool, ROUTABLE[tool.name]));
  const registry = withImageRepairTools(createFormTools("image"), helpers);
  assert.deepEqual(registry.names, ["set_form", "generate", "qwen_engine_repair", "setup_status"]);
  await registry.get("setup_status").run({ id: "stems" });
  assert.equal(calls.pop().body.id, "qwen-engine", "the scoped status always inspects Qwen");
  let modelCalls = 0;
  const handler = createChatRoutes({ scope: "image", qwenRepairTools: helpers, dir: directory,
    config: { uiPort: 4173, paths: { appData: directory } },
    engine: { status: async () => ({ ready: true, running: [], queue: { running: 0, pending: 0 } }) },
    model: async (messages) => {
      modelCalls++;
      if (modelCalls === 1) {
        assert.match(JSON.stringify(messages), /QWEN REPAIR EXCEPTION/, "the small model is explicitly allowed to read then propose");
        return JSON.stringify({ tool: "setup_status", args: {} });
      }
      return JSON.stringify({ tool: "qwen_engine_repair", args: {} });
    },
    json: (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); },
    readBody: async (req) => { let body = ""; for await (const chunk of req) body += chunk; return JSON.parse(body); },
  });
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, "http://127.0.0.1"))) { res.writeHead(404); res.end(); }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const send = async (body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/image`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:qwen-repair-test" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const frames = (await response.text()).split("\n\n").filter((text) => text.startsWith("data: "))
        .map((text) => JSON.parse(text.slice(6)));
      events.push(...frames); return frames.find((frame) => frame.type === "open").session;
    };
    const session = await send({ message: "fix qwen for me" });
    assert.deepEqual(calls, [{ method: "POST", path: "/api/setup", body: { action: "status", id: "qwen-engine" } }]);
    assert.ok(events.some((event) => event.type === "proposal" && event.tool === "qwen_engine_repair"));
    await send({ message: "yes", session });
    assert.equal(modelCalls, 2);
    assert.deepEqual(calls.at(-1), { method: "POST", path: "/api/setup", body: { action: "run", id: "qwen-engine" } });
    assert.equal(calls.filter((call) => call.body.action === "run").length, 1);
    assert.ok(events.some((event) => event.type === "say" && /Fixing Qwen/.test(event.text)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a spoken or typed yes starts the narrow Qwen repair once without a mouse or another model call", async () => {
  const calls = [];
  const source = setupTools(async (method, path, body) => {
    calls.push({ method, path, body });
    return { job: { id: "qwen-engine", state: "running", label: "Downloading engine" } };
  }).find((tool) => tool.name === "qwen_engine_repair");
  assert.deepEqual(source.inputSchema.properties, {}, "the assistant cannot ask users for paths or choose executable code");
  assert.equal(ROUTABLE[source.name], "writes");
  assert.ok(chooseTools("fix qwen image 2.1 for me").some((tool) => tool.name === source.name));
  assert.ok(chooseTools("fix qwen image 2.1 for me").some((tool) => tool.name === "setup_status"), "Chat can read the repair offer in the same turn");
  const tool = adaptTool(source, ROUTABLE[source.name]);
  assert.equal(tool.endsTurn, true);
  assert.match(tool.cost, /downloads.*restarts/);
  const registry = { all: [tool], get: (name) => name === tool.name ? tool : null };
  const engine = { status: async () => ({ ready: true, running: [], queue: { running: 0, pending: 0 } }) };
  let modelCalls = 0;
  const model = async () => { modelCalls++; return JSON.stringify({ tool: tool.name, args: {} }); };
  const session = newSession("qwen_accessible_repair"), events = [];
  await runTurn({ tools: registry, engine, model }, session, "fix qwen for me", (event) => events.push(event));
  assert.equal(calls.length, 0, "the download waits for the existing accessible confirmation");
  assert.equal(session.pending.tool, tool.name);
  await runTurn({ tools: registry, engine, model }, session, "yes", (event) => events.push(event));
  assert.deepEqual(calls, [{ method: "POST", path: "/api/setup", body: { action: "run", id: "qwen-engine" } }]);
  assert.equal(modelCalls, 1, "the local chat model is not invoked again while its engine restarts");
  assert.equal(session.pending, null);
  assert.ok(events.some((event) => event.type === "say" && /Fixing Qwen/.test(event.text)));
});

test("Qwen setup uses the guarded existing route and exposes read-only progress", async () => {
  let runs = 0, reply;
  const runner = { ids: ["qwen-engine"], has: (id) => id === "qwen-engine",
    run: async () => { runs++; return { id: "qwen-engine", state: "running" }; },
    status: async () => ({ setups: [{ id: "qwen-engine", job: { state: "running", label: "Checking Qwen" } }] }) };
  const route = createSetupRoutes({ runner, json: (_res, status, body) => { reply = { status, body }; },
    readBody: async (req) => req.body, sameOriginLocalJson: (req) => req.local === true });
  const url = new URL("http://127.0.0.1/api/setup");
  await route({ method: "POST", body: { action: "run", id: "qwen-engine" } }, {}, url);
  assert.equal(reply.status, 403); assert.equal(runs, 0);
  await route({ method: "POST", local: true, body: { action: "run", id: "qwen-engine" } }, {}, url);
  assert.equal(reply.status, 200); assert.equal(runs, 1);
  await route({ method: "POST", body: { action: "status", id: "qwen-engine" } }, {}, url);
  assert.equal(reply.body.setups[0].job.label, "Checking Qwen"); assert.equal(runs, 1);
});

test("Studio busy detection covers queued work and allows only a finishing idle chat hold", async () => {
  const index = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const text = index.slice(index.indexOf("async function qwenRepairBusy()"), index.indexOf("const qwenActivation ="));
  const jobs = { current: null, queue: [] }, artState = { queued: 0, current: null };
  let live = { running: [], queue: { running: 0, pending: 0 }, held: ["a chat turn"] };
  const busy = new Function("jobs", "art", "engineDoor", `${text}; return qwenRepairBusy;`)(jobs,
    { status: () => ({ art: artState }) }, { status: async () => live });
  assert.equal(await busy(), false);
  live.held = ["a Reactive look"]; assert.equal(await busy(), true);
  live.held = []; live.queue.pending = 1; assert.equal(await busy(), true);
  live.queue.pending = 0; live.queue.running = 1; assert.equal(await busy(), true);
  live.queue.running = 0; artState.queued = 1; assert.equal(await busy(), true);
  artState.queued = 0; jobs.queue.push({}); assert.equal(await busy(), true);
  jobs.queue.length = 0; live.queue = null;
  assert.match(await busy(), /could not check the render queue/, "an unreadable queue cannot authorize a restart");
});

test("repair progress keeps the keyboard control stable and announces stages without installer logs", async () => {
  const source = (await readFile(new URL("../web/setup-feature.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
  const button = { dataset: { setupFeature: "qwen-engine" }, disabled: false, textContent: "Fix Qwen" };
  const note = { dataset: { setupNote: "qwen-engine", setupJobNote: "" }, hidden: true, textContent: "", classList: { toggle() {} } };
  const row = { id: "qwen-engine", button: "Fix Qwen", title: "Qwen engine", readyWords: "Qwen support is ready",
    ready: false, blocked: null, progressOnly: true, offer: "Studio will install a compatible engine and restart it automatically.",
    sizeWords: "About 6-15 GB download · 16 GB disk space", job: null };
  const confirmations = [], alerts = [], requests = [], callbacks = [];
  const context = vm.createContext({
    document: { activeElement: button, addEventListener() {}, querySelectorAll: (selector) =>
      selector === "[data-setup-feature]" ? [button] : selector === "[data-setup-note]" ? [note] : [] },
    CSS: { escape: (text) => text }, Set, Date, console,
    setTimeout: (callback) => { callbacks.push(callback); return callbacks.length; }, clearTimeout() {},
    appConfirm: async (text) => { confirmations.push(text); return true; }, appAlert: (text) => alerts.push(text),
    fetch: async (_url, opts) => {
      const body = JSON.parse(opts.body); requests.push(body);
      if (body.action === "run") row.job = { id: "qwen-engine", state: "running", label: "Downloading engine", n: 3, of: 13,
        lines: ["pip install C:/private/long/path.py error details"] };
      return { json: async () => body.action === "run" ? { job: row.job } : { setups: [row] } };
    },
  });
  vm.runInContext(source, context);
  await vm.runInContext('startSetup("qwen-engine")', context);
  assert.equal(confirmations.length, 1); assert.match(confirmations[0], /6-15 GB/);
  assert.equal(button.disabled, true); assert.equal(button.textContent, "Fixing…");
  assert.equal(note.textContent, "Downloading engine…"); assert.doesNotMatch(note.textContent, /pip|private/);
  assert.equal(note.hidden, false, "stage progress stays in the Simple mode action area");
  assert.equal(context.document.activeElement, button);
  await vm.runInContext('startSetup("qwen-engine")', context);
  assert.equal(requests.filter((r) => r.action === "run").length, 1);
  row.ready = true; row.job = null;
  await vm.runInContext('startSetup("qwen-engine")', context);
  assert.equal(alerts.at(-1), "Qwen support is ready"); assert.doesNotMatch(alerts.at(-1), /undefined/);
  await vm.runInContext("readStatus(true).then(() => paintAll())", context);
  assert.equal(note.hidden, true, "completed setups leave the Simple form uncluttered");
});

test("Qwen repair details stay inside small and desktop viewports after progress changes their height", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const source = /function imgQwenPlacePop\(\) \{[\s\S]*?\n\}/.exec(app)?.[0];
  assert.ok(source);
  for (const width of [315, 700, 1280]) {
    const pop = { hidden: false, style: {}, classList: { toggle() {} }, getBoundingClientRect: () => ({ height: 230 }) };
    const field = { getBoundingClientRect: () => ({ left: 40, right: 280, top: 310, bottom: 340, width: 240 }) };
    const context = vm.createContext({ $: (id) => id === "imgQwenStatus" ? pop : field,
      window: { innerWidth: width, innerHeight: 365 }, Math,
      requestAnimationFrame: () => 1, setTimeout: () => 1, imgQwenPopRaf: null });
    vm.runInContext(`${source}\nimgQwenPlacePop();`, context);
    assert.ok(parseFloat(pop.style.top) >= 8);
    assert.ok(parseFloat(pop.style.top) + 230 <= 357, `the Fix Qwen button remains visible at ${width}px`);
    assert.ok(parseFloat(pop.style.left) >= 8);
    assert.ok(parseFloat(pop.style.left) + parseFloat(pop.style.width) <= width - 8);
  }
});
