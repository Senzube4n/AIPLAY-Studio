"""Unit tests for the exporter in server/imgexport.py.

Export is a part of an image editor where almost nothing needs an eyeball,
because every claim it makes is countable. "Lossless" means the array that
comes back equals the array that went in, element for element. "256 colours"
means you can count the distinct colours and get 256 or fewer. "Under 500 KB"
means os.path.getsize. "Contains 16, 32, 48 and 256" means you parse the icon
directory and look. So nothing below is a golden image; everything is
arithmetic against the file that was actually written, and against PIL's and
OpenCV's own readers rather than against what this module believes it wrote.

Three kinds of test, the split shapes_test.py and effects_test.py use.

  * SWEEPS over the CATALOG: every format encodes, every parameter is
    described, every default sits inside its own advertised range - and every
    parameter is one `resolve()` actually reads, because a catalogued knob the
    code ignores is the failure IMAGE_SPEC section 9 puts third.
  * ONE MEANINGFUL ASSERTION PER FEATURE - not "it ran" but "a white cutout
    flattened onto white has zero variance", "the same picture at JPEG 30 is
    smaller than at JPEG 95 and both reopen", "a 64px source asked for a 256px
    icon gets one".
  * THE SEAM: the CLI is driven as a subprocess, because server/index.js and
    server/mcp.js call this file, not these functions, and a module nobody
    calls is the failure section 9 puts first.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgexport_test.py

Files go to a fresh temp directory and it is removed on the way out, pass or
fail. numpy / cv2 / PIL.
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import traceback

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imgexport as ix                                      # noqa: E402

PASS = FAIL = 0
TMP = tempfile.mkdtemp(prefix="imgexport_test_")
NOTES = []


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    eq(name, abs(float(got) - float(want)) <= tol, True)


def note(line):
    NOTES.append(line)
    print(f"  ..    {line}")


def out(name):
    return os.path.join(TMP, name)


_MARK = [time.perf_counter()]


def section(title):
    """Prints the previous section's wall time. This suite writes and reads a
    few hundred real image files and it runs in the pre-commit hook next to
    suites that take a second, so where the time goes is worth seeing."""
    now = time.perf_counter()
    if len(_MARK) > 1:
        print(f"        ({now - _MARK[-1]:.1f}s)")
    _MARK.append(now)
    print("")
    print("  -- " + title + " --")


def u8(rgba):
    return np.clip(np.asarray(rgba) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def read_rgba(path):
    """Whatever is on disk, as float32 RGBA - through PIL, i.e. through
    somebody else's reader."""
    return ix.as_rgba(path)


# ---------------------------------------------------------------------------
# material
# ---------------------------------------------------------------------------

_PHOTOS = {}


def photo(w=512, h=512, seed=1, grain=0.015):
    """Photograph-shaped: several octaves of smooth noise, a gradient and a
    little grain. Continuous tone with no flat areas, which is the content
    lossy codecs are tuned for and palettes are worst at.

    `grain` matters more than it looks. Per-pixel noise is the single hardest
    thing for a transform codec - it is exactly the high-frequency energy
    quantisation throws away - and it moves the max channel error of a JPEG 95
    from 5/255 to 20/255 all by itself. A round-trip bound measured on grainy
    content is therefore loose enough to hide a genuinely broken encoder, so the
    tight assertions below run on grain=0."""
    key = (w, h, seed, grain)
    if key in _PHOTOS:
        return _PHOTOS[key]          # nothing in this suite mutates one
    r = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.zeros((h, w, 3), np.float32)
    for oc, amp in ((4, .5), (8, .25), (16, .15), (32, .08), (64, .05)):
        n = (r.random((oc, oc, 3)) * 255).astype(np.uint8)
        img += amp * np.asarray(Image.fromarray(n).resize((w, h), Image.BICUBIC),
                                np.float32) / 255.0
    img += 0.15 * np.stack([xx / w, yy / h, (xx + yy) / (w + h)], -1)
    img += r.normal(0, grain, img.shape).astype(np.float32)
    img = np.clip(img / max(img.max(), 1e-6), 0, 1)
    _PHOTOS[key] = np.dstack([img, np.ones((h, w), np.float32)]).astype(np.float32)
    return _PHOTOS[key]


def flat(w=128, h=128, n=6, seed=2):
    """Flat art: n solid bands. What a palette PNG is FOR."""
    r = np.random.default_rng(seed)
    cols = r.integers(0, 256, (n, 3)).astype(np.float32) / 255.0
    img = np.zeros((h, w, 4), np.float32)
    img[..., 3] = 1.0
    for i in range(n):
        img[:, i * w // n:(i + 1) * w // n, :3] = cols[i]
    return img


def cutout(w=128, h=128, rgb=(1.0, 1.0, 1.0), zero_outside=False):
    """A cutout with a SOFT edge: constant RGB, alpha a smooth radial ramp.

    This is the shape of every subject lifted off a background, and the reason
    straight alpha matters. Its colour is `rgb` at every pixel INCLUDING the
    half-transparent ones - that is what straight alpha means - so flattening
    it onto a matte of the same colour must give back that colour flat, with no
    edge at all. Any premultiplied slip puts a ring there."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((xx - w / 2) ** 2 + (yy - h / 2) ** 2) / (min(w, h) / 2.0)
    a = np.clip(1.4 - d * 1.4, 0.0, 1.0).astype(np.float32)
    img = np.zeros((h, w, 4), np.float32)
    img[..., :3] = np.asarray(rgb, np.float32)
    img[..., 3] = a
    if zero_outside:
        # What a cutout tool actually hands you: RGB cleared wherever nothing
        # was kept. Still perfectly valid straight alpha - the colour of a
        # zero-coverage pixel is undefined and zero is as good as anything -
        # and the reason dropping the alpha channel produces a black halo.
        img[..., :3][a <= 0.0] = 0.0
    return img


def maxdiff(a, b):
    return int(np.abs(u8(a).astype(int) - u8(b).astype(int)).max())


def meandiff(a, b):
    return float(np.abs(u8(a).astype(int) - u8(b).astype(int)).mean())


def uniq_colors(path, alpha=False):
    """Distinct colours in the written file, counted through PIL."""
    im = Image.open(path)
    arr = np.asarray(im.convert("RGBA" if alpha else "RGB"))
    return len(np.unique(arr.reshape(-1, arr.shape[-1]), axis=0))


def png_ihdr(path):
    with open(path, "rb") as f:
        v = f.read(33)
    assert v[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    w, h, bits, ctype = struct.unpack(">IIBB", v[16:26])
    return {"width": w, "height": h, "bitDepth": bits, "colorType": ctype}


def png_palette_entries(path):
    """How many colours are really in the PLTE chunk. The point of a palette is
    the bit depth it buys, and the depth follows the palette that was WRITTEN,
    not the one that was asked for - an image with six colours quantised to 256
    still only needs four bits."""
    with open(path, "rb") as f:
        v = f.read()
    i = 8
    while i + 8 <= len(v):
        ln = struct.unpack(">I", v[i:i + 4])[0]
        if v[i + 4:i + 8] == b"PLTE":
            return ln // 3
        i += 12 + ln
    return 0


PHOTO = photo()
FLAT = flat()
CUT = cutout()
# Built once each, because both get reused and a 1024x1024 photograph costs a
# fifth of a second to synthesise - nothing, until it is inside a loop over
# seven formats.
#   BIG  a real photograph, big enough that sampling has something to sample
#        (1 MP against a 512x512 sample budget) - the accuracy measurement.
#   OVER past EXACT_PIXEL_BUDGET, which is the only thing the "did auto switch
#        to sampling" cases care about. Deliberately flat and instant to build:
#        the assertion is a mode string, not a byte count.
BIG = photo(1024, 1024, 21)
OVER = np.zeros((1500, 1500, 4), np.float32)
OVER[..., 3] = 1.0
OVER[..., :3] = (np.mgrid[0:1500, 0:1500][1] / 1499.0)[..., None]


try:
    print("\nimgexport\n")
    print(f"  Pillow {Image.__version__}, OpenCV {cv2.__version__}")
    section("the catalog contract")

    bad = [k for k, e in ix.CATALOG.items()
           if not (e.get("label") and e.get("why") and e.get("ext") and e.get("mime")
                   and e.get("pil") and e.get("group") in ix.GROUP_ORDER)]
    eq("every format has a label, a group, a why, an extension and a mime type", bad, [])

    bad = []
    for src, where in ((ix.COMMON, "common"),
                       *[(e["params"], k) for k, e in ix.CATALOG.items()]):
        for pk, p in src.items():
            if "desc" not in p or "type" not in p or "default" not in p:
                bad.append(f"{where}.{pk}")
            elif p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
                bad.append(f"{where}.{pk}")
            elif p["type"] == "enum" and p["default"] not in p["options"]:
                bad.append(f"{where}.{pk}")
            elif p["type"] == "multiselect" and not set(p["default"]) <= set(p["options"]):
                bad.append(f"{where}.{pk}")
            elif p["type"] == "color" and not (len(p["default"]) == 3
                                               and all(0 <= c <= 255 for c in p["default"])):
                bad.append(f"{where}.{pk}")
    eq("every parameter is described and defaults inside its own range", bad, [])

    eq("the aliases all point at a real format",
       sorted(set(ix.ALIASES.values()) - set(ix.CATALOG)), [])
    cat = ix.catalog()
    eq("catalog() serves every available format",
       sorted(cat["names"]), sorted(k for k, v in ix.CATALOG.items() if v["available"]))
    eq("...and names the ones it cannot serve rather than hiding them",
       sorted(set(cat["names"]) | set(cat["unavailable"])), sorted(ix.CATALOG))

    # IMAGE_SPEC section 9, third item: a schema that accepts a parameter the code
    # then ignores. Every catalogued key must come back out of resolve() with a
    # value, for the format that advertises it.
    unread = []
    for fmt, e in ix.CATALOG.items():
        if not e["available"]:
            continue
        _f, values, _r = ix.resolve({"format": fmt})
        for pk in list(e["params"]) + list(ix.COMMON):
            if pk not in values:
                unread.append(f"{fmt}.{pk}")
    eq("every catalogued parameter is one resolve() actually reads", unread, [])

    # ...and the other half of that: a format's own knob is never reported ignored.
    leaked = []
    for fmt, e in ix.CATALOG.items():
        if not e["available"]:
            continue
        opts = {"format": fmt}
        for pk, p in e["params"].items():
            opts[pk] = list(p["default"]) if isinstance(p["default"], list) else p["default"]
        _f, _v, rep = ix.resolve(opts)
        if rep["ignored"]:
            leaked.append(f"{fmt}:{rep['ignored']}")
    eq("a format's own parameters are never reported as ignored", leaked, [])

    eq("a parameter belonging to another format IS reported, not dropped in silence",
       ix.resolve({"format": "png", "quality": 50})[2]["ignored"], ["quality"])

    # The subtler half: a knob that belongs to this format but does nothing
    # given the OTHER knobs. WebP quality under lossless, TIFF quality under a
    # lossless compression, paletteColors with no palette. All three encode
    # perfectly and all three read as "my setting was applied".
    for what, opts, key in (
            ("WebP quality under lossless",
             {"format": "webp", "lossless": True, "quality": 40}, "quality"),
            ("TIFF quality under a lossless compression",
             {"format": "tiff", "compression": "tiff_deflate", "quality": 40},
             "quality"),
            ("paletteColors with no palette",
             {"format": "png", "paletteColors": 16}, "paletteColors")):
        m = ix.encode(FLAT, opts)[1]
        eq(f"{what} is reported as unused, with a reason",
           (key in m["ignored"], bool(m.get("unusedNotes", {}).get(key))), (True, True))
    eq("...and a DEFAULT sitting unused is not reported - nobody asked for it",
       ix.encode(FLAT, {"format": "tiff"})[1]["ignored"], [])

    section("what this Pillow can and cannot do")
    for name in sorted(ix.CATALOG):
        e = ix.CATALOG[name]
        note(f"{e['label']:5s} available={e['available']}"
             + ("" if e["available"] else f"  ({e.get('unavailableWhy')})"))
    eq("AVIF is offered only if it really encodes",
       ix.CATALOG["avif"]["available"], "AVIF" in Image.SAVE)
    eq("no format advertises an AVIF-style lossless it cannot deliver",
       [k for k, e in ix.CATALOG.items() if "lossless" in e["params"]], ["webp"])

    section("the input contract: float32 (H,W,4) 0..1 straight alpha")
    src = Image.fromarray(u8(PHOTO), "RGBA")
    p0 = out("in.png")
    src.save(p0)
    for what, got in (("an ndarray", ix.as_rgba(PHOTO)),
                      ("a uint8 array", ix.as_rgba(u8(PHOTO))),
                      ("a PIL image", ix.as_rgba(src)),
                      ("a path", ix.as_rgba(p0))):
        eq(f"as_rgba({what}) is float32 (H,W,4) in 0..1",
           (got.dtype, got.shape[2], got.ndim, float(got.min()) >= 0.0,
            float(got.max()) <= 1.0), (np.float32, 4, 3, True, True))
    eq("as_rgba fills alpha in for an RGB array",
       float(ix.as_rgba(PHOTO[..., :3])[..., 3].min()), 1.0)
    eq("as_rgba widens a greyscale plane to RGBA",
       ix.as_rgba(np.zeros((4, 5), np.float32)).shape, (4, 5, 4))

    section("every format round-trips")

    # Lossless formats: EXACT, element for element, read back by PIL.
    p = out("rt.png")
    ix.export(PHOTO, p, {"format": "png"})
    eq("PNG 8-bit round-trips exactly", maxdiff(read_rgba(p), PHOTO), 0)

    p = out("rt_rgba.png")
    ix.export(CUT, p, {"format": "png"})
    eq("...alpha channel included", maxdiff(read_rgba(p), CUT), 0)

    for comp in ("none", "tiff_lzw", "tiff_deflate", "packbits"):
        p = out(f"rt_{comp}.tiff")
        ix.export(CUT, p, {"format": "tiff", "compression": comp})
        eq(f"TIFF {comp} round-trips exactly", maxdiff(read_rgba(p), CUT), 0)

    # WebP lossless is the one that needs `exact=True` underneath: libwebp
    # otherwise rewrites the RGB of fully transparent pixels, which no viewer
    # shows and which breaks a straight-alpha round trip by up to 252/255.
    p = out("rt_lossless.webp")
    ix.export(CUT, p, {"format": "webp", "lossless": True})
    back = read_rgba(p)
    eq("WebP lossless round-trips exactly", maxdiff(back, CUT), 0)
    clear = CUT[..., 3] == 0.0
    eq("...including the RGB hiding under fully transparent pixels",
       int(np.abs(u8(back)[..., :3][clear].astype(int)
                  - u8(CUT)[..., :3][clear].astype(int)).max()) if clear.any() else 0, 0)

    p = out("rt16.png")
    ix.export(PHOTO, p, {"format": "png", "bitDepth": 16})
    eq("16-bit PNG really is 16-bit in the IHDR", png_ihdr(p)["bitDepth"], 16)
    # PHOTO is opaque, so this file is 16-bit RGB and OpenCV reads back three
    # channels. Read back through OpenCV rather than PIL because PIL downsamples
    # a 16-bit PNG to 8 on the way in, which would make "exact" mean nothing.
    raw16 = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_UNCHANGED)
    want16 = np.clip(PHOTO * 65535.0 + 0.5, 0, 65535).astype(np.uint16)[..., [2, 1, 0]]
    eq("...and round-trips exactly at 16 bits, which 8-bit PNG cannot",
       (raw16.shape, int(np.abs(raw16.astype(int) - want16.astype(int)).max())),
       (want16.shape, 0))
    p = out("rt16a.png")
    ix.export(CUT, p, {"format": "png", "bitDepth": 16})
    rawa = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_UNCHANGED)
    wanta = np.clip(CUT * 65535.0 + 0.5, 0, 65535).astype(np.uint16)[..., [2, 1, 0, 3]]
    eq("...and a 16-bit cutout keeps its alpha, exactly too",
       (rawa.shape, int(np.abs(rawa.astype(int) - wanta.astype(int)).max())),
       (wanta.shape, 0))
    # Asserted against Pillow rather than remembered: the reason this one
    # path leaves PIL is that PIL refuses, and if that ever stops being true
    # this test says so instead of quietly keeping a detour nobody needs.
    try:
        Image.fromarray(want16[..., :3]).save(out("pillow16.png"))
        pillow_can_16 = True
    except Exception:                                       # noqa: BLE001
        pillow_can_16 = False
    eq("...which Pillow itself cannot write - the reason that path uses OpenCV",
       pillow_can_16, False)

    # An opaque image carries no alpha plane in EITHER depth. Colour type 2 is
    # truecolour, 6 is truecolour-with-alpha, and at 16 bits a dead channel
    # costs two bytes a pixel.
    p16o, p16a = out("op16.png"), out("cut16.png")
    ix.export(PHOTO, p16o, {"format": "png", "bitDepth": 16})
    ix.export(CUT, p16a, {"format": "png", "bitDepth": 16})
    eq("an opaque 16-bit PNG is RGB, and a cutout keeps its alpha",
       (png_ihdr(p16o)["colorType"], png_ihdr(p16a)["colorType"]), (2, 6))
    p8o, p8a = out("op8.png"), out("cut8.png")
    ro = ix.export(PHOTO, p8o, {"format": "png"})
    ra = ix.export(CUT, p8a, {"format": "png"})
    eq("...and the same at 8 bits, reported rather than done quietly",
       (png_ihdr(p8o)["colorType"], ro.get("alphaDropped"),
        png_ihdr(p8a)["colorType"], ra.get("alphaDropped")),
       (2, True, 6, None))

    # A lanczos resample of an opaque image leaves alpha at 0.9999995, which is
    # not 1.0 - so an exact test would keep a dead alpha channel on every
    # resized export. The threshold is "does it round to 255", not "is it 1.0".
    grown = ix.resize_rgba(PHOTO, 600, 600, "lanczos")
    note(f"alpha after a lanczos upscale of an opaque image: "
         f"{float(grown[..., 3].min()):.7f}")
    eq("...and float error from a resample does not resurrect the alpha channel",
       (float(grown[..., 3].min()) < 1.0,
        ix.encode(grown, {"format": "png"})[1].get("alphaDropped")), (True, True))

    # Lossy formats: a STATED bound, measured over five seeds each rather than
    # guessed, on GRAIN-FREE content - where max error runs 4-7/255 and a bound
    # of 8 is tight enough to catch a broken encoder or a colour-space slip.
    # The same bound on grainy content would have to be 24, which catches
    # nothing. Both numbers are printed.
    SMOOTH = photo(512, 512, 1, grain=0.0)
    for fmt, kw in (("jpeg", {"quality": 95, "chroma": "4:4:4"}),
                    ("webp", {"quality": 95}),
                    ("avif", {"quality": 90, "chroma": "4:4:4"})):
        if not ix.CATALOG[fmt]["available"]:
            continue
        p = out(f"rt_smooth.{fmt}")
        ix.export(SMOOTH, p, {"format": fmt, **kw})
        d, m = maxdiff(read_rgba(p), SMOOTH), meandiff(read_rgba(p), SMOOTH)
        pg = out(f"rt_grain.{fmt}")
        ix.export(PHOTO, pg, {"format": fmt, **kw})
        dg = maxdiff(read_rgba(pg), PHOTO)
        note(f"{fmt} {kw}: max channel error {d}/255 smooth, {dg}/255 with grain; "
             f"mean {m:.2f}")
        eq(f"{fmt} at high quality is inside its stated bound on smooth content "
           f"(max<=8, mean<=1.0)", (d <= 8, m <= 1.0), (True, True))
        eq(f"...and inside the looser grain bound (max<=24)", dg <= 24, True)

    section("JPEG quality is a real dial")
    lo, hi = out("q30.jpg"), out("q95.jpg")
    r30 = ix.export(PHOTO, lo, {"format": "jpeg", "quality": 30})
    r95 = ix.export(PHOTO, hi, {"format": "jpeg", "quality": 95})
    s30, s95 = os.path.getsize(lo), os.path.getsize(hi)
    note(f"same 512x512 photograph: q30 {s30} bytes, q95 {s95} bytes "
         f"({s95 / s30:.1f}x)")
    eq("quality 30 is measurably smaller than quality 95", s30 < s95, True)
    eq("...and the reported byte count is the file's real size",
       (r30["bytes"], r95["bytes"]), (s30, s95))
    ok = []
    for p in (lo, hi):
        with Image.open(p) as im:
            im.load()
            ok.append((im.format, im.size))
    eq("...and both are valid JPEGs when reopened", ok,
       [("JPEG", (512, 512))] * 2)
    ix.export(PHOTO, out("prog.jpg"),
              {"format": "jpeg", "quality": 90, "progressive": True})
    ix.export(PHOTO, out("base.jpg"), {"format": "jpeg", "quality": 90})
    eq("progressive is a real flag, and the file says so when reopened",
       (Image.open(out("prog.jpg")).info.get("progressive"),
        Image.open(out("base.jpg")).info.get("progressive")), (1, None))

    ix.export(PHOTO, out("c444.jpg"),
              {"format": "jpeg", "quality": 90, "chroma": "4:4:4"})
    ix.export(PHOTO, out("c420.jpg"),
              {"format": "jpeg", "quality": 90, "chroma": "4:2:0"})
    a, b = os.path.getsize(out("c444.jpg")), os.path.getsize(out("c420.jpg"))
    note(f"chroma 4:4:4 {a} bytes vs 4:2:0 {b} bytes")
    eq("4:4:4 keeps more colour and costs more bytes than 4:2:0", a > b, True)

    section("the flatten trap")

    # Straight alpha: a white cutout is white AT EVERY PIXEL, including the
    # half-transparent rim. Flattened onto white it must come back flat white,
    # with no ring. Under premultiplied maths applied to straight pixels the rim
    # goes grey - so zero variance is the whole assertion.
    fl = ix.flatten(CUT, (255, 255, 255))
    eq("a white cutout flattened onto white is flat white",
       (float(fl.min()), float(fl.max())), (1.0, 1.0))

    # ...and the case really does discriminate: here is the wrong arithmetic,
    # on the same input, being wrong. Asserted rather than assumed, so this test
    # cannot pass by accident on an image where both formulas agree.
    a = CUT[..., 3:4]
    wrong = np.clip((CUT[..., :3] * a) * a + 1.0 * (1.0 - a), 0.0, 1.0)
    note(f"the same cutout under double-premultiplied compositing: "
         f"min {float(wrong.min()):.3f} (a grey rim), correct min "
         f"{float(fl.min()):.3f}")
    eq("...and the wrong (premultiplied) formula demonstrably darkens it",
       float(wrong.min()) < 0.8, True)

    p = out("cut.jpg")
    res = ix.export(CUT, p, {"format": "jpeg", "quality": 95, "chroma": "4:4:4",
                             "matte": [255, 255, 255]})
    back = read_rgba(p)
    note(f"white cutout -> JPEG on a white matte: min channel "
         f"{int(u8(back)[..., :3].min())}/255")
    eq("exporting a cutout to JPEG on a white matte gives a LIGHT image",
       int(u8(back)[..., :3].min()) >= 245, True)
    eq("...and the matte that was used is reported, not left to be guessed",
       res["matte"], [255, 255, 255])

    # The black halo itself. ZEROED is the shape a cutout tool really emits:
    # white subject, soft rim, RGB cleared where nothing was kept. Dropping the
    # alpha channel then leaves black behind - and this is the case that has to
    # be constructed deliberately, because a cutout that kept white RGB in its
    # transparent region survives the naive path by luck and proves nothing.
    ZEROED = cutout(128, 128, zero_outside=True)
    naive = np.asarray(Image.fromarray(u8(ZEROED), "RGBA").convert("RGB"))
    p = out("zeroed.jpg")
    ix.export(ZEROED, p, {"format": "jpeg", "quality": 95, "chroma": "4:4:4"})
    ours = int(u8(read_rgba(p))[..., :3].min())
    note(f"a zeroed cutout through PIL's convert('RGB'): min channel "
         f"{int(naive.min())}/255 - the black halo. Through this exporter: "
         f"{ours}/255")
    eq("a cutout with a cleared background is BLACK if you just drop the alpha",
       int(naive.min()), 0)
    eq("...and this exporter flattens it to the matte instead", ours >= 245, True)
    eq("...with no rim: the rim pixels are white too, not a gradient to black",
       int(u8(ix.flatten(ZEROED, (255, 255, 255)) * 1.0).min()), 255)

    # A non-degenerate case where the arithmetic is checkable by hand:
    # 50% grey at 50% alpha on white is 0.5*0.5 + 1.0*0.5 = 0.75 -> 191.
    half = np.zeros((4, 4, 4), np.float32)
    half[..., :3] = 0.5
    half[..., 3] = 0.5
    near("50% grey at 50% alpha on white is 0.75, by hand",
         float(ix.flatten(half, (255, 255, 255)).mean()), 0.75, 1e-6)
    near("...and on black it is 0.25", float(ix.flatten(half, (0, 0, 0)).mean()),
         0.25, 1e-6)
    near("...and on mid-red the red channel is 0.5*0.5 + (128/255)*0.5",
         float(ix.flatten(half, (128, 0, 0))[..., 0].mean()),
         0.25 + (128 / 255.0) * 0.5, 1e-6)

    p = out("cut_black.jpg")
    ix.export(CUT, p, {"format": "jpeg", "quality": 95, "matte": [0, 0, 0]})
    eq("a black matte is available and is DARK - the default just isn't it",
       int(u8(read_rgba(p))[..., :3].min()) <= 10, True)
    eq("the default matte is white and says so in the catalog",
       ix.COMMON["matte"]["default"], [255, 255, 255])
    eq("a format that carries alpha reports no matte at all",
       ix.encode(CUT, {"format": "png"})[1]["matte"], None)

    section("palette quantisation")
    p = out("pal256.png")
    r = ix.export(PHOTO, p, {"format": "png", "palette": True, "paletteColors": 256})
    eq("a 256-colour PNG has at most 256 distinct colours", uniq_colors(p) <= 256, True)
    full = out("full.png")
    ix.export(PHOTO, full, {"format": "png"})
    note(f"512x512 photograph: truecolour PNG {os.path.getsize(full)} bytes, "
         f"256-colour {os.path.getsize(p)} bytes "
         f"({os.path.getsize(full) / os.path.getsize(p):.1f}x smaller)")
    eq("...and it is smaller than the truecolour one",
       os.path.getsize(p) < os.path.getsize(full), True)
    eq("truecolour PNG of the same photograph has far more than 256",
       uniq_colors(full) > 256, True)

    # The bit depth follows the palette that was WRITTEN. FLAT has six colours,
    # so asking for 200 of them still writes a 4-bit file - which is the right
    # answer and not the one a memorised table would have predicted. So the
    # assertion is the invariant: the depth is the smallest legal PNG depth that
    # can index the PLTE chunk actually in the file.
    SMALLPHOTO = photo(256, 256, 1)
    for src, name, n in ((FLAT, "flat art", 2), (FLAT, "flat art", 4),
                         (FLAT, "flat art", 16), (FLAT, "flat art", 256),
                         (SMALLPHOTO, "a photograph", 16),
                         (SMALLPHOTO, "a photograph", 200),
                         (SMALLPHOTO, "a photograph", 256)):
        p = out(f"pal_{name.split()[-1]}_{n}.png")
        ix.export(src, p, {"format": "png", "palette": True, "paletteColors": n})
        entries = png_palette_entries(p)
        want = next(d for d in (1, 2, 4, 8) if (1 << d) >= max(entries, 2))
        eq(f"{name} at {n} colours has at most {n} distinct colours",
           (uniq_colors(p) <= n, entries <= n), (True, True))
        eq(f"...and its {entries}-entry palette is written at {want} bit(s) per pixel",
           png_ihdr(p)["bitDepth"], want)
    eq("a photograph asked for 256 colours really does use all 256",
       png_palette_entries(out("pal_photograph_256.png")), 256)
    eq("...and flat art with six colours is not padded out to them",
       png_palette_entries(out("pal_art_256.png")) <= 16, True)

    p = out("pal_alpha.png")
    ix.export(CUT, p, {"format": "png", "palette": True, "paletteColors": 64})
    eq("a palette PNG with alpha keeps its transparency and its colour count",
       (uniq_colors(p, alpha=True) <= 64,
        float(read_rgba(p)[..., 3].min()) < 0.5), (True, True))
    m = ix.encode(CUT, {"format": "png", "palette": True, "paletteColors": 64,
                        "dither": True})[1]
    eq("...and dither, which Pillow cannot do on RGBA, is REPORTED as ignored",
       ("dither" in m["ignored"], bool(m.get("ditherNote"))), (True, True))

    grad = np.zeros((96, 96, 4), np.float32)
    grad[..., 3] = 1.0
    grad[..., :3] = (np.mgrid[0:96, 0:96][1] / 95.0)[..., None]
    d0 = out("nodither.png")
    d1 = out("dither.png")
    ix.export(grad, d0, {"format": "png", "palette": True, "paletteColors": 8})
    m1 = ix.export(grad, d1, {"format": "png", "palette": True, "paletteColors": 8,
                              "dither": True})
    note(f"an 8-colour gradient: undithered {os.path.getsize(d0)} bytes, "
         f"dithered {os.path.getsize(d1)} bytes")
    eq("dither on an opaque image is not a no-op",
       (os.path.getsize(d0) != os.path.getsize(d1), m1["dithered"]), (True, True))
    eq("...and still respects the colour count", uniq_colors(d1) <= 8, True)

    section("ICO is a container, and Pillow drops sizes in silence")
    p = out("icon.ico")
    r = ix.export(photo(64, 64, 9), p, {"format": "ico", "sizes": [16, 32, 48, 256]})
    with open(p, "rb") as f:
        blob = f.read()
    eq("a 64px source asked for 16/32/48/256 gets all four",
       ix._ico_sizes(blob), [16, 32, 48, 256])
    eq("...and the export reports the sizes it really wrote",
       r["sizesWritten"], [16, 32, 48, 256])
    with Image.open(p) as im:
        eq("...and PIL agrees when it reopens the file",
           sorted(s[0] for s in im.info["sizes"]), [16, 32, 48, 256])
        im.size = (32, 32)
        im.load()
        eq("...and a chosen entry really is that size", im.size, (32, 32))
    # The trap itself, so the fix above is provably a fix and not a coincidence.
    naive = os.path.join(TMP, "naive.ico")
    Image.fromarray(u8(photo(64, 64, 9)), "RGBA").save(
        naive, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
    with open(naive, "rb") as f:
        naive_sizes = ix._ico_sizes(f.read())
    note(f"the same source saved straight through Pillow contains "
         f"{naive_sizes} - the 256 is dropped without a word")
    eq("...which is what this exporter is working around", 256 in naive_sizes, False)
    p = out("tiny.ico")
    ix.export(cutout(3, 3), p, {"format": "ico", "sizes": [16, 256]})
    eq("even a 3x3 source produces a real 16-and-256 icon",
       ix._ico_sizes(open(p, "rb").read()), [16, 256])
    eq("...that PIL can actually open", Image.open(p).size in ((256, 256), (16, 16)), True)
    eq("ICO keeps alpha", float(read_rgba(p)[..., 3].min()) < 0.5, True)

    # The second ICO trap, and the nastier one: Pillow KEEPS THE ASPECT RATIO,
    # so a 300x100 source asked for 32x32 writes a 32x11 entry - and it then
    # drops any size that does not fit the source on BOTH axes, so the 256 goes
    # missing entirely. Icons are square; a wide source has to be padded, not
    # stretched and not quietly skipped.
    wide = np.zeros((100, 300, 4), np.float32)
    wide[..., 0] = 1.0
    wide[..., 3] = 1.0
    naive_wide = out("naive_wide.ico")
    Image.fromarray(u8(wide), "RGBA").save(
        naive_wide, format="ICO", sizes=[(16, 16), (32, 32), (256, 256)])
    with Image.open(naive_wide) as im:
        naive_entry = sorted(im.info["sizes"])
    note(f"a 300x100 source straight through Pillow, asked for 16/32/256: "
         f"{naive_entry} - not square, and the 256 is gone")
    eq("Pillow's own ICO of a wide source is neither square nor complete",
       ((256, 256) in naive_entry, all(w == h for w, h in naive_entry)),
       (False, False))
    p = out("wide.ico")
    r = ix.export(wide, p, {"format": "ico", "sizes": [16, 32, 256]})
    with Image.open(p) as im:
        entries = sorted(im.info["sizes"])
    eq("...and this exporter pads it to square and writes all three",
       (entries, r["sizesWritten"]),
       ([(16, 16), (32, 32), (256, 256)], [16, 32, 256]))
    eq("...and says it padded rather than doing it behind your back",
       r.get("icoPaddedToSquare"), 300)

    section("PDF: one page, verified structurally (PIL cannot reopen one)")
    eq("PDF is genuinely write-only here",
       ("PDF" in Image.SAVE, "PDF" in Image.OPEN), (True, False))
    p = out("proof.pdf")
    r = ix.export(PHOTO, p, {"format": "pdf", "dpi": 300})
    blob = open(p, "rb").read()
    eq("it is a PDF, with an image XObject and a proper trailer",
       (blob[:5], b"/Subtype /Image" in blob, blob.rstrip()[-5:]),
       (b"%PDF-", True, b"%%EOF"))
    eq("...carrying the full pixel dimensions",
       (b"/Width 512" in blob, b"/Height 512" in blob), (True, True))
    box300 = blob.split(b"/MediaBox [")[1].split(b"]")[0]
    blob72 = open(out("proof72.pdf"), "rb").read() if ix.export(
        PHOTO, out("proof72.pdf"), {"format": "pdf", "dpi": 72}) else b""
    box72 = blob72.split(b"/MediaBox [")[1].split(b"]")[0]
    note(f"512px at 300dpi -> MediaBox {box300.decode()}; at 72dpi -> {box72.decode()}")
    eq("...and dpi decides the page size, not the pixel count",
       (b"122.88" in box300, b"512" in box72), (True, True))
    eq("a cutout in a PDF is flattened onto the stated matte",
       ix.encode(CUT, {"format": "pdf"})[1]["matte"], [255, 255, 255])

    section("resize on export")
    for w, h in ((320, 200), (1, 1), (777, 13)):
        p = out(f"ex{w}x{h}.png")
        r = ix.export(PHOTO, p, {"format": "png", "resizeMode": "exact",
                                 "resizeWidth": w, "resizeHeight": h})
        eq(f"exact {w}x{h} produces exactly {w}x{h}",
           (Image.open(p).size, (r["width"], r["height"])), ((w, h), (w, h)))
    p = out("le.png")
    ix.export(photo(400, 300, 3), p, {"format": "png", "resizeMode": "longestEdge",
                                      "resizeLongestEdge": 200})
    eq("longestEdge 200 on a 400x300 gives 200x150", Image.open(p).size, (200, 150))
    p = out("le_up.png")
    ix.export(photo(100, 50, 3), p, {"format": "png", "resizeMode": "longestEdge",
                                     "resizeLongestEdge": 300})
    eq("...and it grows as readily as it shrinks", Image.open(p).size, (300, 150))
    p = out("exw.png")
    ix.export(photo(400, 300, 3), p, {"format": "png", "resizeMode": "exact",
                                      "resizeWidth": 200})
    eq("exact with only a width keeps the aspect ratio", Image.open(p).size, (200, 150))

    # Percent rounds HALF UP - stated in the catalog, so it gets asserted at the
    # boundary rather than assumed. 50% of 101 is 50.5, which is 51, not 50.
    p = out("pct.png")
    ix.export(photo(101, 101, 4), p, {"format": "png", "resizeMode": "percent",
                                      "resizePercent": 50})
    eq("percent rounds half UP (50% of 101 is 51, not 50)", Image.open(p).size, (51, 51))
    p = out("pct33.png")
    ix.export(photo(300, 300, 4), p, {"format": "png", "resizeMode": "percent",
                                      "resizePercent": 33})
    eq("...and is exact where it lands exactly (33% of 300 is 99)",
       Image.open(p).size, (99, 99))
    p = out("pct1.png")
    ix.export(photo(40, 40, 4), p, {"format": "png", "resizeMode": "percent",
                                    "resizePercent": 1})
    eq("...and never rounds an image out of existence", Image.open(p).size, (1, 1))

    for f in ["auto"] + sorted(ix.RESAMPLE):
        got = ix.resize_rgba(PHOTO, 128, 96, f)
        eq(f"resample {f} produces the size asked for", got.shape, (96, 128, 4))
    sharp = float(np.abs(np.diff(ix.resize_rgba(PHOTO, 256, 256, "lanczos")[..., 0])).mean())
    soft = float(np.abs(np.diff(ix.resize_rgba(PHOTO, 256, 256, "bilinear")[..., 0])).mean())
    note(f"downscale detail retained: lanczos {sharp:.4f} vs bilinear {soft:.4f} "
         f"mean |dx|")
    eq("...and the filters are not all the same code path", sharp > soft, True)

    # Resizing STRAIGHT alpha drags the colour of undefined transparent pixels
    # into every edge - the same black halo, arriving through the resampler.
    # This module premultiplies first, so a white cutout stays white everywhere
    # it is visible at all.
    small = ix.resize_rgba(CUT, 41, 41, "lanczos")
    vis = small[..., 3] > 0.02
    note(f"white cutout downscaled to 41x41: darkest visible pixel "
         f"{float(small[..., :3][vis].min()):.3f}")
    eq("resampling does not drag transparent black into the edge",
       float(small[..., :3][vis].min()) > 0.93, True)

    section("metadata")
    ex = Image.Exif()
    ex[271] = "AIPLAY"                   # Make
    ex[272] = "Studio Export"            # Model
    ex[305] = "AIPLAY Studio"            # Software
    RAW = ex.tobytes()
    IDENT = (271, 272, 305)

    eq("the default is strip, and the catalog says so",
       ix.COMMON["metadata"]["default"], "strip")
    for fmt in ("jpeg", "png", "webp", "tiff", "avif"):
        if not ix.CATALOG[fmt]["available"]:
            continue
        e = ix.CATALOG[fmt]
        p = out(f"strip{e['ext']}")
        ix.export(PHOTO, p, {"format": fmt}, exif=RAW)
        got = Image.open(p).getexif()
        eq(f"{e['label']}: EXIF is genuinely gone when stripped",
           [t for t in IDENT if t in got], [])
        p = out(f"keep{e['ext']}")
        r = ix.export(PHOTO, p, {"format": fmt, "metadata": "preserve"}, exif=RAW)
        got = Image.open(p).getexif()
        eq(f"{e['label']}: ...and genuinely present when preserved",
           [got.get(t) for t in IDENT], ["AIPLAY", "Studio Export", "AIPLAY Studio"])
        eq(f"{e['label']}: ...and the result says which happened", r["exifWritten"], True)
    note("TIFF's own IFD IS an EXIF IFD, so a stripped TIFF still reports the "
         "structural tags (width, depth, strip offsets) - the identifying ones "
         "are what 'stripped' can mean there, and they are what is asserted")
    eq("a stripped TIFF still carries its structural tags, as it must",
       len(Image.open(out("strip.tiff")).getexif()) > 0, True)

    try:
        ix.encode(PHOTO, {"format": "ico", "metadata": "preserve"})
        eq("preserve on a format with no EXIF container is refused", False, True)
    except ValueError as exc:
        eq("preserve on a format with no EXIF container is refused, loudly",
           "EXIF container" in str(exc), True)
    m = ix.encode(PHOTO, {"format": "jpeg", "metadata": "preserve"})[1]
    eq("preserve with nothing to preserve says so rather than implying success",
       (m["exifWritten"], bool(m.get("metadataNote"))), (False, True))
    try:
        ix.encode(PHOTO, {"format": "png", "bitDepth": 16, "metadata": "preserve"},
                  exif=RAW)
        eq("16-bit PNG + preserve is refused", False, True)
    except ValueError as exc:
        eq("16-bit PNG + preserve is refused, because OpenCV cannot carry EXIF",
           "OpenCV" in str(exc), True)

    section("size targeting")
    big = photo(384, 384, 11)
    for fmt, target in (("jpeg", 40_000), ("webp", 25_000), ("avif", 15_000),
                        ("png", 120_000)):
        if not ix.CATALOG[fmt]["available"]:
            continue
        p = out(f"tgt{ix.CATALOG[fmt]['ext']}")
        r = ix.target_size(big, target, {"format": fmt}, out_path=p)
        real = os.path.getsize(p)
        note(f"{fmt} under {target} bytes: landed on {r['lever']}={r[r['lever']]}, "
             f"{real} bytes ({r['probes']} probes)")
        eq(f"{fmt} size targeting lands UNDER the target", real <= target, True)
        eq(f"...and reports the {r['lever']} it actually used, and the real size",
           (r["met"], r["bytes"] == real), (True, True))
        # It has to be the LARGEST setting that fits, or "search" is a lie.
        nxt = dict({"format": fmt}, **ix._LEVER[fmt][3])
        nxt[r["lever"]] = r[r["lever"]] + 1
        if r[r["lever"]] < ix._LEVER[fmt][2]:
            eq(f"...and one step higher would have missed",
               len(ix.encode(big, nxt)[0]) > target, True)

    p = out("impossible.jpg")
    r = ix.target_size(big, 1, {"format": "jpeg"}, out_path=p)
    note(f"asked for 1 byte: {r['error']}")
    eq("an impossible target says so instead of returning a file that misses",
       (r["ok"], r["met"], os.path.exists(p)), (False, False, False))
    eq("...and reports the smallest size that format can reach",
       r["bytes"] > 1, True)
    r = ix.target_size(big, 1, {"format": "jpeg"}, out_path=p, allow_miss=True)
    eq("...and allow_miss writes the best effort while still reporting met:false",
       (os.path.exists(p), r["met"], os.path.getsize(p) == r["bytes"]),
       (True, False, True))
    for fmt in ("ico", "pdf"):
        try:
            ix.target_size(big, 10_000, {"format": fmt})
            eq(f"targeting a {fmt} size is refused", False, True)
        except ValueError as exc:
            eq(f"targeting a {fmt} size is refused with a reason",
               "no quality dial" in str(exc), True)

    section("the size estimate")
    for fmt, kw in (("jpeg", {"quality": 70}), ("webp", {"quality": 70}),
                    ("png", {}), ("avif", {"quality": 50}), ("ico", {}), ("pdf", {})):
        if not ix.CATALOG[fmt]["available"]:
            continue
        opts = {"format": fmt, **kw}
        est = ix.estimate_size(FLAT, opts, mode="exact")
        p = out(f"est{ix.CATALOG[fmt]['ext']}")
        ix.export(FLAT, p, opts)
        eq(f"{fmt}: the exact estimate is exactly the file, to the byte",
           (est["bytes"], est["exact"]), (os.path.getsize(p), True))

    # The sampling estimator, measured across several images and both kinds of
    # content, and reported. The bound is SAMPLE_TOLERANCE; the number printed
    # is what it actually was, so drift shows up instead of hiding under a loose
    # assertion.
    worst = 0.0
    worst_case = None
    for seed, img in ((21, BIG), (22, photo(1024, 1024, 22)),
                      (23, photo(1024, 1024, 23))):
        # One per format family plus WebP twice, because WebP at low quality is
        # the worst case the estimator has and the one worth watching.
        for fmt, kw in (("jpeg", {"quality": 40}), ("webp", {"quality": 80}),
                        ("webp", {"quality": 40}), ("png", {}),
                        ("avif", {"quality": 55}),
                        ("tiff", {"compression": "tiff_deflate"})):
            if not ix.CATALOG[fmt]["available"]:
                continue
            opts = {"format": fmt, **kw}
            truth = ix.estimate_size(img, opts, mode="exact")["bytes"]
            est = ix.estimate_size(img, opts, mode="sample")
            err = abs(est["bytes"] - truth) / float(truth)
            if err > worst:
                worst, worst_case = err, f"{fmt} {kw} seed {seed}"
            eq(f"sampled estimate for {fmt} {kw or '{}'} seed {seed} is inside "
               f"{int(ix.SAMPLE_TOLERANCE * 100)}%", err <= ix.SAMPLE_TOLERANCE, True)
    note(f"worst sampled-estimate error measured this run: {worst * 100:.1f}% "
         f"({worst_case}); advertised tolerance "
         f"{int(ix.SAMPLE_TOLERANCE * 100)}%")
    sampled = ix.estimate_size(BIG, {"format": "jpeg"}, mode="sample")
    eq("the sampled estimate declares itself inexact and carries its tolerance",
       (sampled["exact"], sampled["tolerance"]), (False, ix.SAMPLE_TOLERANCE))
    eq("auto is exact for a small image and sampled for a big one",
       (ix.estimate_size(FLAT, {"format": "jpeg"})["method"],
        ix.estimate_size(OVER, {"format": "jpeg"})["method"]),
       ("exact", "sample"))
    eq("...and a resize that shrinks the output brings exactness back with it",
       ix.estimate_size(OVER, {"format": "jpeg", "resizeMode": "longestEdge",
                              "resizeLongestEdge": 400})["method"], "exact")
    # "Without writing the file" is the whole promise of an estimate, so it is
    # checked by watching the directory rather than by trusting the docstring.
    before = sorted(os.listdir(TMP))
    for fmt in sorted(ix.CATALOG):
        if ix.CATALOG[fmt]["available"]:
            ix.estimate_size(FLAT, {"format": fmt}, mode="exact")
            ix.estimate_size(OVER, {"format": fmt})
    eq("estimating writes nothing at all", sorted(os.listdir(TMP)), before)

    section("hostile input")
    one = cutout(1, 1)
    for fmt in sorted(ix.CATALOG):
        if not ix.CATALOG[fmt]["available"]:
            continue
        p = out(f"one{ix.CATALOG[fmt]['ext']}")
        r = ix.export(one, p, {"format": fmt})
        eq(f"a 1x1 image exports to {fmt} and is a real file",
           (r["ok"], os.path.getsize(p) > 0), (True, True))
    clear_img = np.zeros((32, 32, 4), np.float32)
    p = out("clear.png")
    ix.export(clear_img, p, {"format": "png"})
    eq("a fully transparent PNG stays fully transparent",
       float(read_rgba(p)[..., 3].max()), 0.0)
    p = out("clear.jpg")
    ix.export(clear_img, p, {"format": "jpeg", "quality": 95, "chroma": "4:4:4"})
    eq("...and flattened to JPEG it is the matte, not black",
       int(u8(read_rgba(p))[..., :3].min()) >= 250, True)

    _f, v, rep = ix.resolve({"format": "jpeg", "quality": 0})
    eq("quality 0 is clamped to the catalog minimum and REPORTED",
       (v["quality"], rep["clamped"]["quality"]["asked"],
        rep["clamped"]["quality"]["used"]), (1, 0.0, 1.0))
    _f, v, rep = ix.resolve({"format": "jpeg", "quality": 101})
    eq("quality 101 is clamped to 100 and REPORTED",
       (v["quality"], rep["clamped"]["quality"]["used"]), (100, 100.0))
    r = ix.export(PHOTO, out("q0.jpg"), {"format": "jpeg", "quality": 0})
    eq("...and quality 0 still writes a valid JPEG",
       (Image.open(out("q0.jpg")).format, r["clamped"]["quality"]["used"]),
       ("JPEG", 1.0))
    note("Pillow itself would have taken quality=101 silently (it clamps) and "
         "quality=-1 as 'use the default' - neither of which the caller asked for")

    for what, opts, needle in (
            ("an unknown format", {"format": "gif"}, "unknown format"),
            ("no format at all", {}, "no format given"),
            ("an unknown option", {"format": "png", "sharpness": 3}, "unknown option"),
            ("an enum outside its options", {"format": "jpeg", "chroma": "4:1:1"},
             "not one of"),
            ("exact resize with no dimensions", {"format": "png",
                                                 "resizeMode": "exact"}, "needs"),
            ("a 16-bit palette PNG", {"format": "png", "bitDepth": 16,
                                      "palette": True}, "cannot both be true"),
            ("an empty ICO size list", {"format": "ico", "sizes": []}, "empty"),
            ("an ICO size that is not a real icon size", {"format": "ico",
                                                          "sizes": [17]}, "not in")):
        try:
            ix.encode(PHOTO, opts)
            eq(f"{what} is refused", False, True)
        except ValueError as exc:
            eq(f"{what} is refused, and the message says which", needle in str(exc), True)
    try:
        ix.target_size(PHOTO, 0, {"format": "jpeg"})
        eq("a target of zero bytes is refused", False, True)
    except ValueError as exc:
        eq("a target of zero bytes is refused", "not a target" in str(exc), True)
    try:
        ix.as_rgba(np.zeros((0, 4, 4), np.float32))
        eq("an empty image is refused", False, True)
    except ValueError as exc:
        eq("an empty image is refused", "at least one pixel" in str(exc), True)

    section("the seam: the CLI another column actually calls")
    PY = sys.executable
    HERE = os.path.dirname(os.path.abspath(__file__))
    MOD = os.path.join(HERE, "imgexport.py")

    def cli(mode, job=None):
        args = [PY, MOD, mode]
        if job is not None:
            jp = out("job.json")
            with open(jp, "w", encoding="utf-8") as f:
                json.dump(job, f)
            args.append(jp)
        pr = subprocess.run(args, capture_output=True, text=True)
        return pr.returncode, json.loads(pr.stdout.strip().splitlines()[-1])

    rc, got = cli("catalog")
    eq("the catalog is one JSON line on stdout",
       (rc, sorted(got["formats"]) == sorted(ix.CATALOG)), (0, True))

    src = out("cli_in.png")
    Image.fromarray(u8(CUT), "RGBA").save(src, exif=RAW)
    dst = out("cli_out.jpg")
    rc, got = cli("export", {"in": src, "out": dst,
                             "export": {"format": "jpeg", "quality": 80,
                                        "matte": [255, 255, 255]}})
    eq("export through the CLI writes the file and reports its real size",
       (rc, got["ok"], got["bytes"] == os.path.getsize(dst)), (0, True, True))
    eq("...and the CLI strips EXIF by default, like every other entry point",
       [t for t in IDENT if t in Image.open(dst).getexif()], [])
    rc, got = cli("export", {"in": src, "out": out("cli_keep.jpg"),
                             "export": {"format": "jpeg", "metadata": "preserve"}})
    eq("...and preserves it from the SOURCE FILE when asked",
       Image.open(out("cli_keep.jpg")).getexif().get(271), "AIPLAY")

    rc, got = cli("estimate", {"in": src, "export": {"format": "webp",
                                                     "quality": 70}})
    ix.export(CUT, out("cli_cmp.webp"), {"format": "webp", "quality": 70})
    eq("estimate through the CLI matches the file the CLI would have written",
       (rc, got["bytes"]), (0, os.path.getsize(out("cli_cmp.webp"))))

    rc, got = cli("target", {"in": src, "out": out("cli_t.jpg"),
                             "export": {"format": "jpeg"}, "maxBytes": 3000})
    eq("target through the CLI lands under and exits 0",
       (rc, got["met"], os.path.getsize(out("cli_t.jpg")) <= 3000), (0, True, True))
    rc, got = cli("target", {"in": src, "out": out("cli_miss.jpg"),
                             "export": {"format": "jpeg"}, "maxBytes": 1})
    eq("...and exits NON-ZERO when it cannot, rather than reporting success",
       (rc, got["ok"], os.path.exists(out("cli_miss.jpg"))), (1, False, False))
    rc, got = cli("export", {"in": src, "out": dst, "export": {"format": "nope"}})
    eq("a bad job is one JSON error line and exit 1",
       (rc, got["ok"], "unknown format" in got["error"]), (1, False, True))

    # base64 pixels, the shape a caller that already holds the array uses.
    import base64
    rc, got = cli("export", {"pixels": base64.b64encode(u8(FLAT).tobytes()).decode(),
                             "width": FLAT.shape[1], "height": FLAT.shape[0],
                             "out": out("cli_px.png"), "export": {"format": "png"}})
    eq("raw pixels can be posted instead of a path",
       (rc, got["width"], got["height"]), (0, FLAT.shape[1], FLAT.shape[0]))
    eq("...and they are the same pixels",
       maxdiff(read_rgba(out("cli_px.png")), FLAT), 0)

    section("the size table")
    TABLE = photo(1024, 1024, 42)
    rows = [("PNG truecolour", {"format": "png"}),
            ("PNG 16-bit", {"format": "png", "bitDepth": 16}),
            ("PNG palette 256", {"format": "png", "palette": True, "paletteColors": 256}),
            ("PNG palette 64", {"format": "png", "palette": True, "paletteColors": 64}),
            ("JPEG 95 4:4:4", {"format": "jpeg", "quality": 95, "chroma": "4:4:4"}),
            ("JPEG 95", {"format": "jpeg", "quality": 95}),
            ("JPEG 85", {"format": "jpeg", "quality": 85}),
            ("JPEG 85 progressive", {"format": "jpeg", "quality": 85,
                                     "progressive": True}),
            ("JPEG 60", {"format": "jpeg", "quality": 60}),
            ("JPEG 30", {"format": "jpeg", "quality": 30}),
            ("WebP lossless", {"format": "webp", "lossless": True}),
            ("WebP 90", {"format": "webp", "quality": 90}),
            ("WebP 80", {"format": "webp", "quality": 80}),
            ("WebP 50", {"format": "webp", "quality": 50}),
            ("AVIF 80", {"format": "avif", "quality": 80}),
            ("AVIF 60", {"format": "avif", "quality": 60}),
            ("AVIF 40", {"format": "avif", "quality": 40}),
            ("TIFF deflate", {"format": "tiff", "compression": "tiff_deflate"}),
            ("TIFF lzw", {"format": "tiff", "compression": "tiff_lzw"}),
            ("TIFF none", {"format": "tiff", "compression": "none"}),
            ("PDF 300dpi", {"format": "pdf", "dpi": 300}),
            ("ICO 16/32/48/256", {"format": "ico", "sizes": [16, 32, 48, 256]})]
    print(f"\n    a 1024x1024 photograph, opaque RGB")
    print(f"    {'':22s} {'bytes':>9s}  {'KB':>7s}  vs PNG")
    base = None
    table_lines = []
    for label, opts in rows:
        if not ix.CATALOG[opts["format"]]["available"]:
            continue
        n = len(ix.encode(TABLE, opts)[0])
        base = base if base is not None else n
        line = f"    {label:22s} {n:9d}  {n / 1024:7.1f}  {n / base * 100:5.1f}%"
        print(line)
        table_lines.append(line)
    eq("every row of the table encoded", len(table_lines) >= 20, True)

except Exception:                                           # noqa: BLE001
    FAIL += 1
    print('  FAIL  the suite raised before it finished:')
    traceback.print_exc(file=sys.stdout)
finally:
    shutil.rmtree(TMP, ignore_errors=True)
    eq("the temp directory is cleaned up", os.path.exists(TMP), False)

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
