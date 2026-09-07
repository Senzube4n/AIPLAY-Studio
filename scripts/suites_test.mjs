/**
 * THE REGISTRATION CENSUS — every test suite on disk is run by the gate.
 *
 * ── the failure this exists for ──────────────────────────────────────────────
 *
 * On 2026-09-06 four suites were added to this repository and registered
 * nowhere. They passed, they were cited in a report as evidence, and the hook
 * never ran one of them — including the seventy-six assertions that were the
 * entire skin-validation fix, standing in front of an in-place file overwrite
 * where a degenerate rig would have destroyed the mesh it was meant to improve.
 * They were wired in by hand afterwards, which fixes those four and prevents
 * nothing.
 *
 * A test suite the gate does not run is not protecting the thing it was written
 * for. It is worse than no suite, because its existence is read as coverage —
 * by the next agent, and by the person who is told the feature is tested.
 *
 * ── what this lane asserts ───────────────────────────────────────────────────
 *
 * Every `*_test.js`, `*_test.mjs` and `*_test.py` in the tree is named
 * somewhere in `.githooks/pre-commit`, or is listed in UNREGISTERED below with
 * a reason. The list is the whole point: an exemption has to be typed out and
 * justified, so "not run" is always a decision somebody made rather than a
 * suite that slipped.
 *
 * It does NOT check that a registered suite passes — every other lane does
 * that. It checks that the gate knows the suite exists.
 *
 * Runs standalone (`node scripts/suites_test.mjs`) and in the pre-commit hook.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, ".githooks", "pre-commit");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/**
 * SUITES THE GATE DELIBERATELY DOES NOT RUN. A reason each, and the reason has
 * to be a real one — "it is slow" is not, since a slow lane belongs behind a
 * flag rather than outside the census.
 */
const MANUAL_HARNESS =
  "named _test but it is not a suite: it takes command-line arguments, renders on the graphics "
  + "card and prints numbers for a person to read. It has no pass/fail and asserts nothing. A "
  + "six-minute gate that also spends GPU is a gate people disable.";

const UNREGISTERED = {

  "scripts/fp32_audio_test.mjs": MANUAL_HARNESS + " Measured: it rendered an 18-second FLAC.",
  "scripts/h3_native_test.mjs": MANUAL_HARNESS + " It is an INVESTIGATION — whether the video "
    + "model was being asked for lengths and sizes outside its trained range — kept because the "
    + "question recurs.",
  "scripts/morph_test.mjs": MANUAL_HARNESS + " Takes a song and a list of images on the command "
    + "line.",
  "scripts/restyle_test.mjs": MANUAL_HARNESS + " Takes a clip name and a song on the command line.",
};

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "output", "outputs", ".venv", "venv", "venv311"]);
const IS_SUITE = /_test\.(js|mjs|py)$/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
    } else if (IS_SUITE.test(name)) {
      out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
}

const hook = readFileSync(HOOK, "utf8");
const suites = walk(ROOT).sort();

console.log(`\nTHE REGISTRATION CENSUS — ${suites.length} suites on disk`);

ok(`the tree was walked and suites were found (${suites.length})`, suites.length > 40,
  "if this is small the walk is broken and every assertion below is vacuous");

/* A suite counts as registered when its path appears in the hook. Matching on
 * the PATH and not the basename is deliberate: two suites named `routes_test.js`
 * in different folders are two suites, and a hook that runs one of them has not
 * run the other. */
const missing = [];
for (const suite of suites) {
  if (suite in UNREGISTERED) continue;
  if (!hook.includes(suite)) missing.push(suite);
}

ok("every suite on disk is run by the gate, or is exempted by name with a reason",
  missing.length === 0,
  missing.length
    ? `${missing.length} suite(s) the hook never runs:\n          `
      + missing.join("\n          ")
      + "\n\n          Add a line to .githooks/pre-commit that runs each, or — if it truly should not"
      + "\n          run — add it to UNREGISTERED in scripts/suites_test.mjs with the reason."
    : "");

/* The exemption list must not rot. An entry naming a file that no longer exists
 * is a licence somebody could later inherit for a different file at that path. */
const ghosts = Object.keys(UNREGISTERED).filter((p) => !suites.includes(p));
ok("every exemption names a suite that exists", ghosts.length === 0,
  `these are exempted and not on disk: ${ghosts.join(", ")}`);

const thin = Object.entries(UNREGISTERED).filter(([, why]) => !why || why.length < 30);
ok("every exemption gives a real reason", thin.length === 0,
  thin.map(([p]) => p).join(", "));

/* And the reverse direction, which catches a renamed or deleted suite still
 * being invoked: a hook line that runs a file that is not there fails the whole
 * gate at that line, so this is really about a clear message rather than a
 * missed test — but a clear message on a six-minute gate is worth a lane. */
const invoked = [...hook.matchAll(/^\s*(?:node|python|py -3(?:\.\d+)?)\s+(\S+_test\.(?:js|mjs|py))/gm)]
  .map((m) => m[1].replace(/^\.\//, ""));
const dangling = [...new Set(invoked)].filter((p) => !suites.includes(p));
ok(`every suite the hook invokes exists on disk (${new Set(invoked).size} invoked)`,
  dangling.length === 0, `the hook runs these and they are gone: ${dangling.join(", ")}`);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
