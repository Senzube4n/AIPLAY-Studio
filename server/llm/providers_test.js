/**
 * Cloud language models, no network: a fake fetch plays Anthropic and an
 * OpenAI-compatible provider.
 *   node server/llm/providers_test.js
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createCloud, normaliseModels, providerById, PROVIDERS } from "./providers.js";
import { createLlmRoutes } from "./routes.js";
import { createChatRoutes } from "../chat/routes.js";
import { createChatModels } from "../chat/models.js";
import { createQwenModel } from "../chat/loop.js";
import { createMusicTools } from "../chat/music-tools.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-llm-"));
const store = new Map();
const secrets = {
  get: async (n) => store.get(n) ?? null,
  set: async (n, v) => { store.set(n, v); return { stored: true, method: "test" }; },
  has: async (n) => store.has(n),
  clear: async (n) => { store.delete(n); },
  status: async (n) => (store.has(n) ? { set: true, method: "test", hint: `…${store.get(n).slice(-4)}` } : { set: false }),
};

/* ── the fake providers ── */
const calls = [];
const GOOD = { anthropic: "sk-ant-good-1234", openai: "sk-good-5678" };
async function fakeFetch(url, init = {}) {
  const u = String(url);
  const h = init.headers || {};
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, method: init.method, headers: h, body });
  const reply = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
  if (u.startsWith("https://api.anthropic.com/v1")) {
    if (h["x-api-key"] !== GOOD.anthropic) return reply(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (u.includes("/models")) {
      return reply(200, { data: [
        { id: "claude-new", display_name: "Claude New", created_at: "2026-07-24T00:00:00Z" },
        { id: "claude-old", display_name: "Claude Old", created_at: "2025-09-29T00:00:00Z" },
      ] });
    }
    if (body.model === "claude-new" && "temperature" in body) {
      return reply(400, { type: "error", error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." } });
    }
    return reply(200, { content: [{ type: "text", text: '{"say":"hi from claude"}' }], usage: { input_tokens: 10, output_tokens: 5 } });
  }
  if (u.startsWith("https://api.openai.com/v1")) {
    if (h.authorization !== `Bearer ${GOOD.openai}`) return reply(401, { error: { message: "Incorrect API key provided" } });
    if (u.endsWith("/models")) {
      return reply(200, { data: [
        { id: "gpt-b", created: 1_750_000_000 }, { id: "gpt-a", created: 1_700_000_000 },
        { id: "text-embedding-3-large", created: 1_705_000_000 }, { id: "whisper-1", created: 1_600_000_000 },
      ] });
    }
    if ("max_tokens" in body) return reply(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
    return reply(200, { choices: [{ message: { content: '{"say":"hi from gpt"}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  }
  throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}

const config = { uiPort: 4173, settingsFile: path.join(dir, "settings.json"), paths: { appData: dir }, llm: { models: {}, bases: {} } };
const cloud = createCloud({ config, secrets, fetch: fakeFetch, usageFile: path.join(dir, "llm-usage.json") });

/* ══ 1. the table and the list ══ */
console.log("\nTHE PROVIDERS");
ok("Claude, ChatGPT, Gemini, Grok, DeepSeek, Qwen, OpenRouter, Groq and a custom server are all offered",
  ["anthropic", "openai", "gemini", "xai", "deepseek", "qwen", "openrouter", "groq", "custom"].every((id) => providerById(id)));
ok("every provider but the custom one has a base URL and a page to get a key", PROVIDERS.filter((p) => !p.custom).every((p) => /^https:\/\//.test(p.base) && p.keyUrl));
const listed = normaliseModels(providerById("openai"), { data: [
  { id: "z-undated" }, { id: "b", created: 20 }, { id: "a", created: 10 }, { id: "tts-1", created: 5 }, { id: "models/gemini-x", created: 30 },
] });
ok("models come oldest first, undated last, non-chat models dropped, Gemini's models/ prefix removed",
  listed.map((m) => m.id).join(",") === "a,b,gemini-x,z-undated", listed.map((m) => m.id).join(","));

/* ══ 2. connecting ══ */
console.log("\nCONNECTING");
let threw = null;
try { await cloud.connect("anthropic", { key: "sk-ant-wrong" }); } catch (e) { threw = e; }
ok("a rejected key is NOT saved and the error says so plainly", threw && /rejected the API key/.test(threw.message) && !store.has("llm:anthropic"), threw?.message);
const conn = await cloud.connect("anthropic", { key: `  ${GOOD.anthropic}  ` });
ok("a good key is saved trimmed, and the newest model is picked", store.get("llm:anthropic") === GOOD.anthropic && conn.model === "claude-new" && conn.count === 2, JSON.stringify(conn));
const models = await cloud.listModels("anthropic");
ok("Claude's models are listed oldest to newest with their display names", models.map((m) => m.label).join(",") === "Claude Old,Claude New");
const saved = JSON.parse(await readFile(config.settingsFile, "utf8"));
ok("the choice is saved in settings.json and the key is not", saved.llm.models.anthropic === "claude-new" && !JSON.stringify(saved).includes(GOOD.anthropic));
const st = await cloud.status();
const row = st.providers.find((p) => p.id === "anthropic");
ok("status shows connected with only the last four characters", row.connected && row.hint === "…1234" && !JSON.stringify(st).includes(GOOD.anthropic), JSON.stringify(row));

/* ══ 3. completing ══ */
console.log("\nTALKING");
calls.length = 0;
const said = await cloud.complete({ provider: "anthropic", model: "claude-new" }, "hello");
ok("a model that refuses temperature is retried without it", said === '{"say":"hi from claude"}' && calls.length === 2 && !("temperature" in calls[1].body), JSON.stringify(calls.map((c) => c.body)));
calls.length = 0;
await cloud.complete({ provider: "anthropic", model: "claude-new" }, "again");
ok("...and remembered, so the next call is one request", calls.length === 1 && !("temperature" in calls[0].body));
ok("the key goes only to Anthropic, in x-api-key", calls[0].url.startsWith("https://api.anthropic.com/") && calls[0].headers["x-api-key"] === GOOD.anthropic);

await cloud.connect("openai", { key: GOOD.openai });
ok("OpenAI's list drops embeddings and whisper and picks the newest chat model", config.llm.models.openai === "gpt-b"
  && (await cloud.listModels("openai")).map((m) => m.id).join(",") === "gpt-a,gpt-b");
calls.length = 0;
const gpt = await cloud.complete({ provider: "openai", model: "gpt-b" }, "hello");
ok("a model that wants max_completion_tokens gets it on the retry", gpt === '{"say":"hi from gpt"}' && "max_completion_tokens" in calls[calls.length - 1].body && !("max_tokens" in calls[calls.length - 1].body));
const usage = (await cloud.status()).providers.find((p) => p.id === "openai").usage;
ok("tokens are counted per provider for the month", usage?.calls === 1 && usage.input === 7 && usage.output === 3, JSON.stringify(usage));

threw = null;
try { await cloud.connect("custom", { base: "http://127.0.0.1:9/v1" }); } catch (e) { threw = e; }
ok("a custom server that cannot be reached is not kept", threw && /Could not reach/.test(threw.message) && !config.llm.bases.custom, threw?.message);

/* ══ 4. the chat model menus ══ */
console.log("\nTHE MODEL MENUS");
const offlineEngine = { objectInfo: async () => { throw new Error("down"); }, status: async () => ({ ready: false }) };
const chatModels = createChatModels({ engine: offlineEngine, config, cloud });
let menu = await chatModels.status();
ok("with the engine down the menu still offers the connected APIs", menu.offline && menu.models.some((m) => m.file === "api:anthropic") && menu.models.some((m) => m.file === "api:openai"), JSON.stringify(menu));
ok("nothing switches to a paid API by itself", !/^api:/.test(menu.current), menu.current);
await chatModels.choose("api:anthropic");
menu = await chatModels.status();
ok("choosing Claude in the menu makes it current", menu.current === "api:anthropic" && config.chatModel === "api:anthropic");
const ask = createQwenModel({ engine: offlineEngine, resolve: chatModels.resolve, cloud });
ok("the chat model answers through the API and says it needs no graphics card",
  (await ask("hi")) === '{"say":"hi from claude"}' && (await ask.usesCard()) === false);

/* The Simple chat's music routes, with a busy card: a cloud turn still answers. */
const busyEngine = { objectInfo: async () => null, status: async () => ({ ready: true, queue: { running: 1, pending: 0 }, running: [{ via: "music", label: "a song", runningSec: 600 }] }) };
const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { "Content-Type": "application/json" }); res.end(s); };
const readBody = async (req) => { const b = []; for await (const x of req) b.push(x); return b.length ? JSON.parse(Buffer.concat(b).toString()) : {}; };
config.chatModelMusic = "api:openai";
const chat = createChatRoutes({ json, readBody, config, engine: busyEngine, cloud, dir: path.join(dir, "chat"), musicTools: createMusicTools() });
const llm = createLlmRoutes({ json, readBody, cloud, config });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (await llm(req, res, url)) return;
  if (await chat(req, res, url)) return;
  json(res, 404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const H = { "Content-Type": "application/json", "x-aiplay-actor": "script:llm-test" };
const text = await (await fetch(`${BASE}/api/chat/music`, { method: "POST", headers: H, body: JSON.stringify({ message: "hello", form: {} }) })).text();
ok("Simple mode on a cloud model answers while a song is rendering", /hi from gpt/.test(text) && !/"busy"/.test(text), text.slice(0, 300));

const g = await (await fetch(`${BASE}/api/llm`, { headers: H })).json();
ok("GET /api/llm lists every provider and leaks no key", g.providers.length === PROVIDERS.length && !JSON.stringify(g).includes(GOOD.openai));
const refused = await fetch(`${BASE}/api/llm`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ action: "disconnect", provider: "openai" }) });
ok("another website cannot change keys", refused.status === 400 && store.has("llm:openai"));
const t = await (await fetch(`${BASE}/api/llm`, { method: "POST", headers: H, body: JSON.stringify({ action: "test", provider: "anthropic" }) })).json();
ok("the Test button sends one small message and shows the reply", t.ok && /hi from claude/.test(t.reply), JSON.stringify(t));
const bad = await (await fetch(`${BASE}/api/llm`, { method: "POST", headers: H, body: JSON.stringify({ action: "model", provider: "anthropic", model: "claude-imaginary" }) })).json();
ok("a model the provider did not list is refused", /did not list/.test(bad.error || ""), JSON.stringify(bad));
await (await fetch(`${BASE}/api/llm`, { method: "POST", headers: H, body: JSON.stringify({ action: "disconnect", provider: "anthropic" }) })).json();
menu = await chatModels.status();
ok("removing the key takes it out of the menus and the chat falls back to local", !store.has("llm:anthropic") && !menu.models.some((m) => m.file === "api:anthropic") && (await ask.usesCard()) === true);

server.close();
await rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
