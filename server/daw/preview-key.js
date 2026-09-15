/** Stable identity for the effective one-note audio job shared by both audition doors. */
import { createHash } from "node:crypto";

// A preview name never embeds paths, arbitrary text, timestamps or an output destination.
// The version prevents a new job from trusting an older incomplete cache identity.
const VERSION = "v2";

function canonical(value, budget, depth = 0) {
  if (++budget.nodes > 16384 || depth > 32) throw new Error("Preview job metadata is too large.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Preview job metadata must contain finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (value.length > 32768 || value.includes("\0")) throw new Error("Invalid preview job text.");
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 256 * 1024) throw new Error("Preview job metadata is too large.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonical(item, budget, depth + 1));
  if (!value || typeof value !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid preview job metadata.");
  const out = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > 256 * 1024) throw new Error("Preview job metadata is too large.");
    // The engine receives JSON: absent/undefined object fields are equivalent.
    if (value[key] !== undefined) out[key] = canonical(value[key], budget, depth + 1);
  }
  return out;
}

/**
 * Hash the job that will actually reach Python, not the caller's musical tick count.
 * Canonical object order shares equivalent params/mixer maps; array order remains audible.
 * The caller has already normalized patch params and mixer values through the store.
 */
export function previewAudioKey(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)
    || !Array.isArray(job.notes) || job.notes.length !== 1) throw new Error("A preview key requires one note.");
  const note = job.notes[0];
  if (!note || typeof note.inst !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(note.inst)) {
    throw new Error("Invalid preview patch id.");
  }
  for (const [name, value] of [["sample rate", job.sr], ["window", job.n_samples], ["note duration", note.dur_samples]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid preview ${name}.`);
  }
  if (job.start_sample !== 0 || note.start_sample !== 0) throw new Error("An audition must start at sample zero.");
  if (!Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127
    || !Number.isInteger(note.vel) || note.vel < 1 || note.vel > 127
    || !Number.isFinite(note.gain_db ?? 0)
    || !Number.isSafeInteger(note.seed ?? 0)) throw new Error("Invalid preview note values.");
  // Do not truncate gain to tenths of a dB: the renderer receives the exact gain.
  const effective = {
    sr: job.sr, start_sample: 0, n_samples: job.n_samples,
    instruments_dir: job.instruments_dir ?? null,
    notes: [{ ...note, params: note.params ?? {}, gain_db: note.gain_db ?? 0, seed: (note.seed ?? 0) >>> 0 }],
    mixer: job.mixer ?? null,
  };
  const serialized = JSON.stringify(canonical(effective, { nodes: 0, bytes: 0 }));
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("Preview job metadata is too large.");
  return `${VERSION}_${createHash("sha256").update(serialized).digest("hex").slice(0, 24)}`;
}
