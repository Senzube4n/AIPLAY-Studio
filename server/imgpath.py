"""Paths and Liquify - the pen tool, and the one retouching tool with no brush.

Two things Photoshop and Pixlr both have that this editor did not. They share a
file because they share a spine: a PATH in image pixels, walked and turned into
either coverage or displacement.

    PATHS (spec 6/8 - drawn where a shape is drawn)

        flatten(path, tol)            -> (N, 2) float64 polygon, and its closed flag
        path_area(path)               -> the EXACT area, in closed form
        path_length(path, tol)
        offset_path(path, amount, ..) -> the path pushed out along its normals
        stroke_outline(path, width..) -> the polygons whose union is the ink
        path_mask(spec, h, w)         -> float32 (H, W) 0..1 - a SELECTION
        draw_path / apply_paths       -> fill and/or stroke onto the image
        boolean_mask / boolean_paths  -> union, subtract, intersect, xor

    LIQUIFY (spec 5's brush class - a stroke arrives as a path)

        liquify(rgba, op, mask, freeze) -> the warped image
        liquify_field(shape, ...)       -> the displacement mesh alone
        warp(rgba, field)               -> sample once, straight alpha kept

Everything takes and returns float32 (H, W, 4), 0..1, **STRAIGHT alpha**, the
convention every column in docs/IMAGE_SPEC.md agrees on. `path_mask` returns
the other shape this editor knows: a float32 (H, W) 0..1 mask, exactly what
server/imgselect.py §3 defines, so a pen path IS a selection with no adapter in
between.

WHAT A PATH IS

    { "anchors": [ {"p": [x, y], "in": [dx, dy], "out": [dx, dy]}, ... ],
      "closed": true }

`in`/`out` are the handles, RELATIVE to their anchor (After Effects' convention
and the one server/vfx/shapes.py already reads); `"handles": "absolute"` on the
path switches them to SVG's. Four other spellings are accepted because a caller
will guess one of them: a point list, bare `[[x, y], ...]` or as
`{"points": [...], "closed": bool}` (all corners either way), AE's
`{vertices, inTangents, outTangents}`, an SVG `{"d": "M .. C .. Z"}`, and a
list of any of those. A path is OPEN unless it says otherwise; filling closes a
contour whatever the flag says, so it only decides what a STROKE draws. One
path is one contour, and a figure with holes is a LIST of paths under a rule.

FLATTENING, AND THE HALF PERCENT NOBODY NOTICED

Curves flatten by adaptive de Casteljau to `tolerance` px of chord error, the
same way shapes.py does it. That much is standard, and it is also SIGNED: every
chord lies inside its curve, so the polygon is inscribed and its area comes out
UNDER the true one, always. shapes.py's ellipse measures 0.41% under pi*a*b for
exactly this reason.

The fix is one pass of arithmetic. Area is LINEAR in each vertex - moving v[i]
by d changes it by exactly cross(d, v[i+1] - v[i-1]) / 2 - and the area the
flattening lost is computable in closed form per segment (`_cubic_area`, the
integral of the cubic, derived rather than remembered). So each vertex is
pushed out along its own normal by just enough to give its two neighbouring
chords their lost slivers back. Moving every vertex at once leaves a
second-order cross term, so it runs TWICE. What comes out is a polygon whose
area equals the curve's to between 1e-9 and 1e-15 depending on how many chords
there were - against 1.5e-2 for a 10 px circle and 4e-4 for a 200 px one
inscribed - whose worst deviation from the curve is 2/3 of what it was (it
straddles the curve rather than sagging inside it), and which is unchanged on
any segment that was already straight. `flatten(..., correct=False)` is the
inscribed one, and imgpath_test measures both.

That leaves ONE error in a flattened circle, and it is not this module's: four
cubics with the standard handle length k = 4(sqrt2 - 1)/3 enclose 1.00028 times
pi*r^2. A four-cubic circle is a 2.8e-4 approximation of a circle before
anything rasterises it, and no tolerance makes that number smaller.

BOOLEANS, HONESTLY

There is still no polygon clipper on this box. shapes.py's merge rasterises at
4x and traces back with findContours at a cost of about 1/8 px, and says so;
`boolean_paths` inherits that verbatim, because it has to hand back GEOMETRY.

`boolean_mask` does not, and is therefore EXACT. Every contour of every operand
crosses the same sub-scanline; the winding of each operand is accumulated
separately along that scanline and the operands are combined per SPAN, before
any pixel is touched. Union, subtract, intersect and xor all fall out of one
rasterisation with the analytic x-coverage intact - no 4x buffer, no threshold,
no retrace. Since a pen path exists to become a selection, that is the path
that matters, and it is the one with no compromise in it.

LIQUIFY, AND THE QUESTION THAT DECIDES WHETHER IT IS USABLE

Resampling an image is lossy, so the number of times you do it is the whole
design. Every dab of every stroke composes into ONE displacement field and the
image is sampled EXACTLY ONCE, at the end, from the original pixels:

    D_new(x) = d(x) + D_old(x + d(x))          # composition, not addition

That is what a real liquify mesh is. Adding the fields instead would be wrong
the moment two strokes overlap (the second would push the ORIGINAL pixels, not
the ones the first put there), and resampling per stroke would be right and
blurry - fifty strokes, fifty bilinear filters, and a face that has been
through a photocopier. Composing costs one remap of a 2-channel field over the
DAB's box, which is nothing, and the field is smooth so interpolating it is
accurate to about 0.001 px per composition.

The image is never touched outside the box the field actually moved, and inside
it, any pixel whose displacement is exactly zero is copied rather than sampled.
So a FROZEN pixel is bit-identical, a zero-strength liquify is bit-identical,
and 95% of a 2048 square is bit-identical after a brush stroke. That is a
guarantee of the code shape, not of cv2's interpolator.

Straight alpha is the other half. cv2.remap filters whatever four planes it is
handed, and filtering STRAIGHT colour mixes in the black that transparent
pixels happen to hold - the dark fringe on every edge that nobody can explain
later. So: premultiply, warp, un-premultiply. Forgetting the LAST step is the
failure mode, and it hides: it returns a picture that is merely too dark by its
own alpha. imgpath_test asserts both directions.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgpath.py catalog
    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgpath.py bench

numpy / cv2, and imagetools._blend - the one blend implementation, the same
arithmetic the compositor and the VFX effects use.
"""
# -- WIRING - what server/imagetools.py has to do, and it is all of it --------
#
#   1. With the other imports:
#
#          import imgpath
#
#   2. Stage 8, with the shapes - a path IS a shape, and drawing it after
#      imgshape keeps the reading order of the job (later draws on top):
#
#          if ops.get("paths"):
#              arr = imgpath.apply_paths(arr, ops["paths"], mask, notes)
#
#      `mask` is the stage-4 selection, float32 (H, W) 0..1, or None.
#
#   3. Stage 7, AFTER imgstroke.apply_strokes and before stage 8 - liquify
#      warps pixels, so everything drawn as vector must land on top of it, and
#      paint laid down in the same job is warped with the rest of the picture,
#      which is what a person watching the canvas expects:
#
#          if ops.get("liquify"):
#              spec = ops["liquify"]
#              frz = imgselect.resolve(spec.get("freeze"), arr) \
#                  if isinstance(spec, dict) and spec.get("freeze") else None
#              arr = imgpath.liquify(arr, spec, mask, freeze=frz, notes=notes)
#
#      The freeze mask is a SELECTION SPEC in the job and imgselect already
#      turns those into masks; resolving it there rather than here is the
#      reason this module has no second copy of that vocabulary. Pass the
#      resolved float32 (H, W) array.
#
#   4. `notes` is a list this module appends one-line strings to - the honest
#      report of a coordinate that was dropped, a parameter that is not in the
#      catalog, or a boolean that had to go through a raster. Put it in the
#      JSON result. Pass None and the same lines go to stderr, which is what
#      the CLI does.
#
#   5. A path selection. `imgpath.path_mask(spec, h, w)` returns exactly what
#      imgselect.resolve returns - float32 (H, W) 0..1 in post-geometry pixels
#      - so the Select column can add a `{"kind": "path", ...}` shape by
#      calling it, and stage 4 can equally take one directly:
#
#          mask = imgpath.path_mask(ops["selection"]["path"], h, w)
#
#      That mask is the FILL's own coverage, from the same rasteriser call, so
#      "select the path" and "fill the path" cannot drift apart.
#
#   6. server/index.js and server/mcp.js: serve `imgpath.catalog()` beside the
#      effect catalog, from `python server/imgpath.py catalog`. Every parameter
#      of every op is in there with type, range and default, so the MCP schema
#      and the UI panels are generated rather than typed.
#
#   7. Errors. A request that cannot be honoured AS WRITTEN raises PathError -
#      no paint on a path, an unknown liquify tool, a mask of the wrong shape.
#      A request that is legal but draws nothing (an empty point list, amount
#      0, a size under half a pixel) returns the input unchanged and says so in
#      `notes`. Let PathError reach the caller as `{ ok: false, error }`, the
#      same way imgshape.ShapeError already does.
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


FLATNESS = 0.25           # px of chord error allowed when flattening a curve
SAMPLES = 16              # vertical sub-scanlines per output row, as imgshape uses
_EPS = np.float32(1e-6)
_MAX_CROSSINGS = 40_000_000       # a runaway path must not eat the box
_MAX_DABS = 20_000                # nor a liquify stroke with a million points
_MAX_DEPTH = 20                   # de Casteljau recursion floor
_TWIRL = math.pi / 2.0            # radians at amount 1 under the dab's centre
_MAX_PINCH = 0.95                 # bloat/pucker cannot collapse a disc to a point

LINE_CAPS = ["butt", "round", "square"]
LINE_JOINS = ["miter", "round", "bevel"]
FILL_RULES = ["nonzero", "evenodd"]
BOOLEANS = ["none", "union", "subtract", "intersect", "xor"]
PRESSURE_MODES = ["both", "size", "amount", "off"]
INTERPOLATIONS = ["bilinear", "bicubic"]
_CV_INTERP = {"bilinear": cv2.INTER_LINEAR, "bicubic": cv2.INTER_CUBIC}

# The handle length that turns four cubics into a circle, to the 2.8e-4 the
# module docstring quotes. Written out rather than typed, because 0.5523 is
# close enough to draw a circle nobody questions and wrong enough to fail every
# area case below.
KAPPA = 4.0 * (math.sqrt(2.0) - 1.0) / 3.0


class PathError(ValueError):
    """A request that cannot be honoured as written. Raised, never swallowed:
    a caller that gets a silent no-op back has no way to learn what it did
    wrong, and spec §9 is explicit that a quiet wrong answer is the failure
    mode this codebase keeps shipping."""


# ---------------------------------------------------------------------------
# the catalog - MCP and the UI are both generated from this
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Path", "Paint", "Liquify"]

# An agent will guess these, and a guess that works is a round trip saved.
ALIASES = {
    "pen": "draw", "bezier": "draw", "path": "draw", "fill": "draw",
    "stroke": "draw", "outline": "draw",
    "selection": "mask", "toMask": "mask", "tomask": "mask", "select": "mask",
    "combine": "boolean", "merge": "boolean", "pathfinder": "boolean",
    "inset": "offset", "outset": "offset", "expand": "offset",
    "forward": "push", "warp": "push", "shift": "push", "smudgeMesh": "push",
    "grow": "bloat", "inflate": "bloat", "expandPixels": "bloat",
    "shrink": "pucker", "pinch": "pucker", "deflate": "pucker",
    "twirl": "twirlCW", "twirlClockwise": "twirlCW", "swirl": "twirlCW",
    "twirlCounterClockwise": "twirlCCW", "twirlCCw": "twirlCCW",
    "restore": "reconstruct", "undo": "reconstruct", "unwarp": "reconstruct",
}

LIQUIFY_TOOLS = ("push", "bloat", "pucker", "twirlCW", "twirlCCW", "reconstruct")


def num(default, lo, hi, desc, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": False, "desc": desc}
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


def col(desc, default=None):
    """RGBA 0-255, or null for 'no paint'. §9 of the spec is about this exact
    line: a 0..1 triple is a legal near-black, so it draws perfectly, the alpha
    is identical, every pixel-counting test passes, and only the picture is
    wrong."""
    return {"type": "color", "default": default, "min": 0, "max": 255,
            "animatable": False, "desc": desc}


def arr(default, desc):
    return {"type": "array", "default": list(default), "animatable": False, "desc": desc}


def geom(desc):
    return {"type": "path", "default": None, "animatable": False, "desc": desc}


def pointlist(desc):
    return {"type": "points", "default": [], "animatable": False, "desc": desc}


def op(name, label, group, why, params, where, **extra):
    """`where` is not decoration. Half this catalog is a member of ops.paths
    and half is a function the engine calls directly, and an agent reading a
    schema with no address on it posts the second kind into the first and gets
    a refusal it cannot learn from."""
    entry = {"label": label, "group": group, "why": why, "where": where,
             "params": params}
    entry.update(extra)
    CATALOG[name] = entry
    return entry


PATH_DESC = (
    "one path or a list of them. A path is {anchors: [{p:[x,y], in:[dx,dy], "
    "out:[dx,dy]}], closed: bool} with the handles RELATIVE to their anchor "
    "(set handles:'absolute' for SVG's convention). Also accepted: a bare "
    "point list [[x,y],...] for an all-corner path, the same thing as "
    "{points: [[x,y],...], closed: bool} or {points: [x0,y0,x1,y1,...]}, AE's "
    "{vertices, inTangents, outTangents, closed}, and an SVG {d: 'M0 0 C...Z'} "
    "with M L H V C S Q T A Z and their relative forms. Coordinates are image "
    "pixels: pixel (row i, col j) is the square [j, j+1) x [i, i+1). A path "
    "is OPEN unless it says closed:true (an SVG Z closes one). Filling "
    "closes a contour whatever the flag says, so it only decides what a "
    "stroke draws."
)
_TOL = num(FLATNESS, 0.005, 10.0,
           "chord error allowed when a curve is flattened, in px. The polygon "
           "is area-corrected afterwards, so this buys smoothness rather than "
           "area", unit="px")
_RULE = pick(FILL_RULES, "nonzero",
             "which side of a self-crossing is inside. They differ only where "
             "a path crosses itself or another path in the same list: nonzero "
             "fills a pentagram solid, evenodd leaves the pentagon in the "
             "middle of it as a hole")
_BOOL = pick(BOOLEANS, "none",
             "how the paths in the list combine. `none` treats them as one "
             "figure under the fill rule, which is how a letter O gets its "
             "hole. The other four are EXACT - each operand's winding is "
             "counted separately along the same scanline and the operands "
             "are combined per span, before any pixel exists. It shapes the "
             "FILL and the mask; a stroke still follows each input path, "
             "because the outline of a boolean is geometry and only "
             "`boolean_paths` can hand that back")

# ---- paths (stage 8) ------------------------------------------------------

op("draw", "Pen Path", "Paint",
   "Fill and/or stroke a bezier path. Fill goes down first, so the stroke sits "
   "on top of it the way every drawing program shows it. A path with neither "
   "is an error, not a no-op - spec §6, and the same rule imgshape enforces.",
   {"paths": geom(PATH_DESC),
    "fill": col("RGBA 0-255 for the interior, or null for no fill"),
    "fillRule": _RULE,
    "boolean": _BOOL,
    "stroke": col("RGBA 0-255 for the outline, or null for no stroke"),
    "strokeWidth": num(2, 0, 4000, "stroke width in px, CENTRED on the path - "
                                   "half of it falls either side", unit="px"),
    "cap": pick(LINE_CAPS, "butt", "what an open path's ends look like. A butt "
                                   "cap stops at the endpoint, which is why a "
                                   "butt stroke of width w over length L lays "
                                   "down exactly w*L of ink"),
    "join": pick(LINE_JOINS, "miter", "what a corner looks like"),
    "miterLimit": num(4, 1, 100, "a miter longer than this many half-widths "
                                 "falls back to a bevel, as SVG and AE do"),
    "dash": arr([], "dash pattern in px, [on, off, on, off, ...]. An odd-length "
                    "pattern repeats to make it even, as SVG does. Dashes cut "
                    "the path by ARC LENGTH, so a dashed circle's segments are "
                    "equal"),
    "dashOffset": num(0, -1e6, 1e6, "how far into the pattern the first dash "
                                    "starts", unit="px"),
    "blend": pick(BLEND_MODES, "normal", "how the paint meets the pixels under it"),
    "tolerance": _TOL},
   "one element of ops.paths (stage 8), drawn by "
   "imgpath.apply_paths(rgba, ops['paths'], mask, notes)",
   touchesAlpha=True)

op("mask", "Path to Selection", "Path",
   "The pen tool's reason to exist. Returns the float32 (H, W) 0..1 mask "
   "imgselect §3 defines - antialiased, in post-geometry pixels - from the "
   "SAME rasteriser call the fill uses, so the selected pixels and the filled "
   "ones are the same pixels by construction and not by agreement.",
   {"paths": geom(PATH_DESC), "fillRule": _RULE, "boolean": _BOOL,
    "tolerance": _TOL},
   "imgpath.path_mask(spec, height, width) - not a field of the job but a call "
   "the engine makes, to turn a path into the stage-4 selection")

op("offset", "Offset Path", "Path",
   "Push every point out along its corner bisector. Each vertex moves by "
   "amount / cos(half the turn) so the two offset EDGES meet where they should "
   "- offsetting along an averaged normal instead pinches every corner inward, "
   "which looks like a bug on a rectangle. Negative insets.",
   {"paths": geom(PATH_DESC),
    "amount": num(10, -4000, 4000, "px to grow by; negative shrinks", unit="px"),
    "join": pick(LINE_JOINS, "round", "what fills the wedge an outward corner "
                                      "opens up"),
    "miterLimit": num(4, 1, 100, "as above"),
    "tolerance": _TOL},
   "imgpath.offset_path(spec) -> polygons, or offset_path(path, amount, join, "
   "miterLimit, tolerance) from Python")

op("boolean", "Combine Paths", "Path",
   "Union, subtract, intersect or xor, returned as GEOMETRY. There is no "
   "polygon clipper in this environment, so this one rasterises at `resolution` "
   "x and traces back with findContours - about 1/8 px of error, inherited "
   "from vfx/shapes.py's merge, which measured it. `boolean_mask` and the "
   "`boolean` parameter of draw/mask do the same four ops EXACTLY, because a "
   "mask never has to become a polygon again. Prefer those.",
   {"paths": geom(PATH_DESC),
    "mode": pick([b for b in BOOLEANS if b != "none"], "union",
                 "applied left to right: the first path is the operand every "
                 "other one acts on"),
    "resolution": num(4, 1, 16, "supersampling of the round trip; 4 costs about "
                                "1/8 px", integer=True),
    "tolerance": _TOL},
   "imgpath.boolean_paths(spec) -> polygons. For a mask, "
   "imgpath.boolean_mask(paths, mode, height, width), which is exact")

# ---- liquify (stage 7) ----------------------------------------------------

_LIQ_PATH = ("the stroke in image pixels, [[x, y, pressure?], ...]; pressure "
             "0..1 defaults to 1, and {x, y, pressure} objects are accepted "
             "too. Dabs are laid along it by ARC LENGTH every spacing*size, "
             "exactly as imgstroke §5 walks a brush. A point with a NaN in it "
             "is dropped.")


def _liq(name, label, why, extra=None):
    p = {"points": pointlist(_LIQ_PATH),
         "size": num(200, 1, 8192, "brush diameter in px", unit="px"),
         "amount": num(0.5, 0, 1, "strength at the centre of the dab"),
         "hardness": num(0.5, 0, 1, "Photoshop calls it density: the warp is "
                                    "full strength out to hardness*radius and "
                                    "smoothsteps to nothing at the rim"),
         "spacing": num(0.25, 0.01, 4, "gap between dabs as a fraction of size"),
         "pressure": pick(PRESSURE_MODES, "both",
                          "what the third component of a point drives - size, "
                          "amount, both, or nothing")}
    if extra:
        p.update(extra)
    return op(name, label, "Liquify", why, p,
              "one element of ops.liquify.strokes (stage 7); the whole list "
              "goes to imgpath.liquify(rgba, ops['liquify'], mask, freeze)",
              touchesAlpha=True)


_liq("push", "Forward Warp",
     "Photoshop's forward warp. Each dab displaces the content under it by "
     "amount * falloff * THIS DAB'S STEP - the vector from the previous dab, "
     "spacing*size long - so at amount 1 the pixel under the cursor follows "
     "the cursor, and at 0.5 it follows at half speed. A single point is a "
     "click with no drag in it and moves nothing; that is not a bug.")
_liq("bloat", "Bloat",
     "Push content outward from the dab's centre, so what was under the brush "
     "grows. The displacement is proportional to the distance from the centre, "
     "which is what keeps the middle of a bloated eye from tearing.")
_liq("pucker", "Pucker",
     "The opposite: content is drawn inward toward the centre. Bloat and "
     "pucker at the same amount and the same place are near-inverses, but only "
     "near - a warp is not its own reciprocal. Use reconstruct to actually "
     "undo one.")
_liq("twirlCW", "Twirl Clockwise",
     "Rotate content around the dab's centre, clockwise ON SCREEN (y grows "
     "downward, so a pixel due east of the centre moves south). The angle is "
     "amount * falloff * 90 degrees per dab, so a stroke that dwells twirls "
     "further.")
_liq("twirlCCW", "Twirl Counter-Clockwise",
     "The same rotation the other way. Two entries rather than one signed "
     "amount because that is how the tool is reached in every editor that has "
     "it, and a negative amount is not a thing a slider can send.")
_liq("reconstruct", "Reconstruct",
     "Fade the accumulated displacement back toward zero under the brush - "
     "Photoshop's reconstruct tool. It works on the MESH, not on the pixels, "
     "so a fully reconstructed region is bit-identical to the original rather "
     "than being a warp of a warp. It only sees strokes in the same call.")


# ops.liquify is an OBJECT with three fields of its own, and none of them are
# a tool's parameter - so without this block the schema generator would emit
# every tool and silently lose the three knobs that wrap them.
LIQUIFY_ENVELOPE = {
    "strokes": {"type": "array", "default": [], "animatable": False,
                "desc": "the strokes, in order. They compose into ONE "
                        "displacement field and the image is resampled once, "
                        "so ten strokes cost ten stroke-walks and one "
                        "interpolation. A bare list is accepted in place of "
                        "this whole object."},
    "freeze": {"type": "selection", "default": None, "animatable": False,
               "desc": "a selection spec (imgselect §3) whose pixels the warp "
                       "may not move. The engine resolves it and passes the "
                       "mask; a spec that reaches this module raises rather "
                       "than being ignored, because an ignored freeze mask is "
                       "a warped face nobody asked for."},
    "interpolation": pick(INTERPOLATIONS, "bicubic",
                          "how the single resample samples. bicubic is sharper "
                          "and can ring; bilinear is softer and cannot"),
}


def catalog():
    """What MCP and /api/image/catalog serve for paths and liquify."""
    return {
        "ops": CATALOG,
        "groups": GROUP_ORDER,
        "names": sorted(CATALOG),
        "liquifyTools": list(LIQUIFY_TOOLS),
        "liquifyEnvelope": LIQUIFY_ENVELOPE,
        "aliases": ALIASES,
        "notes": [
            "Colours are RGBA 0-255. A three-element colour gets alpha 255, "
            "and null means 'no paint'.",
            "Coordinates are image pixels with (0,0) at the top-left CORNER of "
            "the top-left pixel, so pixel j spans [j, j+1) and its centre is "
            "j+0.5. A path drawn through [10.5, 20.5] passes through the "
            "middle of pixel (20, 10).",
            "`draw` is one element of ops.paths (stage 8, with the shapes). "
            "The liquify tools are the `tool` of one element of "
            "ops.liquify.strokes (stage 7, after the brushes).",
            "ops.liquify may be a bare list of strokes or {strokes, freeze, "
            "interpolation}. ALL of its strokes compose into one displacement "
            "field and the image is resampled exactly ONCE - that is the "
            "difference between liquify and fifty passes of a warp filter.",
            "ops.liquify.freeze is a SELECTION SPEC (imgselect §3); the engine "
            "resolves it and passes the mask in. Frozen pixels come back "
            "bit-identical, and so does everything the field never moved.",
            "The selection mask scales the displacement rather than "
            "cross-fading the warped result with the original: cross-fading "
            "two versions of the same content ghosts it. Where the mask is 0 "
            "or 1 the two are identical, and 0 is bit-identical.",
            "A path with neither fill nor stroke raises, as a shape does.",
            "Booleans inside `draw`, `mask` and boolean_mask are exact. "
            "`boolean`, which hands back geometry, goes through a raster and "
            "costs about 1/8 px - there is no polygon clipper here.",
            "Flattening is area-corrected: the polygon's area matches the "
            "curve's rather than sitting under it. Four cubics are still only "
            "a 2.8e-4 approximation of a circle, which no tolerance fixes.",
        ],
    }


# ---------------------------------------------------------------------------
# shared plumbing
# ---------------------------------------------------------------------------

def _note(msg, notes=None):
    """One honest line about something dropped or approximated. The caller that
    passes a list gets it in the job result; everyone else gets it on stderr,
    because the failure this module must never have is the quiet one."""
    if notes is None:
        print(f"[imgpath] {msg}", file=sys.stderr)
    else:
        notes.append(msg)


def _f(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float(default)
    return f if math.isfinite(f) else float(default)


def _valid(rgba):
    return (isinstance(rgba, np.ndarray) and rgba.ndim == 3 and rgba.shape[2] == 4
            and np.issubdtype(rgba.dtype, np.floating)
            and rgba.shape[0] > 0 and rgba.shape[1] > 0)


def _own(rgba):
    """A float32 (H, W, 4) buffer that is OURS to draw on."""
    return np.array(rgba, dtype=np.float32, copy=True)


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


def _xy_list(v, notes=None, where=""):
    """(N, 2) float64 from [[x,y],...] or the flat [x0,y0,x1,y1,...] form. A
    point with a NaN in it is DROPPED and said so - it has no position, and
    inventing one is how a stray coordinate becomes a shape nobody asked for."""
    if v is None:
        return np.zeros((0, 2), np.float64)
    seq = list(v) if isinstance(v, (list, tuple, np.ndarray)) else []
    if seq and all(isinstance(p, (int, float, np.floating, np.integer)) for p in seq):
        seq = [seq[i:i + 2] for i in range(0, len(seq) - 1, 2)]
    out, dropped = [], 0
    for p in seq:
        if isinstance(p, dict):
            p = [p.get("x"), p.get("y")]
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError, KeyError):
            dropped += 1
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            dropped += 1
            continue
        out.append((x, y))
    if dropped:
        _note(f"{where}dropped {dropped} point(s) that were not finite numbers", notes)
    return np.asarray(out, np.float64).reshape(-1, 2)


def _stroke_points(raw, notes=None, where=""):
    """(N, 3) float64 of [x, y, pressure], imgstroke's path shape verbatim."""
    out = []
    for p in (raw if isinstance(raw, (list, tuple, np.ndarray)) else []):
        if isinstance(p, dict):
            p = [p.get("x"), p.get("y"), p.get("pressure", p.get("p", 1.0))]
        if not isinstance(p, (list, tuple, np.ndarray)) or len(p) < 2:
            continue
        try:
            x, y = float(p[0]), float(p[1])
            pr = float(p[2]) if len(p) > 2 and p[2] is not None else 1.0
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if not math.isfinite(pr):
            pr = 1.0
        out.append((x, y, min(1.0, max(0.0, pr))))
    return np.asarray(out, np.float64).reshape(-1, 3)


# An item may BE its own path - {"points": [...], "fill": [...]} is the shape a
# caller writes first - so the path grammar's own keys are not "unknown
# parameters" and must not be reported as such.
_NOT_PARAMS = {"kind", "type", "tool", "path", "paths", "anchors", "vertices",
               "inTangents", "outTangents", "closed", "d", "handles", "points"}


def _coerce(spec, src, where="", notes=None):
    """Every value a body below sees has been through here: unknown keys are
    REPORTED rather than silently dropped (spec §9: rebuilding an object from a
    key list has cost this codebase five features), missing ones take the
    catalog default, and everything else is clamped to the advertised range."""
    src = src if isinstance(src, dict) else {}
    extra = sorted(set(src) - set(spec) - _NOT_PARAMS)
    if extra:
        _note(f"{where}ignoring parameter(s) not in the catalog: {', '.join(extra)}",
              notes)
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
            v = _stroke_points(v, notes, f"{where}{key}: ")
        elif kind == "array":
            try:
                v = [_f(x, 0.0) for x in list(v)]
            except TypeError:
                _note(f"{where}{key}={v!r} is not a list; ignored", notes)
                v = list(p["default"])
        # "path" passes through untouched - _paths_of is its coercion, and it
        # is the one parameter whose shape is a whole grammar.
        out[key] = v
    return out


# ---------------------------------------------------------------------------
# the path grammar
# ---------------------------------------------------------------------------

class Bez:
    """One contour: anchors with ABSOLUTE handle positions.

    `a` is (N, 6) - anchor x, y then the in-handle and out-handle as points on
    the plane rather than offsets. Absolute internally because every operation
    below (transform, subdivide, measure) is then the same arithmetic on all
    three, and the relative form only exists at the JSON boundary.
    """
    __slots__ = ("a", "closed")

    def __init__(self, a, closed=True):
        self.a = np.asarray(a, dtype=np.float64).reshape(-1, 6)
        self.closed = bool(closed)

    def __len__(self):
        return len(self.a)

    def segments(self):
        """[(p0, p1, p2, p3), ...] - one cubic per segment, in order."""
        n = len(self.a)
        if n < 2:
            return []
        last = n if self.closed else n - 1
        out = []
        for i in range(last):
            j = (i + 1) % n
            out.append((self.a[i, 0:2], self.a[i, 4:6], self.a[j, 2:4], self.a[j, 0:2]))
        return out


def _bez_from_points(pts, closed):
    """An all-corner path: every handle sits on its own anchor, which is what
    makes its segments straight lines and its `_cubic_area` exact."""
    p = np.asarray(pts, np.float64).reshape(-1, 2)
    a = np.hstack([p, p, p])
    return Bez(a, closed)


def _handles(spec, anchors, notes, where):
    """Relative (AE, the default) or absolute (SVG) handle convention."""
    mode = spec.get("handles", "relative")
    if mode not in ("relative", "absolute"):
        _note(f"{where}handles={mode!r} is not 'relative' or 'absolute'; "
              f"reading them as relative", notes)
        mode = "relative"
    if mode == "relative":
        anchors[:, 2:4] += anchors[:, 0:2]
        anchors[:, 4:6] += anchors[:, 0:2]
    return anchors


def _bez_from_anchors(spec, notes, where):
    raw = spec.get("anchors")
    if not isinstance(raw, (list, tuple)) or not raw:
        return None
    rows, dropped = [], 0
    for item in raw:
        if isinstance(item, (list, tuple, np.ndarray)) and len(item) >= 2 \
                and not isinstance(item[0], (list, tuple)):
            item = {"p": [item[0], item[1]]}
        if not isinstance(item, dict):
            dropped += 1
            continue
        p = item.get("p", item.get("point", item.get("v")))
        if p is None and "x" in item and "y" in item:
            p = [item["x"], item["y"]]
        pt = _xy_list([p], notes, where)
        if len(pt) == 0:
            dropped += 1
            continue
        tin = _xy_list([item.get("in", item.get("inTangent", [0.0, 0.0]))], notes, where)
        tout = _xy_list([item.get("out", item.get("outTangent", [0.0, 0.0]))],
                        notes, where)
        tin = tin[0] if len(tin) else np.zeros(2)
        tout = tout[0] if len(tout) else np.zeros(2)
        rows.append([pt[0, 0], pt[0, 1], tin[0], tin[1], tout[0], tout[1]])
    if dropped:
        _note(f"{where}dropped {dropped} anchor(s) with no usable position", notes)
    if len(rows) < 2:
        return None
    a = _handles(spec, np.asarray(rows, np.float64), notes, where)
    return Bez(a, bool(spec.get("closed", False)))


def _bez_from_ae(spec, notes, where):
    """AE's {vertices, inTangents, outTangents} - the shape vfx/shapes.py reads,
    so a path written for a shape layer arrives here already correct."""
    verts = _xy_list(spec.get("vertices"), notes, where)
    if len(verts) < 2:
        return None
    n = len(verts)
    a = np.zeros((n, 6), np.float64)
    a[:, 0:2] = verts
    for key, col_ in (("inTangents", 2), ("outTangents", 4)):
        t = spec.get(key)
        t = _xy_list(t, notes, where) if t is not None else np.zeros((0, 2))
        if len(t):
            a[:min(n, len(t)), col_:col_ + 2] = t[:n]
    return Bez(_handles(spec, a, notes, where), bool(spec.get("closed", False)))


# -- SVG path data ----------------------------------------------------------

def _svg_tokens(d):
    """Command letters and numbers. SVG path data is not whitespace-delimited:
    `10-20` is two numbers, `.5.5` is two numbers, and `1e-5` is one - so a
    naive split is wrong three ways and this walks it a character at a time."""
    out, num_, i, n = [], "", 0, len(d)

    def flush():
        nonlocal num_
        if num_:
            try:
                out.append(float(num_))
            except ValueError:
                raise PathError(f"{num_!r} is not a number, in path data")
            num_ = ""

    while i < n:
        c = d[i]
        # `e` is a letter, so this test HAS to come before isalpha() - otherwise
        # 1e2 tokenises as the number 1, a command `e`, and the number 2, and
        # the path silently lands somewhere plausible a hundred times too close
        # to the origin.
        if c in "eE" and num_ and (num_[-1].isdigit() or num_[-1] == "."):
            num_ += c
        elif c.isalpha():
            flush()
            out.append(c)
        elif c in "+-":
            if num_ and num_[-1] in "eE":
                num_ += c                     # the exponent's own sign
            else:
                flush()
                num_ = c
        elif c == ".":
            if "." in num_ or "e" in num_ or "E" in num_:
                flush()                       # .5.5 is two numbers
            num_ += c
        elif c.isdigit():
            num_ += c
        elif c in ", \t\r\n":
            flush()
        else:
            raise PathError(f"unexpected character {c!r} in path data")
        i += 1
    flush()
    return out


def _svg_arc(cur, rx, ry, phi, large, sweep, end):
    """Endpoint parameterisation to centre, then cubics. F.6 of the SVG spec,
    including the radius correction, because a too-small radius is what a
    rounded rectangle exported at the wrong scale sends."""
    x1, y1 = cur
    x2, y2 = end
    if rx == 0 or ry == 0 or (abs(x1 - x2) < 1e-12 and abs(y1 - y2) < 1e-12):
        return [(end, end, end)] if (x1 != x2 or y1 != y2) else []
    rx, ry = abs(rx), abs(ry)
    cp, sp = math.cos(phi), math.sin(phi)
    dx2, dy2 = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    x1p, y1p = cp * dx2 + sp * dy2, -sp * dx2 + cp * dy2
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1.0:
        s = math.sqrt(lam)
        rx, ry = rx * s, ry * s
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    numr = max(0.0, rx * rx * ry * ry - den)
    co = math.sqrt(numr / den) if den > 0 else 0.0
    if large == sweep:
        co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (x1 + x2) / 2.0
    cy = sp * cxp + cp * cyp + (y1 + y2) / 2.0

    def ang(ux, uy, vx, vy):
        d = math.hypot(ux, uy) * math.hypot(vx, vy)
        c = 0.0 if d == 0 else max(-1.0, min(1.0, (ux * vx + uy * vy) / d))
        a = math.acos(c)
        return -a if (ux * vy - uy * vx) < 0 else a

    th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry,
              (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dth > 0:
        dth -= 2 * math.pi
    elif sweep and dth < 0:
        dth += 2 * math.pi
    # A quarter turn per cubic keeps every piece inside the 2.8e-4 that k buys.
    n = max(1, int(math.ceil(abs(dth) / (math.pi / 2.0))))
    segs = []
    for i in range(n):
        a0 = th1 + dth * i / n
        a1 = th1 + dth * (i + 1) / n
        k = 4.0 / 3.0 * math.tan((a1 - a0) / 4.0)

        def pt(t):
            return (cx + rx * math.cos(t) * cp - ry * math.sin(t) * sp,
                    cy + rx * math.cos(t) * sp + ry * math.sin(t) * cp)

        def dpt(t):
            return (-rx * math.sin(t) * cp - ry * math.cos(t) * sp,
                    -rx * math.sin(t) * sp + ry * math.cos(t) * cp)

        p0, p3 = pt(a0), pt(a1)
        d0, d3 = dpt(a0), dpt(a1)
        segs.append(((p0[0] + k * d0[0], p0[1] + k * d0[1]),
                     (p3[0] - k * d3[0], p3[1] - k * d3[1]), p3))
    return segs


def _bez_from_d(d, notes, where):
    """SVG path data -> a list of Bez. M starts a subpath, Z closes one."""
    toks = _svg_tokens(str(d))
    paths, rows, closed = [], [], False
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    prev_c2 = None                       # for S/s
    prev_q = None                        # for T/t
    cmd = None
    i = 0

    def flush():
        nonlocal rows, closed
        if len(rows) >= 2:
            if closed and math.dist(rows[0][:2], rows[-1][:2]) < 1e-9:
                # Z back onto the first anchor: keep the handle it arrived with.
                rows[0][2:4] = rows[-1][2:4]
                rows.pop()
            paths.append(Bez(np.asarray(rows, np.float64), closed))
        rows, closed = [], False

    def anchor(p):
        rows.append([p[0], p[1], p[0], p[1], p[0], p[1]])

    def curve_to(c1, c2, p):
        if rows:
            rows[-1][4:6] = c1
        anchor(p)
        rows[-1][2:4] = c2

    while i < len(toks):
        t = toks[i]
        if isinstance(t, str):
            cmd = t
            i += 1
            if cmd in "Zz":
                closed = True
                flush()
                cur = start
                continue
        elif cmd is None:
            raise PathError("path data must start with a command letter")
        elif cmd in "Mm":
            cmd = "L" if cmd == "M" else "l"       # implicit lineto after moveto
        rel = cmd.islower()
        c = cmd.upper()
        need = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2,
                "A": 7}.get(c)
        if need is None:
            raise PathError(f"unknown path command {cmd!r}")
        if i + need > len(toks) or any(isinstance(x, str) for x in toks[i:i + need]):
            raise PathError(f"path command {cmd!r} wants {need} numbers")
        v = [float(x) for x in toks[i:i + need]]
        i += need
        if c == "M":
            flush()
            cur = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
            start = cur
            anchor(cur)
            prev_c2 = prev_q = None
            continue
        if c in "LHV":
            if c == "L":
                p = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
            elif c == "H":
                p = (cur[0] + v[0], cur[1]) if rel else (v[0], cur[1])
            else:
                p = (cur[0], cur[1] + v[0]) if rel else (cur[0], v[0])
            if not rows:
                anchor(cur)
            anchor(p)
            cur, prev_c2, prev_q = p, None, None
            continue
        if not rows:
            anchor(cur)
        if c in "CS":
            if c == "C":
                c1 = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
                c2 = (cur[0] + v[2], cur[1] + v[3]) if rel else (v[2], v[3])
                p = (cur[0] + v[4], cur[1] + v[5]) if rel else (v[4], v[5])
            else:
                c1 = cur if prev_c2 is None else (2 * cur[0] - prev_c2[0],
                                                  2 * cur[1] - prev_c2[1])
                c2 = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
                p = (cur[0] + v[2], cur[1] + v[3]) if rel else (v[2], v[3])
            curve_to(c1, c2, p)
            cur, prev_c2, prev_q = p, c2, None
        elif c in "QT":
            if c == "Q":
                q = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
                p = (cur[0] + v[2], cur[1] + v[3]) if rel else (v[2], v[3])
            else:
                q = cur if prev_q is None else (2 * cur[0] - prev_q[0],
                                                2 * cur[1] - prev_q[1])
                p = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
            # A quadratic IS a cubic with its handles at 2/3 of the way to the
            # control point - exactly, not approximately.
            c1 = (cur[0] + 2.0 / 3.0 * (q[0] - cur[0]), cur[1] + 2.0 / 3.0 * (q[1] - cur[1]))
            c2 = (p[0] + 2.0 / 3.0 * (q[0] - p[0]), p[1] + 2.0 / 3.0 * (q[1] - p[1]))
            curve_to(c1, c2, p)
            cur, prev_c2, prev_q = p, c2, q
        else:                                              # A
            p = (cur[0] + v[5], cur[1] + v[6]) if rel else (v[5], v[6])
            for c1, c2, end in _svg_arc(cur, v[0], v[1], math.radians(v[2]),
                                        bool(v[3]), bool(v[4]), p):
                curve_to(c1, c2, end)
                cur = end
            cur, prev_c2, prev_q = p, None, None
    flush()
    if not paths:
        _note(f"{where}path data drew nothing", notes)
    return paths


def _one_path(spec, notes, where):
    if isinstance(spec, Bez):
        return [spec]
    if isinstance(spec, dict):
        if spec.get("d"):
            return _bez_from_d(spec["d"], notes, where)
        b = _bez_from_anchors(spec, notes, where)
        if b is not None:
            return [b]
        b = _bez_from_ae(spec, notes, where)
        if b is not None:
            return [b]
        pts = _xy_list(spec.get("points"), notes, where)
        if len(pts) >= 2:
            return [_bez_from_points(pts, bool(spec.get("closed", False)))]
        return []
    pts = _xy_list(spec, notes, where)
    if len(pts) >= 2:
        # OPEN, like every other spelling. Filling closes a contour whatever
        # this says, so the flag only decides what a STROKE does - and a bare
        # list of three points that quietly grew a third side would be a
        # surprise in the one place a caller cannot see it coming.
        return [_bez_from_points(pts, False)]
    return []


def _paths_of(spec, notes=None, where=""):
    """Every accepted spelling of "a path" -> a list of Bez. The one place the
    grammar lives, so draw, mask, offset and boolean cannot disagree on it."""
    if spec is None:
        return []
    if isinstance(spec, (list, tuple)) and spec and (
            isinstance(spec[0], (dict, Bez))
            or (isinstance(spec[0], (list, tuple, np.ndarray))
                and len(spec[0]) and isinstance(spec[0][0], (list, tuple, np.ndarray)))):
        out = []
        for s in spec:
            out.extend(_one_path(s, notes, where))
        return out
    return _one_path(spec, notes, where)


def _geometry_of(spec):
    """Where an op's geometry lives: `paths`, `path`, or the item itself. An
    item that IS a path - {"points": [...], "fill": [...]} - is the first thing
    a caller writes, and refusing it teaches nothing."""
    if isinstance(spec, dict):
        for key in ("paths", "path"):
            if spec.get(key) is not None:
                return spec[key]
    return spec


def circle_path(cx, cy, r):
    """The four-cubic circle, k = 4(sqrt2-1)/3. Handed out because a caller
    that wants a round path should not have to remember k, and because every
    area case in imgpath_test is an argument about this exact figure."""
    k = KAPPA * float(r)
    p = [(cx + r, cy), (cx, cy + r), (cx - r, cy), (cx, cy - r)]
    t = [(0.0, k), (-k, 0.0), (0.0, -k), (k, 0.0)]
    a = [[p[i][0], p[i][1], p[i][0] - t[i][0], p[i][1] - t[i][1],
          p[i][0] + t[i][0], p[i][1] + t[i][1]] for i in range(4)]
    return Bez(np.asarray(a, np.float64), True)


# ---------------------------------------------------------------------------
# flattening - and the area it is not allowed to lose
# ---------------------------------------------------------------------------

def _cubic_area(p0, p1, p2, p3):
    """0.5 * integral over one cubic of (x y' - y x') dt - its contribution to
    Green's theorem, in closed form and EXACT.

    Derived rather than looked up. In the power basis x = a0 + a1 t + a2 t^2 +
    a3 t^3, the integrand's t^(i+j-1) term has coefficient j(a_i b_j - b_i a_j),
    and integrating over [0, 1] divides by (i + j); pairing (i, j) with (j, i)
    collapses the double sum to one term per unordered pair with weight
    (j - i)/(i + j). Six pairs, six weights, no quadrature.
    """
    a0, b0 = p0[0], p0[1]
    a1, b1 = 3.0 * (p1[0] - p0[0]), 3.0 * (p1[1] - p0[1])
    a2, b2 = 3.0 * (p2[0] - 2.0 * p1[0] + p0[0]), 3.0 * (p2[1] - 2.0 * p1[1] + p0[1])
    a3 = p3[0] - 3.0 * p2[0] + 3.0 * p1[0] - p0[0]
    b3 = p3[1] - 3.0 * p2[1] + 3.0 * p1[1] - p0[1]
    return 0.5 * ((a0 * b1 - b0 * a1) + (a0 * b2 - b0 * a2) + (a0 * b3 - b0 * a3)
                  + (a1 * b2 - b1 * a2) / 3.0 + (a1 * b3 - b1 * a3) / 2.0
                  + (a2 * b3 - b2 * a3) / 5.0)


def _flat_enough(p0, p1, p2, p3, tol):
    dx, dy = p3[0] - p0[0], p3[1] - p0[1]
    n = math.hypot(dx, dy)
    if n < 1e-12:
        return (math.hypot(p1[0] - p0[0], p1[1] - p0[1]) <= tol
                and math.hypot(p2[0] - p0[0], p2[1] - p0[1]) <= tol)
    d1 = abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / n
    d2 = abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / n
    return max(d1, d2) <= tol


def _flatten_cubic(p0, p1, p2, p3, tol, out, lost, depth=0):
    """Recursive de Casteljau to a chord-error tolerance, recording the SLIVER
    each chord cuts off. Adaptive because a fixed step is wrong twice: faceted
    on a big curve, wasteful on a small one."""
    if depth >= _MAX_DEPTH or _flat_enough(p0, p1, p2, p3, tol):
        out.append((p3[0], p3[1]))
        # The lens between curve and chord: the curve's own integral plus the
        # chord's, which closes the loop. Zero for a straight segment, which is
        # why a rectangle's corners never move.
        lost.append(_cubic_area(p0, p1, p2, p3)
                    + 0.5 * (p3[0] * p0[1] - p0[0] * p3[1]))
        return
    m01 = ((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5)
    m12 = ((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5)
    m23 = ((p2[0] + p3[0]) * 0.5, (p2[1] + p3[1]) * 0.5)
    a = ((m01[0] + m12[0]) * 0.5, (m01[1] + m12[1]) * 0.5)
    b = ((m12[0] + m23[0]) * 0.5, (m12[1] + m23[1]) * 0.5)
    mid = ((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)
    _flatten_cubic(p0, m01, a, mid, tol, out, lost, depth + 1)
    _flatten_cubic(mid, b, m23, p3, tol, out, lost, depth + 1)


def _poly_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _balance(p, lost, closed, tol):
    """Give every chord the sliver it cut off back, by moving its endpoints.

    Area is exactly linear in each vertex, so moving v[i] along the normal of
    (v[i+1] - v[i-1]) by 2D/|v[i+1] - v[i-1]| adds exactly D. Doing that to
    every vertex at once leaves a second-order cross term - each vertex's
    lever arm moved too - so it runs twice, the second pass distributing
    whatever is left over in proportion to the first. What lands is a polygon
    with the curve's area rather than an inscribed one, and it is BALANCED
    about the curve instead of always inside it, so the worst deviation drops
    to about 2/3 as well.

    The cap is the safety rail: a vertex whose neighbours nearly coincide has
    no usable lever arm, and 4 * tol is far beyond the (2/3) * sagitta a smooth
    curve ever asks for.
    """
    n = len(p)
    if n < 3 or not closed:
        # An open path encloses nothing; there is no area to conserve and the
        # endpoints have no neighbours to take a normal from.
        return p
    d = 0.5 * (np.roll(lost, 1) + lost)
    target = _poly_area(p) + float(lost.sum())
    cap = max(4.0 * tol, 1e-9)
    for _ in range(2):
        w = np.roll(p, -1, axis=0) - np.roll(p, 1, axis=0)
        wl = np.hypot(w[:, 0], w[:, 1])
        ok = wl > 1e-9
        if not ok.any():
            break
        step = np.zeros_like(p)
        delta = np.zeros(n)
        delta[ok] = np.clip(2.0 * d[ok] / wl[ok], -cap, cap)
        step[ok, 0] = w[ok, 1] / wl[ok] * delta[ok]
        step[ok, 1] = -w[ok, 0] / wl[ok] * delta[ok]
        p = p + step
        residual = target - _poly_area(p)
        weight = np.abs(d)
        s = float(weight.sum())
        if s <= 1e-12:
            break
        d = weight / s * residual
    return p


def flatten(path, tol=FLATNESS, correct=True, notes=None):
    """One path -> ((N, 2) float64, closed). The polygon is area-corrected
    unless `correct` is False, which is the plain inscribed flattening and is
    kept because imgpath_test measures the difference."""
    paths = _paths_of(path, notes, "flatten: ")
    if not paths:
        return np.zeros((0, 2), np.float64), False
    if len(paths) > 1:
        _note("flatten: got several paths and returned the first; use "
              "flatten_all for a figure with holes", notes)
    return _flatten_one(paths[0], tol, correct)


def _flatten_one(bez, tol, correct=True):
    tol = max(1e-3, float(tol))
    segs = bez.segments()
    if not segs:
        return np.zeros((0, 2), np.float64), bez.closed
    pts = [(segs[0][0][0], segs[0][0][1])]
    lost = []
    for p0, p1, p2, p3 in segs:
        _flatten_cubic(p0, p1, p2, p3, tol, pts, lost)
    p = np.asarray(pts, np.float64)
    lost = np.asarray(lost, np.float64)
    if bez.closed and len(p) > 1 and math.dist(p[0], p[-1]) < 1e-9:
        p = p[:-1]                       # the closing point IS the first one
    if correct and len(p) == len(lost):
        p = _balance(p, lost, bez.closed, tol)
    return p, bez.closed


def flatten_all(path, tol=FLATNESS, correct=True, notes=None):
    """Every contour of a figure -> [((N, 2), closed), ...]."""
    return [_flatten_one(b, tol, correct)
            for b in _paths_of(path, notes, "flatten: ")]


def path_area(path, notes=None):
    """The EXACT signed area a path encloses, in closed form - no flattening,
    no tolerance. Positive is clockwise on screen, because y grows downward.

    An open path is measured as though a straight line closed it, which is what
    filling one does."""
    total = 0.0
    for b in _paths_of(path, notes, "area: "):
        for p0, p1, p2, p3 in b.segments():
            total += _cubic_area(p0, p1, p2, p3)
        if not b.closed and len(b) >= 2:
            p0, p3 = b.a[-1, 0:2], b.a[0, 0:2]
            total += 0.5 * (p0[0] * p3[1] - p3[0] * p0[1])
    return total


def path_length(path, tol=FLATNESS, notes=None):
    """Arc length of the flattened path, which is the length anything that
    walks it (a dash pattern, a stroke) actually sees."""
    total = 0.0
    for p, closed in flatten_all(path, tol, True, notes):
        if len(p) < 2:
            continue
        d = np.diff(np.vstack([p, p[:1]]) if closed else p, axis=0)
        total += float(np.hypot(d[:, 0], d[:, 1]).sum())
    return total


# ---------------------------------------------------------------------------
# the rasteriser - exact in x, supersampled in y, and boolean per SPAN
# ---------------------------------------------------------------------------
#
# Sub-scanline n samples y = (n + 0.5) / SAMPLES, so output row r averages
# sub-scanlines r*S .. r*S+S-1. Horizontal coverage is ANALYTIC: a span from
# x=3.2 to x=5.7 deposits exactly 0.8, 1.0, 0.7, whatever the geometry, because
# each span end is deposited into a difference array with a fractional weight
# and the row's cumulative sum turns those into true covered area. Only the
# crossing list grows with S, never the pixel work - a plain SxS supersample
# would be S^2 the memory for a WORSE number in x. The trade is that a
# near-horizontal edge quantises to 1/S of a pixel while a near-vertical one is
# exact, which is the same trade imgselect and vfx/shapes make.
#
# The one thing here that is not in either of those: OPERANDS. Each contour
# carries a group id, every group's winding is accumulated along the same
# sorted crossing list, and the boolean is evaluated per span before a pixel
# exists. That is why boolean_mask needs no clipper and loses nothing.

def _bbox(groups, w, h, pad=1.0):
    lo = np.array([np.inf, np.inf])
    hi = np.array([-np.inf, -np.inf])
    for contours in groups:
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
    return x0, y0, x1 - x0, y1 - y0


def _combine(ins, mode):
    """One boolean per span from one insideness per operand."""
    if len(ins) == 1:
        return ins[0]
    if mode == "subtract":
        out = ins[0].copy()
        for m in ins[1:]:
            out &= ~m
        return out
    if mode == "intersect":
        out = ins[0].copy()
        for m in ins[1:]:
            out &= m
        return out
    if mode == "xor":
        out = ins[0].copy()
        for m in ins[1:]:
            out ^= m
        return out
    out = ins[0].copy()                                    # union, and the default
    for m in ins[1:]:
        out |= m
    return out


def _rasterize(groups, rules, mode, x0, y0, bw, bh, samples=SAMPLES):
    """Coverage of a set of operands over a bw x bh box at (x0, y0).

    `groups[i]` is a list of closed contours, `rules[i]` its fill rule, and
    `mode` how the operands combine ("none" for one figure)."""
    if bw <= 0 or bh <= 0:
        return None
    S = max(1, int(samples))
    ex0, ey0, ex1, ey1, gid = [], [], [], [], []
    for g, contours in enumerate(groups):
        for c in contours:
            if len(c) < 3:
                continue
            p = np.asarray(c, dtype=np.float64)
            q = np.roll(p, -1, axis=0)
            ex0.append(p[:, 0] - x0)
            ey0.append(p[:, 1] - y0)
            ex1.append(q[:, 0] - x0)
            ey1.append(q[:, 1] - y0)
            gid.append(np.full(len(p), g, np.int64))
    if not ex0:
        return None
    ex0 = np.concatenate(ex0)
    ey0 = np.concatenate(ey0)
    ex1 = np.concatenate(ex1)
    ey1 = np.concatenate(ey1)
    gid = np.concatenate(gid)

    ylo = np.minimum(ey0, ey1)
    yhi = np.maximum(ey0, ey1)
    lim = bh * S
    k0 = np.clip(np.ceil(ylo * S - 0.5), 0, lim).astype(np.int64)
    k1 = np.clip(np.ceil(yhi * S - 0.5), 0, lim).astype(np.int64)
    n = np.maximum(k1 - k0, 0)
    total = int(n.sum())
    if total <= 0:
        return np.zeros((bh, bw), np.float32)
    if total > _MAX_CROSSINGS:
        raise PathError(f"this path needs {total} scanline crossings, over the "
                        f"{_MAX_CROSSINGS} cap - flatten it at a coarser "
                        f"tolerance or draw it smaller")

    offs = np.concatenate(([0], np.cumsum(n)))
    eidx = np.repeat(np.arange(len(n)), n)
    kk = np.repeat(k0, n) + (np.arange(total) - np.repeat(offs[:-1], n))
    y = (kk + 0.5) / S
    dy = ey1[eidx] - ey0[eidx]
    xc = ex0[eidx] + (y - ey0[eidx]) * (ex1[eidx] - ex0[eidx]) / dy
    dirn = np.where(dy > 0, 1, -1).astype(np.int64)
    gg = gid[eidx]

    order = np.lexsort((xc, kk))
    kk, xc, dirn, gg = kk[order], xc[order], dirn[order], gg[order]

    starts = np.flatnonzero(np.r_[True, kk[1:] != kk[:-1]])
    row_len = np.diff(np.r_[starts, total])
    ins = []
    for g, rule in enumerate(rules):
        if rule == "evenodd":
            csum = np.cumsum((gg == g).astype(np.int64))
            prev = np.where(starts > 0, csum[np.maximum(starts - 1, 0)], 0)
            ins.append(((csum - np.repeat(prev, row_len)) & 1) == 1)
        else:
            csum = np.cumsum(np.where(gg == g, dirn, 0))
            prev = np.where(starts > 0, csum[np.maximum(starts - 1, 0)], 0)
            ins.append((csum - np.repeat(prev, row_len)) != 0)
    inside = _combine(ins, mode)

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
    base = rows * (bw + 2)
    idxs = np.concatenate([base + ia, base + ia + 1, base + ib, base + ib + 1])
    wts = np.concatenate([1.0 - (xa - ia), xa - ia, -(1.0 - (xb - ib)), -(xb - ib)])
    acc = np.bincount(idxs, weights=wts, minlength=bh * (bw + 2))[:bh * (bw + 2)]
    cov = np.cumsum(acc.reshape(bh, bw + 2), axis=1)[:, :bw] / S
    return np.clip(cov, 0.0, 1.0).astype(np.float32)


# ---------------------------------------------------------------------------
# stroke geometry
# ---------------------------------------------------------------------------

def _signed_area(pts):
    return _poly_area(np.asarray(pts, np.float64))


def _orient(pts, positive=True):
    return pts if (_signed_area(pts) >= 0) == positive else pts[::-1]


def _seg_lengths(pts, closed):
    d = np.diff(np.vstack([pts, pts[:1]]) if closed else pts, axis=0)
    return np.hypot(d[:, 0], d[:, 1])


def _circle_poly(cx, cy, r, tol):
    """A round cap or join. The radius is grown by the factor that makes the
    n-gon's area exactly pi*r^2 rather than the inscribed n*sin(2pi/n)*r^2/2 -
    the same one-signed error `_balance` fixes on a flattened curve, in the one
    place a curve is not flattened. It is why a round-capped stroke measures
    w*L + pi*w^2/4 and not slightly under it."""
    r = max(float(r), 1e-9)
    if tol >= r:
        n = 8
    else:
        step = 2.0 * math.acos(max(-1.0, min(1.0, 1.0 - tol / r)))
        n = max(8, int(math.ceil(2.0 * math.pi / max(step, 1e-6))))
    a = np.linspace(0, 2 * math.pi, n, endpoint=False)
    r = r * math.sqrt(2.0 * math.pi / (n * math.sin(2.0 * math.pi / n)))
    return np.stack([cx + r * np.cos(a), cy + r * np.sin(a)], axis=1)


def stroke_outline(pts, closed, width, cap="butt", join="miter", miter_limit=4.0,
                   tol=FLATNESS):
    """The polygons whose NONZERO union is the stroked line.

    Every piece - segment quads, join wedges, caps - is emitted with the same
    winding, and a nonzero fill of same-wound overlapping polygons is exactly
    their union. That is why this is built from quads rather than from
    offset_path(+w/2) and offset_path(-w/2): a two-sided offset self-intersects
    on any turn tighter than the width and the resulting figure-eight fills
    itself inside out, while the union of quads cannot. No clipping, no seams,
    and a miter limit that means what it says.
    """
    hw = float(width) / 2.0
    p = np.asarray(pts, np.float64).reshape(-1, 2)
    if hw <= 0 or len(p) < 1:
        return []
    ring = np.vstack([p, p[:1]]) if closed else p
    polys, segs = [], []
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
    if not segs:
        # A path that collapsed to a point still draws under a round cap - the
        # dot you get by clicking once with a round brush.
        return [_circle_poly(p[0, 0], p[0, 1], hw, tol)] if cap == "round" else []

    for k in range(len(segs) - (0 if closed else 1)):
        a0, b0, u0 = segs[k]
        a1, b1, u1 = segs[(k + 1) % len(segs)]
        v = b0
        cross = u0[0] * u1[1] - u0[1] * u1[0]
        if abs(cross) < 1e-12 and float(np.dot(u0, u1)) > 0:
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
            bn = float(np.linalg.norm(bis))
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
    return [_orient(q, True) for q in polys if abs(_signed_area(q)) > 1e-12]


def _resample_range(pts, closed, lo, hi):
    """The piece of a polyline between two fractions of its arc length."""
    lens = _seg_lengths(pts, closed)
    total = float(lens.sum())
    if total <= 1e-12:
        return None
    acc = np.concatenate(([0.0], np.cumsum(lens)))
    ring = np.vstack([pts, pts[:1]]) if closed else pts
    a, b = lo * total, hi * total
    if b <= a:
        return None

    def at(d):
        i = int(np.searchsorted(acc, d, side="right") - 1)
        i = max(0, min(i, len(lens) - 1))
        t = 0.0 if lens[i] <= 1e-12 else (d - acc[i]) / lens[i]
        return ring[i] + (ring[i + 1] - ring[i]) * t

    out = [at(a)]
    for i in range(len(acc)):
        if a < acc[i] < b:
            out.append(ring[i])
    out.append(at(b))
    return np.asarray(out, np.float64)


def _dash_split(pts, closed, pattern, offset):
    """Cut a contour into dashes by ARC LENGTH. Returns open polylines."""
    pat = [abs(x) for x in pattern if math.isfinite(x)]
    while pat and pat[-1] == 0:
        pat.pop()
    if len(pat) < 2 or sum(pat) <= 1e-6:
        return [(pts, closed)]
    if len(pat) % 2:
        pat = pat + pat                              # odd patterns repeat, as SVG does
    period = sum(pat)
    total = float(_seg_lengths(pts, closed).sum())
    if total <= 1e-9:
        return []
    out = []
    d = -(offset % period)
    on, i = True, 0
    while d < total:
        step = pat[i % len(pat)]
        a, b = d, d + step
        if on and b > 0:
            piece = _resample_range(pts, closed, max(a, 0.0) / total,
                                    min(b, total) / total)
            if piece is not None and len(piece) >= 2:
                out.append((piece, False))
        d = b
        on = not on
        i += 1
    return out


def _join_wedge(v, n_in, n_out, join, tol):
    if join == "bevel":
        return [tuple(v + n_in), tuple(v + n_out)]
    r = float(np.linalg.norm(n_in))
    a0 = math.atan2(n_in[1], n_in[0])
    a1 = math.atan2(n_out[1], n_out[0])
    while a1 - a0 > math.pi:
        a1 -= 2 * math.pi
    while a1 - a0 < -math.pi:
        a1 += 2 * math.pi
    steps = max(1, int(math.ceil(abs(a1 - a0) / max(2.0 * math.acos(
        max(-1.0, min(1.0, 1.0 - tol / max(r, 1e-9)))), 1e-6))))
    return [(v[0] + r * math.cos(a), v[1] + r * math.sin(a))
            for a in np.linspace(a0, a1, steps + 1)]


def offset_path(path, amount=None, join="round", miter_limit=4.0, tol=FLATNESS,
                notes=None):
    """Push a path out along its corner bisectors. -> [(N, 2), ...] polygons.

    Takes either the catalog's spec - offset_path({"paths": .., "amount": -20,
    "join": "round"}) - or the positional form. Both, because the catalog
    advertises those parameter names and a schema whose spelling the code does
    not accept is the same broken promise as one it ignores.

    Each vertex moves by amount / cos(half the turn) so the two offset EDGES
    meet where they should; offsetting along an averaged normal instead pinches
    every corner inward, which reads as a bug on a rectangle. Outward corners
    open a wedge, filled by the chosen join, and a miter past the limit falls
    back to a bevel - the same rule a stroke follows.

    Outward is the side the winding says, so a contour wound the other way (a
    hole) shrinks as its outline grows, which is what "offset" means on a
    figure with holes.
    """
    if amount is None:
        p = _coerce(CATALOG["offset"]["params"], path, "offset: ", notes)
        amount, join = p["amount"], p["join"]
        miter_limit, tol = p["miterLimit"], p["tolerance"]
        path = _geometry_of(path)
    out = []
    for pts, closed in flatten_all(path, tol, True, notes):
        amt = float(amount)
        m = len(pts)
        if m < 2:
            continue
        if abs(amt) < 1e-9:
            out.append(pts)
            continue
        sign = -1.0 if (closed and _signed_area(pts) > 0) else 1.0
        d = np.diff(np.vstack([pts, pts[:1]]), axis=0)
        ln = np.hypot(d[:, 0], d[:, 1])[:, None]
        u = d / np.maximum(ln, 1e-12)
        nrm = np.stack([-u[:, 1], u[:, 0]], axis=1) * (amt * sign)
        f = amt * sign
        joined = []
        for i in range(m):
            j = (i - 1) % m
            n_in, n_out = nrm[j], nrm[i]
            if not closed and i == 0:
                n_in = n_out
            if not closed and i == m - 1:
                n_out = n_in
            bis = n_in + n_out
            bn = float(np.linalg.norm(bis))
            if bn < 1e-9:
                joined.append(tuple(pts[i] + n_in))
                continue
            cos_half = bn / (2.0 * max(abs(amt), 1e-12))
            cross = float(u[j][0] * u[i][1] - u[j][1] * u[i][0])
            # Only a corner that turns AWAY from the offset direction opens a
            # gap; on the other one the two offset edges cross, where a wedge
            # would bulge outward instead of filling anything.
            opens = cross * f < 0 and abs(cross) > 1e-9
            if opens and join != "miter" and abs(amt) > tol:
                joined.extend(_join_wedge(pts[i], n_in, n_out, join, tol))
            elif opens and (1.0 / max(cos_half, 1e-9)) > miter_limit:
                joined.extend([tuple(pts[i] + n_in), tuple(pts[i] + n_out)])
            else:
                joined.append(tuple(pts[i] + bis / bn * (abs(amt) / max(cos_half, 1e-9))))
        out.append(np.asarray(joined, np.float64))
    return out


# ---------------------------------------------------------------------------
# coverage - the one call fill, stroke and selection all go through
# ---------------------------------------------------------------------------

def _fill_groups(paths, tol, mode):
    """Operands for the rasteriser: one group per path under a boolean, all
    contours in one group otherwise (so a figure's holes work by fill rule)."""
    flat = [_flatten_one(b, tol, True) for b in paths]
    contours = [p for p, _ in flat if len(p) >= 3]
    if not contours:
        return []
    if mode == "none":
        return [contours]
    return [[c] for c in contours]


def _stroke_contours(paths, p, tol):
    contours = []
    for pts, closed in flatten_all(paths, tol, True):
        if len(pts) < 2:
            continue
        for piece, pc in _dash_split(pts, closed, p["dash"], p["dashOffset"]):
            contours.extend(stroke_outline(piece, pc, p["strokeWidth"], p["cap"],
                                           p["join"], p["miterLimit"], tol))
    return contours


def path_mask(spec, height, width, notes=None):
    """A path as a SELECTION: float32 (H, W) 0..1, antialiased, in image
    pixels. Exactly the array imgselect.resolve returns, which is the point -
    the pen tool exists so that a curve can become a selection.

    This is the fill's own coverage from the same `_rasterize` call, so "what
    the path selects" and "what the path fills" are the same pixels by
    construction. imgpath_test asserts they are bit-identical."""
    try:
        h, w = int(height), int(width)
    except (TypeError, ValueError):
        # A mask has to be the size of the image it multiplies, and there is no
        # sane default for that - guessing one would hand back a mask that is
        # the wrong shape everywhere it is used.
        raise PathError(f"a mask needs the image's height and width, got "
                        f"{width!r}x{height!r}")
    if h <= 0 or w <= 0:
        raise PathError(f"a mask needs a positive size, got {width}x{height}")
    src = spec if isinstance(spec, dict) else {"paths": spec}
    p = _coerce(CATALOG["mask"]["params"], src, "mask: ", notes)
    paths = _paths_of(_geometry_of(src), notes, "mask: ")
    out = np.zeros((h, w), np.float32)
    if not paths:
        _note("mask: no usable path; the selection is empty", notes)
        return out
    groups = _fill_groups(paths, p["tolerance"], p["boolean"])
    if not groups:
        return out
    box = _bbox(groups, w, h)
    if box is None:
        _note(f"mask: the path is entirely outside the {w}x{h} image", notes)
        return out
    x0, y0, bw, bh = box
    cov = _rasterize(groups, [p["fillRule"]] * len(groups), p["boolean"],
                     x0, y0, bw, bh)
    if cov is not None:
        out[y0:y0 + bh, x0:x0 + bw] = cov
    return out


def boolean_mask(paths, mode="union", height=None, width=None, rule="nonzero",
                 tol=FLATNESS, notes=None):
    """Union / subtract / intersect / xor, EXACTLY, as a mask.

    The operands' windings are counted separately along one shared crossing
    list and combined per span, so the antialiased edge of the result is the
    true coverage of the boolean and not two coverages multiplied together.
    a*b, the compositing shortcut, is only right where both edges are hard."""
    if mode not in BOOLEANS or mode == "none":
        raise PathError(f"boolean mode {mode!r} must be one of "
                        f"{[b for b in BOOLEANS if b != 'none']}")
    return path_mask({"paths": paths, "boolean": mode, "fillRule": rule,
                      "tolerance": tol}, height, width, notes)


def boolean_paths(spec, notes=None):
    """The same four ops, returned as GEOMETRY - and this one is a compromise.

    There is no polygon clipper in this environment, and the winding-rule
    shortcut everyone reaches for (orient the subtracted contours backwards and
    fill nonzero) is simply WRONG once two subtracted shapes overlap: their
    windings add to -2, which is still nonzero, so the hole fills back in. So
    this rasterises at `resolution` x, thresholds, and traces back with
    findContours, which costs about 1/8 px - the same trade vfx/shapes.py's
    merge measured and wrote down, inherited rather than re-invented.

    If what you want is a mask, use boolean_mask: it has none of this in it.
    """
    src = spec if isinstance(spec, dict) else {"paths": spec}
    p = _coerce(CATALOG["boolean"]["params"], src, "boolean: ", notes)
    paths = _paths_of(_geometry_of(src), notes, "boolean: ")
    flat = [c for c, _ in flatten_all(paths, p["tolerance"], True, notes) if len(c) >= 3]
    if len(flat) < 2:
        return flat
    res = int(p["resolution"])
    allpts = np.vstack(flat)
    x0, y0 = np.floor(allpts.min(axis=0) - 2.0)
    x1, y1 = np.ceil(allpts.max(axis=0) + 2.0)
    bw, bh = int((x1 - x0) * res), int((y1 - y0) * res)
    if bw <= 0 or bh <= 0 or bw * bh > 80_000_000:
        raise PathError(f"a {bw}x{bh} raster is too big for a boolean; lower "
                        f"`resolution` or draw the paths smaller")
    groups = [[(c - np.array([x0, y0])) * res] for c in flat]
    acc = _rasterize(groups, ["nonzero"] * len(groups), p["mode"], 0, 0, bw, bh, 2)
    if acc is None:
        return []
    _note(f"boolean: {p['mode']} resolved through a {res}x raster and retraced, "
          f"which costs about {0.5 / res:.2f} px on the outline - there is no "
          f"polygon clipper here. boolean_mask is exact.", notes)
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
        # Holes wound the other way, so a nonzero fill of the result keeps them.
        out.append(_orient(pts, positive=not hole))
    return out


# ---------------------------------------------------------------------------
# compositing - straight alpha, and the divide is the whole point
# ---------------------------------------------------------------------------

def _premul(rgba):
    out = np.array(rgba, dtype=np.float32, copy=True)
    out[..., :3] *= out[..., 3:4]
    return out


def _unpremul(pm):
    """Straight alpha back out. The clamp on the divisor keeps a pixel whose
    alpha rounded to 1e-9 from exploding into whatever colour the ratio of two
    denormals happens to be; below that alpha the colour carries nothing."""
    a = np.clip(pm[..., 3], 0.0, 1.0)
    out = np.empty(pm.shape, np.float32)
    out[..., :3] = np.clip(pm[..., :3] / np.maximum(a, _EPS)[..., None], 0.0, 1.0)
    out[..., 3] = a
    np.copyto(out, 0.0, where=np.isnan(out))
    return out


def _over(base, src_rgb, src_a, mode):
    """Source-over onto STRAIGHT alpha, with the blend mode weighted by the
    backdrop's own alpha the way the compositing spec says.

    The same arithmetic as imgshape's private `_over`, and deliberately not
    imported from it: ten lines that a path and a rectangle must agree on
    forever are safer copied than coupled to another column's private name.
    imgpath_test asserts the two agree on random pixels, which is the only
    version of "they agree" worth having."""
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
    """spec §3's `result * m + original * (1 - m)`, done PREMULTIPLIED.

    The literal reading of that line mixes straight colour, and mixing straight
    colour across an alpha difference drags the colour of the transparent side
    into the result: half-masking an opaque red shape onto an empty canvas
    gives 50% DARK red rather than 50% red, because black is what a transparent
    pixel's RGB happens to hold."""
    if m is None:
        return drawn
    w = m[..., None]
    a = drawn[..., 3:4] * w + base[..., 3:4] * (1.0 - w)
    pm = (drawn[..., :3] * drawn[..., 3:4]) * w + (base[..., :3] * base[..., 3:4]) * (1.0 - w)
    out = np.empty(base.shape, np.float32)
    out[..., :3] = np.clip(pm / np.maximum(a, _EPS), 0.0, 1.0)
    out[..., 3:4] = np.clip(a, 0.0, 1.0)
    return out


def _as_mask(mask, h, w, what="selection mask"):
    """None means all ones. §3 asks for that to be implemented rather than
    branched, and it is - once, here - because a real ones array is 16MB at
    2048 square and every path in the list would pay for it.

    A mask of the WRONG SHAPE raises rather than being treated as absent:
    absent means "the whole frame", which is precisely the damage the caller
    was trying to prevent by sending one."""
    if mask is None:
        return None
    m = np.asarray(mask)
    if m.ndim == 3 and m.shape[2] == 1:
        m = m[..., 0]
    if m.ndim != 2 or m.shape != (h, w):
        raise PathError(f"{what} is {getattr(m, 'shape', None)}, the image is "
                        f"({h}, {w}) - stage 4 resolves masks in post-geometry "
                        f"pixels, so these must match")
    return np.clip(np.nan_to_num(m.astype(np.float32), nan=0.0), 0.0, 1.0)


def _paint(img, cov, rx, ry, color, blend, mask):
    """One coverage field, one colour, onto the image. Only the region the path
    touches is read or written - and when that region is mostly empty, only the
    pixels the path actually reaches, because a stroke's bounding box is the
    whole figure while its ink is a thin ring."""
    if cov is None or cov.size == 0 or color is None:
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
        drawn = _over(base, np.broadcast_to(rgb, (n, 3)), cov[hit] * float(color[3]),
                      blend)
        region[hit] = drawn if sub is None else _mask_lerp(base, drawn, sub[hit])
        return img
    drawn = _over(region, np.broadcast_to(rgb, (rh, rw, 3)), cov * float(color[3]),
                  blend)
    img[ry:ry + rh, rx:rx + rw] = _mask_lerp(region, drawn, sub)
    return img


def draw_path(rgba, spec, mask=None, notes=None):
    """One path item - fill and/or stroke - onto a COPY of the image. spec §6.

    Raises PathError when the request cannot be honoured as written: no paint,
    no usable geometry, a mask of the wrong shape. Everything numeric is
    coerced first, and none of that raises - a NaN coordinate is dropped and
    reported, a colour out of range is clamped."""
    if not _valid(rgba):
        raise PathError("paths need float32 (H, W, 4) 0..1 RGBA")
    img = _own(rgba)
    return _draw(img, spec, _as_mask(mask, img.shape[0], img.shape[1]), notes)


def _draw(img, spec, m, notes):
    """The body of draw_path, on an array that is already ours and a mask that
    is already checked. Split out because apply_paths draws ten items on one
    buffer, and copying the image ten times to protect the caller from a buffer
    it never had is 670MB of memcpy at 2048 square."""
    src = spec if isinstance(spec, dict) else {"paths": spec}
    p = _coerce(CATALOG["draw"]["params"], src, "draw: ", notes)
    paths = _paths_of(_geometry_of(src), notes, "draw: ")
    if p["fill"] is None and p["stroke"] is None:
        # spec §6, verbatim: "A shape with neither fill nor stroke is an error,
        # not a no-op."
        raise PathError("this path has neither fill nor stroke")
    if not paths:
        raise PathError("no usable path: expected anchors, points, vertices or d")
    h, w = img.shape[:2]

    if p["fill"] is not None:
        groups = _fill_groups(paths, p["tolerance"], p["boolean"])
        box = _bbox(groups, w, h) if groups else None
        if box is not None:
            x0, y0, bw, bh = box
            cov = _rasterize(groups, [p["fillRule"]] * len(groups), p["boolean"],
                             x0, y0, bw, bh)
            _paint(img, cov, x0, y0, p["fill"], p["blend"], m)
    if p["stroke"] is not None and p["strokeWidth"] > 0:
        contours = _stroke_contours(paths, p, p["tolerance"])
        box = _bbox([contours], w, h) if contours else None
        if box is not None:
            x0, y0, bw, bh = box
            cov = _rasterize([contours], ["nonzero"], "none", x0, y0, bw, bh)
            _paint(img, cov, x0, y0, p["stroke"], p["blend"], m)
    return img


def apply_paths(rgba, items, mask=None, notes=None):
    """Stage 8: the path items in the order given, each seeing what the last
    one left. One copy of the image for the whole list."""
    if not _valid(rgba):
        raise PathError("paths need float32 (H, W, 4) 0..1 RGBA")
    seq = items if isinstance(items, (list, tuple)) else [items]
    img = _own(rgba)
    m = _as_mask(mask, img.shape[0], img.shape[1])
    for it in seq:
        _draw(img, it, m, notes)
    return img


# ---------------------------------------------------------------------------
# liquify
# ---------------------------------------------------------------------------

def _profile(d, radius, hardness):
    """k(r): 1 out to hardness*radius, smoothstep to 0 at the rim - imgstroke's
    falloff verbatim, so a liquify brush and a paint brush of the same size and
    hardness cover the same pixels. The band is held open to at least one pixel
    even at hardness 1, because a disc thresholded at a radius is aliased and
    every diagonal shows it."""
    outer = float(radius)
    inner = outer * float(hardness)
    if outer - inner < 1.0:
        inner = outer - 1.0
    if inner < 0.0:
        inner = 0.0
    band = outer - inner
    if band <= 1e-6:
        return (d <= outer).astype(np.float32)
    t = np.clip((d - inner) * np.float32(1.0 / band), 0.0, 1.0)
    return (1.0 - t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _walk(pts, size, spacing, mode):
    """Dabs along the path by ARC LENGTH: [(x, y, radius, scale, stepx, stepy)].

    imgstroke's walk, plus the STEP - the vector from the previous dab, which
    is what forward warp displaces by. The step is recomputed from the dab just
    laid down, so a tapering tip stays dense instead of thinning into dots."""
    scale_size = mode in ("size", "both")
    scale_amt = mode in ("amount", "both")
    out = []
    prev_xy = [None]

    def dab(x, y, pr):
        r = 0.5 * size * (pr if scale_size else 1.0)
        if prev_xy[0] is None:
            sx = sy = 0.0
        else:
            sx, sy = x - prev_xy[0][0], y - prev_xy[0][1]
        prev_xy[0] = (x, y)
        out.append((x, y, r, pr if scale_amt else 1.0, sx, sy))
        # 0.75px is the floor: a vanishing tip must not ask for a million dabs.
        return max(0.75, spacing * max(2.0 * r, 0.5))

    need = dab(pts[0][0], pts[0][1], pts[0][2])
    prev = pts[0]
    acc = 0.0
    for q in pts[1:]:
        dx, dy = q[0] - prev[0], q[1] - prev[1]
        seg = math.hypot(dx, dy)
        if seg < 1e-9:
            prev = q
            continue
        travelled = 0.0
        while acc + (seg - travelled) >= need:
            travelled += need - acc
            u = travelled / seg
            need = dab(prev[0] + dx * u, prev[1] + dy * u,
                       prev[2] + (q[2] - prev[2]) * u)
            acc = 0.0
            if len(out) >= _MAX_DABS:
                return out
        acc += seg - travelled
        prev = q
    return out


def _dab_displacement(tool, xs, ys, k, sx, sy):
    """The BACKWARD map offset for one dab: out(x) = src(x + d(x)).

    Backward is why every sign here reads inverted. To move the content under
    the cursor toward +v, the pixel that lands at x has to be fetched from
    x - v, so d = -v. Getting this backwards produces a warp that works
    perfectly and pushes the wrong way, which is the kind of bug that survives
    a code review and dies in a click test."""
    if tool == "push":
        return -k * sx, -k * sy
    if tool in ("bloat", "pucker"):
        s = np.minimum(k, _MAX_PINCH)
        # Bloat samples from nearer the centre, so content spreads outward.
        f = -s if tool == "bloat" else s
        return f * xs, f * ys
    ang = k * _TWIRL * (1.0 if tool == "twirlCW" else -1.0)
    ca, sa = np.cos(ang), np.sin(ang)
    # M(-ang) applied to the offset, so the CONTENT turns by +ang, which with y
    # downward is clockwise on screen.
    return ca * xs + sa * ys - xs, -sa * xs + ca * ys - ys


def liquify_field(shape, spec, mask=None, freeze=None, notes=None):
    """The displacement mesh for a whole list of strokes: float32 (H, W, 2).

    `field[y, x]` is the offset ADDED to (x, y) before sampling the original,
    so a zero entry means "this pixel did not move" and the warp can copy it
    verbatim. Dabs COMPOSE - `d(x) + D(x + d(x))` - rather than adding, which
    is what makes the second stroke push the pixels the first one moved instead
    of the ones that used to be there.

    `mask` (the stage-4 selection) and `freeze` both scale each dab's
    displacement, freeze inverted. Scaling the displacement rather than
    cross-fading the warped result is deliberate: cross-fading two versions of
    the same content ghosts it, and where the mask is 0 or 1 the two agree
    exactly. A pixel the mask fully excludes therefore has a displacement of
    exactly 0, which is what makes it bit-identical downstream."""
    h, w = int(shape[0]), int(shape[1])
    if h <= 0 or w <= 0:
        raise PathError(f"a field needs a positive size, got {shape}")
    strokes, _ = _liquify_spec(spec)
    if freeze is None and isinstance(spec, dict) and spec.get("freeze") is not None:
        if isinstance(spec["freeze"], np.ndarray):
            freeze = spec["freeze"]           # already resolved, just misplaced
        else:
            # Refusing beats ignoring: ops.liquify.freeze is a SELECTION SPEC in
            # the job, and resolving it is imgselect's vocabulary, not this
            # file's. Dropping it silently would unfreeze a face nobody checked.
            raise PathError("ops.liquify.freeze is a selection spec; resolve it "
                            "with imgselect.resolve(spec['freeze'], rgba) and "
                            "pass the float32 (H, W) mask as freeze=")
    sel = _as_mask(mask, h, w)
    frz = _as_mask(freeze, h, w, "freeze mask")
    limit = None
    if sel is not None or frz is not None:
        limit = np.ones((h, w), np.float32) if sel is None else sel
        if frz is not None:
            limit = limit * (1.0 - frz)

    field = np.zeros((h, w, 2), np.float32)
    touched = False
    for s in strokes:
        if not isinstance(s, dict):
            raise PathError(f"a liquify stroke must be an object, got {type(s).__name__}")
        name = str(s.get("tool") or "")
        name = ALIASES.get(name, name)
        if name not in LIQUIFY_TOOLS:
            raise PathError(f"no such liquify tool {name!r}; expected one of "
                            f"{list(LIQUIFY_TOOLS)}")
        p = _coerce(CATALOG[name]["params"], s, f"{name}: ", notes)
        pts = p["points"]
        if len(pts) < 1:
            _note(f"{name}: no usable points; nothing warped", notes)
            continue
        if p["amount"] <= 0.0 or p["size"] < 1.0:
            _note(f"{name}: amount {p['amount']} at size {p['size']} moves "
                  f"nothing", notes)
            continue
        dabs = _walk(pts, p["size"], p["spacing"], p["pressure"])
        if len(dabs) >= _MAX_DABS:
            _note(f"{name}: the stroke was cut off at {_MAX_DABS} dabs - the "
                  f"path is long relative to spacing*size, and the rest of it "
                  f"is NOT warped", notes)
        for (cx, cy, r, scale, sx, sy) in dabs:
            if r < 0.5:
                continue
            if name == "push" and abs(sx) < 1e-9 and abs(sy) < 1e-9:
                continue                 # a click has no drag in it
            if _dab(field, name, cx, cy, r, p["amount"] * scale, p["hardness"],
                    sx, sy, limit):
                touched = True
    if not touched:
        _note("liquify: every stroke was a no-op; the image is untouched", notes)
    return field


def _dab(field, tool, cx, cy, r, amount, hardness, sx, sy, limit):
    """One dab into the accumulated field. Returns whether it moved anything."""
    h, w = field.shape[:2]
    x0 = max(0, int(math.floor(cx - r)))
    y0 = max(0, int(math.floor(cy - r)))
    x1 = min(w, int(math.ceil(cx + r)) + 1)
    y1 = min(h, int(math.ceil(cy + r)) + 1)
    if x1 <= x0 or y1 <= y0:
        return False
    # Pixel CENTRES against the dab's centre, so a dab at (10.5, 10.5) is
    # centred on pixel (10, 10) - the same convention imgstroke's brushes use,
    # and the reason a liquify brush and a paint brush of the same size cover
    # the same pixels. The half-pixel cancels out of the DISPLACEMENT, which is
    # a difference of two positions, so only the falloff needs it.
    xs = (np.arange(x0, x1, dtype=np.float32) + np.float32(0.5) - np.float32(cx))[None, :]
    ys = (np.arange(y0, y1, dtype=np.float32) + np.float32(0.5) - np.float32(cy))[:, None]
    d = np.sqrt(xs * xs + ys * ys)
    k = _profile(d, r, hardness) * np.float32(amount)
    if limit is not None:
        k = k * limit[y0:y1, x0:x1]
    if tool == "reconstruct":
        # Reconstruct works on the MESH, not the pixels: a region taken all the
        # way back has a displacement of exactly zero, so it is bit-identical to
        # the original rather than a warp of a warp.
        sub = field[y0:y1, x0:x1]
        if not sub.any():
            return False
        sub *= (1.0 - k)[..., None]
        np.copyto(sub, 0.0, where=np.abs(sub) < 1e-6)
        return True
    dx, dy = _dab_displacement(tool, xs, ys, k, sx, sy)
    dx = np.broadcast_to(dx, k.shape).astype(np.float32)
    dy = np.broadcast_to(dy, k.shape).astype(np.float32)
    if not (np.any(dx) or np.any(dy)):
        return False
    # D_new(x) = d(x) + D_old(x + d(x)). The sample point can leave the dab's
    # box by as much as the displacement, so the OLD field is read from a
    # padded slice; nothing outside the box is written.
    pad = int(math.ceil(max(float(np.abs(dx).max()), float(np.abs(dy).max())))) + 2
    px0, py0 = max(0, x0 - pad), max(0, y0 - pad)
    px1, py1 = min(w, x1 + pad), min(h, y1 + pad)
    prev = field[py0:py1, px0:px1]
    if prev.any():
        gx = (np.arange(x0, x1, dtype=np.float32)[None, :] - px0) + dx
        gy = (np.arange(y0, y1, dtype=np.float32)[:, None] - py0) + dy
        moved = cv2.remap(prev, np.ascontiguousarray(gx), np.ascontiguousarray(gy),
                          cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        field[y0:y1, x0:x1, 0] = dx + moved[..., 0]
        field[y0:y1, x0:x1, 1] = dy + moved[..., 1]
    else:
        field[y0:y1, x0:x1, 0] += dx
        field[y0:y1, x0:x1, 1] += dy
    return True


def warp(rgba, field, interpolation="bicubic", notes=None):
    """Sample the image ONCE through a displacement field. Straight alpha in
    and out.

    Three things earn their lines here. PREMULTIPLY before filtering, or the
    filter mixes in the black that transparent pixels happen to hold and every
    edge grows a dark fringe; UN-premultiply after, or the picture comes back
    darkened by its own alpha - the failure that hides, because it looks like
    an exposure problem. And only the box the field actually moved is
    resampled: outside it, and at any pixel whose displacement is exactly zero,
    the original bytes are copied. That is what makes a freeze mask
    bit-identical rather than merely close.

    One consequence worth knowing: a pixel that DID move and has alpha 0 comes
    back with RGB 0. Premultiplied filtering cannot preserve the colour of a
    fully transparent pixel, because it multiplied it away - so the invisible
    colour an eraser left behind does not survive being warped, though an
    untouched one does. Every alternative is worse; keeping the old RGB under
    moved content would smear a colour nobody can see into the place a
    different one came from."""
    if not _valid(rgba):
        raise PathError("warp needs float32 (H, W, 4) 0..1 RGBA")
    h, w = rgba.shape[:2]
    f = np.asarray(field)
    if f.ndim != 3 or f.shape[:2] != (h, w) or f.shape[2] != 2:
        raise PathError(f"the field is {f.shape}, expected ({h}, {w}, 2)")
    f = f.astype(np.float32, copy=False)
    active = (f[..., 0] != 0.0) | (f[..., 1] != 0.0)
    if not active.any():
        return rgba                       # bit-identical, and it costs one scan
    rows = np.flatnonzero(active.any(axis=1))
    cols = np.flatnonzero(active.any(axis=0))
    y0, y1 = int(rows[0]), int(rows[-1]) + 1
    x0, x1 = int(cols[0]), int(cols[-1]) + 1
    sub = f[y0:y1, x0:x1]
    reach = float(np.abs(sub).max())
    if not math.isfinite(reach):
        raise PathError("the displacement field has a non-finite entry in it")
    # 4 taps of headroom so bicubic never reads across the padded edge, where
    # BORDER_REPLICATE would invent a pixel that exists two rows away.
    pad = int(math.ceil(reach)) + 4
    px0, py0 = max(0, x0 - pad), max(0, y0 - pad)
    px1, py1 = min(w, x1 + pad), min(h, y1 + pad)
    src = _premul(np.ascontiguousarray(rgba[py0:py1, px0:px1]))
    gx = (np.arange(x0, x1, dtype=np.float32)[None, :] - px0) + sub[..., 0]
    gy = (np.arange(y0, y1, dtype=np.float32)[:, None] - py0) + sub[..., 1]
    flag = _CV_INTERP.get(interpolation, cv2.INTER_CUBIC)
    moved = cv2.remap(src, np.ascontiguousarray(gx), np.ascontiguousarray(gy),
                      flag, borderMode=cv2.BORDER_REPLICATE)
    moved = _unpremul(np.clip(moved, 0.0, 1.0))
    out = _own(rgba)
    region = out[y0:y1, x0:x1]
    np.copyto(region, moved, where=active[y0:y1, x0:x1, None])
    return out


def _liquify_spec(spec):
    """ops.liquify is either a bare list of strokes or {strokes, ...}. Both,
    because a caller with one stroke will send the list."""
    if isinstance(spec, dict):
        if spec.get("tool") is not None and "strokes" not in spec:
            # A caller with ONE stroke sends the stroke. Reading that as an
            # envelope with no strokes in it would warp nothing and say so in
            # a note nobody reads.
            return [spec], "bicubic"
        strokes = spec.get("strokes", spec.get("ops", []))
        if isinstance(strokes, dict):
            strokes = [strokes]
        if not isinstance(strokes, (list, tuple)):
            strokes = []
        interp = spec.get("interpolation", "bicubic")
        if interp not in INTERPOLATIONS:
            interp = "bicubic"
        return list(strokes), interp
    if isinstance(spec, (list, tuple)):
        return list(spec), "bicubic"
    return [], "bicubic"


def liquify(rgba, spec, mask=None, freeze=None, notes=None):
    """Push, bloat, pucker, twirl and reconstruct - the whole list, ONE resample.

    There is deliberately no singular `apply_liquify` beside this the way
    imgstroke has `apply_stroke` beside `apply_strokes`. A brush stroke commits
    pixels, so calling it twice costs nothing extra; a warp does not, and a
    per-stroke entry point is an invitation to pay an interpolation per stroke.
    Hand this every stroke you have.

    `freeze` is a float32 (H, W) 0..1 mask - imgselect's shape, because the
    engine resolves ops.liquify.freeze with imgselect.resolve and passes the
    array. 1 means frozen, and a frozen pixel comes back bit-identical."""
    if not _valid(rgba):
        raise PathError("liquify needs float32 (H, W, 4) 0..1 RGBA")
    h, w = rgba.shape[:2]
    _, interp = _liquify_spec(spec)
    field = liquify_field((h, w), spec, mask, freeze, notes)
    return warp(rgba, field, interp, notes)


# ---------------------------------------------------------------------------
# the CLI
# ---------------------------------------------------------------------------

def _bench(size=2048):
    """The four costs spec-shaped work actually pays, on a size-square plate."""
    rng = np.random.default_rng(7)
    img = rng.random((size, size, 4), dtype=np.float32) * 0.5 + 0.25
    img[..., 3] = 1.0
    blob = {"anchors": [
        {"p": [size * 0.15, size * 0.5], "in": [0, 400], "out": [0, -400]},
        {"p": [size * 0.5, size * 0.12], "in": [-400, 0], "out": [400, 0]},
        {"p": [size * 0.86, size * 0.5], "in": [0, -400], "out": [0, 400]},
        {"p": [size * 0.5, size * 0.88], "in": [400, 0], "out": [-400, 0]}],
        "closed": True}
    out = {}

    def timed(name, fn):
        fn()
        t = time.perf_counter()
        fn()
        out[name] = round((time.perf_counter() - t) * 1000.0, 1)

    timed("fill", lambda: draw_path(img, {"paths": blob, "fill": [255, 40, 90, 255]}))
    timed("stroke w=8", lambda: draw_path(img, {"paths": blob, "stroke": [0, 0, 0, 255],
                                                "strokeWidth": 8}))
    timed("stroke w=8 dashed", lambda: draw_path(img, {"paths": blob,
                                                       "stroke": [0, 0, 0, 255],
                                                       "strokeWidth": 8,
                                                       "dash": [40, 20]}))
    timed("path -> mask", lambda: path_mask({"paths": blob}, size, size))
    timed("boolean_mask subtract",
          lambda: boolean_mask([blob, circle_path(size * 0.5, size * 0.5, size * 0.2)],
                               "subtract", size, size))
    n = 400
    path = [[200.0 + i / (n - 1.0) * (size - 400.0),
             size * 0.5 + math.sin(i / (n - 1.0) * 6.0) * size * 0.2, 1.0]
            for i in range(n)]
    for tool in LIQUIFY_TOOLS:
        job = {"tool": tool, "points": path, "size": 200, "amount": 0.6}
        # Reconstruct has nothing to undo unless something warped first, and a
        # bench of a no-op is how a tool that costs a minute goes unnoticed.
        jobs = [dict(job, tool="push"), job] if tool == "reconstruct" else [job]
        timed(f"liquify {tool}", lambda j=jobs: liquify(img, j))
    timed("liquify push x8", lambda: liquify(img, [
        {"tool": "push", "points": path, "size": 200, "amount": 0.6}] * 8))
    return out


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    elif mode == "bench":
        print(json.dumps({"ok": True, "ms": _bench(), "size": "2048x2048",
                          "stroke": "400 points, size 200, spacing 0.25"}, indent=2))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
