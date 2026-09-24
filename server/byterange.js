/**
 * ONE READING OF AN HTTP `Range` HEADER, for every door here that serves media
 * in pieces (a returned take, a clip, a file under the output folder).
 *
 * Three doors each carried their own copy of the same few lines, and all three
 * read a SUFFIX range — `bytes=-500`, "the last 500 bytes" — as the first 501
 * bytes of the file. A player that asks for the tail of an MP4 to find its
 * index was handed the head. One function, so the fix is in one place.
 *
 * Returns
 *   null                    no usable range: serve the whole file (200)
 *   { unsatisfiable: true } a range this file cannot answer (416)
 *   { start, end }          inclusive byte offsets to serve (206)
 */
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || ""));
  if (!m || (!m[1] && !m[2])) return null;
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) return { unsatisfiable: true };
  if (!m[1]) {
    /* A suffix: the LAST n bytes, all of them when n is larger than the file. */
    const n = Number(m[2]);
    if (!(n > 0)) return { unsatisfiable: true };
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(m[1]);
  const end = Math.min(m[2] ? Number(m[2]) : total - 1, total - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return { unsatisfiable: true };
  return { start, end };
}
