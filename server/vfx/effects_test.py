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
import hashlib
import io
import math
import os
import sys
import time

import cv2
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


def lmap(w, h, red=0.5, green=0.5, blue=0.5, alpha=1.0):
    """A FLAT control layer. A constant channel makes a displacement a number
    instead of a reading: the map is (v - 0.5) * 2, so 1.0 is exactly +1 and
    0.0 is exactly -1, and the pixel that lands somewhere can be named."""
    a = np.zeros((h, w, 4), np.float32)
    a[..., 0], a[..., 1], a[..., 2], a[..., 3] = red, green, blue, alpha
    return a


def halves(bright, w=64, h=16):
    """Opaque black with one half white - a control layer whose luminance says
    "blur here, not there" with no gradient to argue about."""
    a = solid(w, h, (0.0, 0.0, 0.0), 1.0)
    if bright == "right":
        a[:, w // 2:, :3] = 1.0
    else:
        a[:, :w // 2, :3] = 1.0
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
    "addGrain": {"intensity": 80},
    "median": {"radius": 2, "operateOnAlpha": True},
    "dustScratches": {"radius": 2, "threshold": 0},
    "reduceNoise": {"lumaSmoothing": 60, "chromaSmoothing": 80},
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
    "setMatte": {"use": "luminance"},
    "differenceMatte": {"tolerance": 20},
    # The Expression Controls: values that would be VISIBLE if any of them
    # touched a pixel, which is exactly what the sweeps must prove they do not.
    "sliderControl": {"value": 4200},
    "pointControl": {"point": [120, -45]},
    "point3DControl": {"point": [120, -45, 300]},
    "angleControl": {"angle": 1080},
    "checkboxControl": {"checkbox": True},
    "colorControl": {"color": [10, 200, 30, 128]},
}

# The five that read a SECOND LAYER, and what each needs to be actually reading
# one rather than just carrying its name. The reference param is deliberately
# not listed: it is read off the catalog below, which is what makes a sixth
# layer-reading effect join these sweeps by existing.
LAYER_PROBE = {
    "displacementMap": {"horizontalChannel": "red", "maxHorizontal": 5},
    "compoundBlur": {"maxRadius": 8, "levels": 3},
    "setMatte": {"use": "luminance"},
    "differenceMatte": {"tolerance": 20},
    "gradientWipe": {"completion": 50, "source": "luminance"},
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
# The spec names eight groups; Transition is a ninth (a wipe is neither a
# stylize nor a matte), Noise & Grain a tenth (grain on and noise off are one
# family, and neither is a stylize), and Expression Controls an eleventh whose
# effects render nothing at all. Anything downstream that hard-codes a shorter
# list drops whole groups on the floor without erroring, so the FULL list is
# pinned here - a group added or renamed must show up in this line.
eq("the groups are the spec's eight, plus the three deliberate additions",
   effects.GROUP_ORDER,
   ["Blur & Sharpen", "Color", "Keying", "Stylize", "Noise & Grain",
    "Distort", "Generate", "Time", "Matte", "Transition",
    "Expression Controls"])

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
        elif kind == "layer":
            # A layer reference that defaulted to naming a layer would make a
            # freshly added effect reach for somebody else's pixels.
            if d != "":
                bad_param.append(where + " (a layer param must default to no layer)")
        elif kind == "point":
            # 2 or 3 components, each a finite number inside the param's own
            # range - len(default) is the arity the JS side validates keys by,
            # so a default of the wrong length is a param nobody can keyframe.
            if ("min" not in p or "max" not in p or len(d) not in (2, 3)
                    or not all(isinstance(c, float) and math.isfinite(c)
                               and p["min"] <= c <= p["max"] for c in d)):
                bad_param.append(where + " (point default not 2-3 finite in-range floats)")
        else:
            bad_param.append(where + f" (unknown type {kind})")
eq("every catalog param is described with a default inside its own range", bad_param, [])
eq("every effect has a probe in this test file",
   sorted(set(effects.CATALOG) - set(PROBE)), [])
eq("effects needing previous frames say so",
   sorted(n for n, e in effects.CATALOG.items() if e.get("needsHistory")),
   ["echo", "posterizeTime", "timeDifference"])

# A `layer` param IS the message to the engine - there is no separate flag to
# forget to set - so this pins the list the engine has to resolve for.
LAYER_PARAM = {n: [k for k, q in e["params"].items() if q["type"] == "layer"]
               for n, e in effects.CATALOG.items()}
LAYERED = sorted(n for n, k in LAYER_PARAM.items() if k)
eq("the effects that read a second layer are the five that say so", LAYERED,
   ["compoundBlur", "differenceMatte", "displacementMap", "gradientWipe", "setMatte"])
eq("...each naming exactly one layer, so the engine resolves one per effect",
   [n for n in LAYERED if len(LAYER_PARAM[n]) != 1], [])
eq("...and each carrying a mapFit with the same three answers to a size mismatch",
   [n for n in LAYERED
    if effects.CATALOG[n]["params"].get("mapFit", {}).get("options") != effects.MAP_FITS], [])
eq("...and a probe that actually reads one", sorted(set(LAYERED) - set(LAYER_PROBE)), [])
LAYER_KEY = {n: LAYER_PARAM[n][0] for n in LAYERED}

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
        elif meta["type"] == "point":
            edges = [{key: [meta["min"]] * len(meta["default"])},
                     {key: [meta["max"]] * len(meta["default"])}]
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

# The map on ANOTHER layer. The plate is flat apart from a square wave, so its
# own luminance says "blur everything the same" and any variation across the
# frame has to have come from the control layer. Two mirrored control layers,
# identical parameters, opposite halves softened - which is the only way to
# show the layer is driving rather than coinciding.
cbp = solid(64, 16, (0.5, 0.5, 0.5), 1.0)
cbp[:, (np.arange(64) % 8) < 4, 2] = 0.6
CB = {"maxRadius": 6, "levels": 5, "map": "luminance"}


def wave(a, x0, x1):
    """How much of the square wave survives between two columns - the local
    blur, measured rather than inferred."""
    return float(a[8, x0:x1, 2].max() - a[8, x0:x1, 2].min())


cb_r = fx("compoundBlur", cbp, dict(CB, blurLayer="depth"),
          layerPixels={"depth": halves("right")})
cb_l = fx("compoundBlur", cbp, dict(CB, blurLayer="depth"),
          layerPixels={"depth": halves("left")})
eq("a compound blur takes its local radius off the layer it was pointed at",
   (wave(cb_r, 36, 60) < wave(cbp, 36, 60) * 0.25,
    wave(cb_r, 4, 28) > wave(cbp, 4, 28) * 0.99), (True, True))
eq("...so a mirrored control layer softens the other half on the same settings",
   (wave(cb_l, 4, 28) < wave(cbp, 4, 28) * 0.25,
    wave(cb_l, 36, 60) > wave(cbp, 36, 60) * 0.99), (True, True))
# A ramp is the real claim: not two flat zones but a blur that grows.
cb_ramp = fx("compoundBlur", cbp, dict(CB, blurLayer="depth"),
             layerPixels={"depth": hgrad(64, 16)})
eq("...and a ramp gives a blur that genuinely varies across the frame",
   wave(cb_ramp, 4, 12) > wave(cb_ramp, 20, 28) > wave(cb_ramp, 36, 44), True)
eq("a control layer that cannot be produced falls back to this layer's own map",
   np.array_equal(fx("compoundBlur", cmap, {"maxRadius": 6, "map": "red", "levels": 5,
                                            "blurLayer": "missing"}), cmp_out), True)


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

# Difference matte: a clean plate and a shot with something in half of it.
dm_plate = solid(16, 16, (0.2, 0.3, 0.4), 1.0)
dm_shot = dm_plate.copy()
dm_shot[:, 8:, 0] = 0.8
DM = {"differenceLayer": "plate", "tolerance": 10, "softness": 10}
dmk = fx("differenceMatte", dm_shot, DM, layerPixels={"plate": dm_plate})
eq("a difference matte keys out what matches the plate", float(dmk[8, 2, 3]), 0.0)
eq("...and keeps every bit of what moved", float(dmk[8, 12, 3]), 1.0)
eq("...without moving a colour value", np.array_equal(dmk[..., :3], dm_shot[..., :3]), True)
dmi = fx("differenceMatte", dm_shot, dict(DM, invert=True), layerPixels={"plate": dm_plate})
eq("inverted it keeps the plate and drops what moved",
   (float(dmi[8, 2, 3]), float(dmi[8, 12, 3])), (1.0, 0.0))
dmv = fx("differenceMatte", dm_shot, dict(DM, view="matte"), layerPixels={"plate": dm_plate})
eq("view matte shows the key itself as opaque grey",
   (float(dmv[8, 2, 0]), float(dmv[8, 12, 0]), float(dmv[8, 2, 3])), (0.0, 1.0, 1.0))
eq("a tolerance of 100 calls everything a match and the frame goes",
   float(fx("differenceMatte", dm_shot, dict(DM, tolerance=100),
            layerPixels={"plate": dm_plate})[..., 3].max()), 0.0)
# A plate that drifted in colour but not in level is exactly what matchOn is for.
dm_tint = dm_plate.copy()
dm_tint[..., 0] = 0.5
eq("an rgb match loses a plate whose colour drifted",
   float(fx("differenceMatte", dm_shot, DM, layerPixels={"plate": dm_tint})[8, 2, 3]) > 0.5,
   True)
eq("...where a luminance match holds it",
   float(fx("differenceMatte", dm_shot, dict(DM, matchOn="luminance"),
            layerPixels={"plate": dm_tint})[8, 2, 3]), 0.0)
eq("with no plate named it is a declared no-op, not an empty frame",
   fx("differenceMatte", dm_shot, {"tolerance": 40}) is dm_shot, True)


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


print("\n  -- Noise & Grain --")

# `noise` moved here from Stylize; the group changed and the pixels did not.
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

# clipResultValues off is the 8-bit overflow look: only what LEFT the range
# wraps. On a white plate the positive half of the noise overflows and comes
# back as near-black speckle; the negative half never left 0..1 and must be
# bit-identical to the clipped version.
white = solid(24, 24, (1.0, 1.0, 1.0))
n_clip = fx("noise", white, {"amount": 60, "seed": 3})
n_wrap = fx("noise", white, {"amount": 60, "seed": 3, "clipResultValues": False})
eq("wrap-around drags the overflowed half of a white plate down",
   float(n_wrap[..., :3].mean()) < float(n_clip[..., :3].mean()) - 0.15, True)
eq("...while every pixel that never overflowed is bit-identical",
   float((n_wrap[..., 0] == n_clip[..., 0]).mean()) > 0.3, True)

# addGrain is ALWAYS animated - that is its contract. Same (seed, frame) is
# the same pattern; the very next frame is a fresh one; none of it reads a
# clock, which the whole-catalog determinism sweep above already pinned.
gr = {"intensity": 60, "seed": 5}
g1 = fx("addGrain", gradient(), gr, t=1.0)
eq("the same seed and frame give exactly the same grain",
   np.array_equal(g1, fx("addGrain", gradient(), gr, t=1.0)), True)
eq("a different seed is a different grain",
   np.array_equal(g1, fx("addGrain", gradient(), dict(gr, seed=6), t=1.0)), False)
eq("the grain is alive: the very next frame is a fresh pattern",
   np.array_equal(g1, fx("addGrain", gradient(), gr, t=1.0 + 1.0 / 30.0)), False)

grey = solid(32, 24, (0.5, 0.5, 0.5))
d_mono = fx("addGrain", grey, {"intensity": 30, "saturation": 0, "seed": 2}, t=0.5) - grey
eq("saturation 0 is silver grain - one delta across all three channels",
   (np.array_equal(d_mono[..., 0], d_mono[..., 1]),
    np.array_equal(d_mono[..., 1], d_mono[..., 2])), (True, True))
d_col = fx("addGrain", grey, {"intensity": 30, "saturation": 100, "seed": 2}, t=0.5) - grey
eq("saturation 100 is colour grain - the channels disagree",
   np.array_equal(d_col[..., 0], d_col[..., 1]), False)

# The renormalisation claim: intensity 50 is a deviation of 0.1 whatever the
# size and softness, or the two shape sliders quietly become intensity sliders.
big_grey = solid(64, 64, (0.5, 0.5, 0.5))
sd_hard = float((fx("addGrain", big_grey, {"intensity": 50, "seed": 4}) - big_grey)[..., 0].std())
sd_soft = float((fx("addGrain", big_grey, {"intensity": 50, "seed": 4, "size": 4,
                                           "softness": 80}) - big_grey)[..., 0].std())
eq("intensity means the same thing at every size and softness",
   (abs(sd_hard - 0.1) < 0.01, abs(sd_soft - 0.1) < 0.01), (True, True))

speck = solid(24, 24, (0.5, 0.5, 0.5))
speck[12, 12, :3] = 1.0
md = fx("median", speck, {"radius": 1})
eq("a median eats a single-pixel speck", float(md[12, 12, 0]), 0.5)
eq("...and leaves the flat field flat", float(np.abs(md[..., :3] - 0.5).max()), 0.0)
ed = vedge(32, 24)
eq("an edge survives the median that a blur of the same reach would smear",
   edge_step(fx("median", ed, {"radius": 2}))
   > edge_step(fx("gaussianBlur", ed, {"radius": 2})) * 2.0, True)
q8 = fx("median", ogradient(48, 24), {"radius": 3})[..., :3] * 255.0
eq("radius 3 rides the 8-bit median and admits it - every value is a whole level",
   float(np.abs(q8 - np.round(q8)).max()) < 1e-3, True)
holes = disc(25, 25, 8)
eq("the matte is untouched unless asked",
   np.array_equal(fx("median", holes, {"radius": 2})[..., 3], holes[..., 3]), True)
eq("...and filtered when asked",
   np.array_equal(fx("median", holes, {"radius": 2, "operateOnAlpha": True})[..., 3],
                  holes[..., 3]), False)

dust = solid(24, 24, (0.5, 0.5, 0.5))
dust[6, 6, :3] = 1.0                 # a dust spot
dust[15, 3:9, :3] = 0.0              # a one-pixel-tall scratch line
ds = fx("dustScratches", dust, {"radius": 2, "threshold": 60})
eq("dust past the threshold is repaired to the neighbourhood's median",
   float(ds[6, 6, 0]), 0.5)
eq("...and a scratch line goes with it", float(ds[15, 5, 0]), 0.5)
eq("...while everything under the threshold is BIT-identical, not smoothed",
   np.array_equal(ds[0:4], dust[0:4]), True)
eq("threshold 255 changes nothing at all",
   np.array_equal(fx("dustScratches", dust, {"radius": 2, "threshold": 255}), dust), True)
eq("threshold 0 is a plain median",
   np.array_equal(fx("dustScratches", dust, {"radius": 2, "threshold": 0}),
                  fx("median", dust, {"radius": 2})), True)

_dn_rng = np.random.default_rng(99)
noisy = solid(48, 48, (0.5, 0.4, 0.3))
noisy[..., :3] = np.clip(noisy[..., :3]
                         + _dn_rng.normal(0, 0.08, (48, 48, 3)), 0, 1).astype(np.float32)
rn = fx("reduceNoise", noisy, {"lumaSmoothing": 60, "chromaSmoothing": 80, "radius": 4})
eq("it actually REMOVES noise: a flat field's deviation drops by half",
   float(rn[..., 0].std()) < float(noisy[..., 0].std()) * 0.5, True)
noisy_edge = vedge(48, 24)
noisy_edge[..., :3] = np.clip(noisy_edge[..., :3]
                              + _dn_rng.normal(0, 0.05, (24, 48, 3)), 0, 1).astype(np.float32)
eq("...without crossing an edge",
   edge_step(fx("reduceNoise", noisy_edge,
                {"lumaSmoothing": 60, "chromaSmoothing": 80})) > 0.5, True)
eq("zero smoothing on both channels is a true no-op",
   np.array_equal(fx("reduceNoise", noisy, {"lumaSmoothing": 0, "chromaSmoothing": 0}),
                  noisy), True)


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

# The map on ANOTHER layer, read off in whole pixels. The plate carries one
# green mark and the map is flat, so where the mark lands IS the displacement.
mark = np.zeros((24, 40, 4), np.float32)
mark[..., 3] = 1.0
mark[12, 20, 1] = 1.0
DMAP = {"horizontalChannel": "red", "verticalChannel": "off", "maxHorizontal": 4,
        "mapLayer": "map"}
eq("a map layer at full red moves the picture by exactly maxHorizontal",
   (float(fx("displacementMap", mark, DMAP,
             layerPixels={"map": lmap(40, 24, red=1.0)})[12, 16, 1]),
    float(fx("displacementMap", mark, DMAP,
             layerPixels={"map": lmap(40, 24, red=1.0)})[12, 20, 1])), (1.0, 0.0))
eq("...and at zero exactly as far the other way",
   (float(fx("displacementMap", mark, DMAP,
             layerPixels={"map": lmap(40, 24, red=0.0)})[12, 24, 1]),
    float(fx("displacementMap", mark, DMAP,
             layerPixels={"map": lmap(40, 24, red=0.0)})[12, 20, 1])), (1.0, 0.0))
eq("...while mid grey on another layer is exactly no movement, same as on this one",
   np.array_equal(fx("displacementMap", mark, DMAP,
                     layerPixels={"map": lmap(40, 24, red=0.5)}), mark), True)
eq("the vertical axis reads its own channel and its own amount",
   (float(fx("displacementMap", mark,
             {"horizontalChannel": "off", "verticalChannel": "green", "maxVertical": 6,
              "mapLayer": "map"}, layerPixels={"map": lmap(40, 24, green=1.0)})[6, 20, 1]),
    float(fx("displacementMap", mark,
             {"horizontalChannel": "off", "verticalChannel": "green", "maxVertical": 6,
              "mapLayer": "map"}, layerPixels={"map": lmap(40, 24, green=1.0)})[12, 20, 1])),
   (1.0, 0.0))
eq("...and the two axes run independently, different channels and different amounts",
   float(fx("displacementMap", mark,
            {"horizontalChannel": "red", "verticalChannel": "green", "maxHorizontal": 4,
             "maxVertical": 6, "mapLayer": "map"},
            layerPixels={"map": lmap(40, 24, red=1.0, green=0.0)})[18, 16, 1]), 1.0)
# A flat map says the same thing at every size, so all three fits must agree on
# it - which is the fit being applied rather than the map being ignored.
eq("a flat map half the size displaces identically under all three fits",
   sorted({float(fx("displacementMap", mark, dict(DMAP, mapFit=m),
                    layerPixels={"map": lmap(20, 12, red=1.0)})[12, 16, 1])
           for m in effects.MAP_FITS}), [1.0])
eq("a map layer that could not be produced falls back to this layer",
   np.array_equal(fx("displacementMap", dm, dict(PROBE["displacementMap"],
                                                 mapLayer="missing")),
                  fx("displacementMap", dm, PROBE["displacementMap"])), True)

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

sm_tgt = solid(24, 16, (0.2, 0.4, 0.6), 1.0)
sm_matte = solid(24, 16, (1.0, 1.0, 1.0), 1.0)
sm_matte[..., 3] = np.linspace(0, 1, 24, dtype=np.float32)[None, :]
sm = fx("setMatte", sm_tgt, {"matteLayer": "m"}, layerPixels={"m": sm_matte})
eq("set matte transfers another layer's alpha EXACTLY, not approximately",
   np.array_equal(sm[..., 3], sm_matte[..., 3]), True)
eq("...and does not touch one colour value doing it",
   np.array_equal(sm[..., :3], sm_tgt[..., :3]), True)
eq("...inverted, it is exactly one minus that alpha",
   np.array_equal(fx("setMatte", sm_tgt, {"matteLayer": "m", "invertMatte": True},
                     layerPixels={"m": sm_matte})[..., 3], 1.0 - sm_matte[..., 3]), True)
eq("combine multiply keeps only what both layers cover",
   np.array_equal(fx("setMatte", solid(24, 16, (0.2, 0.4, 0.6), 0.5),
                     {"matteLayer": "m", "combine": "multiply"},
                     layerPixels={"m": sm_matte})[..., 3], sm_matte[..., 3] * 0.5), True)
eq("...and amount blends back towards the matte the layer arrived with",
   float(fx("setMatte", solid(4, 4, alpha=1.0), {"matteLayer": "m", "amount": 50},
            layerPixels={"m": solid(4, 4, alpha=0.0)})[0, 0, 3]), 0.5)
eq("taking the matte from a layer's luminance is brightness becoming transparency",
   float(np.abs(fx("setMatte", sm_tgt, {"matteLayer": "m", "use": "luminance"},
                   layerPixels={"m": hgrad(24, 16)})[..., 3]
                - np.linspace(0, 1, 24, dtype=np.float32)[None, :]).max()) < 1e-6, True)
eq("a set matte with nothing named and nothing changed is the exact identity",
   np.array_equal(fx("setMatte", gradient(), {}), gradient()), True)
eq("...and a matte layer that could not be produced reads this layer's own channel",
   np.array_equal(fx("setMatte", gradient(), {"use": "luminance", "matteLayer": "missing"}),
                  fx("setMatte", gradient(), {"use": "luminance"})), True)


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
# The plate is flat and bright, so nothing IN it can order a dissolve: the
# ordering can only have come from the control layer. At completion 50 with no
# softness the threshold sits at 0.49995, so the sixteen columns whose control
# luminance is above one half survive and the sixteen below are gone - the half
# the luminance ordering says, to the pixel.
gw_flat = solid(32, 8, (0.8, 0.8, 0.8), 1.0)
gwl = fx("gradientWipe", gw_flat, {"completion": 50, "softness": 0, "source": "luminance",
                                   "gradientLayer": "g"}, layerPixels={"g": hgrad(32, 8)})
eq("a gradient layer at fifty percent passes exactly the half its luminance orders",
   (float(gwl[..., 3].sum()), float(gwl[4, 15, 3]), float(gwl[4, 16, 3])), (128.0, 0.0, 1.0))
eq("...and inverting it passes exactly the other half",
   (float(fx("gradientWipe", gw_flat, {"completion": 50, "softness": 0,
                                       "source": "luminance", "invert": True,
                                       "gradientLayer": "g"},
             layerPixels={"g": hgrad(32, 8)})[..., 3].sum()),
    float(fx("gradientWipe", gw_flat, {"completion": 50, "softness": 0,
                                       "source": "luminance", "invert": True,
                                       "gradientLayer": "g"},
             layerPixels={"g": hgrad(32, 8)})[4, 16, 3])), (128.0, 0.0))
eq("...while the same wipe with no layer reads the flat plate and takes nothing",
   float(fx("gradientWipe", gw_flat, {"completion": 50, "softness": 0,
                                      "source": "luminance"})[..., 3].min()), 1.0)
eq("a gradient layer replaces the noise field rather than being ignored beside it",
   np.array_equal(fx("gradientWipe", gw_flat, {"completion": 50, "softness": 0,
                                               "source": "noise", "gradientLayer": "g"},
                     layerPixels={"g": hgrad(32, 8)}), gwl), True)
gw_notes = []
fx("gradientWipe", gw_flat, {"completion": 50, "source": "noise", "gradientLayer": "g"},
   layerPixels={"g": hgrad(32, 8)}, notes=gw_notes)
eq("...and says out loud that it did", len(gw_notes), 1)

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

print("\n  -- Expression Controls --")

# A control is a parameter carrier: it exists to be keyframed and read by
# expressions, and it must cost NOTHING at render time. "Nothing" is testable
# as identity: apply() answers with the very object it was handed, which is
# the declared no-op the contract already names for an unknown effect - so
# no clip pass ran, no copy was made, no pixel was visited.
CONTROLS = sorted(n for n, e in effects.CATALOG.items()
                  if e["group"] == "Expression Controls")
eq("the control family is the five that made the cut (dropdown refused: the "
   "catalog cannot carry per-instance menu entries)",
   CONTROLS, ["angleControl", "checkboxControl", "colorControl",
              "point3DControl", "pointControl", "sliderControl"])
eq("dropdownControl stayed refused", "dropdownControl" in effects.CATALOG, False)
eq("every control answers with the INPUT OBJECT - the no-op is identity, "
   "not equality",
   [n for n in CONTROLS if fx(n, PLATE, PROBE[n], t=0.5) is not PLATE], [])
eq("...none claims to touch alpha",
   [n for n in CONTROLS if effects.CATALOG[n]["touchesAlpha"]], [])
eq("...and every parameter on every control is animatable - a control whose "
   "value cannot be keyframed is dead weight",
   [f"{n}.{k}" for n in CONTROLS
    for k, p in effects.CATALOG[n]["params"].items() if not p["animatable"]], [])

# The values expressions will read arrive through _coerce like anything else,
# so the point type's clamping is pinned here even though no pixel depends on
# it: the catalog range is what MCP advertises, and an advertised range that
# does not hold is a lie an agent acts on.
_pt_spec = effects.CATALOG["pointControl"]["params"]
eq("a point coerces to floats inside its advertised range",
   effects._coerce(_pt_spec, {"point": [2e7, -2e7]})["point"],
   [1000000.0, -1000000.0])
eq("...a short, scalar or non-finite point lands on the default whole",
   [effects._coerce(_pt_spec, {"point": bad})["point"]
    for bad in ([1], 5, [float("nan"), 0], "x", None)],
   [[0.0, 0.0]] * 5)
eq("...and a 3D point keeps its three components",
   effects._coerce(effects.CATALOG["point3DControl"]["params"],
                   {"point": [1.5, -2.5, 3.5]})["point"], [1.5, -2.5, 3.5])
eq("a colour control keeps all four 0-255 channels",
   effects._coerce(effects.CATALOG["colorControl"]["params"],
                   {"color": [300, -5, 128, 64]})["color"], [255.0, 0.0, 128.0, 64.0])


print("\n  -- second-layer inputs --")

# THE ASSERTION THAT STOPS THIS BEING A BREAKING CHANGE. These digests were
# taken from the three older effects at the commit BEFORE they learned to read
# a second layer, running the params below on gradient(32, 24) at t=0.7. A
# failure means the no-layer path moved, which is the one thing adding the
# layer path was not allowed to do. (A cv2 upgrade could move them too - check
# the difference is a rounding change before anyone re-baselines these.)
NO_LAYER_GOLD = [
    ("displacementMap", {"horizontalChannel": "red", "verticalChannel": "green",
                         "maxHorizontal": 5, "maxVertical": 5}, "a62152f9ef4fb80a"),
    ("displacementMap", {"horizontalChannel": "luminance", "verticalChannel": "alpha",
                         "maxHorizontal": -12, "maxVertical": 9, "blurMap": 3,
                         "edgeBehavior": "mirror"}, "81c8c432e8f6d376"),
    ("displacementMap", {"horizontalChannel": "blue", "verticalChannel": "off",
                         "maxHorizontal": 40, "edgeBehavior": "wrap"}, "ec5f36e63c94f15a"),
    ("compoundBlur", {"maxRadius": 10, "levels": 4}, "a6bcfe1eb04dc823"),
    ("compoundBlur", {"maxRadius": 30, "map": "alpha", "levels": 7, "invert": True,
                      "edgeBehavior": "transparent"}, "aebb7bd8a2cc8ac2"),
    ("compoundBlur", {"maxRadius": 3, "map": "green", "levels": 2}, "18615c20e46ce518"),
    ("gradientWipe", {"completion": 50}, "e83489138c976d65"),
    ("gradientWipe", {"completion": 70, "source": "luminance", "softness": 40,
                      "invert": True}, "d28a416cdb150ff3"),
    ("gradientWipe", {"completion": 35, "source": "alpha", "softness": 0},
     "ed1a4e639fc1d7a9"),
    ("gradientWipe", {"completion": 35, "source": "noise", "noiseScale": 60,
                      "noiseComplexity": 5, "noiseSeed": 9}, "19a0081840c5a87a"),
]
drifted = []
for name, params, want in NO_LAYER_GOLD:
    out = fx(name, gradient(32, 24), params, t=0.7)
    got = hashlib.sha1(np.ascontiguousarray(out, np.float32).tobytes()).hexdigest()[:16]
    if got != want:
        drifted.append(f"{name} {sorted(params)} -> {got}")
eq("with no layer supplied, every older effect is bit-identical to before the contract",
   drifted, [])

# _fit_map is pure index arithmetic for two of its three modes, so the
# placement can be written out in full rather than described.
tiny = np.array([[0.0, 1.0], [2.0, 3.0]], np.float32)
eq("center pins a small map 1:1 in the middle and repeats its border outward",
   effects._fit_map(tiny, 4, 4, "center").tolist(),
   [[0, 0, 1, 1], [0, 0, 1, 1], [2, 2, 3, 3], [2, 2, 3, 3]])
eq("tile pins it identically and repeats the map instead",
   effects._fit_map(tiny, 4, 4, "tile").tolist(),
   [[3, 2, 3, 2], [1, 0, 1, 0], [3, 2, 3, 2], [1, 0, 1, 0]])
eq("...so the two differ only outside the map, never inside it",
   (effects._fit_map(tiny, 4, 4, "center")[1:3, 1:3].tolist()
    == effects._fit_map(tiny, 4, 4, "tile")[1:3, 1:3].tolist()), True)
stretched = effects._fit_map(tiny, 4, 4, "stretch")
eq("stretch resamples the map over the whole frame, corners and all",
   (stretched.shape, float(stretched[0, 0]), float(stretched[-1, -1])), ((4, 4), 0.0, 3.0))
eq("a map bigger than the frame is cropped from the middle",
   effects._fit_map(np.arange(16, dtype=np.float32).reshape(4, 4), 2, 2, "center").tolist(),
   [[5, 6], [9, 10]])
eq("a map already the right size is handed back, not copied - which is what "
   "keeps the no-layer path free",
   effects._fit_map(tiny, 2, 2, "stretch") is tiny, True)

# Every fit mode, every effect, on a map that is neither the plate's size nor a
# whole fraction of it - and the two shapes ctx["layerPixels"] can arrive in
# must resolve to the same pixels.
MAPPX = gradient(21, 13)
bad_fit, two_shapes = [], []
for n in LAYERED:
    for mode in effects.MAP_FITS:
        params = dict(LAYER_PROBE[n], mapFit=mode)
        params[LAYER_KEY[n]] = "src"
        one = fx(n, PLATE.copy(), params, t=0.7, layerPixels={"src": MAPPX})
        two = fx(n, PLATE.copy(), params, t=0.7,
                 layerPixels=lambda ref: {"src": MAPPX}.get(ref))
        if contract_broken(one, PLATE):
            bad_fit.append(f"{n}.{mode}")
        if not np.array_equal(one, two):
            two_shapes.append(f"{n}.{mode}")
eq("every fit mode places an odd-sized map and keeps the (H,W,4) 0..1 contract",
   bad_fit, [])
eq("...and a mapping and a callable at ctx['layerPixels'] give the same pixels",
   two_shapes, [])
eq("...and every one of them is deterministic",
   [n for n in LAYERED
    if not np.array_equal(
        fx(n, PLATE.copy(), dict(LAYER_PROBE[n], **{LAYER_KEY[n]: "src"}), t=0.7,
           layerPixels={"src": MAPPX}),
        fx(n, PLATE.copy(), dict(LAYER_PROBE[n], **{LAYER_KEY[n]: "src"}), t=0.7,
           layerPixels={"src": MAPPX}))], [])

# Every advertised min, max and option AGAIN, but with a layer resolved. The
# sweep up in the contract section runs them with no resolver in ctx, where
# differenceMatte is a no-op from its first line and the other four never take
# the cross-layer branch at all - so the half of these five's catalog that only
# exists on that branch had never actually been run by anything.
layered_raised, layered_loose, layered_trials = [], [], 0
for n in LAYERED:
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
            layered_trials += 1
            params = dict(LAYER_PROBE[n], **{LAYER_KEY[n]: "src"})
            params.update(extra)
            out, err = run_quiet(n, params, PLATE, layerPixels={"src": MAPPX})
            if err:
                layered_raised.append(f"{n}.{key}={extra[key]} "
                                      f"{err.strip().splitlines()[0]}")
            elif contract_broken(out, PLATE):
                layered_loose.append(f"{n}.{key}={extra[key]}")
eq("every advertised range of the five runs with a layer actually resolved",
   layered_raised[:5], [])
eq("...and keeps the (H,W,4) float32 0..1 contract while it does",
   layered_loose[:5], [])
eq("that was a real sweep too", layered_trials > 70, True)


def raiser(ref):
    raise RuntimeError("the resolver exploded")


# Everything that can go wrong on the way in must come back as the same thing:
# the self-channel path, silently correct, never an exception.
UNUSABLE = {
    "no resolver in ctx at all": {},
    "a resolver that raised": {"layerPixels": raiser},
    "a name it does not know": {"layerPixels": {"other": MAPPX}},
    "None where pixels were promised": {"layerPixels": {"src": None}},
    "a 2D array": {"layerPixels": {"src": np.zeros((8, 8), np.float32)}},
    "a 3-channel array": {"layerPixels": {"src": np.zeros((8, 8, 3), np.float32)}},
    "a uint8 array": {"layerPixels": {"src": np.zeros((8, 8, 4), np.uint8)}},
    "an empty array": {"layerPixels": {"src": np.zeros((0, 8, 4), np.float32)}},
}
degraded = []
for n in LAYERED:
    clean, _ = run_quiet(n, LAYER_PROBE[n], PLATE)
    for label, extra in UNUSABLE.items():
        params = dict(LAYER_PROBE[n])
        params[LAYER_KEY[n]] = "src"
        out, err = run_quiet(n, params, PLATE, **extra)
        if err or not np.array_equal(out, clean):
            degraded.append(f"{n}: {label}")
eq("an unusable layer input degrades to the self-channel path and never raises",
   degraded, [])

# A non-string reference must name NOTHING - not a layer called "None". The
# generic hostile sweep cannot catch this: it runs with no resolver, where
# every value degrades to the same picture anyway.
RESOLVER = {"layerPixels": {"src": MAPPX, "": MAPPX, "None": MAPPX, "7": MAPPX,
                            "nan": MAPPX}}
named_junk = []
for n in LAYERED:
    clean, _ = run_quiet(n, LAYER_PROBE[n], PLATE, **RESOLVER)
    for bad in (None, 7, [], {"x": 1}, float("nan"), True):
        params = dict(LAYER_PROBE[n])
        params[LAYER_KEY[n]] = bad
        out, err = run_quiet(n, params, PLATE, **RESOLVER)
        if err or not np.array_equal(out, clean):
            named_junk.append(f"{n}.{LAYER_KEY[n]}={bad!r}")
eq("a non-string reference names nothing, not a layer called \"None\"", named_junk[:5], [])

# An effect that quietly runs a lesser version of itself is the bug nobody
# finds, so all five say so - into a list the engine opted into, never stderr.
missing_notes = []
for n in LAYERED:
    seen = []
    params = dict(LAYER_PROBE[n])
    params[LAYER_KEY[n]] = "ghost"
    out, err = run_quiet(n, params, PLATE, notes=seen)
    if err or len(seen) != 1 or "ghost" not in seen[0]:
        missing_notes.append(n)
eq("all five say so when the layer they were pointed at was not there",
   missing_notes, [])
noisy = []
for n in LAYERED:
    seen = []
    params = dict(LAYER_PROBE[n])
    params[LAYER_KEY[n]] = "src"
    run_quiet(n, params, PLATE, notes=seen, layerPixels={"src": MAPPX})
    if seen:
        noisy.append(f"{n}: {seen[0]}")
eq("...and say nothing at all when they got the layer they asked for", noisy, [])
eq("...and with no list in ctx a degrade is silent and still not an error",
   run_quiet("setMatte", {"matteLayer": "ghost", "use": "luminance"}, PLATE)[1], "")


# ── the identities the fast paths stand on ───────────────────────────────
# Interleaved RGBA is what an effect costs: `rgb OP plane[..., None]` is a
# three-element inner loop at stride 4 against the same loop at stride 0, and
# numpy collapses neither - 9.3ms for one multiply on a 720p frame against 2.3
# once both sides are dense. Every helper below trades that shape for a dense
# one, and every trade is only allowed because it is EXACT.
#
# So these are not performance tests. They are the proof obligations the
# rewrites were accepted under, and each one fails on a rounding difference
# rather than on a visible one - which is the only kind of drift that could
# reach a render without anybody noticing. Bytes are compared, not values, so a
# -0.0 that became a +0.0 fails here too.

def bits(a):
    return np.ascontiguousarray(a, dtype=np.float32).tobytes()


def agree(a, b):
    """Equal bit for bit, counting NaN as equal to NaN."""
    a = np.asarray(a, np.float32)
    b = np.asarray(b, np.float32)
    if a.shape != b.shape:
        return False
    nan = np.isnan(a) & np.isnan(b)
    if not (a[~nan].view(np.int32) == b[~nan].view(np.int32)).all():
        return False
    return bool((np.isnan(a) == np.isnan(b)).all())


_rng = np.random.default_rng(20260826)
_PL = _rng.random((64, 96, 4), dtype=np.float32)
_RGB = np.ascontiguousarray(_PL[..., :3])
_A = np.ascontiguousarray(_PL[..., 3])
_C3 = np.array([0.8, 0.35, 0.6], np.float32)

eq("_rgb and _pack are exactly the strided slice and the strided write they replaced",
   (bits(effects._rgb(_PL)) == bits(_PL[..., :3])
    and bits(effects._pack(_RGB, _A)) == bits(np.dstack([_RGB, _A[..., None]]))), True)
eq("_spread is the broadcast column it stands in for",
   bits(effects._spread(_A)) == bits(np.repeat(_A[..., None], 3, axis=-1)), True)
eq("_grey3 is np.repeat", bits(effects._grey3(_A)) == bits(np.repeat(_A[..., None], 3, -1)), True)
eq("_scale3 is `rgb * plane[..., None]`",
   bits(effects._scale3(_RGB, _A)) == bits(_RGB * _A[..., None]), True)
eq("_tone3 is `plane[..., None] * colour`",
   bits(effects._tone3(_A, _C3)) == bits(_A[..., None] * _C3), True)
eq("_premul4 is the in-place 3-of-4 multiply",
   bits(effects._premul4(_PL)) == bits(np.dstack([_RGB * _A[..., None], _A[..., None]])), True)
_pmref = np.clip(_RGB / np.maximum(np.clip(_A, 0, 1), np.float32(1e-6))[..., None], 0, 1)
eq("_unpremul is the broadcast divide",
   bits(effects._unpremul(_RGB, _A))
   == bits(np.dstack([_pmref, np.clip(_A, 0, 1)[..., None]])), True)
_ss = np.clip((_A - 0.3) / max(0.72 - 0.3, 1e-6), 0.0, 1.0)
eq("_smoothstep unrolled through out= buffers is the one-expression form",
   bits(effects._smoothstep(0.3, 0.72, _A))
   == bits((_ss * _ss * (3.0 - 2.0 * _ss)).astype(np.float32)), True)
eq("_axes carries the same coordinates as _grid",
   [bits(np.broadcast_to(u, (64, 96))) for u in effects._axes(64, 96)]
   == [bits(u) for u in effects._grid(64, 96)], True)

# `_frac` replaces np.mod(x, 1.0), which numpy runs as a scalar libm remainder:
# 30.7ms on a 720p plane against 1.1. floor(x) is exact and so is x - floor(x),
# so the two cannot disagree - swept here over every 977th float32 bit pattern,
# both signs, plus the specials that are the only place a wrap ever breaks.
_probe = np.concatenate([
    np.arange(0, 2 ** 32, 977, dtype=np.uint64).astype(np.uint32).view(np.float32),
    np.array([0.0, -0.0, 1.0, -1.0, np.inf, -np.inf, np.nan, 2.0 ** 24, -(2.0 ** 24),
              np.finfo(np.float32).tiny, np.finfo(np.float32).max], np.float32)])
with np.errstate(invalid="ignore"):
    eq("_frac is np.mod(x, 1.0) on every float32 pattern swept, NaN and infinities included",
       agree(effects._frac(_probe), np.mod(_probe, np.float32(1.0))), True)

# Black & White wraps the hue by hand for the same reason, six times per frame:
# 161ms of a 720p pass became 25. It is only safe because cvtColor's hue channel
# holds [0, 360], -0.0 or NaN and NOTHING else - so that claim is tested first,
# on the pixel values most likely to break it.
_wild = np.array(list(__import__("itertools").product(
    [0.0, -0.0, 1.0, -1.0, 0.5, np.inf, -np.inf, np.nan, 1e30, -1e30,
     np.finfo(np.float32).max, np.finfo(np.float32).tiny], repeat=3)), np.float32)
_wildh = cv2.cvtColor(_wild.reshape(-1, 1, 3), cv2.COLOR_RGB2HSV)[..., 0]
_fin = _wildh[np.isfinite(_wildh)]
eq("cvtColor's hue is never infinite, whatever the pixels were",
   bool(np.isinf(_wildh).any()), False)
eq("...and every finite hue it produces is inside [0, 360]",
   bool(((_fin < 0.0) | (_fin > 360.0)).any()), False)

# The full domain is 1,135,869,955 values and 199 seconds; what stands here is a
# dense stride through it, both boundaries, and the hues a real frame produces.
_lo = np.float32(0.0).view(np.uint32)
_hi = np.float32(360.0).view(np.uint32)
_hue = np.concatenate([
    np.arange(_lo, _hi + 1, 1021, dtype=np.uint32).view(np.float32),
    np.array([0.0, -0.0, 360.0, np.nextafter(np.float32(360.0), np.float32(0.0)),
              60.0, 120.0, 180.0, 240.0, 300.0, np.nan], np.float32),
    _wildh.ravel(),
    cv2.cvtColor(np.ascontiguousarray(_PL[..., :3]), cv2.COLOR_RGB2HSV)[..., 0].ravel()])
_wrapbad = []
for _i in range(6):
    _z = (_hue - _i * 60.0) + 180.0
    with np.errstate(invalid="ignore"):
        _want = np.abs((_z % 360.0) - 180.0)
        _q = np.divide(_z, 360.0)
        np.floor(_q, out=_q)
        np.multiply(_q, 360.0, out=_q)
        _got = np.abs(np.subtract(_z, _q) - 180.0)
    if not agree(_got, _want):
        _wrapbad.append(_i * 60)
eq("Black & White's hand-written hue wrap is `% 360` on every hue that can reach it",
   _wrapbad, [])

# Polar Coordinates keeps np.fmod instead: its argument is arctan2 + 2.5pi, so
# both operands are positive, numpy's remainder never takes its sign correction
# and the two are the same op. That premise is what is checked - the RANGE, and
# then the equality on it.
_ang = np.arctan2(_rng.standard_normal(400_000), _rng.standard_normal(400_000)) + math.pi * 2.5
_ang = _ang.astype(np.float32)
eq("the polar angle is strictly positive before it is wrapped", bool((_ang > 0).all()), True)
eq("...so fmod is remainder there",
   agree(np.fmod(_ang, np.float32(math.pi * 2)), np.mod(_ang, np.float32(math.pi * 2))), True)

# Checkerboard's `% 2` is on a plane of whole numbers, where halving and both
# floors are exact - 2.5ms at 720p against 31.
_cells = np.arange(-9000, 9000, 0.5, dtype=np.float32)
_cells = np.floor(_cells)
eq("the checkerboard parity is `% 2` on whole numbers",
   agree(np.subtract(_cells, np.multiply(np.floor(_cells * 0.5), 2.0)), _cells % 2.0), True)

# Reductions ALONG the colour axis are the same three-element stride-4 loop, and
# 25ms each at 720p; done pairwise on planes they are 1.2 and identical, because
# min, max and a three-term sum all reduce left to right either way.
_c0, _c1, _c2 = cv2.split(_RGB - 0.5)
_sc = _RGB - 0.5
eq("min along the colour axis is the pairwise minimum",
   agree(np.minimum(np.minimum(_c0, _c1), _c2), _sc.min(axis=-1)), True)
eq("...and max is the pairwise maximum",
   agree(np.maximum(np.maximum(_c0, _c1), _c2), _sc.max(axis=-1)), True)
eq("...and a three-channel sum is (a + b) + c",
   agree((_c0 + _c1) + _c2, _sc.sum(axis=-1)), True)
eq("...and |.|.max is the pairwise maximum of the absolutes",
   agree(np.maximum(np.maximum(np.abs(_c0), np.abs(_c1)), np.abs(_c2)),
         np.abs(_sc).max(axis=-1)), True)


# ── what these cost ────────────────────────────────────────────────────────
# A variable blur can be very expensive, and a person deserves the number
# before they reach for it rather than after a nine-hundred-frame render. The
# assertion is only a ceiling: the point of this block is the printed numbers.
BIG = ogradient(1920, 1080)
BIGMAP = ogradient(1280, 720)
spend = {}
for n in LAYERED:
    params = dict(LAYER_PROBE[n] if n != "compoundBlur" else {"maxRadius": 20, "levels": 5})
    params[LAYER_KEY[n]] = "src"
    fx(n, BIG, params, layerPixels={"src": BIGMAP})            # warm the allocator
    started = time.perf_counter()
    fx(n, BIG, params, layerPixels={"src": BIGMAP})
    spend[n] = (time.perf_counter() - started) * 1000.0
for n in sorted(spend):
    print(f"        {n:17s}{spend[n]:7.0f} ms/frame at 1080p, off a 1280x720 map")
eq("none of the five has quietly turned into a minute",
   sorted(n for n, cost in spend.items() if cost > 2000), [])


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
