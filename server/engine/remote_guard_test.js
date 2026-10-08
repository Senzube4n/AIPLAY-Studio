/**
 * /api/runpod ANSWERS ONLY THIS PC'S OWN STUDIO, AND "DON'T RECORD THE
 * PROMPT" HOLDS ON THE POD PATH TOO (review of 40f5859, 2026-09-25).
 *
 *   §1 the Host: a page on a rebound DNS name sends a same-origin GET with no
 *      Origin, which the Origin rule never saw. It read the job labels (the
 *      first words of every prompt), the balance and Pod IDs, and the renders.
 *   §2 every JSON POST is behind index.js sameOriginLocalJson, the house guard;
 *      a reference upload keeps its own body and still needs this Host.
 *   §3 a private image: the delegate line keeps the shape and loses the words
 *      (record.js, as the local door does), the label keeps only its kind, and
 *      the graph leaves jobs.json once the worker has it.
 *   §4 ...and the picture itself: ComfyUI's SaveImage on the Pod wrote the
 *      graph into the PNG's text chunks; a private one is stripped before it
 *      is adopted, and a later download pass knows the stripped file.
 *   §5 a Pod picture or clip carries the wordless fingerprint a local render
 *      carries (safety/lineage.js), private ones too, so "make her nude" on a
 *      picture rendered on the Pod as a child is refused back in full mode.
 *   §6 the Pod's install command is this Studio's repository at its own
 *      commit, with the script's sha256 (a clone's HEAD, or the full commit a
 *      Setup.exe install records in install-info.json); the script installs
 *      nothing without a pinned commit and never follows a branch (review S2,
 *      still open on 7b241ea, whose page and script followed `main`).
 *
 * Temp folders and a stubbed worker only: no network, no GPU, no RunPod.
 *
 *   node --test server/engine/remote_guard_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createRemoteRoutes } from "./remote-routes.js";
import { createRemoteClient } from "./remote-client.js";
import { createEngineRoutes } from "./routes.js";
import { LineageMap, lineageOf } from "../safety/lineage.js";
import { checkPrompt } from "../safety/minors.js";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as bootstrapModule from "./runpod-bootstrap.js";
const { bootstrapCommand, studioBootstrap, BOOTSTRAP_SCRIPT } = bootstrapModule;
/* The one repository a Pod installs from (the owner, 2026-09-26). */
const OFFICIAL_REPO = "Senzube4n/AIPLAY-Studio";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
/* The real guard, lifted out of index.js (cross-origin-doors_test does the same). */
const guardSrc = /function sameOriginLocalJson\(req\) \{[\s\S]*?\n\}/.exec(read("server", "index.js"))?.[0] || "";
const sameOriginLocalJson = new Function("config", `${guardSrc}\nreturn sameOriginLocalJson;`)({ uiPort: 4173 });

async function routes(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-guard-"));
  const r = createRemoteRoutes({ config: { dataDir: dir, outputDir: path.join(dir, "out"), uiPort: 4173 },
    getSecret: async () => null, setSecret: async () => {}, clearSecret: async () => {},
    append: async () => {}, actorFrom: () => "agent:t", adopt: async () => null, sameOriginLocalJson,
    fetchFn: async () => { throw new Error("no network in this test"); } });
  t.after(async () => { (await r.start()).close(); await rm(dir, { recursive: true, force: true }); });
  return async (method, route, { headers = {}, body = null } = {}) => {
    const req = Object.assign(Readable.from(body == null ? [] : [Buffer.from(body)]), { method, headers });
    const res = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(b) { this.body = b ? JSON.parse(b) : null; }, destroy() {} };
    await r(req, res, new URL(`http://127.0.0.1:4173${route}`));
    return res;
  };
}
const HERE = { host: "127.0.0.1:4173" };

test("§1 a request whose Host is not this PC's Studio is refused, GETs included", async (t) => {
  const call = await routes(t);
  for (const host of ["evil.example:4173", "127.0.0.1.nip.io:4173", "", "127.0.0.1:8080"]) {
    for (const route of ["/api/runpod", "/api/runpod/account/overview", "/api/runpod/jobs/00000000-0000-4000-8000-000000000000/files/0"]) {
      const res = await call("GET", route, { headers: { host } });
      assert.equal(res.status, 403, `${host || "no Host"} ${route}`);
    }
  }
  for (const host of ["127.0.0.1:4173", "localhost:4173", "[::1]:4173"]) {
    const res = await call("GET", "/api/runpod", { headers: { host } });
    assert.equal(res.status, 200, `${host}: Studio's own page still reads its status`);
    assert.equal(Array.isArray(res.body.jobs), true);
  }
});

test("§2 JSON POSTs need the house guard; a reference upload needs this Host and its own rules", async (t) => {
  const call = await routes(t);
  const json = { ...HERE, "content-type": "application/json", "x-aiplay-actor": "agent:t" };
  const graph = JSON.stringify({ graph: { 1: { class_type: "SaveImage", inputs: {} } } });
  /* text/plain is what a cross-site page can send with no preflight. */
  assert.equal((await call("POST", "/api/runpod/jobs", { headers: { ...json, "content-type": "text/plain" }, body: graph })).status, 403);
  assert.equal((await call("POST", "/api/runpod/account/pods", { headers: { ...json, "content-type": "text/plain" }, body: "{}" })).status, 403, "creating a paid Pod too");
  assert.equal((await call("POST", "/api/runpod/jobs", { headers: { ...json, origin: "https://evil.example" }, body: graph })).status, 403, "a foreign Origin");
  assert.equal((await call("POST", "/api/runpod/jobs", { headers: { ...json, host: "evil.example:4173", origin: "http://evil.example:4173" }, body: graph })).status, 403, "a rebound page");
  const ok = await call("POST", "/api/runpod/jobs", { headers: json, body: graph });
  assert.notEqual(ok.status, 403, "Studio's own JSON reaches the route");
  assert.match(ok.body.error, /Connect a RunPod worker first/);
  const upload = await call("POST", "/api/runpod/assets?name=ref.png", { headers: { ...HERE, "content-type": "image/png", "x-aiplay-actor": "agent:t" }, body: "png" });
  assert.notEqual(upload.status, 403, "a reference upload is not JSON and is not refused for it");
  assert.equal((await call("POST", "/api/runpod/assets?name=ref.png", { headers: { host: "evil.example:4173", "content-type": "image/png", "x-aiplay-actor": "agent:t" }, body: "png" })).status, 403);
  assert.equal((await call("POST", "/api/runpod/assets?name=ref.png", { headers: { ...HERE, "content-type": "image/png" }, body: "png" })).status, 403,
    "and still needs an Origin or x-aiplay-actor");
  const index = read("server", "index.js");
  assert.match(index, /const remoteRoutes = config\.remoteOnly \? createRemoteRoutes\(\{[^}]*sameOriginLocalJson,/, "index.js hands over the one guard");
  assert.throws(() => createRemoteRoutes({ config: {}, append: async () => {} }), /sameOriginLocalJson/, "and the routes refuse to exist without it");
});

test("§3 a private image: no words in the ledger, the label or jobs.json once the worker has it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-private-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [];
  const WORDS = "a red fox under a paper lantern";
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const answer = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/v1/health") return answer({ protocol: 1, workerId: "w-1", ready: true });
    if (u.pathname === "/v1/jobs" && init.method === "POST") return answer({ id: JSON.parse(init.body).id, state: "queued" });
    return new Response("{}", { status: 404 });
  };
  const client = await createRemoteClient({ dataDir: dir, outputDir: path.join(dir, "out"), getToken: async () => null, setToken: async () => {},
    append: async (_s, e) => { events.push(e); }, fetchFn, pollMs: 3_600_000 });
  t.after(() => client.close());
  await client.connect({ url: "http://127.0.0.1:9", token: "k".repeat(40) });
  const graph = { 1: { class_type: "CLIPTextEncode", inputs: { text: WORDS, clip: ["2", 0] } }, 2: { class_type: "CLIPLoader", inputs: { clip_name: "c.safetensors" } },
    3: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } };
  const job = await client.submit({ graph, label: `AIPLAY image · ${WORDS}`, private: true });
  assert.equal(job.label, "AIPLAY image · prompt not recorded", "the label keeps its kind, which the page finds its jobs by");
  const delegate = events.find((e) => e.type === "delegate");
  assert.ok(delegate);
  assert.equal(JSON.stringify(delegate).includes("red fox"), false, "the delegate line has no words");
  assert.equal(delegate.data.label, null);
  assert.equal(delegate.data.prompt, null);
  assert.deepEqual(delegate.data.redacted, ["prompt", "negative", "texts", "promptHash", "negativeHash", "label", "graphHash"]);
  assert.equal(delegate.data.graphHash, null, "nor the graph's hash, a lookup key for a guessed prompt (record.js)");
  await client.tick();
  const saved = await readFile(path.join(dir, "runpod", "jobs.json"), "utf8");
  assert.equal(client.status().jobs[0].state, "queued", "the worker has it");
  assert.equal(saved.includes("red fox"), false, "and jobs.json no longer holds the graph's words");
  assert.equal(JSON.stringify(client.status()).includes("red fox"), false, "nor does the status the page reads");

  /* A job that is not private keeps what it always kept. */
  const open = await client.submit({ graph, label: `AIPLAY image · ${WORDS}` });
  assert.equal(open.label, `AIPLAY image · ${WORDS}`);
  assert.equal(events.filter((e) => e.type === "delegate")[1].data.prompt, WORDS);

  /* The page sends the switch, and a private label without words. */
  const page = read("web", "runpod-integrated.js");
  assert.match(page, /isPrivate = !!\$\("imgPrivate"\)\?\.checked;/);
  assert.match(page, /label = isPrivate \? "AIPLAY image · prompt not recorded" : /);
  assert.match(page, /api\("\/jobs", \{ graph: built\.graph, bindings: \[\], label, \.\.\.\(isPrivate \? \{ private: true \} : \{\}\) \}\)/);
  assert.match(read("server", "engine", "remote-routes.js"), /private: b\.private === true/);
});

/* A one-pixel PNG with ComfyUI's "prompt" text chunk holding the graph, and
 * the app's own XMP disclosure, which a strip keeps. */
function comfyPng(words) {
  const crc32 = (buf) => { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`prompt\0{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"${words}"}}}`, "latin1")),
    chunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>trainedAlgorithmicMedia</x:xmpmeta>", "latin1")),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}
const graphOf = (words) => ({ 1: { class_type: "CLIPTextEncode", inputs: { text: words, clip: ["2", 0] } }, 2: { class_type: "CLIPLoader", inputs: { clip_name: "c.safetensors" } },
  3: { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } });

/* A mock worker that finishes every job with the given outputs; `fail` makes
 * the named file's first download fail once. */
async function podClient(t, { outputs, adopt, fail = null }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-pod-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetched = {};
  const manifest = outputs.map((o, i) => ({ id: String(i), filename: o.filename, kind: o.kind, bytes: o.bytes.length,
    sha256: createHash("sha256").update(o.bytes).digest("hex") }));
  let failed = false;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const answer = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/v1/health") return answer({ protocol: 1, workerId: "w-1", ready: true });
    if (u.pathname === "/v1/jobs" && init.method === "POST") return answer({ id: JSON.parse(init.body).id, state: "completed", outputs: manifest });
    const job = /^\/v1\/jobs\/([^/]+)$/.exec(u.pathname);
    if (job) return answer({ id: job[1], state: "completed", outputs: manifest });
    const file = /\/files\/(\d+)$/.exec(u.pathname);
    if (file) {
      fetched[file[1]] = (fetched[file[1]] || 0) + 1;
      if (fail === file[1] && !failed) { failed = true; return new Response("{}", { status: 500 }); }
      return new Response(outputs[Number(file[1])].bytes, { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const client = await createRemoteClient({ dataDir: dir, outputDir: path.join(dir, "out"), getToken: async () => null, setToken: async () => {},
    append: async () => {}, adopt, fetchFn, pollMs: 3_600_000 });
  t.after(() => client.close());
  await client.connect({ url: "http://127.0.0.1:9", token: "k".repeat(40) });
  return { client, dir, fetched };
}

test("§4 a private picture from the Pod is adopted without the prompt inside it; an open one keeps what it always kept", async (t) => {
  const WORDS = "a red fox under a paper lantern";
  const png = comfyPng(WORDS);
  const seen = [];
  const { client, dir, fetched } = await podClient(t, { outputs: [{ filename: "runpod_00001_.png", kind: "images", bytes: png },
    { filename: "runpod_00002_.png", kind: "images", bytes: png }], fail: "1",
    adopt: async (d) => { seen.push(d); return null; } });
  await client.submit({ graph: graphOf(WORDS), label: `AIPLAY image · ${WORDS}`, private: true });
  await client.tick();                     // the first picture lands, the second's download fails once
  const first = await readFile(path.join(dir, "out", seen[0].output.localFile));
  assert.equal(first.includes(Buffer.from(WORDS, "latin1")), false, "the picture on this PC has no words in it");
  assert.equal(first.includes(Buffer.from("trainedAlgorithmicMedia", "latin1")), true, "and keeps the app's own disclosure");
  assert.equal(seen[0].spec.private, true, "adopt hears it is private");
  await client.tick();                     // the retry: the stripped first picture is known, not fetched again
  assert.equal(client.status().jobs[0].state, "completed");
  assert.equal(fetched["0"], 1, "the stripped picture is not downloaded again");
  assert.equal(seen.filter((d) => d.output.id === "0").length, 1, "nor adopted twice");
  const second = await readFile(path.join(dir, "out", seen.at(-1).output.localFile));
  assert.equal(second.includes(Buffer.from(WORDS, "latin1")), false);

  const open = await podClient(t, { outputs: [{ filename: "runpod_00003_.png", kind: "images", bytes: png }],
    adopt: async (d) => { seen.push(d); return null; } });
  await open.client.submit({ graph: graphOf(WORDS), label: `AIPLAY image · ${WORDS}` });
  await open.client.tick();
  const kept = await readFile(path.join(open.dir, "out", seen.at(-1).output.localFile));
  assert.equal(kept.equals(png), true, "a picture that is not private arrives byte for byte");
});

test("§5 a Pod render carries its wordless fingerprint into the library, and an edit is judged with it", async (t) => {
  const lib = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-lineage-"));
  t.after(() => rm(lib, { recursive: true, force: true }));
  const IMAGE_DIR = path.join(lib, "images"), CLIP_DIR = path.join(lib, "clips");
  await mkdir(IMAGE_DIR, { recursive: true });
  const rows = (n) => [imageMeta.get(n), clipMeta.get(n)].filter(Boolean);
  const imageMeta = new LineageMap(rows), clipMeta = new LineageMap(rows);
  const cfg = { outputDir: null, uiPort: 4173 };
  const engineRoutes = createEngineRoutes({ json: () => {}, readBody: async () => ({}), config: cfg,
    provenance: {}, engine: { store: {} }, IMAGE_DIR, CLIP_DIR,
    rememberClip: (n, _s, meta) => clipMeta.set(n, { ...(clipMeta.get(n) || {}), ...meta }),
    rememberImage: (n, meta) => imageMeta.set(n, { ...(imageMeta.get(n) || {}), ...meta }) });
  const CHILD = "a girl, age 9, at the beach";
  assert.equal(checkPrompt([CHILD]).ok, true, "the render itself passes");
  assert.equal(checkPrompt(["make her nude"]).ok, true, "and the edit's words alone pass: only the picture's history refuses it");
  for (const [k, priv] of [["open", false], ["private", true]]) {
    const { client, dir } = await podClient(t, { outputs: [{ filename: `${k}_00001_.png`, kind: "images", bytes: comfyPng(CHILD) }],
      adopt: (d) => engineRoutes.adopt(d) });
    cfg.outputDir = path.join(dir, "out");
    await client.submit({ graph: graphOf(CHILD), label: `AIPLAY image · ${CHILD}`, ...(priv ? { private: true } : {}) });
    await client.tick();
    const adopted = client.status().jobs[0].outputs[0].adoptedAs;
    assert.equal(adopted, `images/0-${k}_00001_.png`, `${k}: adopted into the pictures`);
    const row = imageMeta.get(`0-${k}_00001_.png`);
    assert.ok(row, `${k}: the picture has a row`);
    assert.equal(row.safety.minor, true, `${k}: its fingerprint says what it was made as`);
    assert.equal(JSON.stringify(row).includes("age 9"), !priv, `${k}: ${priv ? "no words" : "the words, as a local render keeps them"}`);
    const lin = lineageOf([`0-${k}_00001_.png`], rows);
    assert.equal(checkPrompt(["make her nude"], { context: lin.texts, flags: lin.flags }).ok, false,
      `${k}: "make her nude" on it is refused in full mode`);
  }
  /* A clip: its row carries the fingerprint, and a private one no words. */
  const { client, dir } = await podClient(t, { outputs: [{ filename: "clip_00001_.mp4", kind: "videos", bytes: Buffer.from("mp4") }],
    adopt: (d) => engineRoutes.adopt(d) });
  cfg.outputDir = path.join(dir, "out");
  await client.submit({ graph: graphOf(CHILD), label: `AIPLAY video · ${CHILD}`, private: true });
  await client.tick();
  assert.equal(clipMeta.get("0-clip_00001_.mp4")?.safety?.minor, true);
  assert.equal(clipMeta.get("0-clip_00001_.mp4")?.prompt, null);
  /* The door hands the fingerprint over; a local door run hands none and adopts as before. */
  const rc = read("server", "engine", "remote-client.js");
  assert.match(rc, /spec: \{ private: job\.private === true, safety \}/);
  assert.match(read("server", "index.js"), /const engineRoutes = createEngineRoutes\(\{[\s\S]*?rememberImage: \(name, meta\) => \{[\s\S]*?imageMeta\.set\(name,/,
    "index.js gives the engine routes the picture rows");
});

test("§6 the Pod's install command is this Studio's commit, checked, and the script follows no branch", async (t) => {
  const SHA = "3".repeat(64), C = "a".repeat(40);
  const cmd = bootstrapCommand({ repo: "Senzube4n/AIPLAY-Studio", commit: C, scriptSha256: SHA });
  assert.equal(cmd, `curl -fsSL https://raw.githubusercontent.com/Senzube4n/AIPLAY-Studio/${C}/worker/bootstrap-runpod.sh -o /tmp/aiplay-bootstrap.sh`
    + ` && echo "${SHA}  /tmp/aiplay-bootstrap.sh" | sha256sum -c -`
    + ` && AIPLAY_REPOSITORY=https://github.com/Senzube4n/AIPLAY-Studio.git AIPLAY_COMMIT=${C} bash /tmp/aiplay-bootstrap.sh`,
    "fetched from the commit, checked before it runs, and told the commit");
  for (const bad of [{ repo: "a/b; rm -rf /", commit: C, scriptSha256: SHA }, { repo: "a/b", commit: "main", scriptSha256: SHA },
    { repo: "a/b", commit: C.slice(0, 7), scriptSha256: SHA }, { repo: "a/b", commit: C, scriptSha256: "x" }]) {
    assert.throws(() => bootstrapCommand(bad), undefined, JSON.stringify(bad));
  }
  /* From this checkout: the build's own repository and HEAD, and the sha256
   * of the script blob at that commit (what raw.githubusercontent serves). */
  const here = studioBootstrap();
  if (here.command) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    assert.equal(here.commit, head);
    const blob = execFileSync("git", ["cat-file", "blob", `${head}:${BOOTSTRAP_SCRIPT}`], { cwd: ROOT });
    assert.equal(here.scriptSha256, createHash("sha256").update(blob).digest("hex"));
    assert.match(here.command, new RegExp(`/${head}/worker/bootstrap-runpod\\.sh `));
  }
  /* No git checkout and no install-info.json: no command, and it says why. */
  const none = studioBootstrap({ root: path.join(os.tmpdir(), "no-such-studio"), version: () => ({ repo: "Senzube4n/AIPLAY-Studio" }) });
  assert.equal(none.command, null);
  assert.match(none.problem, /cannot name the commit it runs from/);
  /* ALWAYS Senzube4n/AIPLAY-Studio (the owner's approval, 2026-09-26). A
   * build that names another repository (a contributor's fork, which the
   * updater picks when it is ahead) still installs this commit from the
   * official one, and says so; it never clones the fork. */
  assert.equal(bootstrapModule.OFFICIAL_REPO, OFFICIAL_REPO);
  const fromFork = studioBootstrap({ version: () => ({ repo: "bani4kaskashka/AIPLAY-Studio-Bucky-Fork" }) });
  assert.equal(fromFork.repo, OFFICIAL_REPO);
  if (fromFork.command) {
    assert.match(fromFork.command, /raw\.githubusercontent\.com\/Senzube4n\/AIPLAY-Studio\//);
    assert.doesNotMatch(fromFork.command, /Bucky-Fork/);
  }
  assert.match(fromFork.note || "", /built from bani4kaskashka\/AIPLAY-Studio-Bucky-Fork; the Pod installs only from Senzube4n\/AIPLAY-Studio/);
  assert.equal(studioBootstrap({ version: () => ({ repo: OFFICIAL_REPO }) }).note, null, "the official build says nothing more");
  /* A Setup.exe install has no .git: the installer (and the launcher's
   * updater) record the repository and the FULL commit in install-info.json,
   * and the install's own copy of the script is what the Pod checks against. */
  const setup = await mkdtemp(path.join(os.tmpdir(), "aiplay-setup-install-"));
  t.after(() => rm(setup, { recursive: true, force: true }));
  const { writeFile } = await import("node:fs/promises");
  const script = Buffer.from("#!/usr/bin/env bash\necho pinned\n");
  await writeFile(path.join(setup, "install-info.json"), JSON.stringify({ repo: "Senzube4n/AIPLAY-Studio", commit: C, branch: "main" }));
  const noScript = studioBootstrap({ root: setup, version: () => ({ repo: "someone/else" }) });
  assert.equal(noScript.command, null, "no local script, nothing to check the Pod's copy against");
  assert.match(noScript.problem, /no worker\/bootstrap-runpod\.sh to check/);
  await mkdir(path.join(setup, "worker"), { recursive: true });
  await writeFile(path.join(setup, "worker", "bootstrap-runpod.sh"), script);
  const installed = studioBootstrap({ root: setup, version: () => ({ repo: "someone/else" }) });
  assert.equal(installed.repo, "Senzube4n/AIPLAY-Studio", "the repository the installer recorded, the one that holds that commit");
  assert.equal(installed.commit, C);
  assert.equal(installed.scriptSha256, createHash("sha256").update(script).digest("hex"));
  assert.equal(installed.command, bootstrapCommand({ repo: "Senzube4n/AIPLAY-Studio", commit: C, scriptSha256: installed.scriptSha256 }));
  /* Setup.exe or the updater recorded the fork: the same commit, from the
   * official repository, so the Pod's checkout keeps one origin whichever
   * build the updater picks next (it stopped at "a different Git origin"). */
  await writeFile(path.join(setup, "install-info.json"), JSON.stringify({ repo: "bani4kaskashka/AIPLAY-Studio-Bucky-Fork", commit: C, branch: "main" }));
  const forked = studioBootstrap({ root: setup });
  assert.equal(forked.command, bootstrapCommand({ repo: OFFICIAL_REPO, commit: C, scriptSha256: installed.scriptSha256 }));
  assert.match(forked.note, /A commit that is only on bani4kaskashka\/AIPLAY-Studio-Bucky-Fork is refused on the Pod/);
  assert.match(read("web", "runpod-integrated.js"), /\(b\.note \? ` \$\{b\.note\}` : ""\)/, "the window says it");
  for (const info of [{ repo: "Senzube4n/AIPLAY-Studio", commit: C.slice(0, 7) }, { repo: "Senzube4n/AIPLAY-Studio", commit: "main" },
    { repo: "a/b; rm -rf /", commit: C }, { commit: C }]) {
    await writeFile(path.join(setup, "install-info.json"), JSON.stringify(info));
    assert.equal(studioBootstrap({ root: setup }).command, null, `never pinned to ${JSON.stringify(info)}`);
  }
  assert.ok(JSON.parse(read("install.json")).include.includes("worker"), "Setup.exe and the updater unpack the worker folder, so the script is here to check");
  /* The route serves it, behind the Host rule like every /api/runpod GET. */
  const call = await routes(t);
  const got = await call("GET", "/api/runpod/bootstrap", { headers: HERE });
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.body).sort(), ["command", "commit", "note", "problem", "repo", "scriptSha256"]);
  assert.equal((await call("GET", "/api/runpod/bootstrap", { headers: { host: "evil.example:4173" } })).status, 403);

  /* The script: a repository and a full commit, or nothing at all. */
  const sh = read("worker", "bootstrap-runpod.sh");
  assert.match(sh, /git -C "\$ROOT" fetch --depth 1 origin "\$COMMIT"/, "the commit itself");
  assert.match(sh, /git -C "\$ROOT" remote add origin "\$REPO"/, "from the named repository");
  assert.match(sh, /different Git origin/, "a checkout of another repository is never reused");
  assert.match(sh, /git -C "\$ROOT" checkout -q --force --detach FETCH_HEAD/);
  assert.match(sh, /if \[\[ "\$\(git -C "\$ROOT" rev-parse HEAD\)" != "\$COMMIT" \]\]; then[\s\S]{0,120}exit 1/, "nothing starts on another commit");
  assert.ok(sh.indexOf('if [[ ! "$COMMIT" =~ ^[0-9a-f]{40}$') < sh.indexOf("mkdir -p"), "refused before anything is written");
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.status === 0) {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-boot-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const env of [{}, { AIPLAY_REPOSITORY: "https://github.com/x/y.git", AIPLAY_BRANCH: "main" },
      { AIPLAY_REPOSITORY: "https://github.com/x/y.git", AIPLAY_COMMIT: "main" }, { AIPLAY_COMMIT: C }]) {
      const r = spawnSync("bash", [path.join(ROOT, "worker", "bootstrap-runpod.sh")], { encoding: "utf8",
        env: { ...process.env, AIPLAY_REPOSITORY: "", AIPLAY_COMMIT: "", AIPLAY_WORKER_SOURCE: path.join(root, "src"),
          AIPLAY_WORKER_STATE: path.join(root, "state"), AIPLAY_RUNTIME: path.join(root, "rt"), ...env } });
      assert.equal(r.status, 1, JSON.stringify(env));
      assert.match(r.stderr, /Run the command AIPLAY Studio shows on its RunPod screen/);
      assert.equal(existsSync(path.join(root, "src")) || existsSync(path.join(root, "state")), false, "and nothing was installed");
    }
  }
});

/* §7 THE POD'S OWN DISK (review of the port, 2026-10-08). §3 and §4 kept the
 * words off this PC; on the Pod the worker's state file kept the whole graph
 * for ever and ComfyUI's PNG kept its "prompt" text chunk, on the persistent
 * /workspace volume, and the record's graphHash (and the worker's
 * executedGraphHash) confirmed a guessed prompt by rebuilding the Images
 * screen's deterministic graph. The REAL worker against a fake ComfyUI whose
 * SaveImage writes the graph into the PNG, and the REAL client. */
test("§7 a private render leaves no words on the Pod either, and no hash that confirms a guess", async (t) => {
  const http = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { readdir, writeFile } = await import("node:fs/promises");
  const { createWorker } = await import("../../worker/runpod-worker.js");
  const { sendJSON, readBody, digest } = await import("./remote-common.js");
  const { checkpointGraph } = await import("../workflow.js");
  const { sortedJSON, sha256 } = await import("./record.js");
  const SECRET = "a red fox under a paper lantern at midnight";
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-pod-disk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "pod-input"), outputDir = path.join(root, "pod-output"), stateDir = path.join(root, "pod-state");
  await Promise.all([inputDir, outputDir].map((d) => mkdir(d, { recursive: true })));
  const history = {}, deleted = [], known = new Set();
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    if (url.pathname === "/system_stats") return sendJSON(res, 200, { system: { comfyui_version: "test" }, devices: [] });
    if (url.pathname === "/object_info") return sendJSON(res, 200, Object.fromEntries([...known].map((c) => [c, { input: { required: {} } }])));
    if (url.pathname === "/prompt") {
      const b = JSON.parse((await readBody(req)).toString());
      const id = randomUUID();
      const save = Object.entries(b.prompt).find(([, n]) => n.class_type === "SaveImage");
      const rel = `${save[1].inputs.filename_prefix}_00001_.png`;
      await mkdir(path.dirname(path.join(outputDir, rel)), { recursive: true });
      await writeFile(path.join(outputDir, rel), comfyPng(JSON.stringify(b.prompt).replace(/"/g, "'")));
      history[id] = { prompt: [0, id, b.prompt, b.extra_data], status: { completed: true, status_str: "success" },
        outputs: { [save[0]]: { images: [{ filename: path.posix.basename(rel), subfolder: path.posix.dirname(rel), type: "output" }] } } };
      return sendJSON(res, 200, { prompt_id: id });
    }
    if (url.pathname === "/history" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString());
      for (const id of b.delete || []) { deleted.push(id); delete history[id]; }
      res.writeHead(200); return res.end();
    }
    if (url.pathname === "/queue") return sendJSON(res, 200, { queue_running: [], queue_pending: [] });
    if (url.pathname.startsWith("/history")) { const id = url.pathname.split("/")[2]; return sendJSON(res, 200, id ? (history[id] ? { [id]: history[id] } : {}) : history); }
    sendJSON(res, 404, {});
  });
  const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));
  const comfyURL = await listen(fake);
  const TOKEN = "remote-guard-worker-token-32-characters-long";
  const worker = await createWorker({ token: TOKEN, comfyURL, inputDir, outputDir, stateDir, pollMs: 3_600_000, modelBundles: {} });
  const workerURL = await listen(worker.server);
  t.after(async () => { await worker.close(); await new Promise((r) => fake.close(r)); });
  const ledger = [];
  const client = await createRemoteClient({ dataDir: path.join(root, "pc-data"), outputDir: path.join(root, "pc-output"),
    getToken: async () => null, setToken: async () => {}, append: async (_k, e) => { ledger.push(e); }, adopt: async () => null, pollMs: 3_600_000 });
  t.after(() => client.close());
  await client.connect({ url: workerURL, token: TOKEN });
  /* What the Images screen sends in RunPod mode with the switch on. */
  const options = { ckpt: "sd15.safetensors", width: 512, height: 512, steps: 20, seed: 4242, negative: "", cfg: 6, prefix: "runpod" };
  const graph = checkpointGraph({ ...options, prompt: SECRET });
  for (const n of Object.values(graph)) known.add(n.class_type);
  const podState = () => readFile(path.join(stateDir, "jobs.json"), "utf8");
  const words = (s) => String(s).includes(SECRET) || String(s).includes("paper lantern");

  const sent = await client.submit({ graph, bindings: [], label: "AIPLAY image · prompt not recorded", actor: "user", private: true });
  await client.tick();                                     // PC -> worker
  const kept = JSON.parse(await podState()).jobs[sent.id];
  assert.equal(kept.private, true, "the worker hears it is private");
  assert.notEqual(kept.requestHash, digest({ id: sent.id, graph, bindings: [], private: true }),
    "its request is remembered by a keyed hash, not sha256 of the graph");
  await worker.tick();                                     // worker -> ComfyUI
  assert.equal(words(await podState()), false, "once ComfyUI has it, the worker's state on the volume holds no words");
  await worker.tick();                                     // outputs frozen
  const podDir = path.join(outputDir, "aiplay_remote", sent.id);
  const [podPng] = await readdir(podDir);
  assert.equal((await readFile(path.join(podDir, podPng))).includes(Buffer.from("paper lantern", "latin1")), false,
    "the Pod's own PNG lost ComfyUI's text chunks before it was hashed");
  const status = await (await fetch(`${workerURL}/v1/jobs/${sent.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(status.executedGraphHash, null, "the worker reports no executed-graph hash for it");
  await client.tick();                                     // PC downloads, then asks the worker to forget
  const job = client.status().jobs.find((j) => j.id === sent.id);
  assert.equal(job.state, "completed", job.error || "");
  assert.equal((await readFile(path.join(root, "pc-output", job.outputs[0].localFile))).includes(Buffer.from("paper lantern", "latin1")), false);
  assert.deepEqual(await readdir(podDir).catch(() => []), [], "once the PC has its copy, the Pod's output is gone");
  assert.equal(deleted.length, 1, "and ComfyUI's history entry, which holds the graph in its memory, is deleted");
  const after = JSON.parse(await podState()).jobs[sent.id];
  assert.equal(after.forgotten, true);
  assert.equal(words(JSON.stringify(after)), false);
  assert.deepEqual(after.outputs, []);
  /* The ledger: no words, and no hash a guess can be checked against. */
  const delegate = ledger.find((e) => e.type === "delegate" && e.asset === `engine/${sent.runId}`).data;
  const generate = ledger.find((e) => e.type === "generate" && e.asset === `engine/${sent.runId}`).data;
  assert.equal(words(JSON.stringify(ledger)), false);
  assert.equal(delegate.graphHash, null);
  assert.equal(generate.remote.executedGraphHash, null);
  const guess = checkpointGraph({ ...options, prompt: SECRET });
  assert.equal(JSON.stringify(ledger).includes(sha256(sortedJSON(guess)).slice(7)), false, "the right guess's hash is nowhere in the ledger");

  /* An open render keeps what it always kept: the graph on the worker, its
   * hashes, the PNG as ComfyUI wrote it, and nothing is deleted. */
  const open = await client.submit({ graph, bindings: [], label: `AIPLAY image · ${SECRET}`, actor: "user" });
  await client.tick(); await worker.tick(); await worker.tick(); await client.tick();
  const openJob = client.status().jobs.find((j) => j.id === open.id);
  assert.equal(openJob.state, "completed", openJob.error || "");
  assert.equal(words(JSON.stringify(JSON.parse(await podState()).jobs[open.id])), true);
  const openPod = path.join(outputDir, "aiplay_remote", open.id);
  assert.equal((await readFile(path.join(openPod, (await readdir(openPod))[0]))).includes(Buffer.from("paper lantern", "latin1")), true);
  assert.equal(deleted.length, 1, "nothing of an open job is deleted");
  assert.match(ledger.find((e) => e.type === "delegate" && e.asset === `engine/${open.runId}`).data.graphHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(ledger.find((e) => e.type === "generate" && e.asset === `engine/${open.runId}`).data.remote.executedGraphHash);
});

test("§7 ...a private job the worker refused at submission is never asked to be forgotten", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-refused-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const asked = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    asked.push(`${init.method || "GET"} ${u.pathname}`);
    if (u.pathname === "/v1/health") return new Response(JSON.stringify({ protocol: 1, workerId: "w-1", ready: true }), { status: 200 });
    if (u.pathname === "/v1/jobs") return new Response(JSON.stringify({ error: "This job ID belongs to a different request." }), { status: 409 });
    return new Response(JSON.stringify({ error: "Unknown job." }), { status: 404 });
  };
  const client = await createRemoteClient({ dataDir: dir, outputDir: path.join(dir, "out"), getToken: async () => null, setToken: async () => {},
    append: async () => {}, adopt: async () => null, fetchFn, pollMs: 3_600_000 });
  t.after(() => client.close());
  await client.connect({ url: "http://127.0.0.1:9", token: "k".repeat(40) });
  await client.submit({ graph: graphOf("a lighthouse at dawn"), label: "AIPLAY image · x", private: true });
  await client.tick(); await client.tick();
  assert.equal(client.status().jobs[0].state, "failed");
  assert.equal(asked.some((a) => /\/forget$/.test(a)), false, "a 409's job is someone else's request: nothing is forgotten for it");
});

/* §8 WHAT A WORKER MAY HAND BACK (review S5, open since the first review). A
 * mock worker: a list of 400 outputs was written in full, a 64 MiB answer was
 * parsed whole, and an output whose kind was not a string left the job
 * downloading again at every tick, for ever. */
test("§8 a worker's answers and outputs are capped, and a bad manifest fails once, downloading nothing", async (t) => {
  const { MAX_OUTPUTS, MAX_JOB_BYTES, manifestProblem, readJsonCapped } = await import("./remote-client.js");
  const one = { id: "0", filename: "a.png", kind: "images", bytes: 1, sha256: "0".repeat(64) };
  async function run(outputs, { status = null } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-remote-caps-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let files = 0;
    const answer = (b) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchFn = async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/v1/health") return answer({ protocol: 1, workerId: "w-1", ready: true });
      if (u.pathname === "/v1/jobs" && init.method === "POST") return answer({ id: JSON.parse(init.body).id, state: "running" });
      const s = /^\/v1\/jobs\/([^/]+)$/.exec(u.pathname);
      if (s) return answer(status ? status(s[1]) : { id: s[1], state: "completed", outputs });
      if (/\/files\/\d+$/.test(u.pathname)) { files++; return new Response(Buffer.from("x"), { status: 200 }); }
      return answer({});
    };
    const client = await createRemoteClient({ dataDir: dir, outputDir: path.join(dir, "out"), getToken: async () => null, setToken: async () => {},
      append: async () => {}, adopt: async () => null, fetchFn, pollMs: 3_600_000 });
    t.after(() => client.close());
    await client.connect({ url: "http://127.0.0.1:9", token: "k".repeat(40) });
    const sent = await client.submit({ graph: graphOf("a lighthouse at dawn"), label: "AIPLAY image · a lighthouse" });
    for (let i = 0; i < 4; i++) await client.tick();
    return { job: client.status().jobs.find((j) => j.id === sent.id), files: () => files };
  }
  const many = await run(Array.from({ length: MAX_OUTPUTS + 1 }, (_, i) => ({ ...one, id: String(i), filename: `f${i}.png` })));
  assert.equal(many.job.state, "failed");
  assert.match(many.job.error, new RegExp(`listed ${MAX_OUTPUTS + 1} outputs for one job; at most ${MAX_OUTPUTS}`));
  assert.equal(many.files(), 0, "nothing was downloaded");
  const huge = await run(Array.from({ length: 5 }, (_, i) => ({ ...one, id: String(i), filename: `f${i}.mp4`, kind: "videos", bytes: 512 * 1024 * 1024 })));
  assert.equal(huge.job.state, "failed");
  assert.match(huge.job.error, /add up to 2\.5 GiB; at most 2 GiB/);
  assert.equal(huge.files(), 0);
  const kind = await run([{ ...one, kind: 7 }]);
  assert.equal(kind.job.state, "failed", "a kind that is not one of the worker's ends the job, once");
  assert.match(kind.job.error, /invalid file manifest/);
  assert.equal(kind.files(), 0, "and is not fetched at every tick");
  for (const bad of [{ ...one, kind: "secrets" }, { ...one, filename: "../x.png" }, { ...one, filename: "x.exe" }, { ...one, bytes: -1 }, { ...one, id: "a" }]) {
    assert.match(manifestProblem([bad]), /invalid file manifest/, JSON.stringify(bad));
  }
  assert.equal(manifestProblem([one]), null);
  assert.equal(MAX_JOB_BYTES, 2 * 1024 ** 3);
  /* An answer past the cap is refused while it is read, declared or not. */
  const big = "y".repeat(3 * 1024 * 1024);
  const pad = await run([one], { status: (id) => ({ id, state: "running", pad: big }) });
  assert.notEqual(pad.job.state, "completed");
  assert.match(pad.job.error, /The worker's answer is larger than 2 MiB; it was not read/);
  const streamed = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("z".repeat(1024 * 1024))); c.close(); } }));
  await assert.rejects(readJsonCapped(streamed), /larger than 2 MiB/, "an answer with no length is stopped while it streams");
  assert.deepEqual(await readJsonCapped(new Response('{"ok":true}')), { ok: true });
});

/* §9 THE 500TH PICTURE OF ONE NAME (review of the port, 2026-10-08). The
 * adopt loop gave up at <stem>_499 and rename() on Windows replaced what was
 * there, and every Pod picture is called 0-runpod_00001_.png. */
test("§9 the 500th picture of one name is adopted under a new name, and the 499th is untouched", async (t) => {
  const { writeFile, readdir } = await import("node:fs/promises");
  const lib = await mkdtemp(path.join(os.tmpdir(), "aiplay-adopt-names-"));
  t.after(() => rm(lib, { recursive: true, force: true }));
  const IMAGE_DIR = path.join(lib, "images"), CLIP_DIR = path.join(lib, "clips"), OUT = path.join(lib, "out");
  await mkdir(IMAGE_DIR, { recursive: true }); await mkdir(path.join(OUT, "remote"), { recursive: true });
  const NAME = "0-runpod_00001_.png", STEM = "0-runpod_00001_";
  await writeFile(path.join(IMAGE_DIR, NAME), "picture #1");
  for (let n = 2; n < 500; n++) await writeFile(path.join(IMAGE_DIR, `${STEM}_${n}.png`), `picture #${n}`);
  const rows = {};
  const engineRoutes = createEngineRoutes({ json: () => {}, readBody: async () => ({}), config: { outputDir: OUT, uiPort: 4173 },
    provenance: {}, engine: { store: {} }, IMAGE_DIR, CLIP_DIR, rememberImage: (n, meta) => { rows[n] = meta; } });
  await writeFile(path.join(OUT, "remote", NAME), "picture #500");
  const adopted = await engineRoutes.adopt({ runId: "remote-1234abcd-0000", record: { via: "runpod" },
    output: { file: NAME, subfolder: "remote" }, spec: { safety: { minor: false, sexual: false } } });
  assert.match(adopted, /^images\/0-runpod_00001__[A-Za-z0-9-]+_[0-9a-f]{6}\.png$/);
  assert.equal(await readFile(path.join(IMAGE_DIR, `${STEM}_499.png`), "utf8"), "picture #499", "the 499th is untouched");
  assert.equal(await readFile(path.join(lib, adopted), "utf8"), "picture #500");
  assert.equal((await readdir(IMAGE_DIR)).length, 500);
  assert.equal(rows[`${STEM}_499.png`], undefined, "and no row was merged over the 499th's");
  /* Below the counter nothing changes: the next free number. */
  await rm(path.join(IMAGE_DIR, `${STEM}_7.png`));
  await writeFile(path.join(OUT, "remote", NAME), "picture #501");
  assert.equal(await engineRoutes.adopt({ runId: "r", record: {}, output: { file: NAME, subfolder: "remote" } }), `images/${STEM}_7.png`);
});

/* §10 EVERY ROUTE ANSWERS ONLY THIS PC'S ADDRESS (review of the port,
 * 2026-10-08). /api/runpod refused a rebound Host (§1), and the same page could
 * still GET /api/provenance (every open Pod render's prompt), /api/images and
 * the pictures themselves, and open the live socket. The guard is the first
 * thing the request handler does, lifted out of index.js and run here. */
test("§10 index.js refuses a request whose Host is not this PC's Studio, on every route, and so does the live socket", async () => {
  const { localUiHost } = await import("../cloud-switch.js");
  const index = read("server", "index.js");
  const guard = /\nconst foreignHost = \(req\) => !localUiHost\(req, config\.uiPort\);\n/.exec(index)?.[0];
  assert.ok(guard, "index.js has the guard");
  const head = /const server = http\.createServer\(async \(req, res\) => \{\n([\s\S]*?)\n  const url = new URL\(req\.url, "http:\/\/localhost"\);/.exec(index)?.[1] || "";
  assert.match(head, /^  if \(foreignHost\(req\)\) \{\n    return json\(res, 403, /, "it is the first thing every request meets");
  const run = new Function("config", "localUiHost", "json", "req", "res", `${guard}\n${head}\nreturn "routed";`);
  const said = [];
  const json = (_res, code, body) => { said.push(code); return { code, body }; };
  for (const [host, refused] of [["rebind.evil.example:4173", true], ["127.0.0.1.nip.io:4173", true], ["", true], ["127.0.0.1:8080", true],
    ["127.0.0.1:4173", false], ["localhost:4173", false], ["[::1]:4173", false]]) {
    for (const route of ["/api/provenance", "/api/images", "/images/a.png", "/"]) {
      const out = run({ uiPort: 4173 }, localUiHost, json, { method: "GET", url: route, headers: { host } }, {});
      assert.equal(out === "routed", !refused, `${host || "no Host"} GET ${route}`);
      if (refused) assert.equal(out.code, 403);
    }
  }
  assert.match(index, /new WebSocketServer\(\{ server, path: "\/live",[\s\S]{0,400}verifyClient: \(\{ req \}\) => !foreignHost\(req\) && \(!req\.headers\.origin \|\| req\.headers\.origin === `http:\/\/\$\{req\.headers\.host\}`\)/,
    "the live socket (every job's state, titles included) asks the same");
});
