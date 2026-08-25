"""The VFX effect library - every filter a layer can stack, one pure function
each.

The engine hands a layer's pixels in and takes new pixels back; nothing here
knows about comps, keyframes, files or time beyond the `t` it is told. That is
deliberate: an effect you can run on an 8x8 array is an effect you can prove.

The contract, in full:

    apply(name, rgba, params, ctx) -> np.ndarray

    rgba    float32 (H, W, 4), 0..1, STRAIGHT (un-premultiplied) alpha
    return  the same shape and dtype; the input is never written to
    ctx     { "t", "fps", "width", "height", "draft", "layer", "history"? }
    an unknown name, an unusable array or an effect that raises -> rgba back

`CATALOG` describes every effect and EVERY parameter - type, default, range,
whether it can be keyframed, and one line on what it is for - because MCP
serves it verbatim. An agent reads the catalog instead of guessing, so a
parameter that is not in the catalog does not exist: `apply` drops unknown keys
and clamps known ones before an effect body ever sees them.

Two conventions the rest of the system depends on:

  * ALPHA DISCIPLINE. Every entry carries `touchesAlpha`. Colour work is false
    and is tested to be bit-exact on the alpha channel; keying, mattes and the
    effects that spread light past an edge (glow, drop shadow, stroke) are true
    and say so. Nothing changes transparency quietly.
  * PREMULTIPLIED INTERNALS. Blurs, warps and resamples run on premultiplied
    pixels and un-premultiply on the way out. Filtering straight alpha drags
    the colour of undefined transparent pixels into every edge - the black
    halo everyone recognises and nobody can explain.

Two catalog flags are messages to the engine rather than to a person:
`needsHistory` asks for `ctx["history"]`, this layer's previously rendered
frames, OLDEST FIRST, so history[-1] is the frame before this one; missing or
short history is normal (it is what the first second of a comp looks like) and
those effects fall back to a no-op. `snapsTime` says the layer should be
EVALUATED at a quantised time - posterizeTime asks for that, and holds the
last sampled frame itself when it is handed history instead.

Randomness is seeded from the parameter plus the frame number, never from the
clock: two renders of the same comp must be the same file.

    python effects.py catalog        # the catalog as one JSON line

numpy / cv2 / scipy, plus the blend maths from server/imagetools.py - the same
`_blend` the image compositor uses, so a VFX "screen" and an Images "screen"
are the same arithmetic.
"""
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from imagetools import _blend as _blend_rgb  # noqa: E402  the one blend implementation


# ---------------------------------------------------------------------------
# the registry
# ---------------------------------------------------------------------------

CATALOG = {}
_REGISTRY = {}

GROUP_ORDER = ["Blur & Sharpen", "Color", "Keying", "Stylize", "Distort",
               "Generate", "Time", "Matte"]

# what a generator can do to the layer under it. "stencil" is the one people
# reach for without knowing its name: paint inside the shape that is already
# there, leave its edges alone.
COMPOSITE_MODES = ["normal", "stencil", "behind", "multiply", "screen", "overlay",
                   "softlight", "add", "subtract", "difference", "darken", "lighten"]

EDGE_MODES = ["transparent", "clamp", "wrap", "mirror"]


def num(default, lo, hi, desc, animatable=True, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": animatable, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "animatable": False, "desc": desc}


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default,
            "animatable": False, "desc": desc}


def col(default, desc, animatable=True):
    """Colours are 0-255 RGB, the same units the comp document stores."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": animatable, "desc": desc}


def pts(default, desc):
    """A curve: [[x, y], ...] over 0..255, the domain imagetools' curves use."""
    return {"type": "points", "default": [list(p) for p in default], "min": 0, "max": 255,
            "animatable": False, "desc": desc}


def effect(name, label, group, why, params, touches_alpha=False, **extra):
    def deco(fn):
        entry = {"label": label, "group": group, "why": why,
                 "touchesAlpha": bool(touches_alpha), "params": params}
        entry.update(extra)
        CATALOG[name] = entry
        _REGISTRY[name] = fn
        return fn
    return deco


# ---------------------------------------------------------------------------
# shared plumbing
# ---------------------------------------------------------------------------

LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)   # Rec.601, as imagetools uses
_EPS = np.float32(1e-6)


def _rgb(rgba):
    """A contiguous copy of the colour. cv2 cannot take a strided 3-of-4 slice,
    and a copy is what "never mutate the input" wants anyway."""
    return np.ascontiguousarray(rgba[..., :3])


def _alpha(rgba):
    return np.ascontiguousarray(rgba[..., 3])


def _pack(rgb, a):
    out = np.empty(rgb.shape[:2] + (4,), np.float32)
    out[..., :3] = rgb
    out[..., 3] = a
    return out


def _premul4(rgba):
    """4-channel premultiplied copy - what warps and resamples must work on."""
    out = np.array(rgba, dtype=np.float32, copy=True)
    out[..., :3] *= out[..., 3:4]
    return out


def _unpremul(pm, a):
    a = np.clip(a, 0.0, 1.0).astype(np.float32)
    rgb = np.clip(pm / np.maximum(a, _EPS)[..., None], 0.0, 1.0)
    return _pack(rgb, a)


def _luma(rgb):
    return rgb @ LUMA


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(float(e1) - float(e0), 1e-6), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _rgb01(c):
    a = np.zeros(3, np.float32)
    seq = list(c)[:3]
    for i, v in enumerate(seq):
        a[i] = float(v) / 255.0
    return np.clip(a, 0.0, 1.0)


def _frame(ctx):
    fps = float(ctx.get("fps") or 30.0) or 30.0
    return int(round(float(ctx.get("t") or 0.0) * fps))


def _ks(sigma):
    """Kernel width for a sigma. 1 means "do not filter this axis at all" -
    getGaussianKernel(1, s) is [1.0] whatever s is, which is how a single-axis
    blur stays single-axis even though cv2 copies sigmaX into a zero sigmaY."""
    if sigma < 0.05:
        return 1
    return max(3, int(sigma * 3.0) * 2 + 1)


def _at_scale(img, factor, fn):
    """Run a kernel-bound filter on a shrunken copy and scale the result back.
    A blur is scale-free - halving the picture and the radius gives the same
    picture - so the only thing lost is detail the blur was erasing, while the
    cost falls with the square of the factor. This is what makes a 200px radius
    on a 4K plate a tenth of a second instead of a minute."""
    if factor <= 1.05:
        return fn(img, 1.0)
    h, w = img.shape[:2]
    sw, sh = max(2, int(round(w / factor))), max(2, int(round(h / factor)))
    small = cv2.resize(img, (sw, sh), interpolation=cv2.INTER_AREA)
    small = fn(small, factor)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def _blur2(img, sx, sy, border=cv2.BORDER_REPLICATE, draft=False):
    sx, sy = max(0.0, float(sx)), max(0.0, float(sy))
    if sx < 0.05 and sy < 0.05:
        return img
    lim = 3.0 if draft else 8.0
    factor = min(max(sx, sy) / lim, 24.0)

    def run(a, f):
        ux, uy = sx / f, sy / f
        return cv2.GaussianBlur(a, (_ks(ux), _ks(uy)),
                                sigmaX=max(ux, 1e-3), sigmaY=max(uy, 1e-3),
                                borderType=border)

    return _at_scale(img, factor, run)


def _border_of(edge):
    return cv2.BORDER_CONSTANT if edge == "transparent" else cv2.BORDER_REPLICATE


def _blur_rgba(rgba, sx, sy, edge="clamp", draft=False):
    border = _border_of(edge)
    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    return _unpremul(_blur2(pm, sx, sy, border, draft), _blur2(a, sx, sy, border, draft))


def _blur_a(a, sigma, draft=False):
    return _blur2(np.ascontiguousarray(a), sigma, sigma, cv2.BORDER_CONSTANT, draft)


def _kernel(radius):
    r = max(1, int(round(radius)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r * 2 + 1, r * 2 + 1))


def _grid(h, w):
    yy, xx = np.mgrid[0:h, 0:w]
    return xx.astype(np.float32), yy.astype(np.float32)


def _remap(rgba, mapx, mapy, edge="transparent", draft=False):
    """Resample through an explicit source-coordinate map - the one road every
    distort takes, so they all share the same edge behaviour and the same
    premultiplied handling."""
    h, w = rgba.shape[:2]
    mapx = np.ascontiguousarray(mapx, dtype=np.float32)
    mapy = np.ascontiguousarray(mapy, dtype=np.float32)
    if edge == "wrap":
        # cv2's BORDER_WRAP is not honoured by every remap path; doing it on the
        # coordinates is unambiguous and costs one modulo.
        mapx = np.mod(mapx, w)
        mapy = np.mod(mapy, h)
        border = cv2.BORDER_REPLICATE
    elif edge == "mirror":
        border = cv2.BORDER_REFLECT_101
    else:
        border = _border_of(edge)
    interp = cv2.INTER_NEAREST if draft else cv2.INTER_LINEAR
    warped = cv2.remap(_premul4(rgba), mapx, mapy, interp,
                       borderMode=border, borderValue=(0, 0, 0, 0))
    return _unpremul(warped[..., :3], warped[..., 3])


def _blend_over(rgba, gen_rgb, cov, mode):
    """Composite a generated image onto the layer.

    `normal` covers whatever is there and grows alpha; `stencil` paints only
    inside the alpha that already exists (a Fill, in AE's sense); `behind`
    slides underneath; anything else is a blend mode, and a blend mode against
    nothing is nothing - so those are restricted to the existing shape and
    leave alpha exactly as they found it.
    """
    a = _alpha(rgba)
    rgb = _rgb(rgba)
    cov = np.clip(cov, 0.0, 1.0).astype(np.float32)
    if gen_rgb.ndim == 1:
        gen_rgb = np.broadcast_to(gen_rgb, rgb.shape).astype(np.float32)
    if mode == "stencil":
        c = (cov * a)[..., None]
        return _pack(rgb * (1 - c) + gen_rgb * c, a)
    if mode == "behind":
        out_a = np.clip(a + cov * (1 - a), 0, 1)
        pm = rgb * a[..., None] + gen_rgb * (cov * (1 - a))[..., None]
        return _unpremul(pm, out_a)
    if mode == "normal":
        c = cov[..., None]
        pm = rgb * a[..., None] * (1 - c) + gen_rgb * c
        return _unpremul(pm, np.clip(a * (1 - cov) + cov, 0, 1))
    c = (cov * a)[..., None]
    blended = np.clip(_blend_rgb(rgb, gen_rgb, mode), 0, 1).astype(np.float32)
    return _pack(rgb * (1 - c) + blended * c, a)


def _pchip_lut(points, size=256):
    """The curve LUT from imagetools.apply_edit, ported: dedupe on x, sort,
    extend flat to both ends, PCHIP through the lot (monotone cubic - a spline
    would ring and put a highlight where the artist drew none). Returned in
    0..1 because the compositor is float, not 8-bit."""
    from scipy.interpolate import PchipInterpolator
    clean = {}
    for p in points or []:
        if len(p) != 2:
            continue
        clean[int(max(0, min(255, float(p[0]))))] = max(0.0, min(255.0, float(p[1])))
    items = sorted(clean.items())
    if len(items) < 2:
        return None
    xs = [p[0] for p in items]
    ys = [p[1] for p in items]
    if xs[0] > 0:
        xs.insert(0, 0)
        ys.insert(0, ys[0])
    if xs[-1] < 255:
        xs.append(255)
        ys.append(ys[-1])
    f = PchipInterpolator(xs, ys)
    lut = (np.clip(f(np.linspace(0, 255, size)), 0, 255) / 255.0).astype(np.float32)
    return np.append(lut, lut[-1])      # the spare entry _apply_lut leans on


def _apply_lut(channel, lut):
    """Look the channel up in a uniformly-sampled table, interpolating between
    entries so a smooth gradient does not band. Hand-rolled rather than
    np.interp because the table is uniform: skipping the binary search halves
    the cost, and a curve pass runs on three channels of a 2Mpx frame."""
    pos = np.clip(channel, 0, 1) * (len(lut) - 2)   # the table carries a spare
    lo = pos.astype(np.int32)                       # last entry, so lo+1 is
    frac = pos - lo                                 # always in bounds
    return (lut[lo] + (lut[lo + 1] - lut[lo]) * frac).astype(np.float32)


def _is_identity_curve(points):
    return len(points or []) == 2 and list(points[0]) == [0, 0] and list(points[1]) == [255, 255]


# ---------------------------------------------------------------------------
# Blur & Sharpen
# ---------------------------------------------------------------------------

@effect("gaussianBlur", "Gaussian Blur", "Blur & Sharpen",
        "Soften. The default blur - radius is the gaussian sigma, the same "
        "number the Images screen uses, so 8 here looks like 8 there.",
        {"radius": num(8, 0, 200, "blur sigma in pixels; past ~200 the frame is flat", unit="px"),
         "dimensions": pick(["both", "horizontal", "vertical"], "both",
                            "blur one axis only for a smear rather than a soften"),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp",
                              "clamp repeats the frame edge; transparent lets it fade off")},
        touches_alpha=True)      # a blur softens the matte too, or the edge stays razor sharp
def _gaussian_blur(rgba, p, ctx):
    r = p["radius"]
    if r < 0.05:
        return rgba
    sx = r if p["dimensions"] in ("both", "horizontal") else 0.0
    sy = r if p["dimensions"] in ("both", "vertical") else 0.0
    return _blur_rgba(rgba, sx, sy, p["edgeBehavior"], ctx.get("draft"))


@effect("boxBlur", "Box Blur", "Blur & Sharpen",
        "A cheap blur with a square kernel. Two or three iterations converge on "
        "a gaussian for a fraction of the cost, and one iteration is the boxy "
        "look on purpose.",
        {"radius": num(6, 0, 200, "half the box width, in pixels", unit="px"),
         "iterations": num(1, 1, 4, "repeats; 3 is visually a gaussian", integer=True),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp", "how the frame edge is fed")},
        touches_alpha=True)
def _box_blur(rgba, p, ctx):
    r = int(round(p["radius"]))
    if r < 1:
        return rgba
    border = _border_of(p["edgeBehavior"])
    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    k = (r * 2 + 1, r * 2 + 1)
    ab = a
    for _ in range(int(p["iterations"])):
        pm = cv2.boxFilter(pm, -1, k, borderType=border)
        ab = cv2.boxFilter(ab, -1, k, borderType=border)
    return _unpremul(pm, ab)


@effect("directionalBlur", "Directional Blur", "Blur & Sharpen",
        "A straight-line smear - motion that did not happen, or the tail on a "
        "fast title. Length is the whole smear, not a radius.",
        {"length": num(20, 0, 200, "smear length in pixels", unit="px"),
         "angle": num(0, -360, 360, "degrees, 0 = horizontal, clockwise on screen", unit="deg"),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp", "how the frame edge is fed")},
        touches_alpha=True)
def _directional_blur(rgba, p, ctx):
    length = p["length"]
    if length < 1.5:
        return rgba
    border = _border_of(p["edgeBehavior"])
    lim = 12.0 if ctx.get("draft") else 24.0
    factor = min(max(1.0, length / lim), 8.0)

    def run(img, f):
        k = _line_kernel(length / f, p["angle"])
        return img if k is None else cv2.filter2D(img, -1, k, borderType=border)

    warped = _at_scale(_premul4(rgba), factor, run)
    return _unpremul(warped[..., :3], warped[..., 3])


def _line_kernel(length, angle_deg):
    n = int(round(length))
    if n < 2:
        return None
    size = n if n % 2 == 1 else n + 1
    k = np.zeros((size, size), np.float32)
    th = math.radians(angle_deg)
    dx, dy = math.cos(th), math.sin(th)
    c = (size - 1) / 2.0
    steps = size * 3
    for i in range(steps + 1):
        u = (i / steps - 0.5) * (n - 1)
        x, y = c + dx * u, c + dy * u
        x0, y0 = int(math.floor(x)), int(math.floor(y))
        fx, fy = x - x0, y - y0
        # bilinear splat: a shallow angle drawn with integer steps comes out as
        # a dotted line, and a dotted kernel is a ghost, not a blur
        for xx, yy, wgt in ((x0, y0, (1 - fx) * (1 - fy)), (x0 + 1, y0, fx * (1 - fy)),
                            (x0, y0 + 1, (1 - fx) * fy), (x0 + 1, y0 + 1, fx * fy)):
            if 0 <= xx < size and 0 <= yy < size:
                k[yy, xx] += wgt
    s = float(k.sum())
    return k / s if s > 0 else None


@effect("radialBlur", "Radial Blur", "Blur & Sharpen",
        "Zoom or spin around a point - the hyperspace streak, or a wheel that "
        "will not hold still.",
        {"type": pick(["zoom", "spin"], "zoom", "streak outward from the centre, or around it"),
         "amount": num(10, 0, 100, "zoom: percent of extra scale across the sweep. "
                                   "spin: degrees swept", unit="%"),
         "centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "samples": num(12, 2, 48, "steps in the sweep; more is smoother and slower",
                        integer=True, animatable=False)},
        touches_alpha=True)
def _radial_blur(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    n = int(p["samples"])
    if ctx.get("draft"):
        n = max(2, min(n, 5))
    pm = _premul4(rgba)
    acc = np.zeros_like(pm)
    for i in range(n):
        f = i / (n - 1) if n > 1 else 0.0
        if p["type"] == "zoom":
            m = cv2.getRotationMatrix2D((cx, cy), 0.0, 1.0 + p["amount"] / 100.0 * f)
        else:
            m = cv2.getRotationMatrix2D((cx, cy), p["amount"] * (f - 0.5), 1.0)
        acc += cv2.warpAffine(pm, m, (w, h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    acc /= float(n)
    return _unpremul(acc[..., :3], acc[..., 3])


@effect("unsharpMask", "Unsharp Mask", "Blur & Sharpen",
        "Sharpen by adding back what a blur removed. The threshold is the whole "
        "point: below it nothing happens, so grain and skin stay smooth while "
        "edges get their bite.",
        {"amount": num(80, 0, 500, "percent of the detail layer added back", unit="%"),
         "radius": num(2, 0.2, 50, "size of the detail it looks for, in pixels", unit="px"),
         "threshold": num(2, 0, 100, "ignore differences smaller than this "
                                     "(percent of full range)", unit="%")})
def _unsharp_mask(rgba, p, ctx):
    if p["amount"] < 0.5:
        return rgba
    rgb = _rgb(rgba)
    blurred = _blur2(rgb, p["radius"], p["radius"], cv2.BORDER_REPLICATE, ctx.get("draft"))
    diff = rgb - blurred
    thr = p["threshold"] / 100.0
    if thr > 0.0005:
        mag = np.abs(diff).max(axis=-1)
        diff = diff * _smoothstep(thr, thr * 2.0 + 0.004, mag)[..., None]
    return _pack(rgb + diff * (p["amount"] / 100.0), _alpha(rgba))


@effect("bilateralSmooth", "Bilateral Smooth", "Blur & Sharpen",
        "Smooths flat areas but refuses to cross an edge - the skin-and-sky "
        "cleanup, and the first step of a cel-shaded look. Genuinely expensive; "
        "draft renders skip it.",
        {"radius": num(5, 1, 15, "pixel neighbourhood; cost grows with its square",
                       integer=True, unit="px"),
         "colorSigma": num(25, 1, 100, "how different a colour may be and still be "
                                       "averaged in", unit="%"),
         "spaceSigma": num(25, 1, 100, "how far away a pixel may be and still count", unit="%")},
        expensive=True)
def _bilateral(rgba, p, ctx):
    if ctx.get("draft"):
        return rgba
    rgb = _rgb(rgba)
    out = cv2.bilateralFilter(rgb, int(p["radius"]) * 2 + 1,
                              p["colorSigma"] / 100.0, p["spaceSigma"] / 100.0 * 40.0)
    return _pack(out, _alpha(rgba))


# ---------------------------------------------------------------------------
# Color
# ---------------------------------------------------------------------------

@effect("brightnessContrast", "Brightness & Contrast", "Color",
        "The two knobs everyone reaches for first. Contrast pivots on mid grey "
        "so it opens and closes the image instead of sliding it.",
        {"brightness": num(0, -100, 100, "added light; 100 pushes everything white", unit="%"),
         "contrast": num(0, -100, 100, "spread around mid grey; -100 is flat grey", unit="%")})
def _brightness_contrast(rgba, p, ctx):
    b, c = p["brightness"] / 100.0, p["contrast"] / 100.0
    if abs(b) < 1e-4 and abs(c) < 1e-4:
        return rgba
    k = 1.0 + c if c >= 0 else 1.0 / (1.0 - c)
    rgb = (_rgb(rgba) - 0.5) * k + 0.5 + b
    return _pack(rgb, _alpha(rgba))


@effect("curves", "Curves", "Color",
        "Tone by hand. Same PCHIP through the control points as the Images "
        "screen, so a curve copied from there lands identically here.",
        {"master": pts([[0, 0], [255, 255]], "points on 0..255, applied to all three channels"),
         "red": pts([[0, 0], [255, 255]], "points on 0..255, red only"),
         "green": pts([[0, 0], [255, 255]], "points on 0..255, green only"),
         "blue": pts([[0, 0], [255, 255]], "points on 0..255, blue only"),
         "alpha": pts([[0, 0], [255, 255]], "points on 0..255, the matte itself"),
         "amount": num(100, 0, 100, "blend against the untouched image", unit="%")},
        touches_alpha=True)      # the alpha curve is why this one may move the matte
def _curves(rgba, p, ctx):
    todo = [k for k in ("master", "red", "green", "blue", "alpha")
            if not _is_identity_curve(p[k])]
    if not todo or p["amount"] < 0.05:
        return rgba
    rgb = _rgb(rgba)
    a = _alpha(rgba)
    lut = _pchip_lut(p["master"])
    if lut is not None and "master" in todo:
        rgb = _apply_lut(rgb, lut)          # all three channels in one pass
    for i, key in enumerate(("red", "green", "blue")):
        if key in todo:
            lut = _pchip_lut(p[key])
            if lut is not None:
                rgb[..., i] = _apply_lut(rgb[..., i], lut)
    if "alpha" in todo:
        lut = _pchip_lut(p["alpha"])
        if lut is not None:
            a = _apply_lut(a, lut)
    w = p["amount"] / 100.0
    if w < 0.999:
        rgb = _rgb(rgba) * (1 - w) + rgb * w
        a = _alpha(rgba) * (1 - w) + a * w
    return _pack(rgb, a)


@effect("levels", "Levels", "Color",
        "Where black starts, where white clips, and where the midtone sits "
        "between them. Curves can express this; nobody reaches for a curve to "
        "fix a flat scan - they drag the black point.",
        {"channel": pick(["rgb", "red", "green", "blue"], "rgb",
                         "which channel the numbers apply to"),
         "inBlack": num(0, 0, 254, "input value that becomes black, 0..255"),
         "inWhite": num(255, 1, 255, "input value that becomes white, 0..255"),
         "gamma": num(1.0, 0.1, 9.99, "midtone bend; above 1 lifts the mids"),
         "outBlack": num(0, 0, 255, "black is remapped to this, 0..255"),
         "outWhite": num(255, 0, 255, "white is remapped to this, 0..255")})
def _levels(rgba, p, ctx):
    lo, hi = p["inBlack"] / 255.0, p["inWhite"] / 255.0
    if hi - lo < 1e-4:
        return rgba
    olo, ohi = p["outBlack"] / 255.0, p["outWhite"] / 255.0
    rgb = _rgb(rgba)
    sl = {"rgb": slice(None), "red": 0, "green": 1, "blue": 2}[p["channel"]]
    v = np.clip((rgb[..., sl] - lo) / (hi - lo), 0, 1)
    if abs(p["gamma"] - 1.0) > 1e-3:
        v = np.power(v, 1.0 / p["gamma"])
    rgb[..., sl] = olo + v * (ohi - olo)
    return _pack(rgb, _alpha(rgba))


@effect("hueSaturation", "Hue & Saturation", "Color",
        "Rotate the whole colour wheel, or drain it. Colorize throws the "
        "original hues away and paints everything one colour by brightness.",
        {"hue": num(0, -180, 180, "rotation of the colour wheel in degrees", unit="deg"),
         "saturation": num(0, -100, 100, "-100 is greyscale, +100 doubles the chroma", unit="%"),
         "lightness": num(0, -100, 100, "lift or crush the value channel", unit="%"),
         "colorize": flag(False, "discard the source hues and tint by brightness instead"),
         "colorizeHue": num(200, 0, 360, "hue used when colorize is on", unit="deg"),
         "colorizeSaturation": num(35, 0, 100, "chroma of the colorize tint", unit="%")})
def _hue_saturation(rgba, p, ctx):
    if (not p["colorize"] and abs(p["hue"]) < 1e-3
            and abs(p["saturation"]) < 1e-3 and abs(p["lightness"]) < 1e-3):
        return rgba
    hsv = cv2.cvtColor(_rgb(rgba), cv2.COLOR_RGB2HSV)
    if p["colorize"]:
        hsv[..., 0] = p["colorizeHue"] % 360.0
        hsv[..., 1] = p["colorizeSaturation"] / 100.0
    else:
        hsv[..., 0] = np.mod(hsv[..., 0] + p["hue"], 360.0)
        s = p["saturation"] / 100.0
        hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 + s), 0, 1) if s >= 0 else hsv[..., 1] * (1.0 + s)
    lg = p["lightness"] / 100.0
    if abs(lg) > 1e-3:
        hsv[..., 2] = hsv[..., 2] + (1.0 - hsv[..., 2]) * lg if lg > 0 else hsv[..., 2] * (1.0 + lg)
    rgb = cv2.cvtColor(np.clip(hsv, [0, 0, 0], [360, 1, 1]).astype(np.float32), cv2.COLOR_HSV2RGB)
    return _pack(rgb, _alpha(rgba))


@effect("exposure", "Exposure", "Color",
        "Stops, the way a camera means them: +1 is twice the light. Offset "
        "lifts the black point after, gamma bends what is left.",
        {"exposure": num(0, -8, 8, "stops; each one doubles or halves the light", unit="stops"),
         "offset": num(0, -0.5, 0.5, "flat lift added after the exposure"),
         "gamma": num(1.0, 0.1, 4.0, "gamma correction applied last")})
def _exposure(rgba, p, ctx):
    if abs(p["exposure"]) < 1e-4 and abs(p["offset"]) < 1e-5 and abs(p["gamma"] - 1) < 1e-4:
        return rgba
    rgb = _rgb(rgba) * (2.0 ** p["exposure"]) + p["offset"]
    if abs(p["gamma"] - 1.0) > 1e-4:
        rgb = np.power(np.clip(rgb, 0, None), 1.0 / p["gamma"])
    return _pack(rgb, _alpha(rgba))


@effect("tint", "Tint", "Color",
        "Remap the whole image between two colours by brightness - the duotone, "
        "and the honest way to bed a shot into a palette.",
        {"blackColor": col([0, 20, 60], "what the darkest pixels become"),
         "whiteColor": col([255, 235, 200], "what the brightest pixels become"),
         "amount": num(100, 0, 100, "blend against the untouched image", unit="%")})
def _tint(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    lum = _luma(rgb)[..., None]
    mapped = _rgb01(p["blackColor"]) + lum * (_rgb01(p["whiteColor"]) - _rgb01(p["blackColor"]))
    return _pack(rgb * (1 - w) + mapped * w, _alpha(rgba))


@effect("colorBalance", "Color Balance", "Color",
        "Push colour into the shadows, mids and highlights separately - warm "
        "the faces without warming the sky. Masks are luminance-weighted, the "
        "same shape the Images screen uses for shadow/highlight recovery.",
        {"shadowRed": num(0, -100, 100, "red in the darks", unit="%"),
         "shadowGreen": num(0, -100, 100, "green in the darks", unit="%"),
         "shadowBlue": num(0, -100, 100, "blue in the darks", unit="%"),
         "midRed": num(0, -100, 100, "red in the midtones", unit="%"),
         "midGreen": num(0, -100, 100, "green in the midtones", unit="%"),
         "midBlue": num(0, -100, 100, "blue in the midtones", unit="%"),
         "highRed": num(0, -100, 100, "red in the highlights", unit="%"),
         "highGreen": num(0, -100, 100, "green in the highlights", unit="%"),
         "highBlue": num(0, -100, 100, "blue in the highlights", unit="%"),
         "preserveLuminosity": flag(True, "put the original brightness back afterwards, so "
                                          "the grade moves colour and not exposure")})
def _color_balance(rgba, p, ctx):
    shifts = np.array([[p["shadowRed"], p["shadowGreen"], p["shadowBlue"]],
                       [p["midRed"], p["midGreen"], p["midBlue"]],
                       [p["highRed"], p["highGreen"], p["highBlue"]]], np.float32) / 100.0 * 0.5
    if not np.abs(shifts).any():
        return rgba
    rgb = _rgb(rgba)
    lum = _luma(rgb)
    m_lo = np.clip(1.0 - lum / 0.5, 0, 1) ** 2
    m_hi = np.clip((lum - 0.5) / 0.5, 0, 1) ** 2
    m_mid = np.clip(1.0 - m_lo - m_hi, 0, 1)
    out = rgb + (m_lo[..., None] * shifts[0] + m_mid[..., None] * shifts[1]
                 + m_hi[..., None] * shifts[2])
    if p["preserveLuminosity"]:
        out = out + (lum - _luma(np.clip(out, 0, 1)))[..., None]
    return _pack(out, _alpha(rgba))


@effect("vibrance", "Vibrance", "Color",
        "Saturation that leaves the already-loud alone. Weighted by how "
        "colourful a pixel already is, which is why it does not turn faces "
        "orange the way a saturation slider does.",
        {"vibrance": num(30, -100, 100, "boost weighted against existing chroma", unit="%"),
         "saturation": num(0, -100, 100, "a flat saturation on top, for when you do "
                                         "want the blunt one", unit="%")})
def _vibrance(rgba, p, ctx):
    vib, sat = p["vibrance"] / 100.0, p["saturation"] / 100.0
    if abs(vib) < 1e-4 and abs(sat) < 1e-4:
        return rgba
    rgb = _rgb(rgba)
    mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
    chroma = np.clip(mx - mn, 0, 1)
    grey = _luma(rgb)[..., None]
    k = 1.0 + sat + vib * (1.0 - chroma)[..., None]
    return _pack(grey + (rgb - grey) * k, _alpha(rgba))


@effect("channelMixer", "Channel Mixer", "Color",
        "Build each output channel from all three inputs. The knob behind every "
        "convincing black and white and every deliberate colour break.",
        {"redFromRed": num(100, -200, 200, "percent of red in the new red", unit="%"),
         "redFromGreen": num(0, -200, 200, "percent of green in the new red", unit="%"),
         "redFromBlue": num(0, -200, 200, "percent of blue in the new red", unit="%"),
         "greenFromRed": num(0, -200, 200, "percent of red in the new green", unit="%"),
         "greenFromGreen": num(100, -200, 200, "percent of green in the new green", unit="%"),
         "greenFromBlue": num(0, -200, 200, "percent of blue in the new green", unit="%"),
         "blueFromRed": num(0, -200, 200, "percent of red in the new blue", unit="%"),
         "blueFromGreen": num(0, -200, 200, "percent of green in the new blue", unit="%"),
         "blueFromBlue": num(100, -200, 200, "percent of blue in the new blue", unit="%"),
         "monochrome": flag(False, "copy the red row into all three outputs")})
def _channel_mixer(rgba, p, ctx):
    m = np.array([[p["redFromRed"], p["redFromGreen"], p["redFromBlue"]],
                  [p["greenFromRed"], p["greenFromGreen"], p["greenFromBlue"]],
                  [p["blueFromRed"], p["blueFromGreen"], p["blueFromBlue"]]], np.float32) / 100.0
    if p["monochrome"]:
        m[1] = m[0]
        m[2] = m[0]
    elif np.allclose(m, np.eye(3, dtype=np.float32)):
        return rgba
    return _pack(_rgb(rgba) @ m.T, _alpha(rgba))


@effect("invert", "Invert", "Color",
        "Flip the channel. Amount exists so a half invert can be keyframed "
        "through - and so a full one is exactly its own undo.",
        {"channel": pick(["rgb", "red", "green", "blue", "luminance"], "rgb",
                         "what gets flipped"),
         "amount": num(100, 0, 100, "100 is a full inversion; two of those is identity", unit="%")})
def _invert(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    ch = p["channel"]
    if ch == "rgb":
        rgb = rgb + (1.0 - 2.0 * rgb) * w
    elif ch == "luminance":
        lum = _luma(rgb)[..., None]
        rgb = rgb + (1.0 - 2.0 * lum) * w
    else:
        i = {"red": 0, "green": 1, "blue": 2}[ch]
        rgb[..., i] = rgb[..., i] + (1.0 - 2.0 * rgb[..., i]) * w
    return _pack(rgb, _alpha(rgba))


@effect("blackAndWhite", "Black & White", "Color",
        "Greyscale with a say in it: how bright each hue family lands. Defaults "
        "are Photoshop's, so a red at 40 and a yellow at 60 read the way a "
        "photographer expects.",
        {"reds": num(40, -200, 300, "how bright reds become", unit="%"),
         "yellows": num(60, -200, 300, "how bright yellows become", unit="%"),
         "greens": num(40, -200, 300, "how bright greens become", unit="%"),
         "cyans": num(60, -200, 300, "how bright cyans become", unit="%"),
         "blues": num(20, -200, 300, "how bright blues become", unit="%"),
         "magentas": num(80, -200, 300, "how bright magentas become", unit="%"),
         "tint": flag(False, "tone the result instead of leaving it neutral"),
         "tintColor": col([230, 200, 160], "the tone applied when tint is on"),
         "amount": num(100, 0, 100, "blend against the colour original", unit="%")})
def _black_and_white(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hue = hsv[..., 0]
    weights = [p["reds"], p["yellows"], p["greens"], p["cyans"], p["blues"], p["magentas"]]
    # Triangular 60-degree bands: memberships of the two neighbouring families
    # always sum to one, which makes this exactly Photoshop's model - pure red
    # at 40% lands on 0.40 grey, pure blue at 20% on 0.20.
    mix = np.zeros(hue.shape, np.float32)
    for i, wt in enumerate(weights):
        d = np.abs(((hue - i * 60.0 + 180.0) % 360.0) - 180.0)
        mix += np.clip(1.0 - d / 60.0, 0, 1) * (wt / 100.0)
    mn = rgb.min(axis=-1)
    grey = np.clip(mn + (rgb.max(axis=-1) - mn) * mix, 0, 1)
    out = np.repeat(grey[..., None], 3, axis=-1)
    if p["tint"]:
        out = out * _rgb01(p["tintColor"])[None, None, :] * 1.15
    return _pack(rgb * (1 - w) + out * w, _alpha(rgba))


# ---------------------------------------------------------------------------
# Keying
# ---------------------------------------------------------------------------

@effect("chromaKey", "Chroma Key", "Keying",
        "The greenscreen. Distance to the key colour, a tolerance that goes "
        "fully transparent and a softness band that feathers the rest - ported "
        "from the Images screen so a key set there survives the move.",
        {"color": col([0, 255, 0], "the screen colour being removed"),
         "tolerance": num(25, 0, 100, "everything this close to the key goes fully out", unit="%"),
         "softness": num(10, 0, 100, "width of the feathered band past the tolerance", unit="%"),
         "despill": flag(True, "pull the key hue out of half-transparent edge pixels, so "
                               "hair does not keep a green rim")},
        touches_alpha=True)
def _chroma_key(rgba, p, ctx):
    rgb = _rgb(rgba)
    a = _alpha(rgba)
    key = _rgb01(p["color"])
    tol = max(0.01, p["tolerance"] / 100.0) * 0.75
    soft = max(0.001, p["softness"] / 100.0) * 0.5
    dist = np.sqrt(((rgb - key) ** 2).sum(axis=-1))
    keyed = np.clip((dist - tol) / soft, 0.0, 1.0)
    out_a = a * keyed
    if p["despill"]:
        edge = (keyed > 0) & (keyed < 1)
        if edge.any():
            dom = int(np.argmax(key))
            others = [i for i in range(3) if i != dom]
            cap = np.maximum(rgb[..., others[0]], rgb[..., others[1]])
            rgb[..., dom] = np.where(edge, np.minimum(rgb[..., dom], cap), rgb[..., dom])
    return _pack(rgb, out_a)


@effect("lumaKey", "Luma Key", "Keying",
        "Key on brightness instead of colour - the only thing that works on a "
        "white-card logo, smoke plate or a stock explosion on black.",
        {"keyOut": pick(["darker", "brighter"], "darker", "which end of the range disappears"),
         "threshold": num(20, 0, 100, "where the cut sits on the luminance scale", unit="%"),
         "softness": num(10, 0, 100, "feather width past the threshold", unit="%"),
         "invert": flag(False, "swap what survives")},
        touches_alpha=True)
def _luma_key(rgba, p, ctx):
    lum = _luma(_rgb(rgba))
    thr = p["threshold"] / 100.0
    soft = max(0.002, p["softness"] / 100.0)
    keep = (_smoothstep(thr, thr + soft, lum) if p["keyOut"] == "darker"
            else 1.0 - _smoothstep(thr - soft, thr, lum))
    if p["invert"]:
        keep = 1.0 - keep
    return _pack(_rgb(rgba), _alpha(rgba) * keep)


@effect("colorRangeKey", "Color Range Key", "Keying",
        "Key a range of colour in a space that separates chroma from "
        "brightness. Lab or YCbCr hold a key through a lighting change that "
        "plain RGB distance loses.",
        {"color": col([0, 255, 0], "the colour at the centre of the range"),
         "space": pick(["lab", "ycbcr", "rgb"], "lab", "the space the distance is measured in"),
         "tolerance": num(20, 0, 100, "radius of the range that goes out", unit="%"),
         "softness": num(12, 0, 100, "feather past the tolerance", unit="%"),
         "invert": flag(False, "keep the range and drop everything else")},
        touches_alpha=True)
def _color_range_key(rgba, p, ctx):
    rgb = _rgb(rgba)
    key = _rgb01(p["color"]).reshape(1, 1, 3)
    space = p["space"]
    if space == "lab":
        conv, norm = cv2.COLOR_RGB2Lab, np.array([100.0, 128.0, 128.0], np.float32)
    elif space == "ycbcr":
        conv, norm = cv2.COLOR_RGB2YCrCb, np.array([1.0, 1.0, 1.0], np.float32)
    else:
        conv, norm = None, np.array([1.0, 1.0, 1.0], np.float32)
    if conv is None:
        a_img, a_key = rgb, key
    else:
        a_img = cv2.cvtColor(rgb, conv) / norm
        a_key = cv2.cvtColor(np.ascontiguousarray(key), conv) / norm
    dist = np.sqrt(((a_img - a_key) ** 2).sum(axis=-1))
    tol = max(0.005, p["tolerance"] / 100.0)
    soft = max(0.002, p["softness"] / 100.0)
    keep = np.clip((dist - tol) / soft, 0.0, 1.0)
    if p["invert"]:
        keep = 1.0 - keep
    return _pack(rgb, _alpha(rgba) * keep)


@effect("spillSuppress", "Spill Suppress", "Keying",
        "Take the screen's bounce out of everything, not just the edge a key "
        "feathered. This is the pass that stops a keyed actor glowing green "
        "down one shoulder - it moves colour only, never the matte.",
        {"color": col([0, 255, 0], "the screen colour whose bounce is being removed"),
         "amount": num(80, 0, 100, "how far the offending channel is pulled back", unit="%"),
         "preserveLuminance": flag(True, "put the brightness back after, so suppression "
                                         "does not darken the subject")})
def _spill_suppress(rgba, p, ctx):
    amt = p["amount"] / 100.0
    if amt < 0.005:
        return rgba
    rgb = _rgb(rgba)
    key = _rgb01(p["color"])
    dom = int(np.argmax(key))
    others = [i for i in range(3) if i != dom]
    before = _luma(rgb)
    cap = (rgb[..., others[0]] + rgb[..., others[1]]) * 0.5
    over = np.maximum(rgb[..., dom] - cap, 0.0)
    rgb[..., dom] = rgb[..., dom] - over * amt
    if p["preserveLuminance"]:
        rgb = rgb + (before - _luma(np.clip(rgb, 0, 1)))[..., None]
    return _pack(rgb, _alpha(rgba))


@effect("matteChoke", "Matte Choke", "Keying",
        "Grow, shrink and firm up a matte after a key. Every key leaves a soft "
        "grey fringe; clipping the black and white ends is what turns it back "
        "into an edge.",
        {"amount": num(-1, -50, 50, "pixels; positive grows the matte, negative eats it",
                       unit="px"),
         "feather": num(1, 0, 100, "blur applied to the matte afterwards", unit="px"),
         "blackClip": num(0, 0, 99, "matte below this becomes fully transparent", unit="%"),
         "whiteClip": num(100, 1, 100, "matte above this becomes fully opaque", unit="%")},
        touches_alpha=True)
def _matte_choke(rgba, p, ctx):
    a = _alpha(rgba)
    r = int(round(abs(p["amount"])))
    if r >= 1:
        k = _kernel(r)
        a = cv2.dilate(a, k) if p["amount"] > 0 else cv2.erode(a, k)
    if p["feather"] > 0.05:
        a = _blur_a(a, p["feather"], ctx.get("draft"))
    lo, hi = p["blackClip"] / 100.0, p["whiteClip"] / 100.0
    if hi - lo > 1e-3 and (lo > 1e-4 or hi < 0.9999):
        a = np.clip((a - lo) / (hi - lo), 0, 1)
    return _pack(_rgb(rgba), a)


# ---------------------------------------------------------------------------
# Stylize
# ---------------------------------------------------------------------------

@effect("glow", "Glow", "Stylize",
        "Bloom off the bright parts. Light spreads past the layer's edge, so "
        "this GROWS alpha unless expandAlpha is off - that is what makes it "
        "read as light instead of as a painted halo.",
        {"threshold": num(60, 0, 100, "only pixels brighter than this glow", unit="%"),
         "radius": num(24, 1, 200, "how far the light carries, in pixels", unit="px"),
         "intensity": num(120, 0, 400, "brightness of the halo", unit="%"),
         "softness": num(15, 0, 100, "how gradually the threshold engages", unit="%"),
         "colorize": flag(False, "one colour for the whole glow instead of the source colours"),
         "glowColor": col([255, 220, 150], "the colour used when colorize is on"),
         "mode": pick(["add", "screen"], "add", "add blows out, screen stays inside white"),
         "expandAlpha": flag(True, "let the halo carry alpha past the layer edge")},
        touches_alpha=True)
def _glow(rgba, p, ctx):
    if p["intensity"] < 0.5:
        return rgba
    rgb = _rgb(rgba)
    a = _alpha(rgba)
    thr = p["threshold"] / 100.0
    soft = max(0.002, p["softness"] / 100.0)
    mask = _smoothstep(thr, thr + soft, _luma(rgb)) * a
    src = (_rgb01(p["glowColor"])[None, None, :] * mask[..., None] if p["colorize"]
           else rgb * mask[..., None])
    gain = p["intensity"] / 100.0
    halo = _blur2(src, p["radius"], p["radius"], cv2.BORDER_CONSTANT, ctx.get("draft")) * gain
    halo_a = _blur2(mask, p["radius"], p["radius"], cv2.BORDER_CONSTANT, ctx.get("draft")) * gain
    pm = rgb * a[..., None]
    if p["mode"] == "add":
        out_pm = pm + halo
    else:
        out_pm = 1.0 - (1.0 - np.clip(pm, 0, 1)) * (1.0 - np.clip(halo, 0, 1))
    out_a = np.clip(a + np.clip(halo_a, 0, 1) * (1 - a), 0, 1) if p["expandAlpha"] else a
    return _unpremul(out_pm, out_a)


@effect("dropShadow", "Drop Shadow", "Stylize",
        "The layer's own matte, offset, blurred and darkened behind it. Grows "
        "alpha, because a shadow that stops at the layer edge is not a shadow.",
        {"color": col([0, 0, 0], "shadow colour"),
         "opacity": num(55, 0, 100, "how dark the shadow lands", unit="%"),
         "distance": num(12, 0, 500, "how far it is thrown, in pixels", unit="px"),
         "angle": num(45, -360, 360, "degrees; 0 throws right, 90 throws straight down",
                      unit="deg"),
         "softness": num(10, 0, 200, "blur on the shadow, in pixels", unit="px"),
         "spread": num(0, 0, 50, "grow the matte before blurring, for a fatter shadow",
                       unit="px"),
         "shadowOnly": flag(False, "drop the layer and keep only its shadow")},
        touches_alpha=True)
def _drop_shadow(rgba, p, ctx):
    if p["opacity"] < 0.5:
        return rgba
    h, w = rgba.shape[:2]
    a = _alpha(rgba)
    sa = a
    if p["spread"] >= 1:
        sa = cv2.dilate(sa, _kernel(p["spread"]))
    th = math.radians(p["angle"])
    dx, dy = p["distance"] * math.cos(th), p["distance"] * math.sin(th)
    if abs(dx) > 0.01 or abs(dy) > 0.01:
        m = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
        sa = cv2.warpAffine(sa, m, (w, h), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    if p["softness"] > 0.05:
        sa = _blur_a(sa, p["softness"], ctx.get("draft"))
    sa = np.clip(sa, 0, 1) * (p["opacity"] / 100.0)
    shade = _rgb01(p["color"])[None, None, :]
    if p["shadowOnly"]:
        return _unpremul(shade * sa[..., None], sa)
    rgb = _rgb(rgba)
    out_a = np.clip(a + sa * (1 - a), 0, 1)
    out_pm = rgb * a[..., None] + shade * (sa * (1 - a))[..., None]
    return _unpremul(out_pm, out_a)


@effect("stroke", "Stroke", "Stylize",
        "An outline drawn from the layer's own matte. Outside and centre "
        "strokes paint where there was nothing, so they grow alpha; an inside "
        "stroke stays within the shape.",
        {"color": col([255, 255, 255], "line colour"),
         "width": num(4, 1, 100, "line thickness in pixels", unit="px"),
         "position": pick(["outside", "center", "inside"], "outside",
                          "which side of the matte edge the line sits on"),
         "opacity": num(100, 0, 100, "line opacity", unit="%"),
         "feather": num(0, 0, 50, "soften the line", unit="px")},
        touches_alpha=True)
def _stroke(rgba, p, ctx):
    a = _alpha(rgba)
    w = max(1, int(round(p["width"])))
    pos = p["position"]
    if pos == "outside":
        ring = np.clip(cv2.dilate(a, _kernel(w)) - a, 0, 1)
    elif pos == "inside":
        ring = np.clip(a - cv2.erode(a, _kernel(w)), 0, 1)
    else:
        half = max(1, w // 2)
        ring = np.clip(cv2.dilate(a, _kernel(half)) - cv2.erode(a, _kernel(half)), 0, 1)
    if p["feather"] > 0.05:
        ring = np.clip(_blur_a(ring, p["feather"], ctx.get("draft")), 0, 1)
    cov = ring * (p["opacity"] / 100.0)
    line = _rgb01(p["color"])[None, None, :]
    out_pm = _rgb(rgba) * a[..., None] * (1 - cov[..., None]) + line * cov[..., None]
    return _unpremul(out_pm, np.clip(a * (1 - cov) + cov, 0, 1))


@effect("posterize", "Posterize", "Stylize",
        "Quantise each channel to N steps. Levels, not bits - 4 means four "
        "values, the mistake the Images screen already paid for once.",
        {"levels": num(6, 2, 64, "distinct values per channel", integer=True),
         "amount": num(100, 0, 100, "blend against the smooth original", unit="%")})
def _posterize(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    n = int(p["levels"])
    rgb = _rgb(rgba)
    q = np.round(np.clip(rgb, 0, 1) * (n - 1)) / (n - 1)
    return _pack(rgb * (1 - w) + q * w, _alpha(rgba))


@effect("findEdges", "Find Edges", "Stylize",
        "Sobel gradient - where the picture changes. Inverted by default, "
        "because pencil lines on white is what people mean by find edges.",
        {"intensity": num(100, 0, 500, "gain on the gradient", unit="%"),
         "invert": flag(True, "dark lines on white instead of light lines on black"),
         "mono": flag(False, "one grey edge map instead of per-channel colour edges"),
         "amount": num(100, 0, 100, "blend against the original", unit="%")})
def _find_edges(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    src = np.repeat(_luma(rgb)[..., None], 3, axis=-1) if p["mono"] else rgb
    gx = cv2.Sobel(src, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(src, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.clip(np.sqrt(gx * gx + gy * gy) * (p["intensity"] / 100.0), 0, 1)
    if p["invert"]:
        mag = 1.0 - mag
    return _pack(rgb * (1 - w) + mag * w, _alpha(rgba))


@effect("mosaic", "Mosaic", "Stylize",
        "Average the frame into blocks - the censor bar, or a deliberate "
        "low-res beat. Alpha blocks up with the colour, so a cutout's edge goes "
        "square too.",
        {"size": num(16, 2, 512, "block width in pixels", integer=True, unit="px"),
         "sizeY": num(0, 0, 512, "block height; 0 keeps the blocks square",
                      integer=True, unit="px")},
        touches_alpha=True)
def _mosaic(rgba, p, ctx):
    h, w = rgba.shape[:2]
    bx = max(1, int(p["size"]))
    by = max(1, int(p["sizeY"]) or bx)
    if bx <= 1 and by <= 1:
        return rgba
    sw, sh = max(1, int(math.ceil(w / bx))), max(1, int(math.ceil(h / by)))
    pm = _premul4(rgba)
    small = cv2.resize(pm, (sw, sh), interpolation=cv2.INTER_AREA)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    return _unpremul(big[..., :3], big[..., 3])


@effect("halftone", "Halftone", "Stylize",
        "A print screen: dots that grow as the picture darkens, on a rotated "
        "grid. The angle is what stops it looking like a bug.",
        {"size": num(8, 2, 64, "cell size in pixels - the dot pitch", unit="px"),
         "angle": num(45, -180, 180, "screen rotation in degrees", unit="deg"),
         "colored": flag(False, "keep the source colour in the dots"),
         "inkColor": col([15, 15, 20], "dot colour when colored is off"),
         "paperColor": col([245, 245, 240], "background between the dots"),
         "amount": num(100, 0, 100, "blend against the original", unit="%")})
def _halftone(rgba, p, ctx):
    w8 = p["amount"] / 100.0
    if w8 < 0.0005:
        return rgba
    h, w = rgba.shape[:2]
    rgb = _rgb(rgba)
    size = max(2.0, p["size"])
    th = math.radians(p["angle"])
    xx, yy = _grid(h, w)
    u = (xx * math.cos(th) + yy * math.sin(th)) / size
    v = (-xx * math.sin(th) + yy * math.cos(th)) / size
    du, dv = u - np.floor(u) - 0.5, v - np.floor(v) - 0.5
    d = np.sqrt(du * du + dv * dv) * 2.0
    lum = _luma(rgb)
    radius = np.sqrt(np.clip(1.0 - lum, 0, 1)) * 1.18
    aa = 2.0 / size                      # one screen pixel, in cell units
    ink = 1.0 - np.clip((d - (radius - aa)) / (2 * aa), 0, 1)
    ink = ink[..., None]
    ink_rgb = rgb if p["colored"] else _rgb01(p["inkColor"])[None, None, :]
    dots = _rgb01(p["paperColor"])[None, None, :] * (1 - ink) + ink_rgb * ink
    return _pack(rgb * (1 - w8) + dots * w8, _alpha(rgba))


@effect("noise", "Noise", "Stylize",
        "Grain. Seeded from the seed and the frame number, never the clock - "
        "re-render the comp and you get the same grain in the same places.",
        {"amount": num(12, 0, 100, "noise strength as a percent of full range", unit="%"),
         "type": pick(["gaussian", "uniform"], "gaussian", "the distribution sampled"),
         "mono": flag(True, "one value per pixel instead of per channel"),
         "seed": num(7, 0, 100000, "change it for a different grain", integer=True,
                     animatable=False),
         "animate": flag(True, "advance the grain every frame; off freezes one pattern"),
         "size": num(1, 1, 32, "grain scale in pixels; above 1 the noise is generated "
                               "small and scaled up", integer=True, unit="px")})
def _noise(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    frame = _frame(ctx) if p["animate"] else 0
    rng = np.random.default_rng((int(p["seed"]) & 0xFFFFFFF) * 1000003 + frame)
    step = max(1, int(p["size"]))
    gh, gw = max(1, h // step), max(1, w // step)
    ch = 1 if p["mono"] else 3
    if p["type"] == "gaussian":
        n = rng.normal(0.0, 1.0, (gh, gw, ch)).astype(np.float32)
    else:
        n = (rng.random((gh, gw, ch), dtype=np.float32) - 0.5) * 2.0
    if (gh, gw) != (h, w):
        n = cv2.resize(n, (w, h), interpolation=cv2.INTER_NEAREST)
        n = n.reshape(h, w, ch)
    return _pack(_rgb(rgba) + n * (p["amount"] / 100.0 * 0.35), _alpha(rgba))


@effect("scanlines", "Scanlines", "Stylize",
        "CRT lines. Roll makes them drift, which is the difference between a "
        "still texture and a monitor that is on.",
        {"spacing": num(4, 2, 200, "distance between line centres, in pixels",
                        unit="px"),
         "thickness": num(50, 1, 99, "percent of the spacing the dark band fills", unit="%"),
         "darkness": num(45, 0, 100, "how far the lines pull the picture down", unit="%"),
         "offset": num(0, -500, 500, "shift the pattern, in pixels", unit="px"),
         "rollSpeed": num(0, -200, 200, "pixels per second the pattern drifts", unit="px/s"),
         "softness": num(30, 0, 100, "soften the band edges", unit="%"),
         "vertical": flag(False, "run the lines vertically instead"),
         "affectAlpha": flag(False, "cut the lines out of the matte as well as darkening")},
        touches_alpha=True)
def _scanlines(rgba, p, ctx):
    if p["darkness"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    coord = xx if p["vertical"] else yy
    span = max(2.0, p["spacing"])
    shift = p["offset"] + p["rollSpeed"] * float(ctx.get("t") or 0.0)
    m = np.mod(coord + shift, span) / span
    dist = np.minimum(m, 1.0 - m)                # 0 on a line centre, 0.5 between lines
    half = p["thickness"] / 100.0 * 0.5
    soft = max(0.001, p["softness"] / 100.0 * 0.5)
    dark = (1.0 - _smoothstep(half, half + soft, dist)) * (p["darkness"] / 100.0)
    rgb = _rgb(rgba) * (1.0 - dark)[..., None]
    a = _alpha(rgba) * (1.0 - dark) if p["affectAlpha"] else _alpha(rgba)
    return _pack(rgb, a)


@effect("chromaticAberration", "Chromatic Aberration", "Stylize",
        "Split the channels the way a cheap lens does - red and blue pulled "
        "apart, green left alone. Radial grows toward the corners, which is "
        "what real glass does; linear is the glitch look.",
        {"amount": num(3, 0, 60, "channel separation in pixels at the frame edge",
                       unit="px"),
         "type": pick(["radial", "linear"], "radial", "spread from the centre, or one direction"),
         "angle": num(0, -360, 360, "direction for linear separation", unit="deg"),
         "centerX": num(50, -100, 200, "centre for radial, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre for radial, percent of height", unit="%")})
def _chromatic_aberration(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    out = pm.copy()
    if p["type"] == "radial":
        cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
        rmax = max(1.0, math.hypot(max(cx, w - cx), max(cy, h - cy)))
        for ch, sign in ((0, 1.0), (2, -1.0)):
            m = cv2.getRotationMatrix2D((cx, cy), 0.0, 1.0 + sign * p["amount"] / rmax)
            out[..., ch] = cv2.warpAffine(np.ascontiguousarray(pm[..., ch]), m, (w, h),
                                          flags=cv2.INTER_LINEAR,
                                          borderMode=cv2.BORDER_REPLICATE)
    else:
        th = math.radians(p["angle"])
        dx, dy = p["amount"] * math.cos(th), p["amount"] * math.sin(th)
        for ch, sign in ((0, 1.0), (2, -1.0)):
            m = np.array([[1, 0, sign * dx], [0, 1, sign * dy]], np.float32)
            out[..., ch] = cv2.warpAffine(np.ascontiguousarray(pm[..., ch]), m, (w, h),
                                          flags=cv2.INTER_LINEAR,
                                          borderMode=cv2.BORDER_REPLICATE)
    return _unpremul(out, a)


# ---------------------------------------------------------------------------
# Distort
# ---------------------------------------------------------------------------

@effect("transform", "Transform", "Distort",
        "A second free transform, inside the stack - so you can blur, THEN "
        "scale, which the layer's own transform can never do. Anchor and "
        "position are percentages so a preset survives a resize.",
        {"anchorX": num(50, -200, 300, "pivot, percent of layer width", unit="%"),
         "anchorY": num(50, -200, 300, "pivot, percent of layer height", unit="%"),
         "positionX": num(0, -4096, 4096, "move right, in pixels", unit="px"),
         "positionY": num(0, -4096, 4096, "move down, in pixels", unit="px"),
         "scaleX": num(100, -1000, 1000, "horizontal scale; negative mirrors", unit="%"),
         "scaleY": num(100, -1000, 1000, "vertical scale; negative flips", unit="%"),
         "rotation": num(0, -3600, 3600, "degrees, clockwise on screen", unit="deg"),
         "skew": num(0, -80, 80, "shear in degrees", unit="deg"),
         "opacity": num(100, 0, 100, "fade the transformed result", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "transparent", "what fills the area it leaves behind")},
        touches_alpha=True)
def _transform(rgba, p, ctx):
    h, w = rgba.shape[:2]
    ident = (abs(p["positionX"]) < 1e-3 and abs(p["positionY"]) < 1e-3
             and abs(p["scaleX"] - 100) < 1e-3 and abs(p["scaleY"] - 100) < 1e-3
             and abs(p["rotation"]) < 1e-3 and abs(p["skew"]) < 1e-3)
    if ident and p["opacity"] >= 99.995:
        return rgba
    ax, ay = p["anchorX"] / 100.0 * w, p["anchorY"] / 100.0 * h
    th = math.radians(p["rotation"])
    rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]], np.float32)
    shear = np.array([[1.0, math.tan(math.radians(p["skew"]))], [0.0, 1.0]], np.float32)
    scale = np.array([[p["scaleX"] / 100.0, 0.0], [0.0, p["scaleY"] / 100.0]], np.float32)
    a2 = rot @ shear @ scale
    tx = ax + p["positionX"] - (a2[0, 0] * ax + a2[0, 1] * ay)
    ty = ay + p["positionY"] - (a2[1, 0] * ax + a2[1, 1] * ay)
    if ident:
        return _fade(rgba, p["opacity"])     # nothing moved; do not resample for nothing
    # An affine is invertible, so build the source map and go through the one
    # resampler - that keeps wrap and mirror edges honest, which warpAffine's
    # border flags cannot express for a wrap.
    m = np.array([[a2[0, 0], a2[0, 1], tx], [a2[1, 0], a2[1, 1], ty]], np.float32)
    inv = cv2.invertAffineTransform(m)
    xx, yy = _grid(h, w)
    mapx = inv[0, 0] * xx + inv[0, 1] * yy + inv[0, 2]
    mapy = inv[1, 0] * xx + inv[1, 1] * yy + inv[1, 2]
    return _fade(_remap(rgba, mapx, mapy, p["edgeBehavior"], ctx.get("draft")), p["opacity"])


def _fade(rgba, opacity):
    if opacity >= 99.995:
        return rgba
    out = rgba.copy()
    out[..., 3] *= opacity / 100.0
    return out


@effect("cornerPin", "Corner Pin", "Distort",
        "Drag the four corners anywhere - the screen replacement, the wall "
        "poster, the fake monitor. Corners are percentages of the layer, so "
        "0/0/100/100 is untouched at any resolution.",
        {"topLeftX": num(0, -300, 400, "top-left corner, percent of width", unit="%"),
         "topLeftY": num(0, -300, 400, "top-left corner, percent of height", unit="%"),
         "topRightX": num(100, -300, 400, "top-right corner, percent of width", unit="%"),
         "topRightY": num(0, -300, 400, "top-right corner, percent of height", unit="%"),
         "bottomRightX": num(100, -300, 400, "bottom-right corner, percent of width", unit="%"),
         "bottomRightY": num(100, -300, 400, "bottom-right corner, percent of height", unit="%"),
         "bottomLeftX": num(0, -300, 400, "bottom-left corner, percent of width", unit="%"),
         "bottomLeftY": num(100, -300, 400, "bottom-left corner, percent of height", unit="%"),
         "edgeBehavior": pick(["transparent", "clamp"], "transparent",
                              "what fills outside the pinned quad")},
        touches_alpha=True)
def _corner_pin(rgba, p, ctx):
    h, w = rgba.shape[:2]
    dst = np.array([[p["topLeftX"], p["topLeftY"]], [p["topRightX"], p["topRightY"]],
                    [p["bottomRightX"], p["bottomRightY"]],
                    [p["bottomLeftX"], p["bottomLeftY"]]], np.float32)
    if np.allclose(dst, [[0, 0], [100, 0], [100, 100], [0, 100]]):
        return rgba
    dst = dst / 100.0 * np.array([w, h], np.float32)
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(_premul4(rgba), m, (w, h), flags=cv2.INTER_LINEAR,
                                 borderMode=_border_of(p["edgeBehavior"]),
                                 borderValue=(0, 0, 0, 0))
    return _unpremul(warped[..., :3], warped[..., 3])


@effect("wave", "Wave", "Distort",
        "Push pixels along a sine. Speed makes it a flag, water or a bad "
        "signal without a single keyframe.",
        {"direction": pick(["horizontal", "vertical", "both"], "horizontal",
                           "which axis the pixels move along"),
         "amplitude": num(12, 0, 500, "how far pixels travel, in pixels", unit="px"),
         "wavelength": num(60, 2, 2000, "distance between crests, in pixels", unit="px"),
         "phase": num(0, -3600, 3600, "starting offset in degrees", unit="deg"),
         "speed": num(0, -20, 20, "cycles per second; 0 holds still", unit="Hz"),
         "waveType": pick(["sine", "triangle", "square"], "sine", "the shape of the wave"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from off-frame")},
        touches_alpha=True)
def _wave(rgba, p, ctx):
    if p["amplitude"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    phase = math.radians(p["phase"]) + 2 * math.pi * p["speed"] * float(ctx.get("t") or 0.0)

    def shape(coord):
        u = 2 * math.pi * coord / max(2.0, p["wavelength"]) + phase
        if p["waveType"] == "sine":
            return np.sin(u)
        frac = np.mod(u / (2 * math.pi), 1.0)
        if p["waveType"] == "square":
            return np.where(frac < 0.5, 1.0, -1.0).astype(np.float32)
        return (4.0 * np.abs(frac - 0.5) - 1.0).astype(np.float32)

    amp = p["amplitude"]
    mapx, mapy = xx, yy
    if p["direction"] in ("horizontal", "both"):
        mapx = xx + shape(yy) * amp
    if p["direction"] in ("vertical", "both"):
        mapy = yy + shape(xx) * amp
    return _remap(rgba, mapx, mapy, p["edgeBehavior"], ctx.get("draft"))


@effect("ripple", "Ripple", "Distort",
        "Rings spreading from a point. Decay is what keeps it from looking like "
        "a test pattern - real water runs out of energy.",
        {"centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "amplitude": num(10, 0, 300, "displacement at the centre, in pixels", unit="px"),
         "wavelength": num(40, 2, 1000, "distance between rings, in pixels", unit="px"),
         "phase": num(0, -3600, 3600, "starting offset in degrees", unit="deg"),
         "speed": num(1, -20, 20, "rings per second travelling outward", unit="Hz"),
         "decay": num(60, 0, 100, "how fast the rings die with distance", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from off-frame")},
        touches_alpha=True)
def _ripple(rgba, p, ctx):
    if p["amplitude"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    xx, yy = _grid(h, w)
    dx, dy = xx - cx, yy - cy
    r = np.sqrt(dx * dx + dy * dy)
    rmax = max(1.0, math.hypot(w, h) * 0.5)
    phase = math.radians(p["phase"]) + 2 * math.pi * p["speed"] * float(ctx.get("t") or 0.0)
    fall = np.exp(-(p["decay"] / 100.0) * 3.0 * (r / rmax))
    disp = p["amplitude"] * np.sin(2 * math.pi * r / max(2.0, p["wavelength"]) - phase) * fall
    inv = 1.0 / np.maximum(r, 1e-3)
    return _remap(rgba, xx + disp * dx * inv, yy + disp * dy * inv,
                  p["edgeBehavior"], ctx.get("draft"))


@effect("bulge", "Bulge", "Distort",
        "A lens pressed against the frame. Positive swells, negative pinches, "
        "and the falloff is smooth at the rim so the edge of the effect does "
        "not become a visible circle.",
        {"centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "radius": num(35, 1, 200, "size of the lens, percent of the smaller side", unit="%"),
         "strength": num(50, -100, 100, "positive bulges out, negative pinches in", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from off-frame")},
        touches_alpha=True)
def _bulge(rgba, p, ctx):
    if abs(p["strength"]) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    rad = max(1.0, p["radius"] / 100.0 * min(w, h))
    xx, yy = _grid(h, w)
    dx, dy = xx - cx, yy - cy
    rn = np.clip(np.sqrt(dx * dx + dy * dy) / rad, 0, 1)
    f = 1.0 + (p["strength"] / 100.0) * (1.0 - rn * rn) ** 2
    inv = 1.0 / np.maximum(f, 1e-3)
    return _remap(rgba, cx + dx * inv, cy + dy * inv, p["edgeBehavior"], ctx.get("draft"))


@effect("lensDistortion", "Lens Distortion", "Distort",
        "Barrel and pincushion, the Brown model. Positive is barrel - the "
        "fisheye. Zoom is there because undistorting always exposes the corners.",
        {"amount": num(0, -100, 100, "positive barrels outward, negative pincushions", unit="%"),
         "secondary": num(0, -100, 100, "fourth-order term; bends the corners "
                                        "without touching the middle", unit="%"),
         "zoom": num(100, 25, 400, "scale applied after, to hide exposed corners", unit="%"),
         "centerX": num(50, -100, 200, "optical centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "optical centre, percent of height", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "transparent", "what fills the corners")},
        touches_alpha=True)
def _lens_distortion(rgba, p, ctx):
    if abs(p["amount"]) < 0.05 and abs(p["secondary"]) < 0.05 and abs(p["zoom"] - 100) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    rmax = max(1.0, math.hypot(w, h) * 0.5)
    xx, yy = _grid(h, w)
    dx, dy = (xx - cx) / rmax, (yy - cy) / rmax
    r2 = dx * dx + dy * dy
    k1, k2 = -p["amount"] / 100.0 * 0.5, -p["secondary"] / 100.0 * 0.25
    f = (1.0 + k1 * r2 + k2 * r2 * r2) / max(0.01, p["zoom"] / 100.0)
    return _remap(rgba, cx + dx * f * rmax, cy + dy * f * rmax,
                  p["edgeBehavior"], ctx.get("draft"))


@effect("mirror", "Mirror", "Distort",
        "Fold the frame across a line. Two of these at right angles is a "
        "kaleidoscope, and one is how a half-built set becomes a whole one.",
        {"centerX": num(50, -100, 200, "a point on the mirror line, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "a point on the mirror line, percent of height", unit="%"),
         "angle": num(90, -360, 360, "direction of the mirror line in degrees", unit="deg"),
         "flip": flag(False, "keep the other half instead")},
        touches_alpha=True)
def _mirror(rgba, p, ctx):
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    th = math.radians(p["angle"])
    nx, ny = -math.sin(th), math.cos(th)         # normal to the mirror line
    xx, yy = _grid(h, w)
    s = (xx - cx) * nx + (yy - cy) * ny
    keep = s < 0 if p["flip"] else s > 0
    k = np.where(keep, 2.0 * s, 0.0).astype(np.float32)
    return _remap(rgba, xx - k * nx, yy - k * ny, "clamp", ctx.get("draft"))


@effect("polarCoords", "Polar Coordinates", "Distort",
        "Wrap the frame around a circle, or unroll a circle into a strip. A "
        "straight line of text becomes a ring; a lens flare becomes a wall.",
        {"type": pick(["rectToPolar", "polarToRect"], "rectToPolar",
                      "wrap a strip into a disc, or unroll a disc into a strip"),
         "amount": num(100, 0, 100, "blend between untouched and fully wrapped", unit="%"),
         "centerX": num(50, -100, 200, "centre of the disc, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre of the disc, percent of height", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "transparent", "what fills outside the disc")},
        touches_alpha=True)
def _polar_coords(rgba, p, ctx):
    amt = p["amount"] / 100.0
    if amt < 0.0005:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    rmax = max(1.0, math.hypot(max(cx, w - cx), max(cy, h - cy)))
    xx, yy = _grid(h, w)
    if p["type"] == "rectToPolar":
        ang = np.mod(np.arctan2(yy - cy, xx - cx) + math.pi * 2.5, math.pi * 2)
        rad = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        mapx = ang / (2 * math.pi) * w
        mapy = rad / rmax * h
    else:
        ang = xx / max(1.0, w) * 2 * math.pi - math.pi * 0.5
        rad = yy / max(1.0, h) * rmax
        mapx = cx + np.cos(ang) * rad
        mapy = cy + np.sin(ang) * rad
    return _remap(rgba, xx + (mapx - xx) * amt, yy + (mapy - yy) * amt,
                  p["edgeBehavior"], ctx.get("draft"))


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------

@effect("fill", "Fill", "Generate",
        "Flood a colour. The default mode is stencil - paint inside the matte "
        "that is already there, which is how you recolour a logo without "
        "touching its edges.",
        {"color": col([255, 60, 90], "the colour poured in"),
         "opacity": num(100, 0, 100, "how much of it lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "stencil", "how the fill meets the layer under it")},
        touches_alpha=True)
def _fill(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, _rgb01(p["color"]), cov, p["mode"])


@effect("ramp", "Ramp", "Generate",
        "A gradient between two points. Half the grades in the world are a "
        "ramp on multiply; scatter breaks the banding that a smooth 8-bit "
        "gradient always shows on a projector.",
        {"type": pick(["linear", "radial"], "linear", "straight run, or out from a centre"),
         "startX": num(0, -100, 200, "start point, percent of width", unit="%"),
         "startY": num(0, -100, 200, "start point, percent of height", unit="%"),
         "endX": num(100, -100, 200, "end point, percent of width", unit="%"),
         "endY": num(100, -100, 200, "end point, percent of height", unit="%"),
         "startColor": col([255, 255, 255], "colour at the start point"),
         "endColor": col([0, 0, 0], "colour at the end point"),
         "scatter": num(0, 0, 100, "seeded dither, to kill banding", unit="%"),
         "seed": num(3, 0, 100000, "dither seed", integer=True, animatable=False),
         "opacity": num(100, 0, 100, "how much of the ramp lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how the ramp meets the layer under it")},
        touches_alpha=True)
def _ramp(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    x0, y0 = p["startX"] / 100.0 * w, p["startY"] / 100.0 * h
    x1, y1 = p["endX"] / 100.0 * w, p["endY"] / 100.0 * h
    xx, yy = _grid(h, w)
    if p["type"] == "radial":
        span = max(1e-3, math.hypot(x1 - x0, y1 - y0))
        t = np.sqrt((xx - x0) ** 2 + (yy - y0) ** 2) / span
    else:
        vx, vy = x1 - x0, y1 - y0
        span = max(1e-6, vx * vx + vy * vy)
        t = ((xx - x0) * vx + (yy - y0) * vy) / span
    if p["scatter"] > 0.05:
        rng = np.random.default_rng(int(p["seed"]) & 0xFFFFFFF)
        t = t + (rng.random((h, w), dtype=np.float32) - 0.5) * (p["scatter"] / 100.0 * 0.15)
    t = np.clip(t, 0, 1)[..., None]
    grad = _rgb01(p["startColor"]) * (1 - t) + _rgb01(p["endColor"]) * t
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, grad.astype(np.float32), cov, p["mode"])


@effect("checkerboard", "Checkerboard", "Generate",
        "Squares. A transparency backdrop, an alignment grid, or a floor to "
        "corner-pin into perspective.",
        {"size": num(32, 2, 1024, "square size in pixels", unit="px"),
         "colorA": col([40, 40, 46], "one square"),
         "colorB": col([70, 70, 78], "the other square"),
         "offsetX": num(0, -4096, 4096, "shift the pattern, in pixels", unit="px"),
         "offsetY": num(0, -4096, 4096, "shift the pattern, in pixels", unit="px"),
         "opacity": num(100, 0, 100, "how much of it lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how it meets the layer under it")},
        touches_alpha=True)
def _checkerboard(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    size = max(2.0, p["size"])
    cell = (np.floor((xx - p["offsetX"]) / size) + np.floor((yy - p["offsetY"]) / size)) % 2
    pat = (_rgb01(p["colorA"])[None, None, :] * (1 - cell[..., None])
           + _rgb01(p["colorB"])[None, None, :] * cell[..., None])
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, pat.astype(np.float32), cov, p["mode"])


@effect("vignette", "Vignette", "Generate",
        "Darken toward the corners so the eye stays in the middle. Multiplies "
        "colour only - a vignette that ate the matte would be a mask, not a "
        "vignette.",
        {"amount": num(40, -100, 100, "positive darkens the corners, negative lifts them",
                       unit="%"),
         "size": num(70, 5, 200, "where the falloff starts, percent of the frame radius",
                     unit="%"),
         "softness": num(50, 1, 100, "how gradual the falloff is", unit="%"),
         "roundness": num(50, 0, 100, "0 follows the frame shape, 100 is a circle", unit="%"),
         "centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "color": col([0, 0, 0], "what the corners are pulled toward")})
def _vignette(rgba, p, ctx):
    if abs(p["amount"]) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    xx, yy = _grid(h, w)
    rr = p["roundness"] / 100.0
    sx = max(1.0, w * 0.5 * (1 - rr) + min(w, h) * 0.5 * rr)
    sy = max(1.0, h * 0.5 * (1 - rr) + min(w, h) * 0.5 * rr)
    d = np.sqrt(((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2)
    start = p["size"] / 100.0
    soft = max(0.02, p["softness"] / 100.0)
    k = (_smoothstep(start, start + soft, d) * (abs(p["amount"]) / 100.0))[..., None]
    rgb = _rgb(rgba)
    # positive pulls the corners toward the vignette colour; negative lifts them
    # toward white, which is the "the corners are too dark" fix nobody names
    out = rgb * (1 - k) + _rgb01(p["color"])[None, None, :] * k if p["amount"] > 0 \
        else rgb + (1.0 - rgb) * k
    return _pack(out, _alpha(rgba))


@effect("lensFlare", "Lens Flare", "Generate",
        "A procedural flare: core, halo, starburst and a line of ghosts down "
        "the optical axis. Additive light, so it carries its own alpha and can "
        "sit on an empty layer.",
        {"centerX": num(30, -100, 200, "flare position, percent of width", unit="%"),
         "centerY": num(30, -100, 200, "flare position, percent of height", unit="%"),
         "brightness": num(100, 0, 400, "overall intensity", unit="%"),
         "size": num(25, 1, 200, "core size, percent of the smaller side", unit="%"),
         "color": col([255, 235, 190], "colour of the core and streaks"),
         "streaks": num(6, 0, 24, "number of starburst spikes", integer=True),
         "streakLength": num(60, 0, 200, "how far the spikes run", unit="%"),
         "ghosts": num(4, 0, 12, "reflections down the optical axis; each one is "
                                 "another full-frame pass", integer=True),
         "ghostColor": col([120, 190, 255], "tint of the ghosts")},
        touches_alpha=True)
def _lens_flare(rgba, p, ctx):
    if p["brightness"] < 0.5:
        return rgba
    h, w = rgba.shape[:2]
    # A flare is nothing but smooth falloffs, so a draft builds it at half
    # resolution and scales up - indistinguishable, and four times cheaper on
    # the pass that has twelve ghosts in it.
    step = 2.0 if ctx.get("draft") else 1.0
    gh, gw = max(8, int(h / step)), max(8, int(w / step))
    sx, sy = gw / float(w), gh / float(h)
    cx, cy = p["centerX"] / 100.0 * w * sx, p["centerY"] / 100.0 * h * sy
    size = max(2.0, p["size"] / 100.0 * min(gw, gh))
    xx, yy = _grid(gh, gw)
    dx, dy = xx - cx, yy - cy
    r = np.sqrt(dx * dx + dy * dy)

    core = np.exp(-(r / (size * 0.28)) ** 2)
    halo = np.exp(-((r - size * 0.75) / (size * 0.30)) ** 2) * 0.35
    light = core + halo
    n = int(p["streaks"])
    if n > 0 and p["streakLength"] > 0.5:
        ang = np.arctan2(dy, dx)
        spike = np.abs(np.cos(ang * (n / 2.0))) ** 24
        light = light + spike * np.exp(-r / (size * p["streakLength"] / 100.0 * 2.0)) * 0.6
    tint = _rgb01(p["color"])[None, None, :]
    add = light[..., None] * tint

    ghosts = int(p["ghosts"])
    if ghosts > 0:
        gtint = _rgb01(p["ghostColor"])[None, None, :]
        fcx, fcy = gw * 0.5, gh * 0.5
        for i in range(1, ghosts + 1):
            k = (i / (ghosts + 1.0)) * 2.4 - 0.4
            gx, gy = cx + (fcx - cx) * k * 2.0, cy + (fcy - cy) * k * 2.0
            gr = np.sqrt((xx - gx) ** 2 + (yy - gy) ** 2)
            rad = size * (0.10 + 0.05 * (i % 3))
            ring = np.exp(-((gr - rad) / (rad * 0.55)) ** 2) * (0.16 / (1 + i * 0.35))
            add = add + ring[..., None] * gtint
    add = (add * (p["brightness"] / 100.0)).astype(np.float32)
    if (gh, gw) != (h, w):
        add = cv2.resize(add, (w, h), interpolation=cv2.INTER_LINEAR)

    a = _alpha(rgba)
    lit = np.clip(add.max(axis=-1), 0, 1)
    out_a = np.clip(a + lit * (1 - a), 0, 1)
    return _unpremul(_rgb(rgba) * a[..., None] + add, out_a)


@effect("gridLines", "Grid Lines", "Generate",
        "A ruled grid. Layout guides, a HUD, or graph paper to warp - and the "
        "lines are drawn by distance, so they stay one pixel wide instead of "
        "aliasing into dashes.",
        {"spacing": num(64, 2, 1024, "distance between lines, in pixels", unit="px"),
         "lineWidth": num(2, 1, 64, "line thickness in pixels", unit="px"),
         "color": col([200, 210, 230], "line colour"),
         "axis": pick(["both", "horizontal", "vertical"], "both", "which lines are drawn"),
         "offsetX": num(0, -4096, 4096, "shift the grid, in pixels", unit="px"),
         "offsetY": num(0, -4096, 4096, "shift the grid, in pixels", unit="px"),
         "opacity": num(100, 0, 100, "line opacity", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how the grid meets the layer under it")},
        touches_alpha=True)
def _grid_lines(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    span = max(2.0, p["spacing"])
    half = p["lineWidth"] / 2.0

    def band(coord, off):
        m = np.mod(coord - off, span)
        return np.clip(half + 0.5 - np.minimum(m, span - m), 0, 1)

    cov = np.zeros((h, w), np.float32)
    if p["axis"] in ("both", "vertical"):
        cov = np.maximum(cov, band(xx, p["offsetX"]))
    if p["axis"] in ("both", "horizontal"):
        cov = np.maximum(cov, band(yy, p["offsetY"]))
    return _blend_over(rgba, _rgb01(p["color"]), cov * (p["opacity"] / 100.0), p["mode"])


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------
#
# These two are the only effects that need more than the frame in front of
# them. The engine supplies `ctx["history"]`: a list of this layer's PREVIOUS
# rendered frames, same shape and dtype, OLDEST FIRST, so history[-1] is the
# frame before this one. Missing or short history is not an error - it is what
# the first second of a comp looks like - so both degrade to a no-op.

@effect("echo", "Echo", "Time",
        "Trails: this frame plus its own past, fading. Add for light trails, "
        "behind for a ghost that stays under the subject, maximum for a "
        "long-exposure smear that never blows out.",
        {"echoes": num(5, 1, 32, "how many past frames are stacked; each one is "
                                 "another full-frame composite", integer=True),
         "frameDelay": num(2, 1, 60, "frames between one echo and the next",
                           integer=True, animatable=False),
         "decay": num(60, 0, 100, "each echo keeps this much of the one before", unit="%"),
         "startingIntensity": num(100, 0, 100, "strength of the first echo", unit="%"),
         "mode": pick(["add", "behind", "maximum", "blend"], "behind",
                      "how an echo meets the frames in front of it")},
        touches_alpha=True, needsHistory=True)
def _echo(rgba, p, ctx):
    history = ctx.get("history") or []
    if not len(history):
        return rgba                      # first frames of a comp have no past
    step = max(1, int(p["frameDelay"]))
    decay = p["decay"] / 100.0
    start = p["startingIntensity"] / 100.0
    picks = []
    for i in range(1, int(p["echoes"]) + 1):
        idx = len(history) - i * step
        if idx < 0:
            break
        past = history[idx]
        if not isinstance(past, np.ndarray) or past.shape != rgba.shape:
            continue
        picks.append((past.astype(np.float32, copy=False), start * (decay ** (i - 1))))
    if not picks:
        return rgba

    mode = p["mode"]
    if mode == "behind":
        # oldest first, each newer one composited over it, this frame last
        acc_pm = np.zeros(rgba.shape[:2] + (3,), np.float32)
        acc_a = np.zeros(rgba.shape[:2], np.float32)
        for past, wgt in reversed(picks):
            pa = past[..., 3] * wgt
            acc_pm = acc_pm * (1 - pa[..., None]) + past[..., :3] * pa[..., None]
            acc_a = acc_a * (1 - pa) + pa
        a = _alpha(rgba)
        acc_pm = acc_pm * (1 - a[..., None]) + _rgb(rgba) * a[..., None]
        return _unpremul(acc_pm, np.clip(acc_a * (1 - a) + a, 0, 1))

    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    acc_a = a.copy()
    for past, wgt in picks:
        pa = past[..., 3] * wgt
        ppm = past[..., :3] * pa[..., None]
        if mode == "add":
            pm = pm + ppm
            acc_a = acc_a + pa * (1 - acc_a)
        elif mode == "maximum":
            pm = np.maximum(pm, ppm)
            acc_a = np.maximum(acc_a, pa)
        else:                             # blend - a running average
            pm = pm + ppm
            acc_a = acc_a + pa
    if mode == "blend":
        n = len(picks) + 1.0
        pm, acc_a = pm / n, acc_a / n
    return _unpremul(pm, np.clip(acc_a, 0, 1))


@effect("posterizeTime", "Posterize Time", "Time",
        "Hold the picture on twos, or on sixes - the animation-on-twos look, "
        "and the cheapest way to make 30fps footage read as film. The engine "
        "reads snapsTime and evaluates the layer at the quantised time; if it "
        "instead hands over history, this holds the last sampled frame itself.",
        {"rate": num(12, 1, 120, "how many new pictures per second survive", unit="fps")},
        touches_alpha=True, needsHistory=True, snapsTime=True)
def _posterize_time(rgba, p, ctx):
    fps = float(ctx.get("fps") or 30.0) or 30.0
    step = max(1, int(round(fps / max(1.0, p["rate"]))))
    if step == 1:
        return rgba
    back = _frame(ctx) % step
    if back == 0:
        return rgba                       # this IS a sample frame
    history = ctx.get("history") or []
    if len(history) < back:
        return rgba
    held = history[len(history) - back]
    if not isinstance(held, np.ndarray) or held.shape != rgba.shape:
        return rgba
    return held.astype(np.float32, copy=True)


# ---------------------------------------------------------------------------
# Matte
# ---------------------------------------------------------------------------

@effect("feather", "Feather", "Matte",
        "Soften the matte and nothing else. Bias exists because a symmetric "
        "feather always eats into the subject; push it out and the softness "
        "lands outside the silhouette where it belongs.",
        {"amount": num(6, 0, 200, "blur applied to alpha, in pixels", unit="px"),
         "bias": num(0, -100, 100, "positive pushes the soft edge outward, negative inward",
                     unit="%")},
        touches_alpha=True)
def _feather(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    a = np.clip(_blur_a(_alpha(rgba), p["amount"], ctx.get("draft")), 0, 1)
    if abs(p["bias"]) > 0.05:
        a = np.power(a, 2.0 ** (-p["bias"] / 50.0))
    return _pack(_rgb(rgba), a)


@effect("invertAlpha", "Invert Alpha", "Matte",
        "Swap what is solid for what is not. Two full inversions are exactly "
        "the identity, which is the property that makes it safe to keyframe.",
        {"amount": num(100, 0, 100, "100 is a full swap", unit="%")},
        touches_alpha=True)
def _invert_alpha(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    a = _alpha(rgba)
    return _pack(_rgb(rgba), a + (1.0 - 2.0 * a) * w)


@effect("premultiply", "Premultiply", "Matte",
        "Bake the matte into the colour against a background colour. What you "
        "reach for when a source arrived straight and the thing downstream "
        "expects it flattened.",
        {"matteColor": col([0, 0, 0], "the colour the edge is flattened against")})
def _premultiply(rgba, p, ctx):
    a = _alpha(rgba)
    matte = _rgb01(p["matteColor"])[None, None, :]
    return _pack(_rgb(rgba) * a[..., None] + matte * (1 - a)[..., None], a)


@effect("unpremultiply", "Unpremultiply", "Matte",
        "Remove a colour matte - the black fringe on a badly exported PNG, or "
        "the white halo on a logo cut against paper. Divide the colour back "
        "out and the edge stops glowing.",
        {"matteColor": col([0, 0, 0], "the colour that was baked in")})
def _unpremultiply(rgba, p, ctx):
    a = _alpha(rgba)
    matte = _rgb01(p["matteColor"])[None, None, :]
    rgb = (_rgb(rgba) - matte * (1 - a)[..., None]) / np.maximum(a, _EPS)[..., None]
    return _pack(np.clip(rgb, 0, 1), a)


# ---------------------------------------------------------------------------
# the entry point
# ---------------------------------------------------------------------------

def _coerce(spec, params):
    """Every value an effect body sees has been through here: unknown keys are
    dropped, missing ones take the catalog default, and everything else is
    clamped to the range the catalog advertises. An effect can therefore assume
    its parameters are sane, which is the only reason the bodies read as maths
    instead of validation."""
    out = {}
    src = params if isinstance(params, dict) else {}
    for key, p in spec.items():
        v = src.get(key, p["default"])
        kind = p["type"]
        if kind == "number":
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = float(p["default"])
            if not math.isfinite(v):
                v = float(p["default"])
            v = min(max(v, float(p["min"])), float(p["max"]))
            if p.get("integer"):
                v = int(round(v))
        elif kind == "bool":
            v = bool(v)
        elif kind == "enum":
            if v not in p["options"]:
                v = p["default"]
        elif kind == "color":
            try:
                chan = [min(255.0, max(0.0, float(c))) for c in list(v)[:4]]
            except (TypeError, ValueError):
                chan = []
            v = chan if len(chan) >= 3 else list(p["default"])
        elif kind == "points":
            clean = []
            for pt in (v if isinstance(v, (list, tuple)) else []):
                try:
                    if len(pt) == 2:
                        clean.append([min(255.0, max(0.0, float(pt[0]))),
                                      min(255.0, max(0.0, float(pt[1])))])
                except (TypeError, ValueError):
                    continue
            v = clean if len(clean) >= 2 else [list(q) for q in p["default"]]
        out[key] = v
    return out


def apply(name, rgba, params=None, ctx=None):
    """Run one effect. See the module docstring for the contract."""
    fn = _REGISTRY.get(str(name))
    if fn is None:
        return rgba
    if not isinstance(rgba, np.ndarray) or rgba.ndim != 3 or rgba.shape[2] != 4:
        return rgba
    if not np.issubdtype(rgba.dtype, np.floating):
        # An integer array is 0..255, not 0..1. Casting it would run every
        # effect on numbers a hundred times too big and return a white frame;
        # refusing it makes the mistake visible at the seam where it happened.
        return rgba
    arr = rgba if rgba.dtype == np.float32 else rgba.astype(np.float32)
    h, w = arr.shape[:2]
    c = dict(ctx or {})
    c.setdefault("t", 0.0)
    c.setdefault("fps", 30.0)
    c.setdefault("width", w)
    c.setdefault("height", h)
    c.setdefault("draft", False)
    c.setdefault("layer", {})
    try:
        out = fn(arr, _coerce(CATALOG[name]["params"], params), c)
    except Exception as exc:
        # One bad parameter must not lose an eight-second render. Loud on
        # stderr, though - an effect that quietly does nothing is the failure
        # nobody ever finds.
        print(f"[effects] {name} failed: {exc}", file=sys.stderr)
        return rgba
    if not isinstance(out, np.ndarray) or out.shape != arr.shape:
        return rgba
    if out is arr or out is rgba:
        return arr                        # a declared no-op, not a result
    if out.dtype != np.float32:
        out = out.astype(np.float32)
    # The 0..1 promise is enforced here rather than trusted from 52 places.
    # clip already folds the infinities in; NaN survives it, so it gets its own
    # pass - together about 7ms on a 1080p frame, where nan_to_num alone is 23.
    np.clip(out, 0.0, 1.0, out=out)
    np.copyto(out, 0.0, where=np.isnan(out))
    return out


def catalog():
    """What MCP and /api/vfx/catalog serve."""
    return {"effects": CATALOG, "groups": GROUP_ORDER, "names": sorted(_REGISTRY)}


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
