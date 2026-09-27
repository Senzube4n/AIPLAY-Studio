/**
 * A standalone Qwen image return. This is deliberately separate from the
 * movie-scene return in order.js. The courier must first verify both sealed
 * envelopes and supply their authenticated fingerprints to checkImageReturn.
 * A passing check still leaves the image in quarantine for a human to review.
 */
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpegPath, ffprobePath } from "../clipjoin.js";
import { readStoredImageJob } from "./image-job.js";

export const IMAGE_RETURN_V = 1;
export const IMAGE_RETURN_BYTES_CAP = 64 * 1024 * 1024;
export const IMAGE_RETURN_DECODE_TIMEOUT_MS = 30_000;

const FP_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^o_[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79})?$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TOP_KEYS = ["v", "kind", "jobType", "orderId", "from", "to", "at", "result", "record"];
const RESULT_KEYS = ["mime", "sha256", "bytes", "b64"];
const RECORD_KEYS = ["engine", "model", "modelVersion", "modelSha256", "modelPolicy", "seed",
  "width", "height", "steps", "cfg", "sampler", "scheduler", "count", "refSizing",
  "draft", "transparent", "negative", "referenceSha256s", "outputRights"];
const JOB_RECORD_KEYS = ["engine", "modelPolicy", "seed", "width", "height", "steps", "cfg",
  "sampler", "scheduler", "count", "refSizing", "draft", "transparent", "negative"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function refuse(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw refuse("bad-image-return", `${label} must be an object.`);
  }
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (extra.length || missing.length) {
    throw refuse("bad-image-return", `${label} has ${extra.length ? `unrecognised fields: ${extra.join(", ")}` : `missing fields: ${missing.join(", ")}`}. Nothing was adopted.`);
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(bytes, begin, end) {
  let c = 0xffffffff;
  for (let i = begin; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Check every PNG chunk, its CRC and the final IEND before invoking a decoder.
 * An IHDR alone is not evidence that the pixels can be decoded. */
export function inspectPng(bytes) {
  if (Buffer.isBuffer(bytes) && bytes.length > IMAGE_RETURN_BYTES_CAP) {
    throw refuse("return-too-big", "The image return exceeds the 64 MiB byte limit.");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw refuse("result-not-png", "The returned image is not a PNG file. Nothing was adopted.");
  }
  let offset = 8, width = 0, height = 0, ihdr = false, idat = false, ended = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw refuse("png-integrity", "The PNG ends inside a chunk. Nothing was adopted.");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length || end < offset) throw refuse("png-integrity", "A PNG chunk exceeds the file. Nothing was adopted.");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes, offset + 4, offset + 8 + length) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw refuse("png-integrity", "The PNG has a damaged chunk or checksum. Nothing was adopted.");
    }
    if (!ihdr && (type !== "IHDR" || length !== 13)) throw refuse("png-integrity", "The PNG has no valid first IHDR chunk.");
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const nul = data.indexOf(0);
      const keyword = nul > 0 ? data.subarray(0, nul).toString("latin1") : "";
      if (keyword !== "XML:com.adobe.xmp") {
        throw refuse("result-metadata", "The returned PNG still contains text metadata, which may expose a private render graph. Nothing was sealed or adopted.");
      }
    }
    if (type === "IHDR") {
      if (ihdr || length !== 13) throw refuse("png-integrity", "The PNG has an invalid or repeated IHDR chunk.");
      ihdr = true;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 1_048_576) {
        throw refuse("image-canvas", "The PNG canvas exceeds this image job's bounded sizes.");
      }
    } else if (type === "IDAT") {
      idat = true;
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw refuse("result-animated", "An image job returns one still PNG, not an animated PNG.");
    } else if (type === "IEND") {
      if (length !== 0 || !idat || end !== bytes.length) throw refuse("png-integrity", "The PNG has no valid final IEND chunk.");
      ended = true;
    }
    offset = end;
    if (ended) break;
  }
  if (!ended) throw refuse("png-integrity", "The PNG is missing its final IEND chunk.");
  return { width, height };
}

function runProbe(file, bin, timeoutMs) {
  return new Promise((resolve) => execFile(bin, ["-v", "error", "-count_frames", "-show_entries",
    "stream=codec_name,width,height,nb_read_frames", "-of", "json", file],
  { timeout: timeoutMs, maxBuffer: 128 * 1024, windowsHide: true },
  (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") })));
}

function runDecode(file, bin, expectedBytes, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
      "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0, stderr = "", done = false, timedOut = false;
    const finish = (error, rgba = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ error, rgba, stderr });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > expectedBytes) { child.kill(); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on("close", (code) => {
      if (timedOut) return finish(refuse("decoder-timeout", "The PNG decoder timed out. Nothing was adopted."));
      if (size !== expectedBytes || code !== 0) return finish(refuse("image-decode-failed", "The PNG could not be fully decoded. Nothing was adopted."));
      finish(null, Buffer.concat(chunks, size));
    });
  });
}

/** Independently measure the canvas and fully decode all pixels under a timeout.
 * This app does not bundle ffmpeg; an unavailable decoder is a refusal, not a
 * reason to trust a sender's claimed dimensions. */
export async function measurePng(bytes, { ffprobe = null, ffmpeg = null,
  timeoutMs = IMAGE_RETURN_DECODE_TIMEOUT_MS } = {}) {
  const header = inspectPng(bytes);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw refuse("bad-arguments", "The PNG decoder timeout must be 1–60,000 ms.");
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-image-return-"));
  const file = path.join(dir, "returned.png");
  try {
    await writeFile(file, bytes);
    const probe = await runProbe(file, ffprobePath(ffprobe), timeoutMs);
    if (probe.error) {
      const missing = probe.error.code === "ENOENT";
      throw refuse(missing ? "decoder-unavailable" : "image-probe-failed",
        missing ? "ffprobe is unavailable; the PNG could not be measured, so nothing was adopted."
          : "ffprobe could not measure the PNG. Nothing was adopted.");
    }
    let streams;
    try { streams = JSON.parse(probe.stdout).streams; } catch { /* refused below */ }
    if (!Array.isArray(streams) || streams.length !== 1 || streams[0]?.codec_name !== "png") {
      throw refuse("image-probe-failed", "The returned file did not measure as one PNG image.");
    }
    const measured = { width: streams[0].width, height: streams[0].height };
    if (!Number.isInteger(measured.width) || !Number.isInteger(measured.height)
        || measured.width !== header.width || measured.height !== header.height
        || (streams[0].nb_read_frames && Number(streams[0].nb_read_frames) !== 1)) {
      throw refuse("image-probe-disagrees", "The PNG header and independent image measurement disagree. Nothing was adopted.");
    }
    const decoded = await runDecode(file, ffmpegPath(ffmpeg), measured.width * measured.height * 4, timeoutMs);
    if (decoded.error) {
      if (decoded.error.code === "ENOENT") throw refuse("decoder-unavailable", "ffmpeg is unavailable; the PNG could not be decoded, so nothing was adopted.");
      throw decoded.error;
    }
    for (let index = 3; index < decoded.rgba.length; index += 4) {
      if (decoded.rgba[index] !== 255) throw refuse("image-not-opaque", "The returned PNG contains transparency, but the order asked for an opaque image.");
    }
    return { ...measured, codec: "png", frames: 1, opaque: true, decodedBytes: decoded.rgba.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function checkRecord(record) {
  exactObject(record, RECORD_KEYS, "Image model record");
  if (record.engine !== "qwen-image-2.1" || record.modelPolicy !== "receiver-local-base"
      || typeof record.model !== "string" || !MODEL_RE.test(record.model)
      || (record.modelVersion !== null && (typeof record.modelVersion !== "string" || !record.modelVersion
        || record.modelVersion.length > 100 || /[\\\u0000-\u001f\u007f]/.test(record.modelVersion)))
      || (record.modelSha256 !== null && !SHA_RE.test(String(record.modelSha256)))) {
    throw refuse("record-model", "The return needs a bounded Qwen model identity, version and optional SHA-256 fingerprint.");
  }
  if (!Array.isArray(record.referenceSha256s) || record.referenceSha256s.length > 3
      || record.referenceSha256s.some((sha) => !SHA_RE.test(String(sha)))) {
    throw refuse("record-references", "The model record must name each source picture by SHA-256, in order.");
  }
  const rights = record.outputRights;
  let rightsJson;
  try { rightsJson = JSON.stringify(rights); } catch { /* refused below */ }
  if (!rights || typeof rights !== "object" || Array.isArray(rights)
      || typeof rights.class !== "string" || !rights.class || rights.class.length > 80
      || !rightsJson || rightsJson.length > 4000) {
    throw refuse("record-no-rights", "The lender's model rights stamp is missing or too large to review.");
  }
}

/** Shape, canonical bytes, SHA-256 and PNG structure; no file is written. */
export function readImageReturn(payload) {
  exactObject(payload, payload?.by === undefined ? TOP_KEYS : [...TOP_KEYS, "by"], "Image return");
  if (payload.by !== undefined) {
    exactObject(payload.by, ["app", "commit", "protocol"], "Build caption");
    if (typeof payload.by.app !== "string" || payload.by.app.length > 100
        || (payload.by.commit !== null && (typeof payload.by.commit !== "string" || payload.by.commit.length > 80))
        || !Number.isSafeInteger(payload.by.protocol) || payload.by.protocol < 1) {
      throw refuse("bad-image-return", "The sender's build caption is invalid.");
    }
  }
  if (payload.v !== IMAGE_RETURN_V || payload.kind !== "job-return" || payload.jobType !== "image") {
    throw refuse("not-an-image-return", `This is not an image job return version ${IMAGE_RETURN_V}.`);
  }
  if (!ID_RE.test(String(payload.orderId)) || !FP_RE.test(String(payload.from))
      || !FP_RE.test(String(payload.to)) || !Number.isSafeInteger(payload.at) || payload.at < 1) {
    throw refuse("bad-image-return", "The image return needs an order id, both fingerprints and an integer time.");
  }
  exactObject(payload.result, RESULT_KEYS, "Image result");
  const result = payload.result;
  if (result.mime !== "image/png" || !Number.isInteger(result.bytes) || result.bytes < 1
      || result.bytes > IMAGE_RETURN_BYTES_CAP || !SHA_RE.test(String(result.sha256))) {
    throw refuse("result-metadata", "The image result must be a PNG of at most 64 MiB with a SHA-256 fingerprint.");
  }
  if (typeof result.b64 !== "string" || result.b64.length > Math.ceil(IMAGE_RETURN_BYTES_CAP / 3) * 4) {
    throw refuse("return-too-big", "The image return exceeds the 64 MiB encoded byte limit.");
  }
  const bytes = Buffer.from(result.b64, "base64");
  if (bytes.length !== result.bytes || bytes.toString("base64") !== result.b64) {
    throw refuse("result-bytes", "The image's encoded bytes do not match its declared size.");
  }
  if (hash(bytes) !== result.sha256) throw refuse("result-hash", "The returned PNG disagrees with its SHA-256 fingerprint.");
  inspectPng(bytes);
  checkRecord(payload.record);
  return { doc: payload, bytes };
}

const bad = (reason, why, measured = null) => ({ ok: false, disposition: "quarantine", reason, why, measured });

/** Compare a return with the signed order row and the two VERIFIED envelope
 * fingerprints. `orderToFp` is the original order's signed recipient; `fromFp`
 * is the verified return envelope's signer; `toFp` is this Studio. A string in
 * the return document alone is never proof of the sender. */
export async function checkImageReturn({ returnDoc, orderDoc, orderToFp, fromFp, toFp,
  measure = measurePng } = {}) {
  let parsed, order;
  try {
    parsed = readImageReturn(returnDoc);
    if (!orderDoc) return bad("return-unknown-order", "No signed image order was found for this return. Nothing was adopted.");
    order = readStoredImageJob(orderDoc);
  } catch (error) { return bad(error.reason || "bad-image-return", error.message); }
  const { doc, bytes } = parsed;
  if (![orderToFp, fromFp, toFp].every((fp) => FP_RE.test(String(fp || "")))) {
    return bad("unverified-return-context", "The original order recipient, verified return signer and local recipient must all be known before accepting an image return.");
  }
  if (doc.orderId !== order.id) return bad("return-unknown-order", "This image answers a different order id. Nothing was adopted.");
  if (doc.to !== order.returnTo.fp || doc.to !== toFp) return bad("return-not-for-me", "The image return's recipient differs from the signed order or this Studio.");
  if (doc.from !== fromFp || doc.from !== orderToFp) return bad("return-not-my-order", "The image came from a different peer than the one this order was sent to.");
  for (const key of JOB_RECORD_KEYS) {
    if (doc.record[key] !== order.job[key]) return bad("record-settings", `The returned ${key} differs from the signed image order. Nothing was adopted.`);
  }
  const requestedRefs = order.job.references.map((ref) => ref.sha256);
  if (JSON.stringify(doc.record.referenceSha256s) !== JSON.stringify(requestedRefs)) {
    return bad("record-references", "The returned reference image sequence differs from the signed order.");
  }
  let measured;
  try { measured = await measure(bytes); }
  catch (error) { return bad(error.reason || "image-decode-failed", error.message || "The PNG could not be decoded."); }
  if (!measured || measured.width !== order.job.width || measured.height !== order.job.height) {
    return bad("image-canvas", `The decoded PNG is ${measured?.width ?? "?"}×${measured?.height ?? "?"}; the signed order asked for ${order.job.width}×${order.job.height}.`, measured || null);
  }
  if (measured.codec !== "png" || measured.frames !== 1 || measured.opaque !== true
      || measured.decodedBytes !== order.job.width * order.job.height * 4) {
    return bad("image-decode-failed", "The result was not independently decoded as one complete opaque PNG.", measured);
  }
  return { ok: true, disposition: "quarantine", reason: null,
    why: "The signed order, peer identities, Qwen settings, model record, PNG hash and fully decoded canvas agree. Review this image before using it.", measured };
}

/** Build a return only after applying the same receiver-side checks locally. */
export async function makeImageReturn({ orderDoc, fromFp, resultBytes, record, now = 0,
  measure = measurePng } = {}) {
  const order = readStoredImageJob(orderDoc);
  if (!Buffer.isBuffer(resultBytes) || resultBytes.length < 1 || resultBytes.length > IMAGE_RETURN_BYTES_CAP) {
    throw refuse("return-too-big", "Pass one finished PNG Buffer of at most 64 MiB.");
  }
  if (!FP_RE.test(String(fromFp)) || !Number.isSafeInteger(now) || now < 1) {
    throw refuse("bad-arguments", "Pass the lender's fingerprint and a positive integer time.");
  }
  const doc = {
    v: IMAGE_RETURN_V, kind: "job-return", jobType: "image", orderId: order.id,
    from: fromFp, to: order.returnTo.fp, at: now,
    result: { mime: "image/png", sha256: hash(resultBytes), bytes: resultBytes.length,
      b64: resultBytes.toString("base64") },
    record,
  };
  const verdict = await checkImageReturn({ returnDoc: doc, orderDoc: order,
    orderToFp: fromFp, fromFp, toFp: order.returnTo.fp, measure });
  if (!verdict.ok) throw refuse(verdict.reason, verdict.why);
  return doc;
}
