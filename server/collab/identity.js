/**
 * Collab — this Studio's own identity, and the twelve words that pin it.
 *
 * Two keypairs live here, generated ONCE per installation and stored beside
 * the rest of the user's settings:
 *
 *   <appData>/collab/identity.json    ed25519 signing pair + x25519 sealing pair
 *
 * The signing pair says "this bundle came from me"; the sealing pair is what a
 * friend encrypts to so that a bundle sitting in a shared inbox is not readable
 * by the inbox. Both are node builtins — `crypto.generateKeyPairSync` — because
 * this app ships Apache-2.0 and runs offline, and a friend-to-friend feature is
 * not worth a supply chain.
 *
 * NEVER AT IMPORT TIME. `identity()` creates the file on its FIRST CALL, which
 * is the first visit to the Collab screen. A module that generated a keypair
 * when it was imported would mint an identity on every boot of every install,
 * including the installs of people who never open the tab, and would write into
 * appData during `node --check`-style tooling and tests.
 *
 * ⚠ REGENERATING IS NOT A REPAIR. The fingerprint below is what every friend
 * pins, reads aloud and stores in their roster. If this file is corrupt or has
 * been edited, the functions here REFUSE — they do not quietly mint a new pair.
 * A silent regeneration would change the fingerprint under a peer who had
 * already verified it, and the failure would surface days later as "their
 * bundles stopped opening" rather than as "your identity file is damaged".
 *
 * WHAT THE FINGERPRINT COVERS AND WHY IT IS 16 BYTES. `fingerprint()` hashes
 * BOTH SPKIs, concatenated, so a swapped sealing key produces a different
 * fingerprint and cannot hide behind a signing key somebody already verified.
 * That only holds because both halves are pinned to exactly 44 bytes of the
 * right algorithm — see the warning sign on `spki()`, which is the check doing
 * the work, and which a re-cut of the same 88 bytes defeats the moment it goes.
 * 16 bytes because a keypair-plus-hash costs 0.3440 ms on this machine
 * (measured 2026-09-20, win32, node v22.15.0, 500 iterations, single thread) —
 * at ~2,900 tries per second a targeted 32-bit fingerprint is an afternoon on
 * rented cores, 2^64 is out of reach and 2^128 is not a number.
 *
 * WHAT IS MEASURED HERE, AND WHAT IS NOT. Measured on this machine on
 * 2026-09-20: the 0.3440 ms above; ed25519 and x25519 SPKI are 44 bytes each,
 * 60 base64 characters; `icacls` takes 21 ms and leaves exactly one ACE; the
 * explicit ACL SURVIVES the rename (see `protect`). NOT measured: anything
 * about how this behaves on macOS or Linux — the posix branch has never been
 * run by anyone here, and that is why it reports which branch ran rather than
 * claiming the file is protected.
 */
import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";

/* ──────────────────────────────────────────────────────────── the wordlist */

/**
 * 256 words: one per byte, so twelve of them carry the 96 bits that the first
 * twelve bytes of a fingerprint carry, and the full 32-hex form carries 128.
 * The twelve are for reading down a phone line to a friend who reads theirs
 * back; the hex is for logs, where a human is not the reader.
 *
 * The constraints are about the pen and, in one case, the ear — not entropy:
 *
 *  · 3-7 letters, so nobody trails off halfway through saying one.
 *  · NO TWO WORDS SHARE THEIR FIRST THREE LETTERS, verified: 256 words, 256
 *    distinct prefixes. This is a SPELLING rule, and what it buys is that a
 *    typed prefix is unambiguous if this list ever gets an input box.
 *  · No homophones anywhere in the list, and no word that is the plural of
 *    another, because both are indistinguishable out loud — which is the only
 *    channel this list exists for.
 *  · Words with a shape a person can hold: "velvet" survives a bad line,
 *    "various" does not. NOT all concrete nouns — thirteen entries are not
 *    (`dawn`, `echo`, `edge`, `frost`, `green`, `north`, `purple`, `shadow`,
 *    `smoke`, `spiral`, `sunset`, `yellow`, `zenith`) and they stay, because
 *    the list is frozen. The rule to apply to a future vocabulary is the one
 *    above, not "noun".
 *
 * ⚠ THE PREFIX RULE IS NOT A PHONETIC RULE, and this comment used to claim it
 * was — that a listener who half-hears "cop…" cannot land on "copper" when you
 * said "coral". Distinct spellings do not make two words audibly separable, and
 * this list contains exactly the triples that claim would have excluded:
 * copper/coral, bacon/badge/bagel, cabin/cactus, tomato/topaz. Anyone relying on
 * the ear over a bad line is relying on something that was never measured here.
 * The PGP biometric word list dismissed below WAS built from measured phonetic
 * distance; if the ceremony ever needs that property, it is a new vocabulary
 * behind a new card prefix, not an edit to this one.
 *
 * ⚠ THIS LIST IS FROZEN. Reordering it, or replacing a single word, changes
 * the twelve words every existing identity reads aloud while leaving its
 * fingerprint identical — so a friend who verified you last week would hear a
 * different phrase from the same key and reasonably conclude they were being
 * attacked. If a word must change, the vocabulary gets a version and the card
 * format gets a new prefix; it does not get edited in place.
 *
 * Deliberately NOT the PGP biometric word list, which is public domain and
 * would have done, but whose entries run to eleven letters ("unanimous",
 * "sensation") and whose two alternating halves are an extra rule a person on
 * a phone has to be taught. This one has a single rule: say the words.
 */
export const WORDLIST = [
  "acorn", "adobe", "agate", "album", "amber", "anchor", "apple", "arch",
  "ash", "atlas", "avocado", "axle", "bacon", "badge", "bagel", "bamboo",
  "barn", "basil", "bean", "bell", "bench", "bison", "blade", "boat",
  "bolt", "brick", "bronze", "brush", "bucket", "bugle", "cabin", "cactus",
  "camel", "candle", "carrot", "castle", "cave", "cedar", "chalk", "cherry",
  "chisel", "cinder", "clover", "cobalt", "cocoa", "comet", "copper", "coral",
  "cricket", "crown", "cube", "curtain", "dagger", "daisy", "dawn", "delta",
  "denim", "diamond", "dolphin", "donkey", "dragon", "drum", "eagle", "earth",
  "echo", "edge", "elbow", "ember", "emerald", "engine", "fabric", "falcon",
  "feather", "fern", "fiddle", "finch", "flame", "flint", "forest", "fossil",
  "fox", "frost", "fuel", "garden", "gecko", "ginger", "glacier", "globe",
  "gold", "goose", "granite", "green", "guitar", "hammer", "harbour", "hazel",
  "hedge", "helmet", "herb", "hill", "hollow", "honey", "horse", "iceberg",
  "igloo", "ink", "iris", "iron", "ivory", "jacket", "jade", "jasmine",
  "jelly", "jigsaw", "jungle", "kayak", "kettle", "kilt", "kitten", "koala",
  "krill", "ladder", "lagoon", "lamp", "lantern", "lava", "leaf", "lemon",
  "lily", "linen", "lobster", "magnet", "mango", "maple", "marble", "meadow",
  "melon", "metal", "mint", "mirror", "monkey", "moss", "mouse", "nectar",
  // ⚠ "oasis" before "oak" is the list's ONE alphabetical inversion (machine-
  // checked: 256 entries, exactly one). It is deliberate and it stays. The list
  // reads as sorted everywhere else, which is an invitation to "tidy" it with a
  // sort() — and a sort would re-map every byte, changing the twelve words every
  // existing identity reads aloud while leaving its fingerprint identical. That
  // is the exact disaster the frozen-list warning above describes: a friend who
  // verified you last week hears a different phrase from the same key. Index is
  // the contract here; alphabetical order is not.
  "needle", "nest", "nickel", "noodle", "north", "nutmeg", "oasis", "oak",
  "ocean", "olive", "onion", "opal", "orbit", "otter", "owl", "oyster",
  "paddle", "palm", "panda", "paper", "parrot", "peach", "pebble", "pepper",
  "piano", "pigeon", "pillow", "pine", "planet", "pocket", "pond", "poppy",
  "potato", "prism", "pumpkin", "purple", "quartz", "quilt", "rabbit", "radish",
  "raft", "ranch", "raven", "ribbon", "river", "robin", "rocket", "ruby",
  "saddle", "salmon", "sand", "sardine", "scarf", "shadow", "shelf", "shovel",
  "silver", "slate", "smoke", "snow", "sofa", "spark", "spiral", "statue",
  "stone", "sugar", "sunset", "syrup", "table", "tadpole", "tango", "teapot",
  "temple", "tennis", "thimble", "thunder", "tiger", "timber", "toast", "tomato",
  "topaz", "tractor", "tulip", "turtle", "ukulele", "unicorn", "urchin", "utensil",
  "valley", "vanilla", "velvet", "vessel", "violet", "volcano", "waffle", "wagon",
  "walnut", "wasp", "water", "weasel", "wheat", "willow", "window", "wolf",
  "yacht", "yarn", "yellow", "yogurt", "zebra", "zenith", "zigzag", "zinc",
];

/* ─────────────────────────────────────────────────────── refusals and paths */

/**
 * Every refusal in this module carries a `reason` a caller can branch on and a
 * `message` that is a full sentence telling a human what to do next. The screen
 * shows the message; the route switches on the reason. Neither one is derived
 * from the other, because a UI that string-matches an error message breaks the
 * first time somebody improves the wording.
 */
const REFUSAL = Symbol("aiplay.collab.refusal");

/* ⚠ `err.reason` IS NOT A RELIABLE MARK OF OUR OWN REFUSALS, AND THAT IS WHY
 * THIS BRAND EXISTS. Node's OpenSSL errors carry a `reason` of their own —
 * a private key that is a string but not a parseable PEM comes back as
 * `reason: "unsupported"`, measured on v22.15.0 — so any `if (err.reason) throw
 * err` treats an OpenSSL failure as a refusal this module built and lets it out
 * with a reason string no caller has a branch for. Test the brand, never the
 * field. */
function refuse(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  err[REFUSAL] = true;
  return err;
}

/** True only for a refusal `refuse()` built. See the warning above it. */
const isRefusal = (err) => !!(err && err[REFUSAL]);

/** Where identity.json lives. `appData` is injectable so tests never touch the
 *  real user's keys; unset, it is the same folder settings.json comes from. */
const collabDir = (appData) => path.join(appData || config.paths.appData, "collab");
const identityFile = (appData) => path.join(collabDir(appData), "identity.json");

/**
 * One in-flight creation per file path.
 *
 * ⚠ Two browser tabs opening the Collab screen at the same moment call this
 * within milliseconds of each other. Without this map both generate a keypair,
 * both rename over the same path, and the tab that lost the race is left
 * displaying twelve words for a private key that is no longer on disk — a
 * fingerprint the user may already have read aloud. The map makes the second
 * caller await the first one's file instead of minting a rival identity.
 */
const creating = new Map();

/* ───────────────────────────────────────────────────────── the file at rest */

/**
 * Lock the file down, and report WHICH mechanism actually ran rather than
 * claiming the file is safe.
 *
 * ⚠ `chmod` IS A LIE ON WINDOWS. Measured on this machine 2026-09-20:
 * `fs.chmod(file, 0o600)` on win32 leaves node reporting mode `666`, and leaves
 * the inherited ACEs — including a group-writable one — exactly where they
 * were. Believing the chmod return value is how a private key ends up readable
 * by every account on the box while the code that wrote it looks correct.
 * So win32 goes through `icacls /inheritance:r /grant:r <user>:F`: measured at
 * 21 ms, after which the file has exactly one ACE, `SENZUBEAN\chesy:(F)`, and
 * node STILL reports `666` — which is the proof that the mode bit carries no
 * signal here and must not be tested.
 *
 * Also measured: the single explicit ACE SURVIVES the rename below, because the
 * temp file and the final file are in the same directory and Windows does not
 * re-apply inheritance to a move within a directory. That is why it is safe to
 * lock the temp file and rename afterwards.
 *
 * Returns "icacls", "chmod-0600" or "unprotected". "unprotected" is not an
 * error: the identity is still usable and the user may be on a single-account
 * machine where it does not matter. It is reported so the Collab screen can say
 * so out loud instead of implying a protection that did not happen.
 */
async function protect(file) {
  if (process.platform === "win32") {
    // ⚠ `os.userInfo()` THROWS rather than returning null when the account has
    // no passwd entry the runtime can read — a service account, a container, a
    // roaming profile that failed to load. It used to sit outside this try, so
    // that throw escaped `protect`, escaped `createIdentity`, and arrived at the
    // route as a raw SystemError with no `reason` on it. The whole point of this
    // function is that it REPORTS what happened instead of failing: an identity
    // this machine could not lock is still a usable identity, and the Collab
    // screen says so out loud.
    let who;
    try {
      who = os.userInfo().username || process.env.USERNAME;
    } catch {
      who = process.env.USERNAME;
    }
    if (!who) return "unprotected";
    try {
      // execFileSync, not exec: the path can contain spaces and a shell would
      // need quoting rules that differ between cmd and PowerShell. It is
      // synchronous because it runs exactly once per installation, for 21 ms.
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${who}:F`], { stdio: "pipe" });
      return "icacls";
    } catch {
      return "unprotected";
    }
  }
  try {
    await chmod(file, 0o600);
    return "chmod-0600";
  } catch {
    return "unprotected";
  }
}

/** The shape stored on disk. The private keys are PKCS#8 PEM (119 bytes for
 *  ed25519, measured) because PEM survives a JSON round-trip unambiguously and
 *  is what `createPrivateKey` takes back without a type hint. */
function newRecord(protectedBy) {
  const signPair = generateKeyPairSync("ed25519");
  const sealPair = generateKeyPairSync("x25519");
  const signPublic = signPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const sealPublic = sealPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return {
    v: 1,
    fp: fingerprint(signPublic, sealPublic),
    createdAt: Date.now(),
    protectedBy,
    sign: {
      public: signPublic,
      private: signPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    seal: {
      public: sealPublic,
      private: sealPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
  };
}

/**
 * Create → lock → fill → rename, in that order and for that reason.
 *
 * ⚠ The temp file is created EMPTY and locked BEFORE the private keys are
 * written into it. Writing the keys first and locking afterwards leaves a
 * window — however short — in which a PKCS#8 private key sits on disk under the
 * directory's inherited ACL, readable by anything that happened to be looking.
 * The window is small; it is also free to close, and a key that leaked once has
 * leaked forever.
 *
 * The rename is the same write-temp-then-rename the project store uses
 * (`server/mv/store.js:202-209`): a crash halfway through a write must not
 * leave a truncated identity.json, because a truncated one is unrecoverable —
 * there is no second copy of a private key anywhere.
 *
 * ⚠ EVERY FAILURE LEAVES HERE AS A `bad-identity` REFUSAL. It used to leave as
 * whatever `mkdir`/`writeFile`/`rename` threw: a raw `EACCES`, `EPERM`, `ENOSPC`
 * or `EEXIST` with no `reason` property at all. `identity()` documents the
 * reasons a caller may branch on, and a route switching on `err.reason` got
 * `undefined` for the entire disk-failure family — which is the family most
 * likely to actually happen on a user's machine, and the one where the message
 * on screen decides whether they fix it or file a bug. The original error's
 * `code` and text are carried through, so the log still says which syscall died.
 */
async function createIdentity(file) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    // The mode argument is honoured on posix and ignored on win32; `protect`
    // is what actually does the work on both, and says which.
    await writeFile(tmp, "", { mode: 0o600 });
    const protectedBy = await protect(tmp);
    const record = newRecord(protectedBy);
    await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await rename(tmp, file);
    return record;
  } catch (err) {
    // A half-written temp file holding key material is worse than no file.
    await rm(tmp, { force: true }).catch(() => {});
    if (isRefusal(err)) throw err;
    const refusal = refuse("bad-identity", `Your Collab identity could not be written to ${file}: ${err && err.message ? err.message : String(err)}. Nothing was saved and no key was kept. Check that the folder exists, that this account can write to it and that the disk is not full, then reopen the Collab screen.`);
    if (err && err.code) refusal.code = err.code;
    refusal.cause = err;
    throw refusal;
  }
}

/** Read and validate what is on disk. Returns null when there is no identity
 *  yet; throws when there is one and it is wrong. */
async function readRecord(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw refuse("bad-identity", `Your Collab identity at ${file} could not be read: ${err.message}. Fix the permissions on that file, or move it aside and the Collab screen will create a new identity — but every friend will have to verify your twelve words again.`);
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    throw refuse("bad-identity", `Your Collab identity at ${file} is not valid JSON. Do not delete it: move it aside first, in case the private keys inside it can still be recovered by hand. A new identity will change your fingerprint and every friend will have to verify your twelve words again.`);
  }
  const ok = rec && typeof rec === "object"
    && rec.sign && rec.seal
    && typeof rec.sign.public === "string" && typeof rec.sign.private === "string"
    && typeof rec.seal.public === "string" && typeof rec.seal.private === "string";
  if (!ok) {
    throw refuse("bad-identity", `Your Collab identity at ${file} is missing its keys. Move the file aside and reopen the Collab screen to create a new identity; your friends will each have to verify the new twelve words.`);
  }
  // ⚠ Recomputed on EVERY read, never trusted from the file. The stored `fp` is
  // just a cache of a hash over the two keys sitting next to it; if somebody
  // edited the sealing key in place — the exact attack the two-key fingerprint
  // exists to catch — the stored value would still be the one the user read
  // aloud last week, and the mismatch is the only place it shows.
  const computed = fingerprint(rec.sign.public, rec.seal.public);
  if (rec.fp !== computed) {
    throw refuse("fingerprint-mismatch", `Your Collab identity at ${file} has been edited: its stored fingerprint ${rec.fp} does not match the keys in the same file, which hash to ${computed}. Nothing was loaded. Move the file aside and create a new identity, and tell anyone who has verified you that the old fingerprint is no longer yours.`);
  }
  return rec;
}

/** What leaves this module. The private keys never appear here — `privateKeys`
 *  is the only door to those, and `seal.js` is the only caller it has. */
const publicView = (rec) => ({
  fp: rec.fp,
  signPublic: rec.sign.public,
  sealPublic: rec.seal.public,
  createdAt: rec.createdAt,
  protectedBy: rec.protectedBy,
});

/* ───────────────────────────────────────────────────────────── the exports */

/**
 * This Studio's identity, creating it on the first call.
 *
 * Returns { fp, signPublic, sealPublic, createdAt, protectedBy } with the two
 * publics as base64 SPKI DER — 60 characters each, measured — and never the
 * private keys.
 *
 * Measured 2026-09-20 on this machine: the first call takes 27 ms end to end
 * and writes a 583-byte file; almost all of that is the 21 ms `icacls`, not the
 * 0.344 ms of key generation. Later calls are a read.
 *
 * Refusals: `bad-identity` (unreadable, not JSON, missing its keys, or the write
 * failed — a full disk and a denied folder both arrive here) and
 * `fingerprint-mismatch` (the file was edited). There is no path out of this
 * function that throws without a `reason`.
 */
export async function identity({ appData } = {}) {
  const file = identityFile(appData);
  const existing = await readRecord(file);
  if (existing) return publicView(existing);

  const inFlight = creating.get(file);
  if (inFlight) return publicView(await inFlight);

  const job = createIdentity(file);
  creating.set(file, job);
  try {
    return publicView(await job);
  } finally {
    creating.delete(file);
  }
}

/**
 * The private halves, as KeyObjects, for `seal.js` and for nothing else.
 *
 * Separated from `identity()` so that the object the routes serialise to the
 * browser CANNOT contain a private key by accident. A single shape carrying
 * both would only have to be spread into a JSON response once — by anybody, at
 * any point in the next year — to publish the key over HTTP, and no reviewer
 * catches every spread.
 *
 * This does NOT create an identity: a caller that wants to sign something when
 * there is nothing to sign with has a bug, and minting a key here would hide
 * it.
 *
 * Refusals: `no-identity` when there is no file, plus `bad-identity` and
 * `fingerprint-mismatch` straight through from the same read `identity()` does —
 * a caller that only handles `no-identity` will still meet the other two.
 * `bad-identity` also covers the case this function alone can reach: intact
 * public keys beside private keys that will not parse. See the note on the try
 * below for why that is not left to escape as whatever OpenSSL called it.
 */
export async function privateKeys({ appData } = {}) {
  const file = identityFile(appData);
  const rec = await readRecord(file);
  if (!rec) {
    throw refuse("no-identity", "This Studio has no Collab identity yet, so there is nothing to sign or unseal with. Open the Collab screen once to create one, then try again.");
  }
  /* ⚠ THE FINGERPRINT DOES NOT COVER THE PRIVATE HALVES, so a file whose
   * public keys are intact and whose private keys are damaged reaches this line
   * having passed every check above it. Unwrapped, `createPrivateKey` then
   * throws an OpenSSL error carrying `reason: "unsupported"` — a string shaped
   * exactly like one of ours and matching none of the three this function
   * documents, so a route branching on `err.reason` falls through to its
   * unknown-error arm and tells the user nothing. */
  try {
    return {
      signPrivate: createPrivateKey(rec.sign.private),
      sealPrivate: createPrivateKey(rec.seal.private),
    };
  } catch (err) {
    if (isRefusal(err)) throw err;
    const refusal = refuse("bad-identity", `Your Collab identity at ${file} has public keys that read correctly and private keys that do not: ${err && err.message ? err.message : String(err)}. Nothing can be signed or unsealed with it. Move the file aside and the Collab screen will create a new identity — but every friend will have to verify your twelve words again.`);
    if (err && err.code) refusal.code = err.code;
    refusal.cause = err;
    throw refusal;
  }
}

/**
 * The exact bytes each slot of a key card is allowed to hold.
 *
 * An ed25519 SPKI and an x25519 SPKI are both exactly 44 bytes: a 12-byte DER
 * header carrying the algorithm OID, then the 32-byte key. The two headers
 * differ in one byte — `…2b6570` is ed25519, `…2b656e` is x25519 — and that
 * byte is the only thing in the encoding that says which algorithm the key is
 * for. Measured on this machine 2026-09-20, node v22.15.0.
 */
const SPKI_SHAPE = {
  signing: { algorithm: "ed25519", header: Buffer.from("302a300506032b6570032100", "hex") },
  sealing: { algorithm: "x25519", header: Buffer.from("302a300506032b656e032100", "hex") },
};

/**
 * Decode one base64 SPKI and refuse anything that is not EXACTLY one: 44 bytes,
 * carrying the algorithm header this slot requires. `which` names the key in the
 * message, because "bad key" on a screen showing two keys is not an instruction.
 *
 * ⚠ THE LENGTH CHECK IS WHAT MAKES THE FINGERPRINT A COMMITMENT. It is not a
 * tidiness rule and it must not be loosened back to a minimum. `fingerprint()`
 * hashes `sign ‖ seal` with no length prefix and no separator, so if the two
 * halves may vary in length the split point is not covered by the digest: take a
 * victim's real 44+44 card, re-cut the same 88 bytes at 45/43, and the hash is
 * bit-for-bit identical. Built and measured against a freshly generated pair on
 * 2026-09-20: TWENTY-FOUR forged cards per victim (cuts 32…56), each carrying
 * different `sign`/`seal` strings, each producing the victim's exact fingerprint
 * and therefore the victim's exact twelve words — accepted by both `keyCard` and
 * `readKeyCard`. That defeats the one property the header of this file and the
 * comment on `fingerprint()` both promise. Mallory pastes "Bob, new laptop" into
 * Alice's Collab screen, the roster keys on `fp` and finds Bob's already-VERIFIED
 * row, and the symptom surfaces days later as "Bob's bundles stopped opening".
 * Pinning both halves to 44 bytes makes the split point implicit in the length
 * and closes it; a length-prefixed hash would do the same job, but the keys are
 * fixed-width, so the cheaper check is the honest one.
 *
 * ⚠ THE HEADER CHECK IS THE SECOND HALF OF THE SAME HOLE. Without it any 44-byte
 * blob is "a key": `fingerprint(X, X)` with the sealing key in both slots
 * returned a fingerprint happily, as did the two keys swapped between slots, as
 * did 32 bytes of 0x07 under a hand-written header. Each of those is a distinct
 * identity on the roster that no human could have read aloud correctly, and the
 * first one only fails much later, inside `crypto.verify`, as an unhelpful throw.
 */
function spki(b64, which) {
  if (typeof b64 !== "string" || !b64.trim()) {
    throw refuse("bad-key", `The ${which} key is missing. A key card carries both a signing key and a sealing key; ask your friend to copy the whole line again.`);
  }
  const shape = SPKI_SHAPE[which];
  if (!shape) {
    throw refuse("bad-key", `Internal: "${which}" is not a key slot on an AIPLAY key card. The slots are "signing" and "sealing", and each one accepts only its own algorithm.`);
  }
  const clean = b64.trim();
  const buf = Buffer.from(clean, "base64");
  // Buffer.from silently skips characters outside the base64 alphabet, so a
  // mangled key decodes to something shorter rather than failing. Re-encoding
  // and comparing is what turns that silence into a refusal.
  if (buf.length !== 44 || buf.toString("base64") !== clean) {
    throw refuse("bad-key", `The ${which} key is not a valid public key: a key card carries exactly 60 base64 characters per key, and this one decodes to ${buf.length} bytes instead of 44. It was probably broken across two lines by an email client, or cut short; ask your friend to send the key card as one unbroken line.`);
  }
  if (!buf.subarray(0, shape.header.length).equals(shape.header)) {
    throw refuse("bad-key", `The ${which} key is the wrong kind of key: that slot on a key card holds an ${shape.algorithm} key, and this one is not. A card whose two keys are swapped, or repeated, is not a card any Collab screen wrote — ask your friend to copy theirs again with the Copy button.`);
  }
  return buf;
}

/**
 * The 128-bit fingerprint: sha256 over BOTH SPKIs concatenated, first 16 bytes,
 * lowercase hex, 32 characters.
 *
 * ⚠ BOTH, in that order, and the order is part of the format. Hashing only the
 * signing key would let an attacker who intercepts a key card keep the real
 * signing key — so the fingerprint the two humans read aloud still matches —
 * while substituting their own SEALING key, and every bundle sealed to that
 * fingerprint afterwards would open on the attacker's machine. The twelve words
 * would have verified nothing. Binding the sealing key into the same hash is
 * the entire reason the ceremony is worth doing.
 *
 * ⚠ THAT BINDING ONLY HOLDS BECAUSE `spki()` PINS BOTH HALVES TO 44 BYTES. The
 * concatenation below has no length prefix and no separator, so variable-length
 * halves would leave the split point outside the digest and the same 88 bytes
 * could be re-cut into a different pair of "keys" with the same fingerprint. The
 * warning sign is on `spki()`, where the check lives; do not read this function
 * as safe on its own.
 */
export function fingerprint(signPublicB64, sealPublicB64) {
  const sign = spki(signPublicB64, "signing");
  const seal = spki(sealPublicB64, "sealing");
  return createHash("sha256").update(sign).update(seal).digest("hex").slice(0, 32);
}

/**
 * Twelve words for one fingerprint: one word per byte of the first twelve
 * bytes, in order.
 *
 * Twelve of sixteen bytes, so 96 bits are read aloud and the other 32 stay in
 * the hex form. The point of the ceremony is that a man in the middle must
 * produce a key whose fingerprint STARTS the same way; at 96 bits that is not
 * an afternoon on rented cores, and asking two humans to recite sixteen words
 * instead of twelve buys nothing anyone can spend.
 *
 * Refuses with `bad-fingerprint`.
 */
export function words(fp) {
  const hex = String(fp ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw refuse("bad-fingerprint", "A fingerprint is exactly 32 hexadecimal characters. Paste the whole fingerprint from your friend's key card, without the AIPLAY1 prefix and without spaces.");
  }
  const bytes = Buffer.from(hex, "hex");
  const out = [];
  for (let i = 0; i < 12; i++) out.push(WORDLIST[bytes[i]]);
  return out;
}

/** A nickname is a LABEL THE READER TYPED, never a proof of anything, so the
 *  only rules are the ones the format needs: one line, and no colon, because
 *  the colon is the field separator. 40 characters because the card is meant to
 *  be pasted into a chat window without wrapping. */
function cleanNickname(nickname) {
  const name = String(nickname ?? "").trim();
  if (!name) return "";
  if (name.includes(":") || /[\r\n]/.test(name)) {
    throw refuse("bad-nickname", "A nickname on a key card cannot contain a colon or a line break, because the colon separates the fields of the card. Choose a name without one.");
  }
  if (name.length > 40) {
    throw refuse("bad-nickname", "A nickname on a key card is at most 40 characters. Shorten it and export the card again.");
  }
  return name;
}

/**
 * The key card: one line, five colon-separated fields.
 *
 *   AIPLAY1:<32 hex fp>:<60-char sign spki>:<60-char seal spki>:<nickname>
 *
 * 163 characters plus the nickname (measured: the prefix is 8, the fingerprint
 * 32, each base64 SPKI 60, three separators). One line because it has to
 * survive being pasted into a chat window, and base64 has no colon in its
 * alphabet so the split is unambiguous.
 *
 * ⚠ THE CARD IS NOT A SECRET AND IT IS NOT A PROOF. It is two public keys and a
 * name someone typed. Anyone can make one claiming to be anyone. The only thing
 * that turns a card into an identity is two people reading the twelve words to
 * each other on a channel an attacker cannot control at the same moment — which
 * is what `roster.markVerified` records, and why a card arriving by email starts
 * unverified.
 *
 * Refuses with `bad-key`, `bad-fingerprint` or `bad-nickname`.
 */
export function keyCard({ fp, signPublic, sealPublic, nickname }) {
  const sign = spki(signPublic, "signing").toString("base64");
  const seal = spki(sealPublic, "sealing").toString("base64");
  const computed = fingerprint(sign, seal);
  const given = String(fp ?? "").trim().toLowerCase();
  if (given && given !== computed) {
    throw refuse("bad-fingerprint", `This card would claim fingerprint ${given} for keys that hash to ${computed}. No card was written. Export the card from the identity that owns those keys.`);
  }
  return ["AIPLAY1", computed, sign, seal, cleanNickname(nickname)].join(":");
}

/**
 * Read a key card back, recomputing the fingerprint rather than believing it.
 *
 * ⚠ The fingerprint on the card is CHECKED AGAINST THE KEYS, not trusted. It is
 * on the card only so a human can compare it to the one on the sender's screen
 * without running anything. A card whose fingerprint disagrees with its own keys
 * is refused outright rather than silently corrected, because the fingerprint is
 * the half a person reads aloud and the keys are the half a machine uses: if
 * they disagree, the ceremony would verify one thing while the software used
 * another, and that gap is the whole attack.
 *
 * Whitespace is stripped from the three machine fields, because a 163-character
 * line pasted through an email client comes back wrapped. Inside the nickname it
 * is not: a nickname is allowed to contain spaces, and only its two ends are
 * trimmed.
 *
 * ⚠ THE NICKNAME GOES THROUGH THE SAME `cleanNickname` THE EXPORT SIDE USES, so
 * that what this returns is an object `keyCard()` will accept. It did not, and
 * the gap had two edges. A card is found by splitting on `:`, so everything
 * after the last colon rides along in field five — the outer `.trim()` does not
 * stop a two-line paste. Measured before the fix: `readKeyCard(card + "\nsent
 * from my phone")` returned the nickname `"mika\nsent from my phone"`, which
 * `keyCard()` then REFUSED with `bad-nickname` — the round-trip this function's
 * contract promises simply failed — and a 200-character nickname was accepted
 * whole. That string is what lands in the roster and what gets rendered on a
 * screen, so the refusal belongs here, at the door, not at the far end.
 *
 * Refuses with `not-a-key-card`, `bad-key`, `bad-nickname` or
 * `fingerprint-mismatch`.
 */
export function readKeyCard(text) {
  const line = String(text ?? "").trim();
  if (!line) {
    throw refuse("not-a-key-card", "Nothing was pasted. A key card is one line beginning with AIPLAY1, which your friend copies from their own Collab screen.");
  }
  const parts = line.split(":");
  if (parts[0] !== "AIPLAY1") {
    throw refuse("not-a-key-card", "That is not an AIPLAY key card: a card is one line beginning with AIPLAY1. Ask your friend to use the Copy button on their Collab screen rather than retyping it.");
  }
  if (parts.length !== 5) {
    throw refuse("not-a-key-card", `That key card has ${parts.length} fields and a card has exactly five. It was probably cut short or joined to something else in transit; ask your friend to send it again on a line of its own.`);
  }
  const strip = (s) => s.replace(/\s+/g, "");
  const claimed = strip(parts[1]).toLowerCase();
  const signPublic = strip(parts[2]);
  const sealPublic = strip(parts[3]);
  const nickname = cleanNickname(parts[4]);
  const fp = fingerprint(signPublic, sealPublic);
  if (claimed !== fp) {
    throw refuse("fingerprint-mismatch", `This key card claims fingerprint ${claimed}, but its own keys hash to ${fp}. Nothing was added. Treat the card as untrustworthy until your friend reads their fingerprint to you and you have both seen the same one.`);
  }
  return { fp, signPublic, sealPublic, nickname };
}
