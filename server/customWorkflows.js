/**
 * Bring your own ComfyUI graph.
 *
 * Studio's built-in graphs are tuned, and that tuning is most of what it knows.
 * But they are also opinionated: one image model, two video engines, a fixed
 * sampler. Anyone who already lives in ComfyUI has a graph they prefer, and the
 * honest answer to "can I use mine?" should be yes rather than "fork it".
 *
 * HOW IT WORKS. Drop an **API-format** graph into `workflows/custom/`. Studio
 * substitutes a handful of placeholder tokens and submits it unchanged
 * otherwise. No node rewriting, no graph surgery, no attempt to be clever about
 * what your nodes mean — Studio does not understand your graph and does not
 * pretend to. It fills in the blanks you marked and gets out of the way.
 *
 * ⚠ API FORMAT, NOT THE UI SAVE. ComfyUI's "Save" writes an editor document —
 * nodes, links, positions, widget arrays — which /prompt cannot execute. The one
 * that works is "Save (API Format)" (enable Dev Mode in settings if you cannot
 * see it). These two files look equally like JSON and fail very differently, so
 * the loader tells them apart explicitly and says which one you gave it. That
 * distinction is the single most common way this feature goes wrong.
 */
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CUSTOM_DIR = path.join(__dirname, "..", "workflows", "custom");

/**
 * The tokens Studio will fill in.
 *
 * Deliberately `%wrapped%` rather than bare words: a graph is full of prose in
 * prompts and filenames, and a bare `seed` or `width` would be substituted
 * inside someone's caption. The wrapper makes a placeholder unambiguous and
 * makes a typo'd one visible rather than silently literal.
 */
export const TOKENS = {
  "%prompt%":    "What to generate. Put this in your positive prompt node.",
  "%negative%":  "The negative prompt, if your graph has one.",
  "%seed%":      "Replaced with a number. Put it in your sampler's seed input.",
  "%width%":     "Output width in pixels.",
  "%height%":    "Output height in pixels.",
  "%length%":    "Frame count, for video graphs.",
  "%filename%":  "Output prefix. Studio finds your result by this, so a graph without it still works but Studio may pick up the wrong file.",
};

/** Which kinds a custom graph can stand in for. */
export const KINDS = ["cover", "video"];

/**
 * Is this an executable API-format graph, or the editor's save file?
 *
 * API format is a flat object of `id -> { class_type, inputs }`. The UI format
 * has a top-level `nodes` array with `widgets_values`. Detecting the wrong one
 * on purpose is worth more than a generic parse error, because "it's JSON and it
 * doesn't work" is where people give up.
 */
export function classify(json) {
  if (json && Array.isArray(json.nodes)) {
    return { ok: false, reason: "ui-format" };
  }
  if (!json || typeof json !== "object") return { ok: false, reason: "not-an-object" };
  const entries = Object.entries(json);
  if (!entries.length) return { ok: false, reason: "empty" };
  const looksApi = entries.every(([, v]) => v && typeof v === "object" && typeof v.class_type === "string");
  if (!looksApi) return { ok: false, reason: "not-api-format" };
  return { ok: true, nodes: entries.length };
}

const REASONS = {
  "ui-format": "This is ComfyUI's editor save, not the API format. In ComfyUI, "
    + "turn on Dev Mode in settings and use \"Save (API Format)\" instead.",
  "not-api-format": "Every entry in an API-format graph needs a class_type. This file does not look like one.",
  "not-an-object": "The file did not parse into a JSON object.",
  "empty": "The graph has no nodes.",
};

/** Which placeholders a graph actually uses. */
export function tokensUsed(raw) {
  return Object.keys(TOKENS).filter((t) => raw.includes(t));
}

/**
 * Read every custom graph, with whatever is wrong with it.
 *
 * Broken files are RETURNED rather than skipped. A graph that silently fails to
 * appear is indistinguishable from one Studio never saw, and the user has no way
 * to tell which — so each one comes back with its own verdict.
 */
export async function listCustom() {
  await mkdir(CUSTOM_DIR, { recursive: true });
  let names = [];
  try { names = (await readdir(CUSTOM_DIR)).filter((f) => f.toLowerCase().endsWith(".json")); }
  catch { return []; }

  const out = [];
  for (const name of names) {
    const full = path.join(CUSTOM_DIR, name);
    const rec = { name, id: name.replace(/\.json$/i, "") };
    try {
      const raw = await readFile(full, "utf8");
      rec.bytes = (await stat(full)).size;
      let json;
      try { json = JSON.parse(raw); }
      catch (e) { rec.ok = false; rec.problem = `Not valid JSON: ${e.message}`; out.push(rec); continue; }

      const verdict = classify(json);
      if (!verdict.ok) {
        rec.ok = false;
        rec.problem = REASONS[verdict.reason] || verdict.reason;
        out.push(rec);
        continue;
      }
      rec.ok = true;
      rec.nodes = verdict.nodes;
      rec.tokens = tokensUsed(raw);
      // Not fatal — a graph with a hardcoded prompt is a legitimate thing to
      // want, e.g. a fixed style. But it IS surprising, so it is reported.
      rec.warnings = [];
      if (!rec.tokens.includes("%prompt%")) {
        rec.warnings.push("No %prompt% — this graph will render the same thing every time.");
      }
      if (!rec.tokens.includes("%seed%")) {
        rec.warnings.push("No %seed% — every run gives an identical result, and re-rolling does nothing.");
      }
      if (!rec.tokens.includes("%filename%")) {
        rec.warnings.push("No %filename% — Studio has to guess which output file is yours.");
      }
    } catch (e) {
      rec.ok = false;
      rec.problem = e.message;
    }
    out.push(rec);
  }
  return out;
}

/**
 * Load one and fill in its blanks.
 *
 * Substitution happens on the RAW TEXT before parsing, not on the parsed object.
 * That is what lets `%seed%` sit inside a number field: after replacement the
 * text reads `"seed": 12345`, which parses as a number. Walking the object
 * instead would leave it the string "12345", and ComfyUI rejects a string where
 * a sampler wants an int — a confusing failure a long way from its cause.
 *
 * Numeric tokens are therefore injected WITHOUT quotes, and text tokens are
 * JSON-escaped so an apostrophe or a newline in a prompt cannot break the file.
 */
export async function buildCustom(id, vars = {}) {
  const safe = String(id).replace(/[^\w.-]/g, "");
  if (!safe || safe !== String(id)) throw new Error("Bad workflow name.");
  const full = path.join(CUSTOM_DIR, `${safe}.json`);
  let raw = await readFile(full, "utf8");

  const numeric = { "%seed%": vars.seed, "%width%": vars.width, "%height%": vars.height, "%length%": vars.length };
  for (const [tok, val] of Object.entries(numeric)) {
    if (!raw.includes(tok)) continue;
    const n = Number(val);
    // Quotes around the token are consumed too, so `"%seed%"` becomes a bare
    // number rather than a quoted one.
    raw = raw.split(`"${tok}"`).join(String(Number.isFinite(n) ? Math.round(n) : 0));
    raw = raw.split(tok).join(String(Number.isFinite(n) ? Math.round(n) : 0));
  }

  const text = {
    "%prompt%": vars.prompt ?? "",
    "%negative%": vars.negative ?? "",
    "%filename%": vars.filename ?? "aiplay_custom",
  };
  for (const [tok, val] of Object.entries(text)) {
    if (!raw.includes(tok)) continue;
    // JSON.stringify gives us the escaping; slice off its outer quotes because
    // the token already sits inside quotes in the file.
    raw = raw.split(tok).join(JSON.stringify(String(val)).slice(1, -1));
  }

  let graph;
  try { graph = JSON.parse(raw); }
  catch (e) {
    throw new Error(
      `Filling in the placeholders produced invalid JSON (${e.message}). ` +
      `Usually this means a token sits somewhere it cannot, like a bare %seed% ` +
      `inside a sentence.`);
  }
  const verdict = classify(graph);
  if (!verdict.ok) throw new Error(REASONS[verdict.reason] || "Not an API-format graph.");
  return graph;
}

/** Which custom graph, if any, is standing in for a built-in kind. */
export function assignedTo(kind) {
  return config.customWorkflows?.[kind] || null;
}
