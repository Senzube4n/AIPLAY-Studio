"""The bounce keeps its bit depth through the tagging pass.

The DAW's bounce is written by instruments.py as PCM_24 (soundfile), then
routes.js's tagBounce hands it to server/tag_audio.py for the provenance
marker and the CC-BY attribution lines. tag_audio re-encodes a FLAC to write
the tags, and until the sample format was pinned that re-encode took PyAV's
FLAC default — s16 — so every tagged bounce came back 16-bit with its low
byte gone. The provers caught it by reading the file's subtype: "tagBounce
rewrote the bounce as PCM_16 (the untagged one is PCM_24)."

Everything here reads the file back with an INDEPENDENT reader (soundfile,
which is also the writer the bounce uses) and compares the integer samples,
so a re-encode that changed one LSB fails, not just one that changed the
declared depth.

  <rig-python> server/daw/tag_bounce_test.py
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TAG_AUDIO = os.path.join(HERE, "..", "tag_audio.py")

PASS = 0
FAILS = []


def ok(label, cond, detail=""):
    global PASS
    if cond:
        PASS += 1
        print(f"  ok    {label}")
    else:
        FAILS.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


try:
    import soundfile as sf
    import av  # noqa: F401  -- tag_audio needs it; skip loudly if absent
    HAVE_IO = True
except Exception as exc:  # noqa: BLE001
    HAVE_IO = False
    print(f"  skip  soundfile/av not importable here ({exc}); nothing to prove")

SR = 48000


def bounce_like(path, bits, seconds=1.0):
    """A stereo file written the way instruments.py's encode mode writes the
    bounce: soundfile, subtype PCM_<bits>. The two channels DIFFER (the
    de-interleave seam ear_test pins is a separate bug; this file should
    not be able to hide behind a mono signal either)."""
    t = np.arange(int(SR * seconds)) / SR
    y = np.stack([0.5 * np.sin(2 * np.pi * 220.0 * t),
                  0.25 * np.sin(2 * np.pi * 660.0 * t)
                  + 0.001 * np.sin(2 * np.pi * 3001.0 * t)], axis=1)
    sf.write(path, y, SR, subtype=f"PCM_{bits}")


def tag_like_tagbounce(path, attribution=()):
    """The meta routes.js's tagBounce writes, field for field."""
    meta = {
        "title": "big room take",
        "generator": "AIPLAY Studio DAW (hybrid_kick, sub_bass, bigroom_lead)",
        "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
        "disclosure": "Human-authored audio: every note was placed by a person.",
        "attribution": list(attribution),
        "tier2": True,
        "date": "2026-09-02",
    }
    mp = path + ".meta.json"
    with open(mp, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    try:
        r = subprocess.run([sys.executable, TAG_AUDIO, path, mp],
                           capture_output=True, text=True, timeout=120)
    finally:
        os.unlink(mp)
    line = (r.stdout.strip().splitlines() or ["{}"])[-1]
    try:
        return json.loads(line)
    except ValueError:
        return {"ok": False, "error": (r.stderr or r.stdout)[-400:]}


if HAVE_IO:
    tmp = tempfile.mkdtemp(prefix="tagbounce-")

    print("\n  -- a 24-bit bounce is still 24-bit after tagBounce's pass --")
    p24 = os.path.join(tmp, "take_24.flac")
    bounce_like(p24, 24)
    before = sf.read(p24, dtype="int32")[0]
    ok("fixture: soundfile wrote PCM_24 (the bounce's own depth)",
       sf.info(p24).subtype == "PCM_24", sf.info(p24).subtype)
    r = tag_like_tagbounce(p24, ["Salamander Grand Piano — CC-BY 3.0"])
    ok("the tag pass succeeded", r.get("ok") is True, str(r)[:200])
    after_info = sf.info(p24)
    ok("PCM_24 in, PCM_24 out", after_info.subtype == "PCM_24", after_info.subtype)
    after = sf.read(p24, dtype="int32")[0]
    ok("the sample count survives", after.shape == before.shape, f"{after.shape} vs {before.shape}")
    ok("every 24-bit sample is byte-identical (not one LSB moved)",
       after.shape == before.shape and np.array_equal(after, before),
       f"max |diff| {int(np.max(np.abs(after.astype(np.int64) - before.astype(np.int64)))) if after.shape == before.shape else 'shape'}")
    ok("the two channels are still different (no fold, no interleave slip)",
       not np.array_equal(after[:, 0], after[:, 1]))
    # Read the tags back through ffmpeg's demuxer (PyAV), the reader every
    # player uses — the marker AND the CC-BY line must be in the 24-bit file.
    c = av.open(p24)
    try:
        merged = {**dict(c.streams.audio[0].metadata or {}), **dict(c.metadata or {})}
    finally:
        c.close()
    tags = {k.upper(): v for k, v in merged.items()}
    ok("the provenance marker reads back from the 24-bit file",
       str(tags.get("DIGITALSOURCETYPE", "")).startswith("http://cv.iptc.org/"), str(tags)[:200])
    ok("...and so does the attribution line the licence obliges",
       "Salamander" in str(tags.get("ATTRIBUTION", "")), str(tags.get("ATTRIBUTION"))[:120])

    print("\n  -- a 16-bit file stays 16-bit (the format is PRESERVED, not forced) --")
    p16 = os.path.join(tmp, "take_16.flac")
    bounce_like(p16, 16)
    b16 = sf.read(p16, dtype="int16")[0]
    r = tag_like_tagbounce(p16)
    ok("the tag pass succeeded", r.get("ok") is True, str(r)[:200])
    ok("PCM_16 in, PCM_16 out", sf.info(p16).subtype == "PCM_16", sf.info(p16).subtype)
    a16 = sf.read(p16, dtype="int16")[0]
    ok("every 16-bit sample is byte-identical",
       a16.shape == b16.shape and np.array_equal(a16, b16))

    print("\n  -- the depth survives a SECOND tagging pass (the cover re-tag) --")
    r = tag_like_tagbounce(p24)
    ok("second pass succeeded", r.get("ok") is True, str(r)[:200])
    ok("still PCM_24", sf.info(p24).subtype == "PCM_24", sf.info(p24).subtype)
    ok("still byte-identical to the untagged bounce",
       np.array_equal(sf.read(p24, dtype="int32")[0], before))

    print("\n  -- the source pin: tag_audio.py pins the sample format on the FLAC path --")
    with open(TAG_AUDIO, encoding="utf-8") as fh:
        src = fh.read()
    ok("tag() sets the output stream's format from the input's",
       "out_s.format = in_s.codec_context.format.name" in src)

    import shutil
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n  {PASS} passed, {len(FAILS)} failed\n")
if FAILS:
    print("  failed:\n   " + "\n   ".join(FAILS) + "\n")
    raise SystemExit(1)
