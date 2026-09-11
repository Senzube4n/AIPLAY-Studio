/**
 * THE SCORE, READ — the two-voice ABC dialect YuE2 writes, measured rather than
 * believed. Pure: no fs, no clock, no network, no GPU.
 *
 * ┌─ WHY THIS FILE EXISTS AT ALL, GIVEN THE VENDOR SHIPS A PARSER ──────────┐
 * │ The vendor's own Apache-2.0 reader is                                    │
 * │   skills/yue2-music/scripts/abc_tools.py                                 │
 * │ and it is the AUTHORITY on this dialect. Its grammar is ported here      │
 * │ token for token (abc_tools.py:37-41) and its duration vocabulary         │
 * │ verbatim (abc_tools.py:30). What is NOT ported is its pitch and          │
 * │ accidental resolution (abc_tools.py:96-152) — a sheet and a section map  │
 * │ need bar durations, not MIDI numbers, and a half-ported pitch resolver   │
 * │ would be a third parser pretending to be authoritative.                  │
 * │                                                                          │
 * │ It is not CALLED for two reasons, and the second one is the whole point  │
 * │ of this file:                                                            │
 * │  1. it is Python and this path is Node — a subprocess per sheet, on a    │
 * │     file that is not in this repo and cannot be vendored from here.      │
 * │  2. IT FAILS CLOSED ON THE EXACT DEFECT WE HAVE TO REPORT.               │
 * │     abc_tools.py:154 raises `duration N != meter duration M` and stops.  │
 * │     MEASURED on a real render's score: header                            │
 * │     M:4/4 over bar content of 2 quarters — the vendor parser cannot      │
 * │     open the file, so it cannot tell you WHICH of the two is wrong. A    │
 * │     reader whose only answer is an exception is a reader that turns a    │
 * │     diagnosable disagreement into a dead end.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 🔴 THE DEFECT THIS FILE IS SHAPED AROUND. The first section-map prototype (the
 * prototype) took beats-per-bar from the M: HEADER. A score's header had been
 * hand-edited from M:2/4 to M:4/4 without re-barring the note content, and the
 * nominal duration came out almost exactly 2x wrong. MEASURED, on
 * run_fixed/score.abc, 122 bars per voice at Q:1/4=90:
 *      header-derived   325.333 s     (the prototype's barline-count heuristic
 *                                      said 123 bars / 328.0 s)
 *      content-derived  162.667 s
 *      real audio       167.039 s     (result.json audio_seconds)
 * So the header was wrong by a factor of 1.9476 against the audio and the
 * content was wrong by 2.69%. The header is therefore NEVER the basis. It is
 * an assertion to be checked against the notes, and the disagreement is the
 * FIRST invariant — see invariants(), id "meter_header_vs_content".
 *
 * ⚠ SCORE TIME IS NOT AUDIO TIME, and no amount of parsing fixes that.
 * MEASURED across the YuE2 corpus (a 14-row notated-against-rendered comparison,
 * 10 parseable): nominal/actual ratios 0.963 to 1.046, absolute drift reaching
 * +4.122 s over 221.8 s, and the rendered audio carries 0.84-1.82 s of trailing
 * silence the notation does not contain. sectionMap() therefore scales to the
 * real audio duration and declares `granularity: "section"`. Bar-level playhead
 * sync is not available from this data and is not offered.
 */

/* ── the vendor's grammar, ported ─────────────────────────────────────────── */

/**
 * abc_tools.py:37-41, transliterated. Sticky so the cursor walk below is the
 * same walk parse_bar() does — a global-flag scan would silently skip over a
 * token it could not match, which is how an unsupported duration becomes a
 * short bar instead of a reported defect.
 */
const TOKEN = /"(?<chord>[^"\n]*)"|\[K:(?<key>[^\]\n]+)\]|(?<acc>\^\^|__|\^|_|=)?(?<note>[A-Ga-gz])(?<oct>[,']*)(?<duration>[0-9]*)(?<tie>-?)/guy;

/** abc_tools.py:30 verbatim. Anything else is "split it into tied lengths". */
export const UNIT_DURATIONS = new Set([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]);

/** abc_tools.py:24 — the two voices this dialect has, in the order it writes them. */
export const VOICES = ["Vocal", "Ins"];

/** abc_tools.py:26-29 — the chord vocabulary. Used to REPORT, never to refuse. */
const QUALITIES = ["", "m", "dim", "aug", "7", "maj7", "m7", "dim7", "m7b5",
                   "sus4", "sus2", "6", "m6", "7sus4", "m(maj7)"];
const PITCH_NAME = "[A-G](?:bb|##|b|#)?";
const CHORD_RE = new RegExp(
  `^${PITCH_NAME}(?:${QUALITIES.map((q) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:/${PITCH_NAME})?$`,
);

/* ── header reading ───────────────────────────────────────────────────────── */

/** A field's value by letter, from the header block only. Never from the body. */
const headerField = (lines, letter) => {
  const hit = lines.slice(0, 8).find((l) => l.startsWith(`${letter}:`));
  return hit === undefined ? null : hit.slice(2).trim();
};

/**
 * Quarter notes per bar as the METER FIELD CLAIMS. 6/8 is two dotted-quarter
 * beats but three quarters' worth of time, and Q: is quarter-note tempo, so the
 * conversion is by value and not by numerator. Same arithmetic as
 * abc_tools.py:99 (`length = Fraction(4 * n, d)`).
 */
export function headerQuartersPerBar(meter) {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(meter ?? "").trim());
  if (!m) return null;
  const [n, d] = [Number(m[1]), Number(m[2])];
  // abc_tools.py:87 refuses a non-power-of-two denominator; we report instead.
  return { quarters: (n * 4) / d, num: n, den: d, powerOfTwo: (d & (d - 1)) === 0 };
}

/** L:1/32 -> 0.125 quarters per unit. abc_tools.py:110 (`units * unit * 4`). */
function unitQuarters(unit) {
  const m = /^1\/([1-9][0-9]*)$/.exec(String(unit ?? "").trim());
  if (!m) return null;
  return 4 / Number(m[1]);
}

/* ── the body walk ────────────────────────────────────────────────────────── */

/**
 * Sum one bar's sounding duration in quarter notes.
 *
 * Returns `{ quarters, tokens, unsupported[], chords[] }`. It does NOT throw on
 * an unknown token: MEASURED on the 14-row corpus in
 * that 14-row comparison, 4 of 14 scores are unopenable by the vendor
 * parser — two on `unsupported duration 14`, one on the chord `Dmaj9`, one on a
 * bar-length mismatch. Those four are real scores with real audio beside them,
 * and a reader that refuses them leaves a human with no sheet and no
 * explanation. So: parse what parses, name what did not, and let invariants()
 * say how much of the score the answer rests on.
 */
function readBar(body, { unitQ }) {
  const out = { quarters: 0, tokens: 0, unsupported: [], chords: [], keyChanges: [] };
  if (body === "Z") return { ...out, fullMeasureRest: true };
  TOKEN.lastIndex = 0;
  let cursor = 0;
  while (cursor < body.length) {
    if (/\s/.test(body[cursor])) { cursor += 1; continue; }
    TOKEN.lastIndex = cursor;
    const m = TOKEN.exec(body);
    if (!m) {
      // abc_tools.py:106 fails here. We record the 24 characters it would have
      // quoted and stop this bar — the rest of the bar is not trustworthy.
      out.unsupported.push({ kind: "token", at: cursor, text: body.slice(cursor, cursor + 24) });
      break;
    }
    cursor = TOKEN.lastIndex;
    const g = m.groups;
    if (g.chord !== undefined) {
      out.chords.push(g.chord);
      if (!CHORD_RE.test(g.chord)) out.unsupported.push({ kind: "chord", text: g.chord });
      continue;
    }
    if (g.key !== undefined) { out.keyChanges.push(g.key); continue; }
    const units = Number(g.duration || "1");
    if (!UNIT_DURATIONS.has(units)) out.unsupported.push({ kind: "duration", text: String(units) });
    out.quarters += units * unitQ;
    out.tokens += 1;
  }
  /* ⚠ NO UNIT LENGTH, NO DURATION — and `null`, never 0. abc_tools.py:81
   * refuses a score whose L: field is missing or not a power of two. Here the
   * bar is still read for its chords, its key changes and its token count, but
   * its duration is reported as UNKNOWN. Zero would make the modal content 0,
   * the header/content ratio Infinity and every seconds figure downstream a
   * confident wrong answer rather than an absent one — which is the same class
   * of failure as taking the meter from the header. */
  if (!unitQ) return { ...out, quarters: null, unitUnknown: true };
  return out;
}

/**
 * The whole score, structurally.
 *
 * Tolerant where abc_tools.py:158-213 is strict, and the tolerance is the
 * product: every structural assertion it makes by raising, this makes by
 * recording. Nothing here decides whether the score is GOOD — invariants() does
 * that, out loud, with numbers.
 */
export function readScoreText(text) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  const meter = headerField(lines, "M");
  const unit = headerField(lines, "L");
  const tempoRaw = headerField(lines, "Q");
  const key = headerField(lines, "K");
  const bpm = Number((/^1\/4=([1-9][0-9]*)$/.exec(String(tempoRaw ?? "").trim()) || [, NaN])[1]);
  const unitQ = unitQuarters(unit);
  const header = headerQuartersPerBar(meter);

  /* The V: declarations, from the header block. The prototype counted
   * `^V:\s*\S+\s+clef` which is also how many voices the BODY repeats per
   * group, so a two-voice score read as "two voices" by luck. Read the
   * declarations (abc_tools.py:120-122) and the body separately, then compare. */
  const declared = lines.slice(0, 8)
    .filter((l) => /^V:\s*\S+/.test(l) && /clef=/.test(l))
    .map((l) => ({
      id: (/^V:\s*(\S+)/.exec(l) || [, null])[1],
      name: (/name="([^"]*)"/.exec(l) || [, null])[1],
    }));

  const shape = {
    xHeader: lines[0] === "X:1",
    blankTitle: lines[1] === "T:",
    bodyStartsAt: 8,
  };

  const voices = new Map();
  const sections = [];
  const groups = [];
  const bodyProblems = [];
  const seenName = new Map();

  let current = null;        // the section being filled
  let voiceId = null;        // the V: we are inside
  let group = null;          // one Vocal+Ins pair
  let firstVoiceOfSection = null;

  const voiceOf = (id) => {
    if (!voices.has(id)) {
      voices.set(id, { id, bars: [], quarters: 0, chords: [], keyChanges: [], meterOverrides: [] });
    }
    return voices.get(id);
  };

  for (let i = shape.bodyStartsAt; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    /* A SECTION COMMENT. abc_tools.py:172 skips these; they are the only
     * structural labels the dialect has, and they are what a film is cut to. */
    const sec = /^%\s*(.+?)\s*$/.exec(line);
    if (sec) {
      const name = sec[1];
      const ordinal = (seenName.get(name) || 0) + 1;
      seenName.set(name, ordinal);
      /* ⚠ `verse` IS NOT A KEY. MEASURED on run_fixed/score.abc: 8 sections,
       * of which `verse`, `pre-chorus` and `chorus` each appear TWICE. A map
       * keyed by name alone silently folds the second chorus onto the first —
       * "unique within one film and identical across two" exactly
       * (DIRECTING.md:1231-1238), and its failure mode is a confident wrong
       * cut point rather than an error. The ordinal rides along from here and
       * sectionKey() folds the song's own identity in on top. */
      current = { name, ordinal, bars: 0, fullMeasureRests: 0, line: i + 1 };
      sections.push(current);
      firstVoiceOfSection = null;
      continue;
    }

    const v = /^V:\s*(\S+)\s*$/.exec(line);
    if (v) {
      voiceId = v[1];
      voiceOf(voiceId);
      if (voiceId === VOICES[0]) group = { at: i + 1, counts: new Map() };
      if (current && firstVoiceOfSection === null) firstVoiceOfSection = voiceId;
      continue;
    }

    /* A per-group M:/K: override (abc_tools.py:126-136). Recorded against the
     * voice so a genuinely mixed-meter score is not flattened onto one number
     * by invariants() below. */
    const field = /^([A-Za-z]):(.*)$/.exec(line);
    if (field && field[1] !== "V") {
      if (voiceId && field[1] === "M") voiceOf(voiceId).meterOverrides.push({ at: i + 1, meter: field[2].trim() });
      if (voiceId && field[1] === "K") voiceOf(voiceId).keyChanges.push(field[2].trim());
      continue;
    }

    if (!voiceId) { bodyProblems.push({ at: i + 1, what: "music line before any V:" }); continue; }

    /* A MUSIC LINE. abc_tools.py:138 requires a trailing plain barline; a line
     * without one is read anyway and the omission reported, because the
     * trailing "|" is a punctuation rule and losing the bars behind it is not
     * a proportionate answer to breaking one. */
    if (!line.endsWith("|")) bodyProblems.push({ at: i + 1, what: "music line does not end with a barline" });
    const voice = voiceOf(voiceId);
    const body = line.replace(/\|+$/, "");
    for (const chunk of body.split("|")) {
      const bar = chunk.trim();
      if (!bar) { bodyProblems.push({ at: i + 1, what: "empty measure, or a double/repeat barline this dialect has no rule for" }); continue; }
      const multi = /^Z([2-9][0-9]*)?$/.exec(bar);
      const repeat = multi ? Number(multi[1] || 1) : 1;
      for (let r = 0; r < repeat; r += 1) {
        const read = readBar(multi ? "Z" : bar, { unitQ: unitQ ?? 0 });
        voice.bars.push({
          at: i + 1, section: current ? sections.indexOf(current) : null,
          quarters: read.fullMeasureRest ? null : read.quarters,
          fullMeasureRest: !!read.fullMeasureRest,
          unitUnknown: !!read.unitUnknown,
          unsupported: read.unsupported,
        });
        if (read.chords.length) voice.chords.push(...read.chords);
        if (read.keyChanges.length) voice.keyChanges.push(...read.keyChanges);
        if (current && voiceId === firstVoiceOfSection) {
          current.bars += 1;
          if (read.fullMeasureRest) current.fullMeasureRests += 1;
        }
      }
    }
    if (group) group.counts.set(voiceId, voice.bars.length);
    if (voiceId === VOICES[1] && group) { groups.push(group); group = null; }
  }

  /* ── beats per bar AS THE NOTES ACTUALLY SPELL IT ──────────────────────────
   * The modal explicit-bar total, per voice and overall. Explicit only: a
   * full-measure Z has no content of its own and takes whatever the meter
   * says, so counting it would make the answer circular. */
  const explicit = [...voices.values()].flatMap((vo) => vo.bars.filter((b) => b.quarters !== null).map((b) => b.quarters));
  const histogram = new Map();
  for (const q of explicit) histogram.set(q, (histogram.get(q) || 0) + 1);
  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const contentQuartersPerBar = ranked.length ? ranked[0][0] : null;
  const conforming = contentQuartersPerBar === null ? 0 : (histogram.get(contentQuartersPerBar) || 0);

  const barsPerVoice = new Map([...voices.values()].map((vo) => [vo.id, vo.bars.length]));
  const bars = barsPerVoice.size ? Math.max(...barsPerVoice.values()) : 0;

  return {
    text: raw,
    headers: {
      meter, unit, key, bpm: Number.isFinite(bpm) ? bpm : null,
      tempoRaw, unitQuarters: unitQ,
      headerQuartersPerBar: header ? header.quarters : null,
      meterParsed: header,
      declaredVoices: declared,
      shape,
    },
    /* THE BASIS. Everything that turns bars into seconds uses this and not the
     * header, for the 1.9476x reason in this file's banner. */
    contentQuartersPerBar,
    barContent: { histogram: ranked.map(([quarters, count]) => ({ quarters, count })), conforming, explicit: explicit.length },
    voices: [...voices.values()],
    barsPerVoice: Object.fromEntries(barsPerVoice),
    bars,
    sections,
    groups: groups.length,
    bodyProblems,
    unsupported: [...voices.values()].flatMap((vo) => vo.bars.flatMap((b) => b.unsupported.map((u) => ({ ...u, at: b.at })))),
  };
}

/* ── the invariants ───────────────────────────────────────────────────────── */

/**
 * SEVERITY, and why there are only three words.
 *   blocking  the answer below it is arithmetically wrong, not merely rough.
 *   warn      the answer stands but rests on less than the whole score.
 *   note      true, worth knowing, nothing to fix.
 * No fourth word, because a vocabulary that grows acquires a tier nobody can
 * define and everything lands in it.
 */
export const SEVERITIES = ["blocking", "warn", "note"];

/**
 * What is true about this score, each with the number that makes it true.
 *
 * ORDER IS PART OF THE CONTRACT: index 0 is the header-vs-content meter check,
 * because that is the one that was wrong for a night and every duration on
 * every screen downstream of it inherits the error. A caller that shows one
 * invariant shows that one.
 *
 * `audioSeconds` is optional. Without it the audio checks are absent rather
 * than assumed — the one thing that must never happen here is a drift figure
 * computed against a duration nobody measured.
 */
export function invariants(score, { audioSeconds = null } = {}) {
  const out = [];
  const add = (id, ok, severity, what, measured, why) => out.push({ id, ok, severity, what, measured, why });

  const hdr = score.headers.headerQuartersPerBar;
  const content = score.contentQuartersPerBar;

  /* 1. THE ONE THAT WAS WRONG. A header may be edited in a text editor in one
   * keystroke; re-barring 122 bars cannot be. So when they disagree the header
   * is the suspect, and the ratio is reported so a reader sees the factor
   * rather than a boolean. MEASURED: run_fixed/score.abc reads 4 / 2 = 2.0,
   * and the header-derived total was 325.333 s against 167.039 s of audio. */
  const ratio = hdr && content ? hdr / content : null;
  add("meter_header_vs_content",
    hdr !== null && content !== null && hdr === content,
    ratio && Math.abs(ratio - 1) > 1e-9 ? "blocking" : "note",
    hdr === null ? "the M: field is missing or unparseable, so there is nothing to check the notes against"
      : content === null ? "no bar has explicit content, so the header cannot be checked"
      : hdr === content ? `header M:${score.headers.meter} and the bar content agree at ${content} quarter notes per bar`
      : `header M:${score.headers.meter} claims ${hdr} quarter notes per bar; the notes spell ${content}`,
    { header: hdr, content, ratio: ratio === null ? null : Number(ratio.toFixed(6)),
      conformingBars: score.barContent.conforming, explicitBars: score.barContent.explicit },
    "A header hand-edited from M:2/4 to M:4/4 without re-barring made the nominal duration "
    + "325.333 s against 167.039 s of real audio (MEASURED, run_fixed). Every seconds figure "
    + "downstream takes its beats-per-bar from the CONTENT for this reason.");

  /* 2. Mixed content. A real 6/8-then-4/4 score is legal notation; the modal
   * value is then a majority and not a fact, and a section map built on it is
   * wrong exactly where the meter changes. */
  const off = score.barContent.explicit - score.barContent.conforming;
  add("bar_content_uniform", off === 0, off === 0 ? "note" : "warn",
    off === 0 ? `all ${score.barContent.explicit} explicit bars carry the same duration`
      : `${off} of ${score.barContent.explicit} explicit bars do not carry the modal duration`,
    { histogram: score.barContent.histogram, meterOverrides: score.voices.flatMap((v) => v.meterOverrides) },
    "The basis for seconds-per-bar is one number. When the bars disagree among themselves it is "
    + "a majority, not a measurement, and boundaries after the change are wrong by the difference.");

  /* 3. abc_tools.py:214 asserts the two voices share a bar grid by RAISING.
   * Reported here, because a one-bar difference is a notation slip with a
   * readable sheet behind it and refusing the sheet helps nobody. */
  const counts = Object.values(score.barsPerVoice);
  const agree = counts.length > 1 ? counts.every((c) => c === counts[0]) : true;
  add("voices_share_bar_grid", agree, agree ? "note" : "warn",
    agree ? `${counts.length} voice(s), ${counts[0] ?? 0} bars each`
      : `voices disagree on bar count: ${JSON.stringify(score.barsPerVoice)}`,
    { barsPerVoice: score.barsPerVoice, groups: score.groups },
    "abc_tools.py:214 raises \"Voice meter/time grids differ\" on this. The section map counts the "
    + "FIRST voice of each section, so a disagreement means the map is one voice's opinion.");

  /* 4. The duration vocabulary. MEASURED: 2 of the 14 corpus rows in
   * that comparison die on `unsupported duration 14` alone. */
  const badDur = score.unsupported.filter((u) => u.kind === "duration");
  add("duration_vocabulary", badDur.length === 0, badDur.length ? "warn" : "note",
    badDur.length === 0 ? "every note length is in the dialect's supported set"
      : `${badDur.length} note length(s) outside the supported set: ${[...new Set(badDur.map((u) => u.text))].join(", ")}`,
    { supported: [...UNIT_DURATIONS], offending: badDur.slice(0, 12) },
    "abc_tools.py:112 refuses these outright, which is why 2 of 14 measured scores have no vendor "
    + "report at all. They are counted here and the bar's total still sums, so the map survives; "
    + "the engraver may space that bar oddly.");

  /* 5. Chord placement. abc_tools.py:216 — chords belong to Vocal. */
  const insChords = (score.voices.find((v) => v.id === VOICES[1])?.chords || []).length;
  add("chords_in_vocal_only", insChords === 0, insChords ? "warn" : "note",
    insChords === 0 ? "chord symbols are on the vocal line only"
      : `${insChords} chord symbol(s) on the ${VOICES[1]} voice`,
    { vocal: (score.voices.find((v) => v.id === VOICES[0])?.chords || []).length, ins: insChords },
    "abc_tools.py:216 raises \"Native chord symbols belong in Vocal, not Ins\". abcjs will engrave "
    + "them twice, once over each staff, which reads as a doubled harmony that is not there.");

  /* 6. Unsupported chord spellings. MEASURED: `Dmaj9` alone made one of the 14
   * corpus scores unreadable to the vendor parser. */
  const badChord = score.unsupported.filter((u) => u.kind === "chord");
  add("chord_vocabulary", badChord.length === 0, badChord.length ? "note" : "note",
    badChord.length === 0 ? "every chord symbol is in the dialect's vocabulary"
      : `${badChord.length} chord symbol(s) outside it: ${[...new Set(badChord.map((u) => u.text))].join(", ")}`,
    { offending: [...new Set(badChord.map((u) => u.text))].slice(0, 12) },
    "abc_tools.py:107 refuses these; `Dmaj9` accounts for one unparseable score in the measured "
    + "corpus of 14. abcjs engraves them as written, so this is a note and not a warning.");

  /* 7. Sections. No `%` comments is a legal score and an unusable map. */
  add("sections_declared", score.sections.length > 0, score.sections.length ? "note" : "warn",
    score.sections.length
      ? `${score.sections.length} section comment(s): ${score.sections.map((s) => (s.ordinal > 1 ? `${s.name} ${s.ordinal}` : s.name)).join(", ")}`
      : "no % section comments, so the whole score is one span",
    { sections: score.sections.length,
      repeated: [...new Set(score.sections.filter((s) => s.ordinal > 1).map((s) => s.name))] },
    "Section comments are the only structural labels this dialect has and they are what a film is "
    + "cut to. MEASURED on run_fixed: 8 sections of which 3 names repeat, so a map keyed by name "
    + "alone folds the second chorus onto the first (DIRECTING.md:1231-1238).");

  /* 7b. THE UNIT LENGTH. Without a readable L: field a digit has no value, so
   * no bar has a duration and everything above that divides bars into seconds
   * is absent rather than wrong. Reported loudly, because the absence is total
   * and it is the one input with no sensible default: guessing L:1/8 would make
   * every duration on the sheet a guess wearing a number. */
  const unitOk = score.headers.unitQuarters !== null;
  add("unit_length_readable", unitOk, unitOk ? "note" : "blocking",
    unitOk ? `L:${score.headers.unit} — a digit is ${score.headers.unitQuarters} quarter notes`
      : `L:${score.headers.unit ?? "(absent)"} is not a readable unit length, so no bar has a duration`,
    { unit: score.headers.unit, unitQuarters: score.headers.unitQuarters,
      barsWithUnknownDuration: score.voices.reduce((n, v) => n + v.bars.filter((b) => b.unitUnknown).length, 0) },
    "abc_tools.py:81 refuses a score whose L: is missing or not 1/<power of two>. Here the bars are "
    + "still counted and the chords still read, but every duration is null rather than 0 — a zero "
    + "would make the modal content 0 and the header ratio Infinity, which is a confident wrong "
    + "answer of exactly the kind invariant zero exists to catch.");

  /* 8. Structural shape, as a single line. Not blocking: these are the two
   * fields abc_tools.py:160 checks before anything musical, and a score that
   * fails them still engraves. */
  add("native_header_shape", score.headers.shape.xHeader && score.headers.shape.blankTitle,
    score.headers.shape.xHeader && score.headers.shape.blankTitle ? "note" : "note",
    score.headers.shape.xHeader && score.headers.shape.blankTitle
      ? "native X:1 / blank T: header, as the vendor writes it"
      : "the first two lines are not the vendor's X:1 and blank T:",
    { xHeader: score.headers.shape.xHeader, blankTitle: score.headers.shape.blankTitle,
      declaredVoices: score.headers.declaredVoices.length },
    "abc_tools.py:161 refuses a score without them. Reported because a hand-edited or "
    + "hand-written score is a legitimate input here and the sheet does not care.");

  /* 9-10. THE AUDIO CHECKS, only when a real duration was measured. */
  if (Number.isFinite(audioSeconds) && audioSeconds > 0) {
    const nominal = nominalSeconds(score);
    const scale = nominal ? audioSeconds / nominal : null;
    add("nominal_vs_audio", scale !== null && Math.abs(scale - 1) <= 0.08,
      scale === null ? "warn" : Math.abs(scale - 1) > 0.08 ? "blocking" : "note",
      scale === null ? "the score yields no nominal duration, so it cannot be compared to the audio"
        : `nominal ${nominal.toFixed(3)} s against ${audioSeconds.toFixed(3)} s of audio — scale ${scale.toFixed(5)} (${((scale - 1) * 100).toFixed(2)}%)`,
      { nominalSeconds: nominal === null ? null : Number(nominal.toFixed(3)), audioSeconds,
        scale: scale === null ? null : Number(scale.toFixed(5)), tolerance: 0.08 },
      "MEASURED on the corpus: ratios span 0.963-1.046, so ±8% is the band a constant tempo offset "
      + "explains. Outside it the notation and the render are not the same performance — "
      + "run_fixed's own header-derived figure lands at 1.9476 and would be caught here.");

    /* A STANDING invariant: always false, never fixable, severity `note`.
     * It is here because the caveat has to be attached to the numbers rather
     * than living in a comment nobody downstream reads. A caller must therefore
     * key on SEVERITY and never on "every invariant ok" — that condition is
     * unreachable by construction, and a screen built on it would show a
     * permanent red badge for a fact of the renderer. */
    out.push({
      id: "trailing_silence_unaccounted", ok: false, standing: true, severity: "note",
      what: "the audio carries trailing silence the score does not contain",
      measured: { measuredRangeSeconds: [0.84, 1.82], appliesTo: "every YuE2 render measured" },
      why: "MEASURED 0.84-1.82 s of silence after the last note on the YuE2 renders examined. The "
        + "linear scale spreads it over the whole song, which pushes every boundary slightly late. "
        + "This is one of the two reasons the map is section-granular and never bar-granular.",
    });
  }

  return out;
}

/**
 * The worst word present, or null. What a badge shows.
 *
 * STANDING rows are excluded, and that exclusion is the whole reason this is a
 * function rather than an inline `.some()`: `trailing_silence_unaccounted` is
 * false on every score that will ever exist, so counting it would put a
 * permanent badge on a clean score and the badge would then mean nothing.
 */
export const worstSeverity = (rows) =>
  SEVERITIES.find((s) => rows.some((r) => !r.ok && !r.standing && r.severity === s)) ?? null;

/* ── seconds ──────────────────────────────────────────────────────────────── */

/** Seconds per bar, from the CONTENT and the tempo. Null when either is absent. */
export function secondsPerBar(score) {
  const q = score.contentQuartersPerBar;
  const bpm = score.headers.bpm;
  if (!q || !bpm) return null;
  return q * (60 / bpm);
}

/**
 * Total nominal seconds. Counted off the FIRST voice's bar list rather than the
 * sum of section bars, so a score whose first section comment arrives after
 * some music does not lose those bars.
 */
export function nominalSeconds(score) {
  const spb = secondsPerBar(score);
  if (spb === null) return null;
  const counts = Object.values(score.barsPerVoice);
  const bars = counts.length ? Math.max(...counts) : 0;
  return bars * spb;
}

/**
 * A SECTION'S KEY, with the song folded in.
 *
 * DIRECTING.md:1231-1238: a key that is unique within one film and identical
 * across two "is not an error, it is a confident wrong answer" — sixteen shots
 * completed in four seconds and a whole film stamped that had never been
 * rendered. `chorus` is that key exactly: MEASURED, run_fixed/score.abc names
 * `verse`, `pre-chorus` and `chorus` twice each, and every YuE2 song in the
 * library uses the same eight words. So the key carries the slug, the version
 * the score came from, the name AND the ordinal, and none of the four is
 * optional.
 */
export const sectionKey = (slug, versionId, name, ordinal) =>
  `${slug}/${versionId}/${String(name).trim().toLowerCase().replace(/\s+/g, "-")}#${ordinal}`;

/**
 * The section map, in seconds, scaled to the real audio.
 *
 * `basis` is always "content" and it is reported so no reader has to trust this
 * comment. `granularity` is always "section" and it is reported for the same
 * reason: the caveat has to travel with the numbers or it does not travel.
 *
 * Without `audioSeconds` the map is nominal and says so (`scale: null`) rather
 * than silently presenting notation time as audio time.
 */
export function sectionMap(score, { slug = "score", versionId = "v", audioSeconds = null } = {}) {
  const spb = secondsPerBar(score);
  const nominal = nominalSeconds(score);
  const usable = Number.isFinite(audioSeconds) && audioSeconds > 0 && nominal > 0;
  const scale = usable ? audioSeconds / nominal : null;
  const k = scale ?? 1;

  /* Bars that belong to no section — music before the first `%` comment. Named
   * rather than dropped: dropping them would make every later boundary early
   * by their length, which is the quietest possible version of this file's
   * original bug. */
  const sectioned = score.sections.reduce((n, s) => n + s.bars, 0);
  const counts = Object.values(score.barsPerVoice);
  const totalBars = counts.length ? Math.max(...counts) : 0;
  const orphanBars = Math.max(0, totalBars - sectioned);

  let t = 0;
  const sections = score.sections.map((s) => {
    const startNominal = t;
    const lenNominal = spb === null ? null : s.bars * spb;
    t += lenNominal ?? 0;
    return {
      key: sectionKey(slug, versionId, s.name, s.ordinal),
      name: s.name,
      ordinal: s.ordinal,
      label: s.ordinal > 1 ? `${s.name} ${s.ordinal}` : s.name,
      bars: s.bars,
      fullMeasureRests: s.fullMeasureRests,
      abcLine: s.line,
      nominalStartSeconds: lenNominal === null ? null : Number(startNominal.toFixed(3)),
      startSeconds: lenNominal === null ? null : Number((startNominal * k).toFixed(3)),
      lengthSeconds: lenNominal === null ? null : Number((lenNominal * k).toFixed(3)),
    };
  });

  return {
    basis: "content",
    granularity: "section",
    secondsPerBar: spb === null ? null : Number(spb.toFixed(6)),
    quartersPerBar: score.contentQuartersPerBar,
    headerQuartersPerBar: score.headers.headerQuartersPerBar,
    bpm: score.headers.bpm,
    totalBars,
    orphanBars,
    nominalSeconds: nominal === null ? null : Number(nominal.toFixed(3)),
    audioSeconds: usable ? audioSeconds : null,
    scale: scale === null ? null : Number(scale.toFixed(5)),
    sections,
    cutPoints: sections.map((s) => s.startSeconds).filter((v) => v !== null),
    caveat:
      "Section granularity only. Boundaries are scaled linearly to the measured audio duration, "
      + "which absorbs a constant tempo offset and not uneven drift: MEASURED YuE2 drift reaches "
      + "+4.122 s over 221.8 s, and the render carries 0.84-1.82 s of trailing silence the score "
      + "does not. Treat every boundary as ± one bar. Do not build a bar-level playhead on this.",
  };
}

/**
 * Everything a caller needs about one score, in one call. The route and the
 * sheet both go through here so neither can develop its own opinion about the
 * meter — the failure this whole module exists to prevent.
 */
export function readScore(text, { slug = "score", versionId = "v", audioSeconds = null } = {}) {
  const score = readScoreText(text);
  const rows = invariants(score, { audioSeconds });
  return {
    headers: score.headers,
    contentQuartersPerBar: score.contentQuartersPerBar,
    barContent: score.barContent,
    bars: score.bars,
    barsPerVoice: score.barsPerVoice,
    voices: score.voices.map((v) => ({
      id: v.id, bars: v.bars.length, chords: v.chords.length,
      keyChanges: [...new Set(v.keyChanges)],
    })),
    sections: score.sections.length,
    invariants: rows,
    worst: worstSeverity(rows),
    map: sectionMap(score, { slug, versionId, audioSeconds }),
  };
}
