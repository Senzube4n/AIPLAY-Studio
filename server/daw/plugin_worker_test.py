"""CPU-only worker guards; fake effects, no native plugin is executed."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("daw_plugin_worker", Path(__file__).with_name("plugin_worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerGuards(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="aiplay-vst-worker-test-"))
        self.bundle = self.root / "Example.vst3"
        (self.bundle / "Contents" / "x86_64-win").mkdir(parents=True)
        (self.bundle / "Contents" / "x86_64-win" / "Example.vst3").write_bytes(b"test binary")
        (self.bundle / "LICENSE.txt").write_text("notice", encoding="utf-8")
        self.hash = worker.bundle_fingerprint(self.bundle)
        self.registry = self.root / "registry.json"
        self.id = "vst_" + "a" * 64
        self.entry = {"path": str(self.bundle.resolve()), "fingerprint": self.hash, "status": "ready",
                      "descriptor": {"hostVersion": "test", "state": "", "parameters": {}}}
        self.save_registry()

    def save_registry(self):
        self.registry.write_text(json.dumps({"version": 1, "plugins": {self.id: self.entry}}), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.root)

    def request(self):
        return {"registry": str(self.registry), "id": self.id, "fingerprint": self.hash}

    def test_registered_identity_and_resource_changes(self):
        self.assertEqual(worker.registered(self.request())["path"], self.entry["path"])
        (self.bundle / "LICENSE.txt").write_text("updated", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "files changed"):
            worker.registered(self.request())

    def test_hash_matches_node_algorithm(self):
        hash = hashlib.sha256()
        for file in sorted(self.bundle.rglob("*")):
            if file.is_file():
                data = file.read_bytes()
                hash.update((file.relative_to(self.bundle).as_posix() + "\0" + str(len(data)) + ":" + hashlib.sha256(data).hexdigest() + "\0").encode())
        self.assertEqual(self.hash, hash.hexdigest())

    def test_missing_and_wrong_saved_identity(self):
        with self.assertRaisesRegex(ValueError, "identity"):
            worker.registered({**self.request(), "fingerprint": "b" * 64})
        with self.assertRaisesRegex(ValueError, "not registered"):
            worker.registered({**self.request(), "id": "absent"})

    def test_windows_outer_bundle_resolves_native_binary(self):
        with patch.object(worker, "os", SimpleNamespace(name="nt")), patch.object(worker.platform, "machine", return_value="AMD64"):
            self.assertTrue(worker.plugin_load_path(self.entry).endswith("Contents\\x86_64-win\\Example.vst3") or worker.plugin_load_path(self.entry).endswith("Contents/x86_64-win/Example.vst3"))
            (self.bundle / "Contents" / "x86_64-win" / "Other.vst3").write_bytes(b"second")
            with self.assertRaisesRegex(ValueError, "single VST3"):
                worker.plugin_load_path(self.entry)

    def test_strict_parameter_values_and_state(self):
        schema = {"gain": {"type": "number", "min": -120, "max": 18}, "mono": {"type": "number", "min": 0, "max": 2, "step": 1},
                  "active": {"type": "bool"}, "mode": {"type": "enum", "values": ["a", "b"]}}
        self.assertEqual(worker.checked_params(schema, {"gain": -3, "active": False}), {"gain": -3, "active": False})
        for bad in ({"unknown": 0}, {"gain": float("nan")}, {"gain": True}, {"gain": 19}, {"active": 1}, {"mode": "z"}, {"mono": 0.5}):
            with self.assertRaises(ValueError):
                worker.checked_params(schema, bad)
        self.assertEqual(worker.checked_state(base64.b64encode(b"preset").decode()), b"preset")
        with self.assertRaises(ValueError):
            worker.checked_state("%%%%")

    def archive(self, entries):
        archive = self.root / "plugin.zip"
        with zipfile.ZipFile(archive, "w") as out:
            for name, content in entries:
                entry = zipfile.ZipInfo("fixture")
                entry.filename = name
                entry.orig_filename = name
                out.writestr(entry, content)
        return {"input": str(archive), "output": str(self.root / "stage")}

    def test_extract_preserves_bundle_and_license(self):
        job = self.archive([("Folder/Example.vst3/Contents/x86_64-win/Example.vst3", b"binary"), ("Folder/LICENSE.gpl3", b"license")])
        result = worker.extract_zip(job)
        self.assertEqual(result["entries"], 2)
        self.assertEqual((self.root / "stage/Folder/LICENSE.gpl3").read_bytes(), b"license")

    def test_archive_path_and_special_file_refusals(self):
        for name in ("../escape", "/absolute", "C:/evil", "dir\\evil", "dir/CON.txt", "foo/../escape", "bad. /file"):
            with self.subTest(name=name):
                job = self.archive([(name, b"unsafe")])
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    worker.extract_zip(job)
                shutil.rmtree(self.root / "stage")
        archive = self.root / "plugin.zip"
        with zipfile.ZipFile(archive, "w") as out:
            entry = zipfile.ZipInfo("link")
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            out.writestr(entry, "../../escape")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            worker.extract_zip({"input": str(archive), "output": str(self.root / "stage")})

    def test_case_collisions_and_expansion_limit(self):
        job = self.archive([("Example.vst3", b"a"), ("EXAMPLE.vst3", b"b")])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            worker.extract_zip(job)
        shutil.rmtree(self.root / "stage")
        with zipfile.ZipFile(self.root / "plugin.zip", "w", compression=zipfile.ZIP_DEFLATED) as out:
            out.writestr("huge.vst3", b"0" * (2 * 1024 * 1024))
        with self.assertRaisesRegex(ValueError, "expansion limit"):
            worker.extract_zip(job)

    def test_process_length_state_and_host_identity(self):
        import numpy as np
        class Effect:
            is_instrument = False
            reported_latency_samples = 5
            def reset(self):
                self.calls = 0
            def __call__(self, audio, sr, reset=False):
                self.calls += 1
                # Fake a buffered effect to exercise deficit flushing.
                return audio[:, :-5] * 2 if self.calls == 1 else audio
        fake = SimpleNamespace(load_plugin=lambda path: Effect())
        np.save(self.root / "input.npy", np.ones((2, 100), dtype=np.float32))
        job = {**self.request(), "input": str(self.root / "input.npy"), "output": str(self.root / "output.npy"), "sr": 48000, "hostVersion": "test"}
        with patch.dict("sys.modules", {"pedalboard": fake}), patch("importlib.metadata.version", return_value="test"):
            result = worker.process_plugin(job)
            audio = np.load(self.root / "output.npy")
            self.assertEqual(result["frames"], 100)
            self.assertEqual(audio.shape, (2, 100))
            self.assertTrue(np.isfinite(audio).all())
            with self.assertRaisesRegex(ValueError, "host changed"):
                worker.process_plugin({**job, "hostVersion": "old"})


if __name__ == "__main__":
    unittest.main()
