"""Beat times for a finished track, using only what is already installed.

WHY THIS EXISTS. "Cut on the beat" is the difference between a slideshow and a
music video, and it is the one thing an agent driving the Studio cannot fake —
it needs actual times. librosa would be one import, but it is not in the ComfyUI
venv and adding it there is exactly the kind of dependency creep that has
already cost this project a 5x slowdown once (see the stems note in art.js). So
this is written against torch + numpy + scipy, all of which are already present
because the engine needs them.

THE METHOD, and its limits:

  1. Load, mono, resample to 22050 Hz. Music has nothing above 11 kHz that
     matters for finding a downbeat.
  2. Spectral flux onset envelope: STFT, then the sum of POSITIVE frame-to-frame
     magnitude differences per frame. Positive-only is the whole trick — energy
     appearing is an onset, energy decaying is not, and rectifying is what stops
     every note release registering as a hit.
  3. Tempo by autocorrelating that envelope over a plausible BPM range, weighted
     toward ~120 BPM so the classic octave error (picking half or double time)
     resolves the way a listener would hear it.
  4. Beats by dynamic programming: pick the sequence of peaks that maximises
     onset strength while staying close to the estimated period. A greedy
     peak-picker drifts on a track with syncopation; the DP keeps a steady grid.

Honest about accuracy: this is good on music with a clear kick — which is what
this app generates — and it will do poorly on rubato, on ambient material with
no transients, and on anything with a heavily swung feel. It reports a
confidence so a caller can decline to use it rather than cutting to nonsense.
"""
import json
import sys

import os

import numpy as np
import torch
import torchaudio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _audio_io import load_mono as _load_mono   # noqa: E402


def load_mono(path, sr=22050):
    """Mono float32 at `sr`.

    ⚠ Decoded through `_audio_io`, NOT `torchaudio.load`. Two reasons, both
    learned the hard way. torchaudio 2.11 delegates loading to TorchCodec, which
    is not installed here and raises on the first call. And PyAV hands PACKED
    stereo back interleaved as (1, N*ch) — reading that as mono silently doubles
    the length and scrambles the spectrum, which would put every beat time in
    this file at roughly half its true value while looking perfectly plausible.
    `_audio_io` exists precisely because that already caused two wrong
    conclusions once.
    """
    wav, in_sr = _load_mono(path)
    if in_sr != sr:
        wav = torchaudio.functional.resample(wav, in_sr, sr)
    return wav.squeeze(0).numpy().astype(np.float32), sr


def onset_envelope(y, sr, hop=512, n_fft=2048):
    """Positive spectral flux, one value per hop."""
    win = torch.hann_window(n_fft)
    spec = torch.stft(
        torch.from_numpy(y), n_fft=n_fft, hop_length=hop, window=win,
        return_complex=True, center=True,
    ).abs().numpy()

    # Log magnitude: loudness is perceptual, and a linear flux is dominated by
    # whichever section of the song happens to be loudest.
    spec = np.log1p(spec * 10.0)

    diff = np.diff(spec, axis=1)
    flux = np.maximum(diff, 0.0).sum(axis=0)          # rectify: onsets only
    flux = np.concatenate([[0.0], flux])

    # Subtract a local mean so a loud chorus does not outvote a quiet verse.
    k = 16
    kernel = np.ones(k) / k
    local = np.convolve(flux, kernel, mode="same")
    env = np.maximum(flux - local, 0.0)
    if env.max() > 0:
        env = env / env.max()
    # The spectrogram travels with the envelope so the band pass below is an
    # average over an array we already have rather than a second STFT.
    return env, sr / hop, spec                        # envelope, frames per second, magnitudes


# Frames per second of the reported envelopes. Fixed, so a caller can index by
# `int(t * ENV_FPS)` rather than having to carry a timebase around, and low
# enough that a three-minute song is a couple of hundred kilobytes of JSON.
ENV_FPS = 30.0

# The four bands, in HERTZ.
#
# ⚠ Deliberately not "a fraction of the FFT bins", which is what the live
# in-browser detector uses. Bin fractions depend on the sample rate and the FFT
# size, so the same slider produced different bands in the two paths and a look
# tuned in the editor did not survive being re-derived offline. Hertz is the
# thing a listener actually means.
BANDS = {
    "bass": (20.0, 160.0),      # kick and sub
    "low": (160.0, 800.0),      # bass guitar, low synth, the body of a snare
    "mid": (800.0, 3000.0),     # vocals and most melody
    "high": (3000.0, 11000.0),  # hats, air, sibilance
}


def band_envelopes(spec, sr, hop, n_fft, duration):
    """Per-band loudness over time, resampled to a fixed frame rate.

    `spec` is the same magnitude spectrogram the onset envelope was built from,
    so this costs an average and an interpolation rather than a second STFT.

    Each band is normalised against its OWN 97th percentile, not against the
    loudest band. A mix where the hats are 30 dB below the kick still has a
    usable hat envelope that way, which is the entire point of choosing a band
    — normalising everything together would just reproduce the kick four times.

    The percentile rather than the max because one clipped frame would otherwise
    scale the whole track down around it.
    """
    n_frames = spec.shape[1]
    if n_frames < 2:
        return {}
    freqs = np.linspace(0.0, sr / 2.0, spec.shape[0])
    src_t = np.arange(n_frames) * (hop / sr)
    out_t = np.arange(0.0, max(duration, src_t[-1]), 1.0 / ENV_FPS)

    out = {}
    for name, (lo, hi) in BANDS.items():
        sel = (freqs >= lo) & (freqs < hi)
        if not sel.any():
            continue
        # Mean magnitude across the band. Mean, not sum: a wide band would
        # otherwise read louder than a narrow one purely for being wide.
        v = spec[sel].mean(axis=0)
        ref = float(np.percentile(v, 97))
        # A silent band stays silent instead of becoming amplified noise.
        v = v / ref if ref > 1e-6 else np.zeros_like(v)
        out[name] = np.clip(np.interp(out_t, src_t, v), 0.0, 1.5)
    return out


def resample_env(env, fps, duration):
    """The onset envelope on the same grid as the bands."""
    if env.size < 2:
        return np.zeros(1, dtype=np.float32)
    src_t = np.arange(env.size) / fps
    out_t = np.arange(0.0, max(duration, src_t[-1]), 1.0 / ENV_FPS)
    return np.clip(np.interp(out_t, src_t, env), 0.0, 1.0)


def estimate_tempo(env, fps, lo=60.0, hi=190.0):
    """Autocorrelation of the onset envelope, weighted toward a human default."""
    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    if ac[0] > 0:
        ac = ac / ac[0]

    lag_lo = max(1, int(fps * 60.0 / hi))
    lag_hi = min(len(ac) - 1, int(fps * 60.0 / lo))
    if lag_hi <= lag_lo:
        return 120.0, 0.0

    lags = np.arange(lag_lo, lag_hi)
    bpms = 60.0 * fps / lags

    # A log-normal prior around 120 BPM. Without it, autocorrelation happily
    # returns half or double the tempo a person would tap — the peaks are
    # genuinely there, and picking between them is a perceptual choice rather
    # than a signal-processing one.
    prior = np.exp(-0.5 * (np.log2(bpms / 120.0) / 0.9) ** 2)
    score = ac[lag_lo:lag_hi] * prior

    best = int(np.argmax(score))
    return float(bpms[best]), float(max(0.0, score[best]))


def track_beats(env, fps, bpm):
    """
    Dynamic programming over the onset envelope.

    Maximise (onset strength at each chosen frame) minus (a penalty for
    deviating from the expected period). A greedy picker drifts as soon as the
    track syncopates; this keeps a steady grid and still snaps to real onsets.
    """
    period = fps * 60.0 / bpm
    if period < 2 or len(env) < 4:
        return []

    n = len(env)
    score = np.full(n, -np.inf)
    prev = np.full(n, -1, dtype=int)

    lo = int(period * 0.5)
    hi = int(period * 1.6)
    tightness = 100.0

    score[0] = env[0]
    for i in range(1, n):
        a = max(0, i - hi)
        b = max(a + 1, i - lo + 1)
        if b <= a:
            score[i] = env[i]
            continue
        cand = np.arange(a, b)
        # Squared log deviation from the ideal spacing — symmetric in tempo,
        # so being 10% fast is penalised as much as being 10% slow.
        dev = np.log(np.maximum(i - cand, 1) / period)
        val = score[cand] - tightness * dev * dev
        j = int(np.argmax(val))
        score[i] = env[i] + val[j]
        prev[i] = cand[j]

    # Backtrack from the best ending in the final period, so a fade-out does not
    # decide where the grid ends.
    tail = max(0, n - int(period))
    end = int(tail + np.argmax(score[tail:]))
    beats = []
    while end >= 0:
        beats.append(end)
        end = prev[end]
    beats.reverse()
    return [b / fps for b in beats]


def choose_bar_phase(beats, onset, bands, env_fps, beats_per_bar=4):
    """WHICH of the four beats starts the bar — measured, not assumed.

    `beats[::4]` assumes 4/4 AND that bar one begins on beat one. The second
    half is pure assumption: track_beats lays its grid from the start of the
    file, so beat zero is wherever the DP happened to begin, not a downbeat.

    Scored all four candidate phases against what a listener actually uses to
    hear a downbeat — kick energy and onset strength at the candidate times —
    across the five songs this repo has made:

        sub-rosa            phase 0  margin 1.23   (as assumed)
        ninety-nine-rooms   phase 0  margin 1.12   (as assumed)
        copper-wire         phase 0  margin 1.004  a coin flip, no evidence
        slow-hand-on-six    phase 1  margin 1.07   WRONG by one beat
        the-long-ascent     phase 2  margin 1.17   WRONG by two beats

    So the old default was right on two of five, unsupported on a third, and
    wrong on two. Snapping cuts to that grid put them on the wrong bars.

    ⚠ Returns the margin as well, and callers should use it. Nothing here makes
    a weak result strong: at margin ~1.0 the four phases are indistinguishable
    and the honest move is to leave the cuts where the lyrics put them.
    """
    if len(beats) < beats_per_bar * 2:
        return 0, 1.0, [0.0] * beats_per_bar

    bass = bands.get("bass")
    if bass is None or not len(bass):
        return 0, 1.0, [0.0] * beats_per_bar

    def peak(sig, t, half=0.06):
        i0 = max(0, int((t - half) * env_fps))
        i1 = min(len(sig), int((t + half) * env_fps) + 1)
        return float(np.max(sig[i0:i1])) if i1 > i0 else 0.0

    kick, hit = [], []
    for p in range(beats_per_bar):
        cand = beats[p::beats_per_bar]
        if not cand:
            kick.append(0.0); hit.append(0.0); continue
        kick.append(float(np.mean([peak(bass, t) for t in cand])))
        hit.append(float(np.mean([peak(onset, t) for t in cand])))

    k = np.asarray(kick); h = np.asarray(hit)
    # Each cue normalised across the four phases, so neither wins on scale alone.
    k = k / k.sum() if k.sum() > 0 else k
    h = h / h.sum() if h.sum() > 0 else h
    comb = k + h
    best = int(np.argmax(comb))
    runner = float(np.sort(comb)[-2]) if comb.size > 1 else 1.0
    margin = float(comb[best] / runner) if runner > 0 else 1.0
    return best, round(margin, 4), [round(float(x), 4) for x in comb]


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: beats.py <audiofile>"}))
        return 1
    path = sys.argv[1]
    try:
        y, sr = load_mono(path)
        if y.size < sr:
            print(json.dumps({"error": "too short to analyse"}))
            return 1
        env, fps, spec = onset_envelope(y, sr)
        bpm, conf = estimate_tempo(env, fps)
        beats = track_beats(env, fps, bpm)

        # Report the tempo the GRID actually implies, not the autocorrelation
        # seed that started it. Measured against synthetic click tracks: the
        # seed came out 71.78 / 99.38 / 143.55 for ground truths of 72 / 100 /
        # 140, while the median beat spacing gave 72.06 / 100.08 / 140.21 —
        # under 0.2% error. The DP refines the estimate, so the refined number
        # is the honest one to publish.
        gaps = np.diff(beats) if len(beats) > 2 else np.array([])
        # A LINEAR FIT over beat index, not the mean or median gap.
        #
        # Beat times are quantised to the 23 ms STFT hop, so individual gaps
        # alternate between neighbouring frames — the median lands on one of
        # them and reads ~0.3% off, which is enough to drift audibly over a
        # three-minute song. Fitting a line through (index, time) averages the
        # quantisation out and estimates the true period directly.
        refined = bpm
        if len(beats) > 3:
            idx = np.arange(len(beats), dtype=np.float64)
            period = float(np.polyfit(idx, np.asarray(beats, dtype=np.float64), 1)[0])
            if period > 0:
                refined = 60.0 / period

        duration = len(y) / sr
        bands = band_envelopes(spec, sr, 512, 2048, duration)
        onset = resample_env(env, fps, duration)

        # The bar grid, now that there is something to score it against.
        bar_phase, bar_margin, bar_scores = choose_bar_phase(beats, onset, bands, ENV_FPS)
        bars = beats[bar_phase::4]

        print(json.dumps({
            "bpm": round(refined, 2),
            "bpmSeed": round(bpm, 2),
            "steadiness": round(float(np.std(gaps)), 4) if gaps.size else None,
            "confidence": round(conf, 3),
            "duration": round(len(y) / sr, 3),
            "beats": [round(b, 3) for b in beats],
            "bars": [round(b, 3) for b in bars],
            # ⚠ Read barMargin before snapping anything to `bars`. Near 1.0 the
            # four candidate phases scored the same and this grid carries no
            # evidence — it is a guess with a number next to it.
            "barPhase": bar_phase,
            "barMargin": bar_margin,
            "barScores": bar_scores,
            # ── The audio-reactive half ──────────────────────────────────────
            # Deterministic envelopes, so an effect driven by the music renders
            # identically every time and does not depend on a tab being visible
            # and playing. The in-browser analyser can only ever describe what
            # is audible right now.
            "envFps": ENV_FPS,
            "onset": [round(float(v), 3) for v in onset],
            "bands": {k: [round(float(x), 3) for x in v] for k, v in bands.items()},
        }))
        return 0
    except Exception as e:                                   # noqa: BLE001
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
