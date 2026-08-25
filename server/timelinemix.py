"""Bounce a Studio timeline down to one audio file.

Studio can COMPOSE audio it could not deliver: tracks with levels, mutes and
solos, items with fades and in-points — and the only way out was
`/api/export`, which converts one library track's format and knows nothing
about a timeline. This is the missing half. `Export video` records the picture
in real time through a browser; this renders the sound offline, faster than
real time, with no browser involved.

Usage:
  python timelinemix.py <job.json>

  job: { "tracks": [ { "kind": "audio"|"video", "level": 1.0,
                       "muted": false, "solo": false,
                       "items": [ { "src": path, "start": s, "dur": s,
                                    "inPoint": s, "fadeIn": s, "fadeOut": s } ] } ],
         "out": path, "format": "mp3"|"flac"|"wav",
         "sampleRate": 44100, "seconds": null,
         "normalize": { "rmsDb": -14, "peakDb": -1 } | null }

  `src` must already be an absolute path — resolving "/api/audio/x.flac" against
  the library is the SERVER's job, and a worker that could open arbitrary URLs
  would be a second, unaudited file-access surface.

Prints one JSON line: { ok, out, seconds, tracks, items, ... }.

── WHAT THIS HAS TO MATCH ──────────────────────────────────────────────────
A bounce that does not sound like the monitor is worthless, so every number
below is read off web/studio.js rather than invented:

  * `audible()` — solo beats mute, PER KIND, exactly as on a desk: the moment
    anything in the audio group is soloed, every un-soloed audio track is
    silent whatever its own mute button says.
  * `itemAlpha()` — three gains that MULTIPLY: the crossfade with the previous
    item on the same track, the item's own fadeIn, its own fadeOut. All three
    are LINEAR ramps in amplitude (`into / fadeIn`), not equal-power. That is
    not a preference — playback writes them into `el.volume`, and
    HTMLMediaElement.volume is a linear multiplier on the samples. Rendering
    an equal-power fade here would be smoother AND wrong.
  * The crossfade is one-sided. `itemAlpha` fades the INCOMING item up across
    the overlap and leaves the outgoing one at full unless it carries its own
    fadeOut. A symmetrical crossfade would sound better and would not be what
    the editor showed you.
  * `el.volume = itemAlpha(...) * (tr.level ?? 1)`, clamped to 0..1. Same
    order, same clamp.
  * Video tracks are picture only (`el.muted = tr.kind === "video"`), so their
    audio is not in the mix even when the clip has some.

── WHERE IT HONESTLY CANNOT MATCH ──────────────────────────────────────────
  * Playback re-writes `el.volume` once per animation frame; this evaluates
    the gain per SAMPLE. A fade shorter than ~16 ms is a staircase in the
    monitor and a ramp here. The file is the more correct of the two.
  * `syncMedia` starts an element 0.15 s BEFORE its item (`local >= -0.15`) to
    keep the decoder warm, and an item with no fadeIn is at full level during
    that pre-roll — so the monitor can leak up to 150 ms of a clip's head
    before its start time. That is a decoding artifact, not an edit; items
    here begin exactly at `start`.
  * The browser mixes in float and the sound card clips at the end; so does
    this, and `clipped` in the output says how many samples hit the rail.

Runs in the same venv as ComfyUI, so PyAV and numpy are already present.
"""
from __future__ import annotations

import json
import math
import sys

import av
import numpy as np

# What PyAV can actually encode here, and what the library will list. wav is
# offered because a bounce is sometimes an intermediate — but see the route:
# server/library.js indexes .flac/.mp3/.opus only, so a WAV dropped in the
# output folder is a file no screen in the app can show you.
CODECS = {
    "flac": ("flac", "s16"),
    "mp3": ("libmp3lame", None),   # None: take the encoder's own sample format
    "wav": ("pcm_s16le", "s16"),
}


class Refuse(Exception):
    """A job that cannot be mixed, said in a sentence a person can act on."""


def decode(path: str, rate: int) -> np.ndarray:
    """Decode any source to (2, N) float32 stereo at `rate`.

    One resampler does all three normalisations — sample rate, channel layout
    and sample format — because a timeline routinely mixes a 44.1 kHz FLAC from
    the library with the 48 kHz stereo track muxed into an imported MP4, and
    summing those without conversion is the classic chipmunk bug.
    """
    try:
        container = av.open(path)
    except Exception as err:                       # noqa: BLE001 - reported verbatim
        raise Refuse(f"could not open {path}: {err}") from err
    with container:
        if not container.streams.audio:
            raise Refuse(f"{path} has no audio stream")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
        parts = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                parts.append(out.to_ndarray())
        for out in resampler.resample(None):
            parts.append(out.to_ndarray())
    if not parts:
        return np.zeros((2, 0), dtype=np.float32)
    return np.concatenate(parts, axis=1).astype(np.float32, copy=False)


def item_gain(prev_overlap: float, dur: float, fade_in: float, fade_out: float,
              level: float, n: int, rate: int) -> np.ndarray:
    """The envelope for one item, sample by sample — web/studio.js itemAlpha().

    `clip(into / fade, 0, 1)` is the vector form of studio.js's
    `if (into < fade) a *= into / fade`: past the ramp the expression is
    already >= 1 and the clip pins it there, so the two agree everywhere
    instead of only inside the ramp.
    """
    into = np.arange(n, dtype=np.float32) / float(rate)
    gain = np.ones(n, dtype=np.float32)
    if prev_overlap > 0:
        gain *= np.clip(into / prev_overlap, 0.0, 1.0)
    if fade_in > 0:
        gain *= np.clip(into / fade_in, 0.0, 1.0)
    if fade_out > 0:
        gain *= np.clip((dur - into) / fade_out, 0.0, 1.0)
    # The clamp is el.volume's: a level slider cannot go past 1, but a job
    # written by hand or by an agent can, and the monitor would not obey it.
    return np.clip(gain * level, 0.0, 1.0)


def mix(job: dict) -> dict:
    rate = int(job.get("sampleRate") or 44100)
    fmt = str(job.get("format") or "flac").lower()
    if fmt not in CODECS:
        raise Refuse(f"format must be one of {', '.join(CODECS)} — got {fmt!r}")

    # Video tracks are dropped here rather than by the caller, so the SOLO
    # grouping is computed over the same set the app computes it over.
    tracks = [t for t in (job.get("tracks") or []) if (t.get("kind") or "audio") == "audio"]
    if not tracks:
        raise Refuse("this project has no audio tracks — there is nothing to bounce")

    any_solo = any(bool(t.get("solo")) for t in tracks)
    live = [t for t in tracks if (t.get("solo") if any_solo else not t.get("muted"))]
    if not live:
        raise Refuse("every audio track is muted — the bounce would be silence")

    # Length is the last audio item's end. A video tail is picture, and padding
    # a music file with silence to match it is not something anyone asked for —
    # `seconds` in the job is the override for lining a bounce up with a video.
    placed = []
    for track in live:
        items = sorted((it for it in (track.get("items") or []) if float(it.get("dur") or 0) > 0),
                       key=lambda it: float(it.get("start") or 0))
        for i, it in enumerate(items):
            start, dur = float(it.get("start") or 0), float(it.get("dur") or 0)
            overlap = 0.0
            if i > 0:
                prev = items[i - 1]
                overlap = max(0.0, float(prev.get("start") or 0) + float(prev.get("dur") or 0) - start)
            placed.append((track, it, max(0.0, start), dur, min(overlap, dur)))
    if not placed:
        # Zero-length items are dropped silently above (a 0 s clip is a mis-drag,
        # not an error); a timeline of NOTHING BUT those is worth saying out loud.
        raise Refuse("no audio items with a length — nothing to mix")

    end = max(s + d for _, _, s, d, _ in placed)
    seconds = float(job["seconds"]) if job.get("seconds") else end
    total = max(1, int(round(seconds * rate)))
    bus = np.zeros((2, total), dtype=np.float32)

    cache: dict[str, np.ndarray] = {}
    for track, it, start, dur, overlap in placed:
        src = str(it.get("src") or "")
        if src not in cache:
            cache[src] = decode(src, rate)
        audio = cache[src]

        at = int(round(start * rate))
        n = int(round(dur * rate))
        if at >= total:
            continue
        n = min(n, total - at)
        if n <= 0:
            continue

        off = max(0, int(round(float(it.get("inPoint") or 0) * rate)))
        chunk = audio[:, off:off + n]
        if chunk.shape[1] < n:
            # An item can outlive its source — trim to a guessed duration, then
            # learn the real one. Playback answers that with an element that
            # simply ends; the file answers with silence, which is the same
            # thing you hear.
            chunk = np.pad(chunk, ((0, 0), (0, n - chunk.shape[1])))

        bus[:, at:at + n] += chunk * item_gain(
            overlap, dur, float(it.get("fadeIn") or 0), float(it.get("fadeOut") or 0),
            float(track.get("level", 1) if track.get("level") is not None else 1), n, rate)

    peak_in = float(np.abs(bus).max()) if bus.size else 0.0
    rms_in = float(np.sqrt(np.mean(np.square(bus, dtype=np.float64)))) if bus.size else 0.0

    gain, norm = 1.0, job.get("normalize")
    if norm:
        # RMS first, then let the peak ceiling veto it. Reported either way, so a
        # bounce that could not reach the asked-for loudness says so rather than
        # quietly landing 4 dB under it.
        if rms_in > 0 and norm.get("rmsDb") is not None:
            gain = float(10.0 ** ((float(norm["rmsDb"]) - 20 * math.log10(rms_in)) / 20.0))
        if peak_in > 0 and norm.get("peakDb") is not None:
            ceiling = float(10.0 ** (float(norm["peakDb"]) / 20.0))
            gain = min(gain, ceiling / peak_in)
        bus *= gain

    clipped = int(np.count_nonzero(np.abs(bus) > 1.0))
    np.clip(bus, -1.0, 1.0, out=bus)
    encode(job["out"], bus, rate, fmt)

    def db(x):
        return round(20 * math.log10(x), 2) if x > 0 else None

    return {
        "ok": True, "out": job["out"], "format": fmt, "sampleRate": rate,
        "seconds": round(total / rate, 3),
        "tracks": len(live), "items": len(placed), "sources": len(cache),
        "gainDb": db(gain), "peakDb": db(float(np.abs(bus).max())),
        "rmsDb": db(float(np.sqrt(np.mean(np.square(bus, dtype=np.float64))))),
        "clipped": clipped,
    }


def encode(path: str, data: np.ndarray, rate: int, fmt: str) -> None:
    """Write the bus out.

    The scale is edit_audio.py's, deliberately: 32768 with rounding, clipped
    AFTER scaling because 1.0 * 32768 is one past int16's positive range. A
    bounce and an edit must round-trip through the library identically or
    "non-destructive" stops being true across the pair.
    """
    codec, want = CODECS[fmt]
    out = av.open(path, "w")
    try:
        stream = out.add_stream(codec, rate=rate)
        stream.layout = "stereo"
        target = want or stream.format.name
        resampler = av.AudioResampler(format=target, layout="stereo", rate=rate)

        # A second at a time. One frame of a ten-minute mix works, but it asks
        # the resampler for a second full-size copy of the whole timeline at
        # once for no gain.
        for i in range(0, max(1, data.shape[1]), rate):
            block = np.ascontiguousarray(data[:, i:i + rate])
            if not block.shape[1]:
                break
            frame = av.AudioFrame.from_ndarray(block, format="fltp", layout="stereo")
            frame.sample_rate = rate
            for converted in resampler.resample(frame):
                for packet in stream.encode(converted):
                    out.mux(packet)
        for converted in resampler.resample(None):
            for packet in stream.encode(converted):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    finally:
        out.close()


def main():
    job = json.loads(open(sys.argv[1], encoding="utf-8").read())
    try:
        print(json.dumps(mix(job)))
    except Refuse as err:
        # Exit 0 with ok:false, the same contract imagetools.py's callers read:
        # a refusal keeps its sentence, and only a genuine crash comes back as a
        # traceback on stderr.
        print(json.dumps({"ok": False, "error": str(err)}))


if __name__ == "__main__":
    main()
