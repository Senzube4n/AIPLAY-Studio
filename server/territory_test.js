// The territory gate. On 2026-09-02 four files hand-typed H3's excluded
// territories as THREE while the catalogue said FOUR: a comparison arm, two
// engine-switch descriptions and a video-lab tool, each written by a different
// hand on the same day. The Models page, welcome window and docs derive the
// list from CATALOG; this test fails the build when any other file types it.
//
// Rule: outside server/models.js, no source or doc may contain a hand-typed
// H3 territory list. Allowed: comment lines; lines carrying "retired" /
// "hand-typed" (history notes about the old wording); and the generated
// MODELS:BEGIN … MODELS:END blocks that scripts/models_table.mjs renders from
// CATALOG — derived output is the opposite of hand-typing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./models.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["server", "web", "docs", "scripts", "examples", "README.md", "INSTALL.md", "DIRECTING.md"];
const SKIP = /node_modules|[\\/]\.git[\\/]|_test\.js$|\.(png|jpg|jpeg|mp4|flac|wav|json|css|svg|ico)$/;

// Every phrasing seen in the wild, plus any line naming three or more of the
// four territories without going through CATALOG.
const NAMES = ["EU", "European Union", "UK", "United Kingdom", "South Korea", "Republic of Korea", "USA", "United States"];
const HAND = [
  /EU,\s*the\s+UK\s+or\s+South\s+Korea/i,
  /EU,\s*the\s+UK,\s*South\s+Korea/i,
  /European Union,\s*(the\s+)?United Kingdom,\s*(the\s+)?Republic of Korea/i,
];

let checks = 0, fails = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log("  FAIL", msg); } };

const rows = CATALOG.filter((c) => Array.isArray(c.region?.excluded) && c.region.excluded.length);
ok(rows.length >= 1, "catalogue has a territory-limited row");
ok(new Set(rows.map((r) => r.region.excluded.join("|"))).size === 1, "all territory-limited rows agree");
ok(rows[0].region.excluded.length === 4, `catalogue lists four territories (got ${rows[0].region.excluded.length})`);

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) yield* walk(path.join(p, e)); }
  else yield p;
}

const MODELS = path.resolve(ROOT, "server", "models.js");
for (const top of SCAN) {
  const p = path.join(ROOT, top);
  if (!fs.existsSync(p)) continue;
  for (const f of walk(p)) {
    if (SKIP.test(f) || path.resolve(f) === MODELS) continue;
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    let generated = false;
    text.split("\n").forEach((line, i) => {
      if (/MODELS:BEGIN/.test(line)) generated = true;
      if (/MODELS:END/.test(line)) generated = false;
      if (generated) return;
      if (/^\s*(\*|\/\/|#|<!--)/.test(line) || /retired|hand-typed|used to say/i.test(line)) return;
      const hit = HAND.some((re) => re.test(line));
      const count = NAMES.filter((n) => line.includes(n)).length;
      if (hit || count >= 3) {
        ok(false, `${path.relative(ROOT, f)}:${i + 1} hand-types the territory list; derive it from CATALOG: ${line.trim().slice(0, 110)}`);
      }
    });
  }
}
ok(true, "scan complete");
console.log(`  ${checks - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
