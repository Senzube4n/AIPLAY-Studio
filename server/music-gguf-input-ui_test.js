/** Real setup-controller code with injected DOM/fetch. Never contacts a server. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
test("single-engine music mode retains the parent of native setup",()=>{
  const line=source.match(/\$\("musicEngineRow"\)\.hidden = [^;]+;/)?.[0];
  assert.ok(line);
  for(const [keys,eng,want] of [[['yue2-gguf'],{runtime:'audiocpp'},false],[['legacy'],{},true],[['legacy','yue2'],{},false]]) {
    const row={};runInNewContext(line,{$:()=>row,keys,eng,state:{musicModels:[]}});assert.equal(row.hidden,want);
  }
  // The music model picker lives in this row: with any model choices it shows even for one engine.
  const row={};runInNewContext(line,{$:()=>row,keys:['legacy'],eng:{},state:{musicModels:[{value:'yue2-comfy'}]}});
  assert.equal(row.hidden,false);
});
const start = source.indexOf("let ggufSetupStatus"), end = source.indexOf("function musicEnginePaint()", start);
assert.ok(start >= 0 && end > start);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const result = (body) => ({ ok: true, json: async () => body });
function harness(fetch) {
  const elements = Object.fromEntries(["ggufSetup", "ggufSetupMessage", "ggufSetupProgress", "ggufSetupInstall", "ggufSetupCancel", "ggufSetupRefresh", "ggufSetupAccept", "ggufSetupBytes", "ggufSetupPrecision", "yGgufPrecision"]
    .map((id) => [id, { value: "q4_0", checked: false, disabled: false, hidden: false, textContent: "", addEventListener() {}, removeAttribute(key) { delete this[key]; } }]));
  const timers = new Map(); let timer = 0;
  const state = { musicEngine: "yue2-gguf", musicEngines: { "yue2-gguf": { runtime: "audiocpp", ready: false } } };
  let controller;
  controller = runInNewContext(`${source.slice(start, end)}\n({refreshGgufSetup,actGgufSetup,paintGgufSetup,applyGgufSetupStatus,get:()=>ggufSetupStatus})`, {
    state, $: (id) => elements[id], fetch, AbortController, musicEnginePaint() { controller?.paintGgufSetup(); },
    setTimeout: (fn) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id) => timers.delete(id),
  }, { timeout: 1000 });
  return { ...controller, elements, timers, state };
}
const reviewed = (extra = {}) => ({ quantization: "q4_0", ready: false, installed: false, state: "idle", downloadBytes: 1234, ...extra });
test("setup GET is read-only, deduplicated and updates ready independently of Comfy", async () => {
  const pending = deferred(), calls = [];
  const h = harness((url, options) => { calls.push({ url, options }); return pending.promise; });
  h.applyGgufSetupStatus(reviewed());
  const first = h.refreshGgufSetup(); await h.refreshGgufSetup();
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "GET"); assert.equal(calls[0].options.body, undefined);
  pending.resolve(result({ ok: true, ready: true, state: "ready", message: "Ready" })); await first;
  assert.equal(h.state.musicEngines["yue2-gguf"].ready, true); assert.equal(h.timers.size, 0);
});
test("install needs explicit checkbox, sends licence acceptance once, and cannot auto-retry", async () => {
  const calls = [], pending = deferred();
  const h = harness((url, options) => { calls.push({ url, options }); return pending.promise; });
  h.applyGgufSetupStatus(reviewed());
  await h.actGgufSetup("install"); assert.equal(calls.length, 0);
  h.elements.ggufSetupAccept.checked = true;
  const action = h.actGgufSetup("install"); await h.actGgufSetup("install");
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].options.body), { action: "install", quantization: "q4_0", acceptLicense: true });
  pending.resolve(result({ ok: true, state: "downloading", ready: false })); await action;
  assert.equal(h.elements.ggufSetupAccept.checked, false); assert.equal(h.elements.ggufSetupInstall.disabled, true);
  assert.equal(h.elements.ggufSetupCancel.hidden, false); assert.equal(h.timers.size, 0);
});
test("an older GET cannot overwrite a newer install result", async () => {
  const pending = deferred();
  const h = harness((url, options) => options.method === "GET" ? pending.promise
    : Promise.resolve(result({ ok: true, ready: false, state: "downloading", message: "Installing" })));
  h.applyGgufSetupStatus(reviewed());
  const reading = h.refreshGgufSetup(); h.elements.ggufSetupAccept.checked = true;
  await h.actGgufSetup("install"); pending.resolve(result({ ok: true, ready: false, state: "idle" })); await reading;
  assert.equal(h.get().state, "downloading");
});
test("cancel does not accept licence implicitly and failed requests require a fresh state check", async () => {
  const calls = []; let failed = false;
  const h = harness(async (url, options) => {
    calls.push(options);
    if (failed) throw new Error("Connection lost");
    return result({ ok: true, ...reviewed({ state: "cancelled" }) });
  });
  await h.actGgufSetup("cancel"); assert.deepEqual(JSON.parse(calls[0].body), { action: "cancel" });
  failed = true; h.elements.ggufSetupAccept.checked = true; await h.actGgufSetup("install");
  assert.equal(h.get().uncertain, true); assert.equal(h.elements.ggufSetupInstall.disabled, true);
  assert.equal(calls.length, 2); assert.equal(h.timers.size, 0);
});
test("setup request deadline aborts the sole request without any install or retry", async () => {
  let calls = 0;
  const h = harness((url, options) => {
    calls++; return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))));
  });
  const request = h.refreshGgufSetup(); assert.equal(h.timers.size, 1);
  [...h.timers.values()][0](); await request;
  assert.equal(calls, 1); assert.match(h.get().error, /timed out/); assert.equal(h.timers.size, 0);
});
