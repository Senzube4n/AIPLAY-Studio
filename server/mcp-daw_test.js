/**
 * Every parameter a DAW tool ADVERTISES actually reaches the route.
 *
 * The mcp-vfx_test guard, applied to the daw_* family: a schema that grows a
 * property whose run() never forwards it validates, returns 200, and silently
 * does nothing — worse than a refusal, because additionalProperties: false
 * tells the client to trust the schema. The check reads each run()'s source
 * and asks whether every declared parameter is named in it (snake_case or its
 * camelCase twin); "declared and dropped" is the class that has actually
 * shipped here.
 */
import { dawTools } from "./mcp-daw.js";

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const tools = dawTools(async () => ({}), (s) => s);

/* Parameters a tool takes but does not name in run(), on purpose — with the
 * reason, so it stays a decision someone wrote down. (None yet.) */
const IGNORED = {};

console.log("\n  -- the tool list is well formed --");

ok("every tool has a name, a description, a schema and a run",
  tools.every((t) => t.name && t.description && t.inputSchema && typeof t.run === "function"));

const names = tools.map((t) => t.name);
ok("no duplicate tool names", new Set(names).size === names.length,
  names.filter((n, i) => names.indexOf(n) !== i).join(", "));

ok("every tool is in the daw_ family", names.every((n) => n.startsWith("daw_")), names.join(", "));

ok("every schema refuses undeclared properties",
  tools.every((t) => t.inputSchema.additionalProperties === false),
  tools.filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name).join(", "));

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
    const camel = p.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!src.includes(p) && !src.includes(camel)) dropped.push(`${t.name}.${p}`);
  }
}

ok("every declared parameter is named in its run()", dropped.length === 0,
  dropped.length
    ? `${dropped.join(", ")}\n          Either forward it, or add it to IGNORED with a reason.`
    : "");

console.log("\n  -- the dual-control seam --");

const src = String(dawTools);
ok("every mutation goes out stamped by: \"agent\"", src.includes(`by: "agent"`));
ok("the time model is stated once and quoted",
  tools.filter((t) => t.description.includes("960 ticks per beat")).length >= 3);

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
