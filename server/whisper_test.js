/**
 * WHISPER AS A TOOL: server/whisper.js (the /api/whisper door), the art
 * queue's "whisper" kind, server/whisper.py and the two MCP tools.
 *
 * Nothing here runs whisper, needs a GPU, a model download or ComfyUI:
 *
 *   §1 parseWhisperRequest: exactly one source, and every argument's shape
 *   §2 resolveWhisperInput: library song, clip, path; the output-folder guard
 *      (a path outside, a junction out of it, a UNC path); the vocal stem
 *   §3 the model: WHISPER_MODELS, the PREF_PATHS validator, whisperArgs
 *   §4 the door: same-origin only, a transcription queued as kind "whisper"
 *      with its LRC stem in the lyrics folder, the model saved, status, a job
 *   §5 the REAL ArtRunner with a fake python (a Node script): the job waits
 *      for music, runs without the engine, runs whisper.py in the lyrics
 *      python with the chosen model, and keeps its answer on the job
 *   §6 MCP: whisper_transcribe and whisper_status post what the door knows,
 *      and the in-app chat's decisions are on record
 *   §7 whisper.py itself, with a FAKE stable_whisper (skipped when no python
 *      runs here): the JSON, the alignment, the LRC files, the argument errors
 *
 * The app-data and output folders are a temp folder, set before config.js is
 * imported, so this PC's settings are neither read nor written.
 *
 *   node server/whisper_test.js
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra ? `\n          ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 10_000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(step); }
  return false;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-whisper-"));
process.env.AIPLAY_APPDATA = tmp;
delete process.env.AIPLAY_WHISPER_PYTHON;
delete process.env.AIPLAY_WHISPER_DEVICE;
const OUT = path.join(tmp, "output");
mkdirSync(OUT, { recursive: true });
const { config, PREF_PATHS, WHISPER_MODELS } = await import("./config.js");
config.outputDir = OUT;
config.paths.appData = tmp;
const PY_FILE = path.join(tmp, "whisper-venv", "python.exe");
mkdirSync(path.dirname(PY_FILE), { recursive: true });
writeFileSync(PY_FILE, "");
config.lyrics.whisperPython = PY_FILE;
config.lyrics.python = PY_FILE;
config.lyrics.model = "large-v3";
config.lyrics.useVocalStem = true;
config.stems.model = "htdemucs_ft";

const { engine } = await import("./engine/client.js");
engine.status = async () => ({ running: [] });
engine.cancelRun = async () => ({ stopped: false });
engine.interrupt = async () => ({ stopped: true });
engine.clearQueue = async () => ({ dropped: 0 });

const W = await import("./whisper.js");
const { parseWhisperRequest, resolveWhisperInput, insideFolder, whisperJob, jobAnswer, createWhisperRoutes, MAX_LYRICS } = W;
const { whisperArgs, WHISPER_SCRIPT, runLrc } = await import("./lrc.js");
const art = await import("./art.js");
const { ArtRunner, SUBPROCESS_KINDS, LRC_DIR, CLIP_DIR } = art;

const read = (rel) => readFileSync(path.join(HERE, "..", rel), "utf8").replace(/\r\n/g, "\n");

/* ═══ §1 the arguments ═══════════════════════════════════════════════════ */
console.log("\n§1  THE ARGUMENTS");
{
  const e = (b) => parseWhisperRequest(b).error || "";
  ok("no source is refused, naming the three", /exactly one of file .* clip .* or path/.test(e({})), e({}));
  ok("two sources are refused", !!e({ file: "a.flac", clip: "b.mp4" }));
  ok("a file name with a separator or .. is refused", !!e({ file: "../a.flac" }) && !!e({ file: "x/a.flac" }) && !!e({ clip: "a\\b.mp4" }));
  ok("a non-string source is refused", !!e({ file: 12 }));
  ok("lyrics must be text, and are capped", !!e({ file: "a.flac", lyrics: 3 }) && !!e({ file: "a.flac", lyrics: "x".repeat(MAX_LYRICS + 1) }));
  ok("a language must be a code", !!e({ file: "a.flac", language: "english" }) && !!e({ file: "a.flac", language: "e1" }));
  ok("words, writeLrc and vocals must be booleans", !!e({ file: "a.flac", words: "yes" }) && !!e({ file: "a.flac", writeLrc: 1 }) && !!e({ file: "a.flac", vocals: "on" }));
  const s = parseWhisperRequest({ file: "a.flac", lyrics: "  [Verse]\nhi  ", language: "EN", words: true, writeLrc: true }).spec;
  ok("a good request: trimmed lyrics, a lowercased language, the flags", s && s.by === "file" && s.value === "a.flac"
    && s.lyrics === "[Verse]\nhi" && s.language === "en" && s.words && s.writeLrc && s.vocals === null, JSON.stringify(s));
  const auto = parseWhisperRequest({ clip: "c.mp4", language: "auto" }).spec;
  ok("language auto and empty lyrics mean none", auto?.language === null && auto?.lyrics === null && !auto.words && !auto.writeLrc);
  ok("a three-letter code (haw, yue) is a language", parseWhisperRequest({ file: "a.flac", language: "yue" }).spec?.language === "yue");
}

/* ═══ §2 what it may read ════════════════════════════════════════════════ */
console.log("\n§2  WHAT IT MAY READ");
const dirs = { outputDir: OUT, clipDir: CLIP_DIR, stemsModel: "htdemucs_ft", useVocalStem: true };
writeFileSync(path.join(OUT, "song one.flac"), "fake");
mkdirSync(CLIP_DIR, { recursive: true });
writeFileSync(path.join(CLIP_DIR, "import_talk_x1.mp4"), "fake");
const stemDir = path.join(OUT, "stems", "htdemucs_ft", "song one");
mkdirSync(stemDir, { recursive: true });
writeFileSync(path.join(stemDir, "vocals.flac"), "fake");
const OUTSIDE = mkdtempSync(path.join(os.tmpdir(), "aiplay-whisper-outside-"));
writeFileSync(path.join(OUTSIDE, "secret.wav"), "fake");
{
  const spec = (b) => parseWhisperRequest(b).spec;
  const song = await resolveWhisperInput(spec({ file: "song one.flac" }), dirs);
  ok("a library song resolves in the output folder, with its separated vocal", song.input === path.join(OUT, "song one.flac")
    && song.vocals === path.join(stemDir, "vocals.flac") && song.lrcBase === "song one" && song.title === "Transcribe song one.flac", JSON.stringify(song));
  const noVocal = await resolveWhisperInput(spec({ file: "song one.flac", vocals: false }), dirs);
  ok("...vocals:false keeps the mix", noVocal.vocals === null);
  const settingOff = await resolveWhisperInput(spec({ file: "song one.flac" }), { ...dirs, useVocalStem: false });
  ok("...and the timed-lyrics setting off keeps the mix too", settingOff.vocals === null);
  const notSong = await resolveWhisperInput(spec({ file: "clip.mp4" }), dirs);
  ok("a video is not a library song", notSong.status === 400);
  const missing = await resolveWhisperInput(spec({ file: "nope.flac" }), dirs);
  ok("a song that is not there is a 404", missing.status === 404, JSON.stringify(missing));
  const clip = await resolveWhisperInput(spec({ clip: "import_talk_x1.mp4" }), dirs);
  ok("an imported clip resolves in the clips folder", clip.input === path.join(CLIP_DIR, "import_talk_x1.mp4") && clip.lrcBase === "import_talk_x1" && clip.vocals === null, JSON.stringify(clip));
  const byPath = await resolveWhisperInput(spec({ path: path.join(stemDir, "vocals.flac") }), dirs);
  ok("a path inside the output folder resolves, and its LRC name carries its folders",
    !byPath.error && byPath.lrcBase === "stems_htdemucs_ft_song one_vocals", JSON.stringify(byPath));
  const quoted = await resolveWhisperInput(spec({ path: `"${path.join(OUT, "song one.flac")}"` }), dirs);
  ok("...pasted with Explorer's quotes too", !quoted.error, JSON.stringify(quoted));
  const outside = await resolveWhisperInput(spec({ path: path.join(OUTSIDE, "secret.wav") }), dirs);
  ok("a path OUTSIDE the output folder is refused (403)", outside.status === 403 && /output folder/.test(outside.error), JSON.stringify(outside));
  const dotdot = await resolveWhisperInput(spec({ path: path.join(OUT, "..", path.basename(OUTSIDE), "secret.wav") }), dirs);
  ok("...and so is one that climbs out with ..", dotdot.status === 403 || dotdot.status === 404, JSON.stringify(dotdot));
  const unc = await resolveWhisperInput(spec({ path: "\\\\server\\share\\a.wav" }), dirs);
  ok("a UNC path is refused", unc.status === 400, JSON.stringify(unc));
  const rel = await resolveWhisperInput(spec({ path: "song one.flac" }), dirs);
  ok("a relative path is refused", rel.status === 400);
  const pic = await resolveWhisperInput(spec({ path: path.join(OUT, "covers", "a.png") }), dirs);
  ok("a picture is not transcribed", pic.status === 400);
  /* A junction (no admin needed on Windows) or a symlink elsewhere: inside by
   * name, outside in fact. realpath() is what the guard judges. */
  let linked = false;
  try { symlinkSync(OUTSIDE, path.join(OUT, "escape"), process.platform === "win32" ? "junction" : "dir"); linked = true; } catch { /* not allowed here */ }
  if (linked) {
    const esc = await resolveWhisperInput(spec({ path: path.join(OUT, "escape", "secret.wav") }), dirs);
    ok("a link inside the output folder that leads out of it is refused", esc.status === 403, JSON.stringify(esc));
  } else {
    console.log("  skip  no junction or symlink could be made here");
  }
  ok("insideFolder: the folder itself is not inside it; a sibling with the same prefix is not either",
    !insideFolder(OUT, OUT) && !insideFolder(OUT, `${OUT}-other${path.sep}a.wav`) && insideFolder(OUT, path.join(OUT, "a", "b.wav")));
}

/* ═══ §3 the model ═══════════════════════════════════════════════════════ */
console.log("\n§3  THE MODEL");
{
  ok("the models on offer, large-v3 first", WHISPER_MODELS[0] === "large-v3"
    && ["large-v3-turbo", "medium", "small", "base", "tiny"].every((m) => WHISPER_MODELS.includes(m)));
  const rule = PREF_PATHS.find(([g, k]) => g === "lyrics" && k === "model")?.[2];
  ok("lyrics.model is a saved preference", typeof rule === "function");
  ok("...that accepts every offered model and the default", !!rule && WHISPER_MODELS.every(rule) && rule(config.lyrics.model));
  ok("...and refuses anything else", !!rule && ![null, "", "large", "../x", "whisper-1", 3].some(rule));
  ok("whisperArgs: input first, then only the flags asked for",
    JSON.stringify(whisperArgs({ input: "a.wav" })) === '["a.wav"]'
    && JSON.stringify(whisperArgs({ input: "a.wav", lyricsFile: "l.txt", outStem: "o", language: "en", words: true, vocals: "v.flac" }))
      === '["a.wav","--lyrics","l.txt","--out","o","--language","en","--words","--vocals","v.flac"]');
  ok("the script sits beside lrc.py", path.basename(WHISPER_SCRIPT) === "whisper.py" && existsSync(WHISPER_SCRIPT));
}

/* ═══ §4 the door ════════════════════════════════════════════════════════ */
console.log("\n§4  THE DOOR");
const INDEX = read("server/index.js");
const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(INDEX)?.[0] || "";
ok("index.js's own same-origin guard is the one used", !!guardSrc);
const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)(config);
{
  ok("index.js mounts the door with that guard, the art queue, the lyrics folder and the clips folder",
    /createWhisperRoutes\(\{[\s\S]*?sameOriginLocalJson[\s\S]*?art[\s\S]*?lrcDir: LRC_DIR, clipDir: CLIP_DIR/.test(INDEX)
    && /if \(p === "\/api\/whisper"\) \{\s*\n\s*if \(await whisperRoutes\(req, res, url\)\) return;/.test(INDEX));
  const requests = [];
  const fakeArt = {
    current: null, queue: [], done: [], lastRefusal: null,
    request(o) { requests.push(o); const j = { id: `j${requests.length}`, kind: o.kind, title: o.title, file: o.file }; this.queue.push(j); return j; },
  };
  let saves = 0;
  const probes = [];
  const routes = createWhisperRoutes({
    json: (_res, code, body) => ({ code, body }), readBody: async (req) => req.body, sameOriginLocalJson, art: fakeArt, config,
    probe: async (py, mods) => { probes.push([py, mods]); return { faster_whisper: true, stable_whisper: true }; },
    modules: ["faster_whisper", "stable_whisper"], savePrefs: async () => { saves++; }, lrcDir: LRC_DIR, clipDir: CLIP_DIR,
  });
  const HOST = `127.0.0.1:${config.uiPort}`;
  const PAGE = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" };
  let answer;
  const json = (_res, code, body) => (answer = { code, body });
  const door = createWhisperRoutes({
    json, readBody: async (req) => req.body, sameOriginLocalJson, art: fakeArt, config,
    probe: async (py, mods) => { probes.push([py, mods]); return { faster_whisper: true, stable_whisper: true }; },
    modules: ["faster_whisper", "stable_whisper"], savePrefs: async () => { saves++; }, lrcDir: LRC_DIR, clipDir: CLIP_DIR,
  });
  const call = async (method, body, { headers = PAGE, query = "" } = {}) => {
    answer = null;
    const handled = await door({ method, body, headers }, null, new URL(`http://${HOST}/api/whisper${query}`));
    return handled ? answer : null;
  };
  ok("another path is not this door's", (await routes({ method: "GET", headers: PAGE }, null, new URL(`http://${HOST}/api/lyrics`))) === false);

  const evil = await call("POST", { action: "transcribe", file: "song one.flac" }, { headers: { ...PAGE, origin: "http://evil.example" } });
  ok("a POST from another origin is refused, and nothing is queued", evil.code === 403 && requests.length === 0, JSON.stringify(evil));
  const form = await call("POST", { action: "model", value: "tiny" }, { headers: { ...PAGE, "content-type": "text/plain" } });
  ok("...so is a non-JSON one, and the model is unchanged", form.code === 403 && config.lyrics.model === "large-v3" && saves === 0);

  const q = await call("POST", { action: "transcribe", file: "song one.flac", lyrics: "hello\nworld", language: "en", words: true, writeLrc: true });
  const r0 = requests[0];
  ok("a transcription is queued on the art queue as kind \"whisper\", asked for, under a pseudo-file",
    q.code === 200 && r0?.kind === "whisper" && r0.asked === true && /^whisper:[0-9a-f]{8}$/.test(r0.file) && q.body.jobId === "j1", JSON.stringify(q));
  ok("...carrying the resolved input, the vocal stem, the lyrics, language and words",
    r0.whisper.input === path.join(OUT, "song one.flac") && r0.whisper.vocals === path.join(stemDir, "vocals.flac")
      && r0.whisper.lyrics === "hello\nworld" && r0.whisper.language === "en" && r0.whisper.words === true, JSON.stringify(r0.whisper));
  ok("...and LRC files that never overwrite the song's own timed lyrics",
    r0.whisper.outStem === path.join(LRC_DIR, "song one.whisper") && q.body.lrc === "song one.whisper.lrc" && q.body.wordLrc === "song one.whisper.word.lrc");
  ok("...an MCP caller is recorded as itself", (await call("POST", { action: "transcribe", clip: "import_talk_x1.mp4" }, { headers: { ...PAGE, "x-aiplay-actor": "agent:claude-code" } })).code === 200
    && requests[1].actor === "agent:claude-code" && requests[1].whisper.outStem === null);
  const bad = await call("POST", { action: "transcribe", path: path.join(OUTSIDE, "secret.wav") });
  ok("a path outside the output folder is refused at the door, and nothing is queued", bad.code === 403 && requests.length === 2, JSON.stringify(bad));
  const noArgs = await call("POST", { action: "transcribe" });
  ok("a request with no source is a 400", noArgs.code === 400);

  config.lyrics.python = path.join(tmp, "no-such", "python.exe");
  const noPy = await call("POST", { action: "transcribe", file: "song one.flac" });
  ok("a whisper python that is not there is refused before queueing, with the setup id", noPy.code === 400
    && noPy.body.setup === "lyrics" && /Timed lyrics has no Python to run/.test(noPy.body.error) && requests.length === 2, JSON.stringify(noPy));
  const st0 = await call("GET", undefined);
  ok("...and GET says not ready, with the install lines and the setup id", st0.code === 200 && st0.body.whisper.ready === false
    && Array.isArray(st0.body.whisper.install) && st0.body.whisper.install.some((l) => /faster-whisper stable-ts/.test(l)) && st0.body.whisper.setup === "lyrics", JSON.stringify(st0.body));
  config.lyrics.python = PY_FILE;

  const st = await call("GET", undefined);
  ok("GET: the python, ready, the model and the models, the device setting, the whisper jobs",
    st.body.whisper.python === PY_FILE && st.body.whisper.ready === true && st.body.whisper.model === "large-v3"
      && JSON.stringify(st.body.whisper.models) === JSON.stringify(WHISPER_MODELS) && st.body.whisper.device === "auto"
      && st.body.whisper.jobs.length === 2 && !("install" in st.body.whisper), JSON.stringify(st.body));
  ok("...probed in THAT python for both modules", JSON.stringify(probes.at(-1)) === JSON.stringify([PY_FILE, ["faster_whisper", "stable_whisper"]]));

  const badModel = await call("POST", { action: "model", value: "large" });
  ok("a model that is not offered is refused and nothing is saved", badModel.code === 400 && config.lyrics.model === "large-v3" && saves === 0);
  const turbo = await call("POST", { action: "model", value: "large-v3-turbo" });
  ok("a model on offer is chosen at once and saved", turbo.code === 200 && config.lyrics.model === "large-v3-turbo" && saves === 1 && turbo.body.whisper.model === "large-v3-turbo");
  const readOnly = await call("POST", { action: "model" });
  ok("...and {action:\"model\"} with no value only reports", readOnly.code === 200 && saves === 1);
  config.lyrics.model = "large-v3";
  ok("an unknown action says which there are", /Unknown action\. Try: transcribe, model, status/.test((await call("POST", { action: "go" })).body.error));

  /* Where a job is, by id. */
  fakeArt.current = fakeArt.queue.shift();
  const fin = { id: "j9", kind: "whisper", title: "Transcribe x", transcript: { ok: true, text: "hi" } };
  const failed = { id: "j8", kind: "whisper", title: "Transcribe y", error: "Timed lyrics: boom" };
  const stopped = { id: "j7", kind: "whisper", title: "Transcribe z", error: "Stopped", cancelled: true };
  const notMine = { id: "j6", kind: "lrc", title: "Sung" };
  fakeArt.done.push(fin, failed, stopped, notMine);
  ok("whisperJob: running, queued with its place, done, failed, stopped, and another kind's id is missing",
    whisperJob(fakeArt, "j1").state === "running" && whisperJob(fakeArt, "j2").state === "queued" && whisperJob(fakeArt, "j2").position === 1
      && whisperJob(fakeArt, "j9").state === "done" && whisperJob(fakeArt, "j8").state === "failed" && whisperJob(fakeArt, "j7").state === "stopped"
      && whisperJob(fakeArt, "j6").state === "missing");
  const got = await call("GET", undefined, { query: "?job=j9" });
  ok("GET ?job=<id> returns the finished job's result", got.code === 200 && got.body.job.state === "done" && got.body.job.result.text === "hi", JSON.stringify(got));
  const gotFail = await call("GET", undefined, { query: "?job=j8" });
  ok("...a failed one its own error", gotFail.body.job.state === "failed" && gotFail.body.job.error === "Timed lyrics: boom" && !("result" in gotFail.body.job));
  ok("...and an id nobody knows is a 404", (await call("GET", undefined, { query: "?job=nope" })).code === 404);
  ok("jobAnswer never carries the job's internals", !("whisper" in jobAnswer("j1", whisperJob(fakeArt, "j1"))));
}

/* ═══ §5 the real queue, a fake python ═══════════════════════════════════ */
console.log("\n§5  THE ART QUEUE");
const FAKE = path.join(tmp, "fake-whisper.mjs");
writeFileSync(FAKE, `import { writeFileSync, readFileSync } from "node:fs";
const [, , , script, ...args] = process.argv;            // [node, fake, python, script, ...args]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.stderr.write("[lrc] device=cpu compute=int8\\n");
await sleep(Number(process.env.FAKE_MS || 50));
const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const lyrics = at("--lyrics") ? readFileSync(at("--lyrics"), "utf8") : null;
if (process.env.FAKE_FAIL) { console.log(JSON.stringify({ ok: false, error: "the file could not be read", needsInstall: false })); process.exit(0); }
console.log(JSON.stringify({ ok: true, script, args, lyrics, model: process.env.AIPLAY_WHISPER_MODEL,
  language: "en", text: "hello world", segments: [{ start: 1, end: 2, text: "hello world" }], device: "cpu", computeType: "int8",
  ...(at("--out") ? { lrc: at("--out").split(/[\\\\/]/).pop() + ".lrc", wordLrc: at("--out").split(/[\\\\/]/).pop() + ".word.lrc" } : {}) }));
`);
{
  ok("\"whisper\" is a program of its own (Stop kills its tree; it needs no engine)", SUBPROCESS_KINDS.has("whisper"));
  const spawned = [];
  const spawnPython = (py, argv, opts) => { spawned.push({ py, argv, env: opts.env }); return spawn(process.execPath, [FAKE, py, ...argv], opts); };
  const music = { current: { id: "song" }, queue: [] };
  const runner = new ArtRunner({ ready: false }, music, { spawnPython });
  const events = [];
  runner.on("whisper", (e) => events.push(e));
  runner.on("failed", (e) => events.push({ failed: true, ...e }));
  config.lyrics.model = "small";
  const job = runner.request({ file: "whisper:abc12345", title: "Transcribe song one.flac", kind: "whisper", asked: true,
    whisper: { input: path.join(OUT, "song one.flac"), vocals: null, lyrics: "hello\nworld", language: "en", words: true, outStem: path.join(LRC_DIR, "song one.whisper") } });
  ok("request() takes it and keeps the spec on the job", !!job && job.kind === "whisper" && job.whisper?.language === "en");
  await sleep(1600);
  ok("it waits while a song is rendering (music first)", spawned.length === 0 && runner.status().art.items.some((i) => i.id === job.id));
  music.current = null;
  const done = await until(() => events.length > 0, 15_000);
  const e = events[0] || {};
  ok("then it runs with the engine NOT ready, and says \"whisper\" with its id", done && !e.failed && e.id === job.id && e.language === "en" && e.lrc === "song one.whisper.lrc", JSON.stringify(events));
  const s = spawned[0] || {};
  ok("...in the whisper python, running whisper.py with the flags", s.py === PY_FILE && s.argv?.[0] === WHISPER_SCRIPT
    && s.argv.includes("--words") && s.argv[s.argv.indexOf("--language") + 1] === "en" && s.argv[s.argv.indexOf("--out") + 1] === path.join(LRC_DIR, "song one.whisper"), JSON.stringify(s.argv));
  ok("...with the chosen model in AIPLAY_WHISPER_MODEL", s.env?.AIPLAY_WHISPER_MODEL === "small");
  const row = runner.done.find((j) => j.id === job.id);
  ok("the whole answer is kept on the finished job, the lyrics went by file", row?.transcript?.text === "hello world"
    && row.transcript.lyrics === "hello\nworld" && row.transcript.model === "small", JSON.stringify(row?.transcript));
  const rec = runner.status().art.recent.find((r) => r.id === job.id);
  ok("status() lists it as a finished whisper row with its LRC", rec?.kind === "whisper" && !rec.error && rec.lrc === "song one.whisper.lrc", JSON.stringify(rec));
  ok("the temporary lyrics file is gone", !existsSync(s.argv[s.argv.indexOf("--lyrics") + 1] || "x"));

  process.env.FAKE_FAIL = "1";
  const quiet = console.error; console.error = () => {};
  const j2 = runner.request({ file: "whisper:def67890", title: "Transcribe clip", kind: "whisper", whisper: { input: path.join(CLIP_DIR, "import_talk_x1.mp4") } });
  await until(() => events.length > 1, 15_000);
  console.error = quiet;
  delete process.env.FAKE_FAIL;
  const f = events[1] || {};
  ok("a failure is announced with whisper.py's own sentence and kept on its row",
    f.failed && f.kind === "whisper" && /the file could not be read/.test(f.error) && runner.done.find((j) => j.id === j2.id)?.error, JSON.stringify(f));
  config.lyrics.model = "large-v3";
}

/* ═══ §6 MCP ═════════════════════════════════════════════════════════════ */
console.log("\n§6  MCP AND THE IN-APP CHAT");
{
  const { TOOLS } = await import("./mcp.js");
  const t = TOOLS.find((x) => x.name === "whisper_transcribe");
  const s = TOOLS.find((x) => x.name === "whisper_status");
  ok("whisper_transcribe and whisper_status are MCP tools", !!t && !!s);
  const src = String(t?.run || "");
  ok("whisper_transcribe posts {action:\"transcribe\"} to /api/whisper and reads the job back",
    /api\("POST", "\/api\/whisper", body\)/.test(src) && /action: "transcribe"/.test(src) && /\/api\/whisper\?job=/.test(src) && /waitForArt\(/.test(src));
  const props = t?.inputSchema?.properties || {};
  ok("...taking file, clip, path, lyrics, language, words, write_lrc, vocals, wait and job_id",
    ["file", "clip", "path", "lyrics", "language", "words", "write_lrc", "vocals", "wait", "job_id"].every((k) => k in props));
  ok("whisper_status reads GET /api/whisper and chooses with {action:\"model\"}", /api\("GET", "\/api\/whisper"\)/.test(String(s?.run))
    && /action: "model"/.test(String(s?.run)) && JSON.stringify(s?.inputSchema?.properties?.model?.enum) === JSON.stringify(WHISPER_MODELS));
  ok("the descriptions carry no em dash", !/—/.test(t?.description || "") && !/—/.test(s?.description || ""));
  const { ROUTABLE, WITHHELD, CHAT_WITHHELD_ARGS } = await import("./chat/router.js");
  ok("the chat may read whisper_status but not choose the model with it", ROUTABLE.whisper_status === null && typeof CHAT_WITHHELD_ARGS.whisper_status?.model === "string");
  ok("whisper_transcribe is withheld from the chat, with a reason", typeof WITHHELD.whisper_transcribe === "string" && !("whisper_transcribe" in ROUTABLE));
  const { CATALOG } = await import("./models.js");
  const row = CATALOG.find((c) => c.id === "lyrics");
  ok("the Models row keeps its id and says Whisper, transcription and timed lyrics, with no em dash",
    /Whisper/.test(row?.label) && /transcri/i.test(row?.label) && /timed lyrics/i.test(row?.label)
      && ![row.label, row.why, row.note].some((x) => /—/.test(x || "")), JSON.stringify({ label: row?.label, why: row?.why }));
}

/* ═══ §7 whisper.py, with a fake whisper ═════════════════════════════════ */
console.log("\n§7  whisper.py");
function findPython() {
  for (const c of [process.env.AIPLAY_TEST_PYTHON, "python", "python3"].filter(Boolean)) {
    const r = spawnSync(c, ["-c", "import sys;print(sys.executable) if sys.version_info >= (3, 8) else sys.exit(1)"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
const PY = findPython();
if (!PY) {
  console.log("  skip  no python runs here; whisper.py's own half was not exercised");
} else {
  console.log(`        python: ${PY}`);
  const FAKEPY = path.join(tmp, "fakepy");
  mkdirSync(path.join(FAKEPY, "ctranslate2"), { recursive: true });
  /* A stable_whisper that hears two segments and logs what it was asked. */
  writeFileSync(path.join(FAKEPY, "stable_whisper.py"), `
import os
class W:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end
class Seg:
    def __init__(self, text, start, end, words):
        self.text, self.start, self.end, self.words = text, start, end, words
class Res:
    def __init__(self, segments, language):
        self.segments, self.language = segments, language
class Model:
    def transcribe(self, audio, **kw):
        with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as fh:
            fh.write("transcribe %s %s\\n" % (os.path.basename(audio), sorted(kw.items())))
        return Res([Seg(" Hello world", 1.0, 2.0, [W(" Hello", 1.0, 1.4), W(" world", 1.5, 2.0)]),
                    Seg(" again", 3.0, 3.5, [W(" again", 3.0, 3.5)])], kw.get("language") or "en")
def load_faster_whisper(name, device, compute_type):
    with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as fh:
        fh.write("load %s %s %s\\n" % (name, device, compute_type))
    return Model()
`);
  writeFileSync(path.join(FAKEPY, "ctranslate2", "__init__.py"), "def get_cuda_device_count():\n    return 0\n");
  const LOG = path.join(tmp, "fake_log.txt");
  const audio = path.join(OUT, "song one.flac");
  const env = { ...process.env, PYTHONPATH: FAKEPY, PYTHONDONTWRITEBYTECODE: "1", FAKE_LOG: LOG, AIPLAY_WHISPER_MODEL: "base", PYTHONIOENCODING: "utf-8" };
  const run = async (args) => {
    writeFileSync(LOG, "");
    try { return { info: await runLrc({ python: PY, script: WHISPER_SCRIPT, args, env, log: () => {} }) }; } catch (err) { return { error: String(err.message || err) }; }
  };
  const plain = await run([audio]);
  ok("a plain transcription: language, text, segments without words, the device and the model",
    plain.info?.ok && plain.info.language === "en" && plain.info.text === "Hello world again" && plain.info.segments.length === 2
      && !("words" in plain.info.segments[0]) && plain.info.device === "cpu" && plain.info.computeType === "int8" && plain.info.model === "base"
      && plain.info.cpuReason === "no CUDA GPU was found" && !("aligned" in plain.info) && !("lrc" in plain.info), JSON.stringify(plain));
  ok("...transcribed with lrc.py's options and no language forced",
    readFileSync(LOG, "utf8").includes("[('regroup', True), ('suppress_silence', True), ('vad', True), ('verbose', None), ('word_timestamps', True)]"), readFileSync(LOG, "utf8"));
  const lyr = path.join(tmp, "known.txt");
  writeFileSync(lyr, "[Verse]\nhello world\nagain\n", "utf8");
  const outStem = path.join(tmp, "lrc", "song one.whisper");
  mkdirSync(path.dirname(outStem), { recursive: true });
  const al = await run([audio, "--lyrics", lyr, "--out", outStem, "--language", "de", "--words"]);
  ok("--language reaches whisper", readFileSync(LOG, "utf8").includes("('language', 'de')") && al.info?.language === "de", readFileSync(LOG, "utf8"));
  ok("--words puts word timing on the segments", al.info?.segments?.[0]?.words?.[1]?.text === "world" && al.info.segments[0].words[1].start === 1.5, JSON.stringify(al.info?.segments));
  ok("known lyrics: OUR words, whisper's timing, a confidence", JSON.stringify(al.info?.aligned?.lines?.map((l) => [l.start, l.text])) === '[[1,"hello world"],[3,"again"]]'
    && al.info.aligned.confidence === 1 && al.info.aligned.lines[0].words.length === 2, JSON.stringify(al.info?.aligned));
  const lineLrc = existsSync(`${outStem}.lrc`) ? readFileSync(`${outStem}.lrc`, "utf8").replace(/\r\n/g, "\n") : "";
  ok("...and the LRC pair is written from them", al.info?.lrc === "song one.whisper.lrc" && al.info.wordLrc === "song one.whisper.word.lrc"
    && lineLrc === "[00:01.00]hello world\n[00:03.00]again" && existsSync(`${outStem}.word.lrc`), lineLrc);
  const heardStem = path.join(tmp, "lrc", "heard");
  const heard = await run([audio, "--out", heardStem]);
  const heardLrc = existsSync(`${heardStem}.lrc`) ? readFileSync(`${heardStem}.lrc`, "utf8").replace(/\r\n/g, "\n") : "";
  ok("with no lyrics, the LRC is written from what was heard", heard.info?.lrc === "heard.lrc" && heardLrc === "[00:01.00]Hello world\n[00:03.00]again", heardLrc);
  const markers = path.join(tmp, "markers.txt");
  writeFileSync(markers, "[Chorus]\n(instrumental)\n", "utf8");
  const onlyMarkers = await run([audio, "--lyrics", markers]);
  ok("lyrics with only section markers: a transcript and a note, not a failure", onlyMarkers.info?.ok && /no lines to time/.test(onlyMarkers.info.alignNote || ""), JSON.stringify(onlyMarkers));
  const unknown = await run([audio, "--lyric", lyr]);
  ok("an unknown argument is an error in JSON, not a plain transcript", /unknown argument '--lyric'/.test(unknown.error || ""), JSON.stringify(unknown));
  const none = await run([path.join(OUT, "nope.flac")]);
  ok("a file that is not there is said", /there is no file at/.test(none.error || ""), JSON.stringify(none));
}

/* ═══ the hook runs this file ════════════════════════════════════════════ */
ok("the pre-commit hook runs this suite", /\nnode server\/whisper_test\.js \|\| exit 1\n/.test(read(".githooks/pre-commit")));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
