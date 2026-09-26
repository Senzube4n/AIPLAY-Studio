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
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { CATALOG, markRequired } from "./models.js";
import { config } from "./config.js";

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
  /* Never for video being off; only while this form's RunPod job is being sent (RunPod GPU mode). */
  assert.match(app, /\$\("vidCreate"\)\.disabled = \$\("vidCreate"\)\.dataset\.runpodBusy === "1";/);
  assert.doesNotMatch(app, /\$\("vidCreate"\)\.disabled = !on;/);
  assert.match(app, /function bottomDrawer\(\{ title, body, yes = "Continue", no = "Not now" \}\)/);
  assert.match(app, /if \(!state\.video\?\.enabled\) \{\n\s+const go = await bottomDrawer\(/);
  assert.match(app, /if \(!go \|\| !\(await enableVideo\(\)\)\) return;/, "a No, or a refused switch, renders nothing");
  assert.match(app, /body: JSON\.stringify\(\{ action: "enable", value: true \}\),/, "the same switch Settings uses");
  const css = src("../web/styles.css");
  assert.match(css, /\.bdrawer-wrap\.open \.bdrawer \{ transform: translateY\(0\); \}/, "it slides up from the bottom");
});

/* THE REQUIRED BADGE FOLLOWS THE SELECTED ENGINE, AND ONLY ONCE IT IS READY.
 * status() copied the catalogue's `required`, which marks MiniMax Music 3 as
 * config.js's starting engine, so an install running YuE2 was told MiniMax was
 * REQUIRED and offered 11.92 GB it would never render with. Badging "the
 * selected engine" alone fixed that for nobody new: a fresh install's selected
 * engine IS config.js's MiniMax, and /api/music refuses to select an engine
 * that is not downloaded, so a newcomer was still told MiniMax was the one.
 * Until the selected engine is ready no single row is required, and every
 * music row carries the group. The rows are the engine map's own, so a new
 * engine is in these tests the day it is in config.js. */
const MUSIC_CAPS = [...new Set(Object.values(config.music.engines).map((e) => e.capability))];
/* Status rows the way the screen gets them: every music row, plus one that is
 * not a music row and must come through untouched. */
const rows = (ready = []) => [...MUSIC_CAPS, "coverArt"].map((id) => ({
  id, ready: ready.includes(id), required: !!CATALOG.find((c) => c.id === id)?.required, requiredGroup: null,
}));
const selecting = (engine) => ({ ...config.music, engine });
const local = { enabled: false }, hosted = { enabled: true, provider: "fal" };
const badges = (list) => list.filter((r) => r.required).map((r) => r.id);
const groups = (list) => list.filter((r) => r.requiredGroup).map((r) => `${r.id}:${r.requiredGroup}`);

test("a fresh install badges no single music engine: every music row says one is required", () => {
  /* The real status() on the real default config, with nothing on disk: a
   * child process with empty settings, models, rig and output folders, the
   * way qwen-cover_test.js reads a fresh config. It stats files and writes none. */
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-screen-"));
  try {
    const env = { ...process.env, AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: path.join(dir, "models"),
      AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output") };
    delete env.AIPLAY_MUSIC_ONLY;                  // the full Studio, not the music-only entry point
    const url = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
    const source = `import { config } from ${url("./config.js")}; import { ModelManager } from ${url("./models.js")};`
      + "const rows = (await new ModelManager().status()).map(({ id, ready, required, requiredGroup }) => ({ id, ready, required, requiredGroup }));"
      + "console.log(JSON.stringify({ engine: config.music.engine, api: !!config.api.enabled, rows }));";
    const printed = execFileSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8", timeout: 60_000 });
    const fresh = JSON.parse(printed.trim().split("\n").at(-1));
    assert.equal(fresh.engine, "minimax-music3", "the default engine is unchanged; this is about the badge");
    assert.equal(fresh.api, false);
    const musicRows = fresh.rows.filter((r) => MUSIC_CAPS.includes(r.id));
    assert.equal(musicRows.length, MUSIC_CAPS.length, "every music row is on the screen");
    assert.ok(musicRows.every((r) => !r.ready), "nothing is on disk, or this case proves nothing");
    assert.deepEqual(badges(musicRows), [], "no single music row is REQUIRED: MiniMax least of all");
    assert.deepEqual(groups(musicRows).sort(), MUSIC_CAPS.map((id) => `${id}:music`).sort(), "every music row says one music engine is required");
    assert.deepEqual(groups(fresh.rows.filter((r) => !MUSIC_CAPS.includes(r.id))), [], "no other row joins the group");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("once the selected engine is ready it alone is required; hosted Music 3 needs no local weights", () => {
  const yue = markRequired(rows(["musicYue2"]), { music: selecting("yue2"), api: local });
  assert.deepEqual(badges(yue), ["musicYue2"], "a YuE2 install is not told MiniMax is required");
  assert.deepEqual(groups(yue), [], "the choice is made, so no group");
  assert.deepEqual(badges(markRequired(rows(["engine"]), { music: selecting("minimax-music3"), api: local })), ["engine"],
    "a MiniMax install that has its weights still is");
  assert.deepEqual(badges(markRequired(rows(["musicYue2Gguf"]), { music: selecting("yue2-gguf"), api: local })), ["musicYue2Gguf"],
    "the native engine, when it is the one selected and set up");

  // Selected but not on disk: MiniMax being there does not answer for YuE2.
  const notYet = markRequired(rows(["engine"]), { music: selecting("yue2"), api: local });
  assert.deepEqual(badges(notYet), []);
  assert.deepEqual(groups(notYet), MUSIC_CAPS.map((id) => `${id}:music`));
  // A saved engine that maps to no row points at nothing: the group is the true answer.
  assert.deepEqual(groups(markRequired(rows(["engine"]), { music: selecting("gone"), api: local })), MUSIC_CAPS.map((id) => `${id}:music`));

  /* HOSTED MUSIC 3 renders on the provider's machine (jobs.js #runApi takes
   * exactly api.enabled + minimax-music3), so the 11.92 GB local download is
   * not required, and nothing else is either: the music engine is working. */
  const api = markRequired(rows([]), { music: selecting("minimax-music3"), api: hosted });
  assert.deepEqual(badges(api), [], "API mode is not told to download local weights");
  assert.deepEqual(groups(api), [], "...nor that it still lacks a music engine");
  // API mode is Music 3's alone: a local YuE2 with the switch left on still needs its files.
  assert.deepEqual(badges(markRequired(rows(["musicYue2"]), { music: selecting("yue2"), api: hosted })), ["musicYue2"]);

  const other = markRequired(rows([]), { music: selecting("yue2"), api: local }).find((r) => r.id === "coverArt");
  assert.equal(other.requiredGroup, null, "a row outside the music engines keeps its catalogue answer");
  /* The catalogue flag itself is unchanged: fit.js and the docs find the
   * DEFAULT engine by it, and the welcome panels fall back to it. */
  assert.deepEqual(CATALOG.filter((c) => c.required).map((c) => c.id), ["engine"]);
});

test("no music engine's sentence says required or optional: the badge is the one place that answer lives", () => {
  for (const id of MUSIC_CAPS) {
    assert.doesNotMatch(CATALOG.find((c) => c.id === id).why, /\b(required|optional)\b/i, id);
  }
});

test("both card shapes badge from the server's answer, and /api/models marks after the native overlay", () => {
  assert.match(app, /const requiredBadge = \(c\) => \(c\.required \? "required" : c\.requiredGroup === "music" \? "one music engine required" : ""\);/);
  // The native card reads the flags instead of printing "optional" whatever is selected.
  assert.match(app, /<span class="badge">\$\{requiredBadge\(c\) \|\| "optional"\}<\/span>/);
  assert.doesNotMatch(app, /<span class="badge">optional<\/span>/);
  assert.match(app, /\$\{requiredBadge\(c\) \? `<span class="badge">\$\{requiredBadge\(c\)\}<\/span>` : ""\}/);
  assert.doesNotMatch(app, /c\.required \? '<span class="badge">required<\/span>'/, "the old flag-only badge is gone");
  // The native GGUF row's readiness exists only after the overlay, so the mark is taken over it.
  assert.match(index, /const capabilities = markRequired\(cat\.map\(\(c\) => \(\{\n\s+\.\.\.c,\n\s+\.\.\.\(c\.nativeSetup \? \{ready:/);
});
