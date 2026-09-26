/**
 * REFERENCE PICTURES ON AN ENGINE THAT IGNORES THEM (UI_PLAN E4).
 *
 * FastH3 was distilled without references and LTX has no reference input. The
 * Video screen used to hide the reference slots on those engines and send the
 * render WITHOUT the attached pictures, and a <Picture 1> in the description
 * went to the engine as plain words. Now:
 *
 *   - the server says it, in ONE sentence (server/video-plain.js refsIgnored,
 *     sent per engine on /api/status);
 *   - the reference slots stay in view while anything is attached and show that
 *     sentence (web/vidfit.js #vidRefIgnored);
 *   - a clip with references on those engines is REFUSED in that sentence, by
 *     the door and by make_clip, never rendered without them;
 *   - a tag nothing answers is taken out of the description and said, never
 *     sent as plain words.
 *
 * No server, no engine: the plan runs for real, the page module against a stub
 * DOM, make_clip against a mocked door.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { config } = await import("./config.js");
const { refsIgnored, videoPlan, refTagsIn } = await import("./video-plain.js");
const E = config.video.engines;

test("the server's sentence: FastH3 and LTX ignore references, H3 takes them", () => {
  const fast = refsIgnored("fasth3", E.fasth3.label), ltx = refsIgnored("ltx", E.ltx.label);
  assert.match(fast, /^FastH3 ignores reference pictures and sounds \(it was distilled without them\), so a clip with any attached is refused rather than rendered without them\./);
  assert.match(ltx, /^LTX 2\.5 ignores reference pictures and sounds \(the model has no reference input, a model limit and not a setting\)/);
  for (const s of [fast, ltx]) assert.match(s, /Switch the engine to MiniMax H3 to use them, or remove them to render from the words alone\.$/);
  /* The substitute is LTX's alone: the lab ran FastH3 on text only, so its
   * sentence does not send anyone to an untried frame. */
  assert.match(ltx, /On LTX 2\.5, a picture can open or close the clip as a frame instead\./);
  assert.doesNotMatch(fast, /as a frame instead/);
  assert.equal(refsIgnored("h3", E.h3.label), null);
  assert.match(read("./index.js"), /refsIgnored: refsIgnored\(k, e\.label\),/, "/api/status sends it per engine");
});

test("the plan refuses references on FastH3 and LTX, in that sentence, and takes them on H3", () => {
  for (const key of ["fasth3", "ltx"]) {
    for (const body of [{ refImages: ["a.png"] }, { refAudios: [{ name: "s.flac" }] }]) {
      const p = videoPlan({ prompt: "<Picture 1> walks", ...body }, { engineKey: key, eng: E[key] });
      assert.equal(p.refusal?.reason, "refs-ignored", `${key} ${Object.keys(body)[0]}`);
      assert.equal(p.refusal.error, refsIgnored(key, E[key].label), "the same words the reference slots show");
    }
  }
  const h3 = videoPlan({ prompt: "<Picture 1> walks", refImages: ["a.png"] }, { engineKey: "h3", eng: E.h3 });
  assert.equal(h3.refusal, null);
  assert.equal(h3.prompt, "<Picture 1> walks", "a tag an attached picture answers stays");
  const index = read("./index.js");
  assert.match(index, /const plan = videoPlan\(\{ \.\.\.b, refImages, refAudios \}, \{ engineKey: eng, eng: videoEngine\(eng\),/,
    "the door plans on the references that really staged");
  assert.match(index, /if \(plan\.refusal\) return json\(res, 400, \{ error: plan\.refusal\.error, reason: plan\.refusal\.reason,\s*\.\.\.\(plan\.refusal\.needsModel \? \{ needsModel: plan\.refusal\.needsModel \} : \{\}\) \}\);/);
  assert.doesNotMatch(index, /References need MiniMax H3/, "no second, hand-kept copy of the sentence");
});

test("a tag nothing answers is taken out of the words, and said", () => {
  const ltx = videoPlan({ prompt: "the dancer from <Picture 1> spins, <Audio 1> plays" }, { engineKey: "ltx", eng: E.ltx });
  assert.equal(ltx.refusal, null, "no references attached: nothing to refuse, the Video Lab's LTX arm still renders");
  assert.equal(ltx.prompt, "the dancer from spins, plays");
  assert.deepEqual(refTagsIn(ltx.prompt), []);
  assert.equal(ltx.warnings.find((w) => w.id === "tags").text,
    "<Picture 1>, <Audio 1> were taken out of the description: LTX 2.5 takes no reference pictures or sounds, so the tag would have reached it as plain words.");
  const h3 = videoPlan({ prompt: "<Picture 1> meets <Picture 2>", refImages: ["a.png"] }, { engineKey: "h3", eng: E.h3 });
  assert.equal(h3.prompt, "<Picture 1> meets");
  assert.match(h3.warnings.find((w) => w.id === "tags").text, /^<Picture 2> was taken out of the description: no such reference is attached/);
  const only = videoPlan({ prompt: "<Picture 1>" }, { engineKey: "fasth3", eng: E.fasth3 });
  assert.equal(only.refusal?.reason, "empty", "a description of nothing but tags is not rendered as an empty prompt");
  /* The Video Lab's comparison posts through the same door: what the door
   * changed (a tag taken out, the reference build's steps) lands on the arm's
   * note instead of vanishing. */
  const routes = read("./videolab/routes.js");
  assert.match(routes, /const said = \(Array\.isArray\(r\.warnings\) \? r\.warnings : \[\]\)\.map\(\(w\) => w\?\.text\)\.filter\(Boolean\);\n\s+if \(said\.length\) arm\.note = \[arm\.note, \.\.\.said\]\.filter\(Boolean\)\.join\(" "\);/);
});

test("the page: the reference slots stay in view while anything is attached, and show the server's sentence", async () => {
  const els = new Map();
  const el = (id) => { const e = { id, hidden: true, textContent: "", options: [], value: "", addEventListener() {}, dispatchEvent() { return true; } }; els.set(id, e); return e; };
  el("vidEngine");
  el("vidRefIgnored");
  el("vidPanel").hidden = true;          // no check requests from this lane
  const attached = [];
  Object.assign(globalThis, {
    document: {
      readyState: "complete",
      getElementById: (id) => els.get(id) || null,
      addEventListener() {},
      querySelectorAll: (sel) => (sel.includes("#vidRefImgPrev") ? attached : []),
    },
    MutationObserver: class { observe() {} },
    localStorage: { getItem: () => null },
    fetch: async () => ({ json: async () => ({}) }),
  });
  await import("../web/vidfit.js");
  const paint = globalThis.aiplayVidFit;
  const engines = Object.fromEntries(Object.entries(E).map(([k, e]) => [k, { label: e.label, loraBase: e.loraBase ?? null,
    refsIgnored: refsIgnored(k, e.label) }]));
  const show = (engine) => { els.get("vidEngine").value = engine; paint({ config: { video: { engine, engines } }, art: {} }); return els.get("vidRefIgnored"); };
  attached.push({ dataset: { refname: "aiplay_frame_000000000001.png" } });
  for (const key of ["fasth3", "ltx"]) {
    const line = show(key);
    assert.equal(line.hidden, false, `${key}: said`);
    assert.equal(line.textContent, refsIgnored(key, E[key].label), `${key}: the server's words, as sent`);
  }
  assert.equal(show("h3").hidden, true, "H3 takes them: nothing to say");
  attached.length = 0;
  assert.equal(show("fasth3").hidden, true, "nothing attached: nothing to say");

  const html = read("../web/index.html"), app = read("../web/app.js");
  const wrap = html.slice(html.indexOf('<div class="field" id="vidRefWrap"'), html.indexOf('id="vidSndWrap"'));
  assert.match(wrap, /<p class="hint warnhint" id="vidRefIgnored" hidden><\/p>/, "the sentence sits in the reference slots");
  /* The slots' visibility, lifted from vidPaint and run. */
  const line = /\n\s+\$\("vidRefWrap"\)\.hidden = [^\n]+;/.exec(app)?.[0] || "";
  const hiddenFor = (cur, n) => { const box = {}; new Function("$", "state", "cur", line)(() => box, { refImages: Array(n).fill({}), refAudios: [] }, cur); return box.hidden; };
  assert.equal(hiddenFor("fasth3", 0), true, "FastH3, nothing attached: the slots fold away as before");
  assert.equal(hiddenFor("fasth3", 1), false, "FastH3 with a picture attached: the slots stay, with the sentence");
  assert.equal(hiddenFor("ltx", 2), false);
  assert.equal(hiddenFor("h3", 0), false);
  /* ...and Render sends what is attached, so the server can refuse it by name. */
  assert.match(app, /refImages: \(state\.refImages \|\| \[\]\)\.length \? state\.refImages\.map\(\(m\) => m\.name\) : undefined,/);
  assert.doesNotMatch(app, /refImages: state\.video\?\.engine === "h3"/, "no engine gate on the page that drops them unsaid");
});

test("make_clip: the same sentence, from the status or from the door, and the door's warnings in its reply", async () => {
  const { TOOLS } = await import("./mcp.js");
  const { videoLoraInput } = await import("./video-lora-validation.js");
  const { emptyResultNote } = await import("./art-wait.js");
  const t = TOOLS.find((x) => x.name === "make_clip");
  const run = (api) => new Function("api", "safeName", "waitForArt", "videoLoraInput", "emptyResultNote",
    `return (${String(t.run).replace(/^async run\(/, "async function(")});`)(api, (v) => v, async () => {}, videoLoraInput, emptyResultNote);
  const mock = ({ engine, sentence, door = {} }) => {
    const posts = [];
    const api = async (method, p, body) => {
      if (method === "POST") posts.push(body);
      if (p === "/api/status") return { config: { video: { enabled: true, ready: true, engine,
        engines: { [engine]: { label: E[engine].label, ...(sentence ? { refsIgnored: sentence } : {}) } } } } };
      if (p === "/api/clips") return { clips: [] };
      return door;
    };
    return { api, posts };
  };
  for (const key of ["fasth3", "ltx"]) {
    const said = refsIgnored(key, E[key].label);
    const a = mock({ engine: key, sentence: said });
    await assert.rejects(run(a.api)({ prompt: "<Picture 1> walks", ref_images: ["a.png"] }), (e) => e.message.startsWith(said),
      `${key}: make_clip says the reference slots' sentence`);
    assert.equal(a.posts.length, 0, "and nothing was rendered");
    /* A status without the sentence (an older Studio): the door refuses, in its own words, and they reach the agent. */
    const b = mock({ engine: key, door: { error: said, reason: "refs-ignored" } });
    await assert.rejects(run(b.api)({ prompt: "<Picture 1> walks", ref_images: ["a.png"] }), (e) => e.message === said);
    assert.deepEqual(b.posts.at(-1).refImages, ["a.png"], "the pictures went to the door, which refused them");
  }
  /* On FastH3 the tool's own way out is H3, never an untried frame. */
  const f = mock({ engine: "fasth3", sentence: refsIgnored("fasth3", E.fasth3.label) });
  await assert.rejects(run(f.api)({ prompt: "<Picture 1> walks", ref_images: ["a.png"] }),
    (e) => /is selected: pass engine:"h3"\.$/.test(e.message) && !/first_frame/.test(e.message));
  /* On H3 the render goes, and what the door changed comes back as warnings. */
  const h = mock({ engine: "h3", door: { job: { id: "v1" }, warnings: [{ id: "steps", text: "With references this runs 4 steps, not 3." }] } });
  const r = await run(h.api)({ prompt: "<Picture 1> walks", ref_images: ["a.png"], quality: "fast" });
  assert.deepEqual(r.warnings, ["With references this runs 4 steps, not 3."]);
});
