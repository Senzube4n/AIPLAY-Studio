"""
A hummed melody, as the two-voice ABC score YuE2 takes verbatim.

    python hum_to_abc.py <audio> [--bpm N] [--key K] [--json]

Runs in the engine's python (it has librosa 0.11 and soundfile); the Node side
converts whatever the browser or an agent hands in to 22.05 kHz mono WAV with
ffmpeg first, so this reads WAV only. No model, no card: librosa's pYIN pitch
tracker, a beat tracker for the tempo when none is given, and a Krumhansl key
estimate from the chroma.

What comes out is exactly the layout the planner writes (score.abc of any run):
X:1 / T: / M:4/4 / L:1/32 / Q:1/4=<bpm> / two voices, K:<key>, bars of 32
units, the hum on the Vocal voice and rests on the Ins voice — so the model
arranges under a melody it did not choose. Tempo is a quarter-note figure, as
the planner's own header says. Notes shorter than 80 ms are noise and dropped;
a gap shorter than 60 ms is the singer breathing, not a rest.

This is the "hum only" half of Mothersuperior's YuE2-hum-to-song recipe (its
transcriber is SheetSage2, a 229 MB model; this is a pitch tracker, which is
enough for a monophonic hum and needs nothing downloaded). The other half —
leaving the score OPEN so the planner continues it — is the driver's
--abc-open flag, and this file has nothing to do with it.
"""
from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np

NOTE_NAMES = ["C", "^C", "D", "^D", "E", "F", "^F", "G", "^G", "A", "^A", "B"]
FLAT_NAMES = ["C", "_D", "D", "_E", "E", "F", "_G", "G", "_A", "A", "_B", "B"]
KEY_NAMES_MAJ = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
KEY_NAMES_MIN = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]
FLAT_KEYS = {"F", "Bb", "Eb", "Ab", "Db", "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm"}
UNITS_PER_BAR = 32          # L:1/32 in 4/4
UNITS_PER_BEAT = 8

# Krumhansl-Kessler profiles.
MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def load(path):
    import soundfile as sf
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != 22050:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=22050)
        sr = 22050
    return y, sr


def track(y, sr, hop=256):
    import librosa
    f0, voiced, prob = librosa.pyin(y, fmin=float(librosa.note_to_hz("C2")), fmax=float(librosa.note_to_hz("C6")),
                                   sr=sr, frame_length=2048, hop_length=hop)
    midi = np.full(f0.shape, np.nan)
    ok = ~np.isnan(f0)
    midi[ok] = librosa.hz_to_midi(f0[ok])
    voiced = np.asarray(voiced, dtype=bool) & ok
    return midi, voiced, hop


def segment(midi, voiced, hop, sr, min_note=0.08, min_gap=0.06):
    """Runs of voiced frames on one rounded pitch → (start_s, end_s, midi)."""
    dt = hop / sr
    notes = []
    cur = None
    for i, (v, m) in enumerate(zip(voiced, midi)):
        t = i * dt
        if v and not math.isnan(m):
            p = int(round(m))
            if cur is None:
                cur = [t, t + dt, p, [m]]
            elif abs(m - cur[2]) <= 0.6:
                cur[1] = t + dt; cur[3].append(m)
            else:
                notes.append(cur); cur = [t, t + dt, p, [m]]
        else:
            if cur is not None:
                notes.append(cur); cur = None
    if cur is not None:
        notes.append(cur)
    # median pitch per note, then bridge breaths and drop noise
    out = []
    for s, e, p, ms in notes:
        p = int(round(float(np.median(ms))))
        if out and p == out[-1][2] and s - out[-1][1] < min_gap:
            out[-1][1] = e
        else:
            out.append([s, e, p])
    return [(s, e, p) for s, e, p in out if e - s >= min_note]


def tempo(y, sr, given=None):
    if given:
        return float(given), "given"
    import librosa
    try:
        t, _ = librosa.beat.beat_track(y=y, sr=sr)
        t = float(np.atleast_1d(t)[0])
        while t > 160: t /= 2
        while t and t < 70: t *= 2
        if t:
            return round(t), "beat-tracked"
    except Exception:
        pass
    return 100.0, "default"


def key_of(y, sr, given=None):
    if given:
        return given, "given"
    import librosa
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    if not np.any(chroma):
        return "C", "default"
    best = (-2.0, "C")
    for tonic in range(12):
        for prof, names in ((MAJ, KEY_NAMES_MAJ), (MIN, KEY_NAMES_MIN)):
            r = float(np.corrcoef(np.roll(prof, tonic), chroma)[0, 1])
            if r > best[0]:
                best = (r, names[tonic])
    return best[1], "estimated"


def abc_pitch(midi, flats):
    names = FLAT_NAMES if flats else NOTE_NAMES
    name = names[midi % 12]
    octave = midi // 12 - 1          # MIDI 60 = C4
    if octave >= 5:
        return name.lower() + "'" * (octave - 5)
    return name + "," * max(0, 4 - octave)


def quantise(notes, bpm):
    """Onsets and lengths onto the 1/32 grid; returns [(unit_start, units, midi)]."""
    unit = 60.0 / bpm / UNITS_PER_BEAT
    out = []
    for s, e, p in notes:
        a = int(round(s / unit)); b = int(round(e / unit))
        if b <= a: b = a + 1
        if out and a < out[-1][0] + out[-1][1]:
            a = out[-1][0] + out[-1][1]
            if b <= a: continue
        out.append([a, b - a, p])
    # A note of one grid unit is the tracker catching the glide between two
    # real notes, not a note somebody hummed. It joins the note it follows
    # (or, at the start, the one it precedes) so the grid stays contiguous.
    merged = []
    for a, n, p in out:
        if n < 2 and merged:
            merged[-1][1] += n
        elif n < 2:
            merged.append([a, n, p])
        else:
            if merged and merged[-1][1] < 2:
                merged[-1] = [merged[-1][0], merged[-1][1] + n, p]
            else:
                merged.append([a, n, p])
    return merged


def bars_from(quantised, flats):
    """Bar strings for the Vocal voice, rests filled in, notes split at bar lines with ties."""
    if not quantised:
        return []
    end = max(a + n for a, n, _ in quantised)
    nbars = max(1, math.ceil(end / UNITS_PER_BAR))
    grid = [None] * (nbars * UNITS_PER_BAR)
    for a, n, p in quantised:
        for u in range(a, a + n):
            grid[u] = p
    bars = []
    for b in range(nbars):
        cells = grid[b * UNITS_PER_BAR:(b + 1) * UNITS_PER_BAR]
        tokens = []
        i = 0
        while i < UNITS_PER_BAR:
            p = cells[i]; j = i
            while j < UNITS_PER_BAR and cells[j] == p:
                j += 1
            n = j - i
            if p is None:
                tokens.append("z%d" % n)
            else:
                tie = "-" if j == UNITS_PER_BAR and b + 1 < nbars and grid[(b + 1) * UNITS_PER_BAR] == p else ""
                tokens.append("%s%d%s" % (abc_pitch(p, flats), n, tie))
            i = j
        bars.append("".join(tokens) + "|")
    return bars


def render(bars, bpm, key):
    head = ["X:1", "T:", "M:4/4", "L:1/32", "Q:1/4=%d" % round(bpm),
            'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
            'V: Ins clef=treble name="Ins Melody" snm="Inst."',
            "K:%s" % key, "% hummed"]
    body = []
    for i in range(0, len(bars), 4):
        chunk = bars[i:i + 4]
        body.append("V: Vocal")
        body.append("".join(chunk))
        body.append("V: Ins")
        body.append("".join("Z|" for _ in chunk))
    return "\n".join(head + body) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--bpm", type=float, default=None)
    ap.add_argument("--key", default=None)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    y, sr = load(args.audio)
    seconds = len(y) / sr
    if seconds < 1.0:
        raise SystemExit("The recording is under a second; hum at least a phrase.")
    if seconds > 60.0:
        raise SystemExit("The recording is over a minute; the score is meant to seed a song, not be one.")
    midi, voiced, hop = track(y, sr)
    notes = segment(midi, voiced, hop, sr)
    if not notes:
        raise SystemExit("No pitched notes were found — hum closer to the microphone, on a vowel, without music behind you.")
    bpm, bpm_from = tempo(y, sr, args.bpm)
    key, key_from = key_of(y, sr, args.key)
    q = quantise(notes, bpm)
    bars = bars_from(q, key in FLAT_KEYS)
    abc = render(bars, bpm, key)
    answer = {"abc": abc, "bpm": bpm, "bpmFrom": bpm_from, "key": key, "keyFrom": key_from,
              "seconds": round(seconds, 2), "notes": len(q), "bars": len(bars),
              "pitchRange": [int(min(p for _, _, p in q)), int(max(p for _, _, p in q))]}
    if args.json:
        sys.stdout.write(json.dumps(answer, ensure_ascii=True) + "\n")
    else:
        sys.stdout.write(abc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
