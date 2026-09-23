"""Experimental native PyTorch attention for the exact UniRig inference call sites.

This is explicitly imported by a lab clone, not installed as flash_attn. Model
parameter names match upstream MHA's non-fused cross-attention projections.
No masks, causal mode, dropout, rotary embeddings or training are supported.
"""
import torch
from torch import nn
from torch.nn import functional as F


class NativeCrossMHA(nn.Module):
    def __init__(self, embed_dim, num_heads, cross_attn=False):
        super().__init__()
        if not cross_attn or embed_dim % num_heads:
            raise ValueError('Only UniRig cross-attention is supported')
        self.num_heads = num_heads
        self.head_dim = embed_dim // num_heads
        self.Wq = nn.Linear(embed_dim, embed_dim)
        self.Wkv = nn.Linear(embed_dim, 2 * embed_dim)
        self.out_proj = nn.Linear(embed_dim, embed_dim)

    def forward(self, x, x_kv):
        b, n, d = x.shape
        q = self.Wq(x).reshape(b, n, self.num_heads, self.head_dim).transpose(1, 2)
        k, v = self.Wkv(x_kv).reshape(b, x_kv.shape[1], 2, self.num_heads, self.head_dim).unbind(2)
        y = F.scaled_dot_product_attention(q, k.transpose(1, 2), v.transpose(1, 2))
        return self.out_proj(y.transpose(1, 2).reshape(b, n, d))


def native_varlen_qkvpacked(qkv, cu_seqlens, max_seqlen, dropout_p=0, softmax_scale=None):
    """Keep FlashAttention's exact ragged partitions, avoiding cross-object mixing."""
    if dropout_p != 0:
        raise ValueError('Lab native attention supports inference only')
    bounds = cu_seqlens.tolist()
    if bounds[0] != 0 or bounds[-1] != len(qkv) or any(b <= a or b-a > max_seqlen for a,b in zip(bounds,bounds[1:])):
        raise ValueError('Invalid cumulative sequence lengths')
    chunks = []
    # Group equal-length consecutive partitions to keep the point encoder fast.
    i = 0
    while i < len(bounds)-1:
        length = bounds[i+1]-bounds[i]
        end = i+1
        while end < len(bounds)-1 and bounds[end+1]-bounds[end] == length:
            end += 1
        packed = qkv[bounds[i]:bounds[end]].reshape(end-i, length, *qkv.shape[1:])
        q,k,v = packed.unbind(2)
        y=F.scaled_dot_product_attention(q.transpose(1,2),k.transpose(1,2),v.transpose(1,2),scale=softmax_scale)
        chunks.append(y.transpose(1,2).reshape(-1,*qkv.shape[2:]))
        i=end
    return torch.cat(chunks)
