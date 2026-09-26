/**
 * A returned image stays separate from the image library until its owner
 * reviews and adopts it. The courier route verifies the sealed envelopes and
 * supplies their authenticated fingerprints; this store checks the result
 * against the signed order and measures the PNG on this machine. The lender's
 * model and rights record is preserved as provenance, never inferred locally.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_RETURN_BYTES_CAP, checkImageReturn, inspectPng, measurePng, readImageReturn } from "./image-return.js";
import { readStoredImageJob } from "./image-job.js";

const FP_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^peer_([0-9a-f]{32})_(o_[0-9a-f]{12})_([0-9a-f]{64})\.png$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ROW_BYTES_CAP = 32 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function refuse(reason, message, status = 400) {
  const error = new Error(message);
  error.reason = reason;
  error.status = status;
  return error;
}

function safeFp(fp) {
  if (!FP_RE.test(String(fp || ""))) throw refuse("bad-arguments", "A full lowercase peer fingerprint is required.");
  return fp;
}

function safeName(fp, file) {
  safeFp(fp);
  const name = String(file || "");
  const match = NAME_RE.exec(name);
  if (!match || match[1] !== fp) throw refuse("bad-arguments", "This is not an image returned by that friend.");
  return { name, orderId: match[2], sha256: match[3] };
}

/** `outDir` is already `<output>/collab`, as in the video courier. */
export const imageQuarantineDir = (outDir, fp) => path.join(outDir, "image-quarantine", safeFp(fp));
export const imageQuarantineName = (fp, orderId, digest) => {
  const name = `peer_${safeFp(fp)}_${String(orderId)}_${String(digest)}.png`;
  safeName(fp, name);
  return name;
};

function paths(outDir, fp, file) {
  const { name, orderId, sha256: digest } = safeName(fp, file);
  const picture = path.join(imageQuarantineDir(outDir, fp), name);
  return { name, orderId, digest, picture, sidecar: `${picture}.json` };
}

/** Read with a hard cap even if a file changes after its initial stat. */
async function boundedRead(file, cap) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > cap) {
    throw refuse("stored-image-size", "The stored file is not a regular file within its byte limit.");
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size < 1 || current.size > cap) {
      throw refuse("stored-image-size", "The stored file changed or exceeds its byte limit.");
    }
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw refuse("stored-image-changed", "The stored file changed while it was read.");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead) {
      throw refuse("stored-image-changed", "The stored file grew while it was read.");
    }
    return bytes;
  } finally { await handle.close(); }
}

async function readRow(where, fp, file) {
  const p = paths(where, fp, file);
  let row;
  try { row = JSON.parse((await boundedRead(p.sidecar, ROW_BYTES_CAP)).toString("utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw refuse("no-such-image-return", "That returned image is not in quarantine.", 404);
    if (error?.reason) throw error;
    throw refuse("image-row-unreadable", "The returned image's review record cannot be read. Nothing was changed.", 500);
  }
  if (!row || row.v !== 1 || row.type !== "image" || row.file !== p.name || row.from !== fp
      || row.orderId !== p.orderId || row.sha256 !== p.digest || !SHA_RE.test(row.sha256)
      || !Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > IMAGE_RETURN_BYTES_CAP
      || typeof row.ok !== "boolean" || typeof row.adopted !== "boolean"
      || !row.record || typeof row.record !== "object" || Array.isArray(row.record)) {
    throw refuse("image-row-unreadable", "The returned image's review record disagrees with its file name. Nothing was changed.", 500);
  }
  return { p, row };
}

async function writeRow(file, row) {
  const text = JSON.stringify(row, null, 2);
  if (Buffer.byteLength(text) > ROW_BYTES_CAP) throw refuse("image-row-too-large", "The image review record exceeds its storage limit.");
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, text, { encoding: "utf8", flag: "wx" });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

let tail = Promise.resolve();
function enqueue(fn) {
  const next = tail.then(fn, fn);
  tail = next.then(() => {}, () => {});
  return next;
}

/**
 * Land a signed return for human review. `fromFp` is the VERIFIED return
 * signer, `orderToFp` is the VERIFIED original order recipient, and `toFp`
 * is this Studio. A bad measured canvas remains in quarantine with its reason;
 * a malformed or unsigned-context packet is refused before touching disk.
 */
export async function landImageReturn({ outDir, payload, orderDoc, orderToFp, fromFp, toFp,
  now = Date.now(), measure = measurePng } = {}) {
  return enqueue(async () => {
    safeFp(fromFp); safeFp(orderToFp); safeFp(toFp);
    const signedOrder = readStoredImageJob(orderDoc);
    const { doc, bytes } = readImageReturn(payload);
    if (signedOrder.id !== doc.orderId || doc.from !== fromFp || doc.from !== orderToFp
        || doc.to !== toFp || signedOrder.returnTo.fp !== toFp) {
      throw refuse("return-association", "This image return does not match the verified sender, recipient and signed order. Nothing was stored.");
    }
    const verdict = await checkImageReturn({ returnDoc: doc, orderDoc: signedOrder,
      orderToFp, fromFp, toFp, measure });
    const name = imageQuarantineName(fromFp, doc.orderId, doc.result.sha256);
    const p = paths(outDir, fromFp, name);
    await mkdir(path.dirname(p.picture), { recursive: true });
    const prior = await readRow(outDir, fromFp, name).then(({ row }) => row).catch((error) => {
      if (error.reason === "no-such-image-return") return null;
      throw error;
    });
    if (prior) {
      const stored = await boundedRead(p.picture, IMAGE_RETURN_BYTES_CAP);
      if (stored.length !== prior.bytes || sha256(stored) !== prior.sha256) {
        throw refuse("result-hash", "The quarantined image changed before this replay. Nothing was overwritten.");
      }
      return { ...prior, replay: true };
    }
    try { await writeFile(p.picture, bytes, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stored = await boundedRead(p.picture, IMAGE_RETURN_BYTES_CAP);
      if (sha256(stored) !== doc.result.sha256 || !stored.equals(bytes)) {
        throw refuse("image-file-collision", "A different image already occupies this content-derived name. Nothing was overwritten.", 409);
      }
    }
    const row = {
      v: 1, type: "image", orderId: doc.orderId, from: fromFp,
      at: Number.isSafeInteger(now) && now > 0 ? now : Date.now(),
      file: name, bytes: bytes.length, sha256: doc.result.sha256,
      prompt: signedOrder.job.prompt,
      measured: verdict.measured || null, record: doc.record,
      ok: verdict.ok, reason: verdict.reason, why: verdict.why,
      adopted: false,
    };
    await writeRow(p.sidecar, row);
    return row;
  });
}

/** Read the review queue, including unreadable sidecars as explicit failures. */
export async function listImageQuarantine({ outDir } = {}) {
  const root = path.join(outDir, "image-quarantine");
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw refuse("image-quarantine-unreadable", "The image quarantine cannot be listed.", 500);
  }
  const rows = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !FP_RE.test(dir.name)) continue;
    let names;
    try { names = await readdir(path.join(root, dir.name)); }
    catch { rows.push({ v: 0, from: dir.name, ok: false, reason: "folder-unreadable", adopted: false }); continue; }
    for (const sidecar of names.filter((name) => name.endsWith(".png.json"))) {
      const name = sidecar.slice(0, -5);
      try { rows.push((await readRow(outDir, dir.name, name)).row); }
      catch (error) { rows.push({ v: 0, from: dir.name, file: name,
        ok: false, reason: error.reason || "row-unreadable", adopted: false,
        why: "This image's review record is unreadable. The picture was not adopted." }); }
    }
    for (const name of names.filter((name) => name.endsWith(".png") && !names.includes(`${name}.json`))) {
      if (!NAME_RE.test(name)) continue;
      rows.push({ v: 0, from: dir.name, file: name, ok: false,
        reason: "row-missing", adopted: false,
        why: "This returned image has no review record. It cannot be adopted." });
    }
  }
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** A review-only PNG location for the caller's authenticated preview route. */
export async function imageQuarantinePicture({ outDir, fromFp, file } = {}) {
  const { p, row } = await readRow(outDir, fromFp, file);
  if (!row.ok) throw refuse("return-refused", "This returned image failed its checks and cannot be previewed by the browser.", 403);
  const info = await lstat(p.picture).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== row.bytes
      || info.size > IMAGE_RETURN_BYTES_CAP) {
    throw refuse("stored-image-size", "The returned picture is missing or has changed. Nothing was shown.", 404);
  }
  const bytes = await boundedRead(p.picture, IMAGE_RETURN_BYTES_CAP);
  if (sha256(bytes) !== row.sha256) {
    throw refuse("result-hash", "The returned picture changed after it was measured. Nothing was shown.");
  }
  // Serve exactly the bytes that passed the hash check. Reopening the path
  // after validation would allow a local writer to swap the previewed image.
  return { file: p.picture, bytes, size: bytes.length, type: "image/png", row };
}

/** Explicitly copy a checked PNG into the image library; caller persists metadata. */
export async function adoptImageReturn({ outDir, imageDir, fromFp, file,
  now = Date.now(), measure = measurePng, persistMetadata = null,
  allowAlreadyAdopted = false } = {}) {
  return enqueue(async () => {
    const { p, row } = await readRow(outDir, fromFp, file);
    if (row.adopted && !allowAlreadyAdopted) throw refuse("already-adopted", "This returned image was already added to the library.", 409);
    if (!row.ok) throw refuse("return-refused", `This returned image did not pass its checks: ${row.why}`);
    const bytes = await boundedRead(p.picture, IMAGE_RETURN_BYTES_CAP);
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) {
      throw refuse("result-hash", "The image in quarantine changed after review. Nothing was adopted.");
    }
    inspectPng(bytes);
    const measured = await measure(bytes);
    if (!row.measured || !measured || measured.width !== row.measured.width
        || measured.height !== row.measured.height || measured.codec !== "png"
        || measured.frames !== 1 || measured.opaque !== true
        || measured.decodedBytes !== row.measured.decodedBytes) {
      throw refuse("image-measure-changed", "The image no longer measures like the reviewed PNG. Nothing was adopted.");
    }
    if (typeof imageDir !== "string" || !imageDir) throw refuse("bad-arguments", "The image library directory is required.");
    await mkdir(imageDir, { recursive: true });
    const dest = path.join(imageDir, p.name);
    /* Write the bytes we just hashed and decoded. Reopening the quarantine
     * path here would let a local replacement race put different pixels into
     * the library under the reviewed picture's metadata. */
    try { await writeFile(dest, bytes, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await boundedRead(dest, IMAGE_RETURN_BYTES_CAP);
      if (!existing.equals(bytes)) {
        throw refuse("image-library-collision", "A different image already has this library name. Nothing was overwritten.", 409);
      }
    }
    const at = row.adopted && Number.isSafeInteger(row.adoptedAt) ? row.adoptedAt
      : Number.isSafeInteger(now) && now > 0 ? now : Date.now();
    const metadata = {
      source: "peer-image", peer: { fp: fromFp, orderId: row.orderId },
      prompt: row.prompt,
      seed: row.record.seed, width: measured.width, height: measured.height,
      engine: row.record.engine, model: row.record.model,
      modelVersion: row.record.modelVersion, modelSha256: row.record.modelSha256,
      modelPolicy: row.record.modelPolicy, outputRights: row.record.outputRights,
      steps: row.record.steps, cfg: row.record.cfg, sampler: row.record.sampler,
      scheduler: row.record.scheduler, referenceSha256s: row.record.referenceSha256s,
      at,
    };
    const next = row.adopted ? row : { ...row, adopted: true, adoptedAt: at, adoptedAs: p.name };
    /* A copied PNG is retryable. An adopted review row is not: persist the
     * model and rights record first so a failed metadata write never turns a
     * retryable copy into an orphan with an irrevocable "adopted" verdict. */
    if (persistMetadata) await persistMetadata({ name: p.name, file: dest, metadata });
    if (!row.adopted) await writeRow(p.sidecar, next);
    return { file: dest, name: p.name, row: next, metadata, replay: row.adopted };
  });
}

/** Delete a pending result and its review record; an adopted audit is retained. */
export async function dropImageReturn({ outDir, fromFp, file } = {}) {
  return enqueue(async () => {
    const { p, row } = await readRow(outDir, fromFp, file);
    if (row.adopted) throw refuse("already-adopted", "This image is in the library; its adoption record stays in quarantine.", 409);
    await rm(p.picture, { force: true });
    await rm(p.sidecar, { force: true });
    return { dropped: p.name };
  });
}
