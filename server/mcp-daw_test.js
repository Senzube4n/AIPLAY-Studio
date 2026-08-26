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
 *
 * ── AND THE PARITY GATE, the other way round (agent/dawparity) ───────────
 *
 * server/daw/ui_test.js proves every action the PAGE posts is one the server
 * really dispatches. This file now proves the mirror image: every action the
 * server dispatches is one some daw_* tool can reach. That is the owner's
 * standing constraint — everything a human can do, an agent can do — in
 * executable form. It was not, and six capabilities (set_length, remove_track,
 * remove_clip, remove_meter, remove_tempo, preview_note) plus three more the
 * first sweep missed (record_notes, set_audio_clip, remove_audio_clip) were
 * reachable from the window and from nowhere else. An exemption is allowed,
 * but it has to be written down with a reason.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dawTools } from "./mcp-daw.js";
import { MIXER_ACTIONS } from "./daw/mixer.js";

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

console.log("\n  -- THE PARITY GATE: no capability is reachable from one hand only --");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(path.join(HERE, p), "utf8");

/* Route-level case labels only: both files also switch on card kinds and
 * device types further in, at four spaces. Eight is the dispatch. */
const routeCases = (s) => [...s.matchAll(/^ {8}case "([a-z0-9_]+)": \{/gm)].map((m) => m[1]);
const serverActions = [...new Set([
  ...routeCases(rd("daw/routes.js")),
  ...routeCases(rd("daw/ear.js")),
  ...MIXER_ACTIONS,
])].sort();

/* What the tool family posts, read out of the run() sources themselves —
 * the same evidence the declared-and-dropped check uses. */
const reached = new Map();
for (const t of tools) {
  for (const m of String(t.run).matchAll(/action:\s*"([a-z0-9_]+)"/g)) {
    if (!reached.has(m[1])) reached.set(m[1], []);
    reached.get(m[1]).push(t.name);
  }
}

/* Actions deliberately left off the MCP surface, WITH the reason. */
const NO_TOOL = {
  analyse_file: "THE EAR's file measurement — server/daw/ear.js and mcp-ear.js are the "
    + "Ear lane's files, not this one's. Reachable over HTTP; reported as an open gap.",
  judge: "THE EAR's subjective stage — same lane, same reason. Reported as an open gap.",
};

const unreachable = serverActions.filter((a) => !reached.has(a) && !NO_TOOL[a]);
ok(`every action the server dispatches is reachable from a tool (${serverActions.length} actions)`,
  unreachable.length === 0,
  unreachable.length
    ? `${unreachable.join(", ")}\n          A human can do these and an agent cannot. `
      + "Add a tool, or add the action to NO_TOOL with a reason."
    : "");

ok("every exemption names an action that really exists",
  Object.keys(NO_TOOL).every((a) => serverActions.includes(a)),
  Object.keys(NO_TOOL).filter((a) => !serverActions.includes(a)).join(", "));
ok("...and no exemption is stale (a covered action must not stay exempt)",
  Object.keys(NO_TOOL).every((a) => !reached.has(a)),
  Object.keys(NO_TOOL).filter((a) => reached.has(a)).join(", "));

/* The mirror of the mirror: a tool must not post an action the server has
 * no case for — the same orphan check ui_test.js runs over the page. */
const orphans = [...reached.keys()].filter((a) => !serverActions.includes(a));
ok("no tool posts an action the server does not dispatch", orphans.length === 0,
  orphans.map((a) => `${a} (${reached.get(a).join(", ")})`).join(", "));

console.log(`        (exempt, by name: ${Object.keys(NO_TOOL).join(", ") || "none"})`);

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
