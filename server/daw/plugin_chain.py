# -*- coding: utf-8 -*-
"""Isolated VST3 insert processing for the DAW's offline rack.

The project supplies an opaque registered ID, fingerprint, saved base state and
static controls. Executable paths come only from the private host environment.
Each call starts a new worker and processes the absolute-zero stereo buffer;
no plugin state survives into the next region. The host returns the same shape.
Tails are rendered inside the project window: extend its bars to hear a final
reverb or delay after the last clip.
"""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile

import numpy as np

WORKER = Path(__file__).with_name("plugin_worker.py")
MAX_STATE_CHARS = ((4 * 1024 * 1024 + 2) // 3) * 4
MAX_LOG_BYTES = 64 * 1024
MAX_FRAMES = 48000 * 60 * 60


def _log_tail(file):
    with open(file, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - MAX_LOG_BYTES))
        return handle.read(MAX_LOG_BYTES).decode("utf-8", errors="replace")


def run_vst3(audio, insert, ctx, *, timeout=None):
    """Run an enabled effect, fail by name rather than substitute dry audio."""
    descriptor = insert.get("plugin")
    if not isinstance(descriptor, dict):
        raise ValueError("VST3 effect has no saved plugin descriptor")
    label = str(descriptor.get("label") or descriptor.get("id") or "effect")[:160]
    prefix = "VST3 " + label
    identity, fingerprint = descriptor.get("id"), descriptor.get("fingerprint")
    if (not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", identity)
            or not isinstance(fingerprint, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", fingerprint)):
        raise ValueError(prefix + ": invalid registered identity")
    state, params = descriptor.get("state"), insert.get("params", {})
    if not isinstance(state, str) or len(state) > MAX_STATE_CHARS or not isinstance(params, dict):
        raise ValueError(prefix + ": invalid saved state or parameters")
    registry = os.environ.get("AIPLAY_DAW_PLUGIN_REGISTRY")
    python = os.environ.get("AIPLAY_VST_PYTHON")
    if not registry or not python:
        raise ValueError(prefix + ": plugin host is unavailable; bypass the insert or set up the VST3 host")
    if not Path(registry).is_file() or not Path(python).is_file() or not WORKER.is_file():
        raise ValueError(prefix + ": plugin host or private registry is unavailable; bypass the insert to continue")
    sr = ctx.get("sr")
    if not isinstance(sr, (int, float)) or isinstance(sr, bool) or not math.isfinite(sr) or not 8000 <= sr <= 192000:
        raise ValueError(prefix + ": invalid sample rate")
    source = np.asarray(audio)
    if source.ndim != 2 or source.shape[0] != 2 or source.shape[1] > MAX_FRAMES or not np.all(np.isfinite(source)):
        raise ValueError(prefix + ": input must be bounded finite stereo audio")
    with np.errstate(over="ignore", invalid="ignore"):
        source = np.ascontiguousarray(source, dtype=np.float32)
    if not np.all(np.isfinite(source)):
        raise ValueError(prefix + ": input cannot be represented as float32")
    limit = 120.0 if timeout is None else float(timeout)
    if not math.isfinite(limit) or not 0 < limit <= 300:
        raise ValueError(prefix + ": invalid worker timeout")
    with tempfile.TemporaryDirectory(prefix="aiplay-vst3-") as directory:
        root = Path(directory)
        input_file, output_file = root / "input.npy", root / "output.npy"
        np.save(input_file, source, allow_pickle=False)
        request = {"op": "process", "registry": registry, "id": identity,
                   "fingerprint": fingerprint, "state": state, "params": params,
                   "hostVersion": descriptor.get("hostVersion"),
                   "input": str(input_file), "output": str(output_file), "sr": sr}
        request_file = root / "request.json"
        request_file.write_text(json.dumps(request, allow_nan=False), encoding="utf-8")
        stdout_file, stderr_file = root / "stdout.txt", root / "stderr.txt"
        try:
            with open(stdout_file, "wb") as stdout, open(stderr_file, "wb") as stderr:
                result = subprocess.run([python, str(WORKER), "--request", str(request_file)],
                                        stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                        shell=False, timeout=limit,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired as exc:
            raise ValueError(prefix + f": worker timed out after {limit:g} seconds") from exc
        except OSError as exc:
            raise ValueError(prefix + ": worker could not start: " + str(exc)) from exc
        stdout, stderr = _log_tail(stdout_file), _log_tail(stderr_file)
        lines = [line for line in stdout.splitlines() if line.strip()]
        try:
            reply = json.loads(lines[-1]) if lines else {}
        except (ValueError, TypeError):
            reply = {}
        if result.returncode or not isinstance(reply, dict) or reply.get("ok") is not True:
            detail = str((reply.get("error") or "") if isinstance(reply, dict) else "") or stderr.strip() or f"worker returned no successful result (exit {result.returncode})"
            raise ValueError(prefix + ": " + detail[-2000:])
        if not output_file.is_file() or output_file.stat().st_size > source.nbytes + 65536:
            raise ValueError(prefix + ": worker returned a missing or oversized audio file")
        try:
            output = np.load(output_file, allow_pickle=False)
        except (OSError, ValueError) as exc:
            raise ValueError(prefix + ": worker returned invalid audio") from exc
        if output.shape != source.shape or output.dtype != np.float32 or not np.all(np.isfinite(output)):
            raise ValueError(prefix + ": worker returned a different shape, type or non-finite audio")
        if not isinstance(reply.get("frames"), int) or isinstance(reply["frames"], bool) or reply["frames"] != source.shape[1]:
            raise ValueError(prefix + ": worker frame count does not match its audio")
        return output.astype(np.float64)
