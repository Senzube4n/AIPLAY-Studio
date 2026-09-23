"""Geometry, refusal and actual Blender deformation tests for attachment binding."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

import weight_transfer as wt


def translate(x=0, y=0, z=0):
    values = wt.IDENTITY[:]
    values[12:15] = [x, y, z]
    return values


def fixture(path, rigged=False):
    """A weighted rectangle, or a smaller UV-mapped attachment above its surface."""
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
           "accessors": [], "bufferViews": [], "materials": [{"name": "Keep this material", "pbrMetallicRoughness": {
               "baseColorFactor": [0.8, 0.2, 0.5, 1], "metallicFactor": 0.1, "roughnessFactor": 0.7}}]}
    binary = bytearray()

    def acc(rows, kind, fmt, component, target=None, bounds=False):
        binary.extend(b"\0" * (-len(binary) % 4))
        offset = len(binary)
        for row in rows:
            binary.extend(struct.pack("<" + fmt * len(row), *row))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset}
        if target:
            view["target"] = target
        doc["bufferViews"].append(view)
        accessor = {"bufferView": len(doc["bufferViews"]) - 1, "type": kind, "componentType": component, "count": len(rows)}
        if bounds:
            accessor.update(min=[min(row[k] for row in rows) for k in range(3)], max=[max(row[k] for row in rows) for k in range(3)])
        doc["accessors"].append(accessor)
        return len(doc["accessors"]) - 1

    positions = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)] if rigged else [(.25, .25, 0), (.75, .25, 0), (.75, .75, 0), (.25, .75, 0)]
    attrs = {"POSITION": acc(positions, "VEC3", "f", 5126, 34962, True),
             "TEXCOORD_0": acc([(0, 0), (1, 0), (1, 1), (0, 1)], "VEC2", "f", 5126, 34962),
             "NORMAL": acc([(0, 0, 1)] * 4, "VEC3", "f", 5126, 34962)}
    primitive = {"attributes": attrs, "indices": acc([(i,) for i in (0, 1, 2, 0, 2, 3)], "SCALAR", "H", 5123, 34963), "material": 0}
    # A real embedded texture ensures we retain image bytes, not just a color.
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff\xff")) + chunk(b"IEND", b""))
    binary.extend(b"\0" * (-len(binary) % 4))
    doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(png)})
    binary.extend(png)
    doc["images"] = [{"bufferView": len(doc["bufferViews"]) - 1, "mimeType": "image/png"}]
    doc["textures"] = [{"source": 0}]
    doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    doc["meshes"] = [{"name": "Reference" if rigged else "Attachment", "primitives": [primitive]}]
    if rigged:
        attrs["JOINTS_0"] = acc([(0, 1, 0, 0)] * 4, "VEC4", "H", 5123, 34962)
        attrs["WEIGHTS_0"] = acc([(1 - p[0], p[0], 0, 0) for p in positions], "VEC4", "f", 5126, 34962)
        binds = acc([wt.IDENTITY, translate(-1), translate(-1, -.5)], "MAT4", "f", 5126)
        doc["nodes"] = [{"name": "Reference frame", "translation": [3, 1, 0], "children": [1, 4]},
                        {"name": "Root", "children": [2]}, {"name": "Arm", "translation": [1, 0, 0], "children": [3]},
                        {"name": "UnusedHair", "translation": [0, .5, 0]}, {"name": "Body", "mesh": 0, "skin": 0}]
        doc["skins"] = [{"joints": [1, 2, 3], "skeleton": 1, "inverseBindMatrices": binds}]
    else:
        doc["nodes"] = [{"name": "Part frame", "translation": [.2, .3, 0], "children": [1]},
                        {"name": "Part", "translation": [.1, .2, 0], "mesh": 0}]
    path.write_bytes(wt.pack_glb(doc, binary))
    return path


def rewrite(path, callback):
    doc, binary = wt.read_glb(path)
    callback(doc)
    path.write_bytes(wt.pack_glb(doc, binary))


class WeightTransferTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            wt.runtime()
        except RuntimeError as exc:
            raise unittest.SkipTest(str(exc))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.ref = fixture(self.directory / "reference.glb", True)
        self.target = fixture(self.directory / "attachment.glb")
        self.output = self.directory / "bound.glb"
        self.signature = wt.inspect_reference(self.ref)["skeleton"]
        self.transform = translate(2.7, .5, .02)

    def run_transfer(self, **changes):
        args = {"reference_path": self.ref, "target_path": self.target, "output_path": self.output,
                "expected_skeleton": self.signature, "transform": self.transform, "max_distance": .03}
        args.update(changes)
        return wt.transfer(**args)

    def test_barycentric_weights_full_hierarchy_and_unchanged_material_uv_bytes(self):
        inputs = [p.read_bytes() for p in (self.ref, self.target)]
        target_doc, target_binary = wt.read_glb(self.target)
        report = self.run_transfer()
        self.assertEqual(report["coverage"], 1)
        self.assertAlmostEqual(report["maxDistance"], .02, places=5)
        doc, binary = wt.read_glb(self.output)
        self.assertEqual(binary[:len(target_binary)], target_binary)
        self.assertEqual(doc["materials"], target_doc["materials"])
        self.assertEqual(doc["images"], target_doc["images"])
        self.assertEqual(doc["textures"], target_doc["textures"])
        for name, index in target_doc["meshes"][0]["primitives"][0]["attributes"].items():
            self.assertEqual(doc["meshes"][0]["primitives"][0]["attributes"][name], index)
            self.assertEqual(doc["accessors"][index], target_doc["accessors"][index])
        attrs = doc["meshes"][0]["primitives"][0]["attributes"]
        js = wt.accessor(doc, binary, attrs["JOINTS_0"], "joints", "VEC4", (5123,), vertex=True)
        ws = wt.accessor(doc, binary, attrs["WEIGHTS_0"], "weights", "VEC4", normalized=True, vertex=True)
        for i, expected_arm in enumerate((.25, .75, .75, .25)):
            self.assertAlmostEqual(dict(zip(js[i], ws[i]))[1], expected_arm, places=5)
        joint_nodes = [doc["nodes"][j] for j in doc["skins"][0]["joints"]]
        self.assertEqual([n["name"] for n in joint_nodes], ["Root", "Arm", "UnusedHair"])
        self.assertEqual(joint_nodes[1]["children"], [doc["skins"][0]["joints"][2]])
        self.assertEqual([p.read_bytes() for p in (self.ref, self.target)], inputs)
        self.assertEqual(wt.validate_skinned_glb(self.output)["joints"], 3)
        self.assertEqual(wt.inspect_reference(self.output)["skeleton"], self.signature)

    def test_distance_failure_preserves_previous_output(self):
        self.output.write_bytes(b"keep previous output")
        with self.assertRaisesRegex(ValueError, "Coverage failed"):
            self.run_transfer(max_distance=.001)
        self.assertEqual(self.output.read_bytes(), b"keep previous output")

    def test_one_far_vertex_rejects_all_instead_of_partial_coverage(self):
        with self.assertRaisesRegex(ValueError, "Coverage failed"):
            self.run_transfer(transform=translate(3.15, .5, .02))
        self.assertFalse(self.output.exists())

    def test_mismatched_skeleton_and_changed_hierarchy_refused(self):
        with self.assertRaisesRegex(ValueError, "skeleton mismatch"):
            self.run_transfer(expected_skeleton="0" * 64)
        rewrite(self.ref, lambda doc: doc["nodes"][3].update(name="DifferentHair"))
        with self.assertRaisesRegex(ValueError, "skeleton mismatch"):
            self.run_transfer()

    def test_posed_reference_refused(self):
        rewrite(self.ref, lambda doc: doc["nodes"][2].update(translation=[.5, 0, 0]))
        with self.assertRaisesRegex(ValueError, "bind rest pose"):
            wt.inspect_reference(self.ref)

    def test_rigged_target_and_input_overwrite_refused(self):
        with self.assertRaisesRegex(ValueError, "unrigged"):
            self.run_transfer(target_path=self.ref)
        with self.assertRaisesRegex(ValueError, "never overwritten"):
            self.run_transfer(output_path=self.target)

    def test_bad_alignment_and_distance_and_mode_refused(self):
        for transform in ([1] * 16, [float("nan")] * 16, [0] * 16, translate(1e300), translate(100001)):
            with self.assertRaises(ValueError):
                self.run_transfer(transform=transform)
        for distance in (0, -1, float("inf"), 2):
            with self.assertRaisesRegex(ValueError, "max-distance"):
                self.run_transfer(max_distance=distance)
        with self.assertRaisesRegex(ValueError, "nearest-surface"):
            self.run_transfer(mode="rig-generation")

    def test_external_images_and_existing_animation_refused(self):
        rewrite(self.target, lambda doc: doc.update(images=[{"uri": "private.png"}]))
        with self.assertRaisesRegex(ValueError, "Embed all textures"):
            self.run_transfer()
        fixture(self.target)
        rewrite(self.target, lambda doc: doc.update(animations=[{"name": "not static"}]))
        with self.assertRaisesRegex(ValueError, "animations"):
            self.run_transfer()

    def test_blender_import_rest_pose_and_nonroot_joint_deformation(self):
        self.run_transfer()
        evidence = self.blender_evidence()
        self.assertLess(evidence["maxRestError"], 2e-5)
        self.assertGreater(evidence["maxMovement"], .1)
        self.assertEqual(evidence["movedVertices"], 4)
        self.assertIn("UnusedHair", evidence["bones"])

    def test_rotated_scaled_alignment_stays_in_place_in_blender(self):
        # Half size, +90 degrees about glTF Z, then translation. Includes the
        # target's pre-existing (.3, .5, 0) hierarchy translation.
        self.run_transfer(transform=[0, .5, 0, 0, -.5, 0, 0, 0, 0, 0, 1, 0, 3.75, .725, .02, 1])
        actual = self.blender_evidence()["restPositions"]
        expected = [(3.375, -.02, 1), (3.375, -.02, 1.25), (3.125, -.02, 1.25), (3.125, -.02, 1)]
        for point in actual:
            self.assertLess(min(sum((a - b) ** 2 for a, b in zip(point, e)) for e in expected), 1e-10)
        self.assertEqual(wt.inspect_reference(self.output)["skeleton"], self.signature)

    def blender_evidence(self):
        child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--verify-blender", str(self.output)],
                               capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        return json.loads(next(line[len("BLENDER_EVIDENCE:"):] for line in child.stdout.splitlines() if line.startswith("BLENDER_EVIDENCE:")))


def evaluate_blender(path):
    bpy, _, Vector, Quaternion, _ = wt.runtime()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]
    if len(meshes) != 1:
        raise AssertionError("Expected one imported weighted attachment")
    obj = meshes[0]
    rig = next(m.object for m in obj.modifiers if m.type == "ARMATURE")

    def evaluated():
        bpy.context.view_layer.update()
        deps = bpy.context.evaluated_depsgraph_get()
        eval_obj = obj.evaluated_get(deps)
        mesh = eval_obj.to_mesh()
        try:
            return [eval_obj.matrix_world @ v.co for v in mesh.vertices]
        finally:
            eval_obj.to_mesh_clear()

    rest = evaluated()
    expected = [Vector((x + 3, -.02, y + 1)) for x, y in ((.25, .25), (.75, .25), (.75, .75), (.25, .75))]
    # Importers may reorder vertices to split UV seams. Match spatially.
    error = max(min((v - p).length for p in expected) for v in rest)
    bone = rig.pose.bones["Arm"]
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion = Quaternion((0, 1, 0), .6)
    rig.update_tag()
    moved = [(a - b).length for a, b in zip(rest, evaluated())]
    return {"blenderVersion": bpy.app.version_string, "maxRestError": error,
            "maxMovement": max(moved), "movedVertices": sum(v > 1e-5 for v in moved),
            "bones": list(rig.pose.bones.keys()), "restPositions": [list(v) for v in rest]}


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--verify-blender":
        status = 1
        try:
            print("BLENDER_EVIDENCE:" + json.dumps(evaluate_blender(Path(sys.argv[2])), allow_nan=False))
            status = 0
        finally:
            sys.stdout.flush()
            sys.stderr.flush()
            # The Windows bpy 4.2 wheel exits 1 during glTF-addon finalization,
            # even after successful imports. End only this disposable test worker
            # after reporting its actual result. Exceptions still exit nonzero.
            if sys.platform == "win32":
                os._exit(status)
        sys.exit(status)
    else:
        unittest.main()
