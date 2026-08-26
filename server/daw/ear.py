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
}

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


def spectral_balance(x, sr, genre="neutral"):
    """Long-term band energies (dB, share of total) against the reference
    curve. Returns per-band observed / reference / deviation."""
    x = np.asarray(x, dtype=np.float64)
    mono = x.mean(axis=0) if x.ndim > 1 else x
    _, E = band_spectrogram(mono, sr)
    band_p = E.mean(axis=1)
    tot = float(band_p.sum())
    obs = _db(band_p / tot) if tot > 0 else np.full(len(BANDS), -120.0)
    ref = pink_reference_db() + np.array(GENRE_TILT.get(genre, GENRE_TILT["neutral"]),
                                         dtype=np.float64)
    ref = ref - 10.0 * np.log10(np.sum(10.0 ** (ref / 10.0)))   # renormalise to a share
    levels = _db(band_p)
    top = float(np.max(levels)) if len(levels) else -120.0
    rows = []
    for b in range(len(BANDS)):
        rows.append({
            "band": BAND_LABELS[b], "band_index": b, "name": BAND_NAMES[b],
            "observed_db": round(float(obs[b]), 2),
            "reference_db": round(float(ref[b]), 2),
            "deviation_db": round(float(obs[b] - ref[b]), 2),
            "level_db": round(float(levels[b]), 2),
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
    return {"genre": genre, "reference": "pink (equal energy per octave) + genre tilt",
            "loudest_band_db": round(top, 2), "bands": rows}


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
    if mst["lufs"] is not None:
        d = mst["lufs"] - T["lufs"]
        if abs(d) > T["lufs_tolerance"]:
            out.append(_f(
                "lufs",
                f"the master is {abs(d):.1f} dB {'over' if d > 0 else 'under'} the "
                f"{T['lufs']:.0f} LUFS streaming target",
                "master, whole range",
                f"{mst['lufs']:.1f} LUFS vs {T['lufs']:.0f} LUFS",
                _sev(abs(d) - T["lufs_tolerance"], T["lufs_tolerance"]),
                target="master", observed=mst["lufs"], target_value=T["lufs"],
                delta_db=round(-d, 2)))

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
                and scope == "master"):
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
            out.append(_f(
                "balance",
                f"{row['name']} ({row['band']}) is {abs(d):.1f} dB "
                f"{'over' if d > 0 else 'under'} the reference curve",
                f"master, {row['band']}, whole range",
                f"{d:+.1f} dB vs +-{T['band_tolerance']:.0f} dB",
                _sev(abs(d) - T["band_tolerance"], T["band_tolerance"]),
                target="master", band=row["band"], band_index=row["band_index"],
                observed=d, target_value=0.0, delta_db=round(-d, 2),
                direction="over" if d > 0 else "under", boostable=True,
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
    if mst["lufs"] is not None:
        parts["lufs"] = max(0.0, abs(mst["lufs"] - T["lufs"]) - T["lufs_tolerance"])
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


def analyse_buses(master, tracks, sr, opts):
    """The seam the tests hit: (2,N) master + {tid: (2,N)} stems + the bar map
    in, measurement + findings out. No files, no engine, no job."""
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
    findings = build_findings(measure, opts)
    return measure, findings


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
    measure, findings = analyse_buses(master, stems, sr, opts)
    return {
        "ok": True, "sr": sr, "start_sample": w0, "n_samples": n,
        "seconds": round(n / sr, 3),
        "master_source": master_source,
        "stems": sorted(stems),
        "stems_cover": "notes",
        "audio_clips_excluded": len(job.get("audio") or []),
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
                                              "reference plus a genre tilt"},
            {"metric": "masking", "measures": "per-bar per-band inter-track masking: who "
                                              "masks whom, in which band, in which bars"},
            {"metric": "dynamics", "measures": "crest factor and the short-term LUFS range"},
            {"metric": "width", "measures": "L/R correlation and side/mid width, master "
                                            "and per track"},
            {"metric": "level", "measures": "each track's integrated LUFS against its "
                                            "role target (only when a role is known)"},
        ],
        "judge": judge_status(job),
        "pid": os.getpid(),
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
