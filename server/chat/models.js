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

/**
 * WHICH OF THESE CAN WRITE (UI_PLAN B2).
 *
 * The list above is every file ComfyUI can load as a text encoder whose name
 * looks like a language model, and six raw file names is what a newcomer was
 * shown. Some of them cannot write at all: a BASE model continues text rather
 * than following an instruction (qwen_3_06b_base), ACE-Step's planners write
 * audio codes, LTX's Gemma carries LTX's projection, and an fp4 build runs
 * natively only on an RTX 50-series card (config.js says why: it is
 * dequantised on load anywhere else). They stay under "Show every file".
 * Returns { ok, why }.
 */
export function writerVerdict(file, { gpuName = null } = {}) {
  const n = path.basename(String(file || "")).toLowerCase();
  if (/(^|[_.-])base([_.-]|$)/.test(n)) return { ok: false, why: "a base model: it continues text, it does not follow a request" };
  if (/ace[_-]?1\.?5|_ace\d/.test(n)) return { ok: false, why: "ACE-Step's planner: it writes audio codes, not words" };
  if (/gemma/.test(n) && /ltx/.test(n)) return { ok: false, why: "LTX's text encoder, with LTX's projection built in" };
  if (/(^|[_.-])(nv)?fp4([_.-]|$)/.test(n) && !/rtx\s*50\d\d/i.test(String(gpuName || ""))) {
    return { ok: false, why: "an fp4 build: only RTX 50-series cards run it natively" };
  }
  return { ok: true, why: null };
}

/** "Qwen3 4B - writes lyrics and prompts": the model, in words, and what it is for. */
export function writerLabel(file) {
  const n = path.basename(String(file || "")).toLowerCase();
  const size = (n.match(/(?:^|[_-])(\d+(?:\.\d+)?)b(?:[_.-]|$)/) || [])[1];
  const family = /qwen[_-]?3[_-]?vl/.test(n) ? "Qwen3-VL" : /qwen[_-]?3/.test(n) ? "Qwen3"
    : /qwen[_-]?2[._-]?5/.test(n) ? "Qwen2.5" : /gemma[_-]?3/.test(n) ? "Gemma 3" : /gemma/.test(n) ? "Gemma"
    : /llama/.test(n) ? "Llama" : /ministral/.test(n) ? "Ministral" : /mistral/.test(n) ? "Mistral" : null;
  const name = family ? `${family}${size ? ` ${size}B` : ""}` : labelFor(file);
  return `${name} - writes lyrics and prompts`;
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
/* `gpu` (optional): () => gpuStatus(), for the card's name — writerVerdict()
 * keeps fp4 builds off every card but an RTX 50-series. */
export function createChatModels({ engine, config, key = "chatModel", fallbackKey = null, cloud = null, gpu = null }) {
  let cache = null;          // { at, models }
  const gpuName = () => { try { return (typeof gpu === "function" ? gpu() : gpu)?.name || null; } catch { return null; } };
  /* The rows that can write, each with its friendly name; the same builds of
   * one model told apart by precision. */
  const writersOf = (models) => {
    const rows = (models || []).filter((m) => writerVerdict(m.file, { gpuName: gpuName() }).ok)
      .map((m) => ({ ...m, label: writerLabel(m.file), fileLabel: m.label }));
    const seen = new Map();
    for (const r of rows) seen.set(r.label, (seen.get(r.label) || 0) + 1);
    const quant = (r) => (/\(([^)]+)\)$/.exec(r.fileLabel || "") || [])[1] || path.basename(r.file);
    return rows.map((r) => (seen.get(r.label) > 1 ? { ...r, label: r.label.replace(" - ", ` (${quant(r)}) - `) } : r));
  };

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
      /* Nothing chosen: a model that can write, before a base model or a planner. */
      const hit = models.find((m) => m.file === want) || writersOf(models)[0] || models[0];
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
    /* `models` is what can write (UI_PLAN B2), friendly names first; `every`
     * is every file, for "Show every file". A person's own choice stays in
     * `models` even when it would be filtered: it is theirs. */
    const writers = writersOf(models);
    const mine = !writers.some((m) => m.file === current) ? (models || []).find((m) => m.file === current) : null;
    const every = [...apis, ...(models || []).map((m) => {
      const v = writerVerdict(m.file, { gpuName: gpuName() });
      return v.ok ? m : { ...m, why: v.why };
    })];
    /* `offline` is still about the ENGINE: the page shows the API rows either way. */
    return { models: [...apis, ...writers, ...(mine ? [mine] : [])], every, current, offline: !models };
  }

  return { list, resolve, choose, clear, status };
}
