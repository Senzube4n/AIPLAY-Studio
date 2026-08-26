/**
 * DAW store — the maths every other layer trusts.
 *
 * Everything here has a closed-form answer: a bar of 4/4 at 120 quarter-bpm
 * lasts exactly 2 s, a 7/8 bar at the same tempo exactly 1.75 s, so the
 * timeline, position and duration converters are checked against arithmetic,
 * not against themselves. The dirty-region section is the P0 gate in unit
 * form: an edit in bar 9 must change ONLY the hash of bar 9's region.
 *
 * Runs standalone (`node server/daw/store_test.js`) and in the pre-commit
 * hook. Touches no disk beyond what importing config.js does.
 */
import {
  blankProject, blankTrack, blankClip, migrate,
  buildTimeline, posToSeconds, durationSeconds, projectSeconds, normPos,
  regionsOf, noteEvents, regionHashes, dirtyBetween,
  normalizeMeterMap, normalizeTempoMap,
  TICKS_PER_BEAT, REGION_BARS, SR, TAILS, INSTRUMENTS,
  PATCHES, PATCH_IDS, PATCH_MANIFEST, normParams,
} from "./store.js";

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* A project built by hand, no disk: 16 bars, 120 bpm, 4/4. */
function makeDoc() {
  const doc = blankProject("test", { bpm: 120, num: 4, den: 4, lengthBars: 16 });
  const track = blankTrack("keys", "pluck");
  track.clips.push(blankClip(1, 16));
  doc.tracks.push(track);
  return doc;
}
const addNote = (doc, patch) => {
  const n = {
    id: `nt_${doc.tracks[0].clips[0].notes.length}`,
    bar: 1, beat: 1, tick: 0, durTicks: TICKS_PER_BEAT, pitch: 60, vel: 100, by: "user",
    ...patch,
  };
  doc.tracks[0].clips[0].notes.push(n);
  return n;
};

console.log("\n  -- the timeline is derived from the maps, closed-form --");
{
  const doc = makeDoc();
  const rows = buildTimeline(doc);
  ok("16 bars derive 16 rows", rows.length === 16);
  ok("a 4/4 bar at 120 quarter-bpm lasts exactly 2 s", near(rows[0].secLen, 2));
  ok("bar 3 starts at 4 s", near(rows[2].sec, 4));
  ok("posToSeconds: bar 3 beat 2 tick 480 = 4 + 0.5 + 0.25 s",
    near(posToSeconds(doc, { bar: 3, beat: 2, tick: 480 }), 4.75));
  ok("the whole project is 32 s", near(projectSeconds(doc), 32));
}

console.log("\n  -- mixed meter: 7/8 mid-song, the §12 requirement --");
{
  const doc = makeDoc();
  doc.meterMap = normalizeMeterMap([{ atBar: 1, num: 4, den: 4 }, { atBar: 3, num: 7, den: 8 }]);
  const rows = buildTimeline(doc);
  ok("bar 3 is 7/8", rows[2].num === 7 && rows[2].den === 8);
  // an eighth at 120 quarter-bpm is 0.25 s, so a 7/8 bar is 1.75 s
  ok("a 7/8 bar at 120 quarter-bpm lasts exactly 1.75 s", near(rows[2].secLen, 1.75));
  ok("bar 4 starts at 2+2+1.75 s", near(rows[3].sec, 5.75));
  ok("beat 7 of a 7/8 bar exists", !!normPos(doc, { bar: 3, beat: 7, tick: 0 }));
  let refused = "";
  try { normPos(doc, { bar: 3, beat: 8, tick: 0 }); } catch (e) { refused = e.message; }
  ok("beat 8 of a 7/8 bar is refused, naming the meter", /7\/8/.test(refused), refused);

  // A duration walked ACROSS the meter change: one beat of 4/4 (0.5 s) then
  // one beat of 7/8 (0.25 s).
  const d = durationSeconds(doc, { bar: 2, beat: 4, tick: 0 }, 2 * TICKS_PER_BEAT);
  ok("a 2-beat note across 4/4→7/8 lasts 0.5+0.25 s", near(d, 0.75), `got ${d}`);
}

console.log("\n  -- tempo changes compose with meter changes --");
{
  const doc = makeDoc();
  doc.meterMap = normalizeMeterMap([{ atBar: 1, num: 4, den: 4 }, { atBar: 3, num: 7, den: 8 }]);
  doc.tempoMap = normalizeTempoMap([{ atBar: 1, bpm: 120 }, { atBar: 3, bpm: 90 }]);
  const rows = buildTimeline(doc);
  // 7 eighths at 90 quarter-bpm: an eighth is (60/90)/2 s
  ok("a 7/8 bar at 90 quarter-bpm lasts 7*(60/90)/2 s", near(rows[2].secLen, 7 * (60 / 90) / 2));
  ok("bars before the tempo change are untouched", near(rows[1].secLen, 2));
}

console.log("\n  -- maps normalise: anchored at bar 1, sorted, deduplicated --");
{
  const m = normalizeMeterMap([{ atBar: 5, num: 3, den: 4 }, { atBar: 5, num: 7, den: 8 }]);
  ok("a map missing bar 1 gains a 4/4 anchor", m[0].atBar === 1 && m[0].num === 4);
  ok("two events at one bar keep the later one", m.length === 2 && m[1].num === 7);
  const t = normalizeTempoMap(undefined);
  ok("no tempo map at all becomes 120 at bar 1", t.length === 1 && t[0].bpm === 120);
}

console.log("\n  -- migrate round-trips the maps and the notes --");
{
  const doc = makeDoc();
  doc.meterMap.push({ atBar: 9, num: 5, den: 4 });
  addNote(doc, { bar: 2, beat: 3, tick: 120, pitch: 64, vel: 90, by: "agent" });
  const back = migrate(JSON.parse(JSON.stringify(doc)));
  ok("the meter map survives", JSON.stringify(back.meterMap) === JSON.stringify(doc.meterMap));
  ok("the tempo map survives", JSON.stringify(back.tempoMap) === JSON.stringify(doc.tempoMap));
  const n = back.tracks[0].clips[0].notes[0];
  ok("a note survives field-for-field", n.bar === 2 && n.beat === 3 && n.tick === 120
    && n.pitch === 64 && n.vel === 90 && n.by === "agent");
  ok("garbage in a note repairs, not rejects",
    migrate({ tracks: [{ clips: [{ notes: [{ pitch: "big", vel: -3 }] }] }] })
      .tracks[0].clips[0].notes[0].pitch === 60);
}

console.log("\n  -- regions abut sample-exactly and cover the whole --");
{
  const doc = makeDoc();
  doc.meterMap = normalizeMeterMap([{ atBar: 1, num: 4, den: 4 }, { atBar: 6, num: 7, den: 8 }]);
  const regs = regionsOf(doc);
  ok(`16 bars chop into ${Math.ceil(16 / REGION_BARS)} regions`, regs.length === 4);
  let contiguous = true;
  for (let i = 1; i < regs.length; i++) {
    if (regs[i].startSample !== regs[i - 1].startSample + regs[i - 1].nSamples) contiguous = false;
  }
  ok("every region starts where the last one ends, in SAMPLES", contiguous);
  const total = regs.reduce((a, r) => a + r.nSamples, 0);
  ok("region lengths sum to the whole project",
    total === Math.round(projectSeconds(doc) * SR), `sum ${total}`);
}

console.log("\n  -- THE DIRTY MECHANISM: an edit in bar 9 touches only its region --");
{
  const doc = makeDoc();
  addNote(doc, { bar: 2, beat: 1 });
  addNote(doc, { bar: 9, beat: 2, pitch: 67 });
  const before = regionHashes(doc);
  ok("4 regions hash", before.length === 4);

  // Edit the bar-9 note (region idx 2 covers bars 9-12).
  doc.tracks[0].clips[0].notes[1].pitch = 72;
  const after = regionHashes(doc);
  const dirty = dirtyBetween(before, after, regionsOf(doc));
  ok("exactly one region is dirty", dirty.length === 1, JSON.stringify(dirty));
  ok("...and it is the region holding bar 9", dirty[0]?.fromBar === 9 && dirty[0]?.toBar === 12);
  ok("the bar-2 region kept its hash", after[0] === before[0]);
  ok("the untouched regions kept theirs", after[1] === before[1] && after[3] === before[3]);
}

console.log("\n  -- a tail crossing a region edge dirties the neighbour too --");
{
  const doc = makeDoc();
  // Bar 4, last beat: a pluck's 1.5 s tail reaches well into bar 5 (region 1).
  addNote(doc, { bar: 4, beat: 4, tick: 0 });
  const before = regionHashes(doc);
  doc.tracks[0].clips[0].notes[0].pitch = 65;
  const after = regionHashes(doc);
  const dirty = dirtyBetween(before, after, regionsOf(doc));
  ok("the edit dirties its own region AND the one its tail rings into",
    dirty.length === 2 && dirty[0].fromBar === 1 && dirty[1].fromBar === 5,
    JSON.stringify(dirty));
}

console.log("\n  -- a meter change dirties downstream, never upstream --");
{
  const doc = makeDoc();
  addNote(doc, { bar: 2, beat: 1 });
  addNote(doc, { bar: 14, beat: 1 });
  const before = regionHashes(doc);
  doc.meterMap = normalizeMeterMap([...doc.meterMap, { atBar: 5, num: 7, den: 8 }]);
  const after = regionHashes(doc);
  ok("region 0 (bars 1-4, before the change) keeps its hash", after[0] === before[0]);
  ok("regions from the change onward are dirty",
    after[1] !== before[1] && after[3] !== before[3]);
}

console.log("\n  -- mute and gain are part of a region's identity --");
{
  const doc = makeDoc();
  addNote(doc, { bar: 2, beat: 1 });
  const before = regionHashes(doc);
  doc.tracks[0].gainDb = -6;
  const gained = regionHashes(doc);
  ok("a gain change dirties the note's region", gained[0] !== before[0]);
  ok("...and only that region", gained[1] === before[1]);
  doc.tracks[0].mute = true;
  const muted = regionHashes(doc);
  ok("muting empties the region's event set (hash changes again)", muted[0] !== gained[0]);
}

console.log("\n  -- events carry what the renderer needs, deterministically --");
{
  const doc = makeDoc();
  addNote(doc, { bar: 3, beat: 2, tick: 0, pitch: 64, durTicks: 960 });
  const [e] = noteEvents(doc);
  ok("startSample is the absolute placement", e.startSample === Math.round(4.5 * SR));
  ok("durSamples is a beat", e.durSamples === Math.round(0.5 * SR));
  ok("the seed is stable across recomputation", e.seed === noteEvents(doc)[0].seed);
  ok("every instrument has a declared tail", INSTRUMENTS.every((i) => TAILS[i] > 0));
}

console.log("\n  -- the patch registry round-trips through a document --");
{
  /* The registry and the document are ONE vocabulary: what the manifest
   * offers, a track can hold; what a track holds, the renderer can voice. */
  ok("every renderable patch has a tail, a family and a label",
    PATCH_IDS.every((p) => TAILS[p] > 0 && PATCHES[p].family && PATCHES[p].label),
    PATCH_IDS.filter((p) => !(TAILS[p] > 0)).join(", "));
  ok("the P0 prototype synths are still first-class patches (zero-download sound)",
    ["pluck", "pad", "drums"].every((p) => PATCH_IDS.includes(p) && PATCHES[p].kind === "builtin"));
  ok("the four generate-this-part rows exist but are NOT assignable",
    ["sax", "sitar", "choir", "solo_cello"].every((p) =>
      PATCHES[p] && PATCHES[p].kind === "generate" && !PATCH_IDS.includes(p)
      && typeof PATCHES[p].refusal === "string" && PATCHES[p].refusal.length > 40));

  const t = blankTrack("piano", { patch: "salamander", params: { transpose: 5, bogus: 9 } });
  ok("a track stores instrument as { patch, params }",
    t.instrument.patch === "salamander" && t.instrument.params.transpose === 5);
  ok("...and params are normalised, not trusted", t.instrument.params.bogus === undefined);
  ok("an unknown patch falls back to the P0 pluck rather than refusing to open",
    blankTrack("x", { patch: "nope" }).instrument.patch === "pluck");

  /* The P0 document shape (a bare string instrument) must still open. */
  const legacy = migrate({ ...blankProject("legacy"), tracks: [
    { id: "trk_1", name: "old", instrument: "pad", gainDb: 0, mute: false, clips: [] },
  ] });
  ok("a P0 document's bare-string instrument migrates to { patch, params }",
    legacy.tracks[0].instrument.patch === "pad"
    && typeof legacy.tracks[0].instrument.params === "object");

  ok("normParams clamps transpose and gain, and drops GM keys on a non-GM patch",
    normParams({ transpose: 999, gain_db: -99, program: 40 }, "salamander").transpose === 48
    && normParams({ gain_db: -99 }, "salamander").gain_db === -24
    && normParams({ program: 40 }, "salamander").program === undefined);
  ok("...and keeps program/drum_kit on the GM bank",
    normParams({ program: 40, drum_kit: true }, "generaluser").program === 40
    && normParams({ drum_kit: true }, "generaluser").drum_kit === true);

  ok("every attribution-required pack carries its attribution text",
    Object.values(PATCH_MANIFEST.packs).every((pk) =>
      !pk.attribution_required || (pk.attribution && pk.attribution.length > 20)));
}

console.log("\n  -- a patch or params change dirties exactly what it re-voices --");
{
  const doc = makeDoc();
  addNote(doc, { bar: 2, beat: 1, tick: 0, pitch: 60, durTicks: 960 });
  const before = regionHashes(doc);
  doc.tracks[0].instrument = { patch: "salamander", params: {} };
  const swapped = regionHashes(doc);
  ok("swapping the patch dirties the note's region", swapped[0] !== before[0]);
  ok("...and only that region", swapped[1] === before[1] && swapped[2] === before[2]);
  doc.tracks[0].instrument.params = { transpose: 3 };
  const tuned = regionHashes(doc);
  ok("a params change dirties it again (params ride the hash)", tuned[0] !== swapped[0]);
  ok("...and the hash is stable when nothing changed", regionHashes(doc)[0] === tuned[0]);
  const [e] = noteEvents(doc);
  ok("the event carries the patch id and its params to the renderer",
    e.inst === "salamander" && e.params.transpose === 3);
  ok("the event's tail reach is the PATCH's tail, not a builtin default",
    Math.abs((e.endSec - e.startSec - 0.5) - TAILS.salamander) < 1e-9);
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
