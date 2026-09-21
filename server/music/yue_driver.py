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

# Semantic tokens per second of audio. MEASURED on run 019860f4 (2026-09-17):
# 3520 tokens for 140.799 s; latent frames equal tokens, and the VAE writes
# 1920 samples per frame at 48 kHz, so the ratio is exact, not approximate.
TOKENS_PER_SECOND = 25


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
    # The style must say something; the lyrics must be a STRING, and "" is one.
    # The vendor's own check is `is None` (pipeline.py:230), and an instrumental
    # is exactly empty lyrics with a style that says "no vocals" — the only
    # instrumental control the model has. The first version of this line
    # refused "" too, and the first instrumental through Create died here in
    # 30 s (2026-09-11 22:46). The Node door decides who may send "" (its
    # allowEmptyLyrics); this end only refuses what the vendor would.
    if not str(raw.get("style") or "").strip() or not isinstance(raw.get("lyrics"), str):
        raise Refused("YuE2 needs a style and a lyrics string - its own error for this is \"Provide "
                      "style and lyrics\" (pipeline.py:230). style: genre, instruments, vocal "
                      "character, language, intended tempo. lyrics: the actual words, or an "
                      "empty string for an instrumental whose style says so.")
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

def _extend(pipe, args, request, semantic_sampling, effective, vram):
    """
    CONTINUE A FINISHED TAKE - the MiniMax move, without a package patch.

    MiniMax replays a saved trajectory into the KV cache and lets the sampler
    carry on. Here generate_tokens() takes a flat token list as its prefix and
    never inspects it (sampling.py:57-82), so the plan's prefix followed by the
    take's own semantic tokens, offset back into the codec range, IS the replay.
    The NAR then re-solves the whole sequence: it starts every frame from noise
    and has no latent inpainting (nar.py:180), so the kept part comes back as a
    different waveform. The Node side keeps the original audio up to the seam
    and splices the new render on after it, as it does for MiniMax.

    What the model sees: the take's OWN score (or a longer one handed in) and
    the old words followed by the new ones. Once new words are added the
    replayed tokens sit under text the model did not generate them from - the
    same off-distribution step MiniMax's route documents, and the caller's
    choice. With nothing new the sampler still owes min_tokens (200, ~8 s).

    --extend-codes IS THE SAME REPLAY FROM A RECORDING. A folder holding only
    semantic.npy - codes the real-audio tokenizer read off any track
    (yue_tokenize.py) - with no plan, no receipt and no prefix of its own: the
    request's own words and style make the prefix (cot off unless a score is
    handed in), the codes follow, and the sampler carries on. The codes are
    the tokenizer's reading of the track, not the model's own, so the kept
    part comes back as YuE2's rendering of that reading; the Node side keeps
    the original audio up to the seam, as it does for a take.
    """
    import numpy as np
    from yue2.pipeline import SymbolicPlan, SemanticResult, SongResult
    from yue2.protocol import SongRequest, CODEC_OFFSET, CODEC_SIZE, CONTEXT, resolve_sampling, negative_prefix
    from yue2.storage import identity

    codes_only = bool(getattr(args, "extend_codes", None))
    old_dir = args.extend_codes if codes_only else args.extend_from
    needed = ("semantic.npy",) if codes_only else ("result.json", "semantic.npy", "plan.json", "plan_manifest.json", "prefix.npy")
    for name in needed:
        if not os.path.isfile(os.path.join(old_dir, name)):
            if codes_only:
                raise Refused("--extend-codes %s has no semantic.npy; the tokenizer writes one there." % old_dir)
            raise Refused("--extend-from %s has no %s; only a finished run folder (result.json, "
                          "semantic.npy, plan.json, plan_manifest.json, prefix.npy) can be continued."
                          % (old_dir, name))
    if codes_only:
        old_receipt, old_plan = {}, None
    else:
        with open(os.path.join(old_dir, "result.json"), encoding="utf-8") as fh:
            old_receipt = json.load(fh)
        old_plan = SymbolicPlan.load(old_dir)      # hash-checked against plan_manifest.json
    tokens = np.load(os.path.join(old_dir, "semantic.npy"), allow_pickle=False)
    if tokens.ndim != 1 or tokens.dtype.kind not in "iu":
        raise Refused("%s/semantic.npy is not a 1-D integer array." % old_dir)
    total = int(tokens.shape[0])
    keep = total if args.from_seconds <= 0 else min(total, max(1, int(round(args.from_seconds * TOKENS_PER_SECOND))))
    old = [int(t) for t in tokens[:keep].tolist()]
    if any(t < 0 or t >= CODEC_SIZE for t in old):
        raise Refused("%s/semantic.npy holds values outside the codec range." % old_dir)

    fields = dict(old_plan.request.to_dict()) if old_plan else {}
    fields.update(request)                         # the new request's fields win: lyrics, abc, style, seed, cfg_scale, cot
    if old_plan and fields.get("abc") is None and old_plan.abc is not None and fields.get("cot") != "off":
        fields["abc"] = old_plan.abc               # the take's own score, unless a longer one came in
    if codes_only and fields.get("abc") is None:
        fields["cot"] = "off"                      # a recording has no score of its own to plan under
    new_request = SongRequest(**fields)
    plan = pipe.plan(request=new_request)          # a supplied score is tokenised, never planned
    prefix = list(plan.prefix) + [t + CODEC_OFFSET for t in old]
    room = int(CONTEXT) - len(prefix) - 8
    if room < 1:
        raise Refused("The prefix (%d tokens) plus the kept take (%d tokens) leaves no room in the "
                      "%d-token context; keep less of it with --from-seconds."
                      % (len(plan.prefix), keep, int(CONTEXT)))
    asked = int((semantic_sampling or {}).get("max_tokens", 9000))
    sampling = resolve_sampling({"max_tokens": max(1, min(asked, room))}, pipe.generation_config.semantic)
    effective["maxTokens"] = int(sampling.max_tokens)
    effective["prefixTokens"] = len(prefix)
    negative = None
    if new_request.guidance != 1:
        negative = list(negative_prefix(new_request, pipe.tokenizer, plan.abc_ids)) + [t + CODEC_OFFSET for t in old]
    _event(event="extending", fromDir=old_dir, fromSeconds=args.from_seconds, keptTokens=keep,
           ofTokens=total, prefixTokens=len(prefix), maxTokens=int(sampling.max_tokens), vram=vram())
    t0 = time.perf_counter()
    ids, timing, truncated = pipe._generate(prefix, sampling, new_request.seed, "semantic",
                                            negative=negative, cfg_scale=new_request.guidance,
                                            legacy_off=new_request.cot == "off")
    codec = old + [int(t) - CODEC_OFFSET for t in ids]
    semantic = SemanticResult(plan, codec, timing, truncated)
    _event(event="extended", keptTokens=keep, newTokens=len(ids), totalTokens=len(codec), vram=vram())
    nar_start = time.perf_counter()
    latents = pipe.synthesize(semantic)
    nar_seconds = time.perf_counter() - nar_start
    vae_start = time.perf_counter()
    audio = pipe.decode(latents)
    timing_all = {"abc": plan.timing, "semantic": timing, "nar_seconds": nar_seconds,
                  "vae_seconds": time.perf_counter() - vae_start, "load": dict(pipe.load_timing),
                  "e2e_seconds": time.perf_counter() - t0}
    config = pipe.effective_config(new_request, None, {"max_tokens": int(sampling.max_tokens)})
    extended = {"from": old_dir, "fromIdentity": old_receipt.get("identity"), "fromSeconds": args.from_seconds,
                "keptTokens": keep, "ofTokens": total, "newTokens": len(ids), "totalTokens": len(codec),
                "tokensPerSecond": TOKENS_PER_SECOND, "codesOnly": codes_only}
    request_id = identity({"request": new_request.to_dict(), "config": config, "weights": pipe.weights,
                           "extended": {"fromIdentity": extended["fromIdentity"], "keptTokens": keep}})
    return SongResult(audio, 48000, semantic, latents, config, pipe.weights, timing_all, request_id), extended


def render(args):
    request = _load_request(args.request)
    prepared_replay = None
    if args.replay_manifest:
        if args.extend_from or args.extend_codes or args.abc_open or args.sampling or args.plan_sampling:
            raise Refused("Artifact replay cannot be combined with continuation, an open score or sampler overrides.")
        if args.quantization != "none":
            raise Refused("This reviewed artifact adapter uses unquantized Python YuE2 only.")
        from yue_replay import validate_manifest
        try:
            prepared_replay = validate_manifest(args.replay_manifest, args.replay_sha256,
                                                args.replay_source, args.replay_stage)
        except (ValueError, OSError, KeyError) as error:
            raise Refused(str(error)) from error
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

    if args.query_chunk < 0:
        raise Refused("--query-chunk must be 0 (the package default) or a positive block size.")
    import yue2.nar as nar
    if args.query_chunk:
        # pipeline.synthesize() does `from .nar import synthesize` AT CALL TIME
        # (pipeline.py:287), so replacing the module attribute is the whole
        # injection — nothing in the package binds the function earlier. The
        # option itself is the package's (nar.py:229 `query_chunk_size=None`);
        # only the plumbing to reach it is ours.
        _synthesize = nar.synthesize

        def synthesize_chunked(*a, **kw):
            kw.setdefault("query_chunk_size", args.query_chunk)
            return _synthesize(*a, **kw)
        nar.synthesize = synthesize_chunked

    # The prefill's peak, read WHERE IT HAPPENS: CachedNAR's constructor is the
    # prefill (nar.py:127 `self._prefill()`), and it is the allocation the
    # 194 s render died in. Recorded per chunk so the receipt can say what the
    # stage cost at this length in this configuration, instead of the ledger
    # holding only "free memory at load" and "free memory after" — which is what
    # it held tonight, and what made the OOM a surprise.
    prefill = {}
    _cached_nar_init = nar.CachedNAR.__init__

    def cached_nar_init_measured(self, *a, **kw):
        cuda = torch.cuda.is_available()
        if cuda:
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
        _cached_nar_init(self, *a, **kw)
        if cuda:
            torch.cuda.synchronize()
            peak = torch.cuda.max_memory_allocated() / 2 ** 30
            prefill["peakGib"] = round(max(prefill.get("peakGib", 0.0), peak), 3)
            prefill["tokens"] = max(prefill.get("tokens", 0), int(self.ar_length))
            prefill["chunks"] = prefill.get("chunks", 0) + 1
            _event(event="prefilled", tokens=int(self.ar_length), peakGib=round(peak, 3),
                   queryChunk=args.query_chunk, vram=vram())
    nar.CachedNAR.__init__ = cached_nar_init_measured

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
           quantization=args.quantization, offloadAr=args.offload_ar,
           queryChunk=args.query_chunk, vram=vram())

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

    # ── THE TWO PER-SONG OVERRIDES __call__ CANNOT TAKE BY NAME ─────────────
    # Both are the package's own knobs; only the plumbing is ours, and both are
    # recorded in the receipt because they change what the model computed.
    effective = {"narSteps": 32, "maxTokens": None, "prefixTokens": None}
    # 1. The NAR solver's step count lives on the pipeline's GenerationConfig
    #    (protocol.py:48 ode_steps=32; synthesize() reads it at pipeline.py:301).
    #    A frozen dataclass, so replaced rather than assigned into. MEASURED
    #    2026-09-11 on one fixed score and seed: 16 steps correlates 0.9991
    #    with 32, residual -27.6 dB, every octave band within 0.01 dB.
    if args.nar_steps != 32:
        import dataclasses
        pipe.generation_config = dataclasses.replace(pipe.generation_config, ode_steps=int(args.nar_steps))
        effective["narSteps"] = int(args.nar_steps)
    # 2. The sampler's stop. protocol.py's Sampling takes any max_tokens >= 1;
    #    sampling.py:62 refuses `len(prefix) + max_tokens > CONTEXT` (24576).
    #    The prefix is only known once the plan exists, so the clamp is applied
    #    where the plan arrives: generate_semantic() is wrapped, the dict of
    #    overrides __call__ hands it is clamped to the room the prefix leaves,
    #    and the vendor's own resolve_sampling() (protocol.py:70) turns the
    #    dict into a Sampling. The receipt's `overrides` carries what was ASKED;
    #    the driver block below carries what RAN.
    semantic_sampling = None
    if args.max_tokens:
        from yue2.protocol import CONTEXT
        semantic_sampling = {"max_tokens": int(args.max_tokens)}
        _generate_semantic = pipe.generate_semantic

        def generate_semantic_clamped(plan, *, sampling=None, **kw):
            room = int(CONTEXT) - len(plan.prefix) - 8
            s = dict(sampling or {})
            asked = int(s.get("max_tokens", 9000))
            s["max_tokens"] = max(1, min(asked, room))
            effective["maxTokens"] = s["max_tokens"]
            effective["prefixTokens"] = len(plan.prefix)
            _event(event="max-tokens", asked=asked, ran=s["max_tokens"],
                   prefixTokens=len(plan.prefix), context=int(CONTEXT), vram=vram())
            return _generate_semantic(plan, sampling=s, **kw)
        pipe.generate_semantic = generate_semantic_clamped

    # ── THE OPEN SCORE, the hum-to-song recipe ────────────────────────────
    # A supplied ABC is normally CLOSED: [ABC_START] score [ABC_END, MUSIC_START],
    # and the model sings exactly it. --abc-open leaves it open — [ABC_START]
    # score, no end — and runs the planner from there, so the bars a person
    # hummed become the opening the model continues rather than the whole song.
    # The plan handed back carries the FULL score (seed + continuation), so
    # everything downstream — generate_semantic()'s prefix check, the saved
    # score.abc — sees an ordinary planned score. Refused with cot off, where
    # the planner never runs.
    if args.abc_open:
        if request.get("cot", "full") == "off" or not str(request.get("abc") or "").strip():
            raise Refused("--abc-open needs a supplied abc and cot full or melody: the score is left open "
                          "for the planner to continue, and with cot off nothing plans.")
        import dataclasses as _dc
        from yue2.pipeline import SymbolicPlan
        from yue2.protocol import EOD, ABC_START, token_prefixes, resolve_sampling as _resolve
        _plan = pipe.plan

        def plan_open(style=None, lyrics=None, *, tags=None, request=None, abc_sampling=None,
                      cancelled=None, on_token=None, **kw):
            req = request or pipe._request(style, lyrics, tags=tags, **kw)
            if req.cot == "off" or not req.abc:
                return _plan(request=req, abc_sampling=abc_sampling, cancelled=cancelled, on_token=on_token)
            seed_ids = list(pipe.tokenizer.encode(req.abc))
            open_prefix = [EOD] + pipe.tokenizer.encode(req.text()) + [ABC_START] + seed_ids
            sampling = _resolve(abc_sampling, pipe.generation_config.abc)
            ids, timing, truncated = pipe._generate(open_prefix, sampling, req.seed, "abc",
                                                    cancelled=cancelled, on_token=on_token)
            full = seed_ids + [int(t) for t in ids]
            opened = _dc.replace(req, abc=None)   # the plan's request carries no score; its prefix is rebuilt from the ids
            _event(event="score-continued", seedTokens=len(seed_ids), continuedTokens=len(ids),
                   truncated=bool(truncated), vram=vram())
            return SymbolicPlan(opened, pipe.tokenizer.decode(full), full,
                                token_prefixes(opened, pipe.tokenizer, full), timing, truncated)
        pipe.plan = plan_open

    # ── THE SAMPLER'S OWN DIALS ───────────────────────────────────────────
    # protocol.py's Sampling: temperature, top_p, top_k, repetition_penalty for
    # the semantic pass (the performance) and, separately, for the "abc" pass
    # (the plan). Both arrive as JSON objects and are handed to __call__ as the
    # per-song overrides it already takes; resolve_sampling() merges them over
    # the vendor's defaults and Sampling.__post_init__ refuses anything out of
    # range with its own sentence. Unknown keys are refused here, by name.
    ALLOWED_DIALS = ("temperature", "top_p", "top_k", "repetition_penalty", "penalty_window", "min_tokens")
    def _dials(raw, label):
        if not raw:
            return {}
        try:
            d = json.loads(raw)
        except ValueError:
            raise Refused("--%s must be a JSON object." % label)
        if not isinstance(d, dict):
            raise Refused("--%s must be a JSON object." % label)
        unknown = sorted(set(d) - set(ALLOWED_DIALS))
        if unknown:
            raise Refused("--%s: unknown keys %s; Sampling takes %s (protocol.py:22)." % (label, unknown, list(ALLOWED_DIALS)))
        return {k: (int(v) if k in ("top_k", "penalty_window", "min_tokens") else float(v)) for k, v in d.items()}
    perf = _dials(args.sampling, "sampling")
    plan_dials = _dials(args.plan_sampling, "plan-sampling")
    if perf:
        semantic_sampling = {**(semantic_sampling or {}), **perf}
        effective["performance"] = perf
    if plan_dials:
        effective["plan"] = plan_dials

    kwargs = {k: v for k, v in request.items() if k not in ("style", "lyrics")}
    if semantic_sampling:
        kwargs["semantic_sampling"] = semantic_sampling
    if plan_dials:
        kwargs["abc_sampling"] = plan_dials
    t1 = time.perf_counter()
    try:
        # ⚠ FLASH IS OMITTED, NOT DISABLED. torch's Windows wheels advertise it
        # through the ATen schema and then raise, and sampling.py:89 opens a
        # `try` whose only handler is a `finally` (:151), with no `except`, so there is no fallback to fall back to.
        # EFFICIENT_ATTENTION first, MATH as the floor; torch picks the cheapest
        # one that exists on this build.
        with sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]):
            extended = None
            replayed = None
            if prepared_replay is not None:
                from yue_replay import replay
                result, replayed = replay(pipe, prepared_replay, request)
            elif args.extend_from or getattr(args, "extend_codes", None):
                result, extended = _extend(pipe, args, request, semantic_sampling, effective, vram)
            else:
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
            # 0 is the package default (whole-sequence attention); anything else
            # is a block size that changes the peak, not the arithmetic. The
            # measured prefill peak sits beside it so a receipt answers "what did
            # this length cost at this setting" without a second experiment.
            "queryChunk": args.query_chunk,
            "prefillPeakGib": prefill.get("peakGib"),
            "prefillTokens": prefill.get("tokens"),
            "prefillChunks": prefill.get("chunks"),
            # What RAN, beside what was asked: the solver's step count, and the
            # sampler stop after the clamp to the room the prefix left (None
            # when the vendor's default stop was used). A song longer than
            # 360 s exists only because of these two lines.
            "narSteps": effective["narSteps"],
            "maxTokensAsked": int(args.max_tokens) or None,
            "maxTokens": effective["maxTokens"],
            "prefixTokens": effective["prefixTokens"],
            "backend": args.backend,
            "sdpaBackends": ["EFFICIENT_ATTENTION", "MATH"],
            # A continuation: where it came from and how much of it was kept.
            "extended": extended,
            "artifactReplay": replayed,
            # The score was left open for the planner (the hum-to-song recipe).
            "abcOpen": bool(args.abc_open),
            # The sampler dials that were asked for, if any (None = the vendor's).
            "performance": effective.get("performance"),
            "plan": effective.get("plan"),
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
    # THE THIRD LEVER, and the one that moves the duration ceiling. nar.py:70
    # sizes the attention block as THE WHOLE SEQUENCE on CUDA (`block =
    # query_chunk_size or len(q)`), so the temp one prefill layer allocates
    # grows as tokens², and that — not the 114,688-bytes-per-token K/V cache —
    # is the term that hit the 13.99 GiB cap. MEASURED 2026-09-11 through
    # nar.attention() itself on this 16 GiB card (scratchpad/sdpa_probe.py):
    #
    #   tokens  seconds   whole-sequence    512-block
    #    4200     168        2.66 GiB        0.41 GiB     (the renders that fit)
    #    4900     194        3.58 GiB        0.46 GiB     (the OOM: 764 MiB short)
    #    6700     267        6.60 GiB        0.67 GiB
    #    9000     360       11.79 GiB        0.87 GiB     (the sampler's own cap)
    #
    # and the 512-block call is FASTER (30 ms against 370 at 4200 tokens). The
    # option is the package's own — synthesize() takes query_chunk_size and
    # threads it to every attention call — but pipeline.py:300 never passes it,
    # so it is injected below. 0 keeps the package default.
    ap.add_argument("--query-chunk", type=int, default=0,
                    help="attention query block for the NAR prefill and solve (nar.py:70). "
                         "0 = the package default of the whole sequence, whose temp grows as "
                         "tokens^2 and OOMs above ~170 s on 16 GiB; 512 held every length up "
                         "to the 360 s cap under 0.9 GiB")
    # TWO PER-SONG CHOICES, both the package's own knobs reached through the
    # pipeline object rather than the CLI (which exposes neither).
    #   --nar-steps    protocol.py:48 ode_steps, the flow-matching solver's step
    #       count; 32 is the vendor's. MEASURED 2026-09-11 (scratchpad
    #       narab_verdict.py, one fixed score and seed, sample-aligned): 16 steps
    #       correlates 0.9991 with 32, residual -27.6 dB relative to programme,
    #       every octave band within 0.01 dB; 8 steps 0.980 / -14.0 dB. So 16 is
    #       the same render for half the synthesis time and 8 is not.
    #   --max-tokens   the semantic sampler's stop (protocol.py:29, 9000 = 360 s
    #       at 25 tokens a second). sampling.py:62 refuses prefix + max_tokens
    #       past the 24576 context, so render() clamps to the room the plan's
    #       prefix leaves and records both numbers. A longer song than the
    #       vendor's default is an ATTEMPT: unvalidated by them, measured here
    #       as it lands.
    ap.add_argument("--nar-steps", type=int, default=32,
                    help="NAR solver steps (protocol.py:48). 32 = the vendor's; 16 measured "
                         "identical (corr 0.9991, -27.6 dB residual); 8 is not (0.980, -14 dB)")
    ap.add_argument("--max-tokens", type=int, default=0,
                    help="semantic sampler stop in tokens, 25 per second of audio; 0 = the "
                         "vendor's 9000 (360 s). Clamped to 24576 - prefix at run time")
    ap.add_argument("--sampling", default="",
                    help="JSON: the performance sampler's dials (temperature, top_p, top_k, "
                         "repetition_penalty, penalty_window, min_tokens), merged over the vendor's defaults")
    ap.add_argument("--plan-sampling", default="",
                    help="JSON: the same dials for the score planner (the abc pass)")
    ap.add_argument("--abc-open", action="store_true",
                    help="with a supplied abc and cot full/melody: leave the score OPEN so the planner "
                         "continues it (the hum-to-song recipe); score.abc then holds the seed and the "
                         "continuation")
    ap.add_argument("--extend-from", default=None,
                    help="a finished run folder (result.json, prefix.npy, semantic.npy, plan.json) "
                         "whose performance this run continues: its semantic tokens are replayed "
                         "behind the request's words and the sampler carries on")
    ap.add_argument("--from-seconds", type=float, default=0.0,
                    help="with --extend-from: keep the take up to here (25 semantic tokens per "
                         "second) and generate from there; 0 keeps the whole take")
    ap.add_argument("--extend-codes", default=None,
                    help="a folder holding semantic.npy read off a recording by the real-audio "
                         "tokenizer (yue_tokenize.py): replayed like a take's own tokens, with no "
                         "plan and no receipt; cot is off unless an abc is supplied")
    ap.add_argument("--replay-manifest", default=None, help="Verified, frozen Studio artifact replay manifest")
    ap.add_argument("--replay-sha256", default=None)
    ap.add_argument("--replay-source", default=None)
    ap.add_argument("--replay-stage", choices=["plan", "semantic", "latent"], default=None)
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
