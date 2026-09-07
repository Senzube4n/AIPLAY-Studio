#!/usr/bin/env python3
"""Score the H3 sigma sweep.

Four numbers per clip, chosen because each answers a different question — the
music work's rule that one instrument measures distance and another measures
whether the distance MATTERS:

  psnr_ref   PSNR against the converged 30-step reference, same seed, same shift.
             HIGHER = closer to converged. This is the direct analogue of the
             "2x closer to the converged solution" result from the schedule work.

  loop_db    PSNR between the FIRST and LAST frame. This is the metric nobody
             uses and the one that actually decides whether a clip loops. It is
             scored on its own terms, not against a reference.

  flicker    Mean absolute frame-to-frame delta. A proxy for temporal stability;
             a clip can be sharp per-frame and still boil.

  audio_rms  Audio level in dBFS. H3 always renders audio, and the EasyCache
             regression that hurt this model was an AMPLITUDE regression — so
             audio is watched even though we intend to discard it.

⚠ Comparing two clips from DIFFERENT seeds per-pixel is meaningless — they are
different samples, not better and worse ones. The seedB run exists ONLY to show
what "a completely different sample" scores, which bounds how much of any shift
effect could be noise. Read it as context, never as a ranking.
"""
from __future__ import annotations

import glob
import math
import os
import sys

import av
import numpy as np

OUT = r"D:\AI\aiplay-studio-bench\ComfyUI\output"


def frames(path, limit=None):
    c = av.open(path)
    out = []
    for f in c.decode(video=0):
        out.append(f.to_ndarray(format="rgb24").astype(np.float32))
        if limit and len(out) >= limit:
            break
    c.close()
    return out


def audio_rms_dbfs(path):
    try:
        c = av.open(path)
        if not c.streams.audio:
            c.close()
            return None
        acc = []
        for fr in c.decode(audio=0):
            acc.append(fr.to_ndarray().astype(np.float32).ravel())
        c.close()
        if not acc:
            return None
        a = np.concatenate(acc)
        peak = np.max(np.abs(a)) or 1.0
        a = a / peak if peak > 1.5 else a          # int16 vs float input
        r = float(np.sqrt(np.mean(a ** 2)))
        return round(20 * math.log10(max(r, 1e-9)), 1)
    except Exception:
        return None


def psnr(a, b):
    """Standard PSNR on 0-255 RGB. inf when identical."""
    mse = float(np.mean((a - b) ** 2))
    if mse <= 1e-12:
        return float("inf")
    return 10 * math.log10((255.0 ** 2) / mse)


def clip_psnr(fa, fb):
    n = min(len(fa), len(fb))
    if n == 0:
        return None
    vals = [psnr(fa[i], fb[i]) for i in range(n)]
    finite = [v for v in vals if math.isfinite(v)]
    return round(sum(finite) / len(finite), 2) if finite else float("inf")


def newest(prefix):
    g = sorted(glob.glob(os.path.join(OUT, f"{prefix}_*.mp4")), key=os.path.getmtime)
    return g[-1] if g else None


RUNS = [
    ("ref30",     "sw_ref30"),
    ("ref40",     "sw_ref40"),
    ("floor seedB", "sw_floorB"),
    ("stock (no node)", "sw_s8_stock"),
    ("shift 4/3",  "sw_s8_v4"),
    ("shift 6/3",  "sw_s8_v6"),
    ("shift 9/3",  "sw_s8_v9"),
    ("shift 12/3", "sw_s8_v12"),
    ("shift 16/3", "sw_s8_v16"),
    ("shift 12/1.5", "sw_s8_a15"),
    ("shift 12/6", "sw_s8_a6"),
    ("shift 12/12", "sw_s8_a12"),
]


def main() -> int:
    ref_path = newest("sw_ref30")
    if not ref_path:
        print("no reference render found — run h3_sweep.mjs first")
        return 1
    ref = frames(ref_path)
    print(f"reference: {os.path.basename(ref_path)}  ({len(ref)} frames)\n")

    print(f"{'run':<18}{'psnr_ref':>10}{'loop_db':>10}{'flicker':>10}{'audio':>9}")
    print("-" * 57)
    for label, prefix in RUNS:
        p = newest(prefix)
        if not p:
            print(f"{label:<18}{'(missing)':>10}")
            continue
        fr = frames(p)
        pr = clip_psnr(ref, fr)
        loop = psnr(fr[0], fr[-1]) if len(fr) > 1 else None
        flick = round(float(np.mean([np.mean(np.abs(fr[i + 1] - fr[i])) for i in range(len(fr) - 1)])), 2) if len(fr) > 1 else None
        rms = audio_rms_dbfs(p)
        fmt = lambda v, s="": ("inf" if v == float("inf") else f"{v}{s}") if v is not None else "-"
        print(f"{label:<18}{fmt(pr):>10}{fmt(loop):>10}{fmt(flick):>10}{fmt(rms):>9}")

    print("\nHIGHER psnr_ref = closer to the converged reference.")
    print("HIGHER loop_db  = first and last frame agree = loops better.")
    print("LOWER  flicker  = steadier between frames.")
    print("\n⚠ 'floor seedB' is a DIFFERENT SAMPLE, not a worse one. Its psnr_ref")
    print("  is the score of an unrelated clip — any shift effect that does not")
    print("  clear that margin is indistinguishable from changing the seed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
