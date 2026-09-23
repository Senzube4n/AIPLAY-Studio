"""Timed lyrics for a generated song — one line-level LRC and one word-level LRC.

Usage: lrc.py <audio> <lyrics.txt> <out-stem> [--vocals <vocals.flac>]
Prints one JSON object on stdout — on success AND on every failure Python can
still report, so the caller never has to guess from silence.

Environment:
  AIPLAY_WHISPER_MODEL   whisper model name (default large-v3)
  AIPLAY_WHISPER_DEVICE  auto (default) | cuda | cpu. auto uses the GPU when
                         CUDA and its libraries are really there and falls back
                         to the CPU (int8) when they are not; the JSON says which
                         device ran and, on the CPU, why.

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

This mirrors the approach already proven in a production re-timing worker; the
difference is that
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

import gc
import glob
import json
import os
import re
import shutil
import sys
from difflib import SequenceMatcher

MODEL = os.environ.get("AIPLAY_WHISPER_MODEL", "large-v3")

# pip's name for each module this script imports. The install COMMAND is not
# built here: a failure that needs one says so ("needsInstall" in the JSON) and
# server/lrc.js adds the lines, from the one builder that writes them in a form
# Command Prompt and PowerShell both accept. A second builder here once printed
# the quoted-exe form PowerShell cannot parse.
PIP_NAME = {"stable_whisper": "stable-ts", "faster_whisper": "faster-whisper"}

# An environment variable reaches Studio only through the process that starts
# it, and the launcher keeps its own environment: "restart Studio" from the
# launcher changes nothing. Same words as ENV_RESTART in server/lrc.js.
ENV_RESTART = "quit AIPLAY Studio completely, launcher included, and start it again"

# Where the process is when something raises: the message for a failed download
# depends on it (the model at load time, Silero VAD during transcription).
PHASE = "start"


class LrcError(Exception):
    """A failure whose message is already the sentence a person should read."""


def one_line(exc: BaseException, cap: int = 300) -> str:
    return re.sub(r"\s+", " ", str(exc)).strip()[:cap] or type(exc).__name__


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


# ─────────────────────────────────────────────────────────── which device

def wanted_device() -> str:
    want = (os.environ.get("AIPLAY_WHISPER_DEVICE") or "auto").strip().lower()
    if want not in ("auto", "cuda", "cpu"):
        raise LrcError(f"AIPLAY_WHISPER_DEVICE is {want!r}; it must be auto, cuda or cpu")
    return want


def cudnn_libs(ct2_dir: str) -> list[str]:
    """The cuDNN libraries this ctranslate2 build opens at its first convolution.

    ctranslate2's Windows wheel carries only cuDNN's front door (cudnn64_9.dll).
    The ops and cnn libraries behind it must come from a CUDA build of torch, the
    CUDA toolkit on PATH, or nvidia-* wheels. When they are absent cuDNN does NOT
    raise: it prints "Could not locate cudnn_ops64_9.dll" and aborts the process,
    which no try/except can catch and which used to reach the user as "alignment
    failed". So they are looked for before the model is loaded. A build this does
    not recognise returns [] — no guessing."""
    majors = []
    for p in glob.glob(os.path.join(ct2_dir, "cudnn64_*.dll")):
        m = re.fullmatch(r"cudnn64_(\d+)\.dll", os.path.basename(p), re.I)
        if m:
            majors.append(int(m.group(1)))
    if not majors:
        return []
    n = max(majors)
    if n >= 9:
        return [f"cudnn_ops64_{n}.dll", f"cudnn_cnn64_{n}.dll"]
    return [f"cudnn_ops_infer64_{n}.dll", f"cudnn_cnn_infer64_{n}.dll"]


def missing_dlls(names: list[str]) -> list[str]:
    """Which of these DLLs this process could NOT load. Mapping a DLL starts no
    CUDA context and uses no VRAM. Present means any of: already mapped (a CUDA
    torch maps all of torch/lib when it is imported), loadable through the
    add_dll_directory folders, or loadable from PATH."""
    if not names or sys.platform != "win32":
        return []
    import ctypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetModuleHandleW.restype = ctypes.c_void_p
    k32.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
    missing = []
    for name in names:
        if k32.GetModuleHandleW(name):
            continue
        for kw in ({}, {"winmode": 0}):
            try:
                ctypes.WinDLL(name, **kw)
                break
            except OSError:
                continue
        else:
            missing.append(name)
    return missing


def pick_device() -> tuple[str, str, str | None]:
    """(device, compute_type, why_cpu).

    cuda keeps int8_float16 whenever the card offers it — exactly what this
    script always ran — because it shares a 16 GB card with the generation stack
    and word-level quality is dominated by the singing, not the compute type. The
    CPU always gets int8: int8_float16 there raises ValueError (measured)."""
    want = wanted_device()
    if want == "cpu":
        return "cpu", "int8", "AIPLAY_WHISPER_DEVICE=cpu"
    if want == "cuda":
        return "cuda", "int8_float16", None
    import ctranslate2
    try:
        count = ctranslate2.get_cuda_device_count()
    except Exception as exc:  # noqa: BLE001
        return "cpu", "int8", f"CUDA is not usable here ({one_line(exc, 160)})"
    if count < 1:
        return "cpu", "int8", "no CUDA GPU was found"
    gone = missing_dlls(cudnn_libs(os.path.dirname(ctranslate2.__file__)))
    if gone:
        return "cpu", "int8", ("the GPU's cuDNN libraries are missing (" + ", ".join(gone)
                               + "); install a CUDA build of torch into this python to use the GPU")
    try:
        types = set(ctranslate2.get_supported_compute_types("cuda"))
    except Exception as exc:  # noqa: BLE001
        return "cpu", "int8", f"CUDA is not usable here ({one_line(exc, 160)})"
    for ct in ("int8_float16", "float16", "int8", "float32"):
        if ct in types:
            return "cuda", ct, None
    return "cpu", "int8", "the GPU offers no compute type whisper can use"


# ─────────────────────────────────────────────────────────── what went wrong

GPU_RE = re.compile(r"cuda|cublas|cudnn|out of memory|compute type|nvidia|\bgpu\b|driver", re.I)
OOM_RE = re.compile(r"out of memory|bad_alloc|CUBLAS_STATUS_ALLOC_FAILED", re.I)
NET_RE = re.compile(
    r"huggingface|hf\.co\b|snapshot folder|connecterror|connectionerror|getaddrinfo|"
    r"name or service not known|urlopen error|max retries exceeded|"
    r"outgoing traffic has been disabled|certificate_verify_failed|timed out", re.I)
NET_MODULES = {"huggingface_hub", "requests", "httpx", "httpcore", "urllib3", "urllib", "socket"}


def _chain(exc: BaseException):
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def download_failure(exc: BaseException) -> bool:
    for e in _chain(exc):
        if type(e).__module__.split(".")[0] in NET_MODULES or NET_RE.search(str(e)):
            return True
    return False


def gpu_failure(exc: BaseException) -> bool:
    """A GPU that cannot run whisper at all: cuBLAS missing, a driver too old, a
    compute type the card lacks. Not a download, not a missing file, and NOT
    out of memory: a full card is a busy card (ComfyUI holding a model), and a
    large-v3 pass on the CPU would hold the art queue for minutes while music
    waits behind it. That one is reported, with the way to choose the CPU."""
    return (isinstance(exc, (RuntimeError, ValueError, OSError))
            and not isinstance(exc, FileNotFoundError)
            and not download_failure(exc)
            and not OOM_RE.search(str(exc))
            and bool(GPU_RE.search(str(exc))))


def describe(exc: BaseException, device: str | None = None) -> str:
    """The exception as the sentence a person acts on."""
    msg = one_line(exc)
    if isinstance(exc, LrcError):
        return str(exc)
    # No trailing period on these two: server/lrc.js continues the sentence with
    # the install lines (needs_install), and adds none when there are none.
    if isinstance(exc, ModuleNotFoundError):
        top = (exc.name or "").split(".")[0]
        return (f"{PIP_NAME.get(top, top or 'a package')} is not installed in {sys.executable} "
                f"(No module named '{exc.name}')")
    if isinstance(exc, ImportError):
        return (f"{sys.executable} could not load {exc.name or 'a package timed lyrics needs'}: {msg}; "
                "reinstalling may fix it")
    if download_failure(exc):
        if PHASE == "transcribe":
            return ("could not download Silero VAD from github.com: the first run fetches it "
                    f"and needs internet ({msg})")
        size = " (about 3 GB)" if MODEL == "large-v3" else ""
        return (f"could not download the whisper model {MODEL}{size}: the first run fetches it "
                f"from huggingface.co and needs internet ({msg})")
    if isinstance(exc, MemoryError) or OOM_RE.search(msg):
        if device == "cuda":
            return (f"the GPU ran out of memory running whisper {MODEL} ({msg}). "
                    "Free the card (unload ComfyUI's models) or set the environment variable "
                    f"AIPLAY_WHISPER_DEVICE=cpu (then {ENV_RESTART})")
        return f"ran out of memory running whisper {MODEL} on the CPU ({msg})"
    if device == "cuda" and GPU_RE.search(msg):
        return (f"the GPU could not run whisper ({msg}). Set the environment variable "
                f"AIPLAY_WHISPER_DEVICE=cpu or auto to time on the CPU (then {ENV_RESTART})")
    if isinstance(exc, FileNotFoundError) and PHASE == "transcribe" and shutil.which("ffmpeg") is None:
        # PATH is environment too: winget's change reaches Studio only through a
        # launcher started after it.
        return ("stable-ts reads the song with the ffmpeg program and there is none on PATH. "
                f"Install ffmpeg (for example: winget install Gyan.FFmpeg), then {ENV_RESTART}")
    if PHASE in ("load", "transcribe"):
        return f"transcribe failed: {msg}"
    return f"lrc.py crashed: {type(exc).__name__}: {msg}"


def emit(obj: dict) -> None:
    print(json.dumps(obj))
    sys.stdout.flush()


def mark_device(device: str, compute: str) -> None:
    """One stderr line, flushed at once, naming where whisper is about to run.

    server/lrc.js reads the LAST of these. A native abort (cuDNN) prints no
    JSON, and without this line the caller could not tell a crash on the GPU
    from one on the CPU: it re-ran "on the CPU" runs that had never left it."""
    sys.stderr.write(f"[lrc] device={device} compute={compute}\n")
    sys.stderr.flush()


def needs_install(exc: BaseException) -> bool:
    """A failure that installing a package fixes; the caller appends the lines."""
    return isinstance(exc, ImportError)


# ─────────────────────────────────────────────────────────── transcription

def transcribe(audio: str, device: str = "cuda", compute_type: str = "int8_float16"):
    """Word-level transcription on the device pick_device() chose."""
    global PHASE
    import stable_whisper
    PHASE = "load"
    model = stable_whisper.load_faster_whisper(MODEL, device=device, compute_type=compute_type)
    PHASE = "transcribe"
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
    global PHASE
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

    device = compute = why_cpu = None
    heard = None
    try:
        # stable_whisper first: it imports torch, and a CUDA torch maps the cuDNN
        # and cuBLAS libraries that pick_device() then looks for.
        import stable_whisper  # noqa: F401
        device, compute, why_cpu = pick_device()
        mark_device(device, compute)
        try:
            heard = transcribe(vocals or audio, device, compute)
        except Exception as exc:  # noqa: BLE001
            # A GPU failure Python can catch (cuBLAS missing, a driver too old):
            # once more on the CPU, in this process, unless somebody asked for
            # cuda on purpose. Only the REASON is kept here.
            if not (device == "cuda" and wanted_device() == "auto" and gpu_failure(exc)):
                raise
            why_cpu = f"the GPU run failed ({one_line(exc, 200)})"
        if heard is None:
            # The CPU pass runs HERE, after the except block, never inside it.
            # Inside it, `exc` and its traceback keep transcribe()'s frame alive,
            # and with it the CUDA model and every byte of VRAM it holds, for the
            # whole CPU pass, on a card the generation stack is waiting for.
            # Leaving the block drops them; gc.collect() takes any cycle left.
            gc.collect()
            device, compute = "cpu", "int8"
            mark_device(device, compute)
            heard = transcribe(vocals or audio, device, compute)
    except Exception as exc:  # noqa: BLE001
        error = describe(exc, device)
        if device == "cpu" and why_cpu and why_cpu != "AIPLAY_WHISPER_DEVICE=cpu":
            error += f" (on the CPU because {why_cpu})"
        emit({"ok": False, "error": error[:600], "device": device, "needsInstall": needs_install(exc)})
        return 0
    PHASE = "write"

    flat, times, matched = reconcile(known, heard)
    line_lrc, word_lrc = build(known, flat, times)

    with open(out_stem + ".lrc", "w", encoding="utf-8") as fh:
        fh.write(line_lrc)
    with open(out_stem + ".word.lrc", "w", encoding="utf-8") as fh:
        fh.write(word_lrc)

    result = {
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
        "device": device,
        "computeType": compute,
        "model": MODEL,
    }
    if device == "cpu":
        result["cpuReason"] = why_cpu
    emit(result)
    return 0


if __name__ == "__main__":
    # Everything outside the transcription (argv, reading the lyrics, writing the
    # LRC files) raised a bare traceback onto stderr, which the caller never
    # read. Anything Python can still catch now leaves one JSON line instead.
    try:
        code = main()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        emit({"ok": False, "error": describe(exc)[:600], "needsInstall": needs_install(exc)})
        code = 0
    sys.exit(code)
