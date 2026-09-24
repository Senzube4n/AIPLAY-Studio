/**
 * THE DOORS THAT CHOOSE WHAT RUNS HERE, AND WHO MAY OPEN THEM.
 *
 * readBody parses the bytes whatever the Content-Type, and a page in another
 * origin can POST a text/plain JSON body with mode 'no-cors': no preflight, no
 * answer read back, but the route still runs. Measured on an isolated copy of
 * the merged server (2026-09-24): such a request moved the rig (the folder
 * whose ComfyUI/main.py Studio launches), the output folder and the main models
 * folder, switched the paid API mode on with a $1000 cap, stored its own fal.ai
 * key, and queued a song on the paid path; only addAlso, of all of them, said
 * 403. And /api/audio served a provider's scripted SVG without the sandbox its
 * own door gives it.
 *
 * Each door here is the REAL route text sliced out of index.js and run with the
 * REAL sameOriginLocalJson (the lrc_test pattern): a stub guard would pass
 * whatever the route asked of it. No server, no engine, temp folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, createReadStream } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, stat, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { sendFile } from "./sendfile.js";

const INDEX = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const root = await mkdtemp(path.join(tmpdir(), "aiplay-doors-"));
test.after(() => rm(root, { recursive: true, force: true }));

const config = { uiPort: 4173, settingsFile: path.join(root, "appdata", "settings.json"), outputDir: path.join(root, "out") };
const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(INDEX)?.[0] || "";
const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)(config);
const json = (_res, code, body) => ({ code, body });

const HOST = `127.0.0.1:${config.uiPort}`;
/* What Studio's page sends, what MCP's api() sends, and three ways in from outside. */
const PAGE = { headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" } };
const LOCAL = { headers: { host: HOST, "content-type": "application/json" } };
const FOREIGN = [
  ["a cross-site no-cors POST (text/plain, foreign Origin)", { headers: { host: HOST, origin: "https://evil.example", "content-type": "text/plain" } }],
  ["a foreign Origin, even with a JSON type", { headers: { host: HOST, origin: "https://evil.example", "content-type": "application/json" } }],
  ["a rebound DNS name as Host", { headers: { host: `rebind.evil.example:${config.uiPort}`, "content-type": "application/json" } }],
  ["a text/plain body from Studio's own origin", { headers: { host: HOST, origin: `http://${HOST}`, "content-type": "text/plain" } }],
];

/** The route's body from its `if (...) {` line up to the end marker. */
function slice(open, endMarker, { through = false } = {}) {
  const at = INDEX.indexOf(open);
  assert.ok(at >= 0, `index.js has ${open}`);
  const start = at + open.length;
  const end = INDEX.indexOf(endMarker, start);
  assert.ok(end > start, `index.js has ${endMarker} after ${open}`);
  return INDEX.slice(start, through ? end + endMarker.length : end);
}

/* THE GUARD COMES FIRST. For these doors the body is not even read before the
 * question is asked, so no action in them (and no action added to them later)
 * can run for a foreign request. The head of each route, up to and including
 * its readBody line, runs against a readBody that counts. */
const HEADS = [
  ["POST /api/models (every action: folders, overrides, downloads)", 'if (p === "/api/models" && req.method === "POST") {', "const b = await readBody(req);"],
  ["POST /api/settings (the rig Studio launches, the output folder)", 'if (p === "/api/settings" && req.method === "POST") {', "const b = await readBody(req);"],
  ["POST /api/apimode (the paid mode, its cap, its keys)", 'if (p === "/api/apimode" && req.method === "POST") {', "const b = await readBody(req);"],
  ["POST /api/generate (a song, billed in API mode)", 'if (p === "/api/generate" && req.method === "POST") {', "const body = await readBody(req);"],
  ["POST /api/batch (a night of songs, billed with the hosted engine on)", 'if (p === "/api/batch" && req.method === "POST") {', "const b = await readBody(req);"],
  /* Defaults that follow the disk: the music model (model, engine, "auto",
   * LoRAs) and the picture and cover engines are chosen and saved here; the
   * music door's model action also switches the paid hosted engine. */
  ["POST /api/music (the music model, its build, \"auto\", the LoRAs; its model action switches the paid hosted engine)", 'if (p === "/api/music" && req.method === "POST") {',
    '"could not read that body as JSON" });\n      }'],
  ["POST /api/artconfig (the cover and picture engines, \"auto\")", 'if (p === "/api/artconfig" && req.method === "POST") {',
    '"could not read that body as JSON" });\n      }'],
  /* The video engine and every render (and its check), with a capped body. */
  ["POST /api/video (the video engine, a render, its check)", 'if (p === "/api/video" && req.method === "POST") {',
    '"could not read that body as JSON" });\n      }'],
];
for (const [door, open, readLine] of HEADS) {
  test(`${door}: refused before its body is read, from anywhere but Studio's page or a local client`, async () => {
    const head = slice(open, readLine, { through: true });
    const run = new AsyncFunction("req", "res", "json", "sameOriginLocalJson", "readBody", `${head}\nreturn { passed: true };`);
    for (const [what, req] of FOREIGN) {
      let reads = 0;
      const r = await run(req, null, json, sameOriginLocalJson, async () => { reads++; return {}; });
      assert.equal(r?.code, 403, `${what}: 403`);
      assert.equal(reads, 0, `${what}: the body was never read`);
      assert.match(r.body.error, /only (accepted|queued) from Studio's own/, what);
    }
    for (const [what, req] of [["Studio's page", PAGE], ["MCP / chat (no Origin)", LOCAL], ["[::1]", { headers: { host: `[::1]:${config.uiPort}`, "content-type": "application/json" } }]]) {
      let reads = 0;
      const r = await run(req, null, json, sameOriginLocalJson, async () => { reads++; return {}; });
      assert.deepEqual(r, { passed: true }, `${what} gets through`);
      assert.equal(reads, 1);
    }
  });
}

/* THE VIDEO LAB'S DOOR, which lives in server/videolab/routes.js: a comparison
 * switches the engine and queues renders through POST /api/video over loopback
 * (so that door's own guard could be walked around through this one), and
 * set_knob saves video settings, sparse attention among them. The real head of
 * its POST branch, run with the real guard, handed in by index.js. */
test("POST /api/videolab (comparisons, set_knob): refused before its body is read, from anywhere but Studio's page or a local client", async () => {
  const ROUTES = readFileSync(new URL("./videolab/routes.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const open = 'if (req.method !== "POST") {';
  const at = ROUTES.indexOf(open);
  const end = ROUTES.indexOf('"could not read that body as JSON" });\n      return true;\n    }', at);
  assert.ok(at > 0 && end > at, "routes.js has the POST head");
  const head = ROUTES.slice(ROUTES.indexOf("}", at) + 1, end) + '"could not read that body as JSON" });\n      return true;\n    }';
  const run = new AsyncFunction("req", "res", "json", "sameOriginLocalJson", "readBody", `${head}\nreturn { passed: true, b };`);
  for (const [what, req] of FOREIGN) {
    let reads = 0;
    const r = await run(req, null, json, sameOriginLocalJson, async () => { reads++; return {}; });
    assert.equal(r, true, `${what}: answered and handled`);
    assert.equal(reads, 0, `${what}: the body was never read`);
  }
  let said = null;
  const say = (_res, code, body) => { said = { code, body }; };
  await run(FOREIGN[0][1], null, say, sameOriginLocalJson, async () => ({}));
  assert.equal(said.code, 403);
  assert.match(said.body.error, /only accepted from Studio's own page or a local client/);
  await run(PAGE, null, say, undefined, async () => ({}));
  assert.equal(said.code, 403, "a door handed no guard refuses rather than opening");
  for (const [what, req] of [["Studio's page", PAGE], ["MCP / chat (no Origin)", LOCAL]]) {
    let limit = null;
    const r = await run(req, null, json, sameOriginLocalJson, async (_q, max) => { limit = max; return { action: "state" }; });
    assert.deepEqual(r, { passed: true, b: { action: "state" } }, `${what} gets through`);
    assert.equal(limit, 1024 * 1024, "with the body capped at 1 MB");
  }
  const big = await run(PAGE, null, json, sameOriginLocalJson, async () => { throw Object.assign(new Error("body is over 1 MB"), { tooBig: true }); });
  assert.equal(big, true);
  assert.match(ROUTES, /const \{ json, readBody, art, rememberClip, sameOriginLocalJson \} = deps;/);
  assert.match(INDEX, /json, readBody, art, sameOriginLocalJson,\n\s+rememberClip:/, "index.js hands the Video Lab the one guard");
});

test("/api/models keeps ONE guard, at the top: addAlso no longer carries its own copy", () => {
  const route = slice('if (p === "/api/models" && req.method === "POST") {', 'if (p === "/api/', {});
  assert.equal((route.match(/sameOriginLocalJson\(req\)/g) || []).length, 1, "one check for every action");
  assert.equal(INDEX.split("function sameOriginLocalJson(").length, 2, "and one guard function in index.js");
});

/* THE SETTINGS DOOR, whole. Beyond who may ask: a network or device path is
 * refused before anything touches it (the output folder's write probe would
 * already reach a UNC host; the rig's main.py stat too), and the page's own
 * save still works. */
test("POST /api/settings: foreign requests change nothing, network and device paths are refused, the page still saves", async () => {
  const body = slice('if (p === "/api/settings" && req.method === "POST") {',
    'note: "Saved. Restart AIPLAY Studio for this to take effect — the engine is launched with the folder as an argument.",\n      });', { through: true });
  const run = new AsyncFunction("req", "res", "json", "sameOriginLocalJson", "readBody", "path", "mkdir", "writeFile", "unlink", "stat", "readFile", "config",
    `${body}\nreturn { fellThrough: true };`);
  const touched = [];
  const spy = (fn, name) => async (...a) => { touched.push([name, String(a[0])]); return fn(...a); };
  const call = (b, req = PAGE) => run(req, null, json, sameOriginLocalJson, async () => b, path,
    spy(mkdir, "mkdir"), writeFile, unlink, spy(stat, "stat"), readFile, config);
  await mkdir(path.dirname(config.settingsFile), { recursive: true });
  const saved = JSON.stringify({ rig: "C:\\Original\\Rig", outputDir: "C:\\Original\\Out" });
  await writeFile(config.settingsFile, saved);
  const rig = path.join(root, "rig"), out = path.join(root, "renders");
  await mkdir(path.join(rig, "ComfyUI"), { recursive: true });
  await writeFile(path.join(rig, "ComfyUI", "main.py"), "");

  for (const [what, req] of FOREIGN) {
    const r = await call({ rig, outputDir: out }, req);
    assert.equal(r?.code, 403, what);
    assert.equal(await readFile(config.settingsFile, "utf8"), saved, `${what}: settings.json unchanged`);
  }
  for (const bad of ["\\\\evil.example\\share\\rig", "//evil.example/share/rig", "\\\\?\\C:\\rig", "//?/C:/rig", "\\\\.\\C:\\rig"]) {
    for (const key of ["rig", "outputDir"]) {
      touched.length = 0;
      const r = await call({ [key]: bad }, LOCAL);
      assert.equal(r?.code, 400, `${key} ${bad}: refused`);
      assert.match(r.body.error, /not a network or device path/);
      assert.deepEqual(touched, [], `${key} ${bad}: nothing was made or stat'd first`);
    }
  }
  for (const bad of ["renders", "..\\elsewhere", "C:\\ok\nsecond"]) {
    const r = await call({ outputDir: bad }, LOCAL);
    assert.equal(r?.code, 400, `outputDir ${JSON.stringify(bad)}: refused`);
  }
  assert.equal(await readFile(config.settingsFile, "utf8"), saved, "none of it reached settings.json");

  const ok = await call({ rig, outputDir: out });
  assert.equal(ok?.code, 200, JSON.stringify(ok));
  const now = JSON.parse(await readFile(config.settingsFile, "utf8"));
  assert.equal(now.rig, path.resolve(rig));
  assert.equal(now.outputDir, path.resolve(out));
});

/* /api/audio serves any file under the output folder. The Comfy API's results
 * live in outputDir/router and have their own sandboxed door; here they are
 * not served at all, and whatever IS served cannot run as a page. */
test("/api/audio: the Comfy API's folder is not reachable, and every file is served sandboxed and unsniffed", async () => {
  const MIME = new Function(`${/const MIME = \{[\s\S]*?\n\};/.exec(INDEX)[0]}\nreturn MIME;`)();
  const body = slice('if (p.startsWith("/api/audio/")) {', "\n    }\n\n    // ---- static");
  const run = new AsyncFunction("p", "req", "res", "json", "path", "config", "stat", "MIME", "createReadStream", "sendFile", `${body}\nreturn { fellThrough: true };`);
  await mkdir(path.join(config.outputDir, "router"), { recursive: true });
  const svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>";
  await writeFile(path.join(config.outputDir, "router", "v.svg"), svg);
  await writeFile(path.join(config.outputDir, "cover.svg"), svg);
  await writeFile(path.join(config.outputDir, "song.mp3"), Buffer.alloc(64, 7));
  const get = async (p, headers = {}) => {
    const res = new PassThrough();
    res.writeHead = (status, head) => { res.status = status; res.head = head; };
    res.resume();
    const done = new Promise((ok) => res.on("finish", ok));
    const r = await run(p, { method: "GET", headers }, res, json, path, config, stat, MIME, createReadStream, sendFile);
    if (r?.code) return { status: r.code, head: {} };
    await done;
    return res;
  };
  for (const p of ["/api/audio/router/v.svg", "/api/audio/router%2Fv.svg", "/api/audio/router%5Cv.svg", "/api/audio/Router/v.svg",
    "/api/audio/.%2Frouter%2Fv.svg", "/api/audio/router.%2Fv.svg", "/api/audio/router%20%2Fv.svg"]) {
    assert.equal((await get(p)).status, 404, `${p}: the provider's folder has its own door`);
  }
  for (const [p, headers, status] of [["/api/audio/cover.svg", {}, 200], ["/api/audio/song.mp3", {}, 200], ["/api/audio/song.mp3", { range: "bytes=0-9" }, 206], ["/api/audio/song.mp3", { range: "bytes=900-" }, 416]]) {
    const r = await get(p, headers);
    assert.equal(r.status, status, `${p} ${JSON.stringify(headers)}`);
    assert.equal(r.head["Content-Security-Policy"], "sandbox", `${p} ${status}: sandboxed, so an SVG opened as a page runs no script`);
    assert.equal(r.head["X-Content-Type-Options"], "nosniff", `${p} ${status}: never sniffed into HTML`);
  }
  assert.equal((await get("/api/audio/song.mp3", { range: "bytes=0-9" })).head["Accept-Ranges"], "bytes", "scrubbing still works");
});

/* THE SCORE DOORS run a python on a path the body names: the pitch tracker
 * (hum.js, the engine's python) and the song transcriber (which can start a
 * demucs separation first). readBody parses a text/plain body, so without the
 * guard any page could have Studio read a file on this PC. Each door is the
 * real route text; the guard is asked before the body is read. */
test("POST /api/hum and /api/song_to_score: refused before the body is read, from anywhere but Studio's page or a local client", async () => {
  const hum = new AsyncFunction("req", "res", "json", "readBody", "transcribeHum", "refusalFields", "sameOriginLocalJson",
    `${slice('if (p === "/api/hum" && req.method === "POST") {', "\n    }\n\n    /* /api/replace")}\nreturn { fellThrough: true };`);
  const toScore = new AsyncFunction("req", "res", "json", "readBody", "sameOriginLocalJson", "ensureVocalStem", "songToScore",
    "art", "config", "engineDoor", "prov", "path", "refusalFields",
    `${slice('if (p === "/api/song_to_score" && req.method === "POST") {', "\n    }\n\n    /* THE TOKENIZER ON ITS OWN")}\nreturn { fellThrough: true };`);
  const prov = { actorFrom: () => "agent:test" };
  const doors = [
    ["/api/hum", (req, readBody, ran) => hum(req, null, json, readBody, async () => { ran.push("tracker"); return { abc: "X:1" }; }, () => ({}), sameOriginLocalJson)],
    ["/api/song_to_score", (req, readBody, ran) => toScore(req, null, json, readBody, sameOriginLocalJson, async () => { ran.push("stem"); return {}; },
      async () => { ran.push("transcriber"); return { abc: "X:1" }; }, {}, { stems: {} }, {}, prov, path, () => ({}))],
  ];
  for (const [door, call] of doors) {
    for (const [what, req] of FOREIGN) {
      let reads = 0; const ran = [];
      const r = await call(req, async () => { reads++; return { source: { path: "C:/Users/someone/private.wav" } }; }, ran);
      assert.equal(r?.code, 403, `${door}, ${what}: 403`);
      assert.match(r.body.error, /only accepted from Studio's own page or a local client/, `${door}, ${what}`);
      assert.equal(reads, 0, `${door}, ${what}: the body was never read`);
      assert.deepEqual(ran, [], `${door}, ${what}: no python ran`);
    }
    for (const [what, req] of [["Studio's page", PAGE], ["MCP / chat (no Origin)", LOCAL]]) {
      const ran = [];
      const r = await call(req, async () => ({ source: { path: "C:/h.wav" } }), ran);
      assert.equal(r?.code, 200, `${door}, ${what} gets through: ${JSON.stringify(r)}`);
      assert.equal(ran.length, 1, `${door}, ${what}: it ran`);
    }
  }
});

/* The two settings doors read a few names, never a file: a 64 KB cap before
 * JSON.parse, a 413 that says so, and a foreign request still refused first. */
test("POST /api/music and /api/artconfig cap their bodies at 64 KB: 413 before JSON.parse", async () => {
  for (const open of ['if (p === "/api/music" && req.method === "POST") {', 'if (p === "/api/artconfig" && req.method === "POST") {']) {
    const head = slice(open, '"could not read that body as JSON" });\n      }', { through: true });
    assert.match(head, /b = await readBody\(req, 64 \* 1024\)/, open);
    const run = new AsyncFunction("req", "res", "json", "sameOriginLocalJson", "readBody", `${head}\nreturn { passed: true, b };`);
    let limit = null;
    const ok = await run(PAGE, null, json, sameOriginLocalJson, async (_q, max) => { limit = max; return { action: "x" }; });
    assert.deepEqual(ok, { passed: true, b: { action: "x" } });
    assert.equal(limit, 64 * 1024, "the cap reaches readBody");
    const big = await run(PAGE, null, json, sameOriginLocalJson, async () => { throw Object.assign(new Error("body is over 64 KB"), { tooBig: true }); });
    assert.equal(big.code, 413);
    assert.match(big.body.error, /too large \(body is over 64 KB\)/);
  }
});

test("POST /api/song_to_score caps its body like /api/hum: 413 before JSON.parse", async () => {
  const body = slice('if (p === "/api/song_to_score" && req.method === "POST") {', "\n    }\n\n    /* THE TOKENIZER ON ITS OWN");
  assert.match(body, /b = await readBody\(req, 72 \* 1024 \* 1024\)/);
  assert.match(body, /if \(err\.tooBig\) return json\(res, 413,/);
});
