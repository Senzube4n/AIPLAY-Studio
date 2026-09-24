/**
 * CLOUD LANGUAGE MODELS — an API key in place of the local chat model.
 *
 * The Chat tab and the Music panel's Simple mode normally talk to a Qwen3 or
 * Gemma file through ComfyUI. With a key saved here they can talk to a hosted
 * model instead: Claude, ChatGPT, Gemini, Grok, DeepSeek, Qwen, Mistral, Kimi,
 * Groq, Cerebras, Together, anything on OpenRouter, or any server that speaks
 * the OpenAI chat API (LM Studio, Ollama, vLLM — the "custom" row).
 *
 * The loop does not change. It builds one prompt and wants one string back;
 * `complete()` is that seam for a hosted model, the way createQwenModel() is
 * for the local one. Tools, the confirm-before-spend gate and the sessions
 * are the same code whichever model answers.
 *
 * TWO WIRE SHAPES cover every provider in the table: Anthropic's Messages API,
 * and the OpenAI chat-completions API that everyone else copied. What differs
 * between the copies — `max_tokens` versus `max_completion_tokens`, whether a
 * model accepts `temperature` at all — is learned from the provider's own 400
 * and remembered per model, rather than typed into a table that is wrong the
 * next time a model ships. (Measured 2026-09-17: claude-opus-5 and
 * claude-fable-5-1 refuse `temperature`; claude-haiku-4-5 accepts it.)
 *
 * KEYS go through server/secrets.js (DPAPI on Windows) and are sent only to the
 * provider they belong to. A decrypted key is held in this process for ten
 * minutes so a six-step chat turn is not six PowerShell launches; saving or
 * removing a key drops it at once.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/* ── the table ──────────────────────────────────────────────────────────── */

/** `wire` is "anthropic" or "openai". `keyUrl` is where a person gets a key. */
export const PROVIDERS = [
  { id: "anthropic", name: "Claude", company: "Anthropic", wire: "anthropic",
    base: "https://api.anthropic.com/v1", keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-…" },
  { id: "openai", name: "ChatGPT", company: "OpenAI", wire: "openai",
    base: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-…" },
  { id: "gemini", name: "Gemini", company: "Google", wire: "openai",
    base: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza…" },
  { id: "xai", name: "Grok", company: "xAI", wire: "openai",
    base: "https://api.x.ai/v1", keyUrl: "https://console.x.ai", keyHint: "xai-…" },
  { id: "deepseek", name: "DeepSeek", company: "DeepSeek AI", wire: "openai",
    base: "https://api.deepseek.com/v1", keyUrl: "https://platform.deepseek.com/api_keys", keyHint: "sk-…" },
  { id: "qwen", name: "Qwen", company: "Alibaba Cloud Model Studio", wire: "openai",
    base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key", keyHint: "sk-…" },
  { id: "mistral", name: "Mistral", company: "Mistral AI", wire: "openai",
    base: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys", keyHint: "" },
  { id: "moonshot", name: "Kimi", company: "Moonshot AI", wire: "openai",
    base: "https://api.moonshot.ai/v1", keyUrl: "https://platform.moonshot.ai/console/api-keys", keyHint: "sk-…" },
  { id: "openrouter", name: "OpenRouter", company: "Hundreds of models, one key", wire: "openai",
    base: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys", keyHint: "sk-or-…" },
  { id: "groq", name: "Groq", company: "Fast hosted open models", wire: "openai",
    base: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", keyHint: "gsk_…" },
  { id: "cerebras", name: "Cerebras", company: "Cerebras Inference", wire: "openai",
    base: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai", keyHint: "csk-…" },
  { id: "together", name: "Together AI", company: "Hosted open models", wire: "openai",
    base: "https://api.together.xyz/v1", keyUrl: "https://api.together.ai/settings/api-keys", keyHint: "" },
  { id: "custom", name: "Custom server", company: "Any OpenAI-compatible API — LM Studio, Ollama, vLLM", wire: "openai",
    base: "", custom: true, keyOptional: true, keyUrl: null, keyHint: "optional" },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;
export const secretName = (id) => `llm:${id}`;

/** Longest reply a turn may ask for. The loop wants one JSON object; the room
 *  is for reasoning models, which spend part of it thinking. */
export const MAX_OUTPUT_TOKENS = 4096;
const KEY_TTL_MS = 10 * 60_000;
const LIST_TTL_MS = 10 * 60_000;

/* ── which listed models can chat ───────────────────────────────────────── */

const NOT_CHAT = /embed|whisper|tts|transcri|speech|audio|realtime|dall-?e|image|imagen|veo|sora|moderation|rerank|guard|davinci|babbage|computer-use|aqa|learnlm/i;

export function isChatModelId(id) {
  return !NOT_CHAT.test(String(id));
}

/** "claude-opus-4-5-20251101" stays as given; Gemini's "models/…" loses its prefix. */
const cleanId = (id) => String(id).replace(/^models\//, "");

/**
 * The provider's /models answer as `[{id, label, created}]`, OLDEST FIRST.
 * `created` is epoch milliseconds or null; undated models sort by name after
 * the dated ones, because no date is not the same as old.
 */
export function normaliseModels(provider, body) {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const id = cleanId(r?.id ?? r?.name ?? "");
    if (!id || seen.has(id) || !isChatModelId(id)) continue;
    if (Array.isArray(r?.architecture?.output_modalities) && !r.architecture.output_modalities.includes("text")) continue;
    if (Array.isArray(r?.supportedGenerationMethods) && !r.supportedGenerationMethods.includes("generateContent")) continue;
    seen.add(id);
    let created = null;
    if (typeof r.created_at === "string") created = Date.parse(r.created_at) || null;
    else if (Number.isFinite(r.created) && r.created > 0) created = r.created < 1e12 ? r.created * 1000 : r.created;
    const label = String(r.display_name || (provider.id === "openrouter" ? r.name : "") || id);
    out.push({ id, label, created });
  }
  out.sort((a, b) => {
    if (a.created && b.created) return a.created - b.created || a.id.localeCompare(b.id);
    if (a.created) return -1;
    if (b.created) return 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}

/* ── errors a person can act on ─────────────────────────────────────────── */

export class CloudError extends Error {
  constructor(message, { status = 0, provider = null, body = null } = {}) {
    super(message);
    this.status = status;
    this.provider = provider;
    this.body = body;
  }
}

function providerMessage(body) {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 300);
  const e = body.error;
  if (typeof e === "string") return e;
  return String(e?.message || body.message || body.detail || "").slice(0, 300);
}

function explain(provider, status, body) {
  const said = providerMessage(body);
  const who = provider.name;
  if (status === 401 || status === 403) return `${who} rejected the API key${said ? ` (${said})` : ""}. Check it on the Agent page.`;
  if (status === 402) return `${who} says the account has no credit left${said ? ` (${said})` : ""}.`;
  if (status === 429) return `${who} is rate-limiting this key or it is out of quota${said ? ` (${said})` : ""}. Wait a moment, or check the account.`;
  if (status === 404) return `${who} does not know that model${said ? ` (${said})` : ""}. Pick another on the Agent page.`;
  if (status >= 500) return `${who} had a server error (${status})${said ? `: ${said}` : ""}. Try again shortly.`;
  return `${who} refused the request (${status})${said ? `: ${said}` : ""}.`;
}

/* ── the registry ───────────────────────────────────────────────────────── */

/**
 * deps:
 *   config   — the live config; `config.llm` holds models and bases, and
 *              `config.settingsFile` is where choices are saved
 *   secrets  — { get, set, has, clear, status } (server/secrets.js shapes)
 *   fetch    — injectable for tests
 *   usageFile — where token counts per provider per month are kept
 */
export function createCloud({ config, secrets, fetch: doFetch = globalThis.fetch, usageFile = null } = {}) {
  config.llm ||= { models: {}, bases: {} };
  config.llm.models ||= {};
  config.llm.bases ||= {};
  config.llm.names ||= {};

  const keys = new Map();          // id -> { value, at }
  const lists = new Map();         // id -> { at, models }
  const quirks = new Map();        // "provider|model" -> { noTemperature, completionTokens }

  function baseOf(p) {
    const b = p.custom ? config.llm.bases[p.id] || "" : config.llm.bases[p.id] || p.base;
    return String(b).replace(/\/+$/, "");
  }

  async function keyOf(p) {
    const hit = keys.get(p.id);
    if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.value;
    const value = await secrets.get(secretName(p.id));
    if (value) keys.set(p.id, { value, at: Date.now() });
    return value || null;
  }

  function headers(p, key) {
    if (p.wire === "anthropic") {
      return { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    }
    const h = { "content-type": "application/json" };
    if (key) h.authorization = `Bearer ${key}`;
    if (p.id === "openrouter") h["X-Title"] = "AIPLAY Studio";
    return h;
  }

  async function call(p, url, init, timeoutMs) {
    let r;
    try {
      r = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const why = e?.name === "TimeoutError" ? `no answer after ${Math.round(timeoutMs / 1000)} s` : (e?.cause?.code || e?.message || String(e));
      throw new CloudError(`Could not reach ${p.name} (${why}).`, { provider: p.id });
    }
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!r.ok) throw new CloudError(explain(p, r.status, body), { status: r.status, provider: p.id, body });
    return body;
  }

  async function saveSettings() {
    if (!config.settingsFile) return;
    let cur = {};
    try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
    await mkdir(path.dirname(config.settingsFile), { recursive: true });
    await writeFile(config.settingsFile, JSON.stringify({ ...cur, llm: { models: config.llm.models, names: config.llm.names, bases: config.llm.bases } }, null, 2));
  }

  /* ── usage, so a bill is never a surprise ── */
  let usage = null;
  const month = () => new Date().toISOString().slice(0, 7);
  async function loadUsage() {
    if (usage) return usage;
    usage = {};
    if (usageFile) { try { usage = JSON.parse(await readFile(usageFile, "utf-8")) || {}; } catch { /* none yet */ } }
    return usage;
  }
  async function addUsage(id, input, output) {
    const u = await loadUsage();
    const row = ((u[month()] ||= {})[id] ||= { calls: 0, input: 0, output: 0 });
    row.calls += 1; row.input += input || 0; row.output += output || 0;
    if (usageFile) {
      try { await mkdir(path.dirname(usageFile), { recursive: true }); await writeFile(usageFile, JSON.stringify(u, null, 2)); }
      catch { /* a count that failed to save is not worth failing a reply over */ }
    }
  }

  /* ── what the page and the model menus read ── */

  /** Connected = a key is saved (or, for the custom server, a base URL is set). */
  async function isConnected(p) {
    if (p.custom) return !!baseOf(p);
    return await secrets.has(secretName(p.id));
  }

  async function status() {
    const u = (await loadUsage())[month()] || {};
    const rows = [];
    for (const p of PROVIDERS) {
      const connected = await isConnected(p);
      const st = connected && !p.custom ? await secrets.status(secretName(p.id)) : null;
      rows.push({
        id: p.id, name: p.name, company: p.company, keyUrl: p.keyUrl, keyHint: p.keyHint,
        custom: !!p.custom, keyOptional: !!p.keyOptional,
        connected, hint: st?.hint || null, protection: st?.method || null,
        /* When it was saved and by which copy of Studio: a key another copy saved
         * on this Windows account is shown as that, not silently reused
         * (server/secrets.js secretStatus). */
        said: st?.said || null, savedHere: st?.savedHere ?? null, savedAt: st?.savedAt || null,
        base: p.custom ? baseOf(p) : null,
        model: config.llm.models[p.id] || null,
        usage: u[p.id] || null,
      });
    }
    return { providers: rows, month: month() };
  }

  /** The rows the chat model menus add above the local files. */
  async function choices() {
    const out = [];
    for (const p of PROVIDERS) {
      const model = config.llm.models[p.id];
      if (!model || !(await isConnected(p))) continue;
      const known = lists.get(p.id)?.models?.find((x) => x.id === model)?.label || config.llm.names[p.id];
      out.push({ file: `api:${p.id}`, provider: p.id, model, label: `${p.name} API · ${known || model}`, api: true });
    }
    return out;
  }

  /** `api:<provider>` -> { provider, model } when it can answer now, else null. */
  async function resolveChoice(value) {
    const m = /^api:([a-z0-9_-]+)$/.exec(String(value || ""));
    if (!m) return null;
    const p = providerById(m[1]);
    const model = p && config.llm.models[p.id];
    if (!model || !(await isConnected(p))) return null;
    return { provider: p.id, model };
  }

  async function listModels(id, { fresh = false, key: given = null } = {}) {
    const p = providerById(id);
    if (!p) throw new CloudError(`No provider called "${id}".`);
    const hit = lists.get(id);
    if (!fresh && !given && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.models;
    const base = baseOf(p);
    if (!base) throw new CloudError("Set the server address first.", { provider: id });
    const key = given ?? await keyOf(p);
    if (!key && !p.keyOptional) throw new CloudError(`No ${p.name} key is saved.`, { provider: id });
    const url = p.wire === "anthropic" ? `${base}/models?limit=1000` : `${base}/models`;
    const body = await call(p, url, { method: "GET", headers: headers(p, key) }, 30_000);
    const models = normaliseModels(p, body);
    if (!given) lists.set(id, { at: Date.now(), models });
    return models;
  }

  /**
   * Save a key — but only one the provider accepts. Listing models is free on
   * every provider here, so a typo is caught before it is stored rather than
   * at the first chat message. A network failure is not a rejection: the key
   * is kept and the page is told the check could not run.
   */
  async function connect(id, { key = "", base = null } = {}) {
    const p = providerById(id);
    if (!p) throw new CloudError(`No provider called "${id}".`);
    const k = String(key || "").trim();
    if (p.custom) {
      const b = String(base ?? "").trim().replace(/\/+$/, "");
      if (!/^https?:\/\/\S+$/i.test(b)) throw new CloudError("The server address must start with http:// or https://, e.g. http://127.0.0.1:1234/v1");
      config.llm.bases[p.id] = b;
    } else if (!k) {
      throw new CloudError(`Paste a ${p.name} API key.`);
    }
    let models = null;
    let checked = true;
    try {
      models = await listModels(id, { key: k || null, fresh: true });
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      if (p.custom && !e.status) { delete config.llm.bases[p.id]; throw e; }
      checked = false;
    }
    if (k) {
      await secrets.set(secretName(p.id), k);
      keys.set(p.id, { value: k, at: Date.now() });
    } else if (p.custom) {
      await secrets.clear(secretName(p.id));
      keys.delete(p.id);
    }
    if (models) {
      lists.set(id, { at: Date.now(), models });
      const current = config.llm.models[p.id];
      if (!current || !models.some((m) => m.id === current)) {
        const newest = models[models.length - 1];
        if (newest) config.llm.models[p.id] = newest.id;
      }
      config.llm.names[p.id] = models.find((m) => m.id === config.llm.models[p.id])?.label || config.llm.models[p.id];
    }
    await saveSettings();
    return { checked, count: models?.length ?? null, model: config.llm.models[p.id] || null };
  }

  async function disconnect(id) {
    const p = providerById(id);
    if (!p) throw new CloudError(`No provider called "${id}".`);
    await secrets.clear(secretName(p.id));
    keys.delete(p.id);
    lists.delete(p.id);
    if (p.custom) delete config.llm.bases[p.id];
    delete config.llm.models[p.id];
    delete config.llm.names[p.id];
    await saveSettings();
  }

  async function chooseModel(id, model) {
    const p = providerById(id);
    if (!p) throw new CloudError(`No provider called "${id}".`);
    const want = String(model || "").trim();
    if (!want) throw new CloudError("Pick a model.");
    const known = lists.get(id)?.models;
    if (known && !known.some((m) => m.id === want)) throw new CloudError(`${p.name} did not list "${want}".`);
    config.llm.models[p.id] = want;
    config.llm.names[p.id] = known?.find((m) => m.id === want)?.label || want;
    await saveSettings();
  }

  /**
   * ONE completion: the loop's whole prompt in, the reply text out.
   *
   * The prompt goes in as a single user message. It already carries its own
   * instructions, tool list and transcript — built for a 4B model that has no
   * separate system channel through TextGenerate — and splitting it would make
   * the two paths see different conversations.
   */
  async function complete({ provider, model }, prompt, { maxTokens = MAX_OUTPUT_TOKENS, timeoutMs = 180_000 } = {}) {
    const p = providerById(provider);
    if (!p) throw new CloudError(`No provider called "${provider}".`);
    const key = await keyOf(p);
    if (!key && !p.keyOptional) throw new CloudError(`No ${p.name} key is saved — add one on the Agent page.`, { provider });
    const base = baseOf(p);
    const q = quirks.get(`${provider}|${model}`) || {};

    for (let attempt = 0; attempt < 3; attempt++) {
      let url, body;
      if (p.wire === "anthropic") {
        url = `${base}/messages`;
        body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: String(prompt) }] };
      } else {
        url = `${base}/chat/completions`;
        body = { model, messages: [{ role: "user", content: String(prompt) }] };
        body[q.completionTokens ? "max_completion_tokens" : "max_tokens"] = maxTokens;
      }
      if (!q.noTemperature) body.temperature = 0;

      try {
        const out = await call(p, url, { method: "POST", headers: headers(p, key), body: JSON.stringify(body) }, timeoutMs);
        let text, inTok, outTok;
        if (p.wire === "anthropic") {
          text = (out?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
          inTok = out?.usage?.input_tokens; outTok = out?.usage?.output_tokens;
        } else {
          const msg = out?.choices?.[0]?.message;
          text = Array.isArray(msg?.content) ? msg.content.map((c) => c?.text || "").join("") : String(msg?.content ?? "");
          inTok = out?.usage?.prompt_tokens; outTok = out?.usage?.completion_tokens;
        }
        await addUsage(provider, inTok, outTok);
        if (!text.trim()) throw new CloudError(`${p.name} returned an empty reply from ${model}.`, { provider });
        return text;
      } catch (e) {
        /* Learn the model's dialect from its own refusal, once, and remember it. */
        const said = providerMessage(e.body).toLowerCase();
        if (e.status === 400 && !q.noTemperature && /temperature/.test(said)) {
          q.noTemperature = true; quirks.set(`${provider}|${model}`, q); continue;
        }
        if (e.status === 400 && !q.completionTokens && p.wire === "openai" && /max_tokens|max_completion_tokens/.test(said)) {
          q.completionTokens = true; quirks.set(`${provider}|${model}`, q); continue;
        }
        throw e;
      }
    }
    throw new CloudError(`${p.name} kept refusing the request for ${model}.`, { provider });
  }

  return { PROVIDERS, status, choices, resolveChoice, listModels, connect, disconnect, chooseModel, complete };
}
