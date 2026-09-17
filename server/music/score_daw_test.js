/**
 * A score into the DAW and out as MIDI, 2026-09-17.
 *
 * §1 the plan: tempo, meter, one track per voice, notes at bar.beat.tick with
 * dur_ticks in the DAW's 960-per-beat grammar, chords as markers, the length
 * in bars; 3/4 and 6/8 place the beat by the denominator note; a broken score
 * is refused. §2 the MIDI file, parsed back byte by byte: header, tempo,
 * meter, programmes, note on/off at 480 ppq with offs before ons at a shared
 * tick, chord markers. §3 the route, the tool, the panel and the doc. No card.
 */
import fs from "node:fs";
import { scoreToDawPlan, scoreToMidi, DAW_TICKS_PER_BEAT, MIDI_PPQ } from "./score_daw.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const HEAD = (m, q) => `X:1\nT:\nM:${m}\nL:1/32\nQ:1/4=${q}\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% intro\n`;
// Bar 1: C (quarter) D (quarter) E (half); bar 2: a whole-bar rest; chord
// symbols on Vocal, where the dialect keeps harmony; Ins silent.
const SCORE = HEAD("4/4", 92) + `V: Vocal\n"C"C8D8E16|"G7"z32|\nV: Ins\nz32|z32|\n`;

console.log("\n§1  the plan");
{
  const plan = scoreToDawPlan(SCORE, { name: "t" });
  eq("tempo and meter come from the header", [plan.bpm, plan.num, plan.den], [92, 4, 4]);
  eq("one track per voice with its default patch", plan.tracks.map((t) => [t.name, t.instrument]), [["Vocal", "salamander"], ["Ins", "pluck"]]);
  eq("three notes on the Vocal track", plan.notes.filter((n) => n.track === "Vocal").length, 3);
  const [c, d, e] = plan.notes.filter((n) => n.track === "Vocal");
  eq("C at 1.1.0, one beat", [c.bar, c.beat, c.tick, c.dur_ticks, c.pitch], [1, 1, 0, DAW_TICKS_PER_BEAT, 60]);
  eq("D at 1.2.0", [d.bar, d.beat, d.tick, d.pitch], [1, 2, 0, 62]);
  eq("E at 1.3.0, two beats", [e.bar, e.beat, e.tick, e.dur_ticks, e.pitch], [1, 3, 0, 2 * DAW_TICKS_PER_BEAT, 64]);
  eq("the chords are markers where the dialect keeps them, on Vocal", plan.markers.map((m) => [m.track, m.bar, m.beat, m.symbol]), [["Vocal", 1, 1, "C"], ["Vocal", 2, 1, "G7"]]);
  eq("two bars long", plan.lengthBars, 2);
  eq("...and the counts say so", plan.counts, { notes: 3, chords: 2, voices: 2 });
  const waltz = scoreToDawPlan(HEAD("3/4", 120) + `V: Vocal\nC8D8E8|\nV: Ins\nz24|\n`);
  eq("3/4: three quarter notes are beats 1, 2, 3", waltz.notes.map((n) => [n.beat, n.tick]), [[1, 0], [2, 0], [3, 0]]);
  const six = scoreToDawPlan(HEAD("6/8", 120) + `V: Vocal\nC4D4E4F4G4A4|\nV: Ins\nz24|\n`);
  eq("6/8: an eighth note is one beat of the DAW's 960", [six.num, six.den, six.notes[1].beat, six.notes[0].dur_ticks], [6, 8, 2, DAW_TICKS_PER_BEAT]);
  const off = scoreToDawPlan(HEAD("4/4", 100) + `V: Vocal\nz4C4z8D16|\nV: Ins\nz32|\n`);
  eq("an off-beat start lands on the tick", [off.notes[0].beat, off.notes[0].tick, off.notes[1].beat, off.notes[1].tick], [1, 480, 3, 0]);
  let refused = false;
  try { scoreToDawPlan("X:1\nnot a score"); } catch (e) { refused = /does not parse/.test(e.message); }
  ok("a score that does not parse is refused by sentence", refused);
}

console.log("\n§2  the MIDI file, read back");
{
  const buf = scoreToMidi(SCORE, { name: "t" });
  const rd32 = (o) => buf.readUInt32BE(o), rd16 = (o) => buf.readUInt16BE(o);
  eq("MThd, format 1, two tracks (the silent Ins voice is left out), 480 ppq", [buf.toString("latin1", 0, 4), rd32(4), rd16(8), rd16(10), rd16(12)], ["MThd", 6, 1, 2, MIDI_PPQ]);
  // Walk the chunks.
  const chunks = [];
  let o = 14;
  while (o < buf.length) { const len = rd32(o + 4); chunks.push(buf.subarray(o + 8, o + 8 + len)); o += 8 + len; }
  eq("two track chunks", chunks.length, 2);
  const readVlq = (b, i) => { let v = 0; for (;;) { const x = b[i++]; v = (v << 7) | (x & 0x7f); if (!(x & 0x80)) return [v, i]; } };
  function events(b) {
    const out = []; let i = 0, at = 0, running = null;
    while (i < b.length) {
      let dt; [dt, i] = readVlq(b, i); at += dt;
      let st = b[i];
      if (st === 0xff) { const type = b[i + 1]; let len; [len, i] = readVlq(b, i + 2); out.push({ at, meta: type, data: b.subarray(i, i + len) }); i += len; continue; }
      if (st & 0x80) { running = st; i += 1; } else st = running;
      const kind = st & 0xf0, chn = st & 0x0f;
      const n = (kind === 0xc0 || kind === 0xd0) ? 1 : 2;
      out.push({ at, kind, chn, d: [...b.subarray(i, i + n)] }); i += n;
    }
    return out;
  }
  const t0 = events(chunks[0]);
  const tempo = t0.find((e) => e.meta === 0x51), sig = t0.find((e) => e.meta === 0x58);
  eq("track 0 carries the tempo (92 bpm = 652174 µs)", (tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2], 652174);
  eq("...and the meter 4/4", [sig.data[0], sig.data[1]], [4, 2]);
  const vocal = events(chunks[1]);
  eq("the Vocal track is named and set to Choir Aahs", [Buffer.from(vocal[0].data).toString(), vocal[1].kind, vocal[1].d[0]], ["Vocal", 0xc0, 52]);
  const ons = vocal.filter((e) => e.kind === 0x90).map((e) => [e.at, e.d[0]]);
  const offs = vocal.filter((e) => e.kind === 0x80).map((e) => [e.at, e.d[0]]);
  eq("note ons at 0, 480, 960 (quarter = 480)", ons, [[0, 60], [480, 62], [960, 64]]);
  eq("note offs at 480, 960, 1920", offs, [[480, 60], [960, 62], [1920, 64]]);
  const iOffD = vocal.findIndex((e) => e.kind === 0x80 && e.d[0] === 60), iOnD = vocal.findIndex((e) => e.kind === 0x90 && e.d[0] === 62);
  ok("at a shared tick the off comes before the on", iOffD < iOnD);
  eq("the Vocal track carries the chords as markers", vocal.filter((e) => e.meta === 0x06).map((e) => [e.at, Buffer.from(e.data).toString()]), [[0, "C"], [1920, "G7"]]);
  ok("...and ends with end-of-track", vocal[vocal.length - 1].meta === 0x2f);
}

console.log("\n§3  the route, the tool, the panel and the doc");
{
  const routes = src("../score/routes.js"), tools = src("../mcp-music-score.js"), panel = src("../../web/score-panel.js"),
    html = src("../../web/index.html"), api = src("../../API.md"), router = src("../chat/router.js");
  ok("the score door serves a version as .mid", /p\.startsWith\("\/api\/score\/midi\/"\) && req\.method === "GET"/.test(routes) && /scoreToMidi\(/.test(routes));
  ok("...and builds a DAW project from a version on action to_daw", /case "to_daw":/.test(routes) && /scoreToDawPlan\(/.test(routes) && /action: "add_note"/.test(routes));
  ok("score_to_daw and score_export_midi exist", /name: "score_to_daw"/.test(tools) && /name: "score_export_midi"/.test(tools));
  ok("...routed", /score_to_daw: null,/.test(router) && /score_export_midi: null,/.test(router));
  ok("the panel offers MIDI and Open in DAW", /id="scoreMidi"/.test(html) && /id="scoreDaw"/.test(html) && /action: "to_daw"/.test(panel) && /\/api\/score\/midi\//.test(panel));
  ok("the API doc names both", /### `GET \/api\/score\/midi\/<slug>\/<version>\.mid`/.test(api) && /"to_daw"/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
