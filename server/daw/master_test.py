# -*- coding: utf-8 -*-
"""DAW mastering suite -- every claim proven by arithmetic, never by ear.

What this suite is for. A mastering device that is subtly wrong sounds fine
and ruins masters quietly; the only defence is to state each device's claim as
a number and measure it. The claims:

  REGISTRATION  the seven new devices and the two new stereo_mode params are
                in the catalog with label/why/range/default like the nine,
                and BYPASS is still a bit-exact passthrough.
  CROSSOVER     LR4's LP+HP IS a second-order allpass (measured against the
                closed form to 1e-12), so the bands sum back to the input
                through a magnitude-flat allpass -- asserted twice, in the
                time domain against the allpass reference and in the
                frequency domain against unity.
  MID/SIDE      the encode/decode round trip is BIT-EXACT on float32-sourced
                audio and within one ulp on adversarial float64; an M/S EQ
                moves the sides and leaves the centre alone.
  MULTIBAND     a band ducks ITS OWN band and leaves the others where they
                were, to a fraction of a dB.
  DYNAMIC EQ    flat until the band misbehaves; y = x + (A-1)*BPF(x) is
                exactly the peaking filter peaking_from_bpf() draws.
  IMAGER        the correlation change is MEASURED, in both directions.
  TILT          monotone in the knob, and the pivot does not move.
  MAXIMIZER     the true-peak ceiling holds under a slammed input, at every
                character, measured at 4x oversampling.
  EXCITER       harmonics land where the blend says, and the 21 kHz alias a
                naive generator would fold back is 40 dB down.
  DITHER        a -100 dBFS tone SURVIVES a 16-bit reduction with dither and
                is destroyed without it; the shaped floor really is shaped.
  ANALYZE       a known sine lands in the right log bin at the right level;
                the payload has every key the UI seam promises.
  RESPONSE      device_response matches the device's MEASURED impulse
                response -- the curve is the filter, not a picture of it.
  DELIVERY      the gain advice is arithmetic, and it refuses to pretend
                gain can buy headroom that is not there.
  CPU           every device timed on a 4-bar region and reported.

Run:  python server/daw/master_test.py       (rig venv: numpy + scipy)
"""
import json
import math
import os
import struct
import sys
import tempfile
import time

import numpy as np
from scipy.signal import freqz

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engine   # noqa: E402
import master   # noqa: E402
import rack     # noqa: E402

SR = 48000

passed = 0
failures = []


def ok(label, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok    {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def near(a, b, eps):
    return abs(a - b) <= eps


def ctx(**kw):
    base = {"sr": SR, "spq": [[0.0, 0.5]], "dry": {}}
    base.update(kw)
    return base


def dev(x, dtype, params=None, enabled=True, c=None):
    ins = [{"id": "i", "type": dtype, "enabled": enabled, "params": params or {}}]
    return rack.run_chain(x, ins, c or ctx())


def sine(f, secs, amp=0.5, sr=SR, phase=0.0):
    t = np.arange(int(secs * sr)) / sr
    return np.sin(2 * np.pi * f * t + phase) * amp


def stereo(mono):
    return np.vstack([mono, mono])


def db(x):
    return 20.0 * math.log10(max(float(x), 1e-12))


def fft_mag_db(x, f, sr=SR):
    """Magnitude at one frequency, Hann-windowed, normalised so a full-scale
    sine reads 0 dB."""
    n = len(x)
    w = np.hanning(n)
    X = np.fft.rfft(x * w)
    k = int(round(f * n / sr))
    band = np.abs(X[max(k - 2, 0):k + 3])
    return db(float(band.max()) * 2.0 / float(np.sum(w)))


def impulse_response_db(fn, freqs, n=131072):
    """Measure a device's ACTUAL magnitude response: a unit impulse in, the
    rfft of what comes out. For an LTI device from zero state this IS
    H(e^jw), with no windowing, no estimator and no assumption."""
    imp = np.zeros((2, n))
    imp[:, 0] = 1.0
    y = fn(imp)
    H = np.fft.rfft(y[0])
    bins = np.fft.rfftfreq(n, 1.0 / SR)
    k = np.searchsorted(bins, freqs)
    k = np.clip(k, 0, len(bins) - 1)
    return 20.0 * np.log10(np.maximum(np.abs(H[k]), 1e-12)), bins[k]


NEW = ["multibandCompressor", "dynamicEq", "stereoImager", "tiltEq",
       "maximizer", "exciter", "dither"]


# ═══════════════════════════════ 1. REGISTRATION ═══════════════════════════

print("\n  -- the suite is IN the catalog, on the catalog's own terms --")
ok("all seven devices registered into rack.DEVICES and rack.CATALOG",
   all(d in rack.DEVICES and d in rack.CATALOG for d in NEW),
   ", ".join(d for d in NEW if d not in rack.DEVICES))
ok("catalog and devices are still one list",
   sorted(rack.DEVICES) == sorted(rack.CATALOG))
bad = [f"{d}.{p}" for d in NEW for p, v in rack.CATALOG[d]["params"].items()
       if v.get("type") == "number" and not (v["min"] <= v["default"] <= v["max"])]
ok("every numeric default sits inside its own range", not bad, ", ".join(bad))
bad = [d for d in NEW if not (rack.CATALOG[d].get("why") and rack.CATALOG[d].get("label")
                              and "stateful" in rack.CATALOG[d])]
ok("every new device carries label, why and stateful", not bad, ", ".join(bad))
bad = [f"{d}.{p}" for d in NEW for p, v in rack.CATALOG[d]["params"].items()
       if not v.get("desc")]
ok("every new parameter says what it is for", not bad, ", ".join(bad))
kinds = {v["type"] for d in NEW for v in rack.CATALOG[d]["params"].values()}
ok(f"only the catalog's existing parameter TYPES are used ({', '.join(sorted(kinds))})",
   kinds <= {"number", "bool", "enum"},
   "a new type would need a new UI control and fails the sibling's ui_test")
for d in ("eq", "compressor"):
    sp = rack.CATALOG[d]["params"].get("stereo_mode")
    ok(f"{d} gained stereo_mode, default stereo",
       sp and sp["type"] == "enum" and sp["default"] == "stereo"
       and sp["values"] == ["stereo", "mid_side", "mid", "side"])

print("\n  -- bypass is still a bit-exact passthrough, per new device --")
x0 = stereo(sine(440, 1.0, 0.5) + sine(1330, 1.0, 0.2))
for d in NEW:
    y = dev(x0, d, {}, enabled=False)
    ok(f"{d} bypass", y is x0 or np.array_equal(y, x0))

print("\n  -- determinism: same input + params -> byte-identical output --")
work = {
    "multibandCompressor": {"b1_threshold_db": -40, "b2_threshold_db": -40},
    "dynamicEq": {"d1_on": True, "d3_on": True, "d1_threshold_db": -50},
    "stereoImager": {"w1_width": 0.2, "w3_width": 1.8},
    "tiltEq": {"tilt_db": 5.0},
    "maximizer": {"gain_db": 12.0},
    "exciter": {"drive_db": 20.0},
    "dither": {"bits": 16},
}
for d in NEW:
    a = dev(x0, d, work[d])
    b = dev(x0, d, work[d])
    ok(f"{d} is deterministic", np.array_equal(a, b))
# The dither's noise is a PREFIX of one seeded stream: a shorter render must
# agree sample for sample with the head of a longer one, or a region render
# and a full render would differ (the rack's seam rule).
short = master.tpdf_noise(1000, 7)
long_ = master.tpdf_noise(5000, 7)
ok("dither noise is a stream prefix (region render == head of a full render)",
   np.array_equal(short, long_[:, :1000]))
ok("...and a different seed is a different stream",
   not np.array_equal(master.tpdf_noise(1000, 8), short))


# ═══════════════════════════ 2. THE CROSSOVER ══════════════════════════════

print("\n  -- Linkwitz-Riley: LP4 + HP4 IS a second-order allpass --")
fq = np.geomspace(20.0, 23000.0, 500)


def cas(sos):
    H = np.ones(len(fq), dtype=complex)
    for row in np.atleast_2d(sos):
        _, h = freqz(row[:3], row[3:], worN=fq, fs=SR)
        H = H * h
    return H


worst_ap, worst_sum = 0.0, 0.0
for fc in (60.0, 120.0, 900.0, 5000.0, 12000.0):
    row = master.ap2_sos(fc, SR)
    _, hap = freqz(row[:3], row[3:], worN=fq, fs=SR)
    worst_ap = max(worst_ap, float(np.max(np.abs(20 * np.log10(np.abs(hap))))))
    s = cas(master.lr4_sos(fc, SR, "lp")) + cas(master.lr4_sos(fc, SR, "hp"))
    worst_sum = max(worst_sum, float(np.max(np.abs(s - hap))))
ok(f"the allpass really is allpass (worst |H| deviation {worst_ap:.2e} dB)",
   worst_ap < 1e-9)
ok(f"LP4 + HP4 == reverse(a)/a at every crossover (worst {worst_sum:.2e})",
   worst_sum < 1e-9)

print("\n  -- ...so the band tree RECONSTRUCTS --")
rng = np.random.default_rng(11)
noise = np.vstack([rng.standard_normal(SR) * 0.2, rng.standard_normal(SR) * 0.2])
for xo in ([120.0], [120.0, 900.0], [120.0, 900.0, 5000.0]):
    bands = master.lr_split(noise, xo, SR)
    summed = sum(bands)
    ref = master.lr_reference(noise, xo, SR)
    err = float(np.max(np.abs(summed - ref)))
    ok(f"{len(xo) + 1} bands sum to the allpass reference (max {err:.2e})", err < 1e-10)
    # ...and the allpass chain is unity magnitude, so the reconstruction is
    # exact in MAGNITUDE -- which is what phase-coherent buys you.
    H = np.ones(len(fq), dtype=complex)
    for f in xo:
        H = H * cas(master.ap2_sos(f, SR))
    dev_db = float(np.max(np.abs(20 * np.log10(np.abs(H)))))
    ok(f"   ...and that reference is magnitude-flat to {dev_db:.2e} dB", dev_db < 0.001)

# A device-level statement of the same thing: every band at unity, no
# compression anywhere, and the output measures like the input.
mb_flat = dev(noise, "multibandCompressor",
              {"bands": "4", "b1_bypass": True, "b2_bypass": True,
               "b3_bypass": True, "b4_bypass": True})
ref4 = master.lr_reference(noise, master._xovers([120.0, 900.0, 5000.0], SR), SR)
ok(f"multiband at unity == the allpass of its input ({float(np.max(np.abs(mb_flat - ref4))):.2e})",
   float(np.max(np.abs(mb_flat - ref4))) < 1e-10)
ok("...and it has the same RMS as the input (nothing was gained or lost)",
   near(db(np.sqrt(np.mean(mb_flat ** 2))), db(np.sqrt(np.mean(noise ** 2))), 0.01))


# ═══════════════════════════ 3. MID / SIDE ═════════════════════════════════

print("\n  -- mid/side is exact where it can be, and says where it cannot --")
f32 = (rng.standard_normal((2, 20000)) * 0.3).astype(np.float32).astype(np.float64)
rt = master.ms_decode(master.ms_encode(f32))
ok("float32-sourced audio (the instrument stage's contract) round-trips BIT-EXACT",
   np.array_equal(rt, f32))
f64 = rng.standard_normal((2, 20000))
rt2 = master.ms_decode(master.ms_encode(f64))
err64 = float(np.max(np.abs(rt2 - f64)))
scale = float(np.spacing(np.abs(f64).max()))
ok(f"adversarial float64 round-trips within one ulp ({err64:.2e} vs ulp {scale:.2e})",
   err64 <= scale)
ok("mono in, mono out: side is exactly zero",
   float(np.max(np.abs(master.ms_encode(stereo(sine(440, 0.5)))[1]))) == 0.0)

print("\n  -- an M/S EQ moves the SIDES and leaves the CENTRE alone --")
# Centre: a 500 Hz sine in both channels. Sides: a 3 kHz sine, out of phase.
centre = sine(500, 2.0, 0.3)
sides = sine(3000, 2.0, 0.3)
ms_in = np.vstack([centre + sides, centre - sides])
mid_before = 0.5 * (ms_in[0] + ms_in[1])
side_before = 0.5 * (ms_in[0] - ms_in[1])
cut = {"b3_hz": 3000, "b3_gain_db": -12, "b3_q": 2.0}
y_side = dev(ms_in, "eq", {**cut, "stereo_mode": "side"})
d_side = fft_mag_db(0.5 * (y_side[0] - y_side[1]), 3000) - fft_mag_db(side_before, 3000)
ok(f"mode `side`: the side 3 kHz dropped {d_side:.2f} dB (asked for -12)",
   near(d_side, -12.0, 1.5))
# "Untouched" means untouched to the M/S round trip's own floor -- one ulp.
# It is NOT bit-equal, and claiming it would be would be a lie about IEEE
# arithmetic: the decode re-adds M to a filtered S and rounds once.
mid_after = 0.5 * (y_side[0] + y_side[1])
mid_err = float(np.max(np.abs(mid_after - mid_before)))
ok(f"...and the CENTRE is untouched to the round trip's floor "
   f"({mid_err:.2e}, ulp {float(np.spacing(np.abs(mid_before).max())):.2e})",
   mid_err <= float(np.spacing(np.abs(mid_before).max())))
y_mid = dev(ms_in, "eq", {**cut, "stereo_mode": "mid"})
side_err = float(np.max(np.abs(0.5 * (y_mid[0] - y_mid[1]) - side_before)))
ok(f"mode `mid` is the mirror: the SIDES survive to the same floor ({side_err:.2e})",
   side_err <= float(np.spacing(np.abs(side_before).max())))
ok("...and they are genuinely different edits from each other",
   not np.allclose(y_mid, y_side, atol=1e-6))

# THE HONEST FOOTNOTE, asserted rather than buried. An EQ is LINEAR, so
# filtering M and S with one setting is algebraically the same as filtering
# L and R with it: `mid_side` on the EQ is `stereo` with extra arithmetic.
# It earns its keep on the COMPRESSOR, where the detector is per-component
# and the two modes really do part company.
y_ms = dev(ms_in, "eq", {**cut, "stereo_mode": "mid_side"})
y_lr = dev(ms_in, "eq", cut)
ok(f"on a LINEAR device, mid_side == stereo by algebra "
   f"({float(np.max(np.abs(y_ms - y_lr))):.2e}) -- the useful EQ modes are mid and side",
   np.allclose(y_ms, y_lr, atol=1e-12))
comp_ms = dev(ms_in, "compressor", {"stereo_mode": "mid_side", "threshold_db": -30, "ratio": 6})
comp_lr = dev(ms_in, "compressor", {"threshold_db": -30, "ratio": 6})
ok(f"on the COMPRESSOR it does not: mid_side and stereo differ by "
   f"{db(float(np.max(np.abs(comp_ms - comp_lr)))):.1f} dB of peak difference",
   not np.allclose(comp_ms, comp_lr, atol=1e-4))
ok("stereo_mode defaults to a byte-identical call to the original device",
   np.array_equal(dev(ms_in, "eq", {"b2_gain_db": 4.0}),
                  rack.dev_eq(ms_in, rack.Params(rack.CATALOG["eq"], {"b2_gain_db": 4.0}, SR),
                              ctx())))
# The compressor's M/S mode detects mid and side INDEPENDENTLY.
loud_mid = np.vstack([sine(200, 2.0, 0.8) + sine(3000, 2.0, 0.02),
                      sine(200, 2.0, 0.8) - sine(3000, 2.0, 0.02)])
cms = dev(loud_mid, "compressor",
          {"stereo_mode": "mid_side", "threshold_db": -12, "ratio": 8, "makeup_db": 0})
s_in = 0.5 * (loud_mid[0] - loud_mid[1])
s_out = 0.5 * (cms[0] - cms[1])
ok(f"a loud CENTRE does not squash a quiet SIDE in M/S mode "
   f"({fft_mag_db(s_out, 3000) - fft_mag_db(s_in, 3000):+.2f} dB)",
   abs(fft_mag_db(s_out, 3000) - fft_mag_db(s_in, 3000)) < 0.5)


# ═══════════════════════════ 4. MULTIBAND ══════════════════════════════════

print("\n  -- the multiband ducks ITS band and leaves the others where they were --")
probe = stereo(sine(60, 3.0, 0.6) + sine(2000, 3.0, 0.2) + sine(9000, 3.0, 0.2))
mb = dev(probe, "multibandCompressor",
         {"bands": "3", "x1_hz": 200, "x2_hz": 4000,
          "b1_threshold_db": -30, "b1_ratio": 10, "b1_attack_ms": 5, "b1_release_ms": 50,
          "b2_threshold_db": 0.0, "b2_ratio": 1.0,
          "b3_threshold_db": 0.0, "b3_ratio": 1.0})
d60 = fft_mag_db(mb[0], 60) - fft_mag_db(probe[0], 60)
d2k = fft_mag_db(mb[0], 2000) - fft_mag_db(probe[0], 2000)
d9k = fft_mag_db(mb[0], 9000) - fft_mag_db(probe[0], 9000)
ok(f"the 60 Hz band came down {d60:.2f} dB", d60 < -6.0)
ok(f"...and 2 kHz moved {d2k:+.3f} dB", abs(d2k) < 0.3)
ok(f"...and 9 kHz moved {d9k:+.3f} dB", abs(d9k) < 0.3)
solo = dev(probe, "multibandCompressor",
           {"bands": "3", "x1_hz": 200, "x2_hz": 4000, "b1_solo": True,
            "b1_threshold_db": 0.0, "b1_ratio": 1.0})
ok(f"solo on band 1 leaves 60 Hz ({fft_mag_db(solo[0], 60):.1f} dB) and kills 9 kHz "
   f"({fft_mag_db(solo[0], 9000):.1f} dB)",
   fft_mag_db(solo[0], 60) > -20 and fft_mag_db(solo[0], 9000) < -50)
mk = dev(probe, "multibandCompressor",
         {"bands": "2", "x1_hz": 200, "b1_bypass": True, "b2_bypass": True})
mk6 = dev(probe, "multibandCompressor",
          {"bands": "2", "x1_hz": 200, "b1_bypass": True, "b2_bypass": True,
           "b1_makeup_db": 6.0})
ok("a bypassed band ignores its own makeup (bypass means bypass)",
   np.array_equal(mk, mk6))
# The band gain computer IS the channel strip's, so a one-band multiband and
# the rack's own compressor must agree on the same signal. x1_hz maxes at
# 1000 Hz (the catalog clamps -- and clamped this test the first time it ran,
# splitting a 400 Hz tone across two bands and costing 0.75 dB), so the probe
# tone sits at 100 Hz where LP4(1000) is unity and HP4(1000) is 80 dB down.
burst = stereo(np.concatenate([sine(100, 1.0, 0.7), sine(100, 1.0, 0.05)]))
one = dev(burst, "multibandCompressor",
          {"bands": "2", "x1_hz": 1000, "b1_threshold_db": -20, "b1_ratio": 4,
           "b1_attack_ms": 10, "b1_release_ms": 120,
           "b2_threshold_db": 0.0, "b2_ratio": 1.0, "knee_db": 6.0})
strip = dev(burst, "compressor",
            {"threshold_db": -20, "ratio": 4, "attack_ms": 10, "release_ms": 120,
             "knee_db": 6.0})
rat = db(np.sqrt(np.mean(one ** 2))) - db(np.sqrt(np.mean(strip ** 2)))
ok(f"a single-band multiband tracks the channel-strip compressor to {rat:+.3f} dB",
   abs(rat) < 0.1)


# ═══════════════════════════ 5. DYNAMIC EQ ═════════════════════════════════

print("\n  -- the dynamic EQ is flat until the band misbehaves --")
quietish = stereo(sine(3000, 2.0, 0.02) + sine(500, 2.0, 0.02))
band_on = {"d3_on": True, "d3_hz": 3000, "d3_q": 3.0, "d3_threshold_db": -20,
           "d3_ratio": 8, "d3_range_db": 12, "d3_mode": "above",
           "d3_attack_ms": 2, "d3_release_ms": 60}
flat = dev(quietish, "dynamicEq", band_on)
ok(f"below the threshold it does not move ({float(np.max(np.abs(flat - quietish))):.2e})",
   float(np.max(np.abs(flat - quietish))) < 1e-6)
loudish = stereo(sine(3000, 2.0, 0.5) + sine(500, 2.0, 0.3))
acted = dev(loudish, "dynamicEq", band_on)
d3k = fft_mag_db(acted[0], 3000) - fft_mag_db(loudish[0], 3000)
d500 = fft_mag_db(acted[0], 500) - fft_mag_db(loudish[0], 500)
ok(f"above it, 3 kHz comes down {d3k:.2f} dB", d3k < -4.0)
ok(f"...and 500 Hz moves {d500:+.3f} dB", abs(d500) < 0.5)
ok(f"...and never past the range ({d3k:.2f} dB vs range 12)", d3k > -12.6)
below = dev(quietish, "dynamicEq", {**band_on, "d3_mode": "below"})
ok(f"mode `below` lifts a quiet band instead "
   f"({fft_mag_db(below[0], 3000) - fft_mag_db(quietish[0], 3000):+.2f} dB)",
   fft_mag_db(below[0], 3000) - fft_mag_db(quietish[0], 3000) > 3.0)
ok("range 0 is bit-transparent",
   np.array_equal(dev(loudish, "dynamicEq", {**band_on, "d3_range_db": 0.0}), loudish))

# The identity the device rests on: y = x + (A-1)*BPF(x) IS the peaking
# filter peaking_from_bpf() describes. Measured, not asserted.
for gdb, q in ((6.0, 2.0), (-9.0, 4.0)):
    b, a = master.bpf0_coeffs(2000.0, q, SR)
    A = 10 ** (gdb / 20.0)

    def run(z, b=b, a=a, A=A):
        from scipy.signal import sosfilt as _sf
        bp = _sf(np.concatenate([b, a])[None, :], z, axis=1)
        return z + (A - 1.0) * bp
    freqs = np.geomspace(40.0, 18000.0, 200)
    meas, at = impulse_response_db(run, freqs)
    pb, pa = master.peaking_from_bpf(2000.0, q, gdb, SR)
    _, h = freqz(pb, pa, worN=at, fs=SR)
    curve = 20 * np.log10(np.abs(h))
    worst = float(np.max(np.abs(meas - curve)))
    ok(f"y = x + (A-1)*BPF at {gdb:+.0f} dB Q{q} IS peaking_from_bpf's filter "
       f"(worst {worst:.2e} dB)", worst < 1e-6)


# ═══════════════════════════ 6. STEREO IMAGER ══════════════════════════════

print("\n  -- the imager's correlation change is MEASURED, in both directions --")
wide_in = np.vstack([sine(200, 3.0, 0.4) + sine(4000, 3.0, 0.25, phase=0.0),
                     sine(200, 3.0, 0.4) + sine(4000, 3.0, 0.25, phase=1.1)])


def corr(z):
    return float(np.corrcoef(z[0], z[1])[0, 1])


base_c = corr(wide_in)
widened = dev(wide_in, "stereoImager", {"x1_hz": 250, "x2_hz": 2000,
                                        "w1_width": 1.0, "w2_width": 1.0, "w3_width": 2.0})
narrowed = dev(wide_in, "stereoImager", {"x1_hz": 250, "x2_hz": 2000,
                                         "w1_width": 0.0, "w2_width": 0.0, "w3_width": 0.0})
cw, cn = corr(widened), corr(narrowed)
print(f"        correlation: input {base_c:+.4f}  widened {cw:+.4f}  narrowed {cn:+.4f}")
ok(f"widening the highs LOWERS correlation ({base_c:+.4f} -> {cw:+.4f})", cw < base_c - 0.01)
ok(f"all bands at width 0 is mono: correlation {cn:+.6f}", near(cn, 1.0, 1e-6))
ok("...and the two channels really are identical at width 0",
   float(np.max(np.abs(narrowed[0] - narrowed[1]))) < 1e-12)
mono_low = dev(wide_in, "stereoImager", {"mono_below_hz": 200})
from scipy.signal import sosfilt as _sosfilt   # noqa: E402
lo_side = 0.5 * (_sosfilt(master.lr4_sos(120.0, SR, "lp"), mono_low, axis=1)[0]
                 - _sosfilt(master.lr4_sos(120.0, SR, "lp"), mono_low, axis=1)[1])
ok(f"mono_below_hz folds the bottom ({db(np.sqrt(np.mean(lo_side ** 2))):.1f} dB of side "
   "energy under 120 Hz)", db(np.sqrt(np.mean(lo_side ** 2))) < -80)
ok("at every width 1 and mono off, the imager is the crossover's allpass and nothing else",
   float(np.max(np.abs(dev(wide_in, "stereoImager", {})
                       - master.lr_reference(wide_in, master._xovers([250.0, 3000.0], SR),
                                             SR)))) < 1e-10)


# ═══════════════════════════ 7. TILT EQ ════════════════════════════════════

print("\n  -- tilt is monotone in the knob, and the pivot does not move --")
lows, highs, pivots = [], [], []
for tilt in np.linspace(-12.0, 12.0, 13):
    p = rack.Params(rack.CATALOG["tiltEq"], {"tilt_db": float(tilt), "pivot_hz": 1000.0}, SR)
    secs = master.tilt_sections(p, SR)
    f3 = np.array([100.0, 1000.0, 10000.0])
    if secs:
        h = master.cascade_db(secs, f3, SR)
    else:
        h = np.ones(3, dtype=complex)
    d = 20 * np.log10(np.abs(h))
    lows.append(float(d[0]))
    pivots.append(float(d[1]))
    highs.append(float(d[2]))
ok(f"100 Hz falls monotonically as tilt rises ({lows[0]:+.2f} -> {lows[-1]:+.2f} dB)",
   all(lows[i] > lows[i + 1] + 1e-6 for i in range(len(lows) - 1)))
ok(f"10 kHz rises monotonically ({highs[0]:+.2f} -> {highs[-1]:+.2f} dB)",
   all(highs[i] < highs[i + 1] - 1e-6 for i in range(len(highs) - 1)))
ok(f"the pivot stays put (worst {max(abs(v) for v in pivots):.3f} dB across the whole range)",
   max(abs(v) for v in pivots) < 0.35)
ok("tilt 0 is bit-transparent", np.array_equal(dev(x0, "tiltEq", {}), x0))
tilted = dev(stereo(sine(100, 2.0, 0.3) + sine(10000, 2.0, 0.3)), "tiltEq",
             {"tilt_db": 6.0, "pivot_hz": 1000.0})
src = stereo(sine(100, 2.0, 0.3) + sine(10000, 2.0, 0.3))
ok(f"...and the bytes agree with the curve: 100 Hz "
   f"{fft_mag_db(tilted[0], 100) - fft_mag_db(src[0], 100):+.2f} dB, 10 kHz "
   f"{fft_mag_db(tilted[0], 10000) - fft_mag_db(src[0], 10000):+.2f} dB",
   near(fft_mag_db(tilted[0], 100) - fft_mag_db(src[0], 100), lows[9], 0.6)
   and near(fft_mag_db(tilted[0], 10000) - fft_mag_db(src[0], 10000), highs[9], 0.6))


# ═══════════════════════════ 8. MAXIMIZER ══════════════════════════════════

print("\n  -- the maximizer's true-peak ceiling holds under a slammed input --")
slam = np.vstack([
    np.concatenate([sine(220, 1.0, 0.95), sine(3000, 1.0, 0.95), sine(11987, 1.0, 0.99)]),
    np.concatenate([sine(330, 1.0, 0.95), sine(50, 1.0, 0.95), sine(9000, 1.0, 0.99)]),
])
for ceiling in (-0.1, -1.0, -3.0, -6.0):
    for character in ("clean", "warm", "punch"):
        y = dev(slam, "maximizer", {"gain_db": 18.0, "ceiling_db": ceiling,
                                    "character": character})
        tp = rack.true_peak_db(y)
        ok(f"ceiling {ceiling} dBTP, character {character}: measured {tp:.3f} dBTP",
           tp <= ceiling + 0.02, f"{tp:.4f} > {ceiling}")
# Loudness: measured on a mix with real headroom, which is what a maximizer
# is for. (Slamming an ALREADY-clipped input makes it quieter, correctly:
# the ceiling is below where it started.)
headroomy = slam * 10 ** (-14.0 / 20.0)
loud_in = rack.lufs_integrated(headroomy, SR)
loud_out = rack.lufs_integrated(dev(headroomy, "maximizer",
                                    {"gain_db": 12.0, "ceiling_db": -1.0}), SR)
ok(f"...and it is actually LOUDER for it ({loud_in:.2f} -> {loud_out:.2f} LUFS)",
   loud_out > loud_in + 8.0)
ok("...while STILL holding the ceiling on that quieter input",
   rack.true_peak_db(dev(headroomy, "maximizer",
                         {"gain_db": 12.0, "ceiling_db": -1.0})) <= -1.0 + 0.02)
ok("gain 0 with a quiet input is transparent within float dust",
   np.allclose(dev(stereo(sine(440, 1.0, 0.05)), "maximizer", {"gain_db": 0.0}),
               stereo(sine(440, 1.0, 0.05)), atol=1e-9))

print("\n  -- ...but the MASTER BUS has a tanh downstream of every insert --")
# THE FINDING, pinned so it cannot quietly change. rack.chain_graph ends with
# `mastered = tanh(0.7 * mix)` -- the P0 master curve, unconditional, after
# the master chain. A maximizer's ceiling is therefore the ceiling at the
# DEVICE, not in the file. The error is entirely in the safe direction (the
# file is quieter, never louder), but a true-peak-exact delivery cannot be
# made through the master bus as the rack stands, and the catalog says so.
bus_job = {
    "sr": SR, "start_sample": 0, "n_samples": SR * 2,
    "notes": [{"inst": "pluck", "midi": 45 + (i % 5), "vel": 120, "seed": i,
               "start_sample": i * (SR // 4), "dur_samples": SR // 3,
               "gain_db": 0.0, "track_id": "T"} for i in range(8)],
    "mixer": {"tracks": {"T": {"fader": 6.0}}, "returns": [], "spq": [[0.0, 0.5]],
              "master": {"inserts": [{"id": "m", "type": "maximizer", "enabled": True,
                                      "params": {"gain_db": 18.0, "ceiling_db": -1.0}}],
                         "fader": 0.0}},
}
bus_out, _ = rack.chain_graph(bus_job, engine.SYNTHS)
bus_tp = rack.true_peak_db(bus_out)
bus_sp = db(float(np.max(np.abs(bus_out))))
predicted = 20 * math.log10(math.tanh(0.7 * 10 ** (-1.0 / 20.0)))
print(f"        maximizer ceiling -1.00 dBTP -> the FILE measures {bus_sp:.2f} dBFS sample / "
      f"{bus_tp:.2f} dBTP; tanh(0.7x) predicts {predicted:.2f} dBFS")
ok(f"the ceiling is never BREACHED through the bus ({bus_tp:.2f} <= -1.00)", bus_tp <= -1.0)
ok(f"...and the SAMPLE peak is exactly what tanh(0.7x) predicts "
   f"({bus_sp:.2f} vs {predicted:.2f})", abs(bus_sp - predicted) < 0.15)
ok(f"...the remaining {bus_tp - bus_sp:.2f} dB is intersample overshoot from the "
   "harmonics tanh itself adds -- which is the other half of why a master-bus "
   "ceiling cannot be exact here", bus_tp > bus_sp)
ok("the catalog warns about it in the maximizer's own entry, rather than "
   "leaving someone to find it in a delivery",
   "tanh(0.7*mix)" in rack.CATALOG["maximizer"]["why"])

print("\n  -- ...and the gain-reduction readout is a measurement, not a label --")
gr = master._probe_device(slam, SR, {"type": "maximizer",
                                     "params": {"gain_db": 12.0, "ceiling_db": -1.0}})
ok(f"the probe reports real reduction (max {gr['gr_max_db']} dB, avg {gr['gr_avg_db']} dB)",
   gr["gr_max_db"] is not None and gr["gr_max_db"] < -2.0)
ok("...with the device's own drive knob subtracted out, so 'reduction' means reduction",
   gr["gain_offset_param"] == "gain_db" and near(gr["gain_offset_db"], 12.0, 1e-9))
ok(f"the probe's after-true-peak agrees with the ceiling ({gr['after']['true_peak_db']} dBTP)",
   gr["after"]["true_peak_db"] <= -1.0 + 0.02)


# ═══════════════════════════ 9. EXCITER ════════════════════════════════════

print("\n  -- the exciter generates the harmonics it says, and no aliases --")
tone = stereo(sine(1000, 2.0, 0.4))
odd = dev(tone, "exciter", {"freq_hz": 400, "drive_db": 18, "blend": 1.0, "mix": 1.0})
even = dev(tone, "exciter", {"freq_hz": 400, "drive_db": 18, "blend": 0.0, "mix": 1.0})
o2, o3 = fft_mag_db(odd[0], 2000), fft_mag_db(odd[0], 3000)
e2, e3 = fft_mag_db(even[0], 2000), fft_mag_db(even[0], 3000)
print(f"        odd  blend: 2 kHz {o2:.1f} dB, 3 kHz {o3:.1f} dB")
print(f"        even blend: 2 kHz {e2:.1f} dB, 3 kHz {e3:.1f} dB")
ok(f"blend 1 (odd) puts the third harmonic {o3 - o2:.1f} dB over the second", o3 - o2 > 12.0)
ok(f"blend 0 (even) puts the second {e2 - e3:.1f} dB over the third", e2 - e3 > 12.0)
# THE ALIAS TEST. 3 x 9 kHz = 27 kHz, past Nyquist; a naive generator folds it
# back to 21 kHz. The 4x oversampled generator's decimator removes it.
hi_tone = stereo(sine(9000, 2.0, 0.4))
print(f"        {'drive':>6} {'fund':>8} {'21k alias':>10} {'down':>7} {'naive 21k':>10}")
rows = {}
for drv in (3, 12, 18, 24):
    yh = dev(hi_tone, "exciter", {"freq_hz": 4000, "drive_db": drv, "blend": 1.0, "mix": 1.0})
    nv = np.tanh(hi_tone * 10 ** (drv / 20.0) * 2.0) * 0.5     # same curve, no oversampling
    f9, a21, n21 = fft_mag_db(yh[0], 9000), fft_mag_db(yh[0], 21000), fft_mag_db(nv[0], 21000)
    rows[drv] = (f9, a21, n21)
    print(f"        {drv:6d} {f9:8.1f} {a21:10.1f} {f9 - a21:7.1f} {n21:10.1f}")
f9, a21, n21 = rows[12]                     # the catalog default
ok(f"at the default drive the 21 kHz fold-back is {f9 - a21:.1f} dB down", f9 - a21 > 55.0)
ok(f"...and a naive generator puts it {n21 - a21:.1f} dB louder", n21 - a21 > 40.0)
# The residual is NAMED rather than hidden: at 4x, 27 kHz (the third
# harmonic) is gone entirely and what survives is the NINETEENTH -- 171 kHz,
# which folds to 21 kHz at a 192 kHz working rate. It grows with drive
# because a hard-driven tanh is a square wave, and the catalog says so.
f24, a24, n24 = rows[24]
ok(f"even slammed to +24 dB it stays {f24 - a24:.1f} dB down "
   f"({n24 - a24:.1f} dB better than naive) -- and the catalog says it degrades",
   f24 - a24 > 30.0 and n24 - a24 > 18.0
   and "19th" in rack.CATALOG["exciter"]["why"])
ok("mix 0 is transparent apart from the output trim",
   np.allclose(dev(tone, "exciter", {"mix": 0.0}), tone, atol=1e-12))
ok("the excitation stays ABOVE the corner (1 kHz is untouched at freq_hz 4000)",
   near(fft_mag_db(dev(tone, "exciter", {"freq_hz": 4000, "drive_db": 24, "mix": 1.0})[0], 1000),
        fft_mag_db(tone[0], 1000), 0.3))


# ═══════════════════════════ 10. DITHER ════════════════════════════════════

print("\n  -- dither: sub-LSB information SURVIVES; truncation destroys it --")
# A 1 kHz tone at -100 dBFS. One 16-bit LSB is 2^-15 = -90.3 dBFS, so the tone
# is a THIRD of a quantisation step: plain rounding cannot represent it at all.
tiny = stereo(sine(1000, 4.0, 10 ** (-100 / 20.0)))
step = 2.0 ** -15
truncated = np.round(tiny / step) * step
dithered = master.apply_dither(tiny, bits=16, noise_shape="flat", seed=5)
shaped = master.apply_dither(tiny, bits=16, noise_shape="shaped", seed=5)
ok(f"plain 16-bit rounding erases the tone entirely (peak {float(np.max(np.abs(truncated))):.1e})",
   float(np.max(np.abs(truncated))) == 0.0)
t_d = fft_mag_db(dithered[0], 1000)
t_s = fft_mag_db(shaped[0], 1000)
floor_d = fft_mag_db(dithered[0], 5000)
print(f"        dithered: tone {t_d:.1f} dB, floor at 5 kHz {floor_d:.1f} dB")
ok(f"TPDF dither keeps the tone {t_d - floor_d:.1f} dB above its own noise floor",
   t_d - floor_d > 10.0)
ok(f"noise-shaped dither keeps it too ({t_s:.1f} dB)", t_s > floor_d + 8.0)
ok("both really are quantised to the 16-bit grid",
   float(np.max(np.abs(dithered / step - np.round(dithered / step)))) < 1e-9
   and float(np.max(np.abs(shaped / step - np.round(shaped / step)))) < 1e-9)

print("\n  -- ...and the shaped floor really is SHAPED --")
mus = stereo(sine(220, 4.0, 0.25) + sine(660, 4.0, 0.12))
e_flat = master.apply_dither(mus, bits=16, noise_shape="flat", seed=9) - mus
e_shaped = master.apply_dither(mus, bits=16, noise_shape="shaped", seed=9) - mus


def band_power_db(sig, lo, hi):
    n = len(sig)
    S = np.abs(np.fft.rfft(sig * np.hanning(n))) ** 2
    f = np.fft.rfftfreq(n, 1.0 / SR)
    m = (f >= lo) & (f < hi)
    return 10 * math.log10(max(float(S[m].sum()), 1e-30))


lo_flat = band_power_db(e_flat[0], 20, 4000)
lo_shaped = band_power_db(e_shaped[0], 20, 4000)
hi_flat = band_power_db(e_flat[0], 12000, 24000)
hi_shaped = band_power_db(e_shaped[0], 12000, 24000)
print(f"        error energy  <4 kHz: flat {lo_flat:.1f} dB, shaped {lo_shaped:.1f} dB")
print(f"        error energy >12 kHz: flat {hi_flat:.1f} dB, shaped {hi_shaped:.1f} dB")
ok(f"shaping buys {lo_flat - lo_shaped:.1f} dB under 4 kHz", lo_shaped < lo_flat - 3.0)
ok(f"...and pays {hi_shaped - hi_flat:.1f} dB over 12 kHz, which is the whole trade",
   hi_shaped > hi_flat + 3.0)
ok(f"the flat floor sits near the theoretical TPDF level "
   f"({db(float(np.sqrt(np.mean(e_flat ** 2)))):.1f} dBFS rms for 16 bits)",
   -100.0 < db(float(np.sqrt(np.mean(e_flat ** 2)))) < -80.0)
silence = np.zeros((2, 4800))
ok("auto_blank leaves digital silence silent",
   float(np.max(np.abs(master.apply_dither(silence, bits=16, seed=3)))) == 0.0)
ok("...and turning it off does dither the silence (so the option is real)",
   float(np.max(np.abs(master.apply_dither(silence, bits=16, seed=3,
                                           auto_blank=False)))) > 0.0)
ok("24-bit reduction is a much finer grid than 16 (the depth knob is real)",
   float(np.max(np.abs(master.apply_dither(mus, bits=24, seed=3) - mus)))
   < float(np.max(np.abs(master.apply_dither(mus, bits=16, seed=3) - mus))) / 100.0)


# ═══════════════════════════ 11. ANALYZE ═══════════════════════════════════

print("\n  -- analyze: a known sine lands in the right bin at the right level --")
known = stereo(sine(1000, 4.0, 0.5))
a1 = master.analyze({"sr": SR, "file": None, "start_sample": 0, "n_samples": 0}, None) \
    if False else None
res = master.measure(known, SR)
sp = res["spectrum"]
k = int(np.argmax([v for v in sp["avg_db"]]))
print(f"        peak log bin: {sp['hz'][k]} Hz at {sp['avg_db'][k]} dB "
      f"(expected 1000 Hz at {db(0.5) - 3.01:.2f})")
ok(f"the peak bin is {sp['hz'][k]} Hz (within 3% of 1000)",
   abs(sp["hz"][k] - 1000.0) / 1000.0 < 0.03)
ok(f"...at {sp['avg_db'][k]} dB, the sine's own mean-square level",
   near(sp["avg_db"][k], db(0.5) - 3.01, 1.0))
octave_down = min(range(len(sp["hz"])), key=lambda i: abs(sp["hz"][i] - 500.0))
ok(f"an octave away reads {sp['avg_db'][octave_down]} dB -- 40 dB down or more",
   sp["avg_db"][octave_down] < sp["avg_db"][k] - 40.0)
ok(f"the resolution is stated ({sp['resolution_hz']} Hz) and sub-resolution bands "
   f"are flagged ({sum(sp['interpolated'])} of {len(sp['hz'])})",
   sp["resolution_hz"] > 0 and sum(sp["interpolated"]) > 0
   and not any(sp["interpolated"][k - 2:k + 3]))

print("\n  -- ...and the payload has every key the UI seam promises --")
SHAPE = {
    "spectrum": ["n_fft", "hop", "window", "frames", "resolution_hz", "ref",
                 "hz", "avg_db", "peak_db", "interpolated"],
    "loudness": ["momentary", "short", "integrated", "lra", "true_peak_db",
                 "sample_peak_db", "rms_db"],
    "correlation": ["series", "overall", "min", "max", "mono_compatible",
                    "width", "mid_rms_db", "side_rms_db"],
    "goniometer": ["points", "n_total", "slot", "picked", "axes"],
    "dynamics": ["crest_db", "plr_db", "psr_db", "psr_series"],
}
music = np.vstack([sine(110, 8.0, 0.3) + sine(440, 8.0, 0.2) + sine(3300, 8.0, 0.1),
                   sine(110, 8.0, 0.3) + sine(440, 8.0, 0.2, phase=0.7) + sine(3300, 8.0, 0.1)])
m = master.measure(music, SR)
missing = [f"{g}.{k}" for g, keys in SHAPE.items() for k in keys if k not in m.get(g, {})]
ok("every documented group and key is present", not missing, ", ".join(missing))
ok(f"the loudness series are per ~100 ms (M {len(m['loudness']['momentary'])} points, "
   f"S {len(m['loudness']['short'])})",
   len(m["loudness"]["momentary"]) > 60 and len(m["loudness"]["short"]) > 40)
ok(f"integrated LUFS is a number ({m['loudness']['integrated']}) and LRA is one too "
   f"({m['loudness']['lra']})",
   isinstance(m["loudness"]["integrated"], float) and m["loudness"]["lra"] is not None)
ok(f"correlation is a series plus a summary ({len(m['correlation']['series'])} windows, "
   f"overall {m['correlation']['overall']})",
   len(m["correlation"]["series"]) > 50 and m["correlation"]["overall"] is not None)
ok(f"the goniometer is decimated but keeps the peaks "
   f"({len(m['goniometer']['points'])} points of {m['goniometer']['n_total']} samples)",
   0 < len(m["goniometer"]["points"]) <= master.GONIO_POINTS + 1)
gmax = max(max(abs(a), abs(b)) for a, b in m["goniometer"]["points"])
ok(f"...literally: the cloud's extreme ({gmax:.4f}) matches the signal's "
   f"({float(np.max(np.abs(music[0] + music[1]))) / math.sqrt(2):.4f})",
   near(gmax, float(np.max(np.abs(music[0] + music[1]))) / math.sqrt(2), 0.02))
ok(f"crest {m['dynamics']['crest_db']} dB, PLR {m['dynamics']['plr_db']} dB, "
   f"PSR {m['dynamics']['psr_db']} dB",
   all(isinstance(m["dynamics"][k], float) for k in ("crest_db", "plr_db", "psr_db")))
ok(f"the nine bands are ear.py's, with its pink null ({len(m['bands'])} bands, "
   f"first {m['bands'][0]['name']})",
   len(m["bands"]) == 9 and m["bands"][0]["name"] == "sub"
   and all("delta_db" in b for b in m["bands"]))
# LRA: a signal with a known 12 LU step has a loudness RANGE near 12.
step_sig = np.hstack([
    stereo(sine(400, 12.0, 0.4)), stereo(sine(400, 12.0, 0.4 * 10 ** (-12 / 20.0)))])
lra_v = master.lra(step_sig, SR)
ok(f"LRA of a 12 LU step measures {lra_v:.2f} LU", near(lra_v, 12.0, 1.5))
ok("LUFS-I is rack.py's, not a second implementation",
   near(m["loudness"]["integrated"], round(rack.lufs_integrated(music, SR), 2), 0.001))
ok("true peak is rack.py's too",
   near(m["loudness"]["true_peak_db"], round(rack.true_peak_db(music), 2), 0.001))


# ═══════════════════════ 12. DEVICE RESPONSE ═══════════════════════════════

print("\n  -- device_response: the curve IS the filter (measured impulse response) --")
for params, label in (
    ({"b2_hz": 500, "b2_gain_db": 8, "b2_q": 1.5, "b4_hz": 7000, "b4_gain_db": -6},
     "two bells"),
    ({"hp_on": True, "hp_hz": 120, "b3_hz": 2500, "b3_gain_db": 5}, "HP + a bell"),
):
    r = master.device_response({"type": "eq", "params": params, "sr": SR, "points": 200})
    freqs = np.array([f for f in r["hz"] if 40.0 <= f <= 18000.0])
    curve = np.array([m for f, m in zip(r["hz"], r["magnitude_db"]) if 40.0 <= f <= 18000.0])

    def run_eq(z, params=params):
        return rack.dev_eq(z, rack.Params(rack.CATALOG["eq"], params, SR), ctx())
    meas, at = impulse_response_db(run_eq, freqs)
    # The curve is asked at exact frequencies; the measurement lands on the
    # nearest FFT bin (0.37 Hz apart), so re-evaluate the curve THERE and the
    # comparison is of two numbers about the same frequency.
    exact = 20 * np.log10(np.abs(master.cascade_db(
        master.eq_sections(rack.Params(rack.CATALOG["eq"], params, SR), SR), at, SR)))
    worst = float(np.max(np.abs(meas - exact)))
    drift = float(np.max(np.abs(curve - exact)))
    ok(f"eq ({label}): the drawn curve tracks the REAL device to {worst:.2e} dB",
       worst < 1e-6, f"curve-vs-bin drift {drift:.4f} dB")

r = master.device_response({"type": "tiltEq",
                            "params": {"tilt_db": -8.0, "pivot_hz": 800.0}, "sr": SR})
freqs = np.array([f for f in r["hz"] if 40.0 <= f <= 18000.0])


def run_tilt(z):
    return rack.dev_tilt(z, rack.Params(rack.CATALOG["tiltEq"],
                                        {"tilt_db": -8.0, "pivot_hz": 800.0}, SR), ctx()) \
        if hasattr(rack, "dev_tilt") else master.dev_tilt(
            z, rack.Params(rack.CATALOG["tiltEq"],
                           {"tilt_db": -8.0, "pivot_hz": 800.0}, SR), ctx())


meas, at = impulse_response_db(run_tilt, freqs)
exact = 20 * np.log10(np.abs(master.cascade_db(
    master.tilt_sections(rack.Params(rack.CATALOG["tiltEq"],
                                     {"tilt_db": -8.0, "pivot_hz": 800.0}, SR), SR), at, SR)))
ok(f"tiltEq: drawn curve vs measured device {float(np.max(np.abs(meas - exact))):.2e} dB",
   float(np.max(np.abs(meas - exact))) < 1e-6)

r = master.device_response({"type": "multibandCompressor",
                            "params": {"bands": "4"}, "sr": SR})
flat_dev = max(abs(v) for f, v in zip(r["hz"], r["magnitude_db"]) if 40 <= f <= 18000)
ok(f"multiband: the SUM of the band curves is flat to {flat_dev:.2e} dB", flat_dev < 1e-6)
ok(f"...and every band is drawn separately ({len(r['bands'])} bands, crossovers "
   f"{r['crossovers_hz']})", len(r["bands"]) == 4 and len(r["crossovers_hz"]) == 3)
r = master.device_response({"type": "compressor",
                            "params": {"threshold_db": -20, "ratio": 4, "knee_db": 0}, "sr": SR})
ok("a dynamics device answers a TRANSFER curve instead of a frequency one",
   r["magnitude_db"] is None and "transfer" in r and "none_reason" in r)
tin = np.array(r["transfer"]["in_db"])
tout = np.array(r["transfer"]["out_db"])
i0 = int(np.argmin(np.abs(tin + 30)))
i1 = int(np.argmin(np.abs(tin + 4)))
ok(f"...and it is the real gain computer: -30 dB in -> {tout[i0]:.1f} out (1:1 under the "
   f"threshold), -4 dB in -> {tout[i1]:.1f} out (4:1 over it)",
   near(tout[i0], tin[i0], 0.01) and near(tout[i1], -20 + 16 / 4.0, 0.3))
r = master.device_response({"type": "dither", "params": {}, "sr": SR})
ok("dither says honestly that it has no curve", r["magnitude_db"] is None and r["none_reason"])
r = master.device_response({"type": "dynamicEq",
                            "params": {"d3_on": True, "d3_hz": 3000, "d3_range_db": 9}, "sr": SR})
ok(f"the dynamic EQ draws its REACH as well as its rest state "
   f"(rest flat, reach {min(r['max_magnitude_db']):.1f} dB)",
   r["at_rest"] and max(abs(v) for v in r["magnitude_db"]) < 1e-9
   and near(min(r["max_magnitude_db"]), -9.0, 0.2))


# ═══════════════════════ 13. REFERENCE + DELIVERY ══════════════════════════

print("\n  -- reference A/B: loudness-matched, and it says by how much --")
tmp = tempfile.mkdtemp(prefix="dawmaster_")
ref_path = os.path.join(tmp, "ref.wav")
ref_sig = np.vstack([sine(150, 6.0, 0.5) + sine(2500, 6.0, 0.35),
                     sine(150, 6.0, 0.5) + sine(2500, 6.0, 0.35, phase=0.4)])
rack.write_wav_f32_stereo(ref_path, ref_sig.astype(np.float32), SR)
mine_path = os.path.join(tmp, "mine.wav")
mine_sig = ref_sig * 10 ** (-9.0 / 20.0)
rack.write_wav_f32_stereo(mine_path, mine_sig.astype(np.float32), SR)
rep = master.reference({"sr": SR, "file": mine_path, "reference": ref_path}, None)
ok(f"the applied gain is the loudness difference ({rep['match']['applied_gain_db']} dB, "
   f"expected -9)", near(rep["match"]["applied_gain_db"], -9.0, 0.1))
ok(f"...and after matching both read the same LUFS "
   f"({rep['project']['loudness']['integrated']} vs "
   f"{rep['reference']['loudness']['integrated']})",
   near(rep["project"]["loudness"]["integrated"],
        rep["reference"]["loudness"]["integrated"], 0.05))
ok(f"the reference's OWN loudness is still reported "
   f"({rep['reference']['unmatched_lufs']} LUFS)",
   near(rep["reference"]["unmatched_lufs"] - rep["project"]["loudness"]["integrated"], 9.0, 0.1))
ok("both spectra come back, and the band deltas with them",
   len(rep["project"]["spectrum"]["hz"]) == len(rep["reference"]["spectrum"]["hz"])
   and len(rep["delta_bands_db"]) == 9)
ok(f"identical material matched to itself has ~zero band delta "
   f"(worst {max(abs(v) for v in rep['delta_bands_db']):.3f} dB)",
   max(abs(v) for v in rep["delta_bands_db"]) < 0.05)

print("\n  -- delivery: PASS/FAIL, and the exact move --")
cd = master.check_delivery({"sr": SR, "file": mine_path}, None)
ids = [r["id"] for r in cd["results"]]
ok(f"every target is checked ({len(ids)}: {', '.join(ids)})", len(ids) == len(master.DELIVERY_TARGETS))
bad = [r["id"] for r in cd["results"] if r["confidence"] not in ("published", "measured", "uncertain")
       or not r["source"]]
ok("every target carries a confidence and a source", not bad, ", ".join(bad))
ok("the uncertain ones are labelled uncertain, not rounded into fact",
   any(r["confidence"] == "uncertain" for r in cd["results"])
   and any(r["confidence"] == "measured" for r in cd["results"]))
sp_row = next(r for r in cd["results"] if r["id"] == "spotify")
ok(f"the gain advice is arithmetic: {sp_row['measured_lufs']} LUFS -> "
   f"{sp_row['gain_change_db']} dB gets to {sp_row['lufs']}",
   near(sp_row["measured_lufs"] + sp_row["gain_change_db"], sp_row["lufs"], 0.01))
ok(f"...and it says where that gain would put the true peak "
   f"({sp_row['true_peak_after_gain_db']} dBTP)",
   near(sp_row["true_peak_after_gain_db"],
        sp_row["measured_true_peak_db"] + sp_row["gain_change_db"], 0.01))
# A master already AT the ceiling cannot be gained into the target; the check
# must say that rather than advising an impossible fader move.
hot_path = os.path.join(tmp, "hot.wav")
hot = np.vstack([sine(200, 6.0, 0.03), sine(200, 6.0, 0.03)])
hot[:, ::4000] = 0.89                                   # quiet, but peaky
rack.write_wav_f32_stereo(hot_path, hot.astype(np.float32), SR)
cd2 = master.check_delivery({"sr": SR, "file": hot_path}, None)
row = next(r for r in cd2["results"] if r["id"] == "spotify")
ok(f"a quiet-but-peaky master is told it needs LIMITING, not gain "
   f"({row['limiting_needed_db']} dB, verdict '{row['verdict']}')",
   row["limiting_needed_db"] > 0.5 and "headroom" in row["verdict"])
amz = next(r for r in cd["results"] if r["id"] == "amazon_music")
ok(f"Amazon's tighter ceiling is carried through ({amz['true_peak_db']} dBTP, not -1)",
   amz["true_peak_db"] == -2.0)
ebu = next(r for r in cd["results"] if r["id"] == "ebu_r128")
ok(f"the one real standard in the table keeps its real tolerance "
   f"(EBU R 128, {ebu['lufs']} +/- {ebu['tolerance_lu']} LU)",
   ebu["lufs"] == -23.0 and ebu["tolerance_lu"] == 0.5)
ok("the table warns that platform numbers move", "confidence" in cd["caveat"]
   or "changes" in cd["caveat"])


# ═══════════════════════════ 14. ENGINE SEAM ═══════════════════════════════

print("\n  -- the four analysis modes are on engine.py's own dispatch table --")
for mode in ("analyze", "device_response", "reference", "check_delivery", "delivery_targets"):
    ok(f"MODES[{mode!r}] exists", mode in engine.MODES)
r = engine.MODES["device_response"]({"type": "eq", "params": {"b1_gain_db": 6}})
ok("...and answers the same JSON the module does", r["ok"] and len(r["hz"]) > 100)
r = engine.MODES["analyze"]({"sr": SR, "file": mine_path})
ok("analyze over the engine seam measures a real file",
   r["ok"] and r["source"] == "file" and isinstance(r["loudness"]["integrated"], float))
ok("...and every payload is JSON-serialisable (the wire is the contract)",
   isinstance(json.dumps(r), str) and isinstance(json.dumps(cd), str)
   and isinstance(json.dumps(rep), str))


# ═══════════════════════════ 15. CPU ═══════════════════════════════════════

print("\n  -- CPU: ms per device on a 4-bar region (8 s @48k stereo) --")
region = stereo(np.concatenate([sine(220, 4.0, 0.4), sine(330, 4.0, 0.4)]))
heavy = {
    "multibandCompressor": {"bands": "4", "b1_threshold_db": -40, "b2_threshold_db": -40,
                            "b3_threshold_db": -40, "b4_threshold_db": -40},
    "dynamicEq": {"d1_on": True, "d2_on": True, "d3_on": True, "d4_on": True,
                  "d1_threshold_db": -50, "d2_threshold_db": -50,
                  "d3_threshold_db": -50, "d4_threshold_db": -50},
    "stereoImager": {"w1_width": 0.3, "w2_width": 1.2, "w3_width": 1.8, "mono_below_hz": 120},
    "tiltEq": {"tilt_db": 6.0},
    "maximizer": {"gain_db": 12.0, "character": "punch"},
    "exciter": {"drive_db": 18.0, "mix": 0.5},
    "dither": {"bits": 16, "noise_shape": "shaped"},
}
print(f"        {'device':<22} {'ms/4bar':>8}")
budget_fail = []
timings = {}
for name in NEW:
    t0 = time.perf_counter()
    dev(region, name, heavy[name])
    ms = (time.perf_counter() - t0) * 1000
    timings[name] = ms
    print(f"        {name:<22} {ms:8.1f}")
    if ms > 1000:
        budget_fail.append(f"{name} {ms:.0f}ms")
t0 = time.perf_counter()
master.measure(region, SR)
print(f"        {'(analyze, full)':<22} {(time.perf_counter() - t0) * 1000:8.1f}")
t0 = time.perf_counter()
dev(region, "eq", {"stereo_mode": "mid_side", "b2_gain_db": 4})
print(f"        {'(eq in M/S)':<22} {(time.perf_counter() - t0) * 1000:8.1f}")
ok("every mastering device renders a 4-bar region in under a second", not budget_fail,
   ", ".join(budget_fail))
over = [f"{k} {v:.0f}ms" for k, v in timings.items() if v > 150]
print("        (over the 150 ms/4-bar guideline: "
      + (", ".join(over) if over else "none") + ")")

print(f"\n  {passed} passed, {len(failures)} failed\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
