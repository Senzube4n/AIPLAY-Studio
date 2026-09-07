import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Validate the minimal float32 WAV written by engine.py and rack.py.
 * Read only its 44-byte header, then compare the declared format and actual
 * file length with the requested region. Imported audio uses another path. */
export async function regionWavReady(file, { sr, nSamples, channels }) {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    const bytes = nSamples * channels * 4;
    if (!info.isFile() || !Number.isSafeInteger(bytes) || bytes <= 0
        || info.size !== 44 + bytes) return false;
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, 44, 0);
    return bytesRead === 44
      && header.toString("ascii", 0, 4) === "RIFF"
      && header.readUInt32LE(4) === info.size - 8
      && header.toString("ascii", 8, 16) === "WAVEfmt "
      && header.readUInt32LE(16) === 16
      && header.readUInt16LE(20) === 3
      && header.readUInt16LE(22) === channels
      && header.readUInt32LE(24) === sr
      && header.readUInt32LE(28) === sr * channels * 4
      && header.readUInt16LE(32) === channels * 4
      && header.readUInt16LE(34) === 32
      && header.toString("ascii", 36, 40) === "data"
      && header.readUInt32LE(40) === bytes;
  } catch { return false; }
  finally { await handle?.close().catch(() => {}); }
}

/** One render per content path, shared by playback, look-ahead and bounce.
 * Failed work never becomes an immutable URL and can be retried immediately. */
export function createRegionCache() {
  const pending = new Map();
  return {
    async ensure(file, spec, render) {
      if (pending.has(file)) {
        const result = await pending.get(file);
        return { ...result, cached: true, rendered: false, ms: 0 };
      }
      const work = (async () => {
        if (await regionWavReady(file, spec)) return { cached: true, rendered: false, ms: 0 };
        const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
        try {
          const result = await render(tmp);
          if (!await regionWavReady(tmp, spec)) {
            throw new Error(`The DAW render did not produce a complete ${spec.nSamples}-frame `
              + `${spec.channels}-channel WAV at ${spec.sr} Hz. Render this region again.`);
          }
          await rename(tmp, file);
          return { ...result, cached: false, rendered: true };
        } finally { await unlink(tmp).catch(() => {}); }
      })();
      pending.set(file, work);
      try { return await work; }
      finally { pending.delete(file); }
    },
  };
}
