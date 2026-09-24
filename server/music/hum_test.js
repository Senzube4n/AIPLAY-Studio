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
import { fileURLToPath } from "node:url";
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
const here = path.dirname(fileURLToPath(import.meta.url));
const { parseScore: parseScoreFn } = await import("../mcp-music-score.js");
/** The Vocal voice's sounding pitches, through the app's own score reader. */
function vocalPitches(abc) {
  const s = parseScoreFn(abc);
  return s?.ok ? (s.voices?.Vocal?.notes || []).map((n) => n[1]) : null;
}

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
    const t0 = Date.now();
    const r = spawnSync(python, [path.join(here, "hum_to_abc.py"), wav, "--json"], { encoding: "utf8" });
    const took = (Date.now() - t0) / 1000;
    ok("the tracker ran", r.status === 0, (r.stderr || "").slice(-300));
    /* Seconds, not minutes: a hum is read on the CPU with no model. The bound
     * includes python starting and importing librosa (most of it, cold). */
    ok(`...in seconds (${took.toFixed(1)} s for 4.7 s of hum, bound 30 s)`, took < 30);
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
    /* A breathy hum on a noisy laptop mic (2026-09-24 review): nine notes with
     * vibrato, six harmonics, breath and 20 dB SNR. pYIN's voiced flag and
     * pitch stay right while its voiced PROBABILITY sits near 0.43 over every
     * note, so an absolute 0.5 gate answered "No pitched notes were found"
     * here. The gate is relative to the recording and only for short runs. */
    const breathy = path.join(os.tmpdir(), `aiplay-hum-breathy-${process.pid}.wav`);
    const genB = [
      "import numpy as np, soundfile as sf, sys",
      "sr = 22050; rng = np.random.default_rng(7); parts = [np.zeros(int(sr * .6))]",
      "for m, d in [(60, .5), (62, .5), (64, .5), (65, .5), (67, 1.0), (65, .4), (64, .4), (62, .4), (60, 1.0)]:",
      "    n = int(sr * d); t = np.arange(n) / sr",
      "    f = 440 * 2 ** ((m - 69) / 12) * 2 ** ((0.25 * np.sin(2 * np.pi * 5.5 * t)) / 12)",
      "    ph = 2 * np.pi * np.cumsum(f) / sr",
      "    env = np.minimum(1, np.minimum(t / .04, (d - t) / .06)).clip(0, 1)",
      "    x = sum((0.6 ** k) * np.sin((k + 1) * ph) for k in range(6)) * env + 0.25 * rng.standard_normal(n) * env",
      "    parts += [x, np.zeros(int(sr * .08))]",
      "y = np.concatenate(parts); y = y / np.abs(y).max() * .5",
      "y = y + rng.standard_normal(len(y)) * np.sqrt(np.mean(y ** 2) / 10 ** (20 / 10))",
      "sf.write(sys.argv[1], y.astype(np.float32), sr)",
    ].join("\n");
    const gb = spawnSync(python, ["-c", genB, breathy], { encoding: "utf8" });
    ok("a breathy nine-note hum at 20 dB SNR was synthesised", gb.status === 0 && fs.existsSync(breathy), (gb.stderr || "").slice(-300));
    const rb = spawnSync(python, [path.join(here, "hum_to_abc.py"), breathy, "--json"], { encoding: "utf8" });
    let jb = null;
    try { jb = JSON.parse((rb.stdout || "").trim().split("\n").pop()); } catch { /* not JSON */ }
    const heard = jb ? (vocalPitches(jb.abc) || []) : [];
    ok(`...every note of it is read (${jb ? jb.notes : "refused: " + (rb.stderr || "").trim().split("\n").pop()})`,
      rb.status === 0 && jb?.notes === 9 && JSON.stringify(heard) === JSON.stringify([60, 62, 64, 65, 67, 65, 64, 62, 60]),
      JSON.stringify(heard));
    try { fs.unlinkSync(breathy); } catch { /* gone */ }
    const c = spawnSync(python, ["-m", "py_compile", path.join(here, "hum_to_abc.py")], { encoding: "utf8" });
    ok("hum_to_abc.py byte-compiles under the engine's python", c.status === 0, (c.stderr || "").slice(-200));
  }
}

console.log("\n§1b the score sounds the pitches it was given (key signature, bar accidentals, lengths)");
{
  /* The half-step bug a tester found (2026-09-24): every pitch was spelled as
   * if the key were C, then declared K:<key>, and the dialect applies that
   * signature plus any accidental to the end of its bar. Known note lists go
   * through the script's own bars_from/render and back through the app's own
   * reader; the sounding pitches and lengths must come back unchanged. Only
   * numpy is needed (the module imports it), not librosa. */
  const python = config.python;
  const has = python && fs.existsSync(python)
    && spawnSync(python, ["-c", "import numpy"], { encoding: "utf8" }).status === 0;
  if (!has) {
    console.log("  skip  the engine's python with numpy is not on this machine; the spelling was not run");
  } else {
    const { parseScore } = await import("../mcp-music-score.js");
    // [label, key, [[startUnit, units, midi], ...]] — one 4/4 bar is 32 units.
    const cases = [
      ["K:G with an F natural between F sharps", "G", [[0, 8, 67], [8, 8, 65], [16, 8, 66], [24, 8, 65], [32, 32, 67]]],
      ["K:F with a B natural, then B flat again in the same bar", "F", [[0, 8, 65], [8, 8, 71], [16, 8, 70], [24, 8, 71]]],
      ["K:C, ^F then F in one bar (the second F is natural)", "C", [[0, 16, 66], [16, 16, 65]]],
      ["an accidental carries across octaves by letter", "Bb", [[0, 8, 64], [8, 8, 76], [16, 8, 63], [24, 8, 75]]],
      ["a sharp tied over the barline, then the natural", "C", [[0, 24, 60], [24, 16, 66], [40, 8, 65], [48, 16, 64]]],
      ["K:Em, F natural and D sharp", "Em", [[0, 8, 64], [8, 8, 65], [16, 8, 63], [24, 8, 66]]],
      ["K:D, a chromatic D sharp is spelled sharp", "D", [[0, 8, 62], [8, 8, 63], [16, 16, 64]]],
      ["lengths outside the dialect's set are tied pieces (5, 7, 10, 11 units)", "C", [[0, 5, 60], [5, 7, 62], [12, 10, 64], [22, 10, 65]]],
      ["a repeated pitch stays two notes", "C", [[0, 16, 67], [16, 16, 67]]],
      ["G# major is written as its twin Ab", "G#", [[0, 16, 68], [16, 16, 70]]],
    ];
    const gen = [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "import hum_to_abc as h",
      "out = []",
      "for key, q in json.loads(sys.argv[2]):",
      "    k = h.table_key(key)",
      "    out.append([k, h.render(h.bars_from([list(n) for n in q], key), 100, k)])",
      "sys.stdout.write(json.dumps(out))",
    ].join("\n");
    const r = spawnSync(python, ["-c", gen, here, JSON.stringify(cases.map(([, k, q]) => [k, q]))], { encoding: "utf8" });
    ok("the renderer ran on the note lists", r.status === 0, (r.stderr || "").slice(-400));
    let rendered = [];
    try { rendered = JSON.parse(r.stdout); } catch { /* reported above */ }
    cases.forEach(([label, , q], i) => {
      const [written, abc] = rendered[i] || [];
      const s = abc ? parseScore(abc) : null;
      const got = (s?.voices?.Vocal?.notes || []).map(([at, pitch, ticks]) => [at / 128, ticks / 128, pitch]);
      ok(`${label}: the reader hears ${JSON.stringify(q.map((n) => n[2]))}`,
        !!s && s.ok && JSON.stringify(got) === JSON.stringify(q),
        `K:${written} ${JSON.stringify((abc || "").split("\n").slice(10).join(" | "))} → ${JSON.stringify(got)} ${JSON.stringify(s?.problems?.map((p) => p.says) || [])}`);
    });
    ok("the twin key is the one written in K:", rendered[9]?.[0] === "Ab" && /\nK:Ab\n/.test(rendered[9]?.[1] || ""));
    const sharpF = rendered[0]?.[1] || "";
    ok("...and the natural is marked where the signature would sharpen it", /\nG8=F8\^F8=F8\|G32\|\n/.test(sharpF), sharpF);
    const rests = spawnSync(python, ["-c", [
      "import sys; sys.path.insert(0, sys.argv[1]); import hum_to_abc as h",
      "q = h.quantise([(1.30, 1.58, 64), (1.61, 1.90, 67), (2.30, 2.60, 69)], 120)",
      "print(q)",
    ].join("\n"), here], { encoding: "utf8" });
    // 120 bpm → a unit is 1/16 s. The lead-in (1.30 s) goes; the 0.03 s gap
    // (a one-unit hole) closes into the E; the 0.40 s gap stays a rest.
    ok("a one-unit gap closes, a real rest stays, and the lead-in silence is trimmed",
      rests.status === 0 && rests.stdout.trim() === "[[0, 5, 64], [5, 5, 67], [16, 5, 69]]", (rests.stdout || rests.stderr).trim());
    const hum = src("./hum_to_abc.py");
    /* The gate at segment level, numpy only: two ~0.9 s notes at probability
     * 0.3 (a breathy hum) are kept whatever an absolute threshold would say,
     * and a 93 ms blip at 0.05 between them is dropped. */
    const seg = spawnSync(python, ["-c", [
      "import sys; sys.path.insert(0, sys.argv[1]); import numpy as np, hum_to_abc as h",
      "midi = np.array([60.0] * 40 + [59.0] * 4 + [62.0] * 40); prob = np.array([0.3] * 40 + [0.05] * 4 + [0.3] * 40)",
      "print([n[2] for n in h.segment(midi, np.ones(84, dtype=bool), 512, 22050, prob=prob)])",
    ].join("\n"), here], { encoding: "utf8" });
    ok("long low-probability notes stay, a short blip far below the recording's median goes",
      seg.status === 0 && seg.stdout.trim() === "[60, 62]", (seg.stdout || seg.stderr).trim());
    ok("the gate is short-runs-only and relative to the recording (no absolute 0.5)",
      /n\[1\] - n\[0\] < short and float\(np\.median\(n\[4\]\)\) < rel \* ref/.test(hum) && !/min_prob/.test(hum));
    /* Not a coarser pitch grid: resolution=0.25 read the same synthetic hum
     * but cut the voiced time of a real vocal stem by a third and of a full
     * mix by 70% (module docstring, SPEED). */
    ok("pYIN runs at hop 512 on its default pitch grid", /def track\(y, sr, hop=512\):/.test(hum) && /hop_length=hop\)/.test(hum) && !/resolution=/.test(hum));
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
  ok("/api/hum exists and answers the tracker's refusals with its status and their setup fields",
    /p === "\/api\/hum" && req\.method === "POST"/.test(index)
    && /return json\(res, e\?\.status \|\| 400, \{ error: e\?\.message \|\| String\(e\), \.\.\.refusalFields\(e\) \}\);/.test(index));
  ok("...and caps the recording's body before it is parsed",
    /b = await readBody\(req, 72 \* 1024 \* 1024\)/.test(index) && /if \(err\.tooBig\) return json\(res, 413,/.test(index));
  ok("hum_to_score exists, takes source or a flat library_file, and forwards every declared parameter",
    /name: "hum_to_score",/.test(mcp) && /library_file: \{ type: "string"/.test(mcp)
    && /\{ source: a\.source \?\? \(a\.library_file \? \{ library_file: safeName\(a\.library_file, "song"\) \} : undefined\), bpm: a\.bpm, key: a\.key \}/.test(mcp)
    && /Give source \{path \| library_file \| data_url\}, or library_file\./.test(mcp));
  ok("make_song declares abc_open and forwards it", /abc_open: \{ type: "boolean"/.test(mcp) && /abcOpen: a\.abc_open === true \? true : undefined,/.test(mcp));
  ok("the chat router lists the tool as free", /hum_to_score: null,/.test(router));
  ok("the page has the record, stop, file and open-score controls under Melody & score",
    /id="humRec"/.test(html) && /id="humStop" hidden/.test(html) && /id="humFile" accept="audio\/\*" hidden/.test(html) && /id="yAbcOpen"/.test(html)
    && /id="yMusicPlan">\s*<summary>Melody &amp; score<\/summary>/.test(html) && !/Advanced Options/.test(html));
  ok("...posts the recording to /api/hum and fills the score box",
    /fetch\(song \? "\/api\/song_to_score" : "\/api\/hum", \{/.test(app) && /\$\("yAbc"\)\.value = r\.abc;/.test(app) && /\$\("yAbcUse"\)\.checked = true;/.test(app));
  ok("...and sends abcOpen with the score, on the Python kit (the only build that takes it)", /if \(kit && out\.abc && \$\("yAbcOpen"\)\?\.checked\) out\.abcOpen = true;/.test(app));
  ok("the API doc describes /api/hum and abcOpen", /### `POST \/api\/hum`/.test(api) && /"abcOpen": true/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
