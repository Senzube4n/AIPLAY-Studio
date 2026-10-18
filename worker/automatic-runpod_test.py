"""Offline startup validation; no processes, network access or paid resources."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("automatic_runpod", Path(__file__).with_name("automatic-runpod.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class StartupTests(unittest.TestCase):
    def test_engine_receives_music_nodes_without_touching_models_or_other_nodes(self):
        source = Path(__file__).resolve().parent.parent
        bundled = source / "node" / "node.exe"
        node = str(bundled) if bundled.exists() else shutil.which("node")
        self.assertIsNotNone(node, "Node is required by the repository's pre-commit gate")
        with tempfile.TemporaryDirectory() as directory:
            comfy = Path(directory)
            custom = comfy / "custom_nodes"
            custom.mkdir()
            (custom / "user_node.py").write_text("user's custom node")
            models = comfy / "models"
            models.mkdir()
            (models / "saved.safetensors").write_bytes(b"user model")
            def run(args):
                subprocess.run(args, check=True, capture_output=True, timeout=20)
            installer.install_studio_nodes(source, comfy, node, run)
            for name in ["aiplay_yue2_score.py", "aiplay_yue2_continue.py"]:
                self.assertEqual((custom / name).read_bytes(), (source / "server" / "comfy_nodes" / name).read_bytes())
            self.assertEqual((custom / "user_node.py").read_text(), "user's custom node")
            self.assertEqual((models / "saved.safetensors").read_bytes(), b"user model")
            self.assertFalse((custom / "comfyui-minimax-h3-blockcache-T8").exists())
            installer.install_studio_nodes(source, comfy, node, run)
            self.assertEqual((custom / "user_node.py").read_text(), "user's custom node")

    def test_only_approved_repository_exact_commit_and_generated_token(self):
        env = {"AIPLAY_REPOSITORY": "https://github.com/nemesisone-dev/AIPLAY-Studio.git", "AIPLAY_COMMIT": "a" * 40, "AIPLAY_WORKER_TOKEN": "b" * 64}
        self.assertEqual(installer.checked_environment(env)[1], "a" * 40)
        for key, value in [("AIPLAY_REPOSITORY", "https://github.com/unknown/code.git"), ("AIPLAY_COMMIT", "main"), ("AIPLAY_WORKER_TOKEN", "short")]:
            with self.assertRaises(ValueError):
                installer.checked_environment({**env, key: value})

    def test_existing_non_checkout_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            with self.assertRaises(RuntimeError):
                installer.checkout("repo", "a" * 40, Path(directory), calls.append)
            self.assertEqual(calls, [])

    def test_changed_origin_is_refused_before_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / ".git").mkdir()
            calls = []
            with patch.object(installer.subprocess, "check_output", return_value="other/repo"):
                with self.assertRaises(RuntimeError):
                    installer.checkout("approved/repo", "a" * 40, Path(directory), calls.append)
            self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
