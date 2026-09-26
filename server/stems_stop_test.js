/**
 * STOP THAT STOPS, ONE SEPARATION PER SONG, REAL PROGRESS — the art queue's
 * programs (stems, timed lyrics), after Tika's report of 2026-09-24:
 * "0% for four minutes, nothing in the log, Stop does nothing, and it starts
 * again".
 *
 * The real ArtRunner runs a FAKE python: a Node script that answers the way
 * demucs does (a "bag of 4 models" line on stdout, a download line and tqdm
 * bars redrawn with carriage returns on stderr), starts a grandchild of its
 * own, and then sleeps, finishes, or fails on request. So nothing here needs
 * Python, a GPU or ComfyUI (the engine is "not ready" throughout, which is
 * itself one of the checks):
 *
 *   §1 the preflight: a missing python refused in under a second with the
 *      setup id; demucs / torch missing; AIPLAY_SYS_PYTHON; the cache; a
 *      python that did not answer; demucs 4.1 with no ffmpeg
 *   §2 ensureStem: refused before queueing, and it JOINS a running separation
 *   §3 progress and notes from demucs's own bars; the start is logged
 *   §4 Stop kills the whole tree within 2 s; the job reads "stopped", the
 *      joined waiter ends at once, nothing is queued again, lastError is kept
 *   §5 a second separation of the same song is refused, even with force
 *   §6 stopMine(): the queue dropped (and announced), the running one killed;
 *      §6b stopAll() kills a running program too
 *   §7 a finished separation; each failure's own sentence; a card its
 *      PyTorch cannot run moves the work to the processor, in THAT python
 *      only; the setup's saved device likewise
 *   §8 the same Stop for timed lyrics
 *   §9 the helpers: killProcessTree moved, mesh keeps its name, the
 *      docs_test spawn literals are still there, the meter's streams
 *   §10 Stop on an engine job: only the queue's own run, by id
 *
 * The app-data folder is a temp folder and the engine door is stubbed, so
 * neither this PC's saved settings nor a ComfyUI running on it can change or
 * be changed by what this file does.
 *
 *   node server/stems_stop_test.js
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(step); }
  return false;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-stems-stop-"));
/* HERMETIC. config.js reads settings.json from the app-data folder at import,
 * and a saved stems.device, model or python there (the stems setup itself
 * writes stems.device) changed what this file saw: it failed on a PC whose
 * setup had set device "cpu" (review, 2026-09-24). So the app-data folder is
 * this temp folder, the variable that names the python is unset, and every
 * stems setting the runner reads is pinned below. */
process.env.AIPLAY_APPDATA = tmp;
delete process.env.AIPLAY_SYS_PYTHON;
/* Everything the runner writes goes here: set BEFORE art.js is imported,
 * because its folders (covers, lyrics, clips) are fixed at import. */
const { config } = await import("./config.js");
config.outputDir = tmp;
config.paths.appData = tmp;
Object.assign(config.stems, { model: "htdemucs_ft", twoStems: false, device: null, devicePython: null, systemPython: null });
config.systemPython = path.join(tmp, "stems-python", "python.exe");
/* The engine door, stubbed: nothing here may reach a ComfyUI that happens to
 * be running on this PC (stopMine asks the door what is running; stopAll and
 * an engine job's Stop would interrupt it). */
const { engine } = await import("./engine/client.js");
const door = { running: [], cancelled: [], interrupts: 0, cleared: 0, answer: () => true };
engine.status = async () => ({ running: door.running.slice() });
engine.cancelRun = async ({ runId }) => { door.cancelled.push(runId); return { stopped: door.answer(runId) }; };
engine.interrupt = async () => { door.interrupts++; return { stopped: true }; };
engine.clearQueue = async () => { door.cleared++; return { dropped: 0 }; };
const art = await import("./art.js");
const stems = await import("./music/stems.js");
const { ArtRunner, STOPPED_ERROR, SUBPROCESS_KINDS } = art;
const { stemsPreflight, clearStemsPreflight, ensureStem, StemsRefusal, demucsMeter } = stems;

/* ── the fake python ───────────────────────────────────────────────────── */
const FAKE = path.join(tmp, "fake-python.mjs");
writeFileSync(FAKE, `import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(3);                   // [node, fake, python, ...args]
const mode = process.env.FAKE_MODE || "slow";
const pidFile = process.env.FAKE_PID_FILE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A grandchild, as demucs's workers or whisper's would be: Stop must reach it too. */
const grand = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
if (pidFile) writeFileSync(pidFile, JSON.stringify({ child: process.pid, grand: grand.pid }));
const isLrc = /lrc\\.py$/.test(args[0] || "");
const cpu = args.includes("-d") && args[args.indexOf("-d") + 1] === "cpu";
if (isLrc) {
  process.stderr.write("[lrc] device=cuda compute=int8_float16\\n");
  await sleep(120000);
  process.exit(0);
}
if (mode === "nomodule") { process.stderr.write("Traceback (most recent call last):\\nModuleNotFoundError: No module named 'demucs'\\n"); grand.kill(); process.exit(1); }
if (mode === "exit3") { process.stderr.write("RuntimeError: the audio file could not be read\\n"); grand.kill(); process.exit(3); }
if (mode === "noffmpeg") { process.stderr.write("Traceback (most recent call last):\\nRuntimeError: Saving as .flac requires ffmpeg to be installed.\\n"); grand.kill(); process.exit(1); }
if (mode === "cuda" && !cpu) {
  process.stderr.write("UserWarning: NVIDIA GeForce RTX 5050 with CUDA capability sm_120 is not compatible with the current PyTorch installation.\\n");
  process.stderr.write("RuntimeError: CUDA error: no kernel image is available for execution on the device\\n");
  grand.kill(); process.exit(1);
}
console.log("Selected model is a bag of 4 models. You will see that many progress bars per track.");
process.stderr.write('Downloading: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th" to hub\\\\checkpoints\\\\f7e0c4bc-ba3fe64a.th\\n');
process.stderr.write("\\r 50%|█████     | 40.1M/80.2M [00:01<00:01, 30.0MB/s]");
process.stderr.write("\\r100%|██████████| 80.2M/80.2M [00:02<00:00, 30.0MB/s]\\n");
await sleep(150);   // a download takes a while: long enough for the row to show it
const bar = (p) => "\\r" + String(p).padStart(3) + "%|" + "█".repeat(p / 10) + " ".repeat(10 - p / 10) + "| " + (58.5 * p / 100).toFixed(2) + "/58.5 [00:01<00:01, 20.0seconds/s]";
for (const p of [0, 50, 100]) { process.stderr.write(bar(p)); await sleep(20); }
process.stderr.write("\\n");
for (const p of [0, 20]) { process.stderr.write(bar(p)); await sleep(20); }   // model 2 at 20% (split mid-line below)
process.stderr.write("\\r 2"); await sleep(20); process.stderr.write("5%|██▌       | 14.62/58.5 [00:01<00:03, 20.0seconds/s]");
if (mode === "slow") { await sleep(120000); process.exit(0); }
for (const p of [50, 100]) { process.stderr.write(bar(p)); await sleep(10); }
for (let b = 0; b < 2; b++) for (const p of [0, 100]) { process.stderr.write(bar(p)); await sleep(10); }
const out = args[args.indexOf("-o") + 1], model = args[args.indexOf("-n") + 1];
const stem = path.basename(args[args.length - 1]).replace(/\\.(flac|mp3|opus|wav)$/i, "");
const dir = path.join(out, model, stem);
mkdirSync(dir, { recursive: true });
for (const s of ["vocals", "drums", "bass", "other"]) writeFileSync(path.join(dir, s + ".flac"), "x");
grand.kill();
process.exit(0);
`);

const mode = { current: "slow" };
const pidFile = path.join(tmp, "pids.json");
const readPids = () => { try { return JSON.parse(readFileSync(pidFile, "utf8")); } catch { return null; } };
const spawnPython = (py, args, opts) => spawn(process.execPath, [FAKE, py, ...args],
  { ...opts, env: { ...process.env, ...(opts?.env || {}), FAKE_MODE: mode.current, FAKE_PID_FILE: pidFile } });

/* The engine is NOT ready for the whole file: stems and timed lyrics must
 * start without it. Music is idle. */
const comfy = { ready: false };
const jobsIdle = { current: null, queue: [] };
const runner = new ArtRunner(comfy, jobsIdle, { spawnPython });
const events = [];
for (const ev of ["failed", "stems", "lrc", "update"]) runner.on(ev, (e) => { if (ev !== "update") events.push({ ev, ...e }); });
const song = (name) => { writeFileSync(path.join(tmp, name), "fake audio"); return name; };
const logged = [];
const origLog = console.log, origErr = console.error;
const capture = () => { console.log = (...a) => { logged.push(a.join(" ")); }; console.error = (...a) => { logged.push(a.join(" ")); }; };
const release = () => { console.log = origLog; console.error = origErr; };

/* ═══ §1 the preflight ═══════════════════════════════════════════════════ */
console.log("\n§1  THE PREFLIGHT");
{
  clearStemsPreflight();
  const missing = path.join(tmp, "no-such", "python.exe");
  const t0 = Date.now();
  const r = await stemsPreflight({ python: missing, source: "default" });
  const took = Date.now() - t0;
  ok("a missing python is refused in under a second, without spawning anything", r.ok === false && took < 1000, `${took} ms`);
  ok("...409, stems-python-missing, the setup id, and no pip line (there is no python to pip into)",
    r.status === 409 && r.reason === "stems-python-missing" && r.setup === "stems" && !("pip" in r) && r.python === missing, JSON.stringify(r));
  ok("...in the exact words: what is missing and where, then the button and the Settings field",
    r.error === `Stem separation needs a Python with demucs. None was found at ${missing}. Press "Set up stem separation", or name your own Python in Settings > Songs > "stem separation python".`, r.error);

  clearStemsPreflight();
  const env = await stemsPreflight({ python: missing, source: "env" });
  ok("AIPLAY_SYS_PYTHON names it: no setup id (a Python Studio builds would not be used), and it says so",
    !("setup" in env) && /AIPLAY_SYS_PYTHON names this python, so a Python Studio builds would not be used: install demucs there \(".*" -m pip install demucs\), or remove the variable and start Studio again\./.test(env.error), env.error);

  clearStemsPreflight();
  const here = process.execPath;   // any file that exists: the probe decides
  const noDemucs = await stemsPreflight({ python: here, source: "saved", probe: async () => ({ demucs: false, torch: true }) });
  ok("demucs missing: its own reason and sentence, and the pip line aimed at THAT python",
    noDemucs.reason === "stems-demucs-missing" && noDemucs.pip === `"${here}" -m pip install demucs`
      && noDemucs.error.startsWith(`Stem separation needs demucs, and ${here} does not have it.`) && noDemucs.setup === "stems", JSON.stringify(noDemucs));
  clearStemsPreflight();
  const noTorch = await stemsPreflight({ python: here, source: "saved", probe: async () => ({ demucs: true, torch: false }) });
  ok("torch missing: its own reason and sentence", noTorch.reason === "stems-torch-missing"
    && noTorch.error.startsWith(`Stem separation needs PyTorch, and ${here} does not have it.`) && JSON.stringify(noTorch.missing) === '["torch"]', JSON.stringify(noTorch));
  const cached = await stemsPreflight({ python: here, source: "saved", probe: async () => ({ demucs: true, torch: true }) });
  ok("the answer is kept for 30 s per python, a refusal included", cached.ok === false && cached.reason === "stems-torch-missing");
  clearStemsPreflight();
  const fine = await stemsPreflight({ python: here, source: "saved", probe: async () => ({ demucs: true, torch: true }) });
  ok("...and clearStemsPreflight() asks again: both import → ok", fine.ok === true && fine.python === here, JSON.stringify(fine));
  clearStemsPreflight();

  const slow = await stemsPreflight({ python: here, source: "saved", probe: async () => ({ file: true, modules: {}, timedOut: true }) });
  ok("a python that did not answer in 10 s counts as missing (C1) but says what is known: no answer, not \"no demucs\"",
    slow.ok === false && slow.reason === "stems-demucs-missing" && slow.timedOut === true
      && slow.error.startsWith(`Stem separation needs demucs, and ${here} did not answer within 10 s, so Studio could not check for it.`), slow.error);
  const again = await stemsPreflight({ python: here, source: "saved", probe: async () => ({ demucs: true, torch: true }) });
  ok("...and that answer is kept for 5 s, not 30 (the next ask within 5 s still reads it)", again.timedOut === true);
  clearStemsPreflight();
  const v41 = (ffmpeg) => stemsPreflight({ python: here, source: "saved", ffmpeg,
    probe: async () => ({ file: true, modules: { demucs: true, torch: true }, versions: { demucs: "4.1.0" } }) });
  const noFf = await v41(() => null);
  ok("demucs 4.1 and no ffmpeg anywhere: refused BEFORE a separation runs, with its own reason and no setup id (no setup installs ffmpeg)",
    noFf.ok === false && noFf.status === 409 && noFf.reason === "stems-ffmpeg-missing" && !("setup" in noFf) && !("pip" in noFf)
      && JSON.stringify(noFf.missing) === '["ffmpeg"]'
      && noFf.error === `Stem separation needs ffmpeg, and none was found on PATH or in AIPLAY_FFMPEG. demucs 4.1.0 (in ${here}) writes its FLAC files with ffmpeg, which Studio does not install: put ffmpeg on PATH, or name it in AIPLAY_FFMPEG, then start Studio again.`, JSON.stringify(noFf));
  ok("...with ffmpeg found it is fine", (await v41(() => "C:\\ffmpeg\\bin\\ffmpeg.exe")).ok === true);
  clearStemsPreflight();
  const v40 = await stemsPreflight({ python: here, source: "saved", ffmpeg: () => null,
    probe: async () => ({ file: true, modules: { demucs: true, torch: true }, versions: { demucs: "4.0.1" } }) });
  ok("...and demucs 4.0 (which writes FLAC through torchaudio) never asks for it", v40.ok === true, JSON.stringify(v40));
  clearStemsPreflight();
  const { findFfmpeg, demucsEnv } = stems;
  const ffDir = path.join(tmp, "ff", "bin");
  mkdirSync(ffDir, { recursive: true });
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  writeFileSync(path.join(ffDir, exe), "");
  ok("findFfmpeg: on PATH (as Windows spells the key), in AIPLAY_FFMPEG, or nowhere",
    findFfmpeg({ env: { Path: `${path.join(tmp, "nothing")}${path.delimiter}${ffDir}` } }) === path.join(ffDir, exe)
      && findFfmpeg({ env: { PATH: "", AIPLAY_FFMPEG: path.join(ffDir, exe) } }) === path.join(ffDir, exe)
      && findFfmpeg({ env: { PATH: path.join(tmp, "nothing") } }) === null);
  const denv = demucsEnv({ env: { Path: "X", AIPLAY_FFMPEG: path.join(ffDir, exe) } });
  ok("demucsEnv puts AIPLAY_FFMPEG's folder first on demucs's PATH, under the key the environment already uses",
    denv?.Path === `${ffDir}${path.delimiter}X` && !("PATH" in denv) && demucsEnv({ env: { Path: "X" } }) === null, JSON.stringify(denv));
}

/* ═══ §2 ensureStem refuses before queueing ═══════════════════════════════ */
console.log("\n§2  ENSURESTEM: REFUSED BEFORE QUEUEING");
{
  const asked = [];
  const fakeArt = { request: (j) => { asked.push(j); return null; }, on() {}, off() {} };
  const no = await stemsPreflight({ python: path.join(tmp, "absent", "python.exe"), source: "default" });
  const e = await ensureStem("x.flac", "vocals", { art: fakeArt, outputDir: tmp, preflight: async () => no }).then(() => null, (err) => err);
  ok("a stems python that cannot run demucs throws a StemsRefusal and queues nothing",
    e instanceof StemsRefusal && asked.length === 0 && e.status === 409 && e.setup === "stems" && e.reason === "stems-python-missing"
      && /None was found at/.test(e.message), e && JSON.stringify({ msg: e.message, status: e.status, setup: e.setup }));
  clearStemsPreflight();
}

/* ═══ §3 progress, notes, and the start line ══════════════════════════════ */
console.log("\n§3  PROGRESS FROM DEMUCS'S OWN BARS");
const notes = new Set();
runner.on("update", () => { const c = runner.status().art.current; if (c?.note) notes.add(c.note); });
let joined = null;
{
  capture();
  mode.current = "slow";
  const job = runner.request({ file: song("song.flac"), title: "My Song", kind: "stems", force: true });
  ok("a stems job is queued", !!job && job.kind === "stems");
  const started = await until(() => runner.current === job && readPids());
  const moved = await until(() => runner.status().art.current?.progress > 0.3);
  release();
  const cur = runner.status().art.current;
  ok("it starts while the engine is not ready (stems never wait for ComfyUI)", started && comfy.ready === false);
  ok("progress moves: model 2 of 4 at 25% is ((2-1)+0.25)/4", moved && Math.abs(cur.progress - 0.3125) < 1e-9, JSON.stringify(cur));
  ok("...and the row says which model it is on", cur.note === "model 2 of 4", cur.note);
  ok("the first-run download was said as its own note, with the size from the catalogue",
    notes.has("fetching the separation model, 336 MB, first run only"), JSON.stringify([...notes]));
  ok("the start is logged with the interpreter and the model",
    logged.some((l) => l === `  [stems] separating My Song with ${config.systemPython} (htdemucs_ft)`), logged.join(" | "));
  ok("status: stopping is false and the engine is not reported as what it waits for",
    cur.stopping === false && runner.status().art.deferred === null);

  /* §5 in passing: while it runs, a second request for the same song. */
  const again = runner.request({ file: "song.flac", title: "My Song", kind: "stems", force: true });
  ok("§5 a second separation of the same song is refused even with force, and names the running job",
    again === null && runner.lastRefusal === "My Song is already being separated" && runner.lastRefusalJob === job
      && runner.queue.length === 0, runner.lastRefusal);
  ok("§5 ...findJob(file, \"stems\") finds the running one", runner.findJob("song.flac", "stems") === job && runner.findJob("song.flac", "cover") === null);
  /* A door that needs the vocal stem while it runs JOINS it. */
  joined = ensureStem("song.flac", "vocals", { art: runner, outputDir: tmp, preflight: async () => ({ ok: true }) }).then(() => null, (err) => err);
  await sleep(50);
  ok("§2 ensureStem joins the running separation instead of queueing another", runner.queue.length === 0 && runner.current === job);
}

/* ═══ §4 Stop ═════════════════════════════════════════════════════════════ */
console.log("\n§4  STOP STOPS THE PROGRAM, AND ITS CHILDREN");
{
  const pids = readPids();
  ok("the fake demucs and its grandchild are both running", !!pids && alive(pids.child) && alive(pids.grand), JSON.stringify(pids));
  runner.lastError = "an earlier failure, kept";
  capture();
  const t0 = Date.now();
  const r = await runner.stopCurrent();
  const took = Date.now() - t0;
  const gone = await until(() => !alive(pids.child) && !alive(pids.grand), 2000 - Math.min(took, 1999));
  const left = await until(() => runner.current === null, 3000);
  release();
  ok("stopCurrent answers within 2 s with the job it stopped", took < 2000 && r.stopped === "My Song" && r.kind === "stems" && r.queued === 0, `${took} ms ${JSON.stringify(r)}`);
  ok("...killed: true, and not still stopping", r.killed === true && r.stopping === false, JSON.stringify(r));
  ok("the program AND its grandchild are gone within 2 s", gone, JSON.stringify({ child: alive(pids.child), grand: alive(pids.grand) }));
  const row = runner.status().art.recent[0];
  ok("the job reads stopped: cancelled, with the Stop sentence as its (non-null) error",
    left && row.kind === "stems" && row.cancelled === true && row.error === STOPPED_ERROR, JSON.stringify(row));
  const failed = events.filter((e) => e.ev === "failed" && e.file === "song.flac");
  ok("one \"failed\" event, carrying cancelled: true", failed.length === 1 && failed[0].cancelled === true && failed[0].error === STOPPED_ERROR, JSON.stringify(failed));
  ok("the queue's last failure is left alone (a Stop is not a failure)", runner.status().art.lastError === "an earlier failure, kept");
  runner.lastError = null;
  const e = await Promise.race([joined, sleep(3000).then(() => "still waiting")]);
  ok("the joined ensureStem ends at once, as stopped (409, stems-cancelled)",
    e instanceof Error && e.reason === "stems-cancelled" && e.cancelled === true && e.status === 409
      && e.message === "the separation of song.flac was stopped before it finished", String(e?.message || e));
  await sleep(1500);
  ok("nothing is queued again and nothing starts (1.5 s later)", runner.queue.length === 0 && runner.current === null);
  ok("a stopped job does not feed the time estimates", !runner.stats?.stems);
}

/* ═══ §6 stopMine ═════════════════════════════════════════════════════════ */
console.log("\n§6  STOPMINE: THE QUEUE, THEN THE RUNNING ONE");
{
  capture();
  mode.current = "slow";
  try { rmSync(pidFile); } catch { /* none */ }
  const a = runner.request({ file: song("a.flac"), title: "A", kind: "stems" });
  const b = runner.request({ file: song("b.flac"), title: "B", kind: "stems" });
  const running = await until(() => runner.current === a && readPids());
  const pids = readPids();
  const r = await runner.stopMine();
  const left = await until(() => runner.current === null, 3000);
  release();
  ok("with A running and B waiting", running && !!b);
  ok("stopMine drops B and kills A, and says so",
    r.dropped === 1 && r.wasRunning === "A" && r.kind === "stems" && r.killed === true && r.stopping === false
      && r.interrupted === false && r.engineCancelled === 0, JSON.stringify(r));
  ok("...the program is gone and the queue is empty", left && runner.queue.length === 0 && !alive(pids.child) && !alive(pids.grand));
  ok("...A reads stopped, and B (dropped before it ran) is marked cancelled for any waiter", runner.status().art.recent[0].cancelled === true && b.cancelled === true);
  const bEvents = events.filter((e) => e.ev === "failed" && e.file === "b.flac");
  ok("...and B is ANNOUNCED as stopped (one \"failed\" event, cancelled, the Stop sentence), so an Overnight row or a waiter on it ends at once",
    bEvents.length === 1 && bEvents[0].cancelled === true && bEvents[0].error === STOPPED_ERROR && bEvents[0].kind === "stems", JSON.stringify(bEvents));
  ok("...while B joins no history row (it never started)", !runner.status().art.recent.some((r) => r.file === "b.flac"));
  const none = await runner.stopMine();
  ok("with nothing to stop it answers, and never throws", none.dropped === 0 && none.wasRunning === null && none.killed === false, JSON.stringify(none));
  const idle = await runner.stopCurrent();
  ok("stopCurrent with nothing running: the pinned shape", JSON.stringify(idle) === JSON.stringify({ stopped: null, kind: null, queued: 0, killed: false, stopping: false }), JSON.stringify(idle));
}

/* ═══ §6b stopAll (Battery Safe, the Engine panel) reaches the program too ═══ */
console.log("\n§6b  STOPALL KILLS A RUNNING PROGRAM TOO");
{
  capture();
  mode.current = "slow";
  try { rmSync(pidFile); } catch { /* none */ }
  const c = runner.request({ file: song("c.flac"), title: "C", kind: "stems" });
  const running = await until(() => runner.current === c && readPids());
  const pids = readPids();
  const before = { interrupts: door.interrupts, cleared: door.cleared };
  const r = await runner.stopAll();
  const gone = await until(() => !alive(pids.child) && !alive(pids.grand), 2000);
  const left = await until(() => runner.current === null, 3000);
  release();
  ok("with a separation running, stopAll kills its tree (it used to interrupt only the engine, which never had it)",
    running && gone && left && runner.status().art.recent[0].cancelled === true, JSON.stringify({ gone, left }));
  ok("...and still answers in its own unchanged shape, having asked the engine too",
    JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["dropped", "engineDropped", "interrupted", "wasRunning"]) && r.wasRunning === "C"
      && door.interrupts === before.interrupts + 1 && door.cleared === before.cleared + 1, JSON.stringify(r));
}

/* ═══ §7 a finished separation, and each failure's own sentence ═══════════ */
console.log("\n§7  DONE, AND THE SENTENCES");
{
  capture();
  mode.current = "done";
  const job = runner.request({ file: song("done.flac"), title: "Done", kind: "stems" });
  const finished = await until(() => events.some((e) => e.ev === "stems" && e.file === "done.flac"), 10_000);
  release();
  const ev = events.find((e) => e.ev === "stems" && e.file === "done.flac");
  ok("a separation that finishes emits its four stems", finished && ev?.stems?.length === 4, JSON.stringify(ev));
  ok("...its row is not cancelled and has no error", runner.status().art.recent[0].cancelled === false && runner.status().art.recent[0].error === null && job.child === null);

  const failWith = async (m, file) => {
    mode.current = m;
    capture();
    runner.request({ file: song(file), title: file, kind: "stems" });
    await until(() => events.some((e) => e.ev === "failed" && e.file === file), 10_000);
    release();
    return events.find((e) => e.ev === "failed" && e.file === file);
  };
  const py = config.systemPython;
  const nm = await failWith("nomodule", "nm.flac");
  ok("No module named demucs: its own sentence, with the button and the pip line for that python",
    nm?.error === `${py} has no demucs (No module named 'demucs'). Press "Set up stem separation", or run: "${py}" -m pip install demucs`, nm?.error);
  ok("...a real failure is not \"cancelled\", and does set lastError", !nm?.cancelled && /has no demucs/.test(runner.status().art.lastError || ""));
  ok("...and the stderr tail reached the log", logged.some((l) => /\[stems\] .* exited 1; its stderr ended:/.test(l) && /No module named 'demucs'/.test(l)), logged.slice(-3).join(" | "));
  const x3 = await failWith("exit3", "x3.flac");
  ok("any other exit: the code and demucs's last line", x3?.error === "demucs stopped with exit code 3: RuntimeError: the audio file could not be read", x3?.error);
  const nf = await failWith("noffmpeg", "nf.flac");
  ok("demucs 4.1 with no ffmpeg to write FLAC: its own sentence, naming the python and both ways to name ffmpeg",
    nf?.error === `demucs separated the song but could not write its FLAC files: the demucs in ${py} writes them with ffmpeg, and none was found on PATH or in AIPLAY_FFMPEG. Put ffmpeg on PATH, or name it in AIPLAY_FFMPEG, then start Studio again.`, nf?.error);

  /* One separation to the end, and the start line it logged. */
  const startLine = async (file, title) => {
    logged.length = 0;
    capture();
    runner.request({ file: song(file), title, kind: "stems" });
    const ended = await until(() => events.some((e) => e.ev === "stems" && e.file === file), 10_000);
    release();
    return ended ? logged.find((l) => l.startsWith(`  [stems] separating ${title} with`)) || "(no start line)" : "(did not finish)";
  };
  mode.current = "cuda";
  capture();
  runner.request({ file: song("card.flac"), title: "Card", kind: "stems" });
  const done = await until(() => events.some((e) => e.ev === "stems" && e.file === "card.flac"), 10_000);
  release();
  ok("a card its PyTorch cannot run: the separation is run again on the processor, and finishes",
    done && /no kernel image is available/.test(runner.stemsOnCpu?.why || "") && runner.stemsOnCpu?.python === py, JSON.stringify(runner.stemsOnCpu));
  ok("...and says so in the log", logged.some((l) => /cannot run on the card .* separating Card on the processor instead/.test(l)));
  ok("...and on the row", notes.has("model 2 of 4 · on the processor"), JSON.stringify([...notes]));
  logged.length = 0;
  capture();
  runner.request({ file: song("card2.flac"), title: "Card 2", kind: "stems" });
  const second = await until(() => events.some((e) => e.ev === "stems" && e.file === "card2.flac"), 10_000);
  release();
  ok("...while the next separation in that python goes straight to the processor (-d cpu), with no failing first run",
    second && logged.some((l) => l === `  [stems] separating Card 2 with ${config.systemPython} (htdemucs_ft, on the processor)`)
      && !logged.some((l) => /no kernel image/.test(l)), logged.join(" | "));
  /* The finding belongs to the python it was made in, and to this epoch. */
  mode.current = "done";
  config.systemPython = path.join(tmp, "new-venv", "python.exe");
  const other = await startLine("card3.flac", "Card 3");
  ok("...but NOT in another python chosen since (the stems setup's new venv): the card again",
    other === `  [stems] separating Card 3 with ${config.systemPython} (htdemucs_ft)`, other);
  config.systemPython = py;
  const same = await startLine("card4.flac", "Card 4");
  ok("...back in the first python it still applies", same === `  [stems] separating Card 4 with ${py} (htdemucs_ft, on the processor)`, same);
  clearStemsPreflight();   // what a stems setup finishing (or Settings choosing a python) does
  const rebuilt = await startLine("card5.flac", "Card 5");
  ok("...and not once the python may have been rebuilt IN PLACE (clearStemsPreflight: a setup finished)",
    rebuilt === `  [stems] separating Card 5 with ${py} (htdemucs_ft)`, rebuilt);
  runner.stemsOnCpu = null;

  /* The setup's saved verdict, likewise: only for the python it was measured on. */
  config.stems.device = "cpu";
  config.stems.devicePython = path.join(tmp, "another", "python.exe");
  const notMine = await startLine("dev1.flac", "Dev 1");
  ok("a saved stems.device \"cpu\" measured on ANOTHER python is not applied to this one",
    notMine === `  [stems] separating Dev 1 with ${py} (htdemucs_ft)`, notMine);
  config.stems.devicePython = py;
  const mine = await startLine("dev2.flac", "Dev 2");
  ok("...while one measured on this python is (-d cpu)", mine === `  [stems] separating Dev 2 with ${py} (htdemucs_ft, on the processor)`, mine);
  config.stems.devicePython = null;
  const legacy = await startLine("dev3.flac", "Dev 3");
  ok("...and an older save that recorded no python is applied as before", legacy === `  [stems] separating Dev 3 with ${py} (htdemucs_ft, on the processor)`, legacy);
  config.stems.device = null;

  /* The real spawn, no fake: a python that is not there. */
  const plain = new ArtRunner(comfy, jobsIdle);
  const was = config.systemPython;
  config.systemPython = path.join(tmp, "gone", "python.exe");
  const got = await new Promise((resolve) => {
    plain.on("failed", (e) => resolve(e));
    capture();
    plain.request({ file: song("enoent.flac"), title: "E", kind: "stems" });
    setTimeout(() => resolve(null), 10_000);
  });
  release();
  ok("a stems python that is not there (ENOENT): its own sentence, naming the path and both fixes",
    got?.error === `The stem separation python is not at ${config.systemPython}. Set it in Settings > Songs > "stem separation python", or press "Set up stem separation".`, got?.error);
  ok("...and the 'error' path printed its tail too", logged.some((l) => /\[stems\] .*python\.exe could not start \(ENOENT\)/.test(l)), logged.slice(-3).join(" | "));
  config.systemPython = was;
}

/* ═══ §8 timed lyrics: the same Stop ══════════════════════════════════════ */
console.log("\n§8  THE SAME STOP FOR TIMED LYRICS");
{
  capture();
  try { rmSync(pidFile); } catch { /* none */ }
  const job = runner.request({ file: song("sung.flac"), title: "Sung", kind: "lrc", lyrics: "hello world\nagain", force: true });
  const running = await until(() => runner.current === job && job.child && readPids(), 10_000);
  const pids = readPids();
  const r = await runner.stopCurrent();
  const left = await until(() => runner.current === null, 3000);
  release();
  ok("a timed-lyrics job keeps its program on the job", running && !!pids);
  ok("Stop kills it and its grandchild", r.stopped === "Sung" && r.kind === "lrc" && r.killed === true && !alive(pids.child) && !alive(pids.grand), JSON.stringify(r));
  const row = runner.status().art.recent[0];
  ok("...and it reads stopped, not failed, with no CPU re-run started", left && row.kind === "lrc" && row.cancelled === true && row.error === STOPPED_ERROR, JSON.stringify(row));
  /* "whisper" is the timed-lyrics program pointed at any file (server/whisper.js). */
  ok("SUBPROCESS_KINDS names exactly the three program kinds", [...SUBPROCESS_KINDS].sort().join() === "lrc,stems,whisper");
}

/* ═══ §9 the helpers and the literals ══════════════════════════════════════ */
console.log("\n§9  THE HELPERS");
{
  const { killProcessTree } = await import("./proctree.js");
  const { killMeshProcessTree } = await import("./mesh/runner.js");
  ok("mesh/runner.js keeps killMeshProcessTree, and it IS the shared killProcessTree", killMeshProcessTree === killProcessTree);
  ok("...the taskkill /T path", /taskkill/.test(String(killProcessTree)) && /\/T/.test(String(killProcessTree)));
  ok("killProcessTree of nothing is false, not a throw", (await killProcessTree(null)) === false && (await killProcessTree({ pid: -1 })) === false);
  const src = readFileSync(path.join(HERE, "art.js"), "utf8");
  ok("docs_test's spawn literals are still in art.js", src.includes("spawn(config.systemPython") && src.includes("spawn(config.lyrics.python"));
  ok("the programs are spawned detached on POSIX (the group kill needs it)", (src.match(/detached: process\.platform !== "win32"/g) || []).length >= 2);
  const m = demucsMeter({ model: "htdemucs" });
  m.feed("\r 40%|████      | 23.40/58.5 [00:01<00:01, 20.0seconds/s]");
  ok("demucsMeter: a one-model run reads its bar directly, with no model note", Math.abs(m.progress - 0.4) < 1e-9 && m.note === null);
  const m4 = demucsMeter();
  m4.feed("Selected model is a bag of 2 models. You will see that many progress bars per track.\n");
  m4.feed("\r100%|██████████| 58.5/58.5 [00:01<00:00, 20.0seconds/s]\r  0%|          | 0/58.5 [00:00<?, ?seconds/s]\r 50%|█████     | 29.2/58.5");
  ok("...half a redrawn bar (no closing \"]\" yet) is not read, and not taken for a download", Math.abs(m4.progress - 0.5) < 1e-9 && m4.note === "model 2 of 2", `${m4.progress} ${m4.note}`);
  m4.feed(" [00:01<00:01, 20.0seconds/s]");
  ok("...the bag line on stdout sets the bar count (2 here): 1.5 of 2 bars is 75%", m4.bars === 2 && Math.abs(m4.progress - 0.75) < 1e-9, `${m4.bars} ${m4.progress}`);
  const m5 = demucsMeter();
  m5.feed("\r 2", "stderr");
  m5.feed("Selected model is a bag of 4 models. You will see that many progress bars per track.\n", "stdout");
  m5.feed("5%|██▌       | 14.62/58.5 [00:01<00:03, 20.0seconds/s]", "stderr");
  ok("...one held line PER STREAM: a stdout line landing between two halves of a stderr bar does not splice into it (25%, not 5%)",
    Math.abs(m5.progress - 0.25 / 4) < 1e-9 && m5.note === "model 1 of 4" && m5.bars === 4, `${m5.progress} ${m5.note} ${m5.bars}`);
}

/* ═══ §10 an engine job's Stop is targeted ═══════════════════════════════════ */
console.log("\n§10  STOP ON A PICTURE OR A CLIP: ONLY THE QUEUE'S OWN RUN, AND ONLY A CONFIRMED STOP MARKS IT");
{
  const clip = { id: "v1", kind: "video", file: "clip:1", title: "A long clip" };
  runner.current = clip;
  door.running = [{ runId: "r-chat", via: "chat.image" }];
  door.cancelled = [];
  const before = door.interrupts;
  const r1 = await runner.stopCurrent();
  ok("no run of the art queue's own on the engine (not submitted yet): the old interrupt, and the job is NOT marked stopping",
    door.interrupts === before + 1 && door.cancelled.length === 0 && !clip.cancelled && !clip.stopping && r1.stopping === false && r1.stopped === "A long clip",
    JSON.stringify({ r1, clip }));
  door.running = [{ runId: "r-art", via: "art.clip" }, { runId: "r-gate", via: "gate.h3" }];
  door.answer = () => false;
  const r2 = await runner.stopCurrent();
  ok("its own run is cancelled BY ID (never the gate's), and a cancel the door does not confirm marks nothing",
    JSON.stringify(door.cancelled) === '["r-art"]' && door.interrupts === before + 1 && !clip.cancelled && r2.stopping === false, JSON.stringify({ r2, cancelled: door.cancelled }));
  door.answer = () => true;
  const r3 = await runner.stopCurrent();
  ok("...a confirmed cancel marks it stopping (the row reads \"stopping…\" until its awaiter fails)",
    clip.cancelled === true && clip.stopping === true && r3.stopping === true && runner.status().art.current.stopping === true, JSON.stringify(r3));
  runner.current = null;
  door.running = [];
}

console.log("\n§11  A MINORS REFUSAL THAT MEETS A STOP IS STILL THE REFUSAL");
{
  /* The stopped branch comes before the refusal path in #drain's catch. A
   * Stop pressed as the engine door refused would otherwise list the job as
   * "stopped" with its title (the prompt's first words) kept in recent[] and
   * the log, and a waiter would hear "stopped" instead of the 422 sentence. */
  const artSrc = readFileSync(new URL("./art.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const pin = (t) => /if \(job\.cancelled && !err\?\.safety\) \{[\s\S]{0,1400}?continue;\s*\}\s*(?:\/\*[\s\S]*?\*\/\s*)?job\.cancelled = false; job\.stopping = false;\s*job\.error = String\(err\.message \|\| err\);/.test(t);
  ok("a safety refusal skips the stopped branch and takes the blanking path, its row not marked stopped", pin(artSrc));
  ok("  └ negative: fails when a Stop can swallow the refusal",
    !pin(artSrc.replace("if (job.cancelled && !err?.safety) {", "if (job.cancelled) {")));
}

rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
