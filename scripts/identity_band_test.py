#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""identity_band_test.py - the arithmetic, and the claim in miniature.

No GPU, no encoder, no project on disk. Two halves:

  THE ARITHMETIC. The window is where it says it is; a histogram sums to 1; a
  histogram intersected with itself is 1 and with a disjoint one is 0; NCC of an
  image with itself is +1 and with its inverse is -1; z is (target - mean)/sd and
  reports the foil that beat it.

  THE CLAIM IN MINIATURE. Two synthetic "clips" of the same two coloured actors,
  shot from two different framings. Cropping by each actor's own box, the SAME
  actor across the two clips must score higher than the OTHER actor - and the
  central-band window must FAIL to show it, because the band mixes the two. That
  second half is the whole reason boxes were added to this file, and asserting
  the failure is what stops someone deleting them later as redundant.

Run: D:\\AI\\aiplay-studio-bench\\venv\\Scripts\\python.exe scripts/identity_band_test.py
"""
import os
import sys

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import identity_band as IB   # noqa: E402

FAILED = []
W, H = 320, 176


def check(name, cond, detail=""):
    print("  %-4s %s%s" % ("ok" if cond else "FAIL", name, ("   " + detail) if detail else ""))
    if not cond:
        FAILED.append(name)


def solid(bgr, w=W, h=H):
    im = np.zeros((h, w, 3), np.uint8)
    im[:, :] = bgr
    return im


def scene(pos_a, pos_b, col_a, col_b, bg=(40, 40, 40), bw=34, bh=96):
    """One frame: two coloured rectangles on a common background."""
    im = solid(bg)
    for (cx, cy), col in ((pos_a, col_a), (pos_b, col_b)):
        x0, y0 = int(cx - bw / 2), int(cy - bh / 2)
        im[max(0, y0):y0 + bh, max(0, x0):x0 + bw] = col
    return im


def main():
    print("identity_band_test")
    print()

    # ------------------------------------------------- the window
    im = np.zeros((200, 400, 3), np.uint8)
    b = IB.band(im)
    check("the default window is x[0.30,0.70] y[0.05,1.00] of the image",
          b.shape[:2] == (int(0.95 * 200), int(0.40 * 400)),
          "%dx%d of 400x200 -> %r" % (400, 200, b.shape[:2]))
    b2 = IB.band(im, (0.0, 1.0, 0.0, 1.0))
    check("a full window is the whole image", b2.shape == im.shape)

    box = IB.crop_box(im, (-50, -50, 60, 70))
    check("crop_box clips to the frame", box is not None and box.shape[:2] == (70, 60),
          repr(None if box is None else box.shape[:2]))
    check("a box with no area inside the frame returns None, not an empty array",
          IB.crop_box(im, (500, 500, 600, 600)) is None)

    bb = IB.box_from_points((100.0, 50.0), (100.0, 90.0))
    check("box_from_points is built from the neck-hip distance",
          bb is not None and abs((bb[2] - bb[0]) - 1.6 * 40) < 1e-6
          and abs((bb[3] - bb[1]) - (40 + (0.55 + 0.95) * 40)) < 1e-6,
          "w %.1f h %.1f for a 40 px torso" % (bb[2] - bb[0], bb[3] - bb[1]))
    check("box_from_points refuses a degenerate torso",
          IB.box_from_points((10.0, 10.0), (10.0, 10.0)) is None)

    # ------------------------------------------------- the measures
    red = solid((0, 0, 255))
    blue = solid((255, 0, 0))
    hr, hb = IB.hist(red), IB.hist(blue)
    check("a histogram is normalised", abs(hr.sum() - 1.0) < 1e-9, "sum %.9f" % hr.sum())
    check("a histogram intersected with itself is 1", abs(IB.intersect(hr, hr) - 1.0) < 1e-9)
    check("two disjoint hues do not intersect", IB.intersect(hr, hb) < 1e-9,
          "%.6f" % IB.intersect(hr, hb))

    g = np.random.default_rng(7).normal(size=(64, 64)).astype(np.float32)
    check("NCC of an image with itself is +1", abs(IB.ncc(g, g) - 1.0) < 1e-9)
    check("NCC of an image with its inverse is -1", abs(IB.ncc(g, -g) + 1.0) < 1e-9)
    check("NCC ignores an offset and a gain",
          abs(IB.ncc(g, 3.0 * g + 10.0) - 1.0) < 1e-9)

    z = IB.zscore(0.9, [0.1, 0.2, 0.3])
    exp = (0.9 - 0.2) / np.std([0.1, 0.2, 0.3])
    check("z is (target - foil mean) / foil sd", abs(z["z"] - exp) < 1e-9,
          "%.4f" % z["z"])
    check("z reports the pool size and max", z["foil_n"] == 3 and abs(z["foil_max"] - 0.3) < 1e-9)
    check("a foil that beats the target is flagged",
          IB.zscore(0.2, [0.1, 0.9])["beaten_by_a_foil"] is True)
    check("a foil that does not is not",
          IB.zscore(0.95, [0.1, 0.9])["beaten_by_a_foil"] is False)

    # ------------------------------------------------- the claim in miniature
    # Two "clips" of the same two actors. Clip 1 has A left and B right; clip 2
    # is a different framing - A right, B left, both shifted - which is exactly
    # what a second camera does. The colours are the identity.
    COL_A, COL_B = (40, 200, 255), (200, 60, 90)     # amber, magenta-ish
    clip1, boxes1 = [], {"A": [], "B": []}
    clip2, boxes2 = [], {"A": [], "B": []}
    n = 24
    for t in range(n):
        pa1, pb1 = (90 + t, 88), (230 - t, 88)
        pa2, pb2 = (215 - t, 92), (95 + t, 92)
        clip1.append(scene(pa1, pb1, COL_A, COL_B))
        clip2.append(scene(pa2, pb2, COL_A, COL_B))
        for pos, store in ((pa1, boxes1["A"]), (pb1, boxes1["B"]),
                           (pa2, boxes2["A"]), (pb2, boxes2["B"])):
            store.append((pos[0] - 17, pos[1] - 48, pos[0] + 17, pos[1] + 48))

    def bands(frames, boxes):
        h, ls, used, skipped = IB.bands_from_frames(frames, boxes)
        return (h, ls), used, skipped

    b1a, u1a, _ = bands(clip1, boxes1["A"])
    b1b, _, _ = bands(clip1, boxes1["B"])
    b2a, _, _ = bands(clip2, boxes2["A"])
    b2b, _, _ = bands(clip2, boxes2["B"])
    check("every frame contributed a crop", u1a == n, "%d/%d" % (u1a, n))

    same = IB.compare_bands(b1a, b2a)["palette"]          # A in clip 1 vs A in clip 2
    other = IB.compare_bands(b1a, b2b)["palette"]         # A in clip 1 vs B in clip 2
    # A foil pool that is NOT degenerate. Four solid colours would all score
    # exactly 0 against A, the pool's sd would be 0, and the z would be an
    # artefact of the 1e-9 guard rather than a measurement. Each foil is instead
    # a vertical split - a fraction f of A's own colour beside a foreign one - so
    # the pool has a real mean and a real spread, and the z has to earn itself.
    def split_foil(f, other):
        im = solid(other)
        im[:, :int(round(f * W))] = COL_A
        return (IB.hist(im), [IB.luma(im)])

    foils = [IB.compare_bands(split_foil(f, c), b2a)["palette"]
             for f, c in ((0.10, (10, 240, 10)), (0.25, (240, 240, 10)),
                          (0.40, (10, 10, 240)), (0.55, (250, 120, 20)))]
    zz = IB.zscore(same, [other] + foils)
    check("the SAME actor across two clips beats the OTHER actor",
          same > other + 0.2, "same %.3f vs other %.3f" % (same, other))
    check("the foil pool has a real spread, so the z is not a divide-by-zero",
          zz["foil_sd"] > 0.05, "foil sd %.4f over %d foils" % (zz["foil_sd"], zz["foil_n"]))
    check("and the target beats every foil, so the z is not a tight-pool artefact",
          not zz["beaten_by_a_foil"] and 1.0 < zz["z"] < 1e3,
          "z %.2f, foil mean %.3f, foil max %.3f" % (zz["z"], zz["foil_mean"], zz["foil_max"]))

    # the central band CANNOT do this here: it straddles both actors
    cb1, _, _ = bands(clip1, None)
    cb2a, _, _ = bands(clip2, boxes2["A"])
    cb2b, _, _ = bands(clip2, boxes2["B"])
    band_same = IB.compare_bands(cb1, cb2a)["palette"]
    band_other = IB.compare_bands(cb1, cb2b)["palette"]
    check("the central-band window CANNOT separate two actors in one frame",
          abs(band_same - band_other) < 0.2,
          "band vs A %.3f, vs B %.3f (gap %.3f); per-actor boxes give a gap of %.3f"
          % (band_same, band_other, abs(band_same - band_other), same - other))

    print()
    if FAILED:
        print("FAILED: %s" % ", ".join(FAILED))
        return 1
    print("all identity_band assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
