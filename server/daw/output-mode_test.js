/** Output is a sound contract: legacy hashes, new-project unity, API and UI parity. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { blankProject, blankTrack, blankClip, migrate, regionHashes, dirtyBetween, regionsOf } from "./store.js";
import { masterOutputMode, isDefaultMixer, masterMixSig, mixerJobPayload,
  auditionMixerPayload, handleMixerAction } from "./mixer.js";
import { rackTools } from "./mcp-rack.js";

function legacyDoc() {
  const doc = blankProject("saved mix", { lengthBars: 12 });
  delete doc.master.stereo; delete doc.master.outputMode;
  const track = blankTrack("voice", "pluck", { id: "trk_voice" });
  const clip = blankClip(1, 12, { id: "clp_fixed" });
  clip.notes.push({ id: "nt_fixed", bar: 1, beat: 1, tick: 0, pitch: 60, vel: 80, durTicks: 480 });
  track.clips.push(clip); doc.tracks.push(track);
  return migrate(doc);
}

test("new projects opt into clean stereo; opening old or explicit legacy documents preserves old contracts", () => {
  const fresh = migrate(blankProject("new"));
  assert.equal(fresh.master.outputMode, "transparent");
  assert.equal(fresh.master.stereo, true);
  const old = legacyDoc(), before = regionHashes(old);
  assert.equal(masterOutputMode(old), "legacySoftClip");
  assert.equal(isDefaultMixer(old), true);
  assert.equal(masterMixSig(old.master), "");
  assert.equal(mixerJobPayload(old).outputMode, undefined);
  old.master.outputMode = "legacySoftClip";
  assert.deepEqual(regionHashes(old), before);
  assert.equal(mixerJobPayload(old).outputMode, undefined);
  assert.equal(migrate(old).master.outputMode, undefined);
});

test("mode switches re-key sounding regions and the mono rack path, then restore the old cache", () => {
  const doc = legacyDoc(), before = regionHashes(doc);
  doc.master.outputMode = "transparent";
  assert.equal(isDefaultMixer(doc), false);
  assert.equal(mixerJobPayload(doc).outputMode, "transparent");
  assert.equal(mixerJobPayload(doc).stereo, false);
  const clean = regionHashes(doc), dirty = dirtyBetween(before, clean, regionsOf(doc));
  assert.ok(dirty.some(r => r.idx === 0));
  assert.notEqual(clean[0], before[0]);
  assert.equal(clean.at(-1), before.at(-1), "silent regions need no audio change");
  delete doc.master.outputMode;
  assert.deepEqual(regionHashes(doc), before);
});

test("dry and track-chain auditions inherit mode while leaving the mix's master effects out", () => {
  const doc = legacyDoc();
  assert.equal(auditionMixerPayload(doc, "trk_voice"), null);
  const oldStereo = auditionMixerPayload(doc, "trk_voice", { stereo: true });
  assert.equal(oldStereo.outputMode, undefined);
  doc.master.outputMode = "transparent"; doc.master.stereo = true;
  doc.master.inserts.push({ id: "ins_master", type: "saturator", enabled: true, params: {} });
  doc.tracks[0].fader = -3;
  const dry = auditionMixerPayload(doc, "trk_voice");
  assert.equal(dry.stereo, true); assert.equal(dry.outputMode, "transparent");
  assert.equal(dry.tracks.trk_voice.fader, 0);
  assert.deepEqual(dry.master, { inserts: [], fader: 0 });
  const chain = auditionMixerPayload(doc, "trk_voice", { throughChain: true });
  assert.equal(chain.tracks.trk_voice.fader, -3);
  assert.deepEqual(chain.master, { inserts: [], fader: 0 });
  assert.equal(chain.outputMode, "transparent");
  assert.equal(auditionMixerPayload(doc, "trk_voice", { stereo: false }).stereo, false);
});

test("MCP uses the same validating mutation as the UI and records an undoable mode change", async () => {
  let doc = legacyDoc(); const ledger = [], requests = [];
  const ctx = { safe: String, async mutate(slug, b, action, fn) {
    const copy = structuredClone(doc), before = regionHashes(doc), extra = fn(copy);
    const dirty = dirtyBetween(before, regionHashes(copy), regionsOf(copy));
    doc = copy; if (extra.ledger) ledger.push(extra.ledger);
    return { doc, extra, dirty };
  } };
  const tools = rackTools({ slugOf: String, daw: async body => {
    requests.push(body); return handleMixerAction(body.action, body, ctx);
  } });
  const mixer = tools.find(t => t.name === "daw_mixer");
  assert.deepEqual(mixer.inputSchema.properties.output_mode.enum, ["transparent", "legacySoftClip"]);
  const result = await mixer.run({ op: "set", slug: "saved", target: "master", output_mode: "transparent" });
  assert.equal(requests[0].output_mode, "transparent");
  assert.equal(doc.master.outputMode, "transparent");
  assert.equal(result.output_mode, "transparent");
  assert.ok(result.dirty.length > 0); assert.match(ledger[0].detail, /transparent/);
  for (const value of [null, true, "clean", "invalid"]) {
    await assert.rejects(mixer.run({ op: "set", slug: "saved", target: "master", output_mode: value }), /output_mode/);
  }
  await assert.rejects(mixer.run({ op: "set", slug: "saved", target: "trk_voice", output_mode: "transparent" }), /master/);
  assert.equal(doc.master.outputMode, "transparent");
  const undone = await mixer.run({ op: "set", slug: "saved", target: "master", output_mode: "legacySoftClip" });
  assert.equal(undone.output_mode, "legacySoftClip");
  assert.equal(doc.master.outputMode, undefined);
});

test("master selector exposes both modes and sends the current value as Undo", () => {
  const source = readFileSync(new URL("../../web/daw.js", import.meta.url), "utf8");
  const start = source.indexOf('  if (kind === "master") {\n    const output = document.createElement("select");');
  assert.ok(start >= 0);
  const end = source.indexOf("\n  return el;", start);
  const elements = [], acts = [];
  const createElement = tag => {
    const el = { tag, children: [], handlers: {}, attrs: {},
      appendChild(child) { this.children.push(child); },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(event, fn) { this.handlers[event] = fn; } };
    elements.push(el); return el;
  };
  const host = {}, el = createElement("strip");
  vm.runInNewContext(source.slice(start, end), {
    kind: "master", host, el, document: { createElement }, S: { slug: "saved" }, act: (...args) => acts.push(args),
  });
  const selector = elements.find(e => e.tag === "select");
  assert.deepEqual(Array.from(selector.children, e => e.textContent), ["Clean", "Soft clip"]);
  assert.equal(selector.value, "legacySoftClip");
  selector.value = "transparent"; selector.handlers.change();
  assert.equal(acts[0][0].output_mode, "transparent");
  assert.equal(acts[0][1].output_mode, "legacySoftClip");
  assert.equal(selector.attrs["aria-label"], "Master output");
});
