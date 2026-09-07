/** Shared export/preflight settings. Validate before any render or mutation. */
export const LOUDNESS_SCHEMA = {
  target_lufs: { type: ["number", "null"], minimum: -30, maximum: -6,
    description: "Integrated loudness target (-30 to -6 LUFS); null disables the second pass. Omitted on bounce inherits the project's target." },
  ceiling_db: { type: "number", minimum: -12, maximum: 0,
    description: "True-peak ceiling for the loudness stage, dBTP; default -1." },
  max_limit_db: { type: "number", minimum: 0, maximum: 12,
    description: "Limiter budget in dB; default 3. A lower final loudness is allowed to respect it." },
};

function bounded(value, min, max, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

export function loudnessOptions(body, inheritedTarget = null) {
  const target = body.target_lufs === undefined ? inheritedTarget : body.target_lufs;
  return {
    target_lufs: target === null ? null : bounded(target, -30, -6, "target_lufs"),
    ceiling_db: body.ceiling_db === undefined ? -1 : bounded(body.ceiling_db, -12, 0, "ceiling_db"),
    max_limit_db: body.max_limit_db === undefined ? 3 : bounded(body.max_limit_db, 0, 12, "max_limit_db"),
  };
}

export function bounceOptions(body, inheritedTarget = null) {
  const format = body.format === undefined ? "flac" : body.format;
  if (!["flac", "wav"].includes(format)) throw new Error("format must be flac or wav.");
  const bit_depth = body.bit_depth === undefined ? 24 : body.bit_depth;
  if (![16, 24].includes(bit_depth)) throw new Error("bit_depth must be 16 or 24.");
  return { format, bit_depth, ...loudnessOptions(body, inheritedTarget) };
}
