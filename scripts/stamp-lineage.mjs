/**
 * Write down which upstream commit this fork currently contains.
 *
 * Run it after merging upstream:  node scripts/stamp-lineage.mjs
 *
 * A developer's clone can work this out for itself (`git merge-base HEAD
 * upstream/main`), but a zip, a Desktop install or a plain clone of the fork
 * has no `upstream` remote and no way to know. So the answer is written into
 * package.json, where every copy carries it, and server/version.js prefers the
 * live calculation when there is one — and says "stale stamp" when the two
 * disagree, which is what a forgotten run of this script looks like.
 *
 * On the ORIGINAL repository there is no `aiplay.lineage` block and this script
 * says so and stops. See VERSIONING.md.
 *
 * THE BLOCK THAT KEEPS LEAVING. The original deletes the block whenever it
 * merges a fork (it must: the original carries none), and the fork's next merge
 * back brings that deletion with it. So a fork is named below, and a clone whose
 * `origin` is that fork gets its block back before stamping. On the original's
 * clone `origin` matches no fork and nothing changes. A new fork adds a line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "package.json");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

const FORKS = [
  { letter: "B", name: "Bucky", repo: "bani4kaskashka/AIPLAY-Studio-Bucky-Fork", upstream: "Senzube4n/AIPLAY-Studio" },
];

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
if (!pkg?.aiplay?.lineage) {
  let origin = "";
  try { origin = git("remote", "get-url", "origin").toLowerCase(); } catch { /* no origin: a zip or a bare clone */ }
  const fork = FORKS.find((f) => origin.includes(f.repo.toLowerCase()));
  if (fork) {
    pkg.aiplay = { ...(pkg.aiplay || {}), lineage: { letter: fork.letter, name: fork.name, repo: fork.repo, upstream: { repo: fork.upstream, commit: "", date: "" } } };
    console.log(`The lineage block was missing (a merge from the original removes it); restored ${fork.letter} for ${fork.repo}.`);
  }
}
const line = pkg?.aiplay?.lineage;
if (!line) {
  console.log("No aiplay.lineage in package.json — this is the original, not a fork. Nothing to stamp.");
  process.exit(0);
}

let base;
try {
  base = git("merge-base", "HEAD", "upstream/main");
} catch {
  console.error("No `upstream` remote, or no upstream/main fetched.\n"
    + `  git remote add upstream https://github.com/${line.upstream?.repo || "Senzube4n/AIPLAY-Studio"}.git\n`
    + "  git fetch upstream");
  process.exit(1);
}
const date = git("show", "-s", "--format=%cI", base);
const was = line.upstream?.commit || "";
line.upstream = { repo: line.upstream?.repo || "Senzube4n/AIPLAY-Studio", commit: base, date };
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(was === base
  ? `Already stamped: ${line.letter} contains upstream ${base.slice(0, 7)} (${date.slice(0, 10)}).`
  : `Stamped: ${line.letter} now contains upstream ${base.slice(0, 7)} (${date.slice(0, 10)})${was ? `, was ${was.slice(0, 7)}` : ""}.`);
