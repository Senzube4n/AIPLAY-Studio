"""Unit tests for server/vfx/audiokeys.py.

Everything here is synthesised, because the only way to check a measurement is
against a signal whose answer you already know: a 440 Hz tone with a triangular
envelope, a 60 Hz bass note, a 6 kHz tone, digital silence, and click tracks at
known tempi. Each is written to a WAV in a temp directory and analysed through
the real CLI path, so the decode is tested too.

The keys are read back with `interp.eval_prop` — the engine's OWN evaluator, not
a private copy. That is the assertion that matters: it is not enough for the
numbers to be right, they have to be right in a form the compositor can already
evaluate, which is the entire point of emitting VFX_SPEC §1's shape.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/audiokeys_test.py

The last section MEASURES rather than asserts — analysis wall time against a real
song — and prints it. A regression in speed should be visible without having to
guess a threshold that will be wrong on the next machine.
"""
import contextlib
import io
import json
import math
import os
import struct
import sys
import tempfile
import time
import wave

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import audiokeys  # noqa: E402
import interp     # noqa: E402

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
    eq(f"{name} (|{got:.4f} - {want:.4f}| <= {tol})", abs(got - want) <= tol, True)


SR = 44100


def write_wav(path, y, sr=SR):
    """16-bit mono PCM. stdlib `wave` rather than PyAV: the decode under test is
    audiokeys', and an encoder in the fixture is one more thing that can be the
    reason a test fails."""
    y = np.clip(np.asarray(y, dtype=np.float64), -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{y.size}h", *(y * 32767).astype(np.int16)))
    return path


def tone(freq, secs, amp=0.8, sr=SR, ramp=0.25):
    """A steady tone with cosine ends. The ramp is not cosmetic: an abrupt start
    is a click, and a click is broadband, which would put energy in every band of
    a test whose whole point is that it should be in one."""
    t = np.arange(int(secs * sr)) / sr
    y = np.sin(2 * np.pi * freq * t) * amp
    n = max(1, int(ramp * sr))
    w = np.hanning(2 * n)
    y[:n] *= w[:n]
    y[-n:] *= w[n:]
    return y


def clicks(bpm, secs, sr=SR, first=0.0):
    """A click track and the truth it was built from."""
    n = int(secs * sr)
    y = np.zeros(n)
    rng = np.random.default_rng(11)
    period = 60.0 / bpm
    truth = []
    t = first
    L = int(0.03 * sr)
    env = np.exp(-np.arange(L) / (0.005 * sr))
    while t < secs - 0.15:
        i = int(round(t * sr))
        burst = (rng.standard_normal(L) * 0.5 + np.sin(2 * np.pi * 1400 * np.arange(L) / sr)) * env
        y[i:i + L] += burst[:max(0, min(L, n - i))]
        truth.append(t)
        t += period
    return y / (np.abs(y).max() + 1e-9) * 0.9, truth


def sample(track, t):
    return float(interp.eval_prop(track, t))


def values(track):
    return [k["v"] for k in track["keys"]]


print("\naudiokeys\n")

with tempfile.TemporaryDirectory() as tmp:

    # -- amplitude tracks a known envelope ------------------------------------
    # A triangle from 0 up to 1 at 3 s and back down at 6 s. Linear curve,
    # unsmoothed, unthinned: this is the one configuration where the output is
    # supposed to equal the input envelope, so it is where an error in the
    # windowing or the normalisation has nowhere to hide.
    secs = 6.0
    t = np.arange(int(secs * SR)) / SR
    shape = np.minimum(t / 3.0, (secs - t) / 3.0)
    write_wav(os.path.join(tmp, "tri.wav"), np.sin(2 * np.pi * 440 * t) * shape)
    tri = audiokeys.analyse({"audio": os.path.join(tmp, "tri.wav"), "fps": 30,
                             "curve": "linear", "smooth": False, "epsilon": 0.0,
                             "beats": False})
    amp = tri["tracks"]["amplitude"]
    eq("one key per frame when nothing is thinned", len(amp["keys"]), tri["frames"])
    for at, want in ((0.75, 0.25), (1.5, 0.5), (3.0, 1.0), (4.5, 0.5), (5.25, 0.25)):
        near(f"amplitude at {at}s follows the envelope", sample(amp, at), want, 0.05)
    eq("amplitude never exceeds 1", max(values(amp)) <= 1.0, True)

    # The dB curve is the DEFAULT and cannot equal a linear envelope — but it
    # must still be monotone in the same order, or it is not a level at all.
    tri_db = audiokeys.analyse({"audio": os.path.join(tmp, "tri.wav"), "fps": 30,
                                "smooth": False, "epsilon": 0.0, "beats": False})
    a_db = tri_db["tracks"]["amplitude"]
    eq("the dB curve rises with the envelope",
       sample(a_db, 0.75) < sample(a_db, 1.5) < sample(a_db, 3.0), True)
    eq("the dB curve reads higher than linear at the same quiet point",
       sample(a_db, 0.75) > sample(amp, 0.75), True)

    # -- bands ----------------------------------------------------------------
    write_wav(os.path.join(tmp, "bass.wav"), tone(60.0, 6.0))
    b = audiokeys.analyse({"audio": os.path.join(tmp, "bass.wav"), "fps": 30,
                           "beats": False})
    steady = (1.5, 2.5, 3.5, 4.5)
    eq("a 60Hz tone fills the bass band",
       min(sample(b["tracks"]["bass"], at) for at in steady) > 0.9, True)
    eq("a 60Hz tone leaves treble at the floor",
       max(values(b["tracks"]["treble"])), 0.0)
    eq("and says so rather than silently blanking it",
       "treble" in b["silentBands"], True)
    eq("bass is reported as louder than the whole mix", b["bandDb"]["bass"] > 0, True)
    eq("treble is reported far under it", b["bandDb"]["treble"] < -60.0, True)

    write_wav(os.path.join(tmp, "air.wav"), tone(6000.0, 6.0))
    a = audiokeys.analyse({"audio": os.path.join(tmp, "air.wav"), "fps": 30,
                           "beats": False})
    eq("a 6kHz tone fills the treble band",
       min(sample(a["tracks"]["treble"], at) for at in steady) > 0.9, True)
    eq("a 6kHz tone leaves bass at the floor", max(values(a["tracks"]["bass"])), 0.0)
    eq("the crossovers are the ones documented",
       audiokeys.BANDS, {"bass": (20.0, 160.0), "lowMid": (160.0, 800.0),
                         "highMid": (800.0, 3000.0), "treble": (3000.0, 11000.0)})

    # -- silence --------------------------------------------------------------
    write_wav(os.path.join(tmp, "sil.wav"), np.zeros(int(3 * SR)))
    s = audiokeys.analyse({"audio": os.path.join(tmp, "sil.wav"), "fps": 30,
                           "floor": 0.25})
    flat = set()
    nan = False
    for name, tr in s["tracks"].items():
        for v in values(tr):
            flat.add(round(v, 6))
            nan = nan or (v != v)
    eq("silence yields exactly the floor", flat, {0.25})
    eq("silence yields no NaN", nan, False)
    s0 = audiokeys.analyse({"audio": os.path.join(tmp, "sil.wav"), "fps": 30})
    eq("a zero floor on silence is zero, not NaN",
       set(round(v, 6) for v in values(s0["tracks"]["amplitude"])), {0.0})

    # -- beats ----------------------------------------------------------------
    y, truth = clicks(120.0, 20.0, first=0.5)
    write_wav(os.path.join(tmp, "click120.wav"), y)
    c = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30})
    got = c["beats"]
    errs = [min(abs(g - w) for g in got) * 1000.0 for w in truth]
    eq("every click has a beat within 5 ms", max(errs) < 5.0, True)
    near("mean beat error, ms", float(np.mean(errs)), 0.0, 2.0)
    near("the reported tempo", c["bpm"], 120.0, 0.6)
    eq("it does not invent extra beats", abs(len(got) - len(truth)) <= 2, True)
    eq("bars are every fourth beat", c["bars"][:3], got[:12:4])

    y2, truth2 = clicks(90.0, 20.0, first=0.4)
    write_wav(os.path.join(tmp, "click90.wav"), y2)
    c2 = audiokeys.analyse({"audio": os.path.join(tmp, "click90.wav"), "fps": 30})
    errs2 = [min(abs(g - w) for g in c2["beats"]) * 1000.0 for w in truth2]
    eq("a 90 BPM click also lands within 5 ms", max(errs2) < 5.0, True)
    near("its tempo too", c2["bpm"], 90.0, 0.6)

    # Refinement is the thing that buys those milliseconds — prove it, rather
    # than trusting that the constant is doing something.
    import beats as _b  # noqa: E402
    ym, msr = _b.load_mono(os.path.join(tmp, "click120.wav"), audiokeys.SR)
    env, efps, _ = _b.onset_envelope(ym, msr, hop=audiokeys.HOP, n_fft=audiokeys.N_FFT)
    i0, i1 = audiokeys.onset_span(env)
    seed, _conf = _b.estimate_tempo(env[i0:i1 + 1], efps)
    unrefined = [g + i0 / efps for g in _b.track_beats(env[i0:i1 + 1], efps, seed)]
    raw_err = float(np.mean([min(abs(g - w) for g in unrefined) for w in truth])) * 1000.0
    eq(f"refinement beats the raw DP grid by more than 10x ({raw_err:.1f} ms -> "
       f"{np.mean(errs):.2f} ms)", raw_err > 10.0 * float(np.mean(errs)), True)
    eq("and the raw grid is EARLY, which is the bias being corrected",
       float(np.mean([min(unrefined, key=lambda g: abs(g - w)) - w for w in truth])) < -0.01,
       True)

    # The anchor is what makes the leading silence survivable. Without it the
    # DP starts its chain in the quiet and the first bars come out a third of a
    # beat out of phase, which refinement cannot reach.
    # 0.4 s at 90 BPM is 0.6 of a period, so frame 0 is NOT a valid grid slot —
    # exactly the case where starting there throws the phase. (At 120 BPM with
    # 0.5 s of silence it would land on the grid by luck and prove nothing.)
    ly, lsr = _b.load_mono(os.path.join(tmp, "click90.wav"), audiokeys.SR)
    lenv, lfps, _ = _b.onset_envelope(ly, lsr, hop=audiokeys.HOP, n_fft=audiokeys.N_FFT)
    li0, li1 = audiokeys.onset_span(lenv)
    anchored = [g + li0 / lfps for g in _b.track_beats(
        lenv[li0:li1 + 1], lfps, _b.estimate_tempo(lenv[li0:li1 + 1], lfps)[0])]
    unanchored = _b.track_beats(lenv, lfps, _b.estimate_tempo(lenv, lfps)[0])
    worst_a = max(min(abs(g - w) for g in anchored) for w in truth2)
    worst_u = max(min(abs(g - w) for g in unanchored) for w in truth2)
    eq(f"anchoring at the first onset beats starting at frame 0 "
       f"({worst_u * 1000:.0f} ms -> {worst_a * 1000:.0f} ms)", worst_a * 4 < worst_u, True)
    late_y, late_truth = clicks(120.0, 20.0, first=2.7)
    write_wav(os.path.join(tmp, "late.wav"), late_y)
    cl = audiokeys.analyse({"audio": os.path.join(tmp, "late.wav"), "fps": 30})
    eq("2.7s of leading silence still lands every beat within 5 ms",
       max(min(abs(g - w) for g in cl["beats"]) for w in late_truth) < 0.005, True)
    eq("silence has no tempo and is not given one", (s["beats"], s["bpm"]), ([], None))

    # The beat pulse must actually hit on the beat, and a 30 fps grid must not
    # drop it — that is what the max-pooled resample is for.
    pulse = c["tracks"]["beat"]
    hits = [sample(pulse, bt) for bt in c["beats"][2:8]]
    eq("the beat pulse peaks on every beat", min(hits) > 0.85, True)
    eq("and falls between them",
       sample(pulse, (c["beats"][3] + c["beats"][4]) / 2.0) < 0.6, True)
    onset = c["tracks"]["onset"]
    eq("the onset track survives being resampled to 30 fps",
       min(sample(onset, bt) for bt in c["beats"][2:8]) > 0.15, True)

    # -- smoothing ------------------------------------------------------------
    noisy, _ = clicks(150.0, 12.0, first=0.3)
    noisy = noisy + np.random.default_rng(4).standard_normal(noisy.size) * 0.05
    write_wav(os.path.join(tmp, "noisy.wav"), noisy)
    sm = audiokeys.analyse({"audio": os.path.join(tmp, "noisy.wav"), "fps": 30,
                            "raw": True, "epsilon": 0.0, "beats": False,
                            "attack": 0.01, "release": 0.25})
    raw_v = np.array(values(sm["tracks"]["amplitudeRaw"]))
    smooth_v = np.array(values(sm["tracks"]["amplitude"]))
    jr = float(np.var(np.diff(raw_v)))
    js = float(np.var(np.diff(smooth_v)))
    eq(f"smoothing reduces frame-to-frame variance ({jr:.5f} -> {js:.5f})", js < jr, True)
    eq("by a lot, not a rounding error", js < jr * 0.5, True)
    eq("and does not shift the overall level much",
       abs(float(raw_v.mean() - smooth_v.mean())) < 0.15, True)
    # A slow release must smooth MORE than a fast one, or the dial is decorative.
    slow = audiokeys.analyse({"audio": os.path.join(tmp, "noisy.wav"), "fps": 30,
                              "epsilon": 0.0, "beats": False, "release": 1.0})
    eq("a longer release smooths further",
       float(np.var(np.diff(np.array(values(slow["tracks"]["amplitude"]))))) < js, True)

    # -- key hygiene ----------------------------------------------------------
    full = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                              "floor": 0.1, "gain": 1.5})
    bad_sort = bad_range = bad_shape = 0
    for name, tr in full["tracks"].items():
        ks = tr["keys"]
        for i, k in enumerate(ks):
            if set(k) - {"t", "v", "ease"}:
                bad_shape += 1
            if not isinstance(k["v"], float) or not math.isfinite(k["v"]):
                bad_shape += 1
            if i and not ks[i - 1]["t"] < k["t"]:
                bad_sort += 1
            if not (0.1 - 1e-9 <= k["v"] <= 1.0 + 1e-9):
                bad_range += 1
    eq("every key is strictly sorted in time", bad_sort, 0)
    eq("every value sits inside floor..1", bad_range, 0)
    eq("every key carries only t and v", bad_shape, 0)
    eq("the first key is at t=0", full["tracks"]["amplitude"]["keys"][0]["t"], 0.0)

    # -- thinning -------------------------------------------------------------
    dense = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                               "epsilon": 0.0, "beats": False})
    thinned = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                                 "epsilon": 0.02, "beats": False})
    eq("thinning drops keys", len(thinned["tracks"]["amplitude"]["keys"])
       < len(dense["tracks"]["amplitude"]["keys"]), True)
    worst = max(abs(sample(thinned["tracks"]["amplitude"], k["t"]) - k["v"])
                for k in dense["tracks"]["amplitude"]["keys"])
    eq(f"and stays inside the tolerance it was given ({worst:.4f})", worst <= 0.02 + 1e-6, True)
    eq("endpoints survive thinning",
       (thinned["tracks"]["amplitude"]["keys"][0]["t"],
        round(thinned["tracks"]["amplitude"]["keys"][-1]["t"], 4)),
       (dense["tracks"]["amplitude"]["keys"][0]["t"],
        round(dense["tracks"]["amplitude"]["keys"][-1]["t"], 4)))

    # -- fps, offset, range, gain, ease ---------------------------------------
    at60 = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 60,
                              "epsilon": 0.0, "beats": False})
    eq("60 fps produces twice the frames", at60["frames"], dense["frames"] * 2)
    # Key times are rounded to the microsecond, so "on the grid" means within
    # that rounding, not bit-exact.
    eq("key times land on the comp's frame grid",
       max(abs(k["t"] * 60 - round(k["t"] * 60))
           for k in at60["tracks"]["amplitude"]["keys"]) < 1e-4, True)

    shifted = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                                 "offset": 2.5, "epsilon": 0.0})
    eq("offset moves the first key", shifted["tracks"]["amplitude"]["keys"][0]["t"], 2.5)
    near("offset moves the beats with it", shifted["beats"][0] - full["beats"][0], 2.5, 1e-3)

    part = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                              "from": 4.0, "to": 9.0, "beats": False})
    near("a from/to range analyses only that span", part["seconds"], 5.0, 0.05)

    quiet = tone(440.0, 4.0, amp=0.02)
    write_wav(os.path.join(tmp, "quiet.wav"), quiet)
    q1 = audiokeys.analyse({"audio": os.path.join(tmp, "quiet.wav"), "fps": 30,
                            "curve": "linear", "gain": 1.0, "beats": False,
                            "smooth": False, "from": 1.0, "to": 3.0})
    q2 = audiokeys.analyse({"audio": os.path.join(tmp, "quiet.wav"), "fps": 30,
                            "curve": "linear", "gain": 4.0, "beats": False,
                            "smooth": False, "from": 1.0, "to": 3.0})
    eq("a quiet track still reaches full scale — self-normalised",
       max(values(q1["tracks"]["amplitude"])) > 0.95, True)
    eq("gain cannot push past 1", max(values(q2["tracks"]["amplitude"])) <= 1.0, True)
    fl = audiokeys.analyse({"audio": os.path.join(tmp, "quiet.wav"), "fps": 30,
                            "floor": 0.4, "beats": False})
    eq("the floor is a true minimum", min(values(fl["tracks"]["amplitude"])) >= 0.4 - 1e-9, True)

    held = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                              "ease": "hold", "beats": False})
    eq("a non-linear ease is stamped on every key",
       all(k.get("ease") == "hold" for k in held["tracks"]["amplitude"]["keys"]), True)
    eq("and disables thinning, because a dropped hold key is a dropped step",
       len(held["tracks"]["amplitude"]["keys"]), held["frames"])
    eq("hold really holds through the engine's evaluator",
       sample(held["tracks"]["amplitude"], 1.0 / 30.0 * 3.5),
       held["tracks"]["amplitude"]["keys"][3]["v"])

    subset = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                                "tracks": ["amplitude", "bass"], "beats": False})
    eq("a track subset is honoured", sorted(subset["tracks"]), ["amplitude", "bass"])
    nob = audiokeys.analyse({"audio": os.path.join(tmp, "click120.wav"), "fps": 30,
                             "beats": False})
    eq("beats:false skips beat finding entirely", (nob["beats"], nob["bpm"]), ([], None))

    # -- failure is one line and a non-zero exit ------------------------------
    job = os.path.join(tmp, "job.json")
    with open(job, "w", encoding="utf-8") as fh:
        json.dump({"audio": os.path.join(tmp, "click120.wav"), "fps": 30}, fh)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = audiokeys.main([job])
    line = json.loads(buf.getvalue().strip())
    eq("the CLI exits 0 on success", code, 0)
    eq("the CLI prints one JSON line", (line["ok"], "amplitude" in line["tracks"]), (True, True))

    with open(job, "w", encoding="utf-8") as fh:
        json.dump({"audio": os.path.join(tmp, "nope.wav")}, fh)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = audiokeys.main([job])
    eq("a missing file exits 1", code, 1)
    eq("a missing file says so in one line", json.loads(buf.getvalue().strip())["ok"], False)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = audiokeys.main([])
    eq("no job at all exits 1", code, 1)

    with open(job, "w", encoding="utf-8") as fh:
        json.dump({"audio": os.path.join(tmp, "click120.wav"), "fps": 900}, fh)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = audiokeys.main([job])
    eq("an absurd fps is refused rather than attempted",
       (code, "900" in json.loads(buf.getvalue().strip())["error"]), (1, True))

# -- measured, not asserted ---------------------------------------------------
song = os.path.join(os.path.dirname(os.path.dirname(_HERE)), "docs", "demo", "demo-song.mp3")
if os.path.isfile(song):
    began = time.time()
    m = audiokeys.analyse({"audio": song, "fps": 30})
    wall = time.time() - began
    print(f"\n  measured  {m['seconds']:.0f}s song at 30 fps: {wall:.2f}s analyse "
          f"(+{m['importMs'] / 1000:.1f}s one-off torch import), "
          f"{m['keyCount']} keys, {len(m['beats'])} beats, {m['bpm']} BPM")

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
