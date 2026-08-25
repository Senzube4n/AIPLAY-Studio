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
import contextlib
import io
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


def ogradient(w=32, h=24):
    """The same plate, fully opaque. Any test that resamples and then asks for
    the colour back needs this one: a premultiplied round trip cannot recover
    the colour under alpha 0, so a partly-transparent plate would be measuring
    that instead of the effect."""
    a = gradient(w, h)
    a[..., 3] = 1.0
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
    "channelBlur": {"redBlur": 4, "alphaBlur": 2},
    "compoundBlur": {"maxRadius": 10, "levels": 4},
    "tritone": {},
    "colorama": {"cycles": 2},
    "shadowHighlight": {"radius": 6},
    "roughenEdges": {"border": 6, "scale": 40},
    "bevelAlpha": {"thickness": 4},
    "emboss": {},
    "turbulentDisplace": {"amount": 6, "scale": 50},
    "displacementMap": {"maxHorizontal": 5, "maxVertical": 5},
    "motionTile": {"tileWidth": 60, "tileHeight": 60, "mirrorEdges": True},
    "offset": {"shiftX": 5, "shiftY": -3},
    "twirl": {"angle": 120},
    "fractalNoise": {"scale": 60, "complexity": 3, "mode": "multiply"},
    "fourColorGradient": {"mode": "multiply"},
    "timeDifference": {},
    "minimax": {"radius": 2},
    "linearWipe": {"completion": 50, "feather": 4},
    "radialWipe": {"completion": 50, "feather": 2},
    "venetianBlinds": {"completion": 50, "width": 8},
    "blockDissolve": {"completion": 50, "blockWidth": 6, "blockHeight": 6},
    "gradientWipe": {"completion": 50},
    "irisWipe": {"completion": 50},
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
eq("every group is one the catalog also orders",
   sorted({e["group"] for e in effects.CATALOG.values()} - set(effects.GROUP_ORDER)), [])
# The spec names eight groups; Transition is a ninth, added here because a wipe
# is neither a stylize nor a matte. Anything downstream that hard-codes the
# eight drops six effects on the floor without erroring, so this pins the fact
# that the ninth exists and is deliberate.
eq("the groups are the spec's eight plus Transition", effects.GROUP_ORDER[-1], "Transition")

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
   ["echo", "posterizeTime", "timeDifference"])

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

# ── the same frame twice is the same pixels ────────────────────────────────
# Every seeded effect claims this and a render with motion blur strobes if any
# one of them is lying, so it is asserted over the whole catalog rather than
# per effect: nothing here may read the clock, a hash address or a global RNG.

eq("running an effect twice gives bit-identical pixels",
   [n for n in names
    if not np.array_equal(fx(n, PLATE.copy(), PROBE[n], t=0.7, history=HISTORY),
                          fx(n, PLATE.copy(), PROBE[n], t=0.7, history=HISTORY))], [])


# ── every advertised range is a range somebody actually ran ────────────────
# A guessed parameter NAME is rejected loudly by _coerce. A guessed RANGE is
# accepted and renders wrong, so every min, every max, every enum option and
# both sides of every bool is run here. `apply` swallows exceptions and hands
# the input straight back, which makes a raising effect indistinguishable from
# a deliberate no-op - so the witness is stderr, not the return value.

SMALL = gradient(24, 18)
SMALL_HISTORY = [np.clip(SMALL * (0.4 + 0.08 * i), 0, 1).astype(np.float32) for i in range(6)]


def run_quiet(name, params, plate=None, **ctx):
    buf = io.StringIO()
    base = {"t": 0.7, "fps": 30.0, "history": SMALL_HISTORY}
    base.update(ctx)
    with contextlib.redirect_stderr(buf):
        out = effects.apply(name, (SMALL if plate is None else plate).copy(), params, base)
    return out, buf.getvalue()


def contract_broken(out, plate):
    return (not isinstance(out, np.ndarray) or out.shape != plate.shape
            or out.dtype != np.float32 or not np.isfinite(out).all()
            or out.min() < 0.0 or out.max() > 1.0)


raised, out_of_contract, trials = [], [], 0
for n in names:
    for key, meta in effects.CATALOG[n]["params"].items():
        if meta["type"] == "number":
            edges = [{key: meta["min"]}, {key: meta["max"]}]
        elif meta["type"] == "enum":
            edges = [{key: o} for o in meta["options"]]
        elif meta["type"] == "bool":
            edges = [{key: True}, {key: False}]
        else:
            edges = []
        for extra in edges:
            trials += 1
            params = dict(PROBE[n])
            params.update(extra)
            out, err = run_quiet(n, params)
            if err:
                raised.append(f"{n}.{key}={extra[key]} {err.strip().splitlines()[0]}")
            elif contract_broken(out, SMALL):
                out_of_contract.append(f"{n}.{key}={extra[key]}")
eq("every advertised min, max and option runs without raising", raised[:5], [])
eq("...and every one of them keeps the (H,W,4) float32 0..1 contract",
   out_of_contract[:5], [])
eq("that was a real sweep, not an empty one", trials > 700, True)

# Hostile values, one parameter at a time: each must land on the catalog
# DEFAULT, bit for bit. Bools are excluded on purpose - Python truthiness has
# no invalid value, so bool("banana") is True and that is the coercion working,
# not failing.
HOSTILE = [None, "banana", "", float("nan"), float("inf"), float("-inf"), [],
           {"x": 1}, [[1, 2, 3]], [1, 2]]
not_defaulted, hostile_raised = [], []
for n in names:
    clean, _ = run_quiet(n, {})
    for key, meta in effects.CATALOG[n]["params"].items():
        if meta["type"] == "bool":
            continue
        for bad in HOSTILE:
            if meta["type"] == "color" and isinstance(bad, list) and len(bad) >= 3:
                continue                       # [[1,2,3]] IS three channels of junk
            out, err = run_quiet(n, {key: bad})
            if err:
                hostile_raised.append(f"{n}.{key}={bad!r}")
            elif not np.array_equal(out, clean):
                not_defaulted.append(f"{n}.{key}={bad!r}")
eq("a hostile parameter value never reaches an effect body", hostile_raised[:5], [])
eq("...it falls back to exactly the catalog default", not_defaulted[:5], [])


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


cb_only_red = fx("channelBlur", vedge(), {"redBlur": 5})
eq("a channel blur softens the channel it was pointed at",
   edge_step(cb_only_red) < edge_step(vedge()) * 0.6, True)
eq("...and leaves the other two exactly where they were",
   np.array_equal(cb_only_red[..., 1:3], vedge()[..., 1:3]), True)
eq("...and leaves the matte alone until alphaBlur is asked for",
   np.array_equal(cb_only_red[..., 3], vedge()[..., 3]), True)
eq("an alpha-only channel blur softens the matte and nothing else",
   (np.array_equal(fx("channelBlur", disc(), {"alphaBlur": 3})[..., :3], disc()[..., :3]),
    float(fx("channelBlur", disc(), {"alphaBlur": 3})[20, 32, 3]) > 0.0), (True, True))

# One plate, two jobs: red is the MAP (dark left, bright right) and green
# carries the detail, so the two halves can be compared without the map itself
# being the thing that got blurred.
cmap = np.zeros((16, 64, 4), np.float32)
cmap[..., 3] = 1.0
cmap[:, 32:, 0] = 1.0
cmap[:, ::4, 1] = 1.0
cmp_out = fx("compoundBlur", cmap, {"maxRadius": 6, "map": "red", "levels": 5})


def stripe_bite(a, x0, x1):
    return float(a[8, x0:x1, 1].max() - a[8, x0:x1, 1].min())


eq("a compound blur blurs where the map is bright",
   stripe_bite(cmp_out, 36, 60) < stripe_bite(cmap, 36, 60) * 0.6, True)
eq("...and leaves the picture alone where the map is dark",
   stripe_bite(cmp_out, 4, 28) > stripe_bite(cmap, 4, 28) * 0.95, True)
eq("...and inverting the map swaps which half is soft",
   stripe_bite(fx("compoundBlur", cmap, {"maxRadius": 6, "map": "red", "invert": True}),
               4, 28) < stripe_bite(cmap, 4, 28) * 0.6, True)
eq("a zero radius compound blur is a declared no-op",
   fx("compoundBlur", cmap, {"maxRadius": 0}) is cmap, True)


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


tri = {"shadowColor": [0, 0, 255], "midColor": [0, 255, 0], "highColor": [255, 0, 0],
       "midPoint": 50}
eq("a tritone puts its shadow colour on black",
   tuple(np.round(fx("tritone", solid(4, 4, (0, 0, 0)), tri)[0, 0, :3], 3)), (0.0, 0.0, 1.0))
eq("...its mid colour on the midpoint",
   tuple(np.round(fx("tritone", solid(4, 4, (0.5, 0.5, 0.5)), tri)[0, 0, :3], 2)),
   (0.0, 1.0, 0.0))
eq("...and its highlight colour on white",
   tuple(np.round(fx("tritone", solid(4, 4, (1, 1, 1)), tri)[0, 0, :3], 3)), (1.0, 0.0, 0.0))
eq("moving the midpoint moves where the mid colour lands",
   float(fx("tritone", solid(4, 4, (0.5, 0.5, 0.5)), dict(tri, midPoint=90))[0, 0, 1])
   < float(fx("tritone", solid(4, 4, (0.5, 0.5, 0.5)), tri)[0, 0, 1]), True)

pal = {"colorA": [255, 0, 0], "colorB": [0, 255, 0], "colorC": [0, 0, 255],
       "colorD": [255, 255, 255], "input": "luminance"}
eq("colorama lands on its first stop at the bottom of the range",
   tuple(np.round(fx("colorama", solid(4, 4, (0, 0, 0)), pal)[0, 0, :3], 3)), (1.0, 0.0, 0.0))
eq("...and a quarter of the way up it is on the second",
   tuple(np.round(fx("colorama", solid(4, 4, (0.25, 0.25, 0.25)), pal)[0, 0, :3], 2)),
   (0.0, 1.0, 0.0))
eq("two cycles put the halfway point back on the first stop",
   tuple(np.round(fx("colorama", solid(4, 4, (0.5, 0.5, 0.5)), dict(pal, cycles=2))[0, 0, :3], 2)),
   (1.0, 0.0, 0.0))
eq("a 90 degree phase is a quarter turn of the palette",
   tuple(np.round(fx("colorama", solid(4, 4, (0, 0, 0)), dict(pal, phase=90))[0, 0, :3], 2)),
   (0.0, 1.0, 0.0))
eq("the palette turns with time when phaseSpeed is up",
   np.array_equal(fx("colorama", hgrad(), dict(pal, phaseSpeed=1), t=0.0),
                  fx("colorama", hgrad(), dict(pal, phaseSpeed=1), t=0.5)), False)
eq("...and holds still when it is not",
   np.array_equal(fx("colorama", hgrad(), pal, t=0.0), fx("colorama", hgrad(), pal, t=9.0)),
   True)

sh = fx("shadowHighlight", hgrad(64, 4), {"shadowAmount": 100, "highlightAmount": 0,
                                          "radius": 8})
base_h = hgrad(64, 4)
eq("shadow recovery lifts the darks",
   float(sh[2, 8, 0] - base_h[2, 8, 0]) > 0.05, True)
eq("...far more than it lifts the brights",
   float(sh[2, 8, 0] - base_h[2, 8, 0]) > float(sh[2, 56, 0] - base_h[2, 56, 0]) * 3, True)
eq("...and it clips nothing: black stays black and white stays white",
   (float(fx("shadowHighlight", solid(4, 4, (0, 0, 0)), {"shadowAmount": 100})[0, 0, 0]),
    float(fx("shadowHighlight", solid(4, 4, (1, 1, 1)), {"highlightAmount": 100})[0, 0, 0])),
   (0.0, 1.0))
eq("highlight recovery pulls the brights down",
   float(fx("shadowHighlight", hgrad(64, 4), {"shadowAmount": 0, "highlightAmount": 100,
                                              "radius": 8})[2, 56, 0]) < float(base_h[2, 56, 0]),
   True)


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


big = disc(81, 81, 26)
re_a = {"border": 10, "scale": 25, "fractalInfluence": 120, "seed": 3}
rough = fx("roughenEdges", big, re_a)
eq("roughened edges leave the deep interior solid", float(rough[40, 40, 3]), 1.0)
eq("...and leave the far outside empty", float(rough[2, 2, 3]), 0.0)
eq("...but chew the edge in both directions",
   (int(((rough[..., 3] < 0.5) & (big[..., 3] > 0.5)).sum()) > 20,
    int(((rough[..., 3] > 0.5) & (big[..., 3] < 0.5)).sum()) > 20), (True, True))
eq("a cut edge only ever takes matte away",
   int(((fx("roughenEdges", big, dict(re_a, edgeType="cut"))[..., 3] > 0.5)
        & (big[..., 3] < 0.5)).sum()) < 8, True)
eq("the same seed gives the same tear",
   np.array_equal(rough, fx("roughenEdges", big, re_a)), True)
eq("a different seed gives a different one",
   np.array_equal(rough, fx("roughenEdges", big, dict(re_a, seed=4))), False)
eq("evolution crawls the edge over time",
   np.array_equal(fx("roughenEdges", big, dict(re_a, evolutionSpeed=2), t=0.0),
                  fx("roughenEdges", big, dict(re_a, evolutionSpeed=2), t=0.6)), False)
eq("...and it holds still when nothing asked it to move",
   np.array_equal(fx("roughenEdges", big, re_a, t=0.0),
                  fx("roughenEdges", big, re_a, t=4.0)), True)
rough_c = fx("roughenEdges", big, dict(re_a, edgeType="roughenColor", edgeColor=[255, 0, 0]))
eq("roughenColor paints the band it chewed and nothing else",
   (np.array_equal(rough_c[..., 3], rough[..., 3]),          # same tear
    float(rough_c[..., 1].min()) < 0.5,                      # green pulled out somewhere
    float(rough_c[40, 40, 1]), 1.0),                         # interior untouched
   (True, True, 1.0, 1.0))

bev = fx("bevelAlpha", disc(41, 41, 14, (0.5, 0.5, 0.5)),
         {"thickness": 6, "lightAngle": 0, "intensity": 200})
eq("a bevel lit from the right brightens the right rim",
   float(bev[20, 32, 0]) > 0.55, True)
eq("...and darkens the left one", float(bev[20, 8, 0]) < 0.45, True)
eq("...and never moves the matte",
   np.array_equal(bev[..., 3], disc(41, 41, 14)[..., 3]), True)
eq("turning the light round swaps the two sides",
   float(fx("bevelAlpha", disc(41, 41, 14, (0.5, 0.5, 0.5)),
            {"thickness": 6, "lightAngle": 180, "intensity": 200})[20, 8, 0]) > 0.55, True)

emb = fx("emboss", vedge(32, 24, 0.2, 0.8), {"direction": 0, "relief": 2, "contrast": 200})
eq("an emboss flattens a flat area to mid grey",
   abs(float(emb[12, 4, 0]) - 0.5) < 1e-4, True)
eq("...and turns the edge into a light-dark pair",
   float(np.abs(emb[12, :, 0] - 0.5).max()) > 0.2, True)
# The relief telescopes: summing (value - 0.5) across a row gives the total
# rise the light saw, so turning the light round must flip that total's sign.
emb_back = fx("emboss", vedge(32, 24, 0.2, 0.8),
              {"direction": 180, "relief": 2, "contrast": 200})
eq("...and reverses when the light does",
   (float((emb[12, :, 0] - 0.5).sum()) > 0.5,
    float((emb_back[12, :, 0] - 0.5).sum()) < -0.5), (True, True))


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


# A horizontal-only displacement of a picture that is CONSTANT along x cannot
# change a single pixel - whichever column it reaches for holds the same value.
# That is the cheapest exact test there is for "the y map was left alone", and
# it is the mistake (mapping both axes when one was asked for) that looks fine.
td = {"amount": 20, "scale": 40, "complexity": 3, "seed": 6}
eq("a horizontal turbulent displace cannot move a horizontally-flat plate",
   np.allclose(fx("turbulentDisplace", hedge(48, 48),
                  dict(td, displacement="horizontal")), hedge(48, 48), atol=1e-5), True)
eq("...and a vertical one cannot move a vertically-flat plate",
   np.allclose(fx("turbulentDisplace", vedge(48, 48),
                  dict(td, displacement="vertical")), vedge(48, 48), atol=1e-5), True)
eq("...while a full turbulent displace moves both",
   float(np.abs(fx("turbulentDisplace", hedge(48, 48), td) - hedge(48, 48)).max()) > 0.1, True)
eq("zero amount is a declared no-op",
   fx("turbulentDisplace", PLATE, {"amount": 0}) is PLATE, True)

pinned = fx("turbulentDisplace", ogradient(48, 48), dict(td, pinning=True))
loose = fx("turbulentDisplace", ogradient(48, 48), dict(td, pinning=False))
eq("pinning holds the frame edge exactly where it was",
   float(np.abs(pinned[0, :, :3] - ogradient(48, 48)[0, :, :3]).max()) < 1e-5, True)
eq("...and without it the edge moves like everything else",
   float(np.abs(loose[0, :, :3] - ogradient(48, 48)[0, :, :3]).max()) > 0.02, True)
eq("a different seed is a different field",
   np.array_equal(fx("turbulentDisplace", ogradient(48, 48), td),
                  fx("turbulentDisplace", ogradient(48, 48), dict(td, seed=7))), False)
eq("evolution boils it over time",
   np.array_equal(fx("turbulentDisplace", ogradient(48, 48), dict(td, evolutionSpeed=1), t=0.0),
                  fx("turbulentDisplace", ogradient(48, 48), dict(td, evolutionSpeed=1), t=0.5)),
   False)

# red is the map and green carries the mark, so the displacement can be read
# off in pixels: a full-value channel means "move by exactly maxHorizontal".
dm = np.zeros((8, 40, 4), np.float32)
dm[..., 0] = 1.0
dm[..., 3] = 1.0
dm[:, 20:22, 1] = 1.0
dmo = fx("displacementMap", dm, {"horizontalChannel": "red", "verticalChannel": "off",
                                 "maxHorizontal": 4})
eq("a full red channel displaces by exactly maxHorizontal",
   (float(dmo[4, 16, 1]), float(dmo[4, 20, 1])), (1.0, 0.0))
eq("both channels off is a declared no-op",
   fx("displacementMap", dm, {"horizontalChannel": "off", "verticalChannel": "off"}) is dm,
   True)
half_map = solid(8, 8, (0.5, 0.5, 0.5), 1.0)
half_map[:, 3, 1] = 1.0
eq("a channel sitting at 0.5 moves nothing",
   np.allclose(fx("displacementMap", half_map, {"horizontalChannel": "red",
                                                "verticalChannel": "off",
                                                "maxHorizontal": 6}), half_map, atol=1e-4),
   True)

eq("an untiled motion tile is an exact identity",
   float(np.abs(fx("motionTile", ogradient(32, 24), {}) - ogradient(32, 24)).max()) < 1e-4, True)
mt = fx("motionTile", hgrad(64, 8), {"tileWidth": 50})
eq("a half-width tile repeats the whole frame twice",
   float(np.abs(mt[:, :32, 0] - mt[:, 32:, 0]).max()) < 1e-4, True)


def worst_jump(a):
    return float(np.abs(np.diff(a[4, :, 0])).max())


eq("mirrored edges remove the seam a plain tile leaves",
   worst_jump(fx("motionTile", hgrad(64, 8), {"tileWidth": 50, "mirrorEdges": True}))
   < worst_jump(mt) * 0.2, True)
eq("phase offsets alternate rows instead of leaving a grid",
   np.array_equal(fx("motionTile", ogradient(32, 24), {"tileWidth": 50, "tileHeight": 50}),
                  fx("motionTile", ogradient(32, 24), {"tileWidth": 50, "tileHeight": 50,
                                                      "phase": 180})), False)

off5 = fx("offset", ogradient(32, 24), {"shiftX": 5})
eq("an offset slides the picture by the pixels it was given",
   float(np.abs(off5[:, 5:, 0] - ogradient(32, 24)[:, :-5, 0]).max()) < 1e-4, True)
eq("...and wraps what fell off back on the other side",
   float(np.abs(off5[:, :5, 0] - ogradient(32, 24)[:, -5:, 0]).max()) < 1e-4, True)
eq("a whole frame of offset is the identity",
   float(np.abs(fx("offset", ogradient(32, 24), {"shiftX": 32}) - ogradient(32, 24)).max())
   < 1e-4, True)
eq("speed and time do what shift does",
   np.allclose(fx("offset", ogradient(32, 24), {"speedX": 10}, t=0.5), off5, atol=1e-6), True)

CENTRE41 = 100.0 * 20.0 / 41.0
tw = fx("twirl", ogradient(41, 41), {"angle": 150, "radius": 40, "centerX": CENTRE41,
                                    "centerY": CENTRE41})
eq("a twirl leaves its own centre exactly alone",
   float(np.abs(tw[20, 20, :3] - ogradient(41, 41)[20, 20, :3]).max()) < 1e-5, True)
eq("...and leaves everything past its radius exactly alone",
   float(np.abs(tw[0, 0, :3] - ogradient(41, 41)[0, 0, :3]).max()) < 1e-5, True)
eq("...and turns what is in between",
   float(np.abs(tw[20, 28, :3] - ogradient(41, 41)[20, 28, :3]).max()) > 0.02, True)


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


BLANK = solid(64, 64, (0, 0, 0), 1.0)
fn = {"scale": 80, "complexity": 4, "seed": 12, "mode": "normal"}
noise = fx("fractalNoise", BLANK, fn)
eq("fractal noise fills the frame with something that varies",
   float(noise[..., 0].std()) > 0.05, True)
eq("...in grey, all three channels the same",
   float(np.abs(np.diff(noise[..., :3], axis=-1)).max()) < 1e-6, True)
eq("zero contrast collapses the whole field onto mid grey",
   (round(float(fx("fractalNoise", BLANK, dict(fn, contrast=0))[..., 0].std()), 6),
    round(float(fx("fractalNoise", BLANK, dict(fn, contrast=0))[0, 0, 0]), 4)), (0.0, 0.5))
eq("brightness moves the whole field",
   float(fx("fractalNoise", BLANK, dict(fn, brightness=20))[..., 0].mean())
   > float(noise[..., 0].mean()) + 0.1, True)
eq("a different seed is a different field",
   np.array_equal(noise, fx("fractalNoise", BLANK, dict(fn, seed=13))), False)

# ridged is the turbulent fold turned upside down, so at one octave the two
# must add up to exactly one everywhere. If the normalisation ever drifts
# between fractal types this is the assertion that notices.
one_oct = dict(fn, complexity=1, contrast=100, brightness=0)
turb = fx("fractalNoise", BLANK, dict(one_oct, fractalType="turbulent"))[..., 0]
ridge = fx("fractalNoise", BLANK, dict(one_oct, fractalType="ridged"))[..., 0]
eq("ridged noise is exactly the turbulent fold inverted",
   float(np.abs(turb + ridge - 1.0).max()) < 1e-5, True)

# The pattern is measured off the frame's LONG EDGE, so a half-scale preview
# has to show the same clouds as the full render. This is the assertion that a
# preview is not lying about the shot.
small_n = fx("fractalNoise", solid(64, 64, (0, 0, 0), 1.0), fn)[..., 0]
big_n = fx("fractalNoise", solid(128, 128, (0, 0, 0), 1.0), fn)[..., 0]
shrunk = big_n.reshape(64, 2, 64, 2).mean(axis=(1, 3))
# Not bit-equal, and it cannot be: at 64px the fourth octave's cells are about
# two pixels wide, so downsampling the 128px render averages detail the 64px
# render sampled. The PATTERN is what has to survive, and 0.99 correlation with
# a mean error of a few percent is a field that did not reseed itself.
eq("the same noise at twice the resolution is the same picture",
   (float(np.corrcoef(shrunk.ravel(), small_n.ravel())[0, 1]) > 0.98,
    float(np.abs(shrunk - small_n).mean()) < 0.04), (True, True))
eq("...and at one octave, where nothing aliases, it is nearly exact",
   float(np.abs(fx("fractalNoise", solid(128, 128, (0, 0, 0), 1.0),
                   dict(fn, complexity=1))[..., 0].reshape(64, 2, 64, 2).mean(axis=(1, 3))
                - fx("fractalNoise", solid(64, 64, (0, 0, 0), 1.0),
                     dict(fn, complexity=1))[..., 0]).mean()) < 0.015, True)

off_n = fx("fractalNoise", BLANK, dict(fn, complexity=1, offsetX=8))[..., 0]
flat_n = fx("fractalNoise", BLANK, dict(fn, complexity=1))[..., 0]
eq("an eight pixel offset moves the field exactly eight pixels",
   float(np.abs(off_n[:, 8:] - flat_n[:, :-8]).max()) < 1e-5, True)
eq("evolution walks the field with time",
   np.array_equal(fx("fractalNoise", BLANK, dict(fn, evolutionSpeed=1), t=0.0),
                  fx("fractalNoise", BLANK, dict(fn, evolutionSpeed=1), t=0.4)), False)
eq("...and stands still without it",
   np.array_equal(fx("fractalNoise", BLANK, fn, t=0.0),
                  fx("fractalNoise", BLANK, fn, t=7.0)), True)
eq("a stencil-mode noise never touches the matte",
   np.array_equal(fx("fractalNoise", gradient(), dict(fn, mode="stencil"))[..., 3],
                  gradient()[..., 3]), True)
eq("wrapping the overflow is not the same picture as clipping it",
   np.array_equal(fx("fractalNoise", BLANK, dict(fn, contrast=350, overflow="clip")),
                  fx("fractalNoise", BLANK, dict(fn, contrast=350, overflow="wrap"))), False)

quad = {"color1": [255, 0, 0], "color2": [0, 255, 0], "color3": [0, 0, 255],
        "color4": [255, 255, 255], "blend": 40, "mode": "normal"}
fcg = fx("fourColorGradient", solid(64, 64, (0, 0, 0), 1.0), quad)
eq("each corner of a four-colour gradient is nearest its own colour",
   (int(np.argmax(fcg[16, 16, :3])), int(np.argmax(fcg[16, 48, :3])),
    int(np.argmax(fcg[48, 16, :3]))), (0, 1, 2))
eq("a tighter blend gets closer to the pure colour",
   float(fx("fourColorGradient", solid(64, 64, (0, 0, 0), 1.0),
            dict(quad, blend=15))[16, 16, 0])
   > float(fcg[16, 16, 0]), True)
eq("jitter is seeded, so two renders match",
   np.array_equal(fx("fourColorGradient", solid(32, 32), dict(quad, jitter=80, seed=2)),
                  fx("fourColorGradient", solid(32, 32), dict(quad, jitter=80, seed=2))), True)
eq("...and a different seed dithers differently",
   np.array_equal(fx("fourColorGradient", solid(32, 32), dict(quad, jitter=80, seed=2)),
                  fx("fourColorGradient", solid(32, 32), dict(quad, jitter=80, seed=3))), False)


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


still = [solid(16, 16, (0.4, 0.6, 0.2), 1.0) for _ in range(4)]
same = solid(16, 16, (0.4, 0.6, 0.2), 1.0)
moved = solid(16, 16, (0.5, 0.6, 0.2), 1.0)
eq("nothing changed means a black frame",
   float(fx("timeDifference", same, {}, history=still)[..., :3].max()), 0.0)
eq("...and the matte is left alone while it says so",
   float(fx("timeDifference", same, {}, history=still)[0, 0, 3]), 1.0)
eq("a tenth of a change times a gain of two is a fifth",
   abs(float(fx("timeDifference", moved, {"contrast": 200}, history=still)[0, 0, 0]) - 0.2)
   < 1e-5, True)
eq("keeping the sign centres the difference on mid grey",
   abs(float(fx("timeDifference", moved, {"contrast": 100, "absolute": False},
                history=still)[0, 0, 1]) - 0.5) < 1e-5, True)
eq("a difference matte drops what did not move",
   float(fx("timeDifference", same, {"alphaMode": "difference"}, history=still)[0, 0, 3]), 0.0)
eq("time difference without a past is the identity",
   fx("timeDifference", same, {}) is same, True)
# frame 3 back is a different picture from frame 1 back
walk = [solid(16, 16, (0.1 * i, 0, 0), 1.0) for i in range(5)]
eq("the frame offset chooses which past is compared against",
   (round(float(fx("timeDifference", solid(16, 16, (0.4, 0, 0)), {"frameOffset": 1,
                                                                 "contrast": 100},
                   history=walk)[0, 0, 0]), 3),
    round(float(fx("timeDifference", solid(16, 16, (0.4, 0, 0)), {"frameOffset": 3,
                                                                  "contrast": 100},
                   history=walk)[0, 0, 0]), 3)), (0.0, 0.2))


# The engine does not hand history as a list. It hands a CALLABLE that takes
# how many frames are wanted and returns them NEWEST first, because a list
# would decode N extra frames for every layer on every frame whether or not
# anything asked. This module's docstring promised a list, oldest first, and a
# function is truthy - so `ctx.get("history") or []` swallowed the callable and
# every one of these effects died on len() of a function, inside the try/except
# that turns a raise into a silent no-op. Both shapes are read now, and this is
# the test that says so.

def as_callable(frames, spy=None):
    def history(n=1):
        if spy is not None:
            spy.append(n)
        return list(reversed(frames))[:n]      # newest first, engine order
    return history


trail = {"echoes": 3, "frameDelay": 2, "decay": 80, "mode": "add"}
eq("echo reads the engine's callable history exactly as it reads a list",
   np.array_equal(fx("echo", now, trail, history=past),
                  fx("echo", now, trail, history=as_callable(past))), True)
eq("...and it is not agreeing by both doing nothing",
   np.array_equal(fx("echo", now, trail, history=as_callable(past)), now), False)
asked = []
fx("echo", now, trail, history=as_callable(past, asked))
eq("echo asks for exactly the frames it will reach for", asked, [6])
eq("posterize time reads the callable too",
   float(fx("posterizeTime", cur, {"rate": 10}, t=13 / 30.0, fps=30,
            history=as_callable(held))[8, 8, 0]), 1.0)
eq("time difference reads the callable too",
   float(fx("timeDifference", same, {}, history=as_callable(still))[..., :3].max()), 0.0)


print("\n  -- Matte --")

holed = disc(41, 41, 14)
holed[18:23, 18:23, 3] = 0.0            # a pinhole to close
eq("a max grows the matte",
   float(fx("minimax", disc(), {"operation": "max", "radius": 2})[..., 3].sum())
   > float(disc()[..., 3].sum()), True)
eq("a min eats it",
   float(fx("minimax", disc(), {"operation": "min", "radius": 2})[..., 3].sum())
   < float(disc()[..., 3].sum()), True)
closed = fx("minimax", holed, {"operation": "maxThenMin", "radius": 4})
eq("max-then-min closes a pinhole", float(closed[20, 20, 3]), 1.0)
eq("...without moving the outer edge",
   abs(float(closed[..., 3].sum()) - float(disc(41, 41, 14)[..., 3].sum())) < 4, True)
hgrow = fx("minimax", disc(41, 41, 8), {"operation": "max", "radius": 4,
                                        "direction": "horizontal"})
eq("one axis only grows on that axis",
   (float(hgrow[20, 20 + 11, 3]), float(hgrow[20 + 11, 20, 3])), (1.0, 0.0))
eq("running minimax on colour leaves the matte alone",
   np.array_equal(fx("minimax", gradient(), {"channel": "rgb", "radius": 2})[..., 3],
                  gradient()[..., 3]), True)


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


print("\n  -- Transition --")

WIPES = sorted(n for n, e in effects.CATALOG.items() if e["group"] == "Transition")
eq("the transition group is the six wipes", len(WIPES), 6)
eq("every wipe is a declared no-op at completion 0",
   [n for n in WIPES if fx(n, PLATE, dict(PROBE[n], completion=0)) is not PLATE], [])


def gone(name, **extra):
    params = dict(PROBE[name], completion=100)
    for key in ("feather", "softness"):
        if key in effects.CATALOG[name]["params"]:
            params[key] = 60
    params.update(extra)
    return float(fx(name, PLATE, params)[..., 3].max())


eq("every wipe has removed the whole layer at completion 100, feather and all",
   [n for n in WIPES if gone(n) > 0.0], [])
eq("...and every wipe leaves the colour exactly as it found it",
   [n for n in WIPES
    if not np.array_equal(fx(n, PLATE, dict(PROBE[n], completion=40))[..., :3],
                          PLATE[..., :3])], [])

lw = fx("linearWipe", solid(32, 32, alpha=1.0), {"completion": 50, "angle": 0})
eq("a linear wipe at angle 0 takes the top half first",
   (float(lw[2, 16, 3]), float(lw[29, 16, 3])), (0.0, 1.0))
eq("...and at 90 degrees it takes the right",
   (float(fx("linearWipe", solid(32, 32, alpha=1.0),
             {"completion": 50, "angle": 90})[16, 29, 3]),
    float(fx("linearWipe", solid(32, 32, alpha=1.0),
             {"completion": 50, "angle": 90})[16, 2, 3])), (0.0, 1.0))
eq("a feather makes the edge a ramp instead of a step",
   int(((fx("linearWipe", solid(32, 32, alpha=1.0),
            {"completion": 50, "feather": 8})[..., 3] > 0.05)
        & (fx("linearWipe", solid(32, 32, alpha=1.0),
              {"completion": 50, "feather": 8})[..., 3] < 0.95)).sum()) > 100, True)

rw = fx("radialWipe", solid(33, 33, alpha=1.0), {"completion": 25, "centerX": CENTRE,
                                                 "centerY": CENTRE})
eq("a clockwise radial wipe eats the first quarter turn from twelve o'clock",
   (float(rw[4, 24, 3]), float(rw[4, 8, 3])), (0.0, 1.0))
eq("counterclockwise eats the other side",
   float(fx("radialWipe", solid(33, 33, alpha=1.0),
            {"completion": 25, "wipe": "counterclockwise", "centerX": CENTRE,
             "centerY": CENTRE})[4, 8, 3]), 0.0)

vb = fx("venetianBlinds", solid(32, 32, alpha=1.0), {"completion": 50, "width": 8,
                                                     "direction": 0})
eq("blinds repeat on their width",
   float(np.abs(vb[0:8, 0, 3] - vb[8:16, 0, 3]).max()), 0.0)
# not exactly half: eight rows per slat can only ever land on eighths, and the
# row sitting exactly on the threshold is the half-lit one
eq("...and about half of each slat is gone at fifty percent",
   0.42 < float(vb[:, 0, 3].mean()) < 0.58, True)
eq("...and they do not vary along the slat",
   float(vb[:, :, 3].std(axis=1).max()), 0.0)

bd = fx("blockDissolve", solid(32, 32, alpha=1.0), {"completion": 50, "blockWidth": 8,
                                                    "blockHeight": 8, "seed": 3})
eq("a block dissolve is uniform inside one block", float(bd[0:8, 0:8, 3].std()), 0.0)
eq("...and roughly half gone at fifty percent",
   abs(float(bd[..., 3].mean()) - 0.5) < 0.3, True)
eq("...and the same seed dissolves in the same order",
   np.array_equal(bd, fx("blockDissolve", solid(32, 32, alpha=1.0),
                         {"completion": 50, "blockWidth": 8, "blockHeight": 8, "seed": 3})),
   True)
eq("...while another seed does not",
   np.array_equal(bd, fx("blockDissolve", solid(32, 32, alpha=1.0),
                         {"completion": 50, "blockWidth": 8, "blockHeight": 8, "seed": 4})),
   False)

gw = fx("gradientWipe", hgrad(32, 8), {"completion": 50, "source": "luminance",
                                       "softness": 0})
eq("a luminance gradient wipe takes the dark end first",
   (float(gw[4, 2, 3]), float(gw[4, 29, 3])), (0.0, 1.0))
eq("...and inverting it takes the bright end",
   float(fx("gradientWipe", hgrad(32, 8), {"completion": 50, "source": "luminance",
                                           "softness": 0, "invert": True})[4, 29, 3]), 0.0)
eq("a noise gradient wipe is organic rather than ordered",
   float(fx("gradientWipe", solid(48, 48, alpha=1.0),
            {"completion": 50, "source": "noise", "noiseScale": 60})[..., 3].std()) > 0.3,
   True)

iw = fx("irisWipe", solid(41, 41, alpha=1.0), {"completion": 50, "shape": "circle",
                                               "centerX": CENTRE41, "centerY": CENTRE41})
eq("a closing iris keeps the middle and drops the corner",
   (float(iw[20, 20, 3]), float(iw[0, 0, 3])), (1.0, 0.0))
eq("an inverted iris does the opposite",
   (float(fx("irisWipe", solid(41, 41, alpha=1.0),
             {"completion": 50, "invert": True, "centerX": CENTRE41,
              "centerY": CENTRE41})[20, 20, 3]),
    float(fx("irisWipe", solid(41, 41, alpha=1.0),
             {"completion": 50, "invert": True, "centerX": CENTRE41,
              "centerY": CENTRE41})[0, 0, 3])), (0.0, 1.0))
eq("a diamond iris is not a circle",
   np.array_equal(iw, fx("irisWipe", solid(41, 41, alpha=1.0),
                         {"completion": 50, "shape": "diamond", "centerX": CENTRE41,
                          "centerY": CENTRE41})), False)

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
