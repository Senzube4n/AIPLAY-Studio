#!/usr/bin/env python3
"""A fairer generality test than pure synthesis.

The previous test used machine-exact sine stacks, which are further off-manifold
than real music actually is. A real user upload differs from our own output in
mundane ways: it is lossy-compressed, mastered differently, recorded in a room,
in a different key, possibly mono or resampled. So degrade a known-good
generation along exactly those axes and re-measure.

This is still a proxy — there is no real music on this box — but it brackets the
answer from the optimistic side, where the pure-synthesis test bracketed it from
the pessimistic side.
"""
from __future__ import annotations
import glob, importlib.util, os, subprocess, sys, tempfile
import numpy as np, torch, torchaudio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("de", os.path.join(HERE, "dav_encode.py"))
de = importlib.util.module_from_spec(spec); spec.loader.exec_module(de)
from safetensors.torch import load_file
from _audio_io import load_stereo

OUT = r"D:/AI/aiplay-studio-bench/ComfyUI/output"
SRC = os.path.join(OUT, "aiplay_00043.flac")
SECS = 6.0
device = "cuda" if torch.cuda.is_available() else "cpu"
m = de.DAV(); m.load_state_dict(load_file(de.CKPT), strict=False); m = m.to(device).eval()

base, sr = load_stereo(SRC, secs=SECS)


def score(w):
    w = w.to(device)
    r = m.decode(m.encode(w))
    return de.si_sdr(w[0, 0].cpu().numpy(), r[0, 0].cpu().numpy())


def mp3(w, kbps):
    """Round-trip through a real lossy encoder — most uploads have been here.
    Raw PCM straight into ffmpeg: torchaudio.save() needs torchcodec, which is
    not installed in this venv and is not worth adding for one test."""
    d = tempfile.mkdtemp()
    b = os.path.join(d, "b.mp3")
    pcm = w[0].T.contiguous().numpy().astype("<f4").tobytes()   # interleaved f32le
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "pipe:0",
                    "-b:a", f"{kbps}k", b], input=pcm, check=True)
    out, _ = load_stereo(b, secs=SECS)
    return out


def reverb(w, decay=0.35, taps=6):
    x = w.clone()
    for i in range(1, taps):
        d = int(sr * 0.037 * i)
        x[..., d:] += w[..., :-d] * (decay ** i)
    return x / x.abs().max() * 0.9


cases = {
    "unmodified generation": base,
    "MP3 128 kbps round trip": mp3(base, 128),
    "MP3 64 kbps round trip": mp3(base, 64),
    "pitch shifted +3 semitones": torchaudio.functional.pitch_shift(base[0], sr, 3)[None],
    "room reverb added": reverb(base),
    "collapsed to mono": base.mean(1, keepdim=True).repeat(1, 2, 1),
    "resampled 22k and back": torchaudio.functional.resample(
        torchaudio.functional.resample(base[0], sr, 22050), 22050, sr)[None],
    "quiet (-24 dB)": base * 0.063,
    "loudness-war clipped": (base * 4).clamp(-1, 1),
}

stems = sorted(glob.glob(os.path.join(OUT, ".stems", "**", "*.wav"), recursive=True))
for p in stems[:3]:
    w, s = load_stereo(p, secs=SECS)
    if s == sr:
        cases[f"demucs stem: {os.path.basename(p)[:-4]}"] = w

print(f"DAV reconstruction under realistic upload-style degradation ({SECS:.0f}s, {device})\n")
print(f"{'variant':<32}{'SI-SDR':>9}")
print("-" * 42)
for name, w in cases.items():
    try:
        print(f"{name:<32}{score(w):>8.2f} dB")
    except Exception as exc:
        print(f"{name:<32}{'  skipped':>9}  ({type(exc).__name__})")
print("-" * 42)
print("\nThese all START as model-generated audio, so they bound the OPTIMISTIC side.")
print("The pure-synthesis test bounded the pessimistic side at 6.6 dB.")
print("A real upload sits between; only real music settles it.")
