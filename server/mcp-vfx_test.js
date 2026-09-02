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
  vfx_camera_move: "*",
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

console.log("\n  -- effect presets reach all five actions --");

/* FXPRESETS: one tool, op-dispatched. Each op must post its own route action —
 * an op in the enum whose branch is missing would validate, 200, and do the
 * wrong thing entirely, which is the declared-and-dropped bug one level up. */
const fxp = tools.find((t) => t.name === "vfx_effect_presets");
ok("vfx_effect_presets exists", !!fxp);
for (const act of ["list_fx_presets", "save_fx_preset", "apply_fx_preset",
                   "delete_fx_preset", "rename_fx_preset"]) {
  ok(`...and posts ${act}`, String(fxp?.run || "").includes(`"${act}"`));
}
ok("...forwarding include_transform on the wire spelling",
  String(fxp?.run || "").includes("includeTransform: a.include_transform"));
ok("...and every op in the schema has a branch",
  (fxp?.inputSchema.properties.op.enum || []).every((op) => String(fxp.run).includes(`case "${op}"`)));

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
/* Auto-orient: the same one-typo-from-invisible argument. The schema also has
 * to advertise exactly the modes the store accepts — "towardCamera" is refused
 * by the route with a reason, so offering it in an enum would be a lying
 * schema, the precise failure this file exists to prevent. */
ok("vfx_set_layer forwards autoOrient", String(setLayer.run).includes("autoOrient: a.auto_orient"));
ok("vfx_set_layer offers exactly the auto-orient modes the store takes",
  JSON.stringify(setLayer.inputSchema.properties.auto_orient?.enum) === JSON.stringify(["off", "alongPath"]),
  JSON.stringify(setLayer.inputSchema.properties.auto_orient?.enum));

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

/* [precomp-nested] precompose is live nesting now. The old tool answered a
 * `next` string telling the caller to render the child and fill a disabled
 * placeholder by hand; a revert would validate fine, so the new reply shape
 * is pinned: the comp layer's id and the boundary warnings both surface. */
const pcpTool = tools.find((t) => t.name === "vfx_precompose");
ok("vfx_precompose exists", !!pcpTool);
ok("...and posts the precompose action", String(pcpTool?.run || "").includes(`"precompose"`));
ok("...and hands back the comp layer's id, not a placeholder",
  String(pcpTool?.run || "").includes("comp_layer_id"));
ok("...and surfaces the boundary warnings", String(pcpTool?.run || "").includes("warnings: r.warnings"));
/* Waveform peaks — the same pinning idiom: every snake_case parameter's exact
 * forwarding expression, because the declared-and-dropped heuristic above is
 * satisfied by the name appearing ANYWHERE in run(), descriptions included. */
const peaksTool = tools.find((t) => t.name === "vfx_audio_peaks");
ok("vfx_audio_peaks exists", !!peaksTool);
ok("...posts the audio_peaks action", String(peaksTool?.run || "").includes(`"audio_peaks"`));
ok("...forwards layer_id as layerId", String(peaksTool?.run || "").includes("layerId: a.layer_id"));
ok("...forwards pixels_per_second as pixelsPerSecond",
  String(peaksTool?.run || "").includes("pixelsPerSecond: a.pixels_per_second"));
ok("...forwards src and bins", String(peaksTool?.run || "").includes("src: a.src")
  && String(peaksTool?.run || "").includes("bins: a.bins"));
ok("...and refuses parameters it does not know (additionalProperties:false)",
  peaksTool?.inputSchema?.additionalProperties === false);

/* Audio → notes and the instrument rigs — the same exact-expression pinning,
 * because both tools take snake_case that must land as camelCase on the wire,
 * and a parameter that only appears in the description string would satisfy
 * the declared-and-dropped heuristic while doing nothing. */
const notesTool = tools.find((t) => t.name === "vfx_audio_notes");
ok("vfx_audio_notes exists", !!notesTool);
ok("...posts the audio_notes action", String(notesTool?.run || "").includes(`"audio_notes"`));
ok("...forwards layer_id as layerId", String(notesTool?.run || "").includes("layerId: a.layer_id"));
ok("...forwards the profile, the fingering switch, tuning and frets",
  ["profile: a.profile", "fingering: a.fingering", "tuning: a.tuning", "frets: a.frets"]
    .every((s) => String(notesTool?.run || "").includes(s)));
ok("...offers exactly the two measured profiles",
  JSON.stringify(notesTool?.inputSchema?.properties?.profile?.enum) === JSON.stringify(["guitar", "bass"]),
  JSON.stringify(notesTool?.inputSchema?.properties?.profile?.enum));
ok("...and refuses parameters it does not know (additionalProperties:false)",
  notesTool?.inputSchema?.additionalProperties === false);
ok("...its reply surfaces the cache claim (`cached`), the peaks idiom",
  String(notesTool?.run || "").includes("cached: r.cached"));

const rigTool = tools.find((t) => t.name === "vfx_instrument_rig");
ok("vfx_instrument_rig exists", !!rigTool);
ok("...posts the instrument_rig action", String(rigTool?.run || "").includes(`"instrument_rig"`));
ok("...forwards left_handed as leftHanded", String(rigTool?.run || "").includes("leftHanded: a.left_handed"));
ok("...forwards bend_visual as bendVisual", String(rigTool?.run || "").includes("bendVisual: a.bend_visual"));
ok("...forwards notes, audio, profile, frets, tab, roll, tuning, colors, name",
  ["notes: a.notes", "audio: a.audio", "profile: a.profile", "frets: a.frets",
   "tab: a.tab", "roll: a.roll", "tuning: a.tuning", "colors: a.colors", "name: a.name"]
    .every((s) => String(rigTool?.run || "").includes(s)));
ok("...offers exactly the two rigs that exist",
  JSON.stringify(rigTool?.inputSchema?.properties?.instrument?.enum) === JSON.stringify(["guitar", "piano"]),
  JSON.stringify(rigTool?.inputSchema?.properties?.instrument?.enum));
ok("...and its colors object is a closed schema too",
  rigTool?.inputSchema?.properties?.colors?.additionalProperties === false);
ok("...and refuses parameters it does not know (additionalProperties:false)",
  rigTool?.inputSchema?.additionalProperties === false);
console.log("\n  -- lights reach both directions --");

/* The store, the engine and the gizmo all knew about lights before either
 * surface could author one. The exact forwarding expressions are pinned, the
 * same reason audio's are: one typo from vanishing into a description string. */
ok("vfx_add_layer offers the light layer kind",
  (addLayer.inputSchema.properties.type.enum || []).includes("light"),
  JSON.stringify(addLayer.inputSchema.properties.type.enum));
ok("vfx_add_layer forwards the light spec", String(addLayer.run).includes("light: a.light"));
ok("vfx_set_layer forwards light", String(setLayer.run).includes("light: a.light"));
ok("vfx_set_layer forwards material", String(setLayer.run).includes("material: a.material"));

console.log("\n  -- masks are editable, not just addable --");

/* An agent that added a wrong mask was stuck with it: the GUI had set_mask and
 * remove_mask, MCP had neither — the one drift this codebase is not allowed
 * to ship, in the other direction for once. */
const setMask = tools.find((t) => t.name === "vfx_set_mask");
ok("vfx_set_mask exists", !!setMask);
ok("...and posts the set_mask action", String(setMask?.run || "").includes(`"set_mask"`));
ok("...forwarding mask_id as maskId", String(setMask?.run || "").includes("maskId: a.mask_id"));
ok("...and refuses parameters it does not know",
  setMask?.inputSchema?.additionalProperties === false);

const rmMask = tools.find((t) => t.name === "vfx_remove_mask");
ok("vfx_remove_mask exists", !!rmMask);
ok("...and posts the remove_mask action", String(rmMask?.run || "").includes(`"remove_mask"`));
ok("...forwarding mask_id as maskId", String(rmMask?.run || "").includes("maskId: a.mask_id"));

console.log("\n  -- the RAM preview is drivable from MCP --");

const prewarm = tools.find((t) => t.name === "vfx_prewarm");
ok("vfx_prewarm exists", !!prewarm);
ok("...and posts the prewarm action", String(prewarm?.run || "").includes(`"prewarm"`));
ok("...and the cancel op posts prewarm_cancel", String(prewarm?.run || "").includes(`"prewarm_cancel"`));
ok("...forwarding job_id as jobId", String(prewarm?.run || "").includes("jobId: a.job_id"));

console.log("\n  -- timeRemap has a way OUT --");

/* set_prop value:null used to coerce to a constant-0 remap the engine
 * ignores, while the audio refusal told people to "remove the timeRemap"
 * through a door that did not exist. The schema now documents the null
 * clear and the run surfaces the route's `cleared` confirmation. */
ok("vfx_set_property's value documents the null clear on timeRemap",
  /timeRemap.*null CLEARS/i.test(setProp.inputSchema.properties.value.description || ""),
  setProp.inputSchema.properties.value.description);
ok("...and its run surfaces `cleared`", String(setProp.run).includes("cleared"));

console.log("\n  -- align says when it could not move something --");

ok("vfx_align_layers surfaces the plane-bounds warnings",
  String(align.run).includes("warnings: r.warnings"));

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
