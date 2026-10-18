# Cloud Computer

Open **RunPod GPU** in the launcher, then **Settings → No strong graphics card? → RunPod GPU**.

**Easy Cloud Setup** shows one required step at a time:

1. **Account:** open RunPod Credentials → API Keys, create a restricted account key and connect it in AIPLAY.
2. **Computer:** select an existing computer or press **Create cloud computer**. Choose a graphics card and saved storage, then **Review price**. Available cards of at least 32 GB are suggested for picture/video workflows; exact model requirements vary. Extra naming/provider options stay collapsed. Creation needs the billing checkbox and **Create and start computer**.
3. **AI:** review the start price, connect using the installed AIPLAY service's connection code, and select models if needed. The address is filled from the selected computer.
4. **Automatic stop:** save a separate remote stop key, or explicitly confirm keeping rental running after AIPLAY closes.

The guide reuses the existing vault-backed fields. It verifies account/computer/worker/model readiness before advancing and remembers completed setup for that computer. Stopping compute preserves the completed setup; a subsequent worker failure or invalid account returns to the affected step. The Cloud Computer dashboard appears after selection. Manual provider controls remain under **Advanced setup**.

**Advanced setup** is always available above the guided steps for manual connection and AI-service installation controls. **Back to guided setup** returns to the same step and keeps entered details. Opening either view performs no rental or provisioning action.

Creation reuses the existing account client, vault and persistent creation journal. Review refreshes the GPU catalogue, expires after five minutes, and is invalidated by any changed choice. The server rechecks the estimated rate and availability before provisioning. A successful creation selects its returned resource ID and advances to AI setup. Failed or uncertain creation consumes approval and requires a new review; existing resources must be checked before retrying. Storage figures use RunPod's [published estimates](https://docs.runpod.io/pods/pricing), checked October 17, 2026, including the 20 GB temporary disk while running. They are not provider-enforced spending caps.

New computers offer **Install AI automatically**. This uses REST v2 creation, a checked, published installer from this installation's approved repository and exact commit, and a separate generated worker connection code. The account key stays on the desktop. Rental runs during setup. Existing computers retain the manual connection/update path; they are never replaced or repurposed automatically. Key creation follows [RunPod's current Credentials guide](https://docs.runpod.io/get-started/credentials).

Automatic installation starts a pinned ComfyUI checkout on loopback inside the provider's versioned PyTorch image, installs dependencies into a persistent environment, then starts the authenticated AIPLAY service on port 8787. The desktop shows authenticated stages and checks Pod identity, worker commit and runtime health before saving the connection in its vault. No raw ComfyUI, SSH or Jupyter port is exposed. No container registry account is required. Host code is in `worker/automatic-runpod.py`; local orchestration is in `server/engine/runpod-install.js`.

Before starting ComfyUI, automatic installation also reuses Studio's normal first-party custom-node deployment. This includes the YuE2 score and continuation nodes used by its music workflows. Optional third-party nodes remain off unless requested by their existing switches; models and unrelated custom nodes are preserved.

The `automatic-install.json` journal contains resource IDs and progress, never tokens. Creation is recorded before its single provider POST. Lost replies and desktop restarts reconcile existing resources by their unique approved name; they never repeat the POST. Pending automatic creation also blocks manual creation. A changed price, unpublished installer, mismatched script checksum, active generation or duplicate name blocks creation. Install status reads are capped; failures stay visible and do not trigger restart, termination, cleanup or new resources. Computing may continue to be billed after a failed installation. Use the existing shutdown controls where storage can be verified, or review the computer in RunPod. Do not assume an absent worker means computing has stopped.

After connection, choose verified **YuE2 music**, **SDXL Turbo pictures**, or **LTX 2.5 video** bundles. Every file has a pinned Hugging Face revision, exact length and SHA-256 checksum; downloads resume on the worker even when the desktop closes. Each bundle requires explicit model-terms approval. LTX additionally requires model-page access approval and a Hugging Face read token entered in the model row; this token is used only for that download, never returned in status or saved in the journal. Automatic stop still requires the separately approved remote stop key in Step 4; an installing computer is not claimed to be protected before that policy is verified.

Validation: offline service tests cover idempotency, restart reconciliation, changed prices, source publication/checksum refusal, active-work refusal, identity mismatch and credential projection; startup tests cover source validation and preservation; model tests cover checksums, resume, gated access and token redaction. Real GPU acceptance of the new automatic path remains pending explicit deployment authorization and a spend/runtime allowance. No billable resources were modified during implementation.

The computer and AI readiness have separate indicators. A running computer can still need a worker connection or model installation. Rental charges can accrue during setup.

## First connection

In **Easy Cloud Setup → Account**, save your own RunPod account key. The new manager validates it using REST v2 and stores it in Studio's existing credential vault. The key needs `pods:read`, `pods:write`, `catalog:read`, and, for the corresponding optional controls, `billing:read`, `volumes:read`, and `volumes:write`.

Select an existing computer or create one in Step 2. Studio first matches the saved worker connection; otherwise it selects a single computer named AIPLAY. Multiple candidates require your selection. The lifecycle manager continues to manage existing resources; Step 2 uses the account client's creation path.

In the **AI** step, connect its worker using the address and connection code (worker token). Existing stopped computers retain their saved connection for the next start. The worker must support Cloud Manager version 1, identify the selected RunPod computer, and keep ComfyUI on loopback. Generation readiness additionally checks the installed model catalogue; an actual GPU render is still required to validate the chosen workflow and hardware.

## Starting and stopping

**Start Cloud Computer** checks the current resource, permitted actions, GPU availability and rental price. A price review asks for approval before starting rental. A changed price or storage configuration requires a new review. The computer is then checked until its AI worker is available.

Saved queued work resumes after the approved start once the worker and model catalogue are ready. If models need installation, queued recipes stay saved and paused; the panel shows that generation needs setup.

**Stop Cloud Computer** finishes storage checks and stops idle compute. When work is active, choose **Stop After Current Job**, or explicitly confirm **Stop Now** to cancel managed work. Stop After Current Job lets current work finish and saves future queued recipes for the next approved start. New work is refused while stopping. Work already submitted to ComfyUI finishes before shutdown. This option needs the remote stop credential so it can complete after the desktop closes.

Normal shutdown verifies the persistent filesystem, output manifests and pending transfers, flushes saved data, and requests the provider's `stop` action. Only a subsequent provider state check can display **Compute stopped**. Stopping retains the computer and its persistent storage; the manager never terminates a computer or deletes a volume.

Uncertain start/stop/capacity responses remain attached to the same resource and operation ID. **Check again** reconciles their results rather than repeating a mutation or creating a replacement. An unresolved response can keep controls locked until the provider reports its outcome; technical diagnostics identify the operation for manual provider review. A definitely rejected remote stop can be retried after you explicitly repair its stop credential.

If a GPU cannot be allocated, keep the computer and check later. Review backup options before planning a move. Host-local disks are tied to the existing host; an unavailable host may prevent file export until it recovers. Network storage has different portability and backup options. No automatic recovery path terminates a resource.

## Automatic stop

Choose 15, 30 (recommended), 60 minutes, or Disabled. A preference saved while stopped applies at the next start. The 30-minute default is a recommendation; shutdown is not armed until its remote credential has been configured.

While the computer is running, expand **Automatic stop setup**. Save a separate restricted RunPod key with Pods read/write permissions and approve storing it on this computer. The worker stores it under its persistent state directory in a `0700` directory and `0600` file, matching Studio's Linux file-permission protection. It is never returned to the browser or included in an export. The account key in the desktop vault is not silently copied to the worker. The dedicated key's provider permissions may cover other account Pods, even though this worker's code only permits stopping its own bound computer.

The remote watchdog runs independently of desktop/browser connectivity. It protects ComfyUI running/pending jobs, durable unresolved worker jobs, managed training and the ACE-Step training status, curated downloads, request processing, artifact transfers and the bootstrap maintenance lock. A 90-second desktop workload lease protects local queue/preparation activity; ordinary UI navigation does not renew it. If the desktop disappears, remote generation continues, then the configured idle policy or requested stop can finish safely.

Unknown workload state or unverified storage blocks shutdown. The watchdog depends on a running worker and reachable workload services; a crashed remote agent, unsupported service status, or provider outage can prevent automatic stopping. The UI shows watchdog errors separately. This is a best-effort shutdown policy, not a guaranteed billing cap.

For work launched manually outside AIPLAY's monitored services, maintain the worker's `maintenance.lock` during that work. Bootstrap updates already manage this lock. Do not leave it present after manual work ends. Use **Remove stop key** to disable the remote credential when no stop is pending; revoke its provider permissions in RunPod if the key should no longer be usable.

## Storage and spending

**Review Storage** measures the selected persistent namespace and separates models, generated content, temporary files and other saved files. Allocation comes from the provider. Filesystem backing-pool statistics are diagnostic data, not your storage quota. Scans are bounded to 100,000 entries and approximately ten seconds; partial category values are lower bounds and total usage remains unavailable. Reviews show their time.

**Safe Cleanup** presents only abandoned AIPLAY upload scratch files older than 24 hours. It requires explicit review, hashes and rechecks the manifest, and refuses changed files. It does not select weights, datasets, generated assets or general preview files. Removing files does not reduce the provider's allocated capacity or recurring storage charge.

**Manage Capacity** reviews an increase and its estimated recurring charge. The computer must be stopped, capacity can only grow, and uncertain results are reconciled without repeating the update. Supported paths are a single host-local persistent disk or standard network volume. Multiple storage resources and unsupported/global/high-performance pricing are shown as unavailable and managed through the provider, so a partial price is never presented as the total.

**Back up outputs** uses the existing verified remote download/adoption pipeline for tracked generation results. The computer must be running for worker-based review and export. Existing transport limits still apply (512 MiB per file, 64 outputs and 2 GiB per job). Other datasets, models and independently generated files use the provider's supported export tools.

Session/monthly compute estimates use observed sessions and provider rates, including the current session's reported start time. They exclude storage, taxes and unobserved rate changes. They are not complete billing records. Provider-reported monthly billing is fetched separately for the selected computer and its attached network storage. Shared volume charges are for that volume, not attributed to one generation.

Storage estimates use public rates reviewed on 14 October 2026: persistent disks are $0.10/GB/month while running and $0.20 while stopped; standard network storage uses $0.07/GB/month for the first 1,000 GB and $0.05 above that. Unknown tiers remain unavailable. Actual charges can differ. See [RunPod storage options](https://docs.runpod.io/pods/storage/types) and [network volume pricing](https://docs.runpod.io/storage/network-volumes).

Spending alerts notify in AIPLAY while it is open. They do not enforce a provider billing cap. Stopping GPU compute does not stop storage billing.

## Deploying the fork's worker build

The existing **manual** bootstrap remains pinned to the official repository and an exact published commit. It cannot install fork-only commits. New automatic creation instead uses the approved installed fork's pinned source as described above. Existing Pods can still use the reviewable source archive below with separate installation authorization.

Build the reviewable source-only archive locally:

```powershell
.\node\node.exe scripts/package-cloud-worker.mjs
```

The archive contains the worker's relative import closure, the existing autostart hook, LICENSE, a minimal module manifest, and SHA-256 file manifest. It contains no runtime, models, user data or credentials. An adjacent `.sha256` file checks the archive. Node.js 22 or newer and the existing ComfyUI installation are required.

Installation into an existing billable computer is a separate authorized action: back up the current source, verify the archive checksum and file manifest, protect the update with `maintenance.lock`, install the source into the existing worker source directory, and restart the worker with the existing protected `worker.env`. Preserve its token, state, model directories and outputs. Set `AIPLAY_CLOUD_POD_ID` to the current provider ID if the container does not supply `RUNPOD_POD_ID`; the live provider environment takes precedence. Do not overwrite credentials, terminate the Pod, replace mounts or resize storage as part of installation.

The new worker reports `cloudManagerVersion: 1` and its Pod ID on the authenticated health route. Keep that route behind the existing worker bearer token, and keep raw ComfyUI on loopback.

## Diagnostic files

- Desktop: `<appdata>/runpod/cloud-computer.json`, `paused-music-queue.json`, `creation-journal.json` and `cloud-diagnostics.jsonl`.
- Worker: `<worker-state>/cloud-policy.json`, `cloud-diagnostics.jsonl`, `cloud-secret/stop-key.json`, and the existing job/model state.

Diagnostics record operation, resource, error code and HTTP status. They do not record keys, Authorization headers, prompts or provider response bodies. The lifecycle and remote stop state survive restarts; credentials are held separately.

The new manager uses the [documented REST v2 control API](https://docs.runpod.io/api-reference-v2/overview). Legacy advanced provisioning/template/account tooling still has its original GraphQL/REST v1 paths; normal legacy stop requests now delegate to the safe manager. Legacy creation has an additional write-ahead journal to prevent a second paid creation after a lost response. Migrating the remaining legacy interfaces is separate from this manager.
