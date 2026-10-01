"""Bounded CPU proofs of Studio's generated SVG subset, without a browser.

This is deliberately not a general SVG renderer. It reads the saved XML and
refuses unsupported markup instead of omitting it from a misleading proof.
Paths use imgpath's SVG grammar and antialiased winding rasterizer; adaptive
flattening has an explicit point budget. No script, raster, CSS, font, URL,
entity declaration or external resource can be evaluated by this module.
"""
import base64
import io
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

import imgpath

MAX_BYTES = 16 * 1024 * 1024
MAX_ELEMENTS = 8192
MAX_PATHS = 4096
MAX_TOKENS = 600_000
MAX_ANCHORS = 100_000
MAX_POINTS = 300_000
MAX_CROSSINGS = 2_000_000
MAX_PAINT_PIXELS = 100_000_000
MAX_PIXELS = 1536 * 1536
MAX_COORDINATE = 1_000_000
_SVG_NS = "http://www.w3.org/2000/svg"
_NUM = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,100}$")
_URL = re.compile(r"^url\(#([A-Za-z_][A-Za-z0-9_.-]{0,100})\)$")
_ATTRS = {
    "svg": {"width", "height", "viewBox", "id", "role", "aria-labelledby", "version", "preserveAspectRatio"},
    "metadata": {"id"}, "title": {"id"}, "desc": {"id"}, "defs": {"id"},
    "g": {"id", "fill", "fill-rule", "transform"},
    "path": {"id", "d", "fill", "fill-rule", "transform"},
    "linearGradient": {"id", "gradientUnits", "x1", "y1", "x2", "y2"},
    "stop": {"offset", "stop-color"},
}
_CHILDREN = {"svg": {"metadata", "title", "desc", "defs", "g", "path"},
             "defs": {"linearGradient"}, "g": {"g", "path"},
             "linearGradient": {"stop"}}


def _number(value, label, low=-MAX_COORDINATE, high=MAX_COORDINATE):
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{label} must be a finite number")
    if isinstance(value, str) and not _NUM.fullmatch(value.strip()):
        raise ValueError(f"{label} must be a unitless finite number")
    try:
        number = float(value)
    except (ValueError, TypeError):
        raise ValueError(f"{label} must be a finite number") from None
    if not math.isfinite(number) or number < low or number > high:
        raise ValueError(f"{label} must be between {low} and {high}")
    return number


def _numbers(value, count, label):
    if isinstance(value, str):
        value = re.split(r"[\s,]+", value.strip())
    if not isinstance(value, (list, tuple)) or len(value) != count:
        raise ValueError(f"{label} needs {count} numbers")
    return [_number(v, label) for v in value]


def _color(value):
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return np.asarray([int(value[i:i+2], 16) / 255 for i in (1, 3, 5)], np.float32)
    match = re.fullmatch(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", str(value))
    if match and all(int(v) <= 255 for v in match.groups()):
        return np.asarray([int(v) / 255 for v in match.groups()], np.float32)
    raise ValueError("Proof colors must be #rrggbb or integer rgb(r,g,b)")


def _translation(value):
    if value is None:
        return np.zeros(2)
    match = re.fullmatch(r"translate\(\s*([^()]+)\s*\)", value)
    if not match:
        raise ValueError("Only translate(x y) transforms are supported in vector proofs")
    parts = re.split(r"[\s,]+", match[1].strip())
    if len(parts) not in (1, 2):
        raise ValueError("A translation needs one or two numbers")
    return np.asarray([_number(parts[0], "Translation"), _number(parts[1], "Translation") if len(parts) == 2 else 0])


def _tag(element):
    tag = element.tag
    if not isinstance(tag, str):
        raise ValueError("Unsupported SVG node")
    if tag.startswith("{"):
        namespace, tag = tag[1:].split("}", 1)
        if namespace != _SVG_NS:
            raise ValueError("Unsupported SVG namespace")
    if tag not in _ATTRS:
        raise ValueError(f"Unsupported SVG element: {tag}")
    unknown = set(element.attrib) - _ATTRS[tag]
    if unknown:
        raise ValueError(f"Unsupported {tag} attribute: {sorted(unknown)[0]}")
    if element.get("id") and not _ID.fullmatch(element.get("id")):
        raise ValueError("Unsupported SVG identifier")
    return tag


def _read_svg(file):
    with Path(file).open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Vector proof source exceeds the 16 MiB limit")
    # XML permits UTF-16 too; decode first so a NUL-interleaved declaration
    # cannot evade the declaration check and reach ElementTree's entity reader.
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("Vector proofs require UTF-8 SVG") from None
    if "\x00" in text or re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
        raise ValueError("SVG declarations and entities are not supported")
    if re.search(r"<\?(?!xml\s)[\s\S]*?\?>", text, re.I):
        raise ValueError("SVG processing instructions are not supported")
    for index, _ in enumerate(re.finditer(r"<(?![!?/])", text)):
        if index >= MAX_ELEMENTS:
            raise ValueError("Vector proof exceeds the element limit")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as error:
        raise ValueError(f"Invalid SVG XML: {error}") from None
    if _tag(root) != "svg":
        raise ValueError("Vector proof needs an SVG root")
    ids = set()
    for index, element in enumerate(root.iter()):
        if index >= MAX_ELEMENTS:
            raise ValueError("Vector proof exceeds the element limit")
        tag = _tag(element)
        ident = element.get("id")
        if ident in ids:
            raise ValueError("SVG identifiers must be unique")
        if ident:
            ids.add(ident)
        for child in element:
            if _tag(child) not in _CHILDREN.get(tag, set()):
                raise ValueError(f"Unsupported SVG nesting inside {tag}")
        if tag not in ("metadata", "title", "desc") and (element.text or "").strip():
            raise ValueError("Unexpected text in SVG artwork")
        if (element.tail or "").strip():
            raise ValueError("Unexpected text after SVG artwork")
    return root


def _gradients(root):
    gradients = {}
    for element in root.iter():
        if _tag(element) != "linearGradient":
            continue
        ident = element.get("id")
        if not ident or element.get("gradientUnits") != "userSpaceOnUse":
            raise ValueError("Proof gradients need an id and userSpaceOnUse units")
        ends = np.asarray([_number(element.get(k), "Gradient endpoint") for k in ("x1", "y1", "x2", "y2")]).reshape(2, 2)
        stops = []
        for stop in element:
            offset = stop.get("offset", "")
            percent = offset.endswith("%")
            offset = _number(offset[:-1] if percent else offset, "Gradient stop", 0, 100 if percent else 1) / (100 if percent else 1)
            if stops and offset < stops[-1][0]:
                raise ValueError("Gradient stops must be ordered")
            stops.append((offset, _color(stop.get("stop-color"))))
        if not 2 <= len(stops) <= 8:
            raise ValueError("Proof gradients need 2 to 8 ordered stops")
        gradients[ident] = (ends, stops)
    if len(gradients) > 64:
        raise ValueError("Vector proof exceeds the gradient limit")
    return gradients


def _validate_tokens(tokens):
    if not tokens or tokens[0] not in ("M", "m"):
        raise ValueError("SVG path must begin with moveto")
    index, command = 0, None
    while index < len(tokens):
        if isinstance(tokens[index], str):
            command = tokens[index].upper()
            index += 1
            if command == "Z":
                command = None
                continue
        count = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}.get(command)
        if not count or index + count > len(tokens) or any(isinstance(v, str) for v in tokens[index:index+count]):
            raise ValueError("Invalid SVG path command")
        values = tokens[index:index+count]
        for value in values:
            _number(value, "Path coordinate")
        if command == "A" and (values[0] < 0 or values[1] < 0 or values[3] not in (0, 1) or values[4] not in (0, 1)):
            raise ValueError("SVG arcs need nonnegative radii and binary flags")
        index += count
        if command == "M":
            command = "L"


def _flatten_bounded(bez, budget):
    """Plain adaptive flattening, with at most 1/8 output-pixel chord error."""
    polygons = []
    for contour in bez:
        segments = contour.segments()
        if not segments:
            continue
        points = [segments[0][0]]
        for segment in segments:
            stack = [(np.asarray(segment, np.float64), 0)]
            while stack:
                p, depth = stack.pop()
                if depth >= 20 or imgpath._flat_enough(*p, .125):
                    points.append(p[3])
                    budget["points"] += 1
                    if budget["points"] > MAX_POINTS:
                        raise ValueError("Vector proof exceeds the flattened point limit")
                else:
                    a, b, c = (p[0]+p[1])/2, (p[1]+p[2])/2, (p[2]+p[3])/2
                    d, e = (a+b)/2, (b+c)/2
                    middle = (d+e)/2
                    stack.append((np.asarray([middle, e, c, p[3]]), depth+1))
                    stack.append((np.asarray([p[0], a, d, middle]), depth+1))
        polygons.append(np.asarray(points))
    return polygons


def _proof_mask(polygons, width, height, rule, budget):
    crossings = 0
    for polygon in polygons:
        first = np.clip(np.ceil(polygon[:, 1]*16-.5), 0, height*16)
        following = np.roll(first, -1)
        crossings += int(np.abs(first-following).sum())
    budget["crossings"] += crossings
    if budget["crossings"] > MAX_CROSSINGS:
        raise ValueError("Vector proof exceeds the scanline sample limit")
    coverage = imgpath._rasterize([polygons], [rule], "none", 0, 0, width, height, samples=16)
    return np.zeros((height, width), np.float32) if coverage is None else coverage


def _paint_bounds(polygons, width, height):
    """Clip a path's proof allocation to its visible output-pixel rectangle.

    A one-pixel border covers the flattening tolerance and antialiasing at
    fractional edges. Retain all subpaths together so winding and counters
    keep their meaning even when the rectangle intersects a detail crop.
    """
    if not polygons:
        return None
    low = np.min([p.min(axis=0) for p in polygons], axis=0)
    high = np.max([p.max(axis=0) for p in polygons], axis=0)
    x0, y0 = max(0, math.floor(low[0])-1), max(0, math.floor(low[1])-1)
    x1, y1 = min(width, math.ceil(high[0])+1), min(height, math.ceil(high[1])+1)
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def review_svg(job):
    """Return native PNG image content of the actual saved, restricted SVG."""
    if not isinstance(job, dict) or not isinstance(job.get("in"), str) or not job["in"]:
        raise ValueError("Vector review needs a saved SVG input path")
    max_edge = _number(job.get("maxEdge", 768), "maxEdge", 256, 1536)
    if not max_edge.is_integer():
        raise ValueError("maxEdge must be an integer")
    root = _read_svg(job["in"])
    sw, sh = [_number(root.get(k), "SVG source size", 1, 16384) for k in ("width", "height")]
    vx, vy, vw, vh = _numbers(root.get("viewBox"), 4, "SVG viewBox")
    if vw <= 0 or vh <= 0:
        raise ValueError("SVG viewBox must have positive dimensions")
    aspect = root.get("preserveAspectRatio", "xMidYMid meet")
    if aspect not in ("xMidYMid meet", "xMidYMid", "none"):
        raise ValueError("Unsupported SVG aspect ratio mapping")
    crop = _numbers(job["crop"], 4, "crop") if "crop" in job else [0, 0, sw, sh]
    cx, cy, cw, ch = crop
    if cx < 0 or cy < 0 or cw < 1 or ch < 1 or cx+cw > sw+1e-8 or cy+ch > sh+1e-8:
        raise ValueError("crop must be a positive source-pixel rectangle inside the SVG")
    scale = max_edge / max(cw, ch)
    width, height = max(1, round(cw*scale)), max(1, round(ch*scale))
    if width*height > MAX_PIXELS:
        raise ValueError("Vector proof exceeds the pixel limit")
    resize = np.asarray([width/cw, height/ch])
    viewport_scale = np.asarray([sw/vw, sh/vh])
    if aspect != "none":
        viewport_scale[:] = min(viewport_scale)
    viewport_offset = (np.asarray([sw, sh])-np.asarray([vw, vh])*viewport_scale)/2-np.asarray([vx, vy])*viewport_scale
    transform_scale = viewport_scale*resize
    transform_offset = (viewport_offset-np.asarray([cx, cy]))*resize
    background = job.get("background", "#ffffff")
    canvas = np.zeros((height, width, 4), np.float32)
    if background != "transparent":
        canvas[..., :3] = _color(background)
        canvas[..., 3] = 1
    gradients = _gradients(root)
    budget = {"tokens": 0, "anchors": 0, "points": 0, "crossings": 0, "paths": 0, "paintPixels": 0}
    notes = ["CPU proof supports Studio path fills, user-space linear gradients and translations; unsupported SVG is refused.",
             "Elliptical arcs are approximated by cubic curves for the CPU preview."]

    def paint(element, inherited_fill="#000000", inherited_rule="nonzero", translation=None, depth=0):
        if depth > 32:
            raise ValueError("Vector proof exceeds the group nesting limit")
        tag = _tag(element)
        if tag not in ("svg", "g", "path"):
            return
        translation = np.zeros(2) if translation is None else translation
        translation = translation + _translation(element.get("transform"))
        fill = element.get("fill", inherited_fill)
        rule = element.get("fill-rule", inherited_rule)
        if rule not in ("evenodd", "nonzero"):
            raise ValueError("Unsupported SVG fill rule")
        if tag != "path":
            for child in element:
                paint(child, fill, rule, translation, depth+1)
            return
        budget["paths"] += 1
        if budget["paths"] > MAX_PATHS:
            raise ValueError("Vector proof exceeds the path limit")
        path_data = element.get("d", "")
        tokens = imgpath._svg_tokens(path_data)
        budget["tokens"] += len(tokens)
        if budget["tokens"] > MAX_TOKENS:
            raise ValueError("Vector proof exceeds the path-token limit")
        # An empty generated SVG or an intentionally empty path is ordinary.
        if not tokens:
            return
        _validate_tokens(tokens)
        paths = imgpath._bez_from_d(path_data, [], "vector proof: ")
        for path in paths:
            budget["anchors"] += len(path.a)
            if budget["anchors"] > MAX_ANCHORS:
                raise ValueError("Vector proof exceeds the anchor limit")
            path.a = ((path.a.reshape(-1, 2)+translation)*transform_scale+transform_offset).reshape(-1, 6)
            if not np.all(np.isfinite(path.a)):
                raise ValueError("Invalid transformed SVG path")
        if fill == "none":
            return
        gradient_match = _URL.fullmatch(fill)
        if gradient_match:
            if gradient_match[1] not in gradients:
                raise ValueError("SVG gradient reference was not found")
            gradient = gradients[gradient_match[1]]
        else:
            solid, gradient = _color(fill), None
        polygons = _flatten_bounded(paths, budget)
        bounds = _paint_bounds(polygons, width, height)
        if bounds is None:
            return
        x0, y0, x1, y1 = bounds
        roi_width, roi_height = x1-x0, y1-y0
        budget["paintPixels"] += roi_width*roi_height
        if budget["paintPixels"] > MAX_PAINT_PIXELS:
            raise ValueError("Vector proof exceeds its painted-pixel budget")
        local_polygons = [p-np.asarray([x0, y0]) for p in polygons]
        alpha = _proof_mask(local_polygons, roi_width, roi_height, rule, budget)
        if not np.any(alpha):
            return
        if gradient:
            ends, stops = gradient
            ends = (ends+translation)*transform_scale+transform_offset
            delta = ends[1]-ends[0]
            den = float(np.dot(delta, delta))
            if den < 1e-20:
                rgb = stops[-1][1]
            else:
                # Endpoints remain in full proof coordinates; shifting only
                # the mask must not restart a gradient at each shape's ROI.
                x = np.arange(x0, x1, dtype=np.float32)[None, :]+.5
                y = np.arange(y0, y1, dtype=np.float32)[:, None]+.5
                t = ((x-ends[0, 0])*delta[0]+(y-ends[0, 1])*delta[1])/den
                offsets = [s[0] for s in stops]
                colors = np.asarray([s[1] for s in stops])
                rgb = np.stack([np.interp(t, offsets, colors[:, c]) for c in range(3)], axis=-1).astype(np.float32)
        else:
            rgb = solid
        # Premultiplied compositing keeps holes and transparent backgrounds
        # correct, including a translated shadow beneath foreground artwork.
        target = canvas[y0:y1, x0:x1]
        target[..., :3] = rgb*alpha[..., None]+target[..., :3]*(1-alpha[..., None])
        target[..., 3] = alpha+target[..., 3]*(1-alpha)

    paint(root)
    canvas[..., :3] /= np.maximum(canvas[..., 3:4], 1e-20)
    pixels = np.clip(np.rint(canvas*255), 0, 255).astype(np.uint8)
    stream = io.BytesIO()
    Image.fromarray(pixels, "RGBA").save(stream, format="PNG")
    return {"ok": True, "image": {"mimeType": "image/png", "data": base64.b64encode(stream.getvalue()).decode("ascii")},
            "width": width, "height": height, "sourceWidth": sw, "sourceHeight": sh,
            "crop": crop, "renderer": "aiplay-vector-cpu", "notes": notes}
