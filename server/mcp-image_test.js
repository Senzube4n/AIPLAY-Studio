/**
 * Every parameter an mcp.js tool ADVERTISES actually reaches its run().
 *
 * The same guard mcp-vfx_test.js runs over the VFX tools, extended to the
 * main tool list — because the same bug shipped here too: a schema property
 * added without its run() forwarding it validates, returns 200, and silently
 * does nothing. `additionalProperties: false` means a client trusts the
 * schema, so a schema that lies is a feature that appears to work.
 *
 * The check is a heuristic: it reads each tool's run source and asks whether
 * the parameter's name appears in it. That cannot prove the value is used
 * correctly, but it catches "declared and dropped", which is the class that
 * has actually happened. A tool that forwards its whole argument object is
 * listed in IGNORED, with the reason written down.
 *
 * Plus the structural checks for the routes the image panels lean on — the
 * same source-reading style vfx/routes_test.js uses, because these run on
 * every commit and must not need a server or a python.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOOLS } from "./mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* Parameters a tool takes but does not name in run(), on purpose. */
const IGNORED = {
  // Spread wholesale into the request body, so no name appears individually.
  image_sheet: "*",
  // Destructures the handful it renames and REST-SPREADS everything else into
  // ops — the spread is the forwarding, so nothing declared can be dropped.
  image_adjust: "*",
};

/* The vfx_* tools are appended into TOOLS from mcp-vfx.js and carry their own
 * IGNORED table in mcp-vfx_test.js; checking them twice with a second table
 * is how the two tables drift. This file owns the rest. */
const OURS = TOOLS.filter((t) => !t.name.startsWith("vfx_"));

console.log("\n  -- the tool list is well formed --");

ok("every tool has a name, a description, a schema and a run",
  TOOLS.every((t) => t.name && t.description && t.inputSchema && typeof t.run === "function"));

const names = TOOLS.map((t) => t.name);
ok("no duplicate tool names", new Set(names).size === names.length,
  names.filter((n, i) => names.indexOf(n) !== i).join(", "));

ok("every required parameter is also declared",
  TOOLS.every((t) => (t.inputSchema.required || []).every((r) => t.inputSchema.properties?.[r])),
  TOOLS.filter((t) => (t.inputSchema.required || []).some((r) => !t.inputSchema.properties?.[r]))
    .map((t) => t.name).join(", "));

console.log("\n  -- nothing is advertised and then dropped --");

const dropped = [];
for (const t of OURS) {
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

console.log("\n  -- the panel routes the tools lean on --");

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const idx = readFileSync(path.join(HERE, "index.js"), "utf8");

/* image_tools_catalog promises module=paths; the route's MODULES map is where
 * that promise is kept or broken. It WAS broken — the MCP description said
 * paths for as long as the pen existed while the route never served it. */
ok("the tools route serves the paths module",
  /MODULES = \{[\s\S]{0,400}paths: "imgpath"/.test(idx));

const catalogTool = byName.get("image_tools_catalog");
ok("image_tools_catalog names paths in its module list",
  /paths/.test(String(catalogTool?.inputSchema?.properties?.module?.description || "")));

/* image_swatches speaks to /api/images/swatches; both verbs must have a
 * handler, or the tool is a face on a 404. */
ok("the swatches route has a GET handler",
  idx.includes('p === "/api/images/swatches" && req.method === "GET"'));
ok("...and a POST handler",
  idx.includes('p === "/api/images/swatches" && req.method === "POST"'));
ok("image_swatches exists and calls that route",
  String(byName.get("image_swatches")?.run || "").includes("/api/images/swatches"));

console.log("\n  -- the parameters the panels added --");

const adjust = byName.get("image_adjust");
ok("image_adjust declares channel with the five planes",
  JSON.stringify(adjust?.inputSchema?.properties?.channel?.enum) ===
  JSON.stringify(["r", "g", "b", "a", "luminosity"]));
ok("...and its run() forwards it (via the ops spread)",
  String(adjust.run).includes("...ops"));
ok("image_adjust's selection doc names the channel and path kinds",
  /channel/.test(adjust.inputSchema.properties.selection.description)
  && /'path'/.test(adjust.inputSchema.properties.selection.description));
ok("image_adjust's strokes doc names stroke-a-path",
  /path/.test(adjust.inputSchema.properties.strokes.description));
ok("image_adjust's text doc names the _v2 spec",
  /_v2/.test(adjust.inputSchema.properties.text.description));

console.log("\n  -- clipping masks --");

/* `clipped` lives on the LAYER ITEMS, one level under the top-level `layers`
 * property, so the generic declared-and-dropped sweep above never sees it —
 * these are its guards. The run() forwards it in the ...l spread; the route
 * is where it could silently die, so the route is what gets read. */
const composite = byName.get("image_composite");
ok("image_composite's layer items declare clipped",
  composite?.inputSchema?.properties?.layers?.items?.properties?.clipped?.type === "boolean");
ok("...and its run() forwards layer objects wholesale, spread included",
  String(composite?.run || "").includes("...l"));
const compSrc = idx.slice(idx.indexOf('p === "/api/images/composite"'));
ok("the composite route reads the clipped flag",
  compSrc.includes("l.clipped"));
ok("...and renders a clipped composite through imgdoc.py — ONE implementation " +
   "of the semantics, before the flat imagetools path",
  compSrc.slice(0, compSrc.indexOf("imagetools.py")).includes("imgdoc.py"));
ok("...refusing flips loudly instead of landing them a half-pixel off",
  compSrc.includes("flipH/flipV cannot ride a clipped composite"));
ok("image_composite's description teaches the clipping mask",
  /clipping mask/i.test(composite?.description || ""));
ok("image_document teaches clipped: true in its description",
  /clipped: true/.test(byName.get("image_document")?.description || ""));
ok("...and the semantics live in imgdoc.py's own catalog, not a second copy",
  /"clipped": flag\(/.test(readFileSync(path.join(HERE, "imgdoc.py"), "utf8")));

console.log("\n  -- the document route stages every source the shape allows --");

/* The source walk collects library names for python to resolve. imgdoc.py's
 * shape puts `src` on image layers AND on any layer's mask (MASK_PARAMS is
 * common to every kind, groups included) — a doc with mask:{src} used to
 * render UNMASKED with a warning misdiagnosing the file as missing, because
 * the walk only ever staged l.src. */
const docSrc = idx.slice(idx.indexOf('p === "/api/images/document"'),
                         idx.indexOf('p === "/api/images/capabilities"'));
ok("the source walk stages l.src", /stage\(l\.src\)/.test(docSrc));
ok("...and l.mask.src, at any depth", /stage\(l\.mask\.src\)/.test(docSrc));
ok("...before recursing into children, so a group's own mask is not skipped",
  docSrc.indexOf("stage(l.mask.src)") < docSrc.indexOf("walk(l.layers)"));

console.log(failures.length
  ? `\n  ${pass} ok, ${failures.length} FAILED\n`
  : `\n  all ${pass} checks pass\n`);
process.exit(failures.length ? 1 : 0);
