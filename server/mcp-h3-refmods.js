import { h3OptionalOptions } from "./h3-refmod-options.js";

export const H3_OPTIONAL_MCP_INPUTS = {
  ref_mods: { type: "array", maxItems: 8, description: "Optional H3 visual VAE caches from h3_refmod_status. Uses the matched ref2va checkpoint and reference Turbo, with no guaranteed face lock. Unsupported patch combinations are refused.",
    items: { type: "object", required: ["name"], additionalProperties: false, properties: {
      name: { type: "string" }, strength: { type: "number", minimum: 0, maximum: 1, default: 1 }, copies: { type: "integer", minimum: 1, maximum: 4, default: 1 },
    } } },
  ref_mod_options: { type: "object", additionalProperties: false, properties: {
    retention: { type: "number", minimum: 0, maximum: 1, default: 1 }, max_tokens: { type: "integer", minimum: 1, maximum: 65536, default: 8192 },
  }, description: "Optional RefMod master strength and token budget. Compression reduces detail; references still add attention cost." },
  h3_tweaks: { type: "object", additionalProperties: false, description: "Optional Fizgig H3 model patch. All dials default off. Requires the installed node; refused with RefMod, sparse attention, block cache, bridge or video control.", properties: {
    detail: { type: "number", minimum: -1, maximum: 1, default: 0 }, composition: { type: "number", minimum: -0.5, maximum: 0.5, default: 0 },
    prompt_strength: { type: "number", minimum: -0.5, maximum: 3, default: 0 }, detail_mode: { type: "string", enum: ["stable across frames", "per frame"], default: "stable across frames" },
  } },
};

export function h3OptionalMcpBody(args, engine) {
  if (args.ref_mods === undefined && args.ref_mod_options === undefined && args.h3_tweaks === undefined) return {};
  const options = h3OptionalOptions({
    refMods: args.ref_mods,
    refModOptions: args.ref_mod_options ? { retention: args.ref_mod_options.retention, maxTokens: args.ref_mod_options.max_tokens } : undefined,
    h3Tweaks: args.h3_tweaks ? { detail: args.h3_tweaks.detail, composition: args.h3_tweaks.composition,
      promptStrength: args.h3_tweaks.prompt_strength, detailMode: args.h3_tweaks.detail_mode } : undefined,
    sparse: args.sparse, bridge: args.bridge, bridgeAlpha: args.bridge_alpha, sourceVideo: args.source_video,
  }, engine);
  const body = { refMods: options.refMods, refModOptions: options.refModOptions, h3Tweaks: options.h3Tweaks };
  /* Whether these inputs put the render on the reference path (a RefMod
   * does: video-plain.js refsOn, art.js clipSpeedupNeeded, the page's
   * `keeping`), so make_clip takes Keep my character's chips. Not
   * enumerable: it is not spread into the request. Read here, where the
   * inputs are forwarded, so make_clip's own source names none of them
   * (mcp-image_test's census reads a named input as a forwarded one). */
  Object.defineProperty(body, "keeps", { value: Array.isArray(options.refMods) && options.refMods.length > 0 });
  return body;
}

export function h3RefModTools(api) {
  const door = async (body) => { const result = await api("POST", "/api/h3-refmods", body); if (result.error) throw new Error(result.error); return result; };
  return [
    {
      name: "h3_refmod_status", description: "Read the optional RefMod and Fizgig node readiness, validated local visual/audio cache metadata, token counts and source links. Reads headers only and installs nothing. An available visual cache can be supplied to make_clip ref_mods; audio caches are inspected but not rendered by this integration.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: async () => door({ action: "status" }),
    },
    {
      name: "h3_refmod_inspect", description: "Inspect one local RefMod safetensors header: retained latent shapes, reference kinds, token cost and compression mode. This describes cached information, not predicted identity fidelity. Names come from h3_refmod_status.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      run: async (a) => door({ action: "inspect", name: a.name }),
    },
    {
      name: "h3_refmod_create", description: "Queue creation of a reusable H3 visual VAE cache from 1 to 8 existing library images through Studio's shared art queue. Requires an installed compatible ComfyUI-MiniMaxH3Mod and H3 video VAE. No diffusion checkpoint or H3 weight training is involved. encode stores the full resized VAE latent; training pools it and optionally refines reconstruction, losing detail. The token budget fails explicitly rather than discarding images. Existing cache names are refused. Returns the queued job; use studio_status art_queue to follow it and h3_refmod_status after completion.",
      inputSchema: { type: "object", required: ["name", "images"], additionalProperties: false, properties: {
        name: { type: "string", maxLength: 180 }, images: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
        mode: { type: "string", enum: ["encode", "training"], default: "encode" }, resolution: { type: "integer", minimum: 256, maximum: 1024, multipleOf: 64, default: 512 },
        pool: { type: "integer", minimum: 2, maximum: 64, multipleOf: 2, default: 32 }, refinement_steps: { type: "integer", minimum: 0, maximum: 500, default: 0 },
        max_tokens: { type: "integer", minimum: 1, maximum: 65536, default: 8192 }, description: { type: "string", maxLength: 240 },
      } },
      run: async (a) => door({ action: "create", name: a.name, images: a.images, mode: a.mode, resolution: a.resolution, pool: a.pool,
        refinementSteps: a.refinement_steps, maxTokens: a.max_tokens, description: a.description }),
    },
  ];
}
