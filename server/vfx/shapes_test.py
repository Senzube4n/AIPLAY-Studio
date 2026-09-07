"""Unit tests for the shape renderer in server/vfx/shapes.py.

Vector work is the one part of a compositor where "it looks right" is not a
test, because everything here has a closed-form answer: a 40x20 rectangle
covers 800 pixels, a disc covers pi*r^2, a butt-capped stroke of width w over
length L lays down exactly w*L of ink, and half a trim is half of that. So
almost every case below measures COVERAGE - the sum of the alpha channel -
against arithmetic done on paper, not against a golden image.

Two kinds of test, the same split effects_test.py uses.

  * SWEEPS over the CATALOG: every item type renders, every default sits
    inside its own advertised range, every entry carries a label / group /
    why, and every shape comes back float32, 0..1, straight alpha. These fail
    as one line naming the offenders.
  * ONE MEANINGFUL ASSERTION PER FEATURE - not "it ran" but "a 100% rounded
    hexagon is its inscribed circle", "an inward offset of 20 on a 100 square
    is a 60 square", "the same wiggle seed twice is the same path", "trim
    start=80 end=20 draws the 40% that wraps through the seam".

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/shapes_test.py

numpy / cv2, plus interp.py for the keyframed cases - the animated tests go
through the real evaluator, because "animatable" is a claim about interp and
not about this module.
"""
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import interp                                              # noqa: E402
import shapes                                              # noqa: E402

PASS = FAIL = 0
EV = interp.eval_prop


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    eq(name, abs(float(got) - float(want)) <= tol, True)


def draw(items, t=0.0, w=300, h=300, transform=None, origin="topLeft", **kw):
    """One group of items on a wxh canvas. topLeft origin by default so the
    numbers in a case read as canvas pixels; the layer default is centre and
    gets its own test."""
    group = {"type": "group", "items": items}
    if transform:
        group["transform"] = transform
    return shapes.render_shape({"shapes": [group], "origin": origin},
                               t, w, h, EV, **kw)


def ink(img):
    """Total coverage - the quantity almost every case below is an argument
    about."""
    return float(img[..., 3].sum())


def runs(row, thresh=0.5):
    """How many separate stretches of ink there are along one scanline."""
    on = row > thresh
    return int(np.count_nonzero(on[1:] & ~on[:-1]) + (1 if on[0] else 0))


def blobs(img, thresh=0.5):
    return int(cv2.connectedComponents((img[..., 3] > thresh).astype(np.uint8))[0] - 1)


LINE = {"type": "path", "points": [20, 150, 280, 150], "closed": False}
DISC = {"type": "ellipse", "size": [160, 160], "position": [150, 150]}


print("\nshapes\n")
print("  -- the catalog contract --")

bad = [k for k, e in shapes.CATALOG.items()
       if not (e.get("label") and e.get("why") and e.get("group") in shapes.GROUP_ORDER)]
eq("every entry has a label, a group and a why", bad, [])

bad = []
for k, e in shapes.CATALOG.items():
    for pk, p in e["params"].items():
        if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append(f"{k}.{pk}")
        if p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append(f"{k}.{pk}")
        if "desc" not in p or "animatable" not in p:
            bad.append(f"{k}.{pk}")
eq("every parameter is described and defaults inside its own range", bad, [])

eq("the aliases all point at something real",
   sorted({v for v in shapes.ALIASES.values()} - set(shapes.CATALOG)), [])
cat = shapes.catalog()
eq("catalog() serves the whole vocabulary",
   sorted(cat["shapes"]) == sorted(shapes.CATALOG) and bool(cat["notes"]), True)


print("\n  -- the output contract --")

paths = [{"type": "rect", "size": [80, 60], "position": [150, 150]},
         {"type": "ellipse", "size": [80, 80], "position": [150, 150]},
         {"type": "polystar", "position": [150, 150], "outerRadius": 60, "innerRadius": 30},
         {"type": "path", "points": [100, 100, 200, 100, 200, 200], "closed": True}]
bad, straight, ranged = [], [], []
for pth in paths:
    img = draw([pth, {"type": "fill", "color": [255, 0, 0], "opacity": 40}])
    if img.dtype != np.float32 or img.shape != (300, 300, 4):
        bad.append(pth["type"])
    if float(img.min()) < 0.0 or float(img.max()) > 1.0:
        ranged.append(pth["type"])
    a = img[..., 3]
    hit = np.unravel_index(int(np.argmax(a)), a.shape)
    # STRAIGHT alpha: the colour of a 40%-opaque red fill is still pure red.
    if not (abs(a[hit] - 0.4) < 1e-5 and np.allclose(img[hit][:3], [1, 0, 0], atol=1e-5)):
        straight.append(pth["type"])
eq("every path type returns float32 (H,W,4)", bad, [])
eq("...inside 0..1", ranged, [])
eq("...with STRAIGHT alpha, not premultiplied", straight, [])

eq("a layer with no shapes is an empty frame",
   ink(shapes.render_shape({}, 0, 32, 32, EV)), 0.0)
eq("...and so is a layer full of nonsense",
   ink(shapes.render_shape({"shapes": [{"type": "nope"}, 7, None]}, 0, 32, 32, EV)), 0.0)
eq("a bare item list is treated as one group",
   ink(shapes.render_shape({"shapes": [{"type": "rect", "size": [10, 10],
                                        "position": [16, 16]},
                                       {"type": "fill"}], "origin": "topLeft"},
                           0, 32, 32, EV)), 100.0)


print("\n  -- paths --")

img = draw([{"type": "rect", "size": [40, 20], "position": [50, 30]},
            {"type": "fill", "color": [255, 0, 0]}])
a = img[..., 3]
ys, xs = np.nonzero(a)
eq("a filled rect covers exactly its own area", ink(img), 800.0)
eq("...on exactly the right pixels and no others",
   (xs.min(), xs.max(), ys.min(), ys.max()), (30, 69, 20, 39))
eq("...with no partial pixel anywhere on an integer-aligned edge",
   sorted(set(np.unique(a).tolist())), [0.0, 1.0])

img = draw([DISC, {"type": "fill"}])
near("an ellipse's area is pi*r^2", ink(img), math.pi * 80 * 80, math.pi * 6400 * 0.02)
edge = a = img[..., 3]
soft = int(((edge > 0.02) & (edge < 0.98)).sum())
eq("its edge is antialiased, not binary", soft > 400, True)
eq("...across many levels, not two or three", len(np.unique(edge)) > 40, True)

# Adaptive flattening is the claim that a big curve is not faceted: the same
# circle at four times the radius must keep the same relative area error.
small = ink(draw([{"type": "ellipse", "size": [40, 40], "position": [150, 150]},
                  {"type": "fill"}])) / (math.pi * 400)
big = ink(draw([{"type": "ellipse", "size": [560, 560], "position": [300, 300]},
                {"type": "fill"}], w=600, h=600)) / (math.pi * 280 * 280)
eq("flattening is adaptive - a big circle is no more faceted than a small one",
   abs(big - 1.0) <= abs(small - 1.0) + 1e-4, True)

# 5-point star: 5 triangles of base 2*R*sin(pi/5)... the closed form is
# 5*R*r*sin(pi/5), which is what a real polystar has to land on.
img = draw([{"type": "polystar", "starType": "star", "points": 5,
             "position": [150, 150], "outerRadius": 100, "innerRadius": 45},
            {"type": "fill"}])
near("a 5-point star has the area a 5-point star has",
     ink(img), 5 * 100 * 45 * math.sin(math.pi / 5), 40)
img = draw([{"type": "polystar", "starType": "polygon", "points": 6,
             "position": [150, 150], "outerRadius": 100, "outerRoundness": 100},
            {"type": "fill"}])
near("100% roundness on a polygon IS its inscribed circle",
     ink(img), math.pi * (100 * math.cos(math.pi / 6)) ** 2, 200)

near("rect roundness cuts the corners by exactly (4-pi)r^2",
     ink(draw([{"type": "rect", "size": [200, 200], "position": [150, 150],
                "roundness": 50}, {"type": "fill"}])),
     200 * 200 - (4 - math.pi) * 2500, 120)
eq("roundness clamps at half the shorter side (a stadium, not a knot)",
   abs(ink(draw([{"type": "rect", "size": [200, 100], "position": [150, 150],
                  "roundness": 900}, {"type": "fill"}]))
       - (100 * 100 + math.pi * 2500)) < 120, True)

# A bezier quarter-turn: the tangent length that makes a cubic into a quarter
# circle is r*4/3*(sqrt(2)-1). Filling the closed wedge gives a quarter disc
# plus the triangle behind it.
k = 100.0 * 4.0 / 3.0 * (math.sqrt(2) - 1)
img = draw([{"type": "path", "vertices": [[150, 150], [250, 150], [150, 50]],
             "outTangents": [[0, 0], [0, -k], [0, 0]],
             "inTangents": [[0, 0], [0, 0], [k, 0]], "closed": True},
            {"type": "fill"}])
near("a bezier path flattens to the curve it describes",
     ink(img), math.pi * 100 * 100 / 4.0, 120)


print("\n  -- paint --")

for width in (1, 3, 10, 25):
    img = draw([{"type": "path", "points": [150, 20, 150, 280], "closed": False},
                {"type": "stroke", "width": width}])
    near(f"a stroke of width {width} is {width} pixels wide",
         img[150, :, 3].sum(), width, 0.02)
near("...and a diagonal one lays down width*length of ink",
     ink(draw([{"type": "path", "points": [50, 50, 250, 250], "closed": False},
               {"type": "stroke", "width": 12}])),
     12 * math.hypot(200, 200), 6)

for cap, extra in (("butt", 0.0), ("round", math.pi * 25), ("square", 100.0)):
    near(f"a {cap} cap adds what a {cap} cap adds",
         ink(draw([{"type": "path", "points": [100, 150, 200, 150], "closed": False},
                   {"type": "stroke", "width": 10, "lineCap": cap}])),
         1000 + extra, 6)

# A right-angle miter reaches sqrt(2) line widths; a limit under that has to
# fall back to bevel and lose the tip.
corner = [{"type": "path", "points": [100, 100, 200, 100, 200, 200], "closed": False}]
mit = ink(draw(corner + [{"type": "stroke", "width": 20, "lineJoin": "miter",
                          "miterLimit": 4}]))
bev = ink(draw(corner + [{"type": "stroke", "width": 20, "lineJoin": "bevel"}]))
lim = ink(draw(corner + [{"type": "stroke", "width": 20, "lineJoin": "miter",
                          "miterLimit": 1.2}]))
eq("a miter join covers more than a bevel", mit > bev + 20, True)
eq("...and a miter limit under the miter's own length falls back to bevel",
   abs(lim - bev) < 1e-3, True)
near("a round join is between the two",
     ink(draw(corner + [{"type": "stroke", "width": 20, "lineJoin": "round"}])),
     (mit + bev) / 2.0, (mit - bev))

img = draw([LINE, {"type": "stroke", "width": 6, "dashes": [20, 20]}])
eq("dashes produce gaps", runs(img[150, :, 3]) > 4, True)
eq("...and a solid stroke does not", runs(draw([LINE, {"type": "stroke",
                                                       "width": 6}])[150, :, 3]), 1)
near("...and the ink is the on-time fraction of the whole line",
     ink(img), 260 * 6 * 0.5, 260 * 6 * 0.08)
off = draw([LINE, {"type": "stroke", "width": 6, "dashes": [20, 20],
                   "dashOffset": 20}])
eq("a dash offset slides the pattern",
   float(np.abs(off[150, :, 3] - img[150, :, 3]).max()) > 0.9, True)

img = draw([{"type": "rect", "size": [200, 100], "position": [150, 150]},
            {"type": "gradientFill", "startPoint": [50, 150], "endPoint": [250, 150],
             "stops": [{"pos": 0, "color": [255, 0, 0]},
                       {"pos": 1, "color": [0, 0, 255]}]}])
eq("a linear gradient starts at the first colour",
   bool(img[150, 55, 0] > 0.9 and img[150, 55, 2] < 0.1), True)
eq("...and ends at the last",
   bool(img[150, 245, 2] > 0.9 and img[150, 245, 0] < 0.1), True)
eq("...passing through the middle on the way",
   bool(0.4 < img[150, 150, 0] < 0.6 and 0.4 < img[150, 150, 2] < 0.6), True)
rad = draw([{"type": "rect", "size": [200, 200], "position": [150, 150]},
            {"type": "gradientFill", "gradientType": "radial",
             "startPoint": [150, 150], "endPoint": [230, 150],
             "stops": [{"pos": 0, "color": [255, 0, 0]},
                       {"pos": 1, "color": [0, 0, 255]}]}])
eq("a radial gradient is the first colour at its centre",
   bool(rad[150, 150, 0] > 0.95), True)
eq("...and reaches the last at its radius in every direction, not just along x",
   bool(rad[60, 150, 2] > 0.95 and rad[150, 60, 2] > 0.95
        and rad[240, 150, 2] > 0.95), True)
eq("a gradient stroke ramps along the line too",
   bool(draw([LINE, {"type": "gradientStroke", "width": 20,
                     "startPoint": [20, 150], "endPoint": [280, 150],
                     "stops": [{"pos": 0, "color": [255, 0, 0]},
                               {"pos": 1, "color": [0, 255, 0]}]}])[150, 270, 1] > 0.9),
   True)

ring = [DISC, {"type": "ellipse", "size": [80, 80], "position": [150, 150]}]
near("evenodd punches the inner circle out",
     ink(draw(ring + [{"type": "fill", "fillRule": "evenodd"}])),
     math.pi * (80 * 80 - 40 * 40), 200)
near("...where nonzero keeps it filled",
     ink(draw(ring + [{"type": "fill", "fillRule": "nonzero"}])),
     math.pi * 80 * 80, 200)
eq("a later paint draws over an earlier one",
   float(draw([{"type": "rect", "size": [100, 100], "position": [150, 150]},
               {"type": "fill", "color": [255, 0, 0]},
               {"type": "fill", "color": [0, 0, 255]}])[150, 150, 2]), 1.0)


print("\n  -- trim paths --")

full = draw([LINE, {"type": "stroke", "width": 6}])
half = draw([LINE, {"type": "trim", "start": 0, "end": 50},
             {"type": "stroke", "width": 6}])
eq("trim end=50 draws exactly half the path length", ink(half) / ink(full), 0.5)
xs = np.nonzero(half[150, :, 3] > 0.5)[0]
eq("...the FIRST half, measured on the canvas", (int(xs.min()), int(xs.max())), (20, 149))
eq("trim end=100 draws all of it",
   ink(draw([LINE, {"type": "trim", "start": 0, "end": 100},
             {"type": "stroke", "width": 6}])), ink(full))
eq("trim start=end draws nothing",
   ink(draw([LINE, {"type": "trim", "start": 40, "end": 40},
             {"type": "stroke", "width": 6}])), 0.0)
near("trim start=25 end=75 draws the middle half",
     ink(draw([LINE, {"type": "trim", "start": 25, "end": 75},
               {"type": "stroke", "width": 6}])), ink(full) * 0.5, 1)
wrapped = draw([LINE, {"type": "trim", "start": 80, "end": 20},
                {"type": "stroke", "width": 6}])
near("start past end WRAPS through the seam and draws the other 40%",
     ink(wrapped), ink(full) * 0.4, 1)
eq("...as two pieces on an open path", runs(wrapped[150, :, 3]), 2)
near("an offset of 180 degrees moves the trim half a path along",
     ink(draw([LINE, {"type": "trim", "start": 0, "end": 50, "offset": 180},
               {"type": "stroke", "width": 6}])), ink(full) * 0.5, 1)
eq("...to the far half of the line",
   int(np.nonzero(draw([LINE, {"type": "trim", "start": 0, "end": 50, "offset": 180},
                        {"type": "stroke", "width": 6}])[150, :, 3] > 0.5)[0].min()), 150)
eq("a closed path trimmed to 100% is still closed (no seam gap)",
   blobs(draw([DISC, {"type": "trim", "start": 0, "end": 100},
               {"type": "stroke", "width": 6}])), 1)

two = [{"type": "path", "points": [20, 100, 280, 100], "closed": False},
       {"type": "path", "points": [20, 200, 280, 200], "closed": False}]
sim = draw(two + [{"type": "trim", "end": 50, "trimMultipleShapes": "simultaneously"},
                  {"type": "stroke", "width": 6}])
ind = draw(two + [{"type": "trim", "end": 50, "trimMultipleShapes": "individually"},
                  {"type": "stroke", "width": 6}])
eq("simultaneously: both paths are half drawn",
   (runs(sim[100, :, 3]), runs(sim[200, :, 3])), (1, 1))
eq("individually: the first path finishes before the second starts",
   (runs(ind[100, :, 3]), runs(ind[200, :, 3])), (1, 0))
near("...and the two spend the same total ink", ink(sim), ink(ind), 1)


print("\n  -- repeater --")

dot = [{"type": "ellipse", "size": [20, 20], "position": [40, 150]},
       {"type": "fill"}]
eq("a repeater with 3 copies produces 3",
   blobs(draw(dot + [{"type": "repeater", "copies": 3, "position": [80, 0]}])), 3)
eq("...and with 1 copy produces 1",
   blobs(draw(dot + [{"type": "repeater", "copies": 1, "position": [80, 0]}])), 1)
one = ink(draw(dot))
near("...each copy carrying the same ink",
     ink(draw(dot + [{"type": "repeater", "copies": 3, "position": [80, 0]}])),
     one * 3, 3)
fade = draw(dot + [{"type": "repeater", "copies": 3, "position": [80, 0],
                    "startOpacity": 100, "endOpacity": 20}])
eq("a start/end opacity fades the copies out",
   bool(fade[150, 40, 3] > 0.95 and 0.15 < fade[150, 200, 3] < 0.25), True)
near("...scaling copies scales their ink with them",
     ink(draw(dot + [{"type": "repeater", "copies": 2, "position": [120, 0],
                      "anchor": [40, 150], "scale": [50, 50]}])),
     one * 1.25, 3)
spun = draw([{"type": "path", "points": [150, 150, 150, 40], "closed": False},
             {"type": "stroke", "width": 6},
             {"type": "repeater", "copies": 4, "position": [0, 0],
              "anchor": [150, 150], "rotation": 90}])
eq("a rotating repeater sweeps a full turn into 4 arms", blobs(spun), 1)
eq("...reaching all four sides of the anchor",
   bool(spun[45, 150, 3] > 0.5 and spun[255, 150, 3] > 0.5
        and spun[150, 45, 3] > 0.5 and spun[150, 255, 3] > 0.5), True)


print("\n  -- the other path operations --")

sq = {"type": "rect", "size": [100, 100], "position": [150, 150]}
near("offset +20 with a miter join is a 140 square",
     ink(draw([sq, {"type": "offsetPath", "amount": 20, "lineJoin": "miter"},
               {"type": "fill"}])), 140 * 140, 1)
near("...with a round join it loses the corner squares to quarter discs",
     ink(draw([sq, {"type": "offsetPath", "amount": 20, "lineJoin": "round"},
               {"type": "fill"}])), 140 * 140 - (4 - math.pi) * 400, 30)
near("offset -20 shrinks it to a 60 square",
     ink(draw([sq, {"type": "offsetPath", "amount": -20}, {"type": "fill"}])),
     60 * 60, 1)

near("round corners at radius 30 cuts (4-pi)r^2 off a rectangle",
     ink(draw([sq, {"type": "roundCorners", "radius": 30}, {"type": "fill"}])),
     100 * 100 - (4 - math.pi) * 900, 40)
near("...and rounding a CIRCLE does nothing, because it has no corners",
     ink(draw([DISC, {"type": "roundCorners", "radius": 30}, {"type": "fill"}])),
     ink(draw([DISC, {"type": "fill"}])), 1e-3)

zz = draw([LINE, {"type": "zigzag", "size": 20, "ridges": 3},
           {"type": "stroke", "width": 4}])
ys = np.nonzero(zz[..., 3] > 0.5)[0]
eq("a zigzag pushes the path to both sides by its size",
   (int(ys.min()) <= 131 and int(ys.max()) >= 169), True)
eq("...and a straight line does not", int(np.ptp(np.nonzero(full[..., 3] > 0.5)[0])), 5)
eq("more ridges makes a longer path",
   ink(draw([LINE, {"type": "zigzag", "size": 20, "ridges": 6},
             {"type": "stroke", "width": 4}]))
   > ink(zz) * 1.2, True)
eq("smooth points give a different path from corner points",
   float(np.abs(draw([LINE, {"type": "zigzag", "size": 20, "ridges": 3,
                             "points": "smooth"},
                      {"type": "stroke", "width": 4}]) - zz).max()) > 0.5, True)

wig = dict(type="wiggle", size=12, detail=10, seed=4)
w1 = draw([DISC, wig, {"type": "fill"}])
eq("the same wiggle seed renders the same path twice",
   np.array_equal(w1, draw([DISC, wig, {"type": "fill"}])), True)
eq("...a different seed does not",
   np.array_equal(w1, draw([DISC, dict(wig, seed=5), {"type": "fill"}])), False)
eq("...and size 0 leaves the path alone",
   np.array_equal(draw([DISC, dict(wig, size=0), {"type": "fill"}]),
                  draw([DISC, {"type": "fill"}])), True)
eq("a frozen wiggle does not move between two times",
   np.array_equal(draw([DISC, wig, {"type": "fill"}], t=0.0),
                  draw([DISC, wig, {"type": "fill"}], t=2.0)), True)
eq("...and one with wigglesPerSecond does",
   np.array_equal(draw([DISC, dict(wig, wigglesPerSecond=2), {"type": "fill"}], t=0.0),
                  draw([DISC, dict(wig, wigglesPerSecond=2), {"type": "fill"}], t=2.0)),
   False)

# Two discs of radius 60 whose centres are 60 apart: the lens they share has a
# closed form, so add / subtract / intersect / exclude all do.
pair = [{"type": "ellipse", "size": [120, 120], "position": [120, 150]},
        {"type": "ellipse", "size": [120, 120], "position": [180, 150]}]
disc = math.pi * 3600
lens = 2 * 3600 * math.acos(0.5) - 30 * math.sqrt(4 * 3600 - 3600)
for mode, want in (("add", 2 * disc - lens), ("subtract", disc - lens),
                   ("intersect", lens), ("exclude", 2 * disc - 2 * lens)):
    got = ink(draw(pair + [{"type": "merge", "mode": mode}, {"type": "fill"}]))
    eq(f"merge {mode} lands within 2% of the closed form",
       abs(got - want) / want < 0.02, True)
eq("merge leaves a single path alone",
   ink(draw([DISC, {"type": "merge", "mode": "add"}, {"type": "fill"}]))
   == ink(draw([DISC, {"type": "fill"}])), True)
eq("a merged result is still a PATH - a stroke can trace it",
   blobs(draw(pair + [{"type": "merge", "mode": "add"},
                      {"type": "stroke", "width": 4}])), 1)


print("\n  -- groups and transforms --")

base = [{"type": "rect", "size": [40, 40], "position": [50, 50]}, {"type": "fill"}]
moved = draw(base, transform={"position": [100, 0]})
eq("a group transform moves its contents",
   int(np.nonzero(moved[..., 3] > 0.5)[1].min()), 130)
near("...scales them about the anchor",
     ink(draw(base, transform={"anchor": [50, 50], "position": [50, 50],
                               "scale": [200, 200]})), 80 * 80, 1)
near("...and scales the STROKE with them",
     ink(draw([{"type": "path", "points": [100, 150, 200, 150], "closed": False},
               {"type": "stroke", "width": 10}],
              transform={"anchor": [150, 150], "position": [150, 150],
                         "scale": [200, 200]})), 200 * 20, 4)
eq("a rotated group is not an unrotated one",
   float(np.abs(draw(base, transform={"anchor": [50, 50], "position": [50, 50],
                                      "rotation": 45}) - draw(base)).max()) > 0.5, True)
near("group opacity multiplies every paint in it",
     ink(draw(base, transform={"opacity": 50})), ink(draw(base)) * 0.5, 1)
eq("a disabled group draws nothing",
   ink(shapes.render_shape({"origin": "topLeft",
                            "shapes": [{"type": "group", "enabled": False,
                                        "items": base}]}, 0, 300, 300, EV)), 0.0)
eq("a nested group renders inside its parent's transform",
   int(np.nonzero(shapes.render_shape(
       {"origin": "topLeft",
        "shapes": [{"type": "group", "transform": {"position": [100, 0]},
                    "items": [{"type": "group", "items": base}]}]},
       0, 300, 300, EV)[..., 3] > 0.5)[1].min()), 130)

centred = shapes.render_shape({"shapes": [{"type": "group", "items": [
    {"type": "rect", "size": [40, 40], "position": [0, 0]},
    {"type": "fill"}]}]}, 0, 300, 300, EV)
ys, xs = np.nonzero(centred[..., 3] > 0.5)
eq("the default origin is the CENTRE of the layer, as AE has it",
   (int(xs.min()), int(ys.min())), (130, 130))

eq("scale renders the same picture at half the size",
   shapes.render_shape({"shapes": [{"type": "group", "items": base}],
                        "origin": "topLeft"}, 0, 150, 150, EV, scale=0.5).shape,
   (150, 150, 4))
near("...covering a quarter of the pixels",
     ink(shapes.render_shape({"shapes": [{"type": "group", "items": base}],
                              "origin": "topLeft"}, 0, 150, 150, EV, scale=0.5)),
     1600 / 4.0, 1)
eq("draft still draws, with coarser sampling",
   ink(draw([DISC, {"type": "fill"}], draft=True)) > 0, True)


print("\n  -- animation --")

trim_keys = {"keys": [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 100.0}]}
anim = [DISC, {"type": "trim", "end": trim_keys}, {"type": "stroke", "width": 8}]
a0, a1, a2 = ink(draw(anim, t=0.0)), ink(draw(anim, t=0.5)), ink(draw(anim, t=1.0))
eq("an animated trim is empty at its first key", a0, 0.0)
near("...half drawn halfway", a1, a2 / 2.0, a2 * 0.02)
eq("...and whole at its last key", a2 > 0, True)
eq("...and holds after the last key", ink(draw(anim, t=5.0)), a2)

for what, items in (
        ("a rect size", [{"type": "rect", "size": {"keys": [
            {"t": 0, "v": [20, 20]}, {"t": 1, "v": [200, 200]}]}, "position": [150, 150]},
            {"type": "fill"}]),
        ("a fill opacity", [DISC, {"type": "fill", "opacity": {"keys": [
            {"t": 0, "v": 100}, {"t": 1, "v": 20}]}}]),
        ("a stroke width", [LINE, {"type": "stroke", "width": {"keys": [
            {"t": 0, "v": 4}, {"t": 1, "v": 30}]}}]),
        ("a repeater rotation", [{"type": "rect", "size": [20, 90],
                                  "position": [150, 100]}, {"type": "fill"},
                                 {"type": "repeater", "copies": 3, "position": [0, 0],
                                  "anchor": [150, 150], "rotation": {"keys": [
                                      {"t": 0, "v": 0}, {"t": 1, "v": 90}]}}]),
        ("a gradient endpoint", [{"type": "rect", "size": [200, 100],
                                  "position": [150, 150]},
                                 {"type": "gradientFill", "startPoint": [50, 150],
                                  "endPoint": {"keys": [{"t": 0, "v": [60, 150]},
                                                        {"t": 1, "v": [250, 150]}]}}]),
        ("a group rotation", [{"type": "rect", "size": [40, 40], "position": [50, 50]},
                              {"type": "fill"}])):
    if what == "a group rotation":
        early = draw(items, t=0.0, transform={"anchor": [50, 50], "position": [50, 50],
                                              "rotation": {"keys": [{"t": 0, "v": 0},
                                                                    {"t": 1, "v": 40}]}})
        late = draw(items, t=1.0, transform={"anchor": [50, 50], "position": [50, 50],
                                             "rotation": {"keys": [{"t": 0, "v": 0},
                                                                   {"t": 1, "v": 40}]}})
    else:
        early, late = draw(items, t=0.0), draw(items, t=1.0)
    eq(f"{what} keyframes", float(np.abs(late - early).max()) > 0.2, True)

eq("an easing on a keyframe changes the value in between",
   abs(ink(draw([DISC, {"type": "trim", "end": {"keys": [
       {"t": 0.0, "v": 0.0, "ease": "easeInOut"}, {"t": 1.0, "v": 100.0}]}},
       {"type": "stroke", "width": 8}], t=0.25)) - a2 * 0.25) > a2 * 0.03, True)


print("\n  -- the ready-made constructors --")

for name, fn in sorted(shapes.CONSTRUCTORS.items()):
    layer = fn()
    eq(f"{name}() builds a shape layer", layer.get("type"), "shape")
    frames = [ink(shapes.render_shape(layer, t, 600, 600, EV)) for t in (0.0, 1.0, 3.0)]
    eq(f"...and {name}() renders something at every time",
       all(f >= 0 for f in frames) and max(frames) > 0, True)
eq("line_draw() is empty before its animation starts and drawn after",
   ink(shapes.render_shape(shapes.line_draw(duration=1.0), 0.0, 600, 600, EV)) == 0.0
   and ink(shapes.render_shape(shapes.line_draw(duration=1.0), 1.0, 600, 600, EV)) > 0,
   True)
eq("progress_ring() grows between two times",
   ink(shapes.render_shape(shapes.progress_ring(duration=2.0), 2.0, 600, 600, EV))
   > ink(shapes.render_shape(shapes.progress_ring(duration=2.0), 0.2, 600, 600, EV)),
   True)
eq("burst(rays=8) draws 8 rays",
   blobs(shapes.render_shape(shapes.burst(rays=8), 0.0, 600, 600, EV)), 8)


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
