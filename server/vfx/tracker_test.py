"""Unit tests for server/vfx/tracker.py.

Every clip here is drawn frame by frame from a known path and encoded with PyAV
at crf 0, so the truth is arithmetic rather than opinion: the tracked keys can be
compared against the exact pixel the feature was painted at. Lossless matters —
at crf 23 the assertions below would be measuring h264's ringing as much as the
tracker's accuracy.

The interesting cases are the ones where it is supposed to FAIL: a feature that
gets occluded, a rect with no detail in it, and a repeating pattern where the
correlation is confident and wrong. A tracker is only useful if those three
report themselves, so each has an assertion.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/tracker_test.py

The last section MEASURES rather than asserts — 100 frames of 864x480 — and
prints it.
"""
import contextlib
import io
import json
import math
import os
import sys
import tempfile
import time

import av
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import interp    # noqa: E402
import tracker   # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    eq(f"{name} (|{got:.3f} - {want:.3f}| <= {tol})", abs(got - want) <= tol, True)


FPS = 30


def encode(path, frames, fps=FPS):
    """Lossless h264. The fixture must not be the reason a pixel moved."""
    h, w = frames[0].shape[:2]
    c = av.open(path, "w")
    s = c.add_stream("libx264", rate=fps)
    s.width, s.height = w, h
    s.pix_fmt = "yuv420p"
    s.options = {"crf": "0", "preset": "ultrafast"}
    for i, img in enumerate(frames):
        f = av.VideoFrame.from_ndarray(np.ascontiguousarray(img), format="rgb24")
        f.pts = i
        for pkt in s.encode(f):
            c.mux(pkt)
    for pkt in s.encode(None):
        c.mux(pkt)
    c.close()
    return path


def backdrop(w, h, seed=5):
    """Static, low-contrast, non-uniform. A flat background would let a lost
    tracker sit anywhere and still score well. The one deliberately FLAT patch
    at (10,190) is there to be tracked at, so the refusal can be tested."""
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 26, (h, w, 3)).astype(np.uint8)
    img += (np.arange(w, dtype=np.uint8)[None, :, None] // 10)
    img[190:230, 10:70] = 60
    return img


def stamp(img, cx, cy, size=28):
    """A square with an internal corner, so the correlation peak is a point and
    not a ridge. CLIPPED at the frame edge, not clamped — a feature that walks
    off the side has to actually leave, or the "lost when it exits" case cannot
    be tested."""
    x, y = int(round(cx - size / 2)), int(round(cy - size / 2))
    h, w = img.shape[:2]
    blk = np.full((size, size, 3), 235, np.uint8)
    blk[:size // 2, :size // 2] = 80
    blk[size // 2:, size // 2:] = 155
    sx, sy = max(0, -x), max(0, -y)
    ex, ey = min(size, w - x), min(size, h - y)
    if ex > sx and ey > sy:
        img[y + sy:y + ey, x + sx:x + ex] = blk[sy:ey, sx:ex]
    return img


def swerve(i):
    """The truth: a rightward drift with a vertical sine on top of it."""
    return 110.0 + 3.0 * i, 130.0 + 40.0 * math.sin(i / 9.0)


def clip_frames(n, w=320, h=240, occlude=None, size=28):
    out = []
    base = backdrop(w, h)
    for i in range(n):
        img = base.copy()
        cx, cy = swerve(i)
        stamp(img, cx, cy, size)
        if occlude and occlude[0] <= i < occlude[1]:
            # A textured bar, not a black one: NCC against a flat patch is
            # undefined, and "undefined" would be testing OpenCV's guard rather
            # than this tracker's behaviour under occlusion.
            x = max(0, int(cx) - 34)
            bar = np.full((h, 68, 3), 120, np.uint8)
            bar[::5, :] = 205
            img[:, x:x + bar.shape[1]] = bar[:, :img[:, x:x + 68].shape[1]]
        out.append(img)
    return out


print("\ntracker\n")

with tempfile.TemporaryDirectory() as tmp:

    # -- a clean track follows the truth --------------------------------------
    clean = encode(os.path.join(tmp, "clean.mp4"), clip_frames(60))
    x0, y0 = swerve(0)
    r = tracker.track({"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36], "search": 30})
    keys = r["keys"]["position"]["keys"]
    eq("it tracks every frame it was given", r["frames"], 60)
    eq("confidence is reported once per key", len(r["confidence"]), len(keys))
    errs = []
    for k in keys:
        i = int(round(k["t"] * r["fps"]))
        tx, ty = swerve(i)
        errs.append(math.hypot(k["v"][0] - tx, k["v"][1] - ty))
    eq(f"every key lands within 2 px of the truth (worst {max(errs):.2f})",
       max(errs) < 2.0, True)
    eq(f"and typically much closer (mean {np.mean(errs):.2f})", np.mean(errs) < 0.5, True)
    eq("confidence stays high on clean footage", min(r["confidence"]) > 0.9, True)
    eq("nothing was lost", (r["lostAt"], r["lostFrame"], r["dips"]), (None, None, []))
    eq("keys are sorted in time",
       all(keys[i - 1]["t"] < keys[i]["t"] for i in range(1, len(keys))), True)
    eq("a position key is a 2-vector", len(keys[0]["v"]), 2)
    eq("every key carries only t and v",
       sum(1 for k in keys if set(k) - {"t", "v"}), 0)
    # Read back through the engine's OWN evaluator: the keys are only useful if
    # the compositor can already evaluate them.
    mid = interp.eval_prop(r["keys"]["position"], keys[20]["t"])
    eq("the engine's evaluator reads them as §1 keys", [round(v, 3) for v in mid],
       keys[20]["v"])
    tween = interp.eval_prop(r["keys"]["position"], (keys[20]["t"] + keys[21]["t"]) / 2)
    eq("and interpolates between them",
       keys[20]["v"][0] < tween[0] < keys[21]["v"][0], True)

    # -- sub-pixel, on a path that is not made of whole pixels ----------------
    # `stamp` paints at integer coordinates, so the clean clip above cannot
    # prove sub-pixel accuracy — its truth is quantised too. Shifting the WHOLE
    # frame with a bilinear warp gives a fractional ground truth, and doubles as
    # the realistic case for stabilisation: camera shake.
    import cv2  # noqa: E402
    shake_base = backdrop(320, 240, seed=12)
    stamp(shake_base, 160, 120, 30)

    def shake_at(i):
        # Both axes start at zero, so the seed rect really is centred on the
        # feature at frame 0 — otherwise every later position is measured
        # against a truth the template never agreed with.
        return 4.7 * math.sin(i / 5.0), 3.3 * math.sin(i / 3.5)

    shaken = []
    for i in range(40):
        dx, dy = shake_at(i)
        M = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], dtype=np.float64)
        shaken.append(cv2.warpAffine(shake_base, M, (320, 240),
                                     flags=cv2.INTER_LINEAR,
                                     borderMode=cv2.BORDER_REFLECT))
    sh = tracker.track({"video": encode(os.path.join(tmp, "shake.mp4"), shaken),
                        "rect": [145, 105, 30, 30], "search": 16})
    sk_ = sh["keys"]["position"]["keys"]
    sub_err = max(math.hypot(sk_[i]["v"][0] - (160.0 + shake_at(i)[0]),
                             sk_[i]["v"][1] - (120.0 + shake_at(i)[1]))
                  for i in range(len(sk_)))
    eq(f"a fractional-pixel path is followed to within a quarter pixel "
       f"(worst {sub_err:.3f})", sub_err < 0.25, True)
    eq("positions are not snapped to whole pixels",
       sum(1 for k in sk_ if abs(k["v"][0] - round(k["v"][0])) > 0.05) > 20, True)
    shake_stab = sh["stabilize"]["position"]["keys"]
    residual = max(math.hypot(shake_stab[i]["v"][0] - shake_stab[0]["v"][0] + shake_at(i)[0]
                              - shake_at(0)[0],
                              shake_stab[i]["v"][1] - shake_stab[0]["v"][1] + shake_at(i)[1]
                              - shake_at(0)[1])
                   for i in range(len(shake_stab)))
    eq(f"applying the stabilisation keys would cancel the shake to a quarter "
       f"pixel (worst {residual:.3f})", residual < 0.25, True)

    # -- stabilisation --------------------------------------------------------
    stab = r["stabilize"]["position"]["keys"]
    p0 = keys[0]["v"]
    s0 = stab[0]["v"]
    dev = max(max(abs((stab[i]["v"][0] - s0[0]) + (keys[i]["v"][0] - p0[0])),
                  abs((stab[i]["v"][1] - s0[1]) + (keys[i]["v"][1] - p0[1])))
              for i in range(len(keys)))
    eq(f"stabilisation is the exact negation of the motion (dev {dev:.4f})",
       dev < 0.002, True)
    eq("stabilisation defaults to the clip centre", r["stabilize"]["anchor"],
       [160.0, 120.0])
    eq("the first stabilisation key sits at the anchor", stab[0]["v"], [160.0, 120.0])
    r_anchor = tracker.track({"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36],
                              "search": 30, "anchor": [500, 400], "to": 10})
    eq("a given anchor is honoured",
       r_anchor["stabilize"]["position"]["keys"][0]["v"], [500.0, 400.0])
    eq("stabilize:false leaves it out",
       "stabilize" in tracker.track({"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36],
                                     "to": 6, "stabilize": False}), False)

    # -- occlusion is reported, not tracked through ---------------------------
    occ = encode(os.path.join(tmp, "occ.mp4"), clip_frames(60, occlude=(30, 42)))
    o = tracker.track({"video": occ, "rect": [x0 - 18, y0 - 18, 36, 36], "search": 30})
    eq("occlusion is reported as lost", o["lostAt"] is not None, True)
    near("and at the frame the occluder arrived", o["lostFrame"], 30, 1)
    eq("the confidence that triggered it is published",
       o["lostConfidence"] < o["minConfidence"], True)
    eq("no keys are emitted past the loss", o["frames"] <= 31, True)
    eq("and the keys it did emit are still accurate",
       max(math.hypot(k["v"][0] - swerve(int(round(k["t"] * o["fps"])))[0],
                      k["v"][1] - swerve(int(round(k["t"] * o["fps"])))[1])
           for k in o["keys"]["position"]["keys"]) < 2.0, True)
    # The whole argument for NCC over LK: the score has to COLLAPSE, not wobble.
    eq("the last confidence before stopping is high", o["confidence"][-1] > 0.9, True)

    o2 = tracker.track({"video": occ, "rect": [x0 - 18, y0 - 18, 36, 36], "search": 30,
                        "stopOnLost": False})
    eq("stopOnLost:false keeps going to the end", o2["frames"], 60)
    eq("but still reports where it lost lock", o2["lostAt"] is not None, True)
    eq("and the confidences show the hole", min(o2["confidence"]) < 0.55, True)
    eq("with the low frames actually in the array",
       sum(1 for c in o2["confidence"] if c < 0.55) >= 5, True)

    # NCC is invariant to linear brightness change by construction, so dimming a
    # frame does NOT dip it — a one-frame occlusion is what a real flicker looks
    # like to this detector.
    dim = clip_frames(6)
    dim[3] = (dim[3].astype(np.int16) // 3).astype(np.uint8)
    d = tracker.track({"video": encode(os.path.join(tmp, "dim.mp4"), dim),
                       "rect": [x0 - 18, y0 - 18, 36, 36], "search": 30})
    eq("a 3x brightness drop does not disturb the correlation at all",
       (min(d["confidence"]) > 0.9, d["lostAt"]), (True, None))

    # A one-frame occlusion is a dip, not a loss — otherwise every passing
    # foreground object would end a usable track.
    fl = tracker.track({"video": encode(os.path.join(tmp, "flick.mp4"),
                                        clip_frames(40, occlude=(20, 21))),
                        "rect": [x0 - 18, y0 - 18, 36, 36], "search": 30,
                        "lostAfter": 3})
    eq("a one-frame dip does not end the track", fl["frames"], 40)
    eq("but it is reported rather than smoothed over", len(fl["dips"]) >= 1, True)
    eq("the dip names its time and depth",
       sorted(fl["dips"][0]), ["confidence", "frames", "t"])

    # -- a feature that leaves the frame --------------------------------------
    away = []
    base = backdrop(320, 240)
    for i in range(40):
        img = base.copy()
        stamp(img, 160 + 9.0 * i, 120)         # walks off the right edge
        away.append(img)
    a = tracker.track({"video": encode(os.path.join(tmp, "away.mp4"), away),
                       "rect": [146, 106, 28, 28], "search": 30})
    eq("a feature leaving the frame is lost, not frozen", a["lostAt"] is not None, True)
    eq("and the track stops well before the end", a["frames"] < 30, True)

    # -- honest refusals ------------------------------------------------------
    def refuses(name, job, needle):
        try:
            tracker.track(job)
        except Exception as exc:             # noqa: BLE001
            eq(name, needle in str(exc).lower(), True)
            return
        eq(name, "no exception", f"an error mentioning {needle!r}")

    refuses("a featureless rect is refused, not tracked",
            {"video": clean, "rect": [20, 195, 30, 30]}, "featureless")
    refuses("a 2px rect is refused", {"video": clean, "rect": [10, 10, 2, 2]}, "under 4px")
    refuses("a malformed rect is refused", {"video": clean, "rect": [1, 2]}, "[x, y, w, h]")
    refuses("a missing video is refused", {"video": os.path.join(tmp, "no.mp4"),
                                           "rect": [10, 10, 20, 20]}, "no.mp4")
    refuses("an inverted range is refused",
            {"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36], "from": 20, "to": 5},
            "empty range")

    # -- the failure NCC's own score cannot see -------------------------------
    # A repeating pattern correlates just as well on the wrong copy. Confidence
    # stays near 1 and is USELESS; `margin` is what makes it visible.
    stripes = []
    for i in range(30):
        x = np.arange(320)
        row = 128 + 100 * np.sin(2 * np.pi * (x - 2.0 * i) / 24.0)
        img = np.repeat(row[None, :], 240, axis=0)
        img = img + np.linspace(-25, 25, 240)[:, None]
        stripes.append(np.clip(np.repeat(img[:, :, None], 3, axis=2), 0, 255).astype(np.uint8))
    st = tracker.track({"video": encode(os.path.join(tmp, "stripes.mp4"), stripes),
                        "rect": [140, 100, 40, 40], "search": 40})
    eq("a repeating pattern still scores high confidence",
       max(st["confidence"][1:]) > 0.9, True)
    eq("but its margin collapses, which is the honest signal",
       min(st["margin"][1:]) < 0.25, True)
    eq("a real feature keeps a wide margin", min(r["margin"][1:]) > 0.4, True)

    # -- 2-point: rotation and scale ------------------------------------------
    rot = []
    base = backdrop(400, 300, seed=9)
    truth_rot, truth_scale = [], []
    for i in range(45):
        img = base.copy()
        ang = math.radians(1.6 * i)
        rad = 70.0 * (1.0 + 0.005 * i)
        stamp(img, 200 + rad * math.cos(ang), 150 + rad * math.sin(ang), 26)
        stamp(img, 200 - rad * math.cos(ang), 150 - rad * math.sin(ang), 26)
        rot.append(img)
        truth_rot.append(1.6 * i)
        truth_scale.append(100.0 * (1.0 + 0.005 * i) / 1.0)
    two = tracker.track({"video": encode(os.path.join(tmp, "rot.mp4"), rot),
                         "rect": [200 + 70 - 13, 150 - 13, 26, 26],
                         "rect2": [200 - 70 - 13, 150 - 13, 26, 26],
                         "search": 24})
    eq("2-point tracking emits rotation and scale",
       ("rotation" in two and "scale" in two), True)
    rk = two["rotation"]["keys"]
    sk = two["scale"]["keys"]
    eq("rotation starts at zero", rk[0]["v"], 0.0)
    eq("scale starts at 100%", sk[0]["v"], [100.0, 100.0])
    rerr = max(abs(rk[i]["v"] - truth_rot[int(round(rk[i]["t"] * two["fps"]))])
               for i in range(len(rk)))
    serr = max(abs(sk[i]["v"][0] - truth_scale[int(round(sk[i]["t"] * two["fps"]))])
               for i in range(len(sk)))
    eq(f"rotation is within a degree (worst {rerr:.3f})", rerr < 1.0, True)
    eq(f"scale is within a percent (worst {serr:.3f})", serr < 1.0, True)
    eq("scale is a 2-vector, ready for transform.scale", len(sk[0]["v"]), 2)
    st2 = two["stabilize"]
    eq("stabilising rotation negates it",
       round(st2["rotation"]["keys"][-1]["v"] + rk[-1]["v"], 3), 0.0)
    # Percent inverts as a ratio: countering 122% needs 82%, not 78%.
    near("stabilising scale inverts the ratio",
         st2["scale"]["keys"][-1]["v"][0] * sk[-1]["v"][0] / 100.0, 100.0, 0.01)
    near("and the anchor it must pivot around is the pair's midpoint",
         st2["anchor"][0], 200.0, 1.5)
    refuses("two rects on top of each other are refused",
            {"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36],
             "rect2": [x0 - 17, y0 - 18, 36, 36], "to": 6}, "on top of each other")

    # -- range, offset, timebase ----------------------------------------------
    part = tracker.track({"video": clean, "rect": list(swerve(10)) + [0, 0],
                          "from": 10, "to": 29, "search": 30,
                          "rect": [swerve(10)[0] - 18, swerve(10)[1] - 18, 36, 36]})
    eq("a frame range is honoured", part["frames"], 20)
    near("and its first key is at that frame's time",
         part["keys"]["position"]["keys"][0]["t"], 10.0 / FPS, 1e-6)
    off = tracker.track({"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36],
                         "to": 5, "offset": [1000, -500]})
    near("offset shifts every position",
         off["keys"]["position"]["keys"][0]["v"][0] - keys[0]["v"][0], 1000.0, 1e-6)
    orig = tracker.track({"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36],
                          "to": 5, "timeOrigin": 3.0})
    near("timeOrigin shifts every key time",
         orig["keys"]["position"]["keys"][0]["t"], 3.0, 1e-6)
    secs = tracker.track({"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36],
                          "fromTime": 0.2, "toTime": 0.5})
    eq("a range can be given in seconds", secs["frames"], 10)

    # -- the CLI --------------------------------------------------------------
    job = os.path.join(tmp, "job.json")
    with open(job, "w", encoding="utf-8") as fh:
        json.dump({"video": clean, "rect": [x0 - 18, y0 - 18, 36, 36], "to": 8}, fh)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = tracker.main([job])
    line = json.loads(buf.getvalue().strip())
    eq("the CLI exits 0 on success", code, 0)
    eq("the CLI prints one JSON line with the contract's keys",
       (line["ok"], "position" in line["keys"], isinstance(line["confidence"], list),
        "lostAt" in line, line["frames"]), (True, True, True, True, 9))

    with open(job, "w", encoding="utf-8") as fh:
        json.dump({"video": clean}, fh)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = tracker.main([job])
    eq("a job with no rect exits 1", code, 1)
    eq("and says so in one line", json.loads(buf.getvalue().strip())["ok"], False)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = tracker.main([])
    eq("no job at all exits 1", code, 1)

    # -- measured, not asserted -----------------------------------------------
    big = []
    base = backdrop(864, 480, seed=3)
    for i in range(100):
        img = base.copy()
        stamp(img, 120 + 6.0 * i, 240 + 90.0 * math.sin(i / 11.0), 40)
        big.append(img)
    bigpath = encode(os.path.join(tmp, "big.mp4"), big)
    began = time.time()
    m = tracker.track({"video": bigpath, "rect": [100, 220, 40, 40], "search": 40})
    wall = time.time() - began
    eq("the 864x480 benchmark clip tracked cleanly",
       (m["frames"], m["lostAt"]), (100, None))
    print(f"\n  measured  100 frames of 864x480, 40px feature, 40px search: "
          f"{wall:.2f}s ({wall * 1000 / 100:.1f} ms/frame, decode included)")

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
