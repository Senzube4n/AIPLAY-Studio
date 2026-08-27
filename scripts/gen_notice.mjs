#!/usr/bin/env node
/**
 * Regenerate the NOTICE file's model list from the catalogue.
 *
 * WHY THIS SCRIPT EXISTS. That section is the one place a licence travels with
 * a FORK — somebody who clones this repo and never opens the app reads NOTICE
 * and nothing else. It was typed by hand, and by 2026-08-26 it had gone stale
 * in exactly the worst direction: it listed six models and omitted five,
 * including **Ideogram 4 — the single entry whose output terms nobody has been
 * able to read**, plus BiRefNet, RIFE, Real-ESRGAN and the DAV encoder. A
 * hand-kept list of licences is a list that is wrong the first time a model is
 * added, and a licence file that is wrong is worse than no licence file,
 * because it is believed.
 *
 * So the list is DERIVED, the way the Thanks page and the Models screen already
 * derive theirs: one catalogue, three surfaces, no fourth copy to forget.
 *
 *   node scripts/gen_notice.mjs           rewrite NOTICE in place
 *   node scripts/gen_notice.mjs --check   fail if NOTICE has drifted (pre-commit)
 *
 * Only the model-weights section is touched. Everything a human wrote —
 * the vendor attribution, the runtime dependencies — is left exactly alone.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, OUTPUT_RIGHTS_CLASSES } from "../server/models.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTICE = path.join(HERE, "..", "NOTICE");

const RULE = "─".repeat(80);
const HEADING = "MODEL WEIGHTS ARE NOT PART OF THIS SOFTWARE";

const INTRO = `AIPLAY Studio ships no model weights and redistributes none. Each capability
declares its files in server/models.js and downloads them from the publisher, at
the user's request, on their own machine. Those weights carry their own licences,
which are shown in the app before anything is downloaded and are between the user
and the publisher.

This list is GENERATED from that catalogue by scripts/gen_notice.mjs — a
hand-kept second copy is a copy that goes stale, and it did. Re-run it after
adding a capability; the pre-commit hook checks it has been run.

"Output rights" answers one question: may the person who generated something
sell it? Four answers only — yours (nothing in the licence touches the output),
yours with conditions (the licence says so and attaches terms), not for sale
(the ban reaches the generated material itself), and unverified (nobody has read
the operative text — stated as ignorance, never dressed up as either verdict).
The operative sentence itself is quoted verbatim in server/models.js and shown
in the app.`;

/** "Cover art — FLUX.2 klein 4B" → "FLUX.2 klein 4B". The label's first half is
 *  the capability, which the app needs and a licence notice does not. */
const modelName = (label) => {
  const parts = String(label).split(" — ");
  return (parts.length > 1 ? parts.slice(1).join(" — ") : parts[0]).trim();
};

/** The licence NAME, without the paragraph of reasoning some entries carry. */
const licenceName = (licence) => String(licence || "see publisher").split(" — ")[0].trim();

const RIGHTS_WORD = {
  "unrestricted": "yours",
  "yours-with-conditions": "yours, with conditions",
  "not-for-sale": "NOT FOR SALE — the ban reaches the output",
  "unknown": "UNVERIFIED — the licence text has not been read",
};

const NAME_COL = 24;
const wrap = (text, width, indent) => {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && (line + " " + word).length > width) { out.push(line); line = ""; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
};

function body() {
  const lines = [INTRO, ""];
  for (const cap of CATALOG) {
    const name = modelName(cap.label);
    const pad = name.length >= NAME_COL ? `\n    ${" ".repeat(NAME_COL)}` : " ".repeat(NAME_COL - name.length);
    lines.push(`    ${name}${pad}${licenceName(cap.licence)}`);
    const ind = `    ${" ".repeat(NAME_COL)}`;
    const or = cap.outputRights;
    if (or) {
      const word = RIGHTS_WORD[or.class] || RIGHTS_WORD.unknown;
      lines.push(`${ind}${wrap(`Output rights: ${word}${or.clause ? ` (${or.clause})` : ""}`, 76 - NAME_COL, ind)}`);
      if (or.url) lines.push(`${ind}${or.url}`);
    }
    if (cap.region) {
      lines.push(`${ind}${wrap(`⚠ Grants rights only inside its Applicable Territory, which EXCLUDES ${cap.region.excluded.join(", ")}.`, 76 - NAME_COL, ind)}`);
    }
    if (cap.gated) {
      lines.push(`${ind}${wrap("⚠ Access-gated: the publisher requires you to accept the licence and authenticate before downloading.", 76 - NAME_COL, ind)}`);
    }
    lines.push("");
  }
  /* A class list nobody can look up is decoration. Naming the four here means a
   * fork that reads only this file still knows what the words mean. */
  lines.push("The four output-rights classes, as the app words them:");
  lines.push("");
  for (const [id, v] of Object.entries(OUTPUT_RIGHTS_CLASSES)) {
    /* Padding is applied OUTSIDE wrap(): wrap splits on whitespace, so a
     * pre-padded string comes back with its columns collapsed. */
    const ind = " ".repeat(4 + NAME_COL);
    lines.push(`    ${id.padEnd(NAME_COL)}${wrap(v.line, 76 - NAME_COL, ind)}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd().split("\n");
}

/**
 * ⚠ LINE ENDINGS ARE PART OF THE COMPARISON.
 *
 * `core.autocrlf` is true on Windows, so a fresh clone hands this script a CRLF
 * NOTICE. Writing LF lines into a CRLF file makes `--check` report drift on a
 * checkout nobody has touched — and a gate that fails on a clean tree is a gate
 * people delete. The generated block adopts whatever the file already uses.
 */
function rebuild(current) {
  const EOL = /\r\n/.test(current) ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === HEADING);
  if (at < 0) throw new Error(`NOTICE has no "${HEADING}" section — refusing to guess where it went.`);
  const start = at + 2;                       // heading, then its underline rule
  if (!lines[at + 1]?.startsWith("─")) throw new Error("NOTICE section heading is not followed by its rule.");
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith("─")) { end = i; break; }   // the next section's rule
  }
  return [...lines.slice(0, start), ...body(), ...lines.slice(end)].join(EOL);
}

const current = readFileSync(NOTICE, "utf8");
const next = rebuild(current);
const check = process.argv.includes("--check");

if (current === next) {
  console.log("NOTICE model list matches the catalogue");
} else if (check) {
  console.log("NOTICE has DRIFTED from server/models.js — run: node scripts/gen_notice.mjs");
  /* Show the first difference rather than the whole file: a hook that prints
   * 80 lines of diff gets scrolled past. */
  const a = current.split(/\r?\n/), b = next.split(/\r?\n/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log(`  first difference at line ${i + 1}:`);
      console.log(`    NOTICE:    ${JSON.stringify(a[i] ?? null)}`);
      console.log(`    catalogue: ${JSON.stringify(b[i] ?? null)}`);
      break;
    }
  }
  process.exit(1);
} else {
  writeFileSync(NOTICE, next, "utf8");
  console.log(`NOTICE regenerated from the catalogue (${CATALOG.length} capabilities)`);
}
