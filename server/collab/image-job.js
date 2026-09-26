/**
 * A standalone picture request carried by the signed Collab courier.
 *
 * This is deliberately a different wire kind from the movie-scene `order`.
 * It contains data and a bounded, typed render request, never a graph, path,
 * model filename or instruction to execute. Routes must still verify the
 * envelope's signer/recipient, the peer's role, local model readiness and the
 * receiving person's acceptance before they queue anything.
 */
import { createHash, randomBytes } from "node:crypto";
import { assertSafe } from "../safety/refusal.js";
import { expand, hasWildcards } from "../wildcards.js";

export const IMAGE_JOB_V = 1;
export const IMAGE_JOB_CANVASES = Object.freeze([
  Object.freeze([1024, 1024]),
  Object.freeze([1344, 768]),
  Object.freeze([768, 1344]),
]);
export const IMAGE_JOB_REF_CAP = 3;
export const IMAGE_JOB_REF_BYTES_CAP = 8 * 1024 * 1024;
export const IMAGE_JOB_INPUT_BYTES_CAP = 24 * 1024 * 1024;
export const IMAGE_JOB_PROMPT_BYTES_CAP = 8000;
export const IMAGE_JOB_MAX_HOURS = 24 * 14;

const FP_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^o_[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const TOP_KEYS = ["v", "kind", "jobType", "id", "at", "expires", "returnTo", "job"];
const ADDRESS_KEYS = ["fp", "nickname"];
const JOB_KEYS = ["type", "engine", "modelPolicy", "prompt", "seed", "width", "height", "steps", "cfg", "sampler", "scheduler", "count", "refSizing", "draft", "transparent", "negative", "references"];
const REF_KEYS = ["ordinal", "mime", "sha256", "bytes", "b64", "safety"];
const STORED_REF_KEYS = ["ordinal", "mime", "sha256", "bytes", "safety"];
const STORAGE_KEYS = ["v", "sha256"];
const STORAGE_V = 1;
const SAFETY_KEYS = ["minor", "sexual"];
const BUILD_KEYS = ["app", "commit", "protocol"];
const SHA = (bytes) => createHash("sha256").update(bytes).digest("hex");

function refuse(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  error.status = 400;
  return error;
}

function object(value, keys, what, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw refuse("bad-image-job", `${what} must be an object.`);
  }
  const given = Object.keys(value);
  const extra = given.filter((key) => !keys.includes(key) && !optional.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (extra.length || missing.length) {
    throw refuse("bad-image-job", `${what} has ${extra.length ? `unrecognised fields: ${extra.join(", ")}` : `missing fields: ${missing.join(", ")}`}. A peer's request cannot add instructions that this Studio has not agreed to read.`);
  }
}

function pictureMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function checkSafety(value) {
  object(value, SAFETY_KEYS, "Reference safety fingerprint");
  if (typeof value.minor !== "boolean" || typeof value.sexual !== "boolean") {
    throw refuse("bad-reference", "A reference's safety fingerprint needs two booleans. Missing is not the same as false.");
  }
  return { minor: value.minor, sexual: value.sexual };
}

function decodeReference(ref, ordinal, stored = false) {
  object(ref, stored ? STORED_REF_KEYS : REF_KEYS, `Reference ${ordinal}`);
  if (ref.ordinal !== ordinal) throw refuse("bad-reference", "References must be numbered once, in their exact visible order, starting at 1.");
  if (typeof ref.mime !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(ref.mime)) throw refuse("bad-reference", "A reference must be PNG, JPEG or WebP.");
  if (!Number.isInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > IMAGE_JOB_REF_BYTES_CAP) throw refuse("reference-too-large", `Each reference must carry 1–${IMAGE_JOB_REF_BYTES_CAP} bytes.`);
  if (!SHA_RE.test(String(ref.sha256))) throw refuse("reference-hash", "A reference needs a lowercase SHA-256 fingerprint.");
  if (stored) {
    /* The signed wire has already been decoded and verified before this local
     * orderbook summary was written. Its bytes are never accepted from this
     * representation; the lender re-hashes the staged source before render. */
    return { ordinal, mime: ref.mime, sha256: ref.sha256, bytes: ref.bytes,
      safety: checkSafety(ref.safety) };
  }
  if (typeof ref.b64 !== "string" || ref.b64.length > Math.ceil(IMAGE_JOB_REF_BYTES_CAP / 3) * 4) throw refuse("reference-too-large", "A reference's encoded bytes exceed the limit.");
  const bytes = Buffer.from(ref.b64, "base64");
  if (!bytes.length || bytes.toString("base64") !== ref.b64 || bytes.length !== ref.bytes) throw refuse("reference-bytes", "A reference's encoded bytes do not match its declared byte count.");
  if (pictureMime(bytes) !== ref.mime) throw refuse("reference-type", "A reference's claimed image type disagrees with its bytes.");
  if (!SHA_RE.test(String(ref.sha256)) || SHA(bytes) !== ref.sha256) throw refuse("reference-hash", "A reference's bytes disagree with its SHA-256 fingerprint.");
  return { ordinal, mime: ref.mime, sha256: ref.sha256, bytes: bytes.length, b64: ref.b64, safety: checkSafety(ref.safety) };
}

function checkJob(job, safetyContext = [], stored = false) {
  object(job, JOB_KEYS, "Image job");
  if (job.type !== "image" || job.engine !== "qwen-image-2.1" || job.modelPolicy !== "receiver-local-base") {
    throw refuse("model-incompatible", "This job only asks for the receiving Studio's local Qwen Image 2.1 base model. Other engines, exact model files and API models are not part of this wire version.");
  }
  if (typeof job.prompt !== "string" || !job.prompt.trim() || Buffer.byteLength(job.prompt, "utf8") > IMAGE_JOB_PROMPT_BYTES_CAP) throw refuse("bad-prompt", "The full picture prompt must be readable and at most 8,000 UTF-8 bytes.");
  /* /api/image always passes text through expand(), even when no wildcard
   * group exists. Refuse a signed prompt whose actual render text could drift
   * from the words the friend reviewed (including escapes and whitespace). */
  if (hasWildcards(job.prompt) || expand(job.prompt).prompt !== job.prompt) {
    throw refuse("prompt-not-frozen", "Resolve the image prompt to its exact render text before sending it to a friend.");
  }
  if (!Number.isInteger(job.seed) || job.seed < 0 || job.seed > 4294967295) throw refuse("bad-seed", "The picture seed must be a whole number from 0 to 4294967295.");
  if (!IMAGE_JOB_CANVASES.some(([w, h]) => job.width === w && job.height === h)) throw refuse("size-unreproducible", "This image job's canvas is not one of the three fixed Qwen sizes this contract supports.");
  for (const [key, want] of Object.entries({ steps: 25, cfg: 1, sampler: "euler", scheduler: "simple", count: 1, refSizing: "custom", draft: false, transparent: false, negative: "" })) {
    if (job[key] !== want) throw refuse("settings-incompatible", `${key} must be ${JSON.stringify(want)} for this Qwen base job. A setting is refused rather than changed behind the sender's preview.`);
  }
  if (!Array.isArray(job.references) || job.references.length > IMAGE_JOB_REF_CAP) throw refuse("references-count", `This job accepts at most ${IMAGE_JOB_REF_CAP} reference pictures.`);
  const references = job.references.map((ref, index) => decodeReference(ref, index + 1, stored));
  if (references.reduce((n, row) => n + row.bytes, 0) > IMAGE_JOB_INPUT_BYTES_CAP) throw refuse("job-too-large", "The reference pictures exceed the 24 MiB job limit.");
  if (!Array.isArray(safetyContext) || safetyContext.some((text) => typeof text !== "string")) throw refuse("bad-arguments", "Safety context must be a list of source descriptions.");
  assertSafe({ door: "collab.image-job", via: "collab", texts: [job.prompt], context: safetyContext, flags: references.map((ref) => ref.safety) });
  return { ...job, references };
}

/** Build from local request data. Each reference is `{data: Buffer, mime, safety}`.
 * Source names stay local; the wire contains only numbered, hashed bytes. */
export function makeImageJob({ prompt, seed, width, height, references = [], returnTo, now = 0,
  id = null, expiresInHours = 48, safetyContext = [] } = {}) {
  if (!Array.isArray(references) || references.length > IMAGE_JOB_REF_CAP) throw refuse("references-count", `This job accepts at most ${IMAGE_JOB_REF_CAP} reference pictures.`);
  const at = Number(now);
  if (!Number.isSafeInteger(at) || at < 1) throw refuse("bad-arguments", "Pass a positive integer `now` when making an image job.");
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > IMAGE_JOB_MAX_HOURS) throw refuse("bad-expiry", "An image job can expire in 1 hour to 14 days.");
  if (id !== null && !ID_RE.test(String(id))) throw refuse("bad-id", "An image job id is o_ followed by twelve lowercase hexadecimal characters.");
  if (!returnTo || !FP_RE.test(String(returnTo.fp || "")) || typeof returnTo.nickname !== "string" || returnTo.nickname.length > 40 || /[\u0000-\u001f\u007f]/.test(returnTo.nickname)) throw refuse("bad-return-address", "The return address needs this Studio's 32-character fingerprint and a short nickname.");
  const rows = references.map((ref, index) => {
    if (!Buffer.isBuffer(ref?.data)) throw refuse("bad-reference", "Pass each source picture as a Buffer in `data`.");
    if (!ref.data.length || ref.data.length > IMAGE_JOB_REF_BYTES_CAP) throw refuse("reference-too-large", "A source picture must be between 1 byte and 8 MiB.");
    return { ordinal: index + 1, mime: ref.mime, sha256: SHA(ref.data), bytes: ref.data.length,
      b64: ref.data.toString("base64"), safety: ref.safety };
  });
  const order = {
    v: IMAGE_JOB_V, kind: "job-order", jobType: "image",
    id: id || `o_${randomBytes(6).toString("hex")}`, at,
    expires: at + expiresInHours * 3600_000,
    returnTo: { fp: returnTo.fp, nickname: returnTo.nickname },
    job: { type: "image", engine: "qwen-image-2.1", modelPolicy: "receiver-local-base", prompt,
      seed, width, height, steps: 25, cfg: 1, sampler: "euler", scheduler: "simple", count: 1,
      refSizing: "custom", draft: false, transparent: false, negative: "", references: rows },
  };
  return readImageJob(order, { safetyContext });
}

/** Validate a decrypted peer payload. The caller must separately bind the
 * signed envelope sender to `returnTo.fp` and check its own roster/role. */
function readJobFields(payload, { now = 0, myFp = null, safetyContext = [], stored = false } = {}) {
  /* The existing Collab sealer adds a build caption after the order was made.
   * It is a label, never the protocol/compatibility decision. */
  object(payload, stored ? [...TOP_KEYS, "storage"] : TOP_KEYS, "Image job order", ["by"]);
  if (payload.kind !== "job-order" || payload.jobType !== "image" || payload.v !== IMAGE_JOB_V) throw refuse("not-an-image-job", `This is not an image job order version ${IMAGE_JOB_V}.`);
  if (!ID_RE.test(String(payload.id))) throw refuse("bad-id", "An image job id is o_ followed by twelve lowercase hexadecimal characters.");
  if (!Number.isSafeInteger(payload.at) || payload.at < 1 || !Number.isSafeInteger(payload.expires)
      || payload.expires <= payload.at || payload.expires > payload.at + IMAGE_JOB_MAX_HOURS * 3600_000) throw refuse("bad-expiry", "This image job's expiry is missing or exceeds fourteen days.");
  if (now !== 0 && (!Number.isSafeInteger(now) || now < 1)) throw refuse("bad-arguments", "Pass an integer `now` for the receiving clock.");
  if (now && now > payload.expires) throw refuse("order-expired", "This image job has expired. Ask your friend to prepare it again before spending this machine's GPU time.");
  object(payload.returnTo, ADDRESS_KEYS, "Return address");
  if (!FP_RE.test(String(payload.returnTo.fp)) || typeof payload.returnTo.nickname !== "string"
      || payload.returnTo.nickname.length > 40 || /[\u0000-\u001f\u007f]/.test(payload.returnTo.nickname)) throw refuse("bad-return-address", "This image job has no usable return address.");
  if (myFp && payload.returnTo.fp === myFp) throw refuse("order-to-myself", "This job names this very machine as its return address; it is not work for a friend.");
  let by = null;
  if (Object.hasOwn(payload, "by")) {
    object(payload.by, BUILD_KEYS, "Build caption");
    if (typeof payload.by.app !== "string" || payload.by.app.length > 80
        || /[\u0000-\u001f\u007f]/.test(payload.by.app)
        || (payload.by.commit !== null && (typeof payload.by.commit !== "string" || payload.by.commit.length > 80))
        || !Number.isSafeInteger(payload.by.protocol) || payload.by.protocol < 1) {
      throw refuse("bad-image-job", "The build caption has invalid fields.");
    }
    by = { app: payload.by.app, commit: payload.by.commit, protocol: payload.by.protocol };
  }
  const job = checkJob(payload.job, safetyContext, stored);
  return { v: IMAGE_JOB_V, kind: "job-order", jobType: "image", id: payload.id, at: payload.at,
    expires: payload.expires, returnTo: { fp: payload.returnTo.fp, nickname: payload.returnTo.nickname }, job,
    ...(by ? { by } : {}) };
}

export function readImageJob(payload, { now = 0, myFp = null, safetyContext = [] } = {}) {
  return readJobFields(payload, { now, myFp, safetyContext, stored: false });
}

const withoutReferenceBytes = (order) => ({ ...order, job: { ...order.job,
  references: order.job.references.map(({ b64, ...reference }) => reference) } });
const storageDigest = (order) => SHA(Buffer.from(JSON.stringify(order), "utf8"));

/** Make a small, local orderbook record from a fully checked signed-wire job.
 * `storage.sha256` detects accidental row edits; it is not a peer signature.
 * Never send this representation over the courier: `readImageJob` refuses it. */
export function compactImageJob(payload, options = {}) {
  const order = withoutReferenceBytes(readImageJob(payload, options));
  return { ...order, storage: { v: STORAGE_V, sha256: storageDigest(order) } };
}

/** Validate a local orderbook summary. Legacy rows that predate compaction
 * still contain the full wire document and are read with byte verification.
 * New compact rows require the exact storage marker and forbid reference b64. */
export function readStoredImageJob(payload, options = {}) {
  if (!Object.hasOwn(payload || {}, "storage")) {
    return compactImageJob(payload, options);
  }
  const order = readJobFields(payload, { ...options, stored: true });
  object(payload.storage, STORAGE_KEYS, "Image job storage marker");
  if (payload.storage.v !== STORAGE_V || !SHA_RE.test(String(payload.storage.sha256))
      || payload.storage.sha256 !== storageDigest(order)) {
    throw refuse("stored-image-job-changed", "The saved image order no longer matches its validated orderbook summary. Nothing was rendered or received.");
  }
  return { ...order, storage: { v: STORAGE_V, sha256: payload.storage.sha256 } };
}

/** Consent-card text, including the complete prompt rather than a truncated
 * sentence. The receiver's actual model files are chosen locally at accept. */
export function describeImageJob(order) {
  const p = readImageJob(order);
  return `One ${p.job.width}×${p.job.height} opaque PNG on this machine's Qwen Image 2.1 base `
    + `(${p.job.steps} steps, CFG ${p.job.cfg}, seed ${p.job.seed}, ${p.job.references.length} reference picture${p.job.references.length === 1 ? "" : "s"}). `
    + `Your installed Qwen weights may differ from the sender's. The full prompt is: ${p.job.prompt}`;
}
