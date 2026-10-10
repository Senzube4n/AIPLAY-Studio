"""Bake saved Studio image-document layers for StandRig's PSD-only importer.

The PSD writer lives in the Node wrapper. This stage uses imgdoc's own renderer
for every part, so a transform, mask or source alpha has the same pixels as the
editor's full-resolution preview. It never invents separation from a photo.
"""
from __future__ import annotations

import copy
import json
import os
import sys
from PIL import Image

_SERVER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER not in sys.path:
    sys.path.insert(0, _SERVER)

import imgdoc  # noqa: E402
import numpy as np  # noqa: E402

MAX_PIXELS = 4_194_304
MAX_PARTS = 32
MAX_RAW_BYTES = 40 * 1024 * 1024
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_PIXELS = 16_777_216


def _source_names(layers):
    for layer in layers:
        if layer.get("type") == "image" and layer.get("src"):
            yield layer["src"]
        mask = layer.get("mask")
        if isinstance(mask, dict) and mask.get("src"):
            yield mask["src"]
        if layer.get("type") == "group":
            yield from _source_names(layer.get("layers") or [])


def _sources(image_dir, doc):
    root = os.path.realpath(image_dir)
    table = {}
    for name in set(_source_names(doc["layers"])):
        if not isinstance(name, str) or not name or name != os.path.basename(name) or "\\" in name:
            raise ValueError("A layer source must be a filename on the image shelf.")
        full = os.path.realpath(os.path.join(root, name))
        if os.path.commonpath((root, full)) != root or not os.path.isfile(full):
            raise ValueError(f'Image shelf source "{name}" is missing or outside the shelf.')
        if os.stat(full).st_size > MAX_SOURCE_BYTES:
            raise ValueError(f'Image shelf source "{name}" exceeds 32 MiB.')
        with Image.open(full) as source:
            if source.width * source.height > MAX_SOURCE_PIXELS:
                raise ValueError(f'Image shelf source "{name}" exceeds 16,777,216 pixels.')
        table[name] = full
    return table


def _reject_group_effects(layer):
    transform = layer.get("transform") or {}
    return bool(layer.get("clipped") or layer.get("mask") or layer.get("styles")
                or layer.get("effects") or layer.get("ops")
                or layer.get("blend", "normal") != "normal"
                or any(key in transform for key in ("anchor", "position", "scale", "rotation"))
                or float(transform.get("opacity", 100)) != 100)


def _tree(layers):
    tree = []
    for layer in layers:
        kind = layer["type"]
        if kind == "adjustment":
            raise ValueError(f'Adjustment layer "{layer["name"]}" depends on the stack; bake it into each affected part first.')
        if layer.get("clipped") or layer.get("blend", "normal") != "normal":
            raise ValueError(f'Layer "{layer["name"]}" uses clipping or a blend mode; bake it into a part before export.')
        # PSD records visibility independently for each group and child. A
        # hidden parent must not erase the saved visibility of its children.
        invisible = layer.get("enabled") is False
        if kind == "group":
            if _reject_group_effects(layer):
                raise ValueError(f'Group "{layer["name"]}" has a mask, transform, effect or opacity; bake that group first.')
            tree.append({"name": layer["name"], "type": "group", "hidden": invisible,
                         "children": _tree(layer.get("layers") or [])})
        else:
            tree.append({"name": layer["name"], "type": kind, "hidden": invisible, "layer": layer})
    return tree


def _leaves(tree):
    for node in tree:
        if node["type"] == "group":
            yield from _leaves(node["children"])
        else:
            yield node


def prepare(job):
    image_dir = os.path.realpath(job["imageDir"])
    scratch = os.path.realpath(job["scratch"])
    opened = imgdoc.store_job({"dir": image_dir, "action": "open", "id": job["id"]})
    doc = opened["doc"]
    if opened.get("warnings"):
        raise ValueError("The saved document needs repair before PSD export: " + "; ".join(opened["warnings"][:3]))
    width, height = doc["width"], doc["height"]
    if width < 4 or height < 4:
        raise ValueError("PSD export needs a canvas at least 4 by 4 pixels.")
    if width * height > MAX_PIXELS:
        raise ValueError("PSD export supports at most 4,194,304 canvas pixels. Resize this document first.")
    if len(doc.get("bg") or []) >= 4 and float(doc["bg"][3]) > 0:
        raise ValueError("The document background is opaque. Move it to its own layer or set the background transparent.")
    tree = _tree(doc["layers"])
    leaves = list(_leaves(tree))
    if not 2 <= len(leaves) <= MAX_PARTS:
        raise ValueError("StandRig needs 2 to 32 separately painted layers. A flat picture cannot be separated by export.")
    if width * height * 4 * len(leaves) > MAX_RAW_BYTES:
        raise ValueError("The layers exceed the 40 MiB raw-pixel export budget. Resize or split this document.")
    sources = _sources(image_dir, doc)
    resolve = imgdoc.resolver_for(sources)
    os.makedirs(scratch, exist_ok=True)
    warnings = []
    for index, node in enumerate(leaves):
        layer = copy.deepcopy(node.pop("layer"))
        layer["enabled"] = True  # hidden is stored in the PSD after baking pixels
        isolated = {**doc, "bg": [0, 0, 0, 0], "layers": [layer]}
        report = {}
        rgba = imgdoc.render(isolated, resolve, 1.0, report)
        if report["missing"] or report["warnings"]:
            raise ValueError(f'Layer "{node["name"]}" could not be baked faithfully: '
                             + "; ".join((report["warnings"] or report["missing"])[:3]))
        pixels = imgdoc.to_uint8(rgba)
        alpha = pixels[..., 3]
        if not np.any(alpha):
            raise ValueError(f'Layer "{node["name"]}" has no painted pixels. Remove or paint it first.')
        if np.count_nonzero(alpha) > width * height * 0.95:
            warnings.append(f'Layer "{node["name"]}" covers nearly the full canvas; check its part separation.')
        file = f"part_{index:02d}.rgba"
        pixels.tofile(os.path.join(scratch, file))
        node["raw"] = file
        node["width"] = width
        node["height"] = height
    composite_report = {}
    composite = imgdoc.render(doc, resolve, 1.0, composite_report)
    if composite_report["missing"] or composite_report["warnings"]:
        raise ValueError("The full document could not be rendered faithfully: "
                         + "; ".join((composite_report["warnings"] or composite_report["missing"])[:3]))
    imgdoc.to_uint8(composite).tofile(os.path.join(scratch, "composite.rgba"))
    return {"ok": True, "width": width, "height": height, "tree": tree,
            "warnings": warnings, "sourceDocumentId": doc["id"],
            "sourceDocumentUpdatedAt": doc["updatedAt"]}


if __name__ == "__main__":
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as stream:
            print(json.dumps(prepare(json.load(stream))))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
