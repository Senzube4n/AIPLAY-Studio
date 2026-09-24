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
  /* Defaults that follow the disk: the music model (model, engine, "auto",
   * LoRAs) and the picture and cover engines are chosen and saved here. */
  ["POST /api/music (the music model, its build, \"auto\", the LoRAs)", 'if (p === "/api/music" && req.method === "POST") {', "const b = await readBody(req);"],
  ["POST /api/artconfig (the cover and picture engines, \"auto\")", 'if (p === "/api/artconfig" && req.method === "POST") {', "const b = await readBody(req);"],
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
  const run = new AsyncFunction("p", "req", "res", "json", "path", "config", "stat", "MIME", "createReadStream", `${body}\nreturn { fellThrough: true };`);
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
    const r = await run(p, { method: "GET", headers }, res, json, path, config, stat, MIME, createReadStream);
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
