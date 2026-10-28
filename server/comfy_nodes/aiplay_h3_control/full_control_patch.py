"""Load the exact official full-width H3 v1 ControlNet without rewriting it.

The inverse key/QKV/SwiGLU layout follows VideoX-Fun's publisher conversion:
9dc6f1d49ab14b35ec956c13ac9e35d6d52c527d/minimax_h3_conversion.py439-473.
There is no timestep basis conversion, interpolation, padding or core patch.
"""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import struct
import types

import torch

FULL_PATCH_NAME = "MiniMax-H3-Fun-Controlnet-Union.safetensors"
FULL_PATCH_BYTES = 6806843904
MAX_HEADER_BYTES = 128 * 1024


@dataclass(frozen=True)
class ControlShape:
    hidden: int = 5376
    attention: int = 7168
    ffn: int = 14336
    time: int = 2688
    head: int = 128
    blocks: int = 5


OFFICIAL_SHAPE = ControlShape()


def original_spec(shape=OFFICIAL_SHAPE):
    h, a, f, t, head = shape.hidden, shape.attention, shape.ffn, shape.time, shape.head
    spec = {"control_proj_in.weight": ((h, 196), "F32"), "control_proj_in.bias": ((h,), "F32")}
    for index in range(shape.blocks):
        prefix = f"control_blocks.{index}."
        local = {
            "adaln_proj.linear.weight": (18 * h, t), "adaln_proj.linear.bias": (18 * h,),
            "after_proj.weight": (h, h), "after_proj.bias": (h,),
            "norm1.weight": (h,), "norm2.weight": (h,),
            "attn.norm_q.weight": (head,), "attn.norm_k.weight": (head,),
            "attn.to_q.weight": (a, h), "attn.to_k.weight": (a, h), "attn.to_v.weight": (a, h),
            "attn.to_out.0.weight": (h, a), "ff.net.0.proj.weight": (2 * f, h), "ff.net.2.weight": (h, f),
        }
        if index == 0:
            local.update({"before_proj.weight": (h, h), "before_proj.bias": (h,)})
        spec.update({prefix + key: (dimensions, "BF16") for key, dimensions in local.items()})
    return spec


def _metadata(metadata):
    if metadata != {"format": "pt"}:
        raise ValueError("The full H3 control loader requires the official v1 metadata, not a converted or basis-compressed patch.")


def validate_original_header(header, header_bytes, file_bytes, shape=OFFICIAL_SHAPE, expected_file_bytes=FULL_PATCH_BYTES):
    if not isinstance(header, dict):
        raise ValueError("Invalid full H3 control safetensors header.")
    _metadata(header.get("__metadata__"))
    spec = original_spec(shape)
    if set(header) != set(spec) | {"__metadata__"}:
        raise ValueError("Full H3 control checkpoint has missing or unexpected original-format keys.")
    if expected_file_bytes is not None and file_bytes != expected_file_bytes:
        raise ValueError("Full H3 control checkpoint is incomplete or is not the supported official v1 file.")
    spans = []
    for key, (dimensions, dtype) in spec.items():
        info = header[key]
        if not isinstance(info, dict) or info.get("shape") != list(dimensions) or info.get("dtype") != dtype:
            raise ValueError("Full H3 control tensor shape/dtype mismatch: " + key)
        offsets = info.get("data_offsets")
        if not isinstance(offsets, list) or len(offsets) != 2 or any(type(n) is not int for n in offsets):
            raise ValueError("Invalid full H3 control tensor offsets: " + key)
        count = 1
        for size in dimensions:
            count *= size
        start, end = offsets
        if start < 0 or end - start != count * (4 if dtype == "F32" else 2):
            raise ValueError("Invalid full H3 control tensor payload size: " + key)
        spans.append((start, end))
    previous = 0
    for start, end in sorted(spans):
        if start != previous:
            raise ValueError("Full H3 control tensor data overlaps or has gaps.")
        previous = end
    if previous + header_bytes + 8 != file_bytes:
        raise ValueError("Full H3 control tensor data does not match the file length.")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate full H3 control header key.")
        value[key] = item
    return value


def read_original_header(path):
    path = Path(path)
    before = path.stat()
    if before.st_size != FULL_PATCH_BYTES:
        raise ValueError("Install the complete official full-width H3 v1 control patch first.")
    with path.open("rb") as stream:
        length_data = stream.read(8)
        if len(length_data) != 8:
            raise ValueError("Full H3 control header is incomplete.")
        header_bytes = struct.unpack("<Q", length_data)[0]
        if not 1 <= header_bytes <= MAX_HEADER_BYTES:
            raise ValueError("Full H3 control header is outside the supported bound.")
        raw = stream.read(header_bytes)
        if len(raw) != header_bytes:
            raise ValueError("Full H3 control header is incomplete.")
    header = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    validate_original_header(header, header_bytes, before.st_size)
    return header, (before.st_size, before.st_mtime_ns), hashlib.sha256(raw).hexdigest()


def convert_original_state(state, metadata, shape=OFFICIAL_SHAPE):
    """Exact layout conversion only; caller retains ownership of source tensors."""
    _metadata(metadata)
    spec = original_spec(shape)
    if set(state) != set(spec):
        raise ValueError("Full H3 control state has missing or unexpected original-format keys.")
    for key, (dimensions, dtype) in spec.items():
        tensor = state[key]
        expected_dtype = torch.float32 if dtype == "F32" else torch.bfloat16
        if not isinstance(tensor, torch.Tensor) or tuple(tensor.shape) != dimensions or tensor.dtype != expected_dtype or tensor.device.type != "cpu":
            raise ValueError("Full H3 control state shape/dtype/device mismatch: " + key)
    converted = {key: state[key] for key in ("control_proj_in.weight", "control_proj_in.bias")}
    same = ("adaln_proj.linear.weight", "adaln_proj.linear.bias", "after_proj.weight", "after_proj.bias", "norm1.weight", "norm2.weight")
    for index in range(shape.blocks):
        prefix = f"control_blocks.{index}."
        for key in same:
            converted[prefix + key] = state[prefix + key]
        if index == 0:
            for key in ("before_proj.weight", "before_proj.bias"):
                converted[prefix + key] = state[prefix + key]
        for source, target in (("attn.norm_q.weight", "attn.q_norm.weight"), ("attn.norm_k.weight", "attn.k_norm.weight"),
                               ("attn.to_out.0.weight", "attn.out_proj.weight"), ("ff.net.2.weight", "mlp.fc2.weight")):
            converted[prefix + target] = state[prefix + source]
        converted[prefix + "attn.qkv_proj.weight"] = torch.cat([state[prefix + "attn.to_" + part + ".weight"] for part in ("q", "k", "v")], dim=0)
        # Publisher uses value * silu(gate); native MLP uses silu(gate) * value.
        value, gate = state[prefix + "ff.net.0.proj.weight"].chunk(2, dim=0)
        converted[prefix + "mlp.fc1.weight"] = torch.cat((gate, value), dim=0)
    if len(converted) != 2 + shape.blocks * 12 + 2:
        raise ValueError("Incomplete native full H3 control conversion.")
    return converted


def _native_runtime():
    try:
        import comfy.utils
        import comfy.storage
        import comfy.model_management
        import comfy.model_patcher
        from comfy.ldm.minimax.controlnet import MiniMaxH3FunControl
        from comfy_extras.nodes_model_patch import dit_patch_operations
        patcher = comfy.model_patcher.CoreModelPatcher
        fast_disk = comfy.storage.state_dict_fast_disk
    except (ImportError, AttributeError) as error:
        raise RuntimeError("This ComfyUI build lacks native full-width H3 control support. Use a compatible Studio engine; no core patch was applied.") from error
    return types.SimpleNamespace(utils=comfy.utils, mm=comfy.model_management, Control=MiniMaxH3FunControl,
                                 Patcher=patcher, operations=dit_patch_operations, fast_disk=fast_disk)


class AiplayH3FullControlPatchLoader:
    RETURN_TYPES = ("MODEL_PATCH",)
    FUNCTION = "load_model_patch"
    CATEGORY = "model/loaders"
    EXPERIMENTAL = True

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths
        # Schema discovery must refuse an old core before any guide extraction.
        # This resolves native functions only; it loads no model or device.
        _native_runtime()
        return {"required": {"name": (folder_paths.get_filename_list("model_patches"),)}}

    @classmethod
    def IS_CHANGED(cls, name):
        import folder_paths
        path = folder_paths.get_full_path_or_raise("model_patches", name)
        _header, stamp, digest = read_original_header(path)
        return stamp + (digest,)

    def load_model_patch(self, name):
        import folder_paths
        if Path(name).name != FULL_PATCH_NAME:
            raise ValueError("Select the supported official full-width H3 v1 control patch.")
        path = folder_paths.get_full_path_or_raise("model_patches", name)
        _header, stamp, _digest = read_original_header(path)
        runtime = _native_runtime()
        original, metadata = runtime.utils.load_torch_file(path, safe_load=True, device=torch.device("cpu"), return_metadata=True)
        current = Path(path).stat()
        if (current.st_size, current.st_mtime_ns) != stamp:
            raise ValueError("Full H3 control file changed while it was being loaded.")
        state = convert_original_state(original, metadata)
        del original
        dtype, operations = runtime.operations(state)
        model = runtime.Control(control_in_dim=49, injection_layers=(0, 10, 20, 30, 40),
            hidden_size=5376, num_attention_heads=56, attention_head_dim=128, ffn_hidden_size=14336,
            time_embed_dim=2688, use_adaln_curves=False, inpaint_post_norm=False,
            operations=operations, device=runtime.mm.unet_offload_device(), dtype=dtype)
        model.requires_grad_(False)
        model.eval()
        patcher = runtime.Patcher(model, load_device=runtime.mm.get_torch_device(),
            offload_device=runtime.mm.unet_offload_device(), fast_disk=runtime.fast_disk(state))
        model.load_state_dict(state, strict=True, assign=patcher.is_dynamic())
        return (patcher,)
