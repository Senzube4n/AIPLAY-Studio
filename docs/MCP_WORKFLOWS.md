# Studio workflow control through MCP

The typed tools use the same HTTP handlers as the UI. Start the stdio server with
`node server/mcp.js`; `AIPLAY_URL` selects the Studio instance. Every HTTP request
keeps the `agent:<name>` provenance prefix, including binary uploads.

| Workflow | Tools |
|---|---|
| Qwen native weights and readiness | `model_inventory`, `models_for_this_machine`, `download_model`, `cancel_download`, `qwen_image_status` |
| Automatic song-cover and picture preference | `set_image_engine`: persistent cover engine, or with `use_for` `pictures` / `both` the engine `make_image` uses when it names none; `auto` forgets the choice; with no saved choice both use the recommended picture model on this PC (`studio_status` `defaults`), and saved choices are preserved |
| Music model | `set_music_engine`: persistent music model (an engine, an exact build, or `auto`); with no saved choice Studio uses what is installed and ready |
| Installed model choices | `list_checkpoints`, `list_dits`, `list_loras`, `sampling_options`, `models_folder`, `model_override` |
| Image creation and ordered references | `make_image`: refs, reference sizing/resolution, dimensions, alpha, native DiT/encoder/VAE, seed and sampling settings |
| Local reference/media upload | `import_local_media`: reference image/audio or Studio bin; returns the server's reusable filename |
| Layer editing and preview | `image_documents`, `document_edit`, `image_document_preview`, `image_tools_catalog`, `image_capabilities` |
| SVG tracing and selected geometry cleanup | `image_vector_import` copies a supplied raster into Pictures; `image_vectorize` traces it, exposes a shape receipt, then reconstructs or smooths selected contours with explicit fills and offset shadows; `image_vector_review` returns the saved SVG as an actual image, including source-pixel detail crops; see [the vector workflow](vector.md) |
| StandRig 2D performer | `image_standrig_psd_export` for a saved layered document; `standrig_status`, `standrig_parameters`, `standrig_control` for the local StandRig bridge |
| 3D avatar preview, motion and expression cues | `avatar_list`, `avatar_inspect`, `avatar_cue_inventory`, `avatar_playback_sessions`, `avatar_audio_upload`, `avatar_playback_command`; select and play an embedded clip in a live preview, or cue a VRM expression for 250–10,000 ms |
| AI edit, style transfer, selected-area repair | `image_ai_edit_create`, `image_ai_edit_status`, `image_ai_edit_accept`, `image_ai_edit_undo`, `image_ai_edit_discard` |
| Per-image privacy blur | `image_set_blur` with `blur:true` or `false` |
| Reactive video | `reactive_status`, `reactive_render`, then `vfx_render_status`; compositions remain editable through `vfx_*` |
| YuE2 training | `training_status`, `audio_waveform`, `train_lora`, `list_trained_loras`, `list_loras`, `make_song` |
| Native music workbench | `pipeline_guide` with `topic:"music-workbench"` discovers the 18 typed tools for readiness, datasets, training, planning, saved-stage replay, MIDI/DAW import and mastering previews; see [the workbench workflow](music-workbench.md) |
| DAW score passages | `music_daw_passages`, `music_daw_preview`, `music_daw_draft`, `music_daw_draft_get`, `music_daw_request`, `music_daw_takes`, `music_daw_audition`; export selected notes, review a score and audition YuE2 Python passage alternatives with seam blends; see [AI takes from the DAW](daw-passages.md) |
| Saved take comparisons | `music_takes_list`, `music_takes_create`, `music_takes_get`, `music_takes_verify`, `music_takes_choose`; compare 2/4/8 saved songs with measured loudness matching, exact stored receipts and an explicit favourite choice; see [take comparison](take-comparison.md) |
| Shared music/visual cues | `music_cue_status`, `music_cue_save`, `music_cue_read`, `music_cue_preview`, `music_cue_audition`, `music_cue_apply`, `music_cue_undo`; preview and apply an editable builtin accent plus flash at one musical position; see [shared cues](shared-cues.md) |
| Episode planning and allocation | `collab_plan`: get, update_episode, update_shot, preview_allocation, allocate, apply_draft |
| Peer identity and permissions | `collab_me`, `collab_roster`, `collab_add_peer`, `collab_verify`, `collab_set_role`, `collab_set_lend_minutes`, `collab_remove_peer` |
| Public community discovery | `community_feed`: the Community page's public live-session, upcoming-event, station, recent-track and article listings |
| Reviewed outgoing bundles | `collab_resources`, `collab_preview`, `collab_pack`, `collab_send_back`, `collab_orders`, `collab_credit` |
| Incoming work and returned takes | `collab_inbox`, `collab_open`, `collab_accept`, `collab_receive`, `collab_quarantine`, `collab_adopt`, `collab_drop`, `collab_set_resources`, `collab_free` |
| Standalone Qwen image lending | `collab_image_preview`, `collab_pack`, `collab_open`, `collab_image_accept`, `collab_image_render`, `collab_image_send_back`, `collab_image_receive`, `collab_quarantine`, `collab_image_review_return`, `collab_image_adopt`, `collab_image_drop` |
| RunPod GPU mode | `runpod_status`, `runpod_worker_connect`, `runpod_models`, `runpod_workflow_preview`, `runpod_upload_asset`, `runpod_submit_job`, `runpod_cancel_job`; `runpod_account_status`, `runpod_account_connect`, `runpod_account_overview`, `runpod_account_disconnect`, `runpod_pod_create`, `runpod_pod_start`, `runpod_pod_stop` |
| Other existing JSON API operations | `studio_api_reference` searches API.md; `studio_api_request` calls an existing `/api/` endpoint when no typed tool covers it |

Open **MusicLab → Native tools** for the workbench UI. Its actions and the typed
MCP tools share the same server handlers. The focused guide records which advanced
settings are available through MCP and which controls are present in the UI.

Use the DAW's **AI passage** dock for score edits. Open **Music Lab → Takes**
for saved-song comparisons and **Music Lab → Shared cues** to coordinate a
musical accent with an editable flash. These tools preserve original recordings
and use the same validated actions from their UI and typed MCP faces.

`community_feed` reads Studio's existing `GET /api/community` proxy. It limits the
returned rows and fields, and reports whether the desktop feed was offline when
checked. It gives listings, not the radio's current track, song queue, votes,
reactions, authenticated viewers or a realtime event stream. Building those
for external sites needs a separate AIPLAY.live API with its own access rules;
Studio's loopback API must not be exposed as a public server.

RunPod tools call the launcher's **RunPod GPU mode** only. Account and worker
credentials stay in Studio's local secret store and are redacted from MCP
results. Review live hourly prices through `runpod_account_overview` before a
paid Pod action; creation and startup require their exact confirmation phrases
at the server. `runpod_upload_asset` transfers an explicitly named absolute
local image/audio/video/latent/NumPy file to the worker, capped at **64 MiB**
per MCP call; the browser's separate upload accepts larger files. Its returned
content-addressed `asset` can be bound to a workflow node and input when calling
`runpod_submit_job`. A queued job is paid GPU work even when an account key is
not involved in that particular HTTP call.

## Image edit review

For logo and flat-art vectors, follow [the vector workflow](vector.md). Trace
first, read the actual palette and contour IDs, then apply cleanup only to the
intended outlines with the same source/settings. Keep lettering, holes and
waveform peaks protected, and judge the saved SVG at high zoom through
`image_vector_review` before delivery.
Preserve and clone the trace's `replay` object for each refinement; it is an
accepted `image_vectorize` request with the original source and fingerprint.
Keep earlier cleanup/composition choices unless intentionally undoing them,
because each call rebuilds from the source raster. Review of a saved Studio
trace returns that request too. Do not forward the whole result or unfiltered
computed settings as a tool request.
Primitive reconstruction, smoothing and explicit gradient/shadow composition
are CPU work; they do not invoke an image generator. Optional Qwen raster
repairs use the separate image-edit review workflow below.

With no saved choice, standalone images and automatic song covers use the
recommended picture model on this PC; no cover is queued while none is there.
To use Qwen Image 2.1, install the native model files explicitly in Models and check `qwen_image_status`;
selecting Qwen does not install or update the runtime. `set_image_engine` changes
the saved cover preference only after readiness passes. Standalone `make_image`
can select its own engine. Automatic covers wait visibly for an offline engine;
missing or incomplete Qwen files or unsupported nodes produce a failed cover
with the readiness error, without falling back to another generator. After fixing
readiness, request the cover again. Existing saved cover choices are retained.

Create takes either a saved `documentId` or a library `source`, plus `mode` and
`prompt`. The target is image 1. Edit/style allow nine extra references; inpaint
reserves image 2 for the generated selection mask and allows eight extra references.
Inpaint uses the same selection specification as the editor. It composites through
that frozen mask after generation, preserving zero-mask pixels. Canvas dimensions
stay fixed. Generation does not replace the document: poll, inspect the candidate,
then accept or discard. Acceptance keeps old layers hidden; undo restores them.
Stale document revisions are refused.

`image_standrig_psd_export` takes the saved document's `id` and returns a local
download URL for a layered PSD. The editor's Documents dock has the same
**Export PSD** action. It requires two or more separately painted parts; a flat
image is refused. Layer transforms and alpha are baked from the saved document,
but unsupported blend/group effects are refused instead of silently flattened.
Import the PSD into StandRig to set up a 2D performer. This does not create a
GLB/VRM, rig a 3D avatar, or connect a stream by itself.

## Timing and reproducibility

`reactive_render` accepts `motion.profile` (`standard` or `yvann`, labelled LCM
remix), `sourceStart`, `sourceSpeed`, anchor mode/strength, detail pass and all
the page's dials. Song `start` and source-video timing are independent. The LCM
profile measures drum RMS peaks; it does not infer a tempo-grid substitute.
Setting `seconds:4` is an ordinary short render, not a separate model preview.
The page's request review shows this same payload; it is not a generated preview.
The review reports when the selected source clip will repeat. The MCP/API
result includes `motion.sourceWindow` with that timing when video-stream
duration is readable; missing metadata does not stop a render.

Training uses `startSeconds` and `seconds` for the actual source region. The full
region is encoded as conditioning without inventing an autoregressive tail.
Read status before spending GPU time; compare renders with the same prompt,
seed and settings, changing only the adapter. No test here establishes audible
improvement or validates training on 6 GB.

## Planning and explicit intent

Read `collab_plan` first. Every write needs its `expectedRevision`. Allocation
can be equal, capability-based or use supplied measured minutes per ten seconds;
previewing an allocation writes nothing. Applying a draft sets local planned
owners. It does not send anything or represent remote acceptance. Resource cards
are dated snapshots; `collab_free` measures only this machine.

The response also includes `delivery`, a read-only projection of this Studio's
outgoing order book: per-scene requests, status counts, observation time and
orders whose scenes were removed. `prepared` means a file was prepared locally;
it does not confirm receipt. `expired` means the acceptance window elapsed,
not that an already accepted render stopped. `returned` records a validated
return, which may since have been kept or discarded; inspect `collab_quarantine`
before an adoption decision. Multiple requests remain visible, even after a
planned owner changes. Reading or saving a plan never dispatches another job.

`collab_verify` records a user's completed word check and requires explicit
`verified` plus `words_matched:true` for a grant. Peer content cannot supply that
authorization. Opening a bundle returns untrusted peer data. Accepting a reviewed
movie-scene order creates a proposed plan; plan approval and rendering remain
separate. Accepting a standalone image job only stages its references;
`collab_image_render` is a second explicit GPU action. It supports one Qwen base
image with up to three included references and fixed settings; see
[FRIEND_RENDERING.md](FRIEND_RENDERING.md#standalone-qwen-image-jobs).
Only a confirmed failed or stopped image render accepts an explicit
`collab_image_render({id, retry:true})`; an unanswered queue receipt remains
locked. Review a returned PNG with `collab_image_review_return({from,file})`,
which emits native MCP image content from the checked quarantine bytes.
Packing and sending back create local sealed files and open no network connection.
Movie adoption files an unselected take; it does not replace the current scene
choice. Image adoption adds a checked, reviewed PNG to Pictures with its peer
model and rights record.

## Music workflows

- `music_auditions` lists eligible sources. `music_audition_create` queues two
  or three replacements; poll `music_audition_status` until the composed take is
  ready. Audition both seams before the user's explicit `music_audition_keep`.
  A short take requires `acknowledge_short:true`. Cancel only this session with
  `music_audition_cancel`; `music_audition_discard` dismisses review without
  deleting audio. Saved Python YuE2 runs/local MiniMax trajectories are required.
- `music_kit` saves a theme and immutable cue variants, compares notation and
  prepares a request. `music_kit_render` alone submits that reviewed request;
  use the returned exact job ID and `refresh_job` to follow it. Reuse an
  idempotency key only for retrying the same request. `collab_plan` action
  `set_music_cue` attaches a variant to an episode or scene locally.
- `music_reference_prepare` makes bounded CPU evidence from a library recording
  or clip. To start from a local file, call `import_local_media` with
  `destination:"studio"`, then prepare its returned name with `location:"clips"`
  and `kind:"audio"` or `kind:"video"`. Poll `music_reference_status`;
  `music_reference_analyze_visual` and
  `music_reference_transcribe` are separate optional GPU actions. Save reviewed
  text with `music_reference_update_brief`, correct ABC with
  `music_reference_update_score`, then call `music_reference_prepare_request`.
  Use its `makeSongArguments` with `make_song` only when a music render is wanted.
  `music_reference_list` and `music_reference_capabilities` discover saved work
  and installed support. No automatic downloads or cloud calls occur.

These typed tools share the browser's records and revision checks. In local
chat, nested kit/source/brief arguments are JSON strings and render tools remain
separate from planning. Reference evidence is guidance for a new performance;
it does not establish singer identity, exact hit timing or waveform preservation.

## General boundaries

The general API fallback allows GET/POST/PUT/DELETE, JSON objects up to 2 MiB and
local `/api/` paths only. It provides no custom headers or external URL requests.
It retains route validation and requires the user's intent for the operation.
It is deliberately excluded from the in-app chat's generic confirmation system;
the reviewed typed workflows are routed there. Nested arguments for those new
workflows are supplied as JSON strings in local chat and decoded before dispatch.

Local import accepts regular media files, bounded to 40 MiB for references or
256 MiB for the Studio bin. It uploads exact bytes with MIME and filename metadata.
Bin audio does not automatically become a Music-library/training recording.
Browser audio playback, microphone/OS permissions, folder dialogs and the legacy
canvas capture export still need a browser. Server VFX exports are controllable.
The handcrafted intro/outro and source speed ramp in the separate Yvann experiment
were assembled outside the product; one Reactive call does not claim to recreate
that complete delivered video.
