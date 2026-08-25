"""The brush class - every tool that arrives as a PATH and leaves as pixels.

`docs/IMAGE_SPEC.md` §5 is the contract. A stroke is a list of points in image
pixels; the rasterising happens HERE, never in the browser, because the whole
point of one implementation is that an agent posting a path and a person
dragging a mouse commit the same bytes.

    apply_stroke(rgba, stroke, mask=None) -> np.ndarray
    apply_strokes(rgba, strokes, mask=None) -> np.ndarray

    rgba    float32 (H, W, 4), 0..1, STRAIGHT (un-premultiplied) alpha
    stroke  { "tool", "points": [[x, y, pressure?]], ...catalog params }
    mask    float32 (H, W) 0..1, or None for "everywhere"
    return  the same shape as float32; the input is never written to, and a
            stroke with nothing to draw hands the input straight back

Straight alpha is not a detail. Painting over a half-transparent region with
premultiplied arithmetic and no divide leaves a grey rim on every edge that
nobody can explain afterwards, so `_over` divides and `_mix_rgba` divides, and
there is a test that fails the moment either one stops.

FOUR RULES, because they are what separates a brush from a polyline:

  1. STAMPS, not segments. The path is walked by ARC LENGTH and a dab is laid
     down every `spacing * size`, interpolating position and pressure between
     the points the client sent. Draw the path as lines instead and you have
     built a pen: no spacing, no per-dab pressure, no beads when spacing goes
     past 1.0. `spacing=2` giving separate blobs is a feature and a test.
  2. HARDNESS IS A CURVE. The stamp is 1 out to `hardness * radius` and
     smoothsteps to 0 at the rim - never a binary disc. Even at hardness 1 the
     falloff band is held open to one pixel, because a brush with an aliased
     edge is a bug report, not a hard brush.
  3. FLOW ACCUMULATES WITHIN ONE STROKE, OPACITY CAPS IT. One buffer `S` per
     stroke, each dab compositing `S += f*k*(1-S)`; what reaches the image is
     `opacity * S`. So a stroke that doubles back over itself at flow 0.5 gets
     darker (0.5 then 0.75) and the same stroke at opacity 0.5 does not (0.5
     then 0.5). ACROSS strokes opacity does compound - that is not a bug, it
     is the only way an opacity brush ever builds anything up, and it has its
     own test so nobody "fixes" it.
     `opacity * S` rather than `min(S, opacity)`: the cap has to scale the
     falloff, not clip it, or every soft brush at opacity 0.5 grows a mesa
     where the profile crosses 0.5.
  4. PRESSURE SCALES SIZE AND FLOW, both by default (`pressure: "both"`).
     Size alone tapers but leaves a thin hard scratch at the light end; flow
     alone fades at constant width, which is an airbrush and reads as one. A
     real nib does both, and the caller can have either on its own.

Twelve tools, one coverage map each, one commit path:

    brush eraser   clone heal smudge   blur sharpen   dodge burn sponge
    bucket gradient

Clone and heal both sample a SNAPSHOT taken at stroke start, offset by
`source - points[0]` and fixed for the stroke - sampling the live image is how
a clone stamp turns into a smear. They differ in what they do with the sample:
clone copies it, heal keeps only its DETAIL (`src - blur(src) + blur(dst)`) so
the patch takes the destination's shading and the source's texture. That is the
difference the spec refuses to let us fake, and the test asserts the low
frequencies land on the destination's, not the source's.

`CATALOG` describes every tool and EVERY parameter it honours - and only the
ones it honours, because a schema that accepts a knob the code ignores is worse
than a refusal. Colours are 0-255 RGBA throughout, the units the rest of the
document uses; a 0..1 triple is a legal near-black and nothing here can tell
the difference, which is exactly how that bug ships.

    python imgstroke.py catalog     # the catalog as one JSON line
    python imgstroke.py bench       # per-tool ms on a 2048x2048 plate

numpy / cv2.
"""
import json
import math
import sys
import time

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# the catalog
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Paint", "Retouch", "Focus", "Tone"]

PRESSURE_MODES = ["both", "size", "flow", "off"]
TONE_RANGES = ["shadows", "midtones", "highlights", "all"]
GRADIENT_SHAPES = ["linear", "radial", "angular"]

# An agent will guess these, and a guess that works is a round trip saved.
ALIASES = {
    "paintbrush": "brush", "paint": "brush",
    "erase": "eraser", "rubber": "eraser",
    "clonestamp": "clone", "cloneStamp": "clone", "stamp": "clone",
    "healingbrush": "heal", "healingBrush": "heal", "spotheal": "heal",
    "smear": "smudge", "finger": "smudge",
    "blurbrush": "blur", "sharpenbrush": "sharpen",
    "fill": "bucket", "paintbucket": "bucket", "paintBucket": "bucket",
    "floodfill": "bucket", "floodFill": "bucket",
    "gradientfill": "gradient", "gradientFill": "gradient", "ramp": "gradient",
}

MAX_DABS = 200_000          # a runaway path must not eat the box
_EPS = np.float32(1e-6)
LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)   # Rec.601, as imagetools uses


def num(default, lo, hi, desc, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": False, "desc": desc}
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


def col(default, desc):
    """0-255 RGBA. Three components are accepted and mean alpha 255."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": False, "desc": desc}


def vec2(default, desc, required=False):
    p = {"type": "vec2", "default": list(default), "min": -1e7, "max": 1e7,
         "animatable": False, "unit": "px", "desc": desc}
    if required:
        p["required"] = True
    return p


def tool(name, label, group, why, params, points, touches_alpha=False, **extra):
    entry = {"label": label, "group": group, "why": why, "params": params,
             "touchesAlpha": bool(touches_alpha), "points": points}
    entry.update(extra)
    CATALOG[name] = entry
    return entry


# Every stamped tool shares these. Repeating the dict per tool rather than
# nesting a "common" block, because the catalog is read as a flat schema and a
# caller should never have to merge two dicts to find out what brush takes.
def _stamp_params(**extra):
    p = {
        "size": num(24, 0, 4096, "brush diameter in pixels; under 0.5 nothing "
                                 "is laid down at all", unit="px"),
        "hardness": num(0.5, 0, 1, "0 is all falloff, 1 is a solid core with a "
                                   "one-pixel antialiased rim"),
        "opacity": num(1.0, 0, 1, "the most this ONE stroke can reach, whatever "
                                  "the flow builds up to"),
        "flow": num(1.0, 0, 1, "how much each dab lays down; accumulates where "
                               "the stroke crosses itself"),
        "spacing": num(0.25, 0.01, 4, "gap between dabs as a fraction of size; "
                                      "past 1.0 the stroke beads, and it is a "
                                      "DENSITY knob too - tighter spacing means "
                                      "more dabs at `flow` over the same pixel"),
        "pressure": pick(PRESSURE_MODES, "both",
                         "what the third component of a point drives - size, "
                         "flow, both, or nothing"),
    }
    p.update(extra)
    return p


PATH = "a path in image pixels, [[x, y, pressure?], ...]; pressure 0..1 " \
       "defaults to 1, and {x, y, pressure} objects are accepted too. One " \
       "point is a single dab - a click. A point with a NaN in it is dropped."

tool("brush", "Brush", "Paint",
     "Paint colour along a path. The tool everything else in this file is a "
     "variation on: a round stamp with a falloff, laid down every spacing*size "
     "and accumulated at flow.",
     _stamp_params(color=col([0, 0, 0, 255], "RGBA 0-255; alpha multiplies the "
                                             "stroke's coverage")),
     {"min": 1, "desc": PATH}, touches_alpha=True)

tool("eraser", "Eraser", "Paint",
     "Take alpha away along a path. Colour is left exactly where it was - in "
     "straight alpha an erased pixel keeps its RGB, which is what makes an "
     "erase undoable by painting alpha back.",
     _stamp_params(),
     {"min": 1, "desc": PATH}, touches_alpha=True)

tool("clone", "Clone Stamp", "Retouch",
     "Copy pixels from `source` to the path. The offset is source - points[0], "
     "fixed for the whole stroke, and the sample comes from a snapshot taken "
     "before the stroke started - sampling live pixels is how a clone turns "
     "into a smear.",
     _stamp_params(source=vec2([0, 0], "where the copy is taken FROM, in image "
                                       "pixels; no source means no stroke",
                               required=True)),
     {"min": 1, "desc": PATH}, touches_alpha=True)

tool("heal", "Healing Brush", "Retouch",
     "Clone the source's TEXTURE onto the destination's SHADING. It is "
     "src - blur(src) + blur(dst): the high frequencies come from the source, "
     "the low ones from where you are painting, so a patch lifted from a "
     "different exposure still matches. Alpha is left alone - healing is a "
     "retouch inside existing content, not a copy, so it will not punch a "
     "shape into a transparent region.",
     _stamp_params(source=vec2([0, 0], "where the texture is taken FROM, in "
                                       "image pixels; no source means no stroke",
                               required=True),
                   detailRadius=num(0, 0, 200, "px separating detail from "
                                               "shading; 0 ties it to size/4",
                                    unit="px")),
     {"min": 1, "desc": PATH})

tool("smudge", "Smudge", "Retouch",
     "Drag colour along the path. A brush-sized accumulator picks up what it "
     "passes over and lays it back down ahead of itself, so the smear runs in "
     "the direction of travel and dies out over roughly amount * a few brush "
     "widths.",
     _stamp_params(amount=num(0.5, 0, 1, "how much of the carried colour "
                                         "survives each dab; 1 smears forever")),
     {"min": 2, "desc": PATH + " Two points minimum - a smudge with no "
                               "direction has nothing to carry."},
     touches_alpha=True)

tool("blur", "Blur Brush", "Focus",
     "Soften under the brush only. Premultiplied internally and divided back "
     "out, so blurring across a cutout edge does not drag the colour of "
     "transparent pixels into it.",
     _stamp_params(amount=num(0.5, 0, 1, "strength; multiplies the stroke's "
                                         "coverage"),
                   radius=num(0, 0, 200, "blur sigma in px; 0 ties it to size/8",
                              unit="px")),
     {"min": 1, "desc": PATH}, touches_alpha=True)

tool("sharpen", "Sharpen Brush", "Focus",
     "Unsharp mask under the brush only: the picture plus its own detail. "
     "Pushed hard it haloes, like every sharpener ever written.",
     _stamp_params(amount=num(0.5, 0, 1, "strength; multiplies the stroke's "
                                         "coverage"),
                   radius=num(0, 0, 200, "detail sigma in px; 0 ties it to "
                                         "size/12", unit="px")),
     {"min": 1, "desc": PATH})

tool("dodge", "Dodge", "Tone",
     "Lighten, weighted by tonal range: c += amount * w(luma) * (1 - c), so a "
     "pixel already at white cannot go further and nothing clips.",
     _stamp_params(amount=num(0.3, 0, 1, "strength"),
                   range=pick(TONE_RANGES, "midtones",
                              "which tones it touches; shadows peaks at black, "
                              "midtones at 0.5, highlights at white, all is flat")),
     {"min": 1, "desc": PATH})

tool("burn", "Burn", "Tone",
     "Darken, weighted by tonal range: c -= amount * w(luma) * c, the exact "
     "mirror of dodge, so dodging what you burned walks back toward where you "
     "started instead of somewhere else.",
     _stamp_params(amount=num(0.3, 0, 1, "strength"),
                   range=pick(TONE_RANGES, "midtones", "which tones it touches")),
     {"min": 1, "desc": PATH})

tool("sponge", "Sponge", "Tone",
     "Push colour toward or away from its own luma. No tonal range - "
     "saturation is not a tonal property and pretending it is would put a "
     "parameter in the schema that does nothing.",
     _stamp_params(amount=num(0.5, 0, 1, "strength"),
                   mode=pick(["desaturate", "saturate"], "desaturate",
                             "toward grey, or away from it")),
     {"min": 1, "desc": PATH})

tool("bucket", "Paint Bucket", "Paint",
     "Flood fill from points[0]. Tolerance is a per-channel 0-255 distance "
     "from the seed colour, alpha included, so a transparent hole never merges "
     "with an opaque region that happens to be the same colour. Nothing about "
     "a fill is a stamp, so size, hardness, flow and spacing are not in its "
     "schema.",
     {"color": col([255, 0, 0, 255], "RGBA 0-255 to fill with"),
      "tolerance": num(32, 0, 255, "how far a channel may differ from the seed"),
      "contiguous": flag(True, "off fills every matching pixel in the image, "
                               "not just the region touching the seed"),
      "antialias": flag(True, "grow the fill half a pixel - a 0.5 rim - so it "
                              "covers the antialiased edge of whatever it stops at"),
      "opacity": num(1.0, 0, 1, "how strongly the fill is composited")},
     {"min": 1, "max": 1, "desc": "one point: the seed, in image pixels"},
     touches_alpha=True)

tool("gradient", "Gradient", "Paint",
     "A ramp between points[0] and points[1]. Linear projects onto the line, "
     "radial measures distance from the first point, angular sweeps a wheel "
     "starting at the direction of the second. Alpha ramps too, which is how "
     "you fade an image out rather than into a colour.",
     {"shape": pick(GRADIENT_SHAPES, "linear", "how the ramp is measured"),
      "color": col([0, 0, 0, 255], "RGBA 0-255 at points[0]"),
      "color2": col([255, 255, 255, 255], "RGBA 0-255 at points[1]"),
      "reverse": flag(False, "swap the two ends"),
      "opacity": num(1.0, 0, 1, "how strongly the ramp is composited")},
     {"min": 2, "max": 2, "desc": "two points: start and end, in image pixels"},
     touches_alpha=True)


# ---------------------------------------------------------------------------
# coercion - the same discipline effects.py uses: unknown keys are dropped,
# known ones are clamped, and nothing below ever sees a NaN or a string.
# ---------------------------------------------------------------------------

def _coerce(spec, params):
    src = params if isinstance(params, dict) else {}
    out = {}
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
            if not all(math.isfinite(c) for c in chan):
                chan = []
            if len(chan) == 3:
                chan.append(255.0)
            v = chan if len(chan) == 4 else list(p["default"])
        elif kind == "vec2":
            try:
                pair = [float(c) for c in list(v)[:2]]
            except (TypeError, ValueError):
                pair = []
            if p.get("required") and key not in src:
                pair = []               # ABSENT is not "the default", see below
            if len(pair) != 2 or not all(math.isfinite(c) for c in pair):
                # A missing required vec2 stays missing rather than defaulting.
                # Defaulting `source` to [0,0] would clone from the top-left
                # corner at a plausible-looking offset - a wrong picture that
                # never raises, which is the failure this file is trying to
                # avoid everywhere else.
                v = None if p.get("required") else list(p["default"])
            else:
                v = pair
        out[key] = v
    return out


def _rgba01(c):
    """0-255 RGBA -> float32 (4,) 0..1."""
    a = np.zeros(4, np.float32)
    a[3] = 1.0
    for i, v in enumerate(list(c)[:4]):
        a[i] = float(v) / 255.0
    return np.clip(a, 0.0, 1.0)


# ---------------------------------------------------------------------------
# the path
# ---------------------------------------------------------------------------

def _points(raw):
    """(N, 3) float32 of finite [x, y, pressure]. A point with a NaN in it is
    dropped rather than fixed up: an interpolated position invented out of a
    broken one is a stroke somewhere nobody asked for."""
    out = []
    for p in (raw if isinstance(raw, (list, tuple)) else []):
        if isinstance(p, dict):
            p = [p.get("x"), p.get("y"), p.get("pressure", p.get("p", 1.0))]
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        try:
            x, y = float(p[0]), float(p[1])
            pr = float(p[2]) if len(p) > 2 and p[2] is not None else 1.0
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if not math.isfinite(pr):
            pr = 1.0
        out.append((x, y, min(1.0, max(0.0, pr))))
    return out


def _walk(pts, size, spacing, mode):
    """Dabs along the path by ARC LENGTH: [(x, y, radius, flowScale), ...].

    The step is recomputed from the dab that was just laid down, so a tapering
    tip stays dense instead of thinning out into dots - spacing is a fraction
    of the size AT THAT POINT, not of the size the caller typed."""
    scale_size = mode in ("size", "both")
    scale_flow = mode in ("flow", "both")
    out = []

    def dab(x, y, pr):
        r = 0.5 * size * (pr if scale_size else 1.0)
        out.append((x, y, r, pr if scale_flow else 1.0))
        # 0.75px is the floor: a vanishing tip must not ask for a million dabs.
        return max(0.75, spacing * max(2.0 * r, 0.5))

    need = dab(pts[0][0], pts[0][1], pts[0][2])
    prev = pts[0]
    acc = 0.0
    for q in pts[1:]:
        dx, dy = q[0] - prev[0], q[1] - prev[1]
        seg = math.hypot(dx, dy)
        if seg < 1e-9:
            prev = q
            continue
        travelled = 0.0
        while acc + (seg - travelled) >= need:
            travelled += need - acc
            u = travelled / seg
            need = dab(prev[0] + dx * u, prev[1] + dy * u,
                       prev[2] + (q[2] - prev[2]) * u)
            acc = 0.0
            if len(out) >= MAX_DABS:
                return out
        acc += seg - travelled
        prev = q
    return out


def _profile(d, radius, hardness):
    """k(r): 1 out to hardness*radius, smoothstep to 0 at the rim.

    The band is held open to at least one pixel even at hardness 1, because a
    disc thresholded at a radius is aliased and every diagonal shows it."""
    outer = float(radius)
    inner = outer * float(hardness)
    if outer - inner < 1.0:
        inner = outer - 1.0
    if inner < 0.0:
        inner = 0.0
    band = outer - inner
    if band <= 1e-6:
        return (d <= outer).astype(np.float32)
    t = np.clip((d - inner) * np.float32(1.0 / band), 0.0, 1.0)
    return (1.0 - t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _accumulate(h, w, dabs, hardness, flow):
    """The stroke buffer. One pass per dab, compositing INTO what is already
    there - which is the whole of rule 3: overlapping dabs at flow 0.5 build
    0.5, 0.75, 0.875 and never reach 1, and at flow 1 the first dab is done."""
    s = np.zeros((h, w), np.float32)
    bx0, by0, bx1, by1 = w, h, 0, 0
    for (cx, cy, r, pf) in dabs:
        f = flow * pf
        if r < 0.25 or f <= 0.0:
            continue
        x0 = max(0, int(math.floor(cx - r)))
        y0 = max(0, int(math.floor(cy - r)))
        x1 = min(w, int(math.ceil(cx + r)) + 1)
        y1 = min(h, int(math.ceil(cy + r)) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        xs = (np.arange(x0, x1, dtype=np.float32) + np.float32(0.5)) - np.float32(cx)
        ys = (np.arange(y0, y1, dtype=np.float32) + np.float32(0.5)) - np.float32(cy)
        d = ys[:, None] * ys[:, None] + xs[None, :] * xs[None, :]
        np.sqrt(d, out=d)
        k = _profile(d, r, hardness)
        tile = s[y0:y1, x0:x1]
        tile += (np.float32(f) * k) * (1.0 - tile)
        bx0, by0 = min(bx0, x0), min(by0, y0)
        bx1, by1 = max(bx1, x1), max(by1, y1)
    if bx1 <= bx0 or by1 <= by0:
        return None, None
    return s, (by0, by1, bx0, bx1)


def _coverage(h, w, pts, p, mask):
    """What the stroke asks for, everywhere: opacity * accumulated flow, times
    the selection. Scaling the coverage IS §3's `result*m + original*(1-m)` -
    for a source-over it is algebraically identical, and for every lerp-shaped
    tool below the coverage is literally the lerp factor."""
    size = float(p["size"])
    if size < 0.5:
        return None, None
    dabs = _walk(pts, size, float(p["spacing"]), p["pressure"])
    cov, box = _accumulate(h, w, dabs, float(p["hardness"]), float(p["flow"]))
    if cov is None:
        return None, None
    cov *= np.float32(p["opacity"])
    y0, y1, x0, x1 = box
    cov[y0:y1, x0:x1] *= mask[y0:y1, x0:x1]
    return cov, box


# ---------------------------------------------------------------------------
# compositing - straight alpha, and the divide is the whole point
# ---------------------------------------------------------------------------

def _over(dst, cov, src_rgb, src_a):
    """Source-over in STRAIGHT alpha.

        ao = ca + ad(1-ca)          co = (C*ca + Cd*ad*(1-ca)) / ao

    written as a weight so the divide happens once: w = ca/ao, and
    ad(1-ca)/ao is exactly 1-w. Skip the divide and you get the premultiplied
    result presented as straight - white over half-transparent white comes out
    at 0.625 instead of 1.0, which is the grey fringe."""
    ad = dst[..., 3]
    ca = cov * src_a
    ao = ca + ad * (1.0 - ca)
    w = np.where(ao > _EPS, ca / np.maximum(ao, _EPS), 0.0).astype(np.float32)
    out = np.empty_like(dst)
    out[..., :3] = dst[..., :3] + (src_rgb - dst[..., :3]) * w[..., None]
    out[..., 3] = ao
    return out


def _mix_rgb(dst, eff, rgb):
    """Replace colour, leave alpha. Exact where eff is 0, which is what lets
    the mask test assert bit-identity outside the selection."""
    out = dst.copy()
    out[..., :3] = dst[..., :3] + (rgb - dst[..., :3]) * eff[..., None]
    return out


def _mix_rgba(dst, eff, other):
    """Blend two RGBA images. Premultiplied for the mix and divided back out -
    lerping straight colour drags the undefined colour of transparent pixels
    into the result. The `where` keeps untouched pixels BIT-identical: the
    premul/unpremul round trip is not exact in float and the mask test would
    catch it as a leak."""
    ad, ao_ = dst[..., 3], other[..., 3]
    a = ad + (ao_ - ad) * eff
    pm = dst[..., :3] * ad[..., None]
    pm = pm + (other[..., :3] * ao_[..., None] - pm) * eff[..., None]
    rgb = pm / np.maximum(a, _EPS)[..., None]
    touched = (eff > 0.0)[..., None]
    out = np.empty_like(dst)
    out[..., :3] = np.where(touched, rgb, dst[..., :3])
    out[..., 3] = np.where(eff > 0.0, a, ad)
    return out


def _luma(rgb):
    return rgb @ LUMA


def _premul(rgba):
    pm = rgba[..., :3] * rgba[..., 3:4]
    return pm, np.ascontiguousarray(rgba[..., 3])


def _unpremul(pm, a):
    out = np.empty(pm.shape[:2] + (4,), np.float32)
    out[..., :3] = pm / np.maximum(a, _EPS)[..., None]
    out[..., 3] = a
    return out


def _flat(a):
    """A matte with one value everywhere. Nothing can be dragged out of it, so
    premultiplying is the identity and four array passes can be skipped - which
    is most photographs, where alpha is 1 from corner to corner."""
    return float(a.min()) == float(a.max())


def _blur_rgba(rgba, sigma):
    """Gaussian on premultiplied pixels, divided back out - effects.py's rule,
    for the same reason: filter straight alpha and every edge grows a halo of
    whatever colour the transparent side happened to be storing."""
    if sigma < 0.05:
        return rgba
    k = max(3, int(sigma * 3.0) * 2 + 1)
    a = np.ascontiguousarray(rgba[..., 3])
    if _flat(a):
        out = np.empty_like(rgba)
        out[..., :3] = cv2.GaussianBlur(np.ascontiguousarray(rgba[..., :3]), (k, k),
                                        sigma, borderType=cv2.BORDER_REPLICATE)
        out[..., 3] = a
        return out
    pm, a = _premul(rgba)
    pm = cv2.GaussianBlur(np.ascontiguousarray(pm), (k, k), sigma,
                          borderType=cv2.BORDER_REPLICATE)
    a = cv2.GaussianBlur(a, (k, k), sigma, borderType=cv2.BORDER_REPLICATE)
    return _unpremul(pm, np.clip(a, 0.0, 1.0))


def _pad(box, pad, h, w):
    y0, y1, x0, x1 = box
    return (max(0, y0 - pad), min(h, y1 + pad),
            max(0, x0 - pad), min(w, x1 + pad))


def _shifted(arr, dx, dy):
    """The snapshot moved by (dx, dy), transparent outside. An integral offset
    goes through INTER_LINEAR untouched, so a clone at an integral offset is a
    bit-for-bit copy and the test can say so."""
    h, w = arr.shape[:2]
    m = np.array([[1.0, 0.0, -dx], [0.0, 1.0, -dy]], np.float32)
    if _flat(arr[..., 3]) and float(arr[..., 3].min()) >= 1.0:
        # Opaque everywhere: the warp cannot invent a fringe, and the border
        # still has to arrive transparent so a clone that reaches off-plate
        # composites as nothing rather than as black.
        out = np.empty_like(arr)
        out[...] = cv2.warpAffine(arr, m, (w, h), flags=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_CONSTANT,
                                  borderValue=(0, 0, 0, 0))
        return out
    pm, a = _premul(arr)
    pm = cv2.warpAffine(np.ascontiguousarray(pm), m, (w, h), flags=cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    a = cv2.warpAffine(a, m, (w, h), flags=cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return _unpremul(pm, np.clip(a, 0.0, 1.0))


def _range_weight(l, which):
    """Which tones a dodge or a burn is allowed to move. Triangular and
    piecewise-linear on purpose: a caller can work out what `midtones` does to
    a 0.25 pixel (0.5) without running it."""
    if which == "all":
        return np.ones_like(l)
    if which == "shadows":
        return np.clip(1.0 - 2.0 * l, 0.0, 1.0)
    if which == "highlights":
        return np.clip(2.0 * l - 1.0, 0.0, 1.0)
    return np.clip(1.0 - np.abs(2.0 * l - 1.0), 0.0, 1.0)


# ---------------------------------------------------------------------------
# the twelve
# ---------------------------------------------------------------------------

def _t_brush(arr, pts, p, mask):
    cov, box = _coverage(arr.shape[0], arr.shape[1], pts, p, mask)
    if cov is None:
        return None
    c = _rgba01(p["color"])
    y0, y1, x0, x1 = box
    out = arr.copy()
    out[y0:y1, x0:x1] = _over(arr[y0:y1, x0:x1], cov[y0:y1, x0:x1], c[:3], c[3])
    return out


def _t_eraser(arr, pts, p, mask):
    cov, box = _coverage(arr.shape[0], arr.shape[1], pts, p, mask)
    if cov is None:
        return None
    y0, y1, x0, x1 = box
    out = arr.copy()
    # RGB untouched: in straight alpha an erased pixel keeps its colour, so
    # painting alpha back restores the picture instead of a black hole.
    out[y0:y1, x0:x1, 3] = arr[y0:y1, x0:x1, 3] * (1.0 - cov[y0:y1, x0:x1])
    return out


def _offset(pts, p):
    src = p.get("source")
    if src is None:
        return None
    return float(src[0]) - pts[0][0], float(src[1]) - pts[0][1]


def _t_clone(arr, pts, p, mask):
    off = _offset(pts, p)
    if off is None:
        print("[imgstroke] clone without a usable source - nothing drawn", file=sys.stderr)
        return None
    cov, box = _coverage(arr.shape[0], arr.shape[1], pts, p, mask)
    if cov is None:
        return None
    y0, y1, x0, x1 = box
    src = _shifted(arr, off[0], off[1])[y0:y1, x0:x1]
    out = arr.copy()
    out[y0:y1, x0:x1] = _over(arr[y0:y1, x0:x1], cov[y0:y1, x0:x1],
                              src[..., :3], src[..., 3])
    return out


def _t_heal(arr, pts, p, mask):
    off = _offset(pts, p)
    if off is None:
        print("[imgstroke] heal without a usable source - nothing drawn", file=sys.stderr)
        return None
    h, w = arr.shape[:2]
    cov, box = _coverage(h, w, pts, p, mask)
    if cov is None:
        return None
    sigma = float(p["detailRadius"]) or max(1.0, float(p["size"]) / 4.0)
    # Blur over a padded window and crop back: a gaussian evaluated on the
    # bounding box alone gets its low frequencies from the box edge, which is
    # exactly where a heal is judged.
    py0, py1, px0, px1 = _pad(box, int(math.ceil(sigma * 3.0)) + 2, h, w)
    dst = arr[py0:py1, px0:px1]
    src = _shifted(arr, off[0], off[1])[py0:py1, px0:px1]
    healed = np.clip(src[..., :3] - _blur_rgba(src, sigma)[..., :3]
                     + _blur_rgba(dst, sigma)[..., :3], 0.0, 1.0)
    y0, y1, x0, x1 = box
    out = arr.copy()
    # Only where the source actually has something to give: healing from a
    # transparent region would paste its undefined colour as "detail".
    eff = cov[y0:y1, x0:x1] * src[y0 - py0:y1 - py0, x0 - px0:x1 - px0, 3]
    out[y0:y1, x0:x1] = _mix_rgb(arr[y0:y1, x0:x1], eff,
                                 healed[y0 - py0:y1 - py0, x0 - px0:x1 - px0])
    return out


def _t_smudge(arr, pts, p, mask):
    h, w = arr.shape[:2]
    size = float(p["size"])
    if size < 0.5:
        return None
    dabs = _walk(pts, size, float(p["spacing"]), p["pressure"])
    if not dabs:
        return None
    # Sequential by nature: a smudge is a state machine dragged along the path,
    # so it cannot go through the stroke buffer the other ten share. Flow still
    # scales each dab and opacity still caps the lot.
    rate = float(p["amount"])
    gain = float(p["opacity"]) * float(p["flow"])
    r0 = max(1, int(math.ceil(0.5 * size)))
    n = r0 * 2 + 1
    out = arr.copy()
    acc_pm = None
    acc_a = None
    bx0, by0, bx1, by1 = w, h, 0, 0
    xs0 = np.arange(n, dtype=np.float32) + np.float32(0.5)
    for (cx, cy, r, pf) in dabs:
        if r < 0.25:
            continue
        ix, iy = int(math.floor(cx)) - r0, int(math.floor(cy)) - r0
        sx0, sy0 = max(0, ix), max(0, iy)
        sx1, sy1 = min(w, ix + n), min(h, iy + n)
        if sx1 <= sx0 or sy1 <= sy0:
            continue
        tx0, ty0 = sx0 - ix, sy0 - iy
        tile = out[sy0:sy1, sx0:sx1]
        under_pm = tile[..., :3] * tile[..., 3:4]
        under_a = tile[..., 3]
        if acc_pm is None:
            acc_pm = np.zeros((n, n, 3), np.float32)
            acc_a = np.zeros((n, n), np.float32)
            acc_pm[ty0:ty0 + (sy1 - sy0), tx0:tx0 + (sx1 - sx0)] = under_pm
            acc_a[ty0:ty0 + (sy1 - sy0), tx0:tx0 + (sx1 - sx0)] = under_a
        # Pick up what is under us, then lay the carried colour back down. The
        # pick-up happens first so a dab that has moved on already carries the
        # colour it just crossed - that is what makes the smear directional.
        aw = acc_pm[ty0:ty0 + (sy1 - sy0), tx0:tx0 + (sx1 - sx0)]
        aa = acc_a[ty0:ty0 + (sy1 - sy0), tx0:tx0 + (sx1 - sx0)]
        aw *= rate
        aw += under_pm * (1.0 - rate)
        aa *= rate
        aa += under_a * (1.0 - rate)
        dx = (xs0[tx0:tx0 + (sx1 - sx0)] + np.float32(ix)) - np.float32(cx)
        dy = (xs0[ty0:ty0 + (sy1 - sy0)] + np.float32(iy)) - np.float32(cy)
        d = np.sqrt(dy[:, None] * dy[:, None] + dx[None, :] * dx[None, :])
        k = _profile(d, r, float(p["hardness"]))
        k = np.clip(k * (gain * pf), 0.0, 1.0) * mask[sy0:sy1, sx0:sx1]
        new_pm = under_pm + (aw - under_pm) * k[..., None]
        new_a = under_a + (aa - under_a) * k
        touched = (k > 0.0)
        tile[..., :3] = np.where(touched[..., None],
                                 new_pm / np.maximum(new_a, _EPS)[..., None],
                                 tile[..., :3])
        tile[..., 3] = np.where(touched, new_a, under_a)
        bx0, by0 = min(bx0, sx0), min(by0, sy0)
        bx1, by1 = max(bx1, sx1), max(by1, sy1)
    if bx1 <= bx0:
        return None
    return out


def _focus(arr, pts, p, mask, auto, fn):
    h, w = arr.shape[:2]
    cov, box = _coverage(h, w, pts, p, mask)
    if cov is None:
        return None
    sigma = float(p["radius"]) or max(0.6, float(p["size"]) / auto)
    py0, py1, px0, px1 = _pad(box, int(math.ceil(sigma * 3.0)) + 2, h, w)
    y0, y1, x0, x1 = box
    win = arr[py0:py1, px0:px1]
    res = fn(win, sigma)[y0 - py0:y1 - py0, x0 - px0:x1 - px0]
    eff = cov[y0:y1, x0:x1] * np.float32(p["amount"])
    out = arr.copy()
    out[y0:y1, x0:x1] = _mix_rgba(arr[y0:y1, x0:x1], eff, res)
    return out


def _t_blur(arr, pts, p, mask):
    return _focus(arr, pts, p, mask, 8.0, _blur_rgba)


def _t_sharpen(arr, pts, p, mask):
    def sharp(win, sigma):
        low = _blur_rgba(win, sigma)
        out = np.empty_like(win)
        # Twice the difference at full strength: enough to be obviously a
        # sharpen at amount 1 without inverting anything at the edges.
        out[..., :3] = np.clip(win[..., :3] + (win[..., :3] - low[..., :3]) * 2.0, 0.0, 1.0)
        out[..., 3] = win[..., 3]
        return out
    return _focus(arr, pts, p, mask, 12.0, sharp)


def _tone(arr, pts, p, mask, fn):
    cov, box = _coverage(arr.shape[0], arr.shape[1], pts, p, mask)
    if cov is None:
        return None
    y0, y1, x0, x1 = box
    win = arr[y0:y1, x0:x1]
    rgb = win[..., :3]
    eff = cov[y0:y1, x0:x1] * np.float32(p["amount"])
    out = arr.copy()
    out[y0:y1, x0:x1, :3] = np.clip(fn(rgb, _luma(rgb), eff), 0.0, 1.0)
    return out


def _t_dodge(arr, pts, p, mask):
    return _tone(arr, pts, p, mask, lambda rgb, l, eff: rgb + (
        eff * _range_weight(l, p["range"]))[..., None] * (1.0 - rgb))


def _t_burn(arr, pts, p, mask):
    return _tone(arr, pts, p, mask, lambda rgb, l, eff: rgb - (
        eff * _range_weight(l, p["range"]))[..., None] * rgb)


def _t_sponge(arr, pts, p, mask):
    sat = p["mode"] == "saturate"

    def fn(rgb, l, eff):
        g = (1.0 + 2.0 * eff) if sat else (1.0 - eff)
        return l[..., None] + (rgb - l[..., None]) * g[..., None]
    return _tone(arr, pts, p, mask, fn)


def _t_bucket(arr, pts, p, mask):
    h, w = arr.shape[:2]
    sx, sy = int(math.floor(pts[0][0])), int(math.floor(pts[0][1]))
    if not (0 <= sx < w and 0 <= sy < h):
        print(f"[imgstroke] bucket seed ({pts[0][0]}, {pts[0][1]}) is outside "
              f"the {w}x{h} image - nothing filled", file=sys.stderr)
        return None
    seed = arr[sy, sx]
    tol = np.float32(float(p["tolerance"]) / 255.0)
    # Per-channel max distance, alpha included: a transparent hole and an
    # opaque patch of the same RGB are different regions and a fill that runs
    # between them is the bug people report as "it leaked".
    d = np.abs(arr - seed[None, None, :]).max(axis=2)
    cov = (d <= tol).astype(np.float32)
    if p["contiguous"]:
        _, lab = cv2.connectedComponents(cov.astype(np.uint8), connectivity=4)
        cov = (lab == lab[sy, sx]).astype(np.float32)
    if p["antialias"]:
        # Grow the fill by HALF A PIXEL: the inside stays exactly 1, every
        # pixel the region touches edge-on gets exactly 0.5. That is the rim
        # that covers the antialiased edge of whatever the fill stopped at -
        # leave it out and a fill against a drawn line keeps a one-pixel halo
        # of the old colour, which is the "it didn't fill properly" bug.
        # A blurred skirt would do the same job with a magic sigma and an
        # interior that is no longer exactly 1; this is arithmetic.
        grown = cv2.dilate(cov, np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], np.uint8))
        cov = np.maximum(cov, 0.5 * grown)
    cov *= np.float32(p["opacity"]) * mask
    c = _rgba01(p["color"])
    return _over(arr, cov, c[:3], c[3])


def _t_gradient(arr, pts, p, mask):
    h, w = arr.shape[:2]
    (x0, y0), (x1, y1) = (pts[0][0], pts[0][1]), (pts[1][0], pts[1][1])
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length < 1e-6:
        print("[imgstroke] gradient endpoints coincide - nothing drawn", file=sys.stderr)
        return None
    px = (np.arange(w, dtype=np.float32) + np.float32(0.5)) - np.float32(x0)
    py = (np.arange(h, dtype=np.float32) + np.float32(0.5)) - np.float32(y0)
    shape = p["shape"]
    if shape == "linear":
        t = (px[None, :] * np.float32(dx) + py[:, None] * np.float32(dy)) / np.float32(length * length)
    elif shape == "radial":
        t = np.sqrt(px[None, :] ** 2 + py[:, None] ** 2) / np.float32(length)
    else:
        ang = np.arctan2(np.broadcast_to(py[:, None], (h, w)),
                         np.broadcast_to(px[None, :], (h, w)))
        t = np.mod(ang - np.float32(math.atan2(dy, dx)), np.float32(2.0 * math.pi))
        t = t / np.float32(2.0 * math.pi)
    t = np.clip(t, 0.0, 1.0).astype(np.float32)
    if p["reverse"]:
        t = 1.0 - t
    a, b = _rgba01(p["color"]), _rgba01(p["color2"])
    rgb = a[None, None, :3] + (b[:3] - a[:3])[None, None, :] * t[..., None]
    alpha = a[3] + (b[3] - a[3]) * t
    return _over(arr, np.float32(p["opacity"]) * mask, rgb, alpha)


_TOOLS = {
    "brush": _t_brush, "eraser": _t_eraser, "clone": _t_clone, "heal": _t_heal,
    "smudge": _t_smudge, "blur": _t_blur, "sharpen": _t_sharpen,
    "dodge": _t_dodge, "burn": _t_burn, "sponge": _t_sponge,
    "bucket": _t_bucket, "gradient": _t_gradient,
}


# ---------------------------------------------------------------------------
# the entry points
# ---------------------------------------------------------------------------

def _usable(rgba):
    return (isinstance(rgba, np.ndarray) and rgba.ndim == 3 and rgba.shape[2] == 4
            and np.issubdtype(rgba.dtype, np.floating)
            and rgba.shape[0] > 0 and rgba.shape[1] > 0)


_ONE = np.float32(1.0)


def _mask_for(mask, h, w):
    """The selection, or a read-only field of ones. §3 asks for no branch on
    "no selection" and a broadcast view gives that for nothing.

    A mask of the WRONG SHAPE is not treated as absent. Absent means "paint
    everywhere", which is precisely the damage a caller was trying to prevent
    by sending one; refusing the stroke is recoverable, painting over the rest
    of the picture is not."""
    if mask is None:
        return np.broadcast_to(_ONE, (h, w)), True
    if not isinstance(mask, np.ndarray) or mask.shape != (h, w):
        print(f"[imgstroke] mask is {getattr(mask, 'shape', type(mask).__name__)}, "
              f"expected ({h}, {w}) - stroke skipped rather than painted "
              f"outside the selection", file=sys.stderr)
        return None, False
    m = np.nan_to_num(mask.astype(np.float32, copy=False), nan=0.0,
                      posinf=1.0, neginf=0.0)
    return np.clip(m, 0.0, 1.0), True


def apply_stroke(rgba, stroke, mask=None):
    """One stroke. See the module docstring for the contract."""
    if not _usable(rgba):
        return rgba
    if not isinstance(stroke, dict):
        return rgba
    arr = rgba if rgba.dtype == np.float32 else rgba.astype(np.float32)
    name = str(stroke.get("tool") or "")
    name = ALIASES.get(name, name)
    entry = CATALOG.get(name)
    if entry is None:
        print(f"[imgstroke] no such tool {name!r} - nothing drawn", file=sys.stderr)
        return rgba
    h, w = arr.shape[:2]
    m, ok = _mask_for(mask, h, w)
    if not ok:
        return rgba
    pts = _points(stroke.get("points"))
    need = int(entry["points"]["min"])
    if len(pts) < need:
        # Not an error and not a warning: a client sends an empty path on every
        # click that was really a mis-click, and a stroke of one point is a dot.
        if len(pts) == 1 and need > 1:
            print(f"[imgstroke] {name} needs {need} points, got 1 - nothing drawn",
                  file=sys.stderr)
        return rgba
    p = _coerce(entry["params"], stroke)
    try:
        out = _TOOLS[name](arr, pts, p, m)
    except Exception as exc:
        # One bad stroke must not lose the edit. Loud on stderr, though - a
        # tool that quietly does nothing is the failure nobody ever finds.
        print(f"[imgstroke] {name} failed: {exc}", file=sys.stderr)
        return rgba
    if out is None:
        return rgba
    if not isinstance(out, np.ndarray) or out.shape != arr.shape:
        return rgba
    if out.dtype != np.float32:
        out = out.astype(np.float32)
    np.clip(out, 0.0, 1.0, out=out)
    np.copyto(out, 0.0, where=np.isnan(out))
    return out


def apply_strokes(rgba, strokes, mask=None):
    """Stage 7 of the pipeline: the strokes in the order given, each one seeing
    what the last one left."""
    out = rgba
    for s in (strokes if isinstance(strokes, (list, tuple)) else []):
        out = apply_stroke(out, s, mask)
    return out


def catalog():
    """What MCP and the Images screen serve for strokes."""
    return {
        "tools": CATALOG, "groups": GROUP_ORDER, "names": sorted(CATALOG),
        "aliases": ALIASES,
        "notes": {
            "coordinates": "image pixels; pixel (row i, col j) is the square "
                           "[j, j+1) x [i, i+1), so its centre is (j+0.5, i+0.5)",
            "colors": "0-255 RGBA; a 0..1 triple is a legal near-black and "
                      "nothing here can tell the two apart",
            "alpha": "float32 (H, W, 4) 0..1 STRAIGHT alpha in and out",
            "flow": "accumulates within one stroke, opacity caps it; across "
                    "two strokes opacity compounds, which is how build-up works",
            "pressure": "the optional third component of a point, 0..1, "
                        "scaling size and flow by default",
            "selection": "every tool multiplies its coverage by the mask, "
                         "which is §3's result*m + original*(1-m)",
        },
    }


def _bench(size=2048, n=500):
    """Per-tool ms for one 500-point stroke at size 40 on a 2048x2048 plate -
    the shape the spec asks about."""
    rng = np.random.default_rng(7)
    img = rng.random((size, size, 4), dtype=np.float32) * 0.5 + 0.25
    img[..., 3] = 1.0
    tt = np.linspace(0.0, 1.0, n, dtype=np.float64)
    path = [[200.0 + tv * (size - 400.0),
             size * 0.5 + math.sin(tv * 9.0) * size * 0.3,
             0.4 + 0.6 * abs(math.sin(tv * 3.0))] for tv in tt]
    common = {"points": path, "size": 40, "hardness": 0.5, "spacing": 0.25,
              "color": [255, 40, 90, 255], "amount": 0.5,
              "source": [path[0][0] + 120.0, path[0][1] + 80.0]}
    out = {}
    for name in sorted(CATALOG):
        job = dict(common, tool=name)
        if name == "gradient":
            job["points"] = [[200.0, 200.0], [size - 200.0, size - 200.0]]
        apply_stroke(img, job)                    # warm
        t0 = time.perf_counter()
        apply_stroke(img, job)
        out[name] = round((time.perf_counter() - t0) * 1000.0, 1)
    return out


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    elif mode == "bench":
        print(json.dumps({"ok": True, "ms": _bench(), "size": "2048x2048",
                          "stroke": "500 points, size 40, spacing 0.25"}, indent=2))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
