"""The Lightroom half of the image editor - the tools people reach for on a
PHOTOGRAPH, as opposed to the 25 Photoshop adjustments in imagetools.py and the
75 compositing effects in vfx/effects.py.

Nothing here is a second copy of anything there. What is already covered and is
deliberately NOT reimplemented:

  * brightness / contrast / saturation / gamma / levels / curves / shadows /
    highlights / HSL bands / denoise / sharpen  -> imagetools.apply_edit
  * vibrance, colorBalance, channelMixer, shadowHighlight, unsharpMask,
    lensDistortion, chromaticAberration                -> vfx/effects.py
  * a crude +-12% red/blue `temperature` slider        -> imagetools.apply_edit

The contract is §8 of docs/IMAGE_SPEC.md, the same one effects.py signs:

    apply(name, rgba, params, mask) -> np.ndarray
    analyze(name, rgba, params, mask) -> dict

    rgba    float32 (H, W, 4), 0..1, STRAIGHT (un-premultiplied) alpha
    mask    float32 (H, W), 0..1, or None meaning all ones (§3)
    return  the same shape and dtype; the input is never written to

`CATALOG` describes every tool and every parameter the way effects.py does, so
MCP and the UI both read it instead of guessing. `apply` drops unknown keys and
clamps known ones before a body ever sees them - the coercion is effects.py's,
imported rather than copied, because two clampers is one clamper that drifts.

IMPORT DIRECTION, and it matters. This module imports vfx/effects.py; effects.py
imports imagetools.py for `_blend`. So imagetools must import THIS one lazily,
inside the function that uses it, exactly the way `_effects_registry()` already
does - a module-level `import imgphoto` at the top of imagetools closes the
cycle and the whole editor stops loading.

LINEAR LIGHT vs GAMMA, tool by tool. Getting this wrong is the difference
between a photo tool and a filter, so it is written down rather than remembered:

  dehaze              LINEAR. I = J*t + A*(1-t) is a radiance equation. Haze
                      ADDS scattered light; addition is only addition where the
                      numbers are proportional to photons. Run on sRGB code
                      values it degenerates into a contrast slider, which is
                      exactly what most "dehaze" sliders are.
  highlightRecovery   LINEAR. What is being reconstructed is a RATIO between
                      channels - the sensor's, before the curve - and a ratio
                      survives only in linear light. In gamma space the same
                      recovery invents a hue.
  whiteBalance        LINEAR. Chromatic adaptation is a 3x3 on tristimulus
                      values. Von Kries scaling applied to gamma-encoded numbers
                      is the channel-scale hack this tool exists to replace.
  clarity             GAMMA, deliberately. It is a PERCEPTUAL midtone move, and
                      the midtone mask that protects the two ends only means
                      anything on a roughly perceptually-uniform scale. In
                      linear light "the midtones" is a sliver near 0.2 and the
                      protection lands in the wrong place.
  texture             GAMMA, same reason, plus: the noise floor it thresholds
                      against is a display-referred quantity.
  splitTone           GAMMA. The shadow/highlight masks are defined on the tones
                      a person SEES; a colourist grades the display-referred
                      picture. Also a hue rotation genuinely does not need
                      linear light - it is a rotation, not a sum.
  autoStraighten      GAMMA. Canny's thresholds are contrast thresholds; in
                      linear light every shadow edge falls below them.
  autoTone            GAMMA. It is proposing values for controls that are
                      themselves defined on gamma-encoded numbers.

TWO OF THESE RETURN NUMBERS, NOT PIXELS. `autoStraighten` returns the angle
because rotation belongs to whoever owns geometry, and `autoTone` returns the
control values it chose because a one-click that cannot be seen or nudged is a
black box. Both are `analysis: true` in the catalog and both are a bit-identical
no-op through `apply`.

    python imgphoto.py catalog        # the catalog as one JSON line

The `mask` is whatever server/imgselect.py resolves at stage 4. This module
does NOT import it and does not build one of its own - it takes the array and
honours it, so the two connect when the integrator wires them and there is
never a second implementation of a selection to disagree with the first.

numpy / cv2, plus the parameter vocabulary, the coercion and the blur from
vfx/effects.py.
"""
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vfx"))
from effects import (LUMA, _alpha, _blur2, _coerce, _pack, _rgb,     # noqa: E402
                     _smoothstep, flag, num, pick)


# ---------------------------------------------------------------------------
# the registry
# ---------------------------------------------------------------------------

CATALOG = {}
_REGISTRY = {}
_ANALYZERS = {}

GROUP_ORDER = ["Tone", "Color", "Detail", "Analysis"]


def tool(name, label, group, why, params, **extra):
    """Register a pixel tool. `extra` is the same escape hatch effects.py uses
    for `needsHistory` and friends - here it carries `analysis` and `returns`."""
    def deco(fn):
        entry = {"label": label, "group": group, "why": why,
                 "touchesAlpha": False, "params": params}
        entry.update(extra)
        CATALOG[name] = entry
        _REGISTRY[name] = fn
        return fn
    return deco


def analyzer(name):
    """Mark a function as the `analyze` implementation for a catalog entry.
    Separate from `tool` because whiteBalance is both: it moves pixels AND can
    report the temperature and tint it worked out."""
    def deco(fn):
        _ANALYZERS[name] = fn
        return fn
    return deco


# ---------------------------------------------------------------------------
# colour space
# ---------------------------------------------------------------------------

def _to_linear(c):
    """sRGB EOTF, and the PIECEWISE one.

    The 2.2-power shortcut is out by 8e-4 in linear at black, which is three
    display levels of lift in the deepest shadow - the exact place a dehaze and
    a highlight recovery are doing their arithmetic, and the exact place a
    photographer looks first.

    cv2.pow rather than np.power because it is four times faster on 50M floats
    and this runs twice per linear-light tool; the toe is patched in afterwards
    so only one power pass is ever paid for.
    """
    c = np.clip(np.asarray(c, np.float32), 0.0, 1.0)
    out = cv2.pow(np.maximum((c + np.float32(0.055)) * np.float32(1.0 / 1.055),
                             np.float32(0.0)), 2.4)
    np.copyto(out, c * np.float32(1.0 / 12.92), where=c <= np.float32(0.04045))
    return out


def _to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0.0, 1.0)
    out = cv2.pow(c, 1.0 / 2.4)
    out *= np.float32(1.055)
    out -= np.float32(0.055)
    np.copyto(out, c * np.float32(12.92), where=c <= np.float32(0.0031308))
    return out


# sRGB primaries against D65 - the matrix pair everything chromatic goes through.
_RGB2XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                     [0.2126729, 0.7151522, 0.0721750],
                     [0.0193339, 0.1191920, 0.9503041]], np.float64)
_XYZ2RGB = np.linalg.inv(_RGB2XYZ)

# Bradford, the transform every raw converter adapts with. Von Kries (the
# identity cone matrix) is the textbook one and is visibly worse on tungsten.
_BRADFORD = np.array([[0.8951, 0.2664, -0.1614],
                      [-0.7502, 1.7135, 0.0367],
                      [0.0389, -0.0685, 1.0296]], np.float64)
_BRADFORD_INV = np.linalg.inv(_BRADFORD)

_D65_XYZ = np.array([0.95047, 1.0, 1.08883], np.float64)


def _bradford_matrix(src_white_xyz, dst_white_xyz=None):
    """The linear-sRGB 3x3 that moves `src_white` to `dst_white`.

    Worth knowing before reading the callers: because the source white is
    normalised to Y=1 and D65 is too, a pixel that IS the source white comes out
    as (Y, Y, Y) with its own luminance intact. Luminance preservation is not a
    flag here, it is a property of the construction - which is why there is no
    flag for it in the catalog.
    """
    dst = _D65_XYZ if dst_white_xyz is None else np.asarray(dst_white_xyz, np.float64)
    src = np.asarray(src_white_xyz, np.float64)
    rho_s = _BRADFORD @ src
    rho_d = _BRADFORD @ dst
    # A source white with a dead channel is a black or absurd pick; the guard
    # keeps the ratio finite instead of returning a matrix full of infinities.
    ratio = rho_d / np.where(np.abs(rho_s) < 1e-9, 1e-9, rho_s)
    cat = _BRADFORD_INV @ np.diag(ratio) @ _BRADFORD
    return (_XYZ2RGB @ cat @ _RGB2XYZ).astype(np.float64)


def _planckian_xy(kelvin):
    """CIE 1931 xy on the Planckian locus - Kim et al.'s cubics, valid
    1667..25000K. Used only to answer "what colour temperature was that pick",
    never to move a pixel."""
    t = float(min(25000.0, max(1667.0, kelvin)))
    if t <= 4000.0:
        x = (-0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2
             + 0.8776956e3 / t + 0.179910)
    else:
        x = (-3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2
             + 0.2226347e3 / t + 0.240390)
    if t <= 2222.0:
        y = -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    elif t <= 4000.0:
        y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483
    return float(x), float(y)


def _xy_to_uv(x, y):
    """CIE 1960 UCS. Duv is only meaningful here, which is why tint is measured
    here and not in xy."""
    d = -2.0 * x + 12.0 * y + 3.0
    if abs(d) < 1e-9:
        return 0.0, 0.0
    return 4.0 * x / d, 6.0 * y / d


def _cct_and_tint(xyz):
    """Correlated colour temperature (McCamy) and signed Duv for an illuminant.

    Tint is reported as Duv, positive toward green and negative toward magenta -
    the actual physical quantity, rather than an invented -150..150 slider that
    would only be honest inside one vendor's UI.
    """
    s = float(xyz[0] + xyz[1] + xyz[2])
    if s <= 1e-9:
        return 0.0, 0.0
    x, y = float(xyz[0]) / s, float(xyz[1]) / s
    denom = 0.1858 - y
    cct = 0.0
    if abs(denom) > 1e-6:
        n = (x - 0.3320) / denom
        cct = 449.0 * n ** 3 + 3525.0 * n ** 2 + 6823.3 * n + 5520.33
    cct = float(min(25000.0, max(1000.0, cct)))
    u, v = _xy_to_uv(x, y)
    # Closest point on the locus, found by sampling rather than by Robertson's
    # isotherm table: 400 samples is 0.02 in Duv terms and this is a readout.
    best, best_d2, best_v = 0.0, 1e9, 0.0
    for k in np.geomspace(1667.0, 25000.0, 400):
        px, py = _planckian_xy(float(k))
        pu, pv = _xy_to_uv(px, py)
        d2 = (u - pu) ** 2 + (v - pv) ** 2
        if d2 < best_d2:
            best_d2, best, best_v = d2, float(k), pv
    duv = math.sqrt(best_d2) * (1.0 if v >= best_v else -1.0)
    return cct, float(duv)


# ---------------------------------------------------------------------------
# shared plumbing
# ---------------------------------------------------------------------------

def _luma(rgb):
    return rgb @ LUMA


def _short_side(rgba):
    h, w = rgba.shape[:2]
    return float(max(1, min(h, w)))


def _px(rgba, percent):
    """A radius given as a percent of the shorter side, in pixels.

    Every radius in this module is a percentage for one reason: a photograph and
    its export are the same photograph. A 30px clarity radius is a look at 1000
    pixels wide and a rounding error at 4096, and nobody ever notices until the
    web version comes back flat.
    """
    return float(percent) / 100.0 * _short_side(rgba)


def _guided(guide, src, radius, eps):
    """He, Sun & Tang's guided filter, on box sums.

    Edge-aware smoothing where the edges come from a DIFFERENT image - which is
    the whole trick behind a transmission map that follows the buildings instead
    of blurring across them. opencv-python ships without ximgproc, so it is here
    rather than imported; it is six box filters and a division.
    """
    r = max(1, int(round(radius)))
    k = (r * 2 + 1, r * 2 + 1)
    guide = np.ascontiguousarray(guide, np.float32)
    src = np.ascontiguousarray(src, np.float32)
    mean_i = cv2.boxFilter(guide, cv2.CV_32F, k)
    mean_p = cv2.boxFilter(src, cv2.CV_32F, k)
    var_i = cv2.boxFilter(guide * guide, cv2.CV_32F, k) - mean_i * mean_i
    cov = cv2.boxFilter(guide * src, cv2.CV_32F, k) - mean_i * mean_p
    a = cov / (var_i + float(eps))
    b = mean_p - a * mean_i
    return (cv2.boxFilter(a, cv2.CV_32F, k) * guide
            + cv2.boxFilter(b, cv2.CV_32F, k)).astype(np.float32)


_STAT_SAMPLE = 400_000      # a percentile off this many pixels is inside a
                            # tenth of a percent of the exact one, and np.percentile
                            # SORTS - at 4K the exact answer costs seconds


def _thin(a):
    """A deterministic subsample for the histogram statistics.

    A stride rather than an RNG: two runs of auto-tone on the same picture must
    propose the same numbers, or the panel disagrees with itself every time a
    slider is touched. A stride can alias against a repeating pattern; the
    quantities being read are percentiles of a whole frame, which is the one
    place that does not matter.
    """
    n = a.shape[0]
    if n <= _STAT_SAMPLE:
        return a
    return a[::max(1, n // _STAT_SAMPLE)]


def _valid(rgba, m):
    """Which pixels the STATISTICS may look at: opaque, and inside the mask.

    Thresholded at 0.5 rather than weighted, because a percentile of a weighted
    cloud is not a percentile, and pretending otherwise is how an auto-tone ends
    up quietly averaging in the transparent border it was cropped out of.
    """
    ok = _alpha(rgba) > 0.5
    if m is not None:
        ok = ok & (m > 0.5)
    if not ok.any():
        ok = np.ones(rgba.shape[:2], bool)
    return ok


def _mask_of(rgba, mask):
    """A selection mask, or None meaning all ones.

    §3 asks for the no-selection case to BE a mask of ones so the two paths
    cannot drift. This is that, with the ones short-circuited in the one place
    the blend lives: at 4096x4096 a mask is 64MB and the blend is a full
    multiply-add per tool, and there is only one code path here to drift from.
    A mask of the wrong shape is refused LOUDLY and the tool then does nothing.
    The tempting fallback - carry on with no mask - would take an edit somebody
    asked for inside a selection and apply it to the whole frame, which is the
    worst of the three possible answers and the only one nobody would notice.
    """
    if mask is None:
        return None, True
    if not isinstance(mask, np.ndarray) or mask.shape != rgba.shape[:2]:
        print(f"[imgphoto] mask shape {getattr(mask, 'shape', type(mask))} does not "
              f"match image {rgba.shape[:2]} - refusing to edit", file=sys.stderr)
        return None, False
    m = np.nan_to_num(mask.astype(np.float32), nan=0.0, posinf=1.0, neginf=0.0)
    return np.clip(m, 0.0, 1.0), True


def _mix(original, result, m):
    """§3's whole rule: result * m + original * (1 - m).

    Alpha is COPIED rather than blended. Every tool here declares
    touchesAlpha false and is tested bit-exact on it, and a*(1-m) + a*m is not
    bit-identical to a in float32.

    Written in place, on `result`: at 4096x4096 the naive expression allocates
    four 200MB temporaries and the whole tool becomes a memory-bandwidth
    problem. `result` is always the tool's own fresh array by the time this is
    reached - `apply` has already returned for the declared-no-op case where it
    would be the input.
    """
    if m is None:
        return result
    # All four channels, then alpha is put back byte for byte. Blending the
    # slice instead looks tidier and is three times slower: `result[..., :3]` is
    # a strided view and numpy leaves the fast path the moment it sees one.
    w = m[..., None]
    result -= original
    result *= w
    result += original
    result[..., 3] = original[..., 3]
    return result


# ---------------------------------------------------------------------------
# Tone
# ---------------------------------------------------------------------------

_DEHAZE_OMEGA = 0.95        # He et al.'s: keeping 5% of the haze is what keeps
                            # distance readable instead of flattening the shot
_DEHAZE_WORK = 1024         # transmission is a depth map, and depth is smooth;
                            # estimating it above this is spending 4K pixels on
                            # a signal that has no 4K detail in it
_HAZE_ADD_GAIN = 6.0        # see _dehaze


def _dark_channel(lin, patch):
    per_px = lin.min(axis=2)
    r = max(1, int(round(patch)))
    return cv2.erode(per_px, cv2.getStructuringElement(cv2.MORPH_RECT, (r * 2 + 1, r * 2 + 1)))


def _atmosphere(lin, dark, ok):
    """The airlight A: the colour the scene fades TO at infinite distance.

    Taken as the mean over the brightest 0.1% of the DARK channel - not the
    brightest pixels of the image, which is a specular highlight on a car and
    poisons every transmission downstream. Clamped off the floor because a night
    shot has no airlight and dividing by one is how a dehaze produces neon.
    """
    d = dark[ok]
    if d.size == 0:
        return np.array([0.5, 0.5, 0.5], np.float32)
    thr = float(np.percentile(d, 99.9)) if d.size > 1000 else float(d.max())
    sel = ok & (dark >= thr)
    if not sel.any():
        sel = ok
    a = np.array([float(lin[..., c][sel].mean()) for c in range(3)], np.float32)
    return np.clip(a, 0.05, 1.0)


@tool("dehaze", "Dehaze", "Tone",
      "Atmospheric scattering, inverted. Estimates how much of each pixel is "
      "airlight instead of scene (dark-channel prior, guided-filter refined) "
      "and takes it back out. Negative puts haze IN, furthest away first, "
      "because the same transmission estimate runs backwards. This is not a "
      "contrast slider with a marketing name - on a clear photograph it barely "
      "moves, which a contrast slider never does.",
      {"amount": num(50, -100, 100, "positive lifts the scattering out; negative "
                                    "puts it back in, distance first", unit="%"),
       "radius": num(2.5, 0.5, 15, "dark-channel patch, percent of the shorter side", unit="%"),
       "minTransmission": num(10, 2, 60, "floor under the transmission estimate - the "
                                         "sky is where a dark-channel dehaze goes black "
                                         "without one", unit="%"),
       "refine": flag(True, "guided-filter the transmission against the picture, so the "
                            "recovery stops at the edge of the building instead of "
                            "haloing round it")})
def _dehaze(rgba, p, m):
    e = p["amount"] / 100.0
    if abs(e) < 1e-4:
        return rgba
    # LINEAR: I = J*t + A*(1-t) is radiance. See the module docstring.
    lin = _to_linear(_rgb(rgba))
    h, w = lin.shape[:2]
    scale = max(1.0, max(h, w) / float(_DEHAZE_WORK))
    sw, sh = max(2, int(round(w / scale))), max(2, int(round(h / scale)))
    small = cv2.resize(lin, (sw, sh), interpolation=cv2.INTER_AREA) if scale > 1.05 else lin
    ok_small = _valid(rgba, m)
    if scale > 1.05:
        ok_small = cv2.resize(ok_small.astype(np.uint8), (sw, sh),
                              interpolation=cv2.INTER_NEAREST).astype(bool)
        if not ok_small.any():
            ok_small = np.ones((sh, sw), bool)

    patch = max(1.0, _px(rgba, p["radius"]) / max(1.0, scale))
    a_light = _atmosphere(small, _dark_channel(small, patch), ok_small)
    t = 1.0 - _DEHAZE_OMEGA * _dark_channel(small / a_light[None, None, :], patch)
    t = np.clip(t, 0.02, 1.0).astype(np.float32)

    if p["refine"]:
        guide = _to_srgb(_luma(small))          # the guide is an EDGE map, and edges
        t = _guided(guide, t, max(4.0, patch * 4.0), 1e-3)   # are where the eye is
        t = np.clip(t, 0.02, 1.0).astype(np.float32)
    if scale > 1.05:
        t = cv2.resize(t, (w, h), interpolation=cv2.INTER_LINEAR)

    t = np.clip(t, p["minTransmission"] / 100.0, 1.0)
    # One formula both ways. J = A + (I - A) * t^(-e): e>0 divides the airlight
    # back out, e<0 re-renders the scene at a lower transmission, which is haze
    # added in proportion to the depth already estimated. The gain on the
    # negative side exists because a clear photograph's t is already near 1 -
    # t^1 would be a rounding error rather than a control - and it stays
    # depth-modulated because it is still a power of the same estimate.
    expo = -e if e > 0 else -e * _HAZE_ADD_GAIN
    gain = cv2.pow(t, expo)[..., None]
    a3 = a_light[None, None, :]
    lin -= a3                      # in place: `lin` is ours, and at 4K each of
    lin *= gain                    # these expressions is a 200MB allocation
    lin += a3
    return _pack(_to_srgb(np.clip(lin, 0.0, 1.0, out=lin)), _alpha(rgba))


_FILL_SUPPORT = 4.0         # a quarter of the neighbourhood being trustworthy is
                            # enough to stop asking coarser levels
_RECOVER_CEILING = 8.0      # three stops over white. Past that the "ratio" being
                            # extended came from somewhere else in the picture


def _push_pull(vals, weights, sigma):
    """Normalised convolution, then a pyramid to carry it as far as it has to go.

    `vals` is (h, w, C) ALREADY multiplied by `weights` (h, w) - the numerator
    and the denominator of a normalised convolution, kept apart until the end.

    A blur alone cannot fill a blown-out sky: the trustworthy pixels are round
    the EDGE of the hole and a 20px Gaussian reaches 20px in, so the middle of
    every large clipped region falls back to "no idea" and the tool does
    nothing - which is exactly what a highlight recovery built on one blur does,
    and it is why they all feel broken on skies. Halving until the hole is
    smaller than the image and interpolating back up costs O(n) and has an
    answer everywhere.
    """
    vs = [_blur2(np.ascontiguousarray(vals, np.float32), sigma, sigma)]
    ws = [_blur2(np.ascontiguousarray(weights, np.float32), sigma, sigma)]
    while min(vs[-1].shape[:2]) > 4:
        vs.append(cv2.pyrDown(vs[-1]))
        ws.append(cv2.pyrDown(ws[-1]))
    for i in range(len(vs) - 2, -1, -1):
        size = (vs[i].shape[1], vs[i].shape[0])
        gap = np.clip(1.0 - ws[i] * _FILL_SUPPORT, 0.0, 1.0)
        vs[i] = vs[i] + cv2.pyrUp(vs[i + 1], dstsize=size) * gap[..., None]
        ws[i] = ws[i] + cv2.pyrUp(ws[i + 1], dstsize=size) * gap
    return vs[0] / np.maximum(ws[0], 1e-6)[..., None]


def _smooth_field(vals, weights, sigma, cap=1024):
    """A push-pull run at a sane resolution and scaled back up.

    The field this estimates is the local HUE of the picture, and a local hue
    has no 4K detail in it - the same argument the transmission map gets. AREA
    downsampling a weighted numerator and its weights IS a normalised
    convolution, so nothing is approximated by moving the work down here except
    the finest scale, which was going to be blurred away by `sigma` anyway.
    """
    h, w = weights.shape[:2]
    scale = max(1.0, max(h, w) / float(cap))
    if scale <= 1.05:
        return _push_pull(vals, weights, sigma)
    sw, sh = max(4, int(round(w / scale))), max(4, int(round(h / scale)))
    v = cv2.resize(vals, (sw, sh), interpolation=cv2.INTER_AREA)
    k = cv2.resize(weights, (sw, sh), interpolation=cv2.INTER_AREA)
    small = _push_pull(v, k, max(0.5, sigma / scale))
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


@tool("highlightRecovery", "Highlight Recovery", "Tone",
      "Rebuild the channels that clipped from the ones that did not. A red "
      "sunset that blew only the red channel is recorded as white and renders "
      "as white; the true ratio is still sitting in green and blue, and taking "
      "the local ratio from unclipped neighbours puts the colour back. WHERE "
      "ALL THREE CHANNELS ARE CLIPPED THERE IS NOTHING TO RECOVER - no ratio "
      "survived - and those pixels come back bit-identical rather than "
      "smeared. Recovered pixels get darker: that is the trade, colour for "
      "brightness, and it is what recovery has always been.",
      {"amount": num(100, 0, 100, "how far toward the reconstruction to go", unit="%"),
       "threshold": num(96, 50, 100, "a channel at or above this counts as clipped", unit="%"),
       "radius": num(1.5, 0.2, 10, "how far to look for unclipped neighbours to take "
                                   "the ratio from, percent of the shorter side", unit="%")})
def _highlight_recovery(rgba, p, m):
    w = p["amount"] / 100.0
    if w < 5e-4:
        return rgba
    srgb = _rgb(rgba)
    thr = p["threshold"] / 100.0
    clipped = srgb >= thr
    n_clipped = clipped.sum(axis=2)
    recoverable = (n_clipped >= 1) & (n_clipped <= 2)
    if not recoverable.any():
        return rgba

    # LINEAR: what is being propagated is a RATIO between channels, and a ratio
    # only survives in linear light. Done on sRGB code values the same maths
    # invents a hue that was never in the scene.
    lin = _to_linear(srgb)
    keep = (~clipped).astype(np.float32)
    # Trustworthy = nothing clipped there, so the scene's own channel ratio is
    # still on the sensor. Everything else is being reconstructed FROM these.
    trust = ((n_clipped == 0) & (_alpha(rgba) > 0.5)).astype(np.float32)
    sigma = max(0.5, _px(rgba, p["radius"]))
    local = np.maximum(_smooth_field(lin * trust[..., None], trust, sigma), 1e-5)

    # From here on only the pixels that can be recovered are carried, gathered
    # flat. Nothing else in the frame is going to be written, and a clipped
    # region is usually a few percent of a photograph - doing the arithmetic on
    # all sixteen million to write two hundred thousand is most of what a 4K
    # recovery costs.
    sel = recoverable & (_alpha(rgba) > 0.0)
    if not sel.any():
        return rgba
    here, lin, clipped = srgb[sel], lin[sel], clipped[sel]
    local, keep = local[sel], keep[sel]

    # How much brighter this pixel is than the local trusted colour, judged ONLY
    # on the channels that survived. Both sides of that division carry the same
    # local brightness, so it cancels and what is left is the exposure of this
    # pixel relative to its neighbourhood - which is the one number the clipped
    # channel is missing.
    scale = (lin / local * keep).sum(axis=1) / np.maximum(keep.sum(axis=1), 1.0)
    scale = np.clip(scale, 0.02, 64.0)[:, None]
    est = np.clip(local * scale, 0.0, _RECOVER_CEILING)
    # A clipped channel's true value cannot be BELOW where it clipped, and at the
    # very edge of the clip the estimate lands on the clip point itself - which
    # is why this is continuous across the boundary instead of a visible step.
    rebuilt = np.where(clipped, np.maximum(est, lin), lin)

    # The reconstruction lives above 1.0. Rendering it means scaling the whole
    # pixel down - which is why a recovered highlight is darker and coloured
    # instead of bright and white.
    peak = np.maximum(rebuilt.max(axis=1), 1.0)
    out_srgb = _to_srgb(np.clip(rebuilt / peak[:, None], 0.0, 1.0))

    # Straight into `srgb` - it is `_rgb`'s copy and nobody else holds it, and
    # `here` was gathered out before this, so the source is not being read back.
    # Every pixel not in `sel` therefore comes through bit-identical, which is
    # the promise the all-three-clipped half of this tool is making.
    srgb[sel] = here + (out_srgb - here) * w
    return _pack(srgb, _alpha(rgba))


# ---------------------------------------------------------------------------
# Detail
# ---------------------------------------------------------------------------

def _apply_luma_delta(rgb, alpha, delta):
    """Push a luminance change back into RGB additively.

    Additive, not a ratio: `rgb * (new/old)` explodes on a near-black pixel and
    is how a clarity slider produces coloured confetti in the shadows. Adding
    the same number to all three preserves every channel DIFFERENCE, which is
    what "do not shift the hue" actually means.

    Takes the rgb the caller already extracted rather than pulling its own out
    of the rgba: `_rgb` is a 200MB copy at 4K and doing it twice per tool is
    half the cost of clarity.
    """
    rgb += delta[..., None]
    return _pack(rgb, alpha)


@tool("clarity", "Clarity", "Detail",
      "Midtone local contrast: a large-radius unsharp mask on luminance, with "
      "the shadows and highlights held back so it deepens the picture instead "
      "of crushing both ends of it. That protection is the entire difference "
      "between clarity and turning up contrast. Negative is the old soft-focus "
      "glow, and is a real tool on a portrait.",
      {"amount": num(30, -100, 100, "positive is local contrast, negative is glow", unit="%"),
       "radius": num(3.0, 0.2, 20, "neighbourhood, percent of the shorter side - "
                                   "resolution-independent, so a 4K master and its 1K "
                                   "export get the same look", unit="%"),
       "protect": num(70, 0, 100, "how hard the two ends are held back; at 0 this is a "
                                  "plain unsharp mask and it crushes them", unit="%")})
def _clarity(rgba, p, m):
    k = p["amount"] / 100.0
    if abs(k) < 1e-4:
        return rgba
    # GAMMA space - a perceptual midtone move needs a perceptual scale under it.
    rgb = _rgb(rgba)
    lum = _luma(rgb)
    sigma = max(0.5, _px(rgba, p["radius"]))
    base = _blur2(np.ascontiguousarray(lum), sigma, sigma)
    detail = lum - base
    # The tonal zone is decided by the BLURRED value, so protection follows a
    # region rather than a pixel: a bright speck inside a shadow stays part of
    # the shadow instead of being treated as a highlight of its own.
    bell = np.clip(4.0 * base * (1.0 - base), 0.0, 1.0)
    guard = 1.0 - (p["protect"] / 100.0) * (1.0 - bell)
    detail *= guard
    detail *= np.float32(k * 1.2)
    return _apply_luma_delta(rgb, _alpha(rgba), detail)


@tool("texture", "Texture", "Detail",
      "The same idea as clarity one octave down, and NOT a sharpener. Sharpening "
      "boosts the finest band there is, which is where the sensor noise lives; "
      "this is a BAND-PASS between two small radii, so the octave above it - "
      "grain, sensor noise, JPEG mosquitoes - is deliberately left out. That is "
      "the difference, and it is measurable: the two put their energy at "
      "different spatial frequencies. No tonal protection either, because "
      "texture is wanted in the shadows as much as the midtones. Negative "
      "smooths skin without touching the edges of the face.",
      {"amount": num(30, -100, 100, "positive raises fine detail, negative smooths it", unit="%"),
       "radius": num(0.35, 0.05, 3, "centre of the band, percent of the shorter side", unit="%"),
       "threshold": num(3, 0, 50, "detail smaller than this is left alone - the noise "
                                  "floor", unit="%")})
def _texture(rgba, p, m):
    k = p["amount"] / 100.0
    if abs(k) < 1e-4:
        return rgba
    # GAMMA space - the noise floor being thresholded against is display-referred.
    rgb = _rgb(rgba)
    lum = np.ascontiguousarray(_luma(rgb))
    # Floored at a pixel: a percentage radius on a 128px thumbnail lands under
    # half a pixel, and a band between two sub-pixel blurs is a silent no-op
    # rather than a subtle one.
    hi = max(1.0, _px(rgba, p["radius"]))
    lo = max(0.4, hi * 0.35)
    # A band, not a residual. On a small image `lo` falls under the blur's own
    # floor and this degrades to a plain high-pass, which is the correct thing
    # for it to degrade to - there is no octave left to exclude.
    band = _blur2(lum, lo, lo) - _blur2(lum, hi, hi)
    thr = p["threshold"] / 100.0
    if thr > 5e-4:
        band *= _smoothstep(thr, thr * 2.0 + 0.004, np.abs(band))
    band *= np.float32(k * 1.5)
    return _apply_luma_delta(rgb, _alpha(rgba), band)


# ---------------------------------------------------------------------------
# Color
# ---------------------------------------------------------------------------

def _sample_patch(rgba, x, y, radius):
    """Mean linear colour around a pick, and whether the pick was in bounds.

    Averaged in LINEAR light: the mean of gamma-encoded neighbours is not the
    colour of the patch, it is a number that happens to be near it, and on a
    noisy grey card the bias is enough to move the result.
    """
    h, w = rgba.shape[:2]
    cx = int(min(max(0, int(x)), w - 1))
    cy = int(min(max(0, int(y)), h - 1))
    clamped = (cx != int(x)) or (cy != int(y))
    r = max(0, int(radius))
    x0, x1 = max(0, cx - r), min(w, cx + r + 1)
    y0, y1 = max(0, cy - r), min(h, cy + r + 1)
    patch = rgba[y0:y1, x0:x1]
    a = patch[..., 3]
    lin = _to_linear(patch[..., :3])
    if a.sum() > 1e-4:
        col = (lin * a[..., None]).reshape(-1, 3).sum(axis=0) / float(a.sum())
    else:
        col = lin.reshape(-1, 3).mean(axis=0)
    return col.astype(np.float64), clamped, (cx, cy)


def _wb_matrix(picked_lin):
    """The linear-sRGB matrix that makes `picked_lin` neutral, or None."""
    xyz = _RGB2XYZ @ np.asarray(picked_lin, np.float64)
    if xyz[1] <= 1e-6:
        return None, None                  # a black pick carries no illuminant
    return _bradford_matrix(xyz / xyz[1]), xyz


@tool("whiteBalance", "White Balance (picked neutral)", "Color",
      "Click a pixel that should be grey and this works out the illuminant it "
      "was lit by, then adapts the whole picture from that illuminant to D65 "
      "with a Bradford transform. A real chromatic adaptation, not a per-channel "
      "scale: the cone response is what gets normalised, which is why it fixes "
      "tungsten without turning the shadows blue. The picked pixel keeps its "
      "brightness for free - that falls out of normalising both whites to Y=1, "
      "so there is no flag for it. `analyze` reports the temperature and tint it "
      "found.",
      {"x": num(0, 0, 100000, "column of the pixel that should be grey",
                integer=True, unit="px"),
       "y": num(0, 0, 100000, "row of the pixel that should be grey",
                integer=True, unit="px"),
       "sampleRadius": num(2, 0, 64, "average over this many pixels around the pick - "
                                     "one pixel is noise, not a grey card",
                           integer=True, unit="px"),
       "amount": num(100, 0, 100, "how far toward the neutral to go", unit="%")},
      returns={"temperatureK": "correlated colour temperature of the picked illuminant",
               "tint": "signed Duv - positive green, negative magenta",
               "picked": "the sampled colour, 0-255 sRGB",
               "gain": "the linear-sRGB matrix diagonal, for a sanity check",
               "clamped": "true if the pick landed outside the image and was pulled in"})
def _white_balance(rgba, p, m):
    w = p["amount"] / 100.0
    if w < 5e-4:
        return rgba
    picked, clamped, _ = _sample_patch(rgba, p["x"], p["y"], p["sampleRadius"])
    if clamped:
        print(f"[imgphoto] whiteBalance pick ({int(p['x'])}, {int(p['y'])}) is outside "
              f"the {rgba.shape[1]}x{rgba.shape[0]} image - clamped to the edge",
              file=sys.stderr)
    mat, _ = _wb_matrix(picked)
    if mat is None:
        print("[imgphoto] whiteBalance pick is black - no illuminant to read from it",
              file=sys.stderr)
        return rgba
    # A partial white balance is a partial ADAPTATION, so the matrix is what
    # gets interpolated toward identity. Blending the two images instead would
    # put the half-way point off the adaptation path.
    mat = np.eye(3) * (1.0 - w) + mat * w
    # LINEAR: chromatic adaptation is a 3x3 on tristimulus values.
    lin = _to_linear(_rgb(rgba))
    out = lin @ mat.T.astype(np.float32)
    return _pack(_to_srgb(np.clip(out, 0.0, 1.0)), _alpha(rgba))


@analyzer("whiteBalance")
def _white_balance_analyze(rgba, p, m):
    picked, clamped, at = _sample_patch(rgba, p["x"], p["y"], p["sampleRadius"])
    mat, xyz = _wb_matrix(picked)
    if mat is None:
        return {"temperatureK": 0.0, "tint": 0.0, "picked": [0, 0, 0],
                "gain": [1.0, 1.0, 1.0], "clamped": clamped, "at": list(at),
                "note": "the pick is black - no illuminant can be read from it"}
    cct, duv = _cct_and_tint(xyz / xyz[1])
    return {"temperatureK": round(cct, 1), "tint": round(duv, 5),
            "picked": [round(float(c) * 255.0, 2) for c in _to_srgb(picked.astype(np.float32))],
            "gain": [round(float(v), 5) for v in np.diag(mat)],
            "clamped": clamped, "at": list(at)}


def _hue_chroma(hue_deg):
    """A fully-saturated hue as a ZERO-LUMINANCE vector.

    Subtracting its own luma is what makes a split tone add colour and nothing
    else. Tint a shadow with a vector that carries luma and you have quietly
    also raised the exposure of the darks, which is the bug in every split tone
    that "brightens the image for some reason".
    """
    h = (float(hue_deg) % 360.0) / 60.0
    i = int(math.floor(h)) % 6
    f = h - math.floor(h)
    table = [(1.0, f, 0.0), (1.0 - f, 1.0, 0.0), (0.0, 1.0, f),
             (0.0, 1.0 - f, 1.0), (f, 0.0, 1.0), (1.0, 0.0, 1.0 - f)]
    c = np.array(table[i], np.float32)
    return c - float(c @ LUMA)


_SPLIT_GAIN = 0.35          # what "100% saturation" is worth in chroma units


@tool("splitTone", "Split Tone / Colour Grade", "Color",
      "A hue and a strength for the shadows, another pair for the highlights, "
      "and a balance that slides the crossover between them. The tint is added "
      "as pure chroma - the vector has its own luminance removed first - so a "
      "grade moves colour and never exposure. effects.py's colorBalance is the "
      "RGB-offset sibling of this; they are the same intent through different "
      "hands, and a colourist reaches for the polar one.",
      {"shadowHue": num(220, 0, 360, "hue laid into the darks", unit="deg"),
       "shadowSat": num(0, 0, 100, "how much of it", unit="%"),
       "highlightHue": num(45, 0, 360, "hue laid into the brights", unit="deg"),
       "highlightSat": num(0, 0, 100, "how much of it", unit="%"),
       "balance": num(0, -100, 100, "slides the crossover; right hands the midtones to "
                                    "the highlight tint, left to the shadow tint")})
def _split_tone(rgba, p, m):
    s_sat, h_sat = p["shadowSat"] / 100.0, p["highlightSat"] / 100.0
    if s_sat < 1e-4 and h_sat < 1e-4:
        return rgba
    # GAMMA space - the two masks are defined on the tones a person sees.
    rgb = _rgb(rgba)
    lum = np.clip(_luma(rgb), 0.0, 1.0)
    cross = float(np.clip(0.5 - 0.35 * (p["balance"] / 100.0), 0.08, 0.92))
    # Squared on top of the smoothstep: one soft crossover leaves the midtones
    # half-tinted by both ends at once, which reads as a colour cast rather
    # than a split. `rgb` is `_rgb`'s copy and is written in place.
    hi_m = _smoothstep(cross, 1.0, lum)
    lo_m = 1.0 - _smoothstep(0.0, cross, lum)
    if s_sat > 1e-4:
        rgb += (lo_m * lo_m * (s_sat * _SPLIT_GAIN))[..., None] * _hue_chroma(p["shadowHue"])
    if h_sat > 1e-4:
        rgb += (hi_m * hi_m * (h_sat * _SPLIT_GAIN))[..., None] * _hue_chroma(p["highlightHue"])
    return _pack(rgb, _alpha(rgba))


# ---------------------------------------------------------------------------
# Analysis - these return numbers, and are a no-op on pixels
# ---------------------------------------------------------------------------

@tool("autoStraighten", "Auto-Straighten", "Analysis",
      "Finds the dominant horizon or set of verticals with a probabilistic "
      "Hough and returns the ANGLE that levels them. It does NOT rotate: "
      "rotation belongs to whoever owns geometry, and an analysis that quietly "
      "resamples the picture is an analysis nobody can put a slider on. The "
      "number returned is degrees for imagetools' `rotate` op, positive "
      "clockwise, which is that op's own convention and not a guess at it.",
      {"mode": pick(["auto", "horizon", "vertical"], "auto",
                    "which family of lines to trust; auto folds both onto the same "
                    "correction, because one rotation fixes them together"),
       "maxAngle": num(12, 1, 45, "how far off level the shot is allowed to be - past "
                                  "this it is composition, not a mistake", unit="deg"),
       "minLine": num(15, 2, 60, "shortest segment that gets a vote, percent of the "
                                 "shorter side", unit="%")},
      analysis=True,
      returns={"angle": "degrees to pass to imagetools' rotate op, positive clockwise",
               "confidence": "share of the total line length that agreed, 0..1",
               "lines": "how many segments voted"})
def _auto_straighten_noop(rgba, p, m):
    return rgba                     # declared: analysis tools never touch pixels


@analyzer("autoStraighten")
def _auto_straighten(rgba, p, m):
    h, w = rgba.shape[:2]
    if h < 16 or w < 16:
        return {"angle": 0.0, "confidence": 0.0, "lines": 0,
                "note": "too small for a line to mean anything"}
    # GAMMA space: Canny's thresholds are contrast thresholds, and in linear
    # light every shadow edge falls under them.
    grey = np.clip(_luma(_rgb(rgba)), 0.0, 1.0)
    scale = max(1.0, max(h, w) / 1200.0)
    if scale > 1.05:
        grey = cv2.resize(grey, (max(8, int(w / scale)), max(8, int(h / scale))),
                          interpolation=cv2.INTER_AREA)
    gh, gw = grey.shape[:2]
    u8 = (np.clip(grey, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    med = float(np.median(u8))
    edges = cv2.Canny(u8, int(max(0, 0.66 * med)), int(min(255, 1.33 * med)))

    # The mask and the alpha gate the EDGES, not the picture: a selection round
    # the building means "level the building", and edges outside it must not vote.
    gate = (_alpha(rgba) > 0.5)
    if m is not None:
        gate = gate & (m > 0.5)
    if not gate.all():
        g8 = cv2.resize(gate.astype(np.uint8), (gw, gh), interpolation=cv2.INTER_NEAREST)
        edges = edges * g8

    min_len = max(8, int(min(gh, gw) * p["minLine"] / 100.0))
    segs = cv2.HoughLinesP(edges, 1, np.pi / 720.0, threshold=max(20, min_len // 2),
                           minLineLength=min_len, maxLineGap=max(2, min_len // 8))
    if segs is None or len(segs) == 0:
        return {"angle": 0.0, "confidence": 0.0, "lines": 0,
                "note": "no line long enough to vote"}

    lim = float(p["maxAngle"])
    devs, weights = [], []
    # cv2 4.x hands back (N, 1, 4) and 5.x hands back (N, 4). Reshaping is the
    # only version check that cannot go stale.
    for x1, y1, x2, y2 in np.asarray(segs, np.float64).reshape(-1, 4):
        dx, dy = float(x2 - x1), float(y2 - y1)
        length = math.hypot(dx, dy)
        if length < 1.0:
            continue
        a = math.degrees(math.atan2(dy, dx))
        a = (a + 90.0) % 180.0 - 90.0            # fold to (-90, 90]
        near_h = abs(a) <= lim
        near_v = abs(abs(a) - 90.0) <= lim
        if p["mode"] == "horizon" and not near_h:
            continue
        if p["mode"] == "vertical" and not near_v:
            continue
        if p["mode"] == "auto":
            if not (near_h or near_v):
                continue
            dev = ((a + 45.0) % 90.0) - 45.0     # one correction levels both families
        else:
            dev = a if near_h else (a - 90.0 if a > 0 else a + 90.0)
        if abs(dev) > lim:
            continue
        devs.append(dev)
        weights.append(length)
    if not devs:
        return {"angle": 0.0, "confidence": 0.0, "lines": 0,
                "note": "every line found was further off level than maxAngle"}

    devs = np.asarray(devs, np.float64)
    weights = np.asarray(weights, np.float64)
    # A length-weighted histogram, then a weighted mean of what fell in the peak.
    # The mean alone is wrong on any picture with two competing families - the
    # roof and the fence - and lands neatly between them, level with neither.
    bins = np.arange(-lim, lim + 0.1001, 0.1)
    hist, _ = np.histogram(devs, bins=bins, weights=weights)
    hist = np.convolve(hist, np.array([0.25, 0.5, 1.0, 0.5, 0.25]), mode="same")
    peak = 0.5 * (bins[int(np.argmax(hist))] + bins[int(np.argmax(hist)) + 1])
    near = np.abs(devs - peak) <= 0.75
    if not near.any():
        near = np.abs(devs - peak) <= lim
    dev = float((devs[near] * weights[near]).sum() / weights[near].sum())
    conf = float(weights[near].sum() / weights.sum())
    # Positive `rotate` turns the picture clockwise (imagetools does
    # `im.rotate(-rot)`), and a horizon that falls to the right needs the right
    # side lifted, so the correction is the negation of the tilt measured.
    return {"angle": round(-dev, 3), "confidence": round(conf, 3),
            "lines": int(len(devs))}


@tool("autoTone", "Auto-Tone", "Analysis",
      "One honest 'make this look right'. It does not touch a pixel: it "
      "measures the picture and returns VALUES for controls that already exist "
      "- imagetools' levels, gamma, contrast, shadows, highlights, temperature, "
      "saturation, plus dehaze and clarity from this module - so a person sees "
      "every decision on a slider and can argue with it. Deliberately does NOT "
      "propose imagetools' autoLevels: stretching each channel to its own "
      "percentiles is a blunt white balance that turns a legitimately red sunset "
      "grey. Keys it has nothing to say about are absent, so an already-good "
      "photograph comes back with an empty proposal rather than a shrug.",
      {"strength": num(100, 0, 100, "scales every value it proposes", unit="%"),
       "clipLow": num(0.4, 0, 5, "percent of pixels allowed to go to black", unit="%"),
       "clipHigh": num(0.2, 0, 5, "percent of pixels allowed to blow out", unit="%"),
       "targetMidtone": num(45, 20, 70, "where the median tone should land", unit="%"),
       "neutralize": flag(True, "estimate the illuminant and propose a temperature "
                                "with it")},
      analysis=True,
      returns={"adjust": "op values for imagetools.apply_edit, in its own units",
               "photo": "op values for this module's tools",
               "notes": "one line per decision, in plain words",
               "stats": "what it measured, so the decisions can be checked"})
def _auto_tone_noop(rgba, p, m):
    return rgba                     # declared: analysis tools never touch pixels


@analyzer("autoTone")
def _auto_tone(rgba, p, m):
    k = p["strength"] / 100.0
    rgb = _rgb(rgba)
    ok = _valid(rgba, m)
    lum0 = _thin(np.clip(_luma(rgb), 0.0, 1.0)[ok])
    adjust, photo, notes = {}, {}, []
    lo = float(np.percentile(lum0, p["clipLow"])) if lum0.size else 0.0
    hi = float(np.percentile(lum0, 100.0 - p["clipHigh"])) if lum0.size else 1.0
    stats = {"black": round(lo, 4), "white": round(hi, 4)}

    # 1. Black and white point. On the MASTER channel only, for the reason in
    #    the `why`: per-channel is a white balance wearing a levels costume.
    work = rgb
    if k > 1e-3 and (lo > 0.02 or hi < 0.98) and hi - lo > 0.05:
        black = round(lo * 255.0 * k, 1)
        white = round(255.0 - (1.0 - hi) * 255.0 * k, 1)
        if black > 0.5 or white < 254.5:
            adjust["levels"] = {"master": {"black": black, "white": white, "gamma": 1.0}}
            notes.append(f"black point {black:.0f}/255, white point {white:.0f}/255 - "
                         f"the picture only used {lo:.3f}..{hi:.3f}")
            # EVERY decision below is taken on the RESTRETCHED picture. Measure
            # the midtone on the original and the gamma proposal fights the
            # levels move it was handed in the same breath, which is how an
            # auto-tone ends up over-brightening exactly the flat scans it was
            # built for.
            work = np.clip((rgb - black / 255.0) / max(1e-4, (white - black) / 255.0), 0.0, 1.0)

    lum = _thin(np.clip(_luma(work), 0.0, 1.0)[ok])
    px = _thin(work[ok])
    med = float(np.median(lum)) if lum.size else 0.5
    p25 = float(np.percentile(lum, 25)) if lum.size else 0.25
    p75 = float(np.percentile(lum, 75)) if lum.size else 0.75
    stats.update({"median": round(med, 4), "iqr": round(p75 - p25, 4)})

    # 2. Midtone placement, as GAMMA. imagetools does rgb ** (1/gamma), so the
    #    value that puts `med` on `target` is log(med)/log(target) - the
    #    reciprocal of the exponent, and getting that backwards darkens every
    #    photograph it touches. imagetools runs contrast BEFORE gamma, and
    #    PIL's contrast enhancer pivots on the mean, so it barely moves the
    #    median - which is the only reason these two can be chosen separately.
    target = p["targetMidtone"] / 100.0
    # A five-point deadband, not a one-point one. Two percent of median luma is
    # not a difference anybody can see, and proposing it every time means
    # auto-tone never converges - apply its own answer, run it again, and it
    # hunts back and forth across the target forever.
    if 0.02 < med < 0.98 and abs(med - target) > 0.05:
        g = math.log(max(1e-4, med)) / math.log(max(1e-4, target))
        g = 1.0 + (g - 1.0) * k
        g = float(min(3.0, max(0.2, g)))         # imagetools' own clamp
        if abs(g - 1.0) > 0.01:
            adjust["gamma"] = round(g, 4)
            notes.append(f"gamma {g:.2f} - the median tone sat at {med:.2f}, "
                         f"aiming for {target:.2f}")

    # 3. Contrast, from how wide the middle half of the histogram is.
    # A properly exposed frame's luminance IQR sits around 0.25; under about
    # 0.22 it really is flat. Set higher, this fires on almost every photograph
    # and auto-tone becomes "add contrast" with extra steps.
    iqr = p75 - p25
    if iqr < 0.22 and k > 1e-3:
        c = 100.0 + min(40.0, (0.28 - iqr) * 220.0) * k
        adjust["contrast"] = round(c, 1)
        notes.append(f"contrast {c:.0f} - the middle half of the tones spanned only {iqr:.2f}")

    # 4. Crushed shadows / blown highlights get the local recovery, not a curve.
    crushed = float((lum < 0.03).mean()) if lum.size else 0.0
    blown = float((lum > 0.97).mean()) if lum.size else 0.0
    if crushed > 0.02:
        v = round(min(60.0, crushed * 400.0) * k, 1)
        if v > 1.0:
            adjust["shadows"] = v
            notes.append(f"shadows +{v:.0f} - {crushed * 100:.1f}% of the frame is at black")
    if blown > 0.01:
        # POSITIVE pulls highlights DOWN here. That is imagetools' sign, the
        # opposite of the Lightroom slider, and it is silent when it is wrong.
        v = round(min(60.0, blown * 500.0) * k, 1)
        if v > 1.0:
            adjust["highlights"] = v
            notes.append(f"highlights +{v:.0f} - {blown * 100:.1f}% of the frame is blown "
                         f"(positive pulls DOWN in imagetools' units)")

    # 5. Illuminant. Shades-of-grey (Minkowski p=6) over the unclipped pixels,
    #    which beats plain grey-world on anything with a large flat colour in it.
    if p["neutralize"] and px.size:
        unclipped = px[(px.max(axis=1) < 0.99) & (px.max(axis=1) > 0.02)]
        if unclipped.shape[0] > 32:
            est = np.power(np.power(unclipped.astype(np.float64), 6).mean(axis=0), 1.0 / 6)
            est = est / max(1e-6, float(est.mean()))
            stats["illuminant"] = [round(float(v), 4) for v in est]
            # imagetools' temperature is r*(1+q), b*(1-q) with q = t/100*0.12.
            # Solve for the t that equalises the red and blue estimates: it is
            # that op's own arithmetic, read out of its source rather than
            # remembered.
            r, b = float(est[0]), float(est[2])
            if r > 1e-6 and b > 1e-6:
                q = (b - r) / (b + r)
                t = float(np.clip(q / 0.12 * 100.0, -100.0, 100.0)) * k
                # Under about five points the "cast" is the sampling noise of
                # the estimate itself, and proposing it makes auto-tone look
                # like it always finds something wrong.
                if abs(t) > 5.0:
                    adjust["temperature"] = round(t, 1)
                    notes.append(f"temperature {t:+.0f} - the illuminant read "
                                 f"{est[0]:.2f}/{est[1]:.2f}/{est[2]:.2f} R/G/B")
                    if abs(t) >= 99.9:
                        # imagetools' slider is a +-12% red/blue swing end to
                        # end. Past that it cannot express the cast, and saying
                        # nothing here is how a half-corrected picture gets
                        # blamed on the estimate rather than on the control.
                        notes.append("...and that is the whole slider - the cast "
                                     "is stronger than imagetools' temperature op "
                                     "can express; pick a neutral and use "
                                     "whiteBalance for the rest")

    # 6. Chroma. Only a nudge, and only when the frame really is flat.
    if px.size:
        chroma = float((px.max(axis=1) - px.min(axis=1)).mean())
        stats["chroma"] = round(chroma, 4)
        if chroma < 0.10:
            s = 100.0 + min(35.0, (0.10 - chroma) * 300.0) * k
            if s > 102.0:
                adjust["saturation"] = round(s, 1)
                notes.append(f"saturation {s:.0f} - mean chroma was {chroma:.3f}")

    # 7 and 8 are both measured on a downscaled copy. Every radius in this
    #    module is a percent of the shorter side, so shrinking the picture and
    #    the radius together measures the same quantity - and a 200px erode plus
    #    a 16-million-element percentile is otherwise seconds of work to decide
    #    one slider.
    h0, w0 = work.shape[:2]
    dscale = max(1.0, max(h0, w0) / 1024.0)
    if dscale > 1.05:
        size = (max(8, int(w0 / dscale)), max(8, int(h0 / dscale)))
        small = cv2.resize(work, size, interpolation=cv2.INTER_AREA)
        ok_s = cv2.resize(ok.astype(np.uint8), size,
                          interpolation=cv2.INTER_NEAREST).astype(bool)
        if not ok_s.any():
            ok_s = np.ones(small.shape[:2], bool)
    else:
        small, ok_s = work, ok
    short_s = float(max(1, min(small.shape[0], small.shape[1])))

    # 7. Haze reads as a floor under the dark channel: if the darkest channel of
    #    every neighbourhood is bright, light is being added everywhere.
    dark = _dark_channel(_to_linear(small), max(1.0, short_s * 0.025))
    floor = float(np.percentile(_thin(dark[ok_s]), 60)) if ok_s.any() else 0.0
    stats["darkChannel"] = round(floor, 4)
    if floor > 0.05:
        v = round(min(60.0, (floor - 0.05) * 400.0) * k, 1)
        if v > 3.0:
            photo["dehaze"] = {"amount": v}
            notes.append(f"dehaze {v:.0f} - the dark channel never got below {floor:.3f}")

    # 8. Local contrast, measured rather than assumed: a large-radius high-pass
    #    with nothing in it is a flat picture, and only then is clarity earned.
    sigma = max(0.5, short_s * 0.03)
    l_all = np.clip(_luma(small), 0.0, 1.0)
    local = float(np.std(l_all - _blur2(np.ascontiguousarray(l_all), sigma, sigma)))
    stats["localContrast"] = round(local, 5)
    if local < 0.045:
        v = round(min(40.0, (0.045 - local) * 900.0) * k, 1)
        if v > 3.0:
            photo["clarity"] = {"amount": v}
            notes.append(f"clarity {v:.0f} - local contrast measured {local:.3f}")

    if not adjust and not photo:
        notes.append("nothing to do - the tones, the cast and the local contrast "
                     "all measured fine")
    return {"adjust": adjust, "photo": photo, "notes": notes, "stats": stats}


# ---------------------------------------------------------------------------
# the entry points
# ---------------------------------------------------------------------------

def apply(name, rgba, params=None, mask=None):
    """Run one tool. See the module docstring for the contract.

    An analysis tool returns its input untouched here, on purpose and as
    declared in the catalog - a caller who asked for `autoTone` through the
    pixel door deserves an honest no-op rather than "no such tool".
    """
    fn = _REGISTRY.get(str(name))
    if fn is None:
        return rgba
    if not isinstance(rgba, np.ndarray) or rgba.ndim != 3 or rgba.shape[2] != 4:
        return rgba
    if not np.issubdtype(rgba.dtype, np.floating):
        # An integer array is 0..255, not 0..1. Same refusal effects.apply makes,
        # and for the same reason: fail at the seam where the mistake happened.
        return rgba
    arr = rgba if rgba.dtype == np.float32 else rgba.astype(np.float32)
    m, usable = _mask_of(arr, mask)
    if not usable:
        return arr
    try:
        out = fn(arr, _coerce(CATALOG[name]["params"], params), m)
    except Exception as exc:
        print(f"[imgphoto] {name} failed: {exc}", file=sys.stderr)
        return arr
    if not isinstance(out, np.ndarray) or out.shape != arr.shape:
        return arr
    if out is arr or out is rgba:
        return arr                        # a declared no-op, not a result
    out = out.astype(np.float32, copy=False)
    if np.may_share_memory(out, arr):
        # `_mix` and the clamp below both write in place. A tool that returned a
        # VIEW of its input rather than a fresh array would have the caller's
        # pixels rewritten under it - silently, and only when a mask was passed.
        out = out.copy()
    out = _mix(arr, out, m)
    # The 0..1 promise is enforced here rather than trusted from six bodies -
    # clip folds the infinities in and NaN needs its own pass, exactly as
    # effects.apply does it.
    np.clip(out, 0.0, 1.0, out=out)
    np.copyto(out, 0.0, where=np.isnan(out))
    return out


def analyze(name, rgba, params=None, mask=None):
    """Numbers instead of pixels. None for a tool that has none to give."""
    fn = _ANALYZERS.get(str(name))
    if fn is None:
        return None
    if not isinstance(rgba, np.ndarray) or rgba.ndim != 3 or rgba.shape[2] != 4:
        return None
    if not np.issubdtype(rgba.dtype, np.floating):
        return None
    arr = rgba if rgba.dtype == np.float32 else rgba.astype(np.float32)
    arr = np.nan_to_num(arr, nan=0.0, posinf=1.0, neginf=0.0)
    m, usable = _mask_of(arr, mask)
    if not usable:
        return None
    try:
        return fn(arr, _coerce(CATALOG[name]["params"], params), m)
    except Exception as exc:
        print(f"[imgphoto] {name} analysis failed: {exc}", file=sys.stderr)
        return None


def catalog():
    """What MCP and the UI are served."""
    return {"tools": CATALOG, "groups": GROUP_ORDER, "names": sorted(_REGISTRY),
            "analyzers": sorted(_ANALYZERS)}


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
