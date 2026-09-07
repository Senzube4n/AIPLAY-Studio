"""The SAME frame out of several clips, so a comparison can be looked at.

WHY THIS IS NOT clipframes.py. That script samples EVENLY across one clip and
deliberately skips the first and last 4% — the right shape for "show a model six
pictures of this take". A comparison needs the opposite: the same numbered frame
out of every arm, including frame 0, because frame 0 is where reference bleed
lives (docs/H3_REFERENCE_BLEED.md) and skipping it hides the finding. Evenly
spaced samples of two clips with different frame counts are not the same moment,
so a strip built from them compares two variables and reports one.

NOT ffmpeg, for the reason clipthumb.py already gives at length: the export path
deliberately avoids depending on it and OpenCV is installed here anyway.

FULL RESOLUTION, NEVER RESIZED. This exists so an 84 px face and a 58 px face can
be told apart, and the surest way to destroy that is to downscale on the way out.
The page decides how big to draw them; the file always holds every pixel the
render delivered, so click-to-zoom has something to zoom into.

SEQUENTIAL DECODE, NOT SEEK. cv2's CAP_PROP_POS_FRAMES seek lands on the nearest
keyframe on plenty of containers, so "frame 15" from a seek is frame 15 in one
arm and frame 12 in another — which is precisely the error this whole strip
exists to avoid. Decoding forward is exact. It costs a linear read up to the
LARGEST wanted index: nothing at all for the 49-124 frame clips this app makes,
and a one-off wait on some imported ten-minute file, after which the caller's
cache never asks again.

ONE CLAMP FOR EVERY ARM. The frames are clamped to the SHORTEST clip in the job,
not per clip. Clamping per clip would silently hand back frame 55 of one arm
beside frame 48 of another under the same column heading, which is a lie with a
number on it. The clamp is reported so the caller can say it out loud.

Job on stdin, JSON on stdout:

  {"destDir": "...", "frames": [0, 15, 60], "quality": 88,
   "clips": [{"key": "h3_quality", "src": "...mp4", "prefix": "9f1c…"}]}

`prefix` is the caller's content address for the source file; this writes
<destDir>/<prefix>.<frame>.jpg and skips any that is already there.
"""
import json
import os
import sys

import cv2

MAX_FRAMES = 8          # columns a person can actually compare at a glance
MAX_INDEX = 200_000     # a guard on the sequential read, not a real limit


def probe(cap):
    """Frame count and size without decoding anything."""
    return {
        "frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0),
        "fps": round(float(cap.get(cv2.CAP_PROP_FPS) or 0.0), 3),
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
    }


def wanted_frames(raw):
    """Whole, non-negative, sorted, unique, and not more than a strip can show."""
    out = []
    for v in raw or []:
        try:
            i = int(v)
        except (TypeError, ValueError):
            continue
        if 0 <= i <= MAX_INDEX and i not in out:
            out.append(i)
    out.sort()
    return out[:MAX_FRAMES]


def extract(src, dest_dir, prefix, idxs, quality):
    """Write the wanted frames of one clip. Returns the row for that clip."""
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        return {"error": "could not open the clip", "stills": []}
    info = probe(cap)
    fps = info["fps"] or 24.0

    todo = {}
    stills = []
    for i in idxs:
        name = "%s.%d.jpg" % (prefix, i)
        dest = os.path.join(dest_dir, name)
        row = {"frame": i, "atSec": round(i / fps, 3), "file": name,
               "w": info["width"], "h": info["height"]}
        if os.path.exists(dest):
            row["bytes"] = os.path.getsize(dest)
            row["cached"] = True
            stills.append(row)
        else:
            todo[i] = (dest, row)
            stills.append(row)

    if todo:
        os.makedirs(dest_dir, exist_ok=True)
        last = max(todo)
        at = 0
        while at <= last:
            ok, fr = cap.read()
            if not ok:
                break
            if at in todo:
                dest, row = todo[at]
                # Encode first, THEN write — the same rule clipthumb.py states:
                # a half-written JPEG in a cache is worse than a cache miss.
                enc, buf = cv2.imencode(".jpg", fr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
                if enc:
                    with open(dest, "wb") as f:
                        f.write(buf.tobytes())
                    row["bytes"] = int(buf.size)
                    row["cached"] = False
                    # The DECODED size, not the container's declared one. They
                    # agree on everything this app makes; when they ever
                    # disagree the file on disk is the truth.
                    row["h"], row["w"] = fr.shape[:2]
                else:
                    row["error"] = "could not encode a jpeg"
                del todo[at]
            at += 1
        for _i, (_dest, row) in todo.items():
            row["error"] = "the clip ended before this frame"
    cap.release()

    info["stills"] = [s for s in stills if "error" not in s]
    info["missing"] = [s for s in stills if "error" in s]
    return info


def run(job):
    dest_dir = job.get("destDir") or "."
    quality = int(job.get("quality") or 88)
    clips = job.get("clips") or []
    asked = wanted_frames(job.get("frames"))
    if not asked:
        return {"error": "no usable frame numbers were asked for"}
    if not clips:
        return {"error": "no clips to read"}

    # THE SHORTEST ARM SETS THE CEILING, and it is found before a single frame
    # is decoded, so every arm is asked for the identical list.
    lengths = []
    for c in clips:
        cap = cv2.VideoCapture(c.get("src") or "")
        if cap.isOpened():
            n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if n > 0:
                lengths.append({"key": c.get("key"), "frames": n})
        cap.release()
    if not lengths:
        return {"error": "none of these clips could be opened"}
    shortest = min(lengths, key=lambda x: x["frames"])
    ceiling = shortest["frames"] - 1
    frames = wanted_frames([min(i, ceiling) for i in asked])

    rows = []
    for c in clips:
        r = extract(c.get("src") or "", dest_dir, c.get("prefix") or "x", frames, quality)
        r["key"] = c.get("key")
        rows.append(r)

    out = {"ok": True, "frames": frames, "requested": asked, "clips": rows,
           "shortest": shortest, "ceiling": ceiling}
    if frames != asked:
        out["clamped"] = (
            "Frame %s does not exist in every arm: the shortest is %s at %d frames, so the "
            "strip stops at %d. Every arm is still showing the SAME frame numbers — a strip "
            "that clamped per arm would put different moments under one heading."
            % (", ".join(str(i) for i in asked if i > ceiling),
               shortest["key"], shortest["frames"], ceiling)
        )
    return out


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as e:                                   # noqa: BLE001
        print(json.dumps({"error": "unreadable job: %s" % e}))
        return 1
    try:
        r = run(job)
    except Exception as e:                                   # noqa: BLE001
        r = {"error": "%s: %s" % (type(e).__name__, e)}
    print(json.dumps(r))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
