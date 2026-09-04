#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""consistency_score_test.py - drive the scorer with a PERFECT render.

The nulls in consistency_score.py are the whole instrument, and a null that never
fires is decoration. So this builds the render the metric would give a perfect
score - a keypoint dump synthesised directly from camera 1's own projections,
with a body drawn around each projected neck and hip - and asserts that:

  the real score is ZERO pixels and ORDER AGREEMENT 1.000,
  the SWAPPED null is hundreds of pixels and order agreement 0.000,
  the FROZEN-frame-0 null is hundreds of pixels,
  the CROSS-CAMERA null is hundreds of pixels and its order agreement is nowhere
    near 1.000 - which is the check that says the metric is seeing the camera.

If the last one passed, every number consistency_score.py prints would be about
something other than what it claims, and no amount of GPU time would show it.

It needs the two ground-truth camera json files, which are CPU-only artefacts:

    python scripts/gate_block.py --figures 2 --camera 1
    python scripts/gate_block.py --figures 2 --camera 2

If they are absent this exits 2 with that instruction rather than passing
vacuously - a test that skips itself silently is worse than no test.

Run: D:\\AI\\aiplay-studio-bench\\venv\\Scripts\\python.exe scripts/consistency_score_test.py
"""
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pose_follow as PF          # noqa: E402
import consistency_score as CS    # noqa: E402

FAILED = []


def check(name, cond, detail=""):
    print("  %-4s %s%s" % ("ok" if cond else "FAIL", name, ("   " + detail) if detail else ""))
    if not cond:
        FAILED.append(name)


def perfect_keypoints(camjson, camera, n):
    """A COCO-18 body drawn around each actor's PROJECTED neck and hip, on every
    frame the ground truth says that actor is in shot. The limbs are placed from
    the neck-hip vector, so the dump is a rigid function of the projection and
    carries no information the projection does not."""
    d = json.load(open(camjson, encoding="utf-8"))
    tracks = d["actor_tracks"]["cam%d" % camera]
    frames = []
    for i in range(n):
        people = []
        for a in sorted(tracks):
            r = tracks[a][i]
            if not (r["neck_in_frame"] and r["hip_in_frame"]):
                continue
            nk = np.array(r["neck_uv"], float)
            hp = np.array(r["hip_uv"], float)
            v = hp - nk
            perp = np.array([-v[1], v[0]])
            k = np.zeros((18, 3))

            def put(j, p):
                k[j] = (p[0], p[1], 1.0)

            put(PF.NECK, nk)
            put(0, nk - 0.55 * v)
            put(PF.R_SHO, nk + 0.35 * perp)
            put(PF.L_SHO, nk - 0.35 * perp)
            put(PF.R_HIP, hp + 0.22 * perp)
            put(PF.L_HIP, hp - 0.22 * perp)
            put(9, hp + 0.9 * v)
            put(12, hp + 0.9 * v)
            people.append({"pose_keypoints_2d": [float(x) for x in k.ravel()]})
        frames.append({"people": people, "canvas_width": 1280, "canvas_height": 704})
    return frames


def main():
    missing = [p for p in CS.CAMJSON.values() if not os.path.exists(p)]
    if missing:
        print("consistency_score_test: the ground truth is not built.")
        for p in missing:
            print("  missing %s" % p)
        print("  build it:  python scripts/gate_block.py --figures 2 --camera 1")
        print("             python scripts/gate_block.py --figures 2 --camera 2")
        return 2

    n = CS.FRAMES
    cam = 1
    tmp = tempfile.mkdtemp(prefix="consistency_score_test_")
    kp = os.path.join(tmp, "perfect.json")
    json.dump(perfect_keypoints(CS.CAMJSON[cam], cam, n), open(kp, "w"))

    print("consistency_score_test - a synthetic render that is exactly right")
    print()

    frames, meta = PF.load_people(kp)
    frames = frames[:n]
    tgt = PF.targets_from_cam(CS.CAMJSON[cam], cam, frames=n)
    hip = PF.targets_from_cam(CS.CAMJSON[cam], cam, frames=n, joint="hip")

    check("the ground truth has two actors", sorted(tgt) == ["A", "B"], repr(sorted(tgt)))
    check("the synthetic dump has people on most frames",
          meta["frames_with_any_person"] > 0.8 * n,
          "%d/%d" % (meta["frames_with_any_person"], n))
    check("the orbit camera loses an actor for part of the clip, as measured",
          meta["people_per_frame_min"] < 2 <= meta["people_per_frame_max"],
          "people per frame %d..%d" % (meta["people_per_frame_min"],
                                       meta["people_per_frame_max"]))

    real, _ = CS.score_one(frames, tgt, hip)
    worst_real = max(real["actors"][a]["error"]["neck"]["mean_px"] for a in tgt)
    check("a perfect render scores ZERO pixels", worst_real < 1e-6,
          "worst actor %.3g px" % worst_real)
    check("and ORDER AGREEMENT 1.000",
          abs(real["layout"]["order_agreement"] - 1.0) < 1e-12,
          "%.4f over %d pairs" % (real["layout"]["order_agreement"], real["layout"]["pairs"]))
    check("and a layout vector error of zero",
          real["layout"]["vector_err_norm_mean"] < 1e-9,
          "%.3g" % real["layout"]["vector_err_norm_mean"])

    # ---- null (i) swapped ------------------------------------------------
    sw, _ = PF.assign_by_projection(frames, tgt, swap=True)
    sw_err = max(PF.track_error(sw[a], tgt[a], hip[a])["neck"]["mean_px"] for a in tgt)
    sw_lay = CS.layout_agreement(sw, tgt)
    check("the SWAPPED null is hundreds of pixels wrong", sw_err > 100,
          "%.1f px" % sw_err)
    check("and gets the left/right order EXACTLY backwards",
          sw_lay["order_agreement"] < 1e-12,
          "%.4f" % sw_lay["order_agreement"])

    # ---- null (ii) frozen ------------------------------------------------
    ft, fh = PF.freeze_frame0(tgt), PF.freeze_frame0(hip)
    fr, _ = PF.assign_by_projection(frames, ft)
    fr_err = max(PF.track_error(fr[a], ft[a], fh[a])["neck"]["mean_px"] for a in tgt)
    check("the FROZEN-frame-0 null is hundreds of pixels wrong", fr_err > 100,
          "%.1f px" % fr_err)

    # ---- null (iii) cross-camera: THE one that must fail -----------------
    ot = PF.targets_from_cam(CS.CAMJSON[2], 2, frames=n)
    oh = PF.targets_from_cam(CS.CAMJSON[2], 2, frames=n, joint="hip")
    cc, _ = PF.assign_by_projection(frames, ot)
    cc_err = max(PF.track_error(cc[a], ot[a], oh[a])["neck"]["mean_px"] for a in tgt)
    cc_lay = CS.layout_agreement(cc, ot)
    check("the CROSS-CAMERA null FAILS on position", cc_err > 100, "%.1f px" % cc_err)
    check("the CROSS-CAMERA null FAILS on order too",
          cc_lay["order_agreement"] < 0.9, "%.3f" % cc_lay["order_agreement"])
    check("so the metric is seeing the camera, not just 'a person is roughly there'",
          cc_err > 100 * max(worst_real, 1e-3) and cc_lay["order_agreement"] < 0.9,
          "real %.3g px / order 1.000  vs  cross-camera %.1f px / order %.3f"
          % (worst_real, cc_err, cc_lay["order_agreement"]))

    # ---- the identity crop path -----------------------------------------
    boxes = CS.actor_boxes(CS.CAMJSON[cam], cam, "A", n=n)
    have = sum(1 for b in boxes if b is not None)
    check("per-actor crop boxes are built for every frame the actor is in shot",
          have == real["actors"]["A"]["assignment"]["visible_frames"],
          "%d boxes, %d visible frames" % (have, real["actors"]["A"]["assignment"]["visible_frames"]))

    print()
    if FAILED:
        print("FAILED: %s" % ", ".join(FAILED))
        return 1
    print("all consistency_score assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
