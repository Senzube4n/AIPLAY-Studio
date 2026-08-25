"""Shapes, canvas and geometry - the half of the Image menu that did not exist.

Everything here is a pure function over float32 (H, W, 4), 0..1, **STRAIGHT
alpha**, and returns the same. That is the contract docs/IMAGE_SPEC.md sets for
every column, and it is the only convention cv2 cannot infer for you: warpAffine
and warpPerspective happily filter whatever four planes you hand them, so the
premultiply on the way in and the divide on the way out are this module's job.
Get it wrong in one direction and every edge grows a black halo; get it wrong in
the other and a half-transparent picture comes back at half brightness. There is
a test for each of those failures, because both have shipped in this codebase.

Three groups, and they sit in three different places in the pipeline:

  * SHAPES (spec 6, pipeline stage 8) - rect, ellipse, line, polygon, arrow,
    with fill and/or stroke. Drawn on top of the image, antialiased, honouring
    the selection mask stage 4 resolved.
  * CANVAS (spec 7, pipeline stage 1) - canvasSize and trim. These change the
    FRAME, not the content, which is why they run before everything else: a
    crop rectangle or a selection written against the old frame would land in
    the wrong place otherwise.
  * GEOMETRY (spec 7, pipeline stage 3) - flips, arbitrary rotation, a free
    transform to a destination quad, and content-aware resizing. Also
    frame-changing, so also before the selection is resolved. None of the three
    canvas/geometry ops takes a mask; a mask in pre-geometry coordinates is
    meaningless by the time the op has finished.

RASTERISATION. One scanline rasteriser draws every shape. Horizontal coverage
is ANALYTIC - a span from x=3.2 to x=5.7 deposits exactly 0.8, 1.0, 0.7 - and
only the vertical axis is supersampled, SAMPLES sub-scanlines per output row.
Nothing iterates in Python: the crossings of every edge with every sub-scanline
are built as one array, sorted once, and turned into spans by a cumulative
winding sum, and the spans are deposited with two bincounts and one cumsum.
That is why a 2048-wide shape costs about as much as a 200-wide one plus the
cost of the pixels it actually covers.

Rectangles and ellipses do not go through the polygon path at all. Both have a
closed-form span at any y, so they are rasterised from the equation rather than
from a flattened approximation of it - an ellipse's area then lands on pi*a*b
to a part in ten thousand instead of the half-percent a 0.25px-flattened
polygon loses by being inscribed. A rectangle's stroke is the difference of two
such shapes and is exact as well. An ellipse's is NOT, and the reason is worth
knowing: the offset curve of an ellipse is not an ellipse, so growing the
semi-axes gets the ring's area exactly right while drawing a stroke that
measures 8.0px where 10.0 was asked for. That one is offset along the real
normal instead.

WHAT IS NOT HERE, deliberately: miter joins on ROUND-jointed curves (a polyline
stroke offers miter/round/bevel and defaults to miter; an ellipse stroke has no
corners to join), gradient paints, and dashes. Those belong to the compositor's
shape layers (server/vfx/shapes.py), which is a different job with a different
document.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgshape.py catalog
    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgshape.py bench

numpy / cv2, and imagetools._blend - the one blend implementation, the same
arithmetic the compositor and the VFX effects use.
"""
# -- WIRING - what server/imagetools.py has to do, and it is all of it --------
#
#   1. With the other imports:
#
#          import imgshape
#
#   2. Stage 1 of the pipeline, before `crop`:
#
#          if ops.get("canvas"):
#              arr = imgshape.apply_canvas(arr, ops["canvas"], notes)
#
#   3. Stage 3, after `crop` and before the selection is resolved:
#
#          if ops.get("geometry"):
#              arr = imgshape.apply_geometry(arr, ops["geometry"], notes)
#
#      `ops["geometry"]["rotate"]` REPLACES the old top-level `ops["rotate"]`,
#      which only ever accepted 0/90/180/270. Keep accepting the old key and
#      forward it here; the multiples of 90 still take the transpose path and
#      are still bit-exact.
#
#   4. Stage 8, after strokes and before text:
#
#          if ops.get("shapes"):
#              arr = imgshape.apply_shapes(arr, ops["shapes"], mask)
#
#      `mask` is the stage-4 selection, float32 (H, W) 0..1, or None.
#
#   5. `notes` is a list this module appends one-line strings to - the honest
#      report of a smartResize that had to batch its seam search or hand part
#      of the job to a plain resize. Put it in the JSON result. Pass None and
#      the same lines go to stderr instead, which is what the CLI does.
#
#   6. server/index.js and server/mcp.js: serve `imgshape.catalog()` beside the
#      effect catalog, from `python server/imgshape.py catalog`. Every
#      parameter of every op is in there with its type, range and default, so
#      the MCP schema and the UI panels are generated rather than typed.
#
#   7. A shape with neither fill nor stroke RAISES (spec 6: "an error, not a
#      no-op"). That is the one thing here that throws on purpose; let it reach
#      the caller as `{ ok: false, error }`.
# ---------------------------------------------------------------------------
import json
import math
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imagetools import BLEND_MODES, _blend as _blend_rgb    # noqa: E402


SAMPLES = 16              # vertical sub-scanlines per output row
_EPS = np.float32(1e-6)
_MAX_CROSSINGS = 40_000_000       # a runaway polygon must not eat the box
_MAX_PIXELS = 64_000_000          # nor a rotation that expands into next week

ANCHORS = ["topleft", "top", "topright", "left", "center", "right",
           "bottomleft", "bottom", "bottomright"]
INTERPOLATIONS = ["nearest", "bilinear", "bicubic", "lanczos"]
_CV_INTERP = {"nearest": cv2.INTER_NEAREST, "bilinear": cv2.INTER_LINEAR,
              "bicubic": cv2.INTER_CUBIC, "lanczos": cv2.INTER_LANCZOS4}
LINE_CAPS = ["butt", "round", "square"]
LINE_JOINS = ["miter", "round", "bevel"]
FILL_RULES = ["nonzero", "evenodd"]


class ShapeError(ValueError):
    """A request that cannot be drawn as asked. Raised, never swallowed - the
    spec is explicit that a shape with no paint is an error, and an agent that
    gets a silent no-op back has no way to learn what it did wrong."""


# ---------------------------------------------------------------------------
# the catalog - MCP and the UI are both generated from this
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Shape", "Canvas", "Geometry"]

# An image has no timeline, so nothing here is `animatable`; that flag is the
# one field effects.py carries which would be a lie in this column.


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


def col(desc, default=None):
    """Colours are 0-255 RGBA, everywhere, in every column of this codebase. A
    0-1 triple is a legal near-black colour and will draw perfectly, which is
    why it has cost this codebase a feature more than once. `null` means the
    paint is absent, which is not the same as an alpha of 0."""
    return {"type": "color", "default": default, "min": 0, "max": 255,
            "optional": default is None, "desc": desc}


def pointlist(desc, minimum=2):
    return {"type": "points", "default": [], "min": -1e6, "max": 1e6,
            "minPoints": minimum, "desc": desc}


def op(name, label, group, why, params, stage, **extra):
    entry = {"label": label, "group": group, "why": why, "stage": stage,
             "params": params}
    entry.update(extra)
    CATALOG[name] = entry
    return entry


_BLEND = pick(BLEND_MODES, "normal", "how the shape's colour meets the pixels under it")
_STROKE_W = num(2, 0, 4000, "stroke width in pixels, centred on the path", unit="px")

# ---- shapes (stage 8) -----------------------------------------------------

op("rect", "Rectangle", "Shape",
   "An axis-aligned rectangle from two opposite corners, optionally rounded. "
   "Rasterised from its equation rather than from a polygon, so an integer-"
   "aligned edge has no partial pixel on it at all and a rounded corner is a "
   "real arc.",
   {"points": pointlist("[[x0,y0],[x1,y1]] - two opposite corners, in image "
                        "pixels. x=30 is the LEFT EDGE of column 30, so a "
                        "40x20 rect at [[30,20],[70,40]] covers exactly 800 "
                        "whole pixels. `x`/`y`/`w`/`h` are accepted instead."),
    "radius": num(0, 0, 4000, "corner radius in px; clamped at half the shorter side",
                  unit="px"),
    "fill": col("interior colour, RGBA 0-255"),
    "stroke": col("outline colour, RGBA 0-255"),
    "strokeWidth": _STROKE_W,
    "blend": _BLEND}, stage=8)

op("ellipse", "Ellipse", "Shape",
   "An axis-aligned ellipse inscribed in the box the two points describe. "
   "Analytic, so its area is pi*a*b and not the slightly smaller area of the "
   "polygon that approximates it.",
   {"points": pointlist("[[x0,y0],[x1,y1]] - the bounding box. `cx`/`cy`/`rx`/`ry` "
                        "are accepted instead."),
    "fill": col("interior colour, RGBA 0-255"),
    "stroke": col("outline colour, RGBA 0-255"),
    "strokeWidth": _STROKE_W,
    "blend": _BLEND}, stage=8)

op("line", "Line", "Shape",
   "A straight segment, or a polyline if you give it more than two points. A "
   "line has no interior: its paint is `stroke`, and a line with only a fill "
   "is an error rather than an invisible success.",
   {"points": pointlist("[[x0,y0],[x1,y1],...] - two or more, in image pixels"),
    "stroke": col("line colour, RGBA 0-255"),
    "strokeWidth": _STROKE_W,
    "cap": pick(LINE_CAPS, "butt", "how the two open ends finish"),
    "join": pick(LINE_JOINS, "miter", "how two segments meet"),
    "miterLimit": num(4, 1, 100, "a miter longer than this many line widths bevels instead"),
    "blend": _BLEND}, stage=8)

op("polygon", "Polygon", "Shape",
   "A closed polygon through the given points. Self-intersecting is fine and "
   "the fill rule decides what that means: nonzero fills anything wound "
   "around, evenodd punches the hole a five-pointed star is drawn with.",
   {"points": pointlist("[[x,y],...] - three or more; the last joins back to the first",
                        minimum=3),
    "fill": col("interior colour, RGBA 0-255"),
    "stroke": col("outline colour, RGBA 0-255"),
    "strokeWidth": _STROKE_W,
    "fillRule": pick(FILL_RULES, "nonzero", "how a self-intersecting outline is filled"),
    "join": pick(LINE_JOINS, "miter", "how the stroke turns a corner"),
    "miterLimit": num(4, 1, 100, "a miter longer than this many line widths bevels instead"),
    "blend": _BLEND}, stage=8)

op("arrow", "Arrow", "Shape",
   "A line with a solid head on its last point. Like `line` it is painted by "
   "`stroke` - head included, so the whole arrow is one colour and one alpha "
   "with no seam where the head meets the shaft.",
   {"points": pointlist("[[x0,y0],...,[xn,yn]] - tail first, TIP LAST"),
    "stroke": col("arrow colour, RGBA 0-255"),
    "strokeWidth": _STROKE_W,
    "headLength": num(0, 0, 4000, "head length in px; 0 derives 3x the stroke width",
                      unit="px"),
    "headWidth": num(0, 0, 4000, "head width in px; 0 derives 2.5x the stroke width",
                     unit="px"),
    "join": pick(LINE_JOINS, "miter", "how two shaft segments meet"),
    "miterLimit": num(4, 1, 100, "a miter longer than this many line widths bevels instead"),
    "blend": _BLEND}, stage=8)

SHAPE_KINDS = ["rect", "ellipse", "line", "polygon", "arrow"]

# An agent will guess these, and a guess that works is a round trip saved.
ALIASES = {"rectangle": "rect", "square": "rect", "roundedRect": "rect",
           "circle": "ellipse", "oval": "ellipse", "ellipsis": "ellipse",
           "segment": "line", "polyline": "line", "path": "line",
           "poly": "polygon", "triangle": "polygon"}

# ---- canvas (stage 1) -----------------------------------------------------

op("canvasSize", "Canvas Size", "Canvas",
   "Resize the FRAME without touching the content. The original pixels are "
   "COPIED, never resampled, to the place the anchor names, and whatever is "
   "left over is filled with the background. This is not 'resize the image' "
   "and the difference is the entire point: 'resize' rescales what is there, "
   "this one gives it more room or takes some away.",
   {"width": num(1920, 1, 30000, "the new frame width in px", integer=True, unit="px"),
    "height": num(1080, 1, 30000, "the new frame height in px", integer=True, unit="px"),
    "anchor": pick(ANCHORS, "center", "where the original sits in the new frame"),
    "background": col("what fills the new area, RGBA 0-255; null is transparent")},
   stage=1)

op("trim", "Trim", "Canvas",
   "Crop away a uniform border. `transparent` cuts rows and columns whose "
   "alpha is zero; `borders` reads the border colour off the four corners and "
   "cuts every row and column that is entirely that colour. A row with one "
   "off-colour pixel in it is content and survives, which is the whole "
   "difference between a trim and a guess.",
   {"trim": pick(["none", "transparent", "borders"], "none", "which border to detect"),
    "tolerance": num(0, 0, 255, "how far off the border colour a pixel may be and "
                                "still count as border, per channel, 0-255")},
   stage=1)

# ---- geometry (stage 3) ---------------------------------------------------

op("flip", "Flip", "Geometry",
   "Mirror the frame. Exact - it moves pixels and resamples nothing.",
   {"flipH": flag(False, "mirror left to right"),
    "flipV": flag(False, "mirror top to bottom")}, stage=3)

op("rotate", "Rotate", "Geometry",
   "Rotate by ANY angle, clockwise, with an antialiased edge. Multiples of 90 "
   "take a transpose instead of a resample and are bit-exact. `expand` grows "
   "the frame to hold the whole rotated picture; without it the frame is kept "
   "and the corners are clipped.",
   {"rotate": num(0, -36000, 36000, "degrees CLOCKWISE - the sign the Images screen "
                                    "and PIL's rotate(-a) already use", unit="deg"),
    "expand": flag(True, "grow the frame to fit; off keeps the frame and clips"),
    "interpolation": pick(INTERPOLATIONS, "bicubic",
                          "bicubic is sharp and can ring slightly; bilinear is "
                          "soft and never overshoots")}, stage=3)

op("perspective", "Perspective", "Geometry",
   "Free transform: say where the four corners of the image should end up and "
   "the projective warp that puts them there is the one applied. Points are "
   "the DESTINATION quad in image pixels, clockwise from the top-left corner. "
   "A degenerate quad - three points on a line, two points the same - has no "
   "such warp and is refused rather than approximated.",
   {"perspective": pointlist("[[x,y] x4] - where TL, TR, BR, BL land, in px", minimum=4),
    "fit": flag(False, "resize the frame to the quad's bounding box; off keeps "
                       "the frame and clips"),
    "interpolation": pick(INTERPOLATIONS, "bicubic", "as rotate")}, stage=3)

op("smartResize", "Smart Resize", "Geometry",
   "Content-aware resize - seam carving. Removes (or duplicates) the "
   "lowest-energy connected paths of pixels, so a busy subject keeps its "
   "proportions while flat sky and wall are taken up instead. It is EXPENSIVE: "
   "one dynamic-programming pass over the whole image per seam is the honest "
   "implementation and it is not interactive past about a megapixel, so "
   "`seamsPerPass` trades a little quality for a lot of speed by taking "
   "several non-crossing seams from one pass. Every compromise it makes is "
   "reported, including the one case it will not do quietly: past `maxCarve` "
   "of a dimension there are no cheap seams left and the remainder is a plain "
   "resize.",
   {"width": num(0, 0, 30000, "target width in px; 0 keeps it", integer=True, unit="px"),
    "height": num(0, 0, 30000, "target height in px; 0 keeps it", integer=True, unit="px"),
    "seamsPerPass": num(0, 0, 64, "seams taken from one energy pass; 0 picks a "
                                  "number that keeps the whole call near a second",
                        integer=True),
    "maxCarve": num(0.5, 0.05, 1.0, "the most of a dimension seam carving may "
                                    "account for; the rest is a plain resize")},
   stage=3)


def catalog():
    """What MCP and /api/image/catalog serve."""
    return {
        "ops": CATALOG,
        "groups": GROUP_ORDER,
        "names": sorted(CATALOG),
        "shapes": SHAPE_KINDS,
        "aliases": ALIASES,
        "notes": [
            "Colours are RGBA 0-255. A three-element colour gets alpha 255.",
            "Coordinates are image pixels with (0,0) at the top-left CORNER of "
            "the top-left pixel, so pixel j spans [j, j+1).",
            "Shape entries are the `kind` of one element of ops.shapes (stage 8). "
            "canvasSize and trim are fields of ops.canvas (stage 1); flip, "
            "rotate, perspective and smartResize are fields of ops.geometry "
            "(stage 3).",
            "Geometry runs flip, then rotate, then perspective, then "
            "smartResize - a perspective quad is therefore in the coordinates "
            "of the already-rotated frame.",
            "ops.canvas trims BEFORE it resizes the frame; the other order "
            "would trim away the background it had just added.",
            "A shape with neither fill nor stroke raises. So does a line or an "
            "arrow with no stroke.",
            "`radius` is a rect field only - a polygon's corners are not "
            "rounded, and sending radius to anything but a rect is reported "
            "rather than quietly accepted.",
            "Stroke joins are miter (with a limit), round or bevel; caps are "
            "butt, round or square. Dashes and gradient paints are not here - "
            "those live in the compositor's shape layers.",
        ],
    }


# ---------------------------------------------------------------------------
# shared plumbing
# ---------------------------------------------------------------------------

def _note(msg, notes=None):
    """One honest line about a compromise. The caller that passes a list gets
    it in the job result; everyone else gets it on stderr, because the failure
    this module must never have is the quiet one."""
    if notes is None:
        print(f"[imgshape] {msg}", file=sys.stderr)
    else:
        notes.append(msg)


def _valid(rgba):
    return (isinstance(rgba, np.ndarray) and rgba.ndim == 3 and rgba.shape[2] == 4
            and np.issubdtype(rgba.dtype, np.floating))


def _arr(rgba):
    """float32 (H, W, 4), contiguous. May BE the caller's buffer when it is
    already both - which is fine for the ops that build a new frame and never
    fine for the ones that draw, so those use _own."""
    return np.ascontiguousarray(rgba, dtype=np.float32)


def _own(rgba):
    """A copy nothing else holds a reference to. ascontiguousarray on an array
    that is already contiguous float32 hands the SAME array back, so a shape
    drawn through _arr writes into the caller's picture - which is how an undo
    stack quietly stops working."""
    return np.array(rgba, dtype=np.float32, copy=True, order="C")


def _f(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float(default)
    return f if math.isfinite(f) else float(default)


def _color(v, notes=None, where=""):
    """RGBA 0..1 from an RGB(A) 0-255 list, or None for 'no paint'."""
    if v is None:
        return None
    if isinstance(v, (str, bytes)):
        # list("red") is ['r','e','d'], which coerces to a perfectly drawable
        # black. Named colours are not a thing here; say so instead.
        _note(f"{where}colour {v!r} is a string; colours are RGBA 0-255 lists", notes)
        return None
    try:
        chan = [_f(c, 0.0) for c in list(v)[:4]]
    except TypeError:
        _note(f"{where}colour {v!r} is not a list; treating it as absent", notes)
        return None
    if len(chan) < 3:
        _note(f"{where}colour {v!r} has fewer than three channels; absent", notes)
        return None
    if len(chan) == 3:
        chan.append(255.0)
    return np.clip(np.asarray(chan, np.float32) / 255.0, 0.0, 1.0)


def _points(v, notes=None, where=""):
    """(N, 2) float64. Accepts [[x,y],...] and the flat [x0,y0,x1,y1,...] form.
    A point with a NaN or an infinity in it is DROPPED and said so - it has no
    position, and inventing one for it is how a stray coordinate turns into a
    shape nobody asked for."""
    if v is None:
        return np.zeros((0, 2), np.float64)
    seq = list(v) if isinstance(v, (list, tuple, np.ndarray)) else []
    if seq and all(isinstance(p, (int, float, np.floating, np.integer)) for p in seq):
        seq = [seq[i:i + 2] for i in range(0, len(seq) - 1, 2)]
    out, dropped = [], 0
    for p in seq:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            dropped += 1
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            dropped += 1
            continue
        out.append((x, y))
    if dropped:
        _note(f"{where}dropped {dropped} point(s) that were not finite numbers", notes)
    return np.asarray(out, np.float64).reshape(-1, 2)


def _coerce(spec, src, where="", notes=None):
    """Every value a body below sees has been through here: unknown keys are
    reported rather than silently dropped (spec 9: rebuilding an object from a
    key list has cost this codebase five features), missing ones take the
    catalog default, and everything else is clamped to the advertised range."""
    src = src if isinstance(src, dict) else {}
    extra = sorted(set(src) - set(spec) - {"kind", "type"})
    if extra:
        _note(f"{where}ignoring parameter(s) not in the catalog: {', '.join(extra)}", notes)
    out = {}
    for key, p in spec.items():
        present = key in src
        v = src.get(key, p["default"])
        kind = p["type"]
        if kind == "number":
            v = _f(v, p["default"])
            v = min(max(v, float(p["min"])), float(p["max"]))
            if p.get("integer"):
                v = int(round(v))
        elif kind == "bool":
            v = bool(v)
        elif kind == "enum":
            if v is None:
                v = p["default"]        # null is how JSON spells "not set"
            elif v not in p["options"]:
                if present:
                    _note(f"{where}{key}={v!r} is not one of {p['options']}; "
                          f"using {p['default']!r}", notes)
                v = p["default"]
        elif kind == "color":
            v = _color(v, notes, f"{where}{key}: ")
        elif kind == "points":
            v = _points(v, notes, f"{where}{key}: ")
        out[key] = v
    return out


def _premul(rgba):
    out = np.array(rgba, dtype=np.float32, copy=True)
    out[..., :3] *= out[..., 3:4]
    return out


def _unpremul(pm):
    """Straight alpha back out. The clamp on the divisor is what keeps a pixel
    whose alpha rounded to 1e-9 from exploding into whatever colour the ratio
    of two denormals happens to be; below that alpha the colour is not carrying
    any information anyway."""
    a = np.clip(pm[..., 3], 0.0, 1.0)
    out = np.empty(pm.shape, np.float32)
    out[..., :3] = np.clip(pm[..., :3] / np.maximum(a, _EPS)[..., None], 0.0, 1.0)
    out[..., 3] = a
    np.copyto(out, 0.0, where=np.isnan(out))
    return out


# ---------------------------------------------------------------------------
# the rasteriser
# ---------------------------------------------------------------------------
#
# Every shape becomes a set of horizontal spans, one or more per SUB-SCANLINE.
# Sub-scanline n samples y = (n + 0.5) / SAMPLES, so row r is the average of
# sub-scanlines r*SAMPLES .. r*SAMPLES+SAMPLES-1. Two producers make spans:
# _poly_spans, which crosses a pile of closed contours against every
# sub-scanline at once, and the analytic pair below it, which solve the rect
# and the ellipse directly. Both hand the same three arrays to _deposit.


def _deposit(sub, xa, xb, rx, ry, rw, rh, samples):
    """Analytic horizontal coverage for a pile of spans, all at once.

    The whole-pixel middle of every span goes into a difference array that is
    cumsum'd once at the end; only the two fractional ends need a scattered
    add. Two bincounts and a cumsum for any number of spans, which is why a
    shape's cost is its area and not its complexity.

    The arithmetic is exact in float64 and stays exact when it lands in
    float32: every value deposited is a multiple of 1/samples plus at most two
    fractions, and the running winding sum never leaves [0, 1]."""
    out = np.zeros((rh, rw), np.float32)
    if sub.size == 0:
        return out
    rows = (sub // samples) - ry
    xa = np.clip(np.asarray(xa, np.float64) - rx, 0.0, float(rw))
    xb = np.clip(np.asarray(xb, np.float64) - rx, 0.0, float(rw))
    keep = (xb > xa) & (rows >= 0) & (rows < rh)
    if not keep.any():
        return out
    rows, xa, xb = rows[keep].astype(np.int64), xa[keep], xb[keep]

    w2 = rw + 2
    weight = 1.0 / samples
    ia = np.floor(xa).astype(np.int64)
    ib = np.floor(xb).astype(np.int64)
    np.clip(ia, 0, rw - 1, out=ia)
    np.clip(ib, 0, rw, out=ib)
    same = ia == ib
    base = rows * w2

    idx = [base[same] + ia[same]]
    val = [(xb[same] - xa[same]) * weight]
    o = ~same
    if o.any():
        idx.append(base[o] + ia[o])
        val.append((ia[o] + 1.0 - xa[o]) * weight)
        idx.append(base[o] + ib[o])
        val.append((xb[o] - ib[o]) * weight)
    flat = np.concatenate(idx)
    vals = np.concatenate(val)
    cov = np.bincount(flat, weights=vals, minlength=rh * w2)[:rh * w2].reshape(rh, w2)
    if o.any():
        # +1 where the solid middle starts, -1 where it ends; one cumsum fills in
        # every whole pixel between them without ever touching them individually.
        dflat = np.concatenate([base[o] + ia[o] + 1, base[o] + ib[o]])
        dvals = np.concatenate([np.full(int(o.sum()), weight),
                                np.full(int(o.sum()), -weight)])
        diff = np.bincount(dflat, weights=dvals,
                           minlength=rh * w2)[:rh * w2].reshape(rh, w2)
        cov += np.cumsum(diff, axis=1)
    return np.clip(cov[:, :rw], 0.0, 1.0).astype(np.float32)


def _poly_spans(contours, sub_lo, sub_hi, samples, rule="nonzero", notes=None):
    """Crossings of every edge with every sub-scanline, sorted once, turned
    into spans by a cumulative winding sum.

    The cumsum needs no per-scanline reset: every contour is closed, so the
    directions within one sub-scanline sum to zero and the running total is
    back at zero by the time the next one starts."""
    x0s, y0s, x1s, y1s = [], [], [], []
    for c in contours:
        if len(c) < 2:
            continue
        a = np.asarray(c, np.float64)
        b = np.roll(a, -1, axis=0)
        x0s.append(a[:, 0]); y0s.append(a[:, 1])
        x1s.append(b[:, 0]); y1s.append(b[:, 1])
    if not x0s:
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)
    x0 = np.concatenate(x0s); y0 = np.concatenate(y0s)
    x1 = np.concatenate(x1s); y1 = np.concatenate(y1s)

    dy = y1 - y0
    live = dy != 0.0                       # a horizontal edge crosses nothing
    if not live.any():
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)
    x0, y0, x1, y1, dy = x0[live], y0[live], x1[live], y1[live], dy[live]
    slope = (x1 - x0) / dy
    direction = np.where(dy > 0, 1, -1).astype(np.int32)

    ylo = np.minimum(y0, y1)
    yhi = np.maximum(y0, y1)
    # y(n) >= ylo and y(n) < yhi, with y(n) = (n + 0.5)/samples. Half-open at
    # the top so a vertex shared by two edges is crossed exactly once.
    nlo = np.ceil(ylo * samples - 0.5)
    nhi = np.ceil(yhi * samples - 0.5) - 1
    nlo = np.maximum(nlo, sub_lo).astype(np.int64)
    nhi = np.minimum(nhi, sub_hi - 1).astype(np.int64)
    cnt = np.maximum(nhi - nlo + 1, 0)
    total = int(cnt.sum())
    if total <= 0:
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)
    if total > _MAX_CROSSINGS:
        _note(f"shape needs {total} scanline crossings, over the {_MAX_CROSSINGS} "
              f"cap; skipped", notes)
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)

    idx = np.repeat(np.arange(cnt.size), cnt)
    starts = np.concatenate(([0], np.cumsum(cnt)[:-1]))
    n = nlo[idx] + (np.arange(total) - np.repeat(starts, cnt))
    y = (n + 0.5) / samples
    x = x0[idx] + (y - y0[idx]) * slope[idx]
    d = direction[idx]

    order = np.lexsort((x, n))
    n, x, d = n[order], x[order], d[order]
    wind = np.cumsum(d)
    inside = (wind != 0) if rule == "nonzero" else ((wind & 1) != 0)
    sel = inside[:-1] & (n[:-1] == n[1:])
    return n[:-1][sel], x[:-1][sel], x[1:][sel]


def _sub_range(y_lo, y_hi, samples, rh_lo, rh_hi):
    lo = max(int(math.floor(y_lo * samples)), rh_lo * samples)
    hi = min(int(math.ceil(y_hi * samples)) + 1, rh_hi * samples)
    return lo, hi


def _rrect_edges(y, x0, y0, x1, y1, r):
    """The left and right edge of a rounded rectangle at each y in `y`.
    Exact: inside the straight band it is the box, and in a corner band it is
    the circle, solved rather than approximated."""
    inside = (y >= y0) & (y < y1)
    d = np.minimum(y - y0, y1 - y)
    dy = np.maximum(r - d, 0.0)
    dx = r - np.sqrt(np.maximum(r * r - dy * dy, 0.0))
    dx = np.where(d >= r, 0.0, dx)
    return x0 + dx, x1 - dx, inside & (x1 - dx > x0 + dx)


def _ellipse_edges(y, cx, cy, rx, ry):
    if rx <= 0 or ry <= 0:
        z = np.zeros(y.shape, np.float64)
        return z, z, np.zeros(y.shape, bool)
    t = (y - cy) / ry
    ok = np.abs(t) < 1.0
    dx = rx * np.sqrt(np.maximum(1.0 - t * t, 0.0))
    return cx - dx, cx + dx, ok


def _ring_spans(outer, inner, sub_lo, sub_hi, samples):
    """Two edge functions in, one or two spans per sub-scanline out. `inner`
    is what makes a rectangle's stroke a stroke: the difference of the rect
    grown by half the line width and the same rect shrunk by it, which is an
    exact offset for a box and for a rounded box, and is why a rect's outline
    measures its own width to the last decimal. An ellipse cannot use this -
    see _ellipse_ring_contours."""
    n = np.arange(sub_lo, sub_hi, dtype=np.int64)
    if n.size == 0:
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)
    y = (n + 0.5) / samples
    oa, ob, ook = outer(y)
    if inner is None:
        return n[ook], oa[ook], ob[ook]
    ia, ib, iok = inner(y)
    both = ook & iok
    only = ook & ~iok
    return (np.concatenate([n[only], n[both], n[both]]),
            np.concatenate([oa[only], oa[both], ib[both]]),
            np.concatenate([ob[only], ia[both], ob[both]]))


# ---------------------------------------------------------------------------
# contour builders - the polygon side
# ---------------------------------------------------------------------------

def _orient(poly):
    """Same winding for everything, so overlapping contours UNION under the
    nonzero rule instead of punching holes in each other. That union is how a
    stroke's segments, joins and caps become one antialiased outline with no
    seam where two of them meet - taking the max of separately rasterised
    pieces would leave a visible crease down every join."""
    a = np.asarray(poly, np.float64)
    b = np.roll(a, -1, axis=0)
    area = float((a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]).sum())
    return a[::-1].copy() if area < 0 else a


def _disc(cx, cy, r, tol=0.05):
    """A circle flattened to `tol` px of chord error - fine enough that a round
    cap measures round rather than measuring like a 12-gon."""
    r = max(float(r), 1e-9)
    steps = max(8, int(math.ceil(math.pi / math.acos(max(-1.0, min(1.0, 1.0 - tol / r))))))
    steps = min(steps, 512)
    # The n-gon is grown until its AREA is the circle's, instead of being left
    # inscribed. An inscribed 23-gon is short by 1.2%, which on a round cap of
    # width 10 is a whole pixel of missing ink - small, invisible, and exactly
    # the kind of quiet bias that makes a measured test disagree with paper.
    r *= math.sqrt(2.0 * math.pi / (steps * math.sin(2.0 * math.pi / steps)))
    th = np.linspace(0.0, 2.0 * math.pi, steps, endpoint=False)
    return np.stack([cx + r * np.cos(th), cy + r * np.sin(th)], axis=1)


def _ellipse_ring_contours(cx, cy, rx, ry, hw, tol=0.02):
    """A constant-width band around an ellipse, as an outer contour and an
    inner one wound the other way.

    The tempting shortcut - grow both semi-axes by half the line width and
    subtract the shrunk one - is WRONG for anything but a circle: the offset
    curve of an ellipse is not an ellipse. On a 4:1 ellipse that shortcut
    draws a stroke that measures 8.0px where it was asked for 10.0, thinnest
    at the flat ends. The area comes out exactly right, which is precisely why
    a test that only counted ink would have blessed it. So the offset is taken
    along the real normal instead, and only the flattening is approximate."""
    r = max(float(rx), float(ry))
    steps = max(24, int(math.ceil(math.pi / math.acos(max(-1.0, 1.0 - tol / max(r, 1e-9))))))
    steps = min(steps, 4096)
    t = np.linspace(0.0, 2.0 * math.pi, steps, endpoint=False)
    ct, st = np.cos(t), np.sin(t)
    px, py = cx + rx * ct, cy + ry * st
    nx, ny = ry * ct, rx * st                  # the ellipse's own normal direction
    n = np.hypot(nx, ny)
    n[n < 1e-12] = 1.0
    nx, ny = nx / n, ny / n
    outer = _orient(np.stack([px + hw * nx, py + hw * ny], axis=1))
    if hw >= min(float(rx), float(ry)):
        return [outer]                         # the stroke has swallowed the interior
    inner = _orient(np.stack([px - hw * nx, py - hw * ny], axis=1))
    return [outer, inner[::-1].copy()]         # opposite winding punches the hole


def _stroke_contours(pts, width, closed, cap="butt", join="miter", miter_limit=4.0):
    """A polyline's outline as a pile of overlapping, consistently wound
    contours: one quad per segment, one wedge per corner, one cap per open end.
    Nonzero winding does the union."""
    hw = float(width) / 2.0
    if hw <= 0 or len(pts) < 2:
        return []
    p = np.asarray(pts, np.float64)
    if closed and len(p) > 2 and np.allclose(p[0], p[-1]):
        p = p[:-1]
    seg = (np.roll(p, -1, axis=0) - p) if closed else (p[1:] - p[:-1])
    starts = p if closed else p[:-1]
    length = np.hypot(seg[:, 0], seg[:, 1])
    live = length > 1e-12
    if not live.any():
        # Every point in the same place. A round or square cap still has an
        # honest answer - a dot - and butt has none.
        if cap == "round":
            return [_orient(_disc(p[0, 0], p[0, 1], hw))]
        if cap == "square":
            return [_orient(np.array([[p[0, 0] - hw, p[0, 1] - hw], [p[0, 0] + hw, p[0, 1] - hw],
                                      [p[0, 0] + hw, p[0, 1] + hw], [p[0, 0] - hw, p[0, 1] + hw]]))]
        return []
    seg, starts, length = seg[live], starts[live], length[live]
    d = seg / length[:, None]
    nrm = np.stack([-d[:, 1], d[:, 0]], axis=1)          # left normal, screen axes
    ends = starts + seg

    out = []
    ext = hw if cap == "square" and not closed else 0.0
    for i in range(len(seg)):
        a, b, nv, dv = starts[i], ends[i], nrm[i] * hw, d[i]
        e0 = dv * (ext if (not closed and i == 0) else 0.0)
        e1 = dv * (ext if (not closed and i == len(seg) - 1) else 0.0)
        out.append(_orient(np.array([a - e0 + nv, b + e1 + nv, b + e1 - nv, a - e0 - nv])))

    joints = range(len(seg)) if closed else range(len(seg) - 1)
    for i in joints:
        j = (i + 1) % len(seg)
        pt = ends[i]
        if join == "round":
            out.append(_orient(_disc(pt[0], pt[1], hw)))
            continue
        cross = float(d[i, 0] * d[j, 1] - d[i, 1] * d[j, 0])
        if abs(cross) < 1e-12:
            continue                                      # straight through
        s = -1.0 if cross > 0 else 1.0                    # the outer side of the turn
        a = pt + s * hw * nrm[i]
        b = pt + s * hw * nrm[j]
        dot = float(nrm[i] @ nrm[j])
        wedge = [pt, a, b]
        if join == "miter" and dot > -1.0 + 1e-9:
            ratio = math.sqrt(2.0 / (1.0 + dot))
            if ratio <= float(miter_limit):
                m = nrm[i] + nrm[j]
                m = pt + s * hw * m / (1.0 + dot)
                wedge = [pt, a, m, b]
        out.append(_orient(np.array(wedge)))

    if cap == "round" and not closed:
        out.append(_orient(_disc(starts[0, 0], starts[0, 1], hw)))
        out.append(_orient(_disc(ends[-1, 0], ends[-1, 1], hw)))
    return out


def _arrow_contours(pts, width, head_len, head_w, join, miter_limit):
    p = np.asarray(pts, np.float64)
    d = p[-1] - p[-2]
    n = float(np.hypot(d[0], d[1]))
    body = _stroke_contours(p, width, False, "butt", join, miter_limit)
    if n <= 1e-12 or head_len <= 0 or head_w <= 0:
        return body
    d = d / n
    perp = np.array([-d[1], d[0]])
    tip = p[-1]
    base = tip - d * head_len
    head = np.array([tip, base + perp * (head_w / 2.0), base - perp * (head_w / 2.0)])
    return body + [_orient(head)]


# ---------------------------------------------------------------------------
# compositing
# ---------------------------------------------------------------------------

def _over(base, src_rgb, src_a, mode):
    """Source-over onto STRAIGHT alpha, with the blend mode weighted by the
    backdrop's own alpha the way the compositing spec says.

    This is not quite the arithmetic imagetools.composite() uses: that one
    assumes an opaque backdrop and reads `dst*(1-a) + blend*a`, which turns a
    50% red shape on an empty canvas into dark red at 50% instead of red at
    50%. Over opaque pixels the two agree exactly; over transparent ones this
    one is right and that one darkens."""
    ab = base[..., 3:4]
    cb = base[..., :3]
    ash = src_a[..., None]
    cs = src_rgb
    if mode != "normal":
        cs = (1.0 - ab) * cs + ab * np.clip(_blend_rgb(cb, cs, mode), 0.0, 1.0)
    ao = ash + ab * (1.0 - ash)
    co = (cs * ash + cb * ab * (1.0 - ash)) / np.maximum(ao, _EPS)
    out = np.empty(base.shape, np.float32)
    out[..., :3] = np.clip(co, 0.0, 1.0)
    out[..., 3:4] = np.clip(ao, 0.0, 1.0)
    return out


def _mask_lerp(base, drawn, m):
    """spec 3's `result * m + original * (1 - m)`, done PREMULTIPLIED.

    The literal reading of that line mixes straight colour, and mixing straight
    colour across an alpha difference drags the colour of the transparent side
    into the result: half-masking an opaque red shape onto an empty canvas
    gives 50% DARK red rather than 50% red, because black is what a
    transparent pixel's RGB happens to hold. Premultiplying first is the same
    formula on the only representation where the mix means anything."""
    if m is None:
        return drawn
    w = m[..., None]
    a = drawn[..., 3:4] * w + base[..., 3:4] * (1.0 - w)
    pm = (drawn[..., :3] * drawn[..., 3:4]) * w + (base[..., :3] * base[..., 3:4]) * (1.0 - w)
    out = np.empty(base.shape, np.float32)
    out[..., :3] = np.clip(pm / np.maximum(a, _EPS), 0.0, 1.0)
    out[..., 3:4] = np.clip(a, 0.0, 1.0)
    return out


def _as_mask(mask, h, w):
    """None means all ones. spec 3 asks for that to be implemented rather than
    branched, and it is - once, here, rather than in every op - because a real
    ones array is 16MB at 2048 square and every shape in the list would pay for
    it."""
    if mask is None:
        return None
    m = np.asarray(mask)
    if m.ndim == 3 and m.shape[2] == 1:
        m = m[..., 0]
    if m.ndim != 2 or m.shape != (h, w):
        raise ShapeError(f"selection mask is {getattr(m, 'shape', None)}, "
                         f"the image is ({h}, {w}) - stage 4 resolves the mask in "
                         f"post-geometry pixels, so these must match")
    return np.clip(np.nan_to_num(m.astype(np.float32), nan=0.0), 0.0, 1.0)


# ---------------------------------------------------------------------------
# shapes - spec 6, pipeline stage 8
# ---------------------------------------------------------------------------

def _paint(img, cov, rx, ry, color, blend, mask):
    """One coverage field, one colour, onto the image. Only the region the
    shape touches is read or written - and when that region is mostly empty,
    only the pixels the shape actually reaches.

    The sparse path matters more than it looks: a stroke's bounding box is the
    whole shape while its ink is a thin ring, so compositing the box costs
    twenty times what compositing the ring costs. Both paths run the same
    arithmetic on the same values - _over and _mask_lerp are written against a
    trailing axis of 4, so a (N, 4) gather is the same code as an (H, W, 4)
    block."""
    if cov.size == 0 or color is None:
        return img
    rh, rw = cov.shape
    region = img[ry:ry + rh, rx:rx + rw]
    sub = None if mask is None else mask[ry:ry + rh, rx:rx + rw]
    rgb = color[:3].astype(np.float32)
    hit = cov > 0.0
    n = int(np.count_nonzero(hit))
    if n == 0:
        return img
    if n * 3 < cov.size:
        base = region[hit]
        drawn = _over(base, np.broadcast_to(rgb, (n, 3)), cov[hit] * float(color[3]), blend)
        region[hit] = drawn if sub is None else _mask_lerp(base, drawn, sub[hit])
        return img
    drawn = _over(region, np.broadcast_to(rgb, (rh, rw, 3)), cov * float(color[3]), blend)
    img[ry:ry + rh, rx:rx + rw] = _mask_lerp(region, drawn, sub)
    return img


def _region(x_lo, x_hi, y_lo, y_hi, w, h):
    rx = max(0, int(math.floor(x_lo)) - 1)
    ry = max(0, int(math.floor(y_lo)) - 1)
    rx1 = min(w, int(math.ceil(x_hi)) + 1)
    ry1 = min(h, int(math.ceil(y_hi)) + 1)
    return rx, ry, max(0, rx1 - rx), max(0, ry1 - ry)


def _rect_points(p, src):
    """Two opposite corners, or the x/y/w/h vocabulary spec 3 uses for
    selections - an agent that has just written a selection will write a
    rectangle the same way, and refusing it teaches nothing."""
    if len(p) >= 2:
        return p
    if all(k in src for k in ("x", "y", "w", "h")):
        x, y = _f(src["x"]), _f(src["y"])
        return np.array([[x, y], [x + _f(src["w"]), y + _f(src["h"])]], np.float64)
    return p


def _ellipse_points(p, src):
    if len(p) >= 2:
        return p
    if all(k in src for k in ("cx", "cy", "rx", "ry")):
        cx, cy, rx, ry = (_f(src["cx"]), _f(src["cy"]), _f(src["rx"]), _f(src["ry"]))
        return np.array([[cx - rx, cy - ry], [cx + rx, cy + ry]], np.float64)
    return p


def draw_shape(rgba, shape, mask=None, notes=None):
    """One shape onto a COPY of the image. spec 6.

    Raises ShapeError when the request cannot be honoured as written - no
    paint, no usable geometry, an unknown kind. Everything numeric is coerced
    first: a NaN coordinate is dropped, a negative size is normalised, an
    out-of-range colour is clamped, and none of those raise.
    """
    if not _valid(rgba):
        raise ShapeError("shapes need float32 (H, W, 4) 0..1 RGBA")
    img = _own(rgba)
    return _draw(img, shape, _as_mask(mask, img.shape[0], img.shape[1]), notes)


def _draw(img, shape, m, notes):
    """The body of draw_shape, on an array that is already OURS and a mask
    that is already checked. Split out because apply_shapes draws ten shapes on
    one buffer and copying the image ten times to protect the caller from a
    buffer it never had is 670MB of memcpy at 2048 square."""
    src = shape if isinstance(shape, dict) else {}
    kind = str(src.get("kind") or src.get("type") or "").strip()
    kind = ALIASES.get(kind, kind)
    if kind not in SHAPE_KINDS:
        raise ShapeError(f"unknown shape kind {kind!r}; expected one of {SHAPE_KINDS}")

    where = f"{kind}: "
    p = _coerce(CATALOG[kind]["params"], src, where, notes)
    fill = p.get("fill")
    stroke = p.get("stroke")
    if fill is None and stroke is None:
        # spec 6, verbatim: "A shape with neither fill nor stroke is an error,
        # not a no-op."
        extra = "" if "fill" in CATALOG[kind]["params"] else \
            " (a line and an arrow have no interior; their paint is `stroke`)"
        raise ShapeError(f"{kind} has neither fill nor stroke{extra}")

    h, w = img.shape[:2]
    pts = p["points"]
    sw = float(p.get("strokeWidth", 0.0))
    if stroke is not None and sw <= 0:
        _note(f"{where}stroke width is 0, so the stroke draws nothing", notes)

    if kind in ("rect", "ellipse"):
        pts = _rect_points(pts, src) if kind == "rect" else _ellipse_points(pts, src)
        if len(pts) < 2:
            _note(f"{where}needs two corner points; nothing drawn", notes)
            return img
        x0, x1 = sorted((float(pts[0][0]), float(pts[1][0])))
        y0, y1 = sorted((float(pts[0][1]), float(pts[1][1])))
        hw = sw / 2.0 if stroke is not None else 0.0
        rx, ry, rw, rh = _region(x0 - hw - 1, x1 + hw + 1, y0 - hw - 1, y1 + hw + 1, w, h)
        if rw <= 0 or rh <= 0:
            return img
        lo, hi = _sub_range(y0 - hw, y1 + hw, SAMPLES, ry, ry + rh)
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        ax, by = (x1 - x0) / 2.0, (y1 - y0) / 2.0
        r = max(min(float(p.get("radius", 0.0)), ax, by), 0.0)
        if kind == "rect":
            def outer_f(y):
                return _rrect_edges(y, x0, y0, x1, y1, r)
        else:
            def outer_f(y):
                return _ellipse_edges(y, cx, cy, ax, by)

        if fill is not None:
            n, xa, xb = _ring_spans(outer_f, None, lo, hi, SAMPLES)
            _paint(img, _deposit(n, xa, xb, rx, ry, rw, rh, SAMPLES), rx, ry,
                   fill, p["blend"], m)
        if stroke is not None and sw > 0:
            if kind == "rect":
                # Offsetting a rounded rect outward gives radius r+hw - but a
                # SHARP corner offsets to a sharp corner, not to an arc of the
                # stroke's own half-width. Getting that wrong rounds every
                # rectangle's outline and loses (1-pi/4)*hw^2 of ink per corner,
                # which is small, plausible and completely visible.
                ro = (r + hw) if r > 0 else 0.0
                def grown(y):
                    return _rrect_edges(y, x0 - hw, y0 - hw, x1 + hw, y1 + hw, ro)
                def shrunk(y):
                    return _rrect_edges(y, x0 + hw, y0 + hw, x1 - hw, y1 - hw,
                                        max(r - hw, 0.0))
                n, xa, xb = _ring_spans(grown, shrunk, lo, hi, SAMPLES)
                cov = _deposit(n, xa, xb, rx, ry, rw, rh, SAMPLES)
            else:
                contours = _ellipse_ring_contours(cx, cy, ax, by, hw)
                n, xa, xb = _poly_spans(contours, lo, hi, SAMPLES, "nonzero", notes)
                cov = _deposit(n, xa, xb, rx, ry, rw, rh, SAMPLES)
            _paint(img, cov, rx, ry, stroke, p["blend"], m)
        return img

    # line / polygon / arrow: everything goes through the polygon rasteriser.
    need = CATALOG[kind]["params"]["points"]["minPoints"]
    if len(pts) < need:
        _note(f"{where}needs at least {need} points, got {len(pts)}; nothing drawn", notes)
        return img

    join = p.get("join", "miter")
    ml = float(p.get("miterLimit", 4.0))
    fills, strokes = [], []
    if kind == "polygon":
        if fill is not None:
            fills = [np.asarray(pts, np.float64)]
        if stroke is not None and sw > 0:
            strokes = _stroke_contours(pts, sw, True, "butt", join, ml)
    elif kind == "line":
        if stroke is not None and sw > 0:
            strokes = _stroke_contours(pts, sw, False, p["cap"], join, ml)
    else:
        hl = float(p["headLength"]) or 3.0 * sw
        hwd = float(p["headWidth"]) or 2.5 * sw
        if stroke is not None and sw > 0:
            strokes = _arrow_contours(pts, sw, hl, hwd, join, ml)

    for contours, color, rule in ((fills, fill, p.get("fillRule", "nonzero")),
                                  (strokes, stroke, "nonzero")):
        if not contours or color is None:
            continue
        allp = np.concatenate([np.asarray(c, np.float64) for c in contours])
        rx, ry, rw, rh = _region(allp[:, 0].min(), allp[:, 0].max(),
                                 allp[:, 1].min(), allp[:, 1].max(), w, h)
        if rw <= 0 or rh <= 0:
            continue
        lo, hi = _sub_range(allp[:, 1].min(), allp[:, 1].max(), SAMPLES, ry, ry + rh)
        n, xa, xb = _poly_spans(contours, lo, hi, SAMPLES, rule, notes)
        _paint(img, _deposit(n, xa, xb, rx, ry, rw, rh, SAMPLES), rx, ry,
               color, p["blend"], m)
    return img


def apply_shapes(rgba, shapes, mask=None, notes=None):
    """spec 2 stage 8: every shape in the list, in order, later ones on top."""
    if not _valid(rgba):
        return rgba
    img = _own(rgba)
    m = _as_mask(mask, img.shape[0], img.shape[1])
    for i, s in enumerate(shapes if isinstance(shapes, (list, tuple)) else []):
        try:
            _draw(img, s, m, notes)
        except ShapeError as exc:
            raise ShapeError(f"shapes[{i}]: {exc}") from None
    return img


# ---------------------------------------------------------------------------
# canvas - spec 7, pipeline stage 1
# ---------------------------------------------------------------------------

_ANCHOR_X = {"topleft": 0, "left": 0, "bottomleft": 0,
             "top": 1, "center": 1, "bottom": 1,
             "topright": 2, "right": 2, "bottomright": 2}
_ANCHOR_Y = {"topleft": 0, "top": 0, "topright": 0,
             "left": 1, "center": 1, "right": 1,
             "bottomleft": 2, "bottom": 2, "bottomright": 2}


def _anchor_offset(new, old, anchor, axis):
    """Where the old frame starts inside the new one. Negative means the new
    frame is smaller and the original is being clipped, which is the same
    arithmetic and needs no second case."""
    side = (_ANCHOR_X if axis == "x" else _ANCHOR_Y).get(anchor, 1)
    if side == 0:
        return 0
    if side == 2:
        return new - old
    return (new - old) // 2          # floor, so an odd remainder falls right/bottom


def canvas_size(rgba, width, height, anchor="center", background=None):
    """Resize the FRAME. The content is copied, never resampled - which is what
    makes this different from a resize, and the difference is the feature."""
    if not _valid(rgba):
        return rgba
    img = _arr(rgba)
    h, w = img.shape[:2]
    W = max(1, min(int(_f(width, w)), 30000))
    H = max(1, min(int(_f(height, h)), 30000))
    anchor = anchor if anchor in ANCHORS else "center"
    bg = background if isinstance(background, np.ndarray) else _color(background)
    out = np.zeros((H, W, 4), np.float32)
    if bg is not None:
        out[:] = bg
    ox = _anchor_offset(W, w, anchor, "x")
    oy = _anchor_offset(H, h, anchor, "y")
    sx0, sy0 = max(0, -ox), max(0, -oy)
    dx0, dy0 = max(0, ox), max(0, oy)
    cw = min(w - sx0, W - dx0)
    ch = min(h - sy0, H - dy0)
    if cw > 0 and ch > 0:
        out[dy0:dy0 + ch, dx0:dx0 + cw] = img[sy0:sy0 + ch, sx0:sx0 + cw]
    return out


def trim(rgba, mode="transparent", tolerance=0.0, notes=None):
    """Crop a uniform border away and not one row more.

    A row survives if ONE pixel in it is not border. That is the difference
    between a trim and a guess, and it is why this counts per-pixel rather than
    comparing row means."""
    if not _valid(rgba):
        return rgba
    img = _arr(rgba)
    h, w = img.shape[:2]
    mode = str(mode or "none")
    if mode not in ("transparent", "borders"):
        return img
    tol = max(0.0, min(_f(tolerance, 0.0), 255.0)) / 255.0
    if mode == "transparent":
        border = img[..., 3] <= tol
    else:
        corners = np.stack([img[0, 0], img[0, w - 1], img[h - 1, 0], img[h - 1, w - 1]])
        ref = corners[0]
        if float(np.abs(corners - ref).max()) > max(tol, 1e-6):
            _note("trim: the four corners are not the same colour; using the "
                  "top-left one as the border", notes)
        border = np.abs(img - ref).max(axis=2) <= tol
    keep_rows = ~border.all(axis=1)
    keep_cols = ~border.all(axis=0)
    if not keep_rows.any() or not keep_cols.any():
        _note("trim: the whole image is border; kept one pixel rather than "
              "returning an empty frame", notes)
        return img[:1, :1].copy()
    y0, y1 = int(np.argmax(keep_rows)), h - int(np.argmax(keep_rows[::-1]))
    x0, x1 = int(np.argmax(keep_cols)), w - int(np.argmax(keep_cols[::-1]))
    return np.ascontiguousarray(img[y0:y1, x0:x1])


def _known(*specs):
    """The union of several ops' parameter names. An op object like
    `ops.canvas` mixes the fields of two catalog entries, so the unknown-key
    report has to be made against the union or half of it is a false alarm."""
    names = set()
    for s in specs:
        names |= set(s)
    return names


def apply_canvas(rgba, canvas, notes=None):
    """spec 2 stage 1. Trim runs FIRST: trimming after the frame has been
    extended would cut off the background that was just added."""
    if not _valid(rgba):
        return rgba
    src = canvas if isinstance(canvas, dict) else {}
    img = _arr(rgba)
    tspec, cspec = CATALOG["trim"]["params"], CATALOG["canvasSize"]["params"]
    extra = sorted(set(src) - _known(tspec, cspec))
    if extra:
        _note(f"canvas: ignoring field(s) not in the catalog: {', '.join(extra)}", notes)
    t = _coerce(tspec, {k: v for k, v in src.items() if k in tspec}, "canvas: ", notes)
    if t["trim"] in ("transparent", "borders"):
        img = trim(img, t["trim"], t["tolerance"], notes)
    if src.get("width") or src.get("height"):
        c = _coerce(cspec,
                    {**{k: v for k, v in src.items() if k in cspec},
                     "width": src.get("width") or img.shape[1],
                     "height": src.get("height") or img.shape[0]},
                    "canvas: ", notes)
        img = canvas_size(img, c["width"], c["height"], c["anchor"], c["background"])
    return img


# ---------------------------------------------------------------------------
# geometry - spec 7, pipeline stage 3
# ---------------------------------------------------------------------------

def flip(rgba, horizontal=False, vertical=False):
    """Exact. Nothing is resampled, so a flip and a flip back is the identity
    down to the bit."""
    if not _valid(rgba):
        return rgba
    img = _arr(rgba)
    if horizontal:
        img = img[:, ::-1]
    if vertical:
        img = img[::-1]
    return np.ascontiguousarray(img)


def _snap(v):
    """cos(90 degrees) is 6.1e-17, not 0, and that is the difference between a
    right-angle rotation landing exactly on pixel centres and landing 1e-14
    away from them. Snapping the matrix is what lets the general resampling
    path be exact at the one angle where the answer is knowable."""
    for target in (-1.0, 0.0, 1.0):
        if abs(v - target) < 1e-12:
            return target
    return v


def _warp_affine(img, M, size, interpolation, notes=None):
    """Premultiply, warp, un-premultiply.

    cv2 does not know which alpha convention it is filtering. Filtering
    STRAIGHT colour mixes the colour of transparent pixels - which is nothing,
    stored as black - into every edge, and that black halo is the artefact
    everybody recognises and nobody can name. Filtering premultiplied colour
    and dividing the alpha back out afterwards is the only order that is right,
    and the divide is not optional: skip it and the picture comes back at
    alpha-times its own brightness, which on a uniformly half-transparent image
    is exactly half."""
    W, H = size
    if W * H > _MAX_PIXELS:
        _note(f"a {W}x{H} result is past the {_MAX_PIXELS}px cap; left unrotated", notes)
        return img
    flags = _CV_INTERP.get(interpolation, cv2.INTER_CUBIC)
    pm = cv2.warpAffine(_premul(img), M, (W, H), flags=flags,
                        borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    return _unpremul(pm)


def rotate(rgba, degrees, expand=True, interpolation="bicubic", notes=None):
    """Any angle, CLOCKWISE, antialiased.

    Multiples of 90 take np.rot90 instead of the resampler. Not an
    optimisation: a right-angle rotation is a permutation of the pixels, and
    running it through a filter would cost a premultiply round trip that is
    only accurate to a float32 ulp above an alpha of 1e-6 and to nothing at all
    below it. The resampling path is exact at those angles too - the test
    proves it - but it has no business being lossy where it need not be."""
    if not _valid(rgba):
        return rgba
    img = _arr(rgba)
    deg = _f(degrees, 0.0) % 360.0
    if abs(deg - round(deg)) < 1e-9 and int(round(deg)) % 90 == 0:
        k = (-int(round(deg)) // 90) % 4          # clockwise degrees -> ccw rot90 turns
        out = np.ascontiguousarray(np.rot90(img, k))
        if not expand and out.shape != img.shape:
            return canvas_size(out, img.shape[1], img.shape[0], "center", None)
        return out

    M, size = _rotate_matrix(img.shape[1], img.shape[0], deg, expand)
    return _warp_affine(img, M, size, interpolation, notes)


def _rotate_matrix(w, h, degrees, expand=True):
    """The affine matrix and output size a rotation of `degrees` CLOCKWISE
    needs. Split out from rotate() so a test can drive the resampling path at
    an angle rotate() itself would shortcut - the matrix under test is then
    this one and not the test author's memory of it."""
    rad = math.radians(float(degrees))
    c, s = _snap(math.cos(rad)), _snap(math.sin(rad))
    if expand:
        W = int(math.ceil(abs(w * c) + abs(h * s) - 1e-9))
        H = int(math.ceil(abs(w * s) + abs(h * c) - 1e-9))
    else:
        W, H = w, h
    W, H = max(1, W), max(1, H)
    # Rows run downward, so a clockwise turn on screen is [[c, -s], [s, c]].
    M = np.array([[c, -s, 0.0], [s, c, 0.0]], np.float64)
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    M[0, 2] = (W - 1) / 2.0 - (M[0, 0] * cx + M[0, 1] * cy)
    M[1, 2] = (H - 1) / 2.0 - (M[1, 0] * cx + M[1, 1] * cy)
    return M, (W, H)


def perspective(rgba, quad, fit=False, interpolation="bicubic", notes=None):
    """Free transform. `quad` is where the four corners land - TL, TR, BR, BL,
    clockwise, in destination pixels."""
    if not _valid(rgba):
        return rgba
    img = _arr(rgba)
    h, w = img.shape[:2]
    pts = quad if isinstance(quad, np.ndarray) else _points(quad, notes, "perspective: ")
    if len(pts) < 4:
        _note(f"perspective needs four destination points, got {len(pts)}; skipped", notes)
        return img
    dst = np.asarray(pts[:4], np.float64)
    # Three points on a line have no projective map onto a rectangle, and
    # getPerspectiveTransform will hand back a singular or infinite matrix
    # rather than say so.
    for i in range(4):
        a, b, c = dst[i], dst[(i + 1) % 4], dst[(i + 2) % 4]
        u, v = b - a, c - a
        if abs(float(u[0] * v[1] - u[1] * v[0])) < 1e-9:
            _note("perspective: the destination quad is degenerate (three "
                  "points on a line); skipped", notes)
            return img
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float64)
    off = np.zeros(2)
    if fit:
        off = dst.min(axis=0)
        W = int(math.ceil(dst[:, 0].max() - off[0]))
        H = int(math.ceil(dst[:, 1].max() - off[1]))
    else:
        W, H = w, h
    W, H = max(1, W), max(1, H)
    if W * H > _MAX_PIXELS:
        _note(f"a {W}x{H} result is past the {_MAX_PIXELS}px cap; skipped", notes)
        return img
    try:
        M = cv2.getPerspectiveTransform(src.astype(np.float32),
                                        (dst - off).astype(np.float32))
    except cv2.error as exc:
        _note(f"perspective: {exc}; skipped", notes)
        return img
    if not np.isfinite(M).all() or abs(float(np.linalg.det(M))) < 1e-12:
        _note("perspective: the destination quad has no invertible warp; skipped", notes)
        return img
    flags = _CV_INTERP.get(interpolation, cv2.INTER_CUBIC)
    pm = cv2.warpPerspective(_premul(img), M, (W, H), flags=flags,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    return _unpremul(pm)


# ---- seam carving ---------------------------------------------------------

def _energy(img):
    """Gradient magnitude of the premultiplied luma, plus the alpha's own
    gradient so a cutout's edge is not treated as free to walk through.

    The alpha pass is skipped when the alpha is constant, which is every
    photograph. It is not a micro-optimisation: this runs once per carving
    pass, and at 2048 square those two extra Sobels are a third of the pass."""
    a = img[..., 3]
    lum = np.ascontiguousarray(
        (img[..., 0] * 0.299 + img[..., 1] * 0.587 + img[..., 2] * 0.114) * a,
        dtype=np.float32)
    e = np.abs(cv2.Sobel(lum, cv2.CV_32F, 1, 0, ksize=3))
    e += np.abs(cv2.Sobel(lum, cv2.CV_32F, 0, 1, ksize=3))
    if float(a.max()) != float(a.min()):
        ac = np.ascontiguousarray(a)
        e += np.abs(cv2.Sobel(ac, cv2.CV_32F, 1, 0, ksize=3))
        e += np.abs(cv2.Sobel(ac, cv2.CV_32F, 0, 1, ksize=3))
    return e


def _seam_mask(energy, k):
    """A boolean (H, W) with exactly k True per row: k non-crossing vertical
    seams from ONE dynamic-programming pass.

    The exact algorithm re-runs the DP after every single seam. That is one
    pass per seam and it is what makes seam carving quadratic in practice;
    taking k seams off one pass is the standard trade and the only thing that
    keeps this usable above a megapixel. The seams are still the k cheapest
    paths through that energy field, they are just chosen without seeing each
    other's removal. Overlap is forbidden outright - a shared pixel would leave
    a row one pixel short and the reshape would fail - while a crossing is
    harmless, because removal is done by mask and a mask has no opinion about
    which seam a column belonged to."""
    H, W = energy.shape
    k = int(max(1, min(k, W - 1)))
    # An infinity column on each side instead of a fresh left/right array per
    # row: the three candidates are then SLICES of one buffer and the whole DP
    # allocates nothing inside the loop. The loop runs H times and cannot be
    # vectorised - each row depends on the one above - so the only thing that
    # can be taken out of it is the per-row numpy overhead, and that is most of
    # the cost at any width worth carving.
    pad = np.full((H, W + 2), np.inf, np.float32)
    pad[:, 1:W + 1] = energy
    M = pad[:, 1:W + 1]
    back = np.zeros((H, W), np.int8)
    for y in range(1, H):
        left, prev, right = pad[y - 1, 0:W], pad[y - 1, 1:W + 1], pad[y - 1, 2:W + 2]
        best = np.minimum(np.minimum(left, prev), right)
        # Ties go STRAIGHT UP, and that tie-break is load-bearing twice over. A
        # flat region - sky, a wall, a gradient - is a sea of exact ties, and
        # preferring a diagonal there makes every candidate path drift the same
        # way and merge into one, so a pass that asked for 32 seams comes back
        # with two and the batching buys nothing. It also draws straighter
        # seams, which is what a seam through flat sky should look like.
        back[y] = np.where(best == prev, 0, np.where(best == left, -1, 1))
        M[y] += best

    # Backtracking the k cheapest endpoints INDEPENDENTLY does not work, and it
    # is worth saying why because the failure is silent and looks like success:
    # the back-pointers form a forest, adjacent endpoints funnel into the same
    # trunk within a few rows, and a pass asked for 32 seams hands back two
    # identical ones. Measured on a gradient with a textured subject: 2 of 64.
    #
    # So the k seams are backtracked TOGETHER and kept in order. Each one takes
    # the step the DP recorded; where two would land on the same pixel, the
    # right-hand one is pushed over by the accumulate, which is the smallest
    # nudge that keeps them strictly increasing. Strictly increasing is not a
    # nicety - it is what guarantees exactly k pixels per row, which is what
    # lets the removal be one boolean index and one reshape.
    end = np.argsort(M[-1], kind="stable")[:k]
    xs = np.sort(end).astype(np.int64)
    idx = np.arange(xs.size, dtype=np.int64)
    paths = np.empty((H, xs.size), np.int64)
    detours = 0
    for y in range(H - 1, -1, -1):
        paths[y] = xs
        if y:
            t = np.maximum.accumulate(xs + back[y, xs] - idx)
            np.clip(t, 0, W - xs.size, out=t)
            nxt = t + idx
            detours += int(np.count_nonzero(np.abs(nxt - xs) > 1))
            xs = nxt
    mask = np.zeros((H, W), bool)
    mask[np.arange(H)[:, None], paths] = True
    return mask, int(xs.size), detours


def _carve(img, target, notes, seams_per_pass, max_carve, axis_name):
    """Remove or insert vertical seams until the width is `target`."""
    H, W = img.shape[:2]
    if target == W:
        return img
    span = abs(target - W)
    cap = int(round(max_carve * W))
    if span > cap:
        _note(f"smartResize: {span}px off the {axis_name} is more than the "
              f"{max_carve:.0%} seam carving can account for; carving {cap}px "
              f"and plain-resizing the remaining {span - cap}px", notes)
        span = cap
    if span <= 0:
        return img
    shrink = target < W
    # About four energy passes whatever the size - that is the whole
    # budget, and it is what keeps a 2048-square carve near a second instead
    # of near a minute.
    per = int(seams_per_pass) if seams_per_pass else max(1, min(64, int(math.ceil(span / 4))))
    if per > 1:
        _note(f"smartResize: taking up to {per} seams per energy pass on the "
              f"{axis_name} - the exact algorithm is one pass per seam and is "
              f"not interactive at this size", notes)
    done = 0
    detours = 0
    while done < span:
        want = min(per, span - done)
        e = _energy(img)
        mask, n, det = _seam_mask(e, want)
        detours += det
        if n <= 0:
            _note(f"smartResize: no seam left on the {axis_name} after {done} "
                  f"of {span}", notes)
            break
        h, w = img.shape[:2]
        if shrink:
            img = img[~mask].reshape(h, w - n, 4)
        else:
            pm = _premul(img)
            nxt = np.empty_like(pm)
            nxt[:, :-1] = pm[:, 1:]
            nxt[:, -1] = pm[:, -1]
            pairs = np.stack([pm, (pm + nxt) * 0.5], axis=2)
            sel = np.stack([np.ones((h, w), bool), mask], axis=2)
            img = _unpremul(pairs[sel].reshape(h, w + n, 4))
        done += n
    if detours:
        _note(f"smartResize: {detours} seam step(s) on the {axis_name} were "
              f"nudged more than one pixel to keep the seams apart "
              f"({detours / max(1, span * H):.2%} of them)", notes)
    return img


def smart_resize(rgba, width=0, height=0, seams_per_pass=0, max_carve=0.5, notes=None):
    """Content-aware resize. spec 7.

    Carves the width, then transposes and carves the height, then - only if
    the request was past what seam carving can honestly do - hands whatever is
    left to a plain resize and SAYS SO. A silent fallback to a plain resize is
    the one outcome this must never produce, because from the outside it looks
    exactly like a working feature."""
    if not _valid(rgba):
        return rgba
    img = _arr(rgba)
    h, w = img.shape[:2]
    tw = int(_f(width, 0)) or w
    th = int(_f(height, 0)) or h
    tw = max(1, min(tw, 30000))
    th = max(1, min(th, 30000))
    mc = min(max(_f(max_carve, 0.5), 0.05), 1.0)
    if (tw, th) == (w, h):
        return img
    if tw != w:
        img = _carve(img, tw, notes, seams_per_pass, mc, "width")
    if th != h:
        img = np.ascontiguousarray(np.swapaxes(img, 0, 1))
        img = _carve(img, th, notes, seams_per_pass, mc, "height")
        img = np.ascontiguousarray(np.swapaxes(img, 0, 1))
    if img.shape[:2] != (th, tw):
        _note(f"smartResize: {img.shape[1]}x{img.shape[0]} after carving; the "
              f"remaining difference to {tw}x{th} is a PLAIN resize", notes)
        shrinking = tw * th < img.shape[0] * img.shape[1]
        pm = cv2.resize(_premul(img), (tw, th),
                        interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_CUBIC)
        img = _unpremul(pm)
    return img


def apply_geometry(rgba, geometry, notes=None):
    """spec 2 stage 3: flip, then rotate, then perspective, then smartResize.

    The order is fixed and documented because a perspective quad is written in
    pixels, and pixels move: give the quad in the coordinates of the frame as
    it is AFTER the flip and the rotation."""
    if not _valid(rgba):
        return rgba
    src = geometry if isinstance(geometry, dict) else {}
    img = _arr(rgba)
    fspec = CATALOG["flip"]["params"]
    rspec = CATALOG["rotate"]["params"]
    pspec = CATALOG["perspective"]["params"]
    extra = sorted(set(src) - _known(fspec, rspec, pspec) - {"smartResize"})
    if extra:
        _note(f"geometry: ignoring field(s) not in the catalog: {', '.join(extra)}", notes)
    f = _coerce(fspec, {k: v for k, v in src.items() if k in fspec}, "geometry: ", notes)
    if f["flipH"] or f["flipV"]:
        img = flip(img, f["flipH"], f["flipV"])
    if src.get("rotate"):
        r = _coerce(rspec, {k: v for k, v in src.items() if k in rspec},
                    "geometry: ", notes)
        img = rotate(img, r["rotate"], r["expand"], r["interpolation"], notes)
    if src.get("perspective"):
        pr = _coerce(pspec, {k: v for k, v in src.items() if k in pspec},
                     "geometry: ", notes)
        img = perspective(img, pr["perspective"], pr["fit"], pr["interpolation"], notes)
    sr = src.get("smartResize")
    if isinstance(sr, dict):
        s = _coerce(CATALOG["smartResize"]["params"], sr, "geometry.smartResize: ", notes)
        img = smart_resize(img, s["width"], s["height"], s["seamsPerPass"],
                           s["maxCarve"], notes)
    return img


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def bench():
    rng = np.random.default_rng(0)
    img = rng.random((2048, 2048, 4)).astype(np.float32)
    out = {}

    def timed(name, fn, runs=5):
        if runs > 1:
            fn()                       # warm the allocator; not for the slow ones
        t = time.perf_counter()
        for _ in range(runs):
            fn()
        out[name] = round((time.perf_counter() - t) / runs * 1000, 2)

    timed("flipH", lambda: flip(img, True, False))
    timed("rotate90", lambda: rotate(img, 90))
    timed("rotate37", lambda: rotate(img, 37))
    timed("rotate37 no-expand", lambda: rotate(img, 37, expand=False))
    quad = [[40, 0], [2048, 120], [2000, 2048], [0, 1900]]
    timed("perspective", lambda: perspective(img, quad))
    timed("canvasSize 3000", lambda: canvas_size(img, 3000, 3000, "center"))
    timed("trim", lambda: trim(img, "transparent"))
    shp = {"kind": "ellipse", "points": [[100, 100], [1900, 1800]],
           "fill": [255, 0, 0, 255], "stroke": [0, 0, 255, 255], "strokeWidth": 12}
    timed("ellipse fill+stroke", lambda: draw_shape(img, shp))
    poly = {"kind": "polygon", "points": [[100, 100], [1900, 300], [1500, 1900], [300, 1500]],
            "fill": [255, 255, 255, 200], "stroke": [0, 0, 0, 255], "strokeWidth": 8}
    timed("polygon fill+stroke", lambda: draw_shape(img, poly))
    for n in (512, 1024, 2048):
        sub = img[:n, :n]
        timed(f"smartResize {n} -10%",
              lambda s=sub, m=n: smart_resize(s, int(m * 0.9), 0, notes=[]), runs=1)
        timed(f"smartResize {n} -10% exact",
              lambda s=sub, m=n: smart_resize(s, int(m * 0.9), 0, seams_per_pass=1,
                                              notes=[]), runs=1)
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    elif mode == "bench":
        print(json.dumps(bench(), indent=2))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
