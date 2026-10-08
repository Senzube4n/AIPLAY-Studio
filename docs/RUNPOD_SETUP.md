# RunPod rendering preview

AIPLAY runs on your Windows PC. A small authenticated worker beside ComfyUI on a dedicated RunPod Pod executes workflows. Results are downloaded, SHA-256 checked, and placed in your local library. Your PC needs Node.js for AIPLAY's backend; it does not need CUDA or local model weights for this remote panel.

This is a source-level preview, not a signed Windows installer. RunPod is available as a render target in the normal Images and Video screens, and the advanced workflow panel remains available for inspecting or importing graphs. The integration has automated coverage. The complete image path was validated on 24 September 2026 with a RunPod RTX PRO 4500 Blackwell, ComfyUI 0.30.0 and the SD 1.5 checkpoint. The complete video path was validated on 25 September 2026 with ComfyUI 0.37.0 and the official LTX 2.5 distilled model bundle. Connect, inventory, render, hash-checked download and local-library adoption passed in both cases. Music still requires its exact model bundle and compatible ComfyUI nodes to be installed and tested on the Pod.

## Start on Windows

In the launcher, press **Launch RunPod GPU**. It starts the full local interface without a local ComfyUI; the same mode from a terminal is:

```powershell
npm ci --omit=dev
npm run start:remote
```

In this mode the Images and Video screens render on the Pod: each shows a RunPod box (model on the Pod, remote size, **Connection…**) above the prompt. Full Studio, Music only and Comfy API show none of it, and /api/runpod answers only in this mode, because a Pod bills by the hour. The Images path renders standard ComfyUI checkpoints installed on the Pod. The Video path uses the installed LTX 2.5 distilled bundle for text-to-video. **Advanced workflow panel** in the connection window opens the graph panel (`/runpod.html`). Native GGUF music, image references, video frames/references/soundtracks, mesh tools, compositor processing and final timeline export have not been connected to the integrated presets. Local editing/export tools can still have their own CPU, media-tool or Python requirements.

## Prepare one dedicated Pod

Choose a ComfyUI environment and GPU for one specific first workflow. A model-specific API such as Seedance includes its model deployment; a rented GPU does not. Confirm current compute and storage prices in the RunPod console before deploying. The Pod wizard can create a paid Pod, but does not enforce a dollar budget or stop idle GPUs.

1. Keep ComfyUI, model weights, its `input`/`output` folders, and worker state on persistent storage. A network volume can outlive the Pod, but has separate storage charges and placement constraints. See [RunPod storage options](https://docs.runpod.io/pods/storage/types) and [network volumes](https://docs.runpod.io/storage/network-volumes).
2. Install the selected models/custom nodes and prove a small workflow directly in that ComfyUI installation first. Start with a standard SD/SDXL checkpoint image to test transport cheaply. For video/music, install the exact files and nodes referenced by the chosen graph. The remote model list and graph validation report missing names; they do not install models or prove GPU memory is sufficient.
3. Keep ComfyUI on the Pod's loopback interface, normally `127.0.0.1:8188`. Use the template's Python environment, for example `python main.py --listen 127.0.0.1 --port 8188`. Configure the template so exactly one ComfyUI runs on the Pod. The worker input/output directories must match ComfyUI's actual directories. RunPod's current ComfyUI template uses `/workspace/runpod-slim/ComfyUI`; check the live Pod instead of assuming `/workspace/ComfyUI`.
4. Install Node.js 22 or newer in the Pod. The bootstrap below fetches the exact commit the Studio you connect from runs, never a branch that moves, and starts nothing unless the checkout is that commit. The gateway itself uses only Node built-ins: no `npm install` is required on the Pod. It needs more of the checkout than the worker file: `worker/runpod-worker.js`, `worker/model-manager.js`, `worker/check-comfy-loopback.js`, `server/engine/remote-common.js`, `server/safety/graph.js`, `server/safety/minors.js`, `server/pngtext.js` and a root `package.json` with `"type": "module"`. Use the bootstrap command: a worker set up by hand from a shorter list fails on its imports, and is not pinned to your Studio's commit.
5. Expose only worker HTTP port **8787** for rendering. Keep raw ComfyUI port 8188 private. RunPod provides an HTTPS proxy such as `https://POD_ID-8787.proxy.runpod.net`; use the actual URL from the Pod's Connect panel. Public proxy services require their own authentication, and the proxy has a 100-second response timeout. The worker returns job IDs quickly and is polled separately. [RunPod port documentation](https://docs.runpod.io/pods/configuration/expose-ports).

On the Pod, generate a worker secret once and save it outside the source checkout:

```bash
mkdir -p /workspace/aiplay-worker
chmod 700 /workspace/aiplay-worker
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync("/workspace/aiplay-worker/worker.env", "AIPLAY_WORKER_TOKEN=" + randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });'
```

The exclusive write refuses to overwrite an existing token. Retrieve its value privately for the local connection form. This secret is **not your RunPod account API key**. Do not commit or share it.

Add the Pod-specific paths to the same private environment file:

```bash
cat >> /workspace/aiplay-worker/worker.env <<'EOF'
AIPLAY_COMFY_DIR=/workspace/runpod-slim/ComfyUI
AIPLAY_WORKER_COMFY_URL=http://127.0.0.1:8188
AIPLAY_WORKER_STATE=/workspace/aiplay-worker
AIPLAY_WORKER_PORT=8787
EOF
```

From the copied checkout, start the gateway with the same Node runtime:

```bash
node --env-file=/workspace/aiplay-worker/worker.env worker/runpod-worker.js
```

Set this command up under the Pod template's startup supervisor for actual use, so it starts again on restart and does not depend on a browser terminal staying connected. Some RunPod ComfyUI images keep `/start.sh` as their entry point and pass a configured container command to it as an unused argument. For those images, install the included restart hook on the persistent ComfyUI volume:

```bash
mkdir -p /workspace/runpod-slim/ComfyUI/custom_nodes/aiplay_worker_autostart
cp /workspace/aiplay-worker-src/worker/comfyui-autostart/__init__.py \
  /workspace/runpod-slim/ComfyUI/custom_nodes/aiplay_worker_autostart/__init__.py
python -m py_compile /workspace/runpod-slim/ComfyUI/custom_nodes/aiplay_worker_autostart/__init__.py
```

The hook starts one worker when ComfyUI imports custom nodes and writes its log to `/workspace/aiplay-worker/worker.log`. Supervise ComfyUI separately. Do not run two worker processes against the same state directory.

| Environment variable | Default / purpose |
| --- | --- |
| `AIPLAY_WORKER_TOKEN` | Required, at least 32 characters; use a random secret |
| `AIPLAY_COMFY_DIR` | `/workspace/ComfyUI` |
| `AIPLAY_WORKER_COMFY_URL` | `http://127.0.0.1:8188`; loopback only |
| `AIPLAY_WORKER_INPUT` | ComfyUI's `input` folder |
| `AIPLAY_WORKER_OUTPUT` | ComfyUI's `output` folder |
| `AIPLAY_WORKER_STATE` | `/workspace/aiplay-worker`; retain across restarts |
| `AIPLAY_WORKER_PORT` | `8787`; gateway listens on all interfaces |

## Connect and render

On Images or Video, choose **RunPod GPU**, open **Connection…**, and enter the worker HTTPS URL and token. The local backend stores the token through AIPLAY's existing secret store; it is never returned by the status API or placed in browser storage. Connect checks worker identity, ComfyUI readiness and its model/node inventory.

The same window has **Create or manage a RunPod Pod**. Add a restricted RunPod API key with permission to read GPU inventory and manage Pods. AIPLAY stores that key in the same local secret store and never returns it to the page after saving. It can then show the account balance, current hourly spend, existing Pods, live GPU stock/price estimates, and start/stop controls. See RunPod's [API-key guidance](https://docs.runpod.io/get-started/api-keys) and [Pod GraphQL operations](https://docs.runpod.io/sdks/graphql/manage-pods).

Press **Create private templates** to add four reusable Pod templates to that RunPod account. The operation is idempotent and does not start a GPU. Existing templates with the same names are left unchanged.

| Template | Persistent disk | Suggested GPU | Intended workload |
| --- | ---: | --- | --- |
| AIPLAY Images | 60 GB | 16 GB VRAM or more | ComfyUI checkpoints and image output |
| AIPLAY Video | 120 GB | 32 GB VRAM or more | LTX 2.5 nodes, weights and clips |
| AIPLAY Audio | 100 GB | 24 GB VRAM or more | YuE2, ACE-Step or MiniMax Music |
| AIPLAY Music LoRA Training | 120 GB | 24 GB VRAM recommended | ACE-Step 1.5 datasets, checkpoints and LoRA output |

The rendering templates are private, use the NVIDIA ComfyUI CUDA 13 image, mount persistent storage at `/workspace`, and expose only authenticated worker port 8787. Raw ComfyUI must listen on loopback. They save the deployment shape, not licensed model weights. After the first deployment, run the worker bootstrap and install only the model bundles whose terms you accepted. Selecting a template and pressing RunPod's deploy button is a separate paid action.

The connection panel can install the pinned YuE2 ComfyUI bundle after its repository terms are accepted. Downloads continue on the worker, resume partial files, and verify the exact size and SHA-256 before adoption. The MCP equivalents are `runpod_setup_status`, `runpod_install_bundle` and `runpod_cancel_install`; private presets use `runpod_templates` and `runpod_create_templates`.

The **AIPLAY Music LoRA Training** preset uses RunPod's Python 3.11 PyTorch image and exposes JupyterLab on port 8888, the ACE-Step interface on port 7860 and TensorBoard on port 6006. Its RunPod README pins the official ACE-Step 1.5 source revision and contains the installation commands. ACE-Step's LoRA Training tab handles annotation, preprocessing and training. The publisher documents a small personal example starting with eight songs and about 12 GB VRAM; larger datasets need more GPU memory, storage and time. Keep the source audio and training output under `/workspace` so they survive restarts. Use only recordings you have permission to train on. See the [official ACE-Step repository](https://github.com/ace-step/ACE-Step-1.5) and [LoRA training guide](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/LoRA_Training_Guide.md).

Creating a Pod is a reviewed paid action: choose the GPU, cloud tier and persistent disk, review the current estimated GPU hourly price, and explicitly acknowledge that billing begins before the create button is enabled. The current wizard creates the standard `runpod/comfyui:cuda12.8` image with only worker HTTP port 8787 exposed. Storage is billed separately and may continue after compute is stopped.

The MCP surface exposes the same local worker, account, workflow, job and Pod
routes (see [MCP workflow control](MCP_WORKFLOWS.md)). MCP Pod creation requires
`CREATE PAID POD`; starting a stopped Pod requires `START PAID POD` after the
hourly price is reviewed. The server checks both phrases, including for raw
HTTP callers. The MCP asset uploader accepts absolute local reference paths up
to **64 MiB** per file so the MCP process does not buffer the browser route's
512 MiB maximum. Its result is an asset name for a job's node/input binding;
workflow preview itself never starts a render.

Use a Pod terminal or SSH session from the RunPod Connect panel to run the bootstrap command shown in the setup window. The Studio builds that command from its own repository and full commit, with the script's sha256, which the Pod checks before running it. A Studio that cannot name its commit (no git checkout and no `install-info.json` from Setup.exe) shows no command, and a commit that is not on GitHub yet cannot be fetched by the Pod. A Pod set up with an earlier command keeps its old worker until the new command is run there. It installs Node.js and the AIPLAY worker under `/workspace`, checks that ComfyUI actually listens on `127.0.0.1:8188` and no public address, creates a private worker token, adds a ComfyUI restart hook, starts the worker, and prints the connection URL and token. If the check fails, restart ComfyUI with `--listen 127.0.0.1 --port 8188` and rerun the bootstrap. The script is safe to run again and preserves the token. Model files are still a separate step because their licenses, access gates, size and required nodes vary by model.

For a first image, select the checkpoint shown under **Model on the Pod**, keep the default remote CFG 6, choose a small size and render. For a first video, keep **512 × 320 · cheapest test**, use a short duration, and render. Results appear in the normal Images or Clips library after their hashes are verified and the files are downloaded to the PC. The normal render buttons resume an active matching remote job after a page reload.

For custom graphs, open the advanced RunPod panel, select a template and model, enter the prompt, and build the graph. Review the editable workflow before rendering. You can instead import a ComfyUI **API-format** workflow; the canvas-format JSON is not accepted. Templates inherit AIPLAY defaults and may need model filenames edited to match the Pod.

For reference media, expand Add reference files and choose the graph node and input that should receive each file. The local file is uploaded and that input is replaced with a Pod-relative path. Merely importing a workflow that contains a Windows filename does not upload that file.

Render records the request locally before dispatching. Jobs show queued/running/downloading and final status. Image and video results are adopted into AIPLAY's local image/clip folders; supported audio goes into its local music library. Other supported output files remain downloadable from the job. Returning to the main studio may be needed to refresh a library view.

The worker and ComfyUI must stay running for the render to progress. Closing the PC UI does not stop the GPU job or Pod billing. Reopening AIPLAY resumes polling and downloads with the original job ID. Confirm that files are on the PC before terminating or removing remote storage. Manage compute and storage in the [RunPod console](https://console.runpod.io/).

## Recovery and limits

- Both sides persist job state. Retrying a lost desktop submission response uses the same UUID. A lost ComfyUI response is reconciled against its queue/history; it is never automatically rendered again. An **uncertain** result requires checking ComfyUI before creating another job.
- Keep the same worker state directory and URL for recovery. While a job is active, you can refresh its token, but cannot switch to another worker. Recreating a Pod at a new URL while local jobs are active currently requires manual recovery; this preview does not migrate outstanding jobs between endpoints.
- Cancellation targets one job. A ComfyUI version without targeted running-job cancellation will return an error; the worker deliberately does not send a global interrupt. A queued job can be withdrawn without stopping others. Inspect the Pod if cancellation fails.
- Files are limited to 512 MiB each, workflows to 2 MiB / 500 nodes, input bindings to 30, and the worker queue to 20 active jobs. Actual proxy transfer limits may be lower. Transfers restart from the beginning after interruption; large or slow transfers may need an SSH tunnel or a future object-storage transport.
- Outputs use a frozen size/hash manifest. Keep remote files until local download succeeds. A job lists at most 64 outputs and 2 GiB in all, and a worker answer is read up to 2 MiB (64 MiB for the model list); a job past those fails with the reason and downloads nothing. A render made with **Don't record the prompt** leaves no words on the Pod: the worker drops its graph once ComfyUI has accepted it, strips ComfyUI's text chunks from its PNGs before hashing them, and deletes its outputs and ComfyUI's history entry once the Studio has its verified copies. Other renders have no automated cleanup or retention expiry yet: monitor disk usage. Restart recovery is tested; hard power-loss durability and every third-party save node are not certified.
- No live progress percentage, automatic model installer, automatic Pod lifecycle control, multi-tenant isolation, or remote timeline/export support is included. This is a personal, dedicated worker: treat its bearer token as full access to its ComfyUI environment.

## Verify without cloud charges

```powershell
npm run test:remote
```

The integration tests use temporary directories and local mock HTTP services for authentication, model validation, uploads, download verification, submission loss, restart recovery, provenance and scoped cancellation.

For a browser demonstration, run `node scripts/mock-runpod.mjs` in one terminal. It prints a public test token and listens only on `http://127.0.0.1:8788`. In a second terminal:

```powershell
$env:AIPLAY_APPDATA = Join-Path $env:TEMP 'aiplay-runpod-demo'
$env:AIPLAY_UI_PORT = '4184'
npm run start:remote
```

Open port 4184's RunPod panel, connect the printed mock URL/token, select `MOCK-NO-GPU.safetensors`, build an image graph and render. The result is a tiny fixture PNG, not AI-generated media. Keep this demo's app-data separate from your real studio, and close both processes afterward.

## Live acceptance status

The first image acceptance test passed on 24 September 2026. A 512 x 512 SD 1.5 job completed remotely in about 26 seconds, returned both its full image and thumbnail, passed the declared byte-count and SHA-256 checks, and was adopted into the local AIPLAY image library.

The first video acceptance test passed on 25 September 2026. A 512 x 320, 25-frame LTX 2.5 job completed remotely in 172 seconds after the initial model load. It produced a 24 fps H.264/AAC MP4 lasting 1.042 seconds. The local download matched the worker's 370,008-byte size and SHA-256 digest and was adopted into the AIPLAY clip library. The tested worker reported an RTX PRO 4500 Blackwell with 32,623 MiB VRAM and ComfyUI 0.37.0. AIPLAY accepts both legacy ComfyUI model-choice lists and the newer `COMBO` input schema used by this version.

H3's licence excludes use in the EU and several other territories. LTX 2.5 is the suitable built-in route for this EU deployment, but its repository is access-gated and its model bundle is about 40 GB. Accept its publisher licence and provide Hugging Face access before downloading it, then verify that the Pod's ComfyUI version exposes every node in the generated LTX graph.
