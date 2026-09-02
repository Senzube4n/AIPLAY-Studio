"""sRGB <-> linear light — the one place this engine says what its numbers mean.

Every float in this compositor is 0..1, and until now nothing said what 0.5
WAS. It is not half the light. It is the sRGB code 128, which carries about
21.6% of the light of code 255 — because a display's response is a power curve
and the encoding is its inverse, so that 8 bits are spent where the eye can see
them rather than evenly across a range it cannot.

That distinction does not matter to most of what this engine does. A curve, a
levels, a hue rotation, a posterize are all LOOK operations: their parameters
are drawn against code values and their whole meaning is "move code 128 to code
160". Running those in linear would be wrong, not righter.

It matters to the operations that are physically LIGHT — the ones that add or
average photons:

    a blur          a weighted average of the light in a neighbourhood
    a glow          the same average, then added on top
    add / screen    two sources of light arriving at one place
    a light wrap    a screen of the plate's light onto the layer's edge
    diffuse/specular shading (lights.py)

Do those on gamma-encoded numbers and the mid-tones come out dark. The classic
demonstration: a 50/50 mix of black and white is code 128 in gamma and code 188
in linear — 60 codes apart, and 188 is the one a defocused photograph of a black
and white checker actually produces. That 60-code gap is the "dirty" halo on
every glow built the wrong way round; it is why a gamma-space glow looks like
paint and a linear one looks like light.

THE CURVE IS PIECEWISE, NOT 2.2. IEC 61966-2-1 defines sRGB as a linear toe
below 0.04045 spliced onto a 2.4 power above it, and the pair together
APPROXIMATE a 2.2 power — they are not the same function. Substituting a bare
x**2.2 costs at most 0.0085 in linear, which sounds negligible and is not: near
black the linear values are tiny, so that absolute error is a large relative
one, and re-encoding it lands 8.55 CODES away in the bottom decade of the
range. The bottom decade is exactly where a glow's tail and a shadow's falloff
live, so the approximation misses in the one place these functions were added
for. The toe also keeps the derivative finite at zero, which a power curve does
not: x**(1/2.4) has infinite slope at 0 and turns a black pixel's noise into
banding.

    srgb_to_linear(a)   0..1 encoded  -> 0..1+ linear light
    linear_to_srgb(a)   linear light  -> encoded; values over 1 are LEFT over 1

Both take and return float32 of any shape, never write to the input, and are
exact inverses to within a bit at 8-bit precision (colour_test.py checks the
round trip over all 256 codes and over a million random floats).

ALPHA IS NOT PUT THROUGH EITHER OF THEM. Alpha is coverage — the fraction of a
pixel the layer occupies — and a fraction of an area has no transfer function.
This is also why the callers convert STRAIGHT colour and never premultiplied
colour: decode(C * a) applies a display curve to the product of a colour and an
area, which is neither one thing nor the other. See engine.py's `linear light`
section for the order that falls out of that.

WHAT THIS IS NOT: a colour-management system. There is one primary set here
(Rec.709, which sRGB shares) and one transfer function. No HDR, no wide gamut,
no ACES, no LUTs, no display transform, no per-source input profile. Footage is
assumed to be sRGB/Rec.709 because that is what every generator, browser canvas
and h264 file in this product actually is.

MEASURED, 1920x1080 float32, this machine (colour_test.py prints these):

    srgb_to_linear, (H, W, 3)     39 ms
    linear_to_srgb, (H, W, 3)     36 ms
    the pair                      77 ms
    decode_rgb + encode_rgb      110 ms       THE NUMBER THAT MATTERS — see below
    ...at 720p                    48 ms       decode_rgb + encode_rgb

    naive numpy `** 2.4`          96 ms       2.4x one cv2.pow chain
    a 4096-entry lerp LUT        142 ms       SLOWER, and exact to 0.0004 codes
                                              for the trouble: fancy indexing
                                              over six million floats costs
                                              more than the power it replaces

QUOTE THE 110, NOT THE 77. The (H, W, 3) pair is the arithmetic; `decode_rgb`
and `encode_rgb` are what every caller actually reaches for, and they run the
curve over all FOUR channels and write the alpha back (which is genuinely the
cheaper of the two options — see decode_rgb). That is a third more work, and an
earlier draft of this header quoted the three-channel figure against a glow and
called a converted run "70% of a glow". Measured back to back on one machine
state, a 1080p glow is 87 ms and a converted run is 110: a run costs about
1.2 GLOWS, not two thirds of one. The difference decided nothing about the
design and everything about the honesty of the setting's description, which a
person reads before choosing to pay it.

WHERE THE TIME GOES, because it is not where you would guess. cv2.pow alone is
13 ms and the offset-and-scale chain around it 18. The remaining 20 is THE
TOE — one comparison, one multiply and one masked copy over the whole frame,
which doubles the function to fix the bottom 4% of its range. That is the price
of being the standard's curve rather than a power; it is paid on every pixel,
and it buys the 8.55 codes above. There is no branch-free form to reach for:
the power branch sits above the toe at every x, so no min/max composes them.

Because a run costs more than the effect it wraps, the callers AMORTISE it —
one conversion per contiguous RUN of light-like effects, not one per effect. A
stack of blur + glow + blur pays 110 ms once, not three times. See engine.py's
`_apply_effects`.
"""
from __future__ import annotations

import cv2
import numpy as np

# IEC 61966-2-1. The four constants are the standard's, not a fit: 12.92 is the
# toe slope, 0.0031308 (linear) / 0.04045 (encoded) the splice point, and
# 1.055/0.055 the scale and offset that make the two halves meet with a
# continuous value there.
SRGB_TOE_SLOPE = np.float32(12.92)
SRGB_LIN_KNEE = np.float32(0.0031308)
SRGB_ENC_KNEE = np.float32(0.04045)
SRGB_SCALE = np.float32(1.055)
SRGB_OFFSET = np.float32(0.055)
SRGB_GAMMA = np.float32(2.4)

# What the encoded pixels ARE, for whoever has to tag a file. Named here rather
# than in engine.py so the container tag and the maths cannot drift apart.
COLOR_PRIMARIES = "bt709"
COLOR_TRC = "iec61966-2-1"     # sRGB's own transfer curve, the one above
COLOR_SPACE = "bt709"          # the RGB->YCbCr matrix, for the 4:2:0 lanes
COLOR_RANGE = "tv"             # h264 limited range, which is what av writes


def _f32(a):
    """A float32 view or copy, whichever is free. Never the caller's buffer."""
    arr = np.asarray(a)
    if arr.dtype != np.float32:
        return arr.astype(np.float32)
    return arr


def _piecewise(x, hi, knee, slope):
    """Splice the linear toe onto the power branch already computed in `hi`.

    `hi` is written through, so the caller's power result is the output buffer.
    The toe is `max(x, 0) * slope` — the clamp is on BOTH branches, not just the
    power one, or a stray -0.001 comes back as a negative "light" through the
    toe while the power branch is busy being careful about the same value.

    THE asarray IS NOT DECORATION. `np.maximum` on a 0-d input returns a numpy
    SCALAR, not a 0-d array, and a scalar cannot be an `out=` buffer — so
    without it this raised `TypeError: return arrays must be of ArrayType` on
    `0.5`, on `np.float32(0.5)` and on `np.array(0.5)` alike, while the
    docstrings above promised "any shape". It costs nothing on the frames: for
    an ndarray of rank 1 or more `np.maximum` already returns an array and
    `asarray` hands the same object straight back. (The 0-d case does not
    arrive here any more — `_scalar` below reshapes it first, for a worse
    reason than this one — but a function that cannot take the shape its own
    docstring names is a trap for the next caller.)
    """
    lo = np.asarray(np.maximum(x, np.float32(0.0)), dtype=np.float32)
    np.multiply(lo, slope, out=lo)
    np.copyto(hi, lo, where=(x <= knee))
    return hi


def _scalar(fn, x):
    """Run a 0-d input as a one-element vector and hand it back 0-d.

    NOT A CONVENIENCE. cv2.pow SILENTLY DOES NOTHING to a 0-d array — it does
    not raise, it returns the buffer untouched — so a scalar that reached the
    power branch came back offset-and-scaled with no power applied at all:
    srgb_to_linear(0.5) answered 0.5261 where the right answer is 0.2140, and
    answered it without a word. That is the worst failure shape a transfer
    function has, and it is the one a PARAMETER hits: effects.py converts
    glow's picked swatch a channel at a time, and a threshold is one number.
    A reshape is a view, so the whole fix costs one Python call.
    """
    return fn(x.reshape(1)).reshape(())


def srgb_to_linear(a):
    """Encoded sRGB -> linear light. 0.5 comes back 0.2140, not 0.5.

    Any shape, INCLUDING a scalar: a float, a np.float32 and a 0-d array all
    come back as a 0-d float32 array (which `float()` takes). See `_scalar`.
    """
    x = _f32(a)
    if x.ndim == 0:
        return _scalar(srgb_to_linear, x)
    hi = np.empty(x.shape, np.float32)
    # cv2.pow raises a fractional power on the ABSOLUTE value, so the clamp is
    # not optional: without it a -0.001 would come back +0.0000004.
    np.maximum(x, np.float32(0.0), out=hi)
    np.add(hi, SRGB_OFFSET, out=hi)
    np.multiply(hi, np.float32(1.0) / SRGB_SCALE, out=hi)
    cv2.pow(hi, float(SRGB_GAMMA), hi)
    return _piecewise(x, hi, SRGB_ENC_KNEE, np.float32(1.0) / SRGB_TOE_SLOPE)


def linear_to_srgb(a):
    """Linear light -> encoded sRGB, the exact inverse of the above.

    Values ABOVE 1 are encoded, not clipped: an additive glow that blows past
    white must clip once, at the uint8 boundary, and not twice. Clipping here
    would flatten the highlight before it had been asked to fit in 8 bits.

    Any shape, scalars included — same story as above.
    """
    x = _f32(a)
    if x.ndim == 0:
        return _scalar(linear_to_srgb, x)
    hi = np.empty(x.shape, np.float32)
    np.maximum(x, np.float32(0.0), out=hi)
    cv2.pow(hi, 1.0 / float(SRGB_GAMMA), hi)
    np.multiply(hi, SRGB_SCALE, out=hi)
    np.subtract(hi, SRGB_OFFSET, out=hi)
    return _piecewise(x, hi, SRGB_LIN_KNEE, SRGB_TOE_SLOPE)


def decode_rgb(rgba):
    """A copy of an (H, W, 4) frame with its COLOUR decoded and its alpha as it
    was. The straight-alpha contract in, the same contract out — only the
    meaning of the three colour numbers has changed.

    ALL FOUR CHANNELS go through the curve and the alpha is then written back
    over: converting a channel and discarding the answer sounds like waste and
    is the cheaper of the two options here, because `rgba[..., :3]` is the
    stride-4 slice effects.py's planar note warns about. Measured at 1080p:
    51 ms this way, 53 through cv2.mixChannels, 266 through the slice.
    """
    out = srgb_to_linear(rgba)
    out[..., 3] = rgba[..., 3]
    return out


def encode_rgb(rgba):
    """The inverse of `decode_rgb`, alpha again untouched."""
    out = linear_to_srgb(rgba)
    out[..., 3] = rgba[..., 3]
    return out
