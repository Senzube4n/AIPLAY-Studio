"""DAW -- the render engine. P0-1 of the DAW plan.

  python server/daw/engine.py render    <job.json>   one bar-region to a wav
  python server/daw/engine.py chirp     <job.json>   the calibration sweep
  python server/daw/engine.py calibrate <job.json>   loopback offset estimate
  python server/daw/engine.py probe     <job.json>   what this engine speaks
  python server/daw/engine.py serve                  the same four, over stdin

The contract is server/vfx/engine.py's: a job file (or line) in, one JSON
line out, `serve` from day one so the ~300 ms of interpreter+numpy startup is
paid once per session instead of once per edit -- the whole point of this
prototype is the stopwatch on edit-to-audible, and an interpreter launch per
region would be a third of the budget gone before a sample is computed.

── PLACEMENT IS ABSOLUTE, SEAMS ARE EXACT ──────────────────────────────────
A render job names an absolute sample window [start_sample, start_sample +
n_samples) and a list of notes with ABSOLUTE start samples (store.js computed
them from the meter/tempo maps; seconds crossed the boundary there, once).
Every note is synthesised in full and added into the window at its global
offset, in the job's (deterministic) order, accumulating in float64; the
master curve (tanh) is memoryless. Consequence, proven in engine_test.py: a
region render is BIT-IDENTICAL to the same window sliced out of a
whole-project render -- stitching regions is exact by construction, no
crossfade, no click, because there is no seam in the mathematics, only in
the file layout.

That proof leans on one invariant: a voice is EXACTLY zero at and beyond
dur + TAIL[instrument]. The store's region hasher uses the same table to
decide which notes can reach a region; a voice that whispered past its
declared tail would be a note the hasher legitimately excluded and the
renderer audibly included -- the classic silent seam. So every synth here
hard-gates its buffer to the declared length, the fade to zero is part of
the envelope, and the test asserts the final samples are exactly 0.

── THE SOUND, honestly ─────────────────────────────────────────────────────
Prototype-grade on purpose (the bet is the loop, not the timbre):
  pluck  Karplus-Strong via one long IIR comb -- the measured, tested code
         from the AMT eval (C:/temp/amt_eval/synth.py), with a note-off
         release so a held note damps like a string, and the +-3 cent
         humanisation seeded PER NOTE so a re-render is bit-identical.
  pad    two detuned saws through a one-pole lowpass with an ADSR -- the
         cheapest polyphonic pad that still sounds like a synth.
  drums  synthesised kit on GM-ish keys (36 kick, 38/40 snare, 42/44 hat,
         46 open hat, 49/57 crash, toms elsewhere) -- no samples, no disk.
"""
import json
import math
import os
import struct
import sys
import time

import numpy as np
from scipy.signal import lfilter, butter

DEFAULT_SR = 48000

# The mirror of store.js's TAILS. probe reports it; the e2e compares the two.
TAILS = {"pluck": 1.5, "pad": 0.6, "drums": 1.3}

# ---------------------------------------------------------------- wav i/o

def write_wav_f32(path, y, sr):
    """Minimal RIFF float32 mono writer -- no soundfile dependency."""
    data = np.asarray(y, dtype="<f4").tobytes()
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVEfmt ")
        # format 3 = IEEE float, mono
        f.write(struct.pack("<IHHIIHH", 16, 3, 1, sr, sr * 4, 4, 32))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


def read_wav_f32(path):
    """Reads back what write_wav_f32 writes (for the tests). Chunk-walking,
    so a wav with extra chunks still reads."""
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
            if fmt != 3 or ch != 1:
                raise ValueError("expected float32 mono")
        elif cid == b"data":
            data = np.frombuffer(body, dtype="<f4")
        pos += 8 + size + (size & 1)
    if sr is None or data is None:
        raise ValueError("missing fmt or data chunk")
    return data.copy(), sr

# ---------------------------------------------------------------- synths
#
# Every synth: (midi, dur_samples, vel_0_1, sr, rng) -> float64 array of
# EXACTLY dur_samples + round(TAIL*sr) samples, last sample exactly 0.

def _gate(y, total, sr):
    """Pin a voice to its declared length with a hard-zero end."""
    out = np.zeros(total)
    n = min(len(y), total)
    out[:n] = y[:n]
    # the last 10 ms ramp to exactly zero -- the seam proof's invariant
    fade = min(int(0.010 * sr), total)
    if fade > 1:
        out[total - fade:] *= np.linspace(1.0, 0.0, fade)
    out[-1] = 0.0
    return out


def _midi_hz(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def synth_pluck(midi, dur_samples, vel, sr, rng):
    """Karplus-Strong: y[n] = x[n] + damp*0.5*(y[n-L] + y[n-L-1]).
    The AMT eval's exact-IIR formulation, plus a note-off release."""
    total = dur_samples + int(round(TAILS["pluck"] * sr))
    f0 = _midi_hz(midi + rng.uniform(-0.03, 0.03))     # +-3 cents, SEEDED
    L = max(int(round(sr / f0 - 0.5)), 2)
    damp = 0.996 if midi < 52 else 0.995
    n = total
    x = np.zeros(n)
    burst = rng.uniform(-1, 1, min(L, n))
    a1 = 0.6 - 0.5 * min(max(vel, 0.0), 1.0)           # softer pick = duller
    burst = lfilter([1 - a1], [1, -a1], burst)
    burst -= burst.mean()
    x[:len(burst)] = burst * vel
    a = np.zeros(L + 2)
    a[0] = 1.0
    a[L] = -damp * 0.5
    a[L + 1] = -damp * 0.5
    y = lfilter([1.0], a, x)
    # Note-off: past the note's own length the string is damped -- an
    # exponential release, tau 180 ms, which dies well inside the 1.5 s tail.
    if n > dur_samples:
        t = np.arange(n - dur_samples) / sr
        y[dur_samples:] *= np.exp(-t / 0.18)
    return _gate(y, total, sr)


def synth_pad(midi, dur_samples, vel, sr, rng):
    """Two detuned saws -> one-pole lowpass -> ADSR. Cheap and vectorised."""
    total = dur_samples + int(round(TAILS["pad"] * sr))
    f0 = _midi_hz(midi)
    t = np.arange(total) / sr
    y = np.zeros(total)
    for cents, ph in ((-6.0, rng.uniform(0, 1)), (6.0, rng.uniform(0, 1))):
        f = f0 * 2.0 ** (cents / 1200.0)
        y += 2.0 * ((t * f + ph) % 1.0) - 1.0
    # velocity opens the filter: one-pole LP, fixed per note
    cutoff = 300.0 + 4000.0 * min(max(vel, 0.0), 1.0)
    k = math.exp(-2.0 * math.pi * cutoff / sr)
    y = lfilter([1 - k], [1, -k], y)
    # ADSR: a 10 ms, d 250 ms to 0.75, release 0.5 s from note-off
    env = np.ones(total) * 0.75
    atk = min(int(0.010 * sr), total)
    env[:atk] = np.linspace(0, 1, atk)
    dec = min(int(0.250 * sr), total - atk)
    if dec > 0:
        env[atk:atk + dec] = np.linspace(1, 0.75, dec)
    rel = total - dur_samples
    if rel > 0:
        tr = np.arange(rel) / sr
        env[dur_samples:] *= np.exp(-tr / 0.12)
    return _gate(y * env * (0.5 + 0.5 * vel) * 0.35, total, sr)


def _drum_voice(midi, sr, rng):
    """One drum hit on GM-ish keys. Each voice is well under the tail cap."""
    def t_of(n):
        return np.arange(n) / sr
    if midi in (35, 36):                                   # kick
        n = int(0.45 * sr)
        t = t_of(n)
        f = 45.0 + 55.0 * np.exp(-t / 0.06)                # 100 -> 45 Hz sweep
        phase = 2 * np.pi * np.cumsum(f) / sr
        y = np.sin(phase) * np.exp(-t / 0.16)
        click = rng.uniform(-1, 1, int(0.002 * sr)) * 0.4
        y[:len(click)] += click
        return y
    if midi in (38, 40):                                   # snare
        n = int(0.30 * sr)
        t = t_of(n)
        tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05) * 0.5
        noise = rng.uniform(-1, 1, n)
        b, a = butter(2, [1500 / (sr / 2), 9000 / (sr / 2)], btype="band")
        noise = lfilter(b, a, noise) * np.exp(-t / 0.10)
        return tone + noise
    if midi in (42, 44):                                   # closed hat
        n = int(0.08 * sr)
        t = t_of(n)
        noise = rng.uniform(-1, 1, n)
        b, a = butter(2, 7000 / (sr / 2), btype="high")
        return lfilter(b, a, noise) * np.exp(-t / 0.025) * 0.8
    if midi == 46:                                         # open hat
        n = int(0.50 * sr)
        t = t_of(n)
        noise = rng.uniform(-1, 1, n)
        b, a = butter(2, 6000 / (sr / 2), btype="high")
        return lfilter(b, a, noise) * np.exp(-t / 0.12) * 0.7
    if midi in (49, 57):                                   # crash
        n = int(1.25 * sr)
        t = t_of(n)
        noise = rng.uniform(-1, 1, n)
        b, a = butter(2, 4000 / (sr / 2), btype="high")
        return lfilter(b, a, noise) * np.exp(-t / 0.35) * 0.6
    # everything else: a pitched tom around the key
    n = int(0.35 * sr)
    t = t_of(n)
    f = _midi_hz(midi) * 0.5
    f_t = f * (1 + 0.4 * np.exp(-t / 0.04))
    phase = 2 * np.pi * np.cumsum(f_t) / sr
    return np.sin(phase) * np.exp(-t / 0.12) * 0.9


def synth_drums(midi, dur_samples, vel, sr, rng):
    """A drum ignores note length -- a hit is a hit -- but the buffer is still
    dur + TAIL long so the gate arithmetic is uniform across instruments."""
    total = dur_samples + int(round(TAILS["drums"] * sr))
    return _gate(_drum_voice(midi, sr, rng) * vel, total, sr)


SYNTHS = {"pluck": synth_pluck, "pad": synth_pad, "drums": synth_drums}

# ── THE DRUM MACHINES (server/daw/drums.py) ───────────────────────────────
# Zero-download, zero-licence, fully tunable circuits: the TR-808 and TR-909
# voice sets, the pitched 808 bass and a modern hybrid sub kick. They are
# BUILTIN patches like the three above — no pack, no download, always
# installed — so they belong in this one table, which store.js's builtin
# list and the e2e's tail mirror are both held to. The adapters registered
# here are the mono, default-knob view; the real render goes through
# instruments.py, which reaches drums.voice() directly for stereo, the
# declared parameters and the per-note cache.
import drums as _drums  # noqa: E402
import synths as _synths  # noqa: E402

SYNTHS.update(_drums.engine_synths())
TAILS.update(_drums.engine_tails())
# ── THE BIG-ROOM SYNTHS (server/daw/synths.py): same seam, same reason. ──
SYNTHS.update(_synths.engine_synths())
TAILS.update(_synths.engine_tails())

# ╔═══════════════════════════════════════════════════════════════════════╗
# ║ DAWINST SEAM — the instrument stage lives in server/daw/instruments.py ║
# ║ (wt_dawinst). This import + the dispatch in render() + the probe merge ║
# ║ are the ONLY palette edits to this file. The seam contract (per-track  ║
# ║ render = instrument stage THEN chain stage) is documented atop         ║
# ║ instruments.py; the P0 synths above remain the builtin patches and are ║
# ║ called BY instruments.py, so every note goes through one door.        ║
# ╚═══════════════════════════════════════════════════════════════════════╝
import instruments as dawinst

# ---------------------------------------------------------------- render

def render(job):
    """One absolute sample window, mixed and mastered, to float32 wav.

    job: { sr, start_sample, n_samples, out,
           notes: [{ inst, midi, vel(1..127), start_sample, dur_samples,
                     gain_db, seed }] }
    """
    # ── CHAIN STAGE DISPATCH (agent/dawrack) ────────────────────────────
    # A job that carries `mixer` takes the rack path: per-track dry buffers
    # (the instrument stage, same note maths, and the same file-backed clips
    # through mix_clips below) -> insert chains -> fader/pan -> sends ->
    # returns -> master chain -> master fader -> the tanh master stays last
    # (rack.py keeps it). Without `mixer` the P0 mono path below runs
    # untouched, byte for byte.
    if job.get("mixer") is not None:
        import rack
        return rack.render_with_chain(job, SYNTHS, TAILS)
    t_start = time.perf_counter()
    sr = int(job.get("sr") or DEFAULT_SR)
    w0 = int(job["start_sample"])
    n = int(job["n_samples"])
    if n <= 0 or n > sr * 600:
        raise ValueError(f"n_samples out of range: {n}")
    out_path = job.get("out")
    mix = np.zeros(n)                                     # float64 accumulator

    for note in job.get("notes") or []:
        inst = note.get("inst")
        midi = int(note["midi"])
        dur = max(1, int(note["dur_samples"]))
        vel127 = min(max(int(note.get("vel", 100)), 1), 127)
        gain = 10.0 ** (float(note.get("gain_db", 0.0)) / 20.0)
        seed = int(note.get("seed", 0)) & 0xFFFFFFFF
        # ── DAWINST SEAM: every voice comes from the instrument stage.
        # instruments.py returns the stereo (2, N) contract; this mono bus
        # consumes (L+R)/2 until the chain stage (wt_dawrack) goes stereo.
        y = dawinst.synth_note_mono(
            inst, midi, dur, vel127, sr, seed,
            note.get("params"), job.get("instruments_dir")) * gain * 0.5
        s0 = int(note["start_sample"])                    # ABSOLUTE
        # intersect [s0, s0+len(y)) with the window [w0, w0+n)
        a = max(s0, w0)
        b = min(s0 + len(y), w0 + n)
        if b <= a:
            continue                                      # the hasher was generous; fine
        mix[a - w0:b - w0] += y[a - s0:b - s0]

    # ── [DAWREC] file-backed audio clips — the recording/import path ──────
    # Additive: a job with no "audio" list renders exactly as before. The
    # placement is mix_clips() below, and the CHAIN path calls that SAME
    # function on each track's dry buffer — one implementation of "a clip into
    # a buffer", so the two lanes cannot drift apart. They did drift: for as
    # long as this loop lived here and nowhere else, a clip through a mixer
    # was silence, and every new project has a mixer.
    mix_clips(job.get("audio"), mix, w0, sr)

    # Master: memoryless soft clip -- per-sample, so region slices of the same
    # notes stay bit-identical to whole-render slices (the seam proof).
    mastered = np.tanh(0.7 * mix).astype(np.float32)
    if out_path:
        write_wav_f32(out_path, mastered, sr)
    sha = __import__("hashlib").sha1(mastered.tobytes()).hexdigest()
    peak = float(np.max(np.abs(mastered))) if n else 0.0
    return {"ok": True, "sr": sr, "n_samples": n, "peak": round(peak, 6),
            "sha1": sha, "notes": len(job.get("notes") or []),
            # [DAWREC] the same key rack.render_with_chain answers with, and
            # the same count: how many clips THIS job carried. For as long as
            # a reply named only notes, a job whose whole content was a clip
            # reported "ok" over a silent file on the chain lane.
            "clips": len(job.get("audio") or []),
            "ms": round((time.perf_counter() - t_start) * 1000, 1)}

# ---------------------------------------------------- [DAWREC] audio files


def mix_clips(clips, buf, w0, sr):
    """THE placement of file-backed clips into a dry buffer. Both lanes call it.

    Each entry names an absolute sample placement, exactly like a note:
    { path, start_sample, offset_samples, dur_samples, gain_db }. Samples are
    decoded once per process (cached), accumulated into the SAME float64 dry
    buffer as the synth voices and BEFORE the master curve — so the
    region-seam proof holds unchanged: per-sample addition then a memoryless
    tanh has no seam in the mathematics. Gain is honest unity: 0 dB means the
    file's own level (notes carry their historical 0.5).

    `buf` is (N,) for a mono accumulator or (2, N) for a stereo one, and `w0`
    is the absolute sample its first element stands for: the P0 path passes
    its window accumulator with the window's own start; rack.chain_graph
    passes a track's dry buffer with 0, because the rack processes from
    absolute sample 0. Stereo imports retain their channels in a stereo
    buffer; mono recordings feed both channels. The mono lane deliberately
    folds stereo to its channel mean.

    WHY IT LIVES HERE AND IS CALLED FROM THERE. rack.py owned no line of this
    and the chain path rendered clips as silence: engine.render returned
    rack.render_with_chain the moment a job carried `mixer`, and
    rack.chain_graph built its dry buffers from job["notes"] and nothing else.
    Two implementations would have been two chances to drift again, so there
    is one, and rack imports it lazily (the same direction master.py imports
    back into rack — the cycle stays open because the call is at call time).

    Returns how many clips actually put samples in the buffer. NOT what the
    render replies report: their `clips` is len(job["audio"]), the count the
    job CARRIED, which is the number routes.js and capture_test.py mean by it.
    The two differ exactly when a clip was sent to a window it places nothing
    in — which is a normal thing to send, because a clip whose stateful tail
    rings into a window belongs in that window's job (store.audioJobClips
    filters by reach) while contributing no samples of its own to the P0 mono
    lane's accumulator. Said here rather than left to be read off the code,
    because this docstring claimed the opposite for as long as nobody checked.
    """
    two = np.asarray(buf).ndim == 2
    n = buf.shape[1] if two else buf.shape[0]
    placed = 0
    for clip in clips or []:
        y = _read_audio_f64(str(clip["path"]), sr, preserve_stereo=two)
        frames = y.shape[-1]
        off = max(0, int(clip.get("offset_samples") or 0))
        dur = int(clip.get("dur_samples") or (frames - off))
        seg = y[..., off:off + max(0, dur)]
        if not seg.shape[-1]:
            continue
        gain = 10.0 ** (float(clip.get("gain_db", 0.0)) / 20.0)
        s0 = int(clip["start_sample"])
        a = max(s0, w0)
        b = min(s0 + seg.shape[-1], w0 + n)
        if b <= a:
            continue
        piece = seg[..., a - s0:b - s0] * gain
        if two:
            buf[:, a - w0:b - w0] += piece
        else:
            buf[a - w0:b - w0] += piece
        placed += 1
    return placed


# The decode cache for file-backed clips. Keyed on (path, mtime) so a
# re-recorded file under the same name (which the capture layer never does —
# take/import/comp names are write-once) would still be re-read honestly.

_AUDIO_CACHE = {}
_AUDIO_CACHE_MAX = 24


def _read_audio_f64(path, sr, preserve_stereo=False):
    """Float64 asset samples: (N,) by default or (2,N) for a stereo bus.

    FLAC is decoded through PyAV with the exact inverse of capture.py's
    encode scale (s32 left-justified -> /2**31); float32 wav rides the
    existing reader. A rate mismatch is an ERROR, never a resample — the
    import seam (capture.py decode) already put every asset at the project
    rate, so a mismatch here means a file bypassed it. The requested rate is
    part of the cache key — a cached hit must never skip the rate check."""
    key = (path, os.path.getmtime(path), sr, preserve_stereo)
    hit = _AUDIO_CACHE.get(key)
    if hit is not None:
        return hit
    if path.lower().endswith(".flac"):
        import av                                   # lazy: only audio-mixing renders pay it
        container = av.open(path)
        try:
            if not container.streams.audio:
                raise ValueError(f"{os.path.basename(path)} has no audio stream")
            stream = container.streams.audio[0]
            if int(stream.rate) != sr:
                raise ValueError(f"{os.path.basename(path)} is {stream.rate} Hz, the project is {sr} — re-import it")
            parts = []
            for frame in container.decode(audio=0):
                arr = frame.to_ndarray()
                channels = frame.layout.nb_channels
                # Packed FLAC is (1, N*channels), not a mono timeline.
                if not frame.format.is_planar:
                    arr = arr.reshape(-1, channels).T
                parts.append(arr)
        finally:
            container.close()                       # a refused file must not stay open
        y = np.concatenate(parts, axis=1) if parts else np.zeros((1, 0), dtype=np.int32)
        if y.dtype == np.int32:
            y = y.astype(np.float64) / 2147483648.0
        elif y.dtype == np.int16:
            y = y.astype(np.float64) / 32768.0
        else:
            y = y.astype(np.float64)
    else:
        from capture import read_wav_f32 as read_asset_wav
        y, fsr = read_asset_wav(path, preserve_stereo=True)
        if fsr != sr:
            raise ValueError(f"{os.path.basename(path)} is {fsr} Hz, the project is {sr} — re-import it")
        y = y.astype(np.float64).T
        if y.ndim == 1:
            y = y[None, :]
    if preserve_stereo:
        y = y[:2] if y.shape[0] > 1 else np.repeat(y, 2, axis=0)
    else:
        y = y.mean(axis=0) if y.shape[0] > 1 else y.reshape(-1)
    while len(_AUDIO_CACHE) >= _AUDIO_CACHE_MAX:
        _AUDIO_CACHE.pop(next(iter(_AUDIO_CACHE)))
    _AUDIO_CACHE[key] = y
    return y


def click(job):
    """[DAWREC] the count-in / monitor click bed.

    job: { sr, n_samples, out, events: [{ sample, accent }] } — the events
    arrive as ABSOLUTE samples computed by store.js's timeline. This engine
    never derives musical time itself: the meter map is the only clock, and
    it is spoken here only as sample positions someone else derived from it.
    """
    sr = int(job.get("sr") or DEFAULT_SR)
    n = int(job.get("n_samples") or 0)
    if n <= 0 or n > sr * 600:
        raise ValueError(f"click: n_samples out of range: {n}")
    out = job.get("out")
    y = np.zeros(n)
    blip_n = int(0.040 * sr)
    t = np.arange(blip_n) / sr
    env = np.exp(-t / 0.008)
    hi = np.sin(2 * np.pi * 1760.0 * t) * env * 0.8      # the accented "one"
    lo = np.sin(2 * np.pi * 880.0 * t) * env * 0.5
    count = 0
    for e in job.get("events") or []:
        s = int(e.get("sample", -1))
        if s < 0 or s >= n:
            continue
        blip = hi if e.get("accent") else lo
        b = min(s + blip_n, n)
        y[s:b] += blip[:b - s]
        count += 1
    mastered = np.tanh(0.9 * y).astype(np.float32)
    if out:
        write_wav_f32(out, mastered, sr)
    return {"ok": True, "sr": sr, "n_samples": n, "clicks": count}


# ------------------------------------------------------- P0-4: calibration

CHIRP_SECONDS = 0.5
CHIRP_F0, CHIRP_F1 = 200.0, 4000.0

def make_chirp(sr):
    """Deterministic log sweep 200->4000 Hz, hann-edged. Both ends of the
    loopback speak THIS -- the reference is regenerated, never trusted from
    a file that could have been resampled on the way."""
    n = int(CHIRP_SECONDS * sr)
    t = np.arange(n) / sr
    k = math.log(CHIRP_F1 / CHIRP_F0) / CHIRP_SECONDS
    phase = 2 * np.pi * CHIRP_F0 * (np.exp(k * t) - 1) / k
    y = np.sin(phase)
    edge = int(0.01 * sr)
    y[:edge] *= np.linspace(0, 1, edge)
    y[-edge:] *= np.linspace(1, 0, edge)
    return y * 0.8


def chirp(job):
    sr = int(job.get("sr") or DEFAULT_SR)
    out = job.get("out")
    if not out:
        raise ValueError("chirp needs an 'out' path")
    write_wav_f32(out, make_chirp(sr).astype(np.float32), sr)
    return {"ok": True, "sr": sr, "seconds": CHIRP_SECONDS, "out": out}


def estimate_offset(ref, cap, sr):
    """Cross-correlation peak with parabolic interpolation -> sub-sample lag.

    Returns (offset_ms, peak_ratio). peak_ratio is the correlation peak over
    the next-highest peak outside +-1 ms -- below ~2 the estimate is a guess
    and the caller should say so rather than store it.
    """
    ref = np.asarray(ref, dtype=np.float64)
    cap = np.asarray(cap, dtype=np.float64)
    ref = ref - ref.mean()
    cap = cap - cap.mean()
    # Circular FFT correlation puts lag k -- "the capture starts k samples
    # after playback" -- at index k directly. Pad past len(cap)+len(ref) so
    # no legal lag wraps, then keep the non-negative lags only: a capture
    # cannot precede the playback that caused it.
    size = 1 << (len(cap) + len(ref)).bit_length()
    R = np.fft.rfft(ref, size)
    C = np.fft.rfft(cap, size)
    corr = np.fft.irfft(C * np.conj(R), size)[:len(cap)]
    best = int(np.argmax(corr))
    # parabolic interpolation around the peak -> sub-sample
    if 0 < best < len(corr) - 1:
        y0, y1, y2 = corr[best - 1], corr[best], corr[best + 1]
        denom = (y0 - 2 * y1 + y2)
        frac = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-12 else 0.0
        frac = float(np.clip(frac, -1, 1))
    else:
        frac = 0.0
    lag = best + frac
    # confidence: the peak against the best rival outside +-1 ms
    guard = int(0.001 * sr)
    mask = np.ones(len(corr), dtype=bool)
    mask[max(0, best - guard):best + guard + 1] = False
    rival = float(np.max(corr[mask])) if mask.any() else 0.0
    peak_ratio = float(corr[best] / rival) if rival > 1e-12 else float("inf")
    return lag * 1000.0 / sr, peak_ratio


def calibrate(job):
    """job: { sr, capture } -- capture is a path to RAW little-endian float32
    PCM (what the browser's AudioWorklet hands over; no container to parse).
    The reference chirp is regenerated from the same constants."""
    sr = int(job.get("sr") or DEFAULT_SR)
    cap_path = job.get("capture")
    if not cap_path or not os.path.isfile(cap_path):
        raise ValueError("calibrate needs a 'capture' path to raw float32 PCM")
    cap = np.fromfile(cap_path, dtype="<f4").astype(np.float64)
    if len(cap) < sr * 0.1:
        raise ValueError(f"capture too short ({len(cap)} samples) -- record at least the chirp plus headroom")
    ref = make_chirp(sr)
    offset_ms, peak_ratio = estimate_offset(ref, cap, sr)
    return {"ok": True, "sr": sr,
            "offset_ms": round(offset_ms, 3),
            "peak_ratio": round(peak_ratio, 2),
            "confident": bool(peak_ratio >= 2.0)}

# ---------------------------------------------------------------- probe

def probe(job):
    return {"ok": True, "engine": "daw", "sr_default": DEFAULT_SR,
            "instruments": sorted(SYNTHS), "tails": TAILS,
            "chirp": {"seconds": CHIRP_SECONDS, "f0": CHIRP_F0, "f1": CHIRP_F1},
            "pid": os.getpid(),
            # ── DAWINST SEAM: the palette speaks through the same probe, so
            # the e2e can hold store.js and the engine to ONE patch table.
            **dawinst.probe_extra(job)}


MODES = {"render": render, "chirp": chirp, "calibrate": calibrate, "probe": probe}
MODES["click"] = click        # [DAWREC] additive — the capture path's dispatch

# ── CHAIN STAGE DISPATCH (agent/dawrack): the two rack-owned commands ──────
# `meters` answers offline per-bus levels for a window (peak/RMS/LUFS, master
# true-peak); `rack` answers the device catalog so the routes can compare it
# against the store's mirror the way probe compares the tail tables.
import rack as _rack  # noqa: E402
MODES["meters"] = lambda job: _rack.meters(job, SYNTHS)
MODES["rack"] = _rack.rack_probe

# ── THE MASTERING SUITE (agent/master): analysis served as DATA ────────────
# rack.py already imported master.py at its own bottom to register the seven
# mastering devices; this line adds the four ANALYSIS commands the mastering
# UI draws from -- `analyze` (every meter in one payload), `device_response`
# (a device's own curve, from its own coefficients), `reference` (a
# loudness-matched A/B) and `check_delivery` (PASS/FAIL per streaming
# target). Same one-JSON-line contract as everything else in this table.
import master as _master  # noqa: E402
MODES.update(_master.engine_modes(SYNTHS))

# ── [VOICELAB] THREE NEW MODES, AND NOT ONE LINE ABOVE THIS BLOCK ─────────
# `render` and its chain dispatch are load-bearing in a way nothing else in
# this file is: every region hash in every cache on disk is the hash of what
# `render` produced, and the region-seam proof is a statement about its
# bytes. So the per-track lanes and the Voice Lab arrive as ADDITIONS here
# and change nothing that was already dispatchable.
#
#   render_stems   the post-fader per-track buses of THE SAME graph the mix
#                  came from -- rack.chain_graph(capture=True), which the Ear
#                  has been computing and throwing away since it shipped. A
#                  separate job, never a change to the region job, so the
#                  region hash cannot move.
#   peaks_mip      the four-stage waveform mip-map, built once per file.
#   voice_analyse  the Voice Lab's picture: per-channel peaks, the Ear's own
#                  nine bands plus a 1/3-octave curve, and a dB envelope with
#                  t10/t30/t60.
#
# The last two live on the SERVE child rather than in a spawned process for a
# measured reason: one note renders in 4-12 ms warm, and a cold python would
# spend ~300 ms importing numpy before it looked at it.
import peaks as _peaks  # noqa: E402
MODES["render_stems"] = lambda job: _rack.render_stems(job, SYNTHS, TAILS)
MODES["peaks_mip"] = _peaks.peaks_mip
MODES["voice_analyse"] = _peaks.voice_analyse

SERVE_MODES = MODES

# ---------------------------------------------------------------- serve

def serve(stdin=None, stdout=None):
    """`{"id":..., "cmd":"render", "job":{...}}` a line in, one JSON line out,
    until stdin closes or a `shutdown` arrives. The vfx engine's protocol,
    kept to the letter so routes.js's lane code carries over unchanged."""
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout

    def reply(obj):
        stdout.write(json.dumps(obj) + "\n")
        stdout.flush()

    reply({"ok": True, "ready": True, "pid": os.getpid()})
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("a request must be a JSON object")
            rid = req.get("id")
            cmd = str(req.get("cmd") or "")
            if cmd == "shutdown":
                reply({"id": rid, "ok": True, "bye": True})
                break
            if cmd not in SERVE_MODES:
                raise ValueError(f"unknown cmd {cmd}")
            result = SERVE_MODES[cmd](req.get("job") or {})
            result = dict(result, id=rid) if rid is not None else result
            reply(result)
        except MemoryError:
            reply({"id": rid, "ok": False, "fatal": True, "error": "MemoryError"})
            return 1
        except Exception as exc:                           # noqa: BLE001
            reply({"id": rid, "ok": False,
                   "error": f"{type(exc).__name__}: {exc}"})
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "serve":
        return serve()
    try:
        if len(argv) < 2:
            raise ValueError("usage: engine.py <render|chirp|calibrate|probe> <job.json>"
                             "  |  engine.py serve")
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
