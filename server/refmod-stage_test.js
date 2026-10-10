import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, open, symlink, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { stageRefModImage } from "./refmod-stage.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
async function withFolders(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-refmod-stage-"));
  const folders = Object.fromEntries(["inputDir", "imageDir", "coverDir"].map((key) => [key, path.join(temp, key)]));
  try { await Promise.all(Object.values(folders).map((dir) => mkdir(dir))); await run(folders, temp); }
  finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("aiplay-refmod-stage-"));
    await rm(temp, { recursive: true, force: true });
  }
}

test("library and cover staging uses signature, stable content name and bounded engine input copy", async () => {
  await withFolders(async (folders) => {
    const fixtures = [
      { dir: folders.imageDir, name: "singer.jpg", bytes: png, ext: ".png" },
      { dir: folders.coverDir, name: "cover.png", bytes: Buffer.from([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]), ext: ".jpg" },
      { dir: folders.inputDir, name: "first.webp", bytes: Buffer.from("RIFF0000WEBP", "ascii"), ext: ".webp" },
    ];
    for (const item of fixtures) {
      await writeFile(path.join(item.dir, item.name), item.bytes);
      const expected = `aiplay_refmod_${createHash("sha256").update(item.bytes).digest("hex").slice(0, 24)}${item.ext}`;
      assert.equal(await stageRefModImage(item.name, folders), expected);
      assert.deepEqual(await readFile(path.join(folders.inputDir, expected)), item.bytes);
      assert.equal(await stageRefModImage(item.name, folders), expected, "identical staging can be reused");
      assert.equal(await stageRefModImage(expected, folders), expected, "already staged images remain valid inputs");
    }
  });
});

test("staging refuses traversal, streams, invalid signatures, oversized files and occupied destinations", async () => {
  await withFolders(async (folders) => {
    for (const name of ["../singer.png", "x/singer.png", "C:\\singer.png", "singer.png:stream.png", "bad\n.png", "singer.gif", "singer.bmp", "https://example.test/a.png"]) {
      await assert.rejects(stageRefModImage(name, folders), /Choose a Studio reference image/);
    }
    await assert.rejects(stageRefModImage("missing.png", folders), /unavailable/);
    await assert.rejects(stageRefModImage("singer.png", { imageDir: folders.imageDir }), /input folder/);
    await mkdir(path.join(folders.imageDir, "folder.png"));
    await assert.rejects(stageRefModImage("folder.png", folders), /ordinary files/);
    await writeFile(path.join(folders.imageDir, "tiny.png"), Buffer.alloc(4));
    await assert.rejects(stageRefModImage("tiny.png", folders), /ordinary files/);
    await writeFile(path.join(folders.imageDir, "fake.png"), Buffer.alloc(12));
    await assert.rejects(stageRefModImage("fake.png", folders), /signature/);
    const handle = await open(path.join(folders.imageDir, "huge.png"), "w");
    try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(stageRefModImage("huge.png", folders), /under 32 MB/);
    await writeFile(path.join(folders.imageDir, "singer.png"), png);
    const target = path.join(folders.inputDir, `aiplay_refmod_${createHash("sha256").update(png).digest("hex").slice(0, 24)}.png`);
    await writeFile(target, Buffer.alloc(png.length));
    await assert.rejects(stageRefModImage("singer.png", folders), /occupied by a different file/);
    assert.deepEqual(await readFile(target), Buffer.alloc(png.length), "an existing file is never overwritten");
  });
});

test("staging does not follow a library symlink", async (t) => {
  await withFolders(async (folders, temp) => {
    const outside = path.join(temp, "outside.png"); await writeFile(outside, png);
    try { await symlink(outside, path.join(folders.imageDir, "linked.png"), "file"); }
    catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip("Creating file symlinks is unavailable on this host."); throw error; }
    await assert.rejects(stageRefModImage("linked.png", folders), /ordinary files/);
  });
});
