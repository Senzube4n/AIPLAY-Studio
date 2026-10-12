"""VST3 isolation and region-prefix proofs with a disposable fake worker.

No native plugins are installed or loaded by this suite. The real host has a
separate smoke test; these tests pin failure handling around that boundary.
"""
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
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
