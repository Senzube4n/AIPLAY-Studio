"""
The YuE2 driver — the far side of the third door.

WHAT THIS IS
------------
`server/music/yue.js` spawns this file with VENV-YUE's python, never with the
engine's and never with the system one. It reads one request (style, lyrics and
five optional fields), writes one folder of artifacts, and prints exactly one
machine-readable line on stdout:

    YUE_RESULT_JSON:{...}

The Node side brace-matches the object after that marker rather than taking the
rest of the line, because a library that prints its own notices shares this pipe:
`yue2/fast.py` `print()`s "[YuE2] Flash Attention failed; retrying with
backend=torch-eager" straight to stdout. See runPreviz() in
server/mv/blender.js for the measured failure that rule comes from — the JSON
arrived complete and the newline after it did not.

Exit codes, deliberately the same vocabulary the previz toolkit and the mesh
driver use so there is one to learn:

    0   done, the artifacts are on the disk, and the result line was printed
    2   REFUSED — a rule this file enforces. The reason is on stderr and is
        meant to be read. Nothing was spent.
    3   the run itself failed — INCLUDING a render that finished and wrote
        nothing. See _verify() for why that is an error and not a success.

WHY IT USES THE PYTHON API AND NOT `python -m yue2.cli`
-------------------------------------------------------
Because the CLI cannot express the one configuration this card needs.
`--budget` is TWO things at once:

    cli.py:36        vae_core_frames = 512 if budget <= 12 else 1024
    pipeline.py:162  budget = min((memory_budget_gib - 2) * 2**30, total - 2*2**30)
    pipeline.py:165  torch.cuda.set_per_process_memory_fraction(budget / total)

So `--budget 12` buys small VAE tiles and simultaneously caps PyTorch at 10.00
GiB on a card with 15.99 — and the run died at nar.py:95 trying to allocate 3.86
GiB in one block with 7.04 GiB still free. The card was never the limit; the cap
was. `--budget 16` lifts the cap and silently switches the VAE to 1024-frame
tiles, which is the other half of the same memory problem.

The pipeline constructor takes both numbers separately. That is the whole reason
this file exists instead of a command line: `memory_budget_gib=16` with
`vae_core_frames=512`.

THE THREE OTHER TRAPS THIS FILE ENCODES
---------------------------------------
1. `save_artifacts` IS A METHOD ON THE RESULT, NOT ON THE PIPELINE
   (pipeline.py:103; cli.py:132 calls `result.save_artifacts(dir)`). A
   `hasattr(pipe, "save_artifacts")` guard was False, the branch was skipped,
   and the process exited 0 — silently discarding a finished 35-minute render.
   That is why _verify() checks the DISK and why its failure is exit 3.

2. FLASH MUST BE OMITTED from the sdpa_kernel preference. torch's Windows
   wheels advertise the op through its ATen schema (registered from
   torch_cpu.dll, independent of the build flags) and then raise, and
   sampling.py:89 opens a `try` whose only handler is the `finally` at :151 — no `except`, so there is no fallback.
   EFFICIENT_ATTENTION and MATH only. This is also a MEMORY fix, not only a
   speed one: the 3.86 GiB allocation above is a dense attention matrix over the
   whole semantic sequence, which is exactly what a memory-efficient kernel
   avoids materialising.

3. `pipe()` TAKES THE FIELDS, NOT A REQUEST. `__call__` builds the SongRequest
   itself (pipeline.py:378-380 -> _request at :225-231), so passing a
   SongRequest into the style slot raises "Provide style and lyrics" — an error
   that reads as "you forgot the lyrics" when the lyrics are right there.

PROGRESS
--------
Not reinvented here. `yue2/progress.py` already writes whole newline-terminated
lines to stderr when the stream is not a TTY, at max(5.0, refresh) second
intervals, and `progress=True` is passed for exactly that. Reformatting them
would mean two vocabularies and two parsers. What this file adds on stderr is its
own milestones, as one-line JSON behind a `YUE_EVENT:` prefix, for the phases the
pipeline does not own: the refusals, the memory readings, and the save.

MEASURED, on this rig (RTX 4070 Ti SUPER, 15.99 GiB usable), 2026-09-11:
    167.0 s of 48 kHz 24-bit stereo in 399.6 s end to end = 2.39x realtime
    load 6.6 s warm (~20 s cold) | ABC plan 0 s when a score is supplied
    semantic 281.0 s, 4177 tokens, 14.87 tok/s | NAR 106.3 s | VAE 5.7 s
    peak ~10.6 GiB | execution "eager", attention "sdpa", cfg_branches 1
"""

import argparse
import json
import locale
import os
import sys
import time

# ⚠ BEFORE torch IS IMPORTED, and torch is imported inside render() for exactly
# that reason. expandable_segments lets the allocator grow a segment instead of
# failing on a large contiguous request, which is the shape of the nar.py:95
# failure described above. MEASURED: the successful run had it set.
os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")

# ⚠ A COURTESY FOR A HAND-RUN, NOT THE FIX. The Node side sets all four of these
# BEFORE this interpreter starts, which is the only form in which PYTHONUTF8 is a
# fix at all: setting it here cannot re-encode stdio that is already configured,
# and cannot change what `Path.write_text` in the vendor package will do. The
# real guard is _refuse_encoding() below, which turns that into a refusal instead
# of a 400-second render that dies writing its own receipt.
for _k, _v in (("HF_HUB_DISABLE_SYMLINKS", "1"), ("HF_HUB_DISABLE_SYMLINKS_WARNING", "1"),
               ("PYTHONUTF8", "1"), ("PYTHONIOENCODING", "utf-8")):
    os.environ.setdefault(_k, _v)

MARKER = "YUE_RESULT_JSON:"
EVENT = "YUE_EVENT:"

# What save_artifacts() writes (pipeline.py:103-118). The first two are REQUIRED;
# the rest are what make a run reproducible.
REQUIRED = ("audio.flac", "result.json")
ARTIFACTS = ("audio.flac", "result.json", "semantic.npy", "latent.npy", "request.json",
             "config.json", "plan.json", "plan_manifest.json", "abc_tokens.npy", "prefix.npy",
             "score.abc")

# The seven fields SongRequest has (protocol.py:82-88). There is no eighth, which
# is why an audio reference is a refusal and not a feature request.
REQUEST_FIELDS = ("style", "lyrics", "cot", "seed", "abc", "cfg_scale", "id")


class Refused(Exception):
    """A rule this file enforces. Exit 2, reason on stderr, nothing spent."""


class OutputMissing(Exception):
    """The render finished and the disk does not show it. Exit 3. See _verify()."""


def _say(obj):
    """The one line the Node side reads. Flushed, because stdout is shared."""
    sys.stdout.write(MARKER + json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _event(**kw):
    """One machine-readable milestone on stderr, beside progress.py's own lines.

    ⚠ ensure_ascii=True on purpose. This line is parsed by JSON.parse on the
    other side and a lyric fragment must never be able to put a raw CJK byte into
    a pipe whose encoding is the thing being guarded.
    """
    kw.setdefault("t", round(time.time(), 3))
    sys.stderr.write(EVENT + json.dumps(kw, ensure_ascii=True) + "\n")
    sys.stderr.flush()


# Deliberately NO _log() helper beside _event(). Prose on stderr next to
# progress.py's own lines would be a second vocabulary on one pipe, and the Node
# parser would then have to ignore it line by line. Everything this file says is
# either a machine-readable YUE_EVENT, a REFUSED/OUTPUT MISSING sentence, or a
# traceback.


# ───────────────────────────────────────────────────── the refusals, before spend

def _refuse_encoding(request):
    """
    ⚠ THE RECEIPT IS WRITTEN THROUGH THE LOCALE'S ENCODING, AND THAT IS A TRAP.

    `yue2/storage.py:28` is:

        temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, ...))

    — `ensure_ascii=False` with NO `encoding=`, so `Path.write_text` uses the
    locale's preferred encoding. On Windows that is cp1252, and a CJK lyric
    raises UnicodeEncodeError inside `save_artifacts()`, AFTER the render. The
    audio is in memory and the receipt cannot be written.

    PYTHONUTF8=1 in the environment before the interpreter starts fixes it. This
    cannot: by the time this module runs, the encoding is decided.

    So it is a refusal — and only when the trap can actually bite. A request that
    is pure ASCII writes fine through cp1252, and refusing it would block a
    perfectly good render on a machine that is merely unusual.
    """
    if sys.flags.utf8_mode:
        return
    try:
        preferred = locale.getpreferredencoding(False)
    except Exception:                      # noqa: BLE001 — an unreadable locale is not a verdict
        return
    if (preferred or "").lower().replace("-", "") in {"utf8", "utf_8"}:
        return
    offenders = []
    for field in ("style", "lyrics", "abc"):
        value = request.get(field)
        if isinstance(value, str) and any(ord(c) > 127 for c in value):
            offenders.append(field)
    if not offenders:
        return
    raise Refused(
        "This request has non-ASCII text in %s and this interpreter is not in UTF-8 mode "
        "(locale prefers %r), so the render would finish and then fail while writing its own "
        "receipt: yue2/storage.py:28 calls Path.write_text with ensure_ascii=False and no "
        "encoding. Start python with PYTHONUTF8=1 in the environment - it must be set BEFORE the "
        "interpreter starts, which is the only form in which it is a fix. The Node adapter sets "
        "it; a hand-run has to." % (", ".join(offenders), preferred))


def _refuse_audio_input(raw):
    """
    YuE2 has no audio-reference argument, and that is an ABSENCE, not a setting.

    SongRequest has seven fields (protocol.py:82-88). The vendor says the same
    thing in its own words in skills/yue2-music/SKILL.md: "YuE2 exposes no
    audio-reference, phoneme-alignment, or local-inpainting argument."

    Checked here as well as in the adapter because a driver is also run by hand,
    and because the expensive version of this failure is not an error — it is a
    finished song that ignored the reference, which listens like a bad model and
    is really a silently dropped argument.
    """
    suspects = [k for k in raw
                if k not in REQUEST_FIELDS
                and any(w in k.lower() for w in ("audio", "reference", "voice", "stem",
                                                 "speaker", "continuation", "melody"))]
    if raw.get("mode") == "external_audio_continuation":
        suspects.append("mode=external_audio_continuation")
    if suspects:
        raise Refused(
            "YuE2 has no audio-reference argument, so %s cannot be honoured and nothing was "
            "started. Its request has seven fields and no eighth: style, lyrics, cot, seed, abc, "
            "cfg_scale, id. A melody can be handed in as NOTATION - pass `abc` with cot "
            "\"melody\" or \"full\" and the score is retained verbatim (pipeline.py:260-264) - but "
            "a reference recording would have to be transcribed to ABC first, by something that is "
            "not this driver." % ", ".join(suspects))


def _load_request(path):
    """
    The request, from a UTF-8 JSON file rather than from argv.

    Lyrics contain newlines and, on this rig, CJK; Windows argv quoting mangles
    both and the command line has a length limit a three-verse song can reach.
    `encoding="utf-8"` is explicit for the same reason storage.py:28's absence of
    it is a trap.
    """
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict):
        raise Refused("The request file must contain one JSON object.")
    _refuse_audio_input(raw)
    unknown = sorted(set(raw) - set(REQUEST_FIELDS))
    if unknown:
        raise Refused("Unknown request fields: %s. SongRequest takes exactly %s "
                      "(protocol.py:82-88)." % (unknown, list(REQUEST_FIELDS)))
    if not str(raw.get("style") or "").strip() or not str(raw.get("lyrics") or "").strip():
        raise Refused("YuE2 needs both a style and lyrics - its own error for this is \"Provide "
                      "style and lyrics\" (pipeline.py:230). style: genre, instruments, vocal "
                      "character, language, intended tempo. lyrics: the actual words.")
    _refuse_encoding(raw)
    return {k: v for k, v in raw.items() if k in REQUEST_FIELDS and v is not None}


def _require_model(model, vae):
    for label, d in (("YuE2-3B", model), ("YuE2-Vae", vae)):
        if not os.path.isdir(d):
            raise Refused("%s is not at %s. The adapter hands these in as AIPLAY_YUE_MODEL and "
                          "AIPLAY_YUE_VAE; nothing here will download them." % (label, d))
        if not os.path.isfile(os.path.join(d, "model.safetensors")):
            raise Refused("%s at %s has no model.safetensors." % (label, d))


def _require_empty(out, overwrite):
    """
    An output folder that already holds a run is refused, not overwritten.

    The same call cli.py:122 makes ("Nonempty output %s; use --resume or a new
    output directory"), and for a better reason here: `save_artifacts` writes
    file by file, so a half-overwritten folder is a receipt describing one render
    beside the audio of another. `--overwrite` says it on purpose.
    """
    if overwrite or not os.path.isdir(out):
        return
    existing = [f for f in os.listdir(out) if f in ARTIFACTS]
    if existing:
        raise Refused("%s already holds a finished run (%s). Choose a new output directory, or "
                      "pass --overwrite to replace it - a half-overwritten folder is a receipt "
                      "for one render beside the audio of another."
                      % (out, ", ".join(sorted(existing))))


# ────────────────────────────────────────────── what actually landed on the disk

def _verify(out, receipt):
    """
    ⚠ THE RENDER IS NOT FINISHED UNTIL THE DISK SAYS SO.

    This function is the whole lesson of the 35-minute loss: `save_artifacts` is
    a method on the RESULT and a guard that looked for it on the PIPELINE was
    False, so the save never ran, and the process exited 0 with an empty
    directory. Success was reported. The audio was gone.

    Two things are required — audio.flac with a non-zero size, and result.json —
    and their absence raises OutputMissing, which is exit 3. A zero-byte flac is
    named separately from a missing one because the causes differ (an interrupted
    VAE decode leaves the first, a skipped save the second) and whoever is
    debugging needs to know which happened.
    """
    why = []
    for name in REQUIRED:
        p = os.path.join(out, name)
        if not os.path.isfile(p):
            why.append("%s was not written" % name)
        elif os.path.getsize(p) == 0:
            why.append("%s is zero bytes" % name)
    if receipt is not None and receipt.get("status") != "complete":
        why.append("result.json says status %r, not \"complete\"" % receipt.get("status"))
    if why:
        raise OutputMissing(
            "The render completed and the output directory does not show it: %s. Nothing is "
            "reported as success on the strength of a return value - save_artifacts is a method on "
            "the RESULT (pipeline.py:103), and a guard that looked for it on the pipeline once "
            "discarded a finished 35-minute render and exited 0. This exits 3." % "; ".join(why))
    return {name: os.path.getsize(os.path.join(out, name))
            for name in ARTIFACTS if os.path.isfile(os.path.join(out, name))}


def _rescue(result, out):
    """
    ONE attempt to get the audio out of memory when save_artifacts left nothing.

    A 400-second render sitting in RAM behind an unwritable directory is the same
    loss as the one above wearing a different hat, and `result.save(path)`
    (pipeline.py:94) is a single-file writer that does not touch the rest. If it
    works there is audio on the disk to recover by hand.

    ⚠ IT DOES NOT MAKE THE RUN A SUCCESS. The driver promised a reproducible run
    — receipt, tokens, latents — and a bare FLAC is not one, so the exit code
    stays 3 and the sentence says where the file is.
    """
    try:
        path = result.save(os.path.join(out, "audio.flac"))
        _event(event="rescued", path=str(path))
        return str(path)
    except Exception as exc:               # noqa: BLE001 — a failed rescue is reported, not raised
        _event(event="rescue-failed", error="%s: %s" % (type(exc).__name__, exc))
        return None


# ───────────────────────────────────────────────────────────────────── the render

def render(args):
    request = _load_request(args.request)
    model = args.model or os.environ.get("AIPLAY_YUE_MODEL") or ""
    vae = args.vae or os.environ.get("AIPLAY_YUE_VAE") or ""
    _require_model(model, vae)
    _require_empty(args.out, args.overwrite)
    os.makedirs(args.out, exist_ok=True)

    # Imported HERE, not at module scope, so --selftest and every refusal above
    # run under any python in milliseconds and touch no card. Importing torch is
    # ~6 s cold on this machine and initialises nothing until asked.
    import torch
    from torch.nn.attention import SDPBackend, sdpa_kernel
    from yue2.pipeline import YuE2Pipeline

    def vram():
        """Free/total in GiB, or None on a machine with no CUDA device. `None`
        means NO READING, never zero — the same rule the adapter's gate uses."""
        try:
            free, total = torch.cuda.mem_get_info()
            return {"freeGib": round(free / 2 ** 30, 2), "totalGib": round(total / 2 ** 30, 2)}
        except Exception:                  # noqa: BLE001
            return None

    # ⚠ REFUSE FP8 ON AN INELIGIBLE CARD HERE, NOT WHERE THE LIBRARY DOES.
    # quantization.py:73-75 raises from prepare_fp8_ar, which takes the loaded
    # model — so the library's own check happens AFTER 6.76 GiB of weights have
    # come off the disk and onto the card, and the user pays a minute and a half
    # to be told their card cannot do this. torch is imported by now, so the
    # capability is free to read, and the refusal costs nothing.
    if args.quantization == "fp8":
        cap = torch.cuda.get_device_capability() if torch.cuda.is_available() else None
        if cap is None:
            raise Refused("--quantization fp8 needs a CUDA device and there is none. "
                          "Use --quantization none.")
        if cap < (8, 9):
            raise Refused(
                "--quantization fp8 needs compute capability 8.9 or newer and this card is "
                "%d.%d, so the 8-bit kernels do not exist on it. That is an RTX 40-series "
                "floor. Use --quantization none - and note that --offload-ar has no such "
                "requirement and frees more memory (4.0344 GiB against 1.3125)."
                % (cap[0], cap[1]))

    _event(event="starting", model=model, vae=vae, backend=args.backend,
           budgetGib=args.budget_gib, vaeCoreFrames=args.vae_core_frames,
           quantization=args.quantization, offloadAr=args.offload_ar, vram=vram())

    t0 = time.perf_counter()
    # ⚠ THE ONE COMBINATION THE CLI CANNOT EXPRESS, and the reason this file is
    # not a command line: a HIGH memory cap together with SMALL VAE tiles.
    #   memory_budget_gib=16 -> pipeline.py:162 caps torch at min(14, total-2)
    #                           = 13.99 GiB on this card, instead of the 10.00
    #                           GiB that `--budget 12` imposes and OOMs under.
    #   vae_core_frames=512  -> the tile size cli.py:36 only grants at budget<=12.
    # backend="torch-eager" skips CUDA-graph capture, which the measured run used
    # ("execution": "eager"). local_files_only=True so a missing file is an error
    # here and never a silent 7 GB download.
    pipe = YuE2Pipeline.from_pretrained(
        model,
        vae=vae,
        device="auto",
        memory_budget_gib=args.budget_gib,
        vae_core_frames=args.vae_core_frames,
        # Both are pipeline.py:122-124 constructor keywords, defaulting to
        # "none"/False there, so passing the defaults changes nothing.
        quantization=args.quantization,
        offload_ar=args.offload_ar,
        backend=args.backend,
        local_files_only=True,
        progress=True,
    )
    load_seconds = time.perf_counter() - t0
    _event(event="loaded", seconds=round(load_seconds, 2), vram=vram())

    kwargs = {k: v for k, v in request.items() if k not in ("style", "lyrics")}
    t1 = time.perf_counter()
    try:
        # ⚠ FLASH IS OMITTED, NOT DISABLED. torch's Windows wheels advertise it
        # through the ATen schema and then raise, and sampling.py:89 opens a
        # `try` whose only handler is a `finally` (:151), with no `except`, so there is no fallback to fall back to.
        # EFFICIENT_ATTENTION first, MATH as the floor; torch picks the cheapest
        # one that exists on this build.
        with sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]):
            # ⚠ FIELDS, NOT A REQUEST OBJECT. __call__ builds the SongRequest
            # itself (pipeline.py:378-380 -> _request at :225-231); a SongRequest
            # in the style slot raises "Provide style and lyrics".
            result = pipe(style=request["style"], lyrics=request["lyrics"], **kwargs)
        generate_seconds = time.perf_counter() - t1
        _event(event="generated", seconds=round(generate_seconds, 2), vram=vram())

        # ⚠ ON THE RESULT. NOT ON THE PIPELINE. NOT BEHIND A hasattr.
        # pipeline.py:103; cli.py:132 calls exactly this.
        _event(event="saving", dir=args.out)
        receipt = result.save_artifacts(args.out)
        try:
            sizes = _verify(args.out, receipt)
        except OutputMissing:
            rescued = _rescue(result, args.out)
            raise OutputMissing(
                "save_artifacts() returned and the required files are not on the disk. "
                + ("The audio was written to %s by a direct result.save() so the render is "
                   "recoverable by hand, but this run produced no receipt, no tokens and no "
                   "latents, so it is not a reproducible run and exits 3." % rescued
                   if rescued else
                   "A direct result.save() could not write the audio either - the directory is "
                   "unwritable or the drive is full. The render is lost; this exits 3."))
    finally:
        # Always, even on a raise: the weights are ~7.8 GB of card and the next
        # thing the owner does is probably a video render.
        pipe.close()

    answer = {
        "ok": True,
        "out": args.out,
        "audio": os.path.join(args.out, "audio.flac"),
        "artifacts": sizes,
        "identity": receipt.get("identity"),
        "truncated": receipt.get("truncated"),
        "audioSeconds": receipt.get("audio_seconds"),
        "sampleRate": receipt.get("sample_rate"),
        "weights": receipt.get("weights"),
        "timing": receipt.get("timing"),
        "config": receipt.get("config") if isinstance(receipt.get("config"), dict) else None,
        "driver": {
            "loadSeconds": round(load_seconds, 3),
            "generateSeconds": round(generate_seconds, 3),
            "budgetGib": args.budget_gib,
            "vaeCoreFrames": args.vae_core_frames,
            # In the receipt because a song rendered with fp8 AR linears was made
            # by different arithmetic than one rendered without, and the ledger
            # has to be able to say which. The vendor validates neither the
            # quality nor the speed of that path, so an unrecorded run of it
            # would be an unanswerable question later.
            "quantization": args.quantization,
            "offloadAr": args.offload_ar,
            "backend": args.backend,
            "sdpaBackends": ["EFFICIENT_ATTENTION", "MATH"],
        },
        # The receipt itself, whole, because it is the thing that makes the run
        # reproducible and re-reading it from disk on the Node side would be a
        # second opinion about the same file.
        "receipt": receipt,
    }
    _event(event="verified", audioSeconds=receipt.get("audio_seconds"),
           bytes=sizes.get("audio.flac"))
    _say(answer)
    return 0


# ────────────────────────────────────────────────────────────────── the selftest

def selftest(mode):
    """
    Prove the argument surface, the marker, the exit codes and the REAL progress
    line shapes without importing torch, touching a card or loading a weight.

    This is what `server/music/yue_test.js` drives, and the reason it exists is
    written in that file's header: the mesh suite promises "every check here is
    free" and therefore never drives its own subprocess door at all, leaving its
    timeout, tree-kill and exit-code branches untested. Those are the paths that
    cost this strand a night.

      ok              a plausible result line, exit 0
      refuse          exit 2 with a reason on stderr
      missing-output  the 35-minute loss, reproduced: claim a finished render
                      over an empty directory and exit 3 rather than 0
      progress        emit the three real progress shapes by driving the
                      VENDOR'S OWN writer — yue2/progress.py is stdlib-only and
                      yue2/__init__.py is lazy, so this imports no torch
    """
    if mode == "refuse":
        raise Refused("selftest: this is what a refusal looks like. Exit 2, one sentence, "
                      "nothing spent.")
    if mode == "missing-output":
        _event(event="saving", dir="(selftest)")
        raise OutputMissing(
            "selftest: the render 'completed' and wrote nothing. This is the failure that "
            "exited 0 for real once and lost 35 minutes of finished audio; here it exits 3.")
    if mode == "progress":
        from yue2.progress import Progress
        p = Progress(enabled=True, stream=sys.stderr)
        with p.stage("Loading model"):            # shape 1: no unit, no total, no " | "
            pass
        s = p.stage("Generating song", unit="tokens")   # shape 2: an amount and a rate
        s.__enter__()
        s.advance(4177)
        s.finish("completed")
        s = p.stage("Synthesizing audio", unit="steps")
        s.__enter__()
        s.update(7, total=32)                     # shape 2 with a runtime-discovered total
        s.finish("completed")
        p.close()
        # shape 3: the summary, which has NO label before the colon
        Progress(enabled=True, stream=sys.stderr).complete(167.0, 399.6)
    _say({"ok": True, "selftest": mode,
          "note": "no model was loaded and no card was touched; this proves the marker, the "
                  "exit code and the progress shapes only"})
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="AIPLAY Studio YuE2 driver (style + lyrics to a song).")
    ap.add_argument("--request", help="a UTF-8 JSON object with style, lyrics and any of "
                                      "cot, seed, abc, cfg_scale, id")
    ap.add_argument("--out", help="directory for audio.flac, result.json and the run's artifacts")
    ap.add_argument("--model", default=None, help="the YuE2-3B folder (else AIPLAY_YUE_MODEL)")
    ap.add_argument("--vae", default=None, help="the YuE2-Vae folder (else AIPLAY_YUE_VAE)")
    # 16, not 12. See the header: --budget 12 caps torch at 10.00 GiB and OOMs at
    # nar.py:95 with 7.04 GiB free. MEASURED.
    ap.add_argument("--budget-gib", type=int, default=16,
                    help="memory_budget_gib. pipeline.py:162 turns it into a per-process cap of "
                         "min(budget-2, total-2) GiB; 16 gives 13.99 on a 15.99 GiB card")
    # 512, not 1024, and independently of the budget. This is the pairing the CLI
    # cannot express.
    ap.add_argument("--vae-core-frames", type=int, default=512,
                    help="VAE tile size. cli.py:36 only grants 512 when budget<=12; this passes "
                         "it alongside a high budget")
    ap.add_argument("--backend", default="torch-eager", choices=["torch", "torch-eager", "vllm"],
                    help="the measured run used torch-eager (\"execution\": \"eager\")")
    # THE TWO MEMORY LEVERS, and they are not interchangeable: each one lowers a
    # DIFFERENT stage's peak, which is why the configuration ladder on the Node
    # side (server/music/yue_fit.js) adds their savings instead of choosing
    # between them.
    #
    #   --quantization fp8   lowers the PLANNING and SEMANTIC peak. Replaces the
    #       196 AR projection/MLP linears with E4M3 (quantization.py's own
    #       AR_LINEAR regex): 2.6250 GiB of BF16 becomes 1.3125, so it saves
    #       1.3125 GiB. MEASURED by summing the safetensors header over exactly
    #       those names. The originals stay in CPU memory for exact restore, so
    #       this costs system RAM, not VRAM.
    #   --offload-ar         lowers the SYNTHESIS peak, which is the one that
    #       grows with song length. Moves the 310 tensors nar.py:208-210 names
    #       to the host during synthesis: 4.0344 GiB, 59.7% of the weights,
    #       leaving the 318 `nar_*` tensors on the card. MEASURED the same way.
    ap.add_argument("--quantization", default="none", choices=["none", "fp8"],
                    help="fp8 quantizes only the AR linears and needs compute capability "
                         ">=8.9; NAR always restores exact BF16 (quantization.py)")
    ap.add_argument("--offload-ar", action="store_true",
                    help="move the AR half to system memory during synthesis. Slower — it "
                         "crosses PCIe once per chunk — and frees 4.0344 GiB where length costs")
    ap.add_argument("--overwrite", action="store_true",
                    help="replace a finished run in --out instead of refusing it")
    ap.add_argument("--selftest", nargs="?", const="ok",
                    choices=["ok", "refuse", "missing-output", "progress"],
                    help="prove this file's contract without torch, a card or any weights")
    a = ap.parse_args(argv)

    try:
        if a.selftest:
            return selftest(a.selftest)
        if not a.request or not a.out:
            raise Refused("Rendering a song needs --request and --out.")
        return render(a)
    except Refused as e:
        sys.stderr.write("REFUSED: %s\n" % e)
        return 2
    except OutputMissing as e:
        # ⚠ NOT EXIT 0. The whole point of this class.
        sys.stderr.write("OUTPUT MISSING: %s\n" % e)
        return 3
    except BaseException:                  # noqa: BLE001 — the traceback IS the answer
        import traceback
        traceback.print_exc()
        return 3


if __name__ == "__main__":
    sys.exit(main())
