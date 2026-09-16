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

/** The CLIPLoader `type` that picks a tokenizer able to generate for this file. */
export function clipTypeFor(file) {
  if (/gemma/i.test(file)) return "ltxv";
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

export function createChatModels({ engine, config }) {
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

  const saved = () => (typeof config.chatModel === "string" && config.chatModel) || null;

  /** The model a turn should use right now: {file, loader, type}. */
  async function resolve() {
    const models = await list().catch(() => null);
    const want = saved();
    if (models?.length) {
      const hit = models.find((m) => m.file === want) || models[0];
      return hit;
    }
    const file = want || DEFAULT_CHAT_MODEL;
    return { file, loader: /\.gguf$/i.test(file) ? "CLIPLoaderGGUF" : "CLIPLoader", type: clipTypeFor(file) };
  }

  async function choose(file) {
    const models = await list({ fresh: true });
    if (models && !models.some((m) => m.file === file)) {
      throw new Error(`ComfyUI cannot load "${file}" as a chat model`);
    }
    config.chatModel = file;
    let cur = {};
    try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
    await mkdir(path.dirname(config.settingsFile), { recursive: true });
    await writeFile(config.settingsFile, JSON.stringify({ ...cur, chatModel: file }, null, 2));
  }

  async function status() {
    const models = await list().catch(() => null);
    const current = models ? (await resolve()).file : saved() || DEFAULT_CHAT_MODEL;
    return { models: models || [], current, offline: !models };
  }

  return { list, resolve, choose, status };
}
