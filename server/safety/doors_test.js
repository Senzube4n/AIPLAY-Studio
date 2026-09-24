/**
 * THE MINORS RULE AT EVERY DOOR.
 *
 * minors_test.js proves WHAT is refused. This proves WHERE: that every way a
 * picture can be asked for refuses the same requests, answers the same 422
 * with the same sentence, queues nothing, and files a `refused` event that
 * holds no words. Three kinds of evidence, each where it is strongest:
 *
 *   RUN   the choke point itself — engine.dispatch() with a fake engine and a
 *         temp ledger — refuses when called directly, whatever `private`,
 *         `dryRun`, the actor or injected deps say, sends nothing, stores no
 *         graph, and writes one event with no prompt in it. Then the modules
 *         that refuse on their own: the art queue (and MV's wait on it), the
 *         collab order and video recipe, the overnight plan, the Comfy Router
 *         queue (add AND the resumed step), the enhancer, the engine's HTTP
 *         door and the backstop's check door.
 *   READ  server/index.js's routes, which cannot be booted here: each door's
 *         check is pinned in place (before staging, before art.request) and
 *         answers 422. Every such pin runs TWICE, the second time against a
 *         copy with the check cut out, and must fail there — a pin that passes
 *         on a broken tree is not watching anything.
 *   GRAPHS the real builders: an adult render whose NEGATIVE prompt names
 *         minors is not refused (Qwen's one-node negative_prompt, a checkpoint
 *         negative, LTX's house negative), songs are not read as pictures, and
 *         a prompt hidden in AnimateDiff's JSON schedule or a custom node's
 *         odd key is found.
 *
 * Temp folders only: no server, no ComfyUI, no GPU, and never the owner's
 * ledger. `node server/safety/doors_test.js`
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The scratch world, set before config.js is first imported. */
const TMP = mkdtempSync(path.join(os.tmpdir(), "aiplay-safety-doors-"));
process.env.AIPLAY_OUTPUT = path.join(TMP, "output");
process.env.AIPLAY_APPDATA = path.join(TMP, "appdata");
process.env.AIPLAY_INPUT = path.join(TMP, "input");
process.env.AIPLAY_RIG = path.join(TMP, "rig");
process.env.AIPLAY_MV_DIR = path.join(TMP, "mv");
process.env.AIPLAY_MODELS_DIR = path.join(TMP, "models");
for (const d of [process.env.AIPLAY_OUTPUT, process.env.AIPLAY_APPDATA, process.env.AIPLAY_INPUT]) mkdirSync(d, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const src = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const { CODE, REFUSAL, CONTEXT_HINT, fingerprintOf } = await import("./minors.js");
const { checkGraph, graphTexts, isBlob, UNVERIFIABLE, UNVERIFIABLE_CODE } = await import("./graph.js");
const { onRefusal, refusalEvent } = await import("./refusal.js");
const { LineageMap, lineageOf, projectRowFingerprint } = await import("./lineage.js");
const provenance = await import("../provenance.js");
const { createEngineClient } = await import("../engine/client.js");
const { createStore } = await import("../engine/store.js");
const { createEngineRoutes } = await import("../engine/routes.js");
const { createSafetyRoutes } = await import("./routes.js");
const { BACKSTOP_TOKEN, backstopEnv } = await import("./backstop.js");
const { ArtRunner } = await import("../art.js");
const { awaitArt, castContext, castFlags } = await import("../mv/generate.js");
const { checkPrompt: checkPromptOf } = await import("./minors.js");
const { makeOrder, readOrder, ORDER_V } = await import("../collab/order.js");
const { normalizeVideoRecipe, makeVideoRecipe, readVideoRecipe } = await import("../collab/video-recipe.js");
const { cleanMediaItem } = await import("../batch.js");
const { createRouterJobs } = await import("../router/jobs.js");
const { createRouterRoutes } = await import("../router/routes.js");
const { createEnhancer, createPromptToolRoutes } = await import("../prompt-tools.js");
const workflow = await import("../workflow.js");
const { qwenImageGraph } = await import("../qwen-image.js");
const { animateGraph } = await import("../animatediff.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const section = (s) => console.log(`\n  -- ${s} --`);

/* Every refusal announced outside the engine door lands here, the way
 * server/index.js's one listener files it. */
const announced = [];
onRefusal((evt) => { announced.push(evt); });
const lastAnnounced = () => announced[announced.length - 1];

/* The words used below, so "no words in the ledger" can be checked against
 * exactly what was asked. Clinical pairs only. */
const PAIR = "child nude";
const WORDS = ["child", "nude", "teen", "lingerie", "toddler", "naked", "kid"];
const holdsWords = (obj) => {
  /* The refusal sentence itself says "child"; it is the answer, not the request. */
  const text = JSON.stringify(obj).split(REFUSAL).join("").toLowerCase();
  return WORDS.some((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(text));
};

const SAVE = { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "safety_test" } };
const pictureGraph = (text) => ({
  1: { class_type: "CLIPTextEncode", inputs: { clip: ["9", 0], text } },
  2: { class_type: "SomeSampler", inputs: { positive: ["1", 0], seed: 1 } },
  3: SAVE,
  9: { class_type: "CLIPLoader", inputs: { clip_name: "clip.safetensors", type: "flux2" } },
});

/* ══ GRAPHS ════════════════════════════════════════════════════════════ */
section("graphs: negatives are not intent, songs are not pictures, hidden prompts are found");
{
  const ck = workflow.checkpointGraph({ ckpt: "adult.safetensors", prompt: "nude figure study of an adult woman",
    negative: "child, teen, underage, loli", seed: 1, width: 1024, height: 1024, steps: 20, cfg: 6 });
  ok("a checkpoint render whose NEGATIVE names minors is not refused", checkGraph(ck).ok, JSON.stringify(graphTexts(ck).positive));
  const ckBad = workflow.checkpointGraph({ ckpt: "adult.safetensors", prompt: "teen lingerie",
    negative: "blurry", seed: 1, width: 1024, height: 1024, steps: 20, cfg: 6 });
  ok("...and the same graph with the pair in its POSITIVE is", checkGraph(ckBad).ok === false);

  const qw = qwenImageGraph({ prompt: "nude figure study of an adult woman", negative: "child, teen, underage",
    seed: 1, width: 1024, height: 1024, steps: 4, cfg: 2 });
  ok("Qwen keeps both prompts on ONE node; its negative_prompt is still not intent", checkGraph(qw).ok);
  const qwBad = qwenImageGraph({ prompt: "toddler naked", negative: "", seed: 1, width: 1024, height: 1024, steps: 4, cfg: 1 });
  ok("...and its positive prompt is", checkGraph(qwBad).ok === false);
  /* FAST DRAFT is a render door too: the same TextEncodeQwenImage21 under a LoRA
   * and a custom sampler. Its ManualSigmas text and the unguided negative must not
   * make a clean draft unverifiable, and its positive is read like any other. */
  const qwDraft = qwenImageGraph({ prompt: "a storyboard frame of a harbor at night", seed: 1, draft: true });
  ok("a clean Qwen Fast draft passes the door (not refused, not unverifiable)", checkGraph(qwDraft).ok, JSON.stringify(checkGraph(qwDraft)));
  const qwDraftBad = qwenImageGraph({ prompt: "toddler naked", seed: 1, draft: true, refImages: ["ref.png"] });
  ok("...and a draft's positive prompt is refused at the door", checkGraph(qwDraftBad).ok === false && checkGraph(qwDraftBad).code === checkGraph(qwBad).code,
    "the same minors verdict as the full render, not an unverifiable graph");

  const ltx = workflow.videoGraphLtx({ prompt: "a nude adult dancer on a stage", seed: 1, seconds: 3, width: 768, height: 512 });
  ok("LTX's house negative (it says \"childish\") does not refuse an adult render", checkGraph(ltx).ok);

  const song = workflow.buildYue2ComfyGraph({ caption: "punk", lyrics: "teenage kicks, sexy nights", seed: 1, checkpoint: "y.safetensors" });
  ok("a song's lyrics are not a picture: a YuE2 graph is not read", graphTexts(song).visual === false && checkGraph(song).ok);
  const mm = workflow.buildGraph({ caption: "pop", lyrics: "baby, teen, sexy", seed: 1, model: "m.safetensors" });
  ok("...nor a MiniMax Music graph", graphTexts(mm).visual === false);
  const chat = { 1: { class_type: "TextGenerate", inputs: { prompt: PAIR } }, 2: { class_type: "PreviewAny", inputs: { source: ["1", 0] } } };
  ok("...nor a chat turn (TextGenerate into PreviewAny)", checkGraph(chat).ok);
  const unknownOut = { 1: { class_type: "TextGenerate", inputs: { prompt: PAIR } }, 2: { class_type: "SomebodysSaveNode", inputs: { source: ["1", 0] } } };
  ok("an output class the list does not know IS read (fail closed)", checkGraph(unknownOut).ok === false);

  const ad = animateGraph({ source: "clip.mp4", frames: 16, width: 512, height: 512, seed: 1,
    schedule: { 0: "a kid on a swing", 8: "naked" } });
  ok("a prompt inside AnimateDiff's JSON schedule is found", checkGraph(ad).ok === false);
  const custom = { 1: { class_type: "SomeCustomNode", inputs: { wildly_named_field: { nested: ["teen lingerie"] } } }, 2: SAVE };
  ok("a prompt under any key, at any depth, of a custom node is found", checkGraph(custom).ok === false);
  const lora = { 1: { class_type: "LoraLoader", inputs: { lora_name: "loli_style.safetensors", model: ["3", 0], clip: ["3", 1] } },
    2: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "nude" } }, 3: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    4: SAVE };
  ok("a LoRA's file name counts", checkGraph(lora).ok === false);
  const blob = { 1: { class_type: "LoadImageBase64", inputs: { image: `data:image/png;base64,${"a".repeat(64)}kid${"b".repeat(64)}` } }, 2: { ...SAVE, inputs: { images: ["1", 0] } } };
  ok("an inline picture (data: URI) is not read as words", graphTexts(blob).positive.length === 0);
  ok("context counts: a clean graph with a minor in its safetyContext and nudity in the prompt is refused",
    checkGraph(pictureGraph("<Picture 1> is Ana, nude"), { context: ["Ana is 9 years old"] }).ok === false);
  ok("flags count: a clean graph over a picture flagged minor, with nudity in the prompt, is refused",
    checkGraph(pictureGraph("make her nude"), { flags: [{ minor: true, sexual: false }] }).ok === false);
}

section("graphs: the structural tricks a raw graph can play (review 2026-09-24)");
{
  /* A plain checkpoint render, the pair split so each trick has somewhere to
   * hide it. `bad` is always the words the model will really read. */
  const T = PAIR;
  const base = () => ({
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
    2: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: T } },
    3: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "" } },
    4: { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    5: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
    6: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    9: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "x" } },
  });
  const refused = (g) => checkGraph(g).ok === false;
  ok("the plain graph is refused (the table below is not vacuous)", refused(base()));
  {
    const g = base(); g[2].inputs.text = "a cat"; g[3].inputs.text = T; g[5].inputs.cfg = 0;
    ok("A: the pair in the NEGATIVE of a sampler at cfg 0 (which renders its negative) is refused", refused(g));
    const g1 = base(); g1[2].inputs.text = "a cat"; g1[3].inputs.text = T; g1[5].inputs.cfg = ["7", 0];
    ok("A': ...and so is a negative whose sampler's cfg is WIRED, so nobody can prove it is at least 1", refused(g1));
    const ok1 = base(); ok1[2].inputs.text = "nude adult figure study"; ok1[3].inputs.text = "child, teen"; ok1[5].inputs.cfg = 1;
    ok("...while at cfg 1 a negative naming minors under an adult positive is still not intent", checkGraph(ok1).ok);
  }
  {
    const g = base(); g[10] = { class_type: "PreviewAny", inputs: { source: ["2", 0], meta: { r: ["9", 0] } } };
    ok("B: a link-shaped value NESTED in an input does not hide SaveImage (only top-level wires are wires)", refused(g) && graphTexts(g).visual);
  }
  {
    const g = base(); g[7] = { class_type: "ConditioningCombine", inputs: { conditioning_1: ["2", 0], conditioning_2: ["3", 0] } };
    g[5].inputs.positive = ["7", 0];
    g[8] = { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["3", 0], negative: ["2", 0], cfg: 1 } };
    ok("C: a dummy guider's negative wire does not make the real positive's words negative", refused(g));
  }
  {
    const g = base(); g[2].inputs.text = `a\nphoto\nof\na\n${T.replace(" ", "\n")}${"\n".repeat(2100)}x`;
    ok("D: words padded with newlines to look like base64 are read", refused(g) && !isBlob(g[2].inputs.text));
  }
  {
    const g = base(); g[11] = { class_type: "StringConcatenate", inputs: { string_a: "chi", string_b: "ld nude", delimiter: "" } }; g[2].inputs.text = ["11", 0];
    const r = checkGraph(g);
    ok("E: words assembled by StringConcatenate while the graph runs are refused as unverifiable",
      r.ok === false && r.code === UNVERIFIABLE_CODE && r.reason === UNVERIFIABLE, JSON.stringify(r));
    const g2 = base(); g2[11] = { class_type: "StringReplace", inputs: { string: "cXild nude", find: "X", replace: "h" } }; g2[2].inputs.text = ["11", 0];
    ok("F: ...and by StringReplace", checkGraph(g2).code === UNVERIFIABLE_CODE);
    const g3 = base(); g3[2].inputs.text = "a lighthouse"; g3[11] = { class_type: "TextGenerate", inputs: { clip: ["1", 1], prompt: "write a caption" } }; g3[12] = { class_type: "MyEncoder", inputs: { clip: ["1", 1], words: ["11", 0] } };
    g3[5].inputs.positive = ["12", 0];
    ok("...and by a text generator feeding an encoder under any key name", checkGraph(g3).code === UNVERIFIABLE_CODE);
    const g4 = base(); g4[11] = { class_type: "PrimitiveStringMultiline", inputs: { value: "a lighthouse at dusk" } }; g4[2].inputs.text = ["11", 0];
    ok("...while a plain text primitive wired into the encoder is read, and passes", checkGraph(g4).ok);
    const g5 = base(); g5[2].inputs.text = "a lighthouse"; g5[11] = { class_type: "LoadImageTextSetFromFolderNode", inputs: { folder: "set" } };
    ok("...and captions read from a folder on a picture graph are unverifiable", checkGraph(g5).code === UNVERIFIABLE_CODE);
  }
  {
    const schedule = JSON.stringify({ 0: "CHILDWORD nude" }).replace("CHILDWORD", "\\u0063hild");
    const g = base(); g[2] = { class_type: "AiplayPromptSchedule", inputs: { clip: ["1", 1], schedule } };
    ok("G: a JSON schedule is DECODED, escapes and all", refused(g));
  }
  {
    const g = base(); g[2] = { class_type: "SomeCustomEncode", inputs: { clip: ["1", 1], negative_style: T } };
    ok("H: a negative-named key on a node nothing proves is a negative encoder is read", refused(g));
  }
  {
    const g = base(); g[10] = { class_type: "SaveAudio", inputs: { audio: ["9", 0] } };
    ok("I: a SaveAudio hung off SaveImage does not make a picture graph a song", refused(g));
  }
  {
    const lora = {
      1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
      2: { class_type: "LoadImageSetFromFolderNode", inputs: { folder: "set" } },
      3: { class_type: "VAEEncode", inputs: { pixels: ["2", 0], vae: ["1", 2] } },
      4: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: T } },
      5: { class_type: "TrainLoraNode", inputs: { model: ["1", 0], latents: ["3", 0], positive: ["4", 0], batch_size: 1, steps: 100, learning_rate: 0.0001, rank: 8 } },
      7: { class_type: "SaveLoRA", inputs: { lora: ["5", 0], prefix: "x", steps: ["5", 2] } },
    };
    ok("an IMAGE LoRA training run is a picture graph, and its captions are read", graphTexts(lora).visual && refused(lora));
    const train = await import("../music/train.js");
    const g = train.trainGraph({ ckpt: "yue2.safetensors", sliceName: "a.wav", codesDir: "C:/codes", seconds: train.SECONDS_MAX,
      steps: 50, rank: 2, learningRate: 0.0002, name: "teen_sexy" });
    ok("the Studio's own MUSIC LoRA training graph is not a picture", graphTexts(g).visual === false, JSON.stringify(Object.values(g).map((n) => n.class_type)));
  }
  {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 7)]).toString("base64");
    ok("a real inline PNG (base64) is a picture, not words", isBlob(png));
    const words = Buffer.from(`${PAIR} `.repeat(300)).toString("base64");
    ok("base64 that is not a media file is not skipped as one", !isBlob(words));
    const g = base(); g[2].inputs.text = "a lighthouse"; g[12] = { class_type: "SomeLoader", inputs: { payload: words } };
    ok("...and its decoded words are read", refused(g));
    const g2 = base(); g2[2].inputs.text = "a lighthouse"; g2[12] = { class_type: "SomeLoader", inputs: { uri: `data:text/plain,${encodeURIComponent(PAIR)}` } };
    ok("a data: URI that is not a picture is read", refused(g2));
  }
}

/* ══ RUN: THE CHOKE POINT ═══════════════════════════════════════════════ */
section("run: engine.dispatch refuses when called directly, and leaves no words anywhere");
const ledgerDir = path.join(TMP, "ledger");
mkdirSync(ledgerDir, { recursive: true });
const ledger = { append: (_s, evt) => provenance.append({ dir: ledgerDir }, evt), read: (_s, o) => provenance.read({ dir: ledgerDir }, o) };
const graphDir = path.join(TMP, "graphs");
const store = createStore({ graphDir, hashCacheFile: path.join(TMP, "hashes.json"), outputDir: process.env.AIPLAY_OUTPUT,
  inputDir: process.env.AIPLAY_INPUT, prov: ledger });
const fetches = [];
const fakeFetch = async (url, opts = {}) => {
  fetches.push(String(url));
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (String(url).includes("/prompt")) return reply({ prompt_id: "p1" });
  if (String(url).includes("/history/")) return reply({ p1: { status: { status_str: "success", completed: true }, outputs: {} } });
  if (String(url).includes("/queue")) return reply({ queue_running: [], queue_pending: [] });
  return reply({});
};
const makeClient = (extra = {}) => {
  const c = createEngineClient({ provenance: ledger, fetch: fakeFetch, store, poll: { POLL_MS: 5 }, port: 47999, ...extra });
  c.attachChild({ exitCode: null, signalCode: null });
  return c;
};
const readLedger = async () => (await provenance.read({ dir: ledgerDir })).events;
{
  const c = makeClient();
  const tries = [
    ["a plain run", { graph: pictureGraph(PAIR), via: "api", actor: "agent:test" }],
    ["a PRIVATE run", { graph: pictureGraph(PAIR), via: "art.image", actor: "user", private: true }],
    ["a DRY run", { graph: pictureGraph(PAIR), via: "api", actor: "script:x", dryRun: true }],
    ["a run with no via at all", { graph: pictureGraph(PAIR) }],
    ["a submit (wait: false)", { graph: pictureGraph(PAIR), via: "api", wait: false }],
    ["a run labelled with the words", { graph: pictureGraph(PAIR), via: "api", label: PAIR, note: PAIR }],
  ];
  for (const [what, spec] of tries) {
    const before = (await readLedger()).length;
    let err = null;
    try { await c.dispatch(spec); } catch (e) { err = e; }
    ok(`${what}: refused with the sentence, the code and a 422`,
      !!err && err.message === REFUSAL && err.code === CODE && err.status === 422 && err.safety === true, err?.message);
    const events = (await readLedger()).slice(before);
    ok(`${what}: exactly one ledger event, of type "refused"`, events.length === 1 && events[0].type === "refused",
      JSON.stringify(events.map((e) => e.type)));
    ok(`${what}: the event holds the code and the door, and NO words, label or hash of them`,
      events[0]?.data?.code === CODE && events[0]?.data?.door === "engine.dispatch" && !holdsWords(events[0])
      && !["prompt", "texts", "label", "note", "promptHash", "graphHash", "negative"].some((k) => k in (events[0]?.data || {})),
      JSON.stringify(events[0]));
  }
  {
    /* The words a StringReplace node will compute on the engine: nothing here can read them. */
    const computed = {
      ...pictureGraph("x"),
      1: { class_type: "StringReplace", inputs: { string: "a lighthouse", find: "a", replace: "b" } },
      4: { class_type: "CLIPTextEncode", inputs: { clip: ["9", 0], text: ["1", 0] } },
      2: { class_type: "SomeSampler", inputs: { positive: ["4", 0], seed: 1 } },
    };
    const before = (await readLedger()).length;
    let err = null;
    try { await c.dispatch({ graph: computed, via: "api", private: true }); } catch (e) { err = e; }
    ok("a graph whose words are written while it runs is refused at the door, 422, with its own code and sentence",
      err?.code === UNVERIFIABLE_CODE && err.message === UNVERIFIABLE && err.status === 422 && err.safety === true, err?.message);
    const ev = (await readLedger()).slice(before);
    ok("...and filed as one wordless refused event carrying that code",
      ev.length === 1 && ev[0].type === "refused" && ev[0].data.code === UNVERIFIABLE_CODE && !holdsWords(ev[0]), JSON.stringify(ev));
  }
  ok("nothing reached the engine: zero fetches of any kind", fetches.length === 0, JSON.stringify(fetches));
  ok("no graph was filed in the graph store", !existsSync(graphDir) || readdirSync(graphDir).length === 0);
  ok("no delegate line was written", (await readLedger()).every((e) => e.type === "refused"));

  const off = makeClient({ safety: false, checkGraph: () => ({ ok: true }), check: null, allowMinors: true });
  let err = null;
  try { await off.dispatch({ graph: pictureGraph(PAIR), via: "api" }); } catch (e) { err = e; }
  ok("NO SWITCH: deps named safety/checkGraph/allowMinors change nothing", !!err && err.code === CODE);

  err = null;
  try { await c.run({ graph: pictureGraph("<Picture 1> is Ana, nude"), via: "art.clip", safetyContext: ["Ana, 9 years old"] }); } catch (e) { err = e; }
  ok("safetyContext is honoured at the door (a cast description behind a picture)", !!err && err.code === CODE);

  const adult = workflow.checkpointGraph({ ckpt: "adult.safetensors", prompt: "nude figure study of an adult woman",
    negative: "child, teen", seed: 1, width: 1024, height: 1024, steps: 20, cfg: 6 });
  const dry = await c.dispatch({ graph: adult, via: "api", dryRun: true });
  ok("an adult render with minors in its negative passes the door (dry run returns its record)", dry?.dryRun === true);
  const clean = await c.run({ graph: pictureGraph("a lighthouse at dusk"), via: "api", adopt: false });
  ok("...and a clean graph is sent as before", fetches.some((u) => u.endsWith("/prompt")) && clean.status === "completed",
    JSON.stringify({ status: clean.status, fetches }));
}

section("run: the engine's HTTP door answers 422 with the sentence");
{
  const c = makeClient();
  const out = [];
  const routes = createEngineRoutes({
    json: (_r, status, body) => out.push({ status, body }),
    readBody: async (req) => req._body, config: { uiPort: 4173 }, engine: c, IMAGE_DIR: TMP, CLIP_DIR: TMP,
    provenance: { ...ledger, actorFrom: provenance.actorFrom, normalizeActor: provenance.normalizeActor },
  });
  await routes({ method: "POST", headers: { "x-aiplay-actor": "agent:test" }, _body: { graph: pictureGraph("teen lingerie") } },
    {}, new URL("http://x/api/engine/prompt"));
  const r = out.pop();
  ok("POST /api/engine/prompt with a refused graph: 422, the sentence, the code",
    r?.status === 422 && r.body.error === REFUSAL && r.body.code === CODE, JSON.stringify(r));
}

section("run: the backstop's check door (what ComfyUI's own node asks)");
{
  const out = [];
  const routes = createSafetyRoutes({ json: (_r, status, body) => out.push({ status, body }), readBody: async (req) => req._body, token: BACKSTOP_TOKEN });
  const ask = async (headers, body) => { await routes({ method: "POST", headers, _body: body }, {}, new URL("http://x/api/safety/check")); return out.pop(); };
  ok("no token: 403", (await ask({}, { prompt: pictureGraph(PAIR) }))?.status === 403);
  ok("a wrong token: 403", (await ask({ "x-aiplay-safety-token": "0".repeat(48) }, { prompt: pictureGraph(PAIR) }))?.status === 403);
  const good = { "x-aiplay-safety-token": BACKSTOP_TOKEN };
  const before = announced.length;
  const no = await ask(good, { prompt: pictureGraph("toddler naked") });
  ok("a refused graph: ok:false with the sentence and the code", no?.status === 200 && no.body.ok === false && no.body.error === REFUSAL && no.body.code === CODE, JSON.stringify(no));
  ok("...announced once, as door engine.backstop, with no words",
    announced.length === before + 1 && lastAnnounced().data.door === "engine.backstop" && !holdsWords(lastAnnounced()));
  const yes = await ask(good, { prompt: pictureGraph("a lighthouse at dusk") });
  ok("a clean graph: ok:true", yes?.body?.ok === true);
  const computed = { 1: { class_type: "StringConcatenate", inputs: { string_a: "a", string_b: "b", delimiter: "" } },
    2: { class_type: "CLIPTextEncode", inputs: { clip: ["9", 0], text: ["1", 0] } }, 3: { class_type: "SomeSampler", inputs: { positive: ["2", 0] } },
    4: { class_type: "SaveImage", inputs: { images: ["3", 0] } }, 9: { class_type: "CLIPLoader", inputs: { clip_name: "c.safetensors" } } };
  const unv = await ask(good, { prompt: computed });
  ok("a graph that writes its words while it runs: ok:false with its own sentence and code",
    unv?.body?.ok === false && unv.body.error === UNVERIFIABLE && unv.body.code === UNVERIFIABLE_CODE, JSON.stringify(unv));
  const env = backstopEnv(4173);
  ok("the engine is told where to ask and the per-boot token",
    env.AIPLAY_SAFETY_URL === "http://127.0.0.1:4173/api/safety/check" && env.AIPLAY_SAFETY_TOKEN === BACKSTOP_TOKEN && BACKSTOP_TOKEN.length >= 32);
  ok("the token door refuses to exist without a token", (() => { try { createSafetyRoutes({ json() {}, readBody() {} }); return false; } catch { return true; } })());
}

/* ══ RUN: THE ART QUEUE ═════════════════════════════════════════════════ */
section("run: the art queue refuses, queues nothing, and tells every kind of waiter");
{
  const runner = new ArtRunner(null, null);
  runner.paused = true;                       // nothing here may try to render
  runner.enabled = true;
  const failed = [];
  runner.on("failed", (e) => failed.push(e));
  const cases = [
    ["a picture from the Images screen", { file: "image:s1", kind: "cover", asked: true, video: { prompt: PAIR } }],
    ["a clip with its own prompt", { file: "clip:s2", kind: "video", force: true, video: { prompt: "teen lingerie" } }],
    ["a clip made from a track's CAPTION", { file: "song-a.flac", kind: "video", caption: "toddler naked", title: "A" }],
    ["a cover written from a song's LYRICS", { file: "song-b.flac", title: "B", lyrics: "a teen in lingerie\na teen in lingerie\nthe end of it", asked: true }],
    ["a restyle", { file: "c.mp4", kind: "restyle", force: true, video: { prompt: "kid nude" } }],
    ["a clean prompt whose CONTEXT names a child", { file: "image:s3", kind: "cover", asked: true, video: { prompt: "<Picture 1> is Ana, nude", safetyContext: ["Ana, 9 years old"] } }],
  ];
  for (const [what, req] of cases) {
    const before = announced.length;
    const job = runner.request(req);
    ok(`${what}: request() answers null and queues nothing`, job === null && runner.queue.length === 0, JSON.stringify(runner.queue.map((j) => j.file)));
    ok(`${what}: the route can answer 422 with the sentence`, runner.lastRefusalBody?.error?.startsWith(REFUSAL) && runner.lastRefusalBody?.code === CODE && runner.lastRefusalCode === CODE);
    ok(`${what}: \`failed\` went out for this file, with the code`, failed.some((e) => e.file === req.file && e.code === CODE && e.error.startsWith(REFUSAL)));
    ok(`${what}: announced once as door art.request, with no words`,
      announced.length === before + 1 && lastAnnounced().data.door === "art.request" && !holdsWords(lastAnnounced()));
  }
  const fine = runner.request({ file: "image:s4", kind: "cover", asked: true, video: { prompt: "a lighthouse at dusk" } });
  ok("a clean picture is still queued, and clears the last refusal", !!fine && runner.queue.length === 1 && runner.lastRefusalBody === null);
  const stems = runner.request({ file: "song-c.flac", kind: "stems", title: "teen lingerie" });
  ok("a kind that makes no picture (stems) is not read", !!stems);
  runner.queue.length = 0;

  const t0 = Date.now();
  let err = null;
  try { await awaitArt(runner, "image:s1", ["cover"], 60_000); } catch (e) { err = e; }
  ok("MV's awaitArt, starting AFTER the refusal, rejects at once rather than waiting out its deadline",
    !!err && err.code === CODE && err.status === 422 && Date.now() - t0 < 2000, `${err?.message} after ${Date.now() - t0} ms`);

  runner.request({ file: "image:s9", kind: "cover", asked: true, video: { prompt: PAIR } });
  const wasRefused = !!runner.refusalFor("image:s9");
  runner.request({ file: "image:s9", kind: "cover", asked: true, video: { prompt: "a lighthouse at dusk" } });
  ok("a file refused, then asked for again with words that pass, is no longer remembered as refused",
    wasRefused && runner.refusalFor("image:s9") === null);
  runner.queue.length = 0;
  const fp = runner.request({ file: "image:s10", kind: "cover", asked: true, video: { prompt: "a toddler at the beach" } });
  ok("a queued job carries its wordless fingerprint, for the picture it will make",
    JSON.stringify(fp?.safety) === '{"minor":true,"sexual":false}');
  runner.queue.length = 0;
  const flagged = runner.request({ file: "image:s11", kind: "cover", asked: true, video: { prompt: "make her nude", safetyFlags: [{ minor: true, sexual: false }] } });
  ok("the queue reads the flags of the pictures a job is handed, and says part of it came from them",
    flagged === null && runner.lastRefusalBody?.error.startsWith(REFUSAL) && runner.lastRefusalBody.error.includes(CONTEXT_HINT)
    && JSON.stringify(runner.lastRefusalBody.found) === JSON.stringify({ minor: ["context"], sexual: ["prompt"] }));

  const { EventEmitter } = await import("node:events");
  const fake = Object.assign(new EventEmitter(), { refusalFor: () => null });
  const waiting = awaitArt(fake, "image:late", ["cover"], 5000).then(() => null, (e) => e);
  fake.emit("failed", { file: "image:late", code: UNVERIFIABLE_CODE, error: UNVERIFIABLE });
  const late = await waiting;
  ok("a refusal heard as an event keeps its own code and sentence (here: words written while it runs)",
    late?.safety === true && late.code === UNVERIFIABLE_CODE && late.message === UNVERIFIABLE, late?.message);
}

section("run: MV hands the words behind each <Picture n> to the check");
{
  const doc = {
    characters: [{ name: "Ana", description: "Ana, 9 years old", sheetPrompt: "character sheet of Ana" }, { name: "Bo", description: "an adult" }],
    backgrounds: [{ name: "Beach", platePrompt: "a beach" }], props: [],
  };
  const ctx = castContext(doc, ["Ana", "Beach", "Nobody"]);
  ok("castContext gathers each named row's description, sheet and plate prompts",
    ctx.includes("Ana, 9 years old") && ctx.includes("character sheet of Ana") && ctx.includes("a beach") && !ctx.includes("an adult"));

  /* THE LAUNDERING THE REVIEW FOUND: render the sheet from a child's
   * description, change the description to an adult's, then render a sexual
   * board. The words say adult now; the adopted take says what it was drawn as. */
  const laundered = {
    characters: [{ name: "Ana", description: "an adult woman", imageFile: "char_ana.png",
      takes: [{ file: "char_old.png", safety: { minor: false, sexual: false } }, { file: "char_ana.png", safety: fingerprintOf("Ana, 9 years old") }] }],
    backgrounds: [], props: [],
  };
  const flags = castFlags(laundered, ["Ana"]);
  ok("castFlags reads the fingerprint of the take the row ADOPTED, whatever its words say now",
    flags.length === 1 && flags[0].minor === true);
  ok("...so a sexual board over that sheet is refused although every word in view is adult",
    checkPromptOf("<Picture 1> is Ana. She is nude.", { context: castContext(laundered, ["Ana"]), flags }).ok === false);
  ok("...and the same board over a sheet drawn as an adult is not",
    checkPromptOf("<Picture 1> is Ana. She is nude.", { context: castContext(laundered, ["Ana"]),
      flags: castFlags({ ...laundered, characters: [{ ...laundered.characters[0], imageFile: "char_old.png" }] }, ["Ana"]) }).ok);
  const errandRow = { characters: [{ name: "Kid", description: "", imageFile: "x.png", safety: { minor: true, sexual: false } }] };
  ok("castFlags reads a row's own flags too (a friend's errand has no takes)", castFlags(errandRow, ["Kid"])[0]?.minor === true);
}

section("run: what a picture was made as survives every derivation, however many steps back");
{
  const rows = (n) => [images.get(n), clips.get(n)].filter(Boolean);
  const images = new LineageMap(rows);
  const clips = new LineageMap(rows);
  /* A PRIVATE render: no words kept, only the two booleans the art queue stamped. */
  images.set("a.png", { promptRedacted: true, seed: 1, safety: fingerprintOf("portrait of a toddler") });
  ok("a private picture keeps no words and still carries its fingerprint",
    images.get("a.png").prompt === undefined && images.get("a.png").safety.minor === true
    && Object.values(images.get("a.png").safety).every((v) => typeof v === "boolean"));
  /* Five editor edits, each naming only its parent (as the editor registers them). */
  let prev = "a.png";
  for (let i = 1; i <= 5; i++) { images.set(`e${i}.png`, { prompt: "brighter", generatedFrom: `gen${i}.png`, derivedFrom: prev }); prev = `e${i}.png`; }
  ok("five edits later the fingerprint was copied forward at every step", images.get("e5.png").safety.minor === true);
  images.set("other.png", { prompt: "a lighthouse" });
  images.set("sheet.png", { prompt: "contact sheet of 2 images", sheetOf: ["e5.png", "other.png"] });
  images.set("comp.png", { compositeOf: "other.png", compositeSources: ["sheet.png"] });
  images.set("doc.png", { documentOf: ["comp.png"] });
  images.set("still.png", { prompt: "comp frame at 2s", source: "vfx", layerSources: ["doc.png"] });
  images.set("mask.png", { maskOf: "still.png", prompt: "selection matte of still.png" });
  images.set("vec.png", { vectorFrom: "mask.png" });
  ok("...through a contact sheet, a composite, a document, a compositor still, a mask and a vector",
    ["sheet.png", "comp.png", "doc.png", "still.png", "mask.png", "vec.png"].every((n) => images.get(n).safety.minor === true));
  clips.set("c1.mp4", { prompt: "she walks away", firstFrame: "vec.png" });
  clips.set("c2.mp4", { prompt: "she keeps walking", extendedFrom: "c1.mp4" });
  clips.set("c3.mp4", { source: "restyle", from: "c2.mp4", prompt: "oil paint" });
  ok("...and into a clip opened on it, its extension and its restyle", clips.get("c3.mp4").safety.minor === true);
  const lin = lineageOf(["c3.mp4"], rows);
  ok("lineageOf walks every ancestor (no depth limit) and hands back the flags",
    lin.flags.some((f) => f.minor) && lin.texts.includes("brighter"));
  ok("\"make her nude\" on the restyle of the extension of a clip opened on that picture is refused",
    checkPromptOf("make her nude", { context: lin.texts, flags: lin.flags }).ok === false);
  ok("...and a clean edit of it is not", checkPromptOf("make it brighter", { context: lin.texts, flags: lin.flags }).ok);
  images.load("old.png", { prompt: "a toddler on a beach" });
  ok("a row read back from disk is stored as it was (no fingerprint invented at load)", images.get("old.png").safety === undefined);
  images.set("oldedit.png", { prompt: "brighter", derivedFrom: "old.png" });
  ok("...but a picture derived from it is fingerprinted from the old row's words", images.get("oldedit.png").safety.minor === true);
  images.set("loop1.png", { prompt: "x", derivedFrom: "loop2.png" });
  images.set("loop2.png", { prompt: "y", derivedFrom: "loop1.png" });
  ok("a lineage loop ends", Array.isArray(lineageOf(["loop1.png"], rows).texts));
}

section("run: a friend's order carries what its pictures were made as, and both sides read it");
{
  const kidSheet = { name: "Ana", description: "an adult woman", imageFile: "char_ana.png",
    takes: [{ file: "char_ana.png", safety: fingerprintOf("Ana, 9 years old") }] };
  const f = projectRowFingerprint(kidSheet, "char_ana.png");
  ok("projectRowFingerprint joins a row's words with its picture's take", f.minor === true && f.sexual === false);
  const shotWith = (safety) => ({ kind: "shot", v: 1, segmentId: "s1_0", prompt: "<Picture 1> is Ana. She is nude.",
    seconds: 4, width: 1344, height: 768, refs: [{ name: "Ana", sha256: "ab".repeat(32), bytes: 10, file: "char_ana.png", ...(safety ? { safety } : {}) }], guides: [] });
  let err = null;
  try { makeOrder({ shot: shotWith(f) }); } catch (e) { err = e; }
  ok("the SENDER cannot seal a sexual scene over a picture flagged minor", err?.status === 422 && err.reason === CODE, err?.message);
  err = null;
  try { readOrder({ kind: "order", v: ORDER_V, shot: shotWith(f), files: [], order: {}, returnTo: { fp: "ab".repeat(16) } }); } catch (e) { err = e; }
  ok("the LENDER refuses it too, reading only the flags (no words about Ana ever reached it)", err?.status === 422 && err.reason === CODE);
  err = null;
  try { makeOrder({ shot: shotWith(null), safetyContext: ["Ana, 9 years old"] }); } catch (e) { err = e; }
  ok("the sender also reads its cast's own words, which never leave its machine", err?.status === 422);
  err = null;
  try { makeOrder({ shot: shotWith({ minor: false, sexual: false }) }); } catch (e) { err = e; }
  ok("the same scene over a picture flagged adult gets past the check", err?.reason === "bad-arguments", err?.reason);
  const { errandDoc } = await import("../collab/errand.js");
  const orderDoc = { id: "o1", shot: { ...shotWith(f), engine: "h3", engineMode: "hybrid" }, order: { segmentId: "s1_0", steps: 8, engineMode: "hybrid", seed: 1 } };
  const edoc = errandDoc({ orderDoc, from: { fp: "ab".repeat(16), nickname: "x" }, staged: [{ file: "char_ana.png", name: "ref_1.png", role: "ref", sha256: "ab".repeat(32) }], now: 1 });
  ok("the lender's errand keeps each picture's flags on its row", edoc.characters[0].safety?.minor === true);
  ok("...so its own render door judges the scene with them", castFlags(edoc, edoc.boards[0].characterRefs, { board: edoc.boards[0] }).some((x) => x.minor));
}

/* ══ RUN: COLLAB, OVERNIGHT, ROUTER, ENHANCE ══════════════════════════ */
section("run: a friend's order is refused on both sides of the loan");
{
  const shot = (prompt) => ({ kind: "shot", v: 1, segmentId: "s1_0", prompt, seconds: 4, width: 1344, height: 768 });
  let err = null;
  const before = announced.length;
  try { makeOrder({ shot: shot("teen lingerie") }); } catch (e) { err = e; }
  ok("the SENDER cannot seal it: 422, the sentence, reason minor-sexual",
    !!err && err.status === 422 && err.message === REFUSAL && err.reason === CODE, err?.message);
  ok("...announced as door collab.order", announced.length === before + 1 && lastAnnounced().data.door === "collab.order");
  err = null;
  try { readOrder({ kind: "order", v: ORDER_V, shot: shot("child nude"), files: [], order: {}, returnTo: { fp: "ab".repeat(16) } }); } catch (e) { err = e; }
  ok("the LENDER cannot accept it", !!err && err.status === 422 && err.message === REFUSAL);
  err = null;
  try { makeOrder({ shot: shot("a lighthouse at dusk") }); } catch (e) { err = e; }
  ok("a clean scene gets past the check (and stops later, on its missing return address)", !!err && err.reason === "bad-arguments", err?.reason);
  err = null;
  try { makeOrder({ shot: { ...shot("a nude adult dancer"), negative: "child" } }); } catch (e) { err = e; }
  ok("a minor term in the scene's NEGATIVE is not intent", !!err && err.reason === "bad-arguments", err?.reason);
}

section("run: a video recipe is refused on pack and on open");
{
  const recipe = (prompt) => ({ engine: "h3", prompt, width: 1344, height: 768, seconds: 5, steps: 8, guidance: 1, keepAudio: false, seed: 1 });
  const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const e1 = threw(() => makeVideoRecipe(recipe("toddler naked")));
  ok("packing: 422 with the sentence", e1?.status === 422 && e1.message === REFUSAL);
  const e2 = threw(() => readVideoRecipe({ v: 1, kind: "video-recipe", recipeVersion: 1, id: "vr_x", at: 1, modelPolicy: "receiver-defaults", video: recipe("kid nude") }));
  ok("opening: 422 with the sentence", e2?.status === 422 && e2.message === REFUSAL);
  ok("a clean recipe normalises as before", normalizeVideoRecipe(recipe("waves at dusk")).prompt === "waves at dusk");
  ok("...and so does an adult one with minors only in its negative",
    normalizeVideoRecipe({ ...recipe("a nude adult dancer"), negative: "child, teen" }).negative === "child, teen");
}

section("run: an overnight plan is refused at start");
{
  const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  ok("an image plan item", threw(() => cleanMediaItem({ prompt: "teen lingerie" }, "image"))?.status === 422);
  ok("a video plan item", threw(() => cleanMediaItem({ prompt: "child nude" }, "video"))?.status === 422);
  ok("a wildcard TEMPLATE that could pair them in any take", threw(() => cleanMediaItem({ prompt: "{a kid|an adult} {nude|dressed}" }, "image"))?.code === CODE);
  ok("a music item is a song, not a picture, and is not read here", threw(() => cleanMediaItem({ caption: "teenage kicks, sexy nights" }, "music")) === null);
  ok("wildcard alternatives that can never share a take are not refused (each expansion is read, not the braces)",
    threw(() => cleanMediaItem({ prompt: "{a family picnic with kids|a nude figure study of an adult model}" }, "image")) === null);
  ok("a clean image item is kept", cleanMediaItem({ prompt: "a lighthouse", negative: "child" }, "image").prompt === "a lighthouse");
}

section("run: the Comfy Router (the cloud path the engine door never sees)");
{
  const dir = path.join(TMP, "router");
  const submitted = [];
  const client = { submit: async (...a) => { submitted.push(a); return { status: 200, json: { request_id: "r1", status: "IN_QUEUE" } }; },
    status: async () => ({ json: { status: "IN_QUEUE" } }), result: async () => ({}), cancel: async () => ({}) };
  const jobs = createRouterJobs({ client, dir, outDir: path.join(dir, "out"), tickMs: 60_000 });
  let err = null;
  try { await jobs.add({ model: "bfl/flux-2-pro", kind: "image", label: "x", prompt: "x", body: { input: { prompt: "teen lingerie" } } }); } catch (e) { err = e; }
  ok("add(): refused with a 422 before the run exists", err?.status === 422 && err.message === REFUSAL);
  ok("...so nothing about it was written to disk", !existsSync(path.join(dir, "runs.json")));
  err = null;
  try { await jobs.add({ model: "google/gemini-image", kind: "image", body: { contents: [{ parts: [{ text: "a toddler" }, { text: "naked" }] }] } }); } catch (e) { err = e; }
  ok("the prompt is found under any provider key (contents[].parts[].text)", err?.code === CODE);
  err = null;
  try { await jobs.add({ model: "anthropic/claude", kind: "text", body: { messages: [{ role: "user", content: PAIR }] } }); } catch (e) { err = e; }
  ok("a TEXT model is read too: it can be asked for an image tool, and whatever it returns is saved", err?.code === CODE);
  err = null;
  try { await jobs.add({ model: "openai/gpt-5.2", kind: "text", body: { input: PAIR, tools: [{ type: "image_generation" }] } }); } catch (e) { err = e; }
  ok("...an image_generation tool on a text body is refused", err?.code === CODE);
  const song = await jobs.add({ model: "suno/music-v5", kind: "audio", body: { lyrics: "teenage kicks, sexy nights" } });
  ok("a SOUND model that asks for no picture is not read (songs are not checked)", !!song?.id);
  err = null;
  try { await jobs.add({ model: "kling/video-with-sfx", kind: "audio", body: { prompt: PAIR } }); } catch (e) { err = e; }
  ok("...but a model filed as sound whose id makes video is read", err?.code === CODE);
  err = null;
  const padded = `a\nphoto\nof\na\n${PAIR.replace(" ", "\n")}${"\n".repeat(2100)}x`;
  try { await jobs.add({ model: "bfl/flux-2-pro", kind: "image", body: { prompt: padded } }); } catch (e) { err = e; }
  ok("text padded with newlines to look like base64 is read, not skipped as a file", err?.code === CODE);
  err = null;
  try { await jobs.add({ model: "bfl/flux-2-pro", kind: "image", label: "x", prompt: PAIR, body: { input: {} } }); } catch (e) { err = e; }
  ok("the prompt the route read off the form is checked as well as the body", err?.code === CODE);
  const gemini = await jobs.add({ model: "google/gemini-image", kind: "image", body: {
    contents: [{ role: "user", parts: [{ text: "a child reading a book in a library, watercolor" }] }],
    safetySettings: [{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" }] } });
  ok("a provider's own safety settings are not read as intent (a stricter setting must not cause a refusal)", !!gemini?.id);
  const adult = await jobs.add({ model: "bfl/flux-2-pro", kind: "image", body: { prompt: "nude adult figure", negative_prompt: "child, teen" } });
  ok("a negative_prompt naming minors is not intent", !!adult?.id);
  const pngB64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 7)]).toString("base64");
  const withPicture = await jobs.add({ model: "bfl/flux-2-pro", kind: "image", body: { prompt: "a lighthouse", input_image: pngB64 } });
  ok("a real inline picture is still not read as words", !!withPicture?.id);
  jobs.stop();

  /* A run written to disk by an older build, resumed after a restart. */
  const dir2 = path.join(TMP, "router2");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(path.join(dir2, "runs.json"), JSON.stringify([{ id: "old1", idem: "i", model: "bfl/flux-2-pro", kind: "image", label: "x",
    prompt: "toddler naked", status: "waiting", createdAt: 1, body: { prompt: "toddler naked" } }]));
  const jobs2 = createRouterJobs({ client, dir: dir2, outDir: path.join(dir2, "out"), tickMs: 60_000 });
  const sentBefore = submitted.length;
  const before = announced.length;
  await jobs2.tick();
  const run = (await jobs2.list())[0];
  /* Judged by WHAT was sent, not how many: the runs the first queue accepted
   * above are still being submitted in the background. */
  ok("step(): a resumed run is refused before it is sent", run.status === "failed" && run.error?.type === CODE
    && submitted.length >= sentBefore && !submitted.some((a) => JSON.stringify(a).includes("toddler naked")),
    JSON.stringify(run));
  ok("...and the list no longer keeps its words", run.prompt === "" && !holdsWords(run));
  ok("...announced as door router.step", announced.length === before + 1 && lastAnnounced().data.door === "router.step");
  jobs2.stop();

  const out = [];
  const routes = createRouterRoutes({
    json: (_r, status, body) => out.push({ status, body }), readBody: async (req) => req._body,
    config: { uiPort: 4173, cloudOnly: true },
    sameOriginLocalJson: () => true,
    secrets: { has: async () => true }, client: { listModels: async () => [] }, catalog: {}, jobs,
  });
  await routes({ method: "POST", headers: { host: "127.0.0.1:4173", "x-aiplay-actor": "agent:t", "content-type": "application/json" },
    /* confirmSpend: the person said yes to the credits (server/cloud-switch.js),
     * so what answers is the minors rule and not the spend question. */
    _body: { model: "bfl/flux-2-pro", raw: { prompt: "kid nude" }, confirmSpend: true } }, {}, new URL("http://x/api/router/run"));
  const r = out.pop();
  ok("POST /api/router/run: 422 with the sentence and the code", r?.status === 422 && r.body.error === REFUSAL && r.body.code === CODE, JSON.stringify(r));
  jobs.stop();
}

section("run: the enhancer checks what it is asked AND what it writes");
{
  let asked = 0;
  let reply = "a quiet lighthouse at dusk";
  const ask = Object.assign(async () => { asked++; return reply; }, { usesCard: async () => false });
  const models = { resolve: async () => ({ api: true, label: "api" }), status: async () => ({}), list: async () => ["m"] };
  const enh = createEnhancer({ models, ask });
  let err = null;
  try { await enh.enhance({ field: "simple", text: "teen lingerie" }); } catch (e) { err = e; }
  ok("a refused request is answered before any model is woken", err?.status === 422 && asked === 0);
  reply = "a toddler, naked";
  err = null;
  try { await enh.enhance({ field: "style", text: "a beach at noon" }); } catch (e) { err = e; }
  ok("words the model WROTE are checked before they are handed back", err?.status === 422 && err.message === REFUSAL && asked === 1);
  reply = "a quiet lighthouse at dusk";
  ok("a clean rewrite comes back as before", (await enh.enhance({ field: "style", text: "lighthouse" })).text === reply);
  const lyr = await enh.enhance({ field: "lyrics", text: "teenage kicks, sexy nights" }).catch((e) => e);
  ok("LYRICS are a song and are not read by the enhancer (a lyric line is judged where it becomes a picture)", lyr?.text === reply, lyr?.message);
  const out = [];
  const routes = createPromptToolRoutes({ json: (_r, status, body) => out.push({ status, body }), readBody: async (req) => req._body, gallery: {}, enhancer: enh });
  await routes({ method: "POST", _body: { field: "simple", text: PAIR } }, {}, new URL("http://x/api/enhance"));
  const r = out.pop();
  ok("POST /api/enhance: 422 with the sentence and the code", r?.status === 422 && r.body.error === REFUSAL && r.body.code === CODE, JSON.stringify(r));
}

/* ══ READ: THE ROUTES AND THE WIRING ═══════════════════════════════════ */
section("read: every door in server/index.js checks before it stages or queues, and answers 422");
/* The two-sided pin: the claim must hold on the real text AND fail on a copy
 * with its subject cut out. */
const both = (what, test, text, breakIt, how) => {
  ok(what, test(text));
  let broken;
  try { broken = breakIt(text); } catch { broken = text; }
  ok(`  └ negative: fails when ${how}`, broken !== text && !test(broken),
    broken === text ? "THE MUTATION CHANGED NOTHING" : "THE PIN PASSED ON A BROKEN TREE");
};
const INDEX = src("server/index.js");
const block = (text, open, close) => {
  const at = text.indexOf(open);
  if (at < 0) return "";
  const end = close ? text.indexOf(close, at + open.length) : -1;
  return text.slice(at, end > at ? end : at + 20000);
};
const before = (a, b) => (t) => { const i = t.indexOf(a), j = t.indexOf(b, Math.max(i, 0)); return i >= 0 && j > i; };
const refusesAt = (door) => new RegExp(`safetyRefusal\\(\\{[\\s\\S]{0,200}door: "${door.replace(/\./g, "\\.")}"[\\s\\S]{0,400}?if \\(refused\\) return json\\(res, 422, refused\\)`);
const cutCheck = (door) => (t) => t.replace(new RegExp(`safetyRefusal\\(\\{[\\s\\S]{0,200}door: "${door.replace(/\./g, "\\.")}"`), "noCheck({");
{
  const image = block(INDEX, 'if (p === "/api/image" && req.method === "POST")', 'if (p === "/api/');
  both("/api/image refuses with 422 at its own door", (t) => refusesAt("api.image").test(t), image, cutCheck("api.image"), "the check is cut");
  both("...before any reference picture is staged", (t) => before('door: "api.image"', "stageQwenReferences(")(t), image,
    (t) => t.replace('door: "api.image"', 'door: "api.imagx"'), "the check is moved/renamed");
  both("...and before art.request", (t) => before('door: "api.image"', "art.request(shot)")(t), image,
    (t) => t.replace("art.request(shot)", "art.enqueue(shot)"), "the queue call is renamed");
  both("...on the persona-folded words, with the references' stored prompts as context",
    (t) => /texts: \[applyPersona\(personaUsed, \{ prompt \}\)\.prompt\], context: imageLineage/.test(t), image,
    (t) => t.replace("context: imageLineage", "context: []"), "the lineage is dropped");
  both("...and carries that lineage to the engine door", (t) => /safetyContext: imageLineage/.test(t), image,
    (t) => t.replace("safetyContext: imageLineage", "safetyContext: []"), "the context is dropped");
  both("...and a queue refusal is a 422, not the generic 409", (t) => before("if (art.lastRefusalBody) return json(res, 422, art.lastRefusalBody)", "return json(res, 409")(t), image,
    (t) => t.replace("if (art.lastRefusalBody) return json(res, 422, art.lastRefusalBody);", ""), "the 422 branch is cut");

  const edit = block(INDEX, 'if (p === "/api/images/ai-edit" && req.method === "POST")', 'if (p === "/api/');
  both("/api/images/ai-edit refuses before the editor prepares anything", (t) => refusesAt("api.images.ai-edit").test(t) && before('door: "api.images.ai-edit"', "imageEditor.request(")(t),
    edit, cutCheck("api.images.ai-edit"), "the check is cut");
  both("...with the edited picture's (or document's) own history, words AND flags",
    (t) => /const editLineage = lineage\(\[b\?\.source,[\s\S]{0,160}documentSources\(b\.documentId\)/.test(t)
      && /context: editLineage\.texts, flags: editLineage\.flags/.test(t), edit,
    (t) => t.replace("lineage([b?.source", "lineage([b?.nothing"), "the source is dropped");

  const extend = block(INDEX, 'if (b.action === "extend") {', 'if (b.action === "create") {');
  both("/api/video extend refuses before the clip is staged", (t) => refusesAt("api.video.extend").test(t)
    && before('door: "api.video.extend"', "writeFile(path.join(config.inputDir, staged)")(t), extend, cutCheck("api.video.extend"), "the check is cut");
  both("...and a queue refusal is a 422", (t) => /if \(!job && art\.lastRefusalBody\) return json\(res, 422/.test(t), extend,
    (t) => t.replace(/if \(!job && art\.lastRefusalBody\) return json\(res, 422, art\.lastRefusalBody\);/, ""), "the branch is cut");

  const create = block(INDEX, 'if (b.action === "create") {\n        if (!config.video.enabled)', 'if (b.action === "engine") {');
  both("/api/video create refuses before any frame is staged", (t) => refusesAt("api.video.create").test(t)
    && before('door: "api.video.create"', "stageFrame(b.fromCover)")(t) && before('door: "api.video.create"', "art.request(")(t),
    create, cutCheck("api.video.create"), "the check is cut");
  both("...with every frame, reference and driving video's stored prompt as context",
    (t) => /b\.fromCover, b\.toCover,[\s\S]{0,200}b\.refImages[\s\S]{0,80}b\.sourceVideo/.test(t) && /safetyContext: clipLineage/.test(t), create,
    (t) => t.replace("safetyContext: clipLineage", "safetyContext: []"), "the context is dropped");

  const run = block(INDEX, 'if (b.action === "run") {\n        if (!config.video.enabled)', 'return json(res, 400, { error: "Unknown action." });');
  both("/api/video run (a clip from a CAPTION) answers the queue's refusal with 422", (t) => /if \(!queued && art\.lastRefusalBody\) return json\(res, 422/.test(t), run,
    (t) => t.replace(/if \(!queued && art\.lastRefusalBody\)[^\n]*\n/, ""), "the branch is cut");

  const restyle = block(INDEX, 'if (p === "/api/restyle" && req.method === "POST")', 'if (p === "/api/');
  both("/api/restyle refuses before it queues", (t) => refusesAt("api.restyle").test(t) && before('door: "api.restyle"', "art.request(")(t),
    restyle, cutCheck("api.restyle"), "the check is cut");

  const artRoute = block(INDEX, 'if (p === "/api/art" && req.method === "POST")', 'if (b.action === "enable")');
  both("/api/art regenerate (a cover from lyrics) answers the queue's refusal with 422",
    (t) => before("if (art.lastRefusalBody) return json(res, 422, art.lastRefusalBody)", "return json(res, 409")(t), artRoute,
    (t) => t.replace("if (art.lastRefusalBody) return json(res, 422, art.lastRefusalBody);", ""), "the branch is cut");

  const reactive = block(INDEX, 'if (p === "/api/reactive/run" && req.method === "POST")', "const loop = async");
  both("/api/reactive/run refuses its prompt before anything is analysed", (t) => refusesAt("api.reactive").test(t), reactive, cutCheck("api.reactive"), "the check is cut");

  const batchRoute = block(INDEX, 'if (p === "/api/batch" && req.method === "POST")', 'if (p === "/api/');
  both("/api/batch answers a plan refused at start with 422", (t) => /if \(err\?\.safety\) return json\(res, 422/.test(t), batchRoute,
    (t) => t.replace(/if \(err\?\.safety\) return json\(res, 422[^\n]*\n/, ""), "the branch is cut");

  both("every refusal announced outside the engine door is filed by ONE listener, into the library ledger",
    (t) => /onRefusal\(\(evt\) => provNote\("library", evt\)\)/.test(t), INDEX,
    (t) => t.replace('onRefusal((evt) => provNote("library", evt));', ""), "the listener is cut");
  both("the backstop's check door is mounted", (t) => /if \(p === "\/api\/safety\/check"\) \{\s*if \(await safetyRoutes\(req, res, url\)\) return;/.test(t), INDEX,
    (t) => t.replace('if (p === "/api/safety/check") {', 'if (p === "/api/safety/nope") {'), "the mount is renamed");
}

section("read: the engine door checks first, and nothing can switch it off");
{
  const code = src("server/engine/client.js").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const dispatch = code.slice(code.indexOf("async function dispatch("));
  const at = dispatch.indexOf("checkGraph(graph");
  const order = ["buildRecord(graph", "if (spec.dryRun)", "store.putGraph(", 'type: "delegate"', "/prompt"].map((n) => dispatch.indexOf(n));
  ok("dispatch() checks the graph BEFORE the record, the dry run, the graph store, the delegate and the POST",
    at > 0 && order.every((i) => i > at), JSON.stringify({ at, order }));
  ok("...right after the structural problems, so nothing else runs first",
    at > dispatch.indexOf("graphProblems(graph)") && dispatch.slice(dispatch.indexOf("graphProblems(graph)"), at).split("\n").length < 12);
  ok("...with the ORIGINAL graph and only an additive context, and no deps anywhere near it",
    /checkGraph\(graph, \{ context: spec\.safetyContext, flags: spec\.safetyFlags \}\)/.test(dispatch) && !/deps\./.test(dispatch.slice(at - 200, at + 400)));
  const art = src("server/art.js");
  ok("the art queue checks before a job is pushed", before("checkPrompt([words]", "this.queue.push(job)")(art));
  ok("...and each visual render carries the job's safetyContext to the door",
    (art.match(/safetyContext: job\.safetyContext/g) || []).length === 3);
  const gen = src("server/mv/generate.js");
  ok("MV sheets, board keyframes and clips each hand the cast's words to the queue",
    (gen.match(/safetyContext: castContext\(/g) || []).length === 2 && /safetyContext: \[\s*\.\.\.castContext\(doc, board \? boardCast\(board\)/.test(gen));
  ok("MV's wait asks the queue for a refusal before it starts waiting", /art\.refusalFor\(file\)/.test(gen));
  const control = src("server/mv/control.js");
  ok("MV control renders (which skip the queue) refuse before anything is staged or run",
    before('assertSafe({ door: "mv.control"', "stageIn(")(control) && before('assertSafe({ door: "mv.control"', "engine.run(")(control)
    && /via: "mv\.control", clientId: "aiplay-mv-control", safetyContext,/.test(control));
  ok("the MV routes answer a refusal with 422", /if \(err\?\.safety\) return json\(res, 422/.test(src("server/mv/routes.js")));
  ok("the engine's HTTP door answers a refusal with 422", /if \(err\?\.safety\) \{\s*json\(res, 422/.test(src("server/engine/routes.js")));
  ok("the engine is spawned with the backstop's address and token",
    /env: \{ \.\.\.pythonEnv\(config\.python\), \.\.\.backstopEnv\(config\.uiPort\) \}/.test(src("server/comfy.js")));
  const gate = src("server/comfy_nodes/aiplay_safety_gate.py");
  ok("the backstop node ships with the Studio's nodes and registers an on_prompt handler",
    /PromptServer\.instance\.add_on_prompt_handler\(gate\)/.test(gate) && /OUTPUT_NODE = True/.test(gate));
  ok("...and carries the SAME sentence", gate.includes(`REFUSAL = "${REFUSAL}"`));
  ok("MCP agents hear a 422 as an error with its sentence (mcp.js api() rejects on >= 400)",
    /if \(res\.statusCode >= 400\) \{\s*reject\(new Error\(parsed\?\.error/.test(src("server/mcp.js")));
}

section("read: the review's wiring (2026-09-24), each pin two-sided");
{
  both("the picture and clip maps are LineageMaps: every row written is fingerprinted from its words and its parents",
    (t) => /const imageMeta = new LineageMap\(libraryRows\);/.test(t) && /const clipMeta = new LineageMap\(libraryRows\);/.test(t), INDEX,
    (t) => t.replace("const clipMeta = new LineageMap(libraryRows);", "const clipMeta = new Map();"), "the clip map is plain again");
  both("...and rows read back from disk go in with load(), as they were saved",
    (t) => /imageMeta\.load\(k, v\)/.test(t) && /clipMeta\.load\(k, v\)/.test(t), INDEX,
    (t) => t.replace("imageMeta.load(k, v)", "imageMeta.set(k, v)"), "a load becomes a set");
  const artSrc = src("server/art.js");
  both("an engine-door refusal blanks the job's title, prompt and context BEFORE it is listed in recent[], logged or put in lastError",
    (t) => /if \(err\?\.safety\) \{\s*job\.title = null;\s*job\.prompt = null;[\s\S]{0,160}job\.safetyContext = null;\s*\}\s*if \(!this\.done\.includes\(job\)\) this\.done\.unshift\(job\);\s*this\.lastError = err\?\.safety \? String\(err\.message \|\| err\) :/.test(t),
    artSrc, (t) => t.replace("job.title = null;\n", ""), "the title is kept");
  both("the picture a job makes carries its fingerprint onto its row (imageOptions is spread onto it), private or not",
    (t) => /imageOptions: job\._imageOptions \|\| job\.safety\s*\? \{ \.\.\.\(job\._imageOptions \|\| \{\}\), \.\.\.\(job\.safety \? \{ safety: job\.safety \} : \{\}\) \}/.test(t),
    artSrc, (t) => t.replace("...(job.safety ? { safety: job.safety } : {})", ""), "the fingerprint is dropped");
  const openAt = block(INDEX, 'if (action === "open") {', "return json(res, 200, {\n            ok: true, file,");
  both("a friend's order or shot this Studio would refuse is refused when OPENED, before its prompt is put on a card",
    (t) => /door: "collab\.open"[\s\S]{0,200}if \(refusedIn\) return json\(res, 422/.test(t), openAt,
    (t) => t.replace('door: "collab.open"', 'door: "collab.opened"'), "the check is renamed away");
  both("an order is sealed with the cast's own words as context", (t) => /safetyContext: mvRowWords\(docO, \(shotO\.refs \|\| \[\]\)\.map/.test(t), INDEX,
    (t) => t.replace("safetyContext: mvRowWords(docO", "safetyContext: ([]).concat(docO"), "the context is dropped");
  both("a shot sent for somebody else to render is checked before it is sealed",
    (t) => before('door: "collab.shot"', "const wrote = await sealFor(packet")(t), INDEX,
    (t) => t.replace('door: "collab.shot"', 'door: "collab.shoot"'), "the check is renamed away");
  both("Reactive Paint is judged with its source clip's and style pictures' history before a frame is painted",
    (t) => /door: "reactive\.paint"[\s\S]{0,200}context: lin\.texts, flags: lin\.flags[\s\S]{0,80}return paintClip\(/.test(t), INDEX,
    (t) => t.replace('door: "reactive.paint"', 'door: "reactive.painted"'), "the check is renamed away");
  both("...and the Motion look hands that history to the engine door",
    (t) => /motionClip\(\{ \.\.\.mo, clipDir: CLIP_DIR, imageDir: IMAGE_DIR, safetyContext: lin\.texts, safetyFlags: lin\.flags \}/.test(t), INDEX,
    (t) => t.replace("safetyFlags: lin.flags }", "}"), "the flags are dropped");
  ok("reactive_motion.js passes it on to engine.run", /via: "reactive\.motion"[\s\S]{0,300}safetyContext: o\.safetyContext, safetyFlags: o\.safetyFlags/.test(src("server/reactive_motion.js")));
  ok("an MV control render's driving clip is judged with its own history",
    /lineage: deps\.lineage/.test(src("server/mv/routes.js")) && /deps\.lineage\(\[name\]\)/.test(src("server/mv/control.js"))
    && /engine\.run\(\{\s*graph, actor, via: "mv\.control", clientId: "aiplay-mv-control", safetyContext, safetyFlags,/.test(src("server/mv/control.js")));
  ok("MV sheets, board keyframes and clips hand their adopted takes' flags to the queue",
    (src("server/mv/generate.js").match(/safetyFlags: /g) || []).length >= 3);
  ok("the compositor's stills and clips name the library files they were made from", (src("server/vfx/routes.js").match(/layerSources: layerSourcesOf\(doc\)/g) || []).length === 2);
  ok("the song editor's Regenerate cover reads the answer instead of claiming it was queued",
    /* Either the plain failSay or the release's own dialog (appAlert, with the
     * model window on a 409): what matters is that it returns before "Queued". */
    /\$\("edRegen"\)\.onclick[\s\S]{0,1400}if \(r\??\.error\) \{[^\n]*(?:failSay\(r\)|appAlert\(r\.error)[^\n]*return; \}[\s\S]{0,40}\$\("edArt"\)\.title = "Queued/.test(src("web/app.js")));

  const { keepSafetyGate, SAFETY_GATE_MODULE, STUDIO_OWNED } = await import("../comfyargs.js");
  const cli = 'parser.add_argument("--disable-all-custom-nodes")\nparser.add_argument("--whitelist-custom-nodes", nargs="+")';
  ok("NO SETTING TURNS THE BACKSTOP OFF: \"Don't load custom node packs\" still loads the safety node by name",
    JSON.stringify(keepSafetyGate(["--lowvram", "--disable-all-custom-nodes"], cli))
      === JSON.stringify(["--lowvram", "--disable-all-custom-nodes", "--whitelist-custom-nodes", SAFETY_GATE_MODULE]));
  ok("...joining a whitelist the install already had",
    JSON.stringify(keepSafetyGate(["--disable-all-custom-nodes", "--whitelist-custom-nodes", "mine", "--lowvram"], cli))
      === JSON.stringify(["--disable-all-custom-nodes", "--whitelist-custom-nodes", "mine", SAFETY_GATE_MODULE, "--lowvram"]));
  ok("...and an install too old to know --whitelist-custom-nodes gets its custom nodes back",
    JSON.stringify(keepSafetyGate(["--disable-all-custom-nodes", "--lowvram"], 'parser.add_argument("--disable-all-custom-nodes")')) === JSON.stringify(["--lowvram"]));
  ok("...a launch without the flag is untouched", JSON.stringify(keepSafetyGate(["--lowvram"], cli)) === JSON.stringify(["--lowvram"]));
  ok("the whitelist flag is the Studio's alone", STUDIO_OWNED.has("--whitelist-custom-nodes"));
  ok("the engine is launched through it", /return keepSafetyGate\(buildLaunchArgs\(\{/.test(src("server/comfy.js")));
  const gatePy = src("server/comfy_nodes/aiplay_safety_gate.py");
  ok("the backstop node says whether it is armed, and the Studio asks before it reveals the port",
    /@PromptServer\.instance\.routes\.get\(STATUS_PATH\)/.test(gatePy) && /STATUS_PATH = "\/aiplay\/safety_status"/.test(gatePy)
    && /BACKSTOP_STATUS_PATH = "\/aiplay\/safety_status"/.test(src("server/engine/client.js")));
}

section("read: the ledger event, and where the rule is written down");
{
  const evt = refusalEvent({ door: "api.image", via: "x", actor: "agent:t" });
  ok("the event is type refused on safety/refusals, private, carrying code/door/via only",
    evt.type === "refused" && evt.asset === "safety/refusals" && evt.private === true
    && JSON.stringify(Object.keys(evt.data).sort()) === JSON.stringify(["code", "door", "via"]));
  ok("\"refused\" is a legal ledger event type", provenance.EVENT_TYPES.has("refused"));
  const hook = src(".githooks/pre-commit");
  ok("the gate runs both suites", hook.includes("node server/safety/minors_test.js") && hook.includes("node server/safety/doors_test.js"));
  const doc = src("docs/SAFETY.md");
  ok("docs/SAFETY.md states the rule and the sentence", doc.includes(REFUSAL) && /no override/i.test(doc));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
process.exit(0);
