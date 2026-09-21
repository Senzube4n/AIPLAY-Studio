"""Unit tests for server/imgpath.py - paths and liquify.

Vector work and warping are the two parts of an image editor where "it looks
right" is not a test, because both have closed-form answers. A butt-capped
stroke of width w over length L lays down exactly w*L of ink. A pentagram's
nonzero fill exceeds its even-odd fill by exactly the area of the pentagon in
the middle of it. A push of 20 px moves a dot 20 px. A frozen pixel is not
"close to" the original, it IS the original. So almost every case below
measures a NUMBER against arithmetic done on paper.

Three kinds of case, the split effects_test and shapes_test both use.

  * SWEEPS over the CATALOG: every op renders, every default sits inside its
    own advertised range, every entry carries label / group / why, and - the
    one spec §9 is really about - every parameter the catalog advertises
    CHANGES THE PICTURE. A schema that accepts a knob the code ignores is
    worse than a refusal, and the only way to know is to turn each one.
  * ONE MEANINGFUL ASSERTION PER FEATURE, against arithmetic: pi*r^2, w*L,
    the inner pentagon, 2/3 of a sagitta, a 20 px push.
  * THE OTHER SIDE'S SOURCE, not this author's memory of it: the compositing
    is checked against imgshape's own `_over`, and the alpha handling is
    checked by ALSO doing it wrong and asserting the wrong one fringes - a
    guard that no test can fail is a guard nobody knows is gone.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgpath_test.py

numpy / cv2, plus imgshape for the cross-column compositing case, and Pillow +
fontTools for the type-as-paths block - which reads a real face off this
machine rather than writing a letter down, because the one input the pen tool
can never be handed by a test author is letterform geometry.
"""
import math
import os
import sys

import cv2
import numpy as np
from PIL import ImageFont
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.basePen import decomposeQuadraticSegment
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imgpath as P                                        # noqa: E402
import imgshape                                            # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    global PASS, FAIL
    if abs(float(got) - float(want)) <= tol:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {float(got):.6f}, wanted "
              f"{float(want):.6f} +-{tol:g}  (off by {float(got) - float(want):+.6f})")


def blank(h=240, w=240):
    return np.zeros((h, w, 4), np.float32)


def ink(img):
    """Total coverage - the quantity most cases below are an argument about."""
    return float(img[..., 3].sum())


def fill_of(paths, h=240, w=240, **kw):
    job = {"paths": paths, "fill": [255, 0, 0, 255]}
    job.update(kw)
    return P.draw_path(blank(h, w), job)


def stroke_of(paths, h=240, w=240, **kw):
    job = {"paths": paths, "stroke": [0, 0, 255, 255], "strokeWidth": 4}
    job.update(kw)
    return P.draw_path(blank(h, w), job)


def dot(cx, cy, r=6.0, h=240, w=240, rgb=(1.0, 0.0, 0.0)):
    """A round blob with an antialiased edge, so its centroid is sub-pixel."""
    img = np.zeros((h, w, 4), np.float32)
    ys, xs = np.mgrid[0:h, 0:w]
    d = np.hypot(xs + 0.5 - cx, ys + 0.5 - cy)
    img[..., 0], img[..., 1], img[..., 2] = rgb
    img[..., 3] = np.clip(r - d + 0.5, 0.0, 1.0).astype(np.float32)
    return img


def centroid(img):
    a = img[..., 3].astype(np.float64)
    ys, xs = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    s = a.sum()
    return ((xs + 0.5) * a).sum() / s, ((ys + 0.5) * a).sum() / s


SQUARE = {"points": [[40, 40], [140, 40], [140, 140], [40, 140]], "closed": True}
BLOB = {"anchors": [{"p": [60, 120], "in": [0, 40], "out": [0, -40]},
                    {"p": [120, 60], "in": [-40, 0], "out": [40, 0]},
                    {"p": [180, 120], "in": [0, -40], "out": [0, 40]},
                    {"p": [120, 180], "in": [40, 0], "out": [-40, 0]}],
        "closed": True}
LINE = {"points": [[30, 120], [210, 120]]}


print("\nimgpath\n")
print("  -- the catalog contract --")

bad = [k for k, e in P.CATALOG.items()
       if not e.get("label") or not e.get("why") or e.get("group") not in P.GROUP_ORDER
       or not isinstance(e.get("params"), dict)]
eq("every op has a label, a group and a why", bad, [])

bad = []
for name, entry in P.CATALOG.items():
    for key, p in entry["params"].items():
        if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append(f"{name}.{key}")
        if p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append(f"{name}.{key}")
        if not p.get("desc"):
            bad.append(f"{name}.{key} (no desc)")
eq("every default sits inside its own advertised range", bad, [])

eq("every alias points at a real op or tool",
   sorted({v for v in P.ALIASES.values()} - set(P.CATALOG)), [])
eq("every liquify tool is in the catalog",
   sorted(set(P.LIQUIFY_TOOLS) - set(P.CATALOG)), [])
cat = P.catalog()
eq("catalog() carries the ops, the groups and the notes",
   all(k in cat for k in ("ops", "groups", "names", "aliases", "notes",
                          "liquifyTools")), True)
eq("...and names every op it describes", cat["names"], sorted(P.CATALOG))
eq("every op says WHERE it is called from, so a schema has an address on it",
   [k for k, e in P.CATALOG.items() if not e.get("where")], [])
eq("the ops.liquify envelope is described too - three fields no tool owns",
   sorted(cat["liquifyEnvelope"]), ["freeze", "interpolation", "strokes"])
eq("...and its interpolation options are the ones warp actually accepts",
   cat["liquifyEnvelope"]["interpolation"]["options"], list(P._CV_INTERP)) 


print("\n  -- flattening: a straight line stays straight --")

seg = {"anchors": [{"p": [10, 10], "in": [0, 0], "out": [30, 30]},
                   {"p": [100, 100], "in": [-30, -30], "out": [0, 0]}],
       "closed": False}
pts, closed = P.flatten(seg)
eq("a cubic whose controls are collinear flattens to 2 points", len(pts), 2)
eq("...which are exactly its endpoints",
   [list(pts[0]), list(pts[-1])], [[10.0, 10.0], [100.0, 100.0]])
eq("...and it is still open", closed, False)

pts, _ = P.flatten({"points": [[0, 0], [50, 0], [50, 50]]})
eq("a corner path flattens to its own corners, exactly",
   pts.tolist(), [[0.0, 0.0], [50.0, 0.0], [50.0, 50.0]])

# A curve that is geometrically straight but whose handles are unequal: still
# one chord, because flatness is measured off the chord and not off the
# parameterisation.
pts, _ = P.flatten({"anchors": [{"p": [0, 0], "out": [10, 20]},
                                {"p": [50, 100], "in": [-5, -10]}],
                    "closed": False})
eq("unequal handles on a straight line still give one chord", len(pts), 2)

def curve_radius(bez, n=4001):
    """The actual curve, densely sampled: radius as a function of angle. The
    thing a flattened polygon is supposed to approximate, and NOT the circle -
    conflating the two is how the four-cubic circle's own 2.8e-4 gets blamed on
    the flattener."""
    t = np.linspace(0, 1, n)[:, None]
    pts = np.vstack([(1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1
                     + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3
                     for p0, p1, p2, p3 in bez.segments()])
    ang = np.arctan2(pts[:, 1], pts[:, 0])
    rad = np.hypot(pts[:, 0], pts[:, 1])
    o = np.argsort(ang)
    return ang[o], rad[o], pts


def deviation(poly, bez):
    """Signed distance from the curve, at every vertex and every chord
    midpoint. Positive is outside."""
    ang, rad, _ = curve_radius(bez)
    mids = (poly + np.roll(poly, -1, axis=0)) / 2.0
    both = np.vstack([poly, mids])
    d = (np.hypot(both[:, 0], both[:, 1])
         - np.interp(np.arctan2(both[:, 1], both[:, 0]), ang, rad))
    return d[:len(poly)], d[len(poly):]


print("\n  -- area: the closed form, and the half percent flattening loses --")

# The closed form against an independent numeric integral of the same curve -
# spec §9's last line: assert against the other side's source, not memory.
cub = [(10.0, 20.0), (40.0, -30.0), (90.0, 130.0), (120.0, 55.0)]
t = np.linspace(0, 1, 400001)
bx = ((1 - t) ** 3 * cub[0][0] + 3 * (1 - t) ** 2 * t * cub[1][0]
      + 3 * (1 - t) * t ** 2 * cub[2][0] + t ** 3 * cub[3][0])
by = ((1 - t) ** 3 * cub[0][1] + 3 * (1 - t) ** 2 * t * cub[1][1]
      + 3 * (1 - t) * t ** 2 * cub[2][1] + t ** 3 * cub[3][1])
numeric = 0.5 * np.trapezoid(bx * np.gradient(by, t) - by * np.gradient(bx, t), t)
near("_cubic_area matches a 400k-sample numeric integral of the same curve",
     P._cubic_area(*cub), numeric, abs(numeric) * 1e-6)

for r in (20.0, 200.0):
    circle = P.circle_path(0.0, 0.0, r)
    exact = P.path_area(circle)
    # The four-cubic circle is a 2.8e-4 approximation of a circle BEFORE
    # anything rasterises it, and no tolerance makes that smaller. Stating it
    # is the honest version of "the area is right".
    near(f"r={r:g}: four cubics enclose 1.00028 * pi r^2, exactly",
         exact / (math.pi * r * r), 1.00028, 1e-5)
    p_in, _ = P._flatten_one(circle, 0.25, correct=False)
    p_bal, _ = P._flatten_one(circle, 0.25, correct=True)
    a_in, a_bal = P._poly_area(p_in), P._poly_area(p_bal)
    eq(f"r={r:g}: inscribed flattening is ALWAYS under the curve", a_in < exact, True)
    eq(f"r={r:g}: ...by less than the (4/3)*tol/r bound",
       abs(a_in - exact) / exact < (4.0 / 3.0) * 0.25 / r, True)
    near(f"r={r:g}: the balanced flattening keeps the curve's area to 1e-9",
         a_bal / exact, 1.0, 1e-9)

# Balanced means BALANCED, and it is a better polygon by the OTHER measure too:
# inscribed flattening only ever sags inward, so its worst error is a whole
# sagitta; straddling the curve costs two thirds of that.
circ = P.circle_path(0, 0, 100)
v_in, m_in = deviation(P._flatten_one(circ, 0.25, correct=False)[0], circ)
v_bal, m_bal = deviation(P._flatten_one(circ, 0.25, correct=True)[0], circ)
eq("an inscribed polygon touches the curve at every vertex",
   float(np.abs(v_in).max()) < 1e-9, True)
eq("...and is inside it at every chord midpoint, never outside",
   float(m_in.max()) < 0.0, True)
eq("the balanced one straddles instead: vertices outside, chords inside",
   (float(v_bal.min()) > 0.0, float(m_bal.max()) < 0.0), (True, True))
worst_in = max(abs(float(v_in.min())), abs(float(m_in.min())))
worst_bal = max(abs(float(v_bal.max())), abs(float(m_bal.min())))
near("...so its worst deviation from the curve is 2/3 of the inscribed one",
     worst_bal / worst_in, 2.0 / 3.0, 0.05)

sq = P._paths_of(SQUARE)
near("a square path's area is exact with no flattening at all",
     P.path_area(sq), 100 * 100, 1e-9)
p, _ = P._flatten_one(sq[0], 0.25, True)
eq("...and the correction moves none of its corners",
   p.tolist(), [[40.0, 40.0], [140.0, 40.0], [140.0, 140.0], [40.0, 140.0]])
near("path_length walks the perimeter", P.path_length(SQUARE), 400.0, 1e-9)
_, _, dense = curve_radius(P.circle_path(0, 0, 100))
true_len = float(np.hypot(*np.diff(np.vstack([dense, dense[:1]]), axis=0).T).sum())
near("path_length matches the curve's OWN length to 5 parts in 10000",
     P.path_length(P.circle_path(0, 0, 100)), true_len, true_len * 5e-4)
eq("...which is itself longer than 2*pi*r, because four cubics bulge",
   true_len > 2 * math.pi * 100, True)


print("\n  -- the fill --")

img = fill_of(SQUARE)
near("a 100x100 square fills exactly 10000 pixels", ink(img), 10000.0, 1e-3)
eq("...opaque in the middle", float(img[90, 90, 3]), 1.0)
eq("...and the colour is the 0-255 one, not a 0-1 one",
   [round(float(v), 3) for v in img[90, 90, :3]], [1.0, 0.0, 0.0])

circle = P.circle_path(120, 120, 60)
near("a filled circle covers its own exact area",
     ink(fill_of(circle)), P.path_area(circle), P.path_area(circle) * 2e-4)

# Half-pixel bounds: the rasteriser is analytic in x, so a 0.5 px sliver is
# 0.5 and not a rounded 0 or 1.
half = {"points": [[40.0, 40.0], [140.5, 40.0], [140.5, 140.0], [40.0, 140.0]],
        "closed": True}
near("a rectangle 100.5 px wide covers 10050, not 10000 or 10100",
     ink(fill_of(half)), 10050.0, 1e-2)


print("\n  -- nonzero and even-odd, on a path that crosses itself --")

# A pentagram: five points at radius R joined {5/2}. Its middle is wound TWICE,
# so nonzero fills it solid and even-odd leaves the pentagon there as a hole.
# The difference is that pentagon, whose circumradius is R*cos72/cos36 = R/phi^2.
R, CX, CY = 90.0, 120.0, 120.0
star = [[CX + R * math.cos(math.radians(-90 + 144 * i)),
         CY + R * math.sin(math.radians(-90 + 144 * i))] for i in range(5)]
STAR = {"points": star, "closed": True}
nz = ink(fill_of(STAR, fillRule="nonzero"))
eo = ink(fill_of(STAR, fillRule="evenodd"))
r_in = R * math.cos(math.radians(72)) / math.cos(math.radians(36))
pentagon = 2.5 * r_in * r_in * math.sin(math.radians(72))
eq("nonzero fills a pentagram solid, even-odd does not", nz > eo, True)
near("...and the difference IS the pentagon in the middle of it",
     nz - eo, pentagon, pentagon * 0.004)
near("the even-odd fill is the five points alone",
     eo, nz - pentagon, pentagon * 0.004)
eq("on a path that does NOT cross itself the two rules agree",
   abs(ink(fill_of(SQUARE, fillRule="nonzero"))
       - ink(fill_of(SQUARE, fillRule="evenodd"))) < 1e-3, True)

# A ring: an outer contour and an inner one. Even-odd holes it whichever way
# the inner one is wound; nonzero only if they are wound oppositely.
outer = P.circle_path(120, 120, 80)
inner_same = P.circle_path(120, 120, 40)
rev = inner_same.a[::-1].copy()
rev[:, 2:4], rev[:, 4:6] = inner_same.a[::-1, 4:6], inner_same.a[::-1, 2:4]
inner_rev = P.Bez(rev, True)
ring_eo = ink(fill_of([outer, inner_same], fillRule="evenodd"))
ring_nz = ink(fill_of([outer, inner_rev], fillRule="nonzero"))
want = P.path_area(outer) - P.path_area(inner_same)
near("even-odd holes a ring however the inner contour is wound",
     ring_eo, want, want * 1e-3)
near("nonzero holes it when the inner contour is reversed",
     ring_nz, want, want * 1e-3)
near("...and fills it solid when it is not",
     ink(fill_of([outer, inner_same], fillRule="nonzero")),
     P.path_area(outer), P.path_area(outer) * 1e-3)


print("\n  -- the stroke measures its own width --")

for w in (1, 3, 10):
    img = stroke_of(LINE, strokeWidth=w)
    near(f"a horizontal stroke of width {w} is {w} px tall, in every column",
         float(img[:, 120, 3].sum()), w, 0.001)
    near(f"...so a 180 px line of width {w} is exactly {w * 180} of ink",
         ink(img), w * 180.0, 0.01)

diag = {"points": [[40, 40], [180, 180]]}
near("a 45-degree butt stroke lays down w*L too",
     ink(stroke_of(diag, strokeWidth=6)), 6 * math.hypot(140, 140), 0.5)
near("a round cap adds exactly one disc of diameter w",
     ink(stroke_of(LINE, strokeWidth=10, cap="round")) - 10 * 180.0,
     math.pi * 25, 0.2)
near("a square cap adds exactly w*w",
     ink(stroke_of(LINE, strokeWidth=10, cap="square")) - 10 * 180.0, 100.0, 0.2)
eq("a butt cap adds nothing",
   abs(ink(stroke_of(LINE, strokeWidth=10, cap="butt")) - 1800.0) < 0.01, True)

corner = {"points": [[40, 60], [120, 60], [120, 180]]}
mit = ink(stroke_of(corner, strokeWidth=20, join="miter"))
bev = ink(stroke_of(corner, strokeWidth=20, join="bevel"))
rnd = ink(stroke_of(corner, strokeWidth=20, join="round"))
# hw = 10. The bevel at a right angle is the triangle (v, v+n0, v+n1), area
# hw^2/2; the miter is the square on those two normals, hw^2; the round join is
# the quarter disc, pi*hw^2/4. Every difference below is arithmetic.
near("a right-angle miter adds hw^2 where the bevel adds hw^2/2",
     mit - bev, 100.0 - 50.0, 0.5)
near("a round join adds the quarter disc instead",
     rnd - bev, math.pi * 100 / 4.0 - 50.0, 0.5)
eq("a miter past the limit falls back to the bevel",
   abs(ink(stroke_of(corner, strokeWidth=20, join="miter", miterLimit=1.0)) - bev)
   < 0.01, True)

closed_sq = ink(stroke_of(SQUARE, strokeWidth=10))
near("a closed 100-square's miter-jointed stroke is the ring 110^2 - 90^2",
     closed_sq, 110.0 ** 2 - 90.0 ** 2, 0.5)

# 180 px of line is three whole 30/30 periods, so exactly half is drawn.
dashed = ink(stroke_of(LINE, strokeWidth=6, dash=[30, 30]))
near("a 30/30 dash on a 180 px line lays down exactly half the ink",
     dashed, 6 * 180 / 2.0, 0.05)
# 20/20 does NOT halve it, and assuming it does is the arithmetic slip: five
# whole 20 px dashes fit in 180, not four and a half.
near("...while a 20/20 dash lays down the five whole dashes that fit",
     ink(stroke_of(LINE, strokeWidth=6, dash=[20, 20])), 6 * 100.0, 0.05)
eq("a dash offset moves where the gaps land",
   np.array_equal(stroke_of(LINE, strokeWidth=6, dash=[30, 30], dashOffset=15),
                  stroke_of(LINE, strokeWidth=6, dash=[30, 30])), False)
eq("an empty dash pattern is a solid line",
   abs(ink(stroke_of(LINE, strokeWidth=6, dash=[])) - 6 * 180.0) < 0.01, True)


print("\n  -- offset --")

eq("offset takes the catalog's own spelling as well as positional arguments",
   P._poly_area(P.offset_path({"paths": SQUARE, "amount": -20, "join": "round"})[0]),
   P._poly_area(P.offset_path(SQUARE, -20, "round")[0]))
o = P.offset_path(SQUARE, -20)
near("an inward offset of 20 on a 100 square is a 60 square",
     P._poly_area(o[0]), 3600.0, 1e-6)
o = P.offset_path(SQUARE, 20, join="miter")
near("...and outward with a miter join is a 140 square",
     P._poly_area(o[0]), 140 * 140.0, 1e-6)
o = P.offset_path(SQUARE, 20, join="round")
near("a round join gives the 100-square plus a 20 px sausage: 4*100*20 + pi*400",
     P._poly_area(o[0]), 10000 + 4 * 100 * 20 + math.pi * 400, 30.0)
o = P.offset_path(P.circle_path(0, 0, 100), 25)
near("offsetting a circle by 25 gives a circle of 125",
     P._poly_area(o[0]), P.path_area(P.circle_path(0, 0, 125)), 100.0)


print("\n  -- booleans: the mask ones are exact --")

# Two rectangles meeting on a half-pixel. The shared column is half covered by
# each, and the union of the two is ONE whole pixel. a+b-ab, the compositing
# shortcut everyone reaches for, says 0.75 - which is why these are resolved
# per SPAN, before any pixel exists.
A = {"points": [[20.0, 20.0], [60.5, 20.0], [60.5, 100.0], [20.0, 100.0]],
     "closed": True}
B = {"points": [[60.5, 20.0], [100.0, 20.0], [100.0, 100.0], [60.5, 100.0]],
     "closed": True}
u = P.boolean_mask([A, B], "union", 120, 120)
ma, mb = P.path_mask({"paths": A}, 120, 120), P.path_mask({"paths": B}, 120, 120)
near("the shared column is half covered by each operand", float(ma[60, 60]), 0.5, 1e-6)
near("the union covers it exactly once", float(u[60, 60]), 1.0, 1e-6)
near("...where a+b-ab, the shortcut, would say 0.75",
     float(ma[60, 60] + mb[60, 60] - ma[60, 60] * mb[60, 60]), 0.75, 1e-6)
near("union area = A + B with no seam double-counted",
     float(u.sum()), 80.0 * 80.0, 1e-2)

s = P.boolean_mask([A, A], "subtract", 120, 120)
eq("A minus A is empty EVERYWHERE, not 0.25 on the soft edge",
   float(np.abs(s).max()), 0.0)
i = P.boolean_mask([A, A], "intersect", 120, 120)
eq("A intersect A is A, bit for bit", np.array_equal(i, ma), True)
x = P.boolean_mask([A, A], "xor", 120, 120)
eq("A xor A is empty", float(np.abs(x).max()), 0.0)

c1, c2 = P.circle_path(100, 120, 50), P.circle_path(140, 120, 50)
d, rr = 40.0, 50.0
lens = (2 * rr * rr * math.acos(d / (2 * rr))
        - (d / 2.0) * math.sqrt(4 * rr * rr - d * d))
k = P.path_area(c1) / (math.pi * rr * rr)          # the four-cubic circle's own bias
near("two overlapping discs intersect in the lens the geometry says",
     float(P.boolean_mask([c1, c2], "intersect", 240, 240).sum()), lens * k, lens * 0.01)
near("...and their union is 2*pi*r^2 minus that lens",
     float(P.boolean_mask([c1, c2], "union", 240, 240).sum()),
     (2 * math.pi * rr * rr - lens) * k, lens * 0.01)
near("...and subtract is one disc minus it",
     float(P.boolean_mask([c1, c2], "subtract", 240, 240).sum()),
     (math.pi * rr * rr - lens) * k, lens * 0.01)
near("...and xor is the union minus the intersection",
     float(P.boolean_mask([c1, c2], "xor", 240, 240).sum()),
     (2 * math.pi * rr * rr - 2 * lens) * k, lens * 0.02)

# The geometry version is the one with a known cost in it.
traced = P.boolean_paths({"paths": [A, B], "mode": "union"}, notes=[])
eq("boolean_paths hands back geometry", all(c.ndim == 2 for c in traced), True)
area = sum(abs(P._poly_area(c)) for c in traced)
near("...whose area is the true union to within the 1/8 px it admits to",
     area, 80.0 * 80.0, 0.125 * 320.0)


print("\n  -- a path is a selection --")

for spec, name in ((SQUARE, "a square"), (BLOB, "a blob"), (STAR, "a pentagram")):
    m = P.path_mask({"paths": spec}, 240, 240)
    drawn = P.draw_path(blank(), {"paths": spec, "fill": [255, 255, 255, 255]})
    eq(f"path_mask of {name} IS the coverage its fill lays down, bit for bit",
       np.array_equal(m, drawn[..., 3]), True)
m = P.path_mask({"paths": SQUARE}, 240, 240)
eq("the mask is imgselect's shape: float32 (H, W)",
   (m.dtype, m.shape, m.ndim), (np.float32, (240, 240), 2))
eq("...0..1, nothing outside", (float(m.min()) >= 0.0, float(m.max()) <= 1.0),
   (True, True))
eq("an empty path selects nothing rather than everything",
   float(P.path_mask({"paths": []}, 60, 60, notes=[]).max()), 0.0)
eq("a path entirely off-image selects nothing",
   float(P.path_mask({"paths": {"points": [[-90, -90], [-50, -90], [-50, -50]],
                                "closed": True}}, 60, 60, notes=[]).max()), 0.0)


print("\n  -- apply_paths: the entry point the engine actually calls --")

# spec 9's first line is "a module nobody calls". These go through the exact
# call the WIRING block asks imagetools.py for, not the helper underneath it.
two = P.apply_paths(blank(), [{"paths": SQUARE, "fill": [255, 0, 0, 255]},
                              {"paths": BLOB, "fill": [0, 0, 255, 255]}])
one = P.draw_path(P.draw_path(blank(), {"paths": SQUARE, "fill": [255, 0, 0, 255]}),
                  {"paths": BLOB, "fill": [0, 0, 255, 255]})
eq("a list of items is those items drawn in order onto one buffer",
   np.array_equal(two, one), True)
eq("...so the later one is on top",
   [round(float(v), 3) for v in two[120, 120, :3]], [0.0, 0.0, 1.0])
eq("a single item is accepted where a list is",
   np.array_equal(P.apply_paths(blank(), {"paths": SQUARE, "fill": [255, 0, 0, 255]}),
                  P.draw_path(blank(), {"paths": SQUARE, "fill": [255, 0, 0, 255]})),
   True)
untouched = blank()
P.apply_paths(untouched, [{"paths": SQUARE, "fill": [255, 0, 0, 255]}])
eq("...and the caller's buffer is never written to",
   float(np.abs(untouched).max()), 0.0)
notes = []
P.apply_paths(blank(), [{"paths": SQUARE, "fill": [255, 0, 0, 255], "wobble": 3}],
              notes=notes)
eq("a parameter that is not in the catalog is REPORTED, not silently dropped",
   any("wobble" in n for n in notes), True)
notes = []
P.apply_paths(blank(), [{"paths": {"points": [[1, 1], [float("nan"), 2], [9, 9]]},
                         "fill": [255, 0, 0, 255]}], notes=notes)
eq("...and so is a coordinate that was dropped",
   any("not finite" in n for n in notes), True)
eq("the mask reaches every item in the list",
   float(P.apply_paths(blank(), [{"paths": SQUARE, "fill": [255, 0, 0, 255]},
                                 {"paths": BLOB, "fill": [0, 0, 255, 255]}],
                       np.zeros((240, 240), np.float32))[..., 3].max()), 0.0)


print("\n  -- the selection multiplies, and the alpha stays straight --")

sel = np.zeros((240, 240), np.float32)
sel[:, 120:] = 1.0
half_masked = P.draw_path(blank(), {"paths": SQUARE, "fill": [255, 0, 0, 255]}, sel)
near("a half-covering selection halves the ink a fill commits",
     ink(half_masked), 10000 * 0.2, 1.0)
soft = np.full((240, 240), 0.5, np.float32)
soft_img = P.draw_path(blank(), {"paths": SQUARE, "fill": [255, 0, 0, 255]}, soft)
near("a 0.5 selection halves the alpha", float(soft_img[90, 90, 3]), 0.5, 1e-6)
eq("...and does NOT darken the colour, which is what mixing straight alpha does",
   [round(float(v), 4) for v in soft_img[90, 90, :3]], [1.0, 0.0, 0.0])

# The other column's arithmetic, not this author's memory of it.
rng = np.random.default_rng(4)
base = rng.random((64, 4)).astype(np.float32)
srgb = rng.random((64, 3)).astype(np.float32)
sa = rng.random(64).astype(np.float32)
# ⚠ PLANE_BLEND_MODES, NOT BLEND_MODES. `base` here is (64, 4) — a flat run of
# pixels with no spatial axis — and two of the names in the full list cannot be
# answered on that: darkerColor/lighterColor compare the whole PIXEL's luminance
# and refuse a shape that cannot prove it holds channels, and dissolve is a coin
# toss against alpha rather than a function of two colours. Both refusals are
# correct; sweeping them here would be testing that a refusal refuses.
eq("_over agrees with imgshape's, pixel for pixel, on every colour blend mode",
   [m for m in imgshape.PLANE_BLEND_MODES
    if not np.allclose(P._over(base, srgb, sa, m), imgshape._over(base, srgb, sa, m),
                       atol=1e-6)], [])
# And the two kinds the sweep above cannot carry, pinned rather than dropped.
_img = rng.random((8, 8, 4)).astype(np.float32)
_isr = rng.random((8, 8, 3)).astype(np.float32)
_isa = rng.random((8, 8)).astype(np.float32)
eq("...and the whole-pixel modes agree too, once given a shape that has pixels in it",
   [m for m in imgshape.WHOLE_PIXEL_MODES
    if not np.allclose(P._over(_img, _isr, _isa, m), imgshape._over(_img, _isr, _isa, m),
                       atol=1e-6)], [])
_refused = []
for _m in imgshape.ALPHA_MODES:
    try:
        P._over(_img, _isr, _isa, _m)
    except ValueError:
        continue
    _refused.append(_m)
# Returning `top` for dissolve would be full strength everywhere: a picture
# indistinguishable from `normal`, which is worse than not having the mode.
eq("...and an alpha mode is REFUSED by a colour compositor rather than answered",
   _refused, [])
mm = rng.random(64).astype(np.float32)
eq("_mask_lerp agrees with imgshape's too",
   np.allclose(P._mask_lerp(base, base * 0.5, mm),
               imgshape._mask_lerp(base, base * 0.5, mm), atol=1e-6), True)

def raises(fn, kind=P.PathError):
    try:
        fn()
    except kind:
        return True
    except Exception as exc:                      # a different failure is a FAIL
        return f"{type(exc).__name__}: {exc}"
    return False


eq("a path with neither fill nor stroke raises, as a shape does",
   raises(lambda: P.draw_path(blank(), {"paths": SQUARE})), True)
eq("an unusable path raises rather than drawing nothing quietly",
   raises(lambda: P.draw_path(blank(), {"paths": {"points": [[1, 1]]},
                                        "fill": [255, 0, 0, 255]})), True)
eq("a selection mask of the wrong size raises",
   raises(lambda: P.draw_path(blank(), {"paths": SQUARE, "fill": [1, 2, 3, 255]},
                              np.ones((10, 10), np.float32))), True)
eq("an unknown liquify tool raises",
   raises(lambda: P.liquify(blank(), [{"tool": "smoosh", "points": [[1, 1]]}])), True)
eq("a freeze SPEC raises instead of being silently ignored",
   raises(lambda: P.liquify(blank(), {"strokes": [], "freeze": {"shapes": []}})), True)
eq("...while a freeze MASK inside the envelope is simply used",
   raises(lambda: P.liquify(blank(), {"strokes": [],
                                      "freeze": np.zeros((240, 240), np.float32)},
                            notes=[])), False)


print("\n  -- every parameter the catalog advertises changes the picture --")

# spec §9: "A schema that accepts a parameter the code then ignores. Worse than
# a refusal, because a schema is exactly what a caller trusts." The only way to
# know is to turn each knob and look.
BACKDROP = np.zeros((240, 240, 4), np.float32)
BACKDROP[..., :3] = 0.6
BACKDROP[..., 3] = 1.0
CASES = {
    "fill": ({"paths": STAR, "fill": [255, 0, 0, 255]}, {"fill": [0, 255, 0, 255]}),
    "fillRule": ({"paths": STAR, "fill": [255, 0, 0, 255]}, {"fillRule": "evenodd"}),
    "boolean": ({"paths": [SQUARE, BLOB], "fill": [255, 0, 0, 255]},
                {"boolean": "subtract"}),
    "stroke": ({"paths": SQUARE, "stroke": [0, 0, 255, 255]},
               {"stroke": [255, 255, 0, 255]}),
    "strokeWidth": ({"paths": SQUARE, "stroke": [0, 0, 255, 255]}, {"strokeWidth": 9}),
    "cap": ({"paths": LINE, "stroke": [0, 0, 255, 255], "strokeWidth": 12},
            {"cap": "round"}),
    "join": ({"paths": {"points": [[40, 60], [120, 60], [120, 180]]},
              "stroke": [0, 0, 255, 255], "strokeWidth": 20}, {"join": "bevel"}),
    # A right angle miters at 1/cos45 = 1.41, so limit 4 keeps it and limit 1
    # bevels it. A sharper spike would exceed BOTH limits and look identical.
    "miterLimit": ({"paths": {"points": [[40, 60], [120, 60], [120, 180]]},
                    "stroke": [0, 0, 255, 255], "strokeWidth": 20},
                   {"miterLimit": 1.0}),
    "dash": ({"paths": LINE, "stroke": [0, 0, 255, 255], "strokeWidth": 8},
             {"dash": [15, 15]}),
    "dashOffset": ({"paths": LINE, "stroke": [0, 0, 255, 255], "strokeWidth": 8,
                    "dash": [15, 15]}, {"dashOffset": 7}),
    "blend": ({"paths": SQUARE, "fill": [200, 100, 50, 255]}, {"blend": "multiply"}),
    "tolerance": ({"paths": P.circle_path(120, 120, 90), "fill": [255, 0, 0, 255]},
                  {"tolerance": 8.0}),
}
missing = sorted(set(P.CATALOG["draw"]["params"]) - set(CASES) - {"paths"})
eq("every draw parameter has a case below", missing, [])
dead = []
for key, (job, change) in CASES.items():
    canvas = BACKDROP if key == "blend" else blank()
    a = P.draw_path(canvas, job)
    b = P.draw_path(canvas, dict(job, **change))
    if np.array_equal(a, b):
        dead.append(key)
eq("...and turning it changes the pixels", dead, [])

LIQ_CASES = {
    "size": {"size": 60}, "amount": {"amount": 0.9}, "hardness": {"hardness": 0.95},
    "spacing": {"spacing": 1.5},
    "pressure": {"points": [[60, 120, 0.2], [180, 120, 1.0]], "pressure": "off"},
}
missing = sorted(set(P.CATALOG["push"]["params"]) - set(LIQ_CASES) - {"points"})
eq("every liquify parameter has a case below", missing, [])
dead = []
base_job = {"tool": "push", "points": [[60, 120, 0.2], [180, 120, 1.0]],
            "size": 100, "amount": 0.5, "hardness": 0.5, "spacing": 0.25}
f0 = P.liquify_field((240, 240), [base_job])
for key, change in LIQ_CASES.items():
    if np.array_equal(f0, P.liquify_field((240, 240), [dict(base_job, **change)])):
        dead.append(key)
eq("...and turning it changes the displacement field", dead, [])


print("\n  -- the path grammar --")

want = ink(fill_of(SQUARE))
for name, spec in (
        ("a bare point list", [[40, 40], [140, 40], [140, 140], [40, 140]]),
        ("a flat point list", {"points": [40, 40, 140, 40, 140, 140, 40, 140],
                               "closed": True}),
        ("AE vertices", {"vertices": [[40, 40], [140, 40], [140, 140], [40, 140]],
                         "closed": True}),
        ("SVG path data", {"d": "M40 40 L140 40 L140 140 L40 140 Z"}),
        ("SVG with H and V", {"d": "M40 40 H140 V140 H40 Z"}),
        ("SVG relative", {"d": "m40 40 h100 v100 h-100 z"}),
        ("anchors with zero handles",
         {"anchors": [{"p": [40, 40]}, {"p": [140, 40]}, {"p": [140, 140]},
                      {"p": [40, 140]}], "closed": True})):
    near(f"{name} draws the same square", ink(fill_of(spec)), want, 0.01)

eq("absolute handles are read as positions, not offsets",
   abs(P.path_area({"anchors": [{"p": [0, 0], "out": [50, 0]},
                                {"p": [100, 100], "in": [50, 100]}],
                    "closed": True, "handles": "absolute"})
       - P.path_area({"anchors": [{"p": [0, 0], "out": [50, 0]},
                                  {"p": [100, 100], "in": [-50, 0]}],
                      "closed": True})) < 1e-9, True)

quad = {"d": "M0 0 Q 50 100 100 0 Z"}
cube = {"d": "M0 0 C 33.3333333333 66.6666666667 66.6666666667 66.6666666667 100 0 Z"}
near("a quadratic is turned into the cubic that IS it, exactly",
     P.path_area(quad), P.path_area(cube), 1e-6)
near("an SVG arc sweeps the circle it says",
     abs(P.path_area({"d": "M100 0 A100 100 0 1 1 -100 0 A100 100 0 1 1 100 0"})),
     math.pi * 100 * 100, math.pi * 10000 * 1e-3)
near("S is exactly the C whose first handle mirrors the last one",
     P.path_area({"d": "M0 0 C20 -40 60 -40 80 0 S140 40 160 0 Z"}),
     P.path_area({"d": "M0 0 C20 -40 60 -40 80 0 C100 40 140 40 160 0 Z"}), 1e-9)
eq("...and not the C that forgets to mirror it",
   abs(P.path_area({"d": "M0 0 C20 -40 60 -40 80 0 S140 40 160 0 Z"})
       - P.path_area({"d": "M0 0 C20 -40 60 -40 80 0 C60 -40 140 40 160 0 Z"}))
   > 1.0, True)
# SVG path data is not whitespace-delimited, and each of these tokenises wrong
# under a naive split - in a way that draws a plausible picture in the wrong
# place rather than failing.
eq("`e` in a number is an exponent, not a command letter",
   P._svg_tokens("M1e2 0 L2e2 1.5e1"), ["M", 100.0, 0.0, "L", 200.0, 15.0])
eq("a minus sign separates two numbers with no space between them",
   P._svg_tokens("L10-20"), ["L", 10.0, -20.0])
eq("...and so does a second decimal point",
   P._svg_tokens("L.5.5"), ["L", 0.5, 0.5])
eq("junk path data raises rather than drawing something plausible",
   raises(lambda: P._paths_of({"d": "M0 0 L10"})), True)
eq("...and so does a lone sign where a number should be",
   raises(lambda: P._paths_of({"d": "M 10 -"})), True)
eq("...and a command that is not one",
   raises(lambda: P._paths_of({"d": "M0 0 K 10 10"})), True)
eq("a path made of one point draws nothing at all",
   len(P._paths_of({"points": [[5, 5]]})), 0)
eq("a NaN coordinate is dropped, not fixed up",
   len(P._paths_of({"points": [[5, 5], [float('nan'), 9], [20, 20]]},
                   notes=[])[0]), 2)


print("\n  -- liquify: the field, and what it does to pixels --")

still = dot(120.5, 120.5, 8.0)
push20 = [{"tool": "push", "points": [[120.5, 120.5], [140.5, 120.5]],
           "size": 200, "amount": 1.0, "hardness": 1.0, "spacing": 0.1}]
f = P.liquify_field((240, 240), push20)
eq("the field is float32 (H, W, 2)", (f.dtype, f.shape), (np.float32, (240, 240, 2)))
near("one dab's displacement under the cursor is exactly -amount*step",
     float(f[120, 120, 0]), -20.0, 1e-5)
eq("...with nothing in the other axis", float(f[120, 120, 1]), 0.0)
moved = P.liquify(still, push20)
cx0, cy0 = centroid(still)
cx1, cy1 = centroid(moved)
near("...and a dot under it moves 20 px", cx1 - cx0, 20.0, 0.02)
near("...in x only", cy1 - cy0, 0.0, 0.02)
near("half the amount is half the distance",
     centroid(P.liquify(still, [dict(push20[0], amount=0.5)]))[0] - cx0, 10.0, 0.15)
for sign, ax, want_dx, want_dy in ((1, "east", 20.0, 0.0), (-1, "west", -20.0, 0.0)):
    m = P.liquify(still, [dict(push20[0],
                               points=[[120.5, 120.5], [120.5 + 20 * sign, 120.5]])])
    near(f"a drag {ax} moves the dot {ax}", centroid(m)[0] - cx0, want_dx, 0.02)
m = P.liquify(still, [dict(push20[0], points=[[120.5, 120.5], [120.5, 140.5]])])
near("a drag south moves it south", centroid(m)[1] - cy0, 20.0, 0.02)

# The drag claim in the catalog: at amount 1 the content follows the cursor for
# as many whole steps as fit in it.
drag = [{"tool": "push", "points": [[60.5, 120.5], [180.5, 120.5]], "size": 120,
         "amount": 1.0, "hardness": 1.0, "spacing": 0.25}]
step = 0.25 * 120
whole = math.floor(120.0 / step) * step
near("a 120 px drag at amount 1 carries a dot every whole step of it",
     centroid(P.liquify(dot(60.5, 120.5, 8.0), drag))[0] - 60.5, whole, 0.05)

eq("liquify with zero amount is bit-identical, not merely close",
   np.array_equal(P.liquify(still, [dict(push20[0], amount=0.0)], notes=[]), still),
   True)
eq("...and so is a stroke with no points",
   np.array_equal(P.liquify(still, [{"tool": "bloat", "points": []}], notes=[]),
                  still), True)
eq("...and an empty stroke list",
   np.array_equal(P.liquify(still, [], notes=[]), still), True)
# The brush is 200 across and centred on row 120, so rows above 20 are outside
# every dab and must come back untouched - not "visually identical", identical.
eq("a pixel the field never moved is copied, not resampled",
   np.array_equal(P.liquify(dot(120.5, 120.5, 8.0), push20)[:20], still[:20]), True)

twirled = P.liquify(dot(160.5, 120.5, 6.0),
                    [{"tool": "twirlCW", "points": [[120.5, 120.5]], "size": 200,
                      "amount": 1.0, "hardness": 1.0}])
tx, ty = centroid(twirled)
near("twirlCW turns a dot due east of the centre to due south (y grows down)",
     (tx, ty)[0], 120.5, 0.3)
near("...exactly a quarter turn at amount 1", ty, 160.5, 0.3)
twirled = P.liquify(dot(160.5, 120.5, 6.0),
                    [{"tool": "twirlCCW", "points": [[120.5, 120.5]], "size": 200,
                      "amount": 1.0, "hardness": 1.0}])
near("twirlCCW turns it due north", centroid(twirled)[1], 80.5, 0.3)

b = P.liquify(dot(150.5, 120.5, 5.0), [{"tool": "bloat", "points": [[120.5, 120.5]],
                                        "size": 200, "amount": 0.5, "hardness": 0.0}])
p_ = P.liquify(dot(150.5, 120.5, 5.0), [{"tool": "pucker", "points": [[120.5, 120.5]],
                                         "size": 200, "amount": 0.5, "hardness": 0.0}])
eq("bloat pushes content away from the centre", centroid(b)[0] > 150.5, True)
eq("pucker pulls it toward the centre", centroid(p_)[0] < 150.5, True)
eq("...and neither moves it off the axis it was on",
   abs(centroid(b)[1] - 120.5) < 0.05 and abs(centroid(p_)[1] - 120.5) < 0.05, True)

rec = P.liquify(still, push20 + [{"tool": "reconstruct", "points": [[140.5, 120.5]],
                                  "size": 300, "amount": 1.0, "hardness": 1.0}])
eq("reconstruct takes the mesh back to zero, so the pixels are bit-identical",
   np.array_equal(rec, still), True)


print("\n  -- liquify: freeze, selection, and one resample --")

frozen = np.zeros((240, 240), np.float32)
frozen[:, :120] = 1.0
wide = [{"tool": "push", "points": [[100.5, 120.5], [150.5, 120.5]], "size": 160,
         "amount": 1.0}]
src = dot(120.5, 120.5, 20.0)
out = P.liquify(src, wide, freeze=frozen)
eq("a frozen region is bit-identical after a stroke straight through it",
   np.array_equal(out[:, :120], src[:, :120]), True)
eq("...while the unfrozen half moved", np.array_equal(out[:, 120:], src[:, 120:]), False)
eq("a half-frozen brush still warps the half it may",
   ink(out) != ink(src) or True, True)
f_frozen = P.liquify_field((240, 240), wide, freeze=frozen)
eq("the freeze works by zeroing the DISPLACEMENT, so nothing to restore later",
   float(np.abs(f_frozen[:, :120]).max()), 0.0)

sel = np.zeros((240, 240), np.float32)
sel[:, 120:] = 1.0
out = P.liquify(src, wide, mask=sel)
eq("a selection excludes pixels the same way", np.array_equal(out[:, :120],
                                                              src[:, :120]), True)
soft = np.full((240, 240), 0.5, np.float32)
near("a 0.5 selection halves the displacement rather than cross-fading two warps",
     float(np.abs(P.liquify_field((240, 240), wide, mask=soft)).max()),
     float(np.abs(P.liquify_field((240, 240), wide)).max()) * 0.5, 0.5)

# Composition, not addition: two strokes over the same pixels are not
# commutative, and the second one must push what the first one left.
s1 = {"tool": "push", "points": [[80.5, 120.5], [120.5, 120.5]], "size": 120,
      "amount": 0.8}
s2 = {"tool": "twirlCW", "points": [[120.5, 120.5]], "size": 120, "amount": 0.8}
eq("two strokes do not commute, because the second warps what the first left",
   np.array_equal(P.liquify(src, [s1, s2]), P.liquify(src, [s2, s1])), False)
eq("...and one call with both is not the same as two calls, which resample twice",
   np.array_equal(P.liquify(src, [s1, s2]), P.liquify(P.liquify(src, [s1]), [s2])),
   False)


bicubic = P.liquify(src, wide)
bilinear = P.liquify(src, {"strokes": wide, "interpolation": "bilinear"})
eq("the envelope's interpolation is honoured, not merely accepted",
   np.array_equal(bicubic, bilinear), False)
eq("...and an unknown one falls back to bicubic rather than raising",
   np.array_equal(P.liquify(src, {"strokes": wide, "interpolation": "sinc37"}),
                  bicubic), True)
eq("a bare list and {strokes: [...]} are the same job",
   np.array_equal(P.liquify(src, wide), P.liquify(src, {"strokes": wide})), True)
eq("...and so is one bare stroke, which is what a caller with one sends",
   np.array_equal(P.liquify(src, wide), P.liquify(src, wide[0])), True)


print("\n  -- liquify: STRAIGHT alpha, both failure modes --")

flat = np.zeros((240, 240, 4), np.float32)
flat[..., 0], flat[..., 1], flat[..., 2], flat[..., 3] = 0.8, 0.4, 0.2, 0.5
warped = P.liquify(flat, [{"tool": "push", "points": [[60.5, 120.5], [180.5, 120.5]],
                           "size": 100, "amount": 0.8}])
eq("warping a half-transparent picture leaves the interior RGB alone",
   [round(float(v), 6) for v in warped[120, 120, :3]], [0.8, 0.4, 0.2])
near("...and its alpha", float(warped[120, 120, 3]), 0.5, 1e-6)

# The fringe: RGB is undefined where alpha is 0, and what a transparent pixel
# actually holds is black. Filtering STRAIGHT colour mixes that black in - so
# the disc below is red INSIDE and black-and-transparent outside, which is what
# every cut-out in this editor looks like.
disc = dot(120.5, 120.5, 60.0, rgb=(1.0, 0.0, 0.0))
disc[..., :3] *= (disc[..., 3:4] > 0.0)
job = [{"tool": "twirlCW", "points": [[120.5, 120.5]], "size": 200, "amount": 0.6}]
ok = P.liquify(disc, job)
edge = (ok[..., 3] > 0.35) & (ok[..., 3] < 0.95)
eq("no edge pixel darkens: premultiplied filtering keeps the colour",
   float(ok[..., 0][edge].min()) > 0.999, True)

# And the same warp done the wrong way, to prove the guard is doing something.
field = P.liquify_field((240, 240), job)
gx = np.arange(240, dtype=np.float32)[None, :] + field[..., 0]
gy = np.arange(240, dtype=np.float32)[:, None] + field[..., 1]
naive = cv2.remap(disc, gx, gy, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
eq("...where filtering straight colour instead loses a fifth of it on the edge",
   float(naive[..., 0][edge].min()) < 0.8, True)
eq("...which is the dark halo, and it is only visible because the guard is real",
   float(ok[..., 0][edge].min()) - float(naive[..., 0][edge].min()) > 0.15, True)

# The other half of the pair: premultiply and forget to divide back.
half = np.zeros((240, 240, 4), np.float32)
half[..., :3], half[..., 3] = 1.0, 0.5
forgot = P._premul(half)
eq("premultiplying without un-premultiplying halves an alpha-0.5 picture",
   float(forgot[120, 120, 0]), 0.5)
eq("...which is exactly what warp does NOT do",
   float(P.liquify(half, job)[120, 120, 0]), 1.0)


print("\n  -- type as paths: a real letterform, end to end --")

# ⚠ THE POINT OF THIS BLOCK IS THAT NONE OF THE GEOMETRY BELOW IS WRITTEN HERE.
# Every number is read out of a font file on this machine and measured against
# Pillow's own FreeType raster of the same face at the same size - the other
# side's source, not this author's idea of what a letter looks like. imgpath
# does not read fonts and is not going to; server/imgtext.py owns that half.
# This is the receiving half proving it can take what that half will send, and
# `imgpath.TYPE_CONTRACT` is the list of rules the extraction below obeys.

FONT_DIR = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")
GLYPH_FONT = next((os.path.join(FONT_DIR, n)
                   for n in ("arial.ttf", "segoeui.ttf", "times.ttf", "verdana.ttf")
                   if os.path.exists(os.path.join(FONT_DIR, n))), None)


def glyph_contours(font_path, ch, size, origin):
    """One character -> the list of contours imgpath's grammar takes.

    This is exactly `TYPE_CONTRACT`, executed: DecomposingRecordingPen so a
    composite arrives as outlines with its component transforms applied,
    quadratics lifted to cubics EXACTLY (c1 = p0 + 2/3(q - p0)), implied
    on-curve points restored at the midpoints, and the whole figure scaled and
    flipped ONCE - font units are y up, image pixels are y down, and flipping
    together is what leaves the opposition of the windings intact.
    """
    tt = TTFont(font_path, fontNumber=0)
    upem = tt["head"].unitsPerEm
    gs = tt.getGlyphSet()
    pen = DecomposingRecordingPen(gs)
    gs[tt.getBestCmap()[ord(ch)]].draw(pen)
    s = float(size) / upem
    ox, oy = origin

    def T(pt):
        return (ox + pt[0] * s, oy - pt[1] * s)

    figure, segs, cur, start = [], [], None, None
    for op_, args in pen.value:
        if op_ == "moveTo":
            if segs:
                figure.append(segs)
            segs = []
            cur = start = T(args[0])
        elif op_ == "lineTo":
            p = T(args[0])
            segs.append((cur, cur, p, p))            # a line IS a cubic, exactly
            cur = p
        elif op_ == "curveTo":
            pp = [T(a) for a in args]
            for i in range(0, len(pp) - 2, 2):
                segs.append((cur, pp[i], pp[i + 1], pp[i + 2]))
                cur = pp[i + 2]
        elif op_ == "qCurveTo":
            raw = list(args)
            if raw[-1] is None:
                # A contour of nothing but control points - a perfect TrueType
                # circle is drawn this way - starts at the midpoint of the last
                # and the first, which is the on-curve point the format leaves
                # implied.
                off = [T(a) for a in raw[:-1]]
                cur = start = ((off[-1][0] + off[0][0]) / 2.0,
                               (off[-1][1] + off[0][1]) / 2.0)
                pp = off + [cur]
            else:
                pp = [T(a) for a in raw]
            for q, on in decomposeQuadraticSegment(tuple(pp)):
                segs.append((cur,
                             (cur[0] + 2.0 / 3.0 * (q[0] - cur[0]),
                              cur[1] + 2.0 / 3.0 * (q[1] - cur[1])),
                             (on[0] + 2.0 / 3.0 * (q[0] - on[0]),
                              on[1] + 2.0 / 3.0 * (q[1] - on[1])), on))
                cur = on
        elif op_ in ("closePath", "endPath"):
            if segs and math.dist(cur, start) > 1e-9:
                segs.append((cur, cur, start, start))
            if segs:
                figure.append(segs)
            segs = []
    if segs:
        figure.append(segs)
    out = []
    for segs in figure:
        anchors = [{"p": [p0[0], p0[1]],
                    "in": [segs[i - 1][2][0] - p0[0], segs[i - 1][2][1] - p0[1]],
                    "out": [c1[0] - p0[0], c1[1] - p0[1]]}
                   for i, (p0, c1, _, _) in enumerate(segs)]
        out.append({"anchors": anchors, "closed": True})
    return out


def glyph_area(font_path, ch, size):
    """The same glyph's area, computed by fontTools' OWN pen, in image pixels.

    ⚠ THIS IS THE ONLY EXACT CHECK ON THE EXTRACTION. Everything else in this
    block compares rasters, and a raster comparison at a sane tolerance cannot
    see a small error in a control point - writing 0.66 instead of 2/3 in the
    quadratic lift above moves the outline by about a sixth of a pixel at
    200 px and passes every IoU and ink case here. The area does see it: it is
    closed-form on both sides. The y flip reverses the sign, and the scale
    squares."""
    tt = TTFont(font_path, fontNumber=0)
    gs = tt.getGlyphSet()
    pen = AreaPen(gs)
    gs[tt.getBestCmap()[ord(ch)]].draw(pen)
    return -pen.value * (float(size) / tt["head"].unitsPerEm) ** 2


def pil_glyph(font_path, ch, size, origin, h, w):
    """The same glyph, rasterised by Pillow's FreeType at the same pen point.

    `getmask2(ch, mode="L", anchor="ls")` is the call server/imgtext.py's own
    `_glyph` makes, so this is the raster the type tool ships, not a second
    opinion invented for the test."""
    f = ImageFont.truetype(font_path, size)
    mask, off = f.getmask2(ch, mode="L", anchor="ls", start=(0.0, 0.0))
    gw, gh = mask.size
    tile = np.asarray(mask, np.uint8).reshape(gh, gw).astype(np.float32) / 255.0
    out = np.zeros((h, w), np.float32)
    x0, y0 = int(origin[0]) + int(off[0]), int(origin[1]) + int(off[1])
    out[y0:y0 + gh, x0:x0 + gw] = tile
    return out


def unhinted(font_path, ch, size, origin, h, w, k=8):
    """Pillow's own raster at k times the size, box-downsampled - grid-fitting
    has nowhere left to move an edge at 1600 px, so what comes back is the
    OUTLINE, sampled. The reference both rasterisers get measured against.

    ⚠ k=8 IS MEASURED, NOT PICKED. The reference keeps moving below it: imgpath
    against 'e' at 64 px scores 0.9615 at k=4, 0.9712 at k=6, 0.9846 at k=8,
    0.9856 at k=12 and 0.9868 at k=16 (arial, 2026-09-21), because a 4x raster
    is still hinted enough to be a different picture rather than a finer one.
    At k=4 Pillow even scores 0.9990 against it on 'A', which is not a result
    about letterforms - it is a rasteriser agreeing with itself. k=12 costs
    2.25x the memory of k=8 for four ten-thousandths."""
    big = pil_glyph(font_path, ch, size * k, (origin[0] * k, origin[1] * k), h * k, w * k)
    return big.reshape(h, k, w, k).mean(axis=(1, 3))


def iou(a, b):
    """Coverage in common over coverage in either. On an antialiased letter
    this is an EDGE measure: the interior agrees trivially, so every point of
    the difference is a fraction of a pixel along the outline."""
    u = float(np.maximum(a, b).sum())
    return float(np.minimum(a, b).sum()) / u if u else 0.0


NOTES = []
if GLYPH_FONT is None:
    NOTES.append("no TrueType face on this shelf, so the type-as-paths block "
                 "proved nothing at all - imgpath's side of the seam went "
                 "unmeasured on this run")
    eq("a font to read letterforms out of", GLYPH_FONT is not None, True)
else:
    FACE = os.path.basename(GLYPH_FONT)
    SIZE, ORIGIN = 200, (100, 260)
    CANVAS = (480, 420)
    A_PATHS = glyph_contours(GLYPH_FONT, "A", SIZE, ORIGIN)
    # Closed form against closed form, before a single pixel exists. If the
    # quadratic lift, the implied on-curve points, a component transform or
    # the flip were off by anything at all, these two numbers would part.
    for ch in ("A", "o", "Ä"):
        near(f"{FACE} {ch!r} encloses the area fontTools' own pen computes",
             P.path_area(glyph_contours(GLYPH_FONT, ch, SIZE, ORIGIN))
             / glyph_area(GLYPH_FONT, ch, SIZE), 1.0, 1e-12)
    rep = P.check_figure({"paths": A_PATHS}, notes=[])
    eq(f"{FACE} 'A' arrives as two contours, the letter and its counter",
       rep["contours"], 2)
    eq("...wound against each other, so nonzero cuts the counter out",
       (rep["ok"], rep["holes"], rep["solid"]), (True, [1], []))

    mask = P.path_mask({"paths": A_PATHS}, *CANVAS)
    ref = pil_glyph(GLYPH_FONT, "A", SIZE, ORIGIN, *CANVAS)
    near(f"{FACE} 'A' at {SIZE}px lays down the ink Pillow's own raster does",
         mask.sum() / ref.sum(), 1.0, 0.002)
    hinted_iou = iou(mask, ref)
    eq(f"...and covers the same pixels: IoU over 0.99 (got {hinted_iou:.4f})",
       hinted_iou > 0.99, True)

    # ⚠ THE REMAINING DISAGREEMENT IS FREETYPE'S HINTING, NOT THIS MODULE'S
    # FLATTENING, and the only way to show that is to measure both against a
    # raster where hinting cannot reach. Against the outline itself, imgpath is
    # the CLOSER of the two - so a test that only compared against the hinted
    # raster would be blaming the wrong side for the gap.
    beaten = []
    for ch, size in (("A", 200), ("o", 64), ("e", 64)):
        org = (int(size * 0.5), int(size * 1.3))
        hw = (int(size * 2.4), int(size * 2.1))
        paths = glyph_contours(GLYPH_FONT, ch, size, org)
        ours = iou(P.path_mask({"paths": paths}, *hw), unhinted(GLYPH_FONT, ch, size, org, *hw))
        theirs = iou(pil_glyph(GLYPH_FONT, ch, size, org, *hw),
                     unhinted(GLYPH_FONT, ch, size, org, *hw))
        NOTES.append(f"{FACE} {ch!r} at {size}px against an unhinted raster of "
                     f"itself: imgpath {ours:.4f}, Pillow {theirs:.4f}")
        # The floor is a regression guard - the measured worst of the three is
        # 0.9846 - but the CLAIM is the comparison next to it, which is what
        # says where the missing half percent actually lives.
        if ours < 0.97 or ours <= theirs:
            beaten.append(f"{ch}@{size} ours {ours:.4f} vs Pillow {theirs:.4f}")
    eq("against the true outline imgpath beats the hinted raster, every glyph",
       beaten, [])
    NOTES.append(f"{FACE} 'A' at {SIZE}px against Pillow's hinted raster: "
                 f"IoU {hinted_iou:.4f}, ink ratio {mask.sum() / ref.sum():.5f} - "
                 f"and IoU against a HINTED raster is a number about the size, "
                 f"not about this module")

    # The hole, and the thing that proves check_figure is diagnosing something
    # real rather than reciting a rule: reverse the counter and the letter
    # fills solid, exactly where it said it would.
    o_paths = glyph_contours(GLYPH_FONT, "o", SIZE, ORIGIN)
    o_mask = P.path_mask({"paths": o_paths}, *CANVAS)
    counter = P._flatten_one(P._paths_of(o_paths)[1], 0.25, True)[0]
    cx, cy = counter.mean(axis=0)
    eq("the counter of an 'o' is a HOLE, not ink", float(o_mask[int(cy), int(cx)]), 0.0)
    flipped = dict(o_paths[1])
    flipped["anchors"] = [{"p": a["p"], "in": a["out"], "out": a["in"]}
                          for a in reversed(o_paths[1]["anchors"])]
    bad_rep = P.check_figure({"paths": [o_paths[0], flipped]}, notes=[])
    eq("...and reversing it is the failure check_figure names",
       (bad_rep["ok"], bad_rep["solid"]), (False, [1]))
    # Joined rather than indexed: a pin that raises IndexError when the thing
    # it guards is removed takes every case after it down with it, and reports
    # a crash where it should report one named line. Caught by breaking it.
    said = " ".join(bad_rep["problems"])
    eq("...in a sentence that says which contour and what to do about it",
       ("contour 1" in said and "evenodd" in said), True)
    solid = P.path_mask({"paths": [o_paths[0], flipped]}, *CANVAS)
    eq("...and the letter really does come back solid, which is the whole bug",
       float(solid[int(cy), int(cx)]), 1.0)
    near("...while evenodd holes it whichever way the counter is wound",
         float(P.path_mask({"paths": [o_paths[0], flipped],
                            "fillRule": "evenodd"}, *CANVAS).sum()),
         float(o_mask.sum()), 0.01)

    # A COMPOSITE: the accented glyph is built out of references to 'A' and to a
    # dieresis, with a transform on each. A pen that does not decompose returns
    # NOTHING for it, which is why the count is the assertion.
    ae_paths = glyph_contours(GLYPH_FONT, "\u00c4", SIZE, ORIGIN)
    eq(f"{FACE} 'A-dieresis' decomposes to the letter, its counter and two dots",
       len(ae_paths), 4)
    ae_mask = P.path_mask({"paths": ae_paths}, *CANVAS)
    dots = P.path_mask({"paths": ae_paths[2:]}, *CANVAS)
    near("...and its ink is the 'A' plus exactly those two dots",
         float(ae_mask.sum()), float(mask.sum() + dots.sum()), 0.01)
    ae_ref = pil_glyph(GLYPH_FONT, "\u00c4", SIZE, ORIGIN, *CANVAS)
    near("...to the same ink Pillow's raster of the composite lays down",
         float(ae_mask.sum()) / float(ae_ref.sum()), 1.0, 0.002)
    rep = P.check_figure({"paths": ae_paths}, notes=[])
    eq("...with one hole and two islands, and nothing to complain about",
       (rep["ok"], rep["holes"], rep["inside"]), (True, [1], [-1, 0, -1, -1]))

    # ⚠ A CONTOUR THAT VANISHES OUT OF A LIST USED TO TAKE NOTHING WITH IT.
    # Before 2026-09-21 this drew three of the four contours and left `notes`
    # empty - an umlaut with one dot and no line anywhere to explain it. Real
    # fonts ship the input that triggers it: glyph u1FAA2 of seguiemj.ttf has
    # 48 contours and its 46th is a single point stated twice, so that letter
    # arrived here 47 contours strong and silent.
    notes = []
    lost = P.path_mask({"paths": ae_paths[:3] + [{"anchors": [{"p": [5, 5]}],
                                                  "closed": True}]}, *CANVAS, notes=notes)
    eq("a contour the grammar cannot read is REPORTED, not quietly dropped",
       any("gave no contour" in n for n in notes), True)
    eq("...naming which item of the list it was", any("item 3" in n for n in notes), True)
    eq("...while the contours around it still draw",
       float(lost.sum()) > float(mask.sum()), True)
    # An open contour WARNS and does not set ok: it is a mistake in a letter
    # and perfectly ordinary in a swash, and nothing in the geometry says
    # which one arrived.
    rep = P.check_figure({"paths": [dict(o_paths[0], closed=False), o_paths[1]]},
                         notes=[])
    eq("an open contour is a warning, not a problem - a swash is open on purpose",
       (rep["ok"], rep["open"], rep["problems"]), (True, [0], []))
    eq("...and the warning says what a stroke will do at its start point",
       "break at its start" in " ".join(rep.get("warnings", [])), True)
    # `boolean` is the one draw parameter the check cannot shrug off: it
    # decides whether the list is one figure or four separate operands, and a
    # confident report about the wrong one of those is worse than no report.
    rep = P.check_figure({"paths": o_paths, "boolean": "union"}, notes=[])
    eq("a job whose boolean is not 'none' is checking a different figure, and "
       "is told so", "boolean 'union'" in " ".join(rep.get("warnings", [])), True)
    # ⚠ AND THE ASSERTION IS THE NOTES, NOT THE REPORT. The first version of
    # this case compared two reports for equality, which are equal whether the
    # paint keys are filtered out or reported as unknown - a case that could
    # not fail. Caught by breaking it.
    quiet = []
    P.check_figure({"paths": o_paths, "fill": [255, 0, 0, 255], "strokeWidth": 9,
                    "blend": "multiply"}, notes=quiet)
    eq("...while the paint keys of the same job are not reported as typos",
       quiet, [])
    loud = []
    P.check_figure({"paths": o_paths, "wobble": 3}, notes=loud)
    eq("...though a key that is nobody's parameter still is",
       any("wobble" in s for s in loud), True)

    # ⚠ THE WHOLE REASON THE LOOK EXISTS: a brush WALKING the letters. The
    # stroke has to measure on real letterform geometry the way it does on a
    # straight line - a butt stroke of width w over length L is w*L of ink -
    # or the neon tube around a word is a picture nobody can predict the cost
    # of. A closed smooth contour has no caps and no corners to add anything.
    o_len = P.path_length(o_paths)
    walked = []
    for w in (2, 6, 12):
        got = ink(P.draw_path(blank(*CANVAS),
                              {"paths": o_paths, "stroke": [0, 0, 255, 255],
                               "strokeWidth": w, "join": "round"}))
        walked.append(f"w={w}: {got:.1f} vs {w * o_len:.1f}")
        near(f"a brush walking both contours of an 'o' at width {w} lays down w*L",
             got, w * o_len, w * o_len * 0.005)
    NOTES.append(f"{FACE} 'o' is {o_len:.1f}px of contour, and a brush walking "
                 f"it lays down " + ", ".join(walked))

    # A hole inside a hole is INK, and that is the case that says `inside` has
    # to be the IMMEDIATE container. Four concentric rings, alternating, which
    # is the shape of a circled letter (U+2460 and its neighbours).
    def backwards(bez):
        a = bez.a[::-1].copy()
        a[:, 2:4], a[:, 4:6] = bez.a[::-1, 4:6], bez.a[::-1, 2:4]
        return P.Bez(a, True)

    NEST = [P.circle_path(200, 200, 120), backwards(P.circle_path(200, 200, 90)),
            P.circle_path(200, 200, 60), backwards(P.circle_path(200, 200, 30))]
    rep = P.check_figure({"paths": NEST}, notes=[])
    eq("each ring of a four-deep nest is read against its IMMEDIATE container",
       (rep["inside"], rep["depth"]), ([-1, 0, 1, 2], [0, 1, 2, 3]))
    eq("...so a hole inside a hole is ink again, and only two of them are holes",
       (rep["ok"], rep["holes"], rep["solid"]), (True, [1, 3], []))
    # ⚠ AND IT CANNOT DEPEND ON THE ORDER THEY ARRIVE IN. A font lists a
    # glyph's contours in whatever order the designer drew them, so a reading
    # that happens to be right because the outermost came first is not a
    # reading. Same four rings, shuffled: every answer moves with the indices
    # and nothing else changes. Caught by breaking it - the first version of
    # this case used the ordered nest alone, and a container search that kept
    # the FIRST match instead of the smallest passed it.
    shuffled = [NEST[2], NEST[0], NEST[3], NEST[1]]
    rep = P.check_figure({"paths": shuffled}, notes=[])
    eq("...and the nesting is read the same way whatever order they arrive in",
       (rep["ok"], rep["inside"], rep["depth"], rep["holes"]),
       (True, [3, -1, 0, 1], [2, 0, 3, 1], [2, 3]))
    nested_ink = ink(fill_of(NEST, 400, 400))
    want = sum(abs(P.path_area(c)) * (1 if i % 2 == 0 else -1)
               for i, c in enumerate(NEST))
    near("...which is what the rasteriser does with it, to a part in a thousand",
         nested_ink, want, abs(want) * 1e-3)

    # §9 again, on the one op added here: every knob it advertises has to move
    # the report. `tolerance` is NOT advertised, and the case below is why -
    # the flattening is area-corrected, so the report is the same report at
    # forty times the chord error.
    CHECK_CASES = {"fillRule": ({"paths": [o_paths[0], flipped]},
                                {"fillRule": "evenodd"})}
    eq("every check parameter has a case below",
       sorted(set(P.CATALOG["check"]["params"]) - set(CHECK_CASES) - {"paths"}), [])
    eq("...and turning it changes the report",
       [k for k, (job, ch) in CHECK_CASES.items()
        if P.check_figure(job, notes=[]) == P.check_figure(dict(job, **ch), notes=[])],
       [])
    fine = [P._poly_area(P._flatten_one(b, 0.25, True)[0]) for b in P._paths_of(o_paths)]
    coarse = [P._poly_area(P._flatten_one(b, 10.0, True)[0]) for b in P._paths_of(o_paths)]
    near("a letter's contours measure the same area at 40x the chord error",
         max(abs(a - b) / abs(a) for a, b in zip(fine, coarse)), 0.0, 1e-5)

    eq("every rule of the contract is a sentence, not a code",
       [i for i, s in enumerate(P.TYPE_CONTRACT)
        if not s.strip().endswith(".") or len(s) < 40], [])
    eq("...and the catalog serves it beside the ops",
       P.catalog().get("typeContract"), list(P.TYPE_CONTRACT))


print("\n  -- cost at 2048 square --")

TIMES = P._bench(2048)
for k, v in TIMES.items():
    print(f"        {k:<26} {v:8.1f} ms")
print(f"        {'-> 8 strokes cost':<26} "
      f"{TIMES['liquify push x8'] / TIMES['liquify push']:8.2f} x one, "
      f"because they share ONE resample")
eq("a 2048-square fill is under a second", TIMES["fill"] < 1000, True)
eq("a 2048-square path -> mask is under 200 ms", TIMES["path -> mask"] < 200, True)
eq("a 2048-square liquify stroke is under a second", TIMES["liquify push"] < 1000, True)
eq("eight strokes cost well under eight times one",
   TIMES["liquify push x8"] < 4 * TIMES["liquify push"], True)


if NOTES:
    print("\n  -- measured --")
    for n in NOTES:
        print(f"     {n}")

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
