/**
 * WHAT A PICTURE WAS MADE FROM, WITHOUT THE WORDS.
 *
 * The minors rule reads words, and a picture handed to a render is not words:
 * a reference, an opening frame, the image being edited, the clip being
 * continued or restyled. What this app CAN say about such a picture is what it
 * was made from. Two things carry that:
 *
 *   · its stored prompt, when it has one (a private render keeps none, an
 *     upload never had one), read as context;
 *   · its FINGERPRINT, `safety: { minor, sexual }`, two booleans stamped on
 *     every picture and clip this app makes (private ones too), computed from
 *     the words it was rendered with and everything IT was made from, and
 *     copied forward onto everything derived from it: an edit, an upscale, a
 *     cutout, a mask, a contact sheet, a composite, a document, a vector, a
 *     compositor still, an extension, a restyle.
 *
 * A request is judged with the prompts and the fingerprints of EVERY ancestor
 * of every picture it uses, however many steps back (no depth limit, a visited
 * set against loops). So "make her nude" is refused on the fifth "brighter"
 * edit of a picture made as a child, on a contact sheet that holds one, and on
 * a private render that kept no prompt.
 *
 * Pure: no fs. The callers own the maps; `lookup(name)` returns the metadata
 * rows for a library file name (a picture's, a clip's, or both).
 */
import path from "node:path";
import { fingerprintOf, mergeFingerprints } from "./minors.js";

/** The metadata keys that name what a file was made from. A key that holds a
 *  label rather than a file name ("source": "import") names nothing the maps
 *  know, and is harmless. */
export const PARENT_KEYS = [
  "derivedFrom", "generatedFrom", "from", "extendedFrom", "editedFrom", "maskOf", "compositeOf",
  "compositeSources", "sheetOf", "documentOf", "vectorFrom", "firstFrame", "lastFrame", "endFrame",
  "fromCover", "toCover", "refImages", "sourceVideo", "layerSources", "source",
];

const MAX_NODES = 5000;

/** Library file names in whatever shape a field holds them. */
export function namesIn(value) {
  const out = [];
  const visit = (v, d) => {
    if (d > 6 || v === null || v === undefined) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, d + 1); return; }
    if (typeof v === "object") { visit(v.name ?? v.file ?? v.src ?? v.image ?? null, d + 1); return; }
    if (typeof v === "string" && v.trim()) out.push(path.basename(v.trim()));
  };
  visit(value, 0);
  return out;
}

/** The files one metadata row says it was made from. */
export function parentsOf(meta) {
  if (!meta || typeof meta !== "object") return [];
  return PARENT_KEYS.flatMap((k) => namesIn(meta[k]));
}

/** One row's fingerprint: the one it carries, else what its words say. */
export function fingerprintOfRow(meta) {
  if (!meta || typeof meta !== "object") return null;
  const own = typeof meta.prompt === "string" && meta.prompt.trim() ? fingerprintOf(meta.prompt) : null;
  return mergeFingerprints(meta.safety, own);
}

/**
 * A metadata row with its fingerprint filled in: what it carries, what its own
 * words say, and what each file it names as a parent carries. Monotonic: a
 * half, once set, is never cleared by a later write.
 */
export function withFingerprint(meta, lookup) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  const parents = parentsOf(meta).flatMap((n) => [].concat(lookup(n) || []));
  return { ...meta, safety: mergeFingerprints(fingerprintOfRow(meta), ...parents.map(fingerprintOfRow)) };
}

/**
 * Everything a request's pictures stand on, across every ancestor.
 * @param {*} values  file names, or {name|file|src} objects, or arrays of them
 * @param {(name: string) => object|object[]|null} lookup
 * @returns {{ texts: string[], flags: {minor:boolean, sexual:boolean}[] }}
 */
export function lineageOf(values, lookup) {
  const texts = [];
  const flags = [];
  const seen = new Set();
  const stack = namesIn(values);
  while (stack.length && seen.size < MAX_NODES) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of [].concat(lookup(n) || [])) {
      if (!m || typeof m !== "object") continue;
      if (typeof m.prompt === "string" && m.prompt.trim()) texts.push(m.prompt);
      if (m.safety && typeof m.safety === "object") flags.push({ minor: m.safety.minor === true, sexual: m.safety.sexual === true });
      stack.push(...parentsOf(m));
    }
  }
  return { texts, flags };
}

/**
 * The fingerprint of an MV project row's picture (a character, background or
 * prop sheet, or a board still or keyframe): the row's own words as they are
 * now, joined with the fingerprint of the take that IS that picture, which
 * says what it was drawn as whatever the words have been edited to since.
 * For a picture that travels without its words (a friend's order).
 */
export function projectRowFingerprint(row, file = row?.imageFile) {
  if (!row || typeof row !== "object") return { minor: false, sexual: false };
  const words = ["description", "sheetPrompt", "platePrompt", "boardPrompt"]
    .map((k) => row[k]).filter((s) => typeof s === "string" && s.trim());
  const take = (Array.isArray(row.takes) ? row.takes : []).find((t) => t && file && (t.file === file || t.clip === file));
  return mergeFingerprints(words.length ? fingerprintOf(words) : null, take?.safety);
}

/**
 * A Map of metadata rows that fingerprints every row it is handed. Every write
 * (`set`) runs withFingerprint against `lookup`, so each derivation copies its
 * parents' fingerprints forward without the dozens of places that write a row
 * each having to remember to. `load` is the plain write, for rows read back
 * from disk exactly as they were saved.
 */
export class LineageMap extends Map {
  constructor(lookup) {
    super();
    this.lookup = typeof lookup === "function" ? lookup : () => null;
  }
  set(key, value) {
    return super.set(key, withFingerprint(value, (n) => (n === key ? null : this.lookup(n))));
  }
  load(key, value) {
    return super.set(key, value);
  }
}
