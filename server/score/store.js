/**
 * THE SCORE — a first-class artifact, and its store.
 *
 * One JSON document plus an artifact folder per slug, EXACTLY the contract
 * server/mv/store.js:1-21 sets out and for the same three reasons: a single
 * writer per slug through one promise chain, write-temp-then-rename, and a
 * document that nothing else re-serialises from a fixed field list.
 *
 *   <outputDir>/score/<slug>/score.json              the document
 *   <outputDir>/score/<slug>/versions/<id>/           THE VENDOR'S OWN FOLDER
 *   <outputDir>/score/<slug>/sheets/<id>/             ours: sheet.html, sheet.pdf
 *
 * ┌─ WHY THE VENDOR'S FOLDER IS STORED WHOLE AND NOT REINVENTED ────────────┐
 * │ YuE2 already writes 10 hashed files plus a receipt (result.json) that    │
 * │ carries an `identity` hash over request + config + weights. MEASURED on  │
 * │ a real render's result.json: 10 artifacts with sha256 and                │
 * │ bytes each, the two weight files hashed with their config, and the whole │
 * │ timing breakdown. Re-deriving any of that here would produce a second    │
 * │ opinion about the same bytes, and the two would disagree the first time  │
 * │ a file was touched. So the folder is copied in verbatim, the receipt is  │
 * │ VERIFIED against it once on the way in, and the document stores only     │
 * │ what the app needs and the vendor does not emit.                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * FOUR ADDITIONS, and nothing else:
 *
 *  1. `parent` — A POINTER. The vendor has none, and this repo's existing
 *     `reroll` is a bare boolean (server/jobs.js:572 `reroll: !!j.reusesConditioning`,
 *     server/library.js:378, web/app.js:1502 renders it as the words
 *     "re-roll"). A boolean says a render was a repeat and not WHAT it
 *     repeated, so N versions of a song today are N unrelated rows sorted by
 *     mtime. `parent` makes them a tree; `rootId` and `lineage()` walk it.
 *
 *  2. `note` — the human's words, VERBATIM. The Ear's precedent, in its own
 *     words: "written in your words, recorded verbatim — it ranks above any
 *     menu pick" (server/daw/ear.js:1478-1482). Capped at 4000 characters
 *     exactly as ear.js:2347 caps free_text, and otherwise untouched: not
 *     trimmed to a summary, not parsed for keywords, not lowercased.
 *
 *  3. `by` AND `author`, WHICH CANNOT BE MERGED.
 *       `by`     the actor that caused this version to be adopted. Comes from
 *                provenance.actorFrom(req) (server/provenance.js:192) and NEVER
 *                from the request body — that function deliberately coerces a
 *                header claiming "user" to "system" so an agent cannot
 *                fabricate human action, and a `by` readable from the body
 *                would hand back exactly that power.
 *       `author` the credit. Who wrote the song. Free text, set by a human.
 *     Merging them either credits a robot for a person's song or claims a
 *     person pressed a button they did not press. There is no single field that
 *     can be honest about both, so there are two, and setAuthor() cannot write
 *     `by` while adoptVersion() cannot read `author` from anywhere but the body.
 *
 *  4. `changed` — COMPUTED FROM HASHES, NEVER DECLARED, and computed ON READ.
 *     See changesBetween(). It is not a stored field, and store_test.js asserts
 *     the persisted document contains no `changed` key: a stored diff is a diff
 *     that can disagree with the files, which is the same defect
 *     server/mv/store.js:276-287 avoids by deriving lastRenderAt().
 *
 * ⚠ MATCHING. A finished render is matched BY THE ID THIS STORE RETURNED, never
 * by diffing a folder. DIRECTING.md:1220-1252 is the measured reason: a loop
 * that waited for "any new file" raced through five shots in under a minute,
 * and a matching key that was unique within one film and identical across two
 * stamped sixteen shots complete in four seconds for a film that had never been
 * rendered — "not an error, it is a confident wrong answer". So versionKey()
 * folds the SLUG into the vendor's identity hash, and adoptVersion() refuses a
 * duplicate key by naming the version that already answers to it.
 */
import { readFile, writeFile, rename, mkdir, readdir, stat, rm, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
/* THE SAME SLUGIFIER, not a second one. server/mv/store.js:40-48 is the
 * on-disk-identity rule for this whole app; a divergent copy would put one
 * title in two folder names, which is the four-copies drift
 * server/mv/store.js:355-379 spells out for assetComplete(). */
import { slugify } from "../mv/store.js";

export { slugify };

export const SCORE_DIR = () => path.join(config.outputDir, "score");
export const scoreDir = (slug) => path.join(SCORE_DIR(), slug);
export const versionsDir = (slug) => path.join(scoreDir(slug), "versions");
/** THE VENDOR'S folder, byte for byte. Nothing of ours is written inside it. */
export const versionDir = (slug, id) => path.join(versionsDir(slug), id);
/** OURS. Separate so "every file here is in the receipt" stays checkable. */
export const sheetsDir = (slug) => path.join(scoreDir(slug), "sheets");
export const sheetDir = (slug, id) => path.join(sheetsDir(slug), id);
const docPath = (slug) => path.join(scoreDir(slug), "score.json");

/** Document version. Bump only with a migration in `migrate()`. */
export const DOC_VERSION = 1;

/** ear.js:2347's cap, verbatim. Long enough for a paragraph of direction. */
export const NOTE_CAP = 4000;
/** Bounded breadcrumbs, the same number server/mv/store.js:426-430 keeps. */
export const RUN_LIMIT = 200;

const newId = () => randomUUID().slice(0, 8);

/**
 * One path segment, or null. Same posture as server/mv/routes.js:92-95's
 * `safe`, and deliberately STRICTER in one way.
 *
 * ⚠ `safe` normalises with basename, so "a/b" becomes "b" and "../../x.json"
 * becomes "x.json". That is safe — nothing escapes the folder — but it is not
 * honest: MEASURED while writing store_test.js, a read of "../../score.json"
 * turned into a read of `score.json` INSIDE the version folder and came back
 * ENOENT for a file the caller never named. A value that was not already a
 * single segment is refused here instead, so the error says what was wrong
 * rather than reporting a different file missing.
 */
export const safeSeg = (v) => {
  const s = String(v ?? "");
  if (!s || s === "." || s === ".." || s.includes("..")) return null;
  return path.basename(s) === s ? s : null;
};

/**
 * A blank score document. Every array exists from the start so nothing
 * downstream has to null-check — server/mv/store.js:52's rule.
 */
export function blankScore(title) {
  const now = Date.now();
  return {
    v: DOC_VERSION,
    kind: "score",
    id: newId(),
    slug: slugify(title),
    title: String(title || "Untitled"),
    createdAt: now,
    updatedAt: now,
    /* THE CREDIT, at the document level as well as per version. A song has one
     * author across its re-rolls; a version may override it when a different
     * hand made that take. Never written from a request header. */
    author: null,
    /* Newest first. Each entry is one adopted render; see adoptVersion(). */
    versions: [],
    /* Which version is the one to show. An explicit pointer rather than
     * "versions[0]": mtime order is what made N versions N unrelated rows in
     * the first place, and "the newest render" is not the same question as
     * "the take we are using". */
    current: null,
    runs: [],
  };
}

/* ─────────────────────────────────────────────── the single-writer queue */

/** One promise chain per slug. server/mv/store.js:188-200, same shape. */
const chains = new Map();

function enqueue(slug, fn) {
  const prev = chains.get(slug) ?? Promise.resolve();
  // The chain must not break on a rejection, or every later write for this
  // score is silently dropped. Callers still see their own error.
  const next = prev.then(fn, fn);
  chains.set(slug, next.then(() => {}, () => {}));
  return next;
}

async function writeDoc(slug, doc) {
  await mkdir(versionsDir(slug), { recursive: true });
  const tmp = docPath(slug) + `.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await rename(tmp, docPath(slug));
  return doc;
}

/** Forward-compatible reads: an older doc is migrated in memory on load. */
function migrate(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (!doc.kind) doc.kind = "score";
  if (!Array.isArray(doc.versions)) doc.versions = [];
  if (!Array.isArray(doc.runs)) doc.runs = [];
  if (doc.current === undefined) doc.current = doc.versions[0]?.id ?? null;
  if (doc.author === undefined) doc.author = null;
  /* ⚠ A DEFAULT-EMPTY MIGRATION DOES NOT BUMP DOC_VERSION. Same call as
   * server/mv/store.js:216-219: it reads forward and backward, and bumping
   * would make an older build refuse a document it can read perfectly. */
  return doc;
}

export async function readScoreDoc(slug) {
  try {
    return migrate(JSON.parse(await readFile(docPath(slug), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Read, mutate, write — atomically with respect to every other writer.
 * `fn` may mutate in place or return a replacement; `false` abandons the write.
 * server/mv/store.js:239-256, verbatim in behaviour.
 */
export async function updateScore(slug, fn) {
  return enqueue(slug, async () => {
    const doc = await readScoreDoc(slug);
    if (!doc) throw new Error(`No such score: ${slug}`);
    const out = await fn(doc);
    if (out === false) return doc;
    const next = out && typeof out === "object" ? out : doc;
    next.updatedAt = Date.now();
    return writeDoc(slug, next);
  });
}

export async function createScore(title, { author = null } = {}) {
  const doc = blankScore(title);
  if (author) doc.author = String(author).slice(0, 200);
  // Two songs called "Rain" must not become one folder. mv/store.js:260-265.
  let slug = doc.slug, n = 2;
  while (await readScoreDoc(slug)) slug = `${doc.slug}-${n++}`;
  doc.slug = slug;
  return enqueue(slug, () => writeDoc(slug, doc));
}

export async function deleteScore(slug) {
  return enqueue(slug, async () => {
    await rm(scoreDir(slug), { recursive: true, force: true });
    return true;
  });
}

/* ─────────────────────────────────────────── the key, with the song in it */

/**
 * THE MATCHING KEY. The vendor's identity hash with the slug folded in.
 *
 * The identity hash covers request + config + weights — MEASURED,
 * run_fixed/result.json:3 is 64 hex characters over exactly those three. What
 * it does NOT cover is which song it belongs to, because the vendor has no
 * concept of one. Two songs generated from the same style and lyrics text would
 * therefore share an identity, and a store keyed on it alone would hand the
 * second song the first song's render and report success.
 *
 * That is DIRECTING.md:1231-1238's measured disaster with the nouns changed:
 * "unique within one film and identical across two ... not an error, it is a
 * confident wrong answer". The slug goes in front, separated by "/", which a
 * slug cannot contain (server/mv/store.js:40-48 strips everything but
 * [a-z0-9-]), so the key is unambiguous and still readable in a folder listing.
 */
export const versionKey = (slug, identity) => `${slug}/${String(identity ?? "")}`;

/** Short display form. Never used for matching — only for a human's eye. */
export const shortKey = (key) => {
  const [slug, identity] = String(key).split("/");
  return identity ? `${slug}/${identity.slice(0, 12)}` : String(key);
};

/* ───────────────────────────────────────── reading the vendor's receipt */

/** sha256 of a file, hex. The same digest the receipt states. */
async function sha256File(file) {
  const h = createHash("sha256");
  h.update(await readFile(file));
  return h.digest("hex");
}

/**
 * The receipt, plus what the folder next to it actually contains.
 *
 * THREE LISTS, and every one of them is a real thing that happened:
 *   mismatched   a file whose bytes or sha256 disagree with the receipt. The
 *                one that must block: it means the folder is not the render.
 *   missing      a receipt entry with no file. Also blocking.
 *   unreceipted  a file present that the receipt does not hash. NOT blocking.
 *                MEASURED: run_fixed/ holds 12 files — the receipt's 10, the
 *                receipt itself, and `rain_yue2.mp3`, which was made by hand
 *                from audio.flac a minute after the render (mtime 02:46 against
 *                02:45). Refusing that folder would refuse a real render over a
 *                convenience file; dropping the extra file silently would lose
 *                it. It is copied and named.
 *
 * `verify: "hash"` (the default) reads every byte. MEASURED on the real
 * 34.7 MB folder (audio.flac alone is 33,549,285 bytes): **38 ms**, against
 * 1 ms for `verify: "bytes"` and against the 399.6 s render it is checking. So
 * the strict mode is the default and the cheap one exists only for a caller
 * that has already hashed these files itself.
 */
export async function readReceipt(dir, { verify = "hash" } = {}) {
  const receiptPath = path.join(dir, "result.json");
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (err) {
    throw new Error(
      `No readable result.json in ${dir}. That file is the render's receipt — `
      + "it carries the identity hash over request+config+weights and the per-file "
      + `sha256 map — and without it there is nothing to verify against (${err.message}).`,
    );
  }
  const artifacts = receipt.artifacts && typeof receipt.artifacts === "object" ? receipt.artifacts : {};
  if (!receipt.identity) {
    throw new Error(`result.json in ${dir} has no \`identity\`. Refusing to adopt a render that cannot be keyed.`);
  }

  let present = [];
  try {
    present = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
  } catch (err) {
    throw new Error(`Cannot read ${dir}: ${err.message}`);
  }

  const missing = [];
  const mismatched = [];
  for (const [name, spec] of Object.entries(artifacts)) {
    const file = path.join(dir, name);
    let st;
    try { st = await stat(file); } catch { missing.push(name); continue; }
    if (Number.isFinite(spec?.bytes) && st.size !== spec.bytes) {
      mismatched.push({ name, field: "bytes", receipt: spec.bytes, found: st.size });
      continue;
    }
    if (verify === "hash" && spec?.sha256) {
      const found = await sha256File(file);
      if (found !== spec.sha256) mismatched.push({ name, field: "sha256", receipt: spec.sha256, found });
    }
  }
  const hashed = new Set(Object.keys(artifacts));
  const unreceipted = present.filter((n) => n !== "result.json" && !hashed.has(n));

  return { receipt, receiptPath, present, missing, mismatched, unreceipted, verified: verify };
}

/* ────────────────────────────────────────────────────────── adopting a run */

/**
 * Adopt a finished vendor run as a version of this score.
 *
 * THE ID IS RETURNED BY THIS FUNCTION AND IS THE ONLY WAY TO ASK ABOUT THE
 * RENDER AFTERWARDS. Nothing here scans for new folders, compares directory
 * listings, or waits for a file to appear — DIRECTING.md:1220-1252 measured all
 * three failing: "the app writes more than one file per render, so the previous
 * shot's second file counted as this shot's first", five shots posted in under
 * a minute on the wrong engine, and sixteen shots stamped complete in four
 * seconds for a film that had never been rendered. The id is minted before the
 * copy and handed back with it.
 *
 * Fields taken from the CALLER and never invented here:
 *   by      the actor. From provenance.actorFrom(req) at the route, not the body.
 *   author  the credit. From the body, or inherited from the document.
 *   note    the human's words, verbatim, capped.
 *   parent  the version this one re-rolls. null for a root.
 */
export async function adoptVersion(slug, {
  dir, by, author = undefined, note = null, parent = null,
  dedupe = "refuse", verify = "hash", id = null, label = null,
} = {}) {
  if (!dir) throw new Error("adoptVersion needs the vendor's run directory.");
  if (!by) throw new Error("adoptVersion needs `by` — the actor. It comes from the request, never from the body.");

  const read = await readReceipt(dir, { verify });
  const { receipt } = read;

  if (read.missing.length || read.mismatched.length) {
    throw new Error(
      `${dir} does not match its own receipt and will not be adopted. `
      + (read.missing.length ? `missing: ${read.missing.join(", ")}. ` : "")
      + (read.mismatched.length
        ? `changed: ${read.mismatched.map((m) => `${m.name} (${m.field})`).join(", ")}. `
        : "")
      + "The receipt hashes request+config+weights and every artifact; a folder that disagrees "
      + "with it is not the render the receipt describes.",
    );
  }

  const key = versionKey(slug, receipt.identity);
  const versionId = safeSeg(id) || newId();

  return updateScore(slug, async (doc) => {
    /* DUPLICATE KEY. DIRECTING.md:1244-1252 measured the alternative: a shot
     * "completed in four seconds with the identical bad clip" because the
     * matcher found the old render and every log line said success. So the
     * refusal NAMES the version that already answers to this key. */
    const matches = doc.versions.filter((v) => v.key === key);
    if (matches.length && dedupe !== "allow") {
      /* THE OLDEST, not the newest. `versions` is newest-first, so `find()`
       * named the most recent duplicate — which is the wrong one to hand back:
       * the version a caller already has is the original, and the later ones
       * only exist because somebody passed dedupe:"allow" on purpose. */
      const already = matches[matches.length - 1];
      throw new Error(
        `Version ${already.id} of "${slug}" already answers to ${shortKey(key)} `
        + `(adopted ${new Date(already.at).toISOString()}`
        + (matches.length > 1 ? `, and ${matches.length - 1} more like it` : "")
        + "). The identity hash covers request + config + weights, so this is the same "
        + "render request. Pass dedupe:\"allow\" to adopt it as a second version anyway — "
        + "and if you meant to re-roll, change something the identity covers, because a "
        + "re-render that hashes identically is the same file.",
      );
    }
    if (parent && !doc.versions.some((v) => v.id === parent)) {
      throw new Error(`No version "${parent}" in "${slug}" to be the parent of this one.`);
    }
    if (doc.versions.some((v) => v.id === versionId)) {
      throw new Error(`Version id "${versionId}" is already used in "${slug}".`);
    }

    /* The copy. Into versionDir, which holds NOTHING of ours — so
     * "every file here is hashed by result.json, or named in `unreceipted`"
     * stays a property a test can check. */
    const dest = versionDir(slug, versionId);
    await mkdir(dest, { recursive: true });
    for (const name of read.present) {
      const safe = safeSeg(name);
      if (!safe) continue;
      await copyFile(path.join(dir, name), path.join(dest, safe));
    }

    const t = receipt.timing || {};
    const version = {
      id: versionId,
      key,
      /* ⚠ THE POINTER THE VENDOR HAS NOT GOT, and the repo's `reroll` boolean
       * is not. Without it, server/library.js:378's `reroll: !!m.reroll` is the
       * whole of what a second take records about the first. */
      parent: parent || null,
      label: label ? String(label).slice(0, 80) : null,
      at: Date.now(),
      /* TWO FIELDS, NEVER ONE. See this file's banner. */
      by,
      author: author === undefined ? (doc.author ?? null) : (author === null ? null : String(author).slice(0, 200)),
      /* VERBATIM. Capped at ear.js:2347's 4000 and otherwise untouched. */
      note: note === null || note === undefined ? null : String(note).slice(0, NOTE_CAP),
      /* ── straight off the receipt. Copied, never recomputed. ───────────── */
      identity: receipt.identity,
      status: receipt.status ?? null,
      audioSeconds: Number.isFinite(receipt.audio_seconds) ? receipt.audio_seconds : null,
      sampleRate: receipt.sample_rate ?? null,
      truncated: receipt.truncated ?? null,
      weights: receipt.weights ?? null,
      timing: {
        e2eSeconds: t.e2e_seconds ?? null,
        semanticSeconds: t.semantic?.seconds ?? null,
        semanticTokens: t.semantic?.output_tokens ?? null,
        semanticTps: t.semantic?.output_tps ?? null,
        narSeconds: t.nar_seconds ?? null,
        vaeSeconds: t.vae_seconds ?? null,
        loadSeconds: t.load?.resolve_and_integrity_seconds ?? null,
        execution: t.semantic?.execution ?? null,
        attention: t.semantic?.attention ?? null,
        cfgBranches: t.semantic?.cfg_branches ?? null,
      },
      artifacts: receipt.artifacts ?? {},
      /* What was in the folder that the receipt does not hash. MEASURED
       * example: rain_yue2.mp3, made by hand from audio.flac. */
      unreceipted: read.unreceipted,
      verified: read.verified,
      /* Set by sheet.js when a sheet is engraved. Absent is not a failure. */
      sheet: null,
      /* ⚠ NO `changed` KEY. It is computed on read by changesBetween(), for
       * server/mv/store.js:276-287's reason: a stored diff goes wrong the
       * moment anything beside it moves, and there is no migration to write. */
    };

    doc.versions.unshift(version);
    /* `current` follows an adopt, because the reason to adopt is to look at it.
     * An explicit pointer, so "the take we are using" survives a later adopt
     * that turns out worse — which mtime order cannot express. */
    doc.current = versionId;
    noteScoreRun(doc, { what: "adopt", version: versionId, key, by, parent: parent || null,
                        unreceipted: read.unreceipted.length });
    return doc;
  }).then((doc) => ({ id: versionId, key, version: findVersion(doc, versionId), doc }));
}

/* ─────────────────────────────────────────────── a version with no render yet */

/**
 * Write an EDITED score as a new version. The row a render later attaches to.
 *
 * ⚠ WHY NOT `adoptVersion`. Adopt requires `dir` — a finished vendor run
 * folder, verified against result.json's own sha256 map — which by definition
 * an un-rendered edit has not got. mcp-music-score.js:1867 says exactly this in
 * its own comment and has been posting `action: "draft"` since it shipped. The
 * action was never implemented, so `score_edit` and `score_mechanical` both
 * answered "Unknown action" for their whole existence while their 188
 * assertions passed, because the suite calls the tool and checks the shape of
 * what it would send. Half the score surface was inert. This is the half.
 *
 * ⚠ THE IDENTITY IS THE SCORE'S OWN HASH, not a receipt's. A rendered version's
 * key hashes request + config + weights, because what makes two renders the
 * same is everything that went into them. A draft has none of that: what makes
 * two drafts the same is that the NOTATION is the same, so the key is the
 * sha256 of the ABC, prefixed to keep the two kinds of identity from ever
 * colliding in `doc.versions`. Without the prefix a draft could in principle
 * answer to a render's key and dedupe against it, which would be a silent lie
 * about provenance.
 *
 * The caller supplies the check verdict rather than this function recomputing
 * it, deliberately: `checkScore()` lives beside the ABC parser in abc.js and
 * the callers already run it to decide whether to write at all. Recomputing it
 * here would put a second opinion about validity in the store, and the store
 * is not where that argument belongs. What IS enforced here is that the hash
 * the caller claims matches the bytes it handed over.
 */
export async function draftVersion(slug, {
  abc, by, author = undefined, note = null, parent = null,
  style = null, lyrics = null, cot = null,
  check = null, id = null, label = null, dedupe = "refuse",
} = {}) {
  if (!abc || !String(abc).trim()) throw new Error("draftVersion needs `abc` — the edited score.");
  if (!by) throw new Error("draftVersion needs `by` — the actor. It comes from the request, never from the body.");

  const text = String(abc);
  const sha = createHash("sha256").update(text, "utf8").digest("hex");
  /* The caller's claim, checked against the bytes. A mismatch means the score
   * that was validated is not the score being stored, and storing it would
   * attach a passing verdict to unexamined notation. */
  if (check && check.sha256 && check.sha256 !== sha) {
    throw new Error(
      `The check verdict is for ${String(check.sha256).slice(0, 12)} and the score supplied hashes to `
      + `${sha.slice(0, 12)}. Nothing was written: a verdict about other bytes is not a verdict about these.`,
    );
  }
  const key = versionKey(slug, `abc:${sha}`);
  const versionId = safeSeg(id) || newId();

  return updateScore(slug, async (doc) => {
    const matches = doc.versions.filter((v) => v.key === key);
    if (matches.length && dedupe !== "allow") {
      const already = matches[matches.length - 1];
      throw new Error(
        `Version ${already.id} of "${slug}" already holds this exact notation (${shortKey(key)}, `
        + `written ${new Date(already.at).toISOString()}). An edit that changes nothing is not a new `
        + `version; change the score, or pass dedupe:"allow" if a second row is genuinely wanted.`,
      );
    }
    if (parent && !doc.versions.some((v) => v.id === parent)) {
      throw new Error(`No version "${parent}" in "${slug}" to be the parent of this one.`);
    }
    if (doc.versions.some((v) => v.id === versionId)) {
      throw new Error(`Version id "${versionId}" is already used in "${slug}".`);
    }

    /* score.abc is the whole artifact. versionDir holds nothing else, so
     * "every file here is hashed by result.json or named in `unreceipted`"
     * still holds — `unreceipted` names it, because no receipt covers it. */
    const dest = versionDir(slug, versionId);
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "score.abc"), text, "utf8");

    const version = {
      id: versionId,
      key,
      parent: parent || null,
      label: label ? String(label).slice(0, 80) : null,
      at: Date.now(),
      by,
      author: author === undefined ? (doc.author ?? null) : (author === null ? null : String(author).slice(0, 200)),
      note: note === null || note === undefined ? null : String(note).slice(0, NOTE_CAP),
      identity: `abc:${sha}`,
      /* ⚠ `drafted`, AND EVERY RENDER FIELD EXPLICITLY NULL rather than absent.
       * A reader asking "how long is this take" must get null and not undefined:
       * absent reads as "nobody recorded it", null reads as "there is no take".
       * The distinction is the whole difference between a draft and a render
       * whose receipt went missing. */
      drafted: true,
      status: null,
      audioSeconds: null,
      sampleRate: null,
      truncated: null,
      weights: null,
      timing: null,
      artifacts: {},
      unreceipted: ["score.abc"],
      verified: false,
      /* The request this draft is FOR, carried so a later render can be made
       * from the same words rather than from whatever the caller remembers. */
      request: {
        style: style === null || style === undefined ? null : String(style),
        lyrics: lyrics === null || lyrics === undefined ? null : String(lyrics),
        cot: cot || null,
      },
      check: check ? { ok: !!check.ok, sha256: sha } : null,
      sheet: null,
    };

    doc.versions.unshift(version);
    /* ⚠ `current` DOES NOT FOLLOW A DRAFT, and that is the opposite of adopt.
     * Adopt moves it because the reason to adopt is to look at the thing. A
     * draft is a proposal with no audio: moving `current` to it would make "the
     * take we are using" point at something nobody can listen to, and the
     * player would have nothing to play. The render that comes from this draft
     * moves it, when there is something to hear. */
    noteScoreRun(doc, { what: "draft", version: versionId, key, by, parent: parent || null,
                        sha256: sha });
    return doc;
  }).then((doc) => ({ id: versionId, key, sha256: sha, version: findVersion(doc, versionId), doc }));
}

/* ──────────────────────────────────────────── the human's note, and credit */

/**
 * Record the human's note on a version. VERBATIM.
 *
 * ear.js:1478-1482's precedent in full: "written in your words, recorded
 * verbatim — it ranks above any menu pick". So this function does not trim
 * whitespace, does not collapse newlines, does not lowercase and does not
 * summarise. The only transformation is the 4000-character cap ear.js:2347
 * applies, and `truncated` says when it bit rather than leaving a sentence
 * silently cut in half.
 */
export async function setNote(slug, versionId, note, { by, append = false } = {}) {
  if (!by) throw new Error("setNote needs `by` — the actor, from the request.");
  const text = note === null || note === undefined ? null : String(note);
  return updateScore(slug, (doc) => {
    const v = findVersion(doc, versionId);
    if (!v) throw new Error(`No version "${versionId}" in "${slug}".`);
    const next = text === null ? null
      : append && v.note ? `${v.note}\n${text}` : text;
    /* ⚠ AN APPEND THAT WOULD NOT FIT IS REFUSED, NOT SILENTLY DROPPED.
     * MEASURED while writing store_test.js: slicing the concatenation to the
     * cap discarded the whole of the new line and still reported success with
     * `noteTruncated`, so the human's words vanished and the flag looked like a
     * cosmetic trim. A replacement is cut at the cap because the caller can see
     * what they sent; an append cannot be, because the part that gets cut is
     * exactly the part they just wrote. */
    if (append && next !== null && next.length > NOTE_CAP) {
      throw new Error(
        `That note is already ${v.note.length} characters and the cap is ${NOTE_CAP}, so appending `
        + `${text.length} more would discard the new text rather than the old. Send the whole note `
        + "instead (append: false) and decide what to keep.",
      );
    }
    v.note = next === null ? null : next.slice(0, NOTE_CAP);
    v.noteBy = by;
    v.noteAt = Date.now();
    v.noteTruncated = next !== null && next.length > NOTE_CAP;
    noteScoreRun(doc, { what: "note", version: versionId, by, chars: v.note?.length ?? 0,
                        truncated: !!v.noteTruncated });
    return doc;
  }).then((doc) => findVersion(doc, versionId));
}

/**
 * Set the credit — on the document, or on one version.
 *
 * ⚠ IT CANNOT WRITE `by`, and that is asserted rather than merely intended:
 * `by` is only ever written by adoptVersion() from the value the route read out
 * of provenance.actorFrom(req). server/provenance.js:165-174 exists to make
 * fabricating human action impossible; a credit field that could reach `by`
 * would be a way around it that arrived by accident.
 */
export async function setAuthor(slug, author, { versionId = null, by } = {}) {
  if (!by) throw new Error("setAuthor needs `by` — the actor, from the request.");
  const value = author === null || author === undefined ? null : String(author).slice(0, 200);
  return updateScore(slug, (doc) => {
    if (versionId) {
      const v = findVersion(doc, versionId);
      if (!v) throw new Error(`No version "${versionId}" in "${slug}".`);
      v.author = value;
    } else {
      doc.author = value;
    }
    noteScoreRun(doc, { what: "author", version: versionId, by, author: value });
    return doc;
  }).then((doc) => (versionId ? findVersion(doc, versionId) : doc));
}

/** Which version is the one to show. Explicit, never mtime. */
export async function setCurrent(slug, versionId, { by } = {}) {
  return updateScore(slug, (doc) => {
    if (versionId !== null && !findVersion(doc, versionId)) {
      throw new Error(`No version "${versionId}" in "${slug}".`);
    }
    doc.current = versionId;
    noteScoreRun(doc, { what: "current", version: versionId, by: by || "system" });
    return doc;
  });
}

/** Attach an engraved sheet to a version. Written by server/score/sheet.js. */
export async function setSheet(slug, versionId, sheet) {
  return updateScore(slug, (doc) => {
    const v = findVersion(doc, versionId);
    if (!v) throw new Error(`No version "${versionId}" in "${slug}".`);
    v.sheet = sheet;
    noteScoreRun(doc, { what: "sheet", version: versionId,
                        pdf: !!sheet?.pdf, skipped: sheet?.pdfSkipped ?? null });
    return doc;
  }).then((doc) => findVersion(doc, versionId));
}

/* ─────────────────────────────────────── what changed, computed from hashes */

/**
 * WHAT CHANGED BETWEEN TWO VERSIONS — from the hashes, never from a claim.
 *
 * The receipt hashes every artifact, so "the score changed but the audio did
 * not" is a fact about two sha256 strings and not an opinion anybody has to
 * type. A declared change map is the field that says "tempo" when the tempo is
 * the one thing that stayed the same.
 *
 * PURE, and computed on read for server/mv/store.js:276-287's reason: a stored
 * diff goes wrong the moment a version is deleted and there is no migration to
 * write. `identity` is reported separately from the files because it is the
 * vendor's own answer to the same question at a coarser grain — request +
 * config + weights — and the two disagreeing is itself information: same
 * identity with different artifacts means the render is not deterministic.
 */
export function changesBetween(parent, child) {
  if (!parent || !child) return null;
  const a = parent.artifacts || {};
  const b = child.artifacts || {};
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const added = [], removed = [], changed = [], same = [];
  for (const n of names) {
    if (!a[n]) { added.push(n); continue; }
    if (!b[n]) { removed.push(n); continue; }
    (a[n].sha256 === b[n].sha256 ? same : changed).push(n);
  }
  const weightsSame = JSON.stringify(parent.weights ?? null) === JSON.stringify(child.weights ?? null);
  return {
    from: parent.id, to: child.id,
    basis: "sha256 of every artifact in the two receipts",
    added, removed, changed, same,
    /* The interesting three, named because they are the questions a human
     * actually asks of two takes of the same song. */
    scoreChanged: changed.includes("score.abc") || added.includes("score.abc") || removed.includes("score.abc"),
    audioChanged: changed.includes("audio.flac") || added.includes("audio.flac") || removed.includes("audio.flac"),
    requestChanged: changed.includes("request.json"),
    configChanged: changed.includes("config.json"),
    weightsSame,
    identitySame: parent.identity === child.identity,
    /* ⚠ THE CONTRADICTION WORTH SEEING. The identity hash covers
     * request+config+weights; if it matches and the artifacts do not, the same
     * request produced different bytes. That is a sampling nondeterminism
     * finding, not a bookkeeping error, and it would be invisible in a declared
     * change map because nobody would think to declare it. */
    identityContradiction: parent.identity === child.identity && changed.length > 0,
  };
}

/** The version, by the id this store returned. The only lookup that matters. */
export const findVersion = (doc, id) => (doc?.versions || []).find((v) => v.id === id) || null;

/** The version answering to a folded key, or null. Never by identity alone. */
export const findByKey = (doc, key) => (doc?.versions || []).find((v) => v.key === key) || null;

/**
 * The parent chain, oldest first, with the computed change map on each step.
 * Cycle-guarded: a `parent` pointer is data on disk and a hand-edited document
 * can contain a loop, which would otherwise hang the route that renders it.
 */
export function lineage(doc, id) {
  const chain = [];
  const seen = new Set();
  let v = findVersion(doc, id);
  while (v && !seen.has(v.id)) {
    seen.add(v.id);
    chain.unshift(v);
    v = v.parent ? findVersion(doc, v.parent) : null;
  }
  return chain.map((row, i) => ({
    id: row.id, at: row.at, by: row.by, author: row.author, note: row.note,
    label: row.label, identity: row.identity,
    changed: i === 0 ? null : changesBetween(chain[i - 1], row),
  }));
}

/** Direct children of a version. The other direction of the same pointer. */
export const childrenOf = (doc, id) => (doc?.versions || []).filter((v) => v.parent === id).map((v) => v.id);

/** The root this version descends from. Cycle-guarded, same reason as lineage(). */
export function rootOf(doc, id) {
  const seen = new Set();
  let v = findVersion(doc, id);
  while (v && v.parent && !seen.has(v.id)) { seen.add(v.id); v = findVersion(doc, v.parent) || null; }
  return v?.id ?? null;
}

/* ───────────────────────────────────────────────────── listing and reading */

/** Append a run record. Bounded — a breadcrumb trail, not an audit log. */
export function noteScoreRun(doc, entry) {
  doc.runs.unshift({ at: Date.now(), ...entry });
  doc.runs = doc.runs.slice(0, RUN_LIMIT);
  return doc;
}

/**
 * When this score last produced something, as against when it was last poked.
 * Derived, for server/mv/store.js:275-287's reason: `updatedAt` moves when
 * somebody fixes a typo in the credit.
 */
export function lastVersionAt(doc) {
  let at = 0;
  for (const v of doc?.versions || []) if (Number(v.at) > at) at = Number(v.at);
  return at || null;
}

/** Total GPU seconds this score has cost, off the receipts. Derived. */
export function renderSeconds(doc) {
  let s = 0;
  for (const v of doc?.versions || []) if (Number.isFinite(v.timing?.e2eSeconds)) s += v.timing.e2eSeconds;
  return s || null;
}

/**
 * One row per score, for a picker.
 *
 * `renderedAt` is beside `updatedAt` rather than replacing it because they
 * answer different questions and a picker sorted by the wrong one is a picker
 * that hides the song you just rendered.
 */
export async function listScores() {
  let names = [];
  try {
    names = (await readdir(SCORE_DIR(), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const rows = await Promise.all(names.map(async (slug) => {
    const doc = await readScoreDoc(slug);
    if (!doc) return null;
    const current = findVersion(doc, doc.current);
    return {
      slug: doc.slug, id: doc.id, title: doc.title, author: doc.author,
      createdAt: doc.createdAt, updatedAt: doc.updatedAt, renderedAt: lastVersionAt(doc),
      versions: doc.versions.length,
      /* HOW MANY ARE ACTUALLY RELATED. A count of versions says nothing; a
       * count of ROOTS says whether these are takes of one song or a folder
       * somebody dumped renders into — which is exactly what N unrelated rows
       * sorted by mtime could not tell anybody. */
      roots: new Set(doc.versions.map((v) => rootOf(doc, v.id))).size,
      current: doc.current,
      currentAudioSeconds: current?.audioSeconds ?? null,
      sheets: doc.versions.filter((v) => v.sheet?.html).length,
      pdfs: doc.versions.filter((v) => v.sheet?.pdf).length,
      renderSeconds: renderSeconds(doc),
    };
  }));
  return rows.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read one artifact out of a version's vendor folder. Path-safe. */
export async function readArtifact(slug, versionId, name) {
  const s = safeSeg(slug), v = safeSeg(versionId), n = safeSeg(name);
  if (!s || !v || !n) throw new Error("bad artifact path");
  return readFile(path.join(versionDir(s, v), n));
}

/** The score text of a version, as a string. The input to abc.js and sheet.js. */
export async function readScoreAbc(slug, versionId) {
  return (await readArtifact(slug, versionId, "score.abc")).toString("utf8");
}
