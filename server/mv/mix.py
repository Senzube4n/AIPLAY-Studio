"""Offline audio mixdown - the audiobook mixer and Studio's audio export.

Reads a JSON job from argv[1], writes one audio file, prints a JSON result.

Job shape:
{
  "out": "C:/.../chapter01.mp3",          # .mp3 or .wav decides the container
  "sampleRate": 44100,
  "tracks": [
    { "gain": 1.0,
      "items": [ { "src": "C:/.../line1.wav", "start": 0.0, "dur": 12.5,
                   "inPoint": 0.0, "gain": 1.0, "fadeIn": 0.0, "fadeOut": 0.0 } ] },
    ...
  ],
  "duck": { "source": 0, "targets": [1], "depthDb": -13,
            "attackMs": 120, "releaseMs": 450, "thresholdDb": -45 },
  "normalize": { "rmsDb": -20.0, "peakDb": -3.0 }
}

Ducking: the SOURCE track's loudness envelope pushes the TARGET tracks down by
up to depthDb - the sidechain an audiobook needs so the ambient bed breathes
under the narration instead of fighting it. Offline, so attack/release are
just an asymmetric smoother on the envelope; nothing here needs realtime.

Normalisation is RMS-to-target with a hard peak ceiling, which is the shape of
the ACX audiobook spec (RMS -23..-18 dBFS, peaks under -3 dBFS).

PyAV for decode/encode (already a dependency of this app), numpy for the math.
Everything mixes in float32 stereo at the job's sample rate.
"""
import json
import sys

import numpy as np

import av
from av.audio.resampler import AudioResampler


def decode(path, rate):
    """Decode any audio file to float32 stereo [2, n] at `rate`."""
    resampler = AudioResampler(format="fltp", layout="stereo", rate=rate)
    chunks = []
    with av.open(path) as container:
        stream = next(s for s in container.streams if s.type == "audio")
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                arr = out.to_ndarray()          # planar fltp -> [2, n]
                if arr.shape[0] == 1:
                    arr = np.vstack([arr, arr])
                chunks.append(arr)
        # flush the resampler
        for out in resampler.resample(None):
            arr = out.to_ndarray()
            if arr.shape[0] == 1:
                arr = np.vstack([arr, arr])
            chunks.append(arr)
    if not chunks:
        return np.zeros((2, 0), dtype=np.float32)
    return np.concatenate(chunks, axis=1).astype(np.float32)


def db(x):
    return 10.0 ** (x / 20.0)


def envelope(x, rate, attack_ms, release_ms):
    """Asymmetric one-pole follower over the mono absolute signal.

    Runs on a 10 ms peak grid (a python loop at 100 steps per second of audio
    is nothing), so the smoothing coefficients are per GRID STEP - computing
    them per sample and applying them per step made the release ~441x slower
    than asked and the bed never came back after speech. Caught by measuring
    the mixed output, not by reading the code.
    """
    mono = np.abs(x).mean(axis=0)
    n = len(mono)
    hop = max(1, int(rate * 0.010))            # 10 ms grid
    dt = hop / rate
    att = np.exp(-dt / (max(attack_ms, 1) / 1000.0))
    rel = np.exp(-dt / (max(release_ms, 1) / 1000.0))
    grid = mono[: (n // hop) * hop].reshape(-1, hop).max(axis=1) if n >= hop else mono[None, :].max(axis=1)
    sm = np.empty_like(grid)
    prev = 0.0
    for i, g in enumerate(grid):
        coef = att if g > prev else rel
        prev = coef * prev + (1 - coef) * g
        sm[i] = prev
    env = np.repeat(sm, hop)
    if len(env) < n:
        env = np.pad(env, (0, n - len(env)), mode="edge")
    return env[:n]


def main():
    job = json.loads(open(sys.argv[1], encoding="utf-8").read())
    rate = int(job.get("sampleRate", 44100))

    # total length = the furthest item edge across all tracks
    total = 0.0
    for tr in job["tracks"]:
        for it in tr["items"]:
            total = max(total, float(it["start"]) + float(it["dur"]))
    n_total = int(round(total * rate)) + 1
    buses = []

    cache = {}
    for tr in job["tracks"]:
        bus = np.zeros((2, n_total), dtype=np.float32)
        for it in tr["items"]:
            src = it["src"]
            if src not in cache:
                cache[src] = decode(src, rate)
            audio = cache[src]
            in0 = int(round(float(it.get("inPoint", 0)) * rate))
            need = int(round(float(it["dur"]) * rate))
            seg = audio[:, in0:in0 + need]
            if seg.shape[1] < need and it.get("loop"):
                # Ambient beds LOOP to cover their span, with an equal-power
                # crossfade at each seam so the tile edge cannot be heard.
                xf = min(int(rate * float(it.get("loopFadeSec", 2.0))), seg.shape[1] // 2)
                tiles = [seg]
                have = seg.shape[1]
                body = audio[:, in0:] if audio.shape[1] - in0 > xf else seg
                while have < need:
                    a = tiles[-1]
                    t = np.linspace(0, np.pi / 2, xf, dtype=np.float32)
                    fade_out, fade_in = np.cos(t), np.sin(t)
                    a[:, -xf:] = a[:, -xf:] * fade_out + body[:, :xf] * fade_in
                    tiles.append(body[:, xf:])
                    have += body.shape[1] - xf
                seg = np.concatenate(tiles, axis=1)[:, :need]
            g = float(it.get("gain", 1.0))
            fi = int(rate * float(it.get("fadeIn", 0)))
            fo = int(rate * float(it.get("fadeOut", 0)))
            m = seg.shape[1]
            if m == 0:
                continue
            shaped = seg * g
            if fi > 0:
                k = min(fi, m)
                shaped[:, :k] *= np.linspace(0, 1, k, dtype=np.float32)
            if fo > 0:
                k = min(fo, m)
                shaped[:, m - k:] *= np.linspace(1, 0, k, dtype=np.float32)
            at = int(round(float(it["start"]) * rate))
            end = min(at + m, n_total)
            bus[:, at:end] += shaped[:, : end - at]
        bus *= float(tr.get("gain", 1.0))
        buses.append(bus)

    duck = job.get("duck")
    if duck and buses:
        src_bus = buses[int(duck["source"])]
        env = envelope(src_bus, rate, duck.get("attackMs", 120), duck.get("releaseMs", 450))
        thresh = db(duck.get("thresholdDb", -45))
        depth = db(duck.get("depthDb", -13))     # e.g. -13 dB => x0.224
        # Above the threshold the target is fully ducked; below it fades back.
        amt = np.clip(env / thresh, 0, 1)
        gain = 1 - amt * (1 - depth)
        for t in duck.get("targets", []):
            buses[int(t)] *= gain

    mix = np.sum(buses, axis=0) if buses else np.zeros((2, n_total), dtype=np.float32)

    norm = job.get("normalize") or {}
    rms_target = db(norm.get("rmsDb", -20.0))
    peak_ceil = db(norm.get("peakDb", -3.0))
    rms = float(np.sqrt(np.mean(mix ** 2))) or 1e-9
    mix *= rms_target / rms
    peak = float(np.max(np.abs(mix))) or 1e-9
    if peak > peak_ceil:
        mix *= peak_ceil / peak

    out_path = job["out"]
    codec = "libmp3lame" if out_path.lower().endswith(".mp3") else "pcm_s16le"
    with av.open(out_path, "w") as out:
        stream = out.add_stream(codec, rate=rate)
        stream.layout = "stereo"
        if codec == "libmp3lame":
            stream.bit_rate = 192_000
        frame_len = 1152 if codec == "libmp3lame" else 4096
        i = 0
        n = mix.shape[1]
        while i < n:
            chunk = mix[:, i:i + frame_len]
            frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(chunk), format="fltp", layout="stereo")
            frame.sample_rate = rate
            for pkt in stream.encode(frame):
                out.mux(pkt)
            i += frame_len
        for pkt in stream.encode(None):
            out.mux(pkt)

    print(json.dumps({"ok": True, "out": out_path, "seconds": round(total, 2),
                      "rmsDb": round(20 * np.log10(max(rms, 1e-9)), 1)}))


if __name__ == "__main__":
    main()
