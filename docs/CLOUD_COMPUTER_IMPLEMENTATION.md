# Cloud Computer implementation report

Status: implementation and automated/simulated validation prepared for publication to the Nemesis fork. Final acceptance on real GPU hardware is authorized but awaiting credential entry. No real RunPod resources were created, started, stopped, resized, terminated or deleted during development.

## Integration

Repository inspection found existing RunPod connection/account UI, the credential vault, durable remote job transport, music queue, model manager, ACE-Step training adapter and worker autostart. It did not find a separate Easy Cloud Setup module or existing REST v2 management client. The existing account integration uses GraphQL and REST v1.

The new manager uses these existing pieces and adds a dedicated REST v2 adapter. It stays within the RunPod launch mode and matching Settings card. Beginners first see Easy Cloud Setup: Account → Computer → AI → Automatic stop. It moves the existing vault-backed forms into the current step, fills the selected resource's address, and checks account, worker and model readiness. Completed setup is remembered per resource and survives stopping compute. A Change setup disclosure preserves access to credential repair, model management and stop-key changes. The dashboard follows selection; provider-specific controls stay behind Advanced details.

The guided interface does not automate new-resource provisioning or worker installation. In this fork build those remain advanced/manual tasks with explicit price approval and the reviewed deployment archive. A trusted deployable worker installer and tested model/workload presets are the next steps for a fully self-service beginner installation.

| Component | Responsibility |
|---|---|
| `server/engine/runpod-v2.js` | Official v2 paths, pagination, safe resource projection, bearer authentication, availability/pricing, billing and increase-only capacity |
| `server/engine/cloud-computer.js` | Persistent operation journal, quote-bound approval, discovery, reconciliation, session estimates, scheduler gate and desktop workload lease |
| `server/engine/remote-routes.js` | Existing host/origin/JSON guards, vault-backed credentials and manager routes |
| `server/engine/remote-client.js` | Existing authenticated worker identity and verified artifact transport, closed cloud-policy replies and submission gate |
| `worker/cloud-watchdog.js` | Persistent idle/finish policy, per-computer stop authority, safe preparation, uncertain-result reconciliation and separate diagnostics |
| `worker/cloud-storage.js` | Mount verification, bounded namespace inventory, reviewed scratch cleanup, output verification and filesystem flushing |
| `worker/runpod-worker.js` | Authenticated controls, transfer/request lifetime accounting, workload checks and generation freeze during shutdown |
| `server/jobs.js`, `server/index.js` | Pause and persist future music recipes, restore on approved start and prevent new enqueueing during shutdown |
| `server/music/ace-training.js` | Read-only ACE-Step activity check, including externally initiated service training |
| `web/cloud-computer.*` | Beginner panel using existing UI styles and app confirmation dialogs |
| `scripts/package-cloud-worker.mjs` | Reproducible allow-listed deployment source archive and checksums |

Core paths: unconfigured → stopped → starting → ready / models-needed / worker-unavailable. Stop paths: preparing / waiting-to-stop → stopping → provider-confirmed stopped. An uncertain operation stays bound to its resource and ID. A failed availability check never leads to termination or automatic replacement. Capacity changes have their own pending operation.

## Verified API contracts

The official OpenAPI schema was downloaded on 14 October 2026 from `https://api.runpod.io/v2/openapi.json`. Its SHA-256 is `fe8a74b177282ec89a9ba1c75d3ce1d4bd1a2a9b9609fbdb4bd131d5b4a24506`.

Implemented contracts include:

- `GET /v2/pods` with `pods` and cursor pagination; `GET /v2/pods/{id}` with lifecycle `status` and permitted `actions`.
- `POST /v2/pods/{id}/action` with the single `action` field, restricted here to start/stop.
- `GET /v2/catalog/gpus/{id}` with availability/product/count/cloud filters and per-cloud prices.
- Network volume reads/increase-only updates and complete persistent-mount updates on stopped computers.
- Pod and attached-network-volume billing with explicit UTC month bounds.

No terminate, delete, reset, mount replacement or automatic Pod creation surface is provided by the manager. Unknown availability/pricing/state is refused rather than treated as zero or success. See the [official v2 overview](https://docs.runpod.io/api-reference-v2/overview), [storage persistence rules](https://docs.runpod.io/pods/storage/types), and [network storage](https://docs.runpod.io/storage/network-volumes).

## Acceptance evidence

The focused run contains 97 passing tests across the new lifecycle/watchdog/storage suites, existing transport/UI/account/MCP/security suites and ACE-Step training tests. Two additional setup tests verify progression/repair, real shutdown authority versus the default preference, reuse of secret inputs and price approval. GPU-dependent gates may explicitly skip missing hardware/tooling and do not constitute real GPU acceptance.

Final software validation records:

- Full `.githooks/pre-commit` gate: exit 0, `tmp/cloud-manager/acceptance-gate.log`.
- Final focused run after the queue-readiness guard: 95 passed, 0 failed, `tmp/cloud-manager/regression-tests.log`.
- Final beginner-setup regression run: 97 passed, 0 failed, `tmp/cloud-manager/setup-regression.log`.
- Beginner-setup full repository gate: exit 0, `tmp/cloud-manager/setup-gate.log`; final setup-edit controls also passed the browser checks and focused regression run above.
- Registration census: all 399 suites accounted for; 5 checks passed, 0 failed.
- Syntax checks for the server entry, scheduler and lifecycle manager: passed; `git diff --check`: passed.
- Browser flow: price approval, running/AI readiness, monthly billing scope, storage review, cancelled Stop Now and provider-confirmed idle stop passed using simulation only. No browser errors were recorded.
- Beginner setup browser flow: first account step, price-review cancellation/start, automatic-stop opt-out confirmation, saved setup after stopping, and subsequent connection/model/stop-key editing passed. Desktop and 700-pixel account-step layouts showed no overflow; screenshots are `tmp/cloud-manager/easy-setup-desktop.jpg` and `easy-setup-mobile.jpg`.

Optional hardware/tool-dependent checks explicitly skipped their absent dependencies. Neither the software gate nor the source archive proves a real GPU deployment.

| Requested case | Automated/simulated evidence | Real hardware |
|---|---|---|
| Start existing computer | Quote approval, fresh price, retained identity, compatible worker/model checks | Pending credentials/deployment |
| Stop idle computer | Persistent-output permit; stopped displayed after provider GET | Pending credentials/deployment |
| Finish job then stop | Remote durable intent, desktop lease and saved future queue; queued worker recipes pause until resume | Pending credentials/deployment |
| Confirm cancellation | Missing confirmation refused; repeated IDs do not cancel twice | Pending credentials/deployment |
| Idle shutdown | 15/30/60/disabled; persisted policy; remote stop action | Pending credentials/deployment |
| Desktop disconnect during generation | Remote activity blocks stop after lease expires; watchdog continues independently | Pending credentials/deployment |
| GPU unavailable after stop | No destructive recovery; wait/backup alternatives | Observe without forcing an outage |
| Restart with storage | Same Pod/mount retained; increase only after explicit approval | Pending credentials/deployment |
| Storage cost display | Running/stopped disk rates, standard network tiers, unknown-tier handling | Pending credentials/deployment |
| Invalid credentials | Safe distinct errors, no credentials in URLs/replies/diagnostics | Pending credentials/deployment |
| API timeouts | Persisted uncertain operations, no blind mutation replay | Safe fault injection planned |
| Worker failure | Computer remains running, AI unready; shutdown withheld without evidence | Pending credentials/deployment |
| Resource reconciliation | Pagination and recovered persisted operation on same resource | Pending credentials/deployment |
| Existing RunPod regressions | Existing suites retained; legacy stop hardened; creation uncertainty journal | Automated pass |
| Storage cleanup | Explicit review, content/metadata checks, namespace bounds, no assets/weights selected | Pending credentials/deployment |
| External queues/updates/training | Real authenticated worker HTTP fixture vetoes unsafe shutdown | Pending credentials/deployment |

Browser validation uses an isolated app-data/output directory and a provider interceptor that blocks all outside requests. Its computer is visibly named **AIPLAY SIMULATION (no charges)**. The UI exercises start price approval, separate running/AI-ready indicators, provider billing versus estimates, storage review and cancellation/stop flow. Desktop and 700-pixel layouts were checked; the cloud card has no horizontal overflow at 700 pixels and the browser error log was empty. Screenshots are saved in `tmp/cloud-manager/desktop-preview.jpg` and `mobile-preview.jpg`. It is not a cloud-hardware benchmark.

## Deployment artifact

Current archive: `dist/aiplay-cloud-worker-f4c6f853b66c.tar.gz` (14 source/license files).

- Source manifest build: `f4c6f853b66c619a09ac0475d3f0401305e4aef3eef90c6abc730677452162ae`.
- Archive SHA-256: `dcb11860c2bcff910030d008c705436d25edf4ca4ea701642a3e824bc7891518`.
- Archive/file hashes are generated locally; no upload or installation is performed.

The existing official-repository bootstrap cannot fetch the fork's Cloud Computer changes. The source-only package makes the exact worker code reviewable without changing the inherited bootstrap trust policy. See [setup and operation](CLOUD_COMPUTER.md) for deployment requirements and preservation rules.

## Remaining acceptance and operating limits

On 14 October 2026, the user authorized choosing an existing computer and acceptance workflow. The planned run is limited to $2 additional compute and 30 minutes, without resizing, terminating or deleting resources. Read-only local discovery found no usable account API key or worker token in AIPLAY's vault. No provider requests or billable mutations were made. The inventory record is `tmp/cloud-manager/hardware-inventory.json`; hardware acceptance remains pending credential entry through AIPLAY's connection settings.

Once credentials are entered, acceptance will select a suitable existing idle computer and installed workflow within the authorized scope above. No existing computer should be terminated or have its storage replaced/deleted. Capacity increases are excluded unless separately approved.

The acceptance run should record resource/mount IDs, provider states and rates; run a small saved-output generation; verify the checksum, retained file and restart; test stop-after-job and approved cancellation; close the desktop during generation; and verify remote idle stopping and provider billing. Network faults can be injected safely around the client; GPU unavailability must be observed or simulated, never manufactured by destructive resource changes.

Automatic stopping requires the separate remote key, a live worker and known workload/storage state. Unknown services, remote process failure or provider outages may keep compute running. Manual work outside monitored services requires the maintenance lock. It is not a guaranteed spending cap. Historical estimates can miss external rate changes and compute sessions not observed by AIPLAY. Storage prices are dated public estimates; multiple-resource configurations and high-performance/global tiers without verified total prices remain unavailable. The existing verified transfer limits and tracked-output-only backup scope remain in effect.

Software implementation is complete; production readiness and final real-hardware acceptance are not claimed.
