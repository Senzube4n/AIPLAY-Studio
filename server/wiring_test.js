/**
 * EVERY DOOR IS HUNG — a census of what is REACHABLE, not of what exists.
 *
 * ⚠ WHY THIS FILE EXISTS. On 2026-09-11, `server/score/` shipped with 2451
 * lines across four modules and 1287 passing assertions, and `/api/score`
 * answered the app's own 404. `server/mcp-music-score.js` shipped with 188
 * passing assertions and not one of its tools appeared on the surface an agent
 * sees. Both suites passed the entire time, because both import the thing they
 * test and call it directly — which proves a module WORKS and says nothing
 * about whether anything CALLS it. Two doors, both tested, neither hung.
 *
 * The hole was found by asking the running server for a score list. Nothing in
 * the repository was in a position to notice, so this is that thing: it reads
 * the source text of index.js and mcp.js and checks that each factory and each
 * tool set is both imported and actually used.
 *
 * ⚠ IT READS THE SOURCE, NOT THE MODULES — the same decision fit_test.js makes
 * about the shipped video default, and for a related reason. Importing index.js
 * starts a server, binds a port and launches the engine; a test that has to run
 * the app to check the app's wiring is a test nobody runs. The cost is that
 * this checks the TEXT: a dispatch inside `if (false)` would satisfy it. That
 * is a much smaller lie than a door that was never hung, and it is the lie this
 * file is not trying to catch.
 *
 * Adding a route module or a tool file with no registration now fails here,
 * naming the file and the line to add.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;

function ok(name, got, detail) {
  if (got === true) { pass++; console.log(`  ok    ${name}`); return; }
  fail++;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`          ${detail}`);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__pycache__" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(HERE);
const rel = (p) => path.relative(HERE, p).replace(/\\/g, "/");

console.log("\nHTTP: every routes.js factory is imported AND dispatched in index.js");
{
  const index = readFileSync(path.join(HERE, "index.js"), "utf8");
  const routeFiles = files.filter((p) => /(^|[\\/])routes\.js$/.test(p) && !/_test\.js$/.test(p));
  ok("there are route modules to check at all", routeFiles.length > 0, `${routeFiles.length} found`);

  for (const p of routeFiles.sort()) {
    const src = readFileSync(p, "utf8");
    const m = src.match(/export function (create[A-Za-z]*Routes)/);
    if (!m) continue;                       // not the factory shape; nothing to assert
    const fn = m[1];
    ok(`${rel(p)} — index.js imports ${fn}`,
      new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from`).test(index),
      `add: import { ${fn} } from "./${rel(p)}";`);
    /* Imported and never called is the same dead end as not imported, so the
     * call site is asserted separately from the import. */
    ok(`${rel(p)} — ...and calls it`,
      new RegExp(`${fn}\\s*\\(`).test(index),
      `add: const x = ${fn}({ json, readBody, config, provenance: prov });`);
  }
}

console.log("\nMCP: every mcp-*.js tool set is spread into some surface");
{
  /* ⚠ ANY AGGREGATOR, NOT JUST mcp.js. The first version of this check asked
   * only about mcp.js and reported five false failures: the DAW's sub-surfaces
   * (ear, master, rack, refprofile, voicelab) are composed inside mcp-daw.js,
   * which is itself spread into mcp.js. A guard that cries wolf about correct
   * code gets switched off, and then it is not guarding anything. So the
   * property asserted is the real one — SOMETHING other than the defining file
   * spreads these tools — rather than a guess about which file that is. */
  const aggregators = files
    .filter((p) => p.endsWith(".js") && !/_test\.js$/.test(p))
    .map((p) => ({ p, src: readFileSync(p, "utf8") }));

  const toolFiles = files
    .filter((p) => /[\\/]mcp-[a-z0-9-]+\.js$/.test(p) && !/_test\.js$/.test(p))
    .sort();
  ok("there are tool modules to check at all", toolFiles.length > 0, `${toolFiles.length} found`);

  for (const p of toolFiles) {
    const src = readFileSync(p, "utf8");
    const m = src.match(/export (?:function|const) ([a-zA-Z]*Tools)\b/);
    if (!m) continue;
    const fn = m[1];
    /* The spread is the registration. An import alone leaves the tools defined
     * and invisible, which is exactly how scoreTools spent its first night —
     * so this looks for the spread, and the import comes along with it. */
    const spread = new RegExp(`\\.\\.\\.\\s*\\(?\\s*${fn}\\b`);
    const host = aggregators.find((a) => a.p !== p && spread.test(a.src));
    ok(`${rel(p)} — ${fn} is spread into a surface${host ? ` (${rel(host.p)})` : ""}`,
      !!host,
      `nothing spreads ${fn}, so none of its tools exist for an agent. `
      + `add: ...${fn}(api),  beside the other spreads in mcp.js`);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
