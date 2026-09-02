#!/usr/bin/env python3
"""Score the H3 resolution ladder — face pixels, mouth pixels, face sharpness.

WHAT IS BEING SEPARATED. "Bigger" and "more detail" are not the same thing, and
telling them apart is the whole point of the sweep:

  face_px      height of the face box, median over sampled frames. The raw
               currency — how many pixels the model spent on the head.
  face_pct     that height as a percentage of FRAME height. This is the
               composition, and it is reported because it turns out not to be
               constant across sizes: changing the canvas changes the latent
               shape, so a "fixed" seed is a different draw and the model
               reframes. Without this column the face_px comparison is unread-
               able.
  mouth_px     height of the LOWER THIRD of the face box. Lip-sync reads the
               mouth, not the head.
  sharpness    variance of Laplacian over the face crop AT ITS NATIVE SIZE.
               A big face box full of mush scores low; that is the point.
  sharp_norm   same crop resized to a common height first. Detail per unit of
               face rather than per pixel. NOTE it carries the upsample factor
               with it — a smaller crop is stretched further and blurs more —
               so it is only comparable between rows of similar face_px.

⚠ FALSE POSITIVES ARE THE REAL ENEMY at this face size. The first pass took the
largest detection per frame and confidently measured a pair of white sneakers as
a 60px face. Two filters fix it, both cheap:
  - a head in a standing wide shot is in the upper part of the frame, so boxes
    centred below 72% of frame height are dropped;
  - a real face is detected in the SAME PLACE frame after frame, so detections
    are clustered by position and the cluster seen in the most frames wins.
An annotated frame is written per clip so the choice can be checked by eye
rather than trusted.

⚠ THE DETECTOR. The brief asked for cv2's bundled Haar cascade. This rig's
OpenCV is 5.0.0, which REMOVED cv2.CascadeClassifier and ships an EMPTY
cv2.data.haarcascades directory, so this runs on an isolated OpenCV 4.12 venv
built for the purpose. Nothing on the rig was changed.

No detection is reported as -1, not as a guess.
"""
import argparse, glob, json, os, sys
import cv2
import numpy as np

CASCADE = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
EYE_CASCADE = os.path.join(cv2.data.haarcascades, "haarcascade_eye.xml")
SAMPLES = 16
STRIP_H = 320
MAX_Y = 0.72          # a head is not in the bottom quarter of a standing wide shot


def has_eye(gray, box, eyes):
    """Does this candidate box contain an eye?

    ⚠ THE FILTER THAT MATTERS. Frame-to-frame consistency does NOT separate a
    face from a false positive here: a lit office block in the skyline is the
    most stable thing in the shot, and the cluster vote picked one twice —
    measuring a building as an 82px 'face'. A window grid survives a position
    vote; it does not survive being asked for an eye. The crop is blown up to
    120px first because these heads are 50-90px and the eye cascade has a
    20x20 minimum."""
    x, y, w, h = box
    crop = gray[y:y + h, x:x + w]
    if crop.size == 0 or h < 8:
        return False
    s = 120.0 / h
    up = cv2.resize(crop, (max(1, int(w * s)), 120), interpolation=cv2.INTER_CUBIC)
    upper = up[: int(120 * 0.65), :]          # eyes live in the upper part of a face
    return len(eyes.detectMultiScale(cv2.equalizeHist(upper), scaleFactor=1.05,
                                     minNeighbors=3, minSize=(12, 12))) > 0


def sample_frames(path, n=SAMPLES):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return (0, 0, 0), []
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    idx = np.linspace(0, max(0, total - 1), min(n, max(1, total))).astype(int)
    frames = []
    for i in idx:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, fr = cap.read()
        if ok:
            frames.append((int(i), fr))
    cap.release()
    return (w, h, total), frames


def detections(gray, det, H):
    eq = cv2.equalizeHist(gray)
    out = []
    for (x, y, w, h) in det.detectMultiScale(eq, scaleFactor=1.05, minNeighbors=6,
                                             minSize=(20, 20)):
        if (y + h / 2) / H > MAX_Y:      # too low in frame to be a head
            continue
        out.append((int(x), int(y), int(w), int(h)))
    return out


def cluster_motion(g, grays):
    """Mean absolute frame-to-frame change inside this cluster's box.

    ⚠ THE DISCRIMINATOR THAT ACTUALLY WORKS. Neither position-stability nor the
    eye cascade separates a face from a lit office block: a window grid is
    perfectly stable AND reads as an eye, and one such block sat ~100px from the
    subject's head and got measured as her face. But the camera is locked off and
    the rapper is not: her face changes 27-45 grey levels between sampled frames
    and every false positive measured here changes less than 10, most of them
    less than 1. Motion is what tells a person from a building."""
    mh = int(np.median([b[3] for _, b in g["pts"]]))
    mw = int(np.median([b[2] for _, b in g["pts"]]))
    x0, y0 = max(0, int(g["cx"] - mw / 2)), max(0, int(g["cy"] - mh / 2))
    order = sorted(grays)
    diffs = []
    for a, b in zip(order, order[1:]):
        ca = grays[a][y0:y0 + mh, x0:x0 + mw].astype(np.int16)
        cb = grays[b][y0:y0 + mh, x0:x0 + mw].astype(np.int16)
        if ca.size and ca.shape == cb.shape:
            diffs.append(float(np.abs(ca - cb).mean()))
    return float(np.median(diffs)) if diffs else 0.0


def pick_cluster(per_frame, W, H, grays):
    """Group detections by centre, then pick the one that is a person.

    Tolerance is 3% of the frame diagonal. It was 6% and that was too loose: the
    real face and the office block beside it merged into a single cluster whose
    centre landed on the block."""
    tol = 0.03 * np.hypot(W, H)
    groups = []   # each: {"pts": [(frame_idx, box)], "eye": {frame_idx: bool}, "cx", "cy"}
    for fi, boxes in per_frame:
        for (x, y, w, h), eye in boxes:
            cx, cy = x + w / 2, y + h / 2
            for g in groups:
                if np.hypot(cx - g["cx"], cy - g["cy"]) < tol:
                    g["pts"].append((fi, (x, y, w, h)))
                    g["eye"][fi] = g["eye"].get(fi, False) or eye
                    n = len(g["pts"])
                    g["cx"] += (cx - g["cx"]) / n
                    g["cy"] += (cy - g["cy"]) / n
                    break
            else:
                groups.append({"pts": [(fi, (x, y, w, h))], "eye": {fi: eye}, "cx": cx, "cy": cy})
    if not groups:
        return None
    # Eye-confirmed on at least 2 frames to be a candidate at all, then the one
    # that MOVES. A cluster that passes neither test is not a face.
    for g in groups:
        g["eyes_n"] = len({fi for fi in g["eye"] if g["eye"][fi]})
        g["motion"] = cluster_motion(g, grays)
    cands = [g for g in groups if g["eyes_n"] >= 2]
    if not cands:
        return None
    best = max(cands, key=lambda g: g["motion"])
    return best if best["motion"] >= 5.0 else None


def score(path, dump_dir):
    det = cv2.CascadeClassifier(CASCADE)
    eyes = cv2.CascadeClassifier(EYE_CASCADE)
    (W, H, total), frames = sample_frames(path)
    rec = {"file": os.path.basename(path), "width": W, "height": H, "frames": total,
           "sampled": len(frames), "detected_on": 0}
    by_frame = {i: fr for i, fr in frames}
    grays = {i: cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY) for i, fr in frames}
    per_frame = []
    for i, fr in frames:
        gray = grays[i]
        per_frame.append((i, [(b, has_eye(gray, b, eyes)) for b in detections(gray, det, H)]))
    g = pick_cluster(per_frame, W, H, grays)
    if g is None:
        rec.update(face_px=-1, face_pct=-1, mouth_px=-1, sharpness=-1, sharp_norm=-1,
                   eye_frames=0, motion=-1)
        return rec, None

    heights, sharps, sharps_norm, best = [], [], [], None
    for fi, (x, y, w, h) in g["pts"]:
        fr = by_frame[fi]
        gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        crop = gray[y:y + h, x:x + w]
        if crop.size == 0:
            continue
        heights.append(h)
        sharps.append(float(cv2.Laplacian(crop, cv2.CV_64F).var()))
        norm = cv2.resize(crop, (STRIP_H, STRIP_H), interpolation=cv2.INTER_LINEAR)
        sharps_norm.append(float(cv2.Laplacian(norm, cv2.CV_64F).var()))
        # the strip's frame is chosen from the EYE-CONFIRMED ones, so what a
        # human checks is a frame the filter actually vouched for
        if g["eye"].get(fi) and (best is None or h > best[0]):
            best = (h, fi, fr, (x, y, w, h))
    if best is None:
        fi, (x, y, w, h) = max(g["pts"], key=lambda p: p[1][3])
        best = (h, fi, by_frame[fi], (x, y, w, h))
    rec["detected_on"] = len({fi for fi, _ in g["pts"]})
    rec["eye_frames"] = g["eyes_n"]
    rec["motion"] = round(g["motion"], 2)
    med_h = float(np.median(heights))
    rec.update(
        face_px=int(round(med_h)),
        face_px_min=int(min(heights)), face_px_max=int(max(heights)),
        face_pct=round(100.0 * med_h / H, 2),
        mouth_px=round(med_h / 3.0, 1),
        sharpness=round(float(np.median(sharps)), 1),
        sharp_norm=round(float(np.median(sharps_norm)), 1),
    )
    # annotated frame, so the pick can be checked by eye
    fh, fi, fr, (x, y, w, h) = best
    ann = fr.copy()
    cv2.rectangle(ann, (x, y), (x + w, y + h), (0, 255, 0), 2)
    cv2.rectangle(ann, (x, y + 2 * h // 3), (x + w, y + h), (0, 200, 255), 2)
    cv2.putText(ann, f"{W}x{H} face {rec['face_px']}px", (x, max(20, y - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2, cv2.LINE_AA)
    cv2.imwrite(os.path.join(dump_dir, "picked_" + os.path.basename(path).replace(".mp4", ".png")), ann)
    return rec, best


def strip(entries, out):
    """One face crop per size, blown up to a common height with NEAREST so the
    real pixel grid stays visible — a smooth resize would hide the very thing
    being compared."""
    tiles = []
    for label, best in entries:
        if best is None:
            tile = np.full((STRIP_H, STRIP_H, 3), 40, np.uint8)
            cv2.putText(tile, "no face", (40, STRIP_H // 2), cv2.FONT_HERSHEY_SIMPLEX,
                        1.0, (60, 60, 255), 2)
        else:
            fh, _, fr, (x, y, w, h) = best
            pad = int(h * 0.3)
            Hh, Ww = fr.shape[:2]
            crop = fr[max(0, y - pad):min(Hh, y + h + pad), max(0, x - pad):min(Ww, x + w + pad)]
            s = STRIP_H / crop.shape[0]
            tile = cv2.resize(crop, (int(crop.shape[1] * s), STRIP_H), interpolation=cv2.INTER_NEAREST)
        bar = np.full((32, tile.shape[1], 3), 20, np.uint8)
        cv2.putText(bar, label, (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(np.vstack([bar, tile]))
    hmax = max(t.shape[0] for t in tiles)
    tiles = [np.vstack([t, np.full((hmax - t.shape[0], t.shape[1], 3), 20, np.uint8)]) for t in tiles]
    cv2.imwrite(out, np.hstack(tiles))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=r"D:\AI\aiplay-studio-bench\ComfyUI\output\ressweep")
    a = ap.parse_args()
    vids = sorted(glob.glob(os.path.join(a.dir, "*.mp4")))
    if not vids:
        print("no clips yet in", a.dir); sys.exit(1)
    print(f"cascade: {CASCADE}\n")
    recs, entries = [], []
    for v in vids:
        rec, best = score(v, a.dir)
        recs.append(rec)
        entries.append((f"{rec['width']}x{rec['height']}  face {rec['face_px']}px  "
                        f"mouth {rec['mouth_px']}px", best))
        print(f"{rec['file']:<40} {rec['width']}x{rec['height']} f={rec['frames']:<4} "
              f"face={rec['face_px']:<5} ({rec['face_pct']}%) mouth={rec['mouth_px']:<6} "
              f"sharp={rec['sharpness']:<9} norm={rec['sharp_norm']:<8} "
              f"det={rec['detected_on']}/{rec['sampled']} eye={rec.get('eye_frames',0)} "
              f"motion={rec.get('motion',0)}")
    out = os.path.join(a.dir, "face_strip.png")
    strip(entries, out)
    json.dump(recs, open(os.path.join(a.dir, "scores.json"), "w"), indent=2)
    print(f"\nstrip:  {out}\nscores: {os.path.join(a.dir, 'scores.json')}")
