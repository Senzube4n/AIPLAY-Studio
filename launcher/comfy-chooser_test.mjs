/** Exercise the launcher's real chooser controller without an OS dialog or a user's profile. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const start = html.indexOf("/* ── choose a detected ComfyUI install");
const end = html.indexOf("/* ── engine setup", start);
assert.ok(start >= 0 && end > start);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(setImmediate);
const good = (rig, extra = {}) => ({ rig, name: "My ComfyUI", python: `${rig}/ComfyUI/.venv/python`, valid: true, ...extra });

function harness(api) {
  const elements = {};
  let focused = null;
  const element = (id) => ({
    id, value: "", textContent: "", disabled: false, open: false, isConnected: true, listeners: {}, attrs: {}, radios: [],
    classList: { toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(key, value) { this.attrs[key] = value; },
    querySelectorAll() { return this.radios; },
    focus() { focused = id; },
    closest() { return null; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    get innerHTML() { return this.markup || ""; },
    set innerHTML(value) {
      this.markup = value;
      this.radios = [...value.matchAll(/<input type="radio"[^>]+>/g)].map(([tag]) => ({
        value: /value="([^"]*)"/.exec(tag)?.[1], dataset: { valid: /data-valid="([^"]*)"/.exec(tag)?.[1] },
        checked: /\schecked/.test(tag), disabled: /\sdisabled/.test(tag),
      }));
    },
  });
  const get = (id) => elements[id] ||= element(id);
  let refreshed = 0;
  const context = {
    $: get, esc: (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    api, check: { hits: ["D:/first", "D:/second"], modes: { full: { available: false } } },
    studio: { state: "idle" }, install: { state: "idle" },
    closeMenus() {}, document: { activeElement: get("trigger") }, loadCheck: async () => { refreshed++; },
  };
  const controller = runInNewContext(`${html.slice(start, end)}\n({openComfyChooser, closeComfyChooser, scanComfyInstalls,
    saveComfyInstall, maybeChooseComfy, get: () => ({comfySelected, comfySaving, comfyScanning})})`, context);
  return { ...controller, context, elements, getElement: get, refreshed: () => refreshed, focused: () => focused };
}

test("ambiguity opens an in-app choice once and cancel suppresses repaint prompts", async () => {
  const calls = [];
  const h = harness(async (url) => { calls.push(url); return { installs: [good("D:/first"), good("D:/second")] }; });
  h.maybeChooseComfy(); await settle();
  assert.equal(h.elements.comfyModal.open, true);
  assert.deepEqual(calls, ["/api/comfy-installs"]);
  assert.equal(h.elements.comfyUse.disabled, true, "several installs require an explicit choice");
  h.closeComfyChooser(); h.maybeChooseComfy(); await settle();
  assert.equal(h.elements.comfyModal.open, false);
  assert.equal(calls.length, 1);
  assert.equal(h.focused(), "trigger");
  h.context.check.hits.push("E:/third"); h.maybeChooseComfy(); await settle();
  assert.equal(h.elements.comfyModal.open, true, "a changed discovery result can prompt again");
});

test("startup never interrupts a running Studio or a working selection", () => {
  const h = harness(() => { throw new Error("must not scan"); });
  h.context.studio.state = "ready"; h.maybeChooseComfy();
  h.context.studio.state = "idle"; h.context.check.modes.full.available = true; h.maybeChooseComfy();
  assert.equal(h.getElement("comfyModal").open, false);
});

test("invalid Python is disabled and names, paths and errors are escaped", async () => {
  const h = harness(async () => ({ installs: [good("D:/ok"), {
    rig: 'D:/<bad>"', name: "<script>bad</script>", valid: false, error: "torch <missing>",
  }] }));
  h.openComfyChooser(); await settle();
  assert.equal(h.elements.comfyList.radios[0].disabled, false);
  assert.equal(h.elements.comfyList.radios[1].disabled, true);
  assert.match(h.elements.comfyList.innerHTML, /&lt;script&gt;/);
  assert.match(h.elements.comfyList.innerHTML, /torch &lt;missing&gt;/);
  assert.doesNotMatch(h.elements.comfyList.innerHTML, /<script>/);
});

test("selection saves the exact rig once and closes only after validated success", async () => {
  const pending = deferred(), calls = [];
  const h = harness(async (url, body) => {
    calls.push({ url, body });
    return body ? pending.promise : { installs: [good("D:/portable")], selectedRig: "D:/portable" };
  });
  h.openComfyChooser(); await settle();
  assert.equal(h.elements.comfyUse.disabled, false);
  const saving = h.saveComfyInstall(); await h.saveComfyInstall();
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[1]), JSON.stringify({ url: "/api/comfy-install", body: { rig: "D:/portable" } }));
  assert.equal(h.elements.comfyUse.disabled, true);
  h.closeComfyChooser(); assert.equal(h.elements.comfyModal.open, true, "saving cannot be dismissed as if cancelled");
  pending.resolve({ ok: true, rig: "D:/portable", python: "D:/portable/python_embeded/python.exe" });
  await saving;
  assert.equal(h.elements.comfyModal.open, false);
  assert.equal(h.refreshed(), 1);
});

test("failed validation keeps the pasted path editable and the dialog open", async () => {
  const calls = [];
  const h = harness(async (url, body) => { calls.push({ url, body }); return body ? { error: "Python cannot import torch" } : { installs: [] }; });
  h.openComfyChooser(); await settle();
  h.elements.comfyPath.value = "  F:/my-comfy/ComfyUI  ";
  h.elements.comfyPath.listeners.input();
  await h.saveComfyInstall();
  assert.equal(calls[1].body.rig, "F:/my-comfy/ComfyUI");
  assert.equal(h.elements.comfyMessage.textContent, "Python cannot import torch");
  assert.equal(h.elements.comfyModal.open, true);
  assert.equal(h.elements.comfyPath.disabled, false);
  assert.equal(h.refreshed(), 0);
});

test("a discovered interpreter remains selectable until the save validates it", async () => {
  const h = harness(async () => ({ installs: [good("D:/unchecked", { valid: null })] }));
  h.openComfyChooser(); await settle();
  assert.equal(h.elements.comfyList.radios[0].disabled, false);
  assert.match(h.elements.comfyList.innerHTML, /Python found/);
  assert.doesNotMatch(h.elements.comfyList.innerHTML, /Python ready/);
});

test("a pasted path can be validated while a discovery scan is slow", async () => {
  const scanning = deferred(), calls = [];
  const h = harness(async (url, body) => {
    calls.push({ url, body });
    return body ? { error: "Python missing" } : scanning.promise;
  });
  h.openComfyChooser();
  h.elements.comfyPath.value = "D:/manual"; h.elements.comfyPath.listeners.input();
  assert.equal(h.elements.comfyUse.disabled, false);
  await h.saveComfyInstall();
  assert.equal(calls[1].body.rig, "D:/manual");
  scanning.resolve({ installs: [good("D:/late")] }); await settle();
  assert.equal(h.elements.comfyMessage.textContent, "Python missing");
  assert.doesNotMatch(h.elements.comfyList.innerHTML, /D:\/late/);
});

test("a cancelled scan cannot overwrite the next dialog session", async () => {
  const stale = deferred(); let scans = 0;
  const h = harness(async () => ++scans === 1 ? stale.promise : { installs: [good("D:/current")] });
  h.openComfyChooser(); h.closeComfyChooser(); h.openComfyChooser(); await settle();
  stale.resolve({ installs: [good("D:/stale")] }); await settle();
  assert.match(h.elements.comfyList.innerHTML, /D:\/current/);
  assert.doesNotMatch(h.elements.comfyList.innerHTML, /D:\/stale/);
});

test("scan errors allow a pasted path and Escape cancels the dialog", async () => {
  const h = harness(async () => { throw new Error("Could not read installations"); });
  h.openComfyChooser(); await settle();
  assert.match(h.elements.comfyMessage.textContent, /Could not read/);
  h.elements.comfyPath.value = "D:/manual"; h.elements.comfyPath.listeners.input();
  assert.equal(h.elements.comfyUse.disabled, false);
  let prevented = false;
  h.elements.comfyModal.listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.elements.comfyModal.open, false);
});

test("System's ComfyUI Change opens the dialog before the native folder picker", () => {
  const comfy = html.indexOf('if (p.dataset.pick === "comfy") { openComfyChooser(); return; }');
  const native = html.indexOf('api("/api/pick", { what: p.dataset.pick })');
  assert.ok(comfy > 0 && native > comfy);
  assert.match(html, /<dialog id="comfyModal" aria-labelledby="comfyTitle" aria-describedby="comfyHint">/);
});
