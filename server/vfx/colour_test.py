"""Unit tests for the transfer pair in server/vfx/colour.py.

A transfer function has exactly two things to prove and one to report.

  * IT IS THE STANDARD'S. Not "close to 2.2" — the piecewise IEC 61966-2-1
    curve, checked at the four points where a wrong implementation shows: the
    knee (0.04045 <-> 0.0031308, where the two halves must meet), the ends
    (0 -> 0, 1 -> 1, which the 1.055/0.055 pair exists to make true), the toe
    slope (12.92 exactly), and the published anchor 0.5 -> 0.2140. Then the
    2.2 approximation is measured against it, so the docstring's claim about
    the bottom decade is a number in this file and not a belief.
  * IT ROUND-TRIPS. encode(decode(v)) == v to within a bit at 8 bits, over all
    256 codes and over a million random floats — because the whole feature is
    "convert, work, convert back", and a pair that loses a code per trip would
    make an ENABLED comp drift every time somebody added an effect.

The thing to report is the COST, in the same units effects.py quotes: ms on a
1080p frame, beside a glow so the trade is legible rather than abstract. The
alternatives are timed too (naive numpy, a LUT), because "cv2.pow" is a choice
and a choice with no losing option beside it is not evidence.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/colour_test.py

numpy / cv2 only. This module has no comp, no engine and no files.
"""
import math
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import colour                                              # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print("  ok    %s" % name)
    else:
        FAIL += 1
        print("  FAIL  %s\n          got %r, wanted %r" % (name, got, want))


def close(name, got, want, tol):
    eq(name + "  (%.6g vs %.6g)" % (got, want), abs(got - want) <= tol, True)


def ms(fn, n=5):
    fn()
    best = 1e9
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        best = min(best, (time.perf_counter() - t0) * 1000.0)
    return best


def ratio_of(fn_a, fn_b, n=9):
    """Is fn_a at least `factor` times fn_b? Measured PAIRWISE, and the reason is
    a real failure on this machine.

    Two calls to ms() are two separate best-of-5 windows, and best-of-5 does not
    survive a busy box: measured during an H3 render at 100% GPU, `cv2.pow`
    alone came back at 36.7 ms where it is 16.0 ms on a quiet machine - a 2.3x
    inflation that survived taking the minimum of five, because all five samples
    sat inside the same contended window. The ratio flipped, the lane failed,
    and nothing about the code under test had changed. A check that fails
    because something ELSE is using the machine is a check people learn to skip.

    So the two are timed back to back inside one loop, so each pair sees the
    same machine, and the verdict is the MEDIAN of the per-pair ratios rather
    than a ratio of two independent minima. The claim being made is about the
    shape of the code, not about this second's wall clock."""
    fn_a(); fn_b()
    ratios = []
    for _ in range(n):
        t0 = time.perf_counter(); fn_a(); a = time.perf_counter() - t0
        t0 = time.perf_counter(); fn_b(); b = time.perf_counter() - t0
        ratios.append(a / b if b > 0 else float("inf"))
    ratios.sort()
    return ratios[len(ratios) // 2]


def slower_than(fn_a, fn_b, factor, n=9):
    """fn_a costs at least `factor` times fn_b, measured pairwise. See ratio_of."""
    return ratio_of(fn_a, fn_b, n) >= factor


# ── the curve is the standard's ───────────────────────────────────────────────

print("\nthe piecewise IEC 61966-2-1 curve")

close("0 decodes to 0", float(colour.srgb_to_linear(np.float32([0.0]))[0]), 0.0, 0.0)
close("1 decodes to 1", float(colour.srgb_to_linear(np.float32([1.0]))[0]), 1.0, 1e-6)
close("0 encodes to 0", float(colour.linear_to_srgb(np.float32([0.0]))[0]), 0.0, 0.0)
close("1 encodes to 1", float(colour.linear_to_srgb(np.float32([1.0]))[0]), 1.0, 1e-6)

# The published anchor. Code 128/255 = 0.50196 is 0.2158 of the light; the round
# 0.5 is 0.2140. Either number being wrong means the exponent or the offset is.
close("0.5 carries 21.40% of the light",
      float(colour.srgb_to_linear(np.float32([0.5]))[0]), 0.21404114, 1e-6)
close("mid GREY (code 128) carries 21.58%",
      float(colour.srgb_to_linear(np.float32([128.0 / 255.0]))[0]), 0.21586052, 1e-6)

# The knee, from both sides. A splice that does not meet is the single most
# common way to get this function wrong, and it shows as a step at code 10.
knee_lo = float(colour.srgb_to_linear(np.float32([colour.SRGB_ENC_KNEE - 1e-6]))[0])
knee_hi = float(colour.srgb_to_linear(np.float32([colour.SRGB_ENC_KNEE + 1e-6]))[0])
close("the two halves meet at the knee", knee_hi - knee_lo, 0.0, 2e-7)
close("...and they meet AT 0.0031308", knee_lo, float(colour.SRGB_LIN_KNEE), 3e-7)

# The toe is a straight line of slope 12.92, which is what keeps the derivative
# finite at black. Two points on it settle both the slope and the intercept.
close("the toe has slope 12.92",
      float(colour.srgb_to_linear(np.float32([0.02]))[0]), 0.02 / 12.92, 1e-9)
close("...and passes through the origin",
      float(colour.srgb_to_linear(np.float32([0.001]))[0]), 0.001 / 12.92, 1e-9)
close("the encode toe is its inverse",
      float(colour.linear_to_srgb(np.float32([0.001]))[0]), 0.001 * 12.92, 1e-9)

# Monotone, everywhere. A transfer function that is not is a posterisation.
_v = np.linspace(0.0, 1.0, 100001, dtype=np.float32)
eq("decode is strictly increasing over 0..1",
   bool(np.all(np.diff(colour.srgb_to_linear(_v)) > 0)), True)
eq("encode is strictly increasing over 0..1",
   bool(np.all(np.diff(colour.linear_to_srgb(_v)) > 0)), True)

# Over 1 is ENCODED, not clipped — the additive-glow case.
close("linear 2.0 encodes to 1.353 rather than clipping to 1",
      float(colour.linear_to_srgb(np.float32([2.0]))[0]), 1.3531, 1e-3)
eq("negative light decodes to 0, not to a mirrored positive",
   float(colour.srgb_to_linear(np.float32([-0.25]))[0]), 0.0)


# ── a scalar is a shape ───────────────────────────────────────────────────────
#
# "Both take and return float32 of any shape" was not true of the smallest
# shape there is, and it failed in two different ways at once — which is why
# this block asserts a VALUE and not merely the absence of an exception:
#
#   _piecewise raised TypeError: return arrays must be of ArrayType. np.maximum
#   on a 0-d input returns a numpy SCALAR, and a scalar cannot be an out=
#   buffer. Loud, at least.
#   cv2.pow SILENTLY DID NOTHING to a 0-d array. Reshaped past the TypeError,
#   0.5 decoded to 0.5261 — the offset-and-scale with no power applied — and
#   said so to nobody. A test that only caught the raise would have blessed it.
#
# The shape matters because a PARAMETER is this shape. glow's picked swatch and
# its threshold go through the same curve as the pixels now (effects.py's
# LINEAR_PARAMS), and they arrive one number at a time.

print("\na scalar is a shape")

_scalars = {"a python float": 0.5,
            "a np.float32": np.float32(0.5),
            "a 0-d float32 array": np.array(0.5, np.float32),
            "a 0-d float64 array": np.array(0.5)}
for _what, _v in _scalars.items():
    close("decode takes %s" % _what, float(colour.srgb_to_linear(_v)), 0.2140, 1e-4)
    close("...and encode does too  (%s)" % _what,
          float(colour.linear_to_srgb(_v)), 0.7354, 1e-4)
eq("a scalar comes back 0-d float32, not a bare python number",
   [colour.srgb_to_linear(0.5).shape, colour.srgb_to_linear(0.5).dtype],
   [(), np.dtype(np.float32)])
eq("the scalar path is the SAME curve as the array path, code for code",
   [float(colour.srgb_to_linear(float(c))) for c in (0.0, 0.02, 0.04045, 0.5, 1.0)],
   [float(x) for x in colour.srgb_to_linear(
       np.float32([0.0, 0.02, 0.04045, 0.5, 1.0]))])
close("a scalar round-trips both ways", float(colour.linear_to_srgb(
    colour.srgb_to_linear(np.float32(0.31)))), 0.31, 1e-6)
# The two numbers glow's parameters turn on, quoted where they are computed.
print("        an unconverted swatch: sRGB 128 read as light re-encodes to %.1f"
      % (float(colour.linear_to_srgb(np.float32(128 / 255.0))) * 255.0))
print("        an unconverted threshold: 60%% read as light cuts at code %.1f"
      % (float(colour.linear_to_srgb(np.float32(0.6))) * 255.0))


# ── it round-trips ────────────────────────────────────────────────────────────

print("\nthe round trip")

codes = (np.arange(256, dtype=np.float32) / 255.0)
back = colour.linear_to_srgb(colour.srgb_to_linear(codes))
u8_in = np.arange(256, dtype=np.uint8)
u8_out = np.clip(back * 255.0 + 0.5, 0, 255).astype(np.uint8)
eq("all 256 8-bit codes survive a round trip EXACTLY",
   int(np.abs(u8_out.astype(int) - u8_in.astype(int)).max()), 0)
close("...and in float the worst code is under a thousandth of an LSB",
      float(np.abs(back - codes).max()) * 255.0, 0.0, 1e-3)

rng = np.random.default_rng(7)
big = rng.random(1_000_000, dtype=np.float32)
rt = colour.linear_to_srgb(colour.srgb_to_linear(big))
close("a million random floats round-trip inside 1/255 of a code",
      float(np.abs(rt - big).max()) * 255.0, 0.0, 1.0 / 255.0)

lin = rng.random(1_000_000, dtype=np.float32)
rt2 = colour.srgb_to_linear(colour.linear_to_srgb(lin))
close("...and so does the other direction",
      float(np.abs(rt2 - lin).max()), 0.0, 1e-6)

# The input is never written to. Every caller hands its own working buffer in.
src = np.full((4, 4, 4), 0.5, np.float32)
keep = src.copy()
colour.decode_rgb(src)
colour.encode_rgb(src)
colour.srgb_to_linear(src)
colour.linear_to_srgb(src)
eq("neither function writes to its input", bool(np.array_equal(src, keep)), True)

# decode_rgb / encode_rgb: colour moves, alpha does not, bit for bit.
frame = rng.random((32, 32, 4), dtype=np.float32)
dec = colour.decode_rgb(frame)
eq("decode_rgb leaves alpha bit-identical",
   bool(np.array_equal(dec[..., 3], frame[..., 3])), True)
eq("decode_rgb moves every colour channel",
   bool(np.all(dec[..., :3] < frame[..., :3])), True)
enc = colour.encode_rgb(dec)
close("decode_rgb then encode_rgb is the frame back",
      float(np.abs(enc - frame).max()) * 255.0, 0.0, 1.0 / 255.0)


# ── the 2.2 approximation, measured rather than dismissed ─────────────────────

print("\nwhy piecewise and not a bare 2.2 power")

v = np.linspace(0.0, 1.0, 4096, dtype=np.float32)
true_lin = colour.srgb_to_linear(v)
approx_lin = np.power(v, 2.2, dtype=np.float32)
err_lin = float(np.abs(true_lin - approx_lin).max())
# Re-encode the approximation's answer with the RIGHT curve: that is what a
# downstream pixel actually shows, and it is where an "invisible" 0.008 goes.
err_codes = np.abs(colour.linear_to_srgb(approx_lin) - v) * 255.0
bottom = v <= 0.1                                     # the bottom decade
print("        max error in linear                 %.4f" % err_lin)
print("        ...as codes, whole range            %.2f" % float(err_codes.max()))
print("        ...as codes, bottom decade (v<=0.1) %.2f" % float(err_codes[bottom].max()))
eq("2.2 looks harmless in linear (under 0.01)", err_lin < 0.01, True)
eq("...and is worth several codes once re-encoded", float(err_codes.max()) > 4.0, True)
eq("...worst exactly where a glow's tail lives",
   float(err_codes[bottom].max()) > float(err_codes[v > 0.5].max()), True)


# ── what it costs ─────────────────────────────────────────────────────────────

print("\ncost, best of five, float32")

for label, shape in (("720p  rgb ", (720, 1280, 3)),
                     ("1080p rgb ", (1080, 1920, 3)),
                     ("1080p rgba", (1080, 1920, 4))):
    a = rng.random(shape, dtype=np.float32)
    d = ms(lambda a=a: colour.srgb_to_linear(a))
    e = ms(lambda a=a: colour.linear_to_srgb(a))
    print("        %s   decode %6.1f ms   encode %6.1f ms   pair %6.1f ms"
          % (label, d, e, d + e))

f = rng.random((1080, 1920, 4), dtype=np.float32)
pair_frame = ms(lambda: colour.encode_rgb(colour.decode_rgb(f)))
print("        1080p decode_rgb + encode_rgb on a whole frame   %6.1f ms" % pair_frame)

a3 = rng.random((1080, 1920, 3), dtype=np.float32)
naive = ms(lambda: np.where(a3 <= 0.04045, a3 / 12.92,
                            ((a3 + 0.055) / 1.055) ** 2.4).astype(np.float32))
print("        1080p naive numpy `** 2.4`                       %6.1f ms  (%.1fx)"
      % (naive, naive / max(ms(lambda: colour.srgb_to_linear(a3)), 1e-9)))

# A LUT is the obvious cheaper answer, so price it AND price its error.
LUT_N = 4096
_x = np.linspace(0.0, 1.0, LUT_N, dtype=np.float32)
_lut = colour.srgb_to_linear(_x)


def _lut_decode(a):
    idx = np.clip(a, 0.0, 1.0) * (LUT_N - 1)
    i0 = idx.astype(np.int32)
    fr = idx - i0
    i1 = np.minimum(i0 + 1, LUT_N - 1)
    return _lut[i0] * (1.0 - fr) + _lut[i1] * fr


lut_ms = ms(lambda: _lut_decode(a3))
lut_err = float(np.abs(colour.linear_to_srgb(_lut_decode(v)) - v).max()) * 255.0
print("        1080p a %d-entry lerp LUT                        %6.1f ms  (off by %.3f codes)"
      % (LUT_N, lut_ms, lut_err))
eq("the LUT loses to cv2.pow outright, which is why it is not used",
   slower_than(lambda: _lut_decode(a3), lambda: colour.srgb_to_linear(a3), 1.0), True)

# Where the time actually goes: the toe, not the power. Worth pinning, because
# somebody optimising this will reach for the exponent first and find nothing.
pow_only = ms(lambda: cv2.pow(a3, 2.4))
print("        1080p cv2.pow alone, no toe                      %6.1f ms" % pow_only)
eq("the toe costs about as much as the power it is spliced onto",
   slower_than(lambda: colour.srgb_to_linear(a3), lambda: cv2.pow(a3, 2.4), 1.5), True)

# The guard, not the spec: the numbers above are the report.
#
# THE REAL CLAIM, AND IT DOES NOT DEPEND ON WHAT ELSE THE MACHINE IS DOING. This
# path exists because cv2.pow beats the obvious numpy expression; if a rewrite
# loses that, everything above is decoration. Measured pairwise so both halves
# see the same machine, and it holds steady under load - taken during an H3
# render at 100% GPU the shipped round trip was 0.446x the naive one, spread
# 0.399 to 0.500. The line at 0.7 is comfortably clear of that and still fails
# the moment somebody drops back to `** 2.4`.
def _naive_pair():
    x = f[..., :3]
    lin = np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)
    np.where(lin <= 0.0031308, lin * 12.92, 1.055 * (lin ** (1 / 2.4)) - 0.055)


shipped_vs_naive = ratio_of(lambda: colour.encode_rgb(colour.decode_rgb(f)), _naive_pair)
print("        the shipped round trip costs %.3fx the naive numpy one" % shipped_vs_naive)
eq("the shipped round trip really is faster than the obvious numpy one",
   shipped_vs_naive < 0.7, True)

# AND A CEILING, DELIBERATELY LOOSE. This was 150 ms and it failed the gate on a
# machine that was busy rendering - not because anything changed, but because
# the quiet number is 137 ms and nine percent of headroom cannot tell a bad
# rewrite from a busy box. A check that fails when something ELSE is using the
# machine is one people learn to skip. 250 ms still catches the regression it
# names: the naive round trip above costs roughly 2.2x the shipped one, so any
# rewrite that lost the fast path lands well past this line.
eq("...and the 1080p whole-frame pair stays under 250ms (137ms quiet, 147ms under load)",
   pair_frame < 250.0, True)


print("\n%d passed, %d failed\n" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
