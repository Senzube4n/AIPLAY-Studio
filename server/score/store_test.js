/**
 * THE SCORE STORE — the guard suite. No server, no python, no GPU.
 *
 * What each section is guarding, because a check whose reason is not written
 * down is a check somebody deletes:
 *
 *  · THE CONTRACT IS server/mv/store.js's, NOT A NEW ONE. One JSON document
 *    plus an artifact folder per slug, one promise chain per slug, and
 *    write-temp-then-rename. The single-writer property is proved by racing
 *    twenty writers at one document and requiring all twenty to land, because
 *    the failure it prevents — read-modify-write clobbering — is invisible in a
 *    sequential test and loses an hour of work in production.
 *
 *  · THE VENDOR'S FOLDER IS STORED WHOLE, AND VERIFIED ON THE WAY IN. The
 *    receipt hashes 10 files and carries an identity over request+config+
 *    weights. A folder that disagrees with its own receipt is refused BY NAME,
 *    and the real receipt from a real render (fixtures/yue2_result.json) is used
 *    to prove it rather than a mock of one.
 *
 *  · THE FOUR ADDITIONS ARE EACH A DEFECT REPAIR AND EACH IS PINNED HERE:
 *      parent   the repo's existing `reroll` is a bare boolean
 *               (server/jobs.js:572, server/library.js:378) with no pointer at
 *               what it re-rolled. A pointer, a lineage and a cycle guard.
 *      note     VERBATIM, byte for byte, ear.js:1478-1482's precedent.
 *      by/author  CANNOT BE MERGED, and setAuthor() cannot reach `by`.
 *      changed  COMPUTED from sha256 and NOT STORED — the persisted JSON is
 *               grepped for the key.
 *
 *  · MATCHED BY THE ID THIS STORE RETURNED, NEVER BY DIFFING A FOLDER.
 *    DIRECTING.md:1220-1252. Checked as a property of the SOURCE as well as of
 *    the behaviour, because a second matching path would pass every dynamic test
 *    in this file and still be the bug.
 *
 * Runs standalone (`node server/score/store_test.js`). Writes only into a temp
 * directory, which it removes.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The output dir MUST be decided before config.js is first imported, and static
 * imports hoist — so every import below is dynamic. Same discipline as
 * server/mv/plan_test.js:40-43, for the same reason. */
const OUT = path.join(os.tmpdir(), `score-store-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;
process.env.AIPLAY_APPDATA = path.join(OUT, "appdata");
mkdirSync(OUT, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
/** The store as text, for the two checks that pin a property of the source. */
const SRC = readFileSync(path.join(HERE, "store.js"), "utf8");

const store = await import("./store.js");
const {
  createScore, readScoreDoc, updateScore, deleteScore, listScores,
  adoptVersion, readReceipt, setNote, setAuthor, setCurrent, setSheet,
  findVersion, findByKey, changesBetween, lineage, childrenOf, rootOf,
  lastVersionAt, renderSeconds, versionKey, shortKey, blankScore,
  scoreDir, versionDir, versionsDir, sheetDir, readScoreAbc,
  DOC_VERSION, NOTE_CAP,
} = store;

let pass = 0;
const failures = [];
function ok(what, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ok    ${what}`); return true; }
  failures.push(what);
  console.log(`  FAIL  ${what}${detail ? `\n          ${detail}` : ""}`);
  return false;
}
const eq = (what, a, b) => ok(`${what} = ${JSON.stringify(b)}`, a === b, `got ${JSON.stringify(a)}`);
async function throws(what, fn, re) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  return ok(what, msg !== null && (!re || re.test(msg)), msg === null ? "it did not throw" : msg);
}

/* ── a self-consistent vendor run folder, built rather than mocked ────────── */

const REAL_ABC = readFileSync(path.join(FIX, "yue2_score.abc"), "utf8");
const REAL_RECEIPT = JSON.parse(readFileSync(path.join(FIX, "yue2_result.json"), "utf8"));

let runSeq = 0;
/**
 * Write a folder shaped exactly like the vendor's, with a receipt whose hashes
 * are computed from the files actually written.
 *
 * `files` overrides the contents; `extra` adds a file the receipt will NOT
 * hash (the measured rain_yue2.mp3 case); `corrupt` rewrites a file AFTER the
 * receipt is computed, which is the only honest way to test the verification.
 */
function makeRun({ abc = REAL_ABC, identity = REAL_RECEIPT.identity, extra = null,
                   corrupt = null, dropFromDisk = [], audioSeconds = REAL_RECEIPT.audio_seconds } = {}) {
  const dir = path.join(OUT, `run-${runSeq += 1}`);
  mkdirSync(dir, { recursive: true });
  const contents = {
    "score.abc": Buffer.from(abc, "utf8"),
    "audio.flac": Buffer.from("fLaC-not-really-but-hashed-like-one", "utf8"),
    "request.json": Buffer.from(JSON.stringify({ style: "test", lyrics: "la" }), "utf8"),
    "config.json": Buffer.from(JSON.stringify({ cfg_scale: 1.0 }), "utf8"),
    "latent.npy": Buffer.from([1, 2, 3, 4]),
    "semantic.npy": Buffer.from([5, 6, 7, 8]),
  };
  const artifacts = {};
  for (const [name, buf] of Object.entries(contents)) {
    writeFileSync(path.join(dir, name), buf);
    artifacts[name] = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  }
  writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    status: "complete",
    identity,
    truncated: { abc: false, semantic: false },
    sample_rate: 48000,
    audio_seconds: audioSeconds,
    weights: REAL_RECEIPT.weights,
    timing: REAL_RECEIPT.timing,
    artifacts,
  }, null, 2));
  if (extra) writeFileSync(path.join(dir, extra.name), Buffer.from(extra.body || "x"));
  if (corrupt) writeFileSync(path.join(dir, corrupt.name), Buffer.from(corrupt.body));
  for (const n of dropFromDisk) rmSync(path.join(dir, n), { force: true });
  return dir;
}

/* ════════════════════════════════════════════════════════════════════════
 * 1 · THE CONTRACT: one document, one folder, ONE WRITER.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n1 · the contract server/mv/store.js sets\n");
{
  const doc = await createScore("Ninety Storeys", { author: "Ada" });
  eq("a score is created under a slug", doc.slug, "ninety-storeys");
  eq("...at the document version", doc.v, DOC_VERSION);
  eq("...with the credit set from the body", doc.author, "Ada");
  eq("...and no versions yet", doc.versions.length, 0);
  ok("the document lives at <outputDir>/score/<slug>/score.json",
    existsSync(path.join(scoreDir("ninety-storeys"), "score.json")));
  ok("...beside a versions folder", existsSync(versionsDir("ninety-storeys")));

  /* Two songs called Rain must not become one folder. mv/store.js:260-265. */
  const a = await createScore("Rain");
  const b = await createScore("Rain");
  eq("a colliding title takes a suffix, not the same folder", b.slug, "rain-2");
  ok("...and the first one is untouched", a.slug === "rain");

  /* 🔴 THE SINGLE-WRITER PROPERTY. Twenty read-modify-writes fired at once. A
   * store without the chain loses all but a handful: each reads the same
   * document and the last write wins. This is the check that would have caught
   * "losing an hour of directing to a truncated JSON file". */
  const N = 20;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    updateScore("ninety-storeys", (d) => { (d.runs ||= []).unshift({ at: Date.now(), what: "race", i }); return d; })));
  const raced = await readScoreDoc("ninety-storeys");
  const seen = new Set(raced.runs.filter((r) => r.what === "race").map((r) => r.i));
  eq(`all ${N} concurrent writers land`, seen.size, N);

  /* The chain must not break on a rejection, or every later write for this
   * score is silently dropped. store.js's enqueue() comment. */
  await throws("a writer that throws surfaces its own error",
    () => updateScore("ninety-storeys", () => { throw new Error("deliberate"); }), /deliberate/);
  await updateScore("ninety-storeys", (d) => { d.title = "After The Throw"; return d; });
  eq("...and the next writer still lands", (await readScoreDoc("ninety-storeys")).title, "After The Throw");

  /* `false` abandons the write. mv/store.js:239-256. */
  const before = (await readScoreDoc("rain")).updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  await updateScore("rain", () => false);
  eq("returning false abandons the write", (await readScoreDoc("rain")).updatedAt, before);

  /* write-temp-then-rename, as a property of the source AND of the folder. */
  ok("the writer renames a temp file into place rather than writing in place",
    /\.tmp-\$\{process\.pid\}/.test(SRC) && /await rename\(tmp, docPath\(slug\)\)/.test(SRC));
  ok("...and leaves no temp file behind",
    !readdirSync(scoreDir("ninety-storeys")).some((n) => n.includes(".tmp-")),
    readdirSync(scoreDir("ninety-storeys")).join(", "));

  /* A default-empty migration must not bump DOC_VERSION — mv/store.js:216-219. */
  const old = blankScore("Old");
  delete old.versions; delete old.runs; delete old.current; delete old.author;
  mkdirSync(path.join(OUT, "score", "old"), { recursive: true });
  writeFileSync(path.join(OUT, "score", "old", "score.json"), JSON.stringify(old));
  const migrated = await readScoreDoc("old");
  ok("an older document migrates in memory", Array.isArray(migrated.versions) && Array.isArray(migrated.runs));
  eq("...and its version is NOT bumped", migrated.v, DOC_VERSION);
  eq("...with current defaulting to absent rather than to a guess", migrated.current, null);

  await throws("a missing score is a named error, not a silent create",
    () => updateScore("no-such-song", (d) => d), /No such score: no-such-song/);
  eq("...and reading one is null", await readScoreDoc("no-such-song"), null);
}

/* ════════════════════════════════════════════════════════════════════════
 * 2 · THE RECEIPT, VERIFIED. A folder that disagrees with it is refused.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n2 · the vendor's receipt is checked, not trusted\n");
{
  const good = makeRun();
  const r = await readReceipt(good);
  eq("a self-consistent folder has nothing missing", r.missing.length, 0);
  eq("...nothing mismatched", r.mismatched.length, 0);
  eq("...and nothing unreceipted", r.unreceipted.length, 0);
  eq("...and reports how it was verified", r.verified, "hash");

  /* MEASURED: run_fixed/ holds a hand-made rain_yue2.mp3 the receipt does not
   * hash. Refusing that folder would refuse a real render over a convenience
   * file; dropping the file silently would lose it. */
  const withExtra = makeRun({ extra: { name: "rain_yue2.mp3", body: "ID3" } });
  const re = await readReceipt(withExtra);
  eq("a file the receipt does not hash is NAMED", re.unreceipted.join(","), "rain_yue2.mp3");
  eq("...and is not treated as a mismatch", re.mismatched.length, 0);

  /* Bytes differ. */
  const badBytes = makeRun({ corrupt: { name: "latent.npy", body: [1, 2, 3, 4, 5, 6, 7, 8] } });
  const rb = await readReceipt(badBytes);
  eq("a file whose size disagrees is mismatched", rb.mismatched.length, 1);
  eq("...on the bytes field", rb.mismatched[0].field, "bytes");
  eq("...and named", rb.mismatched[0].name, "latent.npy");

  /* Same length, different content — the case a size check cannot see. */
  const badHash = makeRun({ corrupt: { name: "latent.npy", body: [9, 9, 9, 9] } });
  const rh = await readReceipt(badHash);
  eq("a same-size file with different content is caught by the hash", rh.mismatched.length, 1);
  eq("...on the sha256 field", rh.mismatched[0].field, "sha256");
  const rq = await readReceipt(badHash, { verify: "bytes" });
  eq("...and is NOT caught when only bytes are compared", rq.mismatched.length, 0);
  ok("...so the two modes are genuinely different and the default is the strict one",
    /verify = "hash"/.test(SRC));

  /* A missing artifact. */
  const missing = makeRun({ dropFromDisk: ["audio.flac"] });
  eq("a receipt entry with no file is missing", (await readReceipt(missing)).missing.join(","), "audio.flac");

  /* No receipt, and no identity. */
  const bare = path.join(OUT, "bare-run");
  mkdirSync(bare, { recursive: true });
  writeFileSync(path.join(bare, "score.abc"), REAL_ABC);
  await throws("a folder with no result.json is refused, and the message says what it is for",
    () => readReceipt(bare), /identity hash over request\+config\+weights/);

  const noId = path.join(OUT, "noid-run");
  mkdirSync(noId, { recursive: true });
  writeFileSync(path.join(noId, "result.json"), JSON.stringify({ status: "complete", artifacts: {} }));
  await throws("a receipt with no identity is refused rather than keyed on nothing",
    () => readReceipt(noId), /cannot be keyed/);

  /* 🔴 THE REAL RECEIPT, against a folder holding only the real score.abc.
   * fixtures/README.md explains why the other 9 files are not shipped; this is
   * the case that proves a partial folder cannot be adopted as a render. */
  const partial = path.join(OUT, "partial-run");
  mkdirSync(partial, { recursive: true });
  writeFileSync(path.join(partial, "score.abc"), REAL_ABC);
  writeFileSync(path.join(partial, "result.json"), JSON.stringify(REAL_RECEIPT));
  const rp = await readReceipt(partial);
  eq("the real score.abc matches the real receipt's hash for it", rp.mismatched.length, 0);
  eq("...and the 9 artifacts not shipped are reported missing", rp.missing.length, 9);
  ok("...naming audio.flac among them", rp.missing.includes("audio.flac"), rp.missing.join(", "));
  await throws("...so the folder is refused by name",
    () => adoptVersion("rain", { dir: partial, by: "user" }),
    /does not match its own receipt.*missing:.*audio\.flac/s);
}

/* ════════════════════════════════════════════════════════════════════════
 * 3 · ADOPTING: the id is returned, the folder is never diffed.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n3 · adopt, and the id that is the only handle on a render\n");
let v1, v2;
{
  const dir = makeRun({ extra: { name: "rain_yue2.mp3", body: "ID3-hand-made" } });
  const r = await adoptVersion("rain", { dir, by: "user", note: "keeper", author: "Ada" });
  v1 = r.id;
  ok("adopt returns an id", typeof r.id === "string" && r.id.length > 0, JSON.stringify(r.id));
  eq("...and the folded key", r.key, versionKey("rain", REAL_RECEIPT.identity));
  ok("the vendor's folder is copied whole", existsSync(versionDir("rain", v1)));

  /* THE PROPERTY THAT JUSTIFIES A SEPARATE sheets/ FOLDER: everything inside
   * versions/<id>/ is either hashed by the receipt or named in `unreceipted`.
   * Nothing of ours is written in there, so the folder stays checkable. */
  const onDisk = readdirSync(versionDir("rain", v1)).sort();
  const version = r.version;
  const accounted = new Set([...Object.keys(version.artifacts), "result.json", ...version.unreceipted]);
  ok("every file in the version folder is accounted for by the receipt or named as extra",
    onDisk.every((n) => accounted.has(n)), onDisk.filter((n) => !accounted.has(n)).join(", "));
  eq("...and the extra file was copied, not dropped", version.unreceipted.join(","), "rain_yue2.mp3");
  ok("...and it really is on disk", existsSync(path.join(versionDir("rain", v1), "rain_yue2.mp3")));

  /* Receipt fields are copied verbatim, never recomputed. */
  eq("the identity is the receipt's", version.identity, REAL_RECEIPT.identity);
  eq("the audio duration is the receipt's", version.audioSeconds, REAL_RECEIPT.audio_seconds);
  eq("the sample rate is the receipt's", version.sampleRate, 48000);
  eq("the end-to-end render time is the receipt's", version.timing.e2eSeconds, REAL_RECEIPT.timing.e2e_seconds);
  eq("...as is the semantic token rate", version.timing.semanticTps, REAL_RECEIPT.timing.semantic.output_tps);
  eq("...and the execution mode", version.timing.execution, "eager");
  eq("...and the attention backend", version.timing.attention, "sdpa");
  eq("the weight hashes ride along untouched",
    version.weights.mot.files["model.safetensors"].bytes, 7261441640);

  /* Adopt sets `current`, because the reason to adopt is to look at it. */
  eq("adopt makes the new version current", (await readScoreDoc("rain")).current, v1);

  /* 🔴 MATCHED BY ID, NEVER BY FOLDER DIFF. A property of the source, because a
   * second matching path would pass every behavioural test here.
   * DIRECTING.md:1220-1243. */
  ok("adoptVersion() never lists a directory looking for the new render",
    !/readdir/.test(adoptVersion.toString()), "adoptVersion mentions readdir");
  ok("...and the store's only readdir calls are the receipt check and the picker",
    (SRC.match(/readdir\(/g) || []).length === 2, String((SRC.match(/readdir\(/g) || []).length));

  /* Reading the score text back out of the adopted folder. */
  eq("the score text comes back byte for byte", await readScoreAbc("rain", v1), REAL_ABC);

  /* ── the duplicate key, refused BY NAME ──────────────────────────────── */
  await throws("adopting the same identity again is refused",
    () => adoptVersion("rain", { dir: makeRun(), by: "user" }),
    new RegExp(`Version ${v1} of "rain" already answers`));
  await throws("...and the refusal says what the identity covers",
    () => adoptVersion("rain", { dir: makeRun(), by: "user" }),
    /request \+ config \+ weights/);

  const allowed = await adoptVersion("rain", {
    dir: makeRun(), by: "agent:overnight", parent: v1, dedupe: "allow",
    note: "re-roll with a shorter outro", label: "outro-6",
  });
  v2 = allowed.id;
  ok("dedupe:\"allow\" adopts it as a second version", v2 !== v1);
  eq("...with the label kept", allowed.version.label, "outro-6");

  /* THE SLUG IS IN THE KEY. DIRECTING.md:1231-1238: the same identity under two
   * songs must not be one row. */
  const other = await adoptVersion("rain-2", { dir: makeRun(), by: "user" });
  ok("the same identity under a different song is a different key",
    other.key !== allowed.key, `${other.key} vs ${allowed.key}`);
  eq("...and is adopted without a duplicate refusal", typeof other.id, "string");
  eq("versionKey() folds the slug in front",
    versionKey("rain", "abc123"), "rain/abc123");

  /* findByKey is the lookup that must NEVER take a bare identity. */
  const doc = await readScoreDoc("rain");
  eq("a folded key resolves to a version", findByKey(doc, allowed.key)?.id, v2);
  eq("...while the identity ALONE resolves to nothing",
    findByKey(doc, REAL_RECEIPT.identity), null);
  eq("...and another song's folded key resolves to nothing here",
    findByKey(doc, versionKey("rain-2", REAL_RECEIPT.identity)), null);
  eq("...and the short form is for a human's eye only",
    shortKey(versionKey("rain", REAL_RECEIPT.identity)), "rain/c02ff5c4f7ac");

  await throws("a parent that does not exist is refused",
    () => adoptVersion("rain", { dir: makeRun(), by: "user", parent: "nope", dedupe: "allow" }),
    /No version "nope" in "rain"/);
  await throws("adopt without an actor is refused",
    () => adoptVersion("rain", { dir: makeRun(), dedupe: "allow" }),
    /needs `by`.*never from the body/s);
  await throws("adopt without a directory is refused",
    () => adoptVersion("rain", { by: "user" }), /needs the vendor's run directory/);
}

/* ════════════════════════════════════════════════════════════════════════
 * 4 · THE PARENT POINTER — the thing a bare `reroll` boolean is not.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n4 · parent, lineage, and the boolean this replaces\n");
{
  const doc = await readScoreDoc("rain");
  eq("the second version points at the first", findVersion(doc, v2).parent, v1);
  eq("...and the first points at nothing", findVersion(doc, v1).parent, null);
  eq("children resolve the other way", childrenOf(doc, v1).join(","), v2);
  eq("the root of a child is the parent's id", rootOf(doc, v2), v1);
  eq("...and the root of a root is itself", rootOf(doc, v1), v1);

  const chain = lineage(doc, v2);
  eq("the lineage is oldest first", chain[0].id, v1);
  eq("...and two long", chain.length, 2);
  eq("the first step has no change map", chain[0].changed, null);
  ok("...and the second does", chain[1].changed !== null);

  /* THE DEFECT BEING REPAIRED, stated as a property of the source: this store
   * records a POINTER, not a boolean called reroll. server/jobs.js:572 and
   * server/library.js:378 are the bare-boolean sites. */
  ok("the store writes no `reroll` boolean",
    !/^\s*reroll[:=]/m.test(SRC.replace(/\/\*[\s\S]*?\*\//g, "")), "a reroll field survives in code");
  ok("...and `parent` is a documented field, not an incidental one",
    /THE POINTER THE VENDOR HAS NOT GOT/.test(SRC));

  /* A hand-edited document can contain a loop, and a route that rendered it
   * would hang. Both walkers are guarded. */
  await updateScore("rain", (d) => {
    findVersion(d, v1).parent = v2;                 // v1 -> v2 -> v1
    return d;
  });
  const looped = await readScoreDoc("rain");
  const t0 = Date.now();
  const walked = lineage(looped, v2);
  const root = rootOf(looped, v2);
  ok("a parent cycle does not hang the lineage walk", Date.now() - t0 < 1000);
  ok("...and terminates with each version once", new Set(walked.map((x) => x.id)).size === walked.length);
  ok("...and rootOf() answers rather than spinning", typeof root === "string", String(root));
  await updateScore("rain", (d) => { findVersion(d, v1).parent = null; return d; });
}

/* ════════════════════════════════════════════════════════════════════════
 * 5 · `changed` IS COMPUTED FROM HASHES AND IS NOT STORED.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n5 · what changed, from the hashes\n");
{
  /* 🔴 NOT A STORED FIELD. The persisted bytes are grepped, because the whole
   * argument for computing it is that a stored diff can disagree with the
   * files — server/mv/store.js:276-287's reason for deriving lastRenderAt(). */
  const raw = readFileSync(path.join(scoreDir("rain"), "score.json"), "utf8");
  ok("the persisted document contains no `changed` key", !/"changed"\s*:/.test(raw));
  ok("...and no stored diff of any name", !/"diff"\s*:/.test(raw));

  const doc = await readScoreDoc("rain");
  const a = findVersion(doc, v1), b = findVersion(doc, v2);
  const same = changesBetween(a, b);
  eq("two identical renders show nothing changed", same.changed.length, 0);
  eq("...and everything the same", same.same.length, Object.keys(a.artifacts).length);
  eq("...with the basis stated", same.basis, "sha256 of every artifact in the two receipts");
  eq("changesBetween(null, x) is null, not an empty diff", changesBetween(null, b), null);

  /* A genuinely different score, same identity. The contradiction worth seeing:
   * the identity covers request+config+weights, so if it matches and the bytes
   * do not, the render is not deterministic — and nobody would DECLARE that. */
  const changedDir = makeRun({ abc: REAL_ABC.replace("Q:1/4=90", "Q:1/4=96") });
  const third = await adoptVersion("rain", {
    dir: changedDir, by: "user", parent: v2, dedupe: "allow", note: "faster",
  });
  const d3 = await readScoreDoc("rain");
  const diff = changesBetween(findVersion(d3, v2), findVersion(d3, third.id));
  eq("a changed score.abc is detected from its hash alone", diff.scoreChanged, true);
  eq("...and named in the change list", diff.changed.join(","), "score.abc");
  eq("...while the audio is reported unchanged", diff.audioChanged, false);
  eq("...and the weights the same", diff.weightsSame, true);
  eq("the identity is reported as identical", diff.identitySame, true);
  eq("...which with changed bytes is flagged as a contradiction", diff.identityContradiction, true);

  /* An artifact added and one removed. */
  const withMore = { ...findVersion(d3, v1), artifacts: { ...findVersion(d3, v1).artifacts } };
  delete withMore.artifacts["latent.npy"];
  withMore.artifacts["prefix.npy"] = { sha256: "0".repeat(64), bytes: 8492 };
  const dd = changesBetween(findVersion(d3, v1), withMore);
  eq("an added artifact is named", dd.added.join(","), "prefix.npy");
  eq("...and a removed one too", dd.removed.join(","), "latent.npy");
}

/* ════════════════════════════════════════════════════════════════════════
 * 6 · THE HUMAN'S NOTE, VERBATIM.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n6 · the note, in the human's own words\n");
{
  /* ear.js:1478-1482: "written in your words, recorded verbatim — it ranks
   * above any menu pick". So: no trim, no collapse, no case change, no
   * summarising. The string below carries every transformation a well-meaning
   * helper might apply. */
  const verbatim = "  keeper — the SECOND chorus is the one.\r\n\n\tthe outro drags:\ttry 6 bars.\n  ";
  const v = await setNote("rain", v1, verbatim, { by: "user" });
  eq("the note comes back byte for byte", v.note, verbatim);
  eq("...with the actor who wrote it", v.noteBy, "user");
  ok("...and when", Number.isFinite(v.noteAt));
  eq("...and it was not truncated", v.noteTruncated, false);

  const raw = readFileSync(path.join(scoreDir("rain"), "score.json"), "utf8");
  ok("the persisted JSON holds exactly those bytes", JSON.parse(raw).versions
    .some((x) => x.note === verbatim));

  /* The cap is ear.js:2347's, and the cut is announced rather than silent. */
  const long = "x".repeat(NOTE_CAP + 500);
  const capped = await setNote("rain", v1, long, { by: "user" });
  eq("a note longer than the cap is cut to it", capped.note.length, NOTE_CAP);
  eq("...and says so", capped.noteTruncated, true);
  eq("the cap is the Ear's", NOTE_CAP, 4000);

  /* 🔴 THE DEFECT THIS TEST FOUND. Appending to a note already at the cap used
   * to slice the concatenation back to 4000, which discarded the whole of the
   * NEW line and reported success. The human's words vanished and the
   * `noteTruncated` flag read as a cosmetic trim. */
  await throws("appending to a note already at the cap is REFUSED, not silently dropped",
    () => setNote("rain", v1, "and the mix is boxy", { by: "user", append: true }),
    /would discard the new text rather than the old/);
  eq("...and the note is left exactly as it was", capped.note.length, NOTE_CAP);

  await setNote("rain", v1, "keeper", { by: "user" });
  const appended = await setNote("rain", v1, "and the mix is boxy", { by: "user", append: true });
  eq("an append that fits keeps both, newline-separated", appended.note, "keeper\nand the mix is boxy");

  await setNote("rain", v1, verbatim, { by: "user" });
  /* Nothing else may touch it. */
  await setAuthor("rain", "Someone Else", { versionId: v1, by: "agent:x" });
  await setCurrent("rain", v2, { by: "user" });
  await setSheet("rain", v1, { html: "sheet.html", pdf: null, pdfSkipped: "no-edge" });
  const after = findVersion(await readScoreDoc("rain"), v1);
  eq("the note survives a credit change, a current change and a sheet", after.note, verbatim);

  eq("clearing a note is possible and is not an empty string",
    (await setNote("rain", v1, null, { by: "user" })).note, null);
  await setNote("rain", v1, verbatim, { by: "user" });

  await throws("a note needs an actor", () => setNote("rain", v1, "x", {}), /needs `by`/);
  await throws("a note on a version that is not there is a named error",
    () => setNote("rain", "nope", "x", { by: "user" }), /No version "nope"/);
}

/* ════════════════════════════════════════════════════════════════════════
 * 7 · `by` AND `author` CANNOT BE MERGED.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n7 · two fields, because no one field can be honest about both\n");
{
  const doc = await readScoreDoc("rain");
  const a = findVersion(doc, v1), b = findVersion(doc, v2);
  eq("the first version was adopted by a human", a.by, "user");
  eq("...the second by an agent", b.by, "agent:overnight");
  eq("...and the credit on the first is a person's name", a.author, "Someone Else");
  ok("...which is a DIFFERENT value from `by`", a.author !== a.by);

  /* 🔴 setAuthor() cannot reach `by`. The provenance module exists to make
   * fabricating human action impossible (server/provenance.js:165-174); a
   * credit field that could write `by` would be a way round it by accident. */
  const before = findVersion(await readScoreDoc("rain"), v2).by;
  await setAuthor("rain", "user", { versionId: v2, by: "agent:overnight" });
  const after = findVersion(await readScoreDoc("rain"), v2);
  eq("setting the credit to the literal string \"user\" does not change `by`", after.by, before);
  eq("...it only changes the credit", after.author, "user");
  ok("setAuthor's signature takes `by` separately and never from the value",
    /export async function setAuthor\(slug, author, \{ versionId = null, by \} = \{\}\)/.test(SRC));
  /* ⚠ WAS "the only writer of `by` is adoptVersion", counting `^\s+by,$` and
   * expecting exactly 1. draftVersion became a second writer on 2026-09-11 and
   * this correctly failed — but the count was only ever a PROXY for the real
   * property, which is that `by` is written from an explicit parameter and
   * never read out of a caller's value. A magic 1 cannot express that, and it
   * goes stale the moment a legitimate second writer arrives.
   *
   * So state the property directly: every function that writes `by` into a
   * record also REFUSES to run without it. Add a writer without the guard and
   * this fails, which is the thing worth catching — not the existence of a
   * second writer.
   *
   * ⚠ COUNTED PER FUNCTION, NOT GLOBALLY, and the first attempt got that wrong
   * too: it asserted the two totals were equal and failed 4 against 2, because
   * setNote and setAuthor also refuse without `by` while writing it under other
   * names (noteBy) rather than as a record field. Four guards against two
   * record writes is correct. The property is about each writer individually,
   * so the source is split per function and every chunk that writes `by` must
   * carry its own guard. */
  const chunks = SRC.split(/^export (?:async )?function /m).slice(1);
  const writers = chunks.filter((c) => /^\s+by,$/m.test(c));
  const unguarded = writers
    .filter((c) => !/needs `by`/.test(c))
    .map((c) => c.slice(0, c.indexOf("(")));
  ok("every function that writes `by` into a record refuses to run without it",
    writers.length > 0 && unguarded.length === 0,
    `${writers.length} writers, unguarded: ${unguarded.join(", ") || "none"}`);

  /* The document-level credit, and per-version override. */
  await setAuthor("rain", "Ada", { by: "user" });
  eq("the score carries a credit of its own", (await readScoreDoc("rain")).author, "Ada");
  eq("...and a version may override it", findVersion(await readScoreDoc("rain"), v2).author, "user");

  /* A version adopted with no author inherits the document's. */
  const inherit = await adoptVersion("rain", { dir: makeRun(), by: "script:test", dedupe: "allow" });
  eq("an adopt with no credit inherits the score's", inherit.version.author, "Ada");
  eq("...and records the script that did it", inherit.version.by, "script:test");

  await throws("a credit change needs an actor", () => setAuthor("rain", "x", {}), /needs `by`/);
}

/* ════════════════════════════════════════════════════════════════════════
 * 8 · DERIVED, NOT STORED — and the picker row.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n8 · nothing derivable is stored\n");
{
  const doc = await readScoreDoc("rain");
  const raw = readFileSync(path.join(scoreDir("rain"), "score.json"), "utf8");
  ok("no total is stashed on the document", !/"renderSeconds"\s*:/.test(raw) && !/"lastVersionAt"\s*:/.test(raw));
  eq("when it last produced something is derived from the versions",
    lastVersionAt(doc), Math.max(...doc.versions.map((v) => v.at)));
  const expect = doc.versions.reduce((n, v) => n + (v.timing.e2eSeconds || 0), 0);
  eq("the GPU seconds are summed off the receipts", renderSeconds(doc), expect);

  const rows = await listScores();
  const rain = rows.find((r) => r.slug === "rain");
  ok("the picker row counts versions", rain.versions === doc.versions.length, String(rain.versions));
  /* HOW MANY SONGS ARE REALLY IN THIS FOLDER. A count of versions cannot say. */
  eq("...and counts ROOTS, which is the question a count of versions cannot answer",
    rain.roots, new Set(doc.versions.map((v) => rootOf(doc, v.id))).size);
  ok("...and reports the render time and the current audio duration",
    rain.renderSeconds > 0 && rain.currentAudioSeconds === REAL_RECEIPT.audio_seconds,
    JSON.stringify([rain.renderSeconds, rain.currentAudioSeconds]));
  ok("...and both timestamps, because they answer different questions",
    Number.isFinite(rain.updatedAt) && Number.isFinite(rain.renderedAt) && rain.updatedAt >= rain.renderedAt);
  ok("rows are newest-touched first", rows.every((r, i) => i === 0 || rows[i - 1].updatedAt >= r.updatedAt));

  eq("a sheet attached to a version is counted", rows.find((r) => r.slug === "rain").sheets, 1);
  eq("...and a PDF that was never made is not", rows.find((r) => r.slug === "rain").pdfs, 0);

  /* setCurrent is explicit, so "the take we are using" survives a later adopt
   * that turns out worse — which mtime order cannot express. */
  await setCurrent("rain", v1, { by: "user" });
  eq("current is an explicit pointer, not the newest row", (await readScoreDoc("rain")).current, v1);
  await throws("...and cannot point at a version that is not there",
    () => setCurrent("rain", "nope", { by: "user" }), /No version "nope"/);

  /* The breadcrumb trail is bounded. */
  ok("the run trail is bounded", (await readScoreDoc("rain")).runs.length <= store.RUN_LIMIT);
  ok("...and records what happened, not just that something did",
    (await readScoreDoc("rain")).runs.some((r) => r.what === "adopt" && r.version),
    JSON.stringify((await readScoreDoc("rain")).runs.slice(0, 3)));
}

/* ════════════════════════════════════════════════════════════════════════
 * 9 · PATHS. Nothing from a caller becomes a path.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n9 · paths\n");
{
  /* 🔴 THE SECOND DEFECT THIS TEST FOUND. safeSeg() used server/mv/routes.js's
   * basename-then-check, which is SAFE — nothing escapes the folder — and not
   * honest: "../../score.json" normalised to a read of `score.json` inside the
   * version folder and answered ENOENT for a file the caller never named. A
   * value that is not already one segment is now refused outright. */
  for (const bad of ["../escape", "..", ".", "", "a/b", "a\\b", "x/../y", null, undefined]) {
    eq(`safeSeg(${JSON.stringify(bad)}) refuses it`, store.safeSeg(bad), null);
  }
  eq("...while a plain name passes through untouched", store.safeSeg("audio.flac"), "audio.flac");
  await throws("an artifact read with a traversing name is refused BY NAME, not by ENOENT",
    () => store.readArtifact("rain", v1, "../../score.json"), /bad artifact path/);
  ok("the sheets folder is outside the version folder",
    !sheetDir("rain", v1).startsWith(versionDir("rain", v1)),
    `${sheetDir("rain", v1)} vs ${versionDir("rain", v1)}`);
}

/* ════════════════════════════════════════════════════════════════════════
 * 10 · DELETE takes the folder with it.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n10 · delete\n");
{
  await createScore("Throwaway");
  await adoptVersion("throwaway", { dir: makeRun(), by: "user" });
  ok("the folder exists before", existsSync(scoreDir("throwaway")));
  await deleteScore("throwaway");
  ok("...and is gone after, artifacts included", !existsSync(scoreDir("throwaway")));
  eq("...and it leaves the picker", (await listScores()).filter((r) => r.slug === "throwaway").length, 0);
}

/* ── done ────────────────────────────────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════════════════════
   draftVersion — a version with no render behind it

   ⚠ THESE EXIST BECAUSE THE FUNCTION DID NOT. mcp-music-score.js has posted
   `action: "draft"` from score_edit and score_mechanical since it shipped, and
   nothing implemented it: both tools answered "Unknown action" for their whole
   existence while their 188 assertions passed, because that suite checks what
   the tool would SEND. The store had no way to write an edited score at all —
   adoptVersion requires a verified vendor run folder, which an un-rendered
   edit has not got.
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- draftVersion: an edited score, with no audio yet --");
{
  const { draftVersion } = store;
  const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
  const ABC = [
    "X:1", "T:", "M:4/4", "L:1/16", "Q:1/4=95", "K:Dm",
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
    'V: Ins clef=treble name="Ins Melody" snm="Inst."',
    "% verse", "V: Vocal", '"Dm"A4B4c4d4|"C"e8z8|', "V: Ins", "z16|z16|",
  ].join("\n");

  const made = await createScore("Draft Suite");
  const slug = made.slug;

  const first = await draftVersion(slug, {
    abc: ABC, by: "user", note: "the first draft, verbatim",
    style: "indie folk", lyrics: "(none)", cot: "full",
    check: { ok: true, sha256: sha(ABC) },
  });
  ok("a draft is written and returns an id", !!first.id, JSON.stringify(first).slice(0, 140));
  eq("its identity is the SCORE's own hash, not a receipt's", first.version.identity, `abc:${sha(ABC)}`);
  eq("it is marked drafted", first.version.drafted, true);
  /* ⚠ null AND PRESENT, not absent. Absent reads as "nobody recorded it";
   * null reads as "there is no take". That distinction is the difference
   * between a draft and a render whose receipt went missing. */
  ok("every render field is explicitly null rather than absent",
    first.version.audioSeconds === null && first.version.timing === null
    && "audioSeconds" in first.version && "timing" in first.version && "weights" in first.version,
    JSON.stringify({ a: first.version.audioSeconds, t: first.version.timing }));
  eq("the note is kept verbatim", first.version.note, "the first draft, verbatim");
  eq("the request it is FOR travels with it", first.version.request.style, "indie folk");
  ok("score.abc on disk is exactly the text supplied",
    (await readScoreAbc(slug, first.id)) === ABC);
  ok("...and is named in `unreceipted`, because no receipt covers it",
    (first.version.unreceipted || []).includes("score.abc"),
    JSON.stringify(first.version.unreceipted));

  /* ⚠ THE OPPOSITE OF adopt, ON PURPOSE. adopt moves `current` because the
   * reason to adopt is to look at the thing. Moving it to a draft would point
   * "the take we are using" at something nobody can listen to. */
  const afterFirst = await readScoreDoc(slug);
  ok("`current` does NOT follow a draft — a draft has nothing to hear",
    afterFirst.current !== first.id,
    `current=${afterFirst.current} draft=${first.id}`);

  const ABC2 = ABC.replace("Q:1/4=95", "Q:1/4=104");
  const second = await draftVersion(slug, {
    abc: ABC2, by: "user", parent: first.id, note: "tempo 95 -> 104",
    check: { ok: true, sha256: sha(ABC2) },
  });
  eq("a second draft parents on the first", second.version.parent, first.id);
  eq("...and carries its own identity", second.version.identity, `abc:${sha(ABC2)}`);

  await throws("a check verdict for OTHER bytes is refused, naming both hashes",
    () => draftVersion(slug, {
      abc: ABC.replace("Q:1/4=95", "Q:1/4=120"), by: "user",
      check: { ok: true, sha256: "0".repeat(64) },
    }),
    /is for 000000000000 and the score supplied hashes to/);

  await throws("the identical notation twice is refused, naming the version that holds it",
    () => draftVersion(slug, { abc: ABC, by: "user" }),
    /already holds this exact notation/);

  ok("...unless dedupe is explicitly allowed",
    !!(await draftVersion(slug, { abc: ABC, by: "user", dedupe: "allow" })).id);

  await throws("a parent that does not exist is refused",
    () => draftVersion(slug, {
      abc: ABC.replace("Q:1/4=95", "Q:1/4=132"), by: "user", parent: "nosuchver",
    }),
    /No version "nosuchver"/);

  await throws("an empty score is refused",
    () => draftVersion(slug, { abc: "   ", by: "user" }), /needs `abc`/);

  /* `by` comes from the request and never from the body — this file's banner. */
  await throws("a missing actor is refused",
    () => draftVersion(slug, { abc: ABC.replace("Q:1/4=95", "Q:1/4=144") }), /needs `by`/);

  await deleteScore(slug);
}

if (!process.env.KEEP_SCORE_TEST) rmSync(OUT, { recursive: true, force: true });
else console.log(`\n  kept ${OUT}`);
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
