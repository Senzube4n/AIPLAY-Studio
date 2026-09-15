"""CPU-only synthetic WAV fixtures; no models, GPU, user media, or app settings."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vfx import engine  # noqa: E402


class AudioPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vfx-audio-preview-python-")
        self.addCleanup(self.temp.cleanup)
        self.source = os.path.join(self.temp.name, "tone.wav")
        samples = np.round(np.sin(np.arange(24000) * 0.061) * 12000).astype("<i2")
        with wave.open(self.source, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            wav.writeframes(samples.tobytes())
        self.comp = {"slug": "fixture", "duration": 1.0, "layers": [
            {"id": "tone", "type": "audio", "src": self.source,
             "start": 0.1, "end": 0.7, "inPoint": 0.05, "audioLevels": -3.0}]}

    def job(self, comp=None, **extra):
        return {"comp": comp or self.comp, "from": 0.0, "to": 0.8,
                "out": os.path.join(self.temp.name, "preview.wav"), **extra}

    def exact(self, job):
        original = engine.render_audio(job["comp"], job["from"], job["to"])
        result = engine.cmd_audio_preview(job)
        self.assertTrue(result["hasAudio"])
        with wave.open(job["out"], "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (2, 2, 48000))
            self.assertEqual(wav.getnframes(), result["frames"])
            got = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").reshape(-1, 2)
        want = np.clip(np.round(original.T * 32768.0), -32768, 32767).astype("<i2")
        np.testing.assert_array_equal(got, want)
        return got

    def test_offset_trim_gain_and_silence_are_sample_exact(self):
        got = self.exact(self.job())
        self.assertTrue(np.all(got[:4800] == 0))
        self.assertTrue(np.any(got[5000:10000] != 0))
        self.assertTrue(np.all(got[-4000:] == 0))

    def test_nested_and_reverse_retimed_mix_matches_movie_audio(self):
        child = dict(self.comp, slug="child")
        parent = {"slug": "parent", "duration": 1.0, "comps": {"child": child}, "layers": [
            {"id": "nested", "type": "comp", "src": "child", "start": 0.0,
             "end": 0.8, "inPoint": 0.75, "timeScale": -1.25, "audioLevels": -2.0}]}
        self.exact(self.job(parent))

    def test_output_work_area_starts_at_correct_composition_time(self):
        self.exact(self.job(**{"from": 0.25, "to": 0.45}))

    def test_disabled_audio_and_empty_interval_have_no_fake_wav(self):
        self.comp["layers"][0]["audio"] = False
        job = self.job()
        result = engine.cmd_audio_preview(job)
        self.assertEqual(result, {"ok": True, "hasAudio": False, "rate": 48000, "frames": 0})
        self.assertFalse(os.path.exists(job["out"]))
        self.comp["layers"][0]["audio"] = True
        result = engine.cmd_audio_preview(self.job(**{"from": 0.8, "to": 1.0}))
        self.assertFalse(result["hasAudio"])

    def test_time_remap_audio_refusal_matches_export(self):
        self.comp["layers"][0]["timeRemap"] = {"expr": "time"}
        with self.assertRaisesRegex(ValueError, "time-remapped"):
            engine.cmd_audio_preview(self.job())
        self.assertFalse(os.path.exists(self.job()["out"]))

    def test_invalid_and_long_work_areas_refuse_before_allocation(self):
        for extra in [{"from": -1}, {"to": 121}, {"to": 1.1}, {"from": True},
                      {"to": float("inf")}, {"to": 0}, {"out": "not-a-wav.mp4"}]:
            with self.assertRaises(ValueError):
                engine.cmd_audio_preview(self.job(**extra))

    def test_decode_and_recursive_mix_budgets_bound_actual_sample_counts(self):
        budget = engine._AudioPreviewBudget(10)
        budget.decode(3000, 3000)
        with self.assertRaisesRegex(ValueError, "decode limit"):
            budget.decode(1, 3001)
        budget = engine._AudioPreviewBudget(10)
        budget.decode(3000, 3000)
        budget.decode(3000, 3000)
        with self.assertRaisesRegex(ValueError, "decode limit"):
            budget.decode(1, 1)
        budget = engine._AudioPreviewBudget(10)
        budget.mix(4800)
        with self.assertRaisesRegex(ValueError, "mix limit"):
            budget.mix(1)

    def test_exclusive_output_preserves_existing_file(self):
        job = self.job()
        with open(job["out"], "wb") as fh:
            fh.write(b"existing-owned-fixture")
        with self.assertRaises(FileExistsError):
            engine.cmd_audio_preview(job)
        with open(job["out"], "rb") as fh:
            self.assertEqual(fh.read(), b"existing-owned-fixture")

    def test_cli_dispatch_returns_real_audio_receipt(self):
        job = self.job()
        job_path = os.path.join(self.temp.name, "job.json")
        with open(job_path, "w", encoding="utf-8") as fh:
            json.dump(job, fh)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(engine.main(["audio-preview", job_path]), 0)
        receipt = json.loads(output.getvalue())
        self.assertTrue(receipt["hasAudio"])
        self.assertEqual(receipt["frames"], 38400)
        self.assertEqual(receipt["rate"], 48000)


if __name__ == "__main__":
    unittest.main(verbosity=2)
