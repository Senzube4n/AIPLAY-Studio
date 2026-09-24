/**
 * A MISSING MODULE BECOMES AN INSTALL BUTTON (Tika's R4c), AND THE REPAIR
 * THAT BUTTON RUNS CANNOT LIE ABOUT SCIPY (R4d).
 *
 * "No module named 'scipy'" from hum-to-score, the tokenizer, the compositor
 * or the DAW used to reach the page as a traceback tail or a sentence with no
 * python path and no way forward. engineModuleRefusal() turns it into the R0
 * refusal: which module, which python, the pip line, and setup
 * "studio-packages" only where that setup would fix THIS python. Pinned:
 *
 *   §1  missingModuleOf reads the last "No module named 'x.y'" as "x"; a
 *       refusal reads only the run's FINAL line (a warning traceback earlier
 *       never stands in for the failure), also "cannot import name … (unknown
 *       location)" and "DLL load failed", and a dependency of one of the four
 *       as that one (the traceback's innermost site-packages frame);
 *   §1b the real import judges what the features load (scipy.signal,
 *       librosa's pitch tracker), against a half package on PYTHONPATH;
 *   §2  the four cases: Studio's engine gets the id; a foreign ComfyUI gets
 *       the pip line naming its python and no id; a module outside the list
 *       gets no id; a python outside the rig gets no id — each sentence exact;
 *       and offerSetup's first sentence survives a ". " inside the path;
 *   §3  the runner behind the id: a python outside the rig is blocked, with a
 *       pip line for only what is missing; missing SciPy is not ready (also
 *       when find_spec finds a broken one); the button says "Try again" only
 *       after a failed try; the offer names the constraints file and size, or,
 *       for an installed-but-broken module, that only adding happens in here;
 *       nothing is probed while its own pip job runs; one probe in flight per
 *       python, and a timed-out one is not asked again at once; the run is
 *       --add-only;
 *   §4  the callers: hum.js (a real spawn, through ffmpeg), the compositor's
 *       catalog door and the DAW's chirp door answer 409 with the fields.
 *
 * No network, no GPU. Every engine python here is a stand-in; §1b uses a
 * python from PATH (or AIPLAY_TEST_PYTHON) with only fake packages in front,
 * and says "skip" when there is none.
 *   node server/setup/engine-refusal_test.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, linkSync, copyFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-engine-refusal-"));
/* Before any module reads config: an isolated profile, output and rig. */
process.env.AIPLAY_APPDATA = path.join(tmp, "profile");
process.env.AIPLAY_OUTPUT = path.join(tmp, "output");
process.env.AIPLAY_RIG = path.join(tmp, "norig");
process.env.AIPLAY_DAW_NO_SERVE = "1";
process.env.AIPLAY_VFX_NO_SERVE = "1";

const {
  missingModuleOf, failedModuleOf, engineModuleRefusal, refusalError, engineRefusalFields, createEnginePackagesRunner,
  venvPython, samePath, forgetImports, importProbe, REPAIR_MODULES, PACKAGE_OF, ENGINE_SETUP_ID,
} = await import("./engine-packages.js");
const { MODULES_PROBE, IMPORT_OF } = await import("./studio-packages.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(HERE, "..", "..", rel), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

/** An engine folder as scripts/install-engine.mjs leaves it: a complete
 *  marker (when Studio's) and a venv python file (never run here). */
function engine(name, { studio = true } = {}) {
  const rig = path.join(tmp, name);
  mkdirSync(rig, { recursive: true });
  if (studio) writeFileSync(path.join(rig, ".aiplay-engine.json"), JSON.stringify({ complete: true, backend: "nvidia" }));
  const py = venvPython(rig);
  mkdirSync(path.dirname(py), { recursive: true });
  writeFileSync(py, "");
  return { rig, py };
}
const TRACE = "Traceback (most recent call last):\n  File \"x.py\", line 3, in <module>\n"
  + "    from scipy.signal import lfilter\nModuleNotFoundError: No module named 'scipy.signal'\n";

console.log("\n§1  WHICH MODULE");
ok("the repair list is Studio's four, each with its package", REPAIR_MODULES.join() === "cv2,librosa,soundfile,scipy"
  && PACKAGE_OF.cv2 === "opencv-python-headless" && PACKAGE_OF.scipy === "scipy");
ok("'scipy.signal' is scipy", missingModuleOf(TRACE) === "scipy");
ok("the LAST missing module in the text wins (the innermost failure)",
  missingModuleOf("No module named 'cv2'\n...\nImportError: No module named librosa.core") === "librosa");
ok("a traceback that names no missing module is null", missingModuleOf("ImportError: DLL load failed while importing cv2") === null
  && missingModuleOf("") === null && missingModuleOf(null) === null);
ok("samePath is case-insensitive on Windows only",
  samePath("C:\\E\\venv\\Scripts\\python.exe", "c:\\e\\VENV\\scripts\\PYTHON.EXE", "win32")
    && !samePath("/e/venv/bin/python", "/E/venv/bin/python", "linux") && !samePath(null, "x"));
{
  /* A refusal reads the run's final line only. xformers prints a whole
   * warning traceback naming triton on import; a resampler warns about
   * samplerate; neither is why the run stopped. */
  const SP = "C:\\E\\venv\\Lib\\site-packages";
  const XFORMERS = "Traceback (most recent call last):\n  File \"" + SP + "\\xformers\\__init__.py\", line 9\n"
    + "ModuleNotFoundError: No module named 'triton'\n";
  ok("a warning traceback naming a module, then an out-of-memory, is not a missing module (the OOM keeps its own sentence)",
    failedModuleOf(`${XFORMERS}Traceback (most recent call last):\n  File "yue_tokenize.py", line 80\nRuntimeError: CUDA out of memory\n`) === null);
  ok("...nor a UserWarning naming one before the tracker's own refusal",
    failedModuleOf("UserWarning: resampy not found (No module named 'samplerate')\nNo pitched notes were found - hum closer to the microphone.\n") === null);
  ok("...while the same stderr ending in a missing module is read from that last line",
    JSON.stringify(failedModuleOf(`${XFORMERS}Traceback (most recent call last):\n  File "engine.py", line 54\nModuleNotFoundError: No module named 'scipy.signal'\n`)) === '{"module":"scipy","named":"scipy"}');
  ok("a folder left with no __init__ ('cannot import name … (unknown location)') is that package",
    failedModuleOf("ImportError: cannot import name 'lfilter' from 'scipy.signal' (unknown location)")?.module === "scipy");
  ok("a DLL that will not load is the package whose frame loaded it",
    failedModuleOf("Traceback (most recent call last):\n  File \"engine.py\", line 54, in <module>\n"
      + `  File "${SP}\\scipy\\signal\\__init__.py", line 1\n  File "${SP}\\scipy\\special\\__init__.py", line 3\n`
      + "ImportError: DLL load failed while importing _ufuncs: The specified module could not be found.")?.module === "scipy"
      && failedModuleOf("ImportError: DLL load failed while importing cv2: The specified module could not be found.")?.module === "cv2");
  const lazy = failedModuleOf("Traceback (most recent call last):\n  File \"hum_to_abc.py\", line 40\n"
    + `  File "${SP}\\librosa\\__init__.py", line 5\nModuleNotFoundError: No module named 'lazy_loader'\n`);
  ok("a dependency one of the four imports (librosa's lazy_loader) is answered as that one, naming what was missing",
    lazy?.module === "librosa" && lazy.named === "lazy_loader", JSON.stringify(lazy));
  const cffi = failedModuleOf(`Traceback (most recent call last):\n  File "${SP}\\soundfile.py", line 17\nModuleNotFoundError: No module named '_cffi_backend'\n`);
  ok("...soundfile.py is a module file, not a folder, and counts too", cffi?.module === "soundfile", JSON.stringify(cffi));
  ok("...but a frame from an EARLIER traceback does not claim a later failure",
    failedModuleOf(`Traceback (most recent call last):\n  File "${SP}\\librosa\\__init__.py", line 5\nWarning\n`
      + "Traceback (most recent call last):\n  File \"x.py\", line 1\nModuleNotFoundError: No module named 'transformers'\n")?.module === "transformers");
  const noFrame = await engineModuleRefusal({ stderr: "ModuleNotFoundError: No module named '_cffi_backend'", feature: "x", python: "C:\\p\\python.exe" });
  ok("with no traceback to read, _cffi_backend's pip line names cffi, its real package", noFrame?.pip === "\"C:\\p\\python.exe\" -m pip install cffi", noFrame?.pip);
  ok("the real-import probe imports scipy.signal and librosa's pitch tracker, keyed by the module id",
    IMPORT_OF.scipy === "scipy.signal" && IMPORT_OF.librosa === "librosa.core.pitch"
      && /importlib\.import_module\(imp\.get\(n, n\)\)/.test(MODULES_PROBE) && /"scipy":"scipy\.signal"/.test(MODULES_PROBE));
}

console.log("\n§1b THE REAL IMPORT JUDGES WHAT THE FEATURES LOAD");
{
  /* A half-removed SciPy that `import scipy` still accepts (SciPy 1.9+ loads
   * scipy.signal lazily), and a librosa whose package imports but whose
   * pitch tracker cannot: fake packages in front of a real python. */
  const cand = process.env.AIPLAY_TEST_PYTHON || "python";
  const v = spawnSync(cand, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", windowsHide: true });
  if (v.status !== 0 || String(v.stdout).trim() !== "3") {
    console.log("  skip  no python 3 on PATH (set AIPLAY_TEST_PYTHON); the half-package probe was not run");
  } else {
    const half = path.join(tmp, "half");
    mkdirSync(path.join(half, "scipy", "signal"), { recursive: true });
    writeFileSync(path.join(half, "scipy", "__init__.py"), "");
    writeFileSync(path.join(half, "scipy", "signal", "__init__.py"), "from ._sigtools import _linear_filter\n");
    mkdirSync(path.join(half, "librosa", "core"), { recursive: true });
    writeFileSync(path.join(half, "librosa", "__init__.py"), "");
    writeFileSync(path.join(half, "librosa", "core", "__init__.py"), "");
    writeFileSync(path.join(half, "librosa", "core", "pitch.py"), "import aiplay_no_such_numba\n");
    const was = process.env.PYTHONPATH;
    process.env.PYTHONPATH = half;
    let got = null, bare = null;
    try {
      got = await importProbe(cand, ["scipy", "librosa"]);
      bare = spawnSync(cand, ["-s", "-c", "import scipy, librosa"], { encoding: "utf8", windowsHide: true });
    } finally { if (was === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = was; }
    ok("a half-removed SciPy that a bare `import scipy` accepts is NOT importing (scipy.signal is what is tried)",
      bare?.status === 0 && typeof got?.scipy === "string" && /No module named 'scipy\.signal\._sigtools'/.test(got.scipy), JSON.stringify({ got, bare: bare?.status }));
    ok("...and librosa is judged by its pitch tracker, not its lazy package", /aiplay_no_such_numba/.test(String(got?.librosa)), JSON.stringify(got));
  }
}

console.log("\n§2  THE FOUR CASES, AND THEIR SENTENCES");
{
  const ours = engine("ours");
  const theirs = engine("theirs", { studio: false });
  const pip = (py, pkg) => `"${py}" -m pip install ${pkg}`;

  const a = await engineModuleRefusal({ stderr: TRACE, feature: "Hum to score", rig: ours.rig, python: ours.py });
  ok("1. Studio's engine, its own python, a module on the list → setup id \"studio-packages\"",
    a?.setup === ENGINE_SETUP_ID && a.status === 409 && a.reason === "missing-module" && a.module === "scipy"
      && a.package === "scipy" && a.python === ours.py && a.pip === pip(ours.py, "scipy"), JSON.stringify(a));
  ok("...its sentence names the module, the python, the id and the pip line",
    a?.message === `Hum to score needs SciPy, which the engine's python cannot import (${ours.py}). `
      + "Studio can install it into the engine it set up, pinned to its torch and numpy: setup id \"studio-packages\" "
      + `(the Install button, or setup_feature for an agent). To do it by hand: ${pip(ours.py, "scipy")}`, a?.message);
  ok("...and its first sentence ends where offerSetup cuts it (the path's dots do not split it)",
    a?.message.split(/(?<=\.)\s/)[0] === `Hum to score needs SciPy, which the engine's python cannot import (${ours.py}).`);
  /* offerSetup's own cut, lifted out of the page: a person whose profile is
   * "J. Carr" has ". " inside the python path, which sits in parentheses. */
  const fsSrc = /export function firstSentence\(text\) \{[\s\S]*?\n\}\n/.exec(src("web/setup-feature.js"))?.[0] || "";
  const firstSentence = new Function(`${fsSrc.replace(/^export /, "")}\nreturn firstSentence;`)();
  const jPy = "C:\\Users\\J. Carr\\.aiplay-studio\\engine\\venv\\Scripts\\python.exe";
  ok("offerSetup's first sentence is not cut at a \". \" inside the parenthesised python path",
    firstSentence(`Hum to score needs SciPy, which the engine's python cannot import (${jPy}). Studio can install it.`)
      === `Hum to score needs SciPy, which the engine's python cannot import (${jPy}).`
      && firstSentence(a?.message) === `Hum to score needs SciPy, which the engine's python cannot import (${ours.py}).`
      && firstSentence("One. Two.") === "One." && firstSentence("No full stop here") === "No full stop here"
      && firstSentence("Unbalanced (C:\\J. Carr. Rest") === "Unbalanced (C:\\J.");
  const upper = await engineModuleRefusal({ stderr: TRACE, feature: "Hum to score", rig: ours.rig, python: ours.py.toUpperCase() });
  ok("...the same python spelled in another case still counts on Windows", process.platform !== "win32" || upper?.setup === ENGINE_SETUP_ID);

  const b = await engineModuleRefusal({ stderr: "No module named 'cv2'", feature: "The compositor", rig: theirs.rig, python: theirs.py });
  ok("2. a ComfyUI Studio did not install → no id, and the pip line names ITS python",
    b && !("setup" in b) && b.pip === pip(theirs.py, "opencv-python-headless")
      && b.message === `The compositor needs OpenCV (cv2), which ${theirs.py} cannot import. `
        + `Studio installs packages only into the engine it set up itself, so run this yourself: ${pip(theirs.py, "opencv-python-headless")}`, JSON.stringify(b));

  const c = await engineModuleRefusal({ stderr: "ModuleNotFoundError: No module named 'transformers'", feature: "The real-audio tokenizer", rig: ours.rig, python: ours.py });
  ok("3. a module outside Studio's list, on Studio's engine → no id, and says why",
    c && !("setup" in c) && c.module === "transformers"
      && c.message === `The real-audio tokenizer needs the Python module "transformers", which ${ours.py} cannot import. `
        + `It is not one of Studio's own packages, so Studio does not install it; to add it yourself: ${pip(ours.py, "transformers")}`, JSON.stringify(c));
  const pil = await engineModuleRefusal({ stderr: "No module named 'PIL'", feature: "The compositor", rig: ours.rig, python: ours.py });
  ok("...with the pip name when it differs from the import name", pil?.pip === pip(ours.py, "Pillow"), pil?.pip);

  const elsewhere = path.join(tmp, "other-python", "python.exe");
  const d = await engineModuleRefusal({ stderr: TRACE, feature: "The DAW render", rig: ours.rig, python: elsewhere });
  ok("4. config.python outside the rig (AIPLAY_PYTHON) → no id: the setup would fix a python that does not run",
    d && !("setup" in d) && d.message === `The DAW render needs SciPy, which ${elsewhere} cannot import. `
      + `Studio installs packages only into the engine it set up itself, so run this yourself: ${pip(elsewhere, "scipy")}`, JSON.stringify(d));

  ok("a failure that names no missing module is not a refusal (the caller keeps its own sentence)",
    (await engineModuleRefusal({ stderr: "RuntimeError: CUDA out of memory", feature: "x", rig: ours.rig, python: ours.py })) === null);

  const e = refusalError(a);
  ok("as an Error: the message, status 409 and the R0 fields", e instanceof Error && e.message === a.message && e.status === 409
    && e.setup === ENGINE_SETUP_ID && e.reason === "missing-module" && e.pip === a.pip && e.python === ours.py && e.module === "scipy");
  ok("...and the fields a door spreads are only the R0 keys present",
    JSON.stringify(engineRefusalFields(e)) === JSON.stringify({ setup: ENGINE_SETUP_ID, pip: a.pip, python: ours.py, module: "scipy", reason: "missing-module" })
      && JSON.stringify(engineRefusalFields(refusalError(b))) === JSON.stringify({ pip: b.pip, python: theirs.py, module: "cv2", reason: "missing-module" }));
}

console.log("\n§3  THE SETUP BEHIND THE ID (R4d)");
{
  const ours = engine("runner-engine");
  const appData = path.join(tmp, "runner-appdata");
  mkdirSync(appData, { recursive: true });
  const ALL = { cv2: true, librosa: true, soundfile: true, scipy: true };
  let realCalls = 0;
  const make = ({ py = ours.py, spec = ALL, real = ALL } = {}) => createEnginePackagesRunner({
    appData, rig: () => ours.rig, python: () => py,
    probe: async () => spec, imports: async () => { realCalls++; return real; },
    run: async () => { throw new Error("must not run"); },
  });
  const row = async (r) => (await r.status()).setups[0];

  const elsewhere = path.join(tmp, "elsewhere", "python.exe");
  mkdirSync(path.dirname(elsewhere), { recursive: true });
  writeFileSync(elsewhere, "");
  const blocked = await make({ py: elsewhere }).run(ENGINE_SETUP_ID);
  ok("config.python outside the rig is blocked, with the reason and the pip line for the python that runs",
    blocked.state === "blocked" && blocked.message.startsWith(`Studio runs its engine with ${elsewhere}, not the engine's own ${ours.py}`)
      && blocked.message.includes(`"${elsewhere}" -m pip install opencv-python-headless librosa soundfile scipy`), blocked.message);

  forgetImports();
  let s = await row(make({ spec: { ...ALL, scipy: false } }));
  ok("missing SciPy is not ready, and is what the row names", s.ready === false && JSON.stringify(s.missing) === '["scipy"]', JSON.stringify(s.missing));
  forgetImports();
  s = await row(make({ spec: ALL, real: { ...ALL, scipy: "ModuleNotFoundError: No module named 'scipy._lib._ccallback_c'" } }));
  ok("...also when find_spec finds a half-removed SciPy but a real import fails", s.ready === false && JSON.stringify(s.missing) === '["scipy"]', JSON.stringify(s.missing));
  forgetImports();
  const before = realCalls;
  const warm = make();
  await row(warm); await row(warm);
  ok("the real import is run once and kept for 30 s, not on every status read", realCalls === before + 1, `${realCalls - before} calls`);
  const refused = await engineModuleRefusal({ stderr: TRACE, feature: "Hum to score", rig: ours.rig, python: ours.py });
  await row(warm);
  ok("...and a refusal naming a missing module forgets it, so the next status probes again rather than repeat \"ready\"",
    !!refused && realCalls === before + 2, `${realCalls - before} calls`);

  forgetImports();
  s = await row(make({ spec: { cv2: false, librosa: false, soundfile: false, scipy: true } }));
  ok("an engine whose record has no studioPackages gets \"Install what this needs\"", s.button === "Install what this needs");
  ok("the offer names the modules, the engine, the constraints file, and ends with the measured size",
    s.offer.startsWith(`Studio can install OpenCV (cv2), librosa and soundfile into the engine it installed at ${ours.rig}. `)
      && s.offer.includes(`pinned first, in ${path.join(ours.rig, "studio-constraints.txt")}, so pip can only add`)
      && s.offer.endsWith("About 0.3 GB on disk.") && !/not been measured/.test(s.offer), s.offer);
  ok("...and the row carries the constraints file and the four modules", s.constraintsFile === path.join(ours.rig, "studio-constraints.txt")
    && s.modules.join() === "cv2,librosa,soundfile,scipy" && s.packages.join() === "opencv-python-headless,librosa,soundfile,scipy");
  writeFileSync(path.join(appData, "settings.json"), JSON.stringify({ engineInstall: { backend: "nvidia", studioPackages: { ok: false, missing: ["librosa"] } } }));
  s = await row(make({ spec: { ...ALL, librosa: false } }));
  ok("once the record says the last try failed, the button is \"Try again\"", s.button === "Try again");
  writeFileSync(path.join(appData, "settings.json"), JSON.stringify({ engineInstall: { backend: "nvidia", studioPackages: { ok: true, missing: [] } } }));
  s = await row(make({ spec: { ...ALL, librosa: false } }));
  ok("...but a record whose packages went in fine, and a module broke later, is not a retry: \"Install what this needs\"",
    s.button === "Install what this needs", s.button);

  /* The blocked sentence's pip line names only what does not import, and
   * never tells a ComfyUI with opencv-python to add a second cv2. */
  forgetImports();
  const narrow = await make({ py: elsewhere, spec: { ...ALL, librosa: false } }).run(ENGINE_SETUP_ID);
  ok("a blocked python's pip line lists only the missing module's package",
    narrow.state === "blocked" && narrow.message.endsWith(`"${elsewhere}" -m pip install librosa`), narrow.message);
  ok("...and with OpenCV among them, says to reinstall an opencv-* already there instead of adding headless",
    /pip install opencv-python-headless librosa soundfile scipy \(if an opencv-\* package is already installed there, reinstall that one instead of adding opencv-python-headless\)$/.test(blocked.message), blocked.message);

  /* Installed but not importing (find_spec finds it, the real import fails):
   * from inside a running Studio the repair only adds, and the offer says
   * that putting it back is the launcher's, Studio stopped. */
  forgetImports();
  s = await row(make({ spec: ALL, real: { ...ALL, scipy: "ModuleNotFoundError: No module named 'scipy.signal._sigtools'" } }));
  ok("an installed-but-broken SciPy: the offer says only adding happens here, and where putting it back is done",
    s.offer.startsWith(`SciPy is installed in the engine at ${ours.rig} but does not import. Studio can add what it is missing without replacing anything: `)
      && s.offer.includes(`pinned first, in ${path.join(ours.rig, "studio-constraints.txt")}`)
      && /putting SciPy back replaces files the running engine holds open/.test(s.offer)
      && /Try again beside "Studio's own packages" in the launcher/.test(s.offer)
      && !/can only add|GB on disk|MB on disk/.test(s.offer), s.offer);

  /* While its own pip job runs, status probes nothing: a python importing
   * SciPy while pip replaces SciPy is how "~cipy" is made. */
  forgetImports();
  let specCalls = 0, importCalls = 0, finish;
  const busy = createEnginePackagesRunner({
    appData, rig: () => ours.rig, python: () => ours.py, quickMs: 5,
    probe: async () => { specCalls++; return { ...ALL, soundfile: false }; },
    imports: async () => { importCalls++; return ALL; },
    run: (o) => { busy.opts = o; return new Promise((res) => { finish = res; }); },
  });
  const started = await busy.run(ENGINE_SETUP_ID);
  const probedBefore = specCalls + importCalls;
  const during = [await row(busy), await row(busy), await row(busy)];
  ok("while the job runs, three status reads spawn no probe at all",
    started.state === "running" && specCalls + importCalls === probedBefore
      && during.every((x) => x.job?.state === "running" && x.ready === false && JSON.stringify(x.missing) === '["soundfile"]'),
    JSON.stringify({ specCalls, importCalls, probedBefore, states: during.map((x) => x.job?.state) }));
  ok("...and the run from inside Studio is --add-only (nothing installed is replaced under a live engine)",
    busy.opts?.addOnly === true && busy.opts?.rig === ours.rig, JSON.stringify(busy.opts));
  finish({ ok: true, studio: { ok: true, missing: [] } });
  await new Promise((res) => setTimeout(res, 20));
  const after = await row(busy);
  ok("...and once it has finished, the next status probes again", after.job?.state === "done" && specCalls + importCalls > probedBefore);

  /* One probe in flight per python, and an answer of "could not run" (a
   * timeout) is kept for the 30 s like any other, not asked on every read. */
  forgetImports();
  let slowCalls = 0, release;
  const slow = createEnginePackagesRunner({
    appData, rig: () => ours.rig, python: () => ours.py,
    imports: () => { slowCalls++; return new Promise((res) => { release = res; }); },
    run: async () => { throw new Error("must not run"); },
  });
  const both = Promise.all([row(slow), row(slow)]);
  await new Promise((res) => setTimeout(res, 10));
  release(null);
  await both;
  await row(slow);
  ok("two status reads at once share one real import, and a probe that could not answer is not re-run at once",
    slowCalls === 1, `${slowCalls} calls`);
  ok("the probe gives up after 20 s at most (index.js probeOne's cap), not 60",
    /\{ timeoutMs = 20_000 \} = \{\}/.test(src("server/setup/engine-packages.js")));
}

console.log("\n§4  THE CALLERS ANSWER 409 WITH THE FIELDS");
{
  const ours = engine("callers-engine");
  const { config } = await import("../config.js");
  const { HumRefusal, transcribeHum } = await import("../music/hum.js");
  const h = new HumRefusal("m", 409, { setup: "studio-packages", pip: "p", python: "y", module: "scipy", reason: "missing-module", other: 1 });
  ok("HumRefusal carries the R0 fields it is given, and nothing else",
    h.status === 409 && h.setup === "studio-packages" && h.pip === "p" && h.module === "scipy" && h.reason === "missing-module" && !("other" in h));
  ok("...and a plain one is still a 400 with no fields", new HumRefusal("x").status === 400 && !("setup" in new HumRefusal("x")));

  /* hum.js end to end: a real ffmpeg converts a real WAV, then the "python"
   * — Node under the engine's venv name, preloaded to die the way a python
   * without SciPy does — fails, and the refusal comes back with the id. */
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (ff.status !== 0) {
    console.log("  skip  ffmpeg is not on PATH here; hum.js was not run end to end");
  } else {
    let linked = false;
    try { rmSync(ours.py); linkSync(process.execPath, ours.py); linked = true; } catch { try { copyFileSync(process.execPath, ours.py); linked = true; } catch { /* no copy */ } }
    const die = path.join(tmp, "no-scipy.cjs");
    writeFileSync(die, `process.stderr.write(${JSON.stringify(TRACE)}); process.exit(1);\n`);
    const n = 2205, wav = Buffer.alloc(44 + n * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
    const was = process.env.NODE_OPTIONS;
    /* NODE_OPTIONS reads "\" inside quotes as an escape: forward slashes. */
    process.env.NODE_OPTIONS = `--require "${die.replace(/\\/g, "/")}"`;
    let got = null;
    try {
      await transcribeHum({ source: { data_url: `data:audio/wav;base64,${wav.toString("base64")}`, name: "hum.wav" }, rig: ours.rig, python: ours.py });
    } catch (e) { got = e; } finally { if (was === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = was; }
    ok("hum.js: a pitch tracker that cannot import SciPy is a 409 HumRefusal with the id, the python and the pip line",
      linked && got instanceof HumRefusal && got.status === 409 && got.setup === ENGINE_SETUP_ID && got.module === "scipy"
        && got.python === ours.py && got.pip === `"${ours.py}" -m pip install scipy`
        && got.message.startsWith(`Hum to score needs SciPy, which the engine's python cannot import (${ours.py}).`), `${got?.status} ${got?.message}`);
  }
  const hum = src("server/music/hum.js"), tok = src("server/music/tokenize.js");
  ok("hum.js asks with its own feature name, its rig and its python",
    /engineModuleRefusal\(\{ stderr: r\.err, feature: "Hum to score", rig, python \}\)/.test(hum) && /rig = config\.rig/.test(hum));
  ok("tokenize.js too, and throws the refusal (409, missing-module) instead of a 500",
    /feature: "The real-audio tokenizer", rig, python \}\);\n\s*if \(refusal\) throw refusalError\(refusal\);/.test(tok) && /rig = config\.rig/.test(tok)
      && !/lacks a package the tokenizer needs/.test(tok));

  /* The compositor: its effects catalog is the first thing the page reads,
   * and engine.py imports cv2 at the top. A fake python that dies on it. */
  const dying = (text) => () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdin = { write() {}, unref() {} };
    proc.kill = () => true; proc.unref = () => {};
    setImmediate(() => { proc.stderr.emit("data", text); proc.emit("close", 1); });
    return proc;
  };
  const cfg = { ...config, rig: ours.rig, python: ours.py, outputDir: process.env.AIPLAY_OUTPUT };
  const reply = (res) => (status, body) => { res.status = status; res.body = body; };
  const { createVfxRoutes } = await import("../vfx/routes.js");
  const vfx = createVfxRoutes({ config: cfg, CLIP_DIR: path.join(tmp, "clips"), IMAGE_DIR: path.join(tmp, "images"), art: null,
    readBody: async (req) => req.body, json: (res, status, body) => reply(res)(status, body),
    spawnPython: dying("Traceback (most recent call last):\nModuleNotFoundError: No module named 'cv2'\n") });
  const res = {};
  await vfx({ method: "GET", headers: {} }, res, new URL("http://127.0.0.1/api/vfx/catalog"));
  ok("the compositor's catalog door answers 409 with setup, pip, python and module (no traceback)",
    res.status === 409 && res.body?.setup === ENGINE_SETUP_ID && res.body.module === "cv2" && res.body.python === ours.py
      && res.body.pip === `"${ours.py}" -m pip install opencv-python-headless` && /^The compositor needs OpenCV \(cv2\)/.test(res.body.error)
      && !/Traceback/.test(res.body.error), JSON.stringify(res));
  const again = {};
  await vfx({ method: "GET", headers: {} }, again, new URL("http://127.0.0.1/api/vfx/catalog"));
  ok("...and the same refusal, fields and all, while the miss is cached", again.status === 409 && again.body?.setup === ENGINE_SETUP_ID, JSON.stringify(again));

  const { createDawRoutes } = await import("../daw/routes.js");
  const daw = createDawRoutes({ config: cfg, readBody: async (req) => req.body, json: (res2, status, body) => reply(res2)(status, body),
    spawnPython: dying("Traceback (most recent call last):\n  File \"engine.py\", line 54\nModuleNotFoundError: No module named 'scipy'\n") });
  const d = {};
  await daw({ method: "GET", headers: {} }, d, new URL("http://127.0.0.1/api/daw/chirp.wav"));
  ok("the DAW (engine.py imports scipy.signal at the top) answers 409 with the id instead of a 503 traceback",
    d.status === 409 && d.body?.setup === ENGINE_SETUP_ID && d.body.module === "scipy" && /^The DAW render needs SciPy/.test(d.body.error), JSON.stringify(d));
  const other = createDawRoutes({ config: cfg, readBody: async (req) => req.body, json: (res2, status, body) => reply(res2)(status, body),
    spawnPython: dying("RuntimeError: something else\n") });
  const o = {};
  await other({ method: "GET", headers: {} }, o, new URL("http://127.0.0.1/api/daw/chirp.wav"));
  ok("...while any other failure keeps its old status and words", o.status === 503 && /something else/.test(o.body?.error) && !("setup" in (o.body || {})), JSON.stringify(o));
  const warned = createDawRoutes({ config: cfg, readBody: async (req) => req.body, json: (res2, status, body) => reply(res2)(status, body),
    spawnPython: dying("Traceback (most recent call last):\n  File \"x.py\", line 1\nModuleNotFoundError: No module named 'triton'\n"
      + "Traceback (most recent call last):\n  File \"engine.py\", line 900\nRuntimeError: sample rate 12345 is not supported\n") });
  const w = {};
  await warned({ method: "GET", headers: {} }, w, new URL("http://127.0.0.1/api/daw/chirp.wav"));
  ok("...including one whose stderr carries an earlier warning naming a module: the last line decides",
    w.status === 503 && /sample rate 12345/.test(w.body?.error) && !("setup" in (w.body || {})) && !("module" in (w.body || {})), JSON.stringify(w));
}

console.log("\n§5  THE PAGE OFFERS WHATEVER ID ARRIVES (D4)");
{
  const mod = src("web/setup-feature.js");
  ok("offerSetup keeps its signature and names no setup: title, button and offer come from the server",
    /export async function offerSetup\(id, message, \{ lead = "" \} = \{\}\)/.test(mod)
      && /appConfirm\(`\$\{lead \? `\$\{lead\} ` : ""\}\$\{first\}\\n\\n\$\{offerOf\(s\)\}`, \{ title: s\.title, ok: s\.button, cancel: "Not now" \}\)/.test(mod)
      && !/"studio-packages"|"stems"|"lyrics"/.test(mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  ok("...an unknown, blocked or ready setup is said, not offered",
    /if \(!s \|\| s\.blocked \|\| s\.ready\) \{ appAlert\(`\$\{lead \? `\$\{lead\} ` : ""\}\$\{s\?\.blocked \|\| message\}`\); return; \}/.test(mod));
  ok("...and cuts the first sentence with firstSentence (parentheses kept whole)", /const first = firstSentence\(message\);/.test(mod));

  /* The DAW page and the compositor answer a refusal's setup id with the
   * same dialog (their doors are D's), loaded on demand and at most once a
   * minute, typeof-guarded because vfx.js's postVfx is lifted and run alone
   * by server/vfx/ui-workflow_test.js. */
  const daw = src("web/daw.js"), vfx = src("web/vfx.js");
  const offers = (text, v) => new RegExp(`import\\("\\./setup-feature\\.js"\\)\\.then\\(\\(m\\) => m\\.offerSetup\\(${v}\\.setup, ${v}\\.error\\)\\)`).test(text)
    && /Date\.now\(\) - \(setupOffered\.get\([dj]\.setup\) \|\| 0\) < 60_000/.test(text);
  ok("the DAW page offers the setup a refusal names, from both of its fetch helpers",
    offers(daw, "j") && (daw.match(/if \(typeof offerRefusalSetup === "function"\) offerRefusalSetup\(j\);/g) || []).length === 2);
  ok("the compositor too (postVfx and getJson), guarded inside the lifted request code",
    offers(vfx, "d") && (vfx.match(/if \(typeof offerRefusalSetup === "function"\) offerRefusalSetup\(d\);/g) || []).length === 2
      && !/function offerRefusalSetup/.test(vfx.slice(vfx.indexOf("const VFX_READ_ACTIONS"), vfx.indexOf("async function getJson("))));
}

rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
