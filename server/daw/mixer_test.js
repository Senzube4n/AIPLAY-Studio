/**
 * DAW mixer — the document model and THE DEPENDENCY-GRAPH RULE, pinned.
 *
 * The clauses under test are the ones mixer.js's header states:
 *   P0 PRESERVED   a fully default mixer leaves every region hash
 *                  byte-identical to P0's (old caches stay warm, the P0
 *                  e2e gates keep meaning what they say);
 *   CONFIG REACH   a chain edit dirties the track's sounding regions, a
 *                  return edit dirties its consumers, a master edit every
 *                  sounding region — and an UNUSED return dirties nothing;
 *   STATE REACH    a stateful chain stretches its notes' reach to ∞
 *                  forward, a memoryless one does not (the sub-second
 *                  level-mixing loop survives);
 *   SIDECHAIN      keying another track's compressor drags the source into
 *                  the stateful rule;
 *   ONE FORMAT     automation is the vfx keyframe shape, normalised by the
 *                  vfx normaliser, evaluated by the vfx evaluator.
 *
 * Runs standalone (`node server/daw/mixer_test.js`) and in the pre-commit
 * hook. No disk beyond importing config.js, no python.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  blankProject, blankTrack, blankClip, migrate,
  regionsOf, noteEvents, regionHashes, dirtyBetween, buildTimeline,
  TICKS_PER_BEAT,
} from "./store.js";
import {
  MIXER_CATALOG, MIXER_LIMITS, MIXER_ACTIONS,
  normParams, normAuto, normInserts, migrateTrackMixer, migrateDocMixer,
  isDefaultMixer, mixerAudible, mixerReach, trackStatefulPath,
  mixerSigBundle, mixerJobPayload, autoValueAt, catalogsAgree,
} from "./mixer.js";

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* 16 bars, 120 bpm 4/4 → four 4-bar regions of 8 s each. */
function makeDoc() {
  const doc = blankProject("mix", { bpm: 120, num: 4, den: 4, lengthBars: 16 });
  for (const [name, inst] of [["A", "pluck"], ["B", "drums"]]) {
    const t = blankTrack(name, inst, { id: `trk_${name}` });
    t.clips.push(blankClip(1, 16, {}));
    doc.tracks.push(t);
  }
  return migrate(doc);
}
const note = (doc, trackId, bar, patch = {}) => {
  const t = doc.tracks.find((x) => x.id === trackId);
  t.clips[0].notes.push({
    id: `nt_${trackId}_${t.clips[0].notes.length}`,
    bar, beat: 1, tick: 0, durTicks: TICKS_PER_BEAT, pitch: 60, vel: 100, by: "user",
    ...patch,
  });
};
const dirtyOf = (doc, fn) => {
  const before = regionHashes(doc);
  fn(doc);
  return dirtyBetween(before, regionHashes(doc), regionsOf(doc));
};
const ins = (type, params = {}, patch = {}) => ({
  id: patch.id || `ins_${type}`, type, enabled: true, params: normParams(type, params), ...patch,
});

console.log("\n  -- the catalog mirror is coherent --");
/* Nine channel-strip devices + the seven of the mastering suite
 * (agent/master, registered into the same mirror). The count is asserted
 * rather than the list because a device arriving with no catalog entry --
 * the failure this line exists to catch -- shows up as a count either way. */
ok("sixteen devices: the rack's nine plus the mastering suite's seven",
  Object.keys(MIXER_CATALOG).length === 16, Object.keys(MIXER_CATALOG).join(", "));
ok("catalogsAgree agrees with itself", catalogsAgree(
  JSON.parse(JSON.stringify(MIXER_CATALOG))).length === 0);
ok("...and names a planted drift", catalogsAgree({
  ...MIXER_CATALOG, eq: { ...MIXER_CATALOG.eq, params: { ...MIXER_CATALOG.eq.params, b1_q: { type: "number", default: 2, min: 0.1, max: 12 } } },
}).some((p) => p.includes("eq.b1_q")));

console.log("\n  -- params: catalog-complete, clamped, unknowns refused --");
{
  const p = normParams("compressor", { threshold_db: -999, ratio: 4 });
  ok("numbers clamp to the catalog range", p.threshold_db === -60);
  ok("omitted params take their defaults", p.attack_ms === 10 && p.knee_db === 6);
  let err = "";
  try { normParams("eq", { wet: 1 }); } catch (e) { err = e.message; }
  ok("an unknown param is refused naming the real ones", /has no parameter/.test(err) && /b1_hz/.test(err));
  err = "";
  try { normParams("delay", { sync: "1/7" }); } catch (e) { err = e.message; }
  ok("a bad enum is refused naming the values", /1\/8/.test(err));
}

console.log("\n  -- automation is the vfx shape, one format --");
{
  const v = normAuto({ keys: [{ t: 5, v: -12 }, { t: 1, v: 0, ease: "easeInOut" }] }, 0, -60, 12, "fader");
  ok("keys come back sorted with ease kept",
    v.keys[0].t === 1 && v.keys[0].ease === "easeInOut" && v.keys[1].t === 5);
  ok("the vfx evaluator reads it: halfway is -6",
    near(autoValueAt(v, 3), -6));
  ok("values clamp per key", normAuto({ keys: [{ t: 1, v: 99 }] }, 0, -60, 12).keys[0].v === 12);
  let err = "";
  try { normAuto({ keys: [] }, 0, -60, 12, "fader"); } catch (e) { err = e.message; }
  ok("an empty keys array is refused", /non-empty/.test(err));
  err = "";
  try {
    normAuto({ keys: Array.from({ length: 65 }, (_, i) => ({ t: i + 1, v: 0 })) }, 0, -60, 12, "fader");
  } catch (e) { err = e.message; }
  ok("more than 64 keys is refused", /64/.test(err));
}

console.log("\n  -- migration repairs, never refuses --");
{
  const doc = makeDoc();
  doc.tracks[0].inserts = [
    { type: "eq", params: { b1_gain_db: 99, junk: 5 } },   // junk param, wild value
    { type: "no_such_device" },
    null,
  ];
  doc.tracks[0].fader = "loud";
  doc.returns = [{ name: "Verb", inserts: [{ type: "reverb" }] }, false];
  doc.master = { inserts: [{ type: "limiter", params: { ceiling_db: 5 } }], fader: -900 };
  migrate(doc);
  ok("the unknown device is dropped, the eq survives with clamped params",
    doc.tracks[0].inserts.length === 1
    && doc.tracks[0].inserts[0].type === "eq"
    && doc.tracks[0].inserts[0].params.b1_gain_db === 18
    && !("junk" in doc.tracks[0].inserts[0].params));
  ok("nonsense fader falls back to 0", doc.tracks[0].fader === 0);
  ok("the return is kept, minted an id, chain migrated",
    doc.returns.length === 1 && /^ret_/.test(doc.returns[0].id)
    && doc.returns[0].inserts[0].type === "reverb");
  ok("the master limiter's ceiling clamps into range",
    doc.master.inserts[0].params.ceiling_db === 0 && doc.master.fader === -60);
}

console.log("\n  -- P0 PRESERVED: a default mixer changes not one hash byte --");
{
  const doc = makeDoc();
  note(doc, "trk_A", 2);
  note(doc, "trk_B", 14);
  ok("a migrated blank mixer is default", isDefaultMixer(doc));
  ok("its sig bundle is null (nothing enters the hash)", mixerSigBundle(doc) === null);
  const h0 = regionHashes(doc);
  const d = dirtyOf(doc, (x) => {
    x.tracks[0].inserts.push(ins("eq", { b2_gain_db: 6 }));
  });
  const h1 = regionHashes(doc);
  ok("adding a chain changes hashes", JSON.stringify(h0) !== JSON.stringify(h1));
  doc.tracks[0].inserts = [];
  ok("removing it RESTORES the P0 hashes exactly (old cache warm again)",
    JSON.stringify(regionHashes(doc)) === JSON.stringify(h0));
}

console.log("\n  -- CONFIG REACH: chain edits dirty where the track sounds --");
{
  // A sounds only in bars 1-2 (region 0); B only in bar 14 (region 3).
  const doc = makeDoc();
  note(doc, "trk_A", 1);
  note(doc, "trk_B", 14);
  const dUtil = dirtyOf(doc, (x) => {
    x.tracks[0].inserts.push(ins("utility", { gain_db: -6 }));
  });
  ok("the FIRST non-default edit dirties every sounding region (mono→stereo path switch)",
    dUtil.length === 2 && dUtil[0].idx === 0 && dUtil[1].idx === 3, JSON.stringify(dUtil));
  const dUtil2 = dirtyOf(doc, (x) => {
    x.tracks[0].inserts[0].params.gain_db = -3;
  });
  ok("from then on a MEMORYLESS edit on A dirties exactly A's region",
    dUtil2.length === 1 && dUtil2[0].idx === 0, JSON.stringify(dUtil2));
  const dB3 = dirtyOf(doc, (x) => {
    const b = x.tracks.find((t) => t.id === "trk_B");
    b.fader = -3;
  });
  ok("B's fader dirties exactly B's region", dB3.length === 1 && dB3[0].idx === 3,
    JSON.stringify(dB3));
  const dPan = dirtyOf(doc, (x) => {
    x.tracks[0].pan = normAuto({ keys: [{ t: 1, v: -1 }, { t: 3, v: 1 }] }, 0, -1, 1);
  });
  ok("a pan RIDE is still memoryless: A's region only",
    dPan.length === 1 && dPan[0].idx === 0, JSON.stringify(dPan));
  ok("the level-mix loop keeps P0 reach (no stateful path)",
    mixerReach(doc, doc.tracks[0]).fwd === 0);
}

console.log("\n  -- STATE REACH: a stateful chain stretches forward to ∞ --");
{
  const doc = makeDoc();
  note(doc, "trk_A", 1);
  note(doc, "trk_B", 14);
  const dEq = dirtyOf(doc, (x) => {
    x.tracks[0].inserts.push(ins("eq", { b2_gain_db: 6 }));
  });
  ok("a STATEFUL insert on A (bar-1 note) dirties region 0 AND everything after",
    dEq.length === 4, JSON.stringify(dEq));
  ok("A's reach is now [start-0.02, ∞)",
    mixerReach(doc, doc.tracks[0]).fwd === Infinity
    && mixerReach(doc, doc.tracks[0]).back === 0.02);
  ok("B's reach is untouched (its own path is clean... until the master isn't)",
    mixerReach(doc, doc.tracks[1]).fwd === 0);
  const dNote = dirtyOf(doc, (x) => {
    x.tracks[0].clips[0].notes[0].pitch = 64;
  });
  ok("editing A's bar-1 note through the stateful chain dirties forward too",
    dNote.length === 4, JSON.stringify(dNote));
  const dB = dirtyOf(doc, (x) => {
    note(x, "trk_B", 13);
  });
  ok("a B note edit stays local: region 3 only", dB.length === 1 && dB[0].idx === 3,
    JSON.stringify(dB));
}

console.log("\n  -- returns: consumers dirty, the unused return dirties nothing --");
{
  const doc = makeDoc();
  note(doc, "trk_A", 1);
  note(doc, "trk_B", 14);
  doc.returns.push({ id: "ret_V", name: "Verb", inserts: [ins("reverb")], fader: 0, pan: 0 });
  doc.returns.push({ id: "ret_X", name: "Unused", inserts: [], fader: 0, pan: 0 });
  regionHashes(doc); // settle
  const dSend = dirtyOf(doc, (x) => {
    x.tracks[0].sends.push({ to: "ret_V", level: 0, pre: false });
  });
  ok("routing A into the reverb return dirties A's regions (stateful: forward)",
    dSend.length === 4 && dSend[0].idx === 0, JSON.stringify(dSend));
  const dRet = dirtyOf(doc, (x) => {
    x.returns[0].inserts[0].params.room_size = 0.9;
  });
  ok("editing the RETURN's reverb dirties its consumers' regions",
    dRet.length === 4, JSON.stringify(dRet));
  const dUnused = dirtyOf(doc, (x) => {
    x.returns[1].inserts.push(ins("delay"));
  });
  ok("an unused return's chain dirties NOTHING (it is inaudible)",
    dUnused.length === 0, JSON.stringify(dUnused));
}

console.log("\n  -- the master: every SOUNDING region, and silence stays clean --");
{
  const doc = makeDoc();
  note(doc, "trk_A", 1);                     // regions 1..3 hold no events
  doc.master.inserts.push(ins("utility", { gain_db: -1 }));
  regionHashes(doc);
  const dM = dirtyOf(doc, (x) => {
    x.master.inserts[0].params.gain_db = -4;
  });
  ok("a MEMORYLESS master edit dirties the sounding region only",
    dM.length === 1 && dM[0].idx === 0, JSON.stringify(dM));
  const dLim = dirtyOf(doc, (x) => {
    x.master.inserts.push(ins("limiter"));
  });
  ok("a STATEFUL master device pulls every note's reach to ∞ (all sounding-forward regions)",
    dLim.length === 4, JSON.stringify(dLim));
  ok("...and every track now has the stateful path",
    trackStatefulPath(doc, doc.tracks[1]));
}

console.log("\n  -- sidechain drags the source into the stateful rule --");
{
  const doc = makeDoc();
  note(doc, "trk_A", 5);
  note(doc, "trk_B", 1);
  doc.tracks[0].inserts.push(ins("compressor", { sidechain: "trk_B" }));
  ok("B keys A's compressor → B is stateful-reached",
    trackStatefulPath(doc, doc.tracks[1]) && mixerReach(doc, doc.tracks[1]).fwd === Infinity);
  regionHashes(doc);
  const d = dirtyOf(doc, (x) => {
    x.tracks[1].clips[0].notes[0].vel = 40;
  });
  ok("softening B's kick re-keys everything forward of it",
    d.length === 4, JSON.stringify(d));
}

console.log("\n  -- solo composes with mute through the event list --");
{
  const doc = makeDoc();
  note(doc, "trk_A", 1);
  note(doc, "trk_B", 14);
  regionHashes(doc);
  const d = dirtyOf(doc, (x) => { x.tracks[0].solo = true; });
  ok("soloing A silences B: B's region dirties",
    d.some((r) => r.idx === 3), JSON.stringify(d));
  ok("...and B is inaudible while A stays",
    !mixerAudible(doc, doc.tracks[1]) && mixerAudible(doc, doc.tracks[0]));
  doc.tracks[0].solo = false;
  ok("un-solo restores the event list", mixerAudible(doc, doc.tracks[1]));
}

console.log("\n  -- the job payload: bars become seconds at the boundary, once --");
{
  const doc = makeDoc();
  note(doc, "trk_A", 1);
  doc.tracks[0].fader = normAuto({ keys: [{ t: 1, v: 0 }, { t: 3, v: -12 }] }, 0, -60, 12);
  doc.tempoMap = [{ atBar: 1, bpm: 120 }, { atBar: 9, bpm: 90 }];
  const pay = mixerJobPayload(doc);
  const keys = pay.tracks.trk_A.fader.keys;
  ok("bar 1 → 0 s, bar 3 → 4 s at 120 bpm", near(keys[0].t, 0) && near(keys[1].t, 4));
  ok("the tempo map rides along as [t, sec-per-quarter] segments",
    pay.spq.length === 2 && near(pay.spq[0][1], 0.5) && near(pay.spq[1][1], 60 / 90)
    && near(pay.spq[1][0], 16), JSON.stringify(pay.spq));
  ok("the stored document still holds BARS (payload did not mutate it)",
    doc.tracks[0].fader.keys[1].t === 3);
  doc.tracks[1].mute = true;
  ok("a muted track leaves the payload", !("trk_B" in mixerJobPayload(doc).tracks));
}

console.log("\n  -- the route actions list matches the dispatcher --");
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(HERE, "mixer.js"), "utf8");
  const cases = [...src.matchAll(/^\s*case "([a-z_]+)": \{/gm)].map((m) => m[1]);
  ok("every advertised action has a case",
    MIXER_ACTIONS.every((a) => cases.includes(a)),
    MIXER_ACTIONS.filter((a) => !cases.includes(a)).join(", "));
  ok("every case is advertised",
    cases.every((a) => MIXER_ACTIONS.includes(a)),
    cases.filter((a) => !MIXER_ACTIONS.includes(a)).join(", "));
  ok("routes.js dispatches to the mixer before its own switch",
    readFileSync(path.join(HERE, "routes.js"), "utf8").includes("handleMixerAction"));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
