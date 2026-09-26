import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { ffmpegPath, ffprobePath } from "../clipjoin.js";
import { inspectImageReference, measureImageJobReferences } from "./image-reference.js";

const execute = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, payload) {
  const name = Buffer.from(type, "ascii");
  const n = Buffer.alloc(4), crc = Buffer.alloc(4);
  n.writeUInt32BE(payload.length);
  let c = 0xffffffff;
  for (const byte of Buffer.concat([name, payload])) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([n, name, payload, crc]);
}
function png(width, height, { animated = false, badPixels = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.alloc(width * 4 + 1);
  for (let x = 0; x < width; x++) { row[1 + x * 4] = 50; row[2 + x * 4] = 100; row[3 + x * 4] = 150; row[4 + x * 4] = 255; }
  const compressed = badPixels ? Buffer.from("not zlib pixels") : deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    ...(animated ? [chunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))] : []),
    chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}
const asRef = (data, mime, ordinal = 1) => ({ ordinal, mime, bytes: data.length,
  b64: data.toString("base64"), sha256: sha256(data), safety: { minor: false, sexual: false } });
const available = [ffprobePath(), ffmpegPath()].every((bin) => spawnSync(bin, ["-version"],
  { windowsHide: true, timeout: 5000, stdio: "ignore" }).status === 0);

test("reference container preflight refuses oversized and animated pictures before decoding", () => {
  assert.deepEqual(inspectImageReference(png(8, 7), "image/png"), { mime: "image/png", width: 8, height: 7 });
  assert.throws(() => inspectImageReference(png(4097, 1), "image/png"), { reason: "reference-canvas" });
  assert.throws(() => inspectImageReference(png(4000, 1001), "image/png"), { reason: "reference-canvas" });
  assert.throws(() => inspectImageReference(png(2, 2, { animated: true }), "image/png"), { reason: "reference-animated" });
  assert.throws(() => inspectImageReference(Buffer.from("not-an-image"), "image/png"), { reason: "reference-format" });
  const webpAnimated = Buffer.alloc(30);
  webpAnimated.write("RIFF", 0); webpAnimated.writeUInt32LE(22, 4); webpAnimated.write("WEBPVP8X", 8);
  webpAnimated.writeUInt32LE(10, 16); webpAnimated[20] = 0x02;
  assert.throws(() => inspectImageReference(webpAnimated, "image/webp"), { reason: "reference-animated" });
});

test("the parsed job's canonical bytes, count and hash are rechecked", async () => {
  const picture = png(2, 2), row = asRef(picture, "image/png");
  await assert.rejects(measureImageJobReferences([{ ...row, sha256: "0".repeat(64) }]), { reason: "reference-hash" });
  await assert.rejects(measureImageJobReferences([{ ...row, b64: row.b64 + "\n" }]), { reason: "reference-hash" });
  await assert.rejects(measureImageJobReferences(Array.from({ length: 4 }, () => row)), { reason: "bad-arguments" });
  await assert.rejects(measureImageJobReferences([row], { timeoutMs: 0 }), { reason: "bad-arguments" });
  await assert.rejects(measureImageJobReferences([asRef(png(4097, 1), "image/png")],
    { ffprobe: "no-such-ffprobe-aiplay" }), { reason: "reference-canvas" });
  assert.deepEqual(await measureImageJobReferences([]), []);
});

test("real ffprobe and full ffmpeg decode accept bounded PNG, JPEG and WebP still references", { skip: !available }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-image-reference-test-"));
  try {
    const input = path.join(dir, "source.png"), jpeg = path.join(dir, "source.jpg"), webp = path.join(dir, "source.webp");
    await writeFile(input, png(8, 7));
    await execute(ffmpegPath(), ["-nostdin", "-v", "error", "-i", input, "-frames:v", "1", "-y", jpeg], { timeout: 10_000, windowsHide: true });
    await execute(ffmpegPath(), ["-nostdin", "-v", "error", "-i", input, "-frames:v", "1", "-y", webp], { timeout: 10_000, windowsHide: true });
    const pictures = [await readFile(input), await readFile(jpeg), await readFile(webp)];
    const mimes = ["image/png", "image/jpeg", "image/webp"];
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(inspectImageReference(pictures[index], mimes[index]),
        { mime: mimes[index], width: 8, height: 7 });
    }
    assert.throws(() => inspectImageReference(Buffer.concat([pictures[1], pictures[1]]), "image/jpeg"),
      { reason: "reference-format" });
    const measured = await measureImageJobReferences(pictures.map((data, index) => asRef(data, mimes[index], index + 1)));
    assert.equal(measured.length, 3);
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(measured[index], { ordinal: index + 1, mime: mimes[index], width: 8, height: 7,
        frames: 1, decodedBytes: 8 * 7 * 4, sha256: sha256(pictures[index]) });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("valid PNG wrapper with undecodable pixels is not accepted", { skip: !available }, async () => {
  await assert.rejects(measureImageJobReferences([asRef(png(2, 2, { badPixels: true }), "image/png")]),
    (error) => ["reference-probe-failed", "reference-probe-disagrees", "reference-decode-failed"].includes(error.reason));
});

test("missing local decoder is a refusal, never an implicit trust of signed image bytes", async () => {
  const ref = asRef(png(2, 2), "image/png");
  await assert.rejects(measureImageJobReferences([ref], { ffprobe: "no-such-ffprobe-aiplay" }), { reason: "decoder-unavailable" });
  if (available) await assert.rejects(measureImageJobReferences([ref], { ffmpeg: "no-such-ffmpeg-aiplay" }), { reason: "decoder-unavailable" });
});
