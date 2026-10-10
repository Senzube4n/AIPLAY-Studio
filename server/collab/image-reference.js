/**
 * Independently measure and decode a peer image job's source pictures before
 * staging them for ComfyUI. `readImageJob` verifies the signed packet's byte
 * count, MIME and hash; none of those prove its compressed pixels are safe to
 * open. This preflight reads the container dimensions *before* invoking a
 * decoder, then requires ffprobe to see exactly one frame and ffmpeg to emit
 * every RGBA pixel under one shared deadline. Missing tools fail closed.
 */
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpegPath, ffprobePath } from "../clipjoin.js";
import { IMAGE_JOB_REF_BYTES_CAP, IMAGE_JOB_REF_CAP } from "./image-job.js";

export const IMAGE_REFERENCE_MAX_SIDE = 4096;
export const IMAGE_REFERENCE_MAX_PIXELS = 4_000_000;
export const IMAGE_REFERENCE_TIMEOUT_MS = 30_000;

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const codecs = Object.freeze({ "image/png": "png", "image/jpeg": "mjpeg", "image/webp": "webp" });
const suffixes = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function refuse(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  error.status = 400;
  return error;
}

function bounded(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > IMAGE_REFERENCE_MAX_SIDE || height > IMAGE_REFERENCE_MAX_SIDE
      || width * height > IMAGE_REFERENCE_MAX_PIXELS) {
    throw refuse("reference-canvas", `A friend image reference must be at most ${IMAGE_REFERENCE_MAX_SIDE} pixels per side and ${IMAGE_REFERENCE_MAX_PIXELS} pixels total.`);
  }
  return { width, height };
}

function pngCanvas(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG)
      || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw refuse("reference-format", "A PNG reference needs an intact first IHDR chunk.");
  }
  const canvas = bounded(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  let offset = 8, ended = false, pixels = false, headers = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw refuse("reference-format", "A PNG reference ends inside a chunk.");
    const size = bytes.readUInt32BE(offset);
    const next = offset + size + 12;
    if (next > bytes.length || next <= offset) throw refuse("reference-format", "A PNG reference has a chunk outside its file.");
    const tag = bytes.toString("ascii", offset + 4, offset + 8);
    if (tag === "IHDR" && ++headers !== 1) throw refuse("reference-format", "A PNG reference has more than one image header.");
    if (["acTL", "fcTL", "fdAT"].includes(tag)) throw refuse("reference-animated", "A friend image reference must be one still picture, not an animated PNG.");
    if (tag === "IDAT") pixels = true;
    if (tag === "IEND") {
      if (size !== 0 || next !== bytes.length) throw refuse("reference-format", "A PNG reference has bytes after its final image chunk.");
      ended = true;
      break;
    }
    offset = next;
  }
  if (!pixels || !ended) throw refuse("reference-format", "A PNG reference needs pixels and a final image chunk.");
  return canvas;
}

function jpegCanvas(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw refuse("reference-format", "A JPEG reference needs a complete start and end marker.");
  }
  let offset = 2, canvas = null, inScan = false;
  while (offset < bytes.length) {
    if (inScan) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
      if (offset >= bytes.length) break;
    }
    if (bytes[offset] !== 0xff) throw refuse("reference-format", "A JPEG reference has an invalid marker before its frame header.");
    while (bytes[offset] === 0xff && offset < bytes.length) offset++;
    const marker = bytes[offset++];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (!inScan) throw refuse("reference-format", "A JPEG reference has a scan-only marker outside its scan.");
      continue;
    }
    inScan = false;
    if (marker === 0xd9) {
      if (!canvas || offset !== bytes.length) throw refuse("reference-format", "A JPEG reference has trailing data or no frame header after its end marker.");
      return canvas;
    }
    if (marker === 0xd8) throw refuse("reference-format", "A JPEG reference contains a second image.");
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) break;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) throw refuse("reference-format", "A JPEG reference has a damaged marker segment.");
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (size < 7 || canvas) throw refuse("reference-format", "A JPEG reference has a short or repeated frame header.");
      canvas = bounded(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    if (marker === 0xda) inScan = true;
    offset += size;
  }
  throw refuse("reference-format", "A JPEG reference is missing its final end marker.");
}

function webpCanvas(bytes) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF"
      || bytes.toString("ascii", 8, 12) !== "WEBP"
      || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw refuse("reference-format", "A WebP reference needs one complete RIFF container.");
  }
  let offset = 12, canvas = null, frames = 0, headers = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw refuse("reference-format", "A WebP reference ends inside a chunk.");
    const tag = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const next = data + size + (size & 1);
    if (next > bytes.length || next <= offset) throw refuse("reference-format", "A WebP reference has a chunk outside its file.");
    if (tag === "ANIM" || tag === "ANMF") throw refuse("reference-animated", "A friend image reference must be one still picture, not an animated WebP.");
    if (tag === "VP8X") {
      if (size < 10 || ++headers !== 1) throw refuse("reference-format", "A WebP reference has a short or repeated extended header.");
      if (bytes[data] & 0x02) throw refuse("reference-animated", "A friend image reference must be one still picture, not an animated WebP.");
      const width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
      const height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
      canvas = bounded(width, height);
    } else if (tag === "VP8 ") {
      if (++frames !== 1) throw refuse("reference-animated", "A friend image reference must contain one still WebP frame.");
      if (size < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
        throw refuse("reference-format", "A WebP reference has no VP8 keyframe header.");
      }
      const dimensions = bounded(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff);
      if (canvas && (canvas.width !== dimensions.width || canvas.height !== dimensions.height)) throw refuse("reference-format", "A WebP reference's canvas and frame dimensions disagree.");
      canvas = dimensions;
    } else if (tag === "VP8L") {
      if (++frames !== 1) throw refuse("reference-animated", "A friend image reference must contain one still WebP frame.");
      if (size < 5 || bytes[data] !== 0x2f) throw refuse("reference-format", "A WebP reference has no lossless frame header.");
      const bits = bytes.readUInt32LE(data + 1);
      const dimensions = bounded(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
      if (canvas && (canvas.width !== dimensions.width || canvas.height !== dimensions.height)) throw refuse("reference-format", "A WebP reference's canvas and frame dimensions disagree.");
      canvas = dimensions;
    }
    offset = next;
  }
  if (!canvas || frames !== 1) throw refuse("reference-format", "A WebP reference has no readable still-frame dimensions.");
  return canvas;
}

/** Container dimensions before either external decoder runs. */
export function inspectImageReference(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > IMAGE_JOB_REF_BYTES_CAP) {
    throw refuse("reference-too-large", "Each friend image reference must contain 1 byte to 8 MiB.");
  }
  if (mime === "image/png") return { mime, ...pngCanvas(bytes) };
  if (mime === "image/jpeg") return { mime, ...jpegCanvas(bytes) };
  if (mime === "image/webp") return { mime, ...webpCanvas(bytes) };
  throw refuse("reference-format", "A friend image reference must be PNG, JPEG or WebP.");
}

function deadlineLeft(deadline) {
  const left = deadline - Date.now();
  if (left < 1) throw refuse("decoder-timeout", "Measuring the friend image references timed out. Nothing was accepted.");
  return left;
}

function probe(file, bin, timeoutMs) {
  return new Promise((resolve) => execFile(bin, ["-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames", "-of", "json", file],
  { timeout: timeoutMs, maxBuffer: 128 * 1024, windowsHide: true },
  (error, stdout) => resolve({ error, stdout: String(stdout || "") })));
}

function decode(file, bin, expectedBytes, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
      "-threads", "1", "-i", file, "-map", "0:v:0", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let size = 0, done = false, timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    child.on("error", (error) => finish({ error }));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > expectedBytes) { overflow = true; child.kill(); }
    });
    // Keep a pipe reader so ffmpeg cannot block on stderr without allowing
    // untrusted decoder diagnostics to fill this process's memory.
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      if (timedOut) return finish({ error: refuse("decoder-timeout", "Decoding a friend image reference timed out. Nothing was accepted.") });
      if (overflow || code !== 0 || size !== expectedBytes) return finish({ error: refuse("reference-decode-failed", "A friend image reference could not be fully decoded as one picture. Nothing was accepted.") });
      finish({ bytes: size });
    });
  });
}

/**
 * `references` is the array in a validated `readImageJob(...).job`. No caller
 * supplied path is opened. Each input is decoded sequentially, with one total
 * timeout shared across all references. Returns measured summaries in order.
 */
export async function measureImageJobReferences(references, { ffprobe = null, ffmpeg = null,
  timeoutMs = IMAGE_REFERENCE_TIMEOUT_MS } = {}) {
  if (!Array.isArray(references) || references.length > IMAGE_JOB_REF_CAP
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw refuse("bad-arguments", "Measure up to three image references with a 1–60,000 ms timeout.");
  }
  const input = references.map((row, index) => {
    if (!row || row.ordinal !== index + 1 || typeof row.b64 !== "string" || !Number.isInteger(row.bytes)
        || !/^[0-9a-f]{64}$/.test(String(row.sha256 || ""))) throw refuse("bad-reference", "The image reference list is not the ordered, verified job input.");
    const bytes = Buffer.from(row.b64, "base64");
    if (bytes.toString("base64") !== row.b64 || bytes.length !== row.bytes || sha256(bytes) !== row.sha256) {
      throw refuse("reference-hash", "An image reference differs from the signed job bytes.");
    }
    return { bytes, header: inspectImageReference(bytes, row.mime), ordinal: row.ordinal };
  });
  if (!input.length) return [];
  const deadline = Date.now() + timeoutMs;
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-image-reference-"));
  try {
    const result = [];
    for (const { bytes, header, ordinal } of input) {
      const file = path.join(dir, `reference-${ordinal}.${suffixes[header.mime]}`);
      await writeFile(file, bytes);
      const measured = await probe(file, ffprobePath(ffprobe), deadlineLeft(deadline));
      if (measured.error) {
        if (measured.error.code === "ENOENT") throw refuse("decoder-unavailable", "ffprobe is unavailable; image references cannot be accepted without measuring them.");
        if (measured.error.killed) throw refuse("decoder-timeout", "Measuring a friend image reference timed out. Nothing was accepted.");
        throw refuse("reference-probe-failed", "ffprobe could not measure a friend image reference. Nothing was accepted.");
      }
      let streams;
      try { streams = JSON.parse(measured.stdout).streams; } catch { /* refused below */ }
      if (!Array.isArray(streams) || streams.length !== 1
          || streams[0].codec_type !== "video" || streams[0].codec_name !== codecs[header.mime]
          || streams[0].width !== header.width || streams[0].height !== header.height
          || streams[0].nb_read_frames !== "1") {
        throw refuse("reference-probe-disagrees", "The reference's decoder format, dimensions or still-frame count differ from its container. Nothing was accepted.");
      }
      const expectedBytes = header.width * header.height * 4;
      const decoded = await decode(file, ffmpegPath(ffmpeg), expectedBytes, deadlineLeft(deadline));
      if (decoded.error) {
        if (decoded.error.code === "ENOENT") throw refuse("decoder-unavailable", "ffmpeg is unavailable; image references cannot be accepted without decoding them.");
        throw decoded.error;
      }
      result.push({ ordinal, mime: header.mime, width: header.width, height: header.height,
        frames: 1, decodedBytes: decoded.bytes, sha256: sha256(bytes) });
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
