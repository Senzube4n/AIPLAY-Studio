"""Frame-aligned RMS peaks for a resolved drum recording (CPU only).

The recipe is RMS per video frame, normalization over the requested clip,
then height/distance peak selection. It is independent of a tempo beat grid.
"""
import argparse
import json
import subprocess

import numpy as np
from scipy.signal import find_peaks


def frame_peaks(samples, sample_rate, fps, frames, distance=5):
    if not 0 < fps <= 120 or frames < 1 or distance < 1:
        raise ValueError("fps, frames and peak distance must be positive")
    block = int(sample_rate / fps)
    if block < 1:
        raise ValueError("sample rate must be at least the video frame rate")
    audio = np.asarray(samples, dtype=np.float64)
    if audio.ndim == 1:
        audio = audio[:, None]
    if audio.ndim != 2 or not audio.shape[1] or not np.isfinite(audio).all():
        raise ValueError("expected finite audio samples with a channel dimension")
    needed = block * frames
    audio = audio[:needed]
    if len(audio) < needed:
        audio = np.pad(audio, ((0, needed - len(audio)), (0, 0)))
    levels = np.round(np.sqrt(np.mean(audio.reshape(frames, block, -1) ** 2, axis=(1, 2))), 6)
    span = float(np.ptp(levels))
    weights = (levels - levels.min()) / span if span else np.zeros(frames)
    weights = np.round(np.where(weights > 0.5, weights, 0).clip(0, 1), 6)
    peaks = find_peaks(weights, height=0.4, distance=distance)[0]
    return {"fps": fps, "frames": frames, "peaks": [0, *map(int, peaks)], "weights": weights.tolist(),
            "method": "drum-frame-rms", "threshold": 0.5, "peakHeight": 0.4, "minDistanceFrames": distance}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--fps", type=float, default=12)
    parser.add_argument("--frames", type=int, required=True)
    parser.add_argument("--gap", type=int, default=5)
    args = parser.parse_args()
    if args.start < 0 or args.fps <= 0 or not 1 <= args.frames <= 14400:
        raise ValueError("invalid audio window")
    rate, channels = 44100, 2
    decoded = subprocess.run([args.ffmpeg, "-v", "error", "-ss", str(args.start), "-i", args.audio,
                              "-t", str(args.frames / args.fps), "-vn", "-ac", str(channels), "-ar", str(rate),
                              "-f", "f32le", "pipe:1"], capture_output=True, check=True, timeout=120)
    samples = np.frombuffer(decoded.stdout, dtype="<f4").reshape(-1, channels)
    if not len(samples):
        raise ValueError("the selected drum-audio window contains no samples")
    print(json.dumps(frame_peaks(samples, rate, args.fps, args.frames, args.gap)))


if __name__ == "__main__":
    main()
