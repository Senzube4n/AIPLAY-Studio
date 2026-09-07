/**
 * The prompt shelf — templates worth keeping, and where the LLM half lives.
 *
 * WHY THERE IS NO LLM CLIENT IN THIS FILE. Asking for "twenty character
 * archetypes as a {a|b|c} template" is exactly what a language model is for,
 * and this app has one: the agent already driving MCP. Adding a second — an
 * API key, a cloud round trip, a bill — would send your prompts off the machine
 * to duplicate something already connected, in an app whose entire premise is
 * that it runs locally.
 *
 * So authoring is a TOOL, not a service. The agent writes a template and saves
 * it here; the screen lists what is on the shelf, drops one into the prompt box
 * and lets it be edited. Same division as the music-video bible: the agent
 * drafts, the human owns the result, and both reach the same document.
 *
 * A template is just a prompt with {a|b|c} groups in it, so preview_prompt
 * already says what one will produce and combinations() already counts it. This
 * file only remembers them.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MAX_TEMPLATES = 300;
const newId = () => `t_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

export function createPromptStore(file) {
  let byId = new Map();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      for (const t of raw.templates || []) if (t && t.id) byId.set(t.id, t);
    } catch { /* no shelf yet, or corrupt: empty is the honest fallback */ }
  }

  async function save() {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ templates: [...byId.values()] }, null, 1));
    } catch { /* a shelf that cannot be written must not take the app down */ }
  }

  const norm = (s) => String(s ?? "").trim();
  const key = (s) => norm(s).toLowerCase();

  return {
    async list(tag) {
      await load();
      const all = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return tag ? all.filter((t) => key(t.tag) === key(tag)) : all;
    },

    async get(idOrName) {
      await load();
      if (byId.has(idOrName)) return byId.get(idOrName);
      const k = key(idOrName);
      return [...byId.values()].find((t) => key(t.name) === k) || null;
    },

    /** Save by NAME, so re-authoring "outfits" replaces it instead of piling up. */
    async save(input = {}) {
      await load();
      const name = norm(input.name);
      const template = norm(input.template);
      if (!name) throw new Error("A template needs a name.");
      if (!template) throw new Error("A template needs a prompt — that is the whole of it.");

      const existing = input.id ? byId.get(input.id) : await this.get(name);
      const t = {
        id: existing?.id || newId(),
        name,
        template,
        /* What KIND of thing this varies — characters, outfits, sceneries,
         * artist styles. A loose label rather than an enum: the shelf should not
         * argue with someone about which drawer their idea belongs in. */
        tag: norm(input.tag ?? existing?.tag),
        notes: norm(input.notes ?? existing?.notes),
        /* Who wrote it. An agent-drafted template and one a person typed are
         * different things to trust, and the ledger records that distinction
         * everywhere else in this app. */
        by: norm(input.by ?? existing?.by) || "user",
        at: existing?.at || Date.now(),
        updatedAt: Date.now(),
      };
      byId.set(t.id, t);
      while (byId.size > MAX_TEMPLATES) byId.delete(byId.keys().next().value);
      await save();
      return t;
    },

    async remove(idOrName) {
      await load();
      const t = await this.get(idOrName);
      if (!t) return false;
      byId.delete(t.id);
      await save();
      return true;
    },
  };
}
