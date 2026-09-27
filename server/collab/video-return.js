/** Signed standalone video result, checked against the saved signed request. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpegPath, probeClip } from "../clipjoin.js";
import { alignFrames } from "../workflow.js";
import { readStoredVideoJob } from "./video-job.js";

export const VIDEO_RETURN_V = 1;
export const VIDEO_RETURN_BYTES_CAP = 64 * 1024 * 1024;
const FP = /^[0-9a-f]{32}$/;
const ID = /^o_[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TOP = ["v", "kind", "jobType", "orderId", "from", "to", "at", "result", "record"];
const RESULT = ["mime", "bytes", "sha256", "b64"];
const RECORD = ["engine", "modelPolicy", "model", "modelVersion", "modelSha256", "outputRights", "prompt", "seed", "width", "height", "seconds", "steps", "guidance", "keepAudio", "negative", "sparse", "attention", "blockCache", "bridge", "bridgeAlpha", "references", "loras"];
const COMPARE = ["engine", "modelPolicy", "prompt", "seed", "width", "height", "seconds", "steps", "guidance", "keepAudio", "negative", "sparse", "attention", "blockCache", "bridge", "bridgeAlpha", "references", "loras"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function refuse(reason, message) { const e = new Error(message); e.reason = reason; e.status = 400; return e; }
function exact(v, keys, label, optional = []) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw refuse("bad-video-return", `${label} must be an object.`);
  const extra = Object.keys(v).filter((k) => !keys.includes(k) && !optional.includes(k));
  const missing = keys.filter((k) => !Object.hasOwn(v, k));
  if (extra.length || missing.length) throw refuse("bad-video-return", `${label} has ${extra.length ? `unsupported fields: ${extra.join(", ")}` : `missing fields: ${missing.join(", ")}`}.`);
}
function mp4(bytes) { return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp"; }
function recordOK(record) {
  exact(record, RECORD, "Video render record");
  if (record.engine !== "h3" || record.modelPolicy !== "receiver-local-base" || !MODEL.test(String(record.model)) || !MODEL.test(String(record.modelVersion)) || (record.modelSha256 !== null && !SHA.test(String(record.modelSha256)))) throw refuse("record-model", "The H3 model identity or fingerprint is invalid.");
  const rights = record.outputRights;
  if (!rights || typeof rights !== "object" || Array.isArray(rights) || typeof rights.class !== "string" || !rights.class || JSON.stringify(rights).length > 4000) throw refuse("record-no-rights", "The lender's model rights record is missing.");
}
/** Canonical base64, bounded bytes and MP4 signature; does not write a file. */
export function readVideoReturn(payload) {
  exact(payload, TOP, "Video return", ["by"]);
  if (payload.v !== VIDEO_RETURN_V || payload.kind !== "job-return" || payload.jobType !== "video") throw refuse("not-a-video-return", "This is not a supported video job return.");
  if (!ID.test(String(payload.orderId)) || !FP.test(String(payload.from)) || !FP.test(String(payload.to)) || !Number.isSafeInteger(payload.at) || payload.at < 1) throw refuse("bad-video-return", "Return identity or timestamp is invalid.");
  exact(payload.result, RESULT, "Video result");
  const r = payload.result;
  if (r.mime !== "video/mp4" || !Number.isInteger(r.bytes) || r.bytes < 12 || r.bytes > VIDEO_RETURN_BYTES_CAP || !SHA.test(String(r.sha256))) throw refuse("result-metadata", "A video result must be a bounded MP4 with a SHA-256 fingerprint.");
  if (typeof r.b64 !== "string" || r.b64.length > Math.ceil(VIDEO_RETURN_BYTES_CAP / 3) * 4) throw refuse("return-too-big", "The encoded MP4 exceeds 64 MiB.");
  const bytes = Buffer.from(r.b64, "base64");
  if (bytes.length !== r.bytes || bytes.toString("base64") !== r.b64) throw refuse("result-bytes", "The encoded MP4 disagrees with its declared size.");
  if (hash(bytes) !== r.sha256) throw refuse("result-hash", "The returned MP4 disagrees with its SHA-256 fingerprint.");
  if (!mp4(bytes)) throw refuse("result-not-mp4", "The returned file has no MP4 container signature.");
  recordOK(payload.record);
  return { doc: payload, bytes };
}

function runDecode(file, { ffmpeg = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => execFile(ffmpegPath(ffmpeg), ["-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-f", "null", "-"],
    { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error) => resolve(error)));
}
/** Independently probe and fully decode the video stream. No sender metadata
 * is trusted for the width, frame count, frame rate or audio stream count. */
export async function measureVideo(bytes, { probe = probeClip, ffmpeg = null } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > VIDEO_RETURN_BYTES_CAP || !mp4(bytes)) throw refuse("result-not-mp4", "The video bytes are not a bounded MP4.");
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-video-return-"));
  const file = path.join(dir, "result.mp4");
  try {
    await writeFile(file, bytes);
    const measured = await probe(file);
    if (measured.error || measured.videoStreams !== 1 || measured.audioStreams > 1 || !Number.isInteger(measured.frames) || measured.frames < 1 || !Number.isFinite(measured.fps) || measured.fps <= 0) throw refuse("video-probe-failed", measured.error || "The returned MP4 must have one video stream, at most one audio stream and a measured frame count.");
    const error = await runDecode(file, { ffmpeg });
    if (error) throw refuse(error.code === "ENOENT" ? "decoder-unavailable" : "video-decode-failed", "The MP4 could not be fully decoded here, so it cannot be adopted.");
    return measured;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const bad = (reason, why, measured = null) => ({ ok: false, reason, why, measured, disposition: "quarantine" });
export async function checkVideoReturn({ returnDoc, orderDoc, orderToFp, fromFp, toFp, measure = measureVideo } = {}) {
  let parsed, order;
  try { parsed = readVideoReturn(returnDoc); order = readStoredVideoJob(orderDoc); }
  catch (e) { return bad(e.reason || "bad-video-return", e.message); }
  const { doc, bytes } = parsed;
  if (![orderToFp, fromFp, toFp].every((fp) => FP.test(String(fp || "")))) return bad("unverified-return-context", "The signed recipient and verified sender are required.");
  if (doc.orderId !== order.id || doc.from !== orderToFp || doc.from !== fromFp || doc.to !== order.returnTo.fp || doc.to !== toFp) return bad("return-association", "The return does not answer this signed order from its intended friend.");
  for (const key of COMPARE) if (JSON.stringify(doc.record[key]) !== JSON.stringify(order.job[key])) return bad("record-settings", `The rendered ${key} differs from the signed video request.`);
  let measured;
  try { measured = await measure(bytes); }
  catch (e) { return bad(e.reason || "video-decode-failed", e.message); }
  const expectedFrames = alignFrames(order.job.seconds, 24, "h3");
  if (measured.width !== order.job.width || measured.height !== order.job.height || measured.frames !== expectedFrames || Math.abs(measured.fps - 24) > 0.01 || measured.audioStreams !== Number(order.job.keepAudio)) return bad("video-measure-disagrees", `The decoded MP4 does not match the requested ${order.job.width}×${order.job.height}, ${expectedFrames} frames at 24 fps and audio choice.`, measured);
  return { ok: true, reason: null, why: "Signed sender, order settings, MP4 hash and independently decoded clip agree. Review before adoption.", measured, disposition: "quarantine" };
}

export async function makeVideoReturn({ orderDoc, fromFp, resultBytes, record, now = Date.now(), measure = measureVideo } = {}) {
  const order = readStoredVideoJob(orderDoc);
  if (!FP.test(String(fromFp)) || !Buffer.isBuffer(resultBytes) || resultBytes.length > VIDEO_RETURN_BYTES_CAP || !Number.isSafeInteger(now) || now < 1) throw refuse("bad-arguments", "A video return needs the lender, bounded MP4 bytes and a timestamp.");
  const doc = { v: VIDEO_RETURN_V, kind: "job-return", jobType: "video", orderId: order.id, from: fromFp, to: order.returnTo.fp, at: now,
    result: { mime: "video/mp4", bytes: resultBytes.length, sha256: hash(resultBytes), b64: resultBytes.toString("base64") }, record };
  const verdict = await checkVideoReturn({ returnDoc: doc, orderDoc: order, orderToFp: fromFp, fromFp, toFp: order.returnTo.fp, measure });
  if (!verdict.ok) throw refuse(verdict.reason, verdict.why);
  return doc;
}
