/**
 * COMFY ROUTER: which models exist, what kind of thing each makes, and what
 * each one's input looks like.
 *
 * THE LIST. With a key saved, `GET /v2/models` is the truth (it is free, and
 * it carries each model's billing facts). Without one, the public docs index
 * (docs.comfy.org/llms.txt) names every model's schema file, so the page can
 * be browsed before anyone pays for anything.
 *
 * THE SCHEMAS are public too: docs.comfy.org/router-schemas/<provider>/<model>.json,
 * the same OpenAPI document `GET …/openapi.json` returns with a key. They are
 * cached on disk for a day and handed to the page RESOLVED: $refs inlined,
 * allOf merged, descriptions cut, so the page's form engine reads one plain
 * JSON-schema object instead of an OpenAPI document.
 *
 * THE KIND (image, video, audio, 3d, text) is not in the catalogue, so it is
 * read off the model id by rule, with the featured list in adapters.js
 * overriding it. A model the rule gets wrong is still runnable; it is only
 * filed under the wrong tab.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { FEATURED, featuredById, simpleFor } from "./adapters.js";
import { validModelId } from "./client.js";

export const DOCS = "https://docs.comfy.org";
const DAY = 86_400_000;

/** Image, video, audio, 3d or text, from the id alone. Mirrors the sort the
 *  published schemas support (scripts that checked it: see router_test.js). */
export function kindOf(id) {
  const f = featuredById(id);
  if (f) return f.kind;
  const [p, m = ""] = String(id).toLowerCase().split("/");
  if (["meshy", "tencent"].includes(p) || /3d|mesh|glb|rigging|remesh|animations/.test(m)) return "3d";
  if (["anthropic", "openrouter"].includes(p)) return "text";
  if (/^(gpt-\d|o\d|seed-2|gemini-omni)/.test(m) || (/^gemini-[\d.]+-(pro|flash)/.test(m) && !/image/.test(m))) return "text";
  if (/sfx|eleven|seed-audio|speech|tts|starfish|voice|music/.test(m)) return "audio";
  if (/video|seedance|^kling-v|^kling-3|ltx|^ray|veo|t2v|i2v|r2v|happyhorse|^h3|flashvsr|sync-|lip-sync|avatar|switchx|p-video|aleph|gen4_turbo/.test(m)
      || (p === "moonvalley" && /video/.test(m))) return "video";
  return "image";
}

export function labelOf(id) {
  const f = featuredById(id);
  if (f) return f.label;
  const m = String(id).split("/")[1] || id;
  return m.replace(/[-_]/g, " ").replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/**
 * @param {object} o
 * @param {string} o.dir         a folder for the cache
 * @param {Function} [o.fetchImpl]
 */
export function createCatalog({ dir, fetchImpl = globalThis.fetch } = {}) {
  const schemaDir = path.join(dir, "schemas");
  const listFile = path.join(dir, "models.json");
  const mem = new Map();

  async function cached(file, maxAge, load) {
    try {
      const j = JSON.parse(await readFile(file, "utf8"));
      if (Date.now() - (j.at || 0) < maxAge) return j.data;
    } catch { /* no cache yet */ }
    const data = await load();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ at: Date.now(), data }), "utf8");
    return data;
  }

  async function publicIds() {
    const r = await fetchImpl(`${DOCS}/llms.txt`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`docs.comfy.org answered ${r.status}`);
    const t = await r.text();
    return [...new Set([...t.matchAll(/\/router-schemas\/([^)\s]+?)\.json/g)].map((m) => m[1]))].filter(validModelId);
  }

  return {
    /**
     * Every model, featured first within each kind.
     * @param {object} [o]
     * @param {Function} [o.live]  async () => the API's list, when a key is saved
     */
    async models({ live = null, fresh = false } = {}) {
      let rows = null, source = "docs";
      if (live) {
        try {
          const api = await live();
          if (api.length) {
            rows = api.map((m) => ({ id: m.id, billing: m.billing?.charges_on_policy_rejection ?? null }));
            source = "api";
          }
        } catch { /* fall back to the public list */ }
      }
      if (!rows) {
        const ids = await cached(listFile, fresh ? 0 : DAY, publicIds);
        rows = ids.map((id) => ({ id, billing: null }));
      }
      const have = new Set(rows.map((r) => r.id));
      const order = new Map(FEATURED.map((f, i) => [f.id, i]));
      const out = rows.filter((r) => validModelId(r.id)).map((r) => ({
        id: r.id,
        provider: r.id.split("/")[0],
        kind: kindOf(r.id),
        label: labelOf(r.id),
        featured: order.has(r.id),
        simple: !!simpleFor(r.id),
        /* "yes", "no" or "unknown"; anything else counts as unknown. */
        policyCharged: ["yes", "no", "unknown"].includes(r.billing) ? r.billing : null,
      }));
      out.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e4) - (order.has(b.id) ? order.get(b.id) : 1e4)
        || a.id.localeCompare(b.id));
      /* A featured model the live list does not carry (renamed, withdrawn) is
       * left out rather than offered and refused. */
      return { source, models: out.filter((m) => have.has(m.id)) };
    },

    /** One model's input, resolved for the form engine. */
    async schema(id) {
      if (!validModelId(id)) throw new Error("not a model id");
      if (mem.has(id)) return mem.get(id);
      const file = path.join(schemaDir, `${id.replace("/", "__")}.json`);
      const doc = await cached(file, DAY, async () => {
        const r = await fetchImpl(`${DOCS}/router-schemas/${id}.json`, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`No published schema for ${id} (${r.status}).`);
        return r.json();
      });
      const out = inputOf(doc, id);
      mem.set(id, out);
      return out;
    },
  };
}

/* Keys the form never shows: plumbing the Router fills in or that a desktop
 * app has no use for (webhooks, storage buckets, streaming). */
export const HIDDEN_FIELDS = new Set([
  "callback_url", "external_task_id", "user", "model", "model_name", "model_id", "ai_model",
  "stream", "pubsubTopic", "storageUri", "execution_expires_after", "output",
]);

/**
 * The request body schema of an OpenAPI document, $refs inlined and trimmed.
 * @returns {{id, authored:boolean, description, input:object, example:any}}
 */
export function inputOf(doc, id = "") {
  const comps = doc?.components?.schemas || {};
  const op = Object.values(doc?.paths || {})[0]?.post;
  const body = op?.requestBody?.content?.["application/json"]?.schema || {};
  const resolve = (n, depth, stack) => {
    if (!n || typeof n !== "object" || depth > 24) return {};
    if (n.$ref) {
      const name = n.$ref.split("/").pop();
      if (stack.includes(name)) return { type: "object", description: "(recursive)" };
      return resolve(comps[name] || {}, depth + 1, [...stack, name]);
    }
    const out = {};
    for (const k of ["type", "enum", "default", "minimum", "maximum", "format", "const", "title"]) if (n[k] !== undefined) out[k] = n[k];
    if (typeof n.description === "string") out.description = n.description.replace(/\s+/g, " ").trim().slice(0, 400);
    if (n.example !== undefined && depth === 0) out.example = n.example;
    if (Array.isArray(n.required)) out.required = [...n.required];
    if (n.properties) {
      out.properties = {};
      for (const [k, v] of Object.entries(n.properties)) out.properties[k] = resolve(v, depth + 1, stack);
    }
    if (n.items) out.items = resolve(n.items, depth + 1, stack);
    for (const k of ["oneOf", "anyOf"]) if (Array.isArray(n[k])) out[k] = n[k].slice(0, 8).map((x) => resolve(x, depth + 1, stack));
    if (Array.isArray(n.allOf)) {
      for (const part of n.allOf.map((x) => resolve(x, depth + 1, stack))) {
        if (part.properties) out.properties = { ...(out.properties || {}), ...part.properties };
        if (part.required) out.required = [...new Set([...(out.required || []), ...part.required])];
        if (!out.type && part.type) out.type = part.type;
        if (!out.description && part.description) out.description = part.description;
      }
    }
    return out;
  };
  const input = resolve(body, 0, []);
  return {
    id,
    authored: doc?.["x-comfy-input-schema-authored"] !== false && !!(input.properties || input.oneOf || input.anyOf),
    description: input.description || "",
    input,
    example: input.example ?? null,
    simple: simpleFor(id),
    hidden: [...HIDDEN_FIELDS],
  };
}
