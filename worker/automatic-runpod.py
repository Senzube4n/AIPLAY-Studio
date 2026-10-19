#!/usr/bin/env python3
"""Pinned first-boot installation for NEW AIPLAY Pods only.

No account key, arbitrary commands, model URLs or tokens are accepted over HTTP.
The temporary status server is bearer authenticated; only the worker port is exposed.
Model downloads remain behind the worker's curated catalogue and licence approval.
"""
import hashlib
import hmac
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY_COMMIT = "ce1e922d8623bb507180e32a0c01a7d0e29edef7"
ACCEPTANCE_PROTOCOL = 2
BASE = Path("/workspace/aiplay-managed")
STAGES = {"source", "runtime", "engine", "dependencies", "starting", "complete", "failed"}


def acceptance_policy(env):
    if not env.get('AIPLAY_ACCEPTANCE_ID'):
        if any(k.startswith('AIPLAY_ACCEPTANCE_') for k in env):
            raise ValueError('Incomplete acceptance deadline')
        return None
    policy = {name: int(env['AIPLAY_ACCEPTANCE_' + key]) for name, key in
              [('issuedAt', 'ISSUED_AT'), ('workUntil', 'WORK_UNTIL'), ('stopBy', 'STOP_BY')]}
    policy['requestId'] = env['AIPLAY_ACCEPTANCE_ID']
    if not re.fullmatch(r'[a-f0-9-]{36}', policy['requestId']) or policy['issuedAt'] <= 0 \
            or policy['workUntil'] - policy['issuedAt'] != 90 * 60000 \
            or policy['stopBy'] - policy['issuedAt'] != 120 * 60000:
        raise ValueError('Acceptance deadline must reserve the final 30 minutes')
    return policy


class AcceptanceSupervisor:
    """Only this new test Pod, only stop, independent of the desktop/worker.

    The normal worker owns cancellation/storage preparation. This supervisor
    owns the acceptance stop credential and journal; it cannot start or delete.
    """
    def __init__(self, state_dir, pod_id, policy, provider, worker, preserve, cancel,
                 now=lambda: int(time.time() * 1000), monotonic=time.monotonic):
        self.file = Path(state_dir) / 'acceptance-deadline.json'
        self.file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.now, self.monotonic = now, monotonic
        self.provider, self.worker, self.preserve, self.cancel = provider, worker, preserve, cancel
        self.state = {'version': 1, 'podId': pod_id, **policy, 'phase': 'watching', 'sentAt': None, 'confirmedStopped': False}
        if self.file.exists():
            saved = json.loads(self.file.read_text())
            if any(saved.get(k) != self.state[k] for k in ['podId', 'requestId', 'issuedAt', 'workUntil', 'stopBy']):
                raise ValueError('A different acceptance deadline already exists')
            self.state = saved
        if now() + 2000 < self.state.get('lastObservedAt', policy['issuedAt']):
            self.state['phase'] = 'draining'
            self.state['clockRollback'] = True
        # Neither backward clock adjustment nor restarting the worker extends
        # this fixed wall deadline. A live supervisor also uses monotonic time.
        self.work_mono = monotonic() + max(0, policy['workUntil'] - now()) / 1000
        self.stop_mono = monotonic() + max(0, policy['stopBy'] - now()) / 1000
        self.abort = False
        self.save()

    def save(self):
        pending = self.file.with_suffix('.tmp')
        with pending.open('w') as out:
            json.dump(self.state, out)
            out.flush()
            os.fsync(out.fileno())
        pending.replace(self.file)

    def accepting(self):
        return self.state['phase'] == 'watching' and self.now() < self.state['workUntil'] \
            and self.monotonic() < self.work_mono and not self.abort

    def validate_resource(self, pod):
        if pod.get('id') != self.state['podId'] or pod.get('cloud') != 'SECURE' \
                or pod.get('gpu', {}).get('id') != 'NVIDIA A100-SXM4-80GB' or pod['gpu'].get('count') != 1 \
                or pod['gpu'].get('memory', 0) < 64 or pod['gpu'].get('vcpuCount', 0) < 8 \
                or not isinstance(pod.get('cost'), (int, float)) or not 0 < pod['cost'] <= 1.79 \
                or pod.get('disk') != 20 \
                or pod.get('mounts', {}).get('persistent') != {'size': 100, 'path': '/workspace'}:
            raise ValueError('Actual computer differs from the approved test resources')
        if not isinstance(pod.get('_providerClockMS'), (int, float)) or abs(pod['_providerClockMS'] - self.now()) > 60000:
            raise ValueError('The deadline clock could not be verified against the provider')

    def tick(self):
        if self.state['confirmedStopped']:
            return
        try:
            self.state['lastObservedAt'] = max(self.now(), self.state.get('lastObservedAt', self.state['issuedAt']))
            if self.accepting():
                self.save()
                return
            self.state['phase'] = 'draining'
            if self.now() >= self.state['stopBy'] or self.monotonic() >= self.stop_mono:
                self.state['deadlineOverrun'] = True
            self.save()
            pod = self.provider('GET', None)
            if pod.get('id') != self.state['podId']:
                raise ValueError('Provider computer identity changed')
            if pod.get('status') == 'EXITED':
                self.state.update(phase='stopped', confirmedStopped=True, confirmedAt=self.now(), error=None)
                self.save()
                return
            if self.state['sentAt'] is not None:
                self.state['error'] = 'Awaiting provider confirmation; no duplicate stop request'
                self.save()
                return
            ready = False
            try:
                result = self.worker('/v1/cloud/stop', {'podId': self.state['podId'], 'mode': 'now',
                    'requestId': self.state['requestId'], 'confirm': 'CANCEL WORK AND STOP'})
                ready = result.get('ready') is True and result.get('storageVerified') is True \
                    and result.get('permit', {}).get('root') == '/workspace'
            except (OSError, ValueError):
                pass
            # During failed installation, or after ten minutes of draining a
            # stuck worker, stop only child process groups we launched here.
            if not ready and (self.abort or self.now() >= self.state['workUntil'] + 10 * 60000
                              or self.monotonic() >= self.work_mono + 600):
                self.cancel()
                self.preserve()  # Reuses CloudStorage.persist when outputs exist.
                ready = True
            if not ready:
                self.state['error'] = 'Waiting for cancellation and persistent output verification'
                self.save()
                return
            mount = pod.get('mounts', {}).get('persistent', {})
            if mount.get('path') != '/workspace' or mount.get('size') != 100 or pod.get('locked') \
                    or 'stop' not in pod.get('actions', []):
                raise ValueError('Provider storage or stop permission could not be verified')
            # Write ahead. Even a lost HTTP response only permits subsequent
            # GET reconciliation, never a new Pod or blind stop retry.
            self.state.update(phase='stopping', sentAt=self.now(), error=None)
            self.save()
            self.provider('POST', {'action': 'stop'})
            after = self.provider('GET', None)
            if after.get('id') == self.state['podId'] and after.get('status') == 'EXITED':
                self.state.update(phase='stopped', confirmedStopped=True, confirmedAt=self.now())
            self.save()
        except Exception as exc:
            # No arbitrary response bodies, exception arguments or credentials.
            self.state['error'] = 'Acceptance shutdown needs attention: ' + type(exc).__name__
            self.save()


def verified_workspace(root=Path('/workspace'), mountinfo=Path('/proc/self/mountinfo')):
    actual = root.resolve(strict=True)
    mounts = [Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), row.split()[4]))
              for row in mountinfo.read_text().splitlines()]
    if actual == Path('/') or actual not in mounts:
        raise ValueError('The persistent workspace mount could not be verified')
    return actual


def checked_environment(env):
    repo, commit, token = (env.get(k, "") for k in ("AIPLAY_REPOSITORY", "AIPLAY_COMMIT", "AIPLAY_WORKER_TOKEN"))
    if repo.lower() not in ("https://github.com/nemesisone-dev/aiplay-studio.git", "https://github.com/senzube4n/aiplay-studio.git"):
        raise ValueError("Unapproved AIPLAY repository")
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[a-f0-9]{64}", token):
        raise ValueError("Missing pinned build or generated connection code")
    return repo, commit, token


def checkout(repo, commit, target, run):
    if not (target / ".git").exists():
        if target.exists():
            raise RuntimeError("Installation source folder already exists without Git; review it manually")
        run(["git", "init", "-q", str(target)])
        run(["git", "-C", str(target), "remote", "add", "origin", repo])
    origin = subprocess.check_output(["git", "-C", str(target), "remote", "get-url", "origin"], text=True).strip()
    if origin != repo:
        raise RuntimeError("Source repository changed; refusing to replace it")
    run(["git", "-C", str(target), "fetch", "--depth", "1", "origin", commit])
    # Only this dedicated source checkout is changed; models, state and outputs live elsewhere.
    run(["git", "-C", str(target), "checkout", "-q", "--detach", commit])
    actual = subprocess.check_output(["git", "-C", str(target), "rev-parse", "HEAD"], text=True).strip()
    if actual != commit:
        raise RuntimeError("Source commit did not match the approved build")


def download(url, target):
    with urllib.request.urlopen(url, timeout=60) as response, target.open("wb") as out:
        shutil.copyfileobj(response, out)


def install_node(base, run):
    node = base / "node" / "bin" / "node"
    if node.exists():
        return node
    # Pinned vendor runtime and vendor checksum, never an unchecked archive.
    version = "v22.23.3"
    name = f"node-{version}-linux-x64.tar.xz"
    url = f"https://nodejs.org/dist/{version}"
    sums = urllib.request.urlopen(f"{url}/SHASUMS256.txt", timeout=60).read().decode()
    expected = next(line.split()[0] for line in sums.splitlines() if line.split()[-1] == name)
    archive = base / name
    download(f"{url}/{name}", archive)
    with archive.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected:
        raise RuntimeError("Node runtime checksum failed")
    # Python's data filter prevents absolute paths, escaping links and device files.
    with tarfile.open(archive) as bundle:
        bundle.extractall(base, filter="data")
    (base / f"node-{version}-linux-x64").rename(base / "node")
    archive.unlink()
    return node


def install_studio_nodes(source, comfy, node, run):
    # Reuse the normal engine's node deployment, including its opt-in rules.
    # This source and ComfyUI checkout are both pinned, dedicated installations.
    run([str(node), "--input-type=module", "-e",
         "import {pathToFileURL} from 'node:url'; "
         "const {deployStudioNodes}=await import(pathToFileURL(process.argv[1]).href); "
         "const result=deployStudioNodes(process.argv[2]); "
         "console.log('AIPLAY nodes deployed:', result.copied.length, 'copied,', result.kept.length, 'kept');",
         str(source / "server" / "comfy_nodes.js"), str(comfy / "custom_nodes")])


def main():
    repo, commit, token = checked_environment(os.environ)
    policy = acceptance_policy(os.environ)
    # Only the supervisor holds this separate credential. Do not inherit it
    # into pip, git, ComfyUI, custom nodes, or the HTTP worker.
    stop_key = os.environ.pop('AIPLAY_ACCEPTANCE_STOP_KEY', '')
    if policy and (len(stop_key) < 20 or '\n' in stop_key or '\r' in stop_key):
        raise ValueError('A separate acceptance stop key is required')
    pod_id = os.environ.get("RUNPOD_POD_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", pod_id):
        raise RuntimeError("Provider computer identity is unavailable")
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir = BASE / "state"
    state_dir.mkdir(exist_ok=True, mode=0o700)
    children, children_lock = [], threading.Lock()
    supervisor = None
    source = BASE / ('source-' + commit)
    for folder in ['models', 'input', 'output', 'temp']:
        (BASE / folder).mkdir(exist_ok=True)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            raise ValueError('Redirects are not allowed')
    opener = urllib.request.build_opener(NoRedirect)
    def json_request(url, key, body=None, provider_clock=False):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, headers={
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        with opener.open(request, timeout=10) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            date = response.headers.get('Date')
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Diagnostic response exceeds size limit')
        result = json.loads(raw)
        if provider_clock and isinstance(result, dict):
            try:
                result['_providerClockMS'] = int(parsedate_to_datetime(date).timestamp() * 1000)
            except (TypeError, ValueError, AttributeError):
                result['_providerClockMS'] = None
        return result
    def provider(method, body):
        suffix = '/action' if method == 'POST' else ''
        return json_request('https://api.runpod.io/v2/pods/' + pod_id + suffix, stop_key, body, provider_clock=True)
    def cancel_children():
        with children_lock:
            active = [p for p in children if p.poll() is None]
        for process in active:
            os.killpg(process.pid, signal.SIGTERM)
        for process in active:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
    def preserve():
        verified_workspace()
        node = BASE / 'node/bin/node'
        if node.exists() and (source / 'worker/cloud-storage.js').exists():
            # Same persistence verification, output checksums and sync as the
            # normal lifecycle; the worker need not still be alive.
            program = """import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
const base=process.argv[1], source=process.argv[2];
const {createCloudStorage,persistentPaths}=await import(pathToFileURL(source+'/worker/cloud-storage.js'));
const dirs=['models','output','input','state'];
const verifyPersistence=()=>persistentPaths('/workspace',dirs.map(d=>base+'/'+d));
const storage=createCloudStorage({root:'/workspace',modelsDir:base+'/models',outputDir:base+'/output',inputDir:base+'/input',tempDir:base+'/temp',stateDir:base+'/state',verifyPersistence});
let jobs={};try{jobs=JSON.parse(await readFile(base+'/state/jobs.json','utf8')).jobs||{}}catch(e){if(e.code!=='ENOENT')throw e}
await storage.persist(Object.values(jobs));"""
            subprocess.run([str(node), '--input-type=module', '-e', program, str(BASE), str(source)],
                           check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            # Before a runtime exists there can be no generation. Never apply
            # this fallback if any output or job state needs verification.
            if (state_dir / 'jobs.json').exists() or any((BASE / 'output').iterdir()):
                raise ValueError('Output verification requires the installed lifecycle runtime')
            subprocess.run(['sync', '-f', '/workspace'], check=True, timeout=30,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if policy:
        supervisor = AcceptanceSupervisor(state_dir, pod_id, policy, provider,
            lambda route, body: json_request('http://127.0.0.1:8787' + route, token, body),
            preserve, cancel_children)
        def supervise():
            while not supervisor.state['confirmedStopped']:
                supervisor.tick()
                time.sleep(5)
        threading.Thread(target=supervise, daemon=True).start()
    status_file = state_dir / "install-status.json"
    status = {"stage": "source", "commit": commit, "podId": pod_id}
    status_lock = threading.Lock()

    def mark(stage):
        assert stage in STAGES
        with status_lock:
            status["stage"] = stage
            pending = status_file.with_suffix(".tmp")
            pending.write_text(json.dumps(status))
            pending.replace(status_file)

    class Status(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log authorization headers or connection codes.

        def do_GET(self):
            supplied = self.headers.get("Authorization", "").encode()
            if not hmac.compare_digest(supplied, ("Bearer " + token).encode()):
                self.send_error(401)
                return
            if self.path == '/v1/acceptance/deadline' and supervisor:
                body = json.dumps(supervisor.state).encode()
            elif self.path != "/v1/install/status":
                self.send_error(503, "AI service is installing")
                return
            else:
                with status_lock:
                    body = json.dumps(status).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("0.0.0.0", 8787), Status)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    engine = None
    worker = None
    # All verbose subprocess output stays on the remote persistent disk.
    with (state_dir / "installation.log").open("ab", buffering=0) as log:
        def launch(args, **kwargs):
            if supervisor and not supervisor.accepting():
                raise RuntimeError('The acceptance workload window has closed')
            process = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=bool(policy), **kwargs)
            with children_lock:
                children.append(process)
            return process
        def run(args, **kwargs):
            if not policy:
                return subprocess.run(args, check=True, stdout=log, stderr=log, timeout=1800, **kwargs)
            process = launch(args, **kwargs)
            try:
                if process.wait(timeout=1800) != 0:
                    raise RuntimeError('An installation subprocess failed')
            except subprocess.TimeoutExpired:
                process.terminate()
                raise

        try:
            if supervisor:
                verified_workspace()
                supervisor.validate_resource(provider('GET', None))
            mark("source")
            source = BASE / ("source-" + commit)
            checkout(repo, commit, source, run)
            mark("runtime")
            node = install_node(BASE, run)
            mark("engine")
            comfy = BASE / ("comfy-" + COMFY_COMMIT)
            checkout("https://github.com/Comfy-Org/ComfyUI.git", COMFY_COMMIT, comfy, run)
            mark("dependencies")
            venv = BASE / "venv"
            if not (venv / "bin" / "python").exists():
                run(["python", "-m", "venv", "--system-site-packages", str(venv)])
            python = venv / "bin" / "python"
            run([str(python), "-m", "pip", "install", "-r", str(comfy / "requirements.txt")])
            install_studio_nodes(source, comfy, node, run)
            models = BASE / "models"
            models.mkdir(exist_ok=True)
            # A separate model root survives code upgrades and container restarts.
            paths = BASE / "model-paths.yaml"
            paths.write_text("aiplay:\n  base_path: " + str(models) + "\n" + "".join(
                f"  {key}: {key}/\n" for key in ("checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "latent_upscale_models")))
            output, inputs, temp = (BASE / p for p in ("output", "input", "temp"))
            for folder in (output, inputs, temp):
                folder.mkdir(exist_ok=True)
            mark("starting")
            engine_entry = [str(python), str(source / 'worker/acceptance-telemetry.py'), str(comfy / 'main.py')] if policy else [str(python), str(comfy / 'main.py')]
            engine = launch([*engine_entry, "--listen", "127.0.0.1", "--port", "8188",
                "--disable-auto-launch", "--extra-model-paths-config", str(paths), "--output-directory", str(output),
                "--input-directory", str(inputs), "--temp-directory", str(temp)], cwd=comfy,
                env={**os.environ, 'AIPLAY_WORKER_STATE': str(state_dir)})
            for _ in range(300):
                if engine.poll() is not None:
                    raise RuntimeError("AI engine exited before it became ready")
                try:
                    with urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2) as response:
                        json.load(response)
                    break
                except (OSError, ValueError):
                    time.sleep(2)
            else:
                raise RuntimeError("AI engine readiness timed out")
            env = {**os.environ, "AIPLAY_INSTALL_COMMIT": commit, "AIPLAY_COMFY_DIR": str(comfy),
                "AIPLAY_MODELS_DIR": str(models), "AIPLAY_WORKER_STATE": str(state_dir),
                "AIPLAY_WORKER_OUTPUT": str(output), "AIPLAY_WORKER_INPUT": str(inputs), "AIPLAY_PERSISTENT_ROOT": "/workspace"}
            mark("complete")
            server.shutdown()
            server.server_close()
            worker = launch([str(node), str(source / "worker" / "runpod-worker.js")], env=env)
            while worker.poll() is None and engine.poll() is None:
                time.sleep(2)
            raise RuntimeError("An AI service stopped unexpectedly; inspect installation.log before restarting")
        except Exception as exc:
            if supervisor:
                supervisor.abort = True
            print("AI installation needs attention. See /workspace/aiplay-managed/state/installation.log", flush=True)
            log.write((type(exc).__name__ + ": " + str(exc) + "\n").encode())
            mark("failed")
            # Keep authenticated diagnostics available. Never delete resources or restart paid compute.
            if engine and engine.poll() is None:
                engine.terminate()
            if worker and worker.poll() is None:
                worker.terminate()
                worker.wait(timeout=15)
            if server.socket.fileno() < 0:
                server = ThreadingHTTPServer(("0.0.0.0", 8787), Status)
                threading.Thread(target=server.serve_forever, daemon=True).start()
            while True:
                time.sleep(60)


if __name__ == "__main__":
    main()
