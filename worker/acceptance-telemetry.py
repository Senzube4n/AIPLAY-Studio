"""Opt-in diagnostic wrapper for the pinned ComfyUI acceptance process.

No model loading, network endpoint, credentials or prompts of its own. The
existing ComfyUI entrypoint runs unchanged after scoped timing wrappers.
"""
import functools
import builtins
import inspect
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import threading
import time


def memory_sample(proc=Path('/proc'), cgroup=Path('/sys/fs/cgroup')):
    def fields(file):
        result = {}
        try:
            for line in file.read_text().splitlines():
                name, value = line.split(':', 1)
                parts = value.split()
                if parts and parts[0].isdigit():
                    result[name] = int(parts[0]) * (1024 if len(parts) > 1 and parts[1] == 'kB' else 1)
        except (OSError, ValueError):
            pass
        return result
    def counter(file):
        try:
            value = file.read_text().strip()
            return int(value) if value.isdigit() else None
        except OSError:
            return None
    status, host = fields(proc / 'self/status'), fields(proc / 'meminfo')
    return {'processRssBytes': status.get('VmRSS'), 'processRssLifetimePeakBytes': status.get('VmHWM'),
            'processSwapBytes': status.get('VmSwap'), 'hostTotalBytes': host.get('MemTotal'),
            'hostAvailableBytes': host.get('MemAvailable'),
            'containerCurrentBytes': counter(cgroup / 'memory.current'),
            'containerLimitBytes': counter(cgroup / 'memory.max'),
            'containerLifetimePeakBytes': counter(cgroup / 'memory.peak')}


def gpu_sample(run=subprocess.check_output):
    try:
        raw = run(['nvidia-smi', '--query-gpu=index,memory.total,memory.used,memory.free',
                   '--format=csv,noheader,nounits'], text=True, timeout=2, stderr=subprocess.DEVNULL)
        return [{'index': int(p[0]), 'totalBytes': int(float(p[1]) * 1048576),
                 'usedBytes': int(float(p[2]) * 1048576), 'freeBytes': int(float(p[3]) * 1048576)}
                for p in (line.split(',') for line in raw.strip().splitlines()) if len(p) == 4]
    except (OSError, ValueError, subprocess.SubprocessError):
        return []


class Recorder:
    def __init__(self, state_dir, clock=time.monotonic, wall=time.time):
        self.dir = Path(state_dir)
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.clock, self.wall = clock, wall
        self.lock = threading.RLock()
        self.started = clock()
        self.summary = {'version': 1, 'sampleIntervalSeconds': 1, 'samples': 0, 'gaps': 0,
                        'observedPeaks': {}, 'timings': [], 'timingRecordsDropped': 0,
                        'scope': 'ComfyUI process; container and whole-host counters are separate'}
        self.last = None

    def save(self):
        pending = self.dir / 'acceptance-telemetry.tmp'
        pending.write_text(json.dumps(self.summary))
        pending.replace(self.dir / 'acceptance-telemetry.json')

    def sample(self, memory=None, gpus=None):
        with self.lock:
            at = self.clock()
            if self.last is not None and at - self.last > 2.5:
                self.summary['gaps'] += 1
            self.last = at
            memory = memory_sample() if memory is None else memory
            gpus = gpu_sample() if gpus is None else gpus
            row = {'at': self.wall(), 'elapsedSeconds': at - self.started, 'memory': memory, 'gpus': gpus}
            self.summary['samples'] += 1
            self.summary['latest'] = row
            self.summary.setdefault('baseline', row)
            peaks = self.summary['observedPeaks']
            # Never relabel host consumption or lifetime counters as job peaks.
            for key in ['processRssBytes', 'containerCurrentBytes']:
                if isinstance(memory.get(key), int):
                    peaks[key] = max(peaks.get(key, 0), memory[key])
            for gpu in gpus:
                key = 'gpu' + str(gpu['index']) + 'UsedBytes'
                peaks[key] = max(peaks.get(key, 0), gpu['usedBytes'])
            self.save()

    def wrap(self, owner, name, label):
        original = getattr(owner, name, None)
        if not callable(original) or getattr(original, '_aiplay_acceptance', False):
            return
        descriptor = inspect.getattr_static(owner, name)
        binding = type(descriptor) if isinstance(descriptor, (classmethod, staticmethod)) else None
        if binding:
            original = descriptor.__func__
        def end(start, success):
            try:
                with self.lock:
                    row = {'operation': label, 'startElapsedSeconds': start - self.started,
                           'durationSeconds': self.clock() - start, 'success': success}
                    if len(self.summary['timings']) < 1000:
                        self.summary['timings'].append(row)
                    else:
                        self.summary['timingRecordsDropped'] += 1
                    self.save()
            except Exception:
                # Diagnostics must not turn a successful inference into a
                # failure or mask the original model exception.
                self.summary['diagnosticWriteErrors'] = self.summary.get('diagnosticWriteErrors', 0) + 1
        if inspect.iscoroutinefunction(original):
            @functools.wraps(original)
            async def timed(*args, **kwargs):
                start, success = self.clock(), False
                try:
                    result = await original(*args, **kwargs)
                    success = True
                    return result
                finally:
                    end(start, success)
        else:
            @functools.wraps(original)
            def timed(*args, **kwargs):
                start, success = self.clock(), False
                try:
                    result = original(*args, **kwargs)
                    success = True
                    return result
                finally:
                    end(start, success)
        timed._aiplay_acceptance = True
        setattr(owner, name, binding(timed) if binding else timed)
        self.summary.setdefault('installedHooks', []).append(label)

    def instrument_nodes(self, nodes):
        for name in ['UNETLoader', 'DualCLIPLoader', 'VAELoader', 'TextEncodeAceStepAudio1.5',
                     'KSampler', 'VAEDecodeAudio', 'SaveAudio']:
            cls = nodes.NODE_CLASS_MAPPINGS.get(name)
            if cls:
                function = getattr(cls, 'FUNCTION', None) or ('execute' if hasattr(cls, 'execute') else None)
                if function:
                    self.wrap(cls, function, 'node:' + name)


def main():
    state = os.environ['AIPLAY_WORKER_STATE']
    comfy = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(comfy.parent))
    sys.argv = [str(comfy), *sys.argv[2:]]
    recorder = Recorder(state)
    # Do not import torch/ComfyUI before main.py applies its environment and
    # CUDA options. Observe its ordinary imports, then wrap loaded modules.
    original_import = builtins.__import__
    installed = False
    def observed_import(*args, **kwargs):
        nonlocal installed
        result = original_import(*args, **kwargs)
        nodes = sys.modules.get('nodes')
        if not installed and nodes and hasattr(nodes, 'init_extra_nodes') and 'comfy.sd' in sys.modules:
            installed = True
            builtins.__import__ = original_import
            recorder.wrap(sys.modules.get('comfy.utils'), 'load_torch_file', 'checkpoint_deserialization')
            recorder.wrap(sys.modules.get('comfy.sd'), 'load_diffusion_model', 'diffusion_loader_inclusive')
            recorder.wrap(sys.modules.get('comfy.model_management'), 'load_models_gpu', 'gpu_load_or_offload_inclusive')
            torch = sys.modules.get('torch')
            recorder.summary['runtime'] = {'python': sys.version.split()[0], 'torch': str(getattr(torch, '__version__', 'unknown')),
                                           'cudaRuntime': getattr(getattr(torch, 'version', None), 'cuda', None)}
            init = nodes.init_extra_nodes
            async def initialize(*a, **kw):
                value = await init(*a, **kw)
                recorder.instrument_nodes(nodes)
                return value
            nodes.init_extra_nodes = initialize
            recorder.instrument_nodes(nodes)
        return result
    builtins.__import__ = observed_import
    def sampling():
        while True:
            start = time.monotonic()
            try:
                recorder.sample()
            except Exception:
                with recorder.lock:
                    recorder.summary['gaps'] += 1
            time.sleep(max(0, 1 - (time.monotonic() - start)))
    threading.Thread(target=sampling, daemon=True).start()
    try:
        runpy.run_path(str(comfy), run_name='__main__')
    finally:
        builtins.__import__ = original_import
        with recorder.lock:
            recorder.summary['processEndedAt'] = time.time()
            recorder.save()


if __name__ == '__main__':
    main()
