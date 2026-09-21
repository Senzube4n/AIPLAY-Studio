"""Image adjustments and vectorization - the editing engine behind the Images
screen AND the MCP tools. One implementation: the browser only PREVIEWS with
CSS approximations; every committed edit renders here, so the UI and an agent
produce identical pixels.

Usage:
  python imagetools.py edit <job.json>
      job: { "in": path, "out": path, "thumbOut": path|null, "thumbSize": 256,
             # ops.styles: Photoshop's ten layer styles, stage 9b
             "maskOut": path|null,   # the resolved selection, as a grayscale plate
             "ops": { brightness, contrast, saturation, gamma, temperature,
                      sharpen, blur, vignette, rotate, flipH, flipV } }
      All ops optional. brightness/contrast/saturation: 100 = unchanged
      (range ~0..200). gamma: 1.0 unchanged (0.2..3). temperature: -100..100
      (cold..warm). sharpen: 0..100. blur: 0..20 px. vignette: 0..100.
      rotate: 0|90|180|270. flipH/flipV: bool.

  python imagetools.py vectorize <job.json>
      job: { "in": path, "out": svg path, "colors": 6, "detail": 1.0,
             "minArea": 16 }
      Posterizes to N colors and traces each layer with OpenCV contours
      (Douglas-Peucker simplified). Made for LOGOS and flat art - photographs
      come out as posterized art, which is honest for what an SVG is.

Prints one JSON line: { ok, out, [width, height | paths, colors] }.
"""
import json
import sys

import os

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

_HERE = os.path.dirname(os.path.abspath(__file__))


def _keys_or_refuse(d, allowed, op):
    """Unknown keys in a dict-shaped op are an ERROR naming the real keys.

    The surface's stated rule is "a guessed name is refused" — and resize
    {width, height} was accepted and IGNORED (the real keys are w/h), which is
    how a crop+resize call returned a full-size file with no note. Same
    pattern for the other inline dict ops; delegated ops (photo, effects,
    strokes, paths, shapes, text, selection, canvas, geometry, liquify) have
    their own validators in their modules.
    """
    if not isinstance(d, dict):
        return d
    bad = [k for k in d if k not in allowed]
    if bad:
        raise ValueError(
            f'{op} has no key "{bad[0]}". It takes: {", ".join(allowed)}.')
    return d


def _selection_mask(ops, im):
    """The selection, resolved at stage 4 — after geometry, before any edit.

    Returns (mask, None) or (None, error). None means "the whole frame", which
    is the mask of ones written the cheap way: every caller then treats "no
    selection" and "a selection" through the same path, so the no-selection
    case cannot drift.

    imgselect.resolve() never raises — it collects warnings, because one
    malformed shape in a list of forty should not lose the other thirty-nine.
    But §3 requires a wand seed outside the image to be an ERROR, and the
    module cannot raise it, so converting the warning is this column's job.
    Without this the requirement is simply unmet.
    """
    sel = ops.get("selection")
    if not sel or not isinstance(sel, dict):
        return None, None
    try:
        import imgselect                                # noqa: PLC0415
    except Exception as exc:                            # noqa: BLE001
        return None, f"selections are unavailable: {exc}"

    rgba = np.asarray(im).astype(np.float32) / 255.0
    warn = []
    try:
        mask = imgselect.resolve(sel, rgba, warn)
    except Exception as exc:                            # noqa: BLE001
        return None, f"the selection could not be resolved: {exc}"

    # A seed that lands outside the frame is a caller bug, and silently
    # selecting nothing would look like the wand simply failed.
    for w in warn:
        if "seed" in str(w).lower() or "outside" in str(w).lower() or "bounds" in str(w).lower():
            return None, str(w)
    return mask, None


def _effects_registry():
    """The compositor's effect registry, or None if it is not importable.

    Same guarded shape engine.py uses: a missing registry means "no effects",
    never "no image". It lives under server/vfx/ and this file is server/, so
    the path goes on sys.path rather than the package being restructured for
    one import.
    """
    vfx = os.path.join(_HERE, "vfx")
    if vfx not in sys.path:
        sys.path.insert(0, vfx)
    try:
        import effects                                  # noqa: PLC0415
        return effects
    except Exception:                                   # noqa: BLE001
        return None


# Effects that read a TIMELINE — frame history (echo, timeDifference,
# posterizeTime) or the clock itself (particleSystem: its birth integral is
# zero at t=0, so a still gets identity pixels). A still has neither, so these
# return their input. Listed rather than hidden: asking for echo on a
# photograph should say why it did nothing, not imply the name was wrong.
#
# The LIVE list is read off the catalog's own needsHistory/needsTimeline flags
# (timeline_effects, below), so an effect added on the other side cannot be
# silently missed here; this tuple is the registry-less fallback and the
# documented base set.
TIMELINE_EFFECTS = ("echo", "timeDifference", "posterizeTime", "particleSystem")


def timeline_effects(fx=None):
    """The effect names a STILL cannot honour, from the registry's own
    needsHistory/needsTimeline declarations. imgdoc reads this too — one
    answer for every still pipeline."""
    fx = fx if fx is not None else _effects_registry()
    if fx is None:
        return set(TIMELINE_EFFECTS)
    return {n for n, e in fx.CATALOG.items()
            if e.get("needsHistory") or e.get("needsTimeline")}


def apply_effects(im, specs, mask=None, notes=None):
    """Run a list of {type, params} over a PIL RGBA image, §4.

    `mask` is a float32 (H, W) 0..1 array, or None for the whole frame. Each
    effect computes its full result and is then blended through the mask.
    apply_edit deliberately passes None — its ONE selection blend at the end
    of stages 5-8 clips effects with the same code that clips everything
    else, and a mask here as well would apply a feathered selection twice.
    The parameter stays for callers that composite effects locally themselves.

    `notes` is the honesty channel: a list the effects may append a compromise
    to (effects.py's _note). Pass the job's notes list to surface them.
    """
    fx = _effects_registry()
    if fx is None or not specs:
        return im, []

    rgba = np.asarray(im).astype(np.float32) / 255.0
    m = None
    if mask is not None:
        m = np.clip(np.asarray(mask, dtype=np.float32), 0.0, 1.0)
        if m.shape[:2] != rgba.shape[:2]:
            raise ValueError(
                f"the selection is {m.shape[1]}x{m.shape[0]} but the image is "
                f"{rgba.shape[1]}x{rgba.shape[0]} — it is resolved after geometry, "
                "so it must match the frame the effects see")
        m = m[..., None]

    # A still has no history. The callable shape is what the compositor passes,
    # so the contract is identical and effects.py needs no special case. Both
    # "t" and "time" are set: the effects read ctx.get("t") (imgdoc's ctx
    # carries both), and setting only "time" was a drift the animated params
    # silently rode — their phase terms read 0.0 by fallback, correctly, but
    # by accident.
    ctx = {"history": lambda n=1: [], "t": 0.0, "time": 0.0, "fps": 1.0,
           "draft": False,
           "notes": notes if isinstance(notes, list) else []}

    timeline = timeline_effects(fx)
    skipped = []
    for spec in specs:
        name = str((spec or {}).get("type") or "")
        if not name or name not in fx.CATALOG:
            raise ValueError(
                f'No effect called "{name}". '
                f"There are {len(fx.CATALOG)}; the catalog lists them.")
        if name in timeline:
            skipped.append(name)
            continue
        before = rgba
        out = fx.apply(name, rgba.copy(), (spec or {}).get("params") or {}, ctx)
        if not isinstance(out, np.ndarray) or out.shape != rgba.shape:
            continue                                    # an effect that refused
        rgba = out if m is None else (out * m + before * (1.0 - m))

    rgba = np.clip(rgba, 0.0, 1.0)
    return Image.fromarray((rgba * 255.0 + 0.5).astype(np.uint8), "RGBA"), skipped





def _to_rgba(im):
    return np.asarray(im).astype(np.float32) / 255.0


def _from_rgba(a):
    return Image.fromarray((np.clip(a, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGBA")


def adjust(im, ops):
    """Stages 5's twenty-five adjustments, on a PIL RGBA image.

    Lifted out of apply_edit unchanged so that something holding PIXELS rather
    than a file path can run them — an adjustment layer in a document, most
    obviously. apply_edit still calls this and nothing else changed, which is
    the point: one implementation, no drift.
    """
    # enhancers must not touch transparency — split it off, work on RGB
    alpha_ch = im.getchannel("A")
    work = im.convert("RGB")

    # ── tone first: auto-levels, then curves — the professional order ──
    if ops.get("autoLevels"):
        a = np.asarray(work).astype(np.float32)
        for c in range(3):
            lo, hi = np.percentile(a[..., c], [0.3, 99.7])
            if hi - lo > 1:
                a[..., c] = (a[..., c] - lo) * (255.0 / (hi - lo))
        work = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

    # Levels: where black starts, where white clips, and where the midtone
    # sits between them. Curves can express this, but nobody reaches for a
    # curve to fix a flat scan — they drag the black point.
    lv = ops.get("levels")
    if lv:
        _keys_or_refuse(lv, ("master", "r", "g", "b"), "levels")
        a = np.asarray(work).astype(np.float32)
        for ch, key in ((None, "master"), (0, "r"), (1, "g"), (2, "b")):
            adj = lv.get(key)
            if not isinstance(adj, dict):
                continue
            _keys_or_refuse(adj, ("black", "white", "gamma", "outBlack", "outWhite"),
                            f"levels.{key}")
            lo = float(adj.get("black", 0)); hi = float(adj.get("white", 255))
            mid = max(0.05, min(9.99, float(adj.get("gamma", 1.0))))
            if hi - lo < 1:
                continue
            sl = slice(None) if ch is None else ch
            v = np.clip((a[..., sl] - lo) / (hi - lo), 0, 1)
            if abs(mid - 1.0) > 0.001:
                v = np.power(v, 1.0 / mid)
            out_lo = float(adj.get("outBlack", 0)); out_hi = float(adj.get("outWhite", 255))
            a[..., sl] = out_lo + v * (out_hi - out_lo)
        work = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

    curves = ops.get("curves")
    if curves:
        _keys_or_refuse(curves, ("master", "r", "g", "b"), "curves")
        from scipy.interpolate import PchipInterpolator

        def lut_for(points):
            pts = sorted({int(max(0, min(255, p[0]))): max(0, min(255, float(p[1])))
                          for p in points if len(p) == 2}.items())
            if len(pts) < 2:
                return None
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            if xs[0] > 0:
                xs.insert(0, 0); ys.insert(0, ys[0])
            if xs[-1] < 255:
                xs.append(255); ys.append(ys[-1])
            f = PchipInterpolator(xs, ys)     # monotone cubic — no ringing
            return np.clip(f(np.arange(256)), 0, 255).astype(np.uint8)

        a = np.asarray(work).copy()
        master = lut_for(curves.get("master") or [])
        if master is not None:
            a = master[a]
        for ch, key in enumerate(("r", "g", "b")):
            lut = lut_for(curves.get(key) or [])
            if lut is not None:
                a[..., ch] = lut[a[..., ch]]
        work = Image.fromarray(a)

    # ── shadows / highlights recovery: luminance-masked lift and pull ──
    sh_amt = float(ops.get("shadows") or 0.0)
    hi_amt = float(ops.get("highlights") or 0.0)
    if abs(sh_amt) > 0.5 or abs(hi_amt) > 0.5:
        a = np.asarray(work).astype(np.float32) / 255.0
        luma = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        if abs(sh_amt) > 0.5:
            m = np.clip(1.0 - luma / 0.5, 0, 1) ** 2       # strongest in the darks
            a += (np.power(a, 0.6) - a) * (sh_amt / 100.0) * m[..., None]
        if abs(hi_amt) > 0.5:
            m = np.clip((luma - 0.5) / 0.5, 0, 1) ** 2     # strongest in the lights
            a += (np.power(a, 1.6) - a) * (hi_amt / 100.0) * m[..., None]
        work = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))

    # ── HSL per color band: the panel photographers live in ──
    hsl = ops.get("hsl")
    if hsl:
        import colorsys  # noqa: F401  (documented intent; math below is vectorized)
        BANDS = { "reds": 0, "yellows": 60, "greens": 120, "cyans": 180, "blues": 240, "magentas": 300 }
        _keys_or_refuse(hsl, tuple(BANDS), "hsl")
        for _band, _adj in hsl.items():
            _keys_or_refuse(_adj, ("h", "s", "l"), f"hsl.{_band}")
        hsv = np.asarray(work.convert("HSV")).astype(np.float32)
        H, S, V = hsv[..., 0] * (360.0 / 255.0), hsv[..., 1] / 255.0, hsv[..., 2] / 255.0
        for band, adj in hsl.items():
            center = BANDS.get(band)
            if center is None or not isinstance(adj, dict):
                continue
            d = np.abs(((H - center + 180) % 360) - 180)
            w8 = np.clip(1.0 - d / 45.0, 0, 1)             # 45-degree feathered band
            w8 = w8 * np.clip(S * 4, 0, 1)                 # gray pixels belong to no band
            if abs(float(adj.get("h") or 0)) > 0.01:
                H = (H + float(adj["h"]) * w8) % 360
            if abs(float(adj.get("s") or 0)) > 0.01:
                S = np.clip(S * (1 + (float(adj["s"]) / 100.0) * w8), 0, 1)
            if abs(float(adj.get("l") or 0)) > 0.01:
                V = np.clip(V * (1 + (float(adj["l"]) / 100.0) * 0.6 * w8), 0, 1)
        out = np.stack([H * (255.0 / 360.0), S * 255.0, V * 255.0], axis=-1)
        work = Image.fromarray(out.astype(np.uint8), "HSV").convert("RGB")

    def enh(cls, key):
        nonlocal work
        v = ops.get(key)
        if v is not None and abs(float(v) - 100.0) > 0.01:
            work = cls(work).enhance(max(0.0, float(v) / 100.0))
    enh(ImageEnhance.Brightness, "brightness")
    enh(ImageEnhance.Contrast, "contrast")
    enh(ImageEnhance.Color, "saturation")

    im = Image.merge("RGBA", (*work.split(), alpha_ch))

    g = float(ops.get("gamma") or 1.0)
    t = float(ops.get("temperature") or 0.0)
    vg = float(ops.get("vignette") or 0.0)
    ck = ops.get("chromaKey")
    if ck:
        _keys_or_refuse(ck, ("color", "tolerance", "softness"), "chromaKey")
    if abs(g - 1.0) > 0.001 or abs(t) > 0.01 or vg > 0.01 or ck:
        a = np.asarray(im).astype(np.float32) / 255.0
        rgb, alpha = a[..., :3].copy(), a[..., 3:4].copy()
        if abs(g - 1.0) > 0.001:
            rgb = np.power(np.clip(rgb, 0, 1), 1.0 / max(0.2, min(3.0, g)))
        if abs(t) > 0.01:
            # warm shifts red up / blue down; cold the reverse. Gentle: full
            # slider is a +-12% channel swing, not an Instagram accident.
            k = (t / 100.0) * 0.12
            rgb[..., 0] = rgb[..., 0] * (1 + k)
            rgb[..., 2] = rgb[..., 2] * (1 - k)
        if vg > 0.01:
            h, w = rgb.shape[:2]
            yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
            cx, cy = (w - 1) / 2, (h - 1) / 2
            d = np.sqrt(((xx - cx) / (w / 2)) ** 2 + ((yy - cy) / (h / 2)) ** 2) / np.sqrt(2)
            fall = 1.0 - (vg / 100.0) * np.clip(d, 0, 1) ** 2
            rgb *= fall[..., None]
        if ck and ck.get("color"):
            # the greenscreen: distance to the key color in a luma-discounted
            # space; inside tolerance = transparent, a softness band feathers
            # the edge instead of cutting a halo
            key = np.array([c / 255.0 for c in ck["color"][:3]], dtype=np.float32)
            tol = max(0.01, float(ck.get("tolerance") or 25) / 100.0) * 0.75
            soft = max(0.001, float(ck.get("softness") or 10) / 100.0) * 0.5
            dist = np.sqrt(((rgb - key) ** 2).sum(axis=-1))
            keyed = np.clip((dist - tol) / soft, 0.0, 1.0)[..., None]
            alpha = alpha * keyed
            # despill: pull the key hue out of half-transparent edge pixels
            edge = ((keyed > 0) & (keyed < 1))[..., 0]
            if edge.any():
                dom = int(np.argmax(key))
                others = [i for i in range(3) if i != dom]
                cap = np.maximum(rgb[..., others[0]], rgb[..., others[1]])
                rgb[..., dom] = np.where(edge, np.minimum(rgb[..., dom], cap), rgb[..., dom])
        a = np.concatenate([rgb, alpha], axis=-1)
        im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "RGBA")

    # ── one-click looks ──
    if ops.get("grayscale") or ops.get("sepia"):
        alpha2 = im.getchannel("A")
        g8 = im.convert("L")
        if ops.get("sepia"):
            a = np.asarray(g8).astype(np.float32) / 255.0
            tinted = np.stack([a * 255 * 1.0, a * 240 * 0.89, a * 192 * 0.83], axis=-1)
            rgb8 = Image.fromarray(np.clip(tinted, 0, 255).astype(np.uint8))
        else:
            rgb8 = Image.merge("RGB", (g8, g8, g8))
        im = Image.merge("RGBA", (*rgb8.split(), alpha2))
    if ops.get("invert"):
        alpha2 = im.getchannel("A")
        from PIL import ImageOps
        im = Image.merge("RGBA", (*ImageOps.invert(im.convert("RGB")).split(), alpha2))
    pz = int(ops.get("posterize") or 0)
    if 2 <= pz <= 8:
        alpha2 = im.getchannel("A")
        from PIL import ImageOps
        # pz is LEVELS (what the UI and the tool schema promise); PIL takes
        # BITS. bit_length() doubled every request — 4 and 6 both became 3 bits
        # (8 levels) and rendered identically. (pz-1).bit_length() is the
        # levels->bits map: 2->1, 3..4->2, 5..8->3.
        bits = max(1, (pz - 1).bit_length())
        im = Image.merge("RGBA", (*ImageOps.posterize(im.convert("RGB"), bits).split(), alpha2))

    dn = float(ops.get("denoise") or 0.0)
    if dn > 0.5:
        import cv2
        alpha2 = im.getchannel("A")
        bgr = np.asarray(im.convert("RGB"))[..., ::-1].copy()
        h_par = 3 + (dn / 100.0) * 12
        out = cv2.fastNlMeansDenoisingColored(bgr, None, h_par, h_par, 7, 21)
        im = Image.merge("RGBA", (*Image.fromarray(out[..., ::-1]).split(), alpha2))

    sh = float(ops.get("sharpen") or 0.0)
    if sh > 0.01:
        im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=int(sh * 1.5), threshold=2))
    bl = float(ops.get("blur") or 0.0)
    if bl > 0.01:
        im = im.filter(ImageFilter.GaussianBlur(radius=min(20.0, bl)))

    gr = float(ops.get("grain") or 0.0)
    if gr > 0.5:
        a = np.asarray(im).astype(np.float32)
        rng = np.random.default_rng(int(ops.get("grainSeed") or 7))
        noise = rng.normal(0, (gr / 100.0) * 22, a.shape[:2])[..., None]
        a[..., :3] = np.clip(a[..., :3] + noise, 0, 255)
        im = Image.fromarray(a.astype(np.uint8), "RGBA")
    return im


def apply_ops(rgba, ops):
    """The same twenty-five, as a float32 (H, W, 4) 0..1 straight-alpha door.

    The adjustments are PIL-native (ImageEnhance, ImageFilter), so this
    converts rather than reimplements. Round-tripping through 8-bit costs a
    quantisation, which is what the adjustments were always doing anyway —
    apply_edit has quantised at exactly this point since it was written.
    """
    im = Image.fromarray((np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGBA")
    return np.asarray(adjust(im, ops or {})).astype(np.float32) / 255.0


def frame_stages(im, ops, notes):
    """Stages 1-3 — canvas, crop, geometry. THE COORDINATE SYSTEM ITSELF.

    ⚠ EVERY SELECTION IN THIS SYSTEM IS WRITTEN IN THE FRAME THESE PRODUCE.
    imagetools resolves one at stage 4, web/app.js's iedSrcToStage() writes its
    shapes post-crop and post-rotate, and IMAGE_SPEC §3 says "pixels AFTER any
    crop/rotate/flip in the same call". So a caller that resolves a selection
    against the RAW source is not slightly off — it is answering about a
    different picture, with the right numbers and no error on either side.

    describe_selection() did exactly that until this was lifted out of
    apply_edit. It lives here, in one place, rather than being copied: a second
    copy of a coordinate system is the same bug with a delay on it.
    """
    # ── stage 1: the canvas — the FRAME changes, not the content ──
    if ops.get("canvas"):
        import imgshape                                 # noqa: PLC0415
        im = _from_rgba(imgshape.apply_canvas(_to_rgba(im), ops["canvas"], notes))

    crop = ops.get("crop")
    if crop:
        _keys_or_refuse(crop, ("x", "y", "w", "h"), "crop")
        missing = [k for k in ("x", "y", "w", "h") if k not in crop]
        if missing:
            raise ValueError(
                f'crop needs x, y, w and h — missing {", ".join(missing)}.')
        x, y = max(0, int(crop["x"])), max(0, int(crop["y"]))
        w, h = int(crop["w"]), int(crop["h"])
        if w > 4 and h > 4:
            im = im.crop((x, y, min(im.width, x + w), min(im.height, y + h)))

    # ── stage 3: geometry ──
    #
    # ops.geometry supersedes the old top-level rotate/flipH/flipV, which only
    # ever did right angles. The old keys still arrive from the existing UI and
    # MCP tool, so they are folded in rather than broken — and an arbitrary
    # angle now works through either spelling.
    _geo = dict(ops.get("geometry") or {})
    for _old, _new in (("rotate", "rotate"), ("flipH", "flipH"), ("flipV", "flipV")):
        if ops.get(_old) and _new not in _geo:
            _geo[_new] = ops[_old]
    if _geo:
        import imgshape                                 # noqa: PLC0415
        im = _from_rgba(imgshape.apply_geometry(_to_rgba(im), _geo, notes))
    return im


def apply_edit(job):
    ops = job.get("ops") or {}
    # RGBA throughout: cutouts and chroma keys carry transparency, and an edit
    # pass must not flatten it
    im = Image.open(job["in"]).convert("RGBA")

    # ── stages 1-3: the frame. Shared with describe_selection so that what a
    # selection is measured against and what it is applied to cannot drift.
    _notes = []
    im = frame_stages(im, ops, _notes)

    # ── stage 4: the selection, resolved in post-geometry coordinates ──
    _mask, _sel_err = _selection_mask(ops, im)
    if _sel_err:
        raise ValueError(_sel_err)
    # What stages 5-8 will be blended back against. Captured here so a blur
    # inside a selection samples the ORIGINAL neighbourhood, which is what a
    # person means by it.
    _base = np.asarray(im).astype(np.float32) / 255.0 if _mask is not None else None

    # ── stage 5: the twenty-five adjustments (see adjust(), above) ──
    im = adjust(im, ops)

    # ── stage 5b: the photo-grade tools ──
    #
    # LAZY import, inside the branch: imgphoto imports effects, effects is
    # imported by this module, and a module-level import here closes that
    # cycle and stops the editor loading. Every stage below does the same.
    photo_specs = ops.get("photo")
    if photo_specs:
        try:
            import imgphoto                             # noqa: PLC0415
        except Exception as exc:                        # noqa: BLE001
            raise ValueError(f"the photo tools are unavailable: {exc}")
        rgba = _to_rgba(im)
        for spec in photo_specs:
            nm = str((spec or {}).get("type") or "")
            if nm not in imgphoto.CATALOG:
                raise ValueError(
                    f'No photo tool called "{nm}". '
                    f"There are {len(imgphoto.CATALOG)}: {', '.join(sorted(imgphoto.CATALOG))}.")
            rgba = imgphoto.apply(nm, rgba, (spec or {}).get("params") or {}, None)
        im = _from_rgba(rgba)

    # ── the shared effect registry, §4 — 88 of them, none reimplemented ──
    #
    # No mask passed down on purpose: the one blend below clips effects with
    # the same code that clips everything else in stages 5-8, and a mask here
    # as well would apply a feathered selection twice. `ops` deliberately
    # carries no key for it either — the old ops.get("_mask") was an
    # undocumented injectable no legitimate caller wrote, and an HTTP caller
    # could smuggle it in to double-mask; the schema-visible `selection` is
    # the only mask there is.
    fx_skipped = []
    fx_specs = ops.get("effects")
    if fx_specs:
        im, fx_skipped = apply_effects(im, fx_specs, notes=_notes)

    # ── stage 6d: clear — Delete, and the reason Ctrl+A had nothing to do ──
    #
    # ⚠ ZEROES ALPHA ON THE WHOLE FRAME AND LETS THE ONE BLEND CLIP IT. Resolving
    # the mask here instead would feather twice, for exactly the reason stage 7
    # gives below: a 50% rim would come out 25%. With a selection live the blend
    # restores _base outside it and the soft edge lands at alpha = 1 - coverage;
    # with no selection the blend does not run and the frame clears entirely,
    # which is what Delete does to a layer in Photoshop.
    #
    # ⚠ BEFORE THE BRUSH CLASS, NOT AFTER. A pipeline is stage order, not click
    # order: clearing after the strokes would delete a stroke queued in the same
    # Apply. "Empty this, then paint into it" is the useful reading.
    if ops.get("clear"):
        rgba = np.asarray(im).astype(np.float32) / 255.0
        rgba[..., 3] = 0.0
        im = Image.fromarray((rgba * 255.0 + 0.5).astype(np.uint8), "RGBA")
        _notes.append("cleared to transparency"
                      + (" inside the selection" if _mask is not None else " (no selection: the whole frame)"))

    # ── stage 7: the brush class ──
    #
    # No mask passed down on purpose: the blend below clips these with the same
    # code that clips the adjustments. Passing it here as well would apply a
    # feathered selection twice, turning a 50% rim into 25%.
    stroke_specs = ops.get("strokes")
    if stroke_specs:
        try:
            import imgstroke                            # noqa: PLC0415
        except Exception as exc:                        # noqa: BLE001
            raise ValueError(f"stroke tools are unavailable: {exc}")
        rgba = np.asarray(im).astype(np.float32) / 255.0
        rgba = imgstroke.apply_strokes(rgba, stroke_specs)
        im = Image.fromarray((np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGBA")

    # ── stage 7b: liquify, after the brush strokes ──
    #
    # Both write pixels, and warping what was just painted is the order a
    # person means. `freeze` is a SELECTION SPEC in the job and imgpath will
    # refuse it raw — deliberately, because a freeze mask that quietly does
    # nothing is a face warped after the user protected it.
    liq = ops.get("liquify")
    if liq:
        import imgpath                                 # noqa: PLC0415
        frz = None
        if ops.get("freeze"):
            import imgselect                           # noqa: PLC0415
            fw = []
            frz = imgselect.resolve(ops["freeze"], _to_rgba(im), fw)
            for w in fw:
                _notes.append(f"freeze: {w}")
        im = _from_rgba(imgpath.liquify(_to_rgba(im), liq, None,
                                        freeze=frz, notes=_notes))

    # ── stage 8: paths, beside the shapes ──
    if ops.get("paths"):
        import imgpath                                 # noqa: PLC0415
        im = _from_rgba(imgpath.apply_paths(_to_rgba(im), ops["paths"], None, _notes))

    # ── stage 8: shapes ──
    #
    # No mask passed down: the blend below clips these with the same code that
    # clips everything else in stages 5-8.
    if ops.get("shapes"):
        import imgshape                                 # noqa: PLC0415
        im = _from_rgba(imgshape.apply_shapes(_to_rgba(im), ops["shapes"], None, _notes))

    # ── the selection, applied ONCE to everything stages 5-8 did ──
    #
    # One blend rather than 25 adjustments each learning about masks: same
    # answer, 25 fewer chances to drift, and no adjustment can forget. Text
    # (stage 9) is deliberately outside it — a caption is placed, not painted
    # into a selection.
    if _mask is not None and _base is not None:
        import imgselect                                # noqa: PLC0415
        cur = np.asarray(im).astype(np.float32) / 255.0
        if cur.shape == _base.shape:
            out = np.clip(imgselect.blend(_base, cur, _mask), 0.0, 1.0)
            im = Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), "RGBA")

    # ── stage 9: the type tool ──
    #
    # Outside the selection blend on purpose: a caption is placed on top of a
    # picture, not painted into a selection.
    #
    # `ops.text` in the OLD shape (content/font/size/color/align/x/y/stroke)
    # is what the existing UI and MCP tool send, and both are other columns —
    # from_legacy translates it, and imgtext's own suite reads the legacy key
    # list out of THIS file and asserts the adapter covers every one.
    txt = ops.get("text")
    if txt and str(txt.get("content") or "").strip():
        try:
            import imgtext                              # noqa: PLC0415
        except Exception as exc:                        # noqa: BLE001
            raise ValueError(f"the type tool is unavailable: {exc}")
        spec = txt if txt.get("_v2") else imgtext.from_legacy(txt)
        rgba = np.asarray(im).astype(np.float32) / 255.0
        # ⚠ `_notes` IS NOT OPTIONAL HERE. draw_text folds its telemetry into
        # this list — a substituted font, a clamped variation axis, a line that
        # overflowed its box — and the reply already carries `notes` to the
        # caller. Called without it the whole channel is silent and the picture
        # comes back looking almost right.
        rgba = imgtext.draw_text(rgba, spec, notes=_notes)
        im = Image.fromarray((np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGBA")

    # ── stage 9b: layer styles, on a shape of their own ──
    #
    # ⚠ AFTER THE SELECTION BLEND, ON PURPOSE. A style paints OUTSIDE the shape
    # it decorates — that is what a drop shadow, an outer glow and an outside
    # stroke are — and the stage 5-8 blend clips everything back inside the
    # stage-4 selection. Run before it, the shadow would be silently erased with
    # both halves behaving correctly.
    #
    # ⚠ AND A STYLE NEEDS A SHAPE. A photograph is opaque everywhere, so every
    # style would either paint the whole frame or do nothing at all; imgstyles
    # refuses that case in a sentence rather than rendering a control that
    # appears to work. The shape comes from `selection`, from the picture's own
    # alpha on a cutout, or from the type and shapes drawn above.
    if ops.get("styles"):
        import imgstyles                                # noqa: PLC0415
        im = _from_rgba(imgstyles.apply_style_op(_to_rgba(im), ops["styles"], _notes))

    # ── channel matte: one plane of the RESULT as grayscale ──
    #
    # The Channels panel's "view R/G/B/A" rendered to pixels - Photoshop's
    # ctrl+3..6 as an export. After every stage above so it reads the channel
    # of what the edit produced, before resize so the grayscale is resampled
    # once like everything else. An unknown channel is an error, not a shrug:
    # a caller typing "alpha " must not receive their picture back unchanged.
    chan = ops.get("channel")
    if chan:
        _CHAN = {"r": 0, "red": 0, "g": 1, "green": 1, "b": 2, "blue": 2,
                 "a": 3, "alpha": 3}
        key = str(chan).strip().lower()
        rgba = np.asarray(im).astype(np.float32) / 255.0
        if key in _CHAN:
            plane = rgba[..., _CHAN[key]]
        elif key in ("luminosity", "luma", "l", "rgb", "composite"):
            plane = rgba[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32)
        else:
            raise ValueError(f'No channel called "{chan}". Channels are r, g, '
                             f'b, a, luminosity.')
        gray = np.empty_like(rgba)
        gray[..., 0] = gray[..., 1] = gray[..., 2] = np.clip(plane, 0.0, 1.0)
        gray[..., 3] = 1.0                     # the matte itself is opaque
        im = Image.fromarray((gray * 255.0 + 0.5).astype(np.uint8), "RGBA")

    rs = ops.get("resize")
    if rs:
        _keys_or_refuse(rs, ("w", "h"), "resize")
    if rs and int(rs.get("w") or 0) > 15 and int(rs.get("h") or 0) > 15:
        im = im.resize((min(8192, int(rs["w"])), min(8192, int(rs["h"]))), Image.LANCZOS)

    im.save(job["out"])

    # ── THE SELECTION, AS A PICTURE ────────────────────────────────────────
    #
    # imgdoc.py tells a caller to "bake the result into a library image and use
    # mask.src" for the kinds a document mask cannot rasterise — wand,
    # colorRange, path. This is that step. Written after `out` so it lands in
    # the same coordinates, and only when asked: a plate nobody wanted is a file
    # nobody deletes.
    if job.get("maskOut"):
        # ⚠ NO SELECTION IS EVERYTHING, NOT NOTHING. `_mask` is None when the
        # job carried none, and the rest of this function branches on that.
        # Skipping the write here would make "no selection" produce no file,
        # which reads as a failure rather than as the whole frame it means.
        _plate = np.ones((im.height, im.width), np.float32) if _mask is None else _mask
        _img = Image.fromarray(
            (np.clip(_plate, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "L")
        # ⚠ AND THE MASK IS IN PRE-RESIZE COORDINATES. Stage 4 resolves it
        # against the post-geometry image and the resize above happens later, so
        # a plate at the source size does not register against `out` — and
        # nothing downstream would say so: it would simply mask the wrong pixels.
        if _img.size != (im.width, im.height):
            _img = _img.resize((im.width, im.height), Image.LANCZOS)
        _img.convert("RGBA").save(job["maskOut"])
        _reply_mask = {"maskOut": job["maskOut"],
                       "coverage": float(np.clip(_plate, 0.0, 1.0).mean()),
                       "everything": _mask is None}
    else:
        _reply_mask = None

    if job.get("thumbOut"):
        th = im.copy()
        size = int(job.get("thumbSize") or 256)
        th.thumbnail((size, size), Image.LANCZOS)
        th.save(job["thumbOut"])
    # `notes` is how a stage reports a compromise it made — smartResize past
    # maxCarve genuinely becomes a plain resize, and says so. Dropping them
    # would turn an honest degradation into a silent one.
    _reply = {"ok": True, "out": job["out"], "width": im.width, "height": im.height}
    if _reply_mask:
        _reply.update(_reply_mask)
    if _notes:
        _reply["notes"] = _notes
    # An effect that needs a timeline does nothing to a still. apply_effects
    # already worked out which ones, and this used to drop the list — the
    # server knowing and not saying is the same silence the spec is written
    # against.
    if fx_skipped:
        _reply["fxSkipped"] = fx_skipped
    print(json.dumps(_reply))


# The guard engine.py uses for the same family of divisions (server/vfx/
# engine.py:355), copied by value rather than imported: imagetools cannot
# import from vfx without a cycle, and two columns holding different opinions
# about where zero starts would put a seam down the middle of one mode —
# colordodge lives there, vividLight's burn half lives here, and they are the
# same arithmetic.
_EPS = 1e-6

# W3C compositing-1's Lum weights, which are engine.py's _LUMA_W and NOT the
# (0.299, 0.587, 0.114) the greyscale channel extractor above uses. The two
# whole-pixel modes are the twins of `color` and `luminosity`, which are
# defined on Lum; handing them the video triple instead would make neighbouring
# modes disagree about which of two nearly equal pixels is the darker one, and
# that disagreement has no symptom except a pixel that took the wrong layer.
_LUMA_W = np.array([0.30, 0.59, 0.11], dtype=np.float32)

BLEND_MODES = ("normal", "multiply", "screen", "overlay", "softlight", "add",
               "subtract", "difference", "darken", "lighten",
               # Photoshop's remaining eleven, appended rather than slotted
               # into its dropdown order: engine.py builds its tuple as this
               # one plus seven, imgdoc.py builds on that, and two test suites
               # index the result by position. Growing the tail moves nothing
               # that already had an index.
               "dissolve", "linearBurn", "darkerColor", "linearDodge",
               "lighterColor", "vividLight", "linearLight", "pinLight",
               "hardMix", "exclusion", "divide",
               # The last seven lived in server/vfx/engine.py's `_EXTRA_MODES`
               # until 2026-09-21 and were implemented ONLY there, which meant
               # `_blend` fell off the end of its own if-chain and handed `top`
               # back for all seven: a shape, a brush stroke or a flat layer
               # composite set to "hard light" or "color dodge" rendered
               # BIT-IDENTICAL to normal and nothing said so. They are here now
               # because this is the tuple every caller of `_blend` reads, and a
               # list that offers a name the function cannot answer is a picker
               # row that does nothing.
               #
               # STILL AT THE TAIL, and in `_EXTRA_MODES`' own order, because
               # engine.py used to build its tuple as this one PLUS these seven
               # in exactly this sequence. Appending them here in that order
               # leaves engine.BLEND_MODES and imgdoc.BLEND_MODES the same
               # tuples they already were, position for position, so the two
               # suites that index them and the hand-kept list in
               # server/vfx/store.js all stay true without being touched.
               "hardlight", "colordodge", "colorburn",
               "hue", "saturation", "color", "luminosity")

# ⚠ NOT EVERY NAME ABOVE IS A FUNCTION OF TWO COLOURS, and a sweep that assumes
# so crashes on the two that are not — which is exactly what four suites did the
# hour these landed.
#
# WHOLE_PIXEL_MODES compare the pixel's LUMINANCE and take one side wholesale,
# so they need all three channels at once: `_blend_whole_pixel` refuses them on
# a single plane rather than quietly becoming darken/lighten.
#
# NON_SEPARABLE_MODES are the spec's component family. They take the Lum or the
# Sat of one layer and graft it onto the other, and both of those are reductions
# ACROSS the three channels, so they need an image for the same reason the two
# above do and refuse a plane the same way. Separate from WHOLE_PIXEL_MODES
# because the two groups fail differently and say so differently: those degrade
# into darken/lighten, these would degrade into a per-channel nonsense that has
# no name at all.
#
# ALPHA_MODES are not colour maths at all. `dissolve` is a coin toss against the
# top layer's alpha and belongs ABOVE a composite's lerp — see dissolve_mask().
#
# IMAGE_ONLY_MODES is the union a caller actually branches on: everything
# `_blend` will refuse when handed one colour plane. It exists so a plane-at-a-
# time caller has ONE name to subtract rather than two it can get half right.
#
# PLANE_BLEND_MODES is what is left: elementwise, safe on one plane, and the set
# any "for every mode" test may iterate. Derived by SUBTRACTION on purpose — a
# hand-written twin would still read 26 after a 27th elementwise mode was added,
# and that mode would then be swept by nothing.
WHOLE_PIXEL_MODES = ("darkerColor", "lighterColor")
NON_SEPARABLE_MODES = ("hue", "saturation", "color", "luminosity")
ALPHA_MODES = ("dissolve",)
IMAGE_ONLY_MODES = WHOLE_PIXEL_MODES + NON_SEPARABLE_MODES
PLANE_BLEND_MODES = tuple(m for m in BLEND_MODES
                          if m not in IMAGE_ONLY_MODES and m not in ALPHA_MODES)


def dissolve_mask(alpha, seed=7, index=0, shape=None, at=(0, 0)):
    """The per-pixel coin toss `dissolve` actually is, as a boolean plate.

    Dissolve is the one transfer mode in the list that is not a function of two
    colours. Nothing is mixed: each pixel either takes the top layer at FULL
    strength or keeps the backdrop untouched, and the layer's alpha is the
    probability of the first. At 50% a dissolve layer is half its own pixels
    and half holes, which is why it looks like a dither and why no blend
    formula can produce it — `_blend` is handed two colours and no alpha, so it
    refuses the mode by name instead of inventing an answer.

    ⚠ THE SEED IS NOT A CONVENIENCE. An unseeded dissolve renders differently
    every time it is asked for: in a still that is a picture nobody can
    reproduce, and across frames it is crawling noise, because the dither
    pattern is re-rolled while the artwork under it holds still. `grain` above
    already settled the house answer to this — `grainSeed`, defaulting to a
    constant — and this follows it.

    `index` is mixed into the seed so that two dissolve layers in one stack do
    not choose the SAME pixels and read as a single layer; composite() passes
    the layer's position.

    `shape` and `at` place the window inside a field generated at the LAYER's
    own size: the noise is glued to the artwork rather than to the screen, so
    moving a layer moves its dither with it instead of dragging the layer
    through a fixed field — which is the crawl again, wearing the other hat.
    Left out, the window IS the whole layer.
    """
    a = np.asarray(alpha, dtype=np.float32)
    ah, aw = a.shape[:2]
    fh, fw = (ah, aw) if shape is None else (int(shape[0]), int(shape[1]))
    rng = np.random.default_rng([int(seed) & 0xFFFFFFFF, int(index) & 0xFFFFFFFF])
    y, x = int(at[0]), int(at[1])
    field = rng.random((fh, fw), dtype=np.float32)[y:y + ah, x:x + aw]
    # `<` and not `<=`: rng.random() is [0, 1), so alpha 0 can never win a toss
    # and alpha 1 can never lose one. Those two are the ends people check.
    return field[..., None] < a.reshape(ah, aw, -1)[..., :1]


def _blend_whole_pixel(base, top, mode):
    """darkerColor / lighterColor — the two modes that are NOT per-channel.

    darken and lighten compare each channel on its own, so a red backdrop under
    a blue source comes out of darken as near-black: a third colour, made of
    the losing halves of both layers, that is in neither picture. darkerColor
    compares the PIXELS by luminance and takes one of them whole, which is the
    mode people mean when they say "keep whichever is darker".

    ⚠ WHICH IS WHY IT CANNOT BE DONE ON ONE COLOUR PLANE, and why this refuses
    rather than answers. engine.py hands imagetools._blend a single plane at a
    time (server/vfx/engine.py:835) and a plane does not know the other two
    channels: the luma of a red plane is the red channel, so the mode would
    quietly degrade into `darken` and nothing would report it. A shape test on
    the last axis alone does not save it either — a tile exactly three pixels
    wide would pass one and weigh three PIXELS as if they were three channels —
    so what is required here is an IMAGE: a trailing axis of three with at
    least one spatial axis in front of it, which every channel-last caller
    (composite() below, imgshape._over, imgpath._over) hands over and no
    plane-at-a-time caller ever can.

    engine.py answers these from all three of its planes at once, in the branch
    it keeps directly above its non-separable one — see `_blend_rgb` there. It
    is the same shape of fix `_blend_non_separable` below needs from any
    plane-at-a-time caller, and the reason both refusals name IMAGE_ONLY_MODES.
    """
    b = np.asarray(base)
    if b.ndim < 3 or b.shape[-1] != 3:
        raise ValueError(
            f'"{mode}" compares whole pixels, so it needs an RGB image — an '
            f'array shaped (..., h, w, 3) — and it was handed {b.shape}. One '
            f'colour plane cannot know the other two channels, and answering '
            f'anyway would silently turn this mode into '
            f'{"darken" if mode == "darkerColor" else "lighten"}. A caller '
            f'that works plane by plane (server/vfx/engine.py) has to route '
            f'this mode through its own non-separable branch instead.')
    t = np.asarray(top)
    lb = b[..., :3] @ _LUMA_W
    lt = t[..., :3] @ _LUMA_W
    # ⚠ A TIE IS A REAL CASE, not a rounding artefact: two different colours of
    # equal luminance (a dark red and a dark green, say) tie exactly, and which
    # one survives is visible. Ties go to the SOURCE in both directions, so a
    # tone-matched layer paints instead of vanishing — the same thing `normal`
    # would do, which is the least surprising of the two answers.
    keep_base = (lb < lt) if mode == "darkerColor" else (lb > lt)
    return np.where(keep_base[..., None], b, t)


# ── the component family: Lum and Sat grafted from one layer onto the other ──
#
# W3C compositing-1 §12, and the four helpers below are its four: Lum, Sat,
# ClipColor, SetLum/SetSat. They are written on CHANNEL-LAST arrays because that
# is what every caller of `_blend` in this file's column holds, and they are
# written as the same sequence of operations, in the same order, as the plane
# form in server/vfx/engine.py — which is not a coincidence and not a coding
# style. That engine keeps its own plane-native copy for a measured reason (see
# `_blend_rgb` there), so these two are twins that can drift, and the only thing
# stopping them is that engine_test sweeps both and demands they agree BIT FOR
# BIT. Reordering an expression here for tidiness breaks that pin on purpose;
# if you do it, do it in both houses in the same commit.


def _ns_lum(c):
    """Lum(C), keeping the trailing axis so it broadcasts back over the three.

    Written out rather than as `c @ _LUMA_W` because a dot product is free to
    sum in whatever order its kernel likes, and this value has to match the
    plane form's `c0*w0 + c1*w1 + c2*w2` to the last bit.
    """
    return (c[..., 0:1] * _LUMA_W[0] + c[..., 1:2] * _LUMA_W[1]
            + c[..., 2:3] * _LUMA_W[2])


def _ns_sat(c):
    """Sat(C) — the spread of the three channels, which is the spec's whole
    definition of saturation here. NOT HSL's S: there is no division by the
    lightness, so a colour's Sat falls to zero as it approaches white as well as
    black, and `saturation` blending a near-white layer therefore flattens
    rather than blows out."""
    return c.max(axis=-1, keepdims=True) - c.min(axis=-1, keepdims=True)


def _ns_set_sat(c, s):
    """The spec's SetSat, vectorised: min -> 0, max -> s, mid -> proportional.

    Writing it as `(C - Cmin) * s / (Cmax - Cmin)` for all three channels at
    once gives exactly those three answers and avoids sorting the channels to
    find which is the middle one — a sort that would have to be done per pixel.

    ⚠ THE FLAT CASE IS THE DIVISION BY ZERO. A grey pixel has Cmax == Cmin, and
    the spec's answer for it is all three channels at 0 (a colour with no spread
    to rescale). The maximum() keeps the divide finite so no NaN is ever born —
    np.where would evaluate the dividing branch anyway — and the mask then
    replaces whatever that guard computed with the defined answer.
    """
    mn = c.min(axis=-1, keepdims=True)
    rng = c.max(axis=-1, keepdims=True) - mn
    flat = np.logical_not(rng > _EPS)
    out = (c - mn) * s / np.maximum(rng, _EPS)
    return np.where(flat, np.float32(0.0), out)


def _ns_clip_color(c):
    """Pull a colour back inside the cube WITHOUT moving its luminance.

    SetLum below adds a constant to all three channels, which walks a saturated
    colour straight out of 0..1; clamping the result there would change the
    luminance it was just asked to set, and the whole point of `luminosity` is
    that the tone is the one it was given. So the colour is scaled TOWARD its
    own luma grey instead, which leaves Lum exactly where it is.

    ⚠ maximum(), NOT minimum(), ON BOTH DIVISORS. `l` is a weighted mean of the
    three channels, so `l - n` and `x - l` are both non-negative; a minimum()
    against a positive epsilon would therefore be the epsilon EVERY time, and
    every out-of-gamut pixel would be divided by 1e-6. engine.py shipped exactly
    that slip once — [-0.058, 0.542, 0.242] came back as [127323, -70077,
    28623] — and the note on its `_clip_color` is the record of it.
    """
    l = _ns_lum(c)
    n = c.min(axis=-1, keepdims=True)
    x = c.max(axis=-1, keepdims=True)
    # The complement of the predicate rather than the predicate: a NaN channel
    # then falls on the "leave it alone" side of both halves instead of being
    # scaled by a comparison that is False for every operator.
    keep_lo = np.logical_not(n < 0)
    keep_hi = np.logical_not(x > 1)
    n = np.maximum(l - n, _EPS)
    x = np.maximum(x - l, _EPS)
    p = np.where(keep_lo, c, l + (c - l) * l / n)
    return np.where(keep_hi, p, l + (p - l) * (1 - l) / x)


def _ns_set_lum(c, l):
    """SetLum(C, l): shift all three channels by one number, then re-gamut."""
    return _ns_clip_color(c + (l - _ns_lum(c)))


def _blend_non_separable(base, top, mode):
    """hue / saturation / color / luminosity — the four that mix components.

    Each one takes two of {Hue, Sat, Lum} from one layer and the third from the
    other. `color` and `luminosity` are the pair people actually reach for: a
    colour layer over a photograph, and a photograph's tone under a flat colour.

    ⚠ NONE OF THEM IS A FUNCTION OF ONE CHANNEL, which is why this refuses a
    plane rather than answering. Lum is a weighted sum across the three and Sat
    is max minus min across the three, so handed a single plane both reductions
    collapse to the plane itself: Lum(r) == r, Sat(r) == 0. `luminosity` would
    become `normal`, `color` would become `normal`, and `hue` and `saturation`
    would both become a flat grey — four modes silently wrong in three
    different ways, which is worse than the one they were in before this
    function existed. `_blend_whole_pixel` above refuses for the same reason and
    with the same guard; see its note for why a shape test on the last axis
    alone is not enough.
    """
    b = np.asarray(base)
    if b.ndim < 3 or b.shape[-1] != 3:
        raise ValueError(
            f'"{mode}" mixes the Lum and Sat of whole pixels, so it needs an '
            f'RGB image — an array shaped (..., h, w, 3) — and it was handed '
            f'{b.shape}. Lum and Sat are both reductions ACROSS the three '
            f'channels, so one colour plane cannot supply either, and '
            f'answering anyway would turn this mode into normal or into a flat '
            f'grey depending on which one it is. A caller that works plane by '
            f'plane (server/vfx/engine.py) has to route every name in '
            f'imagetools.IMAGE_ONLY_MODES through its own branch instead.')
    b = b[..., :3]
    t = np.asarray(top)[..., :3]
    if mode == "hue":
        # The source's hue, worn at the backdrop's saturation and tone. SetSat
        # first and SetLum second, and NOT the other way round: SetSat rescales
        # the channels about zero and would drag any luminance set before it.
        return _ns_set_lum(_ns_set_sat(t, _ns_sat(b)), _ns_lum(b))
    if mode == "saturation":
        # The source's SATURATION applied to the backdrop's own hue and tone —
        # the backdrop is the colour being moved, which is why `b` is the
        # argument to SetSat here and `t` was above. Swapping those two lines
        # gives a mode that looks plausible and is `hue` with the layers
        # exchanged.
        return _ns_set_lum(_ns_set_sat(b, _ns_sat(t)), _ns_lum(b))
    if mode == "color":
        return _ns_set_lum(t, _ns_lum(b))
    # luminosity: `color` with the layers the other way round, and the only one
    # of the four that keeps the BACKDROP's colour.
    return _ns_set_lum(b, _ns_lum(t))


def _blend(base, top, mode):
    """Photoshop's blend maths on float 0..1 arrays, RGB only.

    `base` is the backdrop (the spec's Cb), `top` the source (Cs). Every mode
    here but the six in IMAGE_ONLY_MODES is ELEMENTWISE, which is the property
    that lets engine.py hand this one colour plane at a time and get the same
    arithmetic out; those six, and dissolve, say so themselves rather than
    returning a plausible wrong colour.

    RANGE: the modes whose own definition ends in a clamp are clamped here; add
    and subtract are not, and never were, because all four call sites clip the
    result (composite() below, imgshape._over, imgpath._over, engine._mix_blend).
    """
    if mode == "multiply":
        return base * top
    if mode == "screen":
        return 1 - (1 - base) * (1 - top)
    if mode == "overlay":
        return np.where(base <= 0.5, 2 * base * top, 1 - 2 * (1 - base) * (1 - top))
    if mode == "softlight":
        # W3C/Photoshop soft light
        d = np.where(base <= 0.25, ((16 * base - 12) * base + 4) * base, np.sqrt(np.maximum(base, 0)))
        return np.where(top <= 0.5,
                        base - (1 - 2 * top) * base * (1 - base),
                        base + (2 * top - 1) * (d - base))
    if mode == "add":
        return base + top
    if mode == "subtract":
        return base - top
    if mode == "difference":
        return np.abs(base - top)
    if mode == "darken":
        return np.minimum(base, top)
    if mode == "lighten":
        return np.maximum(base, top)

    # ── Photoshop's other eleven ─────────────────────────────────────────
    if mode == "linearDodge":
        # THE SAME FUNCTION AS `add` ABOVE, and written as the same
        # expression on purpose rather than as a second opinion about it.
        # Photoshop renamed add to "Linear Dodge (Add)" and people look for
        # both spellings, so both have to exist; two names that quietly
        # differed by so much as a clamp would be a bug with no symptom. That
        # is also why this one is NOT clamped — `add` is not — and why
        # imagetools_test pins the two bit-identical across the whole grid.
        return base + top
    if mode == "linearBurn":
        # b + t - 1, and this one IS clamped where linearDodge is not. The
        # asymmetry is deliberate: linearDodge has a twin it must match to the
        # last bit, linearBurn has none, and the clamp is part of its own
        # definition. Every call site clips anyway, so the two conventions meet
        # at the pixel and disagree only about what this function promises.
        return np.clip(base + top - 1.0, 0.0, 1.0)
    if mode == "vividLight":
        # ColorBurn against a doubled source below the midpoint, ColorDodge
        # against the doubled remainder above it — the only one of the four
        # light-pair modes that genuinely divides.
        #
        # ⚠ np.where EVALUATES BOTH BRANCHES. The divides therefore have to be
        # safe before the selection ever happens: the np.maximum guards are
        # what stop a NaN being born, and the outer np.where is what gives each
        # corner its defined answer. This is engine.py's `_blend_extra` shape
        # exactly, because these are its colordodge and colorburn with the
        # source stretched — a NaN escaping here would land as a black or white
        # pixel with nothing anywhere reporting it.
        burn = np.where(base >= 1 - _EPS, 1.0,
                        np.where(top <= _EPS, 0.0,
                                 1 - np.minimum(1.0, (1 - base)
                                                / np.maximum(2 * top, _EPS))))
        dodge = np.where(base <= _EPS, 0.0,
                         np.where(top >= 1 - _EPS, 1.0,
                                  np.minimum(1.0, base
                                             / np.maximum(2 - 2 * top, _EPS))))
        return np.where(top <= 0.5, burn, dodge)
    if mode == "linearLight":
        # LinearBurn(b, 2t) below the midpoint and LinearDodge(b, 2t - 1) above
        # it are the SAME expression, b + 2t - 1, so there is no branch here —
        # and no division either. The warning that every light-pair mode hides
        # a divide by zero holds for vividLight above; for this one, pinLight
        # and hardMix the divide only exists if you build them out of
        # colorDodge/colorBurn, and written straight they cannot divide by zero
        # because they never divide. The clamp is real: b + 2t - 1 runs -1..2.
        return np.clip(base + 2 * top - 1.0, 0.0, 1.0)
    if mode == "pinLight":
        # Darken against a doubled source below the midpoint, Lighten against
        # the doubled remainder above it. No clamp: min(b, 2t) cannot exceed b
        # and max(b, 2t - 1) cannot exceed 1, so both ends are closed by
        # construction, and a clamp that can never fire is not a guard — it is
        # a line that makes the next reader think one was needed.
        return np.where(top <= 0.5,
                        np.minimum(base, 2 * top),
                        np.maximum(base, 2 * top - 1.0))
    if mode == "hardMix":
        # VividLight rounded to its ends, which works out to a plain threshold
        # on b + t: VividLight(b, t) >= 0.5 exactly when b + t >= 1, in BOTH of
        # its branches. Writing the threshold instead of thresholding the
        # division is what keeps this one clear of the divide-by-zero it would
        # otherwise inherit.
        #
        # Legitimately 0 or 1 per channel, so the output holds eight colours and
        # looks brutal. That is the mode, not a clamp bug: it is what people
        # reach for to posterise a layer against its backdrop.
        s = base + top
        return (s >= 1.0).astype(np.asarray(s).dtype)
    if mode == "exclusion":
        # b + t - 2bt — difference's softer twin, with the mid-tones pulled to
        # grey instead of to black. No clamp: the expression is linear in b
        # with both endpoints (t and 1 - t) inside 0..1, so it cannot leave the
        # range for inputs that are in it.
        return base + top - 2 * base * top
    if mode == "divide":
        # b / t, guarded the way engine.py guards colordodge: the denominator
        # is never actually zero, so no NaN is ever born, and min() turns the
        # overflow into the white Photoshop gives. The guard decides two
        # corners, and both are decisions rather than accidents — t = 0 over a
        # lit base runs straight past 1 and pins at white; t = 0 over a black
        # base gives 0 / _EPS = 0, black, which is the only value continuous
        # with b falling to zero. 0/0 has no right answer; this is at least the
        # same answer every time.
        return np.minimum(1.0, base / np.maximum(top, _EPS))
    if mode == "hardlight":
        # Overlay with the layers exchanged: the SOURCE decides which branch
        # each pixel takes, so a hard-light layer is a contrast mask you paint,
        # where an overlay is one you pass a picture through. Both halves are
        # written out rather than delegated to overlay's own branch, because
        # calling overlay(top, base) would read as if the two modes were the
        # same function and the argument order were a detail.
        return np.where(top <= 0.5, 2 * base * top,
                        1 - 2 * (1 - base) * (1 - top))
    if mode == "colordodge":
        # b / (1 - t): the backdrop brightened until the source's complement
        # runs out. vividLight above is this same expression against a doubled
        # source, and the guards are identical for the identical reason —
        # np.where EVALUATES BOTH BRANCHES, so the divide has to be finite
        # before the selection happens or a NaN is born in the branch that gets
        # thrown away and left behind as a RuntimeWarning.
        #
        # The two corner tests are in the spec's own order and that order
        # DECIDES a pixel: at b = 0 and t = 1 both fire, and W3C compositing-1
        # asks the Cb == 0 one first, so a black backdrop under a white source
        # stays black instead of going white.
        return np.where(base <= _EPS, 0.0,
                        np.where(top >= 1 - _EPS, 1.0,
                                 np.minimum(1.0, base
                                            / np.maximum(1 - top, _EPS))))
    if mode == "colorburn":
        # The mirror of colordodge through 1 - x, with its corners in the
        # spec's order too: Cb == 1 is asked before Cs == 0, so a white backdrop
        # under a black source stays white.
        return np.where(base >= 1 - _EPS, 1.0,
                        np.where(top <= _EPS, 0.0,
                                 1 - np.minimum(1.0, (1 - base)
                                                / np.maximum(top, _EPS))))
    if mode in ("darkerColor", "lighterColor"):
        return _blend_whole_pixel(base, top, mode)
    if mode in NON_SEPARABLE_MODES:
        return _blend_non_separable(base, top, mode)
    if mode == "dissolve":
        # ⚠ NOT A PIXEL FUNCTION, so there is no colour to return here. It is a
        # per-pixel coin toss against the top layer's ALPHA, which this
        # signature is never handed, and it needs a seed or the same composite
        # renders differently every time. Even given the alpha the answer would
        # be wrong from here: every caller finishes with `base * (1 - a) +
        # result * a`, and that lerp smears back exactly the mixing dissolve is
        # defined to avoid. composite() below does it properly, above the lerp,
        # with dissolve_mask(). Returning `top` instead of raising would be a
        # dissolve that ignores its own definition — full strength everywhere,
        # a picture indistinguishable from `normal` — which is worse than not
        # having the mode.
        raise ValueError(
            "dissolve is not a blend function: it is a per-pixel coin toss "
            "against the top layer's alpha, and _blend(base, top, mode) is "
            "handed neither an alpha nor a seed. Use imagetools.dissolve_mask("
            "alpha, seed, index) above the composite's own lerp, the way "
            "imagetools.composite() does.")
    if mode == "normal":
        return top

    # ⚠ THIS USED TO BE A BARE `return top`, AND THAT LINE HID A REAL BUG FOR AS
    # LONG AS IT EXISTED. Seven modes were listed in BLEND_MODES and implemented
    # only over in server/vfx/engine.py, so every one of them fell off the end
    # of the chain above and came back as the source untouched: hard light,
    # color dodge, color burn, hue, saturation, color and luminosity all
    # rendered BIT-IDENTICAL to normal through composite(), imgshape._over and
    # imgpath._over, and no test, no log line and no pixel said otherwise. A
    # blend mode that renders as normal looks like a plausible picture, which is
    # the only reason it survived.
    #
    # `normal` is answered by NAME above instead, so the two cases can no longer
    # share an exit. A caller that genuinely wants "paint it as normal when the
    # name is a stranger" — engine.py's `_over` does, because a comp document is
    # free to carry any string and an exception inside a render loop is worse
    # than a wrong-looking layer — has to make that decision itself, in its own
    # file, where it is visible. imgdoc.normalize() already did exactly that at
    # the document level and kept its warning.
    raise ValueError(
        f'no blend mode called "{mode}". The {len(BLEND_MODES)} this function '
        f'implements are imagetools.BLEND_MODES; the six in IMAGE_ONLY_MODES '
        f'additionally need an RGB image rather than a single colour plane. If '
        f'you meant to paint an unrecognised name as normal, coerce it against '
        f'BLEND_MODES where the name arrives — do not ask for a colour and get '
        f'the source back.')


def analyze(job):
    """Read an image and PROPOSE ops — the one-click enhance, but honest: it
    returns the recipe instead of baking it, so the sliders land where the
    analysis put them and a human (or an agent) can argue with any of it.

    job: { "in": path }
    """
    im = Image.open(job["in"]).convert("RGB")
    small = im.copy()
    small.thumbnail((512, 512), Image.LANCZOS)
    a = np.asarray(small).astype(np.float32)
    luma = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

    lo, hi = np.percentile(luma, [0.5, 99.5])
    mean = float(luma.mean())
    # saturation as the mean chroma spread, 0..1
    sat = float((a.max(axis=-1) - a.min(axis=-1)).mean() / 255.0)
    clipped_low = float((luma < 4).mean())
    clipped_high = float((luma > 251).mean())

    ops = {}
    notes = []
    if hi - lo < 200 and clipped_low < 0.02 and clipped_high < 0.02:
        ops["autoLevels"] = True
        notes.append(f"flat: the range is {int(hi - lo)} of 255, so levels stretch it")
    if mean < 96:
        ops["shadows"] = min(45, int((110 - mean) * 0.8))
        notes.append(f"dark (mean {int(mean)}): lifting shadows {ops['shadows']}")
    elif mean > 170:
        ops["highlights"] = -min(40, int((mean - 160) * 0.8))
        notes.append(f"bright (mean {int(mean)}): recovering highlights {ops['highlights']}")
    if sat < 0.14:
        ops["saturation"] = 100 + min(35, int((0.18 - sat) * 300))
        notes.append(f"muted (chroma {sat:.2f}): saturation {ops['saturation']}")
    elif sat > 0.42:
        ops["saturation"] = 100 - min(20, int((sat - 0.40) * 150))
        notes.append(f"loud (chroma {sat:.2f}): pulling saturation to {ops['saturation']}")
    # a gentle S only when the image is not already contrasty
    spread = float(luma.std())
    if spread < 52:
        ops["curves"] = {"master": [[0, 0], [64, 56], [192, 200], [255, 255]]}
        notes.append(f"low contrast (sd {int(spread)}): a gentle S curve")
    if clipped_high > 0.06:
        notes.append(f"warning: {clipped_high * 100:.1f}% of pixels are blown — no amount of tone gets them back")

    print(json.dumps({"ok": True, "ops": ops, "notes": notes,
                      "stats": {"mean": round(mean, 1), "sd": round(spread, 1),
                                "chroma": round(sat, 3), "black": round(float(lo), 1),
                                "white": round(float(hi), 1),
                                "clippedLow": round(clipped_low, 4),
                                "clippedHigh": round(clipped_high, 4)}}))


def composite(job):
    """Layer images onto a base — the compositing half of an editor.

    job: { "base": path, "out": path, "thumbOut": path|null, "thumbSize": 256,
           "layers": [ { "src": path, "x": 0, "y": 0, "scale": 1.0,
                         "opacity": 1.0, "mode": "normal", "rotate": 0,
                         "flipH": false, "anchor": "topleft"|"center",
                         "dissolveSeed": 7 } ],
           "canvas": { "w": int, "h": int, "bg": [r,g,b,a] }|null }

    Layers paint in order, first is bottom. Each layer's own alpha (a cutout's
    transparency, say) multiplies its opacity, so a PNG with holes composites
    the way it looks. Blend maths runs on the OVERLAP only — a 200px logo on a
    4K plate costs 200px of work, not 4K.

    A layer's `mode` is a free string off a job file, so a name nothing
    implements is REPAIRED here rather than raised, and the repair is REPORTED
    in the status line's `warnings`. That is imgdoc.normalize()'s rule, applied
    at the only other place a document-shaped thing meets this compositor: a
    stack is usually somebody's saved work and losing all of it over one
    layer's spelling is the worse of the two failures. What is not acceptable is
    what this used to do — `_blend` ended in `return top`, so the layer painted
    as normal and nothing anywhere said so, and seven modes that were genuinely
    missing hid behind that for as long as it lasted.
    """
    warnings = []
    base = Image.open(job["base"]).convert("RGBA")
    canvas = job.get("canvas") or {}
    if int(canvas.get("w") or 0) > 0 and int(canvas.get("h") or 0) > 0:
        bg = tuple((canvas.get("bg") or [0, 0, 0, 0])[:4])
        sheet = Image.new("RGBA", (int(canvas["w"]), int(canvas["h"])), bg)
        sheet.alpha_composite(base, (0, 0))
        base = sheet

    out = np.asarray(base).astype(np.float32) / 255.0
    H, W = out.shape[:2]

    for li, layer in enumerate(job.get("layers") or []):
        top = Image.open(layer["src"]).convert("RGBA")
        sc = float(layer.get("scale") or 1.0)
        if abs(sc - 1.0) > 0.001:
            top = top.resize((max(1, int(top.width * sc)), max(1, int(top.height * sc))), Image.LANCZOS)
        rot = int(layer.get("rotate") or 0) % 360
        if rot:
            top = top.rotate(-rot, expand=True, resample=Image.BICUBIC)
        if layer.get("flipH"):
            top = top.transpose(Image.FLIP_LEFT_RIGHT)
        if layer.get("flipV"):
            top = top.transpose(Image.FLIP_TOP_BOTTOM)

        # Layer effects, drawn from the layer's own alpha the way Photoshop
        # does: the shape is the mask, the effect is painted behind (shadow,
        # glow) or around (stroke) it, and the whole lot grows the layer so
        # nothing clips at the edges.
        fx = layer.get("effects") or {}
        sh, gl, st = fx.get("shadow"), fx.get("glow"), fx.get("stroke")
        if sh or gl or st:
            from PIL import ImageFilter as IF
            pad = int(max(
                (abs(int((sh or {}).get("dx", 6))) + int((sh or {}).get("blur", 8)) + 4) if sh else 0,
                (int((gl or {}).get("size", 10)) + 4) if gl else 0,
                (int((st or {}).get("width", 3)) + 2) if st else 0,
                (abs(int((sh or {}).get("dy", 6))) + int((sh or {}).get("blur", 8)) + 4) if sh else 0,
            ))
            grown = Image.new("RGBA", (top.width + pad * 2, top.height + pad * 2), (0, 0, 0, 0))
            mask = top.getchannel("A")
            if st:
                w = max(1, int(st.get("width", 3)))
                col = tuple((st.get("color") or [0, 0, 0])[:3]) + (255,)
                ring = mask.filter(IF.MaxFilter(w * 2 + 1))
                layerimg = Image.new("RGBA", grown.size, col)
                grown.paste(layerimg, (0, 0), Image.new("L", grown.size).point(lambda _: 0))
                tmp = Image.new("L", grown.size, 0)
                tmp.paste(ring, (pad, pad))
                grown = Image.composite(Image.new("RGBA", grown.size, col), grown, tmp)
            if gl:
                col = tuple((gl.get("color") or [255, 240, 180])[:3])
                size = max(1, int(gl.get("size", 10)))
                op = float(gl.get("opacity", 0.8))
                halo = Image.new("L", grown.size, 0)
                halo.paste(mask, (pad, pad))
                halo = halo.filter(IF.GaussianBlur(size))
                halo = halo.point(lambda v: int(min(255, v * (1 + op))))
                grown = Image.composite(Image.new("RGBA", grown.size, col + (255,)), grown, halo)
            if sh:
                col = tuple((sh.get("color") or [0, 0, 0])[:3])
                blur = max(0, int(sh.get("blur", 8)))
                dx, dy = int(sh.get("dx", 6)), int(sh.get("dy", 6))
                op = float(sh.get("opacity", 0.55))
                sm = Image.new("L", grown.size, 0)
                sm.paste(mask, (pad + dx, pad + dy))
                if blur:
                    sm = sm.filter(IF.GaussianBlur(blur))
                sm = sm.point(lambda v: int(v * op))
                grown = Image.composite(Image.new("RGBA", grown.size, col + (255,)), grown, sm)
            grown.alpha_composite(top, (pad, pad))
            top = grown
            layer = {**layer, "x": int(layer.get("x") or 0) - (0 if str(layer.get("anchor")) == "center" else pad),
                     "y": int(layer.get("y") or 0) - (0 if str(layer.get("anchor")) == "center" else pad)}

        x, y = int(layer.get("x") or 0), int(layer.get("y") or 0)
        if str(layer.get("anchor") or "topleft") == "center":
            x -= top.width // 2
            y -= top.height // 2

        # clip to the canvas; work only on the overlap
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(W, x + top.width), min(H, y + top.height)
        if x1 <= x0 or y1 <= y0:
            continue
        crop = np.asarray(top.crop((x0 - x, y0 - y, x1 - x, y1 - y))).astype(np.float32) / 255.0

        dst = out[y0:y1, x0:x1]
        a = crop[..., 3:4] * float(layer.get("opacity", 1.0))
        mode = str(layer.get("mode") or "normal")
        if mode not in BLEND_MODES:
            warnings.append(
                f"layer {li}: no blend mode called \"{mode}\" — painted as "
                f"normal. The {len(BLEND_MODES)} real ones are "
                f"imagetools.BLEND_MODES.")
            mode = "normal"
        if mode == "dissolve":
            # ⚠ ABOVE THE LERP, NOT INSIDE IT. The two lines below are the
            # whole of compositing for every other mode — blend, then weight by
            # alpha — and dissolve is defined by refusing the second half: the
            # alpha chose WHICH pixels take the top, so the ones that did take
            # it at full strength and full coverage. Running it through the
            # lerp would mix every pixel a second time and hand back something
            # that just looks like `normal` at reduced opacity.
            keep = dissolve_mask(a, layer.get("dissolveSeed") or 7, li,
                                 shape=(top.height, top.width),
                                 at=(y0 - y, x0 - x))
            dst[..., :3] = np.where(keep, crop[..., :3], dst[..., :3])
            dst[..., 3:4] = np.where(keep, 1.0, dst[..., 3:4])
            continue
        blended = np.clip(_blend(dst[..., :3], crop[..., :3], mode), 0, 1)
        dst[..., :3] = dst[..., :3] * (1 - a) + blended * a
        dst[..., 3:4] = np.clip(dst[..., 3:4] + a * (1 - dst[..., 3:4]), 0, 1)

    im = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA")
    im.save(job["out"])
    if job.get("thumbOut"):
        th = im.copy()
        th.thumbnail((int(job.get("thumbSize") or 256),) * 2, Image.LANCZOS)
        th.save(job["thumbOut"])
    # `warnings` is omitted when empty rather than sent as []: the route that
    # reads this line parses the last line of stdout and looks at two keys, and
    # a key that is present on every run is a key nobody notices on the one run
    # that matters.
    print(json.dumps({"ok": True, "out": job["out"], "width": im.width, "height": im.height,
                      "layers": len(job.get("layers") or []),
                      **({"warnings": warnings} if warnings else {})}))


def sheet(job):
    """Contact sheet: N images tiled into one, the collage a gallery implies.

    job: { "images": [paths], "out": path, "thumbOut": path|null,
           "cols": int|null, "cell": 512, "gap": 8, "bg": [r,g,b,a],
           "labels": [str]|null, "fit": "cover"|"contain" }

    cols defaults to the near-square arrangement. "cover" crops each tile to
    fill its cell (the tight grid people mean by a collage); "contain" letter-
    boxes instead, which keeps whole images intact.
    """
    from PIL import ImageDraw, ImageFont
    import math
    import os

    paths = [p for p in (job.get("images") or []) if p]
    if not paths:
        print(json.dumps({"ok": False, "error": "no images"}))
        return
    cell = max(64, int(job.get("cell") or 512))
    gap = max(0, int(job.get("gap") or 8))
    cols = int(job.get("cols") or 0) or max(1, int(math.ceil(math.sqrt(len(paths)))))
    rows = int(math.ceil(len(paths) / cols))
    labels = job.get("labels") or []
    lab_h = 26 if labels else 0
    bg = tuple((job.get("bg") or [12, 13, 16, 255])[:4])
    fit = str(job.get("fit") or "cover")

    W = cols * cell + (cols + 1) * gap
    H = rows * (cell + lab_h) + (rows + 1) * gap
    out = Image.new("RGBA", (W, H), bg)
    draw = ImageDraw.Draw(out)
    font = None
    if labels:
        for cand in (r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"):
            try:
                font = ImageFont.truetype(cand, 14); break
            except OSError:
                continue
        if font is None:
            font = ImageFont.load_default(14)

    for i, p in enumerate(paths):
        try:
            im = Image.open(p).convert("RGBA")
        except Exception:
            continue
        r, c = divmod(i, cols)
        x = gap + c * (cell + gap)
        y = gap + r * (cell + lab_h + gap)
        if fit == "contain":
            im.thumbnail((cell, cell), Image.LANCZOS)
            ox, oy = (cell - im.width) // 2, (cell - im.height) // 2
            out.alpha_composite(im, (x + ox, y + oy))
        else:
            sc = max(cell / im.width, cell / im.height)
            im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
            left = (im.width - cell) // 2
            topc = (im.height - cell) // 2
            out.alpha_composite(im.crop((left, topc, left + cell, topc + cell)), (x, y))
        if labels and i < len(labels) and labels[i]:
            draw.text((x + 4, y + cell + 5), str(labels[i])[:60], font=font, fill=(220, 220, 226, 255))

    out.save(job["out"])
    if job.get("thumbOut"):
        th = out.copy()
        th.thumbnail((int(job.get("thumbSize") or 256),) * 2, Image.LANCZOS)
        th.save(job["thumbOut"])
    print(json.dumps({"ok": True, "out": job["out"], "width": out.width, "height": out.height,
                      "tiles": len(paths), "cols": cols, "rows": rows}))


def vectorize(job):
    import cv2

    colors = max(2, min(16, int(job.get("colors") or 6)))
    detail = max(0.2, min(4.0, float(job.get("detail") or 1.0)))
    min_area = int(job.get("minArea") or 16)

    im = Image.open(job["in"]).convert("RGB")
    # keep vector work at a sane size; SVG scales anyway
    scale = min(1.0, 1024 / max(im.size))
    if scale < 1.0:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    w, h = im.size

    # adaptive palette; slight pre-blur so JPEG noise doesn't become 10k paths
    q = im.filter(ImageFilter.GaussianBlur(0.6)).quantize(colors=colors, method=Image.MEDIANCUT)
    pal = q.getpalette()
    idx = np.asarray(q, dtype=np.uint8)

    # layers back-to-front by coverage: the biggest color paints first so
    # smaller shapes sit on top of it, exactly how a designer would stack
    counts = [(int((idx == i).sum()), i) for i in range(colors)]
    counts.sort(reverse=True)

    eps_base = 1.2 / detail
    paths = []
    for _, i in counts:
        mask = (idx == i).astype(np.uint8) * 255
        if mask.sum() == 0:
            continue
        r, g, b = pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]
        contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            continue
        # group outer contours with their holes into one even-odd path
        d_parts = []
        for c, hinfo in zip(contours, hierarchy[0]):
            if cv2.contourArea(c) < min_area:
                continue
            approx = cv2.approxPolyDP(c, eps_base, True)
            if len(approx) < 3:
                continue
            pts = approx.reshape(-1, 2)
            d = f"M{pts[0][0]},{pts[0][1]}" + "".join(f"L{x},{y}" for x, y in pts[1:]) + "Z"
            d_parts.append(d)
        if d_parts:
            paths.append(f'<path fill="rgb({r},{g},{b})" fill-rule="evenodd" d="{"".join(d_parts)}"/>')

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
           f'width="{w}" height="{h}">{"".join(paths)}</svg>')
    with open(job["out"], "w", encoding="utf-8") as f:
        f.write(svg)
    print(json.dumps({"ok": True, "out": job["out"], "paths": len(paths), "colors": colors,
                      "bytes": len(svg)}))


def describe_selection(job):
    """What a selection actually caught, before an edit is spent on it.

    The one answer that distinguishes "my key is subtle" from "my key caught
    nothing and every op silently did nothing" \u2014 see imgselect.resolve(), which
    treats an all-zero mask as a legitimate no-op.
    """
    src = job.get("src")
    if not src:
        print(json.dumps({"ok": False, "error": "describe needs a src image"}))
        return
    import imgselect                                    # noqa: PLC0415
    im = Image.open(src).convert("RGBA")
    # ⚠ IN THE FRAME THE SHAPES WERE WRITTEN IN, NOT THE RAW SOURCE. This used
    # to open the file and resolve against it, so with a crop pending it
    # measured a selection in one picture that the edit would then apply to
    # another — right numbers, wrong frame, and the whole point of this route
    # is that the numbers can be trusted. `frame` carries only stages 1-3; the
    # adjustments cannot move a coordinate and are not run.
    _notes = []
    im = frame_stages(im, job.get("frame") or {}, _notes)
    rgba = _to_rgba(im)
    out = imgselect.describe(job.get("selection") or {}, rgba)
    print(json.dumps({"ok": True, "width": im.width, "height": im.height,
                      "notes": _notes or None, **out}))


def blank(job):
    """A new page: {out, width, height, background:[r,g,b,a]}.

    Bounds are the ones the rest of this module already lives inside - a canvas
    bigger than 16384 on a side is not a page somebody meant to open, it is a
    typo that costs a gigabyte of RAM before anything refuses it.
    """
    w = max(1, min(16384, int(job.get("width") or 1920)))
    h = max(1, min(16384, int(job.get("height") or 1080)))
    bg = job.get("background")
    if not isinstance(bg, (list, tuple)) or len(bg) != 4:
        bg = [0, 0, 0, 0]
    bg = tuple(max(0, min(255, int(round(float(c))))) for c in bg)
    im = Image.new("RGBA", (w, h), bg)
    # The format is stated rather than inferred: callers stage this through a
    # temp file whose extension is deliberately NOT an image extension, so that
    # the half-written page is never matched by the gallery's own listing.
    im.save(job["out"], format="PNG")
    print(json.dumps({"ok": True, "width": w, "height": h,
                      "background": list(bg)}))


def main():
    mode, job_path = sys.argv[1], sys.argv[2]
    job = json.loads(open(job_path, encoding="utf-8").read())
    if mode == "edit":
        apply_edit(job)
    elif mode == "composite":
        composite(job)
    elif mode == "sheet":
        sheet(job)
    elif mode == "analyze":
        analyze(job)
    elif mode == "vectorize":
        vectorize(job)
    elif mode == "describe":
        describe_selection(job)
    elif mode == "blank":
        blank(job)
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))


if __name__ == "__main__":
    main()
