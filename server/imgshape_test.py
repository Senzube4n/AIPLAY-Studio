"""Unit tests for server/imgshape.py - shapes, canvas and geometry.

Geometry is the part of an image editor where "it looks right" is not a test,
because every one of these has an answer you can write down before you run it.
A 40x20 rectangle covers 800 pixels. An ellipse covers pi*a*b. A butt-capped
stroke of width w over length L lays down exactly w*L of ink, and a square cap
adds exactly w*w. A canvas anchored bottom-right puts the old top-left corner
at exactly (W-w, H-h). So almost every case below measures COVERAGE - the sum
of the alpha channel - or an exact pixel address, against arithmetic done on
paper.

Three kinds of case, and the third is the one this codebase keeps needing:

  * SWEEPS over the CATALOG - every entry has a label, a group, a why and a
    stage; every default sits inside its own advertised range.
  * ONE MEANINGFUL ASSERTION PER FEATURE - not "it ran" but "a miter join on a
    right angle adds exactly hw^2/2 more ink than a bevel", "rotating by 90 is
    bit-identical to the transpose", "trim keeps the row with one stray pixel
    in it".
  * EVERY CATALOG PARAMETER CHANGES THE PICTURE. A schema that accepts a
    parameter the code ignores is worse than a refusal, because a schema is
    exactly what a caller trusts. Each one is rendered twice, at its default
    and at some other value, and the two must differ.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgshape_test.py

numpy / cv2. imagetools is imported only to prove the blend arithmetic here is
the same arithmetic the compositor uses, rather than a second copy of it.
"""
import math
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imagetools                                          # noqa: E402
import imgshape as S                                       # noqa: E402

PASS = FAIL = 0
TIMES = {}


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    got, want = float(got), float(want)
    ok = abs(got - want) <= tol
    if not ok:
        print(f"        {name}: {got:.6f} vs {want:.6f} (tol {tol:g})")
    eq(name, ok, True)


def blank(h=140, w=180):
    return np.zeros((h, w, 4), np.float32)


def opaque(h=140, w=180, rgb=(0.5, 0.5, 0.5)):
    img = np.zeros((h, w, 4), np.float32)
    img[..., :3] = rgb
    img[..., 3] = 1.0
    return img


def ink(img):
    """Total coverage - the quantity most of the cases below argue about."""
    return float(img[..., 3].sum())


def noise(h, w, seed=0):
    return np.random.default_rng(seed).random((h, w, 4)).astype(np.float32)


def smooth(n, seed=1):
    """Detail down to about two pixels - roughly what a photograph carries,
    and what a resampling round trip is fair to be judged on. Blur it to
    nothing and the round-trip test stops measuring anything."""
    rng = np.random.default_rng(seed)
    a = cv2.GaussianBlur(rng.random((n, n, 4)).astype(np.float32), (0, 0), 2.0)
    a -= a.min()
    a /= max(float(a.max()), 1e-6)
    a[..., 3] = 1.0
    return np.ascontiguousarray(np.clip(a, 0, 1))


def photo(n, seed=0):
    """A smooth background with a busy subject in the middle - the picture
    seam carving exists for."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n].astype(np.float32) / n
    img = np.zeros((n, n, 4), np.float32)
    img[..., 0], img[..., 1], img[..., 2] = x, y, 0.5 * (x + y)
    lo, hi = int(n * 0.375), int(n * 0.625)
    img[:, lo:hi, :3] = rng.random((n, hi - lo, 3)).astype(np.float32)
    img[..., 3] = 1.0
    return img


PHI2 = ((1.0 + math.sqrt(5.0)) / 2.0) ** 2


def star_points(cx, cy, r, n=5, step=2):
    th = [-math.pi / 2 + (2 * math.pi * step * k) / n for k in range(n)]
    return [[cx + r * math.cos(t), cy + r * math.sin(t)] for t in th]


print("\nimgshape\n")
print("  -- the catalog contract --")

bad = [k for k, e in S.CATALOG.items()
       if not (e.get("label") and e.get("why") and e.get("group") in S.GROUP_ORDER
               and e.get("stage") in (1, 3, 8))]
eq("every entry has a label, a group, a why and a pipeline stage", bad, [])

bad = []
for k, e in S.CATALOG.items():
    for pk, p in e["params"].items():
        if "desc" not in p or "type" not in p:
            bad.append(f"{k}.{pk}")
        elif p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append(f"{k}.{pk}")
        elif p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append(f"{k}.{pk}")
        elif p["type"] == "color" and not (p["default"] is None or len(p["default"]) >= 3):
            bad.append(f"{k}.{pk}")
eq("every parameter is described and defaults inside its own range", bad, [])

eq("every shape kind has a catalog entry",
   [k for k in S.SHAPE_KINDS if k not in S.CATALOG], [])
eq("every shape kind can be painted",
   [k for k in S.SHAPE_KINDS
    if not ({"fill", "stroke"} & set(S.CATALOG[k]["params"]))], [])
eq("the aliases all point at something real",
   sorted({v for v in S.ALIASES.values()} - set(S.SHAPE_KINDS)), [])
cat = S.catalog()
eq("catalog() serves the whole vocabulary",
   sorted(cat["ops"]) == sorted(S.CATALOG) and bool(cat["notes"]), True)
eq("...and the blend modes come from imagetools, not from a second list",
   S.CATALOG["rect"]["params"]["blend"]["options"], list(imagetools.BLEND_MODES))


print("\n  -- every catalog parameter is actually read --")

BASE = {
    "rect": {"kind": "rect", "points": [[20, 20], [120, 90]], "fill": [255, 0, 0],
             "stroke": [0, 255, 0], "strokeWidth": 6},
    "ellipse": {"kind": "ellipse", "points": [[20, 20], [120, 90]], "fill": [255, 0, 0],
                "stroke": [0, 255, 0], "strokeWidth": 6},
    "line": {"kind": "line", "points": [[20, 90], [70, 20], [24, 88]],
             "stroke": [255, 255, 255], "strokeWidth": 9},
    "polygon": {"kind": "polygon", "points": star_points(80, 60, 50),
                "fill": [255, 0, 0], "stroke": [0, 0, 255], "strokeWidth": 5},
    "arrow": {"kind": "arrow", "points": [[20, 90], [70, 20], [140, 90]],
              "stroke": [255, 255, 255], "strokeWidth": 9},
}
CHANGED = {
    "points": [[10, 10], [60, 40], [30, 70], [80, 80]],
    "radius": 18, "fill": [0, 0, 255], "stroke": [255, 255, 0], "strokeWidth": 14,
    "blend": "multiply", "cap": "round", "join": "round", "miterLimit": 100,
    "fillRule": "evenodd", "headLength": 40, "headWidth": 44,
}
# A miter limit only matters at an angle sharp enough to be near it, and every
# kind's base shape has a different corner: the line is a spike that bevels at
# 4 already, the star and the arrow are blunter and miter at 4.
CHANGED_FOR = {("polygon", "miterLimit"): 1.05, ("arrow", "miterLimit"): 1.05}


def render_shape(kind, overrides):
    src = dict(BASE[kind])
    src.update(overrides)
    return S.draw_shape(opaque(), src)


missing = []
for kind in S.SHAPE_KINDS:
    for pk in S.CATALOG[kind]["params"]:
        if pk not in CHANGED:
            missing.append(f"{kind}.{pk} (no test value)")
            continue
        a = render_shape(kind, {})
        b = render_shape(kind, {pk: CHANGED_FOR.get((kind, pk), CHANGED[pk])})
        if np.array_equal(a, b):
            missing.append(f"{kind}.{pk}")
eq("every shape parameter in the catalog changes the pixels", missing, [])

CANVAS_CASES = [
    ("canvasSize.width", {"width": 200, "height": 200}, {"width": 240, "height": 200}),
    ("canvasSize.height", {"width": 200, "height": 200}, {"width": 200, "height": 240}),
    ("canvasSize.anchor", {"width": 200, "height": 200}, {"width": 200, "height": 200,
                                                          "anchor": "topleft"}),
    ("canvasSize.background", {"width": 200, "height": 200},
     {"width": 200, "height": 200, "background": [255, 0, 0, 255]}),
    ("trim.trim", {}, {"trim": "transparent"}),
]
# trim.tolerance needs a border that is ALMOST uniform; on an exactly
# transparent one every tolerance gives the same answer.
FUZZY = np.zeros((40, 40, 4), np.float32)
FUZZY[:] = [0.8, 0.4, 0.2, 1.0]
FUZZY[10:30, 12:28] = [0.1, 0.1, 0.1, 1.0]
FUZZY[0, ::3, 0] += 2.0 / 255.0
CANVAS_CASES.append(("trim.tolerance", {"trim": "borders", "tolerance": 0},
                     {"trim": "borders", "tolerance": 3}))
GEOM_CASES = [
    ("flip.flipH", {}, {"flipH": True}),
    ("flip.flipV", {}, {"flipV": True}),
    ("rotate.rotate", {}, {"rotate": 12}),
    ("rotate.expand", {"rotate": 12}, {"rotate": 12, "expand": False}),
    ("rotate.interpolation", {"rotate": 12}, {"rotate": 12, "interpolation": "nearest"}),
    ("perspective.perspective", {"perspective": [[0, 0], [128, 0], [128, 128], [0, 128]]},
     {"perspective": [[6, 2], [90, 0], [84, 70], [0, 64]]}),
    ("perspective.fit", {"perspective": [[6, 2], [90, 0], [84, 70], [0, 64]]},
     {"perspective": [[6, 2], [90, 0], [84, 70], [0, 64]], "fit": True}),
    ("perspective.interpolation", {"perspective": [[6, 2], [90, 0], [84, 70], [0, 64]]},
     {"perspective": [[6, 2], [90, 0], [84, 70], [0, 64]], "interpolation": "nearest"}),
    ("smartResize.width", {}, {"smartResize": {"width": 96}}),
    ("smartResize.height", {}, {"smartResize": {"height": 96}}),
    ("smartResize.seamsPerPass", {"smartResize": {"width": 96, "seamsPerPass": 1}},
     {"smartResize": {"width": 96, "seamsPerPass": 32}}),
    ("smartResize.maxCarve", {"smartResize": {"width": 40, "maxCarve": 0.2}},
     {"smartResize": {"width": 40, "maxCarve": 1.0}}),
]

edgy = photo(128)
edgy[:6, :, 3] = 0.0                      # a transparent border, so trim has work
busy = photo(128)
# The geometry cases get the picture WITHOUT the border, and that is a finding
# rather than a convenience: a full-width band of transparency puts one huge
# horizontal edge in the energy field, every seam through it is dead straight,
# and thirty-two straight seams taken at once are the same thirty-two taken one
# at a time. seamsPerPass then genuinely changes nothing, and a sweep run on
# that image would have concluded the parameter was ignored.
ignored = []
for label, a_ops, b_ops in CANVAS_CASES:
    src = FUZZY if label == "trim.tolerance" else edgy
    a, b = S.apply_canvas(src, a_ops, []), S.apply_canvas(src, b_ops, [])
    if a.shape == b.shape and np.array_equal(a, b):
        ignored.append(label)
for label, a_ops, b_ops in GEOM_CASES:
    if np.array_equal(S.apply_geometry(busy, a_ops, []), S.apply_geometry(busy, b_ops, [])):
        ignored.append(label)
eq("every canvas and geometry parameter changes the pixels", ignored, [])
covered = {c[0] for c in CANVAS_CASES + GEOM_CASES}
eq("...and the cases above cover every one of them",
   sorted({f"{n}.{p}" for n in ("canvasSize", "trim", "flip", "rotate", "perspective",
                                "smartResize")
           for p in S.CATALOG[n]["params"] if f"{n}.{p}" not in covered}), [])


print("\n  -- the spec's own objects, verbatim --")

# docs/IMAGE_SPEC.md section 7, copied field for field. Every field it names has
# to be a field the catalog names, or the schema and the contract have already
# drifted - and the only way to find that out is to feed the contract in and
# listen for a complaint.
spec_img = photo(64)
spec_img[:4, :, 3] = 0.0
notes = []
out = S.apply_canvas(spec_img, {"width": 96, "height": 72, "anchor": "center",
                                "background": [0, 0, 0, 0], "trim": "transparent"}, notes)
eq("the spec's canvas object is accepted field for field",
   (out.shape[:2], [n for n in notes if "not in the catalog" in n]), ((72, 96), []))
notes = []
out = S.apply_geometry(spec_img, {"rotate": 12.5, "expand": True, "flipH": False,
                                  "flipV": False,
                                  "perspective": [[0, 0], [64, 0], [64, 64], [0, 64]],
                                  "smartResize": {"width": 48, "height": 40}}, notes)
eq("the spec's geometry object is accepted field for field",
   (out.shape[:2], [n for n in notes if "not in the catalog" in n]), ((40, 48), []))
notes = []
out = S.apply_shapes(opaque(64, 64), [{"kind": "rect", "points": [[8, 8], [40, 40]],
                                       "radius": 0, "fill": [255, 0, 0, 255],
                                       "stroke": [0, 255, 0, 255], "strokeWidth": 2,
                                       "blend": "normal"}], None, notes)
eq("the spec's shape object is accepted field for field",
   ([n for n in notes if "not in the catalog" in n],
    bool(np.allclose(out[24, 24, :3], [1, 0, 0], atol=1e-6))), ([], True))
notes = []
S.apply_canvas(spec_img, {"trim": None}, notes)
eq("a null trim is 'not set', not a complaint", notes, [])


print("\n  -- the output contract --")

bad, ranged, straight = [], [], []
for kind in S.SHAPE_KINDS:
    # ONE paint, because where a fill and a stroke overlap the alphas compound
    # and 0.4 over 0.4 is 0.64 - which says nothing about the convention.
    src = {k: v for k, v in BASE[kind].items() if k not in ("fill", "stroke")}
    src["fill" if "fill" in BASE[kind] else "stroke"] = [255, 0, 0, 102]   # 40% red
    img = S.draw_shape(blank(), src)
    if img.dtype != np.float32 or img.shape != (140, 180, 4):
        bad.append(kind)
    if float(img.min()) < 0.0 or float(img.max()) > 1.0:
        ranged.append(kind)
    a = img[..., 3]
    hit = np.unravel_index(int(np.argmax(a)), a.shape)
    # STRAIGHT alpha: the colour of a 40%-opaque red shape is still pure red.
    if not (abs(a[hit] - 102 / 255) < 1e-5 and np.allclose(img[hit][:3], [1, 0, 0], atol=1e-5)):
        straight.append(kind)
eq("every kind returns float32 (H,W,4)", bad, [])
eq("...inside 0..1", ranged, [])
eq("...with STRAIGHT alpha, not premultiplied", straight, [])

src_img = opaque()
before = src_img.copy()
S.draw_shape(src_img, BASE["rect"])
eq("drawing does not write to the caller's array", np.array_equal(src_img, before), True)

for kind in S.SHAPE_KINDS:
    src = {k: v for k, v in BASE[kind].items() if k not in ("fill", "stroke")}
    try:
        S.draw_shape(blank(), src)
        eq(f"a {kind} with no paint is an error", "no raise", "ShapeError")
    except S.ShapeError:
        eq(f"a {kind} with no paint is an error", True, True)
try:
    S.draw_shape(blank(), {"kind": "line", "points": [[10, 10], [40, 40]],
                           "fill": [255, 0, 0]}, notes=[])
    eq("a line painted only with a fill is an error", "no raise", "ShapeError")
except S.ShapeError:
    eq("a line painted only with a fill is an error", True, True)
try:
    S.draw_shape(blank(), {"kind": "banana", "points": [[1, 1]], "fill": [1, 2, 3]})
    eq("an unknown kind is an error", "no raise", "ShapeError")
except S.ShapeError:
    eq("an unknown kind is an error", True, True)


print("\n  -- shapes: fills --")

img = S.draw_shape(blank(), {"kind": "rect", "points": [[30, 20], [70, 40]],
                             "fill": [255, 0, 0]})
a = img[..., 3]
ys, xs = np.nonzero(a)
eq("a 40x20 filled rect covers exactly 800 pixels", ink(img), 800.0)
eq("...exactly the right ones", (int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())),
   (30, 69, 20, 39))
eq("...with no partial pixel anywhere on an integer-aligned edge",
   sorted(np.unique(a).tolist()), [0.0, 1.0])
eq("...and the colour is the 0-255 one that was asked for",
   np.allclose(img[30, 50, :3], [1, 0, 0], atol=1e-6), True)

img = S.draw_shape(blank(), {"kind": "rect", "points": [[30.5, 20.25], [70.5, 40.25]],
                             "fill": [255, 255, 255]})
near("a rect on a fractional boundary still covers exactly 800", ink(img), 800.0, 1e-3)
eq("...and antialiases the edge it lands between", len(np.unique(img[..., 3])) > 2, True)

img = S.draw_shape(blank(), {"kind": "rect", "points": [[70, 40], [30, 20]],
                             "fill": [255, 255, 255]})
eq("corners given the other way round are the same rectangle", ink(img), 800.0)

img = S.draw_shape(blank(200, 260), {"kind": "ellipse", "points": [[20, 40], [180, 140]],
                                     "fill": [255, 255, 255]})
area = math.pi * 80 * 50
near("an ellipse's area is pi*a*b", ink(img), area, area * 0.0005)
edge = img[..., 3]
eq("its edge is antialiased, not binary",
   int(((edge > 0.02) & (edge < 0.98)).sum()) > 300, True)
eq("...across many levels, not two or three", len(np.unique(edge)) > 40, True)
# The analytic span is the point of the exercise: a 0.25px-flattened polygon
# would be inscribed and would lose about half a percent of this.
big = S.draw_shape(blank(700, 700), {"kind": "ellipse", "points": [[10, 10], [690, 690]],
                                     "fill": [255, 255, 255]})
near("a big circle is no more faceted than a small one",
     ink(big) / (math.pi * 340 * 340), 1.0, 0.0005)

for r in (0, 12, 25):
    img = S.draw_shape(blank(), {"kind": "rect", "points": [[20, 20], [120, 70]],
                                 "radius": r, "fill": [255, 255, 255]})
    near(f"a rect with radius {r} loses exactly (4-pi)r^2 to its corners",
         ink(img), 100 * 50 - (4 - math.pi) * r * r, 0.05)
img = S.draw_shape(blank(), {"kind": "rect", "points": [[20, 20], [120, 70]],
                             "radius": 999, "fill": [255, 255, 255]})
near("radius clamps at half the shorter side - a stadium, not a mess",
     ink(img), 100 * 50 - (4 - math.pi) * 25 * 25, 0.05)

img = S.draw_shape(blank(), {"kind": "polygon", "points": [[10, 10], [110, 10], [10, 90]],
                             "fill": [255, 255, 255]})
near("a right triangle covers base*height/2", ink(img), 100 * 80 / 2, 0.02)

pts = star_points(90, 70, 60)
non = ink(S.draw_shape(blank(), {"kind": "polygon", "points": pts, "fill": [255, 255, 255]}))
even = ink(S.draw_shape(blank(), {"kind": "polygon", "points": pts, "fill": [255, 255, 255],
                                  "fillRule": "evenodd"}))
core = 2.5 * (60 / PHI2) ** 2 * math.sin(math.radians(72))
near("evenodd punches exactly the pentagram's core out of nonzero",
     non - even, core, core * 0.02)


print("\n  -- shapes: strokes --")

for w in (1, 3, 10):
    img = S.draw_shape(blank(160, 260), {"kind": "line", "points": [[20, 80.37], [220, 80.37]],
                                         "stroke": [255, 255, 255], "strokeWidth": w})
    near(f"a horizontal stroke of width {w} measures {w}", ink(img) / 200.0, w, 0.01)
    img = S.draw_shape(blank(260, 160), {"kind": "line", "points": [[80.37, 20], [80.37, 220]],
                                         "stroke": [255, 255, 255], "strokeWidth": w})
    near(f"a vertical stroke of width {w} measures {w}", ink(img) / 200.0, w, 0.01)
    img = S.draw_shape(blank(260, 260), {"kind": "line", "points": [[30, 30], [180, 180]],
                                         "stroke": [255, 255, 255], "strokeWidth": w})
    near(f"a diagonal stroke of width {w} measures {w}",
         ink(img) / (150 * math.sqrt(2)), w, 0.01)

img = S.draw_shape(blank(220, 300), {"kind": "rect", "points": [[50, 50], [250, 150]],
                                     "stroke": [255, 255, 255], "strokeWidth": 10})
near("a rect's stroke is the band between the grown and the shrunk rect",
     ink(img), 210 * 110 - 190 * 90, 0.05)

img = S.draw_shape(blank(400, 400), {"kind": "ellipse", "points": [[100, 100], [300, 300]],
                                     "stroke": [255, 255, 255], "strokeWidth": 10})
ring = math.pi * (105 ** 2 - 95 ** 2)
near("a circle's stroke is the ring between r+w/2 and r-w/2", ink(img), ring, ring * 0.001)

# The regression this replaced: growing both semi-axes by w/2 gets the RING'S
# AREA exactly right while drawing a stroke that measures 8.0 where it was
# asked for 10.0. Only a local measurement catches it.
img = S.draw_shape(blank(200, 400), {"kind": "ellipse", "points": [[100, 75], [300, 125]],
                                     "stroke": [255, 255, 255], "strokeWidth": 10})
near("a 4:1 ellipse's stroke measures 10 at its flat end too",
     float(img[100, :200, 3].sum()), 10.0, 0.15)
near("...and at its sharp end", float(img[:100, 200, 3].sum()), 10.0, 0.15)

L = 100.0
for cap, extra in (("butt", 0.0), ("square", 10.0 * 5.0 * 2), ("round", math.pi * 25)):
    img = S.draw_shape(blank(160, 200), {"kind": "line", "points": [[40, 80], [140, 80]],
                                         "stroke": [255, 255, 255], "strokeWidth": 10,
                                         "cap": cap})
    near(f"a {cap} cap adds exactly {extra:.2f}", ink(img), L * 10 + extra, 0.06)

corner = {"kind": "line", "points": [[20, 20], [80, 20], [80, 80]],
          "stroke": [255, 255, 255], "strokeWidth": 10, "cap": "butt"}
quads = 600 + 600 - 25
near("a bevel join on a right angle adds hw^2/2",
     ink(S.draw_shape(blank(), {**corner, "join": "bevel"})), quads + 12.5, 0.05)
near("a miter join adds hw^2", ink(S.draw_shape(blank(), {**corner, "join": "miter"})),
     quads + 25.0, 0.05)
near("a round join adds the quarter disc the two quads leave uncovered",
     ink(S.draw_shape(blank(), {**corner, "join": "round"})), quads + math.pi * 25 / 4, 0.3)
spike = {"kind": "line", "points": [[30, 100], [80, 20], [34, 100]],
         "stroke": [255, 255, 255], "strokeWidth": 10, "join": "miter"}
eq("a miter past the limit falls back to a bevel",
   ink(S.draw_shape(blank(), {**spike, "miterLimit": 1.05}))
   < ink(S.draw_shape(blank(), {**spike, "miterLimit": 100})) - 10, True)

sw, hl, hw = 6.0, 30.0, 18.0
img = S.draw_shape(blank(240, 300), {"kind": "arrow", "points": [[50, 120], [200, 120]],
                                     "stroke": [255, 255, 255], "strokeWidth": sw,
                                     "headLength": hl, "headWidth": hw})
overlap = sw * hl * (1.0 - sw / (2.0 * hw))
near("an arrow is its shaft plus its head minus the overlap of the two",
     ink(img), 150 * sw + hl * hw / 2 - overlap, 0.05)
img = S.draw_shape(blank(240, 300), {"kind": "arrow", "points": [[50, 120], [200, 120]],
                                     "stroke": [255, 255, 255], "strokeWidth": sw,
                                     "headLength": hl, "headWidth": sw})
near("...and a head no wider than the shaft is entirely inside it",
     ink(img), 150 * sw, 0.05)
dl, dw = 3.0 * sw, 2.5 * sw
near("an arrow's default head is 3x the stroke width long and 2.5x wide",
     ink(S.draw_shape(blank(240, 300), {"kind": "arrow", "points": [[50, 120], [200, 120]],
                                        "stroke": [255, 255, 255], "strokeWidth": sw})),
     150 * sw + dl * dw / 2 - sw * dl * (1.0 - sw / (2.0 * dw)), 0.05)


print("\n  -- shapes: compositing --")

base = opaque(60, 60, (0.5, 0.5, 0.5))
img = S.draw_shape(base, {"kind": "rect", "points": [[10, 10], [50, 50]],
                          "fill": [128, 128, 128], "blend": "multiply"})
want = float(imagetools._blend(np.float32(0.5), np.float32(128 / 255), "multiply"))
near("a blend mode is imagetools' blend, not a second copy of it",
     img[30, 30, 0], want, 1e-6)

img = S.draw_shape(blank(60, 60), {"kind": "rect", "points": [[10, 10], [50, 50]],
                                   "fill": [255, 0, 0, 128]})
eq("a half-opaque shape on an empty canvas is still pure red",
   np.allclose(img[30, 30, :3], [1, 0, 0], atol=1e-6), True)
near("...at half alpha", img[30, 30, 3], 128 / 255, 1e-6)

two = S.apply_shapes(blank(60, 60), [
    {"kind": "rect", "points": [[10, 10], [50, 50]], "fill": [255, 0, 0]},
    {"kind": "rect", "points": [[20, 20], [40, 40]], "fill": [0, 0, 255]}])
eq("shapes draw in list order, the later one on top",
   np.allclose(two[30, 30, :3], [0, 0, 1], atol=1e-6)
   and np.allclose(two[15, 15, :3], [1, 0, 0], atol=1e-6), True)

base = opaque(60, 60)
m0 = np.zeros((60, 60), np.float32)
m1 = np.ones((60, 60), np.float32)
shape = {"kind": "ellipse", "points": [[5, 5], [55, 55]], "fill": [255, 0, 0]}
eq("a zero selection mask leaves the image bit-identical",
   np.array_equal(S.draw_shape(base, shape, m0), base), True)
eq("a mask of all ones is bit-identical to no mask at all",
   np.array_equal(S.draw_shape(base, shape, m1), S.draw_shape(base, shape, None)), True)
half = np.full((60, 60), 0.5, np.float32)
masked = S.draw_shape(blank(60, 60), shape, half)
# The literal reading of "result*m + original*(1-m)" mixes STRAIGHT colour and
# would give 50% of dark red here, because a transparent pixel's RGB is black.
eq("a half mask over transparency keeps the colour and halves the alpha",
   np.allclose(masked[30, 30, :3], [1, 0, 0], atol=1e-6), True)
near("...alpha", masked[30, 30, 3], 0.5, 1e-6)
try:
    S.draw_shape(base, shape, np.ones((10, 10), np.float32))
    eq("a mask that is not the image's size is a wiring error", "no raise", "ShapeError")
except S.ShapeError:
    eq("a mask that is not the image's size is a wiring error", True, True)


print("\n  -- canvas: canvas size --")

src = np.zeros((3, 5, 4), np.float32)
src[..., 0] = np.arange(15, dtype=np.float32).reshape(3, 5) / 15.0
src[..., 1], src[..., 2], src[..., 3] = 0.25, 0.5, 1.0
W, H = 11, 9
bg = [255, 0, 0, 255]
EXPECT = {"topleft": (0, 0), "top": (3, 0), "topright": (6, 0),
          "left": (0, 3), "center": (3, 3), "right": (6, 3),
          "bottomleft": (0, 6), "bottom": (3, 6), "bottomright": (6, 6)}
wrong, leaked = [], []
for anchor in S.ANCHORS:
    out = S.canvas_size(src, W, H, anchor, bg)
    ox, oy = EXPECT[anchor]
    if out.shape != (H, W, 4) or not np.array_equal(out[oy:oy + 3, ox:ox + 5], src):
        wrong.append(anchor)
    keep = np.ones((H, W), bool)
    keep[oy:oy + 3, ox:ox + 5] = False
    if not np.allclose(out[keep], [1, 0, 0, 1], atol=1e-6):
        leaked.append(anchor)
eq("all nine anchors put the original exactly where they say", wrong, [])
eq("...and fill every other pixel with the background", leaked, [])

out = S.canvas_size(src, 10, 9, "center", bg)
eq("an odd remainder falls to the right and the bottom",
   np.array_equal(out[3:6, 2:7], src), True)
out = S.canvas_size(src, 5, 3, "center", bg)
eq("a canvas the same size is the same image", np.array_equal(out, src), True)
out = S.canvas_size(src, 3, 3, "center", bg)
eq("a smaller canvas crops rather than scaling",
   np.array_equal(out, src[:, 1:4]), True)
out = S.canvas_size(src, 7, 5, "center", None)
eq("the default background is transparent", float(out[..., 3].sum()), 15.0)
eq("...and it is a canvas resize, not an image resize: no pixel is resampled",
   sorted(np.unique(out[..., 0]).tolist()) ==
   sorted(set(np.unique(src[..., 0]).tolist()) | {0.0}), True)


print("\n  -- canvas: trim --")

img = np.zeros((20, 20, 4), np.float32)
img[5:15, 3:17] = [0.2, 0.4, 0.6, 1.0]
out = S.trim(img, "transparent")
eq("trim removes exactly the transparent border", out.shape, (10, 14, 4))
eq("...and the content is untouched", np.array_equal(out, img[5:15, 3:17]), True)

img2 = img.copy()
img2[2, 0] = [1, 1, 1, 1]                 # one stray pixel in the border
out = S.trim(img2, "transparent")
eq("a border row with ONE pixel in it is content and survives", out.shape, (13, 17, 4))

img3 = np.zeros((16, 16, 4), np.float32)
img3[:] = [0.8, 0.4, 0.2, 1.0]
img3[4:12, 6:10] = [0.1, 0.1, 0.1, 1.0]
eq("trim borders reads the colour off the corners", S.trim(img3, "borders").shape,
   (8, 4, 4))
eq("...and leaves a transparent-mode trim with nothing to do",
   S.trim(img3, "transparent").shape, (16, 16, 4))

img4 = img3.copy()
img4[0, ::3, 0] += 2.0 / 255.0            # a border that is not quite uniform
eq("tolerance 0 refuses to trim a border that is not exactly uniform",
   S.trim(img4, "borders", 0, []).shape, (16, 16, 4))
eq("...and a tolerance of 3/255 trims it", S.trim(img4, "borders", 3, []).shape, (8, 4, 4))

notes = []
eq("an image that is all border keeps one pixel rather than becoming empty",
   S.trim(np.zeros((8, 8, 4), np.float32), "transparent", 0, notes).shape, (1, 1, 4))
eq("...and says so", any("border" in n for n in notes), True)

notes = []
out = S.apply_canvas(img, {"trim": "transparent", "width": 20, "height": 20,
                           "anchor": "center", "background": [0, 255, 0, 255]}, notes)
eq("apply_canvas trims BEFORE it resizes the frame - the other order "
   "would trim the new background away",
   (out.shape, np.allclose(out[0, 0], [0, 1, 0, 1], atol=1e-6)), ((20, 20, 4), True))


print("\n  -- geometry: flips and right angles --")

im = noise(23, 17, 5)
eq("flipH is exact", np.array_equal(S.flip(im, True, False), im[:, ::-1]), True)
eq("flipV is exact", np.array_equal(S.flip(im, False, True), im[::-1]), True)
eq("flipping twice is the identity, to the bit",
   np.array_equal(S.flip(S.flip(im, True, True), True, True), im), True)

bad = []
for h, w in ((23, 17), (24, 16), (23, 16), (1, 1)):
    a = noise(h, w, h * 31 + w)
    for deg, k in ((90, -1), (180, 2), (270, 1)):
        if not np.array_equal(S.rotate(a, deg), np.rot90(a, k)):
            bad.append((h, w, deg))
eq("rotating by a multiple of 90 is bit-identical to the transpose", bad, [])

mark = np.zeros((10, 6, 4), np.float32)
mark[0, 0] = 1.0
eq("...and positive degrees turn CLOCKWISE, as the Images screen already does",
   (float(S.rotate(mark, 90)[0, -1, 3]), S.rotate(mark, 90).shape), (1.0, (6, 10, 4)))

# The transpose is a shortcut. Drive the RESAMPLING path at 90 degrees too,
# through the module's own matrix builder, because an antialiasing
# implementation that is subtly wrong shows up at the one angle where the
# answer is knowable and nowhere else.
a = noise(23, 17, 9)
a[..., 3] = np.clip(a[..., 3] * 0.8 + 0.2, 0, 1)        # no invisible pixels
M, size = S._rotate_matrix(17, 23, 90, True)
warped = S._warp_affine(a, M, size, "bicubic")
want = np.rot90(a, -1)
eq("the resampling path at 90 is bit-exact on alpha",
   np.array_equal(warped[..., 3], want[..., 3]), True)
near("...and within a float32 ulp on colour", np.abs(warped[..., :3] - want[..., :3]).max(),
     0.0, 6e-8)


print("\n  -- geometry: arbitrary rotation --")

n = 201
im = smooth(n, 4)
there = S.rotate(im, 37, expand=False)
back = S.rotate(there, -37, expand=False)
yy, xx = np.mgrid[0:n, 0:n]
disc = ((yy - n // 2) ** 2 + (xx - n // 2) ** 2) < (n // 4) ** 2
d = np.abs(back[disc] - im[disc])
# NOT zero, and it never can be: a rotation resamples, so every output pixel is
# a weighted sum of source pixels that do not sit under it. Two passes of a
# bicubic reconstruction low-pass the picture twice. The bound below is what a
# smooth image costs; noise costs an order of magnitude more, which is a fact
# about sampling and not about this code.
near("+37 then -37 comes back within 0.005 of itself on average", d.mean(), 0.0, 0.005)
near("...and within 0.05 at the worst pixel", d.max(), 0.0, 0.05)
print(f"        measured: mean {d.mean():.5f}, max {d.max():.5f}")

r = S.rotate(np.ones((100, 60, 4), np.float32), 30, expand=True)
eq("expand grows the frame to hold the rotated picture",
   r.shape[:2], (int(math.ceil(60 * 0.5 + 100 * math.cos(math.radians(30)))),
                 int(math.ceil(60 * math.cos(math.radians(30)) + 100 * 0.5))))
eq("...and without it the frame is kept",
   S.rotate(np.ones((100, 60, 4), np.float32), 30, expand=False).shape[:2], (100, 60))

# STRAIGHT ALPHA. A uniformly half-transparent picture rotated 30 degrees must
# come back the same colour it went in. Premultiplied maths that forgets to
# divide the alpha back out returns exactly half of it - a picture that looks
# plausible, has the right alpha, and is wrong.
half = np.zeros((80, 80, 4), np.float32)
half[..., :3] = [1.0, 0.2, 0.4]
half[..., 3] = 0.5
rot = S.rotate(half, 30)
h2, w2 = rot.shape[:2]
core = rot[h2 // 2 - 12:h2 // 2 + 12, w2 // 2 - 12:w2 // 2 + 12]
eq("a half-transparent picture keeps its colour through a 30 degree rotation",
   np.allclose(core[..., :3], [1.0, 0.2, 0.4], atol=1e-6), True)
near("...and its alpha", core[..., 3].mean(), 0.5, 1e-6)
eq("...and is NOT the premultiplied answer, which is the failure this catches",
   bool(np.abs(core[..., 0] - 0.5).max() > 0.4), True)

# The other direction of the same mistake: filtering STRAIGHT colour drags the
# black of the transparent outside into every edge pixel.
white = np.ones((80, 80, 4), np.float32)
rot = S.rotate(white, 30)
fringe = (rot[..., 3] > 0.2) & (rot[..., 3] < 0.8)
eq("a rotated opaque picture grows no black halo along its new edge",
   float(rot[..., :3][fringe].min()) > 0.99, True)


print("\n  -- geometry: perspective --")

im = noise(64, 48, 11)
im[..., 3] = 1.0
ident = [[0, 0], [48, 0], [48, 64], [0, 64]]
out = S.perspective(im, ident)
# Measured at exactly 0: getPerspectiveTransform returns the exact identity
# and every sample then lands on a pixel centre, where any interpolation
# kernel is [0, 1, 0, 0]. The bound is stated a million ulps looser than that
# because it is a promise about cv2's fixed-point sampler, not about this run.
near("the identity quad is a no-op", np.abs(out - im).max(), 0.0, 1e-6)
print(f"        measured: max deviation {float(np.abs(out - im).max()):.3g}")

out = S.perspective(im, [[0, 0], [24, 0], [24, 64], [0, 64]])
eq("a half-width quad squashes the picture into the left half",
   (float(out[:, 24:, 3].max()), out.shape[:2]), (0.0, (64, 48)))

notes = []
out = S.perspective(im, [[0, 0], [10, 10], [20, 20], [5, 5]], notes=notes)
eq("a degenerate quad is refused, not approximated",
   (np.array_equal(out, im), any("degenerate" in n for n in notes)), (True, True))
notes = []
eq("...so is one with fewer than four usable points",
   np.array_equal(S.perspective(im, [[0, 0], [1, float("nan")], [2, 2]], notes=notes), im),
   True)

out = S.perspective(im, [[10, 4], [70, 0], [66, 90], [4, 84]], fit=True)
eq("fit resizes the frame to the quad's bounding box", out.shape[:2], (90, 66))


print("\n  -- geometry: smart resize --")

im = photo(128)
notes = []
out = S.smart_resize(im, 96, 0, notes=notes)
eq("smartResize hits the width it was asked for", out.shape[:2], (128, 96))


def busy_cols(a, thresh=0.05):
    """Columns carrying high-frequency detail. Measured as the row-to-row
    difference, NOT the variance: the smooth background is a gradient, so its
    variance down a column is large and a variance test would count the whole
    picture as subject and pass without measuring anything."""
    return int((np.abs(np.diff(a[..., :3], axis=0)).mean(axis=(0, 2)) > thresh).sum())


kept, was = busy_cols(out), busy_cols(im)
plain = int(round(was * 96 / 128))
eq("...by taking the flat background and leaving the busy subject alone",
   (was, kept > plain + 4), (32, True))
print(f"        subject columns: {was} before, {kept} after "
      f"(a plain resize would leave {plain})")

exact = S.smart_resize(im, 96, 0, seams_per_pass=1, notes=[])
batched = S.smart_resize(im, 96, 0, seams_per_pass=32, notes=[])
ee, eb = float(S._energy(exact).mean()), float(S._energy(batched).mean())
eq("batching several seams into one energy pass is not the same picture",
   np.array_equal(exact, batched), False)
near("...but it is within a couple of percent of the exact carve's energy",
     eb / ee, 1.0, 0.03)
print(f"        residual energy: exact {ee:.5f}, batched {eb:.5f}")

out = S.smart_resize(im, 0, 96, notes=[])
eq("it carves the height the same way, by transposing", out.shape[:2], (96, 128))
out = S.smart_resize(im, 150, 0, notes=[])
eq("and it inserts seams to make a picture wider", out.shape[:2], (128, 150))

notes = []
out = S.smart_resize(im, 40, 0, max_carve=0.5, notes=notes)
eq("past maxCarve it still lands on the exact size", out.shape[:2], (128, 40))
eq("...and says out loud that the remainder was a plain resize",
   any("PLAIN resize" in n for n in notes), True)


print("\n  -- hostile input --")


def survives(name, fn, check=None):
    global PASS, FAIL
    try:
        got = fn()
    except Exception as exc:                                # noqa: BLE001
        FAIL += 1
        print(f"  FAIL  {name}\n          raised {type(exc).__name__}: {exc}")
        return
    if check is None or check(got):
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          wrong answer: {np.shape(got)}")


base = opaque(40, 60)
nan, inf = float("nan"), float("inf")

survives("a NaN corner drops the point and draws nothing",
         lambda: S.draw_shape(base, {"kind": "rect", "points": [[nan, 4], [30, 20]],
                                     "fill": [255, 0, 0]}, notes=[]),
         lambda o: np.array_equal(o, base))
survives("an infinite coordinate does the same",
         lambda: S.draw_shape(base, {"kind": "rect", "points": [[inf, inf], [30, 20]],
                                     "fill": [255, 0, 0]}, notes=[]),
         lambda o: np.array_equal(o, base))
survives("a zero-size rect draws zero pixels",
         lambda: S.draw_shape(base, {"kind": "rect", "points": [[10, 10], [10, 10]],
                                     "fill": [255, 0, 0]}, notes=[]),
         lambda o: np.array_equal(o, base))
survives("a negative-size rect is the same rect the other way round",
         lambda: S.draw_shape(base, {"kind": "rect", "points": [[30, 25], [10, 5]],
                                     "fill": [255, 0, 0]}, notes=[]),
         lambda o: abs(ink(o) - (ink(base) + 0)) >= 0 and abs(
             float((o[..., 0] > 0.9).sum()) - 400) < 1)
survives("a polygon with two points draws nothing",
         lambda: S.draw_shape(base, {"kind": "polygon", "points": [[5, 5], [30, 30]],
                                     "fill": [255, 0, 0]}, notes=[]),
         lambda o: np.array_equal(o, base))
survives("a line with one point draws nothing",
         lambda: S.draw_shape(base, {"kind": "line", "points": [[5, 5]],
                                     "stroke": [255, 0, 0]}, notes=[]),
         lambda o: np.array_equal(o, base))
survives("a NaN stroke width falls back to the catalog default",
         lambda: S.draw_shape(base, {"kind": "line", "points": [[5, 20], [55, 20]],
                                     "stroke": [255, 0, 0], "strokeWidth": nan}, notes=[]),
         lambda o: abs(ink(o) - (ink(base) + 0)) >= 0 and abs(
             float((o[..., 0] > 0.9).sum()) - 100) < 3)
survives("a negative stroke width clamps to zero and draws nothing",
         lambda: S.draw_shape(base, {"kind": "line", "points": [[5, 20], [55, 20]],
                                     "stroke": [255, 0, 0], "strokeWidth": -8}, notes=[]),
         lambda o: np.array_equal(o, base))
survives("an out-of-range colour clamps to 0-255 rather than wrapping",
         lambda: S.draw_shape(base, {"kind": "rect", "points": [[5, 5], [25, 25]],
                                     "fill": [1e9, -5, nan]}, notes=[]),
         lambda o: np.allclose(o[10, 10, :3], [1, 0, 0], atol=1e-6))
survives("a named colour is refused instead of drawing black",
         lambda: S.draw_shape(base, {"kind": "rect", "points": [[5, 5], [25, 25]],
                                     "fill": "red", "stroke": [0, 255, 0],
                                     "strokeWidth": 2}, notes=[]),
         lambda o: float(o[10, 10, 1]) < 0.6)
survives("an unknown parameter is reported, not silently dropped",
         lambda: [n for n in
                  (lambda ns: (S.draw_shape(base, {"kind": "rect",
                                                   "points": [[5, 5], [25, 25]],
                                                   "fill": [255, 0, 0],
                                                   "opacity": 0.5}, notes=ns), ns)[1])([])
                  if "opacity" in n],
         lambda o: len(o) == 1)

one = np.ones((1, 1, 4), np.float32)
survives("a 1x1 image survives a shape", lambda: S.draw_shape(
    one, {"kind": "ellipse", "points": [[0, 0], [1, 1]], "fill": [255, 0, 0]}, notes=[]),
    lambda o: o.shape == (1, 1, 4))
survives("a 1x1 image survives an arbitrary rotation",
         lambda: S.rotate(one, 37, notes=[]), lambda o: o.ndim == 3 and o.shape[2] == 4)
survives("a 1x1 image survives a trim", lambda: S.trim(one, "transparent", 0, []),
         lambda o: o.shape == (1, 1, 4))
survives("a 1x1 image survives a perspective warp",
         lambda: S.perspective(one, [[0, 0], [1, 0], [1, 1], [0, 1]], notes=[]),
         lambda o: o.shape == (1, 1, 4))
survives("a 1x1 image survives a smart resize",
         lambda: S.smart_resize(one, 1, 1, notes=[]), lambda o: o.shape == (1, 1, 4))

survives("a NaN rotation is no rotation", lambda: S.rotate(base, nan, notes=[]),
         lambda o: np.array_equal(o, base))
survives("an infinite rotation is no rotation", lambda: S.rotate(base, inf, notes=[]),
         lambda o: np.array_equal(o, base))
survives("a NaN canvas size keeps the size it had",
         lambda: S.canvas_size(base, nan, nan), lambda o: o.shape == base.shape)
survives("a zero canvas size clamps to one pixel",
         lambda: S.canvas_size(base, 0, -5), lambda o: o.shape == (1, 1, 4))
survives("a NaN trim tolerance is a tolerance of zero",
         lambda: S.trim(base, "transparent", nan, []), lambda o: o.shape == base.shape)
survives("a NaN smart resize target keeps the size it had",
         lambda: S.smart_resize(base, nan, nan, notes=[]),
         lambda o: o.shape == base.shape)
survives("a quad of four identical points is refused",
         lambda: S.perspective(base, [[3, 3]] * 4, notes=[]),
         lambda o: np.array_equal(o, base))
survives("apply_shapes ignores a shapes value that is not a list",
         lambda: S.apply_shapes(base, "rect"), lambda o: np.array_equal(o, base))
survives("apply_geometry ignores a geometry value that is not an object",
         lambda: S.apply_geometry(base, 7), lambda o: np.array_equal(o, base))
survives("apply_canvas ignores a canvas value that is not an object",
         lambda: S.apply_canvas(base, None), lambda o: np.array_equal(o, base))

u8 = (base * 255).astype(np.uint8)
survives("a uint8 array is refused rather than run as if it were 0..1",
         lambda: S.apply_geometry(u8, {"rotate": 30}), lambda o: o.dtype == np.uint8)
try:
    S.draw_shape(u8, {"kind": "rect", "points": [[1, 1], [3, 3]], "fill": [255, 0, 0]})
    eq("...and drawing on one is an error", "no raise", "ShapeError")
except S.ShapeError:
    eq("...and drawing on one is an error", True, True)

notes = []
S.apply_geometry(base, {"rotate": 30, "wobble": 3}, notes)
eq("an unknown geometry field is reported", any("wobble" in n for n in notes), True)
notes = []
S.apply_canvas(base, {"width": 50, "sparkle": 1}, notes)
eq("an unknown canvas field is reported", any("sparkle" in n for n in notes), True)

flipped = S.apply_geometry(base, {"flipH": True, "rotate": 90})
eq("apply_geometry flips before it rotates, as the catalog notes say",
   np.array_equal(flipped, S.rotate(S.flip(base, True, False), 90)), True)


print("\n  -- what it costs --")

big = noise(2048, 2048, 3)
big[..., 3] = 1.0


def timed(name, fn):
    t = time.perf_counter()
    fn()
    TIMES[name] = (time.perf_counter() - t) * 1000


timed("flipH", lambda: S.flip(big, True, False))
timed("rotate 90", lambda: S.rotate(big, 90))
timed("rotate 37 expand", lambda: S.rotate(big, 37))
timed("rotate 37 no expand", lambda: S.rotate(big, 37, expand=False))
timed("perspective", lambda: S.perspective(big, [[40, 0], [2048, 120], [2000, 2048], [0, 1900]]))
timed("canvasSize 3000", lambda: S.canvas_size(big, 3000, 3000, "center"))
timed("trim", lambda: S.trim(big, "transparent"))
timed("rect fill+stroke", lambda: S.draw_shape(big, {
    "kind": "rect", "points": [[100, 100], [1900, 1800]], "radius": 60,
    "fill": [255, 0, 0, 255], "stroke": [0, 0, 255, 255], "strokeWidth": 12}))
timed("ellipse fill+stroke", lambda: S.draw_shape(big, {
    "kind": "ellipse", "points": [[100, 100], [1900, 1800]],
    "fill": [255, 0, 0, 255], "stroke": [0, 0, 255, 255], "strokeWidth": 12}))
for n in (256, 512, 1024, 2048):
    sub = np.ascontiguousarray(big[:n, :n])
    timed(f"smartResize {n} -10%", lambda s=sub, m=n: S.smart_resize(s, int(m * 0.9), 0,
                                                                     notes=[]))
for k, v in TIMES.items():
    print(f"        {k:<24} {v:8.1f} ms")
inter = [n for n in (256, 512, 1024, 2048) if TIMES[f"smartResize {n} -10%"] <= 150]
print(f"        smartResize stays under 150ms up to "
      f"{max(inter) if inter else 0} square; past that it is a progress bar, not a slider")
eq("a 2048-square rotation is under a second",
   TIMES["rotate 37 expand"] < 1000, True)
eq("a 2048-square 10% carve is under five seconds",
   TIMES["smartResize 2048 -10%"] < 5000, True)


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
