"""Selected cleanup safety regressions; no models, GPU or SVG renderer.

Run: python -m unittest discover -s server -p vector_cleanup_test.py
"""
import math
import unittest
from unittest.mock import patch

import cv2
import numpy as np

import vector_curves as vc
from vector_cleanup import cleanup_mask, normalize_cleanup, parent_indices, _rasterize


def operation(kind, contours, maximum=4, **extra):
    return {"type": kind, "color": "#808080", "contours": contours,
            "maxDeviation": maximum, **extra}


def circle_mask(size=256, outer=104, inner=None):
    y, x = np.ogrid[:size, :size]
    radius = np.hypot(x-(size-1)/2, y-(size-1)/2)
    angle = np.arctan2(y-(size-1)/2, x-(size-1)/2)
    mask = (radius < outer+.6*np.sin(angle*31)).astype(np.uint8)
    if inner:
        mask[radius < inner+.8*np.cos(angle*27)] = 0
    return mask


class ContractTests(unittest.TestCase):
    def test_defaults_and_independent_palette_indexes(self):
        value = normalize_cleanup({"operations": [
            {"type": "smooth", "color": "#ABCDEF", "contours": [0, 3]},
            {"type": "circle", "color": "#808080", "contours": [0]}]})
        self.assertEqual(value["operations"][0], operation("smooth", [0, 3], 4, strength=.7) | {"color": "#abcdef"})
        self.assertEqual(value["operations"][1]["maxDeviation"], 4)
        self.assertNotIn("strength", value["operations"][1])
        self.assertIsNone(normalize_cleanup(None))
        self.assertEqual(normalize_cleanup({"operations": []}), {"operations": []})

    def test_rejects_unknown_duplicate_nonfinite_and_incompatible_controls(self):
        bad = [
            {"operations": [operation("smooth", [1]), operation("circle", [1])]},
            {"operations": [operation("smooth", [1, 1])]},
            {"operations": [operation("smooth", [True])]},
            {"operations": [operation("smooth", [1], float("nan"))]},
            {"operations": [operation("smooth", [1], 33)]},
            {"operations": [operation("smooth", [1], strength=2)]},
            {"operations": [operation("circle", [1], strength=.5)]},
            {"operations": [operation("circle", [1, 2])]},
            {"operations": [operation("concentric", [1])]},
            {"operations": [operation("auto", [1])]},
            {"operations": [operation("smooth", [1], prompt="change lettering")]},
            {"operations": [operation("smooth", [1])], "guess": True},
        ]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_cleanup(value)


class CleanupTests(unittest.TestCase):
    def test_pixel_cell_geometry_rasterizes_exactly_even_for_diagonal_gaps(self):
        rng = np.random.default_rng(10)
        mask = np.uint8(rng.random((31, 43)) > .63)
        cv2.rectangle(mask, (7, 4), (33, 26), 1, -1)
        cv2.line(mask, (9, 5), (30, 24), 0, 1)
        contours = vc._pixel_boundaries(mask)
        self.assertTrue(np.array_equal(_rasterize(contours, mask.shape), mask))

    def test_independent_objects_union_while_owned_counters_stay_hollow(self):
        def rectangle(left, top, right, bottom):
            return np.array([[left, top], [right, top], [right, bottom], [left, bottom]], float)
        objects = [rectangle(4, 4, 35, 35), rectangle(12, 12, 20, 20), rectangle(25, 20, 48, 48)]
        mask = _rasterize(objects, (55, 55), groups=[[0, 1], [2]])
        self.assertEqual(mask[15, 15], 0)
        self.assertEqual(mask[27, 30], 1)
        self.assertEqual(mask[43, 43], 1)
        self.assertEqual(_rasterize(objects, (55, 55))[27, 30], 0)

    def test_crossing_limit_refuses_before_expanded_allocation(self):
        polygon = np.array([[2, 2], [18, 2], [18, 18], [2, 18]], float)
        with patch("vector_cleanup.MAX_VALIDATION_CROSSINGS", 10), \
                patch("vector_cleanup.np.repeat", side_effect=AssertionError("allocated before checking")), \
                self.assertRaisesRegex(vc.TraceLimitError, "crossing limit"):
            _rasterize([polygon], (30, 30))

    def test_selected_circle_is_exact_arc_and_unselected_letter_is_byte_identical(self):
        mask = np.zeros((256, 420), np.uint8)
        mask[:, :256] = circle_mask()
        cv2.rectangle(mask, (300, 70), (380, 190), 1, -1)
        cv2.rectangle(mask, (323, 93), (358, 128), 0, -1)
        before, baseline = vc.trace_mask(mask, return_info=True)
        selected = next(i for i, c in enumerate(baseline["contours"]) if c["bounds"][0] < 50 and not c["hole"])
        after, info = cleanup_mask(mask, [operation("circle", [selected])])
        self.assertIn("A", after[selected])
        self.assertEqual(after[selected].count("A"), 2)
        self.assertTrue(all(a == b for i, (a, b) in enumerate(zip(before, after)) if i != selected))
        self.assertEqual(info["cleanupTopology"]["components"], 2)
        self.assertEqual(info["cleanupTopology"]["holes"], 1)
        measurement = info["cleanup"][0]["measurements"][0]
        self.assertLess(measurement["sourceToCurve"], 2)
        self.assertLess(measurement["curveToSource"], 2)

    def test_concentric_ring_keeps_hole_and_shared_center(self):
        mask = circle_mask(inner=83)
        after, info = cleanup_mask(mask, [operation("concentric", [0, 1])])
        self.assertEqual(len(after), 2)
        self.assertTrue(all(path.count("A") == 2 for path in after))
        metrics = info["cleanup"][0]["measurements"]
        self.assertEqual(metrics[0]["center"], metrics[1]["center"])
        self.assertEqual(sum(c["hole"] for c in info["contours"]), 1)
        self.assertEqual(info["contours"][1]["parent"], 0)
        self.assertEqual(info["cleanupTopology"]["holes"], 1)
        self.assertLess(max(max(m["sourceToCurve"], m["curveToSource"]) for m in metrics), 2)

    def test_parallelogram_rebuilds_parallel_sides_with_crisp_corners(self):
        mask = np.zeros((300, 300), np.uint8)
        cv2.fillPoly(mask, [np.array([[120, 25], [161, 25], [90, 265], [49, 265]])], 1)
        after, info = cleanup_mask(mask, [operation("parallelogram", [0])])
        self.assertEqual(after[0].count("L"), 3)
        self.assertNotIn("C", after[0])
        corners = np.array(info["cleanup"][0]["measurements"][0]["corners"])
        edges = np.roll(corners, -1, axis=0)-corners
        self.assertLess(abs(float(edges[0, 0]*edges[2, 1]-edges[0, 1]*edges[2, 0])), 1e-6)
        self.assertLess(abs(float(edges[1, 0]*edges[3, 1]-edges[1, 1]*edges[3, 0])), 1e-6)
        self.assertEqual(info["cleanupTopology"]["components"], 1)

    def test_smoothing_keeps_unselected_counter_and_wave_peak_corners(self):
        mask = np.zeros((240, 340), np.uint8)
        contour = np.array([[20, 130], [75, 45], [125, 125], [177, 35], [220, 135],
                            [220, 195], [20, 195]])
        cv2.fillPoly(mask, [contour], 1)
        cv2.rectangle(mask, (265, 60), (320, 185), 1, -1)
        cv2.rectangle(mask, (282, 80), (300, 130), 0, -1)
        baseline, _ = vc.trace_mask(mask, return_info=True)
        after, info = cleanup_mask(mask, [operation("smooth", [0], 4, strength=.7)])
        self.assertEqual(after[1:], baseline[1:])
        self.assertGreaterEqual(info["cleanup"][0]["measurements"][0]["protectedCorners"], 5)
        self.assertEqual(info["cleanupTopology"]["holes"], 1)
        self.assertLess(info["cleanup"][0]["measurements"][0]["maxFilteredPointMove"], 4)

    def test_zero_strength_is_exact_noop(self):
        mask = circle_mask(inner=80)
        baseline = vc.trace_mask(mask)
        after, info = cleanup_mask(mask, [operation("smooth", [0], strength=0)])
        self.assertEqual(after, baseline)
        self.assertTrue(info["cleanup"][0]["unchanged"])

    def test_selected_rough_straight_edges_become_long_lines(self):
        mask = np.zeros((170, 280), np.uint8)
        for x in range(25, 245):
            shift = int(round(1.3*math.sin(x*.14)))
            mask[30+shift:135+shift, x] = 1
        after, info = cleanup_mask(mask, [operation("smooth", [0])])
        self.assertGreaterEqual(info["cleanup"][0]["measurements"][0]["straightSegments"], 2)
        self.assertLess(info["cleanup"][0]["measurements"][0]["sourceToCurve"], 4)
        self.assertEqual(info["cleanupTopology"]["components"], 1)

    def test_rejects_wrong_shape_or_too_small_deviation(self):
        rectangle = np.zeros((180, 240), np.uint8)
        cv2.rectangle(rectangle, (10, 20), (225, 150), 1, -1)
        with self.assertRaisesRegex(ValueError, "circle|deviation"):
            cleanup_mask(rectangle, [operation("circle", [0])])
        with self.assertRaisesRegex(ValueError, "four-sided"):
            cleanup_mask(circle_mask(), [operation("parallelogram", [0])])
        with self.assertRaisesRegex(ValueError, "maxDeviation"):
            cleanup_mask(circle_mask(), [operation("circle", [0], .5)])

    def test_rejects_missing_or_repeated_indexes(self):
        mask = circle_mask()
        with self.assertRaisesRegex(ValueError, "not found"):
            cleanup_mask(mask, [operation("smooth", [2])])
        with self.assertRaisesRegex(ValueError, "only one"):
            cleanup_mask(mask, [operation("smooth", [0]), operation("circle", [0])])

    def test_rejects_topology_change(self):
        mask = circle_mask(inner=60)
        # A deliberately broken candidate proves the final guard checks the
        # rendered compound fill, not merely the number of contour records.
        import vector_cleanup as cleanup
        original = cleanup._fit_circles
        def broken(contours, spacing=.5):
            candidates = original(contours, spacing)
            return [candidates[0], candidates[0]]
        with patch("vector_cleanup._fit_circles", side_effect=broken), \
                patch("vector_cleanup._distances", return_value=(0, 0)), \
                self.assertRaisesRegex(ValueError, "connected shapes or holes"):
            cleanup_mask(mask, [operation("concentric", [0, 1])])

    def test_parent_inventory_uses_smallest_outer_contour(self):
        mask = np.zeros((220, 220), np.uint8)
        cv2.circle(mask, (110, 110), 105, 1, -1)
        cv2.circle(mask, (110, 110), 85, 0, -1)
        cv2.circle(mask, (110, 110), 60, 1, -1)
        cv2.circle(mask, (110, 110), 30, 0, -1)
        contours = vc._pixel_boundaries(mask)
        parents = parent_indices(contours)
        for index, parent in enumerate(parents):
            signed = cv2.contourArea(contours[index].astype(np.float32), oriented=True)
            self.assertEqual(parent is not None, signed < 0)
            if parent is not None:
                self.assertGreater(cv2.contourArea(contours[parent].astype(np.float32)), abs(signed))

    def test_existing_point_and_segment_limits_are_enforced(self):
        with self.assertRaises(vc.TraceLimitError):
            cleanup_mask(circle_mask(), [operation("circle", [0])], limits={"points": 100})
        with self.assertRaises(vc.TraceLimitError):
            cleanup_mask(circle_mask(), [operation("smooth", [0])], limits={"segments": 1})

    def test_scaled_working_tolerance_below_public_minimum_remains_valid(self):
        mask = np.zeros((80, 100), np.uint8)
        mask[12:68, 15:85] = 1
        _, info = cleanup_mask(mask, [operation("smooth", [0], .125)])
        receipt = info["cleanup"][0]
        self.assertAlmostEqual(receipt["samplingSpacing"], .025)
        metric = receipt["measurements"][0]
        self.assertLess(max(metric["sourceToCurve"], metric["curveToSource"])+.0125, .125)

    def test_one_pixel_shape_rejected_as_circle_with_readable_error(self):
        mask = np.zeros((10, 10), np.uint8)
        mask[5, 5] = 1
        with self.assertRaisesRegex(ValueError, "circular outline"):
            cleanup_mask(mask, [operation("circle", [0])])


if __name__ == "__main__":
    unittest.main()
