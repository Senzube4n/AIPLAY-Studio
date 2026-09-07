"""Timed lyrics for a generated song — one line-level LRC and one word-level LRC.

Usage: lrc.py <audio> <lyrics.txt> <out-stem> [--vocals <vocals.flac>]
Prints one JSON object on stdout.

WHY TRANSCRIBE-AND-RECONCILE RATHER THAN FORCED ALIGNMENT
---------------------------------------------------------
We know exactly what the words are — we wrote them. The naive move is therefore
forced alignment: hand the model the text and make it place every token. That
fails badly on this material. Alignment is FORCED, so it must consume every word
somewhere, and when the singer drops a line, repeats one, or the song runs
thirty seconds of instrumental, it jams the leftovers onto a single timestamp.

So instead: transcribe the audio (whisper's own words carry real timing and
naturally skip instrumental passages), then sequence-align that transcript
against the KNOWN words. The result keeps OUR text — authority on *what* the
words are, including spelling and profanity the model mishears — and takes
WHISPER's timing, authority on *when*. Words whisper never heard are
interpolated between their neighbours rather than dropped.

This mirrors the approach already proven in the production re-timing worker at
C:\\Users\\chesy\\aiplay-whisper\\whisper_worker_v2.py; the difference is that
this version starts from plain lyrics rather than an existing word LRC.

⚠ HONEST LIMITS, measured on real generated songs:
  - LINE-level timing is reliable and is what visualisers mostly need.
  - WORD-level is approximate on sung vocals. Held and melismatic notes drift by
    1-3 s, because a word stretched over two bars has no single true onset.
  - Whisper invents words for outro vocalise and ad-libs. Reconciling against the
    known lyrics removes the invented TEXT, but a stray anchor can still pull a
    nearby timestamp. The line-level fallback exists for exactly that case.
"""
from __future__ import annotations

import json
import os
import re
import sys
from difflib import SequenceMatcher

# Stage directions, not sung words. Left in the reference they anchor a whole
# bracket onto one timestamp and drag the line with it.
#
# Both bracket styles matter: the model's own format uses [Verse] / [Chorus],
# but writers also drop parenthetical directions on their own line — "(spoken)",
# "(whispered)", "(instrumental)". The first draft only stripped square brackets
# and "(spoken)" duly turned up in the LRC as a lyric line with a timestamp.
SECTION_RE = re.compile(r"^\s*[\[\(][^\]\)]*[\]\)]\s*$")
WORD_NORM_RE = re.compile(r"[^a-z0-9']")


def norm(s: str) -> str:
    return WORD_NORM_RE.sub("", (s or "").lower())


def stamp(t: float) -> str:
    mm = int(t // 60)
    ss = t - mm * 60
    return f"[{mm:02d}:{ss:05.2f}]"


def lyric_lines(text: str) -> list[list[str]]:
    """Known lyrics -> list of lines, each a list of words. Markers dropped."""
    out = []
    for raw in (text or "").splitlines():
        if not raw.strip() or SECTION_RE.match(raw):
            continue
        words = [w for w in raw.split() if w.strip()]
        if words:
            out.append(words)
    return out


def transcribe(audio: str):
    """Word-level transcription. int8_float16 because this shares a 16 GB card
    with the generation stack and quality at word granularity is dominated by the
    singing, not by the compute type."""
    import stable_whisper
    model = stable_whisper.load_faster_whisper(
        os.environ.get("AIPLAY_WHISPER_MODEL", "large-v3"),
        device="cuda", compute_type="int8_float16",
    )
    # verbose=None keeps the progress bars off stdout. They are written with
    # carriage returns rather than newlines, so a caller splitting stdout into
    # lines gets the entire progress animation glued to the front of the JSON.
    res = model.transcribe(audio, word_timestamps=True, suppress_silence=True,
                           vad=True, regroup=True, verbose=None)
    words = []
    for seg in res.segments:
        for w in (seg.words or []):
            t = (getattr(w, "word", "") or "").strip()
            if t and getattr(w, "start", None) is not None:
                words.append({"text": t, "start": float(w.start), "end": float(w.end or w.start)})
    return words


def reconcile(known: list[list[str]], heard: list[dict]):
    """Give every KNOWN word a time, using the heard words as the clock.

    Matching runs over the flattened word sequence rather than per line, because
    a singer does not respect our line breaks and whisper's segmentation is its
    own. Anything unmatched is interpolated between the nearest matched
    neighbours, so a word whisper missed still lands in the right place instead
    of inheriting 0.0.
    """
    flat = [(li, wi, w) for li, line in enumerate(known) for wi, w in enumerate(line)]
    a = [norm(w) for _, _, w in flat]
    b = [norm(w["text"]) for w in heard]

    times: list[float | None] = [None] * len(flat)
    for tag, i1, i2, j1, j2 in SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag != "equal":
            continue
        for k in range(i2 - i1):
            times[i1 + k] = heard[j1 + k]["start"]

    matched = sum(1 for t in times if t is not None)

    # Interpolate the gaps. Leading unmatched words share the first known time;
    # trailing ones share the last. Neither is exact, but both are ordered, and
    # an ordered guess is usable where a zero is not.
    known_idx = [i for i, t in enumerate(times) if t is not None]
    if known_idx:
        first, last = known_idx[0], known_idx[-1]
        for i in range(first):
            times[i] = times[first]
        for i in range(last + 1, len(times)):
            times[i] = times[last]
        for x, y in zip(known_idx, known_idx[1:]):
            gap = y - x
            if gap > 1:
                step = (times[y] - times[x]) / gap
                for k in range(1, gap):
                    times[x + k] = times[x] + step * k
    else:
        times = [0.0] * len(flat)

    # Monotonic. Interpolation across a repeated lyric can otherwise step
    # backwards, and a player that seeks on these would jump.
    for i in range(1, len(times)):
        if times[i] < times[i - 1]:
            times[i] = times[i - 1]

    return flat, times, matched


def build(known, flat, times) -> tuple[str, str]:
    line_first: dict[int, float] = {}
    word_blocks: dict[int, list[str]] = {}
    for (li, _wi, w), t in zip(flat, times):
        line_first.setdefault(li, t)
        word_blocks.setdefault(li, []).append(f"{stamp(t)}{w} ")
    line_lrc = "\n".join(
        f"{stamp(line_first[li])}{' '.join(known[li])}" for li in range(len(known)) if li in line_first
    )
    word_lrc = "\n\n".join("\n".join(word_blocks[li]) for li in range(len(known)) if li in word_blocks)
    return line_lrc, word_lrc


def main() -> int:
    audio, lyr_path, out_stem = sys.argv[1], sys.argv[2], sys.argv[3]
    vocals = None
    if "--vocals" in sys.argv:
        v = sys.argv[sys.argv.index("--vocals") + 1]
        if os.path.exists(v):
            vocals = v

    with open(lyr_path, encoding="utf-8") as fh:
        known = lyric_lines(fh.read())
    if not known:
        print(json.dumps({"ok": False, "error": "no lyric lines (instrumental?)"}))
        return 0

    try:
        heard = transcribe(vocals or audio)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"transcribe failed: {exc}"[:300]}))
        return 0

    flat, times, matched = reconcile(known, heard)
    line_lrc, word_lrc = build(known, flat, times)

    with open(out_stem + ".lrc", "w", encoding="utf-8") as fh:
        fh.write(line_lrc)
    with open(out_stem + ".word.lrc", "w", encoding="utf-8") as fh:
        fh.write(word_lrc)

    print(json.dumps({
        "ok": True,
        "lines": len(known),
        "words": len(flat),
        "heard": len(heard),
        "matched": matched,
        # The number worth surfacing: how much of the timing is measured rather
        # than interpolated. Low confidence means the vocal was hard to hear, and
        # the word-level file should be treated as a rough guide.
        "confidence": round(matched / max(1, len(flat)), 3),
        "usedVocalStem": bool(vocals),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
