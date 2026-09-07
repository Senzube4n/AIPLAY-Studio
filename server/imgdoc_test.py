"""Unit tests for the layered image document in server/imgdoc.py.

Compositing is arithmetic. Every case below computes its expected pixel on
paper, in the test, from the two colours going in — never from a golden image
and never by asking imgdoc what it thinks the answer is. Two colours are used
throughout:

    backdrop  [153,  51, 204]  ->  (0.6, 0.2, 0.8)
    source    [102, 153, 204]  ->  (0.4, 0.6, 0.8)

chosen by search rather than taste: every one of the 17 colour blends lands on
a different triple with them, overlay and hardlight disagree (they agree
whenever both colours sit on the same side of 0.5, which hides a mode that
fell back to the other), and the four non-separable modes stay inside the
0..1 cube so no case is quietly measuring a clamp.

Three kinds of case, the split shapes_test.py and effects_test.py use.

  * SWEEPS over the catalog and over the vocabulary: every entry described,
    every default inside its own range, and BLEND_MODES parsed straight out of
    server/vfx/store.js and compared element for element. IMAGE_SPEC §9's last
    line — assert against the other side's SOURCE, never your memory of it.
  * ONE MEANINGFUL ASSERTION PER FEATURE - "a group at 50% gives the top
    child's colour in the overlap and NOT the purple that per-child opacity
    would have given", not "grouping ran".
  * HOSTILE INPUT - a cycle, a missing source, a NaN, a blend mode that does
    not exist, a 1x1 canvas. Each has to come back with a picture and a
    warning, not a traceback and not silence.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgdoc_test.py
    IMGDOC_BENCH=1 ... to add the worst-case 2048 timing (about 19 s)

numpy, plus the compositor imgdoc composites through.
"""
import copy
import os
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vfx"))
import effects                                             # noqa: E402
import engine                                              # noqa: E402
import imgdoc as D                                         # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol=1e-6):
    eq(name, bool(abs(float(got) - float(want)) <= tol), True)


def rgb_is(name, px, want, tol=1e-6):
    """One pixel's colour against three numbers computed in this file."""
    got = [round(float(v), 7) for v in np.asarray(px)[:3]]
    ok = all(abs(g - w) <= tol for g, w in zip(got, want))
    eq(name if ok else f"{name}  [{got} vs {[round(w, 7) for w in want]}]", ok, True)


# The two colours every arithmetic case below argues about, in the 0-255 the
# document stores and the 0..1 the compositor works in.
BACK_255, BACK = [153, 51, 204], (0.6, 0.2, 0.8)
FRONT_255, FRONT = [102, 153, 204], (0.4, 0.6, 0.8)


def doc(w=8, h=8, bg=(0, 0, 0, 0), layers=()):
    d = D.blank_doc("test", w, h, list(bg))
    d["layers"] = list(layers)
    return d


def solid(color, **patch):
    return D.blank_layer("solid", color=list(color), **patch)


def render(d, resolve=None, warn=None):
    rep = {}
    out = D.render(d, resolve, 1.0, rep)
    if isinstance(warn, list):
        warn.extend(rep["warnings"])
        warn.extend("MISSING:" + m for m in rep["missing"])
    return out


print("\nimgdoc\n")
print("  -- the catalog contract --")

bad = [k for k, e in D.CATALOG.items()
       if not (e.get("label") and e.get("why") and e.get("group") in D.GROUP_ORDER)]
eq("every layer kind has a label, a group and a why", bad, [])

eq("every kind the renderer can draw is in the catalog",
   sorted(D.CATALOG), sorted(D.LAYER_TYPES))


def sweep_params(where, params):
    out = []
    for pk, p in params.items():
        if "desc" not in p or "type" not in p:
            out.append(f"{where}.{pk}: undescribed")
        if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            out.append(f"{where}.{pk}: default outside its own range")
        if p["type"] == "enum" and p["default"] not in p["options"]:
            out.append(f"{where}.{pk}: default is not one of the options")
        if "animatable" in p:
            # A still has no time axis. An animatable flag here would be a
            # promise the renderer cannot keep, which is IMAGE_SPEC §9's
            # "schema that accepts a parameter the code then ignores".
            out.append(f"{where}.{pk}: claims to be animatable")
    return out


bad = []
for k, e in D.CATALOG.items():
    bad += sweep_params(k, e["params"])
    if e.get("content"):
        bad += sweep_params(f"{k}.{e['content']['key']}", e["content"]["params"])
for k, e in D.STYLE_CATALOG.items():
    bad += sweep_params("styles." + k, e["params"])
for where, block in (("common", D.COMMON_PARAMS), ("transform", D.TRANSFORM_PARAMS),
                     ("mask", D.MASK_PARAMS)):
    bad += sweep_params(where, block)
eq("every parameter is described and defaults inside its own range", bad, [])

cat = D.catalog()
eq("catalog() serves the whole vocabulary",
   sorted(cat["layers"]) == sorted(D.CATALOG)
   and cat["blendModes"] == list(D.BLEND_MODES)
   and bool(cat["notes"]["order"]) and bool(cat["effects"]["effects"]), True)

# The gradient layer is effects.py's Ramp on a plate. Retyping its parameters
# would be a second catalog for one implementation; this asserts it is spliced.
ramp = {k: v for k, v in effects.CATALOG["ramp"]["params"].items()
        if k not in ("mode", "opacity")}
mine = D.CATALOG["gradient"]["content"]["params"]
eq("the gradient layer's parameters ARE effects.py's ramp parameters",
   sorted(mine) == sorted(ramp)
   and all(mine[k]["default"] == ramp[k]["default"] for k in ramp), True)


print("\n  -- the blend list is store.js's, not a copy of it --")

_STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vfx", "store.js")
_body = re.search(r"export const BLEND_MODES = \[(.*?)\];",
                  open(_STORE, encoding="utf-8").read(), re.S).group(1)
# the comment inside that literal quotes the word "normal"; strip it first or
# the parse invents a 22nd mode
STORE_MODES = re.findall(r'"([^"]+)"', re.sub(r"/\*.*?\*/", "", _body, flags=re.S))

eq("BLEND_MODES holds exactly the names store.js holds, none more and none fewer",
   sorted(D.BLEND_MODES), sorted(STORE_MODES))
eq("...which is 21 modes", len(D.BLEND_MODES), 21)
# NOT compared in order, and that is a finding rather than a shrug: store.js
# lists hardlight sixth (beside softlight, Photoshop's dropdown grouping) while
# engine.py lists it eleventh, because engine's tuple is imagetools' ten with
# its own seven appended. Membership is what a fork breaks and what this pins;
# a dropdown built off one file and a dropdown built off the other are in a
# different order today, which somebody has to decide about.
eq("...and the two orders disagree only about where hardlight sits",
   [m for m in STORE_MODES if m != "hardlight"],
   [m for m in D.BLEND_MODES if m != "hardlight"])
eq("...with the four stencil transfer modes at the end",
   list(D.BLEND_MODES[-4:]), ["stencilAlpha", "stencilLuma",
                              "silhouetteAlpha", "silhouetteLuma"])
eq("STENCIL_MODES is engine.py's tuple, not a second one",
   D.STENCIL_MODES is engine.STENCIL_MODES or
   tuple(D.STENCIL_MODES) == tuple(engine.STENCIL_MODES), True)
eq("STYLE_ORDER is engine.py's, so two styles at once land in the same order",
   list(D.STYLE_ORDER), list(engine.STYLE_ORDER))


print("\n  -- the output contract --")

out = render(doc(11, 7, layers=[solid(BACK_255)]))
eq("render returns float32 (H, W, 4) at the document's size",
   (out.dtype, out.shape), (np.float32, (7, 11, 4)))
eq("...clipped to 0..1", bool(out.min() >= 0.0 and out.max() <= 1.0), True)
rgb_is("...and a full-canvas solid is that solid", out[3, 5], BACK)

eq("an empty document is exactly its background",
   [round(float(v), 4) for v in render(doc(4, 4, bg=(255, 0, 0, 128)))[0, 0]],
   [1.0, 0.0, 0.0, round(128 / 255.0, 4)])
eq("a 1x1 document renders", render(doc(1, 1, layers=[solid(BACK_255)])).shape, (1, 1, 4))
eq("a document with no layers at all still renders",
   render(doc(4, 4)).shape, (4, 4, 4))


print("\n  -- compositing arithmetic --")

out = render(doc(layers=[solid(BACK_255), solid(FRONT_255)]))
rgb_is("two opaque layers composite to the top one", out[4, 4], FRONT)
near("...at alpha 1", out[4, 4, 3], 1.0)

# Straight-alpha source-over, twice, on a transparent canvas:
#   after the bottom layer   a = 0.5,   rgb = Cb   (its own colour, undivided)
#   after the top layer      a = 0.5 + 0.5*0.5 = 0.75
#                          rgb = (Cs*0.5 + Cb*0.5*0.5) / 0.75 = (2*Cs + Cb) / 3
want = tuple((2 * f + b) / 3.0 for f, b in zip(FRONT, BACK))
out = render(doc(layers=[solid(BACK_255, transform={"opacity": 50}),
                         solid(FRONT_255, transform={"opacity": 50})]))
rgb_is("two 50% layers give (2*Cs + Cb)/3", out[4, 4], want)
near("...at alpha 0.75", out[4, 4, 3], 0.75)
eq("...and that is NOT the naive 50/50 mix",
   abs(float(out[4, 4, 0]) - (FRONT[0] + BACK[0]) / 2.0) > 1e-3, True)

near("layer opacity multiplies the source's own alpha",
     render(doc(layers=[solid([255, 255, 255, 128],
                              transform={"opacity": 50})]))[0, 0, 3],
     (128 / 255.0) * 0.5)


print("\n  -- straight alpha, not premultiplied --")

# Stored premultiplied and read as straight, a half-transparent white comes back
# as half-grey. This is the cheapest possible detector and it fires on the very
# first layer, before any blending has had a chance to hide it.
out = render(doc(layers=[solid([255, 255, 255, 255], transform={"opacity": 50})]))
rgb_is("a 50% white layer is still WHITE, not 50% grey", out[0, 0], (1.0, 1.0, 1.0))
near("...at alpha 0.5", out[0, 0, 3], 0.5)

out = render(doc(layers=[solid([255, 0, 0, 128]), solid([0, 0, 255, 255])]))
rgb_is("an opaque layer over a 50% layer leaves the RGB uncontaminated",
       out[0, 0], (0.0, 0.0, 1.0))
near("...and the result is opaque", out[0, 0, 3], 1.0)

# The case the brief's opaque-over-translucent version cannot catch: with the
# top layer opaque, straight and premultiplied maths agree. Make BOTH sides
# translucent and they part company. imagetools.composite() uses
#     dst = dst*(1-a) + src*a
# which assumes an opaque backdrop and answers 0.5 here; the un-premultiplying
# divide answers 1/3, and 1/3 is right — 0.25 of white over 0.5 of black is a
# quarter of a three-quarter-covered pixel.
out = render(doc(layers=[solid([255, 255, 255, 255], transform={"opacity": 50}),
                         solid([0, 0, 0, 255], transform={"opacity": 50})]))
near("50% black over 50% white needs the un-premultiplying divide: 1/3",
     out[0, 0, 0], 1.0 / 3.0)
eq("...and NOT the 0.5 the opaque-backdrop shortcut gives",
   abs(float(out[0, 0, 0]) - 0.5) > 0.1, True)


print("\n  -- every blend mode, textbook result on a known pair --")

b0, b1, b2 = BACK
s0, s1, s2 = FRONT
_sl_hi = 0.8 + 0.6 * (float(np.sqrt(0.8)) - 0.8)        # softlight, s>0.5, b=0.8
EXPECTED = {
    "normal":     (s0, s1, s2),
    "multiply":   (b0 * s0, b1 * s1, b2 * s2),
    "screen":     (1 - .4 * .6, 1 - .8 * .4, 1 - .2 * .2),
    # overlay tests the BACKDROP: 2bs where b<=.5, else 1-2(1-b)(1-s)
    "overlay":    (1 - 2 * .4 * .6, 2 * .2 * .6, 1 - 2 * .2 * .2),
    # hardlight tests the SOURCE, so it must differ from overlay above
    "hardlight":  (2 * .6 * .4, 1 - 2 * .8 * .4, 1 - 2 * .2 * .2),
    "softlight":  (.6 - (1 - 2 * .4) * .6 * .4,                     # s<=.5
                   .2 + (2 * .6 - 1) * (0.448 - .2),                # s>.5, b<=.25
                   _sl_hi),                                         # s>.5, b>.25
    "add":        (min(1.0, b0 + s0), b1 + s1, min(1.0, b2 + s2)),
    "subtract":   (b0 - s0, max(0.0, b1 - s1), b2 - s2),
    "difference": (abs(b0 - s0), abs(b1 - s1), abs(b2 - s2)),
    "darken":     (min(b0, s0), min(b1, s1), min(b2, s2)),
    "lighten":    (max(b0, s0), max(b1, s1), max(b2, s2)),
    "colordodge": (min(1.0, b0 / (1 - s0)), b1 / (1 - s1), min(1.0, b2 / (1 - s2))),
    "colorburn":  (1 - min(1.0, (1 - b0) / s0), 1 - min(1.0, (1 - b1) / s1),
                   1 - min(1.0, (1 - b2) / s2)),
    # The four non-separable modes, W3C compositing-1. Lum uses (.30,.59,.11);
    # SetSat rescales the channel spread; SetLum shifts all three by one number.
    # Every result below stays inside 0..1, so none of them is measuring a clamp.
    "hue":        (0.143, 0.443, 0.743),          # SetLum(SetSat(Cs,Sat(Cb)),Lum(Cb))
    "saturation": (0.2666667 + 0.262, 0.0 + 0.262, 0.4 + 0.262),
    "color":      (s0 - 0.176, s1 - 0.176, s2 - 0.176),   # Lum(Cb)-Lum(Cs) = -0.176
    "luminosity": (b0 + 0.176, b1 + 0.176, b2 + 0.176),   # Lum(Cs)-Lum(Cb) = +0.176
}
eq("the expectation table covers every colour blend mode",
   sorted(EXPECTED), sorted(D.BLEND_MODES[:17]))

seen = {}
for mode, want in EXPECTED.items():
    px = render(doc(layers=[solid(BACK_255), solid(FRONT_255, blend=mode)]))[4, 4]
    rgb_is(f"{mode}", px, want, tol=2e-6)
    seen[mode] = tuple(round(float(v), 5) for v in px[:3])
# A mode that fell back to normal would still pass its own case if the maths
# happened to agree; nothing may share an answer with anything else.
eq("no two blend modes produce the same colour (nothing silently fell back)",
   len(set(seen.values())), len(seen))

# The stencils mix no colour at all: they re-cut the alpha of everything already
# painted beneath them, and are never drawn themselves.
half = dict(size=[4, 8], transform={"position": [2, 4]})
for mode, inside, outside in (("stencilAlpha", 1.0, 0.0),
                              ("silhouetteAlpha", 0.0, 1.0),
                              ("stencilLuma", 0.2, 0.0),
                              ("silhouetteLuma", 0.8, 1.0)):
    grey = [51, 51, 51, 255] if mode.endswith("Luma") else [255, 255, 255, 255]
    out = render(doc(layers=[solid(BACK_255), solid(grey, blend=mode, **half)]))
    near(f"{mode} cuts alpha to {inside} where it covers", out[4, 1, 3], inside, 2e-6)
    near(f"...and to {outside} where it does not", out[4, 6, 3], outside, 2e-6)
    rgb_is(f"...leaving the colour underneath alone", out[4, 1], BACK)


print("\n  -- layer masks --")


def mask_source(w, h, alpha_row):
    """An RGBA whose alpha is exactly the numbers a case wants to see back."""
    a = np.zeros((h, w, 4), dtype=np.float32)
    a[..., :3] = 1.0
    a[..., 3] = np.asarray(alpha_row, dtype=np.float32)[None, :]
    return a


GATE = mask_source(8, 8, [0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 0.5, 0.0])
RES = D.resolver_for({"gate.png": GATE})

top = solid([0, 255, 0, 255])
top["mask"] = {"src": "gate.png", "channel": "alpha"}
out = render(doc(layers=[solid([255, 0, 0, 255]), top]), RES)
rgb_is("a mask at 0 hides its layer completely", out[4, 0], (1.0, 0.0, 0.0))
rgb_is("a mask at 1 lets it through completely", out[4, 4], (0.0, 1.0, 0.0))
# opaque backdrop, so the composite is the straight lerp cb + (cs - cb) * m
rgb_is("a mask at 0.25 composites a quarter of the layer", out[4, 1], (0.75, 0.25, 0.0))
rgb_is("a mask at 0.75 composites three quarters", out[4, 3], (0.25, 0.75, 0.0))

top2 = dict(top, mask={"src": "gate.png", "channel": "alpha", "invert": True})
out = render(doc(layers=[solid([255, 0, 0, 255]), top2]), RES)
rgb_is("invert flips the mask", out[4, 0], (0.0, 1.0, 0.0))

top3 = dict(top, mask={"src": "gate.png", "channel": "alpha", "density": 50})
out = render(doc(layers=[solid([255, 0, 0, 255]), top3]), RES)
rgb_is("density 50 halves how far the mask is allowed to hide",
       out[4, 0], (0.5, 0.5, 0.0))

shaped = solid([0, 255, 0, 255])
shaped["mask"] = {"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 4, "h": 8}]}
out = render(doc(layers=[solid([255, 0, 0, 255]), shaped]), RES)
rgb_is("an IMAGE_SPEC section-3 rect mask gates the layer", out[4, 1], (0.0, 1.0, 0.0))
rgb_is("...and nothing outside it", out[4, 6], (1.0, 0.0, 0.0))

wand = solid([0, 255, 0, 255])
wand["mask"] = {"shapes": [{"kind": "wand", "x": 1, "y": 1, "tolerance": 32}]}
sideways = solid([0, 255, 0, 255])
sideways["mask"] = {"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 4, "h": 8,
                                "mode": "erase"}]}
try:
    render(doc(layers=[sideways]), RES)
    eq("a mask shape mode that does not exist is refused, not read as add", False, True)
except ValueError as exc:
    eq("a mask shape mode that does not exist is refused, not read as add",
       "erase" in str(exc), True)

try:
    render(doc(layers=[wand]), RES)
    eq("a wand mask is refused by name rather than silently dropped", False, True)
except ValueError as exc:
    eq("a wand mask is refused by name rather than silently dropped",
       "imgselect" in str(exc) and "wand" in str(exc), True)
    # The refusal used to claim imgselect.py "does not exist yet" — it is 1138
    # lines of shipped selection engine — and to recommend mask.src while the
    # HTTP route dropped every mask source. Guidance in an error is part of
    # the contract: it must name what is true.
    eq("...and its guidance does not claim the selection engine is unbuilt",
       "does not exist" in str(exc), False)
    eq("...and points at the working paths: a flat-pipeline selection or mask.src",
       "selection" in str(exc) and "mask.src" in str(exc), True)


print("\n  -- groups composite as a unit --")

# Two OPAQUE children that overlap. Inside the group the top child wins the
# overlap outright; the group is then faded once. Fade each child instead and
# the overlap is a MIX of the two at a HIGHER alpha - which is the whole
# difference between a group and an indent.
kids = [solid([255, 0, 0, 255], size=[6, 8], transform={"position": [3, 4]}),
        solid([0, 0, 255, 255], size=[6, 8], transform={"position": [5, 4]})]
grp = D.blank_layer("group", name="pair")
grp["layers"] = kids
grp["transform"] = {"opacity": 50}
out = render(doc(layers=[grp]))
rgb_is("in the overlap a 50% group shows the TOP child's colour", out[4, 3], (0.0, 0.0, 1.0))
near("...at the group's own 0.5 alpha", out[4, 3, 3], 0.5)

per_child = doc(layers=[dict(kids[0], transform={"position": [3, 4], "opacity": 50}),
                        dict(kids[1], transform={"position": [5, 4], "opacity": 50})])
wrong = render(per_child)[4, 3]
eq("...and NOT the mix per-child opacity gives",
   (abs(float(wrong[3]) - 0.75) < 1e-6
    and abs(float(wrong[0]) - 1.0 / 3.0) < 1e-6
    and abs(float(out[4, 3, 0]) - float(wrong[0])) > 0.3), True)

blended = D.blank_layer("group", name="tinted")
blended["layers"] = [solid(FRONT_255)]
blended["blend"] = "multiply"
out = render(doc(layers=[solid(BACK_255), blended]))
rgb_is("a group's blend mode applies to the composited unit",
       out[4, 4], (BACK[0] * FRONT[0], BACK[1] * FRONT[1], BACK[2] * FRONT[2]))

masked = D.blank_layer("group", name="masked")
masked["layers"] = [solid([0, 255, 0, 255])]
masked["mask"] = {"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 4, "h": 8}]}
out = render(doc(layers=[solid([255, 0, 0, 255]), masked]))
rgb_is("a mask on a group gates the whole unit", out[4, 1], (0.0, 1.0, 0.0))
rgb_is("...and the rest of it is untouched", out[4, 6], (1.0, 0.0, 0.0))


print("\n  -- adjustment layers --")

INVERT = [{"type": "invert", "params": {}}]
ADJ = dict(D.blank_layer("adjustment"), effects=INVERT)
inv = tuple(1.0 - c for c in BACK)

out = render(doc(layers=[solid(BACK_255), ADJ]))
rgb_is("an adjustment layer changes what is beneath it", out[4, 4], inv, tol=2e-6)

out = render(doc(layers=[solid(BACK_255), ADJ, solid(FRONT_255)]))
rgb_is("...and nothing above it", out[4, 4], FRONT)

narrow = dict(ADJ, size=[4, 8], transform={"position": [2, 4]})
out = render(doc(layers=[solid(BACK_255), narrow]))
rgb_is("an adjustment layer reaches only where its own alpha does",
       out[4, 1], inv, tol=2e-6)
rgb_is("...and stops at its edge", out[4, 6], BACK)

faded = dict(ADJ, transform={"opacity": 50})
out = render(doc(layers=[solid(BACK_255), faded]))
rgb_is("an adjustment layer's opacity is how far the adjustment goes",
       out[4, 4], tuple(b + (i - b) * 0.5 for b, i in zip(BACK, inv)), tol=2e-6)

inner = D.blank_layer("group", name="lit")
inner["layers"] = [solid(FRONT_255), ADJ]
out = render(doc(layers=[solid(BACK_255), inner]))
rgb_is("an adjustment inside a group reaches its siblings",
       out[4, 4], tuple(1.0 - c for c in FRONT), tol=2e-6)

inner2 = D.blank_layer("group", name="lit")
inner2["layers"] = [solid(FRONT_255, size=[4, 8], transform={"position": [2, 4]}), ADJ]
out = render(doc(layers=[solid(BACK_255), inner2]))
rgb_is("...and stops at the group's floor - the layer under the group is untouched",
       out[4, 6], BACK)

warn = []
render(doc(layers=[solid(BACK_255), dict(ADJ, blend="multiply")]), warn=warn)
eq("an adjustment layer's blend mode is called out, never quietly honoured",
   any("never drawn" in w for w in warn), True)
warn = []
render(doc(layers=[dict(D.blank_layer("adjustment"), effects=[])]), warn=warn)
eq("an adjustment layer with no effects says so", any("no-op" in w for w in warn), True)

warn = []
styled = dict(ADJ, size=[4, 8], transform={"position": [2, 4]},
              styles={"dropShadow": {"distance": 12, "size": 6, "opacity": 100}})
eq("a style on an adjustment layer is ignored, exactly as the warning claims",
   np.array_equal(render(doc(layers=[solid(BACK_255), styled]), warn=warn),
                  render(doc(layers=[solid(BACK_255), narrow]))), True)
eq("...and the warning is there to be read",
   any("adjustment layer has none" in w for w in warn), True)


print("\n  -- clipping masks --")

# The unit's alpha IS the base's alpha. GATE's columns are the base coverage
# [0, .25, .5, .75, 1, 1, .5, 0]; an opaque red clipped onto it must come out
# as red AT EXACTLY THOSE ALPHAS — bit-identical to the unclipped composite
# where the base is fully opaque, exactly nothing where the base is absent,
# and proportional to the coverage between.
gbase = D.blank_layer("image", src="gate.png")             # white, alpha = GATE
red = solid([255, 0, 0, 255], clipped=True)
out = render(doc(layers=[gbase, red]), RES)
ref = render(doc(layers=[gbase, solid([255, 0, 0, 255])]), RES)
eq("where the base is opaque, a clipped layer is BIT-identical to an unclipped one",
   np.array_equal(out[:, 4:6], ref[:, 4:6]), True)
eq("where the base is absent, a clipped layer leaves alpha at exactly 0.0",
   float(out[4, 0, 3]), 0.0)
near("at base alpha 0.25 the unit's alpha IS 0.25", out[4, 1, 3], 0.25)
near("...and 0.75 is 0.75 — coverage never moves", out[4, 3, 3], 0.75)
rgb_is("...while the colour is fully the clipped layer's", out[4, 1], (1.0, 0.0, 0.0))

# Same document over an opaque backdrop: the unit lands as the straight lerp
# backdrop + (red - backdrop) * coverage, computed here on paper.
out = render(doc(layers=[solid(BACK_255), gbase, red]), RES)
rgb_is("over a backdrop, a quarter-covered base shows a quarter of the clip",
       out[4, 1], tuple(b + (r - b) * 0.25 for b, r in zip(BACK, (1.0, 0.0, 0.0))))
rgb_is("...and three quarters shows three",
       out[4, 3], tuple(b + (r - b) * 0.75 for b, r in zip(BACK, (1.0, 0.0, 0.0))))

# A clipped layer's own opacity mixes COLOUR toward the base fill; the matte
# still never moves. engine._over_preserve's whole argument, measured.
half_red = solid([255, 0, 0, 255], clipped=True, transform={"opacity": 50})
out = render(doc(layers=[gbase, half_red]), RES)
rgb_is("a 50% clipped layer mixes half its colour into the base fill",
       out[4, 4], (1.0, 0.5, 0.5))
near("...and the alpha is still the base's 1.0, not source-over's 1-and-a-bit",
     out[4, 4, 3], 1.0)

# Two consecutive clipped layers ride ONE base: both confined to it, the upper
# compositing over the lower inside the unit.
lbase = solid([255, 255, 255, 255], size=[4, 8], transform={"position": [2, 4]})
blue = solid([0, 0, 255, 255], size=[4, 8], transform={"position": [4, 4]},
             clipped=True)
out = render(doc(layers=[lbase, solid([255, 0, 0, 255], clipped=True), blue]))
rgb_is("two stacked clipped layers share one base: lower shows where upper is not",
       out[4, 1], (1.0, 0.0, 0.0))
rgb_is("...upper wins where both cover", out[4, 3], (0.0, 0.0, 1.0))
eq("...and NEITHER escapes the base, even where both cover x=5",
   float(out[4, 5, 3]), 0.0)

# The clipped layer's blend mode meets the BASE GROUP's colour, not the
# document backdrop — over white, multiply against the base must give the
# base*source product and not source*white.
mb = solid(BACK_255, size=[4, 8], transform={"position": [2, 4]})
out = render(doc(layers=[solid([255, 255, 255, 255]), mb,
                         solid(FRONT_255, blend="multiply", clipped=True)]))
rgb_is("a clipped multiply multiplies against its BASE",
       out[4, 1], (BACK[0] * FRONT[0], BACK[1] * FRONT[1], BACK[2] * FRONT[2]))
rgb_is("...and against the backdrop it does not exist at all", out[4, 6], (1.0, 1.0, 1.0))

# The base's opacity fades the WHOLE unit once — Photoshop's "blend clipped
# layers as group", the same shape as the group-opacity case above.
out = render(doc(layers=[solid(BACK_255, transform={"opacity": 50}),
                         solid(FRONT_255, clipped=True)]))
rgb_is("a 50% base fades the finished unit: the clip's colour survives whole",
       out[4, 4], FRONT)
near("...at the base's 0.5 — NOT source-over's 0.75", out[4, 4, 3], 0.5)

# ...and the base's blend mode composites the finished unit.
out = render(doc(layers=[solid(BACK_255),
                         solid(FRONT_255, blend="multiply"),
                         solid([255, 255, 255, 255], clipped=True,
                               transform={"opacity": 0})]))
rgb_is("the base's blend mode carries the unit, clip run present or not",
       out[4, 4], (BACK[0] * FRONT[0], BACK[1] * FRONT[1], BACK[2] * FRONT[2]))

# A hidden base hides its whole clipped stack — nothing paints, not even the
# members that are themselves enabled.
out = render(doc(layers=[solid(BACK_255),
                         dict(lbase, enabled=False),
                         solid([255, 0, 0, 255], clipped=True)]))
rgb_is("a hidden base hides the clipped stack with it", out[4, 1], BACK)
rgb_is("...everywhere", out[4, 6], BACK)

warn = []
out = render(doc(layers=[solid(BACK_255), D.blank_layer("image", src="gone.png"),
                         solid([255, 0, 0, 255], clipped=True)]), warn=warn)
rgb_is("a base whose source is missing clips its stack to nothing", out[4, 4], BACK)
eq("...and the missing name is still reported",
   any(w.startswith("MISSING:") for w in warn), True)

# THE trick: a clipped adjustment layer reaches its base stack and nothing
# else — proven against the unclipped control, pixel for pixel.
hbase = solid(FRONT_255, size=[4, 8], transform={"position": [2, 4]})
out = render(doc(layers=[solid(BACK_255), hbase, dict(ADJ, clipped=True)]))
ctrl = render(doc(layers=[solid(BACK_255), hbase, ADJ]))
rgb_is("a clipped adjustment inverts its base",
       out[4, 1], tuple(1.0 - c for c in FRONT), tol=2e-6)
rgb_is("...and leaves the backdrop next to it UNTOUCHED", out[4, 6], BACK)
rgb_is("the unclipped control inverts that same backdrop",
       ctrl[4, 6], tuple(1.0 - c for c in BACK), tol=2e-6)
eq("...while agreeing with the clipped render over the base",
   bool(np.allclose(out[4, 1], ctrl[4, 1], atol=1e-6)), True)

# The base's styles run on the assembled unit: a colour overlay on the base
# recolours OVER the clipped content (Photoshop's endlessly-reported truth),
# and a drop shadow reads the unit's matte — which is the base's alpha — so
# the clipped colour never bleeds into it.
sbase = solid([255, 0, 0, 255], size=[8, 8], transform={"position": [16, 16]},
              styles={"colorOverlay": {"color": [0, 0, 255], "opacity": 100}})
out = render(doc(32, 32, layers=[sbase, solid([0, 255, 0, 255], clipped=True)]))
rgb_is("a colour overlay on the base recolours OVER the clipped result",
       out[16, 16], (0.0, 0.0, 1.0))

dbase = solid([255, 0, 0, 255], size=[8, 8], transform={"position": [16, 16]},
              styles={"dropShadow": {"distance": 8, "angle": 45, "size": 2,
                                     "opacity": 100}})
out = render(doc(32, 32, layers=[dbase, solid([0, 255, 0, 255], clipped=True)]))
eq("the base's drop shadow still lands outside the unit",
   bool(out[20:26, 16:22, 3].max() > 0.5), True)
rgb_is("...under a layer area that shows the CLIPPED green, not the base's red",
       out[16, 16], (0.0, 1.0, 0.0))
eq("...and the clipped green never bleeds into the shadow",
   bool(out[20:26, 16:22, 1].max() < 0.1), True)

# Clipping never crosses a group edge. Inside a group it works as anywhere;
# a clipped FIRST CHILD has no base even with a whole document below the group.
gin = D.blank_layer("group", name="clipin")
gin["layers"] = [dict(lbase), solid([255, 0, 0, 255], clipped=True)]
out = render(doc(layers=[solid(BACK_255), gin]))
rgb_is("a clip inside a group confines inside the group", out[4, 1], (1.0, 0.0, 0.0))
rgb_is("...and the backdrop past the base is untouched", out[4, 6], BACK)

gedge = D.blank_layer("group", name="edge")
gedge["layers"] = [solid([255, 0, 0, 255], clipped=True)]
warn = []
out = render(doc(layers=[solid(BACK_255, size=[4, 8], transform={"position": [2, 4]}),
                         gedge]), warn=warn)
rgb_is("a clipped first child does NOT clip to the layer under its group",
       out[4, 6], (1.0, 0.0, 0.0))
eq("...it paints unclipped, and the warning says why",
   any("nothing is beneath it in its container" in w for w in warn), True)

warn = []
out = render(doc(layers=[dict(solid(FRONT_255), clipped=True)]), warn=warn)
rgb_is("the bottom layer of a document cannot clip: it paints unclipped",
       out[4, 4], FRONT)
eq("...with the no-base warning", any("no base" in w for w in warn), True)

warn = []
out = render(doc(layers=[solid(BACK_255), dict(ADJ),
                         solid(FRONT_255, clipped=True)]), warn=warn)
rgb_is("clipped onto an adjustment layer paints unclipped too", out[4, 4], FRONT)
eq("...and the warning names the reason",
   any("adjustment layer" in w and "clip" in w for w in warn), True)

# set_clipped is the editing gesture: pure, and it REFUSES what render could
# only warn about.
cdoc = doc(layers=[solid(BACK_255, name="floor"), solid(FRONT_255, name="sky")])
CFROZEN = copy.deepcopy(cdoc)
clipped_doc = D.set_clipped(cdoc, "sky")
eq("set_clipped leaves the input document untouched", cdoc == CFROZEN, True)
eq("...and sets the flag on a copy", clipped_doc["layers"][1]["clipped"], True)
eq("...and set_clipped(False) releases it",
   D.set_clipped(clipped_doc, "sky", False)["layers"][1]["clipped"], False)
try:
    D.set_clipped(cdoc, "floor")
    eq("set_clipped refuses the bottom layer of a container", False, True)
except ValueError as exc:
    eq("set_clipped refuses the bottom layer of a container",
       "nothing beneath" in str(exc), True)
adoc = doc(layers=[dict(ADJ, name="curves"), solid(FRONT_255, name="photo")])
try:
    D.set_clipped(adoc, "photo")
    eq("set_clipped refuses an adjustment layer as the base", False, True)
except ValueError as exc:
    eq("set_clipped refuses an adjustment layer as the base",
       "adjustment" in str(exc), True)

# Round-trip: the flag survives normalize and the copy-helpers, and an absent
# flag is never invented — the rebuild-site bug class this repo keeps refinding.
rdoc = doc(layers=[solid(BACK_255), dict(solid(FRONT_255), clipped=True,
                                         futureField=7)])
back_rt = D.normalize(rdoc)
eq("normalize keeps clipped:true, beside a key it has never heard of",
   (back_rt["layers"][1]["clipped"], back_rt["layers"][1]["futureField"]), (True, 7))
eq("...an explicit clipped:false survives too",
   D.normalize(D.set_clipped(rdoc, rdoc["layers"][1]["id"],
                             False))["layers"][1]["clipped"], False)
eq("...and a layer that never had the flag does not grow one",
   "clipped" in back_rt["layers"][0], False)
eq("duplicate_layer carries the flag with the copy",
   D.duplicate_layer(rdoc, rdoc["layers"][1]["id"])["layers"][2]["clipped"], True)


print("\n  -- layer effects (styles) --")

lay = solid([255, 0, 0, 255], size=[8, 8], transform={"position": [16, 16]})
lay["styles"] = {"dropShadow": {"distance": 8, "angle": 45, "size": 2, "opacity": 100}}
out = render(doc(32, 32, layers=[lay]))
eq("a drop shadow lands OUTSIDE the layer's own box, not clipped to it",
   bool(out[20:26, 16:22, 3].max() > 0.5), True)
eq("...and the layer itself is still on top of it",
   [round(float(v), 3) for v in out[16, 16, :3]], [1.0, 0.0, 0.0])

lay2 = solid([255, 0, 0, 255], size=[8, 8], transform={"position": [16, 16]})
lay2["styles"] = {"stroke": {"color": [0, 255, 0], "size": 3, "position": "outside"}}
out = render(doc(32, 32, layers=[lay2]))
# the solid spans x 12..19; an outside stroke of 3 lays green over x 9..11,
# which only exists at all because the bitmap was grown before the style ran
eq("a stroke rides the edge and grows the layer past its own box",
   bool(out[16, 10, 1] > 0.9 and out[16, 10, 0] < 0.1), True)
eq("...without eating into the layer itself",
   bool(out[16, 12, 0] > 0.9 and out[16, 12, 1] < 0.1), True)

# engine.py's styles have no catalog anywhere - STYLE_CATALOG is a
# transcription of its inline `_f(p.get(k), default)` fallbacks. Rendering each
# style with {} and with exactly the catalogued numbers must give the same
# pixels; if a default drifts, this is where it shows. The tolerance is 0.01
# because two colour fallbacks land on a half-of-255 that the catalog rounds -
# a drifted distance, size or opacity misses by far more than that.
plate = np.zeros((48, 48, 4), dtype=np.float32)
plate[16:32, 16:32] = (0.8, 0.3, 0.2, 1.0)
drift = []
for name, entry in D.STYLE_CATALOG.items():
    defaults = {k: v["default"] for k, v in entry["params"].items() if k != "enabled"}
    a = engine.STYLES[name](plate.copy(), {}, 1.0, False)
    b = engine.STYLES[name](plate.copy(), defaults, 1.0, False)
    if not np.allclose(a, b, atol=0.01):
        drift.append(f"{name} (max delta {float(np.abs(a - b).max()):.3f})")
eq("every catalogued style default is the one engine.py actually falls back to",
   drift, [])
eq("the catalog covers every style engine.py can draw",
   sorted(D.STYLE_CATALOG), sorted(engine.STYLES))


print("\n  -- sources --")

PIXELS = np.zeros((4, 4, 4), dtype=np.float32)
PIXELS[..., :3] = FRONT
PIXELS[..., 3] = 1.0
img = D.blank_layer("image", src="p.png")
out = render(doc(8, 8, layers=[solid(BACK_255), img]),
             D.resolver_for({"p.png": PIXELS}))
rgb_is("an image layer lands centred on the canvas", out[4, 4], FRONT)
rgb_is("...and does not cover what it is not over", out[0, 0], BACK)

grad = D.blank_layer("gradient")
grad["gradient"] = {"type": "linear", "startX": 0, "endX": 100, "startY": 0,
                    "endY": 0, "startColor": [0, 0, 0], "endColor": [255, 255, 255]}
row = render(doc(16, 2, layers=[grad]))[0, :, 0]
eq("a gradient layer ramps from one colour to the other",
   bool(row[0] < 0.01 and row[-1] > 0.9 and np.all(np.diff(row) > 0)), True)

typ = D.blank_layer("text")
typ["text"] = {"content": "HI", "size": 40, "color": [255, 255, 255, 255]}
eq("a text layer draws glyphs",
   bool(render(doc(128, 64, layers=[typ]))[..., 3].sum() > 50), True)


print("\n  -- the CRUD helpers are pure --")

base = doc(16, 16, layers=[solid(BACK_255, name="floor"),
                           solid(FRONT_255, name="sky")])
base["layers"].append(D.blank_layer("group", name="box"))
base["layers"][2]["layers"] = [solid([0, 255, 0, 255], name="leaf")]
FROZEN = copy.deepcopy(base)


def pure(name, fn):
    out = fn()
    eq(f"{name} leaves the input document untouched", base == FROZEN, True)
    return out


out = pure("reorder_layer", lambda: D.reorder_layer(base, "sky", 0))
eq("...and reorder actually moves it", [l["name"] for l in out["layers"]],
   ["sky", "floor", "box"])

out = pure("duplicate_layer", lambda: D.duplicate_layer(base, "box"))
ids = [l["id"] for l in D.walk(out)]
eq("...and duplicate mints a fresh id for every layer it copied",
   len(ids), len(set(ids)))
eq("...directly above the original",
   [l["name"] for l in out["layers"]], ["floor", "sky", "box", "box copy"])

out = pure("move_layer", lambda: D.move_layer(base, "sky", parent="box"))
eq("...and move_layer regroups it",
   ([l["name"] for l in out["layers"]],
    [l["name"] for l in out["layers"][1]["layers"]]),
   (["floor", "box"], ["leaf", "sky"]))

out = pure("group_layers", lambda: D.group_layers(base, ["floor", "sky"], name="both"))
eq("...and group_layers wraps them where the lowest one was",
   ([l["name"] for l in out["layers"]],
    [l["name"] for l in out["layers"][0]["layers"]]),
   (["both", "box"], ["floor", "sky"]))

out = pure("ungroup_layer", lambda: D.ungroup_layer(base, "box"))
eq("...and ungroup leaves the children where the group was",
   [l["name"] for l in out["layers"]], ["floor", "sky", "leaf"])

out = pure("remove_layer", lambda: D.remove_layer(base, "leaf"))
eq("...and remove takes it out of the group it was in",
   [l["name"] for l in D.walk(out)], ["floor", "sky", "box"])

out = pure("add_layer", lambda: D.add_layer(base, solid(BACK_255, name="new"),
                                            parent="box", index=0))
eq("...and add_layer puts it in the group at the index asked for",
   [l["name"] for l in out["layers"][2]["layers"]], ["new", "leaf"])

moved = D.update_layer(base, "sky", {"transform": {"position": [3, 4]}})
out = pure("update_layer",
           lambda: D.update_layer(moved, "sky", {"transform": {"opacity": 40}}))
eq("...and update_layer MERGES a transform instead of rebuilding it",
   out["layers"][1]["transform"], {"opacity": 40, "position": [3, 4]})
eq("...and never lets a patch move an id or a type",
   D.update_layer(base, "sky", {"id": "nope", "type": "group"})["layers"][1]["type"],
   "solid")

try:
    D.move_layer(base, "box", parent="box")
    eq("move_layer refuses to put a group inside itself", False, True)
except ValueError as exc:
    eq("move_layer refuses to put a group inside itself", "inside itself" in str(exc), True)

try:
    D.group_layers(base, ["floor", "leaf"])
    eq("group_layers refuses to grab layers out of two different parents", False, True)
except ValueError as exc:
    eq("group_layers refuses to grab layers out of two different parents",
       "different groups" in str(exc), True)

try:
    D.find_layer(doc(layers=[solid(BACK_255, name="x"), solid(FRONT_255, name="x")]), "x")
    eq("an ambiguous name is refused with the ids listed", False, True)
except ValueError as exc:
    eq("an ambiguous name is refused with the ids listed", "use the id" in str(exc), True)


print("\n  -- hostile input --")

warn = []
loop = D.blank_layer("group", name="ouroboros")
loop["layers"] = [loop]                       # the same dict, twice over
out = render(doc(layers=[loop]), warn=warn)
eq("a cycle in the group tree returns a picture instead of hanging",
   out.shape, (8, 8, 4))
eq("...and says so", any("inside itself" in w for w in warn), True)

warn = []
out = render(doc(layers=[solid(BACK_255),
                         D.blank_layer("image", src="../../etc/passwd")]), warn=warn)
rgb_is("a layer with a missing source is skipped, the rest still draws",
       out[4, 4], BACK)
eq("...and the name is reported, not swallowed",
   any(w.startswith("MISSING:") for w in warn), True)

warn = []
out = render(doc(layers=[solid(BACK_255, transform={"opacity": float("nan")})]),
             warn=warn)
rgb_is("a NaN opacity falls back to fully opaque", out[4, 4], BACK)
eq("...and is reported", any("not a number" in w for w in warn), True)

warn = []
out = render(doc(layers=[solid(BACK_255), solid(FRONT_255, blend="doesNotExist")]),
             warn=warn)
rgb_is("a blend mode that does not exist paints as normal", out[4, 4], FRONT)
eq("...and is named in the warning, with the count of the real ones",
   any('"doesNotExist"' in w and "21" in w for w in warn), True)

warn = []
out = render(doc(layers=[dict(solid(BACK_255), type="hologram")]), warn=warn)
eq("a layer kind that does not exist is read as a solid and said aloud",
   any("hologram" in w for w in warn), True)

warn = []
out = render(doc(layers=[solid(BACK_255), "not a layer", None]), warn=warn)
rgb_is("junk in the layer list is skipped, not fatal", out[4, 4], BACK)

warn = []
out = render(doc(layers=[solid(BACK_255),
                         dict(solid(FRONT_255), effects=[{"type": "notAnEffect"}])]),
             warn=warn)
rgb_is("an effect that does not exist leaves the layer alone", out[4, 4], FRONT)
eq("...and is named", any("notAnEffect" in w for w in warn), True)

out = render(doc(layers=[solid(BACK_255),
                         solid(FRONT_255, transform={"position": [9999, 9999]})]))
rgb_is("a layer transformed entirely off the canvas costs nothing", out[4, 4], BACK)

warn = []
out = render(doc(layers=[dict(solid(BACK_255), transform="sideways", mask=7)]), warn=warn)
rgb_is("a transform and a mask of the wrong SHAPE are repaired, not fatal",
       out[4, 4], BACK)
eq("...and both are reported", len([w for w in warn if "layer" in w]) >= 2, True)

deep = D.blank_doc("deep", 8, 8)
node = deep["layers"]
for _ in range(40):
    g = D.blank_layer("group")
    node.append(g)
    node = g["layers"]
node.append(solid(BACK_255))
warn = []
eq("a group nested 40 deep is cut off rather than followed",
   render(deep, warn=warn).shape, (8, 8, 4))
eq("...and says where it stopped", any("nested past" in w for w in warn), True)

try:
    D.normalize([1, 2, 3])
    eq("normalize refuses something that is not a document", False, True)
except ValueError:
    eq("normalize refuses something that is not a document", True, True)

# Repair, never rebuild: IMAGE_SPEC section 9's second bullet, and the exact bug
# store.js's migrateLayer carried for months.
odd = doc(layers=[dict(solid(BACK_255), futureField={"kept": 1},
                       transform={"opacity": 60, "somethingNew": 3})])
back = D.normalize(odd)
eq("normalize keeps keys it has never heard of, on the layer and the transform",
   (back["layers"][0].get("futureField"),
    back["layers"][0]["transform"].get("somethingNew")), ({"kept": 1}, 3))
eq("...and does not invent an anchor the source has not been measured for",
   "anchor" in back["layers"][0]["transform"], False)


print("\n  -- the CLI seam --")

# IMAGE_SPEC section 9's first bullet is "a module nobody calls". Routes and MCP
# are the Integrator's column, so the furthest this file can reach is the
# protocol they will drive: a job file in, one JSON line out, exit 1 on refusal.
# Rendering THROUGH it rather than around it is what makes that seam a claim.
import json as _json                                       # noqa: E402
import subprocess                                          # noqa: E402
import tempfile                                            # noqa: E402
from PIL import Image                                      # noqa: E402

_MOD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "imgdoc.py")
_tmp = tempfile.mkdtemp(prefix="imgdoc_test_")
_src = os.path.join(_tmp, "p.png")
_out = os.path.join(_tmp, "out.png")
_thumb = os.path.join(_tmp, "thumb.png")
Image.fromarray(
    (np.ones((8, 8, 4)) * np.array(FRONT_255 + [255])).astype("uint8"), "RGBA"
).save(_src)

_doc = doc(16, 16, layers=[solid(BACK_255), D.blank_layer("image", src="p.png")])
_job = os.path.join(_tmp, "job.json")
with open(_job, "w", encoding="utf-8") as fh:
    _json.dump({"doc": _doc, "out": _out, "thumbOut": _thumb, "thumbSize": 8,
                "sources": {"p.png": _src}}, fh)


def cli(*args):
    r = subprocess.run([sys.executable, _MOD, *args], capture_output=True, text=True)
    return r, (_json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {})


_r, _line = cli("render", _job)
eq("the CLI renders a job and prints one JSON line",
   (_r.returncode, _line.get("ok"), _line.get("width"), _line.get("painted")),
   (0, True, 16, 2))
eq("...and the pixels it wrote are the pixels render() computes",
   np.array_equal(np.asarray(Image.open(_out).convert("RGBA")),
                  D.to_uint8(render(_doc, D.resolver_for({"p.png": _src})))), True)
eq("...and the thumbnail is written too", os.path.exists(_thumb), True)

_job2 = os.path.join(_tmp, "job2.json")
with open(_job2, "w", encoding="utf-8") as fh:
    _json.dump({"doc": {"layers": [{"type": "image", "src": "p.png"},
                                   {"type": "solid", "color": [0, 255, 0, 255],
                                    "clipped": True}]},
                "sizeFrom": "p.png", "out": _out,
                "sources": {"p.png": _src}}, fh)
_r, _line = cli("render", _job2)
eq("sizeFrom sizes the document from a named source (the node side has no decoder)",
   (_r.returncode, _line.get("ok"), _line.get("width"), _line.get("height")),
   (0, True, 8, 8))
eq("...and the clipped flag rides the CLI seam: green confined to the base",
   [int(v) for v in np.asarray(Image.open(_out).convert("RGBA"))[4, 4]],
   [0, 255, 0, 255])

_r, _line = cli("render", os.path.join(_tmp, "gone.json"))
eq("a job it cannot read is {ok:false} and exit 1, never a traceback on stdout",
   (_r.returncode, _line.get("ok")), (1, False))

_r, _cat = cli("catalog")
eq("the catalog serves over the CLI, in ASCII so no console can mangle it",
   (sorted(_cat["layers"]) == sorted(D.LAYER_TYPES), _r.stdout.isascii()), (True, True))

_half = D.render(doc(16, 16, layers=[solid(BACK_255)]), None, 0.5)
eq("scale 0.5 renders half a canvas", _half.shape, (8, 8, 4))
rgb_is("...and the same picture", _half[4, 4], BACK)


print("\n  -- what it costs --")


def bench(label, n, size, alpha, opacity, modes):
    src = np.ascontiguousarray(
        np.random.default_rng(7).random((size, size, 4), dtype=np.float32) * .9 + .05)
    src[..., 3] = alpha if alpha is not None else src[..., 3]
    layers = [dict(D.blank_layer("image", src="p.png"), blend=modes[i % len(modes)],
                   transform={"opacity": opacity}) for i in range(n)]
    d = dict(D.blank_doc("bench", size, size), layers=layers)
    res = D.resolver_for({"p.png": src})
    res("p.png")                                   # decode once, outside the clock
    D.render(d, res)                               # warm
    t0 = time.perf_counter()
    D.render(d, res)
    ms = (time.perf_counter() - t0) * 1000
    print(f"  ..    {label:<52s} {ms:8.0f} ms")
    return ms


ms = bench("20 layers, 2048x2048, opaque, normal", 20, 2048, 1.0, 100, ["normal"])
eq("20 opaque 2048x2048 layers composite in under 5 s", ms < 5000, True)
bench("20 layers, 2048x2048, translucent, normal", 20, 2048, None, 80, ["normal"])
if os.environ.get("IMGDOC_BENCH"):
    bench("20 layers, 2048x2048, translucent, all 17 blends",
          20, 2048, None, 80, list(D.BLEND_MODES[:17]))
else:
    print("  ..    (IMGDOC_BENCH=1 adds the all-17-blends case, about 19 s)")


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
