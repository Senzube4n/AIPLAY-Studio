import test from "node:test";
import assert from "node:assert/strict";
import { mountMusicArtifacts } from "../../web/music-artifacts.js";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function harness(t) {
  const nodes = new Map(), calls = [];
  function node(name) {
    if (!nodes.has(name)) {
      const attributes = new Map();
      nodes.set(name, { value: "", handlers: {}, disabled: false, srcWrites: 0, textContent: "", innerHTML: "",
        get src() { return attributes.get("src"); }, set src(value) { attributes.set("src", value); this.srcWrites++; },
        getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key), pause() {},
        addEventListener(type, handler) { this.handlers[type] = handler; } });
    }
    return nodes.get(name);
  }
  const root = { dataset: {}, classList: { add() {} }, querySelector: selector => node(/="([^"]+)"/.exec(selector)[1]) };
  Object.defineProperty(root, "innerHTML", { set(html) { for (const match of html.matchAll(/data-mf="([^"]+)"/g)) node(match[1]);
    for (const [key, value] of Object.entries({ stage: "latent", tiles: "512", steps: "32", seed: "0" })) node(key).value = value;
  } });
  const prepared = id => ({ id, state: "prepared", source: "source.flac", sourceIdentity: "a".repeat(64), manifestSha256: "b".repeat(64),
    stage: "latent", options: { seed: 5, narSteps: 32, vaeCoreFrames: 512 }, stages: { reuse: ["plan", "semantic", "latent"], run: ["decode"] } });
  const state = { status: async id => ({ prepared: prepared(id) }), inspect: async () => ({ inspection: { source: "source.flac", audioSeconds: 30,
    request: { seed: 5 }, generation: { ode_steps: 32 }, truncated: {}, identity: "a", files: {}, weights: {} } }) };
  const fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null; calls.push(body);
    let answer;
    if (!body) answer = { sources: [{ file: "source.flac" }, { file: "other.flac" }], prepared: [prepared("first"), prepared("second")] };
    else if (body.action === "inspect") answer = await state.inspect();
    else if (body.action === "prepare") answer = { prepared: prepared("new") };
    else if (body.action === "status") answer = await state.status(body.preparedId);
    else if (body.action === "render") answer = { prepared: { ...prepared(body.preparedId), state: "done", job: { file: "new.flac" } } };
    return { ok: true, json: async () => answer };
  };
  const mounted = await mountMusicArtifacts({ root, fetch }); t.after(() => mounted.destroy());
  return { node, calls, state, prepared, fire: (name, type = "click") => node(name).handlers[type]?.() };
}

test("prepare stays separate from render and latent mode sends no synthesis controls", async t => {
  const h = await harness(t); await h.fire("inspect"); await h.fire("prepare");
  const request = h.calls.find(c => c?.action === "prepare");
  assert.deepEqual(request, { action: "prepare", source: "source.flac", stage: "latent", vaeCoreFrames: 512 });
  assert.equal(h.calls.filter(c => c?.action === "render").length, 0);
  await h.fire("render"); assert.equal(h.calls.find(c => c?.action === "render").preparedId, "new");
  assert.equal(h.node("candidate").src, "/api/audio/new.flac");
});

test("switching saved requests disables the old render while loading and preserves source playback", async t => {
  const h = await harness(t); h.node("saved").value = "first"; await h.fire("saved", "change");
  assert.equal(h.node("original").srcWrites, 1);
  const pending = deferred(); h.state.status = async () => pending.promise;
  h.node("saved").value = "second"; const switching = h.fire("saved", "change");
  assert.equal(h.node("render").disabled, true);
  await h.fire("render"); assert.equal(h.calls.filter(c => c?.action === "render").length, 0);
  pending.resolve({ prepared: h.prepared("second") }); await switching;
  assert.equal(h.node("original").srcWrites, 1, "same source does not restart during refreshed status");
  await h.fire("render"); assert.equal(h.calls.find(c => c?.action === "render").preparedId, "second");
});

test("late source verification cannot enable prepare for a different source", async t => {
  const h = await harness(t), pending = deferred(); h.state.inspect = () => pending.promise;
  const inspecting = h.fire("inspect"); h.node("source").value = "other.flac"; await h.fire("source", "change");
  pending.resolve({ inspection: { source: "source.flac" } }); await inspecting;
  assert.equal(h.node("prepare").disabled, true);
  assert.equal(h.calls.filter(c => c?.action === "prepare").length, 0);
});
