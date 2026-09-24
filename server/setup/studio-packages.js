/**
 * STUDIO'S OWN PYTHON PACKAGES IN STUDIO'S OWN ENGINE.
 *
 * Studio runs several of its own Python scripts in the engine's interpreter
 * (config.python, the ComfyUI venv): the compositor (server/vfx/engine.py
 * imports cv2), clip posters (scripts/clipthumb.py, cv2), hum-to-score
 * (librosa, soundfile), the real-audio tokenizer (soundfile, scipy.signal)
 * and the DAW (server/daw/engine.py imports scipy.signal at the top; its
 * sampled instruments and mastered bounce need soundfile). ComfyUI's
 * requirements.txt lists scipy, Pillow and av but not OpenCV, librosa or
 * soundfile, and nothing installed those: on the rig, `pip show
 * opencv-python` says "Required-by: nothing", i.e. installed by hand.
 *
 * SciPy is on the list although ComfyUI brings it. librosa 0.10+ imports
 * lazily, so `import librosa` passes while SciPy is broken, and a check of
 * three modules said "ready" on an engine whose DAW and pitch tracker could
 * not start: the repair then offered itself forever and installed nothing.
 * SciPy 1.9+ is lazy too (`import scipy` loads no scipy.signal), so the
 * check imports what the features load: scipy.signal, and librosa's pitch
 * tracker, which pulls numba, soxr and audioread (IMPORT_OF).
 *
 * So scripts/install-engine.mjs installs them after ComfyUI's requirements,
 * into an engine it made itself and never into anybody else's, and only the
 * ones that do not import. The pip line carries a constraints file holding
 * EVERY package already in the engine at its installed version (`pip
 * freeze`), torch's local build included, so installing cannot move the
 * engine's torch, its numpy, or a compiled package a running ComfyUI holds
 * open. The last is how a pip upgrade on Windows leaves a half-removed
 * package behind (a "~cipy" folder in site-packages): the .pyd is locked,
 * the rollback fails. The one thing that replaces files, putting back a
 * package pip lists but that does not import, is done only while Studio is
 * stopped (the launcher's Try again); from inside a running Studio the step
 * only adds (`replace: false`).
 *
 * Node built-ins only, and nothing here runs a process: the installer does,
 * and hands its runners to addStudioPackages().
 */
import path from "node:path";

/** What pip installs. Headless OpenCV: the engine draws no windows, and the
 *  GUI build drags in Qt libraries for nothing. */
export const STUDIO_PACKAGES = ["opencv-python-headless", "librosa", "soundfile", "scipy"];
/** What each one imports as, in the same order. */
export const STUDIO_MODULES = ["cv2", "librosa", "soundfile", "scipy"];
/** The package that puts each module back. */
export const PACKAGE_OF = { cv2: "opencv-python-headless", librosa: "librosa", soundfile: "soundfile", scipy: "scipy" };
/** A plain name for each module, for the sentence a person reads. */
export const MODULE_WORDS = { cv2: "OpenCV (cv2)", librosa: "librosa", soundfile: "soundfile", scipy: "SciPy" };
/** What needs them, in one clause. */
export const STUDIO_USES = "Clip posters, the compositor, hum-to-score, the real-audio tokenizer and the DAW need them";

/**
 * On disk, per module, with what it pulls in: measured with du on the rig's
 * venv (Python 3.10 wheels), 2026-09-24. librosa is librosa 5.7 MB + numba 24
 * + llvmlite 119 + scikit-learn 41 + joblib, soxr, pooch and the rest ~4. The
 * download was not measured; the wheels are compressed, so it is smaller.
 */
export const MODULE_DISK_MB = { cv2: 115, librosa: 193, soundfile: 2.4, scipy: 139 };
/** ComfyUI's own requirements.txt brings these, so a fresh engine lacks only the rest. */
export const COMFY_BRINGS = ["scipy"];
/** What an engine made before Studio added its packages is usually missing. */
export const ADDED_BY_STUDIO = STUDIO_MODULES.filter((m) => !COMFY_BRINGS.includes(m));

/** "About 0.3 GB on disk." for OpenCV, librosa and soundfile; the sum of whatever is named. */
export function diskWords(mods = ADDED_BY_STUDIO) {
  const mb = (mods || []).reduce((n, m) => n + (MODULE_DISK_MB[m] || 0), 0);
  if (!mb) return "";
  return mb < 100 ? `About ${Math.max(1, Math.round(mb))} MB on disk.` : `About ${(mb / 1000).toFixed(1)} GB on disk.`;
}

/** "OpenCV (cv2), librosa and SciPy" */
export function moduleWords(mods) {
  const w = (mods || []).map((m) => MODULE_WORDS[m] || m);
  return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : (w[0] || "");
}

/** The packages whose installed versions the probe below reads. torch and
 *  numpy are the two that must be there; the torch family rides with torch. */
export const PINNED = ["torch", "torchvision", "torchaudio", "numpy"];

/** Python that prints `@@versions {...}`: the installed version of each of PINNED. */
export const VERSIONS_PROBE = [
  "import json, importlib.metadata as m",
  "out = {}",
  `for n in ${JSON.stringify(PINNED)}:`,
  "    try: out[n] = m.version(n)",
  "    except Exception: pass",
  "print('@@versions ' + json.dumps(out))",
].join("\n");

/**
 * What each module is imported AS to be judged: the submodule Studio's
 * scripts actually load. SciPy and librosa both import lazily, so a bare
 * `import scipy` passes on a half-removed SciPy (measured on the rig, scipy
 * 1.15.3: no scipy.signal is loaded), and a bare `import librosa` loads
 * neither SciPy nor numba. The DAW and the tokenizer import scipy.signal;
 * hum-to-score calls librosa.pyin and librosa.resample, whose module
 * (librosa.core.pitch) imports numba, scipy, soundfile, soxr and audioread.
 * The answer stays keyed by the module id. ~3 s for all four on the rig.
 */
export const IMPORT_OF = { scipy: "scipy.signal", librosa: "librosa.core.pitch" };

/** Python that prints `@@modules {...}`: true, or the one-line reason, per module.
 *  A real import, not find_spec: cv2 can be present and still fail on a DLL,
 *  and a half-removed SciPy still has a folder for find_spec to find. */
export function modulesProbe(mods) {
  return [
    "import importlib, json",
    `imp = ${JSON.stringify(IMPORT_OF)}`,
    "out = {}",
    `for n in ${JSON.stringify(mods)}:`,
    "    try:",
    "        importlib.import_module(imp.get(n, n))",
    "        out[n] = True",
    "    except Exception as e:",
    "        out[n] = (type(e).__name__ + ': ' + str(e)).splitlines()[0][:200]",
    "print('@@modules ' + json.dumps(out))",
  ].join("\n");
}
export const MODULES_PROBE = modulesProbe(STUDIO_MODULES);

/** Python that prints `@@leftovers {"dir", "names"}`: what pip left in
 *  site-packages when an uninstall or rollback could not finish. pip parks a
 *  package it is replacing under a name starting with "~" (or "-"), and on
 *  Windows a file the running engine holds open keeps it there. */
export const LEFTOVERS_PROBE = [
  "import json, os, sysconfig",
  "d = sysconfig.get_paths()['purelib']",
  "try: names = sorted(n for n in os.listdir(d) if n[:1] in '~-')",
  "except Exception: names = []",
  "print('@@leftovers ' + json.dumps({'dir': d, 'names': names}))",
].join("\n");

/** The `@@<tag> {json}` line out of a probe's stdout, or null. */
export function probeLine(stdout, tag) {
  for (const l of String(stdout || "").split(/\r?\n/)) {
    if (l.startsWith(`@@${tag} `)) { try { return JSON.parse(l.slice(tag.length + 3)); } catch { return null; } }
  }
  return null;
}

/**
 * The narrow pin: one `name==version` per installed package of PINNED. A
 * local version such as 2.13.0+cu130 is kept whole: pip matches it exactly,
 * and the installed wheel satisfies it, so pip has nothing to change.
 * Refuses when torch or numpy is missing, since then there is nothing to pin
 * against and the packages would be installed into a broken engine.
 */
export function constraintsText(versions) {
  const v = versions || {};
  for (const need of ["torch", "numpy"]) {
    if (!v[need]) throw new Error(`The engine has no ${need} installed, so there is nothing to pin Studio's packages against.`);
  }
  return `${PINNED.filter((n) => v[n]).map((n) => `${n}==${v[n]}`).join("\n")}\n`;
}

/** pip's own name comparison: case, "_" and "." do not matter. */
export const normName = (n) => String(n || "").toLowerCase().replace(/[-_.]+/g, "-");

const FROZEN_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;#]+)\s*$/;

/** `pip freeze` → Map(normalised name → { name, version, line }). Only
 *  `name==version` lines: editable installs, `name @ url` lines and comments
 *  cannot be constraints, so they are not counted as pinned. */
export function parseFreeze(text) {
  const out = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = FROZEN_LINE.exec(raw.trim());
    if (m) out.set(normName(m[1]), { name: m[1], version: m[2], line: `${m[1]}==${m[2]}` });
  }
  return out;
}

/**
 * The constraints file: every `name==version` line `pip freeze` printed, as
 * printed (torch 2.14.0+cu130 whole), then any of PINNED the freeze missed
 * but the version probe read. With every installed package held at its
 * version, a plain install can only add new ones: nothing a running engine
 * has loaded is replaced under it (only --force-reinstall replaces, and
 * addStudioPackages does that only with Studio stopped). Refuses an engine
 * with no torch or no numpy.
 */
export function frozenConstraints(freezeText, versions = {}) {
  const frozen = parseFreeze(freezeText);
  const v = { ...(versions || {}) };
  for (const n of PINNED) if (!v[n] && frozen.get(n)) v[n] = frozen.get(n).version;
  constraintsText(v);   // the same refusal as the narrow pin
  const lines = [...frozen.values()].map((d) => d.line);
  for (const n of PINNED) if (v[n] && !frozen.has(n)) lines.push(`${n}==${v[n]}`);
  return `${lines.join("\n")}\n`;
}

/** The modules that did not import, from a modules probe's answer. */
export const missingModules = (answer, mods = STUDIO_MODULES) =>
  mods.filter((m) => answer?.[m] !== true);

/**
 * The top-level module a text says could not be imported: the LAST
 * "No module named 'x.y'" in it → "x" (a traceback names the innermost
 * failure last). null when the text names none.
 */
export function missingModuleOf(text) {
  const re = /No module named ['"]?([A-Za-z_][\w.]*)['"]?/g;
  let m, last = null;
  while ((m = re.exec(String(text || "")))) last = m[1];
  return last ? last.split(".")[0] : null;
}

/**
 * What to hand pip, from a real import of each module (`answer`, or null when
 * the probe itself could not run) and `pip freeze`:
 *
 *   - a module that imports is left alone, and so is one that fails only
 *     because ANOTHER of the four does (librosa's pitch tracker failing on
 *     "No module named 'scipy.signal._sigtools'"): putting SciPy back is
 *     what fixes it;
 *   - a module that fails while pip still lists its distribution is put
 *     back at exactly the frozen version (`force`): --force-reinstall
 *     --no-deps, because a plain `pip install scipy` there is a no-op
 *     ("Requirement already satisfied") and leaves the half-removed package
 *     as it was. The same frozen line then also goes through a plain
 *     install, which adds any requirement of it that is missing (librosa
 *     without lazy_loader, soundfile without cffi) and, with every
 *     installed package pinned, changes nothing else;
 *   - OpenCV counts as listed when ANY opencv-* distribution is installed:
 *     that one is put back, and opencv-python-headless is not added beside
 *     it (two distributions owning one cv2 folder);
 *   - anything else is added by name (`add`).
 *
 * With no answer (the probe itself could not run) nothing is forced: what
 * pip does not list is added, and what it lists is left alone.
 */
export function studioInstallPlan(answer, freezeText) {
  const frozen = parseFreeze(freezeText);
  const known = !!answer && typeof answer === "object";
  const missing = known ? missingModules(answer) : [...STUDIO_MODULES];
  const add = [], force = [], forceModules = [];
  for (const m of missing) {
    const cause = known ? missingModuleOf(answer[m]) : null;
    if (cause && cause !== m && missing.includes(cause) && missingModuleOf(answer[cause]) !== m) continue;   // fixed by fixing `cause`
    const listed = m === "cv2"
      ? (frozen.get(normName(PACKAGE_OF.cv2)) || [...frozen.entries()].find(([n]) => n.startsWith("opencv-"))?.[1])
      : frozen.get(normName(PACKAGE_OF[m] || m));
    if (listed && known) { force.push(listed.line); forceModules.push(m); }
    else if (!listed) add.push(PACKAGE_OF[m] || m);
  }
  return { missing, add, force, forceModules, known };
}

/** The half-removed folders, in words, or "". */
export function leftoverWords(leftovers) {
  const names = Array.isArray(leftovers?.names) ? leftovers.names.filter(Boolean) : [];
  if (!names.length) return "";
  return `pip left half-removed packages in ${leftovers.dir || "the engine's site-packages"} (${names.join(", ")}): `
    + "stop Studio, delete those folders, then try again.";
}

/**
 * The one sentence a person reads when Studio's packages are not all there.
 * The engine itself still works, so the install is not undone for this; the
 * sentence says what is affected and where the retry is: the launcher's
 * "Try again" beside "Studio's own packages" (a Setup.exe install has no
 * `node` on PATH), with the command behind it for whoever wants it. Any
 * half-removed package folders pip left are named, since while they are
 * there the same module keeps failing. `putBack` is the frozen lines a run
 * from inside a running Studio did not replace (addStudioPackages with
 * replace: false): those need Studio stopped, and the sentence says so.
 */
export function studioWarning(missing, reason = "", leftovers = null, { putBack = [] } = {}) {
  if (!missing?.length) return null;
  const names = missing.map((m) => MODULE_WORDS[m] || m).join(", ");
  const left = leftoverWords(leftovers);
  const back = (putBack || []).filter(Boolean);
  return `The engine works, but Studio's own packages did not all install (missing: ${names})${reason ? `: ${reason}` : ""}. `
    + (left ? `${left} ` : "")
    + (back.length ? `Putting back ${back.join(", ")} (installed, but not importing) replaces files the running engine holds open, `
      + "so it is done only while Studio is stopped. " : "")
    + `${STUDIO_USES}; everything else runs. `
    + `To try only these again, ${back.length ? "stop Studio, then " : ""}press Try again beside "Studio's own packages" in the launcher's system check `
    + "(the same as: node scripts/install-engine.mjs --studio-packages, from the Studio folder).";
}

/** The constraints file's name inside the engine folder. */
export const CONSTRAINTS_FILE = "studio-constraints.txt";

const lastLine = (e) => String(e?.stderr || e?.message || e).trim().split(/\r?\n/).pop();

/**
 * Studio's own packages, into the engine at `root`. The runners are the
 * installer's, so this file still starts no process:
 *
 *   runPy(code, timeoutMs) → { stdout }     the engine's python -s -c <code>
 *   freeze()               → text           the engine's `pip freeze`
 *   pip(args)              → resolves       the engine's `pip install --progress-bar raw <args>`
 *   write(file, text)                       the constraints file
 *
 * Every installed package is written into <root>/studio-constraints.txt
 * first, and pip gets that file with -c. Only the modules that do not import
 * are handed to pip (studioInstallPlan), in two calls:
 *
 *   1. --force-reinstall --no-deps <name==frozen>…   the listed-but-broken
 *      ones, only when `replace` (Studio is stopped: the launcher, a fresh
 *      install). From inside a running Studio (`replace: false`, the in-app
 *      button and MCP) nothing installed is replaced: its ComfyUI and the
 *      DAW and compositor children hold those .pyd files open, and a
 *      replacement that cannot finish is what leaves a "~cipy" behind;
 *   2. <name==frozen>… <new package>…                a plain install: adds
 *      what is absent and any missing requirement of what is listed, and
 *      under the pins changes nothing already there.
 *
 * Returns { ok, pinned, plan, constraints, kept, keptModules, noop?, error? }:
 * `kept` is the frozen lines step 1 skipped, `keptModules` their modules.
 * Never throws for a pip failure, because the engine it adds to already
 * works (the caller says so, loudly).
 */
export async function addStudioPackages({ root, runPy, freeze, pip, write, log = () => {}, replace = true }) {
  let pinned;
  try {
    pinned = probeLine((await runPy(VERSIONS_PROBE, 120_000)).stdout, "versions");
  } catch (e) {
    return { ok: false, error: `could not read the engine's torch and numpy: ${lastLine(e)}` };
  }
  let frozen;
  try { frozen = String(await freeze()); } catch (e) {
    return { ok: false, pinned, error: `could not list the engine's packages (pip freeze): ${lastLine(e)}` };
  }
  let text;
  try { text = frozenConstraints(frozen, pinned); } catch (e) { return { ok: false, pinned, error: e.message }; }
  const file = path.join(root, CONSTRAINTS_FILE);
  await write(file, text);
  const held = text.trim().split("\n");
  log(`Pinned every package already in the engine at its version (${held.length}, in ${file}): `
    + `${held.filter((l) => PINNED.includes(normName(l.split("==")[0]))).join(", ")}, …`);
  let answer = null;
  try { answer = probeLine((await runPy(MODULES_PROBE)).stdout, "modules"); } catch { answer = null; }
  const plan = studioInstallPlan(answer, frozen);
  const kept = replace ? [] : [...plan.force];
  const keptModules = replace ? [] : [...plan.forceModules];
  if (!plan.missing.length) {
    log(`Studio's own packages already import: ${STUDIO_MODULES.join(", ")}. Nothing to install.`);
    return { ok: true, pinned, plan, constraints: file, kept, keptModules, noop: true };
  }
  try {
    if (plan.force.length && replace) {
      log(`Listed but not importing, so put back at the same version: ${plan.force.join(", ")}`);
      await pip(["--force-reinstall", "--no-deps", ...plan.force, "-c", file]);
    } else if (plan.force.length) {
      log(`Listed but not importing: ${plan.force.join(", ")}. Studio is running, so they are not replaced; `
        + "only what they are missing is added.");
    }
    if (plan.force.length || plan.add.length) await pip([...plan.force, ...plan.add, "-c", file]);
    return { ok: true, pinned, plan, constraints: file, kept, keptModules };
  } catch (e) {
    return { ok: false, pinned, plan, constraints: file, kept, keptModules, error: String(e.message).split("\n")[0] };
  }
}
