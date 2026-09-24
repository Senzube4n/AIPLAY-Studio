/**
 * Collaboration — the roster of people this machine will talk to.
 *
 * One file, `<appData>/collab/roster.json`, holding one row per peer whose key
 * card has been read in. It is the answer to exactly two questions, asked in
 * this order by everything downstream:
 *
 *   1. Do I know who this fingerprint is?        (a row exists, and `verified`)
 *   2. What am I willing to let them do?         (`role`, `lendMinutesPerDay`)
 *
 * WHY A SEPARATE FILE FROM `identity.json`. That file holds this machine's own
 * PRIVATE keys and is clamped to the owner (icacls /inheritance:r on Windows,
 * chmod 0600 elsewhere). This file holds other people's PUBLIC keys and nothing
 * else, so it can be read, copied, backed up and pasted into a bug report
 * without leaking anything. Keeping the two apart means the permission clamp
 * has one job and one file, instead of a roster edit being one wrong `writeFile`
 * away from widening the permissions on a private key.
 *
 * ⚠ WHAT THIS FILE CAN CHECK ABOUT A FINGERPRINT, AND WHAT IT CANNOT.
 * It CAN check, and does (`addPeer`), that a row's `fp` is the hash of that same
 * row's two keys. It CANNOT check whose keys they are. Those are different
 * questions and only the second one needs a human.
 *
 * An earlier version of this header said the first check was impossible here,
 * because `fingerprint()` lives in identity.js and this module imports node
 * builtins and ../config.js only. That was wrong, and expensively so: the hash
 * needs `createHash` and nothing else, so the binding was being dropped at the
 * one point in the chain that stores it. The consequence was precise — the
 * twelve words a human reads aloud are derived from `row.fp`, but the bytes that
 * seal a packet are `row.seal`. A card pairing a real friend's fingerprint with
 * an attacker's sealing key would have passed the ceremony and then encrypted
 * every bundle to the attacker. `addPeer` now recomputes and refuses a mismatch,
 * exactly as identity.js `readKeyCard` does, so the card cannot enter the roster
 * by a side door that skips the parser.
 *
 * What remains, and what the phone call is for: anybody can generate a key pair
 * and hand you a perfectly self-consistent card claiming to be anyone. That is
 * why `verified` starts false, why `setRole` refuses to give an unverified row
 * any power, and why re-adding an existing fingerprint is refused below rather
 * than treated as an update. A silent key swap on an already-verified row would
 * undo the only check in the system that a machine cannot perform for you.
 *
 * ⚠ NEVER WRITE A PRIVATE KEY INTO THIS FILE. `addPeer` refuses a card whose
 * key fields are not public-key DER, and the check is not a formality — see the
 * measurement on SIGN_SPKI_PREFIX below. A roster is the one collaboration file
 * people will cheerfully e-mail to each other when something goes wrong.
 *
 * ⚠ SINGLE WRITER, WITHIN ONE PROCESS ONLY. Every mutation below goes through
 * one promise chain and lands by write-temp-then-fsync-then-rename, exactly as
 * server/mv/store.js does, so a crash mid-write cannot leave a truncated roster
 * and two concurrent HTTP requests cannot lose each other's edit. TWO Studios
 * running against the same appData folder are NOT guarded: the second rename
 * wins and the first edit is gone. That case is unhandled and unmeasured; it is
 * written down here rather than papered over with a lock file that would need
 * its own stale-lock story.
 *
 * ⚠ A ROSTER THAT CANNOT BE READ IS NOT AN EMPTY ROSTER. Every read below
 * refuses rather than returning `[]` on anything but a genuinely absent file.
 * This is a load-bearing distinction and the next person will be tempted to
 * simplify it away: the previous `catch { return []; }` could not tell ENOENT
 * from EACCES, EBUSY (a second Studio or an AV scanner holding the file open —
 * the ordinary Windows case), EMFILE, or one bad character from a hand edit, and
 * `addPeer` would then see zero peers, pass its duplicate check, and rename a
 * one-row file over the top. Every verified peer gone, silently, and the thing
 * destroyed costs a phone call each to rebuild. A transient open failure must
 * fail the call, not empty the file.
 */
import { readFile, rename, mkdir, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

/**
 * What a peer is allowed to be.
 *
 *   "none"          — known, possibly verified, allowed nothing. The state every
 *                     peer starts in, and the state you drop somebody back to
 *                     instead of deleting them, because a removed peer who
 *                     re-sends a card arrives as a fresh unverified row and you
 *                     have to do the phone call again.
 *   "lender"        — may run renders for you on their card. Receives a SHOT
 *                     PACKET (server/collab/packet.js) — one scene's composed
 *                     prompt and its reference images, and nothing else. No
 *                     lyrics, no other scenes, no bibles as fields, no title.
 *   "collaborator"  — receives the whole project document. They are directing
 *                     with you, so they read the script; there is no version of
 *                     collaborating where they render blind.
 *
 * Frozen because this array is the validator for `setRole` and it is exported:
 * one caller splicing or sorting it in place would change what every later call
 * accepts, in a way no test of that caller would ever show.
 */
export const ROLES = Object.freeze(["none", "lender", "collaborator"]);

/** On-disk schema version. Written, never returned — see `roster()`. */
const ROSTER_VERSION = 1;

/** 32 lowercase hex characters: the first 16 bytes of the identity hash. */
const FP_RE = /^[0-9a-f]{32}$/;

/**
 * The base64 SPKI DER a public ed25519 / x25519 key actually starts with.
 *
 * MEASURED on this machine's node with `crypto.generateKeyPairSync`, 2026-09-20:
 * an ed25519 SPKI export is exactly 60 base64 characters beginning
 * "MCowBQYDK2Vw"; an x25519 SPKI export is exactly 60 beginning "MCowBQYDK2Vu".
 * A PKCS#8 PRIVATE key of either type is 64 characters beginning "MC4CAQAwBQYDK2V".
 *
 * So this one prefix test does three jobs at once, which is why it is worth the
 * strictness: it rejects a private key pasted into a card (different prefix and
 * different length), it rejects a card whose signing and sealing keys have been
 * swapped (the two prefixes differ in their last two characters, `Vw` against
 * `Vu`), and it rejects arbitrary text before it can be stored and handed to
 * `crypto.createPublicKey` somewhere further away, where the error would say
 * nothing about a roster.
 *
 * ⚠ If a future card ever carries a different key type, this is the line that
 * will refuse it, and the refusal will name the field. That is intended: a new
 * key type is a decision, not something a roster should absorb quietly.
 */
const SIGN_SPKI_PREFIX = "MCowBQYDK2Vw";   // ed25519, the signing key
const SEAL_SPKI_PREFIX = "MCowBQYDK2Vu";   // x25519, the sealing key
const SPKI_B64_LEN = 60;

/** …and exactly this many DER bytes: a 12-byte header carrying the algorithm
 *  OID, then the 32-byte key. The two constants are not interchangeable — see
 *  `keyBytes` for the gap between them, which was open. */
const SPKI_BYTES = 44;

/** A whole day. Nobody's daily allowance can exceed the day it is measured in. */
const MAX_LEND_MINUTES = 1440;

/**
 * WHAT A FRESHLY PROMOTED LENDER GETS, AND WHY IT IS NOT ZERO.
 *
 * A peer is added with 0 minutes, as the shape below says, and 0 is the right
 * value for an unverified stranger: it is unreachable anyway, because `setRole`
 * refuses to give an unverified row any role but "none".
 *
 * But a row that has just been promoted to "lender" is the opposite case. You
 * read twelve words down a phone line to a person you know, and then chose the
 * word "lender". A lender holding 0 minutes is a lender who is refused at the
 * first lend, with a message about a number nobody knew they had to type — the
 * app promising a capability and then declining to perform it, which is the
 * defect the ceremony above exists to avoid, not one it should introduce.
 *
 * So the promotion transition (from "none" into either lending role, "lender"
 * or "collaborator" — accept admits both) fills in 60 minutes a day when the
 * row is still holding 0. It is bounded, it is per-day, and it is revocable
 * with one call.
 *
 * ⚠ HOW FAR AN EXPLICIT ZERO STICKS, stated exactly, because an earlier draft of
 * this note overclaimed it. `setLendMinutes(0)` on a lender survives re-saving
 * the role "lender" on a row that is already a lender — the fill tests the
 * transition, so that call changes nothing. It does NOT survive a round trip
 * through another role: `lender -> none -> lender` is a fresh promotion and
 * fires the fill again, because `promoting` compares against the previous role
 * and has no memory of a deliberate zero. That is defensible — a re-promotion is
 * a new grant, and a lender you just re-granted with no minutes is the same
 * broken promise the fill exists to prevent — but it is not what "STICKS"
 * sounded like, and a caller who means zero after a re-promotion must say so
 * again. Nothing in the row records that a zero was deliberate; if that
 * distinction ever matters, it needs a field, not a cleverer comparison.
 *
 * ⚠ 60 is a JUDGEMENT, not a measurement. Nothing here has measured what a
 * minute of somebody else's card is worth to a render; accept checks these
 * minutes against timed and estimated renders (lending.js budgetCheck), and
 * sixty is about a dozen 5-second H3 scenes at 1344x768 by the plan's table
 * (4.9 min each at 8 steps), not by a measurement on anybody's card. Treat the
 * number as a starting
 * allowance chosen to be obviously finite, and expect to change it once a real
 * lend has been timed.
 */
const LEND_MINUTES_ON_PROMOTION = 60;

/**
 * A nickname is display text and nothing else — it binds no reference, and two
 * peers may share one. It is bounded and stripped for one reason: this string
 * is rendered on the screen where somebody decides whether to trust a
 * fingerprint, and a nickname carrying a newline could paint a second, invented
 * line under the real one. Control characters go, runs of whitespace collapse,
 * and 64 characters is as much as that line can show anyway.
 */
const NICKNAME_MAX = 64;
const cleanNickname = (v) => String(v ?? "")
  /* Written as escapes, never as literal characters: a control character
   * typed into source is invisible in every diff and in every review. */
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, NICKNAME_MAX);

/**
 * Every refusal in this file is built here, so that all of them carry the same
 * three things: a `reason` a caller can branch on without reading English, a
 * `status` a route can return, and a MESSAGE that is a full sentence saying what
 * to do next. A refusal that only says "invalid" sends the person who hit it
 * back into the source.
 */
function refuse(reason, message, status = 400) {
  const e = new Error(message);
  e.reason = reason;
  e.status = status;
  return e;
}

/**
 * One key field of a card, refused with a message that names the ACTUAL defect.
 *
 * ⚠ THE FIRST VERSION OF THIS CHECK TOLD THE WRONG STORY, and it is worth
 * recording because the code was correct while the sentence was not. Both key
 * fields were tested against their own prefix, and the signing field's refusal
 * said "if it starts MC4CAQ it is a private key". Feeding it a card whose two
 * keys had been SWAPPED — an ordinary copy-and-paste slip, and the one a person
 * assembling a card by hand is most likely to make — produced that private-key
 * sentence, sending them to look for a problem they did not have. A refusal
 * whose reason code is right and whose sentence is wrong costs more time than
 * no sentence at all, because it is believed.
 */
function checkKey(which, value, want, other, algorithm) {
  if (value.startsWith(want) && value.length === SPKI_B64_LEN) return;
  if (value.startsWith(other)) {
    throw refuse("bad-card", `That card's ${which} key is the wrong kind: the signing and sealing keys look swapped. Ask your friend for the card their Studio printed rather than one assembled by hand.`);
  }
  if (value.startsWith("MC4CAQ")) {
    throw refuse("bad-card", `That card's ${which} key is a PRIVATE key, which must never leave the machine that made it. Tell your friend at once, and ask them for the card their Studio printed.`);
  }
  throw refuse("bad-card", `That card's ${which} key is not a public ${algorithm} key (${SPKI_B64_LEN} base64 characters). Ask for the card again — one that has been through a chat window is often missing a character or wrapped onto two lines.`);
}

/**
 * The key's DER bytes, for the fingerprint check below.
 *
 * ⚠ THE RE-ENCODE IS NOT DECORATION. `Buffer.from(s, "base64")` silently skips
 * every character outside the base64 alphabet, so a key of the right length and
 * the right prefix but with punctuation in the middle decodes SHORT instead of
 * failing, and would then be hashed and stored as those short bytes. Encoding
 * the result back and comparing is what turns that silence into a refusal. This
 * is the same guard identity.js `spki()` applies, for the same reason.
 */
function keyBytes(which, value) {
  const buf = Buffer.from(value, "base64");
  /* ⚠ THE BYTE LENGTH IS CHECKED HERE AND NOT ONLY IN CHARACTERS, because 60
   * base64 characters is 43, 44 or 45 bytes and all three round-trip cleanly.
   * Without this clause the comment below — that the split point is fixed
   * before the hash sees it — was untrue on exactly the hand-built-object door
   * this function guards, and a row could be stored whose keys would throw out
   * of createPublicKey later, in seal.js, with no roster-shaped reason. */
  if (buf.length !== SPKI_BYTES || buf.toString("base64") !== value) {
    throw refuse("bad-card", `That card's ${which} key is the right length but is not valid base64 — some of its characters are not part of a key. Ask for the card again, copied with the Copy button on your friend's Collab screen.`);
  }
  return buf;
}

/**
 * The fingerprint these two keys hash to: sha256 over both SPKIs in the order
 * signing-then-sealing, first 16 bytes, lowercase hex.
 *
 * ⚠ THIS IS A SECOND COPY OF identity.js `fingerprint()` AND MUST STAY BYTE
 * IDENTICAL TO IT. Copying a security primitive is a hazard, and it is taken
 * deliberately: roster.js imports node builtins and ../config.js only, so that
 * the roster stays readable by tools with no business near key material, and the
 * alternative to this copy was the hole described in the file header — the row
 * storing a fingerprint that is not the hash of the row's own keys. If you
 * change the hash, the order, or the 16-byte truncation in identity.js, change
 * it here in the same commit or every existing peer stops being addable.
 *
 * The concatenation carries no length prefix, which would be a collision if the
 * two inputs could vary in length. They cannot get here: `checkKey` has already
 * pinned both fields to exactly SPKI_BYTES (44) DER bytes each — the character
 * count alone does not, since 60 base64 characters decode to 43, 44 or 45 — so
 * the split point is fixed before the hash sees the bytes.
 */
function fingerprintOf(signBytes, sealBytes) {
  return createHash("sha256").update(signBytes).update(sealBytes).digest("hex").slice(0, 32);
}

const collabDir = (appData) => path.join(appData || config.dataDir, "collab");
const rosterPath = (appData) => path.join(collabDir(appData), "roster.json");

/* ───────────────────────────────────────────── the single-writer queue */

/**
 * One chain for the whole module, not one per file, because there IS one file.
 * The chain must not break on a rejection or every later write is silently
 * dropped — the caller still sees its own error. Same construction and same
 * reasoning as server/mv/store.js `enqueue()`.
 */
let chain = Promise.resolve();
function enqueue(fn) {
  const next = chain.then(fn, fn);
  chain = next.then(() => {}, () => {});
  return next;
}

/**
 * An ABSENT file reads as an empty roster. Nothing else does.
 *
 * ⚠ THE `catch { return []; }` THIS REPLACED WAS A DATA-LOSS BUG, and anyone
 * shortening it back will reintroduce one. See the header note. The rule is:
 * ENOENT is the only failure that means "no peers yet". A file that exists and
 * cannot be opened, or opens and does not parse, or parses into something that
 * is not a roster, is a REFUSAL — because the very next thing every caller does
 * is hand this array to `savePeers`, and an array that is empty for the wrong
 * reason is a rename that destroys the file it failed to read.
 *
 * The same reasoning covers a row that is not an object: the old code filtered
 * those out, which reads as tidiness but is the identical trap one row down —
 * load, drop, save, and the hand edit that produced the bad row has taken the
 * good rows with it. Refuse and let a person look at the file.
 */
async function loadPeers(appData) {
  const file = rosterPath(appData);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw refuse("roster-unreadable", `This machine's roster (${file}) exists but could not be read (${err?.code || err?.message}). Nothing was changed. On Windows this is usually a second Studio or a virus scanner holding the file open — close the other Studio and try again.`, 500);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw refuse("roster-unreadable", `This machine's roster (${file}) is not readable JSON (${err?.message}). Nothing was changed, and nothing will be written until it parses, so your peers are still in that file. Open it in a text editor and fix it, or move it aside to start a fresh roster.`, 500);
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.peers)) {
    throw refuse("roster-unreadable", `This machine's roster (${file}) parsed but has no "peers" list, so it is not a roster. Nothing was changed. Move it aside to start a fresh roster.`, 500);
  }
  if (raw.peers.some((p) => !p || typeof p !== "object" || Array.isArray(p))) {
    throw refuse("roster-unreadable", `This machine's roster (${file}) holds an entry that is not a peer. Nothing was changed — writing now would drop that entry and save the rest over the top. Open it in a text editor and remove the bad entry.`, 500);
  }
  return raw.peers;
}

/**
 * Write temp, FLUSH, rename. The flush is the half that is easy to drop.
 *
 * ⚠ WHY `fh.sync()` IS HERE. rename is atomic, so a process crash between the
 * two calls leaves either the old roster or the new one — that much was already
 * true. A POWER CUT is a different failure: without the flush the metadata
 * rename can reach the platter while the data blocks are still in the page
 * cache, and the machine comes back with `roster.json` present, named, and
 * zero-length or half-written. Flushing before the rename is what makes the
 * header's crash-safety claim true of the disk and not just of the process.
 *
 * ⚠ AND WHY THE `catch` DELETES THE TEMP. rename throws EPERM on Windows when
 * another handle is open on the destination — the unguarded two-Studio case in
 * the header. Without this, every such failure left a `.tmp-<pid>` sitting
 * beside the roster forever, in the one folder the header invites people to zip
 * up and e-mail. The error is re-thrown unchanged: cleaning up is not handling.
 */
async function savePeers(appData, peers) {
  await mkdir(collabDir(appData), { recursive: true });
  const dest = rosterPath(appData);
  /* The pid is in the temp name so two processes cannot collide on the temp
   * file itself. It does NOT make the write safe between processes — see the
   * single-writer warning in the file header. */
  const tmp = `${dest}.tmp-${process.pid}`;
  const json = JSON.stringify({ v: ROSTER_VERSION, peers }, null, 2);
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(json, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return peers;
}

/**
 * Fingerprints are compared lowercased and trimmed, because this string arrives
 * from a text field as often as from a card, and a person who typed one letter
 * in capitals should not be told the peer does not exist.
 */
const fpKey = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Read, find the row, mutate it, write. Every mutator below is this function
 * plus its own refusals, so there is exactly one place that knows a missing row
 * is `no-such-peer` and exactly one place that writes the file.
 *
 * Returns the row it wrote, so a route can answer with the peer rather than
 * re-reading the roster to find out what it just did.
 */
function mutate(appData, fp, fn) {
  const key = fpKey(fp);
  return enqueue(async () => {
    const peers = await loadPeers(appData);
    const row = peers.find((p) => fpKey(p.fp) === key);
    if (!row) {
      throw refuse("no-such-peer", FP_RE.test(key)
        ? `No peer with fingerprint ${key} is on this machine's roster. Add their key card first.`
        : "That is not a fingerprint: it should be 32 hexadecimal characters, the first line of a key card after AIPLAY1.", 404);
    }
    fn(row);
    await savePeers(appData, peers);
    return row;
  });
}

/* ─────────────────────────────────────────────────────── reading */

/**
 * The roster as the screens want it: `{ peers: [...] }`, oldest first, and
 * `{ peers: [] }` when nothing has ever been added — meaning the file is not
 * there. A file that IS there and cannot be read refuses with
 * `roster-unreadable` rather than answering "no peers", because a screen that
 * says "no peers" when the peers are merely unreachable is how somebody decides
 * to add them all again. See the note on `loadPeers`.
 *
 * The on-disk version field is deliberately NOT returned. Callers branching on a
 * schema version is how a version becomes load-bearing in six files; the
 * migration, when there is one, belongs in `loadPeers` where the file is read.
 */
export async function roster({ appData } = {}) {
  return enqueue(async () => ({ peers: await loadPeers(appData) }));
}

/* ─────────────────────────────────────────────────────── writing */

/**
 * Add a peer from a key card that `readKeyCard()` has already parsed.
 *
 * The card is taken as an object rather than as the card TEXT so that this
 * module never has to parse the card format, and so the one function that knows
 * that format (identity.js `readKeyCard`) stays the only one. The cost is that
 * a caller can hand us a hand-built object; the key-shape refusals below, and
 * the fingerprint recomputation, are what stops that becoming a stored private
 * key, an unusable row, or a fingerprint bound to somebody else's keys.
 *
 * ⚠ THE CARD'S FIELDS ARE `signPublic` / `sealPublic`, NOT `sign` / `seal`, and
 * reading the wrong two cost this function every real call it had. `readKeyCard`
 * returns `{ fp, signPublic, sealPublic, nickname }`; `sign` and `seal` are the
 * names of the STORED ROW written below, and an earlier version read the row
 * vocabulary off the card. Both keys therefore came back as "", and every
 * genuine card in existence was refused with the sentence about a chat window
 * eating a character — a refusal whose reason code was right and whose
 * instructions sent the user hunting a transit corruption that had not happened.
 * The probe that missed it hand-built `{fp, sign, seal}` instead of calling
 * `readKeyCard`. Both spellings are accepted here so a stored row can be fed
 * back in, but `signPublic`/`sealPublic` is the card format and wins.
 *
 * The row starts at the bottom of everything it can start at the bottom of:
 * unverified, role "none", zero minutes. See the ceremony note in the header —
 * the row is worth nothing until a human has read the words aloud.
 */
export async function addPeer({ appData, card } = {}) {
  if (!card || typeof card !== "object") {
    throw refuse("bad-card", "Read the key card first: addPeer takes the object readKeyCard() returns, not the card text.");
  }
  const fp = fpKey(card.fp);
  if (!FP_RE.test(fp)) {
    throw refuse("bad-card", "That card's fingerprint is not 32 hexadecimal characters. Ask for the card again — a card that has been through a chat window is often missing a character.");
  }
  const sign = String(card.signPublic ?? card.sign ?? "").trim();
  const seal = String(card.sealPublic ?? card.seal ?? "").trim();
  checkKey("signing", sign, SIGN_SPKI_PREFIX, SEAL_SPKI_PREFIX, "ed25519");
  checkKey("sealing", seal, SEAL_SPKI_PREFIX, SIGN_SPKI_PREFIX, "x25519");

  /* ⚠ THE ROW'S FINGERPRINT MUST BE THE HASH OF THE ROW'S OWN KEYS, and this is
   * the line that makes it so. Without it `addPeer` stored `card.fp` on faith
   * while everything downstream treated it as a handle on those keys: the twelve
   * words a human reads aloud come from `row.fp`, the bytes that seal a packet
   * come from `row.seal`, and nothing joined them. A card carrying a friend's
   * real fingerprint beside an attacker's sealing key would have passed the
   * phone call and then encrypted every bundle to the attacker — the exact
   * substitution identity.js says the two-key hash exists to prevent, dropped at
   * the one point in the chain that writes it down. `readKeyCard` makes the same
   * check, which is why this one looks redundant; it is not, because the doc
   * above deliberately permits a hand-built object and that is the door. */
  const computed = fingerprintOf(keyBytes("signing", sign), keyBytes("sealing", seal));
  if (computed !== fp) {
    throw refuse("bad-card", `That card claims fingerprint ${fp}, but its own keys hash to ${computed}. Nothing was added. Treat the card as untrustworthy until your friend reads their fingerprint to you and you have both seen the same one.`);
  }

  return enqueue(async () => {
    const peers = await loadPeers(appData);
    /* ⚠ A SECOND CARD FOR A FINGERPRINT ALREADY ON THE ROSTER IS REFUSED, not
     * merged. Merging is the attack: a row that has been verified by a phone
     * call carries the only human judgement in this system, and quietly
     * replacing its keys — or its `verified` flag — would spend that judgement
     * on keys nobody ever read aloud. Removing the peer first is one extra
     * deliberate act, and it correctly costs the phone call again. */
    if (peers.some((p) => fpKey(p.fp) === fp)) {
      throw refuse("already-a-peer", `${fp} is already on the roster. If their keys really changed, remove the peer first and verify the new card by reading the twelve words aloud again.`, 409);
    }
    const row = {
      fp,
      nickname: cleanNickname(card.nickname) || fp.slice(0, 8),
      sign,
      seal,
      verified: false,
      role: "none",
      lendMinutesPerDay: 0,
      addedAt: Date.now(),
      verifiedAt: null,
    };
    peers.push(row);
    await savePeers(appData, peers);
    return row;
  });
}

/**
 * What reading twelve words aloud sets.
 *
 * ⚠ THIS FUNCTION VERIFIES NOTHING. It records that a HUMAN verified something,
 * off the machine, over a channel this program cannot see. That is the entire
 * design: the twelve words are 128 bits of the fingerprint spoken in a voice
 * you recognise, and no amount of code here can substitute for recognising the
 * voice. Call it only from a screen that has just shown the words and asked
 * "did they read back the same twelve?".
 *
 * Passing `verified: false` un-verifies, and that is not a mistake to design
 * out — it is what you do when the phone call went wrong, and it drops the peer
 * to role "none" below for you, because a verified-only role held by a row that
 * is no longer verified would be a permission nobody re-granted.
 *
 * ⚠ `verified` IS CHECKED, NOT COERCED, AND THE DIFFERENCE IS THE WHOLE POINT.
 * The old test was `verified !== false`, which failed OPEN: the string "false",
 * the string "no", `0` and `null` all meant VERIFY. This is the flag that gates
 * `setRole`, which gates the script leaving the machine, and the ordinary way it
 * gets called is a route reading `req.query.verified` or a JSON body — where a
 * boolean arrives as a string by default. An un-verify that silently verified is
 * the worst direction for this particular bug to fail in. Only `true`/`false`
 * and their two exact spellings are accepted; anything else is `bad-verified`.
 * Do not "helpfully" widen this to truthiness.
 */
export async function markVerified({ appData, fp, verified = true } = {}) {
  const want = verified === true || verified === "true" ? true
    : verified === false || verified === "false" ? false
    : null;
  if (want === null) {
    throw refuse("bad-verified", `Verified must be true or false, not ${JSON.stringify(verified)}. Pass true only when the person read back the same twelve words, and false to take a verification away.`);
  }
  return mutate(appData, fp, (row) => {
    row.verified = want;
    row.verifiedAt = want ? Date.now() : null;
    if (!want && row.role !== "none") {
      row.role = "none";
      row.lendMinutesPerDay = 0;
    }
  });
}

/**
 * Give a verified peer a role, or take it away.
 *
 * Two refusals, and the second is the one that matters: a role may not be given
 * to a row that has not been verified. Without that line the twelve-word
 * ceremony is decorative — a card pasted from anywhere could be promoted to
 * collaborator and would then be sent the whole script.
 */
export async function setRole({ appData, fp, role } = {}) {
  const want = String(role ?? "");
  if (!ROLES.includes(want)) {
    throw refuse("bad-role", `"${want}" is not a role. Use one of: ${ROLES.join(", ")}.`);
  }
  return mutate(appData, fp, (row) => {
    if (want !== "none" && !row.verified) {
      throw refuse("not-verified", `${row.nickname} has not been verified yet. Read the twelve words aloud and confirm they read back the same twelve, then set the role.`, 409);
    }
    /* ⚠ BOTH LENDING ROLES START WITH MINUTES, BECAUSE ACCEPT READS THEM NOW.
     * A collaborator's scenes are accepted like a lending friend's, and accept
     * refuses a friend at 0 minutes (lending.js budgetCheck) — so a friend made
     * a collaborator straight from "nothing yet" used to land at 0 and have
     * every scene refused until "Accept anyway". Moving BETWEEN the two lending
     * roles is not a new grant, so it keeps whatever number is there. */
    const LENDS = ["lender", "collaborator"];
    const promoting = LENDS.includes(want) && !LENDS.includes(row.role);
    row.role = want;
    if (want === "none") row.lendMinutesPerDay = 0;
    /* The starting allowance, and only on the transition. See the long note on
     * LEND_MINUTES_ON_PROMOTION for why this is not zero and how to make it zero. */
    if (promoting && row.lendMinutesPerDay === 0) row.lendMinutesPerDay = LEND_MINUTES_ON_PROMOTION;
  });
}

/**
 * How many minutes of THIS machine's card this peer's scenes may use per day.
 *
 * ⚠ NOTHING IN THIS FILE SPENDS IT OR COUNTS IT. The accounting lives where a
 * lend is accepted: the door's `accept` reads this number through
 * server/collab/lending.js `budgetCheck`, against what the card has rendered
 * for this peer today (timed) and promised (the plan's estimate), and refuses
 * past it unless a person answers "Accept anyway". It is a daily ceiling
 * checked at accept time — a scene already accepted runs to the end.
 *
 * 0 is a real and useful value: it means "on the roster, trusted, currently
 * lending nothing", which is what you set when a friend's card is busy for a
 * week and you do not want to forget who they are.
 */
export async function setLendMinutes({ appData, fp, minutesPerDay } = {}) {
  const n = Number(minutesPerDay);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEND_MINUTES) {
    throw refuse("bad-minutes", `Minutes a day must be a whole number from 0 to ${MAX_LEND_MINUTES} (a whole day). 0 means this peer lends nothing for now.`);
  }
  return mutate(appData, fp, (row) => { row.lendMinutesPerDay = n; });
}

/**
 * What this peer last SAID they could do, and when they said it.
 *
 * ⚠ IT IS A MESSAGE, NOT A READING, and the whole reason this stores `at`
 * alongside is that the two look identical on a screen. Nothing here probed
 * anybody's machine: a resource card is what a friend's Studio reported at the
 * moment they pressed send, and they may have uninstalled half of it since.
 * Every surface that prints one must print its age beside it — see
 * `resources.js` `ageOf`, which exists so no caller has to invent that sentence.
 *
 * Stored on the peer row rather than in a file of its own because it is worth
 * exactly as much as the row is: forget the peer and this goes with them, which
 * is the correct behaviour and would have to be written by hand otherwise.
 *
 * ⚠ WHAT THIS DOES AND DOES NOT CHECK. It takes a card that
 * `resources.js` `readResourceCard` has already whitelisted and bounded, and it
 * checks only that the thing it was handed calls itself a resource card. It does
 * NOT know whether that card arrived inside a verified bundle — the route is
 * what reads a bundle, and nothing ties this call to one. An earlier version of
 * this note claimed both, and neither was enforced anywhere: the route took
 * `b.resources` straight out of a POST body and stored every key it was sent,
 * so a fifty-kilobyte object with a file path in it went onto a peer row whole.
 * What IS true is that `open` files nothing by itself; filing is a second,
 * deliberate call.
 */
export async function setResources({ appData, fp, resources } = {}) {
  if (!resources || typeof resources !== "object" || resources.kind !== "resources") {
    throw refuse("bad-resources", "That is not a resource card. A friend's Studio makes one on its own Collab screen and sends it sealed, the same way a project travels.");
  }
  return mutate(appData, fp, (row) => {
    row.resources = resources;
    row.resourcesAt = Number(resources.at) || 0;
  });
}

/**
 * THE BUILD A FRIEND'S LAST FILE WAS MADE BY.
 *
 * A caption, recorded when one of their packets opens here, so their row can
 * say which Studio is on the other end without anybody comparing screenshots.
 * ⚠ It decides nothing: whether a file opens is `speaks()` in compat.js reading
 * that file's own protocol number. This is what a person reads afterwards.
 */
export async function setBuild({ appData, fp, by } = {}) {
  if (!by || typeof by !== "object") throw refuse("bad-build", "No build stamp to record.");
  return mutate(appData, fp, (row) => {
    row.build = {
      app: String(by.app || "").slice(0, 40),
      commit: String(by.commit || "").slice(0, 12),
      protocol: Number(by.protocol) || 0,
      at: Date.now(),
    };
  });
}

/**
 * Forget a peer entirely. Returns the row that was removed, so the screen can
 * say whose card it just dropped without having read the roster first.
 *
 * ⚠ REMOVING IS NOT THE SAME AS REVOKING, and the difference bites. Their copy
 * of anything you already sent them is still theirs — a shot packet that has
 * left this machine is gone, and no row deleted here reaches it. What removal
 * buys is that nothing NEW will be sealed to that fingerprint. If the intent is
 * "stop them rendering but keep knowing who they are", `setRole(fp, "none")` is
 * the honest call and it keeps the verification you paid a phone call for.
 */
export async function removePeer({ appData, fp } = {}) {
  const key = fpKey(fp);
  return enqueue(async () => {
    const peers = await loadPeers(appData);
    const i = peers.findIndex((p) => fpKey(p.fp) === key);
    if (i < 0) {
      throw refuse("no-such-peer", FP_RE.test(key)
        ? `No peer with fingerprint ${key} is on this machine's roster, so there is nothing to remove.`
        : "That is not a fingerprint: it should be 32 hexadecimal characters, the first line of a key card after AIPLAY1.", 404);
    }
    const [row] = peers.splice(i, 1);
    await savePeers(appData, peers);
    return row;
  });
}
