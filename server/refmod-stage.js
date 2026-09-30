import path from "node:path";
import { lstat, realpath, open, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
async function boundedImage(file, expected) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 12 || info.size > MAX_IMAGE_BYTES
        || info.dev !== expected.dev || info.ino !== expected.ino || info.size !== expected.size)
      throw new Error("Reference images must be unchanged ordinary files under 32 MB.");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Reference image changed while it was being read.");
      offset += bytesRead;
    }
    const after = await handle.stat(), extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || extra.bytesRead)
      throw new Error("Reference image changed while it was being read.");
    return bytes;
  } finally { await handle.close(); }
}

/** Stage a bounded, ordinary image already owned by Studio. */
export async function stageRefModImage(name, { inputDir, imageDir, coverDir }) {
  if (typeof name !== "string" || name.length > 240 || path.basename(name) !== name || /[\\/\x00-\x1f:<>"|?*]/.test(name)
      || !/\.(png|jpe?g|webp)$/i.test(name)) throw new Error("Choose a Studio reference image.");
  if (typeof inputDir !== "string" || !inputDir) throw new Error("The engine input folder is unavailable.");
  for (const folder of [inputDir, coverDir, imageDir].filter(Boolean)) {
    const source = path.join(folder, name);
    let info;
    try { info = await lstat(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size < 12 || info.size > MAX_IMAGE_BYTES)
      throw new Error("Reference images must be ordinary files under 32 MB.");
    const root = await realpath(folder), resolved = await realpath(source);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Reference image is outside Studio.");
    const bytes = await boundedImage(resolved, info);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp) throw new Error("Reference image has an unsupported file signature.");
    const ext = png ? ".png" : jpeg ? ".jpg" : ".webp";
    const staged = `aiplay_refmod_${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}${ext}`;
    await mkdir(inputDir, { recursive: true });
    const destination = path.join(inputDir, staged);
    try { await writeFile(destination, bytes, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length
          || !(await boundedImage(destination, existing)).equals(bytes))
        throw new Error("The staged reference filename is occupied by a different file.");
    }
    return staged;
  }
  throw new Error(`Reference image is unavailable: ${name}.`);
}
