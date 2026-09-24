/** The Images and Video panels' Simple mode: generic form tools over the
 *  page's own controls, served at /api/chat/image and /api/chat/video. No
 *  model, no GPU: a fake model answers and the stream is read back. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFileSync } from "node:fs";
import { mkdtemp as mkdtempP } from "node:fs/promises";
import { createFormTools, describeScreen, parseChanges, checkValue, formIntro, applyScreenPatch } from "./form-tools.js";
import { createChatRoutes } from "./routes.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SCREEN = {
  promptField: "imgPrompt",
  fields: [
    { id: "imgPrompt", label: "What should it show", type: "text", value: "" },
    { id: "imgEngine", label: "engine", type: "select", value: "flux2", options: [
      { v: "flux2", t: "FLUX.2 klein — fast" }, { v: "zimage", t: "Z-Image Turbo" },
      { v: "anima", t: "Anima — anime", off: true, why: "not installed" }] },
    { id: "imgSteps", label: "steps", type: "range", value: "4", min: 1, max: 50 },
    { id: "imgCkpt", label: "model file", type: "select", value: "", hidden: true, options: [{ v: "a.safetensors", t: "a" }] },
    { id: "vidLoop", label: "Seamless loop", type: "checkbox", value: false },
  ],
  button: { ready: true },
  renders: { running: "", queued: 0, recent: ['"cat" (image, flux2): FAILED — out of memory'] },
};

test("set_form: the description and any field by id, checked against the screen", async () => {
  const t = createFormTools("image");
  t.setScreen(structuredClone(SCREEN));
  const r = await t.get("set_form").run({ prompt: "a fox", changes: "imgEngine = Z-Image Turbo\nsteps = 80\nvidLoop = yes" });
  assert.deepEqual(r.form.fields, { imgPrompt: "a fox", imgEngine: "zimage", imgSteps: 50, vidLoop: true });
  await assert.rejects(t.get("set_form").run({ changes: "imgEngine = anima" }), /UNAVAILABLE here \(not installed\)/);
  await assert.rejects(t.get("set_form").run({ changes: "imgEngine = sdxl" }), /no choice "sdxl"\. Its choices: flux2=/);
  await assert.rejects(t.get("set_form").run({ changes: "nope = 1" }), /no field "nope"/);
  assert.equal((await t.get("set_form").run({ changes: "imgCkpt = a.safetensors" })).form.fields.imgCkpt, "a.safetensors", "a hidden field can be set");
  assert.deepEqual(parseChanges("a = 1; b: two"), [["a", "1"], ["b", "two"]]);
  assert.equal(checkValue({ id: "x", type: "number", min: 0, max: 10 }, "12s"), 10);
  const g = t.get("generate");
  assert.ok(g.spends && g.endsTurn);
});

test("the screen names every field, the unavailable choices and failed renders", () => {
  const d = describeScreen(SCREEN);
  assert.match(d, /imgEngine · engine · now flux2 · choices: flux2=FLUX\.2 klein — fast; zimage=Z-Image Turbo; anima=Anima — anime UNAVAILABLE \(not installed\)/);
  assert.match(d, /imgCkpt · model file \(hidden\)/);
  assert.match(d, /FAILED — out of memory/);
  assert.match(formIntro("video").join("\n"), /ONE subject, ONE clear action and ONE camera move/);
  const f = applyScreenPatch(structuredClone(SCREEN), { fields: { imgEngine: "zimage" } });
  assert.equal(f.fields[1].value, "zimage", "the rest of the turn sees the change");
});

test("/api/chat/image runs the panel's tools on its own snapshot, and generate goes with a warning", async () => {
  const dir = await mkdtempP(path.join(os.tmpdir(), "aiplay-formtools-"));
  const answers = ['{"tool":"set_form","args":{"prompt":"a fox asleep","changes":"imgEngine = zimage"}}', '{"tool":"generate","args":{}}'];
  const prompts = [];
  const model = async (p) => { prompts.push(p); return answers.shift() ?? '{"say":"ok"}'; };
  model.usesCard = async () => false;
  const engine = { status: async () => ({ ready: true, queue: { running: 0, pending: 0 }, running: [] }) };
  const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { "Content-Type": "application/json" }); res.end(s); };
  const readBody = async (req) => { const b = []; for await (const x of req) b.push(x); return b.length ? JSON.parse(Buffer.concat(b).toString()) : {}; };
  const handle = createChatRoutes({ json, readBody, config: { uiPort: 1, paths: { appData: dir } }, engine, model, dir,
    chatModels: { resolve: async () => null, status: async () => ({ models: [] }) }, musicChatModels: { resolve: async () => null, status: async () => ({ models: [] }) } });
  const server = http.createServer(async (req, res) => { if (!(await handle(req, res, new URL(req.url, "http://x")))) json(res, 404, {}); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/image`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:form-tools-test" },
      body: JSON.stringify({ message: "a fox asleep on books, make it", form: SCREEN }),
    });
    const ev = (await r.text()).split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
    const set = ev.find((e) => e.type === "tool_result" && e.tool === "set_form");
    assert.deepEqual(set?.result?.form?.fields, { imgPrompt: "a fox asleep", imgEngine: "zimage" });
    assert.ok(ev.some((e) => e.type === "gpu" && e.tool === "generate"), "the warning, no ask-first card");
    assert.ok(ev.some((e) => e.type === "tool_result" && e.result?.action === "generate"));
    assert.match(prompts[0], /image assistant inside the Images panel/);
    assert.match(prompts[1], /imgEngine · engine · now zimage/, "the next step sees what set_form did");
  } finally { server.close(); }
});

test("the page: Simple/Advanced on Images and Video, Advanced by default; Video has the Images look", () => {
  const js = src("../../web/assist.js"), css = src("../../web/styles.css"), html = src("../../web/index.html");
  assert.match(html, /<script type="module" src="assist\.js"><\/script>/);
  assert.match(js, /setMode\(false\);/, "every start opens on Advanced");
  assert.doesNotMatch(js, /localStorage\.getItem\(store\)/, "no remembered Simple across starts");
  assert.match(js, /fetch\(`\/api\/chat\/\$\{kind\}`/);
  assert.match(js, /mount\("image"\); mount\("video"\);/);
  assert.match(js, /engine: "imgEngine", engineLabel: "Image model"/, "Simple has the model picker");
  assert.match(js, /engine: "vidEngine", engineLabel: "Video model"/);
  assert.match(js, /ownModel\(P, box\);/);
  assert.match(js, /box\.querySelector\("\.aswriter select"\)/, "the writing model is its own dropdown");
  // Your own model file: the file list takes the writing model's place, with an arrow; then its name shows.
  assert.match(js, /own: \{ value: "checkpoint", pick: "imgCkpt", label: "Model file" \}/);
  assert.match(js, /wrap\.hidden = !show; arrow\.hidden = !show; writer\.hidden = show;/);
  assert.match(js, /o\.textContent = own && file\.value && !picking \? name\(\) : o\.dataset\.orig;/);
  assert.match(js, /"Choose another model file…"/);
  assert.match(js, /<div class="ptools" data-gallery="\$\{kind\}" data-target="\$\{kind\}AsText" data-label="ideas"><\/div>/, "saved ideas on Images and Video");
  // Every Simple bar: New, saved ideas and Send on their own row at the right; the dropdowns below, full width.
  assert.match(css, /\.create \.simple-bar::before, \.assist \.simple-bar::before \{ content: ""; order: 5; flex: 0 0 100%; height: 0; \}/);
  assert.match(css, /\.create \.simple-bar \.simple-new, \.assist \.simple-bar \.simple-new \{ order: 1; margin-left: auto; \}/);
  assert.match(css, /\.aswriter \{ flex: 0 0 calc\(50% - 3px\); min-width: 0; width: auto; \}/, "the two dropdowns side by side, 50/50");
  assert.match(html, /<section class="ovcol" id="imgPanel" hidden>\s*<div class="vidform">/, "the Images form is the page's left column, like Video's");
  assert.match(css, /:is\(#imgPanel \.vidform, #vidPanel\) textarea/, "the Images rules cover Video");
  assert.match(css, /\.assist-on > :not\(\.stagehead\)/, "Simple hides the Advanced form");
  assert.match(src("./routes.js"), /\["image", "video"\]\.map\(\(s\) => \[`\/api\/chat\/\$\{s\}`/);
});

test("the assistant is handed the prompting rules of the model on the screen", async () => {
  const { guideLines, checkpointGuide, IMAGE_GUIDES, VIDEO_GUIDES } = await import("./model-guides.js");
  const img = (eng, ckpt = "") => guideLines("image", [{ id: "imgEngine", value: eng }, { id: "imgCkpt", value: ckpt }]).join("\n");
  for (const k of ["flux2", "zimage", "zimage-base", "anima", "krea2", "ideogram4"]) assert.ok(img(k).startsWith(`HOW TO PROMPT ${IMAGE_GUIDES[k].name}:`), k);
  assert.match(img("zimage-base"), /negative prompt WORKS/);
  assert.match(img("ideogram4"), /NON-COMMERCIAL/);
  assert.match(img("checkpoint", "ponyDiffusionV6XL.safetensors"), /ponyDiffusionV6XL\.safetensors \(looks like a Pony model\)[\s\S]*score_9/);
  assert.match(checkpointGuide("waiIllustriousSDXL_v150.safetensors").name, /Illustrious/);
  assert.match(checkpointGuide("realisticVisionV60_v51.safetensors").name, /family unknown/);
  assert.match(img("checkpoint"), /none chosen yet/);
  const vid = (eng) => guideLines("video", [{ id: "vidEngine", value: eng }]).join("\n");
  assert.match(vid("h3"), /HOW TO PROMPT MiniMax H3:[\s\S]*<Picture 1>/);
  /* Keeping a person and making them sing (the REWIND A/B, 2026-09-24): the
   * guide and the Video assistant's own craft both say it. */
  assert.match(vid("h3"), /To keep a person the same across clips: 1–3 tight pictures of them/);
  assert.match(vid("h3"), /To make them sing in time: the song under the clip/);
  assert.match(formIntro("video").join("\n"), /KEEPING A PERSON\. If the clip shows someone who must look the same as in other clips, set vidCharacter to/);
  assert.match(formIntro("video").join("\n"), /never claim it is kept without\npictures\./);
  assert.doesNotMatch(formIntro("image").join("\n"), /KEEPING A PERSON/, "the Pictures assistant has its own character picker");
  assert.match(vid("ltx"), /HOW TO PROMPT LTX 2\.5:[\s\S]*about 200 words/);
  assert.match(vid("ltx"), /Always:[\s\S]*Say what IS in the frame/, "the repo's measured rules for every model");
  assert.ok(VIDEO_GUIDES.h3 && VIDEO_GUIDES.ltx);
  // On the screen, and it follows a switch made in the same turn.
  const f = { fields: [{ id: "imgEngine", type: "select", value: "flux2", options: [] }] };
  assert.match(describeScreen(f, "image"), /HOW TO PROMPT FLUX\.2 klein/);
  applyScreenPatch(f, { fields: { imgEngine: "anima" } });
  assert.match(describeScreen(f, "image"), /HOW TO PROMPT Anima/);
  assert.match(formIntro("image").join("\n"), /HOW TO PROMPT on the screen is written for the model chosen right now/);
  assert.match(src("./routes.js"), /describeScreen\(form, scope\)/);
});
