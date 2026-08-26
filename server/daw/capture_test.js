/**
 * DAW capture — the maths between "samples arrive" and "a take sits on the
 * timeline", proven closed-form. [DAWREC]
 *
 * Everything here has an exact answer: chunk reassembly is byte identity,
 * placement is one multiplication, a comp is picks over known buffers, a
 * count-in is bars × beats × seconds — so every assertion compares against
 * arithmetic, not against the code under test. The actor-honesty section
 * pins the one rule that must never drift: an agent driving the record API
 * cannot mint a human-performance provenance event.
 *
 * Runs standalone (`node server/daw/capture_test.js`) and in the pre-commit
 * hook. Touches no disk beyond one settings file in the OS temp dir.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  beginSession, getSession, endSession, addChunk, assembleSession,
  latencyShift, takePlacement, punchTrim, flattenComp, clickEvents,
  readLatency, writeLatency, offsetFor, captureEvent, quantizePos,
} from "./capture.js";
import {
  blankProject, blankTrack, blankAudioClip, migrate,
  audioStartSample, audioEvents, regionHashes, regionsOf, dirtyBetween,
  posToSeconds, buildTimeline, SR, TICKS_PER_BEAT,
} from "./store.js";

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

function makeDoc(opts = {}) {
  const doc = blankProject("cap-test", { bpm: 120, num: 4, den: 4, lengthBars: 16, ...opts });
  doc.tracks.push(blankTrack("mic", "pluck"));
  return migrate(doc);
}

console.log("\n  -- chunk assembly is sample-exact across chunk boundaries --");
{
  const doc = makeDoc();
  const s = beginSession({
    slug: doc.slug, trackId: doc.tracks[0].id, sr: SR,
    at: { bar: 1, beat: 1, tick: 0 }, startSample: 0, shiftSamples: 0,
    countinBars: 1, countinSeconds: 2, device: "test", by: "user",
  });
  ok("the session is findable by id", getSession(s.id) === s);

  // a known ramp, split at deliberately awkward sizes (odd sample counts,
  // a 1-sample chunk) — reassembly must be the identical float sequence
  const total = 4801;
  const ramp = new Float32Array(total);
  for (let i = 0; i < total; i++) ramp[i] = Math.fround(Math.sin(i * 0.01) * (i / total));
  const cuts = [0, 1, 1024, 1025, 3000, 4800, total];
  const order = [3, 0, 5, 1, 4, 2];                 // arrival order ≠ seq order
  for (const seq of order) {
    const part = ramp.subarray(cuts[seq], cuts[seq + 1]);
    addChunk(s, seq, Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  }
  const out = assembleSession(s);
  ok(`assembled length is exact (${out.length})`, out.length === total);
  let identical = true;
  for (let i = 0; i < total; i++) if (out[i] !== ramp[i]) { identical = false; break; }
  ok("every sample is bit-identical across the chunk seams", identical);

  ok("a duplicate seq is refused loudly", /already received/.test(thrown(() =>
    addChunk(s, 2, Buffer.alloc(8)))));
  ok("a ragged chunk (not ×4 bytes) is refused", /float32/.test(thrown(() =>
    addChunk(s, 6, Buffer.alloc(7)))));
  endSession(s.id);
  ok("a finished session is gone", /No such recording session/.test(thrown(() => getSession(s.id))));
}
{
  const s = beginSession({ slug: "x", trackId: "t", sr: SR, at: { bar: 1, beat: 1, tick: 0 },
    startSample: 0, shiftSamples: 0, countinBars: 0, countinSeconds: 0, by: "user" });
  addChunk(s, 0, Buffer.alloc(16));
  addChunk(s, 2, Buffer.alloc(16));
  ok("a MISSING seq fails assembly naming the gap", /chunk 1 is missing/.test(thrown(() => assembleSession(s))));
  endSession(s.id);
}

console.log("\n  -- the latency offset is applied at placement --");
{
  ok("50 ms at 48 kHz shifts 2400 samples EARLIER", latencyShift(50, SR) === -2400);
  ok("0 ms shifts nothing", latencyShift(0, SR) === 0);
  const doc = makeDoc();
  // bar 3 of 4/4 @120 starts at 4 s = 192000 samples
  const posSample = Math.round(posToSeconds(doc, { bar: 3, beat: 1, tick: 0 }) * SR);
  ok("bar 3 anchors at sample 192000", posSample === 192000);
  const s = beginSession({
    slug: doc.slug, trackId: doc.tracks[0].id, sr: SR,
    at: { bar: 3, beat: 1, tick: 0 }, startSample: posSample,
    shiftSamples: latencyShift(50, SR),
    countinBars: 1, countinSeconds: 2, by: "user",
  });
  const place = takePlacement(s);
  ok("the take lands 2400 samples before its anchor (189600)", place.startSample === 189600);
  endSession(s.id);

  // and store.audioStartSample re-derives the same number from the stored take
  const clip = blankAudioClip("tk_x.flac", { bar: 3, beat: 1, tick: 0, shiftSamples: -2400, durSamples: 1000 });
  ok("audioStartSample agrees with the placement formula",
    audioStartSample(doc, clip) === 189600);
}

console.log("\n  -- punch in/out is a pure trim --");
{
  const samples = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) samples[i] = i;
  const t = punchTrim(samples, 5000, 5200, 5700);
  ok("the window is exact (500 samples from local 200)",
    t.samples.length === 500 && t.samples[0] === 200 && t.samples[499] === 699);
  ok("the start moved to the punch-in", t.startSample === 5200 && t.extraShift === 200);
  const noPunch = punchTrim(samples, 5000, null, null);
  ok("no punch = no trim", noPunch.samples.length === 1000 && noPunch.extraShift === 0);
  ok("an empty punch window is refused", /leaves nothing/.test(thrown(() =>
    punchTrim(samples, 5000, 7000, 8000))));
}

console.log("\n  -- comping: ordered picks flatten, later picks win --");
{
  const a = new Float32Array(400).fill(0.25);
  const b = new Float32Array(400).fill(0.5);
  const takes = new Map([
    ["tk_a", { start: 1000, samples: a }],
    ["tk_b", { start: 1200, samples: b }],
  ]);
  const flat = flattenComp([
    { take: "tk_a", fromSample: 1000, toSample: 1400 },
    { take: "tk_b", fromSample: 1300, toSample: 1600 },
  ], takes);
  ok("the comp window is min..max of the picks", flat.startSample === 1000 && flat.samples.length === 600);
  ok("before the overlap the first pick sounds", flat.samples[100] === 0.25);
  ok("in the overlap the LATER pick wins (order is priority)", flat.samples[350] === 0.5);
  ok("after take A ends only B sounds", flat.samples[550] === 0.5);
  // a pick past its take's samples leaves silence, honestly
  const flat2 = flattenComp([{ take: "tk_a", fromSample: 900, toSample: 1100 }], takes);
  ok("a pick reaching before the take leaves silence there",
    flat2.samples[0] === 0 && flat2.samples[99] === 0 && flat2.samples[100] === 0.25);
  ok("an unknown take is refused by name", /unknown take/.test(thrown(() =>
    flattenComp([{ take: "tk_zz", fromSample: 0, toSample: 10 }], takes))));
  ok("a backwards pick is refused", /to > from/.test(thrown(() =>
    flattenComp([{ take: "tk_a", fromSample: 10, toSample: 10 }], takes))));
}

console.log("\n  -- the count-in is meter-aware: 7/8 counts in 7 --");
{
  const doc = makeDoc();                               // 4/4 @120
  const ce = clickEvents(doc, 1, 4, 1, SR);
  ok("one 4/4 bar at 120 counts in over exactly 2 s", near(ce.countinSeconds, 2));
  ok("...which is 96000 samples", ce.countinSamples === 192000 / 2);
  const countinClicks = ce.events.filter((e) => e.sample < ce.countinSamples);
  ok("the count-in holds exactly 4 clicks", countinClicks.length === 4);
  ok("beat one of the count-in is accented, the rest are not",
    countinClicks[0].accent === true && countinClicks.slice(1).every((e) => !e.accent));
  ok("the first real bar's downbeat lands AT the count-in boundary",
    ce.events.some((e) => e.sample === ce.countinSamples && e.accent));

  const odd = makeDoc({ num: 7, den: 8 });             // 7/8 @120 quarter-bpm
  const ceOdd = clickEvents(odd, 1, 2, 1, SR);
  ok("one 7/8 bar at 120 counts in over 1.75 s", near(ceOdd.countinSeconds, 1.75));
  const oddCountin = ceOdd.events.filter((e) => e.sample < ceOdd.countinSamples);
  ok("SEVEN count-in clicks in 7/8 — never four", oddCountin.length === 7);
  ok("eighth-note spacing: clicks 0.25 s apart",
    oddCountin.every((e, i) => i === 0 || e.sample - oddCountin[i - 1].sample === SR / 4));

  // two count-in bars double the length
  const ce2 = clickEvents(doc, 1, 4, 2, SR);
  ok("countin_bars 2 counts 8 clicks over 4 s", near(ce2.countinSeconds, 4)
    && ce2.events.filter((e) => e.sample < ce2.countinSamples).length === 8);

  // a count-in into bar 5 uses BAR 5's meter
  const mixed = makeDoc();
  mixed.meterMap.push({ atBar: 5, num: 7, den: 8 });
  const ce5 = clickEvents(migrate(mixed), 5, 2, 1, SR);
  ok("counting into a 7/8 bar 5 counts in 7 (1.75 s), whatever bar 1 is",
    near(ce5.countinSeconds, 1.75)
    && ce5.events.filter((e) => e.sample < ce5.countinSamples).length === 7);
}

console.log("\n  -- audio clips reach the region hashes (the dirty mechanism) --");
{
  const doc = makeDoc();
  const before = regionHashes(doc);
  doc.tracks[0].audioClips.push(blankAudioClip("imp_1.flac", {
    bar: 9, beat: 1, tick: 0, durSamples: SR,        // one second in bar 9
  }));
  const after = regionHashes(doc);
  const dirty = dirtyBetween(before, after, regionsOf(doc));
  ok("adding a clip in bar 9 dirties exactly the bar-9 region",
    dirty.length === 1 && dirty[0].fromBar === 9 && dirty[0].toBar === 12, JSON.stringify(dirty));
  const evs = audioEvents(doc);
  ok("the event carries the absolute placement (bar 9 = 16 s = 768000)",
    evs.length === 1 && evs[0].startSample === 768000);
  const g1 = regionHashes(doc);
  doc.tracks[0].audioClips[0].gainDb = -6;
  const g2 = regionHashes(doc);
  ok("a clip gain change re-keys only its region",
    dirtyBetween(g1, g2, regionsOf(doc)).length === 1);
  doc.tracks[0].mute = true;
  ok("a muted track's audio clips vanish from the events (un-mute = dirty)",
    audioEvents(doc).length === 0);
}

console.log("\n  -- the per-device latency store --");
{
  const cfg = { settingsFile: path.join(os.tmpdir(), `dawrec_settings_${process.pid}.json`) };
  const t0 = await readLatency(cfg);
  ok("an absent settings file reads as an empty table", JSON.stringify(t0) === "{}");
  await writeLatency(cfg, "USB Mic (deluxe)", 87.312);
  await writeLatency(cfg, "default", 12);
  const t1 = await readLatency(cfg);
  ok("offsets round-trip per device label", t1["USB Mic (deluxe)"] === 87.312 && t1.default === 12);
  ok("offsetFor: exact label wins", offsetFor(t1, "USB Mic (deluxe)") === 87.312);
  ok("offsetFor: unknown label falls back to default", offsetFor(t1, "some other mic") === 12);
  ok("offsetFor: empty table is 0", offsetFor({}, "anything") === 0);
  await unlink(cfg.settingsFile).catch(() => {});
}

console.log("\n  -- ACTOR HONESTY at the capture seam --");
{
  const user = captureEvent("user", "audio", { device: "mic" });
  ok("a browser capture is a RECORD event (human-recorded)", user.type === "record");
  const agent = captureEvent("agent:mcp", "audio", {});
  ok("the SAME call driven by an agent is an IMPORT, never a record",
    agent.type === "import" && agent.data.origin === "third-party/existing");
  const sys = captureEvent("system", "audio", {});
  ok("an unattributable actor is an import too — never promoted", sys.type === "import");
  const midi = captureEvent("agent:mcp", "midi", {});
  ok("MIDI capture follows the same rule", midi.type === "import");
}

console.log("\n  -- quantize (optional, grid ticks) --");
{
  const q = quantizePos(2, 130, 240, 4);               // near beat 2 tick 240
  ok("130 ticks late snaps to the 240 grid", q.beat === 2 && q.tick === 240);
  const q2 = quantizePos(1, 100, 240, 4);
  ok("100 ticks snaps back to the beat", q2.beat === 1 && q2.tick === 0);
  const q3 = quantizePos(4, 900, 240, 4);              // would round past the bar
  ok("the bar's end clamps rather than spilling into bar+1",
    q3.beat === 4 && q3.tick <= TICKS_PER_BEAT - 1);
  ok("grid = a full beat snaps to beats", JSON.stringify(quantizePos(3, 500, 960, 4)) === JSON.stringify({ beat: 4, tick: 0 }));
}

/* The capture UI binds its listeners at MODULE TOP LEVEL, so one id that
 * daw.html does not carry is `null.addEventListener` — a TypeError during
 * evaluation that kills the WHOLE daw.js module, piano roll included, and
 * the browser swallows it. That is exactly what scripts/trace_load.mjs
 * exists for, and trace_load only evaluates web/app.js. A stub DOM cannot
 * catch it either (every stub element is a Proxy that answers to anything),
 * so the honest check is textual: every id daw.js reaches for must exist. */
console.log("\n  -- the capture UI is actually wired to elements that exist --");
{
  const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
  const js = readFileSync(path.join(web, "daw.js"), "utf8");
  const html = readFileSync(path.join(web, "daw.html"), "utf8");
  const inHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const missing = wanted.filter((id) => !inHtml.has(id));
  ok(`every id daw.js reaches for exists in daw.html (${wanted.length} checked)`,
    missing.length === 0, missing.join(", "));
  /* And the capture cluster by name, so deleting one of these from the page
   * fails here instead of removing a feature quietly. */
  for (const id of ["recBtn", "cntIn", "recDev", "impBtn", "impFile", "calOpen",
                    "midiDev", "midiRecBtn", "midiQuant", "takes",
                    "calDlg", "calRunMic", "calRunSyn", "calStore", "calResult"]) {
    ok(`the capture UI carries #${id}`, inHtml.has(id) && js.includes(`$("${id}")`));
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
