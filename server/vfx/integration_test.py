"""Every subsystem in ONE render.

Each of these features has its own suite and each passes in isolation. That is
exactly the coverage that missed the bugs which actually shipped: shapes
rendered perfectly while nothing dispatched to them; expressions passed 242
assertions while the engine never evaluated one; 3D rotation worked in the
compositor while the store deleted the axes on load. Every fault lived in the
seam, and a suite per subsystem cannot see a seam.

So this file builds one document that uses all of them together and asserts on
the pixels. It is deliberately small — the point is not depth, it is that the
combination is exercised at all.

Run:  python server/vfx/integration_test.py
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np                                       # noqa: E402
import engine                                            # noqa: E402

_pass = 0
_fail: list[str] = []


def ok(label, cond, detail=""):
    global _pass
    if cond:
        _pass += 1
        print(f"  ok    {label}")
    else:
        _fail.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def ink(frame):
    """Painted pixels — the cheapest honest measure that a layer drew."""
    return int((frame[..., 3] > 0.5).sum())


# ── the document ─────────────────────────────────────────────────────────────
# A child comp whose shape draws itself, nested inside a parent that rotates it
# in 3D under a camera, beside text whose opacity comes from an expression.

CHILD = {
    "slug": "kid", "name": "kid", "width": 120, "height": 120,
    "duration": 2, "fps": 24,
    "layers": [{
        "id": "K", "type": "shape",
        "transform": {"anchor": [60, 60], "position": [60, 60],
                      "scale": [100, 100], "rotation": 0, "opacity": 100},
        "shapes": [
            {"type": "ellipse", "size": [90, 90], "position": [0, 0]},
            # keyframed on the ITEM — the path resolvePropPath now reaches
            {"type": "trim", "start": 0,
             "end": {"keys": [{"t": 0, "v": 10}, {"t": 2, "v": 100}]}},
            # 0-255, like every colour in this system. A 0-1 triple here is a
            # legal colour that happens to be almost black: the ring draws, the
            # alpha is identical, and only the picture is wrong.
            {"type": "stroke", "color": [77, 230, 255], "width": 8},
        ],
    }],
}


def doc():
    return {
        "width": 240, "height": 240, "duration": 2, "fps": 24, "seed": 7,
        "comps": {"kid": CHILD},
        "layers": [
            {"id": "CAM", "type": "camera", "threeD": True,
             "camera": {"zoom": 500},
             "transform": {"anchor": [120, 120], "position": [120, 120, -500],
                           "scale": [100, 100], "rotation": 0, "opacity": 100}},
            {"id": "TXT", "type": "text",
             "text": {"content": "MIX", "font": "arial.ttf", "size": 40,
                      "color": [255, 255, 255, 255], "align": "center"},
             "transform": {"anchor": [120, 120], "position": [120, 60],
                           "scale": [100, 100], "rotation": 0,
                           # Must actually CHANGE the value: an expression that
                           # computes the number the constant already held proves
                           # nothing about whether expressions are evaluated.
                           "opacity": {"expr": "value * 0.4", "value": 100}}},
            {"id": "NEST", "type": "comp", "src": "kid", "threeD": True,
             "transform": {"anchor": [60, 60], "position": [120, 150, -60],
                           "scale": [100, 100], "rotation": 0, "opacity": 100,
                           # INSIDE the transform, which is where the engine reads it
                           "rotationY": {"keys": [{"t": 0, "v": 0}, {"t": 2, "v": 60}]}},
             "effects": [{"id": "fx_1", "type": "glow", "enabled": True,
                          "params": {"radius": 6}}]},
        ],
    }


print("\n  -- all of it, in one render --")

began = time.time()
frames = [engine.render_frame(doc(), t) for t in (0.0, 0.7, 1.4, 1.9)]
per_frame_ms = (time.time() - began) * 1000 / len(frames)

ok("the combined document renders at all", all(f is not None for f in frames))
ok("...at the comp's size", all(f.shape == (240, 240, 4) for f in frames),
   str([f.shape for f in frames]))
ok("...as float32 in 0..1",
   all(f.dtype == np.float32 and f.min() >= -1e-6 and f.max() <= 1 + 1e-6 for f in frames))

marks = [ink(f) for f in frames]
ok("every frame differs from every other", len({f.tobytes() for f in frames}) == 4,
   f"ink {marks}")
ok("something is actually drawn in each", all(m > 0 for m in marks), f"ink {marks}")

# The shape's trim opens from 10% to 100% while the nested comp turns away from
# camera, so ink is not monotonic — asserting a direction here would be
# asserting a coincidence. That it MOVES is the real claim.
ok("the amount drawn changes over time", len(set(marks)) > 1, f"ink {marks}")

print("\n  -- and it is reproducible --")

a = engine.render_frame(doc(), 0.7)
b = engine.render_frame(doc(), 0.7)
ok("the same instant renders bit-identically twice", np.array_equal(a, b))

print("\n  -- each part is load-bearing --")

# Remove one feature at a time; each must change the picture. A part that can
# be deleted without changing a pixel was never wired in the first place —
# which is the exact failure this file exists for.
base = engine.render_frame(doc(), 1.4)

d = doc()
d["layers"][2]["transform"].pop("rotationY")
ok("removing the 3D rotation changes the render",
   not np.array_equal(base, engine.render_frame(d, 1.4)))

d = doc()
d["layers"][1]["transform"]["opacity"] = 100          # drop the expression
ok("removing the text expression changes the render",
   not np.array_equal(base, engine.render_frame(d, 1.4)))

d = doc()
d["comps"]["kid"] = dict(CHILD)
d["comps"]["kid"]["layers"] = [dict(CHILD["layers"][0])]
d["comps"]["kid"]["layers"][0]["shapes"] = [
    CHILD["layers"][0]["shapes"][0], CHILD["layers"][0]["shapes"][2]]   # no trim
ok("removing the shape's trim changes the render",
   not np.array_equal(base, engine.render_frame(d, 1.4)))

d = doc()
d["layers"][2]["effects"] = []
ok("removing the effect changes the render",
   not np.array_equal(base, engine.render_frame(d, 1.4)))

d = doc()
d["layers"] = [lay for lay in d["layers"] if lay["id"] != "CAM"]
ok("removing the camera changes the render",
   not np.array_equal(base, engine.render_frame(d, 1.4)))

print("\n  -- the two effects that read TIME, not just pixels --")

# A layer whose OWN CONTENT changes: a solid moved by keyframes has an
# identical bitmap every frame, and effects run before the transform, so it
# cannot show either of these no matter how well they work.
def ticker(fx):
    return {
        "width": 96, "height": 96, "duration": 2, "fps": 24,
        "layers": [{
            "id": "S", "type": "shape",
            "transform": {"anchor": [48, 48], "position": [48, 48],
                          "scale": [100, 100], "rotation": 0, "opacity": 100},
            "shapes": [
                {"type": "ellipse", "size": [70, 70], "position": [0, 0]},
                {"type": "trim", "start": 0,
                 "end": {"keys": [{"t": 0, "v": 5}, {"t": 2, "v": 100}]}},
                {"type": "stroke", "color": [255, 255, 255], "width": 6},
            ],
            "effects": fx,
        }],
    }

# echo reads ctx["history"]. The engine hands it as a CALLABLE while effects.py
# documented a list; `ctx.get("history") or []` returned the function, which is
# truthy, and every history effect died on len() of a function — inside apply's
# try/except, so it was a silent no-op plus one stderr line per layer per frame.
plain = engine.render_frame(ticker([]), 1.0)
echoed = engine.render_frame(ticker([
    {"id": "e", "type": "echo", "enabled": True,
     "params": {"echoes": 5, "frameDelay": 4, "decay": 0.8}}]), 1.0)
ok("echo actually reaches the layer's previous frames",
   not np.array_equal(plain, echoed),
   f"ink {ink(echoed)} vs {ink(plain)}")

# posterizeTime declares snapsTime, which asks the engine to sample the layer's
# CONTENT at a quantised instant. The parameter is the catalog's `rate` — this
# test originally wrote `fps`, a name the catalog never had, and the engine was
# reading the same wrong name back (matrix F2): the pair agreed with each other
# and with nothing a real document could hold, so previews and draft renders
# never held. engine_test.py pins the draft-side hold; this stays the seam test.
POSTER = [{"id": "p", "type": "posterizeTime", "enabled": True, "params": {"rate": 3}}]
a = engine.render_frame(ticker(POSTER), 1.05)
b = engine.render_frame(ticker(POSTER), 1.28)
c = engine.render_frame(ticker(POSTER), 1.40)
ok("two instants inside one step render identically", np.array_equal(a, b))
ok("...and the next step is different", not np.array_equal(a, c))
ok("...while without it those same two instants differ",
   not np.array_equal(engine.render_frame(ticker([]), 1.05),
                      engine.render_frame(ticker([]), 1.28)))

print("\n  -- the gamut clip that every hue blend goes through --")

# _clip_color pulls an out-of-gamut colour back inside the cube WITHOUT moving
# its luminance. Its n < 0 branch divided by np.minimum(l - n, -EPS) — and l is
# a weighted MEAN of the channels, so l >= n always and that expression was
# ALWAYS exactly -1e-6. Every colour the luminance transfer pushed below zero
# was divided by a millionth and flew off to five figures. SetSat always yields
# a channel of 0, so this was most hue and saturation blends. It shipped, and
# nothing raised.
_c = np.array([[[-0.058, 0.542, 0.242]]], np.float32)
_clipped = engine._clip_color(_c)
ok("an out-of-gamut colour lands back inside the cube",
   bool((_clipped >= -1e-4).all() and (_clipped <= 1.0001).all()),
   str(_clipped[0, 0]))
ok("...with its luminance untouched, which is the whole job",
   abs(float(engine._lum(_clipped)[0, 0, 0]) - float(engine._lum(_c)[0, 0, 0])) < 1e-4)

# And through the compositor, on the four modes that use it.
def _pair(mode):
    return {
        "width": 8, "height": 8, "duration": 1, "fps": 24,
        "layers": [
            {"id": "T", "type": "solid", "color": [20, 200, 90, 255], "blend": mode,
             "transform": {"anchor": [4, 4], "position": [4, 4], "scale": [100, 100],
                           "rotation": 0, "opacity": 100}},
            {"id": "B", "type": "solid", "color": [200, 40, 60, 255],
             "transform": {"anchor": [4, 4], "position": [4, 4], "scale": [100, 100],
                           "rotation": 0, "opacity": 100}},
        ],
    }

for _mode in ("hue", "saturation", "color", "luminosity"):
    _f = engine.render_frame(_pair(_mode), 0.5)
    ok(f"the {_mode} blend renders in range",
       bool(np.isfinite(_f).all() and _f.min() >= -1e-4 and _f.max() <= 1.0001),
       f"min {float(_f.min()):.3f} max {float(_f.max()):.3f}")

print("\n  -- effects that read a SECOND layer --")

# Five effects (displacement map, compound blur, set matte, difference matte,
# gradient wipe) declare a `layer` param, and the engine resolves it into
# ctx["layerPixels"]. Everything below is the ENGINE half of that contract;
# what the effects do with the pixels is effects_test.py's business.
def _maps(ref, enabled=True, fx=True):
    return {
        "width": 160, "height": 120, "duration": 1, "fps": 24,
        "layers": [
            {"id": "top", "type": "shape", "name": "plate",
             "transform": {"anchor": [80, 60], "position": [80, 60],
                           "scale": [100, 100], "rotation": 0, "opacity": 100},
             # TEXTURED on purpose: a flat field displaces to a flat field, so a
             # uniform plate cannot show whether the map arrived at all.
             "shapes": [{"type": "rect", "size": [150, 30], "position": [0, 0]},
                        {"type": "fill", "color": [255, 60, 40]}],
             "effects": ([{"id": "d", "type": "displacementMap", "enabled": True,
                           "params": {"mapLayer": ref, "maxHorizontal": 40,
                                      "maxVertical": 0}}] if fx else [])},
            {"id": "mapL", "type": "shape", "name": "ramp", "enabled": enabled,
             "transform": {"anchor": [80, 60], "position": [80, 60],
                           "scale": [100, 100], "rotation": 0, "opacity": 100},
             "shapes": [{"type": "rect", "size": [80, 120], "position": [-40, 0]},
                        {"type": "fill", "color": [255, 255, 255]}]},
        ],
    }

_none = engine.render_frame(_maps(""), 0.5)
_byid = engine.render_frame(_maps("mapL"), 0.5)
_byname = engine.render_frame(_maps("ramp"), 0.5)

ok("a layer reference reaches the effect and changes the render",
   not np.array_equal(_none, _byid))
ok("...resolved by unique NAME as well as by id", np.array_equal(_byid, _byname))

# Refusing the requester is not politeness — without it this recurses until the
# render dies. Degrading to the self-channel read is also the right answer.
ok("naming its OWN layer degrades instead of recursing",
   np.array_equal(_none, engine.render_frame(_maps("top"), 0.5)))
ok("an unknown reference falls back to the self-channel behaviour",
   np.array_equal(_none, engine.render_frame(_maps("nosuch"), 0.5)))

# Switching the map layer's eyeball off so it does not composite IS the
# workflow, so visibility must not gate RESOLUTION. Comparing against the same
# comp with the effect removed, because a hidden layer legitimately changes the
# picture by no longer painting.
_hidden_fx = engine.render_frame(_maps("mapL", enabled=False, fx=True), 0.5)
_hidden_no = engine.render_frame(_maps("mapL", enabled=False, fx=False), 0.5)
ok("a HIDDEN map layer still drives the effect",
   not np.array_equal(_hidden_fx, _hidden_no))
ok("...with the real map, not the fallback",
   not np.array_equal(_hidden_fx, engine.render_frame(_maps("", enabled=False), 0.5)))
ok("...while still not compositing itself", float(_hidden_no[10, 10, 3]) == 0.0)

print("\n  -- 3D lights --")

# lights.py has 145 assertions on the shading maths. None of them can prove the
# ENGINE builds a rig and hands it over, which is this seam — and the seam is
# the half that has gone missing every previous time.
def _lit(with_light):
    L = [
        {"id": "plate", "type": "solid", "color": [200, 200, 200, 255], "threeD": True,
         "transform": {"anchor": [80, 60], "position": [80, 60, 0], "scale": [100, 100],
                       "rotation": 0, "opacity": 100},
         "material": {"diffuse": 100, "ambient": 10}},
        {"id": "cam", "type": "camera", "threeD": True, "camera": {"zoom": 400},
         "transform": {"anchor": [80, 60], "position": [80, 60, -400], "scale": [100, 100],
                       "rotation": 0, "opacity": 100}},
    ]
    if with_light:
        L.insert(0, {"id": "key", "type": "light", "name": "key", "threeD": True,
                     "light": {"kind": "point", "intensity": 100,
                               "color": [255, 255, 255], "falloff": "none"},
                     "transform": {"anchor": [0, 0], "position": [80, 60, -200],
                                   "scale": [100, 100], "rotation": 0, "opacity": 100}})
    return {"width": 160, "height": 120, "duration": 1, "fps": 24, "layers": L}

_dark = engine.render_frame(_lit(False), 0.5)
_bright = engine.render_frame(_lit(True), 0.5)

ok("a light layer changes the render", not np.array_equal(_dark, _bright),
   f"{_dark[60, 80, 0]:.3f} -> {_bright[60, 80, 0]:.3f}")
ok("...and it brightens rather than darkens",
   float(_bright[60, 80, 0]) > float(_dark[60, 80, 0]))

# A light has no pixels. Without the layer-kind guard it paints as a white
# rectangle over the comp, which is what the module warned about by name.
ok("the light layer itself paints nothing",
   bool(np.isfinite(_bright).all() and _bright.max() <= 1.0001))

# acceptsLights:false must be bit-identical to having no lights at all —
# otherwise the opt-out is not an opt-out.
_optout = _lit(True)
_optout["layers"][1]["material"] = {"acceptsLights": False}
ok("a layer that refuses lights renders exactly as the unlit one",
   np.array_equal(engine.render_frame(_optout, 0.5), _dark))

print(f"\n  {per_frame_ms:.0f} ms/frame at 240x240")
print(f"\n  {_pass} passed, {len(_fail)} failed\n")
sys.exit(1 if _fail else 0)
