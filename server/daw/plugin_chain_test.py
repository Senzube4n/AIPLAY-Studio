"""VST3 isolation and region-prefix proofs with a disposable fake worker.

No native plugins are installed or loaded by this suite. The real host has a
separate smoke test; these tests pin failure handling around that boundary.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import plugin_chain
import rack

FAKE_WORKER = r'''
import argparse, base64, json, os, sys, time
import numpy as np
p=argparse.ArgumentParser();p.add_argument('--request');a=p.parse_args()
j=json.load(open(a.request,encoding='utf-8'))
x=np.load(j['input'],allow_pickle=False)
case=j['params'].get('case','ok')
if case=='timeout':time.sleep(5)
if case=='crash':os._exit(7)
if case=='failure':
    print(json.dumps({'ok':False,'error':'registered binary changed'}));sys.exit(4)
if case=='nojson':
    print('native diagnostic, no success reply');sys.exit(0)
if case=='badfile':
    open(j['output'],'wb').write(b'not a numpy file')
else:
    y=np.empty_like(x)
    gain=float(j['params'].get('gain',1));memory=float(base64.b64decode(j['state']).decode())
    for c in range(2):
        value=0
        for i in range(x.shape[1]):
            value=memory*value+float(x[c,i])*gain;y[c,i]=value
    if case=='nan':y[0,0]=np.nan
    if case=='shape':y=y[:,:-1]
    if case=='dtype':y=y.astype(np.float64)
    if case=='oversize':y=np.zeros((2,100000),dtype=np.float32)
    np.save(j['output'],y,allow_pickle=False)
print(json.dumps({'ok':True,'latencySamples':0,'frames':x.shape[1]+(1 if case=='frames' else 0)}))
'''


class PluginBoundary(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="vst-boundary-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.worker = self.root / "fake_worker.py"
        self.worker.write_text(FAKE_WORKER, encoding="utf-8")
        registry = self.root / "registry.json"
        registry.write_text("{}", encoding="utf-8")
        self.env = patch.dict(os.environ, {"AIPLAY_VST_PYTHON": sys.executable,
                                           "AIPLAY_DAW_PLUGIN_REGISTRY": str(registry)})
        self.env.start(); self.addCleanup(self.env.stop)
        self.worker_patch = patch.object(plugin_chain, "WORKER", self.worker)
        self.worker_patch.start(); self.addCleanup(self.worker_patch.stop)
        self.insert = {"id": "ins", "type": "vst3", "enabled": True,
                       "plugin": {"id": "vst_fake", "label": "Fake Delay", "fingerprint": "a" * 64,
                                  "hostVersion": "test", "state": base64.b64encode(b"0.75").decode()},
                       "params": {"gain": 0.5}}
        self.audio = np.zeros((2, 64), dtype=np.float64)
        self.audio[:, 0] = [0.8, 0.4]

    def render(self, case="ok", **options):
        insert = dict(self.insert, params={**self.insert["params"], "case": case})
        return plugin_chain.run_vst3(self.audio, insert, {"sr": 48000}, **options)

    def test_catalog_and_disabled_passthrough_without_host(self):
        self.assertEqual(set(rack.DEVICES), set(rack.CATALOG))
        self.assertTrue(rack.CATALOG["vst3"]["stateful"])
        with patch.dict(os.environ, {}, clear=True):
            result = rack.run_chain(self.audio, [{"type": "vst3", "enabled": False}], {"sr": 48000})
        self.assertIs(result, self.audio)

    def test_saved_state_and_controls_move_real_samples(self):
        out = self.render()
        self.assertEqual(out.dtype, np.float64)
        self.assertEqual(out.shape, self.audio.shape)
        self.assertAlmostEqual(out[0, 0], 0.4, places=6)
        self.assertAlmostEqual(out[0, 1], 0.3, places=6)
        self.assertGreater(out[0, 2], 0)  # stateful tail after a one-frame impulse
        self.assertTrue(np.isfinite(out).all())
        self.assertTrue(np.array_equal(out, self.render()))

    def test_absolute_zero_prefix_seam_and_future_context(self):
        full = rack.run_chain(self.audio, [self.insert], {"sr": 48000})
        prefix = rack.run_chain(self.audio[:, :32], [self.insert], {"sr": 48000})
        self.assertTrue(np.array_equal(full[:, :32], prefix))
        mx = {"tracks": {"a": {"inserts": [dict(self.insert,
            plugin=dict(self.insert["plugin"], latencySamples=480))]}}, "master": {"inserts": []}}
        self.assertAlmostEqual(rack.graph_future_seconds(mx), .01)
        mx["tracks"]["a"]["inserts"][0]["enabled"] = False
        self.assertEqual(rack.graph_future_seconds(mx), 0)

    def test_missing_host_is_named_and_does_not_return_dry_audio(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "VST3 Fake Delay.*unavailable"):
                self.render()

    def test_worker_crash_failure_and_bad_reply_are_named(self):
        for case in ("crash", "failure", "nojson"):
            with self.subTest(case=case), self.assertRaisesRegex(ValueError, "VST3 Fake Delay"):
                self.render(case)

    def test_worker_timeout_is_bounded(self):
        with self.assertRaisesRegex(ValueError, "Fake Delay.*timed out"):
            self.render("timeout", timeout=.1)

    @unittest.skipUnless(os.name == "nt", "Windows venv redirector lifetime")
    def test_timeout_reaps_real_worker_tree_before_removing_log_files(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel.CloseHandle.restype = wintypes.BOOL
        parent_pid, child_pid = self.root / "parent.pid", self.root / "child.pid"
        child = ("import os,time;from pathlib import Path;"
                 f"Path({str(child_pid)!r}).write_text(str(os.getpid()));time.sleep(30)")
        self.worker.write_text("import os,subprocess,sys,time;from pathlib import Path\n"
                               f"Path({str(parent_pid)!r}).write_text(str(os.getpid()))\n"
                               f"subprocess.Popen([sys.executable,'-c',{child!r}])\n"
                               "time.sleep(30)\n", encoding="utf-8")
        handles, directories = [], []
        ready, stopping = threading.Event(), threading.Event()

        def observe():
            # Hold handles while both real interpreters are alive. Checking
            # their signaled state later cannot mistake PID reuse for exit.
            for file in (parent_pid, child_pid):
                while not stopping.is_set():
                    try:
                        pid = int(file.read_text())
                        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
                        if handle and kernel.WaitForSingleObject(handle, 0) == 258:
                            handles.append((pid, handle))
                            break
                        if handle:
                            kernel.CloseHandle(handle)
                    except (OSError, ValueError):
                        pass
                    stopping.wait(.005)
                else:
                    return
            ready.set()

        original = tempfile.TemporaryDirectory
        def temporary(*args, **kwargs):
            directory = original(*args, **kwargs)
            directories.append(Path(directory.name))
            return directory
        watcher = threading.Thread(target=observe, daemon=True)
        watcher.start()
        started = time.monotonic()
        try:
            with patch.object(plugin_chain.tempfile, "TemporaryDirectory", temporary):
                with self.assertRaisesRegex(ValueError, "Fake Delay.*timed out"):
                    self.render(timeout=1)
            self.assertTrue(ready.wait(.5), "both real interpreters must be observed before timeout")
            self.assertEqual(len(handles), 2)
            for pid, handle in handles:
                self.assertEqual(kernel.WaitForSingleObject(handle, 0), 0,
                                 f"owned interpreter {pid} still holds the worker's log handles")
            self.assertTrue(directories and all(not file.exists() for file in directories))
            self.assertLess(time.monotonic() - started, 6)
        finally:
            stopping.set(); watcher.join(1)
            # A regression must not leave the fixture's sleepers behind.
            # These handles belong only to interpreters this test observed.
            for pid, handle in handles:
                if kernel.WaitForSingleObject(handle, 0) == 258:
                    subprocess.run([os.path.join(os.environ.get("SystemRoot", "C:\\Windows"), "System32", "taskkill.exe"),
                                    "/PID", str(pid), "/T", "/F"], shell=False,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                    kernel.WaitForSingleObject(handle, 5000)
                kernel.CloseHandle(handle)
            for directory in directories:
                if directory.exists():
                    import shutil
                    shutil.rmtree(directory)

    @unittest.skipUnless(os.name == "nt", "Windows tree-stop contract")
    def test_failed_tree_stop_is_not_reported_as_success(self):
        from unittest.mock import Mock
        worker = Mock(pid=12345)
        worker.poll.return_value = None
        failed = subprocess.CalledProcessError(1, "taskkill")
        with patch.object(plugin_chain.subprocess, "run", side_effect=failed) as stop:
            with self.assertRaisesRegex(OSError, "process tree could not be stopped"):
                plugin_chain._stop_worker(worker)
        args, options = stop.call_args
        self.assertEqual(args[0], [os.path.join(os.environ.get("SystemRoot", "C:\\Windows"), "System32", "taskkill.exe"),
                                   "/PID", "12345", "/T", "/F"])
        self.assertIs(options["shell"], False)
        self.assertIs(options["check"], True)
        self.assertEqual(options["timeout"], 5)
        worker.kill.assert_called_once_with()
        worker.wait.assert_called_once_with(timeout=5)

    def test_timeout_keeps_named_error_when_teardown_fails(self):
        from unittest.mock import Mock
        worker = Mock()
        worker.wait.side_effect = subprocess.TimeoutExpired("fake-worker", .1)
        for failure in (OSError("tree stop failed"), subprocess.TimeoutExpired("worker-reap", 5)):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(plugin_chain.subprocess, "Popen", return_value=worker), \
                    patch.object(plugin_chain, "_stop_worker", side_effect=failure):
                with self.assertRaisesRegex(ValueError, "Fake Delay.*timed out.*could not be stopped"):
                    self.render(timeout=.1)

    def test_rejects_wrong_shape_type_nonfinite_and_oversized_output(self):
        for case in ("shape", "dtype", "nan", "oversize", "frames", "badfile"):
            with self.subTest(case=case), self.assertRaisesRegex(ValueError, "VST3 Fake Delay"):
                self.render(case)

    def test_temp_io_is_removed_after_success_and_failure(self):
        original = tempfile.TemporaryDirectory
        paths = []
        def temporary(*args, **kwargs):
            directory = original(*args, **kwargs)
            paths.append(directory.name)
            return directory
        with patch.object(plugin_chain.tempfile, "TemporaryDirectory", temporary):
            self.render()
            with self.assertRaises(ValueError): self.render("failure")
        self.assertEqual(len(paths), 2)
        self.assertTrue(all(not Path(file).exists() for file in paths))


if __name__ == "__main__":
    unittest.main()
