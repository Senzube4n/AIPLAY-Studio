import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adoptLora } from "./train.js";

test("adoption binds a unique training prefix and refuses ambiguous or missing output", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yue-adopt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output"), dest = path.join(root, "loras");
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, "mine_song_old_50_steps_00001_.safetensors"), "old");
  await writeFile(path.join(outputDir, "mine_song_unique_50_steps_00001_.safetensors"), "this exact run");
  const kept = await adoptLora("mine_song", { outputDir, dest, outputPrefix: "mine_song_unique", exact: true });
  assert.equal(await readFile(kept.file, "utf8"), "this exact run");
  await writeFile(path.join(outputDir, "mine_song_unique_50_steps_00002_.safetensors"), "another run");
  await assert.rejects(adoptLora("mine_song", { outputDir, dest, outputPrefix: "mine_song_unique", exact: true }), /exactly one/);
  assert.equal(await readFile(kept.file, "utf8"), "this exact run");
  await assert.rejects(adoptLora("mine_song", { outputDir, dest, outputPrefix: "mine_song_missing", exact: true }), /exactly one/);
  await assert.rejects(adoptLora("../escape", { outputDir, dest }), /Invalid training/);
});
