#!/usr/bin/env python3
"""Does the DAV encoder generalise, or only handle audio the model itself made?

Every number so far came from aiplay_00043 — a MiniMax Music 3 generation, i.e.
exactly the distribution the autoencoder was trained to reconstruct. A user
uploading their own recording is a different case, and if reconstruction
collapses off-manifold then "audio reference" only works on our own output,
which would make it nearly pointless.

No real music on this box, so instead: signals the model would never produce.
White noise is the hardest possible case for any autoencoder (incompressible);
speech-like modulation, a sine sweep, heavy clipping and a dense synthetic
arrangement cover the rest of the space. If SI-SDR holds up across these, the
encoder is a general audio codec and real uploads are fine.
"""
from __future__ import annotations
import importlib.util, os, sys
import numpy as np, torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("de", os.path.join(HERE, "dav_encode.py"))
de = importlib.util.module_from_spec(spec); spec.loader.exec_module(de)
from safetensors.torch import load_file
from _audio_io import load_stereo

SR, SECS = 44100, 6.0
t = np.arange(int(SR * SECS)) / SR
rng = np.random.default_rng(0)


def stereo(x):
    x = x / (np.abs(x).max() + 1e-9) * 0.8
    return torch.from_numpy(np.stack([x, x]).astype(np.float32))[None]


def chord_bed():
    """Dense synthetic arrangement: triads, a bassline, hats. Music-like but
    machine-exact, which no generative model produces."""
    out = np.zeros_like(t)
    for i, root in enumerate([110, 146.83, 164.81, 130.81]):
        seg = (t >= i * 1.5) & (t < (i + 1) * 1.5)
        for h, amp in [(1, 1.0), (1.26, .7), (1.5, .7), (2, .4), (3, .2)]:
            out[seg] += amp * np.sin(2 * np.pi * root * h * t[seg])
        out[seg] += 0.6 * np.sin(2 * np.pi * root / 2 * t[seg])
    hat = (np.sin(2 * np.pi * 8 * t) > 0.9) * rng.standard_normal(len(t)) * 0.3
    return out * 0.25 + hat


CASES = {
    "white noise (worst case)": rng.standard_normal(len(t)),
    "sine sweep 40Hz-16kHz": np.sin(2 * np.pi * (40 * (400 ** (t / SECS)) * SECS / np.log(400))),
    "speech-like AM noise": rng.standard_normal(len(t)) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) * np.exp(-((t % 0.6) * 6)),
    "synthetic arrangement": chord_bed(),
    "hard-clipped square": np.clip(np.sin(2 * np.pi * 220 * t) * 8, -1, 1),
    "near-silence + transients": (np.abs(t % 1.0) < 0.002).astype(float) * 1.0,
}

device = "cuda" if torch.cuda.is_available() else "cpu"
m = de.DAV(); m.load_state_dict(load_file(de.CKPT), strict=False); m = m.to(device).eval()

print(f"DAV reconstruction across signal types  ({SECS:.0f}s each, {device})\n")
print(f"{'signal':<28}{'SI-SDR':>9}")
print("-" * 38)
res = {}
for name, sig in CASES.items():
    w = stereo(sig).to(device)
    z = m.encode(w)
    r = m.decode(z)
    a = w[0, 0].cpu().numpy(); b = r[0, 0].cpu().numpy()
    v = de.si_sdr(a, b); res[name] = v
    print(f"{name:<28}{v:>8.2f} dB")

ref = os.path.join(r"D:/AI/aiplay-studio-bench/ComfyUI/output", "aiplay_00043.flac")
if os.path.exists(ref):
    w, sr = load_stereo(ref, secs=SECS)
    w = w.to(device)
    z = m.encode(w); r = m.decode(z)
    v = de.si_sdr(w[0, 0].cpu().numpy(), r[0, 0].cpu().numpy())
    print(f"{'model-generated music':<28}{v:>8.2f} dB   <- the in-distribution case")

print("-" * 38)
music_like = res["synthetic arrangement"]
print(f"\nsynthetic arrangement is the closest proxy for a real upload: {music_like:.2f} dB")
print("if that is within a few dB of the in-distribution number, the encoder")
print("is a general codec and user uploads will reconstruct fine.")
print("white noise is expected to be the WORST — it is incompressible, and a low")
print("score there is not a defect.")
