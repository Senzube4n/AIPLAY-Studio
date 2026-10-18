// My pages (server/pages.js): storage, versions, import and the model's answer,
// with a stand-in model so nothing is sent anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { createPages, extractHtml, readExport, buildPrompt, titleOf, localLabel, frameCsp, shellCsp, frameHtml, FRAME_BOOTSTRAP, STARTER } from "./pages.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "aiplay-pages-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const asked = [];
const cloud = {
  choices: async () => [{ file: "api:test", label: "Test API · fake" }],
  resolveChoice: async (v) => (v === "api:test" ? { provider: "test", model: "fake" } : null),
  complete: async (choice, prompt) => {
    asked.push(prompt);
    return "Here you go:\n```html\n<!doctype html><html><body><h1>Built</h1></body></html>\n```\nEnjoy.";
  },
};
const pages = createPages({ dir, cloud });

test("a new page starts from the starter and is version 1", async () => {
  const meta = await pages.create({ name: "Song list" });
  assert.match(meta.id, /^[a-f0-9]{12}$/);
  const got = await pages.get(meta.id);
  assert.equal(got.version, 1);
  assert.equal(got.html, STARTER);
  assert.equal((await pages.list())[0].name, "Song list");
});

test("generate asks the chosen model and keeps the answer as a new version", async () => {
  const meta = await pages.create({ name: "Gen" });
  const r = await pages.generate({ id: meta.id, model: "api:test", request: "show a heading" });
  assert.equal(r.version, 2);
  assert.match(r.html, /<h1>Built<\/h1>/);
  assert.match(asked.at(-1), /WHAT THE PERSON WANTS:\nshow a heading/);
  assert.match(asked.at(-1), /studio\.songs\(\)/, "the bridge is described to the model");
  const v1 = await pages.get(meta.id, 1);
  assert.equal(v1.html, STARTER, "the older version is still there");
});

test("generate refuses a model that is not connected, and an empty request", async () => {
  const meta = await pages.create({ name: "X" });
  await assert.rejects(pages.generate({ id: meta.id, model: "api:nope", request: "x" }), /not connected/);
  await assert.rejects(pages.generate({ id: meta.id, model: "api:test", request: "  " }), /Say what/);
});

test("an id that is not ours never reaches the disk", async () => {
  await assert.rejects(pages.get("../../etc"), /No such page/);
  await assert.rejects(pages.get("abc"), /No such page/);
});

test("the model's page is taken from its code block, or from a bare document", () => {
  assert.equal(extractHtml("```html\n<div>a</div>\n```"), "<div>a</div>\n");
  assert.match(extractHtml("Sure! <!doctype html><html><body>x</body></html>"), /^<!doctype html>/);
  assert.equal(extractHtml("I cannot help with that."), null);
});

test("an exported file is checked before it is kept", () => {
  assert.throws(() => readExport({ format: "something", html: "<p>" }), /not an AIPLAY page/);
  assert.throws(() => readExport({ format: "aiplay-page", html: "" }), /no page/);
  const ok = readExport({ format: "aiplay-page", name: "  <b>Mine</b>  ", html: "<p>hi</p>", author: "B", licence: "Apache-2.0" });
  assert.equal(ok.name, "bMine/b");
  assert.equal(ok.licence, "Apache-2.0");
});

test("the prompt carries the current page", () => {
  const p = buildPrompt({ html: "<p>now</p>", request: "more", name: "N" });
  assert.match(p, /```html\n<p>now<\/p>\n```/);
});

test("the model is told what the sandbox blocks and how to get sound through Web Audio", () => {
  const p = buildPrompt({ html: "<p>x</p>", request: "eq", name: "N" });
  assert.match(p, /localStorage, sessionStorage, indexedDB or cookies \(they THROW/);
  assert.match(p, /studio\.audio\(file\) -> Promise<string>/);
  assert.match(p, /Web Audio turns a cross-origin element into SILENCE/);
  assert.match(p, /studio\.get\(key\)/);
});

test("the page's errors travel with the next request", () => {
  const p = buildPrompt({ html: "<p>x</p>", request: "fix", name: "N", errors: ["Uncaught TypeError: a is undefined (line 4)"] });
  assert.match(p, /REPORTS THESE ERRORS[^\n]*\n- Uncaught TypeError: a is undefined \(line 4\)/);
  assert.doesNotMatch(buildPrompt({ html: "", request: "x", name: "N" }), /REPORTS THESE ERRORS/);
});

test("a page keeps its own saved data, capped and per page", async () => {
  const a = await pages.create({ name: "A" }), b = await pages.create({ name: "B" });
  await pages.dataSet(a.id, "eq", { bands: [1, 2, 3] });
  assert.deepEqual(await pages.dataGet(a.id, "eq"), { bands: [1, 2, 3] });
  assert.equal(await pages.dataGet(b.id, "eq"), null, "another page cannot see it");
  await pages.dataSet(a.id, "eq", null);
  assert.equal(await pages.dataGet(a.id, "eq"), null, "null removes it");
  await assert.rejects(pages.dataSet(a.id, "big", "x".repeat(1024 * 1024 + 10)), /1 MB/);
  await assert.rejects(pages.dataSet(a.id, "", 1), /1 to 100/);
});

test("a page on the default name takes the model's <title>; a name the person chose stays", async () => {
  const titled = createPages({ dir, cloud: { ...cloud,
    complete: async () => "```html\n<!doctype html><html><head><title>Song &amp; Equalizer</title></head><body>x</body></html>\n```" } });
  const fresh = await titled.create({});
  assert.equal(fresh.name, "My page");
  const r = await titled.generate({ id: fresh.id, model: "api:test", request: "an eq" });
  assert.equal(r.name, "Song & Equalizer");
  assert.equal((await titled.get(fresh.id)).name, "Song & Equalizer");
  const mine = await titled.create({ name: "Bucky's EQ" });
  assert.equal((await titled.generate({ id: mine.id, model: "api:test", request: "x" })).name, "Bucky's EQ");
  assert.equal(titleOf("<p>no title</p>"), "");
});

test("the engine's own models are offered, write pages through the engine, and wait for a busy card", async () => {
  const sent = [];
  let busy = null;
  const local = {
    models: async () => [{ file: "qwen_3_4b.safetensors", label: "Qwen3 4B - writes lyrics and prompts" },
      { file: "Qwen3-VL-8B-Q6_K.gguf", label: "Qwen3-VL 8B (Q6_K) - writes lyrics and prompts" }, { file: "api:anthropic", label: "x" }],
    complete: async (file, prompt) => { sent.push(file); return "```html\n<!doctype html><html><head><title>Local Page</title></head><body>l</body></html>\n```"; },
    busy: async () => busy,
  };
  const lp = createPages({ dir, cloud, local });
  assert.equal(localLabel({ label: "Qwen3 4B - writes lyrics and prompts" }), "Qwen3 4B · Studio engine · small, more mistakes");
  assert.equal(localLabel({ label: "Qwen3-VL 8B (Q6_K) - writes lyrics and prompts" }), "Qwen3-VL 8B (Q6_K) · Studio engine");
  const meta = await lp.create({});
  busy = "A song is rendering (\"x\").";
  await assert.rejects(lp.generate({ id: meta.id, model: "local:qwen_3_4b.safetensors", request: "x" }), /needs the card/);
  busy = null;
  const r = await lp.generate({ id: meta.id, model: "local:Qwen3-VL-8B-Q6_K.gguf", request: "x" });
  assert.deepEqual(sent, ["Qwen3-VL-8B-Q6_K.gguf"]);
  assert.equal(r.name, "Local Page");
  assert.match((await lp.get(meta.id)).versions.at(-1).source, /^ai:engine\/Qwen3-VL-8B/);
});

/* The security probe of 2026-10-14: a <meta> policy spliced into the page was
 * moved into a comment by hostile markup, and the page then sent the song
 * library out. The rules are headers now, and the page sits in a wrapper. */
const served = async (url, headers = { "sec-fetch-dest": "iframe" }) => {
  const out = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead: (s, h) => { out.status = s; Object.assign(out.headers, h); },
    end: (b) => { out.body = String(b ?? ""); },
  };
  const json = (r, s, o) => { out.status = s; out.body = JSON.stringify(o); };
  await pages.handle({ method: "GET", headers: { host: "127.0.0.1:4199", ...headers } }, res, new URL(url, "http://127.0.0.1:4199"), { json });
  return out;
};

test("a page is served with its rules as headers, the bridge ahead of any hostile markup", async () => {
  const meta = await pages.create({ name: "Hostile" });
  await pages.handle({ method: "POST", headers: {} }, { writeHead() {}, end() {} }, new URL("http://x/api/pages"), {
    json: () => {}, sameOriginLocalJson: () => true,
    readBody: async () => ({ action: "save", id: meta.id, html: "<!-- <head> --><script>location='http://x/?'+1</script><html><head></head><body>x</body></html>" }),
  });
  const f = await served(`/api/pages/${meta.id}/frame?v=2`);
  const csp = f.headers["Content-Security-Policy"];
  assert.match(csp, /^sandbox allow-scripts;/, "the document has an opaque origin");
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(f.headers["Content-Type"], /^text\/html/);
  assert.ok(f.body.startsWith('<!doctype html><html><head><meta charset="utf-8"><script>(()=>{'), "Studio's head and bridge come first");
  assert.ok(f.body.indexOf("window.studio") < f.body.indexOf("<!-- <head> -->"));
  assert.match(f.body, /delete window\[k\]/, "WebRTC is taken away before the page runs");
  assert.equal(f.headers["X-DNS-Prefetch-Control"], "off");
  assert.match(f.headers["Permissions-Policy"], /microphone=\(\)/);
  const s = await served(`/api/pages/${meta.id}/shell?v=2`);
  assert.match(s.headers["Content-Security-Policy"], new RegExp(`frame-src http://127\\.0\\.0\\.1:4199/api/pages/${meta.id}/frame$`), "the wrapper only admits this page's isolated endpoint");
  assert.doesNotMatch(s.headers["Content-Security-Policy"], /script-src/, "the wrapper runs no script");
  assert.match(s.body, new RegExp(`<iframe id="f"[^>]*sandbox="allow-scripts"[^>]*src="/api/pages/${meta.id}/frame\\?v=2"`));
  assert.equal((await served("/api/pages/..%2F..%2Fetc/frame")).status, 404);
  const direct = await served(`/api/pages/${meta.id}/frame?v=2`, { "sec-fetch-dest": "document" });
  assert.equal(direct.status, 302);
  assert.equal(direct.headers.Location, `/api/pages/${meta.id}/shell?v=2`);
  assert.equal((await served(`/api/pages/${meta.id}/frame?v=2`, {})).status, 302, "clients without Fetch Metadata use the wrapper too");
});

test("frameCsp only names a host that looks like one", () => {
  assert.match(frameCsp("127.0.0.1:4199"), /img-src 'self' http:\/\/127\.0\.0\.1:4199 data: blob:/);
  assert.doesNotMatch(frameCsp("evil.example; script-src *"), /evil/);
});

test("only the constant sealing bootstrap is allowed by the inherited script policy", () => {
  const csp = frameCsp("127.0.0.1:4199"), hash = createHash("sha256").update(FRAME_BOOTSTRAP).digest("base64");
  assert.match(csp, new RegExp(`script-src 'sha256-${hash.replace(/[+]/g, "\\+")}' 'unsafe-eval';`));
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp.split("script-src ")[1].split(";")[0], /unsafe-inline|nonce-|strict-dynamic/);
  for (const kind of ["connect", "frame", "child", "worker", "object"]) assert.ok(csp.includes(`${kind}-src 'none'`));
  const html = frameHtml("<script>window.pageScript=true</script>");
  assert.equal(html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>")), FRAME_BOOTSTRAP);
  assert.ok(FRAME_BOOTSTRAP.indexOf('delete window[k]') < FRAME_BOOTSTRAP.indexOf('(0,eval)'));
  assert.equal((csp.match(/'sha256-/g) || []).length, 1, "page scripts and handlers get no reusable browser permission");
  assert.match(shellCsp("bad;host", "a".repeat(12)), /frame-src 'none'$/);
  assert.match(shellCsp("127.0.0.1:4199", "../bad"), /frame-src 'none'$/);
});

/* Optional real-browser regression; no package is added to Studio. CI/local
 * reviewers can point these at an installed Playwright module and browser.
 * The fixture serves loopback only, with fake songs and saved data. It never
 * constructs a peer connection or contacts any external address. */
test("browser enforces descendant isolation while inline tools and the explicit bridge work", {
  skip: !process.env.AIPLAY_PAGES_PLAYWRIGHT || !process.env.AIPLAY_PAGES_BROWSER
    ? "Set AIPLAY_PAGES_PLAYWRIGHT and AIPLAY_PAGES_BROWSER for the local browser fixture." : false,
  timeout: 30000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.AIPLAY_PAGES_PLAYWRIGHT).href);
  const copied = `<script>${FRAME_BOOTSTRAP}</script><script>setInterval(()=>parent.postMessage({copiedSeal:typeof RTCPeerConnection},"*"),50)</script>`;
  const attribute = value => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<!doctype html><html><head><style>body{color:rgb(1,2,3)}</style></head><body>
<button id="counter" onclick="counter++;this.textContent=String(counter)">0</button><canvas id="canvas" width="1" height="1"></canvas>
<script type="application/json" id="data">{"answer":42}</script>
<iframe srcdoc="${attribute(`<script>parent.postMessage({rawDescendant:true},"*")</script><button onclick='parent.postMessage({rawHandler:true},"*")'>child</button>`)}"></iframe>
<iframe id="blank"></iframe><iframe srcdoc="${attribute(copied)}"></iframe>
<script>
let counter=0;window.childMessages=[];addEventListener("message",e=>childMessages.push(e.data));
document.addEventListener("DOMContentLoaded",()=>{document.body.dataset.ready="yes";document.body.insertAdjacentHTML("beforeend",'<button id="dynamic" onclick="counter+=2;this.textContent=String(counter)">dynamic</button>')});
const ctx=document.getElementById("canvas").getContext("2d");ctx.fillStyle="rgb(7,8,9)";ctx.fillRect(0,0,1,1);
window.localStorageBlocked=false;try{localStorage.getItem("x")}catch(e){localStorageBlocked=e.name==="SecurityError"}
window.workerBlocked=false;try{const worker=new Worker(URL.createObjectURL(new Blob(["postMessage('worker-ran')"],{type:"text/javascript"})));worker.onerror=e=>{workerBlocked=true;e.preventDefault()};worker.onmessage=()=>window.workerRan=true;}catch(e){workerBlocked=true}
window.blankBlocked=false;try{document.getElementById("blank").contentWindow.eval("window.childRan=true")}catch(e){blankBlocked=e.name==="SecurityError"}
window.bridgeDone=(async()=>{const songs=await studio.songs();await studio.set("answer",42);const saved=await studio.get("answer");const blob=await studio.audio("fake.wav");window.bridgeResult={songs:songs.length,saved,blob:blob.startsWith("blob:")};})();
document.getElementById("counter").addEventListener("click",async()=>{const context=new AudioContext();const buffer=await context.decodeAudioData(await studio.audioData("fake.wav"));window.audioDecoded=buffer.duration;await context.close()});
</script></body></html>`;
  const meta = await pages.create({ name: "Browser fixture", html });
  const requests = [];
  const wav = Buffer.alloc(16044);wav.write("RIFF");wav.writeUInt32LE(wav.length-8,4);wav.write("WAVEfmt ",8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(wav.length-44,40);
  const harness = `<!doctype html><script>const saved=new Map();function attach(){const shell=document.getElementById("shell").contentWindow;shell.addEventListener("message",e=>{const d=e.data;if(!d||!d.aiplayBridge||e.source!==shell.frames[0])return;if(d.op==="hello"){e.source.postMessage({aiplayBridge:1,op:"ready"},"*");return;}let result;if(d.op==="songs")result=[{file:"fake.wav",title:"Fixture"}];else if(d.op==="data-set"){saved.set(d.args.key,d.args.value);}else if(d.op==="data-get")result=saved.get(d.args.key);else if(d.op==="audio")result={type:"audio/wav",data:new Uint8Array(${JSON.stringify([...wav])}).buffer};else return;e.source.postMessage({aiplayBridge:1,id:d.id,result},"*");});}</script><iframe id="shell" onload="attach()" src="/api/pages/${meta.id}/shell"></iframe>`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`); requests.push(url.pathname);
    if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(harness); return; }
    if (await pages.handle(req, res, url, { json: (r, status, value) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(value)); } })) return;
    res.writeHead(404);res.end();
  });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const browser = await chromium.launch({ executablePath: process.env.AIPLAY_PAGES_BROWSER, headless: true });
  t.after(() => browser.close());
  const tab = await browser.newPage();
  tab.setDefaultTimeout(5000);
  // A route guard prevents the test harness itself from ever leaving loopback.
  await tab.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const origin = `http://127.0.0.1:${server.address().port}`;
  await tab.goto(origin);
  const frame = tab.frames().find(f => f.url().includes(`/api/pages/${meta.id}/frame`));
  assert.ok(frame);
  await frame.waitForFunction(() => window.bridgeResult && document.body.dataset.ready === "yes" && workerBlocked);
  assert.deepEqual(await frame.evaluate(() => ({ rtc: typeof RTCPeerConnection, storage: localStorageBlocked, worker: workerBlocked, blank: blankBlocked, bridge: bridgeResult, json: JSON.parse(document.getElementById("data").textContent).answer, pixel: [...document.getElementById("canvas").getContext("2d").getImageData(0,0,1,1).data] })), {
    rtc: "undefined", storage: true, worker: true, blank: true, bridge: { songs: 1, saved: 42, blob: true }, json: 42, pixel: [7,8,9,255],
  });
  await frame.locator("#counter").click();
  assert.equal(await frame.locator("#counter").textContent(), "1", "inline handlers share the classic scripts' lexical scope");
  await frame.waitForFunction(() => window.audioDecoded === 1);
  await frame.locator("#dynamic").click();
  assert.equal(await frame.locator("#dynamic").textContent(), "3", "later innerHTML handlers use the same sealed realm and lexical scope");
  await frame.waitForFunction(() => childMessages.some(m => Object.hasOwn(m || {}, "copiedSeal")));
  const rawChild = frame.childFrames().find(f => f.url() === "about:srcdoc" && f !== frame.childFrames().at(-1));
  assert.ok(rawChild);
  await rawChild.locator("button").click();
  const messages = await frame.evaluate(() => ({ raw: childMessages.some(m => m?.rawDescendant || m?.rawHandler), seal: childMessages.find(m => Object.hasOwn(m || {}, "copiedSeal")).copiedSeal }));
  assert.equal(messages.raw, false);
  assert.equal(messages.seal, "undefined", "a copied permitted bootstrap seals its fresh realm too");
  await frame.evaluate(() => { location.href = "/outside-page"; });
  await tab.waitForTimeout(200);
  assert.equal(requests.includes("/outside-page"), false, "the wrapper blocks navigation even to unrelated Studio HTML");
  await tab.goto(`${origin}/api/pages/${meta.id}/frame`);
  assert.ok(tab.url().includes(`/api/pages/${meta.id}/shell`), "direct visits enter through the navigation-constraining wrapper");
});

test("names lose direction overrides and line separators", async () => {
  const m = await pages.create({ name: "abc‮dcba x" });
  assert.equal(m.name, "abcdcbax");
});

test("pages live in their own folder with page.json and v<n>.html", async () => {
  const meta = await pages.create({ name: "Files" });
  const j = JSON.parse(readFileSync(path.join(dir, meta.id, "page.json"), "utf8"));
  assert.equal(j.versions[0].n, 1);
  assert.equal(readFileSync(path.join(dir, meta.id, "v1.html"), "utf8"), STARTER);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function serializedFixture(t, complete = async () => "<!doctype html><html><body>built</body></html>") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "aiplay-page-serialized-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pages = createPages({ dir: directory, cloud: { resolveChoice: async () => ({ provider: "mock", model: "mock" }), complete } });
  const page = await pages.create({ name: "Concurrent page" });
  const post = async body => {
    let reply;
    await pages.handle({ method: "POST" }, {}, new URL("http://localhost/api/pages"), {
      json: (_res, status, data) => { reply = { status, data }; }, readBody: async () => ({ id: page.id, ...body }), sameOriginLocalJson: () => true,
    });
    return reply;
  };
  return { pages, page, post };
}

test("concurrent model completions preserve both immutable versions with unique numbers", async t => {
  const ready = deferred(); let calls = 0;
  const f = await serializedFixture(t, async () => { const value = ++calls; if (calls === 2) ready.resolve(); await ready.promise; return `<!doctype html><html><body>result ${value}</body></html>`; });
  const results = await Promise.all(["first", "second"].map(request => f.pages.generate({ id: f.page.id, model: "mock", request })));
  assert.deepEqual(results.map(r => r.version).sort(), [2, 3]);
  assert.deepEqual((await f.pages.get(f.page.id)).versions.map(v => v.n), [1, 2, 3]);
  for (const result of results) assert.equal((await f.pages.get(f.page.id, result.version)).html, result.html);
});

test("concurrent saves and rename keep all history; concurrent saved-data writes keep both keys", async t => {
  const f = await serializedFixture(t);
  const replies = await Promise.all([f.post({ action: "save", html: "<p>First</p>" }), f.post({ action: "save", html: "<p>Second</p>" }), f.post({ action: "rename", name: "Renamed" })]);
  assert.ok(replies.every(r => r.status === 200));
  assert.deepEqual(replies.slice(0, 2).map(r => r.data.version).sort(), [2, 3]);
  const page = await f.pages.get(f.page.id);
  assert.equal(page.name, "Renamed"); assert.deepEqual(page.versions.map(v => v.n), [1, 2, 3]);
  await Promise.all([f.pages.dataSet(f.page.id, "first", 1), f.pages.dataSet(f.page.id, "second", 2)]);
  assert.equal(await f.pages.dataGet(f.page.id, "first"), 1);
  assert.equal(await f.pages.dataGet(f.page.id, "second"), 2);
});

test("a rejected mutation does not block the next save", async t => {
  const f = await serializedFixture(t);
  const replies = await Promise.all([f.post({ action: "save", html: "" }), f.post({ action: "save", html: "<p>Valid</p>" })]);
  assert.equal(replies[0].status, 400); assert.equal(replies[1].status, 200);
  assert.equal((await f.pages.get(f.page.id)).version, 2);
});

test("a pending model cannot recreate its page after deletion", async t => {
  const started = deferred(), finish = deferred();
  const f = await serializedFixture(t, async () => { started.resolve(); await finish.promise; return "<!doctype html><html><body>late</body></html>"; });
  const building = f.pages.generate({ id: f.page.id, model: "mock", request: "Wait" });
  await started.promise; assert.equal((await f.post({ action: "delete" })).status, 200); finish.resolve();
  await assert.rejects(building, error => error.status === 404);
  assert.deepEqual(await f.pages.list(), []);
});
