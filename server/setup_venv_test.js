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
 *   - the MCP tools, and that the in-app chat may not start one.
 *
 *   node server/setup_venv_test.js
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSetupRunner, lyricsRecipe, offerSentence, localDiskProblem, venvPython, RECIPE_IDS, TORCH_CHOICES } from "./setup/venv.js";
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
  driveType = async () => "Fixed", appData = null, quickMs = 60, blockedBy = undefined, commandTimeoutMs = undefined } = {}) {
  scenario++;
  const dir = appData || path.join(tmp, `case${scenario}`);
  const log = path.join(tmp, `uv${scenario}.jsonl`);
  process.env.FAKE_UV_LOG = log;
  const saved = [], probed = [];
  const runner = createSetupRunner({
    appData: dir, vendor: () => vendor,
    probe: async (py, mods) => { probed.push([py, mods]); return probe(py, mods); },
    /* By default the feature runs in whatever was last chosen, as config.lyrics.python does. */
    currentPython: () => (current ? current() : saved.at(-1)?.[1] || null),
    save: async (id, py) => { saved.push([id, py]); return { note: `Timed lyrics run in ${py}, and faster-whisper and stable-ts both import there.` }; },
    getUv: async () => [process.execPath, FAKE_UV],
    driveType, quickMs, blockedBy, commandTimeoutMs,
  });
  return { runner, dir, log, saved, probed };
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
  ok("recipes and torch choices are the lists MCP offers", RECIPE_IDS.join() === "lyrics" && TORCH_CHOICES.join() === "auto,cu126,cpu");
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
    st.ready === false && Object.keys(st.offers).join() === "auto,cu126,cpu"
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
  ok("an unknown torch build is refused", r.code === 400 && /torch must be one of: auto, cu126, cpu/.test(r.body.error));
  r = await call({ action: "run", id: "stems" });
  ok("an unknown setup is refused by name", r.code === 400 && /No setup called "stems"/.test(r.body.error));
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
