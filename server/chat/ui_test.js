/**
 * CHAT UI — the static gates the chat panel stands on.
 *
 * Modelled on server/daw/ui_test.js, and it runs the same three ways:
 *
 *   1. THE PARITY GATE — every path web/chat.js fetches must be a path
 *      server/chat/routes.js really handles, and every path that route handles
 *      must be reachable from the page. Both directions, no exemption table,
 *      because there is nothing here small enough to need one. The direction
 *      that finds bugs is the second: a route with no way to reach it is a
 *      feature that shipped half-built, and it is exactly how three DAW actions
 *      once shipped with a route, a panel and no tool while the census said 216
 *      passed / 0 failed.
 *
 *   2. THE WIRING GATE — web/chat.js binds its listeners at module top level
 *      inside init(), so one id index.html does not carry is
 *      `null.addEventListener`: a TypeError that kills the WHOLE module, and
 *      the browser swallows it. Every `$("…")` in the page's code must be an id
 *      the HTML really has.
 *
 *   3. THE PLACE IN THE APP — first in the rail, the boot default, an ⓘ mount,
 *      a paragraph in the welcome catalogue, a stylesheet, a script tag and a
 *      mount in server/index.js. Seven small things, every one of which fails
 *      silently on its own: a screen with no script tag is a blank panel, a
 *      screen with no catalogue paragraph tells a new reader they have seen the
 *      whole app when they have not.
 *
 * Runs standalone (`node server/chat/ui_test.js`) and in the pre-commit hook.
 * Touches no disk beyond reading web/ and server/.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatTools } from "./tools.js";
import { systemPrompt } from "./loop.js";
/* The page's own markdown renderer, imported and RUN — see section 6. It is the
 * one function on that screen that turns model text into markup, so it is the
 * one function that can put a tag on the page that the model asked for. Nothing
 * in web/chat.js touches the DOM at module scope (the bootstrap is guarded), so
 * importing it here costs nothing. */
import { renderMarkdown } from "../../web/chat.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const WEB = path.join(ROOT, "web");
const read = (...p) => readFileSync(path.join(...p), "utf8");

const CHATJS = read(WEB, "chat.js");
const CHATCSS = read(WEB, "chat.css");
const HTML = read(WEB, "index.html");
const APPJS = read(WEB, "app.js");
const ROUTES = read(HERE, "routes.js");
const LOOP = read(HERE, "loop.js");
const TOOLSRC = read(HERE, "tools.js");
const INDEXJS = read(ROOT, "server", "index.js");
const CATALOGUE = read(ROOT, "server", "welcome", "catalogue.js");
const README = read(ROOT, "README.md");

/* Strip comments before looking for code shapes, so a sentence in a docblock
 * cannot pass or fail a structural check — the trap that once let both
 * mountAllInfo() statements be deleted with every check still passing. */
const noComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODE = noComments(CHATJS);
const ROUTECODE = noComments(ROUTES);

/* ══ 1. parity ════════════════════════════════════════════════════════════ */
console.log("\nTHE PARITY GATE");

/** Every path this page fetches, with the method it uses. */
const fetches = [...CODE.matchAll(/fetch\(\s*(?:`([^`]+)`|"([^"]+)")\s*(?:,\s*\{([\s\S]*?)\}\s*\))?/g)]
  .map((m) => {
    const raw = m[1] ?? m[2] ?? "";
    const opts = m[3] || "";
    const method = /method:\s*"([A-Z]+)"/.exec(opts)?.[1] || "GET";
    /* `?id=${...}` and the like: the PATH is what the route matches on. */
    return { path: raw.split("?")[0], method, raw };
  });

ok(`the page's fetches were found and read (${fetches.length})`, fetches.length >= 3,
  fetches.map((f) => `${f.method} ${f.path}`).join(", "));

/** Every path the route really handles, read out of its own guard. */
const served = new Set();
for (const m of ROUTECODE.matchAll(/p\s*(?:!==|===)\s*"(\/api\/chat[^"]*)"/g)) served.add(m[1]);
ok(`the route's paths were found and read (${[...served].join(", ")})`, served.size >= 2, [...served].join(", "));

const orphans = fetches.filter((f) => !served.has(f.path));
ok("every path the page fetches is one the route handles",
  orphans.length === 0,
  `${orphans.map((f) => `${f.method} ${f.path}`).join(", ")} — posted by web/chat.js and matched by `
  + "nothing in server/chat/routes.js. A button posting into a 404 looks exactly like a button "
  + "that is merely slow.");

const unreached = [...served].filter((p) => !fetches.some((f) => f.path === p));
ok("...and every path the route handles is reachable from the page",
  unreached.length === 0,
  `${unreached.join(", ")} — served and reachable from nothing a person can click. `
  + "A route with no way in is a feature that shipped half-built.");

ok("the page POSTs the message and GETs the sessions, not the other way round",
  fetches.some((f) => f.method === "POST" && f.path === "/api/chat")
  && fetches.some((f) => f.method === "GET" && f.path === "/api/chat/sessions"),
  fetches.map((f) => `${f.method} ${f.path}`).join(", "));

/** The fields the page sends, against the fields the route reads. */
ok("the page sends `message` and `session`, which are the two the route reads",
  /JSON\.stringify\(\{\s*message,\s*session:/.test(CODE)
  && /b\.message/.test(ROUTECODE) && /b\.session/.test(ROUTECODE));
ok("...and it sends nothing else, so there is no field the server would ignore in silence",
  !/JSON\.stringify\(\{\s*message,\s*session:\s*SESSION\s*,\s*\w/.test(CODE));

/* THE CONFIRM BUTTON IS NOT A SECOND WRITE PATH. This is the one that matters
 * most on this screen: if the button had its own route, the gate in loop.js
 * could be bypassed by a page that forgot to call it. */
ok("the confirm button sends an ORDINARY MESSAGE — it is a convenience, not a second write path",
  /chatYes.*addEventListener.*send\("yes"\)/s.test(CODE) && !/\/api\/chat\/confirm/.test(CODE),
  "web/chat.js's Yes button must call send(\"yes\"), the same path typing it takes");
ok("...and the gate that actually stops the spend is in the loop, not the page",
  /session\.pending\s*=\s*\{\s*tool:/.test(noComments(LOOP))
  && !/pending/.test(CODE.replace(/\/\/.*$/gm, "")),
  "server/chat/loop.js holds the pending proposal; web/chat.js must hold no spend state at all");

/* THE EVENT VOCABULARY IS ALSO A PARITY SURFACE. The stream is the only thing
 * this page is told, so an event the loop emits and the page does not draw is a
 * phase that happens invisibly — and a `case` for an event nothing sends is a
 * branch that has never run. Both directions, same as the paths above. */
/* ⚠ The route side is read for BOTH verbs. It writes to the stream through
 * `send` directly and through the `emit` wrapper that also files the event to
 * the session's JSONL, and reading only `send` made this census blind to the
 * second — which is how the router's own `routed` event was sent down the wire
 * and reported as a page inventing a case for nothing. A parity test with a
 * hole in one direction is worse than none, because it is believed. */
const emitted = new Set([
  ...[...noComments(LOOP).matchAll(/emit\(\{\s*type: "([a-z_]+)"/g)].map((m) => m[1]),
  ...[...noComments(ROUTECODE).matchAll(/(?:send|emit)\(\{\s*type: "([a-z_]+)"/g)].map((m) => m[1]),
]);
const drawn = new Set([...CODE.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]));
ok(`the stream's event vocabulary was found and read (${emitted.size})`, emitted.size >= 12,
  [...emitted].join(", "));
ok("every event the loop and the route can send is one the page draws",
  [...emitted].every((t) => drawn.has(t)),
  `${[...emitted].filter((t) => !drawn.has(t)).join(", ")} — sent down the stream and drawn by `
  + "nothing in web/chat.js, so the phase happens where nobody can see it.");
ok("...and the page invents none of its own",
  [...drawn].every((t) => emitted.has(t)),
  `${[...drawn].filter((t) => !emitted.has(t)).join(", ")} — a case for an event nothing sends`);

/* ══ 2. wiring ════════════════════════════════════════════════════════════ */
console.log("\nTHE WIRING GATE");

const ids = [...new Set([...CODE.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]))];
ok(`the page's element ids were found and read (${ids.length})`, ids.length >= 8, ids.join(", "));
const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(HTML));
ok("every id web/chat.js reaches for really exists in web/index.html",
  missing.length === 0,
  `${missing.join(", ")} — one missing id is null.addEventListener at module top level, which `
  + "kills the whole module and the browser says nothing.");

/* The cluster named explicitly, so deleting one from the page fails HERE rather
 * than quietly removing a feature. */
for (const id of ["chatLog", "chatScroll", "chatForm", "chatText", "chatSend", "chatStop",
                  "chatNew", "chatConfirm", "chatConfirmText", "chatYes", "chatNo",
                  "chatBusy", "chatBusyText", "chatSessions"]) {
  ok(`#${id} is in the page`, new RegExp(`id="${id}"`).test(HTML));
}

/* The composer's contract, in as many words. Each of these has its own way of
 * failing silently: a Send that never re-enables looks like a dead app, and a
 * Stop that is always visible is a button that lies about there being anything
 * to stop. */
ok("Enter sends and shift+Enter is a new line",
  /e\.key === "Enter" && !e\.shiftKey/.test(CODE));
ok("...the textarea grows with what is typed rather than staying two rows",
  /scrollHeight/.test(CODE) && /addEventListener\("input", grow\)/.test(CODE));
ok("...Send is disabled and Stop is shown for exactly the length of a turn",
  /send\.disabled = on/.test(CODE) && /stop\.hidden = !on/.test(CODE));
ok("...and Stop pulls on the stream rather than pretending to stop the card",
  /STREAM\.abort\(\)/.test(CODE) && /AbortError/.test(CODE),
  "aborting the read closes this page's ear; a render that already began keeps going, "
  + "and the note web/chat.js writes must say so");

ok("listeners are addEventListener, never `onclick =` — app.js owns those properties on the rail",
  !/\.onclick\s*=/.test(CODE) && /addEventListener/.test(CODE));

/* ══ 3. the place in the app ══════════════════════════════════════════════ */
console.log("\nTHE PLACE IN THE APP");

const railViews = [...HTML.matchAll(/<a href="#"[^>]*data-view="([a-z]+)"/g)].map((m) => m[1]);
ok("chat is in the rail", railViews.includes("chat"), railViews.join(", "));
/* The rail was Home, Chat, Music (the owner's ask, 2026-09-19) until UI_PLAN
 * B1, approved 2026-09-24: Make first (Home, Music, Pictures, Video, Music
 * video), and Chat heads the "More tools" fold, one click away. */
ok("...and the rail opens Home, then Make: Music, Pictures, Video, Music video",
  railViews[0] === "home" && railViews[1] === "create" && railViews[2] === "router"
    && railViews[3] === "images" && railViews[4] === "video" && railViews[5] === "workflow", railViews.join(", "));
ok("...and Chat heads the More tools fold",
  /<details class="navgroup navmore" id="navMore">\s*<summary[^>]*>[\s\S]*?<\/summary>\s*<a href="#" data-view="chat"/.test(HTML));

const APPCODE = noComments(APPJS);
ok("Welcome is the boot default", /\nsetView\("home"\);/.test(APPCODE),
  "web/app.js's boot line must be setView(\"home\")");
ok("...and its rail entry carries class=\"on\" so the highlight matches the boot view",
  /<a href="#" class="on" data-view="home"/.test(HTML));
ok("Welcome: the mark, the name, and Chat · Music · Video · Pictures · Explore (Community)",
  /<div id="home" class="home" hidden>[\s\S]*?class="homelogo"[\s\S]*?<b>AI PLAY<\/b><span>STUDIO<\/span>[\s\S]*?Start with[\s\S]*?data-go="chat">Chat<[\s\S]*?data-go="create">Music<[\s\S]*?data-go="video">Video<[\s\S]*?data-go="images">Pictures<[\s\S]*?data-go="community">Explore</.test(HTML)
  && /\$\("home"\)\.hidden = name !== "home";/.test(APPCODE));
ok("...and no OTHER rail entry claims the highlight",
  (HTML.match(/<a href="#" class="on" data-view=/g) || []).length === 1);

/* ── EVERY RAIL VIEW IS UN-HIDDEN BY SOMETHING ────────────────────────────
 *
 * 🔴 Collab shipped registered and INVISIBLE. It had a rail link, an entry in
 * INFO_HOSTS and `paintCollab()` on the view change, so the nav highlighted, the
 * keypair was made, the door was called — and the screen stayed blank, because
 * nothing ever set `$("collab").hidden`. `setView`'s own comment warns about
 * precisely this failure and sits three lines above where the missing line
 * belonged. A warning you have to read is not a check.
 *
 * The rule: a rail entry whose container is a `<div id="X" … hidden>` must have
 * its `hidden` driven from the view SOMEWHERE in app.js. Most do it with one
 * line in setView; `#community` is driven by `paintComm()` instead, for the
 * reason written above that function, and this passes either way. Views whose
 * container is not a hidden div of the same id (create, images, video) are not
 * in scope — they are shown through their own panels.
 */
{
  const railViews = [...new Set([...HTML.matchAll(/data-view="([a-z0-9_-]+)"/g)].map((m) => m[1]))];
  const invisible = railViews.filter((v) => {
    const hasContainer = new RegExp(`<div id="${v}"[^>]*\\bhidden\\b`).test(HTML);
    if (!hasContainer) return false;
    const driven = new RegExp(`\\$\\("${v}"\\)\\.hidden\\s*=`).test(APPCODE);
    return !driven;
  });
  ok(`every rail view with a hidden container is un-hidden by something (${railViews.length} views)`,
    invisible.length === 0,
    `${invisible.join(", ")} — registered in the rail and never shown. That is a highlighted nav entry over a blank screen.`);
}

ok("setView shows and hides #chat, one explicit line like every other view",
  /\$\("chat"\)\.hidden\s*=\s*name\s*!==\s*"chat"/.test(APPCODE));
ok("...and #chat is a real container in the page", /<div id="chat" hidden>/.test(HTML));
ok("...with an ⓘ mounted for it, which every screen gets",
  /const INFO_HOSTS = \{[\s\S]*?\n\s*chat:\s*"#chat",/.test(APPCODE));

ok("web/index.html loads chat.css", /<link[^>]+href="chat\.css"/.test(HTML));
ok("...and web/chat.js, as a module, after app.js",
  HTML.indexOf('src="chat.js"') > HTML.indexOf('src="app.js"')
  && /<script type="module" src="chat\.js"><\/script>/.test(HTML));

ok("server/index.js imports the route factory", /import \{ createChatRoutes \} from "\.\/chat\/routes\.js";/.test(INDEXJS));
ok("...calls it", /const chatRoutes = createChatRoutes\(\{/.test(INDEXJS));
ok("...and mounts it on the whole /api/chat prefix",
  /if \(p === "\/api\/chat" \|\| p\.startsWith\("\/api\/chat\/"\)\) \{[\s\S]{0,120}chatRoutes\(req, res, url\)/.test(INDEXJS));

ok("the welcome catalogue carries a paragraph for this screen",
  /id: "chat", icon:/.test(CATALOGUE),
  "the welcome census counts SCREENS — a tab with no paragraph tells a new reader they have "
  + "seen the whole app when they have not");
ok("...and it names the model that is actually behind the panel",
  /Qwen3-4B/.test(CATALOGUE) || /qwen_3_4b/.test(CATALOGUE));

ok("README.md has a Chat section", /^##+ .*\bChat\b/m.test(README),
  "the README is where this repo says what it is");

/* ══ 4. the sheet spells no colour of its own ═════════════════════════════ */
console.log("\nTHE STYLESHEET");

/* Same bargain as engine.css, videolab.css and welcome.css: neutrals expressed
 * as an alpha over grey, or currentColor, so this screen inherits the app's
 * theme rather than declaring a second opinion about it. */
const colours = [...CHATCSS.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)]
  .map((m) => m[0])
  .filter((c) => {
    if (c.startsWith("#")) return true;
    const [, r, g, b] = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
    return !(r === g && g === b);      // a grey is a neutral, not a brand colour
  });
ok("web/chat.css spells no brand colour of its own", colours.length === 0, colours.join(", "));
ok("...and everything it draws is scoped under #chat or .chat-",
  [...CHATCSS.matchAll(/^([.#@][^\s{,]+)/gm)].map((m) => m[1])
    .every((sel) => sel.startsWith("#chat") || sel.startsWith(".chat-") || sel.startsWith("@")),
  [...CHATCSS.matchAll(/^([.#@][^\s{,]+)/gm)].map((m) => m[1])
    .filter((s) => !s.startsWith("#chat") && !s.startsWith(".chat-") && !s.startsWith("@")).join(", "));
ok("...and it respects prefers-reduced-motion, because the only animation here is a pulsing dot",
  /prefers-reduced-motion/.test(CHATCSS));

/* ── the three rules a real browser at 380px broke ─────────────────────────
 *
 * ⚠ MEASURED IN HEADLESS CHROME AT 380 CSS PIXELS, 2026-09-05, and every one
 * of these was a real defect on the shipped page before it was a check here.
 * They are all the same bug wearing three hats: a FLEX ITEM WILL NOT SHRINK
 * BELOW ITS OWN CONTENT unless something says it may, and every one of these
 * three rows carries a whole sentence.
 *
 *  1. the tool card's summary — its one-line result ("note: Rendering has
 *     started. Ask song_status with this job_id") pushed the row 133px past
 *     the transcript and the PAGE took 128px of sideways scroll from it;
 *  2. the bar's right-hand group — label, a 260px select and New chat stayed
 *     on one line and hung the button 36px off the panel's right edge;
 *  3. the composer — with the app's 176px rail there was nothing left, and the
 *     textarea measured SEVENTY PIXELS WIDE with Send beside it.
 *
 * These are string checks on the stylesheet, which is the weakest kind of
 * check; what makes them worth having is that each one names a measurement
 * that was taken in a browser, so a future edit that deletes one has to
 * argue with the number rather than with a preference. */
ok("the tool card's summary may become two rows rather than one too-wide one",
  /\.chat-tool > summary \{[^}]*flex-wrap: wrap/.test(CHATCSS));
ok("...and the parts of it that carry sentences may shrink and wrap",
  /\.chat-tool-state \{[^}]*min-width: 0/.test(CHATCSS)
  && /\.chat-tool-state \{[^}]*overflow-wrap: anywhere/.test(CHATCSS)
  && /\.chat-tool-what \{[^}]*min-width: 0/.test(CHATCSS));
ok("...and the tool card's gloss has a class to hang that on, rather than a bare span",
  /class="chat-tool-what"/.test(CODE));
ok("the bar's right-hand group wraps too, so New chat cannot hang off the edge",
  /\.chat-right \{[^}]*flex-wrap: wrap/.test(CHATCSS));
ok("...and below 560px the composer stops being a row, so the box gets the whole width",
  /@media \(max-width: 560px\)/.test(CHATCSS)
  && /\.chat-input \{ flex-direction: column/.test(CHATCSS));

/* ══ 5. the tools the model is shown ══════════════════════════════════════ */
console.log("\nTHE TOOL SURFACE");

const tools = createChatTools({ api: async () => ({}) });
/* ⚠ EIGHT, ASSERTED BOTH WAYS. Only the upper half is a real constraint, and
 * only the lower half catches a tool that quietly stopped being registered.
 * Every tool added is two more paragraphs in the one prompt a 4B reads before
 * every reply, and its accuracy on all the others falls as that list grows —
 * the seventh and eighth were bought with a screen that had promised to draw
 * pictures and could not, and a ninth has to make that argument again.
 *
 * THE ROUTER DID NOT LIFT THIS CEILING, and the distinction is the point.
 * server/chat/router.js reaches the wider MCP surface a few tools at a time,
 * matched to the message, so the prompt grows only when the message earned it
 * and shrinks again on the next turn. These eight are the ones present on
 * EVERY turn, in every prompt, whatever was asked — which is exactly why their
 * number is still a budget and a ninth still has to be argued for. */
ok("EIGHT written tools, on every single turn — the budget the router did not lift, since a routed "
   + "tool is present only when the message reached for it",
  tools.all.length === 8, `${tools.all.length}`);
ok("...and eight is a CEILING rather than a running total — a ninth costs accuracy on the eight",
  tools.all.length <= 8, `${tools.all.length}`);
const SYS = systemPrompt(tools.all);
ok("every one of them reaches the model", tools.names.every((n) => SYS.includes(`TOOL ${n}`)));
ok("...and every tool's `run` is a thin call into an existing route, not a second implementation",
  tools.all.every((t) => typeof t.run === "function")
  && (TOOLSRC.match(/await api\(/g) || []).length >= 6,
  `${(TOOLSRC.match(/await api\(/g) || []).length} api calls in server/chat/tools.js`);
ok("server/chat/tools.js imports no MCP module — the MCP servers are stdio transports for "
   + "EXTERNAL clients, and every one of their tools is already a wrapper over these same routes",
  !/from "\.\.\/mcp/.test(TOOLSRC));
/* ⚠ STATED AS A POSITIVE, ON PURPOSE. The obvious way to write this check is to
 * look for the old engine constant — and then THIS FILE contains it, and
 * server/engine/ui_test.js's bypass census fails the commit naming this file as
 * a bypass. It is right to: a census that scans every .js in the tree cannot
 * tell a test's regex from a URL, and teaching it to would be the first hole.
 * So the property is asserted the other way round: exactly one address is built
 * here and it is this app's own. */
const TOOLCODE = noComments(TOOLSRC);
ok("server/chat/tools.js builds exactly ONE address, and it is this app's own port",
  (TOOLCODE.match(/http:\/\//g) || []).length === 1
  && /http:\/\/127\.0\.0\.1:\$\{uiPort\}/.test(TOOLCODE),
  (TOOLCODE.match(/http:\/\/[^`"']*/g) || []).join(", "));
ok("...and it names no engine route, so it cannot reach the GPU except through the door",
  !/config\.comfy/.test(TOOLCODE) && !/["'`]\/(prompt|history|queue|object_info)\b/.test(TOOLCODE));
/* ── THE PICTURE TOOLS ────────────────────────────────────────────────────
 *
 * The strand these three checks belong to: the chat had six tools and not one
 * of them could draw, so asked for a picture it answered "Sure! Let me create
 * the brainrot image for you" and produced nothing. What stops that returning
 * is not that make_image exists — it is that it exists at the size a 4B can
 * actually use, and that the person is told where the file went. */
const img = tools.get("make_image");
ok("make_image takes a prompt and an engine and NOTHING ELSE — ref_images, prompt_choices, "
   + "dedupe and count are arrays and replay semantics, which is the shape this model gets wrong",
  Object.keys(img.args).join(",") === "prompt,engine", Object.keys(img.args).join(","));
ok("...and it spends, so it carries a cost sentence and goes through the loop's confirm gate",
  img.spends === true && String(img.cost || "").length > 20, img.cost || "no cost sentence");
ok("...and it tells the model where the picture lands and how the person sees it, because a file "
   + "name with no place attached is not an answer to 'draw me a picture'",
  /Pictures library/.test(img.description) && /open Pictures in the left rail/.test(img.description));
ok("list_images is FREE and read-only — it is what makes make_image answerable ('did it work?')",
  tools.get("list_images").spends === false && !tools.get("list_images").cost);
ok("...and nothing in this file POSTs to an image route except make_image's own create",
  (TOOLCODE.match(/api\("POST", "\/api\/image/g) || []).length === 1,
  `${(TOOLCODE.match(/api\("POST", "\/api\/image/g) || []).length} POSTs to /api/image*`);

ok("the loop reaches the engine ONLY through server/engine/client.js",
  /from "\.\.\/engine\/client\.js"/.test(LOOP) && !/http:\/\//.test(noComments(LOOP)));
ok("...and it says out loud that the model is one node output rather than a token stream",
  /NOT A TOKEN STREAM/.test(ROUTES) && /not a token stream|NOT A TOKEN STREAM/i.test(LOOP));

/* ══ 6. the markdown renderer ═════════════════════════════════════════════
 *
 * ⚠ THE MODEL'S OUTPUT IS UNTRUSTED TEXT. It is a 4B that has just read a tool
 * result, and that tool result came off this disk: `<img onerror=…>.wav` is a
 * legal file name, list_library will return it, and the model will repeat it
 * back. renderMarkdown() is the ONE function on that screen that turns model
 * text into markup, so it is the one place a tag the model asked for could
 * reach the page — and the property that stops it is ORDER: escape the whole
 * string first, format the escaped string afterwards.
 *
 * These run the real function out of web/chat.js. They are not a reading of the
 * code; they are the output.
 */
console.log("\nTHE MARKDOWN RENDERER");

const md = (s) => renderMarkdown(s);

ok("a script tag comes back as VISIBLE TEXT, not as a script tag",
  md("<script>alert(1)</script>").includes("&lt;script&gt;")
  && !/<script/i.test(md("<script>alert(1)</script>")),
  md("<script>alert(1)</script>"));
ok("...and so does one hidden inside a fenced code block",
  !/<img/i.test(md("```\n<img src=x onerror=alert(1)>\n```"))
  && md("```\n<img src=x onerror=alert(1)>\n```").includes("&lt;img"),
  md("```\n<img src=x onerror=alert(1)>\n```"));
ok("...and one inside a heading, a list item and an inline code span",
  !/<img/i.test(md("# <img onerror=x>\n- <img onerror=x>\n\n`<img onerror=x>`")),
  md("# <img onerror=x>\n- <img onerror=x>\n\n`<img onerror=x>`"));
/* The quote is `&quot;` before the link rule ever runs, so the payload below
 * cannot close the href and start an attribute. It survives as VISIBLE TEXT,
 * which is exactly right: the reader sees what the model wrote. */
ok("an attribute cannot be broken out of, because the quote is escaped first",
  !/<a\b/.test(md('[go](http://x" onmouseover="alert(1))'))
  && md('[go](http://x" onmouseover="alert(1))').includes("&quot;"),
  md('[go](http://x" onmouseover="alert(1))'));
ok("a javascript: link is shown as text rather than made into an href",
  !/href="javascript/i.test(md("[click](javascript:alert(1))")),
  md("[click](javascript:alert(1))"));
ok("...while an ordinary http link IS a link, and opens away from the app",
  /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/
    .test(md("[docs](https://example.com)")),
  md("[docs](https://example.com)"));

ok("paragraphs, bold, italic and inline code render",
  /<p>/.test(md("hello **there** and _here_ and `code`"))
  && /<strong>there<\/strong>/.test(md("**there**"))
  && /<em>here<\/em>/.test(md("_here_"))
  && /<code>code<\/code>/.test(md("`code`")),
  md("hello **there** and _here_ and `code`"));
ok("...headings, bulleted and numbered lists, quotes and rules render",
  /<h2>Title<\/h2>/.test(md("## Title"))
  && /<ul><li>one<\/li><li>two<\/li><\/ul>/.test(md("- one\n- two"))
  && /<ol><li>one<\/li><\/ol>/.test(md("1. one"))
  && /<blockquote>/.test(md("> quoted"))
  && /<hr>/.test(md("---")),
  `${md("## Title")} ${md("- one\n- two")} ${md("1. one")}`);
ok("...a nested list nests rather than flattening",
  /<ul><li>one<ul><li>deeper<\/li><\/ul><\/li><\/ul>/.test(md("- one\n  - deeper")),
  md("- one\n  - deeper"));
ok("...emphasis inside a code span is left alone, which is the point of a code span",
  /<code>a \*b\* c<\/code>/.test(md("`a *b* c`")), md("`a *b* c`"));
ok("...and a snake_case word is not turned into italics by its underscores",
  /mv_previz_shot/.test(md("call mv_previz_shot now")) && !/<em>/.test(md("call mv_previz_shot now")),
  md("call mv_previz_shot now"));

ok("a fenced block gets a monospace face, a copy button and its own scroller",
  /<div class="chat-code">/.test(md("```js\nconst a = 1;\n```"))
  && /data-copy/.test(md("```js\nconst a = 1;\n```"))
  && /<pre><code>const a = 1;<\/code><\/pre>/.test(md("```js\nconst a = 1;\n```"))
  && /\.chat-code pre \{[^}]*overflow-x: auto/.test(CHATCSS),
  md("```js\nconst a = 1;\n```"));
ok("...and the copy button is wired by ONE delegated listener, not an inline handler",
  /data-copy/.test(CODE) && /navigator\.clipboard/.test(CODE) && !/onclick=/.test(CHATJS));

/* ── THE THUMBNAIL ────────────────────────────────────────────────────────
 *
 * The tool card draws the picture make_image just made, and that is one more
 * path from a tool result into markup — where a picture's NAME comes off this
 * disk, on which `<img onerror=alert(1)>.png` is a perfectly legal file name.
 * Two properties stop that being a hole, and both are checked as code rather
 * than trusted: the src is escaped like everything else on this screen, and it
 * is built only from a `url` matching this app's own image route, so a result
 * carrying an absolute URL or a data: URI draws nothing at all. */
const imageUrlFn = /function imageUrl\(result\)[\s\S]*?\n}/.exec(CODE)?.[0] || "";
ok("the tool card's thumbnail is built ONLY from this app's own /api/image/ route",
  imageUrlFn.includes(String.raw`\/api\/image\/`) && /\.test\(u\)\s*\?\s*u\s*:\s*null/.test(imageUrlFn),
  imageUrlFn || "web/chat.js has no imageUrl() guard at all");
ok("...and its src goes through esc(), like every other value drawn on this screen",
  CODE.includes('src="${esc(shot)}"'), "an unescaped src is an onerror= away from being a hole");
ok("...and a card showing a picture is left OPEN — folding it hides the one thing on it",
  CODE.includes("d.open = !!shot;"));

ok("nothing else on this screen builds markup out of model text — every other "
   + "path through it goes via esc()",
  (CODE.match(/renderMarkdown\(/g) || []).length >= 3
  && !/innerHTML\s*=\s*(?:ev|t)\./.test(CODE),
  "a second unescaped path would make the escaping above decorative");

/* ══ 7. what the screen says it can do ════════════════════════════════════ */
console.log("\nTHE EMPTY STATE");

ok("the empty state names all EIGHT tools in plain words, one card each",
  (CODE.match(/\{ t: "/g) || []).length === 8, `${(CODE.match(/\{ t: "/g) || []).length}`);
/* The card that was missing is the whole point of this strand: a screen that
 * lists what it can do and leaves out the thing a person will ask for first is
 * the same failure as a chat that says "Sure!" and draws nothing. */
ok("...including the two that were missing — a picture, and the pictures already made",
  /Draw a picture/.test(CODE) && /Look through your pictures/.test(CODE));
ok("...and it marks the three that spend, which are the three the loop gates",
  (CODE.match(/spends: true/g) || []).length === tools.all.filter((t) => t.spends).length,
  `${(CODE.match(/spends: true/g) || []).length} marked, ${tools.all.filter((t) => t.spends).length} really spend`);
ok("...and each tool the model is given has a plain-words name on this screen too",
  tools.names.every((n) => new RegExp(`${n}:`).test(CODE)),
  tools.names.filter((n) => !new RegExp(`${n}:`).test(CODE)).join(", "));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
