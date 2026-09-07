"""Frames across a clip, as pictures a model can actually look at.

WHY THIS SITS WHERE IT DOES. There is a deterministic floor underneath it —
scripts/clipflow.py, which measures motion and answers yes or no about a frozen
tail, a slideshow, a still frame. This is the layer ABOVE that, and it is
deliberately weaker: it hands over pictures and lets something else form an
opinion.

⚠ AND THAT OPINION MAY ONLY EVER COMPARE. AutoMV measured Qwen-Omni scoring
nearly everything 4.7-5.0, and Gemini-2.5-Pro rating AutoMV's own output
4.30/4.55/4.59 where human experts gave 2.94/2.05/2.62 on the same footage. A
judge that saturates cannot hold a threshold, so nothing built on these frames
may gate a render. "Which of these two takes is better" is answerable. "Is this
take good enough" is not — that question belongs to clipflow.py, which measures.

THE FRAMES. Evenly spaced across the clip, and never frame 0: clips routinely
open on black or part-way through a fade, and the first tile of a contact strip
being black teaches the reader nothing. The same lesson as clipthumb.py, applied
to every sample rather than just the poster.

Base64 JPEG on stdout in the shape server/review.js already uses for images
({data, mimeType}), so the MCP transport's `_images` handling needs no new case.
"""
import base64
import json
import sys

import cv2


def frames(path, n=6, width=512, quality=82):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return {"error": "could not open the clip"}
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total <= 1:
        cap.release()
        return {"error": "not a video, or a single frame"}

    n = max(1, min(int(n), 12))
    # Skip the first and last 4% — the fade-in and the tail, neither of which is
    # representative, and the tail is exactly where a frozen ending hides.
    lo, hi = int(total * 0.04), int(total * 0.96)
    if hi <= lo:
        lo, hi = 0, total - 1
    idxs = [lo] if n == 1 else [round(lo + (hi - lo) * k / (n - 1)) for k in range(n)]

    out = []
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, fr = cap.read()
        if not ok:
            continue
        h, w = fr.shape[:2]
        if w > width:
            fr = cv2.resize(fr, (width, max(1, round(h * width / w))), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", fr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
        if not ok:
            continue
        out.append({
            "atSec": round(i / fps, 3),
            "frame": int(i),
            "data": base64.b64encode(buf.tobytes()).decode("ascii"),
            "mimeType": "image/jpeg",
        })
    cap.release()
    if not out:
        return {"error": "no decodable frames"}
    return {"ok": True, "fps": round(fps, 3), "frames": total,
            "durationSec": round(total / fps, 3), "sampled": len(out), "images": out}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: clipframes.py <video> [count] [width]"}))
        return 1
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    w = int(sys.argv[3]) if len(sys.argv) > 3 else 512
    try:
        r = frames(sys.argv[1], n, w)
    except Exception as e:                                   # noqa: BLE001
        r = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(r))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
