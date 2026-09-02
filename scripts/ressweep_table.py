#!/usr/bin/env python3
"""Join the ladder's wall-clock to its face metrics and price a music video.

THE TRADE-OFF, made explicit. Two curves cross somewhere: face pixels rise with
size, render seconds rise faster. The decision is not "which is sharpest" but
the largest size whose TOTAL still fits a real video, so this prints both
columns next to each other and then the total.

Extrapolating 2 s -> 5 s. The clips measured here are 56 frames because the
question is spatial. A real clip is 124 (5 s at 24 fps, and 124 is the bottom of
H3's trained length range). Attention is quadratic in token count and tokens
scale with frames as well as pixels, so the scaling is NOT 124/56 = 2.21. Using
config.js's own fitted exponent 1.2 and its 15 s fixed cost:

    T(124) = 15 + (T(56) - 15) * (124/56)^1.2      (124/56)^1.2 = 2.60

which is an assumption, flagged as one, and cross-checked below against the
1344x768 x 124f figure already on file in config.js.
"""
import json, os, argparse

FIXED = 15.0                     # config.video.engines.h3.costFixedSeconds
FRAME_SCALE = (124 / 56) ** 1.2  # 2.596
VIDEO_SECONDS = 180              # a 3-minute song
CLIP_SECONDS = 5

ap = argparse.ArgumentParser()
ap.add_argument("--dir", default=r"D:\AI\aiplay-studio-bench\ComfyUI\output\ressweep")
a = ap.parse_args()

runs = json.load(open(os.path.join(a.dir, "ressweep.json")))
scores = {s["file"]: s for s in json.load(open(os.path.join(a.dir, "scores.json")))}

by_tag = {}
for r in runs["results"]:
    if "files" not in r:
        continue
    for f in r["files"]:
        by_tag[os.path.basename(f)] = r

clips = VIDEO_SECONDS / CLIP_SECONDS
print(f"H3 resolution ladder — {runs['length']} frames, {runs['steps']} steps, seed {runs['seed']}")
print(f"ref {runs['ref']}\n")
hdr = (f"{'requested':<12}{'actual':<12}{'Mpx':<7}{'2s clip':<9}{'5s clip*':<10}"
       f"{'face':<7}{'%frame':<8}{'mouth':<8}{'sharp':<9}{'36 clips*':<11}{'det'}")
print(hdr); print("-" * len(hdr))

rows = []
for name, r in sorted(by_tag.items(), key=lambda kv: (kv[1].get("warmRepeat", False), kv[1]["requested"])):
    s = scores.get(name)
    if not s:
        continue
    mpx = s["width"] * s["height"] / 1e6
    t5 = FIXED + (r["seconds"] - FIXED) * FRAME_SCALE
    total_h = t5 * clips / 3600
    warm = "  (warm repeat, seed+1)" if r.get("warmRepeat") else ""
    print(f"{r['requested']:<12}{s['width']}x{s['height']:<6}{mpx:<7.2f}"
          f"{r['seconds']:<9.0f}{t5:<10.0f}{s['face_px']:<7}{s['face_pct']:<8}"
          f"{s['mouth_px']:<8}{s['sharpness']:<9}{total_h:<11.1f}"
          f"{s['detected_on']}/{s['sampled']}{warm}")
    rows.append((r, s))

print("\n* 5s clip and 36-clip total are EXTRAPOLATED from the measured 2 s render")
print(f"  with T(124) = {FIXED} + (T(56) - {FIXED}) x {FRAME_SCALE:.2f}; 36 clips = a 3-minute video.")

# THE CONFOUND, made arithmetic. Changing the canvas changes the latent shape, so
# a "fixed" seed is a different draw and the model reframes — face_px moves for a
# reason that has nothing to do with resolution. Split it:
#   face_px  =  face_pct  x  frame_height
#              (the draw)   (what the size actually buys)
# Holding the composition at whatever the native render chose isolates the second.
base = next(((r, s) for r, s in rows if not r.get("warmRepeat")), None)
if base:
    br, bs = base
    print(f"\nframing held at the native render's {bs['face_pct']}% of frame height,")
    print("i.e. the face pixels the size buys IF the shot is framed the same:")
    for r, s in rows:
        if r.get("warmRepeat"):
            continue
        held = bs["face_pct"] / 100.0 * s["height"]
        print(f"  {s['width']}x{s['height']:<6} face would be {held:5.1f}px "
              f"(x{s['height']/bs['height']:.2f})   mouth {held/3:4.1f}px   "
              f"measured {s['face_px']}px at {s['face_pct']}%   time x{r['seconds']/br['seconds']:.2f}")
warm = [(r, s) for r, s in rows if r.get("warmRepeat")]
if warm and base:
    wr, ws = warm[0]
    print(f"\nSEED NOISE FLOOR — same size, seed {br['seed']} vs {wr['seed']}:")
    print(f"  face {bs['face_px']}px ({bs['face_pct']}%) vs {ws['face_px']}px ({ws['face_pct']}%)"
          f"   sharp {bs['sharpness']} vs {ws['sharpness']}")
    print(f"  wall clock {br['seconds']:.0f}s (cold, includes model load) vs {wr['seconds']:.0f}s (warm)")
