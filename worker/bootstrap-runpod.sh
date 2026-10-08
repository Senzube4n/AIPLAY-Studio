#!/usr/bin/env bash
set -euo pipefail

# Install the AIPLAY worker beside the official RunPod ComfyUI template.
# This script is idempotent: it preserves the worker token. Model weights are
# deliberately not downloaded.
#
# PINNED, NEVER A BRANCH. It installs exactly the commit of the Studio you
# connect from: AIPLAY Studio's RunPod screen shows the command, which names
# the repository and the full commit (AIPLAY_REPOSITORY, AIPLAY_COMMIT) and
# checks this script's sha256 before running it (server/engine/
# runpod-bootstrap.js). It used to clone a branch and fast-forward it at every
# rerun, so whatever that branch held when somebody pasted or reran the
# command ran here as root, with every prompt, render and the worker token.

ROOT="${AIPLAY_WORKER_SOURCE:-/workspace/aiplay-worker-src}"
STATE="${AIPLAY_WORKER_STATE:-/workspace/aiplay-worker}"
RUNTIME="${AIPLAY_RUNTIME:-/workspace/aiplay-runtime}"
REPO="${AIPLAY_REPOSITORY:-}"
COMMIT="${AIPLAY_COMMIT:-}"

if [[ ! "$COMMIT" =~ ^[0-9a-f]{40}$ || ! "$REPO" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]]; then
  echo "Run the command AIPLAY Studio shows on its RunPod screen. It names the repository and the exact commit" >&2
  echo "of the Studio you connect from (AIPLAY_REPOSITORY, AIPLAY_COMMIT), so this Pod runs that Studio's worker" >&2
  echo "and never a branch that moves. Nothing was installed." >&2
  exit 1
fi

if [[ -d /workspace/runpod-slim/ComfyUI ]]; then
  COMFY="/workspace/runpod-slim/ComfyUI"
elif [[ -d /workspace/ComfyUI ]]; then
  COMFY="/workspace/ComfyUI"
else
  echo "ComfyUI was not found under /workspace/runpod-slim/ComfyUI or /workspace/ComfyUI." >&2
  exit 1
fi

for command in curl git sha256sum tar; do
  command -v "$command" >/dev/null || { echo "$command is required by the bootstrap." >&2; exit 1; }
done

mkdir -p "$RUNTIME" "$STATE"
chmod 700 "$STATE"

if [[ ! -x "$RUNTIME/current/bin/node" ]]; then
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    *) echo "This bootstrap currently supports x86_64 RunPod containers." >&2; exit 1 ;;
  esac
  NODE_BASE="https://nodejs.org/dist/latest-v22.x"
  SUMS="$(curl -fsSL "$NODE_BASE/SHASUMS256.txt")"
  NODE_FILE="$(printf '%s\n' "$SUMS" | awk -v arch="$NODE_ARCH" '$2 ~ ("node-v.*-linux-" arch "\\.tar\\.xz$") { print $2; exit }')"
  NODE_SUM="$(printf '%s\n' "$SUMS" | awk -v file="$NODE_FILE" '$2 == file { print $1; exit }')"
  [[ -n "$NODE_FILE" && -n "$NODE_SUM" ]] || { echo "Could not resolve the current Node.js 22 Linux archive." >&2; exit 1; }
  curl -fsSL "$NODE_BASE/$NODE_FILE" -o "$RUNTIME/$NODE_FILE"
  printf '%s  %s\n' "$NODE_SUM" "$RUNTIME/$NODE_FILE" | sha256sum -c -
  rm -rf "$RUNTIME/node-v22" "$RUNTIME/current"
  mkdir -p "$RUNTIME/node-v22"
  tar -xJf "$RUNTIME/$NODE_FILE" -C "$RUNTIME/node-v22" --strip-components=1
  ln -s "$RUNTIME/node-v22" "$RUNTIME/current"
  rm -f "$RUNTIME/$NODE_FILE"
fi

BEFORE=""
if [[ -d "$ROOT/.git" ]]; then
  if [[ "$(git -C "$ROOT" remote get-url origin)" != "$REPO" ]]; then
    echo "$ROOT has a different Git origin. Review it and move that checkout aside before retrying." >&2
    exit 1
  fi
  BEFORE="$(git -C "$ROOT" rev-parse -q --verify HEAD 2>/dev/null || true)"
elif [[ -e "$ROOT" ]]; then
  echo "$ROOT exists but is not an AIPLAY Git checkout; move it aside and retry." >&2
  exit 1
else
  git init -q "$ROOT"
  git -C "$ROOT" remote add origin "$REPO"
fi
# The commit itself, from the named repository: never a branch, never a merge.
git -C "$ROOT" fetch --depth 1 origin "$COMMIT" || {
  echo "Commit $COMMIT is not in $REPO. A Studio built from a commit that is not on GitHub yet cannot install its worker here." >&2
  exit 1
}
git -C "$ROOT" checkout -q --force --detach FETCH_HEAD
if [[ "$(git -C "$ROOT" rev-parse HEAD)" != "$COMMIT" ]]; then
  echo "The checkout in $ROOT is not commit $COMMIT; nothing was started." >&2
  exit 1
fi
# A worker still running an earlier checkout would keep answering with the old
# code: stop it, so the pinned one starts below (and at every ComfyUI start).
if [[ -n "$BEFORE" && "$BEFORE" != "$COMMIT" ]] && command -v pkill >/dev/null; then
  pkill -f "worker/runpod-worker.js" || true
  sleep 2
fi

# Raw ComfyUI must stay on loopback; the bearer-authenticated worker is the
# only HTTP service this Pod exposes. The worker repeats this check on start.
"$RUNTIME/current/bin/node" "$ROOT/worker/check-comfy-loopback.js"

ENV_FILE="$STATE/worker.env"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  TOKEN="$($RUNTIME/current/bin/node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"))')"
  cat > "$ENV_FILE" <<EOF
AIPLAY_WORKER_TOKEN=$TOKEN
AIPLAY_COMFY_DIR=$COMFY
AIPLAY_MODELS_DIR=$COMFY/models
AIPLAY_WORKER_COMFY_URL=http://127.0.0.1:8188
AIPLAY_WORKER_STATE=$STATE
AIPLAY_WORKER_PORT=8787
EOF
fi
chmod 600 "$ENV_FILE"

# Older installs predate the in-app model manager. Add only this non-secret
# location; preserve the existing token and all user-edited values.
if ! grep -q '^AIPLAY_MODELS_DIR=' "$ENV_FILE"; then
  printf '\nAIPLAY_MODELS_DIR=%s/models\n' "$COMFY" >> "$ENV_FILE"
fi

HOOK="$COMFY/custom_nodes/aiplay_worker_autostart"
mkdir -p "$HOOK"
cp "$ROOT/worker/comfyui-autostart/__init__.py" "$HOOK/__init__.py"
python -m py_compile "$HOOK/__init__.py"

TOKEN="$(sed -n 's/^AIPLAY_WORKER_TOKEN=//p' "$ENV_FILE" | head -n 1)"
if ! curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/health >/dev/null 2>&1; then
  nohup "$RUNTIME/current/bin/node" --env-file="$ENV_FILE" "$ROOT/worker/runpod-worker.js" \
    > "$STATE/worker.log" 2>&1 &
fi

echo
echo "AIPLAY worker installed. The restart hook is in: $HOOK"
echo "Worker URL: https://${RUNPOD_POD_ID:-YOUR_POD_ID}-8787.proxy.runpod.net"
echo "Worker token: $TOKEN"
echo
echo "Copy the URL and token into AIPLAY Studio > RunPod connection. Keep the token private."
