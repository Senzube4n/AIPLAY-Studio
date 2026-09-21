# YuE2: practical next workflows

Research checked 2026-09-21. These are proposals, not features shipped by this
change. Prioritize the first two before another model integration.

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

## 1. Chorus alternatives with an honest commit step

Select a region, create two or three alternate performances, listen with a little
context before and after each seam, then keep one. Retain the original and store
which take was chosen. Reuse `replace_section`, audio trimming/crossfades and the
DAW's audio clips; add a versioned audition session and a small take-lane UI.
Check the actual output length and display a short-generation warning before
commit. This is a bounded product improvement; it requires no new trained model.
Suno's editor is a useful interaction reference, not proof that our replacement
audio will have identical quality or timing.
[Suno section editor](https://help.suno.com/en/articles/6141505)

## 2. A musical identity kit for an episode series

Save a short theme with its score, harmony, lyrics, style, seed and model/VAE
identity. Offer explicit choices: keep melody/change accompaniment, keep the
whole score/change instrumentation, or revise the composition. Generate an
opening, tension cue and closing from that kit, and attach versions to the
episode plan. The underlying `music_plan`, `score_check`, `score_edit`,
`score_render`, `score_compare` and `score_to_daw` tools already exist. The missing
work is an identity-kit record and guided UI. Always describe the result as a new
performance, not preservation of the original singer or waveform.
[YuE2 generation controls](https://github.com/multimodal-art-projection/YuE/blob/main/docs/generation.md)

## 3. Reuse a good composition before paying for another one

Store verified plan, semantic-token and latent artifacts by their content hashes.
An unchanged plan could feed new synthesis variants; cached latents could compare
decoders without another composition pass. The official staged API supports this,
but AIPLAY's public request validators currently expose the full-generation path,
not semantic-token replay (`server/music/yue.js`, `server/music/yue-gguf.js`).
This needs a pinned runtime adapter, compatibility checks and a measured benchmark.
Do not promise a speedup before timing it on the user's installed backend.
[Official artifact reuse and decoder comparison](https://github.com/multimodal-art-projection/YuE/blob/main/docs/generation.md)

## 4. A LoRA listening lab

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
