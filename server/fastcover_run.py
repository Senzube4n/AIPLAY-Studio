#!/usr/bin/env python3
"""
FAST COVERS: one song cover from Supra2-IMG, on the processor.

Spawned by server/fastcover.js in the Python that Settings > Experimental
builds (server/setup/venv.js, recipe "covers": CPU PyTorch, transformers,
diffusers). Everything is read from the three local folders the Models row
"fastCover" downloads, pinned and hashed; nothing is fetched here
(HF_HUB_OFFLINE), and the checkpoint is a pickle, so it is loaded with
weights_only=True: tensors and plain containers, never code.

The model classes below are SupraLabs' own, from inference.py in
https://huggingface.co/SupraLabs/Supra2-IMG (revision 10dec6e, Apache-2.0),
unchanged apart from comments. Sampling is theirs too: Euler steps along the
flow with classifier-free guidance.

Prints one line `FASTCOVER_RESULT_JSON: {...}` on success; exit 2 on bad
arguments or missing files, 3 on a failure while drawing.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("HIP_VISIBLE_DEVICES", "")

RESULT_MARKER = "FASTCOVER_RESULT_JSON:"

# Architecture constants (must match the trained checkpoint).
IMG_SIZE = 256
LATENT_SIZE = 32
LATENT_CH = 4
PATCH = 2
NUM_TOKENS = (LATENT_SIZE // PATCH) ** 2
D_MODEL = 576
DEPTH = 14
N_HEADS = 9
MLP_RATIO = 4.0
D_CTX = 768
MAX_CTX_LEN = 128
VAE_SCALE = 0.18215


def build_model():
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    def modulate(x, shift, scale):
        return x * (1 + scale.unsqueeze(1)) + shift.unsqueeze(1)

    class TimestepEmbedder(nn.Module):
        def __init__(self, hidden_size, freq_dim=256):
            super().__init__()
            self.freq_dim = freq_dim
            self.mlp = nn.Sequential(nn.Linear(freq_dim, hidden_size), nn.SiLU(), nn.Linear(hidden_size, hidden_size))

        def _sinusoidal(self, t):
            half = self.freq_dim // 2
            freqs = torch.exp(-math.log(10000.0) * torch.arange(half, device=t.device) / half)
            args = t[:, None].float() * freqs[None] * 1000.0
            emb = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
            if self.freq_dim % 2:
                emb = F.pad(emb, (0, 1))
            return emb

        def forward(self, t):
            return self.mlp(self._sinusoidal(t))

    class Attention(nn.Module):
        def __init__(self, dim, n_heads, ctx_dim=None):
            super().__init__()
            self.n_heads = n_heads
            self.head_dim = dim // n_heads
            self.is_self = ctx_dim is None
            if self.is_self:
                self.qkv = nn.Linear(dim, dim * 3, bias=True)
            else:
                self.q = nn.Linear(dim, dim, bias=True)
                self.kv = nn.Linear(ctx_dim, dim * 2, bias=True)
            self.proj = nn.Linear(dim, dim, bias=True)

        def forward(self, x, ctx=None, ctx_mask=None):
            B, N, C = x.shape
            if self.is_self:
                qkv = self.qkv(x).view(B, N, 3, self.n_heads, self.head_dim)
                q, k, v = (qkv[:, :, i].transpose(1, 2) for i in range(3))
            else:
                M = ctx.shape[1]
                q = self.q(x).view(B, N, self.n_heads, self.head_dim).transpose(1, 2)
                kv = self.kv(ctx).view(B, M, 2, self.n_heads, self.head_dim)
                k, v = kv[:, :, 0].transpose(1, 2), kv[:, :, 1].transpose(1, 2)
            attn_mask = ctx_mask.bool()[:, None, None, :] if ctx_mask is not None else None
            out = F.scaled_dot_product_attention(q, k, v, attn_mask=attn_mask)
            return self.proj(out.transpose(1, 2).reshape(B, N, C))

    class DiTBlock(nn.Module):
        def __init__(self, dim, n_heads, ctx_dim, mlp_ratio):
            super().__init__()
            self.norm1 = nn.LayerNorm(dim, elementwise_affine=False, eps=1e-6)
            self.self_attn = Attention(dim, n_heads)
            self.norm_ca = nn.LayerNorm(dim, elementwise_affine=False, eps=1e-6)
            self.cross_attn = Attention(dim, n_heads, ctx_dim=dim)
            self.norm2 = nn.LayerNorm(dim, elementwise_affine=False, eps=1e-6)
            hidden = int(dim * mlp_ratio)
            self.mlp = nn.Sequential(nn.Linear(dim, hidden), nn.GELU(approximate="tanh"), nn.Linear(hidden, dim))
            self.adaln = nn.Sequential(nn.SiLU(), nn.Linear(dim, 6 * dim, bias=True))

        def forward(self, x, c, ctx, ctx_mask):
            shift_sa, scale_sa, gate_sa, shift_mlp, scale_mlp, gate_mlp = self.adaln(c).chunk(6, dim=1)
            x = x + gate_sa.unsqueeze(1) * self.self_attn(modulate(self.norm1(x), shift_sa, scale_sa))
            x = x + self.cross_attn(self.norm_ca(x), ctx=ctx, ctx_mask=ctx_mask)
            x = x + gate_mlp.unsqueeze(1) * self.mlp(modulate(self.norm2(x), shift_mlp, scale_mlp))
            return x

    class FinalLayer(nn.Module):
        def __init__(self, dim, out_ch):
            super().__init__()
            self.norm = nn.LayerNorm(dim, elementwise_affine=False, eps=1e-6)
            self.linear = nn.Linear(dim, out_ch, bias=True)
            self.adaln = nn.Sequential(nn.SiLU(), nn.Linear(dim, 2 * dim, bias=True))

        def forward(self, x, c):
            shift, scale = self.adaln(c).chunk(2, dim=1)
            return self.linear(modulate(self.norm(x), shift, scale))

    class SupraDiT(nn.Module):
        def __init__(self):
            super().__init__()
            self.patch = PATCH
            self.x_embed = nn.Linear(LATENT_CH * PATCH * PATCH, D_MODEL)
            self.pos_embed = nn.Parameter(torch.zeros(1, NUM_TOKENS, D_MODEL))
            self.t_embed = TimestepEmbedder(D_MODEL)
            self.ctx_proj = nn.Linear(D_CTX, D_MODEL)
            self.blocks = nn.ModuleList([DiTBlock(D_MODEL, N_HEADS, D_MODEL, MLP_RATIO) for _ in range(DEPTH)])
            self.final = FinalLayer(D_MODEL, LATENT_CH * PATCH * PATCH)

        def forward(self, z, t, ctx, ctx_mask=None):
            B, C, H, W = z.shape
            P = self.patch
            h, w = H // P, W // P
            x = z.view(B, C, h, P, w, P).permute(0, 2, 4, 1, 3, 5).reshape(B, h * w, C * P * P)
            x = self.x_embed(x) + self.pos_embed
            c = self.t_embed(t)
            ctx = self.ctx_proj(ctx)
            for blk in self.blocks:
                x = blk(x, c, ctx, ctx_mask)
            x = self.final(x, c)
            return x.view(B, h, w, C, P, P).permute(0, 3, 1, 4, 2, 5).reshape(B, C, H, W)

    return SupraDiT()


def draw(a):
    import torch
    from PIL import Image
    from transformers import AutoTokenizer, T5EncoderModel
    from diffusers import AutoencoderKL

    torch.set_num_threads(max(1, a.threads))
    t0 = time.perf_counter()
    state = torch.load(os.path.join(a.models, "supra2-img", "model_final_ema.pt"), map_location="cpu", weights_only=True)
    cfg = state.get("config", {}) if isinstance(state, dict) else {}
    if isinstance(cfg, dict) and cfg.get("patch", PATCH) != PATCH:
        raise SystemExit(2)
    weights = state["ema"] if "ema" in state else state.get("model", state)
    model = build_model().eval()
    model.load_state_dict({k: v.float() for k, v in weights.items()}, strict=True)
    tok = AutoTokenizer.from_pretrained(os.path.join(a.models, "flan-t5-base"))
    text = T5EncoderModel.from_pretrained(os.path.join(a.models, "flan-t5-base")).eval()
    vae = AutoencoderKL.from_pretrained(os.path.join(a.models, "sd-vae-ft-mse")).eval()
    loaded = time.perf_counter() - t0

    ctx_len = int(cfg.get("ctx_len", MAX_CTX_LEN)) if isinstance(cfg, dict) else MAX_CTX_LEN
    t1 = time.perf_counter()
    with torch.no_grad():
        tk = tok([a.prompt], padding="max_length", truncation=True, max_length=ctx_len, return_tensors="pt")
        ctx, cmask = text(**tk).last_hidden_state.float(), tk["attention_mask"].float()
        if isinstance(cfg, dict) and "uncond_text" in cfg:
            uctx, umask = cfg["uncond_text"].float().unsqueeze(0), cfg["uncond_mask"].float().unsqueeze(0)
        else:
            ut = tok([""], padding="max_length", truncation=True, max_length=ctx_len, return_tensors="pt")
            uctx, umask = text(**ut).last_hidden_state.float(), ut["attention_mask"].float()
        gen = torch.Generator().manual_seed(a.seed)
        z = torch.randn(1, LATENT_CH, LATENT_SIZE, LATENT_SIZE, generator=gen)
        both_ctx, both_mask = torch.cat([ctx, uctx]), torch.cat([cmask, umask])
        for i in range(a.steps):
            t = torch.full((2,), i / a.steps)
            v_cond, v_uncond = model(torch.cat([z, z]), t, both_ctx, both_mask).chunk(2)
            z = z + (v_uncond + a.cfg * (v_cond - v_uncond)) / a.steps
        img = ((vae.decode(z / VAE_SCALE).sample.clamp(-1, 1) + 1) / 2)[0]
    drew = time.perf_counter() - t1

    pic = Image.fromarray((img.permute(1, 2, 0) * 255).round().byte().numpy())
    # The model draws 256 px. The cover is scaled up to the size covers are
    # stored at, and the thumbnail down (or kept) to the thumbnail size.
    pic.resize((a.size, a.size), Image.LANCZOS).save(a.out)
    pic.resize((a.thumb_size, a.thumb_size), Image.LANCZOS).save(a.thumb)
    return {"out": a.out, "thumb": a.thumb, "native": IMG_SIZE, "size": a.size, "steps": a.steps,
            "cfg": a.cfg, "seed": a.seed, "loadSeconds": round(loaded, 2), "drawSeconds": round(drew, 2)}


def main():
    p = argparse.ArgumentParser(description="Studio fast covers (Supra2-IMG, processor only)")
    p.add_argument("--models", required=True, help="the folder holding supra2-img, flan-t5-base and sd-vae-ft-mse")
    p.add_argument("--prompt", required=True)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--steps", type=int, default=25)
    p.add_argument("--cfg", type=float, default=3.0)
    p.add_argument("--size", type=int, default=1024)
    p.add_argument("--thumb-size", type=int, default=256)
    p.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    p.add_argument("--out", required=True)
    p.add_argument("--thumb", required=True)
    a = p.parse_args()
    for sub in ("supra2-img/model_final_ema.pt", "flan-t5-base/model.safetensors", "sd-vae-ft-mse/diffusion_pytorch_model.safetensors"):
        if not os.path.isfile(os.path.join(a.models, sub)):
            print(f"missing {sub} in {a.models}", file=sys.stderr)
            sys.exit(2)
    if not (1 <= a.steps <= 100 and 64 <= a.size <= 2048 and 32 <= a.thumb_size <= 1024):
        print("steps, size or thumb size out of range", file=sys.stderr)
        sys.exit(2)
    a.seed = a.seed % (2 ** 63)
    try:
        result = draw(a)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - the one line the caller reads
        print(f"fast cover failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(3)
    print(RESULT_MARKER + " " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
