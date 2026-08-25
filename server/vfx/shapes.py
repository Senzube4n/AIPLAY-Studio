"""Shape layers - the vector side of the compositor, which until now did not
exist at all.

A shape layer owns no bitmap. It owns a small program:

    layer["shapes"] = [ group, group, ... ]
    group           = { "type": "group", "items": [ ... ], "transform": {...} }
    item            = a PATH, a PAINT, a PATH OPERATION, or another group

Items run **in list order, first to last**. A path pushes onto the group's
current path set; an operation rewrites that set in place; a paint consumes it
and draws, and a later paint draws OVER an earlier one. Groups follow the same
rule, so the last group in `shapes` is the one in front. `fill` before `stroke`
therefore gives the outline on top, which is what everyone wants and is the
reverse of the order AE's panel shows (AE renders its shape stack bottom-up).
Reading order beats panel order in a JSON document nobody can drag.

Coordinates are LAYER pixels with **(0, 0) at the centre of the layer**, AE's
convention: a shape layer is comp-sized and its anchor defaults to the middle,
so a rectangle at position [0, 0] sits in the middle of the frame. Set
`"origin": "topLeft"` on the layer if you would rather think in comp pixels.

Every numeric property is ANIMATABLE. Nothing here reads a raw number out of
the document - every value goes through the `eval_prop` callable the caller
passes in (interp.eval_prop's signature, `f(prop, t)`), so a keyframed trim,
a keyframed repeater rotation and a keyframed gradient endpoint all work
without this module knowing what a keyframe is.

RASTERISATION. One scanline rasteriser draws everything: fills, strokes (as
outline polygons), dashes, gradients. Horizontal coverage is computed
ANALYTICALLY - a span from x=3.2 to x=5.7 deposits exactly 0.8, 1.0 and 0.7 -
and only the vertical axis is supersampled, `SAMPLES` sub-scanlines per output
row (4 by default, 2 in draft). Only the crossing list grows with that number,
never the pixel work, which is why the whole range from 1 sub-scanline to 8
measures within 11% of itself - a plain 4x4 supersample would have been 16x the
memory and 16x the filtering for the same edge. The trade is that a
near-horizontal edge quantises to 1/4 of a pixel while a near-vertical one is
exact. Everything is drawn inside the geometry's bounding box, so a small badge
on a 1080p canvas costs what the badge costs.

Curves flatten ADAPTIVELY, to `FLATNESS` pixels of chord error at render
resolution - a 500px circle becomes about 100 segments and a 5px dot about 10,
so nothing is faceted and nothing pays for detail it cannot show.

    python shapes.py catalog     # the vocabulary as one JSON line
    python shapes.py bench       # render costs at 1920x1080

numpy / cv2 / scipy, and interp.py for the default property evaluator.
"""
# ── WIRING - what the engine owner has to do, and it is all of it ────────────
#
#   1. server/vfx/engine.py, with the other imports:
#
#          import shapes
#
#   2. In `_layer_pixels`, next to the "text" branch:
#
#          if kind == "shape":
#              return shapes.render_shape(layer, t, W, H, interp.eval_prop,
#                                         scale=scale, draft=draft)
#
#      W, H are the RENDER-resolution canvas and are already scaled; `scale` is
#      passed separately because the geometry in the document is in comp pixels
#      and has to be multiplied by it - the same thing `_rasterize_text` does
#      with its font size. `draft` halves the antialiasing samples.
#
#   3. `_layer_native_size` needs no branch: a shape layer is comp-sized, which
#      is what its existing `return cw, ch` fallback already says.
#
#   4. The document gains `"type": "shape"` and a `"shapes": [...]` array.
#      Nothing else - transform, effects, masks, mattes, parenting, blend modes
#      and motion blur all apply on top exactly as they do for a text layer,
#      because this returns the same thing a text layer returns: float32
#      (H, W, 4), 0..1, straight alpha.
#
#   5. routes.js / mcp-vfx.js: serve `shapes.catalog()` beside the effect
#      catalog, from `python server/vfx/shapes.py catalog`. It describes every
#      item type and every parameter, so the MCP schema and the UI panels are
#      generated rather than typed.
#
#   6. Validation, if the route wants a limit: groups per layer <= 32, items
#      per group <= 64, repeater copies <= 200 (enforced here anyway).
# ─────────────────────────────────────────────────────────────────────────────
import json
import math
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from interp import eval_prop as _default_eval          # noqa: E402
except ImportError:                                        # standalone use
    def _default_eval(prop, t):
        return prop


SAMPLES = 4          # vertical sub-scanlines per output row
DRAFT_SAMPLES = 2
FLATNESS = 0.25      # px of chord error allowed when flattening a curve
_EPS = np.float32(1e-6)
_MAX_CROSSINGS = 40_000_000      # a runaway document must not eat the box


# ---------------------------------------------------------------------------
# the catalog
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Path", "Paint", "Path Operation", "Group"]

LINE_CAPS = ["butt", "round", "square"]
LINE_JOINS = ["miter", "round", "bevel"]
FILL_RULES = ["nonzero", "evenodd"]

# An agent will guess these names, and a guess that works is a round trip saved.
ALIASES = {
    "rectangle": "rect", "rounded-rect": "rect", "roundedRect": "rect",
    "circle": "ellipse", "oval": "ellipse",
    "star": "polystar", "polygon": "polystar",
    "bezier": "path", "shape": "path", "custom": "path",
    "gradient": "gradientFill", "gradientfill": "gradientFill",
    "trimPaths": "trim", "trimpath": "trim", "trimPath": "trim",
    "offsetPaths": "offsetPath", "offset": "offsetPath",
    "roundedCorners": "roundCorners", "round": "roundCorners",
    "zigZag": "zigzag", "zig-zag": "zigzag",
    "wigglePaths": "wiggle", "wigglePath": "wiggle",
    "mergePaths": "merge",
}


def num(default, lo, hi, desc, animatable=True, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": animatable, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def vec2(default, desc, lo=-100000, hi=100000, unit="px"):
    return {"type": "vec2", "default": list(default), "min": lo, "max": hi,
            "animatable": True, "unit": unit, "desc": desc}


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "animatable": False, "desc": desc}


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default,
            "animatable": False, "desc": desc}


def col(default, desc):
    """Colours are 0-255 RGB, the units the comp document already stores."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": True, "desc": desc}


def arr(default, desc, animatable=True):
    """A flat list of numbers. interp interpolates those elementwise, so a flat
    list keyframes; a NESTED list does not, which is why every nested parameter
    below is marked animatable: False and has a flat twin."""
    return {"type": "array", "default": list(default), "animatable": animatable,
            "desc": desc}


def obj(default, desc):
    return {"type": "object", "default": default, "animatable": False, "desc": desc}


def item(name, label, group, why, params, **extra):
    entry = {"label": label, "group": group, "why": why, "params": params}
    entry.update(extra)
    CATALOG[name] = entry
    return entry


GROUP_TRANSFORM = {
    "anchor": vec2([0, 0], "the pivot scale and rotation turn around"),
    "position": vec2([0, 0], "moves everything in the group"),
    "scale": vec2([100, 100], "percent; scales stroke widths with the geometry",
                  lo=-10000, hi=10000, unit="%"),
    "rotation": num(0, -36000, 36000, "degrees clockwise", unit="deg"),
    "skew": num(0, -85, 85, "degrees of shear", unit="deg"),
    "skewAxis": num(0, -360, 360, "the direction the shear runs along", unit="deg"),
    "opacity": num(100, 0, 100, "multiplies every paint in the group", unit="%"),
}

item("group", "Group", "Group",
     "A bag of paths, paints and operations with its own transform. Items run "
     "top to bottom: paths accumulate, an operation rewrites what has "
     "accumulated, a paint draws it and later paints draw on top.",
     {"name": {"type": "string", "default": "", "animatable": False,
               "desc": "what the layer panel calls it"},
      "enabled": flag(True, "off skips the whole group"),
      "items": obj([], "the shape items, in order"),
      "transform": {"type": "transform", "animatable": True, "default": {},
                    "params": GROUP_TRANSFORM,
                    "desc": "applied to the group's geometry before it is drawn"}})

# ── paths ───────────────────────────────────────────────────────────────────

item("rect", "Rectangle", "Path",
     "A rectangle, optionally with rounded corners. Roundness is a real corner "
     "radius in pixels and clamps at half the shorter side, where the "
     "rectangle has become a stadium.",
     {"size": vec2([200, 120], "width and height"),
      "position": vec2([0, 0], "centre, in layer pixels from the middle of the layer"),
      "roundness": num(0, 0, 4000, "corner radius in pixels", unit="px")})

item("ellipse", "Ellipse", "Path",
     "An ellipse. Equal width and height is a circle, and it is sampled from "
     "its radius so a big one is not a polygon.",
     {"size": vec2([200, 200], "the two diameters"),
      "position": vec2([0, 0], "centre, in layer pixels from the middle of the layer")})

item("polystar", "Polystar", "Path",
     "A star or a regular polygon. Roundness rounds the corners with real "
     "arcs, so 100% on a polygon is a circle and 100% on a star's inner points "
     "is the blobby flower AE draws.",
     {"starType": pick(["star", "polygon"], "star", "a star alternates two radii"),
      "points": num(5, 3, 100, "number of points (star) or sides (polygon)",
                    integer=True),
      "position": vec2([0, 0], "centre"),
      "rotation": num(0, -36000, 36000, "degrees clockwise; 0 puts a point straight up",
                      unit="deg"),
      "outerRadius": num(120, 0, 8000, "distance to the outer points", unit="px"),
      "innerRadius": num(60, 0, 8000, "distance to the inner points; star only",
                         unit="px"),
      "outerRoundness": num(0, 0, 100, "rounds the outer corners", unit="%"),
      "innerRoundness": num(0, 0, 100, "rounds the inner corners; star only", unit="%")})

item("path", "Path", "Path",
     "An arbitrary path. Give it `points` - a FLAT [x0,y0,x1,y1,...] list - for "
     "a polyline that can be keyframed, or `vertices` with `inTangents` / "
     "`outTangents` for real beziers. Tangents are relative to their vertex, "
     "the convention every exporter uses.",
     {"points": arr([], "flat [x0,y0,x1,y1,...]; animatable because it is flat"),
      "vertices": obj([], "[[x,y],...]; beziers need this form, which cannot keyframe"),
      "inTangents": obj([], "[[dx,dy],...] relative to each vertex"),
      "outTangents": obj([], "[[dx,dy],...] relative to each vertex"),
      "closed": flag(True, "join the last vertex back to the first")})

# ── paint ───────────────────────────────────────────────────────────────────

item("fill", "Fill", "Paint",
     "Flood the current paths with one colour.",
     {"color": col([255, 255, 255], "RGB 0-255"),
      "opacity": num(100, 0, 100, "percent", unit="%"),
      "fillRule": pick(FILL_RULES, "nonzero",
                       "nonzero fills anything wound around; evenodd punches a "
                       "hole wherever contours overlap")})

item("stroke", "Stroke", "Paint",
     "Draw the current paths as a line. The outline is built as geometry - "
     "real caps, real joins, a real miter limit - and filled, so a stroke "
     "antialiases exactly the way a fill does.",
     {"color": col([255, 255, 255], "RGB 0-255"),
      "opacity": num(100, 0, 100, "percent", unit="%"),
      "width": num(6, 0, 2000, "line width in pixels; sub-pixel widths render faint",
                   unit="px"),
      "lineCap": pick(LINE_CAPS, "butt", "how an open end finishes"),
      "lineJoin": pick(LINE_JOINS, "miter", "how two segments meet"),
      "miterLimit": num(4, 1, 100,
                        "a miter longer than this many line widths falls back to bevel"),
      "dashes": arr([], "flat [dash, gap, dash, gap, ...] in pixels; empty is solid"),
      "dashOffset": num(0, -100000, 100000, "slides the dash pattern along the path",
                        unit="px")})

_STOPS = {"type": "stops", "animatable": False,
          "default": [{"pos": 0.0, "color": [255, 255, 255], "opacity": 100},
                      {"pos": 1.0, "color": [0, 0, 0], "opacity": 100}],
          "desc": "[{pos 0..1, color [r,g,b], opacity 0..100}, ...]"}
_STOP_VALUES = arr([], "flat [pos,r,g,b, pos,r,g,b, ...] twin of `stops` that "
                       "CAN be keyframed; wins over `stops` when present")

item("gradientFill", "Gradient Fill", "Paint",
     "Flood the current paths with a ramp. Linear runs along start->end; "
     "radial runs outward from start, with end setting the radius.",
     {"gradientType": pick(["linear", "radial"], "linear", "how the ramp is laid out"),
      "startPoint": vec2([-100, 0], "where the ramp begins, in layer pixels"),
      "endPoint": vec2([100, 0], "where it ends (radial: sets the radius)"),
      "stops": _STOPS,
      "stopValues": _STOP_VALUES,
      "opacity": num(100, 0, 100, "percent, on top of the stops' own opacity", unit="%"),
      "fillRule": pick(FILL_RULES, "nonzero", "as Fill")})

item("gradientStroke", "Gradient Stroke", "Paint",
     "A stroke whose colour is a ramp. Same outline geometry as Stroke, same "
     "ramp as Gradient Fill.",
     {"gradientType": pick(["linear", "radial"], "linear", "how the ramp is laid out"),
      "startPoint": vec2([-100, 0], "where the ramp begins"),
      "endPoint": vec2([100, 0], "where it ends"),
      "stops": _STOPS,
      "stopValues": _STOP_VALUES,
      "opacity": num(100, 0, 100, "percent", unit="%"),
      "width": num(6, 0, 2000, "line width in pixels", unit="px"),
      "lineCap": pick(LINE_CAPS, "butt", "how an open end finishes"),
      "lineJoin": pick(LINE_JOINS, "miter", "how two segments meet"),
      "miterLimit": num(4, 1, 100, "miter fallback threshold, in line widths"),
      "dashes": arr([], "flat [dash, gap, ...] in pixels"),
      "dashOffset": num(0, -100000, 100000, "slides the pattern along", unit="px")})

# ── path operations ─────────────────────────────────────────────────────────

item("trim", "Trim Paths", "Path Operation",
     "Show only part of the path, by percentage of its length. The line-draw. "
     "Keyframe `end` 0->100 and the path draws itself; keyframe `offset` and "
     "the visible piece chases around the shape. When start is past end the "
     "range WRAPS through the end of the path and back to the beginning, which "
     "is what makes a dot chase a circle.",
     {"start": num(0, -1000, 1000, "percent of the path length", unit="%"),
      "end": num(100, -1000, 1000, "percent of the path length", unit="%"),
      "offset": num(0, -36000, 36000, "degrees; 360 is one whole path length",
                    unit="deg"),
      "trimMultipleShapes": pick(["simultaneously", "individually"], "simultaneously",
                                 "simultaneously: every path trims by the same "
                                 "percentage at once. individually: the paths are "
                                 "laid end to end, so one finishes before the next "
                                 "begins")})

item("repeater", "Repeater", "Path Operation",
     "Copy everything in the group, applying its transform once more each "
     "time. Twelve copies rotated 30 degrees about a shared anchor is a "
     "sunburst; twelve copies offset in x is a row.",
     {"copies": num(3, 1, 200, "how many, including the original", integer=True),
      "offset": num(0, -200, 200,
                    "shifts which copy is which - 0.5 puts every copy half a step along"),
      "composite": pick(["above", "below"], "above",
                        "above: the first copy is drawn last, on top"),
      "anchor": vec2([0, 0], "the pivot the per-copy transform turns around"),
      "position": vec2([100, 0], "how far each copy moves from the one before"),
      "scale": vec2([100, 100], "percent per copy; 90 shrinks each copy by a tenth",
                    lo=-10000, hi=10000, unit="%"),
      "rotation": num(0, -36000, 36000, "degrees per copy", unit="deg"),
      "startOpacity": num(100, 0, 100, "opacity of the first copy", unit="%"),
      "endOpacity": num(100, 0, 100, "opacity of the last copy", unit="%")})

item("offsetPath", "Offset Paths", "Path Operation",
     "Grow or shrink the path along its own normals. Positive is outward. See "
     "the note on `amount` - this is the one operation with a caveat.",
     {"amount": num(0, -2000, 2000,
                    "pixels outward (negative inward). A large negative amount on "
                    "a detailed path leaves self-intersection loops behind: a "
                    "nonzero FILL swallows them, an evenodd fill or a STROKE will "
                    "show them. Nothing here clips them away - that needs a "
                    "polygon clipper this box does not have",
                    unit="px"),
      "lineJoin": pick(LINE_JOINS, "round", "how the outward corners are filled in"),
      "miterLimit": num(4, 1, 100, "miter fallback threshold")})

item("roundCorners", "Round Corners", "Path Operation",
     "Replace every real corner with a circular arc. Points that only exist "
     "because a curve was flattened are left alone, so rounding a circle does "
     "nothing and rounding a rectangle rounds exactly four corners.",
     {"radius": num(20, 0, 2000, "corner radius in pixels; clamps to what fits",
                    unit="px")})

item("zigzag", "Zig Zag", "Path Operation",
     "Push the path alternately to each side. Corner points give sawtooth, "
     "smooth gives a wave.",
     {"size": num(10, -500, 500, "how far each ridge travels from the path", unit="px"),
      "ridges": num(2, 1, 100,
                    "ridges per path SEGMENT - a rectangle has four segments, an "
                    "ellipse has one, so the same number reads differently on "
                    "different shapes, exactly as it does in AE", integer=True),
      "points": pick(["corner", "smooth"], "corner", "sharp ridges or a wave")})

item("wiggle", "Wiggle Paths", "Path Operation",
     "Roughen the path with seeded noise. Same seed and same time is the same "
     "path, every render - `wigglesPerSecond` above zero makes it crawl, and "
     "it crawls identically on a re-render.",
     {"size": num(10, 0, 1000, "how far a point can wander", unit="px"),
      "detail": num(8, 1, 200,
                    "sample points per path segment; never coarser than the path "
                    "already was, so a wiggled circle stays round", integer=True),
      "seed": num(1, 0, 100000, "change it for a different wiggle", integer=True),
      "wigglesPerSecond": num(0, 0, 60,
                              "0 is a frozen roughen; above 0 it animates", unit="hz")})

item("merge", "Merge Paths", "Path Operation",
     "Boolean-combine the accumulated paths. HOW: the paths are rasterised at "
     "`resolution` times the render scale, combined exactly, and the result is "
     "traced back to contours - because there is no polygon clipper here and "
     "faking one with winding rules is wrong the moment two subtracted shapes "
     "overlap. The traced outline is accurate to about half an oversampled "
     "pixel (0.12px at the default), invisible under a fill and very slightly "
     "soft under a hairline stroke. It also costs a raster pass, so it is the "
     "one operation worth not leaving switched on.",
     {"mode": pick(["add", "subtract", "intersect", "exclude"], "add",
                   "subtract and intersect take the FIRST path against all the rest"),
      "resolution": num(4, 1, 8, "oversampling used for the trace; higher is "
                                 "sharper and quadratically slower", integer=True)})


# ---------------------------------------------------------------------------
# parameter coercion - an item body never validates, same rule as effects.py
# ---------------------------------------------------------------------------

def _f(v, fallback=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return fallback
    return x if math.isfinite(x) else fallback


def _pair(v, fallback):
    if isinstance(v, (list, tuple)):
        if len(v) >= 2:
            return [_f(v[0], fallback[0]), _f(v[1], fallback[1])]
        if len(v) == 1:
            return [_f(v[0], fallback[0]), _f(v[0], fallback[1])]
        return list(fallback)
    if isinstance(v, (int, float)):
        return [_f(v, fallback[0]), _f(v, fallback[1])]
    return list(fallback)


def _coerce(spec, raw, t, ev):
    """Every value an item body sees has been through here: unknown keys
    dropped, missing keys defaulted, animatable keys EVALUATED at t, numbers
    clamped to the range the catalog advertises. That is why the bodies below
    read as geometry instead of validation."""
    out = {}
    src = raw if isinstance(raw, dict) else {}
    for key, p in spec.items():
        kind = p["type"]
        present = key in src
        v = src[key] if present else p["default"]
        if present and p.get("animatable") and kind in ("number", "vec2", "color", "array"):
            v = ev(v, t)
        if kind == "number":
            v = _f(v, float(p["default"]))
            v = min(max(v, float(p["min"])), float(p["max"]))
            if p.get("integer"):
                v = int(round(v))
        elif kind == "vec2":
            v = _pair(v, p["default"])
            v = [min(max(c, float(p["min"])), float(p["max"])) for c in v]
        elif kind == "bool":
            v = bool(v)
        elif kind == "enum":
            if v not in p["options"]:
                v = p["default"]
        elif kind == "color":
            try:
                chan = [min(255.0, max(0.0, _f(c))) for c in list(v)[:4]]
            except TypeError:
                chan = []
            v = chan if len(chan) >= 3 else list(p["default"])
        elif kind == "array":
            try:
                v = [_f(c) for c in v]
            except TypeError:
                v = list(p["default"])
        elif kind == "string":
            v = str(v) if v is not None else ""
        out[key] = v
    return out


def _rgb01(c):
    a = np.zeros(3, np.float32)
    for i, v in enumerate(list(c)[:3]):
        a[i] = _f(v) / 255.0
    return np.clip(a, 0.0, 1.0)


# ---------------------------------------------------------------------------
# paths: a flattened polyline that remembers which of its points were REAL
# ---------------------------------------------------------------------------

class Path:
    """A flattened contour.

    `corner` is the bookkeeping that makes Round Corners and Zig Zag honest:
    a point that only exists because a curve was chopped up is not a corner and
    is not a segment boundary, so rounding a circle rounds nothing and a zigzag
    with 2 ridges per segment puts 2 ridges on each side of a rectangle rather
    than 2 on each of its hundred flattened pieces.
    """
    __slots__ = ("pts", "closed", "corner")

    def __init__(self, pts, closed=True, corner=None):
        self.pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        self.closed = bool(closed)
        if corner is None:
            corner = np.ones(len(self.pts), dtype=bool)
        self.corner = np.asarray(corner, dtype=bool).reshape(-1)

    def copy(self):
        return Path(self.pts.copy(), self.closed, self.corner.copy())


def _flat_enough(p0, p1, p2, p3, tol):
    dx, dy = p3[0] - p0[0], p3[1] - p0[1]
    n = math.hypot(dx, dy)
    if n < 1e-9:
        return (math.hypot(p1[0] - p0[0], p1[1] - p0[1]) <= tol
                and math.hypot(p2[0] - p0[0], p2[1] - p0[1]) <= tol)
    d1 = abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / n
    d2 = abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / n
    return max(d1, d2) <= tol


def _flatten_cubic(p0, p1, p2, p3, tol, out, depth=0):
    """Recursive de Casteljau to a chord-error tolerance. Adaptive because a
    fixed step is wrong twice: faceted on a big curve, wasteful on a small one."""
    if depth >= 16 or _flat_enough(p0, p1, p2, p3, tol):
        out.append(p3)
        return
    m01 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    m12 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    m23 = ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2)
    a = ((m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2)
    b = ((m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2)
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    _flatten_cubic(p0, m01, a, mid, tol, out, depth + 1)
    _flatten_cubic(mid, b, m23, p3, tol, out, depth + 1)


def _arc_steps(radius, sweep, tol):
    """How many chords a sweep of `sweep` radians on `radius` needs before its
    sagitta - r(1-cos(dtheta/2)) - drops under the tolerance."""
    r = max(abs(radius), 1e-9)
    sweep = abs(sweep)
    if sweep < 1e-9:
        return 1
    if tol >= r:
        step = math.pi
    else:
        step = 2.0 * math.acos(max(-1.0, min(1.0, 1.0 - tol / r)))
    return max(1, int(math.ceil(sweep / max(step, 1e-6))))


def _arc(cx, cy, rx, ry, a0, a1, tol):
    n = _arc_steps(max(abs(rx), abs(ry)), a1 - a0, tol)
    return [(cx + rx * math.cos(a), cy + ry * math.sin(a))
            for a in np.linspace(a0, a1, n + 1)]


# ── path constructors ───────────────────────────────────────────────────────

def _make_rect(p, tol):
    w, h = abs(p["size"][0]), abs(p["size"][1])
    cx, cy = p["position"]
    if w < 1e-6 or h < 1e-6:
        return []
    r = min(p["roundness"], w / 2.0, h / 2.0)
    x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    if r < 1e-6:
        pts = [(x1, y0), (x1, y1), (x0, y1), (x0, y0)]
        return [Path(pts, True, [True] * 4)]
    pts, corner = [], []
    # clockwise on screen, starting after the top-right corner's arc
    for cx0, cy0, a0, a1 in ((x1 - r, y0 + r, -math.pi / 2, 0.0),
                             (x1 - r, y1 - r, 0.0, math.pi / 2),
                             (x0 + r, y1 - r, math.pi / 2, math.pi),
                             (x0 + r, y0 + r, math.pi, 3 * math.pi / 2)):
        seg = _arc(cx0, cy0, r, r, a0, a1, tol)
        pts.extend(seg)
        corner.extend([False] * len(seg))
    return [Path(pts, True, corner)]


def _make_ellipse(p, tol):
    rx, ry = abs(p["size"][0]) / 2.0, abs(p["size"][1]) / 2.0
    cx, cy = p["position"]
    if rx < 1e-6 or ry < 1e-6:
        return []
    pts = _arc(cx, cy, rx, ry, -math.pi / 2, 3 * math.pi / 2, tol)[:-1]
    return [Path(pts, True, [False] * len(pts))]


def _make_polystar(p, tol):
    n = max(3, int(p["points"]))
    cx, cy = p["position"]
    rot = math.radians(p["rotation"]) - math.pi / 2.0     # 0 puts a point up
    star = p["starType"] == "star"
    ro, ri = abs(p["outerRadius"]), abs(p["innerRadius"])
    if ro < 1e-6 and (not star or ri < 1e-6):
        return []
    pts, radii = [], []
    count = n * 2 if star else n
    for i in range(count):
        a = rot + i * (2.0 * math.pi / count)
        r = ro if (not star or i % 2 == 0) else ri
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        radii.append(r)
    path = Path(pts, True, [True] * len(pts))
    # Roundness is a FRACTION of the largest arc that fits the corner, which is
    # why 100% on a polygon is exactly its inscribed circle: at that radius
    # every arc's centre lands on the polygon's own centre.
    outer = p["outerRoundness"] / 100.0
    inner = (p["innerRoundness"] / 100.0) if star else outer
    if outer > 1e-4 or inner > 1e-4:
        per_vertex = []
        m = len(pts)
        for i in range(m):
            frac = outer if (not star or i % 2 == 0) else inner
            fit = _corner_radius_for(pts[i], pts[(i - 1) % m], pts[(i + 1) % m])
            per_vertex.append(fit * frac)
        path = _round_path(path, per_vertex, tol)
    return [path]


def _make_path(p, tol):
    verts = p["vertices"] if isinstance(p["vertices"], (list, tuple)) else []
    flat = p["points"]
    if not verts and len(flat) >= 4:
        verts = [[flat[i], flat[i + 1]] for i in range(0, len(flat) - 1, 2)]
    clean = []
    for v in verts:
        try:
            clean.append((_f(v[0]), _f(v[1])))
        except (TypeError, IndexError):
            continue
    if len(clean) < 2:
        return []
    it = p["inTangents"] if isinstance(p["inTangents"], (list, tuple)) else []
    ot = p["outTangents"] if isinstance(p["outTangents"], (list, tuple)) else []

    def tan(lst, i):
        try:
            return _f(lst[i][0]), _f(lst[i][1])
        except (TypeError, IndexError, KeyError):
            return 0.0, 0.0

    closed = p["closed"]
    n = len(clean)
    pts = [clean[0]]
    corner = [True]
    last = n if closed else n - 1
    for i in range(last):
        a, b = clean[i], clean[(i + 1) % n]
        oa = tan(ot, i)
        ib = tan(it, (i + 1) % n)
        if abs(oa[0]) < 1e-9 and abs(oa[1]) < 1e-9 and abs(ib[0]) < 1e-9 and abs(ib[1]) < 1e-9:
            pts.append(b)
            corner.append(True)
            continue
        seg = []
        _flatten_cubic(a, (a[0] + oa[0], a[1] + oa[1]),
                       (b[0] + ib[0], b[1] + ib[1]), b, tol, seg)
        pts.extend(seg)
        corner.extend([False] * (len(seg) - 1) + [True])
    if closed and len(pts) > 1 and math.dist(pts[0], pts[-1]) < 1e-9:
        pts = pts[:-1]
        corner = corner[:-1]
    return [Path(pts, closed, corner)]


_PATH_BUILDERS = {"rect": _make_rect, "ellipse": _make_ellipse,
                  "polystar": _make_polystar, "path": _make_path}


# ---------------------------------------------------------------------------
# geometry helpers
# ---------------------------------------------------------------------------

def _signed_area(pts):
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _orient(pts, positive=True):
    a = _signed_area(pts)
    if (a < 0) == positive:
        return pts[::-1]
    return pts


def _seg_lengths(pts, closed):
    d = np.diff(pts, axis=0)
    lens = np.hypot(d[:, 0], d[:, 1])
    if closed and len(pts) > 1:
        lens = np.append(lens, math.hypot(pts[0, 0] - pts[-1, 0], pts[0, 1] - pts[-1, 1]))
    return lens


def path_length(path):
    return float(_seg_lengths(path.pts, path.closed).sum()) if len(path.pts) > 1 else 0.0


def _resample_range(pts, closed, lo, hi):
    """The piece of a contour between two arc-length fractions, with the cut
    points interpolated rather than snapped to the nearest vertex - a trim that
    jumps from vertex to vertex reads as a stutter at any speed."""
    if len(pts) < 2:
        return None
    lens = _seg_lengths(pts, closed)
    total = float(lens.sum())
    if total <= 1e-9:
        return None
    cum = np.concatenate(([0.0], np.cumsum(lens)))
    a, b = lo * total, hi * total
    if b - a <= 1e-9:
        return None
    ring = np.vstack([pts, pts[:1]]) if closed else pts

    def point_at(d):
        i = int(np.searchsorted(cum, d, side="right") - 1)
        i = max(0, min(i, len(lens) - 1))
        seg = lens[i]
        u = 0.0 if seg <= 1e-12 else (d - cum[i]) / seg
        return ring[i] + (ring[i + 1] - ring[i]) * u

    out = [point_at(a)]
    keep = np.flatnonzero((cum > a + 1e-9) & (cum < b - 1e-9))
    for i in keep:
        out.append(ring[i])
    out.append(point_at(b))
    return np.asarray(out, dtype=np.float64)


def _corner_radius_for(v, prv, nxt, want=math.inf):
    """The largest arc radius that fits in a corner, capped at what was asked."""
    d0 = np.array(prv, float) - np.array(v, float)
    d1 = np.array(nxt, float) - np.array(v, float)
    n0, n1 = np.linalg.norm(d0), np.linalg.norm(d1)
    if n0 < 1e-9 or n1 < 1e-9 or want <= 1e-9:
        return 0.0
    cosang = float(np.clip(np.dot(d0 / n0, d1 / n1), -1.0, 1.0))
    ang = math.acos(cosang)
    if ang < 1e-4 or ang > math.pi - 1e-4:
        return 0.0                      # a straight line has no corner to round
    tan_half = math.tan(ang / 2.0)
    # the cut-back along each edge is r/tan(ang/2); it may not exceed half of
    # either edge or two neighbouring roundings eat each other
    max_r = min(n0, n1) / 2.0 * tan_half
    return min(want, max_r)


def _round_path(path, radii, tol):
    """Replace corners with arcs. `radii` is per-vertex; zero leaves it sharp."""
    pts = path.pts
    m = len(pts)
    if m < 3:
        return path
    out, corner = [], []
    for i in range(m):
        if not path.closed and (i == 0 or i == m - 1):
            out.append(tuple(pts[i]))
            corner.append(bool(path.corner[i]))
            continue
        r = radii[i] if i < len(radii) else 0.0
        if r <= 1e-6 or not path.corner[i]:
            out.append(tuple(pts[i]))
            corner.append(bool(path.corner[i]))
            continue
        v = pts[i]
        d0 = pts[(i - 1) % m] - v
        d1 = pts[(i + 1) % m] - v
        u0 = d0 / max(np.linalg.norm(d0), 1e-12)
        u1 = d1 / max(np.linalg.norm(d1), 1e-12)
        cosang = float(np.clip(np.dot(u0, u1), -1.0, 1.0))
        ang = math.acos(cosang)
        if ang < 1e-4 or ang > math.pi - 1e-4:
            out.append(tuple(v))
            corner.append(True)
            continue
        cut = r / math.tan(ang / 2.0)
        p0 = v + u0 * cut
        p1 = v + u1 * cut
        bis = u0 + u1
        bn = np.linalg.norm(bis)
        if bn < 1e-9:
            out.append(tuple(v))
            corner.append(True)
            continue
        centre = v + (bis / bn) * (r / math.sin(ang / 2.0))
        a0 = math.atan2(p0[1] - centre[1], p0[0] - centre[0])
        a1 = math.atan2(p1[1] - centre[1], p1[0] - centre[0])
        while a1 - a0 > math.pi:
            a1 -= 2 * math.pi
        while a1 - a0 < -math.pi:
            a1 += 2 * math.pi
        seg = _arc(centre[0], centre[1], r, r, a0, a1, tol)
        out.extend(seg)
        corner.extend([False] * len(seg))
    return Path(out, path.closed, corner)


def _segments_of(path):
    """Index ranges between real vertices - what "per segment" means."""
    n = len(path.pts)
    if n < 2:
        return []
    idx = [i for i in range(n) if path.corner[i]]
    if len(idx) < 2:
        return [(0, n - 1)] if not path.closed else [(0, n)]
    segs = []
    for k in range(len(idx) - 1):
        segs.append((idx[k], idx[k + 1]))
    if path.closed:
        segs.append((idx[-1], idx[0] + n))
    elif idx[-1] < n - 1:
        segs.append((idx[-1], n - 1))
    if not path.closed and idx[0] > 0:
        segs.insert(0, (0, idx[0]))
    return segs


def _normals(pts):
    """A unit normal per point, averaged from the two adjacent edges."""
    d = np.zeros_like(pts)
    d[:-1] += np.diff(pts, axis=0)
    d[1:] += np.diff(pts, axis=0)
    n = np.linalg.norm(d, axis=1, keepdims=True)
    d = d / np.maximum(n, 1e-12)
    return np.stack([-d[:, 1], d[:, 0]], axis=1)


# ---------------------------------------------------------------------------
# the rasteriser
# ---------------------------------------------------------------------------

def _bbox(contours, w, h, pad=1.0):
    lo = np.array([np.inf, np.inf])
    hi = np.array([-np.inf, -np.inf])
    for c in contours:
        if len(c) == 0:
            continue
        lo = np.minimum(lo, c.min(axis=0))
        hi = np.maximum(hi, c.max(axis=0))
    if not np.isfinite(lo).all():
        return None
    x0 = max(0, int(math.floor(lo[0] - pad)))
    y0 = max(0, int(math.floor(lo[1] - pad)))
    x1 = min(w, int(math.ceil(hi[0] + pad)))
    y1 = min(h, int(math.ceil(hi[1] + pad)))
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _rasterize(contours, x0, y0, bw, bh, rule="nonzero", samples=SAMPLES):
    """Coverage of a set of closed contours over a bw x bh box at (x0, y0).

    Exact in x, `samples` sub-scanlines in y. Every crossing of every
    sub-scanline is found at once, sorted once, and turned into spans; each
    span is deposited into a difference array with FRACTIONAL end weights, so
    the cumulative sum along x is the true covered area of every pixel. That
    fractional deposit is the whole trick - it is why a 45 degree edge here has
    no stair steps even though only four sub-scanlines were taken.
    """
    if bw <= 0 or bh <= 0:
        return None
    S = max(1, int(samples))
    ex0, ey0, ex1, ey1 = [], [], [], []
    for c in contours:
        if len(c) < 3:
            continue
        p = np.asarray(c, dtype=np.float64)
        q = np.roll(p, -1, axis=0)
        ex0.append(p[:, 0] - x0)
        ey0.append(p[:, 1] - y0)
        ex1.append(q[:, 0] - x0)
        ey1.append(q[:, 1] - y0)
    if not ex0:
        return None
    ex0 = np.concatenate(ex0)
    ey0 = np.concatenate(ey0)
    ex1 = np.concatenate(ex1)
    ey1 = np.concatenate(ey1)

    ylo = np.minimum(ey0, ey1)
    yhi = np.maximum(ey0, ey1)
    lim = bh * S
    k0 = np.clip(np.ceil(ylo * S - 0.5), 0, lim).astype(np.int64)
    k1 = np.clip(np.ceil(yhi * S - 0.5), 0, lim).astype(np.int64)
    n = np.maximum(k1 - k0, 0)
    total = int(n.sum())
    if total <= 0 or total > _MAX_CROSSINGS:
        return None

    offs = np.concatenate(([0], np.cumsum(n)))
    eidx = np.repeat(np.arange(len(n)), n)
    kk = np.repeat(k0, n) + (np.arange(total) - np.repeat(offs[:-1], n))
    y = (kk + 0.5) / S
    dy = ey1[eidx] - ey0[eidx]
    xc = ex0[eidx] + (y - ey0[eidx]) * (ex1[eidx] - ex0[eidx]) / dy
    dirn = np.where(dy > 0, 1, -1).astype(np.int64)

    order = np.lexsort((xc, kk))
    kk, xc, dirn = kk[order], xc[order], dirn[order]

    starts = np.flatnonzero(np.r_[True, kk[1:] != kk[:-1]])
    row_len = np.diff(np.r_[starts, total])
    if rule == "evenodd":
        pos = np.arange(total) - np.repeat(starts, row_len)
        inside = (pos & 1) == 0
    else:
        csum = np.cumsum(dirn)
        prev = np.where(starts > 0, csum[np.maximum(starts - 1, 0)], 0)
        inside = (csum - np.repeat(prev, row_len)) != 0
    last = np.zeros(total, dtype=bool)
    last[starts + row_len - 1] = True

    sel = np.flatnonzero(inside & ~last)
    if len(sel) == 0:
        return np.zeros((bh, bw), np.float32)
    xa = np.clip(xc[sel], 0.0, bw)
    xb = np.clip(xc[sel + 1], 0.0, bw)
    rows = kk[sel] // S
    keep = xb > xa + 1e-12
    xa, xb, rows = xa[keep], xb[keep], rows[keep]
    if len(xa) == 0:
        return np.zeros((bh, bw), np.float32)

    ia = np.floor(xa).astype(np.int64)
    ib = np.floor(xb).astype(np.int64)
    fa = xa - ia
    fb = xb - ib
    base = rows * (bw + 2)
    idxs = np.concatenate([base + ia, base + ia + 1, base + ib, base + ib + 1])
    wts = np.concatenate([1.0 - fa, fa, -(1.0 - fb), -fb])
    acc = np.bincount(idxs, weights=wts, minlength=bh * (bw + 2))[:bh * (bw + 2)]
    cov = np.cumsum(acc.reshape(bh, bw + 2), axis=1)[:, :bw] / S
    return np.clip(cov, 0.0, 1.0).astype(np.float32)


# ---------------------------------------------------------------------------
# strokes - built as outline geometry, then filled like anything else
# ---------------------------------------------------------------------------

def _circle_poly(cx, cy, r, tol):
    n = max(4, _arc_steps(r, 2 * math.pi, tol))
    a = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.stack([cx + r * np.cos(a), cy + r * np.sin(a)], axis=1)


def _stroke_outline(pts, closed, width, cap, join, miter_limit, tol):
    """Polygons whose NONZERO union is the stroked line.

    Every piece - segment quads, join wedges, caps - is emitted with the same
    winding, and nonzero fill of same-wound overlapping polygons is exactly
    their union. No clipping, no seams, and the joins are real geometry rather
    than a fattened line, so a miter limit means what it says.
    """
    hw = width / 2.0
    if hw <= 0 or len(pts) < 1:
        return []
    p = np.asarray(pts, dtype=np.float64)
    d = np.diff(np.vstack([p, p[:1]]) if closed else p, axis=0)
    keep = np.hypot(d[:, 0], d[:, 1]) > 1e-9
    if not keep.any():
        # a path collapsed to a point still draws under a round cap - AE's dot
        return [_circle_poly(p[0, 0], p[0, 1], hw, tol)] if cap == "round" else []
    ring = np.vstack([p, p[:1]]) if closed else p
    polys = []
    segs = []
    for i in range(len(ring) - 1):
        a, b = ring[i], ring[i + 1]
        v = b - a
        ln = math.hypot(v[0], v[1])
        if ln < 1e-9:
            continue
        u = v / ln
        nrm = np.array([-u[1], u[0]]) * hw
        polys.append(np.array([a + nrm, b + nrm, b - nrm, a - nrm]))
        segs.append((a, b, u))

    for k in range(len(segs) - (0 if closed else 1)):
        a0, b0, u0 = segs[k]
        a1, b1, u1 = segs[(k + 1) % len(segs)]
        v = b0
        cross = u0[0] * u1[1] - u0[1] * u1[0]
        dot = float(np.dot(u0, u1))
        if abs(cross) < 1e-9 and dot > 0:
            continue                                  # collinear, nothing to join
        if join == "round":
            polys.append(_circle_poly(v[0], v[1], hw, tol))
            continue
        s = -1.0 if cross > 0 else 1.0
        n0 = np.array([-u0[1], u0[0]]) * hw * s
        n1 = np.array([-u1[1], u1[0]]) * hw * s
        pa, pb = v + n0, v + n1
        if join == "miter":
            bis = n0 + n1
            bn = np.linalg.norm(bis)
            if bn > 1e-9:
                mid = bis / bn
                cosphi = float(np.dot(n0 / hw, mid))
                if cosphi > 1e-6 and (1.0 / cosphi) <= miter_limit:
                    polys.append(np.array([v, pa, v + mid * (hw / cosphi), pb]))
                    continue
        polys.append(np.array([v, pa, pb]))

    if not closed:
        if cap == "round":
            polys.append(_circle_poly(ring[0, 0], ring[0, 1], hw, tol))
            polys.append(_circle_poly(ring[-1, 0], ring[-1, 1], hw, tol))
        elif cap == "square":
            for end, u, sign in ((segs[0][0], segs[0][2], -1.0),
                                 (segs[-1][1], segs[-1][2], 1.0)):
                nrm = np.array([-u[1], u[0]]) * hw
                tip = end + u * hw * sign
                polys.append(np.array([end + nrm, tip + nrm, tip - nrm, end - nrm]))

    return [_orient(q, True) for q in polys if abs(_signed_area(q)) > 1e-9]


def _dash_split(pts, closed, pattern, offset):
    """Cut a contour into dashes by arc length. Returns open polylines."""
    pat = [abs(x) for x in pattern if math.isfinite(x)]
    while pat and pat[-1] == 0:
        pat.pop()
    if len(pat) < 2 or sum(pat) <= 1e-6:
        return [(pts, closed)]
    if len(pat) % 2:
        pat = pat + pat                              # odd patterns repeat, as SVG does
    period = sum(pat)
    lens = _seg_lengths(pts, closed)
    total = float(lens.sum())
    if total <= 1e-9:
        return []
    out = []
    d = -(offset % period)
    on = True
    i = 0
    while d < total:
        step = pat[i % len(pat)]
        a, b = d, d + step
        if on and b > 0:
            lo = max(a, 0.0) / total
            hi = min(b, total) / total
            piece = _resample_range(pts, closed, lo, hi)
            if piece is not None and len(piece) >= 2:
                out.append((piece, False))
        d = b
        on = not on
        i += 1
    return out


# ---------------------------------------------------------------------------
# path operations
# ---------------------------------------------------------------------------

def _op_trim(paths, p, tol):
    if not paths:
        return paths
    u0 = p["start"] / 100.0 + p["offset"] / 360.0
    u1 = p["end"] / 100.0 + p["offset"] / 360.0
    if u1 < u0:
        u1 += 1.0                     # start past end wraps through the seam
    span = u1 - u0
    if span <= 1e-9:
        return []
    if span >= 1.0 - 1e-9:
        return paths

    def pieces(lo, hi):
        """One range in unwrapped space -> up to two ranges in 0..1."""
        base = math.floor(lo)
        lo -= base
        hi -= base
        if hi <= 1.0 + 1e-9:
            return [(lo, min(hi, 1.0))]
        return [(lo, 1.0), (0.0, hi - 1.0)]

    out = []
    if p["trimMultipleShapes"] == "individually":
        lens = [max(path_length(pa), 1e-9) for pa in paths]
        total = sum(lens)
        run = 0.0
        for pa, ln in zip(paths, lens):
            a, b = run / total, (run + ln) / total
            run += ln
            for lo, hi in pieces(u0, u1):
                s = max(lo, a)
                e = min(hi, b)
                if e - s <= 1e-9:
                    continue
                seg = _resample_range(pa.pts, pa.closed, (s - a) / (b - a), (e - a) / (b - a))
                if seg is not None and len(seg) >= 2:
                    out.append(Path(seg, False, _corner_carry(pa, seg)))
    else:
        for pa in paths:
            for lo, hi in pieces(u0, u1):
                seg = _resample_range(pa.pts, pa.closed, lo, hi)
                if seg is not None and len(seg) >= 2:
                    out.append(Path(seg, False, _corner_carry(pa, seg)))
    return out


def _corner_carry(src, pts):
    """A trimmed piece keeps corner-ness only at points that coincide with a
    real vertex of the original - otherwise Round Corners after a Trim would
    round the two fresh cut ends, which are not corners."""
    if len(src.pts) == 0:
        return np.zeros(len(pts), bool)
    real = src.pts[src.corner]
    if len(real) == 0:
        return np.zeros(len(pts), bool)
    d = np.abs(pts[:, None, :] - real[None, :, :]).max(axis=2)
    return (d.min(axis=1) < 1e-7)


def _affine(anchor, position, scale, rotation, skew=0.0, skew_axis=0.0):
    sx, sy = scale[0] / 100.0, scale[1] / 100.0
    rad = math.radians(rotation)
    c, s = math.cos(rad), math.sin(rad)
    m = np.array([[c * sx, -s * sy], [s * sx, c * sy]], dtype=np.float64)
    if abs(skew) > 1e-9:
        ar = math.radians(skew_axis)
        ca, sa = math.cos(ar), math.sin(ar)
        rot = np.array([[ca, -sa], [sa, ca]])
        shear = np.array([[1.0, math.tan(math.radians(skew))], [0.0, 1.0]])
        m = m @ rot @ shear @ rot.T
    t = np.array([position[0], position[1]], float) - m @ np.array(anchor, float)
    return np.hstack([m, t.reshape(2, 1)])


def _pivot_affine(anchor, position, scale, rotation):
    """Scale and rotate ABOUT the anchor, then travel by position.

    Not the same composition as `_affine`, and the difference is the repeater:
    a group's position is where its anchor lands, but a repeater's position is
    how far each copy MOVES from the one before, so its anchor has to stay put
    when position is zero. Getting these two the same way round is what turns
    "rotate 90 per copy about the middle" from a pinwheel into three shapes
    flung at the origin.
    """
    sx, sy = scale[0] / 100.0, scale[1] / 100.0
    rad = math.radians(rotation)
    c, s = math.cos(rad), math.sin(rad)
    m = np.array([[c * sx, -s * sy], [s * sx, c * sy]], dtype=np.float64)
    a = np.array(anchor, float)
    t = np.array(position, float) + a - m @ a
    return np.hstack([m, t.reshape(2, 1)])


IDENTITY = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])


def _mat_mul(a, b):
    a3 = np.vstack([a, [0.0, 0.0, 1.0]])
    b3 = np.vstack([b, [0.0, 0.0, 1.0]])
    return (a3 @ b3)[:2]


def _apply_mat(m, pts):
    return np.asarray(pts, float).reshape(-1, 2) @ m[:, :2].T + m[:, 2]


def _mat_scale(m):
    """The uniform scale factor a matrix carries, for stroke widths. A
    non-uniform scale makes a real stroke elliptical, which a scalar width
    cannot express - the geometric mean is the honest single number."""
    return math.sqrt(abs(float(np.linalg.det(m[:, :2])))) or 1.0


def _op_offset(paths, p, tol):
    """Push every point out along the corner bisector by `amount`.

    Each vertex moves by amount / cos(half the turn) so the two offset EDGES
    actually meet - offsetting along an averaged normal instead pinches every
    corner inward, which looks like a bug on a rectangle. Outward corners open
    a wedge, filled by the chosen join; the miter limit falls back to bevel,
    same rule a stroke follows.
    """
    amt = p["amount"]
    if abs(amt) < 1e-6:
        return paths
    out = []
    for pa in paths:
        pts = pa.pts
        m = len(pts)
        if m < 2:
            continue
        # Outward is the side the winding says - every primitive here winds the
        # same way, so a hole (wound the other way) shrinks as the outline
        # grows, which is what "offset" means on a path with holes.
        sign = -1.0 if (pa.closed and _signed_area(pts) > 0) else 1.0
        d = np.diff(np.vstack([pts, pts[:1]]), axis=0)
        ln = np.hypot(d[:, 0], d[:, 1])[:, None]
        u = d / np.maximum(ln, 1e-12)
        nrm = np.stack([-u[:, 1], u[:, 0]], axis=1) * (amt * sign)
        f = amt * sign
        joined, corner = [], []
        for i in range(m):
            j = (i - 1) % m
            n_in, n_out = nrm[j], nrm[i]
            if not pa.closed and i == 0:
                n_in = n_out
            if not pa.closed and i == m - 1:
                n_out = n_in
            bis = n_in + n_out
            bn = float(np.linalg.norm(bis))
            if bn < 1e-9:
                joined.append(tuple(pts[i] + n_in))
                corner.append(True)
                continue
            cos_half = bn / (2.0 * max(abs(amt), 1e-12))
            # Only a corner that turns AWAY from the offset direction opens a
            # gap; the other one has the two offset edges crossing, where a
            # join wedge would bulge outward instead of filling anything.
            cross = float(u[j][0] * u[i][1] - u[j][1] * u[i][0])
            opens = cross * f < 0 and abs(cross) > 1e-9
            if opens and p["lineJoin"] != "miter" and abs(amt) > tol:
                seg = _join_wedge(pts[i], n_in, n_out, p["lineJoin"], tol)
                joined.extend(seg)
                corner.extend([False] * len(seg))
            elif opens and (1.0 / max(cos_half, 1e-9)) > p["miterLimit"]:
                joined.extend([tuple(pts[i] + n_in), tuple(pts[i] + n_out)])
                corner.extend([False, False])
            else:
                joined.append(tuple(pts[i] + bis / bn * (abs(amt) / max(cos_half, 1e-9))))
                corner.append(bool(pa.corner[i]))
        out.append(Path(joined, pa.closed, corner))
    return out


def _join_wedge(v, n_in, n_out, join, tol):
    """The points that carry an offset from one edge's normal to the next."""
    if join == "bevel":
        return [tuple(v + n_in), tuple(v + n_out)]
    r = float(np.linalg.norm(n_in))
    a0 = math.atan2(n_in[1], n_in[0])
    a1 = math.atan2(n_out[1], n_out[0])
    while a1 - a0 > math.pi:
        a1 -= 2 * math.pi
    while a1 - a0 < -math.pi:
        a1 += 2 * math.pi
    return _arc(v[0], v[1], r, r, a0, a1, tol)


def _op_round(paths, p, tol):
    r = p["radius"]
    if r <= 1e-6:
        return paths
    return [_round_path(pa, [_corner_radius_for(pa.pts[i], pa.pts[(i - 1) % len(pa.pts)],
                                                pa.pts[(i + 1) % len(pa.pts)], r)
                             for i in range(len(pa.pts))], tol)
            if len(pa.pts) >= 3 else pa for pa in paths]


def _resample_segment(pts, count):
    """`count` evenly spaced points along a polyline, endpoints included."""
    d = np.diff(pts, axis=0)
    lens = np.hypot(d[:, 0], d[:, 1])
    cum = np.concatenate(([0.0], np.cumsum(lens)))
    total = cum[-1]
    if total <= 1e-9:
        return np.repeat(pts[:1], count, axis=0)
    want = np.linspace(0.0, total, count)
    x = np.interp(want, cum, pts[:, 0])
    y = np.interp(want, cum, pts[:, 1])
    return np.stack([x, y], axis=1)


def _walk_segments(path):
    """Every real segment of a path as its own point array, in order."""
    n = len(path.pts)
    if n < 2:
        return []
    out = []
    for a, b in _segments_of(path):
        idx = [i % n for i in range(a, b + 1)]
        if len(idx) >= 2:
            out.append(path.pts[idx])
    return out


def _op_zigzag(paths, p, tol):
    size = p["size"]
    ridges = max(1, int(p["ridges"]))
    if abs(size) < 1e-6:
        return paths
    smooth = p["points"] == "smooth"
    out = []
    for pa in paths:
        segs = _walk_segments(pa)
        if not segs:
            continue
        pts, corner = [], []
        for si, seg in enumerate(segs):
            # Sample at least as densely as the segment already was, so
            # zigzagging a circle keeps the circle; k is a whole number of
            # samples per half-ridge, which is what puts a sample exactly on
            # every peak instead of near one.
            k = max(4 if smooth else 1,
                    int(math.ceil((len(seg) - 1) / (2.0 * ridges))))
            n = 2 * ridges * k + 1
            samp = _resample_segment(seg, n)
            nrm = _normals(samp)
            # A triangle wave, built from a sine so its peaks land on integers:
            # zero at both ends, `ridges` peaks in between, alternating sides.
            phase = np.linspace(0.0, math.pi * ridges, n)
            amp = np.sin(phase)
            if not smooth:
                amp = (2.0 / math.pi) * np.arcsin(amp)
            samp = samp + nrm * (amp * size)[:, None]
            start = 0 if si == 0 else 1
            pts.extend(samp[start:])
            corner.extend([True] * len(samp[start:]))
        if len(pts) >= 2:
            out.append(Path(np.asarray(pts), pa.closed, corner))
    return out


def _noise(seed, idx, phase):
    """Value noise: reproducible from (seed, point index, time step), smooth in
    time. A wiggle that moves with the wall clock is a wiggle that renders
    differently every time, which is not a wiggle, it is a bug."""
    def h(a, b, c):
        x = (np.asarray(a, np.uint64) * np.uint64(374761393)
             + np.uint64(b % 1000003) * np.uint64(668265263)
             + np.uint64(c % 1000003) * np.uint64(2246822519))
        x = x & np.uint64(0xFFFFFFFF)
        x = ((x ^ (x >> np.uint64(13))) * np.uint64(1274126177)) & np.uint64(0xFFFFFFFF)
        return (x ^ (x >> np.uint64(16))).astype(np.float64) / 4294967295.0

    f0 = int(math.floor(phase))
    u = phase - f0
    u = u * u * (3.0 - 2.0 * u)
    a = h(idx, seed, f0)
    b = h(idx, seed, f0 + 1)
    return (a + (b - a) * u) * 2.0 - 1.0


def _op_wiggle(paths, p, tol, t):
    size = p["size"]
    if size < 1e-6:
        return paths
    detail = max(1, int(p["detail"]))
    seed = int(p["seed"])
    phase = float(t) * p["wigglesPerSecond"]
    out = []
    counter = 0
    for pa in paths:
        segs = _walk_segments(pa)
        if not segs:
            continue
        pts, corner = [], []
        for si, seg in enumerate(segs):
            # never coarser than the source: roughening a circle must not turn
            # it into a polygon on the way
            samp = _resample_segment(seg, max(detail + 1, len(seg)))
            idx = np.arange(counter, counter + len(samp), dtype=np.uint64)
            counter += len(samp)
            dx = _noise(seed, idx, phase) * size
            dy = _noise(seed + 7919, idx, phase) * size
            samp = samp + np.stack([dx, dy], axis=1)
            start = 0 if si == 0 else 1
            pts.extend(samp[start:])
            corner.extend([False] * len(samp[start:]))
        if len(pts) >= 2:
            if pts:
                corner[0] = True
                corner[-1] = True
            out.append(Path(np.asarray(pts), pa.closed, corner))
    return out


def _op_merge(paths, p, tol):
    """Boolean combine, resolved through a raster and traced back.

    There is no polygon clipper on this box, and the winding-rule shortcut
    everyone reaches for (orient the subtracted contours backwards, fill
    nonzero) is simply WRONG once two subtracted shapes overlap: their windings
    add to -2, which is still nonzero, and the hole fills back in. A raster
    round trip is slower and half a sub-pixel less precise, and it is right.
    """
    if len(paths) < 2:
        return paths
    mode = p["mode"]
    res = max(1, int(p["resolution"]))
    # Local shape space, not canvas space: this runs BEFORE the group transform
    # and its coordinates are centred on zero, so clipping to the frame here
    # would throw away everything left of the middle.
    allpts = np.vstack([pa.pts for pa in paths if len(pa.pts)])
    if len(allpts) < 3:
        return paths
    x0, y0 = np.floor(allpts.min(axis=0) - 2.0)
    x1, y1 = np.ceil(allpts.max(axis=0) + 2.0)
    bw, bh = int((x1 - x0) * res), int((y1 - y0) * res)
    if bw <= 0 or bh <= 0 or bw * bh > 80_000_000:
        return paths

    def cov_of(pa):
        c = (pa.pts - np.array([x0, y0])) * res
        return _rasterize([c], 0, 0, bw, bh, "nonzero", 2)

    acc = cov_of(paths[0])
    if acc is None:
        acc = np.zeros((bh, bw), np.float32)
    for pa in paths[1:]:
        c = cov_of(pa)
        if c is None:
            c = np.zeros((bh, bw), np.float32)
        if mode == "add":
            acc = acc + c - acc * c
        elif mode == "subtract":
            acc = acc * (1.0 - c)
        elif mode == "intersect":
            acc = acc * c
        else:
            acc = acc + c - 2.0 * acc * c

    mask = (acc > 0.5).astype(np.uint8)
    found = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    cnts, hier = (found[0], found[1]) if len(found) == 2 else (found[1], found[2])
    out = []
    for i, c in enumerate(cnts):
        c = cv2.approxPolyDP(c, 0.5, True).reshape(-1, 2).astype(np.float64)
        if len(c) < 3:
            continue
        pts = (c + 0.5) / res + np.array([x0, y0])
        hole = hier is not None and len(hier) and hier[0][i][3] >= 0
        pts = _orient(pts, positive=not hole)   # holes wound the other way, so a
        out.append(Path(pts, True, [False] * len(pts)))   # nonzero fill keeps them
    return out


# ---------------------------------------------------------------------------
# gradients
# ---------------------------------------------------------------------------

def _stops_of(p):
    flat = p.get("stopValues")
    flat = list(flat) if isinstance(flat, (list, tuple)) else []
    raw = p.get("stops")
    raw = raw if isinstance(raw, (list, tuple)) else []
    stops = []
    if len(flat) >= 8 and len(flat) % 4 == 0:
        for i in range(0, len(flat), 4):
            stops.append((max(0.0, min(1.0, _f(flat[i]))),
                          _rgb01(flat[i + 1:i + 4]), 1.0))
    else:
        for s in raw:
            if not isinstance(s, dict):
                continue
            stops.append((max(0.0, min(1.0, _f(s.get("pos")))),
                          _rgb01(s.get("color") or [255, 255, 255]),
                          max(0.0, min(1.0, _f(s.get("opacity"), 100.0) / 100.0))))
    if len(stops) < 2:
        return None
    stops.sort(key=lambda s: s[0])
    return stops


def _gradient(p, m, x0, y0, bw, bh):
    stops = _stops_of(p)
    if stops is None:
        return None, None
    a = _apply_mat(m, [p["startPoint"]])[0]
    b = _apply_mat(m, [p["endPoint"]])[0]
    xx = np.arange(x0, x0 + bw, dtype=np.float32)[None, :]
    yy = np.arange(y0, y0 + bh, dtype=np.float32)[:, None]
    dx, dy = float(b[0] - a[0]), float(b[1] - a[1])
    if p["gradientType"] == "radial":
        r = math.hypot(dx, dy)
        if r < 1e-6:
            u = np.zeros((bh, bw), np.float32)
        else:
            u = np.sqrt((xx - a[0]) ** 2 + (yy - a[1]) ** 2) / r
    else:
        den = dx * dx + dy * dy
        if den < 1e-9:
            u = np.zeros((bh, bw), np.float32)
        else:
            u = ((xx - a[0]) * dx + (yy - a[1]) * dy) / den
    u = np.clip(u + np.zeros((bh, bw), np.float32), 0.0, 1.0)
    # The ramp is baked into a 1024-entry table and gathered, not interpolated
    # per pixel: np.interp on a million pixels costs more than the rasteriser
    # that produced them, and 10 bits is finer than anything downstream keeps.
    xs = np.array([s[0] for s in stops], np.float32)
    grid = np.linspace(0.0, 1.0, 1024, dtype=np.float32)
    lut = np.stack([np.interp(grid, xs, np.array([s[1][ch] for s in stops], np.float32))
                    for ch in range(3)], axis=1).astype(np.float32)
    lut_a = np.interp(grid, xs, np.array([s[2] for s in stops], np.float32)).astype(np.float32)
    idx = np.minimum((u * 1023.0).astype(np.int32), 1023)
    return lut[idx], lut_a[idx]


# ---------------------------------------------------------------------------
# the canvas
# ---------------------------------------------------------------------------

class _Canvas:
    """Premultiplied accumulator. Straight alpha in and out, premultiplied in
    between: `over` is one multiply-add per channel that way instead of a
    divide per paint, and the single divide at the end is what makes the
    returned buffer straight the way the engine contract demands.

    Colour is stored PLANAR, (3, H, W). Interleaved (H, W, 3) costs 5.7x more
    here for the same arithmetic: the coverage broadcasts with a zero stride on
    the last axis, numpy cannot collapse the loop, and the inner loop runs
    three elements at a time over a 240 000-pixel region. Planar puts the wide
    contiguous axis last where the vectoriser wants it.
    """

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.pm = np.zeros((3, h, w), np.float32)
        self.a = np.zeros((h, w), np.float32)
        self.dirty = None          # nothing painted has to be un-premultiplied

    def over(self, x0, y0, rgb, a):
        bh, bw = a.shape
        box = (slice(y0, y0 + bh), slice(x0, x0 + bw))
        sl = (slice(None),) + box
        inv = 1.0 - a
        src = (np.moveaxis(rgb, 2, 0) * a) if rgb.ndim == 3 else (rgb[:, None, None] * a)
        self.pm[sl] *= inv
        self.pm[sl] += src
        self.a[box] *= inv
        self.a[box] += a
        b = (x0, y0, x0 + bw, y0 + bh)
        self.dirty = b if self.dirty is None else (
            min(self.dirty[0], b[0]), min(self.dirty[1], b[1]),
            max(self.dirty[2], b[2]), max(self.dirty[3], b[3]))

    def rgba(self):
        # Only the painted region is divided back out. A badge in the corner of
        # a 1080p frame should not cost three full-frame float passes, and
        # np.zeros is a calloc whose untouched pages never fault in.
        out = np.zeros((self.h, self.w, 4), np.float32)
        if self.dirty is None:
            return out
        x0, y0, x1, y1 = self.dirty
        a = np.clip(self.a[y0:y1, x0:x1], 0.0, 1.0)
        d = np.maximum(a, _EPS)
        for c in range(3):
            np.clip(self.pm[c, y0:y1, x0:x1] / d, 0.0, 1.0, out=out[y0:y1, x0:x1, c])
        out[y0:y1, x0:x1, 3] = a
        return out


# ---------------------------------------------------------------------------
# painting
# ---------------------------------------------------------------------------

def _paint(canvas, contours, rule, samples, colour, opacity, grad=None):
    if opacity <= 1e-6 or not contours:
        return
    box = _bbox(contours, canvas.w, canvas.h, pad=1.0)
    if box is None:
        return
    x0, y0, x1, y1 = box
    cov = _rasterize(contours, x0, y0, x1 - x0, y1 - y0, rule, samples)
    if cov is None:
        return
    if grad is not None:
        rgb, ga = _gradient(grad[0], grad[1], x0, y0, x1 - x0, y1 - y0)
        if rgb is None:
            return
        canvas.over(x0, y0, rgb, cov * ga * opacity)
    else:
        canvas.over(x0, y0, colour, cov * opacity)


def _stroke_contours(paths, p, tol, m):
    """The outline polygons for a stroke, in canvas space."""
    width = p["width"] * _mat_scale(m)
    if width <= 1e-4:
        return []
    dashes = [x * _mat_scale(m) for x in (p["dashes"] or [])]
    out = []
    for pa in paths:
        pts = _apply_mat(m, pa.pts)
        pieces = (_dash_split(pts, pa.closed, dashes, p["dashOffset"] * _mat_scale(m))
                  if dashes else [(pts, pa.closed)])
        for sub, closed in pieces:
            out.extend(_stroke_outline(sub, closed, width, p["lineCap"], p["lineJoin"],
                                       p["miterLimit"], tol))
    return out


# ---------------------------------------------------------------------------
# the group program
# ---------------------------------------------------------------------------

def _item_type(it):
    if not isinstance(it, dict):
        return None
    raw = str(it.get("type") or ("group" if "items" in it else "")).strip()
    return ALIASES.get(raw, raw)


def _run_items(items, canvas, m, opacity, t, ev, tol, samples, depth=0):
    """Walk a group's item list once: paths accumulate, operations rewrite,
    paints draw."""
    paths = []
    for it in items if isinstance(items, (list, tuple)) else []:
        kind = _item_type(it)
        if kind is None or kind not in CATALOG:
            continue
        if it.get("enabled") is False:
            continue
        spec = CATALOG[kind]["params"]
        if kind in _PATH_BUILDERS:
            paths.extend(_PATH_BUILDERS[kind](_coerce(spec, it, t, ev), tol))
        elif kind == "group":
            if depth < 6:
                _render_group(it, canvas, m, opacity, t, ev, tol, samples, depth + 1)
        elif kind == "trim":
            paths = _op_trim(paths, _coerce(spec, it, t, ev), tol)
        elif kind == "offsetPath":
            paths = _op_offset(paths, _coerce(spec, it, t, ev), tol)
        elif kind == "roundCorners":
            paths = _op_round(paths, _coerce(spec, it, t, ev), tol)
        elif kind == "zigzag":
            paths = _op_zigzag(paths, _coerce(spec, it, t, ev), tol)
        elif kind == "wiggle":
            paths = _op_wiggle(paths, _coerce(spec, it, t, ev), tol, t)
        elif kind == "merge":
            paths = _op_merge(paths, _coerce(spec, it, t, ev), tol)
        elif kind == "repeater":
            continue                              # handled by _render_group
        elif kind == "fill":
            p = _coerce(spec, it, t, ev)
            _paint(canvas, [_apply_mat(m, pa.pts) for pa in paths if len(pa.pts) >= 3],
                   p["fillRule"], samples, _rgb01(p["color"]),
                   p["opacity"] / 100.0 * opacity)
        elif kind == "gradientFill":
            p = _coerce(spec, it, t, ev)
            _paint(canvas, [_apply_mat(m, pa.pts) for pa in paths if len(pa.pts) >= 3],
                   p["fillRule"], samples, None, p["opacity"] / 100.0 * opacity,
                   grad=(p, m))
        elif kind == "stroke":
            p = _coerce(spec, it, t, ev)
            _paint(canvas, _stroke_contours(paths, p, tol, m), "nonzero", samples,
                   _rgb01(p["color"]), p["opacity"] / 100.0 * opacity)
        elif kind == "gradientStroke":
            p = _coerce(spec, it, t, ev)
            _paint(canvas, _stroke_contours(paths, p, tol, m), "nonzero", samples,
                   None, p["opacity"] / 100.0 * opacity, grad=(p, m))
    return paths


def _render_group(group, canvas, parent_m, parent_opacity, t, ev, tol, samples, depth=0):
    if not isinstance(group, dict) or group.get("enabled") is False:
        return
    items = group.get("items")
    if items is None and isinstance(group.get("shapes"), list):
        items = group["shapes"]
    xf = _coerce(GROUP_TRANSFORM, group.get("transform") or {}, t, ev)
    m = _mat_mul(parent_m, _affine(xf["anchor"], xf["position"], xf["scale"],
                                   xf["rotation"], xf["skew"], xf["skewAxis"]))
    opacity = parent_opacity * xf["opacity"] / 100.0
    if opacity <= 1e-6:
        return

    rep = None
    for it in items if isinstance(items, (list, tuple)) else []:
        if _item_type(it) == "repeater" and it.get("enabled") is not False:
            rep = _coerce(CATALOG["repeater"]["params"], it, t, ev)
    if rep is None:
        _run_items(items, canvas, m, opacity, t, ev, tol, samples, depth)
        return

    # A repeater repeats the whole group, paint included, with the transform
    # applied once more per copy - so it is done here rather than as a path
    # operation, which is also the only way the per-copy opacity can reach the
    # paints it is supposed to fade.
    n = max(1, int(rep["copies"]))
    step = _pivot_affine(rep["anchor"], rep["position"], rep["scale"], rep["rotation"])
    back = None
    order = range(n - 1, -1, -1) if rep["composite"] == "above" else range(n)
    for i in order:
        k = i + rep["offset"]
        sign = 1.0 if k >= 0 else -1.0
        whole = int(math.floor(abs(k)))
        frac = abs(k) - whole
        if sign < 0 and back is None:
            try:
                back = np.linalg.inv(np.vstack([step, [0.0, 0.0, 1.0]]))[:2]
            except np.linalg.LinAlgError:
                back = IDENTITY
        cm = m
        for _ in range(min(whole, 512)):
            cm = _mat_mul(cm, step if sign > 0 else back)
        if frac > 1e-6:
            # A fractional offset is one PARTIAL application of the step, not a
            # scaled anchor: the pivot is the same pivot, only the travel shrinks.
            part = _pivot_affine(rep["anchor"],
                                 [c * frac * sign for c in rep["position"]],
                                 [100 + (rep["scale"][0] - 100) * frac * sign,
                                  100 + (rep["scale"][1] - 100) * frac * sign],
                                 rep["rotation"] * frac * sign)
            cm = _mat_mul(cm, part)
        u = 0.0 if n == 1 else i / float(n - 1)
        o = (rep["startOpacity"] + (rep["endOpacity"] - rep["startOpacity"]) * u) / 100.0
        if o <= 1e-6:
            continue
        _run_items(items, canvas, cm, opacity * o, t, ev, tol, samples, depth)


# ---------------------------------------------------------------------------
# the entry point
# ---------------------------------------------------------------------------

def render_shape(layer, t, width, height, eval_prop=None, scale=1.0, draft=False):
    """One shape layer's own pixels at comp time t.

    Returns float32 (height, width, 4), 0..1, STRAIGHT alpha - the same thing
    a text layer returns, so the engine's transform / effect / mask / matte
    path applies unchanged.

    `width` and `height` are the RENDER canvas and are already multiplied by
    `scale`; `scale` is passed as well because the geometry in the document is
    in comp pixels and has to be brought to render pixels here.

    A malformed item is skipped, never raised on: the same rule the effect
    registry follows, because a typo in one of forty shape items must not cost
    a nine-hundred-frame render.
    """
    W, H = max(1, int(width)), max(1, int(height))
    canvas = _Canvas(W, H)
    if not isinstance(layer, dict):
        return canvas.rgba()
    ev = eval_prop or _default_eval
    s = _f(scale, 1.0)
    s = s if s > 1e-6 else 1.0
    samples = DRAFT_SAMPLES if draft else SAMPLES
    tol = FLATNESS

    shapes = layer.get("shapes")
    if not isinstance(shapes, list) or not shapes:
        return canvas.rgba()
    groups = shapes if all(_item_type(g) == "group" for g in shapes) else [{"items": shapes}]

    origin = str(layer.get("origin") or "center").lower()
    ox, oy = (0.0, 0.0) if origin in ("topleft", "top-left") else (W / 2.0, H / 2.0)
    base = np.array([[s, 0.0, ox], [0.0, s, oy]], dtype=np.float64)

    for g in groups:
        try:
            _render_group(g, canvas, base, 1.0, t, ev, tol, samples)
        except Exception as exc:                        # noqa: BLE001
            print(f"[shapes] group failed: {exc}", file=sys.stderr)
    return canvas.rgba()


# ---------------------------------------------------------------------------
# ready-made constructors - the vocabulary, spelled out
# ---------------------------------------------------------------------------

def line_draw(points=(-300, 80, -100, -60, 100, 60, 300, -80),
              color=(255, 255, 255), width=8, duration=1.5, start=0.0,
              cap="round", join="round", name="line draw"):
    """A polyline that draws itself. `points` is a flat [x0,y0,x1,y1,...] list in
    layer pixels from the centre. Returns a whole LAYER, ready for comp.layers."""
    return {
        "type": "shape", "name": name,
        "shapes": [{"type": "group", "name": name, "items": [
            {"type": "path", "points": list(points), "closed": False},
            {"type": "trim", "start": 0, "end": {"keys": [
                {"t": start, "v": 0, "ease": "easeInOut"},
                {"t": start + max(0.01, duration), "v": 100}]}},
            {"type": "stroke", "color": list(color), "width": width,
             "lineCap": cap, "lineJoin": join},
        ]}],
    }


def progress_ring(radius=160, width=18, color=(90, 200, 255),
                  track=(40, 44, 56), from_pct=0.0, to_pct=100.0,
                  duration=2.0, start=0.0, name="progress ring"):
    """A ring that fills clockwise from twelve o'clock: a grey track underneath,
    a coloured arc on top whose trim end is keyframed. Returns a LAYER."""
    ring = {"type": "ellipse", "size": [radius * 2, radius * 2], "position": [0, 0]}
    return {
        "type": "shape", "name": name,
        "shapes": [
            {"type": "group", "name": "track", "items": [
                dict(ring),
                {"type": "stroke", "color": list(track), "width": width},
            ]},
            {"type": "group", "name": "arc", "items": [
                dict(ring),
                {"type": "trim", "start": from_pct, "offset": 0, "end": {"keys": [
                    {"t": start, "v": from_pct, "ease": "easeInOut"},
                    {"t": start + max(0.01, duration), "v": to_pct}]}},
                {"type": "stroke", "color": list(color), "width": width,
                 "lineCap": "round"},
            ]},
        ],
    }


def burst(rays=12, length=140, inner=60, width=6, color=(255, 214, 120),
          spin=0.0, duration=2.0, name="burst"):
    """A radial sunburst: one ray, repeated and rotated. Shows the repeater and
    a keyframed group rotation together. Returns a LAYER."""
    per = 360.0 / max(1, int(rays))
    return {
        "type": "shape", "name": name,
        "shapes": [{"type": "group", "name": name,
                    "transform": {"rotation": {"keys": [
                        {"t": 0.0, "v": 0.0},
                        {"t": max(0.01, duration), "v": spin}]}},
                    "items": [
                        {"type": "path", "points": [0, -inner, 0, -(inner + length)],
                         "closed": False},
                        {"type": "stroke", "color": list(color), "width": width,
                         "lineCap": "round"},
                        {"type": "repeater", "copies": int(rays), "rotation": per,
                         "position": [0, 0], "anchor": [0, 0],
                         "startOpacity": 100, "endOpacity": 100},
                    ]}],
    }


CONSTRUCTORS = {"line_draw": line_draw, "progress_ring": progress_ring, "burst": burst}


def catalog():
    """What MCP and /api/vfx/catalog serve for shapes."""
    return {"shapes": CATALOG, "groups": GROUP_ORDER,
            "names": sorted(CATALOG), "aliases": ALIASES,
            "constructors": sorted(CONSTRUCTORS),
            "notes": {
                "coordinates": "layer pixels, (0,0) at the layer centre unless the "
                               "layer sets origin:'topLeft'",
                "order": "items run first to last; paths accumulate, operations "
                         "rewrite, paints draw and later paints draw on top",
                "antialiasing": f"exact in x, {SAMPLES} sub-scanlines in y "
                                f"({DRAFT_SAMPLES} in draft)",
            }}


def _bench():
    ev = _default_eval
    W, H = 1920, 1080
    cases = {
        "filled rect 600x400": {"shapes": [{"type": "group", "items": [
            {"type": "rect", "size": [600, 400], "roundness": 40},
            {"type": "fill", "color": [200, 60, 90]}]}]},
        "trimmed stroke (circle r=400, w=24)": {"shapes": [{"type": "group", "items": [
            {"type": "ellipse", "size": [800, 800]},
            {"type": "trim", "start": 0, "end": 65},
            {"type": "stroke", "color": [90, 200, 255], "width": 24,
             "lineCap": "round"}]}]},
        "repeater x12 (rays)": burst(rays=12, length=300, inner=80, width=10),
        "gradient fill": {"shapes": [{"type": "group", "items": [
            {"type": "ellipse", "size": [900, 900]},
            {"type": "gradientFill", "startPoint": [-450, -450],
             "endPoint": [450, 450]}]}]},
        "dashed stroke": {"shapes": [{"type": "group", "items": [
            {"type": "ellipse", "size": [800, 800]},
            {"type": "stroke", "width": 16, "dashes": [30, 20]}]}]},
    }
    out = {}
    for name, layer in cases.items():
        render_shape(layer, 0.5, W, H, ev)                    # warm
        n = 5
        t0 = time.perf_counter()
        for _ in range(n):
            render_shape(layer, 0.5, W, H, ev)
        out[name] = round((time.perf_counter() - t0) / n * 1000.0, 1)
    return out


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    elif mode == "bench":
        print(json.dumps({"ok": True, "ms": _bench(), "size": "1920x1080",
                          "samples": SAMPLES}, indent=2))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
