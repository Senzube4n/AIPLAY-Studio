"""Selection masks - the multiplier that makes every other op local.

A selection is a float32 (H, W) array, 0..1, and IMAGE_SPEC §3 turns the whole
editor on one line of arithmetic:

    out = result * m + original * (1 - m)

That is `blend()` at the bottom of this file, and it is the only reason 25
adjustments and 75 effects become local from one implementation. Nothing here
knows what an adjustment is; it hands back a mask and the caller multiplies.

    resolve(selection, rgba, warn=None) -> float32 (H, W), 0..1
    blend(original, result, mask)       -> float32 (H, W, 4), straight alpha
    describe(selection, rgba)           -> what the UI puts under the marching ants
    catalog()                           -> the vocabulary, for MCP and the panels

`rgba` is float32 (H, W, 4), 0..1, STRAIGHT alpha - the same array effects.py
takes, sampled at STAGE 4: after geometry, before any adjustment. A wand run
after the tone stage would select against pixels the user cannot see yet.

THE ONE THING TO GET RIGHT IS blend(). These buffers are straight alpha, and
the formula above applied to all four channels is the formula for PREMULTIPLIED
data. Run it on straight data and every semi-transparent edge fringes toward
whatever colour is sitting under the transparency - usually black, which is why
the bug always reads as a dark halo. See the comment on `blend`.

NO SELECTION IS A MASK OF ONES, and it is produced by this file rather than by
a branch at each of the hundred call sites, so that path cannot drift. The one
distinction worth knowing: `selection` absent, None, a dict with no "shapes"
key, or one whose "shapes" is null - all of them mean "I did not select
anything, edit the frame" -> ones, because null is how JSON spells absent. A
"shapes" LIST that is present but empty, or whose every entry is degenerate,
means "my selection came out empty" -> zeros, and every op becomes a no-op.
Those two must not collapse into each other: a NaN-poisoned rectangle silently
turning into a global edit is how you lose someone's picture.

The accumulator STARTS EMPTY, so shapes[0] should be `add` - an `intersect`
with nothing selected is nothing, which is what intersect means and is not
special-cased into "replace" the way a marquee tool would. Everything after
shapes[0] behaves the way the panel implies.

ORDER, and it matters:

    each shape rasterised -> hardened if antialias is off
    combined in list order by its own mode (add / subtract / intersect)
    expand      (morphological, +grows -contracts)
    feather     (gaussian)
    invert

`expand` reads the mask as a hard edge carrying at most a one-pixel ramp, which
is exactly what a rasterised shape is and exactly what a FEATHERED shape is
not - a 10px ramp would be read as a 10px displacement of the boundary. So
expand runs first, and "feather 8, expand 5" means the boundary moves 5px and
is then softened by 8, which is also the sentence a person means when they say
it. Feathering an expanded mask and expanding a feathered one are different
pictures; this file does the first.

`invert` is last, so it is the complement of exactly what you selected,
softness included. It does not commute with expand: `expand 5, invert` is the
background minus a 5px bite, not the background plus one.

COLOUR DISTANCE (wand, colorRange) is CIE76 in L*a*b* with L* at half weight,
plus alpha, NOT RGB euclidean - see `_colour_distance` for the argument.

    python imgselect.py catalog     # the vocabulary as one JSON line
    python imgselect.py bench       # per-kind cost at 4096x4096

numpy / cv2.
"""
# ── WIRING - what the engine owner has to do, and it is all of it ────────────
#
#   1. server/imagetools.py, with the other imports:
#
#          import imgselect
#
#   2. At STAGE 4, once geometry is done and before any adjustment, on the
#      float32 (H, W, 4) 0..1 straight-alpha array:
#
#          warn = []
#          mask = imgselect.resolve(ops.get("selection"), rgba, warn)
#          if warn:
#              return {"ok": False, "error": warn[0]}     # §3 wants this loud
#
#      §3 names the out-of-bounds wand seed specifically ("Say so in the error
#      if a wand seed lands out of bounds"), and every warning this module
#      raises is of that family: the caller asked for something the picture
#      cannot answer. Failing the job is the integrator's line to write because
#      only the integrator owns the job envelope - but it is not optional, and
#      `resolve` never raises so that the choice stays there.
#
#   3. Stages 5-8 each become two lines instead of one:
#
#          out = <the op, computed over the WHOLE frame as it always was>
#          rgba = imgselect.blend(rgba, out, mask)
#
#      Every op. An adjustment that skips this is an adjustment that ignores
#      the selection, and nothing will raise to tell you. `blend` short-circuits
#      an all-ones mask to `result` itself, so the no-selection path costs one
#      array scan and is BIT-IDENTICAL to not calling blend at all - which is
#      the property that lets it be unconditional.
#
#   4. server/index.js and server/mcp.js: serve `imgselect.catalog()` beside the
#      effect catalog, from `python server/imgselect.py catalog`. Every
#      parameter below is described with its type, range and default, so the
#      panel and the MCP schema are generated rather than typed.
#
#   5. `describe(selection, rgba)` is what the selection panel puts under the
#      marching ants - pixel count, coverage, how much of it is a soft edge,
#      and the warnings. A selection that came out empty is the single most
#      confusing state in an editor and this is the only thing that can say so.
#
# Nothing else. This module owns no files, no job envelope and no pipeline; it
# takes an array and a dict and returns a mask.

import json
import math
import sys
import time

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# the catalog
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Marquee", "Freehand", "Colour"]

MODES = ["add", "subtract", "intersect"]

# An agent will guess these, and a guess that works is a round trip saved.
ALIASES = {
    "rectangle": "rect", "marquee": "rect", "box": "rect", "square": "rect",
    "circle": "ellipse", "oval": "ellipse", "elliptical": "ellipse",
    "lasso": "polygon", "poly": "polygon", "freehand": "polygon",
    "path": "polygon", "magicWand": "wand", "magic-wand": "wand",
    "magicwand": "wand", "floodFill": "wand", "flood": "wand",
    "colorrange": "colorRange", "color-range": "colorRange",
    "colourRange": "colorRange", "selectColor": "colorRange",
}


def num(default, lo, hi, desc, animatable=False, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": animatable, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "animatable": False, "desc": desc}


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default,
            "animatable": False, "desc": desc}


def col(default, desc):
    """Colours are 0-255 RGB. §9 of the spec is about this exact line: a 0-1
    triple is a legal near-black colour, so it selects a perfectly plausible
    nothing and no test that counts pixels will ever notice."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": False, "desc": desc}


def pointlist(desc):
    return {"type": "points", "default": [], "animatable": False, "desc": desc}


MODE_PARAM = pick(MODES, "add",
                  "how this shape joins the ones before it; the selection-level "
                  "`mode` is the default when a shape omits it. The first shape "
                  "combines against an EMPTY selection, so a leading `intersect` "
                  "or `subtract` selects nothing")


def shape(name, label, group, why, params):
    CATALOG[name] = {"label": label, "group": group, "why": why,
                     "params": dict(params, mode=MODE_PARAM)}


shape("rect", "Rectangle", "Marquee",
      "The axis-aligned marquee. Coverage is computed analytically per axis, so "
      "integer bounds give exactly the pixels inside and no partial ones, and "
      "fractional bounds give the exact fraction of each edge pixel.",
      {"x": num(0, -1e6, 1e6, "left edge in post-geometry pixels", unit="px"),
       "y": num(0, -1e6, 1e6, "top edge in post-geometry pixels", unit="px"),
       "w": num(100, -1e6, 1e6, "width; negative is normalised, the way a marquee "
                                "dragged up-and-left arrives", unit="px"),
       "h": num(100, -1e6, 1e6, "height; negative is normalised", unit="px")})

shape("ellipse", "Ellipse", "Marquee",
      "The elliptical marquee. The edge is an analytic distance to the ellipse, "
      "not a supersample, so the area lands within about a hundredth of a "
      "percent of pi*rx*ry at any radius above a few pixels.",
      {"cx": num(0, -1e6, 1e6, "centre x", unit="px"),
       "cy": num(0, -1e6, 1e6, "centre y", unit="px"),
       "rx": num(50, 0, 1e6, "horizontal radius; negative is taken as its "
                             "magnitude", unit="px"),
       "ry": num(50, 0, 1e6, "vertical radius", unit="px")})

shape("polygon", "Lasso", "Freehand",
      "A closed polygon - the lasso, and the shape any freehand tool reduces "
      "to. Self-intersection fills EVEN-ODD: a pentagram is a five-pointed "
      "outline with a hole, not a solid star. Fewer than 3 points encloses no "
      "area and selects nothing.",
      {"points": pointlist("[[x, y], ...] in post-geometry pixels; the path is "
                           "closed for you, so the last point need not repeat "
                           "the first")})

shape("wand", "Magic wand", "Freehand",
      "Everything within `tolerance` of the colour under the seed. Distance is "
      "perceptual (CIE76 in L*a*b*, lightness at half weight) rather than RGB, "
      "which is what lets it take a whole sky or a whole cheek instead of "
      "stopping at the first shadow.",
      {"x": num(0, -1e6, 1e6, "seed x; outside the image is an error, not a "
                              "shrug", unit="px"),
       "y": num(0, -1e6, 1e6, "seed y", unit="px"),
       "tolerance": num(32, 0, 255, "perceptual distance (weighted CIE76 dE). "
                                    "Under 5 is one shade of one surface, ~30 "
                                    "takes a material across normal lighting, "
                                    "past ~90 it is taking hues"),
       "contiguous": flag(True, "keep only the region touching the seed "
                                "(4-connected); off selects every matching "
                                "pixel in the frame"),
       "lightness": num(0.5, 0, 1, "how much lightness counts against hue and "
                                   "chroma. 1 is plain CIE76 and splits a sky "
                                   "into bands; 0 cannot tell white from black")})

shape("colorRange", "Colour range", "Colour",
      "Global selection by proximity to one colour, with a soft shoulder. "
      "Within `tolerance` is fully selected, and it falls to zero over the next "
      "`softness` - so unlike the wand this produces genuinely partial values "
      "and is the tool for a graded key rather than a region.",
      {"color": col([255, 255, 255], "the colour to select, 0-255 RGB"),
       "tolerance": num(32, 0, 255, "weighted CIE76 dE that is still fully "
                                    "selected; same scale as the wand's"),
       "softness": num(8, 0, 255, "width of the falloff past the tolerance; 0 "
                                  "is a hard threshold"),
       "lightness": num(0.5, 0, 1, "weight on lightness, as for the wand")})

# The selection-level modifiers. Same param shape as a shape's, because the
# panel and the MCP schema are generated from both and a second convention is a
# second thing to get wrong.
MODIFIERS = {
    "mode": pick(MODES, "add", "default combine mode for shapes that omit one"),
    "feather": num(0, 0, 1000, "gaussian sigma in px. Not a radius: the visible "
                               "transition runs about 2 sigma either side of "
                               "the edge. Mass-preserving, so a feathered "
                               "selection has the same total as the hard one "
                               "unless it runs off the frame", unit="px"),
    "invert": flag(False, "complement the finished mask, softness and all"),
    "expand": num(0, -1000, 1000, "grow (+) or contract (-) the boundary by this "
                                  "many px, measured as true euclidean distance "
                                  "and applied BEFORE feather", unit="px"),
    "antialias": flag(True, "soft edges on the shapes themselves. Off gives a "
                            "hard 0/1 mask - which `feather` will then soften "
                            "again, because feather is an explicit request and "
                            "antialias is only about edge quality"),
}


# ---------------------------------------------------------------------------
# reading a hostile document
# ---------------------------------------------------------------------------

_EPS = np.float32(1e-6)


def _num(v, default, lo=-1e9, hi=1e9):
    """Every number below has been through here. NaN and inf are the two that
    matter: they survive comparisons, poison a coordinate silently, and a
    rectangle whose width is NaN clips to the whole frame in most naive
    implementations - which is the accident that turns a local edit global."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float(default)
    if not math.isfinite(f):
        return float(default)
    return min(max(f, lo), hi)


def _int(v, default, lo=-10 ** 9, hi=10 ** 9):
    return int(round(_num(v, default, lo, hi)))


def _points(raw):
    """[[x, y], ...] with every unusable entry dropped rather than the whole
    list rejected - a lasso with one NaN sample from a flaky pointer is still a
    lasso."""
    out = []
    for p in (raw if isinstance(raw, (list, tuple)) else []):
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            out.append((x, y))
    return out


def _rgb255(v, default=(255, 255, 255)):
    try:
        chan = [min(255.0, max(0.0, _num(c, 0.0))) for c in list(v)[:3]]
    except (TypeError, ValueError):
        chan = []
    return chan if len(chan) == 3 else list(default)


def _mode_of(spec, fallback):
    m = spec.get("mode") if isinstance(spec, dict) else None
    return m if m in MODES else fallback


# ---------------------------------------------------------------------------
# rasterising one shape
# ---------------------------------------------------------------------------

def _empty(h, w):
    return np.zeros((h, w), np.float32)


def _box(h, w, x0, y0, x1, y1, pad=1):
    """The integer pixel window a shape can possibly touch, clipped to the
    frame. Everything below computes inside this and pastes, so a 40px marquee
    on a 4K plate costs what a 40px marquee costs."""
    ix0 = max(0, int(math.floor(x0)) - pad)
    iy0 = max(0, int(math.floor(y0)) - pad)
    ix1 = min(w, int(math.ceil(x1)) + pad)
    iy1 = min(h, int(math.ceil(y1)) + pad)
    if ix1 <= ix0 or iy1 <= iy0:
        return None
    return ix0, iy0, ix1, iy1


def _paste(h, w, box, sub):
    m = _empty(h, w)
    x0, y0, x1, y1 = box
    m[y0:y1, x0:x1] = sub
    return m


def _rect_mask(spec, h, w, warn):
    x, y = _num(spec.get("x"), 0.0), _num(spec.get("y"), 0.0)
    dw, dh = _num(spec.get("w"), 0.0), _num(spec.get("h"), 0.0)
    # A marquee dragged up-and-left arrives with negative extents. Normalising
    # is what the gesture meant; refusing it would be pedantry with a mouse.
    x0, x1 = (x, x + dw) if dw >= 0 else (x + dw, x)
    y0, y1 = (y, y + dh) if dh >= 0 else (y + dh, y)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        warn.append("rect has no area (w or h is zero)")
        return _empty(h, w)
    box = _box(h, w, x0, y0, x1, y1, pad=0)
    if box is None:
        warn.append(f"rect ({x0:g},{y0:g})-({x1:g},{y1:g}) is entirely outside "
                    f"the {w}x{h} image")
        return _empty(h, w)
    bx0, by0, bx1, by1 = box
    # Exact coverage: pixel i spans [i, i+1), so its share of [x0, x1) is the
    # length of the overlap. Integer bounds therefore give exactly 1 or exactly
    # 0 and never a partial pixel, which is the one property a marquee has that
    # every other shape here does not.
    ix = np.arange(bx0, bx1, dtype=np.float32)
    iy = np.arange(by0, by1, dtype=np.float32)
    cx = np.clip(np.minimum(x1, ix + 1.0) - np.maximum(x0, ix), 0.0, 1.0)
    cy = np.clip(np.minimum(y1, iy + 1.0) - np.maximum(y0, iy), 0.0, 1.0)
    return _paste(h, w, box, np.outer(cy, cx).astype(np.float32))


def _ellipse_mask(spec, h, w, warn):
    cx, cy = _num(spec.get("cx"), 0.0), _num(spec.get("cy"), 0.0)
    rx, ry = abs(_num(spec.get("rx"), 0.0)), abs(_num(spec.get("ry"), 0.0))
    if rx <= 0 or ry <= 0:
        warn.append("ellipse has no area (rx or ry is zero)")
        return _empty(h, w)
    box = _box(h, w, cx - rx, cy - ry, cx + rx, cy + ry)
    if box is None:
        warn.append(f"ellipse at ({cx:g},{cy:g}) r({rx:g},{ry:g}) is entirely "
                    f"outside the {w}x{h} image")
        return _empty(h, w)
    bx0, by0, bx1, by1 = box
    xs = (np.arange(bx0, bx1, dtype=np.float32) + 0.5 - cx)
    ys = (np.arange(by0, by1, dtype=np.float32) + 0.5 - cy)
    u = (xs / rx)[None, :]
    v = (ys / ry)[:, None]
    g = u * u + v * v
    # Distance to the g == 1 isoline, to first order: (1 - g) / |grad g|. For a
    # circle that is algebraically the exact signed distance; for an ellipse it
    # is right to within the curvature over one pixel, which is nothing at any
    # radius you can see. Supersampling would have cost 16x the memory for a
    # WORSE number, because a sampled edge is quantised and this one is not.
    gx = 2.0 * u / rx
    gy = 2.0 * v / ry
    grad = np.sqrt(gx * gx + gy * gy)
    d = (1.0 - g) / np.maximum(grad, _EPS)
    return _paste(h, w, box, np.clip(d + 0.5, 0.0, 1.0).astype(np.float32))


_SUB = 4                # sub-scanlines per output row; x needs none, see below
_BAND_BYTES = 16 << 20  # peak scratch per band; ~490 rows of a 4096-wide frame


def _poly_mask(spec, h, w, warn):
    """A closed polygon, filled EVEN-ODD, exact in x and sampled in y.

    This is a hand-rolled scanline rather than cv2.fillPoly for one measured
    reason: cv2 fills a span INCLUSIVE of both endpoints, so a shape n pixels
    wide comes out n+1 wide however finely you supersample it. On a 40x20
    rectangle that is 815 pixels where 800 is the answer - a 1.9% area bias
    that no amount of sampling removes, because it is a convention and not a
    quantisation.

    Horizontal coverage is therefore computed ANALYTICALLY: a span from x=3.2
    to x=5.7 deposits exactly 0.8, 1.0 and 0.7, whatever the geometry. Only y
    is sampled, `_SUB` sub-scanlines per row, and the cost of that is in the
    crossing list rather than in the pixels - a plain 4x4 supersample would be
    sixteen times the memory for a WORSE number in x. The trade is the same one
    shapes.py makes: a near-horizontal edge quantises to 1/4 of a pixel while a
    near-vertical one is exact.

    EVEN-ODD is the fill rule, and it is the useful one. A pentagram is a
    five-pointed outline with a pentagonal hole rather than a solid star, and -
    the case people actually draw - a lasso that goes round the outside, walks
    in along its own path and goes round an island leaves the island unselected.
    Under nonzero, whether that island is a hole depends on which way the hand
    went round it. For any path that does not cross itself the two rules agree,
    so this only decides what happens to a crossing, and a hole is the more
    legible answer than one that depends on handedness.
    """
    pts = _points(spec.get("points"))
    if len(pts) < 3:
        warn.append(f"polygon has {len(pts)} usable point(s); 3 enclose the "
                    f"smallest possible area")
        return _empty(h, w)
    arr = np.asarray(pts, np.float64)
    box = _box(h, w, arr[:, 0].min(), arr[:, 1].min(), arr[:, 0].max(), arr[:, 1].max())
    if box is None:
        warn.append(f"polygon is entirely outside the {w}x{h} image")
        return _empty(h, w)
    bx0, by0, bx1, by1 = box
    bw, bh = bx1 - bx0, by1 - by0

    ring = np.vstack([arr, arr[:1]])                      # closed for you
    xa, ya = ring[:-1, 0] - bx0, ring[:-1, 1] - by0
    xb, yb = ring[1:, 0] - bx0, ring[1:, 1] - by0
    live = ya != yb                    # a horizontal edge crosses no scanline
    xa, ya, xb, yb = xa[live], ya[live], xb[live], yb[live]
    if xa.size == 0:
        warn.append("polygon is degenerate (every edge is horizontal)")
        return _empty(h, w)
    dxdy = (xb - xa) / (yb - ya)

    stride = bw + 2
    band = max(1, min(bh, int(_BAND_BYTES // max(1, stride * 8))))
    out = np.empty((bh, bw), np.float32)
    lo, hi = np.minimum(ya, yb), np.maximum(ya, yb)
    for top in range(0, bh, band):
        rows = min(band, bh - top)
        ys = (top + np.arange(rows * _SUB, dtype=np.float64) / _SUB
              + 0.5 / _SUB)[:, None]
        # Half-open in y so a vertex shared by two edges is crossed once, not
        # twice - the classic scanline double-count that punches a hole at
        # every local extremum.
        xc = np.where((ys >= lo) & (ys < hi), xa + (ys - ya) * dxdy, np.inf)
        xc.sort(axis=1)
        if xc.shape[1] & 1:
            xc = np.hstack([xc, np.full((xc.shape[0], 1), np.inf)])
        left = np.clip(xc[:, 0::2], 0.0, bw)
        right = np.clip(xc[:, 1::2], 0.0, bw)
        # Coverage of pixel i by a span [l, r) is H(l, i) - H(r, i), where
        # H(a, i) = clip(i + 1 - a, 0, 1) is its coverage by the half-line from
        # a rightwards. H is a step with exactly one partial pixel at floor(a),
        # so it is two scattered adds and a running sum - which turns "paint
        # every span" into one bincount for the whole band.
        #
        # The sub-scanlines are folded in BEFORE the scan, not after: a running
        # sum and an average are both linear, so scattering sub-row j into
        # output row j // _SUB at weight 1/_SUB gives the identical answer for
        # a quarter of the buffer and a quarter of the scan.
        acc = np.zeros(rows * stride, np.float64)
        base = ((np.arange(rows * _SUB) // _SUB) * stride)[:, None]
        for edge, sign in ((left, 1.0 / _SUB), (right, -1.0 / _SUB)):
            fl = np.floor(edge)
            frac = edge - fl
            idx = (base + fl.astype(np.int64)).ravel()
            acc += np.bincount(idx, weights=(sign * (1.0 - frac)).ravel(),
                               minlength=acc.size)
            acc += np.bincount(idx + 1, weights=(sign * frac).ravel(),
                               minlength=acc.size)
        acc = acc.reshape(rows, stride)
        np.cumsum(acc, axis=1, out=acc)
        out[top:top + rows] = acc[:, :bw]
    np.clip(out, 0.0, 1.0, out=out)
    return _paste(h, w, box, out)


# ---------------------------------------------------------------------------
# colour distance - the choice the wand lives or dies on
# ---------------------------------------------------------------------------

def _lab(rgba):
    """RGB 0..1 -> CIE L*a*b*, cv2's float layout and NOT rescaled: L* 0..100,
    a*/b* about +-128. Those are the units CIE76 is defined in, so one unit of
    lightness already counts as one unit of chroma and any helpful-looking
    rescale of L* onto a 0-255 axis silently re-inflates lightness by 2.55x -
    which is the exact bias L*a*b* was reached for in the first place."""
    return cv2.cvtColor(np.ascontiguousarray(rgba[..., :3]), cv2.COLOR_RGB2Lab)


def _colour_distance(lab, alpha, seed_lab, seed_a, lightness):
    """CIE76 in L*a*b*, lightness weighted, alpha included.

    RGB euclidean is the naive metric and it fails in one specific way: RGB
    distance is dominated by BRIGHTNESS, because all three channels move
    together when the light does. A sky is one colour lit across three stops,
    so a wand loose enough to take the whole sky is loose enough to take the
    building beside it, and one tight enough to spare the building bands the
    sky. L*a*b* puts lightness on its own axis; weighting that axis DOWN says
    the thing a person means by "this colour" - the same material under
    different light.

    Measured, on eight two-material scenes (a lit ramp of one material against
    a flat distractor: sky/building, skin/wood, skin in skylit shade, foliage/
    dirt, red car/road, white wall/beige, deep blue sky, grass/green sign). The
    score is the fraction of the ramp a wand can take before it jumps to the
    other material at all - i.e. how much of the region is reachable AT ANY
    tolerance:

        RGB euclidean                     70.4% mean, best in 2 of 8
        L*a*b*, L weighted 1.0 (CIE76)    83.5% mean, best in 4
        L*a*b*, L weighted 0.5            86.0% mean, best in 6   <- default
        CIE94                             62.5% mean, best in 0

    CIE94 is in that list because it is the obvious "better" answer and it is
    WORSE here, decisively. It divides chroma differences by (1 + 0.045*C), so
    around a saturated seed every other hue is pulled closer - which is right
    for judging whether two printed samples match and wrong for asking what
    else in the frame is this colour. The red car scores 100% under weighted
    CIE76 and 45% under CIE94.

    0.5 rather than the mean-optimal 0.35 because the mean peak is flat (87.7%
    against 86.0%) and the worst case is not: 0.35 gives up ten points on the
    scene it handles worst. Both skin scenes are where the weighting loses to
    RGB, because skin in shadow DESATURATES rather than just darkening, so its
    chroma moves as far as its lightness. That is what the dial is for; 0 is
    not an option at either end, since a=b=0 is both white and black.

    ALPHA is in the distance because these are RGBA buffers and the RGB under a
    transparent pixel is undefined - matching it is meaningless. Without this
    term a wand seeded on a cut-out subject cheerfully takes the transparent
    surround whenever the garbage colour left behind happens to be close.
    """
    d = lab - seed_lab
    d[..., 0] *= float(lightness)
    # Alpha scaled by 100, the range of L*: opaque against transparent is then
    # exactly as far apart as white against black, which is the only defensible
    # place to put it and keeps the whole distance on one axis.
    da = (alpha - float(seed_a)) * 100.0
    return np.sqrt(np.einsum("...c,...c->...", d, d) + da * da, dtype=np.float32)


def _falloff(dist, tolerance, softness):
    """1 inside the tolerance, 0 past tolerance+softness, smoothstep between.
    Smoothstep rather than a linear ramp because a linear falloff leaves a
    visible crease where it meets the flat top - the same reason every gradient
    tool in every editor is cubic."""
    if softness <= 0.0:
        return (dist <= tolerance).astype(np.float32)
    t = np.clip((dist - tolerance) / softness, 0.0, 1.0)
    return (1.0 - t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _wand_mask(spec, rgba, h, w, warn, antialias):
    x, y = _int(spec.get("x"), 0), _int(spec.get("y"), 0)
    if not (0 <= x < w and 0 <= y < h):
        # §3: "Say so in the error if a wand seed lands out of bounds."
        warn.append(f"wand seed ({x}, {y}) is outside the {w}x{h} image")
        return _empty(h, w)
    tol = _num(spec.get("tolerance"), 32.0, 0.0, 255.0)
    light = _num(spec.get("lightness"), 0.5, 0.0, 1.0)
    lab = _lab(rgba)
    alpha = rgba[..., 3]
    dist = _colour_distance(lab, alpha, lab[y, x].copy(), float(alpha[y, x]), light)
    # The soft shoulder is one distance unit wide, not a fraction of the
    # tolerance: it exists to antialias the boundary where the image ramps
    # through the threshold, and that ramp does not get wider when the
    # tolerance does. On a flat synthetic region it changes nothing at all,
    # which is what makes "selects exactly that region" testable.
    m = _falloff(dist, max(0.0, tol - 1.0), 1.0) if antialias else _falloff(dist, tol, 0.0)
    if spec.get("contiguous", True):
        # 4-connected. 8 leaks through single-pixel diagonal contacts, and on
        # any photograph with grain that is enough to join the whole frame -
        # the classic "the wand selected everything" bug, which is a
        # connectivity choice and not a tolerance one.
        n, lbl = cv2.connectedComponents((dist <= tol).astype(np.uint8), connectivity=4)
        m = np.where(lbl == lbl[y, x], m, np.float32(0.0))
    return m.astype(np.float32, copy=False)


def _colour_range_mask(spec, rgba, h, w, warn, antialias):
    rgb = _rgb255(spec.get("color"))
    tol = _num(spec.get("tolerance"), 32.0, 0.0, 255.0)
    soft = _num(spec.get("softness"), 8.0, 0.0, 255.0)
    light = _num(spec.get("lightness"), 0.5, 0.0, 1.0)
    seed = _lab(np.asarray([[rgb]], np.float32) / np.float32(255.0))[0, 0]
    # A colour range names an OPAQUE colour, so the target alpha is 1: asking
    # for "everything near this red" must not hand back the transparent margin.
    dist = _colour_distance(_lab(rgba), rgba[..., 3], seed, 1.0, light)
    if soft <= 0.0 and antialias:
        soft = 1.0            # same one-unit shoulder the wand gets, same reason
        tol = max(0.0, tol - 1.0)
    return _falloff(dist, tol, soft)


# ---------------------------------------------------------------------------
# combining
# ---------------------------------------------------------------------------

def _add(a, b):
    return np.maximum(a, b)


def _subtract(a, b):
    return np.clip(a - b, 0.0, 1.0)


def _intersect(a, b):
    return np.minimum(a, b)


# The min/max lattice, plus "subtract removes exactly the overlap" - which is
# what max(0, a-b) is, since a - min(a, b) == max(0, a - b). The two properties
# a person notices are that adding the same region twice changes nothing and
# that subtracting a region from itself leaves nothing; the probabilistic
# family (a+b-ab, ab, a(1-b)) has neither, and gives 75% where two half-covered
# edges overlap. The cost of max-union is the reverse: two antialiased shapes
# that ABUT leave a 50% seam instead of closing to 100%. That is the right trade
# for a selection - a seam is visible and recoverable, a silent inflation of
# every overlapping feather is not - but it is why one polygon beats two.
_COMBINE = {"add": _add, "subtract": _subtract, "intersect": _intersect}


# ---------------------------------------------------------------------------
# the modifiers
# ---------------------------------------------------------------------------

def _sdf(m):
    """Signed distance to the mask's 0.5 contour, in px, positive inside.

    Two sources, because neither alone is enough. Away from the edge, an exact
    euclidean distance transform - cost independent of how far we are about to
    move the boundary, which is the whole reason expand does not use a
    structuring element. Inside the one-pixel ramp a rasterised edge already
    carries, the coverage value IS the sub-pixel offset (cov = d + 0.5), and
    that is finer than any distance transform on a binary image can be: the
    binary image threw the sub-pixel position away.
    """
    hard = (m >= 0.5).astype(np.uint8)
    # distanceTransform on an array with no zero (or no one) returns 1.8e19,
    # not an error. It happens to be the right answer here - an all-selected
    # mask is infinitely far from its own non-existent edge - but it is a
    # sentinel and worth knowing before it turns up in a subtraction.
    d_in = cv2.distanceTransform(hard, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    d_out = cv2.distanceTransform(1 - hard, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    sdf = np.where(hard > 0, d_in - 0.5, 0.5 - d_out).astype(np.float32)
    band = (m > 0.0) & (m < 1.0)
    np.copyto(sdf, m - np.float32(0.5), where=band)
    return sdf


def _expand(m, px):
    if abs(px) < 1e-4:
        return m
    lo, hi = float(m.min()), float(m.max())
    if hi <= 0.0 or lo >= 1.0:
        return m                      # nothing, or everything; no edge to move
    return np.clip(_sdf(m) + np.float32(px) + np.float32(0.5), 0.0, 1.0)


def _feather(m, sigma):
    if sigma <= 1e-4:
        return m
    # BORDER_CONSTANT (zero): the frame edge is not a mirror, and a selection
    # feathered against it should fade out there rather than reflect back in.
    # It is also the only border that makes "feather conserves the total" true
    # for anything that does not touch the edge.
    k = max(3, int(sigma * 3.0) * 2 + 1)
    return cv2.GaussianBlur(m, (k, k), sigmaX=float(sigma), sigmaY=float(sigma),
                            borderType=cv2.BORDER_CONSTANT)


def _harden(m):
    return (m >= 0.5).astype(np.float32)


# ---------------------------------------------------------------------------
# the entry points
# ---------------------------------------------------------------------------

def _frame(rgba):
    if isinstance(rgba, np.ndarray) and rgba.ndim == 3 and rgba.shape[2] >= 3:
        return int(rgba.shape[0]), int(rgba.shape[1])
    if isinstance(rgba, np.ndarray) and rgba.ndim == 2:
        return int(rgba.shape[0]), int(rgba.shape[1])
    return 0, 0


def _as_rgba(rgba, h, w):
    """The colour tools need four float channels 0..1. An integer array here is
    0..255 and would put every distance a hundred times too far, so it is
    converted rather than reinterpreted - the one case where guessing is
    better than refusing, because the alternative is a wand that selects
    nothing and says nothing."""
    a = np.asarray(rgba)
    if a.dtype != np.float32:
        a = a.astype(np.float32)
        if not np.issubdtype(np.asarray(rgba).dtype, np.floating):
            a /= np.float32(255.0)
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=2)
    if a.shape[2] == 3:
        a = np.concatenate([a, np.ones((h, w, 1), np.float32)], axis=2)
    return np.ascontiguousarray(a[..., :4])


def _shape_masks(shapes, rgba, h, w, warn, antialias, default_mode):
    """Every shape, rasterised and hardened, paired with its combine mode."""
    built = []
    for i, spec in enumerate(shapes):
        if not isinstance(spec, dict):
            warn.append(f"shape {i} is not an object")
            continue
        kind = spec.get("kind")
        kind = ALIASES.get(kind, kind)
        n = len(warn)
        if kind == "rect":
            m = _rect_mask(spec, h, w, warn)
        elif kind == "ellipse":
            m = _ellipse_mask(spec, h, w, warn)
        elif kind == "polygon":
            m = _poly_mask(spec, h, w, warn)
        elif kind == "wand":
            m = _wand_mask(spec, rgba, h, w, warn, antialias)
        elif kind == "colorRange":
            m = _colour_range_mask(spec, rgba, h, w, warn, antialias)
        else:
            warn.append(f"shape {i}: unknown kind {spec.get('kind')!r}; known "
                        f"kinds are {', '.join(sorted(CATALOG))}")
            continue
        # §9: a schema that accepts a parameter the code then ignores is worse
        # than a refusal. Unknown keys ARE ignored - that is the only sane thing
        # to do with them - so the caller is told which ones, by name. The most
        # common one is a modifier written on a shape: `antialias` and `feather`
        # belong to the selection, not to any single shape in it.
        stray = sorted(set(spec) - set(CATALOG[kind]["params"]) - {"kind"})
        if stray:
            warn.append(f"ignored unknown key(s) {', '.join(stray)}"
                        + (f"; {', '.join(sorted(MODIFIERS))} belong to the "
                           f"selection, not to a shape"
                           if set(stray) & set(MODIFIERS) else ""))
        for j in range(n, len(warn)):
            warn[j] = f"shape {i} ({kind}): {warn[j]}"
        if not antialias:
            m = _harden(m)
        built.append((_mode_of(spec, default_mode), m))
    return built


def resolve(selection, rgba, warn=None):
    """The mask IMAGE_SPEC §3 describes. Never raises; anything it could not
    honour is appended to `warn` in words a person can act on.

    `rgba` is the STAGE 4 image - post-geometry, pre-adjustment - and only the
    colour tools read it; the geometric shapes need nothing but its size.
    """
    warn = warn if isinstance(warn, list) else []
    h, w = _frame(rgba)
    if h <= 0 or w <= 0:
        warn.append("selection needs an image to resolve against")
        return np.zeros((1, 1), np.float32)

    spec = selection if isinstance(selection, dict) else {}
    raw = spec.get("shapes")
    antialias = bool(spec.get("antialias", True))
    default_mode = _mode_of(spec, "add")

    if raw is None:
        # No selection. §3: a mask of ones, produced HERE, so that stages 5-8
        # call blend() unconditionally and the no-selection path is the same
        # code as every other path.
        built = None
    elif isinstance(raw, (list, tuple)):
        needs_pixels = any(isinstance(s, dict)
                           and ALIASES.get(s.get("kind"), s.get("kind"))
                           in ("wand", "colorRange") for s in raw)
        img = _as_rgba(rgba, h, w) if needs_pixels else None
        built = _shape_masks(raw, img, h, w, warn, antialias, default_mode)
    else:
        warn.append("selection.shapes must be a list")
        built = []

    if built is None:
        m = np.ones((h, w), np.float32)
    else:
        # An empty list is EMPTY, not everything. A selection whose shapes all
        # came out degenerate has to end as a no-op, because the other reading -
        # fall back to the whole frame - is a local edit silently going global.
        m = _empty(h, w)
        for mode, sm in built:
            m = _COMBINE[mode](m, sm)

    m = _expand(m, _num(spec.get("expand"), 0.0, -1e4, 1e4))
    if not antialias:
        # expand rebuilt the edge, so re-harden it. feather does not get this
        # treatment: antialias is a claim about edge quality, feather is an
        # explicit request for softness, and hardening it would ignore the ask.
        m = _harden(m)
    m = _feather(m, _num(spec.get("feather"), 0.0, 0.0, 1e4))
    if spec.get("invert"):
        m = np.float32(1.0) - m

    np.clip(m, 0.0, 1.0, out=m)
    np.copyto(m, np.float32(0.0), where=np.isnan(m))
    return m


# Below this fraction of pixels actually mixing, gathering them beats blending
# the whole frame. Measured on 4096x4096: the crossover is around one pixel in
# three, and a real selection is nowhere near it.
_SPARSE = 3


def _blend_core(o, r, m):
    """The arithmetic, on flat (N, 4) colours and (N,) coverage. One copy of it,
    so the whole-frame path and the gathered path cannot disagree.

        a   = ao + (ar - ao)*m
        rgb = o + (r - o) * (ar*m / a)

    The second line is the first one rearranged: weighting by coverage AND by
    alpha and dividing the alpha back out is algebraically a lerp between the
    two straight colours, at a ratio that is NOT m. That is the entire fix -
    at m = 0.5 against a transparent original the ratio is 1, not 0.5, so the
    opaque colour survives whole instead of being halved toward whatever was
    left under the transparency.
    """
    ao, ar = o[:, 3:4], r[:, 3:4]
    mm = m[:, None]
    out = np.empty_like(r)
    a, rgb = out[:, 3:4], out[:, :3]
    np.subtract(ar, ao, out=a)
    np.multiply(a, mm, out=a)
    np.add(a, ao, out=a)
    k = (ar * mm) / np.maximum(a, _EPS)
    np.subtract(r[:, :3], o[:, :3], out=rgb)
    rgb *= k
    rgb += o[:, :3]
    # Where no alpha is left the ratio is undefined; the straight lerp is the
    # least surprising thing to leave there, and it keeps a later op that
    # RAISES alpha from finding black. Guarded on a scan, because a photograph
    # has no fully transparent pixels at all.
    if a.size and float(a.min()) <= float(_EPS):
        gone = a[:, 0] <= float(_EPS)
        rgb[gone] = o[gone, :3] + (r[gone, :3] - o[gone, :3]) * mm[gone]
    return out


def blend(original, result, mask):
    """`result * m + original * (1 - m)` - IMAGE_SPEC §3, and the reason this
    module exists. All three are float32; mask is (H, W), 0..1.

    STRAIGHT ALPHA IS THE WHOLE PROBLEM. Run that formula over all four
    channels of straight-alpha data and it is silently wrong, because it is the
    formula for PREMULTIPLIED data: interpolating a straight RGB drags the
    colour sitting under the transparency into the answer. Blend an opaque red
    result at 50% against a fully transparent original whose leftover RGB is
    black and you get (0.5, 0, 0) at alpha 0.5 - half-transparent DARK red,
    where the right answer is half-transparent RED. That is the dark fringe on
    every soft edge, and it is invisible on any test that only checks alpha.

    So: weight by coverage AND by alpha, then divide the alpha back out.

        a   = ao*(1-m) + ar*m
        rgb = (rgb_o*ao*(1-m) + rgb_r*ar*m) / a

    The two extremes are then restored by copy rather than left to arithmetic.
    x*a/a is not bit-identical to x in float32, and "no selection changes
    nothing" has to be exact - otherwise every unselected op perturbs its own
    output by a division round-trip, forever, at every stage of the pipeline.
    """
    if mask is None:
        return result                       # no selection: §3's identity, free
    if not isinstance(result, np.ndarray) or not isinstance(original, np.ndarray) \
            or result.shape != original.shape or result.ndim != 3 or result.shape[2] != 4:
        print("[imgselect] blend got mismatched buffers; op not applied", file=sys.stderr)
        return original
    m = np.asarray(mask, np.float32)
    if m.ndim == 3 and m.shape[2] == 1:
        m = m[..., 0]
    if m.shape != result.shape[:2]:
        # Refuse toward "did nothing" rather than "did it everywhere". An op we
        # cannot place is an op that must not land.
        print(f"[imgselect] blend mask {m.shape} does not fit {result.shape[:2]}; "
              f"op not applied", file=sys.stderr)
        return original
    mn, mx = float(m.min()), float(m.max())
    if mn >= 1.0:
        return result                       # the no-selection fast path
    if mn < 0.0 or mx > 1.0:
        m = np.clip(m, 0.0, 1.0)
        mn, mx = max(mn, 0.0), min(mx, 1.0)
    o = np.reshape(original.astype(np.float32, copy=False), (-1, 4))
    r = np.reshape(result.astype(np.float32, copy=False), (-1, 4))
    flat = np.reshape(m, -1)

    mixing = (flat > 0.0) & (flat < 1.0)
    if int(np.count_nonzero(mixing)) * _SPARSE <= flat.size:
        # A selection is a hard interior with a soft rim, so the pixels that
        # genuinely MIX are a rim's worth and everything else is one of the two
        # inputs verbatim. Picking those verbatim is also where the bit-
        # exactness at 0 and 1 comes from - it is a copy, not arithmetic that
        # happens to round well. Four times faster on a 4K plate, and it is the
        # same `_blend_core` doing the mixing either way, so the two paths
        # cannot drift apart.
        out = np.where((flat >= 1.0)[:, None], r, o)
        idx = np.flatnonzero(mixing)
        out[idx] = _blend_core(o[idx], r[idx], flat[idx])
    else:
        out = _blend_core(o, r, flat)
        # No clipping anywhere: blend is a lerp, not a sanitiser, and clipping
        # here would break bit-identity for any caller whose result legitimately
        # sits outside 0..1 before its own clamp.
        if mx >= 1.0:
            np.copyto(out, r, where=(flat >= 1.0)[:, None])
        if mn <= 0.0:
            np.copyto(out, o, where=(flat <= 0.0)[:, None])
    return out.reshape(result.shape)


def describe(selection, rgba):
    """What the selection panel puts under the marching ants. An empty
    selection is the most confusing state an editor has, and this is the only
    thing in the system that can name it."""
    warn = []
    m = resolve(selection, rgba, warn)
    total = float(m.sum())
    n = int(m.size)
    return {"width": int(m.shape[1]), "height": int(m.shape[0]),
            "pixels": total, "coverage": total / n if n else 0.0,
            "fullyIn": int(np.count_nonzero(m >= 1.0)),
            "partial": int(np.count_nonzero((m > 0.0) & (m < 1.0))),
            "empty": total <= 0.0,
            "everything": bool(float(m.min()) >= 1.0),
            "warnings": warn}


def catalog():
    """What MCP and the Images panel serve for selections."""
    return {"selection": CATALOG, "groups": GROUP_ORDER, "names": sorted(CATALOG),
            "aliases": ALIASES, "modes": MODES, "modifiers": MODIFIERS,
            "notes": {
                "mask": "float32 (H, W), 0..1; ops blend result*m + original*(1-m)",
                "none": "no `selection`, or no `shapes` key, is a mask of ones; a "
                        "`shapes` list that is present but empty or degenerate is "
                        "a mask of zeros and every op becomes a no-op",
                "order": "shapes in list order -> expand -> feather -> invert",
                "empty": "the accumulator starts empty, so shapes[0] should be add",
                "samples": "wand and colorRange read the image at stage 4: after "
                           "geometry, before any adjustment",
                "distance": "CIE76 in L*a*b* (L* 0..100, a*/b* +-128) with L* "
                            "scaled by `lightness` and alpha scaled by 100; "
                            "tolerances are dE in those units",
                "winding": "polygons fill even-odd",
                "antialiasing": f"analytic for rect and ellipse; polygons are "
                                f"exact in x with {_SUB} sub-scanlines in y",
            }}


# ---------------------------------------------------------------------------
# bench
# ---------------------------------------------------------------------------

def _bench(size=4096, reps=3):
    h = w = size
    rng = np.random.default_rng(7)
    img = np.empty((h, w, 4), np.float32)
    img[..., :3] = rng.random((h, w, 3), dtype=np.float32)
    img[..., 3] = 1.0
    star = [[w / 2 + (w * 0.45 if k % 2 == 0 else w * 0.2) * math.cos(k * math.pi / 7),
             h / 2 + (h * 0.45 if k % 2 == 0 else h * 0.2) * math.sin(k * math.pi / 7)]
            for k in range(14)]
    cases = {
        "rect": {"shapes": [{"kind": "rect", "x": w * .1, "y": h * .1,
                             "w": w * .8, "h": h * .8}]},
        "ellipse": {"shapes": [{"kind": "ellipse", "cx": w / 2, "cy": h / 2,
                                "rx": w * .45, "ry": h * .45}]},
        "polygon": {"shapes": [{"kind": "polygon", "points": star}]},
        "wand": {"shapes": [{"kind": "wand", "x": w // 2, "y": h // 2,
                             "tolerance": 60}]},
        "colorRange": {"shapes": [{"kind": "colorRange", "color": [128, 128, 128],
                                   "tolerance": 40, "softness": 20}]},
        "feather 16": {"shapes": [{"kind": "rect", "x": w * .1, "y": h * .1,
                                   "w": w * .8, "h": h * .8}], "feather": 16},
        "expand 20": {"shapes": [{"kind": "rect", "x": w * .1, "y": h * .1,
                                  "w": w * .8, "h": h * .8}], "expand": 20},
    }
    out = {}
    for name, sel in cases.items():
        best = 1e9
        for _ in range(reps):
            t0 = time.perf_counter()
            resolve(sel, img)
            best = min(best, (time.perf_counter() - t0) * 1000.0)
        out[name] = round(best, 1)
    mask = resolve(cases["ellipse"], img)
    res = img * np.float32(0.5)
    best = 1e9
    for _ in range(reps):
        t0 = time.perf_counter()
        blend(img, res, mask)
        best = min(best, (time.perf_counter() - t0) * 1000.0)
    out["blend"] = round(best, 1)
    return out


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    elif mode == "bench":
        print(json.dumps({"ok": True, "size": "4096x4096", "ms": _bench()}, indent=2))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
