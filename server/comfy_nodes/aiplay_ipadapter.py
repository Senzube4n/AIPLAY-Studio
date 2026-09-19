"""
AIPLAY IP-Adapter — picture references in the cross-attention, one per frame.

WHY THIS EXISTS. The reference audio-reactive workflow (ComfyUI_Yvann-Nodes)
carries its look entirely on PICTURES: IP-Adapter Plus puts sixteen tokens
from each reference picture beside the text tokens in every cross-attention
layer, and a per-frame weight schedule decides which picture is live and how
strongly — switching on the drum peaks with a short linear transition. The
node pack that does this in ComfyUI is GPL-3.0 and cannot ship inside an
Apache-2.0 app. The METHOD is not: IP-Adapter's reference implementation
(tencent-ailab/IP-Adapter) is Apache-2.0, the weights (h94/IP-Adapter,
ip-adapter-plus_sd15) are Apache-2.0, and the CLIP tower they need
(laion/CLIP-ViT-H-14) is MIT. This file is that method written against
ComfyUI's own attention-replace hook, with the per-frame schedule keyed on
AnimateDiff-Evolved's sliding window — the same contract our sliding
ControlNet loader uses.

WHAT IT DOES, in the reference's own terms (ip_adapter.py, resampler.py):
  1. The CLIP tower's penultimate hidden states of each picture (257 x 1280)
     go through the Resampler (a 4-layer perceiver, ported below from the
     Apache-2.0 reference) into 16 tokens of 768 — the "image prompt".
  2. Every cross-attention layer of the SD1.5 UNet (16 of them) gets a second
     key/value projection (to_k_ip / to_v_ip, from the weights file), and its
     output becomes  attn(q, k_text, v_text) + w · attn(q, k_ip, v_ip).
  3. `w` and WHICH picture's tokens are used are decided per frame from the
     schedule: a list, one entry per frame, of [picture index, weight] pairs
     (two pairs during a transition). Under AnimateDiff the batch that reaches
     a layer is one context window (times cond/uncond); the window's frame
     indices arrive in extra_options["ad_params"]["sub_idxs"].
  4. The unconditional half sees the tokens of a black picture, as the
     reference does, so the guidance difference is the picture and nothing else.

Nodes
  AiplayIPAdapterLoader  ipadapter file → IPADAPTER
  AiplayIPAdapterApply   model, ipadapter, clip_vision, images, schedule, frames, weight → MODEL

The schedule JSON: {"per_frame": [[[0, 1.0]], [[0, 0.8], [1, 0.2]], ...]}
(index into `images`, weight 0..1). Frames past the list's end reuse its
last entry. `weight` multiplies every entry (the reference's max weight).
"""
import json
import math

import torch
import torch.nn as nn

import os

import comfy.model_management
import comfy.utils
import folder_paths
from comfy.ldm.modules.attention import optimized_attention

# Core ComfyUI has no "ipadapter" shelf; the weights live in models/ipadapter
# by the convention every IP-Adapter node pack uses, so the loader's list
# reads that folder. Registered once, at import.
if "ipadapter" not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path("ipadapter", os.path.join(folder_paths.models_dir, "ipadapter"))


# ── the Resampler, ported from the Apache-2.0 reference (resampler.py) ────

def _feed_forward(dim, mult=4):
    inner = int(dim * mult)
    return nn.Sequential(nn.LayerNorm(dim), nn.Linear(dim, inner, bias=False), nn.GELU(), nn.Linear(inner, dim, bias=False))


def _heads(x, heads):
    bs, length, width = x.shape
    return x.view(bs, length, heads, -1).transpose(1, 2).reshape(bs, heads, length, -1)


class _PerceiverAttention(nn.Module):
    def __init__(self, dim, dim_head=64, heads=8):
        super().__init__()
        self.dim_head = dim_head
        self.heads = heads
        inner = dim_head * heads
        self.norm1 = nn.LayerNorm(dim)
        self.norm2 = nn.LayerNorm(dim)
        self.to_q = nn.Linear(dim, inner, bias=False)
        self.to_kv = nn.Linear(dim, inner * 2, bias=False)
        self.to_out = nn.Linear(inner, dim, bias=False)

    def forward(self, x, latents):
        x = self.norm1(x)
        latents = self.norm2(latents)
        b, l, _ = latents.shape
        q = self.to_q(latents)
        k, v = self.to_kv(torch.cat((x, latents), dim=-2)).chunk(2, dim=-1)
        q, k, v = _heads(q, self.heads), _heads(k, self.heads), _heads(v, self.heads)
        scale = 1 / math.sqrt(math.sqrt(self.dim_head))
        w = (q * scale) @ (k * scale).transpose(-2, -1)
        w = torch.softmax(w.float(), dim=-1).type(w.dtype)
        out = (w @ v).permute(0, 2, 1, 3).reshape(b, l, -1)
        return self.to_out(out)


class _Resampler(nn.Module):
    def __init__(self, dim=768, depth=4, dim_head=64, heads=12, num_queries=16, embedding_dim=1280, output_dim=768, ff_mult=4):
        super().__init__()
        self.latents = nn.Parameter(torch.randn(1, num_queries, dim) / dim ** 0.5)
        self.proj_in = nn.Linear(embedding_dim, dim)
        self.proj_out = nn.Linear(dim, output_dim)
        self.norm_out = nn.LayerNorm(output_dim)
        self.layers = nn.ModuleList([nn.ModuleList([_PerceiverAttention(dim, dim_head, heads), _feed_forward(dim, ff_mult)]) for _ in range(depth)])

    def forward(self, x):
        latents = self.latents.repeat(x.size(0), 1, 1)
        x = self.proj_in(x)
        for attn, ff in self.layers:
            latents = attn(x, latents) + latents
            latents = ff(latents) + latents
        return self.norm_out(self.proj_out(latents))


# ── the weights ──────────────────────────────────────────────────────────

# SD1.5's sixteen cross-attention layers, in the order the reference's
# attention processors are numbered (odd indices 1, 3, … 31 are attn2), as
# ComfyUI names the blocks they live in.
#
# ⚠ THE ORDER IS DOWN, UP, MID — not down, mid, up. The reference numbers the
# processors in the order diffusers' UNet registers its children, and that
# UNet assigns `down_blocks` and `up_blocks` (as empty lists) before it builds
# `mid_block`, so the middle block's adapter is the LAST pair (31), after the
# nine output blocks. Measured 2026-09-19: with the middle block placed
# seventh, the six 1280-wide layers took each other's weights without a
# shape error and every render was moiré.
_SD15_ATTN2_BLOCKS = [("input", 1), ("input", 2), ("input", 4), ("input", 5), ("input", 7), ("input", 8),
                      ("output", 3), ("output", 4), ("output", 5), ("output", 6), ("output", 7), ("output", 8),
                      ("output", 9), ("output", 10), ("output", 11),
                      ("middle", 0)]


class AiplayIPAdapterLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"ipadapter_file": (folder_paths.get_filename_list("ipadapter"),)}}

    RETURN_TYPES = ("IPADAPTER",)
    FUNCTION = "load"
    CATEGORY = "AIPLAY/ipadapter"

    def load(self, ipadapter_file):
        path = folder_paths.get_full_path_or_raise("ipadapter", ipadapter_file)
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        proj = {k[len("image_proj."):]: v for k, v in sd.items() if k.startswith("image_proj.")}
        layers = {}
        for k, v in sd.items():
            if not k.startswith("ip_adapter."):
                continue
            _, idx, name, _w = k.split(".")   # ip_adapter.<n>.to_k_ip.weight
            layers.setdefault(int(idx), {})[name] = v
        if not layers:
            raise RuntimeError(f"{ipadapter_file} is not an IP-Adapter file (no ip_adapter.* weights)")
        if len(layers) != len(_SD15_ATTN2_BLOCKS):
            raise RuntimeError(f"{ipadapter_file} has {len(layers)} cross-attention adapters; SD1.5 needs {len(_SD15_ATTN2_BLOCKS)}")
        if "latents" in proj:
            # PLUS: the perceiver over the tower's penultimate hidden states
            num_queries = proj["latents"].shape[1]
            emb_dim = proj["proj_in.weight"].shape[1]
            dim = proj["proj_in.weight"].shape[0]
            out_dim = proj["proj_out.weight"].shape[0]
            depth = max(int(k.split(".")[1]) for k in proj if k.startswith("layers.")) + 1
            heads = proj["layers.0.0.to_q.weight"].shape[0] // 64
            resampler = _Resampler(dim=dim, depth=depth, dim_head=64, heads=heads, num_queries=num_queries, embedding_dim=emb_dim, output_dim=out_dim)
            resampler.load_state_dict(proj, strict=True)
            resampler.eval()
            return ({"kind": "plus", "resampler": resampler, "layers": layers, "file": ipadapter_file},)
        if "proj.weight" in proj:
            # PLAIN: the reference's ImageProjModel — a linear map of the tower's
            # image embedding into `tokens` x 768, then a LayerNorm.
            out_dim = proj["norm.weight"].shape[0]
            tokens = proj["proj.weight"].shape[0] // out_dim
            projector = nn.Sequential(nn.Linear(proj["proj.weight"].shape[1], proj["proj.weight"].shape[0]))
            projector[0].weight.data.copy_(proj["proj.weight"]); projector[0].bias.data.copy_(proj["proj.bias"])
            norm = nn.LayerNorm(out_dim)
            norm.weight.data.copy_(proj["norm.weight"]); norm.bias.data.copy_(proj["norm.bias"])
            return ({"kind": "plain", "projector": projector.eval(), "norm": norm.eval(), "tokens": tokens, "out_dim": out_dim, "layers": layers, "file": ipadapter_file},)
        raise RuntimeError(f"{ipadapter_file}: image_proj is neither the Plus perceiver nor the plain projector")


class AiplayIPAdapterApply:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "ipadapter": ("IPADAPTER",),
                "clip_vision": ("CLIP_VISION",),
                "images": ("IMAGE",),
                "frames": ("INT", {"default": 16, "min": 1, "max": 4096}),
                "schedule": ("STRING", {"multiline": True, "default": '{"per_frame": [[[0, 1.0]]]}'}),
                "weight": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.05}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "AIPLAY/ipadapter"

    def apply(self, model, ipadapter, clip_vision, images, frames, schedule, weight):
        try:
            sched = json.loads(schedule) if schedule.strip() else {}
        except json.JSONDecodeError as exc:
            raise ValueError(f"schedule is not JSON: {exc}") from exc
        per_frame = sched.get("per_frame")
        if not isinstance(per_frame, list) or not per_frame:
            raise ValueError('schedule needs "per_frame": a list, one entry per frame, of [picture index, weight] pairs')
        n_pics = int(images.shape[0])
        for entry in per_frame:
            for pair in entry:
                if not (0 <= int(pair[0]) < n_pics):
                    raise ValueError(f"schedule names picture {pair[0]} but only {n_pics} were given")

        # 1. the pictures, and a black one for the unconditional half, as tokens
        device = comfy.model_management.get_torch_device()
        black = torch.zeros((1,) + tuple(images.shape[1:]), dtype=images.dtype)
        with torch.no_grad():
            enc = clip_vision.encode_image(images, crop=True)
            enc_un = clip_vision.encode_image(black, crop=True)
            if ipadapter.get("kind") == "plain":
                projector = ipadapter["projector"].to(device)
                norm = ipadapter["norm"].to(device)
                n_tok, out_dim = ipadapter["tokens"], ipadapter["out_dim"]
                proj = lambda e: norm(projector(e.to(device, torch.float32)).reshape(-1, n_tok, out_dim))
                tokens = proj(enc["image_embeds"])
                tokens_un = proj(enc_un["image_embeds"])
                projector.to("cpu"); norm.to("cpu")
            else:
                resampler = ipadapter["resampler"].to(device)
                tokens = resampler(enc["penultimate_hidden_states"].to(device, torch.float32))       # (n_pics, 16, 768)
                tokens_un = resampler(enc_un["penultimate_hidden_states"].to(device, torch.float32))  # (1, 16, 768)
                resampler.to("cpu")
        tokens = tokens.to("cpu")
        tokens_un = tokens_un.to("cpu")

        # 2. per-frame (indices, weights), padded to `frames`
        table = []
        for f in range(int(frames)):
            entry = per_frame[min(f, len(per_frame) - 1)]
            table.append([(int(p[0]), float(p[1]) * float(weight)) for p in entry])

        layers = ipadapter["layers"]
        patched = model.clone()

        def make_patch(k_w, v_w):
            # One cache PER LAYER. Its key is (device, dtype), which every
            # layer shares — a cache shared across the closures handed the
            # first layer's 320-wide projections to all sixteen (the 640- and
            # 1280-wide layers reshaped them without a shape error) and every
            # render was diagonal stripes. Measured 2026-09-19.
            cache = {}

            def patch(q, k, v, extra_options):
                heads = extra_options["n_heads"]
                out = optimized_attention(q, k, v, heads)
                ad = extra_options.get("ad_params") or {}
                sub_idxs = ad.get("sub_idxs")
                cond_or_uncond = extra_options.get("cond_or_uncond") or [0]
                b = q.shape[0]
                chunk = max(1, b // max(1, len(cond_or_uncond)))
                key = (q.device, q.dtype)
                if key not in cache:
                    cache[key] = (tokens.to(q.device, q.dtype), tokens_un.to(q.device, q.dtype),
                                  k_w.to(q.device, q.dtype), v_w.to(q.device, q.dtype))
                tok, tok_un, kw, vw = cache[key]
                # Two picture SLOTS per frame (the picture that is live, and
                # the one it is crossing to), each its own attention term with
                # its own weight on the OUTPUT — the reference's
                #   out + w · attn(q, k_ip, v_ip)
                # and never a weight folded into the tokens: attention is not
                # linear in its keys, so a scaled token is a different picture.
                slots = [[], []]
                weights = [[], []]
                for i in range(b):
                    which = cond_or_uncond[min(i // chunk, len(cond_or_uncond) - 1)]
                    j = i % chunk
                    frame = int(sub_idxs[j]) if sub_idxs is not None and j < len(sub_idxs) else j
                    pairs = table[min(frame, len(table) - 1)]
                    for s in range(2):
                        if s < len(pairs):
                            idx, w = pairs[s]
                            slots[s].append(tok_un[0] if which == 1 else tok[idx])
                            weights[s].append(w)
                        else:
                            slots[s].append(tok_un[0])
                            weights[s].append(0.0)
                for s in range(2):
                    if not any(weights[s]):
                        continue
                    ip = torch.stack(slots[s], dim=0)                          # (b, 16, 768)
                    w = torch.tensor(weights[s], device=q.device, dtype=q.dtype).view(b, 1, 1)
                    k_ip = torch.nn.functional.linear(ip, kw)
                    v_ip = torch.nn.functional.linear(ip, vw)
                    out = out + w * optimized_attention(q, k_ip, v_ip, heads)
                return out
            return patch

        for j, (block_name, number) in enumerate(_SD15_ATTN2_BLOCKS):
            w = layers[2 * j + 1]
            patched.set_model_attn2_replace(make_patch(w["to_k_ip"], w["to_v_ip"]), block_name, number)
        return (patched,)


NODE_CLASS_MAPPINGS = {"AiplayIPAdapterLoader": AiplayIPAdapterLoader, "AiplayIPAdapterApply": AiplayIPAdapterApply}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplayIPAdapterLoader": "AIPLAY IP-Adapter loader", "AiplayIPAdapterApply": "AIPLAY IP-Adapter (per-frame pictures)"}
