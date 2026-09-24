/* PROMPT TOOLS — saved galleries and the AI "Enhance" button.
 *
 * GALLERIES: a saved list per field (styles, lyrics, simple descriptions, chat
 * prompts), kept in one JSON file under the app's data folder so the page and
 * MCP see the same list. Newest first, duplicates collapse onto the newest.
 *
 * ENHANCE: one model call that rewrites a field — a style line, lyrics, or a
 * Simple-mode description — into a richer version of the same idea. It asks
 * whichever language model is chosen for it: a connected API (Claude, ChatGPT,
 * any OpenAI-compatible server) or a local one run through ComfyUI, the same
 * registry Chat and Simple mode use. Its own choice is saved as
 * `enhanceModel`; with none chosen it uses Simple mode's, then Chat's.
 *
 * A local model runs on the graphics card, so it is refused while a render is
 * using the card (one GPU job at a time); an API model never touches the card
 * and is never refused for that.
 *
 * Routes: GET/POST /api/gallery, GET/POST /api/enhance.
 */
import { assertSafe } from "./safety/refusal.js";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LYRIC_RULES } from "./lyric-style.js";

/* "image" and "video" are the Images and Video panels' Simple-mode ideas. */
export const GALLERY_KINDS = Object.freeze(["styles", "lyrics", "simple", "chat", "image", "video"]);
export const ENHANCE_FIELDS = Object.freeze(["style", "lyrics", "simple"]);
const MAX_ITEMS = 200;
const MAX_TEXT = 8000;

/* ── galleries ───────────────────────────────────────────────────────────── */

/** Pure: a gallery with `text` saved on top (an identical entry moves up). */
export function addToGallery(list, text, { name = "", now = Date.now(), id = randomUUID() } = {}) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("Nothing to save: the box is empty.");
  if (t.length > MAX_TEXT) throw new Error(`Too long to save (${t.length} characters; ${MAX_TEXT} at most).`);
  const rest = (list || []).filter((x) => x.text !== t);
  const clean = String(name || "").trim().slice(0, 80);
  return [{ id, text: t, name: clean || null, at: now }, ...rest].slice(0, MAX_ITEMS);
}

export function createGallery({ file }) {
  let cache = null;
  let chain = Promise.resolve();   // one write at a time: the page and MCP can both save
  async function load() {
    if (cache) return cache;
    try {
      const v = JSON.parse(await readFile(file, "utf8"));
      cache = Object.fromEntries(GALLERY_KINDS.map((k) => [k, Array.isArray(v?.[k]) ? v[k] : []]));
    } catch { cache = Object.fromEntries(GALLERY_KINDS.map((k) => [k, []])); }
    return cache;
  }
  async function persist() {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 1) + "\n");
    await rename(tmp, file);
  }
  const kindOf = (kind) => {
    if (!GALLERY_KINDS.includes(kind)) throw new Error(`Unknown gallery "${kind}". One of: ${GALLERY_KINDS.join(", ")}.`);
    return kind;
  };
  const serial = (fn) => (chain = chain.then(fn, fn));
  return {
    async list(kind) { return (await load())[kindOf(kind)]; },
    save(kind, text, name) {
      return serial(async () => {
        const g = await load();
        g[kindOf(kind)] = addToGallery(g[kind], text, { name });
        await persist();
        return g[kind][0];
      });
    },
    remove(kind, id) {
      return serial(async () => {
        const g = await load();
        const before = g[kindOf(kind)].length;
        g[kind] = g[kind].filter((x) => x.id !== id);
        if (g[kind].length === before) throw new Error("That entry is not in the gallery.");
        await persist();
        return true;
      });
    },
  };
}

/* ── enhance ─────────────────────────────────────────────────────────────── */

const RULES = {
  style: (engine) => [
    "You improve the STYLE PROMPT of an AI music generator.",
    "Rewrite it as ONE line of comma-separated descriptive tags, 12 to 22 tags, under 260 characters.",
    "Keep every idea already in it. Add what is missing: genre and subgenre, lead vocal (who sings and how) unless it says",
    "instrumental, the main instruments, mood, tempo in BPM or a feel, and a production or mix quality.",
    engine === "minimax"
      ? "The model is MiniMax Music: vivid, concrete production words work best."
      : "The model is YuE2: plain lowercase tags like \"female lead vocal, dreamy synth pop, 110 BPM\" work best.",
    "Reply with the style line only: no quotes, no labels, no explanation.",
  ],
  lyrics: () => [
    "You improve SONG LYRICS for an AI music generator.",
    "Keep the song's meaning, point of view and any lines that already work. Tighten the rhythm, make it concrete",
    "and plain-spoken, and give it a memorable, repeatable chorus. Structure it with section tags on their own lines: [Verse], [Pre-Chorus],",
    "[Chorus], [Bridge], [Outro]. If the lyrics are empty or only a few words, write a complete song from the",
    "style and the idea given. Keep it singable: short lines, about 16 to 40 lines in all.",
    ...LYRIC_RULES,
    "Reply with the lyrics only: no title, no notes, no explanation.",
  ],
  simple: () => [
    "You improve a short SONG IDEA that an assistant will turn into a full song.",
    "Rewrite it as two to four sentences: what the song is about, the genre and mood, who sings it and how,",
    "the tempo or energy, and one or two concrete images or details. Keep the original idea and language.",
    "Reply with the improved description only: no quotes, no labels, no explanation.",
  ],
};

/** Pure: the whole prompt for one enhance call. */
export function enhancePrompt(field, text, { style = "", lyrics = "", engine = "yue2" } = {}) {
  if (!ENHANCE_FIELDS.includes(field)) throw new Error(`Enhance works on ${ENHANCE_FIELDS.join(", ")}, not "${field}".`);
  const kind = /minimax/i.test(engine) ? "minimax" : "yue2";
  const lines = [...RULES[field](kind), ""];
  if (field === "lyrics" && String(style).trim()) lines.push(`The song's style: ${String(style).trim()}`, "");
  if (field === "style" && String(lyrics).trim()) lines.push(`The song's lyrics begin: ${String(lyrics).trim().slice(0, 400)}`, "");
  lines.push(`Current ${field === "simple" ? "idea" : field}:`, String(text || "").trim() || "(empty)");
  return lines.join("\n");
}

/** Pure: the model's reply, stripped of the wrapping models add around an answer. */
export function cleanEnhanced(field, raw) {
  let t = String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  t = t.replace(/^```[a-z]*\s*\n?|\n?```\s*$/gi, "").trim();
  t = t.replace(/^(?:sure|okay|ok|here(?:'s| is)[^:\n]*|improved[^:\n]*|enhanced[^:\n]*|style(?: prompt)?|lyrics|description)\s*:\s*\n?/i, "").trim();
  if (field !== "lyrics") {
    t = t.split(/\n\s*\n/)[0].trim();                 // one paragraph
    t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
    if (field === "style") t = t.replace(/\s*\n\s*/g, ", ").replace(/,\s*,/g, ",").replace(/\.$/, "");
  }
  if (!t) throw new Error("The model answered with nothing usable. Try again, or pick another model.");
  return t.slice(0, MAX_TEXT);
}

/**
 * `models`: server/chat/models.js createChatModels({ key: "enhanceModel", … }).
 * `ask`:    server/chat/loop.js createQwenModel({ resolve: models.resolve, … }).
 * `cardBusy`: async () => a reason string when a render holds the card, else null.
 * `ownChoice`: () => Enhance's own saved model, or null.
 */
export function createEnhancer({ models, ask, cardBusy = async () => null, ownChoice = () => null }) {
  return {
    // `own`: Enhance's own saved choice, or null when it borrows Simple mode's or Chat's.
    status: async () => ({ ...(await models.status()), own: ownChoice() }),
    // An empty choice forgets Enhance's own model: Simple mode's, then Chat's, decide again.
    choose: (file) => (file ? models.choose(file) : models.clear()),
    async enhance({ field, text = "", style = "", lyrics = "", engine = "yue2" }) {
      /* ⚠ THE MINORS RULE, BOTH WAYS, ON THE FIELDS THAT BECOME PICTURES. The
       * words asked for are checked before a model is woken, and the words it
       * wrote are checked before they are handed back: an enhanced style or
       * song description becomes a caption, and a caption becomes a cover
       * prompt. LYRICS are a song, and songs are not checked as content
       * (docs/SAFETY.md): a lyric line is judged where it becomes a picture,
       * as a cover hook or a lip-sync shot. Each render door checks again. */
      const judged = field !== "lyrics";
      if (judged) assertSafe({ door: "enhance", via: `enhance.${field}`, texts: [String(text || "")] });
      const prompt = enhancePrompt(field, text, { style, lyrics, engine });
      /* NO CHAT MODEL AT ALL is its own answer, said before anything runs.
       * resolve() falls back to a default file name whether or not it exists,
       * so this used to reach ComfyUI, which refused the graph ("clip_name not
       * in [...]") and the refusal was all the person saw. `need` lets the page
       * open the window that lists the models that would do it. */
      const chosen = await models.resolve().catch(() => null);
      if (!chosen?.api) {
        const installed = typeof models.list === "function" ? await models.list().catch(() => null) : null;
        if (installed && !installed.length) {
          const e = new Error("No chat model is installed, so Enhance has nothing to write with.");
          e.status = 424; e.need = "chat";
          e.apis = ((await models.status().catch(() => null))?.models || []).filter((m) => /^api:/.test(m.file));
          throw e;
        }
      }
      const local = await ask.usesCard();
      if (local) {
        const busy = await cardBusy();
        if (busy) {
          const e = new Error(`${busy} A local model needs the graphics card, so Enhance waits for it — or pick an API model for Enhance, which never touches the card.`);
          e.status = 409; throw e;
        }
      }
      const picked = await models.resolve().catch(() => null);
      const raw = await ask(prompt, { label: `enhance ${field}` });
      const written = cleanEnhanced(field, raw);
      if (judged) assertSafe({ door: "enhance", via: `enhance.${field}`, texts: [written] });
      return { text: written, model: picked?.label || picked?.file || null, local };
    },
  };
}

/* ── routes ──────────────────────────────────────────────────────────────── */

export function createPromptToolRoutes({ json, readBody, gallery, enhancer }) {
  return async function routes(req, res, url) {
    const p = url.pathname;
    try {
      if (p === "/api/gallery") {
        if (req.method === "GET") {
          const kind = url.searchParams.get("kind") || "styles";
          return json(res, 200, { kind, items: await gallery.list(kind) }), true;
        }
        const b = await readBody(req);
        if (b?.action === "save") return json(res, 200, { ok: true, item: await gallery.save(b.kind, b.text, b.name) }), true;
        if (b?.action === "delete") return json(res, 200, { ok: await gallery.remove(b.kind, b.id) }), true;
        return json(res, 400, { error: "action must be save or delete" }), true;
      }
      if (p === "/api/enhance") {
        if (req.method === "GET") return json(res, 200, await enhancer.status()), true;
        const b = await readBody(req);
        if (b?.action === "model") { await enhancer.choose(String(b.model || "")); return json(res, 200, { ok: true, ...(await enhancer.status()) }), true; }
        const out = await enhancer.enhance({ field: b?.field, text: b?.text, style: b?.style, lyrics: b?.lyrics, engine: b?.engine });
        return json(res, 200, { ok: true, ...out }), true;
      }
    } catch (e) {
      return json(res, e.status || 400, { error: String(e.message || e), ...(e.safety ? { code: e.code, ...(e.hint ? { hint: e.hint } : {}) } : {}), ...(e.need ? { need: e.need, apis: e.apis || [] } : {}) }), true;
    }
    return false;
  };
}
