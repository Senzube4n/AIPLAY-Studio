/**
 * THE STEM SEPARATION PYTHON AS A SETTING — server/config.js systemPython(),
 * after Tika's report of 2026-09-24: the only ways to name the interpreter
 * demucs runs in were an environment variable and the Python310 default, so
 * the Models row's "pip install demucs" went into whatever python was on PATH.
 *
 *   §1 the order: AIPLAY_SYS_PYTHON, then the saved choice, then Python310,
 *      and the source flag that says which (Settings shows it)
 *   §2 what may be saved: an absolute one-line path or null; the device is
 *      null or "cpu"; both are in the snapshot settings.json is written from
 *   §3 end to end, in a fresh process per case: a settings.json with a saved
 *      choice is what config.systemPython runs at boot, the environment still
 *      wins, and a bad saved value is dropped with the default kept
 *
 *   node server/system-python_test.js
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

const envWas = process.env.AIPLAY_SYS_PYTHON;
delete process.env.AIPLAY_SYS_PYTHON;
const { config, systemPython, systemPythonSource, defaultSystemPython, PREF_PATHS, prefsSnapshot } = await import("./config.js");

console.log("\n§1  THE ORDER, AND WHICH ONE WON");
{
  const def = defaultSystemPython();
  ok("the default is python.org's per-user 3.10 (the literal Studio always had)",
    def === path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python310", "python.exe"), def);
  const mine = path.join(os.tmpdir(), "my-venv", "Scripts", "python.exe");
  ok("nothing chosen, no variable: the default, source \"default\"", systemPython(null) === def && systemPythonSource(null) === "default");
  ok("a saved choice beats the default, source \"saved\"", systemPython(mine) === mine && systemPythonSource(mine) === "saved");
  process.env.AIPLAY_SYS_PYTHON = path.join(os.tmpdir(), "env", "python.exe");
  ok("AIPLAY_SYS_PYTHON beats a saved choice, source \"env\"",
    systemPython(mine) === process.env.AIPLAY_SYS_PYTHON && systemPythonSource(mine) === "env");
  delete process.env.AIPLAY_SYS_PYTHON;
  const was = config.stems.systemPython;
  config.stems.systemPython = mine;
  ok("with no argument both read config.stems.systemPython (what Settings and the stems setup write)",
    systemPython() === mine && systemPythonSource() === "saved");
  config.stems.systemPython = was;
  ok("config.stems starts with no choice and no device", "systemPython" in config.stems && "device" in config.stems);
}

console.log("\n§2  WHAT MAY BE SAVED");
{
  const rule = (k) => PREF_PATHS.find(([g, key]) => g === "stems" && key === k)?.[2];
  const py = rule("systemPython"), dev = rule("device");
  ok("stems.systemPython and stems.device are remembered settings", typeof py === "function" && typeof dev === "function");
  const abs = process.platform === "win32" ? "C:\\Tools\\py\\python.exe" : "/opt/py/bin/python";
  ok("the path: null or an absolute one-line path only", py(null) && py(abs) && !py("python") && !py("rel\\python.exe")
    && !py(`${abs}\nrm -rf /`) && !py("") && !py(42), "validator disagrees");
  ok("the device: null or \"cpu\" only", dev(null) && dev("cpu") && !dev("cuda") && !dev("") && !dev(true));
  const devPy = rule("devicePython");
  ok("the python the device was measured on: null or an absolute one-line path, like the choice itself",
    typeof devPy === "function" && devPy(null) && devPy(abs) && !devPy("python") && !devPy(`${abs}\nx`));
  const snap = prefsSnapshot();
  ok("all three are in the snapshot settings.json is written from",
    "systemPython" in (snap.stems || {}) && "device" in (snap.stems || {}) && "devicePython" in (snap.stems || {}), JSON.stringify(snap.stems));
}

console.log("\n§3  END TO END, A FRESH PROCESS PER CASE");
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-syspy-"));
  const chosen = process.platform === "win32" ? "C:\\Chosen\\venv\\Scripts\\python.exe" : "/chosen/venv/bin/python";
  const boot = (prefs, env = {}) => {
    const dir = mkdtempSync(path.join(tmp, "case-"));
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ prefs }));
    const e = { ...process.env, AIPLAY_APPDATA: dir, ...env };
    if (!("AIPLAY_SYS_PYTHON" in env)) delete e.AIPLAY_SYS_PYTHON;
    const code = `import(${JSON.stringify(pathToFileURL(path.join(HERE, "config.js")).href)})`
      + ".then((m) => console.log(JSON.stringify({ py: m.config.systemPython, src: m.systemPythonSource(), device: m.config.stems.device, devicePython: m.config.stems.devicePython })))";
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: e, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/).pop());
  };
  const saved = boot({ stems: { systemPython: chosen, device: "cpu", devicePython: chosen } });
  ok("a saved choice is what config.systemPython runs at boot, and the saved device comes back with the python it was measured on",
    saved.py === chosen && saved.src === "saved" && saved.device === "cpu" && saved.devicePython === chosen, JSON.stringify(saved));
  const envPy = process.platform === "win32" ? "C:\\Env\\python.exe" : "/env/python";
  const env = boot({ stems: { systemPython: chosen } }, { AIPLAY_SYS_PYTHON: envPy });
  ok("AIPLAY_SYS_PYTHON still wins over it", env.py === envPy && env.src === "env", JSON.stringify(env));
  const bad = boot({ stems: { systemPython: "python", device: "cuda" } });
  ok("a bad saved value is dropped: the default runs, and the device stays null",
    bad.py === defaultSystemPython() && bad.src === "default" && bad.device === null, JSON.stringify(bad));
  rmSync(tmp, { recursive: true, force: true });
}

if (envWas !== undefined) process.env.AIPLAY_SYS_PYTHON = envWas;
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
