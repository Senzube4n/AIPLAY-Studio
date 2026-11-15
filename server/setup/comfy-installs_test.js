import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { normalizeComfyRig, discoverComfyInstalls, pythonForComfy, listComfyInstalls, validateComfyInstall } from "./comfy-installs.js";

const run = promisify(execFile);
const temporary = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-comfy-choice-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const put = async (file, content = "") => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
const fixture = async (root, name, python = "ComfyUI/.venv/Scripts/python.exe") => {
  const rig = path.join(root, name);
  await put(path.join(rig, "ComfyUI", "main.py"));
  if (python) await put(path.join(rig, python));
  return rig;
};
const marker = (backend = "cpu") => `AIPLAY_TORCH:${JSON.stringify({ version: "2.9.0", backend })}\n`;

test("discovery names Desktop installs, excludes cloud and deduplicates direct/source paths", async (t) => {
  const root = await temporary(t);
  const desktop = path.join(root, "registry");
  const first = await fixture(root, "studio-one");
  const second = await fixture(root, "portable", "python_embeded/python.exe");
  await put(path.join(desktop, "installations.json"), JSON.stringify([
    { id: "older", name: "Music CPU", installPath: first, lastLaunchedAt: 12 },
    { id: "newer", name: "My AMD", installPath: second, lastLaunchedAt: 20 },
    { id: "duplicate", name: "Duplicate", installPath: path.join(first, "ComfyUI") },
    { id: "cloud", name: "Cloud", installPath: first, sourceId: "cloud" },
  ]));
  const found = await discoverComfyInstalls({ roots: [root, first, path.join(first, "ComfyUI")], desktopDir: desktop, savedRig: first });
  assert.deepEqual(found.map((entry) => entry.name), ["My AMD", "Music CPU"]);
  assert.deepEqual(found.map((entry) => entry.rig), [second, first]);
  assert.equal(await normalizeComfyRig(path.join(first, "ComfyUI")), first);
  assert.equal(await pythonForComfy(second), path.join(second, "python_embeded", "python.exe"));
});

test("all supported source/portable environment spellings are found", async (t) => {
  const root = await temporary(t);
  for (const [index, location] of [".venv/Scripts/python.exe", "ComfyUI/venv/bin/python3", "ComfyUI/.venv/bin/python",
    "venv/Scripts/python.exe", "python_embedded/python.exe"].entries()) {
    const rig = await fixture(root, `install-${index}`, location);
    assert.equal(await pythonForComfy(rig), path.join(rig, location));
  }
});

test("fast candidate listing checks presence without executing Python or changing settings", async (t) => {
  const root = await temporary(t);
  const ready = await fixture(root, "source");
  await fixture(root, "uninitialized", null);
  const settings = path.join(root, "settings.json");
  await put(settings, '{"rig":"unchanged"}');
  const entries = await listComfyInstalls({ roots: [root], desktopDir: path.join(root, "empty"), validate: false,
    validation: { execute: () => assert.fail("quick listing must not execute Python") } });
  assert.equal(entries.find((entry) => entry.rig === ready).valid, null);
  assert.match(entries.find((entry) => entry.rig !== ready).error, /No Python environment/);
  assert.equal(await readFile(settings, "utf8"), '{"rig":"unchanged"}');
});

test("validation executes a bounded child and accepts CPU, CUDA, ROCm and XPU", async (t) => {
  const root = await temporary(t);
  const rig = await fixture(root, "portable");
  for (const backend of ["cpu", "cuda", "rocm", "xpu"]) {
    const checked = await validateComfyInstall(rig, { execute: async (python, args, options) => {
      assert.equal(python, path.join(rig, "ComfyUI", ".venv", "Scripts", "python.exe"));
      assert.deepEqual(args.slice(0, 2), ["-s", "-c"]);
      assert.match(args[2], /import json,torch/);
      assert.equal(options.timeout, 45_000);
      assert.equal(options.cwd, path.join(rig, "ComfyUI"));
      return run(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(marker(backend))})`], options);
    } });
    assert.equal(checked.valid, true);
    assert.equal(checked.torchBackend, backend);
  }
});

test("broken imports and bounded process timeouts remain invalid", async (t) => {
  const root = await temporary(t);
  const rig = await fixture(root, "broken");
  const failed = await validateComfyInstall(rig, { execute: (_python, _args, options) =>
    run(process.execPath, ["-e", "process.stderr.write('ImportError: torch missing');process.exit(1)"], options) });
  assert.equal(failed.valid, false);
  assert.match(failed.error, /torch missing/);
  const timed = await validateComfyInstall(rig, { timeout: 100, execute: (_python, _args, options) =>
    run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], options) });
  assert.equal(timed.valid, false);
  assert.match(timed.error, /timed out/);
});

test("explicit setup selection cannot replace working settings with a missing environment", async (t) => {
  const root = await temporary(t);
  const rig = await fixture(root, "no-python", null);
  const profile = path.join(root, "profile");
  const settings = path.join(profile, "settings.json");
  const before = JSON.stringify({ rig: "working engine", python: "working python", launcherAutoLaunch: "music" });
  await put(settings, before);
  let result;
  try {
    result = await run(process.execPath, [fileURLToPath(new URL("../../scripts/setup.mjs", import.meta.url)), "--json", "--select-rig", rig],
      { env: { ...process.env, AIPLAY_APPDATA: profile, APPDATA: root, LOCALAPPDATA: root }, timeout: 5000 });
    assert.fail("invalid setup must fail");
  } catch (error) { result = error; }
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.ok, false);
  assert.match(report.error, /No Python environment/);
  assert.equal(await readFile(settings, "utf8"), before);
});
