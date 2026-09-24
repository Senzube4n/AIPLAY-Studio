import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, utimes, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const parent = path.resolve(tmpdir()), scratch = await mkdtemp(path.join(parent, "aiplay-native-wav-test-"));
process.env.AIPLAY_APPDATA = path.join(scratch, "appdata");
process.env.AIPLAY_RIG = path.join(scratch, "rig");
process.env.AIPLAY_OUTPUT = path.join(scratch, "output");
process.env.AIPLAY_PYTHON = path.join(scratch, "must-not-run-python.exe");
const { tagNativeWav, readNativeWavTags, isNativeLibraryWav } = await import("./library-wav.js");
const { Library } = await import("./library.js");
const { config } = await import("./config.js");
const { renameAtomic } = await import("./fs-atomic.js");
after(async () => {
  assert.equal(path.dirname(path.resolve(scratch)), parent);
  assert.ok(path.basename(scratch).startsWith("aiplay-native-wav-test-"));
  await rm(scratch, { recursive: true, force: true });
});
const wav = () => {
  const out = Buffer.alloc(44 + 400);
  out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(48000, 24); out.writeUInt32LE(192000, 28);
  out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write("data", 36);
  out.writeUInt32LE(400, 40); for (let i = 44; i < out.length; i++) out[i] = i % 251;
  return out;
};
test("native filename scope rejects traversal and does not replace existing format taggers", () => {
  assert.equal(isNativeLibraryWav("aiplay_yue2_gguf_ab12.wav"), true);
  for (const f of ["../aiplay_yue2_gguf_ab.wav", "aiplay_yue2_ab.flac", "aiplay_other.wav", "aiplay_yue2_gguf_a.wav/../x"]) assert.equal(isNativeLibraryWav(f), false);
});
test("WAV tags preserve PCM bytes, exact duration and original timestamp without Python", async () => {
  const file = path.join(scratch, "record.wav"), original = wav();
  await writeFile(file, original); await utimes(file, 1000000, 1000000);
  const before = await stat(file);
  const result = await tagNativeWav(file, { title: "Étoiles 🌙", lyrics: "Soft words", caption: "Piano", generator: "YuE2 GGUF", seed: 11 });
  const bytes = await readFile(file);
  assert.deepEqual(bytes.subarray(12, original.length), original.subarray(12));
  assert.equal(result.seconds, 100 / 48000); assert.equal(result.embedded, false);
  assert.equal(result.title, "Étoiles 🌙"); assert.equal(result.lyrics, "Soft words");
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  assert.match(bytes.toString("utf8"), /AI_DISCLOSURE=.*AI-generated audio/);
  /* The catalogue's credit line (models.js, the YuE2 authors' statement of
   * 15 Sep 2026), with the licence file named in it. */
  assert.match(result.attribution, /Sellable by individuals/);
  assert.match(result.attribution, /licence file: CC BY-NC 4\.0/);
  assert.deepEqual(await readNativeWavTags(file), result);
});
test("retags are serialized, keep attribution with detail disabled, and do not accumulate INFO", async () => {
  const file = path.join(scratch, "retag.wav"); await writeFile(file, wav());
  const raw = { title: "Take", lyrics: "Private text", caption: "Private style", attribution: ["Artist — CC BY-NC 4.0"], tier2: false };
  await Promise.all([tagNativeWav(file, raw), tagNativeWav(file, raw)]);
  const once = await readFile(file); await tagNativeWav(file, raw);
  assert.deepEqual(await readFile(file), once);
  const result = await readNativeWavTags(file);
  assert.equal(result.lyrics, undefined); assert.equal(result.caption, undefined);
  assert.match(result.attribution, /Artist/); assert.match(result.digitalSourceType, /trainedAlgorithmicMedia$/);
  assert.doesNotMatch(once.toString(), /Private text|Private style/);
});
test("malformed WAV and excessive metadata preserve the original and leave no temporary file", async () => {
  const file = path.join(scratch, "invalid.wav"), broken = Buffer.from("not a wav");
  await writeFile(file, broken); await assert.rejects(tagNativeWav(file, {}));
  assert.deepEqual(await readFile(file), broken);
  const valid = path.join(scratch, "large.wav"), original = wav(); await writeFile(valid, original);
  await assert.rejects(tagNativeWav(valid, { provenance: { oversized: "x".repeat(70000) } }), /64KiB/);
  assert.deepEqual(await readFile(valid), original);
  assert.equal((await readdir(scratch)).some((f) => f.endsWith(".tmp")), false);
});
test("native WAV survives durable Library reload and reads tags/duration with no Python executable", async () => {
  await mkdir(config.outputDir, { recursive: true });
  const library = new Library(); await library.load();
  const name = "aiplay_yue2_gguf_fixture.wav"; await writeFile(path.join(config.outputDir, name), wav());
  await library.tagFile(name, { title: "Native take", model: "YuE2 GGUF Q4", seed: 123, tier2: true });
  const warnings = [{ code: "possible_semantic_limit", evidence: "duration_near_configured_limit", message: "Check the ending." }];
  const generationLimits = { semanticMaxTokens: 9000, approxMaxAudioSeconds: 360, source: "installed-sidecars" };
  // Wait for the real persistence call triggered by remember, not a second
  // save() that can return early once dirty has already been cleared.
  const save = library.save.bind(library); let persisted;
  library.save = () => (persisted = save());
  library.remember(name, { title: "Native take", model: "YuE2 GGUF Q4", engine: "yue2-gguf", quantization: "q4_0",
    warnings, generationLimits });
  await persisted;
  await library.save();
  const reload = new Library(); await reload.load();
  const rows = await reload.list();
  assert.equal(rows.find((r) => r.file === name)?.engine, "yue2-gguf");
  assert.deepEqual(rows.find((r) => r.file === name)?.warnings, warnings);
  assert.deepEqual(rows.find((r) => r.file === name)?.generationLimits, generationLimits);
  const old = "aiplay_yue2_gguf_old.wav"; await writeFile(path.join(config.outputDir, old), wav());
  const oldRow = (await reload.list()).find((r) => r.file === old);
  assert.deepEqual(oldRow.warnings, []); assert.equal(oldRow.generationLimits, null);
  assert.equal((await reload.readTags(name)).model, "YuE2 GGUF Q4");
  assert.equal(await reload.durationOf(name), 100 / 48000);
});

test("renameAtomic retries a held file and gives up only on a real failure", async () => {
  const held = (codes) => { let n = 0; const fn = async () => { const c = codes[n++]; if (c) throw Object.assign(new Error(c), { code: c }); }; fn.calls = () => n; return fn; };
  const twice = held(["EPERM", "EBUSY"]);
  await renameAtomic("a", "b", 12, { renameFn: twice });
  assert.equal(twice.calls(), 3, "two transient refusals, then the rename");
  const gone = held(["ENOENT"]);
  await assert.rejects(renameAtomic("a", "b", 12, { renameFn: gone }), { code: "ENOENT" });
  assert.equal(gone.calls(), 1, "a missing file is not retried");
  const stuck = held(Array(20).fill("EACCES"));
  const t0 = Date.now();
  await assert.rejects(renameAtomic("a", "b", 12, { renameFn: stuck }), { code: "EACCES" });
  assert.equal(stuck.calls(), 13, "twelve retries after the first try, then the error unchanged");
  assert.ok(Date.now() - t0 < 2000, "about 0.8 s of backoff, not longer");
});
test("a native WAV held open for a moment is still tagged (the EPERM in the report)", { skip: process.platform !== "win32" && "the lock is a Windows rule" }, async () => {
  const file = path.join(scratch, "held.wav"); await writeFile(file, wav());
  const handle = await open(file, "r");
  const release = new Promise((ok) => setTimeout(() => handle.close().then(ok), 150));
  const result = await tagNativeWav(file, { title: "Held" });
  await release;
  assert.equal(result.title, "Held");
  assert.equal((await readNativeWavTags(file)).title, "Held");
});
test("library rows say how the song may be sold and whether its tags were written", async () => {
  await mkdir(config.outputDir, { recursive: true });
  const library = new Library(); await library.load();
  const names = ["aiplay_yue2_gguf_rights.wav", "aiplay_yue2_gguf_pending.wav", "aiplay_yue2_gguf_legacy.wav",
    "aiplay_yue2_gguf_twin.wav", "aiplay_yue2_gguf_continued.wav", "aiplay_imported_voice.wav"];
  for (const n of names) await writeFile(path.join(config.outputDir, n), wav());
  library.remember(names[0], { engine: "yue2-gguf", taggedAt: Date.now(), rights: "CC BY-NC 4.0 — not for sale" });
  library.remember(names[1], { engine: "yue2-comfy", loraClip: "ar_lora_inst_v3abc_comfyui.safetensors", tagPending: { at: 1, error: "EPERM" } });
  library.remember(names[2], {});
  library.remember(names[3], { engine: "yue2-gguf" });
  /* A recording continued through the real-audio tokenizer: the sidecar
   * index.js now writes for it (tokenized, with no coverOf). */
  library.remember(names[4], { engine: "yue2", extendedFrom: names[5], tokenized: { frames: 750, seconds: 15 } });
  library.remember(names[5], { imported: true, importedFrom: "C:/Music/voice.wav" });
  const rows = await library.list();
  const row = (n) => rows.find((r) => r.file === n);
  assert.equal(row(names[0]).rights.class, "yours-with-conditions", "the sidecar's old words are not read back");
  assert.equal(row(names[0]).rights.sellable, true);
  assert.match(row(names[0]).rights.label, /^Sellable by individuals \(YuE2 authors' statement, 15 Sep 2026\) · companies need a commercial licence$/);
  assert.equal(row(names[0]).rights.capability, "musicYue2Gguf");
  assert.equal(row(names[0]).rights.changed?.from, "not-for-sale");
  assert.equal(row(names[1]).rights.class, "not-for-sale", "the instrumental planner LoRA keeps its own label and makes the song stricter");
  assert.deepEqual(row(names[1]).rights.addOns, ["musicYue2InstrumentalLora"]);
  assert.equal(row(names[2]).rights.class, "unknown");
  /* The B4 shape only: the credit lines are songCredit's (read where a file is
   * tagged), and /api/status carries these rows every four seconds. */
  for (const n of names) {
    assert.equal(row(n).rights.attribution, undefined, `${n}: no credit lines on a list row`);
    assert.equal(row(n).rights.engineCapability, undefined, `${n}: no engine id on a list row`);
  }
  assert.ok(JSON.stringify(row(names[0]).rights).length < 700, "a YuE2 row's rights stay small");
  assert.deepEqual(row(names[3]).rights, row(names[0]).rights, "two songs made the same way read the same");
  assert.notEqual(row(names[3]).rights.addOns, row(names[0]).rights.addOns, "...without sharing an array a caller could change");
  assert.equal(row(names[4]).rights.class, "not-for-sale", "a continued recording went through the tokenizer, which is not for sale");
  assert.deepEqual(row(names[4]).rights.addOns, ["musicYue2Tokenizer"]);
  assert.equal(row(names[5]).rights.class, "unknown", "Studio has read nothing about an imported file");
  assert.equal(row(names[5]).rights.basis, "imported");
  assert.doesNotMatch(row(names[5]).rights.label, /unverified/i, "a person's own recording is not called unverified");
  assert.equal(row(names[0]).tagged, true);
  assert.equal(row(names[1]).tagged, false);
  assert.equal(row(names[2]).tagged, null);
});
test("a cover landing on a native WAV never calls tagFile, and the backfill leaves them out", async () => {
  const INDEX = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const at = INDEX.indexOf("async function embedCover(file, coverName) {");
  assert.ok(at >= 0, "index.js has embedCover");
  const end = INDEX.indexOf("\n}\n", at);
  const body = INDEX.slice(INDEX.indexOf("{", at) + 1, end);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const embedCover = new AsyncFunction("file", "coverName", "library", "config", "path", "COVER_DIR", "songProvMeta", "isNativeLibraryWav", "songCredit", body);
  const calls = [], remembered = [];
  const fake = { meta: new Map(), tagFile: async (...a) => { calls.push(a); return { ok: true, cover: true }; }, remember: (f2, d) => remembered.push([f2, d]) };
  const run = (file) => embedCover(file, "c.png", fake, { sampling: { shift: 1 } }, path, "covers", async () => ({}), isNativeLibraryWav, () => ({ attribution: "credit line" }));
  const skipped = await run("aiplay_yue2_gguf_x.wav");
  assert.equal(calls.length, 0, "a WAV that cannot hold a picture is not rewritten");
  assert.equal(skipped.cover, false);
  await run("aiplay_00001.flac");
  assert.equal(calls.length, 1, "a FLAC still gets its cover");
  assert.equal(calls[0][1].attribution, "credit line", "...and the model's credit line rides in its tags");
  assert.ok(remembered.some(([, d]) => d.coverEmbedded === true) && remembered.some(([, d]) => d.taggedAt && d.tagPending === null),
    "and a successful pass settles a first pass that failed");
  assert.match(INDEX, /!\/\\\.mp3\$\/i\.test\(t\.file\) && !isNativeLibraryWav\(t\.file\)\);/, "the embed backfill skips native WAVs");
  assert.match(INDEX, /library\.remember\(h\.file, \{ tagPending: \{ at: Date\.now\(\), error: why \} \}\);/, "a failed first pass is remembered, not swallowed");
});
