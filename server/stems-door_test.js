/**
 * THE STEM DOORS, THE STOP BUTTON AND THE REFUSALS THAT CARRY THEIR REMEDY.
 *
 * A user's report (2026-09-24): "Separate stems" sat at 0% for four minutes,
 * Stop did nothing, and it "immediately started again"; a missing package was
 * a sentence with no button. The process half is art.js and stems.js (lane C);
 * this lane is the DOORS, and each is the real route text sliced out of
 * index.js and run with fakes for what touches the world (the
 * cross-origin-doors_test pattern). No server, no engine, no python.
 *
 *   1. POST /api/stems run: guarded like every door that runs a program; a
 *      machine that cannot separate answers 409 with setup "stems" before
 *      anything is queued; a song already being separated is JOINED; a queue
 *      refusal is a 409, never ok:true (it used to answer ok regardless).
 *   2. POST /api/stems python: reports, and chooses only for a local page, a
 *      path on this disk that exists.
 *   3. POST /api/cancel: art.stopMine() when art.js has it, the song-to-score
 *      run beside it, and the old hand-drop until it does.
 *   4. refusalFields / refusalStatus / stemFailure: a StemsRefusal keeps its
 *      409 and its setup id through every stem door.
 *   5. POST /api/hum refuses a foreign page with 403 and an oversized body with
 *      413, both before parsing it.
 *   6. a python that died on a missing module becomes the engine-package
 *      refusal: the spawned engines, clip posters, and the warm image worker
 *      (a death before its handshake, and a lazy import inside a job).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ImgWorker } from "./imgworker.js";

const INDEX = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const root = await mkdtemp(path.join(tmpdir(), "aiplay-stems-door-"));
test.after(() => rm(root, { recursive: true, force: true }));

function between(open, endMarker, { through = false } = {}) {
  const at = INDEX.indexOf(open);
  assert.ok(at >= 0, `index.js has ${open}`);
  const end = INDEX.indexOf(endMarker, at + open.length);
  assert.ok(end > at, `index.js has ${endMarker} after ${open}`);
  return INDEX.slice(at + open.length, through ? end + endMarker.length : end);
}
const fnSource = (head) => {
  const at = INDEX.indexOf(head);
  assert.ok(at >= 0, `index.js has ${head}`);
  return INDEX.slice(at, INDEX.indexOf("\n}\n", at) + 2);
};

const config = { uiPort: 4173, systemPython: path.join(root, "python.exe"), stems: { when: "off", model: "htdemucs_ft", systemPython: null } };
const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(INDEX)?.[0] || "";
const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)(config);
const helpers = new Function(`${fnSource("function refusalFields(e) {")}\n${fnSource("function refusalStatus(e, fallback) {")}\n`
  + `${fnSource("function stemFailure(e, stem, extra = {}) {")}\nconst REFUSAL_KEYS = ${/const REFUSAL_KEYS = (\[[^\]]*\]);/.exec(INDEX)[1]};\n`
  + "return { refusalFields, refusalStatus, stemFailure };")();
const { refusalFields, refusalStatus, stemFailure } = helpers;
const json = (_res, code, body) => ({ code, body });

const HOST = `127.0.0.1:${config.uiPort}`;
const PAGE = { headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" } };
const FOREIGN = { headers: { host: HOST, origin: "https://evil.example", "content-type": "text/plain" } };

/* ── 1 · /api/stems run ─────────────────────────────────────────────── */
const STEMS_BODY = between('if (p === "/api/stems" && req.method === "POST") {', "\n    }\n\n    /** Video clips");
const stemsDoor = new AsyncFunction("req", "res", "json", "readBody", "config", "savePrefs", "answerStemsPython",
  "sameOriginLocalJson", "stemsReady", "art", "library", "prov", `${STEMS_BODY}\nreturn { fellThrough: true };`);
function fakeArt({ running = null, take = true } = {}) {
  const requested = [];
  return {
    requested, lastRefusal: null,
    findJob: (file, kind) => (running && running.file === file && kind === "stems" ? running : null),
    request(job) { requested.push(job); if (!take) { this.lastRefusal = "the queue is paused"; return null; } return { id: "j1", ...job }; },
    status: () => ({ art: { queued: requested.length } }),
  };
}
const run = (req, { art = fakeArt(), pre = { ok: true, python: config.systemPython } } = {}) => {
  let preflights = 0;
  return stemsDoor(req, null, json, async () => ({ action: "run", file: "aiplay_00001.flac" }), config, async () => {},
    async () => ({ code: 200 }), sameOriginLocalJson, async () => { preflights++; return pre; }, art,
    { meta: new Map([["aiplay_00001.flac", { title: "One" }]]) }, { actorFrom: () => "agent:test" })
    .then((r) => ({ ...r, preflights, art }));
};

test("/api/stems run: a foreign request is refused before any python is probed", async () => {
  const r = await run(FOREIGN);
  assert.equal(r.code, 403);
  assert.equal(r.preflights, 0);
  assert.equal(r.art.requested.length, 0);
});

test("/api/stems run: no demucs here is a 409 with the setup id, and nothing is queued", async () => {
  const pre = { ok: false, status: 409, error: `Stem separation needs a Python with demucs. None was found at ${config.systemPython}.`,
    python: config.systemPython, missing: ["demucs", "torch"], reason: "stems-python-missing", setup: "stems" };
  const r = await run(PAGE, { pre });
  assert.equal(r.code, 409);
  assert.equal(r.body.setup, "stems");
  assert.equal(r.body.reason, "stems-python-missing");
  assert.equal(r.body.python, config.systemPython);
  assert.match(r.body.error, /^Stem separation needs a Python with demucs\./);
  assert.equal(r.art.requested.length, 0, "a separation that could only fail is not queued");
  const env = await run(PAGE, { pre: { ...pre, setup: undefined, reason: "stems-demucs-missing", pip: `"${config.systemPython}" -m pip install demucs` } });
  assert.equal(env.body.setup, undefined, "no setup id when AIPLAY_SYS_PYTHON names the python");
  assert.match(env.body.pip, /-m pip install demucs$/);
});

test("/api/stems run: a song already being separated is joined, not queued twice", async () => {
  const r = await run(PAGE, { art: fakeArt({ running: { id: "running1", file: "aiplay_00001.flac", kind: "stems" } }) });
  assert.equal(r.code, 200);
  assert.equal(r.body.joined, true);
  assert.equal(r.body.jobId, "running1");
  assert.equal(r.art.requested.length, 0);
});

test("/api/stems run: queued answers the job id; a queue refusal is a 409, never ok", async () => {
  const ok = await run(PAGE);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.jobId, "j1");
  assert.equal(ok.art.requested[0].kind, "stems");
  assert.equal(ok.art.requested[0].actor, "agent:test", "who asked is recorded");
  const no = await run(PAGE, { art: fakeArt({ take: false }) });
  assert.equal(no.code, 409);
  assert.equal(no.body.ok, undefined);
  assert.equal(no.body.reason, "refused");
  assert.equal(no.body.error, "the queue is paused");
});

/* ── 2 · /api/stems python ──────────────────────────────────────────── */
const answerStemsPython = new Function("json", "sameOriginLocalJson", "path", "stat", "defaultStemsPython", "chooseStemsPython", "stemsVerdict",
  `${fnSource("async function answerStemsPython(req, res, b) {")}\nreturn answerStemsPython;`);

test("/api/stems python reports openly and chooses only a local page's real, local file", async () => {
  const chosen = [];
  const door = answerStemsPython(json, sameOriginLocalJson, path, stat, () => "C:\\default\\python.exe",
    async (v) => { chosen.push(v); }, async () => ({ python: "p", ready: false }));
  const py = path.join(root, "py.exe");
  await writeFile(py, "");
  const read = await door(FOREIGN, null, { action: "python" });
  assert.equal(read.code, 200, "reading runs nothing new, so it is open");
  assert.deepEqual(chosen, []);
  assert.equal((await door(FOREIGN, null, { action: "python", value: py })).code, 403);
  assert.equal((await door(PAGE, null, { action: "python", value: "\\\\server\\share\\python.exe" })).code, 400);
  assert.equal((await door(PAGE, null, { action: "python", value: "python.exe" })).code, 400);
  assert.match((await door(PAGE, null, { action: "python", value: path.join(root, "missing.exe") })).body.error, /There is no file at/);
  const set = await door(PAGE, null, { action: "python", value: `"${py}"` });
  assert.equal(set.code, 200);
  assert.deepEqual(chosen, [path.resolve(py)], "a quoted Copy-as-path is taken as pasted");
  await door(PAGE, null, { action: "python", value: "" });
  assert.equal(chosen[1], null, "empty goes back to the default");
});

test("the stems verdict names the python, its source and what it lacks", async () => {
  const verdict = new Function("config", "stat", "probeOne", "STEMS_MODULES", "stemsPythonSource", "defaultStemsPython",
    `${fnSource("async function stemsVerdict() {")}\nreturn stemsVerdict;`);
  const py = path.join(root, "verdict.exe");
  await writeFile(py, "");
  const cfg = { systemPython: py, stems: { systemPython: py } };
  const half = await verdict(cfg, stat, async () => ({ demucs: true }), ["demucs", "torch"], () => "saved", () => "D")();
  assert.deepEqual(half.modules, { demucs: true, torch: false });
  assert.equal(half.ready, false);
  assert.match(half.note, /lacks PyTorch/);
  assert.equal(half.chosen, py);
  const env = await verdict(cfg, stat, async () => ({ demucs: true, torch: true }), ["demucs", "torch"], () => "env", () => "D")();
  assert.equal(env.ready, true);
  assert.match(env.note, /AIPLAY_SYS_PYTHON names this python/);
  const none = await verdict({ systemPython: path.join(root, "nope.exe"), stems: {} }, stat, async () => { throw new Error("must not probe"); },
    ["demucs", "torch"], () => "default", () => "D")();
  assert.match(none.note, /There is no python at/);
});

/* ── 3 · /api/cancel ─────────────────────────────────────────────────── */
const CANCEL_BODY = between('if (p === "/api/cancel" && req.method === "POST") {', "\n    }\n\n    // Community feed");
/* The rail's Stop (?plans=1) also pauses a running workflow plan
 * (mv/routes.js pauseRunningPlans, pinned by mv/cardfit_test); the Music
 * screen's Cancel posts without it and leaves plans alone. */
const cancelSlice = new AsyncFunction("req", "res", "json", "jobs", "art", "engineDoor", "url", "mvRoutes",
  `${CANCEL_BODY}\nreturn { fellThrough: true };`);
const plansPauseCalls = [];
const fakeMvRoutes = { pauseRunningPlans: async () => { plansPauseCalls.push(1); return ["p_1"]; } };
const cancelDoor = (req, res, json_, jobs, art, engineDoor, { plans = false } = {}) =>
  cancelSlice(req, res, json_, jobs, art, engineDoor, new URL(`http://127.0.0.1/api/cancel${plans ? "?plans=1" : ""}`), fakeMvRoutes);
const fakeJobs = { cancelled: 0, async cancel() { this.cancelled++; }, snapshot: () => ({ current: null, queue: [] }) };
const fakeDoor = (running) => {
  const cancelled = [];
  return { cancelled, status: async () => ({ running }), cancelRun: async ({ runId }) => { cancelled.push(runId); return { stopped: true }; } };
};

test("/api/cancel stops the art side through art.stopMine, and the song-to-score run beside it", async () => {
  const door = fakeDoor([{ runId: "a", via: "art.cover" }, { runId: "c", via: "music.cover" }, { runId: "x", via: "chat" }]);
  const art = { stopMine: async () => ({ dropped: 2, wasRunning: "One", kind: "stems", killed: true, stopping: false, interrupted: false, engineCancelled: 0 }) };
  const r = await cancelDoor({}, null, json, fakeJobs, art, door);
  assert.equal(r.code, 200);
  assert.deepEqual(door.cancelled, ["c"], "art.* runs are stopMine's; a chat turn is nobody's to stop here");
  assert.equal(r.body.artStopped.kind, "stems");
  assert.equal(r.body.artStopped.killed, true);
  assert.equal(r.body.artStopped.engineCancelled, 1);
  assert.equal(r.body.artStopped.interrupted, true);
  assert.deepEqual(r.body.plansPaused, [], "the Music screen's Cancel leaves a running plan alone");
  assert.equal(plansPauseCalls.length, 0);
  const rail = await cancelDoor({}, null, json, fakeJobs, art, fakeDoor([]), { plans: true });
  assert.deepEqual(rail.body.plansPaused, ["p_1"], "the rail's Stop (?plans=1) pauses the plan as well");
  assert.equal(rail.body.artStopped.kind, "stems", "...and still stops the stem splitter");
});

test("/api/cancel keeps working before art.js has stopMine", async () => {
  const door = fakeDoor([{ runId: "a", via: "art.cover" }, { runId: "x", via: "chat" }]);
  const dropped = [];
  const art = { queue: [{ file: "f1" }, { file: "f1" }, { file: "f2" }], status: () => ({ art: { current: { title: "Two" } } }),
    drop: (file) => { dropped.push(file); return { removed: file === "f1" ? 2 : 1 }; } };
  const r = await cancelDoor({}, null, json, fakeJobs, art, door);
  assert.deepEqual(dropped, ["f1", "f2"]);
  assert.deepEqual(door.cancelled, ["a"]);
  assert.deepEqual({ dropped: r.body.artStopped.dropped, wasRunning: r.body.artStopped.wasRunning, engineCancelled: r.body.artStopped.engineCancelled },
    { dropped: 3, wasRunning: "Two", engineCancelled: 1 });
});

/* ── 4 · refusals through the stem doors ─────────────────────────────── */
test("a stems refusal keeps its 409 and setup id through every stem door; other failures say which stem", () => {
  const refusal = Object.assign(new Error("Stem separation needs demucs, and C:\\py.exe does not have it. Press \"Set up stem separation\"."),
    { status: 409, setup: "stems", python: "C:\\py.exe", pip: '"C:\\py.exe" -m pip install demucs', reason: "stems-demucs-missing", missing: ["demucs"] });
  const a = stemFailure(refusal, "vocals", { engine: "yue2" });
  assert.equal(a.status, 409);
  assert.equal(a.body.error, refusal.message, "the refusal's own first sentence, not 'the vocals stem could not be separated'");
  assert.equal(a.body.setup, "stems");
  assert.equal(a.body.reason, "stems-demucs-missing");
  assert.equal(a.body.engine, "yue2");
  assert.equal(a.body.missing, undefined, "only the refusal keys travel");
  const b = stemFailure(new Error("demucs stopped with exit code 1: boom"), "drums");
  assert.equal(b.status, 500);
  assert.equal(b.body.reason, "stem-failed");
  assert.match(b.body.error, /^The drums stem could not be separated: demucs stopped/);
  assert.deepEqual(refusalFields({ setup: "", pip: 3, module: "cv2" }), { module: "cv2" });
  assert.equal(refusalStatus({ status: 200 }, 400), 400);
  assert.equal(refusalStatus({ status: 409 }, 400), 409);
  for (const door of ['p === "/api/tokenize"', '(p === "/api/extend" || p === "/api/replace")', 'p === "/api/generate"']) {
    const at = INDEX.indexOf(door);
    assert.ok(at > 0 && INDEX.indexOf("stemFailure(e, ", at) > at, `${door} answers a stem failure through stemFailure`);
  }
  assert.match(INDEX, /\.\.\.\(e\?\.needsModel \? \{ needsModel: e\.needsModel \} : \{\}\), \.\.\.refusalFields\(e\) \}\);/,
    "song_to_score relays a stem refusal's setup id");
  assert.match(INDEX, /return json\(res, refusalStatus\(err, 400\), \{ error: String\(err\.message \|\| err\), \.\.\.refusalFields\(err\) \}\);/,
    "the Reactive drums door too");
});

/* ── 5 · the hum cap ─────────────────────────────────────────────────── */
test("/api/hum refuses a foreign page with 403 and an oversized recording with 413, before either is parsed", async () => {
  const HUM = between('if (p === "/api/hum" && req.method === "POST") {', "\n    }\n\n    /* /api/replace");
  const readBodySrc = /async function readBody\(req, maxBytes = 0\) \{[\s\S]*?\n\}/.exec(INDEX)[0];
  const readBody = new Function(`${readBodySrc}\nreturn readBody;`)();
  const hum = new AsyncFunction("req", "res", "json", "readBody", "transcribeHum", "refusalFields", "sameOriginLocalJson", `${HUM}\nreturn null;`);
  const from = (headers, chunks) => Object.assign(Readable.from(chunks), { headers });
  let reads = 0;
  const foreign = await hum(FOREIGN, null, json, async () => { reads++; return {}; }, async () => ({}), refusalFields, sameOriginLocalJson);
  assert.equal(foreign.code, 403, "a page elsewhere cannot have the tracker read a file on this PC");
  assert.equal(reads, 0, "...and its body is never read");
  const big = from(PAGE.headers, [Buffer.alloc(40 * 1024 * 1024, 32), Buffer.alloc(40 * 1024 * 1024, 32)]);
  let tracked = 0;
  const r = await hum(big, null, json, readBody, async () => { tracked++; return {}; }, refusalFields, sameOriginLocalJson);
  assert.equal(r.code, 413);
  assert.match(r.body.error, /too large/);
  assert.equal(tracked, 0);
  const missing = Object.assign(new Error("Hum to score needs librosa, which the engine's python cannot import (C:\\e\\python.exe)."),
    { status: 409, module: "librosa", pip: '"C:\\e\\python.exe" -m pip install librosa', python: "C:\\e\\python.exe", setup: "studio-packages", reason: "missing-module" });
  const small = from(PAGE.headers, [Buffer.from(JSON.stringify({ source: { path: "C:/h.wav" } }))]);
  const r2 = await hum(small, null, json, readBody, async () => { throw missing; }, refusalFields, sameOriginLocalJson);
  assert.equal(r2.code, 409);
  assert.equal(r2.body.setup, "studio-packages");
  assert.equal(r2.body.module, "librosa");
  assert.match(r2.body.pip, /-m pip install librosa$/);
});

/* ── 6 · a python that died on a missing module (engine-packages.js, D1) ── */
test("the image editor and clip posters turn a missing module into the engine-package refusal", async () => {
  const make = (enginePackages) => new Function("enginePackages", "config", "json",
    `${fnSource("async function moduleRefusal(stderr, feature, python = config.python) {")}\n`
    + `${fnSource("function engineClose(resolve, reject, so, se, code, tailBytes = 400) {")}\n`
    + `${fnSource("function imageFailure(res, err, status, error) {")}\n`
    + `${fnSource("async function imageRefusal(err) {")}\n`
    + `${fnSource("function refusalFields(e) {")}\n${fnSource("function refusalStatus(e, fallback) {")}\n`
    + `const REFUSAL_KEYS = ${/const REFUSAL_KEYS = (\[[^\]]*\]);/.exec(INDEX)[1]};\n`
    + "return { moduleRefusal, engineClose, imageFailure, imageRefusal };")(enginePackages, { rig: "C:\rig", python: "C:\rig\venv\Scripts\python.exe" }, json);
  const asked = [];
  const withD = make({ engineModuleRefusal: async (a) => {
    asked.push(a);
    return /No module named 'cv2'/.test(a.stderr) ? { message: `${a.feature} needs OpenCV, which the engine's python cannot import (${a.python}). …`,
      module: "cv2", package: "opencv-python-headless", pip: `"${a.python}" -m pip install opencv-python-headless`,
      python: a.python, status: 409, reason: "missing-module", setup: "studio-packages" } : null;
  } });
  const crash = "Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'cv2'\n";
  const err = await new Promise((resolve, reject) => withD.engineClose(resolve, reject, "", crash, 1)).then(() => null, (e) => e);
  assert.equal(asked[0].feature, "The image editor");
  assert.equal(asked[0].rig, "C:\rig");
  assert.equal(err.status, 409);
  assert.equal(err.setup, "studio-packages");
  const reply = withD.imageFailure(null, err, 400, `measure failed: ${err.message}`);
  assert.equal(reply.code, 409);
  assert.equal(reply.body.setup, "studio-packages");
  assert.match(reply.body.error, /^The image editor needs OpenCV/, "the refusal's own sentence, not 'measure failed: …'");
  const other = await new Promise((resolve, reject) => withD.engineClose(resolve, reject, "", "segfault\n", 1)).then(() => null, (e) => e);
  assert.equal(other.message, "segfault");
  assert.equal(withD.imageFailure(null, other, 400, "measure failed: segfault").body.error, "measure failed: segfault");
  const stdoutJson = await new Promise((resolve, reject) => withD.engineClose(resolve, reject, '{"ok":false,"error":"bad layer"}', crash, 1)).then(() => null, (e) => e);
  assert.equal(stdoutJson.message, "bad layer", "the engine's own JSON error still comes first");
  const withoutD = make({});
  const plain = await new Promise((resolve, reject) => withoutD.engineClose(resolve, reject, "", crash, 1)).then(() => null, (e) => e);
  assert.equal(plain.status, undefined, "before engine-packages.js has the helper, the old sentence stands");
  assert.match(plain.message, /No module named 'cv2'/);
  const poster = between('if (p.startsWith("/api/clipthumb/")) {', "let buf;");
  assert.match(poster, /const refusal = await moduleRefusal\(r\.se, "Clip posters", config\.python\);/);
  assert.match(poster, /if \(refusal\) return json\(res, 409, \{ error: refusal\.message, \.\.\.refusalFields\(refusal\) \}\);/);

  /* The engine's own JSON error can name the module too (a lazy scipy import). */
  const lazy = await new Promise((resolve, reject) => withD.engineClose(resolve, reject,
    JSON.stringify({ ok: false, error: "ModuleNotFoundError: No module named 'cv2'" }), "", 1)).then(() => null, (e) => e);
  assert.equal(lazy.status, 409, "an engine that answered in JSON about a missing module is a refusal too");
  assert.equal(lazy.setup, "studio-packages");

  /* THE WARM WORKER, driven for real with node standing in for python. */
  const script = path.join(root, "dead_worker.cjs");
  await writeFile(script, "process.stderr.write(\"Traceback (most recent call last):\\n  File \\\"imgworker.py\\\", line 42\\nModuleNotFoundError: No module named 'cv2'\\n\"); process.exit(1);\n");
  const dead = new ImgWorker(process.execPath, { script });
  const died = await dead.run("edit", {}).then(() => null, (e) => e);
  assert.match(died.message, /^image worker exited \(1\): ModuleNotFoundError: No module named 'cv2'$/, "the death says why");
  assert.match(died.stderr, /No module named 'cv2'/, "...and carries the stderr tail for the door");
  const fromDeath = await withD.imageRefusal(died);
  assert.equal(fromDeath.status, 409);
  assert.equal(fromDeath.setup, "studio-packages");
  const deadReply = withD.imageFailure(null, fromDeath, 400, died.message);
  assert.equal(deadReply.code, 409);
  assert.match(deadReply.body.error, /^The image editor needs OpenCV/, "not \"image worker exited (1)\"");

  const jobScript = path.join(root, "lazy_worker.cjs");
  await writeFile(jobScript, [
    "process.stdout.write(JSON.stringify({ ready: true }) + '\\n');",
    "process.stdin.on('data', (d) => { for (const line of String(d).split('\\n').filter(Boolean)) {",
    "  const { id } = JSON.parse(line);",
    "  process.stdout.write(JSON.stringify({ id, ok: false, error: \"ModuleNotFoundError: No module named 'cv2'\" }) + '\\n'); } });",
  ].join("\n"));
  const lazyWorker = new ImgWorker(process.execPath, { script: jobScript });
  try {
    const refused = await lazyWorker.run("edit", {}).then(() => null, (e) => e);
    assert.match(refused.message, /No module named 'cv2'/);
    assert.equal((await withD.imageRefusal(refused)).setup, "studio-packages", "a lazy import inside a job becomes the refusal");
    const plain = Object.assign(new Error("bad ops"), { stderr: "bad ops" });
    assert.equal(await withD.imageRefusal(plain), plain, "an error that names no module comes back as it was");
    const already = Object.assign(new Error("x"), { status: 409, setup: "stems" });
    assert.equal(await withD.imageRefusal(already), already, "a refusal is not asked twice");
  } finally { lazyWorker.stop(); }

  /* Both warm-worker doors answer through it. */
  for (const [open, end] of [['if (p === "/api/images/preview" && req.method === "POST") {', "} finally {"],
    ['if (p === "/api/images/document-paint" && req.method === "POST") {', 'if (p === "/api/images/document-edit"']]) {
    const door = between(open, end);
    assert.match(door, /return imageFailure\(res, await imageRefusal\(err\), 400, String\(err\.message \|\| err\)\);/, open);
    assert.doesNotMatch(door, /return json\(res, 400, \{ error: String\(err\.message \|\| err\) \}\);/, `${open}: no flat 400 left`);
  }
});
