#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""consistency_score.py - do two shots of the same action agree about the people?

The camera gate asked whether ONE clip follows a blocked camera move. This asks
the question a gate cannot: given the SAME two actors doing the SAME thing, shot
from two different cameras and rendered twice from the same one, does the render
put them in the same places?

Everything scored here is measured against an ANALYTIC ground truth. gate_block.py
knows, in world metres, where each actor's neck and hip are on every frame, and it
writes the pixel each one projects to under BOTH cameras. Nothing on the reference
side of any number below is estimated.

WHAT IS MEASURED, PER CLIP AND PER ACTOR
----------------------------------------
  position      mean pixel error of the DETECTED neck and mid-hip against the
                PROJECTED ones. The absolute number here is not the interesting
                part - a generative render is not a renderer and will not land on
                the pixel - the nulls beside it are.
  layout        the B-minus-A vector in normalised frame coordinates (u/1280,
                v/704) against the projected vector, per frame. This is the shape
                of the scene rather than the position of one body, and it is what
                survives a render that draws everyone slightly to the left.
  order         the left/right ORDER agreement rate: the fraction of frames where
                sign(u_B - u_A) matches the ground truth's sign. This is the
                cheapest question in the file and the one an editor actually
                asks: are the two people on the correct sides of the screen?
  take drift    the same actor's detected neck between two renders of the SAME
                control clip on two seeds. Nothing about the conditioning differs,
                so whatever this is, is the model's own variance.

THE THREE NULLS, EACH PRINTED BESIDE THE NUMBER IT NULLIFIES
------------------------------------------------------------
  (i)   SWAPPED       actor A is scored against B's projection and vice versa. A
                      metric that returns the same error either way cannot tell
                      two people apart, and every per-actor number above it is
                      then about "a person", not about that person.
  (ii)  FROZEN f0     the projection is replaced by its own frame 0, held for the
                      whole clip. This is what "the actors are roughly where you
                      would guess" scores. Position and layout must both beat it.
  (iii) CROSS-CAMERA  the camera-1 render scored against camera 2's projection.
                      THIS ONE MUST FAIL. It is not a null about the render; it is
                      a null about the INSTRUMENT. If scoring a clip against the
                      wrong camera's ground truth comes out fine, the metric is
                      not seeing the camera, and every other number in this file
                      is measuring something other than what it claims.

A NUMBER THIS FILE WILL NOT PRODUCE
-----------------------------------
There is no aggregate "consistency score". Position, layout and order fail
differently and for different reasons, and one number that mixes them would let a
render with the actors on the wrong sides of the frame pass on the strength of a
good mean pixel error. They are reported separately, with their nulls, and the
reading is left to a person.

Run: D:\\AI\\aiplay-studio-bench\\venv\\Scripts\\python.exe scripts/consistency_score.py
"""
import glob
import hashlib
import json
import os
import sys

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pose_follow as PF          # noqa: E402
import identity_band as IB        # noqa: E402

OUTROOT = r"D:\AI\aiplay-studio-bench\ComfyUI\output"
OUT = os.path.join(OUTROOT, "consistency")
GATE = os.path.join(OUTROOT, "gate")
REPORT = os.path.join(OUT, "report.json")


def _argval(name, default=None):
    a = sys.argv[1:]
    if name in a and a.index(name) + 1 < len(a):
        return a[a.index(name) + 1]
    return default


# --subdir s050    score a STRENGTH SWEEP arm instead of the 1.00 pass.
#
# The sweep renders into consistency/<tag>/<clip>/ so that its arms can never be
# mistaken for - or resumed from - the strength-1.00 run this file was written
# against. Everything else about the scoring is identical, deliberately: same
# ground truth, same three nulls, same detector-free fallback. Only the folder
# this file reads and the report it writes move.
_SUBDIR = _argval("--subdir")
if _SUBDIR:
    OUT = os.path.join(OUTROOT, "consistency", _SUBDIR)
    REPORT = os.path.join(OUT, "report.json")

# --always-localise    run the detector-free localisation for every clip, not
# only for clips where DWPose found nobody. On the 1.00 pass that block was a
# fallback for an empty pose result. On a sweep it is a MEASUREMENT IN ITS OWN
# RIGHT - "does the object stay where the ground truth says as the strength
# drops" is half the question the sweep exists to answer, and a block that
# switches itself off the moment a person is detected cannot answer it.
ALWAYS_LOCALISE = "--always-localise" in sys.argv[1:]

W, H = 1280.0, 704.0
FRAMES = 121                      # the conditioning window; the renders are 121 long

CLIPS = {
    "C1S1": {"camera": 1, "seed": 70117, "control": "gate_block_f2c1.mp4"},
    "C2S1": {"camera": 2, "seed": 70117, "control": "gate_block_f2c2.mp4"},
    "C1S2": {"camera": 1, "seed": 31337, "control": "gate_block_f2c1.mp4"},
}
CAMJSON = {1: os.path.join(GATE, "gate_block_f2c1_cam.json"),
           2: os.path.join(GATE, "gate_block_f2c2_cam.json")}

# The identity foil pool. Seven single-figure character sheets from unrelated
# projects on this rig, windowed by exactly the same rule as everything else. They
# are foils, not references: nothing in this experiment was conditioned on any of
# them, so a corridor actor that beats them has beaten "some other character",
# which is the weakest useful claim and the only one this pool can support.
MV = os.path.join(OUTROOT, "mv")
FOIL_SHEETS = {
    "sheet_night_train": os.path.join(MV, r"night-train-girl\assets\char_4cf6a2160fb1.png"),
    "sheet_sub_rosa": os.path.join(MV, r"sub-rosa\assets\char_836dad3c60e5.png"),
    "sheet_spoken": os.path.join(MV, r"spoken-mv\assets\char_1bb16bef430f.png"),
    "sheet_glass_neon": os.path.join(MV, r"glass-and-neon-mv\assets\char_567658bbd820.png"),
    "sheet_bone_waffle": os.path.join(MV, r"bone-waffle-cgi\assets\char_151910b166a8.png"),
    "sheet_salt_static": os.path.join(MV, r"salt-and-static\assets\char_56ef717c8590.png"),
    "sheet_hands_up": os.path.join(MV, r"hands-up-horizon\assets\char_5ba1b3ec8599.png"),
}


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def find_render(cid):
    c = [p for p in sorted(glob.glob(os.path.join(OUT, cid, "*.mp4"))) if "_skel" not in p]
    return c[0] if c else None


def find_pose(cid):
    c = sorted(glob.glob(os.path.join(OUT, cid, "*.json")))
    return c[0] if c else None


def nanmean(a):
    a = np.asarray([x for x in a if np.isfinite(x)], float)
    return float(a.mean()) if a.size else float("nan")


# ------------------------------------------------------------------ layout
def layout_agreement(real, targets, ids=("A", "B")):
    """The B-minus-A vector, detected against projected, in NORMALISED frame
    coordinates - u by 1280 and v by 704, so the number is a fraction of the frame
    and does not change meaning if the size ever does.

    Reported: the mean length of the difference, the mean angle between the two
    vectors, and the ORDER agreement rate (sign of the u component). Order is
    separated out on purpose: a layout error of 0.05 that keeps both people on
    their correct sides and one that swaps them are the same number and are not
    the same failure."""
    a, b = ids
    d_err, angles, sgn_ok, n = [], [], 0, 0
    d_norm, p_norm = [], []
    for t in range(len(targets[a])):
        if not (real[a]["matched"][t] and real[b]["matched"][t]):
            continue
        pa, pb = targets[a][t], targets[b][t]
        if not (np.isfinite(pa).all() and np.isfinite(pb).all()):
            continue
        da = PF.person_anchor({"xy": real[a]["xy"][t], "ok": real[a]["ok"][t]})
        db = PF.person_anchor({"xy": real[b]["xy"][t], "ok": real[b]["ok"][t]})
        if da is None or db is None:
            continue
        dv = np.array([(db[0] - da[0]) / W, (db[1] - da[1]) / H])
        pv = np.array([(pb[0] - pa[0]) / W, (pb[1] - pa[1]) / H])
        d_norm.append(dv)
        p_norm.append(pv)
        d_err.append(float(np.linalg.norm(dv - pv)))
        nd, npv = np.linalg.norm(dv), np.linalg.norm(pv)
        if nd > 1e-9 and npv > 1e-9:
            angles.append(float(np.degrees(np.arccos(
                np.clip(float(dv @ pv) / (nd * npv), -1.0, 1.0)))))
        sgn_ok += int(np.sign(dv[0]) == np.sign(pv[0]))
        n += 1
    d_norm = np.array(d_norm) if d_norm else np.zeros((0, 2))
    p_norm = np.array(p_norm) if p_norm else np.zeros((0, 2))

    # THE ORDER METRIC NEEDS ITS OWN BASELINE, and on camera 2 it needs it badly.
    # The ground truth's sign of (u_B - u_A) flips ONCE on the orbit camera and
    # NEVER on the static side camera. So on camera 2 a render that simply always
    # put B on the same side would score 1.000 without having followed anything,
    # and quoting that number next to camera 1's would compare a hard question to
    # a free one. `order_baseline` is what the best CONSTANT guess scores against
    # this same ground truth on these same frames; `order_lift` is what the render
    # earned above it, and on camera 2 the honest reading of a lift of 0 is "this
    # camera cannot ask the question", not "the render passed".
    if n:
        pos = float((p_norm[:, 0] > 0).mean())
        baseline = max(pos, 1.0 - pos)
        gt_flips = int(sum(1 for i in range(1, n)
                           if (p_norm[i, 0] > 0) != (p_norm[i - 1, 0] > 0)))
    else:
        baseline, gt_flips = float("nan"), 0
    return {
        "pairs": n,
        "order_baseline_constant_guess": baseline,
        "order_lift_over_baseline": ((sgn_ok / n) - baseline) if n else float("nan"),
        "ground_truth_order_flips": gt_flips,
        "vector_err_norm_mean": nanmean(d_err),
        "vector_err_norm_median": float(np.median(d_err)) if d_err else float("nan"),
        "angle_deg_mean": nanmean(angles),
        "angle_deg_median": float(np.median(angles)) if angles else float("nan"),
        "order_agreement": (sgn_ok / n) if n else float("nan"),
        "order_agreed_frames": sgn_ok,
        "r_du": PF.pearson(d_norm[:, 0], p_norm[:, 0]) if n >= 5 else float("nan"),
        "r_dv": PF.pearson(d_norm[:, 1], p_norm[:, 1]) if n >= 5 else float("nan"),
        "mean_du_detected": float(d_norm[:, 0].mean()) if n else float("nan"),
        "mean_du_projected": float(p_norm[:, 0].mean()) if n else float("nan"),
    }


def score_one(frames, targets, hips):
    """Assign, then measure. Returns per-actor errors plus the layout block."""
    real, stats = PF.assign_by_projection(frames, targets)
    per = {}
    for a in targets:
        per[a] = {"assignment": stats[a],
                  "error": PF.track_error(real[a], targets[a], hips[a])}
    return {"actors": per, "layout": layout_agreement(real, targets)}, real


# ------------------------------------------------------------------ identity
def actor_boxes(camjson, camera, actor, n=FRAMES):
    """Per-frame crop boxes built from the PROJECTED neck and hip.

    From the ground truth, never from the detections. If the boxes came from
    DWPose then a clip where the pose assignment went wrong would also crop the
    wrong pixels, and the identity number would agree with the position number
    for a reason that has nothing to do with identity. This way the two measures
    fail independently."""
    d = json.load(open(camjson, encoding="utf-8"))
    rows = d["actor_tracks"]["cam%d" % camera][actor]
    out = []
    for i in range(min(n, len(rows))):
        r = rows[i]
        if not (r.get("neck_in_frame") and r.get("hip_in_frame")):
            out.append(None)
            continue
        out.append(IB.box_from_points(r["neck_uv"], r["hip_uv"]))
    return out


# ------------------------------------------------------------------ detector-free
def box_contrast(mp4, boxes, n=FRAMES, grow=1.9):
    """Is there a DISTINCT OBJECT where the ground truth says the actor is?

    ⚠ WHY THIS EXISTS, AND WHEN IT WAS ADDED. It was NOT in the design. It was
    added after the first render came back, because that render answered a
    different question from the one the pose metrics ask: WAN VACE at strength
    1.00 reproduced the gray-box blocking AS BOXES. The camera is right, the two
    actors are exactly where the projection says they are - and they are slabs,
    not people, so DWPose has nothing to detect and every pose number is empty.

    An empty pose number is a real result and it is reported as one. But "the
    render put an object exactly where the ground truth said" is still a
    measurable, falsifiable claim about cross-clip consistency, and it does not
    need a person detector. So:

        contrast = mean luma of a RING around the projected body box
                 - mean luma of the box itself,          in grey levels

    positive when the actor is darker than what surrounds it, which is what a
    dark coat (or a dark slab) in a lit corridor is.

    NOTHING HERE IS TUNED ON THE PIXELS. The box comes from
    identity_band.box_from_points, whose three constants were derived from the
    figure's own geometry before any render existed; the ring is that box grown
    by a fixed factor. And the number is worthless on its own - it is only ever
    read against the same measurement taken at the SWAPPED, FROZEN and
    CROSS-CAMERA box positions, which is what says the contrast is at the right
    place rather than everywhere.
    """
    cap = cv2.VideoCapture(mp4)
    vals, used, skipped = [], 0, 0
    i = 0
    while True:
        ok, f = cap.read()
        if not ok or i >= n:
            break
        b = boxes[i] if i < len(boxes) else None
        i += 1
        if b is None:
            skipped += 1
            continue
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32)
        cx, cy = 0.5 * (b[0] + b[2]), 0.5 * (b[1] + b[3])
        hw, hh = 0.5 * (b[2] - b[0]), 0.5 * (b[3] - b[1])
        big = (cx - grow * hw, cy - grow * hh, cx + grow * hw, cy + grow * hh)
        inner = IB.crop_box(g, b)
        outer = IB.crop_box(g, big)
        if inner is None or outer is None or outer.size <= inner.size:
            skipped += 1
            continue
        ring = (float(outer.sum()) - float(inner.sum())) / float(outer.size - inner.size)
        vals.append(ring - float(inner.mean()))
        used += 1
    cap.release()
    return {"frames_used": used, "frames_skipped": skipped,
            "contrast_mean": nanmean(vals),
            "contrast_median": float(np.median(vals)) if vals else float("nan"),
            "contrast_sd": float(np.std(vals)) if vals else float("nan")}


def read_gray(mp4, n=FRAMES):
    cap = cv2.VideoCapture(mp4)
    out = []
    while len(out) < n:
        ok, f = cap.read()
        if not ok:
            break
        out.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32))
    cap.release()
    return out


def take_drift_pixels(mp4_a, mp4_b, boxes_by_actor, n=FRAMES):
    """How far apart are two takes of the SAME shot, in grey levels?

    Same camera, same control clip, same prompt, same everything but the seed, so
    whatever this is, is the model's own variance. Measured over the whole frame
    and, separately, inside each actor's PROJECTED body box - because a model that
    repaints the corridor differently but puts the actors in the same place is a
    very different thing from one that moves the actors, and a whole-frame mean
    cannot tell them apart.

    THE YARDSTICK IS THE CLIP'S OWN TEMPORAL STEP: mean |I(t) - I(t+1)| within one
    take. It is the only scale in the problem that is not arbitrary. A take-to-take
    difference SMALLER than one frame of motion means the two takes agree more
    closely than consecutive frames of a single take differ - and a number in grey
    levels with nothing to compare it to would mean nothing at all."""
    A = read_gray(mp4_a, n)
    B = read_gray(mp4_b, n)
    m = min(len(A), len(B))
    if m < 2:
        return None

    def masked(im1, im2, box):
        if box is None:
            return None
        c1, c2 = IB.crop_box(im1, box), IB.crop_box(im2, box)
        if c1 is None or c2 is None or c1.shape != c2.shape:
            return None
        return float(np.abs(c1 - c2).mean())

    whole = [float(np.abs(A[t] - B[t]).mean()) for t in range(m)]
    temporal = [float(np.abs(A[t] - A[t + 1]).mean()) for t in range(m - 1)]
    out = {"frames": m,
           "whole_frame_mean_abs_diff": nanmean(whole),
           "whole_frame_median": float(np.median(whole)),
           "temporal_step_within_take_a": nanmean(temporal),
           "ratio_take_to_temporal": (nanmean(whole) / nanmean(temporal))
                                     if nanmean(temporal) else float("nan"),
           "actors": {}}
    for a, boxes in boxes_by_actor.items():
        vals = [v for t in range(m)
                for v in [masked(A[t], B[t], boxes[t] if t < len(boxes) else None)]
                if v is not None]
        tvals = [v for t in range(m - 1)
                 for v in [masked(A[t], A[t + 1], boxes[t] if t < len(boxes) else None)]
                 if v is not None]
        out["actors"][a] = {
            "frames": len(vals),
            "box_mean_abs_diff": nanmean(vals),
            "box_median": float(np.median(vals)) if vals else float("nan"),
            "temporal_step_in_box": nanmean(tvals),
            "ratio_take_to_temporal": (nanmean(vals) / nanmean(tvals))
                                      if tvals and nanmean(tvals) else float("nan"),
        }
    return out


def contact_sheet(mp4, camjson, camera, real, targets, out_png, picks=(0, 15, 30, 45, 60, 75, 90, 105, 120)):
    """Nine frames of the render with the PROJECTED position of each actor drawn as
    a cross and the ASSIGNED detection as a circle, joined by a line.

    A number with no picture behind it is the thing nobody can check. This is the
    picture: if the assignment ever attaches the wrong person to an actor, the
    lines cross, and no amount of reading the mean pixel error would show that."""
    cap = cv2.VideoCapture(mp4)
    want = {p: None for p in picks}
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if i in want:
            want[i] = f.copy()
        i += 1
    cap.release()
    got = [(p, want[p]) for p in picks if want[p] is not None]
    if not got:
        return None
    th, tw = int(H) // 3, int(W) // 3
    sheet = np.zeros((th * 3, tw * 3, 3), np.uint8)
    COL = {"A": (60, 200, 255), "B": (255, 140, 60)}     # BGR: amber, blue
    for k, (fi, frame) in enumerate(got[:9]):
        im = frame.copy()
        for a in sorted(targets):
            t = targets[a][fi] if fi < len(targets[a]) else None
            if t is not None and np.isfinite(t).all():
                x, y = int(round(t[0])), int(round(t[1]))
                cv2.drawMarker(im, (x, y), COL[a], cv2.MARKER_CROSS, 46, 3)
            if fi < len(real[a]["matched"]) and real[a]["matched"][fi]:
                d = PF.person_anchor({"xy": real[a]["xy"][fi], "ok": real[a]["ok"][fi]})
                if d is not None:
                    dx, dy = int(round(d[0])), int(round(d[1]))
                    cv2.circle(im, (dx, dy), 20, COL[a], 3)
                    if t is not None and np.isfinite(t).all():
                        cv2.line(im, (int(round(t[0])), int(round(t[1]))), (dx, dy), COL[a], 2)
            cv2.putText(im, a, (24, 40 + 34 * (0 if a == "A" else 1)),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, COL[a], 3, cv2.LINE_AA)
        lab = "f%03d  cross = projected, circle = detected" % fi
        cv2.putText(im, lab, (24, int(H) - 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (0, 0, 0), 5, cv2.LINE_AA)
        cv2.putText(im, lab, (24, int(H) - 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (255, 255, 255), 2, cv2.LINE_AA)
        r, c = k // 3, k % 3
        sheet[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = cv2.resize(
            im, (tw, th), interpolation=cv2.INTER_AREA)
    cv2.imwrite(out_png, sheet)
    return out_png


def sheet_band(path):
    img = cv2.imread(path)
    if img is None:
        return None
    c = IB.band(img)
    return IB.hist(c), [IB.luma(c)]


# ------------------------------------------------------------------ main
def main():
    report = {
        "what": "cross-clip consistency: two cameras, two seeds, one analytic ground truth",
        "measured_at": None,
        "frames_scored": FRAMES,
        "size": [int(W), int(H)],
        "out_dir": OUT,
        "subdir": _SUBDIR,
        "clips": {},
        "cross_clip": {},
        "identity": {},
        "nulls_note": (
            "Every per-clip block carries three nulls. swapped: actor A scored "
            "against B's projection. frozen_f0: the projection held at frame 0. "
            "cross_camera: a camera-1 render scored against camera 2's projection, "
            "which MUST fail or the metric is not seeing the camera."),
    }
    import datetime
    report["measured_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

    disp = {}
    dp = os.path.join(OUT, "dispatch.json")
    if os.path.exists(dp):
        d = json.load(open(dp, encoding="utf-8"))
        report["prompt"] = d.get("prompt")
        report["negative"] = d.get("negative")
        report["vace_strength"] = d.get("strength")
        for row in d.get("dispatched", []):
            disp[row["id"]] = row
    pp = os.path.join(OUT, "pose.json")
    poses_meta = {}
    if os.path.exists(pp):
        for row in json.load(open(pp, encoding="utf-8")).get("poses", []):
            poses_meta[row["id"]] = row

    # ---- the ground truth itself -------------------------------------
    report["ground_truth"] = {}
    for cam, p in CAMJSON.items():
        if not os.path.exists(p):
            continue
        d = json.load(open(p, encoding="utf-8"))
        report["ground_truth"]["cam%d" % cam] = {
            "cam_json": p, "cam_json_sha256": sha256(p),
            "control_mp4": os.path.join(GATE, "gate_block_f2c%d.mp4" % cam),
            "control_mp4_sha256": sha256(os.path.join(GATE, "gate_block_f2c%d.mp4" % cam)),
            "variant": d.get("variant"),
            "actors": d.get("actors"),
            "cameras": d.get("cameras"),
            "in_frame_counts": d.get("actor_in_frame_counts", {}).get("cam%d" % cam),
        }

    print("=" * 78)
    print("CROSS-CLIP CONSISTENCY")
    print("=" * 78)

    loaded = {}
    for cid, spec in CLIPS.items():
        mp4 = find_render(cid)
        kps = find_pose(cid)
        block = {"camera": spec["camera"], "seed": spec["seed"], "control": spec["control"],
                 "render": mp4, "keypoints": kps,
                 # The LEDGER's fields win where they exist. A clip the harness
                 # found already on disk (its resume path) leaves no status or
                 # elapsed time in dispatch.json at all, and reporting `null`
                 # there would say "we did not record this render" about a render
                 # the app recorded perfectly well.
                 "runId": (disp.get(cid) or {}).get("runId"),
                 "promptId": (disp.get(cid) or {}).get("promptId"),
                 "render_status": ((disp.get(cid) or {}).get("ledger_status")
                                   or (disp.get(cid) or {}).get("status")),
                 "render_elapsed_s": ((disp.get(cid) or {}).get("ledger_elapsed_s")
                                      if (disp.get(cid) or {}).get("ledger_elapsed_s") is not None
                                      else (disp.get(cid) or {}).get("secs")),
                 "render_queued_at": (disp.get(cid) or {}).get("ledger_queued_at"),
                 "render_resumed_from_disk": bool((disp.get(cid) or {}).get("resumed")),
                 "pose_runId": (poses_meta.get(cid) or {}).get("runId"),
                 "pose_status": (poses_meta.get(cid) or {}).get("status")}
        if mp4 is None:
            block["problem"] = "no render on disk"
            report["clips"][cid] = block
            print("\n%s: NO RENDER — reported as missing, not substituted." % cid)
            continue
        block["render_sha256"] = sha256(mp4)
        block["render_bytes"] = os.path.getsize(mp4)
        if kps is None:
            block["problem"] = "render exists, no DWPose keypoints"
            report["clips"][cid] = block
            print("\n%s: render present, NO POSE — reported as missing." % cid)
            continue
        block["keypoints_sha256"] = sha256(kps)

        frames, meta = PF.load_people(kps)
        frames = frames[:FRAMES]
        block["detection"] = meta
        block["detection"]["frames_scored"] = len(frames)

        cam = spec["camera"]
        tgt = PF.targets_from_cam(CAMJSON[cam], cam, frames=len(frames))
        hip = PF.targets_from_cam(CAMJSON[cam], cam, frames=len(frames), joint="hip")

        real_block, real_tracks = score_one(frames, tgt, hip)
        block["real"] = real_block

        # ---- null (i): swapped -------------------------------------
        sw, sstats = PF.assign_by_projection(frames, tgt, swap=True)
        block["null_swapped"] = {
            "actors": {a: {"assignment": sstats[a],
                           "error": PF.track_error(sw[a], tgt[a], hip[a])} for a in tgt},
            "layout": layout_agreement(sw, tgt),
        }

        # ---- null (ii): projection frozen at frame 0 ----------------
        ftgt = PF.freeze_frame0(tgt)
        fhip = PF.freeze_frame0(hip)
        fr, fstats = PF.assign_by_projection(frames, ftgt)
        block["null_frozen_f0"] = {
            "actors": {a: {"assignment": fstats[a],
                           "error": PF.track_error(fr[a], ftgt[a], fhip[a])} for a in tgt},
            "layout": layout_agreement(fr, ftgt),
        }

        # ---- null (iii): the OTHER camera's projection ---------------
        other = 2 if cam == 1 else 1
        otgt = PF.targets_from_cam(CAMJSON[other], other, frames=len(frames))
        ohip = PF.targets_from_cam(CAMJSON[other], other, frames=len(frames), joint="hip")
        orr, ostats = PF.assign_by_projection(frames, otgt)
        block["null_cross_camera"] = {
            "scored_against_camera": other,
            "actors": {a: {"assignment": ostats[a],
                           "error": PF.track_error(orr[a], otgt[a], ohip[a])} for a in otgt},
            "layout": layout_agreement(orr, otgt),
            "must": "fail — if this is comparable to `real`, the metric is not seeing the camera",
        }

        loaded[cid] = {"frames": frames, "targets": tgt, "hips": hip,
                       "real": real_tracks, "mp4": mp4}
        png = os.path.join(OUT, "%s_contact.png" % cid)
        try:
            block["contact_sheet"] = contact_sheet(mp4, CAMJSON[cam], cam, real_tracks,
                                                   tgt, png)
        except Exception as e:                                   # noqa: BLE001
            block["contact_sheet"] = None
            block["contact_sheet_error"] = str(e)
        report["clips"][cid] = block

        print("\n%s  camera %d  seed %d   %s" % (cid, cam, spec["seed"], os.path.basename(mp4)))
        print("   detection: %d/%d frames have a person; people/frame %d..%d mean %.2f"
              % (meta["frames_with_any_person"], meta["frames"],
                 meta["people_per_frame_min"], meta["people_per_frame_max"],
                 meta["people_per_frame_mean"]))
        hdr = "   %-6s %-14s %6s %6s %10s %10s" % ("actor", "variant", "vis", "asgn",
                                                   "neck px", "hip px")
        print(hdr)
        print("   " + "-" * (len(hdr) - 3))
        for a in sorted(tgt):
            for label, blk in (("real", block["real"]),
                               ("NULL swapped", block["null_swapped"]),
                               ("NULL frozen f0", block["null_frozen_f0"]),
                               ("NULL cross-cam", block["null_cross_camera"])):
                if a not in blk["actors"]:
                    continue
                st = blk["actors"][a]["assignment"]
                er = blk["actors"][a]["error"]
                print("   %-6s %-14s %6d %6d %10.1f %10.1f"
                      % (a, label, st["visible_frames"], st["assigned_frames"],
                         er["neck"]["mean_px"], er["hip"]["mean_px"]))
        print("   layout (B - A vector, normalised frame coords):")
        for label, blk in (("real", block["real"]),
                           ("NULL swapped", block["null_swapped"]),
                           ("NULL frozen f0", block["null_frozen_f0"]),
                           ("NULL cross-cam", block["null_cross_camera"])):
            L = blk["layout"]
            print("     %-14s pairs %3d  |d-p| %.4f  angle %6.1f deg  ORDER %.3f "
                  "(constant-guess baseline %.3f, lift %+.3f, gt flips %d)"
                  % (label, L["pairs"], L["vector_err_norm_mean"], L["angle_deg_mean"],
                     L["order_agreement"], L["order_baseline_constant_guess"],
                     L["order_lift_over_baseline"], L["ground_truth_order_flips"]))

    # ---- take-vs-take drift -----------------------------------------
    if "C1S1" in loaded and "C1S2" in loaded:
        a1, a2 = loaded["C1S1"]["real"], loaded["C1S2"]["real"]
        drift = {}
        for a in loaded["C1S1"]["targets"]:
            ds = []
            for t in range(FRAMES):
                if not (a1[a]["matched"][t] and a2[a]["matched"][t]):
                    continue
                p1 = PF.person_anchor({"xy": a1[a]["xy"][t], "ok": a1[a]["ok"][t]})
                p2 = PF.person_anchor({"xy": a2[a]["xy"][t], "ok": a2[a]["ok"][t]})
                if p1 is None or p2 is None:
                    continue
                ds.append(float(np.linalg.norm(p1 - p2)))
            drift[a] = {"pairs": len(ds),
                        "mean_px": nanmean(ds),
                        "median_px": float(np.median(ds)) if ds else float("nan"),
                        "p90_px": float(np.percentile(ds, 90)) if ds else float("nan")}
        report["cross_clip"]["take_vs_take_C1S1_vs_C1S2"] = {
            "what": "same camera, same control clip, same prompt; seeds 70117 vs 31337. "
                    "Whatever this is, is the model's own variance.",
            "neck_drift": drift,
        }
        print("\ntake-vs-take drift (C1S1 seed 70117 vs C1S2 seed 31337, same control clip):")
        for a, d in drift.items():
            print("   POSE   actor %s: %d frames, mean %.1f px, median %.1f px, p90 %.1f px"
                  % (a, d["pairs"], d["mean_px"], d["median_px"], d["p90_px"]))

        cam = CLIPS["C1S1"]["camera"]
        boxes = {a: actor_boxes(CAMJSON[cam], cam, a) for a in ("A", "B")}
        px = take_drift_pixels(loaded["C1S1"]["mp4"], loaded["C1S2"]["mp4"], boxes)
        if px:
            report["cross_clip"]["take_vs_take_pixels"] = px
            print("   PIXEL  whole frame: mean |I_70117 - I_31337| = %.2f grey levels; the "
                  "clip's own" % px["whole_frame_mean_abs_diff"])
            print("          frame-to-frame step within one take is %.2f, so the two takes "
                  "differ by" % px["temporal_step_within_take_a"])
            print("          %.2fx one frame of motion." % px["ratio_take_to_temporal"])
            for a, d in px["actors"].items():
                print("   PIXEL  actor %s box: %.2f grey levels over %d frames "
                      "(%.2fx the in-box temporal step of %.2f)"
                      % (a, d["box_mean_abs_diff"], d["frames"],
                         d["ratio_take_to_temporal"], d["temporal_step_in_box"]))

    # ---- detector-free localisation ----------------------------------
    # Only run when the pose side found nothing, and SAID SO, so it can never be
    # mistaken for the measurement the experiment was designed around.
    dead = [cid for cid in loaded
            if report["clips"][cid]["detection"]["frames_with_any_person"] == 0]
    if dead or (ALWAYS_LOCALISE and loaded):
        # The heading and the `why` must say WHICH of the two things this is: the
        # fallback for an empty pose result, or a measurement run alongside a pose
        # result that exists. At strength 1.00 they were the same thing and the
        # text could be baked in; across a sweep they are not, and a block that
        # still said "VACE at strength 1.00 reproduced the blocking as boxes"
        # under a clip rendered at 0.50 would be a fabricated finding.
        strength_now = report.get("vace_strength")
        if dead:
            print("\ndetector-free localisation (DWPose found NO people in %s, so the pose "
                  "numbers above are empty; this measures whether an OBJECT is where the "
                  "ground truth says):" % ", ".join(sorted(dead)))
            why = ("DWPose detected no people in %s (VACE strength %s). There is no "
                   "skeleton to find, so this measures object placement instead, with "
                   "the same three nulls. It is NOT a pose measurement."
                   % (", ".join(sorted(dead)), strength_now))
        else:
            print("\ndetector-free localisation (run for every clip by --always-localise; "
                  "DWPose DID find people here, so this is measured beside the pose "
                  "numbers rather than in place of them):")
            why = ("Run for every clip by --always-localise, at VACE strength %s. DWPose "
                   "found people in every clip scored here, so this is NOT standing in "
                   "for an empty pose result: it is the same object-placement question "
                   "asked independently of any detector, so that localisation can be "
                   "compared across strengths on one measure that never switches off."
                   % strength_now)
        block = {"why": why,
                 "measure": "mean(ring luma) - mean(box luma), grey levels, "
                            "box = projected neck/hip body box, ring = that box grown 1.9x",
                 "nulls": "frozen_f0 and cross_camera are real nulls. other_actor_boxes "
                          "is NOT a null - scoring actor A at B's boxes computes B's own "
                          "real number, because this measure localises an object and "
                          "cannot tell which actor is in it.",
                 "clips": {}}
        for cid in sorted(loaded):
            cam = CLIPS[cid]["camera"]
            other = 2 if cam == 1 else 1
            row = {}
            for a in ("A", "B"):
                oa = "B" if a == "A" else "A"
                # ⚠ THE SWAP IS NOT A NULL FOR THIS MEASURE, and calling it one
                # would be a lie by table layout. Scoring actor A at actor B's box
                # positions computes, by construction, B's own real number - both
                # actors are dark objects and this measure asks only "is there a
                # distinct object here". It is kept, named `other_actor_boxes`,
                # because "both actors are localised equally well" is worth
                # knowing; it is NOT evidence that the two can be told apart. The
                # measure that tries to tell them apart is the identity block
                # below, and it is a different measure for that reason.
                variants = {
                    "real": actor_boxes(CAMJSON[cam], cam, a),
                    "other_actor_boxes": actor_boxes(CAMJSON[cam], cam, oa),
                    "null_frozen_f0": None,
                    "null_cross_camera": actor_boxes(CAMJSON[other], other, a),
                }
                fz = variants["real"]
                first = next((b for b in fz if b is not None), None)
                variants["null_frozen_f0"] = [first] * len(fz)
                row[a] = {k: box_contrast(loaded[cid]["mp4"], v)
                          for k, v in variants.items()}
                # ⚠ THE FROZEN NULL IS VACUOUS FOR A STATIC ACTOR ON A STATIC
                # CAMERA, and it must say so rather than quietly scoring the same
                # as `real` and looking like a failure of the measure. Actor A
                # stands still; camera 2 does not move; so A's projected box is
                # IDENTICAL on every frame and freezing it at frame 0 changes
                # nothing. That is a correct property of the geometry, and a
                # reader who is not told will read "frozen == real" as the metric
                # not working.
                boxes_now = [b for b in variants["real"] if b is not None]
                frozen_is_real = bool(
                    boxes_now and all(np.allclose(b, boxes_now[0]) for b in boxes_now))
                row[a]["null_frozen_f0"]["degenerate"] = frozen_is_real
                if frozen_is_real:
                    row[a]["null_frozen_f0"]["why_degenerate"] = (
                        "this actor's projected box is identical on every frame (a "
                        "standing actor on a locked-off camera), so freezing the "
                        "projection at frame 0 IS the projection. Not a null here.")
                print("   %s actor %s: real %+6.2f  | NULL frozen %+6.2f  NULL cross-cam "
                      "%+6.2f  | other-actor boxes %+6.2f (not a null: see the note)"
                      % (cid, a, row[a]["real"]["contrast_mean"],
                         row[a]["null_frozen_f0"]["contrast_mean"],
                         row[a]["null_cross_camera"]["contrast_mean"],
                         row[a]["other_actor_boxes"]["contrast_mean"]))
                if frozen_is_real:
                    print("             (frozen is DEGENERATE here: %s stands still and "
                          "this camera does not move," % a)
                    print("              so its projected box never changes and freezing "
                          "it is a no-op)")
            block["clips"][cid] = row
        report["detector_free_localisation"] = block

    # ---- identity ----------------------------------------------------
    if "C1S1" in loaded and "C2S1" in loaded:
        print("\nidentity (central-band palette + NCC on per-actor crops from the "
              "PROJECTED body box):")
        sheets = {}
        for k, p in FOIL_SHEETS.items():
            b = sheet_band(p)
            if b is not None:
                sheets[k] = b
        bands = {}
        for cid in ("C1S1", "C2S1"):
            cam = CLIPS[cid]["camera"]
            for a in ("A", "B"):
                boxes = actor_boxes(CAMJSON[cam], cam, a)
                h, ls, used, skipped = IB.clip_bands(loaded[cid]["mp4"], boxes=boxes,
                                                     max_frames=FRAMES)
                bands[(cid, a)] = {"band": (h, ls), "used": used, "skipped": skipped}

        ident = {"window": list(IB.WINDOW),
                 "crop": "per-actor box from the projected neck and hip, never from a detection",
                 "foil_sheets": {k: FOIL_SHEETS[k] for k in sheets},
                 "actors": {}}
        for a in ("A", "B"):
            other = "B" if a == "A" else "A"
            ref = bands[("C1S1", a)]["band"]
            same = IB.compare_bands(ref, bands[("C2S1", a)]["band"])
            oth = IB.compare_bands(ref, bands[("C2S1", other)]["band"])
            sheet_scores = {k: IB.compare_bands(v, bands[("C2S1", a)]["band"])
                            for k, v in sheets.items()}
            row = {
                "frames_used_C1S1": bands[("C1S1", a)]["used"],
                "frames_used_C2S1": bands[("C2S1", a)]["used"],
                "frames_skipped_C1S1": bands[("C1S1", a)]["skipped"],
                "frames_skipped_C2S1": bands[("C2S1", a)]["skipped"],
                "same_actor_across_cameras": same,
                "other_actor_across_cameras": oth,
                "vs_foil_sheets": sheet_scores,
            }
            for m in ("palette", "ncc"):
                foils = [oth[m]] + [v[m] for v in sheet_scores.values()]
                row["z_" + m] = IB.zscore(same[m], foils)
            ident["actors"][a] = row
            print("   actor %s: palette same %.4f vs other-actor %.4f, z %.2f%s"
                  % (a, same["palette"], oth["palette"], row["z_palette"]["z"],
                     "  <- A FOIL BEATS IT" if row["z_palette"]["beaten_by_a_foil"] else ""))
            print("             ncc     same %.4f vs other-actor %.4f, z %.2f%s"
                  % (same["ncc"], oth["ncc"], row["z_ncc"]["z"],
                     "  <- A FOIL BEATS IT" if row["z_ncc"]["beaten_by_a_foil"] else ""))
        report["identity"] = ident

    os.makedirs(OUT, exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1, default=float)
    print("\nwrote %s" % REPORT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
