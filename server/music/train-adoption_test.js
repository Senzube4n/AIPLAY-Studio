import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adoptLora, trainGraph, verifyTrainAdoption } from "./train.js";
import { sha256, sortedJSON } from "../engine/record.js";

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

test("a completed run cannot adopt another run's LoRA when its receipt or graph is missing", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yue-adopt-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output"), dest = path.join(root, "loras");
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, "mine_song_other_50_steps_00001_.safetensors"), "other run");
  const runId = "run-a", name = "mine_song", outputPrefix = "mine_song_this";
  const source = { file: "song.wav", sha256: "a".repeat(64), startSeconds: 2, seconds: 24 };
  const settings = { steps: 50, rank: 8, learningRate: .0002 };
  const graph = trainGraph({ ckpt: "yue2.safetensors", sliceName: "train_mine_song_this_at2s_24s.wav",
    codesDir: "codes", seconds: 24, ...settings, name: outputPrefix });
  const graphHash = sha256(sortedJSON(graph));
  const receipt = { runId, name, outputPrefix, source, settings, checkpoint: "yue2.safetensors", graphHash };
  const record = { runId, request: { graphHash }, result: { graphHash, status: "completed" }, graph };

  assert.throws(() => verifyTrainAdoption({ runId, name, receipt: null, record }), /no training receipt/i);
  assert.throws(() => verifyTrainAdoption({ runId, name, receipt, record: { ...record, graph: null } }), /saved training graph/i);
  assert.throws(() => verifyTrainAdoption({ runId, name, receipt, record: {
    ...record, result: { graphHash, status: "cancelled" } } }), /did not complete/i);
  assert.throws(() => verifyTrainAdoption({ runId, name, receipt: { ...receipt, outputPrefix: "mine_song_other" }, record }), /expected source-audio/i);

  const adoption = verifyTrainAdoption({ runId, name, receipt, record });
  assert.deepEqual(adoption, { outputPrefix, exact: true });
  await assert.rejects(adoptLora(name, { outputDir, dest, ...adoption }), /exactly one/);
  await writeFile(path.join(outputDir, "mine_song_this_50_steps_00001_.safetensors"), "this run");
  const kept = await adoptLora(name, { outputDir, dest, ...adoption });
  assert.equal(await readFile(kept.file, "utf8"), "this run");
});
