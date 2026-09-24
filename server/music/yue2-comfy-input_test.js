/**
 * YuE2 through ComfyUI never accepts a score and drops it (Tika R2b, 2026-09-24).
 *
 * The bug: /api/generate read `abc` only for the Python kit; the yue2-comfy
 * job carried no score and buildYue2ComfyGraph always wired the planner's own
 * plan into the music node. A hummed melody was accepted, the song was queued,
 * and the melody never reached the render.
 *
 * What is pinned:
 *   §1  the validator, row by row (server/music/yue2-comfy-input.js), and the
 *       builds its sentences send people to really take what they are sent for;
 *   §2  the dial sentence it shares with the Python kit's branch is the same text;
 *   §3  THE ROUTE LANE: the real /api/generate yue2-comfy text, sliced out of
 *       index.js and run with the real jobs.js graph call behind it. Every
 *       request that carries a score either reaches the graph (node 5 sings
 *       the text, there is no planner node) or is refused with nothing queued.
 *       There is no third outcome;
 *   §4  the in-Studio assistant neither fills a row this engine refuses nor
 *       blocks the clear its refusal asks for;
 *   §5  the page: yueSpec does not send the cover prime to this engine, the
 *       prime row says off with the reason, and the progress line says "your
 *       score" (sliced app.js functions, run against fake elements).
 * No card, no ComfyUI, milliseconds.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { yue2ComfyFields, COMFY_REFUSALS, SEED_WITH_SCORE, DIAL_RANGES, MAX_SCORE_BYTES } from "./yue2-comfy-input.js";
import { buildYue2ComfyGraph, INSTRUMENTAL_PLANNER_LORA } from "../workflow.js";
import { createMusicTools } from "../chat/music-tools.js";
import { prepareGgufJob } from "../music-gguf-input.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const refusal = (body, cot = "full") => {
  try { yue2ComfyFields(body, { cot }); return null; } catch (e) { return e; }
};
const between = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b <= a) throw new Error(`slice boundary moved: ${start}`);
  return source.slice(a, b);
};

const SCORE = "X:1\nT:hummed\nM:4/4\nL:1/8\nK:G\nV:1\n|: GABc d2 B2 | c2 A2 G4 :|\n";

console.log("\n§1  the validator, row by row");
{
  eq("nothing asked: nothing carried", yue2ComfyFields({ caption: "c" }, { cot: "full" }), { abc: null, sampling: null, planSampling: null });
  eq("a score is carried verbatim", yue2ComfyFields({ abc: SCORE }, { cot: "melody" }).abc, SCORE);
  eq("a blank score is no score", yue2ComfyFields({ abc: "  \n " }, { cot: "full" }).abc, null);
  for (const [label, body, reason] of [["a score that is not text", { abc: 42 }, "score-type"],
    ["a score with a NUL in it", { abc: `${SCORE}\0` }, "score-type"],
    ["a score over 64 KiB", { abc: `${SCORE}%${"x".repeat(MAX_SCORE_BYTES)}` }, "score-size"]]) {
    const e = refusal(body);
    ok(`${label}: refused (${reason}), not ignored`, e?.reason === reason && e.status === 400 && e.engine === "yue2-comfy", e ? e.reason : "accepted");
    eq("...in the module's sentence", e?.message, COMFY_REFUSALS[reason]);
  }
  ok("a score of exactly 64 KiB is carried (the GGUF door's own cap)",
    yue2ComfyFields({ abc: "x".repeat(MAX_SCORE_BYTES) }, { cot: "melody" }).abc?.length === MAX_SCORE_BYTES);

  const cotOff = refusal({ abc: SCORE }, "off");
  ok("a score with Thinking off: 400 score-needs-cot", cotOff?.status === 400 && cotOff.reason === "score-needs-cot");
  eq("...in this engine's sentence", cotOff?.message, COMFY_REFUSALS["score-needs-cot"]);
  ok("...which names the controls this engine shows (Thinking, \"Use this score with Create\"), not the Python kit's",
    /Thinking/.test(cotOff?.message) && /"Use this score with Create"/.test(cotOff?.message)
    && !/render from this score/.test(cotOff?.message) && !/protocol\.py/.test(cotOff?.message));

  const rows = [
    ["abcOpen: true", { abc: SCORE, abcOpen: true }, "comfy-open-score",
      "The ComfyUI build of YuE2 sings a supplied score as written; it cannot let the planner continue it. Untick \"Let the planner continue this score\", or use the Python kit. Nothing was queued."],
    ["key", { key: "Em" }, "comfy-seed-score",
      "The ComfyUI build of YuE2 cannot seed a key, tempo or meter. Clear Key, Tempo and Meter, or hum or paste a score that carries them. Nothing was queued."],
    ["bpm", { bpm: 96 }, "comfy-seed-score", COMFY_REFUSALS["comfy-seed-score"]],
    ["meter", { meter: "3/4" }, "comfy-seed-score", COMFY_REFUSALS["comfy-seed-score"]],
    ["key beside a score (the score carries its own)", { abc: SCORE, key: "G" }, "comfy-seed-score", SEED_WITH_SCORE],
    ["coverOf", { abc: SCORE, coverOf: { file: "song.flac", seconds: 8 } }, "comfy-cover-prime",
      "The ComfyUI build of YuE2 cannot hear the original's opening (\"Start from the original\" needs the Python kit). Set it to 0 s, or use the Python kit. Nothing was queued."],
    ["Guidance 1.5", { cfgScale: 1.5 }, "comfy-guidance", COMFY_REFUSALS["comfy-guidance"]],
    ["Guidance as a boolean", { cfgScale: true }, "comfy-guidance", COMFY_REFUSALS["comfy-guidance"]],
    ["planTemperature with a score", { abc: SCORE, planTemperature: 0.6 }, "comfy-plan-dials-with-score",
      "With a supplied score the planner does not run, so Planner temperature does nothing. Clear it, or clear the score. Nothing was queued."],
    ["planTopP with a score", { abc: SCORE, planTopP: 0.8 }, "comfy-plan-dials-with-score", COMFY_REFUSALS["comfy-plan-dials-with-score"]],
  ];
  for (const [label, body, reason, sentence] of rows) {
    const e = refusal(body, "full");
    ok(`${label}: 400 ${reason}, engine yue2-comfy`, e?.status === 400 && e.reason === reason && e.engine === "yue2-comfy", e ? `${e.status} ${e.reason}` : "accepted");
    eq(`...in its exact words`, e?.message, sentence);
  }
  ok("abcOpen false is not a request", refusal({ abc: SCORE, abcOpen: false }) === null);
  ok("blank key / bpm / meter are not requests (the page sends none)", refusal({ key: "", bpm: null, meter: undefined }) === null);
  ok("...nor is a key of spaces", refusal({ key: "   " }) === null);
  ok("Guidance blank or 1 (what this build uses, and what Reuse writes back) is not a request",
    [undefined, null, "", 1, "1"].every((cfgScale) => refusal({ cfgScale }) === null));
  const noPlan = refusal({ planTemperature: 0.6 }, "off");
  ok("planner dials with Thinking off: refused, the planner does not run either",
    noPlan?.reason === "comfy-plan-dials-without-plan" && noPlan.status === 400 && /Thinking Off/.test(noPlan.message));

  /* The builds a sentence sends people to must take what they are sent for. */
  let gguf = null;
  try { prepareGgufJob({ engine: "yue2-gguf", caption: "c", lyrics: "l", abcOpen: true }, "agent:r2b"); } catch (e) { gguf = e.message; }
  ok("comfy-open-score does not send people to YuE2 GGUF, which refuses abcOpen too",
    /abcOpen/.test(gguf || "") && !/GGUF/.test(COMFY_REFUSALS["comfy-open-score"]), gguf);
  ok("comfy-guidance may name YuE2 GGUF: its door takes cfgScale",
    prepareGgufJob({ engine: "yue2-gguf", caption: "c", lyrics: "l", cfgScale: 1.5 }, "agent:r2b").cfgScale === 1.5
    && /YuE2 GGUF/.test(COMFY_REFUSALS["comfy-guidance"]));

  const wired = yue2ComfyFields({ temperature: 0.8, topP: 0.9, topK: 50, repetitionPenalty: 1.1, planTemperature: 0.5, planTopP: 0.85 }, { cot: "full" });
  eq("performance dials are carried under the nodes' names", wired.sampling, { temperature: 0.8, top_p: 0.9, top_k: 50, repetition_penalty: 1.1 });
  eq("planner dials too", wired.planSampling, { temperature: 0.5, top_p: 0.85 });
  eq("performance dials ride with a score", yue2ComfyFields({ abc: SCORE, temperature: 0 }, { cot: "melody" }).sampling, { temperature: 0 });
  eq("a dial of spaces is absent, not temperature 0", yue2ComfyFields({ temperature: "  " }, { cot: "full" }).sampling, null);
  eq("a dial as text is read as its number", yue2ComfyFields({ temperature: "0.8" }, { cot: "full" }).sampling, { temperature: 0.8 });
  for (const [label, body] of [["temperature 6", { temperature: 6 }], ["top-p 0", { topP: 0 }], ["top-k 1.5", { topK: 1.5 }],
    ["penalty 11", { repetitionPenalty: 11 }], ["planner temperature -1", { planTemperature: -1 }], ["temperature as text", { temperature: "warm" }],
    ["temperature true", { temperature: true }], ["temperature []", { temperature: [] }], ["temperature {}", { temperature: {} }]]) {
    const e = refusal(body);
    ok(`${label}: 400 sampling`, e?.reason === "sampling" && e.status === 400, e ? e.reason : "accepted");
  }
  ok("...naming the ranges the Python kit names", refusal({ temperature: 6 })?.message.endsWith(DIAL_RANGES)
    && refusal({ temperature: [] })?.message.endsWith(DIAL_RANGES));
}

console.log("\n§2  one dial sentence across both YuE2 builds");
{
  const index = src("../index.js");
  ok("the Python kit's dial sentence names the same ranges", index.includes("A sampler dial is out of range: ${e.message}. " + DIAL_RANGES));
  ok("the yue2-comfy branch answers with the validator's status, sentence and reason",
    /yueComfy = yue2ComfyFields\(body, \{ cot: \["full", "melody", "off"\]\.includes\(body\.cot\) \? body\.cot : "full" \}\);\n\s+\} catch \(e\) \{\n\s+return json\(res, e\.status \|\| 400, \{ error: e\.message, engine: "yue2-comfy", reason: e\.reason \}\);/.test(index));
}

console.log("\n§3  the route lane: a score on yue2-comfy reaches the graph, or nothing is queued");
{
  const index = src("../index.js"), runner = src("../jobs.js");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const queued = [];
  const shelf = [
    { folder: "checkpoints", name: "yue2_3b_bf16.safetensors", full: "yue2" },
    { folder: "loras", name: INSTRUMENTAL_PLANNER_LORA },
    { folder: "loras", name: "mine.safetensors" },
  ];
  /* Every free name of the sliced branch, injected. A new one fails loudly
   * here (ReferenceError), which is the point of the slice. */
  const scope = { path, INSTRUMENTAL_PLANNER_LORA, yue2ComfyFields,
    config: { music: { yue2Checkpoint: "yue2_3b_bf16.safetensors", yue2Lora: null, yue2LoraClip: null,
      engines: { "yue2-comfy": { maxDuration: 360 } }, precision: "int8" }, audioRef: { denoise: 0.5 } },
    scanBases: async () => shelf, modelBases: async () => [], probeModel: async () => ({ family: "yue2" }),
    json: (_res, status, value) => ({ status, value }), bareName: (v) => v, prov: { actorFrom: () => "agent:r2b" },
    deriveTitle: () => "Untitled", jobReceipt: (job) => ({ id: job.id }),
    jobs: { enqueue: (spec) => { const job = { ...spec, id: `q${queued.length}` }; queued.push(job); return job; } },
    paidSong: false };
  const route = new AsyncFunction(...Object.keys(scope), "body",
    `const musicEngine = 'yue2-comfy', aceJob = null, req = {}, res = {}; { ${between(index, "      let yueLora = null", "\n    /**\n     * Extend an existing take.")}`);
  const request = (body) => route(...Object.values(scope), { caption: "warm folk", lyrics: "one two three", ...body });
  const graphOf = new Function("buildYue2ComfyGraph", "job",
    `return ${between(runner, "buildYue2ComfyGraph({", ") : buildGraph({")});`).bind(null, buildYue2ComfyGraph);

  /* THE INVARIANT, over every shape the page and make_song can send. */
  const cases = [
    { abc: SCORE, cot: "melody" },
    { abc: SCORE, cot: "full" },
    { abc: SCORE },                                        // cot omitted: full
    { abc: SCORE, cot: "off" },
    { abc: SCORE, cot: "melody", abcOpen: true },
    { abc: SCORE, cot: "melody", key: "G", bpm: 100, meter: "4/4" },
    { abc: SCORE, cot: "melody", coverOf: { file: "x.flac", seconds: 8 } },
    { abc: SCORE, cot: "melody", planTemperature: 0.5 },
    { abc: SCORE, cot: "melody", temperature: 0.8, topP: 0.9 },
    { abc: SCORE, cot: "melody", temperature: 9 },
    { abc: SCORE, cot: "melody", cfgScale: 2 },
    { abc: SCORE, cot: "melody", cfgScale: 1 },
    { abc: `${SCORE}\0`, cot: "melody" },
    { abc: SCORE, cot: "full", instrumental: true },
    { abc: SCORE, cot: "full", instrumental: true, loraClip: "mine.safetensors" },
    { abc: SCORE, cot: "melody", scoreSlug: "my-hum", scoreVersion: "v3" },
  ];
  for (const body of cases) {
    const before = queued.length;
    const r = await request(body);
    const label = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => k !== "abc")));
    if (r.status === 200) {
      const job = queued[queued.length - 1];
      const g = graphOf(job);
      ok(`${label}: queued, and the graph sings the score (node 5 abc = the text, no node 4)`,
        queued.length === before + 1 && g[5]?.inputs.abc === body.abc && !("4" in g), JSON.stringify(g[5]?.inputs.abc));
    } else {
      ok(`${label}: refused (${r.status} ${r.value?.reason}) and NOTHING queued`,
        r.status === 400 && queued.length === before && typeof r.value?.error === "string" && r.value.engine === "yue2-comfy");
    }
  }

  const q0 = queued.length;
  let r = await request({ abc: SCORE, cot: "melody", temperature: 0.8, topP: 0.9, topK: 40, repetitionPenalty: 1.3 });
  const dialled = graphOf(queued[q0]);
  eq("the performance dials reach node 5",
    [dialled[5].inputs.temperature, dialled[5].inputs.top_p, dialled[5].inputs.top_k, dialled[5].inputs.repetition_penalty], [0.8, 0.9, 40, 1.3]);
  eq("the job says what it carries", [queued[q0].abc === SCORE, queued[q0].sampling, queued[q0].planSampling],
    [true, { temperature: 0.8, top_p: 0.9, top_k: 40, repetition_penalty: 1.3 }, null]);

  r = await request({ cot: "full", planTemperature: 0.5, planTopP: 0.8 });
  const planned = graphOf(queued[queued.length - 1]);
  ok("without a score the planner runs, with its dials", r.status === 200 && planned[4]?.inputs.temperature === 0.5 && planned[4]?.inputs.top_p === 0.8
    && JSON.stringify(planned[5].inputs.abc) === '["4",0]');

  r = await request({ cot: "full" });
  const plain = graphOf(queued[queued.length - 1]);
  ok("a plain request is unchanged: the planner plans, vendor defaults hold",
    r.status === 200 && plain[4]?.inputs.temperature === 0.7 && plain[5].inputs.temperature === 1.0 && queued[queued.length - 1].abc === null);

  /* The instrumental planner LoRA is picked BY ITSELF only for the planner:
   * beside a score no planner runs, so nothing is picked; one you name stays. */
  r = await request({ cot: "full", instrumental: true });
  eq("an instrumental without a score still picks the instrumental planner LoRA", [r.status, queued[queued.length - 1].loraClip, queued[queued.length - 1].lyrics],
    [200, INSTRUMENTAL_PLANNER_LORA, "[instrumental]"]);
  r = await request({ abc: SCORE, cot: "full", instrumental: true });
  eq("...beside a score it picks nothing, and the sheet is left alone", [r.status, queued[queued.length - 1].loraClip, queued[queued.length - 1].lyrics],
    [200, null, "one two three"]);
  r = await request({ abc: SCORE, cot: "full", instrumental: true, loraClip: "mine.safetensors" });
  eq("...and a planner LoRA the request names is still honoured", [r.status, queued[queued.length - 1].loraClip], [200, "mine.safetensors"]);

  r = await request({ abc: SCORE, cot: "melody", scoreSlug: "my-hum", scoreVersion: "v3" });
  eq("a score's lineage rides to the job", [queued[queued.length - 1].scoreSlug, queued[queued.length - 1].scoreVersion], ["my-hum", "v3"]);
  r = await request({ cot: "melody", scoreSlug: "my-hum", scoreVersion: "v3" });
  eq("...and never without one", [queued[queued.length - 1].scoreSlug, queued[queued.length - 1].scoreVersion], [null, null]);
  ok("...and the ledger files it (params.scoreFrom), beside scoreSupplied",
    /scoreFrom: job\.scoreSlug \? \(job\.scoreVersion \? `\$\{job\.scoreSlug\}\/\$\{job\.scoreVersion\}` : job\.scoreSlug\) : null,/.test(index));
  ok("the Library row says a score was supplied", /\.\.\.\(isYueComfy \? \{\n\s+cot: job\.cot \|\| "full", checkpoint: job\.yue2Checkpoint \|\| null,\n(?:\s+\/?\*.*\n)+\s+scoreSupplied: !!job\.abc,/.test(index));
  ok("the queue view says so too, and names the plan mode (the flag, never the text)",
    /\.\.\.\(j\.engine === "yue2-comfy" \? \{ cot: j\.cot \|\| "full", scoreSupplied: !!j\.abc \} : \{\}\),/.test(runner));

  r = await request({ abc: SCORE, cot: "off" });
  eq("the Thinking-off refusal is this engine's sentence", [r.status, r.value.reason, r.value.error], [400, "score-needs-cot", COMFY_REFUSALS["score-needs-cot"]]);
  r = await request({ abc: SCORE, preview: true });
  eq("preview is still refused first", [r.status, r.value.reason], [400, "no-preview"]);
  const actors = new Set(queued.map((j) => j.actor));
  eq("every job carries the actor the boundary stamped", [...actors], ["agent:r2b"]);
}

console.log("\n§4  the in-Studio assistant: no row this engine refuses is filled, and its clear goes through");
{
  /* change_settings used to fill Key / Tempo / Meter on every YuE2 build; on
   * yue2-comfy the page then sent them and the door (rightly) refused Create. */
  const t = createMusicTools();
  t.setScreen({ engine_id: "yue2-comfy", engine: "YuE2 3B (ComfyUI)" });
  const c = await t.get("change_settings").run({ key: "Em", tempo: 90, meter: "3/4", guidance: 2, thinking: "melody" });
  ok("on yue2-comfy key, tempo, meter and guidance are skipped and said to be skipped",
    !("key" in c.form) && !("tempo" in c.form) && !("meter" in c.form) && !("guidance" in c.form)
    && /key, tempo, meter, guidance are not a setting on YuE2 3B \(ComfyUI\)/.test(c.not_changed || ""),
    JSON.stringify(c));
  ok("...while Thinking is still set", c.form.thinking === "melody");
  let threw = null;
  try { await t.get("change_settings").run({ key: "Em" }); } catch (e) { threw = e.message; }
  ok("...and a key alone changes nothing, by sentence", /Nothing changed: key is not a setting/.test(threw || ""), threw);
  const cleared = await t.get("change_settings").run({ key: "", tempo: "", meter: "", guidance: "" });
  eq("...but CLEARING them goes through: that is what the door's refusal asks for",
    [cleared.form.key, cleared.form.tempo, cleared.form.meter, cleared.form.guidance, cleared.not_changed], ["", "", "", "", undefined]);
  t.setScreen({ engine_id: "yue2", engine: "YuE2 3B (Python kit)" });
  const p = await t.get("change_settings").run({ key: "Em", tempo: 90, guidance: 1.5 });
  ok("the Python kit still takes them", p.form.key === "Em" && p.form.tempo === 90 && p.form.guidance === 1.5, JSON.stringify(p.form));
  const blankTempo = await t.get("change_settings").run({ tempo: "" });
  eq("an empty tempo clears it anywhere (it used to land on 40 BPM)", blankTempo.form.tempo, "");
}

console.log("\n§5  the page: no prime is sent to this engine, the row says why, the progress line says \"your score\"");
{
  const app = src("../../web/app.js");
  const make = (value = "", extra = {}) => ({ value, checked: false, disabled: false, textContent: "", dataset: {}, ...extra });
  const els = {
    yCot: make("melody"), yCfg: make(""), yPrecision: make("none"), ySteps: make("32"), yKey: make(""), yBpm: make(""), yMeter: make(""),
    yTemp: make(""), yTopP: make(""), yPlanTemp: make(""), humEngine: make("song"), humSong: make("old-song.flac"), covPrime: make("8"),
    covStem: make(""), scoreUse: make(), yAbcUse: make("", { checked: true }), yAbc: make(SCORE), yAbcOpen: make(), lyrics: make("words"),
    covPrimeValue: make(), covPrimeNote: make("", { textContent: "How many seconds of the original performance YuE2 hears…" }),
  };
  const state = { musicEngine: "yue2-comfy", tokenizerReady: true,
    musicEngines: { "yue2-comfy": { label: "YuE2 3B (ComfyUI)", runtime: "comfy", cot: ["full", "melody", "off"], score: false },
      yue2: { label: "YuE2 3B", runtime: "python", cot: ["full", "melody", "off"], score: true } } };
  const context = vm.createContext({ $: (id) => els[id], state, yueEngine: () => true });
  vm.runInContext(between(app, "function yueSpec()", "/** A re-roll is:"), context);
  vm.runInContext(between(app, "function paintCoverPrime()", "/* The song-only rows"), context);
  const spec = () => vm.runInContext("yueSpec()", context);

  /* The Simple remix on this engine, with the real-audio tokenizer installed:
   * the transcription is sung; the prime is not sent (the door refuses it). */
  const comfy = spec();
  ok("on yue2-comfy the transcribed score is sent and the prime is not", comfy.abc === SCORE.trim() && !("coverOf" in comfy), JSON.stringify(comfy));
  ok("...so the door carries it rather than refusing Create", refusal(comfy, comfy.cot) === null);
  state.musicEngine = "yue2";
  eq("on the Python kit the prime is still sent", spec().coverOf, { file: "old-song.flac", seconds: 8 });
  ok("...by the line yue_extend_test pins", /out\.coverOf = \{ file: covFile, seconds: covSecs, \.\.\.\(covStem \? \{ stem: covStem \} : \{\}\) \}/.test(app));

  state.musicEngine = "yue2-comfy";
  vm.runInContext("paintCoverPrime()", context);
  ok("the prime row says off on yue2-comfy, and keeps its value for the Python kit",
    els.covPrime.disabled === true && els.covPrime.value === "8" && els.covPrimeValue.textContent === "off" && els.covStem.disabled === true);
  ok("...with the reason, naming the engine and the build that can",
    /YuE2 3B \(ComfyUI\) sings the transcribed score/.test(els.covPrimeNote.textContent) && /Python kit/.test(els.covPrimeNote.textContent));
  state.musicEngine = "yue2";
  vm.runInContext("paintCoverPrime()", context);
  ok("back on the Python kit it is on again, at its value, with its own note",
    els.covPrime.disabled === false && els.covPrimeValue.textContent === "8s" && /How many seconds/.test(els.covPrimeNote.textContent));
  state.tokenizerReady = false;
  vm.runInContext("paintCoverPrime()", context);
  ok("without the tokenizer it is off as before", els.covPrime.disabled === true && /real-audio tokenizer/.test(els.covPrimeNote.textContent));
  ok("the engine painter repaints the prime row (guarded for the harnesses that lift it)",
    /if \(typeof paintCoverPrime === "function"\) paintCoverPrime\(\);/.test(between(app, "function musicEnginePaint()", "/* The configuration ladder.")));
  ok("the progress line says the song is sung from your score",
    /cur\.scoreSupplied \? `singing your score \(\$\{cur\.cot \|\| "full"\}\)`/.test(app));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
