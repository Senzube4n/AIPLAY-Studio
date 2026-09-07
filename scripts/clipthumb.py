"""One poster frame for a clip, so the library can be pictures instead of video.

WHY THIS EXISTS. The clip grid rendered one <video> per clip, and the folder now
holds 438 of them. Even with preload="none" and an observer, that is 438 media
elements in the DOM, and every one that scrolls into view pulls 1-3 MB of MP4 to
show a single still. A 480px JPEG of the same frame is around 25 KB — roughly a
hundredth of the bytes, and an <img> the browser can lazy-load natively without
any observer at all.

NOT ffmpeg. The export path deliberately avoids depending on it (studio.js says
so, at length), and OpenCV is already installed here because the flow gate needs
it. Same precedent as beats.py and clipflow.py: a small python subprocess, JSON
on stdout, cached on disk by the caller.

THE FRAME IS NOT FRAME 0. Clips routinely open on black or part-way through a
fade, and a contact sheet of black tiles is worse than no contact sheet. Take
0.5s in, or 15% of the way through for anything shorter, and fall back to the
first decodable frame if the seek fails — some containers refuse to seek.
"""
import json
import os
import sys

import cv2


def poster(src, dest, width=480):
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        return {"error": "could not open the clip"}
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    dur = total / fps if fps > 0 else 0.0

    target = min(0.5, dur * 0.15) if dur > 0 else 0.5
    frame = None
    got_at = target
    if target > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(target * fps))
        ok, fr = cap.read()
        if ok:
            frame = fr
    if frame is None:
        # Seek refused, or the clip is shorter than the target. Rewind and take
        # whatever decodes first rather than failing the whole thumbnail.
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ok, fr = cap.read()
        if not ok:
            cap.release()
            return {"error": "no decodable frame"}
        frame = fr
        got_at = 0.0
    cap.release()

    h, w = frame.shape[:2]
    if w > width:
        frame = cv2.resize(frame, (width, max(1, round(h * width / w))),
                           interpolation=cv2.INTER_AREA)

    # `or "."` because dirname of a bare filename is "" and makedirs("") raises.
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    # Encode first, THEN write. cv2.imwrite opens for writing before it knows the
    # encode succeeded, and a half-written JPEG in a cache is worse than a miss.
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        return {"error": "could not encode a jpeg"}
    with open(dest, "wb") as f:
        f.write(buf.tobytes())
    return {"ok": True, "dest": dest, "width": frame.shape[1], "height": frame.shape[0],
            # The frame we GOT, not the one we asked for: the fallback takes
            # frame 0 when a seek is refused, and labelling that with the
            # target time puts a quietly wrong number in the cache.
            "bytes": int(buf.size), "atSec": round(got_at, 3)}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: clipthumb.py <src> <dest> [width]"}))
        return 1
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 480
    try:
        r = poster(sys.argv[1], sys.argv[2], width)
    except Exception as e:                                   # noqa: BLE001
        r = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(r))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
