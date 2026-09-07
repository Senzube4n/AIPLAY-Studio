import assert from "node:assert/strict";
import {
  blankProject, blankTrack, blankClip, noteEvents, audioEvents,
  audioJobClips, regionHashes,
} from "./store.js";

const doc = blankProject("return-sidechain", { bpm: 120, lengthBars: 8 });
const key = blankTrack("Key", "drums", { id: "key" });
const body = blankTrack("Body", "pluck", { id: "body" });
const keyClip = blankClip(1, 8, {});
keyClip.notes.push({ id: "key-note", bar: 1, beat: 1, tick: 0,
  durTicks: 120, pitch: 36, vel: 100, by: "agent" });
key.clips.push(keyClip);
key.audioClips = [{ id: "key-audio", file: "key.wav", bar: 1, beat: 2, tick: 0,
  shiftSamples: 0, offsetSamples: 0, durSamples: 4800, gainDb: 0 }];
const bodyClip = blankClip(1, 8, {});
bodyClip.notes.push({ id: "body-note", bar: 5, beat: 1, tick: 0,
  durTicks: 1920, pitch: 60, vel: 100, by: "agent" });
body.clips.push(bodyClip);
body.sends = [{ to: "return", level: 0, pre: false }];
const compressor = { id: "duck", type: "compressor", enabled: true,
  params: { sidechain: key.id, release_ms: 2000 } };
doc.returns = [{ id: "return", name: "Ducked return", fader: 0, pan: 0,
  inserts: [compressor] }];
doc.tracks.push(key, body);

assert.equal(noteEvents(doc).find((n) => n.trackId === key.id).reach1, Infinity,
  "An earlier key note must remain in later jobs to reconstruct return compressor state");
assert.equal(audioEvents(doc).find((a) => a.trackId === key.id).reach1, Infinity);
assert.equal(audioJobClips(doc, "unused", 8, 16).length, 1,
  "The later region job must include the earlier recorded sidechain source");
let before = regionHashes(doc);
keyClip.notes[0].pitch = 38;
assert.notEqual(regionHashes(doc)[1], before[1],
  "Editing the early key note must invalidate the later return audio");
before = regionHashes(doc);
key.audioClips[0].gainDb = -6;
assert.notEqual(regionHashes(doc)[1], before[1],
  "Editing the early recorded key must invalidate the later return audio");

compressor.enabled = false;
assert.ok(Number.isFinite(noteEvents(doc).find((n) => n.trackId === key.id).reach1));
assert.equal(audioJobClips(doc, "unused", 8, 16).length, 0);
before = regionHashes(doc);
keyClip.notes[0].pitch = 42;
key.audioClips[0].gainDb = -9;
assert.equal(regionHashes(doc)[1], before[1],
  "A disabled return compressor must not introduce a sidechain dependency");
console.log("8 return-sidechain state and cache dependency checks passed");
