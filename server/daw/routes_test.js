/**
 * The DAW route module assembles, and its action list is what it claims.
 *
 * The vfx routes_test's bargain, applied here: the factory is one closure
 * built from injected deps, so a dropped import or a typo in a branch that
 * only runs on one action is invisible until someone hits that action.
 * Constructing the factory catches the first class; enumerating the switch's
 * case labels against the declared list catches the second. STRUCTURAL only
 * — no disk, no python; behaviour is proven over HTTP by scripts/e2e_daw.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDawRoutes } from "./routes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

console.log("\n  -- the factory builds --");

let routes = null;
try {
  routes = createDawRoutes({
    json: () => {},
    readBody: async () => ({}),
    config: { outputDir: path.join(HERE, "__nowhere"), python: "python" },
  });
} catch (err) {
  failures.push(`createDawRoutes threw: ${err.message}`);
  console.log(`  FAIL  createDawRoutes threw\n          ${err.message}`);
}

ok("createDawRoutes returns a handler", typeof routes === "function");
ok("...that takes (req, res, url)", routes?.length === 3, `arity ${routes?.length}`);

console.log("\n  -- every action a caller can name --");

const src = readFileSync(path.join(HERE, "routes.js"), "utf8");
const actions = [...src.matchAll(/^\s*case "([a-z0-9_]+)": \{/gm)].map((m) => m[1]);

const EXPECTED = [
  // documents
  "create", "delete", "set_length",
  // the §12 event lists
  "set_meter", "remove_meter", "set_tempo", "remove_tempo",
  // structure
  "add_track", "set_track", "remove_track", "add_clip", "remove_clip",
  // the piano roll as data
  "add_note", "move_note", "delete_note",
  // the dirty-region loop
  "render",
  // [DAWREC] recording: arm, roll, chunks, takes, comping
  "record_arm", "record_start", "record_chunk_b64", "record_stop",
  "record_status", "take_delete", "take_comp",
  // [DAWREC] audio clips (import is the no-mic path) and MIDI capture
  "import_audio", "set_audio_clip", "remove_audio_clip", "record_notes",
  // [DAWREC] calibration and the audition preview
  "calibrate_b64", "set_latency", "preview_note",
  // the engine's own tables, for the mirror check
  "probe",
];

for (const a of EXPECTED) {
  ok(`action "${a}" is handled`, actions.includes(a));
}
const extra = actions.filter((a) => !EXPECTED.includes(a));
ok("no action is handled but undeclared here", extra.length === 0, extra.join(", "));

// The default-branch error message must name every real action — it is the
// discovery surface an agent that guessed wrong actually reads.
const defaultMsg = src.match(/Unknown action[^;]+/)?.[0] ?? "";
const unnamed = EXPECTED.filter((a) => !defaultMsg.includes(a));
ok("the unknown-action message names every action", unnamed.length === 0, unnamed.join(", "));

console.log("\n  -- the dual-control seams --");

ok("every mutation stamps attribution (byOf reaches the ledger)",
  /noteLedger\(d, \{ by: byOf\(b\), action/.test(src));
ok("mutations answer with their dirty regions",
  /dirty = dirtyBetween\(before, after/.test(src));
ok("region audio is content-addressed and immutable",
  /reg\\d\+_\[0-9a-f\]\{12\}\\.wav/.test(src) && src.includes("immutable"));
ok("the serve lane has a per-call fallback",
  src.includes("serveTransport") && src.includes("runOnce"));

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
