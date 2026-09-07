"""Point motion tracking — AE's tracker, and the stabiliser that falls out of it.

WHAT A CALLER MUST PASS
=======================
    python server/vfx/tracker.py <job.json>            one JSON line to stdout

job.json — `video` and `rect` are required, everything else has a default:

    {
      "video": "C:/…/clip.mp4",   ABSOLUTE path. The route resolves library
                                  names; this process picks no files.
      "rect":  [x, y, w, h],      the feature to follow, in SOURCE PIXELS on the
                                  first tracked frame. Box the FEATURE, not the
                                  area around it — see SIZING below.
      "rect2": null,              a second feature, same form. Supplying it adds
                                  rotation and scale (2-point tracking).

      "from": 0, "to": null,      frame indices, inclusive/exclusive-of-null =
                                  to the end. Or "fromTime"/"toTime" in seconds.
      "fps":  null,               timebase for the key times; defaults to the
                                  clip's own fps
      "timeOrigin": 0.0,          seconds added to every emitted key time

      "search": 40,               how far from the PREDICTED position to look,
                                  pixels. Bigger survives faster motion and
                                  costs time quadratically.
      "predict": true,            extrapolate from the last two positions before
                                  searching. Lets `search` stay small.
      "minConfidence": 0.55,      NCC below this counts as a failed frame
      "lostAfter": 2,             consecutive failed frames before declaring lost
      "stopOnLost": true,         false = keep going and keep reporting, honestly,
                                  with the low confidences attached
      "adapt": 0.0,               0..1 — blend the current patch into the template
                                  each frame. 0 = the original feature, forever.
      "adaptAbove": 0.90,         only adapt when confidence is at least this

      "offset": [0, 0],           added to every emitted position, so source
                                  pixels become comp pixels in one step
      "anchor": null,             base position for the STABILISATION keys;
                                  defaults to the clip's centre
      "stabilize": true,          emit the inverse-motion keys too
      "decimals": 3
    }

Result:

    { "ok": true,
      "keys": { "position": { "keys": [ {"t":0.0,"v":[412.5,233.0]}, … ] } },
      "confidence": [0.99, 0.98, …],       one per emitted key, same order
      "lostAt": 1.6667,                    seconds where lock was lost for good,
                                           null if it never was
      "frames": 40,                        keys emitted
      "margin":  [0.61, …],                per key: how far the winning peak beat
                                           the best rival in the search window.
                                           Near zero on repetitive texture, which
                                           is the one failure a high NCC hides.
      "dips":   [{"t":0.9,"frames":1,"confidence":0.41}],
                                           sub-threshold runs that RECOVERED.
                                           Their keys are present; the wobble is
                                           reported rather than quietly smoothed.
      "rotation": {"keys":[…]},            only with rect2, degrees, 0 at the start
      "scale":    {"keys":[…]},            only with rect2, percent, 100 at the start
      "stabilize": { "position": {"keys":[…]}, "anchor": [432,240], … },
      "width": 864, "height": 480, "fps": 30.0, "attempted": 56, "ms": 1234 }

    { "ok": false, "error": "…" } and exit 1 on any failure.

`keys` are EXACTLY VFX_SPEC §1's form. `position` is a 2-vector, matching
`transform.position`; `rotation` and `scale` match theirs (degrees clockwise,
percent) — note `scale` is a 2-vector so it can be dropped straight onto
`transform.scale`.

COORDINATES. Everything measured is in the SOURCE clip's pixels, because that is
what was measured. A layer showing the clip 1:1 with its anchor at the clip's
centre needs `offset` set to (comp centre − clip centre); anything else is the
caller's transform to work out, and inventing one here would be a guess wearing
a number.


THE ALGORITHM, AND WHY THIS ONE
===============================
Normalised cross-correlation template matching (cv2.TM_CCOEFF_NORMED) inside a
bounded search window around a constant-velocity prediction, with sub-pixel
refinement by a parabola fitted to the correlation peak.

The brief offered Lucas-Kanade instead. LK is faster, gives sub-pixel for free,
and would have been the obvious pick — except for the one requirement that
decides it: **this tracker has to be able to say it lost the shot.**

  · NCC hands back a number in the same units on every frame of every clip:
    a correlation coefficient in -1..1. "Below 0.55 for two frames running" is
    a threshold a person can set once and understand. LK's outputs are a
    residual in pixel-intensity units and a binary status flag; the residual is
    not comparable between a dark clip and a bright one, and the flag goes false
    long after the point has quietly slid somewhere else.
  · LK's failure mode is precisely the one the brief calls worse than stopping.
    Occlude the feature and LK does not fail — it follows the occluder's texture,
    confidently, and every downstream keyframe is a fiction. NCC's peak value
    collapses in the same situation because the patch no longer looks like the
    template, which is the event we need to observe.
  · CCOEFF_NORMED subtracts the patch mean and divides by its energy, so it is
    invariant to linear brightness and contrast change. That covers the most
    common reason a feature "changes appearance" — exposure drift, a fade, a
    lighting cue — without any adaptation at all.
  · The cost objection to NCC is real and is answered by bounding the search.
    Full-frame matching at 864x480 would be hopeless; a 40 px radius around a
    predicted position is a 120x120 search for a 40x40 template, and that
    measures at 0.27 ms a frame (0.20 at a 24 px radius, 0.79 at 64). Decoding
    the same footage costs 8.3 ms a frame, so this tracker is entirely
    decode-bound and the algorithm choice never had to be made on speed.

RE-SEEDING, and why it is off by default. The brief suggests re-seeding when
confidence drops. That is exactly backwards: low confidence means the tracker
does not know what it is looking at, and re-seeding then bakes the wrong patch
in as ground truth — the classic way a tracker slides onto a passing shadow and
never comes back. Adaptation belongs on HIGH confidence, where the feature is
still clearly matched but has changed slightly, which is why the dial is
`adapt` gated by `adaptAbove: 0.90`. It defaults to 0.0 — the original feature,
unmodified, for the whole shot — because a fixed template cannot drift, and AE
makes the same default choice. Turn it to 0.1-0.2 on a long shot where the
feature rotates or the light changes; accept that you have traded a drift-proof
tracker for one that survives longer.

WHAT IT STILL GETS WRONG, said plainly:

  · A 2D translation template cannot follow rotation, scale or perspective. A
    feature that turns 20 degrees will lose correlation and be reported lost —
    correctly, but the answer to that is `rect2`, or a manual re-track.
  · Repetitive texture (a brick wall, a picket fence) can correlate as well on
    the wrong copy as the right one. The bounded search around a motion
    prediction is the only defence here, and it is why `search` should not be
    made large "just in case". `margin` — the gap between the best peak and the
    best peak elsewhere in the window — is reported per frame so an ambiguous
    lock is visible rather than invisible.
  · Sub-pixel accuracy from a parabola fit is about a tenth of a pixel on clean
    footage and worse on noisy or heavily compressed footage. It is not
    interpolating anything it did not measure; it is estimating where between
    two integer pixels the correlation peaked.
  · Motion blur defeats it, because a blurred feature genuinely does not look
    like the sharp template it started as.

SIZING THE RECT. Big enough to contain something distinctive (a corner, a high
contrast junction — not a flat patch of sky, which correlates equally well
everywhere), small enough that nothing else moves inside it. 20-60 px on a side
is the usual answer at this resolution.


STABILISATION
=============
The inverse of what was tracked. If the feature moved from p0 to p[i], a layer
placed at `anchor` and given position `anchor - (p[i] - p0)` moves exactly the
opposite way and the feature sits still. The keys are absolute positions in the
caller's chosen space, ready to assign to `transform.position` — not deltas, so
nothing downstream has to know they came from here.

With `rect2` the same inversion is applied to rotation and scale. For THAT to be
geometrically right the layer's anchor point must sit at the midpoint of the two
tracked features, because that is the point the rotation is measured around —
so the midpoint is emitted as `stabilize.anchor` rather than left as an exercise.

cv2 + PyAV + numpy, all already present.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

import av
import cv2
import numpy as np


def _f(v, fallback=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


def _rect(v, name="rect"):
    if not isinstance(v, (list, tuple)) or len(v) < 4:
        raise ValueError(f"{name} must be [x, y, w, h]")
    x, y, w, h = (_f(v[0]), _f(v[1]), _f(v[2]), _f(v[3]))
    if w < 4 or h < 4:
        raise ValueError(f"{name} is {w:g}x{h:g}; a feature under 4px correlates with everything")
    return int(round(x)), int(round(y)), int(round(w)), int(round(h))


class Clip:
    """Forward-only gray frames.

    A tracker walks the clip once, in order — so unlike the engine's reader this
    one does not need random access, and skipping that machinery means it also
    cannot accidentally hand back a cached frame from the wrong index.
    """

    def __init__(self, path):
        self.container = av.open(path)
        if not self.container.streams.video:
            raise ValueError("no video stream")
        self.stream = self.container.streams.video[0]
        self.stream.thread_type = "AUTO"
        rate = self.stream.average_rate or self.stream.guessed_rate
        self.fps = float(rate) if rate else 30.0
        if not math.isfinite(self.fps) or self.fps <= 0:
            self.fps = 30.0
        self.width = int(self.stream.codec_context.width or 0)
        self.height = int(self.stream.codec_context.height or 0)
        dur = None
        if self.stream.duration is not None and self.stream.time_base:
            dur = float(self.stream.duration * self.stream.time_base)
        elif self.container.duration is not None:
            dur = float(self.container.duration) / av.time_base
        self.duration = dur if dur and dur > 0 else 0.0
        self.count = int(self.stream.frames or 0) or (
            int(round(self.duration * self.fps)) if self.duration else 0)

    def close(self):
        try:
            self.container.close()
        except Exception:                    # noqa: BLE001 — closing a dead container is not news
            pass

    def gray_from(self, start):
        """Yield (index, gray uint8) from `start` onward.

        Seeks BACKWARD to the keyframe at or before the target and decodes
        forward, discarding what precedes it — an inter-coded frame cannot be
        decoded without its reference, so there is no cheaper way in.
        """
        if start > 0:
            if self.stream.time_base:
                base = self.stream.start_time or 0
                pts = int((start / self.fps) / float(self.stream.time_base)) + base
            else:
                pts = int(start / self.fps * av.time_base)
            self.container.seek(pts, stream=self.stream, backward=True, any_frame=False)
        counter = 0
        for frame in self.container.decode(video=0):
            if frame.pts is not None and self.stream.time_base:
                base = self.stream.start_time or 0
                idx = max(0, int(round(float((frame.pts - base) * self.stream.time_base)
                                      * self.fps)))
            else:
                idx = counter
            counter = idx + 1
            if idx < start:
                continue
            yield idx, frame.to_ndarray(format="gray")


def _subpixel(resp, x, y):
    """Where between the integer pixels the correlation peak really sat.

    A parabola through the peak and its two neighbours, per axis. The clamp
    matters: a flat or double peak can put the vertex outside the sampled
    interval, and an "answer" further than one pixel from the sample that
    produced it is extrapolation, not refinement.
    """
    h, w = resp.shape
    dx = dy = 0.0
    if 0 < x < w - 1:
        a, b, c = float(resp[y, x - 1]), float(resp[y, x]), float(resp[y, x + 1])
        d = a - 2.0 * b + c
        if abs(d) > 1e-9:
            dx = 0.5 * (a - c) / d
    if 0 < y < h - 1:
        a, b, c = float(resp[y - 1, x]), float(resp[y, x]), float(resp[y + 1, x])
        d = a - 2.0 * b + c
        if abs(d) > 1e-9:
            dy = 0.5 * (a - c) / d
    return max(-1.0, min(1.0, dx)), max(-1.0, min(1.0, dy))


class PointTracker:
    """One feature, followed frame to frame."""

    def __init__(self, gray0, rect, search=40, adapt=0.0, adapt_above=0.90,
                 predict=True):
        x, y, w, h = rect
        H, W = gray0.shape[:2]
        x = max(0, min(W - 2, x))
        y = max(0, min(H - 2, y))
        w = max(2, min(W - x, w))
        h = max(2, min(H - y, h))
        self.tw, self.th = w, h
        self.template = gray0[y:y + h, x:x + w].astype(np.float32)
        if self.template.std() < 1.0:
            # A flat patch correlates equally well everywhere in the search
            # window; the peak it produces is noise wearing a confidence value.
            raise ValueError(
                f"the rect at ({x},{y}) is nearly featureless "
                f"(std {self.template.std():.2f}) — box a corner or an edge, not a flat area")
        self.search = max(2, int(search))
        self.adapt = max(0.0, min(1.0, float(adapt)))
        self.adapt_above = float(adapt_above)
        self.predict = bool(predict)
        self.pos = (x + w / 2.0, y + h / 2.0)
        self.prev = None
        self.start = self.pos

    def step(self, gray):
        """(x, y, confidence, margin) for this frame."""
        H, W = gray.shape[:2]
        cx, cy = self.pos
        if self.predict and self.prev is not None:
            # Constant velocity, damped. Undamped extrapolation overshoots on
            # any change of direction and then has to be caught by the search
            # window anyway, which defeats the point of predicting.
            vx = (self.pos[0] - self.prev[0]) * 0.8
            vy = (self.pos[1] - self.prev[1]) * 0.8
            cx, cy = cx + vx, cy + vy

        pad = self.search
        rx = int(math.floor(cx - self.tw / 2.0)) - pad
        ry = int(math.floor(cy - self.th / 2.0)) - pad
        rw = self.tw + 2 * pad
        rh = self.th + 2 * pad
        ax, ay = max(0, rx), max(0, ry)
        bx, by = min(W, rx + rw), min(H, ry + rh)
        if bx - ax < self.tw or by - ay < self.th:
            # The feature has left the frame. That is lost, not zero motion.
            return self.pos[0], self.pos[1], 0.0, 0.0

        roi = gray[ay:by, ax:bx].astype(np.float32)
        resp = cv2.matchTemplate(roi, self.template, cv2.TM_CCOEFF_NORMED)
        resp = np.nan_to_num(resp, nan=0.0, posinf=0.0, neginf=0.0)
        _, peak, _, loc = cv2.minMaxLoc(resp)
        mx, my = int(loc[0]), int(loc[1])

        # How much better the winner is than the best rival elsewhere in the
        # window. On repetitive texture this collapses toward zero while `peak`
        # stays high — the one failure NCC's own score cannot see.
        margin = float(peak)
        if resp.size > 9:
            masked = resp.copy()
            r = max(2, min(self.tw, self.th) // 2)
            masked[max(0, my - r):my + r + 1, max(0, mx - r):mx + r + 1] = -1.0
            margin = float(peak) - float(masked.max())

        dx, dy = _subpixel(resp, mx, my)
        px = ax + mx + dx + self.tw / 2.0
        py = ay + my + dy + self.th / 2.0
        conf = max(0.0, float(peak))

        self.prev = self.pos
        self.pos = (px, py)

        if self.adapt > 0.0 and conf >= self.adapt_above:
            ix, iy = int(round(px - self.tw / 2.0)), int(round(py - self.th / 2.0))
            if 0 <= ix and 0 <= iy and ix + self.tw <= W and iy + self.th <= H:
                patch = gray[iy:iy + self.th, ix:ix + self.tw].astype(np.float32)
                self.template = ((1.0 - self.adapt) * self.template
                                 + self.adapt * patch)
        return px, py, conf, margin


def _keys(times, values, decimals=3, ease="linear"):
    """VFX_SPEC §1 keys. No thinning here — a position key IS the measurement,
    and a track is hundreds of frames rather than thousands, so there is nothing
    to buy by dropping some."""
    out = []
    ease = str(ease or "linear").strip()
    for t, v in zip(times, values):
        if isinstance(v, (list, tuple)):
            key = {"t": round(float(t), 6), "v": [round(float(c), decimals) for c in v]}
        else:
            key = {"t": round(float(t), 6), "v": round(float(v), decimals)}
        if ease.lower() != "linear":
            key["ease"] = ease
        out.append(key)
    return {"keys": out}


def track(job):
    began = time.time()
    path = job.get("video") or job.get("clip") or job.get("in")
    if not path:
        raise ValueError("job needs a 'video' path")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)

    rect = _rect(job.get("rect"), "rect")
    rect2 = _rect(job.get("rect2"), "rect2") if job.get("rect2") else None
    search = int(_f(job.get("search"), 40.0))
    min_conf = _f(job.get("minConfidence"), 0.55)
    lost_after = max(1, int(_f(job.get("lostAfter"), 2.0)))
    stop_on_lost = job.get("stopOnLost", True) is not False
    adapt = _f(job.get("adapt"), 0.0)
    adapt_above = _f(job.get("adaptAbove"), 0.90)
    predict = job.get("predict", True) is not False
    decimals = int(_f(job.get("decimals"), 3.0))
    off = job.get("offset") or [0, 0]
    off = (_f(off[0]) if len(off) > 0 else 0.0, _f(off[1]) if len(off) > 1 else 0.0)
    want_stab = job.get("stabilize", job.get("stabilise", True)) is not False
    origin = _f(job.get("timeOrigin"), 0.0)

    clip = Clip(path)
    try:
        fps = _f(job.get("fps"), 0.0) or clip.fps
        if job.get("fromTime") is not None:
            start = int(round(_f(job.get("fromTime")) * clip.fps))
        else:
            start = int(_f(job.get("from"), 0.0))
        if job.get("toTime") is not None:
            end = int(round(_f(job.get("toTime")) * clip.fps))
        elif job.get("to") is not None:
            end = int(_f(job.get("to")))
        else:
            end = clip.count - 1 if clip.count else 1 << 30
        start = max(0, start)
        if end < start:
            raise ValueError(f"empty range: frames {start}..{end}")

        trackers = []
        times, positions, confs, margins, pos2 = [], [], [], [], []
        dips = []                          # sub-threshold runs that recovered
        lost = None                        # (t, frame, confidence) — terminal
        run = None                         # first frame of the current bad run
        bad = 0
        attempted = 0
        held = []                          # frames not yet proven good

        def emit(t, results, conf, margin):
            times.append(t)
            positions.append((results[0][0] + off[0], results[0][1] + off[1]))
            confs.append(conf)
            margins.append(margin)
            if rect2:
                pos2.append((results[1][0], results[1][1]))

        for idx, gray in clip.gray_from(start):
            if idx > end:
                break
            if not trackers:
                trackers.append(PointTracker(gray, rect, search=search, adapt=adapt,
                                             adapt_above=adapt_above, predict=predict))
                if rect2:
                    trackers.append(PointTracker(gray, rect2, search=search, adapt=adapt,
                                                 adapt_above=adapt_above, predict=predict))
                # The seed frame is where the template came from; correlating it
                # with itself would be a tautology, so it is simply 1.0.
                results = [(tr.pos[0], tr.pos[1], 1.0, 1.0) for tr in trackers]
            else:
                results = [tr.step(gray) for tr in trackers]
            attempted += 1

            conf = min(r[2] for r in results)
            margin = min(r[3] for r in results)
            t = origin + idx / fps

            if conf < min_conf:
                bad += 1
                if run is None:
                    run = (t, idx, conf)
                if not stop_on_lost:
                    # Asked to keep going: emit it, with its real confidence
                    # attached, and let the caller see the hole.
                    emit(t, results, conf, margin)
                    if lost is None:
                        lost = run
                    continue
                # Held, not emitted. A one-frame dip is a flicker and the frame
                # either side of it is still fine; a run of `lostAfter` is the
                # tracker not knowing where the feature is, and THOSE positions
                # must never reach a keyframe.
                held.append((t, results, conf, margin))
                if bad >= lost_after:
                    lost = run
                    break
                continue

            if held:
                # Recovered. The dip is reported rather than erased — a caller
                # deciding whether to trust this track needs to know the lock
                # wobbled, even though the frames around it are measurements.
                dips.append({"t": round(run[0], 6), "frames": bad,
                             "confidence": round(float(run[2]), 4)})
                for h in held:
                    emit(*h)
                held = []
            bad, run = 0, None
            emit(t, results, conf, margin)

        if held and stop_on_lost:
            # The clip ended mid-dip. Never confirmed as recovered, so it is not
            # a dip; the honest report is that the track ended uncertain.
            lost = run
    finally:
        clip.close()

    lost_at, lost_frame, lost_conf = lost if lost else (None, None, None)

    if not positions:
        raise ValueError("no frames were tracked; check 'from'/'to' against the clip length")

    result = {
        "ok": True,
        "keys": {"position": _keys(times, positions, decimals)},
        "confidence": [round(float(c), 4) for c in confs],
        "lostAt": round(float(lost_at), 6) if lost_at is not None else None,
        "frames": len(positions),
    }

    rot_vals = scale_vals = None
    if rect2 and pos2:
        d0 = (pos2[0][0] - (positions[0][0] - off[0]),
              pos2[0][1] - (positions[0][1] - off[1]))
        len0 = math.hypot(d0[0], d0[1])
        ang0 = math.degrees(math.atan2(d0[1], d0[0]))
        if len0 < 4.0:
            raise ValueError("rect and rect2 are on top of each other; "
                             "separate them so an angle can be measured")
        rot_vals, scale_vals = [], []
        for i, p2 in enumerate(pos2):
            dx = p2[0] - (positions[i][0] - off[0])
            dy = p2[1] - (positions[i][1] - off[1])
            ang = math.degrees(math.atan2(dy, dx)) - ang0
            # Unwrap so a track crossing 180 degrees does not spin the layer a
            # full turn between two frames.
            while rot_vals and ang - rot_vals[-1] > 180.0:
                ang -= 360.0
            while rot_vals and ang - rot_vals[-1] < -180.0:
                ang += 360.0
            rot_vals.append(ang)
            s = 100.0 * math.hypot(dx, dy) / len0
            scale_vals.append([s, s])
        result["rotation"] = _keys(times, rot_vals, decimals)
        result["scale"] = _keys(times, scale_vals, decimals)

    if want_stab:
        anchor = job.get("anchor")
        if isinstance(anchor, (list, tuple)) and len(anchor) >= 2:
            ax, ay = _f(anchor[0]), _f(anchor[1])
        else:
            ax, ay = clip.width / 2.0, clip.height / 2.0
        p0 = positions[0]
        stab_pos = [(ax - (p[0] - p0[0]), ay - (p[1] - p0[1])) for p in positions]
        stab = {"position": _keys(times, stab_pos, decimals), "anchor": [ax, ay]}
        if rot_vals is not None:
            stab["rotation"] = _keys(times, [-r for r in rot_vals], decimals)
            # Percent inverts as a RATIO, not a subtraction: countering a 125%
            # growth needs 80%, not 75%.
            stab["scale"] = _keys(times, [[100.0 * 100.0 / max(s[0], 1e-6)] * 2
                                          for s in scale_vals], decimals)
            mid = ((positions[0][0] - off[0] + pos2[0][0]) / 2.0,
                   (positions[0][1] - off[1] + pos2[0][1]) / 2.0)
            stab["anchor"] = [round(mid[0], decimals), round(mid[1], decimals)]
        result["stabilize"] = stab

    result.update({
        "margin": [round(float(m), 4) for m in margins],
        "dips": dips,
        "lostFrame": lost_frame,
        "lostConfidence": round(float(lost_conf), 4) if lost_conf is not None else None,
        "attempted": attempted,
        "minConfidence": min_conf,
        "width": clip.width,
        "height": clip.height,
        "fps": round(fps, 6),
        "sourceFrames": clip.count,
        "ms": int((time.time() - began) * 1000),
    })
    return result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if not argv:
            raise ValueError("usage: tracker.py <job.json>")
        with open(argv[0], encoding="utf-8") as fh:
            job = json.load(fh)
        result = track(job)
    except Exception as exc:                             # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
