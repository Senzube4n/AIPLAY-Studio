"""DAW -- the capture codecs. [DAWREC]

  python server/daw/capture.py encode <job.json>   raw f32 PCM -> FLAC take
  python server/daw/capture.py decode <job.json>   any audio file -> raw f32 PCM
  python server/daw/capture.py probe  <job.json>   what a file actually is

One JSON line out, the engine.py contract -- but NO serve mode: encoding a
take happens once per take, not once per edit, so the ~300 ms interpreter
launch is noise here and a second resident child would be a second thing to
leak.

── WHY FLAC, AND EXACTLY WHICH FLAC ────────────────────────────────────────
A recorded take is the one asset in this DAW that cannot be regenerated: a
synth note re-renders from its seed, a region re-renders from the doc, but a
performance happens once. So takes are stored LOSSLESSLY -- FLAC via PyAV
(the audio agent's idiom), 24-bit:

  float32 in [-1, 1]  ->  round(x * 8388607) << 8  as s32  ->  flac
  flac s32 frame      ->  v / 2**31                -> float

Measured on this rig (PyAV 17.1.0): the round trip's worst error is
1.2e-7 -- the 24-bit quantisation floor, nothing else. The browser's capture
is float32 but no microphone ADC exceeds 24 bits, so nothing real is lost.

If PyAV is missing the encoder degrades HONESTLY: the take lands as float32
WAV (bit-exact, larger), the reply says format "wav", and the caller stores
that name -- nothing anywhere assumes the extension.

── DECODE IS THE IMPORT SEAM ───────────────────────────────────────────────
`decode` turns anything ffmpeg can read (mp3, m4a, flac, wav, ogg -- the
daw_import_audio path, and the demucs-stems seam the fork will call) into
raw f32 at the PROJECT rate. Imports opt into stereo preservation; recording
and comp callers keep the mono default. Resampling is
libswresample via av.AudioResampler. The engine then never resamples: every
file it mixes is already at the project rate, by construction, here.
"""
import json
import math
import os
import struct
import sys

import numpy as np

DEFAULT_SR = 48000
ENC_FRAME = 32768          # < the FLAC spec's 65535-sample frame ceiling

# ---------------------------------------------------------------- wav i/o
# engine.py's minimal float32 RIFF pair, duplicated so this file stands alone
# (capture must keep working when the render engine is being rebuilt).


def write_wav_f32(path, y, sr):
    y = np.asarray(y, dtype="<f4")
    channels = y.shape[1] if y.ndim == 2 else 1
    data = y.tobytes()
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 3, channels, sr, sr * 4 * channels, 4 * channels, 32))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


def read_wav_f32(path, preserve_stereo=False):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    pos, sr, data = 12, None, None
    while pos + 8 <= len(raw):
        cid, size = raw[pos:pos + 4], struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body = raw[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt, ch, sr = struct.unpack("<HHI", body[:8])
            if fmt != 3 or ch not in (1, 2):
                raise ValueError("expected float32 mono or stereo wav")
        elif cid == b"data":
            data = np.frombuffer(body, dtype="<f4")
        pos += 8 + size + (size & 1)
    if sr is None or data is None:
        raise ValueError("missing fmt or data chunk")
    if ch == 2:
        data = data.reshape(-1, 2)
        if not preserve_stereo:
            data = data.mean(axis=1)
    return data.copy(), sr


def _have_av():
    try:
        import av  # noqa: F401
        return True
    except Exception:
        return False

# ---------------------------------------------------------------- encode


def encode(job):
    """job: { sr, raw, out, channels=1 } -- raw is interleaved little-endian
    float32 PCM; out names a
    .flac path. Returns the path actually written (falls back to .wav when
    PyAV is absent) so the caller stores the truth, not the intent."""
    sr = int(job.get("sr") or DEFAULT_SR)
    channels = int(job.get("channels") or 1)
    if channels not in (1, 2):
        raise ValueError("encode channels must be 1 or 2")
    raw_path = job.get("raw")
    out = job.get("out")
    if not raw_path or not os.path.isfile(raw_path):
        raise ValueError("encode needs a 'raw' path to little-endian float32 PCM")
    if not out:
        raise ValueError("encode needs an 'out' path")
    if os.path.getsize(raw_path) % (4 * channels):
        raise ValueError("raw PCM does not contain complete audio frames")
    x = np.fromfile(raw_path, dtype="<f4")
    if not len(x):
        raise ValueError("the capture is empty -- nothing to encode")
    if not np.isfinite(x).all():
        raise ValueError("audio contains non-finite samples")
    n_samples = len(x) // channels
    peak = float(np.max(np.abs(x)))

    # A floating-point stem may legitimately carry headroom above 0 dBFS.
    # Preserve it as float WAV; converting it to fixed-point FLAC would clip
    # irreversibly before the user can lower its track fader.
    have_av = _have_av()
    if not have_av or peak > 1.0:
        out = os.path.splitext(out)[0] + ".wav"
        write_wav_f32(out, x.reshape(-1, channels), sr)
        return {"ok": True, "out": out, "format": "wav", "sr": sr,
                "channels": channels, "n_samples": n_samples, "seconds": round(n_samples / sr, 3),
                "peak": round(peak, 6),
                "note": ("Audio exceeds full scale -- preserved as float32 wav so importing does not clip it"
                         if peak > 1.0 else
                         "PyAV is not importable in this python -- stored as float32 wav (bit-exact, just larger)")}

    import av
    i32 = (np.clip(x.astype(np.float64), -1.0, 1.0) * 8388607.0).round().astype(np.int64)
    i32 = (i32 << 8).astype(np.int32)          # left-justified 24-in-32
    container = av.open(out, "w")
    stream = container.add_stream("flac", rate=sr)
    stream.codec_context.format = "s32"
    layout = "stereo" if channels == 2 else "mono"
    stream.codec_context.layout = layout
    for start in range(0, len(i32), ENC_FRAME * channels):
        chunk = i32[start:start + ENC_FRAME * channels]
        frame = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s32", layout=layout)
        frame.sample_rate = sr
        for pkt in stream.encode(frame):
            container.mux(pkt)
    for pkt in stream.encode(None):
        container.mux(pkt)
    container.close()
    return {"ok": True, "out": out, "format": "flac", "sr": sr,
            "channels": channels, "n_samples": n_samples, "seconds": round(n_samples / sr, 3),
            "peak": round(peak, 6), "bytes": os.path.getsize(out)}

# ---------------------------------------------------------------- decode


def _decode_av(path, target_sr, preserve_stereo=False):
    import av
    container = av.open(path)
    astreams = container.streams.audio
    if not astreams:
        raise ValueError(f"{os.path.basename(path)} has no audio stream")
    src = astreams[0]
    src_sr = int(src.rate or 0)
    src_ch = int(getattr(src, "channels", 0) or (src.layout.nb_channels if src.layout else 0) or 1)
    channels = 2 if preserve_stereo and src_ch > 1 else 1
    resampler = av.AudioResampler(format="flt", layout="stereo" if channels == 2 else "mono", rate=target_sr)
    parts = []

    def push(frame):
        for rf in resampler.resample(frame):
            a = rf.to_ndarray()
            parts.append(np.asarray(a, dtype=np.float32).reshape(-1))

    for frame in container.decode(audio=0):
        push(frame)
    push(None)                                  # flush the resampler's tail
    container.close()
    y = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    codec = src.codec_context.name if src.codec_context else "?"
    return y, src_sr, src_ch, codec, channels


def decode(job):
    """Decode to interleaved raw f32 at the project rate. Recording/comp
    callers keep the mono default; imports request preserve_stereo=True.
    n_samples counts audio frames, not interleaved channel values."""
    path = job.get("path")
    sr = int(job.get("sr") or DEFAULT_SR)
    out = job.get("out")
    preserve_stereo = job.get("preserve_stereo") is True
    if not path or not os.path.isfile(path):
        raise ValueError(f"decode: no such file: {path}")
    if not out:
        raise ValueError("decode needs an 'out' path for the raw PCM")
    if _have_av():
        y, src_sr, src_ch, codec, channels = _decode_av(path, sr, preserve_stereo)
    else:
        if not path.lower().endswith(".wav"):
            raise ValueError("PyAV is not importable in this python -- only float32 wav can be decoded without it")
        y, src_sr = read_wav_f32(path, preserve_stereo=True)
        src_ch = y.shape[1] if y.ndim == 2 else 1
        channels = src_ch if preserve_stereo else 1
        if src_ch == 2 and not preserve_stereo:
            y = y.mean(axis=1)
        y = y.reshape(-1)
        codec = "pcm_f32le"
        if src_sr != sr:
            raise ValueError(f"wav is {src_sr} Hz, wanted {sr} -- resampling needs PyAV")
    if not len(y):
        raise ValueError(f"{os.path.basename(path)} decoded to zero samples")
    if not np.isfinite(y).all():
        raise ValueError("audio contains non-finite samples")
    np.asarray(y, dtype="<f4").tofile(out)
    n_samples = len(y) // channels
    return {"ok": True, "out": out, "sr": sr, "channels": channels, "n_samples": n_samples,
            "seconds": round(n_samples / sr, 3),
            "src_sr": src_sr, "src_channels": src_ch, "codec": codec}

# ---------------------------------------------------------------- probe


def probe(job):
    path = job.get("path")
    if not path or not os.path.isfile(path):
        raise ValueError(f"probe: no such file: {path}")
    if _have_av():
        import av
        c = av.open(path)
        st = c.streams.audio[0] if c.streams.audio else None
        if st is None:
            raise ValueError("no audio stream")
        dur = float(st.duration * st.time_base) if st.duration else (
            float(c.duration / 1e6) if c.duration else None)
        r = {"ok": True, "av": True, "sr": int(st.rate or 0),
             "channels": int(getattr(st, "channels", 0) or 1),
             "codec": st.codec_context.name if st.codec_context else "?",
             "seconds": round(dur, 3) if dur else None}
        c.close()
        return r
    y, sr = read_wav_f32(path, preserve_stereo=True)
    return {"ok": True, "av": False, "sr": sr, "channels": y.shape[1] if y.ndim == 2 else 1,
            "codec": "pcm_f32le", "seconds": round(len(y) / sr, 3)}


MODES = {"encode": encode, "decode": decode, "probe": probe}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) < 2:
            raise ValueError("usage: capture.py <encode|decode|probe> <job.json>")
        mode, job_path = argv[0], argv[1]
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode}")
        with open(job_path, encoding="utf-8") as fh:
            job = json.load(fh)
        result = MODES[mode](job)
    except Exception as exc:                               # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
