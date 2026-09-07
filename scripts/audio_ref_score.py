#!/usr/bin/env python3
"""Did the audio reference actually do anything?

Two things must be true at once for this to be a real feature:
  RETENTION - the output resembles the REFERENCE (its structure carried over)
  ADHERENCE - the output still moved toward the CAPTION (prompt not ignored)

Either alone is worthless: denoise 0 trivially retains (it IS the reference),
denoise 1 trivially adheres (it ignores the reference). The claim needs a band
where retention clearly beats the denoise-1.0 floor while the output is still
audibly not just a copy.
"""
import glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, torch, torchaudio
from _audio_io import load_mono

OUT = r"D:/AI/aiplay-studio-bench/ComfyUI/output"
REF = os.path.join(OUT, "aiplay_00043.flac")

def mel(w, sr):
    if sr != 24000: w = torchaudio.functional.resample(w, sr, 24000)
    m = torchaudio.transforms.MelSpectrogram(24000, n_fft=2048, hop_length=480, n_mels=64)(w)
    return torch.log10(m.clamp(min=1e-6))[0]

def corr(a, b):
    T = min(a.shape[1], b.shape[1]); a, b = a[:, :T], b[:, :T]
    a = (a - a.mean()) / (a.std() + 1e-9); b = (b - b.mean()) / (b.std() + 1e-9)
    return float((a * b).mean())

rw, rs = load_mono(REF, secs=8)
ref = mel(rw, rs)
print(f"reference : aiplay_00043 first 8.0s ({rw.shape[1]/rs:.2f}s loaded)")
print(f"caption   : dark synthwave (deliberately unlike the reference)\n")

rt = sorted(glob.glob(os.path.join(OUT, "arefstock_*.flac")))
if rt:
    w, sr = load_mono(rt[-1])
    print(f"SANITY encode->ComfyUI decode, no sampler: {w.shape[1]/sr:.2f}s  "
          f"corr {corr(mel(w, sr), ref):.3f}  (want ~1.0)\n")

rows = []
for d in ["1", "095", "09", "085", "08", "06", "04", "02"]:
    f = sorted(glob.glob(os.path.join(OUT, f"aref_d{d}_*.flac")))
    if f:
        w, sr = load_mono(f[-1])
        rows.append((d, mel(w, sr), w.shape[1] / sr))
pure = next(m for d, m, _ in rows if d == "1")
floor = corr(pure, ref)

print(f"{'denoise':>8}{'dur':>7}{'->reference':>13}{'->pure t2m':>12}   verdict")
print("-" * 62)
for d, m, dur in rows:
    cr, cp = corr(m, ref), corr(m, pure)
    lbl = "1.0" if d == "1" else "0." + d[1:]
    if d == "1":
        v = "floor: reference ignored"
    elif cr > floor + 0.15:
        v = "REFERENCE CARRIED THROUGH" if cp > 0.35 else "retains reference"
    else:
        v = "reference had no effect"
    print(f"{lbl:>8}{dur:>6.1f}s{cr:>13.3f}{cp:>12.3f}   {v}")
print("-" * 62)
print(f"floor (pure text-to-music vs reference) = {floor:.3f}")
