/**
 * THE MODELS SCREEN AND THE "YOU NEED A MODEL" WINDOW.
 *
 * Reported from a fresh install on somebody else's machine: sections reopened
 * themselves, there was no chat model anywhere, Music listed SD1.5 checkpoints
 * and ControlNets, and Enhance or a missing music model ended in a raw refusal
 * or an OK box. No server, no GPU: these read the catalogue and the page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATALOG } from "./models.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = src("../web/app.js"), index = src("./index.js"), pick = src("../web/modelpick.js");

/* index.js's own section rule, run against the real catalogue. */
const ruleSrc = index.match(/function modelGroupOf\(c\) \{[\s\S]*?\n\}/)[0];
const modelGroupOf = new Function(`${ruleSrc}; return modelGroupOf;`)();

test("Music & audio holds music: no checkpoint, ControlNet, depth or H3 bridge lands there", () => {
  const music = CATALOG.filter((c) => modelGroupOf(c) === "music").map((c) => c.id);
  /* SD1.5 image models sit with the images, even though the Motion look is
   * their main user; what only ever makes motion sits with video. */
  const where = { sd15Dreamshaper8: "images", controlNetSd15: "images", ipAdapterSd15: "images", clipVisionH: "images",
    animateDiffV3: "video", animateDiffSparseCtrl: "video", depthPreprocess: "video", depthPreprocessLarge: "video",
    bridgeBunny: "video", bridgeSemantic: "video" };
  for (const [id, group] of Object.entries(where)) {
    assert.ok(!music.includes(id), `${id} is not a music model`);
    assert.equal(modelGroupOf(CATALOG.find((c) => c.id === id)), group, id);
  }
  for (const id of ["engine", "musicAceStep15", "musicYue2Gguf", "musicYue2Comfy"]) assert.ok(music.includes(id), id);
  assert.match(src("./models.js"), /group: cap\.group \|\| null,/, "status rows carry the field");
});

test("a Chat section exists and has the model every chat menu defaults to", () => {
  const chat = CATALOG.filter((c) => c.group === "chat");
  assert.ok(chat.length >= 1);
  assert.ok(chat.some((c) => c.files.some((f) => /qwen_3_4b\.safetensors$/.test(f.dest))), "the default chat file has a row");
  for (const c of chat) {
    assert.equal(modelGroupOf(c), "chat");
    assert.ok(c.licence && c.outputRights?.class && c.requires?.vramMinGb, `${c.id} is a complete row`);
    assert.ok(!c.makes, "not a picture model: it must not reach the Images picker");
  }
  assert.match(index, /\{ id: "chat", label: "Chat & writing" \}/);
});

test("a section stays how the person left it, across repaints and restarts", () => {
  const fn = app.match(/function groupModelCards\(d, htmls\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(fn, /c\.progress/, "a download no longer forces its section open");
  assert.match(fn, /const open = state\.modelGroupsOpen\.has\(g\);/);
  assert.match(app, /localStorage\.setItem\("aiplayModelGroups"/);
  assert.match(app, /localStorage\.getItem\("aiplayModelGroups"/);
});

test("the model window: floating, draggable, minimisable, closed only by its ×", () => {
  assert.match(pick, /export function openModelPicker\(o\)/);
  assert.match(pick, /aria-modal="false"/, "the page stays usable while a download runs");
  assert.match(pick, /\.mp-x"\)\.onclick = \(\) => \{ win\.hidden = true;/);
  assert.match(pick, /\.mp-min"\)\.onclick = \(\) => win\.classList\.toggle\("min"\)/);
  assert.match(pick, /pointerdown/, "dragged by its title bar");
  assert.doesNotMatch(pick, /key === "Escape"|addEventListener\("keydown"/, "no Escape: a download's window is not lost by a key");
  assert.doesNotMatch(pick, /document\.addEventListener\("click"/, "no click-outside close");
  assert.match(pick, /fitStates/, "fit verdicts are the server's, not written here");
  assert.match(pick, /action: "download", id: get\.dataset\.get/);
  assert.match(src("../web/index.html"), /modelpick|app\.js/);
});

test("an uninstalled music model opens the window instead of an OK box", () => {
  const choose = app.match(/async function chooseMusicModel\(value\) \{[\s\S]*?\n\}/)[0];
  assert.match(choose, /if \(!c\.available && c\.engine !== "yue2-gguf"\) \{/);
  assert.match(choose, /needModel\("music"/);
  assert.match(app, /const off = false;/, "not-installed rows are choosable, so choosing one can offer it");
  assert.match(app, /globalThis\.aiplayNeedModel = needModel;/);
  assert.match(app, /"minimax-music3": "engine", "ace-step15": "musicAceStep15"/);
});

test("a MiniMax song's badge names the model, not just its precision", () => {
  const fn = app.match(/function songModelLabel\(t\) \{[\s\S]*?\n\}/)[0];
  const label = new Function(`${fn}; return songModelLabel;`)();
  assert.equal(label({ engine: "minimax-music3", model: "int8" }), "MiniMax Music 3 · int8");
  assert.equal(label({ engine: "minimax-music3", model: "fp16" }), "MiniMax Music 3 · fp16");
  assert.equal(label({ engine: "minimax-music3", model: "MiniMax Music 3 (API)" }), "MiniMax Music 3 (API)");
  assert.equal(label({ model: "int8" }), "MiniMax Music 3 · int8", "rows from before the engine field were MiniMax");
  assert.equal(label({ engine: "yue2-gguf", model: "YuE2 GGUF Q8" }), "YuE2 GGUF Q8", "every other engine already records its name");
  assert.equal(label({ engine: "ace-step15", model: "ACE-Step 1.5 turbo" }), "ACE-Step 1.5 turbo");
  assert.doesNotMatch(app, /\$\{esc\(j\.model \|\| "int8"\)\}/);
});

test("Unload is always there, for every engine, and disabled rather than absent", () => {
  assert.match(app, /unload\.hidden = false;/,
    "it used to hide whenever a cover or clip had already unloaded the music model");
  assert.match(app, /box\.hidden = false;/, "and used to be missing entirely on all but three engines");
  assert.match(app, /unload\.disabled = busy \|\| !holding;/);
  assert.match(app, /const holding = !!loaded \|\| !!s\.artResident;/,
    "a picture model on the card is still something to free");
});

test("every screen's 'model not installed' opens the model window, gated ones with their how-to", () => {
  assert.match(app, /function offerModel\(r\) \{/);
  assert.match(app, /function failSay\(r\) \{\n\s+if \(!offerModel\(r\)\) alert\(r\?\.error\);/);
  assert.doesNotMatch(app, /\{ alert\(r\.error\);/, "no plain alert of a server refusal is left");
  assert.match(app, /if \(!offerModel\(r\)\) await appAlert\(r\.error, "Nothing was queued"\)/, "the Images screen too");
  assert.match(app, /if \(!e\.isTrusted\) return;/, "the Images picker asks at the pick, never on page load");
  const index = src("./index.js");
  assert.equal((index.match(/needsModel: cap\?\.id \|\| null/g) || []).length, 4, "each image engine's refusal names its row");
  assert.ok((index.match(/capability: capId/g) || []).length >= 3, "gated refusals name their row too");
  const rowsFor = new Function(`${pick.match(/const MUSIC_ROWS[\s\S]*?\nfunction rowsFor[\s\S]*?\n\}/)[0]}; return rowsFor;`)();
  const caps = [{ id: "videoLtx", group: "video", gated: {} }, { id: "video", group: "video" }, { id: "animateDiffV3", group: "video" },
    { id: "coverArt", group: "images", makes: "picture" }, { id: "imageKrea2", group: "images", makes: "picture" }, { id: "controlNetSd15", group: "images" }];
  assert.deepEqual(rowsFor(caps, "auto", "videoLtx").map((c) => c.id), ["videoLtx", "video"], "video: the engines the picker offers");
  assert.deepEqual(rowsFor(caps, "auto", "imageKrea2").map((c) => c.id), ["coverArt", "imageKrea2"], "images: the picture models, not their parts");
  assert.match(pick, /data-how="\$\{esc\(c\.id\)\}">How to get it<\/button>/, "a gated row explains itself instead of offering a Download that fails");
});

test("Render is never greyed out for video being off: it asks in a drawer and switches it on", () => {
  assert.match(app, /\$\("vidCreate"\)\.disabled = false;/);
  assert.doesNotMatch(app, /\$\("vidCreate"\)\.disabled = !on;/);
  assert.match(app, /function bottomDrawer\(\{ title, body, yes = "Continue", no = "Not now" \}\)/);
  assert.match(app, /if \(!state\.video\?\.enabled\) \{\n\s+const go = await bottomDrawer\(/);
  assert.match(app, /if \(!go \|\| !\(await enableVideo\(\)\)\) return;/, "a No, or a refused switch, renders nothing");
  assert.match(app, /body: JSON\.stringify\(\{ action: "enable", value: true \}\),/, "the same switch Settings uses");
  const css = src("../web/styles.css");
  assert.match(css, /\.bdrawer-wrap\.open \.bdrawer \{ transform: translateY\(0\); \}/, "it slides up from the bottom");
});
