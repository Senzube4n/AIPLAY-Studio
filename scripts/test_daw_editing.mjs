import assert from "node:assert/strict";
import { resizeNoteDurations } from "../web/daw-editing.js";

const four = [
  { bar: 1, den: 4, qStart: 0, ticksPerBar: 3840 },
  { bar: 2, den: 4, qStart: 4, ticksPerBar: 3840 },
];
const mixed = [
  { bar: 1, den: 4, qStart: 0, ticksPerBar: 3840 },
  { bar: 2, den: 8, qStart: 4, ticksPerBar: 6720 },
  { bar: 3, den: 4, qStart: 7.5, ticksPerBar: 3840 },
];
const note = (id, durTicks, bar = 1, beat = 1, tick = 0) => ({ id, bar, beat, tick, durTicks });
let passed = 0;
function test(label, fn) { fn(); passed++; console.log(`ok ${label}`); }
const resize = (notes, anchorId, deltaQ, extra = {}) => resizeNoteDurations({ notes, anchorId, deltaQ, timeline: four, ...extra });
const lengths = (result) => result.map((n) => n.durTicks);

test("grabbing the second selected note keeps unequal lengths and uses its own edge", () => {
  const notes = [note("first", 480), note("grabbed", 1440, 1, 3)];
  assert.deepEqual(lengths(resize(notes, "grabbed", 0.5)), [960, 1920]);
});
test("selection order does not determine the resize anchor", () => {
  const a = note("a", 480), b = note("b", 1440, 1, 3);
  assert.deepEqual(resize([a, b], "b", 0.5), resize([b, a], "b", 0.5).reverse());
});
test("snap uses the grabbed duration and applies one shared delta", () => {
  assert.deepEqual(lengths(resize([note("a", 300), note("b", 1000)], "b", 0.2, { grid: 480 })), [260, 960]);
});
test("grid off permits a one-tick change, not the old 60-tick minimum", () => {
  assert.deepEqual(lengths(resize([note("a", 10)], "a", 1 / 960)), [11]);
});
test("shortening clamps at one tick without equalizing longer selected notes", () => {
  assert.deepEqual(lengths(resize([note("a", 240), note("b", 960)], "b", -0.5)), [1, 480]);
});
test("a grabbed note crossing 4/4 into 7/8 walks both beat units", () => {
  // Quarter 3 → 4.5: 960 quarter-beat ticks + 960 eighth-beat ticks.
  assert.deepEqual(lengths(resize([note("a", 1920, 1, 4)], "a", 0.5, { timeline: mixed })), [2880]);
});
test("mixed-meter selected notes share visual endpoint delta, not identical tick delta", () => {
  const notes = [note("quarter", 960), note("eighth", 960, 2)];
  assert.deepEqual(lengths(resize(notes, "quarter", 0.5, { timeline: mixed })), [1440, 1920]);
});
test("shortening a note back across a meter change uses the earlier unit", () => {
  assert.deepEqual(lengths(resize([note("a", 1920, 1, 4)], "a", -1, { timeline: mixed })), [480]);
});
test("snap across a meter boundary preserves the chosen endpoint for companions", () => {
  const notes = [note("a", 1920, 1, 4), note("b", 960, 1, 1)];
  assert.deepEqual(lengths(resize(notes, "a", 0.3, { timeline: mixed, grid: 480 })), [2400, 1200]);
});
test("last meter extends beyond the project end like the render timeline", () => {
  assert.deepEqual(lengths(resize([note("a", 3840, 2)], "a", 2)), [5760]);
});
test("no movement with grid off preserves exact durations and leaves source untouched", () => {
  const notes = [Object.freeze(note("a", 333)), Object.freeze(note("b", 777))];
  const before = JSON.stringify(notes);
  assert.deepEqual(lengths(resize(notes, "b", 0)), [333, 777]);
  assert.equal(JSON.stringify(notes), before);
});
test("vertical-only edge movement does not quantize off-grid lengths", () => {
  assert.deepEqual(lengths(resize([note("a", 333), note("b", 777)], "b", 0, { grid: 480 })), [333, 777]);
});
test("missing anchor and malformed inputs yield no edit", () => {
  assert.deepEqual(resize([note("a", 960)], "missing", 1), []);
  assert.deepEqual(resize([note("a", 960)], "a", NaN), []);
  assert.deepEqual(resize([note("a", 960)], "a", 1, { timeline: [] }), []);
});

console.log(`${passed} DAW editing checks passed; no server, project or audio touched.`);
