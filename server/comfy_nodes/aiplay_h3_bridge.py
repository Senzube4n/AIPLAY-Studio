"""A conditioning bridge for MiniMax H3 — AIPLAY Studio's own node, 2026-09-17.

WHAT IT IS
----------
A small MLP (5120 -> hidden -> hidden -> 5120, SiLU) that rewrites H3's text
conditioning before the video transformer and is blended back at a chosen
strength. Two published adapters share this exact layout and math:

  * speach1sdef178 / MiniMax-H3-Semantic-Bridge  (v1, 11 MB, hidden 256):
    composition, spatial relations, counting, materials, reflection, occlusion.
  * JOKER141 / BUNNY_H3_Conditioning_Bridge      (V1, 22 MB, hidden 512):
    the same recipe retrained toward action logic — who does what to whom.

Both ship a custom-node package; this file re-implements the node so the
engine stays stock (no third-party package on the node path) and so the
math is written down HERE, where it can be read. Verbatim from BUNNY's
nodes.py (MIT-licensed code; the adapters are under the MiniMax H3 Community
License): RMS-normalise the conditioning, run the MLP, match its magnitude
back to the original per token, blend `h + alpha * (projected - h)`.

WHAT IT IS NOT
--------------
Not a LoRA, not a prompt rewrite, and not validated on the reference path —
the original card reports degraded singing and lip-sync on Ref2VA. The
Studio's graph wires it on both paths and leaves the choice to the setting,
with that warning beside it.

Adapters live in <models>/conditioning_bridges/ (registered below as a
ComfyUI model folder, so the engine's extra-model-paths config covers it).
"""
import os

import torch
import torch.nn as nn

import folder_paths
from safetensors.torch import load_file

FOLDER = "conditioning_bridges"
_folder = os.path.join(folder_paths.models_dir, FOLDER)
if FOLDER not in folder_paths.folder_names_and_paths:
    folder_paths.folder_names_and_paths[FOLDER] = ([_folder], {".safetensors"})
else:
    paths, exts = folder_paths.folder_names_and_paths[FOLDER]
    if _folder not in paths:
        paths.append(_folder)

_CACHE = {}


class _BridgeMLP(nn.Module):
    def __init__(self, input_dim, hidden_dim, output_dim):
        super().__init__()
        self.fc1 = nn.Linear(input_dim, hidden_dim, bias=True)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim, bias=True)
        self.fc3 = nn.Linear(hidden_dim, output_dim, bias=True)
        self.act = nn.SiLU()

    def forward(self, x):
        x = self.act(self.fc1(x))
        x = self.act(self.fc2(x))
        return self.fc3(x)


def _dims(weights):
    required = ["fc1.weight", "fc1.bias", "fc2.weight", "fc2.bias", "fc3.weight", "fc3.bias"]
    missing = [k for k in required if k not in weights]
    if missing:
        raise RuntimeError(f"not a conditioning bridge: missing {missing}")
    w1, w2, w3 = weights["fc1.weight"], weights["fc2.weight"], weights["fc3.weight"]
    if w1.ndim != 2 or w2.ndim != 2 or w3.ndim != 2:
        raise RuntimeError("not a conditioning bridge: the layers are not matrices")
    hidden, input_dim = w1.shape
    if w2.shape != (hidden, hidden) or w3.shape[1] != hidden:
        raise RuntimeError(f"not a conditioning bridge: hidden dims disagree ({tuple(w1.shape)}, {tuple(w2.shape)}, {tuple(w3.shape)})")
    return int(input_dim), int(hidden), int(w3.shape[0])


def _load(name, device, dtype):
    key = (name, str(device), str(dtype))
    hit = _CACHE.get(key)
    if hit is not None:
        return hit
    path = folder_paths.get_full_path(FOLDER, name)
    if not path:
        raise RuntimeError(f"bridge adapter not found: {name} (looked in models/{FOLDER})")
    weights = load_file(path, device="cpu")
    i, h, o = _dims(weights)
    model = _BridgeMLP(i, h, o)
    model.load_state_dict(weights, strict=True)
    model.eval().to(device=device, dtype=dtype)
    for p in model.parameters():
        p.requires_grad_(False)
    hit = {"model": model, "hidden": h, "in": i, "out": o}
    _CACHE.clear()          # one adapter resident at a time; they are tiny anyway
    _CACHE[key] = hit
    return hit


def _rms_normalize(x):
    dt = x.dtype
    xf = x.float()
    rms = torch.sqrt(xf.pow(2).mean(dim=-1, keepdim=True) + 1e-6)
    return (xf / rms).to(dtype=dt)


def _match_per_token(source, target):
    dt = source.dtype
    sf, tf = source.float(), target.float()
    s = torch.sqrt(sf.pow(2).mean(dim=-1, keepdim=True) + 1e-8)
    t = torch.sqrt(tf.pow(2).mean(dim=-1, keepdim=True) + 1e-8)
    return (sf * (t / s)).to(dtype=dt)


def _match_global(source, target):
    dt = source.dtype
    sf, tf = source.float(), target.float()
    s = torch.sqrt(sf.pow(2).mean() + 1e-8)
    t = torch.sqrt(tf.pow(2).mean() + 1e-8)
    return (sf * (t / s)).to(dtype=dt)


def _compute_device():
    try:
        import comfy.model_management as mm
        return mm.get_torch_device()
    except Exception:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


class AiplayH3ConditioningBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "adapter": (folder_paths.get_filename_list(FOLDER),),
                "alpha": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 1.0, "step": 0.01}),
                "magnitude_match": (["per_token", "global", "none"], {"default": "per_token"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("conditioning",)
    FUNCTION = "apply"
    CATEGORY = "aiplay/conditioning"
    DESCRIPTION = ("Blend a learned semantic rewrite into MiniMax H3's text conditioning. "
                   "alpha 0 = bypass. Place it right after the H3 text conditioning node, before guides.")

    def apply(self, conditioning, adapter, alpha, magnitude_match):
        if float(alpha) == 0.0:
            return (conditioning,)
        device = _compute_device()
        dtype = torch.float16 if device.type == "cuda" else torch.float32
        loaded = _load(adapter, device, dtype)
        student = loaded["model"]
        out = []
        for item in conditioning:
            if len(item) != 2:
                raise RuntimeError("unexpected CONDITIONING structure")
            native, meta = item[0], item[1]
            if native.ndim != 3 or native.shape[-1] != loaded["in"]:
                raise RuntimeError(
                    f"expected H3 conditioning [B,T,{loaded['in']}], got {tuple(native.shape)} — "
                    "place this node after the H3 text conditioning node")
            # Blocking copies on purpose: a non_blocking copy back to pageable CPU
            # memory can be read before the GPU has written it (MEASURED here —
            # the "none" path came back as zeros). The tensors are tiny.
            h = native.to(device=device, dtype=dtype)
            x = _rms_normalize(h)
            with torch.inference_mode():
                projected = student(x)
            if magnitude_match == "per_token":
                projected = _match_per_token(projected, h)
            elif magnitude_match == "global":
                projected = _match_global(projected, h)
            elif magnitude_match != "none":
                raise RuntimeError(f"unknown magnitude_match: {magnitude_match}")
            hybrid = h + float(alpha) * (projected - h)
            hybrid = hybrid.to(device=native.device, dtype=native.dtype)
            new_meta = dict(meta)
            new_meta["aiplay_bridge"] = {"adapter": adapter, "alpha": float(alpha),
                                         "mode": magnitude_match, "hidden": loaded["hidden"]}
            out.append([hybrid, new_meta])
        return (out,)


NODE_CLASS_MAPPINGS = {"AiplayH3ConditioningBridge": AiplayH3ConditioningBridge}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplayH3ConditioningBridge": "H3 Conditioning Bridge (AIPLAY)"}
