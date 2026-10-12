import test from "node:test";
import assert from "node:assert/strict";
import { blankProject, blankTrack, blankClip, migrate, regionHashes } from "./store.js";
import { MIXER_CATALOG, catalogsAgree, handleMixerAction, mixerFutureSeconds, mixerJobPayload,
  normInserts, normVst3Plugin, normVst3Params, trackStatefulPath } from "./mixer.js";

const descriptor = (patch = {}) => ({ id: "vst_example", label: "Example Reverb",
  fingerprint: "a".repeat(64), hostVersion: "0.9.22", state: Buffer.from("base state").toString("base64"),
  latencySamples: 480, parameters: {
    wet: { type: "number", label: "Wet", default: 0.3, min: 0, max: 1, step: 0.001 },
    bypass: { type: "bool", label: "Bypass", default: false },
    mode: { type: "enum", label: "Mode", default: "Hall", values: ["Hall", "Room"] },
  }, ...patch });
const insert = patch => normInserts([{ id: "ins_vst", type: "vst3", enabled: true,
  plugin: descriptor(), params: { wet: 0.7 }, ...patch }])[0];

function fixture() {
  let doc = blankProject("vst-test", { bpm: 120, lengthBars: 16 });
  const track = blankTrack("Lead", "pluck", { id: "track" }), clip = blankClip(1, 16, {});
  clip.notes.push({ id: "note", bar: 1, beat: 1, tick: 0, durTicks: 960, pitch: 60, vel: 100, by: "user" });
  track.clips.push(clip); doc.tracks.push(track); doc = migrate(doc);
  const ctx = { safe: String, readProject: async () => structuredClone(doc),
    mutate: async (_slug, _request, _action, fn) => {
      const draft = structuredClone(doc), extra = fn(draft) || {};
      doc = migrate(draft); return { doc, dirty: [], extra };
    }, plugins: { validateInsert: async (id, params) => {
      assert.equal(id, "vst_example"); const plugin = normVst3Plugin(descriptor());
      return { plugin, params: normVst3Params(plugin, params) };
    } } };
  return { ctx, get doc() { return doc; }, call: (action, patch = {}) => handleMixerAction(action,
    { slug: "vst-test", target: "track", ...patch }, ctx) };
}

test("VST3 slot joins both catalogs as a stateful external device", () => {
  assert.deepEqual(MIXER_CATALOG.vst3, { label: "VST3 effect", stateful: true, external: true, params: {} });
  assert.deepEqual(catalogsAgree(structuredClone(MIXER_CATALOG)), []);
});

test("saved descriptor retains bounded identity, schema and state while dropping executable paths", () => {
  const clean = normVst3Plugin(descriptor({ path: "C:/untrusted/plugin.vst3", python: "evil.exe", extra: true }));
  assert.equal(clean.state, descriptor().state); assert.equal(clean.parameters.wet.step, 0.001);
  assert.equal(Object.hasOwn(clean, "path"), false); assert.equal(Object.hasOwn(clean, "python"), false);
  for (const patch of [{ id: "../evil" }, { fingerprint: "bad" }, { hostVersion: "" }, { state: "not base64" },
    { state: "YQ==".repeat(2 * 1024 * 1024) }, { latencySamples: Infinity },
    { parameters: { wet: { type: "number", default: 2, min: 0, max: 1 } } },
    { parameters: JSON.parse('{"__proto__":{"type":"bool","default":false}}') }])
    assert.throws(() => normVst3Plugin(descriptor(patch)), /VST3 effect/);
});

test("static plugin controls refuse unknown keys, coercion, automation and range errors", () => {
  const plugin = normVst3Plugin(descriptor());
  assert.deepEqual(normVst3Params(plugin, { wet: 0, bypass: true, mode: "Room" }), { wet: 0, bypass: true, mode: "Room" });
  for (const params of [{ extra: 1 }, { wet: "0.4" }, { wet: NaN }, { wet: 2 }, { wet: 0.3005 },
    { wet: { keys: [{ t: 1, v: 0.5 }] } }, { bypass: 1 }, { mode: "Arena" }, []])
    assert.throws(() => normVst3Params(plugin, params), /VST3/);
});

test("project migration preserves valid unavailable plugins on all buses and repairs only controls", () => {
  const f = fixture(), d = structuredClone(f.doc);
  d.tracks[0].inserts = [insert()];
  // Feed malformed values after normalization, just as a foreign document arrives.
  d.tracks[0].inserts[0].params = { wet: "bad", mode: "wrong", bypass: true, extra: 1 };
  d.master.inserts = [insert()]; d.returns = [{ id: "return", name: "Room", fader: 0, pan: 0, inserts: [insert()] }];
  const loaded = migrate(d);
  assert.deepEqual(loaded.tracks[0].inserts[0].params, { wet: 0.3, bypass: true, mode: "Hall" });
  assert.equal(loaded.master.inserts[0].plugin.state, descriptor().state);
  assert.equal(loaded.returns[0].inserts[0].plugin.id, "vst_example");
});

test("plugin state, fingerprint and controls reach cache signatures and render payloads", () => {
  const f = fixture(), d = structuredClone(f.doc), track = d.tracks[0];
  track.inserts = [insert()];
  assert.equal(trackStatefulPath(d, track), true); assert.equal(mixerFutureSeconds(d), 0.01);
  const first = regionHashes(d);
  track.inserts[0].plugin.state = Buffer.from("different state").toString("base64");
  assert.ok(regionHashes(d).every((hash, i) => hash !== first[i]));
  const second = regionHashes(d); track.inserts[0].plugin.fingerprint = "b".repeat(64);
  assert.ok(regionHashes(d).every((hash, i) => hash !== second[i]));
  const payload = mixerJobPayload(d).tracks.track.inserts[0];
  assert.equal(payload.plugin.fingerprint, "b".repeat(64)); assert.equal(payload.params.wet, 0.7);
  track.inserts[0].enabled = false;
  assert.equal(trackStatefulPath(d, track), false); assert.equal(mixerFutureSeconds(d), 0);
});

test("adding an effect resolves the private registry and saves no caller-supplied descriptor", async () => {
  const f = fixture();
  const result = await f.call("insert_add", { type: "vst3", plugin: "vst_example", params: { wet: 0.6 } });
  assert.equal(result.ok, true); const saved = f.doc.tracks[0].inserts[0];
  assert.equal(saved.plugin.id, "vst_example"); assert.equal(saved.params.wet, 0.6);
  await assert.rejects(f.call("insert_add", { type: "vst3", plugin: { id: "vst_example" } }), /registered VST3/);
  delete f.ctx.plugins;
  await assert.rejects(f.call("insert_add", { type: "vst3", plugin: "vst_example" }), /host is unavailable/);
});

test("parameter edits preserve base state and reject unavailable or changed enabled plugins", async () => {
  const f = fixture(); await f.call("insert_add", { type: "vst3", plugin: "vst_example" });
  const saved = f.doc.tracks[0].inserts[0], state = saved.plugin.state;
  await f.call("insert_set", { insert: saved.id, params: { wet: 0.9 } });
  assert.equal(f.doc.tracks[0].inserts[0].plugin.state, state);
  assert.equal(f.doc.tracks[0].inserts[0].params.wet, 0.9);
  await assert.rejects(f.call("insert_set", { insert: saved.id, params: { wet: 2 } }), /saved number schema/);
  f.ctx.plugins.validateInsert = async () => ({ plugin: descriptor({ fingerprint: "b".repeat(64) }), params: {} });
  await assert.rejects(f.call("insert_set", { insert: saved.id, params: { wet: 0.8 } }), /changed/);
  delete f.ctx.plugins;
  await assert.rejects(f.call("insert_set", { insert: saved.id, params: { wet: 0.8 } }), /unavailable/);
});

test("missing plugins remain bypassable, editable while disabled, and removable", async () => {
  const f = fixture(); await f.call("insert_add", { type: "vst3", plugin: "vst_example" });
  const id = f.doc.tracks[0].inserts[0].id; delete f.ctx.plugins;
  await f.call("insert_set", { insert: id, enabled: false });
  assert.equal(f.doc.tracks[0].inserts[0].enabled, false);
  await f.call("insert_set", { insert: id, params: { wet: 0.2 } });
  assert.equal(f.doc.tracks[0].inserts[0].params.wet, 0.2);
  await assert.rejects(f.call("insert_set", { insert: id, enabled: true }), /unavailable/);
  await f.call("insert_remove", { insert: id }); assert.equal(f.doc.tracks[0].inserts.length, 0);
});

test("external effects refuse coefficient curves instead of running a descriptor-less probe", async () => {
  const f = fixture();
  await assert.rejects(f.call("device_response", { type: "vst3" }), /do not expose.*frequency-response/);
});

test("undo can restore a bounded missing-plugin snapshot only while bypassed", async () => {
  const f = fixture(); delete f.ctx.plugins;
  const plugin = descriptor({ path: "C:/never/load.vst3" });
  await assert.rejects(f.call("insert_add", { type: "vst3", plugin: plugin.id, plugin_snapshot: plugin }), /only restore a bypassed/);
  await assert.rejects(f.call("insert_add", { type: "vst3", plugin: "different", plugin_snapshot: plugin, enabled: false }), /match the plugin ID/);
  await f.call("insert_add", { type: "vst3", plugin: plugin.id, plugin_snapshot: plugin, enabled: false, params: { wet: 0.8 } });
  const saved = f.doc.tracks[0].inserts[0];
  assert.equal(saved.enabled, false); assert.equal(saved.params.wet, 0.8);
  assert.equal(Object.hasOwn(saved.plugin, "path"), false);
  await assert.rejects(f.call("insert_set", { insert: saved.id, enabled: true }), /unavailable/);
  f.ctx.plugins = { validateInsert: async () => ({ plugin: descriptor({ fingerprint: "b".repeat(64) }), params: saved.params }) };
  await assert.rejects(f.call("insert_set", { insert: saved.id, enabled: true }), /changed/);
  assert.equal(f.doc.tracks[0].inserts[0].enabled, false);
  f.ctx.plugins.validateInsert = async () => ({ plugin: descriptor(), params: saved.params });
  await f.call("insert_set", { insert: saved.id, enabled: true });
  assert.equal(f.doc.tracks[0].inserts[0].enabled, true);
});
