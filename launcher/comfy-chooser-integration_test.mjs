/** The real launcher, HTTP routes and Python subprocess, using disposable venvs.
 * No ComfyUI, PyTorch, models or GPU are required. Set AIPLAY_TEST_PYTHON to a
 * Python 3 executable when it is not on PATH; the suite skips if none is found.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (left, right) => process.platform === "win32"
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

async function findPython() {
  for (const command of [...new Set([process.env.AIPLAY_TEST_PYTHON, process.env.PYTHON, "python3", "python"].filter(Boolean))]) {
    try {
      const { stdout } = await run(command, ["-c", "import sys; assert sys.version_info.major == 3; print(sys.executable)"],
        { timeout: 8_000, windowsHide: true });
      if (stdout.trim()) return stdout.trim();
    } catch { /* An absent command or the Windows Store alias is not Python. */ }
  }
  return null;
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function waitUntil(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(40);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test("HTTP chooser validates Python, saves the chosen rig and rejects unsafe or invalid changes", { timeout: 120_000 }, async (t) => {
  const python = await findPython();
  if (!python) return t.skip("Python 3 is unavailable; set AIPLAY_TEST_PYTHON to run the subprocess integration test.");

  const fixture = await mkdtemp(path.join(tmpdir(), "aiplay-comfy-http-"));
  let child;
  let launcherUrl;
  let externalStudio = false;
  let output = "";
  const engineServer = http.createServer((_req, res) => {
    res.writeHead(externalStudio ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(externalStudio ? { engine: { ready: true }, config: { engineExpected: true } } : { error: "idle fixture" }));
  });
  t.after(async () => {
    if (child && child.exitCode === null) {
      const closed = once(child, "close");
      if (launcherUrl) await fetch(`${launcherUrl}api/quit`, { method: "POST", signal: AbortSignal.timeout(2_000) }).catch(() => {});
      const forced = setTimeout(() => child.kill(), 3_000);
      try { await closed; } finally { clearTimeout(forced); }
    }
    engineServer.closeAllConnections?.();
    if (engineServer.listening) await new Promise((resolve) => engineServer.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  });

  const home = path.join(fixture, "home");
  const roaming = path.join(home, "AppData", "Roaming");
  const local = path.join(home, "AppData", "Local");
  const appdata = path.join(fixture, "studio-settings");
  const scratch = path.join(fixture, "temp");
  await Promise.all([home, roaming, local, appdata, scratch].map((dir) => mkdir(dir, { recursive: true })));

  const rigs = Object.fromEntries(["initial", "chosen", "broken", "missing"].map((name) => [name, path.join(fixture, name)]));
  const sourceRig = path.join(fixture, "source");
  await Promise.all([...Object.values(rigs), sourceRig].map(async (rig) => {
    await mkdir(path.join(rig, "ComfyUI"), { recursive: true });
    await writeFile(path.join(rig, "ComfyUI", "main.py"), "# Fixture backend. Never executed.\n");
  }));
  const baseEnv = { ...process.env, TEMP: scratch, TMP: scratch };
  delete baseEnv.PYTHONHOME;
  delete baseEnv.PYTHONPATH;
  await Promise.all([rigs.initial, rigs.chosen, rigs.broken, sourceRig].map((rig) => run(python,
    ["-m", "venv", "--without-pip", path.join(rig, "ComfyUI", ".venv")],
    { env: baseEnv, timeout: 30_000, windowsHide: true })));

  const torchModule = "class _Version:\n    cuda = None\n    hip = None\nversion = _Version()\n__version__ = '0.0.fixture+cpu'\n";
  const importMarker = path.join(rigs.chosen, "import-started");
  await writeFile(path.join(rigs.initial, "ComfyUI", "torch.py"), torchModule);
  await writeFile(path.join(sourceRig, "ComfyUI", "torch.py"), torchModule);
  await writeFile(path.join(rigs.chosen, "ComfyUI", "torch.py"),
    `import pathlib, time\npathlib.Path(${JSON.stringify(importMarker)}).write_text('checking')\ntime.sleep(1)\n${torchModule}`);
  await writeFile(path.join(rigs.broken, "ComfyUI", "torch.py"), "raise ImportError('fixture PyTorch import failed')\n");
  const pythonFor = (rig) => path.join(rig, "ComfyUI", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

  const desktop = path.join(roaming, "Comfy Desktop");
  await mkdir(desktop, { recursive: true });
  await writeFile(path.join(desktop, "installations.json"), JSON.stringify(Object.entries(rigs).map(([name, rig], index) => ({
    id: name, name: `${name} fixture`, sourceId: "standalone", installPath: rig, lastLaunchedAt: index,
  }))));
  const settingsPath = path.join(appdata, "settings.json");
  const preference = { keep: "unchanged", nested: { enabled: true } };
  await writeFile(settingsPath, JSON.stringify({
    rig: rigs.initial, python: pythonFor(rigs.initial), gpu: { vendor: "intel", name: "fixture", totalMb: 0 },
    torchBackend: "cpu", torchVersion: "0.0.fixture+cpu", launcherCloseStopsStudio: true,
    modelsDirPinned: true, modelsDir: path.join(fixture, "my-models"), fixturePreference: preference,
  }, null, 2));

  await new Promise((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) if (key.startsWith("AIPLAY_")) delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
    AIPLAY_APPDATA: appdata, AIPLAY_COMFY_SEARCH_ROOTS: JSON.stringify([fixture]), AIPLAY_LAUNCHER_NO_WINDOW: "1",
    AIPLAY_LAUNCHER_PORT: "0", AIPLAY_UI_PORT: String(engineServer.address().port),
  });
  child = spawn(process.execPath, [path.join(root, "launcher", "launcher.mjs")],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (err) => { output += `\n${err.message}`; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
    output = (output + data).slice(-64_000);
    launcherUrl ||= output.match(/launcher: (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
  });
  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(`Launcher exited with ${child.exitCode}: ${output}`);
    return !!launcherUrl;
  }, "headless launcher startup");

  const request = async (endpoint, body, headers = {}) => {
    const response = await fetch(`${launcherUrl}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: launcherUrl.slice(0, -1) }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000),
    });
    return { status: response.status, body: await response.json() };
  };

  // Finish the launcher's warm startup check before testing byte-identical failures.
  assert.equal((await request("api/check")).status, 200, output);

  await t.test("discovery sends named candidates without importing every Python environment", async () => {
    const listed = await request("api/comfy-installs");
    assert.equal(listed.status, 200);
    assert.ok(samePath(listed.body.selectedRig, rigs.initial));
    for (const [name, rig] of Object.entries(rigs)) {
      const entry = listed.body.installs.find((item) => samePath(item.rig, rig));
      assert.ok(entry, `${name} is listed`);
      assert.equal(entry.name, `${name} fixture`);
      assert.equal(entry.valid, name === "missing" ? false : null);
    }
    assert.equal(await exists(importMarker), false, "listing does not import the slow fixture's torch");
  });

  await t.test("cross-origin and invalid selections leave settings byte-identical", async () => {
    const before = await readFile(settingsPath, "utf8");
    const refused = await request("api/comfy-install", { rig: rigs.chosen }, { Origin: "https://untrusted.invalid" });
    assert.equal(refused.status, 403);
    for (const rig of [path.join(fixture, "absent"), rigs.missing, rigs.broken]) {
      const result = await request("api/comfy-install", { rig });
      assert.ok(result.body.error, `selection of ${rig} must fail`);
      assert.equal(await readFile(settingsPath, "utf8"), before);
    }
  });

  await t.test("selection normalizes the ComfyUI path, preserves preferences and blocks launch during validation", async () => {
    const selecting = request("api/comfy-install", { rig: path.join(rigs.chosen, "ComfyUI") });
    await waitUntil(() => exists(importMarker), "the selected Python import");
    const launching = await request("api/launch", { mode: "full" });
    await waitUntil(async () => {
      const state = (await request("api/state")).body.studio;
      return /selection to finish/i.test(launching.body.error || state.error || "");
    }, "launch refusal during selection");
    assert.equal((await request("api/state")).body.studio.pid, null, "no Studio process starts during validation");
    const selected = await selecting;
    assert.equal(selected.status, 200);
    assert.equal(selected.body.ok, true, JSON.stringify(selected.body));
    assert.ok(samePath(selected.body.rig, rigs.chosen));
    assert.ok(samePath(selected.body.python, pythonFor(rigs.chosen)));
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(samePath(saved.rig, rigs.chosen));
    assert.ok(samePath(saved.python, pythonFor(rigs.chosen)));
    assert.equal(saved.torchBackend, "cpu");
    assert.equal(saved.torchVersion, "0.0.fixture+cpu");
    assert.equal(saved.launcherCloseStopsStudio, true);
    assert.equal(saved.modelsDirPinned, true);
    assert.equal(saved.modelsDir, path.join(fixture, "my-models"));
    assert.deepEqual(saved.fixturePreference, preference);
  });

  await t.test("an externally running Studio blocks selection without saving", async () => {
    const before = await readFile(settingsPath, "utf8");
    externalStudio = true;
    try {
      const refused = await request("api/comfy-install", { rig: rigs.initial });
      assert.match(refused.body.error || "", /Studio running outside/i);
      assert.equal(await readFile(settingsPath, "utf8"), before);
    } finally { externalStudio = false; }
  });

  await t.test("manual flags survive an engine switch while an unpinned model directory is cleared", async () => {
    const previous = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, JSON.stringify({ ...previous,
      launchFlagsSync: false, comfyExtraArgs: ["--cpu"], launchFrom: "old installation",
      modelsDirPinned: false, modelsDir: path.join(fixture, "old-engine-models"),
    }, null, 2));
    const selected = await request("api/comfy-install", { rig: sourceRig });
    assert.equal(selected.body.ok, true, JSON.stringify(selected.body));
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(samePath(saved.rig, sourceRig));
    assert.ok(samePath(saved.python, pythonFor(sourceRig)));
    assert.equal(saved.launchFlagsSync, false);
    assert.deepEqual(saved.comfyExtraArgs, ["--cpu"], "explicit manual flags still belong to the user");
    assert.equal("modelsDir" in saved, false, "the previous engine's unpinned model directory is discarded");
    assert.equal("launchFrom" in saved, false, "the previous engine's launcher provenance is discarded");
    assert.deepEqual(saved.fixturePreference, preference);
  });

  await t.test("conflicting environment overrides fail before changing the saved installation", async () => {
    const before = await readFile(settingsPath, "utf8");
    for (const [key, value] of [["AIPLAY_RIG", rigs.initial], ["AIPLAY_PYTHON", pythonFor(rigs.initial)]]) {
      await assert.rejects(run(process.execPath, [path.join(root, "scripts", "setup.mjs"),
        "--json", "--select-rig", sourceRig], { cwd: root, env: { ...env, [key]: value }, timeout: 15_000, windowsHide: true }), (error) => {
        const report = JSON.parse(String(error.stdout).trim().split(/\r?\n/).at(-1));
        assert.equal(report.ok, false);
        assert.match(report.error, new RegExp(`${key} overrides`));
        return true;
      });
      assert.equal(await readFile(settingsPath, "utf8"), before);
    }
  });
});
