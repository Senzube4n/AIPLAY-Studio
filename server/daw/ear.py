"""THE EAR — the objective critic. §11b of the DAW report, v0.

  python server/daw/ear.py analyse <job.json>   render a window, measure it, critique it
  python server/daw/ear.py file    <job.json>   measure an existing bounce/wav (master only)
  python server/daw/ear.py judge   <job.json>   the SUBJECTIVE stage (or its honest absence)
  python server/daw/ear.py probe                what this ear can and cannot do here
  python server/daw/ear.py serve                the same, over stdin (engine.py's protocol)

── WHAT THIS FILE IS ───────────────────────────────────────────────────────
The half of the Ear that cannot be fooled. No model runs here. Every number
is a measurement of the actual samples the renderer produced, and every
finding carries the four things a mix note needs to be actionable:

    WHAT      the metric that is off              ("masking", "lufs", "width")
    WHERE     track / bar-range / frequency band  ("pad over voc, 250-500 Hz, bars 9-16")
    HOW MUCH  observed vs target, in dB           (-3.1 dB, target <= -6 dB)
    SEVERITY  low | medium | high                 (how far past the threshold)

A finding that cannot name a concrete edit is demoted to a note by the layer
above (ear.js); this file's job is to be RIGHT, not persuasive.

── WHAT IS REUSED, NOT REIMPLEMENTED ───────────────────────────────────────
rack.py already carries BS.1770-4 K-weighting, gated integrated LUFS, the
short-term series and 4x-oversampled true peak, with rack_test.py pinning the
filter's response shape against the standard's own table. This module imports
them (`rack.lufs_integrated`, `rack.lufs_short_term`, `rack.true_peak_db`) and
adds nothing of its own to that maths. It also drives rack.chain_graph() with
capture=True to obtain the per-track post-fader buses — the SAME graph the
render and the meters use, so what the Ear hears is what the file holds.
Nothing in rack.py, engine.py, instruments.py or capture.py is modified.

── THE THREE THINGS THIS FILE REFUSES TO DO ────────────────────────────────
 1. Guess. Where a target depends on knowledge we do not have (what ROLE a
    track plays in the arrangement), no target is invented: the level is
    measured and reported, and the balance finding only fires when a role or
    an explicit target was supplied. Inferred roles ride at lower confidence.
 2. Score subjectively. The aesthetic judges (§11a) live in `judge` and are
    reported ABSENT when they are absent. There is no fallback that turns a
    DSP number into a fake "production quality 7.4".
 3. Link AGPL. essentia is AGPL-3.0 and is never imported. librosa (ISC) is
    optional and only ever used for conveniences; the critics below are numpy
    and scipy, which the rig venv already has for the renderer.

── THE BANDS ───────────────────────────────────────────────────────────────
Nine bands, roughly octave-wide, chosen so a mix note lands on a fader move a
human recognises ("the 250-500 boxiness", "the 2-4 k presence"). The REFERENCE
curve they are compared against is PINK — equal energy per octave — computed
from the band edges themselves (log2(hi/lo)), not copied from a magazine.
That is a principled null hypothesis, not a genre claim. Genre tilts on top
are house heuristics, small, and labelled as such in GENRE_TILT.

── AND THEY ARE MEASURED PER CHANNEL ───────────────────────────────────────
`spectral_balance` reads the LEFT channel, the RIGHT channel and the mono
fold, and reports all three. The fold keeps the old keys, so every threshold
and card written against `deviation_db` is unmoved; the per-channel numbers
exist because a mid measurement cannot see either of the two things a stereo
mix does wrong. It hides an imbalance (the arranger's drop window reads
boxiness +2.72 dB left, −0.22 right, and −0.02 folded) and it invents a loss
(tr909's `hat_width` allpass costs the hats bus 0.00 dB in each channel and
1.37 dB in the fold). See spectral_balance's own docstring.
"""
import json
import math
import os
import sys
import time

import numpy as np

# rack.py is a sibling: run as a script, server/daw is on sys.path already;
# imported as a module (the tests), add it explicitly.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rack  # noqa: E402  -- the BS.1770 maths and the chain graph, reused

DEFAULT_SR = 48000

# ─────────────────────────────────────────────────────────────── the bands

BANDS = [
    (20.0, 60.0), (60.0, 120.0), (120.0, 250.0), (250.0, 500.0),
    (500.0, 1000.0), (1000.0, 2000.0), (2000.0, 4000.0),
    (4000.0, 8000.0), (8000.0, 20000.0),
]
BAND_LABELS = [f"{int(lo)}-{int(hi)}Hz" for lo, hi in BANDS]
# What a human calls each band, so the card reads like a mix note.
BAND_NAMES = ["sub", "low", "low-mid", "boxiness", "mid",
              "upper-mid", "presence", "brilliance", "air"]


def pink_reference_db():
    """The null hypothesis: equal energy per octave, expressed as each band's
    share of the total in dB. Derived from the band edges, so editing BANDS
    keeps the reference honest."""
    oct_w = np.array([math.log2(hi / lo) for lo, hi in BANDS])
    share = oct_w / oct_w.sum()
    return 10.0 * np.log10(share)


# House heuristics, NOT measurements of a corpus. Small on purpose: a wrong
# reference curve produces confident nonsense, and the pink null above is what
# actually carries the finding. Editable; every value is a dB offset on pink.
GENRE_TILT = {
    "neutral":  [0, 0, 0, 0, 0, 0, 0, 0, 0],
    "pop":      [-1, +1, 0, -1, 0, 0, +1, +1, 0],
    "edm":      [+3, +3, 0, -2, -1, 0, 0, +1, +1],
    "hiphop":   [+4, +3, 0, -2, -1, 0, 0, 0, 0],
    "rock":     [-2, +1, +1, 0, +1, +1, +1, 0, -1],
    "acoustic": [-4, -1, 0, 0, +1, +1, +1, +1, 0],
}

# How far under the loudest band a band has to sit before it counts as EMPTY
# rather than merely under-represented. 30 dB is two and a half orders of
# magnitude of power: nothing musical is happening there.
ABSENT_DB = 30.0

# Streaming's settled convention (§11e cold start), overridable per job.
DEFAULT_TARGETS = {
    "lufs": -14.0,             # integrated, BS.1770-4
    "lufs_tolerance": 1.0,     # a mix note under this is noise
    "true_peak_db": -1.0,      # dBTP ceiling
    "band_tolerance": 3.0,     # dB off the reference curve before it is a note
    "masking_margin_db": 6.0,  # masker over maskee in a band the maskee needs
    "crest_low_db": 6.0,       # under this the master is squashed
    "crest_high_db": 24.0,     # over this it is spiky/unmastered
    "dc_db": -60.0,            # DC offset ceiling
    "balance_tolerance": 3.0,  # dB off a track's role target
    "correlation_low": -0.2,   # under this the stereo image is out of phase
    "narrow_width": 0.02,      # side/mid under this reads as mono
    # L/R correlation at or above this is DUAL MONO: two copies of one signal.
    # A spread big-room lead reads ~0.7 at the voice; 1.000 at the master means
    # something folded it — the defect the first 4:00 bounce shipped with.
    "dual_mono_correlation": 0.99,
    # Kick fundamental vs the song's root, in cents, before it is a note. 30 c
    # at 44 Hz is a 0.8 Hz beat against the sub; the shipped +166 c beat at 4.4.
    "tuning_cents": 30.0,
}

# Where a GENRE's master usually lands, by delivery. Only rows somebody can
# stand behind: big room / EDM club masters sit around -8 LUFS integrated
# (crest ~9 dB), and every streaming service normalises to -14 or thereabouts
# (master.py's DELIVERY_TARGETS carries the per-platform table with sources).
# A project's own `target_lufs` beats this table; the streaming default
# (DEFAULT_TARGETS["lufs"]) is what remains when neither is known.
GENRE_LOUDNESS = {
    "edm": {"club": -8.0, "streaming": -14.0},
}
DEFAULT_DELIVERY = {"edm": "club"}

# The kick patches whose fundamental this ear can measure and name a knob
# for: patch -> (the tuning knob, in semitones; which GM keys ARE the kick on
# a kit, so a 909's hats do not end up in the f0 estimate).
KICK_TUNE_KNOBS = {
    "hybrid_kick": ("tune", None),          # every key is the kick
    "tr808": ("kick_tune", (35, 36)),
    "tr909": ("kick_tune", (35, 36)),
}
NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# Role → where that track's integrated LUFS usually sits relative to the mix's.
# House heuristics again, and the ONLY place a target is invented — which is
# why a finding built on an INFERRED role rides at confidence 0.5, and a role
# we could not infer produces a measurement and no finding at all.
ROLE_OFFSET_DB = {
    "lead": -6.0, "vocal": -6.0, "drums": -8.0, "bass": -9.0,
    "guitar": -12.0, "keys": -13.0, "pad": -15.0, "fx": -18.0,
}

# ───────────────────────────────────────────────────────────────── wav i/o


def read_wav_stereo(path):
    """RIFF float32 or PCM16/24/32 -> (2, N) float64 at the file's rate.
    Mono files are duplicated to both channels. Chunk-walking, so a wav with
    extra chunks still reads. Returns (y, sr)."""
    import struct
    with open(path, "rb") as f:
        head = f.read(12)
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError(f"not a RIFF/WAVE file: {path}")
        fmt = None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                raise ValueError(f"no data chunk in {path}")
            cid, size = struct.unpack("<4sI", hdr)
            body = f.read(size)
            if size % 2:
                f.read(1)
            if cid == b"fmt ":
                fmt = struct.unpack("<HHIIHH", body[:16])
            elif cid == b"data":
                if fmt is None:
                    raise ValueError("data before fmt")
                tag, ch, sr, _br, _ba, bits = fmt
                if tag == 3 and bits == 32:
                    a = np.frombuffer(body, dtype="<f4").astype(np.float64)
                elif tag == 1 and bits == 16:
                    a = np.frombuffer(body, dtype="<i2").astype(np.float64) / 32768.0
                elif tag == 1 and bits == 32:
                    a = np.frombuffer(body, dtype="<i4").astype(np.float64) / 2147483648.0
                else:
                    raise ValueError(f"unsupported wav format tag={tag} bits={bits}")
                if ch == 1:
                    return np.vstack([a, a]), sr
                a = a[: (len(a) // ch) * ch].reshape(-1, ch).T
                return np.vstack([a[0], a[1] if ch > 1 else a[0]]), sr


def read_audio_stereo(path, want_sr=None):
    """Any container the rig can decode -> (2, N) float64. wav natively;
    everything else (the FLAC bounce) through PyAV, which capture.py already
    depends on. A rate mismatch is an ERROR, never a silent resample."""
    if str(path).lower().endswith(".wav"):
        y, sr = read_wav_stereo(path)
    else:
        import av  # noqa: PLC0415 -- optional, only for non-wav
        with av.open(str(path)) as cont:
            st = next(s for s in cont.streams if s.type == "audio")
            sr = int(st.codec_context.sample_rate)
            chunks = []
            for frame in cont.decode(st):
                arr = frame.to_ndarray()
                ch = frame.layout.nb_channels if frame.layout else 1
                # ── DE-INTERLEAVING, and why this is spelled out ───────────
                # PyAV returns PLANAR formats as (channels, N) and PACKED ones
                # as (1, N*channels) — and FLAC decodes packed. Taking row 0 of
                # a packed frame as "the left channel" silently yields the
                # INTERLEAVED stream read as mono: twice as long, every sample
                # duplicated, peak and RMS unchanged (so nothing looks wrong)
                # and LUFS, true peak and every band level quietly wrong. That
                # is exactly what happened here before this branch existed —
                # caught only by comparing a bounce against the region renders
                # it was assembled from, sample for sample.
                if arr.ndim == 1:
                    arr = arr.reshape(-1, ch).T if ch > 1 else arr[None, :]
                elif arr.shape[0] == 1 and ch > 1:
                    arr = arr[0].reshape(-1, ch).T
                if arr.dtype == np.int16:
                    arr = arr.astype(np.float64) / 32768.0
                elif arr.dtype == np.int32:
                    arr = arr.astype(np.float64) / 2147483648.0
                else:
                    arr = arr.astype(np.float64)
                chunks.append(arr)
            if not chunks:
                raise ValueError(f"no audio decoded from {path}")
            a = np.concatenate(chunks, axis=1)
            y = np.vstack([a[0], a[1] if a.shape[0] > 1 else a[0]])
    if want_sr and int(sr) != int(want_sr):
        raise ValueError(
            f"{path} is {sr} Hz but the project is {want_sr} Hz — the Ear does "
            "not resample (a resampled measurement is a measurement of the "
            "resampler). Re-render or import at the project rate.")
    return y, int(sr)


# ───────────────────────────────────────────────────────── the spectrogram

WIN = 4096
HOP = 1024


def _band_bins(sr, n_fft=WIN):
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    return [np.where((freqs >= lo) & (freqs < hi))[0] for lo, hi in BANDS]


def band_spectrogram(x, sr):
    """Per-frame energy in each band of a mono signal.

    Returns (times, E) where E is (n_bands, n_frames) MEAN power per band
    (power, not dB — callers convert). Hann-windowed, 75 % overlap. Power is
    normalised by the window's own energy so a band's dB is comparable to the
    signal's RMS dB rather than to an arbitrary FFT scale."""
    x = np.asarray(x, dtype=np.float64).ravel()
    if len(x) < WIN:
        x = np.pad(x, (0, WIN - len(x)))
    w = np.hanning(WIN)
    wsum = float(np.sum(w ** 2))
    n_frames = 1 + (len(x) - WIN) // HOP
    bins = _band_bins(sr)
    E = np.zeros((len(BANDS), n_frames))
    times = np.zeros(n_frames)
    for i in range(n_frames):
        seg = x[i * HOP: i * HOP + WIN] * w
        # |X|^2 scaled so a full-scale sine reads ~ its own mean square.
        P = (np.abs(np.fft.rfft(seg)) ** 2) * (2.0 / (wsum * WIN))
        for b, idx in enumerate(bins):
            E[b, i] = float(P[idx].sum()) if len(idx) else 0.0
        times[i] = (i * HOP + WIN / 2.0) / sr
    return times, E


def _db(p, floor=1e-14):
    return 10.0 * np.log10(np.maximum(p, floor))


# ───────────────────────────────────────────────────────────── the critics


def loudness(x, sr, short=True):
    """Master loudness: integrated LUFS, true peak dBTP, peak/RMS dBFS, crest,
    and (optionally) the short-term series + its range. rack.py's maths."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.vstack([x, x])
    li = rack.lufs_integrated(x, sr)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    peak_db = 20.0 * math.log10(max(peak, 1e-12))
    rms_db = 20.0 * math.log10(max(rms, 1e-12))
    out = {
        "lufs": None if not math.isfinite(li) else round(li, 2),
        "true_peak_db": round(rack.true_peak_db(x), 2),
        "peak_db": round(peak_db, 2),
        "rms_db": round(rms_db, 2),
        "crest_db": round(peak_db - rms_db, 2),
    }
    if short:
        series = rack.lufs_short_term(x, sr)
        vals = [v for _, v in series if v > -70.0]
        out["lufs_short"] = series
        # LRA-shaped: the 10th..95th percentile spread of the short-term series.
        out["lufs_range"] = (round(float(np.percentile(vals, 95) - np.percentile(vals, 10)), 2)
                             if len(vals) >= 3 else None)
    return out


def stereo_stats(x):
    """Correlation, mid/side energies and WIDTH = side_rms / mid_rms.

    A mono-summed (identical-channel) signal has zero side energy, so width is
    exactly 0.0 — the property the test pins. Correlation is Pearson over the
    two channels; a silent signal reports correlation None rather than 0,
    because 'no signal' is not 'in phase'."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.vstack([x, x])
    L, R = x[0], x[1]
    mid = (L + R) * 0.5
    side = (L - R) * 0.5
    mid_rms = float(np.sqrt(np.mean(mid ** 2))) if mid.size else 0.0
    side_rms = float(np.sqrt(np.mean(side ** 2))) if side.size else 0.0
    ls, rs = float(np.std(L)), float(np.std(R))
    corr = (float(np.corrcoef(L, R)[0, 1]) if ls > 1e-12 and rs > 1e-12 else None)
    return {
        "width": round(side_rms / mid_rms, 6) if mid_rms > 1e-12 else (
            None if side_rms <= 1e-12 else float("inf")),
        "correlation": None if corr is None or not math.isfinite(corr) else round(corr, 4),
        "mid_rms_db": round(20.0 * math.log10(max(mid_rms, 1e-12)), 2),
        "side_rms_db": round(20.0 * math.log10(max(side_rms, 1e-12)), 2),
        "mono_compatible": None if corr is None else bool(corr > 0.2),
    }


def dc_and_clipping(x, sr, ceiling=0.999):
    """DC offset per channel (dB), plus digital clipping: samples at or over
    the ceiling and the longest run of them. A run of 1 is a coincidence; a
    run of 3+ is a flat top."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.vstack([x, x])
    out = {"dc": [], "clipped_samples": 0, "longest_run": 0, "first_clip_sec": None}
    for ch in range(x.shape[0]):
        m = float(np.mean(x[ch])) if x[ch].size else 0.0
        out["dc"].append({
            "channel": ch, "offset": round(m, 8),
            "offset_db": round(20.0 * math.log10(max(abs(m), 1e-12)), 2),
        })
    over = np.abs(x) >= ceiling
    flat = over.any(axis=0)
    out["clipped_samples"] = int(np.count_nonzero(flat))
    if out["clipped_samples"]:
        idx = np.flatnonzero(flat)
        out["first_clip_sec"] = round(float(idx[0]) / sr, 4)
        # longest consecutive run
        best = run = 1
        for a, b in zip(idx, idx[1:]):
            run = run + 1 if b == a + 1 else 1
            best = max(best, run)
        out["longest_run"] = int(best)
    return out


def _band_share(mono, sr):
    """(share_db, level_db) per band for ONE mono signal. The share is what
    the reference curve is written in; the level is what `absent` is decided
    on and what the mapping layer names a band's owner by."""
    _, E = band_spectrogram(mono, sr)
    band_p = E.mean(axis=1)
    tot = float(band_p.sum())
    obs = _db(band_p / tot) if tot > 0 else np.full(len(BANDS), -120.0)
    return obs, _db(band_p)


def spectral_balance(x, sr, genre="neutral"):
    """Long-term band energies (dB, share of total) against the reference
    curve — measured on the LEFT channel, the RIGHT channel and the mono
    FOLD, and reported as all three.

    ── WHY THREE NUMBERS AND NOT ONE ───────────────────────────────────────
    This function used to measure `x.mean(axis=0)` and stop. That average IS
    the mid signal, and a mid measurement is a measurement of what SUMS — so
    anything the two channels do differently is either hidden or invented:

      hidden      an L/R imbalance vanishes into the average. On the
                  arranger's own drop window (bars 25-28, the real graph) the
                  boxiness band reads +2.72 dB on the left and −0.22 on the
                  right; the fold reports −0.02, i.e. dead on target, for a
                  mix that is 2.94 dB lopsided in that band.
      invented    a decorrelated channel COMB-FILTERS against its partner in
                  the sum, so the fold loses energy neither channel has lost.
                  tr909's `hat_width` allpasses the right hat: on the hats
                  bus at the shipped 0.6 the air band is unchanged in both
                  channels (±0.00 dB) and 1.37 dB down in the fold. Read
                  mono, that knob looks like it costs top end. It does not —
                  it costs top end TO A MONO LISTENER, which is a different
                  sentence and a different fix.

    So the row keeps its old keys (`observed_db`, `deviation_db`, `level_db`,
    `absent`) meaning exactly what they always meant — the fold — so every
    card, penalty and threshold written against them reads unchanged, and it
    gains `left_*` / `right_*` beside them plus `mid_db`, which is the fold
    under its own name. `channel_spread_db` is L−R in share; `fold_cost_db`
    is mid − min(L, R) in level, so it is ZERO for anything correlated and
    NEGATIVE exactly where a widener, an allpass or an out-of-phase part
    made the sum hold less than either side does.

    A mono input (or a dual-mono one) costs nothing extra: the second
    spectrogram is skipped when the channels are the same samples."""
    x = np.asarray(x, dtype=np.float64)
    # The fold, computed EXACTLY as it always was — every number derived from
    # it has to stay put.
    mid = x.mean(axis=0) if x.ndim > 1 else x
    if x.ndim > 1 and x.shape[0] >= 2:
        left, right = x[0], x[1]
    else:
        left = right = mid
    dual = left is right or np.array_equal(left, right)
    obs_m, lvl_m = _band_share(mid, sr)
    if dual:
        obs_l, lvl_l = obs_m, lvl_m
        obs_r, lvl_r = obs_m, lvl_m
    else:
        obs_l, lvl_l = _band_share(left, sr)
        obs_r, lvl_r = _band_share(right, sr)
    ref = pink_reference_db() + np.array(GENRE_TILT.get(genre, GENRE_TILT["neutral"]),
                                         dtype=np.float64)
    ref = ref - 10.0 * np.log10(np.sum(10.0 ** (ref / 10.0)))   # renormalise to a share
    levels = lvl_m
    top = float(np.max(levels)) if len(levels) else -120.0
    rows = []
    worst_spread = {"band": None, "band_index": None, "name": None, "db": 0.0}
    worst_fold = {"band": None, "band_index": None, "name": None, "db": 0.0}
    for b in range(len(BANDS)):
        spread = float(obs_l[b] - obs_r[b])
        # NEGATIVE = the fold holds less than either channel does: the two
        # sides cancelled each other in the sum. Zero for anything correlated.
        fold_cost = float(lvl_m[b] - min(lvl_l[b], lvl_r[b]))
        rows.append({
            "band": BAND_LABELS[b], "band_index": b, "name": BAND_NAMES[b],
            "observed_db": round(float(obs_m[b]), 2),
            "reference_db": round(float(ref[b]), 2),
            "deviation_db": round(float(obs_m[b] - ref[b]), 2),
            "level_db": round(float(levels[b]), 2),
            # ── THE THREE CHANNELS ──────────────────────────────────────
            # `mid_db` is `observed_db` under its own name: the fold, kept
            # as the third number so a card written before this change reads
            # the same value it always read.
            "left_db": round(float(obs_l[b]), 2),
            "right_db": round(float(obs_r[b]), 2),
            "mid_db": round(float(obs_m[b]), 2),
            "deviation_left_db": round(float(obs_l[b] - ref[b]), 2),
            "deviation_right_db": round(float(obs_r[b] - ref[b]), 2),
            "level_left_db": round(float(lvl_l[b]), 2),
            "level_right_db": round(float(lvl_r[b]), 2),
            "channel_spread_db": round(spread, 2),
            "fold_cost_db": round(fold_cost, 2),      # mid − min(L, R), dB
            # ── THE ABSENT-BAND RULE ────────────────────────────────────
            # A band more than ABSENT_DB under the loudest band is not
            # "quiet against the reference", it is EMPTY: nothing is playing
            # there. Reporting that as a balance error produces the single
            # worst class of advice a mix critic can give — "boost 20-60 Hz
            # by 23 dB" on a mix with no bass part, which adds rumble, eats
            # headroom, and measurably makes the mix worse (the A/B guard
            # caught exactly this and reverted it, which is how the rule got
            # written). An empty band is an ARRANGEMENT note, not an EQ move.
            "absent": bool(levels[b] < top - ABSENT_DB),
        })
        if not rows[-1]["absent"]:           # an empty band's spread is noise
            if abs(spread) > abs(worst_spread["db"]):
                worst_spread = {"band": BAND_LABELS[b], "band_index": b,
                                "name": BAND_NAMES[b], "db": round(spread, 2)}
            if fold_cost < worst_fold["db"]:
                worst_fold = {"band": BAND_LABELS[b], "band_index": b,
                              "name": BAND_NAMES[b], "db": round(fold_cost, 2)}
    return {"genre": genre, "reference": "pink (equal energy per octave) + genre tilt",
            "loudest_band_db": round(top, 2), "bands": rows,
            # What the legacy keys are measured on, said out loud.
            "fold": "mid ((L+R)/2)", "measured": ["left", "right", "mid"],
            "dual_mono": bool(dual),
            "channel_spread": worst_spread,
            "fold_hides": worst_fold}


def bar_band_levels(stem, sr, bars):
    """(n_bars, n_bands) band LEVEL in dB for one track, averaged over each
    bar's own time span. `bars` is [{bar, t0, t1}, ...] from the server's
    derived timeline — bars are NOT equal length in mixed meter, so the
    windows come from the timeline, never from an assumed bar duration."""
    mono = stem.mean(axis=0) if np.asarray(stem).ndim > 1 else np.asarray(stem)
    times, E = band_spectrogram(mono, sr)
    out = np.full((len(bars), len(BANDS)), -140.0)
    for i, br in enumerate(bars):
        sel = (times >= br["t0"]) & (times < br["t1"])
        if not sel.any():
            sel = np.zeros_like(times, dtype=bool)
            j = int(np.argmin(np.abs(times - (br["t0"] + br["t1"]) / 2.0)))
            sel[j] = True
        out[i] = _db(E[:, sel].mean(axis=1))
    return out


def masking_events(levels_by_track, bars, margin_db=6.0,
                   presence_db=-60.0, salience=0.08, activity_db=12.0):
    """Which track masks which, in which band, in which bars.

    For every ordered pair and every (bar, band): the LOUDER track is the
    masker. It is only a finding when the QUIETER track actually needs that
    band and is actually PLAYING there, and the masker sits at least
    `margin_db` over it. Three gates on the maskee, each earning its keep:

      presence   its band level is above an absolute floor (`presence_db`)
      salience   that band carries >= `salience` of its energy in that bar —
                 nobody cares that a bass is buried at 8 kHz
      activity   its band level is within `activity_db` of its OWN loudest bar
                 in that band. This is the gate that stops the classic false
                 positive: a track that enters at bar 9 has a sliver of
                 analysis-window leakage in bar 8, sits 20 dB under everything
                 else there, and would otherwise be reported as "masked in bar
                 8" by whatever else is playing. Being quiet because you are
                 not playing yet is not being masked.

    Contiguous bars collapse into ranges. Returns raw events; the finding
    layer ranks and words them."""
    tids = sorted(levels_by_track)
    events = []
    for v in tids:                                  # the maskee
        Lv = levels_by_track[v]
        # share of the maskee's own bar energy that lives in each band
        pv = 10.0 ** (Lv / 10.0)
        tot = pv.sum(axis=1, keepdims=True)
        share = np.divide(pv, np.maximum(tot, 1e-30))
        active = Lv >= (Lv.max(axis=0, keepdims=True) - activity_db)
        for m in tids:                              # the masker
            if m == v:
                continue
            Lm = levels_by_track[m]
            hit = ((Lv > presence_db) & active & (share >= salience)
                   & ((Lm - Lv) >= margin_db))
            if not hit.any():
                continue
            for b in range(len(BANDS)):
                col = hit[:, b]
                if not col.any():
                    continue
                i = 0
                while i < len(col):
                    if not col[i]:
                        i += 1
                        continue
                    j = i
                    while j + 1 < len(col) and col[j + 1]:
                        j += 1
                    span = slice(i, j + 1)
                    margins = (Lm[span, b] - Lv[span, b])
                    events.append({
                        "masker": m, "maskee": v, "band_index": b,
                        "band": BAND_LABELS[b], "band_name": BAND_NAMES[b],
                        "from_bar": bars[i]["bar"], "to_bar": bars[j]["bar"],
                        "t0": bars[i]["t0"], "t1": bars[j]["t1"],
                        "margin_db": round(float(np.mean(margins)), 2),
                        "worst_margin_db": round(float(np.max(margins)), 2),
                        "maskee_level_db": round(float(np.mean(Lv[span, b])), 2),
                        "masker_level_db": round(float(np.mean(Lm[span, b])), 2),
                        "bars_covered": int(j - i + 1),
                    })
                    i = j + 1
    # worst first: deepest masking over the most bars
    events.sort(key=lambda e: (-e["margin_db"] * math.log2(1 + e["bars_covered"])))
    return events


# ──────────────────────────────────────────── the target, the root, the kick


def resolve_loudness_target(opts, T=None):
    """(target LUFS, source, delivery). The project's own `target_lufs` wins;
    then the genre table by delivery ("club" for edm unless told
    "streaming"); then the streaming default. `source` says which, because
    a card that quotes -8 LUFS had better say WHY -8."""
    T = T or DEFAULT_TARGETS
    genre = str(opts.get("genre") or "neutral")
    delivery = opts.get("delivery")
    proj = opts.get("target_lufs")
    if proj is not None and math.isfinite(float(proj)):
        return float(proj), "project", (delivery or None)
    table = GENRE_LOUDNESS.get(genre)
    if table:
        d = str(delivery or DEFAULT_DELIVERY.get(genre, "streaming"))
        if d in table:
            return float(table[d]), f"genre:{genre}", d
    return float(T["lufs"]), "default", (delivery or "streaming")


def parse_root(root):
    """A pitch class 0..11 from a note name ("F", "Db", "C#", "Eb minor"), a
    MIDI number, or a pitch class; None when it is none of those."""
    if root is None or root == "":
        return None
    if isinstance(root, bool):
        return None
    if isinstance(root, (int, float)) and math.isfinite(root):
        return int(round(root)) % 12
    s = str(root).strip()
    if not s:
        return None
    letter = s[0].upper()
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}.get(letter)
    if base is None:
        return None
    acc = s[1:2]
    if acc == "#":
        base += 1
    elif acc in ("b", "♭"):
        base -= 1
    return base % 12


def infer_root_pc(notes, bass_track_ids=()):
    """The song's root, inferred: the pitch class that carries the most
    DURATION on the bass-role tracks (a big-room sub plays the chord roots,
    and progressions here lean on the tonic), else on the lowest-register
    pitched track. None when there are no pitched notes to read. The caller
    marks anything built on this as INFERRED (confidence 0.5) — it is a
    guess with evidence, not a fact the human told us."""
    notes = [n for n in (notes or []) if n.get("midi") is not None]
    if not notes:
        return None
    ids = {str(t) for t in (bass_track_ids or ())}
    pool = [n for n in notes if str(n.get("track_id") or "") in ids] if ids else []
    if not pool:
        # the lowest-register track: median midi per track, lowest wins,
        # kits excluded (a 909's key map is not pitch)
        by_track = {}
        for n in notes:
            if n.get("inst") in ("tr808", "tr909", "drums"):
                continue
            by_track.setdefault(str(n.get("track_id") or ""), []).append(int(n["midi"]))
        if not by_track:
            return None
        low = min(by_track, key=lambda t: float(np.median(by_track[t])))
        pool = [n for n in notes if str(n.get("track_id") or "") == low]
    hist = np.zeros(12)
    for n in pool:
        hist[int(n["midi"]) % 12] += max(1, int(n.get("dur_samples") or 1))
    if hist.sum() <= 0:
        return None
    # Two cues, because a progression defeats either alone: by DURATION a
    # i-VI-III-VII loop gives every chord root a quarter of the bar count
    # and the tonic no majority; by REGISTER a sub line sits on the tonic
    # at its floor and climbs to the other roots from there. So: the pitch
    # class of the LOWEST note wins when it carries real weight (>= 15 % of
    # the duration), else the heaviest class. Never more than a guess —
    # every finding built on it says "inferred" and rides at 0.5.
    low_pc = min(int(n["midi"]) for n in pool) % 12
    if hist[low_pc] >= 0.15 * hist.sum():
        return low_pc
    return int(np.argmax(hist))


def kick_f0(dry, sr, onsets, settle_s=0.060, tail_s=0.260, lo_hz=25.0, hi_hz=160.0):
    """The kick's fundamental in Hz from its DRY bus: for every onset, the
    slice from `settle_s` after the hit (past the pitch snap — hybrid_kick's
    sweep time constant is 6-46 ms) to `tail_s` or the next hit, Hann-
    windowed and zero-padded to 2^18 (0.18 Hz bins at 48 k), peak in
    [lo, hi] with parabolic interpolation, MEDIAN over hits. On the shipped
    big-room render this reads 48.039 Hz with a spread of 0.000 across 32
    hits. Returns (f0 or None, hits used)."""
    x = np.asarray(dry, dtype=np.float64)
    if x.ndim > 1:
        x = x.mean(axis=0)
    onsets = sorted(int(o) for o in (onsets or []) if 0 <= int(o) < len(x))
    N = 1 << 18
    freqs = np.fft.rfftfreq(N, 1.0 / sr)
    band = (freqs >= lo_hz) & (freqs <= hi_hz)
    est = []
    for k, s0 in enumerate(onsets):
        nxt = onsets[k + 1] if k + 1 < len(onsets) else len(x)
        a = s0 + int(settle_s * sr)
        b = min(s0 + int(tail_s * sr), nxt - int(0.010 * sr), len(x))
        if b - a < int(0.080 * sr):
            continue
        seg = x[a:b]
        if float(np.max(np.abs(seg))) < 1e-6:
            continue
        seg = (seg - seg.mean()) * np.hanning(len(seg))
        S = np.abs(np.fft.rfft(seg, N))
        i = int(np.argmax(np.where(band, S, 0.0)))
        if i <= 0 or i + 1 >= len(S) or S[i] <= 0:
            continue
        pa, pb, pc = S[i - 1], S[i], S[i + 1]
        den = pa - 2.0 * pb + pc
        p = 0.5 * (pa - pc) / den if den != 0 else 0.0
        est.append((i + p) * sr / N)
    if not est:
        return None, 0
    return float(np.median(est)), len(est)


def kick_tuning(f0_hz, root_pc):
    """Cents from the kick's fundamental to the song root, on the nearest
    octave of that root, folded into (-600, 600]; plus the two frequencies
    and the beat they make against a sub on the root. root_pc None -> only
    the f0 is reported."""
    if f0_hz is None or not math.isfinite(f0_hz) or f0_hz <= 0:
        return None
    out = {"f0_hz": round(float(f0_hz), 3)}
    if root_pc is None:
        return out
    root_pc = int(root_pc) % 12
    # nearest MIDI note with that pitch class, in log distance
    m = 69.0 + 12.0 * math.log2(f0_hz / 440.0)
    cands = [k for k in range(0, 128) if k % 12 == root_pc]
    midi = min(cands, key=lambda k: abs(k - m))
    root_hz = 440.0 * 2.0 ** ((midi - 69) / 12.0)
    cents = 1200.0 * math.log2(f0_hz / root_hz)
    out.update({
        "root_pc": root_pc, "root": NOTE_NAMES[root_pc], "root_midi": midi,
        "root_hz": round(root_hz, 3),
        "cents": round(cents, 1),
        "beat_hz": round(abs(f0_hz - root_hz), 2),
    })
    return out


# ─────────────────────────────────────────────────────────── the findings


def _sev(excess, thr):
    """How far past the threshold, in threshold-widths."""
    r = abs(excess) / max(abs(thr), 1e-9)
    return "high" if r >= 2.0 else "medium" if r >= 1.0 else "low"


def _f(metric, what, where, how_much, severity, **kw):
    row = {"metric": metric, "what": what, "where": where,
           "how_much": how_much, "severity": severity, "confidence": 1.0}
    row.update(kw)
    return row


def build_findings(measure, opts):
    """Every measurement that is off target, as an actionable finding.

    Confidence is 1.0 for anything derived purely from the samples, and drops
    only where a HUMAN-SUPPLIED fact was inferred instead (a track's role)."""
    T = dict(DEFAULT_TARGETS)
    T.update(opts.get("targets") or {})
    out = []
    mst = measure["master"]

    # ── loudness ────────────────────────────────────────────────────────
    # ONE number, ONE finding. When the project or the genre names a target
    # the finding is `loudness_target` (it quotes where the number came from
    # and the shortfall, and its routes lead to the master stage); otherwise
    # it is the plain `lufs` note against the streaming default, unchanged.
    tgt, tgt_source, delivery = resolve_loudness_target(opts, T)
    if mst["lufs"] is not None:
        d = mst["lufs"] - tgt
        if abs(d) > T["lufs_tolerance"]:
            if tgt_source == "default":
                out.append(_f(
                    "lufs",
                    f"the master is {abs(d):.1f} dB {'over' if d > 0 else 'under'} the "
                    f"{tgt:.0f} LUFS streaming target",
                    "master, whole range",
                    f"{mst['lufs']:.1f} LUFS vs {tgt:.0f} LUFS",
                    _sev(abs(d) - T["lufs_tolerance"], T["lufs_tolerance"]),
                    target="master", observed=mst["lufs"], target_value=tgt,
                    delta_db=round(-d, 2)))
            else:
                label = ("the project's own" if tgt_source == "project"
                         else f"{opts.get('genre')} {delivery}")
                out.append(_f(
                    "loudness_target",
                    f"the master is {abs(d):.1f} dB {'over' if d > 0 else 'under'} the "
                    f"{tgt:.0f} LUFS {label} target — integrated {mst['lufs']:.1f} LUFS, "
                    f"true peak {mst['true_peak_db']:.1f} dBTP, crest {mst['crest_db']:.1f} dB",
                    "master, whole range",
                    f"{mst['lufs']:.1f} LUFS vs {tgt:.0f} LUFS ({tgt_source}): "
                    f"{-d:+.1f} dB",
                    _sev(abs(d) - T["lufs_tolerance"], T["lufs_tolerance"]),
                    target="master", observed=mst["lufs"], target_value=tgt,
                    delta_db=round(-d, 2), shortfall_db=round(-d, 2),
                    source=tgt_source, delivery=delivery,
                    true_peak_db=mst["true_peak_db"], crest_db=mst["crest_db"],
                    headroom_db=round(T["true_peak_db"] - mst["true_peak_db"], 2)))

    if mst["true_peak_db"] > T["true_peak_db"]:
        d = mst["true_peak_db"] - T["true_peak_db"]
        out.append(_f(
            "true_peak",
            f"true peak is {d:.1f} dB over the {T['true_peak_db']:.0f} dBTP ceiling — "
            "lossy encoders will clip this",
            "master, whole range",
            f"{mst['true_peak_db']:.1f} dBTP vs {T['true_peak_db']:.0f} dBTP",
            _sev(d, 1.0),
            target="master", observed=mst["true_peak_db"],
            target_value=T["true_peak_db"], delta_db=round(-d, 2)))

    clip = measure["clipping"]
    if clip["clipped_samples"] > 0 and clip["longest_run"] >= 3:
        out.append(_f(
            "clipping",
            f"{clip['clipped_samples']} samples are pinned at full scale "
            f"(longest flat top {clip['longest_run']} samples)",
            f"master, first at {clip['first_clip_sec']:.2f}s",
            f"{clip['clipped_samples']} clipped samples",
            "high",
            target="master", observed=clip["clipped_samples"], target_value=0))

    for row in measure["dc"]["dc"]:
        if row["offset_db"] > T["dc_db"]:
            out.append(_f(
                "dc",
                f"channel {row['channel']} carries a DC offset of {row['offset_db']:.0f} dB — "
                "it steals headroom and thumps on edits",
                f"master, channel {row['channel']}",
                f"{row['offset_db']:.0f} dB vs {T['dc_db']:.0f} dB",
                _sev(row["offset_db"] - T["dc_db"], 10.0),
                target="master", observed=row["offset_db"], target_value=T["dc_db"]))

    # ── dynamics ────────────────────────────────────────────────────────
    crest = mst["crest_db"]
    if crest < T["crest_low_db"]:
        out.append(_f(
            "dynamics",
            f"crest factor is {crest:.1f} dB — the master is squashed flat",
            "master, whole range",
            f"{crest:.1f} dB vs >= {T['crest_low_db']:.0f} dB",
            _sev(T["crest_low_db"] - crest, 2.0),
            target="master", observed=crest, target_value=T["crest_low_db"],
            direction="too_compressed"))
    elif crest > T["crest_high_db"]:
        out.append(_f(
            "dynamics",
            f"crest factor is {crest:.1f} dB — peaks tower over the body of the mix",
            "master, whole range",
            f"{crest:.1f} dB vs <= {T['crest_high_db']:.0f} dB",
            _sev(crest - T["crest_high_db"], 4.0),
            target="master", observed=crest, target_value=T["crest_high_db"],
            direction="too_peaky"))

    # ── stereo ──────────────────────────────────────────────────────────
    # DUAL MONO first. A master whose L/R correlation sits at/over the
    # threshold is two copies of one signal. Whether that is the RACK (the
    # chain stage folded every voice to (L+R)/2 — every stem reads 1.000 too,
    # and the job said the stereo switch was off) or the ARRANGEMENT (the
    # switch is on, the parts are simply mono/centre) decides the route, so
    # the cause is measured here and named on the finding. This is the
    # finding the first 4:00 bounce needed and did not get: the old
    # `too_narrow` note fired, but its routes (widen / chorus / pan) all
    # assumed the sources were stereo and something downstream was narrow.
    dual_thr = T["dual_mono_correlation"]
    mstereo = measure["stereo"]
    dual_mono = (mstereo.get("correlation") is not None
                 and mstereo["correlation"] >= dual_thr)
    if dual_mono:
        stem_corr = [(tid, measure["tracks"][tid]["stereo"].get("correlation"))
                     for tid in sorted(measure["tracks"])]
        live = [(tid, c) for tid, c in stem_corr if c is not None]
        folded = [tid for tid, c in live if c >= dual_thr]
        switch = opts.get("rack_stereo")            # True/False from the job; None for a file
        if switch is False:
            cause = "rack_fold"
        elif switch is True:
            cause = "arrangement"
        else:
            cause = "rack_fold" if (live and len(folded) == len(live)) else "unknown"
        c = mstereo["correlation"]
        out.append(_f(
            "width",
            f"the master is dual mono — L/R correlation {c:.3f}"
            + (f", and all {len(live)} stems read the same"
               if live and len(folded) == len(live) else
               (f", {len(folded)} of {len(live)} stems too" if live else ""))
            + (": the rack folded every voice to (L+R)/2 before the first insert "
               "(the stereo switch is off)" if cause == "rack_fold" else
               ": the switch is on, so the parts themselves are mono or centred"
               if cause == "arrangement" else
               " — check the rack's stereo switch first"),
            "master, whole range",
            f"correlation {c:.3f} vs < {dual_thr:.2f}",
            "high" if c >= 0.999 else "medium",
            target="master", observed=c, target_value=dual_thr,
            direction="dual_mono", cause=cause,
            stems_dual_mono=folded, stems_measured=len(live),
            width=mstereo.get("width"),
            switch="master.stereo"))
    for scope, st in [("master", measure["stereo"])] + [
            (tid, measure["tracks"][tid]["stereo"]) for tid in sorted(measure["tracks"])]:
        if st.get("correlation") is None:
            continue
        name = (opts.get("tracks") or {}).get(scope, {}).get("name", scope)
        if st["correlation"] < T["correlation_low"]:
            out.append(_f(
                "width",
                f"{name} is out of phase (correlation {st['correlation']:.2f}) — "
                "it will hollow out or vanish in mono",
                f"{name}, whole range",
                f"correlation {st['correlation']:.2f} vs > {T['correlation_low']:.1f}",
                "high", target=scope, observed=st["correlation"],
                target_value=T["correlation_low"], direction="out_of_phase"))
        elif (st.get("width") is not None and st["width"] < T["narrow_width"]
                and scope == "master" and not dual_mono):
            out.append(_f(
                "width",
                f"the master is effectively mono (side/mid {st['width']:.3f})",
                "master, whole range",
                f"width {st['width']:.3f} vs > {T['narrow_width']:.2f}",
                "medium", target=scope, observed=st["width"],
                target_value=T["narrow_width"], direction="too_narrow"))

    # ── spectral balance ────────────────────────────────────────────────
    over_rows = [r for r in measure["spectral"]["bands"]
                 if r["deviation_db"] > 0 and not r.get("absent")]
    most_over = max(over_rows, key=lambda r: r["deviation_db"], default=None)
    for row in measure["spectral"]["bands"]:
        d = row["deviation_db"]
        if row["level_db"] <= -70.0:
            continue
        if row.get("absent"):
            # Reported, because it IS true and a human may want to know the
            # arrangement has nothing down there — but as a low-severity
            # ARRANGEMENT observation with no EQ target, never as a curve error.
            if d < -T["band_tolerance"]:
                out.append(_f(
                    "balance",
                    f"there is essentially nothing in the {row['name']} "
                    f"({row['band']}) — the band is {abs(d):.0f} dB under the "
                    "reference because no part is playing there, not because "
                    "it is mixed quietly",
                    f"master, {row['band']}, whole range",
                    f"{row['level_db']:.0f} dB, "
                    f"{abs(row['level_db'] - measure['spectral']['loudest_band_db']):.0f} dB "
                    "under the loudest band",
                    "low", target="master", band=row["band"],
                    band_index=row["band_index"], direction="absent",
                    observed=d, target_value=0.0, delta_db=round(-d, 2),
                    boostable=False))
            continue
        if abs(d) > T["band_tolerance"]:
            # THE SPREAD IS SAID OUT LOUD when the two channels disagree by
            # more than the tolerance itself. `deviation_db` is the fold, and
            # a fold that reads +4 dB can be +7 on one side and +1 on the
            # other — which is a pan or a widener, not an EQ move.
            lop = ""
            if abs(row["channel_spread_db"]) > T["band_tolerance"]:
                lop = (f" (L {row['deviation_left_db']:+.1f}, R "
                       f"{row['deviation_right_db']:+.1f} — the two sides are "
                       f"{abs(row['channel_spread_db']):.1f} dB apart here)")
            out.append(_f(
                "balance",
                f"{row['name']} ({row['band']}) is {abs(d):.1f} dB "
                f"{'over' if d > 0 else 'under'} the reference curve",
                f"master, {row['band']}, whole range",
                f"{d:+.1f} dB vs +-{T['band_tolerance']:.0f} dB{lop}",
                _sev(abs(d) - T["band_tolerance"], T["band_tolerance"]),
                target="master", band=row["band"], band_index=row["band_index"],
                observed=d, target_value=0.0, delta_db=round(-d, 2),
                direction="over" if d > 0 else "under", boostable=True,
                # The same band read on each channel, so an EQ move made from
                # this finding is made knowing whether the two sides agree.
                # `deviation_db` above is the FOLD, which is what the
                # threshold and the penalty have always been written against.
                deviation_left_db=row["deviation_left_db"],
                deviation_right_db=row["deviation_right_db"],
                channel_spread_db=row["channel_spread_db"],
                fold_cost_db=row["fold_cost_db"],
                # The headroom-free way to the same balance: cut whatever is
                # most over instead of lifting what is under.
                most_over_band=(most_over["band_index"]
                                if (d < 0 and most_over
                                    and most_over["band_index"] != row["band_index"])
                                else None)))

    # ── per-track level against its ROLE target (only when a role is known) ─
    tcfg = opts.get("tracks") or {}
    mix_lufs = mst["lufs"]
    for tid in sorted(measure["tracks"]):
        row = measure["tracks"][tid]
        cfg = tcfg.get(tid) or {}
        name = cfg.get("name", tid)
        if row["lufs"] is None or mix_lufs is None:
            continue
        target = cfg.get("target_lufs")
        conf = 1.0
        if target is None:
            role = cfg.get("role")
            if role in ROLE_OFFSET_DB:
                target = mix_lufs + ROLE_OFFSET_DB[role]
                conf = 0.5 if cfg.get("role_inferred") else 0.8
        if target is None:
            continue                                # no invented targets
        d = row["lufs"] - target
        if abs(d) > T["balance_tolerance"]:
            out.append(_f(
                "level",
                f"{name} sits {abs(d):.1f} dB {'above' if d > 0 else 'below'} where a "
                f"{cfg.get('role', 'part')} usually sits in this mix",
                f"{name}, whole range",
                f"{row['lufs']:.1f} LUFS vs {target:.1f} LUFS",
                _sev(abs(d) - T["balance_tolerance"], T["balance_tolerance"]),
                target=tid, track_name=name, observed=row["lufs"],
                target_value=round(target, 2), delta_db=round(-d, 2),
                confidence=conf, role=cfg.get("role"),
                role_inferred=bool(cfg.get("role_inferred"))))

    # ── masking ─────────────────────────────────────────────────────────
    for ev in measure.get("masking", [])[: int(opts.get("max_masking") or 8)]:
        mname = tcfg.get(ev["masker"], {}).get("name", ev["masker"])
        vname = tcfg.get(ev["maskee"], {}).get("name", ev["maskee"])
        excess = ev["margin_db"] - T["masking_margin_db"]
        out.append(_f(
            "masking",
            f"{mname} masks {vname} in the {ev['band_name']} ({ev['band']})",
            f"{mname} over {vname}, {ev['band']}, bars {ev['from_bar']}-{ev['to_bar']}",
            f"{ev['margin_db']:+.1f} dB over {vname} there "
            f"(target <= {T['masking_margin_db']:.0f} dB)",
            _sev(excess, T["masking_margin_db"]),
            target=ev["masker"], against=ev["maskee"],
            track_name=mname, against_name=vname,
            band=ev["band"], band_index=ev["band_index"],
            from_bar=ev["from_bar"], to_bar=ev["to_bar"],
            observed=ev["margin_db"], target_value=T["masking_margin_db"],
            delta_db=round(-(ev["margin_db"] - T["masking_margin_db"]), 2)))

    # ── tuning: the kick's fundamental against the song's root ──────────
    tune = measure.get("tuning")
    if tune and tune.get("cents") is not None:
        cents = float(tune["cents"])
        if abs(cents) > T["tuning_cents"]:
            name = tcfg.get(tune.get("track_id"), {}).get("name", tune.get("track_id"))
            conf = 0.5 if tune.get("root_inferred") else 1.0
            out.append(_f(
                "tuning",
                f"{name}'s fundamental is {tune['f0_hz']:.1f} Hz, {abs(cents):.0f} cents "
                f"{'above' if cents > 0 else 'below'} {tune['root']} "
                f"({tune['root_hz']:.1f} Hz) — it beats against a sub on the root at "
                f"{tune['beat_hz']:.1f} Hz"
                + (" (root inferred from the bass part)" if tune.get("root_inferred") else ""),
                f"{name}, dry bus, {tune.get('hits', 0)} hits",
                f"{cents:+.0f} c vs +-{T['tuning_cents']:.0f} c",
                _sev(abs(cents) - T["tuning_cents"], 50.0),
                target=tune.get("track_id"), track_name=name,
                observed=cents, target_value=0.0,
                f0_hz=tune["f0_hz"], root=tune["root"], root_hz=tune["root_hz"],
                root_pc=tune["root_pc"], root_inferred=bool(tune.get("root_inferred")),
                beat_hz=tune["beat_hz"], patch=tune.get("patch"), knob=tune.get("knob"),
                current_knob=tune.get("current_knob", 0.0),
                semitones=round(-cents / 100.0, 2),
                confidence=conf))

    # A stable, content-derived id, so the same finding across two iterations
    # is recognisably the same finding (the A/B guard and the taste profile
    # both need that identity).
    for f in out:
        f["id"] = ":".join(str(v) for v in [
            f["metric"], f.get("target", "-"), f.get("against", "-"),
            f.get("band", "-"), f.get("from_bar", "-"), f.get("to_bar", "-")])
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda f: (order[f["severity"]], -f["confidence"]))
    return out


def objective_score(measure, opts):
    """One scalar the A/B guard can compare: total weighted distance from
    target, in dB. LOWER IS BETTER, 0 is on target everywhere. It is a
    penalty sum, not a quality score — it never claims the mix is 'good'."""
    T = dict(DEFAULT_TARGETS)
    T.update(opts.get("targets") or {})
    mst = measure["master"]
    pen = 0.0
    parts = {}
    # The same resolved target the finding quotes, so the A/B guard pulls
    # toward the number on the card rather than toward the streaming default.
    tgt, _, _ = resolve_loudness_target(opts, T)
    if mst["lufs"] is not None:
        parts["lufs"] = max(0.0, abs(mst["lufs"] - tgt) - T["lufs_tolerance"])
    parts["true_peak"] = max(0.0, mst["true_peak_db"] - T["true_peak_db"]) * 2.0
    parts["clipping"] = 4.0 * min(measure["clipping"]["clipped_samples"], 100) / 10.0
    parts["crest"] = max(0.0, T["crest_low_db"] - mst["crest_db"])
    # Absent bands are excluded: a mix with no sub part is not 23 dB of mix
    # error, and letting it read that way made the penalty unusable as an A/B
    # yardstick — every edit looked like noise against it.
    parts["balance"] = sum(max(0.0, abs(r["deviation_db"]) - T["band_tolerance"])
                           for r in measure["spectral"]["bands"]
                           if r["level_db"] > -70.0 and not r.get("absent"))
    parts["masking"] = sum(max(0.0, e["margin_db"] - T["masking_margin_db"])
                           for e in measure.get("masking", [])[:8])
    for v in parts.values():
        pen += v
    return {"penalty_db": round(pen, 3),
            "parts": {k: round(v, 3) for k, v in parts.items()},
            "lower_is_better": True}


# ─────────────────────────────────────────────────────── the analysis entry


def analyse_buses(master, tracks, sr, opts, tuning=None, shape=None):
    """The seam the tests hit: (2,N) master + {tid: (2,N)} stems + the bar map
    in, measurement + findings out. No files, no engine, no job. `tuning` is
    the kick's dry-bus measurement (kick_tuning + track/knob), when the
    caller could make one — analyse() does, a file cannot. `shape` is §7's
    reference-match measurement (shape_measure), likewise: it needs the job's
    note positions, so only analyse() can build one and it is simply carried
    through here."""
    bars = opts.get("bars") or []
    genre = opts.get("genre") or "neutral"
    T = dict(DEFAULT_TARGETS)
    T.update(opts.get("targets") or {})
    measure = {
        "master": loudness(master, sr),
        "stereo": stereo_stats(master),
        "clipping": dc_and_clipping(master, sr),
        "spectral": spectral_balance(master, sr, genre),
        "tracks": {},
        "bands": BAND_LABELS,
        "bars": len(bars),
    }
    measure["dc"] = measure["clipping"]
    levels = {}
    for tid, buf in tracks.items():
        buf = np.asarray(buf, dtype=np.float64)
        if buf.ndim == 1:
            buf = np.vstack([buf, buf])
        # The long-term band levels ride along: the mapping layer needs to name
        # WHICH track owns a band the master is over on, and guessing from the
        # instrument name would be exactly the invention this file refuses.
        _, Eb = band_spectrogram(buf.mean(axis=0), sr)
        measure["tracks"][tid] = {
            **loudness(buf, sr, short=False),
            "stereo": stereo_stats(buf),
            "band_levels_db": [round(float(v), 2) for v in _db(Eb.mean(axis=1))],
        }
        if bars:
            levels[tid] = bar_band_levels(buf, sr, bars)
    if len(levels) >= 2:
        measure["masking"] = masking_events(
            levels, bars, margin_db=T["masking_margin_db"],
            presence_db=float(opts.get("presence_db", -60.0)),
            salience=float(opts.get("salience", 0.08)),
            activity_db=float(opts.get("activity_db", 12.0)))
    else:
        measure["masking"] = []
    if tuning:
        measure["tuning"] = dict(tuning)
    if shape:
        measure["shape"] = shape
    tgt, src, delivery = resolve_loudness_target(opts, T)
    measure["loudness_target"] = {"lufs": tgt, "source": src, "delivery": delivery}
    findings = build_findings(measure, opts)
    return measure, findings


def kick_tuning_from_job(job, synths, sr, w0, n, opts):
    """The kick's DRY bus for the window — its notes alone through the same
    _synth_notes the chain stage uses, mono, no inserts, no fader — and the
    f0 → cents measurement against the song's root. Picks the kick track
    with the most hits in the window among the patches KICK_TUNE_KNOBS can
    name a knob for; None when there is none. The root is `ear.root` when
    the caller knows it, else inferred from the bass-role tracks' notes and
    marked so."""
    notes = job.get("notes") or []
    by_track = {}
    for x in notes:
        knob = KICK_TUNE_KNOBS.get(x.get("inst"))
        if not knob:
            continue
        keys = knob[1]
        if keys is not None and int(x.get("midi", -1)) not in keys:
            continue
        s0 = int(x.get("start_sample", 0))
        if not (w0 <= s0 < w0 + n):
            continue
        by_track.setdefault(str(x.get("track_id") or ""), []).append(x)
    if not by_track:
        return None
    tid = max(by_track, key=lambda t: len(by_track[t]))
    hits = by_track[tid]
    patch = hits[0].get("inst")
    knob = KICK_TUNE_KNOBS[patch][0]
    current = float((hits[0].get("params") or {}).get(knob, 0.0) or 0.0)
    dry = rack._synth_notes({**job, "notes": hits}, synths, sr, w0 + n)
    buf = dry.get(tid)
    if buf is None:
        return None
    f0, used = kick_f0(buf, sr, [int(x["start_sample"]) for x in hits])
    if f0 is None:
        return None
    root_pc = parse_root(opts.get("root"))
    # ear.js may hand over a root it INFERRED from the whole document's bass
    # line (better evidence than this window alone); it says so, and so do we.
    inferred = bool(opts.get("root_inferred")) if root_pc is not None else False
    if root_pc is None:
        tcfg = opts.get("tracks") or {}
        bass = [t for t, c in tcfg.items() if (c or {}).get("role") == "bass"]
        root_pc = infer_root_pc(notes, bass)
        inferred = root_pc is not None
    out = kick_tuning(f0, root_pc) or {}
    out.update({"track_id": tid, "patch": patch, "knob": knob, "current_knob": current,
                "hits": used, "root_inferred": inferred, "source": "dry bus"})
    return out


# ─────────────────────────────────────── §7 THE SHAPE, FOR A REFERENCE MATCH

def shape_measure(master, tracks, sr, job, opts, tuning=None):
    """OUR mix's shape, measured by THE PROFILER'S OWN FUNCTIONS.

    A reference profile carries a third-octave curve, a per-band width, a kick
    envelope with t10/t30/t60 and a sidechain pump. Comparing a project to one
    means measuring the same four things HERE — and measuring them with the
    same code, not with a second implementation that agrees until it does not.
    So this imports server/daw/refprofile.py and calls it.

    The import is LAZY and one-way: refprofile.py imports ear.py at module
    level (it wants BANDS, band_spectrogram, spectral_balance, stereo_stats,
    loudness and kick_f0), so importing it back at the top of this file would
    be a cycle. It is also OPTIONAL: a tree without the profiler answers
    `available: false` with the reason rather than failing a critique that had
    nothing to do with references.

    ONE DIFFERENCE FROM THE REFERENCE SIDE, AND IT IS THE GOOD KIND: we do not
    have to DETECT the kick's onsets. The job carries the notes, so the hits
    are known exactly and the grid gate — which exists because a detector
    pointed at a finished master cannot tell a kick from a tom — is neither
    needed nor run. That is said in the reply as `onsets_source`, because
    "read off the score" and "guessed from the audio" are not the same
    evidence and the cards built from them should not pretend they are.

    Only ever called when a caller asks for it (`ear.shape`), because it costs
    real time and a critique that is not matching a reference should not pay
    for it. MEASURED, on bars 1-8 of a chained 128-bar project, three runs
    each: 2 662 ms of analysis without it and 2 969 ms with, so the block is
    307 ms. And it changes nothing else: the same critique with and without a
    profile produced byte-identical `measure` objects apart from this key, an
    identical objective score (6.47) and an identical list of objective
    findings.
    """
    try:
        import refprofile                                # noqa: PLC0415 -- lazy, one-way
    except Exception as exc:                             # noqa: BLE001
        return {"available": False,
                "why": f"server/daw/refprofile.py could not be imported "
                       f"({type(exc).__name__}: {exc}) — the reference profiler is what "
                       "owns the third-octave, width-per-band, kick-decay and pump maths, "
                       "and this file will not keep a second copy of it"}
    out = {
        "available": True,
        "source": "server/daw/refprofile.py, the same functions a reference profile "
                  "is built from",
        "third_octave": refprofile.third_octave_db(master, sr),
        "width_per_band": refprofile.width_per_band(master, sr),
        "kick": None, "pump": None, "onsets_source": None,
    }
    w0 = int(job.get("start_sample") or 0)
    n = int(job.get("n_samples") or 0)
    notes = job.get("notes") or []
    kick_tid = (tuning or {}).get("track_id")
    ons = []
    if kick_tid:
        for x in notes:
            if str(x.get("track_id") or "") != str(kick_tid):
                continue
            s0 = int(x.get("start_sample", 0))
            if w0 <= s0 < w0 + n:
                ons.append(s0 - w0)
        ons.sort()
    if kick_tid and len(ons) >= 3 and kick_tid in tracks:
        out["onsets_source"] = (f"the job's own notes on track {kick_tid} — {len(ons)} hits, "
                                "exact, so no onset detector and no beat-grid gate is "
                                "involved on this side")
        out["kick"] = refprofile.kick_shape(tracks[kick_tid], sr, ons)
        out["kick_track"] = str(kick_tid)
        # The pump is read off the BASS role's bus, the same place a profile
        # reads it — the ducking is a property of what gets ducked.
        tcfg = opts.get("tracks") or {}
        bass = [t for t, c in tcfg.items()
                if (c or {}).get("role") == "bass" and t in tracks]
        if bass:
            loud = max(bass, key=lambda t: float(np.sqrt(np.mean(
                np.asarray(tracks[t], dtype=np.float64) ** 2))))
            out["pump"] = refprofile.pump(tracks[loud], sr, ons)
            out["pump_track"] = str(loud)
        else:
            out["pump_absent_because"] = (
                "no track in this window is playing the bass role, and a sidechain "
                "depth measured on something else is a measurement of something else")
    else:
        out["onsets_source"] = (
            "no kick could be named in this window (the tuning critic finds the kick "
            "track, and it needs at least three hits of a patch whose tune knob it "
            "knows), so the decay and the pump are not measured rather than measured "
            "wrong")
    return out


def analyse(job):
    """Render one absolute window through the SAME graph the bounce uses and
    critique it. job is the `meters` job plus an `ear` block."""
    t0 = time.perf_counter()
    import engine                                    # SYNTHS, for the dry stage
    sr = int(job.get("sr") or DEFAULT_SR)
    w0 = int(job["start_sample"])
    n = int(job["n_samples"])
    opts = dict(job.get("ear") or {})
    mastered, buses = rack.chain_graph(job, engine.SYNTHS, capture=True)
    sl = slice(w0, w0 + n)
    master = mastered[:, sl]
    master_source = "graph"
    if job.get("master_wav"):
        y, _ = read_audio_stereo(job["master_wav"], sr)
        master = y
        master_source = "file"
    stems = {tid: b[:, sl] for tid, b in (buses["tracks"] or {}).items()}
    # The rack's stereo switch, as the JOB carried it (mixer.stereo): the
    # dual-mono finding names the fold as the cause when it is off. Read
    # through rack.stereo_on when that rack has one, else by the same rule.
    stereo_on = getattr(rack, "stereo_on", None)
    mixer = job.get("mixer") or {}
    opts["rack_stereo"] = bool(stereo_on(mixer)) if stereo_on else (mixer.get("stereo") is True)
    tuning = None
    try:
        tuning = kick_tuning_from_job(job, engine.SYNTHS, sr, w0, n, opts)
    except Exception as exc:                          # noqa: BLE001
        # A tuning measurement that fails must not cost the critique; it is
        # reported as absent, with the reason, never as "in tune".
        tuning = {"error": f"{type(exc).__name__}: {exc}"}
    # §7 the reference-match measurement, only when a caller asked for it.
    shape = None
    if opts.get("shape"):
        try:
            shape = shape_measure(master, stems, sr, job, opts, tuning=tuning)
        except Exception as exc:                      # noqa: BLE001
            # A shape measurement that fails must not cost the critique either;
            # the reference cards simply are not built, and the reason travels.
            shape = {"available": False, "why": f"{type(exc).__name__}: {exc}"}
    measure, findings = analyse_buses(master, stems, sr, opts, tuning=tuning, shape=shape)
    # [DAWREC] WHAT WAS IN THE MIX WE JUST MEASURED. chain_graph mixes each
    # clip into its own track's dry buffer (rack._mix_audio), so a job that
    # carried clips put them in the master AND in that track's stem — the
    # coverage of both moves together, and one word says so.
    # This pair replaced "stems_cover": "notes" plus an audio_clips_EXCLUDED
    # count, which was vacuously 0 for as long as the job carried no `audio`
    # at all: the Ear reported nothing excluded about a mix from which every
    # take had been. The count now names what was INCLUDED, which is a number
    # that cannot be right by accident.
    clips = job.get("audio") or []
    return {
        "ok": True, "sr": sr, "start_sample": w0, "n_samples": n,
        "seconds": round(n / sr, 3),
        "master_source": master_source,
        "rack_stereo": opts["rack_stereo"],
        "stems": sorted(stems),
        "stems_cover": "notes+clips" if clips else "notes",
        "audio_clips": len(clips),
        "measure": measure, "findings": findings,
        "score": objective_score(measure, opts),
        "ms": round((time.perf_counter() - t0) * 1000, 1),
    }


def analyse_file(job):
    """Critique an existing file (a bounce). Master-only: no stems exist in a
    mixdown, so masking is not reported rather than guessed."""
    t0 = time.perf_counter()
    path = job["path"]
    opts = dict(job.get("ear") or {})
    y, sr = read_audio_stereo(path, job.get("sr"))
    measure, findings = analyse_buses(y, {}, sr, opts)
    return {
        "ok": True, "path": path, "sr": sr, "n_samples": int(y.shape[1]),
        "seconds": round(y.shape[1] / sr, 3),
        "master_source": "file", "stems": [], "stems_cover": "none",
        "measure": measure, "findings": findings,
        "score": objective_score(measure, opts),
        "ms": round((time.perf_counter() - t0) * 1000, 1),
    }


# ────────────────────────────────────────────────── the subjective stage
#
# §11a's judges. The skeleton is mv/sfxcue.js's, organ for organ: a VRAM
# guard so the judge never evicts a render, one call per subject, a JSON
# verdict, and GRACEFUL ABSENCE — when the judge is not installed the loop
# runs on the objective critic alone and SAYS SO. Nothing here ever invents
# a score: absent is reported as absent.
#
# Licences (verified in the report's §8/§11a, not from a README badge):
#   audiobox-aesthetics  CC-BY-4.0 weights / MIT code  facebookresearch
#   laion-clap           Apache-2.0 checkpoint         laion/larger_clap_music
#   MERT                 CC-BY-NC — REFUSED, never imported
#   essentia             AGPL-3.0  — REFUSED, never linked

JUDGES = {
    "audiobox_aesthetics": {
        "module": "audiobox_aesthetics",
        "role": "aesthetic scorer (Production Quality / Complexity / Content "
                "Enjoyment / Usefulness) — the cheap did-that-edit-help scalar",
        "licence": "CC-BY-4.0 (weights) / MIT (code)",
        "params": "0.1B",
        "install": "pip install audiobox-aesthetics",
        "cpu_ok": True,
        "vram_mb": 1200,
    },
    "laion_clap": {
        "module": "laion_clap",
        "role": "brief similarity — 'does this sound like <the human's brief>?' "
                "and style-drift between iterations",
        "licence": "Apache-2.0 (laion/larger_clap_music)",
        "params": "0.6B",
        "install": "pip install laion-clap",
        "cpu_ok": True,
        "vram_mb": 1600,
    },
}

REFUSED_MODELS = {
    "MERT-v1-330M": "CC-BY-NC-4.0 — non-commercial. Unusable in a product that ships.",
    "essentia": "AGPL-3.0 — linking it would put the whole server under AGPL.",
}


def _module_present(name):
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _free_vram_mb():
    """nvidia-smi's free VRAM, or None when there is no card / no driver. The
    number is an UPPER bound on what is free (gpu.js's warning applies: a
    caching allocator holds blocks it is not using) — which is the safe
    direction for a guard that must never evict a render."""
    import subprocess
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=8)
        if out.returncode != 0:
            return None
        return int(out.stdout.strip().split("\n")[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def judge_status(job=None):
    """What the subjective stage can do HERE, right now. Never optimistic."""
    job = job or {}
    free = _free_vram_mb()
    rows = {}
    for key, spec in JUDGES.items():
        present = _module_present(spec["module"])
        rows[key] = {
            "installed": present,
            "role": spec["role"], "licence": spec["licence"],
            "params": spec["params"],
            "install": spec["install"],
            "device": "cpu" if spec["cpu_ok"] else "cuda",
            "vram_mb_if_gpu": spec["vram_mb"],
            "reason": None if present else
                      f"{spec['module']} is not importable by {sys.executable}",
        }
    any_on = any(r["installed"] for r in rows.values())
    return {
        "ok": True,
        "available": any_on,
        "python": sys.executable,
        "judges": rows,
        "free_vram_mb": free,
        "vram_guard": {
            "policy": "the judge runs on CPU by default and is never allowed to "
                      "evict a render; a GPU run requires the model's VRAM plus "
                      "1 GB of slack free at call time",
            "slack_mb": 1024,
        },
        "refused": REFUSED_MODELS,
        "degrades_to": "the objective critic alone — every card still carries a "
                       "measurement and a concrete edit; only the aesthetic "
                       "opinion is missing, and it is reported missing",
        "installer": {
            "where": "a SEPARATE venv, never the shared ComfyUI venv (installing "
                     "into the render venv is a production side effect this "
                     "module must not have — the same rule that kept pyloudnorm "
                     "out of rack.py)",
            "steps": [
                "python -m venv D:/AI/aiplay-ear-venv",
                "D:/AI/aiplay-ear-venv/Scripts/pip install audiobox-aesthetics laion-clap",
                "set AIPLAY_EAR_PY=D:/AI/aiplay-ear-venv/Scripts/python.exe",
                "restart the Studio; daw_ear_status will show the judges installed",
            ],
            "env": "AIPLAY_EAR_PY",
        },
    }


def judge(job):
    """Score a rendered file with whatever aesthetic judge is installed.

    Absent judge -> {"available": false, ...} and NO scores. That is the whole
    contract: the loop above treats a missing opinion as a missing opinion."""
    st = judge_status(job)
    path = job.get("path")
    want_gpu = bool(job.get("gpu"))
    if not st["available"]:
        return {"ok": True, "available": False, "scores": {}, "status": st,
                "note": "no aesthetic judge is installed in this environment; "
                        "the objective critic carried the run alone"}
    scores, notes, ran = {}, [], []
    free = st["free_vram_mb"]
    for key, spec in JUDGES.items():
        if not st["judges"][key]["installed"]:
            continue
        device = "cpu"
        if want_gpu and spec["cpu_ok"] is not True:
            if free is not None and free >= spec["vram_mb"] + 1024:
                device = "cuda"
            else:
                notes.append(f"{key}: stayed on CPU — the VRAM guard needs "
                             f"{spec['vram_mb'] + 1024} MB free, saw {free}")
        try:
            if key == "audiobox_aesthetics":
                from audiobox_aesthetics.infer import initialize_predictor  # noqa: PLC0415
                pred = initialize_predictor()
                res = pred.forward([{"path": path}])
                scores["audiobox"] = res[0] if isinstance(res, list) else res
                ran.append(key)
            elif key == "laion_clap" and job.get("brief"):
                import laion_clap  # noqa: PLC0415
                model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base")
                model.load_ckpt()
                ae = model.get_audio_embedding_from_filelist([path], use_tensor=False)
                te = model.get_text_embedding([job["brief"], ""], use_tensor=False)
                a = ae[0] / (np.linalg.norm(ae[0]) + 1e-9)
                t = te[0] / (np.linalg.norm(te[0]) + 1e-9)
                scores["brief_similarity"] = round(float(np.dot(a, t)), 4)
                ran.append(key)
        except Exception as exc:                      # noqa: BLE001
            # sfxcue.js's rule: a judge outage degrades the verdict, never the run.
            notes.append(f"{key}: unavailable at call time ({type(exc).__name__}: {exc})")
    return {"ok": True, "available": bool(ran), "ran": ran, "device_policy": "cpu-first",
            "scores": scores, "notes": notes, "status": st}


def probe(job=None):
    return {
        "ok": True, "engine": "ear", "version": 1,
        "bands": BAND_LABELS, "band_names": BAND_NAMES,
        "reference": "pink (equal energy per octave) + genre tilt",
        "genres": sorted(GENRE_TILT),
        "targets": DEFAULT_TARGETS,
        "roles": sorted(ROLE_OFFSET_DB),
        "critics": [
            {"metric": "lufs", "measures": "BS.1770-4 gated integrated loudness of the "
                                           "master and of every track bus (rack.py's maths)"},
            {"metric": "true_peak", "measures": "4x-oversampled true peak dBTP of the master"},
            {"metric": "clipping", "measures": "samples pinned at full scale and the "
                                               "longest flat top"},
            {"metric": "dc", "measures": "per-channel DC offset in dB"},
            {"metric": "balance", "measures": "9-band long-term energy against a pink "
                                              "reference plus a genre tilt, measured on "
                                              "the LEFT channel, the RIGHT channel and "
                                              "the mono fold — the thresholds still read "
                                              "the fold, and the per-channel numbers say "
                                              "what the fold hides (an L/R imbalance) and "
                                              "what it invents (comb loss under a "
                                              "decorrelated channel)"},
            {"metric": "masking", "measures": "per-bar per-band inter-track masking: who "
                                              "masks whom, in which band, in which bars"},
            {"metric": "dynamics", "measures": "crest factor and the short-term LUFS range"},
            {"metric": "width", "measures": "L/R correlation and side/mid width, master "
                                            "and per track; dual mono (correlation >= "
                                            "0.99) names the rack's stereo switch as the "
                                            "cause when the job says it is off"},
            {"metric": "level", "measures": "each track's integrated LUFS against its "
                                            "role target (only when a role is known)"},
            {"metric": "loudness_target", "measures": "integrated LUFS against the "
                                                      "project's target_lufs, else the "
                                                      "genre's (edm: -8 club / -14 "
                                                      "streaming), with the shortfall in dB"},
            {"metric": "tuning", "measures": "the kick's fundamental from its DRY bus "
                                             "(hybrid_kick, tr808, tr909) against the "
                                             "song's root, in cents, with the beat rate "
                                             "against a sub on the root"},
        ],
        "genre_loudness": GENRE_LOUDNESS,
        "kick_patches": sorted(KICK_TUNE_KNOBS),
        "judge": judge_status(job),
        # §7 — the reference match is not a critic of this file's; it is a
        # MEASUREMENT this file can make (shape_measure) and a mapping ear.js
        # makes from it. Reported here so `daw_ear_status` can say whether a
        # profile could be matched on this machine before anyone builds one.
        "shape": shape_probe(),
        "pid": os.getpid(),
    }


def shape_probe():
    """Can this machine measure a project's shape against a profile?"""
    try:
        import refprofile                                # noqa: PLC0415 -- lazy, one-way
    except Exception as exc:                             # noqa: BLE001
        return {"available": False,
                "why": f"server/daw/refprofile.py is not importable here "
                       f"({type(exc).__name__}: {exc})"}
    return {
        "available": True,
        "measures": ["third_octave (29 rate-invariant shares)", "width_per_band (9)",
                     "kick attack/t10/t30/t60 from the kick track's own bus",
                     "pump depth and recovery from the bass role's bus"],
        "asked_for_with": 'ear.shape: true — off by default, because it is a '
                          'measured 307 ms on an eight-bar window, which a critique that '
                          'is not matching a reference should not pay for',
        "onsets": "read off the job's notes, exactly — the beat-grid gate a reference "
                  "profile needs is not run on this side and cannot be",
        "profile_sr": refprofile.PROFILE_SR,
    }


MODES = {
    "analyse": analyse, "file": analyse_file, "judge": judge,
    "judge_status": judge_status, "probe": probe,
}


def serve(stdin=None, stdout=None):
    """engine.py's protocol, to the letter, so the routes' lane code carries
    over unchanged: one JSON request per line, one JSON reply per line."""
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout

    def reply(obj):
        stdout.write(json.dumps(obj) + "\n")
        stdout.flush()

    reply({"ok": True, "ready": True, "pid": os.getpid()})
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = str(req.get("cmd") or "")
            if cmd == "shutdown":
                reply({"id": rid, "ok": True, "bye": True})
                break
            if cmd not in MODES:
                raise ValueError(f"unknown cmd {cmd}")
            result = MODES[cmd](req.get("job") or {})
            reply(dict(result, id=rid) if rid is not None else result)
        except MemoryError:
            reply({"id": rid, "ok": False, "fatal": True, "error": "MemoryError"})
            return 1
        except Exception as exc:                       # noqa: BLE001
            reply({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "serve":
        return serve()
    try:
        if not argv:
            raise ValueError("usage: ear.py <analyse|file|judge|probe> <job.json> "
                             " |  ear.py serve")
        mode = argv[0]
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode}")
        job = {}
        if len(argv) > 1:
            with open(argv[1], encoding="utf-8") as fh:
                job = json.load(fh)
        print(json.dumps(MODES[mode](job)))
        return 0
    except Exception as exc:                           # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
