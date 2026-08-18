"""Waveform peaks, computed server-side.

The browser was decoding the FLAC itself via decodeAudioData, which is not
reliable — Chrome's FLAC support in the Web Audio API is inconsistent, and when it
fails the editor sits on "reading audio…" forever with no way forward.

PyAV is already here and decodes anything ComfyUI can write, so compute the
envelope once on the server and send a small JSON array instead of shipping tens
of megabytes to the client to be decoded twice.

Min/max per column rather than RMS: a true peak envelope keeps transients and
section boundaries visible, which is the whole point of looking at a waveform
when choosing where to cut.

Usage: peaks.py <file> [columns]
"""
from __future__ import annotations

import json
import sys

import av
import numpy as np


def main() -> int:
    path = sys.argv[1]
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 1200

    c = av.open(path)
    st = c.streams.audio[0]
    sr, ch = st.codec_context.sample_rate, st.codec_context.channels
    planar = st.codec_context.format.is_planar
    frames = [f.to_ndarray() for f in c.decode(audio=0)]
    c.close()

    if not frames:
        print(json.dumps({"ok": False, "error": "no audio frames"}))
        return 0

    a = np.concatenate(frames, axis=-1).astype(np.float32)
    if planar or a.shape[0] == ch:
        mono = a.mean(axis=0)
    else:
        flat = a.reshape(-1)
        mono = flat[: (len(flat) // ch) * ch].reshape(-1, ch).mean(axis=1)
    mono /= 32768.0

    n = len(mono)
    step = max(1, n // cols)
    usable = (n // step) * step
    blocks = mono[:usable].reshape(-1, step)
    lo = blocks.min(axis=1)
    hi = blocks.max(axis=1)

    # Interleaved [lo, hi, lo, hi, ...], rounded to 3 dp — plenty for a 96 px tall
    # canvas and it keeps the payload small.
    out = np.empty(lo.size * 2, dtype=np.float32)
    out[0::2] = lo
    out[1::2] = hi

    print(json.dumps({
        "ok": True,
        "seconds": round(n / sr, 3),
        "rate": sr,
        "channels": ch,
        "peaks": [round(float(v), 3) for v in out],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
