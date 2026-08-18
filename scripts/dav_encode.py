#!/usr/bin/env python3
"""Encode audio to a MiniMax Music 3 flow latent — the step ComfyUI refuses.

ComfyUI ships the DAV DECODER only and `comfy/sd.py:534` hard-raises
"MiniMax Music3 DAV cannot encode audio". But the encoder weights exist
(SimpleTuner/MiniMax-Music-3-Encoder, 119 encoder tensors, cached here), and the
architecture is Apache-2.0 (MiniMax + HuggingFace header on SimpleTuner's
vocoder.py). This is that file's model definition with the diffusers base classes
stripped — `ModelMixin`/`ConfigMixin` are only there for `from_pretrained`, and
installing diffusers into either venv on this box breaks something.

WHY THIS MATTERS
----------------
`EmptyMiniMaxMusic3LatentAudio` produces `(batch, 128, T)` with
`downscale_ratio_temporal: 512`. The DAV encoder produces EXACTLY that: 64 latent
dims per audio channel x 2 channels = 128, downsampled 2*4*8*8 = 512. So an
encoded latent is drop-in substitutable for the empty one the sampler normally
starts from — which is what makes audio-reference img2img possible without any
tokenizer and without training.

SELF-VALIDATING, WITH A CAVEAT LEARNED THE HARD WAY. The script round-trips
encode -> decode and reports SI-SDR. But a round trip only proves encoder and
decoder AGREE — it says nothing about whether the input was loaded correctly.
A stereo de-interleaving bug once scored 14 dB here while feeding the encoder
double-rate garbage. So the check below also verifies the decoded length against
the container duration, which is what actually caught it.
"""
from __future__ import annotations

import glob
import json
import math
import os
import sys

import numpy as np
import torch
import torch.nn as nn
from torch.nn.utils import weight_norm

CKPT = glob.glob(r"C:\Users\chesy\.cache\huggingface\hub\models--SimpleTuner--MiniMax-Music-3-Encoder\snapshots\*\audio_vae\diffusion_pytorch_model.safetensors")[0]


class Snake1d(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.alpha = nn.Parameter(torch.ones(1, channels, 1))

    def forward(self, x):
        return x + (self.alpha + 1e-9).reciprocal() * torch.sin(self.alpha * x).pow(2)


class ResidualUnit(nn.Module):
    def __init__(self, dim, dilation):
        super().__init__()
        pad = 3 * dilation
        self.block = nn.Sequential(
            Snake1d(dim),
            weight_norm(nn.Conv1d(dim, dim, 7, dilation=dilation, padding=pad)),
            Snake1d(dim),
            weight_norm(nn.Conv1d(dim, dim, 1)),
        )

    def forward(self, x):
        r = self.block(x)
        if r.shape[-1] != x.shape[-1]:
            p = (x.shape[-1] - r.shape[-1]) // 2
            x = x[..., p: x.shape[-1] - p]
        return x + r


class EncoderBlock(nn.Module):
    def __init__(self, dim, stride):
        super().__init__()
        self.block = nn.Sequential(
            ResidualUnit(dim // 2, 1), ResidualUnit(dim // 2, 3), ResidualUnit(dim // 2, 9),
            Snake1d(dim // 2),
            weight_norm(nn.Conv1d(dim // 2, dim, 2 * stride, stride=stride, padding=math.ceil(stride / 2))),
        )

    def forward(self, x):
        return self.block(x)


class Encoder(nn.Module):
    def __init__(self, encoder_dim=64, encoder_rates=(2, 4, 8, 8), latent_dim=1024):
        super().__init__()
        blk = [weight_norm(nn.Conv1d(1, encoder_dim, 7, padding=3))]
        d = encoder_dim
        for s in encoder_rates:
            d *= 2
            blk.append(EncoderBlock(d, stride=s))
        blk += [Snake1d(d), weight_norm(nn.Conv1d(d, latent_dim, 3, padding=1))]
        self.block = nn.Sequential(*blk)

    def forward(self, x):
        return self.block(x)


class DecoderBlock(nn.Module):
    def __init__(self, ic, oc, stride):
        super().__init__()
        self.block = nn.Sequential(
            Snake1d(ic),
            weight_norm(nn.ConvTranspose1d(ic, oc, 2 * stride, stride=stride, padding=math.ceil(stride / 2))),
            ResidualUnit(oc, 1), ResidualUnit(oc, 3), ResidualUnit(oc, 9),
        )

    def forward(self, x):
        return self.block(x)


class Decoder(nn.Module):
    def __init__(self, input_dim=1024, hidden_dim=1536, upsampling_ratios=(8, 8, 4, 2)):
        super().__init__()
        layers = [weight_norm(nn.Conv1d(input_dim, hidden_dim, 7, padding=3))]
        out = hidden_dim
        for i, s in enumerate(upsampling_ratios):
            ic = hidden_dim // (2 ** i)
            out = hidden_dim // (2 ** (i + 1))
            layers.append(DecoderBlock(ic, out, stride=s))
        layers += [Snake1d(out), weight_norm(nn.Conv1d(out, 1, 7, padding=3)), nn.Tanh()]
        self.model = nn.Sequential(*layers)

    def forward(self, x):
        return self.model(x)


class DAV(nn.Module):
    """latent_channels 128 = channel_latent_channels 64 x 2 AUDIO CHANNELS.
    Not mean+logvar, as the tensor count first suggests — encode() uses mean_proj
    alone and treats L/R as two independent mono streams."""
    def __init__(self):
        super().__init__()
        self.hop_length = 512
        self.latent_channels = 128
        self.channel_latent_channels = 64
        self.encoder = Encoder()
        self.mean_proj = nn.Conv1d(1024, 64, 1)
        self.logs_proj = nn.Conv1d(1024, 64, 1)
        self.dec_in_proj = nn.Conv1d(64, 1024, 1)
        self.decoder = Decoder()

    def _prep(self, w):
        if w.ndim == 1: w = w.unsqueeze(0).unsqueeze(0)
        elif w.ndim == 2: w = w.unsqueeze(0)
        if w.shape[1] == 1: w = w.repeat(1, 2, 1)
        rem = w.shape[-1] % self.hop_length
        if rem:
            w = torch.nn.functional.pad(w, (0, self.hop_length - rem))
        return w

    @torch.no_grad()
    def encode(self, w):
        w = self._prep(w)
        b = w.shape[0]
        h = self.encoder(w.reshape(b * 2, 1, -1))
        return self.mean_proj(h).reshape(b, self.latent_channels, -1)

    @torch.no_grad()
    def decode(self, z):
        b, _, t = z.shape
        h = z.reshape(b * 2, self.channel_latent_channels, t)
        return self.decoder(self.dec_in_proj(h)).reshape(b, 2, -1)


def si_sdr(ref, est):
    ref = ref - ref.mean(); est = est - est.mean()
    n = min(len(ref), len(est)); ref, est = ref[:n], est[:n]
    a = np.dot(est, ref) / (np.dot(ref, ref) + 1e-12)
    proj = a * ref
    noise = est - proj
    return 10 * np.log10((np.dot(proj, proj) + 1e-12) / (np.dot(noise, noise) + 1e-12))


def load_audio(path, device):
    # Via _audio_io: an earlier hand-rolled version here read PACKED stereo as
    # mono, so the encoder was fed interleaved samples at double rate. It still
    # round-tripped at 14 dB — encoder and decoder are consistent no matter what
    # you feed them — so the reconstruction number did NOT catch it. Only
    # decoding the latent and comparing against the real file did.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from _audio_io import load_stereo
    w, sr = load_stereo(path)
    return w.to(device), sr


def main() -> int:
    """CLI for a human, and a service for the server.

    `--json` makes the LAST line of stdout a single JSON object and sends every
    human-readable line to stderr. The server parses that one line, so adding
    another print here can never break it — which is exactly how the lyric
    aligner broke once, when a progress bar wrote \\r into the middle of its
    payload.
    """
    import argparse
    ap = argparse.ArgumentParser(description="Encode audio to a MiniMax Music 3 flow latent.")
    ap.add_argument("src", nargs="?", default=r"D:\AI\aiplay-studio-bench\ComfyUI\output\aiplay_00043.flac")
    ap.add_argument("--out-dir", default=r"D:\AI\aiplay-studio-bench\ComfyUI\input",
                    help="where the ComfyUI .latent is written; LoadLatent reads names relative to it")
    ap.add_argument("--name", default=None, help="basename for the .latent (default: the source's)")
    ap.add_argument("--seconds", type=float, default=float(os.environ.get("DAV_SECONDS", "0") or 0),
                    help="encode only the first N seconds (0 = all)")
    ap.add_argument("--npy", action="store_true", help="also write the raw .npy next to the source")
    ap.add_argument("--json", action="store_true", help="emit one JSON line on stdout; prose to stderr")
    a = ap.parse_args()

    # With --json, prose must not land on stdout or it corrupts the payload.
    log = (lambda *x: print(*x, file=sys.stderr)) if a.json else print
    device = "cuda" if torch.cuda.is_available() else "cpu"

    from safetensors.torch import load_file
    sd = load_file(CKPT)
    m = DAV()
    inc = m.load_state_dict(sd, strict=False)
    miss = list(inc.missing_keys)
    unexp = [k for k in inc.unexpected_keys if not k.startswith("flow.")]
    log(f"state dict: {len(miss)} missing, {len(unexp)} unexpected (flow.* ignored)")
    if miss[:3]: log("  missing:", miss[:3])
    if unexp[:3]: log("  unexpected:", unexp[:3])
    m = m.to(device).eval()

    wav, sr = load_audio(a.src, device)
    full = wav.shape[-1] / sr
    # A 2-minute stereo decode allocates >4 GB and OOM'd on a card already
    # holding the music stack — and an OOM mid-decode shows up as a bad SI-SDR,
    # i.e. as "the encoder is wrong". Trimming isolates that.
    if a.seconds:
        wav = wav[..., : int(a.seconds * sr)]
    log(f"\ninput : {os.path.basename(a.src)}  {tuple(wav.shape)} @ {sr} Hz  "
        f"({wav.shape[-1]/sr:.2f}s of {full:.2f}s)")

    z = m.encode(wav)
    log(f"latent: {tuple(z.shape)}   <- sampler wants (B, 128, T)")
    log(f"        rate {z.shape[-1] / (wav.shape[-1]/sr):.2f} frames/s (expect {sr/512:.2f})")

    # THE self-check. If this reconstructs, the whole assembly is right.
    rec = m.decode(z)
    sdr = si_sdr(wav[0, 0].cpu().numpy(), rec[0, 0].cpu().numpy())
    log(f"\nround-trip SI-SDR: {sdr:.2f} dB")
    log("  >15 dB = encoder is correct.  ~0 dB = something is wrong.")

    if a.npy:
        np.save(os.path.splitext(a.src)[0] + ".latent.npy", z.cpu().numpy())

    # ComfyUI's own .latent format so the STOCK LoadLatent node can read it.
    # `latent_format_version_0` must be present or LoadLatent rescales by 1/0.18215.
    from safetensors.torch import save_file
    os.makedirs(a.out_dir, exist_ok=True)
    stem = a.name or os.path.splitext(os.path.basename(a.src))[0]
    lat = os.path.join(a.out_dir, stem + ".latent")
    save_file({"latent_tensor": z.cpu().contiguous(),
               "latent_format_version_0": torch.tensor([])}, lat)
    log(f"saved ComfyUI latent -> {lat}")

    if a.json:
        print(json.dumps({
            "ok": True,
            # RELATIVE, because that is what LoadLatent's `latent` input wants.
            "latent": os.path.basename(lat),
            "frames": int(z.shape[-1]),
            "seconds": round(z.shape[-1] / (sr / 512), 3),
            "sourceSeconds": round(full, 3),
            "sampleRate": sr,
            # Carried through so the UI can warn when a reference reconstructs
            # badly, rather than letting it fail silently as a bad-sounding song.
            "siSdrDb": round(float(sdr), 2),
        }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
