"""Offline attachment binding, not rig generation. Requires Blender's bpy Python.

The BVH finds the nearest triangle on an explicitly aligned weighted reference;
its barycentric weights are transferred. Original target attribute/image bytes
are retained, avoiding an import/export round trip and dropped unused joints.
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

from unirig_adapter import read_glb, skin_accessor, node_hierarchy, validate_skinned_glb

MARKER = "WEIGHT_TRANSFER_RESULT_JSON:"
MAX_BYTES = 128 * 1024 * 1024
MAX_VERTICES = 200000
MAX_TRIANGLES = 400000
MAX_NODES = 2048
MAX_JOINTS = 256
MIN_RETAINED_WEIGHT = 0.9
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
MATERIAL_EXTENSIONS = {
    "KHR_materials_unlit", "KHR_texture_transform", "KHR_materials_clearcoat",
    "KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_specular",
    "KHR_materials_sheen", "KHR_materials_volume", "KHR_materials_emissive_strength",
    "KHR_materials_anisotropy", "KHR_materials_iridescence", "KHR_materials_dispersion",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def runtime():
    # Import lazily: --help remains usable without the optional local runtime.
    try:
        import bpy
        from mathutils import Matrix, Vector, Quaternion
        from mathutils.bvhtree import BVHTree
    except ImportError as exc:
        raise RuntimeError("Weight transfer needs the configured Blender Python with bpy; no packages are installed automatically") from exc
    return bpy, Matrix, Vector, Quaternion, BVHTree


def matrix(values):
    _, Matrix, _, _, _ = runtime()
    require(isinstance(values, list) and len(values) == 16
            and all(type(v) in (int, float) and math.isfinite(v) for v in values),
            "Transform must contain 16 finite column-major numbers")
    require(values[3] == values[7] == values[11] == 0 and values[15] == 1,
            "Transform must be affine: last row 0, 0, 0, 1")
    result = Matrix([values[c * 4:c * 4 + 4] for c in range(4)]).transposed()
    require(all(math.isfinite(v) for row in result for v in row), "Transform exceeds Blender's finite numeric range")
    require(math.isfinite(result.determinant()) and abs(result.determinant()) > 1e-12,
            "Transform must be invertible")
    return result


def flatten(value):
    return [float(value[r][c]) for c in range(4) for r in range(4)]


def local_matrix(node):
    _, Matrix, Vector, Quaternion, _ = runtime()
    if "matrix" in node:
        require(not any(key in node for key in ("translation", "rotation", "scale")),
                "Node must use matrix or TRS, not both")
        return matrix(node["matrix"])
    t, q, s = node.get("translation", [0, 0, 0]), node.get("rotation", [0, 0, 0, 1]), node.get("scale", [1, 1, 1])
    for values, length in ((t, 3), (q, 4), (s, 3)):
        require(isinstance(values, list) and len(values) == length
                and all(type(v) in (int, float) and math.isfinite(v) for v in values), "Invalid node TRS")
    require(abs(sum(v * v for v in q) - 1) < 1e-4, "Node quaternion must be normalized")
    return matrix(flatten(Matrix.LocRotScale(Vector(t), Quaternion((q[3], *q[:3])), Vector(s))))


def load(path):
    path = Path(path)
    require(path.is_file() and path.suffix.lower() == ".glb", "Input must be an existing .glb file")
    require(path.stat().st_size <= MAX_BYTES, "GLB exceeds the 128 MiB transfer limit")
    doc, binary = read_glb(path)
    require(isinstance(binary, bytes) and len(doc.get("buffers", [])) == 1
            and "uri" not in doc["buffers"][0], "Only a self-contained GLB with one embedded buffer is supported")
    require(all("uri" not in image for image in doc.get("images", [])), "Embed all textures before transferring weights")
    require(doc.get("asset", {}).get("version") == "2.0", "glTF 2.0 is required")
    nodes = doc.get("nodes", [])
    require(isinstance(nodes, list) and 0 < len(nodes) <= MAX_NODES
            and all(isinstance(n, dict) for n in nodes), "Invalid or excessive node hierarchy")
    node_hierarchy(nodes)
    parents = {child: i for i, n in enumerate(nodes) for child in n.get("children", [])}
    locals_ = [local_matrix(n) for n in nodes]
    worlds = {}

    def world(i):
        if i not in worlds:
            worlds[i] = world(parents[i]) @ locals_[i] if i in parents else locals_[i]
            require(all(math.isfinite(v) for row in worlds[i] for v in row), "Node hierarchy overflows its world transform")
        return worlds[i]

    for i in range(len(nodes)):
        world(i)
    scene = doc.get("scene", 0)
    require(type(scene) is int and 0 <= scene < len(doc.get("scenes", [])), "GLB needs a default scene")
    roots = doc["scenes"][scene].get("nodes", [])
    require(isinstance(roots, list) and roots and len(set(roots)) == len(roots)
            and all(type(i) is int and 0 <= i < len(nodes) and i not in parents for i in roots),
            "Default scene must contain distinct hierarchy roots")
    active, stack = set(), list(roots)
    while stack:
        i = stack.pop()
        active.add(i)
        stack.extend(nodes[i].get("children", []))
    return doc, binary, parents, locals_, worlds, active


def accessor(doc, binary, index, label, kind, types=(5126,), **kwargs):
    a = skin_accessor(doc, binary, index, label, kind, types, **kwargs)
    width = {"VEC3": 3, "VEC4": 4, "MAT4": 16, "SCALAR": 1}[kind]
    require(a["count"] <= max(MAX_VERTICES, MAX_TRIANGLES * 3), "Accessor exceeds transfer work limit")
    rows = [tuple(a["at"](i, k) for k in range(width)) for i in range(a["count"])]
    require(all(math.isfinite(v) for row in rows for v in row), label + " contains non-finite values")
    return rows


def primitive_geometry(doc, binary, primitive):
    require(primitive.get("mode", 4) == 4, "Only triangle meshes are supported")
    require(not primitive.get("extensions") and not primitive.get("targets"),
            "Compressed primitives and morph targets require a separate preparation step")
    positions = accessor(doc, binary, primitive.get("attributes", {}).get("POSITION"), "POSITION", "VEC3", vertex=True)
    require(len(positions) <= MAX_VERTICES, "Too many mesh vertices")
    indices = ([r[0] for r in accessor(doc, binary, primitive["indices"], "indices", "SCALAR", (5121, 5123, 5125))]
               if "indices" in primitive else list(range(len(positions))))
    require(indices and len(indices) % 3 == 0 and all(0 <= i < len(positions) for i in indices), "Invalid triangle indices")
    return positions, [tuple(indices[i:i + 3]) for i in range(0, len(indices), 3)]


def reference(path):
    data = load(path)
    doc, binary, parents, locals_, worlds, active = data
    require(len(doc.get("skins", [])) == 1, "Reference must contain exactly one skin")
    validate_skinned_glb(path)
    skin = doc["skins"][0]
    joints = skin["joints"]
    require(1 < len(joints) <= MAX_JOINTS, "Reference must have 2–256 joints")
    require(all(j in active for j in joints), "Every reference joint must belong to the default scene")
    names = [doc["nodes"][j].get("name") for j in joints]
    require(all(isinstance(n, str) and n for n in names) and len(set(names)) == len(names),
            "Reference joints need unique names for attachment compatibility")
    closure = set(joints)
    for j in joints:
        while j in parents:
            j = parents[j]
            closure.add(j)
    kept = sorted(closure)
    require(all(not doc["nodes"][j].get("extensions") for j in kept), "Reference skeleton node extensions are not supported")
    canonical_ids = {node: i for i, node in enumerate(kept)}
    canonical = {"joints": [canonical_ids[j] for j in joints], "nodes": [{"id": canonical_ids[j], "parent": canonical_ids.get(parents.get(j)),
                 "name": doc["nodes"][j].get("name"), "matrix": flatten(locals_[j])} for j in kept]}
    fingerprint = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    binds = [matrix(list(row)) for row in accessor(doc, binary, skin["inverseBindMatrices"], "inverseBindMatrices", "MAT4")]
    uses = [i for i in active if doc["nodes"][i].get("skin") == 0]
    require(uses, "Reference skin has no mesh in the default scene")
    for i in uses:
        for joint, bind in zip(joints, binds):
            require(max(abs(a - b) for a, b in zip(flatten(worlds[joint] @ bind), flatten(worlds[i]))) < 0.001,
                    "Reference must be in its bind rest pose; posed defaults cannot be used as a weighted base")
    return data, skin, kept, fingerprint, uses


def inspect_reference(path):
    data, skin, kept, fingerprint, uses = reference(path)
    return {"ok": True, "mode": "inspect-reference", "skeleton": fingerprint,
            "joints": len(skin["joints"]), "hierarchyNodes": len(kept), "meshNodes": len(uses),
            "jointNames": [data[0]["nodes"][j]["name"] for j in skin["joints"]]}


def surface(data, uses):
    _, _, Vector, _, BVHTree = runtime()
    doc, binary, _, _, worlds, _ = data
    vertices, triangles, weights = [], [], []
    for node in uses:
        for primitive in doc["meshes"][doc["nodes"][node]["mesh"]]["primitives"]:
            positions, faces = primitive_geometry(doc, binary, primitive)
            offset = len(vertices)
            vertices.extend(worlds[node] @ Vector(p) for p in positions)
            require(all(math.isfinite(c) and abs(c) <= 100000 for v in vertices[offset:] for c in v),
                    "Reference geometry must have finite world coordinates within 100 km of origin")
            attrs = primitive["attributes"]
            pairs = []
            for n in range(len([k for k in attrs if k.startswith("JOINTS_")])):
                js = accessor(doc, binary, attrs["JOINTS_%d" % n], "JOINTS", "VEC4", (5121, 5123), vertex=True)
                ws = accessor(doc, binary, attrs["WEIGHTS_%d" % n], "WEIGHTS", "VEC4", (5121, 5123, 5126), normalized=True, vertex=True)
                pairs.append((js, ws))
            for v in range(len(positions)):
                weights.append({j: w for js, ws in pairs for j, w in zip(js[v], ws[v]) if w > 0})
            for face in faces:
                tri = tuple(offset + i for i in face)
                a, b, c = [vertices[i] for i in tri]
                require((b - a).cross(c - a).length_squared > 1e-20, "Reference has degenerate triangles; clean its topology first")
                triangles.append(tri)
            require(len(vertices) <= MAX_VERTICES and len(triangles) <= MAX_TRIANGLES, "Reference exceeds transfer geometry limits")
    require(triangles, "Reference has no transfer surface")
    return BVHTree.FromPolygons(vertices, triangles, all_triangles=True), vertices, triangles, weights


def barycentric(point, a, b, c):
    v0, v1, v2 = b - a, c - a, point - a
    d00, d01, d11 = v0.dot(v0), v0.dot(v1), v1.dot(v1)
    d20, d21 = v2.dot(v0), v2.dot(v1)
    den = d00 * d11 - d01 * d01
    require(den > 1e-20, "Reference triangle is numerically degenerate")
    v, w = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
    values = [max(0.0, min(1.0, t)) for t in (1 - v - w, v, w)]
    total = sum(values)
    return [t / total for t in values]


def pack_glb(doc, binary):
    doc["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(doc, separators=(",", ":"), allow_nan=False).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    binary = bytes(binary) + b"\0" * (-len(binary) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
            + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def transfer(reference_path, target_path, output_path, expected_skeleton, transform, max_distance, mode="nearest-surface"):
    started = time.monotonic()
    require(mode == "nearest-surface", "Only nearest-surface weight transfer is supported")
    require(type(max_distance) in (int, float) and math.isfinite(max_distance) and 0 < max_distance <= 1,
            "max-distance must be greater than 0 and at most 1 metre")
    reference_path, target_path, output_path = map(lambda p: Path(p).resolve(), (reference_path, target_path, output_path))
    require(output_path.suffix.lower() == ".glb" and output_path not in (reference_path, target_path),
            "Output must be a separate .glb; input files are never overwritten")
    alignment = matrix(transform)
    ref, skin, kept, fingerprint, uses = reference(reference_path)
    require(isinstance(expected_skeleton, str) and fingerprint == expected_skeleton,
            "Reference skeleton mismatch; inspect and select the intended weighted base again")
    target = load(target_path)
    doc, binary, _, _, worlds, active = target
    require(not doc.get("skins") and not any("skin" in n for n in doc["nodes"]), "Target must be unrigged")
    require(not doc.get("animations") and not doc.get("extensions"), "Target animations or scene extensions require separate preparation")
    require(set(doc.get("extensionsUsed", [])) <= MATERIAL_EXTENSIONS
            and set(doc.get("extensionsRequired", [])) <= MATERIAL_EXTENSIONS,
            "Target uses an unsupported extension; only material extensions are retained")
    require(all(not n.get("extensions") for n in doc["nodes"]), "Target node extensions require separate preparation")
    mesh_nodes = [i for i, n in enumerate(doc["nodes"]) if "mesh" in n]
    require(len(mesh_nodes) == 1 and mesh_nodes[0] in active, "Target must contain one mesh node in its default scene; join attachment objects first")
    node = mesh_nodes[0]
    require(len(doc.get("meshes", [])) == 1 and doc["nodes"][node]["mesh"] == 0, "Target must contain one mesh definition")
    primitives = doc["meshes"][0].get("primitives", [])
    require(primitives and all(not any(k.startswith(("JOINTS_", "WEIGHTS_")) for k in p.get("attributes", {})) for p in primitives),
            "Target already contains skin attributes, or no mesh primitives")
    bvh, vertices, faces, source_weights = surface(ref, uses)
    _, _, Vector, _, _ = runtime()
    mesh_world = alignment @ worlds[node]
    results, distances, min_retained, count, target_triangles = [], [], 1.0, 0, 0
    for primitive in primitives:
        positions, triangles = primitive_geometry(doc, binary, primitive)
        count += len(positions)
        target_triangles += len(triangles)
        require(count <= MAX_VERTICES and target_triangles <= MAX_TRIANGLES, "Target exceeds transfer geometry limits")
        transferred = []
        for position in positions:
            world_position = mesh_world @ Vector(position)
            require(all(math.isfinite(c) and abs(c) <= 100000 for c in world_position),
                    "Target geometry must have finite aligned coordinates within 100 km of origin")
            nearest, _, face, distance = bvh.find_nearest(world_position)
            require(nearest is not None and math.isfinite(distance) and distance <= max_distance,
                    "Coverage failed: target vertex %d is outside max-distance %.6g m; align the part or use a closer weighted base" % (len(distances), max_distance))
            distances.append(distance)
            tri = faces[face]
            blend = barycentric(nearest, *(vertices[i] for i in tri))
            row = {}
            for vertex, factor in zip(tri, blend):
                for joint, weight in source_weights[vertex].items():
                    row[joint] = row.get(joint, 0) + weight * factor
            strongest = sorted(((j, w) for j, w in row.items() if w > 1e-12), key=lambda pair: (-pair[1], pair[0]))[:4]
            retained = sum(w for _, w in strongest)
            require(retained >= MIN_RETAINED_WEIGHT, "Four influences would discard too much weight; prepare a simpler weighted base")
            min_retained = min(min_retained, retained)
            strongest = [(j, w / retained) for j, w in strongest]
            transferred.append(strongest + [(0, 0.0)] * (4 - len(strongest)))
        results.append(transferred)
    result = copy.deepcopy(doc)
    payload = bytearray(binary)

    def append_accessor(rows, kind, component_type, fmt, target_type=None):
        payload.extend(b"\0" * (-len(payload) % 4))
        offset = len(payload)
        for row in rows:
            payload.extend(struct.pack("<" + fmt * len(row), *row))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload) - offset}
        if target_type:
            view["target"] = target_type
        views = result.setdefault("bufferViews", [])
        views.append(view)
        accessors = result.setdefault("accessors", [])
        accessors.append({"bufferView": len(views) - 1, "componentType": component_type, "count": len(rows), "type": kind})
        return len(accessors) - 1

    for primitive, rows in zip(result["meshes"][0]["primitives"], results):
        primitive["attributes"]["JOINTS_0"] = append_accessor([[j for j, _ in row] for row in rows], "VEC4", 5123, "H", 34962)
        primitive["attributes"]["WEIGHTS_0"] = append_accessor([[w for _, w in row] for row in rows], "VEC4", 5126, "f", 34962)
    remap = {old: len(result["nodes"]) + i for i, old in enumerate(kept)}
    ref_doc, _, ref_parents, _, ref_worlds, _ = ref
    for old in kept:
        original = ref_doc["nodes"][old]
        copied = {key: copy.deepcopy(original[key]) for key in ("name", "matrix", "translation", "rotation", "scale") if key in original}
        children = [remap[c] for c in original.get("children", []) if c in remap]
        if children:
            copied["children"] = children
        result["nodes"].append(copied)
    # The inverse bind maps attachment-local positions into each reference joint's
    # rest space. A copied source IBM would incorrectly retain the body's transform.
    binds = []
    for joint in skin["joints"]:
        value = ref_worlds[joint].inverted() @ mesh_world
        value[3] = (0, 0, 0, 1)
        binds.append(flatten(value))
    bound_skin = {"name": "Attachment weights", "joints": [remap[j] for j in skin["joints"]],
                  "inverseBindMatrices": append_accessor(binds, "MAT4", 5126, "f")}
    if skin.get("skeleton") in remap:
        bound_skin["skeleton"] = remap[skin["skeleton"]]
    result["skins"] = [bound_skin]
    result["nodes"][node]["skin"] = 0
    scene = result["scenes"][result.get("scene", 0)]
    wrapper = len(result["nodes"])
    result["nodes"].append({"name": "Attachment alignment", "matrix": transform, "children": scene["nodes"][:]})
    scene["nodes"] = [wrapper] + [remap[j] for j in kept if j not in ref_parents]
    report = {"ok": True, "mode": mode, "skeleton": fingerprint, "joints": len(skin["joints"]),
              "hierarchyNodes": len(kept), "vertices": count, "triangles": target_triangles,
              "coverage": 1.0, "maxDistance": max(distances), "meanDistance": sum(distances) / count,
              "distanceLimit": max_distance, "minRetainedWeight": min_retained,
              "referenceSha256": hashlib.sha256(reference_path.read_bytes()).hexdigest(),
              "targetSha256": hashlib.sha256(target_path.read_bytes()).hexdigest(),
              "transform": transform, "requiresVisualReview": True,
              "blenderVersion": runtime()[0].app.version_string}
    # glTF extras may legally be a non-object; preserve it rather than mutate it.
    if not isinstance(result.get("extras", {}), dict):
        result["extras"] = {"originalExtras": result["extras"]}
    result.setdefault("extras", {})["aiplayWeightTransfer"] = report
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".weight-transfer-", dir=output_path.parent) as temp:
        staged = Path(temp) / "part.glb"
        encoded = pack_glb(result, payload)
        require(len(encoded) <= MAX_BYTES, "Prepared output exceeds the 128 MiB transfer limit")
        staged.write_bytes(encoded)
        validate_skinned_glb(staged)
        os.replace(staged, output_path)
    return {**report, "output": str(output_path), "seconds": round(time.monotonic() - started, 4)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect-reference")
    parser.add_argument("--reference")
    parser.add_argument("--target")
    parser.add_argument("--output")
    parser.add_argument("--expected-skeleton")
    parser.add_argument("--transform", help="Explicit JSON 16-number glTF column-major alignment matrix in metres")
    parser.add_argument("--max-distance", type=float)
    parser.add_argument("--mode", choices=["nearest-surface"], default="nearest-surface")
    args = parser.parse_args(argv)
    try:
        if args.inspect_reference:
            require(not any((args.reference, args.target, args.output, args.expected_skeleton, args.transform, args.max_distance is not None)),
                    "Inspection and transfer arguments cannot be combined")
            result = inspect_reference(args.inspect_reference)
        else:
            require(all((args.reference, args.target, args.output, args.expected_skeleton, args.transform))
                    and args.max_distance is not None, "Transfer requires reference, target, output, expected-skeleton, transform and max-distance")
            result = transfer(args.reference, args.target, args.output, args.expected_skeleton,
                              json.loads(args.transform), args.max_distance, args.mode)
        print(MARKER + json.dumps(result, allow_nan=False))
        return 0
    except Exception as exc:
        print(MARKER + json.dumps({"ok": False, "error": str(exc)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
