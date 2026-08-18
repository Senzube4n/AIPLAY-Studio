# Fact-check findings against the first drafts

Produced by the docs workflow's verification pass. Each is a claim a draft made
that does not survive contact with the code. Fix these before publishing anything.

## landing-page

**1. Claim:** Install step 1-2: "git clone … cd AIPLAY-Studio … npm install" then "node server/index.js".

**Correction:** That is not the shipped install flow and it skips a required step. `C:\temp\AIPLAYStudio\Start AIPLAY Studio.cmd` is the real entry point: it checks for Node, runs `npm install --omit=dev --no-audit --no-fund`, then runs `node scripts/setup.mjs --quiet-if-ready`, and only then `node server/index.js`. setup.mjs is what locates the ComfyUI install and writes `rig` into `~/.aiplay-studio/settings.json`. Starting the server directly leaves `config.rig` at its hard-coded default `D:\AI\aiplay-studio-bench` (C:\temp\AIPLAYStudio\server\config.js:24). README.md's own install section is three steps and does not mention git clone or npm at all.


**2. Claim:** "The server talks to one ComfyUI instance over its websocket API and keeps it warm. If yours is not at the default host and port, set that first."

**Correction:** Studio does not attach to a ComfyUI you started; it spawns and supervises its own. `C:\temp\AIPLAYStudio\server\comfy.js:71` does `spawn(config.python, [path.join(config.comfyDir,"main.py"), …])` with the flags and `--output-directory` from config. What the user configures is a FOLDER PATH — `AIPLAY_RIG` or `rig` in settings.json, the parent of `ComfyUI/main.py` — not a host and port. The Comfy port (default 8266) is chosen by Studio, not discovered.


**3. Claim:** "The Models screen lists every capability with its real byte count and its licence and fetches on request."

**Correction:** Three of the six capabilities cannot be fetched from that screen. In C:\temp\AIPLAYStudio\server\models.js: `stems` and `lyrics` both carry `files: []` with `viaPackage` (`demucs`, `faster_whisper`), and `ModelManager.download()` throws "…is fetched by its python package, not by this downloader." `videoLtx` carries a `gated` object and `download()` throws before touching the network. Those two package-managed entries also carry `approxBytes` (336101760, 3090000000), not the exact HF byte counts the other entries have — so "real byte count" is true for three of six, approximate for two.


**4. Claim:** Install step 3: "both video engines together are another 74.2 GB … Read the licence column before you take the video weights."

**Correction:** The arithmetic is right (34.48 + 39.69 = 74.17 GB), but LTX's 39.69 GB is not takeable from the Models screen at all. `videoLtx.gated` in models.js says: accept the licence at huggingface.co/Lightricks/LTX-2.5, run `huggingface-cli login`, then run `scripts/fetch_ltx25.py`. The built-in downloader has no credential path and the code comment says it must never grow one. The UI renders the instructions in place of a Download button (C:\temp\AIPLAYStudio\web\app.js:2401).


**5. Claim:** The three-step install implies node + npm is the whole prerequisite chain.

**Correction:** Two capabilities need Python environments that no step on the page mentions. Stems needs `demucs` installed into `config.systemPython` (config.js:114, deliberately the SYSTEM python, not the ComfyUI venv). Timed lyrics needs a separate whisper venv — `config.lyrics.python` defaults to `~/aiplay-whisper/venv/Scripts/python.exe` with stable-whisper/faster-whisper/ctranslate2, explicitly not the cu130 ComfyUI venv. And ComfyUI itself must be installed and run once before Studio will start (setup.mjs exits 1 if it finds ComfyUI but no venv).


**6. Claim:** Video comparison table, H3 row: "Audio — not in the measured run."

**Correction:** H3 ALWAYS renders audio; there is no video-only path. models.js: "H3 always renders audio even when you only want pictures; Studio discards it, because the song already exists." C:\temp\AIPLAYStudio\workflows\README.md repeats it verbatim, and 04-video-clip.json contains a `VAEDecodeAudio` node. The 308 s / 660 s figures therefore INCLUDE audio generation that is thrown away.


**7. Claim:** Video comparison table, H3 row: "Access — open download."

**Correction:** H3 is the one catalogue entry with a `region` field. `ModelManager.download(id)` throws an error carrying `needsRegionAck` unless the caller passes `{acceptRegion: true}` (models.js), and the UI renders the Download button with `disabled` until the region checkbox is ticked (web/app.js:2383, 2415). It is a blocking acknowledgement, enforced at the downloader so curl cannot skip it — the opposite of "open".


**8. Claim:** Capabilities table: Timed lyrics / Whisper large-v3 VRAM "not measured".

**Correction:** models.js declares `requires: { vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16 }` for the `lyrics` capability, with the note "About 36 s for a 2.5-minute song at int8_float16." The page states less than the code does.


**9. Claim:** Capabilities table gives H3 and LTX as "16 GB min" with nothing further; music as "6 GB min · 12 GB rec."

**Correction:** models.js also declares recommendations the page drops, and for H3 the recommendation is above the machine everything was measured on: H3 `vramRecGb: 24, ramMinGb: 32, ramRecGb: 64`; LTX `vramRecGb: 16, ramMinGb: 32`; music `ramMinGb: 16, ramRecGb: 32`; cover art `vramRecGb: 12`. Presenting 16 GB as the H3 figure without the 24 GB / 64 GB recommendation reads harder than the code.


**10. Claim:** "The four graphs behind the buttons are exported to workflows/ as ComfyUI-loadable JSON — nothing here is a pipeline you cannot open in the editor you already have."

**Correction:** Overclaim. C:\temp\AIPLAYStudio\scripts\export_workflows.mjs exports exactly four: 01-music, 02-music-audio-reference, 03-cover-art, and 04-video-clip — titled "AIPLAY · Video clip (MiniMax H3)". The LTX 2.5 pipeline, which is the DEFAULT engine (`config.video.engine = "ltx"`, config.js:325) and the one this page recommends, has no exported graph; `videoGraphLtx()` in server/workflow.js is not in the exporter's list. Stems and timed lyrics are not ComfyUI graphs at all. So the LTX pipeline is precisely a pipeline you cannot open in the editor you already have.


**11. Claim:** Speed table: "Cover art — FLUX.2 klein 4B, one cover — ~3 s."

**Correction:** Two qualifiers are dropped. models.js says "Roughly 3 seconds a cover ONCE LOADED", and its `requires.note` says cover art "cannot be resident alongside the music engine on a 16 GB card, so covers are drawn only while nothing is generating." The 3 s is warm-and-idle, not a cost you can add to a render.


**12. Claim:** The 34.5 GB H3 download and the 308 s / 660 s timings are presented as the same thing.

**Correction:** They are different weight sets. config.js's `pick()` comment and models.js's variants list both say the DiT measured here was the pure-int4 convrot build (11,337,536,848 bytes), which was pulled from its repo's main branch and now 403s, plus two VAEs cast locally to int8/bf16. The 34.5 GB the catalogue offers substitutes the w4a8 DiT (12,540,857,840) and the published fp16/fp32 VAEs. Worse for reproducibility: the download list ships only `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors`, while config.js `pick("loras", …)` prefers the 8-step LoRA that is NOT in the catalogue — so a fresh install runs the 20-step default against a 4-step LoRA, off its design point, and cannot reproduce the quality result behind the 660 s number.


**13. Claim:** Section 06 presents the video screen as a live feature of the product.

**Correction:** Video is off by default and gated behind a confirmation. `config.video.enabled = false` (config.js:309) and `when: "off"`; web/app.js:1678 puts a `confirm()` in front of it reading "Video clips are switched off. MiniMax H3 is about 34 GB, and its licence excludes the EU, the UK and South Korea." config.js records why: "nothing may ship to EU users without the lawyer already handling the ToS work. `enabled: false` is the default for exactly that reason."


**14. Claim:** Audio reference: "+26.26 dB SI-SDR, pearson 0.999" presented as the round-trip result, full stop.

**Correction:** That is the best case, and the code carries the ceiling and the spread the page omits. `config.audioRef.maxSeconds = 60` — only the first 60 seconds of an upload are encoded, because a full track OOM'd the card while the music stack was resident, so "drop in a song" is really "drop in a minute of a song." `config.audioRef.warnBelowSdrDb = 12` exists because reconstruction measures "22-25 dB on ordinary material, 6.6 dB on signals the autoencoder has never seen anything like"; README.md's generality table gives MP3 128k 22.0 dB, room reverb 23.9, pitch-shifted +3 semitones 17.8. Quote 26.26 dB as the clean-source ceiling, and state the 60 s cap.


**15. Claim:** The strength dial is listed as 0.85 / 0.80 / 0.60 with no upper bound and no mechanism.

**Correction:** The code and README carry a fourth row the page drops: "0.90+ — reference ignored (the trim removes under one step)." The mechanism is also worth naming, because the direction is counter-intuitive: it is not a blend weight, it is sigma-schedule trimming — `const keep = Math.max(1, Math.round(nSteps * audioRefDenoise))` in server/workflow.js:119. LOWER keeps more of the reference. The page's ordering happens to imply that but never says it, and a reader who assumes "strength" means "more reference" will turn it the wrong way.


**16. Claim:** Footer / masthead: "measured on a single RTX 4070 Ti SUPER", "measured on one machine".

**Correction:** Correct against the fact sheet and config.js, but it contradicts a shipped file: C:\temp\AIPLAYStudio\workflows\README.md says "They were measured on one RTX 4080 SUPER", generated from a hard-coded string at scripts/export_workflows.mjs:201. One of the two is wrong in the repo; the landing page matches the fact sheet, so fix export_workflows.mjs and regenerate, or a reader who opens the workflows sees a different GPU.


**17. Claim:** HTML theming: dark palette defined only under `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) }`.

**Correction:** There is no `:root[data-theme="dark"]` block, so a viewer whose system is set to light and who explicitly toggles the artifact to dark keeps the light palette. Add a third block redefining the same tokens under `:root[data-theme="dark"]` so the toggle wins in both directions. (The other two HTML requirements pass: the complete palette is on bare `:root`, and `body` sets `background:var(--bg)` explicitly.)


**18. Claim:** The file opens with `<!doctype html>`, `<html lang="en">`, `<head>…</head>`, `<body>`.

**Correction:** The Artifact publisher wraps the file in its own `<!doctype html><head>…</head><body>` skeleton, so these nest and the `<title>`, `<meta name=description>` and `<link rel=icon>` end up inside the body. Write page content only — no doctype, html, head or body tags of your own — and pass the favicon through the tool's `favicon` parameter rather than the inline SVG data URI.


**19. Claim:** "Paying 4× the memory for fp32 does not buy you a better master here" (quoting the 35.34 / 32.38 / 35.46 dB pairwise SI-SDR).

**Correction:** The ratio is 3.93× (9,828,345,396 / 2,502,161,682), so 4× is fine — but the code contradicts the number being quoted. config.js:  "The repo also publishes `minimax_music3_dit_fp32.safetensors` (9.15 GB), which we have never downloaded and never measured", and models.js's fp32 variant note says "Never measured here." Meanwhile scripts/fp32_audio_test.mjs, scripts/night_fp32.py and scripts/night_fp32_results.json exist and a fp32 run was recorded. Those two comments are stale and also disagree on the file size (9.15 GB vs 9,828,345,396 = 9.83 GB). Publishing the fp32 figure on the landing page while the code says fp32 was never measured is a contradiction a reader can find; fix the comments before shipping the claim.


## blog-post

**20. Claim:** The whole audio-reference section, presented as a shipped feature: "Drop a file into the Audio reference box" / "encode out of process, write a .latent, and let stock LoadLatent pick it up."

**Correction:** BLOCKER — this capability is not wired end to end for anyone but the author. C:/temp/AIPLAYStudio/scripts/dav_encode.py line 41 hardcodes the owner's own cache: CKPT = glob.glob(r"C:\Users\chesy\.cache\huggingface\hub\models--SimpleTuner--MiniMax-Music-3-Encoder\snapshots\*\audio_vae\diffusion_pytorch_model.safetensors")[0] — the [0] raises IndexError at import time on any other machine. The SimpleTuner encoder checkpoint has NO entry in server/models.js CATALOG, so the Models screen cannot fetch it, and neither README.md nor INSTALL.md mentions it anywhere. server/index.js:1236 spawns it under config.systemPython, which defaults to a hardcoded %LOCALAPPDATA%\Programs\Python\Python310\python.exe that must already have torch, safetensors and numpy. Fix the code (env-var/HF-cache resolution + a catalogue entry) before publishing, or add an explicit line to the post: the audio-reference path currently needs a manual encoder-weights fetch and a Python with torch installed.


**21. Claim:** "there is no model-size switcher, because it would be a knob whose only effect is a larger download."

**Correction:** False. web/index.html lines 228-232 ship a Precision selector (#qModel) with int8 · 2.5 GB / fp16 · 4.9 GB / fp32 · 9.8 GB (untested), and server/workflow.js honours model: fp16|fp32 by swapping config.models.ditFp16 / ditFp32. Rewrite as: the switcher exists as an advanced override, int8 is the default, and changing it only changes disk use.


**22. Claim:** "Pairwise SI-SDR across int8 / fp16 / fp32 came out 35.34 / 32.38 / 35.46 dB — fp32 is not a point the others converge toward."

**Correction:** These three numbers appear nowhere in the repo, and three shipped files say the opposite. server/config.js:196-200: fp32 "we have never downloaded and never measured". server/models.js variant note: "Never measured here." web/app.js:380: "fp32 is the full-precision original and has NOT been compared against the other two", and the UI option is labelled "(untested)". scripts/night_fp32_results.json does contain a precision-fp32 run, so the code comments are stale — update all three, or drop the three-way claim and keep only the int8-vs-fp16 result (4.2 dB SNR / +10.8 dB NMR), which IS in the code.


**23. Claim:** "One more measured trick, free in either engine: for a seamless loop, pass the same picture as both first and last frame." — placed directly under the 121 s LTX row.

**Correction:** Not free in LTX, which is the shipped default engine (config.video.engine = "ltx"). server/workflow.js:512-522 is explicit: first+last takes the LTXVAddGuide path, which is the vendor's SINGLE-PASS template with no latent upscaler — "asking for a loop changes the graph's shape rather than adding a node, and it gives up the two-pass speed advantage". The 121 s figure is the two-pass, non-looping path, so a looping LTX clip is slower than 121 s. Separately, the 6.00 / 1.62 divergence numbers are recorded only for the LTX guide path (server/index.js:1079-1081, attributed to guides at strength 0.7); nothing measured an H3 loop. Say: free in H3; in LTX it costs the two-pass schedule.


**24. Claim:** Models table lists "Stems — HTDemucs 336 MB" and "Timed lyrics — Whisper large-v3 3.1 GB" as downloads, and "[the Models screen] fetches it only when you press the button."

**Correction:** Neither is fetchable by that button. server/models.js gives both files: [] plus viaPackage, and download() throws "is fetched by its python package, not by this downloader". web/app.js:2360-2363 renders "Needs the demucs python package" in place of a button. INSTALL.md line 205 already says it plainly: "Stems and timed lyrics are the rough edges. They are Python packages (demucs and faster-whisper), not files Studio can fetch." Mark those two rows "via pip" and add one install line.


**25. Claim:** "Other runtime dependencies: ws (MIT). That is the list."

**Correction:** True of the Node server only. Stems (demucs), timed lyrics (faster-whisper, in its own venv at ~/aiplay-whisper) and audio reference (torch + safetensors + numpy in config.systemPython) all need Python packages outside it — INSTALL.md has a whole section titled "Why Studio uses three different Pythons". Qualify as "the server's only runtime dependency".


**26. Claim:** "Timed lyrics (Whisper large-v3, MIT, 3.1 GB) transcribes the sung vocal back and aligns it."

**Correction:** server/models.js lyrics note: "We already know the words, so this is alignment rather than transcription — the model supplies timing and the known lyrics supply the text." Reword to: aligns the lyrics you already wrote against the sung vocal. This also explains the 97.9% "timed by direct match" figure, which is a match rate against known text, not transcription accuracy.


**27. Claim:** "finds your ComfyUI (it checks the usual places across every drive, and asks if it cannot find one)"

**Correction:** scripts/setup.mjs:44 checks drive letters C, D, E and F only, plus three home-directory locations, one level deep. Say "checks the usual places on C through F". README.md line 23 carries the same overstatement and should be corrected with it.


**28. Claim:** "The four real pipelines are exported to workflows/ as ComfyUI-loadable JSON — straight out of the code that submits them... Drag one onto the canvas and you are looking at exactly what the app runs", including "the sigma schedule, the video shift that neither official template exposes."

**Correction:** Two defects. (a) The exported video graph 04-video-clip.json is MiniMax H3, but the shipped default engine is LTX 2.5 (config.video.engine = "ltx"); scripts/export_workflows.mjs:31 imports videoGraph and never videoGraphLtx, so none of the LTX values the post praises (the two literal sigma strings, the latent x2 upscaler, the locked dual CFG) is in workflows/ at all. (b) 04-video-clip.json names minimax_h3_fl2va_pruned_int4_convrot.safetensors and minimax_h3_video_vae_int8_convrot.safetensors — exactly the rig-local files server/models.js says cannot be fetched (the int4 DiT was pulled from its repo, the cast VAEs are unpublished), so on a fresh install that graph fails in ComfyUI with "value not in list". Either export the LTX graph (making it five) or say "four graphs; the video one is the H3 path, and it names this rig's quantised files".


**29. Claim:** "Cover art (FLUX.2 klein 4B, Apache-2.0, 12.5 GB, 8 GB VRAM) draws a cover in ~3 s."

**Correction:** Only once resident. server/art.js:14-16: "22.8 s for the first image (cold, loading 12.4 GB of weights) against 3.3 s each once resident". models.js states it correctly as "roughly 3 seconds a cover once loaded" — add the qualifier, in both the prose and the side-capabilities section.


**30. Claim:** "LTX 2.5 ... requires a paid agreement above USD 10M annual revenue" (in the collected-limits list).

**Correction:** server/models.js is deliberately precise: "$10M annual revenue OR MORE (§2.1 — exactly $10M is above the line)". "above" excludes exactly $10M. The post's earlier body text ("at USD 10,000,000 annual revenue or above") is right; make the limits bullet match it.


**31. Claim:** "a fifteen-line batch script you can read in full."

**Correction:** "Start AIPLAY Studio.cmd" is 70 lines (64 non-blank), roughly 40 of them executable. The .cmd's own header comment repeats the same figure and should be corrected too. Either say "a seventy-line batch script" or drop the count.


**32. Claim:** "fresh render | 39 s of audio in 65 s — 1.66x realtime" presented as the shipped characteristic.

**Correction:** Not wrong against your measurements, but flag the split: the value the code actually ships for ETA is server/config.js:207-209, speed: { realtimeRatio: 1.53 }, commented "135 s of audio in ~207 s => ~1.5x realtime". README.md quotes 1.66x, config quotes 1.53x. Reconcile the two before a reader runs the app and sees a 1.5x estimate.


**33. Claim:** (Repo defect the post contradicts, not a post error) The post correctly names the rig as an RTX 4070 Ti SUPER and invites readers to check the repo.

**Correction:** workflows/README.md line 18 — shipped and public — says "They were measured on one RTX 4080 SUPER." Wrong card. Also server/config.js:342-347 describes the H3 territory exclusion as covering only "the European Union", while server/models.js correctly lists European Union, United Kingdom and South Korea. Fix both, since the post's whole credibility argument is that the repo backs the numbers.


## https://claude.ai/code/artifact/8293652f-f34f-4a98-9463-e04aa48e1b02

**34. Claim:** "Free disk space. 12 GB for music alone. About 62 GB if you eventually want every feature."

**Correction:** 62.28 GB is music + cover + stems + lyrics + H3 ONLY. It omits LTX 2.5, which the doc's own Models table lists and which config.js sets as the DEFAULT video engine (`engine: "ltx"`). Summing every `bytes` field in server/models.js: music 11.92 + cover 12.45 + stems 0.34 + lyrics 3.09 + H3 34.48 + LTX 39.69 = 101.97 GB. Write: "About 67 GB if you want everything through LTX 2.5, or about 102 GB if you fetch both video engines."


**35. Claim:** "Open http://127.0.0.1:4173/api/status … You want: \"backend\": { \"ok\": true, \"torch\": …, \"device\": … }"

**Correction:** There is no top-level `backend` key. server/index.js:389-396 returns it nested one level down: `{ "engine": { "ready": true, "backend": { "ok": true, … }, "torch": …, "device": … } }`. Show `"engine": { "backend": { "ok": true, "torch": "2.13.0+cu130", … } }` or a reader searching for `"backend":` at the top of the JSON will not find it where the doc puts it.


**36. Claim:** "The four pipelines Studio actually submits are in workflows/ as ordinary ComfyUI JSON."

**Correction:** True for three of four. `config.video.engine` is `"ltx"`, and `videoGraph()` (server/workflow.js:367-370) dispatches on that to `videoGraphLtx` — a 29-node LTX graph I ran and confirmed. The committed workflows/04-video-clip.json is the 16-node MiniMax H3 graph, and workflows/README.md documents H3 only. Compounding it, scripts/export_workflows.mjs:132-133 still reads `config.video.seconds/width/height/steps`, all of which are now `undefined` (they moved under `config.video.engines.h3`), so re-running the exporter will not regenerate that file correctly. Either export an LTX workflow and fix the exporter, or say "three of the four pipelines, plus the H3 video graph — the default LTX video graph is not yet exported."


**37. Claim:** "Models land in <your-comfy-folder>\ComfyUI\models\ under diffusion_models, text_encoders, vae and loras — ordinary ComfyUI locations."

**Correction:** Four folders named, five used. LTX 2.5's latent spatial upscaler goes to `latent_upscale_models` (server/models.js:249), and its own comment says "Not optional. The whole speed advantage is sampling at half size and upscaling the LATENT — without this there is no second pass." Add `latent_upscale_models` to the list.


**38. Claim:** "It is a fifteen-line batch file rather than an .exe on purpose"

**Correction:** `Start AIPLAY Studio.cmd` is 70 lines, roughly 35 of them non-blank and non-comment. The claim is inherited from the file's own header comment, which is wrong in the same way. Say "a short batch file you can read in one screen" and drop the count, or fix both places.


**39. Claim:** Launcher step 4: "Starts the app and opens your browser at http://127.0.0.1:4173."

**Correction:** Reversed. The .cmd runs `start "" http://127.0.0.1:4173` BEFORE `node server/index.js`, so on a cold first launch the browser can arrive at a connection-refused and needs a refresh. Say "Opens your browser at http://127.0.0.1:4173 and starts the app — on the very first launch the tab may need one refresh."


**40. Claim:** "It looks in your home folder, Documents, Desktop, and on every drive from C: to F: for ComfyUI, AI, AI\ComfyUI, ComfyUI_windows_portable and StabilityMatrix"

**Correction:** Two lists conflated. In scripts/setup.mjs `guess()`, the home / Documents / Desktop roots are only `…\ComfyUI`; the five-name list (`ComfyUI`, `AI`, `AI\ComfyUI`, `ComfyUI_windows_portable`, `StabilityMatrix`) applies to drive roots C: through F: only. Correct phrasing: "in your home folder, Documents and Desktop for a ComfyUI folder, and on every drive from C: to F: for ComfyUI, AI, AI\ComfyUI, ComfyUI_windows_portable and StabilityMatrix."


**41. Claim:** "Every capability is listed with its real byte count, its licence, what it needs from your hardware, and one button." followed by a six-row table with no distinction.

**Correction:** Two of the six rows have no working button. Stems and Timed lyrics carry `files: []` in server/models.js and `download()` refuses them outright: "…is fetched by its python package, not by this downloader." Their sizes are `approxBytes` round numbers (336,101,760 and 3,090,000,000), not exact byte counts like the four file-backed rows. The doc corrects this four bullets later, but the table should mark those two rows (e.g. "via pip") rather than letting "one button" cover all six.


**42. Claim:** "The four pipelines Studio actually submits are in [workflows/](workflows/)" — a relative link.

**Correction:** In the published artifact `<a href="workflows/">` resolves against the artifact host and is a dead link (same for any other repo-relative path). Use the absolute URL: https://github.com/Senzube4n/AIPLAY-Studio/tree/main/workflows


**43. Claim:** "All the timings in this guide were measured on an RTX 4070 Ti SUPER (16 GB)" — correct, but the repo contradicts it.

**Correction:** Not a doc error; a repo error the doc will be checked against. workflows/README.md:18 says the values "were measured on one RTX 4080 SUPER". config.js:219 and every other source say RTX 4070 Ti SUPER. Fix workflows/README.md before launch or the two documents disagree in public.


**44. Claim:** "The parts that matter are \"ok\": true and a torch version ending in +cu130 or higher."

**Correction:** Slightly stronger than the code. `assertBackend()` (server/comfy.js:143-155) returns `ok: false` only when `cudaFused === false`; if the `comfy_kitchen backend cuda` line never appeared at all, `cudaFused` stays `null` and it returns `ok: true`. So `"ok": true` means "no disabled line was seen", not "fused kernels confirmed on". The doc's own `findstr /i "comfy_kitchen"` step is what actually settles it — reorder so that check is the proof and `"ok": true` is the quick glance.


**45. Claim:** "Before you start" table: "An NVIDIA graphics card. 6 GB of VRAM minimum, 12 GB recommended." with no caveat.

**Correction:** The 6 GB tier is unproven on real hardware — config.js:83-86 says so explicitly ("Measured on a 16 GB card plus --reserve-vram simulation … UNPROVEN ON REAL HARDWARE. Do not publish a minimum-VRAM claim from this"), models.js:70 repeats it, and §6 of the doc states it honestly. The first table is the one most readers will act on, so carry the caveat there too: "6 GB minimum (simulated, not yet proven on a real 6 GB card — see §6), 12 GB recommended."

