# Cloud Computer

Open **RunPod GPU** in the launcher, then **Settings → No strong graphics card? → RunPod GPU**.

The three hosting choices are collapsible: **Ask a friend**, **Paid services**, and **RunPod GPU**. Opening one closes the others while preserving their fields.

**Easy Cloud Setup** shows four tabs:

1. **Your goal:** choose Music, Pictures, Video or All three; connect the account using a restricted RunPod key. The goal is saved locally and never provisions a resource.
2. **Costs:** select an existing computer or press **Create cloud computer**. Review compute, storage and session estimates before starting. Creation still requires a fresh price review, billing checkbox and explicit approval. Storage remains billed after compute stops.
3. **Install AI:** follow automatic installation or connect an existing worker, then approve the selected models' licences and downloads. Choose an idle timeout and save a separate shutdown key, or explicitly choose to keep rental running. Video needs approved model access and a Hugging Face read token.
4. **Ready:** see provider status separately from AI readiness, storage charges, shutdown protection and start/stop controls. Readiness requires every curated bundle for the selected goal, a verified running worker and a verified policy or explicit disabled policy. A stopped computer is shown as stopped, never AI ready.

**Try a sample** prepares the relevant existing creation screen (Pictures for All three); review it and press Make to submit. It does not generate automatically. Opening tabs does not start rental, install models or generate. **More computer controls** contains storage management, detailed spending and job-aware shutdown controls.

The guide reuses the existing vault-backed fields without duplicating credential inputs. Setup completion is remembered for each computer; live readiness is checked again after reconnecting. Manual provider controls remain under **Advanced setup**.

The cloud header stays visible while scrolling the panel and shows the RunPod dollar balance. It refreshes about once a minute while AIPLAY is visible, retains an explicitly labelled last-checked balance on provider failure, and clears it when the account is removed. It is separate from local spending estimates.

**Install AI** shows five live setup checks: start computer, install service, download selected models, check connection and verify automatic stop. The bar counts completed checks, not guessed installation time. Details and model controls remain in button-style disclosures. **Stop setup and computer** asks before pausing model downloads, waits for cancellation, then uses the existing safe idle-stop path. Active generation still blocks that stop. Before worker connection, shutdown is disabled because saved outputs cannot yet be verified; the provider console remains available under Installation details.

**Advanced setup** is a footer button for manual connection and AI-service installation controls. **Back to guided setup** returns to the same step and keeps entered details. Opening either view performs no rental or provisioning action.

### Computers removed outside AIPLAY

Discovery filters terminated computers. A selected computer is retired only after an explicit terminated state, or a Pod GET returning 404 followed by a complete successful inventory that also omits it. A timeout, failed inventory, contradictory list or missing storage resource does not retire the selection. Discovery refreshes about every 30 seconds after the first successful account inventory; Check again refreshes immediately.

Confirmed removal clears stale selection, operation, storage quote and worker readiness, remembers the retired ID across restarts, and returns to Costs without choosing or creating a replacement automatically. Automatic-install journals also retire the missing computer so they cannot select it again or block a fresh explicit creation. Replaying the original creation request never creates another resource. Old unresolved jobs are retained as uncertain, private graphs are cleared, already-downloaded outputs remain, and future local queue work is saved and paused. A replacement can be selected without obsolete jobs blocking it; saved queue recovery remains tied to an explicit reviewed start.

No termination, cleanup or storage deletion is used for reconciliation. Absence from this account does not establish the status of independent storage or charges; review those in RunPod. Historical compute sessions close at the observation time as an estimate, not a provider-confirmed stop time.

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

Catalogue availability describes the data center and does not reserve the original host's GPU. RunPod can reject start with HTTP 400 because that host has no free GPU. AIPLAY recognizes this specific refusal, preserves the stopped computer and its storage, and keeps the explanation visible through read-only refresh and desktop restart. A new price review is required before another start attempt; no replacement or automatic start retry is performed.

## Automatic stop

Choose 15, 30 (recommended), 60 minutes, or Disabled. A preference saved while stopped applies at the next start. The 30-minute default is a recommendation; shutdown is not armed until its remote credential has been configured.

While the computer is running, expand **Automatic stop setup**. Save a separate restricted RunPod key with Pods read/write permissions and approve storing it on this computer. The worker stores it under its persistent state directory in a `0700` directory and `0600` file, matching Studio's Linux file-permission protection. It is never returned to the browser or included in an export. The account key in the desktop vault is not silently copied to the worker. The dedicated key's provider permissions may cover other account Pods, even though this worker's code only permits stopping its own bound computer.

The remote watchdog runs independently of desktop/browser connectivity. It protects ComfyUI running/pending jobs, durable unresolved worker jobs, managed training and the ACE-Step training status, curated downloads, request processing, artifact transfers and the bootstrap maintenance lock. A 90-second desktop workload lease protects local queue/preparation activity; ordinary UI navigation does not renew it. If the desktop disappears, remote generation continues, then the configured idle policy or requested stop can finish safely.

Unknown workload state or unverified storage blocks shutdown. The watchdog depends on a running worker and reachable workload services; a crashed remote agent, unsupported service status, or provider outage can prevent automatic stopping. The UI shows watchdog errors separately. This is a best-effort shutdown policy, not a guaranteed billing cap.

For work launched manually outside AIPLAY's monitored services, maintain the worker's `maintenance.lock` during that work. Bootstrap updates already manage this lock. Do not leave it present after manual work ends. Use **Remove stop key** to disable the remote credential when no stop is pending; revoke its provider permissions in RunPod if the key should no longer be usable.

## Storage and spending

### Model browser and disk management

Open **Install AI → Browse more models** for a live Civitai/Hugging Face gallery. Search by name, choose model/LoRA and task filters, then inspect the version, file, size, base model and licence. **Load more** appends another provider page; changing filters starts a fresh search. Civitai model types use repeated query parameters because its live validator rejects comma-separated types. Civitai Music/Video filters use its audio/video tags; Hugging Face uses pipeline tags. Provider metadata does not certify compatibility or graphics-memory requirements. Hugging Face cards use provider social thumbnails when no art preview is supplied. Civitai browsing requests safe content and uses only safe-rated previews.

File details show **Works with your setup**, **Needs extra components** or **Compatibility unverified**. A positive check currently covers the exact curated SDXL Turbo file, a complete verified bundle and validation of AIPLAY's Pictures graph against the connected worker's actual node definitions and checkpoint choices. Other models and LoRAs remain unverified unless a missing required component is identified. A matching base-model name is not a compatibility guarantee. These checks do not guarantee available GPU memory or a successful generation at arbitrary settings.

Optional read keys live under **Settings → Model connections**, using the existing vault. Browsing works while the Pod is stopped and never starts rental. Install requires a running, connected worker with `catalogVersion: 1`. Existing workers need this published worker update; the desktop does not update or restart a paid computer automatically.

**Download to RunPod** sends provider identifiers, the selected revision/version and file, destination category and reviewed hash/size to the authenticated worker. The worker independently retrieves metadata and downloads directly into its persistent models directory. Weight bytes never pass through the desktop. Only SafeTensors files with provider SHA-256 and bounded size are supported. Additional components and workflows are not installed automatically. The provider key is sent to the worker only for this transfer and is not written to its manifest, status or logs. Gated access must be approved on the provider's model page.

Downloads reuse the worker's verified resumable downloader, cancellation and workload protection. External transfers allow only provider/CDN HTTPS hosts and strip authorization on redirects. Provider metadata is pinned/rechecked; changed files require review again. Hash-prefixed filenames avoid overwriting other weights, and final publication refuses existing files. Paused partials are retained for resume. The persisted catalogue manifest contains no credentials. Free filesystem space is checked, but a shared backing pool is not a guaranteed provider quota; a storage failure preserves user assets and reports failure.

**On RunPod** lists supported model folders (checkpoints, LoRAs, diffusion models, VAEs, text encoders and upscalers). It does not delete automatically. **Delete** first reviews one exact file, then asks for permanent-deletion confirmation. The worker checks idle/known workload state, maintenance, transfers, unresolved jobs, training and downloads; blocks new AIPLAY mutations during review/deletion; rechecks size, timestamp and SHA-256; and refuses traversal, symlinks, changed files and expired/replayed approvals. Direct work outside monitored services must use the existing maintenance lock. This action permanently removes only the confirmed file. Deleting files frees usage but does not reduce allocated-storage charges. Unsupported folders remain managed through RunPod.

Provider contracts: [Hugging Face Hub API](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api), [Civitai model search](https://developer.civitai.com/site/reference/models), [Civitai versions](https://developer.civitai.com/site/reference/model-versions). Verified against public metadata on 18 October 2026. Automated tests use tiny fixture files, never real user-model deletion or paid rental.

**Review Storage** measures the selected persistent namespace and separates models, generated content, temporary files and other saved files. Allocation comes from the provider. Filesystem backing-pool statistics are diagnostic data, not your storage quota. Scans are bounded to 100,000 entries and approximately ten seconds; partial category values are lower bounds and total usage remains unavailable. Reviews show their time.

**Safe Cleanup** presents only abandoned AIPLAY upload scratch files older than 24 hours. It requires explicit review, hashes and rechecks the manifest, and refuses changed files. It does not select weights, datasets, generated assets or general preview files. Removing files does not reduce the provider's allocated capacity or recurring storage charge.

**Manage Capacity** reviews an increase and its estimated recurring charge. The computer must be stopped, capacity can only grow, and uncertain results are reconciled without repeating the update. Supported paths are a single host-local persistent disk or standard network volume. Multiple storage resources and unsupported/global/high-performance pricing are shown as unavailable and managed through the provider, so a partial price is never presented as the total.

**Back up outputs** uses the existing verified remote download/adoption pipeline for tracked generation results. The computer must be running for worker-based review and export. Existing transport limits still apply (512 MiB per file, 64 outputs and 2 GiB per job). Other datasets, models and independently generated files use the provider's supported export tools.

Session/monthly compute estimates use observed sessions and provider rates, including the current session's reported start time. They exclude storage, taxes and unobserved rate changes. They are not complete billing records. Provider-reported monthly billing is fetched separately for the selected computer and its attached network storage. Shared volume charges are for that volume, not attributed to one generation.

Storage estimates use public rates reviewed on 14 October 2026: persistent disks are $0.10/GB/month while running and $0.20 while stopped; standard network storage uses $0.07/GB/month for the first 1,000 GB and $0.05 above that. Unknown tiers remain unavailable. Actual charges can differ. See [RunPod storage options](https://docs.runpod.io/pods/storage/types) and [network volume pricing](https://docs.runpod.io/storage/network-volumes).

Spending alerts notify in AIPLAY while it is open. They do not enforce a provider billing cap. Stopping GPU compute does not stop storage billing.

## Updating existing computers

Open **Install AI → Update AI service**. For computers created by AIPLAY's automatic installer:

1. Stop the computer normally. Active work and unsaved outputs still use the existing safe-stop checks.
2. Press **Review AI update** and approve the exact published AIPLAY build. The computer must remain stopped with its original recognized startup configuration and persistent `/workspace` mount.
3. Press **Review start price** to start it, then **Check update**. AIPLAY reports **Update verified** only when the running worker reports the selected computer identity and target commit.

Saving the update changes only the existing Pod's container command through REST v2 `PATCH /pods/{id}`. It does not start rental, change the image, replace environment variables, regenerate connection keys, resize/delete storage, install models or create a replacement Pod. The next separately approved start runs the pinned installer and may install runtime dependencies while GPU rental is running. Existing versioned source checkouts, shared models, outputs and worker state remain on persistent storage. Storage continues billing while stopped; the original host can refuse a later GPU allocation.

Update requests are journalled before PATCH. An uncertain response blocks both guided and legacy app starts for that computer until a provider read verifies the intended command and unchanged remaining settings. Checking or replaying the same request never repeats the PATCH. Custom startup configurations and computers not tied to this app's automatic-install record use the manual deployment procedure below; they are never silently converted. A build whose published installer cannot be verified cannot be staged.

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

- Desktop: `<appdata>/runpod/cloud-computer.json`, `paused-music-queue.json`, `creation-journal.json`, `worker-update.json` and `cloud-diagnostics.jsonl`.
- Worker: `<worker-state>/cloud-policy.json`, `cloud-diagnostics.jsonl`, `cloud-secret/stop-key.json`, and the existing job/model state.

Diagnostics record operation, resource, error code and HTTP status. They do not record keys, Authorization headers, prompts or provider response bodies. The lifecycle and remote stop state survive restarts; credentials are held separately.

The new manager uses the [documented REST v2 control API](https://docs.runpod.io/api-reference-v2/overview). Legacy advanced provisioning/template/account tooling still has its original GraphQL/REST v1 paths; normal legacy stop requests now delegate to the safe manager. Legacy creation has an additional write-ahead journal to prevent a second paid creation after a lost response. Migrating the remaining legacy interfaces is separate from this manager.
