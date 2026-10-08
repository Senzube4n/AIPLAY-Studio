"""
REAL AUDIO INTO YuE2'S OWN TOKENS.

YuE2 writes a song as a sequence of semantic codes (32,768-way, 25 per second)
and its own runs keep them in semantic.npy, which is what a continuation
replays. The model's authors published no encoder from audio back into those
codes, so until now only a YuE2 take could be continued. This script is that
encoder, from Mothersuperior's realaudio tokenizer (Hugging Face, CC BY-NC
4.0): MERT-v2-FullSong's layer-20 features at 25 Hz, instance-normalised per
track, through an 8-layer transformer head that predicts the code at every
frame. Its published accuracy is 16 % exact codes on YuE2's own songs, with
the near-miss codes rendering almost the same (the author's ear test of a
round trip sits near 95 %) — so what comes out is the song as YuE2 would have
written it, close enough to continue, not a lossless copy.

    python yue_tokenize.py --audio song.wav --out song.semantic.npy \
        --mert <dir with config.json + model.safetensors> --head tokenizer_head_joint_v4.safetensors

Writes a 1-D int32 array of codes in [0, 32768) and prints one JSON line with
the frame count, seconds and timings. Runs on the card when there is one and
on the CPU otherwise (MERT is 632 M parameters: about a minute per song
minute on a desktop CPU, seconds on a card). Reads any format soundfile reads;
stereo is folded to mono, the rate resampled to 24 kHz.

The feature path follows the tokenizer's own prep script step for step (30 s
chunks, hidden state 20, linear interpolation to 25 frames per second, then
instance normalisation); the head is the script's `Tok` class, read off the
safetensors' own metadata line rather than trusted from memory.

MERT's rotary table is recomputed after loading (restore_rotary_inv_freq).
transformers 5 builds the model on the meta device and then swaps every
NON-persistent buffer for torch.empty_like, and MERT2's `embed_positions.inv_freq`
is one: the weights file never held it and MERT2's own _init_weights does not
refill it, so it was whatever that memory held. Until 2026-09-25 the same 20 s
file read four times gave 1, 269, 269 and 277 distinct codes (the first all
zeros from NaN logits), and unrepaired readings agreed with a correct one on
only 7 to 42 % of frames. MERT_READER names this reading; tokenize.js folds it
into the cache folder's name, so codes read before the fix
(output/yue2/tok_<sha12>) are never served again.
"""
import argparse
import json
import os
import sys
import time
from math import gcd

import numpy as np

VOCAB = 32768
WIN = 512
D = 512
LAYERS = 8
HEADS = 8
MERT_LAYER = 20
MERT_SR = 24000
CHUNK_SECONDS = 30
FRAMES_PER_SECOND = 25
# Which reading this is. 1: before the rotary table was restored (garbage under
# transformers 5). 2: restored. tokenize.js declares the same number and keys its
# cache on it; bump both whenever the same audio would read to different codes.
MERT_READER = 2


def _load_audio(path):
    import soundfile as sf
    from scipy.signal import resample_poly
    a, sr = sf.read(path, dtype="float32")
    if a.ndim == 2:
        a = a.mean(1)
    if sr != MERT_SR:
        g = gcd(int(sr), MERT_SR)
        a = resample_poly(a, MERT_SR // g, int(sr) // g).astype(np.float32)
    return np.ascontiguousarray(a, dtype=np.float32)


def _device():
    import torch
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def restore_rotary_inv_freq(model):
    """Recompute every rotary `inv_freq` buffer the way MERT2's RotaryEmbedding.__init__ does.

    modeling_mert2.py (the catalogued revision, d8ba1c7) builds it as
        head_dim = hidden_size // num_attention_heads     (1024 // 16 = 64)
        base     = rotary_embedding_base                  (10000)
        inv_freq = 1.0 / (base ** (arange(0, head_dim, 2, dtype=float32) / head_dim))
    on the CPU, registers it with persistent=False, and pins it to float32 in its
    own _apply. transformers 5 then replaces it with empty memory (see the module
    docstring). The table is rebuilt from the module's own head_dim and base,
    checked against the config, and put back on the device and in the dtype the
    loaded model gave the buffer; the cos/sin cache built from it is dropped.

    Fails loudly, never silently: no rotary buffer at all, a buffer without the
    head_dim/base this recipe reads, a disagreement with the config, a buffer that
    was never materialised, or a non-finite result each raise RuntimeError, and
    the tokenizer then answers with an error line instead of codes. So does any
    OTHER non-persistent buffer: transformers 5 empties every one of them, and
    this reader rebuilds only the rotary table (MERT2 at d8ba1c7 has no other;
    a new modeling revision or a torchaudio that stopped persisting its window
    would add one, and it would be garbage too).
    Returns the names of the buffers restored.
    """
    import torch
    others = sorted("%s.%s" % (n, b) if n else b
                    for n, m in model.named_modules()
                    for b in getattr(m, "_non_persistent_buffers_set", ())
                    if b != "inv_freq" and m._buffers.get(b) is not None)
    if others:
        raise RuntimeError("MERT has non-persistent buffers this reader does not rebuild (%s): transformers 5 leaves "
                           "every such buffer uninitialised, so it will not read with them" % ", ".join(others[:5]))
    restored = []
    cfg = getattr(model, "config", None)
    for name, module in model.named_modules():
        if "inv_freq" not in module._buffers:
            continue
        where = "%s (%s)" % (name or "<model>", type(module).__name__)
        head_dim, base = getattr(module, "head_dim", None), getattr(module, "base", None)
        if not isinstance(head_dim, int) or head_dim <= 0 or head_dim % 2 or not isinstance(base, (int, float)):
            raise RuntimeError("%s has an inv_freq buffer but not the integer head_dim and numeric base that "
                               "MERT2's RotaryEmbedding keeps; this reader will not guess how to rebuild it" % where)
        if cfg is not None and hasattr(cfg, "rotary_embedding_base"):
            want = (cfg.hidden_size // cfg.num_attention_heads, cfg.rotary_embedding_base)
            if (head_dim, base) != want:
                raise RuntimeError("%s has head_dim %s and base %s, but the config says %s and %s"
                                   % (where, head_dim, base, want[0], want[1]))
        old = module._buffers["inv_freq"]
        if old is None or old.is_meta or not old.is_floating_point():
            raise RuntimeError("%s.inv_freq was never materialised as a float tensor (%s)"
                               % (where, "None" if old is None else "%s on %s" % (old.dtype, old.device)))
        inv = 1.0 / (base ** (torch.arange(0, head_dim, 2, dtype=torch.float32, device="cpu") / head_dim))
        inv = inv.to(device=old.device, dtype=old.dtype)
        if inv.shape != old.shape or not bool(torch.isfinite(inv).all()):
            raise RuntimeError("%s.inv_freq rebuilt as %s with non-finite values or the wrong shape (the buffer is %s)"
                               % (where, list(inv.shape), list(old.shape)))
        module.inv_freq = inv   # a registered buffer: stays non-persistent
        for attr, value in (("_cos", None), ("_sin", None), ("_sequence_length", 0), ("_cache_device", None)):
            if hasattr(module, attr):
                setattr(module, attr, value)
        if not torch.equal(module._buffers["inv_freq"], inv):
            raise RuntimeError("%s.inv_freq did not keep the rebuilt table" % where)
        restored.append(name)
    if not restored:
        raise RuntimeError("MERT loaded without a rotary inv_freq buffer: this reader was written for "
                           "modeling_mert2.RotaryEmbedding (embed_positions) and will not read with an unchecked model")
    return restored


def mert_features(mono24, mert_dir, device):
    """MERT-v2-FullSong hidden state 20 for the whole track, at 25 Hz: (T, 1024) float32."""
    import torch
    from transformers import AutoFeatureExtractor, AutoModel
    proc = AutoFeatureExtractor.from_pretrained(mert_dir, trust_remote_code=True)
    model = AutoModel.from_pretrained(mert_dir, trust_remote_code=True).to(device).eval()
    restore_rotary_inv_freq(model)   # transformers 5 leaves it uninitialised; see the module docstring
    ch = MERT_SR * CHUNK_SECONDS
    chunks = [mono24[s:s + ch] for s in range(0, len(mono24), ch)]
    chunks = [c for c in chunks if len(c) >= MERT_SR]           # under a second at the end: dropped, as the reference does
    if not chunks:
        raise SystemExit(json.dumps({"error": "the audio is shorter than one second"}))
    full = [c for c in chunks if len(c) == ch]
    tail = [c for c in chunks if len(c) < ch]
    feats = []
    use_bf16 = device.type == "cuda"
    with torch.inference_mode():
        for group in ([full] if full else []) + [[c] for c in tail]:
            inp = proc(group, sampling_rate=MERT_SR, return_tensors="pt")
            inp = {k: v.to(device) for k, v in inp.items()}
            if use_bf16:
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    out = model(**inp, output_hidden_states=True)
            else:
                out = model(**inp, output_hidden_states=True)
            feats.append(out.hidden_states[MERT_LAYER].reshape(-1, 1024).float())
    h = torch.cat(feats, 0)
    t25 = int(round(len(mono24) / MERT_SR * FRAMES_PER_SECOND))
    h25 = torch.nn.functional.interpolate(h.T[None], size=t25, mode="linear", align_corners=False)[0].T
    return h25.cpu().numpy().astype(np.float32)


def instnorm(x):
    x = x.astype(np.float32)
    return (x - x.mean(0)) / (x.std(0) + 1e-5)


def build_head():
    import torch
    import torch.nn as nn

    class Tok(nn.Module):
        def __init__(self, din):
            super().__init__()
            self.inp = nn.Linear(din, D)
            self.pos = nn.Parameter(torch.zeros(1, WIN, D))
            layer = nn.TransformerEncoderLayer(D, HEADS, 4 * D, dropout=0.1, batch_first=True, norm_first=True, activation="gelu")
            self.enc = nn.TransformerEncoder(layer, LAYERS)
            self.norm = nn.LayerNorm(D)
            self.head = nn.Linear(D, VOCAB)

        def forward(self, x):
            return self.head(self.norm(self.enc(self.inp(x) + self.pos[:, :x.shape[1]])))

    return Tok(1024)


def load_head(path, device):
    import torch
    from safetensors.torch import load_file
    head = build_head()
    state = load_file(path)
    missing, unexpected = head.load_state_dict(state, strict=False)
    if missing or unexpected:
        raise SystemExit(json.dumps({"error": "the tokenizer head does not match the published architecture",
                                     "missing": missing[:5], "unexpected": unexpected[:5]}))
    return head.to(device).eval()


def predict(head, x, device):
    """Codes for every frame: 512-frame windows at half stride, a quarter window trimmed at each inner edge."""
    import torch
    t = len(x)
    out = np.zeros(t, dtype=np.int64)
    starts = list(range(0, max(1, t - WIN + 1), WIN // 2))
    if starts[-1] + WIN < t:
        starts.append(max(0, t - WIN))
    with torch.inference_mode():
        for s0 in starts:
            xw = x[s0:s0 + WIN]
            n = len(xw)
            if n < WIN:
                xw = np.pad(xw, ((0, WIN - n), (0, 0)))
            xt = torch.tensor(xw[None], device=device)
            if device.type == "cuda":
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    pred = head(xt)[0, :n].float().argmax(-1).cpu().numpy()
            else:
                pred = head(xt)[0, :n].float().argmax(-1).cpu().numpy()
            lo = s0 + (0 if s0 == 0 else WIN // 4)
            hi = s0 + n - (0 if s0 + n >= t else WIN // 4)
            out[lo:hi] = pred[lo - s0:hi - s0]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True, help="where the int32 codes go (.npy)")
    ap.add_argument("--mert", required=True, help="a local MERT-v2-FullSong folder (config, modeling code, weights)")
    ap.add_argument("--head", required=True, help="tokenizer_head_joint_v4.safetensors")
    ap.add_argument("--device", default=None, help="cuda or cpu; default: the card when there is one")
    ap.add_argument("--seconds", type=float, default=0, help="tokenize only the first N seconds (0 = all)")
    args = ap.parse_args()
    import torch
    device = torch.device(args.device) if args.device else _device()
    t0 = time.perf_counter()
    mono = _load_audio(args.audio)
    if args.seconds > 0:
        mono = mono[:int(args.seconds * MERT_SR)]
    seconds = len(mono) / MERT_SR
    t1 = time.perf_counter()
    feats = mert_features(mono, args.mert, device)
    t2 = time.perf_counter()
    head = load_head(args.head, device)
    codes = predict(head, instnorm(feats), device)
    t3 = time.perf_counter()
    codes = codes.astype(np.int32)
    if codes.min() < 0 or codes.max() >= VOCAB:
        raise SystemExit(json.dumps({"error": "a code fell outside the codec range"}))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    np.save(args.out, codes, allow_pickle=False)
    print(json.dumps({
        "ok": True, "out": args.out, "frames": int(codes.shape[0]), "seconds": round(seconds, 3),
        "framesPerSecond": FRAMES_PER_SECOND, "device": device.type, "reader": MERT_READER,
        "distinctCodes": int(len(np.unique(codes))),
        "timing": {"load": round(t1 - t0, 2), "mert": round(t2 - t1, 2), "head": round(t3 - t2, 2), "total": round(t3 - t0, 2)},
    }), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # one JSON line on stdout is the contract, whatever went wrong
        print(json.dumps({"error": "%s: %s" % (type(e).__name__, e)}), flush=True)
        sys.exit(1)
