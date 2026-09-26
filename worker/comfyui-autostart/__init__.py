"""Start the AIPLAY worker when a persistent RunPod ComfyUI starts.

Copy this directory into ComfyUI/custom_nodes. ComfyUI imports it during
startup; the port check prevents a second worker when one is already running.
"""

import os
import socket
import subprocess
from pathlib import Path


NODE = Path(os.environ.get("AIPLAY_NODE", "/workspace/aiplay-runtime/current/bin/node"))
ROOT = Path(os.environ.get("AIPLAY_WORKER_SOURCE", "/workspace/aiplay-worker-src"))
ENV_FILE = Path(os.environ.get("AIPLAY_WORKER_ENV", "/workspace/aiplay-worker/worker.env"))
LOG_FILE = Path(os.environ.get("AIPLAY_WORKER_LOG", "/workspace/aiplay-worker/worker.log"))
PORT = int(os.environ.get("AIPLAY_WORKER_PORT", "8787"))


def port_is_open():
    with socket.socket() as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", PORT)) == 0


try:
    if not port_is_open() and NODE.exists() and ROOT.exists() and ENV_FILE.exists():
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("ab", buffering=0) as log:
            subprocess.Popen(
                [str(NODE), f"--env-file={ENV_FILE}", "worker/runpod-worker.js"],
                cwd=str(ROOT),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
except Exception as exc:  # Keep ComfyUI usable even if the companion fails.
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("ab") as log:
        log.write(f"AIPLAY autostart failed: {exc}\n".encode())


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
