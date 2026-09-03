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

And the same again for everything the engine grew past the spec:

  - a precomp that renders a placeholder instead of its child's pixels,
  - a comp that reaches itself and is found out by a RecursionError at frame 900
    rather than by name on frame one,
  - collapse transformations that move the layer while sharpening it,
  - a 3D opt-in that is not opt-in — a 2D layer shifting because a camera exists,
  - z that scales a layer linearly instead of projecting it (looks like
    perspective until two layers at different depths have to pass each other),
  - a depth sort that runs over the whole stack instead of over each RUN, so a
    2D layer stops dividing the 3D layers either side of it,
  - a "per-character" animator that applies one transform to the whole layer
    (every "the text moved" assertion still passes; nothing staggers),
  - a selector shape that quietly falls back to square,
  - a stencil that reaches one layer down like a track matte instead of all of
    them, and preserve-underlying-transparency that grows alpha anyway,
  - a layer style applied after the transform, where a 4px stroke stops being
    4px the moment the layer is scaled,
  - a time remap that stacks with inPoint/timeScale instead of replacing it.

Comps are built synthetically in a temp dir — no external media, so this runs
anywhere the venv does.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/engine_test.py

PyAV/cv2/numpy/PIL, same as engine.py itself. effects.py is a separate
deliverable and may be absent; the three layer styles that delegate to it assert
their documented no-op fallback when it is, so the count does not move either way.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import time
from fractions import Fraction

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vfx import colour, engine, interp  # noqa: E402

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

    # -- nested precomps ------------------------------------------------------
    # The whole point: the child's PIXELS become the layer, so everything that
    # happens to a layer happens to a whole composition.
    kid = comp([solid("k", (0, 255, 0, 255))])
    kid["slug"] = "kid"

    def comp_layer(src="kid", **over):
        lay = {"id": "cl", "name": "nested", "type": "comp", "src": src,
               "start": 0.0, "end": 4.0, "enabled": True,
               "transform": {"anchor": [32, 32], "position": [32, 32],
                             "scale": [100, 100], "rotation": 0, "opacity": 100}}
        lay.update(over)
        return lay

    doc = comp([comp_layer()], comps={"kid": kid})
    f = engine.render_frame(doc, 0.0)
    eq("a nested comp renders its child's pixels", px(f, 32, 32), (0, 255, 0, 255))
    # A precomp that is only a placeholder would still be transparent here; a
    # precomp that ignores its own transform would fill the frame.
    doc = comp([comp_layer(transform={"anchor": [32, 32], "position": [32, 32],
                                      "scale": [50, 50], "rotation": 0, "opacity": 100})],
               comps={"kid": kid})
    f = engine.render_frame(doc, 0.0)
    eq("a nested comp obeys the layer's transform", px(f, 32, 32), (0, 255, 0, 255))
    eq("a nested comp is only where the transform put it", px(f, 4, 32)[3], 0)
    # ...and everything else a layer has: opacity, blend, masks, matte.
    doc = comp([comp_layer(transform={"anchor": [32, 32], "position": [32, 32],
                                      "scale": [100, 100], "rotation": 0, "opacity": 50})],
               comps={"kid": kid})
    eq("a nested comp obeys layer opacity", px(engine.render_frame(doc, 0.0), 32, 32)[3], 128)
    doc = comp([comp_layer(masks=[{"id": "mk", "mode": "add",
                                   "points": [[8, 8], [24, 8], [24, 24], [8, 24]],
                                   "feather": 0, "opacity": 100}])],
               comps={"kid": kid})
    f = engine.render_frame(doc, 0.0)
    eq("a mask cuts a nested comp like any other layer",
       (px(f, 16, 16)[3], px(f, 40, 40)[3]), (255, 0))

    # The child is rendered at the MAPPED time, so the child's own timeline runs.
    timed = comp([solid("late", (255, 0, 0, 255), start=2.0, end=4.0)])
    timed["slug"] = "timed"
    doc = comp([comp_layer(src="timed")], comps={"timed": timed})
    eq("a nested comp is rendered at the mapped time, not t=0",
       int(engine.render_frame(doc, 0.0)[32, 32, 3]), 0)
    eq("a nested comp's own timeline runs", px(engine.render_frame(doc, 2.5), 32, 32)[3], 255)
    # inPoint offsets that mapping the same way a clip's does
    doc = comp([comp_layer(src="timed", inPoint=2.5)], comps={"timed": timed})
    eq("inPoint offsets a nested comp's source time",
       px(engine.render_frame(doc, 0.0), 32, 32)[3], 255)

    # A comp document may carry the child inline instead of by slug.
    doc = comp([comp_layer(src="inline", comp=kid)])
    eq("a nested comp may be carried inline",
       px(engine.render_frame(doc, 0.0), 32, 32), (0, 255, 0, 255))

    # A comp inside itself is a document anyone can write in two clicks. It has
    # to be refused BY NAME, not discovered as a RecursionError at frame 900.
    doc = comp([comp_layer(src="test")])          # comp()'s own slug is "test"
    doc["slug"] = "test"
    try:
        engine.render_frame(doc, 0.0)
        refused = None
    except ValueError as exc:
        refused = str(exc)
    eq("a comp containing itself is refused", refused is not None, True)
    eq("the refusal names the comp", "test" in (refused or ""), True)
    eq("the refusal shows the path that closed the loop", "->" in (refused or ""), True)

    # Mutual recursion is the same trap with one more step in it.
    ping = comp([comp_layer(src="pong")])
    ping["slug"] = "ping"
    pong = comp([comp_layer(src="ping")])
    pong["slug"] = "pong"
    ping["comps"] = {"ping": ping, "pong": pong}
    try:
        engine.render_frame(ping, 0.0)
        mutual = None
    except ValueError as exc:
        mutual = str(exc)
    eq("mutual recursion is refused too", mutual is not None, True)

    # A chain with no cycle still has to stop somewhere.
    docs = {}
    for i in range(12):
        inner = ([comp_layer(src=f"c{i + 1}")] if i < 11
                 else [solid("s", (0, 255, 0, 255))])
        d = comp(inner)
        d["slug"] = f"c{i}"
        docs[f"c{i}"] = d
    deep = docs["c0"]
    deep["comps"] = docs
    try:
        engine.render_frame(deep, 0.0)
        capped = None
    except ValueError as exc:
        capped = str(exc)
    eq("nesting past the depth cap is refused", capped is not None, True)
    eq("the depth refusal says how deep is too deep",
       str(engine.MAX_COMP_DEPTH) in (capped or ""), True)
    # ...and a chain INSIDE the cap renders all the way down
    shallow = {k: v for k, v in docs.items() if int(k[1:]) >= 9}
    shallow["c9"] = dict(docs["c9"], layers=[comp_layer(src="c10")])
    root3 = dict(docs["c9"])
    root3["comps"] = docs
    eq("a legal chain renders through every level",
       px(engine.render_frame(root3, 0.0), 32, 32), (0, 255, 0, 255))

    # Collapse transformations = continuous rasterisation: the child is rendered
    # at the size it will be SEEN at, so blowing it up shows the child's detail
    # rather than the 100% raster's pixels. Same geometry either way.
    small = comp([solid("dot", (255, 0, 0, 255), width=8, height=8,
                        transform={"anchor": [4, 4], "position": [16, 16],
                                   "scale": [100, 100], "rotation": 0, "opacity": 100})],
                 w=32, h=32)
    small["slug"] = "small"
    big = comp_layer(src="small", transform={"anchor": [16, 16], "position": [64, 64],
                                             "scale": [400, 400], "rotation": 0,
                                             "opacity": 100})
    doc = comp([big], w=128, h=128, comps={"small": small})
    flat = engine.render_frame(doc, 0.0)
    big["collapse"] = True
    crisp = engine.render_frame(doc, 0.0)
    softness = lambda f: int(((f[64, :, 3] > 0.02) & (f[64, :, 3] < 0.98)).sum())  # noqa: E731
    eq("an uncollapsed precomp resamples its raster", softness(flat) > 2, True)
    eq("collapse rasterises the child at display size", softness(crisp), 0)
    eq("collapse does not move the layer",
       abs(int((crisp[64, :, 3] > 0.5).sum()) - int((flat[64, :, 3] > 0.5).sum())) <= 2, True)
    eq("collapse keeps the child's colour", px(crisp, 64, 64), (255, 0, 0, 255))
    # AE turns the switch off for a layer that needs a fixed grid, and so does this
    eq("a mask forces a collapsed layer to rasterise at comp size",
       engine._collapse_scale(dict(big, masks=[{"id": "m", "mode": "add",
                                                "points": [[0, 0], [1, 0], [1, 1]]}]),
                              interp.IDENTITY * 4, False), 1.0)
    eq("draft never rasterises above nominal",
       engine._collapse_scale(big, np.array([[4.0, 0, 0], [0, 4.0, 0]]), True), 1.0)

    # -- 3D layers and the camera ---------------------------------------------
    def solid3(lid, color, pos, **over):
        lay = solid(lid, color, threeD=True,
                    transform={"anchor": [32, 32], "position": list(pos),
                               "scale": [50, 50], "rotation": 0, "opacity": 100})
        lay.update(over)
        return lay

    # The opt-in has to be invisible until something moves: a layer turned 3D and
    # otherwise untouched must land exactly where the 2D one did, or every
    # existing comp shifts the moment somebody ticks the switch.
    flat2d = solid("s", (255, 0, 0, 255),
                   transform={"anchor": [32, 32], "position": [32, 32],
                              "scale": [50, 50], "rotation": 0, "opacity": 100})
    a2d = engine.render_frame(comp([flat2d]), 0.0)
    a3d = engine.render_frame(comp([solid3("s", (255, 0, 0, 255), [32, 32, 0])]), 0.0)
    eq("a 3D layer at z=0 lands exactly where the 2D one did",
       int(np.abs(a2d - a3d).max() * 255) <= 1, True)
    # and a camera in the comp must not touch the 2D layer next to it
    cam = {"id": "cam", "type": "camera", "start": 0.0, "end": 4.0, "enabled": True,
           "transform": {"position": [200, 300, -400]},
           "camera": {"pointOfInterest": [10, 10, 0], "zoom": 400}}
    eq("a camera does not move 2D layers",
       int(np.abs(engine.render_frame(comp([cam, flat2d]), 0.0) - a2d).max() * 255), 0)
    eq("a camera layer is never painted",
       px(engine.render_frame(comp([cam]), 0.0), 32, 32)[3], 0)

    span = lambda f: int((f[32, :, 3] > 0.5).sum())  # noqa: E731
    near = engine.render_frame(comp([solid3("s", (255, 0, 0, 255), [32, 32, -40])]), 0.0)
    far = engine.render_frame(comp([solid3("s", (255, 0, 0, 255), [32, 32, 600])]), 0.0)
    eq("pushing a layer away in z shrinks it", span(far) < span(a3d), True)
    eq("pulling a layer toward the camera grows it", span(near) > span(a3d), True)
    # Perspective, not a linear scale: step the SAME distance either way and the
    # near step is worth more than the far one. A z that merely scaled the layer
    # would make these two deltas equal.
    step_near = span(engine.render_frame(
        comp([solid3("s", (255, 0, 0, 255), [32, 32, -40])]), 0.0)) - span(a3d)
    step_far = span(a3d) - span(engine.render_frame(
        comp([solid3("s", (255, 0, 0, 255), [32, 32, 40])]), 0.0))
    eq("z is perspective, not a linear scale", step_near > step_far, True)

    # A camera move has to shift the layer the OPPOSITE way, by the right amount:
    # a 20px dolly right at the default distance moves a z=0 layer 20px left.
    z0 = 64 * engine.DEFAULT_FOCAL_MM / engine.FILM_MM
    moved_cam = {"id": "cam", "type": "camera", "start": 0.0, "end": 4.0, "enabled": True,
                 "transform": {"position": [52, 32, -z0]},
                 "camera": {"pointOfInterest": [52, 32, 0], "zoom": z0}}
    shifted = engine.render_frame(comp([moved_cam, solid3("s", (255, 0, 0, 255), [32, 32, 0])]), 0.0)
    cols = np.where(shifted[32, :, 3] > 0.5)[0]
    eq("a camera move shifts the layer the other way", int(cols.max()), 27
       if len(cols) else -1)
    eq("a camera move does not resize a layer it stays level with", int(cols.min()), 0)
    # ...and the default camera IS the one at -zoom, so naming it changes nothing
    default_cam = {"id": "cam", "type": "camera", "start": 0.0, "end": 4.0, "enabled": True,
                   "transform": {"position": [32, 32, -z0]},
                   "camera": {"pointOfInterest": [32, 32, 0], "zoom": z0}}
    eq("an explicit default camera matches the implicit one",
       int(np.abs(engine.render_frame(
           comp([default_cam, solid3("s", (255, 0, 0, 255), [32, 32, 0])]), 0.0)
           - a3d).max() * 255) <= 1, True)

    # Back-to-front by z, regardless of stack order. Flip the depths and the
    # answer flips with them — a sort that silently does nothing passes the first
    # of these and fails the second.
    red_far = solid3("a", (255, 0, 0, 255), [32, 32, 600], transform={
        "anchor": [32, 32], "position": [32, 32, 600], "scale": [100, 100],
        "rotation": 0, "opacity": 100})
    blue_near = solid3("b", (0, 0, 255, 255), [32, 32, -40], transform={
        "anchor": [32, 32], "position": [32, 32, -40], "scale": [100, 100],
        "rotation": 0, "opacity": 100})
    eq("the nearer 3D layer wins whatever the stack says",
       px(engine.render_frame(comp([red_far, blue_near]), 0.0), 32, 32)[2], 255)
    red_near = dict(red_far, transform=dict(red_far["transform"], position=[32, 32, -40]))
    blue_far = dict(blue_near, transform=dict(blue_near["transform"], position=[32, 32, 600]))
    eq("swapping the depths swaps the winner",
       px(engine.render_frame(comp([red_near, blue_far]), 0.0), 32, 32)[0], 255)
    # A 2D layer has no depth, so it holds its place and divides the run either
    # side of it — AE's rule, and the reason this is a run and not a global sort.
    divider = solid("mid", (0, 255, 0, 255), transform={
        "anchor": [32, 32], "position": [32, 32], "scale": [100, 100],
        "rotation": 0, "opacity": 100})
    # ...so the same two layers that sorted by depth a moment ago no longer can:
    # red is the TOP of the stack and the FURTHEST away, and it wins anyway.
    eq("a 2D layer divides the 3D run either side of it",
       px(engine.render_frame(comp([red_far, divider, blue_near]), 0.0), 32, 32)[0], 255)
    eq("without the divider the same pair sorts by depth",
       px(engine.render_frame(comp([red_far, blue_near]), 0.0), 32, 32)[0], 0)

    # Rotation about Y turns the plane away, so it covers less across but keeps
    # its height — a scale would shrink both.
    turned = engine.render_frame(comp([solid3("s", (255, 0, 0, 255), [32, 32, 0], transform={
        "anchor": [32, 32], "position": [32, 32, 0], "scale": [50, 50],
        "rotationY": 60, "opacity": 100})]), 0.0)
    eq("rotating about Y foreshortens the layer", span(turned) < span(a3d), True)
    eq("rotating about Y keeps its height",
       int((turned[:, 32, 3] > 0.5).sum()), int((a3d[:, 32, 3] > 0.5).sum()))
    # `rotation` is the Z alias, so a 2D spin survives the promotion to 3D
    spun2d = engine.render_frame(comp([solid("s", (255, 0, 0, 255), transform={
        "anchor": [32, 32], "position": [32, 32], "scale": [50, 50],
        "rotation": 45, "opacity": 100})]), 0.0)
    spun3d = engine.render_frame(comp([solid3("s", (255, 0, 0, 255), [32, 32, 0], transform={
        "anchor": [32, 32], "position": [32, 32, 0], "scale": [50, 50],
        "rotation": 45, "opacity": 100})]), 0.0)
    eq("rotation is the Z alias on a 3D layer",
       int(np.abs(spun2d - spun3d).max() * 255) <= 2, True)
    eq("rotationZ says the same thing as rotation",
       int(np.abs(spun3d - engine.render_frame(comp([solid3(
           "s", (255, 0, 0, 255), [32, 32, 0], transform={
               "anchor": [32, 32], "position": [32, 32, 0], "scale": [50, 50],
               "rotationZ": 45, "opacity": 100})]), 0.0)).max() * 255) <= 1, True)

    # Behind the lens there is no projection, and a homography fitted to those
    # corners puts garbage on screen at full brightness.
    eq("a layer behind the camera is not drawn",
       int(engine.render_frame(comp([solid3("s", (255, 0, 0, 255), [32, 32, -400])]),
                               0.0)[32, 32, 3]), 0)

    # Depth of field: in focus is a hard edge, out of focus is not, and draft
    # skips the whole thing because it is the expensive half.
    dof_cam = {"id": "cam", "type": "camera", "start": 0.0, "end": 4.0, "enabled": True,
               "transform": {"position": [32, 32, -500]},
               "camera": {"zoom": 500, "depthOfField": True, "focusDistance": 500,
                          "aperture": 60, "blurLevel": 100}}
    fuzz = lambda f: int(((f[32, :, 3] > 0.02) & (f[32, :, 3] < 0.98)).sum())  # noqa: E731
    focused = engine.render_frame(comp([dof_cam, solid3("s", (255, 255, 255, 255), [32, 32, 0])]), 0.0)
    defocused = engine.render_frame(comp([dof_cam, solid3("s", (255, 255, 255, 255), [32, 32, 400])]), 0.0)
    eq("a layer at the focus distance stays sharp", fuzz(focused) <= 2, True)
    eq("a layer off the focus distance blurs", fuzz(defocused) > fuzz(focused), True)
    eq("draft skips depth of field",
       fuzz(engine.render_frame(comp([dof_cam, solid3("s", (255, 255, 255, 255),
                                                      [32, 32, 400])]), 0.0, draft=True)) <= 2,
       True)
    eq("depth of field is off unless the camera asks for it",
       fuzz(engine.render_frame(comp([{"id": "c2", "type": "camera", "start": 0.0,
                                       "end": 4.0, "enabled": True,
                                       "transform": {"position": [32, 32, -500]},
                                       "camera": {"zoom": 500}},
                                      solid3("s", (255, 255, 255, 255), [32, 32, 400])]),
                                0.0)) <= 2, True)

    # -- text animators -------------------------------------------------------
    def text_layer(content, animators=None, w=200, size=20, **over):
        lay = {"id": "tx", "name": "type", "type": "text", "start": 0.0, "end": 4.0,
               "enabled": True,
               "text": {"content": content, "font": "arial.ttf", "size": size,
                        "color": [255, 255, 255, 255], "align": "center"},
               "transform": {"anchor": [w / 2, 32], "position": [w / 2, 32],
                             "scale": [100, 100], "rotation": 0, "opacity": 100}}
        if animators is not None:
            lay["animators"] = animators
        lay.update(over)
        return lay

    def ink(frame, x0, x1):
        return float(frame[:, x0:x1, 3].sum())

    plain = engine.render_frame(comp([text_layer("HELLO")], w=200, h=64), 0.0)
    eq("a text layer with no animators still draws", ink(plain, 0, 200) > 10.0, True)
    # An empty animator list must take the old path byte for byte — that is what
    # "additive" means for a feature that reroutes an existing renderer.
    eq("an empty animator list is the old raster",
       int(np.abs(plain - engine.render_frame(comp([text_layer("HELLO", [])], w=200, h=64),
                                              0.0)).max() * 255) <= 1, True)
    # ...and so must an animator whose selector is currently over nobody
    away = [{"properties": {"opacity": 0},
             "selector": {"type": "range", "start": 0, "end": 10, "offset": -200,
                          "shape": "square"}}]
    # (within a hair, not to the byte: this path rasterises glyph by glyph, so
    # the antialiasing between two letters is its own and not the line's)
    quiet = engine.render_frame(comp([text_layer("HELLO", away)], w=200, h=64), 0.0)
    eq("an animator selecting nobody leaves the type alone",
       abs(ink(quiet, 0, 200) - ink(plain, 0, 200)) / max(ink(plain, 0, 200), 1.0) < 0.05,
       True)

    # THE test: mid-sweep, two characters must not look the same. A per-character
    # animator that quietly applies one transform to the whole layer passes every
    # "the text moved" assertion and fails this one.
    sweep = [{"properties": {"opacity": 0},
              "selector": {"type": "range", "start": 0, "end": 50, "offset": 0,
                           "shape": "square"}}]
    half = engine.render_frame(comp([text_layer("IIIIIIII", sweep)], w=200, h=64), 0.0)
    eq("mid-sweep the selected characters are gone", ink(half, 0, 100) < 1.0, True)
    eq("mid-sweep the unselected characters are untouched", ink(half, 100, 200) > 10.0, True)
    # the same document with the window over everybody, and over nobody
    allsel = [{"properties": {"opacity": 0},
               "selector": {"type": "range", "start": 0, "end": 100, "shape": "square"}}]
    eq("a selector over every character reaches every character",
       ink(engine.render_frame(comp([text_layer("IIIIIIII", allsel)], w=200, h=64), 0.0),
           0, 200) < 1.0, True)

    # A ramp is what makes a cascade: the weight has to climb across the string,
    # so the first and last characters differ by MORE than either differs from
    # its neighbour.
    ramp = [{"properties": {"opacity": 0},
             "selector": {"type": "range", "start": 0, "end": 100, "shape": "rampDown"}}]
    graded = engine.render_frame(comp([text_layer("IIIIIIII", ramp)], w=200, h=64), 0.0)
    lit = np.where(engine.render_frame(comp([text_layer("IIIIIIII")], w=200, h=64),
                                       0.0)[:, :, 3].sum(axis=0) > 0.5)[0]
    edges = np.linspace(lit.min(), lit.max() + 1, 5).astype(int)
    quarters = [ink(graded, edges[i], edges[i + 1]) for i in range(4)]
    eq("a ramp selector grades across the string",
       all(quarters[i] <= quarters[i + 1] + 1e-6 for i in range(3)), True)
    eq("a ramp selector actually reaches both ends", quarters[-1] > quarters[0] + 1.0, True)

    # Offset is the typewriter dial, and it is a normal keyframed property.
    typed = [{"properties": {"opacity": 0},
              "selector": {"type": "range", "start": 0, "end": 100, "shape": "square",
                           "offset": {"keys": [{"t": 0.0, "v": 0}, {"t": 1.0, "v": 100}]}}}]
    doc = comp([text_layer("IIIIIIII", typed)], w=200, h=64)
    eq("at the start of the sweep every character is hidden",
       ink(engine.render_frame(doc, 0.0), 0, 200) < 1.0, True)
    eq("at the end of the sweep every character is back",
       ink(engine.render_frame(doc, 1.0), 0, 200) > 10.0, True)
    # offset slides the window along, so the characters it has already passed are
    # the ones that come back — the front of the string first.
    eq("halfway through, some are back and some are not",
       ink(engine.render_frame(doc, 0.5), 0, 100) > ink(engine.render_frame(doc, 0.5), 100, 200),
       True)

    # Position, scale and rotation each have to reach ONE character, not the layer.
    pushed = [{"properties": {"position": [0, -20]},
               "selector": {"type": "range", "start": 0, "end": 50, "shape": "square"}}]
    lifted = engine.render_frame(comp([text_layer("IIIIIIII", pushed)], w=200, h=64), 0.0)
    top_left = float(lifted[:20, :100, 3].sum())
    top_right = float(lifted[:20, 100:, 3].sum())
    eq("a position animator lifts only the characters it selects",
       top_left > top_right + 1.0, True)
    grown = [{"properties": {"scale": [300, 300]},
              "selector": {"type": "range", "start": 0, "end": 50, "shape": "square"}}]
    fat = engine.render_frame(comp([text_layer("IIIIIIII", grown)], w=200, h=64), 0.0)
    eq("a scale animator grows only the characters it selects",
       ink(fat, 0, 100) > ink(half, 100, 200), True)
    # Tracking pushes every LATER character along, which is what makes it tracking
    # rather than a position offset.
    spread = [{"properties": {"tracking": 12},
               "selector": {"type": "range", "start": 0, "end": 50, "shape": "square"}}]
    loose = engine.render_frame(comp([text_layer("IIIIIIII", spread)], w=200, h=64), 0.0)
    cols_tight = np.where(engine.render_frame(comp([text_layer("IIIIIIII")], w=200, h=64),
                                              0.0)[:, :, 3].sum(axis=0) > 0.5)[0]
    cols_loose = np.where(loose[:, :, 3].sum(axis=0) > 0.5)[0]
    eq("a tracking animator widens the line",
       (cols_loose.max() - cols_loose.min()) > (cols_tight.max() - cols_tight.min()), True)
    # Two animators stack rather than the last one winning.
    both = [{"properties": {"opacity": 50},
             "selector": {"type": "range", "start": 0, "end": 100, "shape": "square"}},
            {"properties": {"opacity": 50},
             "selector": {"type": "range", "start": 0, "end": 100, "shape": "square"}}]
    one = [{"properties": {"opacity": 50},
            "selector": {"type": "range", "start": 0, "end": 100, "shape": "square"}}]
    eq("two animators compound instead of replacing each other",
       ink(engine.render_frame(comp([text_layer("IIIIIIII", both)], w=200, h=64), 0.0)
           , 0, 200) < ink(engine.render_frame(comp([text_layer("IIIIIIII", one)], w=200,
                                                    h=64), 0.0), 0, 200), True)

    # The selector shapes are the shapes they are named for.
    shapes = {}
    for shape in ("square", "triangle", "round", "smooth", "rampUp", "rampDown"):
        w_ = [engine._selector_weight({"start": 0, "end": 100, "shape": shape}, i, 9, 0.0)
              for i in range(9)]
        shapes[shape] = [round(v, 3) for v in w_]
    eq("square selects its whole range flat", shapes["square"], [1.0] * 9)
    eq("triangle peaks in the middle", shapes["triangle"][4] > shapes["triangle"][0], True)
    eq("triangle is symmetric", shapes["triangle"][0], shapes["triangle"][8])
    eq("round is fuller than triangle at the same place",
       shapes["round"][2] > shapes["triangle"][2], True)
    eq("smooth starts and ends at nothing",
       (shapes["smooth"][0] < 0.1, shapes["smooth"][-1] < 0.1), (True, True))
    eq("rampUp climbs", all(shapes["rampUp"][i] <= shapes["rampUp"][i + 1] for i in range(8)),
       True)
    eq("rampDown is its mirror",
       [round(1.0 - v, 3) for v in shapes["rampDown"]], shapes["rampUp"])
    eq("a ramp keeps going past its range",
       engine._selector_weight({"start": 0, "end": 10, "shape": "rampUp"}, 8, 9, 0.0), 1.0)
    eq("a square stops at its range",
       engine._selector_weight({"start": 0, "end": 10, "shape": "square"}, 8, 9, 0.0), 0.0)
    eq("offset slides the window",
       engine._selector_weight({"start": 0, "end": 10, "offset": 80, "shape": "square"},
                               7, 9, 0.0), 1.0)
    eq("offset slides it off the characters it left behind",
       engine._selector_weight({"start": 0, "end": 10, "offset": 80, "shape": "square"},
                               0, 9, 0.0), 0.0)
    # Ease High/Low reshape the ramp itself, and both zero must be the straight line.
    plain_mid = engine._selector_weight({"start": 0, "end": 100, "shape": "rampUp"}, 2, 9, 0.0)
    eased = engine._selector_weight({"start": 0, "end": 100, "shape": "rampUp",
                                     "easeLow": 100}, 2, 9, 0.0)
    eq("easeLow flattens the low end of the ramp", eased < plain_mid, True)
    eq("easeHigh flattens the high end",
       engine._selector_weight({"start": 0, "end": 100, "shape": "rampUp",
                                "easeHigh": 100}, 6, 9, 0.0)
       > engine._selector_weight({"start": 0, "end": 100, "shape": "rampUp"}, 6, 9, 0.0), True)
    eq("no ease is the straight ramp",
       round(engine._selector_weight({"start": 0, "end": 100, "shape": "rampUp",
                                      "easeHigh": 0, "easeLow": 0}, 4, 9, 0.0), 4),
       round(plain_mid + (4 - 2) / 9.0, 4))

    # -- stencils, silhouettes, preserve underlying transparency --------------
    left_half = solid("shape", (255, 255, 255, 255),
                      transform={"anchor": [32, 32], "position": [16, 32],
                                 "scale": [50, 100], "rotation": 0, "opacity": 100})
    doc = comp([dict(left_half, blend="stencilAlpha"),
                solid("under", (255, 0, 0, 255))])
    f = engine.render_frame(doc, 0.0)
    eq("a stencil keeps what it covers", px(f, 8, 32), (255, 0, 0, 255))
    eq("a stencil cuts everything else", px(f, 56, 32)[3], 0)
    eq("the stencil layer itself is never drawn", px(f, 8, 32)[:3], (255, 0, 0))
    doc = comp([dict(left_half, blend="silhouetteAlpha"),
                solid("under", (255, 0, 0, 255))])
    f = engine.render_frame(doc, 0.0)
    eq("a silhouette cuts what it covers", px(f, 8, 32)[3], 0)
    eq("a silhouette keeps everything else", px(f, 56, 32), (255, 0, 0, 255))

    # Luma reads brightness where alpha reads coverage — a mid-grey full-frame
    # layer is 128 one way and 255 the other.
    doc = comp([solid("shape", (128, 128, 128, 255), blend="stencilLuma"),
                solid("under", (255, 0, 0, 255))])
    eq("a luma stencil reads brightness",
       px(engine.render_frame(doc, 0.0), 32, 32)[3], 128)
    doc = comp([solid("shape", (128, 128, 128, 255), blend="silhouetteLuma"),
                solid("under", (255, 0, 0, 255))])
    eq("a luma silhouette is its complement",
       px(engine.render_frame(doc, 0.0), 32, 32)[3], 127)

    # THE difference from a track matte: this reaches every layer beneath, not
    # the one directly below. Two layers under it, both cut.
    doc = comp([dict(left_half, blend="stencilAlpha"),
                solid("mid", (0, 255, 0, 255),
                      transform={"anchor": [32, 32], "position": [32, 16],
                                 "scale": [100, 50], "rotation": 0, "opacity": 100}),
                solid("bottom", (255, 0, 0, 255))])
    f = engine.render_frame(doc, 0.0)
    eq("a stencil reaches the layer below it", px(f, 8, 8)[3], 255)
    eq("a stencil reaches layers further down too", px(f, 8, 48)[3], 255)
    eq("a stencil cuts every one of them", (px(f, 56, 8)[3], px(f, 56, 48)[3]), (0, 0))
    eq("stencil modes stay out of the colour blend list",
       [m for m in engine.STENCIL_MODES if m in engine.BLEND_MODES], [])

    # Preserve underlying transparency: colour what is already there, add nothing.
    doc = comp([solid("top", (0, 0, 255, 255), preserveTransparency=True),
                dict(left_half, color=[255, 0, 0, 255])])
    f = engine.render_frame(doc, 0.0)
    eq("preserved transparency paints where the backdrop has alpha",
       px(f, 8, 32), (0, 0, 255, 255))
    eq("preserved transparency adds no alpha of its own", px(f, 56, 32)[3], 0)
    # without the switch the same document covers the frame — that is the control
    doc = comp([solid("top", (0, 0, 255, 255)), dict(left_half, color=[255, 0, 0, 255])])
    eq("without the switch the same layer covers everything",
       px(engine.render_frame(doc, 0.0), 56, 32), (0, 0, 255, 255))
    # a half-covered backdrop caps it rather than gating it
    doc = comp([solid("top", (0, 0, 255, 255), preserveTransparency=True),
                solid("under", (255, 0, 0, 255), transform={
                    "anchor": [32, 32], "position": [32, 32], "scale": [100, 100],
                    "rotation": 0, "opacity": 50})])
    eq("preserved transparency inherits the backdrop's alpha exactly",
       px(engine.render_frame(doc, 0.0), 32, 32)[3], 128)

    # -- layer styles ---------------------------------------------------------
    def styled(**styles):
        # scale 100 on purpose: the mask is in LAYER pixels, so a scaled layer
        # would put the matte edge somewhere other than where it is written
        return solid("s", (255, 255, 255, 255),
                     transform={"anchor": [32, 32], "position": [32, 32],
                                "scale": [100, 100], "rotation": 0, "opacity": 100},
                     masks=[{"id": "mk", "mode": "add",
                             "points": [[16, 16], [48, 16], [48, 48], [16, 48]],
                             "feather": 0, "opacity": 100}],
                     styles=styles)

    f = engine.render_frame(comp([styled(colorOverlay={"color": [0, 0, 255, 255],
                                                       "opacity": 100})]), 0.0)
    eq("a colour overlay recolours the layer", px(f, 32, 32)[:3], (0, 0, 255))
    eq("a colour overlay changes no coverage", px(f, 32, 32)[3], 255)
    f = engine.render_frame(comp([styled(colorOverlay={"color": [0, 0, 255, 255],
                                                       "opacity": 50})]), 0.0)
    eq("a colour overlay's opacity mixes", px(f, 32, 32)[:3], (128, 128, 255))
    eq("a disabled style does nothing",
       px(engine.render_frame(comp([styled(colorOverlay={"color": [0, 0, 255, 255],
                                                         "opacity": 100,
                                                         "enabled": False})]), 0.0),
          32, 32)[:3], (255, 255, 255))
    # animatable like everything else
    doc = comp([styled(colorOverlay={"color": [0, 0, 255, 255],
                                     "opacity": {"keys": [{"t": 0.0, "v": 0},
                                                          {"t": 1.0, "v": 100}]}})])
    eq("a style parameter is animatable",
       (px(engine.render_frame(doc, 0.0), 32, 32)[2],
        px(engine.render_frame(doc, 1.0), 32, 32)[2]), (255, 255))
    eq("an animated style parameter is somewhere else in between",
       px(engine.render_frame(doc, 0.5), 32, 32)[0] not in (0, 255), True)

    # The inside styles darken near the matte's edge and leave its middle alone —
    # which is exactly what makes them "inner".
    f = engine.render_frame(comp([styled(innerShadow={"color": [0, 0, 0, 255],
                                                      "opacity": 100, "distance": 0,
                                                      "angle": 0, "size": 8})]), 0.0)
    eq("an inner shadow darkens the inside edge", px(f, 20, 32)[0] < 250, True)
    eq("an inner shadow leaves the middle alone", px(f, 32, 32)[0], 255)
    eq("an inner shadow adds no coverage", px(f, 20, 32)[3], 255)
    eq("an inner shadow stays inside the matte", px(f, 8, 32)[3], 0)
    f = engine.render_frame(comp([styled(innerGlow={"color": [255, 0, 0, 255],
                                                    "opacity": 100, "size": 8})]), 0.0)
    eq("an inner glow tints the inside edge", px(f, 20, 32)[2] < 250, True)
    eq("an inner glow leaves the middle alone", px(f, 32, 32)[2], 255)

    if engine.effects is not None:
        stroked = dict(styled(stroke={"color": [255, 0, 0, 255], "size": 4,
                                      "position": "outside", "opacity": 100}))
        f = engine.render_frame(comp([stroked]), 0.0)
        eq("a stroke style grows the layer's coverage", px(f, 14, 32)[3], 255)
        eq("a stroke style paints its own colour", px(f, 14, 32)[:3], (255, 0, 0))
        f = engine.render_frame(comp([styled(dropShadow={"color": [0, 0, 0, 255],
                                                         "opacity": 100, "distance": 6,
                                                         "angle": 45, "size": 2})]), 0.0)
        eq("a drop shadow style falls outside the matte", px(f, 50, 50)[3] > 0, True)
        eq("a drop shadow style is dark", px(f, 50, 50)[0] < 40, True)
        f = engine.render_frame(comp([styled(outerGlow={"color": [0, 255, 0, 255],
                                                        "opacity": 100, "size": 6})]), 0.0)
        eq("an outer glow style reaches outside the matte", px(f, 12, 32)[3] > 0, True)
        eq("an outer glow style carries its colour", px(f, 12, 32)[1] > px(f, 12, 32)[2], True)
        # order: the shadow lands BEHIND an overlay, not on top of it
        f = engine.render_frame(comp([styled(
            colorOverlay={"color": [0, 0, 255, 255], "opacity": 100},
            dropShadow={"color": [0, 0, 0, 255], "opacity": 100, "distance": 6,
                        "angle": 45, "size": 2})]), 0.0)
        eq("a colour overlay is under the drop shadow, not over it",
           (px(f, 32, 32)[2], px(f, 50, 50)[2] < 40), (255, True))
        # BEFORE the transform is the load-bearing half of the ordering: the
        # style is drawn in the layer's own pixels and then carried through the
        # transform, so halving the layer halves the stroke on screen. Run styles
        # after the transform and it stays 4px, which is the wrong picture.
        thick = dict(styled(stroke={"color": [255, 0, 0, 255], "size": 4,
                                    "position": "outside", "opacity": 100}))
        wide = engine.render_frame(comp([thick]), 0.0)
        thick["transform"] = {"anchor": [32, 32], "position": [32, 32],
                              "scale": [50, 50], "rotation": 0, "opacity": 100}
        thin = engine.render_frame(comp([thick]), 0.0)
        red_px = lambda f: int(((f[32, :, 0] > 0.5) & (f[32, :, 2] < 0.5)  # noqa: E731
                                & (f[32, :, 3] > 0.5)).sum())
        eq("a style is carried through the transform, not painted over it",
           red_px(thin) < red_px(wide), True)
        eq("the scaled stroke is still there, just smaller", red_px(thin) > 0, True)
    else:
        # documented fallback: a style effects.py owns is a no-op without it
        base = engine.render_frame(comp([styled()]), 0.0)
        for name, spec in (("stroke", {"size": 4}), ("dropShadow", {"distance": 6}),
                           ("outerGlow", {"size": 6})):
            eq(f"the {name} style is a no-op without effects.py",
               int(np.abs(engine.render_frame(comp([styled(**{name: spec})]), 0.0)
                          - base).max() * 255), 0)
        eq("styles are still ordered without effects.py",
           list(engine.STYLE_ORDER)[0], "colorOverlay")
        eq("the drop shadow still sits at the back of the order",
           list(engine.STYLE_ORDER)[-1], "dropShadow")
        eq("every style in the order has an implementation",
           sorted(engine.STYLES) == sorted(engine.STYLE_ORDER), True)
        eq("a colour overlay still works without effects.py",
           px(engine.render_frame(comp([styled(colorOverlay={"color": [0, 0, 255, 255],
                                                             "opacity": 100})]), 0.0),
              32, 32)[:3], (0, 0, 255))
        # the ordering half of the contract holds with or without the registry
        scaled = styled(colorOverlay={"color": [0, 0, 255, 255], "opacity": 100})
        scaled["transform"] = {"anchor": [32, 32], "position": [32, 32],
                               "scale": [50, 50], "rotation": 0, "opacity": 100}
        f = engine.render_frame(comp([scaled]), 0.0)
        eq("a style is carried through the transform, not painted over it",
           px(f, 32, 32)[:3], (0, 0, 255))
        eq("the transform still moved the styled layer", px(f, 20, 32)[3], 0)

    # -- time remapping and frame blending ------------------------------------
    # The ramp clip's red channel counts its frames, so reading red back IS
    # reading which source frame the remap chose.
    remapped = dict(vid, end=1.0, timeRemap={"keys": [
        {"t": 0.0, "v": 20 / 24.0, "ease": "linear"}, {"t": 1.0, "v": 0.0}]})
    doc = comp([remapped], fps=24.0, duration=1.0)
    eq("a time remap reads the frame its curve names",
       abs(px(engine.render_frame(doc, 0.0), 32, 32)[0] - 200) <= 8, True)
    eq("a time remap runs the source wherever the curve goes",
       px(engine.render_frame(doc, 0.99), 32, 32)[0] < 8, True)
    eq("a time remap is sampled, not stepped",
       abs(px(engine.render_frame(doc, 0.5), 32, 32)[0] - 100) <= 12, True)
    # It REPLACES the inPoint/timeScale rule rather than stacking with it.
    ignored = dict(remapped, inPoint=0.5, timeScale=-3.0)
    eq("a time remap overrides inPoint and timeScale",
       abs(px(engine.render_frame(comp([ignored], fps=24.0, duration=1.0), 0.0), 32, 32)[0]
           - 200) <= 8, True)
    # A hold key holds the frame — the reason anyone reaches for time remapping.
    frozen = dict(vid, end=1.0, timeRemap={"keys": [
        {"t": 0.0, "v": 10 / 24.0, "ease": "hold"}, {"t": 0.9, "v": 0.0}]})
    doc = comp([frozen], fps=24.0, duration=1.0)
    eq("a held remap key freezes the source frame",
       px(engine.render_frame(doc, 0.0), 32, 32)[0],
       px(engine.render_frame(doc, 0.8), 32, 32)[0])
    # An empty or constant timeRemap is not a track and must not hijack the rule.
    eq("a timeRemap with no keys leaves the normal rule alone",
       engine._source_time(dict(vid, timeRemap={"keys": []}, start=0.0, inPoint=0.25), 0.0),
       0.25)

    # Frame blending: a source time landing between two frames crossfades them
    # instead of snapping, and draft skips the second decode.
    slow = dict(vid, end=1.0, timeScale=0.5, frameBlend="mix")
    mixed = px(engine.render_frame(comp([slow], fps=24.0, duration=1.0), 5 / 24.0), 32, 32)[0]
    snapped = px(engine.render_frame(comp([dict(slow, frameBlend="off")], fps=24.0,
                                          duration=1.0), 5 / 24.0), 32, 32)[0]
    drafted = px(engine.render_frame(comp([slow], fps=24.0, duration=1.0), 5 / 24.0,
                                     draft=True), 32, 32)[0]
    eq("frame mix lands between the two source frames", mixed != snapped, True)
    eq("frame mix lands between them, not outside", 20 <= mixed <= 30, True)
    eq("draft skips frame blending", drafted, snapped)

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

# ── auto-orient ──────────────────────────────────────────────────────────────
# AE's "orient along path": the layer's rotation becomes the direction of the
# position derivative, and the layer's own rotation composes ON TOP. The
# reference frame is pinned by the existing "rotation turns clockwise on
# screen" assertion above: y points down, +90 takes +x to +y, so moving along
# +x is 0 with the layer upright and moving DOWN is +90.

print("\nvfx auto-orient\n")


def ao_layer(pos_prop, rotation=0, auto="alongPath", lid="ao", **over):
    lay = {"id": lid, "name": lid, "type": "solid", "color": [255, 0, 0, 255],
           "transform": {"anchor": [0, 0], "position": pos_prop,
                         "scale": [100, 100], "rotation": rotation, "opacity": 100}}
    if auto is not None:
        lay["autoOrient"] = auto
    lay.update(over)
    return lay


def heading(lay, t):
    """Where the layer's local +x points on screen, in degrees 0..360."""
    w = interp.world_matrix(lay, {lay["id"]: lay}, t)
    return float(np.degrees(np.arctan2(w[1, 0], w[0, 0]))) % 360.0


ao_right = {"keys": [{"t": 0.0, "v": [0, 100]}, {"t": 2.0, "v": [200, 100]}]}
ao_down = {"keys": [{"t": 0.0, "v": [100, 0]}, {"t": 2.0, "v": [100, 200]}]}

eq("moving along +x is 0 — the layer stays upright",
   round(heading(ao_layer(ao_right), 1.0), 6), 0.0)
# upright means the local +y axis still points down the screen, not merely
# that +x points along the path — a mirrored basis would pass the line above
_w = interp.world_matrix(ao_layer(ao_right), {"ao": ao_layer(ao_right)}, 1.0)
eq("...and its +y axis still points down the screen",
   [round(v, 6) for v in (_w[0, 1], _w[1, 1])], [0.0, 1.0])
eq("moving down is +90 (y-down comp space, clockwise like rotation itself)",
   round(heading(ao_layer(ao_down), 1.0), 6), 90.0)
eq("the layer's own rotation composes ADDITIVELY on top of the path's",
   round(heading(ao_layer(ao_down, rotation=30), 1.0), 6), 120.0)
eq("a static position orients nothing — the switch alone moves no pixel",
   round(heading(ao_layer([50, 60], rotation=15), 1.0), 6), 15.0)

# A circle out of four bezier keys (the 0.5523 magic handle): the tangent at
# each quarter-gap midpoint has a closed form, and the derivative must follow
# the CURVE there, not the chords — a chord direction is off by 45 degrees.
_r, _cx, _cy = 100.0, 500.0, 500.0
_k = 0.5522847498 * _r
ao_circle = {"keys": [
    {"t": 0.0, "v": [_cx + _r, _cy], "to": [0, _k], "ti": [0, -_k]},
    {"t": 1.0, "v": [_cx, _cy + _r], "to": [-_k, 0], "ti": [_k, 0]},
    {"t": 2.0, "v": [_cx - _r, _cy], "to": [0, -_k], "ti": [0, _k]},
    {"t": 3.0, "v": [_cx, _cy - _r], "to": [_k, 0], "ti": [-_k, 0]},
    {"t": 4.0, "v": [_cx + _r, _cy], "to": [0, _k], "ti": [0, -_k]},
]}
for _t, _want in [(0.5, 135.0), (1.5, 225.0), (2.5, 315.0), (3.5, 45.0)]:
    _got = heading(ao_layer(ao_circle), _t)
    _err = abs((_got - _want + 180.0) % 360.0 - 180.0)
    eq(f"a circular path's tangent at t={_t} is within 2 degrees ({_want})",
       _err <= 2.0, True)

# Hold keys: zero motion between jumps keeps the LAST orientation; the jump
# instant itself turns along the jump (the central difference spans it), and
# past the final key the layer stays facing its last motion.
ao_held = {"keys": [
    {"t": 0.0, "v": [0, 0]},
    {"t": 1.0, "v": [100, 0], "ease": "hold"},
    {"t": 2.0, "v": [100, 100]},
]}
eq("during motion the heading is the motion's", round(heading(ao_layer(ao_held), 0.5), 6), 0.0)
eq("a hold segment keeps the last orientation", round(heading(ao_layer(ao_held), 1.5), 6), 0.0)
eq("the jump instant turns along the jump", round(heading(ao_layer(ao_held), 2.0), 6), 90.0)
eq("after the last key the layer keeps facing its last motion",
   round(heading(ao_layer(ao_held), 3.0), 6), 90.0)
# the documented choice for the very first instant: before the layer has ever
# moved it already faces the way it is about to leave
ao_late = {"keys": [{"t": 1.0, "v": [0, 0]}, {"t": 2.0, "v": [0, 50]}]}
eq("before the first key the layer faces the way it will leave",
   round(heading(ao_layer(ao_late), 0.0), 6), 90.0)

# The regression pin: a layer WITHOUT the switch never reaches the new code,
# and "off" is the same absence — byte-identical frames, not merely close.
_ao_diag = {"keys": [{"t": 0.0, "v": [10, 10]}, {"t": 1.0, "v": [54, 54]}]}


def ao_solid(auto, pos, rotation=8):
    return comp([ao_layer(pos, rotation=rotation, auto=auto, width=40, height=8,
                          transform={"anchor": [20, 4], "position": pos,
                                     "scale": [100, 100], "rotation": rotation,
                                     "opacity": 100})])


_f_absent = engine.render_frame(ao_solid(None, _ao_diag), 0.5)
_f_off = engine.render_frame(ao_solid("off", _ao_diag), 0.5)
_f_on = engine.render_frame(ao_solid("alongPath", _ao_diag), 0.5)
eq("autoOrient off renders byte-identical to the switch being absent",
   _f_off.tobytes() == _f_absent.tobytes(), True)
eq("alongPath on a diagonal mover changes the frame",
   _f_on.tobytes() == _f_off.tobytes(), False)
# pure +x motion is heading 0.0 exactly, so composing it adds literally
# nothing — the strongest cheap statement that the compose rule is "+"
_ao_flat = {"keys": [{"t": 0.0, "v": [10, 32]}, {"t": 1.0, "v": [54, 32]}]}
eq("alongPath over pure +x motion is byte-identical to off",
   engine.render_frame(ao_solid("alongPath", _ao_flat), 0.5).tobytes()
   == engine.render_frame(ao_solid("off", _ao_flat), 0.5).tobytes(), True)

# The pixels, not just the matrix: a wide flat solid moving DOWN renders tall.
_ao_drop = {"keys": [{"t": 0.0, "v": [32, 10]}, {"t": 1.0, "v": [32, 54]}]}
_f_tall = engine.render_frame(ao_solid("alongPath", _ao_drop, rotation=0), 0.5)
eq("a 40x8 solid moving down stands vertical: covered above and below",
   (px(_f_tall, 32, 20)[3], px(_f_tall, 32, 44)[3]), (255, 255))
eq("...and empty to its left and right",
   (px(_f_tall, 16, 32)[3], px(_f_tall, 48, 32)[3]), (0, 0))

# An expression drives position through the SAME evaluator the render reads,
# so the derivative follows what is actually drawn — here, straight down.
_ao_expr = {"value": [32, 32], "expr": "value + [0, (time - 1) * 20]"}
_f_expr = engine.render_frame(ao_solid("alongPath", _ao_expr, rotation=0), 1.0)
eq("an expression-driven position orients the layer along its own motion",
   (px(_f_expr, 32, 20)[3], px(_f_expr, 32, 44)[3],
    px(_f_expr, 16, 32)[3], px(_f_expr, 48, 32)[3]), (255, 255, 0, 0))

# Motion blur samples the transform at sub-times, and auto-orient rides it:
# the blurred frame must differ from both the unblurred one and blurred-off.
_mb = comp([ao_layer(_ao_diag, auto="alongPath", motionBlur=True, width=40, height=8,
                     transform={"anchor": [20, 4], "position": _ao_diag,
                                "scale": [100, 100], "rotation": 0, "opacity": 100})],
           motionBlur={"enabled": True, "shutter": 360, "samples": 8})
_f_mb_on = engine.render_frame(_mb, 0.5)
_mb_off = json.loads(json.dumps(_mb))
_mb_off["layers"][0]["autoOrient"] = "off"
eq("motion blur over an auto-oriented layer still sees the orientation",
   _f_mb_on.tobytes() == engine.render_frame(_mb_off, 0.5).tobytes(), False)
eq("...and the blur itself is live (differs from the sharp frame)",
   _f_mb_on.tobytes() == _f_on.tobytes(), False)

# ── auto-orient in 3D ────────────────────────────────────────────────────────
# The basis: local +x onto the tangent, roll fixed by the comp plane's normal,
# so planar 3D motion matches the 2D result exactly — including moving LEFT,
# which must be a 180 turn about z and never a mirror.

_b = engine._auto_orient_basis([1.0, 0.0, 0.0])
eq("3D basis for +x motion is the identity", np.allclose(_b, np.eye(3)), True)
_b = engine._auto_orient_basis([0.0, 1.0, 0.0])
eq("3D basis for downward motion is exactly Rz(90)",
   np.allclose(_b, engine._rot3(0, 0, 90)), True)
_b = engine._auto_orient_basis([-1.0, 0.0, 0.0])
eq("3D basis for leftward motion is Rz(180), not a mirror",
   np.allclose(_b, engine._rot3(0, 0, 180)), True)
eq("...with determinant +1 (a rotation, never a flip)",
   round(float(np.linalg.det(_b)), 6), 1.0)
_b = engine._auto_orient_basis([0.0, 0.0, 1.0])
eq("a dive along +z turns the layer edge-on: local +x points into the screen",
   [round(v, 6) for v in _b[:, 0]], [0.0, 0.0, 1.0])

_ao_zpath = {"keys": [{"t": 0.0, "v": [100, 100, 0]}, {"t": 2.0, "v": [100, 100, 400]}]}
_lay3 = {"id": "z3", "name": "z3", "type": "solid", "threeD": True,
         "autoOrient": "alongPath", "color": [255, 0, 0, 255],
         "transform": {"anchor": [0, 0, 0], "position": _ao_zpath,
                       "scale": [100, 100, 100], "rotation": 0, "opacity": 100}}
_m43 = engine.world_matrix4(_lay3, {"z3": _lay3}, 1.0)
eq("world_matrix4 carries the 3D orientation (x axis along the z tangent)",
   [round(v, 6) for v in _m43[:3, 0]], [0.0, 0.0, 1.0])
# rotationZ composes INSIDE the path orientation, an offset on top of it
_lay3r = json.loads(json.dumps(_lay3))
_lay3r["transform"]["position"] = {"keys": [{"t": 0.0, "v": [0, 0, 0]},
                                            {"t": 2.0, "v": [0, 200, 0]}]}
_lay3r["transform"]["rotationZ"] = 30
_m43r = engine.world_matrix4(_lay3r, {"z3": _lay3r}, 1.0)
eq("3D planar motion with rotationZ 30 composes to 120, same as 2D",
   round(float(np.degrees(np.arctan2(_m43r[1, 0], _m43r[0, 0]))), 4), 120.0)

# ── the viewport overlay inherits it ─────────────────────────────────────────
# The gizmo tripod is drawn from world_matrix4's columns, so an auto-oriented
# layer's axes must show the ORIENTED frame — an upright tripod on a turned
# layer is a gizmo that lies about every axis drag.
from vfx import viewport  # noqa: E402

_ov_doc = comp([ao_layer(_ao_drop, auto="alongPath", width=40, height=8,
                         transform={"anchor": [20, 4], "position": _ao_drop,
                                    "scale": [100, 100], "rotation": 0,
                                    "opacity": 100})])
_ov = viewport.cmd_overlay({"comp": _ov_doc, "t": 0.5, "layerId": "ao"})
_axes = {a["axis"]: a for a in _ov["selected"]["axes"]}
_dx = _axes["x"]["to"][0] - _axes["x"]["from"][0]
_dy = _axes["x"]["to"][1] - _axes["x"]["from"][1]
eq("the gizmo's x arm points DOWN for a layer auto-oriented down a path",
   (abs(_dx) < 1.0, _dy > 30.0), (True, True))
eq("...and its world direction is the oriented +x axis",
   [round(v, 4) for v in _axes["x"]["world"][:2]], [0.0, 1.0])


# ── the planar compositing core ──────────────────────────────────────────────
# _over, the blend maths and _mask_alpha were rewritten to work on contiguous
# (H, W) planes instead of on strided `rgba[..., :3]` views. The rewrite is
# supposed to be bit-identical, so the assertions worth having are the ones a
# plausible planar refactor breaks WITHOUT changing the obvious cases: an
# aliased source, a branch that only fires on an exactly-opaque backdrop, a
# cache that outlives the thing it caches.

print("\nvfx planar compositing core\n")

_SRC = np.zeros((4, 4, 4), np.float32)
_SRC[...] = (0.8, 0.2, 0.4, 0.5)

# Blending against NOTHING must yield the source, in every mode. That is the
# (1 - ab) term in the source-over formula and it is the single property that
# separates a comp's transparent backdrop from the image compositor's opaque
# one — get it wrong and every multiply layer over empty space goes black.
_bad = [m for m in engine.BLEND_MODES
        if not np.allclose(
            (lambda a: (engine._over(a, engine.Tile(_SRC, 0, 0), m), a)[1])(
                np.zeros((4, 4, 4), np.float32)), _SRC, atol=1e-6)]
eq("every blend mode over a transparent backdrop is the source", _bad, [])

# The opaque-backdrop shortcut skips the un-premultiplying divide entirely, so
# it is a whole separate arithmetic path that fires only when min(alpha) is
# within EPS of 1. A backdrop one thousandth off opaque takes the general path
# and the two must still agree.
_opq = np.zeros((4, 4, 4), np.float32)
_opq[...] = (0.1, 0.6, 0.3, 1.0)
_near = _opq.copy()
_near[..., 3] = 0.999
engine._over(_opq, engine.Tile(_SRC, 0, 0), "normal")
engine._over(_near, engine.Tile(_SRC, 0, 0), "normal")
eq("the opaque-backdrop shortcut agrees with the general source-over",
   bool(np.allclose(_opq[..., :3], _near[..., :3], atol=1e-3)), True)

# Source-over's alpha law, which no blend mode may touch.
_acc = np.zeros((4, 4, 4), np.float32)
_acc[...] = (0.2, 0.2, 0.2, 0.25)
engine._over(_acc, engine.Tile(_SRC, 0, 0), "overlay")
eq("a blend mode leaves the source-over alpha law alone",
   round(float(_acc[0, 0, 3]), 6), round(0.5 + 0.25 * 0.5, 6))

# A document is free to carry any string in `blend`, and imagetools._blend hands
# `top` straight back for one it does not recognise — so an unknown mode has to
# land on plain source-over. That is worth an assertion twice over, because
# "normal" now takes a SHORTER path than the blend dispatch does (it never
# de-interleaves the backdrop) and this is the one case where the two paths
# composite the same pixels and can be compared for it.
for _bg_a in (1.0, 0.3):
    _base = np.zeros((4, 4, 4), np.float32)
    _base[...] = (0.1, 0.6, 0.3, _bg_a)
    _plain, _weird = _base.copy(), _base.copy()
    engine._over(_plain, engine.Tile(_SRC, 0, 0), "normal")
    engine._over(_weird, engine.Tile(_SRC, 0, 0), "no-such-mode")
    eq(f"an unrecognised blend mode is plain source-over (backdrop a={_bg_a})",
       bool(np.array_equal(_plain, _weird)), True)
# And nothing composited may write into the tile it was handed.
_keep = _SRC.copy()
engine._over(np.full((4, 4, 4), 0.5, np.float32), engine.Tile(_SRC, 0, 0), "hue")
eq("compositing leaves the source array untouched",
   bool(np.array_equal(_SRC, _keep)), True)

# Motion blur averages PREMULTIPLIED. Straight-alpha averaging of an opaque red
# and a transparent black gives half-alpha DARK red; the answer is half-alpha
# red, and nothing about that is visible in a test that only checks alpha.
_avg = engine._average_tiles([
    engine.Tile(np.array([[[1.0, 0.0, 0.0, 1.0]]], np.float32), 0, 0),
    engine.Tile(np.array([[[0.0, 0.0, 0.0, 0.0]]], np.float32), 0, 0)])
eq("averaging tiles keeps the colour of the covered sample",
   [round(float(v), 4) for v in _avg.rgba[0, 0]], [1.0, 0.0, 0.0, 0.5])

# ── the mask raster cache ────────────────────────────────────────────────────
# _mask_alpha keys its cache on the RESOLVED values, not on a guess about
# whether the mask is animated, so these are the cases that would have needed
# such a guess to be right.

def _masked(mask, t=0.0, scale=1.0):
    return engine.render_frame(
        comp([solid("M", (255, 255, 255, 255), masks=[mask])]), t, scale=scale)


_BOX = [[8, 8], [56, 8], [56, 56], [8, 56]]
_still = {"id": "m", "mode": "add", "points": _BOX, "feather": 6}
eq("a static mask renders identically whenever it is asked for",
   bool(np.array_equal(_masked(_still, 0.0), _masked(_still, 3.0))), True)
eq("a mask of a different shape does not inherit the cached one",
   bool(np.array_equal(
       _masked(_still),
       _masked({"id": "m", "mode": "add", "points": [[8, 8], [40, 8], [40, 40], [8, 40]],
                "feather": 6}))), False)
eq("the same mask at another scale is another raster",
   _masked(_still).shape != _masked(_still, scale=0.5).shape, True)
for _prop, _track in (("feather", {"keys": [{"t": 0, "v": 0}, {"t": 2, "v": 24}]}),
                      ("expand", {"keys": [{"t": 0, "v": 0}, {"t": 2, "v": 10}]}),
                      ("opacity", {"keys": [{"t": 0, "v": 100}, {"t": 2, "v": 20}]})):
    _anim = {"id": "m", "mode": "add", "points": _BOX, _prop: _track}
    eq(f"a keyframed mask {_prop} still moves with time",
       bool(np.array_equal(_masked(_anim, 0.0), _masked(_anim, 2.0))), False)
_inv = dict(_still, invert=True)
eq("inverting a mask is not the same raster as not inverting it",
   bool(np.array_equal(_masked(_still), _masked(_inv))), False)

# ── the raster cache and the buffer that comes out of it ─────────────────────
# _layer_pixels hands back CACHED arrays for stills and for text, and the layer
# opacity step now scales alpha in place when — and only when — some earlier
# step has already replaced that array with one this render made. Get the
# bookkeeping wrong and the first layer's opacity is baked into the cache, so
# the SECOND comp to ask for the same glyphs renders dim.


def _typed(lid, op):
    return {"id": lid, "name": lid, "type": "text", "start": 0.0, "end": 4.0,
            "blend": "normal", "enabled": True,
            "text": {"content": "AA", "size": 28, "color": [255, 255, 255, 255]},
            "transform": {"anchor": [32, 32], "position": [32, 32],
                          "scale": [100, 100], "rotation": 0, "opacity": op}}


_dim = engine.render_frame(comp([_typed("A", 50)]), 0.0)
_full = engine.render_frame(comp([_typed("B", 100)]), 0.0)
eq("a half-opacity layer does not dim the raster the next one reads",
   float(_full[..., 3].max()) > 0.99, True)
eq("...and the half-opacity layer really was half",
   0.4 < float(_dim[..., 3].max()) < 0.6, True)
eq("re-rendering the dimmed layer gives the same frame again",
   bool(np.array_equal(_dim, engine.render_frame(comp([_typed("A", 50)]), 0.0))),
   True)
# Two layers off ONE cached raster inside a single frame, which is where an
# in-place opacity would show up as the top layer wearing the bottom's alpha.
_pair = engine.render_frame(comp([_typed("A", 50), _typed("B", 100)]), 0.0)
eq("two layers sharing a raster keep their own opacities",
   float(_pair[..., 3].max()) > 0.99, True)

# ── audio ────────────────────────────────────────────────────────────────────
# The soundtrack of a movie render. Synthetic media like everything else here:
# a sine encoded through PyAV, so the expected RMS has a closed form and the
# suite still runs anywhere the venv does.

print("\nvfx audio mix\n")

with tempfile.TemporaryDirectory() as _atmp:
    _rate = 48000
    _amp = 0.5
    _n = _rate * 2
    _t = np.arange(_n) / _rate
    _sine = (_amp * np.sin(2 * np.pi * 220 * _t)).astype(np.float32)
    _wav = os.path.join(_atmp, "tone.wav")
    _ac = av.open(_wav, "w")
    _ast = _ac.add_stream("pcm_s16le", rate=_rate)
    _ast.layout = "stereo"
    _i16 = np.clip(np.round(np.stack([_sine, _sine]).T.reshape(1, -1) * 32768.0),
                   -32768, 32767).astype(np.int16)
    for _i in range(0, _n, _rate):
        _blk = np.ascontiguousarray(_i16[:, _i * 2:(_i + _rate) * 2])
        _fr = av.AudioFrame.from_ndarray(_blk, format="s16", layout="stereo")
        _fr.sample_rate = _rate
        for _pkt in _ast.encode(_fr):
            _ac.mux(_pkt)
    for _pkt in _ast.encode(None):
        _ac.mux(_pkt)
    _ac.close()

    def _acomp(layers, dur=2.0):
        return {"slug": "a", "width": 64, "height": 48, "fps": 12, "duration": dur,
                "bg": [0, 0, 0, 255], "layers": layers}

    def _alayer(**kw):
        base = {"id": "au", "type": "audio", "src": _wav,
                "start": 0.0, "end": 2.0, "inPoint": 0.0, "timeScale": 1}
        base.update(kw)
        return base

    def _rms(bus):
        return float(np.sqrt(np.mean(np.square(bus, dtype=np.float64))))

    _want = _amp / np.sqrt(2)                          # RMS of a sine, exactly

    _bus = engine.render_audio(_acomp([_alayer()]), 0.0, 2.0)
    eq("an audio layer mixes its file at unity gain",
       abs(_rms(_bus) - _want) < 0.01, True)
    eq("...at the documented rate and length", _bus.shape, (2, 96000))

    eq("a comp with no audio-bearing layer mixes to None — the movie then "
       "muxes exactly as before",
       engine.render_audio(_acomp([{"id": "s", "type": "solid",
                                    "start": 0, "end": 2}]), 0.0, 2.0), None)

    eq("the audio switch (audio: false) silences the only source back to None",
       engine.render_audio(_acomp([_alayer(audio=False)]), 0.0, 2.0), None)

    # start offsets the sound exactly as it offsets the picture
    _off = engine.render_audio(_acomp([_alayer(start=1.0)]), 0.0, 2.0)
    eq("a layer starting at 1s is silent for its first second",
       float(np.abs(_off[:, :47990]).max()), 0.0)
    eq("...and sounding after it", _rms(_off[:, 48010:]) > 0.05, True)

    # inPoint trims the source, sample-exactly on the fast path
    _trim = engine.render_audio(_acomp([_alayer(inPoint=0.5)]), 0.0, 1.0)
    _expect = _sine[int(0.5 * _rate):int(1.5 * _rate)]
    eq("inPoint trims the source sample-exactly",
       float(np.abs(_trim[0] - _expect).max()) < 2e-4, True)

    # a constant level in dB is a gain of 10^(dB/20)
    _quiet = engine.render_audio(_acomp([_alayer(audioLevels=-20)]), 0.0, 2.0)
    eq("audioLevels -20 dB is one tenth the amplitude",
       abs(_rms(_bus) / _rms(_quiet) - 10.0) < 0.1, True)

    # KEYFRAMED levels follow the curve, not a snapshot of it
    # -48 is the floor of AUDIO_LEVELS_RANGE — a lower key is clamped to it,
    # so the expectation is 10^(-48/20), not silence
    _fade = engine.render_audio(_acomp([_alayer(
        audioLevels={"keys": [{"t": 0.0, "v": 0}, {"t": 1.0, "v": 0},
                              {"t": 1.05, "v": -48}]})]), 0.0, 2.0)
    eq("keyframed audioLevels actually fade (first second loud)",
       _rms(_fade[:, :45000]) > 0.3, True)
    eq("...second second at the -48 dB floor, followed not snapshotted",
       abs(_rms(_fade[:, 55000:]) / _rms(_fade[:, :45000]) - 10 ** (-48 / 20)) < 1e-3,
       True)

    # timeScale resamples: 2x consumes two source seconds in one comp second
    _fast = engine.render_audio(_acomp([_alayer(end=1.0, timeScale=2)]), 0.0, 2.0)
    eq("timeScale 2 keeps the energy in the layer's window",
       abs(_rms(_fast[:, :48000]) - _want) < 0.01, True)
    eq("...and silence after its end", float(np.abs(_fast[:, 48100:]).max()), 0.0)

    # the refusals, both loud and both naming the way out
    _refused = ""
    try:
        engine.render_audio(_acomp([_alayer(
            timeRemap={"keys": [{"t": 0, "v": 0}, {"t": 2, "v": 1}]})]), 0.0, 2.0)
    except ValueError as _e:
        _refused = str(_e)
    eq("timeRemap over live audio is refused, naming the audio switch",
       "audio" in _refused and "switch" in _refused, True)

    _broken = ""
    try:
        _png = os.path.join(_atmp, "not_audio.png")
        Image.fromarray(np.zeros((8, 8, 4), np.uint8), "RGBA").save(_png)
        engine.render_audio(_acomp([_alayer(src=_png)]), 0.0, 2.0)
    except Exception as _e:                            # noqa: BLE001
        _broken = str(_e)
    eq("an audio layer over a soundless file is refused, not silently skipped",
       "no audio stream" in _broken or "could not" in _broken.lower()
       or _broken != "", True)

    # nesting: a child comp's mix arrives through the parent layer's trim and
    # level — and a second level of nesting changes nothing but the path
    _kid = _acomp([_alayer()])
    _kid["slug"] = "kid"
    _par = _acomp([{"id": "c", "type": "comp", "src": "kid", "start": 0.5,
                    "end": 1.5, "inPoint": 0.0, "timeScale": 1,
                    "audioLevels": -6.0}])
    _par["slug"] = "par"
    _par["comps"] = {"kid": _kid}
    _nest = engine.render_audio(_par, 0.0, 2.0)
    eq("child audio is silent before the parent layer's window",
       float(np.abs(_nest[:, :23900]).max()), 0.0)
    eq("...present inside it, through the parent's -6 dB",
       abs(_rms(_nest[:, 26000:70000]) / _want - 10 ** (-6 / 20)) < 0.02, True)
    eq("...and silent after it", float(np.abs(_nest[:, 76000:]).max()), 0.0)

    _grand = _acomp([{"id": "g", "type": "comp", "src": "par",
                      "start": 0.0, "end": 2.0, "inPoint": 0.0, "timeScale": 1}])
    _grand["comps"] = {"par": _par, "kid": _kid}
    _deep = engine.render_audio(_grand, 0.0, 2.0)
    eq("two levels of nesting pass the same samples through",
       float(np.abs(_deep - _nest).max()) < 1e-4, True)

    # the muxed render: the movie carries the track; a silent comp carries none
    _mv = os.path.join(_atmp, "with_audio.mp4")
    _r = engine.cmd_render({"comp": _acomp([_alayer()]), "out": _mv, "from": 0,
                            "to": 2, "format": "mp4", "codec": "libx264",
                            "progressEvery": 0})
    _chk = av.open(_mv)
    eq("a rendered movie with audio layers carries ONE audio stream",
       len(_chk.streams.audio), 1)
    _adur = float(_chk.streams.audio[0].duration * _chk.streams.audio[0].time_base)
    eq("...as long as the render range", abs(_adur - 2.0) < 0.15, True)
    _chk.close()
    eq("...and cmd_render reports the mix it made",
       isinstance(_r.get("audio"), dict) and _r["audio"]["rmsDb"] is not None, True)

    _silent = os.path.join(_atmp, "no_audio.mp4")
    engine.cmd_render({"comp": _acomp([{"id": "s", "type": "solid", "start": 0,
                                        "end": 2}]), "out": _silent, "from": 0,
                       "to": 2, "format": "mp4", "codec": "libx264",
                       "progressEvery": 0})
    _chk = av.open(_silent)
    eq("a silent comp renders with NO audio stream at all",
       len(_chk.streams.audio), 0)
    _chk.close()

    # the pixel path: an audio layer paints nothing and breaks nothing
    _frame = engine.render_frame(_acomp([_alayer(),
                                         {"id": "s", "type": "solid", "start": 0,
                                          "end": 2, "color": [255, 0, 0, 255]}]), 0.5)
    eq("an audio layer paints nothing (the solid beneath shows through)",
       float(_frame[..., 0].max()) > 0.9, True)


# ── serve mode ───────────────────────────────────────────────────────────────
# One process, many jobs. The point is that importing numpy/PIL/cv2/PyAV costs
# ~400 ms and the file-driven modes pay it per frame — but a process that
# outlives a frame also outlives its caches, and every assertion below is about
# something that only becomes possible once it does.

print("\nvfx serve mode\n")


def _serve(*requests):
    """Drive serve() over StringIO and return its replies, handshake first."""
    inp = io.StringIO("".join(json.dumps(r) + "\n" for r in requests))
    out = io.StringIO()
    code = engine.serve(inp, out)
    return code, [json.loads(ln) for ln in out.getvalue().splitlines() if ln.strip()]


with tempfile.TemporaryDirectory() as _stmp:
    _still = os.path.join(_stmp, "plate.png")
    _shot = os.path.join(_stmp, "out.png")
    Image.fromarray(np.full((16, 16, 4), (200, 30, 40, 255), np.uint8), "RGBA").save(_still)
    _doc = comp([{"id": "P", "name": "P", "type": "image", "src": _still,
                  "start": 0.0, "end": 4.0, "blend": "normal", "enabled": True,
                  "transform": {"anchor": [8, 8], "position": [32, 32],
                                "scale": [100, 100], "rotation": 0, "opacity": 100}}])
    _job = {"comp": _doc, "t": 0.0, "scale": 1.0, "out": _shot}

    _code, _out = _serve({"id": 1, "cmd": "frame", "job": _job},
                         {"id": 2, "cmd": "stats"},
                         {"cmd": "shutdown"})
    eq("serve announces itself before any job", _out[0].get("ready"), True)
    eq("serve renders a frame", (_out[1].get("ok"), _out[1].get("id")), (True, 1))
    eq("serve reports what its caches hold", _out[2]["counts"]["images"], 1)
    eq("serve exits clean on shutdown", _code, 0)

    # A bad job is one line of bad news, not the end of the session — that is the
    # whole difference between a supervisor restarting a process and a queue
    # stalling behind one malformed comp.
    _code, _out = _serve({"id": 1, "cmd": "frame", "job": {"comp": {}, "t": 0.0}},
                         {"id": 2, "cmd": "nonsense"},
                         "not json at all",
                         {"id": 4, "cmd": "frame", "job": _job})
    eq("a job that raises answers false and keeps the session",
       (_out[1]["ok"], _out[1]["id"]), (False, 1))
    eq("an unknown cmd is refused by name", "nonsense" in _out[2]["error"], True)
    eq("a line that is not JSON does not end the session", _out[3]["ok"], False)
    eq("...and the next real job still renders", _out[4]["ok"], True)
    eq("running out of stdin exits clean", _code, 0)

    # THE hazard of a long-lived compositor: it caches decoded footage by path,
    # so a file replaced on disk renders as its old self forever. A process that
    # lives for one frame cannot have this bug, which is why nothing else here
    # tests it — and why the replacement has to happen BETWEEN two jobs of ONE
    # session. serve() iterates its input, so a generator is the whole rig.
    _after = os.path.join(_stmp, "after.png")

    def _swap_midway():
        yield json.dumps({"id": 1, "cmd": "frame", "job": _job}) + "\n"
        Image.fromarray(np.full((16, 16, 4), (10, 220, 60, 255), np.uint8),
                        "RGBA").save(_still)
        # a repaint of the same size can land on the same mtime tick, and the
        # stamp is (mtime, size) — nudge it so this tests the eviction
        _bump = os.path.getmtime(_still) + 5
        os.utime(_still, (_bump, _bump))
        yield json.dumps({"id": 2, "cmd": "frame",
                          "job": dict(_job, out=_after)}) + "\n"

    engine.serve(_swap_midway(), io.StringIO())
    _was = np.asarray(Image.open(_shot).convert("RGBA"))[32, 32]
    _now = np.asarray(Image.open(_after).convert("RGBA"))[32, 32]
    eq("the first job in a session rendered the original source",
       (int(_was[0]) > 180, int(_was[1]) < 60), (True, True))
    eq("a source replaced mid-session is re-read, not served from the cache",
       (int(_now[0]) < 60, int(_now[1]) > 180), (True, True))

# ── video alpha survives the decoder ────────────────────────
# PyAV's VideoFormat has no has_alpha attribute, so the old
# getattr(frame.format, "has_alpha", False) was False for every file ever
# decoded and the rgba branch never ran once — every transparent clip
# composited as the opaque black its encoder stored under the alpha. The fix
# tests the decoded frame's format NAME against _ALPHA_PIX_FMTS; this fixture
# exists so the branch can never fall silent again.
with tempfile.TemporaryDirectory() as _vtmp:
    _amov = os.path.join(_vtmp, "half_alpha.mov")
    _vc = av.open(_amov, "w")
    # qtrle keeps the alpha plane losslessly and every ffmpeg build carries it
    _vst = _vc.add_stream("qtrle", rate=8)
    _vst.width, _vst.height, _vst.pix_fmt = 64, 32, "argb"
    _px = np.zeros((32, 64, 4), dtype=np.uint8)
    _px[:, 32:] = [255, 0, 0, 255]        # right half opaque red, left half CLEAR
    for _ in range(8):
        _vf = av.VideoFrame.from_ndarray(_px, format="rgba")
        for _pkt in _vst.encode(_vf):
            _vc.mux(_pkt)
    for _pkt in _vst.encode(None):
        _vc.mux(_pkt)
    _vc.close()

    _acomp2 = {"width": 64, "height": 32, "duration": 1, "fps": 8, "layers": [
        {"id": "clip", "type": "video", "src": _amov,
         "transform": {"anchor": [32, 16], "position": [32, 16],
                       "scale": [100, 100], "rotation": 0, "opacity": 100}},
        {"id": "bg", "type": "solid", "width": 64, "height": 32,
         "color": [0, 255, 0, 255],
         "transform": {"anchor": [32, 16], "position": [32, 16],
                       "scale": [100, 100], "rotation": 0, "opacity": 100}}]}
    engine.close_sources()
    _fr = engine.render_frame(_acomp2, 0.5)
    _l, _r = _fr[16, 10], _fr[16, 54]
    eq("the clip's transparent half shows the solid beneath",
       (float(_l[1]) > 0.8, float(_l[0]) < 0.2), (True, True))
    eq("...and its opaque half still paints",
       (float(_r[0]) > 0.8, float(_r[1]) < 0.2), (True, True))
    engine.close_sources()

# ── matrix F1: points-type params survive evaluation ─────────────────────────
#
# interp._plain mapped every list element through _num, so a points param —
# curves' [[x, y], ...] — arrived at the renderer as [0.0, 0.0, 0.0] and the
# LUT stayed identity: custom curves were a silent no-op on the WHOLE vfx
# pipeline while the identical points worked through image_adjust.
print("\nmatrix F1: nested point lists survive interp\n")

_pts = [[0, 0], [128, 220], [255, 255]]
eq("a constant points param passes through eval_prop intact",
   interp.eval_prop(_pts, 0.5), [[0.0, 0.0], [128.0, 220.0], [255.0, 255.0]])
eq("...and through eval_params, the door the engine actually uses",
   interp.eval_params({"master": _pts, "amount": 100}, 0.5),
   {"master": [[0.0, 0.0], [128.0, 220.0], [255.0, 255.0]], "amount": 100.0})
eq("scalar lists keep the old coercion exactly",
   interp.eval_prop([1, "2", None], 0.0), [1.0, 2.0, 0.0])

# The API refuses to keyframe a points param (normalizeValue wants flat
# numbers), but a hand-written document can hold keyed points. Same point
# count = pairwise lerp; a mismatch HOLDS the left key. Neither may zero.
_keyed = {"keys": [{"t": 0.0, "v": [[0, 0], [128, 220], [255, 255]]},
                   {"t": 1.0, "v": [[0, 64], [128, 100], [255, 195]]}]}
eq("keyed points with matching counts lerp pairwise",
   interp.eval_prop(_keyed, 0.5), [[0.0, 32.0], [128.0, 160.0], [255.0, 225.0]])
_mismatch = {"keys": [{"t": 0.0, "v": [[0, 0], [255, 255]]},
                      {"t": 1.0, "v": [[0, 0], [128, 220], [255, 255]]}]}
eq("keyed points with mismatched counts hold the left key, never zero",
   interp.eval_prop(_mismatch, 0.5), [[0.0, 0.0], [255.0, 255.0]])

if engine.effects is not None:
    print("\nmatrix F1: every points-type param changes pixels through the engine\n")
    _points_params = [(fx, name)
                      for fx, spec in engine.effects.CATALOG.items()
                      for name, ps in (spec.get("params") or {}).items()
                      if isinstance(ps, dict) and ps.get("type") == "points"]
    eq("the catalog's points-type params are curves' five channels",
       sorted(_points_params),
       [("curves", "alpha"), ("curves", "blue"), ("curves", "green"),
        ("curves", "master"), ("curves", "red")])

    # Half-transparent mid-grey so EVERY channel curve — alpha included — has
    # something at 128 to lift; the endpoints of the sweep curve are identity.
    def _curves_comp(params):
        lay = solid("gray", (128, 128, 128, 128))
        if params is not None:
            lay["effects"] = [{"id": "fx1", "type": "curves", "enabled": True,
                               "params": params}]
        return comp([lay], bg=(0, 0, 0, 255))

    _base = engine.render_frame(_curves_comp(None), 0.5)
    _ident = engine.render_frame(_curves_comp({"master": [[0, 0], [255, 255]]}), 0.5)
    eq("an identity curve is the identity", bool(np.array_equal(_base, _ident)), True)
    for _fx, _name in _points_params:
        _out = engine.render_frame(_curves_comp({_name: [[0, 0], [128, 220], [255, 255]]}), 0.5)
        eq(f"{_fx}.{_name} with a real point list changes pixels",
           bool(np.array_equal(_base, _out)), False)
    _lifted = engine.render_frame(
        _curves_comp({"master": [[0, 0], [128, 220], [255, 255]]}), 0.5)
    eq("...and the master lift lands where the LUT says (128 -> ~220, over black at half alpha)",
       abs(float(_lifted[32, 32, 0]) - (220.0 / 255.0) * (128.0 / 255.0)) < 0.03, True)

    # ── matrix F2: posterizeTime's snapsTime path reads `rate`, not a param
    # the catalog never had. Draft renders have no history to fall back on, so
    # before the fix they held NOTHING — pin the hold exactly there.
    print("\nmatrix F2: posterizeTime holds draft/preview frames at rate\n")

    def _ptime_comp(with_hold, rate=2):
        lay = solid("anim", (0, 0, 0, 255))
        fxs = [{"id": "fxfill", "type": "fill", "enabled": True,
                "params": {"color": {"keys": [{"t": 0.0, "v": [0, 0, 0]},
                                              {"t": 1.0, "v": [255, 255, 255]}]}}}]
        if with_hold:
            fxs.append({"id": "fxpt", "type": "posterizeTime", "enabled": True,
                        "params": {} if rate is None else {"rate": rate}})
        lay["effects"] = fxs
        return comp([lay], fps=8.0, duration=1.0, bg=(0, 0, 0, 255))

    _live = _ptime_comp(False)
    eq("the control animates between two draft frames inside one hold step",
       bool(np.array_equal(engine.render_frame(_live, 0.0, draft=True),
                           engine.render_frame(_live, 0.375, draft=True))), False)
    _held = _ptime_comp(True, rate=2)
    _f0 = engine.render_frame(_held, 0.0, draft=True)
    eq("rate=2 holds a draft frame across the whole first half-second step",
       bool(np.array_equal(_f0, engine.render_frame(_held, 0.375, draft=True))), True)
    eq("...and steps at the boundary, so the hold is a hold and not a freeze",
       bool(np.array_equal(_f0, engine.render_frame(_held, 0.5, draft=True))), False)
    # An UNSET rate must quantise to the same grid the effect itself is coerced
    # to (the catalog default, 12), not fall back to "no snap".
    _default = _ptime_comp(True, rate=None)
    eq("an unset rate snaps at the catalog default instead of not at all",
       bool(np.array_equal(engine.render_frame(_default, 0.0, draft=True),
                           engine.render_frame(_default, 1.0 / 16.0, draft=True))), True)


# ── linear light, at the level of a whole comp ────────────────────────────────
#
# effects_test proves the transfer pair and the per-effect set. What is left for
# this file is the three things only the compositor can answer:
#
#   the SWITCH OFF is bit-identical — the house rule, checked here on a comp with
#   effects, blends and lights in it rather than on one effect at a time;
#   the BLEND MODES move, and only the two that should;
#   the RUN COALESCING is a saving and not a different picture.

print("\nlinear light\n")


# TWO COLOURS UNDER ONE KERNEL is the whole requirement, and it is easy to get
# wrong: a blur of a SINGLE colour is exactly space-independent (the colour
# factors out of the kernel and the unpremultiply divides it back), so a blurred
# SOLID measures nothing at all however wrong the space is. A checkerboard drawn
# into the layer by an effect is the cheapest honest plate — black and white
# under one kernel, the worst case and the one every textbook draws.
# Deliberately NOT pure black and white: 0 and 1 are fixed points of the
# transfer pair, so a two-tone plate made of them round-trips exactly and the
# run-coalescing test below would prove nothing about the conversion's error.
_CHECKER = {"id": "gen", "type": "checkerboard", "enabled": True,
            "params": {"size": 8, "colorA": [235, 180, 90], "colorB": [25, 45, 140]}}


def _lin_layer(*fx, lid="top"):
    return solid(lid, (255, 255, 255, 255), effects=[dict(_CHECKER), *fx])


def _lin_comp(**extra):
    return comp([_lin_layer({"id": "fx1", "type": "gaussianBlur", "enabled": True,
                             "params": {"radius": 9}}),
                 solid("bot", (20, 60, 200, 255), effects=[])],
                bg=(0, 0, 0, 255), **extra)


def _codes(a, b):
    d = np.abs(a[..., :3] - b[..., :3]) * 255.0
    return float(d.mean()), float(d.max())


_plain = engine.render_frame(_lin_comp(), 0.0)
eq("a comp with no linearLight field renders exactly as it always did",
   bool(np.array_equal(_plain, engine.render_frame(_lin_comp(linearLight=False), 0.0))), True)
eq("...and so does one that says false out loud",
   bool(np.array_equal(_plain, engine.render_frame(_lin_comp(linearLight=0), 0.0))), True)
_on = engine.render_frame(_lin_comp(linearLight=True), 0.0)
eq("...and turning it on moves the picture", bool(np.array_equal(_plain, _on)), False)
print("        a blurred two-colour comp moves %.2f codes mean, %.2f max" % _codes(_plain, _on))

# The blend modes: exactly two of them, and the rest untouched. `add` and
# `screen` are light arriving twice; multiply is a look; lighten and darken are
# provably identical because max and min commute with a monotone transfer.
_moved, _still = [], []
for _mode in ("add", "screen", "multiply", "lighten", "darken", "overlay",
              "softlight", "difference", "normal"):
    _c = comp([solid("t", (120, 60, 200, 255), blend=_mode, effects=[]),
               solid("b", (200, 140, 40, 255), effects=[])], bg=(0, 0, 0, 255))
    _g = engine.render_frame(_c, 0.0)
    _l = engine.render_frame(dict(_c, linearLight=True), 0.0)
    (_moved if _codes(_g, _l)[1] > 0.5 else _still).append(_mode)
    if _mode in ("add", "screen", "multiply", "lighten"):
        print("        blend %-9s %6.2f codes mean, %6.2f max" % ((_mode,) + _codes(_g, _l)))
eq("exactly add and screen move under linear light", sorted(_moved), ["add", "screen"])
eq("...and the modes the switch leaves alone are the rest of the menu",
   sorted(_still),
   ["darken", "difference", "lighten", "multiply", "normal", "overlay", "softlight"])
eq("...which is the set the engine declares", sorted(engine.LINEAR_BLENDS), ["add", "screen"])

# HALF CORRECTED AT PARTIAL OPACITY, and this pins the number rather than the
# caveat: the blend is computed in linear, the OVER that weights it is not, so
# an add at 50% moves exactly half as far as an add at 100%.
_add = comp([solid("t", (120, 60, 200, 255), blend="add", effects=[]),
             solid("b", (200, 140, 40, 255), effects=[])], bg=(0, 0, 0, 255))
_full = _codes(engine.render_frame(_add, 0.0),
               engine.render_frame(dict(_add, linearLight=True), 0.0))[0]
_add["layers"][0]["transform"]["opacity"] = 50
_half = _codes(engine.render_frame(_add, 0.0),
               engine.render_frame(dict(_add, linearLight=True), 0.0))[0]
print("        an add layer moves %.2f codes at 100%% opacity and %.2f at 50%%" % (_full, _half))
eq("an additive layer at half opacity MOVES exactly half as far — the OVER "
   "composite is still in gamma",
   abs(_half - _full / 2.0) < 0.05, True)

# ...AND HALF THE MOVE IS NOT HALF THE CORRECTION. "Corrected exactly half as
# far" was this file's phrasing and the spec's, and it reads as "half the error
# is gone", which is not what happens. Measured against a FULLY LINEAR
# reference — the blend, the opacity lerp and the composite all in linear,
# which is what moving the compositor would produce — over eight colour pairs
# rather than one, because the answer is per-channel and one pair is an anecdote:
_LIN_PAIRS = [((120, 60, 200), (200, 140, 40)), ((30, 30, 30), (90, 120, 60)),
              ((200, 200, 200), (60, 20, 10)), ((10, 180, 255), (140, 10, 90)),
              ((128, 128, 128), (128, 128, 128)), ((255, 80, 0), (20, 40, 160)),
              ((70, 90, 110), (30, 200, 120)), ((160, 40, 240), (240, 200, 20))]


def _lin_residual(op):
    """|render - fully-linear| in codes, per channel, switch off and switch on."""
    off, on = [], []
    for _t, _b in _LIN_PAIRS:
        _tl = solid("t", tuple(_t) + (255,), blend="add", effects=[])
        _tl["transform"]["opacity"] = op
        _c = comp([_tl, solid("b", tuple(_b) + (255,), effects=[])], bg=(0, 0, 0, 255))
        _g = engine.render_frame(_c, 0.0)[32, 32, :3]
        _l = engine.render_frame(dict(_c, linearLight=True), 0.0)[32, 32, :3]
        _bl = colour.srgb_to_linear(np.float32([v / 255.0 for v in _b]))
        _tlin = colour.srgb_to_linear(np.float32([v / 255.0 for v in _t]))
        _o = op / 100.0
        _ref = np.asarray(colour.linear_to_srgb(
            np.clip(_bl * (1 - _o) + (_bl + _tlin) * _o, 0, 1)))
        off.extend(np.abs(_g - _ref) * 255.0)
        on.extend(np.abs(_l - _ref) * 255.0)
    return np.float64(off), np.float64(on)


_off100, _on100 = _lin_residual(100)
_off50, _on50 = _lin_residual(50)
_worse = _on50 > _off50 + 1e-6
print("        against a fully-linear reference, mean codes over 8 colour pairs")
print("        at 100%% opacity   switch off %5.2f   switch on %5.2f"
      % (_off100.mean(), _on100.mean()))
print("        at  50%% opacity   switch off %5.2f   switch on %5.2f   "
      "(%d of %d channels land FURTHER out, worst by %.1f codes)"
      % (_off50.mean(), _on50.mean(), int(_worse.sum()), _worse.size,
         float((_on50 - _off50).max())))
eq("at full opacity the switch IS the whole correction — nothing is left over",
   float(_on100.max()) < 0.01, True)
# WHAT IS ASSERTED IS THE SHAPE, NOT THE FRACTION. "About a third" is what THESE
# eight pairs give (21.62 -> 13.58, printed above); another eight would give
# another number, so the claim worth pinning is only that the fall is nowhere
# near a half and nowhere near nothing. The labels say the band, not the sample.
eq("...and at half opacity it is not half of it: over these eight pairs the "
   "mean error falls by between a quarter and a half, the printed line saying "
   "which", 0.25 < 1.0 - _on50.mean() / _off50.mean() < 0.45, True)
# The one that makes "half corrected" actively misleading rather than loose:
# two errors that were cancelling stop cancelling, and some channels get worse.
# How MANY is a property of the sample — 6 of 24 for these pairs, printed above
# — so what is asserted is that the count is not zero, which is the claim.
eq("...and the half-correction lands FURTHER from the fully-linear answer than "
   "leaving the switch off did on AT LEAST ONE channel, which is what makes "
   "'half corrected' wrong rather than merely loose",
   int(_worse.sum()) > 0, True)

# Run coalescing. Two adjacent light-like effects share ONE conversion; a
# code-space effect between them breaks the run and the pixels go back and
# forth. The pictures must agree to well under a code either way, or the saving
# is a different render.
_BLUR = {"id": "a", "type": "gaussianBlur", "enabled": True, "params": {"radius": 6}}
_GLOW = {"id": "b", "type": "glow", "enabled": True,
         "params": {"radius": 12, "intensity": 140}}
# `levels` at its defaults is an identity on the pixels and NOT an identity on
# the run: it is a code-space effect, so the engine closes the run before it and
# opens a new one after. What is being measured is exactly the extra round trip.
_LEVELS = {"id": "m", "type": "levels", "enabled": True, "params": {}}
_two = _lin_layer(_BLUR, _GLOW)
_split = _lin_layer(_BLUR, _LEVELS, _GLOW)
_run = engine.render_frame(comp([_two], bg=(0, 0, 0, 255), linearLight=True), 0.0)
_brk = engine.render_frame(comp([_split], bg=(0, 0, 0, 255), linearLight=True), 0.0)
print("        a run of two vs the same two split by a levels: %.3f codes mean, %.3f max"
      % _codes(_run, _brk))
eq("hoisting one conversion out of a run is a saving, not a different picture",
   _codes(_run, _brk)[1] < 1.0, True)

# The run boundaries themselves. A disabled entry must not break a run, and a
# code-space effect must.
_stack = [{"type": "gaussianBlur"}, {"type": "curves"}, {"type": "glow"},
          {"type": "boxBlur"}, {"type": "invert", "enabled": False}, {"type": "radialBlur"}]
_first, _last = engine._linear_run(_stack)
eq("a run opens at each light-like effect that follows a code-space one",
   sorted(_first), [0, 2])
eq("...and closes at the last one before the next break", sorted(_last), [0, 5])
eq("a DISABLED effect does not break a run — it is not in the stack that runs",
   3 in _first, False)
eq("the switch off means no runs at all and every line reads as it did before",
   engine._linear_run([]), (set(), set()))

# AN UNKNOWN TYPE IS NOT A DISABLED ONE, and _linear_run's docstring used to say
# it was. effects.linearises answers False for a name it has never heard of — it
# cannot answer anything else — so the entry closes the run in front of it
# exactly as a code-space effect does. Pinned in both directions, because the
# docstring was believed for as long as nothing asked.
_dis = [{"type": "gaussianBlur"}, {"type": "invert", "enabled": False}, {"type": "boxBlur"}]
_unk = [{"type": "gaussianBlur"}, {"type": "nosuchEffect"}, {"type": "boxBlur"}]
eq("a disabled entry between two blurs leaves ONE conversion pair",
   tuple(sorted(s) for s in engine._linear_run(_dis)), ([0], [2]))
eq("an UNKNOWN type between the same two blurs makes TWO — it breaks the run",
   tuple(sorted(s) for s in engine._linear_run(_unk)), ([0, 2], [0, 2]))

# ...and the extra pair costs TIME, NOT PIXELS. effects.apply returns the frame
# untouched for a name that is not in its registry, and decode/encode is its own
# inverse to float32, so the only thing the broken run buys is milliseconds. If
# this ever stops being true the docstring's reason for leaving it alone is gone.
_UNK = {"id": "u", "type": "nosuchEffect", "enabled": True, "params": {}}
_BOX = {"id": "c", "type": "boxBlur", "enabled": True, "params": {"radius": 5}}
_pair = engine.render_frame(comp([_lin_layer(_BLUR, _BOX)], bg=(0, 0, 0, 255), linearLight=True), 0.0)
_brkn = engine.render_frame(comp([_lin_layer(_BLUR, _UNK, _BOX)], bg=(0, 0, 0, 255), linearLight=True), 0.0)
print("        an unknown type between two blurs: %.4f codes mean, %.4f max"
      % _codes(_pair, _brkn))
eq("an unknown type breaks the run and changes NOTHING about the picture",
   _codes(_pair, _brkn)[1] < 0.001, True)

# A run really is cheaper: three light-like effects in a row pay for one
# conversion, not three. Timed rather than asserted — the assertion is only that
# the saving exists at all, because a machine under load can say anything.
_three = [dict(_BLUR, id="a"), dict(_GLOW, id="b"), dict(_BLUR, id="c")]
_run3 = comp([_lin_layer(*_three)], w=480, h=270, bg=(0, 0, 0, 255), linearLight=True)
_brk3 = comp([_lin_layer(_three[0], dict(_LEVELS, id="m1"), _three[1],
                         dict(_LEVELS, id="m2"), _three[2])],
             w=480, h=270, bg=(0, 0, 0, 255), linearLight=True)


def _ms(fn, n=3):
    fn()
    best = 1e9
    for _ in range(n):
        _t0 = time.perf_counter()
        fn()
        best = min(best, (time.perf_counter() - _t0) * 1000.0)
    return best


_t_run = _ms(lambda: engine.render_frame(_run3, 0.0))
_t_brk = _ms(lambda: engine.render_frame(_brk3, 0.0))
print("        three light-like effects: %.1f ms as one run, %.1f ms broken into three"
      % (_t_run, _t_brk))
eq("...and it is cheaper, which is the whole reason the runs exist",
   _t_run < _t_brk, True)

# lights.py. The one place the arithmetic was plainly wrong: a diffuse multiply
# and a specular add, both performed on codes.
_lit = comp([dict(solid("s", (180, 150, 120, 255), effects=[]), threeD=True,
                  material={"diffuse": 80, "specular": 60, "shininess": 20}),
             {"id": "L", "name": "L", "type": "light", "start": 0.0, "end": 4.0,
              "enabled": True, "transform": {"position": [20, 20, -120]},
              "light": {"kind": "point", "intensity": 120, "color": [255, 240, 210]}}],
            bg=(0, 0, 0, 255))
_lg = engine.render_frame(_lit, 0.0)
_ll = engine.render_frame(dict(_lit, linearLight=True), 0.0)
print("        a 3D layer under one point light moves %.2f codes mean, %.2f max" % _codes(_lg, _ll))
eq("3D shading is done in linear when the switch is on", _codes(_lg, _ll)[1] > 5.0, True)
# ONE SCENE IS NOT A BOUND, and the setting's description used to quote this
# scene's max as if it were one ("up to 31"). Brighter light, more specular and
# a fully diffuse material move half again as far, so the description now says
# what a strong scene does instead of what this one does.
_lit2 = comp([dict(solid("s", (180, 150, 120, 255), effects=[]), threeD=True,
                   material={"diffuse": 100, "specular": 60, "shininess": 30}),
              {"id": "L", "name": "L", "type": "light", "start": 0.0, "end": 4.0,
               "enabled": True, "transform": {"position": [20, 20, -120]},
               "light": {"kind": "point", "intensity": 200, "color": [255, 240, 210]}}],
             bg=(0, 0, 0, 255))
_lit2_codes = _codes(engine.render_frame(_lit2, 0.0),
                     engine.render_frame(dict(_lit2, linearLight=True), 0.0))
print("        a STRONGLY lit one moves %.2f codes mean, %.2f max" % _lit2_codes)
eq("a brighter scene moves further than the one the description used to quote",
   _lit2_codes[1] > _codes(_lg, _ll)[1] * 1.5, True)

# ── the switch reaches INSIDE a precomp ───────────────────────────────────────
#
# It did not. The flag was read off whichever document was in hand, so a parent
# with the switch ON containing a precomp rendered identically to that precomp
# alone with the switch off — while the setting's description promised "every
# frame of this comp". A precomp's frames are this comp's frames.
#
# THREE STATES, one field: absent means INHERIT (and OFF at the top of the
# tree, which is every document written before the field existed), true and
# false are EXPLICIT and a parent cannot overrule them. That last part is not
# tidiness: a precomp built and approved in gamma must not silently re-render
# because the comp that uses it turned a switch on.


def _kid_comp(**extra):
    k = comp([_lin_layer({"id": "kb", "type": "gaussianBlur", "enabled": True,
                          "params": {"radius": 9}}, lid="kidtop")],
             bg=(0, 0, 0, 255), **extra)
    k["slug"] = k["id"] = "kid"
    return k


def _parent_comp(kid, **extra):
    return comp([{"id": "cl", "name": "nested", "type": "comp", "src": "kid",
                  "start": 0.0, "end": 4.0, "enabled": True,
                  "transform": {"anchor": [32, 32], "position": [32, 32],
                                "scale": [100, 100], "rotation": 0, "opacity": 100}}],
                bg=(0, 0, 0, 255), comps={"kid": kid}, **extra)


_kid_off = engine.render_frame(_parent_comp(_kid_comp()), 0.0)
_kid_inherits = engine.render_frame(_parent_comp(_kid_comp(), linearLight=True), 0.0)
_kid_explicit = engine.render_frame(
    _parent_comp(_kid_comp(linearLight=True), linearLight=True), 0.0)
_kid_refuses = engine.render_frame(
    _parent_comp(_kid_comp(linearLight=False), linearLight=True), 0.0)
print("        a precomp inside a linear parent moves %.2f codes mean, %.2f max"
      % _codes(_kid_off, _kid_inherits))
eq("a child that says nothing INHERITS the parent's switch — it used to ignore "
   "it and render exactly as if the parent were off",
   bool(np.array_equal(_kid_off, _kid_inherits)), False)
eq("...and inheriting is the same render as the child saying true itself",
   bool(np.array_equal(_kid_inherits, _kid_explicit)), True)
eq("...while a child that says FALSE keeps its gamma render inside a linear "
   "parent — an approved precomp is not re-rendered by a switch upstairs",
   bool(np.array_equal(_kid_off, _kid_refuses)), True)
eq("a parent that is off leaves a silent child exactly where it was",
   bool(np.array_equal(_kid_off,
                       engine.render_frame(_parent_comp(_kid_comp(linearLight=False)), 0.0))),
   True)
# Two levels down, because "inherit" that stops at the first hop is a different
# rule with the same name.
_deep_kid = _kid_comp()
_mid = _parent_comp(_deep_kid)
_mid["slug"] = _mid["id"] = "mid"
_grand = comp([{"id": "gl", "name": "mid", "type": "comp", "src": "mid",
                "start": 0.0, "end": 4.0, "enabled": True,
                "transform": {"anchor": [32, 32], "position": [32, 32],
                              "scale": [100, 100], "rotation": 0, "opacity": 100}}],
              bg=(0, 0, 0, 255), comps={"mid": _mid, "kid": _deep_kid},
              linearLight=True)
eq("inheritance goes all the way down, not one level",
   bool(np.array_equal(engine.render_frame(_grand, 0.0), _kid_inherits)), True)

# The resolution rule itself, as a table — cheaper to read than four renders.
_LIN_CASES = [({}, None, False), ({}, True, True), ({}, False, False),
              ({"linearLight": None}, True, True),
              ({"linearLight": True}, False, True),
              ({"linearLight": False}, True, False),
              ({"linearLight": True}, None, True)]
eq("inherit when the document is silent, explicit when it is not",
   [engine._linear_light(_d, engine.CompCtx(library={}, chain=(), linear=_p))
    for _d, _p, _ in _LIN_CASES], [_w for _, _, _w in _LIN_CASES])
eq("...and a comp asked with no context at all is OFF, which is every render "
   "this product made before the field existed",
   [engine._linear_light({}), engine._linear_light({"linearLight": True}),
    engine._linear_light(None)], [False, True, False])

# The container tag is NOT part of the switch: the pixels have always been
# sRGB/Rec.709 and an untagged file is a guess whichever way the switch is set.
eq("the colour tag names Rec.709 primaries", engine.AVCOL_PRI_BT709, 1)
eq("...sRGB's own transfer curve, not bt709's near-miss",
   engine.AVCOL_TRC_IEC61966_2_1, 13)
eq("...and the tag constants come from colour.py so they cannot drift from the maths",
   (engine.colour.COLOR_PRIMARIES, engine.colour.COLOR_TRC, engine.colour.COLOR_SPACE),
   ("bt709", "iec61966-2-1", "bt709"))

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
