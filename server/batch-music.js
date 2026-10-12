/** Typed Overnight snapshots. Rendering still passes through the ordinary song door. */
import { MUSIC_BATCH_FIELDS, musicBatchIdea } from "../web/music-batch-spec.js";
import { prepareGgufJob } from "./music-gguf-input.js";
import { yue2ComfyFields } from "./music/yue2-comfy-input.js";
import { deriveTitle } from "./workflow.js";

const known = new Set(Object.values(MUSIC_BATCH_FIELDS).flat());
const numbers = {
  maxDuration: [1, 983], steps: [1, 100, true], arCfg: [0, 20], flowCfg: [0, 20], cfg: [0, 20],
  audioRefDenoise: [.05, 1], narSteps: [1, 256, true], cfgScale: [0, 20],
  temperature: [0, 5], topP: [.01, 1], topK: [1, 32768, true], repetitionPenalty: [.01, 10],
  planTemperature: [0, 5], planTopP: [.01, 1], bpm: [30, 300, true],
  loraStrength: [-4, 4], loraClipStrength: [-4, 4], aceSteps: [1, 100, true], aceCfg: [.01, 20], acePlanTemp: [0, 2],
};
const strings = { title: 120, caption: 10000, lyrics: 20000, abc: 65536, key: 16, meter: 8,
  keyscale: 40, timesignature: 8, language: 16, scoreSlug: 80, scoreVersion: 40, model: 32,
  quantization: 16, cot: 16, checkpoint: 200, lora: 200, loraClip: 200, audioRef: 200 };

function bounded(value, low, high, integer, key) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) {
    throw new Error(`Music ${key} must be ${integer ? "an integer" : "a number"} from ${low} to ${high}.`);
  }
}
function reference(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Music ${kind} must be a reference object.`);
  const keys = kind === "coverOf" ? ["file", "seconds", "stem"] : ["upload", "song"];
  if (Object.keys(value).some(k => !keys.includes(k))) throw new Error(`Music ${kind} has unsupported fields.`);
  if (kind === "aceCover" && (Object.hasOwn(value, "upload") === Object.hasOwn(value, "song"))) throw new Error("Choose one ACE cover source.");
  const file = kind === "coverOf" ? value.file : value.upload ?? value.song;
  if (typeof file !== "string" || !file || file.length > 200 || /[\\/\0]|\.\./.test(file)) throw new Error(`Music ${kind} needs a library or uploaded filename.`);
  if (value.seconds !== undefined) bounded(value.seconds, 1, 30, false, "cover seconds");
  if (value.stem !== undefined && !["vocals", "drums", "bass", "other", "guitar", "piano"].includes(value.stem)) throw new Error("Choose a supported cover stem.");
}

export function cleanMusicItem(raw, { defaultEngine = "minimax-music3" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A music idea must be an object.");
  const engine = raw.engine === undefined ? defaultEngine : raw.engine;
  if (typeof engine !== "string" || !Object.hasOwn(MUSIC_BATCH_FIELDS, engine)) throw new Error("Unknown music engine.");
  const allowed = new Set(MUSIC_BATCH_FIELDS[engine]);
  const unsupported = Object.keys(raw).filter(k => known.has(k) && !allowed.has(k) && raw[k] !== undefined);
  if (unsupported.length) throw new Error(`${engine} Overnight does not support: ${unsupported.join(", ")}.`);
  if (raw.preview === true) throw new Error("Overnight queues complete songs; previews are not supported.");
  const item = musicBatchIdea(raw, engine);
  for (const [key, limit] of Object.entries(strings)) if (item[key] !== undefined) {
    if (typeof item[key] !== "string" || item[key].length > limit || item[key].includes("\0")) throw new Error(`Music ${key} must be text of at most ${limit} characters, without NUL.`);
  }
  for (const key of ["instrumental", "allowSectionLabels", "abcOpen", "aceCodes"]) if (item[key] !== undefined && typeof item[key] !== "boolean") throw new Error(`Music ${key} must be a boolean.`);
  for (const [key, [low, high, integer]] of Object.entries(numbers)) if (item[key] !== undefined) bounded(item[key], low, high, integer, key);
  for (const key of ["checkpoint", "lora", "loraClip", "audioRef"]) if (item[key] && /\0|^[\\/]|^[a-z]:|(^|[\\/])\.{1,2}([\\/]|$)/i.test(item[key])) throw new Error(`Music ${key} must be a relative model or reference filename.`);
  if (item.audioRef !== undefined && !/^[\w.-]+\.latent$/.test(item.audioRef)) throw new Error("Music audioRef must be an encoded .latent filename.");
  if (item.cot !== undefined && !["full", "melody", "off"].includes(item.cot)) throw new Error("Music cot must be full, melody or off.");
  if (item.quantization !== undefined && !(engine === "yue2-gguf" ? ["q4_0", "q8_0"] : ["none", "fp8"]).includes(item.quantization)) throw new Error("Choose a precision supported by this music engine.");
  if (item.model !== undefined && !["int8", "fp16", "fp32"].includes(item.model)) throw new Error("Choose a supported MiniMax model precision.");
  if (item.abc !== undefined && Buffer.byteLength(item.abc) > 65536) throw new Error("Music ABC must fit within 64 KiB.");
  if (item.coverOf !== undefined) reference(item.coverOf, "coverOf");
  if (item.aceCover !== undefined) reference(item.aceCover, "aceCover");
  if (!item.caption?.trim()) throw new Error("Add a style description.");
  item.caption = item.caption.trim();
  item.lyrics ??= "";
  item.instrumental ??= false;
  item.title = item.title?.trim() || deriveTitle({ lyrics: item.lyrics, caption: item.caption });
  if (engine === "yue2-gguf") prepareGgufJob({ ...item, seed: 0 }, "system");
  if (engine === "yue2-comfy") yue2ComfyFields(item, { cot: item.cot ?? "full" });
  if (item.abc && item.cot === "off") throw new Error("A supplied score needs Thinking full or melody.");
  if (engine === "yue2" && item.narSteps !== undefined && ![16, 32].includes(item.narSteps)) throw new Error("Python YuE2 supports 16 or 32 audio steps.");
  if (engine === "yue2-comfy" && item.narSteps !== undefined && (item.narSteps < 8 || item.narSteps > 64)) throw new Error("ComfyUI YuE2 audio steps must be 8 to 64.");
  return item;
}
