"""Geometry, alpha, option and bounded-output regressions for vectorization.

Run: python -m unittest discover -s server -p vector_trace_test.py
No optional SVG renderer, external model or GPU is required.
"""
import json
import base64
import io
import math
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import cv2
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

from vector_curves import TraceLimitError, _eval, _pixel_boundaries, _point_polyline_dist2, trace_mask
from vector_trace import settings_for, trace_image
from vector_preview import review_svg


def sample(d, spacing=.25):
    result = []
    pos, start = None, None
    for op, nums in re.findall(r"([MLCZ])([^MLCZ]*)", d):
        if op == "Z":
            if np.linalg.norm(pos-start) > 1e-8:
                n = max(2, int(np.linalg.norm(start-pos)/spacing)+1)
                result.extend(np.linspace(pos, start, n))
            pos = start
            continue
        xy = np.asarray([float(n) for n in re.findall(r"[-+]?\d*\.?\d+", nums)]).reshape(-1, 2)
        if op == "M":
            pos = xy[0]
            start = pos.copy()
        elif op == "L":
            n = max(2, int(np.linalg.norm(xy[0]-pos)/spacing)+1)
            result.extend(np.linspace(pos, xy[0], n))
            pos = xy[0]
        else:
            c = np.r_[pos[None, :], xy]
            length = float(np.linalg.norm(np.diff(c, axis=0), axis=1).sum())
            result.extend(_eval(c, np.linspace(0, 1, max(8, int(length/spacing)+1))))
            pos = xy[-1]
    return np.asarray(result)


def rasterize(paths, shape):
    # Sample inside each pixel, avoiding an edge-inclusion ambiguity. Higher
    # resolution also avoids treating tiny holes as integer-rounded lines.
    scale = 4
    raster = np.zeros((shape[0]*scale, shape[1]*scale), np.uint8)
    for d in paths:
        face = np.zeros_like(raster)
        cv2.fillPoly(face, [np.rint(sample(d)*scale).astype(np.int32)], 1)
        raster ^= face
    return raster[scale//2::scale, scale//2::scale]


def topology(mask):
    contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    return (cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)[0]-1,
            0 if hierarchy is None else int(np.count_nonzero(hierarchy[0, :, 3] >= 0)))


class GeometryTests(unittest.TestCase):
    def assert_topology(self, mask, expected, **options):
        paths, info = trace_mask(mask, return_info=True, **options)
        self.assertEqual(topology(rasterize(paths, mask.shape)), expected)
        self.assertTrue(all(d.endswith("Z") and not re.search(r"nan|inf", d) for d in paths))
        self.assertEqual(sum(contour["hole"] for contour in info["contours"]), expected[1])
        return paths, info

    def test_4096_circle_is_full_resolution_and_eight_cubics(self):
        size = 4096
        y, x = np.ogrid[:size, :size]
        mask = ((x-2047.5)**2+(y-2047.5)**2 < 1750**2).astype(np.uint8)
        paths, info = trace_mask(mask, return_info=True)
        self.assertEqual(info["width"], 4096)
        self.assertEqual((info["ellipses"], info["segments"], len(paths)), (1, 8, 1))
        points = sample(paths[0])
        radius = np.linalg.norm(points-[2048, 2048], axis=1)
        self.assertLess(float(radius.max()-radius.min()), .03)
        reference = _pixel_boundaries(mask)[0]
        # Sampled bidirectional error includes raster steps and sampling.
        error = max(cKDTree(points).query(reference)[0].max(), cKDTree(reference).query(points)[0].max())
        self.assertLess(error, 1.0)

    def test_donut_and_nested_rings_keep_holes(self):
        mask = np.zeros((256, 256), np.uint8)
        cv2.circle(mask, (128, 128), 115, 1, -1)
        cv2.circle(mask, (128, 128), 90, 0, -1)
        self.assert_topology(mask, (1, 1))
        cv2.circle(mask, (128, 128), 55, 1, -1)
        cv2.circle(mask, (128, 128), 25, 0, -1)
        self.assert_topology(mask, (2, 2))

    def test_rectangle_preserves_four_sharp_sides(self):
        mask = np.zeros((2048, 2048), np.uint8)
        mask[333:1683, 240:1778] = 1
        paths, info = trace_mask(mask, return_info=True)
        self.assertEqual(info["segments"], 4)
        self.assertEqual(info["contours"][0]["bounds"], [240., 333., 1538., 1350.])
        self.assertEqual(info["contours"][0]["corners"], 4)
        self.assertNotIn("C", paths[0])

    def test_thin_strokes_single_pixel_and_punctuation(self):
        mask = np.zeros((128, 128), np.uint8)
        mask[10:80, 12] = 1
        mask[91, 12] = 1
        mask[15:70, 40:80] = 1
        mask[40, 60] = 0
        _, info = self.assert_topology(mask, (3, 1))
        self.assertEqual(min(contour["area"] for contour in info["contours"]), 1.)
        # Large Minimum area removes only the detached punctuation. It must
        # never remove a one-pixel counter in a retained component.
        _, info = self.assert_topology(mask, (2, 1), min_area=20)
        self.assertEqual(info["removed_components"], 1)

    def test_staircase_and_thin_branch_geometry(self):
        wave = np.zeros((512, 768), np.uint8)
        x = np.arange(80, 688)
        y = np.rint(130+65*np.sin((x-80)/608*math.pi)).astype(int)
        cv2.fillPoly(wave, [np.r_[np.c_[x, y], np.c_[x[::-1], (y+100)[::-1]]].astype(np.int32)], 1)
        self.assert_topology(wave, (1, 0))
        branch = np.zeros((1024, 1024), np.uint8)
        cv2.fillPoly(branch, [np.asarray([[150, 900], [280, 890], [760, 100], [680, 90],
                                         [450, 580], [420, 380], [355, 405], [390, 660]])], 1)
        paths, _ = self.assert_topology(branch, (1, 0))
        reference = np.concatenate(_pixel_boundaries(branch))
        fitted = np.concatenate([sample(d) for d in paths])
        error = max(cKDTree(reference).query(fitted)[0].max(), cKDTree(fitted).query(reference)[0].max())
        self.assertLess(error, 1.2)

    def test_rounded_rectangle_is_not_misclassified_as_ellipse(self):
        mask = np.zeros((512, 512), np.uint8)
        mask[120:392, 75:437] = 1
        mask[75:437, 120:392] = 1
        for center in ((120, 120), (120, 391), (391, 120), (391, 391)):
            cv2.circle(mask, center, 45, 1, -1)
        _, info = self.assert_topology(mask, (1, 0))
        self.assertEqual(info["ellipses"], 0)

    def test_detail_does_not_change_tolerance(self):
        mask = np.zeros((30, 30), np.uint8)
        cv2.circle(mask, (15, 15), 10, 1, -1)
        _, low = trace_mask(mask, error=.8, detail=.2, return_info=True)
        _, high = trace_mask(mask, error=.8, detail=4, return_info=True)
        self.assertEqual(low["tolerance"], high["tolerance"])
        self.assertGreater(low["smoothing_bound"], high["smoothing_bound"])

    def test_geometry_limits_fail_clearly(self):
        mask = np.zeros((64, 64), np.uint8)
        mask[::2, ::2] = 1
        with self.assertRaisesRegex(TraceLimitError, "boundary-point"):
            trace_mask(mask, limits={"points": 100})
        with self.assertRaisesRegex(TraceLimitError, "contour limit"):
            trace_mask(mask, limits={"contours": 5})
        with self.assertRaisesRegex(TraceLimitError, "segment limit"):
            trace_mask(mask, limits={"segments": 2})

    def test_local_distance_candidates_match_dense_exact_distances(self):
        rng = np.random.default_rng(45)
        for scale in (1, 100):
            p = np.cumsum(rng.normal(size=(120, 2))*scale, axis=0)
            p[30] = p[29]  # A zero-length edge is still valid.
            q = rng.normal(size=(90, 2))*scale*20
            a, v = p[:-1], p[1:]-p[:-1]
            vv = np.sum(v*v, axis=1)
            t = np.sum((q[:, None, :]-a[None, :, :])*v[None, :, :], axis=2)/np.maximum(vv[None, :], 1e-20)
            projected = a[None, :, :]+np.clip(t, 0, 1)[..., None]*v[None, :, :]
            dense = np.min(np.sum((q[:, None, :]-projected)**2, axis=2), axis=1)
            np.testing.assert_allclose(_point_polyline_dist2(q, p), dense, atol=1e-8)


class ImageTraceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def run_image(self, rgba, name="test", **options):
        source, out = self.root/(name+".png"), self.root/(name+".svg")
        Image.fromarray(rgba, "RGBA").save(source)
        receipt = trace_image({"in": str(source), "out": str(out), **options})
        xml = ET.parse(out).getroot()
        return receipt, xml, out

    def test_invisible_rgb_cannot_affect_palette_or_geometry(self):
        rgba = np.zeros((96, 128, 4), np.uint8)
        rgba[20:75, 20:90] = [18, 52, 86, 255]
        other = rgba.copy()
        other[other[..., 3] == 0, :3] = np.random.default_rng(123).integers(0, 256, (np.count_nonzero(other[..., 3] == 0), 3), dtype=np.uint8)
        ns = {"svg": "http://www.w3.org/2000/svg"}
        for mode in ("logo", "posterize"):
            first, x1, _ = self.run_image(rgba, "clear-"+mode, mode=mode)
            second, x2, _ = self.run_image(other, "hidden-"+mode, mode=mode)
            self.assertEqual(first["palette"], ["#123456"])
            self.assertEqual(first["palette"], second["palette"])
            self.assertEqual([p.attrib for p in x1.findall("svg:path", ns)], [p.attrib for p in x2.findall("svg:path", ns)])

    def test_outline_inventory_basis_and_replay_bind_to_source_and_base_settings(self):
        rgba=np.zeros((96,160,4),np.uint8)
        rgba[10:70,10:70]=[18,52,86,255]
        rgba[30:50,30:50,3]=0
        rgba[20:60,100:145]=[18,52,86,255]
        first,_,_=self.run_image(rgba,'inventory')
        self.assertEqual(len(first['shapes']),3)
        hole=next(s for s in first['shapes'] if s['hole'])
        parent=next(s for s in first['shapes'] if s['contour']==hole['parent'])
        self.assertFalse(parent['hole'])
        self.assertEqual(parent['bounds'],[10.,10.,60.,60.])
        self.assertEqual(len(first['traceFingerprint']),64)
        replay={k:v for k,v in first['replay'].items() if k!='name'}
        second,_,_=self.run_image(rgba,'replay',**replay)
        self.assertEqual(first['traceFingerprint'],second['traceFingerprint'])
        changed=rgba.copy();changed[12,12,0]=99
        with self.assertRaisesRegex(ValueError,'basis is stale'):
            self.run_image(changed,'changed-source',**replay)
        with self.assertRaisesRegex(ValueError,'basis is stale'):
            self.run_image(rgba,'changed-settings',**{**replay,'tolerance':1.1})

    def test_selected_local_gradient_and_shadow_keep_counters_and_other_geometry(self):
        rgba=np.zeros((96,160,4),np.uint8)
        rgba[10:70,10:70]=[18,52,86,255]
        rgba[30:50,30:50,3]=0
        rgba[20:60,100:145]=[18,52,86,255]
        first,xml,_=self.run_image(rgba,'group-source')
        shapes=first['shapes'];hole=next(s for s in shapes if s['hole'])
        ids=[hole['parent'],hole['contour']]
        selection={'color':'#123456','contours':ids}
        composition={'fills':[{**selection,'gradient':{'stops':[{'offset':0,'color':'#ff0000'},{'offset':1,'color':'#00ffff'}]}}],
                     'shadows':[{**selection,'offset':[12,14],'fill':'#c3c3c3'}]}
        edited,result,out=self.run_image(rgba,'group-edit',basis=first['traceFingerprint'],composition=composition)
        ns={'s':'http://www.w3.org/2000/svg'}
        gradient=result.find('s:defs/s:linearGradient',ns)
        self.assertEqual([float(gradient.get(k)) for k in ('x1','x2')],[10.,70.])
        shadow,plain,filled=result.findall('s:path',ns)
        self.assertEqual(shadow.get('transform'),'translate(12.000000 14.000000)')
        self.assertEqual(shadow.get('d'),filled.get('d'))
        self.assertEqual(filled.get('d').count('M'),2)
        baseline_parts=[p.get('d') for p in xml.findall('s:path',ns)]
        self.assertIn(plain.get('d'),baseline_parts)
        self.assertEqual(json.loads(result.find('s:metadata',ns).text),edited)
        self.assertEqual(edited['bytes'],out.stat().st_size)
        self.assertEqual(first['traceFingerprint'],edited['traceFingerprint'])
        with self.assertRaisesRegex(ValueError,'together with their holes'):
            self.run_image(rgba,'lost-counter',basis=first['traceFingerprint'],composition={'fills':[{'color':'#123456','contours':[hole['parent']],'solid':'#ffffff'}]})

    def test_explicit_omission_of_a_hole_is_an_intentional_fill(self):
        rgba=np.zeros((80,80,4),np.uint8)
        rgba[10:70,10:70]=[18,52,86,255];rgba[30:50,30:50,3]=0
        first,_,_=self.run_image(rgba,'omit-source')
        hole=next(s for s in first['shapes'] if s['hole'])
        _,xml,_=self.run_image(rgba,'omit-hole',basis=first['traceFingerprint'],composition={'omit':[{'color':'#123456','contours':[hole['contour']]}]})
        self.assertEqual(xml.find('{*}path').get('d').count('M'),1)
        _,filled,_=self.run_image(rgba,'omit-hole-and-fill',basis=first['traceFingerprint'],composition={
            'omit':[{'color':'#123456','contours':[hole['contour']]}],
            'fills':[{'color':'#123456','contours':[hole['parent']],'solid':'#ff0000'}]})
        self.assertEqual(filled.find('{*}path').get('d').count('M'),1)

    def test_overlapping_fitted_objects_union_without_losing_owned_counters(self):
        rgba=np.zeros((100,100,4),np.uint8)
        rgba[10:80,10:55]=[18,52,86,255];rgba[25:40,20:35,3]=0
        rgba[10:80,56:90]=[18,52,86,255]
        original=trace_mask
        def overlapping(mask,**kwargs):
            parts,info=original(mask,**kwargs)
            second=next(i for i,c in enumerate(info['contours']) if not c['hole'] and c['bounds'][0]>55)
            parts[second]='M53,10L90,10L90,80L53,80Z'
            return parts,info
        with patch('vector_trace.trace_mask',side_effect=overlapping):
            _,xml,out=self.run_image(rgba,'overlap')
        self.assertEqual(len(xml.findall('{*}path')),2)
        rendered=review_svg({'in':str(out),'maxEdge':1000,'background':'#ffffff'})
        pixels=np.asarray(Image.open(io.BytesIO(base64.b64decode(rendered['image']['data']))))
        self.assertTrue(np.all(pixels[500,540,:3] < 150), 'Overlap must stay colored instead of an XOR pinhole')
        self.assertTrue(np.all(pixels[300,250,:3] > 240), 'Owned letter counter must remain open')

    def test_cleanup_measurements_stay_in_source_pixels_after_downscaling(self):
        rgba=np.zeros((512,512,4),np.uint8)
        mask=np.zeros((512,512),np.uint8);cv2.circle(mask,(256,256),150,255,-1)
        rgba[...,3]=mask;rgba[mask>0,:3]=[18,52,86]
        first,_,_=self.run_image(rgba,'scale-source',maxSize=128)
        cleanup={'operations':[{'color':'#123456','contours':[0],'type':'circle','maxDeviation':8}]}
        edited,_,_=self.run_image(rgba,'scale-clean',maxSize=128,basis=first['traceFingerprint'],cleanup=cleanup)
        self.assertEqual(edited['cleanup'][0]['maxDeviation'],8)
        self.assertEqual(edited['cleanup'][0]['primitiveCoordinateSpace'],'tracePixels')
        measurement=edited['cleanup'][0]['measurements'][0]
        self.assertLess(measurement['sourceToCurve'],8)
        self.assertGreater(measurement['sourceToCurve'],.5)
        self.assertEqual(edited['replay']['cleanup'],cleanup)

    def test_selected_plan_errors_fail_before_replacing_output(self):
        rgba=np.zeros((64,64,4),np.uint8);rgba[10:50,10:50]=[18,52,86,255]
        first,_,_=self.run_image(rgba,'invalid-source')
        for composition in [{'fills':[{'color':'#123456','contours':[99],'solid':'#ffffff'}]},
                            {'shadows':[{'color':'#abcdef','contours':[0],'offset':[1,1],'fill':'#ffffff'}]},
                            {'fills':[{'color':'#123456','contours':[0],'solid':'#ffffff','gradient':{}}]}]:
            with self.assertRaises(ValueError):
                self.run_image(rgba,'invalid-plan',basis=first['traceFingerprint'],composition=composition)

    def test_invisible_rgb_is_excluded_during_downscaling(self):
        rgba = np.zeros((256, 256, 4), np.uint8)
        rgba[30:210, 30:210] = [18, 52, 86, 255]
        hidden = rgba.copy()
        hidden[hidden[..., 3] == 0, :3] = [255, 0, 230]
        first, _, _ = self.run_image(rgba, "scaled1", maxSize=64)
        second, _, _ = self.run_image(hidden, "scaled2", maxSize=64)
        self.assertEqual(first["palette"], second["palette"])
        self.assertEqual(first["stats"], second["stats"])

    def test_alpha_shapes_ignore_gradient_bands_and_keep_holes_for_explicit_fills(self):
        rgba = np.zeros((96, 128, 4), np.uint8)
        rgba[10:86, 10:118, 3] = 255
        rgba[32:60, 40:88, 3] = 0
        rgba[..., 0] = np.arange(128, dtype=np.uint8)*2
        rgba[..., 2] = 255-rgba[..., 0]
        neutral, xml, _ = self.run_image(rgba, "alpha", mode="silhouette")
        changed = rgba.copy()
        changed[..., :3] = np.random.default_rng(44).integers(0, 256, (96, 128, 3), dtype=np.uint8)
        gradients = [{"color": "#808080", "angle": 45,
                      "stops": [{"offset": 0, "color": "#ff00ff"}, {"offset": 1, "color": "#00ffff"}]}]
        filled, edited, _ = self.run_image(changed, "alpha-fill", mode="silhouette", gradients=gradients)
        ns = {"svg": "http://www.w3.org/2000/svg"}
        self.assertEqual(neutral["palette"], ["#808080"])
        self.assertEqual(neutral["paths"], 1)
        self.assertEqual(neutral["stats"]["holes"], 1)
        self.assertEqual(neutral["stats"], filled["stats"])
        self.assertEqual(xml.find("svg:path", ns).attrib["d"], edited.find("svg:path", ns).attrib["d"])
        self.assertEqual(edited.find("svg:path", ns).attrib["fill"], "url(#gradient-0)")
        opaque = rgba.copy()
        opaque[..., 3] = 255
        receipt, _, _ = self.run_image(opaque, "opaque-alpha", mode="silhouette")
        self.assertTrue(any("whole canvas" in warning for warning in receipt["warnings"]))

    def test_minimum_area_remains_in_source_coordinates(self):
        rgba = np.zeros((400, 400, 4), np.uint8)
        rgba[40:60, 40:60] = [18, 52, 86, 255]
        keep, xml, _ = self.run_image(rgba, "keep", maxSize=100, minArea=300)
        remove, _, _ = self.run_image(rgba, "remove", maxSize=100, minArea=500)
        self.assertEqual((keep["paths"], remove["paths"]), (1, 0))
        self.assertEqual(keep["settings"]["effectiveTraceMinArea"], 18.75)
        self.assertEqual(keep["settings"]["effectiveTraceTolerance"], .2)
        self.assertEqual((keep["sourceWidth"], keep["width"]), (400, 100))
        self.assertEqual((xml.attrib["width"], xml.attrib["height"]), ("400", "400"))
        self.assertEqual(xml.attrib["viewBox"], "0 0 100 100")
        self.assertTrue(any("resized" in warning for warning in keep["warnings"]))

    def test_explicit_gradients_are_common_coordinate_fills_and_metadata_matches(self):
        rgba = np.zeros((64, 96, 4), np.uint8)
        rgba[10:30, 10:30] = [18, 52, 86, 255]
        rgba[35:55, 60:80] = [18, 52, 86, 255]
        gradients = [{"color": "#123456", "angle": 0,
                      "stops": [{"offset": 0, "color": "#ff0000"}, {"offset": 1, "color": "#0000ff"}]}]
        result, xml, out = self.run_image(rgba, gradients=gradients)
        ns = {"svg": "http://www.w3.org/2000/svg"}
        gradient = xml.find("svg:defs/svg:linearGradient", ns)
        self.assertEqual(gradient.attrib["gradientUnits"], "userSpaceOnUse")
        self.assertEqual((float(gradient.attrib["x1"]), float(gradient.attrib["x2"])), (0., 96.))
        paths = xml.findall("svg:path", ns)
        self.assertEqual(len(paths),2)
        path = paths[0]
        self.assertEqual(path.attrib["fill"], "url(#gradient-0)")
        self.assertTrue(all(p.attrib['fill']=='url(#gradient-0)' and p.attrib['d'].count('M')==1 for p in paths))
        self.assertEqual(json.loads(xml.find("svg:metadata", ns).text), result)
        self.assertEqual(result["bytes"], out.stat().st_size)
        self.assertFalse(list(self.root.glob(".*.vector-*.tmp")))
        plain, plain_xml, _ = self.run_image(rgba, "plain")
        self.assertEqual(plain_xml.find("svg:path", ns).attrib["d"], path.attrib["d"])
        self.assertEqual(plain["palette"], result["palette"])

    def test_absent_and_pruned_gradient_regions_are_rejected(self):
        rgba = np.zeros((64, 64, 4), np.uint8)
        rgba[20:21, 20:21] = [18, 52, 86, 255]
        gradient = {"color": "#123456", "stops": [{"offset": 0, "color": "#000000"}, {"offset": 1, "color": "#ffffff"}]}
        with self.assertRaisesRegex(ValueError, "removed by Minimum area"):
            self.run_image(rgba, minArea=2, gradients=[gradient])
        gradient["color"] = "#abcdef"
        with self.assertRaisesRegex(ValueError, "was not found"):
            self.run_image(rgba, gradients=[gradient])

    def test_continuous_alpha_warning_and_empty_transparency(self):
        rgba = np.zeros((64, 64, 4), np.uint8)
        rgba[10:30, 10:30] = [18, 52, 86, 64]
        result, _, _ = self.run_image(rgba)
        self.assertEqual((result["paths"], result["palette"]), (0, []))
        self.assertTrue(any("Continuous alpha" in warning for warning in result["warnings"]))
        self.assertTrue(any("SVG is empty" in warning for warning in result["warnings"]))
        result, _, _ = self.run_image(rgba, "visible", alphaThreshold=32)
        self.assertEqual(result["paths"], 1)

    def test_palette_is_deterministic_and_requested_color_count_is_bounded(self):
        y, x = np.indices((64, 64))
        rgba = np.stack([(x*4).astype(np.uint8), (y*4).astype(np.uint8), ((x+y)*2).astype(np.uint8), np.full((64, 64), 255, np.uint8)], axis=2)
        first, x1, _ = self.run_image(rgba, "p1", colors=4, minArea=5)
        second, x2, _ = self.run_image(rgba, "p2", colors=4, minArea=5)
        self.assertEqual(first["palette"], second["palette"])
        self.assertLessEqual(len(first["palette"]), 4)
        self.assertEqual(first["stats"], second["stats"])

    def test_source_header_limits_precede_pixel_decode(self):
        class Source:
            def __init__(self, size):
                self.size = size
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def convert(self, *args):
                raise AssertionError("Source pixels decoded before limit check")
        for size in ((16385, 1), (8000, 8000)):
            with patch("vector_trace.Image.open", return_value=Source(size)):
                with self.assertRaisesRegex(ValueError, "40 megapixels"):
                    trace_image({"in": "header.png", "out": str(self.root/"limit.svg")})

    def test_corrupt_source_is_a_readable_validation_error_without_an_export(self):
        source=self.root/'corrupt.png'; source.write_bytes(b'not a decoded image')
        out=self.root/'corrupt.svg'
        with self.assertRaisesRegex(ValueError,'could not be decoded'):
            trace_image({'in':str(source),'out':str(out)})
        self.assertFalse(out.exists())

    def test_failed_atomic_write_preserves_existing_export_and_removes_temp(self):
        rgba = np.zeros((64, 64, 4), np.uint8)
        rgba[10:30, 10:30] = [18, 52, 86, 255]
        source, out = self.root/"source.png", self.root/"existing.svg"
        Image.fromarray(rgba, "RGBA").save(source)
        out.write_text("existing export", encoding="utf-8")
        with patch("vector_trace.os.replace", side_effect=OSError("test rename failure")):
            with self.assertRaisesRegex(OSError, "test rename failure"):
                trace_image({"in": str(source), "out": str(out)})
        self.assertEqual(out.read_text(encoding="utf-8"), "existing export")
        self.assertFalse(list(self.root.glob(".*.vector-*.tmp")))

    def test_total_complexity_and_svg_bytes_fail_before_replacing_output(self):
        rgba = np.zeros((64, 64, 4), np.uint8)
        rgba[10:30, 10:30] = [18, 52, 86, 255]
        for constant, value, message in (("MAX_POINTS", 4, "boundary-point"), ("MAX_SVG_BYTES", 20, "byte limit")):
            with patch("vector_trace."+constant, value):
                with self.assertRaisesRegex(TraceLimitError, message):
                    self.run_image(rgba, "bounded")
                self.assertFalse((self.root/"bounded.svg").exists())

    def test_invalid_option_values_are_refused(self):
        for options in ({"colors": 1}, {"detail": 0}, {"tolerance": float("nan")},
                        {"maxSize": 4097}, {"alphaThreshold": 0}, {"minArea": -1},
                        {"quality": "ultra"}, {"mode": "guess"}, {"colors": True},
                        {"gradients": [{"color": "red", "stops": []}]}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                settings_for(options)
        with self.assertRaisesRegex(ValueError, "2 to 8 stops"):
            settings_for({"gradients": [{"color": "#123456", "stops": [{"offset": i/8, "color": "#000000"} for i in range(9)]}]})
        self.assertEqual(settings_for({"quality": "draft"})["maxSize"], 1024)
        self.assertEqual(settings_for({"quality": "high"})["tolerance"], .5)


if __name__ == "__main__":
    unittest.main()
