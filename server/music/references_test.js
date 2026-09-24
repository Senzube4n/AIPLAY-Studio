import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createMusicReferences, referenceWindow, visualBriefGraph, prepareReferenceMedia, runReferenceProcess } from "./references.js";

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "music-reference-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { dataDir: path.join(dir, "data"), outputDir: path.join(dir, "library"), inputDir: path.join(dir, "input"), python: process.env.AIPLAY_REFERENCE_TEST_PYTHON || "python" };
  await mkdir(path.join(config.outputDir, "clips"), { recursive: true });
  await writeFile(path.join(config.outputDir, "track.wav"), "original audio bytes");
  await writeFile(path.join(config.outputDir, "clips", "clip.mp4"), "original video bytes");
  let calls = 0;
  const engine = { objectInfo: async () => { calls++; throw new Error("offline"); }, run: async () => { calls++; throw new Error("unexpected GPU call"); } };
  const prepareMedia = async ({ directory, body }) => {
    await writeFile(path.join(directory, "region.wav"), "region audio bytes");
    if (body.kind === "video") await writeFile(path.join(directory, "contact.jpg"), "bounded contact sheet");
    return { evidence: { startSeconds: body.startSeconds || 0, seconds: body.seconds || 2, hasAudio: true,
      timestamps: body.kind === "video" ? [2.5, 3.5] : [], audio: { bpm: 120, confidence: .8 } }, warnings: [] };
  };
  const service = createMusicReferences({ config, engine, prepareMedia, ...overrides });
  return { config, service, calls: () => calls };
}
async function ready(service, kind = "audio") {
  const result = await service.request({ action: "prepare", kind, file: kind === "audio" ? "track.wav" : "clip.mp4", seconds: 2 });
  return service.settled(result.reference.id);
}
async function edit(service, row, brief = { style: "Warm orchestral music", lyrics: "Let the morning rise" }) {
  return (await service.request({ action: "update_brief", referenceId: row.id, expectedRevision: row.revision, brief }, { actor: "user" })).reference;
}

test("media windows reject out-of-file regions and retain source timestamps", () => {
  const probe = { format: { duration: "60" }, streams: [{ codec_type: "audio" }, { codec_type: "video" }] };
  const got = referenceWindow(probe, { kind: "video", startSeconds: 10, seconds: 6, maxFrames: 3 });
  assert.deepEqual(got.timestamps, [11, 13, 15]);
  for (const args of [{ startSeconds: -1 }, { startSeconds: 59, seconds: 2 }, { maxFrames: 7 }, { seconds: 121 }, { seconds: "3" }]) {
    assert.throws(() => referenceWindow(probe, { kind: "video", ...args }));
  }
  assert.throws(() => referenceWindow({ format: { duration: 20 }, streams: [] }, { kind: "audio" }), /no audio stream/);
});

test("CPU preparation keeps original intact, hashes snapshot and never asks the engine", async t => {
  const { config, service, calls } = await fixture(t);
  const row = await ready(service);
  assert.equal(row.state, "ready"); assert.equal(calls(), 0);
  assert.equal(row.source.sha256, createHash("sha256").update("original audio bytes").digest("hex"));
  assert.equal(await readFile(path.join(config.outputDir, "track.wav"), "utf8"), "original audio bytes");
  assert.equal(row.evidence.audio.bpm, 120);
  const restored = createMusicReferences({ config, engine: {} });
  assert.equal((await restored.request({ action: "get", referenceId: row.id })).reference.source.sha256, row.source.sha256);
});

test("paths, URLs, bad windows and unsupported fields are refused before preparation", async t => {
  const { service } = await fixture(t);
  for (const file of ["../track.wav", "C:\\track.wav", "https://host/track.wav", "track.txt"]) await assert.rejects(service.request({ action: "prepare", kind: "audio", file }), /bare filename/);
  await assert.rejects(service.request({ action: "prepare", kind: "audio", file: "track.wav", seconds: -1 }), /seconds/);
  await assert.rejects(service.request({ action: "prepare", kind: "audio", file: "track.wav", url: "https://example.com" }), /Unsupported/);
});

test("stale and simultaneous brief writes cannot overwrite a newer draft", async t => {
  const { service } = await fixture(t); const row = await ready(service);
  const results = await Promise.allSettled([edit(service, row, { style: "first" }), edit(service, row, { style: "second" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(edit(service, row), /changed|updated/);
});

test("reviewed requests are explicit, deterministic and do not generate", async t => {
  const { service, calls } = await fixture(t); let row = await edit(service, await ready(service));
  await assert.rejects(service.request({ action: "prepare_request", referenceId: row.id, expectedRevision: row.revision }), /reviewed:true/);
  row = (await service.request({ action: "prepare_request", referenceId: row.id, expectedRevision: row.revision, reviewed: true, seed: 0 }, { actor: "agent:test" })).reference;
  assert.deepEqual(row.prepared.request, { engine: "yue2", caption: "Warm orchestral music", lyrics: "Let the morning rise", cot: "full", seed: 0, instrumental: false, allowSectionLabels: false });
  assert.deepEqual(row.prepared.makeSongArguments, { engine: "yue2", caption: "Warm orchestral music", lyrics: "Let the morning rise", cot: "full", seed: 0, instrumental: false, allow_section_labels: false });
  assert.equal(row.prepared.reviewedBy, "agent:test"); assert.equal(calls(), 0);
  row = await edit(service, row, { style: "Changed style" }); assert.equal(row.prepared, null);
});

test("instrumental is explicit, keeps written lyrics safe, and refuses GGUF", async t => {
  const { service } = await fixture(t); let row = await edit(service, await ready(service));
  const prep = extra => service.request({ action: "prepare_request", referenceId: row.id, expectedRevision: row.revision, reviewed: true, ...extra });
  await assert.rejects(prep({ instrumental: true }), /Clear them explicitly/);
  row = await edit(service, row, { lyrics: "" });
  await assert.rejects(prep({}), /Write lyrics/);
  await assert.rejects(prep({ instrumental: true, engine: "yue2-gguf" }), /GGUF requires lyrics/);
  const got = await prep({ instrumental: true, engine: "yue2-comfy" });
  assert.equal(got.reference.prepared.request.instrumental, true);
});

test("offline capability is not reported as missing model and does not block manual briefs", async t => {
  const { service } = await fixture(t);
  const cap = await service.request({ action: "capabilities" });
  assert.equal(cap.visual.available, false); assert.match(cap.visual.reason, /Start the local engine.*write a brief/i);
  let row = await edit(service, await ready(service, "video"));
  await assert.rejects(service.request({ action: "analyze_visual", referenceId: row.id, expectedRevision: row.revision }), /Start the local engine/);
  assert.ok((await service.request({ action: "prepare_request", referenceId: row.id, expectedRevision: row.revision, reviewed: true })).reference.prepared);
});

test("an offline engine status avoids object_info and never exposes its implementation URL", async t => {
  let objectCalls = 0;
  const { service } = await fixture(t, { engine: {
    status: async () => ({ ready: false }),
    objectInfo: async () => { objectCalls++; throw new Error("Failed to parse URL from http://127.0.0.1:null/object_info"); },
  } });
  const cap = await service.request({ action: "capabilities" });
  assert.equal(objectCalls, 0); assert.equal(cap.visual.available, false);
  assert.match(cap.visual.reason, /Start the local engine.*write a brief/i);
  assert.doesNotMatch(cap.visual.reason, /http|object_info|null/);
});

test("vision uses IMAGE contact sheet, engine provenance and does not overwrite human brief", async t => {
  let submitted;
  const engine = {
    objectInfo: async () => ({ CLIPLoader: { input: { required: { clip_name: [["qwen3vl_4b_fp8_scaled.safetensors"]] } } }, LoadImage: {}, TextGenerate: { input: { optional: { image: ["IMAGE"] } } }, PreviewAny: {} }),
    run: async spec => { submitted = spec; return { status: "completed", runId: "r1", promptId: "p1", entry: { outputs: { "4": { text: ["Observed walking. Suggested music: piano."] } } } }; },
  };
  const { service } = await fixture(t, { engine }); let row = await edit(service, await ready(service, "video"));
  await service.request({ action: "analyze_visual", referenceId: row.id, expectedRevision: row.revision }, { actor: "agent:test" }); row = await service.settled(row.id);
  assert.equal(row.state, "ready"); assert.equal(row.brief.style, "Warm orchestral music");
  assert.match(row.visual.text, /Observed walking/); assert.equal(submitted.actor, "agent:test"); assert.equal(submitted.via, "music.references.visual");
  assert.deepEqual(submitted.graph[3].inputs.image, ["2", 0]); assert.equal(submitted.graph[3].inputs.video, undefined);
  assert.match(submitted.graph[3].inputs.prompt, /2.5, 3.5/);
  assert.match((await service.request({ action: "get", referenceId: row.id, preview: true })).reference.contactSheetDataUrl, /^data:image\/jpeg;base64,/);
});

test("transcription uses the exact staged region and a score request prepares on every YuE2 build", async t => {
  const abc = ['X:1', 'T:', 'M:4/4', 'L:1/16', 'Q:1/4=120',
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
    'V: Ins clef=treble name="Ins Melody" snm="Inst."', 'K:C', '% verse',
    'V: Vocal', 'C4D4E4G4|A4G4E4C4|', 'V: Ins', 'C8G8|F8C8|'].join('\n'); let received;
  const { service } = await fixture(t, { songToScore: async args => { received = args; return { abc, bpm: 108, mode: args.mode, runId: "score1" }; } });
  let row = await edit(service, await ready(service));
  await service.request({ action: "transcribe", referenceId: row.id, expectedRevision: row.revision, mode: "melody" }, { actor: "user" }); row = await service.settled(row.id);
  assert.equal(received.actor, "user"); assert.equal(path.basename(received.source.path), "region.wav"); assert.equal(received.mode, "melody");
  /* ComfyUI's YuE2GenerateMusic takes the score as text (Tika R2b, 2026-09-24): the
   * prepared request carries it, and no abcOpen (that build sings it as written). */
  row = (await service.request({ action: "prepare_request", referenceId: row.id, expectedRevision: row.revision, reviewed: true, useScore: true, engine: "yue2-comfy" })).reference;
  assert.equal(row.prepared.request.engine, "yue2-comfy"); assert.equal(row.prepared.request.abc, abc); assert.equal(row.prepared.request.cot, "melody");
  assert.equal(row.prepared.request.abcOpen, undefined); assert.equal(row.prepared.makeSongArguments.abc, abc); assert.equal(row.prepared.makeSongArguments.abc_open, undefined);
  assert.deepEqual((await service.request({ action: "capabilities" })).scoreEngines, ["yue2", "yue2-comfy", "yue2-gguf"]);
  const request = (await service.request({ action: "prepare_request", referenceId: row.id, expectedRevision: row.revision, reviewed: true, useScore: true, engine: "yue2-gguf" })).reference.prepared.request;
  assert.equal(request.abc, abc); assert.equal(request.cot, "melody"); assert.equal(request.abcOpen, undefined);
  let newer = (await service.request({ action: "get", referenceId: row.id })).reference;
  assert.equal(newer.prepared.makeSongArguments.abc, abc);
  assert.equal(newer.prepared.makeSongArguments.abc_open, undefined);
  await service.request({ action: "transcribe", referenceId: newer.id, expectedRevision: newer.revision, mode: "melody" });
  newer = await service.settled(newer.id); assert.equal(newer.prepared, null, "new score requires a newly reviewed request");
  const corrected = (await service.request({ action: "update_score", referenceId: row.id, expectedRevision: newer.revision, abc: "unfinished", mode: "melody" })).reference;
  assert.equal(corrected.score.check.ok, false); assert.equal(corrected.prepared, null);
  await assert.rejects(service.request({ action: "prepare_request", referenceId: row.id, expectedRevision: corrected.revision, reviewed: true, useScore: true }), /No validated score/);
});

test("actual CPU ffmpeg/Pillow preparation produces bounded timestamped frames and a staged audio window", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reference-media-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.mp4"), dest = path.join(dir, "prepared"); await mkdir(dest);
  await runReferenceProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000", "-t", "2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", source]);
  const python = process.env.AIPLAY_REFERENCE_TEST_PYTHON || "python";
  // Beat dependency can be absent on a test machine; preparation must still work and say so.
  const got = await prepareReferenceMedia({ source, directory: dest, body: { kind: "video", startSeconds: .25, seconds: 1, maxFrames: 2 }, config: { python } });
  assert.deepEqual(got.evidence.timestamps, [.5, 1]); assert.equal(got.evidence.hasAudio, true);
  const jpg = await readFile(path.join(dest, "contact.jpg")); assert.equal(jpg.readUInt16BE(0), 0xffd8); assert.ok(jpg.length < 500000);
  const audio = JSON.parse(await runReferenceProcess("ffprobe", ["-v", "error", "-show_format", "-of", "json", path.join(dest, "region.wav")]));
  assert.ok(Math.abs(Number(audio.format.duration) - 1) < .02);
});
