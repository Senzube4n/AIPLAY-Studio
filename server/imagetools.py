"""Image adjustments and vectorization - the editing engine behind the Images
screen AND the MCP tools. One implementation: the browser only PREVIEWS with
CSS approximations; every committed edit renders here, so the UI and an agent
produce identical pixels.

Usage:
  python imagetools.py edit <job.json>
      job: { "in": path, "out": path, "thumbOut": path|null, "thumbSize": 256,
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


# Effects that read a TIMELINE. A still has no previous frames and no instant
# to quantise, so these return their input. Listed rather than hidden: asking
# for echo on a photograph should say why it did nothing, not imply the name
# was wrong.
TIMELINE_EFFECTS = ("echo", "timeDifference", "posterizeTime")


def apply_effects(im, specs, mask=None):
    """Run a list of {type, params} over a PIL RGBA image, §4.

    `mask` is the selection — float32 (H, W) 0..1, or None for the whole
    frame. Each effect computes its full result and is then blended through
    the mask, which is what makes all 75 of them local without any of them
    knowing selections exist.
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
    # so the contract is identical and effects.py needs no special case.
    ctx = {"history": lambda n=1: [], "time": 0.0, "fps": 1.0, "draft": False}

    skipped = []
    for spec in specs:
        name = str((spec or {}).get("type") or "")
        if not name or name not in fx.CATALOG:
            raise ValueError(
                f'No effect called "{name}". '
                f"There are {len(fx.CATALOG)}; the catalog lists them.")
        if name in TIMELINE_EFFECTS:
            skipped.append(name)
            continue
        before = rgba
        out = fx.apply(name, rgba.copy(), (spec or {}).get("params") or {}, ctx)
        if not isinstance(out, np.ndarray) or out.shape != rgba.shape:
            continue                                    # an effect that refused
        rgba = out if m is None else (out * m + before * (1.0 - m))

    rgba = np.clip(rgba, 0.0, 1.0)
    return Image.fromarray((rgba * 255.0 + 0.5).astype(np.uint8), "RGBA"), skipped





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
        a = np.asarray(work).astype(np.float32)
        for ch, key in ((None, "master"), (0, "r"), (1, "g"), (2, "b")):
            adj = lv.get(key)
            if not isinstance(adj, dict):
                continue
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


def apply_edit(job):
    ops = job.get("ops") or {}
    # RGBA throughout: cutouts and chroma keys carry transparency, and an edit
    # pass must not flatten it
    im = Image.open(job["in"]).convert("RGBA")

    crop = ops.get("crop")
    if crop and all(k in crop for k in ("x", "y", "w", "h")):
        x, y = max(0, int(crop["x"])), max(0, int(crop["y"]))
        w, h = int(crop["w"]), int(crop["h"])
        if w > 4 and h > 4:
            im = im.crop((x, y, min(im.width, x + w), min(im.height, y + h)))

    rot = int(ops.get("rotate") or 0) % 360
    if rot:
        im = im.rotate(-rot, expand=True)
    if ops.get("flipH"):
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    if ops.get("flipV"):
        im = im.transpose(Image.FLIP_TOP_BOTTOM)

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

    # ── the shared effect registry, §4 — 75 of them, none reimplemented ──
    fx_skipped = []
    fx_specs = ops.get("effects")
    if fx_specs:
        im, fx_skipped = apply_effects(im, fx_specs, ops.get("_mask"))

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
        rgba = imgtext.draw_text(rgba, spec)
        im = Image.fromarray((np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGBA")

    rs = ops.get("resize")
    if rs and int(rs.get("w") or 0) > 15 and int(rs.get("h") or 0) > 15:
        im = im.resize((min(8192, int(rs["w"])), min(8192, int(rs["h"]))), Image.LANCZOS)

    im.save(job["out"])
    if job.get("thumbOut"):
        th = im.copy()
        size = int(job.get("thumbSize") or 256)
        th.thumbnail((size, size), Image.LANCZOS)
        th.save(job["thumbOut"])
    print(json.dumps({"ok": True, "out": job["out"], "width": im.width, "height": im.height}))


BLEND_MODES = ("normal", "multiply", "screen", "overlay", "softlight", "add",
               "subtract", "difference", "darken", "lighten")


def _blend(base, top, mode):
    """Photoshop's blend maths on float 0..1 arrays, RGB only."""
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
    return top                                    # normal


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
                         "flipH": false, "anchor": "topleft"|"center" } ],
           "canvas": { "w": int, "h": int, "bg": [r,g,b,a] }|null }

    Layers paint in order, first is bottom. Each layer's own alpha (a cutout's
    transparency, say) multiplies its opacity, so a PNG with holes composites
    the way it looks. Blend maths runs on the OVERLAP only — a 200px logo on a
    4K plate costs 200px of work, not 4K.
    """
    base = Image.open(job["base"]).convert("RGBA")
    canvas = job.get("canvas") or {}
    if int(canvas.get("w") or 0) > 0 and int(canvas.get("h") or 0) > 0:
        bg = tuple((canvas.get("bg") or [0, 0, 0, 0])[:4])
        sheet = Image.new("RGBA", (int(canvas["w"]), int(canvas["h"])), bg)
        sheet.alpha_composite(base, (0, 0))
        base = sheet

    out = np.asarray(base).astype(np.float32) / 255.0
    H, W = out.shape[:2]

    for layer in job.get("layers") or []:
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
        blended = np.clip(_blend(dst[..., :3], crop[..., :3], mode), 0, 1)
        dst[..., :3] = dst[..., :3] * (1 - a) + blended * a
        dst[..., 3:4] = np.clip(dst[..., 3:4] + a * (1 - dst[..., 3:4]), 0, 1)

    im = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA")
    im.save(job["out"])
    if job.get("thumbOut"):
        th = im.copy()
        th.thumbnail((int(job.get("thumbSize") or 256),) * 2, Image.LANCZOS)
        th.save(job["thumbOut"])
    print(json.dumps({"ok": True, "out": job["out"], "width": im.width, "height": im.height,
                      "layers": len(job.get("layers") or [])}))


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
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))


if __name__ == "__main__":
    main()
