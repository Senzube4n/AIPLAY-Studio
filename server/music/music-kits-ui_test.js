import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { mountMusicKits } from "../../web/music-kits.js";

class Element {
  constructor(dataset = {}, tag = "div") { Object.assign(this, { dataset, tag, value: "", textContent: "", hidden: false, disabled: false, checked: false, readOnly: false, options: [], classList: { add() {} } }); }
  set innerHTML(value) {
    this.html = value;
    this.options = [...value.matchAll(/<option value="([^"]*)"[^>]*>(.*?)<\/option>/gs)].map(m => ({ value: m[1] }));
    if (this.tag === "select") this.value = this.options[0]?.value || "";
  }
  get innerHTML() { return this.html || ""; }
  closest() { return this; }
}
function dom() {
  const root = new Element(), elements = new Map(), buttons = new Map(), handlers = {};
  Object.defineProperty(root, "innerHTML", { set(html) {
    for (const match of html.matchAll(/<(\w+)\b([^>]*\bdata-(kit|act)="([^"]+)"[^>]*)>/g)) {
      const [, tag, attrs, kind, name] = match, element = new Element({ [kind]: name }, tag);
      element.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || ""; element.hidden = /\bhidden\b/.test(attrs);
      if (kind === "kit") elements.set(name, element); else buttons.set(name, element);
      if (tag === "select") {
        const from = match.index + match[0].length; element.innerHTML = html.slice(from, html.indexOf("</select>", from));
      }
    }
  } });
  root.querySelector = selector => { const m = /\[data-(kit|act)="([^"]+)"\]/.exec(selector); return m?.[1] === "kit" ? elements.get(m[2]) : buttons.get(m?.[2]); };
  root.querySelectorAll = selector => selector === "button" ? [...buttons.values()] : [...elements.values()].filter(e => ["input", "select", "textarea"].includes(e.tag));
  root.addEventListener = (kind, handler) => { handlers[kind] = handler; };
  root.contains = () => true;
  const fire = (kind, element) => handlers[kind]({ target: element });
  const idle = async () => { for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 2)); if (!buttons.get("refresh")?.disabled) return; } throw new Error("UI action did not settle"); };
  return { root, elements, buttons, fire, idle };
}

test("kit UI discovers score versions and requires review plus an explicit render click", async () => {
  const d = dom(), calls = [], loaded = [];
  const variant = { id: "theme", hash: "variant-hash", name: "Theme", role: "theme", cot: "full", score: { abc: "fixture ABC", sha256: "score-hash", harmony: {}, facts: { bars_per_voice: 2, nominal_seconds: 4 } },
    recipe: { style: "Piano", lyrics: "Words", seed: 42, engine: "yue2", quantization: "none", instrumental: false } };
  let kit = { id: `kit-${"a".repeat(24)}`, name: "Theme kit", theme: "Story identity", revision: 1, variants: [variant], renders: [] };
  const request = { engine: "yue2", quantization: "none", caption: "Piano", lyrics: "Words", seed: 42, abc: "fixture ABC", cot: "full" };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body });
    let result;
    if (url === "/api/score" && !body) result = { scores: [{ slug: "score-real", title: "Existing theme" }] };
    else if (url === "/api/score") result = body.scores === false ? { versions: [{ id: "v-real", label: "Original" }] }
      : { versions: [{ id: "v-real", score: { text: "real source bytes" }, style: "Source piano", lyrics: "Original words", seed: 9 }] };
    else if (url === "/api/mv/projects") result = { projects: [] };
    else if (!body) result = url.includes("?id=") ? { kit } : { kits: [{ ...kit, variants: 1 }], engines: [] };
    else if (body.action === "prepare") {
      kit = { ...kit, revision: 2 }; result = { kit, prepared: { id: "review-one", request, notationSeconds: 4 } };
    } else if (body.action === "render") {
      assert.equal(body.preparedId, "review-one"); assert.ok(body.idempotencyKey);
      kit = { ...kit, revision: 4, renders: [{ id: "render-one", jobId: "exact-job", variantId: "theme", request, status: "queued" }] };
      result = { kit, render: kit.renders[0] };
    } else throw new Error(`Unexpected call ${url} ${body?.action}`);
    return { ok: true, json: async () => structuredClone(result) };
  };
  mountMusicKits({ root: d.root, fetch, onLoadRequest: body => loaded.push(body) }); await d.idle();
  assert.match(d.elements.get("sourceScore").innerHTML, /Existing theme/);
  d.elements.get("sourceScore").value = "score-real"; d.fire("change", d.elements.get("sourceScore")); await d.idle();
  d.elements.get("sourceVersion").value = "v-real"; d.fire("change", d.elements.get("sourceVersion")); await d.idle();
  assert.equal(d.elements.get("sourceAbc").value, "real source bytes"); assert.equal(d.elements.get("sourceStyle").value, "Source piano");
  d.elements.get("pick").value = kit.id; d.fire("change", d.elements.get("pick")); await d.idle();
  assert.equal(d.buttons.get("render").disabled, true);
  d.fire("click", d.buttons.get("prepare")); await d.idle();
  assert.equal(calls.filter(c => c.body?.action === "render").length, 0);
  assert.deepEqual(JSON.parse(d.elements.get("requestJson").textContent), request);
  d.fire("click", d.buttons.get("load")); await d.idle();
  assert.deepEqual(loaded, [request]); assert.equal(calls.filter(c => c.body?.action === "render").length, 0);
  d.fire("click", d.buttons.get("render")); await d.idle();
  assert.equal(calls.filter(c => c.body?.action === "render").length, 1);
  assert.match(d.elements.get("renders").innerHTML, /exact-job/);
  assert.equal(d.buttons.get("render").disabled, true, "consumed review cannot be clicked again");
});

test("editing a reviewed request invalidates the render action without losing the saved kit", async () => {
  const d = dom();
  const variant = { id: "theme", name: "Theme", role: "theme", score: { abc: "ABC", sha256: "h", facts: { bars_per_voice: 1, nominal_seconds: 2 } }, recipe: { style: "Piano", lyrics: "Words", seed: 1, engine: "yue2" } };
  const kit = { id: `kit-${"b".repeat(24)}`, name: "Saved", revision: 1, variants: [variant], renders: [] };
  const fetch = async (url, opts = {}) => ({ ok: true, json: async () => url === "/api/score" ? { scores: [] }
    : url === "/api/mv/projects" ? { projects: [] } : opts.body ? { kit, prepared: { id: "p", request: { engine: "yue2", seed: 1 }, notationSeconds: 2 } }
      : url.includes("?id=") ? { kit } : { kits: [{ ...kit, variants: 1 }] } });
  mountMusicKits({ root: d.root, fetch }); await d.idle();
  d.elements.get("pick").value = kit.id; d.fire("change", d.elements.get("pick")); await d.idle();
  d.fire("click", d.buttons.get("prepare")); await d.idle(); assert.equal(d.buttons.get("render").disabled, false);
  d.elements.get("renderSeed").value = "99"; d.fire("input", d.elements.get("renderSeed"));
  assert.equal(d.buttons.get("render").disabled, true); assert.equal(d.elements.get("review").hidden, true);
  assert.equal(d.elements.get("title").textContent, "Saved");
});

test("composer handoff preserves short reviewed durations and resets omitted backend defaults", async () => {
  const app = await readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const between = (start, end) => {
    const from = app.indexOf(start), to = app.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `find real composer code: ${start}`);
    return app.slice(from, to);
  };
  const fields = new Map();
  const $ = id => {
    if (!fields.has(id)) fields.set(id, { value: "", checked: false, style: {}, focus() {} });
    return fields.get(id);
  };
  // Browser range inputs clamp to bounds and snap to step on assignment.
  const range = { min: "30", max: "300", step: "10" }; let duration = "240";
  Object.defineProperty(range, "value", { get: () => duration, set: value => {
    let number = Math.max(+range.min, Math.min(+range.max, Number(value)));
    if (range.step !== "any") number = +range.min + Math.round((number - +range.min) / +range.step) * +range.step;
    duration = String(number);
  } });
  fields.set("maxDur", range); $("yPrecision").value = "fp8";
  const state = { musicEngine: "yue2", mode: "song", audioRef: { latent: "old-reference" },
    musicEngines: { yue2: { cot: ["full", "melody", "off"], score: true, maxDuration: 300 },
      "yue2-gguf": { cot: ["full", "melody", "off"], runtime: "audiocpp", maxDuration: 300 } },
    musicModels: [{ value: "native-q4", engine: "yue2-gguf", precision: "q4_0" }, { value: "native-q8", engine: "yue2-gguf", precision: "q8_0" }] };
  let load, precision = "q8_0"; const choices = [];
  const context = vm.createContext({ $, state, structuredClone,
    document: { querySelectorAll: () => [] },
    mountMusicWorkflows: options => { load = options.onLoadRequest; },
    ggufPrecision: () => precision,
    chooseMusicModel: async value => { choices.push(value); const row = state.musicModels.find(r => r.value === value); state.musicEngine = row.engine; precision = row.precision; },
    yueEngine: () => true, aceEngine: () => false, captionValue: () => $("caption").value,
    setMode: value => { state.mode = value; }, fmt: value => `${value}s`,
    stopExtend() {}, setSimple() {}, setGuided() {}, paintSeed() {}, paintAref() {}, countChars() {}, musicEnginePaint() {}, musicFitPaint() {}, setView() {},
  });
  // Run the real engine painter's duration block after the handoff, as the app does.
  vm.runInContext(`function musicEnginePaint() { const eng = state.musicEngines[state.musicEngine];
    ${between("  const durMax = eng.maxDuration || 300;", "  /* The note says what THIS engine")}
  }`, context);
  vm.runInContext(between('$("maxDur").oninput = ', '$("qSteps").oninput = '), context);
  vm.runInContext(between("function currentSpec(", "/* The YuE2 rows in Advanced"), context);
  vm.runInContext(between("function yueSpec()", "/** A re-roll is:"), context);
  vm.runInContext(between("mountMusicWorkflows({ onLoadRequest:", "/* LAST, and asynchronous."), context);
  const spec = () => vm.runInContext("currentSpec(false)", context);
  const base = { engine: "yue2", caption: "Piano", lyrics: "Words", abc: "Reviewed ABC", cot: "melody", seed: 0, scoreSlug: "theme", scoreVersion: "v1" };
  for (const maxDuration of [8, 36, 36.5]) {
    await load({ ...base, maxDuration });
    assert.equal(+range.value, maxDuration); assert.equal(spec().maxDuration, maxDuration);
    assert.equal(spec().abc, base.abc); assert.equal(spec().scoreVersion, "v1");
  }
  assert.equal(spec().quantization, "none", "old Python FP8 must not leak");
  assert.equal(spec().audioRef, undefined);
  await assert.rejects(load({ ...base, maxDuration: 301 }), /between 1 and 300/);
  assert.equal(+range.value, 36.5, "unsupported duration must not partly replace the composer");
  await load(base);
  assert.equal(spec().maxDuration, undefined, "an omitted reviewed duration stays automatic");
  assert.equal($("maxDurV").textContent, "Automatic");
  range.value = "42"; range.oninput({ type: "input" });
  assert.equal(spec().maxDuration, 42, "an explicit slider edit replaces automatic duration");
  state.musicEngine = "yue2-gguf";
  await load({ engine: "yue2-gguf", caption: "Piano", lyrics: "Words", cot: "full", seed: 0 });
  assert.deepEqual(choices, ["native-q4"]); assert.equal(spec().quantization, "q4_0", "old native Q8 must not leak");
  assert.equal(spec().narSteps, 32); assert.equal(spec().cfgScale, undefined);
});
