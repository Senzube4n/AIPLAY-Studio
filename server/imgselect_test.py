"""Unit tests for the selection builder in server/imgselect.py.

A selection is the one part of an image editor where "it looks right" is not a
test, because every case here has a closed-form answer: a 40x20 rectangle
covers 800 pixels and no partial ones, an ellipse covers pi*rx*ry, a rectangle
dilated by a disc of radius n covers (w+2n)(h+2n) - (4-pi)n^2, and a gaussian
conserves mass exactly. So almost everything below measures COVERAGE - the sum
of the mask - against arithmetic done on paper.

Three kinds of test.

  * SWEEPS over the CATALOG: every kind builds, every default sits inside its
    own advertised range, every entry carries a label / group / why, and -
    the one that matters - EVERY ADVERTISED PARAMETER DEMONSTRABLY CHANGES THE
    MASK. IMAGE_SPEC §9 calls a schema that accepts a parameter the code
    ignores worse than a refusal, because a schema is exactly what a caller
    trusts. The probe table below has to name every catalogued parameter or the
    sweep fails, so a new parameter cannot be added without proving it does
    something.

  * ONE MEANINGFUL ASSERTION PER FEATURE - not "it ran" but "a 40x20 rect is
    exactly 800 pixels and exactly the right ones", "a pentagram has a hole in
    it", "expanding by 10 and contracting by 10 leaves the interior bit-
    identical", "the perceptual metric takes a whole sky where RGB euclidean
    stops at 75% of it".

  * blend() GETS ITS OWN SECTION, because it is the line the whole spec turns
    on and its failure mode is invisible: the naive four-channel lerp is right
    on every opaque pixel, right on every alpha channel, and wrong only on the
    colour of semi-transparent ones. The case is constructed so that the wrong
    implementation gives a specific different number, and both are asserted.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgselect_test.py

numpy / cv2, plus vfx/effects.py for the integration case - a mask is worth
nothing until a real effect lands only where it was asked to, and that is a
claim about the OTHER column's source rather than about this one.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vfx"))
import imgselect as sel                                    # noqa: E402

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
    if abs(float(got) - float(want)) <= tol:
        eq(name, True, True)
    else:
        eq(name, f"{float(got):.6g} (wanted {float(want):.6g} +-{tol:g})",
           "within tolerance")


def flat(h=160, w=160, rgb=(0.5, 0.5, 0.5)):
    im = np.zeros((h, w, 4), np.float32)
    im[..., :3] = rgb
    im[..., 3] = 1.0
    return im


def scene():
    """A vertical sky ramp with two flat red patches, one of them detached.
    The ramp is what makes `lightness` and `softness` measurable; the detached
    patch is what makes `contiguous` measurable."""
    im = np.zeros((160, 160, 4), np.float32)
    im[..., 3] = 1.0
    top, bot = np.array([0.20, 0.38, 0.75]), np.array([0.72, 0.84, 0.98])
    for r in range(160):
        im[r, :, :3] = top + (bot - top) * (r / 159.0)
    im[20:60, 20:60, :3] = RED
    im[120:140, 120:150, :3] = RED         # same colour, not touching
    return im


RED = np.array([0.90, 0.12, 0.10], np.float32)
RED255 = [230, 31, 26]                     # RED * 255, rounded - 0-255, per §9
SCENE = scene()
SKY60 = (SCENE[60, 0, :3] * 255.0).tolist()   # the ramp at row 60, in 0-255
IMG = flat()


def m(spec, img=None, warn=None):
    return sel.resolve(spec, IMG if img is None else img, warn)


def one(kind, img=None, **kw):
    return m({"shapes": [dict(kw, kind=kind)]}, img)


def area(mask):
    return float(mask.sum())


def partials(mask):
    return int(np.count_nonzero((mask > 0.0) & (mask < 1.0)))


def centroid(mask):
    ys, xs = np.mgrid[0:mask.shape[0], 0:mask.shape[1]]
    s = mask.sum()
    return float((xs * mask).sum() / s), float((ys * mask).sum() / s)


print("\nimgselect\n")
print("  -- the catalog contract --")

bad = [k for k, e in sel.CATALOG.items()
       if not (e.get("label") and e.get("why") and e.get("group") in sel.GROUP_ORDER)]
eq("every entry has a label, a group and a why", bad, [])

bad = []
for k, e in list(sel.CATALOG.items()) + [("<modifiers>", {"params": sel.MODIFIERS})]:
    for pk, p in e["params"].items():
        if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append(f"{k}.{pk}")
        if p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append(f"{k}.{pk}")
        if p["type"] == "color" and len(p["default"]) != 3:
            bad.append(f"{k}.{pk}")
        if "desc" not in p or "animatable" not in p:
            bad.append(f"{k}.{pk}")
eq("every parameter is described and defaults inside its own range", bad, [])

eq("the aliases all point at something real",
   sorted(set(sel.ALIASES.values()) - set(sel.CATALOG)), [])
cat = sel.catalog()
eq("catalog() serves the whole vocabulary",
   sorted(cat["selection"]) == sorted(sel.CATALOG)
   and cat["modes"] == sel.MODES and bool(cat["notes"]) and bool(cat["modifiers"]), True)
eq("an alias resolves to the same mask as the real name",
   area(one("circle", cx=80, cy=80, rx=30, ry=30)),
   area(one("ellipse", cx=80, cy=80, rx=30, ry=30)))


print("\n  -- every advertised parameter changes the mask (§9) --")

# base spec per kind, and one alternative value per catalogued parameter. All
# five shapes overlap the square at (30,30)-(90,90) so that the `mode` probe -
# which needs a shape UNDER it to combine with - works the same way for each.
UNDER = {"kind": "rect", "x": 30, "y": 30, "w": 60, "h": 60}
BASE = {
    "rect": {"kind": "rect", "x": 20, "y": 20, "w": 40, "h": 40},
    "ellipse": {"kind": "ellipse", "cx": 40, "cy": 40, "rx": 20, "ry": 20},
    "polygon": {"kind": "polygon", "points": [[20, 20], [60, 20], [60, 60], [20, 60]]},
    # the colour tools are seeded on the SKY RAMP, because on a flat patch
    # every tolerance selects the same patch and the parameter would look inert
    "wand": {"kind": "wand", "x": 5, "y": 60, "tolerance": 8},
    "colorRange": {"kind": "colorRange", "color": SKY60, "tolerance": 4,
                   "softness": 6},
    "channel": {"kind": "channel", "channel": "r"},
    # A curved subpath (a KAPPA circle, c=(40,40) r=20) plus a square that
    # overlaps it: the curve is what makes `tolerance` visible, the overlap is
    # what makes `fillRule` and `boolean` visible.
    "path": {"kind": "path",
             "paths": [{"d": "M 60 40 C 60 51 51 60 40 60 C 29 60 20 51 20 40 "
                             "C 20 29 29 20 40 20 C 51 20 60 29 60 40 Z"},
                       {"points": [[30, 30], [70, 30], [70, 70], [30, 70]],
                        "closed": True}],
             "fillRule": "nonzero", "boolean": "none", "tolerance": 0.25},
}
ALT = {
    "rect": {"x": 25, "y": 26, "w": 55, "h": 44},
    "ellipse": {"cx": 45, "cy": 46, "rx": 28, "ry": 33},
    "polygon": {"points": [[20, 20], [70, 25], [55, 62], [18, 58]]},
    # the ramp runs down the frame, so moving the seed ACROSS a row is only
    # visible from a row that has the red block on it; and contiguity is only
    # visible where one colour appears in two places. Both get their own seed.
    "wand": {"y": 30, "tolerance": 30, "lightness": 1.0,
             "x": {"seed": {"y": 30}, "to": 30},
             "contiguous": {"seed": {"x": 30, "y": 30, "tolerance": 20},
                            "to": False}},
    "colorRange": {"color": RED255, "tolerance": 30, "softness": 40,
                   "lightness": 1.0},
    "channel": {"channel": "b"},
    "path": {"paths": [{"points": [[30, 30], [70, 30], [70, 70], [30, 70]],
                        "closed": True}],
             "fillRule": "evenodd", "boolean": "subtract", "tolerance": 8.0},
}

# The sweeps below all iterate BASE, so a kind missing from it would silently
# skip every one of them - the exact escape hatch §9 warns about.
eq("the probe table covers every catalogued kind",
   sorted(set(sel.CATALOG) - set(BASE)), [])

missing, inert = [], []
for kind, spec in BASE.items():
    for pk in sel.CATALOG[kind]["params"]:
        if pk == "mode":
            a = m({"shapes": [UNDER, dict(spec, mode="add")]}, SCENE)
            b = m({"shapes": [UNDER, dict(spec, mode="subtract")]}, SCENE)
        elif pk not in ALT[kind]:
            missing.append(f"{kind}.{pk}")
            continue
        else:
            alt = ALT[kind][pk]
            base = spec
            if isinstance(alt, dict) and "to" in alt:
                base = dict(spec, **alt["seed"])
                alt = alt["to"]
            a = m({"shapes": [base]}, SCENE)
            b = m({"shapes": [dict(base, **{pk: alt})]}, SCENE)
        if np.array_equal(a, b):
            inert.append(f"{kind}.{pk}")
eq("the probe table names every catalogued shape parameter", missing, [])
eq("...and every one of them moves the mask", inert, [])

MOD_ALT = {"mode": "subtract", "feather": 6, "invert": True, "expand": 7,
           "antialias": False}
missing = sorted(set(sel.MODIFIERS) - set(MOD_ALT))
eq("the probe table names every catalogued modifier", missing, [])
inert = []
for pk, alt in MOD_ALT.items():
    base = {"shapes": [UNDER, BASE["ellipse"]]}
    if np.array_equal(m(base), m(dict(base, **{pk: alt}))):
        inert.append(pk)
eq("...and every modifier moves the mask", inert, [])


print("\n  -- the channel kind: the plane IS the mask --")

eq("channel r is the red plane, bit for bit",
   np.array_equal(one("channel", img=SCENE, channel="r"), SCENE[..., 0]), True)
eq("channel a on an opaque image is a mask of ones",
   area(one("channel", img=SCENE, channel="a")), float(SCENE.size // 4))
eq("luminosity is the Rec.601 composite",
   np.allclose(one("channel", img=SCENE, channel="luminosity"),
               SCENE[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32),
               atol=1e-6), True)
eq("the synonyms land on the same plane",
   np.array_equal(one("channel", img=SCENE, channel="red"),
                  one("channel", img=SCENE, channel="r")), True)
w = []
eq("an unknown channel is named back, not shrugged at",
   (area(sel.resolve({"shapes": [{"kind": "channel", "channel": "q"}]}, SCENE, w)),
    any("luminosity" in x for x in w)), (0.0, True))


print("\n  -- the path kind: imgpath's own coverage --")

# The other side's source, §9: the params imgselect advertises for `path` are
# imgpath's `mask` op - same names, same enum options - so the two catalogs
# cannot drift apart without this line going red.
import imgpath  # noqa: E402

_ours = sel.CATALOG["path"]["params"]
_theirs = imgpath.CATALOG["mask"]["params"]
eq("the path params are imgpath's mask params, by name",
   sorted(set(_ours) - {"mode"}), sorted(_theirs))
eq("...with the same enum options",
   {k: _ours[k]["options"] for k in _ours
    if k != "mode" and _ours[k].get("options")},
   {k: _theirs[k]["options"] for k in _theirs if _theirs[k].get("options")})

SQ = {"points": [[30, 30], [70, 30], [70, 70], [30, 70]], "closed": True}
eq("a 40x40 closed path selects exactly 1600 pixels",
   area(one("path", paths=[SQ])), 1600.0)
eq("...the same pixels the rect marquee selects",
   np.array_equal(one("path", paths=[SQ]), one("rect", x=30, y=30, w=40, h=40)),
   True)
eq("the kind is imgpath.path_mask, bit for bit",
   np.array_equal(one("path", img=SCENE, paths=BASE["path"]["paths"]),
                  imgpath.path_mask({"paths": BASE["path"]["paths"]}, 160, 160)),
   True)
eq("the pen alias lands on the path kind",
   np.array_equal(one("pen", paths=[SQ]), one("path", paths=[SQ])), True)
w = []
sel.resolve({"shapes": [{"kind": "path", "paths": [{"points": [[-900, -900],
             [-800, -900], [-850, -800]], "closed": True}]}]}, SCENE, w)
eq("a path entirely off-frame says where it went",
   any("outside" in x for x in w), True)


print("\n  -- the output contract --")

bad, ranged, shaped = [], [], []
for kind, spec in BASE.items():
    mask = m({"shapes": [spec]}, SCENE)
    if mask.dtype != np.float32:
        bad.append(kind)
    if not np.isfinite(mask).all() or mask.min() < 0.0 or mask.max() > 1.0:
        ranged.append(kind)
    if mask.shape != SCENE.shape[:2]:
        shaped.append(kind)
eq("every kind returns float32", bad, [])
eq("...clamped to 0..1 with no NaN", ranged, [])
eq("...at the size of the image it was given", shaped, [])
eq("no selection at all is a mask of ones",
   (m(None).min(), m(None).max()), (1.0, 1.0))
eq("...and so is a selection object that names no shapes",
   m({"antialias": True}).min(), 1.0)
eq("...and so is one whose shapes are null, because that is how JSON spells "
   "absent", m({"shapes": None}).min(), 1.0)
eq("feathering the whole frame softens the frame edge, since there is no shape "
   "for it to be about", float(m({"feather": 4})[0, 80]) < 0.7, True)
eq("a shapes list that is PRESENT and empty selects nothing, not everything",
   area(m({"shapes": []})), 0.0)


print("\n  -- rect: the one shape with an exact answer --")

r = one("rect", x=10, y=20, w=40, h=20)
eq("a 40x20 rect is exactly 800 pixels", area(r), 800.0)
eq("...and not one of them is partial", partials(r), 0)
want = np.zeros((160, 160), np.float32)
want[20:40, 10:50] = 1.0
eq("...and they are exactly the right 800", bool((r == want).all()), True)
near("a half-pixel rect covers exactly half of its edge pixels",
     area(one("rect", x=10.5, y=20, w=39.5, h=20)), 790.0, 1e-4)
eq("a marquee dragged up-and-left is the same rect",
   area(one("rect", x=50, y=40, w=-40, h=-20)), 800.0)
eq("...and lands in the same place",
   bool((one("rect", x=50, y=40, w=-40, h=-20) == want).all()), True)
eq("a rect clipped by the frame keeps only what is inside",
   area(one("rect", x=-30, y=-30, w=50, h=50)), 400.0)


print("\n  -- ellipse: pi*rx*ry --")

for rx, ry in ((60, 40), (40, 40), (25, 55)):
    a = area(one("ellipse", cx=80, cy=80, rx=rx, ry=ry))
    exact = math.pi * rx * ry
    near(f"an ellipse {rx}x{ry} covers pi*rx*ry to within 0.05%",
         100.0 * (a - exact) / exact, 0.0, 0.05)
e = one("ellipse", cx=80, cy=80, rx=40, ry=40)
eq("...with a genuinely partial edge all the way round it",
   partials(e) > 250, True)
eq("...symmetric in both axes",
   bool(np.allclose(e, e[::-1]) and np.allclose(e, e[:, ::-1])), True)
eq("a negative radius is its magnitude",
   area(one("ellipse", cx=80, cy=80, rx=-40, ry=40)), area(e))
eq("a 1px ellipse still selects something", area(one("ellipse", cx=80, cy=80,
                                                     rx=0.5, ry=0.5)) > 0, True)


print("\n  -- polygon: even-odd, exact in x --")

square = [[10, 20], [50, 20], [50, 40], [10, 40]]
p = one("polygon", points=square)
eq("a rectangle drawn as a polygon is the same 800 pixels", area(p), 800.0)
eq("...with no partial pixel either", partials(p), 0)
eq("...and closing the ring explicitly changes nothing",
   area(one("polygon", points=square + [[10, 20]])), 800.0)
circle = [[80 + 50 * math.cos(t * math.tau / 720), 80 + 50 * math.sin(t * math.tau / 720)]
          for t in range(720)]
near("a 720-gon of radius 50 covers pi*r^2 to within 0.02%",
     100.0 * (area(one("polygon", points=circle)) - math.pi * 2500) / (math.pi * 2500),
     0.0, 0.02)

star = [[80 + 60 * math.cos(-math.pi / 2 + k * 4 * math.pi / 5),
         80 + 60 * math.sin(-math.pi / 2 + k * 4 * math.pi / 5)] for k in range(5)]
pg = one("polygon", points=star)
eq("a pentagram fills even-odd: the middle is a hole", float(pg[80, 80]), 0.0)
# The five points of a {5/2} star polygon of circumradius R, with the inner
# pentagon subtracted, has a closed form: the inner pentagon's circumradius is
# R * sin(pi/10)/sin(7*pi/10), and the even-odd area is the whole star minus
# twice nothing - five triangles standing on that pentagon.
Rp = 60.0 * math.sin(math.pi / 10) / math.sin(7 * math.pi / 10)
pent = 2.5 * Rp * Rp * math.sin(math.tau / 5)
points_area = (5 * 0.5 * (2 * Rp * math.sin(math.pi / 5))
               * (60.0 - Rp * math.cos(math.pi / 5)))
near("...and its area is the five points without the pentagon",
     area(pg), points_area, points_area * 0.005)

# The practical self-intersection: a lasso that goes round the outside, walks
# in along a zero-width bridge and goes round an island. Even-odd makes that a
# hole, which is the whole reason anyone draws one.
keyhole = [[20, 20], [140, 20], [140, 140], [20, 140], [20, 20],
           [45, 45], [115, 45], [115, 115], [45, 115], [45, 45]]
k = one("polygon", points=keyhole)
eq("a keyhole path is the outer square minus the island", area(k), 120 * 120 - 70 * 70)
eq("...solid in the ring and empty in the island",
   (float(k[30, 80]), float(k[80, 80])), (1.0, 0.0))
eq("a square traced twice is EMPTY - parity 2 - which is what makes this "
   "even-odd and not nonzero",
   area(one("polygon", points=[[20, 20], [100, 20], [100, 100], [20, 100],
                               [20, 20], [100, 20], [100, 100], [20, 100]])), 0.0)

w = []
eq("two points enclose nothing", area(m({"shapes": [{"kind": "polygon",
                                                     "points": [[1, 1], [9, 9]]}]},
                                        None, w)), 0.0)
eq("...and says so", "3 enclose" in " ".join(w), True)
w = []
eq("a polygon of only horizontal edges is degenerate, not a crash",
   area(m({"shapes": [{"kind": "polygon",
                       "points": [[1, 5], [9, 5], [20, 5]]}]}, None, w)), 0.0)
eq("...and says so too", any("degenerate" in x for x in w), True)


print("\n  -- add / subtract / intersect --")

A = {"kind": "rect", "x": 20, "y": 20, "w": 40, "h": 40}      # 1600, (20..60)
B = {"kind": "rect", "x": 40, "y": 40, "w": 40, "h": 40}      # 1600, (40..80)
# overlap is (40..60)^2 = 400
eq("add is the union", area(m({"shapes": [A, dict(B, mode="add")]})), 1600 + 1600 - 400)
eq("subtract removes exactly the overlap",
   area(m({"shapes": [A, dict(B, mode="subtract")]})), 1600 - 400)
eq("intersect keeps exactly the overlap",
   area(m({"shapes": [A, dict(B, mode="intersect")]})), 400)
eq("adding the same shape twice changes nothing",
   area(m({"shapes": [A, dict(A, mode="add")]})), 1600)
eq("subtracting a shape from itself leaves nothing",
   area(m({"shapes": [A, dict(A, mode="subtract")]})), 0.0)
eq("the first shape combines against an empty selection, so add gives itself",
   area(m({"shapes": [dict(A, mode="add")]})), 1600)
eq("...and intersect against an empty selection gives nothing",
   area(m({"shapes": [dict(A, mode="intersect")]})), 0.0)
eq("a shape with no mode takes the selection-level one",
   area(m({"shapes": [dict(A, mode="add"), B], "mode": "intersect"})), 400)
eq("...and its own mode wins over the selection-level one",
   area(m({"shapes": [dict(A, mode="add"), dict(B, mode="add")],
           "mode": "intersect"})), 2800)
eq("a selection-level intersect therefore selects nothing on its own, because "
   "shapes[0] has nothing to intersect with",
   area(m({"shapes": [A, B], "mode": "intersect"})), 0.0)

C = {"kind": "rect", "x": 50, "y": 10, "w": 40, "h": 40}      # 1600, x 50..90, y 10..50
abc = area(m({"shapes": [A, dict(B, mode="subtract"), dict(C, mode="intersect")]}))
acb = area(m({"shapes": [A, dict(C, mode="intersect"), dict(B, mode="subtract")]}))
# A-B is A minus its lower-right quarter; intersecting with C leaves x 50..60,
# y 20..50 minus the part of B in it (x 50..60, y 40..50) = 10*30 - 10*10 = 200.
# The other order intersects first (x 50..60, y 20..50 = 300) then subtracts the
# same 100 - which happens to be the same number, so the pair below uses a C
# that straddles the overlap differently.
eq("(A - B) & C is 200", abc, 200.0)
eq("A & C - B is the same 200 here", acb, 200.0)
D = {"kind": "rect", "x": 40, "y": 40, "w": 60, "h": 60}
o1 = area(m({"shapes": [A, dict(D, mode="add"), dict(B, mode="intersect")]}))
o2 = area(m({"shapes": [A, dict(B, mode="intersect"), dict(D, mode="add")]}))
eq("order matters when all three are used: (A|D)&B is B's 1600 clipped to 40..80",
   o1, 1600.0)
eq("...while (A&B)|D is D plus the sliver of the overlap outside it", o2, 3600.0)
eq("...so the two orders are genuinely different", o1 != o2, True)


print("\n  -- feather --")

base = {"shapes": [{"kind": "rect", "x": 60, "y": 60, "w": 40, "h": 40}]}
a0 = m(base)
f8 = m(dict(base, feather=8))
near("feather conserves the total", area(f8), area(a0), area(a0) * 1e-4)
cx0, cy0 = centroid(a0)
cx1, cy1 = centroid(f8)
near("...does not shift the centroid in x", cx1, cx0, 1e-3)
near("...nor in y", cy1, cy0, 1e-3)
eq("...is symmetric about the shape it softened",
   bool(np.allclose(f8, f8[::-1], atol=1e-6)
        and np.allclose(f8, f8[:, ::-1], atol=1e-6)), True)
eq("...puts genuinely partial values on both sides of the old edge",
   bool(0.0 < f8[80, 55] < 0.5 and 0.5 < f8[80, 65] < 1.0), True)
near("...and leaves the middle of the edge at half", float(f8[80, 60]), 0.5, 0.02)
eq("a bigger sigma reaches further", float(m(dict(base, feather=16))[80, 45]) >
   float(f8[80, 45]), True)
eq("feather 0 is the identity", bool((m(dict(base, feather=0)) == a0).all()), True)
edge = m({"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 40, "h": 40}], "feather": 8})
eq("a selection feathered against the frame edge loses mass rather than "
   "reflecting it back", area(edge) < 1600.0 and area(edge) > 1000.0, True)


print("\n  -- expand: real morphology --")

box = {"shapes": [{"kind": "rect", "x": 30, "y": 30, "w": 100, "h": 80}]}
for n in (4, 8, 15):
    grown = area(m(dict(box, expand=n)))
    # dilation by a disc of radius n: the rect grows n on every side and the
    # four corners become quarter-discs instead of squares
    want = (100 + 2 * n) * (80 + 2 * n) - (4 - math.pi) * n * n
    near(f"expand +{n} is the rect grown by {n} with rounded corners",
         100.0 * (grown - want) / want, 0.0, 0.15)
for n in (4, 8, 14):
    shrunk = area(m(dict(box, expand=-n)))
    # erosion of a convex polygon by a disc is the inset polygon, corners and
    # all - so this one is not approximate, it is exact
    near(f"expand -{n} is exactly the rect inset by {n}",
         shrunk, (100 - 2 * n) * (80 - 2 * n), 0.01)
eq("contracting past the middle leaves nothing", area(m(dict(box, expand=-60))), 0.0)
eq("expand 0 is the identity", bool((m(dict(box, expand=0)) == m(box)).all()), True)

a0 = m(box)
rt = sel._expand(sel._expand(a0, 8), -8)
near("expand +8 then -8 returns the same area to within 0.05%",
     100.0 * (area(rt) - area(a0)) / area(a0), 0.0, 0.05)
eq("...bit-identical everywhere except the edge itself",
   bool((rt[32:108, 32:128] == a0[32:108, 32:128]).all()), True)
eq("...and no pixel moved by half", float(np.abs(rt - a0).max()) < 0.5, True)
# Why it is not exact: growing then shrinking is a morphological CLOSING, which
# for a convex shape is the shape - but the mask is a pixel grid, and each pass
# re-derives the sub-pixel edge position from a thresholded distance transform.
# What a closing genuinely cannot undo is the other order: an OPENING rounds
# every convex corner to the radius it was eroded by, and no dilation brings a
# sharp corner back. That is a number, so it is asserted rather than described.
for n in (6, 12):
    lost = area(a0) - area(sel._expand(sel._expand(a0, -n), n))
    ideal = 4 * (1 - math.pi / 4) * n * n
    eq(f"an opening at {n}px loses the four corners ({lost:.0f}px, 4(1-pi/4)n^2 "
       f"= {ideal:.0f})", ideal * 0.9 < lost < ideal * 1.4, True)

sharp = m(dict(box, expand=6))
soft = m(dict(box, feather=6, expand=6))
eq("expand runs before feather, so a feathered expand is softer than a hard one",
   partials(soft) > partials(sharp) * 3, True)


print("\n  -- invert and antialias --")

tri = {"shapes": [{"kind": "polygon", "points": [[20, 20], [140, 40], [60, 130]]}]}
t0 = m(tri)
ti = m(dict(tri, invert=True))
eq("a mask and its inverse sum to one everywhere",
   bool(np.allclose(t0 + ti, 1.0, atol=1e-6)), True)
eq("invert is applied after feather, so the soft edge is complemented not "
   "re-softened",
   bool(np.allclose(m(dict(tri, feather=5, invert=True)),
                    1.0 - m(dict(tri, feather=5)), atol=1e-6)), True)
eq("an antialiased diagonal has genuinely partial edge pixels",
   partials(t0) > 200, True)
eq("...and they are spread across the range, not stuck at half",
   len(np.unique(np.round(t0[(t0 > 0) & (t0 < 1)], 2))) > 20, True)
th = m(dict(tri, antialias=False))
eq("antialias off gives a strictly binary mask", sorted(np.unique(th).tolist()),
   [0.0, 1.0])
eq("...and still covers the same triangle to within a pixel per edge row",
   abs(area(th) - area(t0)) < 200, True)
eq("antialias off does not disable feather, which was asked for explicitly",
   partials(m(dict(tri, antialias=False, feather=4))) > 500, True)
eq("antialias off after an expand is still binary",
   sorted(np.unique(m(dict(tri, antialias=False, expand=5))).tolist()), [0.0, 1.0])


print("\n  -- wand --")

w = one("wand", img=SCENE, x=30, y=30, tolerance=20)
want = np.zeros((160, 160), np.float32)
want[20:60, 20:60] = 1.0
eq("a wand on a flat region selects exactly that region", bool((w == want).all()), True)
eq("...1600 pixels, none of them partial", (area(w), partials(w)), (1600.0, 0))
wg = one("wand", img=SCENE, x=30, y=30, tolerance=20, contiguous=False)
eq("contiguous:false also takes the detached patch of the same colour",
   area(wg), 1600.0 + 600.0)
eq("...and the contiguous one did not", area(w), 1600.0)
eq("a tolerance of 0 still takes a flat region whole",
   area(one("wand", img=SCENE, x=30, y=30, tolerance=0)), 1600.0)
eq("a wand seeded on the sky does not leak into the red",
   float(one("wand", img=SCENE, x=5, y=5, tolerance=30)[30, 30]), 0.0)

# The metric claim, measured rather than asserted: how much of one material a
# wand can take before it reaches the other one AT ALL. See _colour_distance.
def reachable(img, dist):
    return float((dist[:, :40] < dist[:, 40:].min()).sum()) / 2400.0


sky = np.zeros((60, 60, 4), np.float32)
sky[..., 3] = 1.0
for r in range(60):
    sky[r, :, :3] = np.array([0.20, 0.38, 0.75]) + \
        (np.array([0.72, 0.84, 0.98]) - np.array([0.20, 0.38, 0.75])) * (r / 59.0)
sky[:, 40:, :3] = [0.66, 0.66, 0.66]
lab = sel._lab(sky)
d_lab = sel._colour_distance(lab.copy(), sky[..., 3], lab[0, 5].copy(), 1.0, 0.5)
d_rgb = np.sqrt((((sky[..., :3] - sky[0, 5, :3]) * 255.0) ** 2).sum(-1))
got_lab, got_rgb = reachable(sky, d_lab), reachable(sky, d_rgb)
eq("on a sky under a lighting ramp the perceptual metric reaches all of it",
   got_lab >= 0.999, True)
eq("...where RGB euclidean stops at three quarters before the building joins in",
   0.70 <= got_rgb <= 0.80, True)
eq("a wand at any tolerance cannot take that sky under RGB euclidean, "
   "which is why the metric is not RGB", got_lab > got_rgb, True)

w = []
eq("a seed outside the image selects nothing",
   area(m({"shapes": [{"kind": "wand", "x": 900, "y": 4}]}, SCENE, w)), 0.0)
eq("...and says so, in the words §3 asks for",
   any("wand seed" in x and "outside" in x and "160x160" in x for x in w), True)
w = []
m({"shapes": [{"kind": "wand", "x": -1, "y": 0}]}, SCENE, w)
eq("a negative seed is out of bounds too", len(w), 1)

cut = flat(40, 40, (0.9, 0.1, 0.1))
cut[10:30, 10:30, 3] = 0.0                # a hole, its leftover RGB still red
eq("a wand on a cut-out does not take the transparent hole, whatever colour "
   "was left behind there",
   float(one("wand", img=cut, x=2, y=2, tolerance=30)[20, 20]), 0.0)


print("\n  -- colorRange --")

cr = m({"shapes": [{"kind": "colorRange", "color": RED255, "tolerance": 20,
                    "softness": 5}]}, SCENE)
eq("colorRange takes every patch of the colour, attached or not",
   area(cr), 1600.0 + 600.0)
# The falloff has to be measured on something that ramps, or every distance is
# either zero or enormous and a hard threshold would pass this test.
mid = SCENE[80, 0, :3] * 255.0
soft = m({"shapes": [{"kind": "colorRange", "color": mid.tolist(), "tolerance": 1,
                      "softness": 14}]}, SCENE)
h = np.histogram(soft, bins=[0.0, 1e-6, 0.2, 0.4, 0.6, 0.8, 1.0 - 1e-6, 1.01])[0]
eq(f"a soft colorRange fills the middle of the histogram {h.tolist()}",
   bool((h[2:6] > 300).all()), True)
eq("...and still has both extremes", bool(h[0] > 0 and h[6] > 0), True)
eq("...monotonically decreasing away from the target colour",
   bool((np.diff(soft[80:160, 0]) <= 1e-6).all()), True)
hardcr = m({"shapes": [{"kind": "colorRange", "color": mid.tolist(),
                        "tolerance": 8, "softness": 0}],
            "antialias": False}, SCENE)
eq("softness 0 with antialias off is a hard threshold",
   sorted(np.unique(hardcr).tolist()), [0.0, 1.0])
wide = m({"shapes": [{"kind": "colorRange", "color": mid.tolist(), "tolerance": 1,
                      "softness": 28}]}, SCENE)
eq("more softness means more partial pixels", partials(wide) > partials(soft), True)
eq("colorRange asks for an OPAQUE colour, so it skips transparent pixels",
   float(m({"shapes": [{"kind": "colorRange", "color": [230, 26, 26],
                        "tolerance": 30}]}, cut)[20, 20]), 0.0)
eq("a 0-1 colour triple is near-black and selects the dark end, not the red - "
   "colours are 0-255 (§9)",
   area(m({"shapes": [{"kind": "colorRange", "color": [0.9, 0.12, 0.1],
                       "tolerance": 30}]}, SCENE)) < 1600.0, True)


print("\n  -- blend: the line the whole spec turns on --")

rng = np.random.default_rng(11)
orig = rng.random((16, 16, 4), dtype=np.float32)
res = rng.random((16, 16, 4), dtype=np.float32)
ones = np.ones((16, 16), np.float32)
zeros = np.zeros((16, 16), np.float32)
eq("a mask of ones is BIT-identical to the result",
   sel.blend(orig, res, ones).tobytes() == res.tobytes(), True)
eq("a mask of zeros is BIT-identical to the original",
   sel.blend(orig, res, zeros).tobytes() == orig.tobytes(), True)
# ...and again with one pixel off the extreme, so the all-ones fast path cannot
# be what is passing the test above.
almost = ones.copy()
almost[0, 0] = 0.5
out = sel.blend(orig, res, almost)
eq("...and still bit-identical on the ones when one pixel is not one",
   out[1:].tobytes() == res[1:].tobytes(), True)
eq("...while that one pixel actually moved", bool(np.any(out[0, 0] != res[0, 0])), True)
eq("mask None is the no-selection identity", sel.blend(orig, res, None) is res, True)

# THE FRINGE CASE. A fully transparent original whose leftover RGB is black,
# under an opaque red result, at half coverage. The right answer is red at half
# alpha; the four-channel lerp - correct for premultiplied data, wrong here -
# gives half-strength red, and would look like a dark halo along the edge.
tr = np.zeros((1, 1, 4), np.float32)                        # a=0, rgb=black
op = np.array([[[1.0, 0.0, 0.0, 1.0]]], np.float32)         # opaque red
half = np.full((1, 1), 0.5, np.float32)
got = sel.blend(tr, op, half)[0, 0]
naive = (op * 0.5 + tr * 0.5)[0, 0]
eq("half-covering a transparent pixel with opaque red gives RED at half alpha",
   [round(float(v), 6) for v in got], [1.0, 0.0, 0.0, 0.5])
eq("...where the premultiplied-style lerp would have dimmed it to 0.5 red",
   [round(float(v), 6) for v in naive], [0.5, 0.0, 0.0, 0.5])
eq("...so the two are genuinely different and this test can fail",
   bool(np.any(np.abs(got - naive) > 1e-6)), True)
# and the mirror image: an opaque white original under a transparent result
op_w = np.array([[[1.0, 1.0, 1.0, 1.0]]], np.float32)
got = sel.blend(op_w, tr, half)[0, 0]
eq("half-erasing an opaque white pixel leaves WHITE at half alpha, not grey",
   [round(float(v), 6) for v in got], [1.0, 1.0, 1.0, 0.5])

# The whole point, on a real semi-transparent edge rather than one pixel.
edge = np.zeros((1, 64, 4), np.float32)
edge[0, :, :3] = [1.0, 0.2, 0.1]
edge[0, :, 3] = np.linspace(0.0, 1.0, 64, dtype=np.float32)   # a soft edge
res = edge.copy()
res[0, :, :3] = [0.1, 0.3, 1.0]                               # recoloured, same alpha
out = sel.blend(edge, res, np.full((1, 64), 0.5, np.float32))
lit = out[0, 1:, :3]
eq("blending a recolour across a soft alpha edge keeps one colour all the way "
   "down it - no channel drifts",
   float((lit.max(0) - lit.min(0)).max()) < 1e-5, True)
eq("...which the four-channel lerp also manages here, because the alphas match "
   "- the fringe needs a DIFFERENCE in alpha to appear",
   bool(np.allclose(out[0, 1:], (edge * 0.5 + res * 0.5)[0, 1:], atol=1e-5)), True)

opq_o = np.concatenate([rng.random((8, 8, 3), dtype=np.float32),
                        np.ones((8, 8, 1), np.float32)], 2)
opq_r = np.concatenate([rng.random((8, 8, 3), dtype=np.float32),
                        np.ones((8, 8, 1), np.float32)], 2)
mm = rng.random((8, 8), dtype=np.float32)
eq("on fully opaque pixels blend is the plain lerp everyone expects",
   bool(np.allclose(sel.blend(opq_o, opq_r, mm),
                    opq_r * mm[..., None] + opq_o * (1 - mm[..., None]), atol=1e-6)), True)
o4 = rng.random((8, 8, 4), dtype=np.float32)
r4 = rng.random((8, 8, 4), dtype=np.float32)
out = sel.blend(o4, r4, mm)
eq("alpha is always exactly the lerp of the two alphas",
   bool(np.allclose(out[..., 3], r4[..., 3] * mm + o4[..., 3] * (1 - mm),
                    atol=1e-7)), True)
eq("a fully transparent outcome keeps a usable colour rather than going black",
   bool(np.all(sel.blend(tr, tr.copy(), half)[..., :3] == 0.0)), True)

# blend picks between gathering the pixels that mix and blending the whole
# frame. Two paths through one arithmetic core, so the thing to prove is that
# the choice is invisible - not that either of them is fast.
mixed = np.clip(np.linspace(-0.2, 1.2, 64, dtype=np.float32).reshape(8, 8), 0, 1)
was = sel._SPARSE
try:
    sel._SPARSE = 10 ** 9
    dense = sel.blend(o4, r4, mixed)
    sel._SPARSE = 1
    sparse = sel.blend(o4, r4, mixed)
finally:
    sel._SPARSE = was
eq("the gathered path and the whole-frame path are bit-identical",
   dense.tobytes(), sparse.tobytes())
eq("...including where the mask is exactly 0 and exactly 1",
   bool(np.array_equal(dense[mixed >= 1.0], r4[mixed >= 1.0])
        and np.array_equal(dense[mixed <= 0.0], o4[mixed <= 0.0])), True)
eq("an all-zero mask gathers nothing and still returns the original",
   sel.blend(o4, r4, np.zeros((8, 8), np.float32)).tobytes(), o4.tobytes())

eq("blend refuses a mask that does not fit, and refuses toward doing NOTHING",
   sel.blend(o4, r4, np.ones((3, 3), np.float32)).tobytes(), o4.tobytes())
eq("...and a mismatched pair of buffers the same way",
   sel.blend(o4, np.ones((4, 4, 4), np.float32), mm).tobytes(), o4.tobytes())
eq("a (H, W, 1) mask is accepted as the (H, W) it is",
   bool(np.array_equal(sel.blend(o4, r4, mm[..., None]), sel.blend(o4, r4, mm))), True)


print("\n  -- through the other column's source --")

try:
    import effects                                          # noqa: E402
except Exception as exc:                                    # pragma: no cover
    eq(f"vfx/effects.py imports ({exc})", True, False)
    effects = None
if effects is not None:
    img = np.concatenate([rng.random((64, 64, 3), dtype=np.float32),
                          np.ones((64, 64, 1), np.float32)], 2)
    mask = sel.resolve({"shapes": [{"kind": "rect", "x": 8, "y": 8, "w": 24, "h": 24}]},
                       img)
    moved = []
    for name in ("invert", "brightnessContrast", "hueSaturation", "gaussianBlur",
                 "tint", "levels"):
        if name not in effects.CATALOG:
            continue
        out = sel.blend(img, effects.apply(name, img, {}, {}), mask)
        outside = np.ones((64, 64), bool)
        outside[8:32, 8:32] = False
        if out[outside].tobytes() != img[outside].tobytes():
            moved.append(name)
    eq("a real effect through blend() leaves every unselected pixel BIT-identical",
       moved, [])
    eq("...and does change the selected ones",
       bool(np.any(sel.blend(img, effects.apply("invert", img, {}, {}), mask)[16, 16]
                   != img[16, 16])), True)
    eq("an all-ones mask makes a real effect bit-identical to running it "
       "unmasked - which is why blend() can be unconditional",
       sel.blend(img, effects.apply("invert", img, {}, {}),
                 np.ones((64, 64), np.float32)).tobytes()
       == effects.apply("invert", img, {}, {}).tobytes(), True)


print("\n  -- describe --")

d = sel.describe({"shapes": [{"kind": "rect", "x": 10, "y": 10, "w": 20, "h": 20}]}, IMG)
eq("describe counts the selection", (d["pixels"], d["fullyIn"], d["empty"]),
   (400.0, 400, False))
eq("...names the no-selection case", sel.describe(None, IMG)["everything"], True)
eq("...and names an empty one", sel.describe({"shapes": []}, IMG)["empty"], True)
eq("...and carries the warnings a caller has to surface",
   len(sel.describe({"shapes": [{"kind": "wand", "x": 9999, "y": 0}]}, IMG)["warnings"]),
   1)
eq("...counting the soft edge separately",
   sel.describe({"shapes": [{"kind": "ellipse", "cx": 80, "cy": 80, "rx": 30,
                             "ry": 30}]}, IMG)["partial"] > 100, True)


print("\n  -- hostile input --")

NASTY = [float("nan"), float("inf"), float("-inf"), None, "", "abc", [], {}, True]
broke, everything = [], []
for bad in NASTY:
    for kind, spec in BASE.items():
        for key in list(spec):
            if key == "kind":
                continue
            probe = dict(spec)
            probe[key] = bad
            try:
                mask = sel.resolve({"shapes": [probe]}, SCENE)
            except Exception as exc:
                broke.append(f"{kind}.{key}={bad!r}: {exc}")
                continue
            if not np.isfinite(mask).all():
                broke.append(f"{kind}.{key}={bad!r}: not finite")
            elif float(mask.min()) >= 1.0:
                everything.append(f"{kind}.{key}={bad!r}")
eq("no shape parameter can be made to raise", broke, [])
eq("...and none of them silently selects the whole frame", everything, [])

broke, everything = [], []
for bad in NASTY:
    for key in ("feather", "expand", "invert", "antialias", "mode", "shapes"):
        probe = {"shapes": [BASE["rect"]], key: bad}
        try:
            mask = sel.resolve(probe, SCENE)
        except Exception as exc:
            broke.append(f"{key}={bad!r}: {exc}")
            continue
        if not np.isfinite(mask).all():
            broke.append(f"{key}={bad!r}: not finite")
        # Two of these are SUPPOSED to be able to reach a full frame, and both
        # are arithmetic rather than an accident: inverting an empty selection
        # is the whole frame, and `shapes: null` is how JSON spells "no
        # selection", which §3 defines as a mask of ones.
        elif float(mask.min()) >= 1.0 and not (
                key == "invert" or (key == "shapes" and bad is None)):
            everything.append(f"{key}={bad!r}")
eq("no modifier can be made to raise", broke, [])
eq("...and none of them silently selects the whole frame either", everything, [])

for label, bad in (("a shapes list of garbage", {"shapes": [1, "x", None, []]}),
                   ("a selection that is a list", [1, 2, 3]),
                   ("a selection that is a string", "everything"),
                   ("an unknown kind", {"shapes": [{"kind": "quantum"}]}),
                   ("a shape with no kind", {"shapes": [{"x": 1}]}),
                   ("negative sizes", {"shapes": [{"kind": "ellipse", "rx": -5,
                                                   "ry": -5, "cx": 80, "cy": 80}]}),
                   ("expand beyond the frame", {"shapes": [BASE["rect"]],
                                                "expand": 99999}),
                   ("feather beyond the frame", {"shapes": [BASE["rect"]],
                                                 "feather": 9999})):
    try:
        mask = sel.resolve(bad, SCENE)
        ok = mask.shape == (160, 160) and np.isfinite(mask).all()
    except Exception as exc:
        ok = f"raised {exc}"
    eq(f"{label} survives", ok, True)

w = []
sel.resolve({"shapes": [{"kind": "quantum"}]}, SCENE, w)
eq("an unknown kind lists the ones that exist",
   bool(w and "quantum" in w[0] and "colorRange" in w[0]), True)

# §9 again: unknown keys have to be IGNORED, but silently ignoring them is how
# a caller ends up trusting a parameter that does nothing.
w = []
sel.resolve({"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 9, "h": 9,
                         "radius": 4, "colour": "red"}]}, SCENE, w)
eq("an unknown key on a shape is named back",
   bool(w and "radius" in w[0] and "colour" in w[0]), True)
w = []
sel.resolve({"shapes": [dict(BASE["rect"], feather=3, antialias=False)]}, SCENE, w)
eq("...and a modifier written on a shape is told where it belongs",
   bool(w and "selection, not to a shape" in w[0]), True)
eq("a shape spelled correctly says nothing at all",
   sel.describe({"shapes": [BASE["rect"]]}, SCENE)["warnings"], [])

far = {"shapes": [{"kind": "polygon", "points": [[-900, -900], [-800, -900],
                                                 [-850, -800]]}]}
w = []
eq("a shape entirely off-frame selects nothing", area(sel.resolve(far, SCENE, w)), 0.0)
eq("...and says where it went", any("outside" in x for x in w), True)
eq("a polygon that straddles the frame edge keeps only what is inside",
   area(one("polygon", points=[[-20, -20], [20, -20], [20, 20], [-20, 20]])), 400.0)

tiny = flat(1, 1, (0.3, 0.6, 0.9))
broke = []
for kind, spec in BASE.items():
    try:
        mask = sel.resolve({"shapes": [dict(spec, x=0, y=0, cx=0, cy=0)],
                            "feather": 3, "expand": 2}, tiny)
        if mask.shape != (1, 1) or not np.isfinite(mask).all():
            broke.append(kind)
    except Exception as exc:
        broke.append(f"{kind}: {exc}")
eq("a 1x1 image resolves every kind, with feather and expand on top", broke, [])
eq("a 2x1 image too", sel.resolve({"shapes": [BASE["rect"]]},
                                  flat(2, 1)).shape, (2, 1))
w = []
eq("no image at all is a warning and an empty mask, not a crash",
   (float(sel.resolve({"shapes": [BASE["rect"]]}, None, w).sum()), len(w) > 0),
   (0.0, True))
eq("a 2-D single-channel image is treated as greyscale",
   sel.resolve({"shapes": [{"kind": "colorRange", "color": [128, 128, 128],
                            "tolerance": 60}]}, np.full((8, 8), 0.5, np.float32)).shape,
   (8, 8))
eq("an 8-bit image is 0..255 and is scaled, not reinterpreted",
   area(sel.resolve({"shapes": [{"kind": "wand", "x": 1, "y": 1, "tolerance": 5}]},
                    np.full((8, 8, 4), 255, np.uint8))), 64.0)


print("\n  -- cost at 4096x4096 --")

for name, ms in sel._bench(4096, 2).items():
    print(f"  {name:<14} {ms:8.1f} ms")

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
