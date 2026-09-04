#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""pose_follow_test.py - the crossing that broke follow.py, as a test.

Nothing here touches the GPU, the engine or any rendered clip. It builds a
synthetic two-person SavePoseKpsAsJsonFile dump in which the two people CROSS in
screen x and one of them is nearer the camera for the second half - which is
exactly the situation the corridor clip creates - and asserts:

  1. follow.py's original "largest box wins" rule SWAPS tracks at the crossing.
     Asserted as a failure, so the fix cannot quietly be reverted to something
     that only looks equivalent.
  2. assign_by_projection() does not, because it matches against where the
     ground truth says each neck is.
  3. The assignment is one-to-one: two actors never share a detection, even on
     the frame where they are closest.
  4. The SWAPPED null is much worse than the real assignment. A metric where it
     is not cannot tell the two actors apart and is measuring nothing.
  5. Detection rate is reported, and reports the frames where DWPose found
     nobody rather than dropping them.
  6. Normalised (0..1) keypoints are detected and scaled by the canvas, and a
     dump already in pixels is left alone.

Run: D:\\AI\\aiplay-studio-bench\\venv\\Scripts\\python.exe scripts/pose_follow_test.py
"""
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pose_follow as PF   # noqa: E402

F = 40
W, H = 1280.0, 704.0
FAILED = []


def check(name, cond, detail=""):
    print("  %-4s %s%s" % ("ok" if cond else "FAIL", name, ("   " + detail) if detail else ""))
    if not cond:
        FAILED.append(name)


def person(neck_uv, scale, missing=()):
    """An 18-joint COCO person around `neck_uv`, `scale` px tall. `scale` is what
    makes one of them the 'largest box' - it stands in for being nearer."""
    u, v = neck_uv
    xy = np.zeros((18, 3))
    lay = {PF.NECK: (0.0, 0.0), 0: (0.0, -0.35), PF.R_SHO: (-0.22, 0.02),
           PF.L_SHO: (0.22, 0.02), 3: (-0.30, 0.30), 6: (0.30, 0.30),
           4: (-0.32, 0.55), 7: (0.32, 0.55), PF.R_HIP: (-0.14, 0.95),
           PF.L_HIP: (0.14, 0.95), 9: (-0.15, 1.45), 12: (0.15, 1.45),
           10: (-0.15, 1.95), 13: (0.15, 1.95), 14: (-0.06, -0.40),
           15: (0.06, -0.40), 16: (-0.12, -0.38), 17: (0.12, -0.38)}
    for j, (dx, dy) in lay.items():
        if j in missing:
            continue
        xy[j] = (u + dx * scale, v + dy * scale, 1.0)
    return {"pose_keypoints_2d": [float(x) for x in xy.ravel()]}


def build():
    """A crosses left-to-right, B right-to-left. B is 1.6x bigger for the second
    half - so 'largest box' follows B there and A before, which is the swap.
    Frames 12 and 13 have nobody at all: a real DWPose miss."""
    frames, tgt_a, tgt_b, hip_a, hip_b = [], [], [], [], []
    for t in range(F):
        s = t / (F - 1.0)
        ua, ub = 360.0 + 520.0 * s, 880.0 - 520.0 * s
        va = vb = 300.0
        # A grows as it approaches, B shrinks as it recedes, and they swap size
        # at the same moment they cross in x. That is the corridor's own
        # situation, and it is what makes "largest box" pick the wrong person for
        # exactly half the clip.
        sa, sb = 200.0 + 130.0 * s, 330.0 - 130.0 * s
        tgt_a.append((ua, va))
        tgt_b.append((ub, vb))
        # the mid-hip target follows from the layout above: both hips sit
        # 0.95*scale below the neck, so the midpoint is directly under it.
        hip_a.append((ua, va + 0.95 * sa))
        hip_b.append((ub, vb + 0.95 * sb))
        if t in (12, 13):
            frames.append({"people": [], "canvas_width": W, "canvas_height": H})
            continue
        frames.append({"people": [person((ua, va), sa), person((ub, vb), sb)],
                       "canvas_width": W, "canvas_height": H})
    return (frames, np.array(tgt_a), np.array(tgt_b),
            np.array(hip_a), np.array(hip_b))


def write(frames, path, normalised=False):
    d = json.loads(json.dumps(frames))
    if normalised:
        for fr in d:
            for p in fr["people"]:
                k = np.array(p["pose_keypoints_2d"]).reshape(18, 3)
                k[:, 0] /= W
                k[:, 1] /= H
                p["pose_keypoints_2d"] = [float(x) for x in k.ravel()]
    json.dump(d, open(path, "w"))
    return path


def main():
    tmp = tempfile.mkdtemp(prefix="pose_follow_test_")
    frames, ta, tb, ha, hb = build()
    px = write(frames, os.path.join(tmp, "px.json"))
    nm = write(frames, os.path.join(tmp, "norm.json"), normalised=True)

    print("pose_follow_test - a two-person crossing, 40 frames, 2 with no detection")
    print()

    # ---- 6. coordinate convention -------------------------------------
    fp, meta_p = PF.load_people(px)
    fn, meta_n = PF.load_people(nm)
    check("pixel dump is read as pixels", "already in pixels" in meta_p["coordinates"])
    check("normalised dump is detected and scaled", "normalised" in meta_n["coordinates"])
    a_px = PF.person_anchor(fp[0][0])
    a_nm = PF.person_anchor(fn[0][0])
    check("both conventions land on the same pixel",
          float(np.abs(a_px - a_nm).max()) < 1e-6,
          "max |diff| = %.3g px" % float(np.abs(a_px - a_nm).max()))

    # ---- 5. detection rate --------------------------------------------
    check("detection rate counts the empty frames",
          meta_p["frames"] == F and meta_p["frames_with_any_person"] == F - 2,
          "%d/%d" % (meta_p["frames_with_any_person"], meta_p["frames"]))
    check("people-per-frame histogram is reported",
          meta_p["people_histogram"].get("0") == 2 and meta_p["people_histogram"].get("2") == F - 2,
          repr(meta_p["people_histogram"]))

    targets = {"A": ta, "B": tb}
    hips = {"A": ha, "B": hb}

    # ---- 1. the old rule swaps ----------------------------------------
    largest = PF.pick_largest(fp)
    follows_a = 0
    for t in range(F):
        p = largest[t]
        if p is None:
            continue
        an = PF.person_anchor(p)
        follows_a += int(np.linalg.norm(an - ta[t]) < np.linalg.norm(an - tb[t]))
    check("follow.py's largest-box rule SWAPS tracks at the crossing",
          0.25 * (F - 2) < follows_a < 0.75 * (F - 2),
          "it followed actor A on %d of the %d detected frames and B on the other %d "
          "- one track, two people" % (follows_a, F - 2, F - 2 - follows_a))

    # ---- 2. the fix does not ------------------------------------------
    real, rstats = PF.assign_by_projection(fp, targets)
    ea = PF.track_error(real["A"], targets["A"], hips["A"])
    eb = PF.track_error(real["B"], targets["B"], hips["B"])
    check("A is tracked on every frame it is visible and detected",
          rstats["A"]["assigned_frames"] == F - 2,
          "%d of %d" % (rstats["A"]["assigned_frames"], F - 2))
    check("A's neck lands on A's projection",
          ea["neck"]["mean_px"] < 1e-6, "%.4g px over %d frames"
          % (ea["neck"]["mean_px"], ea["neck"]["n"]))
    check("B's neck lands on B's projection",
          eb["neck"]["mean_px"] < 1e-6, "%.4g px over %d frames"
          % (eb["neck"]["mean_px"], eb["neck"]["n"]))
    check("the hip is measured from the DETECTED mid-hip, not one side",
          ea["hip"]["n"] == F - 2 and ea["hip"]["mean_px"] < 1e-6,
          "%.4g px over %d frames" % (ea["hip"]["mean_px"], ea["hip"]["n"]))

    # ---- 3. one-to-one -------------------------------------------------
    shared = 0
    for t in range(F):
        if real["A"]["matched"][t] and real["B"]["matched"][t]:
            if np.allclose(real["A"]["xy"][t], real["B"]["xy"][t]):
                shared += 1
    check("no frame gives both actors the same detection", shared == 0,
          "%d shared frames" % shared)

    # the crossing frame is where a greedy assignment would go wrong
    seps = [np.linalg.norm(ta[t] - tb[t]) for t in range(F)]
    tc = int(np.argmin(seps))
    check("the two are genuinely close at the crossing", seps[tc] < 40,
          "min separation %.1f px at frame %d" % (seps[tc], tc))

    # ---- 4. the swapped null -------------------------------------------
    sw, _ = PF.assign_by_projection(fp, targets, swap=True)
    sa = PF.track_error(sw["A"], targets["A"], hips["A"])
    check("the SWAPPED null is far worse than the real assignment",
          sa["neck"]["mean_px"] > 50 * max(ea["neck"]["mean_px"], 1e-3),
          "swapped %.1f px vs real %.4g px" % (sa["neck"]["mean_px"], ea["neck"]["mean_px"]))

    # ---- frozen-frame-0 null -------------------------------------------
    fr, _ = PF.assign_by_projection(fp, PF.freeze_frame0(targets))
    fa = PF.track_error(fr["A"], targets["A"], hips["A"])
    check("the frozen-frame-0 null is far worse than the real assignment",
          fa["neck"]["mean_px"] > 50 * max(ea["neck"]["mean_px"], 1e-3),
          "frozen %.1f px vs real %.4g px" % (fa["neck"]["mean_px"], ea["neck"]["mean_px"]))

    # ---- an actor the camera cannot see is not a miss --------------------
    t2 = {"A": ta.copy(), "B": tb.copy()}
    t2["A"][20:] = np.nan
    _, st2 = PF.assign_by_projection(fp, t2)
    check("an out-of-frame actor is excluded from its own rate, not counted as missed",
          st2["A"]["visible_frames"] == 20
          and abs(st2["A"]["assigned_of_visible"] - (18 / 20.0)) < 1e-9,
          "visible %d, assigned/visible %.3f"
          % (st2["A"]["visible_frames"], st2["A"]["assigned_of_visible"]))

    print()
    if FAILED:
        print("FAILED: %s" % ", ".join(FAILED))
        return 1
    print("all pose_follow assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
