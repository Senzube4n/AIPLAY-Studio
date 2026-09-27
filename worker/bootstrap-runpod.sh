#!/usr/bin/env bash
set -euo pipefail

# Install the AIPLAY worker beside the official RunPod ComfyUI template.
# This script is idempotent: it preserves the worker token and only fast-forwards
# an existing source checkout. Model weights are deliberately not downloaded.

ROOT="${AIPLAY_WORKER_SOURCE:-/workspace/aiplay-worker-src}"
STATE="${AIPLAY_WORKER_STATE:-/workspace/aiplay-worker}"
RUNTIME="${AIPLAY_RUNTIME:-/workspace/aiplay-runtime}"
REPO="${AIPLAY_REPOSITORY:-https://github.com/bani4kaskashka/AIPLAY-Studio-Bucky-Fork.git}"
BRANCH="${AIPLAY_BRANCH:-main}"

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

if [[ -d "$ROOT/.git" ]]; then
  if [[ "$(git -C "$ROOT" remote get-url origin)" != "$REPO" ]]; then
    echo "$ROOT has a different Git origin. Review it and set AIPLAY_REPOSITORY explicitly or move that checkout aside before retrying." >&2
    exit 1
  fi
  git -C "$ROOT" fetch --depth 1 origin "$BRANCH"
  git -C "$ROOT" merge --ff-only FETCH_HEAD
elif [[ -e "$ROOT" ]]; then
  echo "$ROOT exists but is not an AIPLAY Git checkout; move it aside and retry." >&2
  exit 1
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$ROOT"
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
AIPLAY_WORKER_COMFY_URL=http://127.0.0.1:8188
AIPLAY_WORKER_STATE=$STATE
AIPLAY_WORKER_PORT=8787
EOF
fi
chmod 600 "$ENV_FILE"

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
