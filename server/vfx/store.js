/**
 * VFX — the composition store.
 *
 * One JSON document per composition, plus a disposable preview folder:
 *   <outputDir>/vfx/<slug>/comp.json
 *   <outputDir>/vfx/<slug>/preview/
 *
 * SINGLE WRITER, the same discipline as server/mv/store.js and for the same
 * reason: the HTTP routes, the MCP tools and a render that finishes at some
 * arbitrary moment all write here, and a comp is an hour of somebody's
 * keyframing. Every mutation goes through one promise chain per slug and lands
 * via write-temp-then-rename, so a crash mid-write cannot truncate the document.
 *
 * The shape is docs/VFX_SPEC.md §1 and nothing here may drift from it — the
 * python engine parses this same JSON, so a field invented in this file is a
 * field the renderer will silently ignore.
 *
 * WHY THERE IS AN EVALUATOR IN HERE. interp.py owns the pixels; this is a
 * mirror of just enough of it to answer "what is this property worth right
 * now" — which is what turning on a stopwatch needs, because a keyframe seeded
 * from the wrong value moves the layer the instant you animate it. §1 pins the
 * semantics (CSS cubic-bezier, hold, clamp outside the range) so both sides can
 * implement it without consulting each other. Nothing here ever paints.
 */
import { readFile, writeFile, rename, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export const VFX_DIR = () => path.join(config.outputDir, "vfx");
export const compDir = (slug) => path.join(VFX_DIR(), slug);
export const previewDir = (slug) => path.join(compDir(slug), "preview");
const docPath = (slug) => path.join(compDir(slug), "comp.json");

/** Document version. Bump only with a migration in `migrate()`. */
export const DOC_VERSION = 1;

/* ──────────────────────────────────────────────── the vocabulary, §1 and §6 */

export const LAYER_TYPES = ["image", "video", "solid", "text", "adjustment", "null"];

/** §2. The first ten already exist in imagetools.py::_blend; the engine extends it. */
export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "softlight", "hardlight", "add",
  "subtract", "difference", "darken", "lighten", "colordodge", "colorburn",
  "hue", "saturation", "color", "luminosity",
];

export const EASES = ["linear", "hold", "easeIn", "easeOut", "easeInOut"];
export const MATTE_TYPES = ["alpha", "luma", "alphaInv", "lumaInv"];
export const MASK_MODES = ["add", "subtract", "none"];

/**
 * §6's hard limits, in one place so the routes and the MCP descriptions can
 * quote the same numbers instead of two people remembering them differently.
 *
 * `masksPerLayer` is NOT in the spec — it is added for the same reason the
 * other caps exist. A mask is a polygon the engine rasterises per frame; an
 * agent in a loop could otherwise post ten thousand of them and turn one
 * preview into a hang. 24 matches the effects cap.
 */
export const LIMITS = {
  minSize: 16, maxSize: 4096,
  minFps: 1, maxFps: 120,
  minDuration: 0.1, maxDuration: 600,
  layers: 64, effectsPerLayer: 24, masksPerLayer: 24,
};

/** Arity of every transform property — what a keyframe's `v` has to match. */
export const TRANSFORM_ARITY = { anchor: 2, position: 2, scale: 2, rotation: 1, opacity: 1 };

/** Animatable mask properties, §1. */
export const MASK_PROPS = ["feather", "opacity", "expand"];

/* ─────────────────────────────────────────────────────────── identity */

/**
 * A slug is the on-disk identity, so it has to survive a file system and a URL
 * and stay recognisable to a human scanning a folder. Same shape mv and the
 * Studio project saver already use.
 */
export function slugify(title) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "untitled";
}

/**
 * Prefixed random ids, §1: `cmp_`, `ly_`, `fx_`, `mk_`.
 *
 * The spec's examples show `fx_1` and `mk_1`, but sequential ids are a trap
 * here: delete effect 2 and add another and the new one reuses a name that a
 * keyframe path, an undo buffer or an open MCP transcript may still be holding.
 * Random ids cost nothing and can never collide with something you removed.
 */
export const newId = (prefix, n = 4) =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, n)}`;

/* ──────────────────────────────────────────────────────── blank documents */

export function blankComp(name, opts = {}) {
  const now = Date.now();
  const title = String(name || "Untitled").slice(0, 80);
  return {
    v: DOC_VERSION,
    id: newId("cmp", 6),
    slug: slugify(title),
    name: title,
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    fps: opts.fps ?? 30,
    duration: opts.duration ?? 8.0,
    bg: opts.bg ?? [0, 0, 0, 0],          // alpha 0 = a transparent comp
    motionBlur: { enabled: false, shutter: 180, samples: 8 },
    layers: [],                            // layers[0] is the TOP of the stack
    markers: [],
    createdAt: now,
    updatedAt: now,
    runs: [],
  };
}

/**
 * A blank layer, centred in the comp.
 *
 * Anchor defaults to the COMP centre rather than the source centre because at
 * this point nobody has read the file yet. The routes probe the source when the
 * engine is available and correct the anchor to the picture's own middle — the
 * difference is whether "rotate" spins the layer or swings it, so it matters,
 * and the fallback is at least predictable rather than random.
 */
export function blankLayer(comp, type, patch = {}) {
  const cx = comp.width / 2, cy = comp.height / 2;
  const layer = {
    id: newId("ly"),
    name: patch.name || type,
    type,
    src: null,
    start: 0,
    end: comp.duration,
    inPoint: 0,
    timeScale: 1,
    blend: "normal",
    parent: null,
    motionBlur: false,
    enabled: true,
    solo: false,
    locked: false,
    transform: {
      anchor: [cx, cy],
      position: [cx, cy],
      scale: [100, 100],
      rotation: 0,
      opacity: 100,
    },
    effects: [],
    masks: [],
    trackMatte: null,
  };
  if (type === "solid") layer.color = [255, 255, 255, 255];
  if (type === "text") {
    layer.text = {
      content: "TEXT", font: "arial.ttf", size: 96,
      color: [240, 240, 245, 255], align: "center",
      stroke: 0, strokeColor: [0, 0, 0, 255], lineHeight: 1.15, tracking: 0,
    };
  }
  return { ...layer, ...patch, id: layer.id };
}

export function blankEffect(type, params = {}) {
  return { id: newId("fx"), type: String(type), enabled: true, params: { ...params } };
}

export function blankMask(points, patch = {}) {
  const { id, ...rest } = patch;
  return {
    id: newId("mk"), mode: "add", points,
    feather: 0, opacity: 100, invert: false, expand: 0,
    ...rest,
  };
}

/* ────────────────────────────────────────────── the single-writer queue */

/** One promise chain per slug. Serialises read-modify-write against itself. */
const chains = new Map();

function enqueue(slug, fn) {
  const prev = chains.get(slug) ?? Promise.resolve();
  // The chain must not break on a rejection, or every later write for this comp
  // is silently dropped. Callers still see their own error.
  const next = prev.then(fn, fn);
  chains.set(slug, next.then(() => {}, () => {}));
  return next;
}

async function writeDoc(slug, doc) {
  await mkdir(compDir(slug), { recursive: true });
  const tmp = docPath(slug) + `.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await rename(tmp, docPath(slug));
  return doc;
}

/* ────────────────────────────────────────────────────────────── migrate */

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const rgba = (v, fallback) =>
  Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(Number(n)))
    ? v.map(Number) : fallback.slice();
const pair = (v, fallback) =>
  Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(Number(n)))
    ? v.map(Number) : (isKeyed(v) ? v : fallback.slice());

/**
 * Forward-compatible reads: an older or hand-edited document is repaired in
 * memory on load, never on disk until something else writes.
 *
 * Repair rather than reject, on purpose. A comp with one malformed layer should
 * open with that layer sane, not refuse to open at all — the alternative is a
 * human staring at a 404 with an hour of work on the other side of it. What
 * cannot be repaired (a missing id) is minted; what is nonsense (a scale of
 * "big") falls back to the default.
 */
export function migrate(doc) {
  if (!doc || typeof doc !== "object") return null;

  doc.v = DOC_VERSION;
  doc.id ||= newId("cmp", 6);
  doc.name = String(doc.name ?? doc.title ?? "Untitled").slice(0, 80);
  doc.slug ||= slugify(doc.name);
  doc.width = clampInt(num(doc.width, 1920), LIMITS.minSize, LIMITS.maxSize);
  doc.height = clampInt(num(doc.height, 1080), LIMITS.minSize, LIMITS.maxSize);
  doc.fps = clamp(num(doc.fps, 30), LIMITS.minFps, LIMITS.maxFps);
  doc.duration = clamp(num(doc.duration, 8), LIMITS.minDuration, LIMITS.maxDuration);
  doc.bg = rgba(doc.bg, [0, 0, 0, 0]);
  if (!doc.motionBlur || typeof doc.motionBlur !== "object") {
    doc.motionBlur = { enabled: false, shutter: 180, samples: 8 };
  } else {
    doc.motionBlur.enabled = !!doc.motionBlur.enabled;
    doc.motionBlur.shutter = clamp(num(doc.motionBlur.shutter, 180), 1, 720);
    doc.motionBlur.samples = clampInt(num(doc.motionBlur.samples, 8), 2, 64);
  }
  if (!Array.isArray(doc.markers)) doc.markers = [];
  doc.markers = doc.markers
    .filter((m) => m && Number.isFinite(Number(m.t)))
    .map((m) => ({ t: Number(m.t), label: String(m.label ?? "") }));
  if (!Array.isArray(doc.runs)) doc.runs = [];
  if (!Array.isArray(doc.layers)) doc.layers = [];
  doc.layers = doc.layers.filter(Boolean).map((l) => migrateLayer(l, doc));
  doc.createdAt = num(doc.createdAt, Date.now());
  doc.updatedAt = num(doc.updatedAt, doc.createdAt);
  return doc;
}

function migrateLayer(l, doc) {
  l.id ||= newId("ly");
  l.type = LAYER_TYPES.includes(l.type) ? l.type : "solid";
  l.name = String(l.name ?? l.type).slice(0, 80);
  l.src = l.src == null ? null : path.basename(String(l.src));
  l.start = num(l.start, 0);
  l.end = num(l.end, doc.duration);
  l.inPoint = num(l.inPoint, 0);
  l.timeScale = num(l.timeScale, 1) || 1;
  l.blend = BLEND_MODES.includes(l.blend) ? l.blend : "normal";
  l.parent = l.parent ? String(l.parent) : null;
  l.motionBlur = !!l.motionBlur;
  l.enabled = l.enabled !== false;
  l.solo = !!l.solo;
  l.locked = !!l.locked;

  const t = (l.transform && typeof l.transform === "object") ? l.transform : {};
  const cx = doc.width / 2, cy = doc.height / 2;
  l.transform = {
    anchor: pair(t.anchor, [cx, cy]),
    position: pair(t.position, [cx, cy]),
    scale: pair(t.scale, [100, 100]),
    rotation: isKeyed(t.rotation) ? t.rotation : num(t.rotation, 0),
    opacity: isKeyed(t.opacity) ? t.opacity : num(t.opacity, 100),
  };

  if (!Array.isArray(l.effects)) l.effects = [];
  l.effects = l.effects.filter((f) => f && f.type).map((f) => ({
    id: f.id || newId("fx"),
    type: String(f.type),
    enabled: f.enabled !== false,
    params: (f.params && typeof f.params === "object") ? f.params : {},
  }));

  if (!Array.isArray(l.masks)) l.masks = [];
  l.masks = l.masks.filter((m) => m && Array.isArray(m.points)).map((m) => ({
    id: m.id || newId("mk"),
    mode: MASK_MODES.includes(m.mode) ? m.mode : "add",
    points: m.points.filter((p) => Array.isArray(p) && p.length === 2).map((p) => [Number(p[0]), Number(p[1])]),
    feather: isKeyed(m.feather) ? m.feather : num(m.feather, 0),
    opacity: isKeyed(m.opacity) ? m.opacity : num(m.opacity, 100),
    invert: !!m.invert,
    expand: isKeyed(m.expand) ? m.expand : num(m.expand, 0),
  }));

  if (l.trackMatte && MATTE_TYPES.includes(l.trackMatte.type)) {
    l.trackMatte = { type: l.trackMatte.type };
  } else {
    l.trackMatte = null;
  }
  return l;
}

export const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi);
export const clampInt = (v, lo, hi) => Math.round(clamp(v, lo, hi));

/* ─────────────────────────────────────────────────────────────── CRUD */

export async function readComp(slug) {
  try {
    return migrate(JSON.parse(await readFile(docPath(slug), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Read, mutate, write — atomically with respect to every other writer.
 *
 * `fn` receives the live document and may mutate it in place or return a
 * replacement. Returning `false` abandons the write, which is how a caller
 * refuses a no-op without having to throw.
 */
export async function updateComp(slug, fn) {
  return enqueue(slug, async () => {
    const doc = await readComp(slug);
    if (!doc) throw new Error(`No such comp: ${slug}`);
    const out = await fn(doc);
    if (out === false) return doc;
    const next = out && typeof out === "object" ? out : doc;
    next.updatedAt = Date.now();
    return writeDoc(slug, next);
  });
}

export async function createComp(name, opts = {}) {
  const doc = blankComp(name, opts);
  // Two comps called "Titles" must not become one folder. The suffix is only
  // added on a real collision so the common case stays readable.
  let slug = doc.slug, n = 2;
  while (await readComp(slug)) slug = `${doc.slug}-${n++}`;
  doc.slug = slug;
  return enqueue(slug, () => writeDoc(slug, doc));
}

export async function deleteComp(slug) {
  return enqueue(slug, async () => {
    await rm(compDir(slug), { recursive: true, force: true });
    return true;
  });
}

/**
 * Every comp, newest first — the summary §6 asks for.
 *
 * `layers` is the COUNT, not the array: a list of thirty comps that each inline
 * sixty keyframed layers is megabytes of JSON to paint one dropdown.
 */
export async function listComps() {
  let names = [];
  try {
    names = (await readdir(VFX_DIR(), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];                                   // no vfx folder yet is not an error
  }
  const rows = await Promise.all(names.map(async (slug) => {
    const doc = await readComp(slug);
    if (!doc) return null;
    return {
      slug: doc.slug, id: doc.id, name: doc.name,
      width: doc.width, height: doc.height, fps: doc.fps, duration: doc.duration,
      layers: doc.layers.length,
      createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    };
  }));
  return rows.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Append a run record. Bounded — this is a breadcrumb trail, not an audit log. */
export function noteRun(doc, entry) {
  if (!Array.isArray(doc.runs)) doc.runs = [];
  doc.runs.unshift({ at: Date.now(), ...entry });
  doc.runs = doc.runs.slice(0, 200);
  return doc;
}

/* ────────────────────────────────────────────── layers, found by id or name */

export function findLayer(doc, ref) {
  const id = String(ref ?? "");
  const byId = doc.layers.find((l) => l.id === id);
  if (byId) return byId;
  // Names are what a person and an agent actually have in hand. Accept one only
  // when it is unambiguous — silently picking the first "text" of four is worse
  // than making the caller say which.
  const byName = doc.layers.filter((l) => l.name === id);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`${byName.length} layers are called "${id}" — use the id: ${byName.map((l) => l.id).join(", ")}`);
  }
  throw new Error(`No such layer: ${id}. This comp has ${doc.layers.map((l) => `${l.id} (${l.name})`).join(", ") || "no layers"}.`);
}

/**
 * Parenting is a tree and a tree has no cycles. Walking it here rather than
 * trusting the engine to notice means the bad edit is refused at the door
 * instead of hanging a render in a recursion no one can see.
 */
export function wouldCycle(doc, layerId, parentId) {
  let cur = parentId;
  const seen = new Set([layerId]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = doc.layers.find((l) => l.id === cur)?.parent ?? null;
  }
  return false;
}

/* ────────────────────────────────────── animatable properties, §1 */

export const isKeyed = (v) =>
  !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.keys);

export const arityOf = (v) => (Array.isArray(v) ? v.length : 1);

/**
 * Point a property path at the thing it names.
 *
 * Paths a caller may use:
 *   transform.position | transform.anchor | transform.scale
 *   transform.rotation | transform.opacity        (or just "opacity")
 *   effects.<fxId|type>.<param>
 *   masks.<maskId>.<feather|opacity|expand>
 *
 * Returns the OWNER object and the key inside it, so the caller can read and
 * write without re-parsing. `arity` is null when only the catalog knows it.
 */
export function resolvePropPath(layer, rawPath) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) throw new Error(`Give a property path, for example "transform.position".`);
  const parts = raw.split(".");

  // The one alias worth keeping: §1 lists `opacity` as animatable and every
  // human calls it that, but it lives inside transform.
  if (parts.length === 1 && parts[0] === "opacity") parts.unshift("transform");

  if (parts[0] === "transform" && parts.length === 2) {
    const key = parts[1];
    if (!(key in TRANSFORM_ARITY)) {
      throw new Error(`No transform property "${key}". It is one of: ${Object.keys(TRANSFORM_ARITY).join(", ")}.`);
    }
    return { owner: layer.transform, key, path: `transform.${key}`, arity: TRANSFORM_ARITY[key], kind: "transform" };
  }

  /* Both spellings of an effect param resolve: "effects.fx_1.radius" and
   * "effects.fx_1.params.radius". The document nests params, so the longer one
   * is what a person reads off the JSON — and the two builders of this feature
   * each picked a different one without conferring, which is exactly the kind
   * of split that turns into a silent 400 in front of a user. Accept both,
   * answer with one. */
  if (parts[0] === "effects" && parts.length === 4 && parts[2] === "params") {
    parts.splice(2, 1);
  }

  if (parts[0] === "effects" && parts.length === 3) {
    const [, ref, param] = parts;
    const fx = pickEffect(layer, ref);
    // An unset param is legal — the engine falls back to the catalog default —
    // so a path naming one is answered, not refused. Its arity is simply not
    // knowable from the document; the routes ask the catalog instead.
    return {
      owner: fx.params, key: param, path: `effects.${fx.id}.${param}`,
      arity: fx.params[param] === undefined ? null : arityOf(constOf(fx.params[param])),
      kind: "effect", effect: fx,
    };
  }

  if (parts[0] === "masks" && parts.length === 3) {
    const [, ref, param] = parts;
    const mk = (layer.masks || []).find((m) => m.id === ref);
    if (!mk) throw new Error(`No such mask on ${layer.id}: ${ref}. It has ${(layer.masks || []).map((m) => m.id).join(", ") || "no masks"}.`);
    if (!MASK_PROPS.includes(param)) {
      throw new Error(`Mask property "${param}" is not animatable. Animatable ones: ${MASK_PROPS.join(", ")}.`);
    }
    return { owner: mk, key: param, path: `masks.${mk.id}.${param}`, arity: 1, kind: "mask" };
  }

  throw new Error(
    `Unrecognised property path "${raw}". Use transform.position, transform.anchor, `
    + `transform.scale, transform.rotation, transform.opacity, `
    + `effects.<fxId>.<param>, or masks.<maskId>.<feather|opacity|expand>.`,
  );
}

/** An effect by id, or unambiguously by type. */
export function pickEffect(layer, ref) {
  const id = String(ref ?? "");
  const list = layer.effects || [];
  const byId = list.find((f) => f.id === id);
  if (byId) return byId;
  const byType = list.filter((f) => f.type === id);
  if (byType.length === 1) return byType[0];
  if (byType.length > 1) {
    throw new Error(`${byType.length} effects on ${layer.id} are "${id}" — use the id: ${byType.map((f) => f.id).join(", ")}.`);
  }
  throw new Error(`No such effect on ${layer.id}: ${id}. It has ${list.map((f) => `${f.id} (${f.type})`).join(", ") || "no effects"}.`);
}

/** The first concrete value inside a property, keyed or not — for arity checks. */
function constOf(prop) {
  return isKeyed(prop) ? (prop.keys[0]?.v ?? 0) : prop;
}

/* ─────────────────────────────────────────────── the evaluator (a mirror) */

/** CSS cubic-bezier control points for the named eases, §1. */
const EASE_CURVES = {
  linear: null,
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** CSS cubic-bezier: solve x(u)=p for u by Newton, bisect when it misbehaves. */
function bezierEase(p, [x1, y1, x2, y2]) {
  const bx = (u) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = (u) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  const dx = (u) => 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
  let u = p;
  for (let i = 0; i < 8; i++) {
    const err = bx(u) - p;
    if (Math.abs(err) < 1e-6) return by(u);
    const d = dx(u);
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  let lo = 0, hi = 1; u = p;
  for (let i = 0; i < 30; i++) {
    const err = bx(u) - p;
    if (Math.abs(err) < 1e-6) break;
    if (err > 0) hi = u; else lo = u;
    u = (lo + hi) / 2;
  }
  return by(u);
}

/** The eased 0..1 fraction across the segment LEAVING a key, §1. */
export function easeFraction(ease, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (ease === "hold") return 0;
  if (!ease || ease === "linear") return u;
  if (typeof ease === "object" && Array.isArray(ease.bezier) && ease.bezier.length === 4) {
    return bezierEase(u, ease.bezier.map(Number));
  }
  const curve = EASE_CURVES[ease];
  return curve ? bezierEase(u, curve) : u;
}

/**
 * `evalProp(prop, t)` — §1. A constant returns itself.
 *
 * Sorts defensively: §1 says keys arrive sorted and the evaluator must tolerate
 * them not being.
 */
export function evalProp(prop, t) {
  if (!isKeyed(prop)) return prop;
  const keys = prop.keys.filter((k) => k && Number.isFinite(Number(k.t)))
    .slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return 0;
  if (keys.length === 1) return keys[0].v;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b.t - a.t;
  const f = easeFraction(a.ease, span > 0 ? (t - a.t) / span : 1);
  const lerp = (x, y) => x + (y - x) * f;
  if (Array.isArray(a.v) && Array.isArray(b.v)) {
    return a.v.map((x, k) => lerp(Number(x), Number(b.v[k] ?? x)));
  }
  return lerp(Number(a.v), Number(b.v));
}

/**
 * Normalise a keys array: sorted, numeric `t`, consistent arity, legal ease.
 *
 * Throws on anything it cannot repair. Every keyframe write in the routes goes
 * through here, which is why an agent can never leave a property in a state the
 * python evaluator would have to guess about.
 */
export function normalizeKeys(keys, { arity = null, label = "property" } = {}) {
  if (!Array.isArray(keys) || !keys.length) {
    throw new Error(`${label}: "keys" must be a non-empty array of { t, v, ease? }.`);
  }
  let want = arity;
  const out = keys.map((k, i) => {
    if (!k || typeof k !== "object") throw new Error(`${label}: key ${i} is not an object.`);
    const t = Number(k.t);
    if (!Number.isFinite(t)) throw new Error(`${label}: key ${i} has no numeric "t" (seconds on the comp timeline).`);
    const v = normalizeValue(k.v, { label: `${label} key ${i}` });
    const n = arityOf(v);
    if (want == null) want = n;
    if (n !== want) {
      throw new Error(`${label}: key ${i} has ${n} number(s) but the property takes ${want}. Every key must match.`);
    }
    return { t, v, ...(k.ease === undefined || k.ease === null ? {} : { ease: normalizeEase(k.ease, label) }) };
  });
  out.sort((a, b) => a.t - b.t);
  // Two keys at the same instant is not an animation, it is a coin toss about
  // which one the interpolator picks. Say so instead of writing it.
  for (let i = 1; i < out.length; i++) {
    if (Math.abs(out[i].t - out[i - 1].t) < 1e-6) {
      throw new Error(`${label}: two keys at t=${out[i].t}. Move one, or remove it first.`);
    }
  }
  return out;
}

export function normalizeEase(ease, label = "property") {
  if (typeof ease === "string") {
    if (!EASES.includes(ease)) {
      throw new Error(`${label}: ease "${ease}" is not one of ${EASES.join(", ")} (or { "bezier": [x1,y1,x2,y2] }).`);
    }
    return ease;
  }
  if (ease && typeof ease === "object" && Array.isArray(ease.bezier)) {
    const b = ease.bezier.map(Number);
    if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) {
      throw new Error(`${label}: { bezier } takes exactly four numbers [x1,y1,x2,y2].`);
    }
    // CSS pins x into 0..1 (time cannot run backwards); y is free, which is
    // what makes overshoot possible.
    if (b[0] < 0 || b[0] > 1 || b[2] < 0 || b[2] > 1) {
      throw new Error(`${label}: bezier x1 and x2 must be between 0 and 1 (CSS cubic-bezier).`);
    }
    return { bezier: b };
  }
  throw new Error(`${label}: ease must be one of ${EASES.join(", ")}, or { "bezier": [x1,y1,x2,y2] }.`);
}

/** A number, or an array of numbers. Anything else is a typo worth naming. */
export function normalizeValue(v, { label = "value" } = {}) {
  if (Array.isArray(v)) {
    if (!v.length) throw new Error(`${label}: an empty array is not a value.`);
    const out = v.map(Number);
    if (out.some((n) => !Number.isFinite(n))) throw new Error(`${label}: every element must be a number.`);
    return out;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}: must be a number or an array of numbers, got ${JSON.stringify(v)}.`);
  return n;
}
