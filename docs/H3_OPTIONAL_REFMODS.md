# Optional H3 reference caches and Fizgig tweaks

RefMod is a reusable VAE reference cache. It saves visual latents in safetensors
with JSON metadata, then appends them to native H3 conditioning's `minimax_refs`.
It does not train H3 weights. Compression can remove facial detail and retains
background, clothing or style along with the subject. Neither integration has a
validated face-lock or voice-cloning claim in Studio.

The two independently installed MIT packs reviewed on 2026-09-30 are:

- [ComfyUI-MiniMaxH3Mod, f946208](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod/tree/f9462081e28794389b5a6c5067eb327412ad8ee7).
  Schema and behavior were read from `nodes.py`, `core.py`, and `BUNDLE_FORMAT.md`.
- [Fizgig H3 Tweaks, 5f8b48a](https://github.com/shootthesound/ComfyUI-Fizgig-H3-Tweaks/tree/5f8b48a3b54978b1b7d81ea0ddf5f581752a6218).
  Schema and behavior were read from `h3tweaks.py`.

Studio installs or downloads neither pack. Readiness checks inspect the running
engine's own node definitions and refuse missing or incompatible schemas. The
feature is available to portable, source and Desktop installs through the same
HTTP and MCP doors. Controls are absent on LTX and FastH3. Every new setting is
per render and defaults off.

`refMods` selects up to eight visual caches by relative ComfyUI dropdown name,
with strength 0–1 and 1–4 copies. `refModOptions` supplies retention and a positive
token budget (8192 default, 65536 ceiling). File discovery stays inside configured
`models/refmods` folders, follows no directory links, and bounds entries, depth,
file size and JSON/header size. The parser checks shape, dtype, tensor byte
offsets, actual token cost and metadata consistency without loading tensor data.
Embedded metadata and bounded legacy JSON sidecars are supported. Version-5
visual bundles are accepted; audio references can be inspected but are refused
for generation by this integration.

The native graph uses the reference checkpoint and matched reference Turbo
selection when any active cache is present. `MiniMaxH3RefModsLoader` and
`MiniMaxH3RefModApply` sit before the existing opening/closing frame and
soundtrack guide chain. Ordinary native picture references still reach the
text/vision encoder. Applying a saved cache does not establish a numbered prompt
label for it; the experimental upstream cache text encoder is not used here.

Creation accepts 1–8 existing reference images. The output graph loads only the
H3 video VAE and images, runs `MiniMaxH3RefModExtract`, and saves a new name through
the shared art queue. Full reference stores the resized encode. Compressed
reference pools to a bounded grid and may refine its reconstruction (0–500
steps); no diffusion model is loaded. The budget uses `error`, preserving an
explicit failure instead of silently dropping images. Existing names are
refused. Dropping or stopping a queued extraction releases its name. A submitted
extraction keeps both its queue slot and name until the engine confirms that
exact prompt has left its running and pending queues. A watcher timeout requests
targeted cancellation; an acknowledgement or unreadable queue cannot release
the reservation while the writer may still be running.

Fizgig patches the model after user LoRAs and before attention/sigma-shift nodes.
Detail/contrast, scene variation and prompt-strength dials all start at zero,
even though the upstream node defaults detail to 0.15. A zero patch creates no
node. RefMod plus Fizgig, continuation, video control, conditioning bridges,
sparse attention and block-cache combinations are refused until tested.

CPU validation: `node --test server/h3-refmod_test.js server/refmod-art_test.js`, plus
`node server/h3_graph_test.js`. Tests exercise actual native graph construction,
matched Turbo selection, guide ordering, parser/path/budget refusals, installed
schema checks, extraction graph queue submission, safe name release after Drop,
Stop and real-client timeout fixtures, inactive controls and the MCP/API mapping.
These are structural and mock checks; they do not measure rendering
quality, GPU compatibility or speed.
