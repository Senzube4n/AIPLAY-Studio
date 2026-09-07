/**
 * SFX cue analysis — find the moments in a narrated bundle that deserve a
 * sound effect, and render them through the engine (Stable Audio 3 Small SFX,
 * art kind "sfx" — FORK_DELTA).
 *
 * Two intelligence tiers, by design:
 * - scanCues(): a curated lexicon over the narration script. Runs offline in
 *   milliseconds, places cues at the moment the phrase is actually spoken
 *   (chunk start + the match's proportional position inside the chunk), and
 *   applies sound-design restraint: max 8 cues per bundle, 25 s apart.
 * - The MCP surface (ab_sfx set) lets a driving agent read the chapter text
 *   and write BETTER cues than any lexicon — the lexicon is the autopilot,
 *   the agent is the sound designer.
 *
 * Timing ground truth: narrateBundle laid chunks end to end, so chunk i
 * starts at Σ seconds of chunks 0..i-1 — the same math mixBundle uses.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
/* THE ENGINE DOOR — this file no longer knows where ComfyUI is, and no longer
 * needs `config` at all now that it does not build a URL. */
import { engine } from "../engine/client.js";
import { readProject, updateProject, assetsDir, noteRun } from "./store.js";
import { awaitArt } from "./generate.js";

/* Each entry: match → what to render. `w` is priority when cues compete,
 * `seconds` the render length, `gain` how far under the narration it sits. */
const LEXICON = [
  { re: /\b(?:rain|raining|downpour|drizzle)\b/i, label: "rain", prompt: "steady rain falling, natural outdoor rain ambience", seconds: 6, gain: 0.5, w: 3 },
  { re: /\bthunder(?:clap|ed|ing)?\b/i, label: "thunder", prompt: "distant thunder rumble rolling across the sky", seconds: 5, gain: 0.7, w: 5 },
  { re: /\bdoor\b[^.]{0,30}\b(?:creak|groan)|creak(?:ing|ed)?\b[^.]{0,20}\bdoor/i, label: "door creak", prompt: "old wooden door creaking open slowly", seconds: 3, gain: 0.6, w: 4 },
  { re: /\b(?:door|gate)\b[^.]{0,30}\b(?:slam|bang)|slam(?:med|ming)?\b[^.]{0,20}\b(?:door|gate)/i, label: "door slam", prompt: "heavy wooden door slamming shut, reverberant", seconds: 2, gain: 0.8, w: 5 },
  { re: /\bfootsteps?\b|\bboots?\b[^.]{0,25}\b(?:stone|floor|gravel|echo)/i, label: "footsteps", prompt: "slow footsteps on a stone floor, echoing", seconds: 4, gain: 0.5, w: 3 },
  { re: /\bwind\b[^.]{0,30}\b(?:howl|whistl|moan|gust)|\b(?:howling|biting|cold)\s+wind\b/i, label: "wind", prompt: "cold wind howling through trees, gusty", seconds: 6, gain: 0.5, w: 3 },
  { re: /\b(?:campfire|fireplace|hearth|flames?)\b[^.]{0,30}\b(?:crackl|burn|roar)|\bcrackl(?:e|ed|ing)\b/i, label: "fire", prompt: "campfire crackling, small flames, close", seconds: 6, gain: 0.5, w: 3 },
  { re: /\b(?:swords?|blades?|steel)\b[^.]{0,35}\b(?:clash|drawn|drew|rang|struck)|\bdrew\s+(?:his|her|the)\s+(?:sword|blade)/i, label: "sword", prompt: "steel sword being drawn from a scabbard, metallic ring", seconds: 2, gain: 0.75, w: 5 },
  { re: /\bscream(?:ed|ing)?\b|\bshriek(?:ed|ing)?\b/i, label: "scream", prompt: "distant scream echoing, horror, far away", seconds: 3, gain: 0.5, w: 4 },
  { re: /\bbells?\b[^.]{0,25}\b(?:toll|rang|ring|chime)|\b(?:toll|chime)\b[^.]{0,15}\bbells?/i, label: "bell", prompt: "large church bell tolling slowly, distant", seconds: 5, gain: 0.6, w: 4 },
  { re: /\b(?:horses?|hoofbeats|hooves)\b[^.]{0,30}\b(?:gallop|hooves|thunder|rode)|\bgallop(?:ed|ing)?\b/i, label: "horses", prompt: "horse galloping past on a dirt road, hoofbeats", seconds: 4, gain: 0.6, w: 3 },
  { re: /\b(?:wolves|wolf)\b[^.]{0,25}\bhowl|\bhowl(?:ed|ing)?\b[^.]{0,25}\b(?:wolf|wolves|distance)/i, label: "wolf", prompt: "lone wolf howling far away at night", seconds: 4, gain: 0.55, w: 4 },
  { re: /\b(?:waves?|surf|ocean|sea)\b[^.]{0,30}\b(?:crash|break|roar|lapp)/i, label: "ocean", prompt: "ocean waves breaking on a rocky shore", seconds: 6, gain: 0.5, w: 3 },
  { re: /\b(?:river|stream|brook|water)\b[^.]{0,25}\b(?:rush|babbl|flow|murmur)/i, label: "river", prompt: "small river flowing over stones, gentle water", seconds: 6, gain: 0.45, w: 2 },
  { re: /\b(?:glass|window)\b[^.]{0,25}\b(?:shatter|smash|broke|break)|\bshatter(?:ed|ing)?\b/i, label: "glass", prompt: "glass shattering on a hard floor", seconds: 2, gain: 0.8, w: 5 },
  { re: /\bknock(?:ed|ing)?\b[^.]{0,20}\b(?:door|gate)|\b(?:door|gate)\b[^.]{0,15}\bknock/i, label: "knock", prompt: "three firm knocks on a wooden door", seconds: 2, gain: 0.7, w: 4 },
  { re: /\b(?:crowd|tavern|market|inn)\b[^.]{0,35}\b(?:noise|din|bustl|roar|chatter|crowded)|\bmurmur\s+of\s+(?:the\s+)?crowd/i, label: "crowd", prompt: "murmuring tavern crowd, glasses, indistinct chatter", seconds: 7, gain: 0.4, w: 2 },
  { re: /\b(?:crickets?|cicadas?)\b|\bnight\b[^.]{0,25}\b(?:alive with|sounds?|chorus)/i, label: "night", prompt: "night crickets chirping, calm summer night ambience", seconds: 7, gain: 0.4, w: 2 },
  { re: /\b(?:birds?|birdsong|sparrows?|larks?)\b[^.]{0,25}\b(?:sang|sing|chirp|call)/i, label: "birds", prompt: "morning songbirds in a forest, light birdsong", seconds: 6, gain: 0.4, w: 2 },
  { re: /\b(?:arrows?|bowstring)\b[^.]{0,25}\b(?:loosed|flew|whistl|twang|fired)/i, label: "arrow", prompt: "arrow whooshing past and thudding into wood", seconds: 2, gain: 0.7, w: 4 },
  { re: /\bexplo(?:sion|ded|des)\b|\bblast\b[^.]{0,20}\b(?:tore|ripped|shook)/i, label: "explosion", prompt: "distant explosion with debris, cinematic", seconds: 4, gain: 0.8, w: 5 },
  { re: /\bheart\b[^.]{0,25}\b(?:pound|hammer|thud|raced)/i, label: "heartbeat", prompt: "slow tense heartbeat, deep thumps", seconds: 5, gain: 0.5, w: 3 },
];

const MAX_CUES = 8;
const MIN_GAP_SEC = 25;

async function loadScriptWithTimes(slug, b) {
  const scriptPath = path.join(assetsDir(slug), `narration_${b.idx}`, "script.json");
  let script;
  try { script = JSON.parse(await readFile(scriptPath, "utf8")); }
  catch { throw new Error("No narration script — narrate this bundle first (older narrations predate scripts; re-narrate)."); }
  if (!b.narration?.length) throw new Error("Narrate this bundle first.");
  let t = 0;
  return script.map((c, i) => {
    const start = t;
    t += b.narration[i]?.seconds || 0;
    return { ...c, start, seconds: b.narration[i]?.seconds || 0 };
  });
}

/** Lexicon pass: store suggestions on the bundle (nothing renders yet). */
export async function scanCues(slug, bundleIdx) {
  const doc = await readProject(slug);
  const b = doc?.bundles.find((x) => x.idx === Number(bundleIdx));
  if (!b) throw new Error(`No bundle ${bundleIdx}`);
  const chunks = await loadScriptWithTimes(slug, b);

  const found = [];
  for (const c of chunks) {
    if (c.pause || !c.text) continue;
    for (const lx of LEXICON) {
      const m = c.text.match(lx.re);
      if (!m) continue;
      const at = c.start + (m.index / Math.max(c.text.length, 1)) * c.seconds;
      found.push({ label: lx.label, prompt: lx.prompt, at: Math.round(at * 10) / 10,
                   seconds: lx.seconds, gain: lx.gain, w: lx.w,
                   phrase: c.text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim() });
    }
  }
  // restraint: strongest first, then enforce spacing in play order
  found.sort((a, b2) => b2.w - a.w);
  const picked = [];
  for (const cue of found) {
    if (picked.length >= MAX_CUES) break;
    if (picked.some((p) => Math.abs(p.at - cue.at) < MIN_GAP_SEC)) continue;
    picked.push(cue);
  }
  picked.sort((a, b2) => a.at - b2.at);

  await updateProject(slug, (doc2) => {
    const b2 = doc2.bundles.find((x) => x.idx === b.idx);
    b2.sfxSuggestions = picked.map(({ w, ...rest }) => rest);
    noteRun(doc2, { tool: "ab_sfx_scan", outcome: `bundle ${b.idx}: ${picked.length} cues (${picked.map((p) => p.label).join(", ") || "none"})` });
    return doc2;
  });
  return picked;
}

/* ─────────────────────────────── the local judge ───────────────────────────
 * qwen_3_4b already sits on disk as FLUX.2's text encoder; through CLIPLoader +
 * TextGenerate it answers flat-JSON questions reliably (nested JSON it cannot
 * do — measured). Greedy decoding, one cue per call. The judge's one job is
 * the failure mode lexicons cannot see: "an explosion of stars" when someone
 * is clubbed is not an explosion. Few-shot examples carry the distinction —
 * verified 4/4 including the matched pair "her voice rang like steel" (false)
 * vs "the steel rang against the scabbard" (true). */
const JUDGE_PROMPT = (phrase, prompt) =>
  `You judge sound-effect cues for an audiobook. Only sounds that physically happen in the ` +
  `scene deserve an effect. Figures of speech do not: "an explosion of stars" when someone ` +
  `is struck, "her laughter was a silver bell", "his heart thundered" are all FALSE. ` +
  `A storm actually breaking, a real door creaking are TRUE. ` +
  `Passage: "${phrase.replace(/"/g, "'")}" Proposed effect: ${prompt}. ` +
  `Reply ONLY flat JSON {"real": true or false, "why": "..."}.`;

async function askQwen(prompt, maxLen = 80) {
  const graph = {
    1: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "flux2" } },
    2: { class_type: "TextGenerate", inputs: { clip: ["1", 0], prompt, max_length: maxLen, sampling_mode: "off" } },
    3: { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
  };
  /* A GRAPH WITH NO FILE OUTPUT AT ALL, and it goes through the door anyway.
   *
   * There is nothing here to adopt and nothing to hash — the answer comes back
   * in the history entry's `text`. What the record carries instead is the
   * question, the model file that answered it, and how long the 8.7 GB judge
   * took: this runs hundreds of times per audiobook and was, until now, the
   * single largest source of GPU time this app could say nothing about. */
  const done = await engine.run({
    graph, actor: "system", via: "mv.sfx_judge", adopt: false,
    timeoutMs: 240_000, pollMs: 800, label: "sfx cue judge",
  });
  if (done.status !== "completed") throw new Error(done.error || `the judge did not answer (${done.status})`);
  /* Read from the terminal history entry the door already has in hand:
   * `PreviewAny` reports under `text`, which is not a file kind and so never
   * appears in `outputs[]`. Asking /history again here would open a gap in
   * which an engine restart returns an empty string — which judgeCues reads as
   * "judge unavailable" and keeps the cue, a silent wrong answer. */
  return done.entry?.outputs?.["3"]?.text?.[0] ?? "";
}

/** Grade the bundle's cues with the local model: figures of speech get
 * real:false and are skipped by render unless explicitly included. */
export async function judgeCues(deps, slug, bundleIdx) {
  const { waitForIdle } = deps;
  const doc = await readProject(slug);
  const b = doc?.bundles.find((x) => x.idx === Number(bundleIdx));
  if (!b) throw new Error(`No bundle ${bundleIdx}`);
  if (!b.sfxSuggestions?.length) throw new Error("No cues to judge — scan (or set) first.");
  // the 8.7 GB judge must never evict a render mid-flight
  if (waitForIdle) await waitForIdle();

  const judged = [];
  for (const cue of b.sfxSuggestions) {
    let verdict = { real: true, why: "judge unavailable — kept" };
    try {
      const raw = await askQwen(JUDGE_PROMPT(cue.phrase || cue.prompt, cue.prompt));
      const m = raw.match(/\{[^}]*\}/);
      if (m) verdict = JSON.parse(m[0]);
    } catch { /* keep the cue rather than lose it to an outage */ }
    judged.push({ ...cue, real: verdict.real !== false, why: String(verdict.why || "").slice(0, 160) });
  }
  await updateProject(slug, (doc2) => {
    const b2 = doc2.bundles.find((x) => x.idx === b.idx);
    b2.sfxSuggestions = judged;
    const killed = judged.filter((c) => !c.real);
    noteRun(doc2, { tool: "ab_sfx_judge", outcome: `bundle ${b.idx}: ${judged.length - killed.length}/${judged.length} cues held${killed.length ? ` (rejected: ${killed.map((c) => c.label).join(", ")})` : ""}` });
    return doc2;
  });
  return judged;
}

/** Overwrite the cue list by hand (or by agent — the intelligent path). */
export async function setCues(slug, bundleIdx, cues) {
  if (!Array.isArray(cues)) throw new Error("cues must be an array");
  return updateProject(slug, (doc) => {
    const b = doc.bundles.find((x) => x.idx === Number(bundleIdx));
    if (!b) throw new Error(`No bundle ${bundleIdx}`);
    b.sfxSuggestions = cues.map((c) => ({
      label: String(c.label || "sfx"), prompt: String(c.prompt || c.label || "sound effect"),
      at: Number(c.at) || 0, seconds: Math.min(10, Math.max(1, Number(c.seconds) || 4)),
      gain: Math.min(1, Math.max(0.1, Number(c.gain) || 0.6)), phrase: c.phrase || "",
    }));
    noteRun(doc, { tool: "ab_sfx_set", outcome: `bundle ${b.idx}: ${b.sfxSuggestions.length} cues set` });
    return doc;
  });
}

/** Render the suggested cues through the engine and attach them to the mix
 * plan. Re-mix afterwards to hear them. `only` filters by suggestion index. */
export async function renderCues(deps, slug, bundleIdx, { only, seed } = {}) {
  const { art } = deps;
  const doc = await readProject(slug);
  const b = doc?.bundles.find((x) => x.idx === Number(bundleIdx));
  if (!b) throw new Error(`No bundle ${bundleIdx}`);
  const wanted = (b.sfxSuggestions || []).filter((c, i) =>
    only ? only.includes(i) : c.real !== false);   // judged-out cues stay unrendered
  if (!wanted.length) throw new Error("No cues — run ab_sfx scan (or set) first, or every cue was judged a figure of speech.");

  const rendered = [];
  for (let i = 0; i < wanted.length; i++) {
    const cue = wanted[i];
    const fileId = `sfx:${slug}:${b.idx}:${Date.now().toString(36)}_${i}`;
    const usedSeed = Number.isFinite(seed) ? Number(seed) + i : Math.floor(Math.random() * 4294967296);
    const job = art.request({ kind: "sfx", file: fileId, title: `sfx · ${cue.label}`,
      seed: usedSeed, video: { prompt: cue.prompt, seconds: cue.seconds } });
    if (!job) throw new Error("engine refused the sfx job");
    const done = await awaitArt(art, fileId, ["sfx"], 10 * 60e3);
    rendered.push({ ...cue, file: done.sfxFile, seed: usedSeed });
  }

  await updateProject(slug, (doc2) => {
    const b2 = doc2.bundles.find((x) => x.idx === b.idx);
    b2.sfx = rendered.map(({ phrase, ...keep }) => keep);
    if (b2.mixFile) b2.status = "narrated";   // the old mix no longer tells the truth
    noteRun(doc2, { tool: "ab_sfx_render", outcome: `bundle ${b.idx}: ${rendered.length} effects rendered (${rendered.map((r) => r.label).join(", ")})` });
    return doc2;
  });
  return rendered;
}

export async function clearCues(slug, bundleIdx) {
  return updateProject(slug, (doc) => {
    const b = doc.bundles.find((x) => x.idx === Number(bundleIdx));
    if (!b) throw new Error(`No bundle ${bundleIdx}`);
    b.sfx = []; b.sfxSuggestions = [];
    noteRun(doc, { tool: "ab_sfx_clear", outcome: `bundle ${b.idx}: cues cleared` });
    return doc;
  });
}
