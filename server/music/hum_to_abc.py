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
the planner's own header says. Notes shorter than 80 ms are noise and dropped,
and so is a SHORT run (under 150 ms) that pYIN was much less sure of than the
rest of the recording (median voiced probability under half the recording's
own median); a gap shorter than 60 ms is the singer breathing, not a rest.

This is the "hum only" half of Mothersuperior's YuE2-hum-to-song recipe (its
transcriber is SheetSage2, a 229 MB model; this is a pitch tracker, which is
enough for a monophonic hum and needs nothing downloaded). The other half —
leaving the score OPEN so the planner continues it — is the driver's
--abc-open flag, and this file has nothing to do with it.

SPELLING, 2026-09-24 (a tester's report: "some notes come out a half-step
off"). The score declares K:<key>, and YuE2's ABC dialect — like Studio's own
reader, server/mcp-music-score.js parseScore — applies that signature to every
unmarked note, and an accidental stays in force for the rest of its bar, by
LETTER, across octaves. This file used to spell every pitch as if the key were
C, so an F natural under K:G was read as F# (measured: 65 came back 66), and
the second F of `^F4F4` in K:C was read sharp too. Each bar now starts from the
key signature, tracks what is in force per letter, and writes `=`, `^` or `_`
exactly when the sounding pitch needs a different alteration from that state.

Lengths are split into the dialect's own multipliers (1 2 3 4 6 8 12 16 24 32
48; abc_tools.py refuses any other, so a 5-unit note becomes `E4-E1`), rests
shorter than 2 units close into the note before them, and the lead-in silence
before the first note is trimmed: the grid starts at the first onset, which
becomes beat one of bar one.

SPEED: pYIN at hop 512 (the default is 256), at its default 0.1-semitone
resolution. Measured on 25 s of real sung vocal stems, CPU, 2026-09-24:
8.6 s → 3.7 s and 9.8 s → 4.5 s with the same voiced time (13.9 s vs 13.5 s)
and the same notes to within two. A coarser 0.25-semitone grid is 4x faster
again but NOT the same notes on real voice, though it is on a synthetic
hum: pYIN's voicing decision changes with the grid, and it cut the voiced
time to 9.3 s on the same stem and 17.1 s → 5.0 s on a full mix (70 notes
→ 13). On that coarser grid the synthetic hum's held E also came back with
a 93 ms D# tail at median voiced probability 0.20 (sung notes sit near
0.95); the probability gate above drops blips like it, and on a real vocal
stem it drops sibilant blips at pYIN's floor. The gate is relative and short-runs-only because an
absolute 0.5 dropped every note of a breathy or noisy hum (median 0.02-0.43,
measured 2026-09-24: 9 of 9 notes → 0) and half the notes of real sung stems;
the voiced flag and the pitch stay right while the probability collapses.
"""
from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np

KEY_NAMES_MAJ = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
KEY_NAMES_MIN = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]
UNITS_PER_BAR = 32          # L:1/32 in 4/4
UNITS_PER_BEAT = 8

# The dialect's key table and letter values, as server/mcp-music-score.js has
# them (KEY_FIFTHS, NATURAL): a key is its count of fifths, sharps positive.
NATURAL = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
KEY_FIFTHS = {}
for _i, _k in enumerate(["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]):
    KEY_FIFTHS[_k] = _i - 7
for _i, _k in enumerate(["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"]):
    KEY_FIFTHS[_k] = _i - 7
# abc_tools.py:30 — the only note lengths the dialect takes; anything else is
# written as tied pieces (notes) or consecutive rests.
DURATIONS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]
ACC_MARK = {-1: "_", 0: "=", 1: "^"}


def key_signature(key):
    """{letter: alteration} for a key in the dialect's table (sharps +1, flats -1)."""
    count = KEY_FIFTHS[key]
    order = "FCGDAEB" if count > 0 else "BEADGCF"
    sig = {letter: 0 for letter in NATURAL}
    for letter in order[:abs(count)]:
        sig[letter] = 1 if count > 0 else -1
    return sig


def table_key(key):
    """A key the dialect's table holds, with the same tonic and mode.

    hum.js lets any `[A-G](b|#)?m?` through, and G#, D#m-style spellings
    outside the table would make the score unreadable (K: is refused). So an
    enharmonic twin is written instead — G# major as Ab, Gbm as F#m — the one
    with fewer accidentals."""
    if key in KEY_FIFTHS:
        return key
    minor = key.endswith("m")
    root = key[:-1] if minor else key
    if not root or root[0] not in NATURAL:
        return "C"                               # not a key at all; hum.js never sends one
    pc = (NATURAL[root[0]] + (1 if "#" in root else -1 if "b" in root else 0)) % 12
    best = None
    for name, fifths in KEY_FIFTHS.items():
        if name.endswith("m") != minor:
            continue
        r = name[:-1] if minor else name
        if (NATURAL[r[0]] + (1 if "#" in r else -1 if "b" in r else 0)) % 12 == pc:
            if best is None or abs(fifths) < abs(KEY_FIFTHS[best]):
                best = name
    return best or "C"


def spell(midi, sig, flats):
    """(letter, alteration) for a sounding pitch under a key signature.

    In order: the key's own spelling of the pitch (E# in F# major, Cb in Gb);
    a white key as itself (a natural, which may need `=`); a black key as a
    sharp in sharp and natural keys, a flat in flat keys."""
    pc = midi % 12
    for letter, value in NATURAL.items():
        if (value + sig[letter]) % 12 == pc:
            return letter, sig[letter]
    for letter, value in NATURAL.items():
        if value == pc:
            return letter, 0
    for letter, value in NATURAL.items():
        if not flats and (value + 1) % 12 == pc:
            return letter, 1
        if flats and (value - 1) % 12 == pc:
            return letter, -1
    raise ValueError("unspellable pitch %r" % midi)


def letter_text(midi, letter, alteration):
    """The letter with its octave marks; the written note is `midi - alteration`."""
    written = midi - alteration                  # a white key, MIDI 60 = C4
    octave = written // 12 - 1
    if octave >= 5:
        return letter.lower() + "'" * (octave - 5)
    return letter + "," * max(0, 4 - octave)


def pieces(units):
    """A length as the dialect's multipliers, largest first (10 → 8 + 2)."""
    out = []
    left = units
    while left > 0:
        take = max(d for d in DURATIONS if d <= left)
        out.append(take)
        left -= take
    return out

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


def track(y, sr, hop=512):
    import librosa
    # hop 512 halves the time with the same voiced frames; the pitch grid
    # stays pYIN's default 0.1 semitone, because a coarser grid changes which
    # frames pYIN calls voiced on real voice (module docstring, SPEED).
    f0, voiced, prob = librosa.pyin(y, fmin=float(librosa.note_to_hz("C2")), fmax=float(librosa.note_to_hz("C6")),
                                   sr=sr, frame_length=2048, hop_length=hop)
    midi = np.full(f0.shape, np.nan)
    ok = ~np.isnan(f0)
    midi[ok] = librosa.hz_to_midi(f0[ok])
    voiced = np.asarray(voiced, dtype=bool) & ok
    return midi, voiced, hop, np.asarray(prob, dtype=float)


def segment(midi, voiced, hop, sr, min_note=0.08, min_gap=0.06, prob=None, short=0.15, rel=0.5):
    """Runs of voiced frames on one rounded pitch → (start_s, end_s, midi).

    With pYIN's voiced probabilities, a run shorter than `short` seconds whose
    median is under `rel` x the recording's own median (over its voiced
    frames) is dropped: a blip the tracker was far less sure of than of the
    singing around it. MEASURED on the synthetic hum at hop 512: the end of a
    held E came back as a 93 ms D# at median 0.20, where the sung notes sat at
    0.95 (recording median 0.89). Both limits are needed: a breathy or noisy
    hum sits at a median of 0.02-0.43 over EVERY note (an absolute 0.5 read
    0 of 9 notes there), and a held note is never a blip whatever its
    probability (real sung stems: held notes of ~1 s at 0.14-0.35). On 25 s
    of a real vocal stem (recording median 0.09) every run this drops sat at
    or near pYIN's floor, 0.01-0.04, most of them at MIDI 78-83 (sibilants);
    none was longer than 139 ms."""
    dt = hop / sr
    notes = []
    cur = None
    for i, (v, m) in enumerate(zip(voiced, midi)):
        t = i * dt
        pr = float(prob[i]) if prob is not None and i < len(prob) else 1.0
        if v and not math.isnan(m):
            p = int(round(m))
            if cur is None:
                cur = [t, t + dt, p, [m], [pr]]
            elif abs(m - cur[2]) <= 0.6:
                cur[1] = t + dt; cur[3].append(m); cur[4].append(pr)
            else:
                notes.append(cur); cur = [t, t + dt, p, [m], [pr]]
        else:
            if cur is not None:
                notes.append(cur); cur = None
    if cur is not None:
        notes.append(cur)
    if prob is not None and notes:
        v = np.asarray(voiced, dtype=bool)[: len(prob)]
        ref = float(np.median(np.asarray(prob)[: len(v)][v])) if v.any() else 0.0
        notes = [n for n in notes
                 if not (n[1] - n[0] < short and float(np.median(n[4])) < rel * ref)]
    # median pitch per note, then bridge breaths and drop noise
    out = []
    for s, e, p, ms, _ in notes:
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


def quantise(notes, bpm):
    """Onsets and lengths onto the 1/32 grid; returns [(unit_start, units, midi)].

    The grid starts at the first onset: the silence before it (the breath
    after pressing Record) is not part of the melody, and keeping it pushed
    every note off the beat by however long that took."""
    unit = 60.0 / bpm / UNITS_PER_BEAT
    lead = notes[0][0] if notes else 0.0
    notes = [(s - lead, e - lead, p) for s, e, p in notes]
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
    # A rest shorter than two units is the tracker losing the voice between
    # two legato notes, not a rest anybody sang: the note before it holds on.
    for cur, nxt in zip(merged, merged[1:]):
        gap = nxt[0] - (cur[0] + cur[1])
        if 0 < gap < 2:
            cur[1] += gap
    return merged


def bars_from(quantised, key="C"):
    """Bar strings for the Vocal voice, rests filled in, notes split at bar lines with ties.

    Each bar starts from the key signature and tracks, per letter, the
    alteration in force (the dialect carries an accidental to the end of its
    bar, across octaves); a note gets `=`, `^` or `_` only when the pitch it
    must sound differs from that. A tied continuation is written unmarked:
    the reader keeps a tied pitch, even across a barline."""
    if not quantised:
        return []
    if isinstance(key, bool):                    # the old (quantised, flats) call shape
        key = "F" if key else "C"
    key = table_key(key)
    sig = key_signature(key)
    flats = KEY_FIFTHS[key] < 0
    end = max(a + n for a, n, _ in quantised)
    nbars = max(1, math.ceil(end / UNITS_PER_BAR))
    grid = [None] * (nbars * UNITS_PER_BAR)
    starts = set()
    for a, n, p in quantised:
        starts.add(a)
        for u in range(a, a + n):
            grid[u] = p
    bars = []
    held = None                                   # (midi, letter text, letter, alteration) of the note being held
    for b in range(nbars):
        cells = grid[b * UNITS_PER_BAR:(b + 1) * UNITS_PER_BAR]
        local = {}
        # A note tied in over the barline sounds its own alteration without
        # setting the bar's; a later note on that letter is then marked even
        # where the signature would already give it (a courtesy `=`), so a
        # reader that carries the tied accidental on reads it the same way.
        carried = {}
        tokens = []
        i = 0
        while i < UNITS_PER_BAR:
            p = cells[i]; j = i + 1
            while j < UNITS_PER_BAR and cells[j] == p and (b * UNITS_PER_BAR + j) not in starts:
                j += 1
            n = j - i
            if p is None:
                tokens.extend("z%d" % d for d in pieces(n))
                held = None
            else:
                last = j == UNITS_PER_BAR
                tie_out = last and b + 1 < nbars and grid[(b + 1) * UNITS_PER_BAR] == p \
                    and ((b + 1) * UNITS_PER_BAR) not in starts
                if i == 0 and held is not None and held[0] == p:
                    head = held[1]                # continues a tie: unmarked
                    carried[held[2]] = held[3]
                else:
                    letter, alteration = spell(p, sig, flats)
                    in_force = local.get(letter, sig[letter])
                    courtesy = letter not in local and carried.get(letter, alteration) != alteration
                    mark = ACC_MARK[alteration] if alteration != in_force or courtesy else ""
                    if mark:
                        local[letter] = alteration
                    head = mark + letter_text(p, letter, alteration)
                    held = (p, letter_text(p, letter, alteration), letter, alteration)
                parts = pieces(n)
                for k, d in enumerate(parts):
                    text = head if k == 0 else held[1]
                    tie = "-" if k < len(parts) - 1 or tie_out else ""
                    tokens.append("%s%d%s" % (text, d, tie))
                if not tie_out:
                    held = None if last else held
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
    midi, voiced, hop, prob = track(y, sr)
    notes = segment(midi, voiced, hop, sr, prob=prob)
    if not notes:
        raise SystemExit("No pitched notes were found — hum closer to the microphone, on a vowel, without music behind you.")
    bpm, bpm_from = tempo(y, sr, args.bpm)
    key, key_from = key_of(y, sr, args.key)
    written = table_key(key)
    if written != key:
        key_from = "%s, written as %s" % (key_from, written)
        key = written
    q = quantise(notes, bpm)
    bars = bars_from(q, key)
    abc = render(bars, bpm, key)
    answer = {"abc": abc, "bpm": bpm, "bpmFrom": bpm_from, "key": key, "keyFrom": key_from,
              "seconds": round(seconds, 2), "notes": len(q), "bars": len(bars),
              "leadIn": round(float(notes[0][0]), 2),
              "pitchRange": [int(min(p for _, _, p in q)), int(max(p for _, _, p in q))]}
    if args.json:
        sys.stdout.write(json.dumps(answer, ensure_ascii=True) + "\n")
    else:
        sys.stdout.write(abc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
