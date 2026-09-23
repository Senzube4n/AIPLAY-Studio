/**
 * The page kit (web/ui.css, web/ui.js, docs/UI_GUIDE.md): the pages that use
 * it, the pills it builds, and the pointers that make agents read the guide.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
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
  assert.deepEqual(tool, accepted, "set_image_engine offers exactly the engines config.js accepts");
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
