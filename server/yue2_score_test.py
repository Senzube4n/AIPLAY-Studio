"""The real capture output node, no ComfyUI imports or model work."""
import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).with_name("comfy_nodes") / "aiplay_yue2_score.py"
spec = importlib.util.spec_from_file_location("aiplay_yue2_score", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ScoreCaptureTests(unittest.TestCase):
    def test_exact_text_and_prompt_binding(self):
        abc = "X:1\nT:leave spaces  \nK:C\nC4  |\n"
        result = module.AiplayYuE2Score().capture(abc, 19.125, "job-id")
        self.assertEqual(result, {"ui": {"aiplay_yue2_score": [{
            "abc": abc, "capture_key": "job-id", "audio_seconds": 19.125,
        }]}, "result": ()})
        self.assertTrue(module.AiplayYuE2Score.OUTPUT_NODE)

    def test_missing_score_never_breaks_audio(self):
        for abc in [None, "  \n", "🎵" * 17000]:
            self.assertEqual(module.AiplayYuE2Score().capture(abc, 1, "id"),
                             {"ui": {"aiplay_yue2_score": []}, "result": ()})

    def test_unmeasured_duration_is_null(self):
        for value in [float("nan"), float("inf"), -1, 0, None, "bad", {}, []]:
            result = module.AiplayYuE2Score().capture("K:C\nC4|", value, "id")
            self.assertIsNone(result["ui"]["aiplay_yue2_score"][0]["audio_seconds"])


if __name__ == "__main__":
    unittest.main()
