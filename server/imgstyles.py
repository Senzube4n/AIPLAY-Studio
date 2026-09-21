"""Photoshop's ten layer styles, on a STILL — the door the picture editor never had.

`server/vfx/engine.py` implements all ten and paints them in Photoshop's order
(engine.STYLE_ORDER). Until this file they were reachable ONLY from a layer
DOCUMENT (`server/imgdoc.py`): `grep styles server/imagetools.py` returned zero,
so a person in the Photoshop-style editing window — the window this app's users
actually open — could not double-click a layer and get a bevel. The whole
implementation existed and had no door onto the surface it belongs to.

    apply_styles(rgba, styles, matte=None, notes=None, global_light=None) -> rgba
    apply_style_op(rgba, spec, notes=None) -> rgba      # the ops-shaped entry

    rgba    float32 (H, W, 4), 0..1, STRAIGHT (un-premultiplied) alpha
    styles  { "<name>": {...params}, ... } as imgdoc.STYLE_CATALOG declares
            them, or a list of {"style": name, ...params} for callers that
            prefer a list. `enabled: false` turns one off without deleting it.
    matte   float32 (H, W) 0..1 — THE SHAPE THE STYLES ARE APPLIED TO. This is
            the argument the whole module is about; see below.
    return  the same shape as float32; the input is never written to.

⚠ THE HARD PART IS NOT THE STYLES. IT IS WHAT THEY ARE APPLIED *TO*.

In a document a style has a LAYER, and the layer's alpha is the shape: the
bevel bevels that edge, the glow glows around it, the overlay stops at it. A
PHOTOGRAPH HAS ALPHA 1 EVERYWHERE. Run the styles on it directly and you get
one of two failures, both measured on a 128x128 opaque plate at default
parameters, neither of which raises anything:

    stroke, outerGlow, dropShadow      max change 0.0000  — silent no-op
    patternOverlay, gradientOverlay,
    colorOverlay, satin, innerGlow,
    innerShadow, bevelEmboss           max change 0.15..0.60 — paints the
                                       WHOLE PICTURE, edge to edge

A control that appears to work and does nothing, and a control that appears to
work and repaints everything. So the matte has to come from somewhere, and in
the still pipeline there are three real sources:

  1. A SELECTION — the same `{shapes:[...]}` spec `imgselect.resolve` already
     answers. This is the natural equivalent of "the layer", and it is what
     Photoshop's own "layer via copy" does before you style anything.
  2. THE PICTURE'S OWN ALPHA, when it is a cutout (`image_cutout` makes these).
     A bevel on a cutout is exactly what people reach for.
  3. The alpha of TEXT or SHAPES drawn in the same pass. Not wired yet — which
     is why `matte` is an explicit argument rather than something this module
     resolves privately: stage 9 can hand its own coverage straight in.

With no source at all and a fully opaque frame this REFUSES, in a sentence that
names both ways to give a style a shape. It does not render the no-op.

── THE TRAPS, each one measured on this rig ──────────────────────────────────

⚠ 1. STRAIGHT ALPHA, INSIDE THE MATTE. `imgstyles_test.py`'s docstring records
   the bug: two overlays set coverage to a constant across the whole buffer
   instead of multiplying by alpha, so they painted colour OUTSIDE the shape.
   With straight alpha that is invisible the moment it composites and wrong in
   the buffer, and anything premultiplying later finds colour outside the
   letterform. Every pin here measures OUTSIDE the shape, not only inside.

⚠ 2. ORDER IS NOT ALPHABETICAL AND IT IS NOT THE CALLER'S. STYLE_ORDER is
   Photoshop's stacking order and it is load-bearing: a drop shadow under a
   stroke is a different picture from a stroke under a drop shadow. Measured on
   three styles, forward vs reversed differs by 1.0 — the whole range. So the
   caller's dict order is DISCARDED and engine's order is used, and there is a
   pin that two callers writing the same styles in different orders get
   bit-identical results.

⚠ 3. THERE IS NO GLOBAL LIGHT, AND THE THREE LIT STYLES DO NOT AGREE.
   Photoshop shares one light angle between drop shadow, inner shadow and
   bevel. engine models nothing of the kind: each style reads its own `angle`,
   and the defaults are dropShadow 45, innerShadow 45, bevelEmboss 120 — so at
   defaults the sun is in two places. Worse, and measured by sweeping the
   angle on a 160x160 square:

       angle    dropShadow throw   innerShadow band   bevel highlight
         0            0                180                 180
        45          315                135                 225
        90          270                 90                 270
       180          180                  0                   0
       270           90                270                  90

   dropShadow and innerShadow are consistent with each other at every angle
   (band at 180-A, shadow thrown at -A: the band sits on the light side and the
   shadow falls away from it). bevelEmboss puts its highlight at 180+A — the
   MIRROR of the other two about the horizontal axis, because `_style_bevel_
   emboss` uses `ly = -sin(angle)` where `_style_inner_shadow` uses `dy =
   +sin(angle)`. The three coincide only at angle 0 and 180.

   This module cannot fix engine and does not try. `globalLight` here sets one
   angle for all three and NEGATES it for the bevel, so one number puts one sun
   in the sky; satin is deliberately excluded, because its angle is the
   direction a fold runs and not where the light is (engine's own docstring:
   "a shape effect, not a light one"). Without `globalLight` the per-style
   angles are passed through untouched and the disagreement above is yours.

⚠ 4. A STYLE THAT GROWS OUTSIDE THE FRAME IS CLIPPED, NOT GROWN. Three styles
   paint outside the matte — stroke (outside/center), outerGlow, dropShadow —
   and the buffer never changes size: a 40px glow on a shape flush to the left
   edge simply loses the half that had nowhere to go. Nothing raises. So when
   a growing style is on AND the matte touches the frame border, a note says
   so and names the fix: add canvas first (`ops.canvas`, stage 1) so the style
   has room, then style.

⚠ 5. A SELECTION THAT CAUGHT NOTHING IS A MASK OF ZEROS. `imgselect.resolve`
   is explicit that an empty shape list resolves to empty rather than to
   everything — the right call, and it means every style silently becomes a
   no-op. That is refused here rather than reported as a success.

⚠ 6. SEVEN OF THE TEN CARRY A NaN STRAIGHT THROUGH. Measured: one NaN in the
   input comes back as one NaN out of patternOverlay, gradientOverlay,
   colorOverlay, satin, innerGlow, innerShadow and bevelEmboss; the three that
   delegate to effects.py sanitise it. A NaN reaching the uint8 cast in
   imagetools becomes 0 with no complaint. So the input is scrubbed on the way
   in and the result is scrubbed and clipped on the way out.

⚠ 7. engine's `_apply_styles` PRINTS a failing style to stderr and carries on.
   That is right for a render that must not die at frame 4000 and wrong for a
   person who clicked a button: here a style that raises lands in `notes` and
   in the reply's `skipped` list, so the picture that comes back is explained.

── WHAT WAS ALREADY REACHABLE, HONESTLY ─────────────────────────────────────

`ops.effects` reaches the 88-effect registry, and SEVEN of the ten styles have
a rough equivalent there — not four. Measured on a matted plate, "follows the
matte" meaning it changed pixels inside the alpha and none outside it:

    dropShadow      effects.dropShadow      IDENTICAL — engine delegates to it
    stroke          effects.stroke          IDENTICAL — engine delegates to it
    outerGlow       effects.dropShadow      IDENTICAL at distance 0 (what a
                                            Photoshop outer glow is); effects.
                                            glow is a threshold bloom, a
                                            different look, and at defaults it
                                            changed NOTHING on this plate
    bevelEmboss     effects.bevelAlpha      rough: lights the matte's own edge,
                                            inside 0.087, outside 0.000
    colorOverlay    effects.fill            near-exact, and `stencil` is its
                                            DEFAULT mode
    gradientOverlay effects.ramp            near-exact with mode "stencil"
                                            (endpoints rather than an angle);
                                            at mode "normal" it replaces the
                                            whole frame, alpha and all
    patternOverlay  effects.checkerboard    partial with mode "stencil" — the
                                            checker only, no stripes, no dots

    innerShadow     — nothing in the registry
    innerGlow       — nothing in the registry
    satin           — nothing in the registry

So three are genuinely absent, not six. That correction does not shrink the
gap, it relocates it: every one of those equivalents follows THE PICTURE'S OWN
ALPHA, and in the still editor the picture is opaque, so all seven are exactly
the no-op-or-whole-frame pair this file opens with. The missing thing was never
the arithmetic. It was a shape to apply it to, and Photoshop's order to apply
them in.
"""
import json
import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))


class StyleError(ValueError):
    """A request that cannot be honoured as written. Raised, never swallowed:
    the failure this module exists to prevent is a control that reports success
    and changes nothing, so every path that would end in a no-op ends in a
    sentence instead."""


# ---------------------------------------------------------------------------
# the lazy guarded imports - a missing renderer means "no styles", never
# "no image", and nothing here may be imported at module scope: imgdoc pulls
# engine which pulls cv2, and imagetools is imported by the editor on boot.
# ---------------------------------------------------------------------------

def _engine():
    """The compositor, or None. Same guarded shape imagetools._effects_registry
    uses — this file is server/ and engine is server/vfx/, so the path goes on
    sys.path rather than the package being restructured for one import."""
    vfx = os.path.join(_HERE, "vfx")
    if vfx not in sys.path:
        sys.path.insert(0, vfx)
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    try:
        import engine                                   # noqa: PLC0415
        return engine
    except Exception:                                   # noqa: BLE001
        return None


def _imgdoc():
    """The document model, for its STYLE_CATALOG only. The per-style parameters
    are SPLICED from there rather than retyped here, the way imgdoc splices
    effects.CATALOG["ramp"] for its gradient layer: a second copy of a
    parameter list is the same bug with a delay on it."""
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    try:
        import imgdoc                                   # noqa: PLC0415
        return imgdoc
    except Exception:                                   # noqa: BLE001
        return None


def _imgselect():
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    try:
        import imgselect                                # noqa: PLC0415
        return imgselect
    except Exception:                                   # noqa: BLE001
        return None


# Photoshop's painting order, read off engine so the two cannot drift. The
# literal below is the import-less fallback AND the documented base set — it is
# asserted equal to engine's in the suite, so a style added on the other side
# fails a pin here rather than quietly painting in the wrong place.
STYLE_ORDER = ("patternOverlay", "gradientOverlay", "colorOverlay", "satin",
               "innerGlow", "innerShadow", "stroke",
               "outerGlow", "dropShadow", "bevelEmboss")


def style_order():
    """engine's order if engine is here, the literal above if it is not."""
    eng = _engine()
    order = getattr(eng, "STYLE_ORDER", None) if eng is not None else None
    return tuple(order) if order else STYLE_ORDER


# The three that paint OUTSIDE the matte, and therefore the three that can be
# thrown off the edge of the frame. Measured, not assumed: on a 128x128 plate
# at defaults these are the only styles whose alpha grew (stroke +808 px,
# outerGlow +14080, dropShadow +10017; the other seven grew none).
GROWS_ALPHA = ("stroke", "outerGlow", "dropShadow")

# The parameter each of those reaches outward by, so the edge warning can say
# how far rather than only that, and the reach at DEFAULTS — read off
# imgdoc.STYLE_CATALOG — for the caller who wrote `{}`.
#
# ⚠ The default is used only when the caller named NONE of the keys. A
# dropShadow written with size 0, spread 0 and distance 0 reaches nowhere, and
# warning about a clipped shadow that was never thrown is the same kind of lie
# as staying silent about one that was.
_REACH = {"stroke": ("size", "feather"), "outerGlow": ("size", "spread"),
          "dropShadow": ("size", "spread", "distance")}
_REACH_DEFAULT = {"stroke": 4.0, "outerGlow": 16.0, "dropShadow": 22.0}

# The three Photoshop drives from one global light. Satin is NOT here: its
# angle is which way a fold runs, not where the sun is. See trap 3 — the value
# is the multiplier applied to globalLight, and the bevel's -1 is the whole
# reason this key exists.
GLOBAL_LIGHT_STYLES = {"dropShadow": 1.0, "innerShadow": 1.0, "bevelEmboss": -1.0}

# An agent will guess these, and a guess that works is a round trip saved.
ALIASES = {
    "shadow": "dropShadow", "drop": "dropShadow", "drop_shadow": "dropShadow",
    "dropshadow": "dropShadow",
    "inner_shadow": "innerShadow", "innershadow": "innerShadow",
    "inner_glow": "innerGlow", "innerglow": "innerGlow",
    "glow": "outerGlow", "outer_glow": "outerGlow", "outerglow": "outerGlow",
    "bevel": "bevelEmboss", "emboss": "bevelEmboss",
    "bevel_emboss": "bevelEmboss", "bevelemboss": "bevelEmboss",
    "bevelAndEmboss": "bevelEmboss",
    "color": "colorOverlay", "colour": "colorOverlay",
    "colorOverLay": "colorOverlay", "colourOverlay": "colorOverlay",
    "color_overlay": "colorOverlay", "coloroverlay": "colorOverlay",
    "gradient": "gradientOverlay", "gradient_overlay": "gradientOverlay",
    "gradientoverlay": "gradientOverlay",
    "pattern": "patternOverlay", "pattern_overlay": "patternOverlay",
    "patternoverlay": "patternOverlay",
    "outline": "stroke", "border": "stroke",
    "sheen": "satin", "silk": "satin",
}


# ---------------------------------------------------------------------------
# the catalog - MCP and the UI are both generated from this
# ---------------------------------------------------------------------------

def num(default, lo, hi, desc, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi, "desc": desc}
    if unit:
        p["unit"] = unit
    return p


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "desc": desc}


# The DOOR's own parameters. The per-style parameters are not here — they are
# spliced from imgdoc.STYLE_CATALOG by catalog(), below.
CATALOG = {
    "styles": {
        "type": "object", "default": None,
        "desc": "the styles to paint, keyed by name — "
                '{"dropShadow": {"distance": 12}, "stroke": {"size": 4}}. A '
                "list of {\"style\": name, ...} is accepted too. The key order "
                "is IGNORED: Photoshop's stacking order is used, because a "
                "stroke under a shadow is a different picture from a shadow "
                "under a stroke.",
        "why": "ten styles, one order, and the order is not the one you typed",
    },
    "selection": {
        "type": "selection", "default": None,
        "desc": "an IMAGE_SPEC §3 selection spec, resolved by imgselect "
                "against the post-geometry frame. Its mask becomes the LAYER: "
                "the shape the bevel bevels and the glow glows around.",
        "why": "a photograph is opaque everywhere, so without this every style "
               "is a no-op or paints the whole frame",
    },
    "useAlpha": flag(False,
                     "take the matte from the picture's OWN alpha, for a "
                     "cutout. Refused on a fully opaque picture, where it "
                     "would mean 'the whole frame'."),
    "matte": {
        "type": "mask", "default": None,
        "desc": "a (H, W) 0..1 coverage array, for a caller holding the shape "
                "already — the text or shapes drawn in the same pass. Not "
                "reachable over the job door; it is the in-process argument "
                "stage 9 will use.",
        "why": "the third matte source, wired from python rather than JSON",
    },
    "globalLight": num(None, -360, 360,
                       "one light angle for dropShadow, innerShadow and "
                       "bevelEmboss, overriding any angle they did not set "
                       "themselves. NEGATED for the bevel, whose angle runs "
                       "the opposite way round the compass from the other two "
                       "— see the module docstring, trap 3. Satin is excluded: "
                       "its angle is a fold direction, not a light.",
                       unit="deg"),
}

GROUP_ORDER = ["Layer style"]


def catalog():
    """What MCP and /api/image/catalog serve for layer styles."""
    doc = _imgdoc()
    styles = dict(getattr(doc, "STYLE_CATALOG", {}) or {}) if doc is not None else {}
    eng = _engine()
    drawable = sorted(getattr(eng, "STYLES", {}) or {}) if eng is not None else []
    return {
        "op": "styles",
        "params": CATALOG,
        "styles": styles,
        # ⚠ SERVED, NOT SORTED. A UI that alphabetises this list and then
        # paints in the order it drew is the trap this whole module documents.
        "order": list(style_order()),
        "names": list(style_order()),
        "drawable": drawable,
        "growsAlpha": list(GROWS_ALPHA),
        "globalLightStyles": sorted(GLOBAL_LIGHT_STYLES),
        "matteSources": ["selection", "useAlpha", "matte"],
        "groups": GROUP_ORDER,
        "aliases": ALIASES,
        "available": eng is not None and bool(drawable),
        "notes": [
            "A style needs a SHAPE. On a flat photograph alpha is 1 "
            "everywhere, so three styles (stroke, outerGlow, dropShadow) do "
            "nothing at all and the other seven repaint the frame edge to "
            "edge. Give it a `selection`, or `useAlpha` on a cutout, or the "
            "call is refused with a sentence rather than rendering the no-op.",
            "The order is Photoshop's (see `order`) and the caller's key order "
            "is discarded. Two callers writing the same styles in different "
            "orders get bit-identical pixels.",
            "Colours are RGBA 0-255, like every other colour in this system. "
            "A three-element colour gets alpha 255.",
            "There is NO global light in the renderer: every style reads its "
            "own angle and the defaults disagree (dropShadow 45, innerShadow "
            "45, bevelEmboss 120). Worse, bevelEmboss's angle runs the "
            "opposite way round the compass from the other two — they agree "
            "only at 0 and 180. `globalLight` is this door's fix: one number, "
            "negated for the bevel, so there is one sun.",
            "stroke, outerGlow and dropShadow paint OUTSIDE the shape and the "
            "buffer never grows. A 40px glow on a shape flush to the frame "
            "edge loses the half that had nowhere to go — add canvas "
            "(ops.canvas, stage 1) first, then style. A note says so when it "
            "is about to happen.",
            "A selection that caught nothing resolves to a mask of zeros, "
            "which would make every style a silent no-op. That is refused, "
            "not reported as a success.",
            "`enabled: false` turns a style off without deleting its "
            "parameters, and opacity 0 is a bypass rather than a faint "
            "version of the style.",
            "A style whose parameters the renderer could not honour is "
            "reported in `skipped` with the reason and the rest still paint. "
            "The envelope's `ok` means the call ran, not that every style "
            "landed.",
        ],
    }


# ---------------------------------------------------------------------------
# normalising what the caller wrote
# ---------------------------------------------------------------------------

def _num(v, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if (math.isnan(f) or math.isinf(f)) else f


def canonical(name):
    """A style name, or None. Aliases resolve; case is only forgiven through
    the alias table, because `colorOverlay` and `coloroverlay` being the same
    key silently would let a typo in a document round-trip as a different
    style."""
    if not isinstance(name, str):
        return None
    n = name.strip()
    order = style_order()
    if n in order:
        return n
    a = ALIASES.get(n) or ALIASES.get(n.lower())
    return a if a in order else None


def normalise_styles(styles, notes=None):
    """The caller's styles as an ORDERED list of (name, params) in STYLE_ORDER.

    ⚠ THE CALLER'S ORDER IS DISCARDED HERE, deliberately and in one place. A
    dict in python 3.7+ keeps insertion order, so `{"dropShadow":…, "stroke":…}`
    and `{"stroke":…, "dropShadow":…}` are different objects — and they must not
    be different pictures. Measured: forward vs reversed on three styles differs
    by 1.0, the whole range.
    """
    notes = notes if isinstance(notes, list) else []
    order = style_order()
    got = {}
    if isinstance(styles, dict):
        items = list(styles.items())
    elif isinstance(styles, (list, tuple)):
        items = []
        for s in styles:
            if not isinstance(s, dict):
                raise StyleError(
                    "a styles LIST holds objects like "
                    '{"style": "dropShadow", "distance": 12} — '
                    f"got {type(s).__name__}.")
            nm = s.get("style") or s.get("name") or s.get("kind")
            items.append((nm, {k: v for k, v in s.items()
                               if k not in ("style", "name", "kind")}))
    else:
        raise StyleError(
            "styles must be an object keyed by style name, or a list of "
            '{"style": name, ...} — got '
            f"{type(styles).__name__}.")

    for raw, params in items:
        name = canonical(raw)
        if name is None:
            raise StyleError(
                f'There is no layer style called "{raw}". The ten are: '
                f"{', '.join(order)}.")
        if not isinstance(params, dict):
            raise StyleError(
                f'{name} takes an object of parameters, not a '
                f"{type(params).__name__}. Use {{}} for its defaults.")
        if params.get("enabled") is False:
            notes.append(f"{name}: enabled is false, so it was not painted")
            continue
        if name in got:
            # Two spellings of one style — an alias beside its real name. One
            # of them is going to be lost, so say which rather than letting the
            # dict silently pick.
            raise StyleError(
                f'{name} was given twice (the second spelling was "{raw}"). '
                "A layer has one of each style; its NAME is its identity.")
        got[name] = dict(params)
    return [(n, got[n]) for n in order if n in got]


def _with_global_light(pairs, global_light, notes):
    """One angle for the three lit styles, the bevel's negated. See trap 3.

    A style that set its OWN angle keeps it: `globalLight` is Photoshop's "use
    global light" checkbox, which an individual style is allowed to leave off.
    """
    g = _num(global_light)
    if g is None:
        return pairs
    out = []
    for name, p in pairs:
        mult = GLOBAL_LIGHT_STYLES.get(name)
        if mult is None or "angle" in p:
            if mult is None and "angle" in p and name == "satin":
                notes.append("satin keeps its own angle: it is the direction "
                             "the fold runs, not where the light is")
            out.append((name, p))
            continue
        p = dict(p)
        p["angle"] = g * mult
        out.append((name, p))
    touched = [n for n, _ in out if n in GLOBAL_LIGHT_STYLES]
    if touched:
        notes.append(
            f"globalLight {g:g}deg applied to {', '.join(sorted(touched))} "
            f"(negated for bevelEmboss, whose angle runs the other way round "
            f"the compass — without this the three styles light from two "
            f"different directions)")
    return out


# ---------------------------------------------------------------------------
# the matte - what the styles are applied TO
# ---------------------------------------------------------------------------

_OPAQUE = 1.0 - 1e-6
_EMPTY = 1e-6


def resolve_matte(rgba, selection=None, use_alpha=False, matte=None, notes=None):
    """The layer's alpha, from one of the three sources, or a refusal.

    Returns `(matte, source)` where matte is float32 (H, W) 0..1.

    ⚠ THE RETURNED MATTE IS THE FINAL LAYER ALPHA, not a mask to be combined
    later. A selection on a cutout has to be intersected with the picture's own
    alpha — you cannot have layer where there is no picture — so that multiply
    happens HERE, once, and callers do not each get a chance to forget it or to
    do it twice. The `useAlpha` path deliberately does NOT multiply, because
    alpha * alpha is a different, softer shape than alpha and nothing would say
    so: the edge would just get thin.
    """
    notes = notes if isinstance(notes, list) else []
    a = np.clip(np.nan_to_num(np.asarray(rgba[..., 3], dtype=np.float32),
                              nan=0.0, posinf=1.0, neginf=0.0), 0.0, 1.0)
    h, w = a.shape[:2]

    if matte is not None:
        m = np.asarray(matte, dtype=np.float32)
        if m.ndim == 3:
            m = m[..., 0]
        if m.shape[:2] != (h, w):
            raise StyleError(
                f"the matte is {m.shape[1]}x{m.shape[0]} and the picture is "
                f"{w}x{h}. A matte in another frame's coordinates does not "
                "register — it masks the wrong pixels and nothing says so.")
        m = np.clip(np.nan_to_num(m, nan=0.0, posinf=1.0, neginf=0.0), 0.0, 1.0) * a
        source = "matte"
    elif selection is not None:
        sel = _imgselect()
        if sel is None:
            raise StyleError("selections are unavailable: imgselect would not "
                             "import, so the shape cannot be resolved.")
        warn = []
        m = np.asarray(sel.resolve(selection, rgba, warn), dtype=np.float32)
        for msg in warn:
            notes.append(f"selection: {msg}")
        if m.shape[:2] != (h, w):
            raise StyleError(
                f"the selection resolved to {m.shape[1]}x{m.shape[0]} against "
                f"a {w}x{h} picture. Selections are written in post-geometry "
                "pixels (IMAGE_SPEC §3) — one of the two is the wrong frame.")
        m = np.clip(m, 0.0, 1.0) * a
        source = "selection"
    else:
        # `useAlpha` and "nothing at all" land in the same place on purpose: the
        # picture's own alpha is the only shape left, and a cutout should not
        # have to say so twice. What separates them is the refusal below, which
        # fires either way — a caller who wrote useAlpha on an opaque photo has
        # made exactly the mistake a caller who wrote nothing has made.
        m = a
        source = "alpha" if use_alpha else "alpha (implied)"

    cover = float(m.mean())
    if float(m.max()) <= _EMPTY:
        if source == "selection":
            raise StyleError(
                "the selection caught nothing, so its mask is zeros "
                "everywhere and every style would be a silent no-op. "
                "imgselect resolves an empty shape list to EMPTY rather than "
                "to the whole frame, on purpose — check the shapes' "
                "coordinates against the post-geometry frame "
                f"({w}x{h}), or the tolerance if it is a wand or colorRange.")
        raise StyleError(
            "the picture is fully transparent, so there is no shape for a "
            "style to follow.")
    if float(m.min()) >= _OPAQUE:
        # ⚠ THE REFUSAL THIS MODULE EXISTS FOR.
        raise StyleError(
            f"every style would paint the whole picture: this {w}x{h} frame is "
            "opaque edge to edge, so there is no shape for a bevel to bevel or "
            "a glow to glow around. Measured on an opaque plate, stroke, "
            "outerGlow and dropShadow change nothing at all and the other "
            "seven repaint every pixel. Give the styles a shape one of two "
            "ways: pass a `selection` (the same {shapes:[...]} spec the "
            "selection tools use — that is the layer), or use a CUTOUT and "
            "pass useAlpha, where the picture's own alpha is the shape.")
    return np.ascontiguousarray(m, dtype=np.float32), source


def _edge_warning(matte, pairs, notes):
    """Trap 4: a style that paints outward, on a shape that touches the border.

    Said before the render rather than after, because the pixels that go over
    the edge leave no trace to measure afterwards — the buffer is the same size
    and the glow is simply not there.
    """
    if matte.size == 0:
        return
    border = max(float(matte[0].max()), float(matte[-1].max()),
                 float(matte[:, 0].max()), float(matte[:, -1].max()))
    if border <= 0.01:
        return
    for name, p in pairs:
        if name not in GROWS_ALPHA:
            continue
        if name == "stroke" and str(p.get("position") or "outside") == "inside":
            continue                       # an inside stroke stays in the shape
        named = [k for k in _REACH[name] if k in p]
        reach = (max([_num(p.get(k), 0.0) for k in named] or [0.0]) if named
                 else _REACH_DEFAULT[name])
        if reach <= 0.5:
            continue                       # asked to reach nowhere, and it does
        notes.append(
            f"{name} paints outside the shape and the shape touches the frame "
            f"edge: about {reach:g}px of it has nowhere to go and is clipped. "
            f"The buffer never grows — add canvas first (ops.canvas, stage 1) "
            f"and style the larger frame.")


# ---------------------------------------------------------------------------
# the paint
# ---------------------------------------------------------------------------

def _clean(a):
    """No NaN, no Inf, in range. Trap 6: seven of the ten carry a NaN straight
    through, and a NaN reaching imagetools' uint8 cast becomes 0 in silence."""
    return np.clip(np.nan_to_num(np.asarray(a, dtype=np.float32),
                                 nan=0.0, posinf=1.0, neginf=0.0), 0.0, 1.0)


def _mix(rgb_a, wa, rgb_b, wb, fallback):
    """Two straight colours at two coverages, as one straight colour.

    The divide is the whole point and the reason this is not a lerp:
    premultiplied arithmetic without it leaves a grey rim on every
    half-transparent edge that nobody can explain afterwards. Where the total
    coverage is zero the fallback's colour is kept rather than a 0/0 — a
    transparent pixel's RGB is not observable, and zeroing it turns a later
    unpremultiply into black fringing.
    """
    tot = wa + wb
    safe = np.where(tot > 1e-6, tot, 1.0)
    return np.where(tot > 1e-6, (rgb_a * wa + rgb_b * wb) / safe, fallback)


def _reassemble(layer, pic, matte):
    """The styled layer put back into the picture it was lifted out of.

    ⚠ `over` IS THE WRONG OPERATOR FOR HALF OF THIS, and using it for all of it
    was a bug this file's own suite caught. A selection does not put a second
    surface in front of the picture; it PARTITIONS one surface. The layer's
    alpha is `matte` and what stayed behind is `pic_alpha - matte`, and those
    two are disjoint coverage of the same pixel — they ADD. Composite them with
    `over` instead and a 50% selection edge on an OPAQUE photograph comes back
    at alpha 0.75, a soft dark seam around every feathered selection, and the
    suite measured exactly that: the alpha inside a partial-alpha selection was
    2a - a² where it should have been a.

    What the STYLES grew — a drop shadow, a glow, an outside stroke — is a
    genuinely new surface in front of the rest of the picture, and that half
    IS `over`. So the two halves are separated by how much alpha the layer has
    beyond what was lifted:

        lift  = matte                 what was taken out of the picture
        rest  = pic_alpha - lift      what stayed behind it
        kept  = min(layer_alpha, lift)  the lifted share, as the styles left it
        grown = layer_alpha - kept      coverage the styles invented

    kept and rest add; grown goes over the sum.
    """
    a = pic[..., 3:4]
    lift = matte[..., None]
    al = layer[..., 3:4]
    rest = np.clip(a - lift, 0.0, 1.0)
    kept = np.minimum(al, lift)
    grown = np.clip(al - kept, 0.0, 1.0)

    base_a = np.clip(kept + rest, 0.0, 1.0)
    base_rgb = _mix(layer[..., :3], kept, pic[..., :3], rest, pic[..., :3])

    out = np.empty_like(pic)
    out[..., 3:4] = np.clip(grown + base_a * (1.0 - grown), 0.0, 1.0)
    out[..., :3] = _mix(layer[..., :3], grown, base_rgb, base_a * (1.0 - grown),
                        base_rgb)
    return out


def apply_styles(rgba, styles, matte=None, notes=None, global_light=None,
                 skipped=None):
    """The ten layer styles on a still, in Photoshop's order, on a real shape.

    `matte` is the layer's alpha — see resolve_matte. Passing None means "the
    picture's own alpha", which is right for a cutout and REFUSED on an opaque
    frame, because there it means "the whole picture" and every style would
    either do nothing or repaint everything.
    """
    notes = notes if isinstance(notes, list) else []
    skipped = skipped if isinstance(skipped, list) else []
    img = np.asarray(rgba, dtype=np.float32)
    if img.ndim != 3 or img.shape[2] != 4:
        raise StyleError(
            "styles need a straight-alpha RGBA image, float32 (H, W, 4) in "
            f"0..1 — got shape {tuple(img.shape)}.")
    img = _clean(img)

    pairs = normalise_styles(styles, notes)
    if not pairs:
        notes.append("no styles were enabled, so the picture came back "
                     "untouched")
        return img
    pairs = _with_global_light(pairs, global_light, notes)

    eng = _engine()
    if eng is None or not getattr(eng, "STYLES", None):
        raise StyleError(
            "the layer-style renderer is unavailable: server/vfx/engine.py "
            "would not import (it needs cv2). Nothing was painted — which is "
            "said here rather than handing back the picture unchanged.")

    if matte is None:
        matte, _src = resolve_matte(img, notes=notes)
    else:
        matte = np.ascontiguousarray(_clean(matte), dtype=np.float32)
        if matte.ndim == 3:
            matte = matte[..., 0]
    if matte.shape[:2] != img.shape[:2]:
        # Same sentence resolve_matte gives, because it is the same mistake and
        # a caller must not have to learn which of the two doors it came
        # through to recognise it.
        raise StyleError(
            f"the matte is {matte.shape[1]}x{matte.shape[0]} and the picture "
            f"is {img.shape[1]}x{img.shape[0]}. A matte in another frame's "
            "coordinates does not register — it masks the wrong pixels and "
            "nothing says so.")

    _edge_warning(matte, pairs, notes)

    # ── THE LAYER ──────────────────────────────────────────────────────────
    #
    # Photoshop's "layer via copy", made explicit: the styles need something
    # whose ALPHA is the shape, so the picture is copied and the matte becomes
    # its alpha. This is the one line that turns ten document-only styles into
    # still-image tools, and everything else here is about not lying about it.
    layer = img.copy()
    layer[..., 3] = matte

    for name, params in pairs:
        try:
            out = eng.STYLES[name](layer, params, 1.0, False)
        except Exception as exc:                        # noqa: BLE001
            # ⚠ Trap 7. engine prints and carries on, which is right for frame
            # 4000 of a render and wrong for a person who clicked a button.
            # The style is dropped, the rest still paint, and BOTH channels say
            # so — the reply's `skipped` and the notes the caller surfaces.
            skipped.append({"style": name, "reason": str(exc)})
            notes.append(f"{name} was skipped: {exc}")
            continue
        if not isinstance(out, np.ndarray) or out.shape != layer.shape:
            skipped.append({"style": name,
                            "reason": "the renderer returned something that is "
                                      "not an image of the same size"})
            notes.append(f"{name} was skipped: the renderer returned "
                         f"{type(out).__name__} rather than an image")
            continue
        layer = np.ascontiguousarray(out, dtype=np.float32)

    # ── BACK ONTO THE PICTURE ──────────────────────────────────────────────
    #
    # When the matte IS the picture's alpha the layer is the whole picture and
    # there is no backdrop to composite onto — handing back `layer` is the
    # answer, and compositing it over itself would double every partial edge.
    #
    # When the matte came from a SELECTION the picture was PARTITIONED: the
    # layer is the share inside the selection, the rest stayed behind, and
    # _reassemble puts the two back together — adding the halves that are
    # disjoint and compositing only what the styles grew. Reassembling with a
    # plain `over` inflates alpha everywhere the selection is partial, which is
    # every feathered edge, and the suite pins it.
    same = matte.shape == img[..., 3].shape and np.array_equal(matte, img[..., 3])
    out = layer if same else _reassemble(layer, img, matte)
    return _clean(out)


def apply_style_op(rgba, spec, notes=None, skipped=None):
    """The ops-shaped entry point — the one line imagetools needs.

        ops.styles = { "styles": {...}, "selection": {...}|null,
                       "useAlpha": bool, "globalLight": deg|null }

    A bare `{"dropShadow": {...}}` is accepted too, for the caller who has only
    styles and a cutout. The two are told apart by whether any top-level key is
    a style name, which is unambiguous because none of the four envelope keys
    is one.
    """
    notes = notes if isinstance(notes, list) else []
    if not isinstance(spec, dict):
        raise StyleError("ops.styles must be an object — got "
                         f"{type(spec).__name__}.")
    envelope = ("styles", "selection", "useAlpha", "globalLight", "matte")
    looks_bare = any(canonical(k) for k in spec)
    if looks_bare and "styles" not in spec:
        bad = [k for k in spec if not canonical(k)]
        if bad:
            raise StyleError(
                f'ops.styles mixes style names with "{bad[0]}". Either write '
                "the styles bare, or wrap them: "
                '{"styles": {...}, "selection": {...}}.')
        return apply_styles(rgba, spec, notes=notes, skipped=skipped)

    unknown = [k for k in spec if k not in envelope]
    if unknown:
        raise StyleError(
            f'ops.styles has no key "{unknown[0]}". It takes: '
            f"{', '.join(envelope)} — or the ten style names written bare.")
    if spec.get("styles") is None:
        raise StyleError(
            "ops.styles carries a selection but no `styles`. Nothing would be "
            "painted, which is said here rather than returning the picture "
            "unchanged and calling it a success.")

    use_alpha = bool(spec.get("useAlpha"))
    selection = spec.get("selection")
    if selection is not None and use_alpha:
        raise StyleError(
            "a style has ONE shape. `selection` and `useAlpha` are two, and "
            "silently preferring either one is how a styled cutout comes back "
            "styled against the wrong edge. Pass one.")
    matte, source = resolve_matte(rgba, selection=selection,
                                  use_alpha=use_alpha,
                                  matte=spec.get("matte"), notes=notes)
    notes.append(f"styles: the shape came from the {source} "
                 f"(coverage {float(matte.mean()):.3f})")
    return apply_styles(rgba, spec["styles"], matte=matte, notes=notes,
                        global_light=spec.get("globalLight"), skipped=skipped)


def describe(rgba, spec):
    """What the shape WOULD be, without painting — for a UI that wants to grey
    the control out before the user clicks it, and for the refusal text."""
    notes = []
    try:
        matte, source = resolve_matte(
            rgba, selection=(spec or {}).get("selection"),
            use_alpha=bool((spec or {}).get("useAlpha")), notes=notes)
    except StyleError as exc:
        # ⚠ `ok` HERE IS A VERDICT ABOUT THE PICTURE, and the door below keeps
        # its own `ok` separate. Collapsing the two — "the call failed" and
        # "the answer is no" — was a real bug in this repo this week.
        return {"shaped": False, "why": str(exc), "notes": notes or None}
    return {"shaped": True, "source": source,
            "coverage": float(matte.mean()),
            "touchesEdge": bool(max(float(matte[0].max()), float(matte[-1].max()),
                                    float(matte[:, 0].max()),
                                    float(matte[:, -1].max())) > 0.01),
            "notes": notes or None}


# ---------------------------------------------------------------------------
# the door
# ---------------------------------------------------------------------------

def _read(path):
    from PIL import Image                               # noqa: PLC0415
    im = Image.open(path).convert("RGBA")
    return np.asarray(im).astype(np.float32) / 255.0


def _write(path, rgba):
    from PIL import Image                               # noqa: PLC0415
    Image.fromarray((np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8),
                    "RGBA").save(path)


def _apply_job(job):
    """`{in, out, styles, selection|useAlpha, globalLight, matteOut}` -> reply."""
    for k in ("in", "out"):
        if not job.get(k):
            raise StyleError(f'the job needs "{k}": a file path.')
    rgba = _read(job["in"])
    notes, skipped = [], []
    spec = {k: job[k] for k in ("styles", "selection", "useAlpha", "globalLight")
            if k in job}
    out = apply_style_op(rgba, spec, notes=notes, skipped=skipped)
    _write(job["out"], out)
    reply = {"ok": True, "out": job["out"],
             "width": int(out.shape[1]), "height": int(out.shape[0]),
             "applied": [n for n, _ in normalise_styles(job.get("styles"), [])
                         if not any(s["style"] == n for s in skipped)],
             "order": list(style_order())}
    if skipped:
        # ⚠ `ok` STAYS TRUE. It means the call ran and wrote a file. Whether
        # every style landed is a different question and it has its own key —
        # collapsing the two is how a caller learns to ignore both.
        reply["skipped"] = skipped
    if job.get("matteOut"):
        matte, source = resolve_matte(rgba, selection=job.get("selection"),
                                      use_alpha=bool(job.get("useAlpha")))
        _write(job["matteOut"],
               np.dstack([matte, matte, matte, np.ones_like(matte)]))
        reply["matteOut"] = job["matteOut"]
        reply["matte"] = {"source": source, "coverage": float(matte.mean())}
    if notes:
        reply["notes"] = notes
    return reply


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    elif mode in ("apply", "describe"):
        # The still door, in the {mode, jobPath} shape every other module here
        # is spawned with, so server/index.js needs no new way to reach python:
        # `spawn(config.python, [".../imgstyles.py", "apply", jobPath])`.
        if len(sys.argv) < 3:
            print(json.dumps({"ok": False,
                              "error": f'{mode} needs the path of a job file '
                                       'holding {"in": ..., "out": ..., '
                                       '"styles": {...}}'}))
            sys.exit(1)
        try:
            _job = json.loads(open(sys.argv[2], encoding="utf-8").read())
            if not isinstance(_job, dict):
                raise StyleError("the job file must hold an object.")
            if mode == "describe":
                _rep = describe(_read(_job["in"]), _job)
                # Two words for two things: `ok` says the call worked, `report.
                # shaped` says whether the picture has a shape to style. A
                # picture with no shape is a legitimate answer, not a failure.
                print(json.dumps({"ok": True, "report": _rep}))
            else:
                print(json.dumps(_apply_job(_job)))
        except Exception as _exc:                       # noqa: BLE001
            print(json.dumps({"ok": False, "error": str(_exc)}))
            sys.exit(1)
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
