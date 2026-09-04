#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""pose_follow.py - does the render follow the pose, and WHICH PERSON is which?

This is the scratchpad's follow.py brought into the repo with the bug that made
it unusable for more than one actor fixed, and with the fix made checkable.

WHAT follow.py DID, AND WHY IT COULD NOT BE REUSED
--------------------------------------------------
Its load() read a SavePoseKpsAsJsonFile dump and, per frame, kept exactly one
person: the one with the largest keypoint bounding box.

    best, barea = None, -1.0
    for p in ppl: ... if area > barea: barea, best = area, (k, v)

For a one-figure clip that is right, and it is what the dance-transfer
measurement needed. For a two-figure clip it is silently, catastrophically
wrong, and in a way no number in the output would show:

  - "largest box" is a proxy for "nearest the camera", so on a clip where a
    walking figure passes a standing one the kept person SWAPS mid-shot, at no
    particular frame, with no marker. Half a track belongs to one actor and half
    to the other, and the mean error over that track is a number about nothing.
  - It reports one track for a scene with two people, so a missing actor - the
    exact failure a consistency experiment exists to detect - reads as a
    perfectly good clip.
  - There was no detection RATE at all, so a run where DWPose found nobody on a
    third of the frames scored the same as one where it found everybody, because
    undetected frames are simply absent from the mean.

WHAT THIS DOES INSTEAD
----------------------
load_people() keeps EVERY person on every frame. assign_by_projection() then
attaches them to named actors by nearest PROJECTED NECK - the pixel the analytic
ground truth says that actor's neck is at on that frame - as a one-to-one
assignment, so two actors can never both claim the same detection.

The assignment is one-to-one and OPTIMAL, not greedy per actor. Greedy would let
the first actor considered take a detection the second one needed, which on the
frames where the two figures are closest together - the frames that decide
everything - is precisely when it goes wrong.

DETECTION IS REPORTED, ALWAYS, AS THREE SEPARATE NUMBERS
--------------------------------------------------------
They mean different things and collapsing them hides which one failed:

  frames_with_any     frames where DWPose found at least one person at all.
  actor_visible       frames where the GROUND TRUTH says that actor's neck and
                      hip project inside the frame. An actor the camera is not
                      pointing at is not a miss.
  actor_assigned      frames where that actor got a detection. The rate that
                      matters is assigned / visible; assigned / total punishes a
                      render for the framing of the shot it was given.

THE NULL THIS FILE OWNS
-----------------------
assign_by_projection(..., swap=True) assigns each actor to the OTHER actor's
projected neck. Everything else is identical. A metric that cannot tell the two
apart returns the same error either way, and the swapped number is printed
beside the real one every time rather than on request.
"""
import json
import sys
from itertools import permutations

import numpy as np

COCO18 = ["nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow",
          "l_wrist", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle",
          "r_eye", "l_eye", "r_ear", "l_ear"]
NECK, R_SHO, L_SHO, R_HIP, L_HIP = 1, 2, 5, 8, 11
W, H = 1280.0, 704.0


# ---------------------------------------------------------------- loading
def load_people(path, width=W, height=H):
    """-> (frames, meta).

    frames[t] is a LIST of people, each {xy: (18,2) float, ok: (18,) bool}.
    Every person is kept; nothing is chosen here, because choosing without the
    ground truth in hand is what the old load() did wrong.

    SavePoseKpsAsJsonFile writes NORMALISED keypoints (0..1 of the frame) with a
    per-frame canvas_width/canvas_height alongside. Both conventions appear in
    the wild depending on the node version, so the scale is DETECTED rather than
    assumed: if every finite coordinate is <= 1.5 the dump is normalised and is
    multiplied up by the canvas size. Getting this wrong is a silent 1280x error
    that still produces a plausible-looking skeleton.
    """
    d = json.load(open(path, encoding="utf-8"))
    if isinstance(d, dict):
        d = d.get("frames") or d.get("animations") or [d]
    raw = []
    for fr in d:
        cw = float(fr.get("canvas_width") or width)
        ch = float(fr.get("canvas_height") or height)
        ppl = []
        for p in (fr.get("people") or []):
            k = np.asarray(p.get("pose_keypoints_2d") or [], np.float64)
            if k.size < 54:
                continue
            k = k[:54].reshape(18, 3)
            ok = (k[:, 2] > 0) & ~((k[:, 0] == 0) & (k[:, 1] == 0))
            ppl.append({"xy": k[:, :2].copy(), "ok": ok, "cw": cw, "ch": ch})
        raw.append(ppl)

    vals = np.concatenate([p["xy"][p["ok"]].ravel() for fr in raw for p in fr]
                          or [np.zeros(0)])
    normalised = bool(vals.size and np.nanmax(np.abs(vals)) <= 1.5)
    if normalised:
        for fr in raw:
            for p in fr:
                p["xy"][:, 0] *= p["cw"]
                p["xy"][:, 1] *= p["ch"]

    counts = np.array([len(fr) for fr in raw], int)
    meta = {
        "path": path,
        "frames": len(raw),
        "coordinates": "normalised-0..1, scaled up by canvas size" if normalised
                       else "already in pixels",
        "people_per_frame_min": int(counts.min()) if counts.size else 0,
        "people_per_frame_max": int(counts.max()) if counts.size else 0,
        "people_per_frame_mean": float(counts.mean()) if counts.size else 0.0,
        "frames_with_any_person": int((counts > 0).sum()),
        "detection_rate": float((counts > 0).mean()) if counts.size else 0.0,
        "people_histogram": {str(n): int((counts == n).sum())
                             for n in range(0, int(counts.max()) + 1)} if counts.size else {},
    }
    return raw, meta


def pick_largest(frames):
    """follow.py's ORIGINAL one-person-per-frame rule, kept so the difference can
    be measured rather than argued. It is the right rule for a single-figure clip
    and the wrong one for this experiment; pose_follow_test.py drives a synthetic
    crossing through both and shows this one swapping tracks."""
    out = []
    for ppl in frames:
        best, barea = None, -1.0
        for p in ppl:
            v = p["ok"]
            if v.sum() < 2:
                continue
            pts = p["xy"][v]
            area = float((pts[:, 0].max() - pts[:, 0].min())
                         * (pts[:, 1].max() - pts[:, 1].min()))
            if area > barea:
                barea, best = area, p
        out.append(best)
    return out


# ---------------------------------------------------------------- anchors
def person_anchor(p):
    """The one pixel a person is AT, for matching against a projected neck.

    Neck when DWPose gave one; the shoulder midpoint when it did not (the neck in
    COCO-18 is itself derived from the shoulders, so this is the same point by
    another route rather than a different one); the centroid of whatever is left
    as the last resort. Returns None only for a person with nothing detected."""
    xy, ok = p["xy"], p["ok"]
    if ok[NECK]:
        return xy[NECK].copy()
    if ok[R_SHO] and ok[L_SHO]:
        return 0.5 * (xy[R_SHO] + xy[L_SHO])
    if ok.any():
        return xy[ok].mean(axis=0)
    return None


def mid_hip(p):
    """Mid-hip in pixels, or None. The ground truth's hip is a single point on the
    body centreline, so one detected hip alone is NOT used as a stand-in for it -
    that would be a systematic half-pelvis-width bias that looks like error."""
    xy, ok = p["xy"], p["ok"]
    if ok[R_HIP] and ok[L_HIP]:
        return 0.5 * (xy[R_HIP] + xy[L_HIP])
    return None


# ---------------------------------------------------------------- assignment
def assign_by_projection(frames, targets, swap=False, gate_px=None):
    """Attach detections to named actors, one-to-one, by nearest projected neck.

    frames    from load_people()
    targets   {actor_id: (F, 2) array of projected NECK pixels, NaN where the
              actor is not in frame}
    swap      the NULL: actor X is matched against actor Y's projection and vice
              versa. Two actors exactly.
    gate_px   optional hard cap on an accepted match distance. Off by default:
              the honest failure of an assignment is a big error, and silently
              dropping the matches that would have shown it is how a metric ends
              up reporting only its successes.

    Returns {actor: {xy (F,18,2), ok (F,18), matched (F,) bool, dist (F,)}} and a
    stats dict.
    """
    ids = list(targets.keys())
    if swap:
        if len(ids) != 2:
            raise ValueError("the swapped null is defined for exactly two actors, got %d" % len(ids))
        targets = {ids[0]: targets[ids[1]], ids[1]: targets[ids[0]]}

    F = len(frames)
    out = {a: {"xy": np.zeros((F, 18, 2)), "ok": np.zeros((F, 18), bool),
               "matched": np.zeros(F, bool), "dist": np.full(F, np.nan)} for a in ids}

    for t in range(F):
        want = [a for a in ids if np.isfinite(targets[a][t]).all()]
        ppl = [p for p in frames[t] if person_anchor(p) is not None]
        if not want or not ppl:
            continue
        anchors = np.array([person_anchor(p) for p in ppl])
        cost = np.array([[float(np.linalg.norm(anchors[j] - targets[a][t]))
                          for j in range(len(ppl))] for a in want])

        # Optimal one-to-one over min(len(want), len(ppl)) pairs. Both sides are
        # tiny here (2 actors, DWPose rarely returns more than a handful), so an
        # exhaustive search is exact and costs nothing; scipy is not a dependency
        # of this repo and adding one for a 2x2 assignment would be silly.
        k = min(len(want), len(ppl))
        best, bestcost = None, np.inf
        cols = range(len(ppl))
        for rows in permutations(range(len(want)), k):
            for cs in permutations(cols, k):
                c = sum(cost[r, j] for r, j in zip(rows, cs))
                if c < bestcost:
                    bestcost, best = c, list(zip(rows, cs))
        for r, j in best:
            a = want[r]
            if gate_px is not None and cost[r, j] > gate_px:
                continue
            out[a]["xy"][t] = ppl[j]["xy"]
            out[a]["ok"][t] = ppl[j]["ok"]
            out[a]["matched"][t] = True
            out[a]["dist"][t] = cost[r, j]

    stats = {}
    for a in ids:
        vis = np.isfinite(np.stack([targets[a][:, 0], targets[a][:, 1]], 1)).all(1)
        m = out[a]["matched"]
        stats[a] = {
            "frames": F,
            "visible_frames": int(vis.sum()),
            "assigned_frames": int(m.sum()),
            "assigned_of_visible": float(m[vis].mean()) if vis.any() else float("nan"),
            "assigned_of_all": float(m.mean()),
            "match_dist_px_median": float(np.nanmedian(out[a]["dist"])) if m.any() else float("nan"),
        }
    return out, stats


# ---------------------------------------------------------------- errors
def track_error(track, target_neck, target_hip):
    """Mean pixel error of the DETECTED neck and mid-hip against the PROJECTED
    ones, over the frames where both sides exist. Returns per-joint dicts plus
    the count each was measured on, because a 4-pixel mean over 3 frames and one
    over 100 are not the same claim and a bare mean cannot tell them apart."""
    F = len(target_neck)
    res = {}
    for name, joint_getter, tgt in (("neck", lambda i: track["xy"][i, NECK]
                                     if track["ok"][i, NECK] else None, target_neck),
                                    ("hip", lambda i: _midhip_row(track, i), target_hip)):
        errs = []
        for i in range(F):
            if not track["matched"][i] or not np.isfinite(tgt[i]).all():
                continue
            p = joint_getter(i)
            if p is None:
                continue
            errs.append(float(np.linalg.norm(p - tgt[i])))
        errs = np.array(errs)
        res[name] = {
            "n": int(errs.size),
            "mean_px": float(errs.mean()) if errs.size else float("nan"),
            "median_px": float(np.median(errs)) if errs.size else float("nan"),
            "p90_px": float(np.percentile(errs, 90)) if errs.size else float("nan"),
            "mean_norm": float((errs / np.hypot(W, H)).mean()) if errs.size else float("nan"),
        }
    return res


def _midhip_row(track, i):
    ok, xy = track["ok"][i], track["xy"][i]
    if ok[R_HIP] and ok[L_HIP]:
        return 0.5 * (xy[R_HIP] + xy[L_HIP])
    return None


# ---------------------------------------------------------------- ground truth
def targets_from_cam(camjson, camera, frames=None, joint="neck"):
    """{actor: (F,2)} projected pixels, NaN on frames where the actor is not in
    frame. Read straight out of gate_block.py's camera json, which carries the
    projections of BOTH cameras whatever it rendered - so the cross-camera null
    (score clip 1 against camera 2's projection) needs no second file."""
    d = json.load(open(camjson, encoding="utf-8")) if isinstance(camjson, str) else camjson
    tracks = d["actor_tracks"]["cam%d" % camera]
    out = {}
    for actor, rows in tracks.items():
        n = len(rows) if frames is None else min(frames, len(rows))
        a = np.full((n, 2), np.nan)
        for i in range(n):
            r = rows[i]
            uv = r.get(joint + "_uv")
            if uv is not None and r.get(joint + "_in_frame"):
                a[i] = uv
        out[actor] = a
    return out


def freeze_frame0(targets):
    """The NULL that says the projection carries no time information: every frame
    gets frame 0's pixel. A metric that scores this as well as the real track is
    measuring 'a person is roughly there', not 'a person is where the camera says'."""
    return {a: np.repeat(v[:1], len(v), axis=0).copy() for a, v in targets.items()}


# ---------------------------------------------------------------- follow.py's own
def norm(xy, width=W, height=H):
    n = np.asarray(xy, float).copy()
    n[..., 0] /= width
    n[..., 1] /= height
    return n


def pearson(a, b):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    if a.size < 3:
        return float("nan")
    a = a - a.mean()
    b = b - b.mean()
    d = (np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b / d) if d > 1e-12 else float("nan")


def torso(xy, ok):
    """neck -> mid-hip length per frame; the scale signal a push-in writes."""
    F = xy.shape[0]
    s = np.full(F, np.nan)
    for t in range(F):
        if not ok[t, NECK]:
            continue
        hips = [h for h in (R_HIP, L_HIP) if ok[t, h]]
        if not hips:
            continue
        mid = xy[t, hips, :].mean(axis=0)
        s[t] = float(np.linalg.norm(xy[t, NECK] - mid))
    return s


# ---------------------------------------------------------------- CLI
def main():
    if len(sys.argv) < 4:
        print(__doc__)
        print("usage: pose_follow.py <keypoints.json> <gate_block_*_cam.json> <camera 1|2> "
              "[out.json]")
        return 2
    kps, camjson, camera = sys.argv[1], sys.argv[2], int(sys.argv[3])
    frames, meta = load_people(kps)
    targets = targets_from_cam(camjson, camera, frames=len(frames))
    real, rstats = assign_by_projection(frames, targets)
    swapped, sstats = assign_by_projection(frames, targets, swap=True)
    frozen, fstats = assign_by_projection(frames, freeze_frame0(targets))
    hips = targets_from_cam(camjson, camera, frames=len(frames), joint="hip")

    print("keypoints : %s" % kps)
    print("frames    : %d   coordinates %s" % (meta["frames"], meta["coordinates"]))
    print("detection : %d/%d frames have a person (%.1f%%); people per frame %d..%d, mean %.2f"
          % (meta["frames_with_any_person"], meta["frames"], 100 * meta["detection_rate"],
             meta["people_per_frame_min"], meta["people_per_frame_max"],
             meta["people_per_frame_mean"]))
    print("            histogram %r" % (meta["people_histogram"],))
    print()
    hdr = ("%-6s %-9s %6s %8s %9s %9s %9s" %
           ("actor", "variant", "vis", "assigned", "neck n", "neck px", "hip px"))
    print(hdr)
    print("-" * len(hdr))
    rows = {}
    for label, tr, st in (("real", real, rstats), ("SWAPPED", swapped, sstats),
                          ("frozen f0", frozen, fstats)):
        for a in sorted(tr):
            e = track_error(tr[a], targets[a], hips[a])
            rows.setdefault(a, {})[label] = {"stats": st[a], "error": e}
            print("%-6s %-9s %6d %8d %9d %9.2f %9.2f"
                  % (a, label, st[a]["visible_frames"], st[a]["assigned_frames"],
                     e["neck"]["n"], e["neck"]["mean_px"], e["hip"]["mean_px"]))
    if len(sys.argv) > 4:
        json.dump({"meta": meta, "camera": camera, "actors": rows},
                  open(sys.argv[4], "w"), indent=1, default=float)
        print("\nwrote %s" % sys.argv[4])
    return 0


if __name__ == "__main__":
    sys.exit(main())
