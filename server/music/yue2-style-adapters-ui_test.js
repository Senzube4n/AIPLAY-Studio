import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { YUE2_STYLE_ADAPTERS, validateYue2StyleAdapter } from "./yue2-style-adapters.js";
import { mountYue2StyleAdapters, yue2StyleAdapterPatch, yue2StyleSelectionIssue, yue2StyleAdapterRows } from "../../web/yue2-style-adapters.js";

class Element {
  constructor(tag = "div") { Object.assign(this, { tag, children: [], listeners: [], value: "", textContent: "", disabled: false, hidden: false, title: "" }); }
  get options() { return this.children.filter(child => child.tag === "option"); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  before(...children) { const parent = this.parentElement, index = parent.children.indexOf(this); for (const child of children) child.parentElement = parent; parent.children.splice(index, 0, ...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(kind, handler, capture = false) { this.listeners.push({ kind, handler, capture }); }
  removeEventListener(kind, handler) { this.listeners = this.listeners.filter(listener => listener.kind !== kind || listener.handler !== handler); }
  fire(kind = "change") {
    let stopped = false;
    const event = { target: this, stopImmediatePropagation() { stopped = true; } };
    for (const listener of [...this.listeners].sort((a, b) => Number(b.capture) - Number(a.capture))) {
      if (listener.kind === kind && !stopped) listener.handler(event);
    }
  }
}

function fixture({ engine = "yue2-comfy", onSelect = () => {} } = {}) {
  const host = new Element(), controls = new Map(), saves = [], errors = [];
  for (const id of ["yLora", "yLoraClip", "yLoraStrength", "yLoraClipStrength", "yLoraStrengthValue", "yLoraClipStrengthValue", "yCot", "yLoraNote"]) {
    const element = new Element(id === "yLora" || id === "yLoraClip" || id === "yCot" ? "select" : "div");
    element.id = id; controls.set(id, element); host.append(element);
  }
  for (const id of ["yLora", "yLoraClip"]) for (const file of ["", "custom.safetensors", ...YUE2_STYLE_ADAPTERS.map(adapter => adapter.file)]) {
    const option = new Element("option"); option.value = file; controls.get(id).append(option);
  }
  controls.get("yCot").value = "off";
  controls.get("yLoraStrength").value = "55"; controls.get("yLoraClipStrength").value = "65";
  const walk = node => [node, ...node.children.flatMap(walk)];
  const document = { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element("text"), { textContent: text }),
    getElementById: id => walk(host).find(element => element.id === id) || null };
  const state = { musicEngine: engine }, catalog = YUE2_STYLE_ADAPTERS.map(styleAdapter => ({ styleAdapter, installed: true }));
  for (const id of ["yLora", "yLoraClip"]) controls.get(id).addEventListener("change", () => saves.push(id));
  const selected = [];
  const api = mountYue2StyleAdapters({ document, getState: () => state, getAdapters: () => catalog,
    onSelect: async (patch, adapter) => { await onSelect(patch, adapter); selected.push({ patch, adapter }); }, onError: error => errors.push(error) });
  const idle = async () => { for (let i = 0; i < 20; i++) { await new Promise(resolve => setImmediate(resolve)); if (!document.getElementById("yStyleAdapter")?.disabled || state.musicEngine !== "yue2-comfy") return; } throw new Error("Picker did not settle"); };
  return { api, document, state, catalog, controls, host, saves, errors, selected, idle };
}

test("style UI paints cached metadata without selecting, changing Thinking or saving", () => {
  const d = fixture(), before = d.controls.get("yCot").value;
  d.api.refresh(); d.api.refresh();
  assert.equal(d.controls.get("yCot").value, before); assert.equal(d.controls.get("yLora").value, "");
  assert.equal(d.controls.get("yLoraClip").value, ""); assert.deepEqual(d.selected, []);
  assert.equal(d.document.getElementById("yStyleAdapter").options.length, 12);
  assert.equal(d.document.getElementById("yStyleAdapterHint").hidden, true);
  const second = mountYue2StyleAdapters({ document: d.document }); assert.equal(second, d.api, "one picker per form");
});

test("explicit picker and existing fused slot choices populate both halves before persistence", async () => {
  const d = fixture(), first = YUE2_STYLE_ADAPTERS[0], other = YUE2_STYLE_ADAPTERS.at(-1);
  const pick = d.document.getElementById("yStyleAdapter"); pick.value = first.file; pick.fire(); await d.idle();
  assert.deepEqual(d.selected[0].patch, { lora: first.file, loraClip: first.file, loraStrength: 1, loraClipStrength: 1, cot: "full" });
  for (const id of ["yLora", "yLoraClip"]) assert.equal(d.controls.get(id).value, first.file);
  assert.equal(d.controls.get("yCot").value, "full"); assert.equal(d.controls.get("yLoraStrength").value, "100");
  assert.equal(d.controls.get("yLoraClipStrengthValue").textContent, "1.00");
  const hint = d.document.getElementById("yStyleAdapterHint");
  assert.match(hint.children[0].textContent, /Start Style with trbdr/); assert.match(hint.children[2].title, /noncommercial use only/);
  assert.match(hint.children[0].title, /INT8 quality is unverified/);
  d.controls.get("yLoraClip").value = other.file; d.controls.get("yLoraClip").fire(); await d.idle();
  assert.equal(d.controls.get("yLora").value, other.file); assert.deepEqual(d.saves, [], "individual saves consumed for a paired known adapter");
  assert.equal(d.selected.at(-1).patch.loraClip, other.file);
  d.controls.get("yLora").value = first.file; d.controls.get("yLora").fire(); await d.idle();
  assert.equal(d.controls.get("yLoraClip").value, first.file);
  d.controls.get("yLora").value = "custom.safetensors"; d.controls.get("yLora").fire();
  assert.deepEqual(d.saves, ["yLora"], "ordinary LoRA behavior belongs to the existing form");
  assert.match(hint.children[0].textContent, /same style adapter/);
  await d.api.select(""); assert.equal(d.controls.get("yLora").value, ""); assert.equal(d.controls.get("yLoraClip").value, "");
});

test("refresh preserves mismatched saved settings and reports unavailable or unsupported choices", async () => {
  const d = fixture(), adapter = YUE2_STYLE_ADAPTERS[0];
  d.controls.get("yLora").value = adapter.file; d.api.refresh();
  assert.equal(d.controls.get("yLoraClip").value, ""); assert.equal(d.controls.get("yCot").value, "off");
  assert.match(d.document.getElementById("yStyleAdapterHint").children[0].textContent, /same style adapter/);
  d.controls.get("yLoraClip").children = d.controls.get("yLoraClip").children.filter(option => option.value !== adapter.file);
  assert.equal(await d.api.select(adapter.file), false); assert.equal(d.errors.at(-1).reason, "yue2-style-missing");
  d.state.musicEngine = "yue2-gguf"; d.api.refresh(); assert.equal(d.document.getElementById("yStyleAdapter").disabled, true);
  assert.equal(await d.api.select(adapter.file), false); assert.equal(d.errors.at(-1).reason, "yue2-style-engine");
  assert.equal(d.selected.length, 0); assert.equal(d.controls.get("yCot").value, "off");
  assert.equal(d.api.validate({ engine: "yue2-gguf", lora: adapter.file, explicit: false }), null);
  assert.equal(d.api.validate({ engine: "yue2-gguf", lora: adapter.file, explicit: true }).reason, "yue2-style-engine");
});

test("a failed persistence hook restores the form and displays an error", async () => {
  const d = fixture({ onSelect: () => { throw new Error("Preference write failed"); } });
  assert.equal(await d.api.select(YUE2_STYLE_ADAPTERS[0].file), false);
  assert.equal(d.controls.get("yLora").value, ""); assert.equal(d.controls.get("yLoraClip").value, "");
  assert.equal(d.controls.get("yCot").value, "off"); assert.equal(d.controls.get("yLoraStrength").value, "55");
  assert.match(d.document.getElementById("yStyleAdapterHint").children[0].textContent, /Preference write failed/);
  d.api.destroy(); assert.equal(d.document.getElementById("yStyleAdapter"), null);
});

test("a newly discovered local adapter is selectable without changing Thinking or inventing publisher metadata", async () => {
  const d = fixture(), file = "community/new-voice.safetensors";
  const adapter = { file, label: "new-voice", engine: "yue2-comfy", fused: true, source: "local",
    recipe: { audioStrength: 1, plannerStrength: 1 } };
  d.catalog.push({ styleAdapter: adapter, installed: true, discovered: true });
  for (const id of ["yLora", "yLoraClip"]) {
    const option = new Element("option"); option.value = file; d.controls.get(id).append(option);
  }
  d.api.refresh();
  assert.ok(d.document.getElementById("yStyleAdapter").options.some(option => option.value === file && !option.disabled));
  assert.equal(await d.api.select(file), true);
  assert.deepEqual(d.selected.at(-1).patch, { lora: file, loraClip: file, loraStrength: 1, loraClipStrength: 1 });
  assert.equal(d.controls.get("yCot").value, "off", "an unknown publisher recipe cannot force Full");
  assert.equal(d.document.getElementById("yStyleAdapterHint").children[2].textContent, "Licence unknown");
  assert.doesNotMatch(d.document.getElementById("yStyleAdapterHint").children[0].textContent, /undefined|Full|Start Style/);
  assert.equal(d.api.validate({ engine: "yue2-comfy", lora: file, loraClip: "", cot: "off" }), null,
    "a locally discovered file may also be used in just one advanced slot");
});

test("installed subfolder paths replace bare catalogue choices and duplicate basenames stay distinct", async () => {
  const d = fixture(), known = YUE2_STYLE_ADAPTERS[0];
  for (const folder of ["one", "two"]) {
    const file = `${folder}/${known.file}`;
    d.catalog.push({ styleAdapter: { ...known, file, source: "catalog" }, installed: true, discovered: true });
    for (const id of ["yLora", "yLoraClip"]) {
      const option = new Element("option"); option.value = file; d.controls.get(id).append(option);
    }
  }
  d.api.refresh();
  const rows = yue2StyleAdapterRows(d.catalog);
  assert.ok(!rows.some(row => row.file === known.file), "the disabled bare preset is replaced by actual shelf paths");
  assert.ok(rows.some(row => row.file === `one/${known.file}`));
  assert.ok(rows.some(row => row.file === `two/${known.file}`));
  assert.throws(() => yue2StyleAdapterPatch(known.file, d.catalog), { reason: "yue2-style-unknown" });
  assert.equal(await d.api.select(`two/${known.file}`), true);
  assert.equal(d.selected.at(-1).patch.lora, `two/${known.file}`);
  assert.equal(d.controls.get("yLoraClip").value, `two/${known.file}`);
});

test("UI validation agrees with the server for native, paired, mismatched and score modes", async () => {
  const file = YUE2_STYLE_ADAPTERS[0].file;
  for (const engine of ["yue2-comfy", "yue2", "yue2-gguf"]) for (const explicit of [true, false]) for (const loraClip of [file, "", "custom.safetensors"]) for (const cot of ["full", "off", "melody"]) {
    const request = { engine, explicit, lora: file, loraClip, cot }, issue = yue2StyleSelectionIssue(request, YUE2_STYLE_ADAPTERS);
    let reason = null; try { validateYue2StyleAdapter(request); } catch (error) { reason = error.reason; }
    assert.equal(issue?.reason || null, reason, JSON.stringify(request));
  }
  assert.throws(() => yue2StyleAdapterPatch(file, YUE2_STYLE_ADAPTERS, "yue2"), { reason: "yue2-style-engine" });
  assert.throws(() => yue2StyleAdapterPatch("unknown.safetensors", YUE2_STYLE_ADAPTERS), { reason: "yue2-style-unknown" });
  const html = await readFile(new URL("../../web/index.html", import.meta.url), "utf8");
  for (const id of ["yLora", "yLoraClip", "yLoraStrength", "yLoraClipStrength", "yCot", "yLoraNote"]) assert.match(html, new RegExp(`id="${id}"`));
});

test("case-distinct local files remain independently selectable with exact paths", () => {
  const catalog = ["voices/Voice.safetensors", "voices/voice.safetensors"].map(file => ({
    styleAdapter: { file, label: file, engine: "yue2-comfy", fused: true, source: "local" },
    installed: true, discovered: true,
  }));
  assert.equal(yue2StyleAdapterRows(catalog).length, 2);
  for (const { styleAdapter } of catalog) {
    assert.equal(yue2StyleAdapterPatch(styleAdapter.file, catalog).lora, styleAdapter.file);
    assert.equal(yue2StyleAdapterPatch(styleAdapter.file.replaceAll("/", "\\"), catalog).loraClip, styleAdapter.file);
  }
  assert.throws(() => yue2StyleAdapterPatch("voices/VOICE.safetensors", catalog), { reason: "yue2-style-unknown" });
});
