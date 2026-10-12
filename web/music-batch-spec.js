/** Music request fields that survive an unattended idea. No runtime/job metadata. */
const common = ["title", "caption", "lyrics", "instrumental"];
const score = ["cot", "narSteps", "abc", "allowSectionLabels", "temperature", "topP", "planTemperature", "planTopP"];
const sampler = ["topK", "repetitionPenalty", "scoreSlug", "scoreVersion"];
export const MUSIC_BATCH_FIELDS = Object.freeze({
  "minimax-music3": Object.freeze([...common, "maxDuration", "model", "steps", "arCfg", "flowCfg", "cfg", "audioRef", "audioRefDenoise"]),
  yue2: Object.freeze([...common, ...score, ...sampler, "maxDuration", "cfgScale", "quantization", "abcOpen", "key", "bpm", "meter", "coverOf"]),
  "yue2-gguf": Object.freeze([...common, ...score, "cfgScale", "quantization"]),
  "yue2-comfy": Object.freeze([...common, ...score, ...sampler, "maxDuration", "checkpoint", "lora", "loraStrength", "loraClip", "loraClipStrength", "cfgScale"]),
  "ace-step15": Object.freeze([...common, "maxDuration", "bpm", "key", "meter", "keyscale", "timesignature", "language", "aceSteps", "aceCfg", "aceCodes", "acePlanTemp", "lora", "loraStrength", "aceCover"]),
});

/** Snapshot the form's valid engine fields; seeds are rolled per take by Overnight. */
export function musicBatchIdea(spec, engine = spec?.engine || "minimax-music3") {
  if (!Object.hasOwn(MUSIC_BATCH_FIELDS, engine)) throw new Error("Choose a supported music engine.");
  const idea = { engine };
  for (const key of MUSIC_BATCH_FIELDS[engine]) if (spec[key] !== undefined) {
    idea[key] = typeof spec[key] === "object" && spec[key] !== null ? structuredClone(spec[key]) : spec[key];
  }
  return idea;
}
