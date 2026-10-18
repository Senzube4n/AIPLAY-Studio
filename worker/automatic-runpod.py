#!/usr/bin/env python3
"""Pinned first-boot installation for NEW AIPLAY Pods only.

No account key, arbitrary commands, model URLs or tokens are accepted over HTTP.
The temporary status server is bearer authenticated; only the worker port is exposed.
Model downloads remain behind the worker's curated catalogue and licence approval.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY_COMMIT = "ce1e922d8623bb507180e32a0c01a7d0e29edef7"
BASE = Path("/workspace/aiplay-managed")
STAGES = {"source", "runtime", "engine", "dependencies", "starting", "complete", "failed"}


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
    pod_id = os.environ.get("RUNPOD_POD_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", pod_id):
        raise RuntimeError("Provider computer identity is unavailable")
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir = BASE / "state"
    state_dir.mkdir(exist_ok=True, mode=0o700)
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
            if self.path != "/v1/install/status":
                self.send_error(503, "AI service is installing")
                return
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
        def run(args, **kwargs):
            subprocess.run(args, check=True, stdout=log, stderr=log, timeout=1800, **kwargs)

        try:
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
            engine = subprocess.Popen([str(python), str(comfy / "main.py"), "--listen", "127.0.0.1", "--port", "8188",
                "--disable-auto-launch", "--extra-model-paths-config", str(paths), "--output-directory", str(output),
                "--input-directory", str(inputs), "--temp-directory", str(temp)], cwd=comfy, stdout=log, stderr=log)
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
            worker = subprocess.Popen([str(node), str(source / "worker" / "runpod-worker.js")], env=env, stdout=log, stderr=log)
            while worker.poll() is None and engine.poll() is None:
                time.sleep(2)
            raise RuntimeError("An AI service stopped unexpectedly; inspect installation.log before restarting")
        except Exception as exc:
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
