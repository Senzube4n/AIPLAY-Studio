/** Isolated Qwen engine staging: no downloads, package installs or GPU needed. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMFY_TAG, QWEN_COMFY_TAG, comfyPinNote, UV_VERSION, uvPin, keptUvPath } from "./setup/pins.js";

const script = fileURLToPath(new URL("../scripts/install-engine.mjs", import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-qwen-install-"));
const readme = path.join(tmp, "README.md");
writeFileSync(readme, "# ComfyUI\n");
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env },
});
const stageArgs = ["--backend", "cpu", "--qwen-compatible", "--stage-only"];
const marker = root => path.join(root, ".aiplay-engine.json");
const mark = (root, data) => { mkdirSync(root, { recursive: true }); writeFileSync(marker(root), JSON.stringify(data)); };
const record = (output, id) => {
  const line = output.split(/\r?\n/).find(value => value.startsWith(`@@${id} `));
  return line ? JSON.parse(line.slice(id.length + 3)) : null;
};

test.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));

test("an explicit ComfyUI update tag stays isolated and keeps the ordinary pins unchanged", () => {
  const root = path.join(tmp, "tag-plan");
  for (const backend of ["nvidia", "amd", "intel", "cpu"]) {
    const result = run(["--backend", backend, "--stage-only", "--comfy-tag", "v0.38.0", "--plan", readme], { AIPLAY_ENGINE_DIR: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.comfy.tag, "v0.38.0"); assert.match(plan.comfy.url, /\/v0\.38\.0\.tar\.gz$/);
    assert.equal(plan.stageOnly, true); assert.equal(plan.qwenCompatible, false); assert.equal(plan.steps.includes("qwen"), false);
    assert.equal(plan.root, root); assert.equal(existsSync(root), false, "--plan creates no engine");
  }
  assert.equal(JSON.parse(run(["--backend", "cpu", "--plan", readme]).stdout).comfy.tag, COMFY_TAG);
});

test("invalid update-tag combinations refuse before planning or cleaning any existing engine", () => {
  const root = path.join(tmp, "protected-update-tag"), appData = path.join(tmp, "protected-update-appdata");
  mark(root, { complete: true }); writeFileSync(path.join(root, "keep.txt"), "keep");
  const good = ["--backend", "cpu", "--stage-only", "--comfy-tag", "v0.38.0", "--plan", readme];
  const invalid = [
    ["--backend", "cpu", "--comfy-tag", "v0.38.0", "--plan", readme],
    [...good, "--qwen-compatible"], [...good, "--studio-packages"], [...good, "--comfy-tag", "v0.39.0"], [...good, "--comfy-tag=evil"],
    ["--backend", "cpu", "--stage-only", "--comfy-tag=v0.38.0", "--plan", readme],
    ...["main", "v01.2.3", "v0.38.0-rc.1", "v0.38.0/path", "https://example.com/archive.tar.gz", "v0.38.0;echo bad"]
      .map(tag => ["--backend", "cpu", "--stage-only", "--comfy-tag", tag, "--plan", readme]),
  ];
  for (const args of invalid) {
    const result = run(args, { AIPLAY_APPDATA: appData, AIPLAY_ENGINE_DIR: root });
    assert.equal(result.status, 1, result.stdout + result.stderr); assert.equal(record(result.stdout, "error").cleaned, false);
    assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "keep");
  }
  assert.equal(run(good, { AIPLAY_ENGINE_DIR: "" }).status, 1, "an explicit folder is required even for a plan");
  const actual = run(good.slice(0, -2), { AIPLAY_APPDATA: appData, AIPLAY_ENGINE_DIR: root });
  assert.equal(actual.status, 1); assert.match(record(actual.stdout, "error").message, /finished engine/);
  assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "keep");
});

test("Qwen repair selects its own pin and adds verification on every supported backend", () => {
  for (const backend of ["nvidia", "amd", "intel", "cpu"]) {
    const result = run(["--backend", backend, "--qwen-compatible", "--stage-only", "--plan", readme]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.comfy.tag, QWEN_COMFY_TAG);
    assert.equal(QWEN_COMFY_TAG, "v0.37.0");
    assert.match(plan.comfy.url, /\/refs\/tags\/v0\.37\.0\.tar\.gz$/);
    assert.equal(plan.stageOnly, true);
    assert.equal(plan.qwenCompatible, true);
    assert.deepEqual(plan.steps.slice(-3), ["test", "qwen", "save"]);
  }
  const ordinary = JSON.parse(run(["--backend", "cpu", "--plan", readme]).stdout);
  assert.equal(ordinary.comfy.tag, COMFY_TAG);
  assert.equal(COMFY_TAG, "v0.36.0");
  assert.equal(ordinary.stageOnly, false);
  assert.ok(!ordinary.steps.includes("qwen"));
});

test("the launcher accepts only a completed verified Qwen repair on its separate pin", () => {
  const qwenNodes = ["TextEncodeQwenImage21", "QwenImage21Cache"];
  const receipt = { complete: true, comfy: QWEN_COMFY_TAG, stageOnly: true, studio: { ok: true }, qwenNodes,
    metadata: { comfy: QWEN_COMFY_TAG, stageOnly: true, studio: { ok: true }, qwenNodes } };
  assert.equal(comfyPinNote(receipt), null);
  for (const changed of [
    { ...receipt, stageOnly: false }, { ...receipt, qwenNodes: [] },
    { ...receipt, qwenNodes: qwenNodes.join(",") },
    { ...receipt, metadata: { ...receipt.metadata, qwenNodes: ["TextEncodeQwenImage21"] } },
    { ...receipt, metadata: { ...receipt.metadata, comfy: "v0.38.0" } },
    { ...receipt, studio: { ok: false } }, { complete: true, comfy: QWEN_COMFY_TAG },
  ]) assert.match(comfyPinNote(changed), /tested with v0\.36\.0/, "unverified or ordinary engines retain the warning");
  assert.match(comfyPinNote(receipt, "v0.35.0"), /tested with v0\.35\.0/, "an explicit pin comparison stays explicit");
});

test("staging refuses current, completed, unmarked and other incomplete engines without deleting them", () => {
  const appData = path.join(tmp, "protected-appdata");
  const current = path.join(appData, "engine");
  const complete = path.join(tmp, "complete-stage");
  const incomplete = path.join(tmp, "ordinary-partial");
  const unmarked = path.join(tmp, "unmarked");
  mark(current, { complete: true });
  mark(complete, { complete: true, stageOnly: true });
  mark(incomplete, { complete: false });
  mkdirSync(unmarked);
  mkdirSync(appData, { recursive: true });
  const settings = JSON.stringify({ rig: current, python: "existing-python", modelsDir: "shared-models", custom: 42 });
  writeFileSync(path.join(appData, "settings.json"), settings);
  for (const root of [current, complete, incomplete, unmarked]) {
    writeFileSync(path.join(root, "keep.txt"), "preserve me");
    const result = run(stageArgs, { AIPLAY_APPDATA: appData, AIPLAY_ENGINE_DIR: root });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(record(result.stdout, "error").cleaned, false);
    assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "preserve me");
    assert.equal(readFileSync(path.join(appData, "settings.json"), "utf8"), settings);
  }
  const absent = run(stageArgs, { AIPLAY_APPDATA: appData, AIPLAY_ENGINE_DIR: "" });
  assert.equal(absent.status, 1);
  assert.match(record(absent.stdout, "error").message, /own AIPLAY_ENGINE_DIR/);
  const otherCurrent = path.join(tmp, "external-current");
  mark(otherCurrent, { complete: false, stageOnly: true });
  writeFileSync(path.join(appData, "settings.json"), JSON.stringify({ rig: otherCurrent }));
  assert.equal(run(stageArgs, { AIPLAY_APPDATA: appData, AIPLAY_ENGINE_DIR: otherCurrent }).status, 1);
  assert.equal(JSON.parse(readFileSync(marker(otherCurrent))).complete, false);
});

test("invalid options cannot clean a completed engine", () => {
  const root = path.join(tmp, "invalid-options");
  mark(root, { complete: true, stageOnly: true });
  writeFileSync(path.join(root, "keep.txt"), "keep");
  for (const args of [[...stageArgs, "--studio-packages"], ["--backend", "quantum"]]) {
    const result = run(args, { AIPLAY_APPDATA: path.join(tmp, "invalid-appdata"), AIPLAY_ENGINE_DIR: root });
    assert.equal(result.status, 1);
    assert.equal(record(result.stdout, "error").cleaned, false);
    assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "keep");
  }
});

test("known unsupported NVIDIA hardware refuses before replacing a finished engine", () => {
  const root = path.join(tmp, "unsupported-nvidia");
  mark(root, { complete: true, comfy: COMFY_TAG });
  writeFileSync(path.join(root, "keep.txt"), "keep");
  const result = run(["--backend", "nvidia", "--gpu-capability", "3.5"], { AIPLAY_APPDATA: path.join(tmp, "unsupported-data"), AIPLAY_ENGINE_DIR: root });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(record(result.stdout, "error").message, /compute capability 3\.5.*5\.0 minimum/);
  assert.equal(record(result.stdout, "error").cleaned, false);
  assert.equal(readFileSync(path.join(root, "keep.txt"), "utf8"), "keep");
});

/* Real Python loads a tiny Comfy extension fixture. Everything that downloads,
 * installs packages or touches hardware is faked in the installer subprocess;
 * the actual Qwen import/schema probe still runs, including its failure path. */
const python = [process.env.AIPLAY_TEST_PYTHON, "python3", "python"].filter(Boolean)
  .find(command => spawnSync(command, ["-c", "print('fixture')"], { encoding: "utf8", timeout: 5000 }).status === 0);
const hook = path.join(tmp, "installer-fixture.cjs");
writeFileSync(hook, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');
const { syncBuiltinESMExports } = require('node:module');
const originalExecFile = cp.execFile;
const nvidia = process.env.FIXTURE_NVIDIA === '1';
const log = entry => fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(entry) + '\\n');
fs.promises.statfs = async () => ({ bavail: 100, bsize: 1024 ** 3 });
global.fetch = async () => new Response(fs.readFileSync(process.env.FIXTURE_ARCHIVE), { status: 200 });
cp.execFile = function(command, args, options, callback) {
  log({ command, args, cwd: options?.cwd });
  if (path.basename(command).toLowerCase().startsWith('tar')) return originalExecFile(command, args, options, callback);
  const code = args[args.indexOf('-c') + 1] || '';
  if (code.includes('from comfy_extras.nodes_qwen import comfy_entrypoint')) {
    return originalExecFile(process.env.FIXTURE_PYTHON, args, options, callback);
  }
  let stdout = '';
  if (command === 'nvidia-smi') stdout = 'NVIDIA GeForce RTX 4070, 8.9, 591.74\\n';
  else if (code.includes('@@modules')) stdout = '@@modules ' + JSON.stringify({ cv2: process.env.FIXTURE_STUDIO_MISSING === '1' ? 'fixture OpenCV import failed' : true, librosa: true, soundfile: true, scipy: true });
  else if (code.includes('@@versions')) stdout = '@@versions ' + JSON.stringify({ torch: nvidia ? '2.14.1+cu130' : '2.9.0+cpu', numpy: '2.2.6' });
  else if (code.includes('@@probe')) stdout = '@@probe ' + JSON.stringify({ version: nvidia ? '2.14.1+cu130' : '2.9.0+cpu', backend: nvidia ? 'cuda' : 'cpu', cudaVersion: nvidia ? '13.0' : null,
    gpu: nvidia && !process.env.FIXTURE_RUNTIME_ERROR, name: nvidia ? 'NVIDIA GeForce RTX 4070' : '', smoke: !process.env.FIXTURE_RUNTIME_ERROR,
    error: process.env.FIXTURE_RUNTIME_ERROR || undefined, capability: nvidia ? '8.9' : null, python: command, pythonVersion: '3.13.9' });
  else if (args.includes('freeze')) stdout = nvidia ? 'torch==2.14.1+cu130\\ntorchvision==0.29.1+cu130\\ntorchaudio==2.11.0+cu130\\nnumpy==2.2.6\\n' : 'torch==2.9.0+cpu\\nnumpy==2.2.6\\n';
  process.nextTick(() => callback(null, stdout, ''));
  return new EventEmitter();
};
cp.execFile[promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
  cp.execFile(command, args, options, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    else resolve({ stdout, stderr });
  });
});
cp.spawn = function(command, args, options) {
  log({ command, args, cwd: options?.cwd });
  if (args[0] === 'venv') {
    const venv = args[args.length - 1];
    const py = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
    fs.mkdirSync(path.dirname(py), { recursive: true }); fs.writeFileSync(py, 'fixture');
  }
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
  setImmediate(() => { child.stdout.emit('end'); child.stderr.emit('end'); child.emit('close', 0, null); });
  return child;
};
syncBuiltinESMExports();
`);

function fixture(name, { missing = false, broken = false, incomplete = false, studioMissing = false, defer = false, nvidia = false, runtimeError = '' } = {}) {
  const base = path.join(tmp, name);
  const source = path.join(base, "archive", "ComfyUI-v0.37.0");
  const root = path.join(base, "new-engine");
  const appData = path.join(base, "appdata");
  mkdirSync(path.join(source, "comfy"), { recursive: true });
  mkdirSync(path.join(source, "comfy_extras"));
  for (const file of ["main.py", "requirements.txt", "comfy/__init__.py", "comfy_extras/__init__.py"]) writeFileSync(path.join(source, file), "");
  writeFileSync(path.join(source, "README.md"), "# Fixture ComfyUI\n");
  writeFileSync(path.join(source, "comfy", "options.py"), "def enable_args_parsing():\n    pass\n");
  writeFileSync(path.join(source, "comfy_extras", "nodes_qwen.py"), broken ? "raise RuntimeError('fixture import failed')\n" : `
from types import SimpleNamespace
class TextEncodeQwenImage21:
    @classmethod
    def define_schema(cls): return SimpleNamespace(node_id='TextEncodeQwenImage21')
    @classmethod
    def execute(cls, *args): raise RuntimeError('must not render')
class QwenImage21Cache:
    @classmethod
    def define_schema(cls): return SimpleNamespace(node_id='QwenImage21Cache')
class Extension:
    async def get_node_list(self): return [TextEncodeQwenImage21${missing ? "" : ", QwenImage21Cache"}]
async def comfy_entrypoint(): return Extension()
`);
  const archive = path.join(base, "comfy.tar.gz");
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-czf", archive, "-C", path.dirname(source), path.basename(source)]);
  const uv = keptUvPath(appData);
  mkdirSync(path.dirname(uv), { recursive: true });
  writeFileSync(uv, "fixture uv");
  writeFileSync(path.join(path.dirname(uv), "uv.json"), JSON.stringify({ version: UV_VERSION, sha256: uvPin().sha256 }));
  const original = path.join(base, "original-engine");
  mark(original, { complete: true, comfy: COMFY_TAG });
  writeFileSync(path.join(original, "keep.txt"), "original");
  const settings = JSON.stringify({ rig: original, python: "original python", modelsDir: "existing weights", comfyExtraArgs: ["--lowvram"], custom: { keep: true } });
  writeFileSync(path.join(appData, "settings.json"), settings);
  mkdirSync(path.join(`${root}-cache`, "pip"), { recursive: true });
  writeFileSync(path.join(`${root}-cache`, "pip", "keep.whl"), "cached wheel");
  if (incomplete) { mark(root, { complete: false, stageOnly: true }); writeFileSync(path.join(root, "old-attempt.txt"), "partial"); }
  const calls = path.join(base, "calls.jsonl");
  const environment = {
    AIPLAY_APPDATA: appData, AIPLAY_ENGINE_DIR: root,
    NODE_OPTIONS: `--require "${hook.replace(/\\/g, "/")}"`,
    FIXTURE_ARCHIVE: archive, FIXTURE_PYTHON: python, FIXTURE_CALLS: calls,
    FIXTURE_STUDIO_MISSING: studioMissing ? "1" : "0",
    FIXTURE_NVIDIA: nvidia ? "1" : "0", FIXTURE_RUNTIME_ERROR: runtimeError,
  };
  const verifyUntouched = () => {
    assert.equal(readFileSync(path.join(appData, "settings.json"), "utf8"), settings, "settings stay byte-identical");
    assert.equal(readFileSync(path.join(original, "keep.txt"), "utf8"), "original", "original engine is untouched");
    assert.equal(readFileSync(uv, "utf8"), "fixture uv", "kept installer stays");
  };
  if (defer) return { root, environment, verifyUntouched };
  const result = run(nvidia ? ["--backend", "nvidia", "--gpu-name", "NVIDIA GeForce RTX 4070", "--qwen-compatible", "--stage-only"] : stageArgs, environment);
  verifyUntouched();
  return { result, root, calls: readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

test("a staged success reports complete launch metadata, verifies real node imports and saves no settings", { skip: !python }, () => {
  const { result, root, calls } = fixture("success", { incomplete: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const done = record(result.stdout, "done");
  assert.equal(done.rig, root);
  assert.equal(done.python, path.join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
  assert.equal(done.stageOnly, true);
  assert.equal(done.comfy, QWEN_COMFY_TAG);
  assert.equal(done.backend, "cpu");
  assert.equal(done.torchBackend, "cpu");
  assert.equal(done.torchVersion, "2.9.0+cpu");
  assert.equal(done.torch, "2.9.0+cpu");
  assert.equal(done.gpu.vendor, "cpu");
  assert.deepEqual(done.comfyExtraArgs, process.platform === "darwin" ? [] : ["--cpu"]);
  assert.equal(done.engineInstall.comfy, QWEN_COMFY_TAG);
  assert.equal(done.engineInstall.studioPackages.ok, true);
  assert.equal(done.studio.ok, true);
  assert.deepEqual(done.qwenNodes, ["TextEncodeQwenImage21", "QwenImage21Cache"]);
  const receipt = JSON.parse(readFileSync(marker(root), "utf8"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.stageOnly, true);
  assert.equal(comfyPinNote(receipt), null, "the launcher recognizes the supported Qwen repair pin");
  assert.deepEqual(receipt.metadata, done, "completed stages can be reused after an activation failure");
  assert.ok(!existsSync(path.join(root, "old-attempt.txt")), "only the old incomplete stage was replaced");
  assert.ok(!existsSync(`${root}-cache`), "successful install removes its download cache");
  const quick = calls.findIndex(call => call.args.includes("--quick-test-for-ci"));
  const checked = calls.findIndex(call => call.args.some(arg => arg.includes("from comfy_extras.nodes_qwen import comfy_entrypoint")));
  assert.ok(quick >= 0 && checked > quick, "native nodes are imported after the normal quick test");
  assert.ok(calls[checked].args.some(arg => arg.includes("node.define_schema().node_id")), "the probe builds actual schemas");
});

test("NVIDIA staging constrains Comfy requirements and records the verified CUDA profile", { skip: !python }, () => {
  const { result, root, calls } = fixture("nvidia-runtime", { nvidia: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const constraint = path.join(root, "torch-constraints.txt");
  assert.equal(readFileSync(constraint, "utf8"), "torch==2.14.1+cu130\ntorchvision==0.29.1+cu130\ntorchaudio==2.11.0+cu130\n");
  const requirements = calls.find(call => call.args.includes("-r"));
  assert.equal(requirements.args[requirements.args.indexOf("-c") + 1], constraint);
  const install = calls.find(call => call.args.includes("torch==2.14.1+cu130"));
  assert.ok(install.args.includes("--index-url"));
  assert.ok(!install.args.includes("--extra-index-url"));
  const done = record(result.stdout, "done");
  assert.deepEqual(done.engineInstall.runtime, { python: "3.13.9", cuda: "13.0", capability: "8.9", driver: "591.74", profile: "cu130", smoke: true });
});

test("a CUDA kernel failure cannot activate a staged engine or blame a current driver", { skip: !python }, () => {
  const { result, root } = fixture("nvidia-runtime-failure", { nvidia: true, runtimeError: "RuntimeError: no kernel image is available for execution on the device" });
  assert.equal(result.status, 1);
  const failure = record(result.stdout, "error");
  assert.equal(failure.step, "verify");
  assert.match(failure.message, /no kernel image is available/);
  assert.match(failure.message, /Python:.*python/);
  assert.doesNotMatch(failure.message, /Update the driver|580-series minimum/);
  assert.equal(record(result.stdout, "done"), null);
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(`${root}-cache`), true);
});

for (const failure of ["missing", "broken"]) {
  test(`a ${failure} native Qwen extension fails the stage and keeps the download cache`, { skip: !python }, () => {
    const { result, root } = fixture(failure, { [failure]: true });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const error = record(result.stdout, "error");
    assert.equal(error.step, "qwen");
    assert.equal(error.cleaned, true);
    assert.match(error.message, failure === "missing" ? /Missing Qwen Image 2.1 nodes: QwenImage21Cache/ : /fixture import failed/);
    assert.equal(record(result.stdout, "done"), null);
    assert.ok(!existsSync(root), "only the incomplete stage is removed");
    assert.equal(readFileSync(path.join(`${root}-cache`, "pip", "keep.whl"), "utf8"), "cached wheel");
  });
}

test("Studio package failures keep a Qwen stage retryable with its download cache", { skip: !python }, () => {
  const { result, root } = fixture("missing-studio", { studioMissing: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const error = record(result.stdout, "error");
  assert.equal(error.step, "verify");
  assert.equal(error.cleaned, true);
  assert.match(error.message, /Studio packages did not import: cv2/);
  assert.equal(record(result.stdout, "done"), null);
  assert.ok(!existsSync(root), "there is no completed engine for the repair to reuse");
  assert.equal(readFileSync(path.join(`${root}-cache`, "pip", "keep.whl"), "utf8"), "cached wheel");
});

test("closing Studio's progress pipes lets the staged installer finish its marker", { skip: !python, timeout: 30_000 }, async () => {
  const { root, environment, verifyUntouched } = fixture("disconnected-parent", { defer: true });
  const child = spawn(process.execPath, [script, ...stageArgs], { windowsHide: true, env: { ...process.env, ...environment } });
  let disconnected = false;
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.once("data", () => {
    disconnected = true;
    child.stdout.destroy(); child.stderr.destroy();
  });
  const exit = await exited;
  assert.equal(disconnected, true, "parent closed the actual stdout/stderr pipes");
  assert.equal(exit.code, 0, `installer exited ${exit.code} (${exit.signal})`);
  const receipt = JSON.parse(readFileSync(marker(root), "utf8"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.metadata.stageOnly, true);
  assert.deepEqual(receipt.metadata.qwenNodes, ["TextEncodeQwenImage21", "QwenImage21Cache"]);
  verifyUntouched();
});
