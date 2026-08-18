/**
 * Repair library chronology after a re-tagging pass restamped files.
 *
 * WHAT WENT WRONG. library.js falls back to the file's mtime for any track whose
 * sidecar has no `createdAt`. Tagging rewrites the file, so the cover-embedding
 * backfill gave every such track a "just now" mtime and collapsed months of
 * library history into one minute. (tag_audio.py now restores the original
 * mtime, so this cannot happen again — this only cleans up what already did.)
 *
 * WHAT CAN AND CANNOT BE RECOVERED. The exact original times are gone; nothing
 * on disk still holds them. What IS recoverable is the ORDER, from the sequential
 * filenames the engine assigns — and order is what the library actually sorts
 * and groups by, so restoring it restores the thing you can see.
 *
 * Affected tracks are written into the sidecar with an explicit `createdAt`, so
 * they stop depending on mtime at all.
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { config } from "../server/config.js";

const SIDECAR = path.join(homedir(), ".aiplay-studio", "library.json");
const DRY = !process.argv.includes("--apply");

// The sidecar is { meta: {...}, playlists: [...] } — the per-track map is nested
// under `meta`, and reading the top level as the map silently found nothing.
const side = JSON.parse(await readFile(SIDECAR, "utf-8").catch(() => "{}"));
const meta = side.meta || (side.meta = {});

const rows = await (await fetch("http://127.0.0.1:4173/api/status")).json()
  .then((d) => d.library);

// "Damaged" = no sidecar createdAt, so the row is showing an mtime the backfill
// wrote. Everything with a real createdAt is untouched and stays untouched.
const damaged = rows.filter((t) => !(meta[t.file]?.createdAt));
const intact = rows.filter((t) => meta[t.file]?.createdAt);

if (!damaged.length) { console.log("nothing to repair"); process.exit(0); }

// Place them before the oldest track that still knows when it was made.
const floor = Math.min(...intact.map((t) => meta[t.file].createdAt));
const seq = (f) => { const m = /(\d+)/.exec(f); return m ? +m[1] : 0; };
damaged.sort((a, b) => seq(a.file) - seq(b.file));

const GAP = 60_000;                       // one minute apart, oldest first
const start = floor - damaged.length * GAP;

console.log(`${rows.length} tracks · ${intact.length} intact · ${damaged.length} to repair`);
console.log(`oldest surviving timestamp: ${new Date(floor).toISOString()}\n`);
for (const [i, t] of damaged.entries()) {
  const at = start + i * GAP;
  console.log(`  ${t.file.padEnd(24)} -> ${new Date(at).toISOString()}`);
  if (!DRY) meta[t.file] = { ...(meta[t.file] || {}), createdAt: at };
}
if (DRY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
} else {
  await writeFile(SIDECAR, JSON.stringify(side, null, 2));
  console.log(`\nwrote ${damaged.length} timestamps to ${SIDECAR}`);
  console.log("Order is restored. The exact original times are not recoverable.");
}
