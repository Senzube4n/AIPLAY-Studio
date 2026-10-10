"""Convert native YuE2 factors to ComfyUI's fused LoRA module names.

LoKr conversion uses kron(A,B) kron(C,D) = kron(AC,BD).
Inspired by YuE2-Studio's documented ComfyUI interoperability workflow.
"""
import json
import re
import sys
from pathlib import Path
import numpy as np
from safetensors import safe_open
from safetensors.numpy import save_file


def factors(parts, metadata):
    alpha = float(parts.get('alpha', np.asarray(float(metadata.get('alpha', 1)))).reshape(-1)[0]) if 'alpha' in parts or 'alpha' in metadata else None
    if 'lokr_w1' in parts:
        w1, a, b = (parts[k] for k in ('lokr_w1', 'lokr_w2_a', 'lokr_w2_b'))
        scale = 1 if alpha is None else alpha / float(metadata.get('lokr_dim', a.shape[1]))
        if w1.shape[0] <= w1.shape[1]:
            up = np.kron(np.eye(w1.shape[0], dtype=np.float32), a)
            down = np.kron(w1, b)
        else:
            up = np.kron(w1, a)
            down = np.kron(np.eye(w1.shape[1], dtype=np.float32), b)
    else:
        up = parts.get('lora_B', parts.get('lora_up'))
        down = parts.get('lora_A', parts.get('lora_down'))
        if up is None or down is None:
            raise ValueError('Unsupported native adapter factors')
        scale = 1 if alpha is None else alpha / down.shape[0]
    if up.ndim != 2 or down.ndim != 2 or up.shape[1] != down.shape[0]:
        raise ValueError('Incompatible factor dimensions')
    return up.astype(np.float32), (down * scale).astype(np.float32)


def fuse(parts):
    width = next(pair[1].shape[1] for pair, _ in parts if pair is not None)
    rank = sum(pair[0].shape[1] for pair, _ in parts if pair is not None)
    up = np.zeros((sum(height for _, height in parts), rank), dtype=np.float32)
    down = np.zeros((rank, width), dtype=np.float32)
    row = col = 0
    for pair, height in parts:
        if pair is not None:
            u, d = pair
            if u.shape[0] != height or d.shape[1] != width:
                raise ValueError('Fused modules have incompatible dimensions')
            n = u.shape[1]
            up[row:row + height, col:col + n] = u
            down[col:col + n] = d
            col += n
        row += height
    return up, down


def convert(file, prefix):
    grouped = {}
    # Native checkpoints can store BF16, which NumPy safetensors cannot decode.
    with safe_open(file, framework='pt', device='cpu') as source:
        metadata = source.metadata() or {}
        for name in source.keys():
            match = re.fullmatch(r'yue2\.blk\.(\d+)\.(?:nar_)?(attn_q|attn_k|attn_v|attn_output|ffn_gate|ffn_up|ffn_down)\.(lora_A|lora_B|lora_up|lora_down|lokr_w1|lokr_w2_a|lokr_w2_b|alpha)(?:\.weight)?', name)
            if not match:
                raise ValueError('Unsupported native tensor: ' + name)
            block, site, part = match.groups()
            grouped.setdefault((block, site), {})[part] = source.get_tensor(name).float().numpy()
    sites = {key: factors(parts, metadata) for key, parts in grouped.items()}
    output = {}
    heights = {'attn_q': 2048, 'attn_k': 1024, 'attn_v': 1024, 'ffn_gate': 6144, 'ffn_up': 6144}
    def add(block, module, pair):
        up, down = pair
        output[f'{prefix}.{block}.{module}.lora_up.weight'] = np.ascontiguousarray(up)
        output[f'{prefix}.{block}.{module}.lora_down.weight'] = np.ascontiguousarray(down)
    for block in sorted({block for block, _ in sites}):
        for names, module in [(('attn_q', 'attn_k', 'attn_v'), 'self_attn.qkv_proj'), (('ffn_gate', 'ffn_up'), 'mlp.gate_up_proj')]:
            if any((block, name) in sites for name in names):
                add(block, module, fuse([(sites.get((block, name)), sites[(block, name)][0].shape[0] if (block, name) in sites else heights[name]) for name in names]))
        for name, module in [('attn_output', 'self_attn.o_proj'), ('ffn_down', 'mlp.down_proj')]:
            if (block, name) in sites:
                add(block, module, sites[(block, name)])
    return output


def main(job):
    tensors = {}
    for half, prefix in [('ar', 'text_encoders.model.layers'), ('nar', 'diffusion_model.model.layers')]:
        if job.get(half):
            tensors.update(convert(job[half], prefix))
    if not tensors:
        raise ValueError('No compatible adapter tensors')
    save_file(tensors, job['output'], metadata={'format': 'pt', 'base_model': 'YuE2-3B (ComfyUI native)', 'name': job['name'], 'trigger': job.get('trigger', '')})


if __name__ == '__main__':
    main(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
