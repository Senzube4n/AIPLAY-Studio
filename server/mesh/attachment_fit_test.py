import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import attachment_fit as fit
import weight_transfer as wt
from weight_transfer_test import fixture, rewrite, translate


class AttachmentFittingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            wt.runtime()
        except RuntimeError as error:
            raise unittest.SkipTest(str(error))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.reference = fixture(self.root / "body.glb", True)
        self.target = fixture(self.root / "part.glb")
        self.output = self.root / "prepared.glb"
        self.options = {**fit.DEFAULTS, "expected_skeleton": wt.inspect_reference(self.reference)["skeleton"],
                        "reference_mesh_node": 4, "reference_primitive": 0}

    def test_real_fit_recovers_scale_and_position_then_deforms(self):
        original = self.target.read_bytes()
        # Target square has half the dimensions, so factor2 restores the base.
        report = fit.fit(self.reference, self.target, self.output, self.options)
        self.assertAlmostEqual(report["fit"]["scale"], 2)
        self.assertAlmostEqual(report["fit"]["maxAfterDistance"], .006, places=5)
        self.assertEqual(report["vertices"], 4)
        self.assertEqual(self.target.read_bytes(), original)
        doc, binary = wt.read_glb(self.output)
        self.assertEqual(doc["nodes"][0]["name"], "Fitted attachment")
        self.assertEqual(doc["extras"]["aiplayWeightTransfer"]["baseJointNodes"], [1, 2, 3])
        self.assertEqual(wt.validate_skinned_glb(self.output)["joints"], 3)
        self.assertEqual(len(doc["images"]), 1)
        child = subprocess.run([sys.executable, str(Path(__file__).with_name("weight_transfer_test.py")), "--verify-blender", str(self.output)],
                               capture_output=True, text=True, timeout=60)
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        evidence = json.loads(next(line.split(":", 1)[1] for line in child.stdout.splitlines() if line.startswith("BLENDER_EVIDENCE:")))
        self.assertGreater(evidence["maxMovement"], .001)
        self.assertGreater(evidence["movedVertices"], 0)

    def test_distance_scale_and_surface_mismatch_preserve_existing_output(self):
        self.output.write_bytes(b"old output")
        for overrides, message in [({"alignment": "keep"}, "max_displacement"),
                                   ({"max_scale_change": 1.5}, "max_scale_change"),
                                   ({"reference_primitive": 7}, "primitive"),
                                   ({"expected_skeleton": "f" * 64}, "skeleton")]:
            with self.assertRaisesRegex(ValueError, message):
                fit.fit(self.reference, self.target, self.output, {**self.options, **overrides})
            self.assertEqual(self.output.read_bytes(), b"old output")

    def test_inverted_surface_fit_is_refused(self):
        rewrite(self.target, lambda d: d["nodes"][0].update(scale=[-1, 1, 1]))
        with self.assertRaisesRegex(ValueError, "orientation|fold|collapse"):
            fit.fit(self.reference, self.target, self.output, self.options)

    def test_unused_texture_and_accessor_resources_are_removed(self):
        doc, binary = wt.read_glb(self.target)
        original_image = copy.deepcopy(doc["images"][0])
        view = doc["bufferViews"][original_image["bufferView"]]
        expected = binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]
        doc["images"].append(copy.deepcopy(original_image))
        doc["textures"].append({"source": 1})
        doc["materials"].append({"pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}})
        self.target.write_bytes(wt.pack_glb(doc, binary))
        fit.fit(self.reference, self.target, self.output, self.options)
        output, data = wt.read_glb(self.output)
        self.assertEqual([len(output[k]) for k in ("materials", "textures", "images")], [1, 1, 1])
        view = output["bufferViews"][output["images"][0]["bufferView"]]
        self.assertEqual(data[view["byteOffset"]:view["byteOffset"] + view["byteLength"]], expected)

    def test_unsupported_input_and_nonfinite_options_fail(self):
        for options in ({**self.options, "clearance": float("nan")}, {**self.options, "alignment": "guess"}, {**self.options, "unknown": 1}):
            with self.assertRaises(ValueError):
                fit.fit(self.reference, self.target, self.output, options)
        rewrite(self.target, lambda d: d.update(animations=[{}]))
        with self.assertRaisesRegex(ValueError, "static"):
            fit.inventory(self.reference, self.target)


if __name__ == "__main__":
    unittest.main()
