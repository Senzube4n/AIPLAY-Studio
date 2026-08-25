"""Unit tests for the brush class in server/imgstroke.py.

A brush is not a thing you eyeball. Every claim §5 makes has a number behind
it - a stamp of radius 20 at hardness 0.5 covers 722.6 pixels, a smoothstep
half way down its falloff is exactly 0.5, two passes of a 50% flow brush are
0.5 then 0.75 and two passes at 50% opacity are 0.5 then 0.5 - so almost every
case below is arithmetic done on paper first and asserted second. Where a
number was taken from the implementation it is because the implementation is
the definition (the catalog), and it says so.

Three kinds of test, the split effects_test.py and shapes_test.py use.

  * SWEEPS over the CATALOG: every tool renders, every default sits inside its
    own advertised range, every entry carries a label / group / why, every
    tool comes back float32 0..1 straight alpha without touching its input -
    and, the one that costs this codebase features, EVERY DECLARED PARAMETER
    CHANGES THE PICTURE. A schema that accepts a knob the code ignores is
    worse than a refusal, so it is asserted rather than believed.
  * ONE MEANINGFUL ASSERTION PER RULE - not "it ran" but "the falloff is
    0.896 at r=12", "spacing 2.0 gives eight separate blobs and spacing 0.25
    gives one", "heal's low frequencies are the DESTINATION's and clone's are
    the source's", "white over half-transparent white stays exactly white".
  * HOSTILITY: NaN, inf, zero and negative sizes, empty paths, one-point
    paths, points a million pixels off-plate, a mask of the wrong shape - on
    all twelve tools. Nothing raises, and nothing quietly does the wrong
    thing either.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgstroke_test.py

numpy / cv2. Nothing here imports imgselect - the mask is just an array, which
is the whole point of the parameter.
"""
import contextlib
import io
import math
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imgstroke as S                                          # noqa: E402

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
    eq(name, abs(float(got) - float(want)) <= tol, True)


def quiet(fn, *a, **kw):
    """Run something that is SUPPOSED to complain on stderr without the
    complaint drowning the report."""
    with contextlib.redirect_stderr(io.StringIO()) as buf:
        out = fn(*a, **kw)
    return out, buf.getvalue()


def clear(h=256, w=256, a=0.0):
    img = np.zeros((h, w, 4), np.float32)
    img[..., 3] = a
    return img


FLAT = 0.5                                  # the grey the two flat regions are


def plate(h=256, w=256):
    """One image that every sweep can use: a luma ramp so the tonal ranges
    differ across it, a saturated hue so the sponge has something to take
    away, a fine texture so blur and sharpen and heal have detail to move,
    two DISCONNECTED flat regions of the same colour so the bucket's
    contiguity flag means something, and a half-transparent band so the
    alpha-touching tools are exercised over straight alpha rather than over
    an opaque plate where every blending bug looks identical."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.zeros((h, w, 4), np.float32)
    ramp = xx / (w - 1)
    tex = np.sin(xx / 1.2732) * 0.06 + np.sin(yy / 2.1) * 0.04
    img[..., 0] = np.clip(0.15 + ramp * 0.7 + tex, 0, 1)
    img[..., 1] = np.clip(0.55 - ramp * 0.35 + tex, 0, 1)
    img[..., 2] = np.clip(0.30 + (yy / (h - 1)) * 0.5 + tex, 0, 1)
    img[..., 3] = 1.0
    img[20:70, 100:200, :3] = FLAT          # region A - straddles x=128
    img[180:230, 20:90, :3] = FLAT          # region B - same colour, apart
    img[240:, :, 3] = 0.5
    return img


PLATE = plate()
# The same plate with an alpha STEP the path crosses, and a flat region inside
# the thin half for the bucket. touchesAlpha is a claim about what a tool CAN
# do, and an opaque plate is exactly where every alpha bug hides.
ASTEP = plate()
ASTEP[110:, :, 3] = 0.25
ASTEP[130:170, 100:200, :3] = FLAT
PATH = [[40.5, 120.5, 1.0], [120.5, 90.5, 0.7], [210.5, 150.5, 0.35]]

# One representative stroke per tool - the sweeps below all run through this
# so "every tool" means every tool, not "every tool I remembered".
JOBS = {
    "brush":    {"points": PATH, "size": 26, "color": [255, 30, 90, 255]},
    "eraser":   {"points": PATH, "size": 26},
    "clone":    {"points": PATH, "size": 26, "source": [40.5, 200.5]},
    "heal":     {"points": PATH, "size": 26, "source": [40.5, 200.5]},
    "smudge":   {"points": PATH, "size": 26, "amount": 0.8},
    "blur":     {"points": PATH, "size": 26, "amount": 1.0},
    "sharpen":  {"points": PATH, "size": 26, "amount": 1.0},
    "dodge":    {"points": PATH, "size": 26, "amount": 0.9, "range": "all"},
    "burn":     {"points": PATH, "size": 26, "amount": 0.9, "range": "all"},
    "sponge":   {"points": PATH, "size": 26, "amount": 1.0},
    "bucket":   {"points": [[110.5, 45.5]], "tolerance": 0, "color": [0, 255, 255, 255]},
    "gradient": {"points": [[40.5, 40.5], [210.5, 210.5]]},
}


def job(name, **kw):
    out = dict(JOBS[name], tool=name)
    out.update(kw)
    return out


print("\nimgstroke\n")
print("  -- the catalog contract --")

bad = [k for k, e in S.CATALOG.items()
       if not (e.get("label") and e.get("why") and e.get("group") in S.GROUP_ORDER
               and isinstance(e.get("touchesAlpha"), bool) and e.get("points"))]
eq("every entry has a label, a group, a why, an alpha claim and a point rule", bad, [])

bad = []
for k, e in S.CATALOG.items():
    for pk, p in e["params"].items():
        if "desc" not in p or "type" not in p:
            bad.append(f"{k}.{pk}")
        elif p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append(f"{k}.{pk}")
        elif p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append(f"{k}.{pk}")
eq("every parameter is described and defaults inside its own range", bad, [])

eq("the twelve tools the spec names are the twelve that exist",
   sorted(S.CATALOG),
   sorted(["brush", "eraser", "clone", "heal", "smudge", "blur", "sharpen",
           "dodge", "burn", "sponge", "bucket", "gradient"]))
eq("every catalog entry has an implementation and back",
   sorted(S.CATALOG) == sorted(S._TOOLS), True)
eq("the aliases all point at something real",
   sorted({v for v in S.ALIASES.values()} - set(S.CATALOG)), [])
eq("an alias reaches the same tool as its real name",
   float(np.abs(S.apply_stroke(PLATE, job("bucket", tool="floodFill"))
                - S.apply_stroke(PLATE, job("bucket"))).max()), 0.0)
cat = S.catalog()
eq("catalog() serves the whole vocabulary and says what the units are",
   sorted(cat["tools"]) == sorted(S.CATALOG)
   and set(cat["notes"]) >= {"coordinates", "colors", "alpha", "flow",
                             "pressure", "selection"}, True)
eq("every tool the sweeps use is covered", sorted(JOBS), sorted(S.CATALOG))


print("\n  -- the output contract --")

bad, mutated, ranged, typed = [], [], [], []
for name in sorted(S.CATALOG):
    before = PLATE.copy()
    out, _ = quiet(S.apply_stroke, PLATE, job(name))
    if out is PLATE or float(np.abs(out - PLATE).max()) == 0.0:
        bad.append(name)
    if not np.array_equal(PLATE, before):
        mutated.append(name)
    if out.dtype != np.float32 or out.shape != PLATE.shape:
        typed.append(name)
    if not np.isfinite(out).all() or out.min() < 0.0 or out.max() > 1.0:
        ranged.append(name)
eq("every tool draws something", bad, [])
eq("no tool writes to the array it was given", mutated, [])
eq("every tool returns float32 (H, W, 4)", typed, [])
eq("every tool returns finite 0..1", ranged, [])

# §9's favourite: a schema that accepts a parameter the code then ignores.
# Perturb every declared parameter of every tool and demand a different
# picture. This is the only reason to trust the catalog an agent is served.
PERTURB = {
    "size": 90, "hardness": 1.0, "opacity": 0.15, "flow": 0.15, "spacing": 2.5,
    "pressure": "off", "amount": 0.05, "radius": 40, "detailRadius": 60,
    "range": "highlights", "mode": "saturate", "tolerance": 255,
    "contiguous": False, "antialias": False, "color": [12, 200, 40, 120],
    "color2": [255, 0, 0, 60], "reverse": True, "shape": "radial",
    "source": [200.5, 40.5],
}
ignored = []
for name in sorted(S.CATALOG):
    base, _ = quiet(S.apply_stroke, PLATE, job(name))
    for pk in S.CATALOG[name]["params"]:
        alt, _ = quiet(S.apply_stroke, PLATE, job(name, **{pk: PERTURB[pk]}))
        if float(np.abs(alt - base).max()) < 1e-4:
            ignored.append(f"{name}.{pk}")
eq("every parameter in the schema changes the picture", ignored, [])

eq("every enum option is honoured, not just the default",
   [f"{k}.{pk}={o}" for k, e in S.CATALOG.items() for pk, p in e["params"].items()
    if p["type"] == "enum" for o in p["options"]
    if float(np.abs(quiet(S.apply_stroke, PLATE, job(k, **{pk: o}))[0]
                    - quiet(S.apply_stroke, PLATE, job(k, **{pk: p["options"][0]}))[0]).max()) == 0.0
    and o != p["options"][0]],
   [])

# touchesAlpha reads in two directions and they are not the same claim: false
# means NEVER, true means CAN. Asserting the second over an opaque plate would
# pass for a tool that has quietly stopped touching alpha at all.
lied, unproven = [], []
for name in sorted(S.CATALOG):
    for plane in (PLATE, ASTEP):
        j = job(name, points=[[150.5, 150.5]]) if name == "bucket" else job(name)
        out, _ = quiet(S.apply_stroke, plane, j)
        moved = float(np.abs(out[..., 3] - plane[..., 3]).max()) > 1e-6
        if moved and not S.CATALOG[name]["touchesAlpha"]:
            lied.append(name)
        if plane is ASTEP and S.CATALOG[name]["touchesAlpha"] and not moved:
            unproven.append(name)
eq("nothing that claims to leave alpha alone ever touches it", sorted(set(lied)), [])
eq("...and every tool that claims to touch alpha is caught doing it", unproven, [])


print("\n  -- the stamp: hardness is a curve --")

# radius 20, hardness 0.5: solid to r=10, smoothstep 1-t^2(3-2t) to 0 at r=20.
# t=0.1/0.25/0.35/0.4/0.5 -> 0.972/0.896/0.7822/0.7104/0.5, and the numbers
# below are that polynomial evaluated by hand, not read back off the code.
one = S.apply_stroke(clear(), {"tool": "brush", "points": [[128.5, 128.5]],
                               "size": 40, "hardness": 0.5,
                               "color": [255, 255, 255, 255]})[..., 3]
for d, want in ((0, 1.0), (10, 1.0), (12, 0.896), (15, 0.5),
                (17, 0.216), (18, 0.104), (20, 0.0), (22, 0.0)):
    near(f"falloff at r={d} is {want}", one[128, 128 + d], want, 1e-4)
eq("the falloff is radial, not square: the corner at 15,15 is 21.2 away and empty "
   "while 15 along a row is still half covered",
   abs(float(one[128 + 10, 128]) - float(one[128, 128 + 10])) < 1e-6
   and float(one[128 + 15, 128 + 15]) == 0.0
   and abs(float(one[128, 128 + 15]) - 0.5) < 1e-4, True)

# Coverage is the integral of that profile, and the integral has a closed
# form: pi*r_in^2 + 200*pi*int_0^1 (1-3u^2+2u^3)(1+u) du = 314.16 + 130*pi.
near("a hardness 0.5 stamp of radius 20 covers 722.6 pixels",
     one.sum(), 314.159 + 130.0 * math.pi, 8.0)
hard = S.apply_stroke(clear(), {"tool": "brush", "points": [[128.5, 128.5]],
                                "size": 40, "hardness": 1.0,
                                "color": [255, 255, 255, 255]})[..., 3]
# hardness 1 holds a one-pixel rim open, so it is a disc of radius 19.5, not 20.
near("a hardness 1.0 stamp is a disc of radius 19.5, antialiased",
     hard.sum(), math.pi * 19.5 * 19.5, 12.0)
eq("...and its rim is a ramp, not a step",
   int(((hard > 0.02) & (hard < 0.98)).sum()) > 60, True)
eq("...while a hardness 0 stamp is falloff all the way in",
   float(S.apply_stroke(clear(), {"tool": "brush", "points": [[128.5, 128.5]],
                                  "size": 40, "hardness": 0.0,
                                  "color": [255, 255, 255, 255]})[128, 138, 3]) < 0.55,
   True)
eq("colours are 0-255: 255,0,0 paints RED, not near-black",
   [round(float(v), 4) for v in S.apply_stroke(clear(), {
       "tool": "brush", "points": [[128.5, 128.5]], "size": 40, "hardness": 1.0,
       "color": [255, 0, 0, 255]})[128, 128, :3]],
   [1.0, 0.0, 0.0])
eq("...and an UNSATURATED colour arrives at exactly v/255, which is where a "
   "scaling slip would still have looked plausible",
   [round(float(v), 5) for v in S.apply_stroke(clear(), {
       "tool": "brush", "points": [[128.5, 128.5]], "size": 40, "hardness": 1.0,
       "color": [128, 64, 192, 255]})[128, 128, :3]],
   [round(128 / 255, 5), round(64 / 255, 5), round(192 / 255, 5)])


print("\n  -- flow accumulates, opacity caps --")

# spacing 1.0 at size 40 puts dabs exactly 40px apart, so at x=140 there is
# ONE dab and its neighbours contribute nothing: the numbers are the model,
# with no overlap arithmetic hiding in them. The doubled path is one stroke
# that walks out and back over its own dabs.
OUT = [[100.5, 128.5], [220.5, 128.5]]
BACK = [[100.5, 128.5], [220.5, 128.5], [100.5, 128.5]]
pen = {"tool": "brush", "size": 40, "hardness": 1.0, "spacing": 1.0,
       "color": [255, 255, 255, 255]}


def at140(pts, **kw):
    return float(S.apply_stroke(clear(), dict(pen, points=pts, **kw))[128, 140, 3])


near("one pass at flow 0.5 lays down 0.5", at140(OUT, flow=0.5), 0.5, 1e-4)
near("...and a second pass in the SAME stroke reaches 0.75",
     at140(BACK, flow=0.5), 0.75, 1e-4)
eq("...so flow accumulates within one stroke",
   at140(BACK, flow=0.5) > at140(OUT, flow=0.5) + 0.2, True)
near("one pass at opacity 0.5 lays down 0.5",
     at140(OUT, flow=1.0, opacity=0.5), 0.5, 1e-4)
near("...and a second pass in the same stroke is still 0.5",
     at140(BACK, flow=1.0, opacity=0.5), 0.5, 1e-4)
eq("...so opacity caps instead of accumulating",
   abs(at140(BACK, flow=1.0, opacity=0.5) - at140(OUT, flow=1.0, opacity=0.5)) < 1e-6,
   True)
s1 = S.apply_stroke(clear(), dict(pen, points=OUT, flow=1.0, opacity=0.5))
s2 = S.apply_stroke(s1, dict(pen, points=OUT, flow=1.0, opacity=0.5))
near("two SEPARATE strokes at opacity 0.5 do compound - build-up depends on it",
     s2[128, 140, 3], 0.75, 1e-4)
# min(S, opacity) would flatten every soft brush into a mesa: at hardness 0 the
# whole disc out to r=14 has S >= 0.5 and would all clip to exactly 0.5. Scaling
# instead keeps the curve, so r=10 - half way down a smoothstep - reads 0.25.
mesa = S.apply_stroke(clear(), {"tool": "brush", "points": [[128.5, 128.5]],
                                "size": 40, "hardness": 0.0, "opacity": 0.5,
                                "color": [255, 255, 255, 255]})[..., 3]
near("opacity scales the falloff: half way down the curve reads 0.25, not 0.5",
     mesa[128, 138], 0.25, 1e-4)
eq("...so there is no plateau where min() would have made one",
   int(np.count_nonzero(np.abs(mesa - 0.5) < 1e-6)) < 4, True)


print("\n  -- the path is stamped, not drawn --")


def diag(spacing, flow=0.12, hardness=0.4, size=40):
    o = S.apply_stroke(clear(800, 800), {
        "tool": "brush", "points": [[200.5, 200.5], [600.5, 600.5]],
        "size": size, "hardness": hardness, "flow": flow, "spacing": spacing,
        "color": [255, 255, 255, 255]})
    a = o[..., 3]
    return np.array([a[k, k] for k in range(230, 571)]), o


line, _ = diag(0.25)
eq("a diagonal stroke has no gaps", float(line.min()) > 0.05, True)
eq("...and no lumps: coverage along it varies under 3%",
   float(line.std() / line.mean()) < 0.03, True)
lumpy, _ = diag(0.5)
eq("...and the same measurement CATCHES lumps when spacing doubles",
   float(lumpy.std() / lumpy.mean()) > 0.15, True)
_, beads = diag(2.0, flow=1.0)
eq("spacing 2.0 beads into separate blobs - which a polyline could never do",
   int(cv2.connectedComponents((beads[..., 3] > 0.5).astype(np.uint8))[0] - 1), 8)
_, solid = diag(0.25, flow=1.0)
eq("...and spacing 0.25 over the same two points is one connected stroke",
   int(cv2.connectedComponents((solid[..., 3] > 0.5).astype(np.uint8))[0] - 1), 1)
eq("the client's two points become ~57 dabs, interpolated between them",
   len(S._walk([(200.5, 200.5, 1.0), (600.5, 600.5, 1.0)], 40, 0.25, "off")), 57)
eq("...which is one dab at the start plus arc length over the step",
   int(math.hypot(400, 400) // 10.0) + 1, 57)


print("\n  -- pressure --")


def dab(mode, pr):
    """One dab at one pressure - no accumulation to hide behind."""
    o = S.apply_stroke(clear(), {"tool": "brush", "points": [[128.5, 128.5, pr]],
                                 "size": 40, "hardness": 0.9, "pressure": mode,
                                 "color": [255, 255, 255, 255]})[..., 3]
    return int((o[128] > 0.01).sum()), float(o.max())


P = {m: (dab(m, 1.0), dab(m, 0.25)) for m in S.PRESSURE_MODES}
(fw, fp), (lw, lp) = P["size"]
eq("pressure 'size' quarters the WIDTH at quarter pressure and leaves the peak at 1.0",
   abs(lw - fw * 0.25) <= 2 and fp == lp == 1.0, True)
(fw, fp), (lw, lp) = P["flow"]
eq("pressure 'flow' quarters the PEAK and leaves the width alone",
   lw == fw and abs(lp - 0.25) < 1e-4 and fp == 1.0, True)
(fw, fp), (lw, lp) = P["both"]
eq("pressure 'both' does both - the default, because a light touch is a "
   "narrower AND a lighter mark",
   abs(lw - fw * 0.25) <= 2 and abs(lp - 0.25) < 1e-4, True)
eq("pressure 'off' ignores it entirely", P["off"][0], P["off"][1])

# spacing 1.0 at size 40 puts the dabs exactly a diameter apart, so each of
# these columns IS one dab and reads its own pressure straight off.
taper = S.apply_stroke(clear(), {
    "tool": "brush", "points": [[40.5, 128.5, 1.0], [220.5, 128.5, 0.0]],
    "size": 40, "hardness": 1.0, "spacing": 1.0, "pressure": "flow",
    "color": [255, 255, 255, 255]})[..., 3]
peaks = [float(taper[128, x]) for x in (40, 80, 120, 160, 200)]
eq("pressure is INTERPOLATED between the points the client sent",
   all(peaks[i] > peaks[i + 1] for i in range(4)), True)
for x, want in ((80, 1 - 40 / 180), (120, 1 - 80 / 180), (160, 1 - 120 / 180)):
    near(f"...linearly: at x={x} of a 180px ramp it is {want:.3f}",
         taper[128, x], want, 0.005)

TAPER = [[40.5, 128.5, 1.0], [220.5, 128.5, 0.2]]
eq("a missing third component means full pressure",
   float(np.abs(S.apply_stroke(clear(), {"tool": "brush", "size": 30,
                                         "points": [[40.5, 128.5], [200.5, 128.5]]})
                - S.apply_stroke(clear(), {"tool": "brush", "size": 30,
                                           "points": [[40.5, 128.5, 1.0],
                                                      [200.5, 128.5, 1.0]]})).max()),
   0.0)
eq("a tapering tip stays dense - spacing follows the LOCAL size, not the typed one",
   float(np.array([S.apply_stroke(clear(), {
       "tool": "brush", "points": TAPER, "size": 40, "hardness": 0.9,
       "pressure": "size", "color": [255, 255, 255, 255]})[128, x, 3]
       for x in range(180, 215)]).min()) > 0.99, True)


print("\n  -- clone and heal are not the same tool --")

TEX = clear(256, 256, a=1.0)
_yy, _xx = np.mgrid[0:256, 0:256].astype(np.float32)
TEX[..., :3] = (0.2 + np.sin(_xx / 1.2732) * 0.06)[..., None]
TEX[:, 140:230, :3] += 0.6                    # the destination sits 0.6 brighter
TEX = np.clip(TEX, 0, 1)
SRC, DST = (slice(120, 137), slice(52, 69)), (slice(120, 137), slice(172, 189))
stamp = {"points": [[180.5, 128.5]], "size": 40, "hardness": 1.0,
         "source": [60.5, 128.5]}
cl = S.apply_stroke(TEX, dict(stamp, tool="clone"))
hl = S.apply_stroke(TEX, dict(stamp, tool="heal"))


def lo(a):
    return cv2.GaussianBlur(np.ascontiguousarray(a[..., 0]), (0, 0), 10.0)


eq("clone reproduces the source region exactly at the offset",
   float(np.abs(cl[DST] - TEX[SRC]).max()) < 1e-5, True)
eq("heal does NOT - it is not a clone with a different name",
   float(np.abs(hl[DST] - TEX[SRC]).max()) > 0.4, True)
near("heal's low frequencies are the DESTINATION's",
     np.abs(lo(hl)[DST] - lo(TEX)[DST]).max(), 0.0, 0.005)
eq("...where clone's are the source's, half a stop away",
   float(np.abs(lo(cl)[DST] - lo(TEX)[DST]).max()) > 0.4, True)
near("...and heal's DETAIL is still the source's",
     np.abs((hl[..., 0] - lo(hl))[DST] - (TEX[..., 0] - lo(TEX))[SRC]).max(), 0.0, 0.005)
eq("the offset is fixed at stroke start, so a long stroke copies a rigid shape",
   float(np.abs(S.apply_stroke(TEX, {"tool": "clone", "size": 20, "hardness": 1.0,
                                     "source": [40.5, 40.5],
                                     "points": [[100.5, 100.5], [140.5, 100.5]]})[100, 130]
                - TEX[40, 70]).max()) < 1e-5, True)
eq("heal leaves alpha alone - a retouch is not a copy",
   float(np.abs(S.apply_stroke(PLATE, job("heal"))[..., 3] - PLATE[..., 3]).max()), 0.0)
eq("a clone with no source draws nothing rather than copying the corner",
   float(np.abs(quiet(S.apply_stroke, TEX, {"tool": "clone", "size": 40,
                                            "points": [[128.5, 128.5]]})[0] - TEX).max()), 0.0)
eq("...and says so on stderr",
   "source" in quiet(S.apply_stroke, TEX, {"tool": "clone", "size": 40,
                                           "points": [[128.5, 128.5]]})[1], True)


print("\n  -- smudge carries colour along the path --")

TWO = clear(300, 300, a=1.0)
TWO[:, :150, 0] = 1.0
TWO[:, 150:, 2] = 1.0
fwd = S.apply_stroke(TWO, {"tool": "smudge", "size": 30, "hardness": 0.6,
                           "amount": 0.7, "points": [[80.5, 150.5], [250.5, 150.5]]})
rev = S.apply_stroke(TWO, {"tool": "smudge", "size": 30, "hardness": 0.6,
                           "amount": 0.7, "points": [[250.5, 150.5], [80.5, 150.5]]})
eq("dragging red into blue carries red past the boundary",
   float(fwd[150, 180, 0]) > 0.4, True)
eq("...and it dies out with distance",
   float(fwd[150, 240, 0]) < float(fwd[150, 180, 0]) * 0.5, True)
eq("...and the reverse stroke carries blue the other way instead",
   float(rev[150, 120, 2]) > 0.4 and float(rev[150, 180, 0]) < 0.01, True)
eq("amount 0 is a no-op, amount 1 smears furthest",
   float(np.abs(S.apply_stroke(TWO, {"tool": "smudge", "size": 30, "amount": 0.0,
                                     "points": [[80.5, 150.5], [250.5, 150.5]]})
                - TWO).max()) < 1e-6
   and float(S.apply_stroke(TWO, {"tool": "smudge", "size": 30, "amount": 1.0,
                                  "points": [[80.5, 150.5], [250.5, 150.5]]})[150, 240, 0])
   > float(fwd[150, 240, 0]), True)
eq("a one-point smudge has no direction and draws nothing",
   float(np.abs(quiet(S.apply_stroke, TWO, {"tool": "smudge", "size": 30,
                                            "points": [[150.5, 150.5]]})[0] - TWO).max()), 0.0)


print("\n  -- blur, sharpen: local and brush-shaped --")

NOISE = clear(256, 256, a=1.0)
NOISE[..., :3] = np.random.default_rng(3).random((256, 256, 3), np.float32) * 0.6 + 0.2
soft = S.apply_stroke(NOISE, {"tool": "blur", "size": 60, "amount": 1.0,
                              "hardness": 1.0, "points": [[128.5, 128.5]]})
crisp = S.apply_stroke(NOISE, {"tool": "sharpen", "size": 60, "amount": 1.0,
                               "hardness": 1.0, "points": [[128.5, 128.5]]})
mid = (slice(115, 142), slice(115, 142))
far = (slice(0, 40), slice(0, 40))
eq("the blur brush softens under itself",
   float(soft[mid][..., :3].std()) < float(NOISE[mid][..., :3].std()) * 0.4, True)
eq("...and leaves the rest of the plate bit-identical", np.array_equal(soft[far], NOISE[far]), True)
eq("the sharpen brush does the opposite",
   float(crisp[mid][..., :3].std()) > float(NOISE[mid][..., :3].std()) * 1.4, True)
eq("...and leaves the rest of the plate bit-identical", np.array_equal(crisp[far], NOISE[far]), True)
eq("a bigger radius blurs more", float(S.apply_stroke(NOISE, {
    "tool": "blur", "size": 60, "amount": 1.0, "hardness": 1.0, "radius": 12,
    "points": [[128.5, 128.5]]})[mid][..., :3].std())
   < float(soft[mid][..., :3].std()), True)


print("\n  -- dodge, burn, sponge --")

GREY = clear(64, 64, a=1.0)
GREY[..., :3] = 0.5
dot = {"points": [[32.5, 32.5]], "size": 30, "hardness": 1.0, "amount": 0.4,
       "range": "all"}
d = float(S.apply_stroke(GREY, dict(dot, tool="dodge"))[32, 32, 0])
b = float(S.apply_stroke(GREY, dict(dot, tool="burn"))[32, 32, 0])
near("dodge at amount 0.4 lifts a 0.5 pixel by 0.4*(1-0.5)", d, 0.7, 1e-4)
near("burn at amount 0.4 drops it by 0.4*0.5", b, 0.3, 1e-4)
eq("...so they are exact mirrors about the pixel they start from",
   abs((d - 0.5) - (0.5 - b)) < 1e-6, True)

RAMP = clear(64, 64, a=1.0)
RAMP[..., :3] = 0.15                                    # a shadow
near("a HIGHLIGHTS dodge leaves a 0.15 pixel exactly alone",
     S.apply_stroke(RAMP, dict(dot, tool="dodge", range="highlights"))[32, 32, 0],
     0.15, 1e-6)
eq("...while a SHADOWS dodge lifts it",
   float(S.apply_stroke(RAMP, dict(dot, tool="dodge", range="shadows"))[32, 32, 0]) > 0.3,
   True)
# midtones weight at luma 0.5 is 1-|2*0.5-1| = 1, at 0.15 it is 1-0.7 = 0.3
near("the midtones weight at luma 0.15 is 0.3, so the lift is 0.4*0.3*0.85",
     S.apply_stroke(RAMP, dict(dot, tool="dodge", range="midtones"))[32, 32, 0],
     0.15 + 0.4 * 0.3 * 0.85, 1e-4)

SAT = clear(64, 64, a=1.0)
SAT[..., 0], SAT[..., 1], SAT[..., 2] = 0.9, 0.2, 0.2
spg = dict(dot, tool="sponge", amount=1.0)
grey_out = S.apply_stroke(SAT, dict(spg, mode="desaturate"))[32, 32, :3]
eq("a full desaturate lands every channel on the luma",
   float(np.abs(grey_out - float(grey_out @ S.LUMA)).max()) < 1e-5, True)
eq("saturate pushes the other way", float(S.apply_stroke(SAT, dict(spg, mode="saturate"))[32, 32, 1])
   < float(SAT[32, 32, 1]), True)
eq("...and neither one moves a pixel that is already grey",
   float(np.abs(S.apply_stroke(GREY, dict(spg, mode="saturate"))[32, 32, :3] - 0.5).max()) < 1e-6,
   True)


print("\n  -- bucket --")

BAR = clear(300, 300, a=1.0)
BAR[..., :3] = 1.0
BAR[:, 200:209, 0] = 0.0
BAR[:, 200:209, 1] = 0.0                     # a blue bar: the blue channel reads coverage
fill = {"tool": "bucket", "points": [[100.5, 100.5]], "tolerance": 0,
        "color": [255, 0, 0, 255]}
cov = 1.0 - S.apply_stroke(BAR, fill)[..., 2]
eq("the fill covers its region EXACTLY - every interior pixel is 1.0",
   (float(cov[:, :200].min()), float(cov[:, :200].max())), (1.0, 1.0))
near("...with half a pixel of partial coverage at the edge it stopped at",
     cov[150, 200], 0.5, 1e-6)
eq("...and nothing at all one pixel further in", float(cov[150, 201]), 0.0)
eq("it stops at the boundary: the far side is untouched", float(cov[:, 209:].max()), 0.0)
eq("antialias off gives a hard edge instead",
   float((1.0 - S.apply_stroke(BAR, dict(fill, antialias=False))[..., 2])[150, 200]), 0.0)
eq("contiguous off fills the far side too",
   float((1.0 - S.apply_stroke(BAR, dict(fill, contiguous=False))[..., 2])[150, 250]), 1.0)
GRAD = clear(64, 64, a=1.0)
GRAD[..., :3] = (np.arange(64, dtype=np.float32) / 255.0)[None, :, None]
tol_hit = np.abs(S.apply_stroke(GRAD, dict(fill, points=[[0.5, 32.5]], tolerance=16,
                                           antialias=False)) - GRAD).max(axis=2) > 0
eq("tolerance 16 admits exactly the 17 columns within 16/255 of the seed",
   int(tol_hit[32].sum()), 17)
eq("...and tolerance 0 admits only the seed's own column",
   int((np.abs(S.apply_stroke(GRAD, dict(fill, points=[[0.5, 32.5]], tolerance=0,
                                         antialias=False)) - GRAD).max(axis=2) > 0)[32].sum()),
   1)
eq("a seed off the plate fills nothing and says so",
   (float(np.abs(quiet(S.apply_stroke, BAR, dict(fill, points=[[900.5, 4.5]]))[0] - BAR).max()),
    "outside" in quiet(S.apply_stroke, BAR, dict(fill, points=[[900.5, 4.5]]))[1]),
   (0.0, True))


print("\n  -- gradient --")

BLACK = clear(400, 400, a=1.0)
ramp = {"tool": "gradient", "points": [[100.5, 200.5], [300.5, 200.5]],
        "color": [255, 0, 0, 255], "color2": [0, 0, 255, 255]}
for shape, mx in (("linear", 200), ("radial", 200)):
    g = S.apply_stroke(BLACK, dict(ramp, shape=shape))
    eq(f"{shape}: the first endpoint is exactly the first colour",
       [round(float(v), 5) for v in g[200, 100, :3]], [1.0, 0.0, 0.0])
    eq(f"{shape}: the second endpoint is exactly the second colour",
       [round(float(v), 5) for v in g[200, 300, :3]], [0.0, 0.0, 1.0])
    eq(f"{shape}: and the midpoint is the midpoint",
       [round(float(v), 5) for v in g[200, 200, :3]], [0.5, 0.0, 0.5])
ang = S.apply_stroke(BLACK, dict(ramp, shape="angular"))
eq("angular starts the wheel at the direction of the second point",
   [round(float(v), 5) for v in ang[200, 300, :3]], [1.0, 0.0, 0.0])
eq("...and is half way round at the opposite bearing",
   [round(float(v), 5) for v in ang[200, 50, :3]], [0.5, 0.0, 0.5])
eq("reverse swaps the ends",
   [round(float(v), 5) for v in S.apply_stroke(BLACK, dict(ramp, reverse=True))[200, 100, :3]],
   [0.0, 0.0, 1.0])
fade = S.apply_stroke(clear(400, 400, a=1.0), dict(
    ramp, color=[255, 255, 255, 255], color2=[255, 255, 255, 0]))
near("alpha ramps too, which is how an image fades OUT rather than to white",
     fade[200, 200, 3], 1.0, 1e-5)
near("...over an opaque plate, half the ramp is half the white", fade[200, 200, 0], 0.5, 1e-4)
eq("coincident endpoints draw nothing rather than dividing by zero",
   float(np.abs(quiet(S.apply_stroke, BLACK, dict(ramp, points=[[10.5, 10.5],
                                                                [10.5, 10.5]]))[0]
                - BLACK).max()), 0.0)


print("\n  -- straight alpha --")

# The case that separates the two implementations needs the paint and the plate
# to DISAGREE about colour AND the plate to be partly transparent. White over
# half-transparent white is invariant under both formulas, which is exactly how
# this bug survives a test suite. Opaque BLACK over white at alpha 0.5:
#     straight       co = (C*ca + Cd*ad*(1-ca)) / ao   ->  0.600 at ca = 0.25
#     premultiplied  co = C*ca + Cd*(1-ca)             ->  0.750 at ca = 0.25
# 0.75 against 0.60 is the grey fringe, on every edge, in both directions.
HALF = clear(200, 200, a=0.5)
HALF[..., :3] = 1.0
o = S.apply_stroke(HALF, {"tool": "brush", "points": [[100.5, 100.5]], "size": 60,
                          "hardness": 0.3, "color": [0, 0, 0, 255]})
ao = o[..., 3]
rim = (ao > 0.5001) & (ao < 0.9999)
ca = (ao - 0.5) / 0.5                       # the coverage, read back off the matte
straight = 1.0 - ca / np.maximum(ao, 1e-6)
premul = 1.0 - ca
eq("the case exists: a wide rim of partial coverage over half-alpha pixels",
   int(rim.sum()) > 500, True)
eq("...and the two formulas really do disagree across it",
   float(np.abs(straight - premul)[rim].max()) > 0.1, True)
near("every rim pixel lands on the straight-alpha answer",
     np.abs(o[..., 0][rim] - straight[rim]).max(), 0.0, 1e-5)
wide = rim & (np.abs(straight - premul) > 0.05)
eq("...and not one of them on the premultiplied one, wherever the two differ at all",
   float(np.abs(o[..., 0][wide] - premul[wide]).min()) > 0.02, True)
# A pixel whose coverage is known EXACTLY rather than measured: the falloff
# section already pinned r=15 of a size-40 hardness-0.5 stamp at 0.5, so
# ao = 0.5 + 0.5*0.5 = 0.75 and the colour is (0*0.5 + 1*0.5*0.5)/0.75 = 1/3.
exact = S.apply_stroke(HALF, {"tool": "brush", "points": [[100.5, 100.5]],
                              "size": 40, "hardness": 0.5, "color": [0, 0, 0, 255]})
near("at a coverage of exactly 0.5 the matte is exactly 0.75", exact[100, 115, 3], 0.75, 1e-5)
near("...and the colour is exactly 1/3, where the fringe would have read 0.5",
     exact[100, 115, 0], 1.0 / 3.0, 1e-5)
eq("and the pixels the stroke did not reach are bit-identical - painting over a "
   "half-alpha region neither darkens nor lightens its neighbours",
   np.array_equal(o[ao <= 0.5], HALF[ao <= 0.5]), True)

# The other half of the discipline: FILTERING straight alpha. A transparent
# pixel still stores a colour, and a blur that does not premultiply drags it
# across the edge - the black (here, green) halo everyone recognises.
EDGE = clear(120, 120, a=0.0)
EDGE[..., 1] = 1.0                          # every transparent pixel holds GREEN
EDGE[:, :60, 0], EDGE[:, :60, 1], EDGE[:, :60, 2] = 1.0, 0.0, 0.0
EDGE[:, :60, 3] = 1.0                       # ...and the opaque half is pure red
blurred = S.apply_stroke(EDGE, {"tool": "blur", "size": 50, "amount": 1.0,
                                "hardness": 1.0, "radius": 6,
                                "points": [[60.5, 60.5]]})
eq("the blur softened the matte, so there IS an edge to fringe",
   float(blurred[60, 62, 3]) > 0.05 and float(blurred[60, 62, 3]) < 0.95, True)
eq("...and no green crossed it: filtering happens premultiplied",
   float(blurred[..., 1][blurred[..., 3] > 0.02].max()) < 0.02, True)

eq("an eraser takes alpha and leaves the colour where it was",
   float(np.abs(S.apply_stroke(PLATE, job("eraser"))[..., :3] - PLATE[..., :3]).max()), 0.0)
eq("...and it is undoable: painting the matte back restores the picture",
   float(np.abs(S.apply_stroke(
       S.apply_stroke(PLATE, {"tool": "eraser", "size": 40, "hardness": 1.0,
                              "points": [[128.5, 128.5]]}),
       {"tool": "brush", "size": 40, "hardness": 1.0, "points": [[128.5, 128.5]],
        "color": [255, 255, 255, 0]})[..., :3] - PLATE[..., :3]).max()), 0.0)


print("\n  -- the mask limits every one of the twelve --")

MASK = np.zeros((256, 256), np.float32)
MASK[:, :128] = 1.0
leaked, inert, feather = [], [], []
for name in sorted(S.CATALOG):
    out, _ = quiet(S.apply_stroke, PLATE, job(name), MASK)
    if not np.array_equal(out[:, 128:], PLATE[:, 128:]):
        leaked.append(name)
    if float(np.abs(out[:, :128] - PLATE[:, :128]).max()) < 1e-4:
        inert.append(name)
    half = np.full((256, 256), 0.5, np.float32)
    soft, _ = quiet(S.apply_stroke, PLATE, job(name), half)
    full, _ = quiet(S.apply_stroke, PLATE, job(name))
    if not (0.0 < float(np.abs(soft - PLATE).max()) < float(np.abs(full - PLATE).max())):
        feather.append(name)
eq("nothing paints outside the mask", leaked, [])
eq("...and everything still paints inside it", inert, [])
eq("a HALF mask is half the edit - the multiplier is continuous, not a stencil",
   feather, [])
eq("no mask means everywhere, and it is the same code path",
   float(np.abs(S.apply_stroke(PLATE, job("brush"))
                - S.apply_stroke(PLATE, job("brush"), np.ones((256, 256), np.float32))).max()),
   0.0)
bad_mask, note = quiet(S.apply_stroke, PLATE, job("brush"), np.ones((8, 8), np.float32))
eq("a mask of the WRONG SHAPE skips the stroke rather than painting the plate",
   (float(np.abs(bad_mask - PLATE).max()), "expected" in note), (0.0, True))
eq("a mask full of NaN paints nothing rather than everything",
   float(np.abs(S.apply_stroke(PLATE, job("brush"),
                               np.full((256, 256), np.nan, np.float32)) - PLATE).max()), 0.0)


print("\n  -- hostility --")

HOSTILE = [
    ("no points", {"points": []}),
    ("points None", {"points": None}),
    ("points a string", {"points": "over there"}),
    ("one point", {"points": [[128.5, 128.5]]}),
    ("a point of NaN", {"points": [[float("nan"), float("nan")], [10.0, 10.0]]}),
    ("a point of inf", {"points": [[float("inf"), 3.0], [10.0, 10.0]]}),
    ("ragged points", {"points": [[1.0], None, 7, [10.0, 10.0], [20.0, 20.0]]}),
    ("a million pixels off-plate", {"points": [[1e6, 1e6], [1e6 + 50, 1e6]]}),
    ("negative coordinates", {"points": [[-9e5, -9e5], [-9e5 + 40, -9e5]]}),
    ("size 0", {"size": 0}),
    ("size negative", {"size": -40}),
    ("size NaN", {"size": float("nan")}),
    ("size inf", {"size": float("inf")}),
    ("hardness inf", {"hardness": float("inf")}),
    ("opacity NaN", {"opacity": float("nan")}),
    ("flow -1", {"flow": -1}),
    ("spacing 0", {"spacing": 0}),
    ("spacing NaN", {"spacing": float("nan")}),
    ("amount NaN", {"amount": float("nan")}),
    ("tolerance -5", {"tolerance": -5}),
    ("colour of NaN", {"color": [float("nan")] * 4}),
    ("colour too short", {"color": [12]}),
    ("colour a string", {"color": "red"}),
    ("source NaN", {"source": [float("nan"), 3.0]}),
    ("pressure garbage", {"points": [[40.5, 40.5, float("nan")],
                                     [90.5, 90.5, -7], [140.5, 40.5, "hard"]]}),
    ("pressure mode garbage", {"pressure": "very"}),
    ("radius NaN", {"radius": float("nan")}),
    ("enum garbage", {"range": "sideways", "mode": "wobble", "shape": "hexagonal"}),
    ("no keys at all", None),
]
threw, dirty = [], []
for name in sorted(S.CATALOG):
    for what, over in HOSTILE:
        j = {"tool": name} if over is None else job(name, **over)
        try:
            out, _ = quiet(S.apply_stroke, PLATE, j)
        except Exception as exc:
            threw.append(f"{name}/{what}: {exc}")
            continue
        if (out.dtype != np.float32 or out.shape != PLATE.shape
                or not np.isfinite(out).all() or out.min() < 0.0 or out.max() > 1.0):
            dirty.append(f"{name}/{what}")
eq("nothing in the hostile table raises", threw, [])
eq("...and everything still comes back a valid float32 0..1 plate", dirty, [])

silent = []
for name in sorted(S.CATALOG):
    for what in ("no points", "points None", "points a string", "size 0",
                 "size negative"):
        over = dict(HOSTILE)[what]
        out, _ = quiet(S.apply_stroke, PLATE, job(name, **over))
        if name in ("bucket", "gradient") and what.startswith("size"):
            continue                    # neither has a size; the key is dropped
        if float(np.abs(out - PLATE).max()) != 0.0:
            silent.append(f"{name}/{what}")
eq("a degenerate stroke does NOTHING rather than something small and wrong", silent, [])

eq("a NaN parameter falls back to its declared default, the way effects.py "
   "coerces - not to nothing, and not to garbage",
   float(np.abs(quiet(S.apply_stroke, PLATE, job("brush", size=float("nan")))[0]
                - S.apply_stroke(PLATE, {k: v for k, v in job("brush").items()
                                         if k != "size"})).max()), 0.0)
eq("an unknown tool draws nothing and names itself on stderr",
   (float(np.abs(quiet(S.apply_stroke, PLATE, {"tool": "airbrush",
                                               "points": PATH})[0] - PLATE).max()),
    "airbrush" in quiet(S.apply_stroke, PLATE, {"tool": "airbrush", "points": PATH})[1]),
   (0.0, True))
for what, arg in (("a list", [[1, 2]]), ("None", None), ("a string", "brush"),
                  ("no tool", {"points": PATH})):
    eq(f"a stroke that is {what} is ignored",
       float(np.abs(quiet(S.apply_stroke, PLATE, arg)[0] - PLATE).max()), 0.0)
for what, arg in (("uint8", (PLATE * 255).astype(np.uint8)),
                  ("three-channel", PLATE[..., :3].copy()),
                  ("not an array", "a picture"), ("empty", np.zeros((0, 0, 4), np.float32))):
    out = quiet(S.apply_stroke, arg, job("brush"))[0]
    eq(f"a {what} plate comes straight back rather than being reinterpreted",
       out is arg, True)

t0 = time.perf_counter()
quiet(S.apply_stroke, PLATE, {"tool": "brush", "size": 0.6, "spacing": 0.01,
                              "points": [[0.5, 0.5], [255.5, 255.5], [0.5, 255.5],
                                         [255.5, 0.5]] * 60})
eq("a path built to explode the dab count still finishes",
   time.perf_counter() - t0 < 5.0, True)
eq("...because the walker is capped", S.MAX_DABS <= 200_000, True)

eq("apply_strokes runs them in order, each seeing the last",
   float(np.abs(S.apply_strokes(PLATE, [job("brush"), job("blur")])
                - S.apply_stroke(S.apply_stroke(PLATE, job("brush")), job("blur"))).max()),
   0.0)
eq("...and a junk list is skipped, not fatal",
   float(np.abs(quiet(S.apply_strokes, PLATE, [None, 7, "x", job("brush")])[0]
                - S.apply_stroke(PLATE, job("brush"))).max()), 0.0)
eq("apply_strokes with nothing to do returns the plate untouched",
   S.apply_strokes(PLATE, None) is PLATE, True)


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
