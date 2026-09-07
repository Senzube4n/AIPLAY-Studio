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
  STEREO    mixer.stereo carries a voice's own channels into the inserts
            (a spread-0.8 lead keeps an L/R correlation near 0.6-0.7 at the
            bounce instead of 1.0); the switch OFF renders the sha1 that was
            PINNED on the mono-only rack, byte for byte; every dynamics
            device applies ONE gain to both channels; the seam proof holds
            under the switch.
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

print("\n  -- STEREO THROUGH THE RACK: the fold is pinned, the width survives the switch --")
# The fold is the default and its bytes are PINNED: two renders whose sha1
# was recorded on the mono-only rack, before mixer.stereo existed. A change
# to the mono path -- any change -- flips these before anyone listens. (A
# machine voice's bytes are part of the pin: a synths.py edit flips the
# second one too, and that is the point -- an existing project's cached
# regions and bounces must survive an engine commit unchanged.)
PIN_SEAM = "1f8849f7db844072bb2f78affc1240ef8178d582"
PIN_MACHINE = "bcafadfd7c1c9fe1df63b02706f86352a2a5f722"
ok("mixer.stereo absent: the seam job renders its PINNED sha1 (the fold, byte for byte)",
   r1["sha1"] == PIN_SEAM and r1["stereo"] is False, r1["sha1"])
SIX = int(60 / 128 / 4 * SR)                       # a 16th at 128 BPM
LEAD = [{"inst": "bigroom_lead", "midi": 65 + (0, 3, 7, 12)[i % 4], "vel": 110,
         "start_sample": i * SIX * 2, "dur_samples": SIX, "gain_db": 0, "seed": 1,
         "track_id": "lead", "params": {"spread": 0.8}} for i in range(16)]
KICK = [{"inst": "hybrid_kick", "midi": 36, "vel": 120, "start_sample": i * SIX * 4,
         "dur_samples": SIX, "gain_db": 0, "seed": 1, "track_id": "kick",
         "params": {"preset": "bigroom"}} for i in range(8)]
MX2 = {"tracks": {"lead": {"inserts": [{"id": "c", "type": "compressor", "enabled": True,
                                        "params": {"sidechain": "kick", "threshold_db": -20,
                                                   "ratio": 20, "attack_ms": 0.5,
                                                   "release_ms": 234}}],
                           "fader": -6, "pan": 0, "sends": []},
                  "kick": {"inserts": [], "fader": 0, "pan": 0, "sends": []}},
       "returns": [],
       "master": {"inserts": [{"id": "l", "type": "limiter", "enabled": True,
                               "params": {"ceiling_db": -1}}], "fader": 0},
       "spq": [[0.0, 60 / 128]]}
job_m = {"sr": SR, "start_sample": 0, "n_samples": SIX * 32, "notes": LEAD + KICK, "mixer": MX2}
rm = rack.render_with_chain(dict(job_m), engine.SYNTHS, engine.TAILS)
ok("a spread-0.8 lead + sidechained kick under the fold: PINNED sha1, stereo:false in the reply",
   rm["sha1"] == PIN_MACHINE and rm["stereo"] is False, rm["sha1"])
mono_out, mono_b = rack.chain_graph(job_m, engine.SYNTHS, capture=True)
ok("...and it is mono to the byte (L == R): the provers' finding, reproduced",
   np.array_equal(mono_out[0], mono_out[1]))
job_s = dict(job_m, mixer=dict(MX2, stereo=True))
st_out, st_b = rack.chain_graph(job_s, engine.SYNTHS, capture=True)
c_lead = rack.lr_correlation(st_b["tracks"]["lead"])
ok(f"mixer.stereo: the lead bus reads an L/R correlation of {c_lead:.2f} at the bounce -- "
   "the voice's 0.70 survives the compressor and the fader (not 1.00)", 0.35 < c_lead < 0.9)
ok("...the kick bus (a mono voice) stays exactly mono",
   np.array_equal(st_b["tracks"]["kick"][0], st_b["tracks"]["kick"][1]))
ok("...and the master is no longer L == R", not np.array_equal(st_out[0], st_out[1]))
rs = rack.render_with_chain(dict(job_s), engine.SYNTHS, engine.TAILS)
ok("the render reply says stereo:true and the bytes differ from the fold's",
   rs["stereo"] is True and rs["sha1"] != rm["sha1"])
ok("re-renders under the switch are byte-identical",
   rs["sha1"] == rack.render_with_chain(dict(job_s), engine.SYNTHS, engine.TAILS)["sha1"])
job_s0 = dict(job_s, notes=[dict(n, params={"spread": 0.0}) for n in LEAD] + KICK)
job_m0 = dict(job_m, notes=[dict(n, params={"spread": 0.0}) for n in LEAD] + KICK)
ok("a spread-0 lead renders the SAME bytes with the switch on and off -- the switch only "
   "carries what the voice has, and x+x then /2 is exact",
   rack.render_with_chain(dict(job_s0), engine.SYNTHS, engine.TAILS)["sha1"]
   == rack.render_with_chain(dict(job_m0), engine.SYNTHS, engine.TAILS)["sha1"])
# SEAM under the switch. This job has a kick on the downbeat of the NEXT
# region and a master limiter that engages on it, so the limiter's lookahead
# (5 ms) sees that kick in the full render and cannot in the region render:
# the last 2*lookahead (+ the 4x resampler's edge) samples of the window
# differ. That horizon is the LIMITER's, not the switch's -- the mono path
# differs at exactly the same samples (measured: 502 of 45 000, max 0.011)
# -- and it is pre-existing: the SEAM section above passes only because its
# limiter has nothing to do at its boundary. So the assertion here is the
# honest one: identical everywhere except inside the limiter's horizon, the
# horizon is the same set of samples on both paths, and with the master
# limiter out the stereo path seams bit for bit.
la_ = int(rack.CATALOG["limiter"]["params"]["lookahead_ms"]["default"] * 1e-3 * SR)
part_s, _ = rack.chain_graph(dict(job_s, start_sample=SIX * 16, n_samples=SIX * 8), engine.SYNTHS)
part_m, _ = rack.chain_graph(dict(job_m, start_sample=SIX * 16, n_samples=SIX * 8), engine.SYNTHS)
d_s = np.any(st_out[:, SIX * 16:SIX * 24].astype(np.float32)
             != part_s[:, SIX * 16:SIX * 24].astype(np.float32), axis=0)
d_m = np.any(mono_out[:, SIX * 16:SIX * 24].astype(np.float32)
             != part_m[:, SIX * 16:SIX * 24].astype(np.float32), axis=0)
horizon = SIX * 8 - (2 * la_ + 64)
ok(f"SEAM under the switch: the region window == the slice of the full stereo render, bit for bit, "
   f"except inside the master limiter's lookahead horizon at the window end ({int(d_s.sum())} "
   f"samples differ, all in the last {SIX * 8 - int(np.argmax(d_s)) if d_s.any() else 0})",
   not d_s[:horizon].any())
ok("...and that horizon is the LIMITER's, not the switch's: the mono path differs at the same samples",
   np.array_equal(d_s, d_m))
mx_nl = dict(job_s["mixer"], master={"inserts": [], "fader": 0})
full_nl, _ = rack.chain_graph(dict(job_s, mixer=mx_nl), engine.SYNTHS)
part_nl, _ = rack.chain_graph(dict(job_s, mixer=mx_nl, start_sample=SIX * 16, n_samples=SIX * 8),
                              engine.SYNTHS)
ok("...with the master limiter out, the stereo path seams bit for bit (compressor, sidechain, fader, tanh)",
   full_nl[:, SIX * 16:SIX * 24].astype(np.float32).tobytes()
   == part_nl[:, SIX * 16:SIX * 24].astype(np.float32).tobytes())
mt = rack.meters(job_s, engine.SYNTHS)
ok("meters carry the flag and an L/R correlation per bus (kick 1.0, lead < 0.9, master present)",
   mt["stereo"] is True and mt["tracks"]["kick"]["corr"] == 1.0
   and mt["tracks"]["lead"]["corr"] < 0.9 and mt["master"]["corr"] is not None)
ok("lr_correlation: silence is None (not 1.0), dual mono is 1.0",
   rack.lr_correlation(np.zeros((2, 100))) is None
   and rack.lr_correlation(stereo(sine(100, 0.1))) == 1.0)
# Dynamics under a stereo input: ONE gain, both channels. Decorrelated L/R,
# then the per-channel output/input ratio must agree wherever the input is
# not near zero -- compressor (own detector AND sidechained), gate, limiter.
t_ = np.arange(2 * SR) / SR
sq_a = 1 + 0.9 * np.sign(np.sin(2 * np.pi * 2 * t_))
sq_b = 1 + 0.9 * np.sign(np.sin(2 * np.pi * 2 * t_ + 0.7))
xs = np.vstack([np.sin(2 * np.pi * 220 * t_) * 0.45 * sq_a,
                np.sin(2 * np.pi * 331 * t_ + 1.0) * 0.4 * sq_b])
key = np.abs(np.sin(2 * np.pi * 3 * t_)) ** 8 * 0.9


def shared_gain_diff(y_, x_):
    m_ = (np.abs(x_[0]) > 1e-2) & (np.abs(x_[1]) > 1e-2)
    return float(np.max(np.abs(y_[0][m_] / x_[0][m_] - y_[1][m_] / x_[1][m_])))


for name_, params_, c_ in (("compressor", {"threshold_db": -20, "ratio": 8}, None),
                           ("compressor", {"threshold_db": -30, "ratio": 20, "sidechain": "K"},
                            ctx(dry={"K": key})),
                           ("gate", {"threshold_db": -12}, None),
                           ("limiter", {"ceiling_db": -12}, None)):
    d_ = shared_gain_diff(dev(xs, name_, params_, c=c_), xs)
    ok(f"{name_}{' (sidechained)' if 'sidechain' in params_ else ''} applies ONE gain to a "
       f"decorrelated stereo input (max L/R gain difference {d_:.1e})", d_ < 1e-9)
ok("dev_limiter is exactly x * limiter_gain (the factoring changed no byte)",
   np.array_equal(dev(xs, "limiter", {"ceiling_db": -12}),
                  xs * rack.limiter_gain(xs, rack.Params(rack.CATALOG["limiter"],
                                                          {"ceiling_db": -12}, SR), ctx())))

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
    # .get, not [] : master.py registers the mastering suite into this same
    # table, and those devices are timed (with their own working params) in
    # master_test.py. Timing them at defaults here is a free extra check;
    # crashing on a device this table has not heard of is not.
    dev(region, name, work.get(name, {}))
    ms = (time.perf_counter() - t0) * 1000
    print(f"        {name:<12} {ms:8.1f}")
    if ms > 1000:
        budget_fail.append(f"{name} {ms:.0f}ms")
ok("every device renders a 4-bar region in under a second", not budget_fail,
   ", ".join(budget_fail))


# ══════════════════════ [VOICELAB] render_stems, and the byte-identity ══════
#
# The constraint this whole feature is built under: nothing may change
# chain_graph's output bytes. The capture path grew one key (buses["mix"]),
# and the first two assertions below are the proof that costs nothing.

print("\n  -- [VOICELAB] capture is free: the mastered bytes do not move --")
cap_out, cap_b = rack.chain_graph(job_s, engine.SYNTHS, capture=True)
nocap_out, nocap_b = rack.chain_graph(job_s, engine.SYNTHS, capture=False)
ok("chain_graph(capture=True) and (capture=False) render the SAME mastered buffer, bit for bit",
   np.array_equal(cap_out, nocap_out))
ok("...and capture=False still returns no buses at all", nocap_b is None)
ok("the pinned stereo sha1 is unmoved by the capture addition",
   rack.render_with_chain(dict(job_s), engine.SYNTHS, engine.TAILS)["sha1"] == rs["sha1"], rs["sha1"])

print("\n  -- the lanes sum to the MIX, and the master sits on top of it --")
# chain_graph accumulates `mix` as: tracks in sorted(track_id) order, then
# returns in job order. Float addition is not associative, so re-adding in
# that ORDER is the claim, and bit-equality is what proves it.
summed = np.zeros_like(cap_b["mix"])
for _tid in sorted(cap_b["tracks"]):
    summed += cap_b["tracks"][_tid]
for _rid in cap_b["returns"]:
    summed += cap_b["returns"][_rid]
ok("sum(per-track buses) + sum(return buses) == the pre-master mix, BIT FOR BIT",
   np.array_equal(summed, cap_b["mix"]),
   f"max |diff| {float(np.max(np.abs(summed - cap_b['mix']))):.3e}")
ok("...and the MASTERED output is NOT that sum -- the differential guard that "
   "stops this suite passing on a master chain that is not in the signal path",
   not np.array_equal(cap_out, cap_b["mix"]))
_md = rack._err_to_sig_db(cap_out - cap_b["mix"], cap_b["mix"])
ok(f"the master stage moves the sum by {_md:.2f} dB error-to-signal (limiter + tanh)",
   math.isfinite(_md) and _md > -60.0, f"{_md}")

print("\n  -- render_stems writes one wav per track, and refuses what it cannot answer --")
import tempfile  # noqa: E402
with tempfile.TemporaryDirectory() as _td:
    rst = rack.render_stems(dict(job_s, out_dir=_td, prefix="reg7_1a2b3c4d5e6f_"),
                            engine.SYNTHS, engine.TAILS)
    names = sorted(os.listdir(_td))
    ok("one file per audible track, named <prefix>trk_<track_id>.wav",
       names == ["reg7_1a2b3c4d5e6f_trk_kick.wav", "reg7_1a2b3c4d5e6f_trk_lead.wav"], str(names))
    ok("no temp file is left behind (the write lands atomically, as regions do)",
       not any(n.startswith(".") or ".tmp-" in n for n in names))
    ok("the payload says the sum is the mix, and measures it rather than asserting it",
       rst["sums_to_mix"] is True and rst["residual_db"] is None)
    ok("...and it names what the lanes do NOT add up to",
       "PRE-MASTER" in rst["sums_to"] and "limiter" in rst["sums_to"])
    ok(f"the master delta travels in the payload ({rst['master_delta_db']} dB)",
       rst["master_delta_db"] is not None and rst["master_delta_db"] > -60.0)
    # The files ARE the buses: read one back and compare to the captured slice.
    _w0, _n = job_s["start_sample"], job_s["n_samples"]
    _lead = np.fromfile(os.path.join(_td, "reg7_1a2b3c4d5e6f_trk_lead.wav"),
                        dtype="<f4", offset=44)
    _want = cap_b["tracks"]["lead"][:, _w0:_w0 + _n].astype(np.float32)
    _got = np.vstack([_lead[0::2], _lead[1::2]])
    ok("the stem file on disk IS the captured bus, sample for sample",
       np.array_equal(_got, _want))
    # ...and the stems add back up to the mix through the FILES, not just in
    # memory: this is the assertion the per-track lanes' honesty rests on.
    _kick = np.fromfile(os.path.join(_td, "reg7_1a2b3c4d5e6f_trk_kick.wav"),
                        dtype="<f4", offset=44)
    _sum = np.vstack([_lead[0::2] + _kick[0::2], _lead[1::2] + _kick[1::2]])
    _mixw = cap_b["mix"][:, _w0:_w0 + _n]
    _err = rack._err_to_sig_db(_sum - _mixw, _mixw)
    ok(f"the FILES sum to the pre-master mix to {_err:.1f} dB error-to-signal "
       "(float32 rounding only -- the buses themselves were exact)",
       _err < -120.0, f"{_err}")
    ok("a `tracks` filter writes only the tracks asked for",
       len(rack.render_stems(dict(job_s, out_dir=_td, prefix="only_",
                                  tracks=["lead"]), engine.SYNTHS)["stems"]) == 1)

try:
    rack.render_stems({"sr": SR, "start_sample": 0, "n_samples": SR,
                       "notes": [], "out_dir": "."}, engine.SYNTHS)
    ok("a job with no mixer is refused", False, "it rendered")
except ValueError as exc:
    ok("a job with no mixer is REFUSED, and the refusal says why (no track_id "
       "on a P0 note) and what to do (send the mixer; a default one is a no-op)",
       "track_id" in str(exc) and "no-op" in str(exc), str(exc))
try:
    rack.render_stems(dict(job_s), engine.SYNTHS)
    ok("a job with no out_dir is refused", False, "it rendered")
except ValueError as exc:
    ok("a job with no out_dir is refused, naming out_dir", "out_dir" in str(exc))

print("\n  -- a track that is silent in the window is NAMED, not omitted quietly --")
with tempfile.TemporaryDirectory() as _td:
    _mx3 = dict(MX2, tracks=dict(MX2["tracks"],
                                 ghost={"inserts": [], "fader": 0, "pan": 0, "sends": []}))
    _r = rack.render_stems(dict(job_s, mixer=dict(_mx3, stereo=True),
                                out_dir=_td, prefix="g_"), engine.SYNTHS)
    ok("a mixer track with no notes in the window lands in silent_tracks",
       _r["silent_tracks"] == ["ghost"], str(_r["silent_tracks"]))
    ok("...and no empty file is written for it",
       not os.path.exists(os.path.join(_td, "g_trk_ghost.wav")))


print(f"\n  {passed} passed, {len(failures)} failed\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
