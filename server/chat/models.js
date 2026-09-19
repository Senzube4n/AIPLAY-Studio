/**
 * WHICH LANGUAGE MODEL ANSWERS THE CHAT.
 *
 * The chat runs a text encoder that can also generate (ComfyUI's TextGenerate
 * node). It used to be hardcoded to qwen_3_4b.safetensors, so a machine that
 * kept a different Qwen3 build — an fp8 Qwen3-VL-4B, a Q8_0 GGUF — had a chat
 * that could not answer at all and no way to say so.
 *
 * The list is whatever ComfyUI itself can load: the clip_name choices of
 * CLIPLoader (and CLIPLoaderGGUF when ComfyUI-GGUF is installed), which already
 * include every extra model folder the install knows about. It is filtered to
 * the language-model families ComfyUI can generate with.
 *
 * The choice is saved as `chatModel` in settings.json. With no choice saved the
 * default file is used when present, otherwise the best Qwen3 match.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CHAT_MODEL = "qwen_3_4b.safetensors";

const FAMILY = /qwen|gemma|llama|mistral|ministral/i;
/* Named like a language model but not one TextGenerate can drive. */
const NOT_CHAT = /tts|minimax|yue|ace[_-]?step|umt5|byt5|(^|[^a-z])t5|clip_[glh]\b|mmproj|audio|vae/i;

/** The CLIPLoader `type` that picks a tokenizer able to generate for this file.
 *
 * Qwen3-VL must NOT go through flux2: that path reuses the Klein encoder and
 * skips ComfyUI's `model.language_model.` → `model.` key rename, so a VL file
 * saved in the newer transformers layout (Huihui-Qwen3-VL-4B, for one) loads
 * with no language weights and fails with "mat1 and mat2 shapes cannot be
 * multiplied (…x2560 and 4096x2560)". Any type outside ComfyUI's special list
 * reaches its native Qwen3-VL model; qwen_image is one every build knows. */
export function clipTypeFor(file) {
  if (/gemma/i.test(file)) return "ltxv";
  if (/qwen[_-]?3[_-]?vl/i.test(file)) return "qwen_image";
  if (/qwen[_-]?2[._-]?5/i.test(file)) return "qwen_image";
  return "flux2";
}

/** A short readable name: "Qwen3-VL-4B-Instruct-abliterated (fp8)". */
export function labelFor(file) {
  const base = path.basename(String(file)).replace(/\.(safetensors|gguf)$/i, "");
  const quant = (base.match(/(q\d_[a-z0-9_]+|fp8[a-z0-9_]*|fp16|bf16|int8)/i) || [])[1];
  const name = base.replace(/[._-]?(q\d_[a-z0-9_]+|fp8[a-z0-9_]*|fp16|bf16|int8|scaled)$/gi, "")
    .replace(/[._-]?(q\d_[a-z0-9_]+|fp8[a-z0-9_]*|fp16|bf16|int8|scaled)$/gi, "");
  return quant ? `${name} (${quant.replace(/_scaled$/i, "")})` : name;
}

/** Choices out of an /object_info row, old ([list]) and new (["COMBO",{options}]) shapes. */
function choicesOf(info, cls) {
  const spec = info?.[cls]?.input?.required?.clip_name;
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0];
  if (Array.isArray(spec[1]?.options)) return spec[1].options;
  return [];
}

export function isChatModel(file) {
  const name = path.basename(String(file));
  return /\.(safetensors|gguf)$/i.test(name) && FAMILY.test(name) && !NOT_CHAT.test(name);
}

/** Rank for the automatic pick: the default file, then plain Qwen3-4B, then any Qwen3. */
function rank(file) {
  const n = path.basename(file).toLowerCase();
  if (n === DEFAULT_CHAT_MODEL) return 0;
  if (/qwen[_-]?3[^v]*4b/.test(n) && n.endsWith(".safetensors")) return 1;
  if (/qwen[_-]?3.*4b/.test(n) && n.endsWith(".safetensors")) return 2;
  if (/qwen[_-]?3.*4b/.test(n)) return 3;
  if (/qwen[_-]?3/.test(n)) return 4;
  return 5;
}

/* `key` is the settings field the choice is saved under; Simple mode keeps its
 * own (`chatModelMusic`) and falls back to the Chat tab's (`fallbackKey`).
 *
 * `cloud` (server/llm/providers.js) adds one row per connected API provider,
 * valued `api:<provider>`. Those rows need no ComfyUI, so the menu still works
 * with the engine down; a saved `api:` choice whose key has since been removed
 * falls back to a local file rather than failing the turn. Nothing is ever
 * switched to a paid API automatically — only a person picking it does that. */
export function createChatModels({ engine, config, key = "chatModel", fallbackKey = null, cloud = null }) {
  let cache = null;          // { at, models }

  async function list({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.models;
    const [plain, gguf] = await Promise.all([
      engine.objectInfo("CLIPLoader").catch(() => null),
      engine.objectInfo("CLIPLoaderGGUF").catch(() => null),
    ]);
    if (!plain && !gguf) return null;              // ComfyUI not reachable
    const seen = new Set();
    const models = [];
    for (const f of choicesOf(plain, "CLIPLoader")) {
      if (!isChatModel(f) || !/\.safetensors$/i.test(f) || seen.has(f)) continue;
      seen.add(f); models.push({ file: f, loader: "CLIPLoader" });
    }
    for (const f of choicesOf(gguf, "CLIPLoaderGGUF")) {
      if (!isChatModel(f) || !/\.gguf$/i.test(f) || seen.has(f)) continue;
      seen.add(f); models.push({ file: f, loader: "CLIPLoaderGGUF" });
    }
    for (const m of models) { m.type = clipTypeFor(m.file); m.label = labelFor(m.file); }
    models.sort((a, b) => rank(a.file) - rank(b.file) || a.label.localeCompare(b.label));
    cache = { at: Date.now(), models };
    return models;
  }

  const pick = (k) => (k && typeof config[k] === "string" && config[k]) || null;
  // `fallbackKey` may be one key or a list, tried in order (Enhance: its own, then Simple mode's, then Chat's).
  const saved = () => pick(key) || [].concat(fallbackKey || []).map(pick).find(Boolean) || null;

  /** The model a turn should use right now: {file, loader, type}, or
   *  {file, api: {provider, model}} for a cloud choice. */
  async function resolve() {
    const want = saved();
    if (cloud && /^api:/.test(want || "")) {
      const api = await cloud.resolveChoice(want).catch(() => null);
      if (api) return { file: want, api, label: `${api.provider} · ${api.model}` };
    }
    const models = await list().catch(() => null);
    if (models?.length) {
      const hit = models.find((m) => m.file === want) || models[0];
      return hit;
    }
    const file = want || DEFAULT_CHAT_MODEL;
    return { file, loader: /\.gguf$/i.test(file) ? "CLIPLoaderGGUF" : "CLIPLoader", type: clipTypeFor(file) };
  }

  async function choose(file) {
    if (/^api:/.test(String(file))) {
      if (!cloud || !(await cloud.resolveChoice(file))) {
        throw new Error("That API is not connected, or has no model picked — see the Agent page.");
      }
      config[key] = file;
      let cur = {};
      try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
      await mkdir(path.dirname(config.settingsFile), { recursive: true });
      await writeFile(config.settingsFile, JSON.stringify({ ...cur, [key]: file }, null, 2));
      return;
    }
    const models = await list({ fresh: true });
    if (models && !models.some((m) => m.file === file)) {
      throw new Error(`ComfyUI cannot load "${file}" as a chat model`);
    }
    config[key] = file;
    let cur = {};
    try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
    await mkdir(path.dirname(config.settingsFile), { recursive: true });
    await writeFile(config.settingsFile, JSON.stringify({ ...cur, [key]: file }, null, 2));
  }

  /** Forget this key's own choice, so the fallback keys decide again. */
  async function clear() {
    delete config[key];
    let cur = {};
    try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* nothing saved */ }
    delete cur[key];
    await mkdir(path.dirname(config.settingsFile), { recursive: true });
    await writeFile(config.settingsFile, JSON.stringify(cur, null, 2));
  }

  async function status() {
    const models = await list().catch(() => null);
    const apis = cloud ? await cloud.choices().catch(() => []) : [];
    const picked = await resolve();
    const current = picked.api || models ? picked.file : saved() || DEFAULT_CHAT_MODEL;
    /* `offline` is still about the ENGINE: the page shows the API rows either way. */
    return { models: [...apis, ...(models || [])], current, offline: !models };
  }

  return { list, resolve, choose, clear, status };
}
