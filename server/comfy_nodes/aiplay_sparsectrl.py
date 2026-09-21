"""
AIPLAY SparseCtrl — keyframe pictures as a ControlNet, one window at a time.

WHY THIS EXISTS. The reference audio-reactive workflow (ComfyUI_Yvann-Nodes)
cycles its style pictures through SparseCtrl RGB at the audio peak indexes.
Those timeline indexes are separate from the indexes into its picture batch.
This node supports that mapping as well as anchoring source-video frames.
The node pack that does this in ComfyUI is
GPL-3.0 and cannot ship inside an Apache-2.0 app. The METHOD is not:
SparseCtrl's reference implementation (guoyww/AnimateDiff, Apache-2.0) and
its weights (v3_sd15_sparsectrl_rgb.ckpt, Apache-2.0) are, and this file is
that method written against ComfyUI's own ControlNet network and control
hook, keyed on AnimateDiff-Evolved's sliding window like our sliding
ControlNet loader and our IP-Adapter node.

WHAT THE CHECKPOINT IS, read from its keys (2026-09-19):
  - an SD1.5 ControlNet's down path (four blocks of two resnets, spatial
    transformers in the first three, three downsamplers), a middle block,
    twelve zero convolutions and a middle one — ComfyUI's cldm.ControlNet
    holds exactly that, so it holds it here, loaded through the same
    diffusers-to-ldm key map ComfyUI uses for any diffusers ControlNet;
  - a SINGLE 3x3 conv over FIVE channels as the condition embedding
    (`controlnet_cond_embedding`, 320 x 5): the reference's
    `use_simplified_condition_embedding` with `concate_conditioning_mask` —
    four VAE-latent channels of a keyframe picture plus a one-channel mask
    that is 1 on frames that ARE keyframes and 0 elsewhere, at latent size;
  - EIGHT temporal transformers (`down_blocks.N.motion_modules.M`), one
    after each resnet of the down path (resnet, then spatial attention, then
    the temporal module — the reference's CrossAttnDownBlock3D order), one
    block each, "Temporal_Self", 8 heads, sinusoidal positions up to 32
    frames, GEGLU feed-forward; none in the middle block;
  - `set_noisy_sample_input_to_zero`: the noisy latent never enters. The
    first block sees conv_in(0) + embedding(cond), i.e. the control depends
    on the keyframes, the timestep and the text alone.

Nodes
  AiplaySparseCtrlLoader   controlnet file → SPARSECTRL
  AiplaySparseCtrlApply    positive, negative, sparsectrl, vae, images,
                           keyframes (JSON [frame, ...]), frames, strength,
                           start_percent, end_percent → positive, negative
"""
import json
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

import comfy.controlnet
import comfy.cldm.cldm
import comfy.model_detection
import comfy.model_management
import comfy.ops
import comfy.utils
import comfy.latent_formats
import folder_paths
from comfy.ldm.modules.attention import optimized_attention


# ── the temporal transformer, ported from the Apache-2.0 reference (motion_module.py) ──

class _PositionalEncoding(nn.Module):
    def __init__(self, dim, max_len=32):
        super().__init__()
        position = torch.arange(max_len).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, dim, 2) * (-math.log(10000.0) / dim))
        pe = torch.zeros(1, max_len, dim)
        pe[0, :, 0::2] = torch.sin(position * div_term)
        pe[0, :, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe, persistent=False)

    def forward(self, x):
        return x + self.pe[:, :x.size(1)].to(device=x.device, dtype=x.dtype)


class _TemporalSelfAttention(nn.Module):
    """VersatileAttention("Temporal"): every spatial position attends over
    the frames of its own window, with a sinusoidal position per frame."""
    def __init__(self, dim, heads, dim_head, max_len=32, dtype=None, device=None, operations=comfy.ops.disable_weight_init):
        super().__init__()
        self.heads = heads
        inner = heads * dim_head
        self.to_q = operations.Linear(dim, inner, bias=False, dtype=dtype, device=device)
        self.to_k = operations.Linear(dim, inner, bias=False, dtype=dtype, device=device)
        self.to_v = operations.Linear(dim, inner, bias=False, dtype=dtype, device=device)
        self.to_out = nn.ModuleList([operations.Linear(inner, dim, dtype=dtype, device=device), nn.Dropout(0.0)])
        self.pos_encoder = _PositionalEncoding(dim, max_len)

    def forward(self, x, video_length):
        # x: ((b f), d, c) — reference: "(b f) d c -> (b d) f c"
        bf, d, c = x.shape
        b = bf // video_length
        x = x.view(b, video_length, d, c).permute(0, 2, 1, 3).reshape(b * d, video_length, c)
        x = self.pos_encoder(x)
        out = optimized_attention(self.to_q(x), self.to_k(x), self.to_v(x), self.heads)
        out = self.to_out[1](self.to_out[0](out))
        return out.view(b, d, video_length, c).permute(0, 2, 1, 3).reshape(bf, d, c)


class _GEGLU(nn.Module):
    def __init__(self, dim, inner, dtype=None, device=None, operations=comfy.ops.disable_weight_init):
        super().__init__()
        self.proj = operations.Linear(dim, inner * 2, dtype=dtype, device=device)

    def forward(self, x):
        h, gate = self.proj(x).chunk(2, dim=-1)
        return h * F.gelu(gate)


class _FeedForward(nn.Module):
    """diffusers' FeedForward: `net` = [GEGLU, Dropout, Linear], so the keys read ff.net.0.proj / ff.net.2."""
    def __init__(self, dim, mult=4, dtype=None, device=None, operations=comfy.ops.disable_weight_init):
        super().__init__()
        self.net = nn.ModuleList([_GEGLU(dim, dim * mult, dtype=dtype, device=device, operations=operations), nn.Dropout(0.0),
                                  operations.Linear(dim * mult, dim, dtype=dtype, device=device)])

    def forward(self, x):
        for m in self.net:
            x = m(x)
        return x


class _TemporalBlock(nn.Module):
    def __init__(self, dim, heads, dim_head, max_len, dtype=None, device=None, operations=comfy.ops.disable_weight_init):
        super().__init__()
        kw = dict(dtype=dtype, device=device, operations=operations)
        self.attention_blocks = nn.ModuleList([_TemporalSelfAttention(dim, heads, dim_head, max_len, **kw)])
        self.norms = nn.ModuleList([operations.LayerNorm(dim, dtype=dtype, device=device)])
        self.ff = _FeedForward(dim, **kw)
        self.ff_norm = operations.LayerNorm(dim, dtype=dtype, device=device)

    def forward(self, x, video_length):
        for attn, norm in zip(self.attention_blocks, self.norms):
            x = attn(norm(x), video_length) + x
        return self.ff(self.ff_norm(x)) + x


class _TemporalTransformer(nn.Module):
    """TemporalTransformer3DModel: GroupNorm → proj_in → blocks → proj_out, residual."""
    def __init__(self, channels, heads=8, max_len=32, layers=1, dtype=None, device=None, operations=comfy.ops.disable_weight_init):
        super().__init__()
        kw = dict(dtype=dtype, device=device, operations=operations)
        self.norm = operations.GroupNorm(32, channels, eps=1e-6, affine=True, dtype=dtype, device=device)
        self.proj_in = operations.Linear(channels, channels, dtype=dtype, device=device)
        self.transformer_blocks = nn.ModuleList([_TemporalBlock(channels, heads, channels // heads, max_len, **kw) for _ in range(layers)])
        self.proj_out = operations.Linear(channels, channels, dtype=dtype, device=device)

    def forward(self, h, video_length):
        # h: ((b f), c, H, W)
        bf, c, H, W = h.shape
        residual = h
        x = self.norm(h).permute(0, 2, 3, 1).reshape(bf, H * W, c)
        x = self.proj_in(x)
        for block in self.transformer_blocks:
            x = block(x, video_length)
        x = self.proj_out(x)
        return x.reshape(bf, H, W, c).permute(0, 3, 1, 2).contiguous() + residual


class _MotionModule(nn.Module):
    """VanillaTemporalModule: the reference's wrapper, so the keys line up."""
    def __init__(self, channels, heads=8, max_len=32, dtype=None, device=None, operations=comfy.ops.disable_weight_init):
        super().__init__()
        self.temporal_transformer = _TemporalTransformer(channels, heads, max_len, dtype=dtype, device=device, operations=operations)

    def forward(self, h, video_length):
        return self.temporal_transformer(h, video_length)


# ── the network ────────────────────────────────────────────────────────────

# cldm input_blocks index → (down block, motion module) for the eight resnets;
# 3, 6, 9 are downsamplers and carry none.
_MOTION_AT = {1: (0, 0), 2: (0, 1), 4: (1, 0), 5: (1, 1), 7: (2, 0), 8: (2, 1), 10: (3, 0), 11: (3, 1)}


class SparseCtrlNet(nn.Module):
    def __init__(self, cldm_config, cond_channels=5, dtype=torch.float32, device=None, operations=comfy.ops.disable_weight_init):
        super().__init__()
        cfg = dict(cldm_config)
        cfg["hint_channels"] = 3                        # the pixel hint block exists in cldm; unused here
        cfg["dtype"] = dtype
        cfg["device"] = device
        cfg["operations"] = operations
        self.net = comfy.cldm.cldm.ControlNet(**cfg)
        self.net.input_hint_block = None                # never called: see forward
        ch = cfg["model_channels"]
        self.cond_embedding = operations.Conv2d(cond_channels, ch, 3, padding=1, dtype=dtype, device=device)
        mult = cfg.get("channel_mult", (1, 2, 4, 8))
        self.motion_modules = nn.ModuleDict()
        for i, (blk, _m) in _MOTION_AT.items():
            self.motion_modules[str(i)] = _MotionModule(ch * mult[blk], dtype=dtype, device=device, operations=operations)
        self.dtype = dtype

    def forward(self, x, hint, timesteps, context, video_length, **kwargs):
        net = self.net
        from comfy.ldm.modules.diffusionmodules.util import timestep_embedding
        t_emb = timestep_embedding(timesteps, net.model_channels, repeat_only=False).to(x.dtype)
        emb = net.time_embed(t_emb)
        out_output, out_middle = [], []
        # the noisy latent is zero at the door (set_noisy_sample_input_to_zero)
        h = net.input_blocks[0](torch.zeros_like(x), emb, context) + self.cond_embedding(hint.to(x.dtype))
        out_output.append(net.zero_convs[0](h, emb, context))
        for i in range(1, len(net.input_blocks)):
            h = net.input_blocks[i](h, emb, context)
            if str(i) in self.motion_modules:
                h = self.motion_modules[str(i)](h, video_length)
            out_output.append(net.zero_convs[i](h, emb, context))
        h = net.middle_block(h, emb, context)
        out_middle.append(net.middle_block_out(h, emb, context))
        return {"middle": out_middle, "output": out_output}


def _load_sparsectrl(path):
    sd = comfy.utils.load_torch_file(path, safe_load=True)
    if "controlnet_cond_embedding.weight" not in sd:
        raise RuntimeError(f"{path} is not a SparseCtrl checkpoint with the simplified (latent) condition embedding")
    motion = {k: v for k, v in sd.items() if ".motion_modules." in k}
    cond_w, cond_b = sd["controlnet_cond_embedding.weight"], sd["controlnet_cond_embedding.bias"]
    spatial = {k: v for k, v in sd.items() if ".motion_modules." not in k and not k.startswith("controlnet_cond_embedding.")}

    # the spatial keys, through ComfyUI's own diffusers → ldm map
    config = comfy.model_detection.unet_config_from_diffusers_unet(spatial)
    keys = comfy.utils.unet_to_diffusers(config)
    keys["controlnet_mid_block.weight"] = "middle_block_out.0.weight"
    keys["controlnet_mid_block.bias"] = "middle_block_out.0.bias"
    count = 0
    while f"controlnet_down_blocks.{count}.weight" in spatial:
        for s in (".weight", ".bias"):
            keys[f"controlnet_down_blocks.{count}{s}"] = f"zero_convs.{count}.0{s}"
        count += 1
    ldm = {}
    for k, v in spatial.items():
        if k not in keys:
            raise RuntimeError(f"SparseCtrl: no place for spatial key {k}")
        ldm[keys[k]] = v
    config.pop("out_channels", None)
    return config, ldm, cond_w, cond_b, motion


def _motion_key(k):
    # down_blocks.N.motion_modules.M.temporal_transformer... → motion_modules.<idx>.temporal_transformer...
    parts = k.split(".")
    blk, mm = int(parts[1]), int(parts[3])
    idx = [i for i, (b, m) in _MOTION_AT.items() if b == blk and m == mm][0]
    return f"motion_modules.{idx}." + ".".join(parts[4:])


class AiplaySparseCtrlLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"sparsectrl_file": (folder_paths.get_filename_list("controlnet"),)}}

    RETURN_TYPES = ("SPARSECTRL",)
    FUNCTION = "load"
    CATEGORY = "AIPLAY/sparsectrl"

    def load(self, sparsectrl_file):
        path = folder_paths.get_full_path_or_raise("controlnet", sparsectrl_file)
        config, ldm, cond_w, cond_b, motion = _load_sparsectrl(path)
        load_device = comfy.model_management.get_torch_device()
        dtype = comfy.model_management.unet_dtype()
        manual_cast = comfy.model_management.unet_manual_cast(dtype, load_device)
        ops = comfy.ops.disable_weight_init if manual_cast is None else comfy.ops.manual_cast
        net = SparseCtrlNet(config, cond_channels=cond_w.shape[1], dtype=dtype, device=comfy.model_management.unet_offload_device(), operations=ops)
        state = {"net." + k: v for k, v in ldm.items()}
        state["cond_embedding.weight"] = cond_w
        state["cond_embedding.bias"] = cond_b
        for k, v in motion.items():
            if k.endswith("pos_encoder.pe"):
                continue                                  # a buffer, rebuilt from the formula
            state[_motion_key(k)] = v
        missing, unexpected = net.load_state_dict(state, strict=False)
        missing = [m for m in missing if not m.endswith("pos_encoder.pe") and ".input_hint_block." not in m]
        if missing or unexpected:
            raise RuntimeError(f"SparseCtrl load: missing {missing[:5]}{'…' if len(missing) > 5 else ''} unexpected {unexpected[:5]}")
        net.eval()
        # Keep the model-management owner in the loader's cached output. A raw
        # net alone outlives a temporary Apply-created patcher; Comfy then sees
        # a live GPU model with a dead owner and cannot offload it normally.
        # The template never receives job hints or a previous-control chain.
        control = SparseCtrlControl(net, load_device=load_device, manual_cast_dtype=manual_cast)
        return ({"control": control, "net": net, "file": sparsectrl_file, "load_device": load_device, "manual_cast_dtype": manual_cast},)


# ── the control: the keyframes' latents and mask, one window at a time ──────

class SparseCtrlControl(comfy.controlnet.ControlNet):
    """comfy.controlnet.ControlNet with the hint replaced: instead of a picture
    resized to the latent, the (frames, 5, h, w) latent-and-mask tensor built
    at apply time, sliced to the sliding window's frames (ad_params.sub_idxs)
    and repeated for the guidance pair. Strength, the timestep window and the
    merge into the UNet are the base class's."""
    # AnimateDiff-Evolved refuses a control without `sub_idxs` (animatediff/sampling.py,
    # prepare_control_objects) and writes the window's frame indices, the piece's
    # length and the window length onto these three before every window.
    sub_idxs = None
    full_latent_length = 0
    context_length = 0

    def __init__(self, control_model=None, load_device=None, manual_cast_dtype=None):
        super().__init__(control_model, load_device=load_device, manual_cast_dtype=manual_cast_dtype)
        self.sparse_cond = None          # (frames, 5, h, w), latent size, on the CPU

    def set_sparse(self, cond):
        self.sparse_cond = cond
        return self

    def get_control(self, x_noisy, t, cond, batched_number, transformer_options):
        control_prev = None
        if self.previous_controlnet is not None:
            control_prev = self.previous_controlnet.get_control(x_noisy, t, cond, batched_number, transformer_options)
        if self.timestep_range is not None:
            if t[0] > self.timestep_range[0] or t[0] < self.timestep_range[1]:
                return control_prev
        dtype = self.control_model.dtype
        if self.manual_cast_dtype is not None:
            dtype = self.manual_cast_dtype
        b = x_noisy.shape[0]
        per = max(1, b // max(1, int(batched_number)))
        sub = self.sub_idxs
        if sub is None:
            sub = ((transformer_options or {}).get("ad_params") or {}).get("sub_idxs")
        idxs = [int(i) for i in sub] if sub is not None else list(range(per))
        idxs = [min(i, self.sparse_cond.shape[0] - 1) for i in idxs][:per]
        while len(idxs) < per:
            idxs.append(idxs[-1] if idxs else 0)
        hint = self.sparse_cond[idxs]
        if hint.shape[-2:] != x_noisy.shape[-2:]:
            # Resize latent anchors without blending neighboring latent vectors;
            # this also keeps their geometry aligned with the nearest mask.
            lat = comfy.utils.common_upscale(hint[:, :4], x_noisy.shape[-1], x_noisy.shape[-2], "nearest-exact", "center")
            msk = comfy.utils.common_upscale(hint[:, 4:5], x_noisy.shape[-1], x_noisy.shape[-2], "nearest-exact", "center")
            hint = torch.cat([lat, msk], dim=1)
        hint = torch.cat([hint] * int(batched_number), dim=0)[:b].to(device=x_noisy.device, dtype=dtype)
        context = cond.get("crossattn_controlnet", cond["c_crossattn"])
        timestep = self.model_sampling_current.timestep(t)
        x_in = self.model_sampling_current.calculate_input(t, x_noisy)
        control = self.control_model(x=x_in.to(dtype), hint=hint, timesteps=timestep.to(dtype),
                                     context=comfy.model_management.cast_to_device(context, x_noisy.device, dtype), video_length=per)
        return self.control_merge(control, control_prev, output_dtype=None)

    def copy(self):
        c = SparseCtrlControl(None, load_device=self.load_device, manual_cast_dtype=self.manual_cast_dtype)
        c.control_model = self.control_model
        c.control_model_wrapped = self.control_model_wrapped
        c.sparse_cond = self.sparse_cond
        c.sub_idxs = None
        c.full_latent_length = 0
        c.context_length = 0
        self.copy_to(c)
        return c


def _keyframe_image_pairs(keys, image_indices, frames, image_count):
    """Return sorted (timeline frame, supplied image) pairs without conflating them.

    An omitted mapping keeps the original source-video behavior. An explicit
    mapping is strict: losing a pair silently would change which picture lands
    on a musical hit.
    """
    if not isinstance(keys, list):
        raise ValueError("keyframes must be a JSON list of timeline frame indices")
    if image_indices is None:
        return [(k, k) for k in sorted({int(k) for k in keys if 0 <= int(k) < min(frames, image_count)})]
    if not isinstance(image_indices, list) or len(image_indices) != len(keys):
        raise ValueError("image_indices must have one picture index per keyframe")
    pairs = []
    seen = set()
    for frame, picture in zip(keys, image_indices):
        if isinstance(frame, bool) or not isinstance(frame, (int, float)) or not math.isfinite(frame) or int(frame) != frame or not 0 <= frame < frames:
            raise ValueError("keyframes must be whole timeline positions inside frames")
        if isinstance(picture, bool) or not isinstance(picture, (int, float)) or not math.isfinite(picture) or int(picture) != picture or not 0 <= picture < image_count:
            raise ValueError("image_indices names a picture outside the supplied image batch")
        if int(frame) in seen:
            raise ValueError("explicit keyframe mappings cannot contain duplicate timeline positions")
        seen.add(int(frame))
        pairs.append((int(frame), int(picture)))
    return sorted(pairs)


class AiplaySparseCtrlApply:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "sparsectrl": ("SPARSECTRL",),
                "vae": ("VAE",),
                "images": ("IMAGE",),
                "keyframes": ("STRING", {"multiline": True, "default": "[0]"}),
                "frames": ("INT", {"default": 16, "min": 1, "max": 4096}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.05}),
                "start_percent": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "end_percent": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
            "optional": {
                "image_indices": ("STRING", {"multiline": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "apply"
    CATEGORY = "AIPLAY/sparsectrl"

    def apply(self, positive, negative, sparsectrl, vae, images, keyframes, frames, strength, start_percent, end_percent, image_indices=""):
        try:
            keys = json.loads(keyframes) if keyframes.strip() else []
            picture_indices = json.loads(image_indices) if image_indices.strip() else None
        except json.JSONDecodeError as exc:
            raise ValueError(f"keyframes or image_indices is not JSON: {exc}") from exc
        n = int(frames)
        pairs = _keyframe_image_pairs(keys, picture_indices, n, int(images.shape[0]))
        if not pairs:
            raise ValueError("keyframes names no valid timeline and image pair")
        if strength <= 0:
            return (positive, negative)
        # the keyframes' latents (ComfyUI's VAE, then the SD1.5 latent scale — the reference multiplies by 0.18215)
        keys = [frame for frame, _ in pairs]
        pics = images[[picture for _, picture in pairs]]
        with torch.no_grad():
            lat = vae.encode(pics[:, :, :, :3])
        lat = comfy.latent_formats.SD15().process_in(lat).to("cpu")
        h, w = lat.shape[-2:]
        cond = torch.zeros((n, 5, h, w), dtype=torch.float32)
        for j, k in enumerate(keys):
            cond[k, :4] = lat[j].float()
            cond[k, 4] = 1.0
        # Clone per-job control state while sharing the loader-owned patcher.
        # This is the same ownership pattern as ComfyUI's ControlNet loaders.
        control = sparsectrl["control"].copy().set_sparse(cond)
        control.set_cond_hint(pics[:1].movedim(-1, 1), float(strength), (float(start_percent), float(end_percent)))
        out = []
        for conditioning in (positive, negative):
            c = []
            for t in conditioning:
                d = t[1].copy()
                prev = d.get("control")
                cn = control.copy()
                if prev is not None:
                    cn.set_previous_controlnet(prev)
                d["control"] = cn
                d["control_apply_to_uncond"] = False
                c.append([t[0], d])
            out.append(c)
        return (out[0], out[1])


NODE_CLASS_MAPPINGS = {"AiplaySparseCtrlLoader": AiplaySparseCtrlLoader, "AiplaySparseCtrlApply": AiplaySparseCtrlApply}
NODE_DISPLAY_NAME_MAPPINGS = {"AiplaySparseCtrlLoader": "AIPLAY SparseCtrl loader", "AiplaySparseCtrlApply": "AIPLAY SparseCtrl (keyframes per window)"}
