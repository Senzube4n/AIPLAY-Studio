"""Unit tests for the VFX engine — server/vfx/interp.py and server/vfx/engine.py.

These are the pixels. The browser previews nothing of its own and MCP renders
through the same two functions, so a silent drift here ships to every surface at
once. The invariants below are the ones a plausible refactor breaks quietly:

  - easing that reads "hold" but interpolates anyway (a title card that drifts),
  - a keyframe list assumed sorted (an agent writes them in the order it thought
    of them),
  - parenting composed in the wrong order (looks fine until the parent rotates),
  - the layer stack painted top-first (looks fine until two layers overlap),
  - a track matte drawn as well as used (the matte layer showing through),
  - warpAffine on straight alpha (a black fringe nobody notices until 4K).

Comps are built synthetically in a temp dir — no external media, so this runs
anywhere the venv does.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/engine_test.py

PyAV/cv2/numpy/PIL, same as engine.py itself. effects.py is a separate
deliverable and may be absent; nothing here needs it.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
from fractions import Fraction

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vfx import engine, interp  # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def comp(layers, w=64, h=64, fps=30.0, duration=4.0, bg=(0, 0, 0, 0), **extra):
    doc = {"v": 1, "id": "cmp_test", "slug": "test", "name": "test",
           "width": w, "height": h, "fps": fps, "duration": duration,
           "bg": list(bg), "layers": layers}
    doc.update(extra)
    return doc


def solid(lid, color, **over):
    lay = {"id": lid, "name": lid, "type": "solid", "color": list(color),
           "start": 0.0, "end": 4.0, "blend": "normal", "enabled": True,
           "transform": {"anchor": [32, 32], "position": [32, 32],
                         "scale": [100, 100], "rotation": 0, "opacity": 100}}
    lay.update(over)
    return lay


def px(frame, x, y):
    """One pixel as ints 0-255, the way a person reads a colour picker."""
    return tuple(int(round(v * 255)) for v in frame[y, x])


print("\nvfx interp\n")

# -- constants pass through ---------------------------------------------------
eq("a bare number is its own value", interp.eval_prop(5, 99.0), 5.0)
eq("a bare array is its own value", interp.eval_prop([1, 2], 99.0), [1.0, 2.0])
eq("an enum string is left alone", interp.eval_prop("clamp", 1.0), "clamp")
eq("the spec's camelCase name is the same function", interp.evalProp, interp.eval_prop)

# -- clamping outside the key range ------------------------------------------
track = {"keys": [{"t": 1.0, "v": 10}, {"t": 2.0, "v": 20}]}
eq("before the first key holds the first value", interp.eval_prop(track, 0.0), 10.0)
eq("after the last key holds the last value", interp.eval_prop(track, 9.0), 20.0)
eq("exactly on the first key is that key", interp.eval_prop(track, 1.0), 10.0)
eq("exactly on the last key is that key", interp.eval_prop(track, 2.0), 20.0)
eq("one key is a constant", interp.eval_prop({"keys": [{"t": 5.0, "v": 7}]}, 0.0), 7.0)
eq("no keys at all falls back", interp.eval_prop({"keys": []}, 0.0, default=3), 3)

# -- linear is actually linear ------------------------------------------------
lin = {"keys": [{"t": 0.0, "v": 0, "ease": "linear"}, {"t": 1.0, "v": 10}]}
eq("linear at a quarter", round(interp.eval_prop(lin, 0.25), 6), 2.5)
eq("linear at a half", round(interp.eval_prop(lin, 0.5), 6), 5.0)
eq("linear at three quarters", round(interp.eval_prop(lin, 0.75), 6), 7.5)
# The definition of linear: equal steps in time are equal steps in value.
steps = [interp.eval_prop(lin, i / 20.0) for i in range(21)]
deltas = [round(steps[i + 1] - steps[i], 9) for i in range(20)]
eq("linear takes identical steps throughout", len(set(deltas)), 1)

# -- hold holds ---------------------------------------------------------------
held = {"keys": [{"t": 0.0, "v": 0, "ease": "hold"}, {"t": 1.0, "v": 10}]}
eq("hold has not moved at the midpoint", interp.eval_prop(held, 0.5), 0.0)
eq("hold has not moved just before the next key", interp.eval_prop(held, 0.999), 0.0)
eq("hold snaps on the next key", interp.eval_prop(held, 1.0), 10.0)

# -- the named eases have the right SHAPE, not just the right endpoints -------
# easeOut leaves fast and settles, so at the halfway point it is already past
# half. easeIn is the mirror. Swapping the two is the classic silent bug: both
# still start at 0 and end at 10, and every endpoint assertion still passes.
ease_out = {"keys": [{"t": 0.0, "v": 0, "ease": "easeOut"}, {"t": 1.0, "v": 10}]}
ease_in = {"keys": [{"t": 0.0, "v": 0, "ease": "easeIn"}, {"t": 1.0, "v": 10}]}
ease_io = {"keys": [{"t": 0.0, "v": 0, "ease": "easeInOut"}, {"t": 1.0, "v": 10}]}
eq("easeOut is ahead of linear at the midpoint", interp.eval_prop(ease_out, 0.5) > 5.0, True)
eq("easeIn is behind linear at the midpoint", interp.eval_prop(ease_in, 0.5) < 5.0, True)
eq("easeInOut is symmetric about the midpoint",
   round(interp.eval_prop(ease_io, 0.5), 3), 5.0)
eq("every ease still lands on its keys",
   [round(interp.eval_prop(e, 0.0), 6) for e in (ease_out, ease_in, ease_io)]
   + [round(interp.eval_prop(e, 1.0), 6) for e in (ease_out, ease_in, ease_io)],
   [0.0, 0.0, 0.0, 10.0, 10.0, 10.0])

# -- custom bezier ------------------------------------------------------------
bez = {"keys": [{"t": 0.0, "v": 0, "ease": {"bezier": [0.2, 0.9, 0.8, 0.1]}},
                {"t": 1.0, "v": 100}]}
samples = [interp.eval_prop(bez, i / 60.0) for i in range(61)]
eq("a bezier ease is monotone across the segment",
   all(samples[i + 1] >= samples[i] - 1e-9 for i in range(60)), True)
eq("a bezier ease starts on its key", round(samples[0], 6), 0.0)
eq("a bezier ease ends on its key", round(samples[-1], 6), 100.0)
eq("a bezier ease stays inside its key values",
   all(-1e-9 <= s <= 100 + 1e-9 for s in samples), True)
# This control net is the S: out fast (y1 = 0.9 over x1 = 0.2), then coast, then
# in fast again. Both halves have to be there — a solver that quietly falls back
# to linear, or reads the control points in the wrong order, flattens one of them.
eq("this bezier leaves ahead of linear", interp.eval_prop(bez, 0.25) > 40.0, True)
eq("this bezier arrives behind linear", interp.eval_prop(bez, 0.75) < 60.0, True)
eq("a point-symmetric control net is symmetric", round(interp.eval_prop(bez, 0.5), 6), 50.0)
# The four numbers with no wrapper is a shape agents write; it must not silently
# degrade to linear.
raw = {"keys": [{"t": 0.0, "v": 0, "ease": [0.2, 0.9, 0.8, 0.1]}, {"t": 1.0, "v": 100}]}
eq("bare bezier control points are honoured",
   round(interp.eval_prop(raw, 0.25), 6), round(interp.eval_prop(bez, 0.25), 6))

# -- unsorted keys ------------------------------------------------------------
messy = {"keys": [{"t": 2.0, "v": 20}, {"t": 0.0, "v": 0}, {"t": 1.0, "v": 10}]}
eq("unsorted keys are sorted before sampling", interp.eval_prop(messy, 0.5), 5.0)
eq("unsorted keys clamp at the real first key", interp.eval_prop(messy, -1.0), 0.0)
eq("unsorted keys clamp at the real last key", interp.eval_prop(messy, 99.0), 20.0)

# -- array-valued keys --------------------------------------------------------
pos = {"keys": [{"t": 0.0, "v": [0, 100]}, {"t": 1.0, "v": [100, 200]}]}
eq("an array key interpolates componentwise", interp.eval_prop(pos, 0.5), [50.0, 150.0])
eq("an array key clamps componentwise", interp.eval_prop(pos, 5.0), [100.0, 200.0])
tri = {"keys": [{"t": 0.0, "v": [0, 0, 0]}, {"t": 2.0, "v": [10, 20, 30]}]}
eq("arity is whatever the property has", interp.eval_prop(tri, 1.0), [5.0, 10.0, 15.0])
# A hand-edited document can put a scalar next to a pair; that is a glitch, not
# a crash.
mixed = {"keys": [{"t": 0.0, "v": 0}, {"t": 1.0, "v": [10, 20]}]}
eq("mismatched arity widens instead of raising", interp.eval_prop(mixed, 0.5), [5.0, 10.0])

# -- transform maths ----------------------------------------------------------
m = interp.transform_matrix({"anchor": [0, 0], "position": [10, 20],
                             "scale": [100, 100], "rotation": 0}, 0.0)
eq("a plain move puts the origin at the position",
   [round(v, 6) for v in interp.apply_matrix(m, [[0, 0]])[0]], [10.0, 20.0])
m = interp.transform_matrix({"anchor": [5, 5], "position": [100, 100],
                             "scale": [200, 200], "rotation": 0}, 0.0)
eq("the anchor lands exactly on the position",
   [round(v, 6) for v in interp.apply_matrix(m, [[5, 5]])[0]], [100.0, 100.0])
eq("scale is percent, measured from the anchor",
   [round(v, 6) for v in interp.apply_matrix(m, [[15, 5]])[0]], [120.0, 100.0])
m = interp.transform_matrix({"anchor": [0, 0], "position": [0, 0],
                             "scale": [100, 100], "rotation": 90}, 0.0)
# y points down the screen, so +90 degrees must take +x to +y — clockwise as seen.
eq("rotation turns clockwise on screen",
   [round(v, 6) for v in interp.apply_matrix(m, [[1, 0]])[0]], [0.0, 1.0])

# -- parenting ----------------------------------------------------------------
parent = {"id": "p", "transform": {"anchor": [0, 0], "position": [100, 50],
                                   "scale": [100, 100], "rotation": 0}}
child = {"id": "c", "parent": "p", "transform": {"anchor": [0, 0], "position": [10, 20],
                                                 "scale": [100, 100], "rotation": 0}}
by_id = {"p": parent, "c": child}
w = interp.world_matrix(child, by_id, 0.0)
eq("a child's move stacks on its parent's",
   [round(v, 6) for v in interp.apply_matrix(w, [[0, 0]])[0]], [110.0, 70.0])

# The order matters and only rotation proves it: parent-then-child and
# child-then-parent give the same answer for pure translation.
parent["transform"] = {"anchor": [0, 0], "position": [0, 0], "scale": [100, 100], "rotation": 90}
w = interp.world_matrix(child, by_id, 0.0)
eq("a child's offset is expressed in its parent's rotated space",
   [round(v, 6) for v in interp.apply_matrix(w, [[0, 0]])[0]], [-20.0, 10.0])
parent["transform"] = {"anchor": [0, 0], "position": [0, 0], "scale": [200, 200], "rotation": 0}
w = interp.world_matrix(child, by_id, 0.0)
eq("a parent's scale multiplies the child's offset",
   [round(v, 6) for v in interp.apply_matrix(w, [[0, 0]])[0]], [20.0, 40.0])

# Two clicks in a parent picker make a loop; a render must survive one.
a = {"id": "a", "parent": "b", "transform": {"anchor": [0, 0], "position": [1, 0],
                                             "scale": [100, 100], "rotation": 0}}
b = {"id": "b", "parent": "a", "transform": {"anchor": [0, 0], "position": [0, 1],
                                             "scale": [100, 100], "rotation": 0}}
loop = interp.world_matrix(a, {"a": a, "b": b}, 0.0)
eq("a parent cycle terminates", np.isfinite(loop).all(), np.True_)
eq("a parent cycle is walked exactly once per layer",
   [round(v, 6) for v in interp.apply_matrix(loop, [[0, 0]])[0]], [1.0, 1.0])

# -- animated transforms feed the matrix --------------------------------------
m0 = interp.transform_matrix(
    {"anchor": [0, 0], "scale": [100, 100], "rotation": 0,
     "position": {"keys": [{"t": 0.0, "v": [0, 0]}, {"t": 2.0, "v": [200, 100]}]}}, 1.0)
eq("a keyframed position drives the matrix",
   [round(v, 6) for v in interp.apply_matrix(m0, [[0, 0]])[0]], [100.0, 50.0])


print("\nvfx engine\n")

with tempfile.TemporaryDirectory() as tmp:

    # -- a solid lands where the transform says ------------------------------
    # 64x64 comp, comp-sized red solid, scaled to half about the centre: a
    # 32x32 red square from 16 to 47 inclusive. Anything off by a factor of two
    # (percent read as a fraction) or centred on the corner (anchor ignored)
    # fails at least one of these.
    doc = comp([solid("s1", (255, 0, 0, 255),
                      transform={"anchor": [32, 32], "position": [32, 32],
                                 "scale": [50, 50], "rotation": 0, "opacity": 100})])
    f = engine.render_frame(doc, 0.0)
    eq("the frame is comp-sized", (f.shape[1], f.shape[0]), (64, 64))
    eq("a half-scaled solid covers the centre", px(f, 32, 32), (255, 0, 0, 255))
    eq("a half-scaled solid is inside its edge", px(f, 20, 32)[3], 255)
    eq("a half-scaled solid is transparent well outside it", px(f, 4, 32)[3], 0)
    eq("a half-scaled solid is transparent at the corner", px(f, 2, 2)[3], 0)

    # position moves it in COMP pixels
    doc = comp([solid("s1", (255, 0, 0, 255),
                      transform={"anchor": [32, 32], "position": [64, 32],
                                 "scale": [100, 100], "rotation": 0, "opacity": 100})])
    f = engine.render_frame(doc, 0.0)
    eq("moving the position slides the layer right", px(f, 40, 32)[3], 255)
    eq("what slid off the left is transparent", px(f, 20, 32)[3], 0)

    # rotation about the anchor turns the square into a diamond, so a corner
    # that was covered stops being covered
    base = {"anchor": [32, 32], "position": [32, 32], "scale": [50, 50], "opacity": 100}
    f = engine.render_frame(comp([solid("s1", (255, 0, 0, 255),
                                        transform=dict(base, rotation=0))]), 0.0)
    eq("unrotated, the square's corner is covered", px(f, 18, 18)[3], 255)
    f = engine.render_frame(comp([solid("s1", (255, 0, 0, 255),
                                        transform=dict(base, rotation=45))]), 0.0)
    eq("rotated 45, that corner falls outside the diamond", px(f, 18, 18)[3], 0)
    eq("rotated 45, the centre is still covered", px(f, 32, 32)[3], 255)
    eq("rotated 45, the diamond reaches further along the axis", px(f, 14, 32)[3], 255)

    # -- opacity --------------------------------------------------------------
    doc = comp([solid("s1", (255, 255, 255, 255),
                      transform={"anchor": [32, 32], "position": [32, 32],
                                 "scale": [100, 100], "rotation": 0, "opacity": 50})])
    f = engine.render_frame(doc, 0.0)
    eq("opacity is percent", px(f, 32, 32)[3], 128)

    # -- the time window ------------------------------------------------------
    doc = comp([solid("s1", (255, 0, 0, 255), start=1.0, end=2.0)])
    eq("before its start a layer is not drawn", int(engine.render_frame(doc, 0.5)[32, 32, 3]), 0)
    eq("inside its window a layer is drawn", px(engine.render_frame(doc, 1.5), 32, 32)[3], 255)
    eq("after its end a layer is not drawn", int(engine.render_frame(doc, 2.5)[32, 32, 3]), 0)
    eq("its start frame is drawn", px(engine.render_frame(doc, 1.0), 32, 32)[3], 255)
    # disabled and solo are the other two ways a layer stops existing
    doc = comp([solid("s1", (255, 0, 0, 255), enabled=False)])
    eq("a disabled layer is not drawn", int(engine.render_frame(doc, 0.0)[32, 32, 3]), 0)
    doc = comp([solid("a", (255, 0, 0, 255), solo=True), solid("b", (0, 0, 255, 255))])
    eq("solo hides everything that is not soloed", px(engine.render_frame(doc, 0.0), 32, 32),
       (255, 0, 0, 255))

    # -- stack order ----------------------------------------------------------
    # layers[0] is the TOP and paints LAST. Reverse the loop and this returns
    # the bottom layer's colour while every single-layer test still passes.
    doc = comp([solid("top", (0, 0, 255, 255)), solid("bottom", (255, 0, 0, 255))])
    eq("layers[0] paints last", px(engine.render_frame(doc, 0.0), 32, 32), (0, 0, 255, 255))

    # -- blending -------------------------------------------------------------
    # 128/255 = 0.502; multiplied with itself that is 0.2522 -> 64.
    doc = comp([solid("top", (128, 128, 128, 255), blend="multiply"),
                solid("bottom", (128, 128, 128, 255))])
    eq("multiply multiplies", px(engine.render_frame(doc, 0.0), 32, 32)[0], 64)
    doc = comp([solid("top", (128, 128, 128, 255), blend="screen"),
                solid("bottom", (128, 128, 128, 255))])
    eq("screen screens", px(engine.render_frame(doc, 0.0), 32, 32)[0], 192)
    # A mode that is NOT in imagetools._blend — the local half of the blend set.
    doc = comp([solid("top", (255, 255, 255, 255), blend="luminosity"),
                solid("bottom", (200, 0, 0, 255))])
    got = px(engine.render_frame(doc, 0.0), 32, 32)
    eq("luminosity takes the top's tone and the bottom's colour",
       got[0] == got[1] == got[2] == 255, True)
    # Blending over NOTHING must give the source, not the maths against black:
    # a comp's backdrop is transparent, unlike an image editor's.
    doc = comp([solid("only", (200, 100, 50, 255), blend="multiply")])
    eq("a blend against a transparent backdrop is the source itself",
       px(engine.render_frame(doc, 0.0), 32, 32), (200, 100, 50, 255))
    eq("every mode the spec lists is accepted",
       sorted(set(engine.BLEND_MODES)) == sorted(set(
           "normal multiply screen overlay softlight hardlight add subtract difference "
           "darken lighten colordodge colorburn hue saturation color luminosity".split())),
       True)

    # -- track mattes ---------------------------------------------------------
    # A white solid covering only the left half is used as the alpha matte for a
    # full-frame red solid beneath it.
    half = solid("matte", (255, 255, 255, 255),
                 transform={"anchor": [32, 32], "position": [16, 32],
                            "scale": [50, 100], "rotation": 0, "opacity": 100})
    doc = comp([half, solid("fill", (255, 0, 0, 255),
                            trackMatte={"type": "alpha"})])
    f = engine.render_frame(doc, 0.0)
    eq("an alpha matte keeps what the matte covers", px(f, 8, 32), (255, 0, 0, 255))
    eq("an alpha matte cuts what it does not", px(f, 56, 32)[3], 0)
    eq("the matte layer itself is never drawn", px(f, 8, 32)[:3], (255, 0, 0))

    doc = comp([half, solid("fill", (255, 0, 0, 255),
                            trackMatte={"type": "alphaInv"})])
    f = engine.render_frame(doc, 0.0)
    eq("an inverted alpha matte cuts what the matte covers", px(f, 8, 32)[3], 0)
    eq("an inverted alpha matte keeps the rest", px(f, 56, 32), (255, 0, 0, 255))

    # A mid-grey full-frame matte: luma reads its brightness, alpha would read
    # its (fully opaque) alpha. The two answers are 128 and 255.
    grey = solid("matte", (128, 128, 128, 255))
    doc = comp([grey, solid("fill", (255, 0, 0, 255), trackMatte={"type": "luma"})])
    eq("a luma matte reads brightness, not alpha",
       px(engine.render_frame(doc, 0.0), 32, 32)[3], 128)
    doc = comp([grey, solid("fill", (255, 0, 0, 255), trackMatte={"type": "alpha"})])
    eq("the same grey as an alpha matte is fully opaque",
       px(engine.render_frame(doc, 0.0), 32, 32)[3], 255)
    doc = comp([grey, solid("fill", (255, 0, 0, 255), trackMatte={"type": "lumaInv"})])
    eq("an inverted luma matte is the complement",
       px(engine.render_frame(doc, 0.0), 32, 32)[3], 127)

    # -- masks ----------------------------------------------------------------
    doc = comp([solid("s1", (0, 255, 0, 255),
                      masks=[{"id": "mk", "mode": "add",
                              "points": [[8, 8], [24, 8], [24, 24], [8, 24]],
                              "feather": 0, "opacity": 100, "invert": False, "expand": 0}])])
    f = engine.render_frame(doc, 0.0)
    eq("inside an add mask the layer shows", px(f, 16, 16)[3], 255)
    eq("outside an add mask it does not", px(f, 40, 40)[3], 0)
    doc["layers"][0]["masks"][0]["invert"] = True
    f = engine.render_frame(doc, 0.0)
    eq("inverting a mask swaps inside for outside", px(f, 16, 16)[3], 0)
    eq("inverting a mask keeps the outside", px(f, 40, 40)[3], 255)

    # -- image layers and parenting through a null ----------------------------
    # A 16x16 blue PNG parented to a null that moves it: the layer document says
    # position [0,0] and the pixels still land at the null's position.
    png = os.path.join(tmp, "chip.png")
    chip = np.zeros((16, 16, 4), dtype=np.uint8)
    chip[..., 2] = 255
    chip[..., 3] = 255
    Image.fromarray(chip, "RGBA").save(png)
    doc = comp([
        {"id": "img", "type": "image", "src": png, "parent": "nul",
         "start": 0.0, "end": 4.0, "enabled": True,
         "transform": {"anchor": [8, 8], "position": [0, 0], "scale": [100, 100],
                       "rotation": 0, "opacity": 100}},
        {"id": "nul", "type": "null", "start": 0.0, "end": 4.0, "enabled": True,
         "transform": {"anchor": [0, 0], "position": [48, 48], "scale": [100, 100],
                       "rotation": 0, "opacity": 100}},
    ])
    f = engine.render_frame(doc, 0.0)
    eq("a parented image lands at its parent's position", px(f, 48, 48), (0, 0, 255, 255))
    eq("a null renders nothing of its own", px(f, 8, 8)[3], 0)
    eq("the parented image is only where the parent put it", px(f, 20, 20)[3], 0)

    # -- adjustment layers ----------------------------------------------------
    # No effects.py here, so an adjustment layer with an empty stack must be a
    # perfect no-op rather than punching a hole in what is beneath it.
    doc = comp([{"id": "adj", "type": "adjustment", "start": 0.0, "end": 4.0,
                 "enabled": True, "effects": [],
                 "transform": {"anchor": [32, 32], "position": [32, 32],
                               "scale": [100, 100], "rotation": 0, "opacity": 100}},
                solid("under", (10, 200, 90, 255))])
    eq("an empty adjustment layer changes nothing",
       px(engine.render_frame(doc, 0.0), 32, 32), (10, 200, 90, 255))

    # -- animated properties drive the render ---------------------------------
    doc = comp([solid("s1", (255, 0, 0, 255), transform={
        "anchor": [32, 32], "scale": [50, 50], "rotation": 0, "opacity": 100,
        "position": {"keys": [{"t": 0.0, "v": [0, 32], "ease": "linear"},
                              {"t": 2.0, "v": [64, 32]}]}})])
    eq("at t=0 the animated solid sits on the left edge",
       px(engine.render_frame(doc, 0.0), 4, 32)[3], 255)
    eq("at t=1 it has reached the centre",
       px(engine.render_frame(doc, 1.0), 32, 32)[3], 255)
    eq("at t=1 it has left the left edge",
       px(engine.render_frame(doc, 1.0), 4, 32)[3], 0)

    # -- motion blur ----------------------------------------------------------
    # Same animation, blurred: the layer's hard edge must smear into partial
    # alpha, and only when BOTH the comp switch and the layer flag are on.
    moving = solid("s1", (255, 255, 255, 255), motionBlur=True, transform={
        "anchor": [32, 32], "scale": [50, 50], "rotation": 0, "opacity": 100,
        "position": {"keys": [{"t": 0.0, "v": [0, 32], "ease": "linear"},
                              {"t": 1.0, "v": [64, 32]}]}})
    off = comp([moving], motionBlur={"enabled": False, "shutter": 180, "samples": 8})
    on = comp([moving], motionBlur={"enabled": True, "shutter": 180, "samples": 8})
    edge_off = engine.render_frame(off, 0.5)[32, :, 3]
    edge_on = engine.render_frame(on, 0.5)[32, :, 3]
    partial = lambda row: int(((row > 0.02) & (row < 0.98)).sum())  # noqa: E731
    eq("without motion blur the edge is hard", partial(edge_off) <= 2, True)
    eq("with motion blur the edge is smeared", partial(edge_on) > partial(edge_off), True)
    eq("draft skips motion blur",
       partial(engine.render_frame(on, 0.5, draft=True)[32, :, 3]), partial(edge_off))
    eq("motion blur does not move the centre of the layer",
       abs(float((edge_on * np.arange(64)).sum() / max(edge_on.sum(), 1e-6))
           - float((edge_off * np.arange(64)).sum() / max(edge_off.sum(), 1e-6))) < 1.0, True)

    # -- preview scale --------------------------------------------------------
    doc = comp([solid("s1", (255, 0, 0, 255),
                      transform={"anchor": [32, 32], "position": [32, 32],
                                 "scale": [50, 50], "rotation": 0, "opacity": 100})])
    half_res = engine.render_frame(doc, 0.0, scale=0.5)
    eq("half scale halves the frame", (half_res.shape[1], half_res.shape[0]), (32, 32))
    eq("half scale puts the same pixels in the same PROPORTIONAL place",
       px(half_res, 16, 16), (255, 0, 0, 255))
    eq("half scale still clears the corner", px(half_res, 1, 1)[3], 0)

    # -- background -----------------------------------------------------------
    doc = comp([], bg=(20, 30, 40, 255))
    eq("an opaque comp background paints", px(engine.render_frame(doc, 0.0), 0, 0),
       (20, 30, 40, 255))
    eq("the default background is transparent",
       px(engine.render_frame(comp([]), 0.0), 0, 0), (0, 0, 0, 0))

    # -- video decode, its LRU cache, and reversed time -----------------------
    # A 24-frame clip whose red channel counts the frames: reading back the red
    # value IS reading back which frame was decoded.
    clip = os.path.join(tmp, "ramp.mp4")
    import av  # noqa: E402  — only this block needs it
    cont = av.open(clip, "w")
    st = cont.add_stream("libx264", rate=24)
    st.width, st.height, st.pix_fmt = 32, 32, "yuv420p"
    st.time_base = Fraction(1, 24)
    st.options = {"crf": "0", "preset": "ultrafast"}
    for i in range(24):
        a = np.zeros((32, 32, 3), np.uint8)
        a[..., 0] = i * 10
        f_ = av.VideoFrame.from_ndarray(a, format="rgb24")
        f_.pts = i
        for pkt in st.encode(f_):
            cont.mux(pkt)
    for pkt in st.encode(None):
        cont.mux(pkt)
    cont.close()

    vid = {"id": "v", "type": "video", "src": clip, "start": 0.0, "end": 1.0,
           "inPoint": 0.0, "timeScale": 1.0, "enabled": True,
           "transform": {"anchor": [16, 16], "position": [32, 32], "scale": [100, 100],
                         "rotation": 0, "opacity": 100}}
    doc = comp([vid], fps=24.0, duration=1.0)
    r0 = px(engine.render_frame(doc, 0.0), 32, 32)[0]
    r10 = px(engine.render_frame(doc, 10 / 24.0), 32, 32)[0]
    eq("frame 0 of a clip decodes as frame 0", r0 < 8, True)
    eq("frame 10 decodes as frame 10", abs(r10 - 100) <= 6, True)

    # Scrubbing the same second repeatedly must not touch the file again. The
    # cache is keyed (path, index), so a second pass over the same times has to
    # leave the entry count where it was.
    before = len(engine._FRAMES)
    for i in range(24):
        engine.render_frame(doc, i / 24.0)
    grew = len(engine._FRAMES)
    for _ in range(3):
        for i in range(24):
            engine.render_frame(doc, i / 24.0)
    eq("re-scrubbing decodes nothing new", len(engine._FRAMES), grew)
    eq("the first scrub did cache frames", grew > before, True)
    eq("the cache is keyed by path and frame index",
       all(isinstance(k, tuple) and len(k) == 2 for k in engine._FRAMES), True)

    # timeScale -1 walks the source backwards from the in point, and the clamp at
    # zero is what "hold the first frame" means.
    rev = dict(vid, inPoint=0.5, timeScale=-1.0)
    doc = comp([rev], fps=24.0, duration=1.0)
    eq("a reversed layer starts in the middle of its source",
       abs(px(engine.render_frame(doc, 0.0), 32, 32)[0] - 120) <= 8, True)
    eq("a reversed layer has walked backwards by t=0.25",
       px(engine.render_frame(doc, 0.25), 32, 32)[0]
       < px(engine.render_frame(doc, 0.0), 32, 32)[0], True)
    eq("a reversed layer clamps at the head of its source",
       px(engine.render_frame(doc, 0.9), 32, 32)[0] < 8, True)

    # timeScale 2 runs the source at double speed
    fast = dict(vid, timeScale=2.0)
    doc = comp([fast], fps=24.0, duration=1.0)
    eq("timeScale 2 is twice as far into the source at the same comp time",
       abs(px(engine.render_frame(doc, 5 / 24.0), 32, 32)[0] - 100) <= 8, True)

    # -- the CLI --------------------------------------------------------------
    job = os.path.join(tmp, "job.json")
    out_png = os.path.join(tmp, "preview.png")
    doc = comp([solid("s1", (255, 0, 0, 255))])
    with open(job, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"comp": doc, "t": 0.0, "out": out_png, "scale": 0.5}))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = engine.main(["frame", job])
    line = json.loads(buf.getvalue().strip().splitlines()[-1])
    eq("frame mode exits clean", code, 0)
    eq("frame mode reports ok", line["ok"], True)
    eq("frame mode reports the scaled size", (line["width"], line["height"]), (32, 32))
    eq("frame mode reports its own cost", isinstance(line["ms"], int), True)
    eq("frame mode actually wrote the file", os.path.exists(out_png), True)
    eq("the written frame is RGBA", Image.open(out_png).mode, "RGBA")

    with open(job, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(
            {"comp": doc, "out": os.path.join(tmp, "seq"), "format": "png",
             "from": 0.0, "to": 0.5, "scale": 0.25, "progressEvery": 5}))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = engine.main(["render", job])
    lines = [json.loads(x) for x in buf.getvalue().strip().splitlines()]
    eq("render mode exits clean", code, 0)
    eq("render mode emits progress before its result",
       all("progress" in x for x in lines[:-1]) and len(lines) > 1, True)
    eq("progress carries a frame number", all("frame" in x for x in lines[:-1]), True)
    eq("render mode counted the frames right", lines[-1]["frames"], 15)
    eq("render mode reports the seconds it covered", lines[-1]["seconds"], 0.5)
    eq("a png sequence is a directory of numbered frames",
       len([n for n in os.listdir(os.path.join(tmp, "seq")) if n.endswith(".png")]), 15)

    # An mp4 has to come back out at the size, length and content that went in —
    # this is the path where an odd dimension or a stray frame time_base turns a
    # finished render into an EINVAL nobody sees until the file will not open.
    mp4 = os.path.join(tmp, "out.mp4")
    with open(job, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(
            {"comp": comp([solid("s1", (255, 0, 0, 255))], w=61, h=45, fps=24.0, duration=1.0),
             "out": mp4, "format": "mp4", "from": 0.0, "to": 0.5, "crf": 20,
             "progressEvery": 0}))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = engine.main(["render", job])
    line = json.loads(buf.getvalue().strip())
    eq("an mp4 render exits clean", code, 0)
    eq("an mp4 render counted its frames", line["frames"], 12)
    probe = engine._probe_one(mp4)
    eq("an odd comp size is made even for yuv420p", (probe["width"], probe["height"]), (60, 44))
    eq("the mp4 holds the frames it said it did", round(probe["duration"] * 24), 12)

    # mov exists in the format list for exactly one reason: alpha survives it.
    mov = os.path.join(tmp, "out.mov")
    with open(job, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(
            {"comp": comp([solid("s1", (255, 0, 0, 255), transform={
                "anchor": [32, 32], "position": [32, 32], "scale": [50, 50],
                "rotation": 0, "opacity": 100})], fps=24.0, duration=0.25),
             "out": mov, "format": "mov", "progressEvery": 0}))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = engine.main(["render", job])
    eq("a mov render exits clean", code, 0)
    with av.open(mov) as dec:
        back = next(dec.decode(video=0)).to_ndarray(format="rgba")
    eq("a mov keeps the comp's transparency", int(back[2, 2, 3]), 0)
    eq("a mov keeps the comp's pixels", tuple(int(v) for v in back[32, 32]), (255, 0, 0, 255))

    with open(job, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"sources": [png, clip, os.path.join(tmp, "nope.mp4")]}))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = engine.main(["probe", job])
    got = json.loads(buf.getvalue().strip())
    eq("probe exits clean", code, 0)
    eq("probe names a still an image", got["sources"][0]["kind"], "image")
    eq("probe reads a still's size",
       (got["sources"][0]["width"], got["sources"][0]["height"]), (16, 16))
    eq("probe names a clip a video", got["sources"][1]["kind"], "video")
    eq("probe reads a clip's fps", round(got["sources"][1]["fps"]), 24)
    eq("probe reads a clip's duration", round(got["sources"][1]["duration"], 1), 1.0)
    # One bad path must not hide the answer for the good ones.
    eq("a missing source is reported, not fatal", got["sources"][2]["kind"], "unknown")
    eq("a missing source carries its reason", "error" in got["sources"][2], True)

    # Failure is one line and a non-zero exit, on every mode.
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = engine.main(["frame", os.path.join(tmp, "does-not-exist.json")])
    eq("a bad job exits 1", code, 1)
    eq("a bad job says so in one line", json.loads(buf.getvalue().strip())["ok"],
       False)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = engine.main(["wat", job])
    eq("an unknown mode exits 1", code, 1)
    eq("an unknown mode names itself",
       "wat" in json.loads(buf.getvalue().strip())["error"], True)

    # Windows will not delete the temp dir while a decoder still holds the clip.
    engine.close_sources()
    eq("closing sources releases every container", len(engine._READERS), 0)

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
