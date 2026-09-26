/** Songwriting rules for every model that writes lyrics; Simple mode's song
 *  chips, remix and rework; presets under the idea box; the drop box that
 *  always closes. No model, no server. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { LYRIC_RULES, LYRIC_AVOID, lyricTells } = await import("./lyric-style.js");
const { createMusicTools, describeForm, MUSIC_INTRO } = await import("./chat/music-tools.js");
const { systemPrompt } = await import("./chat/loop.js");
const { enhancePrompt } = await import("./prompt-tools.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("every lyric writer carries the rules; the owner's banned words are in them", () => {
  for (const w of ["room", "door", "floor", "ceiling", "seam", "dream", "sky", "skies"]) assert.ok(LYRIC_AVOID.includes(w), w);
  const rules = LYRIC_RULES.join("\n");
  assert.ok(MUSIC_INTRO.join("\n").includes(rules), "the Simple assistant");
  assert.ok(systemPrompt([]).includes(rules), "the Chat tab");
  assert.ok(enhancePrompt("lyrics", "x").includes(rules), "Enhance on lyrics");
  assert.doesNotMatch(enhancePrompt("lyrics", "x"), /vivid images/);
  assert.match(src("./mcp.js"), /write like a person: everyday words/, "agents over MCP");
  assert.deepEqual(lyricTells("Walked through the doors, dreams in the skies\nWe met at the gas station on 5th"), ["door", "dream", "skies"]);
});

test("write_song says which banned words slipped in, and still writes", async () => {
  const t = createMusicTools();
  const r = await t.get("write_song").run({ style: "indie", lyrics: "[Verse]\nOpen the door to my dreams", title: "T" });
  assert.equal(r.form.lyrics, "[Verse]\nOpen the door to my dreams");
  assert.match(r.avoid_words_used, /door/);
});

test("remix_song: the attached song, a remix engine, its seed kept — or a question", async () => {
  const t = createMusicTools();
  const song = { file: "aiplay_1.flac", title: "Storm", seed: 42, style: "orchestral", lyrics: "[Verse]\nhi" };
  t.setScreen({ engine: "MiniMax", engine_id: "minimax-music3", remix_models: [{ engine: "ace-step15", label: "ACE-Step 1.5" }], attached: [song] });
  await assert.rejects(t.get("remix_song").run({ song: "aiplay_1.flac", style: "metalcore" }), /cannot remix\. Ask the person which to use: ACE-Step 1\.5/);
  await assert.rejects(t.get("remix_song").run({ song: "other.flac", style: "x", engine: "ace" }), /not attached/);
  await assert.rejects(t.get("remix_song").run({ song: "Storm", style: "x", engine: "yue2" }), /not installed here/);
  const r = await t.get("remix_song").run({ song: "Storm", style: "metalcore", engine: "ace-step15" });
  assert.deepEqual(r.form.remix, { song: "aiplay_1.flac", engine: "ace-step15" });
  assert.equal(r.form.seed, 42, "the same energy");
  assert.equal(r.form.lyrics, "[Verse]\nhi", "its own lyrics unless new ones are given");
  t.setScreen({ engine_id: "ace-step15", remix_models: [{ engine: "ace-step15", label: "ACE-Step 1.5" }], attached: [song] });
  assert.equal((await t.get("remix_song").run({ song: "Storm", style: "x" })).form.remix.engine, "ace-step15", "the model on the screen, when it can");
  assert.ok(t.names.includes("remix_song"));
});

test("the assistant sees the attached songs and what can remix", () => {
  const d = describeForm({ engine: "MiniMax", engine_id: "minimax-music3", remix_models: [{ engine: "ace-step15", label: "ACE-Step 1.5" }],
    attached: [{ file: "a.flac", title: "Storm", seed: 7, style: "orchestral", lyrics: "[Verse]\nline one" }] });
  assert.match(d, /can this model remix: no/);
  assert.match(d, /ATTACHED SONGS \(1\):\n- "Storm" · file a\.flac/);
  assert.match(d, /seed 7/); assert.match(d, /    line one/);
  assert.match(MUSIC_INTRO.join("\n"), /REWORK it[\s\S]*seed[\s\S]*REMIX it[\s\S]*ASK\s+which/);
});

test("the page: chips in the idea box, presets under it, the drop box always closes", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), css = src("../web/styles.css");
  assert.match(html, /<form class="simple-input" id="simpleForm">\s*<!--[^>]*-->\s*<div class="simple-chips" id="simpleChips" hidden><\/div>/);
  assert.match(html, /<div class="simple-presets" id="simplePresets">\s*<select id="exPick"/);
  assert.doesNotMatch(html, /class="exrow"/, "no example picker in the Styles box");
  assert.doesNotMatch(html, /id="presetStyleBox"/, "one set of Lyrics and Style boxes, not a second copy");
  assert.match(app, /const lock = !!state\.simple;\s*for \(const id of \["caption", "lyrics", "capMeta", "capVocal", "capArr"\]\) \{ const el = \$\(id\); if \(el\) el\.readOnly = lock; \}/,
    "Simple mode: Lyrics and Styles are read-only, preset or not");
  assert.match(app, /attachToSimple\(file\);\s*\/\/ never the form/);
  assert.match(css, /\.create\.simplemode #songRef \{ display: none; \}/, "Simple drops never open the form's boxes");
  assert.match(app, /document\.addEventListener\("drop", endSongDrag\);/);
  assert.match(app, /songDragWatch = setTimeout\(endSongDrag, 400\);/);
  assert.match(app, /d\.attached = \(state\.simpleAttached \|\| \[\]\)\.map/);
  assert.match(app, /if \(f\.remix\) \{ applyRemix\(f\.remix\);/);
});

test("one solid block: chips on top, the writing space, one bar with Send at its end", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), css = src("../web/styles.css");
  const form = html.slice(html.indexOf('<form class="simple-input"'), html.indexOf("</form>", html.indexOf('<form class="simple-input"')));
  assert.ok(form.indexOf('id="simpleChips"') < form.indexOf('id="simpleText"') && form.indexOf('id="simpleText"') < form.indexOf('class="simple-bar"'));
  for (const id of ["exPick", "simpleModel", "simpleNew", "simpleSend"]) assert.ok(form.includes(`id="${id}"`), `${id} is inside the block`);
  /* Labelled, not a bare ↑ (UI_PLAN B3): the one button in Simple says what it
   * makes. Images and Video say Make picture and Make clip (web/assist.js). */
  assert.match(form, /<button class="simple-send"[^>]*>Make song<\/button>\s*<\/div>\s*$/, "Make song ends the bar");
  assert.match(src("../web/assist.js"), /view: "images", make: "Make picture",[\s\S]*?view: "video", make: "Make clip",/);
  assert.match(css, /\.create form\.simple-input textarea \{\s*flex: none;[^}]*height: 280px/, "the writing space never shrinks");
  assert.match(app, /form\?\.addEventListener\("mousedown"/, "a click anywhere in the block writes in it");
  // A dropped song fills the read-only boxes, as a preset does; presets for every model.
  assert.match(app, /function attachToSimple[\s\S]*?showSimpleSong\(file\);/);
  assert.match(app, /presetShow\(\{ caption: t\.caption \|\| "", lyrics: t\.lyrics \|\| "", song: file \}\)/);
  assert.doesNotMatch(app, /closest\("\.simple-presets"\)\?\.toggleAttribute\("hidden"/, "the presets are not hidden for any model");
  assert.match(MUSIC_INTRO.join("\n"), /COMBINE them[\s\S]*ONE new set of lyrics/, "two songs' lyrics into one");
});

test("grow handles instead of corner grips; Simple mode hides Lyrics and Styles options", () => {
  const app = src("../web/app.js"), css = src("../web/styles.css");
  for (const [id, key] of [["simpleText", "simple"], ["lyrics", "lyrics"], ["caption", "caption"]])
    assert.ok(app.includes(`growHandle($("${id}"), "${key}"`), id);
  // #scaffold joined them when the section structure became a textarea in the
  // same box as the lyrics, instead of a <pre> in a black panel below it.
  assert.match(css, /#simpleText, #lyrics, #scaffold, #caption \{ resize: none; \}/);
  assert.match(css, /\.growbar i \{[^}]*background: var\(--primary\)/, "light blue");
  assert.match(css, /\.growbar \{[^}]*bottom: -8px;[^}]*opacity: 0;[\s\S]*?\.growbar:hover, \.growbar\.drag/, "on the outer border, shown only near it");
  for (const [ta, box] of [["simpleText", "simplePanel"], ["lyrics", "lyricsBox"], ["caption", "stylesBox"]])
    assert.ok(app.includes(`growHandle($("${ta}"), `) && app.includes(`$("${box}")?.appendChild(bar)`), `${ta}'s bar on ${box}'s border`);
  for (const sel of ["#lyricsBox .tagbar", "#lyricsBox .fieldfoot", "#lyricsSwap", "#capGuide", "#stylesBox .fieldfoot", "#stylesBox .chipbar"])
    assert.ok(css.includes(`.create.simplemode ${sel}`), sel);
  assert.match(app, /function setSimple[\s\S]*?simpleLock\(\);/, "leaving Simple unlocks them");
});

test("into and out of Simple slides like Song <-> Instrumental; folded headers keep their old size", () => {
  const app = src("../web/app.js"), css = src("../web/styles.css");
  assert.match(app, /async function setSimple\(on, instant = false\)[\s\S]*?slideShut[\s\S]*?applySimple\(on\);[\s\S]*?slideOpen\(panel\)/);
  assert.match(app, /simpleCalm\(\)/, "reduced motion switches at once");
  assert.doesNotMatch(app, /localStorage\.getItem\("aiplaySimple"\)/, "Music opens on Song every start, not a remembered Simple");
  assert.match(css, /#lyricsBox:not\(\[open\]\) > summary, \.create #stylesBox:not\(\[open\]\) > summary \{ padding: 14px 11px; \}/);
});

test("a YuE2 remix: generate transcribes first, then renders; dropped songs' words are read back from the file", async () => {
  const app = src("../web/app.js");
  const t = createMusicTools();
  t.setScreen({ engine_id: "yue2-comfy", remix_models: [{ engine: "yue2-comfy", label: "YuE2 3B" }],
    attached: [{ file: "a.flac", title: "Storm", seed: 3, style: "rock", lyrics: "[Verse]\nx" }] });
  const r = await t.get("remix_song").run({ song: "Storm", style: "cheese pop", engine: "yue2" });
  assert.match(r.note, /generate transcribes the song's melody first/);
  assert.doesNotMatch(r.note, /page shows a Transcribe button/, "never sends the person to press it");
  assert.match(t.get("generate").description, /YuE2 remix it transcribes the attached song first/);
  assert.match(app, /state\.remixTranscribe = r\.song;/);
  assert.match(app, /aiplay:simple-generate", async \(\) => \{[\s\S]*?await humSendSource\(\{ library_file: file \}\)[\s\S]*?\$\("btnCreate"\)\.click\(\);/);
  assert.match(app, /return false; \}\s*\}\s*\$\("humRec"\)/, "a failed transcription stops Create");
  assert.match(app, /function attachToSimple[\s\S]*?fetch\(`\/api\/trackmeta\?file=\$\{encodeURIComponent\(file\)\}`\)/);
});

test("GPU tools run when asked, with a warning and Cancel; a delete still asks first", async () => {
  const { runTurn, newSession } = await import("./chat/loop.js");
  const idle = { status: async () => ({ ready: true, queue: { running: 0, pending: 0 }, running: [] }) };
  const ran = [];
  const mk = (name, extra) => ({ name, args: {}, description: name, run: async () => { ran.push(name); return { ok: true, say: "Started." }; }, ...extra });
  const list = [mk("render", { spends: true, cost: "the card" }), mk("remove", { spends: true, gate: "destroys" }), mk("go", { spends: true, endsTurn: true })];
  const tools = { all: list, names: list.map((t) => t.name), get: (n) => list.find((t) => t.name === n) || null, spending: list.map((t) => t.name), routed: [] };
  const turn = async (answers, autoSpend = true) => {
    const evs = [], queue = [...answers];
    const model = async () => queue.shift() ?? '{"say":"done"}';
    model.usesCard = async () => false;
    const s = newSession();
    await runTurn({ tools, engine: idle, model, autoSpend }, s, "do it", (e) => evs.push(e));
    return { evs, s };
  };
  let { evs } = await turn(['{"tool":"render","args":{}}', '{"say":"It is rendering."}']);
  assert.ok(evs.some((e) => e.type === "gpu" && e.tool === "render"), "the warning");
  assert.ok(!evs.some((e) => e.type === "proposal"), "no ask-first card");
  assert.deepEqual(ran, ["render"]);
  ({ evs } = await turn(['{"tool":"go","args":{}}']));
  assert.ok(evs.some((e) => e.type === "say" && e.text === "Started."), "a turn-ending tool answers for itself");
  const r = await turn(['{"tool":"remove","args":{}}']);
  assert.ok(r.evs.some((e) => e.type === "proposal" && e.tool === "remove") && r.s.pending?.tool === "remove", "deleting still asks");
  assert.ok(!ran.includes("remove"));
  ({ evs } = await turn(['{"tool":"render","args":{}}'], false));
  assert.ok(evs.some((e) => e.type === "proposal"), "chatConfirmGpu brings the ask-first card back");
  const { systemPrompt } = await import("./chat/loop.js");
  assert.match(systemPrompt(list, null, { autoSpend: true }), /RUNS AS SOON AS YOU CALL IT/);
  const chat = src("../web/chat.js"), app = src("../web/app.js");
  assert.match(chat, /case "gpu":[\s\S]*?gpuWarning\(ev\)/, "Chat tab shows it");
  assert.match(chat, /ev\.type === "gpu"\) \{ simpleRow\("note", gpuWarning\(ev\)\)/, "Simple shows it");
  assert.match(app, /aiplay:gpu-cancel[\s\S]*?fetch\("\/api\/cancel", \{ method: "POST" \}\)/, "Cancel is the app's Stop");
  assert.match(src("./chat/routes.js"), /autoSpend: deps\.autoSpend \?\? config\.chatConfirmGpu !== true/);
});

test("audit fixes: one spelling of a key, real languages, settings the model has, vocals stay vocals", async () => {
  const { normalizeKey, normalizeLanguage, applyFormPatch } = await import("./chat/music-tools.js");
  assert.deepEqual(["Em", "e minor", "E Minor", "Cb", "F#m", "Bb major"].map(normalizeKey), ["Em", "Em", "Em", "B", "F#m", "Bb"]);
  assert.equal(normalizeKey("H"), null);
  assert.deepEqual(["jp", "Japanese", "cn", "EN"].map(normalizeLanguage), ["ja", "ja", "zh", "en"]);
  assert.equal(normalizeLanguage("klingon"), null);
  const t = createMusicTools();
  t.setScreen({ engine: "MiniMax", engine_id: "minimax-music3", max_length: 300 });
  const r = await t.get("change_settings").run({ key: "Em", length_seconds: 360 });
  assert.equal(r.form.key, undefined, "MiniMax has no key");
  assert.match(r.not_changed, /key is not a setting on MiniMax/);
  assert.equal(r.form.lengthSeconds, 300, "the model's own longest");
  await assert.rejects(t.get("change_settings").run({ language: "ja" }), /Nothing changed: language is not a setting/);
  t.setScreen({ engine_id: "ace-step15", attached: [{ file: "a.flac", title: "A", lyrics: "" }, { file: "b.flac", title: "B", lyrics: "", instrumental: true }] });
  assert.equal((await t.get("change_settings").run({ key: "e minor", language: "Japanese" })).form.key, "Em");
  await assert.rejects(t.get("remix_song").run({ song: "A", style: "x" }), /lyrics of "A" are not on the screen/, "never a silent instrumental");
  assert.equal((await t.get("remix_song").run({ song: "B", style: "x" })).form.instrumental, true);
  assert.equal((await t.get("remix_song").run({ song: "A", style: "x", lyrics: "[Verse]\nhi" })).form.instrumental, false);
  assert.equal((await t.get("change_settings").run({ clear_remix: true })).form.remix, null);
  const f = applyFormPatch({ engine: "MiniMax", engine_id: "minimax-music3" }, { remix: { song: "a.flac", engine: "ace-step15" } });
  assert.equal(f.engine_id, "ace-step15", "the rest of the turn sees the model the remix switched to");
  const app = src("../web/app.js"), chat = src("../web/chat.js");
  assert.match(app, /state\.trackMeta \|\| \(state\.trackMeta = \{\}\)\)\[file\]/, "read-back words survive the library poll");
  assert.match(app, /const t = simpleSongRow\(file\) \|\| \{ file \};/, "and reach the assistant");
  assert.match(app, /simpleNew"\)\?\.addEventListener\("click", \(\) => \{ state\.simpleAttached = \[\]; clearRemix\(\);/);
  assert.match(app, /simpleGenerated\(true\);/);
  assert.match(chat, /aiplay:simple-generated[\s\S]*?Rendering started/);
  assert.match(src("./chat/routes.js"), /ROUTABLE\[n\] !== "destroys"/, "recent tools stay reachable, never a deleting one");
});

test("Stop in Simple mode ends the turn; each message has its own screen; Cancel stops a transcription", async () => {
  const { runTurn, newSession } = await import("./chat/loop.js");
  const idle = { status: async () => ({ ready: true, queue: { running: 0, pending: 0 }, running: [] }) };
  const ran = [];
  const list = [{ name: "go", args: {}, description: "go", run: async () => { ran.push("go"); return {}; } }];
  const tools = { all: list, names: ["go"], get: (n) => list.find((t) => t.name === n) || null, spending: [], routed: [] };
  let stop = false, calls = 0;
  const model = async () => { calls++; stop = true; return '{"tool":"go","args":{}}'; };
  model.usesCard = async () => false;
  const evs = [];
  const out = await runTurn({ tools, engine: idle, model, stopped: () => stop }, newSession(), "hi", (e) => evs.push(e));
  assert.equal(out.stopped, true);
  assert.deepEqual(ran, [], "nothing runs after Stop");
  assert.equal(calls, 1, "and the model is not asked again");
  const chat = src("../web/chat.js"), routes = src("./chat/routes.js"), index = src("./index.js");
  assert.match(chat, /if \(SIMPLE_SENDING\) \{ SIMPLE_STREAM\?\.abort\(\); return; \}/, "Send is Stop while a reply runs");
  assert.match(chat, /signal: SIMPLE_STREAM\.signal/);
  assert.match(routes, /res\.on\("close", \(\) => \{ if \(!res\.writableEnded\) gone = true; \}\)/);
  assert.match(routes, /const musicTurn = scope === "music" \? \(deps\.musicTools \? tools : createMusicTools\(\)\)\s*: panel \? createFormTools\(scope\) : null;/, "a screen per message");
  assert.match(index, /startsWith\("art\."\) \|\| r\.via === "music\.cover"/, "the app's Stop reaches song-to-score");
});

test("rework is the default; a failed separation ends the wait; the assistant sees models and renders", async () => {
  assert.match(MUSIC_INTRO.join("\n"), /REWORK it\. THIS IS THE DEFAULT[\s\S]*Nothing is transcribed[\s\S]*REMIX it ONLY when they want THE RECORDING ITSELF/);
  const t = createMusicTools();
  const models = [{ value: "yue2-gguf:q8_0", engine: "yue2-gguf", label: "YuE2 GGUF · Q8", available: true },
    { value: "yue2-comfy", engine: "yue2-comfy", label: "YuE2 3B (ComfyUI)", available: false, note: "no YuE2 checkpoint" }];
  t.setScreen({ engine: "MiniMax", engine_id: "minimax-music3", music_models: models,
    remix_models: [{ engine: "yue2-gguf", label: "YuE2 GGUF · Q8" }], attached: [{ file: "a.wav", title: "A", lyrics: "[Verse]\nx" }] });
  const r = await t.get("change_settings").run({ music_model: "yue2", key: "e minor" });
  assert.equal(r.form.musicModel, "yue2-gguf:q8_0");
  assert.equal(r.form.key, "Em", "the key is for the model it switched to");
  await assert.rejects(t.get("change_settings").run({ music_model: "yue2-comfy" }), /not installed here \(no YuE2 checkpoint\)/);
  assert.equal((await t.get("remix_song").run({ song: "A", style: "x", engine: "yue2" })).form.remix.engine, "yue2-gguf", "the YuE2 that is installed");
  const d = describeForm({ engine: "MiniMax", music_models: models,
    jobs: { running: "", queued: 0, recent: ['"X" on yue2-gguf: FAILED — out of memory'] }, transcription: "FAILED for a.wav — encoder missing" });
  assert.match(d, /YuE2 3B \(ComfyUI\) \(engine yue2-comfy\): MISSING — no YuE2 checkpoint/);
  assert.match(d, /FAILED — out of memory/);
  assert.match(d, /melody transcription: FAILED for a\.wav/);
  // The separation a transcription waits on: a failure ends the wait at once.
  const { EventEmitter } = await import("node:events");
  const { ensureVocalStem } = await import("./music/stems.js");
  const art = new EventEmitter(); art.queue = []; art.current = null;
  art.request = (job) => { setTimeout(() => art.emit("failed", { file: job.file, kind: "stems", error: "demucs crashed" }), 20); return job; };
  const t0 = Date.now();
  /* The preflight is injected: the default one asks this PC's stems python
   * for demucs, and a machine without one would fail here for a reason this
   * case is not about. */
  await assert.rejects(ensureVocalStem("song.flac", { art, outputDir: "C:/nowhere-aiplay", timeoutMs: 60000, preflight: async () => ({ ok: true }) }), /separation of song\.flac failed: demucs crashed/);
  assert.ok(Date.now() - t0 < 5000, "not the fifteen-minute wait");
  const app = src("../web/app.js");
  assert.match(app, /scores\[file\] = \$\("yAbc"\)\?\.value/, "one transcription per song");
  assert.match(app, /d\.music_models = /); assert.match(app, /FAILED — \$\{j\.error/);
});

/* Every `.libhead` in the file, located by DIV DEPTH rather than by a regex:
 * walk from each opening tag counting `<div`/`</div>` until the count returns to
 * zero, and that is its matching close. Positions, not slices — a wrapper's
 * "everything after me" reaches the end of the document, so asking which wrapper
 * some id follows by substring gives the FIRST wrapper every time. Comments are
 * stripped first so a `<div` inside one cannot shift the count. */
function libheads(html) {
  const bare = html.replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  const open = /<div class="libhead[^"]*"[^>]*>/g;
  let m;
  while ((m = open.exec(bare))) {
    const openEnd = m.index + m[0].length;
    const tag = /<div\b[^>]*>|<\/div\s*>/g;
    tag.lastIndex = openEnd;
    let depth = 1, t = null;
    while (depth > 0 && (t = tag.exec(bare))) depth += t[0].startsWith("</") ? -1 : 1;
    assert.equal(depth, 0, "a .libhead that never closes");
    out.push({ attrs: m[0], openAt: m.index, closeAt: t.index, inner: bare.slice(openEnd, t.index) });
  }
  return { bare, heads: out };
}

test("the library heading is one sticky block, and the gallery is not inside it", () => {
  const html = src("../web/index.html"), css = src("../web/styles.css"), info = src("../web/info.js");
  const { bare, heads } = libheads(html);
  assert.equal(heads.length, 3, "one per gallery: Music, Images, Video");

  /* ⚠ ONE WRAPPER, NOT FOUR STICKY SIBLINGS. Sticky elements do not stack:
   * four of them at `top: 0` land on top of one another, and stacking them by
   * hand hard-codes each one's height into the next one's `top` — heights that
   * change the moment the tick bar wraps. */
  for (const h of heads) assert.match(h.inner, /class="stagehead"/, "the heading is inside it");

  /* ⚠ AND THE GRID IS OUTSIDE IT — a gallery inside the sticky wrapper is a
   * header that never lets its own grid scroll. The wrapper that owns a grid is
   * the LAST one opening before it, which is why this needs positions. */
  for (const id of ["imgGrid", "clipGrid"]) {
    const at = bare.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${id} is in the page`);
    const owner = heads.filter((h) => h.openAt < at).pop();
    assert.ok(owner, `${id} follows a .libhead`);
    assert.ok(at > owner.closeAt, `${id} is NOT inside the sticky header above it`);
  }

  /* Music's wrapper is hidden as a unit. It sits directly in `.stage` — the
   * scroller every view shares — so hiding only its children leaves its own
   * padding and hairline as a bar across the top of every other screen.
   * Measured at height 10 on Images before setView hid the wrapper. */
  const music = heads.find((h) => h.attrs.includes("musicHead"));
  assert.ok(music, "Music's wrapper is named, because it is hidden as a unit");
  assert.match(music.inner, /id="batchBar"/, "the song bar is one of the three inside it");
  assert.match(src("../web/app.js"), /\$\("musicHead"\)\.hidden = name !== "create";/,
    "and the WRAPPER is what setView hides, not the three controls separately");

  /* ⚠ THE WRAPPER IS A LEVEL, AND `:scope >` STOPS AT LEVELS. Without this,
   * Images and Video fell into mountInfo's "no heading" branch and their circled-i
   * floated above the page instead of sitting in the title. */
  assert.match(info, /:scope > \.libhead > \$\{h\}/,
    "mountInfo finds a heading one level down, inside the sticky wrapper");
  assert.match(info, /classList\.contains\("libhead"\) \? header\.parentElement : header/,
    "and the panel opens after the BLOCK, so a screenful of prose is not pinned to the window");

  assert.match(css, /\.libhead\{position:sticky;top:0/, "it is actually sticky");
  /* `top:0` is the scrollport's PADDING box, so it leaves `.stage`'s 16px above
   * the header for the grid to scroll through. Measured at headerTop-6 with the
   * grid scrolled 1500px: DIV.masonry on Images, IMG.cthumb on Video. */
  assert.match(css, /\.libhead::before\{[^}]*bottom:100%/,
    "and it covers the scroller's top padding, which `top:0` does not reach");
});

test("each gallery has its own selection bar: Music's only on Music, new ones on Images and Video", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), css = src("../web/styles.css");
  assert.match(css, /\.batchbar\[hidden\] \{ display: none !important; \}/, "and hidden really hides it");
  assert.match(html, /id="imgBatch"[\s\S]*?data-pick="collage"[\s\S]*?data-pick="trash"[\s\S]*?data-pick="clear"[\s\S]*?<div class="clipgrid" id="imgGrid">/, "Images: under its search row, above the gallery");
  assert.match(html, /id="clipBatch"[\s\S]*?data-pick="boost"[\s\S]*?data-pick="trash"[\s\S]*?<div class="clipgrid" id="clipGrid">/, "Video: under its search row, above the clips");
  assert.match(app, /mountPickBar\(\{\s*grid: "imgGrid", bar: "imgBatch", tile: "\.imtile"/);
  assert.match(app, /mountPickBar\(\{\s*grid: "clipGrid", bar: "clipBatch", tile: "\.clipcard"/);
  assert.match(app, /new MutationObserver\(\(\) => dress\(\)\)\.observe\(g/, "ticks survive the gallery's repaint");
  assert.match(app, /e\.stopPropagation\(\);\s*const input = box\.querySelector\("input"\);/, "a tick never opens the tile");
});

test("the Images page's ⓘ sits in its heading, not loose above the page", () => {
  const app = src("../web/app.js"), js = src("../web/assist.js"), css = src("../web/styles.css");
  assert.match(app, /images: "#imagesview \.vidlib",/, "on the gallery's heading, as Video's is on Clips");
  assert.match(js, /head\?\.nextElementSibling\?\.classList\.contains\("infopanel"\)/, "its panel opens right under the heading");
  assert.match(css, /:not\(\.ctawrap\):not\(\.infopanel\) \{ display: none !important; \}/, "and Simple mode does not hide it");
});

test("Music, Images and Video share one layout: creator column left, what it made on the right", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), css = src("../web/styles.css");
  assert.match(html, /<section class="ovcol" id="imgPanel" hidden>\s*<div class="vidform">\s*<div class="ovhead"><h2>Pictures<\/h2><\/div>/, "Images' form is the left column, titled like Video's, and named as the rail names it (UI_PLAN B1)");
  assert.match(html, /<div id="imagesview" hidden>\s*<div class="vidwrap">\s*<div class="vidlib">/, "the stage holds only the gallery");
  assert.match(app, /const hasLeft = lib \|\| name === "overnight" \|\| name === "video" \|\| name === "images";/);
  assert.match(app, /\$\("imgPanel"\)\.hidden = name !== "images";/);
  assert.match(html, /<div class="ctawrap">\s*<div class="cta">\s*<button class="btn primary wide" type="button" id="imgGo">/, "Make image pinned at the foot, like Render clip and Create");
  assert.match(css, /:is\(#vidPanel, #imgPanel \.vidform\) > \.ovhead h2 \{\s*font-family: var\(--sans\); font-size: 18px; font-weight: 650;/, "left titles match the gallery titles");
  assert.match(css, /:is\(#imgPanel \.vidform, #vidPanel\) \.params \{ border: 0;/, "settings rows open on the column in both");
  assert.match(css, /:is\(#imgPanel \.vidform, #vidPanel\) :is\(\.lbl, \.flabel\) \{\s*text-transform: none;/, "one label style");
});

test("Images and Video line up row for row; every note sits above its button; Music's idea label matches", () => {
  const css = src("../web/styles.css");
  assert.match(css, /#vidPanel \{ gap: 12px; \}/, "both columns step by 12px");
  // Video's note was ordered above Render clip with flex. Every screen's note
  // sits under its own button in the flow now (UI_PLAN C2), so nothing to order.
  assert.match(css, /\.ctanote, #imgPanel \.ctawrap > \.hint \{[\s\S]*?position: static;/, "the note sits under the button");
  assert.doesNotMatch(css, /#vidPanel \.ctawrap > \.ctanote \{ order: -1; \}/);
  assert.match(css, /#imagesview \.wrow\.imgtools \{ margin: 0 0 8px; min-height: 32px;/, "the galleries' bars on one line");
  assert.match(css, /\.create \.simple \.simple-label \{ font-size: var\(--fs-md\); font-weight: 500; margin: 7px 6px 1px 10px;/, "Music's label like the others");
});

test("Music's Simple block and Images'/Video's follow one measured spec", () => {
  const css = src("../web/styles.css");
  assert.match(css, /\.asmode\.seg\.modebar \{ margin-bottom: 2px; \}/, "14px from the switch to the block, as Music");
  assert.match(css, /\.assist \{ font-size: 13px; line-height: 20\.15px; \}/);
  assert.match(css, /\.create \.simple \.simple-label, \.assist \.simple-label \{ color: var\(--dim\); line-height: 20px;/);
  assert.match(css, /\.assist form\.simple-input textarea \{ height: 280px; \}/, "the same writing space");
  assert.match(css, /\.create \.simple-bar \.simple-new, \.assist \.simple-bar \.simple-new \{\s*padding: 2px 6px;/);
  assert.match(css, /\.create \.simple-bar select, \.assist \.simple-bar select,[\s\S]*?font-size: 12px; padding: 0 26px 0 10px;/);
});

test("Images: the sampler and schedule follow the model; sliders sit in fields like the dropdowns", async () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), css = src("../web/styles.css"), index = src("./index.js");
  const samplerLabel = html.match(/<label\b([^>]*\bfor="imgSampler"[^>]*)>sampler<\/label>/);
  assert.ok(samplerLabel, "sampler label exists in the main rows");
  assert.match(samplerLabel[1], /\bhidden\b/, "visibility follows the effective image model");
  const samplerEngines = new Set((samplerLabel[1].match(/\bdata-engineonly="([^"]*)"/)?.[1] || "").split(/\s+/));
  for (const engine of ["checkpoint", "anima", "flux2", "zimage", "zimage-base", "krea2", "qwen-image-2.1"])
    assert.ok(samplerEngines.has(engine), `${engine} exposes its sampler in the main rows`);
  assert.doesNotMatch(html, /id="imgAdv" hidden>\s*<label for="imgSampler"/);
  for (const [eng, s, sc] of [["flux2", "euler", "simple"], ["zimage", "res_multistep", "simple"], ["\"zimage-base\"", "res_multistep", "simple"], ["krea2", "euler", "simple"], ["\"qwen-image-2.1\"", "euler", "simple"]])
    assert.match(app, new RegExp(`${eng}: \{[^}]*sampling: \{ sampler: "${s}", scheduler: "${sc}", fixed: true \}`), eng);
  assert.match(app, /anima: \{\s*sampling: \{ sampler: "er_sde", scheduler: "simple", fixed: false \}/, "Anima: er_sde / simple, changeable");
  assert.match(app, /imgSampling\(\);\s*\/\/ this engine's sampler and schedule/);
  assert.match(app, /imgSampling\(\);\s*\/\/ this file's kind of model picks the pair/);
  const samplerForwarding = index.match(/sampler:\s*\(([^)]+)\)\s*&&\s*typeof b\.sampler === "string"\s*\?\s*b\.sampler\.slice\(0, 40\)/);
  assert.ok(samplerForwarding, "a selected sampler is bounded and forwarded");
  assert.match(samplerForwarding[1], /engine === "anima"/, "Anima's pick reaches its graph");
  assert.match(samplerForwarding[1], /engine === "checkpoint"/, "checkpoint sampler overrides remain available");
  assert.match(samplerForwarding[1], /engine === QWEN_IMAGE_ENGINE/, "Qwen sampler validation reaches its graph");
  const { checkValue, describeScreen } = await import("./chat/form-tools.js");
  assert.throws(() => checkValue({ id: "imgSampler", type: "select", fixed: true, value: "euler", options: [] }, "er_sde"), /fixed by this engine/);
  assert.match(describeScreen({ fields: [{ id: "imgSampler", label: "sampler", type: "select", fixed: true, value: "euler", options: [] }] }), /imgSampler · sampler \(fixed by this engine\)/);
  assert.match(css, /\.params > \.pv:has\(> input\[type=range\]\) \{\s*background: var\(--mfield\);[^}]*border-radius: 10px;[^}]*padding: 0 12px;/, "sliders in a field");
});

test("your own model file: er_sde / simple is Anima's alone; SDXL anime merges get SDXL's pair", () => {
  const app = src("../web/app.js");
  const body = app.slice(app.indexOf("export function ckptSampling"), app.indexOf("async function imgSampling"));
  const ckptSampling = new Function(body.replace("export function", "return function"))();
  const pair = (name, variant, family = "unet") => { const r = ckptSampling({ name, family, variant }); return `${r.sampler}/${r.scheduler}`; };
  // The files on the owner's machine, with what detect.js says they are.
  assert.equal(pair("novaAnimeXL_ilV180.safetensors", "SDXL"), "euler_ancestral/normal");
  assert.equal(pair("ntrMIXIllustriousXL_xiii.safetensors", "SDXL"), "euler_ancestral/normal");
  assert.equal(pair("rinFlanimeIllustrious_v50.safetensors", "SDXL"), "euler_ancestral/normal");
  assert.equal(pair("perfectdeliberate_v90.safetensors", "SDXL"), "dpmpp_2m/karras");
  assert.equal(pair("unholyDesireMixSinister_v80.safetensors", "SDXL"), "dpmpp_2m/karras");
  assert.equal(pair("oneObsession_anima29BV1.safetensors", "anima", "anima"), "er_sde/simple");
  assert.equal(pair("JANIMAAnima_v1029B_bf16.safetensors", "anima", "anima"), "er_sde/simple");
  assert.equal(pair("miaomiaoHarem_anima16.safetensors", "anima", "anima"), "er_sde/simple");
  assert.equal(pair("animagineXL40_v4.safetensors", "SDXL"), "euler_ancestral/normal", "Animagine is SDXL, not Anima");
  assert.equal(pair("ponyDiffusionV6XL.safetensors", "SDXL"), "euler_ancestral/normal");
  assert.equal(pair("Flux4BUnstableRevolution.safetensors", "depth 5/20", "flux2"), "euler/simple");
  assert.equal(pair("ZImage - DarkBeast.safetensors", "dim 3840", "zimage"), "res_multistep/simple");
  assert.equal(pair("redcraftHybridH3A2A_30Krea2.safetensors", "Krea 2"), "euler/simple");
});

test("Video Advanced in order: settings, Frames, Sound, Fine tuning, Lab, then Render clip", () => {
  const html = src("../web/index.html"), tips = src("../web/tips.js"), lab = src("../web/videolab.js");
  const p = html.slice(html.indexOf('id="vidPanel"'), html.indexOf("</section>", html.indexOf('id="vidPanel"')));
  const at = (x) => { const i = p.indexOf(x); assert.ok(i > 0, x); return i; };
  const order = ['id="vidPrompt"', 'id="vidQualityRow"', 'for="vidSecs"', '>Frames</div>', 'id="vidFrom"', 'id="vidToRow"',
    'id="vidMidRow"', '>Sound</div>', 'id="vidRefWrap"', 'id="vidSndWrap"', '>Fine tuning</div>', 'id="vidAdv"', 'id="vidLab"', 'id="vlab"', 'id="vidCreate"'];
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`);
  // A dropdown and its file button share one row.
  for (const [sel, btn] of [["vidFrom", "vidFromPick"], ["vidTo", "vidToPick"], ["vidSndSong", "vidSndPick"], ["vidRefSong", "vidRefAudPick"]])
    assert.match(p, new RegExp(String.raw`<div class="pickrow"( hidden)?>\s*<select id="${sel}"[\s\S]*?</select>\s*<button[^>]*id="${btn}"`), sel);
  // The two frame slots are picture drop boxes now (web/picdrop.js); their
  // dropdown row stays in the page, hidden, as the state it writes to.
  for (const sel of ["vidFrom", "vidTo"])
    assert.match(p, new RegExp(String.raw`<div id="${sel}Drop"></div>\s*<div class="pickrow" hidden>\s*<select id="${sel}"`), `${sel} drop box`);
  // The notes that floated between controls are "!" tips.
  for (const id of ["vidToNote", "vidLoopNote", "vidAdvNote", "vidQualityNote"]) {
    assert.match(p, new RegExp(`class="tipsrc" id="${id}"`), id);
    assert.match(tips, new RegExp(`from: "${id}"`), id);
  }
  // The lab is folded and has no second big button.
  assert.doesNotMatch(lab, /details class="field vlab" open/);
  assert.doesNotMatch(lab, /class="btn" type="button" id="vlabCompare"/);
});

test("Images and Video get Music's grow handle on their Simple and Advanced boxes", () => {
  const app = src("../web/app.js"), assist = src("../web/assist.js"), grow = src("../web/grow.js");
  assert.match(grow, /export function growHandle\(ta, key, place\)/);
  assert.match(app, /import \{ growHandle, growWrap \} from "\.\/grow\.js";/);
  assert.match(app, /growWrap\(\$\("imgPrompt"\), "imgPrompt"\);/);
  assert.match(app, /growWrap\(\$\("vidPrompt"\), "vidPrompt"\);/);
  assert.match(assist, /growHandle\(text, `\$\{kind\}Simple`, \(b\) => form\.appendChild\(b\)\);/);
});

test("Video quality: Fast only when it differs from Standard, chips in a row; no Make button in any Simple mode", () => {
  const app = src("../web/app.js"), css = src("../web/styles.css");
  /* Fast and Standard are the server's numbers (stepDefaults, which follow the
   * disk), so "the same" is a comparison of those numbers, not of the TaoMate
   * flag: without TaoMate Fast is the 4-step build, which equals Standard on a
   * disk without the 8-step files. server/mcp-steer_test.js pins the numbers. */
  assert.match(app, /\$\("vidQFast"\)\.hidden = !tb && qs\.fast === qs\.standard;/,
    "where Fast would equal Standard: one chip, not two (with the builds known, Fast is TaoMate's 3, dimmed when missing)");
  assert.match(css, /#vidQualityRow > \.pv\.chips \{ flex-wrap: nowrap;/);
  assert.match(css, /\.create\.simplemode \.ctawrap > \.cta, \.assist-on \.ctawrap > \.cta \{ display: none !important; \}/,
    "the assistant makes it on your word: Create, Make image and Render clip hide in Simple");
});

test("style packs start on Welcome; Community counts live rooms and starting-soon rooms apart", () => {
  const html = src("../web/index.html"), app = src("../web/app.js");
  assert.match(html, /data-go="community">Explore<\/a>\s*<\/nav>[\s\S]*?id="homeOr"[\s\S]*?id="homePackBtn"[^>]*>Start from a template<\/button>\s*<div class="homepacks" id="homePacks" hidden>/);
  assert.doesNotMatch(html, /id="commPacks"/, "gone from Community");
  assert.match(app, /const live = \(feed\?\.sessions \|\| \[\]\)\.length;\n\s+const soon = \(feed\?\.parties \|\| \[\]\)\.length;/, "upcoming rooms are not live");
  assert.match(app, /on\.push\(`<b>\$\{soon\}<\/b> starting soon`\)/);
  assert.match(app, /paintSoon\(feed\);\n\s+if \(!live\)/, "starting soon shows when nothing is live");
});

test("a template is shown: Styles lights up, the style types itself in, then Create lights up and is never pressed", () => {
  const app = src("../web/app.js"), css = src("../web/styles.css");
  const f = app.slice(app.indexOf("async function usePack(i)"), app.indexOf("$(\"homePackBtn\").onclick"));
  assert.match(f, /box\.classList\.add\("spot"\);[\s\S]{0,200}?if \(!skip\) await wait\(2500\);/, "about 2.5 s of highlight first");
  assert.match(f, /cap\.value = text\.slice\(0, n\);/, "letter by letter");
  assert.match(f, /go\.classList\.add\("spot"\);/);
  assert.doesNotMatch(f, /btnCreate"\)\.click\(\)|go\.click\(\)/, "Create stays the person's to press");
  assert.match(css, /#btnCreate\.spot \{ animation: spotGlowHot/, "not the button's own blue");
  assert.match(f, /box\.classList\.add\("spot"\);\n\s+veilOnly\(box\);/, "the rest of the page dims and blurs while Styles is shown");
  assert.match(f, /go\.classList\.add\("spot"\);\n\s+veilOnly\(go\);/, "...and stays dim around Create");
  assert.match(css, /\.unveiling \{ transition: filter \.9s ease; \}/, "fades out as slowly as it fades in");
  assert.match(css, /#stylesBox\.spot \{ transform: scale\(1\.025\);/, "pops up");
  assert.match(css, /\.veiled \{ filter: brightness\(\.35\) blur\(2px\); transition: filter \.9s ease;/);
});

test("the left column: the same room on the right as on the left, and a divider you can drag", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), css = src("../web/styles.css");
  assert.match(css, /\.create, #vidPanel, #imgPanel \{ scrollbar-gutter: stable; padding-right: 16px; \}/, "16px to the scrollbar, as the left's 16px");
  assert.match(html, /<div class="colgrip" id="colGrip" role="separator" aria-orientation="vertical"/);
  // The rail is its own draggable width now (--railw, 248px by default), so
  // this column sits between two grips rather than beside a fixed 220px.
  assert.match(css, /grid-template-columns: var\(--railw, 248px\) var\(--colw, minmax\(340px, 420px\)\) minmax\(0, 1fr\);/);
  assert.match(app, /const clamp = \(w\) => Math\.round\(Math\.max\(320, Math\.min\(w, maxW\(\)\)\)\);/, "never under 320px, the stage keeps 380px");
  assert.match(app, /grip\?\.addEventListener\("dblclick", \(\) => set\(0\)\);/, "double-click resets");
});

test("Collab wears the app's clothes: one measure, section rules, fields, one primary press per pane", () => {
  const html = src("../web/index.html"), css = src("../web/styles.css");
  assert.match(css, /#collab \{\n\s+--mfield:[^}]*max-width: 940px;/, "one readable measure and the app's field tokens");
  assert.match(css, /#collab \.subhead \{[^}]*text-transform: uppercase;[\s\S]*?#collab \.subhead::after \{ content: ""; flex: 1; height: 1px;/, "section rules like Video's");
  assert.match(css, /#collab :is\(\.btn\.sm, label\.btn\.sm\) \{[\s\S]*?border-radius: 999px; background: transparent;/, "quiet outlined buttons");
  assert.match(css, /#collab :is\(\.btn\.sm\.primary, label\.btn\.sm\.primary\) \{/, "...and a filled one for the press that matters");
  // Scope each pane at its real boundary: Training has its own primary action.
  const pane = (id, end) => html.slice(html.indexOf(`id="${id}"`), html.indexOf(`id="${end}"`));
  assert.equal((pane("cbPaneSend", "cbPaneFriends").match(/btn sm primary/g) || []).length, 2, "Send: the file, and the way out of the empty state");
  assert.equal((pane("cbPaneFriends", "training").match(/btn sm primary/g) || []).length, 1, "Friends: Add");
  assert.match(css, /#collab \.cbpeer :is\(\.ok, \.warn\) \{ padding: 0; border: 0; background: none;/, "a row's state is a word, not a warning box");
});
