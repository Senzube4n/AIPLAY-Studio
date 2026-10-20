"""Offline startup validation; no processes, network access or paid resources."""
import importlib.util
import asyncio
import json
import os
import types
import sys
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("automatic_runpod", Path(__file__).with_name("automatic-runpod.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
telemetry_spec = importlib.util.spec_from_file_location('acceptance_telemetry', Path(__file__).with_name('acceptance-telemetry.py'))
telemetry = importlib.util.module_from_spec(telemetry_spec)
telemetry_spec.loader.exec_module(telemetry)


class StartupTests(unittest.TestCase):
    def acceptance_fixture(self, directory):
        f = types.SimpleNamespace(at=100000, mono=0, status='RUNNING', calls=[], ready=True, preserved=0, cancelled=0,
                                  lost=False, storage_failure=False, rejection=None)
        policy = {'issuedAt': f.at, 'workUntil': f.at + 90 * 60000, 'stopBy': f.at + 120 * 60000,
                  'requestId': '12345678-1234-4234-8234-123456789abc'}
        def provider(method, body):
            f.calls.append((method, body))
            if method == 'POST':
                self.assertEqual(body, {'action': 'stop'})
                if f.rejection:
                    raise HTTPError('https://provider.invalid', f.rejection, 'private response', {}, None)
                if f.lost:
                    raise OSError('ambiguous reply')
                f.status = 'EXITED'
            return {'id': 'testpod', 'status': f.status, 'actions': ['stop'], 'cloud': 'SECURE', 'cost': 1.79, '_providerClockMS': f.at,
                    'gpu': {'id': 'NVIDIA A100-SXM4-80GB', 'count': 1, 'memory': 64, 'vcpuCount': 8}, 'disk': 20,
                    'mounts': {'persistent': {'size': 100, 'path': '/workspace'}}}
        def worker(route, body):
            self.assertEqual(route, '/v1/cloud/stop')
            self.assertEqual(body['mode'], 'now')
            return {'ready': f.ready, 'storageVerified': f.ready, 'permit': {'root': '/workspace'}}
        def preserve():
            f.preserved += 1
            if f.storage_failure:
                raise ValueError('Storage unavailable')
        def cancel():
            f.cancelled += 1
        f.create = lambda: installer.AcceptanceSupervisor(directory, 'testpod', policy, provider, worker, preserve, cancel,
                                                          now=lambda: f.at, monotonic=lambda: f.mono)
        f.guard = f.create()
        f.pod = lambda: provider('GET', None)
        f.advance = lambda minutes: (setattr(f, 'at', f.at + minutes * 60000), setattr(f, 'mono', f.mono + minutes * 60))
        return f

    def test_acceptance_deadline_exact_reserve_and_unchanged_normal_startup(self):
        self.assertIsNone(installer.acceptance_policy({}))
        env = {'AIPLAY_ACCEPTANCE_ID': '12345678-1234-4234-8234-123456789abc', 'AIPLAY_ACCEPTANCE_ISSUED_AT': '100000',
               'AIPLAY_ACCEPTANCE_WORK_UNTIL': str(100000 + 90 * 60000), 'AIPLAY_ACCEPTANCE_STOP_BY': str(100000 + 120 * 60000)}
        self.assertEqual(installer.acceptance_policy(env)['stopBy'], 7300000)
        for key, value in [('AIPLAY_ACCEPTANCE_ID', 'other'), ('AIPLAY_ACCEPTANCE_STOP_BY', '9000000'), ('AIPLAY_ACCEPTANCE_WORK_UNTIL', '5000000')]:
            with self.assertRaises(ValueError):
                installer.acceptance_policy({**env, key: value})

    def test_deadline_survives_desktop_disconnection_and_supervisor_restart(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.guard.validate_resource(f.pod())
            f.advance(89)
            f.guard.tick()
            self.assertFalse(any(method == 'POST' for method, _ in f.calls))
            f.guard = f.create()  # No desktop callback or lease is supplied.
            f.advance(1)
            self.assertFalse(f.guard.accepting())
            f.guard.tick()
            self.assertTrue(f.guard.state['confirmedStopped'])
            self.assertEqual(f.guard.state['phase'], 'stopped')
            self.assertEqual(sum(method == 'POST' for method, _ in f.calls), 1)

    def test_backward_live_clock_cannot_extend_the_monotonic_work_window(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.mono = 91 * 60
            f.at = 1
            f.guard.tick()
            self.assertTrue(f.guard.state['confirmedStopped'])

    def test_lost_stop_reply_reconciles_without_repeating_or_replacing_resources(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.advance(90)
            f.lost = True
            f.guard.tick()
            self.assertFalse(f.guard.state['confirmedStopped'])
            f.guard = f.create()
            f.guard.tick()
            self.assertEqual(sum(method == 'POST' for method, _ in f.calls), 1)
            f.status = 'EXITED'
            f.guard.tick()
            self.assertTrue(f.guard.state['confirmedStopped'])

    def test_stuck_worker_uses_reserve_for_owned_process_cancellation_and_existing_persistence(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.ready = False
            f.advance(90)
            f.guard.tick()
            self.assertEqual(f.cancelled, 0)
            f.advance(10)
            f.guard.tick()
            self.assertEqual((f.cancelled, f.preserved), (1, 1))
            self.assertTrue(f.guard.state['confirmedStopped'])

    def test_explicit_stop_refusal_survives_restart_and_retries_after_reconciliation(self):
        for code in (401, 403, 429):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as root:
                f = self.acceptance_fixture(root)
                f.advance(90)
                f.rejection = code
                f.guard.tick()
                self.assertIsNone(f.guard.state['sentAt'])
                self.assertEqual(f.guard.state['rejectedStatus'], code)
                self.assertNotIn('private response', json.dumps(f.guard.state))
                f.guard = f.create()
                f.rejection = None
                f.guard.tick()
                self.assertEqual(sum(method == 'POST' for method, _ in f.calls), 1)
                f.advance(1)
                f.guard.tick()
                self.assertTrue(f.guard.state['confirmedStopped'])
                self.assertEqual(sum(method == 'POST' for method, _ in f.calls), 2)

    def test_server_error_has_unknown_stop_outcome_and_never_retries(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.advance(90)
            f.rejection = 503
            f.guard.tick()
            self.assertIsNotNone(f.guard.state['sentAt'])
            f.guard = f.create()
            f.rejection = None
            f.advance(40)
            f.guard.tick()
            self.assertTrue(f.guard.state['deadlineOverrun'])
            self.assertEqual(sum(method == 'POST' for method, _ in f.calls), 1)
            self.assertFalse(f.guard.state['confirmedStopped'])

    def test_stop_retry_is_bounded_despite_live_or_restarted_clock_rollback(self):
        for restart in (False, True):
            with self.subTest(restart=restart), tempfile.TemporaryDirectory() as root:
                f = self.acceptance_fixture(root)
                f.advance(90)
                f.rejection = 429
                f.guard.tick()
                f.at -= 60 * 60000
                if restart:
                    f.guard = f.create()
                f.rejection = None
                f.mono += 301
                f.guard.tick()
                self.assertTrue(f.guard.state['confirmedStopped'])
                self.assertEqual(sum(method == 'POST' for method, _ in f.calls), 2)

    def test_rejected_stop_backoff_is_bounded_and_revalidates_storage(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.advance(90)
            f.rejection = 429
            for _ in range(8):
                f.guard.tick()
                self.assertLessEqual(f.guard.state['retryAt'] - f.at, 300000)
                f.advance(5)
            f.rejection = None
            f.ready = False
            f.storage_failure = True
            posts = sum(method == 'POST' for method, _ in f.calls)
            f.guard.tick()
            self.assertEqual(sum(method == 'POST' for method, _ in f.calls), posts)
            self.assertFalse(f.guard.state['confirmedStopped'])

    def test_installation_failure_triggers_preservation_and_stop_without_waiting_for_desktop(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.guard.abort = True
            f.ready = False
            f.guard.tick()
            self.assertEqual(f.preserved, 1)
            self.assertTrue(f.guard.state['confirmedStopped'])

    def test_unverified_storage_never_claims_a_stop_or_deletes_data(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.advance(121)
            f.ready = False
            f.storage_failure = True
            f.guard.tick()
            self.assertFalse(f.guard.state['confirmedStopped'])
            self.assertTrue(f.guard.state['deadlineOverrun'])
            self.assertFalse(any(method == 'POST' for method, _ in f.calls))

    def test_incorrect_actual_hardware_and_changed_deadline_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.guard.validate_resource(f.pod())
            for key, value in [('memory', 63), ('vcpuCount', 7), ('id', 'NVIDIA L40S'),
                               ('id', 'NVIDIA A40'), ('id', 'NVIDIA A100 80GB PCIe'), ('count', 2)]:
                pod = f.pod()
                pod['gpu'][key] = value
                with self.assertRaises(ValueError):
                    f.guard.validate_resource(pod)
            for key, value in [('cloud', 'COMMUNITY'), ('cost', 1.80), ('disk', 21),
                               ('mounts', {'persistent': {'size': 150, 'path': '/workspace'}})]:
                pod = f.pod()
                pod[key] = value
                with self.assertRaises(ValueError):
                    f.guard.validate_resource(pod)
            pod = f.pod()
            pod['_providerClockMS'] += 120000
            with self.assertRaises(ValueError):
                f.guard.validate_resource(pod)
            data = json.loads(f.guard.file.read_text())
            data['stopBy'] += 60000
            f.guard.file.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                f.create()

    def test_memory_and_gpu_sampling_keep_scopes_units_and_unavailable_counters_distinct(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            proc, cg = root / 'proc', root / 'cgroup'
            (proc / 'self').mkdir(parents=True)
            cg.mkdir()
            (proc / 'self/status').write_text('VmRSS: 200 kB\nVmHWM: 300 kB\nVmSwap: 0 kB\n')
            (proc / 'meminfo').write_text('MemTotal: 100000 kB\nMemAvailable: 50000 kB\n')
            (cg / 'memory.current').write_text('1048576')
            (cg / 'memory.max').write_text('max')
            sample = telemetry.memory_sample(proc, cg)
            self.assertEqual(sample['processRssBytes'], 200 * 1024)
            self.assertEqual(sample['hostAvailableBytes'], 50000 * 1024)
            self.assertIsNone(sample['containerLimitBytes'])
            self.assertIsNone(sample['containerLifetimePeakBytes'])
            gpu = telemetry.gpu_sample(lambda *a, **kw: '0, 49152, 15000, 34152\n')
            self.assertEqual(gpu[0]['usedBytes'], 15000 * 1048576)
            self.assertEqual(telemetry.gpu_sample(lambda *a, **kw: 'N/A'), [])
            rec = telemetry.Recorder(root / 'state')
            rec.sample(sample, gpu)
            rec.sample({**sample, 'processRssBytes': 100}, [{**gpu[0], 'usedBytes': 2}])
            self.assertEqual(rec.summary['observedPeaks']['processRssBytes'], 200 * 1024)
            self.assertNotIn('hostUsedBytes', rec.summary['observedPeaks'])

    def test_loading_wrappers_preserve_results_exceptions_async_behavior_and_never_capture_inputs(self):
        with tempfile.TemporaryDirectory() as root:
            now = [1.0]
            rec = telemetry.Recorder(root, clock=lambda: now[0])
            result = object()
            def loading(*a, **kw):
                now[0] += .5
                return result
            async def executing(*a, **kw):
                now[0] += 2
                return result
            def failing(*a):
                raise ValueError('private prompt must not enter diagnostic record')
            obj = types.SimpleNamespace(load=loading, execute=executing, fail=failing)
            for name in ['load', 'execute', 'fail']:
                rec.wrap(obj, name, name)
            self.assertIs(obj.load('secret prompt', key='fake-secret-key'), result)
            self.assertIs(asyncio.run(obj.execute('secret prompt')), result)
            with self.assertRaises(ValueError):
                obj.fail('secret prompt')
            self.assertEqual([t['durationSeconds'] for t in rec.summary['timings']], [.5, 2, 0])
            self.assertEqual([t['success'] for t in rec.summary['timings']], [True, True, False])
            self.assertNotIn('secret', json.dumps(rec.summary))

    def test_v3_classmethod_staticmethod_and_diagnostic_disk_failure_do_not_change_inference(self):
        with tempfile.TemporaryDirectory() as root:
            rec = telemetry.Recorder(root)
            class V3:
                @classmethod
                def execute(cls, value):
                    return cls, value
                @staticmethod
                def static(value):
                    return value
            rec.instrument_nodes(types.SimpleNamespace(NODE_CLASS_MAPPINGS={'VAEDecodeAudio': V3}))
            rec.wrap(V3, 'static', 'static')
            self.assertEqual(V3.execute(7), (V3, 7))
            self.assertEqual(V3().execute(8), (V3, 8))
            self.assertEqual(V3.static(9), 9)
            with patch.object(rec, 'save', side_effect=OSError('disk full')):
                self.assertEqual(V3.execute(10), (V3, 10))
            self.assertEqual(rec.summary['diagnosticWriteErrors'], 1)

    def test_wrapper_runs_existing_entrypoint_after_environment_setup_and_instruments_late_nodes(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            comfy = root / 'engine'
            package = comfy / 'comfy'
            package.mkdir(parents=True)
            (package / '__init__.py').write_text('')
            (package / 'utils.py').write_text("import os\nassert os.environ.get('ENGINE_PREPARED') == '1'\ndef load_torch_file(*a, **kw): return 17\n")
            (package / 'model_management.py').write_text('def load_models_gpu(*a, **kw): return True\n')
            (package / 'sd.py').write_text('from comfy import utils, model_management\ndef load_diffusion_model(*a, **kw):\n model_management.load_models_gpu([])\n return utils.load_torch_file("not-a-real-model")\n')
            (comfy / 'nodes.py').write_text('''from comfy import sd
class UNET:
 FUNCTION='load'
 def load(self): return sd.load_diffusion_model('not-a-real-model')
class Audio:
 @classmethod
 def execute(cls, value): return value
NODE_CLASS_MAPPINGS={'UNETLoader':UNET}
async def init_extra_nodes(*args, **kwargs):
 NODE_CLASS_MAPPINGS['VAEDecodeAudio']=Audio
 return True
''')
            main = comfy / 'main.py'
            main.write_text('''import os, asyncio
os.environ['ENGINE_PREPARED']='1'
from comfy import sd
import nodes
assert asyncio.run(nodes.init_extra_nodes()) is True
assert nodes.UNET().load()==17
assert nodes.Audio.execute(31)==31
''')
            state = root / 'state'
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('acceptance-telemetry.py')), str(main)],
                env={**os.environ, 'AIPLAY_WORKER_STATE': str(state)}, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads((state / 'acceptance-telemetry.json').read_text())
            operations = {t['operation'] for t in summary['timings']}
            self.assertTrue({'checkpoint_deserialization', 'gpu_load_or_offload_inclusive', 'node:UNETLoader', 'node:VAEDecodeAudio'} <= operations)
            self.assertTrue(all(t['success'] for t in summary['timings']))

    def test_restart_after_clock_rollback_is_closed_instead_of_extending_the_deadline(self):
        with tempfile.TemporaryDirectory() as root:
            f = self.acceptance_fixture(root)
            f.advance(60)
            f.guard.tick()
            f.at -= 30 * 60000
            f.guard = f.create()
            self.assertFalse(f.guard.accepting())
            self.assertTrue(f.guard.state['clockRollback'])

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
