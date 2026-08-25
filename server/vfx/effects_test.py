"""Unit tests for the effect library in server/vfx/effects.py.

Effects are pure functions of pixels, so unlike imagetools these need no temp
files - every case is a small synthetic RGBA array run straight through
`apply`. That is the point of the contract: an effect you can prove on a 24x32
array is an effect you can trust on a 4K plate.

Two kinds of test live here.

  * SWEEPS over every registered effect, which is where the contract is
    enforced: shape, dtype, range, the input never written to, alpha left
    exactly alone by everything that claims not to touch it, and a CATALOG
    that describes every effect with defaults inside their own ranges. These
    fail as one line naming the offenders, so adding an effect that breaks the
    contract tells you which one.
  * ONE MEANINGFUL ASSERTION PER EFFECT - not "it ran" but "a gaussian blur of
    a hard edge lowers the local gradient", "an exact-key pixel goes
    transparent while a distant colour stays opaque", "invert twice is the
    identity", "the same seed twice is the same grain".

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/effects_test.py

numpy / cv2 / scipy, same as effects.py itself.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import effects  # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def fx(name, img, params=None, **ctx):
    """Run one effect and hand back the result. Every call goes through the
    public `apply` so the tests exercise coercion and the output guarantees,
    not the private function."""
    base = {"t": 0.0, "fps": 30.0, "draft": False}
    base.update(ctx)
    return effects.apply(name, img, params or {}, base)


# ── test plates ────────────────────────────────────────────────────────────

def gradient(w=32, h=24):
    """Every channel varied, alpha included - a flat test image proves nothing."""
    a = np.zeros((h, w, 4), np.float32)
    a[..., 0] = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    a[..., 1] = np.linspace(1, 0, h, dtype=np.float32)[:, None]
    a[..., 2] = 0.4
    a[..., 3] = np.clip(np.linspace(-0.2, 1.2, w, dtype=np.float32), 0, 1)[None, :]
    return a


def vedge(w=32, h=24, lo=0.1, hi=0.9):
    """A hard vertical edge down the middle, fully opaque - the plate every
    blur and sharpen claim is measured against."""
    a = np.zeros((h, w, 4), np.float32)
    a[..., :3] = lo
    a[:, w // 2:, :3] = hi
    a[..., 3] = 1.0
    return a


def hedge(w=32, h=24, lo=0.1, hi=0.9):
    a = np.zeros((h, w, 4), np.float32)
    a[..., :3] = lo
    a[h // 2:, :, :3] = hi
    a[..., 3] = 1.0
    return a


def key_plate(w=16, h=16):
    """Half pure key green, half red, all opaque."""
    a = np.zeros((h, w, 4), np.float32)
    a[:, :w // 2] = [0.0, 1.0, 0.0, 1.0]
    a[:, w // 2:] = [1.0, 0.0, 0.0, 1.0]
    return a


def disc(w=41, h=41, r=12, color=(1.0, 1.0, 1.0)):
    """A hard-edged opaque circle on transparent - the matte plate."""
    a = np.zeros((h, w, 4), np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    inside = ((xx - w // 2) ** 2 + (yy - h // 2) ** 2) <= r * r
    a[..., :3] = np.array(color, np.float32)
    a[..., 3] = inside.astype(np.float32)
    return a


def solid(w=16, h=16, color=(0.5, 0.5, 0.5), alpha=1.0):
    a = np.zeros((h, w, 4), np.float32)
    a[..., :3] = np.array(color, np.float32)
    a[..., 3] = alpha
    return a


def hgrad(w=32, h=24):
    """Opaque left-to-right luminance ramp."""
    a = np.zeros((h, w, 4), np.float32)
    a[..., :3] = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]
    a[..., 3] = 1.0
    return a


def edge_step(img, row=None):
    """The biggest one-pixel jump along a row - the number a blur must lower
    and a sharpen must raise."""
    r = img.shape[0] // 2 if row is None else row
    return float(np.abs(np.diff(img[r, :, 0])).max())


# Parameters that make each effect actually DO something. Half the catalog
# defaults to identity on purpose (a transform you just added must not move
# the layer), so the sweeps would otherwise be testing nothing at all.
PROBE = {
    "gaussianBlur": {"radius": 3},
    "boxBlur": {"radius": 3, "iterations": 2},
    "directionalBlur": {"length": 9, "angle": 30},
    "radialBlur": {"amount": 30, "type": "spin"},
    "unsharpMask": {"amount": 200, "radius": 2},
    "bilateralSmooth": {"radius": 4},
    "brightnessContrast": {"brightness": 20, "contrast": 40},
    "curves": {"master": [[0, 40], [128, 180], [255, 255]]},
    "levels": {"inBlack": 30, "inWhite": 200, "gamma": 1.4},
    "hueSaturation": {"hue": 60, "saturation": 40, "lightness": 10},
    "exposure": {"exposure": 1.0, "offset": 0.05, "gamma": 1.2},
    "tint": {"amount": 80},
    "colorBalance": {"shadowBlue": 60, "highRed": 40},
    "vibrance": {"vibrance": 80},
    "channelMixer": {"redFromGreen": 50},
    "invert": {},
    "blackAndWhite": {},
    "chromaKey": {},
    "lumaKey": {"threshold": 40},
    "colorRangeKey": {"tolerance": 40},
    "spillSuppress": {},
    "matteChoke": {"amount": 2, "feather": 3, "blackClip": 10, "whiteClip": 90},
    "glow": {"threshold": 20, "radius": 6},
    "dropShadow": {"distance": 6, "softness": 4},
    "stroke": {"width": 3},
    "posterize": {"levels": 4},
    "findEdges": {},
    "mosaic": {"size": 8},
    "halftone": {"size": 6},
    "noise": {"amount": 40},
    "scanlines": {"spacing": 6},
    "chromaticAberration": {"amount": 4},
    "transform": {"scaleX": 140, "scaleY": 80, "rotation": 20, "positionX": 5,
                  "skew": 10, "edgeBehavior": "wrap"},
    "cornerPin": {"topLeftX": 10, "bottomRightY": 80},
    "wave": {"amplitude": 8, "waveType": "triangle", "direction": "both"},
    "ripple": {"amplitude": 9},
    "bulge": {"strength": -60},
    "lensDistortion": {"amount": 40, "secondary": 10, "zoom": 110},
    "mirror": {"angle": 30},
    "polarCoords": {"amount": 70},
    "fill": {"mode": "normal"},
    "ramp": {"scatter": 20, "type": "radial"},
    "checkerboard": {"size": 7, "mode": "multiply"},
    "vignette": {"amount": 70},
    "lensFlare": {},
    "gridLines": {"spacing": 9, "mode": "screen"},
    "echo": {"echoes": 3, "mode": "add"},
    "posterizeTime": {"rate": 6},
    "feather": {"amount": 4, "bias": 40},
    "invertAlpha": {},
    "premultiply": {"matteColor": [255, 0, 0]},
    "unpremultiply": {"matteColor": [10, 10, 10]},
}


print("\nvfx effects\n")

# ── the catalog IS the API ─────────────────────────────────────────────────
# MCP serves CATALOG verbatim and an agent reads it instead of guessing, so a
# registered effect missing from the catalog is an effect nobody can find, and
# a default outside its own range is a slider that starts broken.

names = sorted(effects.CATALOG)
eq("every registered effect is in the catalog",
   sorted(set(effects._REGISTRY) - set(effects.CATALOG)), [])
eq("every catalog entry has an implementation",
   sorted(set(effects.CATALOG) - set(effects._REGISTRY)), [])
eq("the catalog is not empty", len(names) >= 40, True)

missing_meta = [n for n, e in effects.CATALOG.items()
                if not all(e.get(k) for k in ("label", "group", "why"))
                or "params" not in e or "touchesAlpha" not in e]
eq("every effect declares label, group, why, touchesAlpha and params", missing_meta, [])
eq("every group is one of the eight in the spec",
   sorted({e["group"] for e in effects.CATALOG.values()} - set(effects.GROUP_ORDER)), [])

bad_param = []
for n, e in effects.CATALOG.items():
    for key, p in e["params"].items():
        where = f"{n}.{key}"
        if not p.get("desc") or "animatable" not in p or "type" not in p:
            bad_param.append(where + " (undescribed)")
            continue
        kind, d = p["type"], p["default"]
        if kind == "number":
            if "min" not in p or "max" not in p:
                bad_param.append(where + " (no range)")
            elif not (p["min"] <= d <= p["max"]):
                bad_param.append(where + f" (default {d} outside {p['min']}..{p['max']})")
        elif kind == "enum":
            if d not in p.get("options", []):
                bad_param.append(where + " (default not an option)")
        elif kind == "bool":
            if not isinstance(d, bool):
                bad_param.append(where + " (default not a bool)")
        elif kind == "color":
            if len(d) < 3 or not all(0 <= float(c) <= 255 for c in d):
                bad_param.append(where + " (colour outside 0..255)")
        elif kind == "points":
            if len(d) < 2 or not all(len(q) == 2 and 0 <= q[0] <= 255 and 0 <= q[1] <= 255
                                     for q in d):
                bad_param.append(where + " (curve outside 0..255)")
        else:
            bad_param.append(where + f" (unknown type {kind})")
eq("every catalog param is described with a default inside its own range", bad_param, [])
eq("every effect has a probe in this test file",
   sorted(set(effects.CATALOG) - set(PROBE)), [])
eq("effects needing previous frames say so",
   sorted(n for n, e in effects.CATALOG.items() if e.get("needsHistory")),
   ["echo", "posterizeTime"])

# ── the contract, over every effect ────────────────────────────────────────

PLATE = gradient(32, 24)
HISTORY = [np.clip(PLATE * (0.5 + 0.05 * i), 0, 1).astype(np.float32) for i in range(8)]

broken, mutated, moved_alpha, inert = [], [], [], []
for n in names:
    before = PLATE.copy()
    out = fx(n, before, PROBE[n], t=0.5, history=HISTORY)
    if not np.array_equal(before, PLATE):
        mutated.append(n)
    if (not isinstance(out, np.ndarray) or out.shape != PLATE.shape
            or out.dtype != np.float32 or not np.isfinite(out).all()
            or out.min() < 0.0 or out.max() > 1.0):
        broken.append(n)
    if not effects.CATALOG[n]["touchesAlpha"] and not np.array_equal(out[..., 3], PLATE[..., 3]):
        moved_alpha.append(n)

eq("every effect returns a finite float32 (H,W,4) inside 0..1", broken, [])
eq("no effect writes to the array it was given", mutated, [])
eq("effects that claim not to touch alpha leave it bit-identical", moved_alpha, [])

# The same sweep in draft, where several effects take a cheaper road.
draft_broken = [n for n in names
                if fx(n, PLATE.copy(), PROBE[n], t=0.5, draft=True, history=HISTORY).shape
                != PLATE.shape]
eq("draft renders honour the same shape contract", draft_broken, [])

# Garbage in must not raise: the catalog is the schema, so out-of-range,
# wrong-typed and unknown keys are clamped or dropped before an effect sees
# them. This is what stops one bad MCP call losing a render.
junk = {"radius": "nonsense", "amount": 1e9, "levels": -5, "type": "banana",
        "color": None, "size": float("nan"), "seed": {}, "master": "curve",
        "mode": 17, "echoes": None, "unknownParam": 3}
junk_broken = []
for n in names:
    out = fx(n, PLATE.copy(), junk, t=0.5, history=HISTORY)
    if out.shape != PLATE.shape or not np.isfinite(out).all():
        junk_broken.append(n)
eq("garbage parameters are clamped, not fatal", junk_broken, [])

# History is a luxury: the first frames of a comp do not have one.
eq("effects needing history are a no-op without it",
   [n for n, e in effects.CATALOG.items() if e.get("needsHistory")
    and not np.array_equal(fx(n, PLATE, PROBE[n], t=0.4), PLATE)], [])

# ── apply's own guarantees ─────────────────────────────────────────────────

eq("an unknown name returns the very same array",
   fx("noSuchEffect", PLATE) is PLATE, True)
eq("an unusable array comes back untouched",
   fx("gaussianBlur", np.zeros((4, 4), np.float32)).shape, (4, 4))
eq("a uint8 array is refused rather than misread",
   fx("invert", np.zeros((4, 4, 4), np.uint8)).dtype, np.dtype(np.uint8))
eq("the catalog dump carries effects, groups and names",
   sorted(effects.catalog().keys()), ["effects", "groups", "names"])


print("\n  -- Blur & Sharpen --")

sharp = vedge()
eq("a gaussian blur lowers the gradient across a hard edge",
   edge_step(fx("gaussianBlur", sharp, {"radius": 3})) < edge_step(sharp) * 0.6, True)
eq("a horizontal-only blur leaves a horizontal edge alone",
   np.allclose(fx("gaussianBlur", hedge(), {"radius": 4, "dimensions": "horizontal"}),
               hedge(), atol=1e-5), True)
eq("a bigger radius blurs more",
   edge_step(fx("gaussianBlur", sharp, {"radius": 8}))
   < edge_step(fx("gaussianBlur", sharp, {"radius": 2})), True)

eq("a box blur lowers the gradient across a hard edge",
   edge_step(fx("boxBlur", sharp, {"radius": 3})) < edge_step(sharp) * 0.6, True)
eq("more box iterations soften further",
   edge_step(fx("boxBlur", sharp, {"radius": 3, "iterations": 3}))
   < edge_step(fx("boxBlur", sharp, {"radius": 3, "iterations": 1})), True)

eq("a horizontal directional blur smears a vertical edge",
   edge_step(fx("directionalBlur", sharp, {"length": 9, "angle": 0}))
   < edge_step(sharp) * 0.6, True)
eq("...and leaves a horizontal edge standing",
   abs(float(np.abs(np.diff(fx("directionalBlur", hedge(),
                               {"length": 9, "angle": 0})[:, 8, 0])).max())
       - float(np.abs(np.diff(hedge()[:, 8, 0])).max())) < 1e-5, True)

spin = fx("radialBlur", disc(), {"type": "spin", "amount": 40})
eq("a spin blur leaves its own centre alone",
   abs(float(spin[20, 20, 3]) - 1.0) < 1e-3, True)
eq("...and softens the rim it sweeps",
   float(spin[20, 32, 3]) not in (0.0, 1.0), True)

blur_first = fx("gaussianBlur", sharp, {"radius": 2})
eq("an unsharp mask raises the gradient a blur lowered",
   edge_step(fx("unsharpMask", blur_first, {"amount": 250, "radius": 2, "threshold": 0}))
   > edge_step(blur_first), True)
eq("...and its threshold protects small differences",
   np.allclose(fx("unsharpMask", gradient(), {"amount": 250, "radius": 2, "threshold": 60}),
               gradient(), atol=1e-4), True)

noisy = solid(32, 32, (0.5, 0.5, 0.5))
noisy[..., :3] += np.random.default_rng(4).normal(0, 0.05, (32, 32, 3)).astype(np.float32)
noisy[:, 16:, :3] += 0.35
smoothed = fx("bilateralSmooth", np.clip(noisy, 0, 1), {"radius": 5, "colorSigma": 12})
eq("a bilateral smooth flattens noise inside a flat patch",
   float(smoothed[:, 2:14, 0].std()) < float(noisy[:, 2:14, 0].std()) * 0.75, True)
eq("...while keeping the step it was told not to cross",
   float(smoothed[:, 16:, 0].mean() - smoothed[:, :16, 0].mean()) > 0.3, True)
eq("...and it is skipped entirely in draft",
   fx("bilateralSmooth", noisy, {"radius": 5}, draft=True) is noisy, True)


print("\n  -- Color --")

mid = solid(8, 8, (0.4, 0.4, 0.4))
eq("brightness lifts the mean",
   float(fx("brightnessContrast", mid, {"brightness": 30})[..., 0].mean()) > 0.65, True)
eq("contrast widens the spread around mid grey",
   float(fx("brightnessContrast", hgrad(), {"contrast": 80})[..., 0].std())
   > float(hgrad()[..., 0].std()), True)

eq("an identity curve changes nothing",
   fx("curves", gradient(), {"master": [[0, 0], [255, 255]]}) is not None
   and np.allclose(fx("curves", gradient(), {"master": [[0, 0], [255, 255]]}), gradient()), True)
inv_curve = fx("curves", hgrad(), {"master": [[0, 255], [255, 0]]})
eq("an inverting curve inverts",
   float(np.abs(inv_curve[..., 0] - (1.0 - hgrad()[..., 0])).max()) < 0.01, True)

lv = fx("levels", hgrad(), {"inBlack": 64, "inWhite": 192})
eq("levels clips everything under the black point to black",
   float(lv[0, :5, 0].max()), 0.0)
eq("levels clips everything over the white point to white",
   float(lv[0, -3:, 0].min()), 1.0)

eq("saturation -100 leaves red, green and blue equal",
   float(np.abs(np.diff(fx("hueSaturation", gradient(), {"saturation": -100})[..., :3],
                        axis=-1)).max()) < 2e-3, True)
eq("a 180 degree hue rotation is its own undo",
   float(np.abs(fx("hueSaturation", fx("hueSaturation", solid(4, 4, (0.8, 0.3, 0.1)),
                                       {"hue": 180}), {"hue": 180})[..., :3] - 0.8).min()) < 0.01,
   True)

eq("one stop of exposure doubles a midtone",
   abs(float(fx("exposure", solid(4, 4, (0.25, 0.25, 0.25)), {"exposure": 1})[0, 0, 0]) - 0.5)
   < 1e-3, True)

tinted = fx("tint", gradient(), {"blackColor": [0, 0, 0], "whiteColor": [255, 255, 255]})
eq("a black-to-white tint is a greyscale",
   float(np.abs(np.diff(tinted[..., :3], axis=-1)).max()) < 1e-5, True)

cb = fx("colorBalance", hgrad(), {"shadowBlue": 100, "preserveLuminosity": False})
eq("color balance puts blue in the darks, not the lights",
   float(cb[0, 1, 2] - hgrad()[0, 1, 2]) > float(cb[0, -2, 2] - hgrad()[0, -2, 2]), True)

duo = np.zeros((4, 8, 4), np.float32)
duo[..., 3] = 1.0
duo[:, :4, :3] = [0.55, 0.45, 0.45]        # nearly grey
duo[:, 4:, :3] = [1.0, 0.0, 0.0]           # already screaming
vib = fx("vibrance", duo, {"vibrance": 100})


def chroma(a):
    return float((a[..., :3].max(axis=-1) - a[..., :3].min(axis=-1)).mean())


eq("vibrance boosts the dull more than the already-loud",
   (chroma(vib[:, :4]) - chroma(duo[:, :4])) > (chroma(vib[:, 4:]) - chroma(duo[:, 4:])), True)

eq("an identity channel mixer is a no-op", fx("channelMixer", gradient(), {}) is gradient()
   or np.allclose(fx("channelMixer", gradient(), {}), gradient()), True)
eq("a monochrome mixer leaves the three channels equal",
   float(np.abs(np.diff(fx("channelMixer", gradient(),
                           {"monochrome": True})[..., :3], axis=-1)).max()) < 1e-6, True)

once = fx("invert", gradient())
# "Exactly" up to float32: 1-(1-x) is not bit-exact for every x, but a drift
# larger than an ulp would mean the amount blend is not a true reflection.
eq("invert twice is the identity",
   float(np.abs(fx("invert", once) - gradient()).max()) < 1e-6, True)
eq("invert actually inverted", float(np.abs(once[..., 0] - (1 - gradient()[..., 0])).max()) < 1e-6,
   True)

bw_red = fx("blackAndWhite", solid(4, 4, (1.0, 0.0, 0.0)))
bw_blue = fx("blackAndWhite", solid(4, 4, (0.0, 0.0, 1.0)))
eq("black and white puts pure red at the reds weight (40%)",
   abs(float(bw_red[0, 0, 0]) - 0.40) < 0.02, True)
eq("...and pure blue at the blues weight (20%)",
   abs(float(bw_blue[0, 0, 0]) - 0.20) < 0.02, True)


print("\n  -- Keying --")

keyed = fx("chromaKey", key_plate(), {"color": [0, 255, 0], "tolerance": 25, "softness": 10})
eq("an exact-key pixel goes fully transparent", float(keyed[4, 1, 3]), 0.0)
eq("a distant colour stays fully opaque", float(keyed[4, 12, 3]), 1.0)
eq("the distant colour is not despilled", tuple(keyed[4, 12, :3]), (1.0, 0.0, 0.0))
spill = solid(4, 4, (0.5, 0.9, 0.5))
eq("a half-keyed edge pixel has its key channel pulled down",
   float(fx("chromaKey", spill, {"tolerance": 55, "softness": 40})[0, 0, 1]) < 0.9, True)

lk = fx("lumaKey", hgrad(), {"keyOut": "darker", "threshold": 50, "softness": 10})
eq("a luma key drops the dark end", float(lk[0, 2, 3]), 0.0)
eq("...and keeps the bright end", float(lk[0, -2, 3]), 1.0)
eq("inverting a luma key swaps which end survives",
   float(fx("lumaKey", hgrad(), {"keyOut": "darker", "threshold": 50,
                                 "invert": True})[0, -2, 3]), 0.0)

crk = fx("colorRangeKey", key_plate(), {"color": [0, 255, 0], "tolerance": 15, "space": "lab"})
eq("a Lab colour-range key drops the range", float(crk[4, 1, 3]), 0.0)
eq("...and leaves a distant colour alone", float(crk[4, 12, 3]), 1.0)
eq("...without moving its colour", tuple(crk[4, 12, :3]), (1.0, 0.0, 0.0))

sup = fx("spillSuppress", solid(4, 4, (0.4, 0.8, 0.4)), {"amount": 100,
                                                         "preserveLuminance": False})
eq("spill suppression pulls the screen channel back to its neighbours",
   abs(float(sup[0, 0, 1]) - 0.4) < 0.02, True)
eq("...and leaves the matte alone",
   np.array_equal(sup[..., 3], solid(4, 4, (0.4, 0.8, 0.4))[..., 3]), True)

d = disc()
eq("a positive choke grows the matte",
   float(fx("matteChoke", d, {"amount": 3, "feather": 0})[..., 3].sum()) > float(d[..., 3].sum()),
   True)
eq("a negative choke eats it",
   float(fx("matteChoke", d, {"amount": -3, "feather": 0})[..., 3].sum()) < float(d[..., 3].sum()),
   True)
soft_ramp = np.zeros((4, 32, 4), np.float32)
soft_ramp[..., :3] = 1.0
soft_ramp[..., 3] = np.linspace(0, 1, 32, dtype=np.float32)[None, :]
clipped = fx("matteChoke", soft_ramp, {"amount": 0, "feather": 0,
                                       "blackClip": 30, "whiteClip": 70})
eq("the black clip throws away everything under it",
   float(clipped[0, soft_ramp[0, :, 3] < 0.30, 3].max()), 0.0)
eq("the white clip makes everything over it solid",
   float(clipped[0, soft_ramp[0, :, 3] > 0.70, 3].min()), 1.0)


print("\n  -- Stylize --")

lit = disc(41, 41, 8, (1.0, 1.0, 1.0))
glowed = fx("glow", lit, {"threshold": 20, "radius": 8, "intensity": 200})
eq("a glow carries light past the layer edge",
   float(glowed[20, 32, 3]) > float(lit[20, 32, 3]), True)
eq("...unless expandAlpha is off",
   np.array_equal(fx("glow", lit, {"threshold": 20, "radius": 8,
                                   "expandAlpha": False})[..., 3], lit[..., 3]), True)

sh = fx("dropShadow", disc(41, 41, 8), {"distance": 10, "angle": 45, "softness": 1,
                                        "opacity": 100})
eq("a 45 degree shadow lands down and to the right",
   float(sh[27, 27, 3]) > float(sh[13, 13, 3]), True)
eq("shadowOnly keeps the shadow and drops the layer",
   float(fx("dropShadow", disc(41, 41, 8), {"distance": 10, "angle": 45,
                                            "shadowOnly": True})[20, 20, 3]) < 0.5, True)

st = fx("stroke", disc(41, 41, 8), {"width": 3, "position": "outside", "feather": 0})
eq("an outside stroke paints where there was nothing",
   float(st[20, 30, 3]) > 0.5, True)
eq("an inside stroke never grows the matte",
   float(fx("stroke", disc(41, 41, 8), {"width": 3, "position": "inside"})[..., 3].sum())
   <= float(disc(41, 41, 8)[..., 3].sum()) + 1e-3, True)

eq("posterize 4 leaves exactly four values on a ramp",
   len(np.unique(np.round(fx("posterize", hgrad(256, 4), {"levels": 4})[..., 0], 5))), 4)
eq("posterize 8 leaves exactly eight",
   len(np.unique(np.round(fx("posterize", hgrad(256, 4), {"levels": 8})[..., 0], 5))), 8)

fe = fx("findEdges", vedge())
eq("find edges leaves a flat area white (it is inverted by default)",
   float(fe[12, 3, 0]) > 0.98, True)
eq("...and draws the edge dark", float(fe[12, 16, 0]) < 0.5, True)

mos = fx("mosaic", gradient(32, 24), {"size": 8})
eq("every pixel inside one mosaic block is the same",
   float(mos[0:8, 0:8, 0].std()) < 1e-6, True)
eq("...and neighbouring blocks are not",
   abs(float(mos[0, 0, 0] - mos[0, 9, 0])) > 0.05, True)

dark_ht = fx("halftone", solid(32, 32, (0.15, 0.15, 0.15)), {"size": 8})
light_ht = fx("halftone", solid(32, 32, (0.85, 0.85, 0.85)), {"size": 8})
eq("halftone dots grow as the picture darkens",
   float(dark_ht[..., 0].mean()) < float(light_ht[..., 0].mean()), True)

n1 = fx("noise", gradient(), {"amount": 40, "seed": 11}, t=1.0)
n2 = fx("noise", gradient(), {"amount": 40, "seed": 11}, t=1.0)
n3 = fx("noise", gradient(), {"amount": 40, "seed": 12}, t=1.0)
n4 = fx("noise", gradient(), {"amount": 40, "seed": 11}, t=2.0)
eq("the same seed and frame give exactly the same grain", np.array_equal(n1, n2), True)
eq("a different seed gives different grain", np.array_equal(n1, n3), False)
eq("the grain moves with the frame", np.array_equal(n1, n4), False)
eq("a frozen grain does not move with the frame",
   np.array_equal(fx("noise", gradient(), {"amount": 40, "animate": False}, t=1.0),
                  fx("noise", gradient(), {"amount": 40, "animate": False}, t=9.0)), True)

sl = fx("scanlines", solid(24, 24, (1.0, 1.0, 1.0)), {"spacing": 6, "darkness": 80,
                                                      "softness": 0})
eq("scanlines repeat on their spacing", abs(float(sl[0, 0, 0] - sl[6, 0, 0])) < 1e-5, True)
eq("...and the line is darker than the gap", float(sl[0, 0, 0]) < float(sl[3, 0, 0]), True)
eq("a rolling pattern is somewhere else a second later",
   np.array_equal(fx("scanlines", solid(24, 24), {"spacing": 6, "rollSpeed": 30}, t=0.0),
                  fx("scanlines", solid(24, 24), {"spacing": 6, "rollSpeed": 30}, t=0.5)), False)

ca = fx("chromaticAberration", vedge(64, 8), {"amount": 6, "type": "linear", "angle": 0})
eq("linear aberration pushes red and blue opposite ways at an edge",
   float(ca[4, 32, 0] - ca[4, 32, 2]) * float(ca[4, 30, 0] - ca[4, 30, 2]) >= 0
   and abs(float(ca[4, 32, 0] - ca[4, 32, 2])) > 0.05, True)


print("\n  -- Distort --")

src = gradient(16, 16)
opaque = gradient(16, 16)
opaque[..., 3] = 1.0        # a resample cannot recover colour under alpha 0
# The anchor is a percentage of the layer, and the centre of a 16px axis sits
# at 7.5 - not 8 - so the pivot that turns the picture onto itself is 46.875%.
half_turn = {"rotation": 180, "anchorX": 46.875, "anchorY": 46.875, "edgeBehavior": "clamp"}
rot = fx("transform", opaque, half_turn)
eq("a 180 degree transform turns the picture onto itself",
   float(np.abs(rot[..., :3] - opaque[::-1, ::-1, :3]).max()) < 0.02, True)
eq("a default transform is a no-op", fx("transform", src, {}) is src, True)
eq("transform opacity fades the matte",
   abs(float(fx("transform", solid(4, 4, alpha=1.0), {"opacity": 50})[0, 0, 3]) - 0.5) < 1e-6,
   True)

eq("identity corners are a no-op", fx("cornerPin", src, {}) is src, True)
pin = fx("cornerPin", solid(32, 32, (1, 1, 1), 1.0),
         {"topLeftX": 25, "topLeftY": 25, "topRightX": 75, "topRightY": 25,
          "bottomRightX": 75, "bottomRightY": 75, "bottomLeftX": 25, "bottomLeftY": 75})
eq("a shrunk corner pin puts the picture inside the quad", float(pin[16, 16, 3]), 1.0)
eq("...and nothing outside it", float(pin[2, 2, 3]), 0.0)

# One bright column, so the displacement can be read off directly. With a
# wavelength of one image height, row 8 is at the crest (+6px into the source,
# so the column moves 6px LEFT) and row 24 at the trough.
bar = np.zeros((32, 32, 4), np.float32)
bar[..., 3] = 1.0
bar[:, 15:18, :3] = 1.0
wv = fx("wave", bar, {"direction": "horizontal", "amplitude": 6, "wavelength": 32,
                      "phase": 0, "edgeBehavior": "wrap"})


def bar_at(row):
    v = wv[row, :, 0]
    return float((v * np.arange(32)).sum() / max(v.sum(), 1e-6))


eq("a wave crest slides its row by the amplitude", round(bar_at(8) - 16, 1), -6.0)
eq("...and the trough half a wavelength later slides the other way",
   round(bar_at(24) - 16, 1), 6.0)
eq("...and the row on the zero crossing does not move", round(bar_at(0) - 16, 1), 0.0)

# 33 wide puts a real pixel at the centre, and 16/33 is where that pixel is -
# a ripple centred half a pixel off would not be symmetric and this would lie.
CENTRE = 100.0 * 16.0 / 33.0
radial = np.zeros((33, 33, 4), np.float32)
yy, xx = np.mgrid[0:33, 0:33]
radial[..., :3] = (np.sqrt((xx - 16) ** 2 + (yy - 16) ** 2) / 23.0).astype(np.float32)[..., None]
radial[..., 3] = 1.0
rp = fx("ripple", radial, {"amplitude": 5, "wavelength": 10, "decay": 0,
                           "centerX": CENTRE, "centerY": CENTRE})
eq("a ripple about the centre keeps a radial picture radial",
   float(np.abs(rp[..., 0] - rp[::-1, ::-1, 0]).max()) < 1e-5, True)
eq("...and it moved something", float(np.abs(rp[..., 0] - radial[..., 0]).max()) > 0.05, True)

eq("a positive bulge magnifies (the disc grows)",
   float(fx("bulge", disc(), {"strength": 80, "radius": 60})[..., 3].sum())
   > float(disc()[..., 3].sum()), True)
eq("a negative bulge pinches (the disc shrinks)",
   float(fx("bulge", disc(), {"strength": -80, "radius": 60})[..., 3].sum())
   < float(disc()[..., 3].sum()), True)

ld = fx("lensDistortion", gradient(33, 33), {"amount": 60, "zoom": 100})
eq("lens distortion leaves the optical centre where it was",
   abs(float(ld[16, 16, 0] - gradient(33, 33)[16, 16, 0])) < 0.02, True)
eq("...and moves the corners", abs(float(ld[1, 1, 0] - gradient(33, 33)[1, 1, 0])) > 0.02, True)

mir = fx("mirror", gradient(32, 24), {"centerX": 50, "angle": 90})
eq("a vertical mirror makes the two halves reflections",
   float(np.abs(mir[:, 16:, 0] - mir[:, 15::-1, 0][:, :16]).max()) < 0.05, True)

eq("polar coordinates at 0% is a no-op", fx("polarCoords", src, {"amount": 0}) is src, True)
# rect-to-polar reads x as the angle and y as the radius, so a VERTICAL ramp
# (value by y alone) must come out as concentric rings - the same value all the
# way round any circle about the centre.
vramp = np.zeros((33, 33, 4), np.float32)
vramp[..., :3] = np.linspace(0, 1, 33, dtype=np.float32)[:, None, None]
vramp[..., 3] = 1.0
pol = fx("polarCoords", vramp, {"type": "rectToPolar", "amount": 100,
                                "centerX": CENTRE, "centerY": CENTRE})
eq("rect-to-polar turns a vertical ramp into rings about the centre",
   float(np.abs(pol[..., 0] - pol[::-1, :, 0]).max()) < 0.02, True)
eq("...and polar-to-rect is the other direction",
   float(np.abs(fx("polarCoords", vramp, {"type": "polarToRect", "amount": 100,
                                          "centerX": CENTRE, "centerY": CENTRE})[..., 0]
                - vramp[..., 0]).max()) > 0.1, True)


print("\n  -- Generate --")

half = solid(8, 8, (0.2, 0.2, 0.2), alpha=0.5)
fl = fx("fill", half, {"color": [255, 0, 0], "mode": "stencil"})
eq("a stencil fill leaves the matte exactly alone", float(fl[0, 0, 3]), 0.5)
eq("...and paints inside it", abs(float(fl[0, 0, 0]) - (0.2 + 0.5 * 0.8)) < 0.01, True)
eq("a normal fill covers everything", float(fx("fill", half, {"mode": "normal"})[0, 0, 3]), 1.0)

rm = fx("ramp", solid(32, 8, (0, 0, 0), 1.0),
        {"startX": 0, "startY": 0, "endX": 100, "endY": 0,
         "startColor": [255, 0, 0], "endColor": [0, 0, 255], "mode": "normal"})
eq("a ramp starts on its start colour", (round(float(rm[4, 0, 0]), 2),
                                         round(float(rm[4, 0, 2]), 2)), (1.0, 0.0))
# The end point is the right EDGE of the frame, half a pixel past the last
# pixel centre, so the last column is one step short of the end colour.
eq("...and ends on its end colour",
   float(rm[4, -1, 2]) > 0.95 and float(rm[4, -1, 0]) < 0.05, True)
eq("scatter dithers the ramp reproducibly",
   np.array_equal(fx("ramp", solid(32, 8), {"scatter": 50, "seed": 5}),
                  fx("ramp", solid(32, 8), {"scatter": 50, "seed": 5})), True)

ck = fx("checkerboard", solid(32, 32), {"size": 8, "colorA": [0, 0, 0],
                                        "colorB": [255, 255, 255], "mode": "normal"})
eq("neighbouring checker cells differ", abs(float(ck[4, 4, 0] - ck[4, 12, 0])) > 0.9, True)
eq("cells two apart match", abs(float(ck[4, 4, 0] - ck[4, 20, 0])) < 1e-6, True)

vg = fx("vignette", solid(64, 64, (0.8, 0.8, 0.8)), {"amount": 80, "size": 30})
eq("a vignette darkens the corners", float(vg[2, 2, 0]) < float(vg[32, 32, 0]) - 0.2, True)
eq("...and leaves the centre alone", abs(float(vg[32, 32, 0]) - 0.8) < 0.01, True)
eq("...and never touches the matte",
   np.array_equal(vg[..., 3], solid(64, 64)[..., 3]), True)

lf = fx("lensFlare", solid(64, 64, (0, 0, 0), 0.0),
        {"centerX": 25, "centerY": 75, "brightness": 60, "size": 15,
         "ghosts": 0, "streaks": 0})
peak = np.unravel_index(int(np.argmax(lf[..., 3])), lf[..., 3].shape)
eq("the flare is brightest where it was placed",
   (abs(int(peak[1]) - 16) <= 1, abs(int(peak[0]) - 48) <= 1), (True, True))
eq("...and it lights an empty layer, alpha and all", float(lf[48, 16, 3]) > 0.5, True)
eq("brightness 0 is a no-op",
   fx("lensFlare", solid(8, 8), {"brightness": 0}) is not None
   and np.array_equal(fx("lensFlare", solid(8, 8), {"brightness": 0}), solid(8, 8)), True)

gl = fx("gridLines", solid(64, 64, (0, 0, 0), 1.0),
        {"spacing": 16, "lineWidth": 1, "color": [255, 255, 255], "mode": "normal"})
eq("a grid line lands on the spacing", float(gl[32, 0, 0]) > 0.5, True)
eq("...and the gap between lines is untouched", float(gl[8, 8, 0]), 0.0)


print("\n  -- Time --")

past = [solid(16, 16, (1.0, 0.0, 0.0), 1.0) for _ in range(6)]
now = solid(16, 16, (0.0, 0.0, 1.0), 0.0)          # nothing visible this frame
ec = fx("echo", now, {"echoes": 3, "frameDelay": 1, "decay": 100, "mode": "behind"},
        history=past)
eq("an echo brings the past back when this frame is empty",
   abs(float(ec[8, 8, 0]) - 1.0) < 0.01 and float(ec[8, 8, 3]) > 0.9, True)
eq("a shorter decay makes the trail fainter",
   float(fx("echo", now, {"echoes": 3, "decay": 20, "mode": "blend"}, history=past)[8, 8, 3])
   < float(fx("echo", now, {"echoes": 3, "decay": 100, "mode": "blend"}, history=past)[8, 8, 3]),
   True)
faint = {"mode": "add", "decay": 50, "frameDelay": 1, "startingIntensity": 40}
eq("more echoes reach further back",
   float(fx("echo", now, dict(faint, echoes=1), history=past)[8, 8, 3])
   < float(fx("echo", now, dict(faint, echoes=5), history=past)[8, 8, 3]), True)
eq("echo without a past is the identity", fx("echo", now, {"echoes": 3}) is now, True)

held = [solid(16, 16, (1.0, 0.0, 0.0), 1.0) for _ in range(6)]
cur = solid(16, 16, (0.0, 1.0, 0.0), 1.0)
# 30fps posterized to 10 holds each picture for three frames: frame 12 is a
# sample, frame 13 must show what frame 12 showed.
eq("posterize time passes a sample frame straight through",
   fx("posterizeTime", cur, {"rate": 10}, t=12 / 30.0, fps=30, history=held) is cur, True)
eq("...and holds the last sample on the frames between",
   float(fx("posterizeTime", cur, {"rate": 10}, t=13 / 30.0, fps=30,
            history=held)[8, 8, 0]), 1.0)
eq("...and at full rate it does nothing at all",
   fx("posterizeTime", cur, {"rate": 30}, t=13 / 30.0, fps=30, history=held) is cur, True)


print("\n  -- Matte --")

hard = disc()
soft = fx("feather", hard, {"amount": 3})
eq("feathering turns a hard edge into a gradient",
   int(((soft[..., 3] > 0.02) & (soft[..., 3] < 0.98)).sum())
   > int(((hard[..., 3] > 0.02) & (hard[..., 3] < 0.98)).sum()), True)
eq("...and leaves the colour alone", np.array_equal(soft[..., :3], hard[..., :3]), True)
eq("a positive bias keeps more of the matte than a negative one",
   float(fx("feather", hard, {"amount": 3, "bias": 60})[..., 3].sum())
   > float(fx("feather", hard, {"amount": 3, "bias": -60})[..., 3].sum()), True)

ia = fx("invertAlpha", gradient())
eq("inverting alpha twice is the identity",
   float(np.abs(fx("invertAlpha", ia) - gradient()).max()) < 1e-6, True)
eq("an opaque pixel becomes transparent",
   float(fx("invertAlpha", solid(4, 4, alpha=1.0))[0, 0, 3]), 0.0)

pm = fx("premultiply", solid(4, 4, (1.0, 1.0, 1.0), 0.5), {"matteColor": [0, 0, 0]})
eq("premultiplying white at half alpha against black gives mid grey",
   abs(float(pm[0, 0, 0]) - 0.5) < 1e-5, True)
eq("...without moving the matte", float(pm[0, 0, 3]), 0.5)
eq("unpremultiply undoes it",
   abs(float(fx("unpremultiply", pm, {"matteColor": [0, 0, 0]})[0, 0, 0]) - 1.0) < 1e-4, True)
eq("a white matte is removed from a white-fringed edge",
   abs(float(fx("unpremultiply", solid(4, 4, (0.75, 0.75, 0.75), 0.5),
                {"matteColor": [255, 255, 255]})[0, 0, 0]) - 0.5) < 1e-4, True)


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
