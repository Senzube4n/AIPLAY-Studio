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

print(f"\n  {per_frame_ms:.0f} ms/frame at 240x240")
print(f"\n  {_pass} passed, {len(_fail)} failed\n")
sys.exit(1 if _fail else 0)
