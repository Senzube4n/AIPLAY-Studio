#!/usr/bin/env node
/**
 * The pip half of the install, with YOUR paths already in it.
 *
 * WHY THIS EXISTS. Three capabilities are Python packages rather than files, so
 * the Models screen has a row and no button for them. INSTALL.md called them
 * "the rough edges" and told the reader to "install them somewhere and point
 * Studio at that Python with AIPLAY_SYS_PYTHON" — which is true, and is not a
 * command anybody can type. This prints the commands.
 *
 * ⚠ AND IT AIMS THEM AT THE RIGHT INTERPRETER, WHICH IS THE WHOLE POINT.
 * Studio uses three different Pythons on purpose (INSTALL.md §5): ComfyUI's must
 * stay on the cu130 torch build, because the fused int8 kernels the music model
 * needs exist only there and letting pip resolve `demucs`' or `ctranslate2`'s
 * torch requirement inside it silently costs 4.9x the speed of everything, with
 * one line in a log nobody reads. So `pip install demucs` into the wrong Python
 * is not a mistake that fails — it is a mistake that keeps working, slowly. A
 * generic `python -m pip install demucs` in a document is exactly how somebody
 * makes it.
 *
 * The paths come from server/config.js, which reads the same settings.json that
 * setup.mjs wrote — the technique scripts/fetch_ltx25.py already uses to find
 * the rig instead of hard-coding one machine's folder.
 *
 *   node scripts/extras_setup.mjs           what to run, and what is already installed
 *   node scripts/extras_setup.mjs --quiet    only the parts that are missing
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../server/config.js";
import { CATALOG, modulesOf } from "../server/models.js";
import { runLines, installLines, venvOf, SETTING_WORDS, PYTHON_MIN, ENV_RESTART } from "../server/lrc.js";

/**
 * Which interpreter each capability's package has to land in.
 *
 * ⚠ These are not choices made here. Each one names the line in the server that
 * actually spawns the process, and server/docs_test.js reads those files and
 * fails if the pairing stops being true — so this table cannot quietly drift
 * into telling people to install into a Python nothing runs.
 */
const TARGETS = [
  {
    id: "audioRef",
    python: () => config.systemPython,
    setting: "AIPLAY_SYS_PYTHON",
    spawnedBy: ["server/index.js", "config.systemPython"],
    why: "dav_encode.py runs outside ComfyUI — ComfyUI's own DAV cannot encode audio.",
  },
  {
    id: "stems",
    python: () => config.systemPython,
    setting: "AIPLAY_SYS_PYTHON",
    spawnedBy: ["server/art.js", "config.systemPython"],
    why: "demucs pulls its own torch. In ComfyUI's venv that torch replaces the cu130 build.",
  },
  {
    id: "lyrics",
    python: () => config.lyrics.python,
    setting: "AIPLAY_WHISPER_PYTHON",
    spawnedBy: ["server/art.js", "config.lyrics.python"],
    why: "ctranslate2 expects a different torch again, so faster-whisper gets a venv of its own.",
  },
];

const has = (py) => !!py && existsSync(py);

/** Is EVERY module importable in that interpreter? A missing interpreter is a
 *  different answer from a missing package and gets a different sentence.
 *  Every one, not the first: timed lyrics imports stable_whisper as well as
 *  faster_whisper, and checking only the second said "Nothing to do" over a
 *  venv where every run failed. */
function probe(py, mods) {
  return new Promise((res) => {
    if (!has(py)) return res("no-python");
    const p = spawn(py, ["-c", `import importlib.util as u,sys;sys.exit(0 if all(u.find_spec(m) for m in ${JSON.stringify(mods)}) else 1)`],
      { windowsHide: true });
    p.on("error", () => res("no-python"));
    p.on("exit", (c) => res(c === 0 ? "present" : "missing"));
  });
}

const quiet = process.argv.includes("--quiet");
const line = (s = "") => console.log(s);

line();
line("  AIPLAY Studio — the packages Studio cannot download for you");
line("  " + "-".repeat(58));
line();
line("  These are pip packages, not model files. Each goes in the interpreter");
line("  Studio will actually run it with — NOT ComfyUI's, which must stay on its");
line("  cu130 torch build or the whole app quietly runs about 5x slower.");
line();

let missing = 0;
for (const t of TARGETS) {
  const cap = CATALOG.find((c) => c.id === t.id);
  if (!cap) continue;
  const py = t.python();
  const mods = modulesOf(cap);
  const state = await probe(py, mods);
  if (state === "present" && quiet) continue;

  const mark = state === "present" ? "OK  " : state === "missing" ? "GET " : "??  ";
  line(`  ${mark}${cap.label}`);
  line(`        ${t.why}`);
  line(`        python: ${py}${has(py) ? "" : "   ← does not exist on this machine"}`);
  if (state === "present") {
    line(`        ${mods.map((m) => `\`${m}\``).join(" and ")} ${mods.length > 1 ? "import" : "imports"} here already. Nothing to do.`);
  } else {
    missing++;
    /* The catalogue holds the command with a bare `python`; the only thing
     * added here is which python, by the ONE builder every install message in
     * Studio uses (server/lrc.js runLines). It used to substitute `"<py>"`,
     * and a quoted program is a parse error in PowerShell. Timed lyrics gets the
     * verified set: its venv when the python is missing, CUDA torch, then
     * faster-whisper and stable-ts. */
    const cmds = t.id === "lyrics"
      ? installLines(py, { create: state === "no-python" })
      : runLines(py, [(cap.packageInstall || "").replace(/^python\s+/, "")]);
    line(`        run, one line at a time${process.platform === "win32" ? " (Command Prompt or PowerShell)" : ""}:`);
    for (const c of cmds) line(`          ${c}`);
    if (t.id === "lyrics") line(`        The torch line is for an NVIDIA card only (it puts whisper on the GPU).`);
    if (state === "no-python" && t.id === "lyrics") {
      // installLines adds the venv line only when that python sits in a venv.
      line(venvOf(py)
        ? `        That interpreter is missing; the first line creates it (${PYTHON_MIN}).`
        : `        That interpreter is missing. Install ${PYTHON_MIN} there first.`);
      line(`        Or choose a python you already have in ${SETTING_WORDS}.`);
    } else if (state === "no-python") {
      /* setx, not set: set lasts one console window, and Studio is started by
       * the launcher, which keeps the environment it was started with. */
      line(`        That interpreter is missing. Install Python 3.10+ there, or point Studio`);
      line(`        at one you have:  setx ${t.setting} "C:\\path\\to\\python.exe"`);
      line(`        then ${ENV_RESTART}.`);
    }
  }
  line();
}

/* Account-gated models have an in-app flow. They are not missing Python
 * packages and should not send a normal installation back to a terminal. */
const ltx = CATALOG.find((c) => c.gated);
if (ltx && (!quiet || missing)) {
  line(`  OPTIONAL  ${ltx.label}`);
  line(`        Open Studio > Models > Set up LTX. Approve publisher access,`);
  line(`        connect a Hugging Face read token there, then choose Install.`);
  line(`        Studio handles the folders, resume and file verification.`);
  line(`        Licence and access: ${ltx.gated.url}`);
  line(`        You can skip LTX and use the rest of Studio.`);
  line();
}

line(missing
  ? `  ${missing} package group${missing === 1 ? "" : "s"} to install. Everything else in Studio works without them.`
  : "  Every optional package is already installed.");
line();
