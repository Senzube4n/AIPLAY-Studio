/** A standalone, signed H3 text-to-video request. No project, scene, graph,
 * local path, custom model or executable instruction crosses this wire. */
import { createHash, randomBytes } from "node:crypto";
import { assertSafe } from "../safety/refusal.js";

export const VIDEO_JOB_V = 1;
export const VIDEO_JOB_MAX_HOURS = 24 * 14;
const FP = /^[0-9a-f]{32}$/;
const ID = /^o_[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const TOP = ["v", "kind", "jobType", "id", "at", "expires", "returnTo", "job"];
const JOB = ["type", "engine", "modelPolicy", "prompt", "seed", "width", "height", "seconds", "steps", "guidance", "keepAudio", "negative", "sparse", "attention", "blockCache", "bridge", "bridgeAlpha", "references", "loras"];
const ADDRESS = ["fp", "nickname"];
const BUILD = ["app", "commit", "protocol"];
const STORAGE = ["v", "sha256"];
const hash = (v) => createHash("sha256").update(v).digest("hex");

function refuse(reason, message) { const e = new Error(message); e.reason = reason; e.status = 400; return e; }
function exact(value, keys, label, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse("bad-video-job", `${label} must be an object.`);
  const extra = Object.keys(value).filter((k) => !keys.includes(k) && !optional.includes(k));
  const missing = keys.filter((k) => !Object.hasOwn(value, k));
  if (extra.length || missing.length) throw refuse("bad-video-job", `${label} has ${extra.length ? `unsupported fields: ${extra.join(", ")}` : `missing fields: ${missing.join(", ")}`}. Nothing was queued.`);
}
function checkJob(job) {
  exact(job, JOB, "Video job");
  if (job.type !== "video" || job.engine !== "h3" || job.modelPolicy !== "receiver-local-base") throw refuse("model-incompatible", "This job only supports the receiving Studio's local MiniMax H3 base engine.");
  if (typeof job.prompt !== "string" || !job.prompt.trim() || job.prompt !== job.prompt.trim() || Buffer.byteLength(job.prompt, "utf8") > 8000) throw refuse("bad-prompt", "Use an exact, nonempty video prompt of at most 8,000 UTF-8 bytes.");
  if (/<\s*(Picture|Audio)\s+\d+\s*>/i.test(job.prompt)) throw refuse("references-unsupported", "This text-only render order has no reference inputs. Remove unanswered Picture and Audio tags.");
  if (!Number.isInteger(job.seed) || job.seed < 0 || job.seed > 4294967295) throw refuse("bad-seed", "The seed must be a whole number from 0 to 4294967295.");
  if (![job.width, job.height].every((n) => Number.isInteger(n) && n >= 256 && n <= 3840 && n % 32 === 0)) throw refuse("size-unreproducible", "For this H3 job, both image sides must be 256–3840 pixels on H3's 32-pixel grid.");
  if (typeof job.seconds !== "number" || !Number.isFinite(job.seconds) || job.seconds < 1 || job.seconds > 20) throw refuse("bad-seconds", "A clip must be 1–20 seconds.");
  if (job.steps !== 20) throw refuse("settings-incompatible", "This base-only friend job uses 20 H3 steps. The 3-, 4- and 8-step modes load different turbo LoRAs, so they need a separate signed model contract.");
  if (job.guidance !== 1) throw refuse("settings-incompatible", "This H3 graph does not consume the Video guidance slider. Leave it at its default 1 for a friend job.");
  if (typeof job.keepAudio !== "boolean") throw refuse("bad-audio", "Choose whether H3's generated audio stays in the clip.");
  for (const [key, want] of Object.entries({ negative: "", sparse: "off", blockCache: false, bridge: "off", bridgeAlpha: 0 })) {
    if (job[key] !== want) throw refuse("settings-incompatible", `${key} must be ${JSON.stringify(want)} in this first text-to-video job. A setting is refused, never silently changed.`);
  }
  if (!["ck", "pytorch"].includes(job.attention)) throw refuse("settings-incompatible", "H3 attention must be CK or PyTorch.");
  if (!Array.isArray(job.references) || job.references.length || !Array.isArray(job.loras) || job.loras.length) throw refuse("references-unsupported", "This job cannot carry references or custom LoRAs.");
  assertSafe({ door: "collab.video-job", via: "collab", texts: [job.prompt] });
  return { ...job, references: [], loras: [] };
}

export function readVideoJob(payload, { now = 0, myFp = null, stored = false } = {}) {
  exact(payload, stored ? [...TOP, "storage"] : TOP, "Video job order", ["by"]);
  if (payload.v !== VIDEO_JOB_V || payload.kind !== "job-order" || payload.jobType !== "video") throw refuse("not-a-video-job", "This is not a supported video job order.");
  if (!ID.test(String(payload.id))) throw refuse("bad-id", "Video job IDs must be o_ plus twelve lowercase hexadecimal characters.");
  if (!Number.isSafeInteger(payload.at) || payload.at < 1 || !Number.isSafeInteger(payload.expires) || payload.expires <= payload.at || payload.expires > payload.at + VIDEO_JOB_MAX_HOURS * 3600_000) throw refuse("bad-expiry", "The job expiry is invalid or exceeds fourteen days.");
  if (now && (!Number.isSafeInteger(now) || now < 1 || now > payload.expires)) throw refuse("order-expired", "This video job expired. Ask for a new preview.");
  exact(payload.returnTo, ADDRESS, "Return address");
  if (!FP.test(String(payload.returnTo.fp)) || typeof payload.returnTo.nickname !== "string" || payload.returnTo.nickname.length > 40 || /[\u0000-\u001f\u007f]/.test(payload.returnTo.nickname)) throw refuse("bad-return-address", "The return address is invalid.");
  if (myFp && payload.returnTo.fp === myFp) throw refuse("order-to-myself", "This job names this machine as its return address.");
  if (payload.by !== undefined) {
    exact(payload.by, BUILD, "Build caption");
    if (typeof payload.by.app !== "string" || payload.by.app.length > 80 || (payload.by.commit !== null && (typeof payload.by.commit !== "string" || payload.by.commit.length > 80)) || !Number.isInteger(payload.by.protocol) || payload.by.protocol < 1) throw refuse("bad-video-job", "The build caption is invalid.");
  }
  const job = checkJob(payload.job);
  const doc = { v: VIDEO_JOB_V, kind: "job-order", jobType: "video", id: payload.id, at: payload.at, expires: payload.expires, returnTo: { ...payload.returnTo }, job, ...(payload.by ? { by: { ...payload.by } } : {}) };
  if (stored) {
    exact(payload.storage, STORAGE, "Storage marker");
    if (payload.storage.v !== 1 || !SHA.test(String(payload.storage.sha256)) || payload.storage.sha256 !== hash(JSON.stringify(doc))) throw refuse("stored-video-job-changed", "The saved video order differs from its checked summary.");
    return { ...doc, storage: { ...payload.storage } };
  }
  return doc;
}

export function compactVideoJob(payload) {
  const doc = readVideoJob(payload);
  return { ...doc, storage: { v: 1, sha256: hash(JSON.stringify(doc)) } };
}
export function readStoredVideoJob(payload, options = {}) { return readVideoJob(payload, { ...options, stored: true }); }
export function makeVideoJob({ prompt, seed, width, height, seconds, steps, guidance, keepAudio, attention = "pytorch", returnTo, now = Date.now(), expiresInHours = 48 } = {}) {
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > VIDEO_JOB_MAX_HOURS) throw refuse("bad-expiry", "Expiry must be one hour to fourteen days.");
  return readVideoJob({ v: VIDEO_JOB_V, kind: "job-order", jobType: "video", id: `o_${randomBytes(6).toString("hex")}`, at: now, expires: now + expiresInHours * 3600_000,
    returnTo, job: { type: "video", engine: "h3", modelPolicy: "receiver-local-base", prompt, seed, width, height, seconds, steps, guidance, keepAudio,
      negative: "", sparse: "off", attention, blockCache: false, bridge: "off", bridgeAlpha: 0, references: [], loras: [] } });
}
export function describeVideoJob(payload) {
  const doc = readVideoJob(payload);
  const j = doc.job;
  return `One MiniMax H3 clip, ${j.width}×${j.height}, ${j.seconds} s, ${j.steps} steps, guidance ${j.guidance}, seed ${j.seed}, ${j.attention === "ck" ? "CK" : "PyTorch"} attention, generated audio ${j.keepAudio ? "kept" : "muted"}. Receiver-local base weights may differ. Full prompt: ${j.prompt}`;
}
