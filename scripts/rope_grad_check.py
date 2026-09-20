"""Is the hand-derived RoPE backward in aiplay_rope_autograd.py the real one?

Run through scripts/yue2_rope_grad_test.mjs, which finds the engine's python.

WHY THIS EXISTS. A wrong derivative here does not crash. It trains, at full
speed, on gradients that point somewhere other than downhill, and hands back a
LoRA that is merely disappointing — the kind of defect that gets blamed on the
dataset, the rank, the learning rate and the model, in that order, for weeks.
So the formula is checked against autograd through a pure-torch reimplementation
of the op's own documented forward, on random tensors, in float64.
"""
import importlib.util
import os
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(HERE, "..", "server", "comfy_nodes", "aiplay_rope_autograd.py")

spec = importlib.util.spec_from_file_location("aiplay_rope_autograd", NODE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def reference_forward(t, freqs):
    """Verbatim from the op's own docstring in comfy_kitchen/__init__.py."""
    t_ = t.reshape(*t.shape[:-1], 2, -1).movedim(-2, -1).unsqueeze(-2).to(freqs.dtype)
    out = freqs[..., 0] * t_[..., 0] + freqs[..., 1] * t_[..., 1]
    return out.movedim(-1, -2).reshape(*t.shape).type_as(t)


def check(name, x, freqs, upstream, tol=1e-9):
    x = x.clone().requires_grad_(True)
    reference_forward(x, freqs).backward(upstream)
    mine = mod._rope_backward1(upstream, freqs)
    diff = (x.grad - mine).abs().max().item()
    good = diff <= tol * max(1.0, x.grad.abs().max().item())
    print(f"{'ok  ' if good else 'FAIL'} {name:34} max|autograd - ours| = {diff:.3e}")
    return good


def main():
    torch.manual_seed(7)
    ok = True

    for (B, H, T, D) in [(1, 2, 3, 8), (2, 1, 5, 16), (1, 4, 7, 64), (3, 2, 11, 128)]:
        ok &= check(f"shape {(B, H, T, D)}",
                    torch.randn(B, H, T, D, dtype=torch.float64),
                    torch.randn(T, D // 2, 2, 2, dtype=torch.float64),
                    torch.randn(B, H, T, D, dtype=torch.float64))

    # freqs broadcasting across batch and head, which is how the DiT passes them
    ok &= check("freqs broadcast over batch/head",
                torch.randn(2, 3, 4, 32, dtype=torch.float64),
                torch.randn(1, 1, 4, 16, 2, 2, dtype=torch.float64),
                torch.randn(2, 3, 4, 32, dtype=torch.float64))

    # a rotation proper — the real freqs are cos/sin, not arbitrary numbers, and
    # a formula can be right on random matrices and wrong on the structured ones
    T, half = 6, 8
    ang = torch.rand(T, half, dtype=torch.float64) * 6.283
    rot = torch.stack([torch.stack([ang.cos(), -ang.sin()], -1),
                       torch.stack([ang.sin(), ang.cos()], -1)], -2)
    ok &= check("a real rotation (cos/sin)",
                torch.randn(2, 2, T, half * 2, dtype=torch.float64), rot,
                torch.randn(2, 2, T, half * 2, dtype=torch.float64))

    print()
    print("the derivative is correct" if ok
          else "THE DERIVATIVE IS WRONG — a LoRA trained through it would learn the wrong thing")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
