/**
 * Timed lyrics — starting server/lrc.py, and saying why it did not work.
 *
 * WHY THIS FILE EXISTS. art.js used to spawn lrc.py, keep stdout, discard
 * stderr, the exit code and any spawn error, and throw "alignment failed" for
 * anything that was not a JSON {ok,…}. Measured on a fresh machine, four of the
 * five ways timed lyrics fails ended as those same two words:
 *
 *   - the whisper python does not exist (spawn ENOENT) — the usual case for a
 *     new user, who ran `pip install` into whatever python was on PATH;
 *   - the script path was percent-encoded ("AIPLAY%20Studio"), so python could
 *     not open lrc.py and said so on stderr;
 *   - cuDNN could not find its sub-libraries and ABORTED the process natively,
 *     with the one useful sentence on stderr;
 *   - a python exception outside lrc.py's own try block.
 *
 * So every failure now names its cause. The python's own JSON error is used
 * when there is one (lrc.py classifies its exceptions itself); when there is
 * none, the exit code, the interpreter, the device lrc.py said it was on and the
 * tail of stderr are turned into a sentence here, and the tail goes to the log.
 *
 * The cause comes FIRST in every message: status().recent[].error keeps only
 * 200 characters, and the Jobs row shows nothing else.
 *
 * EVERY INSTALL COMMAND A PERSON SEES IS BUILT HERE (installLines), and lrc.py
 * prints none of its own: it says `needsInstall` and this file adds the lines.
 * Two builders is how the first version of this fix came to offer a quoted
 * `"C:\…\python.exe" -m pip …` that PowerShell refuses to parse.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./models.js";

/** A file beside the module whose `import.meta.url` is given.
 *
 *  `fileURLToPath`, never `new URL(…).pathname.slice(1)`: that
 *  keeps the percent-encoding, so the installer's default folder
 *  "…\Programs\AIPLAY Studio" became "AIPLAY%20Studio" and python was handed a
 *  script that does not exist. (It also turned every POSIX path relative.) */
export const besideModule = (url, name) => path.join(path.dirname(fileURLToPath(url)), name);

export const LRC_SCRIPT = besideModule(import.meta.url, "lrc.py");

/** Whisper as a general tool (server/whisper.py): transcribe any file, and
 *  time known lyrics. It imports lrc.py's device logic and prints the same
 *  JSON and the same device marker, so runLrc() below runs it unchanged:
 *  `runLrc({ script: WHISPER_SCRIPT, args: whisperArgs(spec), … })`. */
export const WHISPER_SCRIPT = besideModule(import.meta.url, "whisper.py");

/** whisper.py's argv (after the script) from an already validated spec:
 *  { input, lyricsFile?, outStem?, language?, words?, vocals? }. The lyrics go
 *  in a FILE for the reason #timeLyrics gives: newlines and quotes on argv. */
export function whisperArgs({ input, lyricsFile = null, outStem = null, language = null, words = false, vocals = null }) {
  const args = [String(input)];
  if (lyricsFile) args.push("--lyrics", String(lyricsFile));
  if (outStem) args.push("--out", String(outStem));
  if (language) args.push("--language", String(language));
  if (words) args.push("--words");
  if (vocals) args.push("--vocals", String(vocals));
  return args;
}

/* ──────────────────────────────────────────────────────── the install lines */

/** Where a person changes the interpreter without an environment variable.
 *  web/index.html's label and this sentence are pinned together by lrc_test.js. */
export const SETTING_WORDS = 'Settings > Songs > "timed lyrics python"';

/** An environment variable reaches the server only through the process that
 *  starts it, and the launcher keeps its own environment: `setx` and then
 *  "restart Studio" from the launcher changed nothing. Measured on the report. */
export const ENV_RESTART = "quit AIPLAY Studio completely, launcher included, and start it again";

/** Measured 2026-09-23 on a clean Python 3.11 venv: torch 2.14.0+cu126 (CUDA
 *  True), ctranslate2 4.8.2, faster-whisper 1.2.1, stable-ts 2.19.1, then a real
 *  alignment through lrc.py returned ok:true. Unpinned on purpose: the earlier
 *  pin to torch 2.5.1 on the CUDA 12.1 index has no Windows wheel for Python
 *  3.13 or 3.14 (checked on the index), so it failed for anyone on a current
 *  Python. lrc_test.js refuses any install text that pins torch again. */
export const TORCH_PIP = "-m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu126";
export const PYTHON_MIN = "Python 3.11 or newer";

/** The catalogue's install line without its leading `python`: the Models
 *  screen, the docs and these messages then name one set of packages. */
export function whisperPip() {
  const cap = CATALOG.find((c) => c.id === "lyrics");
  return String(cap?.packageInstall || "").replace(/^python\s+/, "");
}

/** Characters that make a bare command word mean something else to cmd.exe or
 *  PowerShell: whitespace ends it, and the rest are operators in one or both. */
const WIN_UNSAFE = /[\s"&()'`$;,{}@^%!<>|]/;

/**
 * `py <args>` as lines a person pastes, one per element of `argLists`.
 *
 * WHY NOT `"C:\…\python.exe" -m pip …`. cmd accepts a quoted program; PowerShell
 * reads a leading quoted string as a VALUE and stops at `-m` with a parse error,
 * and PowerShell is what a Windows 11 terminal opens. So on Windows:
 *   - a path with nothing either shell would read as syntax is written bare,
 *     which both run as it stands;
 *   - any other path gets `pushd "<its folder>"` and then `.\python.exe …`,
 *     which both run. pushd rather than cd because cmd's `cd` does not change
 *     DRIVE: a venv on D: from a prompt on C: would run the wrong `.\python.exe`
 *     or none; pushd switches the drive in cmd and is Push-Location in PowerShell.
 * Everywhere else a quoted program is ordinary shell, so it is quoted when it
 * needs to be. `platform` is a parameter so the test pins both on one machine.
 */
export function runLines(py, argLists, { platform = process.platform } = {}) {
  if (platform !== "win32") {
    const exe = /^[\w@%+=:,./-]+$/.test(py) ? py : `'${String(py).replace(/'/g, "'\\''")}'`;
    return argLists.map((a) => `${exe} ${a}`);
  }
  if (!WIN_UNSAFE.test(py)) return argLists.map((a) => `${py} ${a}`);
  return [`pushd "${path.win32.dirname(py)}"`, ...argLists.map((a) => `.\\${path.win32.basename(py)} ${a}`)];
}

/** An argument, always quoted, as the verified `python -m venv "<venv>"` has
 *  it. Quoted ARGUMENTS parse the same in cmd, PowerShell and a POSIX shell;
 *  only a quoted PROGRAM differs. */
const quoteArg = (s) => `"${s}"`;

/** `<venv>/Scripts/python.exe` or `<venv>/bin/python` → `<venv>`, else null.
 *  path.win32 reads both separators, so a POSIX path is judged right here too. */
export function venvOf(py, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dir = p.dirname(String(py || ""));
  const leaf = p.basename(dir).toLowerCase();
  return leaf === "scripts" || leaf === "bin" ? p.dirname(dir) : null;
}

/**
 * The verified commands, aimed at `py`: the venv (when `create` and `py` sits in
 * one), CUDA torch (NVIDIA only), then faster-whisper and stable-ts. Commands
 * only, nothing else on a line, so each one pastes as it stands; the NVIDIA
 * condition is said in the sentence around them, never after a command, where
 * cmd would hand it to pip and PowerShell would parse it.
 */
export function installLines(py, { platform = process.platform, create = false } = {}) {
  const venv = venvOf(py, platform);
  const first = create && venv ? [`${platform === "win32" ? "python" : "python3"} -m venv ${quoteArg(venv)}`] : [];
  return [...first, ...runLines(py, [TORCH_PIP, whisperPip()], { platform })];
}

/** installLines as the indented block a message ends with, and the one
 *  sentence that says which line is conditional. */
export function installBlock(py, opts = {}) {
  const platform = opts.platform || process.platform;
  const lines = installLines(py, { ...opts, platform });
  const shells = platform === "win32" ? " (Command Prompt or PowerShell, one line at a time)" : "";
  return `${shells}:\n    ${lines.join("\n    ")}\n`
    + `  The torch line is for an NVIDIA card (it puts whisper on the GPU); without one, skip it.`;
}

const fromEnv = (py) => !!py && process.env.AIPLAY_WHISPER_PYTHON === py;

/** What else a person can do, depending on where Studio got the path. When
 *  AIPLAY_WHISPER_PYTHON names it, the Settings field changes nothing (the
 *  environment wins), so saying "choose it in Settings" would be a dead end. */
function elsewhere(py, env) {
  return env
    ? ` AIPLAY_WHISPER_PYTHON names this python and wins over Settings: correct or remove it, then ${ENV_RESTART}.`
    : ` Or, if you already have a python with them, choose it in ${SETTING_WORDS}; that takes effect at once.`;
}

/** THE BUTTON THAT MAKES THE INTERPRETER (server/setup/venv.js, POST
 *  /api/setup { action: "run", id: SETUP_FEATURE }). The refusal on "Time the
 *  lyrics" carries this id so the page can offer it, and every sentence below
 *  names it first: it needs no Python on PATH and no pasted command. */
export const SETUP_FEATURE = "lyrics";
export const SETUP_BUTTON = "Set up timed lyrics";

/** The one-click way, unless AIPLAY_WHISPER_PYTHON names the interpreter:
 *  then the environment wins over what the button would choose, and offering
 *  it would be a dead end. */
const setupHint = (env) => (env ? ""
  : `The easy way: press ${SETUP_BUTTON} in Settings > Songs (or on the timed lyrics row of the Models screen), `
    + "and Studio builds a private Python with faster-whisper and stable-ts; no system Python is needed. By hand: ");

/** What a person does when the interpreter Studio runs is not there. */
export function missingPythonMessage(py, { platform = process.platform, env = fromEnv(py) } = {}) {
  const venv = venvOf(py, platform);
  const make = venv
    ? `Create it with ${PYTHON_MIN}${installBlock(py, { platform, create: true })}`
    : `Install ${PYTHON_MIN} there, then${installBlock(py, { platform })}`;
  return `Timed lyrics has no Python to run: ${py} does not exist. `
    + `Studio runs timed lyrics only in that interpreter, not the python you type at a prompt. `
    + `${setupHint(env)}${make}${elsewhere(py, env)}`;
}

/** A python that is there but lacks a module timed lyrics imports. */
export function missingModuleMessage(py, modules, { platform = process.platform, env = fromEnv(py) } = {}) {
  const names = modules.map((m) => PIP_NAME[m] || m);
  return `Timed lyrics: ${names.join(" and ")} ${names.length > 1 ? "are" : "is"} not installed in ${py}. `
    + `${setupHint(env)}Install what timed lyrics needs${installBlock(py, { platform })}${elsewhere(py, env)}`;
}

/** pip's name for each module lrc.py imports. Typing the import name at pip
 *  installs somebody else's package, so the two are never swapped. */
export const PIP_NAME = { faster_whisper: "faster-whisper", stable_whisper: "stable-ts" };

/** Refuse before queueing: the sentence when the configured interpreter is an
 *  absolute path with nothing at it, else null. A bare name ("python") is left
 *  to PATH and to the spawn, which reports it just as clearly. */
export function whisperPythonMissing(py) {
  return py && path.isAbsolute(py) && !existsSync(py) ? missingPythonMessage(py) : null;
}

/**
 * The words for Settings and the timed_lyrics_python tool: where the
 * interpreter came from, and whether both modules import in it. `modules` is
 * { name: bool } from the same probe the Models screen runs.
 */
export function pythonVerdict({ python, chosen = null, modules = {}, platform = process.platform }) {
  const env = fromEnv(python);
  const source = env ? "AIPLAY_WHISPER_PYTHON" : chosen ? "Settings" : "the default";
  const missingPython = whisperPythonMissing(python);
  const missing = Object.entries(modules).filter(([, v]) => !v).map(([k]) => k);
  const ready = !missingPython && !missing.length;
  let note;
  if (env && chosen && chosen !== python) {
    note = `AIPLAY_WHISPER_PYTHON is set and wins over the path chosen here, so timed lyrics still run in ${python}. `
      + `Remove it, then ${ENV_RESTART}, to use ${chosen}.`;
  } else if (missingPython) {
    note = missingPython;
  } else if (missing.length) {
    note = missingModuleMessage(python, missing, { platform, env });
  } else {
    note = `Timed lyrics run in ${python}, and faster-whisper and stable-ts both import there.`;
  }
  return { python, chosen, source, modules, ready, note: mask(note) };
}

/* ─────────────────────────────────────────────────────────── reading output */

/** lrc.py's result: the LAST line that is a JSON object with an `ok` key.
 *
 *  Lines are split on \r as well as \n because whisper's progress bars are
 *  drawn with carriage returns, and a bar glued to the front of the JSON on one
 *  "line" once made a completed alignment look like a failure. The old rule —
 *  first "{" to last "}" — is kept as the fallback. */
export function parseResult(stdout) {
  const text = String(stdout || "");
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    const at = l.startsWith("{") ? 0 : l.lastIndexOf('{"ok"');
    if (at < 0) continue;
    try {
      const v = JSON.parse(l.slice(at));
      if (v && typeof v === "object" && "ok" in v) return v;
    } catch { /* not this line */ }
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { const v = JSON.parse(m[0]); if (v && typeof v === "object") return v; } catch { /* none */ }
  }
  return null;
}

/** lrc.py writes "[lrc] device=<d> compute=<ct>" to stderr, flushed, as soon
 *  as it has chosen, and again if it moves to the CPU in-process. The LAST one
 *  is where it was when it stopped. Without it a native abort (no JSON) could
 *  not be told apart from a CPU crash, and was re-run "on the CPU" regardless. */
const MARKER_RE = /^\[lrc\] device=(\S+) compute=(\S+)$/;
export function lastDevice(stderr) {
  let got = null;
  for (const l of String(stderr || "").split(/\r\n|\r|\n/)) {
    const m = MARKER_RE.exec(l.trim());
    if (m) got = { device: m[1], compute: m[2] };
  }
  return got;
}

const PY_ERROR_RE = /^[A-Za-z_][\w.]*(?:Error|Exception|Interrupt)\b/;
const PROGRESS_RE = /^\s*\d{1,3}%\||\|\s*\d+(?:\.\d+)?\/\d+(?:\.\d+)?\s*\[/;
/** A warning is not the failure. huggingface_hub's symlink UserWarning names
 *  huggingface.co on every first run on Windows, and it read as "could not
 *  download its model" above a cuDNN abort. Kept in what a person is SHOWN;
 *  left out of what the message is decided from. */
const WARNING_RE = /Warning:|warnings\.warn/;

/** Every rule is applied to lrc.py's own JSON error AND to the stderr tail,
 *  and to the final message: a token must not reach the Jobs row, the log or
 *  the launcher's window by any of the three. */
const SECRET_RULES = [
  [/\b(?:hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]"],
  // "Authorization: Bearer <token>": the key=value rule used to stop at the
  // space and mask the word "Bearer", leaving the token itself in plain text.
  // So a key=value in any case keeps a scheme word it finds and masks what
  // follows it ("authorization: bearer <token>" as well)...
  [/((?:token|api[_-]?key|password|passwd|secret|authorization)["']?\s*[:=]\s*["']?)((?:Bearer|Basic)\s+)?[^\s"',]+/gi, "$1$2[redacted]"],
  // ...and a bare scheme with no key before it is matched in the case RFC 7235
  // writes it. Case-insensitive, it redacted prose: "running basic
  // transcription" lost a word.
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1$2[redacted]"],
  // Credentials inside a URL: https://user:secret@host/…
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1[redacted]@"],
];
export function mask(text) {
  let s = String(text ?? "");
  for (const [re, to] of SECRET_RULES) s = s.replace(re, to);
  return s;
}

/** The last few lines of stderr worth reading: no blanks, no progress bars, no
 *  device markers (the message states the device itself), tokens masked, each
 *  line capped. Paths are kept: it is the user's own machine, and the path is
 *  usually the answer. */
export function stderrTail(se, n = 6) {
  return String(se || "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !PROGRESS_RE.test(l) && !MARKER_RE.test(l.trim()))
    .slice(-n)
    .map((l) => mask(l).slice(0, 300));
}

/** The lines a failure is classified from: the tail without warnings. */
function judgedTail(se) {
  return stderrTail(se, 16).filter((l) => !WARNING_RE.test(l)).slice(-8);
}

function exitText({ code, signal }) {
  if (signal) return `was stopped by ${signal}`;
  if (code == null) return "ended without an exit code";
  // A native crash on Windows is an NTSTATUS: 3221226505 means nothing, 0xC0000409 can be searched.
  return `exited ${code > 0xffff || code < 0 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : code}`;
}

export const GPU_LIB_RE = /cudnn|cublas|cudart|nvcuda|\bcuda\b|no CUDA-capable/i;
/** A line naming a CUDA library FILE. No leading \b: "libcudnn_ops.so.9". */
const GPU_DLL_RE = /(?:cudnn|cublas|cudart)\w*\.(?:dll|so)\b/i;
const OOM_RE = /out of memory|MemoryError|bad_alloc|CUBLAS_STATUS_ALLOC_FAILED|OutOfMemoryError/i;
const DOWNLOAD_RE = /huggingface|hf\.co\b|snapshot folder|LocalEntryNotFound|ConnectError|ConnectionError|getaddrinfo|Name or service not known|urlopen error|Max retries exceeded|outgoing traffic has been disabled|CERTIFICATE_VERIFY_FAILED|timed out/i;
const MODULE_RE = /No module named '([\w.]+)'/;
const STORE_ALIAS_RE = /Python was not found; run without arguments to install from the Microsoft Store/i;

const lineMatching = (tail, re) => [...tail].reverse().find((l) => re.test(l)) || "";
const headline = (tail) => lineMatching(tail, PY_ERROR_RE) || tail[tail.length - 1] || "";
/** The line that names the missing CUDA library, when one does; else any CUDA line. */
const gpuLine = (tail) => lineMatching(tail, GPU_DLL_RE) || lineMatching(tail, GPU_LIB_RE);

function deviceEnvAdvice() {
  return `set the environment variable AIPLAY_WHISPER_DEVICE=cpu (then ${ENV_RESTART})`;
}

/**
 * One run of the python that produced no usable answer → the sentence.
 * `r` is { stdout, stderr, code, signal, spawnError } plus `python` and `model`.
 */
export function explainFailure(r) {
  return mask(explainRaw(r));
}

function explainRaw(r) {
  const py = r.python;
  if (r.spawnError) {
    if (r.spawnError.code === "ENOENT") return missingPythonMessage(py);
    return `Timed lyrics could not start ${py} (${r.spawnError.code || r.spawnError.message}).${elsewhere(py, fromEnv(py))}`;
  }
  const judged = judgedTail(r.stderr);
  const all = judged.join("\n");
  const shownTail = stderrTail(r.stderr);
  const dev = lastDevice(r.stderr);
  const where = `[${py}${dev ? ` on ${dev.device}` : ""} ${exitText(r)}]`;
  const shown = shownTail.length > 1 ? `\n${shownTail.join("\n")}` : "";

  if (STORE_ALIAS_RE.test(all)) {
    return `Timed lyrics: ${py} is the Microsoft Store placeholder, not a real Python. `
      + `Install ${PYTHON_MIN} and choose its python.exe in ${SETTING_WORDS}. ${where}`;
  }
  if (/can't open file/i.test(all)) {
    return `Timed lyrics: python could not open its script: ${lineMatching(judged, /can't open file/i)} ${where}`;
  }
  const mod = all.match(MODULE_RE);
  if (mod) {
    const top = mod[1].split(".")[0];
    return `Timed lyrics: ${PIP_NAME[top] || top} is not installed in ${py} (No module named '${mod[1]}'). `
      + `Install what timed lyrics needs${installBlock(py)} ${where}`;
  }
  if (OOM_RE.test(all)) {
    return `Timed lyrics ran out of memory (${lineMatching(judged, OOM_RE)}). `
      + `Free the GPU (unload ComfyUI's models) or ${deviceEnvAdvice()}. ${where}${shown}`;
  }
  /* Before the download rule, not after it: cuDNN's own sentence names the
   * library FILE, and a download word elsewhere in the tail must not outrank it. */
  const gpuLib = () => `Timed lyrics: the GPU's CUDA libraries are missing or broken (${gpuLine(judged)}). `
    + `To time on the CPU, ${deviceEnvAdvice()}; to use the GPU, install the CUDA build of torch into that python`
    + `:\n    ${runLines(py, [TORCH_PIP]).join("\n    ")}\n  ${where}${shown}`;
  if (GPU_DLL_RE.test(all)) return gpuLib();
  if (DOWNLOAD_RE.test(all)) {
    const size = (r.model || "large-v3") === "large-v3" ? " (about 3 GB)" : "";
    return `Timed lyrics could not download its model: the first run fetches whisper ${r.model || "large-v3"}${size} `
      + `from huggingface.co and needs internet (${lineMatching(judged, DOWNLOAD_RE)}). ${where}${shown}`;
  }
  if (GPU_LIB_RE.test(all)) return gpuLib();
  if (!shownTail.length) {
    return `Timed lyrics: ${py}${dev ? ` on ${dev.device}` : ""} ${exitText(r)} and printed nothing: no result and no error.`;
  }
  return `Timed lyrics failed: ${headline(judged.length ? judged : shownTail)} ${where}${shown}`;
}

/** lrc.py answered in JSON and said no. Its sentence, plus the install lines
 *  when it asked for them (it builds none itself; see the header). */
function pythonSaid(info, python, run) {
  if (info.error) {
    /* lrc.py's own error passes through as it wrote it. A missing module gets
     * the same opening and the same way out as the other install sentences: a
     * Jobs row that reads "stable-ts is not installed in …" does not say what
     * failed, and the Settings field is the one fix that needs no prompt. */
    if (!info.needsInstall) return mask(info.error);
    const said = /^Timed lyrics:/.test(info.error) ? info.error : `Timed lyrics: ${info.error}`;
    return mask(`${said}. Install what timed lyrics needs${installBlock(python)}${elsewhere(python, fromEnv(python))}`);
  }
  const tail = stderrTail(run.stderr);
  return mask(`Timed lyrics: lrc.py reported a failure and gave no reason [${python} ${exitText(run)}]`
    + (tail.length ? `\n${tail.join("\n")}` : ""));
}

/* ─────────────────────────────────────────────────────────────── running */

function runOnce(launch, argv, env) {
  return new Promise((resolve) => {
    const r = { stdout: "", stderr: "", code: null, signal: null, spawnError: null };
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(r); } };
    let proc;
    try {
      proc = launch(argv, { windowsHide: true, env });
    } catch (err) {
      r.spawnError = err;
      return finish();
    }
    // Decoded as streams, so a character split across two chunks survives.
    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");
    proc.stdout?.on("data", (d) => (r.stdout += d));
    // The tail is what matters; a runaway library must not grow this without bound.
    proc.stderr?.on("data", (d) => { r.stderr = (r.stderr + d).slice(-64_000); });
    // 'close', not 'exit': it waits for stdout to drain, so the JSON is complete.
    proc.on("close", (code, signal) => { r.code = code; r.signal = signal; finish(); });
    proc.on("error", (err) => {
      r.spawnError = err;
      // ENOENT arrives before 'close'; an error after a real start only annotates.
      if (proc.pid === undefined) finish();
    });
  });
}

/**
 * Run lrc.py once — twice only when the GPU crashed natively — and return its
 * JSON result, or throw an Error whose message names the cause.
 *
 * THE SECOND RUN. cuDNN does not raise when its sub-libraries are missing: it
 * prints "Could not locate cudnn_ops64_9.dll" and aborts, so lrc.py can neither
 * catch it nor fall back itself. lrc.py looks for those libraries before it
 * loads the model, and this is the net under that check: a run whose LAST
 * device marker says cuda, that died with no JSON and a CUDA library on stderr,
 * is run again with AIPLAY_WHISPER_DEVICE=cpu — unless somebody set the device
 * on purpose. A run that was already on the CPU is never "re-run on the CPU".
 *
 * `python` is the interpreter the messages name; `launch` starts it, and by
 * default is exactly `spawn(python, …)`. art.js passes its own launch so the
 * spawn of config.lyrics.python stays where extras_setup.mjs says it is.
 */
export async function runLrc({
  python, args, env = process.env, script = LRC_SCRIPT, model = "large-v3",
  log = (...a) => console.error(...a), launch = (argv, opts) => spawn(python, argv, opts),
}) {
  const argv = [script, ...args];
  const first = await runOnce(launch, argv, env);
  const info = parseResult(first.stdout);
  if (info?.ok) return noted(info, log);
  if (info) throw new Error(pythonSaid(info, python, first));

  logTail(log, python, first);
  const wanted = String(env.AIPLAY_WHISPER_DEVICE || "auto").trim().toLowerCase();
  const ran = lastDevice(first.stderr);
  const judged = judgedTail(first.stderr).join("\n");
  if (!first.spawnError && wanted === "auto" && ran?.device === "cuda"
      && GPU_LIB_RE.test(judged) && !OOM_RE.test(judged)) {
    const why = `${gpuLine(judgedTail(first.stderr))} (${exitText(first)})`;
    log(`  [lrc] the ${ran.device} run (${ran.compute}) crashed: ${mask(why)}; timing again on the CPU`);
    const second = await runOnce(launch, argv, { ...env, AIPLAY_WHISPER_DEVICE: "cpu" });
    const again = parseResult(second.stdout);
    if (again?.ok) return noted({ ...again, cpuReason: mask(`the ${ran.device} run (${ran.compute}) crashed: ${why}`) }, log);
    if (!again) logTail(log, python, second);
    const reason = again ? pythonSaid(again, python, second) : explainFailure({ ...second, python, model });
    throw new Error(mask(`${reason} (on the CPU, after the ${ran.device} run crashed: ${why})`));
  }
  throw new Error(explainFailure({ ...first, python, model }));
}

function noted(info, log) {
  if (info.cpuReason) info.cpuReason = mask(info.cpuReason);
  if (info.device === "cpu" && info.cpuReason) log(`  [lrc] timed on the CPU: ${info.cpuReason}`);
  return info;
}

/** The whole tail goes to the launcher's Log; the message carries only its head. */
function logTail(log, python, r) {
  const tail = stderrTail(r.stderr, 20);
  const dev = lastDevice(r.stderr);
  if (tail.length) log(`  [lrc] ${python}${dev ? ` on ${dev.device}` : ""} ${exitText(r)}; its stderr ended:\n    ${tail.join("\n    ")}`);
}
