# -*- coding: utf-8 -*-
"""DAW -- waveform peaks as a MIP-MAP, and the Voice Lab's analysis block.

  python server/daw/peaks.py mip   <audio.wav> [out.pk1]   build the mip-map
  python server/daw/peaks.py voice <audio.wav>             the analysis block
  python server/daw/peaks.py probe                         what this speaks

Both are also engine.py MODES (`peaks_mip`, `voice_analyse`) so they run on
the WARM serve child instead of paying ~300 ms of interpreter + numpy start
per knob turn. The measurement that forced that: one note renders in 4-12 ms
(SPEC 0.3), so a cold analysis process would be forty times the cost of the
thing it is analysing.

── WHY A MIP-MAP AND NOT A BUCKET LIST ──────────────────────────────────────
web/daw.js caches ONE resolution, 900 buckets, channel 0 only, rectified. On
a 3-minute take that is 9 600 samples a bucket: zoom to a single bar and 900
pixels of canvas are drawn from TEN numbers. This module keeps four stages --
8 / 64 / 512 / 4 096 samples per peak -- so that same bar has 12 000 peaks to
draw from, built once per file for a measured 72 ms (SPEC 0.4).

Three details that are not decoration:

  MIN AND MAX, not abs-max. A rectified envelope hides asymmetry and DC, and
  asymmetry is exactly what a saturator or a badly-tuned kick looks like.

  BOTH CHANNELS. A width move that only touches the right channel is
  invisible in a channel-0 waveform, and hat_width is such a move.

  COARSE STAGES ARE BUILT FROM THE FINER ONE, never from the samples again.
  That makes the bounding property EXACT rather than approximate: a coarse
  peak's [min, max] contains every fine peak beneath it by construction, and
  peaks_test.js checks it holds after quantisation too (rounding is monotone,
  so it does).

── THE FILE FORMAT ──────────────────────────────────────────────────────────
  bytes 0..3     "PKS1"
  bytes 4..7     uint32 LE header length H
  bytes 8..8+H   UTF-8 JSON header (below)
  then           int16 LE body

Body layout: stage after stage; inside a stage, channel-major; inside a
channel, [min, max] interleaved per peak. So peak i of channel c of a stage
sits at int16 index  stage.offset + c*stage.count*2 + 2*i.

int16 with a per-file `scale` rather than float32: it halves the sidecar (a
7.5 s stereo region costs 360 KB instead of 720 KB) and the quantisation
error is scale/32767 -- 90 dB under the file's own peak, which no waveform
canvas can show. The scale is IN the header because a post-fader stem can be
louder than 1.0 and clamping it to 1.0 would draw a lie.
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys
import time

import numpy as np

PK_MAGIC = b"PKS1"
PK_VERSION = 1

# 8 / 64 / 512 / 4096 samples per peak. Each stage is 8x the last, which is
# what lets every coarse stage be reduced from the one before it.
SHIFTS = (3, 6, 9, 12)
Q = 32767.0

# ---------------------------------------------------------------- reading


def _ceil_div(a, b):
    return -(-a // b)


def read_channels(path, want_sr=None):
    """(channels, n) float64 in the file's own units, plus the rate.

    The float32 RIFF the DAW writes is parsed here directly -- every region,
    stem and preview in this app is one, and going through PyAV for them
    would cost an import we do not need. Anything else falls through to PyAV,
    which is already a dependency of the app's other peaks path.

    NOT normalised and NOT clipped: a post-fader stem legitimately exceeds
    1.0 and the caller is told the scale instead of being handed a lie.
    """
    try:
        return _read_riff(path)
    except _NotRiff:
        pass
    return _read_pyav(path)


class _NotRiff(Exception):
    pass


def _read_riff(path):
    with open(path, "rb") as f:
        raw = f.read()
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise _NotRiff(path)
    pos, sr, ch, fmt, bits, data = 12, None, None, None, None, None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body = raw[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt, ch, sr = struct.unpack("<HHI", body[:8])
            bits = struct.unpack("<H", body[14:16])[0]
        elif cid == b"data":
            data = body
        pos += 8 + size + (size & 1)
    if sr is None or data is None:
        raise _NotRiff(path)
    if fmt == 3 and bits == 32:
        a = np.frombuffer(data, dtype="<f4").astype(np.float64)
    elif fmt == 1 and bits == 16:
        a = np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0
    else:
        raise _NotRiff(path)                     # let PyAV have it
    ch = max(1, int(ch or 1))
    usable = (a.size // ch) * ch
    return np.ascontiguousarray(a[:usable].reshape(-1, ch).T), int(sr)


def _read_pyav(path):
    import av                                     # deferred: RIFF needs none
    c = av.open(path)
    st = c.streams.audio[0]
    sr = st.codec_context.sample_rate
    ch = st.codec_context.channels
    planar = st.codec_context.format.is_planar
    name = st.codec_context.format.name
    frames = [f.to_ndarray() for f in c.decode(audio=0)]
    c.close()
    if not frames:
        raise ValueError(f"no audio frames in {path}")
    a = np.concatenate(frames, axis=-1)
    # FORMAT-AWARE scale. server/peaks.py divides everything by 32768 because
    # it was written against s16 ComfyUI output; on a float file that reads
    # the whole waveform as silence. Reported as a finding rather than fixed
    # in place there, because that path's numbers are another strand's.
    if a.dtype.kind == "i":
        a = a.astype(np.float64) / float(1 << (a.dtype.itemsize * 8 - 1))
    else:
        a = a.astype(np.float64)
    if planar or (a.ndim == 2 and a.shape[0] == ch):
        out = np.ascontiguousarray(a.reshape(ch, -1))
    else:
        flat = a.reshape(-1)
        usable = (flat.size // ch) * ch
        out = np.ascontiguousarray(flat[:usable].reshape(-1, ch).T)
    _ = name
    return out, int(sr)


# ---------------------------------------------------------------- the mip


def _stage_from_samples(x, spp):
    """min/max of every `spp`-sample block, the ragged tail included and NOT
    zero-padded -- padding would put a false 0 into the last peak, which on a
    fade-out is exactly the sample a reader would zoom in to check."""
    n = x.size
    count = max(1, _ceil_div(n, spp)) if n else 0
    mn = np.empty(count, dtype=np.float64)
    mx = np.empty(count, dtype=np.float64)
    full = n // spp
    if full:
        b = x[:full * spp].reshape(full, spp)
        mn[:full] = b.min(axis=1)
        mx[:full] = b.max(axis=1)
    if n % spp:
        tail = x[full * spp:]
        mn[full] = tail.min()
        mx[full] = tail.max()
    return mn, mx


def _reduce_stage(mn, mx, factor):
    """A coarser stage FROM the finer one: min of mins, max of maxes."""
    n = mn.size
    count = max(1, _ceil_div(n, factor)) if n else 0
    o_mn = np.empty(count, dtype=np.float64)
    o_mx = np.empty(count, dtype=np.float64)
    full = n // factor
    if full:
        o_mn[:full] = mn[:full * factor].reshape(full, factor).min(axis=1)
        o_mx[:full] = mx[:full * factor].reshape(full, factor).max(axis=1)
    if n % factor:
        o_mn[full] = mn[full * factor:].min()
        o_mx[full] = mx[full * factor:].max()
    return o_mn, o_mx


def build_mip(path, out=None):
    """Build every stage once and write the sidecar. Returns the header."""
    t0 = time.perf_counter()
    x, sr = read_channels(path)
    ch, n = x.shape
    out = out or (path + ".pk1")
    scale = float(np.max(np.abs(x))) if n else 0.0
    if not (scale > 0.0) or not math.isfinite(scale):
        scale = 1.0
    stages, blocks, offset = [], [], 0
    cur = None
    for i, shift in enumerate(SHIFTS):
        spp = 1 << shift
        if i == 0:
            cur = [_stage_from_samples(x[c], spp) for c in range(ch)]
        else:
            factor = 1 << (shift - SHIFTS[i - 1])
            cur = [_reduce_stage(mn, mx, factor) for mn, mx in cur]
        count = cur[0][0].size if cur else 0
        for mn, mx in cur:
            inter = np.empty(count * 2, dtype=np.float64)
            inter[0::2] = mn
            inter[1::2] = mx
            q = np.clip(np.rint(inter / scale * Q), -Q, Q).astype("<i2")
            blocks.append(q)
        stages.append({"shift": shift, "spp": spp, "count": int(count),
                       "offset": offset, "values": int(ch * count * 2)})
        offset += ch * count * 2
    body = b"".join(b.tobytes() for b in blocks)
    header = {
        "version": PK_VERSION, "rate": int(sr), "channels": int(ch),
        "samples": int(n), "seconds": round(n / sr, 4) if sr else 0.0,
        "scale": scale, "shifts": list(SHIFTS), "stages": stages,
        "dtype": "int16le",
        "layout": "stage -> channel-major -> [min,max] interleaved per peak",
        "decode": "value = int16 * scale / 32767",
        "source": os.path.basename(path),
    }
    hb = json.dumps(header, separators=(",", ":")).encode("utf-8")
    tmp = out + f".tmp-{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(PK_MAGIC)
        f.write(struct.pack("<I", len(hb)))
        f.write(hb)
        f.write(body)
    os.replace(tmp, out)
    header["file"] = out
    header["bytes"] = 8 + len(hb) + len(body)
    header["ms"] = round((time.perf_counter() - t0) * 1000, 2)
    header["ok"] = True
    return header


def peaks_mip(job):
    """engine.py MODE `peaks_mip`: { file, out? } -> the header, built once."""
    path = job.get("file")
    if not path:
        raise ValueError("peaks_mip needs `file`.")
    out = job.get("out") or (path + ".pk1")
    if job.get("reuse", True) and os.path.exists(out):
        try:
            h = read_header(out)
            h.update({"ok": True, "file": out, "cached": True, "ms": 0.0})
            return h
        except Exception:                          # noqa: BLE001 -- rebuild
            pass
    h = build_mip(path, out)
    h["cached"] = False
    return h


def read_header(path):
    with open(path, "rb") as f:
        magic = f.read(4)
        if magic != PK_MAGIC:
            raise ValueError(f"not a {PK_MAGIC.decode()} peaks file: {path}")
        hlen = struct.unpack("<I", f.read(4))[0]
        return json.loads(f.read(hlen).decode("utf-8"))


def stage_for(samples_per_pixel):
    """The stage a drawing at this zoom should read: the COARSEST stage whose
    peaks are still at least one per pixel, and the finest stage when the
    zoom is finer than that. Monotone non-decreasing in the zoom, which is
    the property that stops a drag from flickering between resolutions."""
    spp = float(samples_per_pixel)
    chosen = SHIFTS[0]
    for shift in SHIFTS:
        if (1 << shift) <= spp:
            chosen = shift
    return chosen


# ----------------------------------------------------- the Voice Lab block
#
# THE ONE RULE HERE: the nine bands come from ear.py, imported, never copied.
# A second copy of BANDS is a second opinion, and the Ear's cards and the
# Voice Lab's spectrum have to be the same measurement or the panel teaches
# the user something the critic will contradict.
#
# AND: PER CHANNEL. ear.spectral_balance folds to mono before it measures
# (x.mean(axis=0)), which is right for a mix critique and wrong for a voice:
# with hat_width's right-channel allpass the two channels' air bands differ
# by nearly a decibel, and a mono fold reports neither of them. So the block
# carries L, R and mid, and mid IS the fold -- the same number ear.py would
# have printed, kept so the two never disagree.


def _ear():
    import ear                                     # deferred: keeps import cheap
    return ear


def envelope_db(x, sr, hop_ms=1.0, win_ms=6.0):
    """A short-window RMS envelope in dB, and the hop it was measured at.
    Same hop/window as refprofile.py's kick_shape, so a Voice Lab decay and a
    reference profile's decay are the same measurement."""
    x = np.asarray(x, dtype=np.float64).ravel()
    hop = max(1, int(round(hop_ms * sr / 1000.0)))
    win = max(hop, int(round(win_ms * sr / 1000.0)))
    if x.size < win:
        x = np.pad(x, (0, win - x.size))
    n_frames = 1 + (x.size - win) // hop
    e = np.empty(n_frames)
    for i in range(n_frames):
        seg = x[i * hop: i * hop + win]
        e[i] = math.sqrt(float(np.mean(np.square(seg))))
    return e, hop / sr


def decay_times(e, dt):
    """t10 / t30 / t60 from the envelope's own peak, plus the attack.

    Every one of them can honestly be None: a 2-second render of a pad never
    falls 60 dB, and reporting a made-up t60 there is how a knob gets set to
    a number nobody measured."""
    if e.size == 0:
        return {"peak_db": None, "attack_ms": None,
                "t10_ms": None, "t30_ms": None, "t60_ms": None}
    pk = float(e.max())
    if pk <= 0:
        return {"peak_db": None, "attack_ms": None,
                "t10_ms": None, "t30_ms": None, "t60_ms": None}
    db = 20.0 * np.log10(np.maximum(e / pk, 1e-9))
    i_pk = int(np.argmax(e))

    def first_below(level):
        w = np.flatnonzero(db[i_pk:] <= level)
        return round(float(w[0]) * dt * 1000.0, 2) if w.size else None

    return {
        "peak_db": round(20.0 * math.log10(max(pk, 1e-12)), 2),
        "attack_ms": round(i_pk * dt * 1000.0, 2),
        "t10_ms": first_below(-10.0),
        "t30_ms": first_below(-30.0),
        "t60_ms": first_below(-60.0),
        "measured_over_ms": round(e.size * dt * 1000.0, 1),
    }


def third_octave(x, sr, n_fft=8192):
    """1/3-octave bands as a dB SHARE of the total -- the rate-invariant,
    gain-invariant curve refprofile.py compares references with. Bands whose
    upper edge is past Nyquist are dropped rather than reported as empty."""
    x = np.asarray(x, dtype=np.float64).ravel()
    if x.size < n_fft:
        x = np.pad(x, (0, n_fft - x.size))
    w = np.hanning(n_fft)
    wsum = float(np.sum(w ** 2))
    hop = n_fft // 2
    n_frames = 1 + (x.size - n_fft) // hop
    P = np.zeros(n_fft // 2 + 1)
    for i in range(n_frames):
        seg = x[i * hop: i * hop + n_fft] * w
        P += (np.abs(np.fft.rfft(seg)) ** 2) * (2.0 / (wsum * n_fft))
    P /= max(1, n_frames)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    rows, powers = [], []
    k = -16                                        # 25 Hz, ISO's usual start
    while True:
        fc = 1000.0 * (2.0 ** (k / 3.0))
        lo, hi = fc / (2.0 ** (1.0 / 6.0)), fc * (2.0 ** (1.0 / 6.0))
        if lo >= sr / 2.0:
            break
        if hi <= sr / 2.0:
            idx = np.flatnonzero((freqs >= lo) & (freqs < hi))
            p = float(P[idx].sum()) if idx.size else 0.0
            rows.append({"hz": round(fc, 1), "lo": round(lo, 1), "hi": round(hi, 1)})
            powers.append(p)
        k += 1
    tot = float(np.sum(powers))
    for r, p in zip(rows, powers):
        r["share_db"] = round(10.0 * math.log10(max(p / tot, 1e-12)), 2) if tot > 0 else -120.0
    return {"bands": rows, "n": len(rows),
            "note": "dB share of the total, so it does not move when the "
                    "gain does -- the property a reference comparison rests on."}


def column_peaks(x, columns):
    """min/max per drawing column for ONE channel -- the cheap picture the
    panel opens with, before anyone zooms into the mip-map."""
    n = x.size
    if n == 0 or columns <= 0:
        return [], []
    step = max(1, n // int(columns))
    full = n // step
    b = x[:full * step].reshape(full, step)
    mn, mx = b.min(axis=1), b.max(axis=1)
    return ([round(float(v), 4) for v in mn], [round(float(v), 4) for v in mx])


def voice_analyse(job):
    """engine.py MODE `voice_analyse`: one rendered note -> the picture.

    job: { file, columns?, genre?, third_octave?, envelope?, peaks? }
    """
    t0 = time.perf_counter()
    path = job.get("file")
    if not path:
        raise ValueError("voice_analyse needs `file`.")
    x, sr = read_channels(path)
    ch, n = x.shape
    L = x[0]
    R = x[1] if ch > 1 else x[0]
    mid = (L + R) * 0.5
    columns = int(job.get("columns") or 900)
    columns = max(16, min(columns, 4000))
    genre = str(job.get("genre") or "neutral")

    # ── THE MONO SHORT-CIRCUIT, and it is a measurement, not a guess ──────
    # Every default Voice Lab preview is the P0 mono job, so L, R and mid are
    # the SAME array -- and (a + a) * 0.5 is exactly a in IEEE-754, so `mid`
    # is not merely close, it is identical. Measuring it three times cost
    # 110.5 ms on tr909 against a 100 ms budget; measuring it once costs a
    # third of that and returns byte-for-byte the same numbers. Dual-mono
    # STEREO files take the same path, because dual mono is what the rack
    # produces whenever mixer.stereo is off.
    # `force_per_channel` exists so a test can run the long way round and
    # compare -- a shortcut nobody can switch off is a shortcut nobody can
    # check.
    same = bool((ch < 2 or np.array_equal(L, R))
                and not job.get("force_per_channel"))

    def per_channel(fn):
        if same:
            r = fn(L)
            return {"L": r, "R": r, "mid": r}
        return {"L": fn(L), "R": fn(R), "mid": fn(mid)}

    out = {
        "ok": True, "file": os.path.basename(path), "rate": int(sr),
        "channels": int(ch), "samples": int(n),
        "seconds": round(n / sr, 4) if sr else 0.0,
        "peak": round(float(np.max(np.abs(x))) if n else 0.0, 6),
        "mono": same,
        "measured_once": same,
    }
    if job.get("peaks", True):
        def _cols(sig):
            mn, mx = column_peaks(sig, columns)
            return {"min": mn, "max": mx}
        cols = {"L": _cols(L)}
        cols["R"] = cols["L"] if same else _cols(R)
        out["peaks"] = {"columns": len(cols["L"]["min"]),
                        "samples_per_column": max(1, n // columns) if n else 0,
                        "channels": cols,
                        "note": "min AND max, per channel -- a rectified "
                                "envelope hides asymmetry and DC."}
    if job.get("spectrum", True):
        ear = _ear()
        bands = per_channel(lambda sig: ear.spectral_balance(sig, sr, genre))
        # The one number a reader wants at a glance: how far apart the two
        # channels are, band by band. dual-mono reads exactly 0.0 everywhere.
        lr = [round(l["level_db"] - r["level_db"], 2)
              for l, r in zip(bands["L"]["bands"], bands["R"]["bands"])]
        out["spectrum"] = {
            "source": "ear.spectral_balance -- the SAME nine bands and the "
                      "same pink reference the Ear's cards are written from.",
            "genre": genre,
            "band_labels": list(ear.BAND_LABELS),
            "band_names": list(ear.BAND_NAMES),
            "per_channel": bands,
            "l_minus_r_db": lr,
            "widest_band": (ear.BAND_NAMES[int(np.argmax(np.abs(lr)))]
                            if lr else None),
            "mid_is_the_fold": "mid is (L+R)/2 -- the number ear.py itself "
                               "would print, kept beside L and R so the two "
                               "views can never disagree.",
        }
        if job.get("third_octave", True):
            out["third_octave"] = per_channel(lambda sig: third_octave(sig, sr))
    if job.get("envelope", True):
        def _env(sig):
            e, dt = envelope_db(sig, sr)
            pk = float(e.max()) if e.size else 0.0
            db = (20.0 * np.log10(np.maximum(e / pk, 1e-9))) if pk > 0 else np.zeros(e.size)
            row = decay_times(e, dt)
            row["hop_ms"] = round(dt * 1000.0, 3)
            # Downsample the drawn curve to <= 600 points; the numbers above
            # are measured on the full-rate envelope, not on this.
            keep = max(1, e.size // 600)
            row["db"] = [round(float(v), 2) for v in db[::keep]]
            row["db_hop_ms"] = round(dt * keep * 1000.0, 3)
            return row
        out["envelope"] = per_channel(_env)
        out["envelope_note"] = ("t10/t30/t60 are measured from the envelope's "
                                "own peak and are null when the render is not "
                                "long enough to reach them -- a pad in a 2 s "
                                "window has no honest t60.")
    out["ms"] = round((time.perf_counter() - t0) * 1000, 2)
    return out


# The zoom sweep `probe` publishes so the JS half can be held to THIS rule
# rather than to a second reading of it. peaks_test.js walks it and compares
# voicelab.js's stageFor value by value -- the only way two languages agree
# on a rule is if one of them is checked against the other.
STAGE_SWEEP = [0.5, 1, 4, 7, 8, 9, 63, 64, 65, 511, 512, 513,
               4095, 4096, 4097, 100000]


def probe(job=None):
    return {"ok": True, "peaks": PK_MAGIC.decode(), "version": PK_VERSION,
            "shifts": list(SHIFTS), "quant": "int16 + per-file scale",
            "stage_sweep": [[s, stage_for(s)] for s in STAGE_SWEEP],
            "modes": ["peaks_mip", "voice_analyse"]}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(json.dumps({"ok": False, "error": "usage: peaks.py <mip|voice|probe> <file>"}))
        return 2
    cmd = argv[0]
    try:
        if cmd == "probe":
            print(json.dumps(probe()))
            return 0
        if cmd == "mip":
            out = argv[2] if len(argv) > 2 else None
            print(json.dumps(peaks_mip({"file": argv[1], "out": out, "reuse": False})))
            return 0
        if cmd == "voice":
            print(json.dumps(voice_analyse({"file": argv[1]})))
            return 0
        raise ValueError(f"unknown command {cmd}")
    except Exception as exc:                        # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
