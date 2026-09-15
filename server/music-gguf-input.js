// Shared browser/MCP boundary. Native GGUF must never inherit Python fit/FP8
// knobs or MiniMax's reference/preview parameters by silently dropping them.
import { validateGgufRequest } from "./music/yue-gguf.js";

const KEYS = new Set(["engine", "title", "caption", "lyrics", "instrumental",
  "seed", "cot", "cfgScale", "quantization", "narSteps", "abc",
  "allowSectionLabels", "preview"]);
export function prepareGgufJob(body, actor) {
  const unsupported = Object.keys(body).filter((k) => !KEYS.has(k) && body[k] !== undefined);
  if (unsupported.length) throw new Error(`YuE2 GGUF does not support: ${unsupported.join(", ")}. Nothing was queued.`);
  if (body.preview) throw new Error("YuE2 GGUF has no cheap preview. Use a full render.");
  if (body.instrumental === true) throw new Error("Native YuE2 GGUF requires nonempty lyrics; instrumental mode is not supported by this runtime.");
  if (typeof body.caption !== "string" || !body.caption.trim()) throw new Error("Add a style description.");
  if (body.title != null && typeof body.title !== "string") throw new Error("Title must be text.");
  if (body.lyrics != null && typeof body.lyrics !== "string") throw new Error("Lyrics must be text.");
  for (const k of ["instrumental", "allowSectionLabels", "preview"]) {
    if (body[k] != null && typeof body[k] !== "boolean") throw new Error(`${k} must be a boolean.`);
  }
  const caption = body.instrumental
    ? `${body.caption.trim()}. Instrumental, no vocals, no singing, no voice.` : body.caption.trim();
  const request = validateGgufRequest({
    style: caption, lyrics: body.instrumental ? "" : (body.lyrics || "").trim(),
    cot: body.cot ?? "full", seed: body.seed ?? 831001, quantization: body.quantization,
    narSteps: body.narSteps ?? 32,
    ...(body.cfgScale != null && body.cfgScale !== "" ? { cfg_scale: body.cfgScale } : {}),
    ...(body.abc != null ? { abc: body.abc } : {}),
    allowSectionLabels: !!body.allowSectionLabels,
    allowEmptyLyrics: !!body.instrumental,
  });
  return {
    engine: "yue2-gguf", actor,
    title: (body.title?.trim() || request.lyrics.split(/\r?\n/).find(Boolean) || "YuE2 GGUF song").slice(0, 120),
    caption: request.style, lyrics: request.lyrics, cot: request.cot, seed: request.seed,
    cfgScale: request.cfg_scale, narSteps: request.narSteps, abc: request.abc,
    quantization: request.quantization, allowSectionLabels: !!body.allowSectionLabels,
    instrumental: !!body.instrumental, preview: false,
    model: request.quantization === "q8_0" ? "YuE2 GGUF Q8" : "YuE2 GGUF Q4", experimental: true,
  };
}
