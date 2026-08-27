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
  noteInClip, notesOutsideClip, shiftClipNotes,
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

  /* A hand-picked track colour is the newest optional field, and optional
   * fields are precisely what this file exists to catch: six have been
   * silently erased by a rebuild path in this codebase. Absent must stay
   * absent (so a document nobody has coloured is byte-identical through a
   * migrate), present must survive, and nonsense must repair. */
  const colourDoc = migrate(JSON.parse(JSON.stringify({
    ...doc, tracks: [{ ...doc.tracks[0], colour: 3 }],
  })));
  ok("a chosen track colour survives a load", colourDoc.tracks[0].colour === 3);
  ok("...an absent one stays absent, not defaulted",
    !("colour" in migrate(JSON.parse(JSON.stringify(doc))).tracks[0]));
  ok("...null clears it rather than storing a null",
    !("colour" in migrate({ tracks: [{ colour: null }] }).tracks[0]));
  ok("...and an out-of-range one clamps instead of rejecting",
    migrate({ tracks: [{ colour: 99 }] }).tracks[0].colour === 15);
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

  /* ── PER-PATCH KNOBS (the drum machines) ──────────────────────────────
   * The manifest declares each machine's front panel; normParams is the
   * only gate between a caller and drums.py's circuit. A knob that this
   * validator drops is a knob that does not exist, however carefully the
   * python end reads it. */
  const MACHINES = ["tr808", "tr909", "tr808_bass", "hybrid_kick"];
  ok("the four drum machines are builtin patches -- no pack, no download",
    MACHINES.every((p) => PATCHES[p] && PATCHES[p].kind === "builtin"
      && PATCHES[p].builtin === p && !PATCHES[p].pack && PATCH_IDS.includes(p)));
  ok("...and each declares a front panel of min/max/default/unit/doc knobs",
    MACHINES.every((p) => {
      const s = PATCHES[p].params;
      return s && Object.keys(s).length >= 6 && Object.values(s).every((k) =>
        Number.isFinite(k.min) && Number.isFinite(k.max) && Number.isFinite(k.default)
        && k.min <= k.default && k.default <= k.max
        && typeof k.doc === "string" && k.doc.length > 10);
    }));
  ok("a declared knob survives normParams, clamped to its declared range",
    normParams({ kick_tune: 7, kick_decay: 99 }, "tr808").kick_tune === 7
    && normParams({ kick_decay: 99 }, "tr808").kick_decay === 1
    && normParams({ kick_decay: -99 }, "tr808").kick_decay === 0);
  ok("a knob belonging to ANOTHER machine is dropped",
    normParams({ kick_sweep: 0.9 }, "tr808").kick_sweep === undefined
    && normParams({ kick_sweep: 0.9 }, "tr909").kick_sweep === 0.9);
  ok("a knob on a patch with no front panel is dropped",
    Object.keys(normParams({ kick_tune: 7 }, "salamander")).length === 0);
  ok("a value EQUAL to the default is dropped, so an untouched track still "
    + "hashes as {} exactly as it did before this table existed",
    Object.keys(normParams({ kick_decay: PATCHES.tr808.params.kick_decay.default,
      kick_tune: 0 }, "tr808")).length === 0
    && Object.keys(normParams({}, "tr808")).length === 0);
  ok("...and a float is rounded, so 0.1+0.2 cannot re-hash a region for free",
    normParams({ kick_decay: 0.1 + 0.2 }, "tr808").kick_decay === 0.3);
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

/* ═══════════════════════════════════════════════════════════════════════
 * CLIP BOUNDS (agent/dawparity) — a clip is the container that decides what
 * sounds, and it can be moved.
 *
 * Every number below is closed form. A 16-bar 4/4 project at 120 quarter-bpm
 * has 2 s bars and REGION_BARS=4, so the four regions are exactly
 *   r0 bars 1-4 = 0-8 s · r1 5-8 = 8-16 s · r2 9-12 = 16-24 s · r3 13-16 = 24-32 s
 * and a pluck's 1.5 s tail is the only thing that reaches across an edge.
 * ═══════════════════════════════════════════════════════════════════════ */

/** A doc with FIXED ids, so two documents built the same way hash the same
 *  way — that is what lets a moved note be compared to a placed one. */
function clipDoc(fromBar, toBar, opts = {}) {
  const doc = blankProject("clips", { bpm: 120, num: 4, den: 4, lengthBars: 16, ...opts });
  doc.id = "prj_fixed";
  const track = blankTrack("keys", "pluck");
  track.id = "trk_fixed";
  const clip = blankClip(fromBar, toBar);
  clip.id = "clp_fixed";
  track.clips.push(clip);
  doc.tracks.push(track);
  return doc;
}
const clipOf = (doc) => doc.tracks[0].clips[0];
function putNote(doc, patch) {
  const n = {
    id: patch.id || `nt_${clipOf(doc).notes.length}`,
    bar: 1, beat: 1, tick: 0, durTicks: TICKS_PER_BEAT, pitch: 60, vel: 100, by: "user",
    ...patch,
  };
  clipOf(doc).notes.push(n);
  return n;
}
const dirtyIdx = (before, after, regions) =>
  dirtyBetween(before, after, regions).map((r) => r.idx).join(",");

console.log("\n  -- THE CONTAINER RULE: a note outside its clip is stored, and silent --");
{
  const doc = clipDoc(1, 4);
  putNote(doc, { id: "nt_in", bar: 2 });
  putNote(doc, { id: "nt_out", bar: 10 });
  ok("noteInClip agrees with the bounds",
    noteInClip(clipOf(doc), clipOf(doc).notes[0])
    && !noteInClip(clipOf(doc), clipOf(doc).notes[1]));
  ok("notesOutsideClip counts the silent ones", notesOutsideClip(clipOf(doc)) === 1);
  const ev = noteEvents(doc);
  ok("only the note inside the clip reaches the renderer",
    ev.length === 1 && ev[0].noteId === "nt_in");
  ok("...and the silent one is STILL in the document", clipOf(doc).notes.length === 2);
  clipOf(doc).toBar = 12;
  ok("widening the clip brings it back, unchanged", noteEvents(doc).length === 2);
}

console.log("\n  -- a clip moves and its notes ride along --");
{
  const doc = clipDoc(1, 4);
  putNote(doc, { id: "a", bar: 2, beat: 3, tick: 240 });
  putNote(doc, { id: "b", bar: 4, beat: 1, tick: 0 });
  const r = shiftClipNotes(doc, clipOf(doc), 8);
  ok("every note moved by the delta", clipOf(doc).notes.map((n) => n.bar).join() === "10,12");
  ok("beat and tick are untouched — a move is a translation in BARS",
    clipOf(doc).notes[0].beat === 3 && clipOf(doc).notes[0].tick === 240);
  ok("it reports what it moved, and that nothing needed repair",
    r.moved === 2 && r.clamped === 0);
  ok("a zero delta is a no-op that says so", shiftClipNotes(doc, clipOf(doc), 0).moved === 0);
  const back = shiftClipNotes(doc, clipOf(doc), -20);
  ok("bars below 1 clamp to bar 1 rather than going negative",
    clipOf(doc).notes.every((n) => n.bar >= 1) && back.moved === 2);
}

console.log("\n  -- mixed meter: a beat that does not exist in the destination clamps --");
{
  const doc = clipDoc(9, 12);
  doc.meterMap = normalizeMeterMap([{ atBar: 1, num: 4, den: 4 }, { atBar: 9, num: 7, den: 8 }]);
  const n = putNote(doc, { id: "seven", bar: 9, beat: 7, tick: 0 });
  ok("beat 7 is legal where the meter is 7/8", normPos(doc, n).beat === 7);
  const r = shiftClipNotes(doc, clipOf(doc), -8);
  ok("moved into a 4/4 bar, beat 7 clamps to the bar's last beat (4)",
    n.bar === 1 && n.beat === 4, `${n.bar}.${n.beat}`);
  ok("...and says so, rather than losing it silently", r.clamped === 1 && r.moved === 1);
  let accepted = true;
  try { normPos(doc, n); } catch { accepted = false; }
  ok("the clamped position is one the document's OWN validator accepts", accepted);
}

console.log("\n  -- DIRTYING: a move dirties the vacated range AND the new one --");
{
  const doc = clipDoc(1, 4);
  putNote(doc, { id: "n1", bar: 2, beat: 1, tick: 0, durTicks: 960 });
  const regions = regionsOf(doc);
  const before = regionHashes(doc);
  const clip = clipOf(doc);
  clip.fromBar = 9; clip.toBar = 12;
  shiftClipNotes(doc, clip, 8);
  ok("bar 2 → bar 10 dirties region 0 (vacated) and region 2 (new), and nothing else",
    dirtyIdx(before, regionHashes(doc), regions) === "0,2",
    dirtyIdx(before, regionHashes(doc), regions));
}

console.log("\n  -- ...and a moved note's TAIL reaches forward exactly as a placed one's --");
{
  /* bar 4 beat 4 = 7.5 s; +1 beat = 8.0 s; +1.5 s of pluck tail = 9.5 s, so
   * the note sounds in r0 AND r1. Moved 8 bars on, it must sound in r2 and
   * r3 by the same arithmetic — and the whole document must then be
   * INDISTINGUISHABLE from one where the note was placed there. */
  const moved = clipDoc(1, 4);
  putNote(moved, { id: "tail", bar: 4, beat: 4, tick: 0, durTicks: 960 });
  const regions = regionsOf(moved);
  const before = regionHashes(moved);
  ok("placed at bar 4 beat 4, the tail already reaches into r1",
    before.length === 4 && noteEvents(moved)[0].reach1 > regions[1].t0);
  const clip = clipOf(moved);
  clip.fromBar = 9; clip.toBar = 12;
  shiftClipNotes(moved, clip, 8);
  ok("moving it dirties all four regions (two vacated, two entered)",
    dirtyIdx(before, regionHashes(moved), regions) === "0,1,2,3",
    dirtyIdx(before, regionHashes(moved), regions));

  const placed = clipDoc(9, 12);
  putNote(placed, { id: "tail", bar: 12, beat: 4, tick: 0, durTicks: 960 });
  ok("a MOVED note hashes byte-identically to a PLACED one — same reach, same seed",
    regionHashes(moved).join() === regionHashes(placed).join(),
    `${regionHashes(moved).join()}\n          vs ${regionHashes(placed).join()}`);
}

console.log("\n  -- a resize silences, it never deletes: shrink then widen restores --");
{
  const doc = clipDoc(1, 8);
  putNote(doc, { id: "early", bar: 2, beat: 1, tick: 0, durTicks: 960 });
  putNote(doc, { id: "late", bar: 6, beat: 1, tick: 0, durTicks: 960 });
  const regions = regionsOf(doc);
  const before = regionHashes(doc);
  const clip = clipOf(doc);
  clip.toBar = 4;
  const shrunk = regionHashes(doc);
  ok("shrinking to bars 1-4 dirties ONLY the range it gave up (r1)",
    dirtyIdx(before, shrunk, regions) === "1", dirtyIdx(before, shrunk, regions));
  ok("...the note is silent", noteEvents(doc).length === 1);
  ok("...and still stored, counted as outside",
    clip.notes.length === 2 && notesOutsideClip(clip) === 1);
  clip.toBar = 8;
  ok("widening restores the audio BYTE-FOR-BYTE — nothing was deleted",
    regionHashes(doc).join() === before.join());
}

console.log("\n  -- a longer project reports each NEW region as dirty exactly ONCE --");
{
  /* The e2e's daw_set_length check found this: growing the region count used
   * to report every new region twice (a second pass over a tail the first
   * pass already covered), so a 16→24-bar edit answered dirty [4,5,4,5]. */
  const doc = clipDoc(1, 16);
  putNote(doc, { id: "n", bar: 2 });
  const before = regionHashes(doc);
  doc.lengthBars = 24;
  const regions = regionsOf(doc);
  const rows = dirtyBetween(before, regionHashes(doc), regions);
  ok("16 → 24 bars adds regions 4 and 5, and names each once",
    rows.map((r) => r.idx).join() === "4,5", rows.map((r) => r.idx).join());
  ok("...and the bars they name are the bars they cover",
    rows[0].fromBar === 17 && rows[1].fromBar === 21 && rows[1].toBar === 24);
  ok("no index appears twice, whatever the shape",
    new Set(rows.map((r) => r.idx)).size === rows.length);
  doc.lengthBars = 16;
  ok("shortening back reports nothing dirty — the regions that remain are unchanged",
    dirtyBetween(regionHashes(doc), regionHashes(doc), regionsOf(doc)).length === 0);
}

console.log("\n  -- clip bounds round-trip through a save and load --");
{
  const doc = clipDoc(5, 9);
  doc.tracks[0].clips.push({ ...blankClip(11, 13), id: "clp_second", name: "second" });
  putNote(doc, { id: "inside", bar: 6, beat: 2, tick: 120 });
  putNote(doc, { id: "outside", bar: 12, beat: 3, tick: 0 });
  const back = migrate(JSON.parse(JSON.stringify(doc)));
  const c = back.tracks[0].clips[0];
  ok("fromBar and toBar survive the round trip", c.fromBar === 5 && c.toBar === 9);
  ok("a second clip's bounds and name survive too",
    back.tracks[0].clips[1].fromBar === 11 && back.tracks[0].clips[1].toBar === 13
    && back.tracks[0].clips[1].name === "second");
  const out = c.notes.find((n) => n.id === "outside");
  ok("a note stored OUTSIDE its clip is not repaired away", !!out && out.bar === 12 && out.beat === 3);
  ok("...and the note inside keeps its exact position",
    c.notes.find((n) => n.id === "inside").tick === 120);
  ok("the reloaded document renders the same regions as the live one",
    regionHashes(back).join() === regionHashes(doc).join());
  const bad = migrate(JSON.parse(JSON.stringify({ ...doc, tracks: [{ ...doc.tracks[0],
    clips: [{ id: "clp_bad", fromBar: 9, toBar: 3, notes: [] }] }] })));
  ok("a clip whose end is before its start is REPAIRED, not rejected",
    bad.tracks[0].clips[0].toBar === 9 && bad.tracks[0].clips[0].fromBar === 9);
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
