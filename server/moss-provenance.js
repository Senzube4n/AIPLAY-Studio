/** Optional content adapters have their own terms, beyond the SFT base's.
 * Called only when a new completed image enters the library. Old ledger lines
 * are evidence of what was known then and are never reclassified here. */
import { CATALOG, rightsRank, rightsStampFor } from "./models.js";
import { MOSS_HIRES_ADAPTER, MOSS_UNCENSORED_ADAPTER } from "./moss-presets.js";

const pinFields = ["repo", "revision", "filename", "sha256", "strength", "clipStrength", "trigger"];
export function mossGenerationProvenance(engine, options = {}) {
  if (engine !== "moss-image") return {};
  const adapter = options?.adapter;
  const pin = options?.mossPreset === "moss-hires-v03" || adapter?.filename === MOSS_HIRES_ADAPTER.filename ? MOSS_HIRES_ADAPTER
    : options?.mossPreset === "nsfw-uncensored" || adapter?.filename === MOSS_UNCENSORED_ADAPTER.filename ? MOSS_UNCENSORED_ADAPTER : null;
  if (!pin) return {};
  const row = CATALOG.find((cap) => cap.id === pin.catalogueId);
  const base = rightsStampFor(engine);
  const adapterRights = { class: row?.outputRights?.class || "unknown", capability: pin.catalogueId,
    url: row?.outputRights?.url || `https://huggingface.co/${pin.repo}/tree/${pin.revision}` };
  /* Do not let incomplete or inconsistent metadata fall through to the base's
   * unrestricted stamp. These are actual completion fields, not a new claim
   * that this function verified a file, recipe or hash. */
  return {
    mossPreset: typeof options.mossPreset === "string" ? options.mossPreset : null,
    mossRecipe: typeof options.mossRecipe === "string" ? options.mossRecipe : null,
    adapter: adapter && typeof adapter === "object"
      ? Object.fromEntries(pinFields.filter((key) => adapter[key] !== undefined).map((key) => [key, adapter[key]])) : null,
    adapterVerifiedSha256: typeof options.adapterVerifiedSha256 === "string" ? options.adapterVerifiedSha256 : null,
    outputRights: {
      ...(rightsRank(adapterRights.class) >= rightsRank(base.class) ? adapterRights : base),
      addOns: [pin.catalogueId],
    },
  };
}
