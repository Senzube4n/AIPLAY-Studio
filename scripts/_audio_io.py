"""Correct PyAV -> float32 audio.

PACKED stereo arrives from `frame.to_ndarray()` as (1, N*ch) INTERLEAVED. Reading
that as (1, N) mono silently doubles the length and scrambles the spectrum, and
it does NOT look like a bug downstream — it looks like a bad encoder. It cost two
wrong conclusions in this experiment before being caught, so every audio load in
these scripts goes through here.
"""
import numpy as np, torch, av


def _decode(path):
    c = av.open(path)
    st = c.streams.audio[0]
    sr, ch = st.codec_context.sample_rate, st.codec_context.channels
    parts = []
    for f in c.decode(audio=0):
        a = f.to_ndarray().astype(np.float32)
        if f.format.is_planar:
            a = a if a.ndim == 2 else a.reshape(1, -1)            # already (ch, N)
        else:
            a = a.reshape(-1, ch).T                                # (1, N*ch) -> (ch, N)
        parts.append(a)
    c.close()
    a = np.concatenate(parts, axis=-1)
    if np.abs(a).max() > 1.5:
        a = a / 32768.0                                            # int16 -> float
    return a, sr


def load_stereo(path, secs=None):
    """(1, 2, N) float32 in [-1, 1], plus sample rate."""
    a, sr = _decode(path)
    if a.shape[0] == 1:
        a = np.repeat(a, 2, 0)
    elif a.shape[0] > 2:
        a = a[:2]
    if secs:
        a = a[:, : int(secs * sr)]
    return torch.from_numpy(np.ascontiguousarray(a))[None], sr


def load_mono(path, secs=None):
    """(1, N) float32, channels averaged, plus sample rate."""
    a, sr = _decode(path)
    a = a.mean(0, keepdims=True)
    if secs:
        a = a[:, : int(secs * sr)]
    return torch.from_numpy(np.ascontiguousarray(a)), sr
