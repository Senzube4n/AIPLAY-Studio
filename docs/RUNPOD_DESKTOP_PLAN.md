# AIPLAY on Windows with RunPod rendering

Research date: 2026-09-22. Updated 2026-09-25: the remote rendering preview is implemented (contributed by nemesisone-dev on `feature/runpod-rendering`), as the launcher's RunPod GPU mode, where the Images and Video screens render on the Pod. See [setup and current limitations](RUNPOD_SETUP.md). Image and LTX 2.5 video paths have passed live GPU acceptance tests; signed desktop packaging remains future work.

## Intended experience

Run AIPLAY on a Windows PC, with a desktop interface and remote generation. Edit projects, browse the library, preview media, and manage jobs locally. Send expensive generation jobs to RunPod and automatically save the results back into the local project.

A hosted model API already provides an engine and models. A dedicated RunPod GPU needs a deployed engine, its dependencies, and its model files before AIPLAY can submit work.

RunPod would execute the generation software beside its GPU. It would not appear as another graphics card installed in Windows. Prompts and required input media travel to the worker; model weights remain on remote storage; outputs return to the PC. Local playback, interface drawing, and editing still use the PC's CPU and graphics capabilities.

```text
Windows PC                              RunPod Pod
----------                              ----------
Desktop window / existing web UI
         |
Local AIPLAY Node.js backend  --HTTPS-->  Authenticated render service
Projects, queue, credentials             ComfyUI + custom nodes
Local asset library          <--files--  Models + GPU + job storage
```

## Recommendation

Start with one dedicated RunPod Pod running a versioned AIPLAY-compatible ComfyUI environment. Keep its model weights and recoverable results on a network volume. Use an authenticated HTTPS service that supports short requests, job IDs, status polling, and file transfer. Keep the service running independently of the desktop connection.

This is an engineering recommendation based on AIPLAY's current architecture, not a claim that this checkout already supports remote execution. AIPLAY currently relies on a long-lived ComfyUI process and its cache (`server/comfy.js`). A persistent Pod preserves that execution pattern during a session.

| RunPod option | Fit for AIPLAY | Tradeoff |
| --- | --- | --- |
| Dedicated Pod | Recommended first implementation; broad ComfyUI workflow support and a persistent process | Compute is charged while the Pod is running, including idle periods; lifecycle controls are needed |
| Queue-based Serverless | Suitable for individually packaged image, music, or video jobs | New submit/status/result adapter, worker packaging, cold starts, and durable artifact storage |
| Flash | Useful for developing remote Python functions | Does not automatically redirect existing Node.js/ComfyUI calls; local Flash development on Windows uses WSL2 |
| Public model endpoints | Useful for specific hosted models | Available provider models and parameters determine functionality; not a replacement for every AIPLAY workflow |

RunPod documents [Pod lifecycle controls](https://docs.runpod.io/pods/manage-pods), [Serverless job requests](https://docs.runpod.io/serverless/endpoints/send-requests), [Flash](https://docs.runpod.io/flash/overview), and [public endpoints](https://docs.runpod.io/public-endpoints/overview). Flash's Windows development requirement is documented [here](https://docs.runpod.io/flash/windows-wsl2); a Windows app making ordinary HTTPS calls does not need Flash or WSL2 for that connection.

## What can move to RunPod

These are feasibility assessments, not verified support claims for a deployed worker.

| AIPLAY function | Proposed placement | Work required |
| --- | --- | --- |
| Interface, projects, library, timeline editing, playback | PC | Preserve local operation when disconnected |
| ComfyUI image, cover, video, and music generation | RunPod GPU | Remote engine adapter, matching models/nodes, input transfer, output retrieval |
| ComfyUI audio conversions and other utility graphs | RunPod initially | Use the same transfer and job path, even when the operation needs little GPU |
| Native YuE2 / GGUF generation | Separate remote worker capability | Compatible Linux runtime/container and an adapter for the current subprocess path; validate independently |
| Image-to-3D and rigging | Separate remote worker capability | Separate dependency environments, model availability, and file transfer |
| Final timeline export | Optional remote render job | Package source assets and timeline, translate paths, run the offline renderer, return the movie |
| VFX compositor | Local previews initially; optional remote final export | Package compositions, nested assets, fonts and render settings; much compositing is CPU work |
| DAW playback and interactive mixing | PC | Keep low-latency interaction local; assess offline processing separately |

Evidence: `server/jobs.js` has separate ComfyUI and native music execution paths; `server/music/yue-gguf.js` invokes a native runtime; `server/mesh/runner.js` manages separate Python environments. `web/studio.js` includes browser MediaRecorder export, while `scripts/timeline_render.py` provides an offline FFmpeg path with NVENC and CPU fallback. `server/vfx/engine.py` composites with NumPy/Pillow/OpenCV/PyAV and can use NVENC for video encoding. A GPU upgrade does not automatically accelerate its CPU effects. Remote execution and GPU acceleration must be evaluated separately.

## Changes required in this checkout

1. **Make engine location an explicit setting.** Extend `server/config.js` with local/remote selection and remote connection settings. Keep access credentials in `server/secrets.js`, outside browser settings and logs.
2. **Separate connection from process ownership.** `server/engine/client.js` builds loopback HTTP/WebSocket URLs and requires `isOurs()` before dispatch. Preserve that rule for local engines. Introduce authenticated remote identity and capability checks for a remote engine; do not simply remove ownership checks globally.
3. **Separate local launch from remote readiness.** `server/comfy.js`, startup in `server/index.js`, and `launcher/launcher.mjs` currently expect a local engine. Remote mode must open the app without requiring local ComfyUI, CUDA, or model weights. Local editing/export tools may still need a lightweight Python/media runtime.
4. **Centralize asset transfer.** Replace shared-folder assumptions with stage-input and fetch-output operations. Callers include `server/art.js`, `server/jobs.js`, `server/exportAudio.js`, and reference preprocessing. Support audio, video, images, masks, latents, and sidecar files where required. Windows paths must not be sent as usable paths to the Linux worker.
5. **Make model and hardware checks remote-aware.** `server/models.js`, `server/modelpick.js`, `server/localmodels.js`, `server/fit.js`, and checks in `server/index.js` use local files or hardware. In remote mode, readiness must come from the selected worker. Local GPU memory must not reject an otherwise valid cloud job.
6. **Package the actual workflows.** The remote image must contain the required ComfyUI version, Python/CUDA dependencies, AIPLAY's `server/comfy_nodes/`, third-party nodes used by the selected workflows, and a model manifest. A generic ComfyUI template does not establish compatibility with this app.
7. **Persist remote job state.** Record the desktop job ID, remote ID, endpoint identity, workflow/model versions, inputs, progress, and artifact manifest. Resume polling after reconnect or desktop restart. An uncertain submission must be reconciled before retrying to avoid duplicate paid jobs.
8. **Preserve provenance and cancellation.** Retain the existing record-before-submit behavior. Mark success only after required artifacts have downloaded and been adopted locally. Scope cancellation to the selected job, with remote capability checks; do not clear an entire remote queue as a substitute.
9. **Add desktop packaging after the remote path works.** A Tauri shell can host the existing interface and launch a bundled Node.js backend. Node.js remains an internal app component. Rewriting the application backend into Rust is not necessary for a native desktop experience.

## Proposed worker contract

Use a small, versioned API in front of the engine so AIPLAY can support multiple render paths without exposing local filesystem assumptions. Endpoint names below are proposed, not existing RunPod APIs.

- `GET /health` and `GET /capabilities`: worker version, engine versions, GPU, supported task types, installed model/node inventory.
- Asset upload and lookup: content hashes, validated media types, size limits, and worker-owned relative asset IDs. Cache unchanged references to avoid uploading them again for every take.
- `POST /jobs`: validated task specification plus an idempotency key; return promptly with a durable job ID.
- `GET /jobs/{id}`: queued/running/completed/failed/cancelled state, progress, error details, and output manifest.
- Job-specific cancellation and artifact download operations.
- Outputs saved atomically with sizes and hashes, retained until local download is acknowledged or an explicit retention policy expires.

For ComfyUI, the service can adapt the existing `/prompt`, `/history/{prompt_id}`, `/queue`, `/object_info`, `/system_stats`, and `/ws` APIs. Its documented image upload route is not enough evidence for every audio/video/latent transfer this app needs; validate those types against the pinned engine or implement dedicated staging. See [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes).

The desktop needs only outbound connections. Polling avoids requiring a public webhook receiver on the PC. A remote job can continue after disconnection if the worker persists it; that behavior has to be implemented and tested rather than assumed.

## RunPod details that affect implementation

- **Networking:** the Pod HTTP proxy uses HTTPS, exposes the service publicly, and documents a 100-second response timeout. Add application authentication and use submit/poll requests rather than one request waiting for a long render. WebSocket reconnects and polling fallback are needed. The RunPod account API key used for managing Pods is separate from authentication of our Pod service. [Port documentation](https://docs.runpod.io/pods/configuration/expose-ports).
- **Alternative transport:** full SSH via a public IP supports SCP/SFTP; RunPod's basic proxied SSH does not. Full SSH could be used for development/file transfer, with tunnel support validated on the chosen setup. A tunnel alone does not resolve AIPLAY's process-ownership and shared-disk assumptions. [SSH documentation](https://docs.runpod.io/pods/configuration/use-ssh).
- **Storage:** network volumes outlive the compute instance and can hold weights and results. Pod network volumes are documented for Secure Cloud and have placement constraints. Keep the PC library as the user's durable working copy. [Network volumes](https://docs.runpod.io/storage/network-volumes).
- **Lifecycle:** stopping releases the GPU; persistent storage can continue to incur charges. Restart depends on GPU availability. Automatically stopping should happen only after the queue is clear and required output persistence is confirmed. Re-check lifecycle support for the selected Pod/storage configuration during deployment. [Manage Pods](https://docs.runpod.io/pods/manage-pods).
- **Serverless:** `/run` returns a job ID, with `/status` for retrieval and `/cancel` for cancellation. Documentation lists 30-minute retention for asynchronous results and a default 10-minute execution timeout. Long video jobs need explicit timeout policy and durable file storage, especially if the PC may be offline. [Request documentation](https://docs.runpod.io/serverless/endpoints/send-requests).
- **ComfyUI Serverless worker:** the official worker documents workflow JSON plus image inputs and image outputs, optionally in S3. Do not assume its published image contract already handles every AIPLAY audio/video/latent output. Extend or verify the worker for each supported task. [Official worker repository](https://github.com/runpod-workers/worker-comfyui).

## GPU and cost selection

Select hardware only after choosing the first model/workflow and target resolution/duration. Compare a 24 GB GPU and a 48 GB GPU as candidates, then measure peak memory, execution time, and complete job cost. Neither capacity is a guarantee for all AIPLAY workflows. Confirm NVENC functionality in the actual container if remote exports are included.

Estimate total cost from Pod running time, storage, startup/model loading, and retries. Keep GPU allocation and stop controls visible in the desktop. Set a session time/budget policy before adding unattended batches. Consult [current RunPod pricing](https://www.runpod.io/pricing) when choosing the instance; no fixed price or performance promise is made here.

## Implementation sequence and acceptance checks

1. Build the remote interface and file transfer path against a local mock worker. Validate remote configuration, authentication errors, unavailable engines/models, upload/download failures, job-scoped cancellation, and duplicate-submit prevention without cloud charges.
2. Package a minimal worker for one existing image workflow. On a live Pod, prove input upload, remote generation, progress, cancellation, local result adoption, and provenance. Confirm the PC did not start a local generation engine.
3. Add one short video workflow and one ComfyUI music workflow. Validate the exact models, nodes, media transfers, memory usage, timings, and result formats before claiming support.
4. Exercise reconnect after app restart, interrupted downloads, expired credentials, Pod restart, worker failure, and unavailable GPU capacity. Verify a disconnected PC can later retrieve a completed result within the configured retention policy.
5. Add desktop connection controls, worker status, model readiness, queue display, and cost/lifecycle controls. Package the app as a Windows desktop window with its backend runtime included.
6. Extend remote coverage to native music, mesh tools, and final exports as separately tested worker capabilities. Keep the interface local throughout.

The first useful milestone is the existing local AIPLAY interface generating an asset on RunPod and automatically placing it in the local library. Desktop wrapping and additional render engines can then build on that verified path.
