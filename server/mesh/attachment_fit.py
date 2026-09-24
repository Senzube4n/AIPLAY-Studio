"""Conservative CPU attachment alignment, bounded surface fitting and binding.

This fits compatible, already oriented rest-pose geometry. It cannot infer
garment semantics, repair topology, or manufacture a rig or hair physics.
"""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import time

import weight_transfer as wt

MARKER = "AVATAR_FITTING_RESULT_JSON:"
LIMITS = {"clearance": [0, .03], "max_displacement": [.001, .2], "max_scale_change": [1, 3],
          "bytes": wt.MAX_BYTES, "vertices": wt.MAX_VERTICES, "joints": wt.MAX_JOINTS}
DEFAULTS = {"alignment": "bounds", "clearance": .006, "max_displacement": .1, "max_scale_change": 2}


def compact_part(doc, binary):
    """Keep only resources reached by this static mesh, preserving used bytes."""
    doc = copy.deepcopy(doc)
    primitives = [p for m in doc["meshes"] for p in m["primitives"]]
    def mapping(indices):
        return {old: new for new, old in enumerate(sorted(set(indices)))}
    materials = mapping(p["material"] for p in primitives if "material" in p)
    kept_materials = [doc["materials"][i] for i in materials]
    textures = set()
    def texture_infos(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith("Texture") and isinstance(child, dict) and "index" in child:
                    yield child
                else:
                    yield from texture_infos(child)
        elif isinstance(value, list):
            for child in value:
                yield from texture_infos(child)
    infos = [info for m in kept_materials for info in texture_infos(m)]
    textures = mapping(info["index"] for info in infos)
    kept_textures = [doc["textures"][i] for i in textures]
    images = mapping(t["source"] for t in kept_textures if "source" in t)
    samplers = mapping(t["sampler"] for t in kept_textures if "sampler" in t)
    kept_images = [doc["images"][i] for i in images]
    accessors = mapping(i for p in primitives for i in [*p["attributes"].values(), *([p["indices"]] if "indices" in p else [])])
    kept_accessors = [doc["accessors"][i] for i in accessors]
    views = set(i["bufferView"] for i in kept_images)
    for a in kept_accessors:
        if "bufferView" in a:
            views.add(a["bufferView"])
        if "sparse" in a:
            views.update(a["sparse"][key]["bufferView"] for key in ("indices", "values"))
    views = mapping(views)
    payload, kept_views = bytearray(), []
    for old in views:
        original = doc["bufferViews"][old]
        payload.extend(b"\0" * (-len(payload) % 4))
        start = original.get("byteOffset", 0)
        kept_views.append({**original, "buffer": 0, "byteOffset": len(payload)})
        payload.extend(binary[start:start + original["byteLength"]])
    for p in primitives:
        p["attributes"] = {key: accessors[i] for key, i in p["attributes"].items()}
        if "indices" in p:
            p["indices"] = accessors[p["indices"]]
        if "material" in p:
            p["material"] = materials[p["material"]]
    for info in infos:
        info["index"] = textures[info["index"]]
    for texture in kept_textures:
        if "source" in texture:
            texture["source"] = images[texture["source"]]
        if "sampler" in texture:
            texture["sampler"] = samplers[texture["sampler"]]
    for image in kept_images:
        image["bufferView"] = views[image["bufferView"]]
    for a in kept_accessors:
        if "bufferView" in a:
            a["bufferView"] = views[a["bufferView"]]
        if "sparse" in a:
            for key in ("indices", "values"):
                a["sparse"][key]["bufferView"] = views[a["sparse"][key]["bufferView"]]
    for key, value in {"materials": kept_materials, "textures": kept_textures, "images": kept_images,
                       "samplers": [doc.get("samplers", [])[i] for i in samplers], "accessors": kept_accessors, "bufferViews": kept_views}.items():
        if value:
            doc[key] = value
        else:
            doc.pop(key, None)
    return doc, payload


def bounds(vertices):
    return {"min": [min(p[k] for p in vertices) for k in range(3)],
            "max": [max(p[k] for p in vertices) for k in range(3)]}


def target_data(path):
    data = wt.load(path)
    doc, binary, _, _, worlds, active = data
    wt.require(not doc.get("skins") and not doc.get("animations") and not doc.get("extensions"),
               "Upload an unrigged static GLB attachment")
    wt.require(set(doc.get("extensionsUsed", [])) <= wt.MATERIAL_EXTENSIONS
               and set(doc.get("extensionsRequired", [])) <= wt.MATERIAL_EXTENSIONS,
               "Attachment uses unsupported extensions; export self-contained PBR/unlit materials")
    nodes = [i for i, n in enumerate(doc["nodes"]) if "mesh" in n]
    wt.require(len(nodes) == 1 and nodes[0] in active and len(doc.get("meshes", [])) == 1,
               "Join the attachment into one mesh object before fitting")
    wt.require(all("skin" not in n and not n.get("extensions") for n in doc["nodes"]), "Attachment must not contain rigs or node extensions")
    _, _, Vector, _, _ = wt.runtime()
    geometry, all_vertices = [], []
    for p in doc["meshes"][0]["primitives"]:
        wt.require(not any(k.startswith(("JOINTS_", "WEIGHTS_")) for k in p["attributes"]), "Attachment already has skin weights")
        pos, faces = wt.primitive_geometry(doc, binary, p)
        vertices = [worlds[nodes[0]] @ Vector(v) for v in pos]
        wt.require(all(math.isfinite(c) and abs(c) <= 100000 for v in vertices for c in v), "Attachment geometry is outside the supported coordinate range")
        all_vertices.extend(vertices)
        geometry.append((vertices, faces))
    wt.require(0 < len(all_vertices) <= wt.MAX_VERTICES, "Attachment exceeds the vertex limit")
    return data, geometry, all_vertices


def inventory(reference_path, target_path=None):
    ref = wt.load(reference_path)
    doc = ref[0]
    available = []
    for node in sorted(ref[5]):
        n = doc["nodes"][node]
        if "skin" not in n or "mesh" not in n:
            continue
        for pi, p in enumerate(doc["meshes"][n["mesh"]]["primitives"]):
            if p.get("targets"):
                continue
            material = doc.get("materials", [])[p["material"]] if "material" in p else {}
            try:
                points, faces = wt.primitive_geometry(doc, ref[1], p)
                _, _, Vector, _, _ = wt.runtime()
                points = [ref[4][node] @ Vector(v) for v in points]
                available.append({"mesh_node": node, "primitive": pi, "name": material.get("name") or n.get("name") or "Surface",
                                  "mesh_name": n.get("name", "Mesh"), "vertices": len(points), "triangles": len(faces), "bounds": bounds(points)})
            except (ValueError, RuntimeError):
                continue
    wt.require(available, "Avatar has no supported static weighted surface")
    first = available[0]
    info = wt.inspect_reference(reference_path, first["mesh_node"], first["primitive"])
    target = target_data(target_path) if target_path else None
    return {"ok": True, "mode": "inspect", "skeleton": info["skeleton"], "joints": info["joints"],
            "reference_surfaces": available, "defaults": DEFAULTS, "limits": LIMITS,
            "target": {"vertices": len(target[2]), "bounds": bounds(target[2])} if target else None}


def fit(reference_path, target_path, output_path, options):
    started = time.monotonic()
    allowed = {"expected_skeleton", "reference_mesh_node", "reference_primitive", *DEFAULTS}
    wt.require(isinstance(options, dict) and set(options) <= allowed and allowed <= set(options), "Fitting options must explicitly include skeleton, surface and all fit limits")
    wt.require(options["alignment"] in ("bounds", "keep"), "alignment must be bounds or keep")
    for name in ("clearance", "max_displacement", "max_scale_change"):
        value = options[name]
        wt.require(type(value) in (int, float) and math.isfinite(value) and LIMITS[name][0] <= value <= LIMITS[name][1], "Invalid " + name)
    reference_path, target_path, output_path = [Path(p).resolve() for p in (reference_path, target_path, output_path)]
    wt.require(output_path.suffix.lower() == ".glb" and output_path not in (reference_path, target_path), "Output must be a separate GLB file")
    ref, skin, _, signature, uses = wt.reference(reference_path, options["reference_mesh_node"], options["reference_primitive"])
    wt.require(signature == options["expected_skeleton"], "Avatar skeleton changed since inspection")
    sampled = wt.surface(ref, uses, options["reference_primitive"], detailed=True)
    data, geometry, source_vertices = target_data(target_path)
    doc, binary = data[:2]
    _, Matrix, Vector, _, _ = wt.runtime()
    source_bounds, reference_bounds = bounds(source_vertices), bounds(sampled["vertices"])
    source_size = Vector(source_bounds["max"]) - Vector(source_bounds["min"])
    reference_size = Vector(reference_bounds["max"]) - Vector(reference_bounds["min"])
    scale = 1.0
    alignment = Matrix.Identity(4)
    if options["alignment"] == "bounds":
        # Least-squares uniform extent fit preserves proportions and orientation.
        wt.require(source_size.length_squared > 1e-12 and reference_size.length_squared > 1e-12, "A nonzero attachment and reference extent are required")
        scale = source_size.dot(reference_size) / source_size.length_squared
        lower, upper = 1 / options["max_scale_change"], options["max_scale_change"]
        wt.require(lower - 1e-6 <= scale <= upper + 1e-6, "Automatic alignment exceeds max_scale_change; prepare the part closer to the avatar's scale")
        scale = max(lower, min(upper, scale))
        source_center = (Vector(source_bounds["min"]) + Vector(source_bounds["max"])) * .5
        destination_center = (Vector(reference_bounds["min"]) + Vector(reference_bounds["max"])) * .5
        alignment = Matrix.Translation(destination_center) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-source_center)
    output_doc = copy.deepcopy(doc)
    output_doc["nodes"] = [{"name": "Fitted attachment", "mesh": 0}]
    output_doc["scenes"] = [{"nodes": [0]}]
    output_doc["scene"] = 0
    payload = bytearray(binary)
    displacements, before_distances, after_distances = [], [], []
    final_vertices, area_ratios = [], []

    def append_vectors(rows, with_bounds=False):
        payload.extend(b"\0" * (-len(payload) % 4))
        offset = len(payload)
        for row in rows:
            payload.extend(struct.pack("<fff", *row))
        output_doc.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": offset, "byteLength": len(payload) - offset, "target": 34962})
        a = {"bufferView": len(output_doc["bufferViews"]) - 1, "componentType": 5126, "count": len(rows), "type": "VEC3"}
        if with_bounds:
            a.update(bounds(rows))
        output_doc.setdefault("accessors", []).append(a)
        return len(output_doc["accessors"]) - 1

    for primitive, (points, triangles) in zip(output_doc["meshes"][0]["primitives"], geometry):
        aligned = [alignment @ p for p in points]
        fitted, normals = [], []
        for point in aligned:
            nearest, face_normal, fi, distance = sampled["bvh"].find_nearest(point)
            wt.require(nearest is not None, "Reference surface has no nearest triangle")
            tri = sampled["triangles"][fi]
            coefficients = wt.barycentric(nearest, *(sampled["vertices"][i] for i in tri))
            normal = sum((sampled["normals"][j] * w for j, w in zip(tri, coefficients)), Vector((0, 0, 0)))
            normal = normal.normalized() if normal.length_squared > 1e-10 else face_normal
            destination = nearest + normal * options["clearance"]
            displacement = (destination - point).length
            wt.require(displacement <= options["max_displacement"], "Surface fitting exceeds max_displacement; choose a matching region or align the part first")
            fitted.append(destination)
            normals.append(normal)
            displacements.append(displacement)
            before_distances.append(distance)
            after_distances.append(sampled["bvh"].find_nearest(destination)[3])
        for face in triangles:
            a, b, c = [aligned[i] for i in face]
            d, e, f = [fitted[i] for i in face]
            before, after = (b - a).cross(c - a), (e - d).cross(f - d)
            wt.require(before.length > 1e-10 and after.length > 1e-10, "Fitting would collapse a triangle or input topology is degenerate")
            expected_normal = sum((normals[i] for i in face), Vector((0, 0, 0)))
            wt.require(expected_normal.length > 1e-10 and before.normalized().dot(expected_normal.normalized()) > .05,
                       "Attachment orientation disagrees with the selected surface; align front/back before fitting")
            ratio = after.length / before.length
            wt.require(.15 <= ratio <= 6 and before.normalized().dot(after.normalized()) > .1,
                       "Fitting would fold or excessively stretch a triangle; use a closer matching part")
            area_ratios.append(ratio)
        primitive["attributes"]["POSITION"] = append_vectors(fitted, True)
        primitive["attributes"]["NORMAL"] = append_vectors(normals)
        # Old tangents describe the pre-fit geometry. Viewers derive the tangent
        # frame from unchanged UVs and fitted normals when TANGENT is absent.
        primitive["attributes"].pop("TANGENT", None)
        final_vertices.extend(fitted)
    fit_report = {"alignment": options["alignment"], "scale": scale, "alignmentMatrix": wt.flatten(alignment),
                  "clearance": options["clearance"], "maxDisplacement": max(displacements),
                  "meanDisplacement": sum(displacements) / len(displacements), "displacementLimit": options["max_displacement"],
                  "maxBeforeDistance": max(before_distances), "maxAfterDistance": max(after_distances),
                  "minTriangleAreaRatio": min(area_ratios), "maxTriangleAreaRatio": max(area_ratios),
                  "referenceBounds": reference_bounds, "sourceBounds": source_bounds, "fittedBounds": bounds(final_vertices),
                  "referencePoseDeviation": sampled["maxReferencePoseDeviation"], "requiresVisualReview": True}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".attachment-fit-", dir=output_path.parent) as folder:
        fitted_path = Path(folder) / "fitted.glb"
        compact_doc, compact_binary = compact_part(output_doc, payload)
        fitted_path.write_bytes(wt.pack_glb(compact_doc, compact_binary))
        bound_path = Path(folder) / "bound.glb"
        report = wt.transfer(reference_path, fitted_path, bound_path, signature, wt.IDENTITY,
                             max(.001, options["clearance"] + .001), reference_mesh_node=options["reference_mesh_node"],
                             reference_primitive=options["reference_primitive"])
        bound, blob = wt.read_glb(bound_path)
        bound.setdefault("extras", {})["aiplayAttachmentFit"] = {**fit_report,
              "sourceSha256": hashlib.sha256(reference_path.read_bytes()).hexdigest(),
              "targetSha256": hashlib.sha256(target_path.read_bytes()).hexdigest()}
        encoded = wt.pack_glb(bound, blob)
        wt.require(len(encoded) <= wt.MAX_BYTES, "Fitted attachment exceeds the output size limit")
        bound_path.write_bytes(encoded)
        wt.validate_skinned_glb(bound_path)
        os.replace(bound_path, output_path)
    return {"ok": True, "mode": "fit-and-bind", "output": str(output_path), "vertices": report["vertices"], "joints": report["joints"],
            "skeleton": signature, "sourceSha256": hashlib.sha256(reference_path.read_bytes()).hexdigest(),
            "targetSha256": hashlib.sha256(target_path.read_bytes()).hexdigest(), "fit": fit_report,
            "referenceMeshNode": options["reference_mesh_node"], "referencePrimitive": options["reference_primitive"],
            "seconds": round(time.monotonic() - started, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--target")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--output")
    parser.add_argument("--options", help="JSON object with explicit selected surface and fitting limits")
    args = parser.parse_args()
    try:
        if args.inspect:
            result = inventory(args.reference, args.target)
        else:
            wt.require(args.target and args.output and args.options, "Fitting requires target, output and options")
            result = fit(args.reference, args.target, args.output, json.loads(args.options))
        print(MARKER + json.dumps(result, allow_nan=False))
        return 0
    except Exception as error:
        print(MARKER + json.dumps({"ok": False, "error": str(error)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
