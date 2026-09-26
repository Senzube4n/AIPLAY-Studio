/** Review-only storage for signed standalone H3 returns. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { VIDEO_RETURN_BYTES_CAP, checkVideoReturn, measureVideo, readVideoReturn } from "./video-return.js";
import { readStoredVideoJob } from "./video-job.js";

const FP = /^[0-9a-f]{32}$/;
const NAME = /^peer_([0-9a-f]{32})_(o_[0-9a-f]{12})_([0-9a-f]{64})\.mp4$/;
const ROW_CAP = 32 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function refuse(reason, message, status = 400) { const e = new Error(message); e.reason = reason; e.status = status; return e; }
function paths(outDir, fp, file) {
  const match = NAME.exec(String(file || ""));
  if (!FP.test(String(fp || "")) || !match || match[1] !== fp) throw refuse("bad-arguments", "Choose a returned video belonging to this friend.");
  const clip = path.join(outDir, "video-quarantine", fp, file);
  return { clip, sidecar: `${clip}.json`, name: file, orderId: match[2], sha256: match[3] };
}
async function boundedRead(file, cap) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > cap) throw refuse("stored-video-size", "The stored video is missing or exceeds its byte limit.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size < 1 || current.size > cap) throw refuse("stored-video-size", "The video changed while being read.");
    const bytes = Buffer.alloc(current.size);
    for (let at = 0; at < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
      if (!bytesRead) throw refuse("stored-video-changed", "The video changed during its read.");
      at += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw refuse("stored-video-changed", "The video grew during its read.");
    return bytes;
  } finally { await handle.close(); }
}
async function readRow(outDir, fp, file) {
  const p = paths(outDir, fp, file);
  let row;
  try { row = JSON.parse((await boundedRead(p.sidecar, ROW_CAP)).toString("utf8")); }
  catch (e) { if (e.code === "ENOENT") throw refuse("no-such-video-return", "No returned video is waiting there.", 404); if (e.reason) throw e; throw refuse("video-row-unreadable", "The video review record is unreadable.", 500); }
  if (row?.v !== 1 || row.type !== "video" || row.file !== p.name || row.from !== fp || row.orderId !== p.orderId || row.sha256 !== p.sha256 || typeof row.ok !== "boolean" || typeof row.adopted !== "boolean" || !Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > VIDEO_RETURN_BYTES_CAP) throw refuse("video-row-unreadable", "The video review record and file name disagree.", 500);
  return { p, row };
}
async function writeRow(file, row) {
  const body = JSON.stringify(row, null, 2);
  if (Buffer.byteLength(body) > ROW_CAP) throw refuse("video-row-too-large", "The video review record is too large.");
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  try { await writeFile(tmp, body, { flag: "wx" }); await rename(tmp, file); }
  catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
}
let tail = Promise.resolve();
function enqueue(fn) { const next = tail.then(fn, fn); tail = next.then(() => {}, () => {}); return next; }

export async function landVideoReturn({ outDir, payload, orderDoc, orderToFp, fromFp, toFp, now = Date.now(), measure = measureVideo } = {}) {
  return enqueue(async () => {
    const order = readStoredVideoJob(orderDoc);
    const { doc, bytes } = readVideoReturn(payload);
    if (![orderToFp, fromFp, toFp].every((fp) => FP.test(String(fp))) || order.id !== doc.orderId || doc.from !== orderToFp || doc.from !== fromFp || doc.to !== order.returnTo.fp || doc.to !== toFp) throw refuse("return-association", "The returned video does not match the signed order and verified peers.");
    const verdict = await checkVideoReturn({ returnDoc: doc, orderDoc: order, orderToFp, fromFp, toFp, measure });
    const name = `peer_${fromFp}_${doc.orderId}_${doc.result.sha256}.mp4`;
    const p = paths(outDir, fromFp, name);
    await mkdir(path.dirname(p.clip), { recursive: true });
    const old = await readRow(outDir, fromFp, name).then((v) => v.row).catch((e) => { if (e.reason === "no-such-video-return") return null; throw e; });
    if (old) {
      const stored = await boundedRead(p.clip, VIDEO_RETURN_BYTES_CAP);
      if (hash(stored) !== old.sha256 || !stored.equals(bytes)) throw refuse("result-hash", "The quarantined video changed before replay.");
      return { ...old, replay: true };
    }
    try { await writeFile(p.clip, bytes, { flag: "wx" }); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      const stored = await boundedRead(p.clip, VIDEO_RETURN_BYTES_CAP);
      if (!stored.equals(bytes)) throw refuse("video-file-collision", "A different video already uses this review name.", 409);
    }
    const row = { v: 1, type: "video", orderId: doc.orderId, from: fromFp, file: name, bytes: bytes.length, sha256: doc.result.sha256,
      at: Number.isSafeInteger(now) && now > 0 ? now : Date.now(), prompt: order.job.prompt, record: doc.record,
      measured: verdict.measured || null, ok: verdict.ok, reason: verdict.reason, why: verdict.why, adopted: false };
    await writeRow(p.sidecar, row);
    return row;
  });
}

export async function listVideoQuarantine({ outDir } = {}) {
  const root = path.join(outDir, "video-quarantine");
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !FP.test(dir.name)) continue;
    const names = await readdir(path.join(root, dir.name));
    for (const sidecar of names.filter((name) => name.endsWith(".mp4.json"))) {
      const name = sidecar.slice(0, -5);
      try { rows.push((await readRow(outDir, dir.name, name)).row); }
      catch (e) { rows.push({ v: 0, type: "video", from: dir.name, file: name, ok: false, reason: e.reason || "row-unreadable", adopted: false }); }
    }
  }
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
}

export async function videoQuarantineClip({ outDir, fromFp, file } = {}) {
  const { p, row } = await readRow(outDir, fromFp, file);
  if (!row.ok) throw refuse("return-refused", "This video did not pass checks and cannot be previewed.", 403);
  const bytes = await boundedRead(p.clip, VIDEO_RETURN_BYTES_CAP);
  if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw refuse("result-hash", "The video changed after review.");
  return { bytes, row };
}

export async function adoptVideoReturn({ outDir, clipDir, fromFp, file, now = Date.now(), persistMetadata = null, measure = measureVideo } = {}) {
  return enqueue(async () => {
    const { p, row } = await readRow(outDir, fromFp, file);
    if (!row.ok) throw refuse("return-refused", "This video failed its checks and cannot be adopted.");
    const bytes = await boundedRead(p.clip, VIDEO_RETURN_BYTES_CAP);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw refuse("result-hash", "The video changed after review.");
    const measured = await measure(bytes);
    if (!row.measured || measured.width !== row.measured.width || measured.height !== row.measured.height || measured.frames !== row.measured.frames || measured.audioStreams !== row.measured.audioStreams) throw refuse("video-measure-changed", "The decoded video differs from the reviewed result.");
    await mkdir(clipDir, { recursive: true });
    const dest = path.join(clipDir, p.name);
    try { await writeFile(dest, bytes, { flag: "wx" }); }
    catch (e) { if (e.code !== "EEXIST") throw e; if (!(await boundedRead(dest, VIDEO_RETURN_BYTES_CAP)).equals(bytes)) throw refuse("video-library-collision", "A different library clip already has this name.", 409); }
    const at = row.adopted ? row.adoptedAt : now;
    const metadata = { source: "peer-video", peer: { fp: fromFp, orderId: row.orderId }, prompt: row.prompt,
      seed: row.record.seed, engine: row.record.engine, model: row.record.model, modelVersion: row.record.modelVersion, modelSha256: row.record.modelSha256,
      modelPolicy: row.record.modelPolicy, outputRights: row.record.outputRights, width: measured.width, height: measured.height, frames: measured.frames,
      clipSeconds: measured.seconds, steps: row.record.steps, guidance: row.record.guidance, keepAudio: row.record.keepAudio, at };
    if (persistMetadata) await persistMetadata({ name: p.name, file: dest, metadata });
    if (!row.adopted) await writeRow(p.sidecar, { ...row, adopted: true, adoptedAt: at, adoptedAs: p.name });
    return { name: p.name, file: dest, metadata, row: { ...row, adopted: true, adoptedAt: at }, replay: row.adopted };
  });
}

export async function dropVideoReturn({ outDir, fromFp, file } = {}) {
  return enqueue(async () => {
    const { p, row } = await readRow(outDir, fromFp, file);
    if (row.adopted) throw refuse("already-adopted", "An adopted video's audit record remains.", 409);
    await rm(p.clip, { force: true }); await rm(p.sidecar, { force: true });
    return { dropped: p.name };
  });
}
