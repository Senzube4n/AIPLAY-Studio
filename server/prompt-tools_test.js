/** Saved galleries and the Enhance button (server/prompt-tools.js), the page's
 *  toolbars (web/prompt-tools.js) and their MCP tools. No model, no GPU. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-prompt-tools-test-"));
process.env.AIPLAY_APPDATA = path.join(root, "appdata");
after(() => rm(root, { recursive: true, force: true }));
const {
  GALLERY_KINDS, addToGallery, createGallery, enhancePrompt, cleanEnhanced, createEnhancer, createPromptToolRoutes,
} = await import("./prompt-tools.js");
const { TOOLS } = await import("./mcp.js");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const page = readFileSync(new URL("../web/prompt-tools.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");

test("a gallery keeps the newest first and moves a repeat to the top", () => {
  let g = addToGallery([], "dark synthwave", { id: "a", now: 1 });
  g = addToGallery(g, "indie folk", { id: "b", now: 2 });
  g = addToGallery(g, "dark synthwave", { id: "c", now: 3, name: "  Night drive  " });
  assert.deepEqual(g.map((x) => x.text), ["dark synthwave", "indie folk"]);
  assert.equal(g[0].name, "Night drive");
  assert.throws(() => addToGallery(g, "   "), /empty/);
  assert.throws(() => addToGallery(g, "x".repeat(8001)), /Too long/);
});

test("the gallery file is shared, per kind, and survives a reload", async () => {
  const file = path.join(root, "gallery.json");
  const g = createGallery({ file });
  assert.deepEqual(GALLERY_KINDS, ["styles", "lyrics", "simple", "chat", "image", "video"]);
  const [a, b] = await Promise.all([g.save("styles", "one"), g.save("lyrics", "[Verse]\nla")]);
  assert.equal(a.text, "one"); assert.equal(b.text, "[Verse]\nla");
  const again = createGallery({ file });
  assert.equal((await again.list("styles"))[0].text, "one");
  assert.equal((await again.list("chat")).length, 0);
  await again.remove("styles", (await again.list("styles"))[0].id);
  assert.equal(JSON.parse(await readFile(file, "utf8")).styles.length, 0);
  await assert.rejects(g.list("nope"), /Unknown gallery/);
  await assert.rejects(again.remove("styles", "missing"), /not in the gallery/);
});

test("each field gets its own instructions and the song's other half as context", () => {
  const s = enhancePrompt("style", "indie pop", { lyrics: "[Verse]\ncity lights", engine: "yue2-gguf:q8_0" });
  assert.match(s, /ONE line of comma-separated/); assert.match(s, /YuE2/); assert.match(s, /city lights/);
  assert.match(enhancePrompt("style", "pop", { engine: "minimax-music3" }), /MiniMax/);
  const l = enhancePrompt("lyrics", "", { style: "sad country" });
  assert.match(l, /\[Verse\]/); assert.match(l, /sad country/); assert.match(l, /\(empty\)/);
  assert.match(enhancePrompt("simple", "a song about rain"), /two to four sentences/);
  assert.throws(() => enhancePrompt("chat", "x"), /Enhance works on/);
});

test("the reply is cleaned of the wrapping models put around an answer", () => {
  assert.equal(cleanEnhanced("style", 'Here is the improved style:\n"dream pop, female vocal, 96 BPM."'), "dream pop, female vocal, 96 BPM");
  assert.equal(cleanEnhanced("style", "<think>hmm</think>```\nlo-fi\nwarm tape\n```"), "lo-fi, warm tape");
  assert.equal(cleanEnhanced("lyrics", "Lyrics:\n[Verse]\nla\n\n[Chorus]\nlo"), "[Verse]\nla\n\n[Chorus]\nlo");
  assert.equal(cleanEnhanced("simple", "A slow song.\n\nNote: I kept it short."), "A slow song.");
  assert.throws(() => cleanEnhanced("style", "  "), /nothing usable/);
});

test("a local model waits for the card; an API model never does", async () => {
  const models = { status: async () => ({ current: "q.safetensors", models: [] }), resolve: async () => ({ file: "q.safetensors", label: "Qwen 4B" }), choose: async () => {}, clear: async () => {} };
  let asked = 0;
  const ask = async () => { asked++; return "dream pop, female vocal"; };
  ask.usesCard = async () => true;
  const busy = createEnhancer({ models, ask, cardBusy: async () => "A song is rendering." });
  await assert.rejects(busy.enhance({ field: "style", text: "pop" }), (e) => e.status === 409 && /A song is rendering/.test(e.message) && /API model/.test(e.message));
  assert.equal(asked, 0, "nothing was sent to the card");
  const free = createEnhancer({ models, ask, cardBusy: async () => null });
  assert.deepEqual(await free.enhance({ field: "style", text: "pop" }), { text: "dream pop, female vocal", model: "Qwen 4B", local: true });
  const cloudAsk = async () => "dream pop"; cloudAsk.usesCard = async () => false;
  const cloud = createEnhancer({ models, ask: cloudAsk, cardBusy: async () => "A song is rendering." });
  assert.equal((await cloud.enhance({ field: "style", text: "pop" })).text, "dream pop", "a render is no reason to refuse an API model");
  let cleared = 0; const m2 = { ...models, clear: async () => { cleared++; } };
  await createEnhancer({ models: m2, ask }).choose("");
  assert.equal(cleared, 1, "an empty choice goes back to Simple mode's model");
  assert.equal((await createEnhancer({ models, ask, ownChoice: () => "api:anthropic" }).status()).own, "api:anthropic");
});

test("the routes answer for the gallery and Enhance, with the refusal's own status", async () => {
  const out = [];
  const json = (res, code, body) => out.push({ code, body });
  const gallery = createGallery({ file: path.join(root, "routes.json") });
  const ask = async () => "x"; ask.usesCard = async () => true;
  const enhancer = createEnhancer({ models: { status: async () => ({}), resolve: async () => null, choose: async () => {}, clear: async () => {} },
    ask, cardBusy: async () => "Busy." });
  const call = async (method, p, body) => {
    const routes = createPromptToolRoutes({ json, readBody: async () => body, gallery, enhancer });
    const handled = await routes({ method }, {}, new URL(`http://x${p}`));
    return { handled, ...out.pop() };
  };
  assert.equal((await call("POST", "/api/gallery", { action: "save", kind: "chat", text: "make a song" })).code, 200);
  assert.equal((await call("GET", "/api/gallery?kind=chat")).body.items[0].text, "make a song");
  assert.equal((await call("POST", "/api/gallery", { action: "save", kind: "chat", text: "" })).code, 400);
  const refused = await call("POST", "/api/enhance", { field: "style", text: "pop" });
  assert.equal(refused.code, 409); assert.match(refused.body.error, /Busy\./);
  assert.equal((await call("GET", "/api/other")).handled, false);
  assert.match(index, /if \(p === "\/api\/gallery" \|\| p === "\/api\/enhance"\)/);
  assert.match(index, /fallbackKey: \["chatModelMusic", "chatModel"\]/);
});

test("MCP can enhance each field on its own, choose the model, and use the galleries", () => {
  const by = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  for (const name of ["enhance_style", "enhance_lyrics", "enhance_description", "enhance_model", "prompt_gallery"]) {
    assert.ok(by[name], name);
    assert.equal(by[name].inputSchema.additionalProperties, false, `${name} schema is closed`);
  }
  assert.deepEqual(by.enhance_style.inputSchema.required, ["text"]);
  assert.deepEqual(by.enhance_lyrics.inputSchema.required, [], "lyrics can be written from nothing");
  assert.deepEqual(by.prompt_gallery.inputSchema.properties.kind.enum, GALLERY_KINDS);
});

test("the page: tool rows on Styles, Lyrics, Simple and Chat; Enhance in the site's colours; setup in the ⓘ", () => {
  for (const [g, f] of [["styles", "style"], ["lyrics", "lyrics"]]) {
    assert.match(html, new RegExp(`class="ptools" data-field="${f}" data-gallery="${g}"`), g);
  }
  // Simple mode is already AI: its saved ideas sit beside Send, with no Enhance.
  assert.match(html, /class="ptools" data-gallery="simple" data-target="simpleText" data-label="ideas"><\/div>\s*<button class="simple-send"/);
  assert.doesNotMatch(html, /data-field="simple"/);
  assert.doesNotMatch(html, /class="simple-hello"/, "the introduction lives behind the \"!\"");
  assert.match(html, /class="ptools" data-gallery="chat" data-target="chatText"/, "chat gets a gallery");
  assert.match(html, /<script type="module" src="prompt-tools\.js"><\/script>/);
  assert.match(html, /id="enhanceModel"/);
  assert.match(css, /\.ptbtn\.ptenh \{[^}]*linear-gradient\(135deg, var\(--primary\) 0%, var\(--secondary\) 100%\)/);
  assert.match(page, /dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
  const infoStart = html.indexOf('id="musicInfo"'), infoEnd = html.indexOf('id="musicEngineWarn"');
  const setup = html.indexOf('id="ggufSetup"');
  assert.ok(setup > infoStart && setup < infoEnd, "the GGUF setup card sits inside the ⓘ panel");
  assert.match(css, /\.minfobtn\.needs::after/);
});

test("no chat model at all is said before anything runs, with the APIs that could answer instead", async () => {
  let asked = 0;
  const ask = async () => { asked++; return "x"; }; ask.usesCard = async () => true;
  const models = {
    list: async () => [],                                   // ComfyUI answered: no chat model on disk
    resolve: async () => ({ file: "qwen_3_4b.safetensors" }),  // the default name, which does not exist
    status: async () => ({ models: [{ file: "api:anthropic", label: "Anthropic · Claude" }] }),
    choose: async () => {}, clear: async () => {},
  };
  await assert.rejects(createEnhancer({ models, ask }).enhance({ field: "style", text: "pop" }),
    (e) => e.status === 424 && e.need === "chat" && e.apis[0].file === "api:anthropic" && /No chat model is installed/.test(e.message));
  assert.equal(asked, 0, "ComfyUI is never handed a graph for a file it does not have");
  /* A chosen API needs no local file at all. */
  const api = { ...models, resolve: async () => ({ file: "api:anthropic", api: { provider: "anthropic", model: "m" }, label: "Claude" }) };
  const cloudAsk = async () => "dream pop"; cloudAsk.usesCard = async () => false;
  assert.equal((await createEnhancer({ models: api, ask: cloudAsk }).enhance({ field: "style", text: "pop" })).text, "dream pop");
  /* ComfyUI unreachable (null) is not "nothing installed": that answer stays the engine's. */
  const down = { ...models, list: async () => null };
  await createEnhancer({ models: down, ask }).enhance({ field: "style", text: "pop" }).catch(() => {});
  assert.equal(asked, 1);
  /* The page opens the model window on `need`, and the route passes it through. */
  assert.match(readFileSync(new URL("../web/prompt-tools.js", import.meta.url), "utf8"), /err\.need === "chat" && window\.aiplayNeedModel/);
  assert.match(readFileSync(new URL("./prompt-tools.js", import.meta.url), "utf8"), /need: e\.need, apis: e\.apis/);
});
