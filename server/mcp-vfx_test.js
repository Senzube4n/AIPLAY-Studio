/**
 * Every parameter a VFX tool ADVERTISES actually reaches the route.
 *
 * The bug this exists for: `vfx_set_comp` grew a `seed` property in its schema
 * and its `run()` was never updated, so the call validated, returned 200, and
 * silently did nothing. That is worse than a refusal — `additionalProperties:
 * false` means a client trusts the schema, and a schema that lies is a
 * feature that appears to work.
 *
 * The check is a heuristic: it reads each tool's `run` source and asks whether
 * the parameter name appears anywhere in it. That cannot prove the value is
 * used correctly, but it catches the whole class of "declared and dropped",
 * which is the one that has actually happened. Anything genuinely accepted and
 * deliberately ignored has to be listed in IGNORED below, with a reason —
 * which is the point: it becomes a decision someone wrote down.
 */
import { readFileSync } from "node:fs";
import { vfxTools } from "./mcp-vfx.js";

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const tools = vfxTools(async () => ({}), (s) => s);

/* Parameters a tool takes but does not name in run(), on purpose. */
const IGNORED = {
  // Spread wholesale into the request body, so no name appears individually.
  vfx_audio_keys: "*",
  vfx_track_motion: "*",
  vfx_shape_preset: "*",
};

console.log("\n  -- the tool list is well formed --");

ok("every tool has a name, a description, a schema and a run",
  tools.every((t) => t.name && t.description && t.inputSchema && typeof t.run === "function"));

const names = tools.map((t) => t.name);
ok("no duplicate tool names", new Set(names).size === names.length,
  names.filter((n, i) => names.indexOf(n) !== i).join(", "));

ok("every required parameter is also declared",
  tools.every((t) => (t.inputSchema.required || []).every((r) => t.inputSchema.properties?.[r])),
  tools.filter((t) => (t.inputSchema.required || []).some((r) => !t.inputSchema.properties?.[r]))
    .map((t) => t.name).join(", "));

console.log("\n  -- nothing is advertised and then dropped --");

const dropped = [];
for (const t of tools) {
  if (IGNORED[t.name] === "*") continue;
  const src = String(t.run);
  const ignored = new Set(IGNORED[t.name] || []);
  for (const p of Object.keys(t.inputSchema.properties || {})) {
    if (ignored.has(p)) continue;
    // snake_case in the schema becomes camelCase on the wire; either spelling
    // appearing in run() means the parameter was not forgotten.
    const camel = p.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!src.includes(p) && !src.includes(camel)) dropped.push(`${t.name}.${p}`);
  }
}

ok("every declared parameter is named in its run()", dropped.length === 0,
  dropped.length
    ? `${dropped.join(", ")}\n          Either forward it, or add it to IGNORED with a reason.`
    : "");

console.log("\n  -- the parameters that were added late --");

const setComp = tools.find((t) => t.name === "vfx_set_comp");
ok("vfx_set_comp forwards seed", String(setComp.run).includes("seed: a.seed"));

const setProp = tools.find((t) => t.name === "vfx_set_property");
ok("vfx_set_property forwards expr", String(setProp.run).includes("expr: a.expr"));

const setLayer = tools.find((t) => t.name === "vfx_set_layer");
for (const f of ["threeD", "camera", "shapes", "animators", "collapse", "frameBlend", "styles",
                 "shy", "label"]) {
  ok(`vfx_set_layer forwards ${f}`, String(setLayer.run).includes(f));
}

ok("vfx_set_comp forwards hide_shy",
  String(setComp.run).includes("hideShy: a.hide_shy"));

console.log("\n  -- the workspace tools exist and reach their routes --");

/* Each of these is a viewport/workspace capability the GUI grew; if the tool
 * vanishes, MCP loses parity with a gesture a human has — the one drift this
 * codebase is not allowed to ship. */
const preview = tools.find((t) => t.name === "vfx_preview_frame");
ok("vfx_preview_frame takes a view", !!preview.inputSchema.properties.view);
ok("...and forwards it", String(preview.run).includes(`q.set("view"`));

const probe = tools.find((t) => t.name === "vfx_probe_pixel");
ok("vfx_probe_pixel exists", !!probe);
ok("...and posts the probe_pixel action", String(probe?.run || "").includes(`"probe_pixel"`));

const align = tools.find((t) => t.name === "vfx_align_layers");
ok("vfx_align_layers exists", !!align);
ok("...and posts the align_layers action", String(align?.run || "").includes(`"align_layers"`));

const overlayTool = tools.find((t) => t.name === "vfx_view_overlay");
ok("vfx_view_overlay exists", !!overlayTool);
ok("...and posts the view_overlay action", String(overlayTool?.run || "").includes(`"view_overlay"`));

const status = tools.find((t) => t.name === "vfx_render_status");
ok("vfx_render_status exists", !!status);
ok("...and reads /api/vfx/renders", String(status?.run || "").includes("/api/vfx/renders"));
/* The audio surface. `audio` is one character away from vanishing into a
 * description string and still matching the heuristic above, so the exact
 * forwarding expressions are pinned — the same reason seed and expr are. */
ok("vfx_set_layer forwards the audio switch", String(setLayer.run).includes("audio: a.audio"));
ok("vfx_set_layer forwards audioLevels", String(setLayer.run).includes("audioLevels: a.audio_levels"));

const addLayer = tools.find((t) => t.name === "vfx_add_layer");
ok("vfx_add_layer offers the audio layer kind",
  (addLayer.inputSchema.properties.type.enum || []).includes("audio"),
  JSON.stringify(addLayer.inputSchema.properties.type.enum));

const importStudio = tools.find((t) => t.name === "vfx_import_studio");
ok("vfx_import_studio forwards audio_as", String(importStudio.run).includes("audioAs: a.audio_as"));
ok("...and offers both homes for audio items",
  JSON.stringify(importStudio.inputSchema.properties.audio_as?.enum) === JSON.stringify(["markers", "layers"]),
  JSON.stringify(importStudio.inputSchema.properties.audio_as));

/* Guides are document state, so MCP must manage them — and SEE them: an agent
 * that cannot read the guide list back cannot respect it. Grid/safe-zone are
 * view furniture with no document state, so no tool exists for them (the
 * set_guides description says so out loud). */
const guidesTool = tools.find((t) => t.name === "vfx_set_guides");
ok("vfx_set_guides exists", !!guidesTool);
ok("...and posts the set_guides action", String(guidesTool?.run || "").includes(`"set_guides"`));
ok("...its guide items are closed schemas too",
  guidesTool?.inputSchema?.properties?.guides?.items?.additionalProperties === false);
ok("the comp summary carries guides, so vfx_get_comp shows them without full:true",
  /guides: comp\.guides/.test(readFileSync(new URL("./mcp-vfx.js", import.meta.url), "utf8")));

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
