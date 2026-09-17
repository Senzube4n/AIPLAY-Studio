/**
 * The SCORE surface — an agent steers a song by editing its notation.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Two lines in server/mcp.js:                                            │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { scoreTools } from "./mcp-music-score.js";                 │
 * │                                                                        │
 * │  2. inside the TOOLS array, alongside the existing entries:            │
 * │     ...scoreTools(api),                                                │
 * │                                                                        │
 * │ The route contract, the config keys and the local-tier tool list are   │
 * │ in the notes that follow. READ THEM BEFORE MERGING THIS:               │
 * │ server/score/ landed in parallel and the two must be reconciled.      │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ ── PARALLEL WORK, AND THE DUPLICATION IT LEFT ────────────────────────────
 *
 * server/score/{abc,store,routes,sheet}.js was written the same night as this
 * file, by another hand, and it is NOT dead work to route around:
 *
 *   server/score/abc.js    a reader of this same bounded dialect, with the
 *                          same header-vs-content finding and the same
 *                          MEASURED numbers (325.333 s nominal against
 *                          167.039 s of audio, run_fixed)
 *   server/score/store.js  a RENDER LEDGER: `adoptVersion` ingests a finished
 *                          vendor run folder and verifies every file against
 *                          result.json's own sha256 map
 *   server/score/routes.js /api/score — capability, list, create, read, adopt,
 *                          note, author, current, map, invariants, lineage,
 *                          sheet, delete
 *
 * SO THERE ARE TWO PARSERS OF ONE DIALECT IN THIS TREE, WHICH IS ONE TOO MANY.
 * `server/score/abc.js` is the one to keep: it is already the engraver's and
 * the section map's reader, and this file's ~400-line parser should collapse
 * onto `readScoreText` + `invariants` at reconciliation. The HANDOFF lists
 * exactly what to delete here, what to port there, and the one thing that
 * genuinely cannot merge:
 *
 *   THE TWO READERS HAVE OPPOSITE DUTIES, and that is not a disagreement.
 *   score/abc.js must NEVER refuse — its consumers are an engraver and a
 *   section map, and a slightly wrong score should still produce a sheet, so
 *   it grades blocking/warn/note and hands back a report. This one must refuse,
 *   because its consumer is 399.6 s of GPU (MEASURED) and a generator that is
 *   not an engraver: the vendor's own tokenizer rejects outright several things
 *   score/abc.js deliberately waves through (a non-native V: declaration, an
 *   unsupported duration). One reader, two verdicts — the gate is this file's
 *   half and it belongs here. What must not survive is the second tokenizer.
 *
 * The store is complementary rather than duplicated: `adopt` requires a
 * receipt, so it cannot hold an edit that has not been rendered yet, which is
 * precisely what score_edit writes. That gap is §0 of the HANDOFF.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 *
 * MiniMax Music 3 takes a caption and gives back audio. There is nothing in
 * between to argue with: if the chorus lands on the wrong chord, the only move
 * is to re-word the caption and roll the dice again. YuE2 puts a SCORE in the
 * middle — two monophonic voices and a chord timeline in a bounded ABC dialect
 * — and that score is an editable object. Change four chord symbols, re-render,
 * and the difference on the record is those four chords.
 *
 * So these tools are not "another music generator". They are the door onto the
 * middle of one: read the score, edit the score, PROVE the edit before paying
 * for it, render, and hear A against B.
 *
 * ── THE TWO TIERS, WHICH IS THE OWNER'S DECISION ───────────────────────────
 *
 * This file is the FRONTIER surface: full access, six tools, and descriptions
 * written for a model that can hold a hundred bars of ABC in its head and
 * reason about voice leading.
 *
 * The local Qwen3-4B chat panel (server/chat/tools.js, 32,768 context) gets a
 * NARROWER, MECHANICAL set — tempo, meter, drop an instrument, reorder or
 * repeat a section — and the reason is measured, not diplomatic: server/mv/
 * sfxcue.js found that this 4B answers FLAT JSON reliably and NESTED JSON not
 * at all, and every one of those four edits is a flat call whose musical work
 * is done by the CODE in this file rather than by the model's own output.
 * Reharmonisation is the opposite shape: it is the model writing a hundred
 * lines of ABC, and a 4B writing ABC produces notation that validates and
 * says nothing. Which tools it gets and why the others are withheld is
 * written out at the tier split further down this file.
 *
 * ONE EDIT PRIMITIVE, TWO EXPOSURES. Both tiers reach the same functions
 * below — checkScore() and MECHANICAL — because a second implementation of
 * the beat-count invariant is how the two surfaces come to disagree about
 * whether a score is valid.
 *
 * ── WHY score_check IS THE POINT OF THE WHOLE FILE ─────────────────────────
 *
 * The vendor's own skill says it plainly (references/abc-editing.md): the
 * tooling "does not implement the entire ABC standard, force the generator to
 * follow the score, or measure perceptual harmony". Nothing downstream will
 * catch a bad edit. The model will sing something.
 *
 * THE DEFECT THIS EXISTS FOR, and it is ours, not a hypothetical: the score at
 * yue_out/run_fixed/score.abc was edited from M:2/4 to M:4/4 and the content
 * was left alone. Every one of its 122 bars holds 8 sixteenths — two quarter
 * notes — under a header that claims four. It renders. It produced 167.0 s of
 * finished audio. It engraves WRONGLY, and it is now the parent of everything,
 * so score_get says so on the way past.
 *
 * MEASURED, and this is the number that settles which side of the file is
 * wrong: at Q:1/4=90 the bars as written are 244 quarters = 162.67 s, the 4/4
 * header would make them 488 quarters = 325.33 s, and the audio came out
 * 167.04 s. The content is +2.7% off the measurement; the header is -48.7%.
 * The model followed the bars and ignored the header — so a header/content
 * disagreement is not cosmetic, it is a lie about what you are about to hear.
 *
 * A render costs 399.6 s MEASURED (6.7 minutes). checkScore() costs under a
 * millisecond on this same 140-line score. It runs before any render is spent,
 * and score_edit REFUSES rather than writing a version that cannot engrave.
 *
 * ── WHERE THE NUMBERS COME FROM ────────────────────────────────────────────
 * Every measurement in this file is one run's receipt — run_fixed/result.json
 * — and the vendor skill at skills/yue2-music. Nothing here is estimated
 * unless it says ESTIMATED.
 */
import { createHash } from "node:crypto";

/* ───────────────────────────────────────────── the measured facts, once */

/**
 * One run, one receipt. Interpolated into tool descriptions and returned by
 * score_render so the sentence an agent reads and the number a result carries
 * cannot drift — the same reason mcp-videolab.js takes H3_EXCLUDED from the
 * catalogue instead of typing the territories out.
 *
 * Source: yue_out/run_fixed/result.json (timing, audio_seconds) and its
 * request.json / score.abc. ALL MEASURED unless the key says ESTIMATED.
 */
export const MEASURED = {
  // The whole render, end to end, for one song on this rig.
  audio_seconds: 167.0,
  e2e_seconds: 399.6,
  realtime_factor: 2.39,           // 399.6 / 167.0
  // A SUPPLIED SCORE COSTS NOTHING TO PLAN. timing.abc reads exactly this.
  abc_seconds: 0,
  abc_output_tokens: 0,
  abc_external_prefix_tokens: 1512,
  // Where the time actually goes.
  semantic_seconds: 281.0,
  semantic_output_tokens: 4177,
  semantic_tokens_per_second: 14.87,
  nar_seconds: 106.3,
  vae_seconds: 5.7,
  load_warm_seconds: 6.6,
  load_cold_seconds: 20,           // approximate, first load of the session
  peak_gib: 10.6,
  usable_gib: 15.99,
  execution: "eager",
  attention: "sdpa",
  cfg_branches: 1,
  sample_rate: 48000,
  // For the comparison an agent will ask for: the other music engine here.
  minimax_realtime_factor: 1.53,   // config.js:398, DIRECTING.md:465
  /** The score that produced the run above — and its defect. */
  parent_score: {
    sha256: "03c1d10944889ad6818447e652c2abe9554c328d7b64b2db2dcb5a003e4392db",
    bytes: 2253,
    header_meter: "4/4",
    written_meter: "2/4",
    bars: 122,
    quarters_as_written: 244,
    bpm: 90,
    nominal_seconds_as_written: 162.67,
    nominal_seconds_if_header_obeyed: 325.33,
    rendered_seconds: 167.04,
  },
};

/* ────────────────────────────────── the four sentences, written down once */

/**
 * THE NON-NEGOTIABLES. An agent reads descriptions instead of code, so these
 * four facts are constants rather than prose typed six times: the file cannot
 * grow a tool that forgets one, and mcp-music-score_test.js asserts each tool
 * carries the ones that apply to it.
 */
export const NO_AUDIO_REFERENCE =
  "⚠ YuE2 ACCEPTS NO AUDIO REFERENCE OF ANY KIND. Its request takes style, "
  + "lyrics, cot, seed, abc, cfg_scale and id — and the vendor states there is no "
  + "field for reference_audio, phonemes, bpm, negative_prompt, an edit interval "
  + "or a reference singer (skills/yue2-music/references/generation-and-covers.md). "
  + "You cannot hand it a singer to imitate, a track to continue, or a mix to match. "
  + "Tempo and meter go in the SCORE; everything else goes in words.";

export const NO_BRACKETS =
  "⚠ LYRICS MUST NEVER CARRY BRACKETED SECTION LABELS — the model SINGS them. "
  + "MEASURED: three MiniMax tracks were rejected for audibly singing \"[verse]\", "
  + "and one carrying them ran 202 s instead of 64 s. Separate sections with a "
  + "BLANK LINE, which is what the run that produced this rig's only YuE2 song did "
  + "(run_fixed/request.json carries no brackets at all). The section structure "
  + "belongs in the score's `% verse` comments, not in the sung words. Any [..] in "
  + "lyrics is refused here before a render is spent.";

export const NOT_ENFORCED =
  "⚠ SCORE ADHERENCE IS NOT ENFORCED BY THE MODEL. The vendor's own skill says "
  + "the tooling does not \"force the generator to follow the score\" "
  + "(references/abc-editing.md), so a VALID score can still come back sung "
  + "differently. A green check proves the notation engraves and says what you "
  + "meant — it is not a promise about the audio. The only test of adherence is "
  + "listening, which is what score_compare is for.";

export const FREE_VS_PAID =
  "A score edit is FREE — text in, text out, no GPU, no weights loaded. A render "
  + "is NOT: 399.6 s end to end for 167.0 s of audio on this rig (MEASURED, 2.39x "
  + "realtime), holding the card the whole time. So edit and check as many times "
  + "as you like, and spend a render only on a score you have already proved.";

/* ══════════════════════════════════════════════════════════════════════════
 *                    THE BOUNDED ABC DIALECT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A port of the vendor's own bounded parser (skills/yue2-music/scripts/
 * abc_tools.py, standard-library Python) into this process, so the check runs
 * with no interpreter, no subprocess and no weights — which is what lets it
 * run before every render instead of when somebody remembers.
 *
 * It is deliberately the SAME bounded dialect and not a general ABC parser.
 * Tuplets, grace notes, chords-as-stacks, repeats, slurs, broken rhythms and
 * w: lyric lines are all REFUSED rather than given guessed timing, exactly as
 * the vendor refuses them. A refusal here can mean "outside this dialect"
 * rather than "invalid ABC"; the report says so in its own `scope` field.
 *
 * TWO DELIBERATE DIVERGENCES from the Python, both in the same direction —
 * more diagnosis per round trip:
 *
 *  1. The Python raises on the FIRST failure (abc_tools.py:44 fail()). Ours
 *     collects every bar-level failure, because "group 1, Vocal, bar 1" and
 *     "all 122 bars, every one short by half" are the same first line and
 *     completely different bugs. One says fix a bar; the other says fix the
 *     header. Telling them apart is the whole job of this file.
 *
 *  2. The clock advances by what a bar HOLDS, not by what its M: claims.
 *     MEASURED reason: on the one score this rig has rendered, the audio came
 *     out 167.04 s against 162.67 s for the content and 325.33 s for the
 *     header. The generator followed the content. So the derived duration
 *     follows the content too, and the header's reading is reported BESIDE it
 *     rather than instead of it.
 */

/**
 * Time is integer ticks of 1/1024 of a quarter note — never floats.
 *
 * Why 1024 exactly: the dialect's L: denominator and M: denominator are both
 * powers of two no greater than 1024 (abc_tools.py:62, :162), so a note of
 * `units` at L:1/D is units*4096/D ticks and a bar of M:n/d is 4096n/d ticks —
 * both integers, always. Fractions would be exact too; integers are exact AND
 * comparable with ===, which is what the voice-grid check needs.
 */
export const TICKS_PER_QUARTER = 1024;

const NATIVE_VOICES = ["Vocal", "Ins"];

/** The two header lines, to the byte. abc_tools.py:167 compares them like this. */
const NATIVE_VOICE_LINES = [
  'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
  'V: Ins clef=treble name="Ins Melody" snm="Inst."',
];

/** abc_tools.py:21 — anything else must be split into tied supported lengths. */
const DURATIONS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const DURATION_SET = new Set(DURATIONS);
// Refusal diagnostics must not expand an invalid multiplier into billions of
// tied notes. These caps also bound the mechanical rest/re-barring helpers.
const MAX_DURATION_PIECES = 4096;
const MAX_EXPANDED_BARS = 65536;

/** abc_tools.py:22 — the whole native chord vocabulary. C13, Cmaj9, A7alt are not in it. */
const QUALITIES = ["", "m", "dim", "aug", "7", "maj7", "m7", "dim7", "m7b5",
  "sus4", "sus2", "6", "m6", "7sus4", "m(maj7)"];

const PITCH_NAME = "[A-G](?:bb|##|b|#)?";
const CHORD_RE = new RegExp(
  "^" + PITCH_NAME + "(?:"
  + QUALITIES.map((q) => q.replace(/[()]/g, "\\$&")).join("|")
  + ")(?:/" + PITCH_NAME + ")?$",
);

/* One token: a quoted chord, an inline key change, or a note/rest with its
 * accidental, octave marks, duration multiplier and tie. Sticky (`y`) so it can
 * be anchored at a cursor the way Python's TOKEN.match(body, cursor) is. */
const TOKEN_RE = /"([^"\n]*)"|\[K:([^\]\n]+)\]|(\^\^|__|\^|_|=)?([A-Ga-gz])([,']*)([0-9]*)(-?)/y;

const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC_VALUE = { "=": 0, _: -1, __: -2, "^": 1, "^^": 2 };

const KEY_FIFTHS = new Map();
["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
  .forEach((k, i) => KEY_FIFTHS.set(k, i - 7));
["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"]
  .forEach((k, i) => KEY_FIFTHS.set(k, i - 7));

const sha256 = (s) => createHash("sha256").update(Buffer.from(String(s), "utf8")).digest("hex");

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;

/** null for an unsupported key — the caller turns that into a problem. */
function keyAccidentals(key) {
  if (!KEY_FIFTHS.has(key)) return null;
  const count = KEY_FIFTHS.get(key);
  const out = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  const order = count > 0 ? "FCGDAEB" : "BEADGCF";
  for (const letter of order.slice(0, Math.abs(count))) out[letter] = count > 0 ? 1 : -1;
  return out;
}

function parseMeter(text) {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(text).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const d = Number(m[2]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d > 1024 || !isPowerOfTwo(d)
      || !Number.isSafeInteger((4 * TICKS_PER_QUARTER * n) / d)) return null;
  return { n, d };
}

const barTicks = (meter) => (4 * TICKS_PER_QUARTER * meter.n) / meter.d;
const noteTicks = (units, denom) => (units * 4 * TICKS_PER_QUARTER) / denom;
const ticksToUnits = (ticks, denom) => (ticks * denom) / (4 * TICKS_PER_QUARTER);

/** "2", "3/2" — a quarter-note count a human can read, exact, never rounded. */
function quartersLabel(ticks) {
  if (ticks % TICKS_PER_QUARTER === 0) return String(ticks / TICKS_PER_QUARTER);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.abs(ticks), TICKS_PER_QUARTER);
  return `${ticks / g}/${TICKS_PER_QUARTER / g}`;
}

const quarters = (ticks) => ticks / TICKS_PER_QUARTER;

/**
 * A meter that would make a bar of `ticks` correct, preferring the denominator
 * already in the header — so a 2-quarter bar under M:4/4 is offered "M:2/4"
 * rather than a technically equal "M:4/8" nobody wrote.
 */
function meterFor(ticks, preferDenominator) {
  const order = [preferDenominator, 4, 8, 2, 16, 1, 32, 64].filter(Boolean);
  for (const d of order) {
    if (!isPowerOfTwo(d) || d > 1024) continue;
    const n = (ticks * d) / (4 * TICKS_PER_QUARTER);
    if (Number.isInteger(n) && n >= 1) return `${n}/${d}`;
  }
  return null;
}

/**
 * Split a duration into native multipliers, tied for notes and plain for rests.
 *
 * The vendor allows only {1,2,3,4,6,8,12,16,24,32,48} and says to "express 10
 * units as C8-C2, or z8z2 for a rest" (abc-editing.md). This is that rule as
 * code, because the mechanical re-barring below cannot ask a person.
 */
function durationTokens(units, head, { tie, maxPieces = MAX_DURATION_PIECES }) {
  if (!Number.isSafeInteger(units) || units < 0 || units > DURATIONS.at(-1) * maxPieces) return null;
  const pieces = [];
  let left = units;
  while (left > 0) {
    if (pieces.length >= maxPieces) return null;
    const take = DURATIONS.filter((d) => d <= left).pop();
    if (!take) return null;                       // cannot be expressed; caller refuses
    pieces.push(take);
    left -= take;
  }
  /* ⚠ A REST IS NEVER TIED. The dialect refuses `z8-z2` outright (abc_tools.py
   * rejects a rest carrying a tie), so the tie logic below must not reach one —
   * an earlier draft of this function emitted exactly that and the re-check at
   * the end of every mechanical op is what caught it. */
  const isRest = head === "z";
  return pieces
    .map((d, i) => head + (d === 1 ? "" : String(d))
      // A note continues with a tie; the last piece carries the original's tie.
      + (isRest ? "" : (tie || i < pieces.length - 1 ? "-" : "")))
    .join("");
}

/** A whole bar of rest as explicit tokens — `z8`, `z8z2`. Never `Z`, never tied. */
function restTokens(ticks, denom) {
  const units = ticksToUnits(ticks, denom);
  if (!Number.isInteger(units)) return null;
  return durationTokens(units, "z", { tie: false });
}

/**
 * One bar's tokens, with their offsets — used by the checker AND by the
 * mechanical re-barrer, so the two cannot disagree about where a beat is.
 */
function tokenizeBar(body, denom) {
  const tokens = [];
  const errors = [];
  let cursor = 0;
  let at = 0;
  while (cursor < body.length) {
    if (/\s/.test(body[cursor])) { cursor += 1; continue; }
    TOKEN_RE.lastIndex = cursor;
    const m = TOKEN_RE.exec(body);
    if (!m || m.index !== cursor) {
      errors.push(`unsupported token at ${JSON.stringify(body.slice(cursor, cursor + 24))}`);
      return { tokens, errors };
    }
    cursor = TOKEN_RE.lastIndex;
    const [text, chord, key, acc, note, oct, digits, tie] = m;
    if (chord !== undefined) { tokens.push({ kind: "chord", at, ticks: 0, sym: chord, text }); continue; }
    if (key !== undefined) { tokens.push({ kind: "key", at, ticks: 0, key, text }); continue; }
    const units = digits ? Number(digits) : 1;
    const ticks = noteTicks(units, denom);
    if (!Number.isSafeInteger(units) || units < 1 || !Number.isSafeInteger(ticks)
        || !Number.isSafeInteger(at + ticks)) {
      errors.push("note/rest duration is outside the finite, exact integer range");
      return { tokens, errors };
    }
    tokens.push({
      kind: note === "z" ? "rest" : "note",
      at, ticks, units, letter: note, acc: acc || "", oct: oct || "", tie: tie === "-", text,
    });
    at += ticks;
  }
  return { tokens, errors };
}

/* ──────────────────────────────────────────────────────────────── the parse */

function newVoice(meter, key) {
  return { meter, key, ticks: 0, notes: [], chords: [], keys: [[0, key]], bars: [], pending: null };
}

/**
 * Parse the bounded dialect and collect everything wrong with it.
 *
 * Returns a structure, never throws: a tool that dies on bad input teaches an
 * agent to stop calling it. `fatal` is set when the header itself could not be
 * read, in which case nothing after it was attempted and saying so is the
 * honest answer.
 */
export function parseScore(text) {
  const raw = String(text ?? "");
  const lines = raw.split("\n");
  // One trailing newline is the native form; splitlines() in the Python drops
  // it the same way. Two would be a real difference and is left visible.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const problems = [];
  const notices = [];
  const push = (code, where, says, fix) => problems.push({ code, where, says, ...(fix ? { fix } : {}) });

  const state = {
    text: raw,
    line_count: lines.length,
    header: { meter: null, unit_denominator: null, bpm: null, key: null, voice_lines_native: false },
    sections: [],
    groups: [],
    bars: [],
    voices: {},
    fatal: null,
    problems,
    notices,
    ok: false,
  };
  const done = () => {
    state.ok = problems.length === 0;
    return state;
  };
  const fatal = (code, where, says, fix) => {
    push(code, where, says, fix);
    state.fatal = problems[problems.length - 1];
    return done();
  };

  if (lines.length < 12) {
    return fatal("header_shape", `the whole file (${lines.length} line(s))`,
      "This is not a native two-voice score: the shortest possible one is 12 lines "
      + "(8 header lines, then V: Vocal, its music, V: Ins, its music).",
      "Start from score_get on an existing version rather than writing a header by hand.");
  }
  if (lines[0] !== "X:1" || lines[1] !== "T:") {
    return fatal("header_shape", "lines 1-2",
      `Expected the native "X:1" then a bare "T:", found ${JSON.stringify(lines[0])} then ${JSON.stringify(lines[1])}.`,
      "Leave T: empty. The title is not part of the score.");
  }
  if (!lines[2].startsWith("M:")) {
    return fatal("header_shape", "line 3", `Expected the M: meter header, found ${JSON.stringify(lines[2])}.`);
  }
  const headerMeter = parseMeter(lines[2].slice(2));
  if (!headerMeter) {
    return fatal("header_shape", "line 3",
      `M:${lines[2].slice(2)} is not a supported meter — write an explicit fraction whose denominator is a power of two up to 1024.`);
  }
  const unitMatch = /^L:1\/([1-9][0-9]*)$/.exec(lines[3]);
  if (!unitMatch || !isPowerOfTwo(Number(unitMatch[1])) || Number(unitMatch[1]) > 1024) {
    return fatal("header_shape", "line 4",
      `Expected L:1/<power of two up to 1024>, found ${JSON.stringify(lines[3])}.`,
      "PRESERVE the exported L: value. It is the rhythmic grid the rest of the file is written on; "
      + "changing it silently rescales every duration in the score.");
  }
  const denom = Number(unitMatch[1]);
  const tempoMatch = /^Q:1\/4=([1-9][0-9]*)$/.exec(lines[4]);
  if (!tempoMatch) {
    return fatal("header_shape", "line 5",
      `Expected an integer quarter-note tempo Q:1/4=<BPM>, found ${JSON.stringify(lines[4])}.`);
  }
  const bpm = Number(tempoMatch[1]);
  if (!Number.isSafeInteger(bpm) || bpm < 1) {
    return fatal("header_shape", "line 5", "Quarter-note tempo must be a positive, finite, exact integer.");
  }

  /* THE VOICE DECLARATIONS, to the byte. This is one of the four invariants
   * because it is the one an agent breaks while being helpful: "tidying" the
   * header, renaming a voice to something more descriptive, or dropping snm=.
   * The native exporter writes these two lines and the parser compares them
   * literally (abc_tools.py:167), so a prettier header is an unreadable file. */
  const voiceLinesNative = lines[5] === NATIVE_VOICE_LINES[0] && lines[6] === NATIVE_VOICE_LINES[1];
  if (!voiceLinesNative) {
    for (const i of [5, 6]) {
      if (lines[i] !== NATIVE_VOICE_LINES[i - 5]) {
        push("voice_declaration", `line ${i + 1}`,
          `The V: declaration is not the native one. Found ${JSON.stringify(lines[i])}.`,
          `Restore it exactly: ${JSON.stringify(NATIVE_VOICE_LINES[i - 5])}`);
      }
    }
  }
  if (!lines[7].startsWith("K:")) {
    return fatal("header_shape", "line 8", `Expected the K: key header, found ${JSON.stringify(lines[7])}.`);
  }
  const headerKey = lines[7].slice(2);
  if (!keyAccidentals(headerKey)) {
    return fatal("key", "line 8",
      `K:${headerKey} is not a supported key — use a standard major (C, Bb, F#) or minor (Am, Dm, C#m) name.`,
      "Modes and custom key strings are outside this dialect; write the relative major or minor and put the mode in the style prompt.");
  }

  state.header = {
    meter: `${headerMeter.n}/${headerMeter.d}`,
    unit_denominator: denom,
    unit: `1/${denom}`,
    bpm,
    key: headerKey,
    voice_lines_native: voiceLinesNative,
  };
  for (const name of NATIVE_VOICES) state.voices[name] = newVoice({ ...headerMeter }, headerKey);

  /* ── the groups ── */

  let cursor = 8;
  let groupIndex = 0;
  let section = null;

  const parseBar = (body, name, where) => {
    const v = state.voices[name];
    const claimed = barTicks(v.meter);
    const start = v.ticks;
    let held = 0;
    let flawed = false;

    if (body === "Z") {
      if (v.pending) {
        push("tie", where, "A tie runs into a full-measure Z rest. A tie must join two sounding notes.",
          "Write the resting bar as explicit rests and resolve the tie before it, or drop the tie.");
        v.pending = null;
        flawed = true;
      }
      held = claimed;
    } else {
      const local = new Map();
      const { tokens, errors } = tokenizeBar(body, denom);
      for (const e of errors) {
        push("token", where, e,
          "Tuplets, grace notes, stacked chords, repeats, slurs, broken rhythms and w: lyric lines are "
          + "outside this dialect — rebuild the passage as plain notes, rests and quoted chord symbols.");
        flawed = true;
      }
      for (const t of tokens) {
        if (t.kind === "chord") {
          if (!CHORD_RE.test(t.sym)) {
            push("chord", where,
              `"${t.sym}" is not a native chord symbol.`,
              "The whole vocabulary is: major (no suffix), " + QUALITIES.filter(Boolean).join(", ")
              + ". Roots and slash basses are note names (Dbaug, F#m7/C#). Cmaj9, C13, A7alt and "
              + "C:maj do not exist here — pick a supported core and ask for the voicing in the style prompt.");
            flawed = true;
            continue;
          }
          if (name === "Ins") {
            push("chord", where, "A chord symbol sits in the Ins voice. Harmony lives in Vocal, including while Vocal rests.",
              "Move the symbol to the Vocal line at the same musical time.");
            flawed = true;
            continue;
          }
          v.chords.push([start + held, t.sym]);
          continue;
        }
        if (t.kind === "key") {
          if (!keyAccidentals(t.key)) {
            push("key", where, `[K:${t.key}] is not a supported key.`);
            flawed = true;
            continue;
          }
          v.key = t.key;
          v.keys.push([start + held, t.key]);
          local.clear();
          continue;
        }
        if (!DURATION_SET.has(t.units)) {
          push("duration", where,
            `Duration ${t.units} is not a native multiplier.`,
            `Supported: ${DURATIONS.join(", ")}. Split it into tied supported lengths — ${t.units} units is `
            + `${durationTokens(t.units, t.letter === "z" ? "z" : (t.acc + t.letter + t.oct), { tie: t.kind === "note", maxPieces: 32 }) || "outside the bounded suggestion range"}.`);
          flawed = true;
        }
        if (held + t.ticks > claimed) {
          push("bar_overflow", where,
            `A ${quartersLabel(t.ticks)}-quarter ${t.kind} starting at ${quartersLabel(held)} runs past the end of a `
            + `${quartersLabel(claimed)}-quarter bar.`,
            "Shorten it, or split it across the barline with a tie.");
          flawed = true;
        }
        if (t.kind === "rest") {
          if (t.acc || t.oct || t.tie) {
            push("token", where, "A rest cannot carry an accidental, an octave mark or a tie.");
            flawed = true;
          }
          if (v.pending) {
            push("tie", where, "A tie runs into a rest.", "Resolve the tie on a sounding note, or drop it.");
            v.pending = null;
            flawed = true;
          }
        } else {
          const letter = t.letter.toUpperCase();
          let written = 60 + NATURAL[letter] + (t.letter === t.letter.toLowerCase() ? 12 : 0);
          written += 12 * ((t.oct.match(/'/g) || []).length - (t.oct.match(/,/g) || []).length);
          if (t.oct.includes(",") && t.oct.includes("'")) {
            push("token", where, `Mixed octave marks in ${JSON.stringify(t.text)}.`);
            flawed = true;
          }
          /* Accidentals propagate BY LETTER ACROSS OCTAVES in this dialect —
           * after ^F both F and f are sharp for the rest of the bar. The
           * vendor warns that general-purpose ABC parsers differ here
           * (abc-editing.md), which is why this is ported rather than
           * delegated. */
          let alteration = local.has(letter) ? local.get(letter) : keyAccidentals(v.key)[letter];
          if (t.acc) {
            alteration = ACC_VALUE[t.acc];
            local.set(letter, alteration);
          }
          let pitch = written + alteration;
          if (v.pending) {
            const [oldPitch, oldWritten] = v.pending;
            // An unmarked continuation keeps the tied pitch, even across a barline.
            if (!t.acc && written === oldWritten) pitch = oldPitch;
            if (pitch !== oldPitch) {
              push("tie", where,
                `A tie changes pitch, from MIDI ${oldPitch} to ${pitch}.`,
                "A tie must join equal sounding pitches; two different pitches need two notes (or a slur, which this dialect has no room for).");
              flawed = true;
              v.notes.push([start + held, pitch, t.ticks]);
            } else {
              v.notes[v.notes.length - 1][2] += t.ticks;
            }
          } else {
            if (pitch < 0 || pitch > 127) {
              push("token", where, `Pitch ${pitch} is outside the MIDI range.`);
              flawed = true;
            }
            v.notes.push([start + held, pitch, t.ticks]);
          }
          v.pending = t.tie ? [pitch, written] : null;
        }
        held += t.ticks;
      }
    }

    /* ⚠ THE INVARIANT THIS FILE EXISTS FOR. Reported only when nothing else in
     * the bar already explains the shortfall — an overflow or an unsupported
     * token would produce a second, derivative complaint about the same bar. */
    if (!flawed && held !== claimed) {
      push("bar_beats", where,
        `The bar holds ${quartersLabel(held)} quarter note(s); M:${v.meter.n}/${v.meter.d} claims ${quartersLabel(claimed)}.`,
        `Either re-bar the content, or change the header — see \`diagnosis\`, which says which side is wrong.`);
    }

    if (!Number.isSafeInteger(start + held)) {
      push("duration", where, "The accumulated score duration is outside the exact integer range.");
    }
    state.bars.push({
      group: groupIndex, section, voice: name, index: v.bars.length + 1,
      body, meter: `${v.meter.n}/${v.meter.d}`,
      start_quarter: quarters(start), held_ticks: held, claimed_ticks: claimed,
      holds_quarters: quarters(held), claims_quarters: quarters(claimed),
    });
    v.bars.push([start, held, claimed, v.meter.n, v.meter.d]);
    // The clock follows what is WRITTEN, for the measured reason in the header comment.
    v.ticks += held;
    return { held, claimed };
  };

  while (cursor < lines.length) {
    const comments = [];
    while (cursor < lines.length && lines[cursor].startsWith("%")) {
      if (!lines[cursor].startsWith("% ")) {
        push("section_comment", `line ${cursor + 1}`,
          `Section comments are written "% verse", with the space. Found ${JSON.stringify(lines[cursor])}.`,
          "The native exporter always writes the space; a parser that requires it will reject this file.");
      }
      comments.push(lines[cursor].replace(/^%\s*/, ""));
      cursor += 1;
    }
    if (cursor >= lines.length) {
      push("group_shape", `line ${cursor}`, "The file ends on a section comment with no music after it.");
      break;
    }
    if (comments.length) {
      section = comments[comments.length - 1];
      state.sections.push({ name: section, group: groupIndex + 1, comments: comments.slice() });
    }
    groupIndex += 1;
    const group = { index: groupIndex, section, comments, fields: {}, bodies: {}, counts: {} };
    let broke = false;

    for (const name of NATIVE_VOICES) {
      const where = `group ${groupIndex}${section ? ` (% ${section})` : ""}, ${name}`;
      if (cursor >= lines.length || lines[cursor] !== `V: ${name}`) {
        push("group_shape", `line ${cursor + 1}`,
          `Expected "V: ${name}" here, found ${cursor >= lines.length ? "the end of the file" : JSON.stringify(lines[cursor])}.`,
          "Every group is a V: Vocal block followed by a V: Ins block, in that order, both present even when one is silent.");
        broke = true;
        break;
      }
      cursor += 1;
      const v = state.voices[name];
      const fields = [];
      const seen = new Set();
      while (cursor < lines.length && (lines[cursor].startsWith("M:") || lines[cursor].startsWith("K:"))) {
        const line = lines[cursor];
        const kind = line[0];
        if (seen.has(kind)) push("group_shape", `line ${cursor + 1}`, `Duplicate ${kind}: field in one voice block.`);
        seen.add(kind);
        if (kind === "M") {
          const m = parseMeter(line.slice(2));
          if (!m) push("header_shape", `line ${cursor + 1}`, `M:${line.slice(2)} is not a supported meter.`);
          else v.meter = m;
        } else {
          if (!keyAccidentals(line.slice(2))) push("key", `line ${cursor + 1}`, `K:${line.slice(2)} is not a supported key.`);
          else {
            v.key = line.slice(2);
            v.keys.push([v.ticks, v.key]);
          }
        }
        fields.push(line);
        cursor += 1;
      }
      if (cursor >= lines.length) {
        push("group_shape", `line ${cursor}`, `${where}: the voice block has no music line.`);
        broke = true;
        break;
      }
      const line = lines[cursor];
      if (!line.endsWith("|")) {
        push("group_shape", `line ${cursor + 1}`,
          `${where}: a music line must end with a plain barline.`,
          "Double barlines, repeat marks and alternate endings are outside this dialect.");
      }
      cursor += 1;
      const bodies = [];
      for (const piece of line.replace(/\|$/, "").split("|")) {
        const bar = piece.trim();
        if (!bar) {
          push("group_shape", `line ${cursor}`,
            `${where}: an empty measure, or a double/repeat barline.`);
          continue;
        }
        const z = /^Z([2-4])?$/.exec(bar);
        if (z) for (let i = 0; i < Number(z[1] || 1); i += 1) bodies.push("Z");
        else bodies.push(bar);
      }
      if (bodies.length < 1 || bodies.length > 4) {
        push("group_shape", `line ${cursor}`,
          `${where}: ${bodies.length} measures in one block, after expanding Z rests.`,
          "The native exporter groups one to four measures at a time. Split the block.");
      }
      group.fields[name] = fields;
      group.bodies[name] = bodies;
      group.counts[name] = bodies.length;
      bodies.forEach((body, i) => parseBar(body, name, `${where}, bar ${v.bars.length + 1} (${i + 1} of ${bodies.length} in this block)`));
    }

    if (broke) break;
    if (group.counts.Vocal !== group.counts.Ins) {
      push("grid", `group ${groupIndex}`,
        `The voices disagree about how many measures this group has: Vocal ${group.counts.Vocal}, Ins ${group.counts.Ins}.`,
        "Both voices are on one time grid. Pad the short one with rests (Z counts by measures, not by L: units).");
    }
    state.groups.push(group);
  }

  /* ── whole-score invariants ── */

  for (const name of NATIVE_VOICES) {
    const v = state.voices[name];
    if (v.pending) {
      push("tie", name, "The score ends on an unresolved tie.",
        "Drop the final tie, or add the note it resolves to.");
    }
  }
  const vocal = state.voices.Vocal;
  const ins = state.voices.Ins;
  if (JSON.stringify(vocal.bars) !== JSON.stringify(ins.bars)) {
    const at = vocal.bars.findIndex((b, i) => JSON.stringify(b) !== JSON.stringify(ins.bars[i]));
    push("grid", at >= 0 ? `bar ${at + 1}` : "the whole score",
      "The two voices are not on the same time grid — their bar starts, lengths or meters diverge"
      + (at >= 0 ? ` from bar ${at + 1}.` : "."),
      "Every meter change must appear in BOTH voice blocks at the same musical time.");
  }
  if (JSON.stringify(vocal.keys) !== JSON.stringify(ins.keys)) {
    push("grid", "the whole score",
      "The two voices change key at different times.",
      "Both voices must change key at the same musical time, header or inline.");
  }

  if (!state.sections.length) {
    notices.push("This score carries no `% verse` / `% chorus` comments, so it has no structure an "
      + "agent can reorder and score_mechanical's `sections` op has nothing to work with.");
  }
  if (!ins.notes.length && state.bars.length) {
    notices.push("The Ins voice is silent for the entire score — every bar of it is a rest. That is legal; "
      + "it means the accompaniment is being left entirely to the style prompt.");
  }
  return done();
}

/* ─────────────────────────────────────────────────────── the check, shaped */

/**
 * Which side of a header/content disagreement is actually wrong.
 *
 * This is the sentence the owner needed at 02:45 and did not have. All 122
 * bars short by the same amount is a WRONG HEADER and costs one character to
 * fix; one bar short is a WRONG BAR and costs a re-bar. The first line of a
 * fail-fast parser reads identically in both cases.
 */
function diagnose(parsed) {
  const beats = parsed.problems.filter((p) => p.code === "bar_beats");
  if (!beats.length) return null;

  /* ⚠ A FULL-MEASURE Z REST IS NOT A WITNESS. The vendor is explicit that "full-bar
   * `Z` rests count by measures, not by `L:` units" (abc-editing.md), so a Z bar
   * holds whatever the M: header says it holds and can never disagree with it.
   *
   * MEASURED consequence on the real score: 244 bars, of which 92 are Z. Counting
   * those as evidence gives "152 of 244 bars are wrong" — which reads as scattered
   * typos and sends you re-barring 152 bars. Excluding them gives "152 of 152
   * CONTENT bars are wrong, all by the same amount", which is one wrong character
   * in the header. Same bytes, opposite conclusion; this is the line that decides
   * which one an agent is told. */
  const content = parsed.bars.filter((b) => b.body !== "Z");
  const bad = content.filter((b) => b.held_ticks !== b.claimed_ticks);
  const zBars = parsed.bars.length - content.length;
  const holds = new Set(bad.map((b) => b.held_ticks));
  const claims = new Set(bad.map((b) => b.claimed_ticks));

  if (bad.length === content.length && content.length > 1 && holds.size === 1 && claims.size === 1) {
    const held = [...holds][0];
    const claimed = [...claims][0];
    // Offer the header's OWN denominator first: a 2-quarter bar under M:4/4
    // should be told "M:2/4", not a technically equal "M:4/8" nobody wrote.
    const suggestion = meterFor(held, Number(String(parsed.header.meter).split("/")[1]));
    const probe = suggestion ? probeMeter(parsed.text, suggestion) : null;
    return "THE HEADER IS THE SIDE THAT IS WRONG. Every bar that holds anything disagrees with it in the same "
      + `direction: all ${bad.length} content bars hold ${quartersLabel(held)} quarter note(s), while `
      + `M:${parsed.header.meter} claims ${quartersLabel(claimed)}`
      + (zBars ? ` (the other ${zBars} bars are full-measure Z rests, which are measured in MEASURES and so `
        + "stretch to whatever the header says — they cannot testify either way, and they are also why a wrong "
        + "header changes this score's length in places where nothing is written)" : "")
      + ". "
      + (probe
        ? `PROVED, not guessed: re-checking this same text with M:${suggestion} gives `
          + `${probe.problems === 0 ? "ZERO problems" : `${probe.problems} problem(s)`}, `
          + `${probe.bars} bars per voice, ${probe.quarters} quarters, ${probe.nominal_seconds} s nominal at `
          + `Q:1/4=${parsed.header.bpm}. Not one note moves. `
        : "")
      + "This is exactly the defect in the score that produced this rig's only YuE2 render — run_fixed/score.abc "
      + "is an M:2/4 score that was re-headered to M:4/4 with the content left alone. MEASURED, and it settles "
      + `which reading the model actually uses: that score's bars as written are `
      + `${MEASURED.parent_score.nominal_seconds_as_written} s, the header's reading is `
      + `${MEASURED.parent_score.nominal_seconds_if_header_obeyed} s, and the audio came out `
      + `${MEASURED.parent_score.rendered_seconds} s. The generator followed the bars and ignored the header, `
      + "so a disagreement here is a lie about what you are about to hear.";
  }
  const named = bad.slice(0, 6).map((b) => `${b.voice} bar ${b.index} (holds ${quartersLabel(b.held_ticks)}, claims ${quartersLabel(b.claimed_ticks)})`);
  return `THE BARS ARE THE SIDE THAT IS WRONG. ${bad.length} of ${content.length} bars that hold anything do not `
    + `hold what their M: header claims: ${named.join("; ")}${bad.length > 6 ? `, and ${bad.length - 6} more` : ""}. `
    + "Re-bar the content. Do NOT move the header to match the mistake — that is how a score comes to "
    + "render plausibly and engrave wrongly.";
}

/**
 * Re-read the same text under a different M:, and report what happens.
 *
 * This is what turns "the header looks wrong" into "M:2/4 gives zero problems",
 * and it costs one more parse of a 140-line file. It deliberately calls
 * parseScore rather than checkScore so there is no diagnose→check→diagnose loop.
 */
function probeMeter(text, meter) {
  const lines = String(text).split("\n");
  if (!lines[2] || !lines[2].startsWith("M:")) return null;
  lines[2] = `M:${meter}`;
  const p = parseScore(lines.join("\n"));
  const vocal = p.voices.Vocal;
  const bpm = p.header.bpm;
  const q = vocal ? quarters(vocal.ticks) : 0;
  return {
    meter,
    problems: p.problems.length,
    bars: vocal ? vocal.bars.length : 0,
    quarters: q,
    nominal_seconds: bpm ? Number(((q * 60) / bpm).toFixed(2)) : null,
  };
}

/**
 * One bar-level defect repeated 152 times is one defect. The full list goes to
 * the parser's own consumers; a tool result carries the first few and a count,
 * because a 153-entry array in an agent's context is 152 entries of noise.
 */
function capProblems(problems, code, keep) {
  const of = problems.filter((p) => p.code === code);
  if (of.length <= keep) return problems;
  let seen = 0;
  const out = [];
  for (const p of problems) {
    if (p.code !== code) { out.push(p); continue; }
    seen += 1;
    if (seen <= keep) out.push(p);
  }
  out.push({
    code: `${code}_summary`,
    where: "the whole score",
    says: `${of.length - keep} further bars carry the same [${code}] defect and are not listed individually.`,
    fix: "Read `diagnosis`: it says whether this is one wrong header or many wrong bars.",
  });
  return out;
}

/**
 * Validate a score and derive its facts. Pure text work: no GPU, no weights,
 * no subprocess, sub-millisecond on the 140-line score this rig has rendered.
 *
 * `ok: true` means the notation parses in the native dialect, every bar holds
 * what its meter claims, the key is a key, the voice declarations are the
 * native ones and the two voices share one grid. It is NOT a claim about the
 * audio — see NOT_ENFORCED.
 */
export function checkScore(text) {
  const parsed = parseScore(text);
  const vocal = parsed.voices.Vocal;
  const ins = parsed.voices.Ins;
  const bpm = parsed.header.bpm;

  const asWritten = vocal ? vocal.ticks : 0;
  const ifHeader = parsed.bars
    .filter((b) => b.voice === "Vocal")
    .reduce((sum, b) => sum + b.claimed_ticks, 0);

  const sections = parsed.sections.map((s, i) => {
    const bars = parsed.bars.filter((b) => b.section === s.name && b.voice === "Vocal"
      && b.group >= s.group && (parsed.sections[i + 1] ? b.group < parsed.sections[i + 1].group : true));
    return {
      index: i + 1,
      name: s.name,
      first_group: s.group,
      bars: bars.length,
      quarters: bars.reduce((sum, b) => sum + b.holds_quarters, 0),
      starts_at_quarter: bars.length ? bars[0].start_quarter : null,
    };
  });

  const nominal = bpm && asWritten ? (quarters(asWritten) * 60) / bpm : null;
  /* The bill, said out loud while the edit is still free. 2.39x realtime is
   * MEASURED, so a five-minute score is a twelve-minute render and an agent
   * about to iterate three times should know that before the first one. */
  if (nominal !== null && nominal > 240) {
    parsed.notices.push(`This score is ${nominal.toFixed(0)} s of nominal music, so a render is `
      + `ESTIMATED at ${Math.round((nominal * MEASURED.realtime_factor) / 60)} minutes on this rig `
      + `(MEASURED ${MEASURED.realtime_factor}x realtime). Iterating on the score is free; iterating on renders is not.`);
  }

  return {
    ok: parsed.ok,
    sha256: sha256(parsed.text),
    bytes: Buffer.byteLength(parsed.text, "utf8"),
    lines: parsed.line_count,
    header: parsed.header,
    facts: {
      bars_per_voice: vocal ? vocal.bars.length : 0,
      /* Counted and reported because they are the reason a wrong header changes
       * this score's LENGTH: a Z is one measure of the current meter, so every
       * one of them stretches when the M: header does. */
      full_measure_rest_bars: parsed.bars.filter((b) => b.body === "Z").length,
      quarters_as_written: quarters(asWritten),
      quarters_if_header_obeyed: quarters(ifHeader),
      nominal_seconds: nominal === null ? null : Number(nominal.toFixed(2)),
      nominal_seconds_if_header_obeyed: bpm && ifHeader
        ? Number(((quarters(ifHeader) * 60) / bpm).toFixed(2)) : null,
      sounding_notes: {
        Vocal: vocal ? vocal.notes.length : 0,
        Ins: ins ? ins.notes.length : 0,
      },
      chord_symbols: vocal ? vocal.chords.length : 0,
      key_changes: vocal ? vocal.keys.map(([t, k]) => ({ at_quarter: quarters(t), key: k })) : [],
      meters_used: [...new Set(parsed.bars.map((b) => b.meter))],
      sections,
    },
    problem_count: parsed.problems.length,
    problems: capProblems(parsed.problems, "bar_beats", 8),
    notices: parsed.notices,
    diagnosis: diagnose(parsed),
    /* An ESTIMATE built from MEASURED ratios, so an agent can see the bill
     * before it decides this edit is worth a render. */
    render_estimate_seconds: nominal === null ? null
      : Math.round(nominal * MEASURED.realtime_factor + MEASURED.load_warm_seconds),
    scope: "Native two-voice dialect structure, exact bar arithmetic, key and voice declarations. "
      + "A refusal can mean \"outside this bounded dialect\" rather than \"invalid ABC\". This makes NO "
      + "claim about the generated audio, about whether the harmony is good, or about whether the model "
      + "will follow the score — it will not necessarily.",
  };
}

/* ─────────────────────────────────────────────────────────── the comparison */

/** A line diff, computed. Small LCS — 140x140 on the real score, nothing to optimise. */
function lineDiff(a, b, cap = 4000) {
  if (a.length > cap || b.length > cap) {
    return { truncated: true, removed: null, added: null, hunks: [] };
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let removed = 0;
  let added = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) { hunks.push({ op: "-", line: i + 1, text: a[i] }); removed += 1; i += 1; }
    else { hunks.push({ op: "+", line: j + 1, text: b[j] }); added += 1; j += 1; }
  }
  while (i < n) { hunks.push({ op: "-", line: i + 1, text: a[i] }); removed += 1; i += 1; }
  while (j < m) { hunks.push({ op: "+", line: j + 1, text: b[j] }); added += 1; j += 1; }
  return { truncated: false, removed, added, hunks: hunks.slice(0, 120), hunks_omitted: Math.max(0, hunks.length - 120) };
}

const firstDifference = (xs, ys) => {
  const common = Math.min(xs.length, ys.length);
  for (let i = 0; i < common; i += 1) if (JSON.stringify(xs[i]) !== JSON.stringify(ys[i])) return i;
  return xs.length === ys.length ? -1 : common;
};

/**
 * What changed between two scores, COMPUTED — never the author's own account
 * of it. An edit note says what somebody meant to do; this says what the bytes
 * did. mcp-videolab.js keeps the same separation between a verdict and a wall
 * time, for the same reason.
 */
export function compareScores(aText, bText) {
  const a = checkScore(aText);
  const b = checkScore(bText);
  const pa = parseScore(aText);
  const pb = parseScore(bText);
  const identical = a.sha256 === b.sha256;

  const voices = {};
  for (const name of NATIVE_VOICES) {
    const na = pa.voices[name]?.notes || [];
    const nb = pb.voices[name]?.notes || [];
    const ca = pa.voices[name]?.chords || [];
    const cb = pb.voices[name]?.chords || [];
    const noteAt = firstDifference(na, nb);
    const chordAt = firstDifference(ca, cb);
    voices[name] = {
      sounding_notes: { a: na.length, b: nb.length },
      notes_identical: noteAt === -1,
      first_differing_note: noteAt === -1 ? null : {
        index: noteAt + 1,
        a: na[noteAt] ? { at_quarter: quarters(na[noteAt][0]), midi: na[noteAt][1], quarters: quarters(na[noteAt][2]) } : null,
        b: nb[noteAt] ? { at_quarter: quarters(nb[noteAt][0]), midi: nb[noteAt][1], quarters: quarters(nb[noteAt][2]) } : null,
      },
      chord_symbols: { a: ca.length, b: cb.length },
      chords_identical: chordAt === -1,
      first_differing_chord: chordAt === -1 ? null : {
        index: chordAt + 1,
        a: ca[chordAt] ? { at_quarter: quarters(ca[chordAt][0]), symbol: ca[chordAt][1] } : null,
        b: cb[chordAt] ? { at_quarter: quarters(cb[chordAt][0]), symbol: cb[chordAt][1] } : null,
      },
    };
  }

  const headerChanges = [];
  for (const key of ["meter", "unit", "bpm", "key"]) {
    if (a.header[key] !== b.header[key]) headerChanges.push({ field: key, a: a.header[key], b: b.header[key] });
  }

  return {
    identical,
    sha256: { a: a.sha256, b: b.sha256 },
    valid: { a: a.ok, b: b.ok },
    header_changes: headerChanges,
    facts: {
      bars: { a: a.facts.bars_per_voice, b: b.facts.bars_per_voice },
      quarters: { a: a.facts.quarters_as_written, b: b.facts.quarters_as_written },
      nominal_seconds: { a: a.facts.nominal_seconds, b: b.facts.nominal_seconds },
      sections: { a: a.facts.sections.map((s) => s.name), b: b.facts.sections.map((s) => s.name) },
    },
    voices,
    text_diff: lineDiff(String(aText ?? "").split("\n"), String(bText ?? "").split("\n")),
    scope: "Exact symbolic difference: bytes, bar grid, sounding notes after merging ties, and the chord "
      + "timeline. It says nothing about which one sounds better, and nothing about whether either "
      + "rendering followed its score.",
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 *                    THE MECHANICAL EDITS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Four edits whose musical work is done HERE, in code, so that the model
 * asking for them only has to name a number. That is what makes them safe for
 * a 4B — and it is also why a frontier model should use them rather than
 * retyping a hundred bars to move one header: a transform that cannot make a
 * transcription error is better than one that probably won't.
 *
 * Each one ends the same way: apply, then RE-CHECK, and refuse to hand back
 * notation that does not validate. A transform that emits a plausible-wrong
 * score is the exact failure this whole file is a reaction to, so it is not
 * allowed to be the transform's own output either.
 */

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

/** Re-collapse runs of full-measure rests, the way the native exporter writes them. */
function collapseZ(bodies) {
  const out = [];
  let run = 0;
  const flush = () => {
    while (run > 0) {
      const take = Math.min(run, 4);
      out.push(take === 1 ? "Z" : `Z${take}`);
      run -= take;
    }
  };
  for (const b of bodies) {
    if (b === "Z") { run += 1; continue; }
    flush();
    out.push(b);
  }
  flush();
  return out;
}

/** Emit groups as native text: section comment, then a V: block per voice, ≤4 bars each. */
function renderGroups(header, groups) {
  const lines = header.slice();
  for (const g of groups) {
    const counts = NATIVE_VOICES.map((n) => g.bodies[n].length);
    const chunks = Math.ceil(Math.max(...counts) / 4);
    for (let c = 0; c < chunks; c += 1) {
      if (c === 0) for (const comment of g.comments || []) lines.push(`% ${comment}`);
      for (const name of NATIVE_VOICES) {
        lines.push(`V: ${name}`);
        if (c === 0) for (const f of g.fields[name] || []) lines.push(f);
        const slice = g.bodies[name].slice(c * 4, c * 4 + 4);
        lines.push(collapseZ(slice).join("|") + "|");
      }
    }
  }
  return lines.join("\n") + "\n";
}

/** The 8 header lines, with one field optionally rewritten. */
function headerLines(text, replace = {}) {
  const lines = String(text).split("\n").slice(0, 8);
  if (replace.meter) lines[2] = `M:${replace.meter}`;
  if (replace.bpm) lines[4] = `Q:1/4=${replace.bpm}`;
  if (replace.key) lines[7] = `K:${replace.key}`;
  return lines;
}

/** Every mechanical op starts here: you cannot re-bar notation that does not add up. */
function requireValid(abc, op) {
  const check = checkScore(abc);
  if (!check.ok) {
    refuse(`Refusing to apply the ${op} edit: the SOURCE score does not validate, so any transform of it `
      + `would be arithmetic on a mistake. ${check.problem_count} problem(s), first: `
      + `${check.problems[0].code} at ${check.problems[0].where} — ${check.problems[0].says}`
      + (check.diagnosis ? ` ${check.diagnosis}` : "")
      + " Fix the source first (score_check tells you which side is wrong), then repeat this edit.");
  }
  return check;
}

/** The re-check every op ends with. */
function requireProduced(abc, op) {
  const after = checkScore(abc);
  if (!after.ok) {
    refuse(`The ${op} transform produced notation that does not validate, so nothing was written. `
      + `This is a defect in the transform, not in your request — report it with the version id. `
      + `First problem: ${after.problems[0].code} at ${after.problems[0].where} — ${after.problems[0].says}`);
  }
  return after;
}

/** TEMPO. The one edit with no notation consequence at all — and a real cost one. */
function opTempo(input) {
  const { abc } = input;
  const before = requireValid(abc, "tempo");
  const bpm = Number(input.bpm);
  if (!Number.isInteger(bpm) || bpm < 20 || bpm > 400) {
    refuse(`Refusing: bpm must be a whole number between 20 and 400 (the header is Q:1/4=<integer>), not ${JSON.stringify(input.bpm)}.`);
  }
  if (bpm === before.header.bpm) {
    refuse(`Refusing: the score is already at Q:1/4=${bpm}. An edit that changes nothing still costs a version and invites a render.`);
  }
  const lines = String(abc).split("\n");
  lines[4] = `Q:1/4=${bpm}`;
  const out = lines.join("\n");
  const after = requireProduced(out, "tempo");
  return {
    abc: out,
    changed: [`Q:1/4=${before.header.bpm} → Q:1/4=${bpm}`],
    consequence: `Not one note moved — the bar grid is identical (${after.facts.quarters_as_written} quarters either way). `
      + `What changes is the CLOCK: nominal length ${before.facts.nominal_seconds} s → ${after.facts.nominal_seconds} s, `
      + `so the render estimate moves ${before.render_estimate_seconds} s → ${after.render_estimate_seconds} s `
      + `(ESTIMATED from the MEASURED ${MEASURED.realtime_factor}x realtime).`,
    also: "The style prompt probably names a tempo in words. The model reads both; if they disagree it is "
      + "not defined which one wins. Change the words too.",
  };
}

/**
 * METER — the re-barring one, and the reason this module exists.
 *
 * The confessed defect: M:2/4 was changed to M:4/4 and the content was left
 * alone, producing 122 half-full bars that render and engrave wrongly. A
 * header rewrite is NOT a meter change. This does the re-barring, or refuses.
 *
 * Integer relations only: merge k old bars into one new one, or split one old
 * bar into k. 2/4 into 6/8 is a musical decision — where the beats go — and
 * this will not guess at it.
 */
function opMeter(input) {
  const { abc } = input;
  const before = requireValid(abc, "meter");
  const target = parseMeter(String(input.meter || ""));
  if (!target) {
    refuse(`Refusing: ${JSON.stringify(input.meter)} is not a meter this dialect can express. `
      + "Write an explicit fraction whose denominator is a power of two up to 1024, e.g. \"4/4\", \"3/4\", \"6/8\", \"7/8\".");
  }
  if (before.facts.meters_used.length !== 1) {
    refuse(`Refusing: this score already changes meter (${before.facts.meters_used.join(", ")}), and mechanical `
      + "re-barring handles a single uniform meter only. Re-bar it by hand, or ask the frontier tier — "
      + "moving a meter change is a musical decision about where the beats land.");
  }
  const parsed = parseScore(abc);
  const denom = before.header.unit_denominator;
  const oldTicks = barTicks(parseMeter(before.facts.meters_used[0]));
  const newTicks = barTicks(target);
  if (oldTicks === newTicks) {
    refuse(`Refusing: M:${before.header.meter} and M:${target.n}/${target.d} are the same bar length, so this would `
      + "rewrite the header and change nothing about the music. If that is genuinely what you want, say so in "
      + "an explicit score_edit with a note explaining why — it is the edit that produced this rig's broken parent score.");
  }

  const groups = parsed.groups.map((g) => ({ ...g, bodies: { ...g.bodies }, comments: g.comments.slice() }));

  if (newTicks % oldTicks === 0) {
    const k = newTicks / oldTicks;
    for (const g of groups) {
      for (const name of NATIVE_VOICES) {
        if (g.bodies[name].length % k !== 0) {
          refuse(`Refusing: group ${g.index}${g.section ? ` (% ${g.section})` : ""} has ${g.bodies[name].length} bars of `
            + `M:${before.header.meter}, which does not divide into whole bars of M:${target.n}/${target.d} (${k} old per new). `
            + "Merging across the group boundary would move a section edge, which is a structural decision this tool "
            + "will not make. Adjust that group's length first, or re-bar by hand.");
        }
        const merged = [];
        for (let i = 0; i < g.bodies[name].length; i += k) {
          const chunk = g.bodies[name].slice(i, i + k);
          if (chunk.every((b) => b === "Z")) { merged.push("Z"); continue; }
          const parts = chunk.map((b) => {
            if (b !== "Z") return b;
            const r = restTokens(oldTicks, denom);
            if (!r) refuse(`Refusing: a full-measure rest in group ${g.index} cannot be written as explicit rests at L:1/${denom}.`);
            return r;
          });
          merged.push(parts.join(""));
        }
        g.bodies[name] = merged;
      }
    }
  } else if (oldTicks % newTicks === 0) {
    const k = oldTicks / newTicks;
    const expandedBars = groups.reduce((sum, g) => sum + g.bodies.Vocal.length + g.bodies.Ins.length, 0) * k;
    if (!Number.isSafeInteger(k) || !Number.isSafeInteger(expandedBars) || expandedBars > MAX_EXPANDED_BARS) {
      refuse(`Refusing: this meter change would expand beyond ${MAX_EXPANDED_BARS} bars. Use a smaller arrangement or a less extreme meter change.`);
    }
    for (const g of groups) {
      for (const name of NATIVE_VOICES) {
        const split = [];
        g.bodies[name].forEach((body, barIdx) => {
          if (body === "Z") { for (let i = 0; i < k; i += 1) split.push("Z"); return; }
          const { tokens, errors } = tokenizeBar(body, denom);
          if (errors.length) refuse(`Refusing: group ${g.index}, ${name}, bar ${barIdx + 1} did not tokenise (${errors[0]}).`);
          const pieces = Array.from({ length: k }, () => []);
          for (const t of tokens) {
            const piece = Math.floor(t.at / newTicks);
            if (t.kind === "chord" || t.kind === "key") { pieces[piece].push(t.text); continue; }
            let at = t.at;
            let left = t.ticks;
            let first = true;
            while (left > 0) {
              const p = Math.floor(at / newTicks);
              const room = (p + 1) * newTicks - at;
              const take = Math.min(room, left);
              const units = ticksToUnits(take, denom);
              if (!Number.isInteger(units)) {
                refuse(`Refusing: group ${g.index}, ${name}, bar ${barIdx + 1} cannot be cut on the new barline at `
                  + `L:1/${denom} without a duration this dialect has no name for.`);
              }
              const head = t.kind === "rest" ? "z" : (first ? t.acc : "") + t.letter + t.oct;
              /* A rest may be divided freely; a NOTE crossing the new barline
               * needs a tie, and the continuation is written WITHOUT its
               * accidental on purpose: an unmarked continuation retains the
               * tied pitch (abc-editing.md), while repeating the accidental
               * would also set the new bar's accidental state and silently
               * alter later untied notes in it. The note-identity compare
               * below is what proves this came out right. */
              const moreToCome = left - take > 0;
              const text = durationTokens(units, head, { tie: t.kind === "note" && (moreToCome || t.tie) });
              if (!text) refuse(`Refusing: ${units} units is not expressible in this dialect.`);
              pieces[p].push(text);
              at += take;
              left -= take;
              first = false;
            }
          }
          for (const p of pieces) {
            if (!p.length) {
              refuse(`Refusing: splitting group ${g.index}, ${name}, bar ${barIdx + 1} into M:${target.n}/${target.d} `
                + "leaves an empty measure, which means the content does not reach the new barline.");
            }
            split.push(p.join(""));
          }
        });
        g.bodies[name] = split;
      }
    }
  } else {
    refuse(`Refusing: M:${before.header.meter} into M:${target.n}/${target.d} is not an integer re-barring `
      + `(${quartersLabel(oldTicks)} quarters per bar into ${quartersLabel(newTicks)}). Where the beats go in that `
      + "change is a musical decision, not a mechanical one — it belongs to the frontier tier writing an explicit "
      + "score_edit, or to a person. Nothing was written.");
  }

  const out = renderGroups(headerLines(abc, { meter: `${target.n}/${target.d}` }), groups);
  const after = requireProduced(out, "meter");

  /* PROVE IT. The bar grid is supposed to change and the music is not, so the
   * note and chord timelines are compared rather than asserted — and a
   * transform that moved a note refuses instead of shipping. */
  const diff = compareScores(abc, out);
  const moved = NATIVE_VOICES.filter((n) => !diff.voices[n].notes_identical || !diff.voices[n].chords_identical);
  if (moved.length) {
    refuse(`The meter transform moved the music in ${moved.join(" and ")}, which it must never do, so nothing was `
      + `written. First difference: ${JSON.stringify(diff.voices[moved[0]].first_differing_note || diff.voices[moved[0]].first_differing_chord)}. `
      + "Report this with the version id.");
  }
  return {
    abc: out,
    changed: [`M:${before.header.meter} → M:${target.n}/${target.d}`,
      `${before.facts.bars_per_voice} bars → ${after.facts.bars_per_voice} bars per voice`],
    consequence: `The music is byte-for-byte the same music: ${after.facts.sounding_notes.Vocal} Vocal and `
      + `${after.facts.sounding_notes.Ins} Ins sounding notes at the same onsets, and the same `
      + `${after.facts.chord_symbols} chord symbols at the same times — VERIFIED by comparing the two note `
      + "timelines, not asserted. Only the barlines moved.",
    also: "A meter change also changes what the style prompt should say about the groove. The prompt is words; "
      + "nothing reconciles it with the score for you.",
  };
}

/**
 * DROP AN INSTRUMENT from the style prompt. Text surgery on the prose, with
 * exactly what came out reported verbatim.
 *
 * ⚠ And the honest part: this removes a REQUEST, not a sound. The style prompt
 * is a generative ask; the vendor is explicit that richer voicings asked for
 * in the prompt "remain a generative request, not a guarantee"
 * (abc-editing.md). Removing the word makes the cello less likely on the next
 * render. It does not remove the cello from the render you already have, and
 * if the Ins voice is carrying that line the notes are still in the score.
 */
function opDropInstrument(input) {
  const style = String(input.style ?? "");
  const word = String(input.instrument ?? "").trim();
  if (!word) refuse("Refusing: name the instrument to drop.");
  if (!style.trim()) refuse("Refusing: this version has no style prompt to edit.");
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (!re.test(style)) {
    refuse(`Refusing: "${word}" does not appear in the style prompt, so nothing would be removed and you would `
      + `be told it worked. The prompt is: ${JSON.stringify(style.slice(0, 300))}${style.length > 300 ? "…" : ""}`);
  }
  const sentences = style.split(/(?<=[.!?])\s+/);
  const removed = [];
  const kept = [];
  for (const s of sentences) {
    if (!re.test(s)) { kept.push(s); continue; }
    /* A sentence that lists several instruments loses only the item that names
     * this one — dropping "piano, rounded electric bass, restrained drums"
     * whole would quietly remove the bass and the drums as well. */
    const items = s.split(/,\s*/);
    if (items.length > 1 && items.filter((it) => re.test(it)).length < items.length) {
      const survivors = items.filter((it) => !re.test(it));
      items.filter((it) => re.test(it)).forEach((it) => removed.push(it));
      kept.push(survivors.join(", "));
    } else {
      removed.push(s);
    }
  }
  const out = kept.join(" ").replace(/\s+/g, " ").trim();
  if (!out) refuse(`Refusing: removing "${word}" would empty the style prompt. Rewrite it instead.`);
  return {
    style: out,
    changed: [`removed ${removed.length} clause(s) naming "${word}"`],
    removed_verbatim: removed,
    consequence: `The style prompt is now ${out.length} characters, was ${style.length}.`,
    also: "⚠ This removed a REQUEST, not a sound. The prompt is a generative ask, so the instrument may still "
      + "appear; and nothing changes at all until the next render. If the Ins voice of the score is playing that "
      + "line, the notes are still there — dropping the word from the prompt does not delete a melody.",
  };
}

/**
 * REORDER OR REPEAT SECTIONS. Whole `% name` blocks, moved as units.
 *
 * ⚠ The lyrics do NOT move with them. Lyrics are a separate free-text field
 * and YuE2 aligns them itself; repeating the chorus in the score does not
 * repeat the chorus words. That has to be done in the lyrics too, by hand.
 */
function opSections(input) {
  const { abc } = input;
  const before = requireValid(abc, "sections");
  const parsed = parseScore(abc);
  const order = input.order;
  if (!Array.isArray(order) || !order.length) {
    refuse("Refusing: `order` must be a non-empty array of 1-based section numbers, as score_get lists them. "
      + "Repeats are allowed ([1,2,3,2]); omissions are allowed ([1,3]).");
  }
  const sections = before.facts.sections;
  if (!sections.length) {
    refuse("Refusing: this score has no `% name` section comments, so it has no sections to reorder. "
      + "Add them with an explicit score_edit first.");
  }
  for (const n of order) {
    if (!Number.isInteger(n) || n < 1 || n > sections.length) {
      refuse(`Refusing: ${JSON.stringify(n)} is not one of this score's ${sections.length} sections `
        + `(1-${sections.length}: ${sections.map((s, i) => `${i + 1} ${s.name}`).join(", ")}).`);
    }
  }
  /* Groups before the first section comment belong to no section and stay
   * where they are — they are the score's own upbeat, not a movable block. */
  const firstSectionGroup = sections[0].first_group;
  const prelude = parsed.groups.filter((g) => g.index < firstSectionGroup);
  const blocks = sections.map((s, i) => {
    const nextGroup = sections[i + 1] ? sections[i + 1].first_group : Infinity;
    return parsed.groups.filter((g) => g.index >= s.first_group && g.index < nextGroup);
  });
  const groups = [...prelude, ...order.flatMap((n) => blocks[n - 1])]
    .map((g) => ({ ...g, bodies: { ...g.bodies }, comments: g.comments.slice() }));

  const out = renderGroups(headerLines(abc), groups);
  let after;
  try {
    after = requireProduced(out, "sections");
  } catch (err) {
    /* The seam is where this breaks: a section that ends on an unresolved tie,
     * spliced against a different section, is a tie that changes pitch. The
     * refusal names it rather than shipping a score that engraves wrongly. */
    refuse(`${err.message} A section seam is the usual cause: a block ending on a tie, now followed by a `
      + "different block. Resolving that tie is a musical decision — hand this ordering to the frontier tier "
      + "as an explicit score_edit.");
  }
  return {
    abc: out,
    changed: [`${sections.map((s) => s.name).join(" → ")}  BECOMES  ${order.map((n) => sections[n - 1].name).join(" → ")}`,
      `${before.facts.bars_per_voice} bars → ${after.facts.bars_per_voice} bars per voice`],
    consequence: `Nominal length ${before.facts.nominal_seconds} s → ${after.facts.nominal_seconds} s, so the render `
      + `estimate moves ${before.render_estimate_seconds} s → ${after.render_estimate_seconds} s `
      + `(ESTIMATED from the MEASURED ${MEASURED.realtime_factor}x realtime).`,
    also: "⚠ THE LYRICS DID NOT MOVE. They are a separate field the model aligns itself, so a repeated chorus "
      + "section does not repeat the chorus words — edit the lyrics to match, or the extra chorus will be sung "
      + "with whatever text falls there.",
  };
}

/**
 * Every /api/score action these tools post, split by whether it exists yet.
 *
 * Exported so the gap is a value rather than a paragraph: the test asserts no
 * tool posts anything outside this union, and the HANDOFF cites it rather than
 * listing the actions again in prose that can drift. When `required` empties,
 * this surface is fully wired.
 */
export const ROUTE_ACTIONS = {
  /* Dispatched today — server/score/routes.js:256. */
  existing: ["list", "read", "to_daw", "export_midi"],
  /* NOT dispatched yet, and neither can be folded into an existing one:
   *  draft  — `adopt` (routes.js:305) requires `dir`, a finished vendor run
   *           folder verified against result.json's own sha256 map. An edit
   *           that has not been rendered has no receipt by definition, so it
   *           cannot be adopted; it is a version with a parent, a verbatim
   *           note and a check verdict, and no artifacts.
   *  render — the bridge to server/music/yue.js. It belongs on the score
   *           because the version is what is being rendered: their doc already
   *           carries a `runs` array, and their `adopt` already takes `parent`,
   *           so the finished folder lands as a child of the draft it came
   *           from and the lineage joins with nothing new invented. */
  required: ["draft", "render"],
};

/** The four mechanical ops, exported so the local chat tier calls these and not a copy. */
export const MECHANICAL = {
  tempo: opTempo,
  meter: opMeter,
  drop_instrument: opDropInstrument,
  sections: opSections,
};

/** The set the local Qwen3-4B tier gets. The reasoning is in the tier note above. */
export const LOCAL_TIER_OPS = ["tempo", "meter", "drop_instrument", "sections"];

/**
 * Apply one mechanical op. Returns {abc?, style?, changed[], consequence, also}
 * or throws a Refusal whose message is the whole explanation.
 */
export function applyMechanical(op, input) {
  const fn = MECHANICAL[op];
  if (!fn) {
    refuse(`Refusing: "${op}" is not a mechanical op. The four are ${LOCAL_TIER_OPS.join(", ")}. `
      + "Anything else — reharmonising, rewriting a melody, changing a key — is a full score_edit: write the "
      + "ABC yourself and let score_check prove it.");
  }
  return fn(input);
}

/* ─────────────────────────────────────────────── the two content refusals */

/**
 * Bracketed section labels in lyrics.
 *
 * ⚠ THE VENDOR'S OWN ASSET DISAGREES WITH THIS GUARD and it is overruled on
 * purpose: skills/yue2-music/assets/prompt.json ships lyrics beginning
 * "[Verse]". Against that, MEASURED on this rig: three MiniMax tracks were
 * rejected for audibly singing "[verse]", one of them running 202 s instead
 * of 64 s while carrying them; and the request that produced this rig's only
 * YuE2 song (run_fixed/request.json) used blank-line stanzas, no brackets,
 * and came back clean at 167.0 s. The measurement wins over the sample file.
 */
export function lyricRefusal(lyrics) {
  const text = String(lyrics ?? "");
  const hits = [...text.matchAll(/\[[^\]\n]{0,60}\]/g)].map((m) => m[0]);
  if (!hits.length) return null;
  const unique = [...new Set(hits)];
  return `Refusing: the lyrics carry ${hits.length} bracketed label(s) — ${unique.slice(0, 6).join(", ")}`
    + `${unique.length > 6 ? `, and ${unique.length - 6} more` : ""} — and the model SINGS them. ${NO_BRACKETS} `
    + "Nothing was written and no render was started. Delete the brackets and separate sections with a blank line.";
}

/**
 * An audio reference asked for in any spelling.
 *
 * The schemas below are closed, but MCP's tools/call does not validate them —
 * server/mcp.js hands `params.arguments` straight to run() — so a closed
 * schema is advice until something checks. This is the check, and it exists
 * because "no audio conditioning" is the single most likely thing for an
 * agent to assume it has: every other engine in this studio takes a reference.
 */
export function audioReferenceRefusal(args) {
  const offending = Object.keys(args || {}).filter((k) =>
    /audio|reference|ref_|singer|voice_?clone|phoneme|negative|continue_from/i.test(k));
  if (!offending.length) return null;
  return `Refusing: this tool was given ${offending.join(", ")}, and no such conditioning exists. `
    + `${NO_AUDIO_REFERENCE} If you want a particular voice, describe it in the style prompt in words; if you `
    + "want to continue an existing track, that is music_input_prepare on the other engine, not this one.";
}

/* ══════════════════════════════════════════════════════════════════════════
 *                    THE MCP SURFACE
 * ══════════════════════════════════════════════════════════════════════════ */

export function scoreTools(api) {
  /**
   * One POST, the actions server/score/routes.js:256 dispatches.
   *
   * Its own errors are thrown strings, which api() in server/mcp.js turns back
   * into a thrown Error — so a refusal written there arrives here as a refusal,
   * unedited. Nothing in this file paraphrases one.
   */
  const score = async (body) => {
    const r = await api("POST", "/api/score", body);
    if (r.error) throw new Error(r.error);
    return r;
  };

  /**
   * Read ONE version of one score.
   *
   * The store is SLUG-SCOPED (routes.js:232 `const slug = b.slug ? …`, and
   * load() throws "Which score? Pass `slug`." for every action), so a version
   * id on its own does not address anything. `version` omitted means the
   * score's `current` (routes.js:242 pick()), which is the behaviour a person
   * expects from "the score" and the one an agent should not have to ask for.
   *
   * Their versionView (routes.js:99) is the row shape: it already carries the
   * note verbatim, the receipt in `timing`, the artifact sha256 map, and
   * `changed` computed from hashes rather than declared. This function adapts
   * names and adds nothing — where a field exists over there, it is used.
   */
  const readVersion = async (slug, id) => {
    if (!String(slug || "").trim()) {
      throw new Error("Refusing: which score? Pass `score` — the slug, as score_get with no arguments "
        + "lists them. The store holds one folder per song, and a version id alone does not say which.");
    }
    const r = await score({ action: "read", slug, version: id || undefined, scores: true });
    const row = (r.versions || [])[0];
    if (!row) {
      throw new Error(`No version ${id ? `"${id}" ` : ""}in "${slug}". `
        + "score_get with just `score` lists the ones it has.");
    }
    return { doc: r.score, row, capability: r.capability };
  };

  /** The ABC text of a row, refusing clearly when the read came back without it. */
  const abcOf = (row, slug) => {
    const abc = row.score?.text ?? row.abc ?? null;
    if (typeof abc !== "string" || !abc.trim()) {
      throw new Error(`Version "${row.id}" of "${slug}" came back without its ABC TEXT, so there is nothing `
        + "to check or edit. Their `read` returns a DERIVED view of the score — headers, bars, sections, "
        + "invariants — and deliberately not the bytes (server/score/routes.js:140), which is right for a "
        + "sheet and impossible for an editor. The store has to return the text on request; until it does, "
        + "pass `abc` to score_check directly. Nothing here can work around it — an editor without the bytes "
        + "is guessing.");
    }
    return abc;
  };

  return [
    {
      name: "score_get",
      description:
        "READ A SCORE. Returns one version's ABC verbatim plus everything derivable from it, computed here "
        + "rather than stored: tempo, meter, key, the two voice names, the `% verse`/`% chorus` sections with "
        + "their bar counts and numbers (those numbers are what score_mechanical's `sections` op takes), the "
        + "sounding-note count per voice after merging ties, the chord-symbol count, any key changes, the "
        + "nominal length in seconds, and its parent version with the editing note whoever wrote it left.\n\n"
        + "THREE DEPTHS, because the store keeps one folder per song: with NO arguments it lists the scores on "
        + "this machine; with a `score` slug it lists that score's versions, their parents, their notes and the "
        + "worst invariant each one carries, so you can see the tree; with a slug AND a `version` it reads that "
        + "one. A version id on its own addresses nothing, and saying so is cheaper than a 404.\n\n"
        + "IT ALSO CHECKS. Every version comes back with its score_check verdict attached, because a version "
        + "can be INVALID and still be in the store: the score that produced this rig's only YuE2 render is "
        + "one — M:4/4 in the header over 122 bars that each hold two quarter notes, an M:2/4 score that was "
        + "re-headered without re-barring. Read `check.ok` before you build on a version; if it is false, "
        + "`check.diagnosis` says which side of the file is wrong.\n\n"
        + NOT_ENFORCED + "\n\n"
        + "CANNOT: it cannot show you the music. A score is not something you can hear, and the two derived "
        + "note counts are not a melody — to judge how something sounds, render it and use score_compare.",
      inputSchema: {
        type: "object",
        properties: {
          score: { type: "string", description: "The score's slug — one folder per song. Omit EVERYTHING to list the scores on this machine." },
          version: { type: "string", description: "A version id within that score. Omit to read the score's `current` version, which is what a person means by \"the score\"." },
          limit: { type: "integer", description: "When listing versions. Default 20." },
        },
        additionalProperties: false,
      },
      async run(a) {
        /* THREE DEPTHS, ONE TOOL, because the store is a folder per song and a
         * version id alone does not address anything (server/score/routes.js
         * load(): "Which score? Pass `slug`."). No arguments lists the songs;
         * a slug lists its versions; a slug and a version reads one. */
        if (!a.score) {
          const r = await score({ action: "list" });
          return {
            scores: (r.scores || []).slice(0, Math.max(1, Number(a.limit) || 20)),
            engraver: r.capability ?? null,
            note: "Pass one of these slugs as `score` to see its versions.",
          };
        }
        if (!a.version) {
          const r = await score({ action: "read", slug: a.score, scores: false });
          return {
            score: r.score?.slug, title: r.score?.title, current: r.score?.current,
            /* How many SONGS are in the folder, which a version count does not
             * say — their read already computes it (routes.js `roots`). */
            distinct_roots: r.roots ?? null,
            versions: (r.versions || []).slice(0, Math.max(1, Number(a.limit) || 20)).map((v) => ({
              version: v.id, parent: v.parent || null, at: v.at, label: v.label ?? null,
              by: v.by ?? null, author: v.author ?? null,
              note_as_written_by_its_author: v.note ?? null,
              status: v.status ?? null, audio_seconds: v.audioSeconds ?? null,
              worst_invariant: v.score?.worst ?? null,
            })),
            recent_runs: r.score?.runs ?? null,
          };
        }
        const { doc, row } = await readVersion(a.score, a.version);
        const abc = abcOf(row, a.score);
        const check = checkScore(abc);
        return {
          score: doc?.slug ?? a.score, version: row.id, parent: row.parent || null,
          children: row.children ?? null, root: row.root ?? null,
          at: row.at, by: row.by ?? null, author: row.author ?? null,
          /* Verbatim, and labelled as a claim. What somebody MEANT by an edit
           * and what the bytes DID are two different records — score_compare
           * computes the second, and their store says `noteVerbatim` for the
           * same reason. */
          note_as_written_by_its_author: row.note ?? null,
          abc,
          style: row.style ?? null,
          lyrics: row.lyrics ?? null,
          cot: row.cot ?? "full",
          check: {
            ok: check.ok, sha256: check.sha256, bytes: check.bytes,
            problem_count: check.problem_count,
            problems: check.problems, notices: check.notices, diagnosis: check.diagnosis,
          },
          header: check.header,
          facts: check.facts,
          render_estimate_seconds: check.render_estimate_seconds,
          /* The render's own receipt, where there is one — every number in
           * these descriptions came out of one of these. */
          rendered: row.status ? {
            status: row.status, audio_seconds: row.audioSeconds ?? null,
            sample_rate: row.sampleRate ?? null, truncated: row.truncated ?? null,
            timing: row.timing ?? null, identity: row.identity ?? null,
            artifacts: row.artifacts ?? null, verified: row.verified ?? null,
          } : null,
          sheet: row.sheet ?? null,
          changed_from_parent: row.changed ?? null,
        };
      },
    },

    {
      name: "score_check",
      description:
        "⚠ THE MOST IMPORTANT TOOL HERE, AND THE CHEAPEST. Validate an ABC score WITHOUT rendering: does it "
        + "parse in YuE2's bounded two-voice dialect; does every bar hold exactly the beats its M: header "
        + "claims; is the key a key; are the two V: declarations still the native ones byte for byte; are both "
        + "voices on one time grid. Pure text work — no GPU, no weights, no model load, under a millisecond on "
        + "a 140-line score.\n\n"
        + "WHY IT MATTERS MORE THAN IT SOUNDS. Nothing downstream will catch a bad edit: the vendor's own skill "
        + "says the tooling does not force the generator to follow the score, so a mis-barred file renders, "
        + "returns audio, and engraves wrongly. That is not hypothetical — the score that produced this rig's "
        + "only YuE2 song has M:4/4 over 122 bars of two quarter notes each, and it came back as 167.0 s of "
        + "perfectly ordinary-sounding music. MEASURED, and this is the number that matters: as written those "
        + "bars are 162.67 s, under the 4/4 header they would be 325.33 s, and the audio was 167.04 s. The model "
        + "followed the bars and ignored the header. A header/content disagreement is a lie about what you are "
        + "about to hear, not a cosmetic slip.\n\n"
        + "IT SAYS WHICH SIDE IS WRONG. `diagnosis` is the field to read. All the bars short by the same amount "
        + "means the HEADER is wrong and one character fixes it; one bar short means that BAR is wrong and needs "
        + "re-barring. A parser that stops at the first failure reports those two identically, which is how the "
        + "second one gets 'fixed' by breaking the first.\n\n"
        + "WHAT IT REFUSES, deliberately, rather than guessing at the timing: tuplets, grace notes, stacked "
        + "chords, repeats and alternate endings, slurs, broken rhythms, decorations, w: lyric lines, non-native "
        + "chord qualities (Cmaj9, C13, A7alt are not in the vocabulary) and custom voices. A refusal can mean "
        + "\"outside this bounded dialect\" rather than \"invalid ABC\" — the result's own `scope` says so.\n\n"
        + FREE_VS_PAID + " Run this before every render; it is free and the render is not.\n\n"
        + NOT_ENFORCED + "\n\n"
        + "CANNOT: it cannot tell you whether the music is any good, whether the harmony works, whether the "
        + "lyrics fit the notes, or whether the render will sound like the page. It is an arithmetic and "
        + "structure check. Those are ears.",
      inputSchema: {
        type: "object",
        properties: {
          abc: { type: "string", description: "The full ABC text to check. Pass this for an edit you have not stored yet, which is the whole point — check before you write, write before you render." },
          score: { type: "string", description: "Check a STORED version instead: the score's slug." },
          version: { type: "string", description: "With `score`, which version. Omit for that score's current one." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const text = a.abc ?? (a.score ? abcOf((await readVersion(a.score, a.version)).row, a.score) : null);
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("Refusing: pass `abc` (the full score text) or `score` (a stored slug). "
            + "There is nothing to check without one.");
        }
        return checkScore(text);
      },
    },

    {
      name: "score_edit",
      description:
        "WRITE A NEW VERSION from an edited score, with a parent pointer and your note recorded verbatim. This "
        + "is the frontier-model door: you supply the whole ABC text, so you can reharmonise, rewrite a melody, "
        + "change a key, or move one chord. Optionally sets the style prompt and the lyrics in the same version, "
        + "because a reharmonisation whose style prompt still says the old thing is half an edit.\n\n"
        + "IT CALLS score_check FIRST AND REFUSES ON A FAILED INVARIANT. Nothing is written and no GPU is "
        + "touched: you get the problems and the diagnosis back instead of a version id. That order is the whole "
        + "design — a render costs " + MEASURED.e2e_seconds + " s MEASURED and this check costs under a "
        + "millisecond, so an invalid score must not be able to reach one. It also refuses an edit that changes "
        + "nothing (same bytes, same style, same lyrics), because such a version exists only to invite a render.\n\n"
        + "THE PARENT MAY ITSELF BE INVALID. score_get tells you; the store holds the as-rendered score exactly "
        + "as it was, defect included. Inheriting from it means inheriting the defect, so check the parent before "
        + "you diff against it.\n\n"
        + NO_BRACKETS + "\n\n"
        + NO_AUDIO_REFERENCE + "\n\n"
        + NOT_ENFORCED + " So write the score AND say the same thing in the style prompt: the two are read "
        + "together and nothing reconciles them for you.\n\n"
        + FREE_VS_PAID + "\n\n"
        + "CANNOT: it does not render (score_render does, deliberately as a separate act). It cannot express "
        + "anything outside the bounded dialect — no tuplets, no chord voicings, no extended jazz symbols; "
        + "Cmaj9 and C13 are not native and will be refused, so pick a supported core and describe the voicing "
        + "in the style prompt, where it is a request rather than a guarantee. And for a purely mechanical "
        + "change — tempo, meter, dropping an instrument from the prompt, reordering sections — use "
        + "score_mechanical instead: it does the re-barring in code and cannot make a transcription error.",
      inputSchema: {
        type: "object",
        required: ["score", "abc", "note"],
        properties: {
          score: { type: "string", description: "The score's slug — which song this is a version of." },
          abc: { type: "string", description: "The complete edited score. Not a patch — the whole file, header included." },
          note: { type: "string", description: "What you changed and why, in a sentence a person reading this in a month can act on. Recorded verbatim and attributed to you; it is a claim about intent, while score_compare computes what actually changed." },
          parent: { type: "string", description: "The version this was edited from. Defaults to the score's current one. Recorded as the parent pointer, so the lineage joins." },
          style: { type: "string", description: "Replace the style prompt. Omit to inherit the parent's. Tempo and meter live in the SCORE; this is for sound, voice and arrangement, in words." },
          lyrics: { type: "string", description: "Replace the lyrics. Omit to inherit the parent's. Blank lines between sections, and NO bracketed labels — the model sings them." },
          cot: { type: "string", enum: ["full", "melody"], description: "Which conditioning the render will use. \"full\" for a score with chord symbols (the normal case for an edit); \"melody\" for a chord-free melody score, as a cover. \"off\" is not offered here: it ignores the score entirely, which makes this whole surface pointless." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const bad = audioReferenceRefusal(a);
        if (bad) throw new Error(bad);
        if (typeof a.abc !== "string" || !a.abc.trim()) {
          throw new Error("Refusing: `abc` must be the complete edited score, header and all. This tool takes a "
            + "whole file rather than a patch, because a patch cannot be checked.");
        }
        if (!String(a.note || "").trim()) {
          throw new Error("Refusing: `note` is required. A version with no note is a fork nobody can read back, "
            + "and this store exists so that six renders leave behind six decisions.");
        }
        const lyricBad = a.lyrics === undefined ? null : lyricRefusal(a.lyrics);
        if (lyricBad) throw new Error(lyricBad);

        /* THE CHECK, BEFORE THE WRITE AND LONG BEFORE THE GPU. */
        const check = checkScore(a.abc);
        if (!check.ok) {
          throw new Error(
            `Refusing to write this version: the score fails ${check.problem_count} invariant(s), so nothing `
            + "was stored and no render was started.\n"
            + check.problems.slice(0, 8).map((p) => `  • [${p.code}] ${p.where}: ${p.says}${p.fix ? ` → ${p.fix}` : ""}`).join("\n")
            + (check.problem_count > 8 ? `\n  • …and ${check.problem_count - 8} more` : "")
            + (check.diagnosis ? `\n\n${check.diagnosis}` : "")
            + `\n\nA render costs ${MEASURED.e2e_seconds} s MEASURED; this check cost under a millisecond. Fix the `
            + "score and call again — score_check as often as you like, it is free.");
        }

        const { row: parent } = await readVersion(a.score, a.parent);
        const parentAbc = abcOf(parent, a.score);
        const style = a.style === undefined ? parent.style : a.style;
        const lyrics = a.lyrics === undefined ? parent.lyrics : a.lyrics;
        if (check.sha256 === sha256(parentAbc) && style === parent.style && lyrics === parent.lyrics) {
          throw new Error(`Refusing: this is byte-identical to ${parent.id} — same score, same style, same lyrics. `
            + "A version that changes nothing costs a row and invites somebody to spend "
            + `${MEASURED.e2e_seconds} s of GPU proving it. If you meant to re-render the same score with a `
            + "different seed, that is score_render with `seed`.");
        }
        /* The inherited lyrics get the same guard: the parent may predate it. */
        const inheritedBad = a.lyrics === undefined ? lyricRefusal(lyrics) : null;
        if (inheritedBad) throw new Error(`${inheritedBad} (These lyrics came from the parent version ${parent.id}; `
          + "pass `lyrics` explicitly to fix them in this edit.)");

        /* `draft` and not `adopt`: their adopt (routes.js:305) requires `dir`,
         * a finished vendor run folder verified against result.json's own
         * sha256 map, which by definition an un-rendered edit does not have.
         * A draft is a version with a parent, a verbatim note and a check
         * verdict, and no receipt — the row the render later attaches to. */
        const r = await score({
          action: "draft", slug: a.score, abc: a.abc, note: a.note, parent: parent.id,
          style, lyrics, cot: a.cot || parent.cot || "full",
          check: { ok: true, sha256: check.sha256 },
        });
        return {
          score: a.score,
          version: r.version?.id ?? r.version,
          parent: parent.id,
          sha256: check.sha256,
          check_passed: true,
          header: check.header,
          facts: check.facts,
          notices: check.notices,
          changed: compareScores(parentAbc, a.abc),
          render_estimate_seconds: check.render_estimate_seconds,
          note: `Written, nothing rendered. score_render on this version spends the GPU; ESTIMATED `
            + `${check.render_estimate_seconds} s for this score, from the MEASURED `
            + `${MEASURED.realtime_factor}x realtime.`,
        };
      },
    },

    {
      name: "score_mechanical",
      description:
        "THE FOUR EDITS THAT DO NOT NEED A MODEL TO WRITE ABC. Each one is a code transform over the score or "
        + "the style prompt, so the caller names a number and the notation work is done here, correctly, every "
        + "time. Writes a new version exactly as score_edit does — same check, same parent pointer, same refusals.\n\n"
        + "  • tempo — rewrite Q:1/4=N. Not one note moves; the CLOCK moves, and so does what the render costs.\n"
        + "  • meter — RE-BAR the content into a new M:, merging or splitting bars and tying notes across the new "
        + "barlines. This is the tool that exists because of a real mistake: M:2/4 was changed to M:4/4 with the "
        + "content left alone, and the result rendered fine and engraved wrongly. Integer relations only — 2/4 "
        + "into 6/8 is a decision about where the beats go and is refused rather than guessed. Afterwards the "
        + "two note timelines are COMPARED to prove nothing moved, and a transform that moved something refuses "
        + "instead of shipping.\n"
        + "  • drop_instrument — remove the clauses of the style prompt that name an instrument, reporting what "
        + "came out verbatim. ⚠ That removes a REQUEST, not a sound.\n"
        + "  • sections — reorder or repeat whole `% verse` / `% chorus` blocks by the numbers score_get lists. "
        + "Repeats and omissions are both allowed. ⚠ The LYRICS do not move with them.\n\n"
        + "WHY THIS EXISTS BESIDE score_edit, for a model that can obviously write ABC itself: a transform "
        + "cannot make a transcription error. Retyping 122 bars to move one header is a hundred chances to drop "
        + "a tie. And the same four functions are the ONLY score edits the local Qwen3-4B chat panel is given — "
        + "one implementation, two tiers, so the small model and the large one cannot disagree about what a "
        + "meter change means.\n\n"
        + FREE_VS_PAID + "\n\n"
        + NOT_ENFORCED + "\n\n"
        + "CANNOT: it will not reharmonise, will not rewrite a melody, will not change a key, will not invent a "
        + "tie to make a meter fit, will not re-bar a score that already changes meter, and will not touch a "
        + "score that does not already validate — arithmetic on a mistake is a worse mistake. All of that is "
        + "score_edit, where you write the ABC and score_check proves it.",
      inputSchema: {
        type: "object",
        required: ["score", "op", "note"],
        properties: {
          score: { type: "string", description: "The score's slug." },
          op: { type: "string", enum: ["tempo", "meter", "drop_instrument", "sections"],
                description: "Which mechanical edit. Anything else is a score_edit." },
          note: { type: "string", description: "Why, recorded verbatim beside the computed change." },
          version: { type: "string", description: "The version to edit. Defaults to the score's current one, which becomes the parent." },
          bpm: { type: "integer", description: "op tempo: the new quarter-note tempo, 20-400, a whole number (the header is Q:1/4=<integer>)." },
          meter: { type: "string", description: "op meter: the new meter as an explicit fraction — \"4/4\", \"3/4\", \"6/8\", \"7/8\". The content is re-barred to match; it is not a header rewrite." },
          instrument: { type: "string", description: "op drop_instrument: the word to remove from the style prompt. Refused if it does not appear, rather than reporting a success that did nothing." },
          order: { type: "array", items: { type: "integer" },
                   description: "op sections: 1-based section numbers in the order you want them, from score_get's `facts.sections`. [1,2,3,2] repeats section 2; [1,3] drops section 2." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (!String(a.note || "").trim()) {
          throw new Error("Refusing: `note` is required, the same as on score_edit. A mechanical edit is still a "
            + "decision, and the version it writes is read back by whoever comes next.");
        }
        const { row: parent } = await readVersion(a.score, a.version);
        parent.abc = abcOf(parent, a.score);

        /* THE PARENT'S OWN DEFECT IS THE PARENT'S, and the refusal has to say
         * so. `drop_instrument` never touches the ABC, so an invalid parent
         * would otherwise surface as "the drop_instrument transform produced a
         * score that fails its own check" — blaming a transform for a file it
         * carried through untouched, which is the kind of error message that
         * sends somebody debugging the wrong function. The one score in this
         * store that fails is v1, and it is the parent of everything. */
        const parentCheck = checkScore(parent.abc);
        if (!parentCheck.ok) {
          throw new Error(`Refusing: version ${parent.id}'s own score fails ${parentCheck.problem_count} `
            + "invariant(s), so every version built on it inherits them and no mechanical transform can "
            + "remove them.\n"
            + parentCheck.problems.slice(0, 4).map((x) => `  • [${x.code}] ${x.where}: ${x.says}`).join("\n")
            + (parentCheck.diagnosis ? `\n\n${parentCheck.diagnosis}` : "")
            + "\n\nRepair it with score_edit first — that is a one-line change here — and then repeat this "
            + "edit against the version that passes.");
        }
        /* The inherited lyrics get the same guard as supplied ones: the parent
         * may predate it, and a mechanical edit must not be the quiet way a
         * sung "[verse]" reaches a render. */
        const inheritedLyrics = lyricRefusal(parent.lyrics);
        if (inheritedLyrics) {
          throw new Error(`${inheritedLyrics} (They came from version ${parent.id}, which this edit would carry `
            + "forward. Fix them with score_edit's `lyrics` first.)");
        }

        let result;
        try {
          result = applyMechanical(a.op, {
            abc: parent.abc, style: parent.style, lyrics: parent.lyrics,
            bpm: a.bpm, meter: a.meter, instrument: a.instrument, order: a.order,
          });
        } catch (err) {
          // A Refusal's message IS the explanation; nothing was written.
          throw new Error(err instanceof Refusal ? err.message : String(err.message || err));
        }
        const abc = result.abc ?? parent.abc;
        const style = result.style ?? parent.style;
        const check = checkScore(abc);
        if (!check.ok) {
          throw new Error(`Refusing: the ${a.op} transform produced a score that fails its own check, so nothing `
            + `was written. First: [${check.problems[0].code}] ${check.problems[0].where}: ${check.problems[0].says}`);
        }
        const r = await score({
          action: "draft", slug: a.score, abc, style, lyrics: parent.lyrics,
          cot: parent.cot || "full", parent: parent.id,
          note: `${a.note} [mechanical:${a.op} — ${result.changed.join("; ")}]`,
          check: { ok: true, sha256: check.sha256 },
        });
        return {
          score: a.score, version: r.version?.id ?? r.version, parent: parent.id, op: a.op,
          changed: result.changed,
          consequence: result.consequence,
          also: result.also,
          removed_verbatim: result.removed_verbatim,
          check_passed: true,
          facts: check.facts,
          render_estimate_seconds: check.render_estimate_seconds,
          note: "Written, nothing rendered.",
        };
      },
    },

    {
      name: "score_render",
      description:
        "SPEND THE GPU: render one version to audio. Returns a job id IMMEDIATELY — poll score_get on that "
        + "version, whose `renders` array fills in with the stage, the wall time and the finished file.\n\n"
        + "WHAT IT COSTS, MEASURED on this rig for one " + MEASURED.audio_seconds + " s song: "
        + MEASURED.e2e_seconds + " s end to end (" + MEASURED.realtime_factor + "x realtime), holding the card "
        + "throughout. Semantic generation is " + MEASURED.semantic_seconds + " s of it ("
        + MEASURED.semantic_output_tokens + " tokens at " + MEASURED.semantic_tokens_per_second + " tok/s), NAR "
        + MEASURED.nar_seconds + " s, VAE " + MEASURED.vae_seconds + " s, model load " + MEASURED.load_warm_seconds
        + " s warm and about " + MEASURED.load_cold_seconds + " s cold. Peak " + MEASURED.peak_gib + " GiB of "
        + MEASURED.usable_gib + " usable. For scale, the other engine here — MiniMax Music 3 — runs at "
        + MEASURED.minimax_realtime_factor + "x realtime, so this one is roughly half as fast and is the only "
        + "one with a score you can edit.\n\n"
        + "⚠ A SUPPLIED SCORE COSTS ZERO ABC TOKENS. MEASURED, from the receipt: abc {seconds: "
        + MEASURED.abc_seconds + ", output_tokens: " + MEASURED.abc_output_tokens + ", external_prefix_tokens: "
        + MEASURED.abc_external_prefix_tokens + "}. Supplying a score does not add a planning pass — it REPLACES "
        + "one. The notation is encoded as a " + MEASURED.abc_external_prefix_tokens + "-token external prefix and "
        + "the planner never runs. So steering a song by editing its score is not more expensive than generating "
        + "one from a caption; the symbolic half is free and only the audio half is paid for.\n\n"
        + "⚠ AND IT DOES NOT REPAIR YOUR SCORE. An external ABC input bypasses the symbolic planner; it does not "
        + "call a second planner to fix what you sent. Whatever you supply is what conditions the render, "
        + "mistakes included — which is why this refuses to start on a version whose check does not pass.\n\n"
        + NOT_ENFORCED + " Expect divergence and listen for it: that is what score_compare is for.\n\n"
        + NO_AUDIO_REFERENCE + "\n\n"
        + NO_BRACKETS + "\n\n"
        + FREE_VS_PAID + "\n\n"
        + "CANNOT: it cannot render a slice, an interval, or one section — there is no edit-interval input, so "
        + "every change is a whole-song re-render. It cannot continue an existing recording. It cannot be told "
        + "to match a reference mix. It does not choose a seed for you unless you omit one, and the same seed "
        + "with the same score and the same words is the only way to make two renders comparable.",
      inputSchema: {
        type: "object",
        required: ["score"],
        properties: {
          score: { type: "string", description: "The score's slug." },
          version: { type: "string", description: "The version to render. Defaults to the score's current one. Its check must pass; a failing one is refused before the card is touched." },
          seed: { type: "integer", minimum: 0, maximum: 4294967295, description: "Held and recorded. Rolled if omitted. Two renders you intend to compare must share a seed, or the difference you read off them is partly the seed." },
          cfg_scale: { type: "number", description: "The vendor's classifier-free guidance scale. MEASURED default on this rig: 1.0, which runs cfg_branches 1 — raising it multiplies the branches and so the time. Leave it alone unless you are measuring it." },
          title: { type: "string", description: "What the finished track is called in the library. Defaults to the version id." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const bad = audioReferenceRefusal(a);
        if (bad) throw new Error(bad);
        const { row: v } = await readVersion(a.score, a.version);
        const check = checkScore(abcOf(v, a.score));
        if (!check.ok) {
          throw new Error(
            `Refusing to render ${v.id}: its score fails ${check.problem_count} invariant(s), and a render `
            + `costs ${MEASURED.e2e_seconds} s MEASURED. The generator will not repair it — an external score `
            + "bypasses the planner rather than being fixed by it.\n"
            + check.problems.slice(0, 6).map((p) => `  • [${p.code}] ${p.where}: ${p.says}`).join("\n")
            + (check.diagnosis ? `\n\n${check.diagnosis}` : "")
            + "\n\nFix it with score_edit (or score_mechanical for a meter) and render the version that passes.");
        }
        const lyricBad = lyricRefusal(v.lyrics);
        if (lyricBad) throw new Error(`${lyricBad} (The lyrics on version ${v.id} carry them; fix them with `
          + "score_edit, which writes a new version rather than mutating this one.)");
        if (!String(v.style || "").trim()) {
          throw new Error(`Refusing: version ${v.id} has no style prompt. The score fixes the notes and the `
            + "tempo; the style fixes the sound, the voice and the arrangement, and there is no other input "
            + "that can. Set it with score_edit's `style`.");
        }

        /* THE RENDER IS A RUN ON THIS SCORE, not a free-floating job: their doc
         * already carries a `runs` array (routes.js read: `runs:
         * doc.runs.slice(0, 20)`), and their `adopt` already ingests a finished
         * vendor folder with `parent`. So the finished render lands as a child
         * of the version it was made from, and the lineage joins by itself. */
        const r = await score({
          action: "render", slug: a.score, version: v.id,
          seed: Number.isFinite(a.seed) ? a.seed : undefined,
          cfgScale: Number.isFinite(a.cfg_scale) ? a.cfg_scale : undefined,
          title: a.title || undefined,
        });
        return {
          run: r.run ?? r.job ?? null, score: a.score, version: v.id, seed: r.seed ?? null,
          cost: {
            abc_planning: `ZERO. MEASURED: abc {seconds: ${MEASURED.abc_seconds}, output_tokens: `
              + `${MEASURED.abc_output_tokens}, external_prefix_tokens: ${MEASURED.abc_external_prefix_tokens}}. `
              + "A supplied score replaces the planning pass rather than adding to it.",
            measured_reference: `${MEASURED.audio_seconds} s of audio in ${MEASURED.e2e_seconds} s `
              + `(${MEASURED.realtime_factor}x realtime): semantic ${MEASURED.semantic_seconds} s, NAR `
              + `${MEASURED.nar_seconds} s, VAE ${MEASURED.vae_seconds} s, load ${MEASURED.load_warm_seconds} s warm.`,
            estimate_seconds: check.render_estimate_seconds,
            estimate_basis: `ESTIMATED: this score's nominal ${check.facts.nominal_seconds} s x the MEASURED `
              + `${MEASURED.realtime_factor}x, plus ${MEASURED.load_warm_seconds} s warm load.`,
          },
          nominal_seconds: check.facts.nominal_seconds,
          note: `Started. Poll score_get with score "${a.score}" — the render takes minutes, the score's `
            + "`recent_runs` carries its stage, and the finished render arrives as a NEW version whose parent "
            + `is ${v.id}, carrying the vendor's own receipt in \`rendered.timing\`.`,
          adherence_warning: NOT_ENFORCED,
        };
      },
    },

    {
      name: "score_compare",
      description:
        "TWO VERSIONS, SIDE BY SIDE: what changed in the notation, COMPUTED, and the audio of both so a person "
        + "can hear A against B.\n\n"
        + "The score half is measured off the bytes, never restated from anybody's edit note: the two sha256s; "
        + "which header fields moved (meter, unit, tempo, key); bars, quarters and nominal seconds for each; "
        + "whether the sounding notes are identical after merging ties, and the index, onset, pitch and duration "
        + "of the FIRST one that is not; the same for the chord timeline; the section running order; and a real "
        + "line diff of the two files. Each version's own editing note comes back too, labelled as its author's "
        + "claim — because what somebody meant to change and what the bytes changed are two records, and they "
        + "sometimes disagree.\n\n"
        + "The audio half is whatever renders exist, with their urls, wall times and seeds. ⚠ IF THE TWO WERE "
        + "RENDERED ON DIFFERENT SEEDS, part of what you hear is the seed and not the edit — the result says so "
        + "when it happens. To attribute a difference to a score change, render both on one seed.\n\n"
        + NOT_ENFORCED + " Which is exactly why this tool ends in audio: a computed score diff tells you what "
        + "you asked for, and only the two files tell you what you got.\n\n"
        + "CANNOT: it cannot listen. It returns urls, not a judgement — there is no measurement here of which "
        + "one is better, whether the harmony works, or whether either render followed its page. It also cannot "
        + "diff across engines: both versions must be scores in this store.",
      inputSchema: {
        type: "object",
        required: ["score", "a", "b"],
        properties: {
          score: { type: "string", description: "The score's slug. Both versions must be in it — this cannot diff across songs, or across engines." },
          a: { type: "string", description: "The earlier version id — the baseline." },
          b: { type: "string", description: "The version to judge against it." },
        },
        additionalProperties: false,
      },
      async run(args) {
        const [ra0, rb0] = await Promise.all([
          readVersion(args.score, args.a), readVersion(args.score, args.b),
        ]);
        const va = ra0.row;
        const vb = rb0.row;
        const diff = compareScores(abcOf(va, args.score), abcOf(vb, args.score));
        /* Audio is whatever each version's own receipt says it produced. A
         * drafted version has none, and that is reported rather than filled in. */
        const audio = (v) => (v.status ? [{
          status: v.status, audio_seconds: v.audioSeconds ?? null, seed: v.seed ?? null,
          sample_rate: v.sampleRate ?? null, truncated: v.truncated ?? null,
          /* Their own artifact route (routes.js:210,
           * /api/score/file/<slug>/<version>/<name>), which serves a file out
           * of the verified vendor folder. Named from the artifact map rather
           * than assumed, because a run that saved no FLAC should say so. */
          audio_url: (v.artifacts || []).some((x) => x.name === "audio.flac")
            ? `/api/score/file/${encodeURIComponent(args.score)}/${encodeURIComponent(v.id)}/audio.flac`
            : null,
          wall_seconds: v.timing?.e2e_seconds ?? null,
        }] : []);
        const ra = audio(va);
        const rb = audio(vb);
        const seeds = [...new Set([...ra, ...rb].map((x) => x.seed).filter((s) => s !== null && s !== undefined))];
        return {
          score: args.score,
          a: { version: va.id, parent: va.parent || null, note_as_written_by_its_author: va.note ?? null, renders: ra },
          b: { version: vb.id, parent: vb.parent || null, note_as_written_by_its_author: vb.note ?? null, renders: rb },
          same_parent: (va.parent || null) === (vb.parent || null),
          b_descends_from_a: vb.parent === va.id,
          score_diff: diff,
          style_changed: (va.style ?? null) !== (vb.style ?? null),
          style: (va.style ?? null) === (vb.style ?? null) ? null : { a: va.style ?? null, b: vb.style ?? null },
          lyrics_changed: (va.lyrics ?? null) !== (vb.lyrics ?? null),
          listen: ra.length && rb.length
            ? "Both have audio. Play them against each other; the score diff above says what you are listening for."
            : "One or both have no render yet — score_render first, or this comparison is notation only.",
          seed_warning: seeds.length > 1
            ? `⚠ These renders used ${seeds.length} different seeds (${seeds.join(", ")}). Some of what you hear is `
              + "the seed. Re-render both on one seed before attributing a difference to the edit."
            : null,
          adherence_warning: NOT_ENFORCED,
        };
      },
    },

    {
      name: "score_to_daw",
      description:
        "Build a DAW project from a score version: tempo and meter from the header, one track per "
        + "voice (Vocal → salamander piano, Ins → pluck by default), one clip the length of the "
        + "score, every sounding note at bar.beat.tick. Goes through the DAW's own door, so limits, "
        + "dirty regions and the ledger apply as if you had added the notes yourself; daw_render "
        + "then plays it, and daw_* edits it. Chord symbols come back as markers (the DAW has no "
        + "home for them). A rest is a gap, a tie is one note. It CANNOT carry chord symbols as "
        + "notes and CANNOT update an existing project — each call makes a new one.",
      inputSchema: {
        type: "object",
        required: ["score"],
        properties: {
          score: { type: "string", description: "The score's slug." },
          version: { type: "string", description: "A version id; default the current one." },
          name: { type: "string", description: "The DAW project's name. Default: the score's title and version." },
          patches: { type: "object", additionalProperties: { type: "string" },
            description: "Instrument per voice, e.g. { Vocal: \"vsco2_flute\", Ins: \"eguitar_clean\" } — ids from daw_patches." },
        },
        additionalProperties: false,
      },
      async run(args) {
        return api("POST", "/api/score", { action: "to_daw", slug: args.score, version: args.version, name: args.name, patches: args.patches })
          .then((r) => { if (r?.error) throw new Error(r.error); return r; });
      },
    },

    {
      name: "score_export_midi",
      description:
        "A score version as a Standard MIDI File (format 1, 480 ppq): tempo and meter on track 0, "
        + "one track per sounding voice with a programme, chord symbols as markers. Written to the "
        + "output folder and the path returned; the same bytes are served at "
        + "GET /api/score/midi/<slug>/<version>.mid for a browser. It CANNOT carry lyrics, "
        + "dynamics or the style line — a YuE2 score has none of them.",
      inputSchema: {
        type: "object",
        required: ["score"],
        properties: {
          score: { type: "string", description: "The score's slug." },
          version: { type: "string", description: "A version id; default the current one." },
        },
        additionalProperties: false,
      },
      async run(args) {
        const r = await api("POST", "/api/score", { action: "export_midi", slug: args.score, version: args.version });
        if (r?.error) throw new Error(r.error);
        return r;
      },
    },
  ];
}
