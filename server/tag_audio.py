"""Stamp a generated file with its provenance, and report its true duration.

Two jobs, one pass over the file:

1. METADATA — required, not optional. Two tiers (SPEC.md D3.1):

   TIER 1 — the machine-readable AI marker (DIGITALSOURCETYPE, AI_DISCLOSURE,
   GENERATOR, TOOL, GENERATED_BY, AI_GENERATED). PINNED: there is no key in the
   meta file, no flag, and no code path that suppresses it. Two independent
   grounds, each sufficient: the MiniMax-Music3 Community Licence's
   acceptable-use policy requires machine-generated content to be disclosed,
   and EU AI Act Article 50(2) puts the marking duty on the tool's provider —
   the studio marks so its users never have to think about it.

   TIER 2 — the rich record (prompt, lyrics, seeds, sampling params, origin
   map, ledger chain head). The user's own working record, governed by the
   `tier2` field in the meta file (Settings → "Embed detailed provenance in
   exports"). Off means those keys are simply not written; the marker stays.

   Deliberately recorded: the MODEL made it, and every setting needed to reproduce
   it. Deliberately NOT recorded: any claim that AIPLAY made it — the user made it,
   on their own machine. We are the tool, not the author.

2. DURATION — the library shows how long each track is, and the only honest source
   is the file. Returned here so the scan does not need a second decode.

Usage: tag_audio.py <file.flac> <meta.json>

Metadata comes from a FILE, not argv — lyrics contain newlines and quotes, and
shell quoting mangles them (it did, on the first attempt).

⚠ Note ComfyUI already writes its entire workflow graph into a `prompt` field on
every output. That means the raw lyrics and every node setting are ALREADY in the
file before we touch it. Ours are the human-readable, standard-key versions that
players and taggers actually display.
"""
from __future__ import annotations

import base64
import json
import os
import struct
import sys
import tempfile

import av

# The IPTC DigitalSourceType vocabulary base (cv.iptc.org). The value written
# is always a full URI from this vocabulary — the form Google, Meta and the
# C2PA action schema all read.
IPTC_DST = "http://cv.iptc.org/newscodes/digitalsourcetype/"


def probe(path: str) -> float:
    c = av.open(path)
    try:
        s = c.streams.audio[0]
        return float(s.duration * s.time_base) if s.duration else 0.0
    finally:
        c.close()


def read_tags(path: str) -> dict:
    """Read the Vorbis comments back out.

    Tracks made before the sidecar recorded lyrics still HAVE them — they were
    written into the file at generation time. This is how the song panel recovers
    the words for an older take instead of showing an empty section.
    """
    c = av.open(path)
    try:
        s = c.streams.audio[0]
        # ⚠ WHERE the tags live differs by container. FLAC and MP3 surface
        # them at container level; the Ogg muxer moves everything into the
        # STREAM's Vorbis comment header — so an Opus file read only through
        # c.metadata looks blank while carrying every tag we wrote. Merge
        # both, container winning where a key exists in each.
        m = {**dict(s.metadata or {}), **dict(c.metadata or {})}
        secs = float(s.duration * s.time_base) if s.duration else 0.0
    finally:
        c.close()
    # Vorbis keys are case-insensitive in practice; normalise so callers need not.
    up = {k.upper(): v for k, v in m.items()}
    return {
        "ok": True,
        "seconds": round(secs, 2),
        "lyrics": up.get("LYRICS", ""),
        "caption": up.get("STYLE_PROMPT", ""),
        "seed": up.get("SEED", ""),
        "steps": up.get("STEPS", ""),
        "model": up.get("PRECISION", ""),
        # The Tier-1 marker, read back — how the embed round-trip is proven.
        "digitalSourceType": up.get("DIGITALSOURCETYPE", ""),
        "aiDisclosure": up.get("AI_DISCLOSURE", ""),
        "generator": up.get("GENERATOR", ""),
        "provenanceChain": up.get("PROVENANCE_CHAIN", ""),
    }


def picture_block(image_path: str) -> str:
    """A FLAC PICTURE block, base64'd, ready to be a METADATA_BLOCK_PICTURE comment.

    WHY BY HAND. PyAV writes container metadata as strings only — there is no API
    for a binary picture block — and the two libraries that do this properly
    (mutagen, a system ffmpeg) are neither of them installed. Adding a dependency
    so a 40 KB thumbnail rides along inside the file is a bad trade for Joe, who
    would have to install it before his first song had art.

    METADATA_BLOCK_PICTURE-in-a-Vorbis-comment is the REQUIRED form for Ogg and
    Opus and a widely-read one for FLAC (foobar2000, VLC, MPD, Navidrome,
    Plex all honour it), so one implementation covers all three of our formats.
    MP3 is the exception — ID3 APIC is a different container entirely — and is
    handled by the caller refusing rather than by writing something wrong.

    Layout is fixed by the FLAC spec, all big-endian:
      type / mime-len+mime / desc-len+desc / w / h / depth / colours / data-len+data
    """
    with open(image_path, "rb") as fh:
        data = fh.read()

    # Dimensions come from the PNG header rather than a decode: it is eight bytes
    # of arithmetic, and pulling in an image library for it would defeat the
    # entire point of not adding a dependency.
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        depth = data[24] * (3 if data[25] == 2 else 4 if data[25] == 6 else 1)
        mime = "image/png"
    elif data[:2] == b"\xff\xd8":
        width = height = 0          # legal: 0 means "unspecified", not "broken"
        depth = 24
        mime = "image/jpeg"
    else:
        raise ValueError("cover must be PNG or JPEG")

    def chunk(b: bytes) -> bytes:
        return struct.pack(">I", len(b)) + b

    block = (
        struct.pack(">I", 3)                    # 3 = front cover
        + chunk(mime.encode("ascii"))
        + chunk(b"")                            # description: none
        + struct.pack(">IIII", width, height, depth, 0)
        + chunk(data)
    )
    return base64.b64encode(block).decode("ascii")


def tag(path: str, meta: dict) -> float:
    """Rewrite the file with its provenance, preserving the audio exactly.

    ⚠ This used to hardcode FLAC — `mkstemp(suffix=".flac")` plus
    `add_stream("flac")` — which was correct while FLAC was the only output but
    silently corrupts anything else: it would write FLAC bytes over a `.mp3`
    path and leave a file whose contents disagree with its extension.

    Now the container follows the file, and lossy formats are REMUXED rather than
    re-encoded. That distinction matters: decoding and re-encoding an MP3 to
    attach a tag throws away quality for no reason, every time. Copying the
    packets leaves the bitstream byte-identical and only rewrites the header.
    FLAC keeps the decode/encode path because it is lossless either way and that
    path is already proven.
    """
    ext = os.path.splitext(path)[1].lower()
    lossless = ext == ".flac"

    # Captured before the rewrite, restored after it — see the note at the end.
    stamp = os.stat(path)

    src = av.open(path)
    in_s = src.streams.audio[0]
    fd, tmp = tempfile.mkstemp(suffix=ext, dir=os.path.dirname(path))
    os.close(fd)

    out = av.open(tmp, "w")
    # PyAV takes container metadata as an attribute set BEFORE the header is
    # written (which happens on the first mux), not as an open() argument.
    out.metadata.update({k: str(v) for k, v in meta.items()})
    try:
        if lossless:
            out_s = out.add_stream("flac", rate=in_s.codec_context.sample_rate)
            out_s.layout = in_s.codec_context.layout.name
            for frame in src.decode(audio=0):
                frame.pts = None
                for pkt in out_s.encode(frame):
                    out.mux(pkt)
            for pkt in out_s.encode(None):
                out.mux(pkt)
        else:
            # Stream copy. Nothing is decoded, so nothing degrades.
            out_s = out.add_stream_from_template(in_s)
            for pkt in src.demux(in_s):
                if pkt.dts is None:      # flush packet, not real data
                    continue
                pkt.stream = out_s
                out.mux(pkt)
    finally:
        out.close()
        src.close()

    # ⚠ PUT THE ORIGINAL TIMESTAMP BACK.
    #
    # Tagging rewrites the file, which gives it a new mtime — and the library
    # falls back to mtime for any track whose sidecar has no `createdAt`. So a
    # re-tagging pass silently restamps every old track as "just now" and
    # scrambles the library's chronology. That is exactly what the first cover
    # backfill did to eleven tracks here.
    os.replace(tmp, path)
    os.utime(path, (stamp.st_atime, stamp.st_mtime))
    return probe(path)


def main() -> int:
    path = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "--read":
        try:
            print(json.dumps(read_tags(path)))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": str(exc)[:200]}))
        return 0

    raw = {}
    if len(sys.argv) > 2:
        with open(sys.argv[2], encoding="utf-8") as fh:
            raw = json.load(fh)
    # Optional third argument: the cover to embed. Absent on the first tagging
    # pass, because the cover has not been drawn yet — see the re-tag in index.js.
    cover = sys.argv[3] if len(sys.argv) > 3 else None

    # ── Tier 1: the AI marker. Written UNCONDITIONALLY — no meta key reaches
    # this block, so nothing a caller passes (tier2:false, tier1:false, a
    # missing field) can suppress it. See the module docstring for why.
    ext_lower = os.path.splitext(path)[1].lower()
    generator = str(raw.get("generator") or "MiniMax-Music3")
    dst = str(raw.get("digitalSourceType") or "")
    if not dst.startswith(IPTC_DST):
        dst = IPTC_DST + "trainedAlgorithmicMedia"
    disclosure = str(raw.get("disclosure") or "") or (
        f"AI-generated audio: created with {generator}. Machine-generated content."
    )
    # MP3 rides ID3v2: arbitrary keys become TXXX frames with the key as the
    # description, and the SPEC's field table names the mixed-case form there;
    # Vorbis comments are conventionally upper-case (and case-insensitive).
    dst_key = "DigitalSourceType" if ext_lower == ".mp3" else "DIGITALSOURCETYPE"
    meta = {
        dst_key: dst,
        "AI_DISCLOSURE": disclosure,
        "GENERATOR": generator,
        "TOOL": f"AIPLAY Studio {raw.get('appVersion', '0.1.0')}",
        # The pre-ledger disclosure pair, kept for continuity with every file
        # already stamped by earlier builds.
        "GENERATED_BY": generator,
        "AI_GENERATED": "true",
        "COMMENT": f"Generated locally with {generator}.",
        # Display basics — identity, not provenance detail.
        "TITLE": str(raw.get("title") or "Untitled"),
        # The model is the performer. We are not.
        "ARTIST": generator,
        "GENRE": (str(raw.get("caption") or "").split(",")[0].strip() or "Generated")[:60],
        "DATE": str(raw.get("date") or ""),
        "SOFTWARE": f"AIPLAY Studio {raw.get('appVersion', '0.1.0')}",
    }

    # ── Tier 2: the rich record — the user's own toggle ("Embed detailed
    # provenance in exports"). `tier2` missing means on: the record is the
    # default and switching it off is the explicit act.
    if raw.get("tier2") is not False:
        prov = raw.get("provenance") or {}
        meta.update({
            # Everything needed to reproduce the render.
            "STYLE_PROMPT": str(raw.get("caption") or "")[:900],
            "LYRICS": str(raw.get("lyrics") or "")[:4000],
            "SEED": str(raw.get("seed", "")),
            "MIX_SEED": str(raw.get("mixSeed", "")),
            "STEPS": str(raw.get("steps", "")),
            "CFG_SCALE": str(raw.get("cfg", "")),
            "SIGMA_SCHEDULE": f"shift {raw.get('shift', '')}" if raw.get("shift", "") != "" else "",
            "SAMPLER": str(raw.get("sampler", "euler")),
            "PRECISION": str(raw.get("model", "int8")),
            # The ledger summary: compact per-part origin map + chain head.
            "PROVENANCE": json.dumps(prov.get("originMap"), separators=(",", ":"))[:2000]
                          if prov.get("originMap") else "",
            "PROVENANCE_CHAIN": str(prov.get("chainHead") or ""),
        })
    meta = {k: v for k, v in meta.items() if v not in ("", None)}

    # Embed the cover, when there is one and the container can carry it this way.
    # A failure here must never cost the tagging pass, let alone the audio.
    embedded = False
    if cover and os.path.exists(cover):
        ext = os.path.splitext(path)[1].lower()
        if ext == ".mp3":
            # ID3 APIC is a binary frame in a different container format, and
            # PyAV cannot write one. Saying so beats writing a comment no MP3
            # player will ever look at.
            pass
        else:
            try:
                meta["METADATA_BLOCK_PICTURE"] = picture_block(cover)
                embedded = True
            except Exception:  # noqa: BLE001 — art is never worth failing over
                pass

    try:
        seconds = tag(path, meta)
    except Exception as exc:  # noqa: BLE001 — never lose the audio over a tag
        print(json.dumps({"ok": False, "error": str(exc)[:200], "seconds": probe(path)}))
        return 0
    print(json.dumps({"ok": True, "seconds": round(seconds, 2), "cover": embedded}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
