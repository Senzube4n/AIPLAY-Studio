# Unified Model Library and creative templates

Base: independently published Phase 3.1 commit
`40fc1e091cf2fed4726d2cd61eaac4971f8e8a13`.

## Existing infrastructure and minimal-change plan

The app already had a provider browser in Cloud Setup, restricted provider
metadata/file resolution, authenticated RunPod downloads, a hash-verifying
transfer manager, a local catalogue/import shelf, category-aware setup planning,
current-worker readiness and existing form selection handlers. Prompt galleries
already demonstrate application-data persistence; `jsonStore` supplies atomic,
serialized writes. These remain the infrastructure for this phase.

The implementation moves the single provider browser to Models, adds a location
selector and curated/installed/reference views, adapts the existing transfer
manager for explicitly approved local provider downloads, and adds a strict
portable configuration format. No model registry, recommendation engine,
inference backend or cloud lifecycle path was replaced or duplicated.

## Delivered behavior

- Models contains AIPLAY curated, Hugging Face, Civitai, installed files and
  custom provider-reference lookup. The former Cloud Setup location links here.
- Curated compatibility reuses `setupPlan` and `fitFor`. Local estimates can
  show Supported or Unsupported; unchecked cloud hardware stays Unknown.
  Experimental profiles retain their status. These labels do not establish
  installed-file verification or current-worker inference readiness.
- Local and RunPod transfers use the existing pinned SafeTensors metadata,
  SHA-256, destination, redirect, cancellation and partial-file protections.
  Local transfers use the same model manager implementation as the worker.
  RunPod transfers and deletion retain the original authenticated routes.
  Local deletion is not added to this panel.
- Local provider-file compatibility stays conservatively Unknown in the
  browser; the existing setup planner supplies complete-bundle and workflow
  verification. Provider
  downloadability alone never establishes executable support.
- Templates support create, preview, save, edit, rename, duplicate, delete,
  individual export/import and all-template backup export with reviewed
  restoration. Files are stored under application data using atomic writes,
  with a previous-file backup. Read-back validation refuses tampered or corrupt
  files instead of exporting them or silently overwriting them.
- The versioned `.aiplay-template.json` format contains a curated selection,
  effective settings, exact companion identities, workflow keys, optional
  pinned provider references, preferred location, description and attribution.
  Internal storage IDs/timestamps are excluded from portable templates.
- Imports are previewed before use; location remains changeable. Missing or
  changed companions and workflow identities block loading. Planners outside
  the curated companion plan also stay blocked for manual review. Model terms link
  to the existing authoritative model pages. Review installation opens the
  existing planner, whose installation/licence approvals remain separate.
- Saving a provider reference does not apply its LoRA or create an adapter.
  Unknown references remain references. No arbitrary executable graph, script,
  pickle, URL downloader, cloud provisioning or auto-install is imported.
- Music captures effective ACE settings, including the selected DiT/planner,
  lyrics, instrumental mode, duration, seed, sampling steps and CFG. Private
  audio handles and unrepresented LoRAs are refused. Supported Pictures and
  LTX controls use their original form handlers. Loading changes forms only;
  the ordinary Make actions still own generation.
- Form restoration rejects unavailable select options and out-of-range values
  rather than silently choosing another planner/model. Execution location
  never changes the application's launcher mode automatically.

## Format and security review

See `aiplay-template.schema.json` and the authoritative runtime validator in
`server/creative-templates.js`. Format version 1 is ready for future indexing
through its name, description, attribution and portable model references;
there is no public hosting or synchronization.

The runtime validator is stricter than structural JSON Schema: it checks known
profile/category combinations, per-adapter setting allowlists, model filenames,
pinned provider revisions/file IDs, hashes, bounds, safe relative paths and
private-path/credential patterns. Unknown fields such as credentials, Pod IDs,
worker URLs, machine identifiers and executable payloads are rejected. Strings
are rendered as text. Provider URLs and download paths are resolved through
the original trusted metadata implementation, never from template-supplied URLs.

The new API uses existing loopback Host/origin and JSON mutation guards. Template
preview, persistence and export never call the vault, provider or installer.
Regression counters verify that boundary. Transfers require explicit model
terms approval and respect the launch-mode and active-work restrictions.

Historical XL-SFT acceptance is recomputed using the existing workflow/artifact
identity helpers. Changing planner, lyrics, duration, seed, steps, CFG or vocal
mode cannot inherit the exact A100 reference claim. Current-worker readiness
always starts unverified; no minimum GPU requirements or smaller-card validation
are inferred. Accepted hardware evidence files remain unchanged.

## Validation and evidence

250 focused JavaScript tests passed, covering the original cloud, worker,
Music/Pictures/Video, catalogue and planner suites plus portable round trips,
persistence, malformed imports, credential/path exclusion, tampered storage,
companion/workflow mismatch, compatibility scoping and effective ACE controls.
The client boot trace passes for app.js, Video Lab, Engine and video fit.

The full mandatory gate runs with the established isolated CPU Python
environment. Final logs and exit artifacts are
`tmp/cloud-manager/phase4-gate.log` / `phase4-gate-result.json` and the normal
commit hook's `phase4-commit-gate.log` / `phase4-commit-result.json`. The standalone
gate passed before the final companion-plan guard; the full normal commit hook
is the authoritative gate for the final source, including that regression. Earlier gate
runs interrupted to finish the final safeguards are not counted as passes.

Browser validation uses the isolated Phase 3 fixture extended with fixed,
synthetic provider metadata. External worker requests remain blocked; provider
metadata is mocked and no provider images or model weights are fetched.
At 1280px and 700px: curated browsing, location-dependent compatibility,
Civitai file review, pinned Hugging Face custom reference review, template
capture, save, duplicate/rename, export/import and backup preview were exercised.
There is no horizontal document overflow at 700px.

The exported Music preset was loaded through the ordinary Music handler:
XL-SFT BF16, 4B planner, 50 steps, CFG 7, 30 seconds, empty lyrics and seed
20261019. Screenshots and portable examples are in
`evidence/model-library-phase4/`. `offline-actions.json` records zero inference
submissions and zero provider actions. These are synthetic integration checks,
not another real GPU acceptance.

## Explicit limits

This phase adds provider downloads, not automatic adapter installation for
arbitrary models. Custom provider references need manual workflow/companion
review. The existing full local catalogue and import/adoption features remain
available below the unified browser. Curated model templates use those supported
adapters; one-click Music form capture currently covers ACE, Pictures capture
covers the curated checkpoint and Video capture covers LTX. Other providers keep
their existing generation paths and are not falsely represented as supported
template adapters. Creative ACE form templates use one take per submission.

Real provider transfers across Local/RunPod and new creative configurations may
need later authorized live validation. No real cloud resources were created,
started, restarted, stopped, resized, terminated or deleted. No model weights,
credentials or retained storage were modified. No installer rebuild or new
hardware validation is claimed by this source-publication milestone.
