/**
 * YuE2 through ComfyUI (engine "yue2-comfy"): what a song request may ask of
 * the graph, decided before anything is queued. Node built-ins only, no I/O,
 * so the door and its tests call the same function.
 *
 * WHY THIS EXISTS. /api/generate read `abc` only in the Python kit's branch,
 * and the yue2-comfy job never carried it: a hummed or pasted score was
 * accepted, the job was queued, and the graph sang the model's own plan
 * instead. ComfyUI's YuE2GenerateMusic (comfy_extras/nodes_yue2.py) takes the
 * score as a plain string ("Connect the ABC generator or supply an edited
 * score"), and so does our AiplayYuE2Continue, so the score is carried and
 * the planner (node 4) is left out. Everything the graph cannot do is refused
 * here by one sentence, never dropped:
 *
 *   - an OPEN score the planner continues: YuE2GenerateABC has no score
 *     input, so it can only plan from nothing (YuE2 GGUF has no open score
 *     either: its door refuses abcOpen, so only the Python kit is named);
 *   - key / tempo / meter: on the Python kit they become an open seed score
 *     (server/music/seed.js), which is the same missing ability;
 *   - "Start from the original" (coverOf): the real-audio prime is the
 *     Python kit's cover path;
 *   - Guidance (cfgScale): YuE2GenerateMusic has no guidance input; the text
 *     encoder uses 1.0 (1.01 with the plan off, comfy/text_encoders/yue2.py);
 *   - planner dials when the planner does not run (a supplied score, or
 *     Thinking off).
 *
 * The words are the page's: "Thinking" (#yCot, cot on the API), "Use this
 * score with Create" (#yAbcUse), "Planner temperature" (#yPlanTemp),
 * "Guidance" (#yCfg), with the API's name beside the page's where an agent
 * reads the same sentence.
 *
 * The sampler dials ARE wired: both nodes take temperature and top_p, and
 * node 5 takes top_k and repetition_penalty too. The ranges are the nodes'
 * own min/max, which are the Python kit's (the door's `dial` in index.js).
 */

export const ENGINE = "yue2-comfy";

/* The Python kit's dial sentence, reused so the two YuE2 builds name the same
 * ranges. yue2-comfy-input_test.js reads index.js and fails if it drifts. */
export const DIAL_RANGES = "Temperature 0–5, top-p 0.01–1, top-k 1–32768, repetition penalty 0.01–10.";
/* The same cap the GGUF door puts on a score (yue-gguf.js validateGgufRequest)
 * and make_song's schema states (maxLength 65536). */
export const MAX_SCORE_BYTES = 64 * 1024;

export const COMFY_REFUSALS = Object.freeze({
  /* Not the Python kit's sentence (the contract asked for it verbatim): that
   * one names "render from this score", a checkbox hidden on this engine, and
   * protocol.py, a file this engine never runs. Same reason code. */
  "score-needs-cot": "A supplied score needs Thinking on (Full plan or Melody only; cot full or melody): with it Off "
    + "the ComfyUI build of YuE2 plans nothing and cannot take a score. Set Thinking, or untick \"Use this score "
    + "with Create\". Nothing was queued.",
  "comfy-open-score": "The ComfyUI build of YuE2 sings a supplied score as written; it cannot let the planner "
    + "continue it. Untick \"Let the planner continue this score\", or use the Python kit. Nothing was queued.",
  "comfy-seed-score": "The ComfyUI build of YuE2 cannot seed a key, tempo or meter. Clear Key, Tempo and Meter, "
    + "or hum or paste a score that carries them. Nothing was queued.",
  "comfy-cover-prime": "The ComfyUI build of YuE2 cannot hear the original's opening (\"Start from the original\" "
    + "needs the Python kit). Set it to 0 s, or use the Python kit. Nothing was queued.",
  "comfy-guidance": "The ComfyUI build of YuE2 has no Guidance setting: it samples at its own 1.0 (1.01 with "
    + "Thinking Off). Clear Guidance, or use the Python kit or YuE2 GGUF. Nothing was queued.",
  "comfy-plan-dials-with-score": "With a supplied score the planner does not run, so Planner temperature does "
    + "nothing. Clear it, or clear the score. Nothing was queued.",
  "comfy-plan-dials-without-plan": "With Thinking Off (cot off) the planner does not run, so Planner temperature "
    + "does nothing. Clear it, or set Thinking to Full plan or Melody only. Nothing was queued.",
  "score-type": "A score must be ABC text, with no NUL characters. Nothing was queued.",
  "score-size": `A score may be up to ${MAX_SCORE_BYTES / 1024} KiB of ABC text. Shorten it. Nothing was queued.`,
});
/* The same reason (comfy-seed-score), said for the case where a score IS
 * supplied: beside a score the three do nothing on any YuE2 build (the score
 * carries its own), so "hum or paste a score" would be advice already taken.
 * The Python kit ignores them there; this door says so instead. */
export const SEED_WITH_SCORE = "With a supplied score, Key, Tempo and Meter do nothing: the score carries its own. "
  + "Clear Key, Tempo and Meter. Nothing was queued.";

function refuse(reason, sentence = COMFY_REFUSALS[reason]) {
  throw Object.assign(new Error(sentence), { status: 400, reason, engine: ENGINE });
}

/* Absent: undefined, null, or a string that is blank once trimmed. */
const isSet = (v) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim());

/* One dial: absent stays absent (the node's own default holds). A number, or
 * the text of one, must be finite and inside the node's range; any other type
 * (true, [], {}) is refused rather than read as 0. */
function dial(v, lo, hi, int = false) {
  if (!isSet(v)) return undefined;
  if (typeof v !== "number" && typeof v !== "string") {
    refuse("sampling", `A sampler dial must be a number, not ${JSON.stringify(v)}. ${DIAL_RANGES}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) {
    refuse("sampling", `A sampler dial is out of range: ${n} is outside ${lo}–${hi}. ${DIAL_RANGES}`);
  }
  return n;
}
const compact = (o) => {
  const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? kept : null;
};

/**
 * @param body   the /api/generate body (or make_song's forwarded fields)
 * @param cot    the chain-of-thought mode the job will run: "full" | "melody" | "off"
 * @returns {{ abc: string|null,
 *             sampling: {temperature?, top_p?, top_k?, repetition_penalty?}|null,
 *             planSampling: {temperature?, top_p?}|null }}
 * @throws  Error with { status: 400, reason, engine: "yue2-comfy" }
 */
export function yue2ComfyFields(body, { cot = "full" } = {}) {
  const b = body && typeof body === "object" ? body : {};
  if (isSet(b.abc) && (typeof b.abc !== "string" || b.abc.includes("\0"))) refuse("score-type");
  if (typeof b.abc === "string" && Buffer.byteLength(b.abc) > MAX_SCORE_BYTES) refuse("score-size");
  /* Verbatim, as the Python kit carries it; a blank box is no score. */
  const abc = typeof b.abc === "string" && b.abc.trim() ? b.abc : null;
  if (b.abcOpen === true) refuse("comfy-open-score");
  if (isSet(b.key) || isSet(b.bpm) || isSet(b.meter)) refuse("comfy-seed-score", abc ? SEED_WITH_SCORE : undefined);
  if (isSet(b.coverOf) && b.coverOf !== false) refuse("comfy-cover-prime");
  /* 1 is what this build uses and what its Library rows record (so Reuse
   * writes it back); anything else would be accepted and not applied. */
  if (isSet(b.cfgScale) && !((typeof b.cfgScale === "number" || typeof b.cfgScale === "string") && Number(b.cfgScale) === 1)) {
    refuse("comfy-guidance");
  }
  if (abc && cot === "off") refuse("score-needs-cot");
  const sampling = compact({
    temperature: dial(b.temperature, 0, 5),
    top_p: dial(b.topP, 0.01, 1),
    top_k: dial(b.topK, 1, 32768, true),
    repetition_penalty: dial(b.repetitionPenalty, 0.01, 10),
  });
  const planSampling = compact({
    temperature: dial(b.planTemperature, 0, 5),
    top_p: dial(b.planTopP, 0.01, 1),
  });
  if (planSampling && abc) refuse("comfy-plan-dials-with-score");
  if (planSampling && cot === "off") refuse("comfy-plan-dials-without-plan");
  return { abc, sampling, planSampling };
}
