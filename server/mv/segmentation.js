/**
 * Audio segmentation — turns timed lyric lines + a song duration into the
 * ordered list of clip-sized audio windows the whole MV pipeline hangs off.
 *
 * PORTED VERBATIM from aiplay.live:
 *   app/helpers/musicVideo/segmentation.ts  (devsnap0812, mtime 2026-06-04)
 * TypeScript stripped by hand; runtime logic is unchanged. Keep the branch
 * order, the rounding and the note wording line-for-line with the .ts so a
 * future `diff` against the website tree stays a by-eye read.
 *
 * ⚠ DO NOT TOUCH THE FOUR DEFAULTS. `maxClipSec: 15` is the Seedance
 * audio-input ceiling, not a taste choice; `minClipSec: 4`, `leadInSec: 0` and
 * `instrumentalGapSec: 6` are what the live site has produced for every project
 * shipped so far. Changing any of them silently re-cuts every scene boundary
 * and no downstream stage validates against the old plan — the corruption is
 * invisible until someone watches the render.
 *
 * ⚠ EPS = 1e-6 appears in every comparison for a reason. Boundaries arrive as
 * floats from Whisper/Suno alignment and land a few ULPs either side of the
 * cap; a bare `>` there emits phantom one-frame segments.
 *
 * Design goals (from the original product brief, refined):
 *   - Each clip is backed by an audio window of AT MOST `maxClipSec` (15s — the
 *     Seedance audio-input ceiling). Never exceed it.
 *   - NEVER cut mid-sentence. Windows snap to whole lyric lines. If adding the
 *     next line would blow the 15s cap, we close the window EARLY (a <15s clip)
 *     so the previous sentence stays whole.
 *   - A long instrumental intro is skipped (we start the first lyrical clip at
 *     the first sung line) — unless it is long enough to deserve its own
 *     instrumental clip, in which case we emit one (or several) for it.
 *   - Instrumental gaps mid-song and a trailing instrumental tail become their
 *     own `instrumental` segments, flagged `audioRecommended:false` so the user
 *     can generate those clips WITHOUT feeding audio (per "sometimes you don't
 *     need audio input").
 *   - Every segment carries a plain-language `note` explaining its boundaries
 *     and any overlap, so the UI can show "we start at 30s, end at 44.6s, and
 *     overlap 0.8s here because…".
 *   - Output is fully user-adjustable: `resnapSegment()` recomputes a single
 *     segment's covered lines + note after the user nudges its start/end.
 *
 * This module is data-source agnostic. Feed it `LyricLine[]` built from Suno
 * aligned lyrics (AlignedWord[] -> lines) OR a Whisper .lrc (already lines).
 * Both adapters live in ./lyricLines.js (separate file).
 */

/**
 * A timed lyric line (a "sentence" unit). Times are seconds from song start.
 * @typedef {object} LyricLine
 * @property {number} index    Stable index into the source line list.
 * @property {string} text
 * @property {number} startSec
 * @property {number} endSec
 */

/**
 * @typedef {"lyrical" | "instrumental"} SegmentKind
 */

/**
 * @typedef {object} AudioSegment
 * @property {number} index
 * @property {number} startSec
 * @property {number} endSec
 * @property {number} durationSec  endSec - startSec. Always <= maxClipSec (+ a tiny float epsilon).
 * @property {SegmentKind} kind
 * @property {number[]} lineIndices  Source line indices this segment covers (empty for instrumental).
 * @property {string} lyricText      Joined lyric text of the covered lines (empty for instrumental).
 * @property {string} thesisLine     Dominant line — the shot anchor. Empty for instrumental.
 * @property {boolean} audioRecommended     False for instrumental segments — UI offers "generate without audio".
 * @property {number} overlapWithPrevSec    Seconds this segment overlaps the previous one (0 when contiguous).
 * @property {boolean} hardCapped   True when a single line was longer than the cap and had to be hard-cut.
 * @property {string} note          Human-readable explanation of the chosen boundaries.
 */

/**
 * @typedef {object} SegmentationOptions
 * @property {number} [maxClipSec]  Hard ceiling per clip in seconds. Default 15 (Seedance audio limit).
 * @property {number} [minClipSec]
 *   Clips shorter than this (in seconds) are merged into a neighbour when that
 *   keeps the result <= maxClipSec, to avoid sub-second slivers. Default 4.
 * @property {number} [leadInSec]
 *   Optional lead-in: start a lyrical window this many seconds before the
 *   first line's startSec (captures the breath/downbeat before a vocal). May
 *   create a small, intentional overlap with the previous clip — reported in
 *   `overlapWithPrevSec` and the note. Default 0 (no lead-in, no overlap).
 * @property {number} [instrumentalGapSec]
 *   A silence/instrumental gap >= this between consecutive lyric lines is
 *   treated as a real break (its own instrumental segment) rather than being
 *   swallowed into a window. Default 6.
 */

const DEFAULTS = {
  maxClipSec: 15,
  minClipSec: 4,
  leadInSec: 0,
  instrumentalGapSec: 6,
};

const EPS = 1e-6;

const round1 = (n) => Math.round(n * 10) / 10;

/** Word count proxy — used to pick the most lyrically dense "thesis" line. */
const wordCount = (s) => (s.trim().match(/\S+/g) ?? []).length;

/**
 * Pick the dominant line of a group (most words; ties -> earliest).
 * The tie-break is the strict `>`: an equal count never displaces the
 * incumbent, so the earliest line of a tie wins. Do not relax it to `>=`.
 * @param {LyricLine[]} lines
 * @returns {string}
 */
function pickThesis(lines) {
  let best = null;
  let bestN = -1;
  for (const l of lines) {
    const n = wordCount(l.text);
    if (n > bestN) {
      best = l;
      bestN = n;
    }
  }
  return best ? best.text.trim() : "";
}

/**
 * Short, truncated quote of a line for human notes.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function quote(text, max = 42) {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length <= max ? `"${t}"` : `"${t.slice(0, max - 1)}…"`;
}

/**
 * Chunk a pure-instrumental span [from, to) into <= maxClipSec windows.
 * Splits as evenly as possible so we don't get a 15s + 1s pair.
 *
 * The count is `ceil(total / cap)` and every piece is `total / n` — NOT
 * cap-sized pieces with a stub remainder. A 20s gap at cap 15 is 2x10s.
 *
 * @param {number} from
 * @param {number} to
 * @param {number} cap
 * @returns {Array<{ startSec: number, endSec: number }>}
 */
function instrumentalSpan(from, to, cap) {
  const total = to - from;
  if (total <= EPS) return [];
  const n = Math.max(1, Math.ceil(total / cap - EPS));
  const each = total / n;
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      startSec: from + k * each,
      endSec: k === n - 1 ? to : from + (k + 1) * each,
    });
  }
  return out;
}

/**
 * Build the segment list. The returned segments are ordered and (by default)
 * non-overlapping except where `leadInSec` intentionally overlaps a lead-in.
 *
 * @param {LyricLine[]} lines
 * @param {number} totalDurationSec
 * @param {SegmentationOptions} [options]
 * @returns {AudioSegment[]}
 */
export function segmentSong(lines, totalDurationSec, options = {}) {
  const cap = options.maxClipSec ?? DEFAULTS.maxClipSec;
  const minClip = options.minClipSec ?? DEFAULTS.minClipSec;
  const leadIn = Math.max(0, options.leadInSec ?? DEFAULTS.leadInSec);
  const gapSec = options.instrumentalGapSec ?? DEFAULTS.instrumentalGapSec;

  const sorted = [...lines]
    .filter((l) => l.endSec > l.startSec + EPS)
    .sort((a, b) => a.startSec - b.startSec);

  // Raw segments (pre lead-in / overlap / merge / numbering). See the Raw
  // typedef below `segmentSong` — it is the shape this array holds.
  const raw = [];

  // ---- Fully instrumental song (no usable lyric lines) ----
  if (sorted.length === 0) {
    for (const s of instrumentalSpan(0, totalDurationSec, cap)) {
      raw.push({ ...s, kind: "instrumental", lineIndices: [], hardCapped: false });
    }
    return finalize(raw, sorted, leadIn, minClip, cap, gapSec);
  }

  let cursor = 0;
  const firstStart = sorted[0].startSec;

  // ---- Leading instrumental intro ----
  // If it is long enough to be a real break, give it its own clip(s).
  // Otherwise skip it (start the first lyrical clip at the first sung line).
  if (firstStart - cursor >= gapSec) {
    for (const s of instrumentalSpan(cursor, firstStart, cap)) {
      raw.push({ ...s, kind: "instrumental", lineIndices: [], hardCapped: false });
    }
  }
  cursor = firstStart;

  // ---- Greedy line packing ----
  let i = 0;
  while (i < sorted.length) {
    const windowStart = sorted[i].startSec;
    let j = i;
    let windowEnd = sorted[i].endSec;
    let hardCapped = false;

    // A single line longer than the cap is unavoidable — hard-cut at the cap.
    if (windowEnd - windowStart > cap + EPS) {
      windowEnd = windowStart + cap;
      hardCapped = true;
    } else {
      // Add following lines while they (a) still fit under the cap and (b) are
      // not separated by an instrumental-sized gap.
      while (j + 1 < sorted.length) {
        const next = sorted[j + 1];
        const gapToNext = next.startSec - sorted[j].endSec;
        if (gapToNext >= gapSec) break; // instrumental break -> close window
        if (next.endSec - windowStart > cap + EPS) break; // would exceed cap
        j++;
        windowEnd = sorted[j].endSec;
      }
    }

    raw.push({
      startSec: windowStart,
      endSec: windowEnd,
      kind: "lyrical",
      lineIndices: sorted.slice(i, j + 1).map((l) => l.index),
      hardCapped,
    });
    cursor = windowEnd;

    // Instrumental gap before the next line?
    if (j + 1 < sorted.length) {
      const nextStart = sorted[j + 1].startSec;
      if (nextStart - cursor >= gapSec) {
        for (const s of instrumentalSpan(cursor, nextStart, cap)) {
          raw.push({ ...s, kind: "instrumental", lineIndices: [], hardCapped: false });
        }
        cursor = nextStart;
      }
    }
    i = j + 1;
  }

  // ---- Trailing instrumental tail ----
  if (totalDurationSec - cursor >= gapSec) {
    for (const s of instrumentalSpan(cursor, totalDurationSec, cap)) {
      raw.push({ ...s, kind: "instrumental", lineIndices: [], hardCapped: false });
    }
  }

  return finalize(raw, sorted, leadIn, minClip, cap, gapSec);
}

/**
 * @typedef {object} Raw
 * @property {number} startSec
 * @property {number} endSec
 * @property {SegmentKind} kind
 * @property {number[]} lineIndices
 * @property {boolean} hardCapped
 */

/**
 * Apply lead-in, merge slivers, then number + annotate.
 *
 * `gapSec` is unused here — it is carried on the signature because the .ts
 * carries it. Keep it, so the two files stay diffable.
 *
 * @param {Raw[]} raw
 * @param {LyricLine[]} sorted
 * @param {number} leadIn
 * @param {number} minClip
 * @param {number} cap
 * @param {number} gapSec
 * @returns {AudioSegment[]}
 */
function finalize(raw, sorted, leadIn, minClip, cap, gapSec) {
  const byIndex = new Map(sorted.map((l) => [l.index, l]));

  // Lead-in: pull a lyrical window's start back by leadIn (>=0), clamped so the
  // window never exceeds the cap. This is what can create a small overlap.
  if (leadIn > 0) {
    for (const r of raw) {
      if (r.kind !== "lyrical") continue;
      const pulled = Math.max(0, r.startSec - leadIn);
      if (r.endSec - pulled <= cap + EPS) r.startSec = pulled;
    }
  }

  // Merge a too-short lyrical sliver into the previous lyrical segment when the
  // merged window still fits under the cap (avoids 1–2s orphan clips).
  const merged = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    const dur = r.endSec - r.startSec;
    if (
      prev &&
      prev.kind === "lyrical" &&
      r.kind === "lyrical" &&
      dur < minClip - EPS &&
      r.endSec - prev.startSec <= cap + EPS
    ) {
      prev.endSec = r.endSec;
      prev.lineIndices = [...prev.lineIndices, ...r.lineIndices];
      prev.hardCapped = prev.hardCapped || r.hardCapped;
    } else {
      merged.push({ ...r });
    }
  }

  // Number + annotate.
  const out = [];
  let prevEnd = -Infinity;
  merged.forEach((r, idx) => {
    const segLines = r.lineIndices
      .map((li) => byIndex.get(li))
      .filter((l) => !!l);
    const lyricText = segLines.map((l) => l.text.trim()).join("\n");
    const thesisLine = pickThesis(segLines);
    // The line whose end defines this window's boundary (for the "ends on" note).
    const closingLine = segLines.length ? segLines[segLines.length - 1].text : thesisLine;
    // Overlap is measured against the UNROUNDED previous end, then rounded once.
    const overlap = idx === 0 ? 0 : Math.max(0, round1(prevEnd - r.startSec));
    const durationSec = round1(r.endSec - r.startSec);
    const startSec = round1(r.startSec);
    const endSec = round1(r.endSec);

    let note;
    if (r.kind === "instrumental") {
      note =
        `Instrumental — no vocals between ${startSec}s and ${endSec}s ` +
        `(${durationSec}s). You can generate this clip without audio input.`;
    } else if (r.hardCapped) {
      note =
        `${startSec}–${endSec}s (${durationSec}s, hard cap). The line ` +
        `${quote(thesisLine)} runs past ${cap}s, so the audio is cut at the ${cap}s ceiling.`;
    } else {
      const nLines = segLines.length;
      note =
        `${startSec}–${endSec}s (${durationSec}s). Holds ${nLines} ` +
        `full ${nLines === 1 ? "line" : "lines"}; ends on ${quote(closingLine)} ` +
        `so the sentence stays whole instead of cutting at the ${cap}s mark.`;
    }
    if (overlap > 0) {
      note += ` Starts ${overlap}s before the previous clip ends (lead-in overlap).`;
    }

    out.push({
      index: idx,
      startSec,
      endSec,
      durationSec,
      kind: r.kind,
      lineIndices: r.lineIndices,
      lyricText,
      thesisLine,
      audioRecommended: r.kind === "lyrical",
      overlapWithPrevSec: overlap,
      hardCapped: r.hardCapped,
      note,
    });
    prevEnd = r.endSec;
  });

  return out;
}

/**
 * Recompute one segment after the user drags its start/end handles. Clamps to
 * [0, totalDuration] and to the cap, recomputes which lines it covers + a fresh
 * note. Lines are "covered" when they overlap the new window at all.
 *
 * Overlap, not containment: a line that merely clips the edge of the new window
 * is recovered into it. That is what lets a user widen a segment and get the
 * neighbouring line back.
 *
 * @param {AudioSegment} seg
 * @param {number} newStartSec
 * @param {number} newEndSec
 * @param {LyricLine[]} lines
 * @param {number} totalDurationSec
 * @param {SegmentationOptions} [options]
 * @returns {AudioSegment}
 */
export function resnapSegment(
  seg,
  newStartSec,
  newEndSec,
  lines,
  totalDurationSec,
  options = {},
) {
  const cap = options.maxClipSec ?? DEFAULTS.maxClipSec;
  let start = Math.max(0, Math.min(newStartSec, totalDurationSec));
  let end = Math.max(0, Math.min(newEndSec, totalDurationSec));
  if (end < start) [start, end] = [end, start];
  if (end - start > cap + EPS) end = start + cap; // never exceed the ceiling

  const covered = lines
    .filter((l) => l.endSec > start + EPS && l.startSec < end - EPS)
    .sort((a, b) => a.startSec - b.startSec);
  const kind = covered.length > 0 ? "lyrical" : "instrumental";
  const thesisLine = pickThesis(covered);
  const durationSec = round1(end - start);
  const s = round1(start);
  const e = round1(end);
  const note =
    kind === "instrumental"
      ? `Instrumental — ${s}s to ${e}s (${durationSec}s). Audio input optional.`
      : `Adjusted to ${s}–${e}s (${durationSec}s), covering ${covered.length} ` +
        `line${covered.length === 1 ? "" : "s"} anchored on ${quote(thesisLine)}.`;

  return {
    ...seg,
    startSec: s,
    endSec: e,
    durationSec,
    kind,
    lineIndices: covered.map((l) => l.index),
    lyricText: covered.map((l) => l.text.trim()).join("\n"),
    thesisLine,
    audioRecommended: kind === "lyrical",
    hardCapped: end - start >= cap - EPS,
    note,
  };
}

/**
 * How a clip slot is fulfilled. Users can turn a proposed scene OFF, or swap the
 * AI clip for their own footage:
 *   - "generate": produce an AI video clip (the default; the only billable mode).
 *   - "broll":    the user supplies their own footage for this span.
 *   - "skip":     intentionally left empty (an "empty patch" — black/held in the cut).
 *
 * @typedef {"generate" | "broll" | "skip"} ClipMode
 */

/**
 * Span kinds for the karaoke/segment timeline. `gap` = song time no scene covers.
 * @typedef {"clip" | "broll" | "skip" | "gap"} CoverageKind
 */

/**
 * @typedef {object} CoverageSpan
 * @property {number} startSec
 * @property {number} endSec
 * @property {number} durationSec
 * @property {CoverageKind} kind
 * @property {number|null} segmentIndex  Source segment index, or null for an uncovered gap.
 * @property {string} label
 */

/**
 * Build a gap-free [0, totalDuration] coverage map for the timeline UI so it can
 * render selected scenes as colored bands AND the "empty patches" that are NOT
 * selected — skipped scenes (mode 'skip') and uncovered song spans ('gap'). Each
 * input carries an optional `mode`; anything no segment covers becomes a 'gap'.
 * Tolerant of the small lead-in overlaps `segmentSong` can produce.
 *
 * @param {Array<{ index: number, startSec: number, endSec: number, mode?: ClipMode, label?: string }>} segments
 * @param {number} totalDurationSec
 * @returns {CoverageSpan[]}
 */
export function computeCoverage(segments, totalDurationSec) {
  const sorted = [...segments]
    .filter((s) => s.endSec > s.startSec + EPS)
    .sort((a, b) => a.startSec - b.startSec);
  const spans = [];
  let cursor = 0;

  const pushGap = (from, to) => {
    if (to - from <= 0.05) return; // ignore sub-50ms slivers
    spans.push({
      startSec: round1(from),
      endSec: round1(to),
      durationSec: round1(to - from),
      kind: "gap",
      segmentIndex: null,
      label: `Empty — ${round1(to - from)}s with no scene selected`,
    });
  };

  for (const s of sorted) {
    if (s.startSec > cursor + EPS) pushGap(cursor, s.startSec);
    const mode = s.mode ?? "generate";
    const kind = mode === "generate" ? "clip" : mode === "broll" ? "broll" : "skip";
    const label =
      kind === "clip"
        ? s.label ?? `Scene ${s.index + 1}`
        : kind === "broll"
          ? `Your B-roll · scene ${s.index + 1}`
          : `Skipped · scene ${s.index + 1} (empty patch)`;
    spans.push({
      startSec: round1(s.startSec),
      endSec: round1(s.endSec),
      durationSec: round1(s.endSec - s.startSec),
      kind,
      segmentIndex: s.index,
      label,
    });
    cursor = Math.max(cursor, s.endSec);
  }
  if (totalDurationSec > cursor + EPS) pushGap(cursor, totalDurationSec);
  return spans;
}

/**
 * Count only the clip slots that will actually be billed (mode 'generate').
 * @param {Array<{ mode?: ClipMode }>} segments
 * @returns {number}
 */
export function billableClipCount(segments) {
  return segments.filter((s) => (s.mode ?? "generate") === "generate").length;
}
