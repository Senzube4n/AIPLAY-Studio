import test from "node:test";
import assert from "node:assert/strict";
import { blankProject, blankTrack, blankClip, durationSeconds, buildTimeline } from "../daw/store.js";
import { dawSelectionToScore } from "./daw-score.js";
import { scoreToDawPlan } from "./score_daw.js";
import { parseScore, checkScore, TICKS_PER_QUARTER } from "../mcp-music-score.js";

const header = (meter = "4/4", bpm = 120, key = "C") => `X:1\nT:\nM:${meter}\nL:1/32\nQ:1/4=${bpm}\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:${key}\n`;
const note = (bar, beat, durTicks, pitch = 60, tick = 0, id = "n1") => ({ id, bar, beat, tick, durTicks, pitch, vel: 100 });
function project(notes = [], { bars = 2, num = 4, den = 4, bpm = 120, name = "Ins" } = {}) {
  const doc = blankProject("Roundtrip", { lengthBars: bars, num, den, bpm });
  const track = blankTrack(name, "pluck");
  const clip = blankClip(1, bars, { name: "notes" });
  clip.notes = notes;
  track.clips.push(clip);
  doc.tracks.push(track);
  return doc;
}
function fromPlan(plan) {
  const doc = blankProject(plan.name, { lengthBars: plan.lengthBars, num: plan.num, den: plan.den, bpm: plan.bpm });
  doc.tracks = plan.tracks.map((planned) => {
    const track = blankTrack(planned.name, planned.instrument);
    const clip = blankClip(1, plan.lengthBars, { name: planned.clipName });
    clip.notes = plan.notes.filter((row) => row.track === planned.name).map((row, i) => note(row.bar, row.beat, row.dur_ticks, row.pitch, row.tick, `n${i}`));
    track.clips.push(clip);
    return track;
  });
  return doc;
}
const sounding = (abc) => Object.fromEntries(Object.entries(parseScore(abc).voices).map(([voice, value]) => [voice, value.notes]));

test("a saved two-voice score survives score-to-DAW-to-score, including sharp/natural pitches, rests, ties and harmony", () => {
  const abc = header("4/4", 92, "G") + '% verse\nV: Vocal\n"C"^F4=F4G8-A8B8|\nV: Ins\nC16D16|\n';
  // Correct a deliberate melody spelling before the roundtrip: tied G must continue as G.
  const valid = abc.replace("G8-A8", "G8-G8");
  assert.equal(checkScore(valid).ok, true);
  const doc = fromPlan(scoreToDawPlan(valid));
  const out = dawSelectionToScore(doc, { sourceAbc: valid });
  assert.equal(out.check.ok, true);
  assert.deepEqual(sounding(out.abc), sounding(valid));
  assert.equal(out.check.header.key, "G");
  assert.deepEqual(parseScore(out.abc).voices.Vocal.chords, parseScore(valid).voices.Vocal.chords);
  assert.equal(out.check.facts.sections[0].name, "verse");
  assert.equal(out.selection.durationSeconds, 240 / 92);
});

test("6/8 roundtrip uses eighth-note DAW beats and preserves off-beat positions", () => {
  const original = header("6/8", 120) + '% phrase\nV: Vocal\nz24|\nV: Ins\nz2C2D4E4F4G8|\n';
  const doc = fromPlan(scoreToDawPlan(original));
  const out = dawSelectionToScore(doc, { sourceAbc: original });
  assert.deepEqual(sounding(out.abc), sounding(original));
  assert.equal(out.selection.durationSeconds, 1.5);
  assert.equal(out.check.facts.nominal_seconds, 1.5);
});

test("one track defaults to Ins, pads Vocal and spells every MIDI octave correctly", () => {
  const pitches = [0, 11, 12, 59, 60, 61, 71, 72, 84, 127];
  const doc = project(pitches.map((pitch, i) => note(Math.floor(i / 4) + 1, i % 4 + 1, 960, pitch, 0, `n${i}`)), { bars: 3 });
  const out = dawSelectionToScore(doc);
  assert.equal(out.check.ok, true);
  assert.deepEqual(parseScore(out.abc).voices.Ins.notes.map((row) => row[1]), pitches);
  assert.equal(out.check.facts.sounding_notes.Vocal, 0);
  assert.ok(out.warnings.some((warning) => warning.code === "harmony_unavailable"));
});

test("an unsupported native duration is split into tied legal tokens without adding retriggers", () => {
  const doc = project([note(1, 1, 600, 65), note(1, 2, 960, 67)], { bars: 1 });
  const out = dawSelectionToScore(doc);
  assert.equal(out.check.ok, true);
  assert.match(out.abc, /=F4-=F/);
  assert.deepEqual(parseScore(out.abc).voices.Ins.notes, [[0, 65, 640], [1024, 67, 1024]]);
});

test("sustained notes are tied across barlines and trimmed only at selection boundaries", () => {
  const doc = project([note(1, 4, 5760, 64)], { bars: 3 });
  const out = dawSelectionToScore(doc, { fromBar: 2, toBar: 2 });
  assert.deepEqual(parseScore(out.abc).voices.Ins.notes, [[0, 64, 4096]]);
  assert.equal(out.selection.startSeconds, 2);
  assert.equal(out.selection.endSeconds, 4);
  assert.equal(out.warnings.find((warning) => warning.code === "boundary_trim").notes, 1);
  const full = dawSelectionToScore(doc);
  assert.deepEqual(parseScore(full.abc).voices.Ins.notes, [[3072, 64, 6144]]);
  assert.equal(full.warnings.some((warning) => warning.code === "boundary_trim"), false);
});

test("mixed meter export follows DAW local-duration semantics and produces valid matching voice grids", () => {
  const doc = project([note(1, 4, 2880)], { bars: 2 });
  doc.meterMap.push({ atBar: 2, num: 6, den: 8 });
  const out = dawSelectionToScore(doc);
  const parsed = parseScore(out.abc);
  assert.equal(out.check.ok, true);
  assert.deepEqual(out.check.facts.meters_used, ["4/4", "6/8"]);
  assert.deepEqual(parsed.voices.Ins.notes, [[3072, 60, 2048]]);
  assert.equal(parsed.voices.Ins.notes[0][2] / TICKS_PER_QUARTER * 60 / 120,
    durationSeconds(doc, doc.tracks[0].clips[0].notes[0], 2880, buildTimeline(doc)));
  assert.equal(out.selection.durationSeconds, 3.5);
});

test("constant-tempo selections retain the active tempo and absolute second bounds; changing-tempo ranges refuse", () => {
  const doc = project([note(1, 1, 960), note(2, 1, 960)], { bars: 3 });
  doc.tempoMap.push({ atBar: 2, bpm: 60 });
  assert.throws(() => dawSelectionToScore(doc), /constant tempo/);
  const out = dawSelectionToScore(doc, { fromBar: 2, toBar: 3 });
  assert.equal(out.check.header.bpm, 60);
  assert.deepEqual([out.selection.startSeconds, out.selection.endSeconds, out.selection.durationSeconds], [2, 10, 8]);
  doc.tempoMap[1].bpm = 60.25;
  assert.throws(() => dawSelectionToScore(doc, { fromBar: 2, toBar: 3 }), /whole number/);
});

test("clip-hidden notes are silent and overlapping clips retain real polyphony, which native ABC refuses", () => {
  const doc = project([note(1, 1, 960), note(2, 1, 960)], { bars: 2 });
  doc.tracks[0].clips[0].toBar = 1;
  assert.equal(dawSelectionToScore(doc).voices[1].notes, 1);
  const duplicate = blankClip(1, 2, { name: "layer" });
  duplicate.notes = [note(1, 1, 960, 67)];
  doc.tracks[0].clips.push(duplicate);
  assert.throws(() => dawSelectionToScore(doc), /overlapping notes/);
  assert.throws(() => dawSelectionToScore(doc, { fromBar: 2, toBar: 2 }), /no sounding notes/);
});

test("quantization is explicit, reports snapped onset and length counts, and leaves the DAW untouched", () => {
  const doc = project([note(1, 1, 351, 60, 31)], { bars: 1 });
  const before = JSON.stringify(doc);
  assert.throws(() => dawSelectionToScore(doc), /1\/32-note grid/);
  const out = dawSelectionToScore(doc, { quantizeTo32nd: true });
  assert.deepEqual(parseScore(out.abc).voices.Ins.notes, [[0, 60, 384]]);
  const quantized = out.warnings.find((warning) => warning.code === "quantized");
  assert.deepEqual([quantized.onsets, quantized.lengths, quantized.minimumLengths], [1, 1, 0]);
  assert.equal(JSON.stringify(doc), before);
  assert.equal(out.noteMetadata[0].sourceStartUnits, 31 / 120);
  assert.equal(out.noteMetadata[0].startUnits, 0);
  doc.tracks[0].clips[0].notes = [note(1, 1, 1, 60, 959)];
  assert.equal(dawSelectionToScore(doc, { quantizeTo32nd: true }).warnings.find((warning) => warning.code === "quantized").minimumLengths, 1);
});

test("snapping never resolves polyphony by silently discarding a note", () => {
  const doc = project([note(1, 1, 1, 60, 30), note(1, 1, 1, 62, 31)], { bars: 1 });
  assert.throws(() => dawSelectionToScore(doc, { quantizeTo32nd: true }), /overlapping notes/);
});

test("two explicitly assigned melodies are distinct voices; percussion and a third voice refuse", () => {
  const doc = project([note(1, 1, 960)], { bars: 1, name: "Lead" });
  const second = blankTrack("Countermelody", "pluck");
  const clip = blankClip(1, 1, { name: "counter" }); clip.notes = [note(1, 1, 960, 67)]; second.clips.push(clip); doc.tracks.push(second);
  const out = dawSelectionToScore(doc, { voiceTracks: { Vocal: second.id, Ins: doc.tracks[0].id } });
  assert.deepEqual(parseScore(out.abc).voices.Vocal.notes, [[0, 67, 1024]]);
  assert.deepEqual(parseScore(out.abc).voices.Ins.notes, [[0, 60, 1024]]);
  assert.throws(() => dawSelectionToScore(doc, { voiceTracks: { Vocal: second.id, Ins: second.id } }), /distinct tracks/);
  second.instrument.params.drum_kit = true;
  assert.throws(() => dawSelectionToScore(doc), /percussion/);
  doc.tracks.push(blankTrack("Third", "pluck"));
  assert.throws(() => dawSelectionToScore(doc), /one or two/);
});

test("source harmony, sections and a mid-bar key change survive a selected passage with explicit pitches", () => {
  const source = header("4/4", 120, "C") + '% verse\nV: Vocal\n"C"z32|\nV: Ins\nz32|\n% chorus\nV: Vocal\n"G7"z8[K:G]z24|\nV: Ins\nz8[K:G]z24|\n';
  const doc = project([note(2, 1, 3840, 65)], { bars: 2 });
  const out = dawSelectionToScore(doc, { fromBar: 2, toBar: 2, sourceAbc: source });
  assert.equal(out.check.ok, true);
  assert.deepEqual(parseScore(out.abc).voices.Ins.notes, [[0, 65, 4096]]);
  assert.deepEqual(parseScore(out.abc).voices.Vocal.chords, [[0, "G7"]]);
  assert.deepEqual(out.check.facts.key_changes, [{ at_quarter: 0, key: "C" }, { at_quarter: 1, key: "G" }]);
  assert.equal(out.check.facts.sections[0].name, "chorus");
});

test("a chord held from before the selection becomes the passage's initial chord", () => {
  const source = header() + '% verse\nV: Vocal\n"Am"z32|z32|\nV: Ins\nz32|z32|\n';
  const doc = project([note(2, 1, 960)], { bars: 2 });
  const out = dawSelectionToScore(doc, { fromBar: 2, toBar: 2, sourceAbc: source });
  assert.deepEqual(parseScore(out.abc).voices.Vocal.chords, [[0, "Am"]]);
  doc.meterMap[0].num = 3;
  assert.throws(() => dawSelectionToScore(doc, { fromBar: 2, toBar: 2, sourceAbc: source }), /meters differ/);
});

test("fingerprints are deterministic, cover off-grid source edits, and distinguish unrelated project changes", () => {
  const doc = project([note(1, 1, 351, 60, 31), note(2, 1, 960)], { bars: 2 });
  const opts = { fromBar: 1, toBar: 1, quantizeTo32nd: true };
  const initial = dawSelectionToScore(doc, opts);
  assert.equal(initial.sourceFingerprint, dawSelectionToScore(doc, opts).sourceFingerprint);
  doc.tracks[0].clips[0].notes[0].tick++;
  const edited = dawSelectionToScore(doc, opts);
  assert.equal(edited.abc, initial.abc);
  assert.notEqual(edited.sourceFingerprint, initial.sourceFingerprint);
  doc.tracks[0].clips[0].notes[1].pitch++;
  const unrelated = dawSelectionToScore(doc, opts);
  assert.equal(unrelated.sourceFingerprint, edited.sourceFingerprint);
  assert.notEqual(unrelated.projectFingerprint, edited.projectFingerprint);
});

test("transpose is applied to sounding pitches, while velocity and effects omissions remain visible", () => {
  const doc = project([note(1, 1, 960)], { bars: 1 });
  doc.tracks[0].instrument.params.transpose = 12;
  doc.tracks[0].clips[0].notes[0].vel = 70;
  const out = dawSelectionToScore(doc);
  assert.equal(parseScore(out.abc).voices.Ins.notes[0][1], 72);
  assert.ok(out.warnings.some((warning) => warning.code === "transpose_applied"));
  assert.ok(out.warnings.some((warning) => warning.code === "velocity_omitted"));
  assert.ok(out.warnings.some((warning) => warning.code === "performance_omitted"));
});
