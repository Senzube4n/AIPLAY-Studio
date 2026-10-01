# Music workbench

Open **Music Lab > Native tools** for the optional native planner, dataset trainer,
MuScriptor and separate audio-processing previews. The main full-window player’s
**Score** view follows a linked YuE2 score; saved native runs also link to the
following-score player. Timing is approximate, and MIDI prediction is not a
faithful transcription guarantee.

On **Music**, Takes offers 1, 2, 3, 4 or 8 separate queued performances with
different seeds. This does not promise simultaneous GPU batching. **Overnight**
retains the selected engine and its accepted per-song settings, exact lyrics and
score text; each take receives a fresh seed and passes through the ordinary
generation door. ACE's base model remains an engine-wide setting.

An MCP agent can discover the workflow with
`pipeline_guide({"topic":"music-workbench"})`. All tools below call the same
`/api/music-tools` route as the UI; they do not bypass worker exclusivity,
source/hash checks, installation state or hardware checks.

| Task | MCP controls |
| --- | --- |
| Read readiness, datasets and history | `music_workbench_status`, `music_workbench_run` |
| Install an explicitly requested optional pack | `music_native_install` |
| Create and review a dataset | `music_dataset_create`, `music_dataset_edit` |
| Convert reviewed recordings | `music_dataset_prepare` |
| Train and resume joint AR/NAR adapters | `music_native_train`, `music_native_continue` |
| Export and copy a ComfyUI LoRA | `music_adapter_export`, `music_adapter_install` |
| Plan score/tokens/audio, replay and save a song | `music_native_plan`, `music_native_replay`, `music_native_keep` |
| Predict MIDI and import editable notes | `music_audio_transcribe`, `music_midi_to_daw` |
| Compare processing previews and keep a separate take | `music_process_preview`, `music_process_keep` |
| Stop only the active workbench worker | `music_workbench_stop` |

The UI exposes planner stage, seed and token limit, plus training recipes and
custom optimizer, adapter and total steps. Planner quantization and NAR steps,
and custom training rank, alpha, accumulation and learning rate are currently
MCP controls; the UI does not yet expose every advanced setting.

Starts return a saved run id. Poll it until done or a visible failure; downloading
an artifact or keeping a result is a separate action. Do not automatically repeat
a start after an uncertain response: these native starts do not have the older
Python replay adapter's idempotency contract. Read status and history first.

Native planning keeps exact effective lyrics/settings. It requires the optional
audio.cpp 0.9 CUDA pack and installed native Q4/Q8 weights. Score edits request a
new semantic performance; token replay reuses verified tokens and refuses a changed
score or primary model/runtime. Neither promises identical audio on other hardware.
The native planner currently requires nonempty lyrics.

The native trainer requires NVIDIA CUDA with at least 11 GB VRAM. Dataset creation
does not approve its metadata: review style, exact lyrics and instrumental flags.
Editing invalidates derived dataset caches while retaining the source recordings.
Preparation converts audio; training completes the latent/code/score preparation.
Fast, balanced and thorough recipes use fixed settings; overrides require custom.
Resume uses a higher total step count and the same dataset fingerprint. Training
loss and successful checkpoint export do not establish musical improvement.

An exported combined adapter is copied into the ComfyUI LoRA shelf only when
requested. Select its returned filename in **Audio LoRA** and **Planner LoRA** on
**YuE2 through ComfyUI** to apply both halves. The existing native GGUF song engine
does not automatically load this trained adapter. Evaluate compatible exports with
the paired listening lab and actual held-out audio.

MuScriptor weights use CC BY-NC 4.0. DAW import retains valid predicted event timing
on a provisional 4/4 timeline, default 120 BPM and pluck sounds. Choose instruments
and review tempo/alignment in the DAW. Partial imports and project limits remain
visible; importing a completed run again returns its saved project.

Processing previews provide denoise, high-frequency EQ reduction, optional offline
VST3 plugins and reference loudness matching. An installed Pedalboard host alone
does not establish compatibility with every plugin. The chain currently processes
the source duration without flushing effect tails. This is separate from the
DAW's EQ, dynamics, imager, exciter, reference comparison and measured bounce.
For mastering, inspect the final exported audio with the DAW meters and use
loudness-matched comparisons. Ozone-equivalent neural processing is not implemented.

Music page take choices make separate queued performances, rather than parallel
model batches. The workbench does not contain an automatic dance-loop judge,
protected-passage guarantees, a syllable stress editor or real-time model synthesis.
