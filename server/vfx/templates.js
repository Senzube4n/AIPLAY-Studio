/**
 * VFX — the template library.
 *
 * Every comp starts empty, and an empty comp is a blank sheet in front of
 * someone who wanted a lower third. These are the ten openings a music/video
 * studio actually reaches for, each one a function from a handful of parameters
 * to a COMPLETE comp document (docs/VFX_SPEC.md §1) — layers, keyframes,
 * effects, the lot — already animated and already renderable.
 *
 * PURE. A template returns a document and touches nothing: no disk, no engine,
 * no library lookups. The route persists it, and that separation is what lets
 * this file be tested with `node server/vfx/templates_test.js` and reused by
 * anything that can build a comp.
 *
 * SOURCES ARE LIBRARY NAMES (§6). A template never sees a path and never
 * invents one. Where a source is not given the layer DEGRADES TO A SOLID of a
 * sensible colour — an endCard with no logo is still an endCard, and a comp
 * that renders something is worth more than a comp that refuses to.
 *
 * WHAT `ctx.probe` IS FOR. Scale is a percentage of the source's OWN pixels, so
 * "fill the frame" is not something a template can compute from the comp alone.
 * The route probes each named source once and passes { name: {width,height} }
 * in; without it a source keeps 100% and may not fill, which is a worse picture
 * but never an error.
 *
 * REAL KEYFRAMES ONLY. Every move here is §1's { keys: [{t,v,ease}] } with an
 * ease chosen for what it has to feel like: easeOut for something arriving,
 * easeIn for something leaving, hold for a glitch (a stutter is a series of
 * steps, and interpolating one turns it into a smear), and a bezier with y past
 * 1 where a logo has to overshoot and settle.
 *
 * EFFECT NAMES AND RANGES ARE NOT GUESSED. Every effect and parameter below is
 * from server/vfx/effects.py's CATALOG, inside its documented range;
 * templates_test.js asserts that against the live catalog so a rename over
 * there fails here loudly instead of rendering a layer with no effect on it.
 */
import {
  blankComp, blankLayer, blankEffect, newId, slugify,
  LIMITS, TRANSFORM_ARITY, MASK_PROPS, isKeyed, normalizeKeys,
} from "./store.js";

/* ───────────────────────────────────────────────────────── small helpers */

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi);

/** One keyframe. `ease` describes the segment LEAVING this key, §1. */
const K = (t, v, ease) => (ease === undefined ? { t: r3(t), v } : { t: r3(t), v, ease });

/** An animated property. */
const anim = (...keys) => ({ keys });

/**
 * The four instants every entrance/exit is built from, with every clamp in ONE
 * place: a template that hard-codes "out at duration - 0.75" is a template that
 * plays backwards when someone asks for a 1.6-second lower third.
 */
function timings(D, { inAt = 0.25, inDur = 0.45, outDur = 0.45, tail = 0.25 } = {}) {
  inDur = Math.min(inDur, D * 0.35);
  outDur = Math.min(outDur, D * 0.35);
  const t0 = clamp(inAt, 0, Math.max(0, D - inDur - outDur - tail - 0.05));
  const t1 = t0 + inDur;
  const t3 = Math.max(t1 + 0.06, D - tail);
  const t2 = Math.max(t1 + 0.03, t3 - outDur);
  return { t0: r3(t0), t1: r3(t1), t2: r3(t2), t3: r3(t3) };
}

/** Fade up, hold, fade down — the opacity track almost everything wants. */
const fadeTrack = ({ t0, t1, t2, t3 }, hi = 100) =>
  anim(K(t0, 0, "easeOut"), K(t1, hi), K(t2, hi, "easeIn"), K(t3, 0));

/**
 * A "back out" bezier: overshoots past the target and settles. §1 allows y
 * outside 0..1 (only x is pinned), which is the whole reason a single segment
 * can carry an overshoot instead of three keys pretending to be one.
 */
const OVERSHOOT = { bezier: [0.34, 1.56, 0.64, 1] };
/** Fast off the mark, long settle — an arrival that does not look linear. */
const SETTLE = { bezier: [0.16, 1, 0.3, 1] };

/** Percent scale that makes a source COVER a box — the "fill the frame" number. */
function coverScale(probe, boxW, boxH) {
  if (!probe || !(probe.width > 0) || !(probe.height > 0)) return 100;
  return r3(Math.max(boxW / probe.width, boxH / probe.height) * 100);
}

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
/** Which library a source name lives in — the same test the routes use. */
export const sourceKind = (name) => (IMAGE_EXT.test(String(name || "")) ? "image" : "clip");

/* ───────────────────────────────────────────────────── layer constructors */

function solidLayer(doc, name, color, w, h, patch = {}) {
  const l = blankLayer(doc, "solid", { name });
  l.color = color.slice();
  // The engine reads width/height off a solid (engine.py::_layer_native_size)
  // and falls back to the comp size — a 6px divider is a 6px layer, not a
  // full-frame one wearing a mask, so its anchor and its wipe mean what they say.
  l.width = Math.max(1, Math.round(w));
  l.height = Math.max(1, Math.round(h));
  l.transform.anchor = [l.width / 2, l.height / 2];
  return Object.assign(l, patch);
}

/**
 * A text layer. Its bitmap is comp-sized and the type is drawn in the middle of
 * it, so `position` is where the text's own centre lands — and with align
 * "left" it is where the line BEGINS. That is engine.py::_rasterize_text's
 * contract and it is the only reason these layouts can be written as numbers.
 */
function textLayer(doc, name, content, spec = {}, patch = {}) {
  const l = blankLayer(doc, "text", { name });
  l.text = {
    content: String(content ?? ""),
    font: spec.font || "arial.ttf",
    size: Math.max(1, Math.round(spec.size ?? 64)),
    color: (spec.color || [240, 240, 245, 255]).slice(),
    align: spec.align || "center",
    stroke: spec.stroke ?? 0,
    strokeColor: (spec.strokeColor || [0, 0, 0, 255]).slice(),
    lineHeight: spec.lineHeight ?? 1.15,
    tracking: spec.tracking ?? 0,
  };
  return Object.assign(l, patch);
}

/**
 * A picture layer from a LIBRARY NAME, or a solid when there is none.
 *
 * The degrade is the point: a template asked for footage it was not given
 * still hands back something that renders, so the caller sees the shape of the
 * thing and swaps the source in with one set_layer.
 */
function sourceLayer(doc, name, label, ctx, { box = null, fallback = [26, 26, 32, 255] } = {}) {
  const W = box ? box[0] : doc.width, H = box ? box[1] : doc.height;
  if (!name) {
    const l = solidLayer(doc, `${label} (no source)`, fallback, W, H);
    l.templatePlaceholder = true;      // read by the route to say so in its reply
    return l;
  }
  const kind = sourceKind(name);
  const l = blankLayer(doc, kind === "image" ? "image" : "video", { name: label });
  l.src = name;
  const probe = ctx?.probe?.[name] || null;
  if (probe?.width && probe?.height) l.transform.anchor = [probe.width / 2, probe.height / 2];
  const s = coverScale(probe, W, H);
  l.transform.scale = [s, s];
  return l;
}

const fx = (type, params) => blankEffect(type, params);

/* ─────────────────────────────────────────────── parameter specification */

const num = (def, min, max, desc, extra = {}) => ({ type: "number", default: def, min, max, desc, ...extra });
const str = (def, desc, max = 400) => ({ type: "text", default: def, maxLength: max, desc });
const col = (def, desc) => ({ type: "color", default: def, desc });
const src = (desc, kind = "any") => ({ type: "source", default: null, kind, desc });
const bool = (def, desc) => ({ type: "bool", default: def, desc });
const one = (options, def, desc) => ({ type: "enum", options, default: def, desc });

/**
 * Size, rate and length belong to every template, so they are described once.
 * A template overrides only the defaults it cares about (`size`, `duration`).
 */
const COMMON = {
  name: { type: "text", default: null, maxLength: 80, desc: "Comp name. Defaults to the template's label." },
  width: num(1920, LIMITS.minSize, LIMITS.maxSize, "Comp width in pixels.", { integer: true }),
  height: num(1080, LIMITS.minSize, LIMITS.maxSize, "Comp height in pixels.", { integer: true }),
  fps: num(30, LIMITS.minFps, LIMITS.maxFps, "Frames per second."),
  duration: num(6, LIMITS.minDuration, LIMITS.maxDuration, "Length in seconds."),
  bg: { type: "color", default: null, desc: "Comp background [r,g,b,a] 0-255. Defaults to the template's own (transparent for overlays, opaque for full-frame ones)." },
};

/**
 * Validate one value against its spec, or say exactly what is wrong with it.
 *
 * "Renders nothing" is the failure mode this exists to prevent: a size of -3 is
 * a title you will never see and an error you will never get, so it is refused
 * here with the range it had to be inside and the value it actually was.
 */
function coerce(tid, key, spec, raw) {
  const where = `${tid}.${key}`;
  if (raw === undefined || raw === null || raw === "") {
    if (spec.type === "text" && raw === "") return "";
    return spec.default;
  }
  switch (spec.type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${where} must be a number — got ${JSON.stringify(raw)}.`);
      if (n < spec.min || n > spec.max) {
        throw new Error(`${where} must be between ${spec.min} and ${spec.max} — got ${n}.`);
      }
      return spec.integer ? Math.round(n) : n;
    }
    case "text": {
      if (typeof raw === "number" || typeof raw === "boolean") raw = String(raw);
      if (typeof raw !== "string") throw new Error(`${where} must be text — got ${typeof raw}.`);
      if (raw.length > spec.maxLength) {
        throw new Error(`${where} is ${raw.length} characters; the limit is ${spec.maxLength}.`);
      }
      return raw;
    }
    case "bool": return !!raw;
    case "enum": {
      const s = String(raw);
      if (!spec.options.includes(s)) {
        throw new Error(`${where} must be one of: ${spec.options.join(", ")} — got "${s}".`);
      }
      return s;
    }
    case "color": {
      if (!Array.isArray(raw) || (raw.length !== 3 && raw.length !== 4)) {
        throw new Error(`${where} takes [r,g,b] or [r,g,b,a], each 0-255 — got ${JSON.stringify(raw)}.`);
      }
      const out = raw.map((c, i) => {
        const n = Number(c);
        if (!Number.isFinite(n)) throw new Error(`${where}[${i}] must be a number 0-255.`);
        if (n < 0 || n > 255) throw new Error(`${where}[${i}] must be between 0 and 255 — got ${n}.`);
        return n;
      });
      return out.length === 3 ? [...out, 255] : out;
    }
    case "source": {
      const s = String(raw).trim();
      if (!s) return null;
      // §6: a source is a library NAME. A caller that could name a path could
      // name any file on the disk, and this document is handed to python.
      if (/[\\/]/.test(s) || s.includes("..")) {
        throw new Error(`${where} must be a library NAME like "raven.png", not a path — got "${s}".`);
      }
      if (spec.kind === "image" && sourceKind(s) !== "image") {
        throw new Error(`${where} wants an IMAGE from the images library (.png, .jpg, .webp…) — got "${s}".`);
      }
      return s;
    }
    default:
      throw new Error(`${where}: unsupported parameter type "${spec.type}".`);
  }
}

/* ────────────────────────────────────────────────────── the templates */

/**
 * Each entry: what it is for, its own parameters, and a `build` that gets the
 * comp document (already sized) plus the validated parameters and returns the
 * layers TOP FIRST — §1's order, painted last.
 */
export const TEMPLATES = {

  /* ── 1. lower third ─────────────────────────────────────────────────── */
  lowerThird: {
    label: "Lower third",
    why: "A name and a role that slide in over footage behind a bar wipe, and leave again before the end. The caption every interview and every artist ID needs.",
    duration: 6, minDuration: 1.6, bg: [0, 0, 0, 0],
    params: {
      // Called `title` and not `name` on purpose: `name` is the COMP's name in
      // every other action, and one key with two meanings is a comp that quietly
      // ends up called "ALEX RIVERS".
      title: str("ALEX RIVERS", "The big line — a person, a band, a place.", 80),
      role: str("Producer · Nightfall Records", "The small line under the bar. Leave empty for one line only.", 120),
      accent: col([255, 60, 90, 255], "The bar's colour."),
      textColor: col([255, 255, 255, 255], "Colour of both lines."),
      plateColor: col([10, 10, 14, 190], "The slab behind the type. Its alpha is the see-through — 190 is a readable smoke."),
      size: num(null, 8, 400, "Size of the big line in pixels. Auto = 5.2% of comp height.", { auto: (c) => Math.round(c.height * 0.052), autoDesc: "5.2% of comp height" }),
      side: one(["left", "right"], "left", "Which side of the frame it hangs off."),
      margin: num(null, 0, 2000, "Distance from the frame edges in pixels. Auto = 11% of comp height.", { auto: (c) => Math.round(c.height * 0.11), autoDesc: "11% of comp height" }),
      barWidth: num(null, 16, 4096, "Length of the accent bar in pixels. Auto = 40% of comp width.", { auto: (c) => Math.round(c.width * 0.4), autoDesc: "40% of comp width" }),
      inAt: num(0.35, 0, 600, "When it starts arriving, in seconds."),
      font: str("arialbd.ttf", "Font file NAME for the big line (basename only).", 60),
    },
    build(doc, p) {
      const T = timings(p.duration, { inAt: p.inAt, inDur: 0.5, outDur: 0.45, tail: 0.3 });
      const roleSize = Math.max(8, Math.round(p.size * 0.42));
      const barH = Math.max(3, Math.round(p.size * 0.1));
      const left = p.side === "left";
      const X = left ? p.margin : p.width - p.margin - p.barWidth;
      const slide = Math.round(p.size * 2.2) * (left ? -1 : 1);

      const nameY = p.height - p.margin - p.size * 0.75;
      const barY = p.height - p.margin - p.size * 0.08;
      const roleY = p.height - p.margin + p.size * 0.45;
      const align = left ? "left" : "right";
      const textX = left ? X + Math.round(p.size * 0.1) : X + p.barWidth - Math.round(p.size * 0.1);

      // Type first (top of the stack), then the bar, then the slab it all sits on.
      const nameL = textLayer(doc, "name", p.title, {
        font: p.font, size: p.size, color: p.textColor, align, tracking: 6,
      }, {
        transform: {
          anchor: [doc.width / 2, doc.height / 2],
          position: anim(
            K(T.t0, [textX + slide, nameY], "easeOut"), K(T.t1, [textX, nameY]),
            K(T.t2, [textX, nameY], "easeIn"), K(T.t3, [textX + slide * 0.4, nameY]),
          ),
          scale: [100, 100], rotation: 0, opacity: fadeTrack(T),
        },
        effects: [fx("dropShadow", { color: [0, 0, 0], opacity: 65, distance: 5, angle: 90, softness: 14, spread: 6 })],
      });

      const layers = [nameL];

      if (p.role.trim()) {
        // The second line lands a beat later; simultaneous is what makes two
        // lines read as one blob instead of a name and its caption.
        const d = 0.12;
        layers.push(textLayer(doc, "role", p.role, {
          font: "arial.ttf", size: roleSize, color: p.textColor, align, tracking: 40,
        }, {
          transform: {
            anchor: [doc.width / 2, doc.height / 2],
            position: anim(
              K(T.t0 + d, [textX + slide, roleY], "easeOut"), K(T.t1 + d, [textX, roleY]),
              K(T.t2, [textX, roleY], "easeIn"), K(T.t3, [textX + slide * 0.4, roleY]),
            ),
            scale: [100, 100], rotation: 0,
            opacity: anim(K(T.t0 + d, 0, "easeOut"), K(T.t1 + d, 78), K(T.t2, 78, "easeIn"), K(T.t3, 0)),
          },
          effects: [fx("dropShadow", { color: [0, 0, 0], opacity: 60, distance: 4, angle: 90, softness: 10, spread: 4 })],
        }));
      }

      // The wipe: scaled from its own leading edge, so it grows out of nothing
      // rather than expanding from the middle.
      const barAnchor = left ? [0, barH / 2] : [p.barWidth, barH / 2];
      layers.push(solidLayer(doc, "accent bar", p.accent, p.barWidth, barH, {
        transform: {
          anchor: barAnchor,
          position: [left ? X : X + p.barWidth, barY],
          scale: anim(K(T.t0, [0, 100], SETTLE), K(T.t1, [100, 100]), K(T.t2, [100, 100], "easeIn"), K(T.t3, [0, 100])),
          rotation: 0, opacity: 100,
        },
      }));

      const plateW = p.barWidth + Math.round(p.size * 0.7);
      const plateH = Math.round((p.role.trim() ? p.size * 2.05 : p.size * 1.35));
      const plateCY = p.role.trim() ? (nameY + roleY) / 2 : nameY;
      const plateAnchor = left ? [0, plateH / 2] : [plateW, plateH / 2];
      layers.push(solidLayer(doc, "plate", p.plateColor, plateW, plateH, {
        transform: {
          anchor: plateAnchor,
          position: [left ? X - Math.round(p.size * 0.3) : X + p.barWidth + Math.round(p.size * 0.3), plateCY],
          scale: anim(K(T.t0, [0, 100], SETTLE), K(T.t1 + 0.05, [100, 100]), K(T.t2, [100, 100], "easeIn"), K(T.t3, [0, 100])),
          rotation: 0, opacity: 100,
        },
      }));

      doc.markers.push({ t: T.t1, label: "lower third on" }, { t: T.t2, label: "lower third off" });
      return layers;
    },
  },

  /* ── 2. title card ──────────────────────────────────────────────────── */
  titleCard: {
    label: "Title card",
    why: "A big centred title that fades and scales up over a plate, with a rule and a subtitle under it. The opening of the film.",
    duration: 5, minDuration: 1.2, bg: [0, 0, 0, 255],
    params: {
      title: str("CROSSROADS OF RAVENS", "The title.", 200),
      subtitle: str("a film about the long way round", "One line under the rule. Empty for none.", 200),
      plate: src("Library NAME of a still or clip to sit behind the type. Omitted = a solid backdrop."),
      titleColor: col([245, 243, 238, 255], "Title colour."),
      subtitleColor: col([200, 198, 194, 255], "Subtitle colour."),
      backdrop: col([9, 9, 13, 255], "Backdrop colour, used behind the plate and instead of it."),
      accent: col([255, 200, 120, 255], "Colour of the rule between title and subtitle."),
      titleSize: num(null, 8, 400, "Title size in pixels. Auto = 9% of comp height.", { auto: (c) => Math.round(c.height * 0.09), autoDesc: "9% of comp height" }),
      subtitleSize: num(null, 8, 400, "Subtitle size in pixels. Auto = 3.1% of comp height.", { auto: (c) => Math.round(c.height * 0.031), autoDesc: "3.1% of comp height" }),
      glow: bool(true, "Bloom the title a little."),
      vignette: num(45, 0, 100, "How far the corners fall off."),
      font: str("arialbd.ttf", "Font file NAME for the title.", 60),
    },
    build(doc, p, ctx) {
      const T = timings(p.duration, { inAt: 0.2, inDur: 0.9, outDur: 0.6, tail: 0.15 });
      const cx = p.width / 2;
      const titleY = p.height * 0.47;
      const ruleY = p.height * 0.47 + p.titleSize * 0.85;
      const subY = ruleY + p.subtitleSize * 1.6;
      const layers = [];

      const titleFx = [fx("dropShadow", { color: [0, 0, 0], opacity: 70, distance: 8, angle: 90, softness: 26, spread: 2 })];
      if (p.glow) titleFx.unshift(fx("glow", { threshold: 55, radius: 30, intensity: 110, softness: 25, mode: "add", expandAlpha: true }));

      layers.push(textLayer(doc, "title", p.title, {
        font: p.font, size: p.titleSize, color: p.titleColor, align: "center", tracking: 25, lineHeight: 1.12,
      }, {
        transform: {
          anchor: [doc.width / 2, doc.height / 2], position: [cx, titleY],
          // Scale and opacity together: a title that only fades looks pasted on,
          // one that only scales looks like a zoom. Both, and it arrives.
          scale: anim(K(T.t0, [92, 92], "easeOut"), K(T.t1, [100, 100]), K(T.t2, [100, 100], "easeIn"), K(T.t3, [103, 103])),
          rotation: 0, opacity: fadeTrack(T),
        },
        effects: titleFx,
      }));

      if (p.subtitle.trim()) {
        layers.push(textLayer(doc, "subtitle", p.subtitle, {
          font: "arial.ttf", size: p.subtitleSize, color: p.subtitleColor, align: "center", tracking: 90,
        }, {
          transform: {
            anchor: [doc.width / 2, doc.height / 2],
            position: anim(K(T.t0 + 0.25, [cx, subY + p.subtitleSize * 0.7], "easeOut"), K(T.t1 + 0.35, [cx, subY])),
            scale: [100, 100], rotation: 0,
            opacity: anim(K(T.t0 + 0.25, 0, "easeOut"), K(T.t1 + 0.35, 100), K(T.t2, 100, "easeIn"), K(T.t3, 0)),
          },
        }));

        const ruleW = Math.round(p.titleSize * 3.2);
        layers.push(solidLayer(doc, "rule", p.accent, ruleW, Math.max(1, Math.round(p.titleSize * 0.025)), {
          transform: {
            anchor: [ruleW / 2, 1], position: [cx, ruleY],
            scale: anim(K(T.t0 + 0.15, [0, 100], SETTLE), K(T.t1 + 0.25, [100, 100]), K(T.t2, [100, 100], "easeIn"), K(T.t3, [0, 100])),
            rotation: 0, opacity: 100,
          },
        }));
      }

      // The plate pushes very slowly the whole way through — a still that never
      // moves reads as a slide, and a title card is a shot.
      const plate = sourceLayer(doc, p.plate, "plate", ctx, { fallback: p.backdrop });
      const base = plate.transform.scale[0];
      plate.transform.scale = anim(K(0, [base, base], "easeInOut"), K(p.duration, [r3(base * 1.05), r3(base * 1.05)]));
      plate.transform.opacity = anim(K(0, 0, "easeOut"), K(0.6, 100), K(T.t2 + 0.15, 100, "easeIn"), K(p.duration, 0));
      plate.effects = [fx("vignette", { amount: p.vignette, size: 76, softness: 62, roundness: 55, color: [0, 0, 0] })];
      layers.push(plate);

      if (p.plate) layers.push(solidLayer(doc, "backdrop", p.backdrop, p.width, p.height));
      doc.markers.push({ t: T.t1, label: "title up" });
      return layers;
    },
  },

  /* ── 3. logo sting ──────────────────────────────────────────────────── */
  logoSting: {
    label: "Logo sting",
    why: "A logo that snaps in past its final size, blooms, and settles. Three seconds of brand at the top or tail of anything.",
    duration: 3, minDuration: 1, bg: [0, 0, 0, 255],
    params: {
      logo: src("Library NAME of the logo image. Omitted = a solid mark in the accent colour.", "image"),
      logoHeight: num(null, 8, 4096, "How tall the logo sits, in pixels. Auto = 34% of comp height.", { auto: (c) => Math.round(c.height * 0.34), autoDesc: "34% of comp height" }),
      caption: str("", "An optional word under the logo.", 80),
      backdrop: col([7, 7, 11, 255], "Background colour."),
      accent: col([120, 190, 255, 255], "The bloom's colour, and the placeholder mark's."),
      spin: num(-10, -360, 360, "Degrees the logo turns through as it lands. 0 for none."),
      settleAt: num(null, 0.2, 600, "When the logo has finished landing, in seconds. Auto = 40% of the duration.", { auto: (c) => r3(c.duration * 0.4), autoDesc: "40% of duration" }),
      captionSize: num(null, 8, 400, "Caption size in pixels. Auto = 3.4% of comp height.", { auto: (c) => Math.round(c.height * 0.034), autoDesc: "3.4% of comp height" }),
    },
    build(doc, p, ctx) {
      const cx = p.width / 2, cy = p.height * (p.caption.trim() ? 0.44 : 0.5);
      const settle = Math.min(p.settleAt, p.duration * 0.7);
      const t0 = Math.min(0.1, settle * 0.25);
      const layers = [];

      const probe = ctx?.probe?.[p.logo] || null;
      const markW = probe?.width ? p.logoHeight * (probe.width / probe.height) : p.logoHeight;
      const logo = p.logo
        ? sourceLayer(doc, p.logo, "logo", ctx)
        : solidLayer(doc, "logo (no source)", p.accent, Math.round(markW), Math.round(p.logoHeight));
      if (!p.logo) logo.templatePlaceholder = true;
      // Scale is a percentage of the source's own pixels, so "34% of the frame"
      // is only knowable once the source has been probed.
      const s = probe?.height ? r3((p.logoHeight / probe.height) * 100) : 100;
      logo.transform.position = [cx, cy];
      logo.transform.scale = anim(K(t0, [r3(s * 0.25), r3(s * 0.25)], OVERSHOOT), K(settle, [s, s]));
      logo.transform.rotation = anim(K(t0, p.spin, "easeOut"), K(settle, 0));
      logo.transform.opacity = anim(
        K(t0, 0, "easeOut"), K(t0 + Math.min(0.25, settle * 0.4), 100),
        K(Math.max(settle + 0.05, p.duration - 0.4), 100, "easeIn"), K(p.duration, 0),
      );
      // The bloom is the impact: nothing, then a hit on landing, then a level it
      // holds. A constant glow is a logo that was always glowing.
      logo.effects = [fx("glow", {
        threshold: 40, radius: 40, softness: 30, mode: "add", colorize: true,
        glowColor: p.accent.slice(0, 3), expandAlpha: true,
        intensity: anim(K(t0, 0, "easeOut"), K(settle, 230, "easeOut"), K(Math.min(p.duration, settle + 0.6), 85)),
      })];
      layers.push(logo);

      if (p.caption.trim()) {
        const capY = cy + p.logoHeight * 0.62;
        layers.push(textLayer(doc, "caption", p.caption, {
          font: "arial.ttf", size: p.captionSize, color: [235, 235, 240, 255], align: "center", tracking: 220,
        }, {
          transform: {
            anchor: [doc.width / 2, doc.height / 2], position: [cx, capY],
            scale: [100, 100], rotation: 0,
            opacity: anim(K(settle * 0.8, 0, "easeOut"), K(settle + 0.35, 100),
              K(Math.max(settle + 0.4, p.duration - 0.4), 100, "easeIn"), K(p.duration, 0)),
          },
        }));
      }

      // A radial ramp that brightens on the hit — the light the logo lands in.
      layers.push(solidLayer(doc, "backdrop", p.backdrop, p.width, p.height, {
        effects: [fx("ramp", {
          type: "radial", startX: 50, startY: 45, endX: 50, endY: 130,
          startColor: [p.accent[0] * 0.22, p.accent[1] * 0.22, p.accent[2] * 0.26].map(Math.round),
          endColor: p.backdrop.slice(0, 3), mode: "normal",
          opacity: anim(K(t0, 20, "easeOut"), K(settle, 100, "easeIn"), K(Math.min(p.duration, settle + 0.7), 55)),
        })],
      }));
      doc.markers.push({ t: r3(settle), label: "logo lands" });
      return layers;
    },
  },

  /* ── 4. ken burns ───────────────────────────────────────────────────── */
  kenBurns: {
    label: "Ken Burns",
    why: "A still that slowly pushes and drifts — the move that turns a folder of images into footage. Give it a cover and you have a video.",
    duration: 8, minDuration: 1, bg: [0, 0, 0, 255],
    params: {
      image: src("Library NAME of the still (a clip works too). Omitted = a solid, which still proves the move."),
      move: one(["in", "out", "left", "right", "up", "down"], "in", "Which way it travels. 'in' pushes, 'out' pulls back, the rest pan while pushing slightly."),
      zoom: num(14, 0, 100, "How much the scale changes across the whole shot, in percent."),
      drift: num(4, 0, 40, "How far a pan travels, as a percent of the frame."),
      vignette: num(28, -100, 100, "Corner falloff. Negative brightens the corners instead."),
      fadeIn: num(0.6, 0, 60, "Seconds fading up from the background at the head."),
      fadeOut: num(0.8, 0, 60, "Seconds fading out at the tail."),
      backdrop: col([0, 0, 0, 255], "What it fades from and to."),
    },
    build(doc, p, ctx) {
      const D = p.duration;
      const layer = sourceLayer(doc, p.image, "still", ctx, { fallback: [58, 52, 64, 255] });
      /* A pan must not run off the edge of the picture, and that is arithmetic,
       * not taste: covering the frame leaves NO slack, so travelling `drift` of
       * the frame needs the picture blown up by the same `drift` — half of it
       * hanging off each side — and then the travel is drift/2 either way. Get
       * this wrong and the shot works on a 16:9 source and shows black on a
       * square one. */
      const panning = p.move !== "in" && p.move !== "out";
      const base = layer.transform.scale[0] * (panning ? 1 + p.drift / 100 + 0.02 : 1);
      const grown = base * (1 + p.zoom / 100);
      const from = p.move === "out" ? grown : base;
      const to = p.move === "out" ? base : grown;

      const cx = p.width / 2, cy = p.height / 2;
      const dx = p.width * (p.drift / 200), dy = p.height * (p.drift / 200);
      const shift = {
        in: [0, 0], out: [0, 0],
        left: [dx, 0], right: [-dx, 0], up: [0, dy], down: [0, -dy],
      }[p.move];

      layer.transform.scale = anim(K(0, [r3(from), r3(from)], "easeInOut"), K(D, [r3(to), r3(to)]));
      layer.transform.position = anim(
        K(0, [r3(cx + shift[0]), r3(cy + shift[1])], "easeInOut"),
        K(D, [r3(cx - shift[0]), r3(cy - shift[1])]),
      );
      const fi = Math.min(p.fadeIn, D * 0.4), fo = Math.min(p.fadeOut, D * 0.4);
      layer.transform.opacity = anim(
        K(0, fi > 0 ? 0 : 100, "easeOut"), K(Math.max(0.02, fi), 100),
        K(Math.max(fi + 0.03, D - fo), 100, "easeIn"), K(D, fo > 0 ? 0 : 100),
      );
      layer.effects = [fx("vignette", { amount: p.vignette, size: 82, softness: 60, roundness: 55, color: [0, 0, 0] })];

      return [layer, solidLayer(doc, "backdrop", p.backdrop, p.width, p.height)];
    },
  },

  /* ── 5. film look ───────────────────────────────────────────────────── */
  filmLook: {
    label: "Film look",
    why: "Grain, a vignette, an S-curve and a whisper of chromatic aberration over existing footage — a LOOK, on an adjustment layer, so it grades everything under it.",
    duration: 6, minDuration: 0.5, bg: [0, 0, 0, 255],
    params: {
      clip: src("Library NAME of the footage to grade. Omitted = a grey solid, which still shows the look."),
      grain: num(14, 0, 100, "Film grain."),
      contrast: num(60, 0, 100, "How hard the S-curve bites — this is the curve's `amount`, not a contrast slider."),
      warmth: num(35, 0, 100, "How far the split-tone pulls: cool shadows, warm highlights."),
      vignette: num(38, -100, 100, "Corner falloff."),
      aberration: num(2.5, 0, 60, "Colour fringing towards the corners, in pixels. Past ~6 it stops being subtle."),
      push: num(3, 0, 40, "A slow scale push across the shot, in percent. 0 holds it still."),
      fadeIn: num(0.5, 0, 60, "Seconds fading up from black."),
      fadeOut: num(0.8, 0, 60, "Seconds fading down to black."),
    },
    build(doc, p, ctx) {
      const D = p.duration;
      const fi = Math.min(p.fadeIn, D * 0.4), fo = Math.min(p.fadeOut, D * 0.4);
      const layers = [];

      // The fade lives on its own black slab rather than on the footage's
      // opacity: fading the footage would fade it to the COMP background, and a
      // comp that later gets composited over something would fade to that.
      layers.push(solidLayer(doc, "fade", [0, 0, 0, 255], p.width, p.height, {
        transform: {
          anchor: [p.width / 2, p.height / 2], position: [p.width / 2, p.height / 2],
          scale: [100, 100], rotation: 0,
          opacity: anim(
            K(0, fi > 0 ? 100 : 0, "easeIn"), K(Math.max(0.02, fi), 0),
            K(Math.max(fi + 0.03, D - fo), 0, "easeOut"), K(D, fo > 0 ? 100 : 0),
          ),
        },
      }));

      const look = blankLayer(doc, "adjustment", { name: "film look" });
      look.effects = [
        // A real S-curve over 0..255, the domain imagetools' curves use: lift the
        // quarter tones, hold the middle, roll the shoulder off.
        fx("curves", {
          master: [[0, 0], [48, 36], [128, 128], [208, 220], [255, 255]],
          amount: p.contrast,
        }),
        fx("tint", { blackColor: [10, 16, 36], whiteColor: [255, 240, 214], amount: r3(p.warmth * 0.45) }),
        fx("chromaticAberration", { amount: p.aberration, type: "radial", centerX: 50, centerY: 50 }),
        fx("vignette", { amount: p.vignette, size: 78, softness: 64, roundness: 52, color: [0, 0, 0] }),
        fx("noise", { amount: p.grain, type: "gaussian", mono: true, seed: 7, animate: true, size: 1 }),
      ];
      layers.push(look);

      const clip = sourceLayer(doc, p.clip, "footage", ctx, { fallback: [96, 96, 102, 255] });
      const base = clip.transform.scale[0];
      const end = r3(base * (1 + p.push / 100));
      clip.transform.scale = p.push > 0
        ? anim(K(0, [base, base], "easeInOut"), K(D, [end, end]))
        : [base, base];
      layers.push(clip);
      return layers;
    },
  },

  /* ── 6. split screen ────────────────────────────────────────────────── */
  splitScreen: {
    label: "Split screen",
    why: "Two sources side by side with a divider between them, each cropped by an alpha matte so neither spills across the line.",
    duration: 6, minDuration: 0.6, bg: [0, 0, 0, 255],
    params: {
      left: src("Library NAME for the left (or top) half. Omitted = a solid."),
      right: src("Library NAME for the right (or bottom) half. Omitted = a solid."),
      orientation: one(["vertical", "horizontal"], "vertical", "'vertical' splits left/right, 'horizontal' splits top/bottom."),
      gap: num(null, 0, 400, "Space between the halves in pixels. Auto = 0.6% of comp width.", { auto: (c) => Math.round(c.width * 0.006), autoDesc: "0.6% of comp width" }),
      dividerColor: col([245, 245, 250, 255], "The line down the middle."),
      dividerWidth: num(null, 0, 400, "Thickness of that line in pixels. 0 hides it. Auto = 0.3% of comp width.", { auto: (c) => Math.max(2, Math.round(c.width * 0.003)), autoDesc: "0.3% of comp width" }),
      backdrop: col([12, 12, 16, 255], "What shows in the gap and behind everything."),
      slide: num(null, 0, 4096, "How far each half travels in, in pixels. Auto = 6% of comp width.", { auto: (c) => Math.round(c.width * 0.06), autoDesc: "6% of comp width" }),
      inDur: num(0.7, 0.05, 60, "Seconds for the halves to arrive."),
    },
    build(doc, p, ctx) {
      const vertical = p.orientation === "vertical";
      const W = p.width, H = p.height, g = p.gap;
      const halfW = vertical ? (W - g) / 2 : W;
      const halfH = vertical ? H : (H - g) / 2;
      const aC = vertical ? [halfW / 2, H / 2] : [W / 2, halfH / 2];
      const bC = vertical ? [W - halfW / 2, H / 2] : [W / 2, H - halfH / 2];
      const inDur = Math.min(p.inDur, p.duration * 0.6);
      const layers = [];

      if (p.dividerWidth > 0) {
        const dw = vertical ? p.dividerWidth : W;
        const dh = vertical ? H : p.dividerWidth;
        layers.push(solidLayer(doc, "divider", p.dividerColor, dw, dh, {
          transform: {
            anchor: [dw / 2, dh / 2], position: [W / 2, H / 2],
            // Wipes open from the centre outward, which is the gesture of a
            // split rather than a line that was always there.
            scale: vertical
              ? anim(K(0, [100, 0], SETTLE), K(inDur + 0.15, [100, 100]))
              : anim(K(0, [0, 100], SETTLE), K(inDur + 0.15, [100, 100])),
            rotation: 0, opacity: 100,
          },
        }));
      }

      // Each half is a matte (the window) with its picture directly beneath it:
      // §1's track matte uses the layer DIRECTLY ABOVE, so the pair order is the
      // whole mechanism. The matte never moves — it is the hole — and the
      // picture slides in behind it.
      for (const [name, srcName, centre, dir] of [
        ["left", p.left, aC, -1], ["right", p.right, bC, 1],
      ]) {
        const label = vertical ? name : (name === "left" ? "top" : "bottom");
        const matte = solidLayer(doc, `${label} window`, [255, 255, 255, 255], halfW, halfH, {
          transform: {
            anchor: [halfW / 2, halfH / 2], position: centre.slice(),
            scale: [100, 100], rotation: 0, opacity: 100,
          },
        });
        /* Overscan by exactly the slide distance. A picture scaled to cover its
         * window precisely would show a bare strip of window for the whole
         * entrance — the matte crops the surplus, so it costs nothing. */
        const ov = 1 + p.slide / Math.max(1, vertical ? halfW : halfH);
        const pic = sourceLayer(doc, srcName, label, ctx, {
          box: [halfW * ov, halfH * ov],
          fallback: name === "left" ? [46, 52, 68, 255] : [68, 50, 52, 255],
        });
        const ox = vertical ? p.slide * dir : 0;
        const oy = vertical ? 0 : p.slide * dir;
        pic.transform.position = anim(
          K(0, [r3(centre[0] + ox), r3(centre[1] + oy)], "easeOut"),
          K(inDur, [r3(centre[0]), r3(centre[1])]),
        );
        // And it keeps moving after it lands. Two pictures frozen side by side
        // read as a diagram; the slow push is what makes it a shot. The matte
        // crops the growth, so nothing can creep over the divider.
        const s0 = pic.transform.scale[0];
        pic.transform.scale = anim(
          K(0, [s0, s0], "easeInOut"), K(p.duration, [r3(s0 * 1.04), r3(s0 * 1.04)]),
        );
        pic.transform.opacity = anim(K(0, 0, "easeOut"), K(Math.min(inDur, 0.35), 100));
        pic.trackMatte = { type: "alpha" };
        layers.push(matte, pic);
      }

      layers.push(solidLayer(doc, "backdrop", p.backdrop, W, H));
      return layers;
    },
  },

  /* ── 7. glitch transition ───────────────────────────────────────────── */
  glitchTransition: {
    label: "Glitch transition",
    why: "Half a second of tearing, blocking and RGB split, built to sit BETWEEN two clips. Render it as mp4 and drop it on the cut.",
    duration: 0.6, minDuration: 0.15, bg: [0, 0, 0, 255],
    params: {
      clip: src("Library NAME of what is being torn apart — usually a frame of the outgoing shot. Omitted = a coloured ramp, which still glitches."),
      intensity: num(70, 0, 100, "How violent it is. Drives the tearing, the blocking and the split together."),
      accent: col([255, 60, 90, 255], "The flash colour."),
      flash: bool(true, "Punch a couple of frames of accent through it."),
      blocks: bool(true, "Mosaic stutter as well as tearing."),
      seed: num(7, 0, 100000, "Noise seed — the same seed renders the same glitch."),
    },
    build(doc, p, ctx) {
      const D = p.duration;
      // Every beat is a fraction of the length, so a 0.25s stab and a 1.5s mess
      // are the same performance at different speeds.
      const at = (f) => r3(clamp(f, 0, 1) * D);
      const g = p.intensity / 100;
      const layers = [];

      if (p.flash) {
        // HOLD easing, deliberately: a glitch is a sequence of steps, and
        // interpolating between them turns a stutter into a smear.
        layers.push(solidLayer(doc, "flash", p.accent, p.width, p.height, {
          blend: "add",
          transform: {
            anchor: [p.width / 2, p.height / 2], position: [p.width / 2, p.height / 2],
            scale: [100, 100], rotation: 0,
            opacity: anim(
              K(0, 0, "hold"), K(at(0.1), r3(55 * g), "hold"), K(at(0.16), 0, "hold"),
              K(at(0.52), r3(38 * g), "hold"), K(at(0.58), 0, "hold"), K(D, 0),
            ),
          },
        }));
      }

      layers.push(Object.assign(blankLayer(doc, "adjustment", { name: "signal" }), {
        effects: [
          fx("scanlines", { spacing: 3, thickness: 55, darkness: r3(45 * g), offset: 0, rollSpeed: 160, softness: 35, vertical: false, affectAlpha: false }),
          fx("noise", { amount: r3(30 * g), type: "uniform", mono: false, seed: p.seed, animate: true, size: 1 }),
        ],
      }));

      const base = sourceLayer(doc, p.clip, "source", ctx, { fallback: [30, 24, 46, 255] });
      const tear = [];
      // The tear: a square wave along x, so rows jump sideways in slabs rather
      // than rippling — square, not sine, is what makes it read as broken video.
      tear.push(fx("wave", {
        direction: "horizontal", wavelength: 26, phase: 0, speed: 6,
        waveType: "square", edgeBehavior: "wrap",
        amplitude: anim(
          K(0, 0, "hold"), K(at(0.08), r3(70 * g), "hold"), K(at(0.22), r3(14 * g), "hold"),
          K(at(0.42), r3(95 * g), "hold"), K(at(0.6), r3(26 * g), "hold"),
          K(at(0.78), r3(48 * g), "easeOut"), K(D, 0),
        ),
      }));
      if (p.blocks) {
        tear.push(fx("mosaic", {
          sizeY: 0,
          size: anim(
            K(0, 2, "hold"), K(at(0.14), r3(2 + 34 * g), "hold"), K(at(0.28), 3, "hold"),
            K(at(0.5), r3(2 + 20 * g), "hold"), K(at(0.66), 2, "hold"), K(D, 2),
          ),
        }));
      }
      tear.push(fx("chromaticAberration", {
        type: "linear", angle: 0, centerX: 50, centerY: 50,
        amount: anim(
          K(0, 0, "easeOut"), K(at(0.12), r3(52 * g), "easeIn"), K(at(0.3), r3(6 * g), "hold"),
          K(at(0.46), r3(40 * g), "easeOut"), K(at(0.8), r3(10 * g), "easeOut"), K(D, 0),
        ),
      }));
      base.effects = tear;
      if (!p.clip) {
        // The degrade still has to be worth glitching: a tear only reads against
        // detail, and a flat rectangle displaced sideways looks like nothing at
        // all. The grid is there to be broken.
        base.effects = [
          fx("ramp", {
            type: "linear", startX: 0, startY: 0, endX: 100, endY: 100,
            startColor: p.accent.slice(0, 3), endColor: [20, 30, 90], opacity: 100, mode: "normal",
          }),
          fx("gridLines", {
            spacing: Math.max(8, Math.round(p.height / 14)), lineWidth: 2,
            color: [235, 240, 255], axis: "both", offsetX: 0, offsetY: 0, opacity: 55, mode: "normal",
          }),
          ...tear,
        ];
      }
      // And it jumps: a couple of held offsets, no interpolation between them.
      base.transform.position = anim(
        K(0, [p.width / 2, p.height / 2], "hold"),
        K(at(0.12), [r3(p.width / 2 + 26 * g), p.height / 2], "hold"),
        K(at(0.2), [r3(p.width / 2 - 18 * g), r3(p.height / 2 + 8 * g)], "hold"),
        K(at(0.34), [p.width / 2, p.height / 2], "hold"),
        K(at(0.5), [r3(p.width / 2 - 30 * g), p.height / 2], "hold"),
        K(at(0.62), [p.width / 2, p.height / 2]),
      );
      layers.push(base);
      return layers;
    },
  },

  /* ── 8. caption bar ─────────────────────────────────────────────────── */
  captionBar: {
    label: "Caption bar",
    why: "A readable subtitle strip: type on a smoked slab at the bottom of the frame, up and gone in a fifth of a second. The audiobook and MV workhorse.",
    duration: 4, minDuration: 0.4, bg: [0, 0, 0, 0],
    params: {
      text: str("Every line of this is going somewhere.\nYou just cannot see where yet.", "The caption. Newlines make more lines.", 600),
      size: num(null, 8, 400, "Type size in pixels. Auto = 4.1% of comp height.", { auto: (c) => Math.round(c.height * 0.041), autoDesc: "4.1% of comp height" }),
      textColor: col([248, 248, 250, 255], "Type colour."),
      barColor: col([8, 8, 12, 185], "The slab. Its alpha is the see-through."),
      barWidth: num(null, 16, 4096, "Slab width in pixels. Auto = 86% of comp width.", { auto: (c) => Math.round(c.width * 0.86), autoDesc: "86% of comp width" }),
      margin: num(null, 0, 2000, "Distance from the bottom edge in pixels. Auto = 7.5% of comp height.", { auto: (c) => Math.round(c.height * 0.075), autoDesc: "7.5% of comp height" }),
      fadeIn: num(0.18, 0, 60, "Seconds arriving."),
      fadeOut: num(0.22, 0, 60, "Seconds leaving."),
      font: str("arial.ttf", "Font file NAME.", 60),
    },
    build(doc, p) {
      const lines = Math.max(1, String(p.text).split("\n").length);
      const lineH = p.size * 1.22;
      const barH = Math.round(lineH * lines + p.size * 0.9);
      const cx = p.width / 2;
      const barCY = p.height - p.margin - barH / 2;
      const T = timings(p.duration, { inAt: 0, inDur: p.fadeIn, outDur: p.fadeOut, tail: 0 });
      const rise = Math.round(p.size * 0.25);

      return [
        textLayer(doc, "caption", p.text, {
          font: p.font, size: p.size, color: p.textColor, align: "center", lineHeight: 1.22,
        }, {
          transform: {
            anchor: [doc.width / 2, doc.height / 2],
            position: anim(K(T.t0, [cx, r3(barCY + rise)], "easeOut"), K(T.t1, [cx, r3(barCY)])),
            scale: [100, 100], rotation: 0, opacity: fadeTrack(T),
          },
          effects: [fx("dropShadow", { color: [0, 0, 0], opacity: 70, distance: 3, angle: 90, softness: 8, spread: 10 })],
        }),
        solidLayer(doc, "slab", p.barColor, p.barWidth, barH, {
          transform: {
            anchor: [p.barWidth / 2, barH / 2],
            position: anim(K(T.t0, [cx, r3(barCY + rise)], "easeOut"), K(T.t1, [cx, r3(barCY)])),
            scale: [100, 100], rotation: 0, opacity: fadeTrack(T),
          },
        }),
      ];
    },
  },

  /* ── 9. end card ────────────────────────────────────────────────────── */
  endCard: {
    label: "End card",
    why: "Title, subtitle and a call to action that holds on screen and breathes. What plays while the last chord rings out.",
    duration: 6, minDuration: 1.2, bg: [0, 0, 0, 255],
    params: {
      title: str("GLASS AND NEON", "The big line.", 120),
      subtitle: str("out now, everywhere", "The line under it.", 160),
      cta: str("LISTEN → aiplay.fm", "The call to action, on a pill. Empty for none.", 80),
      logo: src("Library NAME of a logo image to sit above the title. Omitted = none.", "image"),
      backdrop: col([10, 10, 16, 255], "Background colour."),
      accent: col([255, 60, 90, 255], "The pill's colour."),
      titleColor: col([246, 244, 240, 255], "Title colour."),
      subtitleColor: col([190, 190, 200, 255], "Subtitle colour."),
      ctaColor: col([255, 255, 255, 255], "Colour of the type on the pill."),
      titleSize: num(null, 8, 400, "Title size in pixels. Auto = 7.8% of comp height.", { auto: (c) => Math.round(c.height * 0.078), autoDesc: "7.8% of comp height" }),
      subtitleSize: num(null, 8, 400, "Subtitle size in pixels. Auto = 3.1% of comp height.", { auto: (c) => Math.round(c.height * 0.031), autoDesc: "3.1% of comp height" }),
      ctaSize: num(null, 8, 400, "CTA size in pixels. Auto = 2.8% of comp height.", { auto: (c) => Math.round(c.height * 0.028), autoDesc: "2.8% of comp height" }),
      font: str("arialbd.ttf", "Font file NAME for the title.", 60),
    },
    build(doc, p, ctx) {
      const D = p.duration;
      const cx = p.width / 2;
      const hasLogo = !!p.logo;
      const titleY = p.height * (hasLogo ? 0.46 : 0.4);
      const subY = titleY + p.titleSize * 0.95;
      const ctaY = p.height * 0.72;
      const layers = [];

      /* A line arrives, rises a little, and STAYS. An end card that fades out is
       * an end card nobody read. */
      const enter = (delay, y) => ({
        pos: anim(K(delay, [cx, r3(y + p.subtitleSize * 0.8)], "easeOut"), K(delay + 0.7, [cx, r3(y)])),
        op: anim(K(delay, 0, "easeOut"), K(delay + 0.6, 100)),
      });

      if (p.cta.trim()) {
        // A rough pill: 0.62 em per character is a fair average for the fonts
        // this ships with, and the padding hides the error either way. Set
        // `ctaSize` down if a very long CTA breaks out of it.
        const pillW = Math.round(p.ctaSize * (p.cta.length * 0.62 + 3.4));
        const pillH = Math.round(p.ctaSize * 2.4);
        const pillId = newId("ly");
        const beat = Math.max(0.9, (D - 1.4) / 3);
        const pulse = anim(
          K(1.4, [100, 100], "easeInOut"), K(1.4 + beat / 2, [103, 103], "easeInOut"),
          K(1.4 + beat, [100, 100], "easeInOut"), K(1.4 + beat * 1.5, [103, 103], "easeInOut"),
          K(1.4 + beat * 2, [100, 100]),
        );

        /* The type is PARENTED to the pill so one pulse moves both. A child's
         * transform is read in its PARENT'S layer pixels (interp.world_matrix
         * composes parent ∘ child), which is why the position below is the
         * pill's own centre and not a comp coordinate. */
        layers.push(textLayer(doc, "cta", p.cta, {
          font: "arialbd.ttf", size: p.ctaSize, color: p.ctaColor, align: "center", tracking: 60,
        }, {
          parent: pillId,
          transform: {
            anchor: [doc.width / 2, doc.height / 2],
            position: [pillW / 2, pillH / 2],
            scale: [100, 100], rotation: 0,
            opacity: anim(K(1.0, 0, "easeOut"), K(1.5, 100)),
          },
        }));
        const pill = solidLayer(doc, "cta pill", p.accent, pillW, pillH, {
          transform: {
            anchor: [pillW / 2, pillH / 2],
            position: anim(K(1.0, [cx, r3(ctaY + p.ctaSize * 0.8)], "easeOut"), K(1.7, [cx, r3(ctaY)])),
            scale: pulse, rotation: 0,
            opacity: anim(K(1.0, 0, "easeOut"), K(1.5, 100)),
          },
        });
        pill.id = pillId;
        layers.push(pill);
      }

      if (p.subtitle.trim()) {
        const e = enter(0.55, subY);
        layers.push(textLayer(doc, "subtitle", p.subtitle, {
          font: "arial.ttf", size: p.subtitleSize, color: p.subtitleColor, align: "center", tracking: 70,
        }, {
          transform: { anchor: [doc.width / 2, doc.height / 2], position: e.pos, scale: [100, 100], rotation: 0, opacity: e.op },
        }));
      }

      const e = enter(0.2, titleY);
      layers.push(textLayer(doc, "title", p.title, {
        font: p.font, size: p.titleSize, color: p.titleColor, align: "center", tracking: 20,
      }, {
        transform: {
          anchor: [doc.width / 2, doc.height / 2], position: e.pos,
          scale: anim(K(0.2, [96, 96], "easeOut"), K(0.9, [100, 100])), rotation: 0, opacity: e.op,
        },
        effects: [fx("glow", { threshold: 62, radius: 22, intensity: 70, softness: 30, mode: "screen", expandAlpha: true })],
      }));

      if (hasLogo) {
        const logo = sourceLayer(doc, p.logo, "logo", ctx);
        const probe = ctx?.probe?.[p.logo] || null;
        const want = p.height * 0.14;
        const s = probe?.height ? r3((want / probe.height) * 100) : 100;
        logo.transform.scale = [s, s];
        logo.transform.position = [cx, p.height * 0.26];
        logo.transform.opacity = anim(K(0, 0, "easeOut"), K(0.7, 100));
        layers.push(logo);
      }

      layers.push(solidLayer(doc, "backdrop", p.backdrop, p.width, p.height, {
        effects: [
          fx("ramp", {
            type: "radial", startX: 50, startY: 40, endX: 50, endY: 125,
            startColor: [Math.round(p.accent[0] * 0.18), Math.round(p.accent[1] * 0.16), Math.round(p.accent[2] * 0.2)],
            endColor: p.backdrop.slice(0, 3), opacity: 90, mode: "normal",
          }),
          fx("vignette", { amount: 40, size: 84, softness: 66, roundness: 50, color: [0, 0, 0] }),
        ],
      }));
      doc.markers.push({ t: 1.7, label: "cta in" });
      return layers;
    },
  },

  /* ── 10. VHS look ───────────────────────────────────────────────────── */
  vhsLook: {
    label: "VHS look",
    why: "Scanlines, tape wobble, colour fringing, grain and a head-switch band walking up the frame. Tape, not film.",
    duration: 6, minDuration: 0.5, bg: [0, 0, 0, 255],
    params: {
      clip: src("Library NAME of the footage. Omitted = a ramp, which still shows the tape."),
      wobble: num(30, 0, 100, "Horizontal tape wobble."),
      scanlines: num(55, 0, 100, "How dark the scanlines sit."),
      grain: num(24, 0, 100, "Tape noise."),
      aberration: num(5, 0, 60, "Colour fringing, in pixels."),
      desaturate: num(18, 0, 100, "How far the colour is pulled out."),
      headSwitch: bool(true, "The bright band that crawls up the picture."),
      rollSpeed: num(45, -200, 200, "How fast the scanlines crawl. 0 pins them."),
    },
    build(doc, p, ctx) {
      const D = p.duration;
      const layers = [];

      if (p.headSwitch) {
        /* The band walks bottom to top and JUMPS back — the hold key at the top
         * of each pass is the jump, and it is why this is three key pairs and
         * not a sine. */
        const bandH = Math.max(6, Math.round(p.height * 0.022));
        const pass = Math.max(0.6, D / 3);
        const keys = [];
        for (let i = 0; i * pass < D + pass; i++) {
          const a = r3(i * pass), b = r3(Math.min(D, i * pass + pass * 0.92));
          if (a >= D) break;
          keys.push(K(a, [p.width / 2, p.height + bandH]));
          keys.push(K(b, [p.width / 2, -bandH], "hold"));
        }
        layers.push(solidLayer(doc, "head switch", [210, 214, 230, 255], p.width, bandH, {
          blend: "add",
          transform: {
            anchor: [p.width / 2, bandH / 2],
            position: anim(...keys),
            scale: [100, 100], rotation: 0, opacity: 14,
          },
        }));
      }

      const tape = blankLayer(doc, "adjustment", { name: "tape" });
      tape.effects = [
        fx("hueSaturation", { hue: 0, saturation: -p.desaturate, lightness: 3 }),
        // Washed blacks and a clipped white are what a VHS transfer actually
        // does to the range, and it is most of the look before any grain.
        fx("levels", { channel: "rgb", inBlack: 0, inWhite: 246, gamma: 1.06, outBlack: 16, outWhite: 244 }),
        fx("wave", {
          direction: "horizontal", wavelength: 520, phase: 0, speed: 2.5,
          waveType: "sine", edgeBehavior: "clamp",
          // The wobble is not steady — tape drifts, catches, drifts again.
          amplitude: anim(
            K(0, r3(p.wobble * 0.06), "easeInOut"), K(r3(D * 0.25), r3(p.wobble * 0.3), "easeInOut"),
            K(r3(D * 0.5), r3(p.wobble * 0.08), "easeInOut"), K(r3(D * 0.72), r3(p.wobble * 0.24), "easeInOut"),
            K(D, r3(p.wobble * 0.1)),
          ),
        }),
        fx("chromaticAberration", { amount: p.aberration, type: "linear", angle: 0, centerX: 50, centerY: 50 }),
        fx("scanlines", { spacing: 3, thickness: 55, darkness: p.scanlines, offset: 0, rollSpeed: p.rollSpeed, softness: 40, vertical: false, affectAlpha: false }),
        fx("noise", { amount: p.grain, type: "gaussian", mono: true, seed: 11, animate: true, size: 1 }),
      ];
      layers.push(tape);

      const base = sourceLayer(doc, p.clip, "footage", ctx, { fallback: [70, 74, 86, 255] });
      if (!p.clip) {
        base.effects = [fx("ramp", {
          type: "linear", startX: 0, startY: 0, endX: 100, endY: 0,
          startColor: [200, 200, 60], endColor: [40, 60, 180], opacity: 100, mode: "normal",
        })];
      }
      layers.push(base);
      return layers;
    },
  },
};

/* ────────────────────────────────────────────────────── the public API */

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

export function getTemplate(id) {
  const spec = TEMPLATES[String(id ?? "")];
  if (!spec) {
    throw new Error(`No template called "${id}". There are ${TEMPLATE_IDS.length}: ${TEMPLATE_IDS.join(", ")}.`);
  }
  return spec;
}

/** The full parameter set of a template: its own, plus the comp's. */
export function paramsOf(id) {
  const spec = getTemplate(id);
  return {
    ...COMMON,
    duration: { ...COMMON.duration, default: spec.duration },
    bg: { ...COMMON.bg, default: spec.bg },
    ...spec.params,
  };
}

/** Every template, small enough for a tool description or a picker. */
export function listTemplates() {
  return TEMPLATE_IDS.map((id) => {
    const spec = TEMPLATES[id];
    return {
      id, label: spec.label, why: spec.why,
      duration: spec.duration, minDuration: spec.minDuration,
      params: Object.fromEntries(Object.entries(paramsOf(id)).map(([k, v]) => [k, {
        type: v.type,
        default: v.auto ? `auto (${v.autoDesc})` : v.default,
        range: v.type === "number" ? `${v.min}..${v.max}` : undefined,
        options: v.options,
        desc: v.desc,
      }])),
    };
  });
}

/**
 * One flat block of prose describing every template and every parameter.
 *
 * This is what the MCP tool's description carries: an agent has to pick a
 * template and fill it in without reading this file, and a description
 * generated from the same table it validates against cannot drift from it.
 */
export function describeTemplates() {
  return TEMPLATE_IDS.map((id) => {
    const spec = TEMPLATES[id];
    const own = Object.entries(spec.params).map(([k, v]) => {
      const range = v.type === "number" ? ` ${v.min}..${v.max}` : "";
      const opts = v.options ? ` (${v.options.join("|")})` : "";
      const def = v.auto ? `auto: ${v.autoDesc}` : JSON.stringify(v.default);
      return `${k}: ${v.type}${range}${opts}, default ${def}`;
    });
    return `${id} — ${spec.why}\n    default ${spec.duration}s (minimum ${spec.minDuration}s). Parameters: ${own.join("; ")}.`;
  }).join("\n  ");
}

/**
 * Every parameter, checked and filled in — the shape `build` is handed.
 *
 * Separate from buildTemplate because the route needs the validated SOURCE
 * names before it can build anything: it has to look them up in the library and
 * probe them, and the answer to "did the caller give me a legal name" belongs
 * to one validator, not two.
 */
export function validateParams(id, params = {}) {
  const spec = getTemplate(id);
  const specs = paramsOf(id);

  if (params && typeof params === "object") {
    for (const k of Object.keys(params)) {
      if (!(k in specs)) {
        throw new Error(`${id} has no parameter "${k}". It takes: ${Object.keys(specs).join(", ")}.`);
      }
    }
  }

  // Pass one: the comp's own shape, because every auto default is a fraction of
  // it and cannot be computed before it is known.
  const p = {};
  for (const k of ["width", "height", "fps", "duration"]) {
    p[k] = coerce(id, k, specs[k], params?.[k]);
  }
  if (p.duration < spec.minDuration) {
    throw new Error(
      `${id}.duration must be at least ${spec.minDuration}s — its animation does not fit in ${p.duration}s.`,
    );
  }
  for (const [k, s] of Object.entries(specs)) {
    if (k in p) continue;
    const v = coerce(id, k, s, params?.[k]);
    p[k] = (v === null || v === undefined) && s.auto ? s.auto(p) : v;
  }
  return p;
}

/** Which parameters of a template name a library source, and what they hold. */
export function sourcesOf(id, params = {}) {
  const p = validateParams(id, params);
  return Object.entries(paramsOf(id))
    .filter(([, s]) => s.type === "source")
    .map(([k, s]) => ({ param: k, name: p[k] || null, kind: s.kind === "image" ? "image" : sourceKind(p[k]) }))
    .filter((r) => r.name);
}

/**
 * Build one template into a complete comp document, §1.
 *
 * Nothing is written and nothing is resolved: the caller persists this and the
 * caller turns library names into paths. `ctx.probe` is an optional
 * { name: { width, height, duration, fps } } — see the file header for why.
 */
export function buildTemplate(id, params = {}, ctx = {}) {
  const spec = getTemplate(id);
  const p = validateParams(id, params);

  const name = (p.name && String(p.name).trim()) || spec.label;
  const doc = blankComp(name, {
    width: p.width, height: p.height, fps: p.fps, duration: p.duration,
    bg: (p.bg || spec.bg).slice(),
  });
  doc.slug = slugify(name);
  doc.layers = spec.build(doc, p, ctx || {});
  doc.template = id;                      // a breadcrumb: what this comp grew from
  return finalize(doc, id);
}

/**
 * Last gate before the document leaves this file.
 *
 * Every keyed property goes through the store's own normaliser — the SAME code
 * the routes run on a hand-written keyframe — so a template that emits keys out
 * of order or an ease that does not exist fails here, at build time, with the
 * property named. The alternative is a comp that saves cleanly and renders
 * wrong, which is the one failure nobody traces back to a template.
 */
export function finalize(doc, id = "template") {
  if (doc.layers.length > LIMITS.layers) {
    throw new Error(`${id} built ${doc.layers.length} layers; a comp holds at most ${LIMITS.layers}.`);
  }
  const ids = new Set();
  for (const l of doc.layers) {
    if (ids.has(l.id)) throw new Error(`${id}: two layers share the id ${l.id}.`);
    ids.add(l.id);
    if (l.end > doc.duration + 1e-6 || l.start < -1e-6 || l.end <= l.start) {
      throw new Error(`${id}: layer "${l.name}" has a window of ${l.start}..${l.end}s in a ${doc.duration}s comp.`);
    }
    if (l.effects.length > LIMITS.effectsPerLayer) {
      throw new Error(`${id}: layer "${l.name}" has ${l.effects.length} effects; the limit is ${LIMITS.effectsPerLayer}.`);
    }
    for (const [k, arity] of Object.entries(TRANSFORM_ARITY)) {
      const v = l.transform[k];
      if (isKeyed(v)) {
        l.transform[k] = { keys: normalizeKeys(v.keys, { arity, label: `${id}: ${l.name}.transform.${k}` }) };
      }
    }
    for (const f of l.effects) {
      for (const [k, v] of Object.entries(f.params)) {
        if (isKeyed(v)) {
          f.params[k] = { keys: normalizeKeys(v.keys, { label: `${id}: ${l.name}.${f.type}.${k}` }) };
        }
      }
    }
    for (const m of l.masks || []) {
      for (const k of MASK_PROPS) {
        if (isKeyed(m[k])) m[k] = { keys: normalizeKeys(m[k].keys, { arity: 1, label: `${id}: ${l.name}.mask.${k}` }) };
      }
    }
  }
  for (const l of doc.layers) {
    if (l.parent && !ids.has(l.parent)) throw new Error(`${id}: layer "${l.name}" is parented to a layer that is not in the comp.`);
  }
  // §1's rule: a track matte uses the layer DIRECTLY ABOVE, so index 0 cannot
  // have one — it would be a switch that renders as nothing.
  doc.layers.forEach((l, i) => {
    if (l.trackMatte && i === 0) throw new Error(`${id}: the top layer "${l.name}" asks for a track matte and has nothing above it.`);
  });
  doc.markers = (doc.markers || [])
    .filter((m) => Number(m.t) >= 0 && Number(m.t) <= doc.duration)
    .sort((a, b) => a.t - b.t);
  return doc;
}
