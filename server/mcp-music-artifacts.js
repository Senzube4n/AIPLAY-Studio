/** Explicit staged reuse; no generation takes place during inspect or prepare. */
export function musicArtifactTools(api) {
  const id = { type: "string", description: "Prepared replay id returned by music_artifact_prepare." };
  return [
    { name: "music_artifacts", description: "List saved Python YuE2 sources and prepared artifact replays. No models are run or installed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: () => api("GET", "/api/music-artifacts") },
    { name: "music_artifact_inspect", description: "Verify a completed library song's saved plan, semantic tokens, latents, manifests, pinned Python runtime and model identities. Returns exact hashes and reuse levels. A changed or incompatible source is refused; GGUF/Comfy runs are outside this adapter.",
      inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false },
      run: a => api("POST", "/api/music-artifacts", { action: "inspect", source: a.source }) },
    { name: "music_artifact_prepare", description: "Freeze and review a replay request without rendering: plan runs a new semantic performance plus synthesis/decoding; semantic reuses tokens and runs synthesis/decoding; latent decodes the same cached acoustic data only. Words, style, score and model identities are frozen. Only the installed listening VAE is supported. No speed or quality improvement is promised. Render explicitly after review.",
      inputSchema: { type: "object", properties: { source: { type: "string" }, stage: { type: "string", enum: ["plan", "semantic", "latent"] },
        seed: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "Plan/semantic only. Omit to retain source seed; latent mode rejects this field." },
        nar_steps: { type: "integer", enum: [16, 32], description: "Plan/semantic synthesis steps only; latent mode rejects this field." },
        vae_core_frames: { type: "integer", enum: [256, 512, 1024], description: "Decoder tile size. Default512; may alter seam arithmetic/memory use." } },
        required: ["source", "stage"], additionalProperties: false },
      run: a => api("POST", "/api/music-artifacts", { action: "prepare", source: a.source, stage: a.stage, seed: a.seed, narSteps: a.nar_steps, vaeCoreFrames: a.vae_core_frames }) },
    { name: "music_artifact_render", description: "Queue one reviewed artifact replay through the normal tracked YuE2 queue. Re-verifies the immutable source and prepared hashes. Repeating this prepared id returns the same exact job rather than spending another render. The original is retained; use status to follow progress and inspect actual stage timings.",
      inputSchema: { type: "object", properties: { prepared_id: id }, required: ["prepared_id"], additionalProperties: false },
      run: a => api("POST", "/api/music-artifacts", { action: "render", preparedId: a.prepared_id }, 900_000) },
    { name: "music_artifact_status", description: "Read the prepared replay's exact job, state and resulting filename. Missing history is reported, not silently resubmitted.",
      inputSchema: { type: "object", properties: { prepared_id: id }, required: ["prepared_id"], additionalProperties: false },
      run: a => api("POST", "/api/music-artifacts", { action: "status", preparedId: a.prepared_id }) },
    { name: "music_artifact_cancel", description: "Cancel only this replay's owned queue job, or cancel an unsubmitted preparation. Source artifacts remain intact. A cancellation refusal remains visible while the job stays live.",
      inputSchema: { type: "object", properties: { prepared_id: id }, required: ["prepared_id"], additionalProperties: false },
      run: a => api("POST", "/api/music-artifacts", { action: "cancel", preparedId: a.prepared_id }) },
  ];
}
