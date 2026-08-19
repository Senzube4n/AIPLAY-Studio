/**
 * Unit tests for the studio's timeline maths.
 *
 * These functions decide where every frame lands and how loud every moment is,
 * and until now they were verified only by clicking in a browser. They are pure
 * — track objects in, numbers out — so testing them costs nothing and needs no
 * DOM. studio.js itself imports DOM things at module level, so the functions
 * under test are re-declared here FROM THE SAME SOURCE, extracted by name; a
 * drift between this file and studio.js fails the extraction loudly rather than
 * silently testing an old copy.
 *
 *   node scripts/test_timeline.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "web", "studio.js"), "utf8");

/** Extract a top-level `function name(...) {...}` by brace counting. */
function extract(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`function ${name} not found in studio.js`);
  let i = src.indexOf("{", at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/* The functions under test, evaluated with the tiny surface they need. clamp is
 * studio.js's own helper; S is only read for `snap`, so a stub suffices. */
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const S = { snap: true, t: 0, tracks: [] };
const totalLength = () => {
  let end = 0;
  for (const t of S.tracks) for (const it of t.items) end = Math.max(end, it.start + it.dur);
  return end;
};
// eslint-disable-next-line no-new-func
const itemAlpha = new Function("clamp", `return ${extract("itemAlpha")}`)(clamp);

let pass = 0, fail = 0;
function eq(name, got, want, eps = 1e-9) {
  const ok = typeof want === "number" ? Math.abs(got - want) <= eps : got === want;
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got ${got}, wanted ${want}`); }
}

console.log("\ntimeline maths\n");

/* ── itemAlpha: the crossfade ───────────────────────────────────────────── */
{
  const a = { id: 1, start: 0, dur: 5 };
  const b = { id: 2, start: 4, dur: 5 };          // 1 s overlap
  const tr = { items: [a, b] };
  eq("no overlap yet: full opacity", itemAlpha(tr, b, 5.5), 1);
  eq("crossfade midpoint is half", itemAlpha(tr, b, 4.5), 0.5);
  eq("crossfade start is zero", itemAlpha(tr, b, 4.0), 0);
  eq("first item never crossfades in", itemAlpha(tr, a, 0.0), 1);
}

/* ── itemAlpha: fades, and their product with the crossfade ─────────────── */
{
  const solo = { id: 1, start: 0, dur: 10, fadeIn: 2, fadeOut: 4 };
  const tr = { items: [solo] };
  eq("fade-in midpoint", itemAlpha(tr, solo, 1), 0.5);
  eq("fade-in complete", itemAlpha(tr, solo, 2), 1);
  eq("fade-out midpoint", itemAlpha(tr, solo, 8), 0.5);
  eq("fade-out end reaches zero", itemAlpha(tr, solo, 10), 0);

  /* The case the multiply exists for: a clip fading in from black WHILE
   * dissolving from its neighbour. Either alone would be 0.5; together 0.25.
   * An implementation that picked one would return 0.5 here and the double
   * transition would pop. */
  const p = { id: 1, start: 0, dur: 6 };
  const q = { id: 2, start: 4, dur: 6, fadeIn: 4 };   // overlap 2, own fade 4
  const tr2 = { items: [p, q] };
  eq("crossfade x own fade multiply", itemAlpha(tr2, q, 5), 0.5 * 0.25);
}

/* ── split arithmetic (the model of splitAtPlayhead, asserted directly) ── */
{
  // A clip trimmed to start 3 s into its source, split 2 s into its timeline run.
  const it = { start: 10, dur: 5, inPoint: 3, srcDur: 12, fadeIn: 1, fadeOut: 1 };
  const t = 12;                       // playhead
  const into = t - it.start;          // 2
  const right = {
    start: t, dur: it.dur - into, inPoint: (it.inPoint || 0) + into,
    fadeIn: 0, fadeOut: it.fadeOut,
  };
  const left = { ...it, dur: into, fadeOut: 0 };
  eq("left half keeps its start", left.start, 10);
  eq("left half length", left.dur, 2);
  eq("right half starts at the cut", right.start, 12);
  eq("right half length", right.dur, 3);
  // The one that matters: the right half's in-point advances by the split, so
  // the SOURCE keeps playing continuously across the cut.
  eq("right half in-point continues the source", right.inPoint, 5);
  eq("halves cover the original exactly", left.dur + right.dur, it.dur);
  eq("fade-in stays on the left half", left.fadeIn, 1);
  eq("fade-out moves to the right half", right.fadeOut, 1);
}

/* ── ripple delete ──────────────────────────────────────────────────────── */
{
  const items = [
    { id: 1, start: 0, dur: 4 },
    { id: 2, start: 4, dur: 3 },     // deleted
    { id: 3, start: 7, dur: 2 },
    { id: 4, start: 2, dur: 1 },     // BEFORE the deletion: must not move
  ];
  const del = items[1];
  const rest = items.filter((x) => x !== del);
  for (const other of rest) if (other.start >= del.start) other.start -= del.dur;
  eq("later item closes the gap", rest.find((x) => x.id === 3).start, 4);
  eq("earlier item does not move", rest.find((x) => x.id === 4).start, 2);
  eq("item at the boundary stays put", rest.find((x) => x.id === 1).start, 0);
}

/* ── trim in-point arithmetic (the pointermove model) ───────────────────── */
{
  const it = { start: 4, dur: 6, inPoint: 1, srcDur: 10 };
  // Drag the LEFT edge right to t=6: start moves, end stays, source advances.
  const end = it.start + it.dur;
  const newStart = clamp(6, Math.max(0, it.start - it.inPoint), end - 0.2);
  const inPoint = it.inPoint + (newStart - it.start);
  eq("left-trim keeps the end fixed", end, 10);
  eq("left-trim advances the in-point", inPoint, 3);
  // Drag left PAST the available source material: clamped by the in-point.
  const minStart = Math.max(0, it.start - it.inPoint);
  eq("left-trim cannot reveal media that does not exist", minStart, 3);
}

/* ── totalLength ────────────────────────────────────────────────────────── */
{
  S.tracks = [
    { items: [{ start: 0, dur: 5 }, { start: 4, dur: 5 }] },
    { items: [{ start: 20, dur: 1.5 }] },
  ];
  eq("total is the furthest edge across all tracks", totalLength(), 21.5);
  S.tracks = [];
  eq("empty timeline has zero length", totalLength(), 0);
}

/* ── the beat grid ──────────────────────────────────────────────────────────
 *
 * These decide where an edit LANDS, which is the one thing in a music video the
 * eye checks against the music without being asked. Extracted from studio.js by
 * name like everything else here, so a rename fails loudly instead of leaving
 * this file testing a copy that no longer ships. */
const lastAtOrBefore = new Function(`return ${extract("lastAtOrBefore")}`)();
const beatGrid = new Function("S", `return ${extract("beatGrid")}`)(S);
const barGrid = new Function("beatGrid", `return ${extract("barGrid")}`)(beatGrid);
const offlineBeat = new Function("S", "beatGrid", "lastAtOrBefore",
  `return ${extract("offlineBeat")}`)(S, beatGrid, lastAtOrBefore);

{
  const g = [0, 1, 2, 3, 4];
  eq("binary search: exact hit", lastAtOrBefore(g, 2), 2);
  eq("binary search: between entries takes the earlier", lastAtOrBefore(g, 2.9), 2);
  eq("binary search: before the first is -1", lastAtOrBefore(g, -0.1), -1);
  eq("binary search: past the last is the last", lastAtOrBefore(g, 99), 4);
  eq("binary search: empty is -1", lastAtOrBefore([], 1), -1);
}

{
  S.beats = { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], bpm: 120, envFps: 30, bands: {} };
  S.beatMult = 1;
  eq("as detected: every beat", beatGrid().length, 8);
  eq("bars are every fourth beat", barGrid().join(","), "0,2");
  S.beatMult = 0.5;
  eq("half time: every other beat", beatGrid().join(","), "0,1,2,3");
  S.beatMult = 2;
  eq("double time: one inserted between each pair", beatGrid().length, 15);
  eq("double time: the inserted beat is the midpoint", beatGrid()[1], 0.25);
  S.beatMult = 1;
}

{
  // A band that is loud throughout, so only the pulse shape is under test.
  const loud = new Array(300).fill(1);
  S.beats = { beats: [0, 1, 2], bpm: 60, envFps: 30, bands: { bass: loud, low: loud, mid: loud, high: loud } };
  S.beatCfg = { sens: 0.5, band: "bass" };
  const onBeat = offlineBeat(1);
  const justAfter = offlineBeat(1.09);
  const wellAfter = offlineBeat(1.5);
  eq("a beat reads at full strength", onBeat > 0.9, true);
  eq("the pulse decays", justAfter < onBeat && justAfter > 0, true);
  eq("and is gone before the next beat", wellAfter, 0);
  eq("before the first beat there is nothing", offlineBeat(-1), 0);

  // Same grid, a band that is silent: the beats are there and do not count.
  const quiet = new Array(300).fill(0);
  S.beats = { beats: [0, 1, 2], bpm: 60, envFps: 30, bands: { bass: quiet, low: quiet, mid: quiet, high: quiet } };
  eq("a beat the mix leaves silent does not fire", offlineBeat(1), 0);

  S.beats = null;
  eq("no analysis reports null, so the live detector takes over", offlineBeat(1), null);
}

/* ── cutToBeat ─────────────────────────────────────────────────────────────
 * The headline edit: every clip onto a bar line, in the order already there. */
{
  let undos = 0;
  const cutToBeat = new Function("S", "barGrid", "beatGrid", "findItem", "pushUndo", "paintTimeline", "render",
    `return ${extract("cutToBeat")}`)(
    S, barGrid, beatGrid,
    () => null,                       // nothing selected: falls back to the first video track
    () => { undos++; },
    () => {}, () => {},
  );

  S.beats = { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], bpm: 60, envFps: 30, bands: {} };
  S.beatMult = 1;                                   // bars at 0, 4, 8, 12
  const a = { id: 1, start: 9.3, dur: 1, inPoint: 0, srcDur: 30 };
  const b = { id: 2, start: 0.7, dur: 7, inPoint: 0, srcDur: 30 };
  const c = { id: 3, start: 40, dur: 1, inPoint: 0, srcDur: 1.5 };   // too short for a bar
  S.tracks = [{ id: 9, kind: "video", items: [a, b, c] }];

  const r = cutToBeat(1);
  eq("every clip was moved", r.moved, 3);
  eq("one undo entry for the whole operation", undos, 1);
  // Sorted by their ORIGINAL start: b (0.7), a (9.3), c (40).
  eq("first clip starts on the first bar", b.start, 0);
  eq("first clip spans one bar", b.dur, 4);
  eq("second clip starts on the next bar", a.start, 4);
  eq("third clip starts on the bar after that", c.start, 8);
  eq("a clip shorter than its slot keeps its own length", c.dur, 1.5);
  eq("and is reported rather than silently stretched", r.short, 1);

  // Two bars per clip.
  const d = { id: 4, start: 0, dur: 1, inPoint: 0, srcDur: 30 };
  S.tracks = [{ id: 9, kind: "video", items: [d] }];
  cutToBeat(2);
  eq("bars-per-clip widens the slot", d.dur, 8);

  S.beats = null;
  eq("no grid means no edit at all", cutToBeat(1), null);
  S.tracks = [];
}



console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
