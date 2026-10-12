/** Optional H3 reference caches and Fizgig controls. Pure and shared by the graph/API. */
export const REFMOD_NODES = Object.freeze({ loader: "MiniMaxH3RefModsLoader", apply: "MiniMaxH3RefModApply", extract: "MiniMaxH3RefModExtract" });
export const FIZGIG_NODE = "FizgigH3Tweaks";
export const REFMOD_LIMITS = Object.freeze({ slots: 8, copies: 4, maxTokens: 65536, defaultTokens: 8192, headerBytes: 1048576, fileBytes: 268435456, files: 512, dirs: 128, entries: 2048 });
export const FIZGIG_MODES = Object.freeze(["stable across frames", "per frame"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}
function keys(value, allowed, label) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${label} has an unknown field: ${extra}.`);
}
export function boundedNumber(value, fallback, low, high, label, integer = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} from ${low} to ${high}.`);
  }
  return value;
}

/** Names are ComfyUI dropdown identifiers, never arbitrary local paths. */
export function refModName(value) {
  if (typeof value !== "string" || !value || value.length > 180 || /[\x00-\x1f:<>"|?*]/.test(value)) throw new Error("RefMod name must be a relative cache name.");
  const name = value.replace(/\\/g, "/").replace(/\.safetensors$/i, "");
  const parts = name.split("/");
  if (parts.length > 6 || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("RefMod name must stay inside the reference-cache folder.");
  }
  return name;
}

export function normalizeRefMods(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > REFMOD_LIMITS.slots) throw new Error(`refMods must contain at most ${REFMOD_LIMITS.slots} caches.`);
  return value.map((row, index) => {
    object(row, `refMods[${index}]`);
    keys(row, ["name", "strength", "copies"], "RefMod");
    return { name: refModName(row.name), strength: boundedNumber(row.strength, 1, 0, 1, "RefMod strength"),
      copies: boundedNumber(row.copies, 1, 1, REFMOD_LIMITS.copies, "RefMod copies", true) };
  }).filter((row) => row.strength > 0);
}

export function normalizeRefModOptions(value) {
  if (value === undefined || value === null) value = {};
  object(value, "refModOptions");
  keys(value, ["retention", "maxTokens"], "refModOptions");
  return { retention: boundedNumber(value.retention, 1, 0, 1, "RefMod retention"),
    maxTokens: boundedNumber(value.maxTokens, REFMOD_LIMITS.defaultTokens, 1, REFMOD_LIMITS.maxTokens, "RefMod token budget", true) };
}

/** All numeric defaults are zero: enabling the pack is never a global texture change. */
export function normalizeH3Tweaks(value) {
  if (value === undefined || value === null || value === false) return null;
  object(value, "h3Tweaks");
  keys(value, ["detail", "composition", "promptStrength", "detailMode"], "h3Tweaks");
  const out = { detail: boundedNumber(value.detail, 0, -1, 1, "Fizgig detail"),
    composition: boundedNumber(value.composition, 0, -0.5, 0.5, "Fizgig composition"),
    promptStrength: boundedNumber(value.promptStrength, 0, -0.5, 3, "Fizgig prompt strength"),
    detailMode: value.detailMode ?? FIZGIG_MODES[0] };
  if (!FIZGIG_MODES.includes(out.detailMode)) throw new Error("Fizgig detailMode must be stable across frames or per frame.");
  return out.detail || out.composition || out.promptStrength ? out : null;
}

/** RefMod is a conditioning addition. Model-hook patch combinations need their own validation. */
export function h3OptionalOptions(request = {}, engine = request.engine || "h3") {
  const refMods = normalizeRefMods(request.refMods);
  const refModOptions = normalizeRefModOptions(request.refModOptions);
  const h3Tweaks = normalizeH3Tweaks(request.h3Tweaks);
  const activeRefs = refModOptions.retention > 0 ? refMods : [];
  if (activeRefs.length || h3Tweaks) {
    if (engine !== "h3") throw new Error("RefMod caches and Fizgig tweaks require MiniMax H3.");
    if (request.continueFrom || request.sourceVideo || request.source_video || request.controlVideo || request.controlPatch) throw new Error("RefMod and Fizgig are not validated with continuation or video control.");
    if (request.sparse === "sol-attn" || request.blockCache === true) throw new Error("Turn sparse attention and block cache off for RefMod or Fizgig.");
    if (request.bridge && request.bridge !== "off" && request.bridgeAlpha !== 0) throw new Error("Turn the conditioning bridge off for RefMod or Fizgig.");
    if (activeRefs.length && h3Tweaks) throw new Error("Use RefMod or Fizgig in one render; their combination is not validated.");
  }
  return { refMods: activeRefs, refModOptions, h3Tweaks };
}

export function refModLoaderInputs(refMods, options) {
  const inputs = { show_info: false, max_total_tokens: options.maxTokens };
  for (let slot = 1; slot <= REFMOD_LIMITS.slots; slot++) {
    const row = refMods[slot - 1];
    Object.assign(inputs, { [`mod_${slot}`]: row?.name ?? "(none)", [`strength_${slot}`]: row?.strength ?? 1, [`copies_${slot}`]: row?.copies ?? 1 });
  }
  return inputs;
}

export function refModApplyInputs(conditioning, mods, options) {
  return { conditioning, mods, override: false, retention: options.retention, curve_direction: "constant", curve_shape: "linear",
    curve_value: 1, scramble_seed: -1, max_total_tokens: options.maxTokens };
}
