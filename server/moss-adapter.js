/** One streamed hash per unchanged pinned adapter, never a tensor/model load. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";

const verified = new Map(), pending = new Map();
const stamp = (file, s) => [file, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
export async function mossArtifactPin(found, expected, kind = "Adapter") {
  try {
    if (!found?.full) throw new Error("The " + kind.toLowerCase() + " has no resolved shelf path.");
    const file = await realpath(found.full), before = await stat(file, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.bytes)) throw new Error(kind + " size/type mismatch.");
    const key = stamp(file, before) + ":" + expected.sha256;
    if (verified.has(key)) return verified.get(key);
    if (pending.has(key)) return await pending.get(key);
    const check = (async () => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (stamp(file, await stat(file, { bigint: true })) !== stamp(file, before)) throw new Error(kind + " changed during verification.");
      const sha256 = hash.digest("hex");
      if (sha256 !== expected.sha256) throw new Error(kind + " SHA256 does not match the pinned release.");
      const result = Object.freeze({ ready: true, sha256, bytes: Number(before.size) });
      verified.set(key, result);
      while (verified.size > 32) verified.delete(verified.keys().next().value);
      return result;
    })();
    pending.set(key, check);
    try { return await check; } finally { pending.delete(key); }
  } catch (err) { return { ready: false, error: err.message }; }
}
export const mossAdapterPin = (found, expected) => mossArtifactPin(found, expected, "Adapter");
export const mossModelPin = (found, expected) => mossArtifactPin(found, expected, "Diffusion model");
