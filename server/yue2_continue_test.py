"""Exercise the real YuE2 node control flow with fake model/CLIP objects.

Only semantic .npy fixtures touch disk. No ComfyUI, model loading or GPU work.
"""
import ast
import math
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np

source = Path(__file__).with_name("comfy_nodes") / "aiplay_yue2_continue.py"
tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
body = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.Assign))]
namespace = {
    "os": os, "math": math, "np": np,
    "torch": SimpleNamespace(bfloat16="bf16", float32="fp32"),
    "comfy": SimpleNamespace(model_management=SimpleNamespace(should_use_bf16=lambda _: False)),
    "_yue2": SimpleNamespace(ABC_START=151847, ABC_END=151848, MUSIC_START=151851),
}
exec(compile(ast.Module(body=body, type_ignores=[]), str(source), "exec"), namespace)
Node = namespace["AiplayYuE2Continue"]
OFFSET = namespace["CODEC_OFFSET"]


class FakeModel:
    def __init__(self):
        self.execution_device = "cpu"
        self.config = SimpleNamespace(max_position_embeddings=24576)
        self.encode_token_weights = lambda _: "original"
        self.generated = []
        self.acoustic = []

    def _generate(self, *args, **kwargs):
        self.generated.append((args, kwargs))
        return [OFFSET + 900, OFFSET + 901], False

    def _acoustic_conditioning(self, prefix, codes, dtype):
        self.acoustic.append((prefix, codes, dtype))
        return "conditioning tensor", ((0, len(codes), 0, len(prefix) + len(codes) + 1),)


class FakeClip:
    def __init__(self):
        self.cond_stage_model = FakeModel()
        self.tokenized = []

    def tokenize(self, style, **kwargs):
        self.tokenized.append(kwargs)
        return {"prefix": [10], "negative": [11], "abc_ids": [], "cfg_scale": 1.01, **kwargs}

    def encode_from_tokens_scheduled(self, tokens):
        self.last_tokens = tokens
        encoded, _, metadata = self.cond_stage_model.encode_token_weights(tokens)
        return [[encoded, metadata]]


class SourceConditioningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.codes = Path(self.tmp.name) / "semantic.npy"
        self.clip = FakeClip()

    def tearDown(self):
        self.tmp.cleanup()

    def save(self, frames):
        values = np.arange(frames, dtype=np.int32)
        np.save(self.codes, values, allow_pickle=False)
        return values.tolist()

    def run_node(self, seconds=24, **overrides):
        args = dict(clip=self.clip, style="", lyrics="", codes_dir=self.tmp.name,
                    prime_seconds=0, seed=8, new_duration=0, encode_only=True,
                    source_audio={"waveform": SimpleNamespace(shape=(1, 2, round(seconds * 44100))), "sample_rate": 44100})
        args.update(overrides)
        return Node().generate(**args)

    def test_all_recorded_codes_reach_acoustic_conditioning_without_generation(self):
        values = self.save(600)
        original = self.clip.cond_stage_model.encode_token_weights
        result, seconds = self.run_node()
        model = self.clip.cond_stage_model
        self.assertEqual(model.generated, [])
        self.assertEqual(model.acoustic[0][1], [OFFSET + value for value in values])
        self.assertEqual(seconds, 24)
        self.assertEqual(result[0][1]["aiplay_source_seconds"], 24)
        self.assertTrue(result[0][1]["aiplay_encode_only"])
        self.assertFalse(result[0][1]["yue2_truncated"])
        self.assertIs(model.encode_token_weights, original)
        self.assertEqual(self.clip.last_tokens["max_tokens"], 600)
        self.assertEqual(self.clip.last_tokens["cfg_scale"], 1)

    def test_longest_training_slice_does_not_use_120_second_replay_limit(self):
        self.save(4500)
        self.assertEqual(self.run_node(seconds=180)[1], 180)
        self.assertEqual(len(self.clip.cond_stage_model.acoustic[0][1]), 4500)

    def test_actual_audio_length_controls_the_frame_check(self):
        self.save(300)
        self.assertEqual(self.run_node(seconds=12)[1], 12)

    def test_mismatched_tail_is_refused_before_clip_loading(self):
        self.save(550)
        with self.assertRaisesRegex(ValueError, "Retokenize"):
            self.run_node(seconds=24)
        self.assertEqual(self.clip.tokenized, [])

    def test_actual_duration_outside_training_limits_is_refused(self):
        for seconds in (7, 181):
            self.save(seconds * 25)
            with self.subTest(seconds=seconds), self.assertRaisesRegex(ValueError, "actual audio"):
                self.run_node(seconds=seconds)

    def test_empty_codes_are_refused(self):
        self.save(0)
        with self.assertRaisesRegex(ValueError, "no semantic codes"):
            self.run_node()

    def test_encode_only_cannot_silently_slice_or_generate(self):
        self.save(600)
        for overrides in ({"prime_seconds": 22}, {"new_duration": 2}):
            with self.subTest(overrides=overrides), self.assertRaisesRegex(ValueError, "encode_only requires"):
                self.run_node(**overrides)

    def test_encode_only_requires_actual_source_audio(self):
        self.save(600)
        with self.assertRaisesRegex(ValueError, "source_audio"):
            self.run_node(source_audio=None)

    def test_continuation_keeps_replay_plus_generated_music(self):
        values = self.save(600)
        result, seconds = self.run_node(encode_only=False, source_audio=None, prime_seconds=8, new_duration=2)
        model = self.clip.cond_stage_model
        self.assertEqual(len(model.generated), 1)
        self.assertEqual(model.acoustic[0][1], [OFFSET + value for value in values[:200]] + [OFFSET + 900, OFFSET + 901])
        self.assertEqual(seconds, 202 / 25)
        self.assertEqual(result[0][1]["aiplay_replay_frames"], 200)

    def test_zero_duration_is_not_accepted_as_a_continuation(self):
        self.save(600)
        with self.assertRaisesRegex(ValueError, "Continuation new_duration"):
            self.run_node(encode_only=False)

    def test_model_hook_is_restored_after_acoustic_error(self):
        self.save(600)
        model = self.clip.cond_stage_model
        original = model.encode_token_weights
        def fail(*_):
            raise RuntimeError("acoustic failure")
        model._acoustic_conditioning = fail
        with self.assertRaisesRegex(RuntimeError, "acoustic failure"):
            self.run_node()
        self.assertIs(model.encode_token_weights, original)


if __name__ == "__main__":
    unittest.main()
