# AIPLAY Studio — local HTTP API

## Music score planning (no GPU)

`POST /api/music-plan` and MCP `music_plan` share one read-only implementation.
An outline accepts `bpm` (20–400 quarter-note BPM), `meter` (`2/4`, `3/4`, `4/4`,
`6/8`) and either `bars` (1–1024) or `target_seconds` (1–900). A supplied `abc`
(64 KiB maximum) is checked against the native two-voice dialect; its bar count
and duration come from the written notes. With ABC, optionally provide **either**
`bpm` or `target_seconds` to propose a tempo edit, not both. Bars/meter overrides
are refused for supplied scores. Invalid notation returns `ok:false` with
diagnostics; invalid input fields return HTTP400.

Results include `nominal_seconds`, `bpm`, `bars`, `note`, and proposed `abc` when
applicable. No file, recording, score version or generation queue is changed.
Actual audio length is not guaranteed; this is not recording continuation.
After explicit review, use the returned ABC with `make_song`/`POST /api/generate`
and YuE2 CoT `full` or `melody` to create a **new** take.

Everything the app's own UI does goes through this. It is plain JSON on
`http://127.0.0.1:4173`, bound to loopback only, no auth.

Any agent with a shell or a fetch tool can already drive Studio — Claude Code can
POST `/api/generate` today with no extra code on our side. The MCP server that
was once a plan here now exists: `server/mcp.js`, a thin typed face over these
endpoints. The in-app **Agent** screen has the config block and the live tool
list.

> **Not a public API.** Loopback-only and unauthenticated is fine for a desktop
> app talking to itself. Do not expose the port. That last sentence is no longer
> only advice: `server/engine/ui_test.js` fails the build if any file outside
> `server/engine/client.js` names the engine's port, its routes or
> `config.comfy.*`.

### `POST /api/engine`

The graph-rendering door for ComfyUI-backed features. Native YuE2 uses the
Studio music queue through `/api/generate`, documented below. ComfyUI is
bound to a loopback port Studio picks fresh at every start and does not publish,
so there is no engine address to post to — and everything that comes through here
is recorded before the GPU spends a millisecond.

```bash
curl -sS http://127.0.0.1:4173/api/engine   -H 'content-type: application/json'   -H 'x-aiplay-actor: script:my_sweep'   -d '{"action":"prompt","graph":{...},"wait":true,"label":"arm 3"}'
```

`{action, …}` bodies, the same envelope `/api/vfx`, `/api/daw` and
`/api/videolab` use: `prompt`, `activity`, `run`, `graph`, `object_info`,
`status`, `identity`, `interrupt`, `clear_queue`, `set_hash_models`, `reveal`,
`list_unrecorded`, `adopt_unrecorded`. `POST /api/engine/prompt` is an exact
alias for the first one, so a one-graph script needs no envelope.

⚠ **This endpoint refuses a request it cannot attribute.** Send
`x-aiplay-actor: script:<name>` or `agent:<name>`; a browser is recognised by its
`Origin` and needs nothing. It never invents an actor. And the graph must be
**API format** — ComfyUI's ordinary Save writes an editor document the engine
cannot execute; the route tells the two apart and says which one it got.

Full description, the record it writes, and what it deliberately does not defend
against: [docs/ENGINE_DOOR.md](docs/ENGINE_DOOR.md).

---

## Reading state

### `GET /api/status`
The one endpoint worth polling. Returns engine health, config, the queue, the
whole library, playlists, any overnight run, and a GPU reading.

```jsonc
{
  "engine":  { "ready": true, "backend": { "ok": true }, "torch": "2.13.0+cu130" },
  "config":  { "steps": 15, "shift": 5, "cfg": 1.7, "realtimeRatio": 1.53, "tier": "auto" },
  "gpu":     { "name": "…", "totalMb": 16376, "usedMb": 1024, "utilPct": 3 },
  "current": { "id": "…", "title": "…", "stage": "composing", "overall": 0.34, "etaSeconds": 210 },
  "queue":   [ /* same shape */ ],
  "library": [ /* every track on disk */ ],
  "run":     { "state": "running", "done": 7, "total": 50, "etaAt": 1786… }
}
```

⚠ `gpu.usedMb` is **driver-reported**. PyTorch's allocator keeps freed blocks, so
it reads high — an upper bound, not a requirement. Do not size anything from it.

### `GET /api/trackmeta?file=NAME`
Reads Vorbis comments back out of a FLAC. How tracks made before the sidecar
stored lyrics still show their words. Costs a subprocess — call it lazily.

### `GET /api/peaks/NAME`
`{ ok, seconds, peaks[] }` — a min/max envelope, 1200 columns. Server-side
because browser FLAC decoding proved unreliable.

### `GET /api/audio/NAME`
The audio itself, **with HTTP range support** (206). Native YuE2 WAV files are
served as `audio/wav`; seeking depends on range support.

---

## Making things

### Native YuE2 GGUF

Available through the standalone `npm run start:music`, or **Music only** in the launcher
launcher without ComfyUI or Python. Install the native runtime and model bundle
explicitly in Models first; generation requests never install missing files.

`GET /api/music-gguf` reports native configuration/readiness. A presence/size
check is not proof of runtime compatibility, memory fit or successful audio.
Follow the installer's separate verification result and failure messages.

`GET /api/music-gguf/setup` returns `available`, `ready`, `state`, `progress`,
`downloadBytes`, requirements, licence notices and any error. It checks file
sizes and the native version for readiness; it is not a fresh full-file hash
scan or GPU benchmark on every poll. After the user has reviewed and explicitly
accepted the notices, `POST /api/music-gguf/setup` with
`{"action":"install","acceptLicense":true}` starts the verified download
(202). Active Studio jobs prevent installation (409). Do not auto-accept terms
or install on a generation request. `{"action":"cancel"}` requests cancellation;
poll the GET route for the resulting state. All routes use the existing local
Studio authentication rules.

Precision defaults to `q4_0`. To inspect Q8, use
`GET /api/music-gguf/setup?precision=q8_0` (also supported on `/api/music-gguf`).
Setup returns the selected `quantization`, `selected` details and a `variants`
map for Q4/Q8 readiness and full download totals. `activeQuantization` identifies
an in-progress installation. After explicit approval, install Q8 with
`{"action":"install","quantization":"q8_0","acceptLicense":true}`.
It installs only that main model plus the shared decoder/runtime, reusing valid
files and preserving the other precision. Concurrent installation of a different
precision is refused; wait for the current operation instead of silently switching.

Submit `POST /api/generate` with native-specific fields:

```json
{
  "engine": "yue2-gguf",
  "caption": "Warm acoustic folk, soft vocals",
  "lyrics": "A little light beside the door\nA place to rest once more",
  "title": "A Little Light",
  "seed": 831001,
  "cot": "full",
  "narSteps": 32,
  "quantization": "q4_0"
}
```

`caption` and nonempty `lyrics` are required. `cot` is `full` (default),
`melody` or `off`; `narSteps` defaults to 32 (16 is experimental), with an
integer API range of 1–256. Optional `cfgScale` is finite, 0–20; optional `abc`
is text up to 64 KiB and requires CoT `melody` or `full`. `allowSectionLabels`
is a boolean override for the default lyric-label refusal. Unknown options,
instrumentals, previews, audio references and duration/Python runtime controls
are refused. There is no native mix-cache or generated score-export contract.
`quantization` accepts `q4_0` (default) or `q8_0`; readiness is checked for that
specific choice, with no fallback. The completed job, library and receipt retain
the selected precision.

MCP `yue2_gguf_setup` accepts `precision: "q4_0"` or `"q8_0"` for status/install;
installation still requires `accepted_terms: true` following explicit approval.
MCP `make_song` uses `engine: "yue2-gguf"`, `precision: "q4_0"` or `"q8_0"`, `cot`,
`nar_steps`, `cfg_scale` and optional `abc`; it otherwise shares the style/lyrics
inputs with the tool schema. Omit `max_seconds`, references and instrumental
mode. `wait_for_song` reports `engine`, `file`, **`seconds` for measured audio
duration**, and **`render_seconds` for elapsed rendering**, not interchangeable
values. `make_song`, `wait_for_song` and `list_songs` also report `precision` when
known. Native progress has no measured overall percentage or ETA.

Native job snapshots include `elapsedSeconds` (null while queued),
`generationLimits` (null if the installed sidecar limits could not be read) and
`warnings`. The library persists the latter two; MCP `wait_for_song` and
`list_songs` expose them as `generation_limits` and `warnings`. Example warning:

```json
{
  "code": "possible_semantic_limit",
  "evidence": "duration_near_configured_limit",
  "message": "This take is near the configured generation limit. Check the ending and lyrics; the runtime did not confirm whether it stopped at the limit.",
  "semanticMaxTokens": 9000,
  "approxMaxAudioSeconds": 360
}
```

The numbers above are illustrative, not a hardcoded or user-selected duration.
`generationLimits.source` is `installed-sidecars`. This notice is only a duration
inference, not runtime-confirmed truncation. No warning does not certify complete
lyrics, a natural ending or audio quality. Poll timeouts do not cancel a job or
authorize a replacement render, and never borrow a different job's ETA.

The native adapter durably records delegation before launch. Completion needs a
validated nonempty WAV, derived duration and digest, not just exit code zero.
See [setup, licences and limits](docs/YUE2_GGUF.md). The routes in the rest of
this document may require the full ComfyUI/Python-backed suite.

### `POST /api/generate`

The following body describes **MiniMax Music 3**, not native YuE2:
```jsonc
{
  "caption": "required — the style description",
  "lyrics":  "section tags on their own lines, BARE: [Chorus] not [Chorus - big drums]",
  "title":   "metadata only, the model has no title input",
  "seed":      123,   // the performance. Hold it steady to reuse the AR cache.
  "mixSeed":   456,   // the render. Change only this for a ~4x faster re-roll.
  "arCfg":     1.7,   // composition guidance — steers the 8B LLM. Full render.
  "flowCfg":   1.7,   // render guidance — steers denoising. Reuses the take.
  "steps":     15,
  "maxDuration": 240, // a CEILING, not a target. Lyric length matters far more.
  "model": "int8",    // int8 | fp16 | fp32. Measured indistinguishable; int8 is smallest.
  "instrumental": false,
  "preview": false
}
```
Only `caption` is required. Jobs queue and run **one at a time** — asking for four
takes costs time, not memory.

**YuE2 through ComfyUI** (`"engine": "yue2-comfy"`) adds `cot` (`full` | `melody` | `off`),
`narSteps`, and a LoRA: `"lora": "<file in models/loras>"` with `"loraStrength": 1`
(−4 to 4). Omit `lora` to use the Music page's saved choice, send `""` for none. A name
that is not on a loras shelf is refused (`reason: "lora-missing"`) rather than silently
skipped — ComfyUI's loader matches keys and ignores the rest without an error.
`GET /api/loras?for=<checkpoint>` lists the shelf with each file's fit;
`POST /api/music {"action":"lora","value":"<file>","strength":1}` saves the page's choice.

### YuE2 controls on `POST /api/generate`
Without `abc`: `key` (an ABC key — Em, G, Bb, F#m), `bpm` (40–240) and `meter`
(4/4, 3/4, 6/8, 2/4) become an OPEN seed score of headers the planner continues, so
the song is planned in them (needs `cot` melody or full). The sampler's dials:
`temperature` (0–5, default 1.0), `topP` (0.01–1, default 0.95), `topK`,
`repetitionPenalty` for the performance; `planTemperature` (default 0.7) for the
score planner. Out-of-range values are refused with `reason: "sampling"` or
`"seed"`. MCP: the same on `make_song` as `key`, `bpm`, `meter`, `temperature`,
`top_p`, `plan_temperature`.

### `POST /api/song_to_score`
`{ "source": { "path" | "library_file" | "data_url" … }, "mode": "melody" }` — a
finished song, transcribed by SheetSage2 (ComfyUI's own audio-encoder node, core from
0.35) into the two-voice score YuE2 sings from. `melody` (default) keeps the tune,
`full` keeps the chords too. Needs the catalogue's "Cover — SheetSage2 song-to-score"
row installed, else `400` with `needsModel: "coverSheetSage2"`. Holds the card for the
transcription. Then `/api/generate` with that `abc`, `cot: "melody"` and a NEW style
line is the cover: the melody is kept, the voice and the arrangement are re-rendered.
MCP: `song_to_score`, then `make_song`.

### `POST /api/hum`
`{ "source": { "path": "C:\\…\\hum.wav" } }` — or `{ "library_file": "…" }`, or
`{ "data_url": "data:audio/webm;base64,…", "name": "hum.webm" }` — plus optional `bpm`
and `key`. A pitch tracker in the engine's python (no model, no card) turns one
hummed voice, 1–60 s, into the two-voice ABC score YuE2 takes verbatim. Answers
`abc`, `bpm`, `key`, `notes`, `bars`, `seconds`. Send the score to `/api/generate`
as `abc` with `cot` melody or full; add `"abcOpen": true` to leave the score open so
the planner continues the hummed bars into a whole song (the driver's `--abc-open`).
MCP: `hum_to_score`, then `make_song` with `abc` and `abc_open`.

### `POST /api/extend`
```jsonc
{ "file": "aiplay_00021.flac", "fromSeconds": 14, "seconds": 30, "lyrics": "…", "seed": 123 }
```
Replays the track's saved token trajectory up to `fromSeconds`, then continues.
No audio is read — this works on tracks Studio generated and needs none of the
blocked audio-encoder machinery.

Two things that will bite you:
- Only tracks with a `codes` field can be extended. Anything rendered before the
  capture patch has none and never will.
- Resume from **before** the end. Replaying a whole trajectory leaves the model
  exactly where it chose to stop, so the next token is end-of-audio and you get
  nothing. Default is 80% through.

The extension is spliced onto a copy; the original is left bit-identical.

**YuE2 takes** (`aiplay_yue2_<id>.flac`) extend too. The take's run folder holds
its whole performance (`prefix.npy` + `semantic.npy`), which is what MiniMax keeps
as `codes`; the driver replays it behind the words and the sampler carries on, then
the acoustic model re-renders the whole sequence, so the join takes only the new
render's tail past the seam. Send the **whole** lyric sheet in `lyrics` (old words,
then new; no bracketed labels — refused with `reason: "lyrics"`) and optionally
`abc`, a longer two-voice score; without one the take's own score is reused.
`seconds` is a wish there (8–300, default 45), not a ceiling. The answer carries
`"engine": "yue2"`. MCP: `extend_song` drives both engines.

### `POST /api/replace`
`{ "file": "…", "fromSeconds": 40, "toSeconds": 62, "lyrics": "…", "seed": 123 }` — the
extend body plus `toSeconds`. The model continues from `fromSeconds` exactly as an
extension would (either engine), and the original comes back at `toSeconds`,
crossfaded at both seams. The result is `replace_<ms>.flac`, a mix: it carries no
trajectory or run folder and is not offered for extension; the original is untouched.
Refused with `reason: "replace-range"` when the points are outside the take or under
half a second apart. MCP: `replace_section`.

### `POST /api/video` · `{ "action": "extend" }`
`{ "action": "extend", "clip": "vmu5a3gdz.mp4", "seconds": 3, "prompt": "…", "steps": 4, "seed": 1 }`
— continue a clip on MiniMax H3. The source's last 17k+5 frames (`overlapFrames`,
default 22) are anchored as a native guide at frame 0 of a window of
overlap + extension frames; the model carries on; the overlap is dropped in the
graph; ffmpeg joins source + new frames into a NEW clip under its own id, with
the new frames alone kept beside it as `<id>_new.mp4`. The source is untouched.
`seconds` snaps up to a multiple of 17 frames. Returns `overlapFrames`,
`extensionFrames`, `windowFrames` and the art queue. Refused by `reason`:
`probe` (no ffprobe — this app ships without ffmpeg by promise), `too-short`.
Without ffmpeg the new frames come back as the clip and its record's
`continuation.joined` is false with the reason. MCP: `extend_clip`.

### The conditioning bridge on `POST /api/video`
`create` and `extend` both take `"bridge": "<adapter file>" | "off"` and
`"bridgeAlpha": 0–1` for that render; absent, the Video panel's
`bridge_adapter` / `bridge_alpha` settings apply (video_settings). The node is
the Studio's own (server/comfy_nodes/aiplay_h3_bridge.py, deployed into the
engine at boot); alpha 0 or "off" leaves it out of the graph. The clip's record
carries `bridge` and `bridgeAlpha`. MCP: `make_clip` / `extend_clip`
`bridge`, `bridge_alpha`.

### `GET /api/score/midi/<slug>/<version>.mid`
The version as a Standard MIDI File (format 1, 480 ppq; tempo and meter on
track 0, one track per sounding voice, chord symbols as markers). Nothing is
stored; the score is the artifact. `POST /api/score { "action": "export_midi",
"slug", "version"? }` writes the same bytes under the output folder and returns
the path. `POST /api/score { "action": "to_daw", "slug", "version"?, "name"?,
"patches"? }` builds a DAW project from the version through the DAW's own door
(tempo, meter, one track per voice, one clip, every note) and returns the DAW
slug, the counts and the chord markers. MCP: `score_to_daw`,
`score_export_midi`.

### `POST /api/song_to_score` · `"stem": "vocals"`
With `"stem": "vocals"` and a `source.library_file`, the transcriber reads the
song's separated VOICE instead of the mix: the Studio's own demucs separation
runs first through the art queue when it is not on disk (about a minute), and
the reply carries `stem: { file, path, made }`. Refused with `reason:
"stem-source"` on a path or data-URL source. MCP: `song_to_score` `stem`.

### Steering the defaults from an agent
Every render setting has a tool: `make_clip` (`quality` fast|best, `steps`,
`bridge`, `bridge_alpha`), `video_settings` (every Video Lab knob, including
`turbo3_max_steps`, `turbo_shift_video`, `bridge_adapter`, `bridge_alpha`),
`set_video_engine`, `set_image_engine` (the Images page's default, `krea2`
included), `make_song` (every YuE2 dial: `key`, `bpm`, `meter`, `temperature`,
`top_p`, `top_k`, `repetition_penalty`, `plan_temperature`, `plan_top_p`,
`lora`), and `download_model` (a catalogue row, with `accept_region` for the
territory-locked ones — never assumed). On the page the same choices are two
layers: the Video screen's Fast / Standard / Best chips and the Images engine
dropdown for everyone, the step slider, the Video Lab knobs and Advanced
Options for people who want the number.

### The cover, on the page
Advanced Options → *Hum a melody, or cover a song* → transcriber *Whole song*:
pick a **Library song**, leave **Voice only** ticked, press **Transcribe**. The
score lands in the box, ticked for Create; write the new singer into the style
line ("male lead vocal, warm baritone…"), keep or change the words, press
Create. The same words and tune, a new voice. Over MCP: `song_to_score`
(`stem: "vocals"`) then `make_song` with `abc`, `cot: "melody"` and the new
caption.

### `POST /api/reactive/run`
`{ "song": "…", "pictures": ["a.png", …] | "prompt": "…", "count": 6, "style":
"cuts|crossfade|pulse|film|psychedelic", "cut": "bar|beat|hit", "seconds"?,
"orientation": "landscape|portrait|square", "name"? }` — pictures that move with
a song, on the Studio's own compositor (no video model: works on AMD). Builds a
real comp through the compositor's door (an audio layer, timed picture layers
with opacity keys, the bass on every picture's scale, the beat on an exposure
flash, the style's effects on one look layer) and queues an mp4 render; returns
`slug`, `jobId`, `clip`, the cut count and the bpm at once. Poll
`GET /api/vfx/comp/<slug>` → `renders[]` for progress; the movie lands in the
clips library with the song on it. `pictures` may name CLIPS: a clip plays in
sync with the song in its slot (its own time = the comp's, wrapped over its
length), so several renders of one shot cut between each other on the beat
without the move jumping. `"hits": "drums"` separates the drum stem first
(demucs, once per song) and reads the beats and hits off it alone. `"start"`
begins the piece at that second of the song (the song plays from there; the
cuts and the drive tracks shift with it) and `"seconds"` counts from it.
`"style": "paint"` is the diffusion look (NVIDIA): the clip in `pictures` is
repainted frame by frame by the image engine through the engine door
(scripts/reactive_video.mjs with the source frame on the conditioning), the
pictures are the look and take turns on the bars, the bass decides how hard;
`"paint": { denoiseMin, denoiseRange, source, colour, fps, steps, seed, styleA,
styleB }` are its dials. About 8 s a frame; the call blocks for the render.
`"style": "motion"` is the motion-module look (NVIDIA; needs the
ComfyUI-AnimateDiff-Evolved pack in the engine): the clip in `pictures` is
repainted by SD1.5 under AnimateDiff v3 as one batch — no flicker — the
figure held by ControlNet depth and line art, the look changing on the bars
by prompt; `"motion": { looks: [...], depth, lineart, cfg, steps, seed, ipWeight, transition,
lookWithPictures }` are its dials (server/animatediff.js). Pictures named in
`pictures` beside the clip are the LOOK: through our own IP-Adapter node
(Apache-2.0 weights) they take turns on the drum-stem beats, cross-fading over
`transition` frames ending on each hit — the reference workflow's way. Dials
left out default to the reference's holds with pictures (depth 0.3, line 0.5,
cfg 7) and to the painted look's with prompts (0.2, 0.25, 8). About 3.5 s a
frame; the call blocks.
`GET /api/reactive/status` lists the styles and the hit sources. MCP:
`reactive_render` (advanced: the `vfx_*` tools on the comp).

### `POST /api/batch`
`{ "action": "start", "items": [...], "takes": 4, "cap": 50 }` — also `pause`,
`resume`, `stop`, `clear`.

Round-robin by design: take 1 of every idea, then take 2. A run that only gets
60% through overnight leaves you covered on every idea rather than twenty takes
of the first and none of the rest.

### `POST /api/cancel`
Interrupts the job in flight.

---

## Managing the library

### `POST /api/track`
```jsonc
{ "action": "flag",  "file": "…", "flag": "starred|pinned|rating", "value": true }
{ "action": "trash", "file": "…" }        // MOVES to output/trash, reversible
{ "action": "restore", "file": "…" }
```

### `POST /api/edit`
`{ "file": "…", "ops": [{ "op": "trim"|"cut"|"fade"|"reverse"|"speed"|"join", … }] }`
Every apply writes a **new** file. The load/save round-trip is bit-exact, so
untouched regions are preserved exactly.

### `POST /api/playlist` · `POST /api/reveal` · `POST /api/tier`
Playlist create/toggle/delete; open the file in Explorer; change the graphics
memory tier (restarts the engine and clears the AR cache).

---

## Websocket

`ws://127.0.0.1:4173/live` pushes `{ type: "state", current, queue, history, run }`
on every transition. It carries **job state only, no library** — merge it into
what you already hold rather than replacing.

---

## Cloud language models (the Agent page)

The Chat tab and Music › Simple can answer with a hosted model instead of the local one.
Keys are checked against the provider, stored with `server/secrets.js` (DPAPI on Windows) and
never returned. Providers: Claude, ChatGPT, Gemini, Grok, DeepSeek, Qwen, Mistral, Kimi, OpenRouter,
Groq, Cerebras, Together, and any OpenAI-compatible server (`custom`). Implemented in `server/llm/`.

| Route | What it does |
|---|---|
| `GET /api/llm` | every provider: `connected`, key `hint` (last four), chosen `model`, this month’s `usage` |
| `GET /api/llm/models?provider=ID` | that provider’s chat models, oldest first (`&fresh=1` skips the 10-minute cache) |
| `POST /api/llm {action:"connect", provider, key, base?}` | check the key by listing models, then save it; picks the newest model |
| `POST /api/llm {action:"model", provider, model}` | use that model from now on |
| `POST /api/llm {action:"test", provider}` | send one tiny message; returns the reply and the time |
| `POST /api/llm {action:"disconnect", provider}` | delete the key and the choice |

A connected provider then appears in `GET /api/chat/models` and `GET /api/chat/music/models` as
`{file:"api:ID", api:true}`; `POST` that `file` to use it. Cloud turns skip the graphics-card busy
check and see up to 16 routed Studio tools per message instead of 6. Like the chat routes, a
non-browser caller must send `x-aiplay-actor`.

---

## The MCP server over this

`server/mcp.js` implements it — every tool is a thin, typed face on a route in
this file, so there is one implementation of each behaviour and the UI and an
agent cannot drift apart. The surface kept the spirit of the original plan
written here: it does not mirror the endpoints one-to-one, and it leaves out
song `trash`, `edit`, `reveal` and `tier` — an agent reading a web page should
not be able to empty your library or restart your engine. (Images get an
`image_trash`, which moves to `output/trash` and is reversible.) The full tool
table is in the README and on the app's Agent screen.

The real prize is captions. MiniMax's Structured Caption — Global Metadata,
Vocal Details, Arrangement — is the biggest quality lever on this model and is
tedious to write by hand. An agent writing them is a better experience than a
textarea, and going through MCP means the user's own subscription does the work:
no API key ships with Studio and the local-and-free claim survives.
