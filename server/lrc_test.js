/**
 * Timed lyrics: every failure names its cause, the GPU falls back to the CPU,
 * the script path survives a folder with a space in it, and the commands a
 * person is told to paste run in Command Prompt AND PowerShell. No GPU, no model.
 *
 * THE REPORT. A new user installed faster-whisper "via python", pressed "Time
 * the lyrics" and got "alignment failed". art.js kept only lrc.py's stdout, so
 * a missing interpreter (spawn ENOENT), an unopenable script (the installer's
 * default folder "AIPLAY Studio" percent-encoded to "AIPLAY%20Studio"), a
 * native cuDNN abort and a traceback outside lrc.py's try block all became
 * those same two words.
 *
 * THE REVIEW of the first fix found eleven more, each pinned below: install
 * lines PowerShell cannot parse; "setx, then restart Studio" while the launcher
 * kept its old environment (so the whisper python is now also a SETTING); a
 * Windows-only default on Linux; a huggingface warning outranking a cuDNN
 * abort; "Authorization: Bearer" tokens and lrc.py's own JSON error unmasked;
 * the CPU retry holding the CUDA model inside an except block; a CPU re-run
 * for runs that never touched the GPU; mcp.js comparing a percent-encoded URL
 * with a path; docs that still showed only the generic pip line; a Models
 * screen that said Ready without stable_whisper; and torch==2.5.1.
 *
 * HOW THIS PROVES IT WITHOUT A GPU.
 *   1. The node side (server/lrc.js) is driven with STUB interpreters: node
 *      itself, running small scripts that print a known stderr and exit the
 *      way the real failure does (exit 2, exit 1 with a traceback, 0xC0000409
 *      for a native abort). Each message is pinned.
 *   2. The real ArtRunner runs a real "lrc" job with the whisper python (from
 *      the SAVED SETTING) pointed at a path that does not exist.
 *   3. The real lrc.py runs under whatever python is here, with FAKE
 *      stable_whisper and ctranslate2 modules first on PYTHONPATH, so the device
 *      choice, the CPU fallback, the uncatchable abort and every JSON error are
 *      exercised with no torch, no whisper and CUDA_VISIBLE_DEVICES=-1. Skipped
 *      (loudly) only where no python runs at all.
 *   4. The install lines are run for real in cmd.exe and powershell.exe (on
 *      Windows), against node.exe copied into a folder with a space as
 *      python.exe, answering --version.
 *   5. Source sweeps: no module path in server/ or scripts/ is built from
 *      `import.meta.url` text, and no message pins an old torch.
 *
 *   node server/lrc_test.js
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lrc-test-"));
// Removed however the run ends: a throw before the last line used to leave it,
// two ~80 MB node.exe copies included.
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const WIN = process.platform === "win32";

/* config.js reads settings.json once, at first import — so every server
 * import below is dynamic, after it is written (the order art_cache_test.js
 * keeps). The whisper python comes from the SAVED SETTING, not from
 * AIPLAY_WHISPER_PYTHON: that is the road a person without an environment
 * variable takes, and the one the report needed. A developer's own variable is
 * removed so it cannot leak in. The folder has a space on purpose: every
 * command below must survive one. */
const NO_PYTHON = path.join(TMP, "Zoe van Dam", "aiplay-whisper", "venv", "Scripts", "python.exe");
for (const k of Object.keys(process.env)) if (/^AIPLAY_WHISPER_PYTHON$/i.test(k)) delete process.env[k];
process.env.AIPLAY_OUTPUT = path.join(TMP, "output");
process.env.AIPLAY_APPDATA = path.join(TMP, "appdata");
fs.mkdirSync(process.env.AIPLAY_OUTPUT, { recursive: true });
fs.mkdirSync(process.env.AIPLAY_APPDATA, { recursive: true });
fs.writeFileSync(path.join(process.env.AIPLAY_APPDATA, "settings.json"),
  JSON.stringify({ prefs: { lyrics: { whisperPython: NO_PYTHON } } }));

const { config, prefsSnapshot, defaultWhisperPython } = await import("./config.js");
const { CATALOG, modulesOf } = await import("./models.js");
const lrc = await import("./lrc.js");
const { runLrc, explainFailure, parseResult, stderrTail, missingPythonMessage, whisperPythonMissing,
  besideModule, LRC_SCRIPT, runLines, installLines, installBlock, TORCH_PIP, whisperPip, mask,
  lastDevice, pythonVerdict, SETTING_WORDS, ENV_RESTART, PYTHON_MIN } = lrc;

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${String(detail).slice(0, 900)}` : ""}`); }
}
const quiet = () => {};
const NEVER = "alignment failed";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const LYRICS = CATALOG.find((c) => c.id === "lyrics");
/** A line a person would paste that starts with a quoted program: the form
 *  PowerShell refuses ("The '--' operator works only on variables"). */
const quotedProgram = (text) => String(text || "").split(/\r?\n/).filter((l) => /^\s*"[^"]+"\s+-/.test(l));

/** A stub "python": node running `body`. argv[2] is where lrc.py would be. */
function stub(name, body) {
  const f = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(f, body);
  return f;
}
async function failWith(opts) {
  try { await runLrc({ log: quiet, model: "large-v3", args: ["song.flac", "lyr.txt", "out"], ...opts }); return null; }
  catch (err) { return String(err.message || err); }
}
/** config.js in a child process: its own settings.json, environment and,
 *  optionally, a process.platform the child reports (preloaded before config). */
function configIn({ settings = {}, env = {}, platform = null } = {}) {
  const appdata = fs.mkdtempSync(path.join(TMP, "appdata-"));
  fs.writeFileSync(path.join(appdata, "settings.json"), JSON.stringify(settings));
  const args = [];
  if (platform) {
    const pre = path.join(appdata, "platform.mjs");
    fs.writeFileSync(pre, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`);
    args.push("--import", pathToFileURL(pre).href);
  }
  const probe = path.join(appdata, "probe.mjs");
  fs.writeFileSync(probe, `const { config } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, "config.js")).href)});\n`
    + `console.log(JSON.stringify({ python: config.lyrics.python, whisperPython: config.lyrics.whisperPython }));\n`);
  const childEnv = { ...process.env, AIPLAY_APPDATA: appdata, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  const r = spawnSync(process.execPath, [...args, probe], { encoding: "utf8", env: childEnv, windowsHide: true });
  try { return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { return { error: r.stdout + r.stderr }; }
}

console.log("\nlrc — timed lyrics say why they failed\n");

/* ═══ 0. which python, and where that came from ════════════════════════ */
console.log("  -- the whisper python: default, Settings, environment --");
{
  ok("config.lyrics.python came from the SAVED SETTING (prefs.lyrics.whisperPython), no variable set",
    config.lyrics.python === NO_PYTHON && config.lyrics.whisperPython === NO_PYTHON, JSON.stringify(config.lyrics));
  ok("  and the next save keeps it (prefsSnapshot carries lyrics.whisperPython)",
    prefsSnapshot().lyrics?.whisperPython === NO_PYTHON, JSON.stringify(prefsSnapshot().lyrics));
  const envPy = path.join(TMP, "from-env", "python.exe");
  const both = configIn({ settings: { prefs: { lyrics: { whisperPython: NO_PYTHON } } }, env: { AIPLAY_WHISPER_PYTHON: envPy } });
  ok("AIPLAY_WHISPER_PYTHON still wins over the saved setting (as every env path in config.js does)",
    both.python === envPy && both.whisperPython === NO_PYTHON, JSON.stringify(both));
  const bad = configIn({ settings: { prefs: { lyrics: { whisperPython: "venv\\python.exe" } } }, env: { AIPLAY_WHISPER_PYTHON: undefined } });
  ok("a saved relative path is refused at boot and the default runs",
    bad.whisperPython === null && bad.python === defaultWhisperPython(), JSON.stringify(bad));
  const none = configIn({ env: { AIPLAY_WHISPER_PYTHON: undefined } });
  ok("with neither, the default venv", none.python === defaultWhisperPython() && none.whisperPython === null, JSON.stringify(none));

  // Linux: the venv keeps its python in bin/, and a Scripts\python.exe there is a path nobody can create.
  ok("defaultWhisperPython on Linux is <home>/aiplay-whisper/venv/bin/python",
    defaultWhisperPython("linux", "/home/zoe") === "/home/zoe/aiplay-whisper/venv/bin/python", defaultWhisperPython("linux", "/home/zoe"));
  ok("  and on Windows <home>\\aiplay-whisper\\venv\\Scripts\\python.exe",
    defaultWhisperPython("win32", "C:\\Users\\Zoë") === "C:\\Users\\Zoë\\aiplay-whisper\\venv\\Scripts\\python.exe", defaultWhisperPython("win32", "C:\\Users\\Zoë"));
  const linux = configIn({ platform: "linux", env: { AIPLAY_WHISPER_PYTHON: undefined } });
  ok("  config.js itself uses it: with process.platform 'linux' the default ends in venv/bin/python",
    /aiplay-whisper\/venv\/bin\/python$/.test(linux.python || ""), JSON.stringify(linux));
  const lx = missingPythonMessage("/home/zoe/aiplay-whisper/venv/bin/python", { platform: "linux", env: false });
  ok("  and the Linux message names <venv>/bin/python, python3 -m venv, and no Scripts\\python.exe",
    lx.includes("/home/zoe/aiplay-whisper/venv/bin/python -m pip install faster-whisper stable-ts")
      && lx.includes('python3 -m venv "/home/zoe/aiplay-whisper/venv"') && !/Scripts|python\.exe/.test(lx), lx);
}

/* ═══ 1. the script path, and every path built from import.meta.url ═════ */
console.log("\n  -- the script path --");
{
  ok("LRC_SCRIPT is the lrc.py beside lrc.js", LRC_SCRIPT === path.join(HERE, "lrc.py"), LRC_SCRIPT);
  ok("and it exists", fs.existsSync(LRC_SCRIPT), LRC_SCRIPT);
  ok("and nothing in it is percent-encoded", !LRC_SCRIPT.includes("%"), LRC_SCRIPT);

  /* The folders the diagnosis measured: the installer default (a space), a
   * Dutch account name with ë, a Dutch OneDrive folder. */
  for (const dir of [
    path.join(TMP, "Programs", "AIPLAY Studio", "server"),
    path.join(TMP, "Users", "Zoë", "AIPLAY-Studio-main", "server"),
    path.join(TMP, "OneDrive - Persoonlijk", "AIPLAY", "server"),
  ]) {
    const url = pathToFileURL(path.join(dir, "art.js")).href;
    const got = besideModule(url, "lrc.py");
    const where = path.relative(TMP, path.dirname(dir));
    ok(`besideModule keeps "${where}" as written`, got === path.join(dir, "lrc.py"), got);
    const old = path.join(path.dirname(new URL(url).pathname.slice(1)), "lrc.py");
    ok(`  (the old idiom did not: ${path.relative(TMP, path.dirname(path.dirname(old)))})`, old !== got, old);
  }

  /* THE SWEEP. The repo already knew the rule — yue.js and mesh/runner.js say
   * "fileURLToPath, not new URL().pathname" — and eleven sites still broke it,
   * because nothing checked anywhere but one DRIVER constant. The review found
   * the same mistake in two more shapes: comparing import.meta.url's TEXT with
   * a path, by endsWith/startsWith or against a hand-built `file:` string. All
   * three are URL text standing in for a path. */
  const IDIOMS = [
    /import\.meta\.url\s*\)\s*\.pathname/,
    /import\.meta\.url\.(?:endsWith|startsWith)\(/,
    /===\s*`file:/,
  ];
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name)) {
        fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((l, i) => {
          if (IDIOMS.some((re) => re.test(l))) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
        });
      }
    }
  };
  walk(path.join(ROOT, "server"));
  walk(path.join(ROOT, "scripts"));
  ok("no file in server/ or scripts/ treats import.meta.url's text as a path",
    offenders.length === 0, offenders.join("\n          "));

  /* mcp.js decides "run directly" (and so whether it reads stdin at all) with
   * one expression. That exact expression runs here as the MAIN module from a
   * folder with a space and an ë, and as an imported one; the old test is run
   * beside it from the same folder, so this proves the folder breaks the old
   * one and not the new one. */
  const expr = /const RUN_DIRECTLY = ([\s\S]*?);\n/.exec(read("server/mcp.js"))?.[1] || "";
  const oldExpr = "!!process.argv[1] && import.meta.url" + ".endsWith(process.argv[1].split(path.sep).join(\"/\"))";
  const dir = path.join(TMP, "AIPLAY Studio Zoë", "server");
  fs.mkdirSync(dir, { recursive: true });
  const head = 'import path from "node:path";\nimport { fileURLToPath } from "node:url";\nimport { realpathSync } from "node:fs";\n';
  fs.writeFileSync(path.join(dir, "new.mjs"), `${head}console.log("new=" + (${expr}));\n`);
  fs.writeFileSync(path.join(dir, "old.mjs"), `${head}console.log("old=" + (${oldExpr}));\n`);
  fs.writeFileSync(path.join(dir, "importer.mjs"), 'await import("./new.mjs");\n');
  const run = (f, from = dir) => spawnSync(process.execPath, [path.join(from, f)], { encoding: "utf8", windowsHide: true }).stdout.trim();
  ok("mcp.js's RUN_DIRECTLY compares REAL paths (realpath of fileURLToPath vs realpath of path.resolve)",
    /realpathSync\(fileURLToPath\(import\.meta\.url\)\) === realpathSync\(path\.resolve\(process\.argv\[1\]\)\)/.test(expr), expr);
  ok("  run from 'AIPLAY Studio Zoë' it is true", run("new.mjs") === "new=true", run("new.mjs"));
  ok("  imported by another main module it is false", run("importer.mjs") === "new=false", run("importer.mjs"));
  ok("  (the old URL-text test is false there: the folder really does break it)", run("old.mjs") === "old=false", run("old.mjs"));
  /* Reached through a junction (a symlink off Windows): Node realpaths the main
   * module, so import.meta.url names the target while argv[1] names the link.
   * Compared without realpath, this was false and the server never read stdin. */
  const link = path.join(TMP, "StudioLink");
  let linked = false;
  try { fs.symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir"); linked = true; } catch { /* no links here */ }
  if (linked) ok("  run through a junction or symlink to that folder it is true", run("new.mjs", link) === "new=true", run("new.mjs", link));
  else console.log("  (skipped: this machine cannot make a junction or symlink in the temp folder)");

  // models_table.mjs had the same test; --check must still find its three documents.
  const mt = spawnSync(process.execPath, [path.join(ROOT, "scripts", "models_table.mjs"), "--check"], { encoding: "utf8", windowsHide: true, cwd: ROOT });
  ok("scripts/models_table.mjs --check still runs as main and finds all three documents",
    mt.status === 0 && (mt.stdout.match(/matches the catalogue/g) || []).length === 3, mt.stdout + mt.stderr);
}

/* ═══ 2. the lines a person pastes ═════════════════════════════════════ */
console.log("\n  -- the install lines: one builder, both shells, the verified set --");
{
  ok("the catalogue's install line installs stable-ts too (lrc.py imports stable_whisper)",
    /\bfaster-whisper\b/.test(LYRICS.packageInstall) && /\bstable-ts\b/.test(LYRICS.packageInstall), LYRICS.packageInstall);
  ok("whisperPip() is that line without its python", `python ${whisperPip()}` === LYRICS.packageInstall, whisperPip());
  ok("the torch line is the verified one, unpinned, cu126",
    TORCH_PIP === "-m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu126", TORCH_PIP);
  ok("the Python floor is the verified one", PYTHON_MIN === "Python 3.11 or newer", PYTHON_MIN);

  const plain = "C:\\Users\\Zoe\\aiplay-whisper\\venv\\Scripts\\python.exe";
  const spaced = "C:\\Users\\Zoe van Dam\\aiplay-whisper\\venv\\Scripts\\python.exe";
  ok("Windows, no space: the path bare, which cmd and PowerShell both run",
    JSON.stringify(runLines(plain, ["--version"], { platform: "win32" })) === JSON.stringify([`${plain} --version`]),
    runLines(plain, ["--version"], { platform: "win32" }).join(" | "));
  ok("Windows, a space: pushd \"<folder>\" then .\\python.exe (never a quoted program)",
    JSON.stringify(runLines(spaced, ["--version"], { platform: "win32" }))
      === JSON.stringify([`pushd "${path.win32.dirname(spaced)}"`, ".\\python.exe --version"]),
    runLines(spaced, ["--version"], { platform: "win32" }).join(" | "));
  ok("  and a PowerShell operator character is treated like a space (an & in a user name)",
    runLines("C:\\Users\\A&B\\venv\\Scripts\\python.exe", ["x"], { platform: "win32" })[0].startsWith("pushd "));
  ok("POSIX: a path with a space is single-quoted, one without is bare",
    runLines("/home/zoe van dam/v/bin/python", ["x"], { platform: "linux" })[0] === "'/home/zoe van dam/v/bin/python' x"
      && runLines("/home/zoe/v/bin/python", ["x"], { platform: "linux" })[0] === "/home/zoe/v/bin/python x");
  const lines = installLines(spaced, { platform: "win32", create: true });
  ok("installLines: venv, CUDA torch, then faster-whisper and stable-ts, in that order",
    JSON.stringify(lines) === JSON.stringify([
      `python -m venv "C:\\Users\\Zoe van Dam\\aiplay-whisper\\venv"`,
      `pushd "${path.win32.dirname(spaced)}"`,
      `.\\python.exe ${TORCH_PIP}`,
      ".\\python.exe -m pip install faster-whisper stable-ts",
    ]), lines.join("\n"));
  const block = installBlock(spaced, { platform: "win32", create: true });
  ok("  the NVIDIA condition is a sentence, never text after a command", block.includes("The torch line is for an NVIDIA card")
    && lines.every((l) => !/NVIDIA|\(/.test(l)), block);

  /* FOR REAL. node.exe, copied into a folder with a space as python.exe,
   * answers --version with node's own version. The builder's lines are piped
   * into cmd.exe and powershell.exe as a person would paste them; the old
   * quoted form is piped into PowerShell beside them, and must fail there. */
  if (WIN) {
    const shellRun = (shell, lines2) => {
      const args = shell === "powershell.exe" ? ["-NoProfile", "-NonInteractive", "-Command", "-"] : ["/d", "/q"];
      const r = spawnSync(shell, args, { input: `${lines2.join("\r\n")}\r\nexit\r\n`, encoding: "utf8", windowsHide: true, cwd: TMP });
      return `${r.stdout || ""}${r.stderr || ""}`;
    };
    for (const folder of [path.join(TMP, "Zoe van Dam", "venv", "Scripts"), path.join(TMP, "zoe", "venv", "Scripts")]) {
      fs.mkdirSync(folder, { recursive: true });
      const exe = path.join(folder, "python.exe");
      fs.copyFileSync(process.execPath, exe);
      const got = runLines(exe, ["--version"]);
      for (const shell of ["cmd.exe", "powershell.exe"]) {
        const out = shellRun(shell, got);
        ok(`${shell} runs the builder's line for ${path.relative(TMP, folder)}`, out.includes(process.version), `${got.join(" | ")}\n${out.slice(-400)}`);
      }
    }
    const exe = path.join(TMP, "Zoe van Dam", "venv", "Scripts", "python.exe");
    const quoted = shellRun("powershell.exe", [`"${exe}" --version`]);
    ok("  (control: PowerShell refuses the quoted-program form the first fix printed)", !quoted.includes(process.version), quoted.slice(-300));
  } else {
    console.log("  skip  cmd.exe and powershell.exe exist only on Windows");
  }

  // Nothing a person reads may pin the torch build that has no wheel for Python 3.13/3.14.
  const sources = ["server/lrc.js", "server/lrc.py", "scripts/extras_setup.mjs", "scripts/models_table.mjs", "README.md", "INSTALL.md"];
  const pinned = sources.filter((f) => /torch==|cu121/.test(read(f)));
  ok("no install text pins torch== or cu121", pinned.length === 0, pinned.join(", "));
}

/* ═══ 3. the sentences, from stub interpreters ═════════════════════════ */
console.log("\n  -- every failure names its cause --");
const said = [];
{
  // (a) the interpreter is not there: the reported case.
  const venv = path.dirname(path.dirname(NO_PYTHON));
  const a = await failWith({ python: NO_PYTHON });
  said.push(a);
  ok("a missing interpreter is named, not 'alignment failed'", a && !a.includes(NEVER) && a.includes(NO_PYTHON), a);
  ok("  it says the interpreter does not exist", /does not exist/.test(a || ""), a);
  ok("  it gives the venv command for that exact folder, quoted as an argument", (a || "").includes(`python -m venv "${venv}"`), a);
  ok("  and the verified lines aimed at that python, every one of them",
    installLines(NO_PYTHON, { create: true }).every((l) => (a || "").includes(`\n    ${l}`)), a);
  ok("  with no line a person pastes starting with a quoted program", quotedProgram(a).length === 0, quotedProgram(a).join("\n"));
  ok(`  and names the setting, which takes effect at once (${SETTING_WORDS})`,
    (a || "").includes(SETTING_WORDS) && /takes effect at once/.test(a || ""), a);
  ok("  and never 'setx … then restart Studio' (the launcher keeps its old environment)",
    !/setx|restart Studio/.test(a || ""), a);
  ok("  and the cause is in the first 200 characters (the Jobs row keeps no more)",
    (a || "").slice(0, 200).includes("no Python to run") && (a || "").slice(0, 200).includes(NO_PYTHON), (a || "").slice(0, 200));
  const viaEnv = missingPythonMessage(NO_PYTHON, { env: true });
  ok("when AIPLAY_WHISPER_PYTHON names it, the message says so and that the launcher must be quit too",
    viaEnv.includes("AIPLAY_WHISPER_PYTHON names this python") && viaEnv.includes(ENV_RESTART)
      && /launcher included/.test(ENV_RESTART) && !viaEnv.includes(SETTING_WORDS), viaEnv);
  ok("whisperPythonMissing refuses the same path up front", whisperPythonMissing(NO_PYTHON) === missingPythonMessage(NO_PYTHON));
  ok("  and passes one that exists", whisperPythonMissing(process.execPath) === null);
  ok("  and leaves a bare name to PATH", whisperPythonMissing("python") === null);

  // (b) python ran but could not open the script (the %20 path).
  const encoded = path.join(TMP, "AIPLAY%20Studio", "server", "lrc.py");
  const b = await failWith({
    python: process.execPath,
    script: stub("cant_open", `process.stderr.write(${JSON.stringify(`python.exe: can't open file '${encoded}': [Errno 2] No such file or directory\n`)}); process.exit(2);`),
  });
  said.push(b);
  ok("a script python cannot open is said so, with the path", b && !b.includes(NEVER) && /could not open its script/.test(b) && b.includes("AIPLAY%20Studio"), b);
  ok("  and the exit code and interpreter", (b || "").includes(`[${process.execPath} exited 2]`), b);

  // (c) faster_whisper is not importable in that interpreter.
  const c = await failWith({
    python: process.execPath,
    script: stub("no_module", `process.stderr.write("Traceback (most recent call last):\\n  File \\"lrc.py\\", line 1, in <module>\\nModuleNotFoundError: No module named 'faster_whisper'\\n"); process.exit(1);`),
  });
  said.push(c);
  ok("a missing package is named by its pip name, with the import that failed",
    c && !c.includes(NEVER) && /faster-whisper is not installed in/.test(c) && c.includes("No module named 'faster_whisper'"), c);
  ok("  with the verified lines aimed at the interpreter that ran",
    installLines(process.execPath).every((l) => (c || "").includes(l)), c);

  // (d) cuDNN's sub-libraries are missing: a NATIVE abort, JSON never printed.
  const count = path.join(TMP, "abort_runs.txt");
  const CUDNN = "Could not locate cudnn_ops64_9.dll. Please make sure it is in your library path!\\nInvalid handle. Cannot load symbol cudnnCreateTensorDescriptor\\n";
  const abortBody = `
    import fs from "node:fs";
    fs.appendFileSync(${JSON.stringify(count)}, (process.env.AIPLAY_WHISPER_DEVICE || "auto") + "\\n");
    if (process.env.AIPLAY_WHISPER_DEVICE === "cpu") {
      process.stderr.write("[lrc] device=cpu compute=int8\\n");
      if (process.env.FAIL_ON_CPU) { process.stderr.write("RuntimeError: something else broke on the CPU\\n"); process.exit(1); }
      console.log(JSON.stringify({ ok: true, lines: 2, device: "cpu", computeType: "int8", cpuReason: "AIPLAY_WHISPER_DEVICE=cpu" }));
    } else {
      process.stderr.write(process.env.MARKER ?? "[lrc] device=cuda compute=int8_float16\\n");
      process.stderr.write("${CUDNN}");
      process.exit(3221226505);
    }`;
  const abortStub = stub("cudnn_abort", abortBody);
  const logs = [];
  const got = await runLrc({ python: process.execPath, script: abortStub, args: ["s", "l", "o"], log: (m) => logs.push(m),
    env: { ...process.env, AIPLAY_WHISPER_DEVICE: "" } }).catch((err) => ({ threw: String(err.message || err) }));
  const runs = () => fs.readFileSync(count, "utf8").trim().split("\n").join(",");
  ok("a native cuDNN abort on cuda is run again on the CPU, once", runs() === "auto,cpu", runs());
  ok("  and the CPU result is returned", got?.ok === true && got.device === "cpu", JSON.stringify(got));
  ok("  saying why: the cuda run (its compute type) crashed, naming the library and the NTSTATUS",
    /the cuda run \(int8_float16\) crashed: .*cudnn.*0xC0000409/.test(got?.cpuReason || ""), got?.cpuReason);
  ok("  and the stderr it would have discarded went to the log",
    logs.some((l) => l.includes("Could not locate cudnn_ops64_9.dll")), logs.join("\n"));

  // (d2) THE MARKER DECIDES. The same crash, when lrc.py said it was on the CPU,
  // or said nothing, is not "the GPU crashed" and is not run again.
  fs.writeFileSync(count, "");
  const onCpu = await failWith({ python: process.execPath, script: abortStub,
    env: { ...process.env, AIPLAY_WHISPER_DEVICE: "auto", MARKER: "[lrc] device=cpu compute=int8\n" } });
  ok("the same crash with the last marker saying cpu is NOT re-run", runs() === "auto", runs());
  ok("  and the message names the device the marker named", (onCpu || "").includes(`[${process.execPath} on cpu exited 0xC0000409]`), onCpu);
  fs.writeFileSync(count, "");
  await failWith({ python: process.execPath, script: abortStub, env: { ...process.env, AIPLAY_WHISPER_DEVICE: "auto", MARKER: "" } });
  ok("  nor with no marker at all (nothing says the GPU was ever used)", runs() === "auto", runs());
  ok("lastDevice reads the LAST marker", JSON.stringify(lastDevice("[lrc] device=cuda compute=float16\nx\n[lrc] device=cpu compute=int8\n"))
    === JSON.stringify({ device: "cpu", compute: "int8" }));

  fs.writeFileSync(count, "");
  const forced = await failWith({ python: process.execPath, script: abortStub, env: { ...process.env, AIPLAY_WHISPER_DEVICE: "cuda" } });
  said.push(forced);
  ok("with AIPLAY_WHISPER_DEVICE=cuda there is no second run", runs() === "cuda", runs());
  ok("  and the message names the missing CUDA library, the device, and both ways out",
    forced && !forced.includes(NEVER) && /CUDA libraries are missing or broken/.test(forced)
      && /cudnn_ops64_9\.dll/.test(forced) && /AIPLAY_WHISPER_DEVICE=cpu/.test(forced) && /0xC0000409/.test(forced)
      && forced.includes(" on cuda ") && forced.includes(TORCH_PIP) && forced.includes(ENV_RESTART), forced);

  const both = await failWith({ python: process.execPath, script: abortStub,
    env: { ...process.env, AIPLAY_WHISPER_DEVICE: "auto", FAIL_ON_CPU: "1" } });
  said.push(both);
  ok("when the CPU run fails too, both causes are in the message",
    both && /something else broke on the CPU/.test(both) && /after the cuda run crashed/.test(both), both);

  // (d3) A WARNING IS NOT THE FAILURE. huggingface_hub's symlink UserWarning is
  // on stderr on every first Windows run and names huggingface.co; above a
  // cuDNN abort it used to read as "could not download its model".
  const HF_WARN = [
    "C:\\venv\\Lib\\site-packages\\huggingface_hub\\file_download.py:143: UserWarning: `huggingface_hub` cache-system uses symlinks by default to efficiently store duplicated files but your machine does not support them in C:\\Users\\Zoe\\.cache\\huggingface\\hub\\models--Systran--faster-whisper-large-v3. Caching files will still work but in a degraded version that might require more space on your disk. This warning can be disabled by setting the `HF_HUB_DISABLE_SYMLINKS_WARNING` environment variable. For more details, see https://huggingface.co/docs/huggingface_hub/how-to-cache#limitations.",
    "To support symlinks on Windows, you either need to activate Developer Mode or to run Python as an administrator. In order to activate developer mode, see this article: https://docs.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development",
    "  warnings.warn(message)",
  ].join("\n");
  const hf = explainFailure({ python: "py", model: "large-v3", code: 3221226505,
    stderr: `[lrc] device=cuda compute=int8_float16\n${HF_WARN}\n${CUDNN.replace(/\\n/g, "\n")}` });
  said.push(hf);
  ok("the huggingface symlink warning + a cuDNN abort reads as the CUDA libraries, not a download",
    /CUDA libraries are missing or broken \(Could not locate cudnn_ops64_9\.dll/.test(hf) && !/could not download/.test(hf), hf);
  ok("  and the warning is still SHOWN in the tail", hf.includes("cache-system uses symlinks"), hf);
  const hfOther = explainFailure({ python: "py", code: 1,
    stderr: `${HF_WARN}\nTraceback (most recent call last):\nZeroDivisionError: division by zero\n` });
  ok("  and the same warning over an unrelated crash is not called a download either",
    hfOther.startsWith("Timed lyrics failed: ZeroDivisionError: division by zero"), hfOther);
  const cudnnThenDownload = explainFailure({ python: "py", code: 1,
    stderr: "Could not load library cudnn_cnn_infer64_8.dll. Error code 126\nrequests.exceptions.ConnectionError: Max retries exceeded\n" });
  ok("  a line naming a CUDA library FILE outranks a download word below it",
    /CUDA libraries are missing or broken \(Could not load library cudnn_cnn_infer64_8\.dll/.test(cudnnThenDownload), cudnnThenDownload);
  const realDownload = explainFailure({ python: "py", code: 1, model: "large-v3",
    stderr: "Traceback (most recent call last):\nhuggingface_hub.errors.LocalEntryNotFoundError: Cannot find an appropriate cached snapshot folder\n" });
  ok("  while a real download failure is still a download failure",
    /could not download its model/.test(realDownload) && /about 3 GB/.test(realDownload), realDownload);

  // (e) the first-run model download failed, with no JSON.
  const e = await failWith({
    python: process.execPath,
    script: stub("download", `process.stderr.write("Traceback (most recent call last):\\nhuggingface_hub.errors.LocalEntryNotFoundError: Cannot find an appropriate cached snapshot folder for the specified revision on the local disk and outgoing traffic has been disabled.\\n"); process.exit(1);`),
  });
  said.push(e);
  ok("a failed model download says so, with the size and the host",
    e && !e.includes(NEVER) && /could not download its model/.test(e) && /huggingface\.co/.test(e) && /about 3 GB/.test(e), e);

  // (f) out of memory.
  const f = await failWith({
    python: process.execPath,
    script: stub("oom", `process.stderr.write("MemoryError: Unable to allocate 3.10 GiB for an array\\n"); process.exit(1);`),
  });
  said.push(f);
  ok("out of memory is named", f && !f.includes(NEVER) && /ran out of memory/.test(f) && /3\.10 GiB/.test(f), f);
  ok("  and setting the device variable says the launcher must be quit too", (f || "").includes(ENV_RESTART), f);
  const fGpu = explainFailure({ python: "py", code: 1, stderr: "RuntimeError: CUDA failed with error out of memory\n" });
  said.push(fGpu);
  ok("  a CUDA out-of-memory reads as memory, not as missing libraries", /ran out of memory/.test(fGpu), fGpu);
  const oomRuns = path.join(TMP, "oom_runs.txt");
  const fCrash = await failWith({
    python: process.execPath, env: { ...process.env, AIPLAY_WHISPER_DEVICE: "auto" },
    script: stub("oom_native", `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(oomRuns)}, "x"); process.stderr.write("[lrc] device=cuda compute=int8_float16\\nCUDA failed with error out of memory\\n"); process.exit(3221226505);`),
  });
  ok("  a crash on a FULL card is not re-run on the CPU (music would wait behind it)",
    fs.readFileSync(oomRuns, "utf8") === "x" && /ran out of memory/.test(fCrash || ""), fCrash);

  // (g) anything else: the stderr tail, never the bare two words.
  const g = await failWith({
    python: process.execPath,
    script: stub("unknown", `process.stderr.write("Traceback (most recent call last):\\n  File \\"x.py\\", line 3, in <module>\\n    1/0\\nZeroDivisionError: division by zero\\n"); process.exit(1);`),
  });
  said.push(g);
  ok("an unknown failure shows the python's own last error line first",
    g && !g.includes(NEVER) && g.startsWith("Timed lyrics failed: ZeroDivisionError: division by zero"), g);
  ok("  then the interpreter and exit code, then the tail", (g || "").includes(`[${process.execPath} exited 1]`) && (g || "").includes("File \"x.py\""), g);

  const h = await failWith({ python: process.execPath, script: stub("silent", "process.exit(0);") });
  said.push(h);
  ok("exit 0 with nothing printed is not a success and says so", h && !h.includes(NEVER) && /printed nothing/.test(h), h);

  // (h) the python's own JSON error is still used (the old contract).
  const i = await failWith({ python: process.execPath, script: stub("json_err", `console.log(JSON.stringify({ ok: false, error: "no lyric lines (instrumental?)" }));`) });
  ok("lrc.py's own error is passed through unchanged", i === "no lyric lines (instrumental?)", i);
  const iNeeds = await failWith({ python: process.execPath, script: stub("json_needs",
    `console.log(JSON.stringify({ ok: false, needsInstall: true, error: "stable-ts is not installed in C:\\\\x\\\\python.exe (No module named 'stable_whisper')" }));`) });
  said.push(iNeeds);
  ok("  and when it says needsInstall, THIS side opens with Timed lyrics:, adds the verified lines for the python Studio ran, and offers the Settings field",
    (iNeeds || "").startsWith("Timed lyrics: stable-ts is not installed in") && installLines(process.execPath).every((l) => (iNeeds || "").includes(l))
      && (iNeeds || "").includes(SETTING_WORDS), iNeeds);
  const j = await failWith({ python: process.execPath, script: stub("json_bare", `console.log('{"ok": false}'); process.stderr.write("warn: odd\\n");`) });
  said.push(j);
  ok("an ok:false with no reason still names something", j && !j.includes(NEVER) && /gave no reason/.test(j) && /warn: odd/.test(j), j);

  // (i) parsing: success output survives a banner and carriage-return bars.
  const k = await runLrc({ python: process.execPath, log: quiet, args: [],
    script: stub("banner", `process.stdout.write("config {a:1}\\n 10%|#  | 1/10 [00:01<00:09]\\r100%|###| 10/10\\r" + JSON.stringify({ ok: true, lines: 3, confidence: 0.9 }) + "\\r\\n");`) })
    .catch((err) => ({ threw: String(err.message || err) }));
  ok("a banner with braces and \\r progress bars before the JSON still parse", k?.ok === true && k.lines === 3, JSON.stringify(k));
  ok("parseResult keeps the old first-{-to-last-} fallback", parseResult('x {"ok": true,\n"lines": 1} y')?.lines === 1);

  // (j) small things that decide whether the message can be read.
  const tail = stderrTail("a\n\n 45%|####      | 45/100 [00:03<00:04]\n[lrc] device=cuda compute=int8_float16\nkey hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 token=sekrit\nlast\n");
  ok("stderrTail drops progress bars, blank lines and the device marker", tail.length === 3 && tail[0] === "a" && tail[2] === "last", JSON.stringify(tail));
  ok("  and masks tokens", !tail.join(" ").includes("hf_ABCDEF") && !tail.join(" ").includes("sekrit") && /\[redacted\]/.test(tail[1]), tail[1]);
  const store = explainFailure({ python: "C:\\x\\python.exe", code: 9009,
    stderr: "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.\n" });
  said.push(store);
  ok("the Microsoft Store placeholder is recognised, and the way out is the setting", /Microsoft Store placeholder/.test(store) && store.includes(SETTING_WORDS), store);
  const eacces = explainFailure({ python: "C:\\x\\python.exe", spawnError: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }) });
  said.push(eacces);
  ok("a python that will not start (not ENOENT) is named with its code", /could not start C:\\x\\python\.exe \(EACCES\)/.test(eacces), eacces);

  said.push(got?.cpuReason);
  const all = said.filter(Boolean).join("\n");
  // No sentence here may carry an em dash: docs/UI_GUIDE.md rule 4.
  ok("no em dash in any sentence a person reads", !all.includes("\u2014"));
  ok("no line in any of them starts with a quoted program", quotedProgram(all).length === 0, quotedProgram(all).join("\n"));
}

/* ═══ 4. tokens, wherever they come from ═══════════════════════════════ */
console.log("\n  -- masking --");
{
  const BEARER = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0.dG9rZW4";
  const t = stderrTail(`requests.exceptions.HTTPError: 401 for url\n${BEARER}\n`);
  ok("'Authorization: Bearer <token>' in the stderr tail loses the token, not the word Bearer",
    !t.join("\n").includes("eyJhbGci") && t.join("\n").includes("Bearer [redacted]"), t.join("\n"));
  ok("credentials inside a URL are masked", mask("https://zoe:s3cretpass@hf.co/x") === "https://zoe:[redacted]@hf.co/x",
    mask("https://zoe:s3cretpass@hf.co/x"));
  ok("an ordinary sentence with the word Token survives", mask("Token indices sequence length is longer than 448") === "Token indices sequence length is longer than 448");
  ok("  and one with the word basic (a bare scheme word is matched in its RFC case only)",
    mask("Running basic transcription pipeline") === "Running basic transcription pipeline", mask("Running basic transcription pipeline"));
  const lower = mask("authorization: bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0");
  ok("  while a lowercase 'authorization: bearer <token>' still loses the token", lower === "authorization: bearer [redacted]", lower);
  const fromJson = await failWith({ python: process.execPath, script: stub("json_token",
    `console.log(JSON.stringify({ ok: false, error: "could not download the whisper model large-v3 (401 Client Error: ${BEARER} hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 api_key=abc123def)" }));`) });
  ok("lrc.py's OWN JSON error is masked too (it bypassed the tail)",
    fromJson && !/eyJhbGci|hf_ABCDEF|abc123def/.test(fromJson) && /could not download the whisper model/.test(fromJson), fromJson);
  const fromCrash = await failWith({ python: process.execPath, script: stub("crash_token",
    `process.stderr.write("urllib.error.HTTPError: HTTP Error 401\\n${BEARER}\\n"); process.exit(1);`) });
  ok("  and so is a crash message built from stderr", fromCrash && !/eyJhbGci/.test(fromCrash), fromCrash);
}

/* The click refuses before queueing. index.js is the whole server and is not
 * started here, so this reads the route: inside POST /api/lyrics "run", the
 * interpreter check must come before the job is queued. */
const INDEX = read("server/index.js");
{
  const route = INDEX.slice(INDEX.indexOf('if (p === "/api/lyrics" && req.method === "POST")'));
  const run = route.slice(route.indexOf('if (b.action === "run")'), route.indexOf('return json(res, 400, { error: "Unknown action." })'));
  const check = run.indexOf("whisperPythonMissing(config.lyrics.python)");
  const queue = run.indexOf('kind: "lrc"');
  ok("POST /api/lyrics run refuses a missing whisper python before it queues the job",
    check > 0 && queue > check && /if \(noPython\) return json\(res, 400, \{ error: noPython,/.test(run),
    run.slice(0, 400));
  ok("  the refusal carries setup: \"lyrics\" only when AIPLAY_WHISPER_PYTHON is unset (a build would not be used)",
    /\{ error: noPython, \.\.\.\(process\.env\.AIPLAY_WHISPER_PYTHON \? \{\} : \{ setup: "lyrics" \}\) \}/.test(run), run.slice(0, 600));
  ok("  and the text says which two packages the button installs, not \"both\"",
    missingPythonMessage("C:\\x\\python.exe", { platform: "win32", env: false }).includes("builds a private Python with faster-whisper and stable-ts"));
  /* The refusal names the one-click setup, so the page can offer [Set up timed
   * lyrics] beside the sentence; the id is the recipe server/setup/venv.js runs. */
  const { SETUP_FEATURE, SETUP_BUTTON } = await import("./lrc.js");
  const { RECIPE_IDS } = await import("./setup/venv.js");
  ok("  and carries the setup id, which is a recipe the setup door runs",
    SETUP_FEATURE === "lyrics" && RECIPE_IDS.includes(SETUP_FEATURE));
  const easy = missingPythonMessage("C:\\Users\\Zoe\\aiplay-whisper\\venv\\Scripts\\python.exe", { platform: "win32", env: false });
  ok("  and the sentence offers the button before the pasted commands",
    easy.indexOf(SETUP_BUTTON) > 0 && easy.indexOf(SETUP_BUTTON) < easy.indexOf("-m pip install"), easy);
  ok("  but not when AIPLAY_WHISPER_PYTHON wins over whatever the button would choose",
    !missingPythonMessage("C:\\py\\python.exe", { platform: "win32", env: true }).includes(SETUP_BUTTON));
}

/* ═══ 5. the real ArtRunner, a real lrc job, no python ═════════════════ */
console.log("\n  -- art.js #timeLyrics, end to end --");
const art = await import("./art.js");
const { engine } = await import("./engine/client.js");
/* #drain opens the progress socket; point it at a port reserved from the OS
 * and closed at once, so it can never reach a render in flight. */
await engine.reservePort();
engine.attachChild({ exitCode: null, signalCode: null });
const runner = new art.ArtRunner({ ready: true }, { current: null, queue: [] });

function timeLyrics(file, lyrics) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { cleanup(); resolve({ error: "the job never finished" }); }, 60_000);
    const onLrc = (evt) => { if (evt.file === file) { cleanup(); resolve({ ok: evt }); } };
    const onFailed = (evt) => { if (evt.file === file && evt.kind === "lrc") { cleanup(); resolve({ error: evt.error }); } };
    function cleanup() { clearTimeout(t); runner.off("lrc", onLrc); runner.off("failed", onFailed); }
    runner.on("lrc", onLrc);
    runner.on("failed", onFailed);
    runner.request({ file, title: file, kind: "lrc", lyrics, force: true });
  });
}

const origError = console.error;
console.error = quiet;
const e2e = await timeLyrics("song.flac", "hello world\nagain");
console.error = origError;
ok("the job fails with the sentence, not 'alignment failed'",
  e2e.error === missingPythonMessage(NO_PYTHON), e2e.error);
const st = runner.status().art;
ok("  status() carries it: the Jobs row (first 200 characters) and lastError",
  st.recent.some((r) => r.kind === "lrc" && r.error === missingPythonMessage(NO_PYTHON).slice(0, 200))
    && st.lastError === `song.flac: ${missingPythonMessage(NO_PYTHON)}`, JSON.stringify(st.recent[0]));

/* ═══ 6. Settings: choosing the python, and what it answers ════════════ */
console.log("\n  -- Settings > Songs > timed lyrics python, and its door --");
{
  /* The route's own block, run with its real collaborators except the two that
   * touch the world: savePrefs (counted) and probeOne (answers as a venv that
   * has faster_whisper and lacks stable_whisper: the measured case). The same
   * slice-and-run bucky-integration_test.js uses for another index.js route. */
  const at = INDEX.indexOf('      if (b.action === "python") {');
  const end = INDEX.indexOf('      if (b.action === "run") {', at);
  const block = at > 0 && end > at ? INDEX.slice(at, end) : "";
  ok("the /api/lyrics route has a 'python' action, before 'run'", !!block, "not found");
  const { whisperPython } = await import("./config.js");
  const { LYRICS_MODULES_FOR_TEST } = { LYRICS_MODULES_FOR_TEST: modulesOf(LYRICS) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  /* The origin guard is the REAL one, sliced out of index.js and bound to this
   * config: a stub here would pass whatever the route asked of it. */
  const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\r?\n\}/.exec(INDEX)?.[0] || "";
  ok("index.js has ONE same-origin guard, sameOriginLocalJson", !!guardSrc && INDEX.split("function sameOriginLocalJson(").length === 2, "not found");
  const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)(config);
  const door = new AsyncFunction("b", "req", "res", "json", "stat", "path", "config", "whisperPython", "defaultWhisperPython",
    "savePrefs", "probeOne", "whisperPythonMissing", "pythonVerdict", "LYRICS_MODULES", "sameOriginLocalJson",
    `let packageCache = {};\n${block}\nreturn null;`);
  let saves = 0;
  const probed = [];
  const HOST = `127.0.0.1:${config.uiPort}`;
  // What Studio's Settings page sends: its own origin, a JSON body.
  const PAGE = { headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" } };
  const call = (b, req = PAGE) => door(b, req, null, (_res, code, body) => ({ code, body }), fs.promises.stat, path, config,
    whisperPython, defaultWhisperPython, () => { saves++; }, async (py, mods) => { probed.push([py, mods]); return { faster_whisper: true }; },
    whisperPythonMissing, pythonVerdict, LYRICS_MODULES_FOR_TEST, sameOriginLocalJson);

  const r0 = await call({ action: "python" });
  ok("no value reports: the python, where it came from, and that it does not exist",
    r0?.code === 200 && r0.body.lyrics.python === NO_PYTHON && r0.body.lyrics.source === "Settings"
      && r0.body.lyrics.ready === false && r0.body.lyrics.note === missingPythonMessage(NO_PYTHON) && saves === 0, JSON.stringify(r0));

  const chosen = path.join(TMP, "Zoe van Dam", "py311", "python.exe");
  fs.mkdirSync(path.dirname(chosen), { recursive: true });
  fs.writeFileSync(chosen, "");
  const r1 = await call({ action: "python", value: `  "${chosen}"  ` });
  ok("a path (as Explorer's Copy as path pastes it, in quotes) is chosen at once and saved",
    r1?.code === 200 && config.lyrics.whisperPython === chosen && config.lyrics.python === chosen && saves === 1, JSON.stringify(r1));
  ok("  both modules are probed in THAT python", JSON.stringify(probed.at(-1)) === JSON.stringify([chosen, ["faster_whisper", "stable_whisper"]]),
    JSON.stringify(probed));
  ok("  and a python without stable_whisper is NOT ready, and the answer says stable-ts and how",
    r1.body.lyrics.ready === false && /stable-ts is not installed in/.test(r1.body.lyrics.note)
      && installLines(chosen).every((l) => r1.body.lyrics.note.includes(l)), r1.body.lyrics.note);

  const before = saves;
  const r2 = await call({ action: "python", value: "venv\\Scripts\\python.exe" });
  ok("a relative path is refused as one (asking for the full path), and nothing changes",
    r2?.code === 400 && /Give the full path to the python/.test(r2.body.error) && config.lyrics.python === chosen && saves === before, JSON.stringify(r2));
  const r3 = await call({ action: "python", value: path.join(TMP, "nothing", "python.exe") });
  ok("a path with no file is refused, and nothing changes", r3?.code === 400 && /There is no file at/.test(r3.body.error) && config.lyrics.python === chosen, JSON.stringify(r3));

  /* WHO MAY CHOOSE IT. A web page open in the same browser can POST here with
   * mode 'no-cors' and a text/plain body: no preflight, no answer read, but the
   * route runs, and the path it names is executed at once and on every lyrics
   * job. Each of these must be refused before anything is saved or probed. */
  const probesBefore = probed.length;
  const foreign = [
    ["a text/plain body (what a no-cors cross-site POST sends)", { headers: { host: HOST, origin: `http://${HOST}`, "content-type": "text/plain" } }],
    ["a cross-site Origin", { headers: { host: HOST, origin: "https://evil.example", "content-type": "application/json" } }],
    ["a rebound DNS name as Host", { headers: { host: `evil.example:${config.uiPort}`, "content-type": "application/json" } }],
  ];
  for (const [what, req] of foreign) {
    const r = await call({ action: "python", value: process.execPath }, req);
    ok(`${what} gets 403, and nothing is saved or run`,
      r?.code === 403 && config.lyrics.python === chosen && saves === before && probed.length === probesBefore, JSON.stringify(r));
  }
  const rRead = await call({ action: "python" }, foreign[1][1]);
  ok("  reading the verdict stays open (it runs nothing new)", rRead?.code === 200 && rRead.body.lyrics.python === chosen, JSON.stringify(rRead));
  const probesAfterRead = probed.length;
  const local = { headers: { host: HOST, "content-type": "application/json" } };  // MCP's api(): no Origin at all
  for (const unc of ["\\\\evil.example\\share\\python.exe", "//evil.example/share/python.exe", "\\\\?\\C:\\Python311\\python.exe"]) {
    const r = await call({ action: "python", value: unc }, local);
    ok(`a network or device path (${unc}) is refused from a local client too, and never probed`,
      r?.code === 400 && /network or device path/.test(r.body.error) && config.lyrics.python === chosen && probed.length === probesAfterRead, JSON.stringify(r));
  }
  const gguf = INDEX.slice(INDEX.indexOf('if (p === "/api/music-gguf/setup")'), INDEX.indexOf('if (p === "/api/models" && req.method !== "POST")'));
  ok("the native runtime installer uses the same guard, not a copy of it",
    /if \(!sameOriginLocalJson\(req\)\)/.test(gguf) && !/allowedHosts/.test(gguf), gguf.slice(0, 400));

  /* A python that never answers must not hold the route: probeOne gives up.
   * Its own source, with spawn replaced by a process that never exits. */
  const probeSrc = /function probeOne\(py, mods, timeoutMs = [\d_]+\) \{[\s\S]*?\r?\n\}/.exec(INDEX)?.[0] || "";
  let killed = false;
  const hung = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.kill = () => { killed = true; }; return p; };
  const probeOneHung = new Function("spawn", `${probeSrc}\nreturn probeOne;`)(hung);
  const t0 = Date.now();
  // Raced, so a probe with no timeout FAILS here instead of hanging the run.
  const got = await Promise.race([probeOneHung("C:\\hangs\\python.exe", ["stable_whisper"], 150),
    new Promise((r) => setTimeout(() => r("still waiting after 3 s"), 3000))]);
  ok("probeOne gives up on a python that never exits, kills it, and reads it as not found",
    !!probeSrc && JSON.stringify(got) === "{}" && killed && Date.now() - t0 < 3000, `${probeSrc.slice(0, 80)} got ${JSON.stringify(got)} killed ${killed}`);

  process.env.AIPLAY_WHISPER_PYTHON = process.execPath;
  const r4 = await call({ action: "python", value: chosen });
  ok("with AIPLAY_WHISPER_PYTHON set, the choice is saved but the variable still runs, and the answer says so",
    config.lyrics.python === process.execPath && config.lyrics.whisperPython === chosen
      && /AIPLAY_WHISPER_PYTHON is set and wins/.test(r4.body.lyrics.note) && r4.body.lyrics.note.includes(ENV_RESTART), JSON.stringify(r4.body));
  delete process.env.AIPLAY_WHISPER_PYTHON;

  const r5 = await call({ action: "python", value: "" });
  ok("an empty value goes back to the default venv", r5?.code === 200 && config.lyrics.whisperPython === null
    && config.lyrics.python === defaultWhisperPython() && r5.body.lyrics.source === "the default", JSON.stringify(r5.body));

  const full = pythonVerdict({ python: process.execPath, modules: { faster_whisper: true, stable_whisper: true } });
  ok("both modules importing is ready", full.ready === true && /both import there/.test(full.note), JSON.stringify(full));

  // The field exists where the sentence sends people.
  const html = read("web/index.html");
  const songs = html.slice(html.indexOf('id="set-songs"'), html.indexOf("</section>", html.indexOf('id="set-songs"')));
  ok(`web/index.html has the field ${SETTING_WORDS} points at`,
    /<h3>Songs<\/h3>/.test(songs) && songs.includes('<label for="qWhisperPy">timed lyrics python</label>')
      && songs.includes('id="qWhisperPy"') && songs.includes('id="btnWhisperPy"'), songs.slice(0, 300));
  const app = read("web/app.js");
  ok("  and app.js posts it to the door, and fills it from /api/status",
    /\$\("btnWhisperPy"\)\.onclick[\s\S]{0,600}action: "python", value: \$\("qWhisperPy"\)\.value\.trim\(\)/.test(app)
      && /\$\("qWhisperPy"\)\.value = s\.config\.lyrics\.whisperPython \|\| ""/.test(app));
  ok("  and /api/status sends what it fills from", /python: config\.lyrics\.python, whisperPython: config\.lyrics\.whisperPython/.test(INDEX));
  // The tool, for the owner's rule: a plain control, the number behind it, and a tool.
  const { TOOLS } = await import("./mcp.js");
  const tool = TOOLS.find((x) => x.name === "timed_lyrics_python");
  ok("MCP has timed_lyrics_python, posting the same action", !!tool && /action: "python"/.test(String(tool.run)), tool ? String(tool.run) : "none");
  const { WITHHELD } = await import("./chat/router.js");
  ok("  and the local chat may not use it (it names a program Studio runs)", typeof WITHHELD.timed_lyrics_python === "string");

  config.lyrics.whisperPython = NO_PYTHON;
  config.lyrics.python = NO_PYTHON;
}

/* ═══ 7. Ready means both modules ═══════════════════════════════════════ */
console.log("\n  -- the readiness probe: faster_whisper AND stable_whisper --");
{
  ok("the catalogue lists every module lrc.py imports", JSON.stringify(modulesOf(LYRICS)) === '["faster_whisper","stable_whisper"]',
    JSON.stringify(modulesOf(LYRICS)));
  const pySrc = read("server/lrc.py");
  ok("  and lrc.py imports exactly those", /import stable_whisper/.test(pySrc) && /load_faster_whisper/.test(pySrc));
  const probe = /const PACKAGE_PROBES = \(\) => \{[\s\S]*?\n\};/.exec(INDEX)?.[0] || "";
  const lyricsList = /for \(const m of (\[[^\]]*\])\) add\(config\.lyrics\?\.python/.exec(probe)?.[1];
  ok("PACKAGE_PROBES probes both, in the lyrics interpreter", lyricsList && JSON.stringify(JSON.parse(lyricsList)) === JSON.stringify(modulesOf(LYRICS)),
    probe);
  // The Models row's two fields, evaluated as written in index.js.
  const readyExpr = /packageReady: ([^\n]+),\n/.exec(INDEX)?.[1];
  const missingExpr = /packageMissing: ([^\n]+),\n/.exec(INDEX)?.[1];
  const row = new Function("modulesOf", "c", "pkgs", `return { ready: ${readyExpr}, missing: ${missingExpr} };`);
  const statusRow = { needsPackage: LYRICS.needsPackage, needsModules: LYRICS.needsModules };
  const half = row(modulesOf, statusRow, { faster_whisper: true, stable_whisper: false });
  ok("a venv with faster_whisper and no stable_whisper is NOT Ready on the Models screen, and names stable_whisper",
    half.ready === false && JSON.stringify(half.missing) === '["stable_whisper"]', JSON.stringify(half));
  ok("  both present is Ready", row(modulesOf, statusRow, { faster_whisper: true, stable_whisper: true }).ready === true);
  ok("  a one-package row still reads its needsPackage", row(modulesOf, { needsPackage: "demucs" }, { demucs: true }).ready === true
    && row(modulesOf, { needsPackage: "demucs" }, {}).ready === false);
  ok("models.js status rows carry needsModules to that line", /needsModules: cap\.needsModules \|\| null/.test(read("server/models.js")));
  const { resolveNeeds } = await import("./welcome/catalogue.js");
  const pk = resolveNeeds({ needs: [{ kind: "model", id: "lyrics", for: "test" }] }).filter((n) => n.kind === "package").map((n) => n.id);
  ok("the welcome panel lists a package row for each", JSON.stringify(pk) === '["faster_whisper","stable_whisper"]', JSON.stringify(pk));
  ok("extras_setup.mjs probes every module (modulesOf), not the first",
    /const mods = modulesOf\(cap\);\s*\n\s*const state = await probe\(py, mods\);/.test(read("scripts/extras_setup.mjs")));
  /* WHERE it goes, in the two other places that say so. The recommendation
   * (fit.js, the Models screen and models_for_this_machine) said "your SYSTEM
   * Python" for every package, timed lyrics included: the wrong python, the
   * reported failure. */
  const { recommendFor, readMachine, fitFor } = await import("./fit.js");
  const machine = readMachine({ name: "NVIDIA GeForce RTX 4070 Ti SUPER", totalMb: 16376, usedMb: 0 }, { totalMb: 32659, usedMb: 0 });
  const caps = CATALOG.map((c) => ({ id: c.id, makes: c.makes || null, label: c.label, licence: c.licence, requires: c.requires || null,
    needsPackage: c.needsPackage || null, packageInstall: c.packageInstall || null,
    packageReady: c.id !== "lyrics", packageMissing: c.id === "lyrics" ? ["stable_whisper"] : [],
    files: [], totalBytes: 0, haveBytes: 0, ready: false, fit: fitFor(c.requires, machine) }));
  const lp = recommendFor({ capabilities: caps, machine, disk: { freeBytes: 900e9 } }).packages.find((p) => p.id === "lyrics");
  ok("the recommendation names the missing module and the lyrics python, not 'your SYSTEM Python'",
    /`stable_whisper`/.test(lp?.why || "") && (lp?.why || "").includes(config.lyrics.python) && !/SYSTEM Python/.test(lp?.why || ""), lp?.why);
  const { modelTools } = await import("./mcp-models.js");
  const mft = modelTools(async () => ({ capabilities: [{ id: "lyrics", label: "Timed lyrics", packageReady: false,
    needsPackage: "faster_whisper", packageMissing: ["stable_whisper"], packageInstall: LYRICS.packageInstall }] }))
    .find((t) => t.name === "models_for_this_machine");
  const mrow = (await mft.run({ all: true })).capabilities?.[0];
  ok("models_for_this_machine names the module that is missing", mrow?.needsPackage === "stable_whisper", JSON.stringify(mrow));
  const { NEED_STATES } = await import("./welcome/catalogue.js");
  ok("the welcome panel's 'Not installed' line points at the interpreter under it, not 'your SYSTEM Python'",
    !/SYSTEM Python/.test(NEED_STATES?.absent?.line || "SYSTEM Python") && /interpreter named below/.test(NEED_STATES.absent.line),
    NEED_STATES?.absent?.line);
  ok("the Models screen names the missing ones (pkgWords reads packageMissing)",
    /const pkgWords = \(c\) => \{\s*\n\s*const m = c\.packageMissing\?\.length \? c\.packageMissing : \[c\.needsPackage\];/.test(read("web/app.js")));
}

/* ═══ 8. the docs say WHICH python ══════════════════════════════════════ */
console.log("\n  -- README.md and INSTALL.md --");
{
  for (const doc of ["README.md", "INSTALL.md"]) {
    const text = read(doc);
    /* The row's name is the catalogue label (scripts/models_table.mjs). */
    const at = text.indexOf("**Whisper: transcription and timed lyrics**");
    const row2 = at >= 0 ? text.slice(at, text.indexOf("\n\n", at)) : "";
    ok(`${doc}: the lyrics row says Studio's whisper venv, the setting and the variable`,
      row2.includes("%USERPROFILE%\\aiplay-whisper\\venv") && row2.includes(SETTING_WORDS) && row2.includes("AIPLAY_WHISPER_PYTHON"), row2);
    const want = installLines("aiplay-whisper\\venv\\Scripts\\python.exe", { platform: "win32", create: true });
    ok(`  and the verified lines, each as it pastes`, want.every((l) => row2.includes(`\`${l}\``)), row2);
  }
}

/* ═══ 9. the real lrc.py, fake whisper, any python ═════════════════════ */
console.log("\n  -- lrc.py: the device, the fallback, the JSON --");

/** A python that RUNS — located by executing it, never by `command -v`: on
 *  Windows the Store's App Execution Alias resolves and then prints "Python
 *  was not found". */
function findPython() {
  for (const c of [process.env.AIPLAY_TEST_PYTHON, config.systemPython, "python", "python3"].filter(Boolean)) {
    const r = spawnSync(c, ["-c", "import sys;print(sys.executable) if sys.version_info >= (3, 8) else sys.exit(1)"],
      { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
const PY = findPython();
if (!PY) {
  console.log("  skip  no python runs here; lrc.py's own half was not exercised");
} else {
  console.log(`        python: ${PY}`);
  const FAKE = path.join(TMP, "fake");
  const FAKE_DLL = path.join(TMP, "fake_dll");
  /* The fake Model says when it is FREED (__del__) and whether an exception is
   * being handled when a model is loaded: that is how the CPU pass is shown to
   * run after the CUDA model is gone, not while an except block holds it. */
  const stableWhisper = `
import os, sys
MODE = os.environ.get("FAKE_WHISPER", "ok")
if MODE == "missing":
    raise ModuleNotFoundError("No module named 'stable_whisper'", name="stable_whisper")

class LocalEntryNotFoundError(FileNotFoundError, ValueError):
    pass
LocalEntryNotFoundError.__module__ = "huggingface_hub.errors"

def _log(line):
    with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as fh:
        fh.write(line + "\\n")

class W:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end

class Seg:
    def __init__(self, words):
        self.words = words

class Res:
    def __init__(self, segments):
        self.segments = segments

class Model:
    def __init__(self, device, compute):
        self.device, self.compute = device, compute

    def __del__(self):
        try:
            _log("free %s" % self.device)
        except Exception:
            pass

    def transcribe(self, audio, **kw):
        _log("transcribe %s %s %s" % (self.device, os.path.basename(audio), sorted(kw.items())))
        if MODE == "abort" and self.device == "cuda":
            sys.stderr.write("Could not locate cudnn_ops64_9.dll. Please make sure it is in your library path!\\n")
            sys.stderr.write("Invalid handle. Cannot load symbol cudnnCreateTensorDescriptor\\n")
            sys.stderr.flush()
            os.abort()
        if MODE == "cublas" and self.device == "cuda":
            raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
        if MODE == "oom" and self.device == "cuda":
            raise RuntimeError("CUDA failed with error out of memory")
        if MODE == "vad":
            import urllib.error
            raise urllib.error.URLError("[WinError 10061] No connection could be made because the target machine actively refused it")
        if MODE == "noffmpeg":
            raise FileNotFoundError(2, "The system cannot find the file specified")
        words = os.environ.get("FAKE_HEARD", "hello world again").split()
        return Res([Seg([W(" " + w, 1.0 + i, 1.5 + i) for i, w in enumerate(words)])])

def load_faster_whisper(name, device, compute_type):
    _log("load %s %s %s" % (name, device, compute_type))
    _log("handling %s" % (sys.exc_info()[0].__name__ if sys.exc_info()[0] else "nothing"))
    if MODE == "download":
        raise LocalEntryNotFoundError("Cannot find an appropriate cached snapshot folder for the specified revision on the local disk and outgoing traffic has been disabled.")
    return Model(device, compute_type)
`;
  const ctranslate2 = `
import os
def get_cuda_device_count():
    v = os.environ.get("FAKE_CUDA_COUNT", "0")
    if v == "raise":
        raise RuntimeError("CUDA driver version is insufficient for CUDA runtime version")
    return int(v)
def get_supported_compute_types(device):
    v = os.environ.get("FAKE_CT2_TYPES", "int8_float16,float16,int8,float32")
    if v == "raise":
        raise AssertionError("get_supported_compute_types must not be called")
    return set(x for x in v.split(",") if x)
`;
  for (const root of [FAKE, FAKE_DLL]) {
    fs.mkdirSync(path.join(root, "ctranslate2"), { recursive: true });
    fs.writeFileSync(path.join(root, "stable_whisper.py"), stableWhisper);
    fs.writeFileSync(path.join(root, "ctranslate2", "__init__.py"), ctranslate2);
  }
  // A cuDNN front door of a version nothing on any machine provides the sub-libraries for.
  fs.writeFileSync(path.join(FAKE_DLL, "ctranslate2", "cudnn64_99.dll"), "");

  const lyr = path.join(TMP, "lyrics.txt");
  fs.writeFileSync(lyr, "[Verse]\nhello world\nagain\n");
  const outDir = path.join(TMP, "lrc_out");
  fs.mkdirSync(outDir, { recursive: true });
  const LOG = path.join(TMP, "fake_log.txt");
  const EMPTY_PATH = fs.mkdtempSync(path.join(TMP, "emptypath-"));

  const base = { ...process.env };
  delete base.AIPLAY_WHISPER_DEVICE;
  Object.assign(base, {
    PYTHONPATH: FAKE, PYTHONDONTWRITEBYTECODE: "1", CUDA_VISIBLE_DEVICES: "-1",
    FAKE_LOG: LOG, AIPLAY_WHISPER_MODEL: "large-v3", PYTHONIOENCODING: "utf-8",
  });
  /** Run the real lrc.py through the real node runner. */
  async function lrcPy(env = {}, args = ["song.flac", lyr, path.join(outDir, "song")]) {
    fs.writeFileSync(LOG, "");
    /* Windows keys its environment case-blind: a PATH beside the inherited
     * Path is two keys, and which one the child sees is not ours to choose. */
    const merged = { ...base };
    for (const k of Object.keys(env)) {
      for (const b of Object.keys(merged)) if (b.toUpperCase() === k.toUpperCase()) delete merged[b];
    }
    try {
      return { info: await runLrc({ python: PY, args, env: { ...merged, ...env }, log: quiet }) };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }
  const log = () => fs.readFileSync(LOG, "utf8").replace(/\r\n/g, "\n");

  // The machine this was built on: a CUDA card that offers int8_float16.
  let r = await lrcPy({ FAKE_CUDA_COUNT: "1" });
  ok("a capable GPU still runs cuda at int8_float16, as lrc.py always did",
    r.info?.ok && r.info.device === "cuda" && r.info.computeType === "int8_float16", JSON.stringify(r));
  ok("  the JSON names the device, the compute type and the model, and no cpuReason",
    r.info?.model === "large-v3" && !("cpuReason" in (r.info || {})), JSON.stringify(r.info));
  ok("  the model is loaded once, with the same arguments",
    log().split("\n").filter((l) => l.startsWith("load ")).join() === "load large-v3 cuda int8_float16", log());
  ok("  and transcribe gets exactly the arguments it always got",
    log().includes("[('regroup', True), ('suppress_silence', True), ('vad', True), ('verbose', None), ('word_timestamps', True)]"), log());
  // Text mode: lrc.py has always written CRLF on Windows; the content is what is pinned.
  const lineLrc = fs.readFileSync(path.join(outDir, "song.lrc"), "utf8").replace(/\r\n/g, "\n");
  ok("  and the LRC files are written as before",
    lineLrc === "[00:01.00]hello world\n[00:03.00]again"
      && fs.readFileSync(path.join(outDir, "song.word.lrc"), "utf8").startsWith("[00:01.00]hello "), JSON.stringify(lineLrc));

  // The marker, straight from lrc.py's stderr.
  const direct = spawnSync(PY, [LRC_SCRIPT, "song.flac", lyr, path.join(outDir, "m")], { encoding: "utf8", windowsHide: true,
    env: { ...base, FAKE_CUDA_COUNT: "1" } });
  ok("lrc.py writes '[lrc] device=cuda compute=int8_float16' to stderr once it has chosen",
    lastDevice(direct.stderr)?.device === "cuda" && lastDevice(direct.stderr)?.compute === "int8_float16", direct.stderr);

  r = await lrcPy({ FAKE_CUDA_COUNT: "1", AIPLAY_WHISPER_DEVICE: "cuda", FAKE_CT2_TYPES: "raise" });
  ok("AIPLAY_WHISPER_DEVICE=cuda is the old behaviour exactly: cuda, int8_float16, nothing probed",
    r.info?.device === "cuda" && r.info.computeType === "int8_float16", JSON.stringify(r));

  r = await lrcPy({ FAKE_CUDA_COUNT: "0" });
  ok("no CUDA GPU: the CPU at int8, and the JSON says why",
    r.info?.ok && r.info.device === "cpu" && r.info.computeType === "int8" && /no CUDA GPU/.test(r.info.cpuReason || ""), JSON.stringify(r));

  r = await lrcPy({ FAKE_CUDA_COUNT: "raise" });
  ok("a CUDA runtime that raises on the device count: the CPU, with the driver's words",
    r.info?.device === "cpu" && /driver version is insufficient/.test(r.info.cpuReason || ""), JSON.stringify(r));

  r = await lrcPy({ FAKE_CUDA_COUNT: "1", FAKE_CT2_TYPES: "int8,float32" });
  ok("a card without int8_float16 (GTX 10-series) gets the best type it has, on the GPU",
    r.info?.device === "cuda" && r.info.computeType === "int8", JSON.stringify(r));

  r = await lrcPy({ AIPLAY_WHISPER_DEVICE: "cpu", FAKE_CUDA_COUNT: "1" });
  ok("AIPLAY_WHISPER_DEVICE=cpu is honoured", r.info?.device === "cpu" && r.info.computeType === "int8", JSON.stringify(r));

  if (WIN) {
    r = await lrcPy({ FAKE_CUDA_COUNT: "1", PYTHONPATH: FAKE_DLL });
    ok("cuDNN's sub-libraries missing: the CPU BEFORE the uncatchable abort, naming them",
      r.info?.device === "cpu" && /cudnn_ops64_99\.dll, cudnn_cnn64_99\.dll/.test(r.info.cpuReason || ""), JSON.stringify(r));
    ok("  and cuda was never tried", !/load large-v3 cuda/.test(log()), log());
  }

  r = await lrcPy({ FAKE_CUDA_COUNT: "1", FAKE_WHISPER: "cublas" });
  ok("a catchable GPU failure (cuBLAS missing) is timed again on the CPU in-process",
    r.info?.ok && r.info.device === "cpu" && /cublas64_12\.dll/.test(r.info.cpuReason || ""), JSON.stringify(r));
  const seq = log().split("\n").filter(Boolean);
  const cpuLoad = seq.indexOf("load large-v3 cpu int8");
  ok("  the CUDA model is FREED before the CPU model loads (the retry is outside the except block)",
    cpuLoad > 0 && seq.indexOf("free cuda") >= 0 && seq.indexOf("free cuda") < cpuLoad, seq.join("\n"));
  ok("  and no exception is being handled while the CPU pass runs", seq[cpuLoad + 1] === "handling nothing", seq.join("\n"));

  r = await lrcPy({ FAKE_CUDA_COUNT: "1", FAKE_WHISPER: "oom" });
  ok("CUDA out of memory is NOT moved to the CPU (a busy card; minutes of CPU would hold the queue)",
    !r.info && !/load large-v3 cpu/.test(log()), JSON.stringify(r) + "\n" + log());
  ok("  it is named, with the two ways out, and the launcher to quit for the variable",
    /the GPU ran out of memory running whisper large-v3/.test(r.error || "")
      && /unload ComfyUI's models/.test(r.error || "") && /AIPLAY_WHISPER_DEVICE=cpu/.test(r.error || "")
      && (r.error || "").includes(ENV_RESTART), r.error);

  r = await lrcPy({ FAKE_CUDA_COUNT: "1", FAKE_WHISPER: "cublas", AIPLAY_WHISPER_DEVICE: "cuda" });
  ok("forced cuda does not fall back, and says how to",
    /the GPU could not run whisper \(Library cublas64_12\.dll/.test(r.error || "") && /AIPLAY_WHISPER_DEVICE=cpu/.test(r.error || ""), r.error);

  r = await lrcPy({ FAKE_CUDA_COUNT: "1", FAKE_WHISPER: "abort" });
  ok("a REAL native abort in lrc.py (os.abort after cuDNN's words) is rescued on the CPU by the node side",
    r.info?.ok && r.info.device === "cpu" && /the cuda run \(int8_float16\) crashed: .*cudnn/i.test(r.info.cpuReason || ""), JSON.stringify(r));

  const onCpuMark = spawnSync(PY, [LRC_SCRIPT, "song.flac", lyr, path.join(outDir, "c")], { encoding: "utf8", windowsHide: true,
    env: { ...base, FAKE_CUDA_COUNT: "0" } });
  ok("  and lrc.py marks a CPU run as cpu, so a crash there is never 'rescued' on the CPU",
    lastDevice(onCpuMark.stderr)?.device === "cpu" && lastDevice(onCpuMark.stderr)?.compute === "int8", onCpuMark.stderr);
  const cublasMark = spawnSync(PY, [LRC_SCRIPT, "song.flac", lyr, path.join(outDir, "b")], { encoding: "utf8", windowsHide: true,
    env: { ...base, FAKE_CUDA_COUNT: "1", FAKE_WHISPER: "cublas" } });
  ok("  and marks the in-process move to the CPU again (the LAST marker is where it stopped)",
    /device=cuda[\s\S]*device=cpu/.test(cublasMark.stderr) && lastDevice(cublasMark.stderr)?.device === "cpu", cublasMark.stderr);

  r = await lrcPy({ FAKE_WHISPER: "missing" });
  ok("stable-ts missing: named by its pip name, with the verified lines for the python Studio ran",
    (r.error || "").startsWith("Timed lyrics: stable-ts is not installed in ") && installLines(PY).every((l) => (r.error || "").includes(l))
      && (r.error || "").includes(SETTING_WORDS)
      && quotedProgram(r.error).length === 0 && !(r.error || "").includes(NEVER), r.error);
  ok("  lrc.py builds no install command of its own (one builder: server/lrc.js)",
    !/pip install/.test(read("server/lrc.py")), "lrc.py mentions pip install");

  r = await lrcPy({ FAKE_WHISPER: "download" });
  ok("a failed first-run model download says what, how big and from where",
    /could not download the whisper model large-v3 \(about 3 GB\)/.test(r.error || "") && /huggingface\.co/.test(r.error || ""), r.error);

  r = await lrcPy({ FAKE_WHISPER: "vad" });
  ok("a failed Silero VAD fetch during transcription is told apart from the model",
    /could not download Silero VAD from github\.com/.test(r.error || ""), r.error);

  r = await lrcPy({ FAKE_WHISPER: "noffmpeg", PATH: EMPTY_PATH });
  ok("no ffmpeg on PATH is named, with how to get it and that the launcher must be quit",
    /ffmpeg program and there is none on PATH/.test(r.error || "") && (r.error || "").includes(ENV_RESTART), r.error);

  r = await lrcPy({ AIPLAY_WHISPER_DEVICE: "gpu" });
  ok("a mistyped AIPLAY_WHISPER_DEVICE is refused in words", /must be auto, cuda or cpu/.test(r.error || ""), r.error);

  r = await lrcPy({}, ["only-one-arg"]);
  ok("a crash OUTSIDE the try block (bad argv) is still one JSON line",
    /^lrc\.py crashed: IndexError/.test(r.error || ""), r.error);

  r = await lrcPy({ FAKE_CUDA_COUNT: "0" }, ["song.flac", lyr, path.join(TMP, "no", "such", "dir", "song")]);
  ok("  and so is a failure writing the LRC (not mislabelled as transcription)",
    /^lrc\.py crashed: FileNotFoundError/.test(r.error || ""), r.error);

  /* The whole door once more, through the REAL ArtRunner: art.js hands lrc.py
   * the song, the lyrics file and the output stem, and the event carries both
   * LRC names plus what lrc.py said about the device. */
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(PYTHONPATH|AIPLAY_WHISPER_DEVICE)$/i.test(k)) delete process.env[k];
  Object.assign(process.env, { PYTHONPATH: FAKE, PYTHONDONTWRITEBYTECODE: "1", CUDA_VISIBLE_DEVICES: "-1",
    FAKE_LOG: LOG, FAKE_CUDA_COUNT: "0" });
  config.lyrics.python = PY;
  fs.writeFileSync(LOG, "");
  const done = await timeLyrics("song2.flac", "hello world\nagain");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  // art.js drops the temp lyrics file without awaiting it; give the unlink a moment.
  for (let i = 0; i < 20 && fs.readdirSync(config.paths.appData).some((n) => /^lyr_\d+\.txt$/.test(n)); i++) {
    await new Promise((res) => setTimeout(res, 50));
  }
  const lrcDir = path.join(config.outputDir, "lyrics");
  ok("a real lrc job through art.js returns both LRC names and the device",
    done.ok?.lrc === "song2.lrc" && done.ok?.wordLrc === "song2.word.lrc" && done.ok?.device === "cpu"
      && /no CUDA GPU/.test(done.ok?.cpuReason || ""), JSON.stringify(done));
  ok("  the files are where the library looks for them",
    fs.existsSync(path.join(lrcDir, "song2.lrc")) && fs.existsSync(path.join(lrcDir, "song2.word.lrc")));
  ok("  lrc.py was handed the song under the output folder",
    log().includes(`transcribe cpu song2.flac`), log());
  ok("  and the temporary lyrics file is gone",
    !fs.readdirSync(config.paths.appData).some((n) => /^lyr_\d+\.txt$/.test(n)), fs.readdirSync(config.paths.appData).join());

  // lrc.py's restart words and lrc.js's are one sentence.
  ok("lrc.py's ENV_RESTART is lrc.js's", read("server/lrc.py").includes(`ENV_RESTART = "${ENV_RESTART}"`));

  // The folder names that broke the old path, for real: python opens lrc.py there.
  const spacedDir = path.join(TMP, "Programs", "AIPLAY Studio Zoë", "server");
  fs.mkdirSync(spacedDir, { recursive: true });
  fs.copyFileSync(path.join(HERE, "lrc.py"), path.join(spacedDir, "lrc.py"));
  const emptyLyr = path.join(TMP, "instrumental.txt");
  fs.writeFileSync(emptyLyr, "[Instrumental]\n");
  const url = pathToFileURL(path.join(spacedDir, "art.js")).href;
  const good = await failWith({ python: PY, script: besideModule(url, "lrc.py"), args: ["x.flac", emptyLyr, "o"], env: base });
  ok("from 'AIPLAY Studio Zoë', python opens the script besideModule names (lrc.py answers)",
    good === "no lyric lines (instrumental?)", good);
  const bad = await failWith({ python: PY, script: path.join(path.dirname(new URL(url).pathname.slice(1)), "lrc.py"),
    args: ["x.flac", emptyLyr, "o"], env: base });
  ok("  the old idiom's path is refused by python, and now the message says so",
    /could not open its script/.test(bad || "") && !(bad || "").includes(NEVER), bad);

  // The DLL check itself, on Windows (it is a no-op elsewhere).
  if (WIN) {
    const probe = spawnSync(PY, ["-c", [
      "import sys, os, json, tempfile",
      `sys.path.insert(0, ${JSON.stringify(HERE)})`,
      "import lrc",
      "d = tempfile.mkdtemp()",
      "open(os.path.join(d, 'cudnn64_9.dll'), 'w').close()",
      "e = tempfile.mkdtemp()",
      "open(os.path.join(e, 'cudnn64_8.dll'), 'w').close()",
      "print(json.dumps({'missing': lrc.missing_dlls(['kernel32.dll', 'cudnn_ops64_99.dll']),",
      "  'v9': lrc.cudnn_libs(d), 'v8': lrc.cudnn_libs(e), 'none': lrc.cudnn_libs(tempfile.mkdtemp())}))",
    ].join("\n")], { encoding: "utf8", env: { ...base }, windowsHide: true });
    let jj = null; try { jj = JSON.parse(probe.stdout); } catch { /* shown below */ }
    ok("missing_dlls: a mapped DLL is present, an absent one is missing",
      JSON.stringify(jj?.missing) === '["cudnn_ops64_99.dll"]', probe.stdout + probe.stderr);
    ok("cudnn_libs reads the cuDNN major from ctranslate2's own front door",
      JSON.stringify(jj?.v9) === '["cudnn_ops64_9.dll","cudnn_cnn64_9.dll"]'
        && JSON.stringify(jj?.v8) === '["cudnn_ops_infer64_8.dll","cudnn_cnn_infer64_8.dll"]'
        && JSON.stringify(jj?.none) === "[]", probe.stdout + probe.stderr);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\n  FAILED:\n    ${failures.join("\n    ")}`);
  process.exit(1);
}
process.exit(0);
