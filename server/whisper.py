"""Whisper as a general tool: transcribe any audio or video file, and time lyrics.

Usage: whisper.py <input> [--lyrics <lyrics.txt>] [--out <out-stem>]
                  [--language <code>] [--words] [--vocals <vocals.flac>]

Prints one JSON object on stdout, on success AND on every failure Python can
still report, the same contract as lrc.py (server/lrc.js reads both the same
way, and its CPU re-run after a native cuDNN abort works here unchanged).

What it answers:
  - always: language, text, segments [{start, end, text}], device, model;
  - --words: each segment carries words [{text, start, end}];
  - --lyrics: the known lyrics reconciled against what was heard, with lrc.py's
    reconcile() (our text, whisper's timing): lines [{start, text}] (and their
    words with --words), confidence, matched;
  - --out: <out-stem>.lrc and <out-stem>.word.lrc, from the known lyrics when
    given, else from the heard segments.

Environment: AIPLAY_WHISPER_MODEL and AIPLAY_WHISPER_DEVICE, exactly as lrc.py
reads them. The device logic, the failure sentences and the device marker on
stderr are lrc.py's own, imported rather than copied: a second copy is how two
scripts come to disagree about which GPU failure falls back to the CPU.
"""
from __future__ import annotations

import gc
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lrc  # noqa: E402  (beside this file; stdlib-only at import)

USAGE = "whisper.py <input> [--lyrics <file>] [--out <stem>] [--language <code>] [--words] [--vocals <file>]"


def parse_args(argv: list[str]) -> dict:
    """argv -> options. Unknown flags are an error, not ignored: a caller that
    misspells --lyrics must hear about it rather than get a plain transcript."""
    if not argv or argv[0].startswith("--"):
        raise lrc.LrcError(f"no input file; usage: {USAGE}")
    opts = {"input": argv[0], "lyrics": None, "out": None, "language": None, "words": False, "vocals": None}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--words":
            opts["words"] = True
            i += 1
            continue
        if a in ("--lyrics", "--out", "--language", "--vocals"):
            if i + 1 >= len(argv):
                raise lrc.LrcError(f"{a} needs a value; usage: {USAGE}")
            opts[a[2:]] = argv[i + 1]
            i += 2
            continue
        raise lrc.LrcError(f"unknown argument {a!r}; usage: {USAGE}")
    lang = (opts["language"] or "").strip().lower()
    opts["language"] = None if lang in ("", "auto") else lang
    return opts


def transcribe_full(audio: str, device: str, compute_type: str, language: str | None) -> dict:
    """Segments with word timing, the language whisper settled on, the text.

    The same model call as lrc.transcribe() (VAD on, silence suppressed,
    regrouped, progress bars off stdout), keeping what that one throws away."""
    import stable_whisper
    lrc.PHASE = "load"
    model = stable_whisper.load_faster_whisper(lrc.MODEL, device=device, compute_type=compute_type)
    lrc.PHASE = "transcribe"
    kw = {"language": language} if language else {}
    res = model.transcribe(audio, word_timestamps=True, suppress_silence=True,
                           vad=True, regroup=True, verbose=None, **kw)
    segments = []
    for seg in res.segments:
        text = (getattr(seg, "text", "") or "").strip()
        words = []
        for w in (seg.words or []):
            t = (getattr(w, "word", "") or "").strip()
            if t and getattr(w, "start", None) is not None:
                words.append({"text": t, "start": round(float(w.start), 3),
                              "end": round(float(w.end if w.end is not None else w.start), 3)})
        if not text and not words:
            continue
        segments.append({"start": round(float(seg.start), 3), "end": round(float(seg.end), 3),
                         "text": text, "words": words})
    return {
        "language": getattr(res, "language", None) or language,
        "text": " ".join(s["text"] for s in segments).strip(),
        "segments": segments,
    }


def heard_words(segments: list[dict]) -> list[dict]:
    """The flat word list reconcile() takes as its clock."""
    return [w for s in segments for w in s["words"]]


def segment_lines(segments: list[dict]):
    """Heard segments in the (known, flat, times) shape lrc.build() writes, so a
    transcript with no known lyrics still makes an LRC pair. A segment whisper
    gave no word timing gets its own start for every word."""
    known, flat, times = [], [], []
    for s in segments:
        words = [(w["text"], w["start"]) for w in s["words"]] or [(t, s["start"]) for t in s["text"].split()]
        if not words:
            continue
        li = len(known)
        known.append([t for t, _ in words])
        for wi, (t, at) in enumerate(words):
            flat.append((li, wi, t))
            times.append(at)
    return known, flat, times


def aligned_lines(known, flat, times, with_words: bool) -> list[dict]:
    out: dict[int, dict] = {}
    for (li, _wi, w), t in zip(flat, times):
        line = out.setdefault(li, {"start": round(float(t), 3), "text": " ".join(known[li])})
        if with_words:
            line.setdefault("words", []).append({"text": w, "start": round(float(t), 3)})
    return [out[li] for li in range(len(known)) if li in out]


def run(opts: dict) -> dict:
    """The transcription, on the device lrc.pick_device() chose, moving to the
    CPU in this process after a GPU failure Python can catch: lrc.py's main()
    line for line, because the reasons are the same (see there)."""
    device = compute = why_cpu = None
    source = opts["vocals"] if opts["vocals"] and os.path.exists(opts["vocals"]) else None
    audio = source or opts["input"]
    got = None
    try:
        import stable_whisper  # noqa: F401  (maps a CUDA torch's libraries first)
        device, compute, why_cpu = lrc.pick_device()
        lrc.mark_device(device, compute)
        try:
            got = transcribe_full(audio, device, compute, opts["language"])
        except Exception as exc:  # noqa: BLE001
            if not (device == "cuda" and lrc.wanted_device() == "auto" and lrc.gpu_failure(exc)):
                raise
            why_cpu = f"the GPU run failed ({lrc.one_line(exc, 200)})"
        if got is None:
            gc.collect()
            device, compute = "cpu", "int8"
            lrc.mark_device(device, compute)
            got = transcribe_full(audio, device, compute, opts["language"])
    except Exception as exc:  # noqa: BLE001
        error = lrc.describe(exc, device)
        if device == "cpu" and why_cpu and why_cpu != "AIPLAY_WHISPER_DEVICE=cpu":
            error += f" (on the CPU because {why_cpu})"
        return {"ok": False, "error": error[:600], "device": device, "needsInstall": lrc.needs_install(exc)}
    lrc.PHASE = "write"

    segments = got["segments"]
    result = {
        "ok": True,
        "language": got["language"],
        "text": got["text"],
        "segments": [s if opts["words"] else {k: s[k] for k in ("start", "end", "text")} for s in segments],
        "duration": segments[-1]["end"] if segments else 0.0,
        "usedVocalStem": bool(source),
        "device": device,
        "computeType": compute,
        "model": lrc.MODEL,
    }
    if device == "cpu":
        result["cpuReason"] = why_cpu

    known = None
    if opts["lyrics"]:
        with open(opts["lyrics"], encoding="utf-8") as fh:
            known = lrc.lyric_lines(fh.read())
    if known:
        heard = heard_words(segments)
        flat, times, matched = lrc.reconcile(known, heard)
        result["aligned"] = {
            "lines": aligned_lines(known, flat, times, opts["words"]),
            "words": len(flat), "heard": len(heard), "matched": matched,
            # How much of the timing is measured rather than interpolated.
            "confidence": round(matched / max(1, len(flat)), 3),
        }
    elif opts["lyrics"]:
        result["alignNote"] = "the lyrics had no lines to time (only section markers, or empty)"
    else:
        known, flat, times = segment_lines(segments)

    if opts["out"]:
        if known:
            line_lrc, word_lrc = lrc.build(known, flat, times)
            with open(opts["out"] + ".lrc", "w", encoding="utf-8") as fh:
                fh.write(line_lrc)
            with open(opts["out"] + ".word.lrc", "w", encoding="utf-8") as fh:
                fh.write(word_lrc)
            result["lrc"] = os.path.basename(opts["out"]) + ".lrc"
            result["wordLrc"] = os.path.basename(opts["out"]) + ".word.lrc"
        else:
            result["lrcNote"] = "nothing was heard, so no LRC was written"
    return result


def main() -> int:
    opts = parse_args(sys.argv[1:])
    if not os.path.isfile(opts["input"]):
        raise lrc.LrcError(f"there is no file at {opts['input']}")
    lrc.emit(run(opts))
    return 0


if __name__ == "__main__":
    # Same net as lrc.py: anything Python can still catch leaves one JSON line.
    try:
        code = main()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        lrc.emit({"ok": False, "error": lrc.describe(exc)[:600], "needsInstall": lrc.needs_install(exc)})
        code = 0
    sys.exit(code)
