"""Behavioral SVG proof tests: saved artwork, holes, fills and refusal paths."""
import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

import vector_preview as vp


def svg(body, size='width="100" height="100" viewBox="0 0 100 100"'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" {size}>{body}</svg>'


class VectorProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.file = Path(self.temp.name) / "proof.svg"

    def tearDown(self):
        self.temp.cleanup()

    def render(self, document, **options):
        self.file.write_text(document, encoding="utf-8")
        result = vp.review_svg({"in": str(self.file), "maxEdge": 256, **options})
        image = Image.open(io.BytesIO(base64.b64decode(result["image"]["data"])))
        return result, np.asarray(image)

    def assertRejected(self, document, **options):
        self.file.write_text(document, encoding="utf-8")
        with self.assertRaises((ValueError, vp.imgpath.PathError)):
            vp.review_svg({"in": str(self.file), **options})

    def test_actual_svg_arcs_preserve_evenodd_ring_and_transparency(self):
        ring = 'M10 50A40 40 0 1 0 90 50A40 40 0 1 0 10 50Z'
        hole = 'M30 50A20 20 0 1 0 70 50A20 20 0 1 0 30 50Z'
        result, pixels = self.render(svg(f'<path fill="#cc2233" fill-rule="evenodd" d="{ring+hole}"/>'), background="transparent")
        self.assertEqual(result["renderer"], "aiplay-vector-cpu")
        self.assertEqual(result["image"]["mimeType"], "image/png")
        self.assertEqual(pixels.shape, (256, 256, 4))
        self.assertEqual(int(pixels[128, 128, 3]), 0)
        self.assertEqual(int(pixels[128, 51, 3]), 255)
        self.assertEqual(int(pixels[1, 1, 3]), 0)
        self.assertTrue(np.any((pixels[..., 3] > 0) & (pixels[..., 3] < 255)))

    def test_three_stop_gradient_and_translated_shadow_are_actual_pixels(self):
        body = ('<defs><linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="70" y2="0">'
                '<stop offset="0" stop-color="#ff0000"/><stop offset="0.5" stop-color="#00ff00"/>'
                '<stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
                '<g fill="#808080" transform="translate(10 10)"><path d="M10 10L70 10L70 60L10 60Z"/></g>'
                '<path fill="url(#ink)" d="M10 10L70 10L70 60L10 60Z"/>')
        _, p = self.render(svg(body))
        self.assertTrue(p[75, 28, 0] > 240 and p[75, 28, 1] < 20)
        self.assertTrue(p[75, 102, 1] > 240)
        self.assertTrue(p[75, 175, 2] > 240)
        self.assertEqual(p[165, 192].tolist(), [128, 128, 128, 255])
        self.assertEqual(p[220, 220].tolist(), [255, 255, 255, 255])

    def test_cubic_path_and_nested_group_fill_translate(self):
        document = svg('<g fill="rgb(12,34,56)" transform="translate(5, 5)"><g transform="translate(5)">'
                       '<path d="M10 10C10 0 40 0 40 10L40 40L10 40Z"/></g></g>')
        _, p = self.render(document, crop=[20, 15, 20, 20])
        self.assertEqual(p[128, 128].tolist(), [12, 34, 56, 255])

    def test_crop_is_in_source_pixels_and_honors_viewbox_offset_and_meet(self):
        document = svg('<path fill="#112233" d="M10 20L35 20L35 45L10 45Z"/>',
                       'width="200" height="100" viewBox="10 20 100 100"')
        result, p = self.render(document, crop=[50, 0, 25, 25])
        self.assertEqual(result["sourceWidth"], 200)
        self.assertEqual(result["crop"], [50, 0, 25, 25])
        self.assertEqual(p[128, 128].tolist(), [17, 34, 51, 255])
        _, full = self.render(document)
        self.assertEqual(full.shape, (128, 256, 4))
        self.assertEqual(full[15, 25].tolist(), [255, 255, 255, 255])
        self.assertEqual(full[15, 75].tolist(), [17, 34, 51, 255])

    def test_none_aspect_mapping_uses_source_coordinate_crop(self):
        document = svg('<path fill="#445566" d="M0 0L50 0L50 100L0 100Z"/>',
                       'width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"')
        _, p = self.render(document, crop=[50, 25, 25, 25])
        self.assertEqual(p[128, 128].tolist(), [68, 85, 102, 255])

    def test_transformed_user_space_gradient_moves_with_its_path(self):
        document = svg('<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="20" y2="0">'
                       '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>'
                       '</linearGradient></defs><g transform="translate(50 20)"><path fill="url(#g)" d="M0 0L20 0L20 20L0 20Z"/></g>')
        _, p = self.render(document, crop=[50, 20, 20, 20])
        self.assertTrue(p[128, 5, 0] > 240)
        self.assertTrue(p[128, 250, 2] > 240)

    def test_nonzero_rule_is_not_silently_replaced_with_evenodd(self):
        outer = 'M10 10L90 10L90 90L10 90Z'
        same_winding_hole = 'M30 30L70 30L70 70L30 70Z'
        _, p = self.render(svg(f'<path fill="#112233" d="{outer+same_winding_hole}"/>'))
        self.assertEqual(p[128, 128].tolist(), [17, 34, 51, 255])
        _, p = self.render(svg(f'<path fill="#112233" fill-rule="evenodd" d="{outer+same_winding_hole}"/>'))
        self.assertEqual(p[128, 128].tolist(), [255, 255, 255, 255])

    def test_empty_svg_and_none_fill_are_ordinary_transparent_proofs(self):
        for body in ('', '<path fill="none" d="M0 0L100 0L100 100Z"/>'):
            _, p = self.render(svg(body), background="transparent")
            self.assertEqual(int(p[..., 3].sum()), 0)

    def test_many_disjoint_paths_at_1536_paint_only_local_regions_and_keep_counters(self):
        body = []
        for row in range(10):
            for column in range(10):
                x, y = column*100+10, row*100+10
                outer = f'M{x} {y}h60v60h-60Z'
                hole = f'M{x+20} {y+20}h20v20h-20Z'
                body.append(f'<path fill="#123456" fill-rule="evenodd" d="{outer+hole}"/>')
        mask_sizes = []
        rasterize = vp._proof_mask
        def recorded_mask(polygons, width, height, rule, budget):
            mask_sizes.append((width, height))
            return rasterize(polygons, width, height, rule, budget)
        with patch.object(vp, '_proof_mask', side_effect=recorded_mask):
            result, pixels = self.render(svg(''.join(body), 'width="1000" height="1000" viewBox="0 0 1000 1000"'),
                                         maxEdge=1536, background="transparent")
        self.assertEqual((result['width'], result['height']), (1536, 1536))
        self.assertEqual(len(mask_sizes), 100)
        self.assertLess(sum(w*h for w, h in mask_sizes), 1_000_000)
        self.assertTrue(all(w < 100 and h < 100 for w, h in mask_sizes))
        for row, column in ((0, 0), (5, 7), (9, 9)):
            x, y = column*100+10, row*100+10
            self.assertEqual(int(pixels[round((y+30)*1.536), round((x+30)*1.536), 3]), 0)
            self.assertEqual(pixels[round((y+10)*1.536), round((x+10)*1.536)].tolist(), [18, 52, 86, 255])

    def test_unsupported_active_and_external_markup_is_refused(self):
        bad = ['<script>alert(1)</script>', '<image href="file:///private.png"/>',
               '<use href="#p"/>', '<text>Letter</text>', '<style>path{fill:red}</style>',
               '<foreignObject/>', '<path onclick="alert(1)" d="M0 0L20 20Z"/>',
               '<path style="fill:red" d="M0 0L20 20Z"/>',
               '<path fill="url(https://example.com/x.svg#g)" d="M0 0L20 20Z"/>',
               '<g transform="scale(2)"><path d="M0 0L20 20Z"/></g>',
               '<defs><linearGradient id="g" href="https://example.com/g"/></defs>']
        for body in bad:
            with self.subTest(body=body):
                self.assertRejected(svg(body))
        self.assertRejected('<?xml-stylesheet href="https://example.com/x.css"?>'+svg(''))
        self.assertRejected('<!DOCTYPE svg [<!ENTITY x "expanded">]>'+svg('<title>&x;</title>'))

    def test_unknown_namespace_nested_metadata_and_duplicate_ids_are_refused(self):
        for body in ('<other xmlns="urn:unknown"/>', '<metadata><path d="M0 0L20 20Z"/></metadata>',
                     '<title id="x">a</title><path id="x" d="M0 0L20 20Z"/>'):
            self.assertRejected(svg(body))

    def test_invalid_numbers_crop_gradients_and_arc_flags_are_refused(self):
        for path in ('M0 0L1e999 1Z', 'M0 0A10 10 0 2 0 20 20Z', 'M0 0A-10 10 0 0 0 20 20Z'):
            self.assertRejected(svg(f'<path d="{path}"/>'))
        for options in ({"maxEdge": 255}, {"maxEdge": 768.5}, {"crop": [-1, 0, 20, 20]},
                        {"crop": [90, 0, 20, 20]}, {"crop": [0, 0, 0, 20]}, {"crop": [0, 0, float("nan"), 20]},
                        {"background": "url(#g)"}):
            self.assertRejected(svg(''), **options)
        self.assertRejected(svg('<defs><linearGradient id="g" gradientUnits="objectBoundingBox"/></defs>'))
        self.assertRejected(svg('<path fill="url(#missing)" d="M0 0L20 0L20 20Z"/>'))

    def test_explicit_resource_budgets_refuse_instead_of_partial_proof(self):
        circle = svg('<path d="M10 50A40 40 0 1 0 90 50A40 40 0 1 0 10 50Z"/>')
        for cap in ("MAX_POINTS", "MAX_CROSSINGS", "MAX_TOKENS", "MAX_ANCHORS", "MAX_PAINT_PIXELS", "MAX_BYTES"):
            with self.subTest(cap=cap), patch.object(vp, cap, 1):
                self.assertRejected(circle)


if __name__ == "__main__":
    unittest.main()
