/**
 * SERVE A FILE, AND LET GO OF IT WHEN THE READER LEAVES.
 *
 * `createReadStream(file).pipe(res)` has one hole, and on Windows it costs a
 * file: when the reader goes away early (a player seeks, pauses, skips to the
 * next track, or a tab closes), pipe() unpipes and never destroys the read
 * stream. The file stays open inside Studio until Studio exits. Windows cannot
 * rename a file over one that is open, so the tag rewrite that lands a song's
 * cover a minute later failed with EPERM for any song somebody had listened
 * to in the meantime. Reproduced 2026-09-24 on Node 22.15 with a 32 MB file
 * and a client that hung up after the first chunk: the read stream never
 * emitted 'close' and rename(tmp, file) failed with EPERM, as in the report.
 *
 * So the one rule here: when the response closes before the file has been
 * read to its end, the read stream is destroyed, which closes the handle. And
 * a read error tears the response down rather than leaving a half-sent body
 * that looks finished.
 *
 * Ranges are read by lending's byteRange() (server/byterange.js), the one
 * reading of a `Range` header in this server. That also fixes the suffix form
 * here: `bytes=-500` now means the LAST 500 bytes (RFC 7233), where this door
 * used to hand back the first 501.
 *
 * Only /api/audio uses it so far; the other `.pipe(res)` sites are a later
 * sweep.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { byteRange } from "./byterange.js";

/**
 * Pipe `file` (or the inclusive byte `range` of it) to `res`, closing the file
 * if the response closes first. Returns the read stream.
 */
export function streamFile(res, file, range = null) {
  const stream = createReadStream(file, range ?? {});
  /* pipeline(), not pipe() plus a 'close' listener: a player that hung up
   * while the caller was still awaiting (the door's stat, say) has ALREADY
   * fired 'close', and a listener added afterwards never hears it; that
   * stream stayed open and the rename over the song failed with EPERM
   * (reproduced 2026-09-24). pipeline() sees a response that is already gone
   * and destroys the read stream at once, and it destroys it when the
   * response closes early later on too.
   *
   * A read error tears the response down. The headers are usually gone by
   * then, so there is no status left to send, and ending the connection is
   * the only honest signal that the body is short. */
  /* Node 24 throws ERR_STREAM_UNABLE_TO_PIPE synchronously when the response
   * was destroyed before pipeline() is called. Earlier releases reached the
   * callback instead. Release the just-opened file in either case, including
   * the small race between this check and pipeline attaching its listeners. */
  if (res.destroyed || res.closed || res.writableEnded) {
    stream.destroy();
    return stream;
  }
  try {
    pipeline(stream, res, (err) => {
      if (err && !res.destroyed) res.destroy();
      if (!stream.destroyed) stream.destroy();
    });
  } catch (err) {
    stream.destroy();
    if (!res.destroyed) res.destroy(err);
  }
  return stream;
}

/**
 * Answer a GET or HEAD for `file` with range support.
 *
 * `size` saves a second stat when the caller already has one. `headers` go
 * out first; Accept-Ranges and Content-Length (and Content-Range for a 206 or
 * 416) are set here. Resolves with what was sent: { status: 200 | 206 | 416,
 * start?, end? }.
 */
export async function sendFile(req, res, file, { size, headers = {} } = {}) {
  const total = Number.isFinite(size) ? size : (await stat(file)).size;
  const base = { ...headers, "Accept-Ranges": "bytes" };
  const range = byteRange(req.headers?.range, total);
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...base, "Content-Range": `bytes */${total}` });
    res.end();
    return { status: 416 };
  }
  if (range) {
    const { start, end } = range;
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") { res.end(); return { status: 206, start, end }; }
    return { status: 206, start, end, stream: streamFile(res, file, { start, end }) };
  }
  res.writeHead(200, { ...base, "Content-Length": total });
  if (req.method === "HEAD") { res.end(); return { status: 200 }; }
  return { status: 200, stream: streamFile(res, file) };
}
