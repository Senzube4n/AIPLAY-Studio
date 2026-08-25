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

    sh = float(ops.get("sharpen") or 0.0)
    if sh > 0.01:
        im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=int(sh * 1.5), threshold=2))
    bl = float(ops.get("blur") or 0.0)
    if bl > 0.01:
        im = im.filter(ImageFilter.GaussianBlur(radius=min(20.0, bl)))

    im.save(job["out"])
    if job.get("thumbOut"):
        th = im.copy()
        size = int(job.get("thumbSize") or 256)
        th.thumbnail((size, size), Image.LANCZOS)
        th.save(job["thumbOut"])
    print(json.dumps({"ok": True, "out": job["out"], "width": im.width, "height": im.height}))


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
    elif mode == "vectorize":
        vectorize(job)
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))


if __name__ == "__main__":
    main()
