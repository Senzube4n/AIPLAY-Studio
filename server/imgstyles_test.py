"""THE FOUR LAYER STYLES ADDED 2026-09-21, AND THE PROPERTY THEY ALL SHARE.

The document model carried six of Photoshop's ten. These are the four that make
a layer read as an OBJECT rather than a flat fill: a bevel, a satin sheen, and
the two overlays that are not one flat colour.

⚠ THE PIN THAT CAUGHT A REAL BUG. Every style here paints INSIDE the matte and
leaves alpha alone — that is the contract `_tint_inside` is built on. The first
version of the two overlays set coverage to a constant across the whole buffer,
so they painted colour OUTSIDE the shape. With straight alpha that is invisible
when it composites, which is exactly why it would have survived: the render
looked right and the buffer was wrong, and anything premultiplying later would
have found colour sitting outside the letterform. Found by rendering a square
and measuring outside it, not by reading the code.
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "vfx"))
sys.path.insert(0, _HERE)

import engine            # noqa: E402
import imgdoc            # noqa: E402

PASS = FAIL = 0


def ok(what, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok    {what}")
    else:
        FAIL += 1
        print(f"  FAIL  {what}" + (f"\n        {extra}" if extra else ""))


NEW = ("bevelEmboss", "satin", "gradientOverlay", "patternOverlay")

print("\nLAYER STYLES — THE FOUR PHOTOSHOP HAS AND THIS DID NOT")

# ── declared everywhere one list is read ───────────────────────────────────
ok("all four are in the catalogue the validator and the tools read",
   all(n in imgdoc.STYLE_CATALOG for n in NEW),
   str([n for n in NEW if n not in imgdoc.STYLE_CATALOG]))
ok("...and the renderer can draw every one the catalogue declares",
   all(n in engine.STYLES for n in imgdoc.STYLE_CATALOG),
   str([n for n in imgdoc.STYLE_CATALOG if n not in engine.STYLES]))
ok("...and every one has a place in the painting order",
   all(n in imgdoc.STYLE_ORDER for n in imgdoc.STYLE_CATALOG))
ok("the set is Photoshop's ten", len(imgdoc.STYLE_CATALOG) == 10,
   f"{len(imgdoc.STYLE_CATALOG)}: {sorted(imgdoc.STYLE_CATALOG)}")
# The bevel reads as the surface the rest sit on, so it paints last.
ok("...and the bevel paints last, being the surface the others sit on",
   imgdoc.STYLE_ORDER[-1] == "bevelEmboss", str(imgdoc.STYLE_ORDER))

# ── the shared contract, measured on a real matte ──────────────────────────
H = W = 128
base = np.zeros((H, W, 4), np.float32)
base[32:96, 32:96] = [0.4, 0.45, 0.55, 1.0]

PARAMS = {
    "bevelEmboss": {"size": 8, "depth": 140, "angle": 120, "opacity": 95},
    "satin": {"distance": 18, "size": 8, "opacity": 85},
    "gradientOverlay": {"startColor": [255, 0, 0], "endColor": [0, 0, 255]},
    "patternOverlay": {"pattern": "dots", "size": 12, "opacity": 95},
}
for name in NEW:
    out = engine.STYLES[name](base.copy(), PARAMS[name], 1.0, False)
    d = np.abs(out[..., :3] - base[..., :3])
    inside = float(d[32:96, 32:96].mean())
    outside = float(max(d[:32].max(), d[96:].max()))
    ok(f"{name}: changes the layer where the matte is (mean {inside:.3f})", inside > 0.01,
       "a style that changes nothing is a style nobody can see")
    # ⚠ THE ONE THAT CAUGHT THE BUG.
    ok(f"...and NOTHING outside it (max {outside:.5f})", outside < 1e-6,
       "straight alpha hides this on composite, which is why it has to be measured here")
    ok("...and leaves alpha exactly as it found it",
       np.allclose(out[..., 3], base[..., 3]))

# ── a style at zero does nothing at all ────────────────────────────────────
for name in NEW:
    out = engine.STYLES[name](base.copy(), {**PARAMS[name], "opacity": 0}, 1.0, False)
    ok(f"{name} at zero opacity is a bypass, not a faint version of itself",
       np.allclose(out, base))

print(f"\n  {PASS} passed, {FAIL} failed")
if FAIL:
    raise SystemExit(1)
