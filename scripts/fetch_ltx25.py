#!/usr/bin/env python3
"""Fetch the LTX 2.5 weights for a 16 GB card.

⚠ THE REPO IS GATED. Lightricks/LTX-2.5 returns 401 to an unauthenticated request,
so you must accept the LTX-2.x Community License on the model page and then run:

    huggingface-cli login

That stores a token locally. This script reads it through huggingface_hub and
never handles the value itself — nothing here prints, logs or copies it.

WHY THESE FIVE FILES. int8-convrot for the DiT and the text encoder because
`asym_w4a8_int8` and `convrot_w4a4` are NATIVE on this architecture while nvfp4 is
emulated below compute 10 — the same reasoning that picked H3's quantisation. The
nvfp4 DiT is 2.8 GB smaller and would be slower.

The spatial upscaler is not optional: LTX 2.5's speed comes from sampling at low
resolution, upscaling the LATENT, then re-sampling only a few steps at full size.
Without it there is no second pass and no speed advantage.
"""
from __future__ import annotations
import os, sys

REPO = "Lightricks/LTX-2.5"
COMFY = os.environ.get("AIPLAY_COMFY", r"D:\AI\aiplay-studio-bench\ComfyUI")

# (path in repo, subdirectory under ComfyUI/models, expected bytes)
FILES = [
    ("diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
     "diffusion_models", 21_504_034_224),
    ("text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
     "text_encoders", 15_372_969_374),
    ("vae/ltx-2.5-video-vae-conv-bf16.safetensors", "vae", 1_452_269_922),
    ("vae/ltx-2.5-audio-vae-bf16.safetensors", "vae", 364_866_540),
    ("latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
     "latent_upscale_models", 995_778_752),
]


def main() -> int:
    from huggingface_hub import get_token, hf_hub_download

    if not get_token():
        print("No HuggingFace token found.\n")
        print("  1. Accept the licence at https://huggingface.co/Lightricks/LTX-2.5")
        print("  2. Run:  huggingface-cli login")
        print("  3. Run this script again.\n")
        return 1

    total = sum(f[2] for f in FILES)
    print(f"{len(FILES)} files, {total/1e9:.2f} GB total\n")

    for rel, sub, size in FILES:
        dest_dir = os.path.join(COMFY, "models", sub)
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, os.path.basename(rel))
        if os.path.exists(dest) and os.path.getsize(dest) == size:
            print(f"  have  {os.path.basename(rel)[:58]}")
            continue
        print(f"  get   {os.path.basename(rel)[:58]}  ({size/1e9:.2f} GB)")
        try:
            # Resumes automatically, and verifies against the hub's own hash.
            p = hf_hub_download(REPO, rel, local_dir=os.path.join(COMFY, "models", "_ltx_tmp"))
        except Exception as exc:
            msg = str(exc)
            if "401" in msg or "gated" in msg.lower() or "restricted" in msg.lower():
                print(f"\n  ✗ Access denied. Accept the licence at")
                print(f"    https://huggingface.co/{REPO}  then run huggingface-cli login again.\n")
                return 1
            print(f"\n  ✗ {type(exc).__name__}: {msg[:200]}\n")
            return 1
        os.replace(p, dest)
        got = os.path.getsize(dest)
        print(f"        -> {sub}/  {'ok' if got == size else f'⚠ {got:,} bytes, expected {size:,}'}")

    print("\nDone. Restart Studio so ComfyUI rescans its model folders.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
