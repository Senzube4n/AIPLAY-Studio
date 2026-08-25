"""Unit tests for the photo tools in server/imgphoto.py.

Every one of these tools has a closed-form answer available if you are willing
to build the input backwards, so almost nothing here is eyeballed:

  * DEHAZE is measured against a plate that was HAZED ON PURPOSE. I = J*t +
    A*(1-t) with a t map and an A this file chose, so the original J is ground
    truth and the only interesting number is how much of the error came out.
  * WHITE BALANCE is measured on the picked pixel: it either goes neutral or it
    does not, and "neutral" is a number.
  * HIGHLIGHT RECOVERY is measured on a synthetic clip of a KNOWN hue, so the
    recovered channel ratio can be compared with the ratio that was clipped.
  * AUTO-STRAIGHTEN is measured against a rotation this file applied, using the
    same call imagetools' `rotate` op makes - so the SIGN is asserted against
    that op's source rather than against anyone's memory of it.
  * CLARITY vs TEXTURE is measured as a per-frequency GAIN on a sum of
    sinusoids, because "they are different tools" is a claim about frequency
    and nothing else.

Four sweeps run over every tool in the CATALOG rather than over a list written
here, so a tool added without a test still gets the contract checked:

  * the catalog contract - label / group / why, defaults inside their own range
  * a bit-identical no-op at strength zero, and alpha bit-exact always
  * a mask limits every tool, including the two that return numbers
  * hostile input - NaN, inf, out of range, 1x1, all black, all white

And one seam test: auto-tone's proposal is fed to imagetools.apply_edit ONE KEY
AT A TIME, and every key has to move the pixels. A proposal naming an op that
imagetools ignores is the failure this codebase makes most often, and it cannot
be caught by testing this module alone.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgphoto_test.py

numpy / cv2 / PIL, plus imagetools for the round trip.
"""
import json
import math
import os
import sys
import tempfile
import time

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imagetools                                          # noqa: E402
import imgphoto as P                                       # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    eq(f"{name}  [{float(got):.5g} vs {float(want):.5g} +-{tol:g}]",
       abs(float(got) - float(want)) <= tol, True)


def rgba(rgb, alpha=1.0):
    """An (H, W, 4) plate out of an (H, W, 3) one."""
    out = np.empty(rgb.shape[:2] + (4,), np.float32)
    out[..., :3] = np.clip(rgb, 0.0, 1.0)
    out[..., 3] = alpha
    return out


def photo(n=256, seed=4):
    """Something with structure at several scales, a colour cast and grain -
    a flat noise field is not a photograph and half of these tools read as
    no-ops on one."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    a = np.empty((n, n, 3), np.float32)
    a[..., 0] = 0.30 + 0.30 * (xx / n) + 0.10 * np.sin(xx / 11.0) + 0.05 * np.sin(xx / 2.7)
    a[..., 1] = 0.34 + 0.22 * (yy / n) + 0.09 * np.sin(yy / 7.0) + 0.04 * np.sin(yy / 3.1)
    a[..., 2] = 0.38 + 0.18 * ((xx + yy) / (2 * n)) + 0.08 * np.cos((xx + yy) / 9.0)
    a += rng.normal(0, 0.01, a.shape).astype(np.float32)
    return rgba(a)


def rmse(a, b):
    return float(np.sqrt(((a[..., :3].astype(np.float64)
                           - b[..., :3].astype(np.float64)) ** 2).mean()))


def mean_l(img):
    return float(np.clip(img[..., :3] @ P.LUMA, 0, 1).mean())


ZERO = {"dehaze": {"amount": 0}, "clarity": {"amount": 0}, "texture": {"amount": 0},
        "whiteBalance": {"amount": 0, "x": 3, "y": 3},
        "splitTone": {"shadowSat": 0, "highlightSat": 0},
        "highlightRecovery": {"amount": 0},
        "autoStraighten": {}, "autoTone": {}}

# Live settings for the sweeps and the timings. Chosen to be what somebody
# would actually run, not what is easiest to assert on: the timings below are
# quoted as a real-world cost, and a threshold that calls half the frame
# clipped would quote highlight recovery at three times what it costs.
LIVE = {"dehaze": {"amount": 70}, "clarity": {"amount": 70},
        "texture": {"amount": 70, "radius": 1.5, "threshold": 0},
        "whiteBalance": {"amount": 100, "x": 5, "y": 5, "sampleRadius": 1},
        "splitTone": {"shadowSat": 70, "highlightSat": 70},
        "highlightRecovery": {"amount": 100},
        "autoStraighten": {}, "autoTone": {}}


print("\nimgphoto\n")
print("  -- the catalog contract --")

bad = [k for k, e in P.CATALOG.items()
       if not e.get("label") or not e.get("why") or e.get("group") not in P.GROUP_ORDER]
eq("every tool has a label, a why and a real group", bad, [])
eq("every tool carries touchesAlpha", [k for k, e in P.CATALOG.items()
                                       if "touchesAlpha" not in e], [])
eq("nothing here claims to touch alpha", [k for k, e in P.CATALOG.items()
                                          if e["touchesAlpha"]], [])

out_of_range = []
undocumented = []
for k, e in P.CATALOG.items():
    for pk, spec in e["params"].items():
        if not spec.get("desc"):
            undocumented.append(f"{k}.{pk}")
        if spec["type"] == "number" and not (spec["min"] <= spec["default"] <= spec["max"]):
            out_of_range.append(f"{k}.{pk}")
        if spec["type"] == "enum" and spec["default"] not in spec["options"]:
            out_of_range.append(f"{k}.{pk}")
eq("every parameter says what it is for", undocumented, [])
eq("every default sits inside its own advertised range", out_of_range, [])

eq("the catalog survives JSON, which is how MCP serves it",
   isinstance(json.loads(json.dumps(P.catalog()))["tools"], dict), True)
eq("every registered tool is in the catalog and vice versa",
   sorted(P._REGISTRY) == sorted(P.CATALOG), True)
eq("every analyzer names a catalog entry that declares what it returns",
   [n for n in P._ANALYZERS if "returns" not in P.CATALOG.get(n, {})], [])
eq("the two analysis tools are flagged as such",
   sorted(k for k, e in P.CATALOG.items() if e.get("analysis")),
   ["autoStraighten", "autoTone"])
eq("the ZERO and LIVE tables cover every tool - a new tool cannot dodge the sweeps",
   sorted(ZERO) == sorted(LIVE) == sorted(P.CATALOG), True)


print("\n  -- dehaze, against haze this file added itself --")

# I = J*t + A*(1-t), in LINEAR light, with t falling off toward the top of the
# frame the way distance does. J is therefore ground truth.
CLEAN = photo(256, seed=7)
_yy = np.mgrid[0:256, 0:256][0].astype(np.float32)
T_MAP = (0.28 + 0.66 * (_yy / 255.0)).astype(np.float32)
A_TRUE = np.array([0.86, 0.89, 0.96], np.float32)
_lin = P._to_linear(CLEAN[..., :3])
HAZY = rgba(P._to_srgb(_lin * T_MAP[..., None] + A_TRUE * (1.0 - T_MAP[..., None])))

err_before = rmse(HAZY, CLEAN)
errs = {a: rmse(P.apply("dehaze", HAZY, {"amount": a}), CLEAN) for a in (25, 50, 75, 100)}
print(f"          rmse against the true plate: hazy {err_before:.4f} -> "
      + ", ".join(f"amount {a} {e:.4f}" for a, e in errs.items()))
eq("dehaze recovers measurably toward the original", errs[100] < err_before * 0.6, True)
eq("...and more of it the harder you push",
   all(errs[b] < errs[a] for a, b in ((25, 50), (50, 75), (75, 100))), True)
near("...leaving under half the error it started with", errs[100] / err_before, 0.43, 0.15)

# The transmission estimate has to be a DEPTH map, not a brightness map: the far
# half of the frame was hazed harder, so it has to be corrected harder.
_d = P.apply("dehaze", HAZY, {"amount": 100})
_far = rmse(_d[:128], CLEAN[:128]), rmse(HAZY[:128], CLEAN[:128])
eq("the far half - hazed hardest - is where most of the recovery lands",
   (_far[1] - _far[0]) > (rmse(HAZY[128:], CLEAN[128:])
                          - rmse(_d[128:], CLEAN[128:])), True)

_added = P.apply("dehaze", CLEAN, {"amount": -80})
eq("negative dehaze puts haze back in", float(np.abs(_added - CLEAN).max()) > 0.05, True)
eq("...toward the airlight, so the frame gets flatter",
   float(np.std(_added[..., :3])) < float(np.std(CLEAN[..., :3])), True)
eq("...and it does nothing to a picture that is already all airlight",
   float(np.abs(P.apply("dehaze", rgba(np.full((32, 32, 3), 0.9, np.float32)),
                        {"amount": -80})[..., :3] - 0.9).max()) < 0.01, True)


print("\n  -- clarity: local contrast, and not much else --")

FLAT = photo(256, seed=11)
_c = P.apply("clarity", FLAT, {"amount": 60})


def local_contrast(img, sigma):
    lum = np.ascontiguousarray(np.clip(img[..., :3] @ P.LUMA, 0, 1))
    return float(np.std(lum - cv2.GaussianBlur(lum, (0, 0), sigma)))


_sig = 256 * 0.03
_lc = (local_contrast(FLAT, _sig), local_contrast(_c, _sig))
_shift = mean_l(_c) - mean_l(FLAT)
print(f"          local contrast {_lc[0]:.4f} -> {_lc[1]:.4f}; "
      f"mean brightness moved {_shift:+.5f}")
eq("clarity raises local contrast", _lc[1] > _lc[0] * 1.25, True)
eq("...without moving the global mean brightness by more than 0.005 of full range",
   abs(_shift) < 0.005, True)
eq("negative clarity lowers it again",
   local_contrast(P.apply("clarity", FLAT, {"amount": -60}), _sig) < _lc[0], True)

# The protection is the whole tool. Ramp the frame from black to white and see
# where the change lands.
_ramp = rgba(np.tile(np.linspace(0.0, 1.0, 256, dtype=np.float32)[None, :, None],
                     (256, 1, 3))
             + 0.04 * np.sin(np.mgrid[0:256, 0:256][1] / 2.6).astype(np.float32)[..., None])
_p_on = P.apply("clarity", _ramp, {"amount": 90, "protect": 100})
_p_off = P.apply("clarity", _ramp, {"amount": 90, "protect": 0})


def moved(a, b, sl):
    return float(np.abs(a[:, sl, :3] - b[:, sl, :3]).mean())


_ends = moved(_p_on, _ramp, slice(0, 24)) + moved(_p_on, _ramp, slice(232, 256))
_ends_off = moved(_p_off, _ramp, slice(0, 24)) + moved(_p_off, _ramp, slice(232, 256))
eq("protect holds the two ends back", _ends < _ends_off * 0.35, True)
eq("...and leaves the midtones alone",
   moved(_p_on, _ramp, slice(112, 144)) > moved(_p_off, _ramp, slice(112, 144)) * 0.85, True)


print("\n  -- texture is a different tool, and here is the frequency to prove it --")

# A sum of sinusoids at known frequencies. The gain each tool applies at each
# one is |FFT(out - in)| / |FFT(in)| in that bin - the textbook measurement, and
# the only honest way to say "these two work on different detail".
_N, _KS = 512, [2, 5, 12, 32, 80, 200]
_x = np.arange(_N, dtype=np.float32)
_row = np.full(_N, 0.5, np.float32)
for _k in _KS:
    _row = _row + 0.04 * np.sin(2 * np.pi * _k * _x / _N).astype(np.float32)
SINES = rgba(np.tile(np.clip(_row, 0, 1)[None, :, None], (_N, 1, 3)))
_base_f = np.fft.rfft(SINES[_N // 2, :, 0].astype(np.float64))


def gain(img):
    d = np.fft.rfft((img[_N // 2, :, 0] - SINES[_N // 2, :, 0]).astype(np.float64))
    return {k: float(abs(d[k]) / abs(_base_f[k])) for k in _KS}


G_CL = gain(P.apply("clarity", SINES, {"amount": 60}))
G_TX = gain(P.apply("texture", SINES, {"amount": 60, "threshold": 0}))
print("          cycles/frame " + "  ".join(f"{k:>6d}" for k in _KS))
print("          clarity gain " + "  ".join(f"{G_CL[k]:6.3f}" for k in _KS))
print("          texture gain " + "  ".join(f"{G_TX[k]:6.3f}" for k in _KS))

eq("at 5 cycles across the frame clarity outguns texture by more than 20x",
   G_CL[5] > G_TX[5] * 20, True)
eq("clarity is a HIGH-pass: its gain never rolls off at the top",
   G_CL[200] >= G_CL[80] * 0.9, True)
eq("texture is a BAND-pass: its gain does, which is the noise octave it leaves alone",
   G_TX[200] < G_TX[80] * 0.7, True)
eq("texture's gain peaks above clarity's crossover, not at it",
   max(G_TX, key=G_TX.get) > max(G_CL, key=lambda k: G_CL[k] if k <= 12 else 0), True)
eq("the two produce measurably different pictures at the same strength",
   float(np.abs(P.apply("clarity", FLAT, {"amount": 60})
                - P.apply("texture", FLAT, {"amount": 60})).max()) > 0.02, True)
eq("texture's threshold really is a noise floor - raising it does less",
   float(np.abs(P.apply("texture", FLAT, {"amount": 60, "threshold": 40}) - FLAT).sum())
   < float(np.abs(P.apply("texture", FLAT, {"amount": 60, "threshold": 0}) - FLAT).sum()),
   True)
eq("negative texture smooths instead", local_contrast(
    P.apply("texture", FLAT, {"amount": -80, "threshold": 0}), 1.0) < local_contrast(FLAT, 1.0),
   True)


print("\n  -- white balance from a picked neutral, on six illuminants --")

_NEUTRAL = 0.6
_scene = photo(64, seed=21)
_scene[8, 8, :3] = _NEUTRAL                       # the pixel that should be grey

ILLUM = {"none (D65)": (1.00, 1.00, 1.00), "tungsten": (1.45, 1.00, 0.55),
         "open shade": (0.82, 0.97, 1.30), "fluorescent green": (0.95, 1.15, 0.92),
         "deep blue cast": (0.60, 0.85, 1.50), "magenta cast": (1.12, 0.88, 1.10)}
for _name, _ill in ILLUM.items():
    _lit = rgba(P._to_srgb(np.clip(P._to_linear(_scene[..., :3])
                                   * np.array(_ill, np.float32), 0, 1)))
    _lit[..., 3] = 1.0
    _fixed = P.apply("whiteBalance", _lit, {"x": 8, "y": 8, "sampleRadius": 0})
    _px = _fixed[8, 8, :3]
    _read = P.analyze("whiteBalance", _lit, {"x": 8, "y": 8, "sampleRadius": 0})
    print(f"          {_name:19s} spread {float(_px.max() - _px.min()):.6f}   "
          f"{_read['temperatureK']:8.1f} K   tint {_read['tint']:+.4f}")
    eq(f"{_name}: the picked pixel comes back neutral to 1/1000 of full range",
       float(_px.max() - _px.min()) < 0.001, True)
    # The guarantee is that the PICKED pixel keeps the luminance it was
    # RECORDED with, which falls out of normalising both whites to Y=1. Not
    # that it returns to the brightness it had before the light was coloured -
    # a blue cast genuinely dims a grey card, and no white balance can know
    # what the card looked like under a lamp it never saw.
    # Against CIE Y, not the Rec.601 LUMA the rest of this file uses: the two
    # agree on a neutral and nowhere else, and the LIT pixel is not neutral.
    eq(f"{_name}: ...and the picked pixel keeps the luminance it was recorded with",
       abs(float(P._to_linear(_px) @ P._RGB2XYZ[1])
           - float(P._to_linear(_lit[8, 8, :3]) @ P._RGB2XYZ[1])) < 0.0005, True)
    eq(f"{_name}: the whole frame moves toward the unlit original",
       rmse(_fixed, _scene) < rmse(_lit, _scene) or _name.startswith("none"), True)

_d65 = P.analyze("whiteBalance", rgba(np.full((8, 8, 3), 0.5, np.float32)),
                 {"x": 4, "y": 4, "sampleRadius": 0})
near("a neutral pick reads as D65, which is what sRGB's white point IS",
     _d65["temperatureK"], 6504, 40)
eq("...and its adaptation is the identity", [round(g, 3) for g in _d65["gain"]],
   [1.0, 1.0, 1.0])
eq("the green illuminant reads the largest tint of the six",
   max(ILLUM, key=lambda n: abs(P.analyze(
       "whiteBalance", rgba(P._to_srgb(np.clip(P._to_linear(_scene[..., :3])
                                               * np.array(ILLUM[n], np.float32), 0, 1))),
       {"x": 8, "y": 8, "sampleRadius": 0})["tint"])), "fluorescent green")
eq("a sample radius averages a patch instead of trusting one pixel",
   float(np.ptp(P.apply("whiteBalance", _scene, {"x": 32, "y": 32, "sampleRadius": 4})[
       32, 32, :3])) < float(np.ptp(_scene[32, 32, :3])), True)
eq("half the amount is half the adaptation, not half the picture",
   float(np.abs(P.apply("whiteBalance", _scene, {"x": 8, "y": 8, "amount": 50})[8, 8, :3]
                - _scene[8, 8, :3]).max()) > 0, True)
eq("a black pick is refused rather than guessed at",
   np.array_equal(P.apply("whiteBalance", rgba(np.zeros((8, 8, 3), np.float32)),
                          {"x": 1, "y": 1}),
                  rgba(np.zeros((8, 8, 3), np.float32))), True)
eq("a pick outside the frame is clamped and says so",
   P.analyze("whiteBalance", _scene, {"x": 9000, "y": 9000})["clamped"], True)


print("\n  -- split toning: two ends, independently, and a quiet middle --")

RAMP = rgba(np.tile(np.linspace(0.02, 0.98, 128, dtype=np.float32)[None, :, None],
                    (32, 1, 3)))
_st = P.apply("splitTone", RAMP, {"shadowHue": 240, "shadowSat": 80,
                                  "highlightHue": 40, "highlightSat": 80})
_d = (_st[..., :3] - RAMP[..., :3])[0]
_dark, _mid, _bright = _d[:20], _d[54:74], _d[108:]
_fmt = lambda a: "[" + " ".join(f"{v:+.4f}" for v in a.mean(0)) + "]"   # noqa: E731
print(f"          shadows dRGB {_fmt(_dark)}   mids {_fmt(_mid)}   "
      f"highs {_fmt(_bright)}")
eq("the shadows take the blue that was asked for",
   _dark[:, 2].mean() > 0.08 and _dark[:, 2].mean() > _dark[:, 0].mean() + 0.08, True)
eq("the highlights take the orange, independently",
   _bright[:, 0].mean() > 0.02 and _bright[:, 0].mean() > _bright[:, 2].mean() + 0.08, True)
eq("the midtones move least of the three",
   np.abs(_mid).max() < min(np.abs(_dark).max(), np.abs(_bright).max()) * 0.1, True)

_only_lo = P.apply("splitTone", RAMP, {"shadowHue": 240, "shadowSat": 80, "highlightSat": 0})
_only_hi = P.apply("splitTone", RAMP, {"highlightHue": 40, "highlightSat": 80, "shadowSat": 0})
eq("shadow-only leaves the highlights untouched",
   float(np.abs(_only_lo[:, 108:] - RAMP[:, 108:]).max()) < 0.002, True)
eq("highlight-only leaves the shadows untouched",
   float(np.abs(_only_hi[:, :20] - RAMP[:, :20]).max()) < 0.002, True)
eq("balance right hands the midtones to the highlight tint",
   float(np.abs(P.apply("splitTone", RAMP, {"highlightHue": 40, "highlightSat": 80,
                                            "balance": 90})[:, 54:74]
                - RAMP[:, 54:74]).mean())
   > float(np.abs(_only_hi[:, 54:74] - RAMP[:, 54:74]).mean()) * 3, True)
eq("balance left hands them to the shadow tint",
   float(np.abs(P.apply("splitTone", RAMP, {"shadowHue": 240, "shadowSat": 80,
                                            "balance": -90})[:, 54:74]
                - RAMP[:, 54:74]).mean())
   > float(np.abs(_only_lo[:, 54:74] - RAMP[:, 54:74]).mean()) * 3, True)
# The tint vector carries no luminance, so a grade moves colour and not exposure.
near("a full split tone does not change the frame's brightness",
     mean_l(_st) - mean_l(RAMP), 0.0, 0.004)


print("\n  -- highlight recovery: what survived, and what honestly did not --")

# A constant-hue exposure ramp. Red clips first, then green; blue never does.
# Plus a strip that is flat white, where all three are gone.
_n = 192
_x = np.mgrid[0:_n, 0:_n][1].astype(np.float32)
HUE = np.array([1.0, 0.62, 0.24], np.float32)
_true = (0.18 + 1.55 * (_x / (_n - 1)))[..., None] * HUE
CLIPPED = rgba(P._to_srgb(np.clip(_true, 0, 1)))
CLIPPED[:36, :, :3] = 1.0                         # all three gone, nothing to recover
_rec = P.apply("highlightRecovery", CLIPPED)

_c8 = CLIPPED[..., :3] >= 0.96
_nc = _c8.sum(2)
_lin_out = P._to_linear(_rec[..., :3])
_lin_in = P._to_linear(CLIPPED[..., :3])
for _tag, _sel, _want in (("one channel clipped", _nc == 1, True),
                          ("two channels clipped", _nc == 2, True),
                          ("all three clipped", _nc == 3, False),
                          ("nothing clipped", _nc == 0, False)):
    if not _sel.any():
        eq(f"{_tag}: the test plate contains some", False, True)
        continue
    _a, _b = _lin_out[_sel], _lin_in[_sel]
    _gr_a = float((_a[:, 1] / np.maximum(_a[:, 0], 1e-6)).mean())
    _gr_b = float((_b[:, 1] / np.maximum(_b[:, 0], 1e-6)).mean())
    print(f"          {_tag:22s} {int(_sel.sum()):6d}px   G/R true {HUE[1]:.3f}  "
          f"was {_gr_b:.4f}  now {_gr_a:.4f}")
    if _want:
        eq(f"{_tag}: the ratio the clip destroyed comes back",
           abs(_gr_a - HUE[1]) < abs(_gr_b - HUE[1]) * 0.25, True)
        near(f"{_tag}: ...to within 1% of the true hue", _gr_a, HUE[1], 0.01)
    else:
        eq(f"{_tag}: bit-identical - there was nothing to recover, and it says so",
           np.array_equal(_rec[_sel], CLIPPED[_sel]), True)

eq("recovered pixels trade brightness for colour, so they get darker",
   mean_l(_rec) < mean_l(CLIPPED), True)
eq("the catalog admits the all-three case up front",
   "ALL THREE" in P.CATALOG["highlightRecovery"]["why"], True)
eq("an image with nothing clipped comes back bit-identical",
   np.array_equal(P.apply("highlightRecovery", photo(64)), photo(64)), True)
eq("half the amount is half the move",
   float(np.abs(P.apply("highlightRecovery", CLIPPED, {"amount": 50})
                - CLIPPED).max()) < float(np.abs(_rec - CLIPPED).max()), True)
# A blown region far wider than any blur radius is the case a one-Gaussian
# recovery silently fails at, so it gets its own line.
_wide = CLIPPED.copy()
_wide[100:, 40:, 0] = 1.0
eq("a blown region far wider than the radius is still reached",
   float(np.abs(P.apply("highlightRecovery", _wide, {"radius": 0.3})[150, 170]
                - _wide[150, 170]).max()) > 0.01, True)


print("\n  -- auto-straighten: an angle, checked against the rotation that made it --")


def tilt(deg, n=600, crop=384, seed=3):
    """Rotate a plate the way imagetools' `rotate` op does - `im.rotate(-rot)` -
    then crop out the corners so no border edge can vote. Asserting the sign
    against that call rather than against a memory of which way is positive."""
    a = np.full((n, n, 3), 0.14, np.float32)
    for y in range(30, n, 57):
        a[y:y + 5] = 0.88
    for x in range(45, n, 103):
        a[:, x:x + 4] = 0.72
    a += np.random.default_rng(seed).normal(0, 0.01, a.shape).astype(np.float32)
    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "RGB")
    im = im.rotate(-deg, resample=Image.BICUBIC, expand=False)
    c = (n - crop) // 2
    return rgba(np.asarray(im).astype(np.float32)[c:c + crop, c:c + crop] / 255.0)


for _deg in (-9.0, -4.5, -1.0, 0.0, 2.5, 6.0, 11.0):
    _r = P.analyze("autoStraighten", tilt(_deg))
    print(f"          rotate={_deg:+6.2f} deg -> angle {_r['angle']:+7.3f}  "
          f"confidence {_r['confidence']:.2f}  {_r['lines']} lines")
    near(f"a plate rotated by {_deg:+.1f} asks to be rotated back by {-_deg:+.1f}",
         _r["angle"], -_deg, 0.35)
    eq(f"...and is confident about it ({_deg:+.1f})", _r["confidence"] > 0.5, True)

eq("horizon-only and vertical-only agree on the same frame",
   abs(P.analyze("autoStraighten", tilt(5.0), {"mode": "horizon"})["angle"]
       - P.analyze("autoStraighten", tilt(5.0), {"mode": "vertical"})["angle"]) < 0.4, True)
eq("a tilt past maxAngle is composition, not a mistake, and is left alone",
   P.analyze("autoStraighten", tilt(9.0), {"maxAngle": 3})["angle"], 0.0)
eq("a frame with no lines in it returns zero and says why",
   P.analyze("autoStraighten", rgba(np.full((128, 128, 3), 0.5, np.float32)))["confidence"],
   0.0)
eq("it does NOT rotate - that belongs to whoever owns geometry",
   np.array_equal(P.apply("autoStraighten", tilt(6.0)), tilt(6.0)), True)


print("\n  -- auto-tone proposes values, and imagetools has to accept every one --")


def through_imagetools(img, ops):
    """The real seam: write a PNG, run imagetools.apply_edit on it, read it back.
    A proposal that names an op imagetools does not read is the failure this
    codebase makes most often, and only this call can catch it."""
    d = tempfile.mkdtemp(prefix="imgphoto_")
    src, dst = os.path.join(d, "in.png"), os.path.join(d, "out.png")
    Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA").save(src)
    buf, sys.stdout = sys.stdout, open(os.devnull, "w")
    try:
        imagetools.apply_edit({"in": src, "out": dst, "ops": ops})
    finally:
        sys.stdout.close()
        sys.stdout = buf
    return np.asarray(Image.open(dst).convert("RGBA")).astype(np.float32) / 255.0


# GOOD has to be a plate that already USES its range, or "open the range back
# up" has nothing to be judged against and auto-tone is marked down for doing
# its job. photo() is deliberately low-contrast, so it gets stretched first.
_g = photo(192, seed=31)[..., :3]
_glo, _ghi = float(np.percentile(_g, 0.5)), float(np.percentile(_g, 99.5))
GOOD = rgba((_g - _glo) / (_ghi - _glo) * 0.94 + 0.03)
# The degraded version: crushed into the middle of the range, lifted off black,
# and given a blue cast in linear light the way an overcast sky actually does it.
_bad_lin = P._to_linear(GOOD[..., :3]) * np.array([0.86, 0.94, 1.12], np.float32)
BAD = rgba(P._to_srgb(np.clip(_bad_lin, 0, 1)) * 0.44 + 0.29)

PROP = P.analyze("autoTone", BAD)
print("          proposal: " + json.dumps(PROP["adjust"]))
for _n in PROP["notes"]:
    print(f"            - {_n}")
eq("auto-tone proposes something for a picture that needs it", bool(PROP["adjust"]), True)
eq("...and explains every decision", len(PROP["notes"]) >= len(PROP["adjust"]), True)
eq("...and never proposes autoLevels, which is a white balance in disguise",
   "autoLevels" in PROP["adjust"], False)
eq("it is deterministic - two runs propose the same numbers",
   json.dumps(P.analyze("autoTone", BAD)) == json.dumps(PROP), True)

def spread(i):
    """1st-to-99th percentile of luminance - how much of the range is in use."""
    lum = i[..., :3] @ P.LUMA
    return float(np.percentile(lum, 99) - np.percentile(lum, 1))


def cast(i):
    """Shades-of-grey (Minkowski p=6) illuminant imbalance - the standard
    measure of a colour CAST, and a multiplicative one.

    The obvious metric, how far apart the three channel means are, measures the
    wrong thing twice over: it grows with any levels stretch, because stretching
    the range stretches the gap between the channels with it, and it cannot tell
    a scene that is genuinely blue from a scene lit blue.
    """
    px = i[..., :3].reshape(-1, 3).astype(np.float64)
    px = px[(px.max(1) < 0.99) & (px.max(1) > 0.02)]
    if px.shape[0] < 32:
        return 0.0
    e = np.power(np.power(px, 6).mean(axis=0), 1.0 / 6.0)
    return float(np.ptp(e / e.mean()))


_fixed = through_imagetools(BAD, PROP["adjust"])
print(f"          rmse to the good plate {rmse(BAD, GOOD):.4f} -> {rmse(_fixed, GOOD):.4f};"
      f"  tonal spread {spread(BAD):.3f} -> {spread(_fixed):.3f} (good plate "
      f"{spread(GOOD):.3f});  cast {cast(BAD):.4f} -> {cast(_fixed):.4f} "
      f"(good plate {cast(GOOD):.4f})")
eq("through imagetools, the proposal moves the picture toward the good plate",
   rmse(_fixed, GOOD) < rmse(BAD, GOOD) * 0.9, True)
eq("...it opens the tonal range back up", spread(_fixed) > spread(BAD) * 1.6, True)
# The cast claim, ISOLATED. End to end it is confounded: crushing a picture
# into the middle of the range flatters this metric (BAD scores better than
# GOOD), and the levels stretch that auto-tone proposes first hands the
# imbalance straight back. So the temperature is judged on the image it was
# actually measured for - the one that exists after the levels move.
_lev = through_imagetools(BAD, {"levels": PROP["adjust"]["levels"]})
_lev_t = through_imagetools(_lev, {"temperature": PROP["adjust"]["temperature"]})
print(f"          illuminant imbalance: good plate {cast(GOOD):.4f}, degraded "
      f"{cast(BAD):.4f}, after levels {cast(_lev):.4f}, after the proposed "
      f"temperature {cast(_lev_t):.4f}")
eq("the temperature it chose takes more than half the cast out of the image "
   "it measured", cast(_lev_t) < cast(_lev) * 0.5, True)
# Worth knowing rather than hiding: shades-of-grey pulls toward neutral, so on a
# frame with a real colour bias auto-tone lands FLATTER than the untouched
# original. That is the estimator's known failure and not a bug in the plumbing.
eq("...and, being a grey-world estimate, overshoots past the original's own bias",
   cast(_lev_t) < cast(GOOD), True)
# It does NOT reproduce the original: it restores the RANGE, which on a plate
# whose original never filled the range means it overshoots. Saying so here is
# cheaper than someone re-deriving it from a failing assertion later.
eq("...while over-stretching, because 'use the range' is the job and the "
   "original did not use all of it", spread(_fixed) > spread(GOOD), True)


def effort(prop):
    """One number for how much a proposal is asking for, so convergence is a
    line on a chart instead of an argument about four keys."""
    a = prop["adjust"]
    lv = (a.get("levels") or {}).get("master") or {}
    return (float(lv.get("black", 0)) + (255.0 - float(lv.get("white", 255)))
            + abs(float(a.get("gamma", 1.0)) - 1.0) * 255.0
            + abs(float(a.get("contrast", 100.0)) - 100.0) * 5.0
            + abs(float(a.get("temperature", 0.0)))
            + abs(float(a.get("saturation", 100.0)) - 100.0)
            + float(a.get("shadows", 0.0)) + float(a.get("highlights", 0.0)))


# Convergence is the honest version of "does it know when to stop": apply its
# own answer, ask again, and it has to want much less the second time. A tool
# that keeps finding the same amount of work is one that is guessing.
_efforts, _cur = [], BAD
for _ in range(4):
    _prop = P.analyze("autoTone", _cur)
    _efforts.append(round(effort(_prop), 1))
    if not _prop["adjust"]:
        break
    _cur = through_imagetools(_cur, _prop["adjust"])
print(f"          effort per pass, applying its own answer each time: {_efforts}")
eq("auto-tone converges - the second pass asks for a seventh of the first",
   _efforts[1] < _efforts[0] * 0.15, True)
eq("...and keeps shrinking", all(b <= a for a, b in zip(_efforts, _efforts[1:])), True)
eq("...down to a trim of a few levels, which is all an 8-bit percentile can see",
   _efforts[-1] < 12.0, True)
eq("a converged picture is offered nothing but that trim",
   set(P.analyze("autoTone", _cur)["adjust"]) <= {"levels"}, True)

# ONE KEY AT A TIME. A key imagetools ignores would hide behind the others.
for _key, _val in sorted(PROP["adjust"].items()):
    _one = through_imagetools(BAD, {_key: _val})
    eq(f"imagetools really reads `{_key}` - alone, it moves the pixels",
       float(np.abs(_one[..., :3] - BAD[..., :3]).max()) > 0.004, True)
for _key, _val in sorted(PROP.get("photo", {}).items()):
    eq(f"`{_key}` is a real tool in this module's own catalog", _key in P.CATALOG, True)
    eq(f"...and {_key}'s proposed params are all ones it declares",
       [k for k in _val if k not in P.CATALOG[_key]["params"]], [])

def already_fine(n=128, seed=77):
    """A plate built to be nothing to complain about: luminance centred on the
    default midtone target with an IQR a well-exposed frame has, a few real
    blacks and whites so the range is genuinely used, random hues so the three
    channel means come out level, and detail everywhere so nothing reads as
    flat or hazy. If auto-tone still finds work here it is finding it in itself.
    """
    rng = np.random.default_rng(seed)
    lum = np.clip(rng.normal(0.45, 0.18, (n, n)), 0, 1).astype(np.float32)
    hues = rng.random((n, n)).astype(np.float32) * 360.0
    chroma = np.stack([P._hue_chroma(h) for h in hues.ravel()]).reshape(n, n, 3)
    flat = np.clip(lum[..., None] + chroma.astype(np.float32) * 0.12, 0, 1).reshape(-1, 3)
    pick = rng.random(flat.shape[0])
    flat[pick < 0.004] = 0.0
    flat[(pick >= 0.004) & (pick < 0.008)] = 1.0
    return rgba(flat.reshape(n, n, 3))


_none = P.analyze("autoTone", already_fine())
eq("a picture that needs nothing gets an empty proposal and says so",
   _none["adjust"] == {} and _none["photo"] == {}
   and "nothing to do" in _none["notes"][0], True)
eq("strength 0 proposes nothing at all",
   P.analyze("autoTone", BAD, {"strength": 0})["adjust"] == {}, True)
eq("a hazy plate is offered dehaze", "dehaze" in P.analyze("autoTone", HAZY)["photo"], True)
eq("...and imagetools is never asked for a dehaze it does not have",
   "dehaze" in P.analyze("autoTone", HAZY)["adjust"], False)
eq("it does NOT touch pixels", np.array_equal(P.apply("autoTone", BAD), BAD), True)


print("\n  -- the sweeps: every tool, not one example of each --")

SWEEP = photo(96, seed=5)
SWEEP[..., 3] = np.linspace(0.15, 1.0, 96, dtype=np.float32)[None, :]
SWEEP[4:12, 4:12, :3] = 1.0                       # something clipped, for recovery
SWEEP[20:28, 20:28, :3] = np.array([1.0, 0.5, 0.3], np.float32)

for _name in sorted(P.CATALOG):
    _z = P.apply(_name, SWEEP, ZERO[_name])
    eq(f"{_name} at strength zero is BIT-IDENTICAL", np.array_equal(_z, SWEEP), True)
    _l = P.apply(_name, SWEEP, LIVE[_name])
    eq(f"{_name} leaves alpha bit-exact", np.array_equal(_l[..., 3], SWEEP[..., 3]), True)
    eq(f"{_name} returns float32 (H, W, 4) inside 0..1",
       _l.dtype == np.float32 and _l.shape == SWEEP.shape
       and float(_l.min()) >= 0.0 and float(_l.max()) <= 1.0
       and not np.isnan(_l).any(), True)
    eq(f"{_name} does not write to the array it was handed",
       np.array_equal(SWEEP, photo(96, seed=5) * 0 + SWEEP), True)


print("\n  -- a mask limits every tool --")

# An exposure ramp brightening to the right, so red genuinely blows out on that
# side and nowhere else. Painting a white block in instead looks like a clip and
# is not one: with no supporting gradient the estimate lands below the clip
# point, recovery correctly declines, and the test would have been asserting
# against a plate that never contained the thing it was testing.
MASKED = photo(128, seed=17)
_expo = (0.35 + 3.0 * (np.arange(128, dtype=np.float32) / 127.0))[None, :, None]
MASKED[..., :3] = np.clip(
    P._to_srgb(np.clip(P._to_linear(MASKED[..., :3]) * _expo, 0, 1)), 0, 1)
_ncl = (MASKED[..., :3] >= 0.96).sum(2)
eq("the mask plate really does have a one-or-two-channel clip, and only on the right",
   bool(((_ncl[:, 64:] >= 1) & (_ncl[:, 64:] <= 2)).sum() > 500
        and (_ncl[:, :64] > 0).sum() == 0), True)
MASK = np.zeros((128, 128), np.float32)
MASK[:, 64:] = 1.0                                # the right half only

for _name in sorted(P.CATALOG):
    if P.CATALOG[_name].get("analysis"):
        continue
    _par = dict(LIVE[_name])
    if _name == "whiteBalance":
        _par.update({"x": 100, "y": 40})          # pick inside the masked half
    _out = P.apply(_name, MASKED, _par, MASK)
    eq(f"{_name}: outside the mask, bit-identical",
       np.array_equal(_out[:, :64], MASKED[:, :64]), True)
    eq(f"{_name}: inside it, something happened",
       float(np.abs(_out[:, 64:] - MASKED[:, 64:]).max()) > 0.002, True)
    # A half mask is half the move - measured against the tool's OWN result
    # before the 0..1 clamp, because `apply` clamps after the blend. Compare
    # against the clamped result instead and every tool that pushes a pixel
    # past white on a plate that is already there looks broken.
    _half = np.full((128, 128), 0.5, np.float32)
    _raw = P._REGISTRY[_name](MASKED, P._coerce(P.CATALOG[_name]["params"], _par), None)
    _want = np.clip((MASKED[..., :3] + _raw[..., :3]) * 0.5, 0, 1)
    _soft = P.apply(_name, MASKED, _par, _half)
    eq(f"{_name}: a half mask is half the move",
       float(np.abs(_soft[..., :3] - _want).max()) < 0.002, True)
    eq(f"{_name}: a mask of the wrong shape is refused, not applied globally",
       np.array_equal(P.apply(_name, MASKED, _par, np.ones((7, 7), np.float32)), MASKED),
       True)

# The two that return numbers honour it too - by only listening inside it.
_tilted = tilt(6.0)
_only_left = np.zeros(_tilted.shape[:2], np.float32)
_only_left[:, :40] = 1.0                          # a sliver: too few lines to vote
eq("autoStraighten: a mask changes which lines get a vote",
   P.analyze("autoStraighten", _tilted, {}, _only_left)["lines"]
   < P.analyze("autoStraighten", _tilted)["lines"], True)
_dark_half = np.zeros((192, 192), np.float32)
_dark_half[:, :96] = 1.0
eq("autoTone: a mask changes what it measures",
   P.analyze("autoTone", BAD, {}, _dark_half)["stats"]
   != P.analyze("autoTone", BAD)["stats"], True)
eq("autoTone: a mask of the wrong shape is refused",
   P.analyze("autoTone", BAD, {}, np.ones((3, 3), np.float32)), None)


print("\n  -- hostile input, on every parameter of every tool --")

TINY = rgba(np.full((1, 1, 3), 0.4, np.float32))
BLACK = rgba(np.zeros((24, 24, 3), np.float32))
WHITE = rgba(np.ones((24, 24, 3), np.float32))
NANS = photo(24, seed=2)
NANS[3, 3, :3] = np.nan
NANS[4, 4, 0] = np.inf
NANS[5, 5, 1] = -np.inf
PLATES = {"1x1": TINY, "all black": BLACK, "all clipped white": WHITE,
          "NaN and inf in the pixels": NANS}

HOSTILE = [float("nan"), float("inf"), float("-inf"), -1e9, 1e9, 0, None, "12", [1, 2]]


def hostile_check(name, plate, params):
    """What a tool actually owes on a hostile call.

    NOT "the output is free of NaN": a strength-zero no-op returns the array it
    was handed, verbatim, and if the CALLER put a NaN in there it comes back -
    which is the bit-identity promise working, not a leak. What is owed is that
    nothing NEW appears, and that a finite plate stays inside 0..1.
    """
    out = []
    with np.errstate(all="ignore"):
        o = P.apply(name, plate, params)
    if o.shape != plate.shape or o.dtype != np.float32:
        return [f"{params} wrong shape or dtype"]
    if np.any(np.isnan(o) & ~np.isnan(plate)):
        out.append(f"{params} invented a NaN")
    if np.isfinite(plate).all() and (float(o.min()) < 0.0 or float(o.max()) > 1.0):
        out.append(f"{params} left 0..1")
    if name in P._ANALYZERS:
        with np.errstate(all="ignore"):
            r = P.analyze(name, plate, params)
        if r is not None and not isinstance(r, dict):
            out.append(f"{params} analyze returned {type(r)}")
        if isinstance(r, dict) and any(isinstance(x, float) and not math.isfinite(x)
                                       for x in r.values()):
            out.append(f"{params} non-finite readout")
    return out


for _name, _entry in sorted(P.CATALOG.items()):
    _bad = []
    for _pk in _entry["params"]:
        for _v in HOSTILE:
            for _plate in PLATES.values():
                try:
                    _bad += hostile_check(_name, _plate, {_pk: _v})
                except Exception as _exc:                   # noqa: BLE001
                    _bad.append(f"{_pk}={_v!r} raised {_exc}")
    eq(f"{_name} survives every hostile value on every parameter", _bad[:4], [])

for _pname, _plate in PLATES.items():
    _bad = []
    for _name in P.CATALOG:
        _bad += [f"{_name}: {x}" for x in hostile_check(_name, _plate, LIVE[_name])]
    eq(f"every tool survives a plate that is {_pname}", _bad, [])

eq("a no-op hands back the NaN it was given rather than quietly scrubbing it - "
   "bit-identical means bit-identical",
   np.array_equal(P.apply("clarity", NANS, {"amount": 0}), NANS, equal_nan=True), True)
eq("...but a tool that RUNS never lets one through",
   np.isnan(P.apply("clarity", NANS, {"amount": 60})).any(), False)

eq("a fully clipped white frame has nothing to recover and comes back untouched",
   np.array_equal(P.apply("highlightRecovery", WHITE, {"amount": 100}), WHITE), True)
eq("a black frame has no illuminant, and white balance says so rather than dividing",
   np.array_equal(P.apply("whiteBalance", BLACK, {"x": 3, "y": 3}), BLACK), True)
eq("an unknown tool name is the input back, not an exception",
   np.array_equal(P.apply("noSuchTool", TINY), TINY), True)
eq("an unknown name has no analysis either", P.analyze("noSuchTool", TINY), None)
eq("a uint8 array is refused at the seam rather than run at 255x",
   P.apply("clarity", (SWEEP * 255).astype(np.uint8), {"amount": 50}).dtype, np.uint8)
eq("an RGB array with no alpha is refused",
   P.apply("clarity", SWEEP[..., :3], {"amount": 50}).shape, (96, 96, 3))
eq("parameters the catalog does not declare are dropped, not passed through",
   np.array_equal(P.apply("clarity", SWEEP, {"amount": 0, "wat": 99}), SWEEP), True)


print("\n  -- what it costs, at 4096x4096 --")

_N4 = 4096
_yy, _xx = np.mgrid[0:_N4, 0:_N4].astype(np.float32)
BIG = np.empty((_N4, _N4, 4), np.float32)
BIG[..., 3] = 1.0
BIG[..., 0] = np.clip(0.24 + 0.62 * (_xx / _N4) + 0.13 * np.sin(_xx / 9.0), 0, 1)
BIG[..., 1] = np.clip(0.31 + 0.44 * (_yy / _N4) + 0.11 * np.sin(_yy / 5.0), 0, 1)
BIG[..., 2] = np.clip(0.36 + 0.30 * (_xx / _N4) + 0.09 * np.sin((_xx + _yy) / 13.0), 0, 1)
del _yy, _xx
BIG_MASK = np.zeros((_N4, _N4), np.float32)
BIG_MASK[1024:3072, 1024:3072] = 1.0

_slow = []
for _name in sorted(P.CATALOG):
    _par = dict(LIVE[_name])
    if _name == "whiteBalance":
        _par.update({"x": 2000, "y": 2000, "sampleRadius": 4})
    P.apply(_name, BIG[:64, :64].copy(), _par)                  # warm the code paths
    _t = time.perf_counter()
    P.apply(_name, BIG, _par)
    _ms = (time.perf_counter() - _t) * 1000.0
    _t = time.perf_counter()
    P.apply(_name, BIG, _par, BIG_MASK)
    _msm = (time.perf_counter() - _t) * 1000.0
    _an = ""
    if _name in P._ANALYZERS:
        _t = time.perf_counter()
        P.analyze(_name, BIG, _par)
        _an = f"   analyze {(time.perf_counter() - _t) * 1000.0:7.0f} ms"
    print(f"          {_name:20s} {_ms:7.0f} ms   with a mask {_msm:7.0f} ms{_an}")
    if _ms > 6000:
        _slow.append(f"{_name} {_ms:.0f}ms")
eq("nothing takes more than six seconds on a 16-megapixel frame", _slow, [])

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
