/**
 * THE TWO NUMBERS, AND THE LINE BETWEEN THEM.
 *
 * The defect this exists to stop is one number doing both jobs: a build line
 * that a restyled screen moves being used to decide whether a friend's file
 * opens. So the gates here are mostly about SEPARATION — the protocol comes
 * from the packet module, the update check is never consulted by Collab, and
 * the page that shows one shows the other.
 *
 * No network: `checkUpdates` is exercised against a fake `fetch`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { appVersion, versionLine, stamp, lineage } from "./version.js";
import { PACKET_V } from "./collab/packet.js";
import { checkUpdates, updateSentence } from "./updates.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the build line: a lineage letter, the commit's day, and the commit", () => {
  assert.equal(stamp("2026-09-20T19:15:55+02:00"), "26.09.20");
  assert.equal(stamp(""), "");
  const v = appVersion();
  assert.match(v.line, /^[A-Z?]{1,2} (\d{2}\.\d{2}\.\d{2}|unknown)$/, v.line);
  assert.equal(typeof v.modified, "boolean");
  assert.ok(["git", "packaged", "archive", "unknown"].includes(v.source));
  assert.match(versionLine(), new RegExp(`^${v.line}`));
});

test("a fork names the original it came from; the original carries no lineage block", () => {
  const l = lineage();
  const pkg = JSON.parse(src("../package.json"));
  /* ⚠ THE SAME CODE RUNS ON BOTH SIDES, so the lane checks the RULE and not one
   * side's answer. An earlier version asserted `letter: "B"` and reached into
   * pkg.aiplay.lineage.upstream.commit unconditionally — true on the fork it was
   * written in, and on the original a failure plus a read of undefined, in a
   * lane that gates every commit. Which side you are on is the variable; that a
   * fork names its upstream and the original carries no block is the rule. */
  if (l) {
    assert.match(l.letter, /^[A-Z]$/, "a fork has a one-letter lineage");
    assert.notEqual(l.letter, "S", "S is the original's letter and a fork may not take it");
    assert.match(l.upstream.repo, /^[^/]+\/[^/]+$/, "and it names the repository it forked");
    assert.match(pkg.aiplay.lineage.upstream.commit, /^[0-9a-f]{7,40}$/, "stamped by scripts/stamp-lineage.mjs");
  } else {
    assert.equal(pkg.aiplay?.lineage, undefined, "the original carries no lineage block — that absence IS how it knows");
    assert.equal(appVersion().letter, "S", "and it calls itself S");
    assert.equal(appVersion().fork, false);
  }
  /* A build sitting exactly on an upstream commit says so once rather than
   * printing the same commit twice. */
  const v = appVersion();
  /* Only a fork contains an upstream commit to report; the original IS the line. */
  if (l) assert.ok(v.base || v.sameAsUpstream, "either a base line or 'the same commit'");
  else assert.equal(v.base, null, "the original has no base beneath it");
  assert.equal(lineage({ aiplay: {} }), null, "no block means the original");
});

test("a checkout of the ORIGINAL repository never carries a fork's lineage", () => {
  /* ⚠ THE LANE ABOVE CANNOT SEE THIS, AND IT HAPPENED.
   *
   * It picks its side from the lineage block itself: a block means "I am a
   * fork", no block means "I am the original". So when merging Bucky's fork
   * into the original carried his `aiplay.lineage` over — letter B, name
   * Bucky, repo bani4kaskashka/AIPLAY-Studio-Bucky-Fork — the lane concluded
   * "fork", checked the fork's rules, and passed. The original then called
   * itself Bucky on /api/version and the About screen, and worse, selfupdate.js
   * reads its update source from that block, so a zip install of the ORIGINAL
   * would have updated itself from the fork.
   *
   * Which side a checkout is on has to come from somewhere the merge cannot
   * rewrite: the repository the checkout was cloned from. The fork's clone has
   * its own origin and keeps its block; the original's clone has the original
   * as origin and must not have one. A tree with no git (a zip) is not judged
   * here — the gate always runs in a clone. */
  let origin = null;
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { /* no git, or no origin: nothing to judge from */ }
  if (!origin) return;
  const slug = origin.replace(/\.git$/i, "").replace(/^.*github\.com[/:]/i, "").toLowerCase();
  if (slug !== "senzube4n/aiplay-studio") return;           // a fork's clone keeps its block
  const pkg = JSON.parse(src("../package.json"));
  assert.equal(pkg.aiplay?.lineage, undefined,
    `this is a clone of the original (${origin}) and package.json carries a fork's lineage `
    + `(${JSON.stringify(pkg.aiplay?.lineage?.name)} / ${pkg.aiplay?.lineage?.repo}). A merge from `
    + "a fork brought it over. Delete the `aiplay` block: the original's identity is its absence, "
    + "and selfupdate.js would otherwise update this build from the fork.");
  assert.equal(appVersion().letter, "S", "and the original calls itself S");
  assert.equal(appVersion().fork, false, "and not a fork");
});

test("the protocol is the packet's, not the build's, and only Collab compares it", () => {
  assert.equal(appVersion().protocol, PACKET_V);
  const packet = src("./collab/packet.js");
  assert.match(packet, /export const PACKET_V = \d+;/);
  assert.match(packet, /v: PACKET_V,\n\s+kind: "shot"/, "the packets carry it rather than a literal");
  /* THE SEPARATION, in one line: nothing in Collab may ask the update checker
   * or the build line whether two people can work together. */
  for (const f of ["./collab/packet.js", "./collab/seal.js", "./collab/roster.js", "./collab/order.js", "./collab/identity.js"]) {
    assert.doesNotMatch(src(f), /^import[^\n]*(updates|version)\.js"/m, `${f} decides compatibility from the packet alone`);
  }
});

test("the update check asks GitHub about the base this build contains, and never fails a screen", async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const body = String(url).includes("/compare/")
      ? { ahead_by: 3, behind_by: 0, commits: [{ commit: { message: "one\n\nbody" } }, { commit: { message: "two" } }, { commit: { message: "three" } }] }
      : { sha: "abcdef1234", commit: { message: "newest thing\nmore", committer: { date: "2026-09-20T18:30:31Z" } } };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const r = await checkUpdates({ force: true });
    assert.ok(seen.some((u) => u.includes("/repos/Senzube4n/AIPLAY-Studio/commits/main")));
    assert.ok(seen.some((u) => /\/compare\/[0-9a-f]{7,}\.\.\.main/.test(u)), "compared against the commit this build contains");
    assert.equal(r.upstream.ahead, 3);
    assert.match(updateSentence(r), /3 commits on the original you do not have/);
    /* Judged without the fork line: on a fork's checkout the fake GitHub answers
     * the fork's own head too, and "Your own repository has ..." follows. */
    assert.match(updateSentence({ ...r, fork: null }), /3 commits on the original you do not have[^]*\. Stop Studio, then press Update at the bottom of the launcher window\.$/,
      "behind, the sentence says what to press, where");
    // One if/else chain: only the behind case gets the launcher step, and the
    // "not a commit GitHub knows" line is for a base GitHub could not compare.
    assert.equal(updateSentence({ ok: true, upstream: { head: "abc1234", ahead: 0 } }, { fork: false }), "Up to date.",
      "up to date says only that");
    assert.equal(updateSentence({ ok: true, upstream: { head: "abc1234", ahead: 0 } }, { fork: true }), "Up to date with the original.");
    assert.equal(updateSentence({ ok: true, upstream: { head: "abc1234", ahead: null } }, { fork: false }),
      "The original is at abc1234; this build's base is not a commit GitHub knows.",
      "an unknown base names the original's head and no Update step");
    assert.equal(updateSentence({ ok: true, upstream: { head: "abc1234", ahead: 1, newest: "fix" } }, { fork: false }),
      "1 commit on the original you do not have, newest: fix. Stop Studio, then press Update at the bottom of the launcher window.");
    assert.deepEqual(r.upstream.titles, ["three", "two", "one"], "newest first, one line each");
    const cached = await checkUpdates();
    assert.equal(cached.cached, true, "an hour's cache, so opening a screen costs nothing");
    /* A refusal is a sentence, not an exception. */
    globalThis.fetch = async () => { throw new Error("offline"); };
    const bad = await checkUpdates({ force: true });
    assert.equal(bad.ok, false);
    assert.match(updateSentence(bad), /offline/);
  } finally { globalThis.fetch = real; }
});

test("both numbers reach the screens, and the check is a press", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), index = src("./index.js"), lau = src("../launcher/index.html");
  assert.match(index, /if \(p === "\/api\/version"\) \{/);
  assert.match(index, /if \(b\.action !== "check"\) return json\(res, 400/, "GET touches no network; the check is a POST");
  assert.match(app, /Collab protocol \$\{v\.protocol\}/, "the page that shows the build shows the protocol");
  assert.match(html, /id="verCheck"/); assert.match(html, /id="homeVer"/);
  assert.match(lau, /id="verCheck"/, "the launcher has the same button");
  assert.match(src("../launcher/launcher.mjs"), /url\.pathname === "\/api\/version"/);
  assert.match(src("../scripts/package.mjs"), /version\.gen\.json/, "a zip carries what git would have said");
  const doc = src("../VERSIONING.md");
  assert.match(doc, /\| Protocol \| Shipped \| An older client sees \|/, "a table to fill in when the protocol moves");
  assert.match(doc, /no such block/i, "how a build knows it is the original");
});

test("Collab: the protocol decides, the build is a caption", async () => {
  const { speaks, stamp, describeStamp, friendNote } = await import("./collab/compat.js");
  /* The decision reads the packet's own number and nothing else. */
  assert.equal(speaks(PACKET_V).ok, true);
  assert.equal(speaks(PACKET_V + 1).ok, false, "a packet from the future is refused, not half-read");
  assert.match(speaks(PACKET_V + 1).why, new RegExp(`speaks Collab ${PACKET_V + 1} and this one speaks ${PACKET_V}`), "both numbers, in one sentence");
  assert.equal(speaks(PACKET_V - 1).ok, true, "older opens");
  assert.match(speaks(PACKET_V - 1).why, /older Studio/);
  assert.equal(speaks(undefined).ok, false);
  assert.equal(speaks("x").reason, "no-protocol");
  /* The caption names the build and never comes back as a decision. */
  const s = stamp();
  assert.deepEqual(Object.keys(s).sort(), ["app", "commit", "protocol"], "a caption, not a machine report");
  assert.match(describeStamp(s), /collab \d+$/);
  assert.equal(friendNote({ app: "S 26.09.18", protocol: PACKET_V }).level, "ok");
  assert.equal(friendNote({ app: "S 26.09.18", protocol: PACKET_V + 1 }).level, "warn");
  assert.match(friendNote({ app: "S 26.09.18", protocol: PACKET_V + 1 }).text, /update to open what they send/);

  const index = src("./index.js"), app = src("../web/app.js");
  assert.match(index, /collabPreviews\.create\(\{ payload: \{ \.\.\.payload, by: collabStamp\(\) \}/, "the review snapshot freezes its sender build stamp");
  assert.match(index, /JSON\.stringify\(\{ \.\.\.payload, by: payload\.by \|\| collabStamp\(\) \}\)/, "packing preserves the reviewed stamp and stamps direct packets before sealing");
  assert.match(index, /const talk = speaks\(packet\?\.v\);\n\s+if \(!talk\.ok\) return json\(res, 409/, "refused before it is described or acted on");
  assert.match(index, /collabRoster\.setBuild\(\{ appData, fp: sender\.fp, by: packet\.by \}\)/);
  assert.match(src("./collab/roster.js"), /export async function setBuild/);
  assert.match(app, /function cbBuildLine\(b\)/, "a friend's row says which Studio is on the other end");
  assert.match(app, /state\.collabProtocol = v\.protocol;/);
  assert.match(app, /fresh\.classList\.add\("justadded"\);/, "adding a friend is visible");
  /* ⚠ CLAUDE.md IS NOT IN THIS REPOSITORY. It is a local agent-instructions
   * file, untracked here and untracked in the fork this lane arrived from, so
   * reading it unconditionally passes on exactly one machine and throws ENOENT
   * on every other — and this lane gates every commit, so that ENOENT blocks
   * even the commit that would fix it. Pinned where it exists; announced where
   * it does not. A gate a clean checkout cannot satisfy is a gate that gets
   * bypassed. */
  const rulebook = new URL("../CLAUDE.md", import.meta.url);
  if (existsSync(rulebook)) {
    assert.match(readFileSync(rulebook, "utf8"), /node scripts\/stamp-lineage\.mjs/,
      "the rule that a pull is not finished until it has run");
  } else {
    console.log("  (no CLAUDE.md in this checkout — the stamp-lineage rule is unpinned here)");
  }
});

test("a GitHub Download ZIP names its own commit: export-subst fills the placeholders", () => {
  assert.match(src("../.gitattributes"), /^server\/version\.archive\.json export-subst$/m);
  const a = JSON.parse(src("./version.archive.json"));
  assert.equal(a.commit, "$Format:%h$", "a clone keeps the placeholder; git archive replaces it");
  assert.equal(a.date, "$Format:%cI$");
  assert.match(src("./version.js"), /\|\| fromArchive\(\) \|\|/, "after git and the packaged stamp, before unknown");
});
