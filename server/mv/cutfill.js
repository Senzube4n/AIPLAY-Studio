/**
 * THE CUT LEAVES NO SUNG SECOND WITHOUT A PICTURE.
 *
 * A pass over the segments segmentation.js returns, which stays the website's
 * port verbatim (its header asks for a line-for-line diff against the .ts, so
 * Studio's changes live here instead). routes.js segment() runs it on every
 * cut, whatever the longest scene.
 *
 * WHY IT EXISTS. The website cut at 15 s, and at 15 s two things the port does
 * were rare. At Studio's shorter defaults (sizes.js sceneCutFor: 8 s at full
 * size, 5 s at the smaller ones) they are common, and each leaves a stretch of
 * song that no scene covers. buildTimeline (generate.js) places every clip at
 * its scene's start and fills nothing between, so such a stretch reached the
 * export as black:
 *
 *   a long line   one lyric line longer than the longest scene is hard-cut at
 *                 the cap, and the next scene starts at the NEXT line, so the
 *                 rest of the long line had no scene at all. Measured on this
 *                 library at 5 s: hex-appeal lost 5.0 s, night-train-girl 8.2 s.
 *   a breath      a gap between two lines shorter than an instrumental break
 *                 (6 s) falls between two windows when the next line does not
 *                 fit under the cap. More, shorter windows meet more breaths:
 *                 a ballad with 0.3-1.2 s breaths lost 4.4 s at 15 s and
 *                 14.2 s at 8 s.
 *
 * WHAT IT DOES, in that order:
 *
 *   1. A hard-capped line is split into back-to-back scenes of equal length,
 *      each within the cap, covering the whole line (and the breath after it,
 *      when one follows before the next scene). A line longer than the longest
 *      scene is the one case where a line is split; the website's rule "never
 *      cut mid-sentence" still holds for every line that fits.
 *   2. A breath between two scenes is closed: the earlier scene is held on
 *      through it as far as the cap allows, then the later one starts early as
 *      far as its cap allows. A breath both neighbours are too long to take
 *      (both already at the cap) stays, and the timeline shows it as Empty.
 *
 * The song's intro and outro are left as the port leaves them: an intro or a
 * tail shorter than an instrumental break is skipped by design upstream ("start
 * the first lyrical clip at the first sung line"), at every cap alike.
 *
 * PURE. Segments in, segments out; nothing is read or written.
 */

const EPS = 1e-6;
/** Below this a gap is float noise, the threshold computeCoverage ignores too. */
const SLIVER = 0.05;
const round1 = (n) => Math.round(n * 10) / 10;

function quote(text, max = 42) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  return t.length <= max ? `"${t}"` : `"${t.slice(0, max - 1)}…"`;
}

/**
 * Split [start, end] into the fewest equal pieces whose ROUNDED lengths all
 * stay within the cap (boundaries are rounded to 0.1 s, as the port rounds).
 */
function evenPieces(start, end, cap) {
  let n = Math.max(1, Math.ceil((end - start) / cap - EPS));
  for (;;) {
    const each = (end - start) / n;
    const cuts = Array.from({ length: n + 1 }, (_, k) => (k === n ? round1(end) : round1(start + k * each)));
    const pieces = cuts.slice(0, -1).map((s, k) => [s, cuts[k + 1]]);
    if (pieces.every(([a, b]) => b - a <= cap + EPS && b - a > EPS) || n > 1000) return pieces;
    n++;
  }
}

/**
 * @param {object[]} segments   segmentSong's output, in order
 * @param {object[]} lines      the lyric lines it was cut from ({index, text, startSec, endSec})
 * @param {object}   opts       { maxClipSec, instrumentalGapSec }, as the cut used them
 * @returns {object[]} new segments, renumbered; the input is not changed
 */
export function closeCutHoles(segments, lines, { maxClipSec = 15, instrumentalGapSec = 6 } = {}) {
  const cap = Number(maxClipSec) > 0 ? Number(maxClipSec) : 15;
  const gapSec = Number(instrumentalGapSec) > 0 ? Number(instrumentalGapSec) : 6;
  const byIndex = new Map((lines || []).map((l) => [l.index, l]));
  const src = (segments || []).map((s) => ({ ...s }));

  /* 1. A long line is split, and every part of it gets a scene. */
  const out = [];
  src.forEach((seg, i) => {
    const line = seg.hardCapped && seg.kind === "lyrical" && seg.lineIndices?.length === 1
      ? byIndex.get(seg.lineIndices[0]) : null;
    if (!line || !(line.endSec > seg.endSec + SLIVER)) { out.push(seg); return; }
    /* The breath after the line travels with it, when the next scene starts
     * before an instrumental break would have. */
    const next = src[i + 1];
    const lineEnd = round1(line.endSec);
    const end = next && next.startSec > lineEnd && next.startSec - lineEnd < gapSec ? next.startSec : lineEnd;
    const pieces = evenPieces(seg.startSec, end, cap);
    const text = String(line.text || "").trim();
    pieces.forEach(([a, b], k) => {
      out.push({
        ...seg,
        startSec: a,
        endSec: b,
        durationSec: round1(b - a),
        lineIndices: [line.index],
        lyricText: text,
        thesisLine: text,
        audioRecommended: true,
        hardCapped: true,
        overlapWithPrevSec: k === 0 ? seg.overlapWithPrevSec ?? 0 : 0,
        note: `${a}–${b}s (${round1(b - a)}s), part ${k + 1} of ${pieces.length}. The line ${quote(text)} `
          + `runs longer than the ${cap}s longest scene, so it is split into ${pieces.length} back-to-back `
          + "scenes and every part of it has a picture.",
      });
    });
  });

  /* 2. A breath between two scenes is closed, within each scene's cap. */
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    const gap = round1(b.startSec - a.endSec);
    if (!(gap > SLIVER)) continue;
    const hold = Math.min(gap, Math.max(0, round1(cap - (a.endSec - a.startSec))));
    if (hold > SLIVER) {
      a.endSec = round1(a.endSec + hold);
      a.durationSec = round1(a.endSec - a.startSec);
      a.note = `${a.note || ""} Held ${round1(hold)}s past its last line, through the breath before the `
        + "next scene, so no stretch of the song is left without a picture.";
    }
    const rest = round1(b.startSec - a.endSec);
    const early = Math.min(rest, Math.max(0, round1(cap - (b.endSec - b.startSec))));
    if (early > SLIVER) {
      b.startSec = round1(b.startSec - early);
      b.durationSec = round1(b.endSec - b.startSec);
      b.note = `${b.note || ""} Starts ${round1(early)}s early, in the breath before its first line, so no `
        + "stretch of the song is left without a picture.";
    }
  }

  return out.map((s, idx) => ({ ...s, index: idx, note: String(s.note || "").trim() }));
}

/**
 * Seconds of song between the first and the last scene that no scene covers:
 * what the cut leaves black in the middle of the video. The intro and outro
 * are not counted (the port skips a short one by design, at every cap).
 */
export function uncoveredInside(segments) {
  const s = [...(segments || [])].sort((x, y) => x.startSec - y.startSec);
  let hole = 0, reach = s.length ? s[0].endSec : 0;
  for (const seg of s.slice(1)) {
    if (seg.startSec > reach + SLIVER) hole += seg.startSec - reach;
    reach = Math.max(reach, seg.endSec);
  }
  return round1(hole);
}
