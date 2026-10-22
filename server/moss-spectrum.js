/** Verify only the small separately installed source pack. No code imports or installs. */
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { MOSS_SPECTRUM } from "./moss-presets.js";

export async function mossSpectrumPin(config, pin = MOSS_SPECTRUM) {
  try {
    if (!config.comfyDir || config.remoteOnly || config.cloudOnly) throw new Error("A local source-pinned engine is required.");
    const dir = path.join(config.comfyDir, "custom_nodes", pin.folder);
    for (let parent = dir; ; parent = path.dirname(parent)) {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("Source parent links are not supported.");
      if (path.dirname(parent) === parent) break;
    }
    const read = async (name, bytes) => {
      const file = path.join(dir, name), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (bytes ? stat.size !== bytes : stat.size > 16384)) throw new Error("Source size/type mismatch: " + name);
      return readFile(file);
    };
    const marker = JSON.parse((await read(pin.marker)).toString("utf8"));
    if (marker.schemaVersion !== 1 || marker.repository !== pin.repository || marker.commit !== pin.commit || marker.version !== pin.version
      || !Array.isArray(marker.files) || marker.files.length !== pin.files.length) throw new Error("Source pin marker mismatch.");
    for (const file of pin.files) {
      const recorded = marker.files.find(f => f.file === file.file);
      if (!recorded || recorded.bytes !== file.bytes || recorded.sha256 !== file.sha256) throw new Error("Source pin entry mismatch: " + file.file);
      const data = await read(file.file, file.bytes);
      if (createHash("sha256").update(data).digest("hex") !== file.sha256) throw new Error("Source hash mismatch: " + file.file);
    }
    return { ready: true, commit: pin.commit, version: pin.version, verifiedSourceFiles: pin.files.length };
  } catch (err) { return { ready: false, error: "Spectrum needs the reviewed standalone source pack: " + err.message }; }
}
