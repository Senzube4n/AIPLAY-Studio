"""The embed round-trip — provenance actually survives the files we write.

Every assertion here reads the exported bytes back with an INDEPENDENT parser:
PNG chunks and JPEG segments are walked by hand (struct arithmetic, not the
injector's own code), and audio tags are read back through PyAV's demuxer —
i.e. through ffmpeg, the same library every player and ffprobe use. A test
that verified the writer with the writer would prove nothing.

What is pinned, per format:

  PNG / JPEG   Tier-1 marker (IPTC DigitalSourceType URI + disclosure) and the
               Tier-2 record ride an XMP packet; `metadata:"none"` drops the
               record and KEEPS the marker — no exposed option strips Tier 1.
  WebP         no injector in v1 → the `.provenance.json` sidecar appears and
               the result says "sidecar", never claiming an embed.
  FLAC / MP3   tag_audio.py writes DIGITALSOURCETYPE + AI_DISCLOSURE always;
               `tier2:false` removes LYRICS/SEED/prompt and nothing can remove
               the marker (a `tier1:false` key is ignored — it does not exist).

Run:  <rig venv python> server/provenance_embed_test.py
Needs PIL/numpy/cv2 (imgexport) and av (tag_audio) — the rig venv has all.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import imgexport  # noqa: E402

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


IPTC = "http://cv.iptc.org/newscodes/digitalsourcetype/"
MARKER = {
    "digitalSourceType": IPTC + "trainedAlgorithmicMedia",
    "disclosure": "AI-generated image: created with flux2. Machine-generated content.",
    "generator": "flux2",
    "tool": "AIPLAY Studio test",
}
RECORD = {"prompt": "a red square", "seed": 7, "originMap": {"class": "ai-generated"},
          "chainHead": "sha256:abc123"}


# ── independent readers ─────────────────────────────────────────────────────

def png_xmp(data):
    """Every iTXt XML:com.adobe.xmp payload, by walking the chunk table."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    out = []
    at = 8
    while at + 8 <= len(data):
        ln = struct.unpack(">I", data[at:at + 4])[0]
        typ = data[at + 4:at + 8]
        body = data[at + 8:at + 8 + ln]
        if typ == b"iTXt" and body.startswith(b"XML:com.adobe.xmp\x00"):
            # keyword NUL comp flag/method NUL lang NUL translated NUL text
            rest = body[len(b"XML:com.adobe.xmp\x00"):]
            comp_flag = rest[0]
            text = rest[2:]
            # skip language + translated keyword (two NUL-terminated strings)
            for _ in range(2):
                text = text[text.index(b"\x00") + 1:]
            out.append(zlib.decompress(text) if comp_flag else text)
        # CRC must hold, or the chunk we inserted corrupted the file.
        crc = struct.unpack(">I", data[at + 8 + ln:at + 12 + ln])[0]
        assert crc == (zlib.crc32(typ + body) & 0xFFFFFFFF), f"bad CRC on {typ}"
        at += 12 + ln
        if typ == b"IEND":
            break
    return out


def jpeg_xmp(data):
    """Every XMP APP1 payload, by walking the segment table."""
    assert data[:2] == b"\xff\xd8", "not a JPEG"
    out = []
    at = 2
    while at + 4 <= len(data):
        if data[at] != 0xFF:
            break
        marker = data[at + 1]
        if marker == 0xDA:            # SOS — entropy data follows, stop
            break
        ln = struct.unpack(">H", data[at + 2:at + 4])[0]
        seg = data[at + 4:at + 2 + ln]
        if marker == 0xE1 and seg.startswith(b"http://ns.adobe.com/xap/1.0/\x00"):
            out.append(seg[len(b"http://ns.adobe.com/xap/1.0/\x00"):])
        at += 2 + ln
    return out


# ── image round trips ───────────────────────────────────────────────────────

print("\n  -- PNG: marker + record in an iTXt XMP chunk --")
tmp = tempfile.mkdtemp(prefix="prov_embed_")
rgba = np.zeros((32, 32, 4), np.float32)
rgba[..., 0] = 1.0
rgba[..., 3] = 1.0

p1 = os.path.join(tmp, "a.png")
r = imgexport.export(rgba, p1, {"format": "png"},
                     provenance={"marker": MARKER, "record": RECORD})
ok("export reports provenance: xmp", r.get("provenance") == "xmp", str(r.get("provenance")))
raw = open(p1, "rb").read()
packets = png_xmp(raw)
ok("an XMP packet is in the PNG and every chunk CRC still holds", len(packets) == 1)
xmp = packets[0].decode("utf-8") if packets else ""
ok("the DigitalSourceType URI reads back", MARKER["digitalSourceType"] in xmp)
ok("the disclosure sentence reads back", "Machine-generated content." in xmp)
ok("the record reads back (prompt + chain head)",
   "a red square" in xmp and "sha256:abc123" in xmp)
from PIL import Image  # noqa: E402
im = Image.open(p1)
ok("the injected PNG still opens and holds its pixels",
   im.size == (32, 32) and im.convert("RGBA").getpixel((5, 5))[0] == 255)

print("\n  -- the metadata option: none drops the record, NEVER the marker --")
p2 = os.path.join(tmp, "b.png")
r = imgexport.export(rgba, p2, {"format": "png", "metadata": "none"},
                     provenance={"marker": MARKER, "record": RECORD})
xmp2 = (png_xmp(open(p2, "rb").read()) or [b""])[0].decode("utf-8")
ok("metadata 'none': the marker is still written", MARKER["digitalSourceType"] in xmp2)
ok("metadata 'none': the record is gone", "a red square" not in xmp2 and "sha256:abc123" not in xmp2)
p3 = os.path.join(tmp, "c.png")
imgexport.export(rgba, p3, {"format": "png", "metadata": "preserve"},
                 provenance={"marker": MARKER, "record": RECORD})
xmp3 = (png_xmp(open(p3, "rb").read()) or [b""])[0].decode("utf-8")
ok("metadata 'preserve': marker and record both present",
   MARKER["digitalSourceType"] in xmp3 and "a red square" in xmp3)
# There is no fourth value: every legal metadata mode was just proven to keep
# the marker, which is the "unstrippable via any exposed option" claim.
try:
    imgexport.export(rgba, os.path.join(tmp, "x.png"),
                     {"format": "png", "metadata": "off"}, provenance={"marker": MARKER})
    ok("an unknown metadata mode is refused", False)
except ValueError:
    ok("an unknown metadata mode is refused", True)

print("\n  -- 16-bit PNG (the OpenCV path) --")
p16 = os.path.join(tmp, "d16.png")
r = imgexport.export(rgba, p16, {"format": "png", "bitDepth": 16},
                     provenance={"marker": MARKER, "record": RECORD})
xmp16 = (png_xmp(open(p16, "rb").read()) or [b""])[0].decode("utf-8")
ok("the 16-bit PNG carries the marker too", MARKER["digitalSourceType"] in xmp16)

print("\n  -- JPEG: marker in a standard XMP APP1 segment --")
pj = os.path.join(tmp, "a.jpg")
r = imgexport.export(rgba, pj, {"format": "jpeg"},
                     provenance={"marker": MARKER, "record": RECORD})
segs = jpeg_xmp(open(pj, "rb").read())
ok("export reports provenance: xmp", r.get("provenance") == "xmp")
ok("an XMP APP1 segment is present", len(segs) == 1)
jx = segs[0].decode("utf-8") if segs else ""
ok("URI + disclosure + record read back",
   MARKER["digitalSourceType"] in jx and "Machine-generated content." in jx and "a red square" in jx)
imj = Image.open(pj)
ok("the injected JPEG still opens", imj.size == (32, 32))

print("\n  -- target mode: the packet is budgeted, not blown through --")
big = np.random.default_rng(7).random((256, 256, 4)).astype(np.float32)
big[..., 3] = 1.0
pt = os.path.join(tmp, "t.jpg")
r = imgexport.target_size(big, 9000, {"format": "jpeg"}, out_path=pt,
                          provenance={"marker": MARKER, "record": RECORD})
ok("target met with provenance aboard", r.get("ok") and r.get("met"), str(r))
ok("the written file is under the caller's target", os.path.getsize(pt) <= 9000)
ok("...and carries the marker", MARKER["digitalSourceType"] in
   (jpeg_xmp(open(pt, "rb").read()) or [b""])[0].decode("utf-8", "replace"))

print("\n  -- WebP: no injector in v1 -> sidecar, said honestly --")
pw = os.path.join(tmp, "a.webp")
r = imgexport.export(rgba, pw, {"format": "webp"},
                     provenance={"marker": MARKER, "record": RECORD})
side = pw + ".provenance.json"
ok("the result says sidecar, not xmp", r.get("provenance") == "sidecar", str(r.get("provenance")))
ok("the sidecar exists and carries the marker",
   os.path.exists(side) and json.load(open(side, encoding="utf-8"))["marker"]["digitalSourceType"]
   == MARKER["digitalSourceType"])

# ── audio round trips ───────────────────────────────────────────────────────

print("\n  -- audio: tag_audio.py round trip through ffmpeg's demuxer --")
try:
    import av
    HAVE_AV = True
except Exception as exc:  # noqa: BLE001
    HAVE_AV = False
    print(f"  skip  av is not importable here ({exc}) — audio sections skipped")

if HAVE_AV:
    def make_audio(path, codec, fmt_rate=44100):
        """0.2 s of sine, encoded fresh — the file tag_audio then rewrites."""
        out = av.open(path, "w")
        s = out.add_stream(codec, rate=fmt_rate)
        if codec != "flac":
            try:
                s.layout = "stereo"
            except Exception:  # noqa: BLE001
                pass
        t = np.arange(int(fmt_rate * 0.2)) / fmt_rate
        pcm = (np.sin(2 * np.pi * 440 * t) * 0.3 * 32767).astype(np.int16)
        frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = fmt_rate
        for pkt in s.encode(frame):
            out.mux(pkt)
        for pkt in s.encode(None):
            out.mux(pkt)
        out.close()

    def read_meta(path):
        """Container + stream metadata merged — Ogg keeps Vorbis comments on
        the STREAM, FLAC/MP3 on the container. Same merge read_tags does."""
        c = av.open(path)
        try:
            merged = {**dict(c.streams.audio[0].metadata or {}), **dict(c.metadata or {})}
            return {k.upper(): v for k, v in merged.items()}
        finally:
            c.close()

    def run_tag(path, meta):
        mp = path + ".meta.json"
        with open(mp, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        r = subprocess.run([sys.executable, os.path.join(HERE, "tag_audio.py"), path, mp],
                           capture_output=True, text=True)
        os.unlink(mp)
        return json.loads(r.stdout.strip().splitlines()[-1])

    fl = os.path.join(tmp, "song.flac")
    make_audio(fl, "flac")
    r = run_tag(fl, {"title": "T", "caption": "synthwave, dreamy", "lyrics": "la la la",
                     "seed": 7, "steps": 12, "model": "int8",
                     "provenance": {"originMap": {"class": "ai-generated"},
                                    "chainHead": "sha256:deadbeef"}})
    m = read_meta(fl)
    ok("FLAC: tag pass succeeded", r.get("ok") is True, str(r))
    ok("FLAC: DIGITALSOURCETYPE reads back as the IPTC URI",
       m.get("DIGITALSOURCETYPE") == IPTC + "trainedAlgorithmicMedia", str(m.get("DIGITALSOURCETYPE")))
    ok("FLAC: the disclosure sentence reads back",
       "Machine-generated content." in m.get("AI_DISCLOSURE", ""))
    ok("FLAC: the Tier-2 record rode along (lyrics + chain head)",
       m.get("LYRICS") == "la la la" and m.get("PROVENANCE_CHAIN") == "sha256:deadbeef")

    fl2 = os.path.join(tmp, "song2.flac")
    make_audio(fl2, "flac")
    r = run_tag(fl2, {"title": "T", "caption": "synthwave", "lyrics": "secret words",
                      "seed": 7, "tier2": False,
                      # the fabrication attempt: there is no such key, and the
                      # marker must survive it being passed anyway
                      "tier1": False})
    m2 = read_meta(fl2)
    ok("FLAC tier2:false — the record is gone (no lyrics, no seed, no prompt)",
       "LYRICS" not in m2 and "SEED" not in m2 and "STYLE_PROMPT" not in m2, str(sorted(m2)))
    ok("FLAC tier2:false + tier1:false — the marker is STILL there",
       m2.get("DIGITALSOURCETYPE") == IPTC + "trainedAlgorithmicMedia"
       and "AI_DISCLOSURE" in m2 and m2.get("AI_GENERATED") == "true")

    # MP3 — the remux path writes ID3v2; ffmpeg surfaces TXXX by description.
    mp3 = os.path.join(tmp, "song.mp3")
    try:
        make_audio(mp3, "libmp3lame")
        have_mp3 = True
    except Exception as exc:  # noqa: BLE001
        have_mp3 = False
        print(f"  skip  no mp3 encoder in this ffmpeg build ({exc}) — mp3 round trip skipped")
    if have_mp3:
        r = run_tag(mp3, {"title": "T", "caption": "rock", "lyrics": "hey", "seed": 1})
        m3 = read_meta(mp3)
        ok("MP3: tag pass succeeded", r.get("ok") is True, str(r))
        ok("MP3: the marker reads back through ID3 (TXXX:DigitalSourceType)",
           m3.get("DIGITALSOURCETYPE") == IPTC + "trainedAlgorithmicMedia", str(sorted(m3))[:400])
        ok("MP3: the disclosure reads back", "Machine-generated content." in m3.get("AI_DISCLOSURE", ""))

    # Opus — Vorbis comments in an Ogg container; also the format whose C2PA
    # story is sidecar-only (written by the server at export, not here).
    op = os.path.join(tmp, "song.opus")
    try:
        make_audio(op, "libopus", fmt_rate=48000)
        have_opus = True
    except Exception as exc:  # noqa: BLE001
        have_opus = False
        print(f"  skip  no opus encoder here ({exc}) — opus round trip skipped")
    if have_opus:
        r = run_tag(op, {"title": "T", "caption": "ambient", "seed": 2})
        m4 = read_meta(op)
        ok("Opus: tag pass succeeded", r.get("ok") is True, str(r))
        ok("Opus: the marker reads back from the Ogg comments",
           m4.get("DIGITALSOURCETYPE") == IPTC + "trainedAlgorithmicMedia", str(sorted(m4))[:400])

# ── done ────────────────────────────────────────────────────────────────────
import shutil  # noqa: E402
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n  {PASS} passed, {len(FAILS)} failed\n")
sys.exit(1 if FAILS else 0)
