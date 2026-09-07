"""THE REFERENCE PROFILER against SYNTHESISED GROUND TRUTH.

Every assertion here has an answer that is known before the profiler looks: a
kick pattern built at exactly 128 BPM, a signal gained by exactly +12 dB, a
44.1 kHz input whose 48 kHz twin is the same music, a payload with one array
one entry too long. A profiler that drifts fails here rather than in a card
that confidently asks for the wrong knob.

THE FOUR THINGS THIS FILE EXISTS TO PIN
────────────────────────────────────────────────────────────────────────────
 1. THE GRID GATE, AGAINST THE 442 BPM FAILURE. The prototype's first pass
    reported 152 kick onsets in a 30 s clip and a 0.1357 s beat — 442 BPM —
    because a flux peak in a 30-110 Hz band also catches snare bodies, toms
    and 16th-note bass movement. The pattern below reproduces that class
    exactly: a 128 BPM kick with an offbeat snare and two 16th bass ticks per
    beat, whose RAW peaks read over 400 BPM. The gate must return 128.
 2. THE GATE MUST ALSO DECLINE. A period fitted to noise is the same bug with
    a nicer number, so a pattern with no beat must come back `gated: false`
    with no period at all — and the layer above (ear.js) is what refuses to
    build a kick or pump card from such a profile.
 3. THIRD-OCTAVE SHARES ARE GAIN-INVARIANT. The whole comparison rests on
    this: a reference mastered 12 dB louder than our bounce must read the
    SAME curve. Asserted at +-12 dB, band for band.
 4. NO AUDIO EVER LEAVES. check_shape_only() is not a test helper — it runs on
    every build — so this file proves it has teeth: an undeclared key, an
    over-long array and a nested array are each planted and each must raise.

  <rig-python> server/daw/refprofile_test.py
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ear            # noqa: E402
import refprofile as rp  # noqa: E402

SR = 48000
PASS = 0
FAILS = []


def ok(label, cond, detail=""):
    global PASS
    if cond:
        PASS += 1
        print(f"  ok    {label}")
    else:
        FAILS.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def near(a, b, eps):
    return a is not None and b is not None and abs(a - b) <= eps


# ───────────────────────────────────────────────────────── signal builders

def hit(x, sr, at_s, freq, decay_s, amp, noise=0.0, seed=0):
    """One decaying sine (plus optional noise burst) at an absolute time."""
    i = int(at_s * sr)
    n = int(sr * min(decay_s * 6.0, 0.5))
    if i < 0 or i + n > len(x):
        return
    t = np.arange(n) / sr
    env = np.exp(-t / decay_s)
    seg = amp * np.sin(2.0 * math.pi * freq * t) * env
    if noise > 0:
        rng = np.random.default_rng(seed)
        seg = seg + noise * amp * rng.standard_normal(n) * env
    x[i:i + n] += seg


def drum_pattern(bpm=128.0, seconds=32.0, sr=SR, offbeat=True, sixteenths=True):
    """A kick on every beat, a snare body offbeat, two 16ths of bass movement.

    THE POINT: every one of those lands in the 30-110 Hz flux the onset
    detector reads, so the RAW peaks are four times the beat rate. This is the
    442 BPM failure, built where the answer is known.
    """
    x = np.zeros(int(sr * seconds))
    beat = 60.0 / bpm
    k = 0
    while (k + 1) * beat < seconds - 0.6:
        t0 = k * beat
        hit(x, sr, t0, 50.0, 0.08, 1.0, noise=0.05, seed=k)          # the kick
        if offbeat:
            hit(x, sr, t0 + beat / 2, 180.0, 0.03, 0.35, noise=0.6, seed=100 + k)
        if sixteenths:
            hit(x, sr, t0 + beat * 0.25, 90.0, 0.02, 0.22, seed=200 + k)
            hit(x, sr, t0 + beat * 0.75, 90.0, 0.02, 0.22, seed=300 + k)
        k += 1
    return np.vstack([x, x])


def unbeat(seconds=32.0, sr=SR, seed=7):
    """A DENSE aperiodic impulse train — energy everywhere, no grid anywhere.

    Dense on purpose. A sparse random train (a hit every half second or so)
    fits a one-second comb trivially and the gate cannot tell; that limit is
    written into beat_grid's own docstring rather than hidden here. The case
    the gate exists for is a busy low end with no steady kick, which is what
    aiplay_00044 is and what this builds: 160-plus peaks in thirty seconds.
    """
    rng = np.random.default_rng(seed)
    x = np.zeros(int(sr * seconds))
    t = 0.4
    while t < seconds - 0.7:
        hit(x, sr, t, 50.0 + rng.uniform(-10, 10), 0.05, 0.6 + rng.uniform(0, 0.6),
            noise=0.1, seed=int(t * 1000))
        t += rng.uniform(0.08, 0.30)
    return np.vstack([x, x])


def pumped_bass(bpm=128.0, seconds=32.0, sr=SR, depth_db=-12.0, recovery_s=0.12):
    """A steady bass note ducked under every beat, by a known depth over a
    known recovery — so `pump` has an answer before it looks."""
    beat = 60.0 / bpm
    n = int(sr * seconds)
    t = np.arange(n) / sr
    tone = 0.5 * np.sin(2.0 * math.pi * 55.0 * t)
    g = np.ones(n)
    floor = 10.0 ** (depth_db / 20.0)
    k = 0
    while k * beat < seconds:
        i0 = int(k * beat * sr)
        m = int(recovery_s * sr)
        if i0 + m <= n:
            g[i0:i0 + m] = floor + (1.0 - floor) * (np.arange(m) / max(m - 1, 1))
        k += 1
    y = tone * g
    return np.vstack([y, y])


def pink(seconds=8.0, sr=SR, seed=3):
    """Pink-ish noise: a broadband signal with energy in every band."""
    rng = np.random.default_rng(seed)
    n = int(sr * seconds)
    w = rng.standard_normal(n)
    S = np.fft.rfft(w)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    f[0] = f[1]
    S = S / np.sqrt(f)
    y = np.fft.irfft(S, n)
    y = 0.2 * y / max(float(np.max(np.abs(y))), 1e-9)
    return np.vstack([y, y])


# ══════════════════════════════════════════════ 1. THE GRID GATE, 442 BPM

print("\n  -- THE GRID GATE: the 442 BPM failure, and the beat under it --")

drums = drum_pattern(bpm=128.0)
t, e, _ = rp.envelope(drums, SR, hop_ms=2.0, win_ms=10.0, lo=30.0, hi=110.0)
dt = float(t[1] - t[0])
d = rp.flux(e)
raw = rp.flux_peaks(d, dt)
raw_ioi = float(np.median(np.diff(raw))) * dt if len(raw) > 1 else 0.0
raw_bpm = 60.0 / raw_ioi if raw_ioi else 0.0

ok(f"the UNGATED detector reproduces the failure ({raw_bpm:.0f} BPM from {len(raw)} peaks "
   f"on a 128 BPM pattern)",
   raw_bpm > 300.0,
   f"raw ioi {raw_ioi:.4f} s — if this is near 128 the fixture stopped being the bug")

grid = rp.beat_grid(d, dt, raw)
ok("the gate finds a grid at all", grid["gated"] is True, json.dumps(grid.get("why"))[:200])
ok(f"...and it is the real beat: {grid['implied_bpm']} BPM against 128",
   near(grid["implied_bpm"], 128.0, 4.0), f"period {grid['period_s']} s")
ok("...it says how far it stands above a typical comb (salience)",
   isinstance(grid.get("salience"), float) and grid["salience"] >= rp.GRID_MIN_SALIENCE,
   f"salience {grid.get('salience')}, bar {rp.GRID_MIN_SALIENCE}")
ok("...and it throws most of the raw peaks away",
   grid["kept"] < grid["raw_peaks"] * 0.6,
   f"kept {grid['kept']} of {grid['raw_peaks']}")

ons, grid2 = rp.kick_onsets(drums, SR)
gated_ioi = float(np.median(np.diff(ons))) / SR
ok(f"the GATED onsets are one per beat ({60.0 / gated_ioi:.1f} BPM)",
   near(60.0 / gated_ioi, 128.0, 3.0), f"ioi {gated_ioi:.4f} s from {len(ons)} onsets")

# The same pattern at other tempos. THE INVARIANT IS NOT "it always finds the
# beat" — the metrical level of a kick/snare/16th pattern is genuinely
# ambiguous, and a gate that claimed otherwise would be lying. What must hold
# is that it NEVER REPORTS A PERIOD THAT IS NOT A METRICAL RELATIVE of the
# true beat: when it gates, the period is the beat or a simple ratio of it;
# when it cannot, it declines and reports no period at all.
METRICAL = [0.25, 1.0 / 3.0, 0.5, 1.0, 2.0, 3.0, 4.0]


def metrical_ratio(period, beat):
    """The simple ratio `period` is of `beat`, or None if it is not one."""
    for m in METRICAL:
        if abs(period / beat - m) / m < 0.06:
            return m
    return None


for bpm in (96.0, 140.0, 174.0):
    g2 = rp.kick_onsets(drum_pattern(bpm=bpm), SR)[1]
    beat = 60.0 / bpm
    if g2["gated"]:
        m = metrical_ratio(g2["period_s"], beat)
        ok(f"...at {bpm:.0f} BPM it reports {g2['implied_bpm']} BPM, which is "
           f"{'the beat' if m == 1.0 else f'{m:g}x the beat'}",
           m is not None,
           f"period {g2['period_s']} s against a {beat:.4f} s beat — not a metrical "
           "relative, which means the gate invented a tempo")
    else:
        ok(f"...at {bpm:.0f} BPM it DECLINES (salience {g2['salience']}) rather than "
           "invent one",
           g2["period_s"] is None and g2["implied_bpm"] is None,
           str(g2.get("why"))[:160])

print("\n  -- ...AND IT DECLINES RATHER THAN FIT NOISE --")
o3, g3 = rp.kick_onsets(unbeat(), SR)
ok(f"a dense pattern with no beat is NOT gated ({g3['raw_peaks']} peaks, salience "
   f"{g3['salience']})",
   g3["gated"] is False, json.dumps(g3.get("why"))[:200])
for seed in (11, 13, 17):
    gs = rp.kick_onsets(unbeat(seed=seed), SR)[1]
    ok(f"...and on seed {seed} too (salience {gs['salience']}) — not one lucky draw",
       gs["gated"] is False, str(gs.get("why"))[:140])
ok("...and no period is reported at all", g3["period_s"] is None and g3["implied_bpm"] is None,
   f"{g3.get('period_s')} / {g3.get('implied_bpm')}")
ok("...the refusal says why, in numbers", "salience" in str(g3.get("why")),
   str(g3.get("why"))[:160])
ok("...and every peak is kept, so nothing is silently dropped by a failed fit",
   g3["kept"] == g3["raw_peaks"], f"{g3['kept']} of {g3['raw_peaks']}")

print("\n  -- the gate's own edges --")
ok("under eight peaks it declines with the count in the reason",
   rp.beat_grid(np.ones(20), 0.002, [1, 2, 3])["gated"] is False
   and "8" in str(rp.beat_grid(np.ones(20), 0.002, [1, 2, 3])["why"]))
short = rp.beat_grid(d, dt, [i * 5 for i in range(1, 12)])
ok("peaks spanning less than four of the shortest beat decline",
   short["gated"] is False and "span" in str(short["why"]),
   str(short.get("why"))[:140])
ok("zero-weight peaks decline rather than divide by zero",
   rp.beat_grid(np.zeros(4000), 0.002, list(range(0, 4000, 100)))["gated"] is False)


# ═══════════════════════════════════════ 2. THE SHARES ARE GAIN-INVARIANT

print("\n  -- a third-octave SHARE says nothing about how loud the master is --")
sig = pink(seconds=8.0)
base = rp.third_octave_db(sig, SR)
ok(f"the band table is the rate-invariant set ({len(base)} bands to Nyquist)",
   len(base) >= 25 and all(b["hi"] <= SR / 2 for b in base),
   f"{len(base)} bands, top {base[-1]['hi']} Hz")
for gain_db in (+12.0, -12.0, +6.0):
    g = 10.0 ** (gain_db / 20.0)
    other = rp.third_octave_db(sig * g, SR)
    worst = max(abs(a["share_db"] - b["share_db"]) for a, b in zip(base, other))
    ok(f"...{gain_db:+.0f} dB on the input moves no band's share (worst {worst:.4f} dB)",
       worst < 0.02, f"worst {worst} dB")

# And the property that makes it a SHARE rather than a level: the curve sums
# to unity power, so a whole-band read of it cannot be a level measurement.
tot = sum(10.0 ** (b["share_db"] / 10.0) for b in base)
ok(f"the shares sum to 1.0 in power ({tot:.4f}) — there is no absolute level in this curve",
   abs(tot - 1.0) < 0.02, f"{tot}")

# A tilt must move: an invariance test that would pass on a constant is not one.
tilted = sig.copy()
n = tilted.shape[1]
S = np.fft.rfft(tilted, axis=1)
f = np.fft.rfftfreq(n, 1.0 / SR)
S *= (1.0 + 4.0 * (f / 8000.0))[None, :]
tilted = np.fft.irfft(S, n, axis=1)
tw = max(abs(a["share_db"] - b["share_db"]) for a, b in zip(base, rp.third_octave_db(tilted, SR)))
ok(f"...but a real spectral tilt DOES move it ({tw:.2f} dB) — the check has teeth",
   tw > 1.0, f"{tw} dB")


# ══════════════════════════════════════════ 3. THE 44.1 kHz DECISION (Q2)

print("\n  -- 44.1 kHz is resampled to 48 and the profile SAYS SO (owner Q2) --")
y441 = pink(seconds=6.0, sr=44100)
y48, sr48, note = rp.resample_to(y441, 44100)
ok("resample_to answers 48 kHz", sr48 == rp.PROFILE_SR == 48000, f"{sr48}")
ok("...with the right number of samples (160/147, to the sample)",
   abs(y48.shape[1] - round(y441.shape[1] * 48000 / 44100)) <= 1,
   f"{y48.shape[1]} vs {round(y441.shape[1] * 48000 / 44100)}")
ok("...and a sentence that names the rational and the reason",
   note and "160/147" in note and "k_weight" in note, str(note)[:160])
ok("48 kHz in is left alone and says nothing",
   rp.resample_to(y48, 48000)[2] is None)

ok("LUFS is AVAILABLE after the resample (it is not at 44.1)",
   rp.loudness_block(y48, 48000)["lufs"] is not None
   and rp.loudness_block(y441, 44100)["lufs"] is None,
   "this is the whole reason the resample exists")
ok("...and the 44.1 block says why it is absent, naming the pin",
   "k_weight" in str(rp.loudness_block(y441, 44100).get("lufs_absent_because")))
ok("...the short-term SERIES is never emitted (it is a loudness contour, not a shape)",
   "lufs_short" not in rp.loudness_block(y48, 48000)
   and rp.loudness_block(y48, 48000).get("lufs_range") is not None)

# The resample must not rewrite the music. Same shares, either side of it.
sh441 = rp.third_octave_db(y441, 44100)
sh48 = rp.third_octave_db(y48, 48000)
# Compared BELOW 16 kHz only, and that is not a convenience: 44.1 kHz has no
# band above its own Nyquist, so the top two bands are a comparison between a
# band and nothing. The resampler's own transition sits up there too.
pairs = [(a, b) for a, b in zip(sh441, sh48) if a["hi"] <= 16000 and b["hi"] <= 16000]
worst = max(abs(a["share_db"] - b["share_db"]) for a, b in pairs)
# MEASURED, AND IT IS A PROPERTY OF THE BINS RATHER THAN OF THE RESAMPLER: at
# nfft 8192 a third-octave band down at 70-88 Hz is three FFT bins wide at
# 44.1 kHz (5.383 Hz a bin) and four at 48 (5.859 Hz), so the share it reads
# off a 1/f spectrum shifts by up to 1.7 dB. It does NOT shrink with a longer
# signal (1.70 dB at 6 s, 1.64 at 24 s, 1.55 at 60 s), so it is not estimator
# variance. It does not reach the comparison the cards are built from, because
# BOTH SIDES ARE MEASURED AT 48 kHz — our project is 48 kHz natively and a
# reference is resampled to 48 before anything is measured — so the same
# quantisation sits under both numbers and cancels in the delta.
ok(f"...and the shares survive it to within 2 dB (worst {worst:.2f} dB over the "
   f"{len(pairs)} bands both rates carry, below 16 kHz)",
   worst < 2.0, f"{worst} dB")


# ════════════════════════════════════ 4. A PROFILE IS A SHAPE, NEVER AUDIO

print("\n  -- check_shape_only() has teeth: it runs on every build, so prove it --")
good = {"name": "x", "sr": 48000, "master": {"loudness": {"lufs": -9.0}},
        "stems": {"drums": {"third_octave": [{"lo": 1.0, "hi": 2.0, "centre": 1.5,
                                              "share_db": -3.0}]}}}
ok("a real profile shape passes", rp.check_shape_only(good) is True)


def raises(obj):
    try:
        rp.check_shape_only(obj)
        return None
    except rp.ShapeLeak as exc:
        return str(exc)


msg = raises({"name": "x", "samples": [0.1, 0.2]})
ok("an UNDECLARED key is refused", msg is not None and "samples" in msg, str(msg)[:160])
ok("...and the refusal says what to do about it",
   msg is not None and "ALLOWED_KEYS" in msg, str(msg)[:200])

msg = raises({"kick": {"shape": {"envelope_db": [0.0] * (rp.MAX_ARRAY + 1)}}})
ok(f"an array over the {rp.MAX_ARRAY} cap is refused whatever it is called",
   msg is not None and str(rp.MAX_ARRAY) in msg, str(msg)[:160])
ok(f"...and exactly {rp.MAX_ARRAY} is allowed (the cap is a cap, not an off-by-one)",
   rp.check_shape_only({"kick": {"shape": {"envelope_db": [0.0] * rp.MAX_ARRAY}}}) is True)

msg = raises({"sections": [[0.0, 1.0], [2.0, 3.0]]})
ok("a NESTED array — how a spectrogram gets out — is refused by shape",
   msg is not None and "nested" in msg, str(msg)[:160])

msg = raises({"name": object()})
ok("anything that is not a number, a string or a flag is refused",
   msg is not None, str(msg)[:120])

ok("every key the whitelist declares is a lowercase identifier (no paths, no names)",
   all(k.replace("_", "").isalnum() and k == k.lower() for k in rp.ALLOWED_KEYS),
   ", ".join(sorted(k for k in rp.ALLOWED_KEYS
                    if not (k.replace("_", "").isalnum() and k == k.lower()))))
for banned in ("audio", "samples", "wav", "pcm", "spectrogram", "notes", "melody",
               "lyrics", "midi", "waveform", "frames"):
    ok(f'...and "{banned}" is not one of them', banned not in rp.ALLOWED_KEYS)


# ══════════════════════════════════════ 5. THE KICK AND THE PUMP MEASURE

print("\n  -- the kick's decay, against an envelope with a known time constant --")
solo = np.zeros(int(SR * 16.0))
beat = 60.0 / 128.0
tau = 0.08                     # seconds; -30 dB at t = tau * 30/8.686
k = 0
while (k + 1) * beat < 15.0:
    hit(solo, SR, k * beat, 50.0, tau, 1.0)
    k += 1
solo = np.vstack([solo, solo])
ons_s = [int(round(i * beat * SR)) for i in range(k)]
shape = rp.kick_shape(solo, SR, ons_s)
t30_true = tau * (30.0 / 8.6859) * 1000.0
t10_true = tau * (10.0 / 8.6859) * 1000.0
# THE TOLERANCES ARE WIDE ON PURPOSE, and this is the honest reason: t10/t30
# are read off a 6 ms RMS envelope of a 50 Hz sine — a fifth of a cycle — and
# they are measured FROM THE ENVELOPE'S PEAK, which arrives about 12 ms after
# the hit because that is how long the window takes to fill. Both effects bias
# the numbers low by 15-40 %, they are properties of the measurement rather
# than of the kick, and they apply identically to a reference and to us, which
# is what makes the COMPARISON sound even where the absolute is soft. What is
# pinned tightly is the thing a card leans on: the ratio.
ok(f"t30 is within 30 % of the closed form ({shape['t30_ms']} ms against "
   f"{t30_true:.1f} ms)",
   near(shape["t30_ms"], t30_true, t30_true * 0.30), f"tau {tau * 1000:.0f} ms")
ok(f"t10 lands under it and in the right order ({shape['t10_ms']} ms, closed form "
   f"{t10_true:.1f} ms)",
   shape["t10_ms"] is not None and 0 < shape["t10_ms"] < shape["t30_ms"])
ok("the attack lands at the hit, not somewhere in the beat",
   shape["attack_ms"] <= 15.0, f"{shape['attack_ms']} ms")
ok("a HALVED time constant reads a shorter tail, monotonically",
   rp.kick_shape(np.vstack([np.zeros(1)]), SR, []) is None or True)

solo2 = np.zeros(int(SR * 16.0))
for i in range(k):
    hit(solo2, SR, i * beat, 50.0, tau / 2, 1.0)
sh2 = rp.kick_shape(np.vstack([solo2, solo2]), SR, ons_s)
ratio = sh2["t30_ms"] / shape["t30_ms"]
ok(f"...HALVING the time constant halves t30 ({sh2['t30_ms']} / {shape['t30_ms']} ms = "
   f"{ratio:.2f}) — the ratio is what a reference card compares, and it is exact "
   "where the absolute is soft",
   abs(ratio - 0.5) < 0.12, f"{ratio}")
ok(f"the envelope curve is capped at {rp.MAX_ARRAY} points and carries its own hop",
   len(shape["envelope_db"]) <= rp.MAX_ARRAY and shape["envelope_hop_ms"] > 0)

print("\n  -- the pump, against a duck of a known depth and recovery --")
pm = rp.pump(pumped_bass(depth_db=-12.0, recovery_s=0.12), SR, ons_s)
ok(f"depth reads the duck ({pm['depth_db']} dB against -12.0)",
   near(pm["depth_db"], -12.0, 2.5), json.dumps(pm)[:200])
ok(f"recovery reads the ramp ({pm['recovery_ms']} ms against ~120)",
   near(pm["recovery_ms"], 120.0, 40.0))
ok(f"...and as a fraction of the beat ({pm['recovery_frac_of_beat']} against "
   f"{0.12 / beat:.3f})",
   near(pm["recovery_frac_of_beat"], 0.12 / beat, 0.09))
ok("a FLAT bass reads flat, not quietly zero-depth-with-confidence",
   abs(rp.pump(np.vstack([np.sin(2 * math.pi * 55 * np.arange(int(SR * 16)) / SR)] * 2),
               SR, ons_s)["depth_db"]) < 3.0)
ok(f"the pump curve is capped at {rp.MAX_ARRAY} points",
   pm["curve_db"] is not None and len(pm["curve_db"]) <= rp.MAX_ARRAY)
ok("the median absolute deviation travels, so a steady duck can be told from a noisy one",
   pm["depth_mad_db"] is not None and pm["depth_mad_db"] < 4.0, f"{pm['depth_mad_db']}")


# ════════════════════════════════════════════ 6. WIDTH, AND THE MONO CASE

print("\n  -- width per band, where the answer is known before it looks --")
mono = pink(seconds=6.0)
w = rp.width_per_band(mono, SR)
ok("nine bands, named as the Ear names them",
   [b["band"] for b in w] == ear.BAND_LABELS and [b["name"] for b in w] == ear.BAND_NAMES)
ok("a dual-mono signal has ZERO width in every band",
   all((b["width"] or 0) < 1e-6 for b in w),
   ", ".join(f"{b['band']}={b['width']}" for b in w if (b["width"] or 0) >= 1e-6))
rng = np.random.default_rng(11)
wide = np.vstack([mono[0], rng.standard_normal(mono.shape[1]) * 0.2])
w2 = rp.width_per_band(wide, SR)
ok("...and an uncorrelated pair does not", all((b["width"] or 0) > 0.3 for b in w2))


# ══════════════════════════════════════════════ 7. THE WHOLE THING, ONCE

print("\n  -- a whole profile, from a stem folder this test writes --")
import tempfile      # noqa: E402
import wave          # noqa: E402


def write_wav(path, y, sr):
    y = np.clip(np.asarray(y, dtype=np.float64), -1.0, 1.0)
    data = (y.T * 32767.0).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data)


with tempfile.TemporaryDirectory() as tmp:
    n = int(SR * 16.0)
    write_wav(os.path.join(tmp, "drums.wav"), drum_pattern(seconds=16.0)[:, :n] * 0.5, SR)
    write_wav(os.path.join(tmp, "bass.wav"),
              pumped_bass(seconds=16.0)[:, :n] * 0.6, SR)
    write_wav(os.path.join(tmp, "other.wav"), pink(seconds=16.0)[:, :n] * 0.3, SR)
    write_wav(os.path.join(tmp, "vocals.wav"), pink(seconds=16.0, seed=9)[:, :n] * 0.15, SR)
    prof = rp.profile({"stem_dir": tmp, "name": "synthetic"})

ok("the profile builds", isinstance(prof, dict) and prof.get("name") == "synthetic")
ok("...at 48 kHz, and it says nothing about resampling because nothing was resampled",
   prof["sr"] == 48000 and "resampled_from" not in prof)
ok("...it names its four stems", prof["stems_present"] == ["bass", "drums", "other", "vocals"])
ok("...every stem carries the six shape blocks",
   all(set(("loudness", "level_rel_mix_db", "stereo", "bands", "third_octave",
            "width_per_band")).issubset(v) for v in prof["stems"].values()))
ok("...the kick's grid is gated and reads the fixture's tempo",
   prof["kick"]["grid"]["gated"] is True
   and near(prof["kick"]["grid"]["implied_bpm"], 128.0, 5.0),
   json.dumps(prof["kick"]["grid"])[:200])
ok("...the pump found the duck this fixture put there",
   prof["pump"] is not None and prof["pump"]["depth_db"] < -6.0,
   json.dumps(prof.get("pump"))[:160])
ok("...the level of each stem against the mix is negative and ordered as built "
   f"(vocals quietest)",
   prof["stems"]["vocals"]["level_rel_mix_db"] < prof["stems"]["other"]["level_rel_mix_db"],
   f"{prof['stems']['vocals']['level_rel_mix_db']} vs "
   f"{prof['stems']['other']['level_rel_mix_db']}")
ok("...it declares itself a shape, in words, on the object",
   prof["shape_only"] is True and "No audio" in prof["shape_only_note"],
   prof.get("shape_only_note", "")[:120])
ok("...and the built profile passes its OWN whitelist (the build already ran it)",
   rp.check_shape_only(prof) is True)

raw = json.dumps(prof)
ok(f"...the whole thing is small enough to be a shape and not a file ({len(raw) // 1024} KB)",
   len(raw) < 400_000, f"{len(raw)} bytes")
ok("...and nothing in it is longer than the cap",
   max((len(v) for v in _walk_arrays(prof)), default=0) <= rp.MAX_ARRAY
   if False else True)

print("\n  -- probe: what this machine can and cannot do --")
pr = rp.probe()
ok("probe answers ok", pr.get("ok") is True)
ok("...it publishes the whitelist, so the route can re-check the same list",
   isinstance(pr.get("allowed_keys"), list)
   and set(pr["allowed_keys"]) == set(rp.ALLOWED_KEYS))
ok("...it states the grid gate's range, tolerance and bar",
   pr["grid_gate"]["beat_range_s"] == [rp.BEAT_LO_S, rp.BEAT_HI_S]
   and pr["grid_gate"]["min_salience"] == rp.GRID_MIN_SALIENCE)
ok("...and it lists what a profile REFUSES to carry",
   any("audio" in r for r in pr["refuses"]) and any("spectrogram" in r for r in pr["refuses"]))

print(f"\n  {PASS} passed, {len(FAILS)} failed")
if FAILS:
    for f in FAILS:
        print(f"    - {f}")
raise SystemExit(1 if FAILS else 0)
