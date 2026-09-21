"""The layered image document — the thing a Layers panel is a view of.

`imagetools.composite()` flattens a list of sources in one call. That is a
render, not a document: there is nothing to reopen, nothing to reorder, nothing
to switch off and back on, and so nothing for a Layers panel to show. This
module is the document — layers, masks, groups, adjustment layers, layer styles
— plus the renderer that turns one into pixels, and a set of pure edits that
turn one document into another.

    doc  ->  render(doc, resolve)  ->  float32 (H, W, 4), 0..1, STRAIGHT alpha

Straight alpha in and out, everywhere, because layer work is all semi-
transparent edges and a premultiplied array read as straight darkens every one
of them. The single exception is resampling: `cv2.warpAffine` averages
neighbours, and averaging straight-alpha colour drags the colour of fully
transparent pixels into the edge. So the transform premultiplies, resamples and
un-premultiplies immediately — engine.py's `_warp` already does exactly that
and is used verbatim.

WHAT IS BORROWED, AND WHY NONE OF IT IS COPIED
    The compositor already owns every hard number in here. `engine._blend_rgb`
    is the one implementation of the 17 colour blends (ten of which it takes
    from `imagetools._blend`); `engine._over` is the one implementation of
    W3C source-over against a possibly-transparent backdrop; `engine._warp`,
    `engine._stencil_alpha`, `engine._render_text` and `engine.STYLES` are the
    one implementation of everything else. This module imports all of them.
    The only rasteriser written here is the mask's, because §3's selection
    shapes are a different vocabulary from a comp mask's polygon — its feather
    and expand still use engine's numbers (sigma = feather/2, an elliptical
    structuring element) so the two soften identically. A second copy of any of it is the bug IMAGE_SPEC §9
    describes: it renders correctly the day it is written and drifts silently
    forever after.

    Most of those names are underscore-private. That is a real seam problem, not
    a licence — see MISSING FROM THE OTHER COLUMNS at the bottom of this
    docstring. `_needs()` below fails loudly at import if any of them moves, so
    a compositor refactor is a traceback here and not a picture that is quietly
    wrong.

LAYER ORDER IS BOTTOM-UP, THE OPPOSITE OF comp.json
    `layers[0]` is the BOTTOM of the stack and is painted FIRST.
    docs/VFX_SPEC.md §1 puts the top at index 0, because that is what After
    Effects shows. This document follows `imagetools.composite()` instead
    ("Layers paint in order, first is bottom"), because that is the convention
    the image editor already ships and the one its callers already write. Both
    conventions are defensible; having two of them and not saying so is not.
    Anything moving a layer list between the two documents must reverse it.

GROUPS COMPOSITE AS A UNIT, ALWAYS
    A group renders its children into its own transparent buffer and that buffer
    is then composited with the group's opacity, blend, mask and styles. It is
    never a decorative indent. The consequence is Photoshop's: an isolated group
    is opaque to what is under it, so an adjustment layer inside a group reaches
    its siblings and stops at the group's floor. Photoshop's "Pass Through" is
    NOT offered — it would need a 22nd entry in a blend list this file is
    forbidden to extend, and Photoshop itself abandons pass-through the moment
    you set a group opacity, which is the case this feature exists for.

ADJUSTMENT LAYERS REACH DOWN, NOT SIDEWAYS AND NOT UP
    An adjustment layer's effects run on whatever is already accumulated beneath
    it in its own compositing context, over the region its own alpha covers —
    the same three lines engine.py runs. Its blend mode and its styles are
    meaningless (it is never drawn) and are refused in the catalog rather than
    accepted and ignored.

    python imgdoc.py render <job.json>     one JSON line back
    python imgdoc.py store  <job.json>     save / open / list / delete
    python imgdoc.py edit   <job.json>     a list of mutations, applied and saved
    python imgdoc.py catalog               the vocabulary, for UI and MCP

`store` and `edit` are what make the pure edits below reachable by anything but
a test — see THE SHELF. Neither picks a directory: `dir` is a job field,
because server/config.js owns where this app writes and this module has never
imported it and must not start.

MISSING FROM THE OTHER COLUMNS — read this before extending anything here
  * `imagetools.py` exposes exactly one reusable symbol, `_blend`. Its 25
    adjustments live inside `apply_edit(job)`, which reads a path, writes a
    path, quantises to 8-bit and prints to stdout. None of that can run on a
    float32 array mid-composite, so an adjustment layer here dispatches to
    `effects.py` only. Extracting `apply_ops(rgba, ops) -> rgba` from
    `apply_edit` is a one-function refactor in the Engine's column and is what
    the other ~10 adjustments (temperature, grain, denoise, sepia, autoLevels,
    HSL bands) are waiting on.
  * `engine.py`'s layer styles have no catalog anywhere — the VFX MCP tool
    passes `additionalProperties: true`. STYLE_CATALOG below is the first one,
    and imgdoc_test.py pins its defaults against what engine actually falls back
    to so the two cannot drift apart unnoticed.
  * There is no `shape` layer kind. IMAGE_SPEC §6's vector primitives live in
    `server/imgshape.py`, which serves the flat pipeline; a shape LAYER —
    unbuilt today — is one entry in CATALOG and one branch in `_source_pixels`
    calling it, and everything else here already works on whatever pixels come
    back.
  * Mask geometry is IMAGE_SPEC §3's selection vocabulary, deliberately: a
    layer mask and a selection are the same float32 (H, W) 0..1 array. The
    `wand` and `colorRange` kinds are §3's and belong to `server/imgselect.py`,
    the flat pipeline's selection engine; they sample an image, and a document
    mask resolves in canvas space before there is one to sample, so asking for
    one here is refused by name rather than silently dropped.

numpy / cv2 / PIL, plus server/vfx/{engine,effects,interp}.py.
"""
from __future__ import annotations

import copy
import json
import math
import os
import sys
import time
import uuid

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(_HERE, "vfx"), _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

try:
    import effects                                      # noqa: E402
    import engine                                       # noqa: E402
    import imagetools                                   # noqa: E402
    import interp                                       # noqa: E402
except Exception as _exc:                               # noqa: BLE001
    raise ImportError(
        "imgdoc needs the compositor (server/vfx/engine.py, effects.py, "
        f"interp.py) and could not import it: {_exc}. It is a HARD dependency "
        "and deliberately not guarded the way imagetools guards effects.py: a "
        "missing effect registry costs you effects, a missing engine costs you "
        "every blend mode, the transform and the alpha maths, and the only way "
        "to carry on without it is to write a second copy of all three."
    ) from _exc


def _needs(mod, names):
    """Fail at import if a borrowed private name has moved.

    Everything below composites through the compositor's own functions, and
    every one of them is underscore-private. A rename over there would otherwise
    surface as an AttributeError inside a render loop — or worse, as somebody
    "fixing" it with a local copy of the maths.
    """
    gone = [n for n in names if not hasattr(mod, n)]
    if gone:
        raise ImportError(
            f"server/imgdoc.py composites through {mod.__name__} and these are "
            f"gone: {', '.join(gone)}. Do NOT reimplement them here — that is "
            "the fork IMAGE_SPEC §9 warns about. Re-point at the new names, or "
            "ask the compositor's owner to export them.")


_needs(engine, ("Tile", "_over", "_over_preserve", "_stencil_alpha", "_warp",
                "_tile_region", "_render_text", "_unpremul", "_f", "_rgba01",
                "_LUMA_W", "STYLES", "STYLE_ORDER", "BLEND_MODES",
                "STENCIL_MODES"))
_needs(interp, ("transform_matrix", "mat_mul", "scale_matrix"))
_needs(effects, ("apply", "catalog", "CATALOG"))
_needs(imagetools, ("TIMELINE_EFFECTS", "timeline_effects"))

_f = engine._f                                          # NaN / "big" -> fallback
_rgba01 = engine._rgba01                                # 0-255 document -> 0..1
Tile = engine.Tile


# ── the vocabulary ───────────────────────────────────────────────────────────

DOC_VERSION = 1

# Every kind render() can draw. store.js's lesson applies the moment a JS store
# is written for this document: a kind missing from the store's own copy is
# coerced to a white rectangle on every read, silently. There is no JS store
# yet, so there is exactly one list — keep it that way for as long as possible.
LAYER_TYPES = ("image", "solid", "gradient", "text", "adjustment", "group")

# NOT A NEW LIST. server/vfx/store.js's BLEND_MODES is the 21 the UI offers, and
# the python half of it is already split in two over in engine.py: 17 colour
# blends plus 4 stencil transfer modes that re-shape alpha instead of mixing
# colour. Concatenating them here is the only way to have store.js's list
# without owning a copy of it — imgdoc_test.py parses store.js and asserts this
# tuple holds exactly those names.
#
# The ORDER is engine.py's, not store.js's, and the two already disagree: store
# puts hardlight sixth, beside softlight, where Photoshop's menu has it; engine
# puts it eleventh because its tuple is imagetools' ten with its own seven
# appended. Nothing renders differently — every lookup is by name — but a
# dropdown generated from this catalog and a dropdown generated from store.js
# are in a different order, and somebody owns that decision. It is not this
# file's to make, and inventing a third order to split the difference would be
# the exact fork the paragraph above exists to prevent.
BLEND_MODES = tuple(engine.BLEND_MODES) + tuple(engine.STENCIL_MODES)
STENCIL_MODES = tuple(engine.STENCIL_MODES)

# Photoshop's composite order for layer styles, engine.py's STYLE_ORDER
# unchanged: an overlay recolours the fill, the inside styles sit on that, the
# stroke rides the edge, the outside styles land behind everything.
STYLE_ORDER = tuple(engine.STYLE_ORDER)

# minSize is 1, not store.js's 16. That floor exists because NVENC refuses tiny
# frames; a still has no encoder and a 1x1 swatch is a legitimate document — and
# it is the smallest hostile input worth surviving. maxSize matches the 8192
# imagetools already clamps a resize to.
LIMITS = {
    "minSize": 1, "maxSize": 8192,
    "maxLayers": 256,          # across the whole tree, groups included
    "maxDepth": 16,            # nested groups; a cycle is caught separately
    "effectsPerLayer": 24,     # store.js's number, same reason
    "maskShapes": 64,
    # The shelf's two. 200 documents is store.js's FX_PRESET_LIMITS.presets
    # number, taken rather than invented. The byte cap is a REFUSAL TO READ, not
    # a cap on what may be written: a shelf past it is a shelf something else
    # corrupted, and reading it costs the RAM before anything can say so.
    "shelfDocs": 200,
    "shelfBytes": 64 * 1024 * 1024,
}

MASK_SHAPE_KINDS = ("rect", "ellipse", "polygon")
MASK_CHANNELS = ("alpha", "luma")
MASK_MODES = ("add", "subtract")


# ── the catalog: what the UI and the MCP schema are generated from ───────────
#
# Same shape as effects.py's CATALOG (label / group / why / params) so one
# generator serves both. The param helpers are NOT imported from effects.py for
# one reason: every entry there carries `animatable`, and a still image has no
# time axis, so an animatable flag in this catalog would be a claim the renderer
# cannot honour — IMAGE_SPEC §9's "a schema that accepts a parameter the code
# then ignores", in its politest form.

def num(default, lo, hi, desc, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "desc": desc}


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default, "desc": desc}


def col(default, desc):
    """Colours are 0-255. IMAGE_SPEC §9: a 0-1 triple is a legal near-black that
    draws perfectly, keeps its alpha and passes every pixel-counting test."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255, "desc": desc}


def vec2(default, desc, unit="px"):
    return {"type": "vec2", "default": list(default), "min": -100000, "max": 100000,
            "unit": unit, "desc": desc}


def text(default, desc):
    return {"type": "string", "default": str(default), "desc": desc}


def listof(default, desc):
    return {"type": "list", "default": list(default), "desc": desc}


GROUP_ORDER = ["Source", "Generate", "Non-destructive", "Structure"]

# Every layer carries these, whatever its kind.
COMMON_PARAMS = {
    "name": text("layer", "what the Layers panel shows"),
    "blend": pick(BLEND_MODES, "normal",
                  "how this layer meets what is already beneath it. The last "
                  "four are AE's stencil/silhouette transfer modes: they mix no "
                  "colour, they re-cut the alpha of everything painted below."),
    "enabled": flag(True, "the eyeball. A hidden layer costs nothing to render."),
    "locked": flag(False, "refuses edits from the CRUD helpers; render ignores it"),
    "clipped": flag(False,
                    "Photoshop's clipping mask: this layer keeps the alpha of its "
                    "BASE — the nearest layer below it in the same container that "
                    "is not itself clipped — as its matte. Consecutive clipped "
                    "layers stack onto the one base; the base's own opacity, "
                    "styles and blend mode then apply to the whole clipped "
                    "result, exactly as Photoshop composites it. The search "
                    "never crosses a group edge, so the bottom layer of a "
                    "document or of a group has no base: it paints unclipped, "
                    "with a warning. An adjustment layer is never painted and "
                    "so cannot BE a base (a clipped adjustment layer, though, "
                    "is the classic move: it adjusts its base stack and "
                    "nothing else)."),
}

TRANSFORM_PARAMS = {
    "anchor": vec2([0, 0], "the pivot, in LAYER pixels. Absent means the layer's "
                           "own centre — resolved at render time when the source "
                           "size is finally known, rather than frozen into the "
                           "document by whoever created the layer."),
    "position": vec2([0, 0], "where the anchor lands, in CANVAS pixels. Absent "
                             "means the canvas centre."),
    "scale": vec2([100, 100], "percent", unit="%"),
    "rotation": num(0, -3600, 3600, "degrees, clockwise", unit="deg"),
    "opacity": num(100, 0, 100, "percent. On a group this applies to the group as "
                                "one composited unit, not to each child.", unit="%"),
}

MASK_PARAMS = {
    "enabled": flag(True, "switch the mask off without throwing it away — the "
                          "whole argument for a mask over an eraser"),
    "src": text("", "a LIBRARY IMAGE NAME whose channel becomes the mask. Empty "
                    "for a shape-only mask."),
    "channel": pick(MASK_CHANNELS, "alpha", "which channel of src is the mask"),
    "shapes": listof([], "IMAGE_SPEC §3 selection shapes: "
                         "{kind:'rect', x, y, w, h}, {kind:'ellipse', cx, cy, rx, "
                         "ry}, {kind:'polygon', points:[[x,y]]}, each with "
                         "mode:'add'|'subtract'. Canvas pixels. §3's 'wand' and "
                         "'colorRange' belong to server/imgselect.py and are "
                         "refused here by name — bake theirs into a library "
                         "image and use mask.src."),
    "feather": num(0, 0, 512, "px, gaussian, on the combined mask", unit="px"),
    "expand": num(0, -512, 512, "px; negative contracts", unit="px"),
    "invert": flag(False, "flip the combined mask"),
    "density": num(100, 0, 100, "Photoshop's Density: how far the mask is allowed "
                                "to hide. 0 is a mask that does nothing.", unit="%"),
}

# engine.py's six styles. Its per-style defaults live as inline `_f(p.get(k), d)`
# fallbacks with no catalog anywhere, so these numbers are a transcription and
# imgdoc_test.py's style-drift case is what stops them rotting: it renders each
# style twice, once with {} and once with exactly these values, and demands the
# same pixels.
STYLE_CATALOG = {
    "colorOverlay": {"label": "Color overlay", "group": "Layer style",
                     "why": "recolour the fill and nothing else; the matte never moves",
                     "params": {"color": col([255, 0, 0], "the colour laid over the fill"),
                                "opacity": num(100, 0, 100, "percent", unit="%"),
                                "enabled": flag(True, "off without deleting")}},
    "innerGlow": {"label": "Inner glow", "group": "Layer style",
                  "why": "light crawling inward from the edge — the cheapest way to "
                         "make flat type read as lit",
                  "params": {"color": col([255, 255, 204], "glow colour"),
                             "opacity": num(60, 0, 100, "percent", unit="%"),
                             "size": num(16, 0, 512, "how far it reaches in", unit="px"),
                             "choke": num(0, 0, 256, "eat into the matte before blurring", unit="px"),
                             "enabled": flag(True, "off without deleting")}},
    "innerShadow": {"label": "Inner shadow", "group": "Layer style",
                    "why": "the layer punched INTO the plate rather than sitting on it",
                    "params": {"color": col([0, 0, 0], "shadow colour"),
                               "opacity": num(55, 0, 100, "percent", unit="%"),
                               "angle": num(45, -360, 360, "degrees the light comes from", unit="deg"),
                               "distance": num(8, 0, 512, "how far it is thrown", unit="px"),
                               "size": num(10, 0, 512, "softness", unit="px"),
                               "choke": num(0, 0, 256, "tighten before blurring", unit="px"),
                               "enabled": flag(True, "off without deleting")}},
    "bevelEmboss": {
        "label": "Bevel & emboss",
        "group": "Layer style",
        "why": "light from an angle across the slope of the layer's own matte, so a flat fill reads as a raised surface \u2014 the one style that makes a shape look like an object rather than a colour",
        "params": {
            "size": {"type": "number", "default": 8, "min": 1, "max": 128, "unit": "px",
                     "desc": "how far the slope runs in from the edge"},
            "depth": {"type": "number", "default": 100, "min": 0, "max": 300, "unit": "%",
                      "desc": "how hard the light falls; 100 is the measured default"},
            "angle": {"type": "number", "default": 120, "min": 0, "max": 360, "unit": "deg",
                      "desc": "where the light comes from"},
            "direction": {"type": "enum", "options": ["up", "down"], "default": "up",
                          "desc": "up raises the shape, down presses it in"},
            "highlight": {"type": "color", "default": [255, 255, 255], "min": 0, "max": 255,
                          "desc": "the lit side"},
            "shadow": {"type": "color", "default": [0, 0, 0], "min": 0, "max": 255,
                       "desc": "the side turned away"},
            "opacity": {"type": "number", "default": 75, "min": 0, "max": 100, "unit": "%",
                        "desc": "how strongly the light and shade are laid on"},
        },
    },
    "satin": {
        "label": "Satin",
        "group": "Layer style",
        "why": "the matte folded against itself, which is how cloth catches light \u2014 it reads as fabric on a letterform and as nothing at all on a square, because it is a shape effect and not a lighting one",
        "params": {
            "distance": {"type": "number", "default": 12, "min": 0, "max": 256, "unit": "px",
                         "desc": "how far the shape is folded against itself"},
            "angle": {"type": "number", "default": 45, "min": 0, "max": 360, "unit": "deg",
                      "desc": "which way the fold runs"},
            "size": {"type": "number", "default": 10, "min": 0, "max": 128, "unit": "px",
                     "desc": "softness of the fold"},
            "color": {"type": "color", "default": [0, 0, 0], "min": 0, "max": 255,
                      "desc": "the colour of the fold"},
            "invert": {"type": "boolean", "default": False,
                       "desc": "swap which side of the fold is dark"},
            "opacity": {"type": "number", "default": 50, "min": 0, "max": 100, "unit": "%",
                        "desc": "how visible the sheen is"},
        },
    },
    "gradientOverlay": {
        "label": "Gradient overlay",
        "group": "Layer style",
        "why": "a ramp inside the alpha where colorOverlay puts one flat colour, and like every style here it follows the matte, so it survives each later edit to the shape",
        "params": {
            "startColor": {"type": "color", "default": [0, 0, 0], "min": 0, "max": 255,
                           "desc": "the colour the ramp begins on"},
            "endColor": {"type": "color", "default": [255, 255, 255], "min": 0, "max": 255,
                         "desc": "the colour it ends on"},
            "angle": {"type": "number", "default": 90, "min": 0, "max": 360, "unit": "deg",
                      "desc": "which way the ramp runs; ignored when style is radial"},
            "style": {"type": "enum", "options": ["linear", "radial"], "default": "linear",
                      "desc": "a straight ramp, or one out from the middle"},
            "reverse": {"type": "boolean", "default": False, "desc": "swap the two ends"},
            "opacity": {"type": "number", "default": 100, "min": 0, "max": 100, "unit": "%",
                        "desc": "how much of the ramp covers the layer's own colour"},
        },
    },
    "patternOverlay": {
        "label": "Pattern overlay",
        "group": "Layer style",
        "why": "a repeating tile inside the alpha \u2014 texture behind type, a halftone, a weave. The tile is GENERATED rather than loaded from a file, because a file-backed pattern needs a second asset shelf and these three are what a pattern overlay is actually reached for",
        "params": {
            "pattern": {"type": "enum", "options": ["checker", "stripes", "dots"], "default": "checker",
                        "desc": "which tile to repeat"},
            "size": {"type": "number", "default": 16, "min": 2, "max": 512, "unit": "px",
                     "desc": "one tile across"},
            "angle": {"type": "number", "default": 0, "min": 0, "max": 360, "unit": "deg",
                      "desc": "turn the tiling"},
            "weight": {"type": "number", "default": 30, "min": 1, "max": 100, "unit": "%",
                       "desc": "dot size, as a share of the tile; ignored by the other two"},
            "color": {"type": "color", "default": [0, 0, 0], "min": 0, "max": 255,
                      "desc": "one of the two tile colours"},
            "color2": {"type": "color", "default": [255, 255, 255], "min": 0, "max": 255,
                       "desc": "the other"},
            "opacity": {"type": "number", "default": 100, "min": 0, "max": 100, "unit": "%",
                        "desc": "how much of the tile covers the layer's own colour"},
        },
    },
    "stroke": {"label": "Stroke", "group": "Layer style",
               "why": "an outline that follows the alpha, so it survives every "
                      "later edit to the layer's shape",
               "params": {"color": col([255, 255, 255], "stroke colour"),
                          "size": num(4, 1, 256, "width", unit="px"),
                          "position": pick(["outside", "inside", "center"], "outside",
                                           "which side of the edge it sits on"),
                          "opacity": num(100, 0, 100, "percent", unit="%"),
                          "feather": num(0, 0, 128, "soften the stroke", unit="px"),
                          "enabled": flag(True, "off without deleting")}},
    "outerGlow": {"label": "Outer glow", "group": "Layer style",
                  "why": "a drop shadow thrown zero distance in a bright colour, "
                         "which is what a Photoshop outer glow actually is",
                  "params": {"color": col([255, 230, 153], "glow colour"),
                             "opacity": num(60, 0, 100, "percent", unit="%"),
                             "size": num(16, 0, 512, "how far it reaches out", unit="px"),
                             "spread": num(0, 0, 256, "solid core before the falloff", unit="px"),
                             "enabled": flag(True, "off without deleting")}},
    "dropShadow": {"label": "Drop shadow", "group": "Layer style",
                   "why": "the one effect that separates a layer from its backdrop "
                          "without changing either",
                   "params": {"color": col([0, 0, 0], "shadow colour"),
                              "opacity": num(55, 0, 100, "percent", unit="%"),
                              "angle": num(45, -360, 360, "degrees the light comes from", unit="deg"),
                              "distance": num(12, 0, 1024, "how far it is thrown", unit="px"),
                              "size": num(10, 0, 512, "softness", unit="px"),
                              "spread": num(0, 0, 256, "solid core before the falloff", unit="px"),
                              "shadowOnly": flag(False, "drop the layer, keep the shadow"),
                              "enabled": flag(True, "off without deleting")}},
}

# A gradient layer IS effects.py's Ramp on an opaque plate. Its parameters are
# therefore ramp's parameters, spliced in rather than retyped, minus the two
# that would be a second way to say something the layer already says: `mode` is
# the layer's blend and `opacity` is the layer's opacity, and offering both
# spellings guarantees somebody sets the wrong one.
_RAMP_PARAMS = {k: v for k, v in effects.CATALOG["ramp"]["params"].items()
                if k not in ("mode", "opacity")}
_RAMP_PARAMS = {k: {kk: vv for kk, vv in v.items() if kk != "animatable"}
                for k, v in _RAMP_PARAMS.items()}

# Every generated kind is sized in layer pixels; [0,0] is the canvas, which is
# what an adjustment layer or a backdrop wants and what makes its transform the
# identity.
_PLATE_SIZE = vec2([0, 0], "layer pixels; [0, 0] means the whole canvas")

CATALOG = {
    "image": {
        "label": "Image", "group": "Source",
        "why": "a picture from the library. The document stores the NAME and the "
               "caller resolves it, so a document survives being moved, and this "
               "process never picks a file off disk on its own.",
        "params": {"src": text("", "library image name, never a path")},
    },
    "solid": {
        "label": "Solid", "group": "Generate",
        "why": "a colour plate. Half the useful layers in any document are a "
               "solid with a mask on it.",
        "params": {"color": col([255, 255, 255], "rgba 0-255; alpha may be omitted"),
                   "size": _PLATE_SIZE},
    },
    "gradient": {
        "label": "Gradient", "group": "Generate",
        "why": "a ramp between two points. Half the grades in the world are a "
               "gradient layer on multiply.",
        "params": {"size": _PLATE_SIZE},
        # `params` sit on the layer; `content` names the sub-object the rest go
        # in. Flattening the two into one list is how a UI ends up writing
        # layer.startColor, which nothing reads.
        "content": {"key": "gradient", "params": _RAMP_PARAMS},
    },
    "text": {
        "label": "Text", "group": "Generate",
        "why": "type that stays type — re-editable after the fact, which is the "
               "difference between a layer and a stamp.",
        "params": {"size": _PLATE_SIZE},
        "content": {"key": "text", "params": {
            "content": text("TEXT", "the string; \n splits lines"),
            "font": text("arial.ttf", "BASENAME ONLY, out of the system font "
                                      "folders. A document reaches this process "
                                      "unvalidated and a raw path handed to "
                                      "FreeType opens any file on disk."),
            "size": num(96, 1, 2048, "type size", unit="px"),
            "color": col([240, 240, 245], "fill"),
            "align": pick(["left", "center", "right"], "center", "within the layer"),
            "stroke": num(0, 0, 64, "outline width", unit="px"),
            "strokeColor": col([0, 0, 0], "outline colour"),
            "lineHeight": num(1.15, 0.5, 4.0, "multiples of the type size"),
            "tracking": num(0, -500, 500, "1/1000 em, the number off a type panel"),
        }},
    },
    "adjustment": {
        "label": "Adjustment", "group": "Non-destructive",
        "why": "an effect stack applied to everything beneath it in this group, "
               "over the region this layer's own alpha covers. This is the whole "
               "argument for layers: the 75 shared effects become re-editable "
               "instead of baked.",
        "params": {"effects": listof([], "[{type, params, enabled}] from "
                                         "effects.py's catalog, run in order"),
                   "size": _PLATE_SIZE},
        "refuses": ["blend", "styles"],
    },
    "group": {
        "label": "Group", "group": "Structure",
        "why": "children composited into their own buffer first, then treated as "
               "one layer. A group whose opacity applies per-child is an indent, "
               "not a group.",
        "params": {"layers": listof([], "children, BOTTOM-UP like every layer list here")},
    },
}


def catalog():
    """What MCP and the Layers panel are generated from."""
    return {
        "layers": CATALOG,
        "groups": GROUP_ORDER,
        "names": sorted(CATALOG),
        "common": COMMON_PARAMS,
        "transform": TRANSFORM_PARAMS,
        "mask": MASK_PARAMS,
        "styles": STYLE_CATALOG,
        "styleOrder": list(STYLE_ORDER),
        "blendModes": list(BLEND_MODES),
        "stencilModes": list(STENCIL_MODES),
        "limits": dict(LIMITS),
        "effects": effects.catalog(),
        "notes": {
            "order": "layers[0] is the BOTTOM and is painted first — the OPPOSITE "
                     "of comp.json, which puts the top at index 0. Reverse the "
                     "list when moving one document's layers into the other.",
            "colors": "0-255 everywhere, alpha optional and defaulting to opaque",
            "alpha": "float32 (H, W, 4), 0..1, straight (un-premultiplied)",
            "groups": "a group composites as a unit; there is no pass-through mode",
            "adjustment": "reaches everything beneath it IN ITS OWN GROUP, and "
                          "nothing above it",
            "clipping": "clipped: true keeps the base's alpha as the matte — the "
                        "base is the nearest non-clipped layer below in the same "
                        "container, and its opacity, styles and blend then apply "
                        "to the whole clipped result. A clipped layer with no "
                        "base (the bottom of a container, or an adjustment layer "
                        "beneath it) paints unclipped, with a warning.",
            "masks": "canvas pixels, applied after the layer's transform, so "
                     "rotating a layer does not rotate its mask",
            "animation": "none. A still has no time axis, so no parameter here "
                         "carries an `animatable` flag the way effects.py's do.",
        },
    }


# ── blank documents ──────────────────────────────────────────────────────────

def new_id(prefix, n=4):
    """Random, not sequential — store.js's reasoning verbatim: delete layer 2,
    add another, and a sequential id reuses a name an undo buffer still holds."""
    return f"{prefix}_{uuid.uuid4().hex[:n]}"


def slugify(title):
    # ASCII only, like store.js: a slug is a path segment and a URL, and a
    # non-ASCII one is two different strings depending on who normalised it.
    base = "".join(c if ("a" <= c <= "z" or "0" <= c <= "9") else "-"
                   for c in str(title or "").lower())
    while "--" in base:
        base = base.replace("--", "-")
    return base.strip("-")[:48] or "untitled"


def _handle(value):
    """`value` if it is a safe handle — what new_id mints — else "".

    Not slugify: a slug REPAIRS anything into something, and an id must not be
    quietly repaired into a different document's name. An id either is a handle
    or is replaced with a fresh one and said so.
    """
    s = str(value if value is not None else "")[:64]
    ok = s and all((c.isascii() and c.isalnum()) or c in "_-" for c in s)
    return s if ok else ""


def blank_doc(name="Untitled", width=1920, height=1080, bg=(0, 0, 0, 0)):
    now = time.time()
    title = str(name or "Untitled")[:80]
    return {
        "v": DOC_VERSION,
        "id": new_id("img", 6),
        "slug": slugify(title),
        "name": title,
        "width": int(width),
        "height": int(height),
        "bg": list(bg),                    # rgba 0-255; alpha 0 = transparent
        "layers": [],                      # layers[0] is the BOTTOM
        "createdAt": now,
        "updatedAt": now,
    }


def blank_layer(kind, **patch):
    """A layer of `kind`, with only the keys that kind actually needs.

    Deliberately NOT a full skeleton with every optional key spelled out: an
    absent anchor means "this layer's own centre", resolved at render time when
    the source size is known. Writing a guessed centre into the document is how
    comp.json ends up with layers that swing instead of spinning.
    """
    kind = str(kind)
    if kind not in LAYER_TYPES:
        raise ValueError(f"No layer kind called \"{kind}\". There are "
                         f"{len(LAYER_TYPES)}: {', '.join(LAYER_TYPES)}.")
    layer = {"id": new_id("ly"), "name": patch.get("name") or kind, "type": kind,
             "blend": "normal", "enabled": True, "locked": False,
             "transform": {"opacity": 100}}
    if kind == "image":
        layer["src"] = None
    elif kind == "solid":
        layer["color"] = [255, 255, 255, 255]
    elif kind == "gradient":
        layer["gradient"] = {}
    elif kind == "text":
        layer["text"] = {"content": "TEXT", "font": "arial.ttf", "size": 96,
                         "color": [240, 240, 245, 255], "align": "center",
                         "stroke": 0, "strokeColor": [0, 0, 0, 255],
                         "lineHeight": 1.15, "tracking": 0}
    elif kind == "adjustment":
        layer["effects"] = []
    elif kind == "group":
        layer["layers"] = []
    out = {**layer, **patch, "id": layer["id"], "type": kind}
    return out


def blank_effect(kind, **params):
    return {"id": new_id("fx"), "type": str(kind), "enabled": True, "params": dict(params)}


# ── normalising: repair, never rebuild ───────────────────────────────────────

def _warnlist(warn):
    return warn if isinstance(warn, list) else []


def _int_in(v, lo, hi, fallback):
    return int(min(max(round(_f(v, fallback)), lo), hi))


def normalize(doc, warn=None):
    """A repaired COPY of `doc`, plus a warning per thing that had to be repaired.

    Repair rather than reject, store.js's rule: one malformed layer must not cost
    somebody the other forty.

    What this does NOT do is rebuild a layer from a list of known keys. That is
    IMAGE_SPEC §9's second bullet and store.js has the scar — its `migrateLayer`
    reconstructs `transform` from five names and erased the three 3D rotation
    axes from every comp on every read, for as long as nobody looked. Here every
    key that is present is coerced in place and every key that is not recognised
    is left exactly where it was, so a field this version has never heard of
    survives a round trip through it.
    """
    w = _warnlist(warn)
    if not isinstance(doc, dict):
        raise ValueError("an image document is a JSON object; got "
                         f"{type(doc).__name__}")
    out = copy.deepcopy(doc)
    out["v"] = DOC_VERSION
    out["name"] = str(out.get("name") or "Untitled")[:80]

    # ⚠ THE HANDLES ARE A TRUST BOUNDARY, AND THIS USED TO PASS THEM THROUGH.
    # The old code only filled a slug in when it was MISSING, so a document
    # carrying {"slug": "../../etc/passwd"} kept it, byte for byte, through
    # every round trip. That was harmless while nothing stored a document and
    # stops being harmless the moment one does: `id` is the shelf's key and
    # `slug` is what slugify's own comment calls it — "a path segment and a
    # URL". Repairing them HERE rather than in the shelf is deliberate: this is
    # the one validator, so a document off disk and a document off the wire get
    # the same treatment, and a route that builds `<dir>/<slug>.png` later
    # inherits the guarantee instead of having to remember it.
    ident = _handle(out.get("id"))
    if not ident:
        if out.get("id"):
            w.append(f"doc.id {out['id']!r} is not a handle — letters, digits, "
                     "underscore and hyphen only, so a fresh one was minted")
        ident = new_id("img", 6)
    out["id"] = ident
    slug = slugify(out.get("slug") or out["name"])
    if out.get("slug") and slug != out["slug"]:
        w.append(f"doc.slug {out['slug']!r} is not a slug — a slug is a path "
                 f"segment and a URL, so it was read as \"{slug}\"")
    out["slug"] = slug
    out["width"] = _int_in(out.get("width"), LIMITS["minSize"], LIMITS["maxSize"], 1920)
    out["height"] = _int_in(out.get("height"), LIMITS["minSize"], LIMITS["maxSize"], 1080)
    if not isinstance(out.get("bg"), (list, tuple)):
        out["bg"] = [0, 0, 0, 0]
    if not isinstance(out.get("layers"), list):
        if out.get("layers") is not None:
            w.append("doc.layers was not a list — treated as empty")
        out["layers"] = []
    count = _normalize_layers(out["layers"], w, seen=set(), depth=0)
    if count > LIMITS["maxLayers"]:
        w.append(f"{count} layers is past the {LIMITS['maxLayers']} cap — it will "
                 "render, but nothing else promises to")
    out["updatedAt"] = _f(out.get("updatedAt"), time.time())
    return out


def _normalize_layers(layers, w, seen, depth):
    n = 0
    for i, layer in enumerate(list(layers)):
        if not isinstance(layer, dict):
            w.append(f"layer #{i} is not an object — skipped")
            continue
        n += 1 + _normalize_layer(layer, w, seen, depth)
    # clipping-mask base check: a clipped layer needs a base BENEATH IT IN THIS
    # LIST — the search never crosses a group edge. No base, or an adjustment
    # layer (never painted, so it has no alpha) as the base, is warned here and
    # painted unclipped by render(); the flag itself is left on the layer, so
    # reordering a layer underneath it later makes the clip take without a
    # second edit.
    prev = None
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        if layer.get("clipped"):
            if prev is None:
                w.append(f"layer {layer['id']} ({layer['name']}): clipped, but "
                         "nothing is beneath it in its container — there is no "
                         "base, so it paints unclipped")
            elif prev.get("type") == "adjustment":
                w.append(f"layer {layer['id']} ({layer['name']}): clipped to an "
                         "adjustment layer, which is never painted and has no "
                         "alpha to clip to — it paints unclipped")
        else:
            prev = layer
    return n


def _normalize_layer(layer, w, seen, depth):
    layer.setdefault("id", new_id("ly"))
    kind = str(layer.get("type") or "image")
    if kind not in LAYER_TYPES:
        # store.js coerces this silently. Silence is exactly how a kind the
        # engine could draw came back off disk as a white rectangle, so say it.
        w.append(f"layer {layer['id']}: no kind called \"{kind}\" — read as a solid")
        kind = "solid"
    layer["type"] = kind
    layer["name"] = str(layer.get("name") or kind)[:80]

    blend = str(layer.get("blend") or "normal")
    if blend not in BLEND_MODES:
        w.append(f"layer {layer['id']}: no blend mode called \"{blend}\" — painted "
                 f"as normal. The {len(BLEND_MODES)} real ones are in the catalog.")
        blend = "normal"
    if kind == "adjustment" and blend != "normal":
        # An adjustment layer is never painted, so a blend on one is a switch
        # with no wire behind it. Saying so beats honouring it in the schema.
        w.append(f"layer {layer['id']}: an adjustment layer is never drawn, so its "
                 f"blend mode (\"{blend}\") does nothing")
    layer["blend"] = blend
    layer["enabled"] = layer.get("enabled") is not False
    layer["locked"] = bool(layer.get("locked"))
    if "clipped" in layer:
        # Coerced only when PRESENT — an absent flag stays absent, so a
        # document written before clipping existed round-trips byte-identical.
        layer["clipped"] = bool(layer.get("clipped"))

    if kind == "adjustment" and layer.get("styles"):
        w.append(f"layer {layer['id']}: layer styles need pixels of their own; an "
                 "adjustment layer has none, so they are ignored")

    t = layer.get("transform")
    if not isinstance(t, dict):
        if t is not None:
            w.append(f"layer {layer['id']}: transform was not an object — defaulted")
        t = {}
        layer["transform"] = t
    # Only what is PRESENT is coerced. An absent anchor is not a missing value,
    # it is "the layer's own centre", and render() is the only place that knows
    # what that is.
    if "opacity" in t:
        op = _f(t.get("opacity"), 100.0)
        if op != t.get("opacity"):
            w.append(f"layer {layer['id']}: opacity {t.get('opacity')!r} is not a "
                     "number — read as 100")
        t["opacity"] = min(100.0, max(0.0, op))
    for key in ("anchor", "position", "scale"):
        if key in t and not isinstance(t[key], (list, tuple)):
            w.append(f"layer {layer['id']}: transform.{key} is a pair — defaulted")
            del t[key]
    if "rotation" in t:
        t["rotation"] = _f(t.get("rotation"), 0.0)

    fx = layer.get("effects")
    if fx is not None and not isinstance(fx, list):
        w.append(f"layer {layer['id']}: effects is a list — ignored")
        layer["effects"] = []
    elif isinstance(fx, list):
        for spec in fx:
            if isinstance(spec, dict):
                spec.setdefault("id", new_id("fx"))
        if len(fx) > LIMITS["effectsPerLayer"]:
            w.append(f"layer {layer['id']}: {len(fx)} effects is past the "
                     f"{LIMITS['effectsPerLayer']} cap")

    m = layer.get("mask")
    if m is not None and not isinstance(m, dict):
        w.append(f"layer {layer['id']}: mask is an object — ignored")
        layer["mask"] = None

    if kind != "group":
        return 0
    kids = layer.get("layers")
    if not isinstance(kids, list):
        if kids is not None:
            w.append(f"group {layer['id']}: layers was not a list — treated as empty")
        kids = []
        layer["layers"] = kids
    key = id(layer)
    if key in seen:
        # Only reachable in memory, by aliasing the same dict into two places.
        # It is still worth catching here rather than at render: this is the one
        # document shape that turns a render into a hang.
        w.append(f"group {layer['id']}: is inside itself — the nested copy is dropped")
        layer["layers"] = []
        return 0
    if depth >= LIMITS["maxDepth"]:
        w.append(f"group {layer['id']}: nested past {LIMITS['maxDepth']} — children dropped")
        layer["layers"] = []
        return 0
    seen.add(key)
    try:
        return _normalize_layers(kids, w, seen, depth + 1)
    finally:
        seen.discard(key)


# ── finding and editing: pure functions on a document ────────────────────────
#
# Every one of these deep-copies first and returns the copy. Undo is then a list
# of documents and costs nothing to implement, which is the point of having a
# document at all.

def walk(doc_or_layers):
    """Every layer in the tree, depth-first, bottom-up, groups before children."""
    # .get, not ["layers"]: a document with no layers key is an EMPTY document,
    # and KeyError("layers") on the way into a layer count names nothing a
    # caller can act on. normalize() guarantees the key; these edits are also
    # called straight from python on a dict somebody built by hand.
    layers = doc_or_layers.get("layers") if isinstance(doc_or_layers, dict) else doc_or_layers
    for layer in layers or []:
        if not isinstance(layer, dict):
            continue
        yield layer
        if layer.get("type") == "group":
            for kid in walk(layer.get("layers") or []):
                yield kid


def find_layer(doc, ref):
    """(layer, siblings, index) for an id, or for a name if it is unambiguous.

    A name is what a person and an agent actually have in hand; picking the
    first of four layers called "text" is worse than making the caller say
    which, so an ambiguous name raises with the ids listed.
    """
    want = str(ref if ref is not None else "")
    hits_by_name = []
    stack = [(doc.get("layers") or [])]
    while stack:
        siblings = stack.pop()
        for i, layer in enumerate(siblings):
            if not isinstance(layer, dict):
                continue
            if layer.get("id") == want:
                return layer, siblings, i
            if layer.get("name") == want:
                hits_by_name.append((layer, siblings, i))
            if layer.get("type") == "group" and isinstance(layer.get("layers"), list):
                stack.append(layer["layers"])
    if len(hits_by_name) == 1:
        return hits_by_name[0]
    if len(hits_by_name) > 1:
        ids = ", ".join(str(h[0].get("id")) for h in hits_by_name)
        raise ValueError(f"{len(hits_by_name)} layers are called \"{want}\" — use "
                         f"the id: {ids}")
    have = ", ".join(f"{l.get('id')} ({l.get('name')})" for l in walk(doc)) or "no layers"
    raise ValueError(f"No such layer: {want}. This document has {have}.")


def _whole(value, what):
    """An index, or a refusal that names the argument and what a good one is.

    `int(None)` is a TypeError reading "int() argument must be a string, a
    bytes-like object or a real number" — true, and useless to somebody who sent
    an ops list with a field spelled wrong. Every index that crosses the JSON
    seam comes through here.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(
            f"{what} must be a whole number: 0 is the BOTTOM of the container "
            f"and layers count up from there. Got {value!r}.") from None


def _container(doc, parent):
    """The list a layer should go into: the document's, or a group's."""
    if parent in (None, ""):
        # setdefault, not doc["layers"]: normalize() guarantees the key, but
        # these edits are also called straight from python on a dict somebody
        # built by hand, and a bare KeyError("layers") names nothing.
        return doc.setdefault("layers", [])
    group, _sib, _i = find_layer(doc, parent)
    if group.get("type") != "group":
        raise ValueError(f"{group.get('id')} ({group.get('name')}) is a "
                         f"{group.get('type')}, not a group - only a group holds layers")
    if not isinstance(group.get("layers"), list):
        group["layers"] = []
    return group["layers"]


def _touch(doc):
    doc["updatedAt"] = time.time()
    return doc


def _count(doc):
    return sum(1 for _ in walk(doc))


def _seeded_layer(layer):
    """blank_layer's defaults for the kind, with the caller's fields merged over.

    ⚠ WITHOUT THE SEEDING A TEXT LAYER ADDED OVER A JSON SEAM DRAWS NOTHING.
    `{"type": "text", "name": "title"}` is what every caller that is not python
    sends, because blank_layer() is a python function and a route is not — and
    that layer has no `text` block at all. It normalises clean, renders zero
    pixels, and reads as a layer that failed rather than a layer that was never
    given any content. Seeding costs one dict merge and removes the whole class.

    Merged one level down, update_layer's rule, so `{"text": {"size": 140}}`
    changes the size and keeps the font, the colour and the alignment.
    """
    if not isinstance(layer, dict):
        raise ValueError(
            "a layer is an object like {\"type\": \"text\", \"name\": \"title\"}; "
            f"got {type(layer).__name__}.")
    if not layer.get("type"):
        raise ValueError(
            "that layer has no `type`, so there is no telling what to draw. The "
            f"{len(LAYER_TYPES)} kinds are: {', '.join(LAYER_TYPES)}.")
    seed = blank_layer(layer["type"])      # refuses a kind that does not exist
    out = dict(seed)
    for key, value in layer.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = {**out[key], **value}
        else:
            out[key] = copy.deepcopy(value)
    out["id"] = _handle(layer.get("id")) or seed["id"]
    return out


def add_layer(doc, layer, parent=None, index=None):
    """`layer` inserted at `index` (default: the top of that container)."""
    out = copy.deepcopy(doc)
    if _count(out) >= LIMITS["maxLayers"]:
        raise ValueError(f"this document already holds {LIMITS['maxLayers']} layers")
    at = None if index is None else _whole(index, "add_layer's `index`")
    box = _container(out, parent)
    lay = _seeded_layer(layer)
    if any(l.get("id") == lay["id"] for l in walk(out)):
        lay["id"] = new_id("ly")           # never two of the same handle
    box.insert(len(box) if at is None else max(0, min(len(box), at)), lay)
    return _touch(out)


def remove_layer(doc, ref):
    out = copy.deepcopy(doc)
    _layer, siblings, i = find_layer(out, ref)
    siblings.pop(i)
    return _touch(out)


def reorder_layer(doc, ref, index):
    """Move a layer within its own container. `index` is bottom-up, 0 = bottom."""
    out = copy.deepcopy(doc)
    at = _whole(index, "reorder_layer's `index`")
    layer, siblings, i = find_layer(out, ref)
    siblings.pop(i)
    siblings.insert(max(0, min(len(siblings), at)), layer)
    return _touch(out)


def move_layer(doc, ref, parent=None, index=None):
    """Regroup: the same layer, in a different container.

    Refuses to move a group inside itself. A containment tree cannot express
    that, so the alternative is not a strange document but a render that never
    returns.
    """
    out = copy.deepcopy(doc)
    at = None if index is None else _whole(index, "move_layer's `index`")
    layer, siblings, i = find_layer(out, ref)
    if layer.get("type") == "group" and parent not in (None, ""):
        target, _s, _i = find_layer(out, parent)
        if target is layer or any(k is target for k in walk([layer])):
            raise ValueError(f"{layer['id']} ({layer['name']}) cannot go inside "
                             "itself or one of its own children")
    siblings.pop(i)
    box = _container(out, parent)
    box.insert(len(box) if at is None else max(0, min(len(box), at)), layer)
    return _touch(out)


def duplicate_layer(doc, ref, name=None):
    """A copy directly above the original, with fresh ids all the way down.

    Fresh ids for the children too: a duplicated group whose children keep their
    ids gives find_layer two answers to the same question, and every later edit
    is a coin flip.
    """
    out = copy.deepcopy(doc)
    layer, siblings, i = find_layer(out, ref)
    dupe = copy.deepcopy(layer)
    for l in walk([dupe]):                 # walk() yields the layer itself first
        l["id"] = new_id("ly")
        for spec in (l.get("effects") or []):
            if isinstance(spec, dict):
                spec["id"] = new_id("fx")
    dupe["name"] = str(name) if name else f"{layer.get('name') or 'layer'} copy"
    siblings.insert(i + 1, dupe)
    return _touch(out)


def group_layers(doc, refs, name="group"):
    """Wrap existing layers in a new group, in the order given.

    Only layers that already share a container can be grouped — grouping across
    two different parents means silently moving one of them somewhere it was not,
    and a Layers panel that does that loses work.

    ⚠ THERE IS NO `parent` HERE, AND THE ONE THERE USED TO BE DID NOTHING.
    The old signature took `parent=None` and never read it: pass a group's name
    and the new group still appeared beside the layers it wrapped, silently.
    Nor could it ever mean anything — the picked layers go INSIDE the new group,
    so the group has to appear where they were, which is the paragraph above.
    A caller who wants it elsewhere calls move_layer on it afterwards, which is
    a gesture somebody chose rather than an argument that quietly lied.
    """
    out = copy.deepcopy(doc)
    wanted = list(refs or [])
    picked = [find_layer(out, r) for r in wanted]
    if not picked:
        raise ValueError("group_layers needs at least one layer")
    # The same layer twice used to reach `sib.remove()` twice and come back as
    # "list.remove(x): x not in list" — a python message about a list the caller
    # has never seen, for a mistake that is one word long.
    named_by = {}
    for ref, (layer, _s, _i) in zip(wanted, picked):
        if id(layer) in named_by:
            raise ValueError(
                f"{layer.get('id')} ({layer.get('name')}) is in that list twice, "
                f"as \"{named_by[id(layer)]}\" and \"{ref}\" — name each layer "
                "once. The order you name them in is the order they end up in.")
        named_by[id(layer)] = ref
    boxes = {id(sib) for _l, sib, _i in picked}
    if len(boxes) > 1:
        raise ValueError("those layers are in different groups — move them into "
                         "one container first, so nothing changes parent by accident")
    siblings = picked[0][1]
    lowest = min(i for _l, _s, i in picked)
    for layer, sib, _i in picked:
        sib.remove(layer)
    group = blank_layer("group", name=str(name))
    group["layers"] = [l for l, _s, _i in picked]
    siblings.insert(max(0, min(len(siblings), lowest)), group)
    return _touch(out)


def ungroup_layer(doc, ref):
    """Dissolve a group, leaving its children where the group was.

    The group's own opacity, blend, mask and styles are LOST, and that is the
    honest outcome: they described the group as a composited unit and there is
    no unit any more. Multiplying them into each child would change the picture
    wherever the children overlap — which is the exact difference this whole
    module exists to get right.
    """
    out = copy.deepcopy(doc)
    group, siblings, i = find_layer(out, ref)
    if group.get("type") != "group":
        raise ValueError(f"{group['id']} ({group['name']}) is a {group['type']}, "
                         "not a group")
    siblings.pop(i)
    for offset, kid in enumerate(group.get("layers") or []):
        siblings.insert(i + offset, kid)
    return _touch(out)


def set_clipped(doc, ref, clipped=True):
    """Clip a layer to the one beneath it, or release it — the document half of
    Photoshop's alt-click on the border between two layers.

    Clipping is REFUSED where render() could only ignore it: at the bottom of a
    container there is nothing beneath to clip to, and an adjustment layer
    directly resolving as the base is never painted and so has no alpha. (A
    loaded document carrying either state is repaired with a warning instead —
    normalize()'s rule — but an EDIT that could only ever warn is a refusal.)
    Releasing always succeeds.
    """
    out = copy.deepcopy(doc)
    layer, siblings, i = find_layer(out, ref)
    if not clipped:
        layer["clipped"] = False
        return _touch(out)
    base = None
    for k in range(i - 1, -1, -1):
        if isinstance(siblings[k], dict) and not siblings[k].get("clipped"):
            base = siblings[k]
            break
    if base is None:
        raise ValueError(
            f"{layer['id']} ({layer.get('name')}) has nothing beneath it in its "
            "container to clip to — the bottom layer of a document or group "
            "cannot be clipped. Move a layer underneath it first.")
    if base.get("type") == "adjustment":
        raise ValueError(
            f"{layer['id']} ({layer.get('name')}) would clip to "
            f"{base['id']} ({base.get('name')}), an adjustment layer — which is "
            "never painted and has no alpha to clip to. Clipping the adjustment "
            "layer TO a pixel base is the move that works.")
    layer["clipped"] = True
    return _touch(out)


def update_layer(doc, ref, patch):
    """Merge `patch` into a layer. MERGE — the id and the type never move.

    Dict-valued keys merge one level down, so {"transform": {"opacity": 50}}
    changes the opacity and leaves the position alone. Replacing the whole
    sub-object is IMAGE_SPEC §9's second bullet in miniature and it is the
    single most common way a UI silently resets a layer.
    """
    out = copy.deepcopy(doc)
    layer, _sib, _i = find_layer(out, ref)
    for key, value in (patch or {}).items():
        if key in ("id", "type"):
            continue
        if isinstance(value, dict) and isinstance(layer.get(key), dict):
            layer[key] = {**layer[key], **value}
        else:
            layer[key] = copy.deepcopy(value)
    return _touch(out)


# ── the shelf: where a document lives between sessions ───────────────────────
#
# ⚠ WITHOUT THIS, EVERY EDIT ABOVE IS UNREACHABLE. Before the shelf,
# find_layer, add_layer, remove_layer, reorder_layer, move_layer,
# duplicate_layer, group_layers, ungroup_layer, set_clipped and update_layer had
# exactly one caller between them and it was imgdoc_test.py — grep any of the
# ten across .py and .js and every other hit belongs to the COMP document in
# server/vfx/, which is a different document with the same verbs. Ten editing
# functions nobody can call is IMAGE_SPEC §9's first bullet, "a module nobody
# calls", and the user-visible half of it is worse: with nowhere to put a
# document, "make the title bigger" means re-sending forty layers of JSON to
# change one number, and a cover, a poster, a lyric card and a character sheet
# are all iterated over days.
#
# ONE JSON FILE, not a folder of them: `_documents.json` in whatever directory
# the job names, the same decision server/index.js made for `_presets.json` and
# `_swatches.json` and server/vfx/store.js made for `_fx_presets.json`, for the
# same stated reason — server-side and in one place is what lets MCP and the UI
# see the SAME shelf.
#
# The cost of one file is measured, not guessed. A shelf at BOTH caps — 200
# documents of 256 text layers, the heaviest per-layer JSON this document has —
# is 16.7 MB, and 1.0-1.2 s to read back against 2.0-2.4 s to write over four
# runs on this rig (imgdoc_test.py's bench_shelf builds exactly that and prints
# all three every lane). A realistic shelf, 200 covers of a dozen layers each,
# is 0.44 MB. So the whole-file rewrite every save does is affordable today,
# and what it buys is that a save is one os.replace and can never leave half a
# shelf behind.
# Splitting into a file per document is a change to the four functions below
# and to nothing else in this module.

SHELF_FILE = "_documents.json"
SHELF_VERSION = 1


def _shelf_path(job):
    """<dir>/_documents.json, absolute.

    `dir` is a JOB FIELD with no default on purpose. server/config.js owns
    every directory this app writes to; this module has never imported it and
    a hardcoded path here would be a second opinion about where the images live.
    """
    raw = job.get("dir")
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(
            "this job needs a `dir`: the folder the document shelf lives in. "
            "imgdoc.py never picks one, because server/config.js owns where "
            "this app writes and there must not be a second answer.")
    return os.path.join(os.path.abspath(os.path.expanduser(raw.strip())), SHELF_FILE)


def _read_shelf(path):
    """The shelf document, or an empty one when the file is not there yet.

    ⚠ A FILE THAT EXISTS AND DOES NOT PARSE IS AN ERROR, NEVER A RESEED.
    store.js's rule, and the reason is that reseeding answers a trailing comma
    by deleting somebody's work. Missing is fine; unreadable is not.
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return {"v": SHELF_VERSION, "documents": {}}
    if size > LIMITS["shelfBytes"]:
        raise ValueError(
            f"the document shelf ({path}) is {size / (1024 * 1024):.0f} MB, past "
            f"the {LIMITS['shelfBytes'] // (1024 * 1024)} MB this will read in one "
            "bite. Move that file aside before saving another document.")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            shelf = json.load(fh)
    except json.JSONDecodeError as exc:
        raise ValueError(f"the document shelf ({path}) is not valid JSON: {exc}. "
                         "Nothing was written — fix or move that file.") from None
    if not isinstance(shelf, dict) or not isinstance(shelf.get("documents"), dict):
        raise ValueError(f"the document shelf ({path}) does not hold a "
                         "{\"documents\": {...}} object.")
    return shelf


def _write_shelf(path, shelf):
    """Write a temp file, then rename over the shelf — never half a file.

    ⚠ os.replace, not os.rename: on Windows renaming onto a file that exists
    raises FileExistsError, so every save after the first would fail, and this
    app's rig is Windows.
    """
    shelf["v"] = SHELF_VERSION
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(shelf, fh, ensure_ascii=False)
    os.replace(tmp, path)


def _handles_of(did, doc):
    """(id, slug) for a stored document, repaired — normalize()'s two lines.

    ⚠ A SUMMARY ROW IS NOT A DOCUMENT AND MUST NOT BE TRUSTED LIKE ONE.
    `list` deliberately does not normalize: repairing 200 documents to draw a
    picker means deep-copying every layer of every one of them, 16.7 MB of it
    at the caps. But reading the stored `slug` straight out of the file and
    handing it to a caller is how the trust boundary leaks anyway — the first
    version of this did exactly that, and a shelf edited by hand to hold
    "../../etc/passwd" listed it back verbatim, ready for whatever builds a
    path or a URL out of a picker row. So the row repairs the two fields that
    ARE handles, with normalize()'s own functions rather than a second opinion
    about what a handle is. Everything else in a row is display text.
    """
    return _handle(doc.get("id")) or did, slugify(doc.get("slug") or doc.get("name"))


def _pick(shelf, ref):
    """(id, stored document) for an id or a slug — find_layer's rule, one level up.

    A slug is what a person and an agent actually have in hand, the same
    argument find_layer makes about a layer name. Neither handle can be
    ambiguous: ids are minted unique and _free_slug keeps slugs unique too.
    The slug is matched REPAIRED, so a caller who saw a row in `list` can ask
    for the document by the slug that row showed them.
    """
    docs = shelf["documents"]
    want = str(ref if ref is not None else "").strip()
    if want and want in docs:
        return want, docs[want]
    for did, d in docs.items():
        if want and isinstance(d, dict) and _handles_of(did, d)[1] == want:
            return did, d
    have = ", ".join(f"{k} ({_handles_of(k, v)[1]})" for k, v in docs.items()
                     if isinstance(v, dict)) or "nothing yet"
    raise ValueError(f"No document called \"{want}\" on that shelf. It holds: {have}.")


def _free_slug(docs, slug, own_id):
    """`slug`, or the first "-2", "-3"... no OTHER document on the shelf is using.

    Unique because _pick() takes a slug as a handle: two documents called
    "cover" and the handle has stopped naming one of them.
    """
    taken = {d.get("slug") for k, d in docs.items()
             if isinstance(d, dict) and k != own_id}
    if slug not in taken:
        return slug
    stem = slug[:44]
    for n in range(2, LIMITS["shelfDocs"] + 2):
        if f"{stem}-{n}" not in taken:
            return f"{stem}-{n}"
    return f"{stem}-{own_id}"                  # an id is unique by construction


def _summary(did, doc):
    """A shelf row: what a picker shows, without the tree behind it."""
    ident, slug = _handles_of(did, doc)
    return {"id": ident, "slug": slug, "name": str(doc.get("name") or "Untitled")[:80],
            "width": doc.get("width"), "height": doc.get("height"),
            # walk() indexes "layers" and a hand-written shelf entry need not
            # have one; a picker must not die counting somebody else's typo.
            "layers": _count(doc) if isinstance(doc.get("layers"), list) else 0,
            "createdAt": doc.get("createdAt"), "updatedAt": doc.get("updatedAt")}


def _outline(layers, depth=0):
    """One flat row per layer, groups descended, `depth` for the indent.

    What an edit answers with instead of the document. The whole point of a
    stored document is that a caller stops shipping the tree in both
    directions; shipping it back on every edit would give half of that up. Ask
    for the tree with `"doc": true` when it is actually wanted.
    """
    rows = []
    for layer in layers or []:
        if not isinstance(layer, dict):
            continue
        row = {"id": layer.get("id"), "name": layer.get("name"),
               "type": layer.get("type"), "depth": depth,
               "enabled": layer.get("enabled") is not False}
        if layer.get("clipped"):
            row["clipped"] = True
        rows.append(row)
        if layer.get("type") == "group":
            rows += _outline(layer.get("layers"), depth + 1)
    return rows


# ── edit: a list of mutations, applied to a stored document ──────────────────
#
# The ops are named after the functions they call, so a refusal from one of them
# reads as a refusal from the op and there is no second vocabulary to learn.
# find_layer and walk are not here: they change nothing, and `store open`
# already hands back the tree.

def _ref(spec, op=""):
    """The layer an op names: `ref`, or `id`, or `name`.

    Three spellings of ONE thing, because find_layer already resolves an id or a
    name and a caller reaches for whichever it is holding. `index` is not among
    them and must not be: on add_layer, reorder_layer and move_layer an `index`
    is already the DESTINATION, and a field meaning "which layer" on some ops and
    "put it here" on others is a wrong layer moved silently.

    ⚠ `name` IS NOT A HANDLE ON duplicate_layer, WHERE IT IS THE COPY'S NAME.
    One field cannot mean both "which layer" and "call it this", so that one op
    refuses rather than guessing — a duplicate that lands on the wrong layer
    looks like nothing happened, and is found much later.
    """
    for key in ("ref", "id"):
        if spec.get(key) not in (None, ""):
            return spec[key]
    if spec.get("name") not in (None, ""):
        if op == "duplicate_layer":
            raise ValueError(
                "duplicate_layer's `name` is what to CALL the copy, not which "
                "layer to copy. Say which with `ref` — an id, or a layer name "
                "if only one layer has it.")
        return spec["name"]
    raise ValueError("this op needs a `ref`: a layer id, or a layer name if "
                     "only one layer is called that.")


EDIT_OPS = {
    "add_layer":       lambda d, s: add_layer(d, s.get("layer"), s.get("parent"),
                                              s.get("index")),
    "remove_layer":    lambda d, s: remove_layer(d, _ref(s)),
    "reorder_layer":   lambda d, s: reorder_layer(d, _ref(s), s.get("index")),
    "move_layer":      lambda d, s: move_layer(d, _ref(s), s.get("parent"),
                                               s.get("index")),
    "duplicate_layer": lambda d, s: duplicate_layer(d, _ref(s, "duplicate_layer"),
                                                    s.get("name")),
    "group_layers":    lambda d, s: group_layers(d, s.get("refs"),
                                                 s.get("name") or "group"),
    "ungroup_layer":   lambda d, s: ungroup_layer(d, _ref(s)),
    "set_clipped":     lambda d, s: set_clipped(d, _ref(s),
                                                s.get("clipped") is not False),
    "update_layer":    lambda d, s: update_layer(d, _ref(s), s.get("patch")),
}


def apply_edits(doc, ops):
    """(`doc` with every op applied in order, the names applied) — or nothing.

    ⚠ ALL OF THEM OR NONE OF THEM. Every op returns a NEW document, so the
    half-applied case costs one local variable to avoid, and the alternative is
    a shelf holding a document that is neither what it was nor what was asked
    for — with no way back, because the undo buffer the edits above were written
    for lives in the caller and nobody has built one yet.
    """
    if not isinstance(ops, list) or not ops:
        raise ValueError(
            "an edit needs a non-empty `ops` list, like [{\"op\": "
            "\"update_layer\", \"ref\": \"title\", \"patch\": {\"text\": "
            f"{{\"size\": 140}}}}]. The {len(EDIT_OPS)} ops are: "
            f"{', '.join(sorted(EDIT_OPS))}.")
    out = doc
    applied = []
    for n, spec in enumerate(ops, 1):
        if not isinstance(spec, dict):
            raise ValueError(f"op #{n} is a {type(spec).__name__}, not an object "
                             "like {\"op\": \"remove_layer\", \"ref\": \"title\"}.")
        name = str(spec.get("op") or "")
        fn = EDIT_OPS.get(name)
        if fn is None:
            raise ValueError(f"op #{n}: there is no edit called \"{name}\". The "
                             f"{len(EDIT_OPS)} there are: "
                             f"{', '.join(sorted(EDIT_OPS))}.")
        try:
            out = fn(out, spec)
        except ValueError as exc:
            raise ValueError(f"op #{n} ({name}) was refused: {exc} Nothing was "
                             "saved — the whole list is one edit.") from None
        applied.append(name)
    return out, applied


# ── sources ──────────────────────────────────────────────────────────────────

def as_rgba(value):
    """Anything a resolver hands back, as float32 (H, W, 4) 0..1 straight alpha."""
    if value is None:
        return None
    if isinstance(value, str):
        from PIL import Image                            # noqa: PLC0415
        with Image.open(value) as im:
            return np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0
    arr = np.asarray(value)
    if arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise ValueError("a source is (H, W, 3) or (H, W, 4); got "
                         f"{tuple(arr.shape)}")
    if not np.issubdtype(arr.dtype, np.floating):
        # An integer array is 0..255, not 0..1 — effects.py refuses the same
        # mistake for the same reason: casting it renders a white frame.
        arr = arr.astype(np.float32) / 255.0
    else:
        arr = arr.astype(np.float32, copy=False)
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones(arr.shape[:2] + (1,), np.float32)], axis=2)
    return np.ascontiguousarray(np.clip(arr, 0.0, 1.0))


def resolver_for(sources):
    """A resolver over a {library name: path-or-array} map, decoding once.

    A name that is not in the map is None, never a guess and never a path this
    process assembled: engine.py's rule, and the reason a document can hold a
    hostile `src` without it meaning anything.
    """
    cache = {}
    table = dict(sources or {})

    def resolve(name):
        key = os.path.basename(str(name or ""))
        if key not in cache:
            cache[key] = as_rgba(table.get(key))
        return cache[key]
    return resolve


# ── rendering ────────────────────────────────────────────────────────────────

class _Ctx:
    __slots__ = ("doc", "W", "H", "scale", "resolve", "rep", "stack")

    def __init__(self, doc, W, H, scale, resolve, rep):
        self.doc, self.W, self.H = doc, W, H
        self.scale, self.resolve, self.rep = scale, resolve, rep
        self.stack = set()

    def warn(self, msg):
        self.rep["warnings"].append(msg)


def _resize(rgba, w, h):
    """Premultiplied resample. Straight-alpha averaging drags the colour of
    fully transparent pixels into every soft edge; this is the one place in the
    module where the alpha is not straight, and it is undone on the next line."""
    if (rgba.shape[1], rgba.shape[0]) == (w, h):
        return rgba
    pm = rgba.copy()
    pm[..., :3] *= pm[..., 3:4]
    interp_flag = cv2.INTER_AREA if w * h < rgba.shape[0] * rgba.shape[1] else cv2.INTER_LINEAR
    out = cv2.resize(pm, (w, h), interpolation=interp_flag)
    return engine._unpremul(np.ascontiguousarray(out, dtype=np.float32), inplace=True)


def _plate_size(layer, key, ctx):
    """A generated layer's own size: what it says, or the whole canvas."""
    size = (layer.get(key) if isinstance(layer.get(key), (list, tuple)) else None)
    nw = int(_f(size[0], 0)) if size and len(size) >= 1 else 0
    nh = int(_f(size[1], 0)) if size and len(size) >= 2 else 0
    if nw < 1 or nh < 1:
        return ctx.doc["width"], ctx.doc["height"]
    return min(nw, LIMITS["maxSize"]), min(nh, LIMITS["maxSize"])


def _source_pixels(layer, ctx, depth):
    """(rgba at render resolution, native width, native height), or None.

    Native size is in DOCUMENT pixels, not render pixels: the transform matrix
    below is expressed in document pixels and only its translation is scaled,
    which is engine.py's scheme and the only one where a preview and a full
    render place a layer identically.
    """
    kind = layer["type"]
    s = ctx.scale

    if kind == "image":
        name = layer.get("src")
        px = None
        if name and ctx.resolve is not None:
            try:
                px = as_rgba(ctx.resolve(name))
            except Exception as exc:                     # noqa: BLE001
                ctx.warn(f"layer {layer['id']}: source \"{name}\" would not load: {exc}")
                px = None
        if px is None:
            # Not fatal, and not silent either. A document that lost one image
            # must still open and still show the other thirty layers, but the
            # missing name has to reach the caller or "my layer vanished" has no
            # answer.
            ctx.rep["missing"].append(str(name or ""))
            ctx.warn(f"layer {layer['id']} ({layer['name']}): no source called "
                     f"\"{name}\" — the layer is skipped")
            return None
        nh, nw = px.shape[:2]
        return _resize(px, max(1, round(nw * s)), max(1, round(nh * s))), nw, nh

    if kind == "group":
        inner = np.zeros((ctx.H, ctx.W, 4), dtype=np.float32)
        _composite(inner, layer.get("layers") or [], ctx, depth + 1)
        # Already at render resolution and already in canvas space: the group's
        # own transform then moves the composited unit, not its children.
        return inner, ctx.doc["width"], ctx.doc["height"]

    if kind == "solid":
        nw, nh = _plate_size(layer, "size", ctx)
        w, h = max(1, round(nw * s)), max(1, round(nh * s))
        px = np.empty((h, w, 4), dtype=np.float32)
        px[:] = _rgba01(layer.get("color"), (1.0, 1.0, 1.0, 1.0))
        return px, nw, nh

    if kind == "gradient":
        nw, nh = _plate_size(layer, "size", ctx)
        w, h = max(1, round(nw * s)), max(1, round(nh * s))
        px = np.ones((h, w, 4), dtype=np.float32)
        spec = layer.get("gradient") if isinstance(layer.get("gradient"), dict) else {}
        # mode/opacity are forced: the layer's own blend and opacity say the same
        # thing one level up, and two spellings for one knob is a support ticket.
        params = {k: v for k, v in spec.items() if k not in ("mode", "opacity")}
        params.update({"mode": "normal", "opacity": 100})
        out = effects.apply("ramp", px, params, _fx_ctx(layer, w, h, ctx))
        return np.ascontiguousarray(out, dtype=np.float32), nw, nh

    if kind == "text":
        nw, nh = _plate_size(layer, "size", ctx)
        w, h = max(1, round(nw * s)), max(1, round(nh * s))
        px = engine._render_text(layer, w, h, s)
        return np.ascontiguousarray(px, dtype=np.float32).copy(), nw, nh

    if kind == "adjustment":
        # Only its ALPHA is read — as the region the adjustment reaches — so an
        # opaque plate goes through the identical mask and transform path a
        # solid does, and a masked adjustment layer needs no special case.
        nw, nh = _plate_size(layer, "size", ctx)
        w, h = max(1, round(nw * s)), max(1, round(nh * s))
        return np.ones((h, w, 4), dtype=np.float32), nw, nh

    return None


def _fx_ctx(layer, w, h, ctx):
    """The ctx effects.py expects. A still has no history and no instant, so the
    time-reading effects get an empty one and honestly do nothing — imagetools
    already made that call and this must not disagree with it."""
    return {"history": lambda n=1: [], "t": 0.0, "time": 0.0, "fps": 1.0,
            "width": w, "height": h, "draft": False, "layer": layer,
            "scale": ctx.scale}


# The names a still cannot honour, read ONCE off the catalog's own
# needsHistory/needsTimeline flags via imagetools — one answer for every
# still pipeline, so a time-reading effect added over there cannot silently
# render identity here.
_TIMELINE = imagetools.timeline_effects(effects)


def _apply_effects(rgba, layer, ctx):
    stack = layer.get("effects") or []
    if not stack:
        return rgba
    h, w = rgba.shape[:2]
    # A copy before the stack runs: _resize and _render_text can both hand back
    # a shared or cached array, and one effect that writes in place would poison
    # it for every later layer that names the same source.
    rgba = rgba.copy()
    fxc = _fx_ctx(layer, w, h, ctx)
    for spec in stack:
        if not isinstance(spec, dict) or spec.get("enabled") is False:
            continue
        name = str(spec.get("type") or "")
        if name not in effects.CATALOG:
            ctx.warn(f"layer {layer['id']}: no effect called \"{name}\". There are "
                     f"{len(effects.CATALOG)}; the catalog lists them.")
            continue
        if name in _TIMELINE:
            ctx.warn(f"layer {layer['id']}: \"{name}\" reads a timeline and a still "
                     "has none — it did nothing")
            continue
        try:
            out = effects.apply(name, rgba, spec.get("params") or {}, fxc)
        except Exception as exc:                         # noqa: BLE001
            ctx.warn(f"layer {layer['id']}: effect \"{name}\" failed: {exc}")
            continue
        if isinstance(out, np.ndarray) and out.shape == rgba.shape:
            rgba = np.ascontiguousarray(out, dtype=np.float32)
    return rgba


def _style_pad(styles, scale):
    """How far past its own edge a layer's styles will reach.

    effects.py's dropShadow and stroke draw INSIDE the array they are handed, so
    a shadow on an un-padded layer is cut off at the layer's bounding box —
    engine.py has the same hole and gets away with it because its layers are
    usually comp-sized. Growing the bitmap first is cheaper than explaining why
    half a shadow is missing.
    """
    pad = 0.0
    for name, spec in (styles or {}).items():
        if not isinstance(spec, dict) or spec.get("enabled") is False:
            continue
        d = STYLE_CATALOG.get(name, {}).get("params", {})

        def g(key, dflt=0.0):
            return abs(_f(spec.get(key), _f(d.get(key, {}).get("default"), dflt)))
        if name == "dropShadow":
            pad = max(pad, g("distance", 12) + g("size", 10) + g("spread") + 4)
        elif name == "outerGlow":
            pad = max(pad, g("size", 16) + g("spread") + 4)
        elif name == "stroke" and str(spec.get("position") or "outside") != "inside":
            pad = max(pad, g("size", 4) + g("feather") + 2)
    return int(math.ceil(pad * scale))


def _apply_styles(rgba, layer, ctx, pad=None):
    """The layer's styles, in Photoshop's order, in the layer's own pixels.

    Before the transform, which is the half that matters: a shadow computed off
    the layer's own matte is carried through the rotation with the layer. Run
    them after and every style is a screen-space decal that ignores what the
    layer is doing.

    `pad` overrides the computed growth. _clip_unit passes 0: its buffer is
    already the whole canvas, and anything a style would draw past the canvas
    edge is exactly what the canvas edge was going to crop anyway.
    """
    styles = layer.get("styles")
    if not isinstance(styles, dict) or not styles:
        return rgba, 0
    if pad is None:
        pad = _style_pad(styles, ctx.scale)
    if pad:
        h, w = rgba.shape[:2]
        grown = np.zeros((h + pad * 2, w + pad * 2, 4), dtype=np.float32)
        grown[pad:pad + h, pad:pad + w] = rgba
        rgba = grown
    for name in STYLE_ORDER:
        spec = styles.get(name)
        if not isinstance(spec, dict) or spec.get("enabled") is False:
            continue
        try:
            out = engine.STYLES[name](rgba, spec, ctx.scale, False)
        except Exception as exc:                         # noqa: BLE001
            ctx.warn(f"layer {layer['id']}: style \"{name}\" failed: {exc}")
            continue
        if isinstance(out, np.ndarray) and out.shape == rgba.shape:
            rgba = np.ascontiguousarray(out, dtype=np.float32)
    return rgba, pad


def _shape_mask(shapes, W, H, ctx, layer_id):
    """IMAGE_SPEC §3's geometric selection kinds, combined in order."""
    live = [s for s in shapes if isinstance(s, dict)][:LIMITS["maskShapes"]]
    if not live:
        return None
    has_add = any(str(s.get("mode") or "add") == "add" for s in live)
    # Subtract-only reads as "everything, minus these holes"; the first add is
    # what turns the layer off everywhere it does not cover. engine.py's rule.
    acc = np.zeros((H, W), np.float32) if has_add else np.ones((H, W), np.float32)
    for spec in live:
        kind = str(spec.get("kind") or "rect")
        if kind not in MASK_SHAPE_KINDS:
            raise ValueError(
                f"layer {layer_id}: mask shape \"{kind}\" is not one this module "
                f"can rasterise ({', '.join(MASK_SHAPE_KINDS)}). IMAGE_SPEC §3's "
                "wand and colorRange sample an image, and a document mask is "
                "resolved in canvas space before there is one to sample — run "
                "them as a SELECTION through server/imgselect.py (the flat "
                "pipeline's `selection` op owns both kinds), or bake the result "
                "into a library image and use mask.src.")
        mode = str(spec.get("mode") or "add")
        if mode not in MASK_MODES:
            raise ValueError(f"layer {layer_id}: a mask shape is "
                             f"{' or '.join(MASK_MODES)}, not \"{mode}\"")
        buf = np.zeros((H, W), np.uint8)
        if kind == "rect":
            x, y = int(_f(spec.get("x"), 0)), int(_f(spec.get("y"), 0))
            w2, h2 = int(_f(spec.get("w"), 0)), int(_f(spec.get("h"), 0))
            cv2.rectangle(buf, (x, y), (x + w2 - 1, y + h2 - 1), 255, -1)
        elif kind == "ellipse":
            cx, cy = int(_f(spec.get("cx"), 0)), int(_f(spec.get("cy"), 0))
            rx, ry = int(_f(spec.get("rx"), 0)), int(_f(spec.get("ry"), 0))
            if rx > 0 and ry > 0:
                cv2.ellipse(buf, (cx, cy), (rx, ry), 0, 0, 360, 255, -1,
                            lineType=cv2.LINE_AA)
        else:
            pts = spec.get("points") or []
            if len(pts) >= 3:
                arr = np.round(np.asarray(pts, dtype=np.float64)[:, :2]).astype(np.int32)
                cv2.fillPoly(buf, [arr], 255, lineType=cv2.LINE_AA)
        m = buf.astype(np.float32) / 255.0
        if spec.get("invert"):
            m = 1.0 - m
        if mode == "add":
            acc = np.clip(acc + m, 0.0, 1.0)
        else:
            acc = np.clip(acc - m, 0.0, 1.0)
    return acc


def _layer_mask(layer, ctx):
    """The layer's mask as float32 (H, W) 0..1 in CANVAS pixels, or None.

    Canvas space on purpose. A mask painted on the canvas should stay where it
    was painted when the layer under it is nudged or spun — and it makes a mask
    on a group, a mask on an adjustment layer and a mask on a photo the same
    array multiplied in the same place.
    """
    spec = layer.get("mask")
    if not isinstance(spec, dict) or spec.get("enabled") is False:
        return None
    W, H = ctx.W, ctx.H
    parts = []

    name = spec.get("src")
    if name:
        px = as_rgba(ctx.resolve(name)) if ctx.resolve is not None else None
        if px is None:
            ctx.rep["missing"].append(str(name))
            ctx.warn(f"layer {layer['id']}: mask source \"{name}\" is missing — the "
                     "mask from it is ignored, the layer still draws")
        else:
            px = _resize(px, W, H)
            if str(spec.get("channel") or "alpha") == "luma":
                # A transparent part of a luma mask reads as black, which is what
                # makes a white shape on nothing behave the way anyone expects.
                parts.append(np.ascontiguousarray(
                    (px[..., :3] * engine._LUMA_W).sum(axis=-1) * px[..., 3]))
            else:
                parts.append(np.ascontiguousarray(px[..., 3]))

    shapes = spec.get("shapes")
    if isinstance(shapes, list) and shapes:
        sm = _shape_mask(shapes, W, H, ctx, layer["id"])
        if sm is not None:
            parts.append(sm)

    if not parts:
        return None
    m = parts[0]
    for extra in parts[1:]:
        m = m * extra                      # an image mask AND a shape mask
    expand = _f(spec.get("expand"), 0.0) * ctx.scale
    if abs(expand) >= 0.5:
        r = int(round(abs(expand)))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r * 2 + 1, r * 2 + 1))
        m = cv2.dilate(m, k) if expand > 0 else cv2.erode(m, k)
    feather = _f(spec.get("feather"), 0.0) * ctx.scale
    if feather > 0.1:
        # feather is the full soft band; a gaussian's visible reach is about two
        # sigma either side, so half of it is the sigma to ask for
        m = cv2.GaussianBlur(m, (0, 0), sigmaX=max(0.1, feather / 2.0))
    if spec.get("invert"):
        m = 1.0 - m
    density = min(1.0, max(0.0, _f(spec.get("density"), 100.0) / 100.0))
    if density < 1.0:
        # Photoshop's Density: how far the mask is ALLOWED to hide. 0 is a mask
        # that is still there and still editable and currently does nothing.
        m = 1.0 - (1.0 - m) * density
    return np.clip(np.ascontiguousarray(m, dtype=np.float32), 0.0, 1.0)


def _layer_tile(layer, ctx, depth):
    """One layer in canvas space: pixels, effects, styles, transform, mask, opacity."""
    got = _source_pixels(layer, ctx, depth)
    if got is None:
        return None
    px, nw, nh = got

    pad = 0
    if layer["type"] != "adjustment":
        # An adjustment layer's own pixels are a REGION, not a picture: its
        # effects run on the backdrop instead, and a drop shadow on a region is
        # meaningless. normalize() says both out loud; honouring either here
        # while the warning claims otherwise is the worse half of both options.
        px = _apply_effects(px, layer, ctx)
        px, pad = _apply_styles(px, layer, ctx)

    m = interp.transform_matrix(
        layer.get("transform") or {}, 0.0,
        # The layer's OWN centre, not the canvas centre: an untouched transform
        # must spin a layer about itself rather than swing it around the middle
        # of the document. store.js has to guess this before the source is read;
        # here the source is already in hand.
        anchor_default=(nw / 2.0, nh / 2.0),
        position_default=(ctx.doc["width"] / 2.0, ctx.doc["height"] / 2.0))
    m = interp.scale_matrix(m, ctx.scale)
    if pad:
        # the padded bitmap starts pad px earlier in layer space, so the mapping
        # out of it has to start there too
        m = interp.mat_mul(m, np.array([[1.0, 0.0, -pad], [0.0, 1.0, -pad]]))

    tile = engine._warp(px, m, ctx.W, ctx.H)
    if tile is None:
        return None

    mask = _layer_mask(layer, ctx)
    op = min(1.0, max(0.0, _f((layer.get("transform") or {}).get("opacity"), 100.0) / 100.0))
    if mask is None and op >= 1.0 - 1e-6:
        return tile
    if op <= 0.0:
        return None
    h, w = tile.rgba.shape[:2]
    # copy: _warp hands back its input untouched when the transform is identity,
    # and that input may be a cached decode two layers are sharing.
    rgba = tile.rgba.copy()
    rgba[..., 3] *= op
    if mask is not None:
        rgba[..., 3] *= mask[tile.y:tile.y + h, tile.x:tile.x + w]
    return Tile(rgba, tile.x, tile.y)


def _composite(acc, layers, ctx, depth=0):
    """Paint a list of layers into `acc`, bottom-up. One compositing context.

    `acc` is this context's whole world: an adjustment layer reads it, a stencil
    re-cuts it, and neither reaches outside the group it is in. That is what
    makes a group a unit.
    """
    key = id(layers)
    if key in ctx.stack:
        ctx.warn("a group contains itself — the second visit is dropped rather "
                 "than followed, which would not return")
        return
    if depth > LIMITS["maxDepth"]:
        ctx.warn(f"groups nested past {LIMITS['maxDepth']} — the rest is dropped")
        return
    ctx.stack.add(key)
    try:
        items = [l for l in layers if isinstance(l, dict)]
        i = 0
        while i < len(items):
            base = items[i]
            # gather the clipping-mask run riding on this layer: every
            # consecutive `clipped` layer above it shares it as the one base
            run = []
            j = i + 1
            while j < len(items) and items[j].get("clipped"):
                run.append(items[j])
                j += 1
            i = j
            if base.get("enabled") is False:
                continue                   # a hidden base hides its whole run
            live = [r for r in run if r.get("enabled") is not False]
            if base.get("clipped") or base.get("type") == "adjustment" or not live:
                # No unit to build. `base` itself carrying the flag means the
                # bottom of this container is clipped (nothing beneath it), and
                # an adjustment layer is never painted so it has no alpha to
                # clip to — normalize() has already said both out loud, and the
                # run paints unclipped, exactly as warned. An empty or fully
                # hidden run is just an ordinary layer.
                _paint_one(acc, base, ctx, depth)
                for member in live:
                    _paint_one(acc, member, ctx, depth)
                continue
            _clip_unit(acc, base, live, ctx, depth)
    finally:
        ctx.stack.discard(key)


def _paint_one(acc, layer, ctx, depth):
    """One layer into the accumulator — the non-clipped compositing step."""
    if layer.get("type") == "adjustment":
        _apply_adjustment(acc, layer, ctx, depth)
        return
    tile = _layer_tile(layer, ctx, depth)
    if tile is None:
        return
    ctx.rep["painted"] += 1
    blend = layer.get("blend") or "normal"
    if blend in STENCIL_MODES:
        # Not a blend: it re-shapes the alpha of everything already
        # painted in this context and is never drawn itself.
        engine._stencil_alpha(acc, tile, blend, ctx.W, ctx.H)
        return
    engine._over(acc, tile, blend)


def _clip_unit(acc, base, run, ctx, depth):
    """A clipping-mask unit: `base` plus the consecutive clipped layers on it.

    Photoshop's semantics, deliberately, decision by decision:

      * The unit's alpha IS the base's alpha. A clipped layer never adds
        coverage and never removes it — it recolours what the base already
        covers, mixing in by its own alpha and opacity. That is exactly
        engine._over_preserve (AE's preserve-underlying-transparency switch),
        so the maths lives there and not in a second copy here. Where the base
        is fully opaque the result is bit-identical to an unclipped composite;
        where the base is absent the clipped layer vanishes; between, its
        contribution scales with the base's coverage.
      * The clipped layer's own blend mode meets the BASE GROUP's colour, not
        the document backdrop — the unit is its compositing context, the same
        way a group's buffer is its children's.
      * The base's opacity, styles and blend mode apply to the WHOLE unit —
        Photoshop's default "blend clipped layers as group". Its styles run on
        the assembled unit in canvas space: the matte they read is the base's
        alpha (clipping never moved it), so a drop shadow falls where the
        base's shadow falls and the clipped content never bleeds into it — and
        a colour overlay on the base recolours OVER the clipped result, which
        is Photoshop's (endlessly reported, entirely faithful) behaviour.
      * A clipped ADJUSTMENT layer runs on the unit's buffer, so it reaches the
        base stack and nothing outside it — the most-used clipping trick.
      * A clipped stencil/silhouette mode re-cuts the unit's own matte. And
        because a matte effect inside the run could GROW alpha past the base
        (invertAlpha, say), the matte is clamped back to the base's coverage at
        the end: cuts survive, growth does not — the unit never covers more
        than its base.
    """
    # The base WITHOUT its opacity and styles: both belong to the finished
    # unit, not to the bare fill the clipped layers composite against.
    bare = dict(base)
    bare.pop("styles", None)
    t = bare.get("transform")
    if isinstance(t, dict) and "opacity" in t:
        bare["transform"] = {k: v for k, v in t.items() if k != "opacity"}
    tile = _layer_tile(bare, ctx, depth)
    if tile is None:
        # A base that draws nothing (a missing source, say) has no alpha at
        # all, and a stack clipped to nothing shows nothing — the same answer
        # a hidden base gives, for the same reason.
        return
    inner = np.zeros((ctx.H, ctx.W, 4), dtype=np.float32)
    engine._over(inner, tile, "normal")
    ctx.rep["painted"] += 1
    matte = inner[..., 3].copy()
    for layer in run:
        if layer.get("type") == "adjustment":
            _apply_adjustment(inner, layer, ctx, depth)
            continue
        ltile = _layer_tile(layer, ctx, depth)
        if ltile is None:
            continue
        ctx.rep["painted"] += 1
        blend = layer.get("blend") or "normal"
        if blend in STENCIL_MODES:
            engine._stencil_alpha(inner, ltile, blend, ctx.W, ctx.H)
            continue
        engine._over_preserve(inner, ltile, blend)
    np.minimum(inner[..., 3], matte, out=inner[..., 3])
    inner, _pad = _apply_styles(inner, base, ctx, pad=0)
    op = min(1.0, max(0.0, _f((base.get("transform") or {}).get("opacity"), 100.0) / 100.0))
    if op <= 0.0:
        return
    if op < 1.0 - 1e-6:
        inner[..., 3] *= op
    blend = base.get("blend") or "normal"
    unit = Tile(inner, 0, 0)
    if blend in STENCIL_MODES:
        engine._stencil_alpha(acc, unit, blend, ctx.W, ctx.H)
        return
    engine._over(acc, unit, blend)


def _apply_adjustment(acc, layer, ctx, depth):
    """An adjustment layer: its effects, run on what is already beneath it.

    Full-frame rather than over its own box only, so a blur inside the region
    still samples what surrounds it — otherwise a masked adjustment layer pulls
    the region's own edge inward and shows a seam.
    """
    if not (layer.get("effects") or []) and not (layer.get("ops") or {}):
        ctx.warn(f"layer {layer['id']} ({layer['name']}): an adjustment layer with "
                 "no effects and no ops is a no-op - they are the content")
        return
    tile = _layer_tile(layer, ctx, depth)
    if tile is None:
        return
    cover = engine._tile_region(tile, 0, 0, ctx.W, ctx.H)[..., 3:4]
    processed = acc.copy()

    # imagetools' twenty-five, first — IMAGE_SPEC §2 puts adjustments at stage
    # 5 and effects at stage 6. About ten of them (temperature, grain, denoise,
    # sepia, autoLevels, the HSL bands) have no effects.py twin, so without
    # this an adjustment layer could not do them at all.
    if layer.get("ops"):
        try:
            import imagetools                           # noqa: PLC0415
            processed = imagetools.apply_ops(processed, layer["ops"])
        except Exception as exc:                        # noqa: BLE001
            ctx.warn(f"layer {layer['id']} ({layer['name']}): ops skipped - {exc}")

    processed = _apply_effects(processed, layer, ctx)
    ctx.rep["painted"] += 1
    acc *= (1.0 - cover)
    acc += processed * cover


def render(doc, resolve=None, scale=1.0, report=None):
    """The document as float32 (H, W, 4), 0..1, straight alpha.

    `resolve(name) -> array | path | None` turns a library name into pixels. The
    document never holds a path and this function never builds one; a name the
    resolver does not know is a warning and a skipped layer, not an exception,
    because one lost file must not cost the other forty layers.

    `report`, if a dict, comes back carrying `warnings`, `missing` and `painted`.
    Everything this renderer decides not to do lands in there — it is the only
    difference between a layer that is missing and a layer that is invisible.
    """
    rep = report if isinstance(report, dict) else {}
    rep.setdefault("warnings", [])
    rep.setdefault("missing", [])
    rep["painted"] = 0

    doc = normalize(doc, rep["warnings"])
    s = min(8.0, max(0.01, _f(scale, 1.0)))
    W = max(1, round(doc["width"] * s))
    H = max(1, round(doc["height"] * s))
    rep["width"], rep["height"] = W, H

    acc = np.empty((H, W, 4), dtype=np.float32)
    acc[:] = _rgba01(doc["bg"], (0.0, 0.0, 0.0, 0.0))
    ctx = _Ctx(doc, W, H, s, resolve, rep)
    _composite(acc, doc["layers"], ctx)
    return np.clip(acc, 0.0, 1.0, out=acc)


def to_uint8(rgba):
    return (np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


# ── CLI: one JSON line, the protocol every other program here speaks ─────────

def render_job(job):
    """job: { doc, out, thumbOut?, thumbSize?, sources?: {name: path}, scale?,
              sizeFrom? }

    `sizeFrom` names a source whose pixel size becomes the document's width and
    height — how a caller with no image decoder of its own (the node side) says
    "the document is the size of the base image". The resolver caches, so the
    decode is the same one the layer itself uses.
    """
    from PIL import Image                                # noqa: PLC0415
    rep = {}
    resolve = resolver_for(job.get("sources"))
    doc = job.get("doc")
    if job.get("sizeFrom"):
        px = resolve(job["sizeFrom"])
        if px is None:
            raise ValueError(f"sizeFrom: no source called \"{job['sizeFrom']}\"")
        doc = dict(doc if isinstance(doc, dict) else {},
                   width=int(px.shape[1]), height=int(px.shape[0]))
    rgba = render(doc, resolve, _f(job.get("scale"), 1.0), rep)
    im = Image.fromarray(to_uint8(rgba), "RGBA")
    im.save(job["out"])
    if job.get("thumbOut"):
        th = im.copy()
        th.thumbnail((int(_f(job.get("thumbSize"), 256)),) * 2, Image.LANCZOS)
        th.save(job["thumbOut"])
    return {"ok": True, "out": job["out"], "width": im.width, "height": im.height,
            "painted": rep["painted"], "missing": rep["missing"],
            "warnings": rep["warnings"]}


def store_job(job):
    """job: { dir, action: "save" | "open" | "list" | "delete", doc?, id? }

    `id` takes an id or a slug, either way. `save` mints an id and a slug when
    the document has none, so "save something new" and "save the one I have
    open" are the same call and a caller never has to decide which it is doing.

    ⚠ A DOCUMENT OFF DISK IS AS UNTRUSTED AS ONE OFF THE WIRE, so both go
    through normalize() — the same and only validator render() uses, warnings
    and all. That is not a courtesy: the shelf is a file any process on the
    machine can write, so "we wrote it, therefore it is well formed" is an
    assumption about every other program on the box. What `open` hands back has
    been repaired, and says what it repaired.
    """
    action = str(job.get("action") or "").strip()
    path = _shelf_path(job)

    if action == "list":
        shelf = _read_shelf(path)
        rows = [_summary(k, v) for k, v in shelf["documents"].items()
                if isinstance(v, dict)]
        rows.sort(key=lambda r: _f(r.get("updatedAt"), 0.0), reverse=True)
        return {"ok": True, "shelf": path, "documents": rows}

    if action == "save":
        warn = []
        doc = normalize(job.get("doc"), warn)
        shelf = _read_shelf(path)
        docs = shelf["documents"]
        old = docs.get(doc["id"])
        if not isinstance(old, dict) and len(docs) >= LIMITS["shelfDocs"]:
            raise ValueError(
                f"that shelf already holds {LIMITS['shelfDocs']} documents, which "
                "is all one JSON file is meant to carry. Delete one, or point "
                "`dir` at another folder.")
        if isinstance(old, dict) and old.get("createdAt"):
            doc["createdAt"] = old["createdAt"]     # a save is not a birth
        doc.setdefault("createdAt", time.time())
        doc["slug"] = _free_slug(docs, doc["slug"], doc["id"])
        doc["updatedAt"] = time.time()
        docs[doc["id"]] = doc
        _write_shelf(path, shelf)
        return {"ok": True, "shelf": path, **_summary(doc["id"], doc),
                "warnings": warn}

    if action == "open":
        shelf = _read_shelf(path)
        did, stored = _pick(shelf, job.get("id"))
        warn = []
        doc = normalize(stored, warn)
        doc["id"] = did                             # the shelf key is the handle
        return {"ok": True, "doc": doc, "warnings": warn}

    if action == "delete":
        shelf = _read_shelf(path)
        did, stored = _pick(shelf, job.get("id"))
        # Permanent. There is no trash behind this shelf, and inventing one here
        # would be a second place documents live that nothing else knows about.
        gone = _summary(did, stored) if isinstance(stored, dict) else {"id": did}
        del shelf["documents"][did]
        _write_shelf(path, shelf)
        return {"ok": True, "shelf": path, "deleted": gone}

    raise ValueError("store takes an `action`: save, open, list or delete. Got "
                     f"\"{action}\".")


def edit_job(job):
    """job: { dir, id, ops: [ {op, ...}, ... ], doc?: bool }

    One call moves a layer and renames it and clips it, with the tree crossing
    the seam in neither direction. The reply is the shelf row plus a flat
    `outline`; pass `"doc": true` for the document itself.
    """
    path = _shelf_path(job)
    shelf = _read_shelf(path)
    did, stored = _pick(shelf, job.get("id"))
    warn = []
    doc = normalize(stored, warn)
    doc["id"] = did
    doc, applied = apply_edits(doc, job.get("ops"))
    doc["slug"] = _free_slug(shelf["documents"], doc["slug"], did)
    doc["updatedAt"] = time.time()
    shelf["documents"][did] = doc
    _write_shelf(path, shelf)
    out = {"ok": True, "shelf": path, **_summary(did, doc), "applied": applied,
           "outline": _outline(doc.get("layers")), "warnings": warn}
    if job.get("doc") is True:
        out["doc"] = doc
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    try:
        if mode == "catalog":
            print(json.dumps(catalog()))
            return
        with open(sys.argv[2], "r", encoding="utf-8") as fh:
            job = json.load(fh)
        if mode == "render":
            print(json.dumps(render_job(job)))
            return
        if mode == "store":
            print(json.dumps(store_job(job)))
            return
        if mode == "edit":
            print(json.dumps(edit_job(job)))
            return
        raise ValueError(f"unknown mode {mode}")
    except Exception as exc:                             # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
