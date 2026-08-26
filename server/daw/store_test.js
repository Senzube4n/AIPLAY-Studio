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

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
