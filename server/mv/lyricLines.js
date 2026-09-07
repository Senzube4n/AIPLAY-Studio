/**
 * AI Music Video Studio — lyric line builders (PURE, testable).
 *
 * PORTED, unchanged in behaviour, from the aiplay.live website:
 *   devsnap0812/app/helpers/musicVideo/lyricLines.ts  (mtime 2026-06-04 09:34)
 * TypeScript was stripped by hand — Studio has no build step. Variable names,
 * branch order, rounding, clamping and tie-breaks are deliberately identical so
 * the two files still diff line-by-line.
 *
 * ⚠ These four numbers decide where every shot in a video starts and ends. They
 * are the website's shipped values; nothing downstream re-derives or validates
 * them, so a drifted constant corrupts every artefact silently:
 *     gapSec  0.65   line break when two words are this far apart
 *     maxWords   9   hard line length
 *     estDur clamp [0.18, 0.8]   per-word duration guess, and 0.45 fallback
 *     final .lrc line runs 3.5 s
 *
 * Turns the two lyric sources into the LyricLine[] that segmentSong consumes:
 *   - Suno aligned lyrics: AlignedWord[] = { word, time(sec, word START) }
 *   - Whisper / generic .lrc: "[mm:ss.xx] line text"
 *
 * Suno gives word START times only, so a line's endSec is its last word start +
 * an estimated word duration (median in-line gap, clamped). That leaves the real
 * pauses between lines intact so segmentSong can detect instrumental gaps.
 */

/**
 * A timed lyric line (a "sentence" unit). Times are seconds from song start.
 * Shape mirrors `LyricLine` in segmentation.ts, which is what consumes these.
 *
 * @typedef {object} LyricLine
 * @property {number} index    Stable index into the source line list.
 * @property {string} text
 * @property {number} startSec
 * @property {number} endSec
 */

/**
 * One aligned word. `time` is the word's START, in seconds — there is no end.
 *
 * @typedef {object} AlignedWord
 * @property {string} word
 * @property {number} time
 */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Group aligned words into lines on a time gap or a max word count.
 *
 * @param {AlignedWord[]} words
 * @param {{ gapSec?: number, maxWords?: number }} [opts]
 * @returns {LyricLine[]}
 */
export function wordsToLines(words, opts = {}) {
  const gap = opts.gapSec ?? 0.65;
  const maxW = opts.maxWords ?? 9;
  const sorted = words
    .filter((w) => w && typeof w.time === "number" && (w.word ?? "").trim().length > 0)
    .sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return [];

  // Group into lines on a time gap or a max word count.
  const groups = [];
  let cur = [];
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    const prev = sorted[i - 1];
    const breakLine = cur.length > 0 && ((prev && w.time - prev.time >= gap) || cur.length >= maxW);
    if (breakLine) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  return groups.map((g, idx) => {
    const text = g.map((w) => w.word.trim()).join(" ").replace(/\s+/g, " ").trim();
    const startSec = g[0].time;
    // Estimate end: last word start + a per-word duration guess.
    let estDur = 0.45;
    if (g.length > 1) {
      const deltas = [];
      for (let i = 1; i < g.length; i++) deltas.push(g[i].time - g[i - 1].time);
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)] || 0.45;
      estDur = clamp(median, 0.18, 0.8);
    }
    const endSec = g[g.length - 1].time + estDur;
    return { index: idx, text, startSec: Math.max(0, startSec), endSec };
  });
}

/**
 * Parse a standard .lrc (Whisper output) into timed lines.
 *
 * @param {string} lrc
 * @returns {LyricLine[]}
 */
export function lrcToLines(lrc) {
  /** @type {{ text: string, startSec: number }[]} */
  const out = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/;
  for (const raw of lrc.split(/\r?\n/)) {
    const m = raw.match(re);
    if (!m) continue;
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const frac = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0;
    const text = (m[4] ?? "").trim();
    if (!text) continue; // skip empty/instrumental marker lines
    out.push({ text, startSec: min * 60 + sec + frac });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out.map((l, idx) => ({
    index: idx,
    text: l.text,
    startSec: l.startSec,
    // end at next line's start, or +3.5s for the final line.
    endSec: idx + 1 < out.length ? out[idx + 1].startSec : l.startSec + 3.5,
  }));
}
