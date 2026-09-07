"""Unit tests for server/vfx/notes.py -- the transcription recipe's floors.

Everything is synthesised, because the only way to check a transcription is
against audio whose notes are known by construction: four Karplus-Strong
guitar pieces (the 2026-08-26 AMT eval's own fixtures, regenerated from the
same seeded RNG -- a mono riff, 16ths at 140 BPM with three full-tone bends,
open-position strums, and a riff/chord/rest mix). The FLOORS asserted here are
the eval's measured results, and the point of asserting them per commit is
that every number in the recipe is load-bearing:

    piece A (riff)        F1 >= 0.93   (measured 0.933)
    piece B (16ths+bends) F1 >= 0.914  (measured 0.942 after bend collapse;
                          0.914 was the pre-collapse floor), recall >= 0.95 --
                          the minimum_note_length=40ms claim: the 127.7ms
                          default scores recall 0.468 here
    piece B bends         exactly 3, each +2 semitones on a truth glide onset
    piece C (strums)      F1 >= 0.80, all 12 chord shapes recovered (>= 3
                          notes each)
    piece D (mix)         F1 >= 0.88, fingering 100% playable
    ghost-kill            the two-rule filter removes seeded harmonic ghosts
                          and keeps the DP hand position honest

Scoring is optimal bipartite matching (scipy's Hungarian) with the eval's own
criterion: onset within +-50 ms, pitch exact, offsets ignored.

The pure sections (filter, bend collapse, fingering DP, refusals) always run;
the transcription sections skip with a notice when basic-pitch is not
importable, the same bargain the pre-commit hook makes with the rig venv.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/notes_test.py

Fixture audio is cached under the system temp dir (the synth costs a few
seconds); the transcription itself runs live on every invocation -- it is the
thing under test.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import notes as notesmod  # noqa: E402

PASS = FAIL = 0


def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}" + (f"\n          {detail}" if detail else ""))


def eq(name, got, want):
    ok(name, got == want, f"got {got!r}, wanted {want!r}")


# ---------------------------------------------------------------------------
# the fixtures: the eval's four ground-truth pieces, regenerated
# ---------------------------------------------------------------------------
# Same seed, same draw order (A then B then C then D, velocities in the piece
# functions and excitations in render), so the notes are the eval's notes.
# The wav bytes differ from the eval's only in the PCM encoder's rounding --
# measured to change no F1 by any amount.

SR = 44100
RNG = None  # seeded in synth_all


def _midi_hz(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def _excitation(length, vel):
    from scipy.signal import lfilter
    burst = RNG.uniform(-1, 1, length)
    a = 0.6 - 0.5 * min(max(vel, 0.0), 1.0)
    burst = lfilter([1 - a], [1, -a], burst)
    burst -= burst.mean()
    return burst


def _pluck(midi, dur, vel):
    from scipy.signal import lfilter
    f0 = _midi_hz(midi + RNG.uniform(-0.03, 0.03))
    L = max(int(round(SR / f0 - 0.5)), 2)
    n = int(dur * SR)
    damp = 0.996 if midi < 52 else 0.995
    x = np.zeros(n)
    exc = _excitation(min(L, n), vel)
    x[: len(exc)] = exc * vel
    a = np.zeros(L + 2)
    a[0] = 1.0
    a[L] = -damp * 0.5
    a[L + 1] = -damp * 0.5
    y = lfilter([1.0], a, x)
    fade = min(int(0.015 * SR), n)
    y[n - fade:] *= np.linspace(1, 0, fade)
    return y


def _glide(midi_from, midi_to, glide_time, dur, vel):
    n = int(dur * SR)
    t = np.arange(n) / SR
    frac = np.clip((t - 0.12) / glide_time, 0, 1)
    D = SR / _midi_hz(midi_from + (midi_to - midi_from) * frac) - 0.5
    maxlen = int(np.ceil(D.max())) + 4
    buf = np.zeros(n + maxlen)
    exc = _excitation(int(D[0]), vel) * vel
    out = np.zeros(n)
    for i in range(n):
        d = D[i]
        j = i - d
        j0 = int(math.floor(j))
        fr = j - j0
        s1 = (1 - fr) * buf[j0 + maxlen] + fr * buf[j0 + 1 + maxlen]
        s2 = (1 - fr) * buf[j0 - 1 + maxlen] + fr * buf[j0 + maxlen]
        v = 0.995 * 0.5 * (s1 + s2)
        if i < len(exc):
            v += exc[i]
        buf[i + maxlen] = v
        out[i] = v
    fade = min(int(0.015 * SR), n)
    out[n - fade:] *= np.linspace(1, 0, fade)
    return out


def _piece_A():
    beat = 60.0 / 90.0
    seq = [(0, 40, 1), (1, 43, 0.5), (1.5, 45, 0.5), (2, 47, 1), (3, 45, 1),
           (4, 43, 0.5), (4.5, 40, 0.5), (5, 40, 1), (6, 47, 1), (7, 50, 1),
           (8, 52, 1), (9, 50, 0.5), (9.5, 47, 0.5), (10, 45, 1), (11, 43, 1),
           (12, 40, 0.5), (12.5, 43, 0.5), (13, 45, 0.5), (13.5, 47, 0.5),
           (14, 50, 1), (15, 52, 1), (16, 55, 2), (18, 52, 0.5), (18.5, 50, 0.5),
           (19, 47, 1), (20, 45, 0.5), (20.5, 43, 0.5), (21, 40, 2)]
    out = [dict(onset=round(b * beat, 6), midi=m, dur=round(ln * beat * 0.92, 6),
                vel=0.8 + 0.15 * RNG.uniform(-1, 1)) for b, m, ln in seq]
    return out, 24 * beat


def _piece_B():
    beat = 60.0 / 140.0
    out = []
    b = 0.0

    def add(midi, blen, vel=0.85):
        nonlocal b
        out.append(dict(onset=round(b * beat, 6), midi=midi,
                        dur=round(blen * beat * 0.9, 6),
                        vel=vel + 0.1 * RNG.uniform(-1, 1)))
        b += blen

    def bend(midi, blen, semis=2):
        nonlocal b
        out.append(dict(onset=round(b * beat, 6), midi=midi,
                        dur=round(blen * beat * 0.95, 6), vel=0.9,
                        glide_to=midi + semis, glide_time=0.12))
        b += blen

    for m in [45, 47, 48, 50, 52, 50, 48, 47, 45, 47, 48, 50, 52, 55, 57, 55]:
        add(m, 0.25)
    add(52, 1)
    bend(50, 2)
    for m in [52, 50, 48, 47, 45, 43, 45, 47, 48, 47, 45, 43, 41, 43, 45, 47]:
        add(m, 0.25)
    bend(55, 2)
    add(52, 0.5); add(50, 0.5); add(48, 0.5); add(47, 0.5)
    for m in [45, 48, 50, 52, 55, 52, 50, 48, 50, 52, 55, 57, 60, 57, 55, 52]:
        add(m, 0.25)
    bend(57, 2)
    add(45, 2)
    for m in [40, 43, 45, 47, 48, 47, 45, 43, 40, 43, 45, 47, 48, 50, 52, 50]:
        add(m, 0.25)
    add(48, 0.5); add(47, 0.5); add(45, 0.5); add(43, 0.5)
    for m in [45, 47, 48, 50, 52, 55, 57, 55, 52, 50, 48, 47, 45, 47, 48, 45]:
        add(m, 0.25)
    add(40, 2)
    return out, (b + 1) * beat


_CHORDS = {"E": [40, 47, 52, 56, 59, 64], "A": [45, 52, 57, 61, 64],
           "D": [50, 57, 62, 66], "G": [43, 47, 50, 55, 59, 67],
           "C": [48, 52, 55, 60, 64]}


def _strum(name, onset, dur, vel=0.8):
    return [dict(onset=round(onset + i * 0.007, 6), midi=m, dur=round(dur, 6),
                 vel=vel + 0.08 * RNG.uniform(-1, 1), chord=name)
            for i, m in enumerate(_CHORDS[name])]


def _piece_C():
    beat = 60.0 / 80.0
    seq = ["E", "A", "D", "G", "C", "E", "A", "G", "C", "D", "A", "E"]
    out = []
    for i, name in enumerate(seq):
        out += _strum(name, i * 2 * beat, 2 * beat * 0.95)
    return out, len(seq) * 2 * beat


def _piece_D():
    beat = 60.0 / 100.0
    out = []
    for b, m, ln in [(0, 45, 1), (1, 48, 0.5), (1.5, 50, 0.5), (2, 52, 1), (3, 50, 1),
                     (4, 48, 0.5), (4.5, 45, 0.5), (5, 45, 1)]:
        out.append(dict(onset=round(b * beat, 6), midi=m, dur=round(ln * beat * 0.9, 6), vel=0.85))
    t = 6.5 * beat
    out += _strum("A", t, 2 * beat)
    t += 2.5 * beat
    out += _strum("G", t, 2 * beat)
    t += 3.5 * beat
    for b, m, ln in [(0, 45, 0.5), (0.5, 57, 0.5), (1, 45, 0.5), (1.5, 57, 1), (2.5, 55, 0.5),
                     (3, 52, 0.5), (3.5, 50, 0.5), (4, 48, 0.5), (4.5, 45, 2)]:
        out.append(dict(onset=round(t + b * beat, 6), midi=m, dur=round(ln * beat * 0.9, 6), vel=0.85))
    t += 7 * beat
    for b, m, ln in [(0, 40, 0.5), (0.5, 43, 0.5), (1, 45, 1), (2, 47, 0.5), (2.5, 45, 0.5),
                     (3, 43, 0.5), (3.5, 40, 1.5)]:
        out.append(dict(onset=round(t + b * beat, 6), midi=m, dur=round(ln * beat * 0.9, 6), vel=0.85))
    t += 5.5 * beat
    out += _strum("E", t, 3 * beat)
    return out, t + 3.5 * beat


def _render(truth, total):
    master = np.zeros(int(total * SR) + SR)
    for nt in truth:
        if "glide_to" in nt:
            y = _glide(nt["midi"], nt["glide_to"], nt["glide_time"], nt["dur"], nt["vel"])
        else:
            y = _pluck(nt["midi"], nt["dur"], nt["vel"])
        i0 = int(nt["onset"] * SR)
        master[i0: i0 + len(y)] += y
    peak = np.abs(master).max()
    if peak > 0:
        master *= 0.85 / peak
    return master


def _write_wav(path, y):
    pcm = np.clip(np.asarray(y) * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def synth_all(into):
    """All four pieces, in the eval's exact order -- one RNG stream crosses
    piece boundaries, so generating them out of order generates different
    audio and different (still correct) truth velocities."""
    global RNG
    RNG = np.random.default_rng(20260826)
    for name, fn in [("A", _piece_A), ("B", _piece_B), ("C", _piece_C), ("D", _piece_D)]:
        truth, total = fn()
        y = _render(truth, total)
        _write_wav(os.path.join(into, f"{name}.wav"), y)
        with open(os.path.join(into, f"{name}.json"), "w", encoding="utf-8") as fh:
            json.dump({"notes": truth, "total": total}, fh)


def fixtures():
    """Synthesise once, cache under the system temp dir, reuse forever."""
    d = os.path.join(tempfile.gettempdir(), "aiplay_notes_fixtures_v1")
    have = all(os.path.isfile(os.path.join(d, f"{n}.{x}"))
               for n in "ABCD" for x in ("wav", "json"))
    if not have:
        os.makedirs(d, exist_ok=True)
        began = time.time()
        synth_all(d)
        print(f"  (synthesised the four fixture pieces in {time.time() - began:.1f}s -> {d})")
    return d


# ---------------------------------------------------------------------------
# scoring: the eval's criterion -- onset +-50 ms, pitch exact, optimal matching
# ---------------------------------------------------------------------------

def score(est, truth, tol=0.05):
    from scipy.optimize import linear_sum_assignment
    if not est or not truth:
        return 0.0, 0.0, 0.0, []
    C = np.full((len(truth), len(est)), 1e6)
    for i, r in enumerate(truth):
        for j, e in enumerate(est):
            if e["midi"] == r["midi"] and abs(e["t"] - r["onset"]) <= tol:
                C[i, j] = abs(e["t"] - r["onset"])
    ri, cj = linear_sum_assignment(C)
    pairs = [(i, j) for i, j in zip(ri, cj) if C[i, j] < 1e5]
    p = len(pairs) / len(est)
    r = len(pairs) / len(truth)
    f1 = 2 * p * r / max(p + r, 1e-9)
    return p, r, f1, pairs


# ===========================================================================
print("\n-- the post-filter: two rules, both measured ------------------------")

base = [dict(t=0.0, dur=0.3, midi=45, vel=0.8),
        dict(t=0.5, dur=0.3, midi=47, vel=0.41),
        dict(t=1.0, dur=0.3, midi=48, vel=0.40)]
kept, gated, deduped = notesmod.filter_notes(
    base + [dict(t=0.5, dur=0.05, midi=59, vel=0.39)])
eq("the confidence gate drops vel < 0.40", (len(kept), gated), (3, 1))
ok("...and vel exactly 0.40 survives (the knee is inclusive)",
   any(n["midi"] == 48 for n in kept))

dup = [dict(t=1.0, dur=0.2, midi=50, vel=0.6),
       dict(t=1.08, dur=0.2, midi=50, vel=0.9),   # same pitch, 80 ms later
       dict(t=1.095, dur=0.2, midi=52, vel=0.5)]  # different pitch, untouched
kept, _, deduped = notesmod.filter_notes(dup)
eq("same-pitch re-onsets inside 90 ms are one pluck", deduped, 1)
ok("...keeping the LOUDER of the pair",
   any(n["midi"] == 50 and n["vel"] == 0.9 for n in kept))
ok("...and a different pitch inside the window is untouched",
   any(n["midi"] == 52 for n in kept))
apart = [dict(t=1.0, dur=0.08, midi=50, vel=0.6),
         dict(t=1.095, dur=0.2, midi=50, vel=0.9)]
kept, _, deduped = notesmod.filter_notes(apart)
eq("re-onsets 95 ms apart are two honest plucks", (len(kept), deduped), (2, 0))

print("\n-- the seeded-ghost case: what the filter buys the fingering --------")
# An open-position riff, plus Basic Pitch's measured false-positive signature:
# harmonic ghosts +12/+19/+24 semitones at low confidence with sub-80ms
# fragment durations. A ghost lands inside its real note's chord event, so the
# DP has to find a shape holding BOTH -- the 12th/19th partials force the hand
# up the neck (the eval measured mean position 1.6 -> 2.9 with a position-7
# excursion) and an over-full chord becomes unplayable outright.
ghostreal = [dict(t=i * 0.25, dur=0.22, midi=m, vel=0.8)
             for i, m in enumerate([40, 43, 45, 47, 45, 43, 40, 45])]
ghosts = [dict(t=n["t"] + 0.01, dur=0.06, midi=n["midi"] + 12, vel=0.34) for n in ghostreal[:4]] \
       + [dict(t=n["t"] + 0.02, dur=0.05, midi=n["midi"] + 19, vel=0.28) for n in ghostreal[4:7]] \
       + [dict(t=ghostreal[3]["t"] + 0.02, dur=0.05, midi=ghostreal[3]["midi"] + 24, vel=0.31)]
kept, gated, _ = notesmod.filter_notes(ghostreal + ghosts)
eq("all 8 seeded ghosts die at the gate, all 8 real notes live",
   (gated, len(kept)), (8, 8))
ok("...specifically the ghosts, not the riff",
   sorted(n["midi"] for n in kept) == sorted(n["midi"] for n in ghostreal))
_, dirty_stats = notesmod.annotate_fingering(sorted(ghostreal + ghosts, key=lambda n: n["t"]))
_, clean_stats = notesmod.annotate_fingering(kept)
ok(f"unfiltered, the partials force the hand far up the neck (maxPos {dirty_stats['maxPos']} >= 5)",
   dirty_stats["maxPos"] >= 5)
ok(f"filtered, the riff sits in the open position (maxPos {clean_stats['maxPos']} <= 3)",
   clean_stats["maxPos"] <= 3)
ok(f"...and the mean hand position falls ({dirty_stats['meanPos']} -> {clean_stats['meanPos']})",
   clean_stats["meanPos"] < dirty_stats["meanPos"])

print("\n-- the bend collapse: staircase in, one bent note out ---------------")
# The exact staircase Basic Pitch emitted for piece B's first bend (measured):
# start pitch on time, +1 as a 58 ms fragment ~139 ms in, target ~197 ms in.
stair = [dict(t=2.138, dur=0.139, midi=50, vel=0.74),
         dict(t=2.277, dur=0.058, midi=51, vel=0.46),
         dict(t=2.335, dur=0.662, midi=52, vel=0.75)]
merged = notesmod.collapse_bends(stair)
eq("three staircase notes become one", len(merged), 1)
eq("...with a +2 semitone bend", merged[0].get("bend"), 2)
ok("...reaching the target ~197 ms in", abs(merged[0]["bendTime"] - 0.197) < 0.01,
   f"bendTime={merged[0]['bendTime']}")
ok("...and the merged duration runs to the target's end",
   abs(merged[0]["dur"] - (2.335 + 0.662 - 2.138)) < 1e-6, f"dur={merged[0]['dur']}")

picked = [dict(t=0.0, dur=0.096, midi=47, vel=0.85),
          dict(t=0.107, dur=0.096, midi=48, vel=0.83)]
eq("two honestly picked +1 notes (16ths at 140) do NOT collapse",
   len(notesmod.collapse_bends(picked)), 2)
triple = [dict(t=0.0, dur=0.096, midi=47, vel=0.85),
          dict(t=0.107, dur=0.096, midi=48, vel=0.83),
          dict(t=0.214, dur=0.096, midi=49, vel=0.84)]
eq("a played chromatic triple does not collapse (its steps are full notes)",
   len(notesmod.collapse_bends(triple)), 3)
chord = [dict(t=0.0, dur=1.4, midi=52, vel=0.8),
         dict(t=0.007, dur=1.4, midi=53, vel=0.8)]
eq("overlapping chord tones a semitone apart are untouched",
   len(notesmod.collapse_bends(chord)), 2)

print("\n-- the DP fingering assigner ----------------------------------------")
one = [dict(t=0.0, dur=0.5, midi=40, vel=0.8)]
fing, stats = notesmod.annotate_fingering(one)
eq("low E prefers the open string (the open bonus)",
   (fing[0]["string"], fing[0]["fret"], fing[0]["finger"]), (0, 0, 0))
low = [dict(t=0.0, dur=0.5, midi=30, vel=0.8)]
fing, stats = notesmod.annotate_fingering(low)
eq("a note under the instrument's range is reported unplayable, not dropped",
   (stats["unplayable"], "string" in fing[0]), ([0], False))
wide = [dict(t=0.0, dur=0.5, midi=41, vel=0.8),   # F2: string 0 fret 1 only
        dict(t=0.01, dur=0.5, midi=52, vel=0.8),  # E3
        dict(t=0.02, dur=0.5, midi=64, vel=0.8),  # E4: open or fret 5
        dict(t=0.03, dur=0.5, midi=71, vel=0.8)]  # B4: reachable frets 7/12
fing, stats = notesmod.annotate_fingering(wide)
frets = [n["fret"] for n in fing if "fret" in n]
spans = [f for f in frets if f > 0]
ok("a chord's fretted span stays within 4 frets",
   not spans or max(spans) - min(spans) <= 4, f"frets={frets}")
seven = [dict(t=0.0, dur=0.5, midi=52, vel=0.8) for _ in range(7)]
fing, stats = notesmod.annotate_fingering(seven)
ok("seven simultaneous notes cannot all land: six strings",
   stats["assigned"] < 7, f"assigned={stats['assigned']}")
dropd = notesmod.annotate_fingering(
    [dict(t=0.0, dur=0.5, midi=38, vel=0.8)], tuning=[38, 45, 50, 55, 59, 64])[0]
eq("a custom tuning changes what is playable (drop D)",
   (dropd[0]["string"], dropd[0]["fret"]), (0, 0))
capo = notesmod.annotate_fingering(
    [dict(t=0.0, dur=0.5, midi=66, vel=0.8)], max_fret=1)[1]
eq("a fret cap makes high positions unplayable", capo["unplayable"], [0])

print("\n-- the CLI contract: refusals name the fix --------------------------")
tmp = tempfile.mkdtemp(prefix="notes_test_")
jobp = os.path.join(tmp, "job.json")


def run_cli(job, env_extra=None):
    with open(jobp, "w", encoding="utf-8") as fh:
        json.dump(job, fh)
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    r = subprocess.run([sys.executable, os.path.join(_HERE, "notes.py"), jobp],
                       capture_output=True, text=True, env=env)
    line = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "{}"
    return r.returncode, json.loads(line)


code, out = run_cli({"mode": "fingering",
                     "notes": [{"t": 0, "dur": 0.5, "midi": 40, "vel": 0.8}]})
eq("fingering mode answers over the CLI", (code, out["ok"], out["notes"][0]["string"]),
   (0, True, 0))
code, out = run_cli({"mode": "transcribe", "audio": os.path.join(tmp, "nope.wav")})
eq("a missing file is a refusal, exit 1", (code, out["ok"]), (1, False))
code, out = run_cli({"mode": "transcribe", "audio": jobp, "profile": "theremin"})
ok("an unknown profile is refused naming the real ones",
   code == 1 and "guitar" in out["error"] and "bass" in out["error"], out.get("error"))
code, out = run_cli({"mode": "polish"})
ok("an unknown mode is refused naming the two modes",
   code == 1 and "transcribe" in out["error"], out.get("error"))

# The graceful-refusal path this file exists to keep graceful: basic-pitch
# absent must be a one-line error NAMING the pip install for the exact python
# that refused -- never a traceback. Simulated with the env override.
code, out = run_cli({"mode": "transcribe", "audio": jobp},
                    env_extra={"AIPLAY_NOTES_NO_BASIC_PITCH": "1"})
ok("without basic-pitch: ok:false, exit 1, no crash", code == 1 and out["ok"] is False)
ok("...and the error is a copy-paste fix naming this python",
   "pip install basic-pitch" in out.get("error", "")
   and os.path.basename(sys.executable) in out.get("error", ""),
   out.get("error", "")[:200])

# ---------------------------------------------------------------------------
try:
    import basic_pitch  # noqa: F401
    HAVE_BP = True
except ImportError:
    HAVE_BP = False

if not HAVE_BP:
    print("\n  skip  basic-pitch is not importable here -- the transcription "
          "floors need it (the refusal path above is still proven)")
else:
    print("\n-- the floors: the eval's measured numbers, per commit ----------")
    fixdir = fixtures()
    results = {}
    began = time.time()
    for piece in "ABCD":
        results[piece] = notesmod.transcribe({
            "audio": os.path.join(fixdir, f"{piece}.wav"),
            "profile": "guitar", "fingering": True,
        })
    wall = time.time() - began
    truths = {p: json.load(open(os.path.join(fixdir, f"{p}.json"), encoding="utf-8"))["notes"]
              for p in "ABCD"}

    pA, rA, fA, _ = score(results["A"]["notes"], truths["A"])
    ok(f"piece A (riff): F1 {fA:.3f} >= 0.93", fA >= 0.93)
    pB, rB, fB, _ = score(results["B"]["notes"], truths["B"])
    ok(f"piece B (16ths at 140): F1 {fB:.3f} >= 0.914", fB >= 0.914)
    ok(f"...recall {rB:.3f} >= 0.95 -- the minimum_note_length=40ms claim "
       "(the 127.7ms default scores 0.468 here)", rB >= 0.95)

    bendsB = [n for n in results["B"]["notes"] if n.get("bend")]
    glidesB = [n for n in truths["B"] if "glide_to" in n]
    eq("piece B: exactly the 3 true bends collapse", len(bendsB), 3)
    ok("...each +2 semitones, on a truth glide onset (+-50 ms)",
       all(any(abs(b["t"] - g["onset"]) <= 0.05 and b["bend"] == 2 for g in glidesB)
           for b in bendsB),
       json.dumps([(round(b["t"], 3), b.get("bend")) for b in bendsB]))

    pC, rC, fC, pairsC = score(results["C"]["notes"], truths["C"])
    ok(f"piece C (strums): F1 {fC:.3f} >= 0.80", fC >= 0.80)
    strums, cur = [], [0]
    for i in range(1, len(truths["C"])):
        if truths["C"][i]["onset"] - truths["C"][cur[-1]]["onset"] <= 0.05:
            cur.append(i)
        else:
            strums.append(cur)
            cur = [i]
    strums.append(cur)
    matched = {i for i, _ in pairsC}
    rec = sum(1 for s in strums if len([i for i in s if i in matched]) >= 3)
    eq("...all 12 chord shapes recovered (>= 3 notes each)", (rec, len(strums)), (12, 12))

    pD, rD, fD, _ = score(results["D"]["notes"], truths["D"])
    ok(f"piece D (mix): F1 {fD:.3f} >= 0.88", fD >= 0.88)

    print("\n-- fingering rides the filtered output, and stays playable ------")
    for piece in "CD":
        f = results[piece]["fingering"]
        n = results[piece]["count"]
        eq(f"piece {piece}: 100% of filtered notes are playable ({f['assigned']}/{n})",
           (f["assigned"], f["unplayable"]), (n, []))
    fC2 = results["C"]["fingering"]
    ok(f"piece C: the hand stays in open position (meanPos {fC2['meanPos']} <= 2.0 -- "
       "unfiltered, the eval measured 2.88 with position-7 excursions)",
       fC2["meanPos"] <= 2.0)
    ok("...every fingered note names string 0-5 and fret 0-15",
       all(0 <= m["string"] <= 5 and 0 <= m["fret"] <= 15
           for m in fC2["notes"] if "string" in m))

    print(f"\n  measured  4 pieces ({sum(len(t) for t in truths.values())} truth notes) "
          f"transcribed + filtered + fingered in {wall:.1f}s on CPU")

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
