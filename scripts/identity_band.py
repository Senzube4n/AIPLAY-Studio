#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""identity_band.py - did the CHARACTER carry, measured where the character is.

WHY THIS EXISTS AT ALL. Two whole-frame measures were run first and both came
back unable to answer, for the SAME reason, which is the honest result to report
and the reason this file is not a third guess:

    h3_bleed NCC (whole frame)      z = 0.58   inconclusive
    H-S palette (whole frame)       z = -0.59  inconclusive, one foil beat the target

Neither was broken. Both were dominated by pixels that were SUPPOSED to change -
the character sheet's background is a night sky, the render's is daylight, and
background is most of both frames. A measure of whether the character carried has
to look at where the character is.

THE WINDOW, and it is one rule applied identically to every image on both sides -
no per-image tuning, and the foil pool is windowed the same way, so a window that
flattered the target would flatter the foils too:

    x in [0.30, 0.70] of width, y in [0.05, 1.00] of height

For single-figure character sheets and centre-framed shots the central 40% band
IS the figure in every one of them. It is stated rather than tuned, and the
un-windowed numbers above are reported beside it so a reader can see exactly what
the window bought.

WHAT CHANGED WHEN THIS CAME INTO THE REPO
-----------------------------------------
The scratchpad version hard-coded one project's seven character sheets and two
clip paths at module scope, so it could measure exactly one thing. Two changes,
both forced by the cross-clip consistency experiment:

  1. EXPLICIT BOXES, not only the central band. That experiment has TWO actors in
     ONE frame. A central band would mix them, and a mixture is not a smaller
     measurement of one actor - it is a measurement of neither. So a caller can
     hand in a per-frame pixel box, and the analytic ground truth's projected
     neck and hip are what produce those boxes. The fractional window stays the
     default and is unchanged, because the single-figure measurement it was
     written for is still a thing this file does.
  2. The maths is a library and the paths are a CLI. `bands_from_frames()` takes
     decoded frames, so identity_band_test.py can assert on the arithmetic
     without an encoder, a GPU or a project on disk.

WHAT THE z MEANS, AND WHAT IT DOES NOT
--------------------------------------
z = (score_vs_target - mean(score_vs_foils)) / sd(score_vs_foils). It says how
far the target sits from the foil pool in units of that pool's own spread. It is
NOT a p-value: six foils is six foils, the scores are not independent, and the
pool's sd is estimated from those same six. `foil_max` is printed beside every z
for that reason - a z of 2 with a foil that beats the target is a z that has
stopped meaning what it looks like, and only the max shows it.
"""
import json
import os
import sys

import numpy as np
import cv2

# The window, as fractions of width and height. See the header.
WINDOW = (0.30, 0.70, 0.05, 1.00)
HB, SB = 30, 32          # hue and saturation bins
AW, AH = 176, 320        # portrait analysis size; the band is taller than wide


# ------------------------------------------------------------------ windows
def band(img, window=WINDOW):
    """The fractional central band of an image. One rule, every image."""
    x0, x1, y0, y1 = window
    h, w = img.shape[:2]
    return img[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]


def crop_box(img, box):
    """An explicit pixel box (x0, y0, x1, y1), clipped to the image.

    Returns None when the box has no area inside the frame - which is a real
    answer, not an error: it is what an actor the camera is not pointing at looks
    like, and it must be distinguishable from a crop that came back grey."""
    h, w = img.shape[:2]
    x0 = max(0, int(round(box[0])))
    y0 = max(0, int(round(box[1])))
    x1 = min(w, int(round(box[2])))
    y1 = min(h, int(round(box[3])))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return img[y0:y1, x0:x1]


def box_from_points(neck_uv, hip_uv, width_scale=1.6, pad_head=0.55, pad_foot=0.95):
    """A body box from the two points the ground truth actually knows.

    The neck-to-hip distance is the only scale in the scene that is measured
    rather than assumed, so everything else is expressed in it: the box is
    `width_scale` torsos wide, reaches `pad_head` of a torso above the neck and
    `pad_foot` below the hip. Those three came from the geometry of the figure
    box (0.5 m wide, 1.8 m tall, neck at 1.52 m, hip at 0.95 m) and not from
    looking at any render - a crop tuned on the pixels it will later score is not
    a measurement."""
    n = np.asarray(neck_uv, float)
    hp = np.asarray(hip_uv, float)
    torso = float(np.linalg.norm(hp - n))
    if not np.isfinite(torso) or torso < 1e-3:
        return None
    cx = 0.5 * (n[0] + hp[0])
    half = 0.5 * width_scale * torso
    top = min(n[1], hp[1]) - pad_head * torso
    bot = max(n[1], hp[1]) + pad_foot * torso
    return (cx - half, top, cx + half, bot)


# ------------------------------------------------------------------ measures
def hist(bgr):
    """A normalised hue-saturation histogram. Value is deliberately dropped: it
    is the channel a lighting change moves most, and the question is about the
    character, not the exposure."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1], None, [HB, SB], [0, 180, 0, 256])
    return (h / (h.sum() or 1.0)).ravel()


def luma(bgr, aw=AW, ah=AH):
    return cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), (aw, ah),
                      interpolation=cv2.INTER_AREA).astype(np.float32)


def ncc(a, b):
    a = np.asarray(a, np.float64)
    b = np.asarray(b, np.float64)
    a = a - a.mean()
    b = b - b.mean()
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float((a * b).sum() / d) if d > 1e-9 else 0.0


def intersect(p, q):
    """Histogram intersection: 1.0 for identical distributions, 0 for disjoint."""
    return float(np.minimum(np.asarray(p, float), np.asarray(q, float)).sum())


# ------------------------------------------------------------------ clips
def bands_from_frames(frames, boxes=None, window=WINDOW):
    """-> (mean H-S histogram, [luma per crop], n_used, n_skipped).

    `boxes` is a per-frame (x0,y0,x1,y1) or None on frames where the actor is not
    in shot; pass None for the whole list to use the fractional window instead.
    Skipped frames are COUNTED and returned, because a mean over eleven frames and
    one over a hundred and twenty-one are different claims."""
    hs, ls, used, skipped = None, [], 0, 0
    for i, f in enumerate(frames):
        if boxes is None:
            c = band(f, window)
        else:
            b = boxes[i] if i < len(boxes) else None
            c = None if b is None else crop_box(f, b)
        if c is None or c.size == 0:
            skipped += 1
            continue
        h = hist(c)
        hs = h if hs is None else hs + h
        ls.append(luma(c))
        used += 1
    if not used:
        return None, [], 0, skipped
    return hs / used, ls, used, skipped


def clip_bands(mp4, boxes=None, window=WINDOW, max_frames=None):
    """The same, decoding an mp4 one frame at a time so a long clip never has to
    be held in memory."""
    cap = cv2.VideoCapture(mp4)
    hs, ls, used, skipped, i = None, [], 0, 0, 0
    while True:
        ok, f = cap.read()
        if not ok or (max_frames is not None and i >= max_frames):
            break
        if boxes is None:
            c = band(f, window)
        else:
            b = boxes[i] if i < len(boxes) else None
            c = None if b is None else crop_box(f, b)
        i += 1
        if c is None or c.size == 0:
            skipped += 1
            continue
        h = hist(c)
        hs = h if hs is None else hs + h
        ls.append(luma(c))
        used += 1
    cap.release()
    if not used:
        return None, [], 0, skipped
    return hs / used, ls, used, skipped


# ------------------------------------------------------------------ z
def zscore(target, foils):
    """(target - mean(foils)) / sd(foils), with the pieces kept.

    `foil_max` is returned and must be printed with the z. A z above the pool
    whose single best foil still beats the target is not evidence of identity; it
    is evidence that the pool is tight, and only the max distinguishes the two."""
    f = np.asarray(list(foils), float)
    mean = float(f.mean()) if f.size else float("nan")
    sd = float(f.std()) if f.size else float("nan")
    return {
        "target": float(target),
        "foil_mean": mean,
        "foil_sd": sd,
        "foil_max": float(f.max()) if f.size else float("nan"),
        "foil_n": int(f.size),
        "delta": float(target) - mean,
        "z": (float(target) - mean) / (sd if sd else 1e-9),
        "beaten_by_a_foil": bool(f.size and f.max() >= target),
    }


def compare_bands(a, b):
    """Two (hist, lumas) band summaries -> palette intersection and mean NCC.

    The NCC is the mean over every luma in `b` against the mean luma of `a`,
    which is the same shape of statistic the scratchpad version computed and is
    kept so the numbers stay comparable to the ones already recorded."""
    (ha, la), (hb, lb) = a, b
    out = {"palette": float("nan"), "ncc": float("nan")}
    if ha is not None and hb is not None:
        out["palette"] = intersect(ha, hb)
    if la and lb:
        ref = np.mean(np.stack(la), axis=0)
        out["ncc"] = float(np.mean([ncc(ref, x) for x in lb]))
    return out


# ------------------------------------------------------------------ CLI
def main():
    """identity_band.py <config.json> [out.json]

    config: {"window": [x0,x1,y0,y1] (optional),
             "target": "sheet_or_clip_path",
             "foils": ["path", ...],
             "clips": {"label": "path.mp4", ...}}

    Every path is windowed by the SAME rule, target and foils alike."""
    if len(sys.argv) < 2:
        print(__doc__)
        print(main.__doc__)
        return 2
    cfg = json.load(open(sys.argv[1], encoding="utf-8"))
    window = tuple(cfg.get("window", WINDOW))

    def still(p):
        img = cv2.imread(p)
        if img is None:
            raise SystemExit("cannot read %s" % p)
        c = band(img, window)
        return hist(c), [luma(c)]

    tgt = still(cfg["target"])
    foils = {os.path.basename(p): still(p) for p in cfg["foils"]}

    rows = []
    for label, mp4 in cfg["clips"].items():
        h, ls, used, skipped = clip_bands(mp4, window=window)
        clip = (h, ls)
        pt = compare_bands(tgt, clip)
        pf = [compare_bands(f, clip) for f in foils.values()]
        rows.append({
            "clip": label, "frames_used": used, "frames_skipped": skipped,
            "palette": zscore(pt["palette"], [x["palette"] for x in pf]),
            "ncc": zscore(pt["ncc"], [x["ncc"] for x in pf]),
        })

    print("window x in [%.2f,%.2f], y in [%.2f,%.2f], applied to the target, every foil "
          "and every clip\n" % window)
    hdr = "%-10s %-8s %8s %9s %8s %8s %8s %6s" % (
        "clip", "measure", "vs TGT", "foil mean", "foil sd", "foil max", "DELTA", "z")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        for m in ("palette", "ncc"):
            z = r[m]
            print("%-10s %-8s %8.4f %9.4f %8.4f %8.4f %8.4f %6.2f%s"
                  % (r["clip"], m, z["target"], z["foil_mean"], z["foil_sd"],
                     z["foil_max"], z["delta"], z["z"],
                     "  <- A FOIL BEATS IT" if z["beaten_by_a_foil"] else ""))
    if len(sys.argv) > 2:
        json.dump(rows, open(sys.argv[2], "w"), indent=1)
        print("\nwrote %s" % sys.argv[2])
    return 0


if __name__ == "__main__":
    sys.exit(main())
