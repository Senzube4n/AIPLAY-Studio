/**
 * THE LICENCE BOUNDARY, CHECKED — nothing in this Apache-2.0 tree may import bpy.
 *
 * ⚠ WHY THIS EXISTS AND WHY IT IS ITS OWN FILE. By the Blender Foundation's
 * stated position, anything that does `import bpy` is a derivative work of
 * Blender and must be GPL-compatible. This repository is Apache-2.0 and public.
 * The only legitimate seam is a SUBPROCESS: `blender.exe -b -P <script>`, with a
 * .png and a .json crossing back on disk — data, which carries no obligation.
 *
 * config.js says all of that at length (see the `blender` block) and it has been
 * true the whole time. What was missing is anything that CHECKS it. A licence
 * boundary defended only by a comment is defended by whoever last read the
 * comment.
 *
 * ⚠ THE SEAMS. This is the one list of them; .githooks/pre-commit points here
 * rather than keeping a copy. An earlier branch carried this scan inside
 * server/previz/routes_test.js, and the history rewrite that built this public
 * tree dropped the whole file — the guard with it. Since then the tree gained
 * three Blender crossings where that branch had one:
 *
 *     server/mv/blender.js     runPreviz()   spawns blender.exe
 *     server/mesh/deform.js    bpyDeform()   spawns a bpy script
 *     server/mesh/runner.js                  the mesh toolkit's own launcher
 *
 * And a fourth came with the 3D workshop merge (a6941f0), which is the day this
 * file was for: it arrived as server/mesh/weight_transfer.py, an `import bpy`
 * INSIDE the tree, and this lane failed on it. It now crosses the way deform.py
 * does — the script lives outside the tree, config.js
 * weightTransferScriptPath() (AIPLAY_WEIGHT_TRANSFER_SCRIPT) finds it, and a
 * missing script is a 503 sentence, not a spawn:
 *
 *     server/mesh/avatar-weight-transfer.js  runWeightPython()  spawns a bpy script
 *
 * A fifth came one commit later with main's avatar fitting (298a6f4), by the
 * same road: attachment_fit.py does `import weight_transfer` and takes bpy's
 * types back from it without ever spelling bpy, which is why the module-name
 * rule below exists. It and its suite moved out beside weight_transfer.py,
 * and config.js attachmentFitScriptPath() (AIPLAY_ATTACHMENT_FIT_SCRIPT) finds
 * it:
 *
 *     server/mesh/avatar-fitting.js          runFittingPython() spawns a bpy script
 *
 * Subprocess seams are fine. Seams with nobody watching for the day one of them
 * becomes an import is the thing this file is for.
 *
 * ⚠ AN IMPORT IS NOT ONLY `import bpy`. Three shapes reach Blender without
 * that line, and each one is checked below:
 *   - Blender's OTHER modules: `from mathutils import Vector`, `import bmesh`.
 *     They exist only inside Blender, so a file using them is using Blender.
 *   - the out-of-tree scripts by MODULE NAME. `import weight_transfer as wt`
 *     then `wt.runtime()` hands back bpy's own types without this file ever
 *     spelling bpy; it inherits the problem exactly as importing previz does.
 *   - a runtime import, `importlib.import_module("bpy")` or `__import__`.
 * The Blender names are matched only in .py: a .js line that happens to start
 * `import gpu from` is not Blender.
 *
 * ⚠ THE COPY CHECK READS THE INDEX, NOT THE DISK WALK. The walk skips vendor/
 * (it is where a toolkit clone goes), so a single bpy script dropped into
 * vendor/previz-blender/previz/ and staged with `git add -A` passed every check
 * here. `git ls-files` is what a commit ships, vendor/ included.
 *
 * ⚠ TWO CHECKS FROM THE ORIGINAL ARE DELIBERATELY NOT HERE. The branch also
 * asserted that the previz package root lies OUTSIDE the repo, and read a
 * `BOUNDARY.how` object out of its blender.js. Neither is carried:
 *
 *   - this tree points the toolkit at `vendor/previz-blender/` BY DESIGN, so
 *     asserting the root is external would assert a policy main changed on
 *     purpose. What must never happen is its .py entering our commits, which
 *     is what the index-based copy check below actually defends.
 *   - main's server/mv/blender.js carries the boundary as prose, not as an
 *     exported object, so there is nothing to read.
 *
 * Node's own runner, no dependencies beyond node's own modules and the git on
 * PATH, no GPU, no network. It reads files and returns 1 if the boundary has
 * been crossed.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

let pass = 0;
const failures = [];
const ok = (what, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { failures.push(what); console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`); }
};

console.log("\n  -- the licence boundary --");

/** Every .js/.mjs/.py on disk, minus the places source does not live. */
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "vendor"].includes(name)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) sources(full, out);
    else if (/\.(js|mjs|py)$/.test(name)) out.push(full);
  }
  return out;
}

/** Every path in the index: tracked and staged, vendor/ included. null when
 *  there is no git to ask (an unpacked zip), which is said out loud below. */
function indexed() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached"],
      { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(out.split("\0").filter(Boolean))].map((p) => path.join(REPO, p));
  } catch { return null; }
}

const walked = sources(REPO);
ok(`the scan sees the repo at all (${walked.length} source files)`, walked.length > 100,
  "a scan that walks nothing passes everything");

const index = indexed();
if (index) {
  ok(`the index was read, vendor/ included (${index.length} paths)`, index.length > 100,
    "an index that lists nothing passes every copy check");
} else {
  console.log("  UNRUN the index copy check: no git answered `git ls-files` here, so only the disk walk"
    + " (which skips vendor/) was scanned. UNRUN, not a pass.");
}
const files = [...new Set([...walked, ...(index || []).filter((f) => /\.(js|mjs|py)$/.test(f))])];

/* The patterns. Written as PATTERNS rather than substrings so the word "bpy"
 * can still be DISCUSSED in a comment — which config.js, server/mv/blender.js
 * and server/mesh/deform.js all do at length, and must be able to keep doing.
 * A substring match would fail on its own explanation. */
const BLENDER = "bpy|bpy_extras|bpy_types|mathutils|bmesh|gpu|gpu_extras|bl_math|bl_ui|bl_operators|aud|blf|bgl|idprop|imbuf|freestyle";
const OUTSIDE = "weight_transfer|weight_transfer_test|attachment_fit|attachment_fit_test|deform";
const PREVIZ = "previz";
/** A Python import of any of `mods`: `import a, m as x`, `from m.sub import`,
 *  or a runtime `import_module("m")` / `__import__("m")`. */
const pyImport = (mods) => new RegExp(
  String.raw`^\s*(?:import\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*(?:${mods})(?!\w)`
  + String.raw`|from\s+(?:${mods})(?=[\s.])`
  + String.raw`|.*\b(?:__import__|import_module)\(\s*["'](?:${mods})(?=["'.]))`, "m");
const IMPORTS_BPY_JS = /^\s*import\s+.*\bfrom\s+["']bpy["']/m;
const IMPORTS_BLENDER = pyImport(BLENDER);
const IMPORTS_OUTSIDE = pyImport(OUTSIDE);
const IMPORTS_PREVIZ = pyImport(PREVIZ);

/** Which rule a file's text breaks, if any. */
function crossings(text, file) {
  const py = file.endsWith(".py");
  return {
    blender: IMPORTS_BPY_JS.test(text) || (py && IMPORTS_BLENDER.test(text)),
    outside: py && IMPORTS_OUTSIDE.test(text),
    previz: py && IMPORTS_PREVIZ.test(text),
  };
}

/* The rules on their own inputs first, so a pattern that has quietly stopped
 * matching cannot report a clean tree. The first two are the lines origin/main
 * 298a6f4 put in attachment_fit.py and its suite: neither spells bpy, and the
 * lane as it stood passed both. */
const mustCatch = [
  ["import weight_transfer as wt", "outside"],
  ["from weight_transfer_test import fixture, rewrite, translate", "outside"],
  ["import attachment_fit as fit", "outside"],
  ["import deform", "outside"],
  ["        from mathutils import Matrix, Vector, Quaternion", "blender"],
  ["        from mathutils.bvhtree import BVHTree", "blender"],
  ["        import bpy", "blender"],
  ["import bmesh", "blender"],
  ["import os, bpy", "blender"],
  ["import numpy as np, mathutils", "blender"],
  ["mod = importlib.import_module('bpy')", "blender"],
  ["bl = __import__(\"bpy_extras.io_utils\")", "blender"],
  ["from previz.cli import main", "previz"],
];
const mustPass = [
  ["import { bpyDeform } from './deform.js';", ".js"],
  ["import gpu from './gpu.js';", ".js"],
  ["# weight_transfer.py imports bpy, so it lives outside this tree", ".py"],
  ["from unirig_adapter import read_glb, skin_accessor", ".py"],
  ["import gpustat", ".py"],
  ["import deformation_probe", ".py"],
  ["gpu = detect_gpu()", ".py"],
  ["importlib.metadata.version('bpy')", ".py"],
];
const missed = mustCatch.filter(([line, rule]) => !crossings(line + "\n", "probe.py")[rule]).map(([l]) => l);
ok(`the rules catch every Blender-reaching import shape they name (${mustCatch.length})`, missed.length === 0,
  `not caught: ${missed.join(" | ")}`);
const wrong = mustPass.filter(([line, ext]) => Object.values(crossings(line + "\n", "probe" + ext)).some(Boolean)).map(([l]) => l);
ok(`the rules leave prose and look-alikes alone (${mustPass.length})`, wrong.length === 0,
  `falsely caught: ${wrong.join(" | ")}`);

const offenders = { blender: [], outside: [], previz: [] };
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const hit = crossings(text, f);
  for (const rule of Object.keys(offenders)) if (hit[rule]) offenders[rule].push(path.relative(REPO, f));
}

ok("nothing in this repo imports bpy or another Blender module", offenders.blender.length === 0,
  `${offenders.blender.join(", ")} — bpy, mathutils, bmesh and the rest exist only inside Blender; importing `
  + "them makes the file a derivative work under the Blender Foundation's position, and this repo is "
  + "Apache-2.0. Shell out to blender.exe or a Blender python instead.");

ok("nothing in this repo imports an out-of-tree bpy script by module name", offenders.outside.length === 0,
  `${offenders.outside.join(", ")} — weight_transfer, attachment_fit and deform import bpy, so importing `
  + "them inherits the same problem (and hands back bpy's own types). Move the importer out beside them.");

ok("nothing in this repo imports the previz package", offenders.previz.length === 0,
  `${offenders.previz.join(", ")} — previz/*.py imports bpy, so importing it inherits the same `
  + "problem. The seam is a subprocess.");

/* The GPL half's .py must never be COPIED into the tree, which would pass the
 * import checks above (a bpy script need not import itself) and still be
 * exactly what the boundary forbids. Checked by NAME over the index and the
 * walk together, so vendor/ is covered. */
const COPY = /(?:^|[\\/])(?:previz[\\/](?:moves|scene|blocking|props|shots|cli|deform)|weight_transfer(?:_test)?|attachment_fit(?:_test)?|deform)\.py$/;
const copied = [...new Set([...walked, ...(index || [])])].filter((f) => COPY.test(f));
ok("no previz module or out-of-tree bpy script has been copied into this tree", copied.length === 0,
  copied.map((f) => path.relative(REPO, f)).join(", "));

/* The seam itself, stated in the source that owns it. If someone rewrites
 * runPreviz to do anything but spawn a process, the prose is the tell. */
const mvBlender = readFileSync(path.join(HERE, "mv", "blender.js"), "utf8");
ok("server/mv/blender.js still describes the seam as a subprocess",
  /subprocess|spawn|execFile/i.test(mvBlender),
  "the Blender seam must remain a process boundary, never an import");

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
