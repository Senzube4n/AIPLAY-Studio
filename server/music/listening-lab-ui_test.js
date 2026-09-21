import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createListeningLab } from "./listening-lab.js";
import { mountMusicListeningLab } from "../../web/music-listening-lab.js";

function dom() {
  const fields = new Map(), groups = new Map(), actions = new Map();
  const element = (dataset = {}) => ({ dataset, value: "", checked: false, disabled: false, handlers: {}, textContent: "",
    addEventListener(type, fn) { this.handlers[type] = fn; }, closest() { return this; }, pause() {}, play: async () => {} });
  function controls(html, attribute) {
    const result = new Map();
    const expression = new RegExp(`<([a-z]+)\\b([^>]*${attribute}="([^"]+)"[^>]*)>`, "g");
    for (const match of html.matchAll(expression)) {
      const [, tag, attrs, name] = match, node = element(); node.checked = /\bchecked\b/.test(attrs);
      node.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || "";
      if (tag === "textarea") node.value = html.slice(match.index + match[0].length, html.indexOf("</textarea>", match.index));
      if (tag === "select") {
        const options = html.slice(match.index + match[0].length, html.indexOf("</select>", match.index));
        const selected = /<option([^>]*\bselected[^>]*)>([^<]*)<\/option>/.exec(options) || /<option([^>]*)>([^<]*)<\/option>/.exec(options);
        node.value = selected ? /value="([^"]*)"/.exec(selected[1])?.[1] ?? selected[2] : "";
      }
      result.set(name, node);
    }
    return result;
  }
  const root = { dataset: {}, classList: { add() {} }, handlers: {}, contains: () => true,
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelector(selector) {
      const match = /\[data-ml(?:-action)?="([^"]+)"\]/.exec(selector);
      return selector.includes("-action") ? [...actions.values()].flat().find(x => x.dataset.mlAction === match?.[1]) || null : fields.get(match?.[1]);
    },
    querySelectorAll(selector) {
      if (selector === "button") return [...actions.values()].flat();
      if (selector === "[data-eval-index]") return groups.get("drafts") || [];
      if (selector === "[data-rating-case]") return groups.get("ratings") || [];
      const action = /\[data-ml-action="([^"]+)"\]/.exec(selector)?.[1];
      return action ? [...actions.values()].flat().filter(x => x.dataset.mlAction === action) : [];
    },
  };
  function parseActions(html, group) {
    actions.set(group, [...html.matchAll(/<button\b([^>]*data-ml-action="([^"]+)"[^>]*)>/g)].map(m => element({ mlAction: m[2],
      ...(m[1].match(/data-case="([^"]+)"/) ? { case: /data-case="([^"]+)"/.exec(m[1])[1] } : {}),
      ...(m[1].match(/data-index="([^"]+)"/) ? { index: /data-index="([^"]+)"/.exec(m[1])[1] } : {}) })));
  }
  Object.defineProperty(root, "innerHTML", { set(html) {
    for (const [name, node] of controls(html, "data-ml")) {
      fields.set(name, node);
      Object.defineProperty(node, "innerHTML", { get() { return this.html || ""; }, set(content) {
        this.html = content;
        if (name === "caseDrafts" || name === "review") {
          parseActions(content, name); const isDraft = name === "caseDrafts", marker = isDraft ? "data-eval-index" : "data-rating-case", attr = isDraft ? "data-eval" : "data-rating";
          const starts = [...content.matchAll(new RegExp(`${marker}="([^"]+)"`, "g"))];
          groups.set(isDraft ? "drafts" : "ratings", starts.map((m, i) => {
            const values = controls(content.slice(m.index, starts[i + 1]?.index ?? content.length), attr);
            return { dataset: isDraft ? { evalIndex: m[1] } : { ratingCase: m[1] }, fields: values,
              querySelector: selector => values.get(/="([^"]+)"/.exec(selector)[1]) };
          }));
        }
      } });
    }
    parseActions(html, "root");
  } });
  return { root, fields, groups, fire: action => {
    const button = root.querySelector(`[data-ml-action="${action}"]`); assert.ok(button, `button ${action} exists`);
    return root.handlers.click({ target: button });
  } };
}

async function harness(t, ready = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "listening-ui-"));
  const d = dom(), queued = [], calls = [], sources = new Map([["source.flac", { seconds: 50, sha256: "a".repeat(64) }]]), jobs = new Map();
  const cap = { engine: "yue2-comfy", ready, reason: ready ? null : "No trained adapter is installed.", checkpoints: [{ name: "yue2.safetensors", identity: "checkpoint" }], adapters: ready ? [{ name: "mine_test.safetensors", identity: "adapter" }] : [] };
  const store = createListeningLab({ appData: dir, capabilities: async () => cap, inspectSource: async file => sources.get(file),
    submitGenerate: async ({ request }) => { const id = `job${queued.length + 1}`; queued.push(request); jobs.set(id, { id, state: "queued" }); return { job: { id } }; },
    readJob: async id => jobs.get(id), cancelJob: async () => ({ state: "cancelled" }), random: () => 0 });
  const fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null; calls.push({ url, body });
    try { return { ok: true, json: async () => url === "/api/status" ? { library: [{ file: "source.flac", title: "Source recording" }] } : await store.request(body, "user") }; }
    catch (e) { return { ok: false, json: async () => ({ error: e.message }) }; }
  };
  const mounted = mountMusicListeningLab({ root: d.root, fetch });
  t.after(async () => { mounted.destroy(); await rm(dir, { recursive: true, force: true }); });
  await mounted.refresh();
  return { ...d, queued, calls, store, jobs, sources,
    fill() {
      for (const [key, value] of Object.entries({ name: "Held-out pair", purpose: "Listen for articulation", trainingFile: "source.flac", trainingStart: "0", trainingSeconds: "8", adapter: "mine_test.safetensors", checkpoint: "yue2.safetensors" })) d.fields.get(key).value = value;
      const c = d.groups.get("drafts")[0].fields; c.get("caption").value = "Piano"; c.get("lyrics").value = "New words"; c.get("seed").value = "0";
    },
    finish() { for (const [id, job] of jobs) { Object.assign(job, { state: "done", file: `${id}.flac`, seconds: 42, sha256: "b".repeat(64) }); sources.set(job.file, { seconds: 42, sha256: job.sha256 }); } },
  };
}

test("listening UI saves a review before an explicit paired render and keeps labels hidden until reveal", async t => {
  const h = await harness(t); h.fill(); await h.fire("create");
  assert.equal(h.queued.length, 0); assert.match(h.fields.get("review").innerHTML, /A\/B labels hidden/);
  assert.ok(h.calls.some(c => c.body?.action === "create" && c.body.cases[0].seed === 0));
  await h.fire("start"); assert.equal(h.queued.length, 2);
  assert.equal(h.queued[0].lora, ""); assert.equal(h.queued[1].lora, "mine_test.safetensors");
  assert.equal(h.root.querySelector('[data-ml-action="start"]').disabled, true);
  h.finish(); await h.fire("refreshJobs");
  assert.match(h.fields.get("review").innerHTML, /\/api\/audio\/job1.flac/);
  assert.doesNotMatch(h.fields.get("review").innerHTML, /Take A · base model/);
  const rating = h.groups.get("ratings")[0].fields;
  for (const [key, value] of Object.entries({ A: "4", B: "2", preference: "A", unwantedA: "", unwantedB: "Less clear", notes: "I prefer the articulation in A" })) rating.get(key).value = value;
  await h.fire("rate"); assert.match(h.fields.get("review").innerHTML, /before reveal/);
  await h.fire("reveal"); assert.match(h.fields.get("review").innerHTML, /Take A · base model/); assert.match(h.fields.get("review").innerHTML, /Take B · trained adapter/);
  assert.ok(h.calls.every(c => c.url !== "/api/generate"), "only the explicit shared experiment start owns queue submission");
});

test("unavailable adapter capability is actionable and cannot look ready", async t => {
  const h = await harness(t, false);
  assert.equal(h.root.querySelector('[data-ml-action="create"]').disabled, true);
  assert.match(h.fields.get("capability").textContent, /No trained adapter/);
  assert.equal(h.queued.length, 0);
});
