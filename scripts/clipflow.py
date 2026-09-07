"""Motion measurement for a rendered clip, using only what is already installed.

WHY THIS EXISTS. We had an image review step and no video step at all, which
made us the outlier against every peer system. The gap is not academic: on the
first run over sub-rosa this found that scene 1's CHOSEN take was the most
static of the five takes rendered for it — median flow 0.036 against 0.247 for
the H3 take of the same scene, and 52 of its 89 frames essentially still. The
pipeline could not see that, because nothing in it looked at motion.

WHY NOT A MODEL. AutoMV measured Qwen-Omni scoring nearly everything 4.7-5.0,
and Gemini-2.5-Pro rating AutoMV's own output 4.30/4.55/4.59 where human experts
gave 2.94/2.05/2.62 on the same footage. A saturated judge cannot gate. So every
ABSOLUTE threshold in this pipeline has to come from a deterministic signal, and
a model may only ever compare two candidates. This is that deterministic floor.

THE METHOD, and its limits:

  1. Decode frames and downscale to a fixed analysis width. Farneback flow is
     scale-invariant once the result is normalised, and small is fast.
  2. Dense optical flow between consecutive frames (Farneback), then the mean
     magnitude over the frame.
  3. Report magnitude as PERCENT OF FRAME WIDTH per frame, so a 1920x1088 clip
     and a 960x544 clip are directly comparable. This matters here: the
     low-resolution-generate-then-upscale route produces both.
  4. A frozen TAIL is counted separately from stillness generally, because they
     have different causes. `guided = !!endFrame` pins every guided clip at its
     last frame, and once the model arrives there it has nothing left to move
     toward — so it settles and holds. Measured: 4 of 4 guided clips carried a
     tail, 6 of 9 unguided clips carried none.

HONEST ABOUT THE THRESHOLDS. They were set on a 13-clip comparison and then
checked against the full 99 delivered clips on one rig, not against a
published standard — there is no public baseline for this measurement. They are
set where the two populations actually separated, and they are advisory: this
reports a verdict and never refuses anything. A slow push-in that a brief asked
for looks exactly like a failure to this script, which is why `still` and
`tail` are reported separately rather than collapsed into one score.
"""
import json
import sys

import cv2
import numpy as np

# Flow is normalised against width, so this only trades speed for noise.
ANALYSIS_W = 480
# Below this, a frame is not moving in any way a viewer would call movement.
STILL_EPS = 0.05
# ⚠ THE FRAME MEAN IS BLIND TO A SMALL SUBJECT IN A LARGE STATIC FRAME, because
# it measures how much AREA changed rather than whether anything moved. Measured
# on the Salt and Static reshoot: 4 of 8 clips were flagged and all 4 were good —
# a figure crossing a lit window (100% "still"), a car receding down a road
# (100% "still"), a dashboard POV, a car under streetlights. Each is a small
# mover against a big static background, so the mean sits under STILL_EPS while
# the thing the shot is ABOUT is moving perfectly well.
#
# So flow is now read twice: the frame mean, and the 99th percentile of
# per-pixel magnitude, which is what a small fast subject actually registers on.
# A frame is only still when BOTH are low, and a clip is only a slideshow when
# BOTH are low. The peak alone is not a verdict either — sensor noise and
# compression move single pixels — which is why it gates rather than decides.
PEAK_EPS = 0.55
# Where the guided and unguided populations separated on this rig.
SLIDESHOW_P50 = 0.05
TAIL_SEC = 0.25
STILL_FRACTION = 0.25


def measure(path, max_frames=20000):
    """Per-frame flow magnitude as a percent of frame width."""
    cap = cv2.VideoCapture(path)
    ok, prev = cap.read()
    if not ok:
        cap.release()
        return {"error": "could not decode a first frame"}
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    h, w = prev.shape[:2]
    sw = ANALYSIS_W
    # Even height keeps the resize exact for the usual 16:9 and 1920x1088.
    sh = max(2, int(round(h * sw / w / 2) * 2))
    prev_g = cv2.cvtColor(cv2.resize(prev, (sw, sh)), cv2.COLOR_BGR2GRAY)

    mags, peaks = [], []
    while len(mags) < max_frames:
        ok, fr = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(cv2.resize(fr, (sw, sh)), cv2.COLOR_BGR2GRAY)
        fl = cv2.calcOpticalFlowFarneback(prev_g, g, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        mag = np.linalg.norm(fl, axis=2)
        mags.append(float(mag.mean()))
        # The 99th percentile rather than the max: the max is one pixel and picks
        # up encoder noise, while p99 is roughly "the fastest 1% of the frame",
        # which is exactly a small subject crossing.
        peaks.append(float(np.percentile(mag, 99)))
        prev_g = g
    cap.release()

    if not mags:
        return {"error": "only one frame decoded — not a video"}

    m = np.asarray(mags) / sw * 100.0
    pk = np.asarray(peaks) / sw * 100.0
    # BOTH low, not either — see PEAK_EPS above for the four clips that proved it.
    still = (m < STILL_EPS) & (pk < PEAK_EPS)

    # The tail is the run of still frames at the END, which has its own cause.
    tail = 0
    for v in still[::-1]:
        if not v:
            break
        tail += 1

    p50 = float(np.percentile(m, 50))
    p50pk = float(np.percentile(pk, 50))
    still_frac = float(still.mean())
    flags = []
    if p50 < SLIDESHOW_P50 and p50pk < PEAK_EPS:
        flags.append("slideshow")
    if tail / fps >= TAIL_SEC:
        flags.append("frozen_tail")
    if still_frac > STILL_FRACTION:
        flags.append("mostly_still")

    return {
        # A clip longer than max_frames is reported as TRUNCATED rather than
        # silently described by its opening: durationSec, the frozen tail and
        # the still fraction would otherwise be statistics about a prefix,
        # presented as statistics about the clip.
        "truncated": len(mags) >= max_frames,
        "frames": len(m) + 1,
        "fps": round(fps, 3),
        "width": w,
        "height": h,
        "durationSec": round((len(m) + 1) / fps, 3),
        # All magnitudes are percent of frame width per frame.
        "meanFlow": round(float(m.mean()), 4),
        "p05Flow": round(float(np.percentile(m, 5)), 4),
        "p50Flow": round(p50, 4),
        "p95Flow": round(float(np.percentile(m, 95)), 4),
        # Peak flow — the statistic that sees a small mover. Read it beside the
        # mean: high peak with a low mean is a subject moving in a still frame,
        # which is a composition, not a fault.
        "p50PeakFlow": round(p50pk, 4),
        "p95PeakFlow": round(float(np.percentile(pk, 95)), 4),
        "stillFrames": int(still.sum()),
        "stillFraction": round(still_frac, 4),
        "tailFrames": int(tail),
        "tailSec": round(tail / fps, 3),
        "flags": flags,
        "ok": not flags,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: clipflow.py <video> [<video> ...]"}))
        return 1
    out = []
    for p in sys.argv[1:]:
        try:
            r = measure(p)
        except Exception as e:                               # noqa: BLE001
            r = {"error": f"{type(e).__name__}: {e}"}
        r["path"] = p
        out.append(r)
    # One clip in, one object out; several in, an array — so a caller reading a
    # single result never has to unwrap a list it did not ask for.
    print(json.dumps(out[0] if len(out) == 1 else out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
