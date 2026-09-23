"""CPU-only preparation, document preview and exact masked Qwen composition.

Qwen Image 2.1 consumes references, not an inpainting mask. The selection is
resolved against a frozen source before generation, then applied here afterwards.
"""
import base64
import copy
import hashlib
import io
import json
import os
import sys

import numpy as np
from PIL import Image
import imgdoc
import imgselect


def revision(doc):
    return hashlib.sha256(json.dumps(doc, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def library_path(directory, name):
    if not isinstance(name, str) or not name or name != os.path.basename(name) \
            or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("Use a library image filename, not a path.")
    path = os.path.join(directory, name)
    if not os.path.isfile(path):
        raise ValueError(f"Image is missing: {name}")
    return path


def open_doc(job):
    return imgdoc.store_job({"dir": job["dir"], "action": "open", "id": job["documentId"]})["doc"]


def render_doc(doc, directory):
    sources = {}
    def walk(layers):
        for layer in layers:
            for name in (layer.get("src"), (layer.get("mask") or {}).get("src")):
                if name:
                    sources[name] = library_path(directory, name)
            walk(layer.get("layers") or [])
    walk(doc.get("layers") or [])
    if int(doc.get("width", 0)) * int(doc.get("height", 0)) > 16_777_216:
        raise ValueError("The editor preview supports up to 16 megapixels.")
    report = {}
    pixels = imgdoc.render(doc, imgdoc.resolver_for(sources), 1, report)
    if report.get("missing"):
        raise ValueError("Document sources are missing: " + ", ".join(report["missing"]))
    return Image.fromarray(imgdoc.to_uint8(pixels), "RGBA"), report.get("warnings", [])


def preview(job):
    doc = open_doc(job) if job.get("documentId") else imgdoc.normalize(job.get("doc"))
    image, warnings = render_doc(doc, job["dir"])
    data = io.BytesIO()
    image.save(data, format="PNG")
    return {"dataUrl": "data:image/png;base64," + base64.b64encode(data.getvalue()).decode("ascii"),
            "width": image.width, "height": image.height, "revision": revision(doc), "warnings": warnings,
            "paintTargets": paint_targets(doc, job["dir"])}


PAINT_GUIDANCE = "Use Documents → Render & open composite to paint flattened pixels, or Qwen edit on the composed document."


def paint_targets(doc, directory):
    """Conservative eligibility; never pretend canvas coordinates are local.

    Reuse the renderer's affine calculation, including its implicit centering.
    Brushes and pixel-sampling selections need more than transformed endpoints
    for inverse mapping, so unsupported transforms are refused explicitly.
    """
    result = {}
    width, height = doc["width"], doc["height"]
    identity = np.array([[1., 0., 0.], [0., 1., 0.]])
    def walk(layers, ancestors):
        for layer in layers:
            chain = [*ancestors, layer]
            reason = None
            if layer.get("type") != "image" or not layer.get("src"):
                reason = "Only an image layer has source pixels to paint."
            size = None
            if reason is None:
                try:
                    with Image.open(library_path(directory, layer["src"])) as image:
                        size = image.size
                except (ValueError, OSError) as error:
                    reason = str(error)
            if reason is None and size != (width, height):
                reason = "The layer source is not the full canvas size; canvas strokes cannot be mapped to its pixels safely."
            if reason is None:
                for item in chain:
                    label = item.get("name") or item["id"]
                    if item.get("locked") or item.get("enabled") is False:
                        reason = f'Layer or group "{label}" is locked or hidden. Unlock and show it before painting.'
                        break
                    if any(isinstance(effect, dict) and effect.get("enabled") is not False for effect in item.get("effects") or []):
                        reason = f'Layer or group "{label}" has enabled effects; its displayed pixels may be displaced.'
                        break
                    matrix = imgdoc.interp.transform_matrix(item.get("transform") or {}, 0,
                        anchor_default=(width / 2, height / 2), position_default=(width / 2, height / 2))
                    if not np.allclose(matrix, identity, rtol=0, atol=1e-9):
                        reason = f'Layer or group "{label}" is transformed; canvas strokes cannot be mapped to its pixels safely.'
                        break
            result[layer["id"]] = {"ready": reason is None, "reason": (reason + " " + PAINT_GUIDANCE) if reason else "Full-canvas source with an identity pixel mapping."}
            walk(layer.get("layers") or [], chain)
    walk(doc.get("layers") or [], [])
    return result


def paint_target(job):
    doc = imgdoc.normalize(job["doc"])
    layer, _, _ = imgdoc.find_layer(doc, job["ref"])
    result = paint_targets(doc, job["dir"])[layer["id"]]
    if not result["ready"]:
        raise ValueError(result["reason"])
    return {**result, "ref": layer["id"]}


def flatten_references(references):
    """Qwen's vision tower sees a reference's alpha over white, but its VAE
    encodes all four channels, so one cutout reference turned a whole
    generation transparent. Hand Qwen the picture its vision tower sees.

    A name that is missing or unreadable stays as it is: staging refuses it
    with the message every other Qwen door gives."""
    names = []
    for reference in references:
        path = next((p for p in reference["candidates"] if os.path.isfile(p)), None)
        rgba = None
        if path:
            try:
                with Image.open(path) as image:
                    if any(band in ("A", "a") for band in image.getbands()) or "transparency" in image.info:
                        rgba = image.convert("RGBA")
            except OSError:
                pass
        if rgba is None or rgba.getextrema()[3][0] == 255:
            names.append(reference["name"])
            continue
        flat = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        flat.alpha_composite(rgba)
        flat.convert("RGB").save(reference["out"])
        names.append(os.path.basename(reference["out"]))
    return names


def flatten(job):
    """The same rule for a plain Qwen generation (stageQwenReferences)."""
    return {"references": flatten_references(job["references"])}


def prepare(job):
    doc = open_doc(job) if job.get("documentId") else None
    if doc:
        image, warnings = render_doc(doc, job["dir"])
    else:
        with Image.open(library_path(job["dir"], job["source"])) as src:
            image = src.convert("RGBA")
        warnings = []
    if image.width * image.height > 16_777_216:
        raise ValueError("Qwen edits support source canvases up to 16 megapixels.")
    image.save(job["out"])
    thumbnail = image.copy()
    thumbnail.thumbnail((512, 512), Image.Resampling.LANCZOS)
    preview_data = io.BytesIO()
    thumbnail.save(preview_data, format="PNG")
    coverage = None
    if job.get("mode") == "inpaint":
        selection = job.get("selection")
        if not isinstance(selection, dict) or not selection.get("shapes"):
            raise ValueError("Masked edit needs a nonempty selection.")
        notes = []
        mask = imgselect.resolve(selection, np.asarray(image, dtype=np.float32) / 255, notes)
        if notes:
            raise ValueError("Selection could not be resolved exactly: " + "; ".join(notes))
        if not np.any(mask > 0):
            raise ValueError("The selection covers no pixels.")
        # Float32 avoids turning a small feather value into a zero by quantisation.
        np.save(job["maskOut"], mask, allow_pickle=False)
        Image.fromarray(np.round(np.clip(mask, 0, 1) * 255).astype(np.uint8), "L").convert("RGB").save(job["maskImageOut"])
        coverage = float(np.mean(mask))
    return {"width": image.width, "height": image.height, "warnings": warnings,
            "document": doc, "revision": revision(doc) if doc else None, "coverage": coverage,
            "references": flatten_references(job.get("references") or []),
            "sourcePreview": "data:image/png;base64," + base64.b64encode(preview_data.getvalue()).decode("ascii")}


def over_source(generated, original):
    """The generation laid over the source; straight alpha, float32 0..1.

    A masked edit never asks for transparency, but Qwen can still return it.
    Pasted through the selection, that punched a hole in an opaque frame and
    showed the colour under the alpha. Opaque pixels are copied, so an opaque
    generation composites exactly as before; clear ones leave the source."""
    ag, ao = generated[..., 3:], original[..., 3:]
    alpha = ag + ao * (1 - ag)
    with np.errstate(divide="ignore", invalid="ignore"):
        rgb = (generated[..., :3] * ag + original[..., :3] * ao * (1 - ag)) / alpha
    over = np.concatenate([rgb, alpha], axis=-1)
    return np.where(ag >= 1, generated, np.where(ag <= 0, original, over))


def finish(job):
    with Image.open(job["sourcePath"]) as source:
        original = np.asarray(source.convert("RGBA")).copy()
    with Image.open(library_path(job["dir"], job["generated"])) as generated:
        image = generated.convert("RGBA")
    resized = image.size != (original.shape[1], original.shape[0])
    if resized:
        # Qwen produces 32-aligned dimensions. The edit always returns to the
        # exact document grid before applying its selection.
        image = image.resize((original.shape[1], original.shape[0]), Image.Resampling.LANCZOS)
    result = np.asarray(image).copy()
    warnings = []
    if job.get("maskPath"):
        mask = np.load(job["maskPath"], allow_pickle=False)
        if mask.shape != original.shape[:2]:
            raise ValueError("Frozen selection does not match the source dimensions.")
        generated = result.astype(np.float32) / 255
        selected = mask > 0
        clear = selected & (generated[..., 3] < .5)
        if not np.any(selected & ~clear):
            raise ValueError("Qwen returned the whole selection transparent, so the edit would change nothing. "
                             "A reference or source with transparency can cause this.")
        share = float(np.sum(mask[clear]) / np.sum(mask[selected]))
        if share >= .01:
            warnings.append(f"Qwen returned {share:.0%} of the selection transparent; those pixels keep the source.")
        source01 = original.astype(np.float32) / 255
        result = imgdoc.to_uint8(imgselect.blend(source01, over_source(generated, source01), mask))
        result[mask <= 0] = original[mask <= 0]  # includes hidden RGB and alpha
    final = Image.fromarray(result, "RGBA")
    final.save(job["out"])
    thumb = final.copy()
    thumb.thumbnail((256, 256), Image.Resampling.LANCZOS)
    thumb.save(job["thumbOut"])
    return {"width": final.width, "height": final.height, "resizedToSource": resized, "warnings": warnings}


def _accept_locked(job):
    if job.get("documentId"):
        before = open_doc(job)
        if revision(before) != job["revision"]:
            raise ValueError("The document changed after this edit started. Keep the candidate, or generate again from the current document.")
    else:
        # Keep the frozen original, even if someone replaced the source file
        # while the GPU was running. It becomes an ordinary library layer.
        with Image.open(job["sourcePath"]) as image:
            image.save(os.path.join(job["dir"], job["originalName"]))
        before = imgdoc.normalize({"name": job.get("title") or "Qwen edit",
            "width": job["width"], "height": job["height"],
            "layers": [{"id": "original", "type": "image", "name": "Original", "src": job["originalName"]}]})
    doc = copy.deepcopy(before)
    if float(imgdoc._rgba01(before.get("bg"), (0., 0., 0., 0.))[3]) > 0:
        # Keep the old background in the saved layer tree, not just in this
        # session's undo snapshot. A native solid needs no extra raster asset.
        doc, _ = imgdoc.apply_edits(doc, [{"op": "add_layer", "index": 0, "layer": {
            "type": "solid", "name": "Original document background", "enabled": False,
            "size": [doc["width"], doc["height"]], "color": copy.deepcopy(before["bg"]),
        }}])
    # The result already includes the old document background. Keeping it
    # beneath the replacement would fill new transparency or double its alpha.
    doc["bg"] = [0, 0, 0, 0]
    for layer in doc["layers"]:
        layer["enabled"] = False
    doc, _ = imgdoc.apply_edits(doc, [{"op": "add_layer", "layer": {
        "id": job["layerId"], "type": "image", "name": job["layerName"], "src": job["candidate"]}}])
    saved = imgdoc.store_job({"dir": job["dir"], "action": "save", "doc": doc})
    current = imgdoc.store_job({"dir": job["dir"], "action": "open", "id": saved["id"]})["doc"]
    return {"doc": current, "revision": revision(current), "before": before, "layerId": job["layerId"]}


def _undo_locked(job):
    current = open_doc(job)
    if revision(current) != job["revision"]:
        raise ValueError("The document has newer edits. Undo those first, or toggle the Qwen layer and original layers manually.")
    before = dict(job["before"], id=current["id"], slug=current["slug"])
    saved = imgdoc.store_job({"dir": job["dir"], "action": "save", "doc": before})
    restored = imgdoc.store_job({"dir": job["dir"], "action": "open", "id": saved["id"]})["doc"]
    return {"doc": restored, "revision": revision(restored)}


def accept(job):
    with imgdoc.shelf_lock(job):
        return _accept_locked(job)


def undo(job):
    with imgdoc.shelf_lock(job):
        return _undo_locked(job)


def main():
    with open(sys.argv[2], encoding="utf-8") as handle:
        job = json.load(handle)
    try:
        action = {"preview": preview, "paint-target": paint_target, "prepare": prepare, "finish": finish,
                  "accept": accept, "undo": undo, "flatten": flatten}[sys.argv[1]]
        print(json.dumps({"ok": True, **action(job)}))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
