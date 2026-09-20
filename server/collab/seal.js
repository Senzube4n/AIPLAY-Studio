/**
 * Sealed bundles — one blob, addressed to exactly one peer, signed by the sender.
 *
 * This is the envelope every collab payload travels in: a shot packet on its way
 * to somebody lending a GPU, a project bundle on its way to a collaborator. It
 * does two separable jobs and it is worth naming them apart, because they fail
 * apart:
 *
 *   CONFIDENTIALITY comes from an ephemeral x25519 agreement with the
 *   recipient's sealing key. Only the holder of that sealing private key can
 *   derive the AES key. This says nothing whatsoever about who sent it.
 *
 *   AUTHENTICITY comes from a detached ed25519 signature over the envelope.
 *   The recipient's sealing public key is PUBLIC — it travels in a key card
 *   that gets read aloud, pasted into chat rooms and forwarded. Anybody holding
 *   that card can build a perfectly well-formed, perfectly decryptable bundle
 *   addressed to its owner. Without the signature the receiving Studio would
 *   happily unpack a stranger's payload, attribute it to a roster peer, and
 *   render it. The GCM tag is NOT evidence of who sent anything; it is evidence
 *   that whoever sent it knew the shared secret, and half of that secret is
 *   published on purpose.
 *
 * THE WIRE FORMAT. Four parts, in this order, concatenated with no padding:
 *
 *   1. the ASCII line `AIPLAYSEAL1` and one \n
 *   2. one line of JSON, the envelope, and one \n
 *   3. one line of JSON, the detached signature, and one \n
 *   4. the raw AES-256-GCM ciphertext, `bytes` of it, to the end of the blob
 *
 * The envelope is { v, from, to, eph, iv, tag, bytes }: protocol version, the
 * sender's fingerprint, the RECIPIENT's fingerprint, the ephemeral x25519
 * public key as base64 SPKI DER, the 12-byte GCM iv, the 16-byte GCM tag, and
 * the ciphertext length. The signature line is { alg, sig }.
 *
 * WHY THE RECIPIENT IS INSIDE THE SIGNED BYTES. `to` is signed, so what the
 * sender attests is not "I made this payload" but "I made this payload FOR
 * THIS PERSON". A bundle captured in transit and handed to a third machine
 * cannot be passed off as a bundle that was written for it: the fingerprint in
 * the signed envelope is somebody else's, openSealed refuses at `not-for-me`
 * before it ever tries to decrypt, and rewriting `to` invalidates the
 * signature. Without `to` under the signature, a sender's bundle for a
 * collaborator could be replayed at a GPU lender who would see a valid
 * signature from a roster peer and start rendering.
 *
 * ⚠ THE CANONICAL BYTES ARE THE BYTES ON THE WIRE, NOT A RE-SERIALISATION.
 * The verifier checks the signature over the exact envelope line it read out
 * of the blob — it never parses the envelope and re-stringifies it to get the
 * bytes to verify. Re-serialising is the classic way a signature scheme starts
 * rejecting its own valid messages: key order, the escaping of non-ASCII, and
 * integer formatting are all things a JSON round trip is allowed to change,
 * and every one of those changes a hash. Parsing here is only ever for
 * READING fields; verification is byte-for-byte against what arrived.
 *
 * ⚠ THE CIPHERTEXT IS BINARY AND WILL CONTAIN 0x0A. Splitting the whole blob
 * on newlines to find the three text lines corrupts any payload whose
 * ciphertext happens to hold a linefeed, which for random bytes is roughly one
 * blob in 256 per byte — i.e. essentially all of them. The reader below finds
 * the first two \n by index and then takes the remainder by OFFSET, and it
 * cross-checks that remainder's length against the signed `bytes` field so a
 * truncated or padded transfer is a refusal rather than a mysterious auth
 * failure.
 *
 * MEASURED, on this machine (Node v22.15.0, Windows 11, one warm process):
 * a 1 MiB payload sealed in 1.9 ms and opened in 1.5 ms; a 4 KiB payload
 * sealed in 0.6 ms and opened in 0.7 ms. A bundle costs 354 to 356 bytes more
 * than its payload — the range is real and not rounding: `bytes` is a decimal
 * integer in the envelope, so the header grows a character each time the
 * payload passes a power of ten. Those are single-run wall-clock numbers from
 * one verification script, not a benchmark average, and at these sizes they
 * are within noise of each other. NOT MEASURED: any of it under memory
 * pressure, and anything at all about payloads large enough to matter — a
 * project bundle is around 30 MB and has never been sealed here. Both halves
 * hold the whole payload and the whole ciphertext in memory at once, so the
 * peak is roughly twice the payload; nobody has watched that on a 30 MB
 * bundle, and if it ever hurts, the fix is a streaming variant rather than a
 * tuning knob on this one.
 *
 * NO NEW DEPENDENCIES: node:crypto, plus one pure function from identity.js.
 * Nothing in this file touches the network, the disk, or the roster — it is
 * pure bytes in, bytes out, so the caller decides what a verified sender is
 * allowed to do.
 *
 * WHAT THIS FILE IMPORTS FROM identity.js, AND WHY IT IS EXACTLY ONE THING:
 * `fingerprint`. An earlier version of this header said identity.js was
 * deliberately not imported because "every key and every fingerprint sealTo and
 * openSealed need arrives as a parameter, so there is no value to fetch". That
 * claim was wrong in the expensive direction. The fingerprint is a hash over a
 * peer's signing AND sealing keys precisely so that a substituted sealing key
 * changes the fingerprint, and this file is the only place where that binding
 * can be enforced at the moment of use — so the value to fetch is the check
 * itself. See the ⚠ above sealTo for the hole that cost. The function is pure:
 * it hashes two SPKIs, reads no file and mints no identity, so importing it
 * leaves the crypto here testable with no identity.json on disk (measured:
 * importing identity.js creates nothing under appData).
 */
import { fingerprint } from "./identity.js";
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

/** The first line of every bundle. A version in the magic, not only in the
 *  envelope, so a reader can refuse a future format before it parses JSON. */
const MAGIC = "AIPLAYSEAL1";
const MAGIC_LINE = Buffer.from(`${MAGIC}\n`, "ascii");

/** Fixed HKDF info. It names the whole suite so that a later version with a
 *  different cipher derives a different key from the same agreement, which is
 *  what stops a downgrade from being silent. */
const HKDF_INFO = "AIPLAY collab seal v1 x25519 hkdf-sha256 aes-256-gcm";

const IV_BYTES = 12;   // GCM's native nonce length; anything else costs a GHASH pass
const KEY_BYTES = 32;  // AES-256
const TAG_BYTES = 16;
const PROTOCOL_V = 1;

/** Envelope field order, written explicitly rather than relying on object
 *  literal insertion order. The order only has to be stable for the writer —
 *  the verifier works from the wire bytes — but a reader of this file should
 *  be able to see the line's shape without running it. */
const ENVELOPE_KEYS = ["v", "from", "to", "eph", "iv", "tag", "bytes"];

/** A fingerprint as identity.js makes it: 32 lowercase hex characters. */
const FP_RE = /^[0-9a-f]{32}$/;

/**
 * Build a refusal. `reason` is the short machine-readable branch; `message` is
 * a full sentence telling the caller what to do next, because these errors
 * surface on a screen in front of somebody who did not write this code.
 */
function refuse(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

/** Base64 of an SPKI DER public key back to a KeyObject, or null if it is not
 *  one. Returns null rather than throwing so each caller can pick the reason
 *  that fits its own position in the sequence.
 *
 *  ⚠ THE DECODE USED TO SIT IN A try/catch, AND THAT try/catch NEVER CAUGHT
 *  ANYTHING. Buffer.from(str, "base64") does not throw on invalid input: it
 *  silently SKIPS every character outside the base64 alphabet and hands back a
 *  shorter buffer (measured: `Buffer.from("!!!not base64!!!", "base64")` is six
 *  bytes, no error). So a key mangled in transit — broken across two lines by a
 *  mail client is the usual way — decoded quietly into the wrong bytes, and the
 *  guard that looked like it was catching that was decoration. The re-encode
 *  comparison below is the check that actually turns the silence into a null;
 *  it is the same trick identity.js's spki() plays for the same reason, with
 *  one difference worth knowing: spki() trims its input first and this does
 *  not, so a key carrying a stray newline hashes cleanly through fingerprint()
 *  and is refused here. Every key that reaches this module through the roster
 *  was trimmed on the way in (roster.js addPeer), so the gap is reachable only
 *  from a hand-assembled call. Both
 *  sides of this format write their keys with Buffer#toString("base64"), so
 *  canonical padded base64 is the only spelling that can legitimately arrive.
 *  Do not relax this to a length test: without it, a key that is wrong in a way
 *  base64 tolerates gets all the way to a signature that will not verify, and
 *  the refusal then blames the sender for a fault in the paste. */
function publicFromB64(b64, expectType) {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  const der = Buffer.from(b64, "base64");
  if (der.length === 0 || der.toString("base64") !== b64) return null;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (expectType && key.asymmetricKeyType !== expectType) return null;
    return key;
  } catch {
    return null;
  }
}

/** The exact bytes of the envelope line, with the trailing \n excluded: this
 *  is what gets signed and what gets verified. */
function envelopeLine(envelope) {
  const ordered = {};
  for (const k of ENVELOPE_KEYS) ordered[k] = envelope[k];
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/**
 * Additional authenticated data for GCM: the parts of the envelope that are
 * known before the tag exists.
 *
 * The tag itself lives in the envelope, so the envelope cannot be its own AAD
 * without a circular dependency — this binds the fields that can be bound.
 * It is belt and braces over the ed25519 signature, and it earns its keep in
 * exactly one case: a caller that (wrongly) decrypts without verifying still
 * cannot be fed a bundle whose recipient or ephemeral key were swapped.
 *
 * ⚠ Both sides of this format live in this file. If a bundle is ever opened by
 * anything other than openSealed below, that reader has to build this same
 * string or every tag check fails with no explanation of why.
 */
function aadFor(envelope) {
  return Buffer.from(
    `${MAGIC}|${envelope.v}|${envelope.from}|${envelope.to}|${envelope.eph}|${envelope.iv}`,
    "utf8",
  );
}

/**
 * Derive the AES key from an agreed x25519 secret.
 *
 * hkdfSync returns an ArrayBuffer, not a Buffer, and it is normalised to a
 * Buffer here so that both call sites — and anything that later logs, slices or
 * compares a derived key — see one type. That is the whole reason for the
 * Buffer.from, and it is worth being exact about what it is NOT: it is not a
 * workaround for a type error. An earlier version of this comment warned that
 * handing the ArrayBuffer straight to createCipheriv "fails with a type
 * complaint", written with the authority of something hit in practice. On the
 * Node this file names in the MEASURED block above it simply does not fail —
 * measured on v22.15.0, createCipheriv and createDecipheriv both accept the raw
 * ArrayBuffer with no throw — and the warning sent readers hunting a trap that
 * is not there.
 *
 * The salt is the ephemeral public key's DER: a fresh random value per bundle,
 * which is what a salt is for, and one both sides already hold (the sender
 * generated it, the recipient reads it out of the envelope) so neither has to
 * derive anything extra to agree.
 */
function deriveKey(secret, ephDer) {
  return Buffer.from(hkdfSync("sha256", secret, ephDer, HKDF_INFO, KEY_BYTES));
}

/**
 * Seal `payload` for one peer and sign it as one sender.
 *
 * `toSignPublicB64` and `toSealPublicB64` are the recipient's two public keys
 * (base64 SPKI DER, straight off their key card: the signing key is the card's
 * second field, the sealing key its third — or, on this machine, the `sign` and
 * `seal` fields of their roster row); `toFp` and `fromFp` are 32-hex
 * fingerprints; `signPrivate` is the sender's ed25519 private KeyObject, which
 * on this machine comes from identity.js's privateKeys(). Returns a Buffer —
 * the whole bundle, ready to write to a file or hand to a transport.
 *
 * ⚠ BOTH OF THE RECIPIENT'S KEYS ARE REQUIRED, AND THIS IS THE ONLY PLACE THE
 * FINGERPRINT-TO-KEY BINDING CAN BE ENFORCED AT THE MOMENT OF USE.
 * THE HOLE THIS CLOSES: `toFp` and `toSealPublicB64` used to arrive as two
 * independent parameters and were never compared with each other. sealTo would
 * therefore sign `to: <B's fingerprint>` over a ciphertext that only C can open,
 * and say nothing at all about it — measured, before the fix: "mismatched
 * toFp/sealPub -> ACCEPTED; B gets bad-ciphertext, C gets not-for-me". That is
 * the worst shape a failure can have here: no refusal at the one machine that
 * could still fix it, and then two different errors days later on two different
 * machines, neither of which points back at the sender's roster row. It also
 * meant that a roster row or a key card carrying a real peer's `fp` next to an
 * attacker's sealing key was undetectable at the sealing end — and that
 * substitution is the entire reason the fingerprint hashes BOTH keys
 * (identity.js's fingerprint(), ⚠ paragraph). Recomputing
 * fingerprint(toSignPublicB64, toSealPublicB64) and refusing `bad-recipient`
 * unless it equals `toFp` is the check that catches it.
 * Do NOT delete `toSignPublicB64` on the grounds that sealTo never signs with
 * it. It is not here to sign. It is here to prove that the fingerprint about to
 * be written into the signed envelope names the key the ciphertext is actually
 * being built for.
 *
 * Refusals (Error with `reason`): bad-payload, bad-recipient, bad-sender,
 * bad-key. They are all caller mistakes, they are all checked before a single
 * byte of key material is generated, and each message says which argument.
 */
export function sealTo({ payload, toSealPublicB64, toSignPublicB64, toFp, fromFp, signPrivate }) {
  if (!Buffer.isBuffer(payload)) {
    throw refuse("bad-payload", "Pass the payload as a Buffer. Serialise objects yourself first — for a packet that means Buffer.from(JSON.stringify(packet), \"utf8\") — so the sender, not this function, decides the exact bytes that get signed.");
  }
  if (typeof toFp !== "string" || !FP_RE.test(toFp)) {
    throw refuse("bad-recipient", "Pass toFp as the recipient's 32-character lowercase hex fingerprint, exactly as it appears on their key card and in the roster row.");
  }
  if (typeof fromFp !== "string" || !FP_RE.test(fromFp)) {
    throw refuse("bad-sender", "Pass fromFp as this machine's own 32-character lowercase hex fingerprint from identity().fp.");
  }
  const toSeal = publicFromB64(toSealPublicB64, "x25519");
  if (!toSeal) {
    throw refuse("bad-recipient", "The recipient's sealing key could not be read. It must be an x25519 public key as base64 SPKI DER — that is the third field of their key card, not the second, which is the signing key.");
  }
  if (!publicFromB64(toSignPublicB64, "ed25519")) {
    throw refuse("bad-recipient", "The recipient's signing key could not be read. It must be an ed25519 public key as base64 SPKI DER — the second field of their key card, or the `sign` field of their roster row. It is required even though this function does not sign with it: the fingerprint that goes into the signed envelope is a hash over both of their keys, and it is checked against both of them here.");
  }
  let boundFp;
  try {
    boundFp = fingerprint(toSignPublicB64, toSealPublicB64);
  } catch {
    throw refuse("bad-recipient", "The recipient's two public keys could not be hashed into a fingerprint, so there is no way to tell whether toFp belongs to them. Take both keys from one key card, read in one piece, rather than assembling them from two places.");
  }
  if (boundFp !== toFp) {
    throw refuse("bad-recipient", `The recipient's keys hash to the fingerprint ${boundFp}, not to the ${toFp} you passed as toFp. Nothing was sealed. One of the two came from somewhere else — a roster row edited by hand, or a key card pasted over an older one are the usual causes — and sealing anyway would produce a bundle that names one peer and opens on another. Re-read your friend's key card, and read the twelve words aloud again before you send anything.`);
  }
  if (!signPrivate || typeof signPrivate !== "object" || signPrivate.asymmetricKeyType !== "ed25519") {
    throw refuse("bad-key", "Pass signPrivate as this machine's ed25519 private KeyObject from privateKeys({ appData }).signPrivate. A base64 string will not do: the private keys deliberately never leave identity.js as text.");
  }

  /* A fresh ephemeral pair per bundle, which is the whole reason the sender's
   * long-term sealing key is not used for the agreement: one bundle's secret
   * cannot open the others. Nothing keeps the private half — it is never
   * stored, never returned, and becomes unreachable when sealTo returns. (It
   * lives for the length of this call, not, as an earlier version of this
   * comment said, only until the key is derived.) */
  const eph = generateKeyPairSync("x25519");
  const ephDer = eph.publicKey.export({ format: "der", type: "spki" });
  const secret = diffieHellman({ privateKey: eph.privateKey, publicKey: toSeal });
  const key = deriveKey(secret, ephDer);

  const iv = randomBytes(IV_BYTES);
  const half = {
    v: PROTOCOL_V,
    from: fromFp,
    to: toFp,
    eph: ephDer.toString("base64"),
    iv: iv.toString("base64"),
  };
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(half));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  /* The tag only exists after final(), and the tag is in the envelope, so the
   * envelope can only be completed — and therefore only signed — here. */
  const envelope = { ...half, tag: tag.toString("base64"), bytes: ciphertext.length };
  const line = envelopeLine(envelope);
  const sig = edSign(null, line, signPrivate); // ed25519 takes no digest algorithm
  const sigLine = Buffer.from(JSON.stringify({ alg: "ed25519", sig: sig.toString("base64") }), "utf8");

  return Buffer.concat([
    MAGIC_LINE,
    line, Buffer.from("\n", "ascii"),
    sigLine, Buffer.from("\n", "ascii"),
    ciphertext,
  ]);
}

/**
 * Open a sealed bundle, in this order: verify, then check it is ours, then
 * decrypt. Returns { envelope, payload } with payload as a Buffer.
 *
 * `me` is this machine's fingerprint — either the string, or anything with a
 * `.fp` (so the identity object can be passed straight through).
 * `sealPrivate` is our x25519 private KeyObject from privateKeys().
 * `senderSignPublicB64` is the ed25519 signing public key of the peer the
 * envelope says sent it. It has two spellings, and the second is the one to
 * reach for:
 *
 *   • a base64 string, which the caller must already have looked up in the
 *     roster BY the `from` fingerprint of this very blob; or
 *
 *   • a function `(envelope) => base64 | null`, called with the parsed envelope
 *     once its shape has been checked and before anything is verified or
 *     decrypted. Return null for a fingerprint that is not in the roster (or
 *     throw your own Error with a `reason`, which is passed through untouched).
 *
 * ⚠ WHY THE FUNCTION FORM EXISTS: SO THAT THERE IS ONLY EVER ONE PARSER.
 * `senderSignPublicB64` is validated before the blob is looked at, so with only
 * the string form a caller could not reach `envelope.from` through this module
 * at all — it had to find the first two 0x0a bytes and JSON.parse the envelope
 * itself, which is precisely the read the ⚠ at the top of this file warns is
 * easy to get wrong, written a second time, in a file with no access to
 * MAGIC_LINE. That second copy is the one that splits the whole blob on "\n"
 * and corrupts every ciphertext holding a linefeed. The function form keeps the
 * roster lookup inside the reader that already knows how to do the read. The
 * envelope handed to it is a shallow copy, so a lookup cannot reach back and
 * edit the envelope this function is about to verify against.
 *
 * ⚠ `envelope.from` IS NOT AUTHENTICATED BY ANYTHING IN THIS FILE, AND THE
 * CALLER'S CHOICE OF KEY IS WHAT MAKES IT TRUE. A passing signature proves that
 * the holder of `senderSignPublicB64` signed these bytes. It does not prove that
 * the fingerprint written in `from` belongs to that key: a fingerprint is a hash
 * over a peer's signing AND sealing keys, this function is never given the
 * sender's sealing key, so it could not check that binding even if it tried.
 * `from` is therefore exactly as trustworthy as the way the key was chosen —
 * choose the key BY `from` (the function form makes that automatic) and the two
 * agree by construction. THE HOLE THIS CLOSES: an earlier version of this
 * paragraph also sanctioned "or supplies from a key card being trusted for the
 * first time". Under that pattern `from` is a string the sender picked freely,
 * carried inside bytes signed by a key belonging to somebody else entirely, and
 * any screen that prints `envelope.from` attributes the bundle — and whatever
 * the caller then does with a "known peer's" payload — to the wrong person. Do
 * not put that clause back. A first contact is trusted by adding their card to
 * the roster first and opening afterwards, in that order.
 *
 * ⚠ WHY THE SIGNATURE IS CHECKED BEFORE THE DECRYPTION, AND NOT AFTER.
 * Decrypting first is the tempting order, because it lets you refuse garbage
 * without a roster lookup. It is wrong for two reasons. The first is what the
 * two checks actually prove: successful GCM decryption proves only that the
 * sender knew the shared secret, and the recipient's half of that secret is a
 * PUBLISHED key card, so any stranger can produce a bundle that decrypts
 * perfectly. Verifying afterwards means the plaintext — a prompt, a project
 * document, a file manifest — has already been produced, parsed and quite
 * possibly logged or shown before anybody established who wrote it, and a
 * plaintext that exists is a plaintext that leaks. The second is simpler: the
 * signature is the only check here that is cheap, total, and made over bytes
 * the attacker cannot change. Doing it first means an unsigned or forged blob
 * never reaches the cipher at all, and the `not-for-me` and `bad-ciphertext`
 * refusals below can then be trusted to be about an honest sender's mistake
 * rather than about somebody probing us.
 *
 * Every refusal is an Error with a `reason`: not-sealed, bad-envelope,
 * bad-signature, not-for-me, bad-ciphertext, and `unknown-sender` when the
 * lookup holds no key for the fingerprint the envelope names — plus
 * bad-arguments, which is not about the blob at all (see its comment below).
 */
/**
 * ⚠ THE LARGEST BUNDLE THIS WILL OPEN, AND WHY THERE HAS TO BE ONE.
 *
 * There was no cap of any kind. Measured: a 300 MB payload of dense small
 * objects expands past four gigabytes of heap inside `JSON.parse` and V8 aborts
 * the process — and a heap abort is not a throwable, so every `try/catch` around
 * the parse is decoration. The whole app dies, from one file, sent by anybody
 * whose key card is on the roster.
 *
 * 96 MB is chosen to sit above the largest thing this format legitimately
 * carries — a project bundle measured at about 31 MB, and a returned clip capped
 * at 64 MB by order.js — with room, and far below the parse cliff.
 */
export const MAX_BUNDLE_BYTES = 96 * 1024 * 1024;

export function openSealed({ blob, me, sealPrivate, senderSignPublicB64, maxBytes = MAX_BUNDLE_BYTES }) {
  /* bad-arguments exists because the five blob reasons would each be a lie
   * here. A missing sealing key is not a bad ciphertext and a missing sender
   * key is not a bad signature: those reasons blame the sender for a fault on
   * this side of the wire, and somebody debugging a lend would go looking down
   * the wrong end of it. Callers branching on the five can treat this one as
   * "never happens in production", because it only fires on a call that was
   * built wrong.
   *
   * ⚠ ONE REFUSAL DELIBERATELY LEFT OUT OF THIS BUCKET: a lookup that answers
   * with no key refuses `unknown-sender`, further down, because that one IS
   * driven by the blob — `from` is the sender's choice, so an attacker decides
   * whether it fires. Everything reported as `bad-arguments` is a fault on this
   * side of the wire and nothing else. */
  const myFp = typeof me === "string" ? me : me && typeof me === "object" ? me.fp : null;
  if (typeof myFp !== "string" || !FP_RE.test(myFp)) {
    throw refuse("bad-arguments", "Pass `me` as this machine's own fingerprint string, or as the object identity({ appData }) returned. Without it there is no way to tell whether this bundle was addressed here.");
  }
  if (!sealPrivate || typeof sealPrivate !== "object" || sealPrivate.asymmetricKeyType !== "x25519") {
    throw refuse("bad-arguments", "Pass sealPrivate as this machine's x25519 private KeyObject from privateKeys({ appData }).sealPrivate.");
  }
  const lookupSender = typeof senderSignPublicB64 === "function" ? senderSignPublicB64 : null;
  let senderSign = null;
  if (!lookupSender) {
    senderSign = publicFromB64(senderSignPublicB64, "ed25519");
    if (!senderSign) {
      throw refuse("bad-arguments", "Pass senderSignPublicB64 as the sender's ed25519 signing public key — the `sign` field of their roster row, looked up by the `from` fingerprint in the envelope — or as a function (envelope) => that key, which lets this module do the structural read for you. A bundle cannot be opened from an unknown sender: add them to the roster first.");
    }
  }

  /* ── structural read. Nothing here is trusted; it only finds the lines. ── */
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC_LINE.length) {
    throw refuse("not-sealed", `This is not an AIPLAY sealed bundle — it is too short to hold even the ${MAGIC} header. Check that the file was read as a Buffer with no encoding argument, because reading it as utf8 corrupts the ciphertext.`);
  }
  if (blob.length > maxBytes) {
    throw refuse("too-big", `This bundle is ${Math.round(blob.length / 1048576)} MB and this Studio opens at most ${Math.round(maxBytes / 1048576)} MB. Nothing was decrypted. A bundle far over the limit is not a large project, it is a way of using up this machine's memory.`);
  }
  if (!blob.subarray(0, MAGIC_LINE.length).equals(MAGIC_LINE)) {
    throw refuse("not-sealed", `This is not an AIPLAY sealed bundle: it does not begin with the line ${MAGIC}. If it begins with AIPLAYSEAL followed by a different number, it was sealed by a newer Studio than this one and cannot be opened here.`);
  }
  const envEnd = blob.indexOf(0x0a, MAGIC_LINE.length);
  const sigEnd = envEnd < 0 ? -1 : blob.indexOf(0x0a, envEnd + 1);
  if (envEnd < 0 || sigEnd < 0) {
    throw refuse("bad-envelope", "This bundle is truncated: the envelope and signature lines are not both present. Transfer the file again, and transfer it as binary.");
  }
  const line = blob.subarray(MAGIC_LINE.length, envEnd);
  const sigRaw = blob.subarray(envEnd + 1, sigEnd);
  const ciphertext = blob.subarray(sigEnd + 1);

  let envelope;
  try {
    envelope = JSON.parse(line.toString("utf8"));
  } catch {
    throw refuse("bad-envelope", "The envelope line of this bundle is not valid JSON. The file has been altered or re-encoded in transit — send it again without passing it through anything that rewrites text.");
  }
  const shapeOk = envelope && typeof envelope === "object"
    && envelope.v === PROTOCOL_V
    && typeof envelope.from === "string" && FP_RE.test(envelope.from)
    && typeof envelope.to === "string" && FP_RE.test(envelope.to)
    && typeof envelope.eph === "string"
    && typeof envelope.iv === "string"
    && typeof envelope.tag === "string"
    && Number.isInteger(envelope.bytes) && envelope.bytes >= 0 && envelope.bytes <= maxBytes;
  if (!shapeOk) {
    throw refuse("bad-envelope", `The envelope of this bundle is not a version ${PROTOCOL_V} envelope with the seven fields ${ENVELOPE_KEYS.join(", ")}. Ask the sender which Studio version sealed it.`);
  }

  /* ── 0. the roster lookup, if the caller left it to us. Inside this parser,
   *    keyed by the envelope this function just read, so the key that verifies
   *    is the key held for the `from` that will be reported. Still nothing
   *    trusted: the lookup only chooses which public key the signature has to
   *    survive. ── */
  if (lookupSender) {
    let looked;
    try {
      looked = lookupSender({ ...envelope });
    } catch (err) {
      /* A refusal the caller built on purpose keeps its own reason — that is
       * how an `unknown-peer` from the roster reaches the screen saying what it
       * means. Anything else is a fault on this side of the wire, and the five
       * blob reasons would blame the sender for it. */
      if (err && typeof err.reason === "string") throw err;
      throw refuse("bad-arguments", `Looking up the signing key for ${envelope.from} threw: ${err && err.message ? err.message : String(err)}. Nothing was verified and nothing was decrypted. The lookup passed to openSealed should answer with a key or with null, not fail.`);
    }
    senderSign = publicFromB64(looked, "ed25519");
    if (!senderSign) {
      /* ⚠ `unknown-sender`, NOT `bad-arguments`. This is the one refusal in
       * this function whose cause is the BLOB rather than the call: `from` is
       * chosen by whoever sealed the bundle, so an attacker picks which
       * fingerprint gets looked up and therefore whether this fires. Reporting
       * it as `bad-arguments` — the reason reserved for a call built wrong —
       * would put an attacker-driven path into the one bucket the comment at
       * the top of this function tells callers never happens in production. */
      throw refuse("unknown-sender", `No usable ed25519 signing key is held for ${envelope.from}, so this bundle cannot be attributed to anyone and has not been decrypted. If that fingerprint is a friend you have verified, add their key card to the roster first; if it is not, the bundle came from a stranger.`);
    }
  }

  /* ── 1. the signature, over the bytes that arrived, before anything else ── */
  let sigObj;
  try {
    sigObj = JSON.parse(sigRaw.toString("utf8"));
  } catch {
    throw refuse("bad-signature", "The signature line of this bundle is not valid JSON, so the bundle cannot be attributed to anyone. Do not open it; ask the sender to seal and send it again.");
  }
  if (!sigObj || sigObj.alg !== "ed25519" || typeof sigObj.sig !== "string") {
    throw refuse("bad-signature", "This bundle does not carry an ed25519 signature, which is the only kind this version can check. Ask the sender to seal it again with a current Studio.");
  }
  let ok = false;
  try {
    ok = edVerify(null, line, senderSign, Buffer.from(sigObj.sig, "base64"));
  } catch {
    ok = false; // a malformed signature is an unverified signature, not a crash
  }
  if (!ok) {
    throw refuse("bad-signature", `This bundle was not signed by the key held for ${envelope.from}, or it was altered after sealing. Nothing has been decrypted. Check that the roster row for that fingerprint holds the same signing key as their key card — read the twelve words aloud again if you are not sure.`);
  }

  /* ── 2. addressed to us. Signed, so this is the sender's own statement. ── */
  if (envelope.to !== myFp) {
    throw refuse("not-for-me", `This bundle was sealed for ${envelope.to}, and this machine is ${myFp}. It was signed for someone else, so it is not a bundle that was ever meant to be opened here — a forwarded copy is not a copy addressed to you. Ask the sender to seal a new one against this machine's key card.`);
  }

  /* ── 3. only now, decryption ───────────────────────────────────────────── */
  if (ciphertext.length !== envelope.bytes) {
    throw refuse("bad-ciphertext", `This bundle carries ${ciphertext.length} bytes of ciphertext where its signed envelope says ${envelope.bytes}. The signature checked out, so the envelope is genuine and the body is what changed: the file was truncated or padded in transfer. Send it again as binary.`);
  }
  const ephDer = Buffer.from(envelope.eph, "base64");
  const ephPublic = publicFromB64(envelope.eph, "x25519");
  if (!ephPublic) {
    throw refuse("bad-envelope", "The ephemeral key in this bundle's envelope is not a readable x25519 public key, even though the signature checked out. That means the sender sealed a malformed bundle; ask them to try again.");
  }
  let payload;
  try {
    const key = deriveKey(diffieHellman({ privateKey: sealPrivate, publicKey: ephPublic }), ephDer);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"), { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor(envelope));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    /* The message deliberately does not repeat the exception. GCM failures all
     * say the same uninformative thing, and the useful information is the one
     * fact the caller can act on: the signature already passed, so this is our
     * key, not their bundle. */
    throw refuse("bad-ciphertext", "This bundle's signature checked out but it will not decrypt with this machine's sealing key. The usual cause is that the sender used an older copy of this machine's key card — one from before identity.json was regenerated. Send them the current key card.");
  }
  return { envelope, payload };
}
