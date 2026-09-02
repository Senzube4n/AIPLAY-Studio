#!/usr/bin/env python
"""h3_bleed.py — measure how much of a reference image is showing through.

WHY THIS EXISTS. `h3_score.py` measures psnr_ref, loop_db, flicker and audio_rms.
None of them detect reference bleed: every one compares a clip against a
CONVERGED RUN OF ITSELF, so a clip that faithfully reproduces the reference on
every frame scores perfectly. The bleed complaint had no instrument behind it.

WHAT IT MEASURES, and why the shape matters more than the number.

  ncc[t]  normalised cross-correlation between output frame t and the reference,
          on mean-removed luma at a common analysis size. Scale-free and
          brightness-free, so a clip that merely shares the reference's exposure
          does not score.

The CURVE is the diagnosis, not the mean, because the two mechanisms in
docs/H3_REFERENCE_BLEED.md produce different curves:

  DECAYING from frame 0   -> reference-COPY. The last reference sits 1.000 RoPE
                             time-units from frame 0 while frame 1 sits 1.667
                             away, so a copy head has its strongest pull at the
                             start and it washes out.
  FLAT across the clip    -> posterior-mean COLLAPSE. At 4 steps the committed
                             x0 comes from sigma 0.800 and the reference is the
                             only clean signal in the attention window, so it
                             biases every frame equally.

  band    the fraction of total NCC contribution falling in the central vertical
          third of the frame. `_frame_grid` area-normalises around centre 16.0,
          so mechanism (1) predicts the ghost lands as a TALL NARROW BAND THROUGH
          THE VERTICAL CENTRE. A band score well above 1/3 is that signature.

THE CONTROL YOU MUST NOT SKIP. An NCC of 0.4 means nothing on its own — a rap
video and its own character reference share a person, a palette and a framing.
So every run also scores the clip against a MISMATCHED reference: one belonging
to a different clip. Bleed is (matched - mismatched), not matched. Without that
baseline every number here flatters itself.

Usage:
  h3_bleed.py --clip <mp4> --refs <png> [<png> ...] [--control <png>]
  h3_bleed.py --ledger            # score recent reference-conditioned H3 clips
"""
import argparse, json, os, sys, glob
import numpy as np
import cv2

AW, AH = 320, 176           # analysis size; cheap and enough for a ghost
LEDGER = os.path.expanduser(r"~\.aiplay-studio\clips.json")
INPUT_DIR = r"D:\AI\aiplay-studio-bench\ComfyUI\input"
CLIP_DIR = r"D:\AI\aiplay-studio-bench\ComfyUI\output\clips"


def _gray(img, fit=False):
    """Luma at the analysis size.

    `fit` PRESERVES ASPECT by letterboxing instead of stretching, and it matters
    more than it looks. References here are not 16:9 — the ones in use are
    942x395, 1372x1190 and 768x1344, the last of which is PORTRAIT. Squashing a
    768x1344 reference into a 320x176 landscape frame destroys a correlation the
    eye picks up instantly: on mv_bone-waffle-cgi_s1_4_mtgkjbnr the first three
    output frames are visibly that reference, yet stretched-NCC scored it at
    0.044 and picked a different reference as the frame-0 owner.

    Fitting is also what the pipeline does. `ref_image_size: "match"`
    (workflow.js:1404) scales a reference to the generation's pixel AREA while
    PRESERVING ASPECT, so the model never sees a stretched reference either.
    Measuring against a stretched one measures something the model was never
    shown.
    """
    if img is None:
        return None
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    if not fit:
        return cv2.resize(g, (AW, AH), interpolation=cv2.INTER_AREA).astype(np.float32)
    h, w = g.shape[:2]
    s = min(AW / w, AH / h)
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    r = cv2.resize(g, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.full((AH, AW), float(r.mean()), np.float32)   # pad with its own
    y0, x0 = (AH - nh) // 2, (AW - nw) // 2                    # mean, so the pad
    canvas[y0:y0 + nh, x0:x0 + nw] = r                         # adds no signal
    return canvas


def _frames(path, limit=None):
    cap = cv2.VideoCapture(path)
    out = []
    while True:
        ok, f = cap.read()
        if not ok or (limit and len(out) >= limit):
            break
        out.append(_gray(f))
    cap.release()
    return out


def _ncc_map(a, b):
    """Per-pixel contribution to normalised cross-correlation."""
    a = a - a.mean()
    b = b - b.mean()
    d = (np.linalg.norm(a) * np.linalg.norm(b)) or 1e-9
    return (a * b) / d


def score(clip, refs, control=None):
    frames = _frames(clip)
    if not frames:
        return {"error": f"no frames decoded from {clip}"}
    rimgs = [_gray(cv2.imread(r), fit=True) for r in refs]
    rimgs = [r for r in rimgs if r is not None]
    if not rimgs:
        return {"error": "no references decoded"}

    def series(rs):
        per_frame, band = [], []
        for f in frames:
            best, bestmap = -2.0, None
            for r in rs:                       # a frame answers to its BEST ref
                m = _ncc_map(f, r)
                v = float(m.sum())
                if v > best:
                    best, bestmap = v, m
            per_frame.append(best)
            pos = np.clip(bestmap, 0, None)
            tot = pos.sum() or 1e-9
            c0, c1 = AW // 3, 2 * AW // 3      # central vertical third
            band.append(float(pos[:, c0:c1].sum() / tot))
        return np.array(per_frame), np.array(band)

    ncc, band = series(rimgs)

    # PER-REFERENCE SERIES, and why best-of-refs is not enough.
    #
    # The first version took the max over references at every frame, and it hid
    # the very thing it was built to find. On mv_bone-waffle-cgi_s1_4_mtgkjbnr
    # the opening frames ARE reference 3 almost verbatim, then the clip hands
    # over to the generated scene — which correlates with reference 1, the
    # character. Best-of-refs tracked whichever reference happened to dominate,
    # so it stayed flat and reported decay -0.18, classified "rising, neither
    # mechanism". Visual inspection said the opposite in one glance.
    #
    # The copy signature lives in ONE reference's own curve: whichever reference
    # owns frame 0, measured against ITSELF over the whole clip. So score each
    # reference separately and report the decay of the frame-0 owner.
    per_ref = [series([r])[0] for r in rimgs]
    owner = int(np.argmax([s[0] for s in per_ref]))
    own = per_ref[owner]
    n0 = min(3, len(own))
    tail = max(1, len(own) // 4)
    out = {
        "clip": os.path.basename(clip),
        "frames": len(frames),
        "ncc_mean": round(float(ncc.mean()), 4),
        "ncc_frame0": round(float(ncc[0]), 4),
        "ncc_last": round(float(ncc[-1]), 4),
        "decay": round(float(ncc[0] - ncc[-1]), 4),
        "band_mean": round(float(band.mean()), 4),
        "band_excess": round(float(band.mean() - 1.0 / 3.0), 4),
        # the frame-0 owner's own curve — this is the copy measurement
        "owner_ref": owner + 1,
        "owner_head": round(float(own[:n0].mean()), 4),      # first 3 frames
        "owner_tail": round(float(own[-tail:].mean()), 4),   # last quarter
        "owner_decay": round(float(own[:n0].mean() - own[-tail:].mean()), 4),
    }

    # THE NULL, measured rather than assumed — and measured over a POOL.
    #
    # The first version of this used ONE arbitrary mismatched reference and the
    # numbers were unusable: across six near-identical clips the control swung
    # from -0.33 to +0.21 and the resulting "bleed" varied twentyfold. That
    # spread was the control's own content, not the clip's. A single foil is not
    # a baseline, it is another sample. So score against EVERY mismatched
    # reference available and take the distribution: the mean is the baseline a
    # matched reference has to beat, and the spread says whether beating it
    # means anything. Same discipline the gate scorer uses for its own NULL.
    if control:
        pool = [control] if isinstance(control, str) else list(control)
        cimgs = [_gray(cv2.imread(c), fit=True) for c in pool]
        cimgs = [c for c in cimgs if c is not None]
        if cimgs:
            per = [series([c])[0].mean() for c in cimgs]
            per = np.array(per, dtype=np.float64)
            out["ncc_null_mean"] = round(float(per.mean()), 4)
            out["ncc_null_sd"] = round(float(per.std()), 4)
            out["null_n"] = int(per.size)
            out["bleed"] = round(float(ncc.mean() - per.mean()), 4)
            # How many null standard deviations clear? Below ~2 the number is
            # not distinguishable from picking a different foil.
            out["bleed_z"] = round(float((ncc.mean() - per.mean()) / (per.std() or 1e-9)), 2)

    # THE SHAPE CALL, gated on the clip's own frame-to-frame noise.
    #
    # decay is ncc[0]-ncc[-1], two single frames, so it inherits whatever
    # jitter the series has. Comparing it against a fixed 0.05 classified pure
    # noise as a mechanism on the first run. Require it to clear the series'
    # own variation before naming anything.
    step_noise = float(np.abs(np.diff(ncc)).mean()) if len(ncc) > 1 else 0.0
    out["step_noise"] = round(step_noise, 4)
    thresh = max(0.05, 3.0 * step_noise)
    out["shape_thresh"] = round(thresh, 4)
    if out["decay"] > thresh:
        out["shape"] = "decaying -> reference-COPY (RoPE adjacency)"
    elif out["decay"] < -thresh:
        out["shape"] = "rising -> neither mechanism; investigate"
    else:
        out["shape"] = f"flat within noise (|decay| <= {thresh:.3f}) -> no shape call"
    return out


def from_ledger(n=6):
    j = json.load(open(LEDGER, encoding="utf-8"))
    m = j.get("meta", {})
    h3 = [(k, v) for k, v in m.items()
          if v and v.get("engine") == "h3" and (v.get("refImages") or []) and v.get("steps", 99) <= 4]
    h3.sort(key=lambda kv: kv[1].get("at", 0), reverse=True)
    rows = []
    # a mismatched reference from a DIFFERENT clip, for the control
    pool = {r for _, v in h3 for r in v.get("refImages", [])}
    for name, meta in h3[:n]:
        clip = os.path.join(CLIP_DIR, name)
        if not os.path.exists(clip):
            continue
        refs = [os.path.join(INPUT_DIR, r) for r in meta["refImages"]]
        refs = [r for r in refs if os.path.exists(r)]
        if not refs:
            continue
        others = sorted(r for r in pool if r not in meta["refImages"])
        ctrl = [os.path.join(INPUT_DIR, r) for r in others]
        ctrl = [c for c in ctrl if os.path.exists(c)] or None
        r = score(clip, refs, ctrl)
        r["size"] = f'{meta.get("width")}x{meta.get("height")}'
        r["steps"] = meta.get("steps")
        r["nrefs"] = len(refs)
        rows.append(r)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clip")
    ap.add_argument("--refs", nargs="*")
    ap.add_argument("--control")
    ap.add_argument("--ledger", action="store_true")
    ap.add_argument("-n", type=int, default=6)
    a = ap.parse_args()

    rows = from_ledger(a.n) if a.ledger else [score(a.clip, a.refs or [], a.control)]
    hdr = f'{"clip":42s} {"size":11s} {"st":>3s} {"r":>2s} {"nccM":>7s} {"null":>7s} {"nullSD":>6s} {"BLEED":>7s} {"z":>6s} {"ref":>4s} {"head":>6s} {"tail":>6s} {"COPY":>7s}'
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        if "error" in r:
            print(r["error"]); continue
        print(f'{r["clip"][:42]:42s} {r.get("size",""):11s} {str(r.get("steps","")):>3s} '
              f'{str(r.get("nrefs","")):>2s} {r["ncc_mean"]:7.4f} {r.get("ncc_null_mean",float("nan")):7.4f} '
              f'{r.get("ncc_null_sd",float("nan")):6.4f} {r.get("bleed",float("nan")):7.4f} '
              f'{r.get("bleed_z",float("nan")):6.2f} {r.get("owner_ref",0):4d} '
              f'{r.get("owner_head",float("nan")):6.3f} {r.get("owner_tail",float("nan")):6.3f} '
              f'{r.get("owner_decay",float("nan")):7.3f}')
    print()
    print("  BLEED = matched-ref NCC minus mismatched-ref NCC. The mismatched control is")
    print("  what makes the number mean anything: a clip and its own character reference")
    print("  share a person and a palette, so raw NCC flatters itself.")
    print("  decay = ncc[0]-ncc[-1].  >0.05 reference-COPY, ~0 posterior-mean COLLAPSE.")
    print("  band  = share of positive NCC in the central vertical third. 0.333 is neutral;")
    print("          well above it is the tall-centred-band signature of RoPE adjacency.")
    for r in rows:
        if "shape" in r:
            print(f'    {r["clip"][:42]:42s} {r["shape"]}')


if __name__ == "__main__":
    main()
