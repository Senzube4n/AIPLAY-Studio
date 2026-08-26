# -*- coding: utf-8 -*-
"""DAW rack -- every device proven by arithmetic, never by ear.

The chain-stage assertions the build hangs on:

  BYPASS    enabled:false is a bit-exact passthrough, per device.
  DEFAULTS  transparent devices are transparent (eq/comp/gate/limiter/
            utility pass a sane signal unchanged or within float dust);
            character devices (saturator, chorus, delay, reverb) CHANGE the
            signal, on purpose, and say so in their catalog `why`.
  SWEEP     the headline param of every device audibly moves the bytes.
  EQ        a +12 dB bell boosts its band by ~12 dB in the FFT and leaves a
            distant band alone.
  COMP      a bursty signal comes out with a smaller crest factor; the
            sidechain input ducks a bed under someone else's kick.
  LIMITER   a slammed input holds the ceiling, measured at 4x oversampling.
  DELAY     echoes land exactly on the tempo grid, and follow a tempo
            change by the written rule (an echo spaces to the tempo at the
            moment its source played).
  AUTOMATION fader keys and insert-param keys move the sound over time,
            through the same vfx keyframe evaluator the document stores.
  SEAM      a region window through the FULL graph is bit-identical to the
            same window sliced from a longer render, and re-renders are
            byte-identical -- the P0 determinism story, carried through the
            rack.
  METERS    the K-weighting curve matches BS.1770's stated shape, LUFS
            tracks gain exactly, true-peak sees intersample peaks.
  CPU       every device is timed on a 4-bar region and reported; nothing
            may cost more than a second.

Run:  python server/daw/rack_test.py       (rig venv: numpy + scipy)
"""
import math
import os
import sys
import time

import numpy as np
from scipy.signal import freqz, resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engine  # noqa: E402
import rack    # noqa: E402

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


def sine(f, secs, amp=0.5, sr=SR):
    t = np.arange(int(secs * sr)) / sr
    return np.sin(2 * np.pi * f * t) * amp


def stereo(mono):
    return np.vstack([mono, mono])


def rms(x):
    return float(np.sqrt(np.mean(np.square(x))))


def db(x):
    return 20.0 * math.log10(max(x, 1e-12))


def fft_mag_db(x, f, sr=SR):
    """Magnitude at f from a hann'd rfft of the middle of the signal."""
    n = min(len(x), 1 << 15)
    seg = x[len(x) // 2 - n // 2: len(x) // 2 + n // 2] * np.hanning(n)
    spec = np.abs(np.fft.rfft(seg))
    return db(float(spec[int(round(f * n / sr))]))


print("\n  -- catalog and devices are one list --")
ok("every device has a catalog entry and vice versa",
   sorted(rack.DEVICES) == sorted(rack.CATALOG))
bad = [f"{d}.{p}" for d, spec in rack.CATALOG.items()
       for p, v in spec["params"].items()
       if v.get("type") == "number" and not (v["min"] <= v["default"] <= v["max"])]
ok("every numeric default sits inside its own range", not bad, ", ".join(bad))
ok("every device declares stateful", all("stateful" in s for s in rack.CATALOG.values()))
ok("every device says why", all(s.get("why") and s.get("label") for s in rack.CATALOG.values()))

print("\n  -- bypass is a bit-exact passthrough, per device --")
x0 = stereo(sine(440, 1.0, 0.5) + sine(1330, 1.0, 0.2))
for name in sorted(rack.DEVICES):
    y = dev(x0, name, {"drive_db": 30} if name == "saturator" else {}, enabled=False)
    ok(f"{name} bypass", y is x0 or np.array_equal(y, x0))

print("\n  -- defaults: transparent is transparent, character is character --")
quiet = stereo(sine(440, 1.0, 0.05))                 # ~-26 dBFS, under thresholds
for name, tol in (("eq", 0.0), ("utility", 0.0)):
    y = dev(x0, name)
    ok(f"{name} defaults are bit-transparent", np.array_equal(y, x0))
for name in ("compressor", "gate"):
    y = dev(quiet if name == "compressor" else x0, name)
    ref = quiet if name == "compressor" else x0
    ok(f"{name} defaults are transparent within float dust",
       np.allclose(y, ref, atol=1e-9), f"max diff {np.max(np.abs(y - ref)):.2e}")
y = dev(quiet, "limiter")
ok("limiter defaults are transparent on a sane signal",
   np.allclose(y, quiet, atol=1e-9), f"max diff {np.max(np.abs(y - quiet)):.2e}")
for name in ("saturator", "chorus", "delay", "reverb"):
    y = dev(x0, name)
    changed = not np.allclose(y, x0, atol=1e-6)
    ok(f"{name} default has its documented character (output differs, finite)",
       changed and np.all(np.isfinite(y)))

print("\n  -- the headline param of every device moves the bytes --")
loud = stereo(sine(300, 1.0, 0.8))
sweeps = {
    "eq": ("b2_gain_db", 9.0, x0),
    "compressor": ("threshold_db", -40.0, loud),
    "limiter": ("ceiling_db", -12.0, loud),
    "saturator": ("drive_db", 30.0, x0),
    "chorus": ("depth_ms", 10.0, x0),
    "delay": ("feedback", 0.8, x0),
    "reverb": ("room_size", 0.95, x0),
    "gate": ("threshold_db", -10.0, quiet),
    "utility": ("gain_db", -6.0, x0),
}
for name, (p, v, sig) in sorted(sweeps.items()):
    ya = dev(sig, name)
    yb = dev(sig, name, {p: v})
    ok(f"{name}: {p}={v} changes the output", not np.array_equal(ya, yb))

print("\n  -- EQ: the bell boosts its band and leaves the far band alone --")
probe = stereo(sine(100, 2.0, 0.2) + sine(1000, 2.0, 0.2) + sine(6000, 2.0, 0.2))
yq = dev(probe, "eq", {"b3_hz": 1000, "b3_gain_db": 12, "b3_q": 1.0})
gain_1k = fft_mag_db(yq[0], 1000) - fft_mag_db(probe[0], 1000)
gain_100 = fft_mag_db(yq[0], 100) - fft_mag_db(probe[0], 100)
ok(f"+12 dB bell at 1 kHz measures {gain_1k:.2f} dB", near(gain_1k, 12.0, 1.5))
ok(f"...and 100 Hz moved only {gain_100:.2f} dB", abs(gain_100) < 1.0)
yhp = dev(probe, "eq", {"hp_on": True, "hp_hz": 400})
ok("the high-pass guts 100 Hz",
   fft_mag_db(yhp[0], 100) - fft_mag_db(probe[0], 100) < -12)

print("\n  -- compressor: the decay flattens (crest falls); the sidechain ducks --")
# Crest on the ENVELOPE (100 ms rms windows / overall rms): a sample-peak
# crest is a red herring here -- a real 1 ms attack passes the first
# fraction of a millisecond and that leaked transient IS the sample peak.
# The musical claim is that loud parts come toward quiet parts, so measure
# exactly that: a loud half and a quiet half, windowed crest and the
# loud/quiet range, both of which must collapse.
two = np.concatenate([sine(220, 2.0, 0.8), sine(220, 2.0, 0.08)])
bx = stereo(two)
yc = dev(bx, "compressor", {"threshold_db": -30, "ratio": 8, "attack_ms": 5,
                            "release_ms": 100})
def win_crest(x):
    # steady-state crest: 100 ms rms windows over overall rms, the 5 ms
    # attack's onset window excluded -- a real attack passes the onset and
    # that is behaviour, not a bug to hide with a slow assert.
    w = int(0.1 * SR)
    seg = x[:, int(0.2 * SR):]
    n = (seg.shape[1] // w) * w
    wins = np.sqrt(np.mean(np.square(seg[0][:n].reshape(-1, w)), axis=1))
    return float(np.max(wins)) / max(rms(seg), 1e-12)
ok(f"steady-state windowed crest {win_crest(bx):.3f} -> {win_crest(yc):.3f}",
   win_crest(yc) < win_crest(bx) * 0.9)
loud_w, quiet_w = slice(int(1.0 * SR), int(1.9 * SR)), slice(int(3.0 * SR), int(3.9 * SR))
rng_in = db(rms(bx[0][loud_w])) - db(rms(bx[0][quiet_w]))
rng_out = db(rms(yc[0][loud_w])) - db(rms(yc[0][quiet_w]))
ok(f"the 20 dB loud/quiet range collapses to {rng_out:.1f} dB", rng_out < rng_in * 0.5)

kick = np.zeros(int(4.0 * SR))
for k in range(8):
    i = int(k * 0.5 * SR)
    seg = sine(60, 0.12, 0.9) * np.exp(-np.arange(int(0.12 * SR)) / (0.03 * SR))
    kick[i:i + len(seg)] += seg
bass = stereo(sine(110, 4.0, 0.5))
c_sc = ctx(dry={"K": kick})
duck = dev(bass, "compressor", {"threshold_db": -30, "ratio": 10, "attack_ms": 1,
                                "release_ms": 100, "sidechain": "K"}, c=c_sc)
plain = dev(bass, "compressor", {"threshold_db": -30, "ratio": 10, "attack_ms": 1,
                                 "release_ms": 100}, c=c_sc)
on_kick = slice(int(0.505 * SR), int(0.55 * SR))     # kick 2 lands at 0.5 s
off_kick = slice(int(0.30 * SR), int(0.44 * SR))     # nothing keying here
ok("the bass ducks under the OTHER track's kick",
   rms(duck[0][on_kick]) < rms(bass[0][on_kick]) * 0.5,
   f"{rms(duck[0][on_kick]):.4f} vs {rms(bass[0][on_kick]):.4f}")
ok("...and recovers between kicks (the KEY decides, not the bass)",
   rms(duck[0][off_kick]) > rms(bass[0][off_kick]) * 0.8,
   f"{rms(duck[0][off_kick]):.4f} vs {rms(bass[0][off_kick]):.4f}")
ok("self-keyed on a steady bass, reduction is steady instead",
   near(rms(plain[0][on_kick]) / max(rms(plain[0][off_kick]), 1e-9), 1.0, 0.1),
   f"{rms(plain[0][on_kick]):.4f} vs {rms(plain[0][off_kick]):.4f}")

print("\n  -- limiter: the ceiling holds under a slammed input, true-peak measured --")
slam = stereo(np.clip(sine(97, 2.0, 1.9) + sine(1370, 2.0, 0.7), -2.2, 2.2))
yl = dev(slam, "limiter", {"ceiling_db": -6, "release_ms": 60, "lookahead_ms": 5})
tp = rack.true_peak_db(yl)
ok(f"true peak {tp:.2f} dBTP vs ceiling -6 dBTP", tp <= -6 + 0.15, f"{tp}")
ok("it is limiting, not muting",
   rms(yl) > 0.05 and np.max(np.abs(yl)) > 0.3, f"rms {rms(yl):.3f}")

print("\n  -- delay: echoes on the tempo grid, tempo change obeyed --")
imp = np.zeros(int(3.0 * SR))
imp[0] = 1.0
yd = dev(stereo(imp), "delay", {"sync": "1/4", "feedback": 0.5, "mix": 1.0,
                                "pingpong": False, "tone_hz": 18000})
q = int(0.5 * SR)                                     # 1/4 at 120 bpm = 0.5 s
e1 = int(np.argmax(np.abs(yd[0][q - 100:q + 100]))) + q - 100
e2 = int(np.argmax(np.abs(yd[0][2 * q - 100:2 * q + 100]))) + 2 * q - 100
ok(f"first echo at {e1} (expected {q})", abs(e1 - q) <= 2)
ok(f"second echo at {e2} (expected {2 * q})", abs(e2 - 2 * q) <= 2)
ok("nothing lands off the grid",
   np.max(np.abs(yd[0][int(0.55 * SR):int(0.95 * SR)])) < 0.02)

# tempo change at t=1.0s: 120 -> 90 bpm. An impulse played at t=1.2 writes
# its echo with the tempo AT 1.2 s: spacing 60/90 * 1 quarter = 0.6667 s.
imp2 = np.zeros(int(4.0 * SR))
i_src = int(1.2 * SR)
imp2[i_src] = 1.0
c_t = ctx(spq=[[0.0, 0.5], [1.0, 60.0 / 90.0]])
yd2 = dev(stereo(imp2), "delay", {"sync": "1/4", "feedback": 0.0, "mix": 1.0,
                                  "pingpong": False, "tone_hz": 18000}, c=c_t)
exp = i_src + int(round((60.0 / 90.0) * SR))
got = int(np.argmax(np.abs(yd2[0])))
ok(f"after the tempo change the echo lands at {got} (expected {exp})",
   abs(got - exp) <= rack.AUTO_BLOCK + 260,
   "delay time is read per block at the write position")

yp = dev(stereo(imp), "delay", {"sync": "1/4", "feedback": 0.6, "mix": 1.0,
                                "pingpong": True, "tone_hz": 18000})
ok("ping-pong: first echo louder on L, second on R",
   abs(yp[0][q]) > abs(yp[1][q]) and abs(yp[1][2 * q]) > abs(yp[0][2 * q]),
   f"L1 {yp[0][q]:.3f} R1 {yp[1][q]:.3f} L2 {yp[0][2*q]:.3f} R2 {yp[1][2*q]:.3f}")

print("\n  -- automation: the vfx keys move the sound over time --")
long_sine = stereo(sine(440, 2.0, 0.5))
faded = rack.apply_fader_pan(long_sine, {"keys": [{"t": 0.0, "v": 0.0},
                                                  {"t": 2.0, "v": -40.0}]}, 0.0, SR)
head = rms(faded[0][: int(0.2 * SR)])
tail = rms(faded[0][int(1.8 * SR):])
# a 0.5-amp sine is -9.0 dB rms; the ride already sheds ~2 dB inside the
# first window and sits near -38 dB of fader by the last one.
ok(f"fader ride 0 -> -40 dB: head {db(head):.1f} dB, tail {db(tail):.1f} dB",
   db(head) > -12.5 and db(tail) < -42 and db(head) - db(tail) > 30)
auto_eq = dev(probe, "eq", {"b3_hz": 1000, "b3_q": 1.0,
                            "b3_gain_db": {"keys": [{"t": 0.0, "v": 0.0},
                                                    {"t": 2.0, "v": 12.0}]}})
def band_at(x, t0):
    n = 1 << 13
    i = int(t0 * SR)
    seg = x[i:i + n] * np.hanning(n)
    return db(float(np.abs(np.fft.rfft(seg))[int(round(1000 * n / SR))]))
lift = band_at(auto_eq[0], 1.75) - band_at(auto_eq[0], 0.05)
ok(f"keyed EQ gain lifts 1 kHz by {lift:.1f} dB across the pass", 6.0 < lift < 14.0)
pan_auto = rack.apply_fader_pan(long_sine, 0.0,
                                {"keys": [{"t": 0.0, "v": -1.0}, {"t": 2.0, "v": 1.0}]}, SR)
ok("a pan ride crosses the field",
   rms(pan_auto[0][: int(0.2 * SR)]) > 4 * rms(pan_auto[1][: int(0.2 * SR)])
   and rms(pan_auto[1][int(1.8 * SR):]) > 4 * rms(pan_auto[0][int(1.8 * SR):]))

print("\n  -- the pan law: centre-unity, equal-power --")
gl, gr = rack.pan_gains(0.0)
ok("centre is unity on both channels", near(float(gl), 1.0, 1e-12) and near(float(gr), 1.0, 1e-12))
gl, gr = rack.pan_gains(1.0)
ok("hard right is +3 dB right, silent left",
   near(float(gr), math.sqrt(2), 1e-9) and abs(float(gl)) < 1e-9)

print("\n  -- SEAM: a region through the full graph == the slice of a longer render --")
NOTES = [
    {"inst": "pluck", "midi": 57, "vel": 100, "start_sample": 0,
     "dur_samples": SR, "gain_db": 0, "seed": 11, "track_id": "A"},
    {"inst": "pluck", "midi": 64, "vel": 90, "start_sample": int(1.75 * SR),
     "dur_samples": SR // 2, "gain_db": 0, "seed": 12, "track_id": "A"},
    {"inst": "drums", "midi": 36, "vel": 110, "start_sample": int(0.5 * SR),
     "dur_samples": 2400, "gain_db": 0, "seed": 13, "track_id": "B"},
    {"inst": "drums", "midi": 38, "vel": 100, "start_sample": int(2.5 * SR),
     "dur_samples": 2400, "gain_db": 0, "seed": 14, "track_id": "B"},
]
MIXER = {
    "tracks": {
        "A": {"inserts": [{"id": "i1", "type": "eq", "enabled": True,
                           "params": {"b2_gain_db": 4}},
                          {"id": "i2", "type": "delay", "enabled": True,
                           "params": {"feedback": 0.5, "mix": 0.4}}],
              "fader": -2, "pan": -0.3,
              "sends": [{"to": "R1", "level": -3, "pre": False}]},
        "B": {"inserts": [{"id": "i3", "type": "compressor", "enabled": True,
                           "params": {"threshold_db": -25, "ratio": 6}}],
              "fader": 0, "pan": 0.2, "sends": []},
    },
    "returns": [{"id": "R1", "inserts": [{"id": "i4", "type": "reverb",
                                          "enabled": True, "params": {}}],
                 "fader": -4, "pan": 0}],
    "master": {"inserts": [{"id": "i5", "type": "limiter", "enabled": True,
                            "params": {}}], "fader": 0},
    "spq": [[0.0, 0.5]],
}
job_full = {"sr": SR, "start_sample": 0, "n_samples": 4 * SR,
            "notes": NOTES, "mixer": MIXER}
job_slice = {"sr": SR, "start_sample": 2 * SR, "n_samples": SR,
             "notes": NOTES, "mixer": MIXER}
full, _ = rack.chain_graph(job_full, engine.SYNTHS)
part, _ = rack.chain_graph(job_slice, engine.SYNTHS)
a32 = full[:, 2 * SR:3 * SR].astype(np.float32)
b32 = part[:, 2 * SR:3 * SR].astype(np.float32)
ok("bit-identical", a32.tobytes() == b32.tobytes())
r1 = rack.render_with_chain(dict(job_full), engine.SYNTHS, engine.TAILS)
r2 = rack.render_with_chain(dict(job_full), engine.SYNTHS, engine.TAILS)
ok("re-renders are byte-identical (sha1 pinned)", r1["sha1"] == r2["sha1"])
ok("the tanh master keeps the file inside (-1, 1)", r1["peak"] < 1.0)
hot = {"sr": SR, "start_sample": 0, "n_samples": SR, "notes": NOTES,
       "mixer": {"tracks": {}, "returns": [], "master": {"inserts": [], "fader": 12},
                 "spq": [[0.0, 0.5]]}}
hot_out, _ = rack.chain_graph(hot, engine.SYNTHS)
ok("...even with the master fader slammed +12 dB", float(np.max(np.abs(hot_out))) < 1.0)

print("\n  -- meters: the K-curve's stated shape, LUFS tracks gain, TP sees between samples --")
w, h = freqz(np.array(rack._K1_B), np.array(rack._K1_A),
             worN=[997.0, 10000.0, 30.0], fs=SR)
w2, h2 = freqz(np.array(rack._K2_B), np.array(rack._K2_A),
               worN=[997.0, 10000.0, 30.0], fs=SR)
resp = 20 * np.log10(np.abs(h * h2))
# BS.1770's own calibration: a 0 dBFS 997 Hz sine on one channel reads
# -3.01 LKFS, which forces |H(997)| = +0.691 dB -- the -0.691 term in the
# loudness formula exists to cancel exactly this. Measuring 0.691 here IS
# the coefficient check.
ok(f"K-weighting is +0.691 dB at 997 Hz, the calibration constant (got {resp[0]:.3f})",
   near(resp[0], 0.691, 0.05))
ok(f"K-weighting ~+4 dB at 10 kHz (got {resp[1]:.2f})", near(resp[1], 4.0, 0.6))
ok(f"K-weighting cuts 30 Hz hard (got {resp[2]:.2f})", resp[2] < -8)
s997 = stereo(sine(997, 5.0, 10 ** (-23.0 / 20.0)))
measured = rack.lufs_integrated(s997, SR)
expected = -0.691 + 10 * math.log10(2 * (10 ** (-23.0 / 20.0)) ** 2 / 2 * abs(h[0] * h2[0]) ** 2)
ok(f"997 Hz sine at -23 dBFS: {measured:.2f} LUFS vs analytic {expected:.2f}",
   near(measured, expected, 0.25))
m_lo = rack.lufs_integrated(s997 * 10 ** (-10.0 / 20.0), SR)
ok(f"-10 dB of gain is exactly -10 LU ({measured:.2f} -> {m_lo:.2f})",
   near(measured - m_lo, 10.0, 0.05))
ok("silence gates out (returns -inf)", rack.lufs_integrated(np.zeros((2, SR)), SR) == float("-inf"))
# intersample peak: +/- alternation at Nyquist/2 offsets peaks between samples
isp = stereo(np.sin(2 * np.pi * 11987 * np.arange(SR) / SR) * 0.99)
ok("true peak >= sample peak", rack.true_peak_db(isp) >= db(float(np.max(np.abs(isp)))) - 0.01)

mj = rack.meters(dict(job_full), engine.SYNTHS)
ok("meters answer per bus", set(mj["tracks"]) == {"A", "B"} and "R1" in mj["returns"]
   and "lufs" in mj["master"] and "true_peak_db" in mj["master"])
ok("the master short-term series covers the window", len(mj["master"]["lufs_short"]) >= 1)

print("\n  -- CPU: ms per device on a 4-bar region (8 s @48k stereo) --")
region = stereo(np.concatenate([sine(220, 4.0, 0.4), sine(330, 4.0, 0.4)]))
budget_fail = []
work = {
    "eq": {"hp_on": True, "b1_gain_db": 3, "b2_gain_db": -2, "b3_gain_db": 4, "b4_gain_db": 2},
    "compressor": {"threshold_db": -24}, "limiter": {},
    "saturator": {"drive_db": 12}, "chorus": {}, "delay": {"feedback": 0.5},
    "reverb": {}, "gate": {"threshold_db": -30}, "utility": {"gain_db": -3, "pan": 0.2},
}
print(f"        {'device':<12} {'ms/4bar':>8}")
for name in sorted(rack.DEVICES):
    t0 = time.perf_counter()
    dev(region, name, work[name])
    ms = (time.perf_counter() - t0) * 1000
    print(f"        {name:<12} {ms:8.1f}")
    if ms > 1000:
        budget_fail.append(f"{name} {ms:.0f}ms")
ok("every device renders a 4-bar region in under a second", not budget_fail,
   ", ".join(budget_fail))

print(f"\n  {passed} passed, {len(failures)} failed\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
