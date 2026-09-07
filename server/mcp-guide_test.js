/**
 * Every tool name pipeline_guide utters actually exists.
 *
 * The drift this repo ships is the guide kind: a map that names a tool which
 * was renamed, merged or never built, and every agent that trusts the map
 * then calls a phantom. The guide's contract (written at the top of
 * mcp-guide.js) is that tool names — and ONLY tool names — are backticked,
 * which makes the check mechanical: extract every backticked token from
 * every section, assert each one is in the LIVE tool list. Runs in the
 * pre-commit hook, so the guide cannot outlive a rename.
 *
 * Also pins the shape: the guide is the FIRST tool an agent lists, the
 * initialize reply points at it, each topic answers alone, and the full
 * text stays under a size an agent can afford to read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOOLS } from "./mcp.js";
import { guideTools, GUIDE_SECTIONS } from "./mcp-guide.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const live = new Set(TOOLS.map((t) => t.name));
const guide = guideTools()[0];

console.log("\n  -- the guide is wired and discoverable --");

ok("pipeline_guide is in the live tool list", live.has("pipeline_guide"));
ok("pipeline_guide is the FIRST tool in the list", TOOLS[0]?.name === "pipeline_guide",
  `first is ${TOOLS[0]?.name}`);

const mcpSrc = readFileSync(path.join(HERE, "mcp.js"), "utf8");
ok("the initialize reply's instructions point at pipeline_guide",
  /instructions:[\s\S]{0,200}pipeline_guide/.test(mcpSrc));

console.log("\n  -- no section names a phantom tool --");

/* The contract: backticks wrap tool names and nothing else. So every
 * backticked token must be a live tool — a parameter or a template id in
 * backticks fails here BY DESIGN, because the next reader cannot tell it
 * from a tool either. */
const phantoms = [];
for (const [section, text] of Object.entries(GUIDE_SECTIONS)) {
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (!live.has(m[1])) phantoms.push(`${section}: \`${m[1]}\``);
  }
}
ok("every backticked name in every section is a live tool", phantoms.length === 0,
  phantoms.join(", "));

/* And the same over the module SOURCE, which catches a backticked name in
 * the tool's own description (not a section) going stale too. */
const guideSrc = readFileSync(path.join(HERE, "mcp-guide.js"), "utf8");
const srcPhantoms = [...guideSrc.matchAll(/\\?`([a-z][a-z0-9_]+)\\?`/g)]
  .map((m) => m[1]).filter((n) => n.includes("_") && !live.has(n));
ok("no stale tool name anywhere in mcp-guide.js", srcPhantoms.length === 0,
  [...new Set(srcPhantoms)].join(", "));

console.log("\n  -- the map holds its shape --");

const full = await guide.run({});
ok("the full guide names all five stages",
  ["1 SONG", "2 PLAN", "3 ASSETS", "4 POLISH", "5 ASSEMBLE"].every((s) => full.guide.includes(s)));
ok("the full guide is a useful minimum, not an essay (under 14 KB)",
  /* Raised from 14k to 15k on 2026-08-28, and the reason is worth writing down
   * because moving a limit to fit your own text is usually how limits die.
   *
   * The guide grew a section that is not a map: `pitfalls`, ~2.3k of mistakes
   * this pipeline has actually made — coverage at parity with the runtime, cuts
   * on lyrics instead of bars, a reference used to compose instead of continue,
   * a clip judged from a still. That content is the difference between an agent
   * repeating a week of them and not, so it earns its bytes. The cap still
   * exists, and the topic is separately addressable for anyone who wants only
   * the map. */
  full.guide.length < 15_000, `${full.guide.length} chars`);
ok("the worked example is 12-20 steps",
  (() => { const n = [...GUIDE_SECTIONS.example.matchAll(/^\s*(\d+)\./gm)].length; return n >= 12 && n <= 20; })(),
  `${[...GUIDE_SECTIONS.example.matchAll(/^\s*(\d+)\./gm)].length} steps`);
ok("the guide never recommends H3 (licence: no EU/UK/KR grant)",
  !/prefer h3|use h3|switch to h3|recommend.*h3/i.test(full.guide));

for (const topic of ["stages", "series", "engines", "example", "pitfalls"]) {
  const r = await guide.run({ topic });
  ok(`topic "${topic}" answers alone`, r.topic === topic && r.guide.length > 400);
}
const bad = await guide.run({ topic: "bogus" }).then(() => null, (e) => e.message);
ok("a bad topic is refused naming the real ones", !!bad && bad.includes("stages"), String(bad));

console.log(failures.length
  ? `\n  ${pass} ok, ${failures.length} FAILED\n`
  : `\n  all ${pass} ok\n`);
process.exit(failures.length ? 1 : 0);
