"""CPU-only stage proof using the installed runtime's actual artifact classes.
The pipeline model class and torch are never imported or instantiated."""
import ast
import dataclasses
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
import numpy as np

import yue_replay as replay

PACKAGE = Path(importlib.metadata.distribution("yue2-infer").locate_file("yue2"))


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


protocol = load_module("fixture_protocol", PACKAGE / "protocol.py")
storage = load_module("fixture_storage", PACKAGE / "storage.py")
# Execute ONLY native dataclasses, excluding the pipeline (and its torch import).
tree = ast.parse((PACKAGE / "pipeline.py").read_text(encoding="utf-8"))
classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name in {"SymbolicPlan", "SemanticResult", "SongResult"}]
native = types.ModuleType("yue2.pipeline")
native.__dict__.update({"dataclass": dataclasses.dataclass, "field": dataclasses.field, "Path": Path, "np": np,
                        "json": json, "SongRequest": protocol.SongRequest, "write_json": storage.write_json,
                        "sha256_file": storage.sha256_file, "collect_hashes": storage.collect_hashes})
sys.modules["yue2"] = types.ModuleType("yue2")
sys.modules["yue2.pipeline"] = native
sys.modules["yue2.protocol"] = protocol
sys.modules["yue2.storage"] = storage
exec(compile(ast.Module(body=classes, type_ignores=[]), str(PACKAGE / "pipeline.py"), "exec"), native.__dict__)


class Pipe:
    def __init__(self, weights):
        self.weights = weights
        self.runtime_sha256 = replay.RUNTIME_SHA256
        self.load_timing = {"resolve_and_integrity_seconds": 0.0}
        self.generation_config = protocol.GenerationConfig()
        self.calls = []
    def effective_config(self, request):
        return {"generation": self.generation_config.to_dict(), "runtime_sha256": self.runtime_sha256}
    def generate_semantic(self, plan, **kw):
        self.calls.append("semantic")
        return native.SemanticResult(plan, [1, 2, 3], {"seconds": 0.01}, False)
    def synthesize(self, semantic, **kw):
        self.calls.append("synthesis")
        return np.ones((len(semantic.tokens), 64), dtype=np.float32)
    def decode(self, latent):
        self.calls.append("decode")
        return np.zeros((len(latent) * 1920, 2), dtype=np.float32)


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aiplay-stage-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        request = protocol.SongRequest("folk", "words", seed=77)
        plan = native.SymbolicPlan(request, None, [], [1, 2, 3], {"seconds": 8.0}, False)
        semantic = native.SemanticResult(plan, [1, 2, 3], {"seconds": 10.0}, False)
        self.weights = {"mot": {"files": {"model.safetensors": {"bytes": 3, "sha256": "a" * 64}}, "config_sha256": "b" * 64},
                        "vae": {"files": {"model.safetensors": {"bytes": 3, "sha256": "c" * 64}}, "config_sha256": "d" * 64}}
        self.config = {"generation": protocol.GenerationConfig().to_dict(), "runtime_sha256": replay.RUNTIME_SHA256}
        latents = np.arange(192, dtype=np.float32).reshape(3, 64) / 192
        result = native.SongResult(np.zeros((5760, 2), dtype=np.float32), 48000, semantic, latents, self.config, self.weights, {}, "e" * 64)
        receipt = result.save_artifacts(self.source)
        files = {**receipt["artifacts"], "result.json": {"bytes": (self.source / "result.json").stat().st_size, "sha256": replay.file_hash(self.source / "result.json")}}
        self.saved = {"identity": receipt["identity"], "files": files, "request": request.to_dict(), "config": self.config,
                      "weights": self.weights, "truncated": receipt["truncated"],
                      "runtime": {"package": "yue2-infer", "version": replay.VERSION, "sha256": replay.RUNTIME_SHA256}}
    def prepared(self, stage, **options):
        manifest = {"v": 1, "stage": stage, "sourceDir": str(self.source), "source": self.saved,
                    "options": {"seed": 77, "narSteps": 32, "vaeCoreFrames": 512, **options}}
        file = self.root / "manifest.json"
        file.write_text(json.dumps(manifest), encoding="utf-8")
        return replay.validate_manifest(file, replay.file_hash(file), self.source, stage)
    def test_pinned_runtime_and_real_native_artifacts_validate_without_torch(self):
        manifest, tokens, latents = self.prepared("latent")
        self.assertEqual(tokens.tolist(), [1, 2, 3])
        self.assertEqual(latents.shape, (3, 64))
        self.assertNotIn("torch", sys.modules)
    def test_each_stage_runs_only_its_downstream_stages(self):
        for stage in replay.STAGES:
            with self.subTest(stage=stage):
                prepared = self.prepared(stage)
                pipe = Pipe(self.weights)
                result, receipt = replay.replay(pipe, prepared, self.saved["request"])
                self.assertEqual(pipe.calls, replay.STAGES[stage])
                self.assertEqual(receipt["stagesRun"], replay.STAGES[stage])
                self.assertTrue(result.config["artifact_replay"])
                if stage == "latent": self.assertEqual(result.timing["nar_seconds"], 0)
    def test_latent_replay_retains_exact_latent_and_token_file_hashes(self):
        pipe = Pipe(self.weights)
        result, _ = replay.replay(pipe, self.prepared("latent"), self.saved["request"])
        output = self.root / "decoded"
        receipt = result.save_artifacts(output)
        for name in ["latent.npy", "semantic.npy", "prefix.npy", "abc_tokens.npy"]:
            self.assertEqual(receipt["artifacts"][name]["sha256"], self.saved["files"][name]["sha256"])
        self.assertNotEqual(receipt["identity"], self.saved["identity"])
        self.assertEqual(receipt["timing"]["stages_run"], ["decode"])
    def test_semantic_seed_changes_preserve_exact_prefix_and_tokens(self):
        result, _ = replay.replay(Pipe(self.weights), self.prepared("semantic", seed=99), {**self.saved["request"], "seed": 99, "id": "new"})
        self.assertEqual(result.semantic.plan.request.seed, 99)
        self.assertEqual(result.semantic.tokens, [1, 2, 3])
        self.assertEqual(result.semantic.plan.prefix, [1, 2, 3])
    def test_model_and_prompt_mismatch_fail_before_any_stage(self):
        prepared = self.prepared("latent")
        pipe = Pipe({"wrong": True})
        with self.assertRaisesRegex(ValueError, "identities"):
            replay.replay(pipe, prepared, self.saved["request"])
        self.assertEqual(pipe.calls, [])
        pipe = Pipe(self.weights)
        with self.assertRaisesRegex(ValueError, "frozen lyrics"):
            replay.replay(pipe, prepared, {**self.saved["request"], "lyrics": "changed"})
        self.assertEqual(pipe.calls, [])
    def test_cancellation_before_and_between_stages_never_publishes_audio(self):
        for when in [0, 1, 2]:
            pipe = Pipe(self.weights)
            with self.assertRaises(InterruptedError):
                replay.replay(pipe, self.prepared("plan"), self.saved["request"], cancelled=lambda: len(pipe.calls) >= when)
            self.assertNotIn("decode", pipe.calls)
    def test_file_tamper_fails_before_pipeline_construction(self):
        self.prepared("latent")
        file = self.root / "manifest.json"
        (self.source / "semantic.npy").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "changed before execution"):
            replay.validate_manifest(file, replay.file_hash(file), self.source, "latent")


if __name__ == "__main__": unittest.main()
