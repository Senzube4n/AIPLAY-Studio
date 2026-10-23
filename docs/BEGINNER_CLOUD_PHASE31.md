# Beginner cloud onboarding polish

Base: `f970bd80cf76ed05dd469850adf907d40a273795`.

## Changes

The existing remote idle watchdog already has a 30-minute default, explicit
15/30/60/Disabled choices, separate credential enrollment and workload-aware
persistence protection. This milestone exposes that recommendation during
initial cost review and moves the same controls between Review and Install.
It does not create a second setting or silently authorize shutdown. Existing
worker preferences are now read back instead of displaying the desktop's
default. A pending stopped-computer edit cannot leak to another computer.

The management summary prioritizes provider state, GPU rental, estimated
session compute, estimated storage after stopping and safe actions. Model
identities and billing detail remain available in a disclosure. Start still
requires a fresh provider quote and the original explicit approval dialog.
Stop still uses the guarded persistence path and only reports stopped after
provider confirmation. Storage deletion remains separate and unchanged.

Idle shutdown and separately authorized test deadlines remain distinct.
Neither is a provider-enforced billing cap. Credentials, runtime supervisors,
provisioning and model installation contracts are unchanged.

## Offline validation

239 focused JavaScript tests passed using the established isolated CPU Python
environment. The first invocation omitted AIPLAY_PYTHON and failed two real
audio-tagging tests; rerunning with the documented process-scoped environment
passed all assertions. No installed application configuration was changed.

The new regression checks existing 0/15/60-minute worker preferences survive
discovery without any policy write, and selecting a different computer drops
an unrelated pending edit. Existing suites cover default 30 minutes, active
generation/queues/downloads/transfers, unknown activity, worker restart and
desktop disconnection, failed/uncertain stops, recovery, storage retention,
Music/Pictures/Video behavior and accepted XL-SFT evidence scoping.

Browser checks used the existing isolated Phase 3 fixture with external worker
network blocked, synthetic artifacts and fake provider only. At 1280px and
700px the layout has no horizontal document overflow. Verified running,
provider-confirmed EXITED, continued $20/month illustrative storage estimate,
disabled AI readiness while stopped, explicit fresh $1.79/hour start review,
cancelled start approval, saving 60 minutes while stopped and unavailable
provider recovery. Only one synthetic stop was requested; no render ran.

Screenshots: `evidence/beginner-cloud-phase31/`. Prices and balance in these
images are fixtures, not live provider quotes or billing evidence.

Full mandatory gate and normal commit hook results are recorded in
`tmp/cloud-manager/phase31-gate.log` and `phase31-commit-gate.log`, with exit
status artifacts beside them. Publication is verified against immutable
Nemesis commit URLs and Git blobs after the gate passes.

## Limits

This is software-only validation, not renewed live-provider acceptance. Older
workers still require the existing guided update to report meaningful workload
activity. A recommendation alone does not enroll a stop key or enable a remote
policy. Pending stopped-state changes apply through the existing approved start
lane. No real RunPod operations, weights downloads, credential changes or
retained-storage changes were performed.
