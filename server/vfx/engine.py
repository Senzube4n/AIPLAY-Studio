"""The VFX compositor — the one place comp.json becomes pixels.

The browser never renders the final frame; it asks for one. So does MCP, so does
the render queue. Everything below is reachable from a single CLI so there is
exactly one implementation of "what does this comp look like at t":

  python server/vfx/engine.py frame  <job.json>    one PNG at a time
  python server/vfx/engine.py render <job.json>    a movie or a frame sequence
  python server/vfx/engine.py probe  <job.json>    what a source actually is

One JSON line to stdout per invocation (render also emits progress lines first);
any failure is {"ok": false, "error": "..."} and exit 1, so the node side can
treat a crash and a refusal identically.

Sources arriving here are ABSOLUTE paths — the route resolves library names, and
this process never gets to pick a file off disk on its own.

Pixel contract, everywhere inside: float32, (H, W, 4), 0..1, STRAIGHT
(un-premultiplied) alpha. Premultiplying happens only where the maths demands it
— resampling and averaging — and is undone immediately after, because effects
and the blend formulas below are all written against straight alpha.

Layer order is AE's: layers[0] is the TOP of the stack, so the paint loop walks
the list backwards.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from collections import OrderedDict, namedtuple
from fractions import Fraction

import av
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVER = os.path.dirname(_HERE)
if _SERVER not in sys.path:
    sys.path.insert(0, _SERVER)

import imagetools  # noqa: E402  — the blend maths lives there; do not fork it

try:
    from . import interp
except ImportError:                                   # run as a bare script
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    import interp  # type: ignore  # noqa: F401

# effects.py is a separate deliverable and may legitimately not be here yet (or
# may fail to import on a half-written edit). A comp still has to render — a
# missing registry means "no effects", not "no frame".
try:
    from . import effects
except Exception:                                     # noqa: BLE001
    try:
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        import effects  # type: ignore
    except Exception:                                 # noqa: BLE001
        effects = None

EPS = 1e-6
Tile = namedtuple("Tile", "rgba x y")     # a layer's pixels plus where they land

MAX_HISTORY = 16                          # frames an echo-style effect may ask for
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
FONT_DIRS = [r"C:\Windows\Fonts",
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")]


def _f(v, fallback=0.0):
    """A scalar out of anything a document might hold, including a stray pair."""
    if isinstance(v, (list, tuple)):
        v = v[0] if v else fallback
    try:
        f = float(v)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


def _rgba01(color, fallback=(0.0, 0.0, 0.0, 0.0)):
    """A [r,g,b,a] 0-255 document colour as float 0..1, alpha optional."""
    if not isinstance(color, (list, tuple)) or not color:
        return fallback
    vals = [_f(c) / 255.0 for c in list(color)[:4]]
    while len(vals) < 4:
        vals.append(1.0)
    return tuple(min(1.0, max(0.0, v)) for v in vals)


# ── blending ──────────────────────────────────────────────────────────────────

# imagetools._blend owns normal/multiply/screen/overlay/softlight/add/subtract/
# difference/darken/lighten. The rest of the spec's list is not there and adding
# it would mean editing a file this engine does not own, so the remainder lives
# here — same maths, W3C compositing-1, just a different house.
_EXTRA_MODES = ("hardlight", "colordodge", "colorburn",
                "hue", "saturation", "color", "luminosity")

_LUMA_W = np.array([0.30, 0.59, 0.11], dtype=np.float32)


def _lum(c):
    return (c * _LUMA_W).sum(axis=-1, keepdims=True)


def _clip_color(c):
    """Pull a colour back inside the cube WITHOUT moving its luminance.

    Naive clipping after a luminance transfer shifts hue on anything saturated;
    scaling toward the luma grey keeps the tone the operation just set.
    """
    l = _lum(c)
    n = c.min(axis=-1, keepdims=True)
    x = c.max(axis=-1, keepdims=True)
    lo = np.where(n < 0, l + (c - l) * l / np.minimum(l - n, -EPS), c)
    return np.where(x > 1, l + (lo - l) * (1 - l) / np.maximum(x - l, EPS), lo)


def _set_lum(c, l):
    return _clip_color(c + (l - _lum(c)))


def _set_sat(c, s):
    mn = c.min(axis=-1, keepdims=True)
    mx = c.max(axis=-1, keepdims=True)
    rng = mx - mn
    return np.where(rng > EPS, (c - mn) * s / np.maximum(rng, EPS), 0.0)


def _sat(c):
    return c.max(axis=-1, keepdims=True) - c.min(axis=-1, keepdims=True)


def _blend_rgb(base, top, mode):
    """B(Cb, Cs) for every mode in the spec, on float 0..1 RGB."""
    if mode in _EXTRA_MODES:
        if mode == "hardlight":
            return np.where(top <= 0.5, 2 * base * top, 1 - 2 * (1 - base) * (1 - top))
        if mode == "colordodge":
            return np.where(base <= EPS, 0.0,
                            np.where(top >= 1 - EPS, 1.0,
                                     np.minimum(1.0, base / np.maximum(1 - top, EPS))))
        if mode == "colorburn":
            return np.where(base >= 1 - EPS, 1.0,
                            np.where(top <= EPS, 0.0,
                                     1 - np.minimum(1.0, (1 - base) / np.maximum(top, EPS))))
        if mode == "hue":
            return _set_lum(_set_sat(top, _sat(base)), _lum(base))
        if mode == "saturation":
            return _set_lum(_set_sat(base, _sat(top)), _lum(base))
        if mode == "color":
            return _set_lum(top, _lum(base))
        return _set_lum(base, _lum(top))              # luminosity
    return imagetools._blend(base, top, mode)


BLEND_MODES = tuple(imagetools.BLEND_MODES) + _EXTRA_MODES


def _is_opaque(rgba):
    """Whether every pixel is fully covered — worth one min() to find out.

    Most footage is: a decoded video frame, a JPEG plate, a full-bleed solid. The
    general straight-alpha maths below costs several full-frame temporaries and a
    divide that all collapse to nothing in that case, and a 1080p frame is half a
    million pixels of collapsing.
    """
    return float(rgba[..., 3].min()) >= 1.0 - EPS


def _over(acc, tile, mode="normal"):
    """Composite one tile into the accumulator, W3C source-over with a blend.

    Not the simplified `dst*(1-a) + blend*a` the image compositor uses: that one
    assumes an opaque backdrop, and a comp's backdrop is transparent by default.
    Blending against nothing must yield the source itself, which is what the
    (1 - ab) term buys.
    """
    h, w = tile.rgba.shape[:2]
    src = tile.rgba
    dst = acc[tile.y:tile.y + h, tile.x:tile.x + w]
    a_s = src[..., 3:4]
    ab = dst[..., 3:4]

    if _is_opaque(src) and (not mode or mode == "normal"):
        dst[...] = src                       # nothing of the backdrop survives
        return

    cs = src[..., :3]
    cb = dst[..., :3]
    if mode and mode != "normal":
        blended = np.clip(_blend_rgb(cb, cs, mode), 0.0, 1.0)
        cs = cs + ab * (blended - cs)        # the blend only applies where there IS a backdrop
    if _is_opaque(dst):
        # output alpha is 1, so the un-premultiplying divide has nothing to do
        dst[..., :3] = cb + (cs - cb) * a_s
        dst[..., 3:4] = 1.0
        return
    ao = a_s + ab * (1 - a_s)
    num = cs * a_s + cb * ab * (1 - a_s)
    np.divide(num, np.maximum(ao, EPS), out=num)
    dst[..., :3] = np.where(ao > EPS, num, 0.0)
    dst[..., 3:4] = np.clip(ao, 0.0, 1.0)


# ── sources ───────────────────────────────────────────────────────────────────

_IMAGES = OrderedDict()                   # path -> float32 RGBA at native size
_IMAGE_BYTES = 0
_IMAGE_LIMIT = int(os.environ.get("VFX_IMAGE_CACHE_MB", "384")) * 1024 * 1024

_FRAMES = OrderedDict()                   # (path, index) -> uint8 RGB(A)
_FRAME_BYTES = 0
_FRAME_LIMIT = int(os.environ.get("VFX_FRAME_CACHE_MB", "512")) * 1024 * 1024

_READERS = OrderedDict()                  # path -> _VideoSource, containers held open
_READER_LIMIT = 8

_SCALED = OrderedDict()                   # (path, scale) -> float32 RGBA, preview-sized
_SCALED_BYTES = 0
_SCALED_LIMIT = int(os.environ.get("VFX_SCALED_CACHE_MB", "256")) * 1024 * 1024

_TEXT = OrderedDict()                     # (spec, w, h, scale) -> float32 RGBA
_TEXT_LIMIT = 24


def _trim(store, current, limit):
    """Drop least-recently-used entries until the store fits its budget."""
    while store and current > limit:
        _, arr = store.popitem(last=False)
        current -= arr.nbytes
    return current


def load_image(path):
    """A still as float32 straight-alpha RGBA, cached by path.

    Scrubbing a timeline re-asks for the same PNG thirty times a second; decoding
    it thirty times a second is the difference between a usable viewer and a
    slideshow.
    """
    global _IMAGE_BYTES
    hit = _IMAGES.get(path)
    if hit is not None:
        _IMAGES.move_to_end(path)
        return hit
    with Image.open(path) as im:
        arr = np.asarray(im.convert("RGBA"), dtype=np.uint8)
    rgba = arr.astype(np.float32) / 255.0
    _IMAGES[path] = rgba
    _IMAGE_BYTES = _trim(_IMAGES, _IMAGE_BYTES + rgba.nbytes, _IMAGE_LIMIT)
    return rgba


class _VideoSource:
    """One open container plus the bookkeeping to reach an arbitrary frame.

    Two access patterns matter and they pull in opposite directions: a render
    walks forward one frame at a time, and a scrub jumps anywhere. Decoding
    forward is nearly free; seeking costs a keyframe re-decode. So this keeps the
    decoder running and only seeks when the target is behind the playhead or far
    enough ahead that decoding through would cost more than a seek.

    Everything decoded on the way to the target is cached, which is why dragging
    back and forth across the same second stops touching the file at all.
    """

    FORWARD_WINDOW = 30                   # frames worth decoding through rather than seeking

    def __init__(self, path):
        self.path = path
        self.container = av.open(path)
        self.stream = self.container.streams.video[0]
        self.stream.thread_type = "AUTO"
        rate = self.stream.average_rate or self.stream.guessed_rate
        self.fps = float(rate) if rate else 30.0
        if not math.isfinite(self.fps) or self.fps <= 0:
            self.fps = 30.0
        self.width = int(self.stream.codec_context.width or 0)
        self.height = int(self.stream.codec_context.height or 0)
        dur = None
        if self.stream.duration is not None and self.stream.time_base:
            dur = float(self.stream.duration * self.stream.time_base)
        elif self.container.duration is not None:
            dur = float(self.container.duration) / av.time_base
        self.duration = dur if dur and dur > 0 else 0.0
        self.count = int(self.stream.frames or 0) or (
            int(round(self.duration * self.fps)) if self.duration else 0)
        self._gen = None
        self._next = None                 # index the running decoder will yield next

    def close(self):
        try:
            self.container.close()
        except Exception:                 # noqa: BLE001 — closing a dead container is not news
            pass

    def _index_of(self, frame, fallback):
        if frame.pts is not None and self.stream.time_base:
            start = self.stream.start_time or 0
            secs = float((frame.pts - start) * self.stream.time_base)
            return max(0, int(round(secs * self.fps)))
        return fallback

    def _seek(self, index):
        target = index / self.fps
        if self.stream.time_base:
            start = self.stream.start_time or 0
            pts = int(target / float(self.stream.time_base)) + start
        else:
            pts = int(target * av.time_base)
        self.container.seek(pts, stream=self.stream, backward=True, any_frame=False)
        self._gen = self.container.decode(video=0)
        self._next = None

    def frame(self, index):
        """uint8 RGB or RGBA at the given frame index, decoding as little as possible."""
        global _FRAME_BYTES
        if self.count:
            index = max(0, min(self.count - 1, int(index)))
        else:
            index = max(0, int(index))
        key = (self.path, index)
        hit = _FRAMES.get(key)
        if hit is not None:
            _FRAMES.move_to_end(key)
            return hit

        if (self._gen is None or self._next is None
                or index < self._next or index > self._next + self.FORWARD_WINDOW):
            self._seek(index)

        counter = self._next if self._next is not None else 0
        last = None
        for frame in self._gen:
            idx = self._index_of(frame, counter)
            counter = idx + 1
            self._next = counter
            fmt = "rgba" if getattr(frame.format, "has_alpha", False) else "rgb24"
            arr = frame.to_ndarray(format=fmt)
            _FRAMES[(self.path, idx)] = arr
            _FRAME_BYTES = _trim(_FRAMES, _FRAME_BYTES + arr.nbytes, _FRAME_LIMIT)
            last = arr
            if idx >= index:
                return arr
        # ran off the end: the last decodable frame is the honest answer, and it
        # is what a clamped out-point should show anyway
        self._gen = None
        self._next = None
        if last is not None:
            return last
        raise ValueError(f"no decodable frame at index {index} in {os.path.basename(self.path)}")


def video_source(path):
    src = _READERS.get(path)
    if src is not None:
        _READERS.move_to_end(path)
        return src
    src = _VideoSource(path)
    _READERS[path] = src
    while len(_READERS) > _READER_LIMIT:
        _, dead = _READERS.popitem(last=False)
        dead.close()
    return src


def close_sources():
    """Let go of every open container and cached bitmap.

    The server holds this process open across comps, and Windows will not let a
    clip be replaced or deleted while a decoder still has it mapped — so there has
    to be a way to say "done with that footage" that is not "exit".
    """
    global _IMAGE_BYTES, _FRAME_BYTES, _SCALED_BYTES
    while _READERS:
        _, src = _READERS.popitem()
        src.close()
    _FRAMES.clear()
    _IMAGES.clear()
    _SCALED.clear()
    _TEXT.clear()
    _FRAME_BYTES = _IMAGE_BYTES = _SCALED_BYTES = 0


def _resolve_font(name, size):
    """A font by BASENAME only, out of the system font folders.

    Same rule imagetools follows and for the same reason: comp documents reach
    this process unvalidated, and handing an arbitrary string to FreeType means
    any file on disk gets opened and parsed.
    """
    want = os.path.basename(str(name or "arial.ttf"))
    for d in FONT_DIRS:
        if not d:
            continue
        try:
            return ImageFont.truetype(os.path.join(d, want), size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def _render_text(layer, w, h, scale):
    """Type on a transparent layer-sized canvas, centred on the canvas.

    Centred because the default anchor and position are both the comp centre, so
    a text layer with an untouched transform reads as "in the middle" — which is
    what someone who just typed into an empty comp expects to see.

    Nothing a text layer draws is animatable (the transform moves it, the glyphs
    do not change), so the raster is a pure function of the spec and the canvas —
    cached, because rasterising a static title thirty times a second is thirty
    times more FreeType than the frame needs.
    """
    spec = layer.get("text") or {}
    key = (json.dumps(spec, sort_keys=True, default=str), w, h, round(scale, 5))
    hit = _TEXT.get(key)
    if hit is not None:
        _TEXT.move_to_end(key)
        return hit
    rgba = _rasterize_text(spec, w, h, scale)
    _TEXT[key] = rgba
    while len(_TEXT) > _TEXT_LIMIT:
        _TEXT.popitem(last=False)
    return rgba


def _rasterize_text(spec, w, h, scale):
    content = str(spec.get("content") or "")
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if not content.strip():
        return np.asarray(im, dtype=np.float32) / 255.0

    size = max(1, int(round(_f(spec.get("size"), 64.0) * scale)))
    font = _resolve_font(spec.get("font"), size)
    draw = ImageDraw.Draw(im)
    fill = tuple(int(round(c * 255)) for c in _rgba01(spec.get("color"), (1.0, 1.0, 1.0, 1.0)))
    stroke_w = int(round(_f(spec.get("stroke"), 0.0) * scale))
    stroke_fill = tuple(int(round(c * 255)) for c in _rgba01(spec.get("strokeColor"), (0.0, 0.0, 0.0, 1.0)))
    align = str(spec.get("align") or "center").lower()
    line_h = _f(spec.get("lineHeight"), 1.15) * size
    # AE measures tracking in 1/1000 em, which is the number a designer will
    # copy off a type panel — turn it into pixels at this size.
    track = _f(spec.get("tracking"), 0.0) / 1000.0 * size

    lines = content.split("\n")
    top = h / 2.0 - (line_h * len(lines)) / 2.0 + line_h / 2.0
    anchor = {"left": "lm", "center": "mm", "right": "rm"}.get(align, "mm")
    for i, line in enumerate(lines):
        y = top + i * line_h
        if abs(track) < 0.01:
            draw.text((w / 2.0, y), line, font=font, fill=fill, anchor=anchor,
                      stroke_width=stroke_w, stroke_fill=stroke_fill if stroke_w else None)
            continue
        # Tracking has to be drawn glyph by glyph; PIL has no letter-spacing.
        widths = [draw.textlength(ch, font=font) for ch in line]
        total = sum(widths) + track * max(0, len(line) - 1)
        x = {"left": w / 2.0, "right": w / 2.0 - total}.get(align, w / 2.0 - total / 2.0)
        for ch, adv in zip(line, widths):
            draw.text((x, y), ch, font=font, fill=fill, anchor="lm",
                      stroke_width=stroke_w, stroke_fill=stroke_fill if stroke_w else None)
            x += adv + track
    return np.asarray(im, dtype=np.float32) / 255.0


def _source_time(layer, t):
    """Where in the source we are, for a layer sitting at comp time t.

    Negative timeScale walks the source backwards from its in point; the clamp is
    the out-point behaviour AE calls holding the last frame.
    """
    start = _f(layer.get("start"), 0.0)
    in_point = _f(layer.get("inPoint"), 0.0)
    ts = _f(layer.get("timeScale"), 1.0)
    return in_point + (t - start) * ts


def _layer_native_size(comp, layer):
    """The layer's own pixel dimensions — what its anchor is measured in."""
    cw, ch = int(comp.get("width") or 1920), int(comp.get("height") or 1080)
    kind = str(layer.get("type") or "image")
    if kind == "image":
        src = layer.get("src")
        if src:
            try:
                a = load_image(src)
                return a.shape[1], a.shape[0]
            except Exception:                          # noqa: BLE001
                return cw, ch
    elif kind == "video":
        src = layer.get("src")
        if src:
            try:
                v = video_source(src)
                if v.width and v.height:
                    return v.width, v.height
            except Exception:                          # noqa: BLE001
                return cw, ch
    elif kind == "solid":
        return int(_f(layer.get("width"), cw)) or cw, int(_f(layer.get("height"), ch)) or ch
    return cw, ch


def _layer_pixels(comp, layer, t, scale, size):
    """The layer's own bitmap at render resolution, before anything is done to it.

    Returns None for the types that have no pixels of their own — a null exists to
    be a parent, and an adjustment layer's pixels are whatever is already beneath
    it, which is not this function's business.
    """
    kind = str(layer.get("type") or "image")
    W, H = size
    if kind in ("null",):
        return None
    if kind == "solid":
        nw, nh = _layer_native_size(comp, layer)
        w = max(1, int(round(nw * scale)))
        h = max(1, int(round(nh * scale)))
        rgba = np.empty((h, w, 4), dtype=np.float32)
        rgba[:] = _rgba01(layer.get("color"), (1.0, 1.0, 1.0, 1.0))
        return rgba
    if kind == "text":
        return _render_text(layer, W, H, scale)
    if kind == "adjustment":
        # an opaque plate: only its ALPHA is used, as the region the adjustment
        # reaches, so it goes through the identical mask/transform path as a solid
        rgba = np.ones((H, W, 4), dtype=np.float32)
        return rgba
    src = layer.get("src")
    if not src:
        return None
    if kind == "video":
        v = video_source(src)
        st = _source_time(layer, t)
        if v.duration:
            st = min(max(0.0, st), max(0.0, v.duration - 0.5 / v.fps))
        else:
            st = max(0.0, st)
        arr = v.frame(int(round(st * v.fps)))
        # one allocation, not the three that convert-then-concatenate costs: at
        # 1080p each of those is 33 MB touched on every frame of a render
        a = np.empty(arr.shape[:2] + (4,), dtype=np.float32)
        np.divide(arr, 255.0, out=a[..., :arr.shape[2]])
        if arr.shape[2] == 3:
            a[..., 3] = 1.0
    else:
        # A still does not change between frames, so neither does its preview-
        # sized copy: resizing 1080p to half every frame of a scrub is the single
        # most wasteful thing this function could do.
        return _scaled_image(src, scale)
    return _resample(a, scale)


def _resample(a, scale):
    if abs(scale - 1.0) <= 1e-4:
        return np.ascontiguousarray(a, dtype=np.float32)
    w = max(1, int(round(a.shape[1] * scale)))
    h = max(1, int(round(a.shape[0] * scale)))
    # premultiplied resample: interpolating straight alpha across a cutout's edge
    # drags whatever colour sits in the fully-transparent pixels into the visible
    # fringe, which is the classic black halo
    out = cv2.resize(_premul(a), (w, h),
                     interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    return np.ascontiguousarray(_unpremul(np.asarray(out, dtype=np.float32), inplace=True))


def _scaled_image(path, scale):
    global _SCALED_BYTES
    key = (path, round(float(scale), 5))
    hit = _SCALED.get(key)
    if hit is not None:
        _SCALED.move_to_end(key)
        return hit
    out = _resample(load_image(path), scale)
    _SCALED[key] = out
    _SCALED_BYTES = _trim(_SCALED, _SCALED_BYTES + out.nbytes, _SCALED_LIMIT)
    return out


def _premul(rgba):
    """Straight -> premultiplied. Returns the input itself when it is opaque.

    Premultiplying by 1 is the identity, so a fully-covered frame needs no copy
    at all — and callers here only ever READ the result (it goes into resize or
    warpAffine as the source), so handing back the original is safe.
    """
    if _is_opaque(rgba):
        return rgba
    out = rgba.copy()
    out[..., :3] *= out[..., 3:4]
    return out


def _unpremul(rgba, inplace=False):
    """Premultiplied -> straight. inplace only for arrays the caller just made."""
    if _is_opaque(rgba):
        return rgba if inplace else rgba.copy()
    out = rgba if inplace else rgba.copy()
    a = out[..., 3:4]
    out[..., :3] = np.where(a > EPS, out[..., :3] / np.maximum(a, EPS), 0.0)
    return np.clip(out, 0.0, 1.0, out=out)


# ── effects, masks, transform ─────────────────────────────────────────────────

def _effect_ctx(comp, layer, t, scale, draft, size):
    ctx = {
        "t": float(t),
        "fps": _f(comp.get("fps"), 30.0),
        "width": int(size[0]),
        "height": int(size[1]),
        "draft": bool(draft),
        "layer": layer,
        # not in the spec's ctx list, but a radius in pixels means nothing without
        # it: at 0.5 preview scale a 12px blur must become a 6px blur or the
        # preview lies about the render
        "scale": float(scale),
        # echo and friends declare needsHistory; a LIST would decode N extra
        # frames for every layer on every frame whether or not anything asked.
        # A callable costs nothing until it is called.
        "history": lambda n=1: _history(comp, layer, t, scale, size, n, draft),
    }
    return ctx


def _history(comp, layer, t, scale, size, n, draft):
    """The layer's own source for up to n preceding frames, newest first."""
    if draft:
        return []
    fps = _f(comp.get("fps"), 30.0) or 30.0
    out = []
    for k in range(1, min(int(n), MAX_HISTORY) + 1):
        try:
            px = _layer_pixels(comp, layer, t - k / fps, scale, size)
        except Exception:                              # noqa: BLE001
            break
        if px is None:
            break
        out.append(px)
    return out


def _apply_effects(rgba, comp, layer, t, scale, draft, size):
    stack = layer.get("effects") or []
    if effects is None or not stack:
        return rgba
    ctx = _effect_ctx(comp, layer, t, scale, draft, size)
    for fx in stack:
        if not isinstance(fx, dict) or not fx.get("enabled", True):
            continue
        name = str(fx.get("type") or "")
        params = interp.eval_params(fx.get("params"), t)
        try:
            out = effects.apply(name, rgba, params, ctx)
        except Exception as exc:                       # noqa: BLE001
            # One bad param must not cost 900 frames. Say so on stderr (stdout is
            # the protocol) and carry the layer through unchanged.
            print(f"vfx: effect {name!r} failed: {exc}", file=sys.stderr)
            continue
        if isinstance(out, np.ndarray) and out.shape == rgba.shape:
            rgba = np.ascontiguousarray(out, dtype=np.float32)
    return rgba


def _mask_alpha(layer, t, w, h, scale):
    """The combined mask coverage for a layer, or None when it has no masks.

    Mask points are applied here — BEFORE the transform — so they are read in the
    layer's own pixel space. For the layers masks are actually drawn on (solids,
    adjustment layers, text: everything comp-sized with an untouched transform)
    layer space and comp space are the same grid, which is what the spec's
    "comp px" annotation describes.
    """
    masks = [m for m in (layer.get("masks") or [])
             if isinstance(m, dict) and str(m.get("mode") or "add") != "none"]
    if not masks:
        return None
    has_add = any(str(m.get("mode") or "add") == "add" for m in masks)
    # Only subtract masks means "everything, minus these holes"; the first add
    # mask is what turns the layer off everywhere it does not cover.
    acc = np.zeros((h, w), np.float32) if has_add else np.ones((h, w), np.float32)

    for mk in masks:
        pts = mk.get("points") or []
        if len(pts) < 3:
            continue
        poly = np.zeros((h, w), np.uint8)
        arr = np.round(np.asarray(pts, dtype=np.float64)[:, :2] * scale).astype(np.int32)
        cv2.fillPoly(poly, [arr], 255, lineType=cv2.LINE_AA)
        m = poly.astype(np.float32) / 255.0

        expand = _f(interp.eval_prop(mk.get("expand"), t, 0.0)) * scale
        if abs(expand) >= 0.5:
            r = int(round(abs(expand)))
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r * 2 + 1, r * 2 + 1))
            m = cv2.dilate(m, k) if expand > 0 else cv2.erode(m, k)
        feather = _f(interp.eval_prop(mk.get("feather"), t, 0.0)) * scale
        if feather > 0.1:
            # feather is the full soft band; a gaussian's visible reach is about
            # two sigma either side, so half of it is the sigma to ask for
            m = cv2.GaussianBlur(m, (0, 0), sigmaX=max(0.1, feather / 2.0))
        if mk.get("invert"):
            m = 1.0 - m
        m *= max(0.0, min(1.0, _f(interp.eval_prop(mk.get("opacity"), t, 100.0), 100.0) / 100.0))

        if str(mk.get("mode") or "add") == "add":
            acc = np.clip(acc + m, 0.0, 1.0)
        else:
            acc = np.clip(acc - m, 0.0, 1.0)
    return acc


def _warp(rgba, m, W, H):
    """Place a layer bitmap into comp space, over its bounding box only.

    Region of interest is not an optimisation detail here, it is the difference
    between a 200px badge costing 200px of work and costing a 4K frame of work on
    every one of 240 frames. warpAffine writes into the clipped box and the box
    remembers where it came from.

    Premultiply/unpremultiply around the resample for the same halo reason as
    everywhere else.
    """
    h, w = rgba.shape[:2]
    if interp.is_identity(m) and (w, h) == (W, H):
        return Tile(rgba, 0, 0)
    corners = interp.apply_matrix(m, [[0, 0], [w, 0], [w, h], [0, h]])
    x0 = max(0, int(math.floor(corners[:, 0].min())) - 1)
    y0 = max(0, int(math.floor(corners[:, 1].min())) - 1)
    x1 = min(W, int(math.ceil(corners[:, 0].max())) + 1)
    y1 = min(H, int(math.ceil(corners[:, 1].max())) + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    local = np.array(m, dtype=np.float64, copy=True)
    local[0, 2] -= x0
    local[1, 2] -= y0
    warped = cv2.warpAffine(_premul(rgba), local[:2], (x1 - x0, y1 - y0),
                            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                            borderValue=(0.0, 0.0, 0.0, 0.0))
    return Tile(_unpremul(np.asarray(warped, dtype=np.float32), inplace=True), x0, y0)


def _tile_region(tile, x0, y0, x1, y1):
    """A tile's pixels over an arbitrary box, zero (= transparent) outside it."""
    out = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.float32)
    if tile is None:
        return out
    th, tw = tile.rgba.shape[:2]
    sx0, sy0 = max(x0, tile.x), max(y0, tile.y)
    sx1, sy1 = min(x1, tile.x + tw), min(y1, tile.y + th)
    if sx1 <= sx0 or sy1 <= sy0:
        return out
    out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = \
        tile.rgba[sy0 - tile.y:sy1 - tile.y, sx0 - tile.x:sx1 - tile.x]
    return out


def _average_tiles(tiles):
    """Mean of several sub-time renders of one layer — the motion blur itself.

    Averaged PREMULTIPLIED: a straight-alpha mean of an opaque red pixel and a
    fully transparent one whose colour happens to be black gives half-alpha dark
    red, when the answer is half-alpha red.
    """
    tiles = [t for t in tiles if t is not None]
    if not tiles:
        return None
    if len(tiles) == 1:
        return tiles[0]
    x0 = min(t.x for t in tiles)
    y0 = min(t.y for t in tiles)
    x1 = max(t.x + t.rgba.shape[1] for t in tiles)
    y1 = max(t.y + t.rgba.shape[0] for t in tiles)
    acc = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.float32)
    for t in tiles:
        h, w = t.rgba.shape[:2]
        acc[t.y - y0:t.y - y0 + h, t.x - x0:t.x - x0 + w] += _premul(t.rgba)
    acc /= float(len(tiles))
    return Tile(_unpremul(acc, inplace=True), x0, y0)


def _blur_times(comp, layer, t, draft):
    """Sub-times to sample for motion blur, or just [t] when it is off.

    The shutter angle is degrees of a 360-degree rotary shutter, so 180 means the
    frame is exposed for half its duration. Midpoint sampling rather than
    endpoint: N samples spread evenly INSIDE the window, so no sample sits on the
    boundary and gets double-weighted by the neighbouring frame.
    """
    mb = comp.get("motionBlur") or {}
    if draft or not mb.get("enabled") or not layer.get("motionBlur"):
        return [t]
    samples = int(_f(mb.get("samples"), 8.0))
    samples = max(1, min(64, samples))
    if samples == 1:
        return [t]
    fps = _f(comp.get("fps"), 30.0) or 30.0
    window = (_f(mb.get("shutter"), 180.0) / 360.0) / fps
    if window <= 0:
        return [t]
    return [t - window / 2.0 + window * (i + 0.5) / samples for i in range(samples)]


def _layer_tile(comp, layer, t, scale, draft, size, by_id, apply_fx=True):
    """One layer at one instant, in comp space: effects, masks, transform, opacity.

    That order is the contract and it is also AE's: the effect stack sees the
    layer at its own resolution before any transform has resampled it, which is
    why a blur radius means the same thing whatever the layer is scaled to.
    """
    W, H = size
    px = _layer_pixels(comp, layer, t, scale, size)
    if px is None:
        return None
    if apply_fx and effects is not None and (layer.get("effects") or []):
        # _layer_pixels can hand back a CACHED array (a still, a text raster).
        # The effects contract says not to mutate its input, but one effect that
        # does would poison that cache for every later frame — a copy here is far
        # cheaper than debugging that.
        px = _apply_effects(px.copy(), comp, layer, t, scale, draft,
                            (px.shape[1], px.shape[0]))

    mask = _mask_alpha(layer, t, px.shape[1], px.shape[0], scale)
    if mask is not None:
        px = px.copy()
        px[..., 3] *= mask

    cw, ch = int(comp.get("width") or 1920), int(comp.get("height") or 1080)

    def defaults(lay):
        lw, lh = _layer_native_size(comp, lay)
        return (lw / 2.0, lh / 2.0), (cw / 2.0, ch / 2.0)

    m = interp.world_matrix(layer, by_id, t, defaults=defaults)
    tile = _warp(px, interp.scale_matrix(m, scale), W, H)
    if tile is None:
        return None

    transform = layer.get("transform") or {}
    op = interp.eval_prop(transform.get("opacity"), t,
                          interp.eval_prop(layer.get("opacity"), t, 100.0))
    op = max(0.0, min(1.0, _f(op, 100.0) / 100.0))
    if op < 1.0 - 1e-6:
        if op <= 0.0:
            return None
        rgba = tile.rgba.copy()
        rgba[..., 3] *= op
        tile = Tile(rgba, tile.x, tile.y)
    return tile


def _layer_tile_blurred(comp, layer, t, scale, draft, size, by_id, apply_fx=True):
    times = _blur_times(comp, layer, t, draft)
    if len(times) == 1:
        return _layer_tile(comp, layer, times[0], scale, draft, size, by_id, apply_fx)
    return _average_tiles([_layer_tile(comp, layer, st, scale, draft, size, by_id, apply_fx)
                           for st in times])


def _matte_factor(matte_rgba, kind):
    """AE's four matte flavours, as a 0..1 multiplier on the layer's alpha."""
    kind = str(kind or "alpha").lower()
    a = matte_rgba[..., 3:4]
    if kind.startswith("luma"):
        # transparent parts of a luma matte read as black, which is what makes a
        # white shape on nothing behave the way everyone expects
        v = (matte_rgba[..., :3] * _LUMA_W).sum(axis=-1, keepdims=True) * a
    else:
        v = a
    return 1.0 - v if kind.endswith("inv") else v


def render_frame(comp, t, scale=1.0, draft=False, size=None):
    """The comp at time t as float32 (H, W, 4) straight-alpha RGBA."""
    cw = max(1, int(comp.get("width") or 1920))
    ch = max(1, int(comp.get("height") or 1080))
    scale = max(0.01, min(4.0, float(scale)))
    if size:
        W, H = max(1, int(size[0])), max(1, int(size[1]))
        scale = W / float(cw)
    else:
        W, H = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    size = (W, H)

    acc = np.empty((H, W, 4), dtype=np.float32)
    acc[:] = _rgba01(comp.get("bg"), (0.0, 0.0, 0.0, 0.0))

    layers = [l for l in (comp.get("layers") or []) if isinstance(l, dict)]
    by_id = {l.get("id"): l for l in layers if l.get("id")}
    solo_on = any(l.get("solo") for l in layers)

    # A matte layer is consumed by the layer below it and never painted itself —
    # and that holds whatever its own visibility switch says, because AE turns
    # that switch off for you the moment you assign a matte.
    consumed = set()
    for i, lay in enumerate(layers):
        if isinstance(lay.get("trackMatte"), dict) and i > 0:
            consumed.add(i - 1)

    def visible(lay):
        if solo_on:
            return bool(lay.get("solo"))
        return lay.get("enabled", True) is not False

    def in_window(lay):
        start = _f(lay.get("start"), 0.0)
        end = _f(lay.get("end"), _f(comp.get("duration"), 0.0))
        return (t >= start - EPS) and (t < end - EPS)

    # layers[0] paints LAST — walk the stack from the bottom up
    for i in range(len(layers) - 1, -1, -1):
        lay = layers[i]
        if i in consumed:
            continue
        kind = str(lay.get("type") or "image")
        if kind == "null" or not visible(lay) or not in_window(lay):
            continue

        matte_spec = lay.get("trackMatte") if isinstance(lay.get("trackMatte"), dict) else None
        matte_tile = None
        if matte_spec and i > 0:
            matte_tile = _layer_tile_blurred(comp, layers[i - 1], t, scale, draft, size, by_id)

        if kind == "adjustment":
            # An adjustment layer's own pixels are only a region; the effects run
            # on everything already accumulated beneath it. Full-frame rather than
            # ROI-only so a blur inside the region still samples what surrounds it.
            region = _layer_tile_blurred(comp, lay, t, scale, draft, size, by_id, apply_fx=False)
            if region is None:
                continue
            cover = _tile_region(region, 0, 0, W, H)[..., 3:4]
            if matte_tile is not None:
                cover = cover * _matte_factor(_tile_region(matte_tile, 0, 0, W, H),
                                              str(matte_spec.get("type") or "alpha"))
            processed = _apply_effects(acc.copy(), comp, lay, t, scale, draft, size)
            acc *= (1.0 - cover)
            acc += processed * cover
            continue

        tile = _layer_tile_blurred(comp, lay, t, scale, draft, size, by_id)
        if tile is None:
            continue
        if matte_tile is not None:
            h, w = tile.rgba.shape[:2]
            factor = _matte_factor(
                _tile_region(matte_tile, tile.x, tile.y, tile.x + w, tile.y + h),
                str(matte_spec.get("type") or "alpha"))
            rgba = tile.rgba.copy()
            rgba[..., 3:4] *= factor
            tile = Tile(rgba, tile.x, tile.y)
        elif matte_spec:
            # a matte was asked for and there is no layer above to be one; AE
            # shows nothing rather than quietly ignoring the switch
            continue
        _over(acc, tile, str(lay.get("blend") or "normal"))

    # in place: acc is ours and a spare 1080p float32 copy per frame is 33 MB of
    # nothing
    return np.clip(acc, 0.0, 1.0, out=acc)


def to_uint8(rgba):
    return (np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


# ── CLI modes ─────────────────────────────────────────────────────────────────

_NVENC = None

# NVENC refuses frames below roughly 145x49 — it is a hardware limit, not a
# setting. A 128px comp picking "auto" would otherwise open the encoder, fail on
# frame one, and lose the render. Ask for a little more than the documented floor.
NVENC_MIN = (160, 64)


def _nvenc_available():
    """Whether h264_nvenc actually encodes here, not merely whether ffmpeg lists it.

    A build can carry the encoder with no driver or no GPU behind it, and the
    failure only surfaces on the first frame — by which time a render has already
    reported success in starting. One throwaway frame settles it up front, at a
    size NVENC will accept (see NVENC_MIN: probe too small and this answers "no"
    on a machine that is perfectly capable).
    """
    global _NVENC
    if _NVENC is not None:
        return _NVENC
    _NVENC = False
    try:
        import io as _io
        c = av.open(_io.BytesIO(), "w", format="mp4")
        s = c.add_stream("h264_nvenc", rate=30)
        s.width, s.height, s.pix_fmt = 256, 256, "yuv420p"
        frame = av.VideoFrame.from_ndarray(np.zeros((256, 256, 3), np.uint8), format="rgb24")
        frame.pts = 0
        for pkt in s.encode(frame):
            c.mux(pkt)
        for pkt in s.encode(None):
            c.mux(pkt)
        c.close()
        _NVENC = True
    except Exception:                                  # noqa: BLE001
        _NVENC = False
    return _NVENC


def cmd_frame(job):
    comp = job.get("comp") or {}
    t = _f(job.get("t"), 0.0)
    out = job["out"]
    began = time.time()
    rgba = render_frame(comp, t, scale=_f(job.get("scale"), 1.0) or 1.0,
                        draft=bool(job.get("draft")))
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    Image.fromarray(to_uint8(rgba), "RGBA").save(out)
    return {"ok": True, "out": out, "width": int(rgba.shape[1]), "height": int(rgba.shape[0]),
            "ms": int((time.time() - began) * 1000)}


def _open_movie(path, fmt, W, H, fps, crf, codec):
    """Container + video stream, told plainly what it is being asked to hold."""
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    rate = Fraction(fps).limit_denominator(60000)
    container = av.open(path, "w")
    if fmt == "mov":
        # qtrle is lossless RLE with an alpha channel — the reason "mov" exists in
        # this list at all is to hand back a comp with its transparency intact
        stream = container.add_stream("qtrle", rate=rate)
        stream.pix_fmt = "argb"
    else:
        name = codec
        if name in ("auto", "", None):
            big_enough = W >= NVENC_MIN[0] and H >= NVENC_MIN[1]
            name = "h264_nvenc" if (big_enough and _nvenc_available()) else "libx264"
        stream = container.add_stream(name, rate=rate)
        stream.pix_fmt = "yuv420p"
        if "nvenc" in name:
            # nvenc has no CRF; cq is its constant-quality dial and reads on the
            # same 0-51 scale, so the number in the job means the same thing
            stream.options = {"rc": "vbr", "cq": str(int(crf)), "preset": "p5", "b": "0"}
        else:
            stream.options = {"crf": str(int(crf)), "preset": "medium"}
    stream.width, stream.height = W, H
    stream.time_base = Fraction(1, 1) / rate
    return container, stream


def cmd_render(job):
    comp = job.get("comp") or {}
    out = job["out"]
    fmt = str(job.get("format") or "mp4").lower()
    fps = _f(comp.get("fps"), 30.0) or 30.0
    duration = _f(comp.get("duration"), 0.0)
    t0 = _f(job.get("from"), 0.0)
    t1 = _f(job.get("to"), duration) if job.get("to") is not None else duration
    if t1 <= t0:
        raise ValueError(f"empty range: from {t0} to {t1}")
    scale = _f(job.get("scale"), 1.0) or 1.0
    draft = bool(job.get("draft"))
    every = int(_f(job.get("progressEvery"), 10.0))

    cw = max(1, int(comp.get("width") or 1920))
    ch = max(1, int(comp.get("height") or 1080))
    W = max(2, int(round(cw * scale)))
    H = max(2, int(round(ch * scale)))
    if fmt == "mp4":
        # yuv420p subsamples chroma by two; an odd dimension has nowhere to put
        # the last row and h264 refuses the stream outright
        W -= W % 2
        H -= H % 2

    n_frames = max(1, int(round((t1 - t0) * fps)))
    began = time.time()

    container = stream = None
    seq_dir = None
    if fmt == "png":
        # a sequence is a directory of numbered frames; if the job named a .png
        # the directory it sits in is what was meant
        seq_dir = out if not out.lower().endswith(".png") else os.path.dirname(os.path.abspath(out))
        os.makedirs(seq_dir, exist_ok=True)
    else:
        container, stream = _open_movie(out, fmt, W, H, fps, _f(job.get("crf"), 18.0),
                                        job.get("codec") or "auto")

    for n in range(n_frames):
        t = t0 + n / fps
        rgba = render_frame(comp, t, scale=scale, draft=draft, size=(W, H))
        if seq_dir is not None:
            Image.fromarray(to_uint8(rgba), "RGBA").save(os.path.join(seq_dir, f"{n:05d}.png"))
        else:
            u8 = to_uint8(rgba)
            if fmt == "mov":
                frame = av.VideoFrame.from_ndarray(u8, format="rgba")
            else:
                # flatten onto the comp's own background: straight alpha times its
                # coverage, which for the default transparent bg is black
                frame = av.VideoFrame.from_ndarray(
                    to_uint8(rgba[..., :3] * rgba[..., 3:4]), format="rgb24")
            # pts only: setting a frame's own time_base makes the mp4 muxer
            # reject the packet outright (EINVAL), and the stream's is enough
            frame.pts = n
            for pkt in stream.encode(frame):
                container.mux(pkt)
        if every > 0 and (n % every == 0) and n:
            print(json.dumps({"progress": round(n / n_frames, 4), "frame": n}), flush=True)

    if container is not None:
        for pkt in stream.encode(None):
            container.mux(pkt)
        container.close()

    return {"ok": True, "out": seq_dir or out, "frames": n_frames,
            "seconds": round(n_frames / fps, 4), "ms": int((time.time() - began) * 1000)}


def _probe_one(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        with Image.open(path) as im:
            return {"path": path, "kind": "image", "width": im.width, "height": im.height,
                    "duration": None, "fps": None}
    c = av.open(path)
    try:
        if c.streams.video:
            st = c.streams.video[0]
            rate = st.average_rate or st.guessed_rate
            dur = None
            if st.duration is not None and st.time_base:
                dur = float(st.duration * st.time_base)
            elif c.duration is not None:
                dur = float(c.duration) / av.time_base
            return {"path": path, "kind": "video",
                    "width": int(st.codec_context.width or 0),
                    "height": int(st.codec_context.height or 0),
                    "duration": round(dur, 4) if dur else None,
                    "fps": round(float(rate), 4) if rate else None}
        if c.streams.audio:
            dur = float(c.duration) / av.time_base if c.duration is not None else None
            return {"path": path, "kind": "audio", "width": None, "height": None,
                    "duration": round(dur, 4) if dur else None, "fps": None}
    finally:
        c.close()
    raise ValueError("no video or audio stream")


def cmd_probe(job):
    out = []
    for path in job.get("sources") or []:
        try:
            out.append(_probe_one(path))
        except Exception as exc:                       # noqa: BLE001
            # One unreadable source must not hide the answer for the other nine —
            # the caller is usually asking "which of these can I use".
            out.append({"path": path, "kind": "unknown", "error": str(exc)})
    return {"ok": True, "sources": out}


MODES = {"frame": cmd_frame, "render": cmd_render, "probe": cmd_probe}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) < 2:
            raise ValueError("usage: engine.py <frame|render|probe> <job.json>")
        mode, job_path = argv[0], argv[1]
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode}")
        with open(job_path, encoding="utf-8") as fh:
            job = json.load(fh)
        result = MODES[mode](job)
    except Exception as exc:                           # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
