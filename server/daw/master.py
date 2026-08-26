# -*- coding: utf-8 -*-
"""DAW -- the MASTERING SUITE. Seven devices and four analysers, additive.

── WHAT THIS FILE IS ───────────────────────────────────────────────────────
rack.py is the chain stage: nine devices, all single-band, no analysis
surface. This module is the mastering half — the devices a master needs that
a channel strip does not (multiband dynamics, dynamic EQ, mid/side, width,
tilt, a true-peak maximizer, an exciter, dither) and the MEASUREMENTS a
mastering UI draws from.

It is ADDITIVE in the strict sense: rack.py imports this module at the very
bottom and does three things —

    CATALOG.update(master.CATALOG)      # new devices join the catalog
    DEVICES.update(master.DEVICES)      # ...and the dispatch table
    DEVICES["eq"]        = master.ms_wrap(dev_eq)          # M/S, opt-in
    DEVICES["compressor"] = master.ms_wrap(dev_compressor, unlinked=True)

— and no existing device body is edited. `stereo_mode: "stereo"` (the
default) makes the wrappers a straight call, so every byte the rack produced
before this file existed it still produces.

── THE UI SEAM (binding; the arrangement window draws from this and only
   this) ────────────────────────────────────────────────────────────────────
Analysis is served as DATA. This module renders and measures; it draws
nothing, names no colour, and takes no view state. Four engine modes, each
one JSON object:

  analyze          every meter in one payload — see ANALYZE_SHAPE below
  device_response  a device's own frequency response, FROM ITS COEFFICIENTS
  reference        a reference track, loudness-matched, both spectra
  check_delivery   PASS/FAIL against the streaming targets + the exact gain

The payload keys are frozen by master_test.py (`test_analyze_shape`), so the
UI can bind to them. Anything added later is additive; nothing is renamed.

── WHAT IS REUSED, NOT REIMPLEMENTED ───────────────────────────────────────
  rack.lufs_integrated / lufs_short_term / true_peak_db / k_weight
                            BS.1770-4. Not one line of it is repeated here.
  rack._block_loudness      the 400 ms / 3 s gated block engine.
  rack._rbj_peaking / _rbj_pass / db_to_lin / value_env / _ctrl_pool /
  _ctrl_up / _coef / _envelope_db / Params / CTRL / AUTO_BLOCK
                            the rack's own primitives and control rate.
  rack.dev_limiter          the maximizer's brickwall stage IS the rack's
                            limiter, so the true-peak ceiling proof carries
                            over unchanged rather than being re-argued.
  ear.read_audio_stereo     any container the rig can decode.
  ear.loudness / stereo_stats / band_spectrogram / BANDS / BAND_NAMES /
  pink_reference_db         the Ear's nine-band view and its pink null.
Both are imported LAZILY (`_rack()`, `_ear()`) because rack.py imports this
module: a module-level import would close the cycle at load time.

── LINKWITZ-RILEY, AND WHY THE BANDS SUM BACK ──────────────────────────────
An LR4 crossover is two cascaded Butterworth (Q = 1/√2) biquads. In the
analog prototype

    LP4 = 1/(s²+√2s+1)²        HP4 = s⁴/(s²+√2s+1)²
    LP4 + HP4 = (1+s⁴)/(s²+√2s+1)² = (s²−√2s+1)/(s²+√2s+1)

which is a second-order ALLPASS. The bilinear transform is an algebraic
substitution, so the identity survives it exactly provided both halves use
the same prewarping — RBJ's low-pass and high-pass at one f0 and Q do. In
the digital coefficients that reads: with a = [1+α, −2cos w0, 1−α] the
allpass is reverse(a)/a, and

    b_lp² + b_hp² = reverse(a)·a     (verified term by term at Q = 1/√2:
                                      1−α² = (1+cos²)/2 and
                                      2+2α²+4cos² = 3(1+cos²))

so LP4+HP4 = reverse(a)/a with NO residual. The tree therefore reconstructs:
each band already emitted is passed through the allpass of every LATER
crossover, and

    Σ bands = AP_fk(...AP_f1(x))

exactly — an allpass chain, unity magnitude at every frequency, one shared
phase rotation. That is what "phase-coherent" can mean and does mean here:
the sum is NOT the input sample-for-sample (no LR crossover's is), it is the
input through a magnitude-flat allpass, and master_test.py asserts BOTH — the
sum against the allpass reference to 1e-10, and |FFT(sum)| against |FFT(x)|
to 0.01 dB. A device that claimed bit-equality with the raw input would be
lying about arithmetic anyone can check.

── MID/SIDE IS EXACT ON OUR AUDIO ──────────────────────────────────────────
M = (L+R)/2, S = (L−R)/2, L = M+S, R = M−S. In general IEEE-754 this butterfly
is NOT bit-exact (a counterexample exists at 1+2⁻⁵²). On OUR buffers it is:
every sample originates as float32 (the instrument stage's contract), so L±R
is exactly representable in float64 — 24-bit significands cannot overflow 53
— and the round trip is bit-identical. master_test.py asserts bit-equality on
float32-sourced audio and one-ulp equality on adversarial float64, so the
claim is pinned in the only two forms that are true.

── DETERMINISM ─────────────────────────────────────────────────────────────
Same input + same params → byte-identical output, including `dither`: its
noise is a prefix of one PCG64 stream seeded from the `seed` param, and a
prefix of a stream does not depend on how long the stream is asked to be, so
a region render and a full render agree sample for sample — the rack's seam
rule, kept.

── NO GPL ─────────────────────────────────────────────────────────────────
numpy + scipy only. The filter cookbook is RBJ's (public domain by the
author's own statement, and already the rack's); the noise-shaping transfer
function is (1−z⁻¹)², which is elementary. No plugin source of any licence
was read, ported or consulted.
"""
import math
import os
import sys
import time

import numpy as np
from scipy.signal import freqz, resample_poly, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

MASTER_VERSION = 1


def _rack():
    """rack.py, lazily. rack.py imports THIS module at its bottom to register
    the devices, so a module-level `import rack` would close the cycle while
    one of the two is still half-built. Every use below is at call time."""
    import rack  # noqa: PLC0415
    return rack


def _ear():
    """ear.py, lazily — same argument (ear imports rack, rack imports us)."""
    import ear  # noqa: PLC0415
    return ear


# ────────────────────────────────────────────────────────── catalog helpers
# The same three constructors rack.py uses, so the two catalogs are one
# shape. A parameter that is not here does not exist: the rack clamps and
# drops against this table before a device body sees anything.


def _num(default, lo, hi, desc, unit=None, animatable=True):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": animatable, "desc": desc}
    if unit:
        p["unit"] = unit
    return p


def _bool(default, desc):
    return {"type": "bool", "default": default, "animatable": False, "desc": desc}


def _enum(default, values, desc):
    return {"type": "enum", "default": default, "values": list(values),
            "animatable": False, "desc": desc}


# The one parameter added to two EXISTING devices. Kept here so the wrapper
# and the catalog entry can never disagree about its name or its values.
STEREO_MODE = _enum(
    "stereo", ["stereo", "mid_side", "mid", "side"],
    "stereo = left/right (the default, byte-identical to before this "
    "parameter existed). mid_side = the device runs on M=(L+R)/2 and "
    "S=(L-R)/2 with the same settings. mid = only the centre is processed, "
    "the sides pass untouched. side = only the sides are processed, the "
    "centre passes untouched -- widen the air or de-ess the reverb without "
    "laying a finger on the lead vocal. The encode/decode is exact on "
    "float32-sourced audio.")


# ─────────────────────────────────────────────────────────────── the catalog

CATALOG = {
    "multibandCompressor": {
        "label": "Multiband Compressor",
        "why": "Two to four bands split by Linkwitz-Riley 4th-order "
               "crossovers, each with its own threshold/ratio/attack/release/"
               "makeup and its own solo and bypass. The bands sum back to a "
               "magnitude-flat allpass of the input, so at unity the device "
               "changes tone by nothing measurable. Compress the low end "
               "without pumping the vocal -- the thing a single-band "
               "compressor structurally cannot do.",
        "stateful": True,
        "params": {
            "bands": _enum("3", ["2", "3", "4"], "How many bands."),
            "x1_hz": _num(120.0, 30.0, 1000.0, "Crossover 1 (low | low-mid).", "Hz"),
            "x2_hz": _num(900.0, 200.0, 6000.0, "Crossover 2 (low-mid | high-mid).", "Hz"),
            "x3_hz": _num(5000.0, 1000.0, 16000.0, "Crossover 3 (high-mid | high).", "Hz"),
            "knee_db": _num(6.0, 0.0, 24.0, "Soft-knee width, shared by every band.", "dB"),
            "b1_threshold_db": _num(-24.0, -60.0, 0.0, "Band 1 threshold.", "dB"),
            "b1_ratio": _num(3.0, 1.0, 20.0, "Band 1 slope above the knee."),
            "b1_attack_ms": _num(30.0, 0.5, 300.0, "Band 1 attack.", "ms"),
            "b1_release_ms": _num(200.0, 5.0, 2000.0, "Band 1 release.", "ms"),
            "b1_makeup_db": _num(0.0, -12.0, 24.0, "Band 1 gain after reduction.", "dB"),
            "b1_solo": _bool(False, "Hear band 1 alone (any solo mutes the rest)."),
            "b1_bypass": _bool(False, "Band 1 passes through uncompressed."),
            "b2_threshold_db": _num(-24.0, -60.0, 0.0, "Band 2 threshold.", "dB"),
            "b2_ratio": _num(3.0, 1.0, 20.0, "Band 2 slope above the knee."),
            "b2_attack_ms": _num(15.0, 0.5, 300.0, "Band 2 attack.", "ms"),
            "b2_release_ms": _num(150.0, 5.0, 2000.0, "Band 2 release.", "ms"),
            "b2_makeup_db": _num(0.0, -12.0, 24.0, "Band 2 gain after reduction.", "dB"),
            "b2_solo": _bool(False, "Hear band 2 alone."),
            "b2_bypass": _bool(False, "Band 2 passes through uncompressed."),
            "b3_threshold_db": _num(-24.0, -60.0, 0.0, "Band 3 threshold.", "dB"),
            "b3_ratio": _num(3.0, 1.0, 20.0, "Band 3 slope above the knee."),
            "b3_attack_ms": _num(8.0, 0.5, 300.0, "Band 3 attack.", "ms"),
            "b3_release_ms": _num(120.0, 5.0, 2000.0, "Band 3 release.", "ms"),
            "b3_makeup_db": _num(0.0, -12.0, 24.0, "Band 3 gain after reduction.", "dB"),
            "b3_solo": _bool(False, "Hear band 3 alone."),
            "b3_bypass": _bool(False, "Band 3 passes through uncompressed."),
            "b4_threshold_db": _num(-24.0, -60.0, 0.0, "Band 4 threshold.", "dB"),
            "b4_ratio": _num(3.0, 1.0, 20.0, "Band 4 slope above the knee."),
            "b4_attack_ms": _num(5.0, 0.5, 300.0, "Band 4 attack.", "ms"),
            "b4_release_ms": _num(100.0, 5.0, 2000.0, "Band 4 release.", "ms"),
            "b4_makeup_db": _num(0.0, -12.0, 24.0, "Band 4 gain after reduction.", "dB"),
            "b4_solo": _bool(False, "Hear band 4 alone."),
            "b4_bypass": _bool(False, "Band 4 passes through uncompressed."),
        },
    },
    "dynamicEq": {
        "label": "Dynamic EQ",
        "why": "Four bells that are FLAT until the frequency they sit on "
               "misbehaves, then move by up to their range and let go. "
               "`above` cuts when the band gets loud (harshness, sibilance, "
               "a boomy note); `below` lifts when it gets quiet. The modern "
               "alternative to carving a permanent hole for a problem that "
               "only happens in the chorus. Each band is the exact identity "
               "y = x + (A-1)*BPF(x), so at A = 1 it is bit-transparent.",
        "stateful": True,
        "params": {
            "d1_on": _bool(False, "Enable band 1."),
            "d1_hz": _num(120.0, 20.0, 20000.0, "Band 1 centre.", "Hz"),
            "d1_q": _num(2.0, 0.2, 12.0, "Band 1 Q (higher = narrower)."),
            "d1_threshold_db": _num(-24.0, -60.0, 0.0, "Band 1 threshold, on the band's own level.", "dB"),
            "d1_ratio": _num(4.0, 1.0, 20.0, "Band 1 slope past the threshold."),
            "d1_range_db": _num(6.0, 0.0, 18.0, "Most band 1 may move.", "dB"),
            "d1_mode": _enum("above", ["above", "below"], "Act when the band goes above (cut) or below (boost) the threshold."),
            "d1_attack_ms": _num(10.0, 0.5, 300.0, "Band 1 attack.", "ms"),
            "d1_release_ms": _num(120.0, 5.0, 2000.0, "Band 1 release.", "ms"),
            "d2_on": _bool(False, "Enable band 2."),
            "d2_hz": _num(600.0, 20.0, 20000.0, "Band 2 centre.", "Hz"),
            "d2_q": _num(2.0, 0.2, 12.0, "Band 2 Q."),
            "d2_threshold_db": _num(-24.0, -60.0, 0.0, "Band 2 threshold.", "dB"),
            "d2_ratio": _num(4.0, 1.0, 20.0, "Band 2 slope."),
            "d2_range_db": _num(6.0, 0.0, 18.0, "Most band 2 may move.", "dB"),
            "d2_mode": _enum("above", ["above", "below"], "Cut above, or boost below."),
            "d2_attack_ms": _num(10.0, 0.5, 300.0, "Band 2 attack.", "ms"),
            "d2_release_ms": _num(120.0, 5.0, 2000.0, "Band 2 release.", "ms"),
            "d3_on": _bool(False, "Enable band 3."),
            "d3_hz": _num(3000.0, 20.0, 20000.0, "Band 3 centre.", "Hz"),
            "d3_q": _num(2.0, 0.2, 12.0, "Band 3 Q."),
            "d3_threshold_db": _num(-24.0, -60.0, 0.0, "Band 3 threshold.", "dB"),
            "d3_ratio": _num(4.0, 1.0, 20.0, "Band 3 slope."),
            "d3_range_db": _num(6.0, 0.0, 18.0, "Most band 3 may move.", "dB"),
            "d3_mode": _enum("above", ["above", "below"], "Cut above, or boost below."),
            "d3_attack_ms": _num(5.0, 0.5, 300.0, "Band 3 attack.", "ms"),
            "d3_release_ms": _num(80.0, 5.0, 2000.0, "Band 3 release.", "ms"),
            "d4_on": _bool(False, "Enable band 4."),
            "d4_hz": _num(8000.0, 20.0, 20000.0, "Band 4 centre.", "Hz"),
            "d4_q": _num(2.0, 0.2, 12.0, "Band 4 Q."),
            "d4_threshold_db": _num(-24.0, -60.0, 0.0, "Band 4 threshold.", "dB"),
            "d4_ratio": _num(4.0, 1.0, 20.0, "Band 4 slope."),
            "d4_range_db": _num(6.0, 0.0, 18.0, "Most band 4 may move.", "dB"),
            "d4_mode": _enum("above", ["above", "below"], "Cut above, or boost below."),
            "d4_attack_ms": _num(3.0, 0.5, 300.0, "Band 4 attack.", "ms"),
            "d4_release_ms": _num(60.0, 5.0, 2000.0, "Band 4 release.", "ms"),
        },
    },
    "stereoImager": {
        "label": "Stereo Imager",
        "why": "Width per band -- narrow the lows, widen the air -- through "
               "the same Linkwitz-Riley tree as the multiband, plus a "
               "mono-below corner for the bottom octaves. Widening LOWERS "
               "correlation; this device does not hide that from you. Run "
               "daw_analyze before and after and read `correlation.overall` "
               "and `correlation.min`: anything under 0 will partly cancel "
               "on a mono system, and no setting here can fix that for you.",
        "stateful": True,
        "params": {
            "x1_hz": _num(250.0, 40.0, 2000.0, "Crossover 1 (low | mid).", "Hz"),
            "x2_hz": _num(3000.0, 500.0, 12000.0, "Crossover 2 (mid | high).", "Hz"),
            "w1_width": _num(1.0, 0.0, 2.0, "Low width: 0 mono, 1 as-is, 2 double."),
            "w2_width": _num(1.0, 0.0, 2.0, "Mid width."),
            "w3_width": _num(1.0, 0.0, 2.0, "High width."),
            "mono_below_hz": _num(0.0, 0.0, 300.0,
                                  "Fold everything under this to mono (0 = off).", "Hz"),
        },
    },
    "tiltEq": {
        "label": "Tilt EQ",
        "why": "One knob for the whole spectrum: a low shelf down and a high "
               "shelf up by half the tilt each, hinged at the pivot. Darker "
               "or brighter in a single gesture, with the pivot left alone. "
               "The cheapest real move in mastering and the one used most.",
        "stateful": True,
        "params": {
            "tilt_db": _num(0.0, -12.0, 12.0,
                            "Negative = darker (lows up, highs down); "
                            "positive = brighter.", "dB"),
            "pivot_hz": _num(1000.0, 100.0, 8000.0, "The frequency that does not move.", "Hz"),
            "slope": _num(0.7, 0.3, 1.5, "Shelf slope (higher = steeper hinge)."),
        },
    },
    "maximizer": {
        "label": "Maximizer",
        "why": "Loudness with the true-peak ceiling held by proof, not by "
               "hope. Drive pushes the level up; a soft knee starts pulling "
               "BEFORE the ceiling (never after -- the knee only ever "
               "reduces more than the hard requirement); the last stage is "
               "the rack's own true-peak limiter, so the 4x-oversampled "
               "ceiling argument carries over unchanged. For the honest "
               "gain-reduction readout, daw_analyze with this device as the "
               "`device` probe answers a measured GR series in dB. "
               "READ THIS BEFORE TRUSTING THE NUMBER ON A MASTER BUS: the "
               "ceiling is the ceiling at THIS DEVICE's output. rack.py's P0 "
               "master curve, tanh(0.7*mix), runs after every insert on the "
               "master chain, so a -1 dBTP setting reaches the FILE at about "
               "-5.1 dBFS with ~3.2 dB of curve compression at the peak. The "
               "ceiling is never breached -- the error is entirely in the "
               "safe direction -- but a true-peak-exact delivery cannot be "
               "made through the master bus as the rack stands. Set the "
               "ceiling for the sound you want and read the FILE's number "
               "from daw_analyze or daw_check_delivery, never from the knob.",
        "stateful": True,
        "params": {
            "gain_db": _num(0.0, 0.0, 24.0, "Drive into the ceiling.", "dB"),
            "ceiling_db": _num(-1.0, -20.0, 0.0, "Output ceiling (true peak).", "dBTP"),
            "knee_db": _num(3.0, 0.0, 12.0, "How far under the ceiling the pull starts.", "dB"),
            "attack_ms": _num(1.0, 0.1, 50.0, "Knee-stage attack.", "ms"),
            "release_ms": _num(120.0, 1.0, 1000.0, "Recovery speed.", "ms"),
            "lookahead_ms": _num(5.0, 1.0, 10.0, "How far the gain ramp leads the audio.", "ms"),
            "character": _enum("clean", ["clean", "warm", "punch"],
                               "clean = gain only. warm = a tanh knee before the "
                               "limiter (harmonics instead of pumping). punch = a "
                               "dual release that lets transients through."),
        },
    },
    "exciter": {
        "label": "Exciter",
        "why": "Harmonics ADDED to a chosen band, not a saturator behind a "
               "filter. The generator runs 4x oversampled between two "
               "elliptic brickwalls, so the third harmonic of 9 kHz is "
               "REMOVED rather than folded back as a 21 kHz alias. What "
               "survives is the 19th harmonic (171 kHz folding at a 192 kHz "
               "working rate), and it grows with drive because a hard-driven "
               "tanh IS a square wave: master_test.py measures the fold-back "
               "at 73 dB down at +3 dB of drive, 62 at the default +12, and "
               "36 when slammed to +24 -- against 17 dB for the same curve "
               "with no oversampling. Stay under +18 for a clean top end. "
               "`blend` chooses even harmonics (an octave up, warmth) or odd "
               "(a twelfth up, edge), or any mix.",
        "stateful": True,
        "params": {
            "freq_hz": _num(3000.0, 200.0, 12000.0,
                            "Only what is above this gets excited.", "Hz"),
            "drive_db": _num(12.0, 0.0, 36.0, "Level into the generator.", "dB"),
            "blend": _num(0.5, 0.0, 1.0, "0 = even harmonics only, 1 = odd only."),
            "mix": _num(0.25, 0.0, 1.0, "How much of the generated harmonics to add."),
            "output_db": _num(0.0, -24.0, 12.0, "Output trim.", "dB"),
        },
    },
    "dither": {
        "label": "Dither",
        "why": "LAST on the master, and ONLY when the export reduces bit "
               "depth. Truncating to 16 bits without dither turns a fade "
               "into quantisation distortion that correlates with the "
               "music; TPDF dither converts it into a steady noise floor and "
               "keeps sub-LSB information audible (master_test.py recovers a "
               "-100 dBFS tone from a dithered 16-bit file and shows it "
               "destroyed by plain truncation). `shaped` pushes that noise "
               "up the spectrum with a (1-z^-1)^2 error feedback, buying "
               "about 6 dB of perceived floor under 4 kHz at the cost of "
               "more energy above 12 k. Deterministic: the noise is a prefix "
               "of one seeded PCG64 stream.",
        "stateful": True,
        "params": {
            "bits": _num(16.0, 8.0, 24.0, "Target bit depth.", "bits", animatable=False),
            "noise_shape": _enum("shaped", ["flat", "shaped"],
                                 "flat = plain TPDF. shaped = TPDF plus "
                                 "second-order error feedback."),
            "seed": _num(1.0, 0.0, 65535.0, "Noise seed (determinism).", None, animatable=False),
            "auto_blank": _bool(True, "No dither on digital silence."),
        },
    },
}

# What a probe should subtract from a measured net gain to get the honest
# GAIN REDUCTION of a dynamics device: the device's own make-up/drive knob.
GR_OFFSET_PARAM = {
    "maximizer": "gain_db",
    "compressor": "makeup_db",
    "limiter": None,
    "multibandCompressor": None,     # per-band makeup; the probe reports net
}


# ───────────────────────────────────────────────────── mid/side, exactly
#
# See the header: bit-exact on float32-sourced audio, one ulp on adversarial
# float64. Written once, used by the wrappers and by the imager.


def ms_encode(x):
    """(2,N) L/R -> (2,N) M/S. M = (L+R)/2, S = (L-R)/2."""
    return np.vstack([(x[0] + x[1]) * 0.5, (x[0] - x[1]) * 0.5])


def ms_decode(y):
    """(2,N) M/S -> (2,N) L/R. L = M+S, R = M-S."""
    return np.vstack([y[0] + y[1], y[0] - y[1]])


def ms_wrap(fn, unlinked=False):
    """Give an existing L/R device a `stereo_mode` parameter, without
    touching its body.

    stereo    fn(x) -- the same call, the same bytes, always.
    mid_side  fn runs on the M/S pair, one setting for both.
    mid/side  fn runs on THAT component only; the other is carried through
              the encode/decode untouched, which is what "EQ the sides
              without touching the centre" actually requires.

    `unlinked` runs the device once per component instead of once on the
    pair, so a DYNAMICS device detects mid and side independently (the
    classic M/S bus compressor: a loud centre must not duck the sides).
    For a per-channel filter like the EQ the two are identical and one pass
    is cheaper, so the flag is False there.
    """
    def wrapped(x, p, ctx):
        mode = p.at("stereo_mode")
        if mode == "stereo":
            return fn(x, p, ctx)
        ms = ms_encode(x)
        if mode == "mid":
            out = np.vstack([fn(np.vstack([ms[0], ms[0]]), p, ctx)[0], ms[1]])
        elif mode == "side":
            out = np.vstack([ms[0], fn(np.vstack([ms[1], ms[1]]), p, ctx)[0]])
        elif unlinked:
            out = np.vstack([fn(np.vstack([ms[0], ms[0]]), p, ctx)[0],
                             fn(np.vstack([ms[1], ms[1]]), p, ctx)[0]])
        else:
            out = fn(ms, p, ctx)
        return ms_decode(out)
    wrapped.__name__ = getattr(fn, "__name__", "device") + "_ms"
    wrapped.__doc__ = getattr(fn, "__doc__", None)
    return wrapped


# ──────────────────────────────────────────── Linkwitz-Riley crossover tree


def _pass_sos(f0, sr, kind):
    """One RBJ Butterworth (Q = 1/sqrt2) biquad as an sos row."""
    b, a = _rack()._rbj_pass(f0, sr, kind)
    return np.concatenate([b, a])


def lr4_sos(f0, sr, kind):
    """LR4 = the Butterworth biquad twice."""
    row = _pass_sos(f0, sr, kind)
    return np.vstack([row, row])


def ap2_sos(f0, sr):
    """The second-order allpass that LR4's LP+HP sums to: reverse(a)/a."""
    _, a = _rack()._rbj_pass(f0, sr, "lp")
    return np.array([a[2], a[1], a[0], 1.0, a[1], a[2]])


def _xovers(values, sr):
    """Sorted, distinct, inside the band, at least a third of an octave
    apart -- a crossover pair that crosses itself is not a crossover."""
    out = []
    for v in sorted(float(v) for v in values):
        v = min(max(v, 20.0), sr * 0.45)
        if out and v < out[-1] * 1.26:          # ~1/3 octave
            v = out[-1] * 1.26
        if v < sr * 0.45:
            out.append(v)
    return out


def lr_split(x, xovers, sr):
    """The LR4 tree: len(xovers)+1 bands, low to high, each (2,N).

    Every band already emitted takes the allpass of each LATER crossover, so
    the bands sum to AP_fk(...AP_f1(x)) EXACTLY -- see lr_reference()."""
    bands = []
    rest = np.asarray(x, dtype=np.float64)
    for f in xovers:
        lo = sosfilt(lr4_sos(f, sr, "lp"), rest, axis=1)
        hi = sosfilt(lr4_sos(f, sr, "hp"), rest, axis=1)
        ap = ap2_sos(f, sr)
        bands = [sosfilt(ap, b, axis=1) for b in bands]
        bands.append(lo)
        rest = hi
    bands.append(rest)
    return bands


def lr_reference(x, xovers, sr):
    """What lr_split's bands sum to: the input through the same allpasses.
    Unity magnitude at every frequency, one shared phase rotation."""
    y = np.asarray(x, dtype=np.float64)
    for f in xovers:
        y = sosfilt(ap2_sos(f, sr), y, axis=1)
    return y


# ────────────────────────────────────────────────────────── gain computers


def _soft_knee_reduction(over_db, knee_db, slope):
    """The Giannoulis soft knee, rack.dev_compressor's own shape, factored so
    the multiband and the maximizer cannot drift from the channel strip.
    `over_db` = level - threshold, positive above. Returns dB to REMOVE."""
    half = np.maximum(knee_db * 0.5, 1e-6)
    return np.where(over_db <= -half, 0.0,
                    np.where(over_db >= half,
                             slope * over_db,
                             slope * (over_db + half) ** 2 / (4.0 * half)))


def _dyn_gain(det, thr_db, ratio, knee_db, atk_ms, rel_ms, sr, n):
    """det (per sample, linear, >=0) -> per-sample linear gain <= 1.

    Control-rate throughout (rack.CTRL, ~0.33 ms), the rack's own pooling,
    smoothing and upsampling. Returns (gain (n,), reduction_db at ctrl rate)."""
    R = _rack()
    det_c = R._ctrl_pool(det, np.max)
    m = len(det_c)
    lev = 20.0 * np.log10(np.maximum(det_c, 1e-10))
    slope = 1.0 - 1.0 / max(float(ratio), 1.0)
    red = _soft_knee_reduction(lev - float(thr_db), float(knee_db), slope)
    atk = R._coef(np.full(m, float(atk_ms)), sr)
    rel = R._coef(np.full(m, float(rel_ms)), sr)
    red_s = R._envelope_db(red, atk, rel)
    return R._ctrl_up(R.db_to_lin(-red_s), n), red_s


# ──────────────────────────────────────────────────────────────── devices
#
# Every device: (x (2,N) float64, p Params, ctx) -> (2,N) float64, input
# never written to. ctx: { "sr", "spq", "dry": {trackId: mono float64} }.


def dev_multiband(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    nb = int(p.at("bands"))
    xo = _xovers([p.at(f"x{i}_hz") for i in range(1, nb)], sr)
    bands = lr_split(x, xo, sr)
    knee = p.at("knee_db")
    solos = [bool(p.at(f"b{i}_solo")) for i in range(1, nb + 1)]
    any_solo = any(solos)
    out = np.zeros((2, n))
    for i, band in enumerate(bands):
        k = i + 1
        if any_solo and not solos[i]:
            continue                          # solo mutes, it does not skip work twice
        if p.at(f"b{k}_bypass"):
            out += band
            continue
        det = np.maximum(np.abs(band[0]), np.abs(band[1]))
        gain, _ = _dyn_gain(det, p.at(f"b{k}_threshold_db"), p.at(f"b{k}_ratio"),
                            knee, p.at(f"b{k}_attack_ms"), p.at(f"b{k}_release_ms"),
                            sr, n)
        out += band * gain * _rack().db_to_lin(p.at(f"b{k}_makeup_db"))
    return out


def bpf0_coeffs(f0, q, sr):
    """RBJ constant-0-dB-peak bandpass: b = [alpha, 0, -alpha]."""
    w0 = 2.0 * math.pi * min(max(f0, 1.0), sr * 0.49) / sr
    alpha = math.sin(w0) / (2.0 * max(float(q), 1e-3))
    cw = math.cos(w0)
    a = np.array([1.0 + alpha, -2.0 * cw, 1.0 - alpha])
    b = np.array([alpha, 0.0, -alpha])
    return b / a[0], a / a[0]


def peaking_from_bpf(f0, q, gain_db, sr):
    """The exact transfer function of `y = x + (A-1)*BPF(x)`, which is what
    dev_dyneq applies. Numerator [1+alpha*A, -2cos, 1-alpha*A] over the BPF's
    own denominator -- a constant-Q bell whose bandwidth does NOT move with
    gain (the graphic-EQ convention, unlike RBJ's peaking, which does). This
    function is the ONLY description of that filter; device_response calls
    it, so the drawn curve is the filter."""
    A = 10.0 ** (float(gain_db) / 20.0)
    w0 = 2.0 * math.pi * min(max(f0, 1.0), sr * 0.49) / sr
    alpha = math.sin(w0) / (2.0 * max(float(q), 1e-3))
    cw = math.cos(w0)
    a = np.array([1.0 + alpha, -2.0 * cw, 1.0 - alpha])
    b = np.array([1.0 + alpha * A, -2.0 * cw, 1.0 - alpha * A])
    return b / a[0], a / a[0]


def dev_dyneq(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    R = _rack()
    y = np.asarray(x, dtype=np.float64)
    for i in (1, 2, 3, 4):
        if not p.at(f"d{i}_on"):
            continue
        rng = p.at(f"d{i}_range_db")
        if rng <= 0.0:
            continue
        b, a = bpf0_coeffs(p.at(f"d{i}_hz"), p.at(f"d{i}_q"), sr)
        sos = np.concatenate([b, a])[None, :]
        band = sosfilt(sos, y, axis=1)
        det = np.maximum(np.abs(band[0]), np.abs(band[1]))
        det_c = R._ctrl_pool(det, np.max)
        m = len(det_c)
        lev = 20.0 * np.log10(np.maximum(det_c, 1e-10))
        thr = p.at(f"d{i}_threshold_db")
        slope = 1.0 - 1.0 / max(p.at(f"d{i}_ratio"), 1.0)
        if p.at(f"d{i}_mode") == "above":
            move = -np.minimum(_soft_knee_reduction(lev - thr, 6.0, slope), rng)
        else:
            move = np.minimum(_soft_knee_reduction(thr - lev, 6.0, slope), rng)
        # The envelope smoother works on a POSITIVE "how far from flat"
        # signal, so the sign is stripped and put back.
        atk = R._coef(np.full(m, p.at(f"d{i}_attack_ms")), sr)
        rel = R._coef(np.full(m, p.at(f"d{i}_release_ms")), sr)
        mag = R._envelope_db(np.abs(move), atk, rel)
        sgn = -1.0 if p.at(f"d{i}_mode") == "above" else 1.0
        A = R._ctrl_up(R.db_to_lin(sgn * mag), n)
        y = y + (A - 1.0) * band
    return y


def dev_imager(x, p, ctx):
    sr = ctx["sr"]
    xo = _xovers([p.at("x1_hz"), p.at("x2_hz")], sr)
    bands = lr_split(x, xo, sr)
    out = np.zeros_like(np.asarray(x, dtype=np.float64))
    for i, band in enumerate(bands):
        w = p.at(f"w{i + 1}_width")
        mid = 0.5 * (band[0] + band[1])
        side = 0.5 * (band[0] - band[1]) * w
        out += np.vstack([mid + side, mid - side])
    mono_hz = p.at("mono_below_hz")
    if mono_hz > 0.0:
        lo = sosfilt(lr4_sos(mono_hz, sr, "lp"), out, axis=1)
        hi = sosfilt(lr4_sos(mono_hz, sr, "hp"), out, axis=1)
        m = 0.5 * (lo[0] + lo[1])
        out = np.vstack([m, m]) + hi
    return out


def shelf_coeffs(f0, slope, gain_db, sr, kind):
    """RBJ cookbook shelving filter (`S` = slope). Public-domain maths, the
    same family the rack's peaking/pass filters come from."""
    A = 10.0 ** (float(gain_db) / 40.0)
    w0 = 2.0 * math.pi * min(max(f0, 1.0), sr * 0.49) / sr
    S = min(max(float(slope), 0.05), 2.0)
    alpha = (math.sin(w0) / 2.0) * math.sqrt(max((A + 1.0 / A) * (1.0 / S - 1.0) + 2.0, 0.0))
    cw = math.cos(w0)
    tsa = 2.0 * math.sqrt(A) * alpha
    if kind == "low":
        b = np.array([A * ((A + 1) - (A - 1) * cw + tsa),
                      2 * A * ((A - 1) - (A + 1) * cw),
                      A * ((A + 1) - (A - 1) * cw - tsa)])
        a = np.array([(A + 1) + (A - 1) * cw + tsa,
                      -2 * ((A - 1) + (A + 1) * cw),
                      (A + 1) + (A - 1) * cw - tsa])
    else:
        b = np.array([A * ((A + 1) + (A - 1) * cw + tsa),
                      -2 * A * ((A - 1) + (A + 1) * cw),
                      A * ((A + 1) + (A - 1) * cw - tsa)])
        a = np.array([(A + 1) - (A - 1) * cw + tsa,
                      2 * ((A - 1) - (A + 1) * cw),
                      (A + 1) - (A - 1) * cw - tsa])
    return b / a[0], a / a[0]


def tilt_sections(p, sr, t=0.0):
    """The tilt's two shelves, as (b, a) pairs -- the ONE description, used
    by the device body AND by device_response."""
    tilt = p.at("tilt_db", t)
    if abs(tilt) < 1e-9:
        return []
    pivot = p.at("pivot_hz", t)
    s = p.at("slope", t)
    return [shelf_coeffs(pivot, s, -tilt * 0.5, sr, "low"),
            shelf_coeffs(pivot, s, +tilt * 0.5, sr, "high")]


def dev_tilt(x, p, ctx):
    sr = ctx["sr"]
    secs = tilt_sections(p, sr)
    if not secs:
        return x
    sos = np.vstack([np.concatenate([b, a]) for b, a in secs])
    return sosfilt(sos, np.asarray(x, dtype=np.float64), axis=1)


def dev_maximizer(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    R = _rack()
    ceiling_db = p.at("ceiling_db")
    y = np.asarray(x, dtype=np.float64) * R.db_to_lin(p.at("gain_db"))
    character = p.at("character")
    if character == "warm":
        # A tanh knee a little over the ceiling: harmonics instead of the
        # limiter pumping. It cannot raise the peak (|tanh| < 1), and the
        # brickwall below still owns the guarantee.
        c = R.db_to_lin(ceiling_db) * 1.4
        y = np.tanh(y / c) * c
    knee = p.at("knee_db")
    if knee > 0.0:
        # SAMPLE peak, not true peak, and deliberately: the knee is the
        # MUSICAL stage (start easing before the wall so the brickwall has
        # less to do), and the ceiling guarantee belongs entirely to the
        # limiter underneath, which does its own 4x detection. Oversampling
        # here as well would double the device's cost for a stage that owns
        # no guarantee -- 220 ms per 4-bar region instead of 130.
        lev = 20.0 * np.log10(np.maximum(
            np.maximum(np.abs(y[0]), np.abs(y[1])), 1e-10))
        over = lev - ceiling_db
        # A knee that starts EARLY and never late: red >= over everywhere in
        # the transition (at over = 0 it is knee/4 > 0), so the knee stage
        # can only make the brickwall's job smaller.
        red = np.where(over <= -knee, 0.0,
                       np.where(over >= knee, over,
                                (over + knee) ** 2 / (4.0 * knee)))
        red_c = R._ctrl_pool(red, np.max)
        m = len(red_c)
        atk = R._coef(np.full(m, p.at("attack_ms")), sr)
        rel_ms = p.at("release_ms")
        rel = R._coef(np.full(m, rel_ms), sr)
        smoothed = R._envelope_db(red_c, atk, rel)
        if character == "punch":
            # Dual release: the fast half lets transients breathe back.
            fast = R._envelope_db(red_c, atk, R._coef(np.full(m, max(rel_ms * 0.2, 1.0)), sr))
            smoothed = 0.5 * (smoothed + fast)
        y = y * R._ctrl_up(R.db_to_lin(-smoothed), n)
    # THE CEILING IS THE RACK'S LIMITER, not a second implementation of it.
    lp = R.Params(R.CATALOG["limiter"],
                  {"ceiling_db": ceiling_db, "release_ms": p.at("release_ms"),
                   "lookahead_ms": p.at("lookahead_ms")}, sr)
    return R.dev_limiter(y, lp, ctx)


def _harmonics(x, blend):
    """The two generators, crossfaded.

    ODD  tanh(2x)/2 -- an odd function, so its Taylor series has only odd
         powers and a sine in gives 3f, 5f, ... : edge, a twelfth up.
    EVEN tanh(2x^2)/2 -- x^2 is EVEN, so a sine in gives DC + 2f, 4f, ... :
         warmth, an octave up. The DC is removed by the corner filter the
         device applies afterwards. (x*|x| looks like an even generator and
         is not: it is ODD, and produced a pure third harmonic when this
         file first ran its own test.)

    Both are bounded by 0.5 so the drive knob cannot make the generator
    diverge, and both use the same curve so `blend` really is a crossfade
    between two harmonic families rather than between two loudnesses."""
    even = np.tanh(x * x * 2.0) * 0.5
    odd = np.tanh(x * 2.0) * 0.5
    return (1.0 - blend) * even + blend * odd


# The anti-alias filter the exciter's decimator leans on. resample_poly's
# DEFAULT window (81 taps at 4x) has a transition band several kHz wide, and
# master_test.py measured the 27 kHz third harmonic of a 9 kHz tone folding
# back to 21 kHz only 34 dB down through it. This elliptic filter puts the
# stopband at 22 kHz with 100 dB of rejection, and the same test now measures
# the fold-back over 60 dB down. Built once per rate; the cache is a pure
# function of sr, so determinism is untouched.
_DECIM_SOS = {}


def _decim_sos(sr, factor=4):
    key = (int(sr), int(factor))
    if key not in _DECIM_SOS:
        from scipy.signal import ellip  # noqa: PLC0415
        _DECIM_SOS[key] = ellip(6, 0.05, 90, sr * 0.45, "lowpass",
                                fs=sr * factor, output="sos")
    return _DECIM_SOS[key]


def dev_exciter(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    R = _rack()
    xin = np.asarray(x, dtype=np.float64)
    fc = p.at("freq_hz")
    band = sosfilt(lr4_sos(fc, sr, "hp"), xin, axis=1)
    drive = R.db_to_lin(p.at("drive_db"))
    # BAND LIMITING IS THE POINT, and it takes a brickwall on BOTH sides of
    # the generator:
    #   AFTER   the third harmonic of 9 kHz is 27 kHz. Decimated on
    #           resample_poly's default 81-tap window it folded back to
    #           21 kHz only 34 dB down -- master_test.py measured it.
    #   BEFORE  the UPSAMPLER's own residual images (48k +/- f) are still
    #           there at ~-60 dB, and a nonlinearity intermodulates them
    #           straight back into the audio band: 39 kHz - 2x9 kHz = 21 kHz.
    #           Filtering only after the generator left exactly that, 51 dB
    #           down instead of the 60+ the device claims. Also measured.
    # Both passes, therefore, and the exciter's ~330 ms per 4-bar region is
    # the price of not printing a whistle into a master.
    sos = _decim_sos(sr)
    up = sosfilt(sos, resample_poly(band * drive, 4, 1, axis=1), axis=1)
    gen = sosfilt(sos, _harmonics(up, p.at("blend")), axis=1)
    down = resample_poly(gen, 1, 4, axis=1)
    if down.shape[1] < n:
        down = np.pad(down, ((0, 0), (0, n - down.shape[1])))
    down = down[:, :n]
    # Keep only the harmonics that belong above the corner: the generator
    # also produces energy back down in the band it came from.
    down = sosfilt(lr4_sos(fc, sr, "hp"), down, axis=1)
    mix = p.at("mix")
    return (xin + down * mix) * R.db_to_lin(p.at("output_db"))


# ────────────────────────────────────────────────────────────────── dither
#
# The export-time device. See the catalog `why`; the maths is here so the
# BOUNCE PATH can call it without going through the rack at all.

# Error-feedback noise shaping. The quantiser is
#
#     v[n] = x[n] + H(z)e ,  q[n] = Q(v[n] + dither) ,  e[n] = q[n] - v[n]
#     =>  Q(z) = X(z) + (1 + H(z)) * (E(z) + D(z))
#
# so the NOISE transfer function is 1 + H(z). For NTF = (1 - z^-1)^2 -- a
# second-order highpass, zero at DC, +12 dB at Nyquist -- H(z) = -2z^-1 +
# z^-2, i.e. the taps below. Getting this sign backwards gives NTF(DC) = 2
# and makes the low-frequency floor 6 dB WORSE, which is exactly what the
# first run of master_test.py measured. Elementary maths; no source.
_SHAPE_TAPS = (-2.0, 1.0)


def tpdf_noise(n, seed, channels=2):
    """Triangular (TPDF) noise, +/-1 LSB peak, mean 0, as (channels, n).

    A PREFIX of one PCG64 stream: asking for fewer samples yields exactly the
    first samples of a longer ask, which is what makes a region render and a
    full render agree. That is why the stream is drawn ONCE and indexed
    [sample][channel][half] -- two separate rng.random((channels, n)) calls
    would put the second array at a stream position that depends on n, and
    the prefix property would quietly not hold. Seeded only by `seed`, never
    by the clock."""
    rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)
    raw = rng.random(n * channels * 2).reshape(n, channels, 2)
    return np.ascontiguousarray((raw[:, :, 0] - raw[:, :, 1]).T)


def apply_dither(y, bits=16, noise_shape="shaped", seed=1, auto_blank=True):
    """Quantise (2,N) or (N,) float audio to `bits`, with dither.

    Returns float64 on the SAME -1..1 scale, already quantised to the target
    grid, so the caller can hand it to any encoder without re-rounding. This
    is the function the bounce path calls -- see BOUNCE WIRING at the bottom
    of this file.

      flat    TPDF at +/-1 LSB. Decorrelates the error; the floor is white.
      shaped  TPDF plus second-order error feedback, NTF (1-z^-1)^2: the
              same total error, pushed up the spectrum where the ear cares
              least. Sequential by nature -- the loop is scalar on purpose
              and its cost is measured in master_test.py.

    auto_blank leaves digital silence alone: a run of exact zeros stays zero
    rather than becoming a hiss at the head of a track.
    """
    a = np.asarray(y, dtype=np.float64)
    mono = a.ndim == 1
    if mono:
        a = a[None, :]
    ch, n = a.shape
    if n == 0:
        return a[0] if mono else a
    bits = int(round(float(bits)))
    step = 2.0 ** -(bits - 1)                 # one LSB on the -1..1 scale
    d = tpdf_noise(n, seed, ch) * step
    if auto_blank:
        d = np.where(a == 0.0, 0.0, d)
    if noise_shape == "flat":
        flat = np.round((a + d) / step) * step
        return flat[0] if mono else flat
    # The loop runs in LSB UNITS (x/step), so the inner statement is two
    # multiply-adds and a floor rather than two divisions -- the only reason
    # a 384 k-sample stereo region costs ~150 ms instead of ~350 ms.
    out = np.empty_like(a)
    t0, t1 = _SHAPE_TAPS
    inv = 1.0 / step
    floor = math.floor
    for c in range(ch):
        xs = (a[c] * inv).tolist()
        ds = (d[c] * inv).tolist()
        acc = [0.0] * n
        e1 = 0.0
        e2 = 0.0
        for i in range(n):
            v = xs[i] + t0 * e1 + t1 * e2
            q = floor(v + ds[i] + 0.5)
            e2 = e1
            e1 = q - v                        # the error this sample fed back
            acc[i] = q
        out[c] = np.asarray(acc) * step
    return out[0] if mono else out


def dev_dither(x, p, ctx):
    return apply_dither(np.asarray(x, dtype=np.float64),
                        bits=p.at("bits"), noise_shape=p.at("noise_shape"),
                        seed=p.at("seed"), auto_blank=p.at("auto_blank"))


DEVICES = {
    "multibandCompressor": dev_multiband,
    "dynamicEq": dev_dyneq,
    "stereoImager": dev_imager,
    "tiltEq": dev_tilt,
    "maximizer": dev_maximizer,
    "exciter": dev_exciter,
    "dither": dev_dither,
}


# ═══════════════════════════════════════════════════════════════════════════
# ANALYSIS -- served as DATA. The UI draws; this module measures.
# ═══════════════════════════════════════════════════════════════════════════
#
# ANALYZE_SHAPE (frozen; master_test.py pins every key below)
#
# {
#   ok, ms, sr, source: "master"|"file", path?, file_sr?, resampled_from?,
#   start_sample, n_samples, seconds,
#
#   spectrum: {                    # the one curve pair an analyser draws
#     n_fft, hop, window: "hann", frames,
#     resolution_hz,               # sr/n_fft -- BELOW this the low bands are
#                                  # interpolated, and say so per band
#     ref: "dBFS mean-square; a full-scale sine reads -3.01",
#     hz:       [f0..fN]           # log-spaced centres, low -> high
#     avg_db:   [..]               # time-average of the band power
#     peak_db:  [..]               # peak-hold over the window
#     interpolated: [bool..]       # true where no FFT bin fell in the band
#   },
#
#   loudness: {
#     momentary: [[t_sec, lufs], ..]   # 400 ms window, 100 ms hop (LUFS-M)
#     short:     [[t_sec, lufs], ..]   # 3 s window,   100 ms hop (LUFS-S)
#     integrated: float|null,          # BS.1770-4 gated, null if silent
#     lra: float|null,                 # EBU Tech 3342, gated
#     true_peak_db: float,             # 4x oversampled
#     sample_peak_db: float,
#     rms_db: float
#   },
#
#   correlation: {
#     series: [[t_sec, r|null], ..],   # Pearson L/R per 100 ms
#     overall: float|null, min: float|null, max: float|null,
#     mono_compatible: bool|null,      # overall > 0.2 AND no window < -0.5
#     width: float|null,               # side_rms / mid_rms (ear.stereo_stats)
#     mid_rms_db, side_rms_db
#   },
#
#   goniometer: {
#     points: [[x, y], ..],            # x = (L-R)/sqrt2, y = (L+R)/sqrt2
#     n_total, slot, picked, axes
#   },
#
#   dynamics: {
#     crest_db, plr_db, psr_db,        # peak-RMS, TP-to-LUFS-I, median PSR
#     psr_series: [[t_sec, psr_db], ..]
#   },
#
#   bands: [ { lo, hi, label, name, rms_db, share_db, pink_db, delta_db } ]
#                                      # ear.py's nine bands, ear.py's pink null
#
#   device?: {                         # only when the call asked for a probe
#     type, params, ms,
#     before/after: { integrated, true_peak_db, sample_peak_db, rms_db,
#                     correlation },
#     net_db, gain_offset_db, gain_offset_param,
#     gr_series: [[t_sec, db|null], ..],   # per 10 ms, peak-referenced
#     gr_max_db, gr_avg_db                  # NEGATIVE dB = reduction
#   }
# }

SPECTRUM_FFT = 8192          # 5.86 Hz at 48k -- the low end needs it
SPECTRUM_HOP = 2048
SPECTRUM_BINS = 160          # log-spaced 20 Hz .. 20 kHz
GONIO_POINTS = 3000


def _db20(v, floor=1e-12):
    return 20.0 * math.log10(max(float(v), floor))


def _round_list(a, nd=2):
    return [None if not math.isfinite(float(v)) else round(float(v), nd) for v in a]


def log_spectrum(x, sr, n_fft=SPECTRUM_FFT, hop=SPECTRUM_HOP, n_bins=SPECTRUM_BINS,
                 lo=20.0, hi=20000.0):
    """Log-spaced averaged + peak-hold magnitude spectrum of (2,N).

    The per-bin power normalisation is ear.band_spectrogram's, to the letter
    (|X|^2 * 2/(sum(w^2)*N)), so a band here and a band there are the same
    number: summed over a band it IS that band's mean square, and a
    full-scale sine reads -3.01 dB. Channels are power-averaged.

    Log bands narrower than sr/n_fft contain no FFT bin at all. Those are
    INTERPOLATED from the neighbouring bins' per-Hz density and flagged,
    rather than reported as silence -- an analyser that draws -inf below
    60 Hz is a bug people chase for weeks."""
    a = np.asarray(x, dtype=np.float64)
    if a.ndim == 1:
        a = np.vstack([a, a])
    n = a.shape[1]
    if n < n_fft:
        a = np.pad(a, ((0, 0), (0, n_fft - n)))
        n = n_fft
    w = np.hanning(n_fft)
    wsum = float(np.sum(w ** 2))
    frames = 1 + (n - n_fft) // hop
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    hi = min(hi, sr * 0.5)
    edges = np.geomspace(lo, hi, n_bins + 1)
    centres = np.sqrt(edges[:-1] * edges[1:])
    idx = [np.where((freqs >= edges[i]) & (freqs < edges[i + 1]))[0]
           for i in range(n_bins)]
    interp = [len(i) == 0 for i in idx]
    any_interp = any(interp)
    acc = np.zeros(n_bins)
    peak = np.zeros(n_bins)
    scale = 2.0 / (wsum * n_fft)
    df = max(float(freqs[1] - freqs[0]), 1e-9)
    for f in range(frames):
        seg = a[:, f * hop: f * hop + n_fft] * w
        P = (np.abs(np.fft.rfft(seg, axis=1)) ** 2).mean(axis=0) * scale
        row = np.empty(n_bins)
        for i, ix in enumerate(idx):
            row[i] = float(P[ix].sum()) if len(ix) else 0.0
        if any_interp:
            dens = P / df
            for i, isi in enumerate(interp):
                if isi:
                    row[i] = float(np.interp(centres[i], freqs, dens)) * (edges[i + 1] - edges[i])
        acc += row
        peak = np.maximum(peak, row)
    acc /= max(frames, 1)
    return {
        "n_fft": int(n_fft), "hop": int(hop), "window": "hann",
        "frames": int(frames),
        "resolution_hz": round(sr / n_fft, 3),
        "ref": "dBFS mean-square; a full-scale sine reads -3.01",
        "hz": _round_list(centres, 2),
        "avg_db": _round_list(10.0 * np.log10(np.maximum(acc, 1e-20)), 2),
        "peak_db": _round_list(10.0 * np.log10(np.maximum(peak, 1e-20)), 2),
        "interpolated": [bool(v) for v in interp],
    }


def lra(x, sr, short_series=None):
    """EBU Tech 3342 loudness range, gated.

    Short-term (3 s) values at 100 ms, an absolute gate at -70 LUFS, then a
    RELATIVE gate 20 LU under the energy mean of what survived; LRA is the
    95th minus the 10th percentile of the rest. ear.py's `lufs_range` is the
    UNGATED percentile spread of a 1 s-hop series -- close, but not the
    standard's number, which is why this exists and says which is which."""
    R = _rack()
    if short_series is None:
        short_series = R._block_loudness(R.k_weight(np.asarray(x, dtype=np.float64), sr),
                                         sr, 3.0, 0.1)
    vals = np.array([l for _, l in short_series], dtype=np.float64)
    keep = vals > -70.0
    if keep.sum() < 3:
        return None
    z = 10.0 ** ((vals[keep] + 0.691) / 10.0)
    rel = -0.691 + 10.0 * math.log10(float(np.mean(z))) - 20.0
    kept = vals[keep][vals[keep] > rel]
    if len(kept) < 3:
        return None
    return float(np.percentile(kept, 95) - np.percentile(kept, 10))


def correlation_series(x, sr, win_s=0.1):
    """Pearson L/R per window, vectorised. A window with no signal in one
    channel reports None -- 'no signal' is not 'in phase' (ear.py's rule)."""
    a = np.asarray(x, dtype=np.float64)
    w = max(int(win_s * sr), 16)
    m = a.shape[1] // w
    if m < 1:
        return [], None
    L = a[0, :m * w].reshape(m, w)
    Rr = a[1, :m * w].reshape(m, w)
    Lc = L - L.mean(axis=1, keepdims=True)
    Rc = Rr - Rr.mean(axis=1, keepdims=True)
    num = (Lc * Rc).sum(axis=1)
    den = np.sqrt((Lc ** 2).sum(axis=1) * (Rc ** 2).sum(axis=1))
    r = np.where(den > 1e-18, num / np.maximum(den, 1e-18), np.nan)
    series = [[round(i * w / sr, 3), (None if not math.isfinite(v) else round(float(v), 4))]
              for i, v in enumerate(r)]
    live = r[np.isfinite(r)]
    return series, (live if live.size else None)


def goniometer(x, points=GONIO_POINTS):
    """The vectorscope cloud, decimated by MAX MAGNITUDE per slot, not by
    stride: a stride decimation of a 48 k stream throws away exactly the
    peaks the display exists to show."""
    a = np.asarray(x, dtype=np.float64)
    n = a.shape[1]
    base = {"n_total": int(n), "picked": "max-magnitude per slot",
            "axes": "x = (L-R)/sqrt2 (side), y = (L+R)/sqrt2 (mid)"}
    if n == 0:
        return {"points": [], "slot": 0, **base}
    slot = max(1, n // max(points, 1))
    m = n // slot
    if m < 1:
        m, slot = 1, n
    L = a[0, :m * slot].reshape(m, slot)
    Rr = a[1, :m * slot].reshape(m, slot)
    j = np.argmax(np.abs(L) + np.abs(Rr), axis=1)
    ar = np.arange(m)
    li, ri = L[ar, j], Rr[ar, j]
    root2 = math.sqrt(2.0)
    return {
        "points": [[round(float(v), 5), round(float(u), 5)]
                   for v, u in zip((li - ri) / root2, (li + ri) / root2)],
        "slot": int(slot), **base,
    }


def psr_series(x, sr, short_series):
    """Peak to Short-term loudness Ratio: the sample peak of each 3 s
    short-term window minus that window's LUFS-S. The dynamics number that
    survives loudness normalisation -- a squashed master reads under 8."""
    a = np.asarray(x, dtype=np.float64)
    win = int(3.0 * sr)
    out = []
    for t, l in short_series:
        i0 = int(round(t * sr))
        seg = a[:, i0:i0 + win]
        if seg.shape[1] < win // 2 or l <= -70.0:
            continue
        out.append([round(t, 3),
                    round(_db20(float(np.max(np.abs(seg))) if seg.size else 0.0) - l, 2)])
    return out


def band_energy(x, sr):
    """ear.py's nine bands and ear.py's pink null. Imported, not re-derived."""
    E = _ear()
    a = np.asarray(x, dtype=np.float64)
    mid = 0.5 * (a[0] + a[1])
    _, spec = E.band_spectrogram(mid, sr)
    power = spec.mean(axis=1)
    total = float(power.sum())
    share = 10.0 * np.log10(np.maximum(power / max(total, 1e-20), 1e-12))
    pink = E.pink_reference_db()
    rows = []
    for i, (lo, hi) in enumerate(E.BANDS):
        rows.append({
            "lo": lo, "hi": hi, "label": E.BAND_LABELS[i], "name": E.BAND_NAMES[i],
            "rms_db": round(10.0 * math.log10(max(float(power[i]), 1e-20)), 2),
            "share_db": round(float(share[i]), 2),
            "pink_db": round(float(pink[i]), 2),
            "delta_db": round(float(share[i] - pink[i]), 2),
        })
    return rows


def _loudness_block(x, sr):
    """Everything BS.1770 in one pass over the K-weighted signal, so the
    filter runs once rather than four times."""
    R = _rack()
    a = np.asarray(x, dtype=np.float64)
    kw = R.k_weight(a, sr)
    mom = R._block_loudness(kw, sr, 0.4, 0.1)
    sho = R._block_loudness(kw, sr, 3.0, 0.1)
    li = R.lufs_integrated(a, sr)
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(a)))) if a.size else 0.0
    lr = lra(a, sr, sho)
    return {
        "momentary": [[round(t, 3), round(l, 2)] for t, l in mom],
        "short": [[round(t, 3), round(l, 2)] for t, l in sho],
        "integrated": None if not math.isfinite(li) else round(li, 2),
        "lra": None if lr is None else round(lr, 2),
        "true_peak_db": round(R.true_peak_db(a), 2),
        "sample_peak_db": round(_db20(peak), 2),
        "rms_db": round(_db20(rms), 2),
    }, sho


def measure(x, sr, want_gonio=True):
    """The whole meter set for one buffer. analyze() and reference() share
    it, so a reference track and the master are measured identically."""
    a = np.asarray(x, dtype=np.float64)
    loud, sho = _loudness_block(a, sr)
    series, live = correlation_series(a, sr)
    st = _ear().stereo_stats(a)
    corr = st["correlation"]
    lo_corr = None if live is None else float(np.min(live))
    out = {
        "spectrum": log_spectrum(a, sr),
        "loudness": loud,
        "correlation": {
            "series": series,
            "overall": corr,
            "min": None if lo_corr is None else round(lo_corr, 4),
            "max": None if live is None else round(float(np.max(live)), 4),
            "mono_compatible": (None if corr is None else
                                bool(corr > 0.2 and (lo_corr is None or lo_corr > -0.5))),
            "width": st["width"],
            "mid_rms_db": st["mid_rms_db"],
            "side_rms_db": st["side_rms_db"],
        },
        "dynamics": {
            "crest_db": round(loud["sample_peak_db"] - loud["rms_db"], 2),
            "plr_db": (None if loud["integrated"] is None
                       else round(loud["true_peak_db"] - loud["integrated"], 2)),
            "psr_series": psr_series(a, sr, sho),
        },
        "bands": band_energy(a, sr),
    }
    ps = [v for _, v in out["dynamics"]["psr_series"]]
    out["dynamics"]["psr_db"] = round(float(np.median(ps)), 2) if ps else None
    if want_gonio:
        out["goniometer"] = goniometer(a)
    return out


# ───────────────────────────────────────────────────────── the buffer source


def _master_buffer(job, synths):
    """(y (2,N) float64, sr, info) for the window a job names: a FILE (a
    bounce, a reference track) or the live chain graph -- the SAME
    rack.chain_graph the render and the meters use, so what is measured is
    what the file will hold."""
    sr = int(job.get("sr") or 48000)
    path = job.get("file")
    if path:
        y, fsr = _ear().read_audio_stereo(path)
        info = {"source": "file", "path": str(path), "file_sr": int(fsr)}
        if int(fsr) != sr:
            # ear.py REFUSES to resample, because a resampled mix measurement
            # measures the resampler. A reference track is a different case:
            # it arrives at whatever rate its label mastered it, and the
            # K-weighting table is pinned at 48 k. So resample -- and say so
            # in the payload rather than quietly.
            g = math.gcd(int(sr), int(fsr))
            y = resample_poly(y, sr // g, int(fsr) // g, axis=1)
            info["resampled_from"] = int(fsr)
        w0 = max(int(job.get("start_sample") or 0), 0)
        n = int(job.get("n_samples") or 0) or (y.shape[1] - w0)
        y = y[:, w0:w0 + n]
        info["start_sample"] = w0
    else:
        mastered, _ = _rack().chain_graph(job, synths)
        w0 = int(job["start_sample"])
        n = int(job["n_samples"])
        y = mastered[:, w0:w0 + n]
        info = {"source": "master", "start_sample": w0}
    y = np.ascontiguousarray(np.asarray(y, dtype=np.float64))
    if y.ndim == 1:
        y = np.vstack([y, y])
    return y, sr, info


# ───────────────────────────────────────────────────────── the device probe


def _probe_device(y, sr, spec, ctx_extra=None):
    """Run ONE device over a buffer and report what it did -- the honest
    gain-reduction readout the maximizer's catalog entry points at.

    gr_* are NEGATIVE dB (reduction). `net_db` is the raw peak change; the
    device's own drive/makeup knob (GR_OFFSET_PARAM) is subtracted out of the
    GR series so a maximizer at +6 dB does not report +6 dB of 'reduction'."""
    R = _rack()
    dtype = str(spec.get("type") or "")
    if dtype not in R.DEVICES:
        raise ValueError(f"unknown device {dtype!r} -- this rack speaks {sorted(R.DEVICES)}")
    ctx = {"sr": sr, "spq": [[0.0, 0.5]], "dry": {}}
    if ctx_extra:
        ctx.update(ctx_extra)
    ins = [{"id": "probe", "type": dtype, "enabled": True, "params": spec.get("params") or {}}]
    t0 = time.perf_counter()
    out = R.run_chain(y, ins, ctx)
    ms = (time.perf_counter() - t0) * 1000.0
    p = R.Params(R.CATALOG[dtype], spec.get("params") or {}, sr)
    off_name = GR_OFFSET_PARAM.get(dtype)
    off_db = float(p.at(off_name)) if off_name else 0.0
    w = max(int(0.01 * sr), 16)
    m = min(y.shape[1], out.shape[1]) // w
    gr, finite = [], np.array([])
    if m:
        pin = np.abs(y[:, :m * w]).reshape(2, m, w).max(axis=2).max(axis=0)
        pout = np.abs(out[:, :m * w]).reshape(2, m, w).max(axis=2).max(axis=0)
        vals = np.where(pin > 1e-7,
                        20.0 * np.log10(np.maximum(pout, 1e-12) / np.maximum(pin, 1e-12)) - off_db,
                        np.nan)
        gr = [[round(i * w / sr, 3), (None if not math.isfinite(v) else round(float(v), 2))]
              for i, v in enumerate(vals)]
        finite = vals[np.isfinite(vals)]
    before, _ = _loudness_block(y, sr)
    after, _ = _loudness_block(out, sr)
    small = ("integrated", "true_peak_db", "sample_peak_db", "rms_db")
    E = _ear()
    return {
        "type": dtype, "params": spec.get("params") or {},
        "before": {**{k: before[k] for k in small},
                   "correlation": E.stereo_stats(y)["correlation"]},
        "after": {**{k: after[k] for k in small},
                  "correlation": E.stereo_stats(out)["correlation"]},
        "net_db": round(after["sample_peak_db"] - before["sample_peak_db"], 2),
        "gain_offset_db": round(off_db, 2),
        "gain_offset_param": off_name,
        "gr_series": gr,
        "gr_max_db": (round(float(np.min(finite)), 2) if finite.size else None),
        "gr_avg_db": (round(float(np.mean(finite)), 2) if finite.size else None),
        "ms": round(ms, 1),
    }


def analyze(job, synths):
    """MODES["analyze"] -- every meter the UI draws, in one payload."""
    t0 = time.perf_counter()
    y, sr, info = _master_buffer(job, synths)
    out = {"ok": True, "sr": sr, "n_samples": int(y.shape[1]),
           "seconds": round(y.shape[1] / sr, 4), **info}
    out.update(measure(y, sr, want_gonio=job.get("goniometer") is not False))
    dev = job.get("device")
    if isinstance(dev, dict) and dev.get("type"):
        out["device"] = _probe_device(y, sr, dev)
    out["ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
    return out


# ═══════════════════════════════════════════════════════════════════════════
# DEVICE RESPONSE -- the curve IS the filter
# ═══════════════════════════════════════════════════════════════════════════
#
# Every curve below is freqz() over the SAME coefficient tuples the device
# body runs. Where a device builds its coefficients inline (the rack's
# dev_eq), the section list is factored into one function that both the
# response and a re-measured sweep are checked against: master_test.py sweeps
# a real chirp through the real device and compares the measured transfer to
# this curve within 0.05 dB. A redrawn approximation would fail that.

RESPONSE_POINTS = 512


def response_freqs(sr, n=RESPONSE_POINTS, lo=20.0, hi=20000.0):
    return np.geomspace(lo, min(hi, sr * 0.5 * 0.999), n)


def cascade_db(sections, freqs, sr):
    """|H| in dB of a cascade of (b, a) pairs at the given frequencies."""
    h = np.ones(len(freqs), dtype=complex)
    for b, a in sections:
        _, hi = freqz(np.asarray(b, dtype=np.float64), np.asarray(a, dtype=np.float64),
                      worN=freqs, fs=sr)
        h = h * hi
    return h


def eq_sections(p, sr, t=0.0):
    """rack.dev_eq's section list, in the order dev_eq applies it, including
    its 'a flat band costs nothing' skip. The ONE description of that filter
    outside the device body; the sweep test binds the two together."""
    R = _rack()
    secs = []
    if p.at("hp_on", t):
        secs.append(R._rbj_pass(p.at("hp_hz", t), sr, "hp"))
    if p.at("lp_on", t):
        secs.append(R._rbj_pass(p.at("lp_hz", t), sr, "lp"))
    for i in (1, 2, 3, 4):
        g = f"b{i}_gain_db"
        if abs(p.at(g, t)) < 0.01 and not p.keyed(g):
            continue
        secs.append(R._rbj_peaking(p.at(f"b{i}_hz", t), p.at(f"b{i}_q", t),
                                   p.at(g, t), sr))
    return secs


def _sos_pairs(sos):
    return [(row[:3], row[3:]) for row in np.atleast_2d(sos)]


def _transfer_curve(kind, p, lo=-60.0, hi=0.0, n=121):
    """Output dB vs input dB for a dynamics device, computed by running the
    device's OWN gain computer over a static level sweep -- not a formula
    written twice."""
    x = np.linspace(lo, hi, n)
    if kind == "compressor":
        thr, ratio, knee = p.at("threshold_db"), p.at("ratio"), p.at("knee_db")
        mk = p.at("makeup_db")
        red = _soft_knee_reduction(x - thr, knee, 1.0 - 1.0 / max(ratio, 1.0))
        return x, x - red + mk
    if kind == "maximizer":
        g, ceil, knee = p.at("gain_db"), p.at("ceiling_db"), p.at("knee_db")
        driven = x + g
        over = driven - ceil
        if knee > 0.0:
            red = np.where(over <= -knee, 0.0,
                           np.where(over >= knee, over, (over + knee) ** 2 / (4.0 * knee)))
        else:
            red = np.maximum(over, 0.0)
        return x, np.minimum(driven - red, ceil)
    if kind == "limiter":
        ceil = p.at("ceiling_db")
        return x, np.minimum(x, ceil)
    if kind == "gate":
        thr, rng = p.at("threshold_db"), p.at("range_db")
        return x, np.where(x > thr, x, x + rng)
    return None, None


def device_response(job):
    """MODES["device_response"] -- one device instance's own curve.

    job: { type, params?, sr?, points? }
    ->   { ok, type, sr, hz: [...],
           magnitude_db: [...] | null, phase_deg: [...] | null,
           bands: [ { label, magnitude_db, ... } ]?,       # multiband devices
           transfer: { in_db, out_db }?,                   # dynamics devices
           source: "coefficients",
           none_reason?: "..." }                           # honest absence
    """
    t0 = time.perf_counter()
    R = _rack()
    kind = str(job.get("type") or "")
    if kind not in R.CATALOG:
        raise ValueError(f"unknown device {kind!r} -- this rack speaks {sorted(R.CATALOG)}")
    sr = int(job.get("sr") or 48000)
    n = min(max(int(job.get("points") or RESPONSE_POINTS), 32), 2048)
    p = R.Params(R.CATALOG[kind], job.get("params") or {}, sr)
    f = response_freqs(sr, n)
    out = {"ok": True, "type": kind, "sr": sr, "points": int(n),
           "hz": _round_list(f, 3), "source": "coefficients",
           "magnitude_db": None, "phase_deg": None}

    def emit(h):
        out["magnitude_db"] = _round_list(20.0 * np.log10(np.maximum(np.abs(h), 1e-12)), 3)
        out["phase_deg"] = _round_list(np.degrees(np.angle(h)), 2)

    if kind == "eq":
        secs = eq_sections(p, sr)
        emit(cascade_db(secs, f, sr) if secs else np.ones(n, dtype=complex))
        out["sections"] = len(secs)
        out["stereo_mode"] = p.at("stereo_mode")
    elif kind == "tiltEq":
        secs = tilt_sections(p, sr)
        emit(cascade_db(secs, f, sr) if secs else np.ones(n, dtype=complex))
        out["sections"] = len(secs)
    elif kind == "dynamicEq":
        # A dynamic band is FLAT at rest, so a rest curve alone would be a
        # blank display. Answer both: the rest curve (flat) and, per band,
        # the curve at FULL RANGE -- the reach of what that band can do.
        total = np.ones(n, dtype=complex)
        bands = []
        for i in (1, 2, 3, 4):
            if not p.at(f"d{i}_on"):
                continue
            sgn = -1.0 if p.at(f"d{i}_mode") == "above" else 1.0
            g = sgn * p.at(f"d{i}_range_db")
            b, a = peaking_from_bpf(p.at(f"d{i}_hz"), p.at(f"d{i}_q"), g, sr)
            h = cascade_db([(b, a)], f, sr)
            total = total * h
            bands.append({
                "index": i, "hz": round(p.at(f"d{i}_hz"), 2), "q": round(p.at(f"d{i}_q"), 3),
                "mode": p.at(f"d{i}_mode"), "range_db": round(p.at(f"d{i}_range_db"), 2),
                "threshold_db": round(p.at(f"d{i}_threshold_db"), 2),
                "magnitude_db": _round_list(20.0 * np.log10(np.maximum(np.abs(h), 1e-12)), 3),
            })
        emit(np.ones(n, dtype=complex))          # at rest a dynamic EQ is flat
        out["at_rest"] = True
        out["max_magnitude_db"] = _round_list(
            20.0 * np.log10(np.maximum(np.abs(total), 1e-12)), 3)
        out["bands"] = bands
    elif kind in ("multibandCompressor", "stereoImager"):
        if kind == "multibandCompressor":
            nb = int(p.at("bands"))
            xo = _xovers([p.at(f"x{i}_hz") for i in range(1, nb)], sr)
        else:
            nb = 3
            xo = _xovers([p.at("x1_hz"), p.at("x2_hz")], sr)
        bands = []
        total = np.zeros(n, dtype=complex)
        for i in range(nb):
            secs = []
            if i < len(xo):
                secs += _sos_pairs(lr4_sos(xo[i], sr, "lp"))
            if i > 0:
                for j in range(i):
                    secs += _sos_pairs(lr4_sos(xo[j], sr, "hp"))
            for j in range(i + 1, len(xo)):      # the allpass compensation
                secs += _sos_pairs(ap2_sos(xo[j], sr))
            h = cascade_db(secs, f, sr)
            total = total + h
            bands.append({
                "index": i + 1,
                "lo": round(xo[i - 1], 2) if i > 0 else 0.0,
                "hi": round(xo[i], 2) if i < len(xo) else round(sr / 2.0, 2),
                "magnitude_db": _round_list(20.0 * np.log10(np.maximum(np.abs(h), 1e-12)), 3),
            })
        emit(total)                              # the SUM: flat, by construction
        out["bands"] = bands
        out["crossovers_hz"] = [round(v, 2) for v in xo]
        out["note"] = ("magnitude_db is the SUM of the bands at unity -- flat "
                       "to the float floor, which is the crossover's whole claim.")
    elif kind == "exciter":
        emit(cascade_db(_sos_pairs(lr4_sos(p.at("freq_hz"), sr, "hp")), f, sr))
        out["note"] = ("the curve is the band SELECTOR, not the device: the "
                       "harmonics an exciter adds are not a linear response "
                       "and no frequency curve can draw them.")
    else:
        out["none_reason"] = (
            f"{kind} has no linear frequency response to draw "
            "(it is a dynamics, time or level device)."
            if kind not in ("dither",) else
            "dither is a quantiser plus noise; its spectrum is in "
            "daw_analyze, not in a filter curve.")
    xi, yo = _transfer_curve(kind, p)
    if xi is not None:
        out["transfer"] = {"in_db": _round_list(xi, 2), "out_db": _round_list(yo, 2),
                           "note": "static gain computer, attack/release excluded"}
    out["ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
    return out


# ═══════════════════════════════════════════════════════════════════════════
# REFERENCE A/B -- mastering is comparative
# ═══════════════════════════════════════════════════════════════════════════


def reference(job, synths):
    """MODES["reference"] -- a library track, loudness-matched to the project.

    job: { ...the master job..., reference: "<server-local audio path>",
           match: "lufs" | "off" }
    The reference is measured, then GAINED so its integrated LUFS equals the
    project's, and re-measured. The applied gain is reported, because a
    spectrum comparison at two different loudnesses is a comparison of two
    different loudnesses -- everything sounds better louder, including a
    worse master.
    """
    t0 = time.perf_counter()
    mine, sr, info = _master_buffer(job, synths)
    ref_path = job.get("reference") or job.get("reference_file")
    if not ref_path:
        raise ValueError("reference: give `reference` -- a server-local audio file to compare against.")
    ref_job = {"sr": sr, "file": ref_path,
               "start_sample": int(job.get("reference_start_sample") or 0),
               "n_samples": int(job.get("reference_n_samples") or 0)}
    ref, _, rinfo = _master_buffer(ref_job, synths)
    mine_m = measure(mine, sr)
    ref_raw = _loudness_block(ref, sr)[0]
    gain_db = 0.0
    matched = ref
    if str(job.get("match") or "lufs") == "lufs":
        a, b = mine_m["loudness"]["integrated"], ref_raw["integrated"]
        if a is None or b is None:
            gain_db = 0.0
        else:
            gain_db = float(a) - float(b)
            matched = ref * _rack().db_to_lin(gain_db)
    ref_m = measure(matched, sr)
    return {
        "ok": True, "sr": sr, **info,
        "project": {"n_samples": int(mine.shape[1]),
                    "seconds": round(mine.shape[1] / sr, 4), **mine_m},
        "reference": {"path": str(ref_path), **rinfo,
                      "n_samples": int(ref.shape[1]),
                      "seconds": round(ref.shape[1] / sr, 4),
                      "unmatched_lufs": ref_raw["integrated"],
                      "unmatched_true_peak_db": ref_raw["true_peak_db"],
                      **ref_m},
        "match": {
            "mode": str(job.get("match") or "lufs"),
            "applied_gain_db": round(gain_db, 2),
            "note": ("the reference was gained by this much so both spectra "
                     "are read at the project's integrated loudness; the "
                     "reference's OWN loudness is unmatched_lufs."),
        },
        "delta_bands_db": [
            round(float(p["share_db"] - r["share_db"]), 2)
            for p, r in zip(mine_m["bands"], ref_m["bands"])
        ],
        "ms": round((time.perf_counter() - t0) * 1000.0, 1),
    }


# ═══════════════════════════════════════════════════════════════════════════
# DELIVERY TARGETS
# ═══════════════════════════════════════════════════════════════════════════
#
# SOURCING, and the honest bit first: these numbers are the platforms' own
# published guidance as of this file's writing (2026-08), EXCEPT where
# `confidence` says otherwise. Streaming services change normalisation
# silently and without changelogs. `confidence` is one of:
#
#   published  the platform states this number in its own artist/mastering
#              documentation, or it is a formal standard.
#   measured   the platform does NOT publish a target; the number is the
#              community's measured playback normalisation and is widely
#              reproduced. Treat as approximately right, not as a spec.
#   uncertain  known to have changed, or never clearly stated. Reported so
#              the table is complete, flagged so nobody plans a master on it.
#
# The ONE number here that is a genuine standard rather than a service
# policy is ebu_r128 (EBU R 128 / ITU-R BS.1770-4: -23 LUFS +/-0.5 LU,
# -1 dBTP) -- the same recommendation this whole metering stack implements.
#
# Deliberately NOT invented: per-platform tolerances beyond +/-1 LU (nobody
# publishes them), codec-specific ceilings per bitrate, and any claim about
# what a platform does to a track quieter than its target.

DELIVERY_TARGETS = [
    {
        "id": "spotify", "label": "Spotify",
        "lufs": -14.0, "tolerance_lu": 1.0, "true_peak_db": -1.0,
        "confidence": "published",
        "source": "Spotify for Artists / Spotify Loudness Normalization help page",
        "note": "Spotify normalises on playback. The -1 dBTP ceiling is their "
                "stated requirement for masters louder than -14 LUFS; a "
                "quieter master is turned UP and the ceiling matters more, "
                "not less.",
    },
    {
        "id": "apple_music", "label": "Apple Music (Sound Check)",
        "lufs": -16.0, "tolerance_lu": 1.0, "true_peak_db": -1.0,
        "confidence": "published",
        "source": "Apple Digital Masters technical guidance (-1 dBTP); the "
                  "-16 LUFS figure is Sound Check's normalisation level",
        "note": "The -1 dBTP is Apple's own written requirement (it protects "
                "the lossy encode). The -16 LUFS is the Sound Check target, "
                "which Apple describes rather than specifies.",
    },
    {
        "id": "youtube", "label": "YouTube / YouTube Music",
        "lufs": -14.0, "tolerance_lu": 1.0, "true_peak_db": -1.0,
        "confidence": "measured",
        "source": "no published target; -14 LUFS is the widely measured "
                  "playback normalisation",
        "note": "YouTube publishes no loudness spec. -14 LUFS is what the "
                "player is measured to normalise to; the -1 dBTP is general "
                "lossy-codec headroom practice, not a YouTube rule.",
    },
    {
        "id": "tidal", "label": "TIDAL",
        "lufs": -14.0, "tolerance_lu": 1.0, "true_peak_db": -1.0,
        "confidence": "published",
        "source": "TIDAL loudness normalisation documentation",
        "note": "TIDAL normalises to -14 LUFS with ReplayGain-style metadata.",
    },
    {
        "id": "amazon_music", "label": "Amazon Music",
        "lufs": -14.0, "tolerance_lu": 1.0, "true_peak_db": -2.0,
        "confidence": "published",
        "source": "Amazon Music for Artists mastering guidance",
        "note": "Amazon asks for a LOWER ceiling than the others (-2 dBTP). "
                "If you deliver one master everywhere, -2 dBTP satisfies all "
                "of these targets and -1 does not satisfy this one.",
    },
    {
        "id": "deezer", "label": "Deezer",
        "lufs": -15.0, "tolerance_lu": 1.0, "true_peak_db": -1.0,
        "confidence": "published",
        "source": "Deezer loudness normalisation documentation",
        "note": "Deezer sits one LU under the -14 crowd.",
    },
    {
        "id": "soundcloud", "label": "SoundCloud",
        "lufs": -14.0, "tolerance_lu": 2.0, "true_peak_db": -1.0,
        "confidence": "uncertain",
        "source": "not published; SoundCloud's normalisation behaviour has "
                  "changed more than once",
        "note": "UNCERTAIN. Included for completeness. Do not plan a master "
                "around this row -- verify against SoundCloud's current "
                "behaviour first.",
    },
    {
        "id": "ebu_r128", "label": "EBU R 128 (broadcast)",
        "lufs": -23.0, "tolerance_lu": 0.5, "true_peak_db": -1.0,
        "confidence": "published",
        "source": "EBU R 128 / ITU-R BS.1770-4 -- a formal standard, not a "
                  "service policy",
        "note": "The one row here that is a standard. If the deliverable is "
                "for television or radio, this is the target and the "
                "tolerance really is +/-0.5 LU.",
    },
    {
        "id": "aes_streaming", "label": "AES streaming recommendation",
        "lufs": -18.0, "tolerance_lu": 2.0, "true_peak_db": -1.0,
        "confidence": "published",
        "source": "AES TD1004.1.15-10, which recommends a -16 to -20 LUFS "
                  "range; -18 is its midpoint",
        "note": "A recommendation for streaming delivery generally, not a "
                "single platform. The tolerance here IS the published range.",
    },
]


def delivery_targets():
    return {
        "targets": DELIVERY_TARGETS,
        "caveat": ("Platform normalisation changes without notice and most "
                   "platforms publish no tolerance at all. Every row carries "
                   "`confidence` and `source`; check the row's own source "
                   "before a master is delivered on the strength of it."),
        "as_of": "2026-08",
    }


def check_delivery(job, synths):
    """MODES["check_delivery"] -- PASS/FAIL per target, with the exact move.

    For each target: the gain that lands the integrated LUFS on the target,
    and whether that gain would push the true peak past the ceiling. When it
    would, the report says so and gives the shortfall in dB -- because "turn
    it up 3 dB" is wrong advice if 3 dB of true peak is not there, and the
    honest answer is "you need 2.1 dB of limiting to get the rest".
    """
    t0 = time.perf_counter()
    y, sr, info = _master_buffer(job, synths)
    loud, _ = _loudness_block(y, sr)
    li, tp = loud["integrated"], loud["true_peak_db"]
    rows = []
    only = set(job.get("targets") or [])
    for t in DELIVERY_TARGETS:
        if only and t["id"] not in only:
            continue
        row = {k: t[k] for k in ("id", "label", "lufs", "tolerance_lu",
                                 "true_peak_db", "confidence", "source", "note")}
        row["measured_lufs"] = li
        row["measured_true_peak_db"] = tp
        if li is None:
            row.update(lufs_pass=None, true_peak_pass=tp <= t["true_peak_db"] + 1e-9,
                       gain_change_db=None, verdict="silent",
                       advice="This window measures as silence -- nothing to deliver.")
            rows.append(row)
            continue
        delta = float(t["lufs"]) - float(li)
        row["lufs_delta_lu"] = round(delta, 2)
        row["gain_change_db"] = round(delta, 2)
        row["lufs_pass"] = bool(abs(delta) <= t["tolerance_lu"] + 1e-9)
        row["true_peak_pass"] = bool(tp <= t["true_peak_db"] + 1e-9)
        tp_after = tp + delta
        row["true_peak_after_gain_db"] = round(tp_after, 2)
        headroom = float(t["true_peak_db"]) - tp_after
        row["headroom_after_gain_db"] = round(headroom, 2)
        row["limiting_needed_db"] = round(max(-headroom, 0.0), 2)
        row["pass"] = bool(row["lufs_pass"] and row["true_peak_pass"])
        if row["pass"]:
            row["verdict"] = "pass"
            row["advice"] = "Within tolerance and under the ceiling. Deliver."
        elif not row["true_peak_pass"]:
            row["verdict"] = "true-peak over"
            row["advice"] = (f"True peak is {round(tp - t['true_peak_db'], 2)} dB over the "
                             f"{t['true_peak_db']} dBTP ceiling. Lower the maximizer's "
                             "ceiling; gain alone cannot fix this.")
        elif headroom < 0:
            row["verdict"] = "loudness short, no headroom"
            row["advice"] = (f"{round(delta, 2)} dB of gain would reach {t['lufs']} LUFS but "
                             f"put true peak at {round(tp_after, 2)} dBTP. About "
                             f"{round(-headroom, 2)} dB of that has to come from limiting, "
                             "not from the fader.")
        else:
            row["verdict"] = "loudness off"
            row["advice"] = (f"{'Raise' if delta > 0 else 'Lower'} the master by "
                             f"{round(abs(delta), 2)} dB; true peak lands at "
                             f"{round(tp_after, 2)} dBTP, still under the ceiling.")
        rows.append(row)
    return {
        "ok": True, "sr": sr, **info,
        "n_samples": int(y.shape[1]), "seconds": round(y.shape[1] / sr, 4),
        "measured": {"lufs": li, "true_peak_db": tp,
                     "sample_peak_db": loud["sample_peak_db"],
                     "lra": loud["lra"], "rms_db": loud["rms_db"]},
        "results": rows,
        "as_of": delivery_targets()["as_of"],
        "caveat": delivery_targets()["caveat"],
        "ms": round((time.perf_counter() - t0) * 1000.0, 1),
    }


# ═══════════════════════════════════════════════════════════════════════════
# BOUNCE WIRING -- where dither is supposed to be called
# ═══════════════════════════════════════════════════════════════════════════
#
# apply_dither() above is the export-time function. The bit-depth reduction
# in this repo happens in ONE place:
#
#     server/daw/instruments.py :: _cli_encode()   ->  sf.write(..., subtype)
#
# and that function now takes `bit_depth` (16 or 24) and `dither`, calling
# master.apply_dither() before the write whenever the depth is under 24. The
# route that builds that job is
#
#     server/daw/routes.js :: case "bounce"  ->  runInstruments("encode", {...})
#
# which is owned by another agent, so it is NOT edited here. ONE LINE is
# needed there to expose the option to a caller:
#
#     const enc = await runInstruments("encode", {
#       sr: doc.sr, wav_parts: parts, out,
#       bit_depth: b.bit_depth,          // <-- ADD THIS LINE
#     }, 300_000);
#
# Without it the bounce stays 24-bit (the current behaviour, unchanged, and
# 24-bit needs no dither); with it a 16-bit bounce dithers by default and a
# caller must pass dither:false to get the mastering fault.


def engine_modes(synths):
    """The four modes engine.py registers. One line there, this table here."""
    return {
        "analyze": lambda job: analyze(job, synths),
        "device_response": device_response,
        "reference": lambda job: reference(job, synths),
        "check_delivery": lambda job: check_delivery(job, synths),
        "delivery_targets": lambda job: {"ok": True, **delivery_targets()},
    }
