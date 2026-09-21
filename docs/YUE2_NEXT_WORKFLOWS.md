# YuE2: practical next workflows

Research checked 2026-09-21. The first delivery implements chorus auditions,
episode identity kits and a local reference-to-music brief workflow, available
from **Music → Music workflows** and through typed MCP tools. Artifact replay
and the automated LoRA listening lab below remain proposals requiring separate
runtime and listening validation.

## Available workflows

- **Chorus alternatives:** select a supported library recording and region, queue
  two or three takes with distinct seeds, listen around both joins and explicitly
  Keep one. Saved YuE2 Python runs and local MiniMax trajectories are supported;
  native GGUF/Comfy recordings and imports without replay data are not. The
  original remains. A take becomes ready after its audio has been spliced and
  measured, not merely when generation ends. Short takes show how early the
  retained ending returns and require acknowledgement before Keep.
- **Episode themes:** freeze an exact score version or pasted ABC with lyrics,
  style, seed, backend and available source provenance. Save opening, tension
  and closing variants, review an exact request, then explicitly Render. Link
  an immutable variant to an episode or scene in the local Collab plan. Saving
  or attaching a cue sends no files and starts no generation. Supplied-score
  rendering currently supports Python YuE2 and native GGUF, not the current
  Comfy graph.
- **Reference music:** choose local library audio or a clip; prepare a region
  up to 120 seconds and six timestamped frames on CPU. Optional local Qwen3-VL
  analysis suggests music from the frames; optional SheetSage2 transcription
  produces editable ABC. Measured beats, model suggestions and the editable
  brief stay separate. Review the request, load it into Create, then generate
  explicitly. No model is downloaded or remote service called by preparation.

The reference adapter is **analysis → reviewed brief/score → new YuE2 performance**.
It is not a native audio/video input to YuE2, a singer clone, or a guarantee of
music landing on specific video events. Qwen3-VL describes images; Qwen Image 2.1
remains the separate image generator. The local first-pass limits (512 MiB source,
120-second selected region, six frames) are not Suno/Kie's upload limits.
[Suno V6](https://help.suno.com/en/articles/13924481),
[Kie reference fields](https://docs.kie.ai/suno-api/generate-music),
[YuE2 supported inputs](https://github.com/multimodal-art-projection/YuE/blob/main/docs/generation.md)

MCP: `music_auditions`, `music_audition_create/status/keep/cancel/discard`,
`music_kit`, `music_kit_render`, `collab_plan` (`set_music_cue`),
`music_reference_capabilities/list/prepare/status/analyze_visual/transcribe/update_brief/update_score/prepare_request`.
Each slash group expands to separate tools with that shared prefix. Generation,
visual analysis and transcription have separate explicit actions.

## What the current models actually support

Official YuE2 exposes an editable melody/chord plan, score-conditioned covers,
and staged plan → semantic tokens → acoustic synthesis → decoding. Its supported
unquantized starting point is a BF16 NVIDIA card with 24 GB VRAM; community
quantized inference and LoRA training are separate implementations. Official
quality results use a stated candidate-selection protocol and decoder, so they
are not a benchmark of this Studio or evidence for a six-GB trainer.
[Official YuE2](https://github.com/multimodal-art-projection/YuE)

Official score edits produce a new complete recording. Preserving a melody in
notation is different from preserving the original audio outside a region.
AIPLAY already has a separate continuation-and-crossfade `replace_section`
workflow, alongside `extend_song`, score versions, mechanical score edits,
audio-to-score and MIDI/DAW export.
[YuE2 editing guide](https://github.com/multimodal-art-projection/YuE/blob/main/docs/editing.md)

Suno's useful product patterns include alternate take lanes, section insertion
and replacement, editable seams, lyric edits, and quick extension. Studio 2.0
adds automation, effects, MIDI editing/synthesis and chat-driven arrangement.
AIPLAY already has a DAW, effects, score editing and automation primitives; the
main opportunity is connecting these into a clear audition-and-commit workflow.
[Song Editor](https://help.suno.com/en/articles/6141505),
[Studio 2.0](https://help.suno.com/en/articles/13670529)

## 1. Chorus alternatives — implemented

Select a region, create two or three alternate performances, listen with a little
context before and after each seam, then keep one. Retain the original and store
which take was chosen. The versioned audition session reuses `replace_section`
and audio trimming/crossfades. Its take cards provide playback around both joins,
check the actual output length and require acknowledgement for short takes before
Keep. This workflow requires no new trained model.
Suno's editor is a useful interaction reference, not proof that our replacement
audio will have identical quality or timing.
[Suno section editor](https://help.suno.com/en/articles/6141505)

## 2. A musical identity kit — implemented

Save a short theme with its score, harmony, lyrics, style, seed and model/VAE
identity. Offer explicit choices: keep melody/change accompaniment, keep the
whole score/change instrumentation, or revise the composition. Generate an
opening, tension cue and closing from that kit, and attach versions to the
episode plan. Identity-kit records and their guided UI now connect the existing
score capabilities to reviewed requests, immutable cue variants and local Collab
plans. Rendering produces a new performance; it does not preserve the original
singer or waveform.
[YuE2 generation controls](https://github.com/multimodal-art-projection/YuE/blob/main/docs/generation.md)

## 3. Artifact reuse — next research stage

Store verified plan, semantic-token and latent artifacts by their content hashes.
An unchanged plan could feed new synthesis variants; cached latents could compare
decoders without another composition pass. The official staged API supports this,
but AIPLAY's public request validators currently expose the full-generation path,
not semantic-token replay (`server/music/yue.js`, `server/music/yue-gguf.js`).
This needs a pinned runtime adapter, compatibility checks and a measured benchmark.
Do not promise a speedup before timing it on the user's installed backend.
[Official artifact reuse and decoder comparison](https://github.com/multimodal-art-projection/YuE/blob/main/docs/generation.md)

## 4. Automated LoRA listening lab — next stage

The new region picker fixes what is trained; the next useful step is measuring
what changed. Keep one source region for training and a separate listening set.
Queue otherwise identical base/adapter generations, hide their labels during
audition, retain the seeds/settings, and record preference plus unwanted changes.
Build this from `train_lora`, `make_song`, `list_songs` and the existing player and
DAW analysis. The current before/after players are manual comparisons, not this
automated experiment. Neither a saved adapter nor a successful gradient test is
evidence that training improved a song; six-GB training remains unverified here.

## Larger research items to keep separate

Suno offers a dedicated Add Vocals workflow over an instrumental and advanced
stem extraction (up to twelve automatic stems, or selected instruments).
AIPLAY's current Demucs path supplies four stems: vocals, drums, bass and other.
YuE2 score covers are not a drop-in equivalent to isolated vocal addition over an
untouched backing track. A prototype could generate a new performance, extract
its vocal and mix it over the original backing, but alignment, bleed and vocal
quality need listening tests. Do not label that prototype native vocal inpainting
or promise Suno's isolation quality.
[Add Vocals](https://help.suno.com/en/articles/6882817),
[Suno stem modes](https://help.suno.com/en/articles/13925185)
