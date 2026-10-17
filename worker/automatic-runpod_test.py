"""Offline startup validation; no processes, network access or paid resources."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("automatic_runpod", Path(__file__).with_name("automatic-runpod.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class StartupTests(unittest.TestCase):
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
