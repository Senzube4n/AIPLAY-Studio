/** Separate generation tool lets MCP consent distinguish planning from GPU work. */
export function musicListeningLabTools(api) {
  const region = { type: "object", additionalProperties: false, required: ["file", "startSeconds", "seconds"], properties: {
    file: { type: "string" }, startSeconds: { type: "number", minimum: 0 }, seconds: { type: "number", minimum: .25 } } };
  const seed = { type: "integer", minimum: 0, maximum: 4294967295 };
  const identity = { type: "string", pattern: "^lab-[a-f0-9]{24}$" };
  const revision = { type: "integer", minimum: 1 };
  const token = { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" };
  const defined = body => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  return [{
    name: "music_listening_lab",
    description: "Plan and review paired base-versus-trained-LoRA listening experiments using installed compatible ComfyUI YuE2 MODEL adapters. create saves 1–8 evaluation cases separately from the training region without rendering. Each pair shares prompt, seed and solver settings; explicit empty planner adapters prevent saved settings leaking in. Labels A/B are hidden in this lab until reveal; Studio queue/provenance still expose settings. rate records the listener's own 1–5 ratings, preference and unwanted changes; never infer quality or listening from loss/metrics. refresh reconciles exact job receipts; cancel affects only this experiment. Separate music_listening_lab_start submits the reviewed pairs. No singer, waveform or duration guarantee.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["list", "get", "create", "refresh", "cancel", "rate", "reveal"] },
      id: identity, expectedRevision: revision, idempotencyKey: token,
      name: { type: "string", maxLength: 120 }, purpose: { type: "string", maxLength: 2000 },
      adapter: { type: "string", description: "Installed compatible adapter name from list capabilities." },
      checkpoint: { type: "string", description: "Installed checkpoint name from list capabilities." },
      strength: { type: "number", minimum: -4, maximum: 4, description: "Must be nonzero; default 1." },
      trainingSource: region,
      cases: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false,
        required: ["name", "caption", "seed"], properties: {
          name: { type: "string", maxLength: 120 }, caption: { type: "string", maxLength: 2000 }, lyrics: { type: "string", maxLength: 8000 },
          seed, maxDuration: { type: "number", minimum: 30, maximum: 300 }, narSteps: { type: "integer", minimum: 8, maximum: 64 },
          cot: { type: "string", enum: ["full", "melody", "off"] }, instrumental: { type: "boolean" }, reference: region,
        } } },
      caseId: { type: "string" }, preference: { type: "string", enum: ["A", "B", "tie", "neither"] },
      ratings: { type: "object", additionalProperties: false, required: ["A", "B"], properties: {
        A: { type: "integer", minimum: 1, maximum: 5 }, B: { type: "integer", minimum: 1, maximum: 5 } } },
      unwantedChanges: { type: "object", additionalProperties: false, properties: { A: { type: "string", maxLength: 2000 }, B: { type: "string", maxLength: 2000 } } },
      notes: { type: "string", maxLength: 4000 },
    } },
    run(a) {
      if (!["list", "get", "create", "refresh", "cancel", "rate", "reveal"].includes(a.action)) throw new Error("Rendering requires music_listening_lab_start.");
      const body = { action: a.action, id: a.id, expectedRevision: a.expectedRevision, idempotencyKey: a.idempotencyKey,
        name: a.name, purpose: a.purpose, adapter: a.adapter, checkpoint: a.checkpoint, strength: a.strength,
        trainingSource: a.trainingSource, cases: a.cases, caseId: a.caseId, preference: a.preference,
        ratings: a.ratings, unwantedChanges: a.unwantedChanges, notes: a.notes };
      if (Object.keys(a).some(k => !Object.hasOwn(body, k))) throw new Error("Unsupported listening lab field.");
      return api("POST", "/api/music-listening-lab", defined(body), 900_000);
    },
  }, {
    name: "music_listening_lab_start",
    description: "Submit the saved listening experiment: TWO real music renders per evaluation case, using the installed checkpoint and trained adapter. Explicit generation consent is required. Reuse the same idempotency key to retry safely; an uncertain receipt is never automatically resubmitted. Follow music_listening_lab refresh, audition the paired audio, record your own observations, then explicitly reveal A/B identities.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "expectedRevision", "idempotencyKey"], properties: {
      id: identity, expectedRevision: revision, idempotencyKey: token,
    } },
    run(a) {
      const body = { id: a.id, expectedRevision: a.expectedRevision, idempotencyKey: a.idempotencyKey };
      if (Object.keys(a).some(k => !Object.hasOwn(body, k))) throw new Error("Unsupported listening start field.");
      return api("POST", "/api/music-listening-lab", { action: "start", ...defined(body) }, 900_000);
    },
  }];
}
