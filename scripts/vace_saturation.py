#!/usr/bin/env python
"""Does WAN VACE's `strength` SATURATE?  A re-derivation, not an inherited claim.

WHY THIS FILE EXISTS.  scripts/vace_run.mjs used to make its degenerate
reconstruction anchor out of a very large `strength` (16, and 64 as insurance),
on the reasoning that a big enough multiplier on the VACE residual must
eventually force the output to reproduce the control clip.  Reading
comfy/ldm/wan/model.py says it cannot, and this file turns that reading into a
number anyone can re-run in a second on the CPU.

THE TWO FACTS, BOTH READ OFF THE SOURCE
---------------------------------------
1. EVERY CONSUMER OF x NORMALISES IT.  x is a pure residual stream:
     WanAttentionBlock.forward (model.py:227-270)
       x = x + attn( e0 + LN1(x)*(1+e1) ) * e2      LN1 elementwise_affine=False
       x = x + cross( LN3(x) )                      LN3 affine=True, still a LN
       x = x + ffn ( e3 + LN2(x)*(1+e4) ) * e5      LN2 elementwise_affine=False
     Head.forward (model.py:371-383)
       out = W( e0 + LN(x)*(1+e1) )                 LN  elementwise_affine=False
   LayerNorm(lambda*x) == LayerNorm(x) for lambda > 0, so scaling x up does not
   scale what any block or the head READS from it -- it only shrinks each
   block's own O(1) contribution relative to x.

2. THE VACE STREAM NEVER SEES THE AMPLIFIED x.  model.py:853 is
       c_skip, c[iii] = self.vace_blocks[ii](c[iii], x=x_orig, ...)
   and VaceWanAttentionBlock.forward (model.py:292-298) uses that x ONLY at
   block_id 0 (`c = self.before_proj(c) + x`).  x_orig is the patch-embedded
   input, fixed before the first block.  So every c_skip is a CONSTANT with
   respect to vace_strength; the strength appears exactly once, at
   model.py:854, as `x += c_skip * vace_strength[iii]`.

Together: out(s) -> head( LN( sum_i c_skip_i ) ) as s -> infinity.  A FIXED
LIMIT.  Strength cannot push the output past it, and that limit is the VACE
stream's own head readout -- which is nowhere defined to be the control clip.

WHAT THIS SCRIPT DOES.  Replicates the arithmetic above with random weights and
measures the distance from out(s) to that predicted limit.  It tests the
STRUCTURE, which is what the argument rests on; the real network's weights set
the rate constant, not the shape.  That residual uncertainty is why
scripts/vace_run.mjs still renders W6 (16.00) and W7 (64.00): if the prediction
holds, two arms four-fold apart in strength come back nearly identical.

    D:\AI\aiplay-studio-bench\venv\Scripts\python.exe scripts/vace_saturation.py
"""
import numpy as np

rng = np.random.default_rng(0)
DIM, N, LAYERS, VACE_EVERY = 128, 64, 30, 2     # 1.3B: 30 blocks, 15 vace_blocks
EPS = 1e-6


def LN(x, affine=None):
    y = (x - x.mean(-1, keepdims=True)) / np.sqrt(x.var(-1, keepdims=True) + EPS)
    return y * affine[0] + affine[1] if affine else y


W = lambda a, b: rng.normal(size=(a, b)) / np.sqrt(a)
blocks = [dict(attn=W(DIM, DIM), cross=W(DIM, DIM), f1=W(DIM, 4 * DIM), f2=W(4 * DIM, DIM),
               n3=(rng.normal(size=DIM) * .1 + 1, rng.normal(size=DIM) * .1),
               e=[rng.normal(size=DIM) * .1 for _ in range(6)]) for _ in range(LAYERS)]
head = dict(w=W(DIM, DIM), e=[rng.normal(size=DIM) * .1 for _ in range(2)])

x_orig = rng.normal(size=(N, DIM))
# Frozen, and that is not a simplification: model.py:853 feeds the vace block
# x_orig, so c_skip genuinely does not depend on the strength.
c_skip = [rng.normal(size=(N, DIM)) * 0.3 for _ in range(LAYERS // VACE_EVERY)]


def block(x, b):
    x = x + (np.tanh(LN(x) * (1 + b["e"][1]) + b["e"][0]) @ b["attn"]) * b["e"][2]
    x = x + np.tanh(LN(x, b["n3"])) @ b["cross"]
    y = LN(x) * (1 + b["e"][4]) + b["e"][3]
    return x + (np.maximum(y @ b["f1"], 0) @ b["f2"]) * b["e"][5]


def head_of(x):
    return (LN(x) * (1 + head["e"][1]) + head["e"][0]) @ head["w"]


def forward(s):
    x = x_orig.copy()
    for i, b in enumerate(blocks):
        x = block(x, b)
        if i % VACE_EVERY == 0:
            x = x + c_skip[i // VACE_EVERY] * s
    return head_of(x)


limit = head_of(sum(c_skip))          # head(LN(sum c_skip)) -- LN kills the scale

print(__doc__.split("WHAT THIS SCRIPT DOES.")[0].rstrip())
print("\n  MEASURED (random weights, structure identical to model.py):\n")
print("  strength   rel. change vs half     rel. distance to limit    cos(out, limit)")
prev = None
outs = {}
for s in [0.0, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 256.0, 1000.0]:
    o = outs[s] = forward(s)
    d = "-" if prev is None else "%.6f" % (np.linalg.norm(o - prev) / np.linalg.norm(o))
    dl = np.linalg.norm(o - limit) / np.linalg.norm(limit)
    cs = float((o * limit).sum() / (np.linalg.norm(o) * np.linalg.norm(limit)))
    print("  %8.1f   %18s   %22.6f   %15.6f" % (s, d, dl, cs))
    prev = o

a, b = outs[16.0], outs[64.0]
cs = float((a * b).sum() / (np.linalg.norm(a) * np.linalg.norm(b)))
print("\n  THE ARMS THIS PREDICTS: W6 (strength 16) vs W7 (strength 64), 4x apart,")
print("  differ here by %.4f relative, cos %.6f -- i.e. barely at all."
      % (np.linalg.norm(a - b) / np.linalg.norm(b), cs))
print("  Strength is a knob between 'ignored' and ONE FIXED POINT, and that fixed")
print("  point is head(LN(sum of c_skip)) -- the VACE stream's own readout, which")
print("  nothing in the code makes equal to the control clip. So a big strength is")
print("  NOT a way to force reconstruction. Use the mask instead: control_masks=0")
print("  means 'keep this footage' in the vocabulary the model was trained on")
print("  (nodes_wan.py:341-343 + ComfyUI's own outpainting template). See W9.")
