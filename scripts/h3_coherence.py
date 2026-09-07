#!/usr/bin/env python3
"""Score a clip for the thing the user actually complained about: morphing.

"Jittery, morphing" is temporal INCOHERENCE — the picture changing identity
between frames rather than moving. Three numbers separate that from real motion:

  motion   mean |frame - prev|. Pure magnitude. A static clip and a morphing one
           can share this, so it is context, not a verdict.
  jitter   std of that difference across the clip, normalised by its mean. Real
           camera motion is SMOOTH, so its frame-to-frame difference is roughly
           constant; morphing lurches. This is the headline number.
  drift    correlation between the first and last frames. A 2-second clip that
           keeps its subject stays correlated; one that morphs into something
           else does not.

Lower jitter and higher drift-correlation are better. Reported per clip so a
sweep can be read as a table.
"""
from __future__ import annotations
import subprocess, sys, os
import numpy as np


def frames(path, every=1, size=(160, 96)):
    """Decode to raw grayscale via ffmpeg — no image library needed."""
    w, h = size
    cmd = ["ffmpeg", "-v", "error", "-i", path,
           "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (w * h)
    a = np.frombuffer(raw[: n * w * h], dtype=np.uint8).reshape(n, h, w).astype(float)
    return a[::every]


def score(path):
    f = frames(path)
    if len(f) < 3:
        return None
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    motion = d.mean()
    jitter = d.std() / (d.mean() + 1e-9)
    a, b = f[0].ravel(), f[-1].ravel()
    drift = float(np.corrcoef(a, b)[0, 1])
    return motion, jitter, drift


def main():
    paths = sys.argv[1:]
    print(f"{'clip':<34}{'motion':>9}{'jitter':>9}{'drift r':>9}")
    print("-" * 61)
    rows = []
    for p in paths:
        try:
            r = score(p)
        except Exception as exc:
            print(f"{os.path.basename(p):<34}  ERROR {exc}")
            continue
        if not r:
            continue
        rows.append((os.path.basename(p), *r))
        print(f"{os.path.basename(p):<34}{r[0]:>9.2f}{r[1]:>9.3f}{r[2]:>9.3f}")
    if rows:
        print("-" * 61)
        # rows are (name, motion, jitter, drift) — index 2 is jitter, not 1.
        best_j = min(rows, key=lambda x: x[2])
        best_d = max(rows, key=lambda x: x[3])
        print(f"lowest jitter (least morphing): {best_j[0]}")
        print(f"highest drift correlation     : {best_d[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
