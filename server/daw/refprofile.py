"""THE REFERENCE PROFILE — the SHAPE of a track, and never the track.

  python server/daw/refprofile.py build <job.json>   a profile from a demucs stem folder
  python server/daw/refprofile.py probe              what this profiler can do here
  python server/daw/refprofile.py serve              the same, over stdin (engine.py's protocol)

── WHAT A PROFILE IS ───────────────────────────────────────────────────────
dB numbers, times in milliseconds, and counts. Per stem (drums / bass / other
/ vocals) and for the mix: loudness, level relative to the mix, stereo width
per band, the Ear's nine bands, and 29 third-octave bands expressed as a dB
SHARE of the total — a share, so it says nothing about how loud the reference
was mastered. Plus the kick's fundamental and its decay, and the sidechain
pump's depth and recovery.

── WHAT A PROFILE IS NOT, AND THIS FILE ENFORCES IT ────────────────────────
No audio. No spectrogram frame that could be inverted. No note sequence, no
melody, no lyric, no name of a song's parts beyond a coarse energy label.
`check_shape_only()` walks the emitted object against a DECLARED WHITELIST of
key names and a hard cap on array length, and RAISES rather than emitting
anything it was not told about. That check runs on every build, not only in
the tests, because "a profile is a shape, never a sample" is a promise this
program makes to whoever's track is being matched — and a promise that only
holds when someone remembers to run the test is not one.

── WHAT IS REUSED, NOT REIMPLEMENTED ───────────────────────────────────────
ear.py already owns the nine bands, the band spectrogram, the pink-reference
balance, the stereo statistics, BS.1770 loudness (through rack.py) and the
kick's fundamental. This module imports all of it. What it adds is the maths
ear.py has no reason to have: rate-invariant third-octave shares, an envelope
with decay times, an onset detector with a beat-grid gate, and the pump.

And it adds them ONCE: `server/daw/ear.py` imports THIS module (lazily, to
keep the import one-way) to measure the same shapes on OUR OWN buses, so the
reference and the project are measured by the same code rather than by two
implementations that agree until they do not.

── TWO FINDINGS FROM THE PROTOTYPE THAT ARE BUILT IN HERE ──────────────────
 1. NAIVE ONSET DETECTION READS 442 BPM. The prototype's first pass found 152
    kick onsets in a 30 s clip and a 0.1357 s beat — 442 BPM — because a flux
    peak in a 30-110 Hz band also catches snare bodies, tom hits and 16th-note
    bass movement, and every downstream number (the decay window, the pump's
    beat, the IOI) is then wrong while looking perfectly plausible. THE GRID
    GATE (`beat_grid` below) is the fix, and it is a COMB FIT rather than the
    prototype's autocorrelation, because the autocorrelation was measured to
    have no periodic structure at all on a real track and its argmax was
    therefore the search range's own lower boundary — see `beat_grid`. On a
    synthesised 128 BPM pattern whose raw peaks read 454 BPM, the comb returns
    0.470 s (127.7 BPM) and gates the onsets back to a 0.468 s interval.
    `implied_bpm` is REPORTED, at the grid and again on the kick's shape, so a
    wrong one is visible instead of propagating silently — and when the fit is
    not salient the gate DECLINES, reports no period, and the layer above
    (ear.js's reference_match) refuses to build a kick-decay or a pump card
    from a profile whose grid declined.
 2. LUFS IS UNAVAILABLE AT 44.1 kHz. rack.k_weight is pinned at 48 kHz and
    commercial references are overwhelmingly 44.1. The owner's decision:
    RESAMPLE to 48 kHz inside the profiler and SAY SO. Every profile built
    from a 44.1 kHz source carries `resampled_from: 44100` and a sentence in
    `resample_note`, because resampling changes the numbers slightly and a
    measurement that hides what it did to its input is not a measurement.
    scipy's polyphase resampler at the exact rational 160/147; if scipy is
    absent the audio is left alone and the loudness block reports itself
    absent with the reason, exactly as the prototype did.
"""
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ear  # noqa: E402


PROFILE_SR = 48000          # what rack.k_weight is pinned at, so what we measure at
MAX_ARRAY = 512             # the hard cap on any array in an emitted profile
STEMS = ("drums", "bass", "other", "vocals")


class ShapeLeak(ValueError):
    """Raised when a profile would carry something that is not a shape."""


# ══════════════════════════════════════════════ 1/3 octave, rate-invariant

def third_octave_edges(lo=20.0, hi=20000.0):
    """ISO-ish base-2 third-octave band edges. Centres 1000 * 2**(n/3)."""
    out = []
    n = -17
    while True:
        fc = 1000.0 * 2.0 ** (n / 3.0)
        a, b = fc / 2.0 ** (1.0 / 6.0), fc * 2.0 ** (1.0 / 6.0)
        if b > hi:
            break
        if a >= lo:
            out.append((round(a, 2), round(b, 2), round(fc, 2)))
        n += 1
    return out


def third_octave_db(x, sr, nfft=8192, hop=2048):
    """Mean power per third-octave band, as a dB SHARE of the total.

    SHARE, not absolute level, and that is the whole property the comparison
    rests on: a share is invariant to how loud the reference was mastered, so
    a profile built from a -6 LUFS master and one built from the same music at
    -20 read the same curve. refprofile_test.py pins that against a +-12 dB
    gain on the input.

    IT IS NOT RATE-INVARIANT, and that is why everything is measured at 48 kHz.
    A third-octave band down at 70-88 Hz is three FFT bins wide at 44.1 kHz and
    four at 48, so the same music read at the two rates differs by up to 1.7 dB
    in the low bands — measured, and it does not shrink with a longer signal.
    Since a reference is resampled to 48 kHz before anything is measured and a
    project is 48 kHz natively, both sides of every comparison carry the same
    quantisation and it cancels in the delta.
    """
    x = np.asarray(x, dtype=np.float64)
    mono = x.mean(axis=0) if x.ndim > 1 else x
    if len(mono) < nfft:
        mono = np.pad(mono, (0, nfft - len(mono)))
    w = np.hanning(nfft)
    wsum = float(np.sum(w ** 2))
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    bands = [b for b in third_octave_edges() if b[1] <= sr / 2.0]
    idx = [np.where((freqs >= a) & (freqs < b))[0] for a, b, _ in bands]
    acc = np.zeros(len(bands))
    frames = 0
    for i in range(0, max(1, 1 + (len(mono) - nfft) // hop)):
        seg = mono[i * hop: i * hop + nfft] * w
        P = (np.abs(np.fft.rfft(seg)) ** 2) * (2.0 / (wsum * nfft))
        for b, ii in enumerate(idx):
            acc[b] += float(P[ii].sum()) if len(ii) else 0.0
        frames += 1
    acc /= max(frames, 1)
    tot = float(acc.sum())
    share = ear._db(acc / tot) if tot > 0 else np.full(len(bands), -140.0)
    return [{"lo": a, "hi": b, "centre": c, "share_db": round(float(s), 2)}
            for (a, b, c), s in zip(bands, share)]


# ══════════════════════════════════════════════════ envelopes and the grid

def envelope(x, sr, hop_ms=2.0, win_ms=8.0, lo=None, hi=None):
    """RMS envelope (linear) at hop_ms, optionally band-limited by FFT mask.

    Returns (times, envelope, hop_samples)."""
    x = np.asarray(x, dtype=np.float64)
    mono = x.mean(axis=0) if x.ndim > 1 else x
    n_in = len(mono)
    if lo is not None or hi is not None:
        n = 1 << int(math.ceil(math.log2(max(n_in, 2))))
        S = np.fft.rfft(mono, n)
        f = np.fft.rfftfreq(n, 1.0 / sr)
        m = np.ones_like(f)
        if lo is not None:
            m[f < lo] = 0.0
        if hi is not None:
            m[f > hi] = 0.0
        mono = np.fft.irfft(S * m, n)[:n_in]
    hop = max(1, int(sr * hop_ms / 1000.0))
    win = max(hop, int(sr * win_ms / 1000.0))
    n_fr = 1 + max(0, (len(mono) - win)) // hop
    e = np.empty(n_fr)
    for i in range(n_fr):
        seg = mono[i * hop: i * hop + win]
        e[i] = math.sqrt(float(np.mean(seg * seg))) if seg.size else 0.0
    t = (np.arange(n_fr) * hop + win / 2.0) / sr
    return t, e, hop


def flux(e):
    """Half-wave-rectified difference of an envelope — the onset function."""
    e = np.asarray(e, dtype=np.float64)
    d = np.diff(e, prepend=e[0] if e.size else 0.0)
    d[d < 0] = 0.0
    return d


def flux_peaks(d, dt, pct=92.0, min_gap_s=0.06):
    """Local maxima of the flux over an adaptive threshold, with a floor on
    the gap between them. Frame indices, in time order."""
    d = np.asarray(d, dtype=np.float64)
    if d.size < 8 or float(d.max()) <= 0:
        return []
    thr = float(np.percentile(d, pct))
    gap = max(1, int(min_gap_s / dt))
    peaks = []
    i = 1
    while i < len(d) - 1:
        if d[i] >= thr and d[i] >= d[i - 1] and d[i] >= d[i + 1]:
            peaks.append(i)
            i += gap
        else:
            i += 1
    return peaks


BEAT_LO_S = 0.30            # 200 BPM
BEAT_HI_S = 1.00            # 60 BPM
GRID_TOL = 0.12             # keep a peak within 12 % of a beat of the grid
GRID_MIN_SALIENCE = 1.60    # how far the best comb must stand above the typical one
GRID_PHASE_BINS = 240       # phase resolution of the offset search


def _comb_fit(times, w, period, tol, bins=GRID_PHASE_BINS):
    """Best phase for one candidate period, and what that grid explains.

    Returns (coverage, occupancy, centre_phase, keep_mask, lines).
      coverage   the fraction of PEAK WEIGHT within `tol` of a grid line
      occupancy  the fraction of grid LINES that got a peak
    Both are needed and neither is enough. Coverage alone is maximised by the
    shortest period in the range — every line of P is also a line of P/2, so a
    half-period explains everything a period does and more. Occupancy is what
    refuses that: at P/2, half the lines are empty.
    """
    ph = (times / period) % 1.0
    idx = (ph * bins).astype(int) % bins
    h = np.bincount(idx, weights=w, minlength=bins)
    half = max(1, int(round(tol * bins)))
    width = 2 * half + 1
    hh = np.concatenate([h, h[:width]])
    csum = np.concatenate([[0.0], np.cumsum(hh)])
    win = csum[width:width + bins] - csum[:bins]
    i0 = int(np.argmax(win))
    coverage = float(win[i0])
    centre = (((i0 + half) % bins) + 0.5) / bins
    pos = times / period - centre
    line = np.round(pos).astype(int)
    keep = np.abs(pos - line) < tol
    lines = int(round((times[-1] - times[0]) / period)) + 1
    occ = (len(set(line[keep].tolist())) / lines) if lines > 0 else 0.0
    return coverage, float(occ), centre, keep, lines


def beat_grid(d, dt, peaks, lo_s=BEAT_LO_S, hi_s=BEAT_HI_S, tol=GRID_TOL,
              min_salience=GRID_MIN_SALIENCE):
    """THE GRID GATE — the fix for the 442 BPM reading.

    Raw flux peaks in a 30-110 Hz band still catch snare bodies, tom hits and
    16th-note bass movement. On a real track that reads as a beat of 0.1357 s
    (442 BPM), and every number downstream — the decay window, the pump's
    beat, the inter-onset interval — is then measured against a grid that is
    not the music's. The prototype shipped exactly that reading, and it looked
    entirely plausible on the way out.

    THE FIT, and why it is not the autocorrelation the prototype used. An
    autocorrelation of the flux was measured, on this machine, to have NO
    periodic structure at all in the 0.30-1.00 s range on a real 128 s track
    (unbiased AC: 0.0044 at 0.25 s, falling monotonically to -0.011 by 0.60 s,
    with nothing at the kick's own 0.64 s interval). Its argmax was therefore
    the range's own lower boundary — 0.3093 s at 44.1 kHz and 0.3000 s at 48,
    which is a period picked by the edge of the search rather than by the
    music. The two answers kept different peak sets out of the SAME audio, and
    the 48 kHz one put the average kick's peak 313 ms after the onset.

    So the period is fitted directly against what the gate then does with it: a
    COMB. For each candidate period, the best phase is found by a circular
    sliding window over a weighted phase histogram, and the fit is scored
    coverage x occupancy (see `_comb_fit`).

    AND THE BAR IS RELATIVE, NOT ABSOLUTE. A comb score alone does not
    separate a real beat from noise: measured over the three reference tracks
    on this machine, the best score was 0.326 / 0.329 / 0.331 — three tracks,
    one of which has no usable beat, all within 0.005 of each other. What DOES
    separate them is how far the best stands above the TYPICAL comb over the
    same search: 2.4 and 1.9 for the two that are on a grid, 1.47 for the one
    that is not, and 2.8 for a synthesised 128 BPM pattern. So the criterion is
    `salience = best / median(all candidate scores)`, and under
    `min_salience` the gate DECLINES: it keeps every peak, reports no period,
    and says why. An ungated onset list must never be mistaken for a gated one,
    and a period fitted to noise is the 442 BPM reading with a nicer number.

    TWO LIMITS THIS GATE HAS AND STATES, because a measurement that hides its
    limits is the thing this whole file exists to avoid:
      * THE METRICAL LEVEL IS AMBIGUOUS. A pattern with a kick on the beat, a
        snare offbeat and 16ths of bass under it is genuinely periodic at the
        eighth as well as at the beat, and the comb will take the eighth when
        the eighth is inside the search range. Measured on the synthesised
        sweep in refprofile_test.py: 128, 174 and the two real gated
        references come back at the beat; 96 BPM comes back at 192, its own
        eighth. That is why `implied_bpm` is REPORTED at the grid and again,
        separately, on the kick's shape from the kept onsets — two numbers
        that can disagree, rather than one that cannot be checked.
      * SPARSE INPUT FITS TRIVIALLY. Twenty peaks over thirty seconds will fit
        a one-second comb whatever they are, and the salience test cannot see
        it because the typical comb is low too. The gate is honest on DENSE
        input, which is the case it exists for (a real drums stem gives 150 to
        600 peaks in two minutes).

    Returns a dict, always. `keep` is a list of indices into `peaks`.
    """
    n_raw = len(peaks)
    out = {"raw_peaks": n_raw, "kept": n_raw, "period_s": None, "implied_bpm": None,
           "tolerance_frac": round(float(tol), 3), "coverage": None, "occupancy": None,
           "salience": None, "gated": False, "why": None, "keep": list(range(n_raw))}
    if n_raw < 8:
        out["why"] = (f"only {n_raw} flux peaks — under 8 there is not enough of a "
                      "pattern to fit a beat to, so every peak is kept and the "
                      "interval is reported from the raw peaks instead")
        return out
    d = np.asarray(d, dtype=np.float64)
    times = np.asarray(peaks, dtype=np.float64) * dt
    w = np.array([max(float(d[p]), 0.0) for p in peaks])
    tot = float(w.sum())
    if tot <= 0:
        out["why"] = "every flux peak has zero weight — there is nothing to fit a grid to"
        return out
    w = w / tot
    span = float(times[-1] - times[0])
    if span < 4.0 * lo_s:
        out["why"] = (f"the peaks span {span:.2f} s, under four of the shortest beat "
                      f"this gate will consider ({lo_s:.2f} s) — too little to fit")
        return out

    step = max(dt, 0.002)
    best = None
    all_scores = []
    for period in np.arange(lo_s, hi_s + 1e-9, step):
        cov, occ, centre, keep, lines = _comb_fit(times, w, float(period), tol)
        score = cov * occ
        all_scores.append(score)
        if best is None or score > best[0]:
            best = (score, float(period), cov, occ, centre, keep, lines)
    score, period, cov, occ, centre, keep, lines = best
    typical = float(np.median(all_scores))
    salience = score / typical if typical > 1e-9 else float("inf")

    # ── ONE REFINEMENT PASS, on the peaks the winner kept ────────────────
    # The search step is 2 ms; a least-squares line through the kept peaks'
    # (grid line, time) pairs gets the period to the sample. It is re-scored
    # afterwards and only taken if it does not make the fit worse.
    pos = times / period - centre
    line = np.round(pos).astype(int)
    if keep.sum() >= 4 and len(set(line[keep].tolist())) >= 3:
        slope, _ = np.polyfit(line[keep].astype(float), times[keep], 1)
        if lo_s <= slope <= hi_s:
            cov2, occ2, centre2, keep2, lines2 = _comb_fit(times, w, float(slope), tol)
            if cov2 * occ2 >= score:
                score, period, cov, occ, centre, keep, lines = (
                    cov2 * occ2, float(slope), cov2, occ2, centre2, keep2, lines2)

    out["coverage"] = round(cov, 3)
    out["occupancy"] = round(occ, 3)
    out["salience"] = round(float(salience), 3) if math.isfinite(salience) else None
    if salience < min_salience:
        out["why"] = (
            f"NO GRID: the best comb over {lo_s:.2f}-{hi_s:.2f} s scores {score:.3f} "
            f"(coverage {cov:.2f} x occupancy {occ:.2f}) against a typical {typical:.3f} "
            f"— a salience of {salience:.2f}, under the {min_salience:.2f} bar. These "
            "peaks are not on a steady beat this gate can find, so every one of them is "
            "kept and NO period is reported. A period fitted to noise is worse than no "
            "period: it is the 442 BPM reading with a nicer number on it.")
        return out

    # ── ONE HIT PER GRID LINE ─────────────────────────────────────────
    # The tolerance window is +-12 % of a beat, which at 0.69 s is +-83 ms,
    # and the peak picker's own floor is 60 ms — so two peaks can and do land
    # inside one window. Left alone that reads as a kick every 72 ms on a track
    # whose kick is every 656 ms, which is the 442 BPM failure arriving THROUGH
    # the gate instead of past it. A grid line is one beat and one beat is one
    # kick: the loudest peak on each line wins.
    pos2 = times / period - centre
    line2 = np.round(pos2).astype(int)
    by_line = {}
    for k in range(n_raw):
        if not bool(keep[k]):
            continue
        ln = int(line2[k])
        if ln not in by_line or w[k] > w[by_line[ln]]:
            by_line[ln] = k
    kept = sorted(by_line.values())
    out.update({
        "kept": len(kept), "period_s": round(float(period), 4),
        "implied_bpm": round(60.0 / period, 2) if period > 0 else None,
        "gated": True, "keep": kept,
        "why": (f"{n_raw} flux peaks reduced to {len(kept)} on a {period:.4f} s grid "
                f"({60.0 / period:.1f} BPM), fitted as a comb: it carries {cov * 100:.0f} % "
                f"of the peak weight, {occ * 100:.0f} % of its lines are occupied, and it "
                f"stands {salience:.2f}x above the typical comb over the same search. A "
                f"peak more than {tol * 100:.0f} % of a beat off that grid is a snare "
                "body, a tom or a 16th of bass movement, not a kick."),
    })
    return out


def kick_onsets(drums, sr, lo=30.0, hi=110.0, min_gap_s=0.06):
    """Onsets of the low-band impulse train in the drums stem, GRID-GATED.

    Returns (sample_indices, grid) where `grid` is beat_grid's report — kept
    beside the onsets on purpose, so nothing downstream can use the onsets
    without being able to see how they were chosen."""
    t, e, _ = envelope(drums, sr, hop_ms=2.0, win_ms=10.0, lo=lo, hi=hi)
    if e.size < 8:
        return np.array([], dtype=int), {"raw_peaks": 0, "kept": 0, "period_s": None,
                                         "implied_bpm": None, "tolerance_frac": GRID_TOL,
                                         "gated": False, "keep": [],
                                         "why": "the clip is shorter than eight envelope frames"}
    dt = float(t[1] - t[0])
    d = flux(e)
    peaks = flux_peaks(d, dt, min_gap_s=min_gap_s)
    grid = beat_grid(d, dt, peaks)
    keep = [peaks[k] for k in grid.pop("keep", list(range(len(peaks))))]
    return np.array([int(round(t[p] * sr)) for p in keep], dtype=int), grid


# ══════════════════════════════════════════════════════ the kick's shape

def kick_shape(drums, sr, onsets, lo=30.0, hi=110.0, span_cap_s=0.6, tail_s=0.35):
    """Attack, decay and tail of the AVERAGE kick, in dB under its own peak.

    t10 / t30 / t60 are the three numbers that turn "make it more like a
    big-room kick" into a knob: they are what a decay control actually sets.
    """
    onsets = [] if onsets is None else [int(o) for o in onsets]
    if len(onsets) < 3:
        return None
    t, e, _ = envelope(drums, sr, hop_ms=1.0, win_ms=6.0, lo=lo, hi=hi)
    if e.size < 8:
        return None
    dt = float(t[1] - t[0])
    ioi = (float(np.median(np.diff(onsets))) / sr) if len(onsets) > 1 else 0.5
    span = int(min(ioi, span_cap_s) / dt)
    if span < 8:
        return None
    segs = []
    for s in onsets:
        i0 = int(round((s / sr) / dt))
        if 0 <= i0 and i0 + span < len(e):
            segs.append(e[i0: i0 + span])
    if not segs:
        return None
    avg = np.mean(np.vstack(segs), axis=0)
    pk = float(avg.max())
    if pk <= 0:
        return None
    a = avg / pk
    i_pk = int(np.argmax(a))
    db = 20.0 * np.log10(np.maximum(a, 1e-9))

    def first_below(level):
        w = np.flatnonzero(db[i_pk:] <= level)
        return (i_pk + int(w[0])) * dt if len(w) else None

    def ms_after_peak(level):
        v = first_below(level)
        return None if v is None else round((v - i_pk * dt) * 1000.0, 1)

    keep = min(int(tail_s / dt), len(db), MAX_ARRAY)
    return {
        "hits": int(len(segs)),
        "ioi_s": round(ioi, 4),
        "implied_bpm": round(60.0 / ioi, 2) if ioi > 0 else None,
        "attack_ms": round(i_pk * dt * 1000.0, 2),
        "t10_ms": ms_after_peak(-10.0),
        "t30_ms": ms_after_peak(-30.0),
        "t60_ms": ms_after_peak(-60.0),
        "envelope_db": [round(float(v), 2) for v in db[:keep]],
        "envelope_hop_ms": round(dt * 1000.0, 3),
    }


def click_ratio(drums, sr, onsets, win_ms=12.0):
    """Energy in the 2-6 kHz click band against the 30-110 Hz body, at the hit.

    The knob this is about is `kick_click` — how much of the transient is top
    end rather than weight."""
    x = np.asarray(drums, dtype=np.float64)
    mono = x.mean(axis=0) if x.ndim > 1 else x
    n = int(sr * win_ms / 1000.0)
    body = clic = 0.0
    used = 0
    N = 1 << 14
    f = np.fft.rfftfreq(N, 1.0 / sr)
    m_body = (f >= 30) & (f < 110)
    m_click = (f >= 2000) & (f < 6000)
    for s in onsets:
        seg = mono[int(s): int(s) + n]
        if len(seg) < n // 2:
            continue
        seg = seg * np.hanning(len(seg))
        S = np.abs(np.fft.rfft(seg, N)) ** 2
        body += float(S[m_body].sum())
        clic += float(S[m_click].sum())
        used += 1
    if not used or body <= 0:
        return None
    return {"click_over_body_db": round(10.0 * math.log10(max(clic, 1e-30) / body), 2),
            "hits": used}


# ═══════════════════════════════════════════════════════════════ the pump

def pump(bass, sr, onsets, floor_frac=0.35, curve_points=MAX_ARRAY):
    """Sidechain depth and recovery, read off a stem's own envelope.

    For each kick onset: the broadband envelope over that beat, normalised to
    its own maximum. DEPTH is the minimum in the first 40 % of the beat, in dB
    under that maximum. RECOVERY is the time from the minimum back to 90 % of
    the maximum. Median over hits, with the median absolute deviation reported
    so a flat (unpumped) reference is visibly flat rather than quietly zero.

    `recovery_frac_of_beat` is the number to compare across tempos: 120 ms at
    128 BPM is a different gesture from 120 ms at 90.
    """
    onsets = [] if onsets is None else [int(o) for o in onsets]
    if len(onsets) < 4:
        return None
    t, e, _ = envelope(bass, sr, hop_ms=2.0, win_ms=12.0)
    if e.size < 8:
        return None
    dt = float(t[1] - t[0])
    ioi = float(np.median(np.diff(onsets))) / sr
    span = int(ioi / dt)
    if span < 8:
        return None
    depths, recs, curves = [], [], []
    for s in onsets:
        i0 = int(round((s / sr) / dt))
        if i0 < 0 or i0 + span >= len(e):
            continue
        seg = e[i0: i0 + span]
        mx = float(seg.max())
        if mx <= 1e-7:
            continue
        a = seg / mx
        curves.append(a)
        head = a[: max(3, int(span * floor_frac))]
        i_min = int(np.argmin(head))
        depths.append(20.0 * math.log10(max(float(head[i_min]), 1e-6)))
        w = np.flatnonzero(a[i_min:] >= 0.9)
        recs.append(float(w[0]) * dt * 1000.0 if len(w) else None)
    if not depths:
        return None
    rec = [r for r in recs if r is not None]
    curve = None
    if curves:
        mean_curve = np.mean(np.vstack(curves), axis=0)
        db = 20.0 * np.log10(np.maximum(mean_curve, 1e-6))
        # Decimated to the cap rather than truncated: a truncated curve would
        # show the duck and hide the recovery, which is the half that matters.
        if len(db) > curve_points:
            idx = np.linspace(0, len(db) - 1, curve_points).round().astype(int)
            db = db[idx]
            hop = ioi * 1000.0 / max(curve_points - 1, 1)
        else:
            hop = dt * 1000.0
        curve = ([round(float(v), 2) for v in db], round(hop, 3))
    return {
        "hits": len(depths),
        "depth_db": round(float(np.median(depths)), 2),
        "depth_mad_db": round(float(np.median(np.abs(np.array(depths) - np.median(depths)))), 2),
        "recovery_ms": round(float(np.median(rec)), 1) if rec else None,
        "recovery_frac_of_beat": round(float(np.median(rec)) / 1000.0 / ioi, 3) if rec else None,
        "beat_s": round(ioi, 4),
        "curve_db": curve[0] if curve else None,
        "curve_hop_ms": curve[1] if curve else None,
    }


# ═══════════════════════════════════════════════════════ width and shape

def width_per_band(x, sr):
    """side/mid RMS ratio inside each of ear.py's nine bands.

    Per band, because "too wide" is almost never true of a whole mix: it is
    true of the bass (which should be mono) or of the air band (which usually
    should not be)."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.vstack([x, x])
    mid = (x[0] + x[1]) * 0.5
    side = (x[0] - x[1]) * 0.5
    _, Em = ear.band_spectrogram(mid, sr)
    _, Es = ear.band_spectrogram(side, sr)
    pm, ps = Em.mean(axis=1), Es.mean(axis=1)
    out = []
    for b in range(len(ear.BANDS)):
        w = math.sqrt(ps[b] / pm[b]) if pm[b] > 1e-20 else None
        out.append({"band": ear.BAND_LABELS[b], "name": ear.BAND_NAMES[b],
                    "width": None if w is None else round(w, 4),
                    "side_over_mid_db": None if w is None
                    else round(20.0 * math.log10(max(w, 1e-6)), 2)})
    return out


def sections(mix, sr, block_s=2.0, min_len_s=8.0):
    """Energy-shape segmentation: per-block nine-band dB, cosine novelty on the
    band vector, boundaries at novelty peaks, then a coarse label from the
    block's own sub/low energy relative to the track's max.

    A label is `drop` / `build` / `body` / `quiet` — the shape of the
    arrangement's ENERGY, which is the only thing a profile is allowed to say
    about structure. No key, no chords, no melody, no lyric."""
    x = np.asarray(mix, dtype=np.float64)
    mono = x.mean(axis=0) if x.ndim > 1 else x
    times, E = ear.band_spectrogram(mono, sr)
    if E.shape[1] < 8:
        return []
    nb = max(1, int(block_s / (times[1] - times[0])))
    blocks, bt = [], []
    for i in range(0, E.shape[1] - nb + 1, nb):
        blocks.append(ear._db(E[:, i:i + nb].mean(axis=1)))
        bt.append(float(times[i]))
    if len(blocks) < 2:
        return []
    B = np.vstack(blocks)
    V = B - B.mean(axis=1, keepdims=True)
    Vn = V / np.maximum(np.linalg.norm(V, axis=1, keepdims=True), 1e-9)
    nov = np.zeros(len(B))
    for i in range(1, len(B)):
        nov[i] = 1.0 - float(np.dot(Vn[i], Vn[i - 1]))
    tot = ear._db((10.0 ** (B / 10.0)).sum(axis=1))
    thr = float(np.percentile(nov, 88))
    gap = max(1, int(min_len_s / block_s))
    bounds = [0]
    i = 1
    while i < len(nov):
        if nov[i] >= thr and i - bounds[-1] >= gap:
            bounds.append(i)
            i += gap
        else:
            i += 1
    bounds.append(len(B))
    top = float(tot.max())
    subs = B[:, 0] + B[:, 1]
    sub_top = float(subs.max())
    out = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a < 1:
            continue
        lv = float(tot[a:b].mean())
        sv = float(subs[a:b].mean())
        lab = ("drop" if lv > top - 2.0 and sv > sub_top - 3.0 else
               "build" if float(tot[b - 1] - tot[a]) > 3.0 else
               "quiet" if lv < top - 8.0 else "body")
        out.append({"t0": round(bt[a], 2),
                    "t1": round(bt[b - 1] + block_s, 2),
                    "label": lab,
                    "level_db": round(lv, 2),
                    "sub_low_db": round(sv, 2),
                    "bands_db": [round(float(v), 2) for v in B[a:b].mean(axis=0)]})
        if len(out) >= MAX_ARRAY:
            break
    return out


# ══════════════════════════════════════════════════ rate, and saying so

def resample_to(x, sr, want=PROFILE_SR):
    """(y, sr, note) at `want` Hz. THE OWNER'S DECISION (SPEC Q2), and it says
    what it did.

    rack.k_weight raises at any rate but 48 kHz, and demucs writes 44.1 whatever
    you feed it, so without this a real commercial reference has no LUFS at all
    and `master.py reference()`'s central promise — both spectra read at the
    same loudness — is unavailable. Polyphase at the exact rational (160/147
    for 44.1 -> 48), which is scipy's resample_poly; if scipy is not here the
    audio is returned untouched and the caller reports LUFS absent rather than
    approximating it.
    """
    sr = int(sr)
    if sr == int(want):
        return x, sr, None
    try:
        from scipy.signal import resample_poly  # noqa: PLC0415 -- optional
    except Exception as exc:                    # noqa: BLE001
        return x, sr, (f"could not resample {sr} Hz to {want} Hz: scipy is not "
                       f"available here ({type(exc).__name__}), so this profile is "
                       "measured at the source rate and its loudness block is absent")
    g = math.gcd(int(want), sr)
    up, down = int(want) // g, sr // g
    x = np.asarray(x, dtype=np.float64)
    y = resample_poly(x, up, down, axis=-1)
    return y, int(want), (
        f"resampled {sr} Hz -> {want} Hz (polyphase, {up}/{down}) before measuring. "
        "rack.k_weight — the BS.1770 filter every LUFS number in this program comes "
        "from — is pinned at 48 kHz, so without this step a 44.1 kHz reference has no "
        "loudness at all and could not be loudness-matched to a project. Resampling "
        "moves the numbers slightly; that is why this sentence is on the profile.")


def loudness_block(x, sr):
    """ear.loudness(), minus the short-term SERIES, plus the rate honesty.

    The series is dropped on purpose: it is a loudness contour of the whole
    track, one value every 100 ms, which is a picture of the arrangement rather
    than a shape measurement — and it would be by far the largest array in the
    file. Its RANGE is kept, because that IS a shape."""
    if int(sr) != PROFILE_SR:
        x = np.asarray(x, dtype=np.float64)
        if x.ndim == 1:
            x = np.vstack([x, x])
        peak = float(np.max(np.abs(x))) if x.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
        pdb = 20.0 * math.log10(max(peak, 1e-12))
        rdb = 20.0 * math.log10(max(rms, 1e-12))
        return {"lufs": None, "true_peak_db": None, "lufs_available": False,
                "lufs_absent_because": f"rack.k_weight is pinned at {PROFILE_SR} Hz; "
                                       f"this is {int(sr)} Hz and it could not be resampled",
                "peak_db": round(pdb, 2), "rms_db": round(rdb, 2),
                "crest_db": round(pdb - rdb, 2)}
    d = ear.loudness(x, sr, short=True)
    d.pop("lufs_short", None)
    d["lufs_available"] = d.get("lufs") is not None
    return d


# ═══════════════════════════════════════════════ THE SHAPE-ONLY WHITELIST

#: Every key name a profile may carry — including the four STEM NAMES, which
#: are keys too (`stems.drums`), and are here rather than special-cased so a
#: fifth stem from some other separator cannot arrive unnamed.
#:
#: Nothing outside this set is emitted, and adding a measurement means adding
#: its name HERE — which is the point: the next person who wants to put a
#: spectrogram frame or a note list on a profile has to write the name down in
#: the file that says a profile is a shape.
ALLOWED_KEYS = frozenset("""
name id source model stem_dir mix_source sr source_sr resampled_from resample_note
seconds stems_present warnings ms built_at shape_only shape_only_note
master stems kick pump pump_other sections
drums bass other vocals
loudness level_rel_mix_db stereo bands third_octave width_per_band
lufs true_peak_db peak_db rms_db crest_db lufs_range lufs_available lufs_absent_because
width correlation mid_rms_db side_rms_db mono_compatible
genre reference loudest_band_db fold measured dual_mono channel_spread fold_hides
band band_index observed_db reference_db deviation_db level_db
left_db right_db mid_db deviation_left_db deviation_right_db
level_left_db level_right_db channel_spread_db fold_cost_db absent db
lo hi centre share_db side_over_mid_db
onsets f0_hz f0_hits shape click sub_over_kick_db grid coverage occupancy salience
hits ioi_s implied_bpm attack_ms t10_ms t30_ms t60_ms envelope_db envelope_hop_ms
click_over_body_db raw_peaks kept period_s tolerance_frac gated why
depth_db depth_mad_db recovery_ms recovery_frac_of_beat beat_s curve_db curve_hop_ms
t0 t1 label sub_low_db bands_db
""".split())


def check_shape_only(obj, max_array=MAX_ARRAY, path="profile"):
    """Walk an emitted profile and RAISE on anything that is not a shape.

    Two rules, both structural rather than semantic, because a semantic rule
    would need someone to decide case by case and that is exactly the decision
    that erodes:
      1. every key name is in ALLOWED_KEYS;
      2. no array is longer than `max_array` (an array long enough to be audio
         is refused whatever it is called), and every array holds numbers,
         strings or dicts — never raw nested arrays of samples.
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k not in ALLOWED_KEYS:
                raise ShapeLeak(
                    f"{path}.{k}: a profile is a SHAPE, never a sample. "
                    f'"{k}" is not in refprofile.ALLOWED_KEYS — if it really is a '
                    "shape measurement, add its name there and say what it is.")
            check_shape_only(v, max_array, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        if len(obj) > max_array:
            raise ShapeLeak(
                f"{path}: {len(obj)} entries, over the {max_array} cap. An array "
                "that long is audio or a spectrogram, not a shape — decimate it "
                "or do not emit it.")
        for i, v in enumerate(obj):
            if isinstance(v, (list, tuple)):
                raise ShapeLeak(f"{path}[{i}]: nested arrays are how a spectrogram "
                                "gets out; a profile carries flat curves only.")
            check_shape_only(v, max_array, f"{path}[{i}]")
    elif obj is not None and not isinstance(obj, (int, float, str, bool)):
        raise ShapeLeak(f"{path}: {type(obj).__name__} is not a number, a string or a flag.")
    return True


# ═════════════════════════════════════════════════════════════ the profile

def _load_stems(stem_dir, warnings):
    audio, srs = {}, set()
    for s in STEMS:
        for ext in (".flac", ".wav", ".mp3", ".ogg"):
            p = os.path.join(stem_dir, f"{s}{ext}")
            if os.path.exists(p):
                y, sr = ear.read_audio_stereo(p)     # want_sr=None: the file's own rate
                audio[s] = y
                srs.add(int(sr))
                break
        else:
            warnings.append(f"missing stem: {s}")
    return audio, srs


def profile(job):
    """A profile from a demucs stem folder.

    job: { stem_dir, mix_path?, name?, id?, sections?: bool }
    """
    t_start = time.perf_counter()
    stem_dir = str(job.get("stem_dir") or "")
    if not stem_dir or not os.path.isdir(stem_dir):
        raise ValueError(f"no such stem folder: {stem_dir!r}")
    warnings = []
    prof = {
        "name": job.get("name") or os.path.basename(stem_dir.rstrip("\\/")),
        "id": job.get("id") or None,
        "source": "demucs four-stem separation",
        "model": job.get("model") or os.path.basename(os.path.dirname(stem_dir.rstrip("\\/"))),
        "stem_dir": os.path.basename(stem_dir.rstrip("\\/")),
        "shape_only": True,
        "shape_only_note":
            "Every number here is a SHAPE: dB, milliseconds and counts. No audio, no "
            "spectrogram frame, no note, no melody and no lyric is measured out of the "
            "reference, and refprofile.check_shape_only() refuses to emit anything "
            "outside a declared whitelist. Matching a profile makes a mix that SITS "
            "like the reference; it cannot make one that sounds like its parts.",
        "stems": {}, "warnings": warnings,
    }
    audio, srs = _load_stems(stem_dir, warnings)
    if not audio:
        raise ValueError(f"no stems found in {stem_dir} (looked for "
                         f"{'/'.join(STEMS)} as .flac/.wav/.mp3/.ogg)")
    if len(srs) != 1:
        raise ValueError(f"the stems disagree on sample rate: {sorted(srs)}")
    src_sr = srs.pop()

    mix = None
    mix_path = job.get("mix_path")
    if mix_path and os.path.exists(str(mix_path)):
        mix, msr = ear.read_audio_stereo(str(mix_path))
        if int(msr) != src_sr:
            warnings.append(f"the mix is {msr} Hz and the stems are {src_sr} Hz — "
                            "the stems' own sum is used instead")
            mix = None
    if mix is None:
        n = min(y.shape[1] for y in audio.values())
        mix = sum(y[:, :n] for y in audio.values())
        prof["mix_source"] = "stem sum"
    else:
        prof["mix_source"] = os.path.basename(str(mix_path))

    # ── THE RATE, AND SAYING SO (SPEC Q2, the owner's decision) ──────────
    note = None
    if src_sr != PROFILE_SR:
        for s in list(audio):
            audio[s], _, note = resample_to(audio[s], src_sr)
        mix, new_sr, note = resample_to(mix, src_sr)
    else:
        new_sr = src_sr
    sr = new_sr if src_sr != PROFILE_SR else src_sr
    prof["sr"] = int(sr)
    prof["source_sr"] = int(src_sr)
    if src_sr != PROFILE_SR:
        prof["resampled_from"] = int(src_sr)
        prof["resample_note"] = note
    prof["seconds"] = round(mix.shape[1] / sr, 2)
    prof["stems_present"] = sorted(audio)

    # ── the master's shape ───────────────────────────────────────────────
    mix_loud = loudness_block(mix, sr)
    prof["master"] = {
        "loudness": mix_loud,
        "stereo": ear.stereo_stats(mix),
        "bands": ear.spectral_balance(mix, sr, "neutral"),
        "third_octave": third_octave_db(mix, sr),
        "width_per_band": width_per_band(mix, sr),
    }

    # ── per stem ─────────────────────────────────────────────────────────
    for s in sorted(audio):
        y = audio[s]
        ld = loudness_block(y, sr)
        prof["stems"][s] = {
            "loudness": ld,
            "level_rel_mix_db": round(ld["rms_db"] - mix_loud["rms_db"], 2),
            "stereo": ear.stereo_stats(y),
            "bands": ear.spectral_balance(y, sr, "neutral"),
            "third_octave": third_octave_db(y, sr),
            "width_per_band": width_per_band(y, sr),
        }

    # ── the kick and the pump ────────────────────────────────────────────
    if "drums" in audio:
        ons, grid = kick_onsets(audio["drums"], sr)
        prof["kick"] = {"onsets": int(len(ons)), "grid": grid}
        if len(ons) >= 3:
            f0, used = ear.kick_f0(audio["drums"], sr, list(ons))
            prof["kick"]["f0_hz"] = None if f0 is None else round(f0, 3)
            prof["kick"]["f0_hits"] = used
            prof["kick"]["shape"] = kick_shape(audio["drums"], sr, ons)
            prof["kick"]["click"] = click_ratio(audio["drums"], sr, ons)
            if "bass" in audio:
                _, Ed = ear.band_spectrogram(audio["drums"].mean(axis=0), sr)
                _, Eb = ear.band_spectrogram(audio["bass"].mean(axis=0), sr)
                prof["kick"]["sub_over_kick_db"] = round(
                    float(ear._db(Eb.mean(axis=1))[0] - ear._db(Ed.mean(axis=1))[1]), 2)
                prof["pump"] = pump(audio["bass"], sr, ons)
            prof["pump_other"] = pump(audio["other"], sr, ons) if "other" in audio else None
    if job.get("sections") is not False:
        prof["sections"] = sections(mix, sr)
    prof["built_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    prof["ms"] = round((time.perf_counter() - t_start) * 1000, 1)
    check_shape_only(prof)
    return prof


def build(job):
    """The serve/CLI mode: a profile, plus ok."""
    return {"ok": True, "profile": profile(job)}


def probe(job=None):
    """What this profiler can do on this machine, and what it refuses to do."""
    have_scipy = True
    scipy_err = None
    try:
        from scipy.signal import resample_poly  # noqa: F401,PLC0415
    except Exception as exc:                    # noqa: BLE001
        have_scipy = False
        scipy_err = f"{type(exc).__name__}: {exc}"
    have_av = True
    try:
        import av  # noqa: F401,PLC0415
    except Exception:                           # noqa: BLE001
        have_av = False
    return {
        "ok": True,
        "profile_sr": PROFILE_SR,
        "stems": list(STEMS),
        "bands": ear.BAND_LABELS,
        "third_octave_bands": len([b for b in third_octave_edges() if b[1] <= PROFILE_SR / 2.0]),
        "max_array": MAX_ARRAY,
        "allowed_keys": sorted(ALLOWED_KEYS),
        "resample": {
            "available": have_scipy,
            "why": ("44.1 kHz references are resampled to 48 kHz before measuring, and "
                    "the profile says so — rack.k_weight is pinned at 48 kHz, so this is "
                    "what makes loudness matching against a real reference possible at all")
            if have_scipy else
            ("scipy is not importable here, so a 44.1 kHz reference is measured at its own "
             "rate and its loudness block reports itself absent with the reason"),
            "error": scipy_err,
        },
        "decoder": "PyAV" if have_av else "wav only (PyAV is not importable here)",
        "grid_gate": {
            "beat_range_s": [BEAT_LO_S, BEAT_HI_S],
            "tolerance_frac": GRID_TOL,
            "min_salience": GRID_MIN_SALIENCE,
            "why": "ungated flux peaks read 442 BPM on a real track and 454 BPM on the "
                   "synthesised 128 BPM pattern refprofile_test.py builds; the comb fit "
                   "returns the synthetic to 0.470 s (127.7 BPM) and gates its onsets "
                   "back to a 0.468 s interval. A fit that is not salient DECLINES.",
        },
        "refuses": [
            "audio of any kind", "spectrogram frames", "note or melody data",
            f"any array longer than {MAX_ARRAY}", "any key outside allowed_keys",
        ],
        "pid": os.getpid(),
    }


MODES = {"build": build, "probe": probe}


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
            raise ValueError("usage: refprofile.py <build|probe> <job.json>  |  "
                             "refprofile.py serve")
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
