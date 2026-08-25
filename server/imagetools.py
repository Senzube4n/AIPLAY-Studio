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

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


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

    # ── the type tool: text lands last, on top of everything ──
    txt = ops.get("text")
    if txt and str(txt.get("content") or "").strip():
        from PIL import ImageDraw, ImageFont
        import os
        draw = ImageDraw.Draw(im)
        size = max(8, min(im.height, int(txt.get("size") or 64)))
        font = None
        # BASENAME ONLY. The client picks from /api/fonts, but ops flow to this
        # process unvalidated, and the raw string used to be handed straight to
        # FreeType — any path on disk got opened and parsed. Fonts come from the
        # font folders or not at all.
        want = os.path.basename(str(txt.get("font") or "arial.ttf"))
        FONT_DIRS = [r"C:\Windows\Fonts", os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")]
        for cand in [os.path.join(d, want) for d in FONT_DIRS if d]:
            try:
                font = ImageFont.truetype(cand, size)
                break
            except OSError:
                continue
        if font is None:
            font = ImageFont.load_default(size)
        color = tuple((txt.get("color") or [255, 255, 255])[:3]) + (255,)
        x, y = int(txt.get("x") or im.width // 2), int(txt.get("y") or im.height // 2)
        anchor = {"left": "lm", "center": "mm", "right": "rm"}.get(str(txt.get("align") or "center"), "mm")
        sw = int(txt.get("stroke") or 0)
        scolor = tuple((txt.get("strokeColor") or [0, 0, 0])[:3]) + (255,)
        draw.text((x, y), str(txt["content"]), font=font, fill=color, anchor=anchor,
                  stroke_width=sw, stroke_fill=scolor if sw else None)

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
    elif mode == "vectorize":
        vectorize(job)
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))


if __name__ == "__main__":
    main()
