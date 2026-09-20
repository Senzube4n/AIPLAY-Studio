"""THE ONE OP THAT STOOD BETWEEN YuE2 AND A LoRA YOU TRAINED YOURSELF.

Training any music LoRA here died in the same place every time:

    RuntimeError: Trying to backward through
    comfy_kitchen.apply_rope_split_half.default but no autograd formula was
    registered. Please use register_autograd to add one.

comfy_kitchen's rotary-position-embedding kernels are registered as PyTorch
custom ops with a forward and no backward, because they were written for
inference. `comfy/ldm/minimax_music/dit.py` calls them in every attention block,
and that DiT is what YuE2 rides on — so the gradient could never leave the first
attention layer, whatever the checkpoint, whatever the card. It is not a
quantisation problem and not a VRAM problem: there was simply no derivative.

This registers the derivative. Nothing else about the op changes: the forward is
still comfy_kitchen's fused CUDA kernel at full speed, and a render that never
asks for a gradient never touches a line of this file.

── THE DERIVATIVE ────────────────────────────────────────────────────────────

The op's own docstring gives the forward exactly:

    t_  = t.reshape(*t.shape[:-1], 2, -1).movedim(-2, -1).unsqueeze(-2)
    out = freqs[..., 0] * t_[..., 0] + freqs[..., 1] * t_[..., 1]
    out.movedim(-1, -2).reshape(*t.shape)

`freqs_cis` is (..., head_dim//2, 2, 2): one 2x2 matrix per rotary pair. Writing
a pair as (a, b) and that matrix as M, the forward is a plain matrix-vector
product, out_i = sum_j M[i][j] * in_j. So the derivative is the transpose —
g_in = M^T g_out — and nothing else, because `freqs_cis` is built from positions
and never carries a gradient.

⚠ THE ALGEBRA ABOVE IS NOT TAKEN ON TRUST. scripts/yue2_rope_grad_test.mjs
checks these formulas against autograd through a pure-torch reimplementation of
the same forward, on random tensors, and fails on any disagreement past
tolerance. A wrong backward here would not crash — it would train, slowly, on
gradients pointing somewhere other than downhill, and produce a LoRA that merely
underperforms. That is the worst failure available, so it gets the test.
"""

import logging

import torch

_LOG = logging.getLogger("aiplay.rope_autograd")


def _pairs(t: torch.Tensor, dtype: torch.dtype) -> torch.Tensor:
    """(..., D) -> (..., D/2, 2), matching the op's own split-half layout."""
    return t.reshape(*t.shape[:-1], 2, -1).movedim(-2, -1).to(dtype)


def _unpairs(t: torch.Tensor, like: torch.Tensor) -> torch.Tensor:
    """(..., D/2, 2) -> (..., D), the exact inverse of _pairs."""
    return t.movedim(-1, -2).reshape(*like.shape).type_as(like)


def _rope_backward1(grad_out: torch.Tensor, freqs: torch.Tensor) -> torch.Tensor:
    """g_in = M^T g_out, per rotary pair.

    The forward contracts the 2x2 over its SECOND index; the transpose contracts
    over the first, which is the whole of the change.
    """
    g = _pairs(grad_out, freqs.dtype)                       # (..., half, 2) over i
    g0 = (freqs[..., :, 0] * g).sum(-1)                     # sum over i
    g1 = (freqs[..., :, 1] * g).sum(-1)
    return _unpairs(torch.stack((g0, g1), dim=-1), grad_out)


# ── the two ops that carry a gradient ────────────────────────────────────────
# The trailing-underscore variants write in place and are documented "inference
# only"; an in-place op has no business in a graph being differentiated, so they
# are deliberately left without a formula rather than given a wrong one.

def _setup_two(ctx, inputs, output):
    _xq, _xk, freqs = inputs
    ctx.save_for_backward(freqs)


def _backward_two(ctx, grad_q, grad_k):
    (freqs,) = ctx.saved_tensors
    gq = _rope_backward1(grad_q, freqs) if grad_q is not None else None
    gk = _rope_backward1(grad_k, freqs) if grad_k is not None else None
    return gq, gk, None          # freqs_cis is a constant: no gradient


def _setup_one(ctx, inputs, output):
    _x, freqs = inputs
    ctx.save_for_backward(freqs)


def _backward_one(ctx, grad_out):
    (freqs,) = ctx.saved_tensors
    return _rope_backward1(grad_out, freqs), None


_WIRED = []


def _wire(name, backward, setup):
    """Register one formula, and never fight over an op that already has one."""
    try:
        torch.library.register_autograd(name, backward, setup_context=setup)
        _WIRED.append(name)
    except Exception as e:                                   # noqa: BLE001
        # A future comfy_kitchen that ships its own derivative must win: ours is
        # a stand-in for something missing, not a preference.
        _LOG.info("AIPLAY: leaving %s alone (%s)", name, e)


if hasattr(torch.ops, "comfy_kitchen"):
    _wire("comfy_kitchen::apply_rope_split_half", _backward_two, _setup_two)
    _wire("comfy_kitchen::apply_rope_split_half1", _backward_one, _setup_one)
    if _WIRED:
        _LOG.info("AIPLAY: rotary embeddings can be differentiated now (%s). "
                  "Training a music LoRA is possible on this engine.", ", ".join(_WIRED))
else:
    _LOG.info("AIPLAY: comfy_kitchen is not loaded; rotary ops need no patch here.")


# ComfyUI loads this file for the registration above, which happens on import.
# There is no node: a graph should not have to remember to include one, and a
# derivative that only exists when somebody wires it up is a derivative that
# will be missing on the run that matters.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
