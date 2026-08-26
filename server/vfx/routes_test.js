/**
 * The route module assembles, and its action list is what it claims.
 *
 * Nothing else tests this file. It is nine hundred lines of closure built by
 * one factory call, so a missing import or a typo in a branch that only runs
 * on one action is invisible until someone hits that action — and the whole
 * subsystem is edited by patch scripts, which is exactly how an import gets
 * dropped. Constructing the factory catches the first class; enumerating the
 * actions catches the second.
 *
 * These are STRUCTURAL checks and deliberately touch no disk and no python.
 * The behaviour lives behind HTTP and is checked end-to-end against a running
 * server; this is the cheap guard that runs on every commit.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createVfxRoutes } from "./routes.js";

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
  routes = createVfxRoutes({
    json: () => {},
    readBody: async () => ({}),
    config: { outputDir: path.join(HERE, "__nowhere"), python: "python" },
    IMAGE_DIR: path.join(HERE, "__images"),
    CLIP_DIR: path.join(HERE, "__clips"),
    art: {},
  });
} catch (err) {
  failures.push(`createVfxRoutes threw: ${err.message}`);
  console.log(`  FAIL  createVfxRoutes threw\n          ${err.message}`);
}

ok("createVfxRoutes returns a handler", typeof routes === "function");
ok("...that takes (req, res, url)", routes?.length === 3, `arity ${routes?.length}`);

console.log("\n  -- every action a caller can name --");

/* Read the source rather than the closure: the switch is not reachable from
 * outside, and the point is to notice when an action is added or lost, not to
 * re-implement the dispatch. */
const src = readFileSync(path.join(HERE, "routes.js"), "utf8");
const actions = [...src.matchAll(/^\s*case "([a-z_]+)": \{/gm)].map((m) => m[1]);

const EXPECTED = [
  // documents
  "create", "from_template", "delete", "rename", "set_comp",
  // layers
  "add_layer", "remove_layer", "duplicate_layer", "reorder_layer", "set_layer",
  "add_shape_preset",
  // properties
  "set_prop", "add_key", "remove_key",
  // effects
  "add_effect", "set_effect", "remove_effect", "reorder_effect",
  // FXPRESETS — a layer's effect stack (and optionally its keyframed
  // transform) saved to the app-level shelf and applied anywhere. All five
  // are CALLED in scripts/e2e_vfx.mjs, per the dead-route rule below.
  "save_fx_preset", "list_fx_presets", "apply_fx_preset",
  "delete_fx_preset", "rename_fx_preset",
  // masks and mattes
  "add_mask", "set_mask", "remove_mask", "set_matte",
  // structure
  "precompose",
  // interchange
  "import_studio", "export_studio",
  // analysis — these two were command-line programs no route ran
  "audio_keys", "track_motion",
  // the timeline's waveform: source-derived min/max pairs, sidecar-cached on
  // (file, mtime, bins) — never on updatedAt. CALLED in scripts/e2e_vfx.mjs.
  "audio_peaks",
  // audio → notes (Basic Pitch + the measured post-filter/bend-collapse) and
  // the fretboard/piano rig built from them. Sidecar-cached on
  // (file, mtime, profile), same discipline as audio_peaks. BOTH are CALLED
  // in scripts/e2e_vfx.mjs, per the dead-route rule below.
  "audio_notes", "instrument_rig",
  // discovery — the same enumerator the timeline tree reads, so what the UI
  // can draw and what MCP can name stay one sentence rather than two.
  "layer_properties",
  // output
  "render",
  // RAM preview — pre-render a range so playback is playback. Behaviour is
  // proven over HTTP in routes_ram_test.js; these two are here because this
  // list is the register of what a caller may name.
  "prewarm", "prewarm_cancel",
  // the workspace — gizmo geometry and its inverse (viewport.py, engine maths),
  // a pixel probe off the rendered frame, and align/distribute. All four are
  // CALLED in scripts/e2e_vfx.mjs; a name in a switch that nothing calls is
  // how a route sat dead in this repo for a week.
  "view_overlay", "view_unproject", "probe_pixel", "align_layers",
  // guides — the one piece of viewer furniture that is DOCUMENT state (the
  // grid and safe zones are view state and have no route). Replace-wholesale,
  // like set_comp's markers. CALLED in scripts/e2e_vfx.mjs: set → comp read
  // shows them → survive a second read.
  "set_guides",
];

const missing = EXPECTED.filter((a) => !actions.includes(a));
const extra = actions.filter((a) => !EXPECTED.includes(a));

ok("no expected action has gone missing", missing.length === 0, missing.join(", "));
ok("no action exists that this test does not know about", extra.length === 0,
  `${extra.join(", ")} — add it here, or it is unreviewed`);

const dupes = actions.filter((a, i) => actions.indexOf(a) !== i);
ok("no action is declared twice", dupes.length === 0, dupes.join(", "));

console.log("\n  -- the seams that broke before --");

/* Each of these is a real bug that shipped, caught only by reading the other
 * side's source. A grep is a blunt guard, but it fails loudly if someone
 * reverts the fix, which is the failure mode that actually happened. */
ok("the child-comp walk exists (a comp layer used to fail on frame one)",
  src.includes("resolveChildComps"));
ok("...and the render path uses the tree-aware resolve, not the flat one",
  (src.match(/resolveCompTree\(doc\)/g) || []).length >= 2,
  "frame and render must both resolve children");
ok("the analysis tools are spawned by name, not through the engine",
  src.includes("AUDIOKEYS") && src.includes("TRACKER"));
ok("set_prop can write an expression",
  src.includes("setsExpr") && src.includes("clearsExpr"));
ok("a shape preset name is chosen from a fixed map, never interpolated from input",
  src.includes("const PRESETS = {") && !src.includes("from shapes import ${b."));
ok("fx presets write through the shelf's single writer, and apply mints fresh effect ids",
  src.includes("updateFxPresets(") && src.includes("blankEffect(f.type"));
/* [precomp-nested] precompose once left a DISABLED VIDEO placeholder waiting
 * for a manual render — written before the "comp" layer type existed. Now the
 * comp type exists, precompose must nest live: the holder is a comp layer and
 * its src is the child's slug (src, never compSlug — that field does not
 * exist and fails silently). A revert to the placeholder would pass every
 * structural check above, so it is pinned here. */
ok("precompose leaves a LIVE comp layer, not a disabled video placeholder",
  src.includes(`blankLayer(d, "comp", { name: pcpName })`)
  && src.includes("holder.src = child.slug"));
ok("...and the boundary breaks are computed and answered as warnings",
  src.includes("cutParents") && src.includes("cutMattes") && src.includes("warnings: pcpWarnings"));

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
