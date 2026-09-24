/**
 * The page kit (web/ui.css, web/ui.js, docs/UI_GUIDE.md): the pages that use
 * it, the pills it builds, and the pointers that make agents read the guide.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source assertions describe lines, independent of the checkout's EOL setting.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const HTML = read("web/index.html");
const APP = read("web/app.js");

test("the index loads the kit's stylesheet and script", () => {
  assert.match(HTML, /href="ui\.css"/);
  assert.match(HTML, /src="ui\.js"/);
});

test("Settings, About, Engine and Music Lab are kit pages with a pill bar", () => {
  for (const id of ["settings", "about", "engine", "musicWorkflows"]) {
    const at = HTML.indexOf(`<div id="${id}" hidden class="page`);
    assert.ok(at > 0, `${id} is a .page (and keeps "hidden" before "class")`);
    const next = HTML.indexOf("\n    <div id=", at + 10);
    const body = HTML.slice(at, next > 0 ? next : undefined);
    if (id !== "musicWorkflows") assert.match(body, /<nav class="pnav"/, `${id} has a pill bar`);
  }
});

test("every section that asks for a pill has an id, and ids are unique", () => {
  const cards = [...HTML.matchAll(/<section class="pcard"([^>]*)>/g)].map((m) => m[1]);
  assert.ok(cards.length >= 25, `found ${cards.length} cards`);
  const ids = [];
  for (const attrs of cards) {
    if (!/data-nav="/.test(attrs)) continue;
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    assert.ok(id, `a pcard with data-nav has no id: ${attrs}`);
    ids.push(id);
  }
  assert.equal(new Set(ids).size, ids.length, "duplicate pcard ids");
});

test("Music Lab is a rail page, not a dialog behind a button", () => {
  assert.match(HTML, /data-view="musiclab"/);
  assert.doesNotMatch(HTML, /<dialog id="musicWorkflows"/);
  assert.doesNotMatch(HTML, /id="musicWorkflowsOpen"/);
  assert.match(APP, /\$\("musicWorkflows"\)\.hidden = name !== "musiclab"/);
  assert.match(APP, /musiclab: "#musicWorkflows"/);
});

test("Qwen readiness is a light in the engine dropdown, details in a pop-out", () => {
  assert.match(HTML, /<span class="pv qwenpv"><span class="qdot" id="imgQwenDot" hidden><i><\/i><\/span><select id="imgEngine"/);
  assert.match(APP, /dot\.dataset\.tip = tone === "busy"/, "hovering the light says what it is doing");
  assert.match(APP, /sel\.showPicker\(\)/, "a click on the light still opens the dropdown");
  assert.match(HTML, /<div class="qpop" id="imgQwenStatus" hidden role="alert">/);
  assert.match(read("web/ui.css"), /\.qwenpv\.qok\.qsettled \.qdot \{ right: 26px; \}/, "ready: the light steps left after 2 s");
  assert.match(APP, /setTimeout\(\(\) => pv\.classList\.add\("qsettled"\), 2000\)/);
  assert.match(HTML, /id="imgQwenChip"/);
  assert.doesNotMatch(HTML, /id="imgQwenOptionsNote"/);
  assert.match(APP, /function imgQwenPaint\(/);
});

test("agents are pointed at the UI guide", () => {
  const guide = read("docs/UI_GUIDE.md");
  assert.match(guide, /Text budget/);
  // CLAUDE.md is gitignored, so the tracked pointers are these two.
  assert.match(read("AGENTS.md"), /docs\/UI_GUIDE\.md/);
  assert.match(read("README.md"), /docs\/UI_GUIDE\.md/);
});

test("Images and Video take pictures through the drop box", () => {
  for (const id of ["imgRefDrop", "vidFromDrop", "vidToDrop", "vidMidDrop", "vidRefDrop"]) {
    assert.match(HTML, new RegExp(`id="${id}"`), `${id} host`);
  }
  assert.match(APP, /import \{ mountPicDrop, urlToFile, dropAnywhere \} from "\.\/picdrop\.js"/);
  for (const slot of ["from", "to", "mid", "ref", "img"]) assert.ok(APP.includes(`picDrops.${slot} = mountPicDrop(`), slot);
  // Gallery pictures can be dragged, and say what they are.
  assert.match(APP, /draggable="true" data-picdrag=/);
});

test("no 'Tick … to act on several at once' prompt on any gallery", () => {
  assert.doesNotMatch(APP, /to act on several at once/);
});

test("the visualiser drives the player bar only (plus the playing row and player art in CSS)", () => {
  const claim = /function visClaim\(\) \{[\s\S]*?\n\}/.exec(APP)?.[0] || "";
  assert.match(claim, /\.player/);
  assert.doesNotMatch(claim, /railfoot|details\.adv|"\.cta"/);
  assert.doesNotMatch(read("web/styles.css"), /scrollbar-thumb \{[^}]*--vz-all/);
});

test("a clip poster that fails falls back instead of showing a broken image", () => {
  assert.match(APP, /\$\("clipGrid"\)\.addEventListener\("error",/);
  assert.match(read("web/galleries.css"), /\.cthumb\.cth-none/);
});

test("the whole app tells the browser it is dark, not just the 3D page", () => {
  /* Only avatars.css declared it, and only avatars.html loads that sheet, so
   * every other screen drew native inputs, buttons and <audio> players white.
   * styles.css is the sheet index.html and daw.html share. */
  const root = /^:root \{([\s\S]*?)\n\}/m.exec(read("web/styles.css"))?.[1] || "";
  assert.match(root, /\n\s*color-scheme: dark;/, "styles.css :root declares color-scheme: dark");
  assert.match(HTML, /<link rel="stylesheet" href="styles\.css/, "and the index loads that sheet");
});

test("the covers engine picker is the Images engine list, and that list is the server's", async () => {
  /* Settings' covers dropdown was a hand-typed second list that lacked
   * qwen-image-2.1, the shipped default, so it showed blank. Now it is copied
   * from #imgEngine before loadArtPrefs sets its value, and #imgEngine is held
   * to the whitelist config.js accepts, so an engine added there cannot go
   * missing from either picker without failing here. The route that saves the
   * choice and the agent tool that sets it each keep their own copy of that
   * list, so they are held to it as well: an engine the dropdown offers and
   * the route refuses fails Save with "engine must be ...". */
  assert.match(HTML, /<select id="artEngine" class="sel2"><\/select>/, "no hand-typed options left to drift");
  const load = /async function loadArtPrefs\(\) \{[\s\S]*?\n\}/.exec(APP)?.[0] || "";
  const fill = load.indexOf('$("artEngine").replaceChildren(...[...$("imgEngine").options].map((o) => new Option(o.dataset.cover || o.textContent, o.value)));');
  assert.ok(fill > 0, "loadArtPrefs copies #imgEngine's options into #artEngine");
  assert.ok(fill < load.indexOf('$("artEngine").value ='), "...before it sets the saved engine");
  const sel = /<select id="imgEngine"[^>]*>([\s\S]*?)<\/select>/.exec(HTML)?.[1] || "";
  const offered = [...sel.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]).sort();
  const names = (literal) => literal.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean).sort();
  // The same literal provenance_test.js reads; config.js says so above it.
  const accepted = names(/\["art",\s*"engine",\s*\(v\)\s*=>\s*\[([^\]]*)\]/.exec(read("server/config.js"))?.[1] || "");
  assert.ok(accepted.includes("qwen-image-2.1") && accepted.length >= 8, `config.js whitelist read: ${accepted.join(", ")}`);
  assert.deepEqual(offered, accepted, "#imgEngine offers exactly the engines config.js accepts for art");
  const route = /p === "\/api\/artconfig" && req\.method === "POST"[\s\S]*?if \(!\[([^\]]*)\]\.includes\(b\.engine\)\)/.exec(read("server/index.js"))?.[1] || "";
  assert.deepEqual(names(route), accepted, "POST /api/artconfig accepts exactly the engines config.js does");
  const { TOOLS } = await import("./mcp.js");
  const tool = [...(TOOLS.find((t) => t.name === "set_image_engine")?.inputSchema?.properties?.engine?.enum || [])].sort();
  // "auto" is not an engine: it forgets the choice (Settings' "Let Studio pick").
  assert.ok(tool.includes("auto"), "set_image_engine can hand the choice back to Studio");
  assert.deepEqual(tool.filter((e) => e !== "auto"), accepted, "set_image_engine offers exactly the engines config.js accepts");
});

test("the engine labels have no em dash, and the covers copy claims nothing a cover lacks", () => {
  /* docs/UI_GUIDE.md rule 4: no em dashes on screen. And #imgEngine's labels
   * describe the Images screen, where FLUX.2 takes references and Qwen edits.
   * A cover does neither and has no negative field, so the label the covers
   * dropdown shows (data-cover where there is one, else the text) must not
   * say it does. */
  const sel = /<select id="imgEngine"[^>]*>([\s\S]*?)<\/select>/.exec(HTML)?.[1] || "";
  const opts = [...sel.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)<\/option>/g)]
    .map(([, value, attrs, text]) => ({ value, text, cover: /\bdata-cover="([^"]*)"/.exec(attrs)?.[1] ?? text }));
  assert.ok(opts.length >= 8, `read ${opts.length} options`);
  for (const o of opts) {
    assert.doesNotMatch(`${o.text} ${o.cover}`, /—/, `${o.value}: no em dash in its labels`);
    assert.doesNotMatch(o.cover, /\b(refs?|references?|edit(s|ing)?|negatives?)\b/i,
      `${o.value}'s covers label "${o.cover}" claims something covers do not do`);
  }
});

test("a picture dropped anywhere on the Images or Video panel is taken, Simple mode included", () => {
  assert.ok(APP.includes('dropAnywhere($("imgPanel"), () => picDrops.img)'));
  assert.ok(APP.includes('dropAnywhere($("vidPanel"), () => picDrops.from)'));
  const css = read("web/styles.css");
  assert.match(css, /\.assist-on > [^{]*:not\(#vidFromField\):not\(#imgRefWrap\)[^{]* \{ display: none !important; \}/,
    "Simple mode keeps the reference field and the starting frame visible");
});

test("the reference strip's hidden is what opens the drop box, so imgRefsPaint sets it", () => {
  const paint = /function imgRefsPaint\(\) \{[\s\S]*?\n\}/.exec(APP)?.[0] || "";
  assert.match(paint, /prev\.hidden = !n;/,
    "picdrop opens the zone on !strip.hidden && strip.children.length; a class instead leaves it hidden for ever");
  assert.doesNotMatch(paint, /classList\.toggle\("isempty"/);
  assert.match(paint, /imgRefHoverHide\(\);/, "the hover preview outlives the figure it points at otherwise");
  assert.match(APP, /function imgRefHoverHide\(\)/);
});

test("Qwen readiness is keyed on whether there are references, not how many", () => {
  const query = /function imgQwenQuery\(\) \{[\s\S]*?\n\}/.exec(APP)?.[0] || "";
  assert.match(query, /refs: refs \? "1" : "0"/, "a real count re-checks on every drop");
  assert.match(APP, /function imgQwenCheckSoon\(\)/, "repaints coalesce into one check");
  assert.match(APP, /imgQwenRequestedKey !== imgQwenQuery\(\)\.toString\(\)\) imgQwenCheckSoon\(\)/);
  // The light waits before it spins, so a fast local answer does not flicker.
  assert.match(APP, /const spin = setTimeout\(\(\) => imgQwenPaint\("busy"/);
  assert.match(APP, /if \(same === imgQwenPainted\) return;/, "saying the same thing again restarts the pulse");
});

test("'don't record the prompt' sits with the Make button, not in the reference block", () => {
  const wrap = HTML.slice(HTML.indexOf('<div class="field" id="imgRefWrap">'), HTML.indexOf('id="imgRefEngineNote"'));
  assert.doesNotMatch(wrap, /id="imgPrivate"/, "it is not a property of the references, and it pushed the drop box down");
  const cta = HTML.slice(HTML.indexOf('<button class="btn primary wide" type="button" id="imgGo">'));
  assert.match(cta.slice(0, 1600), /class="tog ctatog"[\s\S]*id="imgPrivate"/);
  // One line with the detail in the tooltip, not a paragraph under the tick.
  assert.doesNotMatch(HTML, /id="imgPrivateNote"/);
  assert.match(read("web/ui.css"), /\.ctatog \{/);
  assert.match(APP, /private: \$\("imgPrivate"\)\.checked/);
});

test("the seed is random by default on every screen", () => {
  // Music: it shipped locked on a fixed number, so the same words gave the
  // identical song for ever and a second Create looked like it had done nothing.
  assert.match(APP, /seedLocked: false,/, "Music's seed starts unlocked");
  assert.match(APP, /if \(!state\.seedLocked\) \$\("seed"\)\.value = Math\.floor\(Math\.random\(\)/,
    "and the number in the box is rolled at boot, not shipped in the markup");
  const row = /<div class="seedrow">[\s\S]*?<\/div>/.exec(HTML)?.[0] || "";
  assert.match(row, /id="seed" inputmode="numeric" placeholder="random"/, "no fixed seed in the markup");
  assert.match(row, /class="seedbtn" type="button" id="seedLock">lock</, "lock is the off state");
  assert.match(row, /class="seedbtn on" type="button" id="seedRand">random</, "random is lit");
  // Images and Video send nothing and let the server roll one; an empty box
  // with this placeholder is what makes that happen.
  assert.match(HTML, /id="vidSeed" inputmode="numeric" placeholder="random"/);
  assert.match(HTML, /id="imgSeed" type="number" class="sel2 sm" placeholder="random"/);
  /* `\\s`, not `\s`: inside a template literal `\s` is a plain "s", and the
   * pattern then needed the text `svalue="`, so a planted value="5" passed. */
  for (const id of ["imgSeed", "vidSeed"]) {
    assert.doesNotMatch(HTML, new RegExp(`id="${id}"[^>]*\\svalue="`), `${id} must ship empty`);
  }
});

test("the player bar stops at the rail, and leaves when there is nothing to play", () => {
  const css = read("web/styles.css");
  // It used to span every column, so it ran under the quick-access rail: the
  // bottom of the rail was covered and everything in it was pushed up.
  assert.doesNotMatch(css, /grid-template-areas:[^;]*"player player player"/);
  for (const areas of ['"rail create stage" "rail player player"',
                       '"rail stage" "rail player"',
                       '"rail create" "rail stage" "rail player"']) {
    assert.ok(css.includes(`grid-template-areas: ${areas}`), areas);
  }
  // One number for its height, and it is 0 while the bar is closed.
  assert.match(css, /\.shell \{[\s\S]{0,400}--playerh: 0px;/);
  assert.match(css, /\.shell\.hasplayer \{ --playerh: \d+px; \}/);
  assert.doesNotMatch(css, /bottom: 64px|inset: 0 0 64px 0/);
  assert.match(css, /bottom: var\(--playerh, 0px\)/);
  assert.match(css, /inset: 0 0 var\(--playerh, 0px\) 0/);
  // ✕ at one end, the full-player arrow at the other, transport in between.
  const bar = /<div class="player">[\s\S]*?\n  <\/div>/.exec(HTML)?.[0] || "";
  assert.ok(bar, "the player bar");
  assert.ok(bar.indexOf('id="pClose"') < bar.indexOf('id="pArt"'), "✕ is at the far left");
  assert.ok(bar.indexOf('id="pExpand"') > bar.indexOf('id="pVol"'), "the arrow is at the far right");
  // Added on play and never removed was the bug: one song left the bar all day.
  assert.match(APP, /function playerClose\(\) \{[\s\S]*?classList\.remove\("hasplayer"\)/);
  assert.match(APP, /\$\("pClose"\)\.onclick = playerClose;/);
  assert.match(APP, /setTimeout\(\(\) => \{ if \(audio\.ended\) playerClose\(\); \}/,
    "the end of the queue closes it, but autoplay's next track keeps it");
});

test("Create is one button with its other ways to render folded into it", () => {
  // Preview was a second button of the same size beside Create, which it is not.
  assert.match(HTML, /<div class="ctasplit solo" id="ctaSplit">[\s\S]*?id="btnCreate"[\s\S]*?id="ctaMore"[\s\S]*?id="ctaDrawer"[\s\S]*?id="btnPreview"/);
  assert.match(APP, /function ctaDrawer\(open\)/);
  assert.match(APP, /\$\("btnPreview"\)\.onclick = \(\) => \{ ctaDrawer\(false\); generate\(true\); \};/);
  // No cheap pass on this engine means no arrow, not a disabled one.
  assert.match(APP, /\$\("ctaSplit"\)\?\.classList\.toggle\("solo", only\);/);
  const css = read("web/ui.css");
  assert.match(css, /\.ctadrawer \{[\s\S]*?bottom: calc\(100% \+ 8px\)/, "the drawer opens upward");
  assert.match(css, /\.ctadrawer \.btn \{ flex: 0 0 auto;/, ".btn's own flex:1 would fill the drawer");
});

test("one box in the rail for what is being made, not two", () => {
  // A "working / <title> / Stop" panel at the top of the footer and a
  // "▶ song · <title> / 1 job remaining" panel at the bottom counted the same
  // queue in different words, and read as two queues.
  for (const gone of ["queueBox", "miniQ", "miniqNow", "miniqNext", "miniqTally", "qTotal", "qRows"]) {
    assert.doesNotMatch(HTML, new RegExp(`id="${gone}"`), gone);
    assert.doesNotMatch(APP, new RegExp(`\$\("${gone}"\)`), gone);
  }
  assert.doesNotMatch(APP, /paintMiniQueue/);
  const foot = /<div class="railfoot">[\s\S]*?<\/nav>/.exec(HTML)?.[0] || "";
  // Above the Ko-fi button, and the panel opens upward over the rail rather
  // than pushing its siblings around at the foot of the window.
  assert.ok(foot.indexOf('id="workBox"') < foot.indexOf('class="kofi"'), "above Support on Ko-fi");
  assert.ok(foot.indexOf('id="wbPanel"') < foot.indexOf('id="wbStrip"'), "the panel is above the strip");
  for (const id of ["wbState", "wbEta", "wbNow", "wbRest", "qStop", "wbStrip", "wbLine"]) {
    assert.match(foot, new RegExp(`id="${id}"`), id);
  }
  assert.match(foot, /class="qmore" data-go="jobs"/);
  const css = read("web/styles.css");
  // Fixed, not absolute: .rail is overflow:hidden and sliced the panel in half
  // once the rail was collapsed to 64px.
  assert.match(css, /\.workbox \.wbpanel\{position:fixed;width:210px/);
  assert.match(APP, /panel\.style\.bottom = `\$\{Math\.max\(8, window\.innerHeight - r\.top \+ 6\)\}px`;/,
    "placed against the strip");
  assert.match(css, /\.workbox:hover \.wbpanel/, "a glance is the point, so hover opens it");
  assert.match(css, /\.workbox \.wbpanel \.qstop,\.workbox \.wbpanel \.qmore,\.workbox \.wbpanel \.wbnow\{cursor:pointer\}/);
  assert.match(APP, /function wbLine\(what, right, busy\)/, "the strip's one line");
  assert.match(APP, /wbLine\("idle", today \? `\$\{today\} today` : "", false\);/);
  // The day's tally is counted from the files' own times, so it survives a restart.
  assert.match(APP, /function doneToday\(\)/);
  assert.match(APP, /count\(state\.library, "createdAt"\) \+ count\(state\.images, "at"\) \+ count\(state\.clips, "at"\)/);
});

test("the native GGUF engine does not claim its runtime and VRAM are unmeasurable", () => {
  // The phrase survives in the comment that explains why it went; what must
  // not survive is a setCta saying it to the user.
  for (const call of APP.match(/setCta\(`[^`]*`/g) || []) {
    assert.doesNotMatch(call, /not measured/, call);
  }
  // Every finished song records how long it took and how long it is.
  assert.match(APP, /function measuredRatio\(engine\)/);
  assert.match(APP, /t\.renderSeconds \/ t\.durationSeconds/);
  assert.match(APP, /const seen = measuredRatio\(state\.musicEngine\);/);
  assert.match(APP, /your first song sets the estimate for this card/);
});

test("pinning a song moves the list with the click, not with the reply", () => {
  assert.match(APP, /function flagNow\(file, flag, value\) \{[\s\S]*?reList\(\);[\s\S]*?trackAction\(/);
  assert.match(APP, /flagNow\(decodeURIComponent\(fl\.dataset\.f\), fl\.dataset\.flag, on\);/);
  assert.match(APP, /flagNow\(decodeURIComponent\(rt\.dataset\.f\), "rating", on \? 1 : 0\);/);
});

test("four meters in the rail: VRAM, RAM, disk and CPU", () => {
  const foot = /<div class="railfoot">[\s\S]*?<\/nav>/.exec(HTML)?.[0] || "";
  for (const id of ["gpuBox", "ramBox", "diskBox", "cpuBox"]) assert.match(foot, new RegExp(`id="${id}"`), id);
  // Disk: the bar is how full the drive is, the number is what the models cost,
  // and the tooltip says how many files that is.
  // The figures are written to fit half a rail; the long halves (free space,
  // drive fullness, core count) are in the tooltips. See the rail-width test.
  assert.match(APP, /\$\("diskText"\)\.textContent = `\$\{size\(d\.modelBytes\)\} models`;/);
  assert.match(APP, /model file\$\{d\.modelFiles === 1 \? "" : "s"\} on this disk/);
  // CPU: measured between polls, so "no reading yet" is null, not 0%.
  assert.match(APP, /pct == null \? `\$\{c\.cores\} cores`/);
  const gpu = read("server/gpu.js");
  assert.match(gpu, /export function cpuStatus\(\)/);
  assert.match(gpu, /percent: dTotal > 0 \? /, "differenced between calls, not totals since boot");
  const index = read("server/index.js");
  assert.match(index, /cpu: cpuStatus\(\),\s+disk: await modelsDisk\(\),/);
  assert.match(index, /if \(Date\.now\(\) - diskMark\.at < 60000\) return diskMark\.value;/,
    "/api/status is polled every few seconds; stat-ing the whole catalogue per poll is not free");
  assert.match(index, /seen\.set\(f\.dest, f\.present/, "a file two capabilities share is counted once");
});

test("the vendor credit is above the mark, and says why it is there", () => {
  // MiniMax-Music3 §3.1 / MiniMax H3 §IV.2: the name shown prominently in the
  // interface of a product using it. Above the logo is as prominent as this
  // window gets, and a name with no explanation invites the question.
  const rail = HTML.slice(HTML.indexOf('<nav class="rail">'), HTML.indexOf('<div class="nav navmain">'));
  assert.ok(rail.indexOf('id="attrib"') < rail.indexOf('<div class="brand">'), "above the mark");
  assert.match(rail, /<button class="poweredby" type="button" id="attrib" hidden/);
  assert.match(rail, /<b id="poweredName">MiniMax-Music3<\/b><i aria-hidden="true">\?<\/i>/,
    "the NAME is what the clause asks for; \"Powered by\" was two thirds of the line");
  assert.match(APP, /\$\("attrib"\)\.onclick = \(\) => \{/);
  assert.match(APP, /must show .MiniMax-Music3. prominently in its interface/);
  // Only the vendor whose licence asks: ACE-Step is MIT, YuE2 is CC BY-NC.
  // EVERY name owed, not the first: Music3 with H3 video on owes both, and
  // FastH3 carries H3's licence, so /h3/ and not /^h3/.
  assert.match(APP, /const minimaxVideo = state\.video\?\.enabled && \/h3\|minimax\/i\.test\(vid\);/);
  assert.match(APP, /const owed = \[\(!yueParams && !aceParams\) \? "MiniMax-Music3" : "", minimaxVideo \? "MiniMax H3" : ""\]\.filter\(Boolean\)\.join\(" · "\);/);
  assert.match(APP, /\$\("attrib"\)\.hidden = !owed;/);
  assert.match(APP, /if \(\/MiniMax-Music3\/\.test\(name\)\) clauses\.push\(/, "the dialog gives Music3's clause when its name is up");
  assert.match(APP, /if \(\/MiniMax H3\/\.test\(name\)\) clauses\.push\(/, "and H3's, both when both are");
  // "RUNNING LOCALLY" under a window full of locally running things said nothing.
  assert.doesNotMatch(HTML, /RUNNING LOCALLY/);
  assert.match(APP, /\$\("engineLineWrap"\)\.hidden = !line;/, "the engine line shows only when something is not ready");
});

test("the meters keep their fill bars but lose the blue rules between them", () => {
  const css = read("web/styles.css");
  for (const id of ["gpuFill", "ramFill", "diskFill", "cpuFill"]) {
    assert.match(HTML, new RegExp(`<i id="${id}">`), id);
    assert.match(APP, new RegExp(`\\$\\("${id}"\\)\\.style\\.width`), id);
  }
  // --edge is a translucent blue, so a border-top on every meter drew four blue
  // rules across the foot of the rail in among the four fill bars.
  assert.doesNotMatch(css, /^\.gpu \{[^}]*border-top/m, "no divider on every meter");
  assert.match(css, /\.meters \{ display: grid; grid-template-columns: 1fr 1fr;[\s\S]*?border-top: 1px solid var\(--edge\)/,
    "one hairline above the block, not one per meter, and two meters to a row");
  // Idle hides Stop, so without this the panel led nowhere at all.
  assert.match(HTML, /<div class="wbnow" id="wbNow" data-go="jobs"/);
  assert.match(css, /\.workbox\.resting \.qstop\{display:none\}/);
  assert.doesNotMatch(css, /\.workbox\.resting \.wbfoot\{display:none\}/, "'all jobs' stays when idle");
});

test("the note under every main button stays visible; the receipt carries the estimate", () => {
  const css = read("web/styles.css");
  /* UI_PLAN C2 undid the hover drop-up (d04ad3e): the estimate is what a
   * newcomer needs BEFORE pressing, not after hovering. The receipt line
   * (web/receipt.js) carries it, and the note steps aside only while it does. */
  assert.match(css, /\.ctanote, #imgPanel \.ctawrap > \.hint \{[\s\S]*?position: static;/);
  assert.doesNotMatch(css, /\.ctawrap:hover > \.ctanote/, "no hover-only estimate");
  assert.doesNotMatch(css, /\.ctanote, #imgPanel \.ctawrap > \.hint \{[^}]*opacity: 0/, "never invisible by default");
  assert.match(css, /\.ctawrap > \.ctanote\.rc-took:not\(\.stick\) \{ display: none; \}/, "a warning is never hidden");
  assert.match(css, /\.ctanote:empty, #imgPanel \.ctawrap > \.hint:empty \{ display: none; \}/);
  assert.match(css, /margin-top: auto; padding: 10px 0 6px;/, "the button sits closer to the bottom");
  assert.doesNotMatch(css, /#vidPanel \.ctawrap > \.ctanote \{ order: -1; \}/, "nothing left to order");
  assert.match(HTML, /<script type="module" src="receipt\.js"><\/script>/, "the receipt is loaded");
});

test("a warning or failure under a main button stays in place, not only under the pointer", () => {
  const css = read("web/styles.css");
  // A hover-only note hid "⚠ 'X' failed", the step-file warnings and "That
  // render failed." along with the estimates. .stick puts one back in the flow.
  assert.match(css, /\.ctawrap > \.ctanote\.stick, #imgPanel \.ctawrap > \.hint\.stick \{[^}]*position: static;[^}]*opacity: 1;/);
  // Music: the outcome warning sticks until the next estimate after a Create.
  assert.match(APP, /musicOutcomeMsg = msg; if \(\$\("ctaNote"\)\) \{ \$\("ctaNote"\)\.textContent = msg; \$\("ctaNote"\)\.classList\.add\("stick"\); \}/);
  assert.match(APP, /function setCta\(text\) \{\n\s+if \(!musicOutcomeMsg && \$\("ctaNote"\)\) \{ \$\("ctaNote"\)\.textContent = text; \$\("ctaNote"\)\.classList\.remove\("stick"\); \}/);
  // Video: a ⚠ in the estimate, or video switched off.
  assert.match(APP, /\$\("vidEst"\)\.classList\.toggle\("stick", !on \|\| \/⚠\/\.test\(\$\("vidEst"\)\.textContent\)\);/);
  // Images: failures and refusals stick, "Queued." and "Done." do not.
  assert.match(APP, /if \(imgFailed\) \{ \$\("imgNote"\)\.textContent = "That render failed\."; \$\("imgNote"\)\.classList\.add\("stick"\); \}/);
  assert.match(APP, /"Qwen Image 2\.1 is not ready\.[^"]*";\n\s+\$\("imgNote"\)\.classList\.add\("stick"\);/);
  assert.match(APP, /"Queued\. It renders when nothing else is using the GPU\.";\n\s+\$\("imgNote"\)\.classList\.remove\("stick"\);/);
  assert.match(read("docs/UI_GUIDE.md"), /A warning or failure is `\.stick` and stays in place/);
});

test("one Unload button, always visible, for every engine", () => {
  // It was two buttons on a list of three engines, coming and going as the
  // record changed; on anything else the bar was not there at all.
  const paint = /function paintModelLoad\(s\) \{[\s\S]*?\n\}/.exec(APP)?.[0] || "";
  assert.match(paint, /box\.hidden = false;/, "every engine, not a list of three");
  assert.match(paint, /\$\("btnModelLoad"\)\.hidden = true;/, "Load is hidden, not deleted");
  assert.match(paint, /unload\.disabled = busy \|\| !holding;/, "disabled, never absent");
  // ⚠ The half that made it look broken: a cover or clip unloads the music
  // model and puts its own on the card, so loadedModel goes null while
  // ComfyUI still holds several GB.
  assert.match(paint, /const holding = !!loaded \|\| !!s\.artResident;/);
  assert.match(read("server/jobs.js"), /artResident: this\.comfy\?\.ready \? !!this\.artResident : false,/);
  assert.match(HTML, /<button class="btn sm ghost" type="button" id="btnModelUnload">Unload<\/button>/,
    "no hidden attribute on the markup either");
  // Always shown now, so its words must hold for engines outside ComfyUI too:
  // YuE2 GGUF and the Python kit load per song, and no song of theirs loads
  // or unloads a ComfyUI model.
  assert.match(paint, /const inComfy = \(state\.musicEngines\?\.\[e\]\?\.runtime \?\? "comfy"\) === "comfy";/);
  assert.match(paint, /: !inComfy \? \(holding \? "ComfyUI is holding a model this engine does not use; Unload frees the card for it\." : ""\)\n\s+: loaded\?\.key === want/,
    "the ComfyUI sentences are reached only for a ComfyUI engine");
});

test("the Structure tip has an anchor that is on the page", () => {
  // The Write | Structure switch removed label[for="structure"]; a tip whose
  // anchor is gone loses its "!" without a word.
  const tips = read("web/tips.js");
  assert.match(tips, /structure: \{ at: "#instrField",/);
  assert.match(HTML, /<div class="structbar" id="instrField"/);
  assert.doesNotMatch(tips, /at: 'label\[for="structure"\]'/);
});

test("the rail has its own width and a grip to set it", () => {
  const css = read("web/styles.css");
  // Two meters to a row means how much of their text fits is a function of
  // this width; one number chosen here is right at one screen size only.
  assert.match(css, /grid-template-columns: var\(--railw, 248px\) var\(--colw/);
  assert.match(css, /grid-template-columns: var\(--railw, 248px\) minmax\(0, 1fr\);/);
  assert.doesNotMatch(css, /grid-template-columns: 220px/, "no hard-coded rail width left");
  assert.match(css, /\.railgrip \{[\s\S]*?cursor: col-resize;/);
  assert.match(css, /\.rail \{ position: relative;/, "the grip is absolute against the rail");
  assert.match(css, /\.shell\.railmini \.railgrip \{ display: none; \}/, "nothing to drag when collapsed");
  assert.match(HTML, /<button class="railgrip" type="button" id="railGrip"/);
  assert.match(APP, /const KEY = "aiplayRailW";/);
  assert.match(APP, /Math\.max\(200, Math\.min\(w, Math\.min\(420, innerWidth - 520\)\)\)/, "clamped both ways");
  assert.match(APP, /grip\?\.addEventListener\("dblclick", \(\) => set\(0\)\);/, "double-click resets");
  // At 248px each cell is 107px, and the figures are written to fit it: the
  // long halves (free space, core count, drive fullness) are in the tooltips.
  assert.match(APP, /\$\("diskText"\)\.textContent = `\$\{size\(d\.modelBytes\)\} models`;/);
  assert.match(APP, /\$\("cpuText"\)\.textContent = pct == null \? `\$\{c\.cores\} cores` : `\$\{pct\}% CPU`;/);
});
