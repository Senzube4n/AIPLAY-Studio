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

/* Every kind the compositor can actually draw. Anything not on this list is
 * coerced to "solid" by migrateLayer, which is the right answer for a typo and
 * the WRONG one for a real layer kind that simply was not added here: shape,
 * camera and comp layers each rendered correctly in the engine and were turned
 * into white rectangles the moment the document was read back. Add the kind
 * here in the same commit that teaches the engine to draw it. */
export const LAYER_TYPES = ["image", "video", "solid", "text", "shape",
                            "adjustment", "null", "camera", "comp", "light",
                            /* Sound-only source. Paints nothing — engine.py
                             * skips it exactly like null/camera/light — but a
                             * movie render mixes its file into the soundtrack.
                             * Absent from this list it would load as a white
                             * solid, the exact bug this comment block is
                             * about. */
                            "audio"];

/* The layer kinds that can carry sound into a movie render: an audio layer's
 * file, a video layer's own audio track, and a comp layer's child mix. One
 * list, because resolvePropPath, layerProperties and the engine's mixer must
 * agree on where `audioLevels` is legal. */
export const AUDIO_KINDS = ["audio", "video", "comp"];

/** audioLevels' advisory range in dB. 0 is unity; the engine clamps to this. */
export const AUDIO_LEVELS_RANGE = [-48, 12];

/* Lights. The engine side is lights.py, whose CATALOG is the one authority on
 * labels, defaults and descriptions; what is mirrored here is the minimum the
 * store needs to answer "can this path be keyframed and at what arity" without
 * a python round trip. KINDS/FALLOFFS pin lights.py's own lists; a document
 * value outside them repairs the way an unknown blend mode does. */
export const LIGHT_KINDS = ["ambient", "point", "spot", "parallel"];
export const LIGHT_FALLOFFS = ["none", "smooth", "inverseSquare"];

/* The ANIMATABLE light parameters — arity is what a keyframe's `v` must match,
 * range is advisory (the engine clamps) and mirrors lights.py's catalog so the
 * enumerator can still answer when the python catalog is unreachable. `kind`,
 * `falloff` and `castsShadows` are switches, deliberately absent: they are not
 * animatable in AE either and are set through set_layer { light: {...} }. */
export const LIGHT_PROP_SPEC = {
  color:            { arity: 3, range: [0, 255] },
  intensity:        { arity: 1, range: [-1000, 1000] },
  radius:           { arity: 1, range: [0, 1000000] },
  falloffDistance:  { arity: 1, range: [0, 1000000] },
  coneAngle:        { arity: 1, range: [0, 180] },
  coneFeather:      { arity: 1, range: [0, 100] },
  shadowDarkness:   { arity: 1, range: [0, 100] },
  shadowDiffusion:  { arity: 1, range: [0, 200] },
  pointOfInterest:  { arity: 3, range: null },
};

/* Which of those each kind actually READS (lights.py's entry() param sets).
 * Offering coneAngle on a point light would be a value that is stored,
 * returned, and read by no render — the dead control this file refuses. */
export const LIGHT_KIND_PARAMS = {
  ambient:  ["color", "intensity"],
  point:    ["color", "intensity", "radius", "falloffDistance",
             "shadowDarkness", "shadowDiffusion"],
  spot:     ["color", "intensity", "radius", "falloffDistance",
             "pointOfInterest", "coneAngle", "coneFeather",
             "shadowDarkness", "shadowDiffusion"],
  parallel: ["color", "intensity", "pointOfInterest",
             "shadowDarkness", "shadowDiffusion"],
};

/* AE's material options — what a 3D layer does with light that reaches it.
 * The numeric four animate (lights.py marks them animatable); the three flags
 * do not and go through set_layer { material: {...} }. Fallbacks are AE's own
 * defaults, which lights.py::material() also applies. */
export const MATERIAL_PROP_SPEC = {
  ambient:   { arity: 1, range: [0, 100], fallback: 100 },
  diffuse:   { arity: 1, range: [0, 100], fallback: 50 },
  specular:  { arity: 1, range: [0, 100], fallback: 50 },
  shininess: { arity: 1, range: [0, 100], fallback: 5 },
};

/* The layer kinds that have no surface to shade — material.* is refused there. */
export const UNSHADEABLE = ["light", "camera", "null", "audio"];

/* ─────────────────────────────────────────────────────────── the lens, §1
 *
 * CAMERAS, and why this table is a straight copy of LIGHT_PROP_SPEC above.
 *
 * The engine side is engine.py::camera_from, which binds EVERY one of these
 * under "camera.<name>" (`_bind(cctx, layer, "camera")`, then `cam("zoom")`,
 * `cam("pointOfInterest")` …) and pushes each through `interp.eval_prop`. So
 * every one of them already keyframes and already takes an expression in the
 * render — an expression-aimed camera renders byte-for-byte identically to a
 * hardcoded point of interest. The lens was nonetheless the only major layer
 * family in the compositor with NO animatable property at all: a spot light
 * enumerated nine rows and a camera enumerated zero, because nothing on this
 * side of the wall could name one. Its own docstring said so.
 *
 * `arity` is what a keyframe's `v` must match; `range` is advisory (the engine
 * clamps, and set_layer used to enforce exactly these numbers) and is mirrored
 * here so the enumerator can answer without a python round trip — the same
 * contract LIGHT_PROP_SPEC has.
 *
 * depthOfField is HERE, where lights' booleans (kind, falloff, castsShadows)
 * are deliberately absent, and the difference is not the type: lights.py reads
 * `bool(src.get("castsShadows", False))` RAW, so keying it would be a stored
 * value no render reads, while engine.py runs depthOfField through
 * `interp.eval_prop` like every other lens field. A hold key on it cuts focus
 * in mid-shot, which is a real move. It stays a plain boolean in the document
 * when it is written as one — see mergeCamera — and only becomes 0/1 when
 * somebody actually keyframes it.
 */
export const CAMERA_PROP_SPEC = {
  zoom:             { arity: 1, range: [1, 100000] },
  focalLength:      { arity: 1, range: [1, 5000] },
  pointOfInterest:  { arity: 3, range: null },
  depthOfField:     { arity: 1, range: [0, 1] },
  aperture:         { arity: 1, range: [0, 1000] },
  focusDistance:    { arity: 1, range: [1, 100000] },
  blurLevel:        { arity: 1, range: [0, 1000] },
};

/* ONE LENS, TWO SPELLINGS — the one place cameras genuinely differ from lights.
 *
 * `zoom` is the focal length in PIXELS and `focalLength` is the same lens in
 * millimetres on 36mm film; engine.py:2402 converts one into the other exactly
 * (`zoom = cw * focal / FILM_MM`, verified: focalLength 24 and zoom 1280 render
 * identically on a 1920-wide comp). They are not two properties, they are two
 * views of one number — and the engine reads them with a PRECEDENCE, not a sum:
 *
 *     zoom = eval(spec["zoom"])
 *     if zoom <= 0:                     # only then
 *         zoom = cw * eval(spec["focalLength"] or 50) / 36
 *
 * So a document holding both has one of them dead: keyframe the focal length of
 * a camera that already carries a zoom and the render never looks at your keys.
 * That is the dead control this file exists to refuse.
 *
 * The rule, therefore: a camera's lens has exactly ONE live spelling, and which
 * one it is behaves like `light.kind` — a switch that decides which parameters
 * resolve, changed through set_layer, never by keyframing. `cameraLens()` reads
 * it off the document the same way the engine does; `CAMERA_LENS_PARAMS` is the
 * literal analogue of `LIGHT_KIND_PARAMS`; resolvePropPath refuses the other
 * spelling naming the fix, and layerProperties enumerates only the live one.
 * A camera with no `zoom` at all is a focalLength camera, because that is the
 * branch engine.py takes for it (falling back to DEFAULT_FOCAL_MM = 50mm).
 */
export const CAMERA_LENS_PARAMS = {
  zoom:        ["zoom", "pointOfInterest", "depthOfField",
                "aperture", "focusDistance", "blurLevel"],
  focalLength: ["focalLength", "pointOfInterest", "depthOfField",
                "aperture", "focusDistance", "blurLevel"],
};

/** Labels for the enumerator. lights.py's catalog supplies a light's; there is
 *  no python catalog for the lens, so the words live here. */
export const CAMERA_PROP_LABELS = {
  zoom: "Zoom", focalLength: "Focal Length", pointOfInterest: "Point of Interest",
  depthOfField: "Depth of Field", aperture: "Aperture",
  focusDistance: "Focus Distance", blurLevel: "Blur Level",
};

/* What the engine falls back to when a field is absent, so a stopwatch seeds
 * from the value the render is actually using. Only the CONSTANT ones are
 * listed: zoom falls back to a comp-width-derived number, focusDistance falls
 * back to whatever the zoom came out as, and pointOfInterest has no fallback at
 * all — its ABSENCE is the meaningful state (engine.py leaves the rotation at
 * identity, i.e. the camera is free and aimed by its own rotationX/Y/Z). */
export const CAMERA_PROP_FALLBACK = {
  focalLength: 50,      // engine.py DEFAULT_FOCAL_MM
  depthOfField: false,
  aperture: 25,
  blurLevel: 100,
};

/**
 * Which spelling of the lens this camera actually uses, by engine.py's own
 * rule: zoom wins whenever it evaluates positive, otherwise focalLength does.
 * Read, never written — the switch happens in set_layer's camera merge.
 */
export function cameraLens(layer) {
  const cam = layer && typeof layer.camera === "object" ? layer.camera : null;
  if (!cam) return "focalLength";
  const z = Number(evalProp(cam.zoom, 0));
  return Number.isFinite(z) && z > 0 ? "zoom" : "focalLength";
}

/**
 * Which spelling the lens will be in ONCE `patch` lands — the decision the
 * camera merge has to make before it writes anything at all.
 *
 * WHY THIS IS A SEPARATE FUNCTION, and the bug it exists to close. The merge
 * used to retire the outgoing spelling FIRST and resolve each value after, so
 * mid-call the camera held NEITHER — and `cameraLens()`, reading the document
 * the way engine.py does, then answered "focalLength" for a camera that had no
 * focalLength in it. Every write in that call was held against a lens nothing
 * was written in, so switching a millimetre camera back to pixels was refused
 * by the very call that was performing the switch, with a message naming a
 * field the document did not contain. A camera can be given a lens it has
 * never had — a fresh one, one carrying only depth-of-field settings, one being
 * converted back — so the target spelling has to be decided from the PAYLOAD
 * and the document together, once, and everything else held against that.
 *
 * `null` is the explicit retire: it hands the lens to the OTHER spelling (the
 * merge converts the value as it goes) rather than leaving the camera with no
 * live lens, which is not a state this document has a reading for.
 */
export function cameraLensAfter(layer, patch = {}) {
  const p = (patch && typeof patch === "object") ? patch : {};
  const cam = (layer && typeof layer.camera === "object" && layer.camera) || null;
  const namesZoom = p.zoom !== undefined && p.zoom !== null;
  const namesFocal = p.focalLength !== undefined && p.focalLength !== null;

  if (namesZoom && namesFocal) {
    throw new Error(
      "camera.zoom and camera.focalLength are one lens said two ways — px and mm on 36mm film — "
      + "and engine.py reads focalLength only when zoom is unset, so giving both leaves one of "
      + "them dead. Give one.",
    );
  }
  if (p.zoom === null && p.focalLength === null) {
    throw new Error(
      "Retiring both spellings at once would leave the camera with no lens at all. Retire one — "
      + "the lens moves to the other spelling, converted, so the shot is unchanged — or give one "
      + "of them a value.",
    );
  }
  if (namesZoom) return "zoom";
  if (namesFocal) return "focalLength";
  /* A retire only moves the lens if there is something to retire; asking to
   * drop a spelling the camera never had is a no-op, not a switch. */
  if (p.focalLength === null && cam?.focalLength !== undefined) return "zoom";
  if (p.zoom === null && cam?.zoom !== undefined) return "focalLength";
  return cameraLens(layer);
}

/** §2. The first ten already exist in imagetools.py::_blend; the engine extends it. */
export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "softlight", "hardlight", "add",
  "subtract", "difference", "darken", "lighten", "colordodge", "colorburn",
  "hue", "saturation", "color", "luminosity",
  /* AE's stencil and silhouette transfer modes. These are not blends at all —
   * engine.py:2402 branches on them BEFORE compositing and uses the layer to
   * cut everything beneath it in the same group. They were missing here, so a
   * layer set to one came back as "normal" and hand-editing the JSON did not
   * work either. Kept in sync with STENCIL_MODES at engine.py:474. */
  "stencilAlpha", "stencilLuma", "silhouetteAlpha", "silhouetteLuma",
];

export const EASES = ["linear", "hold", "easeIn", "easeOut", "easeInOut"];
export const MATTE_TYPES = ["alpha", "luma", "alphaInv", "lumaInv"];
export const MASK_MODES = ["add", "subtract", "none"];

/* AE's auto-orient, a per-layer SWITCH like threeD — not animatable (it is not
 * in AE either), so it is deliberately absent from layerProperties and
 * resolvePropPath. "alongPath" turns the layer to face along its position
 * track's motion; the layer's own rotation then composes ON TOP as an offset,
 * which is AE's rule. "towardCamera" is NOT on this list on purpose: the
 * camera is picked per frame downstream of where layer matrices are built (a
 * camera's own parent chain and the light rig both need matrices before any
 * camera exists), and a billboard under a rotated parent needs the parent's
 * rotation inverted back out — a wrong 3D orientation rendered silently is
 * worse than the refusal the routes give it. */
export const AUTO_ORIENT_MODES = ["off", "alongPath"];

/**
 * Layer label colours — AE's sixteen, by name, plus "none". A NAME rather than
 * a hex so the document reads as intent ("the plates are all aqua") and so the
 * UI owns the exact swatch; the engine never reads this field — a label is
 * organisation, not pixels, exactly as it is in AE.
 */
export const LABEL_COLORS = [
  "none", "red", "yellow", "aqua", "pink", "lavender", "peach", "seafoam",
  "blue", "green", "purple", "orange", "brown", "fuchsia", "cyan",
  "sandstone", "darkgreen",
];

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
  guides: 100,
};

/** Arity of every transform property — what a keyframe's `v` has to match. */
export const TRANSFORM_ARITY = { anchor: 2, position: 2, scale: 2, rotation: 1, opacity: 1 };

/* Animatable properties that hang off the layer itself rather than off its
 * transform. timeRemap is a time in the SOURCE, in seconds; the rotations are
 * degrees about each 3D axis and do nothing until the layer is threeD.
 * audioLevels is gain in dB (see AUDIO_LEVELS_RANGE), read by the render-time
 * audio mixer on audio/video/comp layers — resolvePropPath refuses it
 * elsewhere, because a solid holding a level would be stored, returned, and
 * heard by nobody. */
export const LAYER_PROP_ARITY = { timeRemap: 1, audioLevels: 1 };

/* The 3D axes live INSIDE the transform — engine.py:1604 reads
 * transform.get("rotationX"). They were briefly resolved onto the layer, where
 * the engine never looks: the property took the value, the document kept it,
 * and the render ignored it. */
const TRANSFORM_3D = { rotationX: 1, rotationY: 1, rotationZ: 1 };

/* On a 3D layer these three take an optional [x, y, z]. Both lengths are legal
 * — the engine defaults a missing z — so the arity is left UNSTATED there
 * rather than pinned to 3, and the caller is not refused for writing either. */
const VECTOR_TRANSFORM = new Set(["anchor", "position", "scale"]);

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
let idSeq = 0;
export const newId = (prefix, n = 4) => {
  /* Random AND unique. The randomness is the point above — a removed name can
   * never be handed back. But four hex characters is only 65,536 of them, and
   * a template that mints a dozen layers plays birthday odds every time: the
   * templates suite collided on `ly_` about once in 53 runs (measured), which
   * is a test that randomly fails other people's commits. The counter makes a
   * repeat impossible within a process without giving up unpredictability, and
   * it cannot saturate the way widening alone still could. */
  idSeq = (idSeq + 1) % 0xFFFFFF;
  const rand = randomUUID().replace(/-/g, "").slice(0, n);
  return `${prefix}_${rand}${idSeq.toString(36)}`;
};

/* ───────────────────────────────────────────────────────────── linear light
 *
 * ONE WORDING, so the tool description an agent reads, the tooltip a person
 * reads and the spec all say the same thing. server/vfx/colour.py is the
 * implementation and engine.py's header is the full contract.
 *
 * DEFAULT OFF, INCLUDING ON A NEW COMP, and the reason is not timidity:
 *
 *  - Every template in templates.js and every preset in this repo was tuned by
 *    eye in gamma. Defaulting new comps ON would change what all of them make
 *    while leaving their files untouched — a template that renders differently
 *    from the one it was built against is worse than a template that is off.
 *  - The correction is PARTIAL by design. The OVER composite and the opacity
 *    lerp still run on codes, so an additive layer at partial opacity is only
 *    partly fixed — and "partly" is not "half": at 50% opacity the picture
 *    MOVES half as far, while the error against a fully linear pipeline falls
 *    by about a third, and on a quarter of the channels measured it lands
 *    further out than it started (two errors that were cancelling stop
 *    cancelling). Shipping that as the default makes the remaining half harder
 *    to see, not easier.
 *  - It is not free: about 110 ms per converted run at 1080p, which is MORE
 *    than the glow it wraps.
 *
 * WHAT WOULD CHANGE IT: moving the compositor's OVER into linear too. At that
 * point the correction is whole, the argument above collapses, and this becomes
 * the default with a document migration behind it.
 */
export const LINEAR_LIGHT_DESC =
  "Do the operations that are physically LIGHT in linear light instead of on "
  + "sRGB code values. Blurs, glows and the add/screen blend modes average or "
  + "sum photons, and photons add linearly — a 50/50 mix of black and white is "
  + "code 128 done the usual way and code 188 done properly, and 188 is what a "
  + "camera actually records. That 60-code gap is the muddy halo on a glow "
  + "built the wrong way round. It also fixes 3D lighting, where the diffuse "
  + "multiply and the specular add were summing light on code values — 24 "
  + "codes off on a mid-grey surface's diffuse multiply; a lit 3D layer moves "
  + "about 12 codes mean and 31 at its worst pixel, a strongly lit one 18 and "
  + "63. A glow's own controls move with the pixels: the swatch you picked is "
  + "the colour the halo emits (leaving it behind rendered a pure orange "
  + "[255,128,0] as [255,188,0]) and the threshold selects the same pixels it "
  + "did in gamma (leaving it behind cut half of them). "
  + "IT APPLIES TO PRECOMPS TOO: a nested comp that has never been given a "
  + "setting of its own INHERITS this one. Set it explicitly on the child — on "
  + "or off — and the child wins, so a precomp you approved in gamma is not "
  + "re-rendered by a switch turned on upstairs. "
  + "WHAT IT DOES NOT DO: colour effects (curves, levels, hue, tint) are LOOK "
  + "controls drawn against code values and are left alone; lighten and darken "
  + "are provably identical in both spaces; the add/screen COMPOSITE MODE "
  + "inside an effect (fill, ramp, checkerboard, grid lines, fractal noise, "
  + "four-colour gradient, particle system) stays in gamma, unlike the layer "
  + "blend of the same name; and the OVER composite and layer opacity still "
  + "mix on codes, so "
  + "an ADD or SCREEN layer at partial opacity is only partly corrected — the "
  + "move halves at 50% opacity, but the error against a fully linear pipeline "
  + "falls by about a third rather than a half, and on a quarter of the "
  + "channels measured it lands further out than leaving the switch off did. "
  + "Not HDR, not wide gamut, not ACES, not LUTs, no "
  + "display transform, and it reads no colour profile off your footage. "
  + "Costs about 110ms a frame at 1080p for each run of blurs and glows it "
  + "converts, which is a little MORE than the glow it wraps. "
  + "Off by default, and turning it on CHANGES EVERY FRAME of an existing comp "
  + "— it is a different (and more correct) render, not a free upgrade.";

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
    /* OFF ON A NEW COMP TOO, which is a decision and not an oversight — see
     * LINEAR_LIGHT_DESC below for the reason and for what would change it.
     * EXPLICITLY off, not absent: absent means INHERIT (a precomp follows the
     * comp that contains it), and a comp made from this function has said
     * nothing about being nested. Somebody who wants a precomp to follow its
     * parent asks for that — the toolbar's third state, or `linear_light: null`
     * from an agent. */
    linearLight: false,
    layers: [],                            // layers[0] is the TOP of the stack
    markers: [],
    guides: [],                            // [{ axis: "x"|"y", position }] — comp px; "x" = a vertical line
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
    shy: false,           // hidden from the timeline when the comp hides shy layers;
    label: "none",        // still renders. `label` is a LABEL_COLORS name.
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
  // A shape layer with no items draws nothing, which reads as a broken layer.
  // One visible rounded rectangle says "this worked, now edit it".
  if (type === "shape") {
    layer.shapes = [
      { type: "rect", size: [400, 240], position: [0, 0], roundness: 16 },
      // 0-255. shapes.py reads colour as 0-255 and says so in its catalog; the
      // 0-1 triple this used to hold is a legal colour that happens to be very
      // nearly black, so the placeholder drew perfectly and was invisible.
      { type: "fill", color: [89, 184, 242] },
    ];
  }
  if (type === "camera") {
    layer.camera = { zoom: 1778, depthOfField: false, aperture: 25, focusDistance: 1778 };
    layer.threeD = true;
  }
  if (type === "light") {
    /* lights.py's own defaults, written out so the document says what the
     * render will do instead of leaving every field to engine fallbacks. The
     * position gets the engine's "home" z — the default camera's distance —
     * because a light at z=0 sits IN the plane of an untouched 3D layer and
     * lights nothing, which reads as a broken feature. */
    layer.light = {
      kind: "point", color: [255, 255, 255], intensity: 100,
      falloff: "none", radius: 500, falloffDistance: 500,
      coneAngle: 90, coneFeather: 50, pointOfInterest: [cx, cy, 0],
      castsShadows: false, shadowDarkness: 100, shadowDiffusion: 0,
    };
    layer.transform.position = [cx, cy, -Math.round(comp.width * 50 / 36)];
  }
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
/* A transform component: [x, y] or, on a 3D layer, [x, y, z]. It was written
 * as length === 2 only, which meant an authored [x, y, z] failed the test and
 * took the fallback — so a 3D layer did not merely lose its z, it had x and y
 * reset to the comp centre on every load. VFX_SPEC §1 makes the third
 * component optional, so both arities are valid and neither is padded here:
 * the engine already defaults a missing z (0 for anchor/position, 100 for
 * scale) and it, not the store, owns that choice.
 *
 * Number.isFinite(Number(n)) alone was not enough of a test: Number(null) is 0,
 * as are Number(""), Number(false) and Number([]). JSON cannot carry NaN — it
 * writes null — so a position that went out as [100, NaN] came back as
 * [100, null] and loaded as [100, 0], teleporting the layer to the top of the
 * frame instead of being rejected. isNum() insists on an actual number or a
 * non-blank numeric string. */
const isNum = (n) =>
  (typeof n === "number" || (typeof n === "string" && n.trim() !== ""))
  && Number.isFinite(Number(n));

const pair = (v, fallback) =>
  Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(isNum)
    ? v.map(Number) : (isAnimated(v) ? v : fallback.slice());

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
  /* Timeline housekeeping, not pixels: whether the timeline hides shy layers.
   * Normalised here so it round-trips as an honest boolean. */
  doc.hideShy = !!doc.hideShy;
  /* Linear light, and it is TRI-STATE — the one field on this document that
   * has a third state, so it is the one place `!!x` would be wrong.
   *
   *   absent / null   INHERIT: a precomp takes the setting of the comp that
   *                   contains it, and at the top of the tree there is no
   *                   parent, so it renders OFF. That is every document
   *                   written before this field existed, and the whole
   *                   byte-identity story: it loads with nothing to say, the
   *                   engine's `_linear_light` resolves it to OFF, and not one
   *                   line of the render path behaves differently from the day
   *                   the file was saved.
   *   true / false    EXPLICIT, and a parent cannot overrule it. A precomp
   *                   approved in gamma keeps rendering in gamma inside a
   *                   linear parent.
   *
   * `!!doc.linearLight` was here first and collapsed the three states to two:
   * every load stamped an explicit `false` onto documents that had never said
   * anything, so nothing could ever inherit and the third state was
   * unreachable by construction. The absence is DELETED rather than kept as
   * null so the document reads as it always did — one fewer key, not a null. */
  if (doc.linearLight === undefined || doc.linearLight === null) delete doc.linearLight;
  else doc.linearLight = !!doc.linearLight;
  if (!Array.isArray(doc.markers)) doc.markers = [];
  doc.markers = doc.markers
    .filter((m) => m && Number.isFinite(Number(m.t)))
    .map((m) => ({ t: Number(m.t), label: String(m.label ?? "") }));
  /* Guides are DOCUMENT state — a guide marks a place in the composition, and
   * it must survive a reload and travel with the comp, exactly as AE saves
   * guides in the project. axis "x" is a VERTICAL line at x=position, "y" a
   * HORIZONTAL one at y=position, both in comp pixels. Repaired like markers:
   * a hand-edited entry with a nonsense axis or a non-finite position is
   * dropped, a position outside the raster is clamped onto it (there is no
   * pasteboard to show it in), and the field always round-trips as an array.
   * Normalised FIELD-BY-FIELD, never by rebuilding the doc — a rebuild from a
   * key list is how five fields have been silently erased in this repo. */
  if (!Array.isArray(doc.guides)) doc.guides = [];
  doc.guides = doc.guides
    .filter((g) => g && (g.axis === "x" || g.axis === "y") && isNum(g.position))
    .map((g) => ({
      axis: g.axis,
      position: clamp(Number(g.position), 0, g.axis === "x" ? doc.width : doc.height),
    }));
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
  /* Both survive a load field-for-field — migrateLayer normalises in place and
   * a field it does not name is kept, but these are NAMED so a typo'd label
   * repairs to "none" instead of shipping as a colour the UI cannot draw. */
  l.shy = !!l.shy;
  l.label = LABEL_COLORS.includes(l.label) ? l.label : "none";
  /* Only normalised when PRESENT — an absent switch means "off" to the engine,
   * and stamping "off" onto every 2D title would be noise in the document, the
   * same argument the 3D rotation axes make below. A value the engine would
   * not recognise (a typo, or a hand-written "towardCamera") repairs to "off"
   * rather than shipping as a mode the render silently ignores. */
  if (l.autoOrient !== undefined) {
    l.autoOrient = AUTO_ORIENT_MODES.includes(l.autoOrient) ? l.autoOrient : "off";
  }
  /* A light's spec survives FIELD-FOR-FIELD (it is not named in a rebuild —
   * the five-erasures lesson), but the two enums repair like blend modes do:
   * lights.py falls back to point/none anyway, and a document that says
   * "spott" while the render does "point" is a document that lies. */
  if (l.light !== undefined) {
    if (!l.light || typeof l.light !== "object") l.light = {};
    if (l.light.kind !== undefined && !LIGHT_KINDS.includes(l.light.kind)) l.light.kind = "point";
    if (l.light.falloff !== undefined && !LIGHT_FALLOFFS.includes(l.light.falloff)) l.light.falloff = "none";
  }
  /* A camera's lens survives FIELD-FOR-FIELD too — pointOfInterest, blurLevel,
   * every keyed value — for exactly the reason the light spec does: this pass
   * has erased five fields by rebuilding, and a rigged camera is the newest
   * thing on the list. The ONE repair is the same one the light enums get: a
   * document that carries BOTH spellings of the lens is a document that lies,
   * because engine.py:2402 reads only one of them (zoom when it is positive,
   * focalLength otherwise) and the other is a control the render never looks
   * at. add_layer used to accept both in one call, so such documents exist.
   * Keep the live one, drop the dead one. */
  if (l.camera !== undefined) {
    if (!l.camera || typeof l.camera !== "object") l.camera = {};
    if (l.camera.zoom !== undefined && l.camera.focalLength !== undefined) {
      if (cameraLens(l) === "zoom") delete l.camera.focalLength;
      else delete l.camera.zoom;
    }
    /* The same repair where there is nothing beside it: a plain zoom that is
     * not positive is one engine.py:2402 skips, so the camera renders on the
     * focalLength branch while the document shows a pixel lens. Such documents
     * exist — set_prop reached camera.zoom with no positivity guard on it —
     * and left in place they are the state where the lens has no live
     * spelling at all. A keyed or expression-driven zoom is left alone: what
     * it is worth is a question about time, not about this load. */
    const z = l.camera.zoom;
    if (z !== undefined && (typeof z === "number" || typeof z === "string") && !(Number(z) > 0)) {
      delete l.camera.zoom;
    }
  }

  const t = (l.transform && typeof l.transform === "object") ? l.transform : {};
  const cx = doc.width / 2, cy = doc.height / 2;
  /* REBUILT, not merged — so every key absent from this list is deleted from
   * the document on load. The engine reads EIGHT keys off a transform and this
   * preserved five, which is how the three 3D rotation axes were being erased
   * from every comp on every read. If the engine learns another transform
   * property, it has to appear here in the same commit. */
  l.transform = {
    anchor: pair(t.anchor, [cx, cy]),
    position: pair(t.position, [cx, cy]),
    scale: pair(t.scale, [100, 100]),
    rotation: isAnimated(t.rotation) ? t.rotation : num(t.rotation, 0),
    opacity: isAnimated(t.opacity) ? t.opacity : num(t.opacity, 100),
  };
  // Only carried when present: an absent axis means 0 to the engine, and
  // writing three explicit zeroes onto every 2D layer would be noise in the
  // document and a lie in the UI about which layers are 3D.
  for (const axis of ["rotationX", "rotationY", "rotationZ"]) {
    if (t[axis] !== undefined) {
      l.transform[axis] = isAnimated(t[axis]) ? t[axis] : num(t[axis], 0);
    }
  }

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
    feather: isAnimated(m.feather) ? m.feather : num(m.feather, 0),
    opacity: isAnimated(m.opacity) ? m.opacity : num(m.opacity, 100),
    invert: !!m.invert,
    expand: isAnimated(m.expand) ? m.expand : num(m.expand, 0),
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
    /* MONOTONIC, not just current. This stamp is the frame cache's
     * invalidation key, and Date.now() has millisecond resolution — two edits
     * landing in the same millisecond mint the same stamp, so a frame rendered
     * from the first is served for the second. The writes are serialised per
     * slug so they cannot overlap, but they can certainly finish inside one
     * millisecond, and a stale pixel reaching a user is the worst failure this
     * subsystem has. Found by the agent that built the RAM preview, in a file
     * it correctly would not edit. */
    next.updatedAt = Math.max(Date.now(), (doc.updatedAt || 0) + 1);
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

/** A property carrying an expression: `{ expr: "wiggle(2,30)", value: [960,540] }`.
 *  `value` is what it falls back to and what the expression reads as `value`. */
export const hasExpr = (v) =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof v.expr === "string" && !!v.expr.trim();

/** Keep this property rather than flattening it to a number. An expression-only
 *  property has no `keys`, so testing for keys alone deleted it on load — the
 *  sandbox could have been switched on and still seen nothing. */
export const isAnimated = (v) => isKeyed(v) || hasExpr(v);

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
/**
 * Every animatable property on a layer, keyed or not.
 *
 * The timeline tree and `vfx_layer_properties` both read this, which is the
 * point: a tree that showed a property MCP could not name, or an MCP tool that
 * offered one the tree never drew, is the drift this codebase has shipped six
 * times. One answer, two surfaces.
 *
 * `catalogs` optionally carries `{ effects, shapes }` — the python-side
 * registries — so effect and shape-item parameters can be enumerated with
 * their real labels and ranges. Without it those groups are simply absent
 * rather than guessed at: a wrong range is worse than a missing one, because
 * it is accepted and renders wrong.
 *
 * Every `path` is the spelling resolvePropPath ANSWERS with, so what a caller
 * reads here is what set_prop takes.
 */
export function layerProperties(layer, catalogs = {}) {
  if (!layer || typeof layer !== "object") return [];
  const out = [];
  const fx = catalogs.effects || null;
  const shp = catalogs.shapes || null;

  const push = (path, label, group, arity, value, extra = {}) => {
    out.push({
      path, label, group,
      arity: arity ?? null,
      animated: isKeyed(value),
      expr: hasExpr(value) ? value.expr : null,
      // The concrete value at t=0, so a tree can show a number before anything
      // is keyed. evalProp is the JS mirror; it cannot run an expression, and
      // returns the value underneath instead — which is what to show.
      value: value === undefined ? null : evalProp(value, 0),
      ...extra,
    });
  };

  const tr = layer.transform || {};
  const LABELS = { anchor: "Anchor Point", position: "Position", scale: "Scale",
                   rotation: "Rotation", opacity: "Opacity" };
  for (const k of ["anchor", "position", "scale", "rotation", "opacity"]) {
    const arity = (layer.threeD && (k === "anchor" || k === "position" || k === "scale"))
      ? null : TRANSFORM_ARITY[k];
    push(`transform.${k}`, LABELS[k], "Transform", arity, tr[k]);
  }
  // Only on a 3D layer: offering an axis that renders nothing is the kind of
  // dead control this whole exercise is about removing.
  if (layer.threeD) {
    for (const k of ["rotationX", "rotationY", "rotationZ"]) {
      push(`transform.${k}`, `${k.slice(-1)} Rotation`, "Transform", 1, tr[k]);
    }
  }
  if (layer.timeRemap !== undefined || layer.type === "video" || layer.type === "comp") {
    push("timeRemap", "Time Remap", "Time", 1, layer.timeRemap);
  }
  /* Only where the mixer will read it — offering a level on a solid would be
   * a dead control, the exact thing this enumerator exists to prevent. The
   * fallback is 0 dB (unity): an unset level is not silence. */
  if (AUDIO_KINDS.includes(layer.type)) {
    push("audioLevels", "Audio Levels", "Audio", 1, layer.audioLevels,
         { range: AUDIO_LEVELS_RANGE.slice(), fallback: 0 });
  }

  /* Light parameters, on light layers only, and only the ones the CURRENT
   * kind reads — the same rule resolvePropPath enforces, so what this lists
   * is exactly what set_prop takes. Labels and ranges come from lights.py's
   * catalog when the routes hand it in (catalogs.lights); without it the
   * mirrored LIGHT_PROP_SPEC ranges answer, so the group never goes dark. */
  if (layer.type === "light") {
    const lkind = LIGHT_KINDS.includes(layer.light?.kind) ? layer.light.kind : "point";
    const lcat = catalogs.lights?.lights?.[lkind] || null;
    for (const name of LIGHT_KIND_PARAMS[lkind]) {
      const spec = LIGHT_PROP_SPEC[name];
      const p = lcat?.params?.[name];
      push(`light.${name}`, `${lcat?.label || `${lkind} light`} · ${name}`, "Light",
           spec.arity, layer.light?.[name],
           { range: p && p.min !== undefined ? [p.min, p.max]
               : (spec.range ? spec.range.slice() : null),
             kind: p?.type || null, fallback: p?.default });
    }
  }

  /* Lens parameters, on camera layers only, and only the spelling of the lens
   * this camera actually uses — the same rule resolvePropPath enforces, so
   * what this lists is exactly what set_prop takes. The nine rows a spot light
   * has had all along; a camera had none of them, which is why nothing in the
   * timeline or in vfx_layer_properties could offer a rack focus, an animated
   * focal length, or a point of interest parked on a null. */
  if (layer.type === "camera") {
    const lens = cameraLens(layer);
    for (const name of CAMERA_LENS_PARAMS[lens]) {
      const spec = CAMERA_PROP_SPEC[name];
      push(`camera.${name}`, `Camera · ${CAMERA_PROP_LABELS[name] || name}`, "Camera",
           spec.arity, layer.camera?.[name],
           { range: spec.range ? spec.range.slice() : null,
             kind: name === "depthOfField" ? "bool" : null,
             fallback: CAMERA_PROP_FALLBACK[name] });
    }
  }

  /* Material options — only where a light could actually reach them: a 3D
   * layer with a surface. lights.py's material entry supplies labels and
   * defaults when the catalog is in hand. */
  if (layer.threeD && !UNSHADEABLE.includes(layer.type)) {
    const mcat = catalogs.lights?.lights?.material || null;
    for (const name of Object.keys(MATERIAL_PROP_SPEC)) {
      const p = mcat?.params?.[name];
      push(`material.${name}`, `Material · ${p?.label || name}`, "Material", 1,
           layer.material?.[name],
           { range: MATERIAL_PROP_SPEC[name].range.slice(),
             fallback: p?.default ?? MATERIAL_PROP_SPEC[name].fallback });
    }
  }

  for (const e of layer.effects || []) {
    const spec = fx?.[e.type] || null;
    const label = spec?.label || e.type;
    const params = spec?.params ? Object.keys(spec.params) : Object.keys(e.params || {});
    for (const name of params) {
      const p = spec?.params?.[name];
      if (p && p.animatable === false) continue;
      push(`effects.${e.id}.${name}`, `${label} · ${p?.label || name}`, "Effects",
           null, (e.params || {})[name],
           { effectId: e.id, effectType: e.type, param: name,
             range: p && p.min !== undefined ? [p.min, p.max] : null,
             options: p?.options || null, kind: p?.type || null,
             fallback: p?.default });
    }
  }

  for (const m of layer.masks || []) {
    for (const k of MASK_PROPS) {
      push(`masks.${m.id}.${k}`, `${m.id} · ${k}`, "Masks", 1, m[k], { maskId: m.id });
    }
  }

  /* Shape items nest, and the path is the walk — the same spelling engine.py
   * builds for an expression on the same property. */
  if (Array.isArray(layer.shapes)) {
    const walk = (items, prefix, trail) => {
      items.forEach((it, i) => {
        if (!it || typeof it !== "object") return;
        const here = `${prefix}.${i}`;
        const name = it.name || it.type;
        if (Array.isArray(it.items)) { walk(it.items, `${here}.items`, `${trail}${name} · `); return; }
        const spec = shp?.[it.type] || null;
        const params = spec?.params ? Object.keys(spec.params) : Object.keys(it);
        for (const k of params) {
          if (k === "type" || k === "name") continue;
          const p = spec?.params?.[k];
          if (p && p.animatable === false) continue;
          push(`${here}.${k}`, `${trail}${spec?.label || name} · ${p?.label || k}`,
               "Shape", null, it[k],
               { range: p && p.min !== undefined ? [p.min, p.max] : null,
                 options: p?.options || null, kind: p?.type || null,
                 fallback: p?.default });
        }
      });
    };
    walk(layer.shapes, "shapes", "");
  }

  return out;
}


/**
 * `opts.lens` — the spelling of the lens to hold a `camera.*` path against.
 *
 * Normally the resolver reads it off the document (`cameraLens`), which is
 * right for every door that is not itself changing it. The camera merge IS
 * changing it, and mid-switch the document is precisely the wrong authority:
 * see `cameraLensAfter`. So the one caller that has already made the decision
 * passes it in, and every value in that call is resolved and coerced against
 * the same answer.
 */
export function resolvePropPath(layer, rawPath, opts = {}) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) throw new Error(`Give a property path, for example "transform.position".`);
  const parts = raw.split(".");

  // The one alias worth keeping: §1 lists `opacity` as animatable and every
  // human calls it that, but it lives inside transform.
  if (parts.length === 1 && parts[0] === "opacity") parts.unshift("transform");

  /* Properties that live directly on the layer rather than inside transform.
   * timeRemap is a curve whose VALUE is a time in the source; the rotations
   * are the 3D axes. All four keyframe like anything else, and all four were
   * refused here — so time remapping could be evaluated but never authored. */
  if (parts.length === 1 && parts[0] in LAYER_PROP_ARITY) {
    const key = parts[0];
    /* v1 of the audio mix does not scrub sound through a remap curve, and a
     * remapped picture over unremapped audio would be a lie — so an audio
     * layer cannot take the curve at all. A video layer still can: the render
     * refuses its AUDIO (naming the fix) while the picture remaps. */
    if (key === "timeRemap" && layer.type === "audio") {
      throw new Error(
        "An audio layer cannot be time-remapped — v1 renders remapped pictures but does not "
        + "scrub audio through a remap curve. Trim with start/end/inPoint, or retime with timeScale.",
      );
    }
    if (key === "audioLevels" && !AUDIO_KINDS.includes(layer.type)) {
      throw new Error(
        `audioLevels lives on the layers that can carry sound (${AUDIO_KINDS.join(", ")}) — `
        + `${layer.id} is a ${layer.type} layer.`,
      );
    }
    return { owner: layer, key, path: key, arity: LAYER_PROP_ARITY[key], kind: "layer" };
  }

  // "rotationX" is the name a person says; transform.rotationX is where it
  // lives. Same shorthand `opacity` already gets.
  if (parts.length === 1 && parts[0] in TRANSFORM_3D) parts.unshift("transform");

  if (parts[0] === "transform" && parts.length === 2) {
    const key = parts[1];
    if (!(key in TRANSFORM_ARITY) && !(key in TRANSFORM_3D)) {
      throw new Error(`No transform property "${key}". It is one of: ${[...Object.keys(TRANSFORM_ARITY), ...Object.keys(TRANSFORM_3D)].join(", ")}.`);
    }
    if (key in TRANSFORM_3D) {
      return { owner: layer.transform, key, path: `transform.${key}`, arity: 1, kind: "transform" };
    }
    const arity = (layer.threeD && VECTOR_TRANSFORM.has(key)) ? null : TRANSFORM_ARITY[key];
    return { owner: layer.transform, key, path: `transform.${key}`, arity, kind: "transform" };
  }

  /* Light parameters, in the engine's own spelling — lights.py binds
   * "light.intensity", "light.coneAngle" and so on, and _one_light evaluates
   * every one through interp, so a key written here animates in the render.
   * Only the params the CURRENT kind reads resolve: a coneAngle held by a
   * point light would be stored, returned, and read by no render. */
  if (parts[0] === "light" && parts.length === 2) {
    const key = parts[1];
    if (layer.type !== "light") {
      throw new Error(`light.* lives on light layers — ${layer.id} is a ${layer.type} layer.`);
    }
    if (!(key in LIGHT_PROP_SPEC)) {
      if (["kind", "falloff", "castsShadows"].includes(key)) {
        throw new Error(`light.${key} is a switch, not an animatable property — set it with set_layer { light: { ${key} } }.`);
      }
      throw new Error(`No light property "${key}". Animatable ones: ${Object.keys(LIGHT_PROP_SPEC).join(", ")}.`);
    }
    const lkind = LIGHT_KINDS.includes(layer.light?.kind) ? layer.light.kind : "point";
    if (!LIGHT_KIND_PARAMS[lkind].includes(key)) {
      throw new Error(
        `A ${lkind} light does not read ${key} — its parameters are `
        + `${LIGHT_KIND_PARAMS[lkind].join(", ")}. Change the kind first: set_layer { light: { kind } }.`,
      );
    }
    if (!layer.light || typeof layer.light !== "object") layer.light = {};
    return { owner: layer.light, key, path: `light.${key}`, arity: LIGHT_PROP_SPEC[key].arity, kind: "light" };
  }

  /* The lens, in the engine's own spelling — engine.py::camera_from binds
   * "camera.zoom", "camera.pointOfInterest", "camera.focusDistance" and the
   * rest and evaluates every one through interp, so a key written here moves
   * the lens in the render. This branch is the light branch above with the
   * nouns changed, including the rule that only the parameters the CURRENT
   * configuration reads resolve: for a light that is its kind, for a camera it
   * is which of the two spellings of the lens is live (see CAMERA_LENS_PARAMS).
   * A focalLength keyed onto a camera that carries a zoom would be stored,
   * returned, and read by no render. */
  if (parts[0] === "camera" && parts.length === 2) {
    const key = parts[1];
    if (layer.type !== "camera") {
      throw new Error(`camera.* lives on camera layers — ${layer.id} is a ${layer.type} layer.`);
    }
    if (!(key in CAMERA_PROP_SPEC)) {
      throw new Error(`No camera property "${key}". Animatable ones: ${Object.keys(CAMERA_PROP_SPEC).join(", ")}.`);
    }
    const lens = (opts.lens === "zoom" || opts.lens === "focalLength")
      ? opts.lens : cameraLens(layer);
    if (!CAMERA_LENS_PARAMS[lens].includes(key)) {
      const cam = (layer.camera && typeof layer.camera === "object") ? layer.camera : null;
      /* SAY WHAT THE DOCUMENT ACTUALLY HOLDS. A camera with no lens field at
       * all is a real and common state — one carrying only depth-of-field
       * settings, one a template shipped, one whose lens was just retired —
       * and engine.py renders it at DEFAULT_FOCAL_MM, which is the focalLength
       * branch. Telling its owner the lens "is written as focalLength" when
       * there is no focalLength anywhere in the document is a sentence they
       * cannot act on and cannot verify. */
      const holds = cam && cam[lens] !== undefined;
      throw new Error(
        `This camera's lens ${holds ? `is written as ${lens}`
          : `is unset, which engine.py renders as ${lens === "focalLength"
              ? `the default ${CAMERA_PROP_FALLBACK.focalLength}mm — the focalLength branch`
              : "a zoom"}`}, so ${key} is dead on it — they are one lens `
        + `said two ways (px and mm) and engine.py reads focalLength only when zoom is unset. `
        + `Switch spelling first: set_layer { camera: { ${key} } }`
        + `${holds ? `, which retires ${lens}` : ""}.`,
      );
    }
    if (!layer.camera || typeof layer.camera !== "object") layer.camera = {};
    /* The rules this property carries BEYOND its arity, handed to whoever
     * writes it so that every door inherits them from the one table rather
     * than from whichever door somebody remembered — see checkProp in
     * routes.js. `positive` is the one-lens rule itself: engine.py:2402 hands
     * the lens to the other spelling the moment this value is not positive. */
    return {
      owner: layer.camera, key, path: `camera.${key}`,
      arity: CAMERA_PROP_SPEC[key].arity, kind: "camera", lens,
      range: CAMERA_PROP_SPEC[key].range,
      positive: key === "zoom" || key === "focalLength",
    };
  }

  /* Material options — lights.py binds "material.diffuse" etc. and evaluates
   * them per frame, so the numeric four keyframe. Refused where no light can
   * reach: a kind with no surface, or a 2D layer (lights only touch threeD). */
  if (parts[0] === "material" && parts.length === 2) {
    const key = parts[1];
    if (UNSHADEABLE.includes(layer.type)) {
      throw new Error(`A ${layer.type} layer has no surface to shade — material.* lives on 3D pixel layers.`);
    }
    if (!(key in MATERIAL_PROP_SPEC)) {
      if (["acceptsLights", "castsShadows", "acceptsShadows"].includes(key)) {
        throw new Error(`material.${key} is a switch, not an animatable property — set it with set_layer { material: { ${key} } }.`);
      }
      throw new Error(`No material property "${key}". Animatable ones: ${Object.keys(MATERIAL_PROP_SPEC).join(", ")}.`);
    }
    if (!layer.threeD) {
      throw new Error(`Materials only mean anything on a 3D layer — set threeD: true on ${layer.id} first.`);
    }
    if (!layer.material || typeof layer.material !== "object") layer.material = {};
    return { owner: layer.material, key, path: `material.${key}`, arity: 1, kind: "material" };
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

  /* A parameter inside a shape layer's item tree.
   *
   * The spelling mirrors engine.py's _expr_props, which builds
   * `shapes.<i>.<key>` and descends a group as `shapes.<i>.items.<j>.<key>`.
   * That is the path an expression on the same property already reports
   * itself by, so walking it the same way makes the two agree by construction
   * — the effect-param path and the 3D rotations both drifted precisely
   * because each side worked its own spelling out separately.
   *
   * A numeric segment indexes a list, anything else is a key, which is all the
   * shape tree ever is. */
  if (parts[0] === "shapes" && parts.length >= 3) {
    if (!Array.isArray(layer.shapes)) {
      throw new Error(`${layer.id} is a ${layer.type} layer, not a shape layer — it has no shape items.`);
    }
    let node = layer.shapes;
    const walked = ["shapes"];
    /* The nearest enclosing ITEM and the residual path under it, carried on
     * the ref so the routes can hold the final key against the shape catalog
     * (the catalog lives behind an async python read this sync walk cannot
     * make itself). An item is a non-array object carrying "type" — or
     * "items", shapes.py's group shorthand. */
    let itemNode = null;
    let itemSub = [];
    for (let i = 1; i < parts.length - 1; i++) {
      const seg = parts[i];
      const idx = /^\d+$/.test(seg) ? Number(seg) : null;
      const next = idx === null ? node?.[seg] : node?.[idx];
      if (next === undefined || next === null || typeof next !== "object") {
        const had = Array.isArray(node)
          ? `it holds ${node.length} item(s)`
          : `it has ${Object.keys(node || {}).join(", ") || "nothing"}`;
        throw new Error(`No shape item at "${walked.join(".")}.${seg}" — ${had}.`);
      }
      walked.push(seg);
      node = next;
      if (!Array.isArray(next) && (next.type !== undefined || next.items !== undefined)) {
        itemNode = next;
        itemSub = [];
      } else if (itemNode) {
        itemSub.push(seg);
      }
    }
    const key = parts[parts.length - 1];
    if (Array.isArray(node)) {
      throw new Error(`"${walked.join(".")}" is a list of items — name one by index, then the parameter, e.g. ${walked.join(".")}.0.${key}.`);
    }
    /* An unset parameter is legal: shapes.py falls back to its catalog default,
     * exactly as an effect param does, so a path naming one is answered rather
     * than refused. The arity comes from whatever is there now. */
    const cur = node[key];
    const concrete = cur === undefined ? undefined : evalProp(cur, 0);
    return {
      owner: node, key,
      path: `${walked.join(".")}.${key}`,
      arity: Array.isArray(concrete) ? concrete.length : (concrete === undefined ? null : 1),
      kind: "shape",
      itemType: itemNode
        ? String(itemNode.type ?? (itemNode.items !== undefined ? "group" : "")) : null,
      subPath: itemSub,
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
    + `effects.<fxId>.<param>, masks.<maskId>.<feather|opacity|expand>, `
    + `transform.rotationX/Y/Z, shapes.<i>.<param> (or shapes.<i>.items.<j>.<param>), `
    + `light.<param> on a light layer, camera.<param> on a camera layer, `
    + `material.<param> on a 3D layer, `
    + `or one of ${Object.keys(LAYER_PROP_ARITY).join(", ")}.`,
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
  if (isKeyed(prop)) return prop.keys[0]?.v ?? 0;
  // An expression's `value` IS its constant — it is what the expression reads
  // as `value` and what it falls back to. Returning the wrapper object here
  // would make every arity check downstream compare against an object.
  if (hasExpr(prop)) return prop.value ?? 0;
  return prop;
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
  /* This is the JS MIRROR of the evaluator, for the UI. It cannot run an
   * expression — that sandbox is Python, in the engine — so it shows what the
   * property would be without one: its keys if it has them, else its value.
   * Better a slightly stale preview than "[object Object]" on a slider. */
  if (hasExpr(prop) && !isKeyed(prop)) return prop.value ?? 0;
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
    /* REBUILT from a fixed set, so anything omitted here is discarded — on
     * the way in AND on every subsequent load. interp.py reads three more
     * fields off a key and documents them in its header: "to" and "ti" are
     * AE's spatial tangent handles (offsets from the key's own value, so they
     * carry the property's arity), and "roving" lets an interior key take
     * whatever time keeps the speed even. All three were stripped, which left
     * interp carrying machinery nothing could reach. */
    const out = { t, v, ...(k.ease === undefined || k.ease === null ? {} : { ease: normalizeEase(k.ease, label) }) };
    for (const h of ["to", "ti"]) {
      if (k[h] === undefined || k[h] === null) continue;
      const tan = normalizeValue(k[h], { label: `${label} key ${i} ${h}` });
      if (arityOf(tan) !== n) {
        throw new Error(`${label}: key ${i} "${h}" has ${arityOf(tan)} number(s) but the value has ${n}. A tangent is an offset from the value, so it matches it.`);
      }
      out[h] = tan;
    }
    // Only an INTERIOR key can rove: the ends are the anchors it roves between.
    if (k.roving) out.roving = true;
    return out;
  });
  out.sort((a, b) => a.t - b.t);
  /* resolve_roving anchors on the first and last key, so a roving flag there
   * has nothing to rove between. Dropping it quietly would be the very fault
   * this block exists to fix, so it is refused. */
  for (const edge of [0, out.length - 1]) {
    if (out[edge]?.roving) {
      throw new Error(`${label}: the first and last keyframes cannot rove — they are the anchors the roving keys move between.`);
    }
  }
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

/* ─────────────────────────── FXPRESETS: the effect/animation preset shelf ──
 *
 * APP-LEVEL, one JSON beside the comp folders: <outputDir>/vfx/_fx_presets.json
 * — the same decision the image editor made for _presets.json and _swatches.json,
 * and for the same reason: server-side is what lets MCP and the UI see the SAME
 * shelf. A preset is a named snapshot of a layer's effect stack (params,
 * keyframes, expressions) and optionally its keyframed transform move.
 *
 * THE TIME RULE: keyframe times in a stored preset are RELATIVE SECONDS, zero
 * at the SOURCE layer's `start` (its in-point on the comp timeline). Chosen
 * over "zero at the first key" so a move authored to land 0.4s after the layer
 * cuts in still lands 0.4s after the NEW layer cuts in — and so a preset with
 * no keys at t=0 does not silently slide everything earlier. A key that sat
 * before the layer's start stores a negative time and comes back the same way.
 *
 * Writes go through the same single-writer chain the comps use, keyed by a
 * name no slug can collide with (slugify never emits an underscore), and land
 * via write-temp-then-rename like every other document here.
 */

const FX_PRESETS_KEY = "_fx_presets";
const fxPresetsPath = () => path.join(VFX_DIR(), "_fx_presets.json");

export const FX_PRESET_LIMITS = { presets: 200, nameLen: 60, noteLen: 300 };

/**
 * The starter shelf — data in the same format a save writes, seeded on first
 * read. Every effect type and parameter below is in the CURRENT catalog
 * (server/vfx/effects.py), which is what makes these living documentation:
 * the e2e applies them, so a catalog rename breaks a test instead of a user.
 * Colours are 0-255. Times are relative seconds (see the time rule above).
 */
function builtinFxPresets() {
  const now = Date.now();
  const mk = (note, effects, transform) => ({
    builtin: true, note, effects,
    ...(transform ? { transform } : {}),
    createdAt: now, updatedAt: now,
  });
  return {
    "Film Look (built-in)": mk(
      "Glow + living grain + vignette — a quick filmic grade for any plate.",
      [
        { type: "glow", enabled: true, params: { threshold: 70, radius: 32, intensity: 90, softness: 25 } },
        { type: "addGrain", enabled: true, params: { intensity: 35, size: 1.2, saturation: 15 } },
        { type: "vignette", enabled: true, params: { amount: 45, softness: 60 } },
      ]),
    "Flicker Glow (built-in)": mk(
      "A glow whose intensity breathes over one second — a KEYED effect parameter, times relative to the layer's start.",
      [
        { type: "glow", enabled: true, params: {
          threshold: 55, radius: 40,
          intensity: { keys: [{ t: 0, v: 60, ease: "easeInOut" }, { t: 0.5, v: 220, ease: "easeInOut" }, { t: 1, v: 60 }] },
        } },
      ]),
    "Greenscreen Starter (built-in)": mk(
      "Chroma key + matte choke: pull the screen colour, then firm up the edge. Tune the key colour to your plate first.",
      [
        { type: "chromaKey", enabled: true, params: { color: [0, 255, 0], tolerance: 25, softness: 10, despill: true } },
        { type: "matteChoke", enabled: true, params: { amount: -1, feather: 1.5, blackClip: 5, whiteClip: 95 } },
      ]),
    "Fade-Scale In (built-in)": mk(
      "The animation-preset half: no effects at all, just a keyframed entrance — opacity 0→100 and scale 80→100 over 0.8s.",
      [],
      {
        opacity: { keys: [{ t: 0, v: 0, ease: "easeOut" }, { t: 0.8, v: 100 }] },
        scale: { keys: [{ t: 0, v: [80, 80], ease: "easeOut" }, { t: 0.8, v: [100, 100] }] },
      }),
  };
}

/** The raw shelf document, or null when the file does not exist yet. A file
 *  that exists but does not parse is an ERROR, never silently reseeded — the
 *  reseed would overwrite somebody's saved presets to fix a trailing comma. */
async function readFxDoc() {
  let text;
  try {
    text = await readFile(fxPresetsPath(), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new Error(`Could not read the preset shelf (${fxPresetsPath()}): ${err.message}`);
  }
  let doc;
  try { doc = JSON.parse(text); } catch (err) {
    throw new Error(`The preset shelf (${fxPresetsPath()}) is not valid JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== "object" || !doc.presets || typeof doc.presets !== "object") {
    throw new Error(`The preset shelf (${fxPresetsPath()}) does not hold a { presets } object.`);
  }
  return doc;
}

async function writeFxDoc(doc) {
  await mkdir(VFX_DIR(), { recursive: true });
  const tmp = fxPresetsPath() + `.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(doc, null, 1), "utf8");
  await rename(tmp, fxPresetsPath());
  return doc;
}

/** The shelf, seeding the built-ins on first read (the file being absent). */
export async function readFxPresets() {
  return enqueue(FX_PRESETS_KEY, async () => {
    const doc = await readFxDoc();
    if (doc) return doc;
    return writeFxDoc({ v: 1, presets: builtinFxPresets(), updatedAt: Date.now() });
  });
}

/**
 * Read-mutate-write on the shelf, atomically against every other shelf writer.
 * `fn` mutates the document in place (or returns a replacement; `false`
 * abandons the write). updatedAt bumps monotonically, same rule as the comps.
 */
export async function updateFxPresets(fn) {
  return enqueue(FX_PRESETS_KEY, async () => {
    const doc = (await readFxDoc()) ?? { v: 1, presets: builtinFxPresets(), updatedAt: Date.now() };
    const out = await fn(doc);
    if (out === false) return doc;
    const next = out && typeof out === "object" ? out : doc;
    next.updatedAt = Math.max(Date.now(), (doc.updatedAt || 0) + 1);
    return writeFxDoc(next);
  });
}

/**
 * A deep copy of a property value with every keyframe time shifted by `dt`
 * seconds. Constants and plain values come back as plain deep copies; an
 * expression wrapper keeps its expr and value. Times are rounded at the
 * microsecond so repeated save/apply round trips cannot accumulate float dust.
 */
export function shiftPropTimes(v, dt) {
  const out = JSON.parse(JSON.stringify(v));
  if (isKeyed(out)) {
    out.keys = out.keys.map((k) => ({ ...k, t: Math.round((Number(k.t) + dt) * 1e6) / 1e6 }));
  }
  return out;
}

/**
 * FXPRESETS merge rule — PASTE SEMANTICS, the way AE pastes keyframes: the
 * incoming keys own the closed time range they cover, so existing keys inside
 * that range (±1ms) are replaced and keys outside it survive. A constant
 * property simply becomes the pasted animation; an expression already sitting
 * on the property stays on top, reading the merged keys as `value`.
 * `keys` must already be normalized (times absolute, on the comp timeline).
 */
export function pastePresetKeys(cur, keys) {
  const lo = Math.min(...keys.map((k) => Number(k.t))) - 1e-3;
  const hi = Math.max(...keys.map((k) => Number(k.t))) + 1e-3;
  const outside = isKeyed(cur)
    ? cur.keys.filter((k) => Number(k.t) < lo || Number(k.t) > hi)
    : [];
  const merged = normalizeKeys([...outside, ...keys], { label: "preset keys" });
  return hasExpr(cur) ? { ...cur, keys: merged } : { keys: merged };
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
