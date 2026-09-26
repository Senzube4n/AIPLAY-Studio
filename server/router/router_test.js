/**
 * COMFY ROUTER: the client, the run queue, the result reader, the simple
 * forms, the routes and the launcher mode. No network and no key: the Router
 * and the asset hosts are fake fetch functions, and the schemas are trimmed
 * copies kept in fixtures/ (from docs.comfy.org/router-schemas, 2026-09-23).
 *
 *   node --test server/router/router_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRouterClient, RouterError, validModelId, validationText, routerKeyCache } from "./client.js";
import { findAssets, textOf, extFor, isAsset } from "./outputs.js";
import { FEATURED, ADAPTERS, buildSimple, simpleFor } from "./adapters.js";
import { kindOf, inputOf, createCatalog, HIDDEN_FIELDS } from "./catalog.js";
import { createRouterJobs, trimResult } from "./jobs.js";
import { cleanBody, promptOf, createRouterRoutes } from "./routes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const fixture = (id) => JSON.parse(readFileSync(path.join(HERE, "fixtures", `${id.replace("/", "__")}.json`), "utf8"));
const IDS = JSON.parse(readFileSync(path.join(HERE, "fixtures", "_ids.json"), "utf8"));

/* ── a fake Router ──────────────────────────────────────────────────────── */

function res(status, body, headers = {}) {
  const h = new Map(Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const isBytes = Buffer.isBuffer(body);
  return {
    ok: status < 400, status,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => (isBytes ? JSON.parse(body.toString()) : body),
    text: async () => (isBytes ? body.toString() : JSON.stringify(body)),
    arrayBuffer: async () => (isBytes ? body : Buffer.from(JSON.stringify(body))),
  };
}

/* ── the client ─────────────────────────────────────────────────────────── */

test("submits to the queue route with the key and the idempotency key", async () => {
  const calls = [];
  const c = createRouterClient({
    getKey: async () => "comfyui-test-key-123456",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return res(201, { request_id: "r1", status: "IN_QUEUE", queue_position: 2 }); },
  });
  const r = await c.submit("bfl/flux-2-pro", { prompt: "a teapot" }, "idem-1");
  assert.equal(r.json.request_id, "r1");
  assert.equal(calls[0].url, "https://api.comfy.org/v2/models/bfl/flux-2-pro/requests");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-API-Key"], "comfyui-test-key-123456");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "idem-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: "a teapot" });
});

test("model ids are checked before they reach a URL", async () => {
  for (const id of ["bfl/flux-pro-1.1", "elevenlabs/eleven_v3", "byteplus/seed-audio-1.0-multilingual"]) assert.ok(validModelId(id), id);
  for (const id of ["../etc", "a/b/c", "bfl/", "/x", "a b/c"]) assert.ok(!validModelId(id), id);
  const c = createRouterClient({ getKey: async () => "k".repeat(20), fetchImpl: async () => { throw new Error("must not be called"); } });
  await assert.rejects(c.submit("../x", {}, "i"), /not a model id/);
  assert.ok(IDS.every(validModelId), "every published id passes");
});

test("errors: named buckets, unknown ones read as internal_error, no key refuses before a call", async () => {
  const c = (status, body, headers) => createRouterClient({ getKey: async () => "k".repeat(20), fetchImpl: async () => res(status, body, headers) });
  await assert.rejects(c(402, { error_type: "insufficient_credits", detail: "no balance" }).submit("bfl/flux-2-pro", {}, "i"),
    (e) => e instanceof RouterError && e.type === "insufficient_credits" && /Add credits/.test(e.message) && !e.retryable);
  await assert.rejects(c(500, { error_type: "brand_new_bucket", detail: "?" }).submit("bfl/flux-2-pro", {}, "i"),
    (e) => e.type === "internal_error" && e.rawType === "brand_new_bucket" && e.retryable);
  await assert.rejects(c(429, { error_type: "concurrency_limit_exceeded", detail: "" }, { "retry-after": "7" }).submit("bfl/flux-2-pro", {}, "i"),
    (e) => e.retryable && e.retryAfter === 7);
  await assert.rejects(c(422, { detail: [{ loc: ["body", "prompt"], msg: "Field required" }] }).submit("bfl/flux-2-pro", {}, "i"),
    (e) => /prompt: Field required/.test(e.message));
  const none = createRouterClient({ getKey: async () => null, fetchImpl: async () => { throw new Error("must not be called"); } });
  await assert.rejects(none.submit("bfl/flux-2-pro", {}, "i"), (e) => e.type === "unauthorized");
  assert.equal(validationText([{ loc: ["body", "a", 0], msg: "bad" }]), "a.0: bad");
});

/* A REDIRECT IS NEVER FOLLOWED WITH THE KEY. fetch follows by default and, on a
 * cross-origin hop, strips Authorization and Cookie but not X-API-Key: a stand-in
 * API answering 302 got the key delivered to the other origin (Node 22, undici
 * 6.21). With redirect "manual" the raw 3xx comes back, and it must be a final,
 * readable error: read as a success it left a poll "queued" forever and a submit
 * retrying forty times. */
test("a redirect from the Router is refused, never followed, never retried, and the key goes nowhere else", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
    const c = createRouterClient({
      getKey: async () => "comfyui-secret-key-0001",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return res(status, {}, { location: "https://storage.elsewhere.example/out.png", "content-type": "text/html" });
      },
    });
    for (const [what, go] of [["result", () => c.result("bfl/flux-2-pro", "req-1")], ["status", () => c.status("bfl/flux-2-pro", "req-1")],
      ["submit", () => c.submit("bfl/flux-2-pro", { prompt: "p" }, "idem-1")]]) {
      const before = calls.length;
      await assert.rejects(go(), (e) => e instanceof RouterError && e.status === status && !e.retryable
        && /storage\.elsewhere\.example/.test(e.message) && /did not follow/.test(e.message), `${status} ${what}`);
      assert.equal(calls.length, before + 1, `${status} ${what}: one call, nothing followed`);
      assert.equal(calls.at(-1).init.redirect, "manual", `${status} ${what}: fetch is told not to follow`);
      assert.ok(calls.every((x) => new URL(x.url).host === "api.comfy.org"), "every request went to api.comfy.org only");
    }
  }
});

/* THE KEY CACHE AND A SAVE THAT OVERLAPS A POLL. A save takes ~300 ms of DPAPI
 * in powershell; a poll that began reading the store during it decrypted the
 * OLD key and cached it after the clear, so every later run used the old key
 * until a restart. The read here resolves only after the save has finished,
 * which is exactly that interleaving. */
test("a key read that overlapped a save or a forget never becomes the cached key", async () => {
  let store = "OLDKEY-0000000000000", reads = 0;
  const pending = [];
  const readStore = () => { reads++; const seen = store; return new Promise((ok) => pending.push(() => ok(seen))); };
  const cache = routerKeyCache(readStore);
  const flush = () => { while (pending.length) pending.shift()(); };
  const save = async (value) => { cache.drop(); try { store = value; } finally { cache.drop(); } };

  const inflight = cache.getKey();          // a poll starts reading the old file...
  await save("NEWKEY-1111111111111");        // ...the page saves a new key...
  flush();
  assert.equal(await inflight, "OLDKEY-0000000000000", "the poll that was already reading answers what it read");
  const next = cache.getKey(); flush();
  assert.equal(await next, "NEWKEY-1111111111111", "but the next poll reads the NEW key: the old one was never stored");
  const cached = await cache.getKey();
  assert.equal(cached, "NEWKEY-1111111111111", "and that one is kept");
  const readsWhenCached = reads;
  await cache.getKey();
  assert.equal(reads, readsWhenCached, "a cached key is not decrypted again");

  const fresh = routerKeyCache(readStore);   // Forget, with a poll's read in flight
  const polling = fresh.getKey();
  fresh.drop(); store = null; fresh.drop();
  flush();
  assert.equal(await polling, "NEWKEY-1111111111111", "the poll in flight answers what it read");
  const after = fresh.getKey(); flush();
  assert.equal(await after, null, "after Forget there is no key, not a remembered one");

  const index = read("server/index.js");
  assert.match(index, /routerKeyCache\(\(\) => getSecret\(ROUTER_KEY\)\)/, "index.js caches through it");
  assert.match(index, /set: async \(name, value\) => \{ dropRouterKey\(\); try \{ return await setSecret\(name, value\); \} finally \{ dropRouterKey\(\); \} \},/,
    "a save drops the key before and after its write");
  assert.match(index, /clear: async \(name\) => \{ dropRouterKey\(\); try \{ return await clearSecret\(name\); \} finally \{ dropRouterKey\(\); \} \} \},/,
    "and so does Forget");
});

/* ── reading a result ───────────────────────────────────────────────────── */

test("finds assets by rule: URLs, base64 beside a mime type, data URIs; plumbing URLs skipped", () => {
  const png = Buffer.alloc(400, 1).toString("base64");
  const f = findAssets({
    result: { sample: "https://delivery.example/out.jpg" },
    status_url: "https://api.comfy.org/status",
    videos: [{ bytesBase64Encoded: png, mimeType: "video/mp4" }],
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }],
    extra: `data:image/webp;base64,${png}`,
    callback_url: "https://hooks.example/x",
  });
  assert.deepEqual(f.urls.map((u) => u.url), ["https://delivery.example/out.jpg"]);
  assert.deepEqual(f.inline.map((i) => i.mime).sort(), ["image/png", "image/webp", "video/mp4"]);
});

test("reads text from each language-model family", () => {
  assert.equal(textOf({ content: [{ type: "text", text: "claude says" }] }), "claude says");
  assert.equal(textOf({ output: [{ content: [{ type: "output_text", text: "gpt says" }] }] }), "gpt says");
  assert.equal(textOf({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: "gemini says" }] } }] }), "gemini says");
  assert.equal(textOf({ choices: [{ message: { content: "chat says" } }] }), "chat says");
  assert.equal(textOf({ result: { sample: "https://x" } }), null);
});

test("file types from the content type, the URL or the bytes; pages are not assets", () => {
  assert.equal(extFor("image/png"), "png");
  assert.equal(extFor("application/octet-stream", "https://x/model.glb?sig=1"), "glb");
  assert.equal(extFor("", "", Buffer.from("glTF\x02\x00\x00\x00\x00\x00\x00\x00")), "glb");
  assert.equal(extFor("", "", Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom0000")])), "mp4");
  assert.equal(isAsset("text/html", "html"), false);
  assert.equal(isAsset("application/json", null), false);
  assert.equal(isAsset("image/jpeg", "jpg"), true);
  assert.match(trimResult({ b64: "A".repeat(5000) }).b64, /5000 characters/);
});

/* ── the run queue, end to end ──────────────────────────────────────────── */

test("a run: submit, queued, completed, collected; assets fetched WITHOUT the key; restart-safe", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-router-"));
  try {
    const seen = [];
    let polls = 0;
    const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(40), "hex");
    const routerFetch = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/requests")) return res(201, { request_id: "req-9", status: "IN_QUEUE", queue_position: 0 });
      if (url.endsWith("/status")) return res(200, { status: ++polls < 2 ? "IN_PROGRESS" : "COMPLETED" }, { "retry-after": "0" });
      if (url.endsWith("/requests/req-9")) return res(200, { result: { sample: "https://cdn.example/a.png" }, note: "https://cdn.example/page" }, { "x-comfy-credits-used": "12" });
      throw new Error(`unexpected ${url}`);
    };
    const assetFetch = async (url, init) => {
      seen.push({ url, init, asset: true });
      if (url === "https://cdn.example/a.png") return res(200, png, { "content-type": "image/png" });
      return res(200, Buffer.from("<html></html>"), { "content-type": "text/html" });
    };
    let t = 1_000_000;
    const client = createRouterClient({ getKey: async () => "comfyui-secret-key-0001", fetchImpl: routerFetch });
    const jobs = createRouterJobs({ client, dir: path.join(dir, "state"), outDir: path.join(dir, "out"), fetchImpl: assetFetch, now: () => t, tickMs: 60_000 });
    const run = await jobs.add({ model: "bfl/flux-2-pro", kind: "image", label: "FLUX.2 Pro", prompt: "teapot", body: { prompt: "teapot" } });
    for (let i = 0; i < 8; i++) { t += 60_000; await jobs.tick(); }
    jobs.stop();
    const done = (await jobs.list()).find((r) => r.id === run.id);
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.equal(done.credits, 12);
    assert.equal(done.files.length, 1, "the HTML page was not kept as a result");
    assert.equal(done.files[0].ext, "png");
    assert.ok((await stat(path.join(dir, "out", done.files[0].name))).size > 0);
    const submits = seen.filter((c) => c.url.endsWith("/requests"));
    assert.equal(submits.length, 1);
    assert.ok(submits[0].init.headers["Idempotency-Key"], "an idempotency key on the submit");
    for (const a of seen.filter((c) => c.asset)) assert.equal(a.init?.headers?.["X-API-Key"], undefined, `key leaked to ${a.url}`);
    const saved = await readFile(path.join(dir, "state", "runs.json"), "utf8");
    assert.doesNotMatch(saved, /comfyui-secret-key/, "the key is never written to the run list");
    assert.doesNotMatch(saved, /"body"/, "the sent body is not kept after submit");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a busy Router: the submit waits and retries with the SAME idempotency key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-router-"));
  try {
    const keys = [];
    let n = 0;
    const client = createRouterClient({
      getKey: async () => "k".repeat(20),
      fetchImpl: async (url, init) => {
        if (url.endsWith("/requests")) {
          keys.push(init.headers["Idempotency-Key"]);
          return ++n === 1 ? res(429, { error_type: "concurrency_limit_exceeded", detail: "" }, { "retry-after": "3" })
            : res(201, { request_id: "r2", status: "IN_QUEUE" });
        }
        if (url.endsWith("/status")) return res(200, { status: "COMPLETED", error_type: "content_policy_violation", detail: "refused" });
        throw new Error(url);
      },
    });
    let t = 0;
    const jobs = createRouterJobs({ client, dir, outDir: path.join(dir, "out"), fetchImpl: async () => { throw new Error("no"); }, now: () => t, tickMs: 60_000 });
    await jobs.add({ model: "bfl/flux-2-pro", kind: "image", label: "x", body: { prompt: "p" } });
    for (let i = 0; i < 6; i++) { t += 60_000; await jobs.tick(); }
    jobs.stop();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], "one generation, one key");
    const r = (await jobs.list())[0];
    assert.equal(r.status, "failed");
    assert.equal(r.error.type, "content_policy_violation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a binary result is saved as it came; cancel before submit costs nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-router-"));
  try {
    const client = createRouterClient({
      getKey: async () => "k".repeat(20),
      fetchImpl: async (url) => {
        if (url.endsWith("/requests")) return res(201, { request_id: "r3", status: "IN_QUEUE" });
        if (url.endsWith("/status")) return res(200, { status: "COMPLETED" });
        return res(200, Buffer.from("ID3\x03\x00" + "x".repeat(50)), { "content-type": "audio/mpeg" });
      },
    });
    let t = 0;
    const jobs = createRouterJobs({ client, dir, outDir: path.join(dir, "out"), now: () => t, tickMs: 60_000 });
    const a = await jobs.add({ model: "elevenlabs/eleven_sfx_v2", kind: "audio", label: "sfx", body: { text: "door" } });
    for (let i = 0; i < 4; i++) { t += 60_000; await jobs.tick(); }
    assert.equal((await jobs.list()).find((r) => r.id === a.id).files[0].ext, "mp3");
    jobs.stop();

    const quiet = createRouterJobs({ client: { submit: () => { throw new Error("must not submit"); } }, dir: path.join(dir, "b"), outDir: dir, now: () => t, tickMs: 60_000 });
    quiet.tick = async () => {};                       // never let it reach the Router
    const b = await quiet.add({ model: "bfl/flux-2-pro", kind: "image", label: "x", body: { prompt: "p" } });
    quiet.stop();
    assert.deepEqual(await quiet.cancel(b.id), { ok: true });
    assert.equal((await quiet.list())[0].status, "cancelled");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ── the simple forms, against the real schemas ─────────────────────────── */

/* Enough JSON Schema to catch a wrong shape: types, required, enums, bounds,
 * array items, and oneOf/anyOf as "one of these fits". */
function validate(sch, v, at = "body", strict = true) {
  if (!sch || typeof sch !== "object") return [];
  const errs = [];
  if (sch.oneOf || sch.anyOf) {
    const alts = sch.oneOf || sch.anyOf;
    /* A branch names what tells it apart; the keys it leaves out are not refused. */
    if (!alts.some((a) => validate(a, v, at, false).length === 0)) errs.push(`${at}: matches none of ${alts.length} shapes`);
  }
  const t = sch.type;
  const is = { string: typeof v === "string", integer: Number.isInteger(v), number: typeof v === "number", boolean: typeof v === "boolean",
    array: Array.isArray(v), object: v && typeof v === "object" && !Array.isArray(v) };
  if (t && is[t] === false) return [...errs, `${at}: expected ${t}`];
  if (sch.enum && !sch.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(sch.enum)}`);
  if (typeof v === "number") {
    if (sch.minimum != null && v < sch.minimum) errs.push(`${at}: below ${sch.minimum}`);
    if (sch.maximum != null && v > sch.maximum) errs.push(`${at}: above ${sch.maximum}`);
  }
  if (Array.isArray(v) && sch.items) v.forEach((x, i) => errs.push(...validate(sch.items, x, `${at}[${i}]`)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const r of sch.required || []) if (!(r in v)) errs.push(`${at}.${r}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (sch.properties?.[k]) errs.push(...validate(sch.properties[k], x, `${at}.${k}`));
      else if (strict && sch.properties && !sch.oneOf && !sch.anyOf) errs.push(`${at}.${k}: not in the schema`);
    }
  }
  return errs;
}

const IMG = { mime: "image/png", data: Buffer.alloc(64, 7).toString("base64") };

test("every featured model is in the published catalogue, with a kind the page has", () => {
  for (const f of FEATURED) {
    assert.ok(IDS.includes(f.id), `${f.id} is not a published Router model`);
    assert.ok(["image", "video", "audio", "3d", "text"].includes(f.kind), f.id);
    if (f.adapter) assert.ok(ADAPTERS[f.adapter], `${f.id} names a missing adapter ${f.adapter}`);
  }
});

test("each simple form builds a body its model's schema accepts, with and without a picture", () => {
  for (const f of FEATURED.filter((x) => x.adapter)) {
    const sch = fixture(f.id).input;
    const fields = simpleFor(f.id).fields;
    const simple = { prompt: "a lighthouse at dusk" };
    for (const fl of fields) {
      if (fl.name === "voice_id") simple.voice_id = "JBFqnCBsd6RMkjVDRZzb";
      else if (fl.default !== undefined && simple[fl.name] === undefined) simple[fl.name] = fl.default;
    }
    const withMedia = Object.fromEntries(fields.filter((fl) => fl.type === "media").map((fl) => [fl.name, IMG]));
    for (const files of [{}, withMedia]) {
      const body = buildSimple(f.id, simple, files);
      const errs = validate(sch, body);
      assert.deepEqual(errs, [], `${f.id} (${Object.keys(files).length ? "with" : "without"} a picture): ${errs.join("; ")}`);
    }
  }
});

test("a simple form refuses an empty required field", () => {
  assert.throws(() => buildSimple("veo/veo-3.1-generate-001", { prompt: "  " }), /Fill in prompt/);
  assert.throws(() => buildSimple("bfl/flux-2-pro", { prompt: "x" }), /no simple form/);
});

/* ── the catalogue ──────────────────────────────────────────────────────── */

test("every published model files under a kind, and the sort is sane", () => {
  const by = {};
  for (const id of IDS) (by[kindOf(id)] ||= []).push(id);
  assert.deepEqual(Object.keys(by).sort(), ["3d", "audio", "image", "text", "video"]);
  for (const [id, k] of [["anthropic/claude-sonnet-5", "text"], ["openai/gpt-5.5", "text"], ["openai/gpt-image-2", "image"],
    ["vertexai/gemini-3-pro-image", "image"], ["vertexai/gemini-3.5-flash", "text"], ["kling/kling-v3", "video"],
    ["wan/wan2.5-t2i-preview", "image"], ["wan/wan3.0-video", "video"], ["meshy/meshy-7.1", "3d"],
    ["elevenlabs/eleven_sfx_v2", "audio"], ["fal/h3-max", "video"], ["veo/veo-3.1-generate-001", "video"],
    ["tencent/hunyuan-3d-uv", "3d"], ["bria/video-edit-erase", "video"]]) assert.equal(kindOf(id), k, id);
  assert.ok(by.image.length > 60 && by.video.length > 50 && by.text.length > 30, JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length]))));
});

test("a schema reaches the page resolved: refs inlined, allOf merged, hidden fields listed", () => {
  const doc = {
    "x-comfy-input-schema-authored": true,
    paths: { "/v2/models/a/b": { post: { requestBody: { content: { "application/json": { schema: {
      allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { extra: { type: "boolean" } } }],
    } } } } } } },
    components: { schemas: {
      Base: { type: "object", required: ["prompt"], properties: { prompt: { type: "string", description: "x".repeat(900) }, loop: { $ref: "#/components/schemas/Base" } } },
    } },
  };
  const o = inputOf(doc, "a/b");
  assert.deepEqual(Object.keys(o.input.properties).sort(), ["extra", "loop", "prompt"]);
  assert.deepEqual(o.input.required, ["prompt"]);
  assert.ok(o.input.properties.prompt.description.length <= 400);
  assert.equal(o.input.properties.loop.description, "(recursive)", "a cycle stops instead of recursing");
  assert.ok(o.authored);
  assert.ok(o.hidden.includes("callback_url"));
});

test("the model list comes from the docs without a key, and the API with one; featured first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-router-"));
  try {
    const cat = createCatalog({ dir, fetchImpl: async (url) => {
      assert.match(url, /^https:\/\/docs\.comfy\.org\/llms\.txt$/);
      return { ok: true, text: async () => "- [x](/router-schemas/zz/last.json)\n- [y](/router-schemas/bfl/flux-2-pro.json)" };
    } });
    const pub = await cat.models();
    assert.equal(pub.source, "docs");
    assert.deepEqual(pub.models.map((m) => m.id), ["bfl/flux-2-pro", "zz/last"]);
    const api = await cat.models({ live: async () => [{ id: "bfl/flux-2-pro", billing: { charges_on_policy_rejection: "yes" } }] });
    assert.equal(api.source, "api");
    assert.equal(api.models[0].policyCharged, "yes");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an answer is counted as it arrives: a chunked reply past the cap is refused, not held", async () => {
  const { readCapped } = await import("./client.js");
  const stream = (chunks) => ({ headers: { get: () => null },
    body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } }) });
  assert.deepEqual([...await readCapped(stream([new Uint8Array([1, 2]), new Uint8Array([3])]), 10)], [1, 2, 3]);
  await assert.rejects(readCapped(stream([new Uint8Array(6), new Uint8Array(6)]), 10), /too large/,
    "no Content-Length, and it still stops at the cap");
  await assert.rejects(readCapped({ headers: { get: (k) => (k === "content-length" ? "11" : null) },
    arrayBuffer: async () => { throw new Error("must not be read"); } }, 10), /too large/, "a stated length over the cap is refused unread");
  // Both whole-body readers go through it, and the submit's timeout grows with its upload.
  assert.match(read("server/router/jobs.js"), /const bytes = await readCapped\(res, MAX_ASSET_BYTES\);/);
  assert.match(read("server/router/client.js"), /const bytes = await readCapped\(res\);/);
  assert.match(read("server/router/client.js"), /const limit = Math\.max\(timeoutMs, payload \? Math\.ceil\(payload\.length \/ 50\) : 0\);/);
  assert.equal((read("server/router/jobs.js") + read("server/router/client.js")).match(/await res\.arrayBuffer\(\)/g)?.length, 1,
    "no uncounted whole-body read is left: the one arrayBuffer() is readCapped's own, for a response with no stream");
});

/* ── the routes ─────────────────────────────────────────────────────────── */

test("a generic body drops plumbing and empties; uploads go in as the schema asked", () => {
  const b = cleanBody({ prompt: "p", callback_url: "https://x", seed: "", width: 512 },
    { input_image: { mime: "image/png", data: "QUJD", as: "raw" }, ref: { mime: "image/png", data: "QUJD", as: "uri" } });
  assert.deepEqual(b, { prompt: "p", width: 512, input_image: "QUJD", ref: "data:image/png;base64,QUJD" });
  assert.equal(promptOf(null, { content: [{ type: "text", text: "fox" }] }), "fox");
  assert.equal(promptOf(null, { instances: [{ prompt: "veo" }] }), "veo");
  assert.ok(HIDDEN_FIELDS.has("model"));
});

/* index.js sameOriginLocalJson, the same three checks (Host on the UI port,
 * Origin same or absent, JSON declared), so this lane judges the routes' own
 * logic; that index.js passes the real one is pinned below. */
const sameOriginLocalJson = (req) => {
  const host = req.headers.host || "";
  return ["127.0.0.1:4173", "localhost:4173", "[::1]:4173"].includes(host)
    && (!req.headers.origin || req.headers.origin === `http://${host}`)
    && /^application\/json(?:;|$)/i.test(req.headers["content-type"] || "");
};
const LOCAL = "127.0.0.1:4173";

test("routes: another website cannot save a key or spend credits; file names cannot escape", async () => {
  const out = [];
  const json = (r, status, body) => out.push({ status, body });
  const routes = createRouterRoutes({
    json, readBody: async () => ({ action: "key", key: "x".repeat(30) }), config: { uiPort: 4173, cloudOnly: true }, sameOriginLocalJson,
    secrets: { has: async () => false, set: async () => ({}), clear: async () => {}, status: async () => ({ set: false }) },
    client: { listModels: async () => { throw new Error("must not be called"); } },
    catalog: {}, jobs: { outDir: tmpdir() },
  });
  const req = (headers) => ({ method: "POST", headers: { host: LOCAL, ...headers } });
  await routes(req({ origin: "https://evil.example" }), {}, new URL("http://x/api/router"));
  assert.equal(out.pop().status, 400);
  await routes({ method: "GET", headers: { host: LOCAL } }, {}, new URL("http://x/api/router/file/..%2F..%2Fsecrets.json"));
  assert.equal(out.pop().status, 400);
  assert.equal(await routes(req({}), {}, new URL("http://x/api/other")), false);
  assert.throws(() => createRouterRoutes({ json, readBody: async () => ({}), config: { uiPort: 4173 }, secrets: {}, client: {}, catalog: {}, jobs: {} }),
    /sameOriginLocalJson/, "a credit door built without the guard refuses to exist");
});

/* DNS REBINDING, probed before the merge (2026-09-23): a page on a rebound
 * name is same-origin with ITSELF, so it could send x-aiplay-actor and JSON,
 * and it queued a paid run, saved its own key and read the run list. */
test("routes: a rebound page (foreign Host) reaches nothing; the page's own JSON does, at [::1] too", async () => {
  const out = [], spent = [], keys = [], listed = [];
  const routes = createRouterRoutes({
    json: (r, status, body) => out.push({ status, body }),
    readBody: async (req) => req._body,
    config: { uiPort: 4173, cloudOnly: true }, sameOriginLocalJson,
    secrets: { has: async () => true, set: async (n, k) => { keys.push(k); return { method: "dpapi" }; }, clear: async () => {}, status: async () => ({ set: true, hint: "…abcd" }) },
    client: { listModels: async () => [] },
    catalog: {},
    jobs: { outDir: tmpdir(), add: async (r) => { spent.push(r.model); return { id: "x" }; }, list: async () => { listed.push(1); return [{ prompt: "private" }]; } },
  });
  const hit = async (req, u) => { await routes(req, {}, new URL(`http://x${u}`)); return out.pop()?.status; };
  const evil = { host: "evil.example:4173", origin: "http://evil.example:4173", "x-aiplay-actor": "x", "content-type": "application/json" };
  const run = { model: "bfl/flux-2-pro", raw: { prompt: "spend" }, confirmSpend: true };
  assert.equal(await hit({ method: "POST", headers: evil, _body: run }, "/api/router/run"), 403, "no paid run");
  assert.equal(await hit({ method: "POST", headers: evil, _body: { action: "key", key: "attacker-key-0123456789" } }, "/api/router"), 403, "no key swap");
  assert.equal(await hit({ method: "GET", headers: { host: "evil.example:4173", "x-aiplay-actor": "x" } }, "/api/router/runs"), 403, "no run list");
  assert.equal(await hit({ method: "GET", headers: { host: "evil.example:4173" } }, "/api/router/file/a.png"), 403, "no result files");
  assert.equal(await hit({ method: "POST", headers: { host: LOCAL, origin: `http://${LOCAL}`, "content-type": "text/plain" }, _body: run }, "/api/router/run"), 403,
    "the page's own origin still has to declare JSON: a no-cors text/plain POST is what a cross-site page can send");
  assert.deepEqual([spent, keys, listed], [[], [], []], "nothing ran, nothing was saved, nothing was read");
  /* The page's own JSON, but without this run's own yes: refused, nothing sent
   * (server/cloud-switch.js: every paid run is confirmed on its own). */
  const unasked = { model: run.model, raw: run.raw };
  for (const confirmSpend of [undefined, false, "true", 1]) {
    assert.equal(await hit({ method: "POST", headers: { host: LOCAL, origin: `http://${LOCAL}`, "content-type": "application/json" },
      _body: { ...unasked, ...(confirmSpend === undefined ? {} : { confirmSpend }) } }, "/api/router/run"), 409, `confirmSpend ${confirmSpend}: refused`);
  }
  assert.deepEqual(spent, [], "an unconfirmed run spends nothing");
  assert.equal(await hit({ method: "POST", headers: { host: LOCAL, origin: `http://${LOCAL}`, "content-type": "application/json" }, _body: run }, "/api/router/run"), 200);
  assert.equal(await hit({ method: "POST", headers: { host: "[::1]:4173", origin: "http://[::1]:4173", "content-type": "application/json" }, _body: run }, "/api/router/run"), 200,
    "the page opened at [::1] is the page");
  assert.equal(await hit({ method: "POST", headers: { host: LOCAL, "x-aiplay-actor": "script:t", "content-type": "application/json" }, _body: run }, "/api/router/run"), 200,
    "a named local script");
  assert.equal(spent.length, 3);
  assert.match(read("server/index.js"), /createRouterRoutes\(\{\n\s+json, readBody, config, sameOriginLocalJson,/,
    "index.js hands the routes its one guard, not a copy");
});

test("routes: a provider's file is served sandboxed, so a scripted SVG runs nowhere near Studio's doors", async () => {
  const { PassThrough } = await import("node:stream");
  const { writeFile, mkdtemp: mk } = await import("node:fs/promises");
  const outDir = await mk(path.join(tmpdir(), "aiplay-router-files-"));
  try {
    await writeFile(path.join(outDir, "v.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    await writeFile(path.join(outDir, "c.mp4"), Buffer.alloc(64));
    const routes = createRouterRoutes({
      json: () => {}, readBody: async () => ({}), config: { uiPort: 4173, cloudOnly: true }, sameOriginLocalJson,
      secrets: {}, client: {}, catalog: {}, jobs: { outDir },
    });
    const get = async (name, extra = {}) => {
      const res = new PassThrough();
      res.writeHead = (status, headers) => { res.status = status; res.head = headers; };
      res.resume();
      const done = new Promise((ok) => res.on("finish", ok));
      await routes({ method: "GET", headers: { host: LOCAL, ...extra } }, res, new URL(`http://x/api/router/file/${name}`));
      await done;
      return res;
    };
    for (const [name, extra] of [["v.svg", {}], ["c.mp4", {}], ["c.mp4", { range: "bytes=0-9" }]]) {
      const r = await get(name, extra);
      assert.ok(r.status === 200 || r.status === 206, `${name} served`);
      assert.equal(r.head["Content-Security-Policy"], "sandbox", `${name}: sandboxed (opaque origin, no scripts)`);
      assert.equal(r.head["X-Content-Type-Options"], "nosniff", `${name}: never sniffed into HTML`);
    }
    assert.equal((await get("v.svg")).head["Content-Type"], "image/svg+xml");
  } finally { await rm(outDir, { recursive: true, force: true }); }
});

/* A SCHEMA'S PROPERTY NAMES ARE THE PROVIDER'S WORDS, not Studio's. inputOf()
 * copies keys through as published (and a day's cache keeps them), and the
 * form put each one into id="rtf_<name>" unescaped: a key holding a double
 * quote closed the attribute and wrote its own markup into Studio's page, for
 * every one of the field types (measured: 9 of 9 injected, and the onerror ran
 * in headless Edge). The page's own form functions, lifted from web/router.js,
 * fed such a schema through the real inputOf. */
test("the form built from a published schema never lets a property name write markup", () => {
  const page = read("web/router.js");
  const esc = /const esc = [^\n]+\n/.exec(page)[0];
  const engine = page.slice(page.indexOf("const MAIN = "), page.indexOf("function paintForm()"));
  const { fieldHtml, schemaFields } = new Function(`${esc}${engine}\nreturn { fieldHtml, schemaFields };`)();
  const evil = (tag) => `${tag}"><img src=x onerror=alert(1)><x a="`;
  const props = {
    [evil("text")]: { type: "string" },
    [evil("prompt")]: { type: "string" },
    [evil("steps")]: { type: "integer", minimum: 1, maximum: 9 },
    [evil("scale")]: { type: "number" },
    [evil("loop")]: { type: "boolean" },
    [evil("mode")]: { type: "string", enum: ["a", "b"] },
    [evil("extra")]: { type: "object" },
    [evil("image")]: { type: "string", description: "input image, base64 data URI" },
    [evil("video")]: { type: "string", description: "a video clip as a base64 data URI" },
    "image.url with spaces": { type: "string" },
  };
  const doc = { paths: { "/v2/models/a/b": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: props } } } } } } } };
  const fields = schemaFields({ input: inputOf(doc, "a/b").input, hidden: [] });
  assert.equal(fields.length, Object.keys(props).length, "every property became a field");
  assert.deepEqual(new Set(fields.map((f) => f.type)), new Set(["text", "longtext", "int", "number", "bool", "enum", "json", "media"]));
  const ids = new Set();
  for (const f of fields) {
    const html = fieldHtml(f);
    assert.ok(!/<img/i.test(html), `${f.type}: the name wrote a tag: ${html.slice(0, 160)}`);
    for (const [, id] of html.matchAll(/\b(?:id|for)="([^"]*)"/g)) {
      assert.match(id, /^rtf_\d+$/, `${f.type}: element ids are numbered, never the provider's name`);
      if (/\bid="/.test(html)) ids.add(id);
    }
    assert.ok(html.includes(`data-f="${f.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")}"`)
      || html.includes("data-media=") || html.includes("data-drop="), `${f.type}: the name travels only escaped, in the data attributes`);
  }
  assert.ok(ids.size >= fields.length - 1, "and each field's id is its own");
});

test("a cancel pressed while the submit is in flight reaches the Router, and the run stays cancelled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-router-"));
  try {
    let submits = 0, cancels = 0, polls = 0, release = null;
    const client = {
      submit: () => { submits++; return new Promise((ok) => { release = () => ok({ status: 201, json: { request_id: "r1", status: "IN_QUEUE", queue_position: 0 } }); }); },
      status: async () => { polls++; return { status: 200, json: { status: "IN_QUEUE", queue_position: 0 } }; },
      result: async () => ({ status: 202 }),
      cancel: async (model, id) => { cancels++; assert.equal(id, "r1", "the cancel names the request the Router took"); return { status: 200 }; },
    };
    let t = 0;
    const jobs = createRouterJobs({ client, dir, outDir: path.join(dir, "out"), now: () => t, tickMs: 60_000 });
    const run = await jobs.add({ model: "bfl/flux-2-pro", kind: "image", label: "x", prompt: "p", body: { prompt: "p" } });
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(release, "the submit is in flight");
    assert.deepEqual(await jobs.cancel(run.id), { ok: true }, "the page is told it is cancelled");
    release();                                    // the Router accepts the submit after all
    await jobs.tick();                            // the tick that was in flight finishes
    for (let i = 0; i < 3; i++) { t += 60_000; await jobs.tick(); }
    jobs.stop();
    const r = (await jobs.list())[0];
    assert.equal(r.status, "cancelled", "not un-cancelled by the submit's answer");
    assert.equal(cancels, 1, "the Router was told, once");
    assert.equal(submits, 1, "and nothing was submitted again");
    assert.equal(polls, 0, "a cancelled run is not polled or collected");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ── the launcher mode and the page ─────────────────────────────────────── */

test("AIPLAY_CLOUD_ONLY turns on Comfy API mode: no ComfyUI, and music-only still wins", () => {
  const probe = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "const {config}=await import('./server/config.js');console.log(JSON.stringify({c:config.cloudOnly,m:config.musicOnly,a:config.comfyAutoStart}))"],
  { cwd: ROOT, env: { ...process.env, AIPLAY_APPDATA: path.join(tmpdir(), "aiplay-router-mode"), AIPLAY_MUSIC_ONLY: "0", AIPLAY_CLOUD_ONLY: "0", ...env } }).toString());
  assert.deepEqual(probe({ AIPLAY_CLOUD_ONLY: "1" }), { c: true, m: false, a: false });
  assert.deepEqual(probe({}), { c: false, m: false, a: true });
  assert.deepEqual(probe({ AIPLAY_CLOUD_ONLY: "1", AIPLAY_MUSIC_ONLY: "1" }), { c: false, m: true, a: false });
});

test("the launcher offers it as a third, new, credit-spending mode", () => {
  const html = read("launcher/index.html"), mjs = read("launcher/launcher.mjs");
  /* Relabelled 2026-09-24 (owner: a friend's card first, paid Comfy API second):
   * the heading says whose key and that it costs, where it said "New". */
  assert.match(html, /id="mode-cloud"[\s\S]*?Use Comfy API <span class="tagcredit">your own key, paid<\/span>[\s\S]*?<span class="tagcredit">Requires credits<\/span>[\s\S]*?data-launch="cloud"/);
  /* A fourth mode joined on 2026-09-25: RunPod GPU (server/engine/remote_ui_test.js pins it). */
  assert.match(html, /for \(const m of \["full", "music", "cloud", "runpod"\]\)/);
  assert.match(mjs, /if \(!\["full", "music", "cloud", "runpod"\]\.includes\(mode\)\)/);
  assert.match(mjs, /mode === "cloud" \? path\.join\("scripts", "start-cloud\.mjs"\)/);
  assert.match(mjs, /AIPLAY_CLOUD_ONLY: mode === "cloud" \? "1" : "0"/);
  assert.match(read("scripts/start-cloud.mjs"), /process\.env\.AIPLAY_CLOUD_ONLY='1';/);
  assert.equal(JSON.parse(read("package.json")).scripts["start:cloud"], "node scripts/start-cloud.mjs");
});

test("the server mounts the page's routes and starts no ComfyUI only in that mode", () => {
  const idx = read("server/index.js");
  assert.match(idx, /const routerRoutes = config\.cloudOnly \? createRouterRoutes\(/, "full Studio has no route that can spend a credit");
  assert.match(idx, /let comfyWanted = !config\.musicOnly && !config\.cloudOnly && !config\.remoteOnly;/);
  assert.match(idx, /if \(config\.cloudOnly\) \{[\s\S]{0,400}await routerJobs\.resume\(\);[\s\S]{0,120}return;\n  \}/);
});

test("the web app shows the page only in that mode, and asks before every run", () => {
  const app = read("web/app.js"), html = read("web/index.html"), page = read("web/router.js");
  assert.match(html, /<a href="#" data-view="router" title="Comfy API" hidden>/, "hidden in full Studio");
  assert.match(html, /<div id="router" hidden class="page page-wide">/);
  assert.match(app, /if \(s\.config\?\.cloudOnly && !state\.cloudOnly\) \{[\s\S]*?setView\("router"\);/);
  assert.match(app, /\$\("router"\)\.hidden = name !== "router";/);
  assert.match(app, /router: "#router",/);
  assert.match(page, /await appConfirm\(`Run \$\{m\.label\} on Comfy's cloud\? This uses credits from your Comfy account/);
  assert.doesNotMatch(page, /localStorage/, "the key is never kept in the browser");
  // Full Studio mounts no /api/router, and the Welcome card still leads here.
  assert.match(page, /if \(e\.status === 404\) \{ paintOffMode\(\); return; \}/, "a 404 is the other mode, said plainly");
  assert.match(page, /This page runs in the launcher's Use Comfy API mode\. Full Studio never spends Comfy credits\./);
  assert.match(page, /min="\$\{esc\(f\.min\)\}"/, "schema numbers are escaped into attributes like every other schema text");
});
