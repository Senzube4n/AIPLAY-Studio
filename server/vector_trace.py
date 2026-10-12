"""RGBA-aware vectorization shared by the image HTTP and MCP entry points.

CPU-only NumPy, OpenCV, SciPy and Pillow are already in the image runtime.
Geometry is approximate, bounded cubic fitting; gradients are explicit fills,
never inferred from a posterized raster. No extra engine or model is needed.
"""
import html
import hashlib
import json
import math
import os
import re
import tempfile

import cv2
import numpy as np
from PIL import Image

from vector_curves import MAX_CONTOURS, MAX_POINTS, MAX_SEGMENTS, TraceLimitError, trace_mask
from vector_cleanup import cleanup_mask, normalize_cleanup
from vector_composition import normalize_composition, select, bounds_for, compound_parts

MAX_SOURCE_PIXELS = 40_000_000
MAX_SOURCE_SIDE = 16384
MAX_SVG_BYTES = 16_000_000
_PROFILES = {"draft": (1.5, 1024), "standard": (.8, 4096), "high": (.5, 4096)}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _number(job, name, default, low, high, integer=False):
    value = job.get(name, default)
    if value is None:
        value = default
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number") from None
    if not math.isfinite(number) or number < low or number > high or (integer and not number.is_integer()):
        raise ValueError(f"{name} must be {'an integer' if integer else 'a number'} from {low} to {high}")
    return int(number) if integer else number


def _color(value):
    if not isinstance(value, str) or not _HEX.fullmatch(value):
        raise ValueError("Gradient colors must use #rrggbb")
    return value.lower()


def _gradients(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 16:
        raise ValueError("gradients must be an array of at most 16 explicit fills")
    result, used = [], set()
    for gradient in value:
        if not isinstance(gradient, dict):
            raise ValueError("Each gradient must be an object")
        color = _color(gradient.get("color"))
        if color in used:
            raise ValueError("Each palette color can have only one gradient")
        used.add(color)
        stops = gradient.get("stops")
        if not isinstance(stops, list) or not 2 <= len(stops) <= 8:
            raise ValueError("Each gradient needs 2 to 8 stops")
        parsed = []
        for stop in stops:
            if not isinstance(stop, dict):
                raise ValueError("Each gradient stop must be an object")
            offset = _number(stop, "offset", None, 0, 1)
            if parsed and offset < parsed[-1]["offset"]:
                raise ValueError("Gradient stops must be ordered by offset")
            parsed.append({"offset": offset, "color": _color(stop.get("color"))})
        result.append({"color": color, "angle": _number(gradient, "angle", 0, 0, 360), "stops": parsed})
    return result


def settings_for(job):
    mode = job.get("mode", "logo")
    quality = job.get("quality", "standard")
    if mode not in ("logo", "silhouette", "posterize"):
        raise ValueError("mode must be logo, silhouette or posterize")
    if quality not in _PROFILES:
        raise ValueError("quality must be draft, standard or high")
    tolerance, size = _PROFILES[quality]
    result = {"mode": mode, "quality": quality,
            "colors": _number(job, "colors", 6, 2, 16, True),
            "detail": _number(job, "detail", 1, .2, 4),
            "tolerance": _number(job, "tolerance", tolerance, .15, 4),
            "minArea": _number(job, "minArea", 1, 0, 10000),
            "alphaThreshold": _number(job, "alphaThreshold", 128, 1, 255, True),
            "maxSize": _number(job, "maxSize", size, 64, 4096, True),
            "gradients": _gradients(job.get("gradients"))}
    if "cleanup" in job:
        result["cleanup"] = normalize_cleanup(job["cleanup"])
    if "composition" in job:
        result["composition"] = normalize_composition(job["composition"])
    if "basis" in job:
        if not isinstance(job["basis"], str) or not re.fullmatch(r'[0-9a-f]{64}',job["basis"]):
            raise ValueError("basis must be a traceFingerprint from the initial trace")
        result["basis"] = job["basis"]
    if (result.get('cleanup',{}).get('operations') or any(result.get('composition',{}).values())) and not result.get('basis'):
        raise ValueError("Trace first and supply its traceFingerprint as basis")
    return result


def _load(path, max_size):
    try:
        return _decode_source(path,max_size)
    except (OSError,Image.DecompressionBombError) as exc:
        raise ValueError('Source image could not be decoded; use a valid bounded PNG, JPEG or WebP') from exc


def _decode_source(path, max_size):
    # Inspect the header before decoding or converting source pixels.
    with Image.open(path) as source:
        sw, sh = source.size
        if sw < 1 or sh < 1 or max(sw, sh) > MAX_SOURCE_SIDE or sw*sh > MAX_SOURCE_PIXELS:
            raise ValueError("Vectorization supports source images up to 40 megapixels and 16384 pixels per side")
        rgba = source.convert("RGBA")
        scale = min(1., max_size/max(sw, sh))
        w, h = max(1, round(sw*scale)), max(1, round(sh*scale))
        if (w, h) != (sw, sh):
            # Float premultiplication avoids both hidden-RGB bleed and 8-bit
            # RGBa rounding that invents several edge colors for a flat logo.
            pixels = np.asarray(rgba, dtype=np.uint8)
            alpha = pixels[..., 3].astype(np.float32)/255
            resized_alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_AREA)
            resized = np.empty((h, w, 4), dtype=np.uint8)
            for channel in range(3):
                weighted = pixels[..., channel].astype(np.float32)
                weighted *= alpha
                weighted = cv2.resize(weighted, (w, h), interpolation=cv2.INTER_AREA)
                resized[..., channel] = np.clip(np.rint(weighted/np.maximum(resized_alpha, 1e-8)), 0, 255).astype(np.uint8)
            resized[..., 3] = np.clip(np.rint(resized_alpha*255), 0, 255).astype(np.uint8)
            return resized, (sw, sh)
        return np.asarray(rgba, dtype=np.uint8), (sw, sh)


def _palette_labels(rgba, settings):
    visible = rgba[..., 3] >= settings["alphaThreshold"]
    if settings["mode"] == "silhouette":
        # Trace transparency independently of the raster's gradient bands.
        # One neutral fill gives the explicit gradient workflow a stable key.
        return np.where(visible, 0, -1).astype(np.int16), (["#808080"] if np.any(visible) else []), visible
    rgb = rgba[..., :3].copy()
    if settings["mode"] == "posterize":
        # Normalized convolution: transparent RGB is excluded from the blur
        # as well as palette sampling and geometry.
        weights = visible.astype(np.float32)
        denominator = cv2.GaussianBlur(weights, (0, 0), .6)
        for channel in range(3):
            numerator = cv2.GaussianBlur(rgb[..., channel].astype(np.float32)*weights, (0, 0), .6)
            rgb[..., channel] = np.clip(np.rint(numerator/np.maximum(denominator, 1e-8)), 0, 255).astype(np.uint8)
    positions = np.flatnonzero(visible.reshape(-1))
    labels = np.full(visible.shape, -1, dtype=np.int16)
    if not len(positions):
        return labels, [], visible
    flat = rgb.reshape(-1, 3)
    sample_ids = positions if len(positions) <= 200000 else positions[np.linspace(0, len(positions)-1, 200000, dtype=np.int64)]
    sample = flat[sample_ids]
    unique = np.unique(sample, axis=0)
    if len(unique) <= settings["colors"]:
        colors = unique
    else:
        quantized = Image.fromarray(sample.reshape(1, -1, 3), "RGB").quantize(
            colors=settings["colors"], method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        palette = np.asarray(quantized.getpalette(), dtype=np.uint8).reshape(-1, 3)
        colors = np.unique(palette[np.unique(np.asarray(quantized))], axis=0)
    colors = colors.astype(np.int32)
    flat_labels = labels.reshape(-1)
    for offset in range(0, len(positions), 200000):
        ids = positions[offset:offset+200000]
        pixels = flat[ids].astype(np.int32)
        best = np.full(len(ids), np.iinfo(np.int32).max, dtype=np.int32)
        choice = np.zeros(len(ids), dtype=np.int16)
        for index, color in enumerate(colors):
            distance = np.sum((pixels-color)**2, axis=1)
            better = distance < best
            best[better], choice[better] = distance[better], index
        flat_labels[ids] = choice
    hexes = ["#"+"".join(f"{int(channel):02x}" for channel in color) for color in colors]
    return labels, hexes, visible


def _gradient_xml(gradient, ident, width, height, bounds=None):
    radians = math.radians(gradient["angle"])
    dx, dy = math.cos(radians), math.sin(radians)
    x,y,bw,bh = bounds or [0,0,width,height]
    extent = abs(dx)*bw/2+abs(dy)*bh/2
    cx, cy = x+bw/2, y+bh/2
    # Every fill uses one image-coordinate system, including disjoint shapes.
    coords = [cx-dx*extent, cy-dy*extent, cx+dx*extent, cy+dy*extent]
    attributes = " ".join(f'{name}="{value:.6f}"' for name, value in zip(("x1", "y1", "x2", "y2"), coords))
    stops = "".join(f'<stop offset="{stop["offset"]:.6f}" stop-color="{stop["color"]}"/>' for stop in gradient["stops"])
    return f'<linearGradient id="{ident}" gradientUnits="userSpaceOnUse" {attributes}>{stops}</linearGradient>'


def _atomic_write(path, text):
    directory = os.path.dirname(os.path.abspath(path))
    fd, staging = tempfile.mkstemp(prefix="."+os.path.basename(path)+".vector-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
        os.replace(staging, path)
    finally:
        if os.path.exists(staging):
            os.unlink(staging)


def trace_image(job):
    settings = settings_for(job)
    source_path, out = job.get("in"), job.get("out")
    if not isinstance(source_path, str) or not source_path or not isinstance(out, str) or not out:
        raise ValueError("Vectorization needs input and output paths")
    rgba, (sw, sh) = _load(source_path, settings["maxSize"])
    h, w = rgba.shape[:2]
    sx, sy = w/sw, h/sh
    base_settings={k:v for k,v in settings.items() if k not in ('basis','cleanup','composition','gradients')}
    digest=hashlib.sha256()
    digest.update(json.dumps([sw,sh,base_settings],sort_keys=True,separators=(',',':')).encode())
    digest.update(rgba.tobytes())
    fingerprint=digest.hexdigest()
    if settings.get('basis') and settings['basis'] != fingerprint:
        raise ValueError('Trace basis is stale. Retrace the current source and settings before selecting outlines.')
    labels, palette, visible = _palette_labels(rgba, settings)
    warnings = []
    if (w, h) != (sw, sh):
        warnings.append(f"Source resized from {sw} x {sh} to {w} x {h}; fine features may be lost.")
    if np.any((rgba[..., 3] > 0) & (rgba[..., 3] < 255)):
        warnings.append("Continuous alpha is approximated by the alpha threshold; soft opacity is not preserved.")
    if not np.any(visible):
        warnings.append("No pixels meet the alpha threshold; the SVG is empty.")
    if settings["mode"] == "posterize":
        warnings.append("Posterize produces flat color regions; raster gradients are not reconstructed.")
    if settings["mode"] == "silhouette" and np.all(visible):
        warnings.append("This image has no transparent background; Alpha shapes traces the whole canvas.")
    if settings["gradients"]:
        warnings.append("Explicit gradient fills were applied to palette regions; gradients were not inferred.")
    gradient_map = {gradient["color"]: gradient for gradient in settings["gradients"]}
    absent = sorted(set(gradient_map)-set(palette))
    if absent:
        raise ValueError("Gradient palette color was not found: "+", ".join(absent))
    counts = np.bincount(labels[visible], minlength=len(palette)) if palette else []
    order = sorted(range(len(palette)), key=lambda i: (-int(counts[i]), palette[i]))
    paths, definitions, actual_palette, shapes, inventory, cleanup_receipts = [], [], [], [], {}, []
    stats = {"contours": 0, "holes": 0, "boundaryPoints": 0, "segments": 0,
             "cubicSegments": 0, "lineSegments": 0, "ellipses": 0, "removedComponents": 0,
             "visiblePixels": int(np.count_nonzero(visible)), "traceWidth": w, "traceHeight": h,
             "scaleX": sx, "scaleY": sy}
    # Error and component area remain in source coordinates after resizing.
    effective_error = settings["tolerance"]*min(sx, sy)
    effective_area = settings["minArea"]*sx*sy
    for index in order:
        color = palette[index]
        operations=[{**op,'maxDeviation':op['maxDeviation']*min(sx,sy)} for op in settings.get('cleanup',{}).get('operations',[]) if op['color']==color]
        tracer=cleanup_mask if operations else trace_mask
        parts, info = tracer(labels == index, **({'operations':operations} if operations else {}), error=effective_error, detail=settings["detail"],
                                 min_area=effective_area, return_info=True,
                                 limits={"points": MAX_POINTS-stats["boundaryPoints"],
                                         "contours": MAX_CONTOURS-stats["contours"],
                                         "segments": MAX_SEGMENTS-stats["segments"]})
        stats["removedComponents"] += info["removed_components"]
        stats["boundaryPoints"] += info["source_points"]
        stats["segments"] += info["segments"]
        stats["ellipses"] += info["ellipses"]
        stats["contours"] += len(info["contours"])
        stats["holes"] += sum(contour["hole"] for contour in info["contours"])
        if not parts:
            continue
        inventory[color]=(parts,info['contours'])
        for i,c in enumerate(info['contours']):
            if len(shapes) < 512:
                x,y,bw,bh=c['bounds']
                shapes.append({'id':f'{color[1:]}-c{i}','color':color,'contour':i,'bounds':[x/sx,y/sy,bw/sx,bh/sy],
                               'area':c['area']/(sx*sy),'hole':c['hole'],'parent':c.get('parent'),'segments':c['segments']})
        for receipt in info.get('cleanup',[]):
            clean={**receipt,'color':color,'primitiveCoordinateSpace':'tracePixels'}
            for key in ('maxDeviation','measuredSourceToCurve','measuredCurveToSource','samplingSpacing'):
                if key in clean: clean[key]/=min(sx,sy)
            clean['measurements']=[{**m,'sourceToCurve':m['sourceToCurve']/min(sx,sy),'curveToSource':m['curveToSource']/min(sx,sy)} for m in receipt.get('measurements',[])]
            clean['topology']=info.get('cleanupTopology')
            cleanup_receipts.append(clean)
        d = "".join(parts)
        stats["cubicSegments"] += d.count("C")
        stats["lineSegments"] += d.count("L")
        fill = color
        if color in gradient_map:
            ident = f"gradient-{len(definitions)}"
            definitions.append(_gradient_xml(gradient_map[color], ident, w, h))
            fill = f"url(#{ident})"
        for contour_id,compound in compound_parts(parts,info['contours']):
            paths.append(f'<path id="palette-{index}-shape-{contour_id}" fill="{fill}" fill-rule="evenodd" d="{compound}"/>')
        actual_palette.append(color)
        if sum(len(path) for path in paths) > MAX_SVG_BYTES:
            raise TraceLimitError("Trace exceeds the SVG byte limit; lower colors or use Draft quality.")
    # An explicit gradient must correspond to a retained region, not a pruned
    # palette entry that silently lost the requested fill.
    pruned = sorted(set(gradient_map)-set(actual_palette))
    if pruned:
        raise ValueError("Gradient palette region was removed by Minimum area: "+", ".join(pruned))
    missing_ops=sorted({op['color'] for op in settings.get('cleanup',{}).get('operations',[])}-set(inventory))
    if missing_ops:
        raise ValueError('Cleanup palette color was not retained: '+', '.join(missing_ops))
    composition=settings.get('composition',{})
    if any(composition.values()):
        omitted=set()
        for selection in composition['omit']:
            select(selection,inventory,complete='omit')
            omitted.update((selection['color'],i) for i in selection['contours'])
        filled=set()
        fill_paths=[]
        for i,selection in enumerate(composition['fills']):
            excluded={c for color,c in omitted if color==selection['color']}
            d,chosen=select(selection,inventory,complete=True,excluded=excluded)
            keys={(selection['color'],c) for c in selection['contours']}
            if keys&omitted: raise ValueError('An omitted outline cannot also receive a fill')
            filled.update(keys)
            fill=selection.get('solid')
            if 'gradient' in selection:
                ident=f'selected-gradient-{i}'
                b=selection['gradient'].get('bounds')
                b=[b[0]*sx,b[1]*sy,b[2]*sx,b[3]*sy] if b else bounds_for(chosen)
                definitions.append(_gradient_xml(selection['gradient'],ident,w,h,b))
                fill=f'url(#{ident})'
            parts,contours=inventory[selection['color']]
            for contour_id,compound in compound_parts(parts,contours,selection['contours']):
                fill_paths.append(f'<path id="selected-fill-{i}-shape-{contour_id}" fill="{fill}" fill-rule="evenodd" d="{compound}"/>')
        paths=[]
        for index in order:
            color=palette[index]
            if color not in inventory: continue
            parts,contours=inventory[color]
            ids=[i for i in range(len(parts)) if (color,i) not in omitted|filled]
            if not ids: continue
            fill=color
            if color in gradient_map:
                ident=f'palette-gradient-{index}'
                definitions.append(_gradient_xml(gradient_map[color],ident,w,h))
                fill=f'url(#{ident})'
            for contour_id,compound in compound_parts(parts,contours,ids):
                paths.append(f'<path id="palette-{index}-shape-{contour_id}" fill="{fill}" fill-rule="evenodd" d="{compound}"/>')
        shadow_paths=[]
        for i,selection in enumerate(composition['shadows']):
            excluded={c for color,c in omitted if color==selection['color']}
            d,_=select(selection,inventory,complete=True,excluded=excluded)
            dx,dy=selection['offset']
            parts,contours=inventory[selection['color']]
            for contour_id,compound in compound_parts(parts,contours,selection['contours']):
                shadow_paths.append(f'<path id="selected-shadow-{i}-shape-{contour_id}" fill="{selection["fill"]}" fill-rule="evenodd" transform="translate({dx*sx:.6f} {dy*sy:.6f})" d="{compound}"/>')
        paths=shadow_paths+paths+fill_paths
        warnings.append('Selected fills, shadows and omissions are explicit edits; review the saved SVG at high zoom.')
    if stats["removedComponents"]:
        warnings.append(f'{stats["removedComponents"]} components smaller than Minimum area were removed.')
    settings["effectiveTraceTolerance"] = effective_error
    settings["effectiveTraceMinArea"] = effective_area
    result = {"ok": True, "out": out, "paths": len(paths), "colors": len(actual_palette),
              "sourceWidth": sw, "sourceHeight": sh, "width": w, "height": h,
              "settings": settings, "palette": actual_palette, "stats": stats, "warnings": warnings}
    result.update(traceFingerprint=fingerprint,shapes=shapes,shapesTruncated=stats['contours']>len(shapes),cleanup=cleanup_receipts)
    result['replay']={'name':os.path.basename(source_path),
                      **{k:v for k,v in settings.items() if k not in ('effectiveTraceTolerance','effectiveTraceMinArea')},
                      'basis':fingerprint}
    if result['shapesTruncated']:
        warnings.append('Outline inventory is limited to 512 entries; simplify complex artwork before selecting outlines.')
    # The embedded receipt matches the returned fields. Iterate the byte count
    # until its digit count stabilizes, so metadata reports the actual bytes.
    result["bytes"] = 0
    for _ in range(4):
        metadata = html.escape(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{sw}" height="{sh}">'
               f'<metadata>{metadata}</metadata>'
               +(f'<defs>{"".join(definitions)}</defs>' if definitions else "")+"".join(paths)+"</svg>")
        size = len(svg.encode("utf-8"))
        if size == result["bytes"]:
            break
        result["bytes"] = size
    if size > MAX_SVG_BYTES:
        raise TraceLimitError("Trace exceeds the SVG byte limit; lower colors or use Draft quality.")
    _atomic_write(out, svg)
    return result
