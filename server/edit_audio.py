"""Post-generation audio edits — pure DSP, no model involved.

The model cannot take audio as input (its released VAE is decoder-only), so Suno's
Extend / Cover / Mashup / Replace-section are impossible here. But everything that
operates on the *finished file* is perfectly possible, and these are the ones that
actually get used: trim the intro, fade the end, cut a section, reverse it.

Runs in the same venv as ComfyUI so PyAV and numpy are already present.

Usage:  edit_audio.py <in.flac> <out.flac> <json-ops>

Ops, applied in the order given:
  {"op":"trim","start":s,"end":s}
  {"op":"cut","start":s,"end":s}          remove a section, crossfaded across the seam
  {"op":"join","with":path,"at":s}        splice an extension on at the resume point
  {"op":"fade","in":s,"out":s}
  {"op":"reverse"}
  {"op":"speed","rate":r}                 resample; pitch shifts with it, by design
"""
from __future__ import annotations

import json
import sys

import av
import numpy as np


def load(path: str) -> tuple[np.ndarray, int]:
    """Return (channels, samples) float32 plus the sample rate.

    ComfyUI writes 44.1 kHz s16 *packed* stereo, so PyAV hands back (1, N*ch) with
    L and R interleaved. Averaging that as-if-mono analyses alternating channels and
    produces nonsense — de-interleave explicitly and read the rate from the file.
    """
    c = av.open(path)
    st = c.streams.audio[0]
    sr, ch = st.codec_context.sample_rate, st.codec_context.channels
    planar = st.codec_context.format.is_planar
    a = np.concatenate([f.to_ndarray() for f in c.decode(audio=0)], axis=-1)
    c.close()
    a = a.astype(np.float32) / 32768.0
    if planar or a.shape[0] == ch:
        return a.reshape(ch, -1), sr
    flat = a.reshape(-1)
    usable = (len(flat) // ch) * ch
    return flat[:usable].reshape(-1, ch).T.copy(), sr


def save(path: str, data: np.ndarray, sr: int) -> None:
    """Write s16 FLAC such that load(save(x)) == x exactly.

    This used to scale by 32767 while load() scaled by 32768, and to truncate
    with .astype(int16) instead of rounding. Together those put up to one LSB of
    error on EVERY sample of an edit -- including the regions the edit never
    touched. Inaudible once, but it compounds across repeated edits and it made
    "non-destructive" untrue: a trim rewrote the whole file slightly.

    Matching the scale and rounding makes a round-trip bit-exact, which is what
    lets an extension be spliced on without disturbing the original.
    """
    ch = data.shape[0]
    out = av.open(path, "w")
    stream = out.add_stream("flac", rate=sr)
    stream.layout = "stereo" if ch == 2 else "mono"
    # Clip AFTER scaling: 1.0 * 32768 is 32768, one past int16's positive range.
    scaled = np.round(data.T.reshape(1, -1) * 32768.0)
    inter = np.clip(scaled, -32768.0, 32767.0).astype(np.int16)
    frame = av.AudioFrame.from_ndarray(inter, format="s16", layout=stream.layout)
    frame.sample_rate = sr
    for pkt in stream.encode(frame):
        out.mux(pkt)
    for pkt in stream.encode(None):
        out.mux(pkt)
    out.close()


def _xfade(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    """Equal-power crossfade, so a seam does not dip in loudness."""
    n = min(n, a.shape[1], b.shape[1])
    if n <= 0:
        return np.concatenate([a, b], axis=1)
    t = np.linspace(0, 1, n, dtype=np.float32)
    fo, fi = np.cos(t * np.pi / 2), np.sin(t * np.pi / 2)
    mid = a[:, -n:] * fo + b[:, :n] * fi
    return np.concatenate([a[:, :-n], mid, b[:, n:]], axis=1)


def apply(data: np.ndarray, sr: int, op: dict) -> np.ndarray:
    kind = op.get("op")

    if kind == "trim":
        s = int(max(0, float(op.get("start", 0))) * sr)
        e = int(float(op.get("end", data.shape[1] / sr)) * sr)
        return data[:, s:max(s + 1, e)]

    if kind == "cut":
        s = int(max(0, float(op["start"])) * sr)
        e = int(float(op["end"]) * sr)
        if e <= s:
            return data
        # Crossfade across the join so the removal is not an audible click.
        return _xfade(data[:, :s], data[:, e:], int(0.05 * sr))

    if kind == "join":
        # Splice a generated extension onto the original at the resume point.
        #
        # The model rejoined the performance at `at` seconds, so everything the
        # original played after that has been replaced -- keep [0, at) and hand
        # over to the extension. Outside the crossfade the original samples are
        # untouched, which is the property that makes a bad extension free to
        # discard.
        other, osr = load(op["with"])
        if osr != sr:
            raise SystemExit(f"sample-rate mismatch: {sr} vs {osr}")
        if other.shape[0] != data.shape[0]:
            raise SystemExit(f"channel mismatch: {data.shape[0]} vs {other.shape[0]}")
        # `from` takes only the tail of the incoming file. Merging a tree of
        # extensions needs this: every branch is a COMPLETE song (parent plus its
        # own continuation), so appending them whole would repeat the parent once
        # per branch. Skipping to each branch's own resume point appends only the
        # material that is actually new.
        frm = int(max(0.0, float(op.get("from", 0.0))) * sr)
        if frm:
            other = other[:, min(frm, other.shape[1] - 1):]
        # `at` is clamped to the length, so a deliberately huge value means
        # "append at the end" without the caller tracking a running duration.
        at = int(max(0.0, float(op.get("at", data.shape[1] / sr))) * sr)
        at = min(at, data.shape[1])
        return _xfade(data[:, :at], other, int(float(op.get("fade", 0.08)) * sr))

    if kind == "fade":
        out = data.copy()
        fi = int(float(op.get("in", 0)) * sr)
        fo = int(float(op.get("out", 0)) * sr)
        if fi > 0:
            n = min(fi, out.shape[1])
            out[:, :n] *= np.linspace(0, 1, n, dtype=np.float32)
        if fo > 0:
            n = min(fo, out.shape[1])
            out[:, -n:] *= np.linspace(1, 0, n, dtype=np.float32)
        return out

    if kind == "reverse":
        return data[:, ::-1].copy()

    if kind == "speed":
        # Straight resample: tempo and pitch move together, like a tape machine.
        # Honest and artefact-free. Pitch-preserving stretch would need a phase
        # vocoder, whose artefacts at anything past ~1.2x are worse than the effect.
        rate = float(op.get("rate", 1.0))
        if rate <= 0 or abs(rate - 1) < 1e-3:
            return data
        n_out = int(data.shape[1] / rate)
        idx = np.linspace(0, data.shape[1] - 1, n_out)
        return np.stack([np.interp(idx, np.arange(data.shape[1]), ch) for ch in data]).astype(np.float32)

    raise ValueError(f"unknown op: {kind}")


def main() -> int:
    src, dst, ops_json = sys.argv[1], sys.argv[2], sys.argv[3]
    data, sr = load(src)
    for op in json.loads(ops_json):
        data = apply(data, sr, op)
    save(dst, data, sr)
    print(json.dumps({"ok": True, "seconds": round(data.shape[1] / sr, 2), "rate": sr}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
