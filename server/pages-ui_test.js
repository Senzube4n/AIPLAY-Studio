// Drive the real page controller with delayed HTTP replies and a small DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/pages.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace("export function initPages", "function initPages");
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const nodes = new Map(), inner = { postMessage() {} }, timers = [], generations = [], requests = [], pending = new Map();
  const pages = new Map(["a", "b"].map(id => [id, { id, name: `Page ${id}`, version: 1,
    versions: [{ n: 1, at: "2026-10-18T12:00:00Z" }], html: `<p>${id}</p>` }]));
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(), value = { id, value: "", dataset: {}, hidden: false, disabled: false, textContent: "", innerHTML: "",
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
      setAttribute() {}, addEventListener() {}, focus() {}, querySelector() { return null; }, setSelectionRange() {},
    };
    nodes.set(id, value); return value;
  }
  const frame = node("mpFrame");
  frame.contentWindow = { location: { get href() { return frame.src; } }, document: {}, addEventListener() {} };
  frame.contentDocument = { getElementById: () => ({ contentWindow: inner }) };
  node("mpModel").value = "api:first";
  node("mpAsk").value = "Make a page";
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  async function fetch(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    const key = body?.action || url;
    if (pending.has(key)) { const paused = pending.get(key); pending.delete(key); await paused.promise; }
    if (body?.action === "generate") {
      const paused = deferred();
      generations.push({ body, finish() {
        const page = pages.get(body.id);
        if (!page) { paused.resolve(reply({ error: "No such page." }, 404)); return; }
        page.version++; page.versions.push({ n: page.version, at: "2026-10-18T12:01:00Z" }); page.html = `<p>built ${body.id}</p>`;
        paused.resolve(new Response(JSON.stringify({ type: "done", version: page.version }) + "\n"));
      } });
      return paused.promise;
    }
    if (body?.action === "delete") { pages.delete(body.id); return reply({ ok: true }); }
    if (body?.action === "rename") { pages.get(body.id).name = body.name; return reply({ name: body.name }); }
    if (body?.action === "save") { const page = pages.get(body.id); page.html = body.html; page.version++; return reply({ version: page.version }); }
    if (url === "/api/pages") return reply({ pages: [...pages.values()].map(p => ({ ...p, versions: p.versions.length })),
      models: [{ value: "api:first", label: "First" }, { value: "api:other", label: "Other" }] });
    const id = /^\/api\/pages\/([^?]+)/.exec(url)?.[1];
    return pages.has(id) ? reply(pages.get(id)) : reply({ error: "No such page." }, 404);
  }
  let confirmation = async () => true;
  const context = { document: { getElementById: node, querySelectorAll: () => [], addEventListener() {} }, fetch,
    appConfirm: (...args) => confirmation(...args), appAlert: async () => {}, wireMic() {},
    localStorage: { getItem() { return ""; }, setItem() {} }, Response, TextDecoder, ArrayBuffer, Date, URL,
    requestAnimationFrame: fn => fn(), setInterval: () => 1, clearInterval() {}, setTimeout: fn => { timers.push(fn); },
  };
  vm.runInNewContext(source + `\nglobalThis.controller = { open, build, deletePage, wire,
    state: () => ({ current, busy }), report: message => onBridgeMessage({ source: testInner, data: { aiplayBridge: 1, op: "error", message } }) };`,
  Object.assign(context, { testInner: inner }));
  context.controller.wire();
  return { ...context.controller, node, pages, generations, requests, timers, pending,
    confirmWith: fn => { confirmation = fn; }, tick: async () => { assert.ok(timers.length, "the controller is observing startup errors"); timers.shift()(); await turn(); } };
}

test("a delayed build does not reopen, clear or automatically repair the newly selected page", async () => {
  const f = fixture(); await f.open("a"); const building = f.build(); await turn();
  await f.open("b"); f.node("mpAsk").value = "Keep this request";
  f.report("B's own runtime error");
  const openedB = f.requests.filter(r => r.url === "/api/pages/b").length;
  f.generations[0].finish(); await building;
  assert.equal(f.state().current.id, "b");
  assert.equal(f.node("mpAsk").value, "Keep this request");
  assert.equal(f.node("mpCode").value, "<p>b</p>");
  assert.equal(f.requests.filter(r => r.url === "/api/pages/b").length, openedB);
  assert.equal(f.generations.length, 1);
  assert.equal(f.state().busy, false);
});

test("automatic repair keeps its original page and model, and its delayed result leaves another page alone", async () => {
  const f = fixture(); await f.open("a"); const building = f.build(); await turn();
  f.generations[0].finish(); await turn();
  f.node("mpModel").value = "api:other";
  f.report("A failed during startup"); await f.tick();
  assert.equal(f.generations.length, 2);
  assert.equal(f.generations[1].body.id, "a");
  assert.equal(f.generations[1].body.model, "api:first");
  await f.open("b"); f.node("mpAsk").value = "For B";
  f.report("B failed too"); f.generations[1].finish(); await building;
  assert.equal(f.state().current.id, "b");
  assert.equal(f.node("mpCode").value, "<p>b</p>");
  assert.equal(f.node("mpAsk").value, "For B");
  assert.equal(f.generations.length, 2);
});

test("switching during startup observation prevents repair of the other page's errors", async () => {
  const f = fixture(); await f.open("a"); const building = f.build(); await turn();
  f.generations[0].finish(); await turn();
  await f.open("b"); f.report("Only B reports this error"); await f.tick(); await building;
  assert.equal(f.generations.length, 1);
  assert.equal(f.state().current.id, "b");
});

test("deleting the build target does not reopen it or show its late failure on the replacement page", async () => {
  const f = fixture(); await f.open("a"); const building = f.build(); await turn();
  await f.deletePage(); assert.equal(f.state().current.id, "b");
  f.node("mpAsk").value = "Keep B";
  const note = f.node("mpNote").textContent;
  f.generations[0].finish(); await building;
  assert.equal(f.pages.has("a"), false);
  assert.equal(f.state().current.id, "b");
  assert.equal(f.node("mpNote").textContent, note);
  assert.equal(f.node("mpAsk").value, "Keep B");
  assert.equal(f.state().busy, false);
});

test("a target deleted elsewhere is removed from the view after the pending build fails", async () => {
  const f = fixture(); await f.open("a"); const building = f.build(); await turn();
  f.pages.delete("a"); f.generations[0].finish(); await building;
  assert.equal(f.state().current.id, "b");
  assert.equal(f.generations.length, 1);
  assert.equal(f.state().busy, false);
  assert.equal(f.node("mpNote").textContent, "");
});

test("a build that stays selected still repairs once, saves the new version and unlocks its controls", async () => {
  const f = fixture(); await f.open("a"); const building = f.build(); await turn();
  f.generations[0].finish(); await turn();
  f.report("A startup error"); await f.tick();
  f.generations[1].finish(); await turn(); await f.tick(); await building;
  assert.equal(f.state().current.id, "a");
  assert.equal(f.state().current.version, 3);
  assert.equal(f.generations.length, 2);
  assert.equal(f.node("mpAsk").value, "");
  assert.equal(f.node("mpAsk").readOnly, false);
  assert.match(f.node("mpNote").textContent, /Built and repaired: v3/);
});

test("delete confirmation stays bound to the page named before selection changed", async () => {
  const f = fixture(), confirmation = deferred(); f.confirmWith(() => confirmation.promise);
  await f.open("a"); const removing = f.deletePage(); await f.open("b");
  confirmation.resolve(true); await removing;
  assert.equal(f.pages.has("a"), false);
  assert.equal(f.pages.has("b"), true);
  assert.equal(f.state().current.id, "b");
});

test("out-of-order page loads and delayed edits cannot replace a newer selection", async () => {
  const f = fixture(), load = deferred(); f.pending.set("/api/pages/a", load);
  const old = f.open("a"); await f.open("b"); load.resolve(); await old;
  assert.equal(f.state().current.id, "b");
  await f.open("a"); const rename = deferred(); f.pending.set("rename", rename);
  f.node("mpName").value = "Renamed A"; const changing = f.node("mpName").onchange();
  await f.open("b"); rename.resolve(); await changing;
  assert.equal(f.state().current.id, "b");
  assert.equal(f.state().current.name, "Page b");
  await f.open("a"); const save = deferred(); f.pending.set("save", save);
  f.node("mpCode").value = "<p>edited A</p>"; const saving = f.node("mpSaveCode").onclick();
  await f.open("b"); save.resolve(); await saving;
  assert.equal(f.state().current.id, "b");
  assert.equal(f.node("mpCode").value, "<p>b</p>");
});
