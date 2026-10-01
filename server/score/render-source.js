/** Keep a score render on its saved engine, checkpoint and audio settings. */
import { requireModelName } from "../localmodels.js";
import { yue2ComfyFields } from "../music/yue2-comfy-input.js";

export function scoreRenderSource(version, args = {}) {
  const source = version?.source;
  if (!source) {
    if (version?.producer === "aiplay-yue2-comfy-score-v1") throw new Error("This ComfyUI score has no saved source settings. Use Create to choose its engine and checkpoint explicitly.");
    return { engine: "yue2" }; // Existing Python runs and score-only drafts.
  }
  if (source.engine === "yue2") return { engine: "yue2" };
  if (source.engine !== "yue2-comfy") throw new Error(`This score's saved engine (${source.engine || "unknown"}) is not supported by score_render. Use Create to choose a supported YuE2 engine explicitly.`);
  if (Object.hasOwn(args, "cfg_scale")) throw new Error("The saved ComfyUI score has no Guidance control. Omit cfg_scale, or use Create to choose Python YuE2 explicitly.");
  if (!source.checkpoint) throw new Error("This ComfyUI score has no saved checkpoint. Use Create to choose one explicitly.");
  const settings = { ...(source.settings || {}), ...(version.request || {}) };
  if (!Object.hasOwn(settings, "lora") || !Object.hasOwn(settings, "loraClip")
    || !Number.isInteger(settings.narSteps) || settings.narSteps < 8 || settings.narSteps > 64
    || !settings.sampling || ["temperature", "top_p", "top_k", "repetition_penalty"].some(key => !Number.isFinite(settings.sampling[key])))
    throw new Error("This ComfyUI score has incomplete saved sampler or LoRA settings. Use Create to review them explicitly.");
  const lora = settings.lora ? requireModelName(settings.lora) : "";
  const loraClip = settings.loraClip ? requireModelName(settings.loraClip) : "";
  for (const [name, strength] of [[lora, settings.loraStrength], [loraClip, settings.loraClipStrength]]) {
    if (name && (!Number.isFinite(strength) || strength < -4 || strength > 4)) throw new Error("This ComfyUI score has no valid saved LoRA strength. Use Create to review it explicitly.");
  }
  const out = {
    engine: "yue2-comfy", checkpoint: requireModelName(source.checkpoint),
    // Explicit empty slots keep unrelated current Music preferences out.
    lora, loraStrength: lora ? settings.loraStrength : undefined,
    loraClip, loraClipStrength: loraClip ? settings.loraClipStrength : undefined,
    narSteps: settings.narSteps,
    temperature: settings.sampling.temperature, topP: settings.sampling.top_p,
    topK: settings.sampling.top_k, repetitionPenalty: settings.sampling.repetition_penalty,
  };
  yue2ComfyFields(out, { cot: "full" }); // Use the generation door's ranges.
  return out;
}
