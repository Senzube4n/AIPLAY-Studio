/**
 * WHICH BUILD IS THIS, AND WHOSE.
 *
 * Studio is developed in one place and forked in others, and the forks keep
 * merging the original back in. So "what version am I on" has two halves, and
 * both are answered here:
 *
 *   THE BUILD      `B 26.09.20 · f9737e5` — the date of the commit this build
 *                  was made from, a letter for the lineage, and the commit.
 *   THE BASE       `on S 26.09.20 · 88b607e` — the ORIGINAL's commit that this
 *                  build contains. On the original itself there is no base line
 *                  because it is the base.
 *
 * ⚠ THE PROTOCOL NUMBER IS NOT THE VERSION, and keeping them apart is the whole
 * point of this file. Collab compares `protocol`, an integer that moves only
 * when the file format or its rules change (server/collab/packet.js PACKET_V).
 * A restyled screen changes the build line and must not make two friends think
 * they can no longer work together, which is exactly what one number doing both
 * jobs would do.
 *
 * WHERE THE FACTS COME FROM, in order:
 *   1. git, when the install is a clone (a developer's machine).
 *   2. server/version.gen.json, written into the zip by scripts/package.mjs, so
 *      a portable or Desktop install with no .git says the same thing.
 *   3. neither: the build says so rather than inventing a number.
 *
 * The lineage lives in package.json under `aiplay.lineage` — a letter, a name,
 * the fork's repository, and the upstream commit it was last merged from
 * (stamped by scripts/stamp-lineage.mjs). The ORIGINAL repository carries no
 * such block, which is how a build knows it is the original. See VERSIONING.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKET_V } from "./collab/packet.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEN = path.join(ROOT, "server", "version.gen.json");
/* Filled in by `git archive` (a GitHub "Download ZIP") through export-subst in
 * .gitattributes. In a clone it still holds the literal placeholders. */
const ARCHIVE = path.join(ROOT, "server", "version.archive.json");

function fromArchive() {
  const a = readJson(ARCHIVE);
  if (!a || typeof a.commit !== "string" || !a.commit || a.commit.includes("$Format")) return null;
  return { commit: a.commit.slice(0, 7), date: String(a.date || ""), modified: false, source: "archive" };
}

/** `2026-09-20T12:40:11+02:00` -> `26.09.20`. The day is the version. */
export function stamp(iso) {
  const m = /^(\d{2})(\d{2})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[2]}.${m[3]}.${m[4]}` : "";
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** The fork's own block, or null on the original. */
export function lineage(pkg = readJson(path.join(ROOT, "package.json"))) {
  const l = pkg?.aiplay?.lineage;
  if (!l || typeof l !== "object") return null;
  return {
    letter: String(l.letter || "?").slice(0, 2),
    name: String(l.name || "fork").slice(0, 40),
    repo: String(l.repo || ""),
    upstream: {
      repo: String(l.upstream?.repo || ""),
      commit: String(l.upstream?.commit || ""),
      date: String(l.upstream?.date || ""),
    },
  };
}

/** git, on a machine that has the clone and the command. Never throws. */
function fromGit() {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (!existsSync(path.join(ROOT, ".git"))) return null;
    const commit = git("rev-parse", "--short=7", "HEAD");
    const date = git("show", "-s", "--format=%cI", "HEAD");
    /* Anything not committed means this build is not any commit, and a bug
     * report that names a clean commit would be a lie. */
    const modified = git("status", "--porcelain").length > 0;
    return { commit, date, modified, source: "git" };
  } catch { return null; }
}

/**
 * The original's commit this build contains.
 *
 * On a developer's machine with the `upstream` remote it is computed, which is
 * always right. Everywhere else it is what `scripts/stamp-lineage.mjs` wrote
 * into package.json at merge time. When both exist and differ, the stamp is
 * stale and the build says so instead of quietly showing an old base.
 */
function upstreamBase(line) {
  const recorded = line?.upstream?.commit ? { commit: line.upstream.commit.slice(0, 7), date: line.upstream.date || "", source: "stamped" } : null;
  try {
    const found = execFileSync("git", ["merge-base", "HEAD", "upstream/main"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const date = execFileSync("git", ["show", "-s", "--format=%cI", found], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const live = { commit: found.slice(0, 7), date, source: "git" };
    if (recorded && recorded.commit !== live.commit) return { ...live, staleStamp: recorded.commit };
    return live;
  } catch { return recorded; }
}

let cached = null;

/** Everything about this build, computed once per run. */
export function appVersion({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const line = lineage();
  const git = fromGit();
  const gen = git ? null : readJson(GEN);
  const build = git || (gen && { commit: gen.commit, date: gen.date, modified: !!gen.modified, source: "packaged" })
    || fromArchive() || { commit: "", date: "", modified: false, source: "unknown" };
  const base = git ? upstreamBase(line) : (gen?.base || (line?.upstream?.commit ? { commit: line.upstream.commit.slice(0, 7), date: line.upstream.date, source: "stamped" } : null));
  const letter = line?.letter || "S";
  const day = stamp(build.date);
  const baseDay = stamp(base?.date);
  /* On the original, and on a fork sitting exactly on an original commit, the
   * base IS the build: say it once rather than printing the same line twice. */
  const same = !!base && !!build.commit && base.commit === build.commit;
  cached = {
    letter,
    name: line?.name || "AI PLAY",
    line: `${letter} ${day || "unknown"}`,
    commit: build.commit,
    date: build.date,
    modified: build.modified,
    source: build.source,
    fork: !!line,
    repo: line?.repo || "Senzube4n/AIPLAY-Studio",
    upstreamRepo: line?.upstream?.repo || "Senzube4n/AIPLAY-Studio",
    base: line && base && !same ? { line: `S ${baseDay || "unknown"}`, commit: base.commit, date: base.date, source: base.source, staleStamp: base.staleStamp || null } : null,
    sameAsUpstream: same,
    /* What Collab actually compares. See the ⚠ at the top of this file. */
    protocol: PACKET_V,
  };
  return cached;
}

/** One string for a log line, a bug report or a window title. */
export function versionLine(v = appVersion()) {
  const bits = [v.line];
  if (v.commit) bits.push(v.commit);
  if (v.modified) bits.push("modified");
  if (v.base) bits.push(`on ${v.base.line} ${v.base.commit}`);
  else if (v.fork && v.sameAsUpstream) bits.push("same commit as upstream");
  return bits.join(" · ");
}

/** What scripts/package.mjs writes into the zip, so a build with no git still knows. */
export function stampForPackage() {
  const v = appVersion({ fresh: true });
  return { commit: v.commit, date: v.date, modified: v.modified, base: v.base ? { commit: v.base.commit, date: v.base.date } : null, at: new Date().toISOString() };
}
