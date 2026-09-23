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
 * ⚠ AND THE EXPOSURE GREW WHILE THE GUARD WAS ABSENT. An earlier branch carried
 * this scan inside server/previz/routes_test.js, and the history rewrite that
 * built this public tree dropped the whole file — the guard with it. Since then
 * the tree gained THREE Blender crossings where that branch had one:
 *
 *     server/mv/blender.js     runPreviz()   spawns blender.exe
 *     server/mesh/deform.js    bpyDeform()   spawns a bpy script
 *     server/mesh/runner.js                  the mesh toolkit's own launcher
 *
 * Three subprocess seams are fine. Three seams with nobody watching for the day
 * one of them becomes an import is the thing this file is for.
 *
 * ⚠ TWO CHECKS FROM THE ORIGINAL ARE DELIBERATELY NOT HERE. The branch also
 * asserted that the previz package root lies OUTSIDE the repo, and read a
 * `BOUNDARY.how` object out of its blender.js. Neither is carried:
 *
 *   - this tree points the toolkit at `vendor/previz-blender/` BY DESIGN, so
 *     asserting the root is external would assert a policy main changed on
 *     purpose. The vendored directory is a gitlink, never .py in our commits —
 *     which is what the copy check below actually defends.
 *   - main's server/mv/blender.js carries the boundary as prose, not as an
 *     exported object, so there is nothing to read.
 *
 * Node's own runner, no dependencies beyond node:fs and node:path, no GPU, no
 * network. It reads files and returns 1 if the boundary has been crossed.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
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

/** Every .js/.mjs/.py in the repo, minus the places source does not live. */
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

const files = sources(REPO);
ok(`the scan sees the repo at all (${files.length} source files)`, files.length > 100,
  "a scan that walks nothing passes everything");

/* `import bpy` / `from bpy...`. Written as a PATTERN rather than a substring so
 * the word "bpy" can still be DISCUSSED in a comment — which config.js,
 * server/mv/blender.js and server/mesh/deform.js all do at length, and must be
 * able to keep doing. A substring match would fail on its own explanation. */
const IMPORTS_BPY = /^\s*(?:import\s+bpy\b|from\s+bpy[\s.]|import\s+.*\bfrom\s+["']bpy["'])/m;
const IMPORTS_PREVIZ = /^\s*(?:from\s+previz[\s.]|import\s+previz\b)/m;

const bpyOffenders = [];
const previzOffenders = [];
for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  if (IMPORTS_BPY.test(text)) bpyOffenders.push(path.relative(REPO, f));
  if (IMPORTS_PREVIZ.test(text)) previzOffenders.push(path.relative(REPO, f));
}

ok("nothing in this repo imports bpy", bpyOffenders.length === 0,
  `${bpyOffenders.join(", ")} — importing bpy makes the file a derivative work under the `
  + "Blender Foundation's position, and this repo is Apache-2.0. Shell out to blender.exe instead.");

ok("nothing in this repo imports the previz package", previzOffenders.length === 0,
  `${previzOffenders.join(", ")} — previz/*.py imports bpy, so importing it inherits the same `
  + "problem. The seam is a subprocess.");

/* The GPL half may sit in vendor/ as a gitlink, but its .py must never be
 * COPIED into the tree, which would pass the import checks above and still be
 * exactly what the boundary forbids. vendor/ is excluded from the walk, so this
 * looks for the modules having been moved somewhere they would ship. */
const copied = files.filter((f) => /[\\/]previz[\\/](moves|scene|blocking|props|shots|cli)\.py$/.test(f));
ok("no previz module has been copied into this tree", copied.length === 0,
  copied.map((f) => path.relative(REPO, f)).join(", "));

/* The seam itself, stated in the source that owns it. If someone rewrites
 * runPreviz to do anything but spawn a process, the prose is the tell. */
const mvBlender = readFileSync(path.join(HERE, "mv", "blender.js"), "utf8");
ok("server/mv/blender.js still describes the seam as a subprocess",
  /subprocess|spawn|execFile/i.test(mvBlender),
  "the Blender seam must remain a process boundary, never an import");

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
