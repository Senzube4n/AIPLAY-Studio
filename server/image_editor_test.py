"""Real CPU pixels and shelf I/O; no model or GPU required."""
import os
import multiprocessing
import queue
import contextlib
import io
import tempfile
import time
import unittest

import numpy as np
from PIL import Image
import imgdoc
import imagetools
import image_editor as editor


def concurrent_accept(payload, gate, replies):
    original = imgdoc.store_job
    delayed = False
    def slow_open(job):
        nonlocal delayed
        result = original(job)
        if job.get("action") == "open" and not delayed:
            delayed = True
            time.sleep(.3)  # makes the check-then-write race reproducible without a lock
        return result
    imgdoc.store_job = slow_open
    replies.put("ready")
    gate.wait(10)
    try:
        editor.accept(payload)
        replies.put("accepted")
    except ValueError as error:
        replies.put(str(error))


def ordinary_edit(payload, replies):
    replies.put("ready")
    imgdoc.edit_job(payload)
    replies.put("edited")


class EditorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = self.temp.name
        self.original = np.zeros((24, 40, 4), dtype=np.uint8)
        self.original[:] = [19, 73, 123, 128]
        self.original[:, :5] = [222, 11, 99, 0]  # hidden RGB must survive
        Image.fromarray(self.original, "RGBA").save(self.file("source.png"))
        self.base = {"dir": self.directory, "source": "source.png", "mode": "inpaint",
            "out": self.file("frozen.png"), "maskOut": self.file("mask.npy"),
            "maskImageOut": self.file("mask.png"),
            "selection": {"shapes": [{"kind": "rect", "x": 10, "y": 6, "w": 12, "h": 10}], "antialias": False}}

    def tearDown(self):
        self.temp.cleanup()

    def file(self, name):
        return os.path.join(self.directory, name)

    def finish(self):
        Image.new("RGBA", (32, 32), (240, 30, 10, 255)).save(self.file("generated.png"))
        return editor.finish({"dir": self.directory, "sourcePath": self.file("frozen.png"),
            "generated": "generated.png", "maskPath": self.file("mask.npy"),
            "out": self.file("candidate.png"), "thumbOut": self.file("candidate_t.png")})

    def test_masked_edit_preserves_unselected_rgba_byte_for_byte(self):
        ready = editor.prepare(self.base)
        self.assertGreater(ready["coverage"], 0)
        finished = self.finish()
        self.assertTrue(finished["resizedToSource"])
        self.assertEqual((finished["width"], finished["height"]), (40, 24))
        mask = np.load(self.file("mask.npy"))
        got = np.asarray(Image.open(self.file("candidate.png")))
        np.testing.assert_array_equal(got[mask == 0], self.original[mask == 0])
        np.testing.assert_array_equal(got[mask == 1], np.tile([240, 30, 10, 255], (np.sum(mask == 1), 1)))
        hints = np.asarray(Image.open(self.file("mask.png")))
        self.assertTrue(np.all(hints[mask == 1] == 255))
        self.assertTrue(np.all(hints[mask == 0] == 0))

    def test_soft_selection_blends_straight_alpha_without_dark_fringe(self):
        editor.prepare(self.base)
        mask = np.zeros((24, 40), np.float32)
        mask[0, 0] = .5
        np.save(self.file("mask.npy"), mask)
        self.finish()
        got = np.asarray(Image.open(self.file("candidate.png")))
        self.assertEqual(list(got[0, 0]), [240, 30, 10, 128])
        np.testing.assert_array_equal(got[0, 1], self.original[0, 1])

    def test_empty_and_unknown_selections_refused(self):
        for selection in ({"shapes": []}, {"shapes": [{"kind": "not-a-tool"}]}):
            with self.assertRaises(ValueError):
                editor.prepare({**self.base, "selection": selection})

    def test_reference_paths_cannot_escape_library(self):
        for name in ("../source.png", "..\\source.png", self.file("source.png")):
            with self.assertRaises(ValueError):
                editor.prepare({**self.base, "source": name})

    def saved_doc(self):
        saved = imgdoc.store_job({"dir": self.directory, "action": "save", "doc": {
            "name": "Layer test", "width": 40, "height": 24,
            "layers": [{"id": "original", "type": "image", "src": "source.png"}]}})
        return saved["id"]

    def test_accept_matches_candidate_exactly_and_undo_restores_layers(self):
        did = self.saved_doc()
        prepared = editor.prepare({**self.base, "documentId": did})
        self.finish()
        accepted = editor.accept({"dir": self.directory, "documentId": did,
            "revision": prepared["revision"], "candidate": "candidate.png", "layerId": "generated",
            "layerName": "Qwen edit"})
        self.assertEqual(len(accepted["doc"]["layers"]), 2)
        self.assertFalse(accepted["doc"]["layers"][0]["enabled"])
        rendered, _ = editor.render_doc(accepted["doc"], self.directory)
        # The hidden old stack must not double the candidate's partial alpha.
        np.testing.assert_array_equal(np.asarray(rendered), np.asarray(Image.open(self.file("candidate.png"))))
        undone = editor.undo({"dir": self.directory, "documentId": did,
            "revision": accepted["revision"], "before": accepted["before"]})
        self.assertEqual(len(undone["doc"]["layers"]), 1)
        self.assertTrue(undone["doc"]["layers"][0]["enabled"])

    def test_stale_accept_and_stale_undo_do_not_clobber_other_edits(self):
        did = self.saved_doc()
        prepared = editor.prepare({**self.base, "documentId": did})
        imgdoc.edit_job({"dir": self.directory, "id": did,
            "ops": [{"op": "update_layer", "ref": "original", "patch": {"name": "New name"}}]})
        with self.assertRaisesRegex(ValueError, "changed"):
            editor.accept({"dir": self.directory, "documentId": did, "revision": prepared["revision"]})
        with self.assertRaisesRegex(ValueError, "newer edits"):
            editor.undo({"dir": self.directory, "documentId": did, "revision": prepared["revision"], "before": prepared["document"]})

    def test_transparent_candidate_replaces_background_and_undo_restores_it(self):
        saved = imgdoc.store_job({"dir": self.directory, "action": "save", "doc": {
            "name": "Opaque background", "width": 40, "height": 24, "bg": [20, 40, 80, 255], "layers": []}})
        before = editor.open_doc({"dir": self.directory, "documentId": saved["id"]})
        Image.new("RGBA", (40, 24), (80, 30, 10, 128)).save(self.file("candidate.png"))
        accepted = editor.accept({"dir": self.directory, "documentId": saved["id"],
            "revision": editor.revision(before), "candidate": "candidate.png", "layerId": "result", "layerName": "Transparent edit"})
        persisted = editor.open_doc({"dir": self.directory, "documentId": saved["id"]})
        background = persisted["layers"][0]
        self.assertEqual(background["type"], "solid")
        self.assertEqual(background["color"], [20, 40, 80, 255])
        self.assertEqual(background["size"], [40, 24])
        self.assertFalse(background["enabled"])
        rendered, _ = editor.render_doc(persisted, self.directory)
        self.assertEqual(rendered.getpixel((10, 10)), (80, 30, 10, 128))
        # Simulate recovery after restart using only the saved layer tree.
        persisted["layers"][-1]["enabled"] = False
        background["enabled"] = True
        recovered, _ = editor.render_doc(persisted, self.directory)
        self.assertEqual(recovered.getpixel((10, 10)), (20, 40, 80, 255))
        restored = editor.undo({"dir": self.directory, "documentId": saved["id"],
            "revision": accepted["revision"], "before": accepted["before"]})
        self.assertEqual(restored["doc"]["bg"], [20, 40, 80, 255])
        self.assertEqual(restored["doc"]["layers"], [])

    def test_saved_partial_background_recovers_beneath_original_layers_without_undo_state(self):
        saved = imgdoc.store_job({"dir": self.directory, "action": "save", "doc": {
            "name": "Partial background", "width": 40, "height": 24, "bg": [40, 80, 120, 100],
            "layers": [{"id": "original", "type": "image", "src": "source.png"}]}})
        before = editor.open_doc({"dir": self.directory, "documentId": saved["id"]})
        original, _ = editor.render_doc(before, self.directory)
        Image.new("RGBA", (40, 24), (80, 30, 10, 60)).save(self.file("candidate.png"))
        editor.accept({"dir": self.directory, "documentId": saved["id"],
            "revision": editor.revision(before), "candidate": "candidate.png", "layerId": "result", "layerName": "Edit"})
        persisted = editor.open_doc({"dir": self.directory, "documentId": saved["id"]})
        candidate, _ = editor.render_doc(persisted, self.directory)
        np.testing.assert_array_equal(np.asarray(candidate), np.asarray(Image.open(self.file("candidate.png"))))
        for layer in persisted["layers"]:
            layer["enabled"] = layer["id"] != "result"
        recovered, _ = editor.render_doc(persisted, self.directory)
        np.testing.assert_array_equal(np.asarray(recovered), np.asarray(original))

    def test_preview_is_live_pixels_and_does_not_create_library_files(self):
        did = self.saved_doc()
        before = set(os.listdir(self.directory))
        first = editor.preview({"dir": self.directory, "documentId": did})
        imgdoc.edit_job({"dir": self.directory, "id": did,
            "ops": [{"op": "update_layer", "ref": "original", "patch": {"enabled": False}}]})
        second = editor.preview({"dir": self.directory, "documentId": did})
        self.assertNotEqual(first["dataUrl"], second["dataUrl"])
        self.assertNotEqual(first["revision"], second["revision"])
        self.assertEqual(before, set(os.listdir(self.directory)))

    def test_concurrent_processes_accept_only_one_result_for_a_revision(self):
        did = self.saved_doc()
        prepared = editor.prepare({**self.base, "documentId": did})
        self.finish()
        ctx = multiprocessing.get_context("spawn")
        gate, replies = ctx.Event(), ctx.Queue()
        payload = {"dir": self.directory, "documentId": did, "revision": prepared["revision"],
                   "candidate": "candidate.png", "layerId": "generated", "layerName": "Result"}
        processes = [ctx.Process(target=concurrent_accept, args=(payload, gate, replies)) for _ in range(2)]
        for process in processes:
            process.start()
        self.assertEqual([replies.get(timeout=10), replies.get(timeout=10)], ["ready", "ready"])
        gate.set()
        results = [replies.get(timeout=10), replies.get(timeout=10)]
        for process in processes:
            process.join(10)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(results.count("accepted"), 1)
        self.assertTrue(any("document changed" in result for result in results))

    def test_existing_document_edit_obeys_the_same_cross_process_shelf_lock(self):
        did = self.saved_doc()
        ctx = multiprocessing.get_context("spawn")
        replies = ctx.Queue()
        process = ctx.Process(target=ordinary_edit, args=({"dir": self.directory, "id": did,
            "ops": [{"op": "update_layer", "ref": "original", "patch": {"name": "Concurrent edit"}}]}, replies))
        with imgdoc.shelf_lock({"dir": self.directory}):
            process.start()
            self.assertEqual(replies.get(timeout=10), "ready")
            with self.assertRaises(queue.Empty):
                replies.get(timeout=.15)
        self.assertEqual(replies.get(timeout=10), "edited")
        process.join(10)
        self.assertEqual(process.exitcode, 0)

    def test_paint_guard_accepts_full_canvas_and_refuses_transforms_or_smaller_sources(self):
        did = self.saved_doc()
        doc = editor.open_doc({"dir": self.directory, "documentId": did})
        self.assertTrue(editor.paint_target({"dir": self.directory, "doc": doc, "ref": "original"})["ready"])
        for transform in ({"position": [21, 12]}, {"rotation": 90}, {"scale": [50, 100]}, {"anchor": [0, 0]}):
            doc["layers"][0]["transform"] = transform
            with self.assertRaisesRegex(ValueError, "transformed"):
                editor.paint_target({"dir": self.directory, "doc": doc, "ref": "original"})
        doc["layers"][0]["transform"] = {"position": [20, 12], "anchor": [20, 12], "scale": [100, 100]}
        self.assertTrue(editor.paint_target({"dir": self.directory, "doc": doc, "ref": "original"})["ready"])
        Image.new("RGBA", (20, 12), "red").save(self.file("small.png"))
        doc["layers"][0]["src"] = "small.png"
        with self.assertRaisesRegex(ValueError, "full canvas size"):
            editor.paint_target({"dir": self.directory, "doc": doc, "ref": "original"})

    def test_paint_guard_checks_every_parent_group_and_displacing_effects(self):
        doc = imgdoc.normalize({"width": 40, "height": 24, "layers": [
            {"id": "group", "type": "group", "layers": [
                {"id": "nested", "type": "group", "layers": [
                    {"id": "qwen", "type": "image", "src": "source.png"}]}]}]})
        payload = {"dir": self.directory, "doc": doc, "ref": "qwen"}
        self.assertTrue(editor.paint_target(payload)["ready"])
        for patch, expected in (({"transform": {"rotation": 20}}, "transformed"),
            ({"locked": True}, "locked"), ({"enabled": False}, "hidden"),
            ({"effects": [{"type": "wave", "enabled": True}]}, "effects")):
            parent = doc["layers"][0]
            previous = {key: parent.get(key) for key in patch}
            parent.update(patch)
            with self.assertRaisesRegex(ValueError, expected):
                editor.paint_target(payload)
            for key, value in previous.items():
                if value is None:
                    parent.pop(key, None)
                else:
                    parent[key] = value
        doc["layers"][0]["layers"][0]["transform"] = {"position": [23, 12]}
        with self.assertRaisesRegex(ValueError, "transformed"):
            editor.paint_target(payload)

    def test_full_canvas_paint_hits_correct_pixels_and_commit_refuses_a_concurrent_move(self):
        did = self.saved_doc()
        doc = editor.open_doc({"dir": self.directory, "documentId": did})
        editor.paint_target({"dir": self.directory, "doc": doc, "ref": "original"})
        with contextlib.redirect_stdout(io.StringIO()):
            imagetools.apply_edit({"in": self.file("source.png"), "out": self.file("painted.png"),
                "ops": {"clear": True, "selection": self.base["selection"]}})
        updated = imgdoc.edit_job({"dir": self.directory, "id": did, "doc": True,
            "expectedUpdatedAt": doc["updatedAt"],
            "ops": [{"op": "update_layer", "ref": "original", "patch": {"src": "painted.png"}}]})
        image, _ = editor.render_doc(updated["doc"], self.directory)
        self.assertEqual(image.getpixel((15, 10))[3], 0)
        self.assertEqual(image.getpixel((9, 1)), (19, 73, 123, 128))
        stale = updated["doc"]["updatedAt"]
        imgdoc.edit_job({"dir": self.directory, "id": did,
            "ops": [{"op": "update_layer", "ref": "original", "patch": {"transform": {"position": [25, 12]}}}]})
        with self.assertRaisesRegex(ValueError, "document changed"):
            imgdoc.edit_job({"dir": self.directory, "id": did, "expectedUpdatedAt": stale,
                "ops": [{"op": "update_layer", "ref": "original", "patch": {"src": "source.png"}}]})
        latest = editor.open_doc({"dir": self.directory, "documentId": did})
        self.assertEqual(latest["layers"][0]["src"], "painted.png")


if __name__ == "__main__":
    unittest.main()
