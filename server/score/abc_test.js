/**
 * THE SCORE READER — the guard suite. No server, no python, no GPU, no disk
 * beyond two fixture files.
 *
 * What each section is guarding, because a check whose reason is not written
 * down is a check somebody deletes:
 *
 *  · 🔴 THE HEADER IS NOT THE BASIS. This is the whole file. The prototype
 *    (the first section-map prototype) took beats-per-bar from the M: field, a score
 *    had been hand-edited from M:2/4 to M:4/4 without re-barring, and the
 *    nominal duration came out 1.9476x the real audio. Every duration on every
 *    screen downstream inherits that number, so the disagreement is invariant
 *    zero and the fixture that carries it is a real render's real score.
 *
 *  · THE DISAGREEMENT IS EXPOSED, NOT RAISED. The vendor's own parser
 *    (abc_tools.py:154) refuses the fixture outright, which is why it cannot
 *    say which of the two fields is wrong. Every structural assertion it makes
 *    by throwing, this makes by recording, and the tests below drive the
 *    recording path on inputs that would have thrown.
 *
 *  · A SECTION NAME IS NOT A KEY. MEASURED: the fixture names `verse`,
 *    `pre-chorus` and `chorus` twice each. DIRECTING.md:1231-1238 measured what
 *    a key that is unique within one film and identical across two does —
 *    sixteen shots stamped complete in four seconds for a film never rendered.
 *    So the slug, the version, the name AND the ordinal all go into the key, and
 *    dropping any one of them is a test failure here.
 *
 *  · SCORE TIME IS NOT AUDIO TIME AND THE CAVEAT TRAVELS WITH THE NUMBERS.
 *    Section granularity is asserted, the scale is asserted to be absent rather
 *    than 1 when no audio duration was measured, and the caveat string is
 *    required to still be there.
 *
 * Runs standalone: `node server/score/abc_test.js`.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");

const {
  readScoreText, readScore, invariants, worstSeverity, sectionMap, sectionKey,
  secondsPerBar, nominalSeconds, headerQuartersPerBar, UNIT_DURATIONS, VOICES,
} = await import("./abc.js");

let pass = 0;
const failures = [];
function ok(what, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ok    ${what}`); return true; }
  failures.push(what);
  console.log(`  FAIL  ${what}${detail ? `\n          ${detail}` : ""}`);
  return false;
}
const eq = (what, a, b) => ok(`${what} = ${JSON.stringify(b)}`, a === b, `got ${JSON.stringify(a)}`);
const near = (what, a, b, tol) =>
  ok(`${what} ≈ ${b} (±${tol})`, Number.isFinite(a) && Math.abs(a - b) <= tol, `got ${a}`);

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** The real render's real score. See fixtures/README.md — the defect is deliberate. */
const REAL = readFileSync(path.join(FIX, "yue2_score.abc"), "utf8");
const RECEIPT = JSON.parse(readFileSync(path.join(FIX, "yue2_result.json"), "utf8"));
/** MEASURED, off the receipt itself rather than typed here. */
const REAL_AUDIO = RECEIPT.audio_seconds;

/**
 * A minimal well-formed score whose header and content AGREE, for contrast.
 *
 * M:2/4 with L:1/16 means 8 units to a bar (abc_tools.py:110 — a digit is
 * `units * unit * 4` quarter notes, so 8 × 1/16 × 4 = 2 quarters). Every bar
 * below sums to exactly 8 units, which is the property the fixture exists to
 * have: `cdef` would be 4 units and a bar of ONE quarter, and a fixture whose
 * own bars disagreed would fail invariant 2 while claiming to test invariant 1.
 */
const AGREE = [
  "X:1", "T:", "M:2/4", "L:1/16", "Q:1/4=120",
  'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
  'V: Ins clef=treble name="Ins Melody" snm="Inst."',
  "K:C",
  "% intro",
  "V: Vocal", '"C"z8|"C"z8|',
  "V: Ins", "c8|d8|",
  "% verse",
  "V: Vocal", '"C"c2d2e2f2|"G"g2f2e2d2|',
  "V: Ins", "Z2|",
  "% verse",
  "V: Vocal", '"C"c2d2e2f2|"G"g2f2e2d2|',
  "V: Ins", "Z2|",
].join("\n");

/* ════════════════════════════════════════════════════════════════════════
 * 1 · 🔴 THE DEFECT. Header against content, on the score it happened to.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n1 · the header-vs-content meter disagreement\n");
{
  const s = readScoreText(REAL);

  eq("the M: field claims", s.headers.meter, "4/4");
  eq("...which is quarter notes per bar", s.headers.headerQuartersPerBar, 4);
  eq("the BARS spell quarter notes per bar", s.contentQuartersPerBar, 2);
  eq("bars per voice (MEASURED 122)", s.barsPerVoice.Vocal, 122);
  eq("...and the other voice agrees", s.barsPerVoice.Ins, 122);

  /* The two numbers that made this file necessary. */
  near("content-derived nominal seconds (MEASURED 162.667)", nominalSeconds(s), 162.667, 0.002);
  const headerNominal = 122 * s.headers.headerQuartersPerBar * (60 / s.headers.bpm);
  near("header-derived nominal seconds, for the record (MEASURED 325.333)", headerNominal, 325.333, 0.002);
  near("the header is out against the audio by (MEASURED 1.9476x)", headerNominal / REAL_AUDIO, 1.9476, 0.001);
  near("the content is out against the audio by (MEASURED 2.69%)",
    (REAL_AUDIO / nominalSeconds(s) - 1) * 100, 2.688, 0.01);

  const rows = invariants(s, { audioSeconds: REAL_AUDIO });
  eq("invariant ZERO is the meter check", rows[0].id, "meter_header_vs_content");
  ok("...and it fails on this score", rows[0].ok === false, JSON.stringify(rows[0]));
  eq("...at severity", rows[0].severity, "blocking");
  eq("...reporting the factor", rows[0].measured.ratio, 2);
  ok("...and quoting both numbers, not just a verdict",
    rows[0].measured.header === 4 && rows[0].measured.content === 2, JSON.stringify(rows[0].measured));
  ok("...with the prose naming the fields a human can look at",
    /M:4\/4/.test(rows[0].what) && /notes spell 2/.test(rows[0].what), rows[0].what);
  eq("the worst severity on this score", worstSeverity(rows), "blocking");

  /* THE POINT: nothing downstream may take the header. */
  const map = sectionMap(s, { slug: "rain", versionId: "v1", audioSeconds: REAL_AUDIO });
  eq("the map declares its basis", map.basis, "content");
  eq("...and reports the header beside it rather than hiding it", map.headerQuartersPerBar, 4);
  eq("...and the quarters it actually used", map.quartersPerBar, 2);
  near("seconds per bar (MEASURED 1.3333)", map.secondsPerBar, 1.333333, 1e-5);
}

{
  const s = readScoreText(AGREE);
  const rows = invariants(s);
  eq("a score whose header and content agree passes invariant zero", rows[0].ok, true);
  eq("...at severity", rows[0].severity, "note");
  eq("...and the two numbers are the same", rows[0].measured.ratio, 1);
  eq("nothing else on it is worse than a note", worstSeverity(rows), null);
}

/* ════════════════════════════════════════════════════════════════════════
 * 2 · THE OTHER INVARIANTS. Each one is a thing abc_tools.py raises on.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n2 · every structural assertion the vendor makes by throwing\n");
{
  const id = (rows, k) => rows.find((r) => r.id === k);

  /* A duration outside abc_tools.py:30's set. MEASURED: `14` alone makes 2 of
   * the 14 measured scores unopenable to the vendor.
   * L:1/32 here so a 2/4 bar is 16 units and `c14z2` still SUMS — which is the
   * point: the bar total is right, the score survives, and the defect is named
   * rather than being the thing that ends the read. */
  const dur = [
    "X:1", "T:", "M:2/4", "L:1/32", "Q:1/4=120",
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
    'V: Ins clef=treble name="Ins Melody" snm="Inst."',
    "K:C", "% verse",
    "V: Vocal", '"C"c14z2|"G"g4f4e4d4|',
    "V: Ins", "Z2|",
  ].join("\n");
  const sd = readScoreText(dur);
  const rd = invariants(sd);
  ok("an unsupported note length is REPORTED, not raised", id(rd, "duration_vocabulary").ok === false,
    JSON.stringify(id(rd, "duration_vocabulary")?.measured));
  eq("...at severity", id(rd, "duration_vocabulary").severity, "warn");
  ok("...naming the offending length", /14/.test(id(rd, "duration_vocabulary").what),
    id(rd, "duration_vocabulary").what);
  ok("...and the score is still readable enough to count bars",
    sd.barsPerVoice.Vocal === 2, JSON.stringify(sd.barsPerVoice));
  eq("...and the offending bar still sums to the meter", sd.contentQuartersPerBar, 2);
  eq("...so the header check is not collaterally tripped", rd[0].ok, true);
  ok("...with 14 genuinely not in the vendor's set", !UNIT_DURATIONS.has(14));

  /* abc_tools.py:216 — chords belong to Vocal. */
  const ins = AGREE.replace("V: Ins\nc8|d8|", 'V: Ins\n"C"c8|d8|');
  const ri = invariants(readScoreText(ins));
  ok(`a chord symbol on ${VOICES[1]} is reported`, id(ri, "chords_in_vocal_only").ok === false,
    JSON.stringify(id(ri, "chords_in_vocal_only")?.measured));
  eq("...at severity", id(ri, "chords_in_vocal_only").severity, "warn");

  /* abc_tools.py:107 — the chord vocabulary. MEASURED: `Dmaj9` kills one score. */
  const ch = AGREE.replace('"C"c2d2e2f2', '"Dmaj9"c2d2e2f2');
  const rc = invariants(readScoreText(ch));
  ok("an unsupported chord spelling is reported", id(rc, "chord_vocabulary").ok === false);
  ok("...naming it", /Dmaj9/.test(id(rc, "chord_vocabulary").what), id(rc, "chord_vocabulary").what);
  eq("...as a NOTE, because abcjs engraves it anyway", id(rc, "chord_vocabulary").severity, "note");

  /* abc_tools.py:214 — one bar grid across the voices. */
  const grid = AGREE.replace("V: Ins\nc8|d8|", "V: Ins\nc8|d8|c8|");
  const rg = invariants(readScoreText(grid));
  ok("voices with different bar counts are reported", id(rg, "voices_share_bar_grid").ok === false,
    JSON.stringify(id(rg, "voices_share_bar_grid")?.measured));

  /* Mixed content is legal notation and a majority is not a measurement. */
  const mixed = AGREE.replace('"C"c2d2e2f2|"G"g2f2e2d2|', '"C"c4d4e4f4|"G"g2f2e2d2|');
  const rm = invariants(readScoreText(mixed));
  ok("bars that disagree among themselves are reported", id(rm, "bar_content_uniform").ok === false,
    JSON.stringify(id(rm, "bar_content_uniform")?.measured.histogram));
  ok("...with the whole histogram, not just a count",
    Array.isArray(id(rm, "bar_content_uniform").measured.histogram)
      && id(rm, "bar_content_uniform").measured.histogram.length > 1);

  /* No % comments at all. */
  const nosec = AGREE.split("\n").filter((l) => !l.startsWith("% ")).join("\n");
  const rn = invariants(readScoreText(nosec));
  ok("a score with no section comments says so", id(rn, "sections_declared").ok === false);
  eq("...at severity", id(rn, "sections_declared").severity, "warn");

  /* 🔴 NO UNIT LENGTH, NO DURATION — and null, never 0. The zero version of
   * this makes the modal content 0 and the header/content ratio Infinity, which
   * is a confident wrong answer of exactly the kind invariant zero exists to
   * catch. abc_tools.py:81 refuses such a score outright. */
  for (const [label, text] of [["absent", AGREE.replace("L:1/16\n", "")],
                               ["unreadable", AGREE.replace("L:1/16", "L:3/7")]]) {
    const su = readScoreText(text);
    const ru = invariants(su, { audioSeconds: 100 });
    ok(`an ${label} L: field is reported`, id(ru, "unit_length_readable").ok === false);
    eq(`...at severity (${label})`, id(ru, "unit_length_readable").severity, "blocking");
    eq(`...and no bar has a duration (${label})`, su.contentQuartersPerBar, null);
    eq(`...so the nominal total is absent, not zero (${label})`, nominalSeconds(su), null);
    ok(`...and the header ratio is null rather than Infinity (${label})`,
      ru[0].measured.ratio === null, JSON.stringify(ru[0].measured.ratio));
    ok(`...and the bars are still counted (${label})`, su.barsPerVoice.Vocal === 6,
      JSON.stringify(su.barsPerVoice));
    ok(`...and the chords still read (${label})`,
      su.voices.find((v) => v.id === "Vocal").chords.length > 0);
    eq(`...and the map yields no cut points (${label})`,
      sectionMap(su, {}).cutPoints.length, 0);
  }
  eq("a readable L: field is reported as such",
    id(invariants(readScoreText(AGREE)), "unit_length_readable").ok, true);

  /* A hand-written score without the native header still reads. */
  const hand = AGREE.replace("X:1", "X:2");
  const rh = invariants(readScoreText(hand));
  ok("a non-native header is reported and not fatal", id(rh, "native_header_shape").ok === false);
  eq("...at severity", id(rh, "native_header_shape").severity, "note");
  eq("...and the bars still count", readScoreText(hand).barsPerVoice.Vocal, 6);
}

/* ════════════════════════════════════════════════════════════════════════
 * 3 · THE AUDIO CHECKS. Absent when nothing was measured; never assumed.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n3 · score time is not audio time\n");
{
  const s = readScoreText(REAL);
  const without = invariants(s);
  ok("with no measured audio duration there is NO drift figure",
    !without.some((r) => r.id === "nominal_vs_audio"),
    without.map((r) => r.id).join(", "));
  ok("...and no trailing-silence claim either",
    !without.some((r) => r.id === "trailing_silence_unaccounted"));

  const withAudio = invariants(s, { audioSeconds: REAL_AUDIO });
  const drift = withAudio.find((r) => r.id === "nominal_vs_audio");
  ok("with one, the drift is reported", !!drift);
  near("...as a scale (MEASURED 1.02688)", drift.measured.scale, 1.02688, 1e-4);
  ok("...and passes, because 2.69% is inside the ±8% a tempo offset explains", drift.ok === true);
  eq("...the band being", drift.measured.tolerance, 0.08);

  /* The header-derived figure WOULD be caught by this check, which is the
   * belt-and-braces half of invariant zero. */
  const fake = readScoreText(REAL);
  fake.contentQuartersPerBar = fake.headers.headerQuartersPerBar;   // pretend the header won
  const caught = invariants(fake, { audioSeconds: REAL_AUDIO }).find((r) => r.id === "nominal_vs_audio");
  ok("a score built on the HEADER is caught by the drift check too", caught.ok === false,
    JSON.stringify(caught.measured));
  eq("...at severity", caught.severity, "blocking");
  near("...at a scale of (MEASURED 0.5135 = 1/1.9476)", caught.measured.scale, 0.51354, 1e-4);

  /* The standing caveat. */
  const standing = withAudio.find((r) => r.id === "trailing_silence_unaccounted");
  ok("the trailing-silence caveat is attached to the numbers", !!standing);
  ok("...is marked STANDING, because it is never fixable", standing.standing === true);
  ok("...and therefore does not colour the badge",
    worstSeverity([standing]) === null, String(worstSeverity([standing])));
  ok("...and carries the measured range rather than a word",
    standing.measured.measuredRangeSeconds[0] === 0.84 && standing.measured.measuredRangeSeconds[1] === 1.82);
}

/* ════════════════════════════════════════════════════════════════════════
 * 4 · THE SECTION MAP, and the key that must not collide.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n4 · the section map\n");
{
  const s = readScoreText(REAL);
  const map = sectionMap(s, { slug: "rain", versionId: "v1", audioSeconds: REAL_AUDIO });

  eq("sections found (MEASURED 8)", map.sections.length, 8);
  eq("total bars (MEASURED 122)", map.totalBars, 122);
  eq("no bars fall outside a section", map.orphanBars, 0);
  eq("the granularity is declared", map.granularity, "section");
  ok("...and the caveat travels with the numbers",
    /section granularity/i.test(map.caveat) && /4\.122/.test(map.caveat) && /trailing silence/i.test(map.caveat),
    map.caveat);
  ok("bar-level sync is never promised", !/bar[- ]level/i.test(map.caveat.replace(/Do not build a bar-level playhead on this\./, "")));

  /* MEASURED, and these are the cut points a film would be built on. */
  const cuts = map.cutPoints.map((v) => Number(v.toFixed(2)));
  ok("the measured cut points are reproduced exactly",
    JSON.stringify(cuts) === JSON.stringify([0, 21.91, 54.77, 65.72, 87.63, 109.53, 120.49, 153.35]),
    JSON.stringify(cuts));
  near("the last section ends at the audio duration",
    map.sections.at(-1).startSeconds + map.sections.at(-1).lengthSeconds, REAL_AUDIO, 0.01);

  /* 🔴 A NAME IS NOT A KEY. */
  const names = map.sections.map((x) => x.name);
  const labels = map.sections.map((x) => x.label);
  ok("three section NAMES repeat on this score",
    new Set(names).size === 5 && names.length === 8, JSON.stringify(names));
  ok("...so the labels disambiguate them", new Set(labels).size === 8, JSON.stringify(labels));
  ok("...and the keys are unique", new Set(map.sections.map((x) => x.key)).size === 8);
  ok("the ordinal is in the key",
    map.sections.filter((x) => x.name === "chorus").map((x) => x.key).join(" ")
      === "rain/v1/chorus#1 rain/v1/chorus#2",
    map.sections.filter((x) => x.name === "chorus").map((x) => x.key).join(" "));

  /* THE MEASURED DISASTER, in miniature: the same section of two different
   * songs must not share a key. */
  const other = sectionMap(s, { slug: "storeys", versionId: "v1", audioSeconds: REAL_AUDIO });
  ok("the same section of a DIFFERENT song has a different key",
    map.sections[3].key !== other.sections[3].key,
    `${map.sections[3].key} vs ${other.sections[3].key}`);
  const otherVersion = sectionMap(s, { slug: "rain", versionId: "v2", audioSeconds: REAL_AUDIO });
  ok("...and so does the same section of a different VERSION of the same song",
    map.sections[3].key !== otherVersion.sections[3].key,
    `${map.sections[3].key} vs ${otherVersion.sections[3].key}`);
  eq("sectionKey() is the one builder of that key",
    sectionKey("rain", "v1", "chorus", 2), "rain/v1/chorus#2");
  eq("...and it lower-cases and hyphenates the name so a key is a key",
    sectionKey("rain", "v1", "Pre Chorus", 1), "rain/v1/pre-chorus#1");

  /* NO AUDIO DURATION: nominal, and it says so. */
  const nominalOnly = sectionMap(s, { slug: "rain", versionId: "v1" });
  eq("without a measured duration the scale is ABSENT, not 1", nominalOnly.scale, null);
  eq("...and the audio duration is absent too", nominalOnly.audioSeconds, null);
  ok("...so the boundaries are notation time and equal to the nominal ones",
    nominalOnly.sections.every((x) => x.startSeconds === x.nominalStartSeconds));
  ok("...while the scaled map's boundaries are NOT equal to them",
    map.sections.slice(1).every((x) => x.startSeconds !== x.nominalStartSeconds));

  /* Bars before the first % comment are named rather than dropped — dropping
   * them would make every later boundary early by their length. */
  const orphan = AGREE.replace("% intro\n", "");
  const om = sectionMap(readScoreText(orphan), { slug: "x", versionId: "v" });
  eq("bars outside any section are counted and named", om.orphanBars, 2);
}

/* ════════════════════════════════════════════════════════════════════════
 * 5 · THE DURATION ARITHMETIC, against abc_tools.py's own rules.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n5 · duration arithmetic\n");
{
  /* abc_tools.py:99 — by value, not by numerator. 6/8 is three quarters. */
  eq("4/4 is quarter notes", headerQuartersPerBar("4/4").quarters, 4);
  eq("2/4 is quarter notes", headerQuartersPerBar("2/4").quarters, 2);
  eq("6/8 is quarter notes, not 6 and not 2", headerQuartersPerBar("6/8").quarters, 3);
  eq("12/8 is quarter notes", headerQuartersPerBar("12/8").quarters, 6);
  eq("a non-power-of-two denominator is flagged, not refused",
    headerQuartersPerBar("4/6").powerOfTwo, false);
  eq("an unparseable meter is null", headerQuartersPerBar("C|"), null);

  /* L: changes what a digit means; the content answer must move with it. Same
   * bars as AGREE with every digit halved and L:1/8 instead of L:1/16, so the
   * quarter-note answer must come out identical. */
  const l8 = AGREE.replace("L:1/16", "L:1/8")
    .replace(/z8/g, "z4").replace(/c8\|d8/g, "c4|d4")
    .replace(/([a-gA-G])2/g, "$1");
  const s8 = readScoreText(l8);
  eq("with L:1/8 a bare letter is twice the duration", s8.headers.unitQuarters, 0.5);
  eq("...so the halved digits give the same quarters per bar", s8.contentQuartersPerBar, 2);
  near("...and the same seconds per bar", secondsPerBar(s8), secondsPerBar(readScoreText(AGREE)), 1e-9);

  /* A tie carries a note across a barline; each bar still sums on its own. */
  const tie = AGREE.replace('"C"z8|"C"z8|', '"C"c8-|"C"c8|');
  eq("a tied note is not double-counted into the bar total",
    readScoreText(tie).contentQuartersPerBar, 2);

  /* Z and Zn stand for whole bars. */
  const z = readScoreText(AGREE);
  eq("Z2 expands to two bars", z.barsPerVoice.Ins, 6);
  ok("...and a full-measure rest has no content of its own to skew the modal value",
    z.voices.find((v) => v.id === "Ins").bars.filter((b) => b.quarters === null).length === 4);

  /* secondsPerBar needs both halves and says so when one is missing. */
  const noTempo = AGREE.replace("Q:1/4=120", "Q:1/4=x");
  eq("a score with no readable tempo yields no seconds per bar",
    secondsPerBar(readScoreText(noTempo)), null);
  eq("...and no nominal duration", nominalSeconds(readScoreText(noTempo)), null);
  near("a readable one does (2 quarters at 120 BPM = 1.0 s)",
    secondsPerBar(readScoreText(AGREE)), 1, 1e-9);
}

/* ════════════════════════════════════════════════════════════════════════
 * 6 · readScore() — the one door both the route and the sheet go through.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n6 · one door, so the sheet and the map cannot disagree\n");
{
  const r = readScore(REAL, { slug: "rain", versionId: "v1", audioSeconds: REAL_AUDIO });
  eq("it carries the content basis", r.contentQuartersPerBar, 2);
  eq("...the invariants", r.invariants[0].id, "meter_header_vs_content");
  eq("...the worst word", r.worst, "blocking");
  eq("...and the map", r.map.sections.length, 8);
  ok("the map's seconds-per-bar is the same number the headers imply",
    r.map.secondsPerBar === Number((r.contentQuartersPerBar * (60 / r.headers.bpm)).toFixed(6)),
    `${r.map.secondsPerBar} vs ${r.contentQuartersPerBar * (60 / r.headers.bpm)}`);
  /* MEASURED: 121 chord symbols, one per explicit bar, and the 122nd bar is the
   * closing full-measure rest which carries none. */
  eq("voices are reported with their chord counts", r.voices.find((v) => v.id === "Vocal").chords, 121);
  eq("...and the instrumental carries none", r.voices.find((v) => v.id === "Ins").chords, 0);

  /* The reader never throws on real input. The 4 unparseable rows in
   * the 14-row comparison are real renders with real audio. */
  for (const [name, text] of [["empty", ""], ["one line", "X:1"], ["garbage", " nonsense|||"],
                              ["header only", REAL.split("\n").slice(0, 8).join("\n")]]) {
    let threw = null;
    try { readScore(text); } catch (e) { threw = e.message; }
    ok(`readScore() does not throw on ${name}`, threw === null, String(threw));
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
