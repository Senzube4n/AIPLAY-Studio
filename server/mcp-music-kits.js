/** Rendering is a separate tool so tool-level consent distinguishes planning
 * from spending the generation queue. Both tools use the same HTTP service. */
export function musicKitTools(api) {
  const defined = body => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  const identity = { type: "string", pattern: "^kit-[0-9a-f]{24}$" };
  const idempotency = { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$", description: "Reuse the same key only to retry this exact action." };
  const common = { id: identity, expectedRevision: { type: "integer", minimum: 1 } };
  return [{
    name: "music_kit",
    description: "Save and review musical identity kits without generating audio. Freezes ABC, chord timeline, lyrics, style, seed, backend and available source receipt metadata. keep_melody removes chord annotations while preserving written notes; keep_score reuses notation with a new style; revise requires new ABC. Save opening/tension/closing variants. prepare returns an exact request for explicit music_kit_render. No singer, waveform, instrumentation or duration guarantee. Native GGUF currently requires lyrics.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["list", "get", "create", "update", "preview_variant", "save_variant", "prepare", "refresh_job"] },
      ...common, idempotencyKey: idempotency, name: { type: "string", maxLength: 120 }, theme: { type: "string", maxLength: 2000 },
      sourceScore: { type: "object", additionalProperties: false, required: ["slug", "version"], properties: { slug: { type: "string" }, version: { type: "string" } } },
      abc: { type: "string", maxLength: 65536, description: "ABC source on create, or explicitly revised composition; do not combine with sourceScore." },
      style: { type: "string", maxLength: 2000 }, lyrics: { type: "string", maxLength: 8000 }, instrumental: { type: "boolean" },
      seed: { type: "integer", minimum: 0, maximum: 4294967295 }, engine: { type: "string", enum: ["yue2", "yue2-gguf"] },
      quantization: { type: "string", enum: ["none", "fp8", "q4_0", "q8_0"] },
      baseVariantId: { type: "string", description: "Source variant, default theme." },
      mode: { type: "string", enum: ["keep_melody", "keep_score", "revise"] }, role: { type: "string", enum: ["opening", "tension", "closing"] },
      variantId: { type: "string" }, title: { type: "string", maxLength: 120 }, renderId: { type: "string" },
    } },
    run: a => {
      // The dispatcher does not enforce JSON Schema; never let this planning
      // tool smuggle a render action past the separate render permission gate.
      if (!["list", "get", "create", "update", "preview_variant", "save_variant", "prepare", "refresh_job"].includes(a?.action)) throw new Error("Choose a music_kit planning action. Rendering uses music_kit_render.");
      if (a.action === "list" || a.action === "get") {
        if (Object.keys(a).some(k => !["action", ...(a.action === "get" ? ["id"] : [])].includes(k))) throw new Error("Unsupported read-only kit fields.");
        if (a.action === "get" && !/^kit-[0-9a-f]{24}$/.test(a.id || "")) throw new Error("Choose a valid music kit id.");
        return api("GET", a.action === "list" ? "/api/music-kits" : `/api/music-kits?id=${encodeURIComponent(a.id)}`);
      }
      const body = {
        action: a.action, id: a.id, expectedRevision: a.expectedRevision,
        idempotencyKey: a.idempotencyKey, name: a.name, theme: a.theme,
        sourceScore: a.sourceScore, abc: a.abc, style: a.style, lyrics: a.lyrics,
        instrumental: a.instrumental, seed: a.seed, engine: a.engine,
        quantization: a.quantization, baseVariantId: a.baseVariantId,
        mode: a.mode, role: a.role, variantId: a.variantId, title: a.title, renderId: a.renderId,
      };
      if (Object.keys(a).some(key => !Object.hasOwn(body, key))) throw new Error("Unsupported music kit fields.");
      return api("POST", "/api/music-kits", defined(body));
    },
  }, {
    name: "music_kit_render",
    description: "Generate a NEW take from the exact persisted request reviewed with music_kit prepare. This spends the generation queue. Requires preparedId, current kit revision and an idempotency key; retry returns the original submission instead of another job. Poll music_kit refresh_job using the render id. No original singer, waveform or audio-duration guarantee.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "expectedRevision", "preparedId", "idempotencyKey"], properties: {
      ...common, preparedId: { type: "string" }, idempotencyKey: idempotency,
    } },
    run: a => {
      const body = { id: a.id, expectedRevision: a.expectedRevision,
        preparedId: a.preparedId, idempotencyKey: a.idempotencyKey };
      if (Object.keys(a).some(key => !Object.hasOwn(body, key))) throw new Error("Unsupported music kit render fields.");
      return api("POST", "/api/music-kits", { action: "render", ...defined(body) });
    },
  }];
}
