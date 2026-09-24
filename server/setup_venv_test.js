/**
 * ONE-CLICK TIMED LYRICS — server/setup/venv.js and its door, with a fake uv.
 *
 * The fake uv is a Node script that records every argv it is given (and the
 * two folders uv is pointed at), makes the venv's python file when asked for a
 * venv, and fails or dawdles on request. So the whole job runs here with no
 * network, no Python and no GPU, and what is asserted is exactly what the real
 * uv would have been told to do:
 *
 *   - the CUDA 12.6 index on an NVIDIA card, the CPU index otherwise;
 *   - the both-modules probe gates "done", and the setting is written only
 *     after it passed;
 *   - a feature that already works is a no-op; a ready venv is not rebuilt;
 *   - network shares, mapped network drives and folders Studio did not make
 *     are refused, and nothing is fetched for them;
 *   - a failure removes only the marked, half-built folder and keeps the cache;
 *   - a long job answers its request at once and reports progress;
 *   - uv's Python stays in Studio's folder: no ~/.local/bin copy, no registry entry;
 *   - AIPLAY_WHISPER_PYTHON set: refused up front (a build would not be used);
 *   - the door: who may start a job, the size cap, the words it knows;
 *   - Studio's own engine packages again (studio-packages), with a fake installer;
 *   - the MCP tools, and that the in-app chat may not start one;
 *   - every CUDA build proves the card with a real tensor op (an RTX 50 under
 *     CUDA 12.6 imports cleanly and fails on its first op);
 *   - stems (2026-09-24): CUDA 12.8 on NVIDIA when the drive has room, the CPU
 *     build otherwise, the sizes said either way, the device set to cpu when
 *     the card fails the op.
 *
 *   node server/setup_venv_test.js
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSetupRunner, lyricsRecipe, stemsRecipe, offerSentence, localDiskProblem, venvPython, RECIPE_IDS, TORCH_CHOICES, TORCH_BUILDS, probeTensor, TENSOR_CHECK_ARGS,
  smOf, buildOf, replaceWhy, probeTorchBuild, TORCH_BUILD_ARGS } from "./setup/venv.js";
import { STEMS_MODULES } from "./music/stems.js";
import { createSetupRoutes, oneRunner } from "./setup/routes.js";
import { createEnginePackagesRunner, runStudioPackages, ENGINE_SETUP_ID, venvPython as engineVenvPython } from "./setup/engine-packages.js";
import { UV_PYTHON_INSTALL_ARGS, UV_PRIVATE_ENV } from "./setup/pins.js";
import { TORCH_PIP, whisperPip } from "./lrc.js";
import { CATALOG, modulesOf } from "./models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(HERE, "..", rel), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-setup-venv-"));
const FAKE_UV = path.join(tmp, "fake-uv.mjs");
writeFileSync(FAKE_UV, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
if (process.env.FAKE_UV_LOG) appendFileSync(process.env.FAKE_UV_LOG, JSON.stringify({ argv,
  pythonDir: process.env.UV_PYTHON_INSTALL_DIR, cache: process.env.UV_CACHE_DIR,
  bin: process.env.UV_PYTHON_INSTALL_BIN, registry: process.env.UV_PYTHON_INSTALL_REGISTRY }) + "\\n");
const line = argv.join(" ");
if (process.env.FAKE_UV_SLOW && line.includes(process.env.FAKE_UV_SLOW)) await new Promise((r) => setTimeout(r, 600));
if (process.env.FAKE_UV_FAIL && line.includes(process.env.FAKE_UV_FAIL)) { console.error("error: simulated failure on " + argv.slice(0, 2).join(" ")); process.exit(2); }
if (argv[0] === "venv") {
  const dir = argv[argv.length - 1];
  for (const [d, f] of [["Scripts", "python.exe"], ["bin", "python"]]) { mkdirSync(path.join(dir, d), { recursive: true }); writeFileSync(path.join(dir, d, f), ""); }
}
console.log("fake uv did: " + line);
`);

const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
let scenario = 0;

/** A runner over a fresh app-data folder, with every outside dependency faked. */
function setup({ vendor = "nvidia", probe = () => ({ faster_whisper: true, stable_whisper: true }), current = null,
  driveType = async () => "Fixed", appData = null, quickMs = 60, blockedBy = undefined, commandTimeoutMs = undefined,
  tensor = () => ({ ok: true, cuda: true, device: "cuda", name: "Fake GPU", capability: "sm_89" }), free = 500e9,
  capability = null, torchBuild = () => null, ffmpeg = () => "C:\\ffmpeg\\bin\\ffmpeg.exe", quietSave = false } = {}) {
  scenario++;
  const dir = appData || path.join(tmp, `case${scenario}`);
  const log = path.join(tmp, `uv${scenario}.jsonl`);
  process.env.FAKE_UV_LOG = log;
  const saved = [], probed = [], tensors = [], devices = [], order = [], persisted = [];
  const runner = createSetupRunner({
    appData: dir, vendor: () => vendor,
    probe: async (py, mods) => { probed.push([py, mods]); return probe(py, mods); },
    /* By default the feature runs in whatever was last chosen, as config.lyrics.python does. */
    currentPython: () => (current ? current() : saved.at(-1)?.[1] || null),
    save: async (id, py) => { saved.push([id, py]); order.push("save"); return quietSave ? null : { note: `Timed lyrics run in ${py}, and faster-whisper and stable-ts both import there.` }; },
    getUv: async () => [process.execPath, FAKE_UV],
    driveType, quickMs, blockedBy, commandTimeoutMs,
    /* No real python here: the card test, the drive and the device setting are
     * faked too, and so are the card's generation (no nvidia-smi), the torch
     * build read for status() and the ffmpeg lookup (no machine's PATH). */
    tensorCheck: async (py) => { tensors.push(py); return tensor(py); },
    onDevice: (id, device, _t, py) => { devices.push([id, device]); order.push("device"); if (py) devices.at(-1).py = py; },
    persist: async () => { persisted.push(Date.now()); order.push("persist"); },
    freeBytes: async () => (typeof free === "function" ? free() : free),
    capability: async () => capability,
    torchBuild: async (py) => torchBuild(py),
    ffmpeg: () => ffmpeg(),
  });
  return { runner, dir, log, saved, probed, tensors, devices, order, persisted };
}
async function finished(runner, id = "lyrics") {
  for (let i = 0; i < 600; i++) {
    const job = (await runner.status(id)).setups[0].job;
    if (job && job.state !== "running") return job;
    await sleep(20);
  }
  throw new Error("the job never finished");
}

console.log("\nTHE RECIPE READS THE SAME LINES AS THE REST OF STUDIO");
{
  const nv = lyricsRecipe({ vendor: "nvidia" });
  ok("NVIDIA: lrc.js's TORCH_PIP as it stands, the CUDA 12.6 index",
    nv.torchIndex === "cu126" && nv.torch.indexUrl === "https://download.pytorch.org/whl/cu126"
      && TORCH_PIP.includes(nv.torch.indexUrl) && nv.torch.packages.join(" ") === "torch torchaudio", JSON.stringify(nv.torch));
  for (const vendor of ["amd", "intel", null]) {
    const r = lyricsRecipe({ vendor });
    ok(`${vendor || "no card read"}: the CPU index`, r.torchIndex === "cpu" && r.torch.indexUrl === "https://download.pytorch.org/whl/cpu", r.torch.indexUrl);
  }
  ok("torch: \"cpu\" chooses the CPU build on an NVIDIA card; \"cu126\" chooses CUDA without one",
    lyricsRecipe({ vendor: "nvidia", torch: "cpu" }).torchIndex === "cpu" && lyricsRecipe({ vendor: null, torch: "cu126" }).torchIndex === "cu126");
  ok("the packages are the catalogue's line (whisperPip), not a second copy",
    nv.packages.join(" ") === "faster-whisper stable-ts" && whisperPip().endsWith(nv.packages.join(" ")));
  ok("the modules are the catalogue's needsModules, the Models row's probe",
    JSON.stringify(nv.modules) === JSON.stringify(modulesOf(CATALOG.find((c) => c.id === "lyrics"))) && nv.modules.length === 2);
  ok("Python 3.12, managed by uv", nv.python === "3.12");
  ok("recipes and torch choices are the lists MCP offers", RECIPE_IDS.join() === "lyrics,stems" && TORCH_CHOICES.join() === "auto,cu126,cu128,cpu");
  const offerNv = offerSentence(nv, "C:\\Users\\Zoe\\.aiplay-studio\\venvs\\lyrics");
  ok("the offer names the build, the folder, the sizes and where the numbers come from",
    /PyTorch for your NVIDIA card \(CUDA 12\.6\)/.test(offerNv) && /About 2\.6 GB to download/.test(offerNv)
      && /the download is an estimate; 4\.9 GB on disk was measured on one NVIDIA venv/.test(offerNv)
      && /whisper model, about 3\.1 GB/.test(offerNv) && /No system Python is needed, and nothing else on this PC changes\./.test(offerNv), offerNv);
  const offerNone = offerSentence(lyricsRecipe({ vendor: null }), "X");
  ok("...and for no card read: the CPU build, why it was chosen, and that its size is an estimate",
    /CPU build of PyTorch \(because no NVIDIA card was read on this PC; timing then runs on the processor/.test(offerNone) && /estimate/.test(offerNone), offerNone);
  ok("...a CPU engine's vendor \"cpu\" reads the same, not \"the cpu card\"",
    /because no NVIDIA card was read on this PC/.test(offerSentence(lyricsRecipe({ vendor: "cpu" }), "X"))
      && !/cpu card/.test(offerSentence(lyricsRecipe({ vendor: "cpu" }), "X")));
  ok("...an AMD card is named, with why CUDA is out",
    /because this PC's card is AMD, and PyTorch's CUDA build needs NVIDIA/.test(offerSentence(lyricsRecipe({ vendor: "amd" }), "X")));
  ok("...a build the person chose says so, and a chosen CUDA build does not claim their card is NVIDIA",
    /CPU build of PyTorch \(you chose it;/.test(offerSentence(lyricsRecipe({ vendor: "nvidia", torch: "cpu" }), "X"))
      && /PyTorch's CUDA 12\.6 build \(you chose it; it needs an NVIDIA card\)/.test(offerSentence(lyricsRecipe({ vendor: null, torch: "cu126" }), "X")));
  ok("...and an interpreter it would replace is named before, not after",
    /It then becomes the timed lyrics python, in place of C:\\py\\python\.exe\./.test(offerSentence(nv, "X", { replaces: "C:\\py\\python.exe" }))
      && !/in place of/.test(offerNv));
}

console.log("\nUV'S PYTHON STAYS IN STUDIO'S FOLDER");
{
  ok("python install takes --no-bin --no-registry (uv 0.8+ writes ~/.local/bin and the Windows registry by default)",
    UV_PYTHON_INSTALL_ARGS.join(" ") === "--no-bin --no-registry");
  ok("...and every uv command runs with both switched off in its environment too",
    UV_PRIVATE_ENV.UV_PYTHON_INSTALL_BIN === "0" && UV_PRIVATE_ENV.UV_PYTHON_INSTALL_REGISTRY === "0" && UV_PRIVATE_ENV.UV_NO_CONFIG === "1");
}

console.log("\nA FULL BUILD ON AN NVIDIA CARD");
{
  const { runner, dir, log, saved } = setup();
  const root = path.join(dir, "venvs", "lyrics"), cache = path.join(dir, "venvs", "lyrics-cache");
  const py = venvPython(root);
  await runner.run("lyrics");
  const job = await finished(runner);
  const got = calls(log);
  ok("it succeeds", job.state === "done" && job.python === py, JSON.stringify(job));
  ok("uv is told: install Python 3.12, make a seeded venv, CUDA torch, then the whisper packages",
    JSON.stringify(got.map((c) => c.argv)) === JSON.stringify([
      ["python", "install", "--no-bin", "--no-registry", "3.12"],
      ["venv", "--seed", "--python", "3.12", path.join(root, "venv")],
      ["pip", "install", "--python", py, "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu126"],
      ["pip", "install", "--python", py, "faster-whisper", "stable-ts"],
    ]), JSON.stringify(got.map((c) => c.argv)));
  ok("...with Python inside the marked folder and a cache beside it",
    got.every((c) => c.pythonDir === path.join(root, "python") && c.cache === cache));
  ok("...and uv told, on every command, to put no copy in ~/.local/bin and nothing in the registry",
    got.length === 4 && got.every((c) => c.bin === "0" && c.registry === "0"), JSON.stringify(got.map((c) => [c.bin, c.registry])));
  ok("the setting is written once, with the venv's python", saved.length === 1 && saved[0][1] === py, JSON.stringify(saved));
  ok("the folder carries Studio's marker, finished", JSON.parse(readFileSync(path.join(root, ".aiplay-venv.json"), "utf8")).complete === true);
  ok("the download cache goes once the job has succeeded", !existsSync(cache));
  ok("the answer says it is set up, in the door's own verdict", /Timed lyrics are set up\. Timed lyrics run in/.test(job.message || ""), job.message);
  ok("the whole log is kept for Details", /fake uv did: pip install/.test(readFileSync(path.join(dir, "logs", "setup-lyrics.log"), "utf8")));

  const before = calls(log).length;
  const again = await runner.run("lyrics");
  ok("pressing it again with the python chosen is a no-op: nothing is run, nothing saved",
    calls(log).length === before && saved.length === 1 && (again.state === "done" || again.state === "ready"), JSON.stringify(again));
}

console.log("\nON AMD, INTEL OR NO CARD: THE CPU INDEX");
{
  const { runner, log } = setup({ vendor: "amd" });
  await runner.run("lyrics");
  const job = await finished(runner);
  const torch = calls(log).find((c) => c.argv.includes("torch"));
  ok("an AMD card gets the CPU build of torch", job.state === "done" && torch?.argv.at(-1) === "https://download.pytorch.org/whl/cpu", JSON.stringify(torch));
}

console.log("\nTHE PROBE GATES IT");
{
  const { runner, dir, log, saved } = setup({ probe: (py) => ({ faster_whisper: true, stable_whisper: false }) });
  const cache = path.join(dir, "venvs", "lyrics-cache");
  await runner.run("lyrics");
  const job = await finished(runner);
  ok("a venv where stable_whisper does not import is not done", job.state === "failed", JSON.stringify(job));
  ok("...the setting is never written", saved.length === 0);
  ok("...the sentence names what installed and what does not import, by pip name",
    /faster-whisper \(faster_whisper\) installed, but stable-ts \(stable_whisper\) does not import in/.test(job.message || ""), job.message);
  ok("...the half-built folder is removed, and the download cache kept",
    !existsSync(path.join(dir, "venvs", "lyrics")) && existsSync(cache) && /download cache .* is kept/.test(job.message || ""));
  ok("...after all four uv steps really ran", calls(log).length === 4);
}

console.log("\nALREADY WORKING: A NO-OP");
{
  const mine = process.execPath;   // any file that exists: the probe decides
  const { runner, log, saved, probed } = setup({ current: () => mine });
  const job = await runner.run("lyrics");
  ok("a python that already imports both answers at once, and says nothing was installed",
    job.state === "ready" && job.noop && /Timed lyrics work here, so nothing was installed: .* has faster-whisper and stable-ts./.test(job.message || ""), JSON.stringify(job));
  ok("...uv is never run and nothing is saved", calls(log).length === 0 && saved.length === 0);
  ok("...and the probe asked is the both-modules one", JSON.stringify(probed[0]) === JSON.stringify([mine, ["faster_whisper", "stable_whisper"]]));
}
{
  /* Studio's own venv from an earlier run is complete, but the setting was
   * cleared: it is chosen again without rebuilding. */
  const { runner, dir, log, saved } = setup();
  await runner.run("lyrics");
  await finished(runner);
  const built = calls(log).length;
  saved.length = 0;
  const job = await runner.run("lyrics");
  const done = job.state === "running" ? await finished(runner) : job;
  ok("a finished venv of Studio's own is re-chosen, not rebuilt",
    done.state === "done" && done.noop && calls(log).length === built && saved.length === 1
      && saved[0][1] === venvPython(path.join(dir, "venvs", "lyrics")), JSON.stringify(done));
}

console.log("\nWHEN A BUILD WOULD CHANGE NOTHING");
{
  const why = "AIPLAY_WHISPER_PYTHON is set, so timed lyrics run in C:\\env\\python.exe whatever Studio builds.";
  const { runner, log, saved } = setup({ blockedBy: (id) => (id === "lyrics" ? why : null) });
  const job = await runner.run("lyrics");
  ok("run() refuses with the reason, fetches nothing and saves nothing",
    job.state === "blocked" && job.message === why && calls(log).length === 0 && saved.length === 0, JSON.stringify(job));
  const st = (await runner.status("lyrics")).setups[0];
  ok("...and status says so, in place of the offer", st.blocked === why && st.offer === why);
}
{
  /* The feature runs today in a python that exists but lacks stable-ts: the
   * offer names it as the one being replaced; every build has its own offer. */
  const { runner } = setup({ current: () => process.execPath, probe: () => ({ faster_whisper: true, stable_whisper: false }) });
  const st = (await runner.status("lyrics")).setups[0];
  ok("status: not ready, and each PyTorch choice carries its own sentence, naming the python it replaces",
    st.ready === false && Object.keys(st.offers).join() === "auto,cu126,cu128,cpu"
      && /CPU build/.test(st.offers.cpu) && /CUDA 12\.6/.test(st.offers.cu126) && st.offer === st.offers.auto
      && Object.values(st.offers).every((o) => o.includes(`in place of ${process.execPath}`)), JSON.stringify(st.offers));
  ok("...and the words for each choice, with Auto's reason, come from the server",
    /^Auto: CUDA 12\.6, for an NVIDIA card \(an NVIDIA card was read on this PC\)$/.test(st.torchBuilds.auto)
      && st.torchBuilds.cpu === "the CPU build", JSON.stringify(st.torchBuilds));
}
{
  const src = read("server/setup/venv.js");
  ok("no wall-clock limit on a uv command by default (a ~2.5 GB wheel on a slow line must be allowed to finish)",
    /commandTimeoutMs = 0,/.test(src) && /commandTimeoutMs > 0 \? setTimeout/.test(src));
  const { runner } = setup({ quickMs: 20, commandTimeoutMs: 150 });
  process.env.FAKE_UV_SLOW = "torchaudio";
  await runner.run("lyrics");
  const job = await finished(runner);
  delete process.env.FAKE_UV_SLOW;
  ok("...while a limit a caller sets still stops the command, and says so", job.state === "failed" && /was stopped/.test(job.message || ""), job.message);
}

console.log("\nWHERE IT MAY BUILD");
{
  const share = setup({ appData: "\\\\fileserver\\home\\zoe\\.aiplay-studio" });
  const job = await share.runner.run("lyrics");
  const done = job.state === "running" ? await finished(share.runner) : job;
  ok("a network share is refused, before anything is fetched",
    done.state === "failed" && /network or device path/.test(done.message || "") && calls(share.log).length === 0 && share.saved.length === 0, JSON.stringify(done));
  const mapped = setup({ appData: "Z:\\aiplay", driveType: async (l) => (l === "Z" ? "Network" : "Fixed") });
  const m = await mapped.runner.run("lyrics");
  const mDone = m.state === "running" ? await finished(mapped.runner) : m;
  ok("a mapped network drive is refused too (Windows)", process.platform !== "win32"
    || (mDone.state === "failed" && /Z: is a network drive/.test(mDone.message || "") && calls(mapped.log).length === 0), JSON.stringify(mDone));
  ok("localDiskProblem passes a local folder", (await localDiskProblem("C:\\Users\\Zoe", { platform: "win32", driveType: async () => "Fixed" })) === null
    && (await localDiskProblem("//server/share", { platform: "linux" })) !== null);

  const theirs = setup();
  const root = path.join(theirs.dir, "venvs", "lyrics");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "precious.txt"), "do not delete");
  const t = await theirs.runner.run("lyrics");
  const tDone = t.state === "running" ? await finished(theirs.runner) : t;
  ok("a folder there that Studio did not make is refused and left exactly as it was",
    tDone.state === "failed" && /was not made by Studio/.test(tDone.message || "")
      && readFileSync(path.join(root, "precious.txt"), "utf8") === "do not delete" && calls(theirs.log).length === 0, JSON.stringify(tDone));
}

console.log("\nA FAILED STEP");
{
  const { runner, dir, saved } = setup();
  process.env.FAKE_UV_FAIL = "torchaudio";
  const cache = path.join(dir, "venvs", "lyrics-cache");
  await runner.run("lyrics");
  const job = await finished(runner);
  delete process.env.FAKE_UV_FAIL;
  ok("stops at the step it was on, with uv's own last line", job.state === "failed" && /stopped at "Installing PyTorch \(CUDA 12\.6\)": uv pip install exited with code 2: error: simulated failure/.test(job.message || ""), job.message);
  ok("...removes only the marked folder, keeps the cache, saves nothing",
    !existsSync(path.join(dir, "venvs", "lyrics")) && existsSync(cache) && saved.length === 0);
}

console.log("\nA LONG JOB DOES NOT HOLD ITS REQUEST");
{
  const { runner, log } = setup({ quickMs: 50 });
  process.env.FAKE_UV_SLOW = "torchaudio";
  const t0 = Date.now();
  const first = await runner.run("lyrics");
  const took = Date.now() - t0;
  ok("run() answers at once, while the job is still running", first.state === "running" && took < 500, `${first.state} after ${took} ms`);
  let seen = null;
  for (let i = 0; i < 100 && !seen; i++) {
    const j = (await runner.status("lyrics")).setups[0].job;
    if (j.step === "torch") seen = j;
    await sleep(20);
  }
  ok("status reports the step, its plain label and n of 8", !!seen && seen.label === "Installing PyTorch (CUDA 12.6)" && seen.n === 5 && seen.of === 8, JSON.stringify(seen));
  const dup = await runner.run("lyrics");
  ok("pressing it again meanwhile starts nothing new", dup.already === true && dup.state === "running");
  const done = await finished(runner);
  delete process.env.FAKE_UV_SLOW;
  ok("...and it finishes with four uv calls, not eight", done.state === "done" && calls(log).length === 4, `${done.state}, ${calls(log).length} calls`);
}

console.log("\nTHE CARD, REALLY TESTED (every CUDA build)");
{
  const { runner, dir, tensors, devices } = setup();
  await runner.run("lyrics");
  const job = await finished(runner);
  const py = venvPython(path.join(dir, "venvs", "lyrics"));
  ok("verify runs a tensor op in the new python, not only the imports", job.state === "done" && tensors.length === 1 && tensors[0] === py, JSON.stringify(tensors));
  ok("...a card that passes adds nothing to the message, and lyrics have no device setting to write",
    !/processor/.test(job.message || "") && devices.length === 0, job.message);
  ok("...and the log says it passed, with the card", job.lines.some((l) => /^> tensor check in .*: passed \(Fake GPU, sm_89\)$/.test(l)), JSON.stringify(job.lines));

  const bad = setup({ tensor: () => ({ ok: false, cuda: true, name: "NVIDIA GeForce RTX 5050", capability: "sm_120",
    error: "RuntimeError: CUDA error: no kernel image is available for execution on the device" }) });
  await bad.runner.run("lyrics");
  const b = await finished(bad.runner);
  ok("lyrics on a card its CUDA 12.6 build cannot run: still done and chosen (lrc.py falls back to the processor itself)",
    b.state === "done" && bad.saved.length === 1, JSON.stringify(b));
  ok("...and the message names the card, the failure, and the way to the card: CUDA 12.8 under PyTorch build",
    /NVIDIA GeForce RTX 5050, sm_120 could not run PyTorch's CUDA 12\.6 build \(RuntimeError: CUDA error: no kernel image/.test(b.message || "")
      && /choose CUDA 12\.8 under PyTorch build and press Set up timed lyrics again/.test(b.message || ""), b.message);

  const cpuOnly = setup({ vendor: "amd" });
  await cpuOnly.runner.run("lyrics");
  await finished(cpuOnly.runner);
  ok("a CPU build has no card to test", cpuOnly.tensors.length === 0);

  const src = Buffer.from(/b64decode\('([^']+)'\)/.exec(TENSOR_CHECK_ARGS[1])?.[1] || "", "base64").toString("utf8");
  ok("the test itself: a matrix product ON the card, synchronised, its sum checked",
    /device='cuda'/.test(src) && /x @ x/.test(src) && /torch\.cuda\.synchronize\(\)/.test(src) && /262144/.test(src), src);
  const fakeSpawn = (answer) => (_py, _args, opts) => spawn(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(answer))})`], opts);
  const failed = await probeTensor("C:\\any\\python.exe", { spawnFn: fakeSpawn({ ok: false, cuda: true, error: "no kernel image" }) });
  ok("probeTensor reads the python's answer", failed.ok === false && failed.cuda === true, JSON.stringify(failed));
  const cannot = await probeTensor(path.join(tmp, "no-python.exe"));
  ok("...and a python that cannot start is \"could not test\" (null), never a card failure", cannot.ok === null && /could not start/.test(cannot.error), JSON.stringify(cannot));
}

console.log("\nSTEM SEPARATION: THE RECIPE (the owner's rule: GPU with room, CPU otherwise, the size either way)");
{
  const roomy = stemsRecipe({ vendor: "nvidia", freeBytes: 500e9, drive: "C:" });
  ok("auto on NVIDIA with room: CUDA 12.8 (RTX 50 included), and why",
    roomy.torchIndex === "cu128" && roomy.torch.indexUrl === "https://download.pytorch.org/whl/cu128"
      && roomy.torchChosenBy === "an NVIDIA card was read on this PC, and C: has 500 GB free", JSON.stringify(roomy));
  const tight = stemsRecipe({ vendor: "nvidia", freeBytes: 4.1e9, drive: "C:" });
  ok("auto on NVIDIA with a nearly full drive: the CPU build, and the numbers that decided it",
    tight.torchIndex === "cpu" && tight.torch.indexUrl === "https://download.pytorch.org/whl/cpu"
      && tight.torchChosenBy === "an NVIDIA card was read, but C: has 4.1 GB free and the NVIDIA build needs about 7.3 GB free, counting 5 GB for the build, 336 MB of separation weights and 2 GB to spare, so the CPU build is offered", tight.torchChosenBy);
  ok("...the threshold is the build, the weights and 2 GB to spare", tight.needGb.gpu === 7.3 && tight.needGb.cpu === 3.8 && tight.freeGb === 4.1, JSON.stringify(tight.needGb));
  ok("auto with no NVIDIA card: the CPU build", stemsRecipe({ vendor: "amd", freeBytes: 500e9 }).torchIndex === "cpu"
    && stemsRecipe({ vendor: null, freeBytes: 500e9 }).torchIndex === "cpu");
  ok("free space that cannot be read does not block the GPU build, and says so",
    stemsRecipe({ vendor: "nvidia", freeBytes: null }).torchIndex === "cu128" && /could not be read/.test(stemsRecipe({ vendor: "nvidia" }).torchChosenBy));
  ok("a chosen build wins over auto", stemsRecipe({ vendor: "nvidia", freeBytes: 1e9, torch: "cu128" }).torchIndex === "cu128"
    && stemsRecipe({ vendor: "nvidia", freeBytes: 500e9, torch: "cpu" }).torchIndex === "cpu" && stemsRecipe({ vendor: "nvidia", torch: "cu126" }).torchIndex === "cu126");
  ok("packages: demucs (the catalogue), numpy and av (the audio-reference row) and safetensors (dav_encode.py)",
    roomy.packages.join() === "demucs,numpy,av,safetensors", roomy.packages.join());
  ok("modules: demucs and torch, the same list the doors' preflight asks", JSON.stringify(roomy.modules) === JSON.stringify(STEMS_MODULES) && roomy.modules.join() === "demucs,torch");
  ok("TORCH_BUILDS names the 12.8 build for RTX 50", /CUDA 12\.8, for an NVIDIA card \(RTX 50 included\)/.test(TORCH_BUILDS.cu128));

  const offer = offerSentence(roomy, "C:\\Users\\Tika\\.aiplay-studio\\venvs\\stems", { replaces: "C:\\Users\\Tika\\AppData\\Local\\Programs\\Python\\Python310\\python.exe" });
  ok("the offer names the build and WHY auto chose it, the sizes (said as estimates), the weights and what it replaces",
    /PyTorch for your NVIDIA card \(CUDA 12\.8, RTX 50 included; an NVIDIA card was read on this PC, and C: has 500 GB free\) and demucs, numpy, av and safetensors\./.test(offer)
      && /About 2\.6 GB to download and about 5 GB on disk \(estimates: a CUDA 12\.8 stem separation Python/.test(offer)
      && /the first separation then fetches the separation weights, 336 MB\./.test(offer)
      && /It then becomes the python for stem separation and the audio-reference encoder, in place of C:\\Users\\Tika\\AppData\\Local\\Programs\\Python\\Python310\\python\.exe\./.test(offer)
      && !/ffmpeg/.test(offer), offer);
  const offerTight = offerSentence(tight, "X");
  ok("...on a nearly full drive: the CPU build, its size, and the reason with the numbers and what they are made of",
    /the CPU build of PyTorch \(because an NVIDIA card was read, but C: has 4\.1 GB free and the NVIDIA build needs about 7\.3 GB free, counting 5 GB for the build, 336 MB of separation weights and 2 GB to spare, so the CPU build is offered; separation then runs on the processor, which is slower\)/.test(offerTight)
      && /About 0\.5 GB to download and about 1\.5 GB on disk/.test(offerTight) && !/free some space/.test(offerTight), offerTight);
  ok("...and when even the CPU build does not fit, it says so before anything is fetched",
    /Only 1 GB is free on C:, and this build needs about 3\.8 GB free, counting 1\.5 GB for the build, 336 MB of separation weights and 2 GB to spare: free some space first\./.test(offerSentence(stemsRecipe({ vendor: "nvidia", freeBytes: 1e9, drive: "C:" }), "X")));
  const chosen126 = offerSentence(stemsRecipe({ vendor: "nvidia", freeBytes: 500e9, torch: "cu126" }), "X");
  ok("a chosen CUDA 12.6 build names ITS OWN estimate basis, not CUDA 12.8's",
    /estimates: a CUDA 12\.6 stem separation Python has not been measured here/.test(chosen126) && !/12\.8 stem separation/.test(chosen126), chosen126);
  ok("with no ffmpeg to be found, the offer says separating needs it and that Studio does not install it",
    /Separating also needs ffmpeg, which Studio does not install and which was not found on PATH or in AIPLAY_FFMPEG/.test(offerSentence(roomy, "X", { ffmpegMissing: true }))
      && !/ffmpeg/.test(offerSentence(lyricsRecipe({ vendor: "nvidia" }), "X", { ffmpegMissing: true })));
}

console.log("\nTHE CARD'S GENERATION DECIDES THE CUDA BUILD (PyTorch's published arch lists)");
{
  ok("smOf reads every spelling of a compute capability", smOf("sm_120") === 120 && smOf([12, 0]) === 120 && smOf("8.9") === 89
    && smOf("sm_61") === 61 && smOf(null) === null && smOf("RTX") === null && smOf([12]) === null);
  const l50 = lyricsRecipe({ vendor: "nvidia", capability: [12, 0] });
  ok("timed lyrics, auto, on an RTX 50 (sm_120): CUDA 12.8 straight away, not a 2.6 GB CUDA 12.6 download it cannot run",
    l50.torchIndex === "cu128" && l50.torch.indexUrl === "https://download.pytorch.org/whl/cu128"
      && /RTX 50 or later, sm_120, which PyTorch's CUDA 12\.6 builds cannot run/.test(l50.torchChosenBy), JSON.stringify(l50.torchChosenBy));
  ok("...and its offer says why", /CUDA 12\.8, RTX 50 included; an NVIDIA card was read on this PC, and it is an RTX 50 or later/.test(offerSentence(l50, "X")));
  ok("timed lyrics on an sm_89 card, or with no capability read: CUDA 12.6 as before, and no sm in the words",
    lyricsRecipe({ vendor: "nvidia", capability: "sm_89" }).torchIndex === "cu126" && lyricsRecipe({ vendor: "nvidia" }).torchIndex === "cu126"
      && lyricsRecipe({ vendor: "nvidia", capability: "sm_89" }).torchChosenBy === "an NVIDIA card was read on this PC");
  ok("a capability on a card that is not NVIDIA changes nothing", lyricsRecipe({ vendor: "amd", capability: [12, 0] }).torchIndex === "cpu");
  const old = stemsRecipe({ vendor: "nvidia", freeBytes: 500e9, drive: "C:", capability: [6, 1] });
  ok("stems, auto, on a Pascal card (sm_61): CUDA 12.6, because the 12.8 builds dropped it, and it says so",
    old.torchIndex === "cu126" && /an older card, sm_61, which PyTorch's CUDA 12\.8 builds no longer run/.test(old.torchChosenBy)
      && /PyTorch for your NVIDIA card \(CUDA 12\.6; .*sm_61/.test(offerSentence(old, "X")), old.torchChosenBy);
  ok("stems on an RTX 50 or an sm_75 card: CUDA 12.8", stemsRecipe({ vendor: "nvidia", freeBytes: 500e9, capability: "sm_120" }).torchIndex === "cu128"
    && stemsRecipe({ vendor: "nvidia", freeBytes: 500e9, capability: "sm_75" }).torchIndex === "cu128");
  ok("the card's generation never beats a full drive: still the CPU build", stemsRecipe({ vendor: "nvidia", freeBytes: 2e9, capability: [6, 1] }).torchIndex === "cpu");
  ok("buildOf reads the build a torch version names", buildOf("2.5.1+cu121") === "cu121" && buildOf("2.7.0+cpu") === "cpu" && buildOf("2.5.1") === null);

  const rtx = setup({ capability: [12, 0] });
  await rtx.runner.run("lyrics");
  const r = await finished(rtx.runner);
  const idx = calls(rtx.log).find((c) => c.argv.includes("torch"))?.argv.at(-1);
  ok("a runner reads the card's generation (capability()) before auto decides: an RTX 50 builds timed lyrics on CUDA 12.8",
    r.state === "done" && idx === "https://download.pytorch.org/whl/cu128", String(idx));
  const st = (await rtx.runner.status("lyrics")).setups[0];
  ok("...and status' Auto words say so", /^Auto: CUDA 12\.8, for an NVIDIA card \(RTX 50 included\) \(an NVIDIA card was read on this PC, and it is an RTX 50/.test(st.torchBuilds.auto), st.torchBuilds.auto);
  let asked = 0;
  const amd = createSetupRunner({ appData: path.join(tmp, "cap-amd"), vendor: () => "amd", probe: async () => ({}),
    save: async () => null, freeBytes: async () => 500e9, capability: async () => { asked++; return [12, 0]; },
    torchBuild: async () => null, ffmpeg: () => "ffmpeg" });
  await amd.status();
  ok("...and never asks it of a card that is not NVIDIA (nvidia-smi is not run for nothing)", asked === 0);
}

console.log("\nSTEM SEPARATION: THE BUILD");
{
  const { runner, dir, log, saved, tensors, devices, order } = setup({ probe: () => ({ demucs: true, torch: true }) });
  const root = path.join(dir, "venvs", "stems");
  const py = venvPython(root);
  const first = await runner.run("stems");
  const job = first.state === "running" ? await finished(runner, "stems") : first;
  ok("it succeeds and is chosen", job.state === "done" && job.python === py && saved.length === 1 && saved[0][0] === "stems" && saved[0][1] === py, JSON.stringify(job));
  ok("uv is told: Python 3.12, a seeded venv, CUDA 12.8 torch, then demucs, numpy, av and safetensors",
    JSON.stringify(calls(log).map((c) => c.argv)) === JSON.stringify([
      ["python", "install", "--no-bin", "--no-registry", "3.12"],
      ["venv", "--seed", "--python", "3.12", path.join(root, "venv")],
      ["pip", "install", "--python", py, "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu128"],
      ["pip", "install", "--python", py, "demucs", "numpy", "av", "safetensors"],
    ]), JSON.stringify(calls(log).map((c) => c.argv)));
  ok("verify ran the tensor op in the new python, and the card passing clears the device (null)",
    tensors.length === 1 && tensors[0] === py && JSON.stringify(devices) === JSON.stringify([["stems", null]]), JSON.stringify({ tensors, devices }));
  ok("...and the device is decided, and written to disk (persist), BEFORE the save", order.join() === "device,persist,save", order.join());
  ok("...for the python it was measured on (the new venv)", devices[0]?.py === py, JSON.stringify(devices[0]?.py));
  ok("the message: set up, where it runs, and the weights the first run fetches",
    /^Stem separation is set up\. Timed lyrics run in .*\. The first separation fetches the separation weights \(336 MB\)\.$/.test(job.message || ""), job.message);
  ok("the marker records the card test", JSON.parse(readFileSync(path.join(root, ".aiplay-venv.json"), "utf8")).tensor?.ok === true);

  const bad = setup({ probe: () => ({ demucs: true, torch: true }),
    tensor: () => ({ ok: false, cuda: true, name: "NVIDIA GeForce RTX 5050", capability: "sm_120", error: "RuntimeError: CUDA error: no kernel image is available for execution on the device" }) });
  await bad.runner.run("stems");
  const b = await finished(bad.runner, "stems");
  ok("a card that fails the op: the python is still chosen, and the device becomes cpu",
    b.state === "done" && bad.saved.length === 1 && JSON.stringify(bad.devices) === JSON.stringify([["stems", "cpu"]]), JSON.stringify({ b, devices: bad.devices }));
  ok("...said in the message: the card, the failure, and that separation runs on the processor",
    /NVIDIA GeForce RTX 5050, sm_120 could not run PyTorch's CUDA 12\.8 build/.test(b.message || "") && /So stem separation runs on the processor \(slower\) until this setup is run again/.test(b.message || ""), b.message);

  const low = setup({ probe: () => ({ demucs: true, torch: true }), free: 4.1e9 });
  await low.runner.run("stems");
  const l = await finished(low.runner, "stems");
  const torchCall = calls(low.log).find((c) => c.argv.includes("torch"));
  ok("a nearly full drive builds the CPU torch, and a CPU build runs no card test",
    l.state === "done" && torchCall?.argv.at(-1) === "https://download.pytorch.org/whl/cpu" && low.tensors.length === 0 && low.devices.length === 0, JSON.stringify(torchCall));

  const stuck = setup({ probe: () => ({ demucs: true, torch: false }) });
  await stuck.runner.run("stems");
  const s = await finished(stuck.runner, "stems");
  ok("a venv where torch does not import is not done, and nothing is chosen",
    s.state === "failed" && stuck.saved.length === 0 && /torch does not import in/.test(s.message || ""), s.message);
}
{
  /* Tika's case: a python of her own imports demucs and torch, but its
   * PyTorch cannot run on her RTX 50. It is not called "working". */
  const mine = process.execPath;
  const theirs = setup({ current: () => mine, probe: () => ({ demucs: true, torch: true }),
    tensor: (py) => (py === mine ? { ok: false, cuda: true, error: "no kernel image is available" } : { ok: true, cuda: true, device: "cuda" }) });
  await theirs.runner.run("stems");
  const t = await finished(theirs.runner, "stems");
  ok("a current python whose PyTorch fails on the card: Studio builds its own CUDA 12.8 one instead of a no-op",
    t.state === "done" && !t.noop && calls(theirs.log).length === 4 && theirs.tensors[0] === mine && theirs.saved.length === 1, JSON.stringify(t));
  ok("...and says why in the log", t.lines.some((l) => /imports everything, but its PyTorch cannot run on this card, so Studio builds its own \(CUDA 12\.8\)/.test(l)));

  const works = setup({ current: () => mine, probe: () => ({ demucs: true, torch: true }) });
  const w = await works.runner.run("stems");
  ok("a current python that imports both and passes the card test: a no-op, device cleared",
    w.state === "ready" && w.noop && /Stem separation works here, so nothing was installed: .* has demucs and PyTorch\./.test(w.message || "")
      && calls(works.log).length === 0 && JSON.stringify(works.devices) === JSON.stringify([["stems", null]]), JSON.stringify(w));

  const lowFails = setup({ current: () => mine, probe: () => ({ demucs: true, torch: true }), free: 2e9,
    tensor: () => ({ ok: false, cuda: true, error: "no kernel image is available" }) });
  const lf = await lowFails.runner.run("stems");
  ok("...no room for the GPU build and the card fails: nothing is rebuilt, the device becomes cpu, and it says so",
    lf.state === "ready" && calls(lowFails.log).length === 0 && JSON.stringify(lowFails.devices) === JSON.stringify([["stems", "cpu"]])
      && /runs on the processor/.test(lf.message || ""), JSON.stringify(lf));
  ok("...with the way out being room on the drive, not a build that cannot fit",
    /with about 7\.3 GB free on (?:[A-Z]:|the drive), pressing Set up stem separation again builds PyTorch for the card\./.test(lf.message || ""), lf.message);
  ok("...and the verdict is written to disk at once, on a run that saved nothing else (persist)",
    lowFails.persisted.length === 1 && lowFails.saved.length === 0 && lowFails.devices[0]?.py === mine, JSON.stringify(lowFails.persisted));
}

console.log("\nWHEN A PYTHON THAT IMPORTS EVERYTHING IS STILL REPLACED (review, 2026-09-24)");
{
  /* The build a fake python "has" is the index its last torch install came
   * from, read back from the fake uv's own log. */
  const lastIdx = (log) => calls(log).filter((c) => c.argv.includes("torch")).at(-1)?.argv.at(-1)?.split("/").pop() || null;
  const card = (build, fails) => (fails
    ? { ok: false, cuda: true, name: "NVIDIA GeForce RTX 5050", capability: "sm_120", torch: `2.8.0+${build}`, error: "RuntimeError: CUDA error: no kernel image is available for execution on the device" }
    : build === "cpu" ? { ok: true, cuda: false, device: "cpu", torch: "2.8.0+cpu" }
      : { ok: true, cuda: true, device: "cuda", name: "NVIDIA GeForce RTX 5050", capability: "sm_120", torch: `2.8.0+${build}` });
  const torchCalls = (log) => calls(log).filter((c) => c.argv.includes("torch")).map((c) => c.argv.at(-1).split("/").pop());

  /* 1. Timed lyrics on an RTX 50: the advice, followed, leads somewhere. */
  let L = null;
  L = setup({ tensor: () => card(lastIdx(L.log), lastIdx(L.log) !== "cu128") });
  await L.runner.run("lyrics");
  const l1 = await finished(L.runner);
  ok("lyrics, auto, card not read: CUDA 12.6 is built, the card fails it, and the message points at CUDA 12.8",
    l1.state === "done" && /choose CUDA 12\.8 under PyTorch build and press Set up timed lyrics again/.test(l1.message || "")
      && /may fall back to the processor/.test(l1.message || ""), l1.message);
  const l2run = await L.runner.run("lyrics", { torch: "cu128" });
  const l2 = l2run.state === "running" ? await finished(L.runner) : l2run;
  ok("...pressing again with CUDA 12.8 chosen REBUILDS it on CUDA 12.8 (4 more uv calls), not a no-op",
    l2.state === "done" && !l2.noop && calls(L.log).length === 8 && JSON.stringify(torchCalls(L.log)) === '["cu126","cu128"]'
      && !/choose CUDA 12\.8/.test(l2.message || ""), JSON.stringify({ l2, torch: torchCalls(L.log) }));
  ok("...and the log says why", l2.lines.some((l) => /imports everything, but its PyTorch \(CUDA 12\.6\) cannot run on this card, so Studio builds its own \(CUDA 12\.8\)/.test(l)), JSON.stringify(l2.lines));
  const l3run = await L.runner.run("lyrics", { torch: "cu128" });
  const l3 = l3run.state === "running" ? await finished(L.runner) : l3run;
  ok("...and a third press with the same build chosen changes nothing", l3.noop && calls(L.log).length === 8, JSON.stringify(l3));

  /* 2. Stems built on the CPU while the drive was full, then the drive freed. */
  let free = 3e9;
  let C = null;
  C = setup({ probe: () => ({ demucs: true, torch: true }), tensor: () => card(lastIdx(C.log), false), free: () => free,
    torchBuild: () => ({ version: `2.8.0+${lastIdx(C.log)}`, cuda: lastIdx(C.log) === "cpu" ? null : "12.8" }) });
  const cRunner = C.runner;
  await cRunner.run("stems");
  const c1 = await finished(cRunner, "stems");
  ok("stems with 3 GB free: the CPU build", c1.state === "done" && JSON.stringify(torchCalls(C.log)) === '["cpu"]', JSON.stringify(torchCalls(C.log)));
  free = 400e9;
  const cst = (await cRunner.status("stems")).setups[0];
  ok("...the drive freed: status says it works, but ON THE PROCESSOR, and the offer names the GPU build replacing it",
    cst.ready === true && cst.onProcessor === true && cst.torchIndex === "cu128" && /CUDA 12\.8/.test(cst.offer) && cst.offer.includes("in place of"), JSON.stringify(cst));
  const c2run = await cRunner.run("stems");
  const c2 = c2run.state === "running" ? await finished(cRunner, "stems") : c2run;
  ok("...and pressing it (auto) builds the CUDA 12.8 one instead of saying \"works here\"",
    c2.state === "done" && !c2.noop && JSON.stringify(torchCalls(C.log)) === '["cpu","cu128"]', JSON.stringify({ c2, torch: torchCalls(C.log) }));
  ok("...said in the log", c2.lines.some((l) => /its PyTorch is the CPU build, and CUDA 12\.8 can use this PC's NVIDIA card/.test(l)), JSON.stringify(c2.lines));
  const cst2 = (await cRunner.status("stems")).setups[0];
  ok("...after which it is no longer on the processor", cst2.ready === true && cst2.onProcessor === false, JSON.stringify(cst2.onProcessor));
  free = 2e9;
  const c3run = await cRunner.run("stems");
  const c3 = c3run.state === "running" ? await finished(cRunner, "stems") : c3run;
  ok("...and a full drive later (auto now offers the CPU build) never replaces the working GPU one",
    c3.noop && JSON.stringify(torchCalls(C.log)) === '["cpu","cu128"]', JSON.stringify(c3));
  free = 400e9;
  const c4run = await cRunner.run("stems");
  const c4 = c4run.state === "running" ? await finished(cRunner, "stems") : c4run;
  ok("...nor does pressing auto again with room: the same build is kept", c4.noop && torchCalls(C.log).length === 2, JSON.stringify(c4));

  /* 3. Stems on a chosen CUDA 12.6 that the RTX 50 cannot run: the advice works. */
  let S = null;
  S = setup({ probe: () => ({ demucs: true, torch: true }), tensor: () => card(lastIdx(S.log), lastIdx(S.log) === "cu126") });
  await S.runner.run("stems", { torch: "cu126" });
  const s1 = await finished(S.runner, "stems");
  ok("stems on a chosen CUDA 12.6 the card fails: chosen, device cpu, and the advice is CUDA 12.8",
    s1.state === "done" && S.devices.at(-1)?.[1] === "cpu" && /choose CUDA 12\.8 under PyTorch build and press Set up stem separation again/.test(s1.message || ""), s1.message);
  const s2run = await S.runner.run("stems", { torch: "cu128" });
  const s2 = s2run.state === "running" ? await finished(S.runner, "stems") : s2run;
  ok("...pressing again with CUDA 12.8 rebuilds on 12.8, the card passes, and the device is cleared",
    s2.state === "done" && !s2.noop && JSON.stringify(torchCalls(S.log)) === '["cu126","cu128"]' && S.devices.at(-1)?.[1] === null
      && !/processor/.test(s2.message || ""), JSON.stringify({ s2, torch: torchCalls(S.log), dev: S.devices }));

  /* 4. Studio's own venv built before but not chosen: reused only when it is the build asked for. */
  const R = setup({ probe: () => ({ demucs: true, torch: true }), current: () => null, quietSave: true });
  await R.runner.run("stems", { torch: "cu126" });
  await finished(R.runner, "stems");
  const r2run = await R.runner.run("stems", { torch: "cu126" });
  const r2 = r2run.state === "running" ? await finished(R.runner, "stems") : r2run;
  ok("a finished Studio venv of the build asked for is chosen again, in plain words",
    r2.noop && torchCalls(R.log).length === 1 && /was already built, and stem separation uses it now:/.test(r2.message || ""), r2.message);
  const r3run = await R.runner.run("stems", { torch: "cu128" });
  const r3 = r3run.state === "running" ? await finished(R.runner, "stems") : r3run;
  ok("...while another build chosen rebuilds it (the marker says which build it was made with)",
    !r3.noop && r3.state === "done" && JSON.stringify(torchCalls(R.log)) === '["cu126","cu128"]'
      && r3.lines.some((l) => /Studio's own stem separation Python \(CUDA 12\.6\) is built again with CUDA 12\.8: you chose CUDA 12\.8/.test(l)), JSON.stringify(r3.lines));

  /* 5. Tika's likely python: a plain `pip install demucs`, so the CPU build of torch. */
  const mine = process.execPath;
  const T = setup({ current: () => mine, probe: () => ({ demucs: true, torch: true }),
    tensor: (py) => (py === mine ? card("cpu", false) : card("cu128", false)),
    torchBuild: (py) => (py === mine ? { version: "2.5.1+cpu", cuda: null } : { version: "2.8.0+cu128", cuda: "12.8" }) });
  const tst = (await T.runner.status("stems")).setups[0];
  ok("a working python with the CPU build of torch on an NVIDIA card with room: ready, onProcessor, and the offer replaces it",
    tst.ready === true && tst.onProcessor === true && tst.offer.includes(`in place of ${mine}`), JSON.stringify(tst));
  await T.runner.run("stems");
  const t1 = await finished(T.runner, "stems");
  ok("...and pressing it builds Studio's own CUDA 12.8 python instead of \"works here\"",
    t1.state === "done" && !t1.noop && JSON.stringify(torchCalls(T.log)) === '["cu128"]' && T.saved.length === 1, JSON.stringify(t1));
  const Tfull = setup({ current: () => mine, probe: () => ({ demucs: true, torch: true }), free: 2e9,
    tensor: () => card("cpu", false), torchBuild: () => ({ version: "2.5.1+cpu", cuda: null }) });
  const tf = await Tfull.runner.run("stems");
  const tfs = (await Tfull.runner.status("stems")).setups[0];
  ok("...but with a full drive it is kept (auto offers the CPU build it already has), and is not flagged",
    tf.noop && calls(Tfull.log).length === 0 && /Its PyTorch is the CPU build/.test(tf.message || "") && tfs.onProcessor === false, JSON.stringify({ tf, onProcessor: tfs.onProcessor }));

  /* 6. The rule itself. */
  const want = (torch, extra = {}) => ({ ...stemsRecipe({ vendor: "nvidia", freeBytes: 500e9, torch }), ...extra });
  ok("replaceWhy: the same build is kept, even when the card fails it (a driver matter)",
    replaceWhy(want("auto"), "cu128", card("cu128", true)) === null && replaceWhy(want("cu126"), "cu126", null) === null);
  ok("replaceWhy: a card failure on another build replaces it; an unknown build too",
    /cannot run on this card/.test(replaceWhy(want("auto"), "cu121", card("cu121", true)) || "") && /cannot run on this card/.test(replaceWhy(want("auto"), null, card("x", true)) || ""));
  ok("replaceWhy: a chosen build replaces a different one; auto keeps a working different CUDA build",
    /you chose CUDA 12\.8, and its PyTorch is CUDA 12\.1/.test(replaceWhy(want("cu128"), "cu121", card("cu121", false)) || "")
      && replaceWhy(want("auto"), "cu126", card("cu126", false)) === null && replaceWhy(want("cu128"), null, null) === null);
  ok("replaceWhy: auto replaces the CPU build when it offers CUDA, never the other way round",
    /CPU build/.test(replaceWhy(want("auto"), "cpu", card("cpu", false)) || "")
      && replaceWhy(stemsRecipe({ vendor: "nvidia", freeBytes: 2e9 }), "cu128", null) === null);

  /* 7. ffmpeg: demucs 4.1 writes FLAC with it, and no setup installs it. */
  const F = setup({ probe: () => ({ demucs: true, torch: true }), ffmpeg: () => null });
  await F.runner.run("stems");
  const f1 = await finished(F.runner, "stems");
  const fst = (await F.runner.status("stems")).setups[0];
  ok("with no ffmpeg found, the stems setup still finishes and says separating needs it",
    f1.state === "done" && /Separating also needs ffmpeg, which Studio does not install/.test(f1.message || "") && fst.ffmpegFound === false, f1.message);
  const lst = (await F.runner.status("lyrics")).setups[0];
  ok("...the lyrics row neither needs nor reports it", !("ffmpegFound" in lst));
}
{
  /* The torch-build reader: torch/version.py read as text, torch never imported. */
  const src = Buffer.from(/b64decode\('([^']+)'\)/.exec(TORCH_BUILD_ARGS[1])?.[1] || "", "base64").toString("utf8");
  ok("probeTorchBuild reads torch/version.py and never imports torch", /version\.py/.test(src) && /find_spec\('torch'\)/.test(src) && !/import torch/.test(src), src);
  const fakeSpawn = (answer) => (_py, _args, opts) => spawn(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(answer))})`], opts);
  const cpu = await probeTorchBuild("C:\\any\\python.exe", { spawnFn: fakeSpawn({ version: "2.5.1+cpu", cuda: null }) });
  const cu = await probeTorchBuild("C:\\any\\python.exe", { spawnFn: fakeSpawn({ version: "2.5.1+cu121", cuda: "12.1" }) });
  const none = await probeTorchBuild(path.join(tmp, "no-python.exe"));
  ok("...its answers: the CPU build (cuda null), a CUDA build, and null for a python that cannot start",
    cpu?.cuda === null && cpu?.version === "2.5.1+cpu" && cu?.cuda === "12.1" && none === null, JSON.stringify({ cpu, cu, none }));
}
{
  const { runner } = setup({ current: () => process.execPath, probe: () => ({ demucs: false, torch: true }), free: 4.1e9 });
  const st = (await runner.status("stems")).setups[0];
  ok("status for stems: the lyrics fields plus freeGb and needGb, and each build's own offer",
    st.id === "stems" && st.capability === "stems" && st.button === "Set up stem separation" && st.label === "stem separation"
      && st.freeGb === 4.1 && st.needGb?.gpu === 7.3 && st.needGb?.cpu === 3.8
      && Object.keys(st.offers).join() === "auto,cu126,cu128,cpu" && st.torchIndex === "cpu"
      && /^Auto: the CPU build \(an NVIDIA card was read, but .* has 4\.1 GB free/.test(st.torchBuilds.auto)
      && JSON.stringify(st.modules) === '["demucs","torch"]' && st.ready === false
      && st.offers.auto.includes(`in place of ${process.execPath}`), JSON.stringify(st));
  const lyr = (await runner.status("lyrics")).setups[0];
  ok("...and the lyrics row carries no drive numbers (it does not weigh the drive)", !("freeGb" in lyr) && !("needGb" in lyr));
}

console.log("\nTHE DOOR");
{
  const INDEX = read("server/index.js");
  const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(INDEX)?.[0] || "";
  const bodySrc = /async function readBody\(req, maxBytes = 0\) \{[\s\S]*?\n\}/.exec(INDEX)?.[0] || "";
  ok("the real guard and body reader are sliced from index.js", !!guardSrc && !!bodySrc);
  const config = { uiPort: 4173 };
  const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)(config);
  const readBody = new Function(`${bodySrc}\nreturn readBody;`)();
  const ran = [];
  const runner = { has: (id) => id === "lyrics", ids: ["lyrics"],
    run: async (id, o) => { ran.push([id, o]); return { id, state: "running" }; },
    status: async (id) => ({ setups: [{ id: id || "lyrics" }] }) };
  const door = createSetupRoutes({ json: (_res, code, body) => { door.last = { code, body }; }, readBody, sameOriginLocalJson, runner });
  const HOST = "127.0.0.1:4173";
  const req = (body, headers) => {
    const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return { method: "POST", headers, async *[Symbol.asyncIterator]() { yield raw; } };
  };
  const PAGE = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" };
  const call = async (body, headers = PAGE) => { door.last = null; const handled = await door(req(body, headers), null, new URL(`http://${HOST}/api/setup`)); return { handled, ...door.last }; };

  let r = await call({ action: "run", id: "lyrics" });
  ok("Studio's own page starts it", r.code === 200 && r.body.ok && ran.length === 1 && ran[0][1].torch === "auto", JSON.stringify(r));
  for (const [what, headers] of [
    ["a cross-site no-cors POST (text/plain)", { host: HOST, origin: "https://evil.example", "content-type": "text/plain" }],
    ["a foreign Origin with a JSON type", { host: HOST, origin: "https://evil.example", "content-type": "application/json" }],
    ["a rebound DNS name as Host", { host: "rebind.evil.example:4173", "content-type": "application/json" }],
  ]) {
    r = await call({ action: "run", id: "lyrics" }, headers);
    ok(`${what} gets 403 and starts nothing`, r.code === 403 && ran.length === 1, JSON.stringify(r));
  }
  r = await call({ action: "status" }, { host: HOST, origin: "https://evil.example", "content-type": "text/plain" });
  ok("reading the status stays open (it runs nothing new)", r.code === 200 && r.body.setups?.length === 1);
  r = await call({ action: "run", id: "lyrics", torch: "cpu" }, { host: HOST, "content-type": "application/json" });
  ok("a local client (MCP) may choose the torch build", r.code === 200 && ran.at(-1)[1].torch === "cpu");
  r = await call({ action: "run", id: "lyrics", torch: "rocm" });
  ok("an unknown torch build is refused", r.code === 400 && /torch must be one of: auto, cu126, cu128, cpu/.test(r.body.error));
  /* (It used to be "stems" that was unknown here; stems is a recipe now, below.) */
  r = await call({ action: "run", id: "karaoke" });
  ok("an unknown setup is refused by name, with the ones there are", r.code === 400 && /No setup called "karaoke". There is: lyrics./.test(r.body.error), JSON.stringify(r.body));
  r = await call({ action: "install" });
  ok("an unknown action says which it knows", r.code === 400 && /Unknown action\. Try: run, status\./.test(r.body.error));
  const blockedDoor = createSetupRoutes({ json: (_res, code, body) => { blockedDoor.last = { code, body }; }, readBody, sameOriginLocalJson,
    runner: { has: () => true, ids: ["lyrics"], run: async (id) => ({ id, state: "blocked", message: "AIPLAY_WHISPER_PYTHON is set." }), status: async () => ({ setups: [] }) } });
  await blockedDoor(req({ action: "run", id: "lyrics" }, PAGE), null, new URL(`http://${HOST}/api/setup`));
  ok("a setup that would change nothing answers 409 with its reason", blockedDoor.last.code === 409 && blockedDoor.last.body.error === "AIPLAY_WHISPER_PYTHON is set.");
  r = await call(JSON.stringify({ action: "run", id: "lyrics", pad: "x".repeat(10_000) }));
  ok("a body over the cap is refused before JSON.parse", r.code === 413 && ran.length === 2, JSON.stringify(r));
  const other = await door({ method: "POST", headers: PAGE }, null, new URL(`http://${HOST}/api/models`));
  ok("any other path falls through", other === false);

  const mount = INDEX.slice(INDEX.indexOf("const setupRoutes = createSetupRoutes("), INDEX.indexOf("const setupRoutes = createSetupRoutes(") + 1400);
  ok("index.js mounts it with the real guard and body reader", /createSetupRoutes\(\{ json, readBody, sameOriginLocalJson, runner:/.test(mount)
    && /if \(p === "\/api\/setup"\) \{\s*\n\s*if \(await setupRoutes\(req, res, url\)\) return;/.test(INDEX));
  ok("...and a finished build is chosen through the Settings fields, then answered with that door's verdict",
    /config\.lyrics\.whisperPython = py;\s*\n\s*config\.lyrics\.python = whisperPython\(\);[\s\S]*?savePrefs\(\)[\s\S]*?pythonVerdict\(/.test(mount), mount.slice(0, 300));
  ok("...with AIPLAY_WHISPER_PYTHON blocking the lyrics build, and Studio's engine packages served by the same door",
    /blockedBy: \(id\) => \(id === "lyrics" && process\.env\.AIPLAY_WHISPER_PYTHON/.test(mount)
      && /runner: oneRunner\(createSetupRunner\(/.test(mount) && /createEnginePackagesRunner\(\{[\s\S]*?rig: \(\) => config\.rig,[\s\S]*?python: \(\) => config\.python,/.test(mount));
}

console.log("\nSTUDIO'S OWN ENGINE PACKAGES AGAIN (studio-packages)");
{
  /* A fake engine installer: records its argv and the engine folder it was
   * pointed at, then answers the way install-engine.mjs --studio-packages does. */
  const FAKE_ENGINE = path.join(tmp, "fake-install-engine.mjs");
  writeFileSync(FAKE_ENGINE, `import { appendFileSync } from "node:fs";
if (process.env.FAKE_ENGINE_LOG) appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify({ argv: process.argv.slice(2), rig: process.env.AIPLAY_ENGINE_DIR, appData: process.env.AIPLAY_APPDATA }) + "\\n");
console.log("installing opencv-python-headless librosa soundfile");
if (process.env.FAKE_ENGINE_FAIL) { console.log("@@done " + JSON.stringify({ studio: { ok: false, missing: ["librosa"], warning: "The engine works, but Studio's own packages did not all install (missing: librosa)." } })); process.exit(1); }
console.log("@@done " + JSON.stringify({ studio: { ok: true, missing: [] } }));
`);
  const engineLog = path.join(tmp, "engine.jsonl");
  process.env.FAKE_ENGINE_LOG = engineLog;
  const rig = path.join(tmp, "engine");
  mkdirSync(rig, { recursive: true });
  /* The engine's own venv python (a runner blocks any other: R4d 5). Never
   * run: both probes are faked. */
  const py = engineVenvPython(rig);
  mkdirSync(path.dirname(py), { recursive: true });
  writeFileSync(py, "");
  const make = (probe = () => ({ cv2: false, librosa: false, soundfile: false, scipy: false })) => createEnginePackagesRunner({
    appData: path.join(tmp, "eng-appdata"), rig: () => rig, python: () => py, probe: async (p, m) => probe(p, m), quickMs: 30,
    imports: async (p, m) => probe(p, m), run: (o) => runStudioPackages({ ...o, script: FAKE_ENGINE }),
  });

  let r = make();
  let job = await r.run(ENGINE_SETUP_ID);
  ok("an engine Studio did not install (no marker) is refused, and nothing runs",
    job.state === "blocked" && /was not installed by Studio, so Studio does not install into it/.test(job.message) && calls(engineLog).length === 0, JSON.stringify(job));
  ok("...status says why, with the command for its own python", /-m pip install opencv-python-headless librosa soundfile/.test((await r.status()).setups[0].blocked || ""));

  writeFileSync(path.join(rig, ".aiplay-engine.json"), JSON.stringify({ complete: true, backend: "nvidia" }));
  r = make(() => ({ cv2: true, librosa: true, soundfile: true, scipy: true }));
  job = await r.run(ENGINE_SETUP_ID);
  ok("all four already importing is a no-op", job.state === "ready" && job.noop && calls(engineLog).length === 0, JSON.stringify(job));

  r = make();
  await r.run(ENGINE_SETUP_ID);
  for (let i = 0; i < 200 && (await r.status()).setups[0].job?.state === "running"; i++) await sleep(20);
  job = (await r.status()).setups[0].job;
  const got = calls(engineLog);
  ok("a missing package runs the installer's --studio-packages --add-only against config.rig, and reports done",
    job.state === "done" && got.length === 1 && got[0].argv.join(" ") === "--studio-packages --add-only" && got[0].rig === rig
      && got[0].appData === path.join(tmp, "eng-appdata") && /installed in the engine/.test(job.message), JSON.stringify({ job, got }));
  ok("...its output lines are the job's lines", job.lines.some((l) => /installing opencv-python-headless/.test(l)));

  process.env.FAKE_ENGINE_FAIL = "1";
  r = make();
  await r.run(ENGINE_SETUP_ID);
  for (let i = 0; i < 200 && (await r.status()).setups[0].job?.state === "running"; i++) await sleep(20);
  delete process.env.FAKE_ENGINE_FAIL;
  job = (await r.status()).setups[0].job;
  ok("a failure is the installer's own sentence", job.state === "failed" && /missing: librosa/.test(job.message), JSON.stringify(job));

  const real = await runStudioPackages({ rig: path.join(tmp, "not-an-engine"), appData: path.join(tmp, "eng-appdata") });
  ok("the real install-engine.mjs --studio-packages refuses a folder with no finished engine, and says so",
    real.ok === false && /holds no finished engine made by this installer/.test(real.error || ""), JSON.stringify(real));

  const both = oneRunner({ has: (id) => id === "lyrics", ids: ["lyrics"], run: async () => ({ who: "venv" }), status: async () => ({ setups: [{ id: "lyrics" }] }) }, make());
  ok("one door serves both kinds: ids, run by owner, status merged",
    both.ids.join() === `lyrics,${ENGINE_SETUP_ID}` && both.has(ENGINE_SETUP_ID) && !both.has("stems")
      && (await both.run("lyrics")).who === "venv"
      && (await both.status()).setups.map((x) => x.id).join() === `lyrics,${ENGINE_SETUP_ID}`
      && (await both.status(ENGINE_SETUP_ID)).setups.length === 1);
}

console.log("\nMCP, AND THE IN-APP CHAT");
{
  const { TOOLS } = await import("./mcp.js");
  const { ROUTABLE, WITHHELD } = await import("./chat/router.js");
  const feature = TOOLS.find((t) => t.name === "setup_feature"), status = TOOLS.find((t) => t.name === "setup_status");
  ok("setup_feature and setup_status exist", !!feature && !!status);
  ok("setup_feature posts the door's run action with the id and the optional torch build",
    /api\("POST", "\/api\/setup", \{ action: "run", id: String\(a\.id \|\| ""\)/.test(String(feature?.run)) && feature.inputSchema.required.join() === "id"
      && JSON.stringify(feature.inputSchema.properties.torch.enum) === JSON.stringify(TORCH_CHOICES));
  ok("...its ids are the venv recipes and studio-packages, the same list setup_status takes",
    JSON.stringify(feature.inputSchema.properties.id.enum) === JSON.stringify([...RECIPE_IDS, ENGINE_SETUP_ID])
      && JSON.stringify(status.inputSchema.properties.id.enum) === JSON.stringify([...RECIPE_IDS, ENGINE_SETUP_ID]));
  ok("...and its description sends the agent to setup_status for sizes instead of typing one",
    !/\d+(\.\d+)? GB/.test(feature.description) && /setup_status first/.test(feature.description));
  ok("setup_status posts the status action", /action: "status"/.test(String(status?.run)));
  ok("the chat may not start a setup (withheld, with the reason)", typeof WITHHELD.setup_feature === "string"
    && /downloads gigabytes/.test(WITHHELD.setup_feature) && !("setup_feature" in ROUTABLE));
  ok("...but may read how one is going", "setup_status" in ROUTABLE && ROUTABLE.setup_status === null);
}

console.log("\nTHE PAGE: THREE PLACES, ONE DOOR");
{
  const html = read("web/index.html"), app = read("web/app.js"), mod = read("web/setup-feature.js");
  ok("Settings > Songs has the button, beside the timed lyrics python field",
    /id="btnWhisperPy">Use<\/button>\s*(?:<!--[\s\S]*?-->\s*)?<button[^>]*id="btnSetupLyrics"[^>]*data-setup-feature="lyrics"[^>]*>Set up timed lyrics<\/button>/.test(html)
      && /id="setupLyricsNote"/.test(html));
  ok("the Models screen asks the module to add it to the rows the server names (typeof-guarded for lifted lanes)",
    /if \(typeof paintSetupButtons === "function"\) paintSetupButtons\(\$\("modelList"\), \{ refresh: loadModels \}\);/.test(app));
  ok("the refusal on Time the lyrics offers it (typeof-guarded)",
    /r\.setup && typeof offerSetup === "function"\) offerSetup\(r\.setup, r\.error\)/.test(app));
  ok("...and a batch offers it with the refusal that carried the setup, keeping the not-queued count",
    /if \(r\?\.setup && !setupRefusal\) setupRefusal = r;/.test(app)
      && /offerSetup\(setupRefusal\.setup, setupRefusal\.error, \{ lead: `\$\{errors\.length\} of \$\{songs\} were not queued\.` \}\)/.test(app));
  ok("Settings' python field is the one a finished job writes into, and the PyTorch build sits beside the button",
    /id="qWhisperPy"[^>]*data-setup-python="lyrics"/.test(html) && /<select id="qSetupLyricsTorch" data-setup-torch="lyrics"/.test(html)
      && /for \(const el of sel\("data-setup-python", job\.id\)\) el\.value = job\.python;/.test(mod)
      && /post\(\{ action: "run", id: s\.id, torch: torchOf\(s\) \}\)/.test(mod));
  ok("a ready or blocked setup is said, not offered",
    /if \(s\.blocked\) \{ appAlert\(s\.blocked\); return; \}/.test(mod) && /if \(s\.ready\) \{ appAlert\(/.test(mod));
  ok("the module posts only this door, and decides nothing itself",
    /"\/api\/setup"/.test(mod) && !/cu126|nvidia|GB/i.test(mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
