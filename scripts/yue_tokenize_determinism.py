"""
READ THE SAME FILE TWICE, GET THE SAME CODES — the real-audio tokenizer, for real.

Until 2026-09-25 it did not: under transformers 5 MERT's rotary table was never
initialised, so the same 20 s file read four times gave 1, 269, 269 and 277
distinct codes. server/music/yue_tokenize_test.py pins the repair without
weights; this check runs the Studio's own script twice, each time in a fresh
process with a fresh load of MERT, on the CPU, and requires the two readings
to be identical and not collapsed, and, with --reference, to agree with a
reading known to be right.

IDENTICAL READINGS ALONE DO NOT PROVE THE REPAIR. The garbage is whatever
memory held, so it depends on the machine's state: on 2026-10-08 the
unrepaired reader read hexv4_mix_H1 identically twice, in two fresh processes,
and agreed with the repaired reading on 7 % of frames. Pass --reference.

    python scripts/yue_tokenize_determinism.py --audio song.wav --seconds 20 [--contrast] [--reference fixed.npy]

--mert and --head default to the catalogued files under AIPLAY_MODELS_DIR or
AIPLAY_RIG. --contrast also reads the file twice in this process with the
repair switched off, to show what the unrepaired reader does on this install
(informational; it never decides the verdict). --reference compares with a
reading made elsewhere, and the verdict then also needs 99 % of frames to
agree with it. Needs the weights (2.7 GB) and a few GB of RAM, never
the card: CUDA_VISIBLE_DEVICES is set to -1 for every reading. About a minute
per pair on a desktop CPU. Prints one JSON line; exit 0 when the two readings
are identical, 1 when they are not or a reading failed. Not a gate lane.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "server", "music", "yue_tokenize.py")


def models_dir():
    if os.environ.get("AIPLAY_MODELS_DIR"):
        return os.environ["AIPLAY_MODELS_DIR"]
    if os.environ.get("AIPLAY_RIG"):
        return os.path.join(os.environ["AIPLAY_RIG"], "ComfyUI", "models")
    return None


def read_once(args, out):
    t0 = time.perf_counter()
    cmd = [sys.executable, SCRIPT, "--audio", args.audio, "--out", out, "--mert", args.mert, "--head", args.head,
           "--device", "cpu"] + (["--seconds", str(args.seconds)] if args.seconds > 0 else [])
    r = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, CUDA_VISIBLE_DEVICES="-1"))
    lines = [ln for ln in (r.stdout or "").strip().splitlines() if ln.strip()]
    try:
        info = json.loads(lines[-1]) if lines else {}
    except ValueError:
        info = {"error": lines[-1][:300]}
    if r.returncode != 0 or info.get("error") or not os.path.isfile(out):
        tail = (r.stderr or "").strip().splitlines()[-3:]
        return None, {"error": info.get("error") or "exit %s" % r.returncode, "stderr": tail}
    info["wall"] = round(time.perf_counter() - t0, 1)
    return np.load(out), info


def agree(a, b):
    n = min(len(a), len(b))
    return round(float((a[:n] == b[:n]).mean()), 4) if n else 0.0


def contrast(args, fixed):
    """Two readings in this process with the repair switched off, as the Studio read before 2026-09-25."""
    import torch
    sys.path.insert(0, os.path.dirname(SCRIPT))
    import yue_tokenize as yt
    device = torch.device("cpu")
    mono = yt._load_audio(args.audio)
    if args.seconds > 0:
        mono = mono[:int(args.seconds * yt.MERT_SR)]
    seen = []

    def unrepaired(model):   # stands where the repair stands, records the table it would have fixed
        rot = model.embed_positions
        good = 1.0 / (rot.base ** (torch.arange(0, rot.head_dim, 2, dtype=torch.float32) / rot.head_dim))
        t = rot.inv_freq.detach().float().cpu()
        finite = bool(torch.isfinite(t).all())
        seen.append({"finite": finite, "maxAbsOff": float((t - good).abs().max()) if finite else None})
        return ["embed_positions (left as loaded)"]

    real = yt.restore_rotary_inv_freq
    yt.restore_rotary_inv_freq = unrepaired
    head = yt.load_head(args.head, device)
    reads = []
    try:
        for _ in range(2):
            feats = yt.mert_features(mono, args.mert, device)
            codes = yt.predict(head, yt.instnorm(feats), device).astype(np.int32)
            reads.append({"distinctCodes": int(len(np.unique(codes))), "nanFeatures": int(np.isnan(feats).sum()),
                          "agreeWithRepaired": agree(codes, fixed), "codes": codes})
    finally:
        yt.restore_rotary_inv_freq = real
    return {
        "tables": seen,
        "reads": [{k: v for k, v in r.items() if k != "codes"} for r in reads],
        "unrepairedReadsIdentical": bool(np.array_equal(reads[0]["codes"], reads[1]["codes"])),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n\n")[0])
    ap.add_argument("--audio", required=True)
    ap.add_argument("--seconds", type=float, default=20, help="read only the first N seconds (0 = all); default 20")
    ap.add_argument("--mert", default=None)
    ap.add_argument("--head", default=None)
    ap.add_argument("--reference", default=None, help="a semantic.npy read elsewhere, to compare with")
    ap.add_argument("--contrast", action="store_true", help="also read twice with the repair off (informational)")
    ap.add_argument("--keep", default=None, help="a folder to keep the two readings in")
    args = ap.parse_args()
    md = models_dir()
    args.mert = args.mert or (md and os.path.join(md, "audio_encoders", "MERT-v2-FullSong"))
    args.head = args.head or (md and os.path.join(md, "audio_encoders", "yue2_tokenizer", "tokenizer_head_joint_v4.safetensors"))
    if not args.mert or not args.head or not os.path.isdir(args.mert) or not os.path.isfile(args.head):
        print(json.dumps({"ok": False, "error": "MERT or the head is not on this machine; pass --mert and --head, or set AIPLAY_RIG"}))
        return 1
    work = args.keep or tempfile.mkdtemp(prefix="aiplay-tokdet-")
    os.makedirs(work, exist_ok=True)
    try:
        a, ia = read_once(args, os.path.join(work, "read1.semantic.npy"))
        b, ib = read_once(args, os.path.join(work, "read2.semantic.npy"))
        result = {"audio": os.path.abspath(args.audio), "seconds": args.seconds or None, "device": "cpu",
                  "read1": ia, "read2": ib}
        if a is None or b is None:
            result.update(ok=False, error="a reading failed")
            print(json.dumps(result))
            return 1
        identical = bool(np.array_equal(a, b))
        collapsed = int(len(np.unique(a))) <= 1
        readers = {ia.get("reader"), ib.get("reader")}
        result.update(identical=identical, frames=int(len(a)), distinctCodes=int(len(np.unique(a))),
                      collapsed=collapsed, reader=sorted(r for r in readers if r is not None) or None,
                      agreeReadings=agree(a, b))
        agrees = True
        if args.reference:
            result["agreeWithReference"] = agree(a, np.load(args.reference))
            agrees = result["agreeWithReference"] >= 0.99
        if args.contrast:
            result["contrast"] = contrast(args, a)
        result["ok"] = (identical and not collapsed and agrees
                        and readers == {ia.get("reader")} and ia.get("reader") is not None)
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
