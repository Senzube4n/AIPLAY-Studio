"""Export - turning a committed edit into a file somebody else can open.

Every edit in this app has, until now, written a PNG: one format, one quality,
no options. That is the right default and a terrible only-choice. A 4000px PNG
of a photograph is 14 MB nobody wants to receive; the same picture at JPEG 82 is
under a megabyte and indistinguishable at the size it will actually be viewed.
This module is the export dialog's engine.

THE INPUT CONTRACT, stated once and never varied: every public function takes
**float32 (H, W, 4), 0..1, STRAIGHT (un-premultiplied) alpha** - the identical
array `server/vfx/effects.py` passes around and exactly what a PIL RGBA image
becomes under `np.asarray(im).astype(np.float32) / 255.0`. `as_rgba()` is the
ONE adapter at the boundary; it takes an ndarray, a PIL image or a path and
returns that. Nothing below accepts a PIL image, because two accepted input
types is how a codebase ends up with two flatten implementations.

Straight alpha is load-bearing at exactly one step and it is the step everybody
gets wrong. Flattening onto a matte is

    out = rgb * a + matte * (1 - a)

and the premultiplied spelling of the same line - `rgb + matte * (1 - a)`, or
worse, running the straight formula over pixels somebody already premultiplied -
multiplies coverage in twice and darkens every semi-transparent pixel. On a
cutout that is a grey ring around the subject that nobody can explain and
everybody can see. `flatten()` is the only place this arithmetic exists and
`imgexport_test.py` builds the case that fails under the wrong one.

The second half of the same trap: a format that cannot carry alpha flattens onto
a **stated** matte, default WHITE. PIL's `convert("RGB")` drops the alpha
channel and keeps whatever RGB was hiding underneath, which for a cutout is
black - the black halo in every "why is my exported PNG-to-JPEG ruined" bug
report. This module never calls `convert("RGB")` on an image with alpha.

What it does:

    encode(rgba, opts, exif=None)         -> (bytes, meta)   the one encoder
    export(rgba, path, opts, exif=None)   -> result dict     encode + write
    estimate_size(rgba, opts, mode)       -> result dict     no file touched
    target_size(rgba, max_bytes, opts,
                out_path=None)            -> result dict     "under 500 KB"
    flatten(rgba, matte)                  -> float32 (H, W, 3)
    resize_rgba(rgba, w, h, filt)         -> float32 (H, W, 4)
    resolve(opts)                         -> (fmt, values, report)
    catalog()                             -> what MCP and the UI are served

    python imgexport.py catalog
    python imgexport.py export   <job.json>
    python imgexport.py estimate <job.json>
    python imgexport.py target   <job.json>

`CATALOG` describes every format and EVERY parameter the way effects.py does,
because the UI and the MCP schema are both generated from it. Two rules follow
from that and both are tested:

  * A parameter in the catalog is a parameter the code reads. A knob that is
    accepted and ignored is worse than a refusal - a schema is precisely what a
    caller trusts. Pillow 12.3 ships two of those (see UNSUPPORTED below) and
    neither is offered here.
  * Nothing is dropped in silence. An unknown key is an error naming it; a key
    that belongs to a different format comes back in `ignored`; a number outside
    its range comes back in `clamped` with what was asked and what was used.

Colours - `matte` - are **0-255**, like everywhere else in this codebase. A
0-1 triple is a legal near-black, so it flattens perfectly, every alpha matches,
every pixel-counting test passes, and only the picture is wrong.

UNSUPPORTED, measured on this box rather than assumed (Pillow 12.3.0):

  * **AVIF has no lossless.** `AvifImagePlugin._save` reads `quality` and
    `subsampling` out of `info` and nothing else, so `lossless=True` is
    swallowed by the kwargs dict and never reaches libavif - it silently
    encodes at the default quality instead. Round-tripping noise through
    `lossless=True` came back with a max channel error of 220/255. There is no
    lossless AVIF here, so this module does not offer one.
  * **`Image.quantize(dither=...)` is a no-op** when you also pass `method=`:
    that branch calls the C quantiser directly and never looks at `dither`.
    Byte-identical output for NONE and FLOYDSTEINBERG, both MEDIANCUT and
    FASTOCTREE. Dithering works only through the two-step fixed-palette path
    (`quantize(colors, method)` for the palette, then `quantize(palette=pal,
    dither=...)`), which is what `_palette()` does - and that path refuses RGBA
    outright, so `dither` on an image with alpha is reported in `ignored`.
  * **Pillow cannot write 16-bit colour** - PNG or TIFF, RGB or RGBA, it is
    `TypeError: Cannot handle this data type`. 16-bit PNG here goes through
    OpenCV, which writes and reads it bit-exact. OpenCV has no EXIF, so
    `bitDepth: 16` plus `metadata: "preserve"` is an error rather than a
    surprise.
  * **PDF cannot be reopened by PIL at all** (`PDF` is in `Image.SAVE`, not
    `Image.OPEN`), so the export is verified structurally, not by round-trip.
  * **Pillow's ICO writer silently under-delivers, twice.** It keeps the aspect
    ratio, so a 300x100 source asked for 32x32 writes a 32x11 entry; and it
    drops any requested size that does not fit inside the source on BOTH axes,
    so that same source loses its 256 entry with no error at all - and an 8x8
    source asked for the default sizes writes a six-byte file containing zero
    entries, which PIL then cannot reopen. Icons are square, so `_to_pil` pads
    to square on transparency and scales up to the largest size asked for, and
    `encode` reads the icon directory back and REFUSES rather than returning
    one that is quietly short.

Two behaviours worth knowing before reading a result dict:

  * **An opaque image drops its alpha channel.** A constant 255 plane costs
    bytes for nothing, and for PNG it costs more than bytes - Pillow's palette
    quantiser refuses MEDIANCUT on RGBA and its dithering path refuses RGBA
    outright, so an opaque picture that kept its alpha silently gets the worse
    palette and no dither. Reported as `alphaDropped`. The test for "is it
    opaque" is "does every alpha round to 255", not "is every alpha exactly
    1.0", because a lanczos resample of an opaque image leaves 0.9999995.
  * **`ignored` is about what the caller ASKED for.** A knob that belongs to
    this format but does nothing given the others - WebP `quality` under
    `lossless`, TIFF `quality` under a lossless compression, `paletteColors`
    with no palette - is named there with a reason in `unusedNotes`. A default
    sitting unused is not, because nobody asked for it.

numpy / cv2 / PIL, the same three server/vfx already needs.
"""
import base64
import io
import json
import math
import os
import struct
import sys
import zlib
from xml.sax.saxutils import escape as _xml_escape

import cv2
import numpy as np
import PIL
from PIL import Image

PIL_VERSION = getattr(PIL, "__version__", "?")

_EPS = np.float32(1e-6)


# ---------------------------------------------------------------------------
# what this Pillow can actually do
# ---------------------------------------------------------------------------

def _probe(fmt):
    """Can this build write `fmt`? Asked, not assumed - AVIF needs Pillow
    >= 11.3 or the pillow-avif plugin, and WebP needs libwebp at build time.
    Both are absent often enough that guessing produces a format the UI offers
    and the export refuses. A 1x1 encode settles it for about a millisecond."""
    Image.init()
    if fmt not in Image.SAVE:
        return False, (f"this Pillow ({PIL_VERSION}) has no {fmt} writer - AVIF "
                       f"needs Pillow >= 11.3 or the pillow-avif plugin, WebP "
                       f"needs libwebp at build time")
    try:
        Image.new("RGB", (1, 1)).save(io.BytesIO(), format=fmt)
    except Exception as exc:                                # noqa: BLE001
        return False, f"{fmt} writer present but failed on a 1x1 image: {exc}"
    return True, None


# ---------------------------------------------------------------------------
# the catalog vocabulary - the same four constructors effects.py uses, so a
# schema generator that already walks one catalog walks this one unchanged
# ---------------------------------------------------------------------------

def num(default, lo, hi, desc, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "desc": desc}


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default, "desc": desc}


def col(default, desc):
    """Colours are 0-255 RGB, the units the whole codebase stores."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255, "desc": desc}


def multi(options, default, desc):
    """A set chosen from a fixed list - ICO's size list is the only one, and it
    is the reason ICO exists at all."""
    return {"type": "multiselect", "options": list(options), "default": list(default),
            "desc": desc}


GROUP_ORDER = ["Web", "Photographic", "Archival", "Document & Icon"]

# cv2 rather than PIL for every resample, because the resize runs on
# PREMULTIPLIED float32 and PIL wants 8-bit or a per-band "F" image.
RESAMPLE = {"lanczos": cv2.INTER_LANCZOS4, "bicubic": cv2.INTER_CUBIC,
            "bilinear": cv2.INTER_LINEAR, "area": cv2.INTER_AREA,
            "nearest": cv2.INTER_NEAREST}

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# Applies to every format. Kept apart from the per-format knobs so a UI can draw
# it once above the format tabs, which is also how the export dialog reads.
COMMON = {
    "resizeMode": pick(["none", "longestEdge", "exact", "percent"], "none",
                       "how the output is scaled; 'none' exports at the edit's size"),
    "resizeLongestEdge": num(2048, 1, 16384, "longestEdge: the longer side, in px; "
                             "the shorter one follows the aspect ratio", integer=True,
                             unit="px"),
    "resizeWidth": num(0, 0, 16384, "exact: output width; 0 means derive it from "
                       "the height and the aspect ratio", integer=True, unit="px"),
    "resizeHeight": num(0, 0, 16384, "exact: output height; 0 means derive it from "
                        "the width and the aspect ratio", integer=True, unit="px"),
    "resizePercent": num(100, 1, 1000, "percent: scale factor; 50 halves each side. "
                         "Rounds HALF UP and never below 1px", unit="%"),
    "resample": pick(["auto", "lanczos", "bicubic", "bilinear", "area", "nearest"],
                     "auto", "auto = area when shrinking (no ringing, correctly "
                     "averaged) and lanczos when growing, which is the right answer "
                     "often enough that picking by hand is usually a mistake"),
    "matte": col([255, 255, 255], "0-255 RGB that alpha is flattened onto for a "
                 "format that cannot carry it. WHITE, not black, and always "
                 "reported back - the black halo on an exported cutout is this "
                 "colour being chosen silently"),
    "metadata": pick(["strip", "preserve", "none"], "strip",
                     "EXIF and the detailed provenance record. 'strip' (the "
                     "default) drops EXIF - it carries the camera, the software, "
                     "the timestamp and sometimes GPS - and STILL WRITES the "
                     "provenance XMP; 'preserve' keeps EXIF passed in and writes "
                     "the provenance XMP; 'none' drops EXIF and the detailed "
                     "record both. The Tier-1 AI marker is NOT governed by this "
                     "option: when the export carries one it is written in every "
                     "mode - the model licences and EU AI Act Art 50(2) put the "
                     "marking duty on the tool, so no exposed option removes it"),
}

CATALOG = {
    "png": {
        "label": "PNG", "group": "Web", "ext": ".png", "pil": "PNG", "mime": "image/png",
        "alpha": True, "lossy": False, "exifCapable": True,
        "why": "the safe default: lossless, alpha, opens everywhere. Turn `palette` "
               "on for flat art and UI - 256 colours is routinely a tenth the size "
               "and pixel-identical to the eye, which is the entire point of "
               "offering it",
        "params": {
            "compressLevel": num(6, 0, 9, "zlib effort. 9 is roughly 3x the time of "
                                 "6 for a few percent; 0 writes stored blocks",
                                 integer=True),
            "palette": flag(False, "quantise to an indexed palette. Lossy in colour, "
                            "lossless in geometry - wrong for photographs, right for "
                            "anything with flat areas"),
            "paletteColors": num(256, 2, 256, "palette size. PNG picks the bit depth "
                                 "from this: <=2 colours writes 1 bit/px, <=4 writes "
                                 "2, <=16 writes 4", integer=True),
            "dither": flag(False, "Floyd-Steinberg error diffusion. Hides banding in "
                           "gradients and costs size (it adds entropy - a dithered "
                           "8-colour gradient measured 5x the undithered one). "
                           "IGNORED on an image with alpha: Pillow's fixed-palette "
                           "path, the only one that honours dither at all, refuses "
                           "RGBA"),
            "bitDepth": pick([8, 16], 8, "bits per channel for truecolour. 16 keeps "
                             "the float precision the edit was done at and is written "
                             "through OpenCV, because Pillow cannot write 16-bit "
                             "colour. Palette PNGs ignore this - their depth comes "
                             "from paletteColors"),
        },
    },
    "jpeg": {
        "label": "JPEG", "group": "Photographic", "ext": ".jpg", "pil": "JPEG",
        "mime": "image/jpeg",
        "alpha": False, "lossy": True, "exifCapable": True,
        "why": "photographs, and the only format every system on earth reads. No "
               "alpha at all, so a cutout gets flattened onto the matte",
        "params": {
            "quality": num(85, 1, 100, "1-100. Above ~95 the file grows fast for "
                           "almost nothing; below ~60 blocking shows on flat areas",
                           integer=True),
            "progressive": flag(False, "renders coarse-to-fine while downloading, and "
                                "is usually a few percent SMALLER as a side effect"),
            "chroma": pick(["4:4:4", "4:2:2", "4:2:0"], "4:2:0",
                           "chroma subsampling. 4:2:0 throws away three quarters of "
                           "the colour resolution and is invisible on photographs; "
                           "4:4:4 keeps all of it and is what saturated text, UI and "
                           "line art need - measured 8283 vs 4281 bytes on the same "
                           "q90 tile, so it is not free"),
        },
    },
    "webp": {
        "label": "WebP", "group": "Web", "ext": ".webp", "pil": "WEBP", "mime": "image/webp",
        "alpha": True, "lossy": True, "exifCapable": True,
        "why": "smaller than JPEG at the same quality and it keeps alpha, which is "
               "the combination PNG and JPEG each half-miss. Lossless mode beats PNG "
               "on photographs and loses to it on flat art",
        "params": {
            "quality": num(80, 1, 100, "1-100, ignored when lossless is on",
                           integer=True),
            "lossless": flag(False, "bit-exact. Forces `exact` on underneath, because "
                             "libwebp otherwise rewrites the RGB of fully transparent "
                             "pixels to compress better - harmless for display and "
                             "destructive for a straight-alpha round trip"),
            "effort": num(4, 0, 6, "encoder effort, 0 fastest. Size only; the pixels "
                          "at a given quality do not change", integer=True),
        },
    },
    "avif": {
        "label": "AVIF", "group": "Web", "ext": ".avif", "pil": "AVIF", "mime": "image/avif",
        "alpha": True, "lossy": True, "exifCapable": True,
        "why": "the smallest of the four at a given quality, roughly half of JPEG, "
               "with alpha and no generation-loss cliff. Newer decoders only. NO "
               "LOSSLESS MODE - Pillow's AVIF writer reads quality and subsampling "
               "and nothing else, so a `lossless` flag would be a lie",
        "params": {
            "quality": num(60, 1, 100, "1-100. AVIF 60 is around JPEG 85",
                           integer=True),
            "speed": num(6, 0, 10, "encoder speed, 0 slowest and smallest. 0 on a "
                         "large image is genuinely slow", integer=True),
            "chroma": pick(["4:4:4", "4:2:2", "4:2:0"], "4:2:0",
                           "as JPEG. 4:4:4 matters far more here than it does for "
                           "JPEG because AVIF's default is aggressive"),
        },
    },
    "tiff": {
        "label": "TIFF", "group": "Archival", "ext": ".tiff", "pil": "TIFF",
        "mime": "image/tiff",
        "alpha": True, "lossy": False, "exifCapable": True,
        "why": "the archival copy: lossless, alpha, and the one format print and "
               "scientific tools all take. Big, and meant to be",
        "params": {
            "compression": pick(["none", "tiff_lzw", "tiff_deflate", "packbits", "jpeg"],
                                "tiff_deflate",
                                "deflate is smallest and lossless; lzw is the widest "
                                "compatibility and measured LARGER than raw on noise; "
                                "'jpeg' is lossy and stops being an archival copy"),
            "quality": num(90, 1, 100, "only read when compression is 'jpeg'",
                           integer=True),
        },
    },
    "ico": {
        "label": "ICO", "group": "Document & Icon", "ext": ".ico", "pil": "ICO",
        "mime": "image/x-icon", "alpha": True, "lossy": False, "exifCapable": False,
        "why": "favicons and Windows shortcuts - a CONTAINER of several sizes, which "
               "is the only reason anyone wants one. Pillow under-delivers one "
               "silently in two ways: it drops any size that does not fit the source "
               "on both axes (a 64px source asked for 16/32/48/256 writes three "
               "entries; an 8px source writes a six-byte file with none, which PIL "
               "cannot even reopen) and it keeps the aspect ratio, so a wide source "
               "asked for 32x32 gets 32x11. Icons are square, so this pads to square "
               "on transparency, scales up to the largest size asked for, then reads "
               "the icon directory back and REFUSES if anything is missing",
        "params": {
            "sizes": multi(ICO_SIZES, [16, 32, 48, 256],
                           "square sizes to pack, px. 16/32/48 is the Windows set, "
                           "256 is what modern shells scale from"),
        },
    },
    "pdf": {
        "label": "PDF", "group": "Document & Icon", "ext": ".pdf", "pil": "PDF",
        "mime": "application/pdf", "alpha": False, "lossy": False, "exifCapable": False,
        "why": "one page, one image - for sending a proof to somebody who will print "
               "it. Pillow CAN write an /SMask and keep alpha, but a page is composited "
               "onto paper and a transparent proof prints as whatever the viewer felt "
               "like, so this flattens onto the matte and says so",
        "params": {
            "dpi": num(300, 1, 1200, "pixels per inch, which is what decides the page "
                       "size: 3000px at 300dpi is a 10 inch page. Nothing is "
                       "resampled", integer=True, unit="dpi"),
        },
    },
}

ALIASES = {"jpg": "jpeg", "tif": "tiff", "jpe": "jpeg"}

_JPEG_SUBSAMPLING = {"4:4:4": 0, "4:2:2": 1, "4:2:0": 2}

# Availability is probed once at import. AVIF and WebP are the two that go
# missing; the rest are core Pillow and still get asked, because "core" has been
# wrong before.
_AVAILABLE = {}
for _name, _entry in CATALOG.items():
    _ok, _whynot = _probe(_entry["pil"])
    _entry["available"] = _ok
    if not _ok:
        _entry["unavailableWhy"] = _whynot
    _AVAILABLE[_name] = _ok

# The estimator switches to sampling above this many output pixels. Chosen from
# measured encode times on this box: a 1MP WebP encode is 246ms and a 12MP one
# is 1.9s (PNG at compressLevel 9: 282ms and 10.5s). Two megapixels is the last
# point where an exact answer still arrives inside a slider's debounce.
EXACT_PIXEL_BUDGET = 2_000_000

# Pixels the sampling estimator is allowed to encode, and the lattice it pulls
# them from. See estimate_size() for why tiles beat a downscale.
SAMPLE_PIXEL_BUDGET = 512 * 512
SAMPLE_GRID = 4

# The measured worst case of the sampling estimator, over nine real 1024px
# renders and four synthetic photographs, across JPEG/WebP/AVIF/PNG/TIFF at two
# qualities each: 18.3% (WebP quality 40, the hardest case there is). Advertised
# at 25 so the number has margin over content this test set does not contain -
# and imgexport_test.py prints the error it actually measured every run, so
# drift shows up rather than hiding under a loose bound.
SAMPLE_TOLERANCE = 0.25


# ---------------------------------------------------------------------------
# the input contract
# ---------------------------------------------------------------------------

def as_rgba(src):
    """float32 (H, W, 4), 0..1, STRAIGHT alpha - from an array, a PIL image or
    a path. The one adapter; everything below this line takes the array."""
    if isinstance(src, str):
        with Image.open(src) as im:
            return as_rgba(im)
    if isinstance(src, Image.Image):
        return np.asarray(src.convert("RGBA")).astype(np.float32) / 255.0
    arr = np.asarray(src)
    if arr.dtype == np.uint8:
        arr = arr.astype(np.float32) / 255.0
    else:
        arr = arr.astype(np.float32, copy=False)
    if arr.ndim == 2:
        arr = np.dstack([arr, arr, arr, np.ones_like(arr)])
    elif arr.ndim == 3 and arr.shape[2] == 3:
        arr = np.dstack([arr, np.ones(arr.shape[:2], np.float32)])
    if arr.ndim != 3 or arr.shape[2] != 4:
        raise ValueError(f"expected (H, W, 4) RGBA, got {arr.shape}")
    if arr.shape[0] < 1 or arr.shape[1] < 1:
        raise ValueError(f"an image needs at least one pixel, got {arr.shape[1]}x{arr.shape[0]}")
    return np.clip(arr, 0.0, 1.0)


def load_source(path):
    """(rgba, exif_bytes) - the pair `metadata: "preserve"` needs, because a
    float array carries no EXIF and there is nowhere else for it to come from."""
    with Image.open(path) as im:
        rgba = as_rgba(im)
        raw = im.info.get("exif")
        if raw is None:
            try:
                ex = im.getexif()
                raw = ex.tobytes() if len(ex) else None
            except Exception:                               # noqa: BLE001
                raw = None
    return rgba, raw


# ---------------------------------------------------------------------------
# flatten - the one place coverage is multiplied in
# ---------------------------------------------------------------------------

def flatten(rgba, matte=(255, 255, 255)):
    """Composite straight-alpha RGBA onto an opaque matte -> float32 (H, W, 3).

        out = rgb * a + matte * (1 - a)

    `matte` is 0-255. The premultiplied spelling of this line multiplies the
    coverage in twice and darkens every partially transparent pixel; a white
    cutout on a white matte is the case that catches it, because the correct
    answer there is uniformly white and the wrong one has a grey rim."""
    m = np.asarray(matte, dtype=np.float32).reshape(-1)[:3] / 255.0
    if m.size != 3:
        raise ValueError(f"matte is an 0-255 RGB triple, got {matte!r}")
    a = rgba[..., 3:4]
    return np.clip(rgba[..., :3] * a + m[None, None, :] * (1.0 - a), 0.0, 1.0)


# ---------------------------------------------------------------------------
# resize
# ---------------------------------------------------------------------------

def resize_rgba(rgba, width, height, filt="auto"):
    """Resample to exactly (width, height), premultiplied.

    Premultiplied because resampling STRAIGHT alpha mixes the colour of pixels
    that are fully transparent - pixels whose RGB is undefined - into every
    edge. That is the same black halo `effects.py` documents, arriving through
    a different door. Un-premultiplied on the way out, so what comes back is
    still the straight-alpha array everything else here expects."""
    h, w = rgba.shape[:2]
    width, height = int(width), int(height)
    if width < 1 or height < 1:
        raise ValueError(f"resize target must be at least 1x1, got {width}x{height}")
    if (width, height) == (w, h):
        return rgba
    if filt == "auto":
        # Shrinking, INTER_AREA is a box average over exactly the source pixels
        # that map into the destination one - no ringing and no aliasing.
        # Growing, lanczos has the sharpest reconstruction that is not ringing.
        interp = cv2.INTER_AREA if (width * height) < (w * h) else cv2.INTER_LANCZOS4
    elif filt in RESAMPLE:
        interp = RESAMPLE[filt]
    else:
        raise ValueError(f"unknown resample filter {filt!r}; one of {sorted(RESAMPLE)} or 'auto'")
    pm = rgba.copy()
    pm[..., :3] *= pm[..., 3:4]
    out = cv2.resize(pm, (width, height), interpolation=interp)
    a = np.clip(out[..., 3], 0.0, 1.0)
    rgb = np.clip(out[..., :3] / np.maximum(a, _EPS)[..., None], 0.0, 1.0)
    res = np.empty((height, width, 4), np.float32)
    res[..., :3] = rgb
    res[..., 3] = a
    return res


def _round_half_up(x):
    """Percent resize rounds HALF UP, stated because Python's round() does not:
    round(0.5) is 0 and round(1.5) is 2, which makes a 50% resize of a 101px
    image 50px on one axis and 51 on the other for no reason a user can see."""
    return int(math.floor(float(x) + 0.5))


def _target_dims(w, h, o):
    """The output size, from resizeMode. Returns (w, h) and never zero."""
    mode = o["resizeMode"]
    if mode == "none":
        return w, h
    if mode == "longestEdge":
        edge = int(o["resizeLongestEdge"])
        if max(w, h) == edge:
            return w, h
        s = edge / float(max(w, h))
        return max(1, _round_half_up(w * s)), max(1, _round_half_up(h * s))
    if mode == "percent":
        s = float(o["resizePercent"]) / 100.0
        return max(1, _round_half_up(w * s)), max(1, _round_half_up(h * s))
    if mode == "exact":
        tw, th = int(o["resizeWidth"]), int(o["resizeHeight"])
        if tw <= 0 and th <= 0:
            raise ValueError("resizeMode 'exact' needs resizeWidth or resizeHeight "
                             "(or both); both were 0")
        if tw <= 0:
            tw = max(1, _round_half_up(w * (th / float(h))))
        elif th <= 0:
            th = max(1, _round_half_up(h * (tw / float(w))))
        return tw, th
    raise ValueError(f"unknown resizeMode {mode!r}")


# ---------------------------------------------------------------------------
# options - validated against the catalog, nothing dropped quietly
# ---------------------------------------------------------------------------

_ALL_PARAM_KEYS = set(COMMON) | {k for e in CATALOG.values() for k in e["params"]}


def resolve(opts):
    """(fmt, values, report) - every option this format will act on.

    `report` carries `ignored` (a real key, but not for this format) and
    `clamped` ({asked, used}). An unknown key is an ERROR naming it, because
    rebuilding an options object from a key list and dropping the rest is the
    single most expensive habit in this codebase."""
    opts = dict(opts or {})
    raw_fmt = str(opts.pop("format", "") or "").strip().lower().lstrip(".")
    fmt = ALIASES.get(raw_fmt, raw_fmt)
    if not fmt:
        raise ValueError(f"no format given; one of {sorted(CATALOG)}")
    if fmt not in CATALOG:
        raise ValueError(f"unknown format {raw_fmt!r}; one of "
                         f"{sorted(set(CATALOG) | set(ALIASES))}")
    entry = CATALOG[fmt]
    if not entry.get("available"):
        raise ValueError(f"{entry['label']} is not available here: "
                         f"{entry.get('unavailableWhy')}")

    unknown = sorted(set(opts) - _ALL_PARAM_KEYS)
    if unknown:
        raise ValueError(f"unknown option(s) {unknown} - the catalog is the whole "
                         f"vocabulary; for {fmt} that is "
                         f"{sorted(set(COMMON) | set(entry['params']))}")

    spec = dict(COMMON)
    spec.update(entry["params"])
    ignored = sorted(k for k in opts if k not in spec)
    clamped = {}
    values = {}
    for key, p in spec.items():
        if key not in opts:
            values[key] = p["default"] if p["type"] != "color" else list(p["default"])
            continue
        v = opts[key]
        if p["type"] == "number":
            v = float(v)
            lo, hi = float(p["min"]), float(p["max"])
            if v < lo or v > hi:
                used = min(hi, max(lo, v))
                clamped[key] = {"asked": v, "used": used}
                v = used
            values[key] = int(round(v)) if p.get("integer") else v
        elif p["type"] == "bool":
            values[key] = bool(v)
        elif p["type"] == "enum":
            if v not in p["options"]:
                raise ValueError(f"{key}={v!r} is not one of {p['options']} - an enum "
                                 f"has no sensible nearest value, so this is an error "
                                 f"rather than a clamp")
            values[key] = v
        elif p["type"] == "color":
            c = list(np.asarray(v, dtype=np.float64).reshape(-1))
            if len(c) not in (3, 4):
                raise ValueError(f"{key} is an 0-255 RGB triple, got {v!r}")
            out = []
            for ch in c[:3]:
                if ch < 0 or ch > 255:
                    clamped.setdefault(key, {"asked": list(c[:3]), "used": None})
                    ch = min(255.0, max(0.0, ch))
                out.append(int(round(ch)))
            if key in clamped and clamped[key]["used"] is None:
                clamped[key]["used"] = out
            values[key] = out
        elif p["type"] == "multiselect":
            want = [int(x) for x in (v if isinstance(v, (list, tuple)) else [v])]
            bad = sorted(set(want) - set(p["options"]))
            if bad:
                raise ValueError(f"{key}: {bad} not in {p['options']}")
            if not want:
                raise ValueError(f"{key} cannot be empty")
            values[key] = sorted(set(want))
    return fmt, values, {"ignored": ignored, "clamped": clamped}


# ---------------------------------------------------------------------------
# building the image the encoder is handed
# ---------------------------------------------------------------------------

def _palette(im, colors, dither):
    """Indexed PIL image, at most `colors` distinct colours.

    Two Pillow facts drive every line of this. MEDIANCUT refuses RGBA - only
    FASTOCTREE and libimagequant take it - and `quantize(dither=...)` is
    ignored whenever `method=` is given, so dithering has to go through the
    fixed-palette call instead. Which itself refuses RGBA. Hence: alpha means
    octree and no dither, and the caller is told."""
    has_alpha = im.mode == "RGBA"
    method = Image.FASTOCTREE if has_alpha else Image.MEDIANCUT
    pal = im.quantize(colors=colors, method=method)
    if dither and not has_alpha:
        return im.quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG), True
    return pal, False


def _to_pil(rgba, fmt, o):
    """(PIL image, notes) - the pixels exactly as the encoder will see them.

    Order matters and is the same order imagetools uses: resize LAST of the
    pixel stages so nothing is resampled twice, then flatten, then quantise.
    Flattening before resizing would resample an opaque image and lose the
    edge; quantising before resizing would resample a palette."""
    notes = {}
    h, w = rgba.shape[:2]
    tw, th = _target_dims(w, h, o)
    if (tw, th) != (w, h):
        rgba = resize_rgba(rgba, tw, th, o["resample"])
        notes["resizedFrom"] = [w, h]
    notes["width"], notes["height"] = tw, th

    entry = CATALOG[fmt]
    carries_alpha = entry["alpha"]
    # Tolerance, not < 1.0: a lanczos resample of an opaque image can leave
    # alpha at 0.9999997, and an image whose alpha rounds to 255 everywhere IS
    # opaque in the file about to be written.
    has_alpha = float(rgba[..., 3].min()) < 1.0 - (0.5 / 255.0)

    if fmt == "ico":
        # Two Pillow behaviours, neither of them announced. It KEEPS THE ASPECT
        # RATIO - a 300x100 source asked for 32x32 writes a 32x11 entry - and it
        # then drops any requested size that does not fit inside the source on
        # BOTH axes, so that same source silently loses its 256 entry entirely.
        # Icons are square, so: pad to square on transparency first, then scale
        # up so the square covers the largest size asked for. Every entry then
        # comes out genuinely NxN.
        big = max(o["sizes"])
        if tw != th:
            side = max(tw, th)
            square = np.zeros((side, side, 4), np.float32)
            x0, y0 = (side - tw) // 2, (side - th) // 2
            square[y0:y0 + th, x0:x0 + tw] = rgba
            rgba = square
            tw = th = side
            notes["icoPaddedToSquare"] = side
        if tw < big:
            rgba = resize_rgba(rgba, big, big, o["resample"])
            tw = th = big
            notes["icoUpscaledTo"] = big

    if carries_alpha and has_alpha:
        arr = np.clip(rgba * 255.0 + 0.5, 0, 255).astype(np.uint8)
        im = Image.fromarray(arr, "RGBA")
    elif carries_alpha:
        # An opaque image keeps no alpha channel. Carrying a constant 255 plane
        # into the file costs bytes for nothing, and for PNG it costs more than
        # bytes: Pillow's palette quantiser refuses MEDIANCUT on RGBA and its
        # fixed-palette (dithering) path refuses RGBA outright, so an opaque
        # picture that never dropped its alpha silently gets the worse palette
        # and no dither at all.
        im = Image.fromarray(np.clip(rgba[..., :3] * 255.0 + 0.5, 0, 255).astype(np.uint8),
                             "RGB")
        notes["alphaDropped"] = True
    else:
        rgb = flatten(rgba, o["matte"])
        im = Image.fromarray(np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8), "RGB")
        if has_alpha:
            notes["flattenedOnto"] = list(o["matte"])

    if fmt == "png" and o["palette"]:
        im, dithered = _palette(im, o["paletteColors"], o["dither"])
        notes["paletteColors"] = o["paletteColors"]
        notes["dithered"] = dithered
    return im, notes


# ---------------------------------------------------------------------------
# encoding
# ---------------------------------------------------------------------------

def _png16(rgba, o):
    """16-bit truecolour PNG, through OpenCV because Pillow cannot write one.

    Straight from the float, so this is the only path that does not round-trip
    the edit through 8 bits first - which is the whole reason to ask for it."""
    u16 = np.clip(rgba * 65535.0 + 0.5, 0, 65535).astype(np.uint16)
    # Same rule as the 8-bit path: an opaque image carries no alpha plane, and
    # at 16 bits a dead channel is two wasted bytes per pixel rather than one.
    opaque = int(u16[..., 3].min()) == 65535
    data = u16[..., [2, 1, 0]] if opaque else u16[..., [2, 1, 0, 3]]
    ok, buf = cv2.imencode(".png", data, [cv2.IMWRITE_PNG_COMPRESSION,
                                          int(o["compressLevel"])])
    if not ok:
        raise ValueError("OpenCV refused to encode the 16-bit PNG")
    return buf.tobytes(), opaque


def encode(rgba, opts, exif=None):
    """(bytes, meta) - the ONE encoder. export(), estimate_size() and
    target_size() all come through here, so a file, its live size estimate and
    the result of a size search cannot disagree about anything."""
    rgba = as_rgba(rgba)
    fmt, o, report = resolve(opts)
    entry = CATALOG[fmt]
    meta = {"format": fmt, "ext": entry["ext"], "mime": entry["mime"]}
    meta.update(report)
    # Which metadata mode was in force, so the provenance layer downstream can
    # honour "none" without re-resolving the options.
    meta["metadata"] = o["metadata"]
    ignored = list(report["ignored"])

    keep_exif = o["metadata"] == "preserve"
    if keep_exif and not entry["exifCapable"]:
        raise ValueError(f"{entry['label']} has no EXIF container - ask for "
                         f"metadata:'strip' rather than being told it was kept")
    if keep_exif and exif is None:
        meta["metadataNote"] = ("preserve was asked for and no EXIF was supplied - "
                                "a float array has none of its own, so nothing was "
                                "written")

    # 16-bit PNG bypasses Pillow entirely, so it also bypasses everything Pillow
    # would have carried. Loud, because a silently-8-bit or silently-stripped
    # export is the failure nobody finds.
    if fmt == "png" and o["bitDepth"] == 16:
        if o["palette"]:
            raise ValueError("a palette PNG is indexed - 8 bits per index at most - "
                             "so bitDepth 16 and palette cannot both be true")
        if keep_exif and exif is not None:
            raise ValueError("16-bit PNG is written through OpenCV, which cannot "
                             "carry EXIF; ask for bitDepth 8 or metadata 'strip'")
        h, w = rgba.shape[:2]
        tw, th = _target_dims(w, h, o)
        work = resize_rgba(rgba, tw, th, o["resample"]) if (tw, th) != (w, h) else rgba
        data, opaque = _png16(work, o)
        # OpenCV writes truecolour only, so anything palette-shaped that was
        # asked for is named rather than quietly skipped.
        asked = set(opts or {})
        meta.update({"width": tw, "height": th, "bitDepth": 16, "bytes": len(data),
                     "ignored": sorted(set(ignored) | (asked & {"palette",
                                                                "paletteColors",
                                                                "dither"})),
                     "exifWritten": False, "matte": None})
        if opaque:
            meta["alphaDropped"] = True
        return data, meta

    im, notes = _to_pil(rgba, fmt, o)
    meta.update(notes)

    kw = {}
    if keep_exif and exif is not None:
        kw["exif"] = exif

    # Some knobs only apply when another knob is set a particular way - WebP's
    # quality means nothing under lossless, TIFF's means nothing unless the
    # compression is jpeg. Those are still knobs a caller SET and the code then
    # did not read, so they are named. Only what was actually passed: a default
    # sitting unused is not something anybody asked for.
    asked = set(opts or {})

    def unused(key, why):
        if key in asked:
            ignored.append(key)
            meta.setdefault("unusedNotes", {})[key] = why

    if fmt == "png":
        kw["compress_level"] = int(o["compressLevel"])
        if o["dither"] and not notes.get("dithered"):
            ignored.append("dither")
            meta["ditherNote"] = (
                "dither only means anything when palette is on" if not o["palette"]
                else "dither needs Pillow's fixed-palette path and that path refuses "
                     "RGBA, so an image with alpha cannot be dithered here")
        if not o["palette"]:
            unused("paletteColors", "there is no palette to size unless palette is on")
        meta["bitDepth"] = 8
    elif fmt == "jpeg":
        kw.update(quality=int(o["quality"]), optimize=True,
                  progressive=bool(o["progressive"]),
                  subsampling=_JPEG_SUBSAMPLING[o["chroma"]])
    elif fmt == "webp":
        if o["lossless"]:
            # `exact` keeps the RGB under fully transparent pixels. Without it
            # libwebp rewrites it, which is invisible on screen and makes a
            # "lossless" straight-alpha round trip fail by up to 252/255.
            kw.update(lossless=True, exact=True, method=int(o["effort"]))
            unused("quality", "lossless WebP has no quality to trade")
        else:
            kw.update(quality=int(o["quality"]), method=int(o["effort"]))
    elif fmt == "avif":
        kw.update(quality=int(o["quality"]), speed=int(o["speed"]),
                  subsampling=o["chroma"])
    elif fmt == "tiff":
        comp = o["compression"]
        kw["compression"] = None if comp == "none" else comp
        if comp == "jpeg":
            kw["quality"] = int(o["quality"])
            meta["lossyNote"] = "compression 'jpeg' makes this a lossy TIFF"
        else:
            unused("quality", f"TIFF quality is only read under compression 'jpeg', "
                              f"and this is '{comp}' - which is lossless, so there is "
                              f"nothing to trade")
    elif fmt == "ico":
        kw["sizes"] = [(s, s) for s in o["sizes"]]
    elif fmt == "pdf":
        kw["resolution"] = float(o["dpi"])

    buf = io.BytesIO()
    im.save(buf, format=entry["pil"], **kw)
    data = buf.getvalue()

    if fmt == "ico":
        # Trust nothing: read the directory back and report what is really in it.
        meta["sizesWritten"] = _ico_sizes(data)
        missing = sorted(set(o["sizes"]) - set(meta["sizesWritten"]))
        if missing:
            raise ValueError(f"ICO was asked for {o['sizes']} and only "
                             f"{meta['sizesWritten']} were written (missing "
                             f"{missing}) - refusing to hand back an icon that is "
                             f"quietly short")
    meta["ignored"] = sorted(set(ignored))
    meta["bytes"] = len(data)
    meta["exifWritten"] = bool(kw.get("exif"))
    meta["matte"] = list(o["matte"]) if not entry["alpha"] else None
    return data, meta


def _ico_sizes(data):
    """The sizes actually in an ICO, read out of its directory. 0 in the header
    means 256 - the field is one byte."""
    if len(data) < 6 or data[0:4] != b"\x00\x00\x01\x00":
        return []
    n = struct.unpack("<H", data[4:6])[0]
    out = []
    for i in range(n):
        off = 6 + i * 16
        if off + 2 > len(data):
            break
        out.append(data[off] or 256)
    return sorted(set(out))


# ---------------------------------------------------------------------------
# provenance (SPEC D3) - the XMP writer and the per-container injectors
#
# TWO TIERS. The `marker` is the machine-readable AI disclosure - IPTC
# DigitalSourceType URI, a plain sentence, generator, tool. It is written in
# EVERY metadata mode ("strip", "preserve", "none") whenever the caller
# supplies one: the marking duty sits on the tool (EU AI Act Art 50(2) + the
# model licences), so no exposed option removes it. The `record` is the rich
# provenance - prompt, seeds, origin map, ledger chain head - and IS governed
# by the user: the embed toggle decides whether the caller passes it at all,
# and metadata "none" drops it even when passed.
#
# PNG carries the packet in an iTXt chunk keyed XML:com.adobe.xmp; JPEG in an
# APP1 segment with the standard XMP namespace header. Both are what exiftool
# and Google's DigitalSourceType readers parse. Formats without an injector
# here get a `<file>.provenance.json` sidecar instead, and the result dict
# says which of the two happened - the UI must never claim an embed that fell
# back (meta["provenance"]: "xmp" | "sidecar" | None).
# ---------------------------------------------------------------------------

_XMP_KEYWORD = b"XML:com.adobe.xmp"
_XMP_JPEG_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"


def build_xmp(marker, record=None):
    """The XMP packet, as bytes. RDF/XML by hand - it is a fixed template with
    escaped strings, and pulling in an XMP library for that would be the wrong
    trade for every machine that has to install this app."""
    e = lambda v: _xml_escape(str(v), {'"': "&quot;"})  # noqa: E731
    attrs = []
    inner = []
    if marker:
        if marker.get("digitalSourceType"):
            attrs.append(f'Iptc4xmpExt:DigitalSourceType="{e(marker["digitalSourceType"])}"')
        if marker.get("tool"):
            attrs.append(f'xmp:CreatorTool="{e(marker["tool"])}"')
        if marker.get("generator"):
            attrs.append(f'aiplay:Generator="{e(marker["generator"])}"')
        if marker.get("disclosure"):
            inner.append(
                "<dc:description><rdf:Alt>"
                f'<rdf:li xml:lang="x-default">{e(marker["disclosure"])}</rdf:li>'
                "</rdf:Alt></dc:description>")
    if record:
        inner.append(f"<aiplay:Provenance>{e(json.dumps(record, separators=(',', ':')))}"
                     "</aiplay:Provenance>")
        if record.get("chainHead"):
            attrs.append(f'aiplay:ProvenanceChain="{e(record["chainHead"])}"')
    body = (
        '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="AIPLAY Studio">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"\n'
        '    xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
        '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
        '    xmlns:aiplay="http://aiplay.live/ns/provenance/1.0/"\n'
        "    " + "\n    ".join(attrs) + (">\n" if inner else ">\n")
        + ("".join(f"   {t}\n" for t in inner))
        + "  </rdf:Description>\n"
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
        '<?xpacket end="w"?>'
    )
    return body.encode("utf-8")


def _xmp_into_png(data, xmp):
    """Insert an iTXt XMP chunk right after IHDR. Works on any PNG - Pillow's
    and OpenCV's 16-bit alike - because it is pure chunk arithmetic."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    # iTXt: keyword NUL compressed(0) method(0) lang NUL translated NUL text
    payload = _XMP_KEYWORD + b"\x00\x00\x00\x00\x00" + xmp
    chunk = (struct.pack(">I", len(payload)) + b"iTXt" + payload
             + struct.pack(">I", zlib.crc32(b"iTXt" + payload) & 0xFFFFFFFF))
    # After the IHDR chunk: 8 (signature) + 4 (len) + 4 (type) + 13 + 4 (crc)
    ihdr_end = 8 + 4 + 4 + struct.unpack(">I", data[8:12])[0] + 4
    return data[:ihdr_end] + chunk + data[ihdr_end:]


def _xmp_into_jpeg(data, xmp):
    """Insert the standard XMP APP1 segment right after SOI (and after any
    EXIF APP1 already there, so `metadata: "preserve"` keeps both)."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    seg_payload = _XMP_JPEG_HEADER + xmp
    if len(seg_payload) + 2 > 0xFFFF:
        # A single APP1 caps at 64 KB. The marker alone is well under; a record
        # that big is truncated at the source, not split here.
        raise ValueError("XMP packet too large for one APP1 segment")
    seg = b"\xff\xe1" + struct.pack(">H", len(seg_payload) + 2) + seg_payload
    at = 2
    # Skip past any APP0/APP1 segments already present (JFIF header, EXIF).
    while at + 4 <= len(data) and data[at] == 0xFF and data[at + 1] in (0xE0, 0xE1):
        at += 2 + struct.unpack(">H", data[at + 2:at + 4])[0]
    return data[:at] + seg + data[at:]


_XMP_INJECTORS = {"png": _xmp_into_png, "jpeg": _xmp_into_jpeg}


def apply_provenance(data, meta, provenance, out_path=None):
    """(data, meta) with the provenance layer applied.

    marker: always embedded/sidecarred when supplied, in every metadata mode.
    record: only when supplied AND the metadata mode is not "none".
    """
    meta = dict(meta)
    if not provenance or not (provenance.get("marker") or provenance.get("record")):
        meta.setdefault("provenance", None)
        return data, meta
    marker = provenance.get("marker") or None
    record = provenance.get("record") if meta.get("metadata") != "none" else None
    fmt = meta.get("format")
    inject = _XMP_INJECTORS.get(fmt)
    if inject is not None:
        try:
            data = inject(data, build_xmp(marker, record))
            meta["provenance"] = "xmp"
            meta["bytes"] = len(data)
            return data, meta
        except Exception as exc:                            # noqa: BLE001
            meta["provenanceNote"] = f"embed failed, sidecar written instead: {exc}"
    if out_path:
        side = out_path + ".provenance.json"
        with open(side, "w", encoding="utf-8") as f:
            json.dump({"marker": marker, "record": record}, f, indent=2)
        meta["provenance"] = "sidecar"
        meta["provenanceSidecar"] = side
    else:
        meta["provenance"] = None
        meta["provenanceNote"] = (meta.get("provenanceNote") or
                                  f"{fmt} has no XMP injector here and no out path for a sidecar")
    return data, meta


# ---------------------------------------------------------------------------
# writing
# ---------------------------------------------------------------------------

def _write(out_path, data):
    d = os.path.dirname(os.path.abspath(out_path))
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(data)


def export(rgba, out_path, opts, exif=None, provenance=None):
    """Encode and write. The dict that comes back is what the UI and MCP show:
    the real byte count, the real dimensions, the matte if one was used, and
    everything that was clamped or ignored on the way. `provenance` is the
    two-tier payload from the ledger ({marker, record}); see apply_provenance
    for the rules - the marker is never dropped by any option here."""
    data, meta = encode(rgba, opts, exif=exif)
    data, meta = apply_provenance(data, meta, provenance, out_path=out_path)
    _write(out_path, data)
    meta.update({"ok": True, "out": out_path})
    return meta


# ---------------------------------------------------------------------------
# estimating, without writing anything
# ---------------------------------------------------------------------------

def _mosaic(rgba, budget=SAMPLE_PIXEL_BUDGET, grid=SAMPLE_GRID):
    """(sample, area_ratio) - a lattice of NATIVE-RESOLUTION tiles from across
    the frame, packed into one small image.

    The obvious estimator - shrink the picture, encode that, scale the bytes by
    the pixel ratio - is badly wrong, because shrinking destroys exactly the
    high-frequency detail the bitrate is spent on. Measured over nine real
    renders it ran 20-40% low for WebP and AVIF. Tiles at native resolution
    keep the per-pixel bitrate and only sample less area, and the same
    measurement puts them inside 18%."""
    h, w = rgba.shape[:2]
    total = h * w
    if total <= budget:
        return rgba, 1.0
    t = max(8, int(math.sqrt(budget / float(grid * grid))))
    tw = max(1, min(t, w // grid or w))
    th = max(1, min(t, h // grid or h))
    out = np.empty((th * grid, tw * grid, 4), np.float32)
    for j in range(grid):
        y = int((h - th) * (j / (grid - 1.0))) if grid > 1 else 0
        for i in range(grid):
            x = int((w - tw) * (i / (grid - 1.0))) if grid > 1 else 0
            out[j * th:(j + 1) * th, i * tw:(i + 1) * tw] = rgba[y:y + th, x:x + tw]
    return out, total / float(out.shape[0] * out.shape[1])


def estimate_size(rgba, opts, mode="auto", exif=None):
    """How big the file would be, without creating one. For a live size readout
    next to a quality slider.

    Two modes and the result always says which ran.

      * `exact` encodes the whole image into memory. It is the real number -
        error zero, not "within a few percent" - and it is the default under
        EXACT_PIXEL_BUDGET output pixels.
      * `sample` encodes a lattice of native-resolution tiles and scales by
        area. SAMPLE_TOLERANCE says how wrong it is allowed to be and the test
        prints how wrong it actually was.

    ICO and PDF are always exact: an ICO is bounded at 256px by the format and
    a sampled PDF page would be an estimate of a different document."""
    rgba = as_rgba(rgba)
    fmt, o, _ = resolve(opts)
    h, w = rgba.shape[:2]
    tw, th = _target_dims(w, h, o)
    out_px = tw * th

    if mode not in ("auto", "exact", "sample"):
        raise ValueError(f"mode is auto|exact|sample, got {mode!r}")
    if mode == "auto":
        mode = "exact" if (out_px <= EXACT_PIXEL_BUDGET or fmt in ("ico", "pdf")) \
            else "sample"
    elif mode == "sample" and fmt in ("ico", "pdf"):
        mode = "exact"

    if mode == "exact":
        data, meta = encode(rgba, opts, exif=exif)
        return {"ok": True, "bytes": len(data), "exact": True, "method": "exact",
                "tolerance": 0.0, "format": fmt, "width": meta.get("width", tw),
                "height": meta.get("height", th)}

    # Sample the OUTPUT pixels, so a resize that shrinks 12MP to 1024 is
    # estimated on the 1024 and not on what it came from.
    work = resize_rgba(rgba, tw, th, o["resample"]) if (tw, th) != (w, h) else rgba
    tile, ratio = _mosaic(work)
    sub = dict(opts or {})
    sub["resizeMode"] = "none"          # already at output scale
    data, _ = encode(tile, sub, exif=exif)
    return {"ok": True, "bytes": int(round(len(data) * ratio)), "exact": False,
            "method": "sample", "tolerance": SAMPLE_TOLERANCE, "format": fmt,
            "width": tw, "height": th, "sampledPixels": int(tile.shape[0] * tile.shape[1]),
            "areaRatio": ratio}


# ---------------------------------------------------------------------------
# size targeting
# ---------------------------------------------------------------------------

# What each format has to trade for size. PNG has no quality dial at all, so its
# lever is the palette - which is honest about being a different kind of loss.
_LEVER = {
    "jpeg": ("quality", 1, 100, {}),
    "webp": ("quality", 1, 100, {"lossless": False}),
    "avif": ("quality", 1, 100, {}),
    "tiff": ("quality", 1, 100, {"compression": "jpeg"}),
    "png": ("paletteColors", 2, 256, {"palette": True}),
}


def target_size(rgba, max_bytes, opts, out_path=None, allow_miss=False, exif=None,
                provenance=None):
    """Search the quality dial for the largest setting that fits under
    `max_bytes` - "get this under 500 KB".

    Binary search, then a VERIFICATION encode at the answer, because size is
    only mostly monotonic in quality and a search that assumes it is strictly
    monotonic will occasionally hand back a setting that misses by a few
    hundred bytes. If the verification misses, it steps down until it does not.

    When even the minimum setting is too big it says so - `ok` false, `met`
    false, the smallest size reachable, and no file - rather than writing
    something that misses the target and calling it done. `allow_miss=True`
    writes the best effort anyway, and still reports met:false."""
    rgba = as_rgba(rgba)
    fmt, _o, _ = resolve(opts)
    max_bytes = int(max_bytes)
    if max_bytes < 1:
        raise ValueError(f"a target of {max_bytes} bytes is not a target")
    if fmt not in _LEVER:
        why = ("an ICO is a fixed set of sizes" if fmt == "ico"
               else "a PDF page embeds the image as it is")
        raise ValueError(f"{CATALOG[fmt]['label']} has no quality dial to search - "
                         f"{why}. Resize it, or export a format that has one: "
                         f"{sorted(_LEVER)}")

    key, lo, hi, forced = _LEVER[fmt]
    # The XMP packet is part of the file, so it is part of the target: reserve
    # its size up front and search under the remainder, rather than injecting
    # after the search and quietly missing by a kilobyte.
    reserve = 0
    if provenance and (provenance.get("marker") or provenance.get("record")) \
            and fmt in _XMP_INJECTORS:
        record = provenance.get("record") if str((opts or {}).get("metadata", "strip")) != "none" else None
        reserve = len(build_xmp(provenance.get("marker"), record)) + 96
        if reserve >= max_bytes:
            raise ValueError(f"the {max_bytes}-byte target is smaller than the "
                             f"provenance metadata itself ({reserve} bytes)")
    budget = max_bytes - reserve
    base = dict(opts or {})
    for k, v in forced.items():
        if base.get(k) not in (None, v):
            raise ValueError(f"searching {fmt} size needs {k}={v!r}; {k}={base[k]!r} "
                             f"was asked for")
        base[k] = v

    seen = {}

    def size_at(v):
        if v not in seen:
            probe = dict(base)
            probe[key] = v
            seen[v] = len(encode(rgba, probe, exif=exif)[0])
        return seen[v]

    best = None
    a, b = lo, hi
    while a <= b:
        mid = (a + b) // 2
        if size_at(mid) <= budget:
            best, a = mid, mid + 1
        else:
            b = mid - 1

    # Verify, then walk down if the non-monotonic bit bit us.
    while best is not None and size_at(best) > budget:
        best = best - 1 if best > lo else None

    if best is None:
        floor_opts = dict(base)
        floor_opts[key] = lo
        floor_data, floor_meta = encode(rgba, floor_opts, exif=exif)
        floor_data, floor_meta = apply_provenance(floor_data, floor_meta, provenance,
                                                  out_path=out_path if allow_miss else None)
        res = {"ok": False, "met": False, "format": fmt, "target": max_bytes,
               "lever": key, key: lo, "bytes": len(floor_data), "probes": len(seen),
               "width": floor_meta.get("width"), "height": floor_meta.get("height"),
               "provenance": floor_meta.get("provenance"),
               "error": f"{CATALOG[fmt]['label']} at {key}={lo} is still "
                        f"{len(floor_data)} bytes, {len(floor_data) - max_bytes} over "
                        f"the {max_bytes}-byte target - the picture is too big for "
                        f"this format at any quality. Resize it down, or pick a "
                        f"denser format.",
               "out": None}
        # Default is to write NOTHING: handing back a file that misses the target
        # is how a size limit turns into a silent upload failure downstream.
        if allow_miss and out_path:
            _write(out_path, floor_data)
            res["out"] = out_path
        return res

    final = dict(base)
    final[key] = best
    data, meta = encode(rgba, final, exif=exif)
    data, meta = apply_provenance(data, meta, provenance, out_path=out_path)
    meta.update({"ok": True, "met": len(data) <= max_bytes, "target": max_bytes,
                 "lever": key, key: best, "probes": len(seen), "out": None,
                 "bytes": len(data)})
    if out_path:
        _write(out_path, data)
        meta["out"] = out_path
    return meta


# ---------------------------------------------------------------------------
# what MCP and the UI are served
# ---------------------------------------------------------------------------

def catalog():
    return {
        "formats": CATALOG,
        "common": COMMON,
        "groups": GROUP_ORDER,
        "names": sorted(k for k, v in CATALOG.items() if v.get("available")),
        "unavailable": {k: v.get("unavailableWhy")
                        for k, v in CATALOG.items() if not v.get("available")},
        "aliases": ALIASES,
        "resample": ["auto"] + sorted(RESAMPLE),
        "notes": {
            "input": "float32 (H, W, 4), 0..1, straight (un-premultiplied) alpha",
            "common": "every key in `common` applies to every format; `formats[f]"
                      ".params` is what only that format reads",
            "types": "number|bool|enum|color|multiselect. color is 0-255 RGB. "
                     "multiselect is a subset of `options`",
            "unknownKeys": "an option that is in no catalog is an error; one that "
                           "belongs to another format comes back in `ignored`; a "
                           "number outside its range comes back in `clamped`",
            "metadata": "EXIF is STRIPPED by default and must be passed in to be "
                        "preserved. The provenance XMP (AI marker + record) is "
                        "written under 'strip' and 'preserve'; 'none' drops the "
                        "record while the AI marker is still written - no option "
                        "here removes it",
            "estimate": f"exact under {EXACT_PIXEL_BUDGET} output pixels, otherwise "
                        f"sampled to within {int(SAMPLE_TOLERANCE * 100)}%",
        },
    }


# ---------------------------------------------------------------------------
# CLI - the seam server/index.js and server/mcp.js call, the same shape
# imagetools.py uses. One JSON line out, exit 1 on failure.
# ---------------------------------------------------------------------------

def _job_input(job):
    """(rgba, exif) from a job. `in` is a path; `pixels` is base64 raw RGBA with
    `width`/`height` for a caller that already has the array in hand."""
    if job.get("in"):
        return load_source(job["in"])
    if job.get("pixels"):
        w, h = int(job["width"]), int(job["height"])
        raw = np.frombuffer(base64.b64decode(job["pixels"]), np.uint8)
        return raw.reshape(h, w, 4).astype(np.float32) / 255.0, None
    raise ValueError("job needs 'in' (a path) or 'pixels' + 'width' + 'height'")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    try:
        if mode == "catalog":
            print(json.dumps(catalog()))
            return
        job = json.loads(open(sys.argv[2], encoding="utf-8").read())
        rgba, exif = _job_input(job)
        opts = job.get("export") or job.get("ops") or {}
        provenance = job.get("provenance") or None
        if mode == "export":
            print(json.dumps(export(rgba, job["out"], opts, exif=exif,
                                    provenance=provenance)))
        elif mode == "estimate":
            print(json.dumps(estimate_size(rgba, opts, job.get("mode", "auto"),
                                           exif=exif)))
        elif mode == "target":
            res = target_size(rgba, job["maxBytes"], opts, out_path=job.get("out"),
                              allow_miss=bool(job.get("allowMiss")), exif=exif,
                              provenance=provenance)
            print(json.dumps(res))
            if not res.get("ok"):
                sys.exit(1)
        else:
            print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
            sys.exit(1)
    except Exception as exc:                                # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
