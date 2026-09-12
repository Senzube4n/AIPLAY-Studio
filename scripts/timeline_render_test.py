"""The cut renderer's colour, stated rather than guessed.

Measured 2026-09-12: every clip ComfyUI writes is BT.601-matrix, limited-range
and UNTAGGED — PyAV converts RGB to yuv420p with no colourspace set, so pure
red lands at Y/U/V 81/90/240. A player assumes BT.709 for an HD frame and
shows those values as a slightly orange red and a dimmer green. The cut
renderer now reads its inputs as 601 (ffmpeg's own default for an untagged
frame), converts to 709 in the scale filter it already runs, and tags the
output, so nothing downstream has to guess.

Two halves. The plan half needs nothing: build() is called with a fixture and
its ffmpeg argument list is inspected. The proof half needs the rig's PyAV and
an ffmpeg on PATH: it encodes a red clip exactly the way ComfyUI does, runs the
plan (libx264 — the CPU encoder, so this never touches the card), and reads
the cut back: tagged 709, and red decodes as red. Where either tool is
missing, that half says so and the assertions are counted as not made.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline_render as tr  # noqa: E402

passed, failed = 0, []


def ok(label, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok    {label}")
    else:
        failed.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def fixture(clips_dir, name="mv_test_s1_0.mp4", w=64, h=64, dur=0.5):
    return {
        "out": {"w": w, "h": h, "fps": 24},
        "tracks": [
            {"kind": "video", "items": [
                {"src": f"/api/clip/{name}", "start": 0.0, "dur": dur, "inPoint": 0.0, "srcDur": dur},
            ]},
        ],
    }


tmp = tempfile.mkdtemp(prefix="aiplay-cut-colour-")
clips = os.path.join(tmp, "clips")
os.makedirs(clips)
name = "mv_test_s1_0.mp4"
open(os.path.join(clips, name), "wb").close()   # build() only asks that it exists

print("\nthe plan — the argument list ffmpeg is handed")
plan = tr.build(fixture(clips), clips, tmp, os.path.join(tmp, "out.mp4"))
ok("build() made a plan", "args" in plan, json.dumps(plan)[:200])
args = plan.get("args") or []
fc = args[args.index("-filter_complex") + 1] if "-filter_complex" in args else ""
ok("the clip's chain converts 601 -> 709 inside the scale it already runs",
   "in_color_matrix=auto:out_color_matrix=bt709" in fc, fc[:300])
ok("...and keeps limited range on both sides", "in_range=auto:out_range=tv" in fc)
ok("the conversion sits on the CLIP input, not the black base",
   fc.startswith("[1:v]scale=") or "[1:v]scale=" in fc, fc[:120])


def flag(a, k):
    return a[a.index(k) + 1] if k in a else None


ok("the frames themselves are stamped bt709/tv before the encoder sees them",
   fc.endswith("setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vtagged]"), fc[-160:])
ok("...and that is what is mapped out", flag(args, "-map") == "[vtagged]")
ok("the output is tagged bt709 (matrix)", flag(args, "-colorspace") == "bt709")
ok("...bt709 (primaries)", flag(args, "-color_primaries") == "bt709")
ok("...bt709 (transfer)", flag(args, "-color_trc") == "bt709")
ok("...limited range", flag(args, "-color_range") == "tv")
ok("the tags come AFTER the pixel format, as output options", args.index("-pix_fmt") < args.index("-colorspace"))
ok("...and before the output path", args.index("-color_range") < len(args) - 1 and args[-1].endswith("out.mp4"))
plan_x264 = tr.build(fixture(clips), clips, tmp, os.path.join(tmp, "out.mp4"), encoder="libx264")
ok("the libx264 fallback carries the same tags", flag(plan_x264["args"], "-colorspace") == "bt709")

# The luma remap measured cut-vs-clip (1.098x - 11) was the GRADE, by
# arithmetic: eq contrast c maps Y -> c*(Y-128)+128, and for c = 1.09 that is
# 1.09*Y - 11.52. Pinned so nobody chases a range error that is not there.
c = 1.09
ok("contrast 1.09 is the 1.09x/-11.5 luma map that was measured", abs((c * (0 - 128) + 128) - (-11.52)) < 0.05)

print("\nthe proof — a red frame through the cut")
ffmpeg = shutil.which("ffmpeg")
ffprobe = shutil.which("ffprobe")
try:
    import av  # noqa: F401
    import numpy as np
    have_av = True
except Exception:
    have_av = False

if not (ffmpeg and ffprobe and have_av):
    print("  SKIP  needs ffmpeg + ffprobe on PATH and PyAV in this interpreter — "
          f"ffmpeg={bool(ffmpeg)} ffprobe={bool(ffprobe)} av={have_av}. 5 assertions NOT made.")
else:
    # Exactly ComfyUI's writer: RGB -> yuv420p through PyAV with no colourspace.
    src = os.path.join(clips, name)
    out = av.open(src, "w")
    st = out.add_stream("h264", rate=24)
    st.width, st.height, st.pix_fmt = 64, 64, "yuv420p"
    st.options = {"crf": "0"}
    for _ in range(12):
        fr = av.VideoFrame.from_ndarray(np.full((64, 64, 3), (255, 0, 0), np.uint8), format="rgb24")
        for pk in st.encode(fr.reformat(format="yuv420p")):
            out.mux(pk)
    for pk in st.encode(None):
        out.mux(pk)
    out.close()

    # What was written: the 601 encoding of red, untagged. If PyAV ever starts
    # tagging or converting, this is the assertion that says the premise moved.
    probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=color_space,color_range", "-of", "json", src],
                           capture_output=True, text=True)
    meta = json.loads(probe.stdout or "{}").get("streams", [{}])[0]
    ok("the source is untagged, as ComfyUI's clips are", meta.get("color_space", "unknown") == "unknown", str(meta))
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", src, "-frames:v", "1", "-pix_fmt", "yuv420p",
                          "-f", "rawvideo", "-"], capture_output=True).stdout
    ok("...and holds the 601 values for red (Y~81 U~90 V~240)",
       abs(raw[0] - 81) <= 3 and abs(raw[64 * 64] - 90) <= 3 and abs(raw[64 * 64 + 32 * 32] - 240) <= 3,
       f"got {raw[0]} {raw[64 * 64]} {raw[64 * 64 + 32 * 32]}")

    # The cut, CPU encoder, no grade so the pixels can be checked exactly.
    dst = os.path.join(tmp, "cut.mp4")
    plan = tr.build(fixture(clips), clips, tmp, dst, encoder="libx264", grade=None, crf=0)
    r = subprocess.run(plan["args"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    ok("ffmpeg rendered the cut", r.returncode == 0 and os.path.exists(dst), (r.stderr or "")[-400:])
    if r.returncode == 0:
        probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=color_space,color_range,color_primaries,color_transfer",
                                "-of", "json", dst], capture_output=True, text=True)
        meta = json.loads(probe.stdout or "{}").get("streams", [{}])[0]
        ok("the cut is tagged bt709 / tv", meta.get("color_space") == "bt709" and meta.get("color_range") == "tv"
           and meta.get("color_primaries") == "bt709" and meta.get("color_transfer") == "bt709", str(meta))
        raw = subprocess.run([ffmpeg, "-v", "error", "-i", dst, "-frames:v", "1", "-pix_fmt", "yuv420p",
                              "-f", "rawvideo", "-"], capture_output=True).stdout
        ok("its pixels are the 709 encoding of red (Y~63 U~102 V~240)",
           abs(raw[0] - 63) <= 3 and abs(raw[64 * 64] - 102) <= 3 and abs(raw[64 * 64 + 32 * 32] - 240) <= 3,
           f"got {raw[0]} {raw[64 * 64]} {raw[64 * 64 + 32 * 32]}")
        rgb = subprocess.run([ffmpeg, "-v", "error", "-i", dst, "-frames:v", "1", "-pix_fmt", "rgb24",
                              "-f", "rawvideo", "-"], capture_output=True).stdout
        ok("so a player that reads the tag shows red as red",
           rgb[0] >= 250 and rgb[1] <= 5 and rgb[2] <= 5, f"got {rgb[0]} {rgb[1]} {rgb[2]}")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{passed} passed, {len(failed)} failed")
if failed:
    print("  failed:\n    " + "\n    ".join(failed))
    sys.exit(1)
