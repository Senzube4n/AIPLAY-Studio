"""CPU-only regression tests for SparseCtrl timeline-to-picture mapping.

Extract the actual pure helper from the node so this test does not import
ComfyUI or allocate model/GPU state.
"""
import ast
import math
from pathlib import Path
import unittest

source = Path(__file__).with_name("comfy_nodes") / "aiplay_sparsectrl.py"
tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_keyframe_image_pairs")
namespace = {"math": math}
exec(compile(ast.Module(body=[helper], type_ignores=[]), str(source), "exec"), namespace)
pairs = namespace["_keyframe_image_pairs"]


class SparsePictureMappingTests(unittest.TestCase):
    def test_late_timeline_frames_are_not_filtered_by_short_picture_batch(self):
        self.assertEqual(pairs([0, 12, 24, 36], [0, 1, 0, 1], 48, 2), [(0, 0), (12, 1), (24, 0), (36, 1)])

    def test_sorting_keeps_picture_and_target_paired(self):
        self.assertEqual(pairs([24, 0, 12], [1, 2, 0], 32, 3), [(0, 2), (12, 0), (24, 1)])

    def test_source_mode_remains_compatible(self):
        self.assertEqual(pairs([8, 0, 8, 99, -1], None, 16, 16), [(0, 0), (8, 8)])

    def test_mapping_requires_one_picture_per_hit(self):
        with self.assertRaisesRegex(ValueError, "one picture"):
            pairs([0, 8], [0], 16, 2)

    def test_mapping_rejects_invalid_or_duplicate_timeline_positions(self):
        for positions in ([0, 16], [0, 0], [0, -1], [0, 2.5], [0, float("nan")]):
            with self.subTest(positions=positions), self.assertRaises(ValueError):
                pairs(positions, [0, 1], 16, 2)

    def test_mapping_rejects_invalid_picture_indexes(self):
        for picture in (-1, 2, 0.5, True, float("nan")):
            with self.subTest(picture=picture), self.assertRaisesRegex(ValueError, "image_indices"):
                pairs([8], [picture], 16, 2)


if __name__ == "__main__":
    unittest.main()
