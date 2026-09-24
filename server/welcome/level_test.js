/**
 * THE SHELL LANE: the level, the rail, the first-run lines, the phone.
 *
 * UI_PLAN B1, B3, B4, B5, B6 and E1, and the owner's words of 2026-09-24:
 * "have it open on simple but make it clear there is an advanced with a
 * tooltip option that shows what you get".
 *
 *   1. THE LEVEL. A fresh install opens Simple; an install already in use keeps
 *      Advanced and has Advanced WRITTEN for it (Studio's own keys, or Studio's
 *      own songs in the output folder); the settings file the launcher writes
 *      before Studio's first start does not count as "in use"; a saved choice
 *      wins; the first save writes prefs.ui and nothing else; a settings.json
 *      that is there and cannot be parsed (a trailing comma, a BOM) keeps
 *      Advanced and is left byte-identical. Run in child processes against
 *      temp settings files, because config.js reads the file once, at import.
 *   2. THE DOOR. /api/welcome {action:"level"} reads, saves only for Studio's
 *      own page or a local client (and not at all without the guard), refuses
 *      a bad value, refuses to write over an unparseable file; studio_welcome
 *      carries it and stays withheld from the in-app chat.
 *   3. A HOME CARD OPENS SIMPLE EITHER WAY. web/level.js run against a stub
 *      document: on an Advanced install a Home card still sends its screen to
 *      Simple, and only that screen; the other screens follow the level; a
 *      refused save keeps its reason on screen.
 *   4. EVERY TOOLTIP NAMES REAL CONTROLS that Simple really hides.
 *   5. THE FIRST-RUN LINES on eight imaginary machines, judged by the real
 *      fit.js: the half that falls short (card or RAM), the AMD music warning,
 *      decimal GB, a friend's card worded as untried, then Reactive, nothing
 *      paid; Music only has no video line.
 *   6. THE RAIL: Make first, the rest folded, Models and Settings pinned, the
 *      fold's tooltip from its visible links.
 *   7. THE PHONE: the media rule exists and does what B6 asks.
 *   8. PLAIN WORDS for every run the music-video Activity can show, and the DAW.
 *   9. THE MAKE BUTTONS MAKE: a writing model is yes, no or not known yet; a
 *      press is the go-ahead; typed words are never dropped unasked.
 *
 * Runs standalone (`node server/welcome/level_test.js`) and in the pre-commit
 * hook. Temp folders only; no server, no GPU, no network.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const HTML = read("web/index.html");
const tmp = await mkdtemp(path.join(tmpdir(), "aiplay-level-"));

/* Every import below that reaches config.js reads THIS folder, never the
 * person's own settings. */
process.env.AIPLAY_APPDATA = path.join(tmp, "self");

/* ── 1. the level, per install ─────────────────────────────────────────────── */
console.log("\nTHE LEVEL");
const CONFIG_URL = pathToFileURL(path.join(ROOT, "server", "config.js")).href;
const LEVEL_URL = pathToFileURL(path.join(ROOT, "server", "welcome", "level.js")).href;

/** A Studio start against `settings` (or no file): what config decided, what
 *  the first save wrote, and what a second start then reads. */
async function boot(name, settings, { library = [] } = {}) {
  const dir = path.join(tmp, name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  /* A string is written as it is: the files config.js cannot parse. */
  if (typeof settings === "string") await writeFile(file, settings);
  else if (settings) await writeFile(file, JSON.stringify(settings, null, 2));
  /* Files already in the folder Studio renders into (settings.outputDir). */
  for (const n of library) {
    await mkdir(settings.outputDir, { recursive: true });
    await writeFile(path.join(settings.outputDir, n), "x");
  }
  const script = `
    const { config, prefsSnapshot, prefOrigin } = await import(${JSON.stringify(CONFIG_URL)});
    const { persistStartLevel } = await import(${JSON.stringify(LEVEL_URL)});
    const at = { ...config.ui, imageOrigin: prefOrigin("image", "engine") };
    const wrote = await persistStartLevel();
    console.log(JSON.stringify({ at, wrote, snap: prefsSnapshot().ui }));`;
  /* The output folder comes from the settings under test, or is an empty one:
   * never the default rig's, which on a machine that has rendered holds songs
   * and would make every "fresh" install here look in use. */
  const env = { ...process.env, AIPLAY_APPDATA: dir, AIPLAY_OUTPUT: path.join(dir, "no-songs-yet") };
  if (settings && typeof settings === "object" && settings.outputDir) delete env.AIPLAY_OUTPUT;
  const run = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop());
  const first = run();
  let saved = null;
  try { saved = JSON.parse(await readFile(file, "utf8")); } catch { /* none */ }
  return { first, saved, again: run, file };
}

const fresh = await boot("fresh", null);
ok("a fresh install (no settings file) opens Simple, chosen by Studio",
  fresh.first.at.level === "simple" && fresh.first.at.levelBy === "studio", JSON.stringify(fresh.first.at));
ok("...and the first start writes that down, so it cannot drift later",
  fresh.first.wrote === true && fresh.saved?.prefs?.ui?.level === "simple" && fresh.saved.prefs.ui.levelBy === "studio",
  JSON.stringify(fresh.saved));
ok("...writing prefs.ui and no other preference (machine defaults are worked out when read, never frozen)",
  Object.keys(fresh.saved?.prefs || {}).filter((k) => k !== "keptFromBefore").join(",") === "ui", Object.keys(fresh.saved?.prefs || {}).join(","));
/* config.js reads a prefs block with no `keptFromBefore` as an OLDER Studio's
 * file and pins the picture engine to its literal as "kept". The prefs block
 * the first start creates says it is this Studio's: the marker, empty. */
ok("...with config.js's this-Studio marker, empty (nothing was kept from an older Studio)",
  Array.isArray(fresh.saved?.prefs?.keptFromBefore) && fresh.saved.prefs.keptFromBefore.length === 0, JSON.stringify(fresh.saved?.prefs));
/* The thing the first save is for: a later write of any "in use" key must not
 * turn this install into an Advanced one at the next start. */
await writeFile(fresh.file, JSON.stringify({ ...fresh.saved, welcome: { seenVersion: 3 }, api: { enabled: false } }, null, 2));
const freshAgain = fresh.again();
ok("...and the next start keeps Simple after the app has written other keys",
  freshAgain.at.level === "simple" && freshAgain.wrote === false, JSON.stringify(freshAgain));
ok("...and is still a fresh install to the defaults: the picture engine is the machine's, not \"Saved in your settings\"",
  fresh.first.at.imageOrigin === null && freshAgain.at.imageOrigin === null, JSON.stringify({ first: fresh.first.at.imageOrigin, again: freshAgain.at.imageOrigin }));

const launcher = await boot("launcher", {
  rig: "C:\\AIPLAY\\rig", python: "C:\\AIPLAY\\rig\\python.exe", torchBackend: "cu130",
  gpu: { vendor: "nvidia", name: "NVIDIA GeForce RTX 4070", totalMb: 12282, source: "chosen at install" },
  comfyExtraArgs: [], launchFrom: "Studio's own ComfyUI (main, nvidia)",
});
ok("a settings file written only by the launcher and the engine installer is still a fresh install",
  launcher.first.at.level === "simple", JSON.stringify(launcher.first.at));
ok("...and the launcher's keys survive the first save",
  launcher.saved?.rig === "C:\\AIPLAY\\rig" && launcher.saved?.gpu?.totalMb === 12282);

const existing = await boot("existing", { rig: "D:\\AI\\rig", prefs: { music: { engine: "yue2-comfy" }, tier: "auto" } });
ok("an install already in use (it has prefs) keeps Advanced",
  existing.first.at.level === "advanced" && existing.first.at.levelBy === "studio", JSON.stringify(existing.first.at));
ok("...and Advanced is WRITTEN for it, beside the prefs it already had",
  existing.saved?.prefs?.ui?.level === "advanced" && existing.saved.prefs.music?.engine === "yue2-comfy" && existing.saved.prefs.tier === "auto",
  JSON.stringify(existing.saved?.prefs));
ok("...without the this-Studio marker, so what an older Studio saved stays \"Saved in your settings\" at the next start",
  !("keptFromBefore" in (existing.saved?.prefs || {})) && existing.again().at.imageOrigin === "kept", JSON.stringify(existing.saved?.prefs));
const seenTour = await boot("seen", { welcome: { seenVersion: 2, seenAt: "2026-09-10T10:00:00Z" } });
ok("an install that has shown the tour keeps Advanced", seenTour.first.at.level === "advanced");

const chose = await boot("chose", { prefs: { ui: { level: "simple", levelBy: "you" }, music: { engine: "yue2-comfy" } } });
ok("a saved choice wins, with who made it, and is not rewritten",
  chose.first.at.level === "simple" && chose.first.at.levelBy === "you" && chose.first.wrote === false);
ok("prefsSnapshot carries the level, so savePrefs() keeps it",
  chose.first.snap?.level === "simple" && chose.first.snap?.levelBy === "you", JSON.stringify(chose.first.snap));
const junk = await boot("junk", { prefs: { ui: { level: "expert" } } });
ok("a level that is not simple or advanced is not taken from the file",
  junk.first.at.level === "advanced" && junk.first.at.levelBy === "studio", JSON.stringify(junk.first.at));

/* A FILE THAT IS THERE AND CANNOT BE PARSED is an install with a typo, not a
 * new one: before this rule the first start wrote {prefs:{ui}} over it and
 * erased the rig, the python and the keys (the review's wipe probe). */
const INSTALL = { rig: "D:\\AI\\rig", python: "D:\\AI\\rig\\python.exe", prefs: { music: { engine: "yue2-comfy" } }, llm: { models: { anthropic: "x" } } };
const commaText = JSON.stringify(INSTALL, null, 2).replace(/\n}$/, ",\n}\n");
const bomText = `\uFEFF${JSON.stringify(INSTALL, null, 2)}`;
for (const [name, text] of [["a trailing comma", commaText], ["a byte-order mark (PowerShell 5.1's UTF8)", bomText]]) {
  const b = await boot(`unreadable-${name.length}`, text);
  const after = await readFile(b.file, "utf8");
  ok(`settings.json with ${name}: the first start writes NOTHING, the file is byte-identical`,
    b.first.wrote === false && after === text, JSON.stringify({ wrote: b.first.wrote, same: after === text }));
  ok(`...and it is not taken for a new install: Advanced, chosen by Studio, with the reason kept`,
    b.first.at.level === "advanced" && b.first.at.levelBy === "studio" && typeof b.first.at.unreadable === "string",
    JSON.stringify(b.first.at));
}

/* Studio-written keys beyond prefs (a chosen writing model, a model override,
 * the DAW's latency) and a library already made each mean "in use". */
const chatOnly = await boot("chatmodel", { rig: "C:\\AIPLAY\\rig", chatModelMusic: "qwen_3_4b.safetensors" });
ok("an install whose only Studio key is a chosen writing model keeps Advanced", chatOnly.first.at.level === "advanced",
  JSON.stringify(chatOnly.first.at));
const daw = await boot("daw", { rig: "C:\\AIPLAY\\rig", dawLatency: { default: 12 } });
ok("...and so does one that has only measured the DAW's latency", daw.first.at.level === "advanced");
const libDir = path.join(tmp, "withsongs", "out");
const songs = await boot("withsongs", { rig: "C:\\AIPLAY\\rig", outputDir: libDir }, { library: ["aiplay_20260901_001.flac", "ComfyUI_00001_.png"] });
ok("an install with Studio's own songs in its output folder and default settings is in use: Advanced is written",
  songs.first.wrote === true && songs.saved?.prefs?.ui?.level === "advanced" && songs.saved.prefs.ui.levelBy === "studio",
  JSON.stringify(songs.saved?.prefs));
const foreignOnly = await boot("comfyonly", { rig: "C:\\AIPLAY\\rig", outputDir: path.join(tmp, "comfyonly", "out") }, { library: ["ComfyUI_00001_.png"] });
ok("...while pictures ComfyUI made on its own before Studio came are not Studio's library: still Simple",
  foreignOnly.saved?.prefs?.ui?.level === "simple", JSON.stringify(foreignOnly.saved?.prefs));

const { startLevel, LEVELS, PREF_PATHS, IN_USE_KEYS } = await import(CONFIG_URL);
ok("the two levels are simple and advanced", LEVELS.join(",") === "simple,advanced");
ok("ui.level and ui.levelBy are PREF_PATHS entries, validated",
  PREF_PATHS.some(([g, k, v]) => g === "ui" && k === "level" && v("simple") && !v("expert"))
  && PREF_PATHS.some(([g, k, v]) => g === "ui" && k === "levelBy" && v("you") && !v("agent")));
ok("startLevel(): empty settings are a fresh install", startLevel({}).level === "simple" && startLevel(null).level === "simple");
ok("startLevel(): an unreadable file is Advanced and never saved over", (() => {
  const u = startLevel({}, { unreadable: "Unexpected token" });
  return u.level === "advanced" && u.saved === false && !!u.unreadable;
})());
/* The launcher and the engine installer write these; none may count as use. */
ok("no key the launcher or the engine installer writes counts as \"in use\"",
  ["rig", "python", "gpu", "modelsDir", "modelsDirPinned", "modelsAlso", "outputDir", "inputDir", "comfyExtraArgs",
    "comfyOptions", "comfyAmdFix", "torchBackend", "torchVersion", "launchFrom", "engineInstall", "musicOnly"]
    .every((k) => !IN_USE_KEYS.includes(k)), IN_USE_KEYS.join(","));

/* ── 2. the door and the tool ──────────────────────────────────────────────── */
console.log("\nTHE DOOR");
const { createWelcomeRoutes } = await import(pathToFileURL(path.join(ROOT, "server", "welcome", "routes.js")).href);
const { config } = await import(CONFIG_URL);
async function call(body, { local = true, guard = true } = {}) {
  let out = null;
  const route = createWelcomeRoutes({
    json: (_res, code, b) => { out = { code, body: b }; },
    readBody: async () => body,
    ...(guard ? { sameOriginLocalJson: () => local } : {}),
  });
  await route({ method: "POST" }, {}, new URL("http://127.0.0.1/api/welcome"));
  return out;
}
const got = await call({ action: "level" });
ok("level with no value reads it: the level, who chose, the line and every screen's tooltip",
  got.code === 200 && LEVELS.includes(got.body.level) && typeof got.body.line === "string"
  && ["create", "images", "video"].every((v) => /^Advanced adds /.test(got.body.advancedAdds?.[v] || "")),
  JSON.stringify(got.body).slice(0, 300));
ok("...and names the screens that open on it, so the page keeps no list of its own",
  JSON.stringify(got.body.screens) === JSON.stringify(["create", "images", "video"]), JSON.stringify(got.body.screens));
const foreign = await call({ action: "level", level: "advanced" }, { local: false });
ok("saving refuses a request that is not Studio's own page or a local client", foreign.code === 403);
const unguarded = await call({ action: "level", level: "advanced" }, { guard: false });
ok("...and routes built WITHOUT the guard refuse every save (it fails closed)", unguarded.code === 403);
const bad = await call({ action: "level", level: "expert" });
ok("saving refuses a level that does not exist, and says what does", bad.code === 400 && /simple, advanced/.test(bad.body.error));
/* A hand-broken file at save time: refused, untouched, and the level unmoved. */
await mkdir(path.dirname(config.settingsFile), { recursive: true });
await writeFile(config.settingsFile, commaText);
const before = config.ui.level;
const broken = await call({ action: "level", level: before === "simple" ? "advanced" : "simple" });
ok("saving over a settings.json that cannot be parsed is refused (409), says why, and writes nothing",
  broken.code === 409 && /could not be parsed/.test(broken.body.error) && (await readFile(config.settingsFile, "utf8")) === commaText
  && config.ui.level === before, JSON.stringify({ code: broken.code, error: broken.body?.error }));
await rm(config.settingsFile, { force: true });
const set = await call({ action: "level", level: "advanced" });
const onDisk = JSON.parse(await readFile(config.settingsFile, "utf8"));
ok("saving writes prefs.ui with levelBy you, and the running config follows",
  set.code === 200 && set.body.levelBy === "you" && onDisk.prefs?.ui?.level === "advanced" && config.ui.level === "advanced",
  JSON.stringify(onDisk.prefs));
ok("...and Settings' line says the person chose it", /^You chose Advanced/.test(set.body.line));

const MCPW = read("server/mcp-welcome.js");
ok("studio_welcome carries level and first_run as actions, and level as a parameter",
  /enum: \["reopen", "dismiss", "first_run", "level"\]/.test(MCPW) && /level: \{\s*type: "string", enum: \["simple", "advanced"\]/.test(MCPW)
  && /post\(\{ action: "level", level: String\(a\.level\) \}\)/.test(MCPW) && /post\(\{ action: "first_run" \}\)/.test(MCPW));
const WITHHELD = /export const WITHHELD = \{([\s\S]*?)\n\};/.exec(read("server/chat/router.js"))?.[1] || "";
ok("...and it stays withheld from the in-app chat, because it saves a setting",
  /\n\s*studio_welcome: "[^"]*SAVES the Simple\/Advanced level/.test(WITHHELD));
const INDEX = read("server/index.js");
ok("/api/status serves the level", /ui: \{ level: config\.ui\.level, levelBy: config\.ui\.levelBy \},/.test(INDEX));
ok("the first start saves it, and the welcome door gets the same-origin guard",
  /server\.listen\([^\n]*\n[^\n]*\n\s*persistStartLevel\(\)/.test(INDEX)
  && /createWelcomeRoutes\(\{ json, readBody, sameOriginLocalJson \}\)/.test(INDEX));

/* ── 3. web/level.js: a Home card opens Simple either way ──────────────────── */
console.log("\nA HOME CARD OPENS SIMPLE");
let pageN = 0;
async function page(level, { refuse = null } = {}) {
  const listeners = {};
  const el = () => ({ hidden: false, checked: false, textContent: "", title: "", addEventListener() {} });
  const els = { levelFoot: el(), levelAll: el(), levelNote: el() };
  const posts = [];
  globalThis.document = {
    readyState: "complete",
    getElementById: (id) => els[id] || null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  globalThis.fetch = async (_url, init) => {
    const b = JSON.parse(init.body);
    posts.push(b);
    if (b.level && refuse) return { json: async () => ({ error: refuse, level, levelBy: "studio", line: "x" }) };
    const lv = b.level || level;
    return { json: async () => ({ ok: true, level: lv, levelBy: b.level ? "you" : "studio", line: "x",
      screens: ["create", "images", "video"],
      advancedAdds: { create: "Advanced adds a", images: "Advanced adds b", video: "Advanced adds c" } }) };
  };
  const mod = await import(`${pathToFileURL(path.join(ROOT, "web", "level.js")).href}?${level}${++pageN}`);
  const news = [];
  mod.onLevel((n) => news.push(n));
  await new Promise((r) => setTimeout(r, 20));
  const click = (go) => {
    const target = { closest: (sel) => (sel === "#home [data-go]" ? { dataset: { go } } : null) };
    for (const fn of listeners.click || []) fn({ target });
  };
  return { mod, news, click, els, posts };
}
for (const level of ["advanced", "simple"]) {
  const p = await page(level);
  const bootNews = p.news.find((n) => n.boot);
  ok(`${level} install: every screen hears the saved level on load`,
    !!bootNews && bootNews.simple === (level === "simple") && !bootNews.view);
  ok(`${level} install: the rail's "Show every setting" shows only while the level is Simple`,
    p.els.levelFoot.hidden === (level !== "simple"));
  p.news.length = 0;
  p.click("create");
  p.click("images");
  p.click("video");
  p.click("chat");
  ok(`${level} install: the Home cards for Music, Pictures and Video each open their own screen on Simple`,
    p.news.length === 3 && p.news.every((n) => n.home && n.simple === true)
    && p.news.map((n) => n.view).join(",") === "create,images,video", JSON.stringify(p.news.map((n) => [n.view, n.simple])));
}
{
  const p = await page("simple");
  p.news.length = 0;
  await p.mod.levelSave("advanced");
  ok("Show every setting saves Advanced through the same door, and every screen follows at once",
    p.posts.some((b) => b.action === "level" && b.level === "advanced")
    && p.news.length === 1 && p.news[0].all && p.news[0].simple === false && p.els.levelAll.checked === true);
}
{
  const p = await page("simple", { refuse: "settings.json could not be parsed" });
  p.news.length = 0;
  p.els.levelAll.checked = true;                    // the switch was flipped before the answer
  await p.mod.levelSave("advanced");
  ok("a save the server refuses keeps its reason on screen and puts the switch back",
    p.news.length === 0 && p.els.levelAll.checked === false
    && /^Not saved: settings\.json could not be parsed/.test(p.els.levelNote.textContent)
    && /^Not saved: /.test(p.els.levelFoot.title), JSON.stringify({ note: p.els.levelNote.textContent, foot: p.els.levelFoot.title }));
}
delete globalThis.document;
delete globalThis.fetch;
const LEVELJS = read("web/level.js");
ok("web/level.js keeps no list of the Simple screens: they are the server's `screens`",
  !/LEVEL_SCREENS|\["create",\s*"images",\s*"video"\]/.test(LEVELJS) && /last\.screens/.test(LEVELJS));

/* The screens obey the news the way the lane above assumes. */
const APP = read("web/app.js"), ASSIST = read("web/assist.js");
ok("Music: app.js takes the level from web/level.js, keeps a switch already pressed, and has a visible Advanced",
  /import \{ onLevel \} from "\.\/level\.js";/.test(APP)
  && /onLevel\(\(n\) => \{[\s\S]*?if \(n\.view && n\.view !== "create"\) return;\s*if \(n\.boot && musicModeTouched\) return;[\s\S]*?setSimple\(!!n\.simple, true\);/.test(APP)
  && /\$\("modeAdv"\)\?\.addEventListener\("click", \(\) => setSimple\(false\)\);/.test(APP)
  && /<div class="seg modebar"[^>]*id="modeSeg">[\s\S]*?<button type="button" id="modeAdv"[^>]*>Advanced<\/button>\s*<\/div>/.test(HTML));
ok("Pictures and Video: assist.js opens on the level, not on a hard-coded Advanced",
  /import \{ onLevel \} from "\.\/level\.js";/.test(ASSIST)
  && /onLevel\(\(n\) => \{[\s\S]*?adv\.title = tip;[\s\S]*?if \(n\.view && n\.view !== P\.view\) return;\s*if \(n\.boot && touched\) return;\s*setMode\(!!n\.simple\);/.test(ASSIST)
  && !/Every start opens on Advanced/.test(ASSIST));
ok("assist.js's header no longer claims the choice is remembered per panel",
  !/remembered\s*\*?\s*per panel/.test(ASSIST.slice(0, 1200)));
ok("Settings has the switch, and the rail's foot has the way out",
  /<section class="pcard" id="set-level" data-nav="Screens">[\s\S]*?id="levelAll"[\s\S]*?Show every setting[\s\S]*?id="levelNote"/.test(HTML)
  && /<div class="railfoot">[\s\S]*?<button type="button" class="levelfoot" id="levelFoot" hidden>Show every setting<\/button>/.test(HTML));

/* ── 4. the tooltips name real controls ────────────────────────────────────── */
console.log("\nTHE TOOLTIPS");
const { ADVANCED_ADDS, advancedTip, levelState } = await import(LEVEL_URL);
ok("every screen with a Simple form has an Advanced tooltip",
  levelState().screens.every((v) => (ADVANCED_ADDS[v] || []).length >= 3 && /^Advanced adds .+\.$/.test(advancedTip(v))));
const missing = Object.entries(ADVANCED_ADDS).flatMap(([v, rows]) => rows.flatMap((r) => r.ids.filter((id) => !HTML.includes(`id="${id}"`)).map((id) => `${v}:${id}`)));
ok("every control a tooltip promises is in web/index.html", missing.length === 0, missing.join(", "));
/* The melody box by the name the page gives it (2026-09-24): a tester hunting
 * for "the melody box" found only More Options, and Music's Advanced tooltip
 * never mentioned it. */
ok("Music's Advanced tooltip names Melody & score and its record button and score box",
  ADVANCED_ADDS.create.some((r) => /^Melody & score\b/.test(r.say) && ["yMusicPlan", "humRec", "yAbc"].every((id) => r.ids.includes(id)))
  && /Melody &amp; score/.test(HTML));

/* ...AND IS ONE SIMPLE REALLY HIDES. Pictures and Video share one rule
 * (web/styles.css: `.assist-on > :not(...)`), whose :not() list is what Simple
 * keeps on screen. A promised id that is one of those, or sits inside one, is
 * a tooltip promising something the person can already see: the character
 * picker in the reference box was. Read from the rule itself. */
const STYLES = read("web/styles.css");
const keepRule = /\.assist-on > ((?::not\([^)]+\))+) \{ display: none !important; \}/.exec(STYLES)?.[1] || "";
const keeps = [...keepRule.matchAll(/:not\(([#.])([\w-]+)\)/g)].map((m) => ({ by: m[1] === "#" ? "id" : "class", name: m[2] }));
/** The HTML of every element the predicate picks, open tag to its close. */
function spans(pick) {
  const out = [];
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(HTML))) {
    if (!pick(m[2])) continue;
    const tag = m[1].toLowerCase();
    const open = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "gi");
    open.lastIndex = m.index + m[0].length;
    let depth = 1, t;
    while (depth && (t = open.exec(HTML))) depth += t[0].startsWith("</") ? -1 : 1;
    out.push(HTML.slice(m.index, t ? t.index : HTML.length));
  }
  return out;
}
const kept = keeps.flatMap((k) => spans((attrs) => (k.by === "id"
  ? new RegExp(`\\bid="${k.name}"`).test(attrs)
  : new RegExp(`\\bclass="[^"]*\\b${k.name}\\b[^"]*"`).test(attrs))));
ok(`the Simple rule's keep-list was read (${keeps.length} kept, ${kept.length} elements)`, keeps.length >= 8 && kept.length >= 4,
  keeps.map((k) => k.name).join(","));
const shown = ["images", "video"].flatMap((v) => ADVANCED_ADDS[v].flatMap((r) => r.ids))
  .filter((id) => kept.some((s) => s.includes(`id="${id}"`)));
ok("no Pictures or Video tooltip promises a control Simple already shows", shown.length === 0, shown.join(", "));

/* ── 5. the first-run lines, judged by the real fit.js ─────────────────────── */
console.log("\nTHE FIRST-RUN LINES");
const { readMachine, fitFor, recommendFor } = await import(pathToFileURL(path.join(ROOT, "server", "fit.js")).href);
const { CATALOG } = await import(pathToFileURL(path.join(ROOT, "server", "models.js")).href);
const { firstRunLines } = await import(pathToFileURL(path.join(ROOT, "server", "welcome", "firstrun.js")).href);
const freshCaps = () => CATALOG.map((c) => ({
  id: c.id, makes: c.makes || null, label: c.label, licence: c.licence, outputRights: c.outputRights || null,
  region: c.region || null, gated: c.gated || null, requires: c.requires || null, required: !!c.required,
  needsPackage: c.needsPackage || null, packageReady: !c.needsPackage,
  files: (c.files || []).map((f) => ({ name: path.basename(f.dest), bytes: f.bytes, present: false })),
  totalBytes: (c.files || []).reduce((n, f) => n + f.bytes, 0) || c.approxBytes || 0, haveBytes: 0, ready: false,
}));
const { MODEL_TO_CAPABILITY } = await import(pathToFileURL(path.join(ROOT, "server", "models.js")).href);
const nv = (name, mb) => ({ name, totalMb: mb, usedMb: 0, vendor: "nvidia" });
const ram = (mb) => ({ totalMb: mb, usedMb: 0 });
/* Machines where the card, the RAM or the maker is what matters. The two with
 * 16 GB of RAM and a big enough card are the review's: the line used to blame
 * the card when RAM was short. */
const MACHINES = {
  "16 GB": readMachine(nv("NVIDIA GeForce RTX 4070 Ti SUPER", 16376), ram(32659)),
  "12 GB (the plan's persona)": readMachine(nv("NVIDIA GeForce RTX 4070", 12282), ram(32659)),
  "8 GB": readMachine(nv("NVIDIA GeForce RTX 3060 Ti", 8188), ram(32659)),
  "8 GB, 16 GB RAM": readMachine(nv("NVIDIA GeForce RTX 3060 Ti", 8188), ram(16310)),
  "12 GB, 16 GB RAM": readMachine(nv("NVIDIA GeForce RTX 4070", 12282), ram(16310)),
  "16 GB card, 16 GB RAM": readMachine(nv("NVIDIA GeForce RTX 4060 Ti", 16380), ram(16310)),
  "24 GB card, 16 GB RAM": readMachine(nv("NVIDIA GeForce RTX 4090", 24564), ram(16310)),
  "no card": readMachine(null, ram(32659)),
  "no card, 16 GB RAM": readMachine(null, ram(16310)),
  "AMD 16 GB": readMachine({ name: "AMD Radeon RX 9060 XT", totalMb: 16304, usedMb: 0, vendor: "amd" }, ram(32659)),
  /* The release critic's probe machines: a 6 GB card (the Video screen offers
   * it the experimental preview), a 32 GB laptop reading 31.4 GB and a 16 GB
   * machine reading 15.4 GB (h3tier.js ramBoxGb, the one RAM reader), and a
   * PC whose engine runs on the CPU (no card at all). */
  "6 GB": readMachine(nv("NVIDIA GeForce RTX 2060", 6144), ram(32659)),
  "12 GB laptop reading 31.4 GB": readMachine(nv("NVIDIA GeForce RTX 4070 Laptop GPU", 12282), ram(Math.round(31.4 * 1024))),
  "12 GB, reading 15.4 GB of RAM": readMachine(nv("NVIDIA GeForce RTX 4070", 12282), ram(Math.round(15.4 * 1024))),
  "no card, CPU engine": readMachine(null, ram(32659), { cpuOnly: true }),
};
const linesFor = (machine) => {
  const capabilities = freshCaps().map((c) => ({ ...c, fit: fitFor(c.requires, machine) }));
  const models = { machine, capabilities, recommended: recommendFor({ capabilities, machine, disk: { freeBytes: 900e9 } }) };
  return { models, capabilities, r: firstRunLines(models) };
};
for (const [name, machine] of Object.entries(MACHINES)) {
  const { models, capabilities, r } = linesFor(machine);
  const all = r.lines.join(" ");
  const videoPick = models.recommended.picks.find((p) => p.slot === "video");
  const music = models.recommended.picks.find((p) => p.slot === "music");
  /* The video line carries the what-instead order (friend, own key, Reactive),
   * so it is allowed more room than the other two. */
  ok(`${name}: three lines, plain words (${r.lines.length})`,
    r.lines.length === 3 && !/_|undefined|null|NaN|\[object/.test(all)
    && r.lines.every((l, i) => l.length <= (i === 2 ? 300 : 260) && /\.$/.test(l)),
    r.lines.join(" | "));
  ok(`${name}: the first line names what was read`,
    machine.gpu ? r.lines[0].includes(machine.gpu.name) && r.lines[0].includes(`${machine.gpu.vramGb} GB`)
      : machine.h3?.noCard ? /has no graphics card for Studio/.test(r.lines[0]) && /runs on the CPU/.test(r.lines[0]) && !/could not read/.test(r.lines[0])
      : /could not read a graphics card/.test(r.lines[0]),
    r.lines[0]);
  /* Decimal GB, as Models counts: never the GiB figure of the same bytes. */
  const musicCap = capabilities.find((c) => c.id === music?.id);
  if (music && !music.ready && !music.amdWarning && musicCap?.totalBytes) {
    const dec = `about ${(musicCap.totalBytes / 1e9).toFixed(1)} GB`;
    const gib = `${(musicCap.totalBytes / 1024 ** 3).toFixed(1)} GB`;
    ok(`${name}: download sizes are decimal GB with "about", as the Models screen counts (${dec})`,
      r.lines[1].includes(dec) && (gib === dec.slice(6) || !r.lines[1].includes(gib)), r.lines[1]);
  }
  ok(`${name}: the picture model is said as Studio's recommendation, not as what the screen runs`,
    /For pictures Studio recommends |No picture model clears/.test(r.lines[1]), r.lines[1]);
  if (music?.amdWarning) {
    const head = models.recommended.notes.find((n) => n.slot === "music-amd")?.headline || "(none)";
    ok(`${name}: the music line carries fit.js's AMD warning word for word, and names what works`,
      r.lines[1].startsWith(head) && /renders correctly on it/.test(r.lines[1]) && !/^Music on /.test(r.lines[1]), r.lines[1]);
  }
  if (videoPick) {
    ok(`${name}: the video line names the engine and its territory clause`,
      /^Video clips on /.test(r.lines[2]) && /leaves out some countries/.test(r.lines[2]), r.lines[2]);
    /* A size the tier table measured for this card (server/h3tier.js), which
     * the Video screen starts at: the line names it and says so. */
    if (videoPick.fit?.state === "smaller") {
      const h = videoPick.fit.h3 || {};
      ok(`${name}: a smaller card's line names the measured size and says the Video screen starts there`,
        r.lines[2].includes(`${h.width}x${h.height}`) && /the Video screen starts there/.test(r.lines[2]) && !/gets a smaller/.test(r.lines[2]), r.lines[2]);
    }
    if (machine.gpu?.vendor && machine.gpu.vendor !== "nvidia") {
      ok(`${name}: a card of a make nobody has rendered video on says "not yet tried"`, /not yet (been )?tried/.test(r.lines[2]), r.lines[2]);
    }
  } else {
    /* The engine the Video screen runs, judged by its own row. */
    const row = capabilities.find((c) => c.id === MODEL_TO_CAPABILITY[config.video.engine]);
    const f = row.fit;
    /* The H3 family is judged by its tier (h3tier.js), as the Video screen
     * judges it: a card on the preview tier is offered the preview there, so
     * the line says that instead of the row's printed minimum. */
    const preview = f.h3?.tier === "preview";
    const vramShort = machine.gpu && f.yourVramGb < f.needVramGb && !preview, ramShort = f.yourRamGb < f.needRamGb;
    if (preview) {
      ok(`${name}: a card on the preview tier is told what the Video screen offers it, not "needs an 8 GB card"`,
        /offered on this \d+ GB card only as an experimental \d+x\d+ preview/.test(r.lines[2]) && /the Video screen starts there/.test(r.lines[2])
        && !/needs an? \d+ GB card/.test(r.lines[2]), r.lines[2]);
    }
    if (machine.h3?.noCard) {
      ok(`${name}: no card at all is said as such, not "cannot tell"`,
        /no graphics card for MiniMax H3 to render on/.test(r.lines[2]) && !/cannot tell/.test(r.lines[2]), r.lines[2]);
    }
    ok(`${name}: no video pick, and the line names the half that falls short from the row's own numbers`,
      (!vramShort || r.lines[2].includes(`${f.needVramGb} GB card`))
      && (!ramShort || r.lines[2].includes(`${f.needRamGb} GB of RAM`))
      && (vramShort || !/card and this one has|bigger card/.test(r.lines[2]))
      && (vramShort || ramShort || /not yet|cannot tell|does not recommend|not recommended/.test(r.lines[2])),
      `${r.lines[2]}  [need ${f.needVramGb}/${f.needRamGb}, have ${f.yourVramGb}/${f.yourRamGb}]`);
    /* Offered, not recommended, because the RAM is under what the row
     * recommends (H3: the 32 GB the lab measured with): the RAM is named. */
    if (machine.gpu && !vramShort && !ramShort && f.state !== "unknown" && f.recommendable === false && f.yourRamGb < f.recRamGb) {
      ok(`${name}: offered but not recommended for its RAM, and the line says so from the row's numbers`,
        r.lines[2].includes(`not recommended with ${f.yourRamGb} GB of RAM`) && r.lines[2].includes(`${f.recRamGb} GB)`)
        && !/card and this one has|bigger card/.test(r.lines[2]), r.lines[2]);
    }
    /* The order every surface uses (server/cloud-switch.js NO_STRONG_CARD):
     * a friend first, then the person's own paid key; Reactive as a third,
     * free way. Nothing paid is offered before the friend. */
    const l3 = r.lines[2];
    const [iFriend, iKey, iReactive] = [l3.indexOf("a friend's card (Collab, free; built, not yet tried between two PCs)"),
      l3.indexOf("your own paid key (Settings)"), l3.indexOf("Reactive")];
    ok(`${name}: a friend's card first (Collab, untried between two PCs), your own paid key second, then Reactive`,
      iFriend > 0 && iKey > iFriend && iReactive > iKey
      && r.links[0]?.view === "collab" && r.links[1]?.view === "settings" && r.links[2]?.view === "reactive"
      && !/credit|\$/i.test(all), l3);
  }
  ok(`${name}: the links go to screens that exist`,
    r.links.every((k) => HTML.includes(`data-view="${k.view}"`)), JSON.stringify(r.links));
}
/* THE RELEASE CRITIC'S EDGES, judged the same way as the launcher and the
 * Video screen: one RAM reader (h3tier.js ramBoxGb), and a fresh install's
 * music line never names MiniMax Music 3. */
{
  const laptop = linesFor(MACHINES["12 GB laptop reading 31.4 GB"]);
  ok("a 32 GB laptop reading 31.4 GB is a 32 GB machine here, and H3 is recommended as on the launcher",
    MACHINES["12 GB laptop reading 31.4 GB"].ram.totalGb === 32 && /^Video clips on MiniMax H3/.test(laptop.r.lines[2]), laptop.r.lines[2]);
  /* AMD (release critic): the download is the int8 build, unmeasured on AMD;
   * the music line says so beside it. */
  const amdLines = linesFor(MACHINES["AMD 16 GB"]);
  ok("AMD: the music line names the YuE2 download and says it is not yet measured on AMD cards",
    /^Music on YuE2 3B for ComfyUI once you get it \(about [\d.]+ GB\); the build it fetches is not yet measured on AMD cards\./.test(amdLines.r.lines[1]),
    amdLines.r.lines[1]);
  const low = linesFor(MACHINES["12 GB, reading 15.4 GB of RAM"]);
  ok("a 16 GB machine reading 15.4 GB clears the 16 GB floor (offered, not recommended), and FLUX.2 klein stays the picture pick",
    MACHINES["12 GB, reading 15.4 GB of RAM"].ram.totalGb === 16 && /not recommended with 16 GB of RAM/.test(low.r.lines[2])
    && /FLUX\.2 klein/.test(low.r.lines[1]) && !/below its minimum/.test(low.r.lines[1]), low.r.lines.join(" | "));
  for (const [name, machine] of Object.entries(MACHINES)) {
    const { r, models } = linesFor(machine);
    const music = models.recommended.picks.find((p) => p.slot === "music");
    ok(`${name}: a fresh install's music line is Studio's pick, never MiniMax Music 3`,
      !/MiniMax Music 3/.test(r.lines[1]) && music?.chosenBy === "machine" && !/your selected/.test(music?.why || ""), r.lines[1]);
  }
}
/* The plan's own persona (12 GB, 32 GB of RAM). The lab measured H3 at full
 * quality under a 12 GB cap; whether Home says so is the H3 row's verdict
 * (models.js / fit.js, and server/h3tier.js once the tier lane lands), never a
 * second judgement here. So: the line follows that row, whichever way it goes. */
{
  const m12 = MACHINES["12 GB (the plan's persona)"];
  const { capabilities, r, models } = linesFor(m12);
  const h3 = capabilities.find((c) => c.id === MODEL_TO_CAPABILITY.h3);
  const picked = models.recommended.picks.some((p) => p.slot === "video");
  ok("12 GB: the video line follows the H3 row's own verdict (a floor it quotes, or a pick it names)",
    picked ? /^Video clips on MiniMax H3/.test(r.lines[2])
      : h3.fit.state === "wont-run" && r.lines[2].includes(`needs a ${h3.fit.needVramGb} GB card and this one has 12 GB`),
    `${h3.fit.state}: ${r.lines[2]}`);
}
/* Music only: no Video, Collab or Reactive in that rail, so no video line. */
{
  const was = config.musicOnly;
  config.musicOnly = true;
  try {
    const { r } = linesFor(MACHINES["16 GB"]);
    ok("Music only: two lines, no video line and no Collab link (none of those screens is in its rail)",
      r.lines.length === 2 && !/Video clips|Collab/.test(r.lines.join(" ")) && !r.links.some((k) => k.view === "collab"),
      r.lines.join(" | "));
  } finally { config.musicOnly = was; }
}
ok("a machine Studio could not read says so rather than guessing",
  /could not read this PC/.test(firstRunLines({ unavailable: "timeout", capabilities: [] }).lines[0]));
const W = read("web/welcome.js");
ok("the tour no longer opens by itself: Home gets the lines, the tour is under About",
  !/openWelcome\(\{ auto: true \}\)/.test(W) && /if \(autoOpen && r\.firstRun\) paintFirstRun\(\);/.test(W)
  && /post\(\{ action: "first_run" \}\)/.test(W) && HTML.includes('id="welcomeOpen"') && /Take the welcome tour/.test(HTML)
  && /<div class="homestrip" id="homeStrip" hidden/.test(HTML));
const CAT = read("server/welcome/catalogue.js");
ok("the catalogue no longer calls Chat the screen the app opens on", !/The screen the app opens on/.test(CAT));
ok("...and the Video card names every engine that excludes territories, not \"one of them\"",
  !/one of them excludes whole territories/.test(CAT) && /REGION_LOCKED_VIDEO/.test(CAT));

/* ── 6. the rail ───────────────────────────────────────────────────────────── */
console.log("\nTHE RAIL");
const between = (a, b) => { const i = HTML.indexOf(a); return i < 0 ? "" : HTML.slice(i, HTML.indexOf(b, i)); };
const make = between('<div class="navgroup navmake">', "</div>\n      <details");
const more = between('<details class="navgroup navmore" id="navMore">', "</details>");
const bottom = between('<div class="nav navbottom">', "</div>");
const views = (s) => [...s.matchAll(/data-(?:view|page)="([a-z]+)"/g)].map((m) => m[1]);
ok("Make holds Music, Pictures, Video and Music video, in that order (Comfy API rides along, hidden)",
  views(make).join(",") === "create,router,images,video,workflow", views(make).join(","));
ok("...labelled as a newcomer says them",
  /data-view="home" title="Home"><i>[^<]*<\/i><span class="lbl">Home</.test(HTML)
  && /data-view="images" title="Pictures"><i>[^<]*<\/i><span class="lbl">Pictures</.test(make)
  && /data-view="workflow" title="Music video"><i>[^<]*<\/i><span class="lbl">Music video</.test(make));
ok("More tools folds every other screen",
  views(more).join(",") === "chat,musiclab,vfx,avatars,studio,daw,reactive,training,collab,overnight,community,radio,blog,games,engine",
  views(more).join(","));
ok("Models and Settings are pinned in the bottom block, never below the fold",
  views(bottom).includes("models") && views(bottom).includes("settings"), views(bottom).join(","));
const railViews = views(between('<nav class="rail">', "</nav>"));
ok("no screen is in the rail twice", new Set(railViews).size === railViews.length, railViews.join(","));
const RAIL = read("web/rail.js");
ok("open or folded is remembered per viewer, in try/catch",
  /const KEY = "aiplayRailMore";/.test(RAIL) && /try \{ more\.open = localStorage\.getItem\(KEY\) === "1"; \} catch/.test(RAIL)
  && /try \{ localStorage\.setItem\(KEY, more\.open \? "1" : "0"\); \} catch/.test(RAIL)
  && /<script type="module" src="rail\.js"><\/script>/.test(HTML));
/* The fold's tooltip, run against a stub fold: only the links a launcher mode
 * left visible (Music only hides all but Community), rebuilt when one hides. */
{
  const link = (lbl, hidden = false, display = "") => ({ hidden, style: { display }, querySelector: () => ({ textContent: lbl }) });
  const links = [link("Chat"), link("Radio", true), link("Games", false, "none"), link("Community")];
  const summary = { title: "" };
  let observer = null;
  const more = {
    open: false, addEventListener() {},
    querySelector: (sel) => (sel === "summary" ? summary : null),
    querySelectorAll: (sel) => (sel === "a" ? links : []),
  };
  globalThis.document = { readyState: "complete", getElementById: (id) => (id === "navMore" ? more : null) };
  globalThis.MutationObserver = class { constructor(fn) { observer = fn; } observe() {} };
  await import(`${pathToFileURL(path.join(ROOT, "web", "rail.js")).href}?stub`);
  const first = summary.title;
  links[0].style.display = "none";
  observer?.();
  ok("the More tools tooltip names only the visible links, and follows a link that is hidden later",
    first === "More tools: Chat, Community" && summary.title === "More tools: Community", `${first} → ${summary.title}`);
  delete globalThis.document;
  delete globalThis.MutationObserver;
}

/* ── 7. the phone ──────────────────────────────────────────────────────────── */
console.log("\nTHE PHONE");
const CSS = read("web/shell.css");
const phone = /@media \(max-width: 767px\) \{([\s\S]*)\n\}/.exec(CSS)?.[1] || "";
ok("a media rule below 768 px exists", !!phone.trim());
ok("...stacking the form above the library, one column",
  /grid-template-columns: minmax\(0, 1fr\);/.test(phone) && /grid-template-areas: "create" "stage" "player";/.test(phone));
ok("...turning the rail into a bar of icons",
  /\.rail \{[^}]*position: fixed;[^}]*flex-direction: row;/.test(phone) && /\.shell \.rail \.nav a \.lbl/.test(phone));
ok("...and the page scrolls as one instead of each column", /body \{ overflow: auto; \}/.test(phone));
ok("web/shell.css loads after styles.css, so it can re-lay the grid",
  HTML.indexOf('href="shell.css"') > HTML.indexOf('href="styles.css"') && HTML.indexOf('href="shell.css"') > HTML.indexOf('href="agent.css"'));
const colours = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(#[0-9a-fA-F]{3,8}\b|hsla?\(|rgba?\()/g)].map((m) => m[1]);
ok("web/shell.css spells no colour of its own", colours.length === 0, colours.join(", "));

/* ── 8. plain words for a run ──────────────────────────────────────────────── */
console.log("\nPLAIN WORDS");
const { runWords } = await import(pathToFileURL(path.join(ROOT, "web", "runwords.js")).href);
const tools = new Set();
for (const rel of ["server/mv/routes.js", "server/mv/generate.js", "server/mv/blender.js", "server/mv/control.js",
  "server/mv/previz.js", "server/mv/bible.js", "server/mv/planrun.js", "server/mv/audiobook.js", "server/mv/sfxcue.js",
  "server/mesh/asset.js"]) {
  const src = read(rel);
  for (const m of src.matchAll(/noteRun\([^)]*?\{\s*(?:\/\*[\s\S]*?\*\/\s*)?tool:\s*"([a-z0-9_]+)"/g)) tools.add(m[1]);
}
ok(`the run census found the music-video runs (${tools.size})`, tools.size >= 20 && tools.has("generate_clip"), [...tools].join(", "));
const snake = [...tools].filter((t) => /_/.test(runWords({ tool: t, outcome: "" }).text));
ok("every run the Activity feed can show reads as words, not snake_case", snake.length === 0, snake.join(", "));
const clip = runWords({ tool: "generate_clip", outcome: "scene 12 → clip_0012.mp4 (seed 7, h3, 2 refs)" });
ok('"generate_clip" reads "Rendered scene 12", and the tool name moves into the tooltip',
  clip.text === "Rendered scene 12" && clip.title === "generate_clip", JSON.stringify(clip));
const DAWH = read("web/daw.html"), DAWJ = read("web/daw.js");
ok("the DAW's help keeps tool names in tooltips only",
  !/title="set_length"/.test(DAWH) && !/status\(`set_view:/.test(DAWJ));
const toolStatus = [...DAWJ.matchAll(/status\(`([a-z]+_[a-z_]+)[: ]/g)].map((m) => m[1]);
ok("...and no DAW status line opens with a tool name (record_stop, record_notes were the last)",
  toolStatus.length === 0, toolStatus.join(", "));

/* ── 9. the Make buttons make (B3) ─────────────────────────────────────────── */
console.log("\nTHE MAKE BUTTONS");
const { writerFrom, notYetLine } = await import(pathToFileURL(path.join(ROOT, "web", "writer.js")).href);
ok("a writing model is yes, no or NOT KNOWN: an engine still starting is never taken for \"none\"",
  writerFrom({ models: [{ file: "qwen_3_4b.safetensors" }] }) === true
  && writerFrom({ models: [{ file: "api:anthropic" }], offline: true }) === true   // a connected key answers without the engine
  && writerFrom({ models: [], offline: true }) === null
  && writerFrom(null) === null
  && writerFrom({ models: [] }) === false);
ok("...and the not-yet line names the button and sends nothing", /Press Make clip again/.test(notYetLine("starting", "Make clip")));
const CHAT = read("web/chat.js");
ok("Music: the answer is read again at every press until it is yes, and not-known waits instead of skipping the assistant",
  /if \(SIMPLE_WRITER !== true\) await loadSimpleModels\(\);/.test(CHAT) && /SIMPLE_WRITER = writerFrom\(d\);/.test(CHAT)
  && /if \(why\.kind !== "noengine"\) return simpleRow\("note", esc\(notYetLine\(why\.kind, "Make song"\)\)\);/.test(CHAT));
ok("Pictures and Video: the same, per panel",
  /if \(writer !== true\) await loadModels\(\);/.test(ASSIST) && /writer = writerFrom\(d\);/.test(ASSIST)
  && /if \(why\.kind !== "noengine"\) return row\("note", esc\(notYetLine\(why\.kind, P\.make\)\)\);/.test(ASSIST));
ok("with a writing model, pressing Make is the go-ahead: a reply that set the form up and did not start it is followed by the real button",
  /return simpleSend\(v, \{ make: true \}\);/.test(CHAT)
  && /if \(turn\?\.make && turn\.wrote && !turn\.started && !turn\.proposed && !turn\.failed && !turn\.stopped\) \{\s*simpleRow\("note", "You pressed Make song, so Studio pressed Create\."\);\s*document\.dispatchEvent\(new CustomEvent\("aiplay:simple-generate"\)\);/.test(CHAT)
  && /return ask\(v, \{ make: true \}\);/.test(ASSIST)
  && /if \(t\?\.make && t\.set && !t\.started && !t\.proposed && !t\.failed && !t\.stopped\) \{[\s\S]*?await pressMake\(kind\);/.test(ASSIST));
ok("with no writing model, typed words are never dropped for the form's song: it is offered, and the words stay",
  /if \(song && !String\(typed \|\| ""\)\.trim\(\)\) return simpleMakeForm\(\);/.test(CHAT)
  && /data-simple-form>Make the song already in the form<\/a> instead/.test(CHAT)
  && /if \(e\.target\.closest\?\.\("\[data-simple-form\]"\)\) \{ e\.preventDefault\(\); simpleMakeForm\(\); \}/.test(CHAT));
ok("Music only's no-writer line points at the Agent page's key, not at a Models row it does not have",
  /musicOnly\s*\n?\s*\? 'or connect an API key on the <a href="#" data-go="mcp">Agent<\/a> page'/.test(CHAT));
ok("one label for the one action: the confirm button says Make song too",
  /<button class="btn sm" type="button" id="simpleYes">Make song<\/button>/.test(HTML));

await rm(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
