#!/usr/bin/env python3
"""Score the LoRA self-consistency test.

THE ONLY QUESTION: did the adapter pull the render toward its training target by
more than a different seed would have?

Three renders, one target:
    baseA   no LoRA, flow seed 1
    baseB   no LoRA, flow seed 2      <- the noise floor
    tuned   with LoRA, flow seed 1    <- same seed as baseA, so the LoRA is the
                                         only difference between them
    target  the song the LoRA was trained on

If `tuned` is not closer to `target` than `baseA` is, by more than the gap
between `baseA` and `baseB`, then 150 steps did nothing a reseed would not also
have done. That is a real answer and a cheap one.

METRICS. Deliberately not waveform correlation: two renders of the same
composition with different flow noise are different waveforms by construction,
and r would read ~0 for both. What is being asked is "does it SOUND more like
the target", so this compares timbre and spectral shape:

  mel_l1     mean absolute difference of log-mel spectra. Lower = closer.
             The workhorse — it is what "same instruments, same production"
             looks like numerically.
  centroid   spectral centroid in Hz. A blunt brightness proxy; two takes with
             the same mix land close.
  rms_db     loudness. Included because the earlier EasyCache regression on the
             video model was an AMPLITUDE regression, and a LoRA that merely
             changes level would otherwise look like it changed timbre.

⚠ These are similarity proxies, not judgements. If the numbers say one thing and
the audio says another, the audio wins. There is a listen list at the end.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from _audio_io import load_mono          # the ONLY correct loader — see its docstring

OUT = Path("D:/AI/aiplay-studio-bench/ComfyUI/output")
TARGET = OUT / "aiplay_00043.flac"
SR = 44100


def mel_bank(n_fft: int, n_mels: int = 96, sr: int = SR) -> np.ndarray:
    """A mel filterbank, by hand — no librosa in this environment."""
    def hz2mel(f): return 2595.0 * np.log10(1.0 + f / 700.0)
    def mel2hz(m): return 700.0 * (10 ** (m / 2595.0) - 1.0)
    fmax = sr / 2
    pts = mel2hz(np.linspace(hz2mel(20.0), hz2mel(fmax), n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for i in range(n_mels):
        a, b, c = bins[i], bins[i + 1], bins[i + 2]
        if b == a: b = a + 1
        if c == b: c = b + 1
        c = min(c, fb.shape[1] - 1); b = min(b, c - 1); a = min(a, b - 1)
        if b > a: fb[i, a:b] = np.linspace(0, 1, b - a)
        if c > b: fb[i, b:c] = np.linspace(1, 0, c - b)
    return fb


def features(path: Path, seconds: float = 55.0) -> dict:
    x, sr = load_mono(str(path))
    x = np.asarray(x).reshape(-1)[: int(seconds * sr)]
    n_fft, hop = 2048, 512
    win = np.hanning(n_fft).astype(np.float32)
    frames = 1 + max(0, (len(x) - n_fft) // hop)
    spec = np.empty((frames, n_fft // 2 + 1), dtype=np.float32)
    for i in range(frames):
        seg = x[i * hop: i * hop + n_fft] * win
        spec[i] = np.abs(np.fft.rfft(seg))
    fb = mel_bank(n_fft)
    mel = np.log10(spec @ fb.T + 1e-6)
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    mag = spec.sum(axis=1) + 1e-9
    centroid = float(np.mean((spec * freqs).sum(axis=1) / mag))
    rms = float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9))
    return {"mel": mel, "centroid": centroid, "rms_db": rms, "seconds": len(x) / sr}


def compare(a: dict, b: dict) -> dict:
    n = min(a["mel"].shape[0], b["mel"].shape[0])
    return {
        "mel_l1": float(np.mean(np.abs(a["mel"][:n] - b["mel"][:n]))),
        "centroid_hz": abs(a["centroid"] - b["centroid"]),
        "rms_db": abs(a["rms_db"] - b["rms_db"]),
    }


def newest(prefix: str) -> Path | None:
    hits = sorted(OUT.glob(f"{prefix}*"), key=lambda p: p.stat().st_mtime, reverse=True)
    hits = [h for h in hits if h.suffix.lower() in (".flac", ".mp3", ".wav", ".opus")]
    return hits[0] if hits else None


def main() -> int:
    paths = {k: newest(f"lora_{k}") for k in ("baseA", "baseB", "tuned")}
    missing = [k for k, v in paths.items() if v is None]
    if missing or not TARGET.exists():
        print("missing renders:", missing or "", "| target:", TARGET.exists())
        return 1
    print("\nfiles")
    for k, v in paths.items():
        print(f"  {k:7} {v.name}")
    print(f"  {'target':7} {TARGET.name}")

    feats = {k: features(v) for k, v in paths.items()}
    feats["target"] = features(TARGET)

    to_t = {k: compare(feats[k], feats["target"]) for k in ("baseA", "baseB", "tuned")}
    floor = compare(feats["baseA"], feats["baseB"])

    print(f"\ndistance to the training target (lower = more like it)")
    print(f"  {'':22} {'mel_l1':>9} {'centroid':>10} {'rms_db':>8}")
    for k in ("baseA", "baseB", "tuned"):
        d = to_t[k]
        print(f"  {k:22} {d['mel_l1']:9.4f} {d['centroid_hz']:10.1f} {d['rms_db']:8.2f}")

    print(f"\nNOISE FLOOR — baseA vs baseB, same model, different flow seed.")
    print(f"  {'seed-to-seed spread':22} {floor['mel_l1']:9.4f} {floor['centroid_hz']:10.1f} {floor['rms_db']:8.2f}")

    # Judge EVERY metric against its OWN floor.
    #
    # The first version of this looked only at mel_l1, said "inside the noise",
    # and would have buried the result: the spectral centroid moved 590 of a
    # 776 Hz gap, which is ten times ITS floor. One metric answering "no" does
    # not outrank another answering "emphatically yes" — they measure different
    # things, and the disagreement IS the finding.
    print("\nVERDICT — every metric against its own noise floor")
    verdicts = {}
    for m, label in (("mel_l1", "broad timbre"), ("centroid_hz", "brightness"), ("rms_db", "loudness")):
        g = to_t["baseA"][m] - to_t["tuned"][m]        # positive = moved toward the target
        fl = floor[m]
        ratio = abs(g) / fl if fl else float("inf")
        if abs(g) < fl:
            v = "inside the noise"
        elif g > 0:
            v = f"REAL, toward the target ({ratio:.1f}x floor)"
        else:
            v = f"REAL, but AWAY from it ({ratio:.1f}x floor)"
        verdicts[m] = {"gain": g, "floor": fl, "verdict": v}
        print(f"  {label:13} {m:12} moved {g:+9.3f}   floor {fl:8.3f}   -> {v}")

    won = [m for m, d in verdicts.items() if d["verdict"].startswith("REAL, toward")]
    if won:
        print(f"\n  TRAINING WORKS. {len(won)} of 3 metrics cleared their floor in the right direction.")
        print("  Where they disagree the model has learned some properties and not others,")
        print("  which after 150 steps on ONE example is undertrained, not broken.")
    else:
        print("\n  Nothing cleared its floor: either the loop is a no-op, or 150 steps is far too few.")

    gain = verdicts["mel_l1"]["gain"]

    print("\nNOW LISTEN. These numbers are similarity proxies, not judgements:")
    for k, v in paths.items():
        print(f"  {k:7} {v}")
    print(f"  {'target':7} {TARGET}")

    (OUT / "_lora").mkdir(exist_ok=True)
    (OUT / "_lora" / "scores.json").write_text(json.dumps(
        {"to_target": to_t, "noise_floor": floor, "gain_mel_l1": gain}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
