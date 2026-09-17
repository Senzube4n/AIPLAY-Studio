/**
 * Hum a melody → a YuE2 score, 2026-09-17.
 *
 * The "hum only" half of the YuE2-hum-to-song recipe with a pitch tracker in
 * place of its 229 MB transcriber, and the "continue" half as the driver's
 * open-score flag. Pinned: the tracker turns a synthetic six-note hum (E G A
 * B A E, with vibrato and breaths) into exactly six notes in the planner's own
 * two-voice layout, which the app's score reader accepts; and the wiring —
 * /api/hum, --abc-open behind /api/generate's abcOpen, the door's argv, the
 * job pump, hum_to_score and make_song.abc_open, the page's record block,
 * the doc. The tracker runs only when the engine's python is here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import { readScore } from "../score/abc.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));

console.log("\n§1  the tracker, on a synthetic hum");
{
  const python = config.python;
  const has = python && fs.existsSync(python)
    && spawnSync(python, ["-c", "import librosa, soundfile"], { encoding: "utf8" }).status === 0;
  if (!has) {
    console.log("  skip  the engine's python with librosa is not on this machine; the tracker was not run");
  } else {
    const wav = path.join(os.tmpdir(), `aiplay-hum-test-${process.pid}.wav`);
    const gen = [
      "import numpy as np, soundfile as sf, sys",
      "sr = 22050; y = []",
      "for m, d in [(64, .55), (67, .55), (69, .5), (71, 1.0), (69, .5), (64, 1.1)]:",
      "    f = 440 * 2 ** ((m - 69) / 12); t = np.arange(int(sr * d)) / sr; vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t)",
      "    env = np.minimum(1, t / 0.03) * np.minimum(1, (d - t) / 0.05)",
      "    y.append(0.4 * env * (np.sin(2*np.pi*f*vib*t) + 0.35*np.sin(2*np.pi*2*f*vib*t) + 0.15*np.sin(2*np.pi*3*f*vib*t))); y.append(np.zeros(int(sr * 0.09)))",
      "sf.write(sys.argv[1], np.concatenate(y).astype(np.float32), sr)",
    ].join("\n");
    const g = spawnSync(python, ["-c", gen, wav], { encoding: "utf8" });
    ok("a six-note hum was synthesised", g.status === 0 && fs.existsSync(wav), (g.stderr || "").slice(-300));
    const r = spawnSync(python, [path.join(here, "hum_to_abc.py"), wav, "--json"], { encoding: "utf8" });
    ok("the tracker ran", r.status === 0, (r.stderr || "").slice(-300));
    let j = null;
    try { j = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { /* not JSON */ }
    ok("...and answered JSON", !!j && typeof j.abc === "string");
    if (j) {
      ok(`it heard six notes (heard ${j.notes})`, j.notes === 6);
      ok(`over two bars (${j.bars})`, j.bars === 2);
      ok(`between E4 and B4 (${JSON.stringify(j.pitchRange)})`, j.pitchRange?.[0] === 64 && j.pitchRange?.[1] === 71);
      ok(`in a key on E (${j.key})`, /^E/.test(String(j.key)));
      ok("the score is the planner's own layout",
        /^X:1\nT:\nM:4\/4\nL:1\/32\nQ:1\/4=\d+\nV: Vocal clef=treble[^\n]*\nV: Ins clef=treble[^\n]*\nK:/.test(j.abc));
      ok("...with the hum on the Vocal voice and rests on the Ins voice", /V: Vocal\nE6/.test(j.abc) && /V: Ins\nZ\|Z\|/.test(j.abc));
      let read = null;
      try { read = readScore(j.abc, { slug: "hum", versionId: "v1" }); } catch (e) { read = { threw: e.message }; }
      ok("the app's score reader accepts it", read && !read.threw && read.worst !== "fail", JSON.stringify(read?.worst ?? read?.threw));
    }
    try { fs.unlinkSync(wav); } catch { /* gone */ }
    const c = spawnSync(python, ["-m", "py_compile", path.join(here, "hum_to_abc.py")], { encoding: "utf8" });
    ok("hum_to_abc.py byte-compiles under the engine's python", c.status === 0, (c.stderr || "").slice(-200));
  }
}

console.log("\n§2  the wiring names the field at every hand");
{
  const py = src("./yue_driver.py"), yue = src("./yue.js"), jobs = src("../jobs.js"), index = src("../index.js");
  const mcp = src("../mcp.js"), router = src("../chat/router.js"), html = src("../../web/index.html");
  const app = src("../../web/app.js"), api = src("../../API.md"), hum = src("./hum.js");
  ok("hum.js stages the three source shapes and refuses the rest by sentence",
    /const kinds = \["path", "library_file", "data_url"\]/.test(hum) && /class HumRefusal extends Error/.test(hum));
  ok("...converts with ffmpeg to 22.05 kHz mono before the tracker",
    /\["-y", "-v", "error", "-i", staged\.path, "-ac", "1", "-ar", "22050", "-f", "wav", wav\]/.test(hum));
  ok("the driver takes --abc-open", /add_argument\("--abc-open", action="store_true",/.test(py));
  ok("...and leaves the score open: [EOD] text [ABC_START] seed, no end",
    /open_prefix = \[EOD\] \+ pipe\.tokenizer\.encode\(req\.text\(\)\) \+ \[ABC_START\] \+ seed_ids/.test(py));
  ok("...runs the planner from there", /pipe\._generate\(open_prefix, sampling, req\.seed, "abc",/.test(py));
  ok("...and hands back a plan carrying seed plus continuation",
    /full = seed_ids \+ \[int\(t\) for t in ids\]/.test(py) && /SymbolicPlan\(opened, pipe\.tokenizer\.decode\(full\), full,/.test(py));
  ok("...refusing cot off", /--abc-open needs a supplied abc and cot full or melody/.test(py));
  ok("...and records it in the receipt", /"abcOpen": bool\(args\.abc_open\),/.test(py));
  ok("the door forwards it only with a score and the plan on",
    /abcOpen: !!abcOpen && !!abc && cot !== "off",/.test(yue) && /\.\.\.\(args\.abcOpen \? \["--abc-open"\] : \[\]\),/.test(yue));
  ok("the job pump passes it", /abcOpen: !!job\.abcOpen,/.test(jobs));
  ok("/api/generate accepts abcOpen with a score", /abcOpen: !!abc && \(body\.abcOpen === true \|\| seeded\),/.test(index));
  ok("/api/hum exists and answers the tracker's refusals with its status",
    /p === "\/api\/hum" && req\.method === "POST"/.test(index)
    && /return json\(res, e\?\.status \|\| 400, \{ error: e\?\.message \|\| String\(e\) \}\);/.test(index));
  ok("hum_to_score exists, requires source, and forwards every declared parameter",
    /name: "hum_to_score",/.test(mcp) && /required: \["source"\],/.test(mcp) && /\{ source: a\.source, bpm: a\.bpm, key: a\.key \}/.test(mcp));
  ok("make_song declares abc_open and forwards it", /abc_open: \{ type: "boolean"/.test(mcp) && /abcOpen: a\.abc_open === true \? true : undefined,/.test(mcp));
  ok("the chat router lists the tool as free", /hum_to_score: null,/.test(router));
  ok("the page has the record, stop, file and open-score controls under Advanced Options",
    /id="humRec"/.test(html) && /id="humStop" hidden/.test(html) && /id="humFile" accept="audio\/\*" hidden/.test(html) && /id="yAbcOpen"/.test(html));
  ok("...posts the recording to /api/hum and fills the score box",
    /fetch\(song \? "\/api\/song_to_score" : "\/api\/hum", \{/.test(app) && /\$\("yAbc"\)\.value = r\.abc;/.test(app) && /\$\("yAbcUse"\)\.checked = true;/.test(app));
  ok("...and sends abcOpen with the score", /if \(out\.abc && \$\("yAbcOpen"\)\?\.checked\) out\.abcOpen = true;/.test(app));
  ok("the API doc describes /api/hum and abcOpen", /### `POST \/api\/hum`/.test(api) && /"abcOpen": true/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
