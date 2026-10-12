/**
 * A LIBRARY SONG WITH BRACKETS, COMMAS, ACCENTS OR .opus STILL RIDES UNDER A
 * CLIP, AND ONE THAT CANNOT IS NEVER DROPPED UNSAID (2026-10-08, found
 * preparing REWIND and Voodoo Love).
 *
 * /api/video staged a Library song only when its file name matched
 * [\w. -]+ with one of five extensions. "aiplay_Voodoo Love (K-pop
 * rework).wav" did not, so the soundtrack was dropped by a bare `catch {}`:
 * the clip rendered with H3's own sound and no lip-sync, the reply carried no
 * warning, and the plan, which read the request, still said "+ song
 * (lip-sync)". Every .opus song (Settings > Output format = opus) was dropped
 * the same way, reference audios were dropped the same way, and the ACE cover
 * door refused such a song with "not in the output folder any more".
 *
 *   §1 server/songstage.js: every name the Library lists stages; a name that
 *      is not a bare Library file name is refused with a sentence naming it.
 *   §2 the copy follows the song: a replaced song is staged again, an
 *      unchanged one is not copied twice, and .opus is staged as .ogg.
 *   §3 the /api/video staging block, lifted from index.js and run with its
 *      free names injected: the soundtrack stages, a missing one refuses the
 *      clip by name, a lost reference audio is said as a warning, and the
 *      plan reads what staged.
 *   §4 every door that stages a Library song uses the one helper.
 *
 * Temp folders only: no server, no ComfyUI, no GPU.
 *
 *   node --test server/songstage_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { libraryName, stageLibrarySong, STAGED_SONG, SONG_EXTS } from "./songstage.js";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const box = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "songstage-"));
  const outputDir = path.join(dir, "output"), inputDir = path.join(dir, "input");
  fs.mkdirSync(outputDir, { recursive: true });
  return { dir, outputDir, inputDir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

/* The names the 7b241ea probe dropped, and the control that staged. */
const NAMES = [
  "aiplay_voodoo_mv.wav",
  "aiplay_Voodoo Love (K-pop rework).wav",
  "aiplay_Voodoo Love, take 2.wav",
  "aiplay_[REWIND] master.flac",
  "aiplay_Senzu's run.mp3",
  "aiplay_Rock & Roll.wav",
  "aiplay_Café nocturne.flac",
  "aiplay_api_mabc123.opus",
];

test("§1 every name the Library lists stages, and a name that is not a bare Library file is refused by name", async (t) => {
  const b = box(); t.after(b.done);
  for (const name of NAMES) {
    fs.writeFileSync(path.join(b.outputDir, name), Buffer.from(`song ${name}`));
    const staged = await stageLibrarySong(name, b);
    assert.match(staged, STAGED_SONG, `${name} -> ${staged}`);
    assert.deepEqual(fs.readFileSync(path.join(b.inputDir, staged)), Buffer.from(`song ${name}`), `${name}: its own bytes`);
    assert.equal(await stageLibrarySong(name, { ...b, check: true }), null, `${name}: a check stages nothing and passes`);
  }
  assert.deepEqual(SONG_EXTS.sort(), ["flac", "m4a", "mp3", "ogg", "opus", "wav"]);
  fs.writeFileSync(path.join(b.dir, "outside.wav"), "x");
  for (const bad of ["..\\outside.wav", "../outside.wav", "a/b.wav", "a\\b.wav", "x.wav:s", "C:outside.wav", ".", "..", "", "song.txt",
    "nul\u0000.wav", "trailing.wav ", "gone.wav"]) {
    await assert.rejects(stageLibrarySong(bad, b), (err) => err.reason === "song-missing" && typeof err.message === "string" && err.message.length > 10,
      JSON.stringify(bad));
  }
  await assert.rejects(stageLibrarySong("gone.wav", b), /The song "gone\.wav" is not in the Library's folder any more/);
  await assert.rejects(stageLibrarySong("a/b.wav", b), /"a\/b\.wav" is not the name of a song in the Library/);
  assert.equal(libraryName("aiplay_Voodoo Love (K-pop rework).wav").name, "aiplay_Voodoo Love (K-pop rework).wav");
  assert.equal(fs.readdirSync(b.inputDir).every((n) => STAGED_SONG.test(n)), true, "nothing but staged names lands in the input folder");
});

test("§2 a replaced song is staged again, an unchanged one is not copied twice, and .opus rides as .ogg", async (t) => {
  const b = box(); t.after(b.done);
  const name = "aiplay_Voodoo Love (K-pop rework).wav";
  const src = path.join(b.outputDir, name);
  fs.writeFileSync(src, Buffer.from("first take"));
  const first = await stageLibrarySong(name, b);
  const at = fs.statSync(path.join(b.inputDir, first)).mtimeMs;
  assert.equal(await stageLibrarySong(name, b), first, "the same song, the same staged name");
  assert.equal(fs.statSync(path.join(b.inputDir, first)).mtimeMs, at, "and not copied again");
  fs.writeFileSync(src, Buffer.from("the second, longer take"));
  fs.utimesSync(src, new Date(), new Date(Date.now() + 5000));
  const second = await stageLibrarySong(name, b);
  assert.notEqual(second, first, "a song replaced under the same name is a new copy (the music-video runner kept its first)");
  assert.deepEqual(fs.readFileSync(path.join(b.inputDir, second)), Buffer.from("the second, longer take"));
  fs.writeFileSync(path.join(b.outputDir, "aiplay_take.opus"), Buffer.from("OggS opus"));
  assert.match(await stageLibrarySong("aiplay_take.opus", b), /^aiplay_refaud_[0-9a-f]{12}\.ogg$/, "the Ogg bytes the upload door accepts as ogg");
});

/* §3: the staging block of POST /api/video create, lifted as it is. */
function liftStaging() {
  const index = read("./index.js");
  const start = index.indexOf("        let firstFrame, lastFrame, midFrames = [], refImages = [], refAudios = [], audioTrack, personaStaged = null, personaLost = 0;");
  const endMark = "        if (songRefusal) return json(res, 400, songRefusal);";
  const end = index.indexOf(endMark, start);
  assert.ok(start > 0 && end > start, "the staging block and its refusal are in index.js, in that order");
  const body = index.slice(start, end + endMark.length);
  const names = ["b", "config", "staged", "stageFrame", "stagePersonaForClip", "persona", "STAGED_SONG", "stageLibrarySong", "json", "res"];
  return new Function(...names, `return (async () => {\n${body}\nreturn { refAudios, audioTrack, refAudioLost };\n})();`);
}

test("§3 /api/video: the soundtrack stages whatever its name, a missing one refuses the clip by name, a lost reference audio is said", async (t) => {
  const b = box(); t.after(b.done);
  const run = liftStaging();
  for (const name of NAMES) fs.writeFileSync(path.join(b.outputDir, name), Buffer.from(name));
  const call = async (body) => {
    const said = [];
    const out = await run(body, { outputDir: b.outputDir, inputDir: b.inputDir }, () => undefined, async () => undefined,
      async () => ({ persona: null, lost: 0 }), null, STAGED_SONG, stageLibrarySong,
      (_res, status, payload) => { said.push({ status, payload }); return { status, payload }; }, {});
    return { out, said };
  };
  for (const name of NAMES) {
    const { out, said } = await call({ audioTrack: { name, start: 12 } });
    assert.equal(said.length, 0, `${name}: nothing refused`);
    assert.match(out.audioTrack?.name || "", STAGED_SONG, `${name}: the song rides under the clip (was dropped, no lip-sync)`);
    assert.equal(out.audioTrack.start, 12);
  }
  const missing = await call({ audioTrack: { name: "aiplay_gone (live).wav", start: 0 } });
  assert.equal(missing.said[0]?.status, 400, "a soundtrack that cannot be staged refuses the clip");
  assert.equal(missing.said[0].payload.reason, "song-missing");
  assert.equal(missing.said[0].payload.song, "aiplay_gone (live).wav");
  assert.match(missing.said[0].payload.error, /"aiplay_gone \(live\)\.wav" is not in the Library's folder any more[\s\S]*no lip-sync/);
  const refs = await call({ refAudios: [{ name: NAMES[1] }, { name: "aiplay_gone.wav" }, { name: "a/b.wav" }] });
  assert.equal(refs.said.length, 0, "a lost reference audio does not refuse the clip");
  assert.equal(refs.out.refAudios.length, 1, "the one that stages rides");
  assert.deepEqual(refs.out.refAudioLost, ["aiplay_gone.wav", "a/b.wav"], "and the others are named for the warning");
  const index = read("./index.js");
  assert.match(index, /if \(refAudioLost\.length\) \{\n\s+plan\.warnings\.push\(\{ id: "ref-audio-missing",/, "the reply says which reference audio was left out");
  assert.match(index, /const plan = videoPlan\(\{ \.\.\.b, \.\.\.optionalH3, refImages, refAudios, audioTrack \}, \{ engineKey: eng/,
    "the plan reads the soundtrack that staged, not the request");
  const check = index.slice(index.indexOf('if (b.action === "check") {'), index.indexOf('if (b.action === "create") {'));
  assert.match(check, /stageLibrarySong\(b\.audioTrack\.name, \{ outputDir: config\.outputDir, inputDir: config\.inputDir, check: true \}\)[\s\S]*?reason: "song-missing"/,
    "check_only and the Advanced line say the same before anything is copied");
});

test("§4 every door that stages a Library song uses the one helper, and no song name is judged by a character class", () => {
  const index = read("./index.js");
  assert.match(index, /try \{ cover = await stageLibrarySong\(c\.song, \{ outputDir: config\.outputDir, inputDir: config\.inputDir \}\); \}/,
    "the ACE cover door (it refused such a song as \"not in the output folder any more\")");
  assert.match(read("./mv/generate.js"), /return stageLibrarySong\(path\.basename\(String\(file\)\), \{ outputDir: config\.outputDir, inputDir: config\.inputDir \}\);/,
    "the music-video runner");
  assert.doesNotMatch(index, /\[\\w\. -\]\+\\\.\((flac|wav)/, "no [\\w. -]+ song test is left in index.js");
});
