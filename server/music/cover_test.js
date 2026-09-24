/**
 * Cover a song, 2026-09-17.
 *
 * The published Song-To-ABC workflow (realrebelai/LOW_VRAM_Workflows), read
 * node by node, is SheetSage2AudioToABC feeding YuE2GenerateMusic under a new
 * style line — all core ComfyUI nodes from 0.35. Pinned here: the transcription
 * graph is that lane exactly, the catalogue row for the encoder carries the
 * file's real size and hash at a pinned revision under its own licence, the
 * route refuses by needsModel when the encoder is absent, and the route, the
 * tool, the router, the page and the doc each name the field. No card: the
 * graph is built, not run.
 */
import fs from "node:fs";
import { buildSongToScoreGraph, SHEETSAGE_FILE, SHEETSAGE_CAPABILITY, MODES, CoverRefusal, songToScore } from "./cover.js";
import { CATALOG } from "../models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the graph is the workflow's transcription lane");
{
  const g = buildSongToScoreGraph({ audio: "aiplay_cover_abc123def456.wav", mode: "melody" });
  eq("node 1 loads the encoder by its shelf name", [g["1"].class_type, g["1"].inputs.audio_encoder_name], ["AudioEncoderLoader", SHEETSAGE_FILE]);
  eq("node 2 loads the staged audio by name", [g["2"].class_type, g["2"].inputs.audio], ["LoadAudio", "aiplay_cover_abc123def456.wav"]);
  eq("node 3 transcribes, wired to both", [g["3"].class_type, g["3"].inputs.audio_encoder, g["3"].inputs.audio, g["3"].inputs.mode],
    ["SheetSage2AudioToABC", ["1", 0], ["2", 0], "melody"]);
  eq("node 4 previews the text, which is how /history hands it back", [g["4"].class_type, g["4"].inputs.source], ["PreviewAny", ["3", 0]]);
  eq("full mode keeps the chords", buildSongToScoreGraph({ audio: "x.wav", mode: "full" })["3"].inputs.mode, "full");
  eq("the two modes are the node's own", MODES, ["melody", "full"]);
  let threw = null; try { buildSongToScoreGraph({ audio: "x.wav", mode: "chords" }); } catch (e) { threw = e.message; }
  ok("an unknown mode is refused", /mode must be one of/.test(threw || ""));
}

console.log("\n§2  the catalogue row for the encoder");
{
  const row = CATALOG.find((c) => c.id === SHEETSAGE_CAPABILITY);
  ok("the row exists", !!row);
  if (row) {
    const f = row.files?.[0];
    ok("...one file, on the audio_encoders shelf", row.files?.length === 1 && /audio_encoders[\\/]sheetsage2_bf16\.safetensors$/.test(f?.dest || ""));
    ok("...at a pinned revision of Comfy-Org/YuE2", /\/Comfy-Org\/YuE2\/resolve\/8e6fcf0f23252ed188b634bd50d44f4b01fba890\/audio_encoders\/sheetsage2_bf16\.safetensors$/.test(f?.url || ""));
    eq("...with the LFS size", f?.bytes, 1386868122);
    eq("...and the LFS sha256", f?.sha256, "5fd960ce3df281e3f3a889d174584d88f96247711480cf96377b12d7e8b6adc5");
    ok("...under CC BY-NC, with the verbatim grant and the licence link", /CC BY-NC 4\.0/.test(row.licence) && /NonCommercial purposes only/.test(row.outputRights?.quote || "") && /m-a-p\/SheetSage2\/blob\/main\/LICENSE/.test(row.outputRights?.url || ""));
    ok("...and says the original song's rights are the caller's", (row.outputRights?.conditions || []).some((c) => /recording's own rights/.test(c)));
    ok("...not required, and honest about the unmeasured hardware", row.required === false && /Not yet measured/.test(row.requires?.note || ""));
  }
}

console.log("\n§3  the route refuses without the encoder, and by needsModel");
{
  const fakeEngine = { run: async () => { throw new Error("must not run"); }, history: async () => ({}) };
  /* Point the presence check at a folder with no shelf: config.modelsDir is
   * read at call time, so this is a temp dir with nothing in it. */
  const { config } = await import("../config.js");
  const os = await import("node:os"); const path = await import("node:path");
  const saved = Object.getOwnPropertyDescriptor(config, "modelsDir");
  Object.defineProperty(config, "modelsDir", { value: path.join(os.tmpdir(), "aiplay-cover-test-empty"), configurable: true });
  let err = null;
  try { await songToScore({ source: { path: "C:/nowhere.wav" }, mode: "melody", engine: fakeEngine }); } catch (e) { err = e; }
  if (saved) Object.defineProperty(config, "modelsDir", saved);
  ok("a missing encoder is a CoverRefusal naming the catalogue row", err instanceof CoverRefusal && err.needsModel === SHEETSAGE_CAPABILITY, String(err?.message));
  let err2 = null;
  try { await songToScore({ source: { path: "C:/nowhere.wav" }, mode: "chords", engine: fakeEngine }); } catch (e) { err2 = e; }
  ok("an unknown mode is refused before anything is staged", err2 instanceof CoverRefusal && /mode must be melody or full/.test(err2.message));
}

console.log("\n§4  every hand names the field");
{
  const index = src("../index.js"), mcp = src("../mcp.js"), router = src("../chat/router.js");
  const html = src("../../web/index.html"), app = src("../../web/app.js"), api = src("../../API.md"), cover = src("./cover.js");
  ok("/api/song_to_score exists and passes the engine door and the actor",
    /p === "\/api\/song_to_score" && req\.method === "POST"/.test(index) && /songToScore\(\{ source, mode: b\.mode \|\| "melody", engine: engineDoor, actor: prov\.actorFrom\(req\) \}\)/.test(index));
  ok("...answering refusals with needsModel, and a stem's setup fields after it",
    /\.\.\.\(e\?\.needsModel \? \{ needsModel: e\.needsModel \} : \{\}\), \.\.\.refusalFields\(e\) \}\);/.test(index));
  ok("cover.js reads the score out of /history, since the door lists files only", /engine\.history\(r\.promptId\)/.test(cover) && /outputs\?\.\["4"\]\?\.text/.test(cover));
  ok("...stages a browser recording as WAV for LoadAudio", /\[".wav", ".mp3", ".flac", ".ogg", ".m4a"\]\.includes\(ext\)/.test(cover));
  ok("song_to_score exists, takes source or a flat library_file, forwards mode and the stem", /name: "song_to_score",/.test(mcp)
    && /\{ source: a\.source \?\? \(a\.library_file \? \{ library_file: safeName\(a\.library_file, "song"\) \} : undefined\), mode: a\.mode, stem: a\.stem === "vocals" \? "vocals" : undefined \}/.test(mcp)
    && /if \(r\?\.error\) throw new Error\(refusalText\(r\)\);/.test(mcp));
  ok("the chat router knows it holds the card", /song_to_score: "gpu",/.test(router));
  ok("the page offers the transcriber and the mode", /id="humEngine"/.test(html) && /<option value="song">[^<]*SheetSage2/.test(html) && /id="humMode"/.test(html));
  ok("...and posts a whole song to /api/song_to_score with the mode", /fetch\(song \? "\/api\/song_to_score" : "\/api\/hum"/.test(app) && /mode: \$\("humMode"\)\?\.value \|\| "melody"/.test(app));
  ok("the API doc describes the cover recipe", /### `POST \/api\/song_to_score`/.test(api) && /needsModel: "coverSheetSage2"/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
