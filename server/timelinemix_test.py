"""Unit tests for the timeline mixer in server/timelinemix.py.

The mixer's whole claim is that the file sounds like the monitor, and every
number it uses to keep that promise — solo beating mute, the linear fade ramp,
level and fade multiplying rather than overriding, inPoint offsetting the
source — is a copy of something in web/studio.js. A copy drifts. These are the
assertions that catch it drifting.

Sources are written with the stdlib `wave` module and outputs are read back
with it, so nothing here is round-tripped through the code under test: if
PyAV's resampler or our own scaling starts lying, an independent reader says
so. Signals are DC STEPS rather than tones — the mixer is arithmetic on
samples, and a constant makes "0.4 plus 0.25 is 0.65" an exact claim instead of
a claim about a window of a sine.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/timelinemix_test.py

PyAV/numpy only, same as timelinemix.py itself.
"""
import os
import sys
import tempfile
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import timelinemix  # noqa: E402

PASS = FAIL = 0
RATE = 44100


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol=0.002):
    eq(name, round(abs(float(got) - float(want)), 6) <= tol, True)


def steps(path, values, seconds=1.0, rate=RATE):
    """A source that is `values[i]` for one `seconds` each.

    Constant sections are what make an inPoint assertion readable: seeking one
    second in has to land on the second value, and nothing else can produce it.
    """
    data = np.concatenate([np.full(int(round(seconds * rate)), v, dtype=np.float64) for v in values])
    frames = np.clip(np.round(np.stack([data, data], axis=1) * 32768.0), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames.tobytes())
    return path


def read(path):
    """(2, N) float32 from a PCM wav — the same 32768 scale timelinemix writes."""
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
        ch = w.getnchannels()
    return np.frombuffer(raw, dtype="<i2").reshape(-1, ch).T.astype(np.float32) / 32768.0


def at(out, t):
    """The left channel at `t` seconds — one sample, not an average."""
    return float(out[0, int(round(t * RATE))])


def run(tmp, tracks, **job):
    """Mix `tracks` to a wav in `tmp` and hand back (info, samples)."""
    dst = os.path.join(tmp, f"out_{run.n}.wav")
    run.n += 1
    info = timelinemix.mix({"tracks": tracks, "out": dst, "format": "wav",
                            "sampleRate": RATE, **job})
    return info, read(dst)


run.n = 0


def track(items, **kw):
    return {"kind": "audio", "level": 1, "muted": False, "solo": False, "items": items, **kw}


def item(src, start=0.0, dur=2.0, **kw):
    return {"src": src, "start": start, "dur": dur, "inPoint": 0, **kw}


print("\ntimelinemix\n")

with tempfile.TemporaryDirectory() as tmp:
    a = steps(os.path.join(tmp, "a.wav"), [0.4, 0.4, 0.4, 0.4])
    b = steps(os.path.join(tmp, "b.wav"), [0.25, 0.25, 0.25, 0.25])
    ladder = steps(os.path.join(tmp, "ladder.wav"), [0.1, 0.2, 0.3, 0.4])

    # -- placement and summing ----------------------------------------------
    info, out = run(tmp, [track([item(a, start=0, dur=2)]),
                          track([item(b, start=1, dur=2)])])
    near("an item before the overlap is itself", at(out, 0.5), 0.4)
    near("two items sum where they overlap", at(out, 1.5), 0.65)
    near("an item after the overlap is itself", at(out, 2.5), 0.25)
    eq("the mix runs to the last item's end", info["seconds"], 3.0)
    eq("the file is that long", out.shape[1], int(3.0 * RATE))
    eq("both tracks counted", (info["tracks"], info["items"]), (2, 2))

    # `start` is honoured, not assumed to be zero — an item that begins at 1 s
    # leaves a second of silence in front of it.
    near("nothing sounds before an item starts", at(out, 0.02), 0.4)
    info, out = run(tmp, [track([item(b, start=1, dur=1)])])
    near("a gap at the head is silent", at(out, 0.5), 0.0)

    # -- mute, solo ----------------------------------------------------------
    _, out = run(tmp, [track([item(a, dur=2)], muted=True),
                       track([item(b, dur=2)])])
    near("a muted track contributes nothing", at(out, 1.0), 0.25)

    _, out = run(tmp, [track([item(a, dur=2)]),
                       track([item(b, dur=2)], solo=True)])
    near("a soloed track silences the others", at(out, 1.0), 0.25)

    # Solo beats mute, which is the desk behaviour studio.js's audible()
    # implements and the one a "muted means silent" refactor would break.
    _, out = run(tmp, [track([item(a, dur=2)]),
                       track([item(b, dur=2)], solo=True, muted=True)])
    near("a track that is soloed AND muted still sounds", at(out, 1.0), 0.25)

    # -- level ---------------------------------------------------------------
    _, out = run(tmp, [track([item(a, dur=2)], level=0.5)])
    near("level 0.5 halves the amplitude", at(out, 1.0), 0.2)
    _, out = run(tmp, [track([item(a, dur=2)], level=0)])
    near("level 0 is silence", at(out, 1.0), 0.0)
    # Level and fade MULTIPLY. Half level, halfway up a fade, is a quarter.
    _, out = run(tmp, [track([item(a, dur=2, fadeIn=1.0)], level=0.5)])
    near("level and a fade multiply", at(out, 0.5), 0.1)

    # -- fades ---------------------------------------------------------------
    _, out = run(tmp, [track([item(a, dur=3, fadeIn=1.0, fadeOut=1.0)])])
    near("a fade-in starts at zero", at(out, 0.0), 0.0)
    near("a fade-in is LINEAR at its midpoint", at(out, 0.5), 0.2)
    near("a fade-in reaches full", at(out, 1.5), 0.4)
    near("a fade-out is linear too", at(out, 2.5), 0.2)
    near("the tail ends near zero", at(out, 2.999), 0.0, tol=0.001)

    # The one-sided crossfade. The incoming item ramps up across the overlap;
    # the outgoing one stays at FULL unless it carries its own fadeOut, because
    # that is precisely what itemAlpha() does and the editor drew.
    _, out = run(tmp, [track([item(a, start=0, dur=2), item(b, start=1.5, dur=2)])])
    near("the incoming item is half up at the middle of the overlap",
         at(out, 1.75), 0.4 + 0.125)
    near("the outgoing item is not faded down", at(out, 1.6), 0.4 + 0.05)

    # -- inPoint -------------------------------------------------------------
    _, out = run(tmp, [track([item(ladder, dur=1, inPoint=0)])])
    near("inPoint 0 plays the head", at(out, 0.5), 0.1)
    _, out = run(tmp, [track([item(ladder, dur=1, inPoint=2)])])
    near("inPoint 2 s starts two seconds into the source", at(out, 0.5), 0.3)
    # And it offsets rather than merely skipping: an item's own timeline
    # position is unaffected by where it reads from.
    _, out = run(tmp, [track([item(ladder, start=1, dur=1, inPoint=3)])])
    near("inPoint does not move the item on the timeline", at(out, 0.5), 0.0)
    near("the offset source plays at the item's start", at(out, 1.5), 0.4)

    # -- degenerate items ----------------------------------------------------
    # A source is 4 s; asking for 6 gives 4 s of sound and 2 of silence, which
    # is what an element that has ended sounds like.
    info, out = run(tmp, [track([item(a, dur=6)])])
    near("an item that outlives its source still plays", at(out, 3.5), 0.4)
    near("past the source it is silent", at(out, 5.0), 0.0)
    eq("and it still occupies its full length", info["seconds"], 6.0)

    # A zero-length item is a mis-drag, not an error: dropped, and the rest of
    # the timeline mixes.
    info, out = run(tmp, [track([item(a, start=0, dur=0), item(b, start=0, dur=2)])])
    eq("a zero-length item is dropped", info["items"], 1)
    near("its neighbours are unaffected", at(out, 1.0), 0.25)

    # -- sample-rate mixes ---------------------------------------------------
    half = steps(os.path.join(tmp, "half.wav"), [0.3, 0.3, 0.3], rate=22050)
    info, out = run(tmp, [track([item(half, dur=3)]), track([item(b, dur=3)])])
    # Measured in the middle: a resampler's filter rings for a few ms at the
    # edges of a step, and that transient is not what this is asserting.
    near("a 22.05 kHz source resamples and sums", at(out, 1.5), 0.55, tol=0.005)
    eq("its duration is preserved, not halved", info["seconds"], 3.0)

    # -- normalisation -------------------------------------------------------
    quiet = steps(os.path.join(tmp, "quiet.wav"), [0.05, 0.05, 0.05, 0.05])
    info, out = run(tmp, [track([item(quiet, dur=4)])],
                    normalize={"rmsDb": -14, "peakDb": -1})
    near("normalisation reports the requested RMS", info["rmsDb"], -14, tol=0.05)
    near("and the file measures it", 20 * np.log10(np.sqrt(np.mean(out[0] ** 2))), -14, tol=0.05)
    near("a quiet mix is raised, not lowered", info["gainDb"] > 0, True, tol=0)

    # The peak ceiling VETOES the RMS target, and the report says where it
    # actually landed. Silently missing the asked-for loudness is the failure
    # mode worth a test.
    info, _ = run(tmp, [track([item(quiet, dur=4)])],
                  normalize={"rmsDb": -3, "peakDb": -12})
    near("the peak ceiling caps the gain", info["peakDb"], -12, tol=0.05)
    near("so the RMS target is honestly missed", info["rmsDb"], -12, tol=0.05)

    info, out = run(tmp, [track([item(a, dur=2)])], normalize=None)
    near("no normalize block leaves the level alone", at(out, 1.0), 0.4)

    # -- refusals ------------------------------------------------------------
    def refusal(**job):
        try:
            timelinemix.mix({"out": os.path.join(tmp, "never.wav"), "format": "wav", **job})
        except timelinemix.Refuse as err:
            return str(err)
        return None

    eq("a project with only video tracks is refused",
       "no audio tracks" in (refusal(tracks=[dict(track([item(a)]), kind="video")]) or ""), True)
    eq("a project with no tracks at all is refused",
       "no audio tracks" in (refusal(tracks=[]) or ""), True)
    eq("an all-muted project is refused rather than writing silence",
       "muted" in (refusal(tracks=[track([item(a)], muted=True)]) or ""), True)
    eq("a timeline of nothing but zero-length items is refused",
       "no audio items" in (refusal(tracks=[track([item(a, dur=0)])]) or ""), True)
    eq("an unknown format is refused",
       "format must be" in (refusal(tracks=[track([item(a)])], format="ogg") or ""), True)
    eq("a missing source names the file",
       "could not open" in (refusal(tracks=[track([item(os.path.join(tmp, "gone.wav"))])]) or ""), True)

    # -- the encoders the route actually offers ------------------------------
    # wav is the test harness's format; flac and mp3 are what lands in the
    # library, and an encoder that raises on a real bus is not a detail the
    # route should be the first to discover.
    for fmt, ext in (("flac", ".flac"), ("mp3", ".mp3")):
        dst = os.path.join(tmp, f"enc{ext}")
        info = timelinemix.mix({"tracks": [track([item(a, dur=2, fadeIn=0.5)])],
                                "out": dst, "format": fmt, "sampleRate": RATE})
        eq(f"{fmt} encodes", (info["ok"], os.path.getsize(dst) > 512), (True, True))

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
