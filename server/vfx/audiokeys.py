"""Audio → keyframes. AE's "Convert Audio to Keyframes", rebuilt for a music app.

WHAT A CALLER MUST PASS
=======================
    python server/vfx/audiokeys.py <job.json>          one JSON line to stdout

job.json — only `audio` is required, every other field has a default:

    {
      "audio":  "C:/…/song.flac",   ABSOLUTE path. Anything PyAV decodes.
                                    Library names are resolved by the route,
                                    never here — this process picks no files.
      "fps":    30,                 output keyframe rate. Pass THE COMP'S fps.
      "from":   0.0, "to": null,    seconds of the source to analyse (null = end)
      "offset": 0.0,                seconds added to every emitted key time, so
                                    a track can start part-way into a comp
      "gain":   1.0,                multiplies the normalised value before the
                                    0..1 clamp — push a quiet mix up
      "floor":  0.0,                0..1 resting value. Output is floor..1, so a
                                    silent passage still holds the property at
                                    something rather than collapsing to zero
      "attack": 0.01,               envelope follower, seconds. Rise time.
      "release":0.20,               envelope follower, seconds. Fall time.
      "smooth": true,               false = raw per-frame measurement, jitter and
                                    all (use it to see what smoothing bought)
      "curve":  "db",               "db" | "linear" — see THE CURVE below
      "rangeDb":48.0,               dB below the reference that maps to 0
      "window": 0.05,               seconds of audio behind each amplitude frame
      "refPercentile": 99.0,        the level that maps to 1.0, per track
      "bandFloorDb":  -60.0,        a band this far under the mix is called silent
      "beats":  true,               false skips tempo + beat tracking entirely
      "beatDecay": 0.25,            seconds for the `beat` pulse to fall to 1/e
      "ease":   "linear",           stamped on every key. "hold" gives a stepped
                                    look (see EASE below)
      "epsilon":0.004,              key thinning tolerance in output units; 0 keeps
                                    one key per frame
      "decimals": 4,                rounding of `v`
      "raw":    false,              also emit *Raw tracks (pre-smoothing)
      "tracks": null                ["amplitude","bass"] to emit a subset
    }

Result:

    { "ok": true,
      "tracks": { "amplitude": {"keys":[{"t":0.0,"v":0.31}, …]},
                  "bass": {"keys":[…]}, "lowMid": …, "highMid": …, "treble": …,
                  "onset": {"keys":[…]}, "beat": {"keys":[…]} },
      "beats": [0.512, 1.008, …],  "bars": […],  "bpm": 120.4,
      "seconds": 157.1, "fps": 30, "frames": 4713, … }

    { "ok": false, "error": "…" } and exit 1 on any failure.

Every `keys` array is EXACTLY VFX_SPEC §1's form, so it can be assigned to any
animatable property — `transform.scale` wants an array, so wrap or map first;
everything scalar (opacity, rotation, an effect's radius) takes these directly.


WHY THIS EXISTS RATHER THAN AE's VERSION
========================================
AE gives you one amplitude channel plus a crude 2-band split and calls it done.
In a music studio the interesting question is never "how loud" — it is "how loud
is the KICK", because that is what a person means when they say "pulse it on the
beat". So this emits four bands, an onset channel, and a beat pulse, all on the
comp's own frame grid, and it does the beat finding with the detector this repo
already ships rather than a second opinion.


REUSED, NOT REINVENTED
======================
`scripts/beats.py` already does spectral-flux onset detection, autocorrelation
tempo with a log-normal prior at 120 BPM, and a dynamic-programming beat grid,
and its conclusions are already trusted elsewhere in the app. This file IMPORTS
it — same load path (`_audio_io`, because torchaudio 2.11 cannot load and PyAV
hands back packed stereo interleaved), same STFT, same DP. Two deliberate
extensions:

  · a finer hop (256 rather than 512 samples) so the beat grid is quantised to
    11.6 ms instead of 23.2 ms before refinement, and
  · sample-domain onset refinement, because 12 ms is audible and — worse — the
    spectral flux peak systematically LEADS the true attack. Measured against
    synthetic click tracks at 100 and 128 BPM: the raw DP times land 27.1 ms
    EARLY on average with a 5.5 ms spread and a 33 ms worst case. Refined
    against a 1.45 ms block energy rise, the same beats come in 0.4-0.7 ms
    early with a 1.4 ms worst case. A cut 27 ms ahead of the kick reads as a
    mistake, so this matters.

The band envelopes come from the SAME magnitude spectrogram the onset detector
built — `beats.onset_envelope` hands it back, and log1p is invertible, so a
second STFT is not needed to get linear magnitudes again.


THE CROSSOVERS, IN HERTZ
========================
    bass     20 – 160 Hz     kick, sub, the thing you feel
    lowMid  160 – 800 Hz     bass guitar, low synth, the body of a snare
    highMid 800 – 3000 Hz    vocals and most melody
    treble 3000 – 11000 Hz   hats, air, sibilance

These are `scripts/beats.py`'s four bands, renamed to the brief's vocabulary and
otherwise untouched ON PURPOSE: a look tuned against the beats.py envelopes has
to survive being re-derived here, and it only does if the crossovers are
identical. Hertz rather than "a fraction of the FFT bins" for the same reason —
bin fractions move when the sample rate or FFT size does.

11 kHz is the ceiling because everything is analysed at 22.05 kHz, which is
beats.py's rate; there is nothing above Nyquist to report. For a treble channel
driving a glow that is not a limitation, but it IS a limitation, so: cymbal air
above 11 kHz does not reach these keys.

Each band is normalised against ITS OWN reference level, not the loudest band.
A mix whose hats sit 25 dB under the kick still gets a usable hat channel that
way — which is the entire point of choosing a band. Taken to its limit that
trick amplifies dither and FFT leakage into a full-scale animation, so a band
more than `bandFloorDb` under the full-mix reference is declared silent and
reports the floor instead. That is what stops a solo bassline from producing a
confident, entirely fictional hi-hat track.

WHERE THAT GATE IS HONEST AND WHERE IT IS NOT. Measured with a pure 60 Hz tone:
treble comes out 99 dB under the mix and lowMid 53 dB under — so the gate
cleanly kills the distant band but NOT the neighbouring one. Two bands sharing
a crossover always bleed, and no threshold separates a tone's second harmonic
from a real instrument sitting there. The default -60 dB therefore errs toward
measuring rather than blanking, and the result carries `bandDb` (each band's
level against the whole mix) and `silentBands` so the caller can see that
treble was 13 dB down (real music, demo track) or 99 dB down (a sine) and judge
for itself instead of trusting this file's threshold.


THE CURVE
=========
`curve: "db"` is the default and it is a product decision, not a signal
processing one. A linear RMS envelope of a mastered track sits around 0.2 and
barely moves; a property driven by it looks dead. Mapping `rangeDb` (48 dB) of
level onto 0..1 matches how the loudness is heard and how a compositor expects a
"level" to behave. `curve: "linear"` gives the honest raw ratio for anyone who
wants to do their own shaping — and it is what the tests assert against, because
only the linear curve can be checked against a known amplitude envelope.


EASE
====
Keys carry `ease` only when it is not `linear`, since linear is §1's default and
a 3-minute song at 30 fps is already several thousand keys per track. Passing
`ease: "hold"` is a genuinely useful setting rather than a formality: it makes
every key hold until the next one, which is how you get a stepped, quantised,
on-the-grid look instead of a continuous one. Thinning is disabled whenever the
ease is not linear — with `hold`, a dropped key is a dropped step, not a
redundant sample.

numpy + scipy + torch, all already present (torch arrives via beats.py). The
import of torch costs a couple of seconds before any work happens; the analysis
timing reported in `ms` excludes it, and `importMs` reports it separately so
nobody has to guess which half is slow.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVER = os.path.dirname(_HERE)
_ROOT = os.path.dirname(_SERVER)
_SCRIPTS = os.path.join(_ROOT, "scripts")
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

_IMPORT_BEGAN = time.time()
import beats as _beats  # noqa: E402  — the repo's own onset/tempo/DP detector
_IMPORT_MS = int((time.time() - _IMPORT_BEGAN) * 1000)


# Analysis rate. beats.py's choice, kept so both paths hear the same thing.
SR = 22050

# 8x overlap. beats.py uses 2048/512; the extra time resolution is what makes a
# beat grid worth refining, and 2048 is kept so the bass band still has ~13 bins
# to average rather than 3.
N_FFT = 2048
HOP = 256

BANDS = {
    "bass":    (20.0, 160.0),
    "lowMid":  (160.0, 800.0),
    "highMid": (800.0, 3000.0),
    "treble":  (3000.0, 11000.0),
}

BAND_TRACKS = tuple(BANDS)
ALL_TRACKS = ("amplitude",) + BAND_TRACKS + ("onset", "beat")

# The spectral-flux detector's group delay, in seconds — how far AHEAD of the
# true attack its peak lands. A Hann window of N samples starts seeing a
# transient about N/4 early, and the flux is a difference between frames half a
# hop apart, so (N_FFT/4 + HOP/2) samples. That predicts 29.0 ms here; measured
# against synthetic click tracks at 100 and 128 BPM the raw DP grid came in
# 27.1 ms early with a 5.5 ms spread, so the formula is right to within a
# couple of milliseconds and the search below is CENTRED on it.
DETECTOR_LEAD = (N_FFT / 4.0 + HOP / 2.0) / SR

# Refinement search radius, seconds. Only has to cover the DP's own scatter
# around the compensated centre (measured: under 7 ms), so it stays narrow —
# at 190 BPM, 20 ms is 6% of a beat and cannot reach the neighbouring one.
REFINE_WINDOW = 0.02

# Block length for the sample-domain energy rise used to refine beats. 32
# samples at 22050 Hz is 1.45 ms — finer than the ear resolves, coarse enough
# that one noisy sample cannot win.
REFINE_BLOCK = 32


def _f(v, fallback=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


def frame_rms(y, sr, fps, n, window=0.05):
    """RMS of the waveform under each output frame — the amplitude channel.

    A window WIDER than the frame period (50 ms against 33 ms at 30 fps) on
    purpose: neighbouring frames overlap, so a transient landing on a frame
    boundary does not produce a one-frame spike that the next frame misses
    entirely. Cumulative sums rather than a loop because a 3-minute song at 60
    fps is 10 800 windows.
    """
    w = max(2, int(round(max(1.0 / max(fps, 1e-6), window) * sr)))
    sq = np.concatenate([[0.0], np.cumsum(np.square(y.astype(np.float64)))])
    centre = (np.arange(n, dtype=np.float64) / fps * sr).astype(np.int64)
    a = np.clip(centre - w // 2, 0, y.size)
    b = np.clip(centre + (w - w // 2), 0, y.size)
    cnt = np.maximum(b - a, 1)
    return np.sqrt((sq[b] - sq[a]) / cnt)


def band_rms(mag, freqs, lo, hi):
    """RMS magnitude inside a band, one value per STFT frame.

    RMS across the bins in the band, not a sum: a sum makes a wide band read
    louder than a narrow one purely for being wide, and these four bands span
    140 Hz and 8000 Hz respectively.
    """
    sel = (freqs >= lo) & (freqs < hi)
    if not sel.any():
        return np.zeros(mag.shape[1], dtype=np.float64)
    return np.sqrt(np.square(mag[sel]).mean(axis=0))


def to_fps(v, src_fps, fps, n, reduce="interp"):
    """Any per-frame series onto the comp's frame grid.

    `reduce="max"` exists because the analysis runs at 86 fps and a comp runs at
    24-30. Interpolating a SPIKY series down to a coarser grid samples it, and a
    sample can land in the gap between two spikes — an onset 11 ms wide simply
    vanishes from a 33 ms grid, at random, depending on where the beat fell. Max
    over each output frame's span keeps every hit; it is the right answer for a
    detection function and the wrong one for a level, so levels stay on interp.
    """
    v = np.asarray(v, dtype=np.float64)
    if v.size == 0:
        return np.zeros(n, dtype=np.float64)
    if v.size == 1:
        return np.full(n, float(v[0]), dtype=np.float64)
    if reduce == "max" and src_fps > fps:
        edges = np.clip(((np.arange(n + 1, dtype=np.float64) - 0.5) / fps
                         * src_fps).round().astype(np.int64), 0, v.size)
        out = np.empty(n, dtype=np.float64)
        for i in range(n):
            a, b = edges[i], max(edges[i] + 1, edges[i + 1])
            out[i] = v[a:min(b, v.size)].max() if a < v.size else 0.0
        return out
    src_t = np.arange(v.size, dtype=np.float64) / src_fps
    out_t = np.arange(n, dtype=np.float64) / fps
    return np.interp(out_t, src_t, v)


def normalise(v, curve="db", range_db=48.0, ref=None, ref_pct=99.0, gate=0.0):
    """A measured level onto 0..1.

    The reference is a high PERCENTILE rather than the maximum, because one
    clipped frame — or one door slam — would otherwise scale the entire song
    down around itself and leave every other frame near zero.
    """
    v = np.asarray(v, dtype=np.float64)
    if v.size == 0:
        return v
    if ref is None:
        ref = float(np.percentile(v, ref_pct))
    # Digital silence, or a band that is only leakage: report nothing rather
    # than dividing by a number that is itself noise.
    if not math.isfinite(ref) or ref <= max(gate, 1e-9):
        return np.zeros_like(v)
    ratio = np.clip(v / ref, 0.0, None)
    if str(curve).lower() == "linear":
        return np.clip(ratio, 0.0, 1.0)
    db = 20.0 * np.log10(np.maximum(ratio, 1e-9))
    return np.clip(1.0 + db / max(range_db, 1e-6), 0.0, 1.0)


def envelope(v, fps, attack, release):
    """Attack/release peak follower — fast up, slow down.

    Raw amplitude jitters frame to frame and a scale property driven by it
    visibly vibrates. A symmetric low-pass would fix the vibration by also
    rounding off every transient, which is the one thing worth keeping in a
    music-driven animation. So: rise with the `attack` coefficient, fall with
    the `release` one, which is what a compressor's detector does and what a
    person means by "punchy but not twitchy".

    A Python loop because the coefficient depends on the comparison — lfilter
    cannot branch. 10 000 frames costs a few milliseconds.
    """
    v = np.asarray(v, dtype=np.float64)
    if v.size < 2:
        return v.copy()
    ca = math.exp(-1.0 / max(1e-6, attack * fps)) if attack > 0 else 0.0
    cr = math.exp(-1.0 / max(1e-6, release * fps)) if release > 0 else 0.0
    if ca <= 0.0 and cr <= 0.0:
        return v.copy()
    out = np.empty_like(v)
    y = float(v[0])
    for i in range(v.size):
        x = float(v[i])
        c = ca if x > y else cr
        y = c * y + (1.0 - c) * x
        out[i] = y
    return out


def beat_pulse(times, fps, n, decay=0.25, t0=0.0):
    """1.0 on every beat, falling exponentially — "flash on the beat", ready made.

    A comp wanting a hit on each beat would otherwise have to build this from
    the raw beat list itself, once per property, and get the decay wrong.
    """
    p = np.zeros(n, dtype=np.float64)
    for t in times:
        i = int(round((t - t0) * fps))
        if 0 <= i < n:
            p[i] = 1.0
    if decay > 0 and n > 1:
        c = math.exp(-1.0 / max(1e-6, decay * fps))
        for i in range(1, n):
            held = p[i - 1] * c
            if held > p[i]:
                p[i] = held
    return p


def thin(t, v, eps):
    """Drop keys a straight line already reproduces within `eps`.

    One key per frame is correct and enormous: seven tracks over a 2.6-minute
    song at 30 fps is 28 000 keys and 830 KB of JSON, and most of those keys say
    "the envelope is still sloping the way it was". Douglas-Peucker measured
    VERTICALLY (error in the property's own units at a given time, which is what
    a viewer sees) removes about half of them at the default 0.004, for a
    reconstruction error of — measured, not assumed — 0.0041 worst case out of a
    0..1 range. 0.008 removes 60% for 0.0081. Both are invisible; the default is
    the cautious one.

    Iterative, not recursive: 10 000 points would otherwise blow the stack.
    """
    n = len(t)
    if eps <= 0 or n < 3:
        return np.ones(n, dtype=bool)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        span = t[b] - t[a]
        if span <= 0:
            continue
        lin = v[a] + (v[b] - v[a]) * ((t[a:b + 1] - t[a]) / span)
        d = np.abs(v[a:b + 1] - lin)
        k = int(np.argmax(d))
        if d[k] > eps:
            m = a + k
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return keep


def to_keys(values, fps, offset=0.0, ease="linear", eps=0.002, decimals=4):
    """Values on a frame grid → VFX_SPEC §1 keys."""
    n = len(values)
    if n == 0:
        return {"keys": []}
    t = offset + np.arange(n, dtype=np.float64) / fps
    v = np.asarray(values, dtype=np.float64)
    ease = str(ease or "linear").strip()
    linear = ease.lower() == "linear"
    mask = thin(t, v, eps) if linear else np.ones(n, dtype=bool)
    idx = np.nonzero(mask)[0]
    keys = []
    for i in idx:
        key = {"t": round(float(t[i]), 6), "v": round(float(v[i]), decimals)}
        if not linear:
            key["ease"] = ease
        keys.append(key)
    return {"keys": keys}


def refine_beats(y, sr, times, window=REFINE_WINDOW, block=REFINE_BLOCK,
                 lead=DETECTOR_LEAD):
    """Snap each beat to the attack that actually caused it.

    Takes the times `beats.track_beats` produced and nothing else — it assumes
    the `lead` bias those carry, and re-refining an already-refined list would
    push every beat late by that much.

    The spectral flux peak leads the true onset — a Hann window of length N sees
    a transient roughly N/4 samples before it arrives, and the DP then quantises
    what is left to the STFT hop. Both errors are in the frequency domain, so
    the fix is not there: step back to the samples, find where broadband energy
    JUMPS, and use that.

    Non-overlapping blocks on purpose. An overlapped window would smear the jump
    backwards in exactly the way being corrected for; a rectangular block that
    rises means "the onset is inside THIS 1.45 ms", which is a statement about
    time with no window in front of it. The block centre is reported, so the
    residual error is symmetric and under a millisecond.

    A beat with no energy rise anywhere near it keeps its DP time. That happens
    on sustained material, and moving it to the loudest bit of noise in the
    window would be worse than leaving it where the grid says.
    """
    times = [float(t) for t in times]
    if not times or y.size < block * 4:
        return times
    n_blocks = int(y.size // block)
    e = np.sqrt(np.square(
        y[:n_blocks * block].astype(np.float64).reshape(n_blocks, block)).mean(axis=1))
    rise = np.maximum(np.diff(e, prepend=e[:1]), 0.0)
    # Three blocks of smoothing: an attack spread over two blocks should read as
    # one event, and a single noisy block should not out-vote a real one.
    rise = np.convolve(rise, np.ones(3) / 3.0, mode="same")
    scale = float(np.percentile(rise, 99.5))
    if not math.isfinite(scale) or scale <= 0:
        return times
    w = max(1, int(round(window * sr / block)))
    out = []
    for t in times:
        k = int(round((t + lead) * sr / block))
        a, b = max(0, k - w), min(n_blocks, k + w + 1)
        if b <= a:
            out.append(t)
            continue
        seg = rise[a:b]
        j = int(np.argmax(seg))
        # 5% of the track's strongest rise is the bar for "an onset happened
        # here"; under that, trust the grid rather than the noise.
        if seg[j] < 0.05 * scale:
            out.append(t)
            continue
        out.append(((a + j) * block + block * 0.5) / sr)
    out.sort()
    # Two grid slots either side of a single hit can both snap onto it. Left in,
    # that is a duplicate beat time — a double trigger on anything driven by the
    # list, and a zero-length gap in the tempo fit that reads as an infinite BPM.
    return [t for i, t in enumerate(out) if i == 0 or t - out[i - 1] > 0.001]


def onset_span(env, frac=0.2, pct=99.0):
    """First and last analysis frame that contains a real onset, or None.

    beats.py's DP starts its chain at frame 0 and ends it in the final period.
    On a track that opens with silence — or a count-in, or a two-second fade —
    frame 0 is not a beat, and the grid spends the first several bars in the
    wrong PHASE before the onset rewards drag it into place. Measured on
    synthetic click tracks with 0.4 s of leading silence: the first five beats
    came out up to 204 ms wrong at 90 BPM, which no amount of sample-domain
    refinement can rescue, because 204 ms is a third of a beat and not a
    rounding error.

    Anchoring the DP to the first frame that actually has an onset in it fixes
    that outright: the same tracks then come in at 0.5-0.6 ms mean error across
    90/100/120/140 BPM, whatever the leading silence.

    Returning None for "no onsets anywhere" is the other half of this. Silence
    has no tempo, and without this the DP happily lays a confident 120 BPM grid
    over a blank file.
    """
    if env.size == 0:
        return None
    ref = float(np.percentile(env, pct))
    if ref <= 0:
        ref = float(env.max())
    if not math.isfinite(ref) or ref <= 0:
        return None
    hits = np.nonzero(env >= frac * ref)[0]
    if hits.size == 0:
        return None
    return int(hits[0]), int(hits[-1])


def halve(env):
    """The onset envelope at half rate, keeping the peaks.

    `beats.estimate_tempo` autocorrelates with `np.correlate`, which is O(n²) —
    at the 86 fps hop this file uses, a three-minute song makes that 1.37 s, far
    and away the most expensive thing in the whole analysis. It does not need
    that resolution: it is looking for a periodicity between a third of a second
    and one second, and 43 fps resolves that with room to spare. Measured on the
    demo track, half rate returns the SAME seed (161.50 BPM) in 0.005 s.

    Max rather than mean, because an onset envelope is spikes: averaging two
    frames halves every hit and leaves the autocorrelation with less to lock on.
    """
    if env.size < 4:
        return env
    m = env.size // 2
    return np.maximum(env[:2 * m:2], env[1:2 * m:2])


def analyse(job):
    began = time.time()
    path = job.get("audio") or job.get("path") or job.get("in")
    if not path:
        raise ValueError("job needs an 'audio' path")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)

    fps = _f(job.get("fps"), 30.0) or 30.0
    if not (0.1 <= fps <= 240.0):
        raise ValueError(f"fps {fps} outside 0.1..240")
    gain = max(0.0, _f(job.get("gain"), 1.0))
    floor = min(1.0, max(0.0, _f(job.get("floor"), 0.0)))
    attack = max(0.0, _f(job.get("attack"), 0.01))
    release = max(0.0, _f(job.get("release"), 0.20))
    smooth = job.get("smooth", True) is not False
    curve = str(job.get("curve") or "db").lower()
    range_db = max(1.0, _f(job.get("rangeDb"), 48.0))
    win = max(0.001, _f(job.get("window"), 0.05))
    ref_pct = min(100.0, max(50.0, _f(job.get("refPercentile"), 99.0)))
    band_floor_db = _f(job.get("bandFloorDb"), -60.0)
    want_beats = job.get("beats", True) is not False
    beat_decay = max(0.0, _f(job.get("beatDecay"), 0.25))
    ease = job.get("ease") or "linear"
    eps = max(0.0, _f(job.get("epsilon"), 0.004))
    decimals = int(_f(job.get("decimals"), 4))
    raw_too = bool(job.get("raw"))
    offset = _f(job.get("offset"), 0.0)
    wanted = job.get("tracks")
    wanted = set(wanted) if isinstance(wanted, list) and wanted else None

    y, sr = _beats.load_mono(path, SR)
    if y.size == 0:
        raise ValueError("no audio samples")
    t_from = max(0.0, _f(job.get("from"), 0.0))
    t_to = _f(job.get("to"), 0.0) if job.get("to") is not None else None
    if t_from > 0 or t_to:
        a = int(t_from * sr)
        b = int(t_to * sr) if t_to else y.size
        y = y[a:max(a + 1, min(b, y.size))]
    seconds = float(y.size) / sr
    n = max(1, int(round(seconds * fps)))

    # ── the spectrogram, once ────────────────────────────────────────────────
    # beats.onset_envelope returns its own log1p'd magnitudes; log1p is exactly
    # invertible, so the linear spectrum the bands need costs an expm1 rather
    # than a second STFT over four million samples.
    env, env_fps, log_mag = _beats.onset_envelope(y, sr, hop=HOP, n_fft=N_FFT)
    mag = np.expm1(log_mag) / 10.0
    freqs = np.linspace(0.0, sr / 2.0, mag.shape[0])

    # ── beats ────────────────────────────────────────────────────────────────
    beat_times, bars, bpm, bpm_seed, conf = [], [], None, None, None
    span = onset_span(env) if want_beats and y.size >= sr // 2 else None
    if span is not None:
        i0, i1 = span
        sub = env[i0:i1 + 1]
        t0 = i0 / env_fps
        # Tempo on the half-rate envelope, the grid on the full-rate one: a BPM
        # is a scalar and carries no timebase, so the two can disagree about
        # resolution without disagreeing about the answer.
        bpm_seed, conf = _beats.estimate_tempo(halve(sub), env_fps / 2.0)
        beat_times = refine_beats(
            y, sr, [t + t0 for t in _beats.track_beats(sub, env_fps, bpm_seed)])
        bars = beat_times[::4]
        if len(beat_times) > 3:
            # A linear fit over beat index, beats.py's trick: individual gaps
            # alternate between neighbouring analysis frames, so a median gap
            # reads a few tenths of a percent off and drifts audibly over three
            # minutes. The slope of the line through (index, time) does not.
            idx = np.arange(len(beat_times), dtype=np.float64)
            period = float(np.polyfit(idx, np.asarray(beat_times), 1)[0])
            bpm = 60.0 / period if period > 0 else bpm_seed
        else:
            bpm = bpm_seed

    # ── raw measurements, on the comp's grid ─────────────────────────────────
    measured = {}
    measured["amplitude"] = frame_rms(y, sr, fps, n, window=win)
    full = band_rms(mag, freqs, 0.0, sr / 2.0)
    full_ref = float(np.percentile(full, ref_pct)) if full.size else 0.0
    # A band this far under the full mix is leakage and dither, not content.
    # Without this gate, self-normalising each band turns a solo bassline into a
    # confident hi-hat track that is entirely invented.
    band_gate = full_ref * (10.0 ** (band_floor_db / 20.0))
    band_db, silent = {}, []
    for name, (lo, hi) in BANDS.items():
        b = band_rms(mag, freqs, lo, hi)
        ref = float(np.percentile(b, ref_pct)) if b.size else 0.0
        band_db[name] = (round(20.0 * math.log10(max(ref, 1e-12) / max(full_ref, 1e-12)), 1)
                         if full_ref > 0 else None)
        if ref <= max(band_gate, 1e-9):
            silent.append(name)
        measured[name] = to_fps(b, env_fps, fps, n)
    measured["onset"] = to_fps(env, env_fps, fps, n, reduce="max")

    # ── normalise, smooth, gain, floor ───────────────────────────────────────
    def _shape(v):
        """gain then the floor..1 remap — the last step for every track."""
        return floor + (1.0 - floor) * np.clip(v * gain, 0.0, 1.0)

    tracks, raws = {}, {}
    for name, v in measured.items():
        if name == "onset":
            # The flux envelope is already normalised and already a difference —
            # a dB curve on top of it would mostly amplify the gaps between hits.
            x = np.clip(v, 0.0, 1.0)
        else:
            gate = band_gate if name in BANDS else 0.0
            x = normalise(v, curve=curve, range_db=range_db,
                          ref_pct=ref_pct, gate=gate)
        # The raw variant gets the SAME gain and floor, so the only difference
        # between it and the shipped track is the smoothing — which is the whole
        # reason a caller would ask for both.
        raws[name] = _shape(x)
        tracks[name] = _shape(envelope(x, fps, attack, release) if smooth else x)

    if want_beats:
        pulse = beat_pulse(beat_times, fps, n, decay=beat_decay)
        raws["beat"] = _shape(pulse)
        # The pulse is a shape, not a measurement: smoothing it would round off
        # the very edge that makes it a hit. Only gain and floor apply.
        tracks["beat"] = _shape(pulse)

    out_tracks = {}
    for name in ALL_TRACKS:
        if name not in tracks:
            continue
        if wanted and name not in wanted:
            continue
        out_tracks[name] = to_keys(tracks[name], fps, offset=offset, ease=ease,
                                   eps=eps, decimals=decimals)
        if raw_too:
            out_tracks[name + "Raw"] = to_keys(raws[name], fps, offset=offset,
                                               ease=ease, eps=eps, decimals=decimals)

    return {
        "ok": True,
        "tracks": out_tracks,
        "beats": [round(float(t) + offset, 4) for t in beat_times],
        "bars": [round(float(t) + offset, 4) for t in bars],
        "bpm": round(float(bpm), 2) if bpm else None,
        "bpmSeed": round(float(bpm_seed), 2) if bpm_seed else None,
        "beatConfidence": round(float(conf), 3) if conf is not None else None,
        "seconds": round(seconds, 4),
        "fps": fps,
        "frames": n,
        "sampleRate": sr,
        "bands": {k: list(v) for k, v in BANDS.items()},
        # How loud each band actually was relative to the whole mix, and which
        # ones were gated. Self-normalising a band is what makes a quiet hi-hat
        # usable and it is also what would turn leakage into a confident
        # animation, so the caller gets to see the number rather than trusting
        # this file's threshold blindly.
        "bandDb": band_db,
        "silentBands": silent,
        "curve": curve,
        "gain": gain,
        "floor": floor,
        "attack": attack,
        "release": release,
        "smoothed": bool(smooth),
        "keyCount": sum(len(t["keys"]) for t in out_tracks.values()),
        "importMs": _IMPORT_MS,
        "ms": int((time.time() - began) * 1000),
    }


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if not argv:
            raise ValueError("usage: audiokeys.py <job.json>")
        with open(argv[0], encoding="utf-8") as fh:
            job = json.load(fh)
        result = analyse(job)
    except Exception as exc:                            # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
