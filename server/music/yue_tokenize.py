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


def mert_features(mono24, mert_dir, device):
    """MERT-v2-FullSong hidden state 20 for the whole track, at 25 Hz: (T, 1024) float32."""
    import torch
    from transformers import AutoFeatureExtractor, AutoModel
    proc = AutoFeatureExtractor.from_pretrained(mert_dir, trust_remote_code=True)
    model = AutoModel.from_pretrained(mert_dir, trust_remote_code=True).to(device).eval()
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
        "framesPerSecond": FRAMES_PER_SECOND, "device": device.type,
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
