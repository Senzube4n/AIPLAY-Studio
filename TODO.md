# AIPLAY Studio fork — to-do

Rules for all of it: works on NVIDIA **and** AMD, on portable / from-source /
ComfyUI Desktop installs. Never install or replace torch/ROCm in a user's
ComfyUI. Never run two GPU jobs (e.g. image + music) at the same time.

## 0. Launcher crash — `[comfy] exited with code 1`

- [x] **Root cause:** launched from a cmd window, Python's piped stdout is
  cp1252. rgthree-comfy prints 🎉 → `UnicodeEncodeError` inside logging →
  ComfyUI exits 1, six restarts, gives up. The music-only launcher worked only
  because music-only mode never started ComfyUI.
- [x] Fix: `server/comfy.js` `pythonEnv()` sets `PYTHONUTF8=1` and
  `PYTHONIOENCODING=utf-8` for the engine process.
- [x] Verified by the user: Studio starts from the launcher.

## 1. Models screen — done 2026-09-16

- [x] **Unreadable deep-blue names** — capability names with a publisher link
  were bare `<a>` tags rendering the browser default `#0000ee`. Names now use
  `--ink` (primary on hover); every other link on the screen uses `--primary`.
- [x] **Awkward spacing at the top** — `#models` stacks on one 12px gap instead
  of per-block margins; the "Show me this row" buttons were 96px tall
  (`.btn.ghost` `flex: 0 0 96px` inside a column) and are now label-sized.
- [x] **Models folder** — panel at the top: path, Browse… (native Windows
  folder dialog via the server), Check (counts per subfolder before adopting),
  Use this folder (saves `modelsDir` + `modelsDirPinned`; setup no longer
  overwrites it; restart required). The engine gets a generated
  `extra_model_paths.aiplay.yaml` for any models folder outside the install.
- [x] **Stand-ins for missing catalogue files** — per card, "Use a file you
  already have": files from the same model folder (unet ≡ diffusion_models,
  clip ≡ text_encoders), ranked by name similarity, never a file the catalogue
  already uses. Saved as `modelOverrides`; presence counts it; the engine door
  renames `*_name` loader inputs before the ledger records the graph (dry run
  confirmed the record names the stand-in). Live, no restart. Undo per file.
  Set here: MiniMax int8 DiT → `minimax_music3_dit_fp16` (music engine Ready).
- [x] **On disk, not in the catalogue** — collapsible list of every weight
  file in every folder the engine loads from, labelled by safetensors header.
- [x] **Music model picker** — one dropdown of concrete choices (MiniMax
  Music 3 int8/fp16/fp32, YuE2 GGUF Q4/Q8, YuE2 3B), each marked ready or
  why not, computed server-side from what is on disk (`musicModels` in
  /api/status and /api/models; POST /api/music `action: "model"`). Shown at
  the top of the Models screen AND as the Music tab's Model select; both stay
  in step with Advanced → Precision. The MiniMax build is remembered
  (`music.precision` pref) and is the default for /api/generate.
- [x] **Less at once** — "For this machine" is a collapsible panel (closed,
  headline visible); the catalogue is split into collapsible sections
  (Music & audio open; Images, Video, 3D closed; open state kept across
  repaints; "Show me this row" opens the right section).
- [x] **YuE2 through ComfyUI** — new music engine `yue2-comfy`: renders any
  YuE2 checkpoint in a `checkpoints` folder (found by name, e.g.
  `yue2_3b_bf16`) with ComfyUI's native nodes, using the graph from ComfyUI's
  "Text to Music (YuE2)" template (optional ABC plan by chain-of-thought mode,
  32 steps, cfg 1, dpm_2 / sgm_uniform). Listed in the music model picker as
  "YuE2 3B · bf16 — via ComfyUI"; filed as model `yue2` (CC BY-NC rights row).
  Rendered (2026-09-16): user's own song (66 s audio in 128 s, same per-token
  speed as ComfyUI Desktop) and the smoke test (30 s in 56 s, peak −1.7 dB /
  RMS −18.5 dB).
- [x] Status line and startup console line name the real engine and sampler
  (were hard-coded "shift 5 · 15 steps", MiniMax's).
- [x] Length ceiling per engine: YuE2 through ComfyUI goes to 6:00 (slider and
  server clamp); others stay at 5:00.
- [x] **MiniMax Music 3 marked buggy on AMD** (picker note, Models card,
  Music tab note, README table). Smoke-test retry on ROCm 10.1: 30 s file at
  constant 0 dBFS (broken); first run was reported unlistenable.
- [x] **"For this machine" knows about the AMD bug** (2026-09-16) —
  `readMachine()` now carries `gpu.vendor`, and `recommendFor()` marks a
  MiniMax music pick on an AMD card with `amdWarning` (the measured 0 dBFS
  evidence) plus a `music-amd` note naming YuE2 through ComfyUI as the
  alternative. It does NOT swap the pick silently: the pick is the engine the
  user selected. Pinned in `fit_test.js`, including that it stays silent on
  NVIDIA and when YuE2 is already selected.
- [x] **`server/localmodels_test.js`** (2026-09-16) — 47 assertions in a temp
  dir: the scan (top level only, weights only, a zero-byte download skipped,
  alias shelves), the extra_model_paths YAML (apostrophe escaping, every folder
  mapped, read back through `extraBases`), and the stand-in rename — the prompt
  never touched, object identity kept when nothing matches. Registered in
  `.githooks/pre-commit`; the census passes.
- [x] File names shown without their extension in the picker, stand-ins and
  the "not in the catalogue" list (values keep it).
- [ ] Kept for the worst case: `VAEDecodeAudioTiled` (1920/128) for very long
  YuE2 songs if the plain decode runs out of memory. Plain decode is fine so far.
- [ ] Not done: stand-ins from folders other than the models folder (the
  Desktop's shared folder etc.) — listed, but not offered as stand-ins.

## 2. One launcher (replaces both .cmd files)

- [x] **Launcher window** (2026-09-16). Node-served local page
  (`launcher/launcher.mjs` + `launcher/index.html`) in an Edge / Chrome `--app`
  window, loopback-only, no build step:
  - Full Studio / Music only cards, each naming the music model it will use
    and warning when that model cannot run here.
  - System check from `scripts/setup.mjs --json` plus a models scan: Node,
    GPU, CUDA/ROCm torch + mismatch, ComfyUI install, models folder, YuE2
    checkpoint, MiniMax (buggy on AMD), native GGUF, ffprobe. Re-check button.
  - Launch → stepper (check setup → start Studio → ComfyUI ready → open);
    **opens Studio only after `/api/status` reports `engine.ready`**. Live log
    over SSE. Stop kills Studio + ComfyUI (`taskkill /T`). Single instance.
  - Verified: music-only launch waited ~47 s for ComfyUI, then opened; stop
    left no processes.
- [x] **Music only uses YuE2 through ComfyUI** when a ComfyUI install and a
  YuE2 checkpoint exist (starts ComfyUI; `engineExpected` in /api/status).
  Full Studio remembering an unusable native GGUF switches to YuE2 via ComfyUI.
- [x] **`AIPLAY Studio.exe`** (2026-09-16) — windowless front door with the
  AI PLAY icon, built by `node scripts/build-launcher-exe.mjs` from
  `launcher/exe/AiplayLauncher.cs` with Windows' own .NET Framework 4 `csc`
  (no Tauri, nothing installed). Finds Node 20+ (registry PATH too), runs npm
  install in a console if packages are missing, runs the launcher under a
  hidden console (children inherit it: no console pop-ups), keeps a tray icon
  (click: reopen launcher · Open Studio · Stop Studio and quit), logs to
  `%USERPROFILE%\.aiplay-studio\launcher.log`. `launcher/aiplay.ico` comes from
  the 400 px PNG inside `web/assets/aiplay-logo.svg`; sizes below 256 px are
  classic bitmap entries (System.Drawing mis-decodes PNG entries at 16–48 px).
- [x] Launcher page uses the AI PLAY mark and its colours (magenta → pink →
  orange → yellow); logo served at `/logo.png` and used as the favicon.
  `/api/show` reopens the window; `[hidden]` now beats `.card`'s display:flex.
- [x] **Pick the ComfyUI install and models folder from the launcher**
  (2026-09-16) — Change… on those two rows opens the same native folder dialog
  the Models screen uses (`pickFolderDialog`, now with a caption argument).
  Models: saves `modelsDir` + `modelsDirPinned` and reports what was found.
  ComfyUI: accepts either the folder containing `ComfyUI\main.py` or that
  folder itself, refuses anything else, and drops the derived keys (`python`,
  `comfyExtraArgs`, `launchFrom`, `torchBackend`) so setup re-reads them.
  Refused while Studio is running, since the folders are read at start.
- [x] **Optional code signing** in `scripts/build-launcher-exe.mjs`:
  `AIPLAY_SIGN_SHA1` (a certificate in the Windows store, preferred — no
  password on a command line) or `AIPLAY_SIGN_PFX` + `AIPLAY_SIGN_PASSWORD`,
  timestamped (`/tr`, SHA256) because an untimestamped signature dies with the
  certificate. Verifies with `signtool verify /pa` and says plainly when the
  signature would still show SmartScreen (self-signed).
- [x] **Retired `Start AIPLAY Studio.cmd` / `Start YuE2 Music.cmd`**
  (2026-09-16) — deleted; README, INSTALL.md, API.md, docs/index.html,
  docs/YUE2_GGUF.md, setup.mjs's multi-install hint and `scripts/package.mjs`
  now name the launcher. `server/docs_test.js` checks the launcher's own npm
  guard and that its two modes reach `start-music.mjs` / `server/index.js`
  (104 pass).
- [ ] Unsigned by default: SmartScreen warns on first run from a downloaded
  zip. Needs a real certificate; the build step is ready for one.

## 3. Carried over from setup

- [x] **VRAM tier on this 16 GB AMD card — measured 2026-09-16, no change
  needed.** Six 30-second YuE2 renders (`cot: off`, 32 NAR steps, fresh seeds,
  one job at a time): tier `auto` (`--lowvram --async-offload 4`) 64 s, 38 s,
  24 s, 24 s; tier `high` (no `--lowvram`) 39 s, 24 s, 24 s. Every slow figure
  is the first render after an engine start — warm, both tiers land on 24 s.
  So `--lowvram` costs nothing here, which matches config.js's own note that it
  reads as a no-op under dynamic VRAM. `auto` stays the default; a repeat with
  identical seed + caption returns the cached file in 5 s, so any future
  measurement must vary the seed.
- [ ] Auto cover art is off (it queued an image right after a song). Consider
  making "never run post-processing while a music job is active or just
  finished" explicit rather than relying on the toggle.
- [ ] Commit the fork changes on a branch. (The working tree IS a git
  repository — `.git` is present — so this is a `git switch -c` away.)

## 4. User list, 2026-09-16 — worked in this order

Principle for all of it: **lazy by default.** A normal person clicks, clicks,
generates. Anything technical lives behind *Advanced* and never has to be
touched.

1. [x] **YuE2 with a random seed fails silently.** ROOT CAUSE (ledger,
   2026-09-16 03:25): 🎲 random set ONE seed when pressed and Create never
   re-rolled it, although the note promised "a fresh seed each time". Repeated
   Create sent an identical graph 18 times; ComfyUI served each from cache in
   0.00 s (`cached: true`), and the runner filed "the newest aiplay_* file" —
   the previous song — as a success. FIXED: random re-rolls on every Create;
   the runner reads the output file from ComfyUI's history and flags a cache
   hit (`cached`, `note`) instead of passing an old song off as new; a cache hit
   is not re-filed in the library; every song's start / done / WARNING /
   FAILED goes to Studio's console (the launcher's Log); the Music page shows a
   failure or a cache hit under Create. Verified live: repeat request →
   `cached=True` with the note, console printed the WARNING line.
2. [x] **GGUF downloads "do nothing".** The downloader itself works (measured:
   1.09 GB in ~25 s, progress tracked, cancel keeps a resumable .part). What was
   broken: the Models card showed no progress at all (only a button to the
   Music tab), and on a non-NVIDIA card the 3.7 GB download ends in a runtime
   probe that cannot pass. FIXED: progress bar + Cancel on the Models card
   (polled while installing); the install is refused up front on non-NVIDIA
   cards with the reason, and the Music tab's Install button stays disabled.
3. [x] **GGUF on AMD — not possible as asked; replaced with what works.** The
   YuE2 GGUFs are packed for audio.cpp (`general.architecture = audiocpp`), and
   the installed ComfyUI-GGUF only accepts image and text-encoder architectures
   (flux, sdxl, wan… / t5, llama, qwen3…). No ComfyUI node loads a YuE2 GGUF,
   so auto-installing one would not help. INSTEAD: new catalogue row "YuE2 3B
   for ComfyUI (int8)" — Comfy-Org's official 3.96 GB checkpoint, hash-pinned,
   one-click download on the Models screen, runs through ComfyUI on NVIDIA and
   AMD; an existing bf16 counts as having it. `yue2-comfy` maps to this row,
   so "For this machine" no longer quotes the 7.8 GB Python kit. Not yet
   rendered on AMD in int8 (bf16 is what is measured).
4. [x] **"Every take is a fresh render" — false for ComfyUI, fixed.** The line
   was the Python YuE2 kit's (a new process per song, which IS a reload) shown
   for YuE2 through ComfyUI too, where the model stays loaded: first song after
   a start 38–64 s, warm 24 s. Also shown with the Python kit's timing ratios.
   FIXED: YuE2-via-ComfyUI has its own measured estimate and says "model
   already loaded" / "the first song also loads the model"; the Python kit's
   note says what is true of it. The runner records which model ComfyUI holds
   (`loadedModel` in /api/status); a song with a different model unloads the
   previous one first (`/free` unload_models), and so does choosing another
   model in the picker. Optional **Load now** (a 1-second warm-up whose output
   goes to ComfyUI's temp folder, never a song) and **Unload** under the model
   picker. Verified live: Load 18 s with no output file written; Unload clears
   it; a song re-marks it loaded; console lines for each.
   Also found and fixed on the way: the Music tab never sent chain-of-thought
   or step choices for YuE2 through ComfyUI (the server used its defaults), and
   the outcome warning from item 1 was erased by the next status poll.
5. [x] **Launcher: X also closes Studio** — a Settings card in the launcher,
   "Closing this window also stops Studio", off by default
   (`launcherCloseStopsStudio` in settings.json). Verified live: with it on,
   closing the window stopped Studio and ComfyUI and freed port 4173.
6. [x] **Advanced settings in the launcher** — a closed "Advanced settings"
   section under Settings, read only when opened:
   - Folders: models / output / input, each Change… (native picker) or
     Default; `outputDir` / `inputDir` / `modelsDir` in settings.json
     (`config.inputDir` now honours `inputDir`).
   - "Use the launch flags from your ComfyUI install" on/off.
   - ComfyUI launch options from a curated catalogue (server/comfyargs.js):
     Performance (attention: PyTorch / CK / Sage / Flash / split / quad,
     compiler, CUDA graphs, non-blocking, --fast, channels-last,
     deterministic, Triton), Memory (dynamic VRAM, VRAM mode, reserve VRAM,
     headroom, async offload, smart memory, pinned memory, fast disk,
     disable mmap, mmap .pt, cache mode, cudaMalloc), Precision (global,
     diffusion model, VAE, CPU VAE, text encoder, upcast), Custom nodes.
     Only flags THIS install's cli_args.py defines are offered (30 here).
   - A choice replaces its whole family in the tier and install flags, value
     included, so ComfyUI never gets two exclusive flags; Studio-owned flags
     (port, listen, folders, model paths) cannot be set. Preview of the exact
     flags; Save refused while Studio runs. `server/comfyargs_test.js` (22
     assertions) registered in the pre-commit hook.
   - Verified live: PyTorch attention + no-mmap + reserve 1 GB saved, the
     preview swapped CK for PyTorch and kept the Desktop model-paths YAML,
     and a real launch's ComfyUI command line carried exactly those flags.
7. [x] **Sweep, last — done 2026-09-16.**
   - UI: all 17 Studio screens opened in the browser: no JS errors, no
     console errors, no horizontal page scroll (the flagged wide elements sit
     inside their own scroll areas). Launcher checked at 1280 and 720 px.
   - Found and fixed: sidebar said "Powered by MiniMax-Music3 · YuE2 3B" with
     YuE2 selected (now names the engine in use); `yue2-comfy`'s engine entry
     still pointed at the Python kit's catalogue row; the MCP make_song tool
     could not request `yue2-comfy`; the Music tab never sent YuE2-via-ComfyUI
     plan/step choices; the outcome warning was erased by the next poll.
   - Model detection via /api/models: MiniMax ready through the fp16 stand-in,
     YuE2 for ComfyUI ready through the existing bf16, native GGUF blocked with
     its reason, picker marks MiniMax "buggy on AMD", recommendation names
     YuE2 for ComfyUI as already on disk.
   - Full pre-commit gate: 123 suites; 2 regressions from this work fixed
     (yue2_docs_test, music-gguf-input_test), NOTICE regenerated. Still failing
     and NOT caused here (they fail on a clean HEAD checkout too, or need this
     upstream developer's machine): score/store_test (real receipt hash),
     mcp-image_test (declared parameter), provenance_test (verbatim quote),
     mesh/catalogue_test, control/pose_test + vace_test (live ControlNet
     nodes), daw/production_export_test + vfx/routes_ram_test (python venv at
     D:\AI\aiplay-studio-bench).
   - Open: the picker lists native GGUF as "not installed" on AMD; the page
     only says "NVIDIA only" once the setup panel is opened.
8. [x] **Attention benchmark — done 2026-09-16.** Four cold-start runs, same
   30 s song and seeds, RX 9060 XT, ROCm 10.1:

   | | CK attention | PyTorch attention |
   |---|---|---|
   | YuE2 3B bf16 (full plan) | **57 s** | 95 s |
   | MiniMax Music 3 | **201 s** (≈3.5 s/it) | 213 s (≈3.7–3.85 s/it) |
   | MiniMax audio | broken — flat 0 dBFS | broken — flat 0 dBFS |

   YuE2 audio was identical under both (mean −15.8 dB, peak −1.5 dB). CK is
   faster for both models, so `comfyOptions.attention = --use-ck-attention` is
   saved as Studio's default (Studio only; ComfyUI Desktop untouched). MiniMax
   stays broken on AMD whichever attention is used — attention is not the cause.
   Original request: Four runs: PyTorch
   attention vs CK attention (`--use-ck-attention`, what ComfyUI Desktop uses
   now) × MiniMax Music 3 and YuE2. Compare render times, and check whether
   MiniMax still comes out broken under either. If one attention is better,
   make it the default at Studio's boot (for the app only — ComfyUI Desktop's
   own settings stay untouched).

## Later (user has more to add)

- [x] Suno-style UI pass (music panel, drop box, rail, player) — 2026-09-16.
- [x] Chat model picker: `/api/chat/models`, saved as `chatModel` (server/chat/models.js).
- [x] **(last) First launch sets itself up for the fork:** — done 2026-09-16: setup reads the card first; the launcher asks NVIDIA / AMD / Intel Arc / CPU and `scripts/install-engine.mjs` installs a private ComfyUI + PyTorch from ComfyUI's own README commands, cleaning up and re-asking with the exact error on failure. Verified: CPU install end-to-end on a clean profile (5:52, Studio started on it), failure path (bad torch pin → error shown, folders removed), AMD/NVIDIA/Intel wheel indexes serve the requested wheels. Not run: a real GPU install on NVIDIA, AMD or Intel.
      Original: detect CPU / GPU vendor
      (NVIDIA, AMD, Intel, none), VRAM, RAM, existing ComfyUI (portable, source,
      Desktop), torch backend, and configure everything without questions.
      Verify on a clean app-data folder. Do this after the current UI work.
      Found by the isolated install test (2026-09-16, clean fake user folders):
      `scripts/setup.mjs` exits 1 at "no ComfyUI found" BEFORE detecting the
      GPU and writes no settings, so the launcher's check then says "No NVIDIA
      or AMD card could be read" on a machine that has one. Detect and save the
      hardware first, then ask for / offer to install ComfyUI.
      Re-run: fresh copy via `git ls-files -co --exclude-standard`, `npm ci`,
      then setup + launcher with `AIPLAY_APPDATA`, fake `USERPROFILE`/`APPDATA`/
      `LOCALAPPDATA`, other ports and `AIPLAY_LAUNCHER_NO_WINDOW=1`.

