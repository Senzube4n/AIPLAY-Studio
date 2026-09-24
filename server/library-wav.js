/** Native YuE2 library metadata. Bounded RIFF INFO, lossless streaming copy,
 * no Python/ffmpeg. Only the queue's copied WAV is tagged; its receipt master
 * remains unchanged. No cover embedding is claimed. */
import { open, unlink, utimes } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { inspectGgufWav } from "./music/yue-gguf.js";
import { renameAtomic } from "./fs-atomic.js";
import { outputRightsFor } from "./models.js";

const LIMIT = 64 * 1024;
const PREFIX = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const locks = new Map();
export const isNativeLibraryWav = (file) => /^aiplay_yue2_gguf_[a-z0-9_-]+\.wav$/i.test(file);
const clean = (value, max = 2000) => String(value ?? "").replace(/\0/g, "").slice(0, max);

function record(raw) {
  const generator = clean(raw.generator || "YuE2-3B (native audio.cpp)", 240);
  /* The credit line the catalogue gives this engine's songs (models.js), so
   * ICOP says what the rights chip says; the licence file's name rides in it. */
  const attribution = clean(Array.isArray(raw.attribution) ? raw.attribution.join("\n")
    : raw.attribution || outputRightsFor("yue2-gguf").attribution
      || "YuE2-3B by Multimodal Art Projection (m-a-p), https://huggingface.co/m-a-p/YuE2-3B. Weights licence file: CC BY-NC 4.0; attribution required.");
  return {
    title: clean(raw.title || "Untitled", 240), generator, attribution,
    digitalSourceType: String(raw.digitalSourceType || "").startsWith(PREFIX)
      ? clean(raw.digitalSourceType, 300) : PREFIX + "trainedAlgorithmicMedia",
    aiDisclosure: clean(raw.disclosure || `AI-generated audio: created with ${generator}. Machine-generated content.`),
    software: `AIPLAY Studio ${clean(raw.appVersion || "0.1.0", 80)}`,
    ...(raw.tier2 === false ? {} : {
      caption: clean(raw.caption, 900), lyrics: clean(raw.lyrics, 4000),
      seed: clean(raw.seed, 80), steps: clean(raw.steps, 80), model: clean(raw.model, 240),
      provenance: raw.provenance ?? null,
    }),
  };
}
function chunk(id, bytes) {
  const out = Buffer.alloc(8 + bytes.length + (bytes.length % 2));
  out.write(id, 0, 4, "ascii"); out.writeUInt32LE(bytes.length, 4); bytes.copy(out, 8);
  return out;
}
function infoChunk(data, retained) {
  const entries = new Map(retained);
  const oldComment = entries.get("ICMT")?.toString("utf8").replace(/\0+$/, "") || "";
  const comment = [oldComment && !oldComment.includes("DIGITALSOURCETYPE=") ? oldComment : "", data.aiDisclosure, `DIGITALSOURCETYPE=${data.digitalSourceType}`,
    `AI_DISCLOSURE=${data.aiDisclosure}`, `GENERATOR=${data.generator}`, `ATTRIBUTION=${data.attribution}`].filter(Boolean).join("\n");
  for (const [key, value] of Object.entries({ INAM: data.title, IART: data.generator,
    ICOP: data.attribution, ISFT: data.software, ICMT: comment, IPRV: JSON.stringify(data) })) {
    entries.set(key, Buffer.from(value + "\0", "utf8"));
  }
  const body = Buffer.concat([Buffer.from("INFO"), ...[...entries].map(([key, value]) => chunk(key, value))]);
  if (body.length > LIMIT) throw new Error("Native WAV metadata exceeds64KiB; nothing was changed.");
  return chunk("LIST", body);
}
async function exact(handle, size, position) {
  const buffer = Buffer.alloc(size);
  if ((await handle.read(buffer, 0, size, position)).bytesRead !== size) throw new Error("WAV changed while reading metadata.");
  return buffer;
}
async function scan(handle) {
  const header = await exact(handle, 12, 0), end = header.readUInt32LE(4) + 8;
  const ranges = [], info = new Map();
  let at = 12, count = 0, metadata = 0;
  while (at + 8 <= end && count++ < 256) {
    const head = await exact(handle, 8, at), size = head.readUInt32LE(4), length = 8 + size + size % 2;
    if (at + length > end) throw new Error("Malformed WAV chunk.");
    if (head.toString("ascii", 0, 4) === "LIST" && size >= 4
        && (await exact(handle, 4, at + 8)).toString("ascii") === "INFO") {
      metadata += size;
      if (metadata > LIMIT) throw new Error("Existing WAV metadata exceeds64KiB.");
      const body = await exact(handle, size, at + 8);
      let index = 4;
      while (index + 8 <= body.length) {
        const id = body.toString("ascii", index, index + 4), n = body.readUInt32LE(index + 4);
        if (!/^[A-Z0-9 ]{4}$/.test(id) || index + 8 + n + n % 2 > body.length) throw new Error("Malformed WAV INFO.");
        info.set(id, body.subarray(index + 8, index + 8 + n)); index += 8 + n + n % 2;
      }
      if (index !== body.length) throw new Error("Incomplete WAV INFO.");
    } else ranges.push({ at, length });
    at += length;
  }
  if (at !== end) throw new Error("Too many or incomplete WAV chunks.");
  return { ranges, info };
}
export async function readNativeWavTags(file) {
  const audio = await inspectGgufWav(file), handle = await open(file, "r");
  try {
    const { info } = await scan(handle);
    let data = {};
    try { data = JSON.parse(info.get("IPRV")?.toString("utf8").replace(/\0+$/, "") || "{}"); } catch { /* legacy INFO */ }
    return { ...data, ok: true, seconds: audio.audioSeconds, embedded: false };
  } finally { await handle.close(); }
}
export async function tagNativeWav(file, raw = {}) {
  // Serialize retags of this exact copied library file, including a late cover.
  const previous = locks.get(file) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const audio = await inspectGgufWav(file), input = await open(file, "r");
    const temporary = `${file}.tag-${randomBytes(8).toString("hex")}.tmp`;
    let output, created = false;
    try {
      const stamp = await input.stat(), { ranges, info } = await scan(input);
      const addition = infoChunk(record(raw), info);
      const total = 12 + addition.length + ranges.reduce((sum, r) => sum + r.length, 0);
      if (total - 8 > 0xffffffff) throw new Error("WAV is too large for RIFF INFO tagging.");
      output = await open(temporary, "wx", stamp.mode);
      created = true;
      const header = Buffer.alloc(12); header.write("RIFF", 0); header.writeUInt32LE(total - 8, 4); header.write("WAVE", 8);
      const writeAll = async (buffer) => {
        let n = 0;
        while (n < buffer.length) n += (await output.write(buffer, n, buffer.length - n)).bytesWritten;
      };
      await writeAll(header);
      for (const range of ranges) {
        for (let n = 0; n < range.length; n += 64 * 1024) {
          await writeAll(await exact(input, Math.min(64 * 1024, range.length - n), range.at + n));
        }
      }
      await writeAll(addition); await output.sync(); await output.close(); output = null;
      const verified = await readNativeWavTags(temporary);
      if (verified.seconds !== audio.audioSeconds || !verified.digitalSourceType || !verified.attribution) throw new Error("Native WAV metadata verification failed.");
      await input.close();
      /* Retried on EPERM/EBUSY/EACCES for about 0.8 s (server/fs-atomic.js):
       * a player, the indexer or antivirus holding the song for a moment used
       * to cost the tags and the cover with "EPERM: operation not permitted". */
      await renameAtomic(temporary, file);
      await utimes(file, stamp.atime, stamp.mtime);
      return verified;
    } finally {
      await input.close().catch(() => {}); await output?.close().catch(() => {});
      if (created) await unlink(temporary).catch(() => {}); // Only this invocation's exclusive temporary file.
    }
  });
  locks.set(file, task);
  try { return await task; } finally { if (locks.get(file) === task) locks.delete(file); }
}
