/** Verified, resumable downloads. URLs and digests come from the shipped manifest, never a client. */
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export async function fileMatches(file, spec, {signal} = {}) {
  try {
    signal?.throwIfAborted();
    const s = await lstat(file);
    if (!s.isFile() || s.size !== spec.bytes) return false;
    const hash = createHash(spec.gitBlob ? 'sha1' : 'sha256');
    if (spec.gitBlob) hash.update(`blob ${s.size}\0`);
    for await (const chunk of createReadStream(file, {signal})) hash.update(chunk);
    signal?.throwIfAborted();
    return hash.digest('hex') === (spec.gitBlob || spec.sha256);
  } catch (err) { signal?.throwIfAborted(); return false; }
}

export async function verifiedDownload(spec, dest, {signal, fetchFn = fetch, onProgress = () => {},
  idleTimeoutMs = 120000, matches = fileMatches, writeStream = createWriteStream} = {}) {
  if (!Number.isSafeInteger(spec.bytes) || spec.bytes <= 0 || !/^https:\/\//.test(spec.url)
    || !(spec.gitBlob ? /^[a-f0-9]{40}$/.test(spec.gitBlob) : /^[a-f0-9]{64}$/.test(spec.sha256))) {
    throw new Error('Invalid pinned download manifest.');
  }
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('Invalid download timeout.');
  signal?.throwIfAborted();
  // Reject links/non-files before any truncation, deletion, or replacement.
  for (const file of [dest, `${dest}.part`]) {
    const info = await lstat(file).catch(err => { if (err.code === 'ENOENT') return null; throw err; });
    if (info && !info.isFile()) throw new Error('Download destination must be a regular file.');
  }
  if (await matches(dest, spec, {signal})) { signal?.throwIfAborted(); onProgress(spec.bytes); return {reused:true}; }
  await mkdir(path.dirname(dest), {recursive:true});
  const part = `${dest}.part`;
  let from = await lstat(part).then(s => s.size).catch(err => { if (err.code === 'ENOENT') return 0; throw err; });
  signal?.throwIfAborted();
  if (from > spec.bytes) { await unlink(part); from = 0; }
  if (from === spec.bytes) {
    if (await matches(part, spec, {signal})) { signal?.throwIfAborted(); await rename(part, dest); onProgress(spec.bytes); return {reused:true}; }
    signal?.throwIfAborted();
    await unlink(part); from = 0;
  }
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, {once:true});
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Download stalled; retry resumes the partial file.')), idleTimeoutMs);
  let response;
  try {
  response = await fetchFn(spec.url, {headers:from ? {Range:`bytes=${from}-`} : {}, signal:controller.signal});
  if (!response.ok) throw new Error(`${path.basename(dest)}: HTTP ${response.status}`);
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== from || Number(range[3]) !== spec.bytes
      || Number(range[2]) !== spec.bytes - 1) throw new Error('Invalid download resume range; partial file retained.');
  } else if (response.status === 200) from = 0;
  else throw new Error(`Unexpected download response: ${response.status}`);
  if (!response.body) throw new Error('Download response has no body.');
  const stream = writeStream(part, {flags:from ? 'a' : 'w'});
  let received = from;
  const counter = new Transform({transform(chunk, _encoding, callback) {
    try {
      received += chunk.length;
      if (received > spec.bytes) throw new Error('Download exceeded its pinned size.');
      timer.refresh();
      onProgress(received);
      callback(null, chunk);
    } catch (err) { callback(err); }
  }});
  // Pipeline couples backpressure, cancellation and file/network errors, and awaits close.
  const source = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
  await pipeline(source, counter, stream, {signal:controller.signal});
  clearTimeout(timer);
  signal?.throwIfAborted();
  if (received !== spec.bytes) throw new Error(`Incomplete download: ${received}/${spec.bytes} bytes; retry resumes it.`);
  if (!await matches(part, spec, {signal})) {
    signal?.throwIfAborted();
    await unlink(part);
    throw new Error('Download checksum mismatch; corrupt partial removed. Retry the download.');
  }
  signal?.throwIfAborted();
  await rename(part, dest);
  return {reused:false};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // Also cancel HTTP bodies rejected before pipeline attached to them.
    if (response?.body && !response.body.locked) await response.body.cancel?.().catch(() => {});
  }
}
