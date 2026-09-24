// Shared browser/MCP boundary. Native GGUF must never inherit Python fit/FP8
// knobs or MiniMax's reference/preview parameters by silently dropping them.
import { validateGgufRequest, GGUF_DIALS } from "./music/yue-gguf.js";

/* The sampler dials the page and make_song already send for YuE2 (the Python
 * kit's names) → the runtime's own request options they become, read off the
 * one list in yue-gguf.js (GGUF_DIALS). Vendor defaults, from the installed
 * sidecars/yue2-generation-config.json: semantic 1.0 / 0.95, abc 0.7 / 0.9. */
const DIALS = Object.fromEntries(Object.entries(GGUF_DIALS).map(([option, d]) => [d.from, option]));

const KEYS = new Set(["engine", "title", "caption", "lyrics", "instrumental",
  "seed", "cot", "cfgScale", "quantization", "narSteps", "abc",
  "allowSectionLabels", "preview", ...Object.keys(DIALS)]);

/* A song asked for without a seed gets a new one, as every other engine on
 * /api/generate does. It used to be 831001 every time, so an agent's or the
 * chat's make_song gave the same song for the same words. */
const rollSeed = () => Math.floor(Math.random() * 2 ** 32);

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
  // Blank is "not set" (the vendor default holds), as cfgScale treats it.
  const dials = Object.fromEntries(Object.entries(DIALS)
    .filter(([k]) => body[k] != null && body[k] !== "").map(([k, option]) => [option, body[k]]));
  const request = validateGgufRequest({
    style: caption, lyrics: body.instrumental ? "" : (body.lyrics || "").trim(),
    cot: body.cot ?? "full", seed: body.seed ?? rollSeed(), quantization: body.quantization,
    narSteps: body.narSteps ?? 32,
    ...(body.cfgScale != null && body.cfgScale !== "" ? { cfg_scale: body.cfgScale } : {}),
    ...(body.abc != null ? { abc: body.abc } : {}),
    ...dials,
    allowSectionLabels: !!body.allowSectionLabels,
    allowEmptyLyrics: !!body.instrumental,
  });
  const ggufOptions = Object.fromEntries(Object.values(DIALS)
    .filter((option) => request[option] !== undefined).map((option) => [option, request[option]]));
  return {
    engine: "yue2-gguf", actor,
    title: (body.title?.trim() || request.lyrics.split(/\r?\n/).find(Boolean) || "YuE2 GGUF song").slice(0, 120),
    caption: request.style, lyrics: request.lyrics, cot: request.cot, seed: request.seed,
    cfgScale: request.cfg_scale, narSteps: request.narSteps, abc: request.abc,
    quantization: request.quantization, allowSectionLabels: !!body.allowSectionLabels,
    instrumental: !!body.instrumental, preview: false,
    // Only when a dial was set: the runner spreads these into the native request.
    ...(Object.keys(ggufOptions).length ? { ggufOptions } : {}),
    model: request.quantization === "q8_0" ? "YuE2 GGUF Q8" : "YuE2 GGUF Q4", experimental: true,
  };
}
