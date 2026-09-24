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

### Refused: sexual content involving minors (422)

Every door that makes a picture or a clip refuses a request whose words pair a
child or teenager with nudity or sexual content. This includes `/api/image`,
`/api/images/ai-edit`, `/api/video`, `/api/restyle`, `/api/art`,
`/api/reactive/run`, `/api/batch`, `/api/mv`, `/api/collab`, `/api/router/run`,
`/api/enhance` and `/api/engine`. The answer is always:

```json
{ "error": "This can't be made: it pairs a child or teenager with sexual content.", "code": "minor-sexual" }
```

The status is HTTP 422 and nothing is queued. `error` always starts with that
sentence; when there is something to do about it (move "no children" to the
negative prompt, or part of it came from a picture or cast member the request
uses) that follows in `error` and in `hint`. `found` says where each half came
from (`"prompt"` or `"context"`), never the words. Some doors also say `reason`.
A picture graph that writes its prompt while it runs answers 422 with code
`unverifiable-text`. There is no flag that turns this off. The negative prompt
is never counted as intent. See [docs/SAFETY.md](docs/SAFETY.md).

`POST /api/safety/check` is internal: Studio's own ComfyUI node asks it, with a
per-boot token, about graphs posted to the engine directly.

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
served as `audio/wav`; seeking depends on range support. `bytes=-N` is the last
N bytes. A player that hangs up early (a seek, a pause, the next track) releases
the file at once, so a later tag or cover rewrite is not refused with `EPERM`
on Windows (server/sendfile.js).

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

`caption` and nonempty `lyrics` are required. `seed` is optional: without one
each request rolls its own (0 to 2^32 − 1), as every other engine does; it used
to be 831001 every time. `cot` is `full` (default),
`melody` or `off`; `narSteps` defaults to 32 (16 is experimental), with an
integer API range of 1–256. Optional `cfgScale` is finite, 0–20; optional `abc`
is text up to 64 KiB and requires CoT `melody` or `full`. The sampler's dials
use the Python kit's names and reach the runtime by its own: `temperature`
(0–5) and `topP` (0.01–1) become `semantic_temperature` / `semantic_top_p`
(the performance; vendor defaults 1.0 / 0.95), and `planTemperature` (0–5) /
`planTopP` (0.01–1) become `abc_temperature` / `abc_top_p` (the planner; 0.7 /
0.9). Blank leaves the vendor default. The planner does not run with a supplied
`abc` or with `cot: "off"`, so its two dials are refused there by sentence
(`reason: "sampling"`) rather than dropped. `key`, `bpm`, `meter` and `abcOpen`
are the Python kit's only: this runtime has no open-score option. Lyrics may carry
section tags (`[Verse]`, `[Chorus]`, …), YuE2's own lyric format;
`allowSectionLabels` is still accepted but no longer needed. Unknown options,
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

**Paid, so asked every time.** With the hosted engine switched on (Settings → No strong
graphics card?), a MiniMax Music 3 song bills the person's own key. It is refused with
`409 {reason: "confirm-spend", error, paid: {usdEach, usdTotal, runs, key, keySavedAt, spentUsd, capUsd}}`
until the same request carries `"confirmSpend": true` — exactly `true`; the `error` is the
sentence to show the person. With no key saved: `400 {reason: "needs-key"}`. Nothing is sent
either way. MCP `make_song` takes `confirm_spend`; pass it only after the person agreed to pay
for that song. A MiniMax continuation (`/api/extend`, `/api/replace`) never goes to the hosted engine:
with it switched on, the door answers `409 {reason: "hosted-on"}` and queues nothing.
`POST /api/music` (every action, including `model`, which can switch the hosted engine on or off)
is same-origin JSON only, and `GET /api/apimode` answers only on this machine's own host.

**YuE2 through ComfyUI** (`"engine": "yue2-comfy"`) adds `cot` (`full` | `melody` | `off`),
`narSteps`, and a LoRA: `"lora": "<file in models/loras>"` with `"loraStrength": 1`
(−4 to 4). Omit `lora` to use the Music page's saved choice, send `""` for none. A name
that is not on a loras shelf is refused (`reason: "lora-missing"`) rather than silently
skipped — ComfyUI's loader matches keys and ignores the rest without an error.
`GET /api/loras?for=<checkpoint>` lists the shelf with each file's fit;
`POST /api/music {"action":"lora","value":"<file>","strength":1}` saves the page's choice.
The composer has its own door: `"loraClip": "<file in models/loras>"` with
`"loraClipStrength": 1` patches the autoregressive half (ComfyUI's CLIP side) through
LoraLoader on the clip wire, the audio model untouched — the catalogued instrumental
planner LoRA goes there, and with `"instrumental": true`, nothing named and no `abc` it is
used by itself when it is on a shelf, the sheet becoming `[instrumental]`. Same refusal for a
name off the shelf; `{"action":"planner-lora"}` saves the page's choice; `GET /api/status`
reports both under `config.musicYue2LoraClip` / `…Strength`.
A supplied score (`"abc"`, up to 64 KiB, with `cot` `full` or `melody`) is sung as written:
the planner is left out and the text goes to YuE2GenerateMusic. `temperature`, `topP`,
`topK`, `repetitionPenalty` and, without a score, `planTemperature` / `planTopP` reach the
nodes. What this graph cannot do is refused with one sentence and nothing queued (`400`,
`engine: "yue2-comfy"`): `abcOpen` (`comfy-open-score`), `key` / `bpm` / `meter`
(`comfy-seed-score`), `coverOf` (`comfy-cover-prime`), a `cfgScale` other than 1
(`comfy-guidance`), and planner dials with no planner running.

**ACE-Step 1.5 through ComfyUI** (`"engine": "ace-step15"`) renders the chosen DiT
(`POST /api/music {"action":"model","value":"ace-step15:<file>"}`) with ComfyUI's own
ACE-Step 1.5 nodes. `maxDuration` is the song's length here (10–600 s), not a ceiling.
```jsonc
{
  "engine": "ace-step15",
  "caption": "style tags or prose",
  "lyrics": "[Verse] / [Chorus] on their own lines; empty or instrumental → \"[Instrumental]\"",
  "bpm": 92, "keyscale": "F# minor", "timesignature": "3",  // blank: read from the caption, else 120 / seed key / 4
  "language": "en",                  // ACE-Step 1.5's codes: en, es, fr, de, ja, ko, zh, yue, ru, bg…
  "aceSteps": 8, "aceCfg": 1,        // blank: the template's values (turbo 8 / 1; XL base 50 / 6; XL sft 50 / 7)
  "aceCodes": true,                  // the planner LM ("think first"); off by default with a LoRA, always off for a cover
  "acePlanTemp": 0.85,
  "lora": "<file in models/loras>", "loraStrength": 1,
  "aceCover": { "song": "<Library file>" }   // or { "upload": "<name from POST /api/refaudio>" }
}
```
MCP's `key` (Em, F#m), `bpm` and `meter` (3/4) reach it too, translated. A missing
DiT, VAE, encoder or planner is refused with `reason: "weights-missing"` and
`needsModel: "musicAceStep15"`. `POST /api/music {"action":"aceLm","value":…}` picks the
planner (`qwen_4b_ace15` or `qwen_1.7b_ace15`); `{"action":"aceLora",…}` saves the page's
LoRA. `{"action":"load"}` warms it into ComfyUI, like YuE2.

### YuE2 controls on `POST /api/generate`
Without `abc`: `key` (an ABC key — Em, G, Bb, F#m), `bpm` (40–240) and `meter`
(4/4, 3/4, 6/8, 2/4) become an OPEN seed score of headers the planner continues, so
the song is planned in them (needs `cot` melody or full). The sampler's dials:
`temperature` (0–5, default 1.0), `topP` (0.01–1, default 0.95), `topK`,
`repetitionPenalty` for the performance; `planTemperature` (default 0.7) for the
score planner. Out-of-range values are refused with `reason: "sampling"` or
`"seed"`. MCP: the same on `make_song` as `key`, `bpm`, `meter`, `temperature`,
`top_p`, `plan_temperature`.

Which build takes which: `key`, `bpm`, `meter`, `abcOpen` and `coverOf` are the
Python kit's (`engine: "yue2"`) alone; the dials reach all three builds (native
GGUF as its own request options, above; ComfyUI through its nodes). The Music
page shows a row only on a build that takes it (`data-python-yue` rows are the
kit's; Guidance is not shown on ComfyUI, whose graph samples at cfg 1), and
sends only what it shows — `server/music-engine-rows_test.js` holds each
visible row against each build's door.

### `POST /api/song_to_score`
`{ "source": { "path" | "library_file" | "data_url" … }, "mode": "melody" }` — a
finished song, transcribed by SheetSage2 (ComfyUI's own audio-encoder node, core from
0.35) into the two-voice score YuE2 sings from. `melody` (default) keeps the tune,
`full` keeps the chords too. Needs the catalogue's "Cover — SheetSage2 song-to-score"
row installed, else `400` with `needsModel: "coverSheetSage2"`. Same-origin local JSON only
(`403` otherwise), and the body is capped at 72 MB (`413`). With `"stem": "vocals"`,
a machine that cannot separate stems answers `409` with `setup: "stems"` (see
Refusals below). Holds the card for the
transcription. Then `/api/generate` with that `abc`, `cot: "melody"` and a NEW style
line is the cover: the melody is kept, the voice and the arrangement are re-rendered.
MCP: `song_to_score`, then `make_song`.

### `POST /api/hum`
`{ "source": { "path": "C:\\…\\hum.wav" } }` — or `{ "library_file": "…" }`, or
`{ "data_url": "data:audio/webm;base64,…", "name": "hum.webm" }` — plus optional `bpm`
and `key`. A pitch tracker in the engine's python (no model, no card) turns one
hummed voice, 1–60 s, into the two-voice ABC score YuE2 takes verbatim, in
seconds (pYIN at hop 512). Each bar is spelled against
the key signature, with `=`, `^` or `_` wherever the sounding pitch needs one
(an accidental holds to the end of its bar in this dialect), lengths are the
dialect's own multipliers (tied where needed), and the silence before the
first note is trimmed. Answers
`abc`, `bpm`, `key`, `notes`, `bars`, `seconds`, `leadIn` (the seconds trimmed). Send the score to `/api/generate`
as `abc` with `cot` melody or full; add `"abcOpen": true` to leave the score open so
the planner continues the hummed bars into a whole song (the driver's `--abc-open`).
Same-origin local JSON only (`403` otherwise): it runs the engine's python on a
path the body names. The body is capped at 72 MB (`413` above it). A python missing a module the
tracker needs answers `409` with `module`, `pip` and, for an engine Studio
installed, `setup: "studio-packages"`. MCP: `hum_to_score` (`source`, or a flat
`library_file`), then `make_song` with `abc` and `abc_open`.

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
then new, section tags included) and optionally
`abc`, a longer two-voice score; without one the take's own score is reused.
`seconds` is a wish there (8–300, default 45), not a ceiling. The answer carries
`"engine": "yue2"`. MCP: `extend_song` drives both engines.

**Any other recording** (an import, a take with no saved performance) extends
once the YuE2 real-audio tokenizer is on this machine (Models screen: the
Mothersuperior head over m-a-p's MERT-v2-FullSong, CC BY-NC 4.0) and YuE2 3B is
the music model: the track is read into YuE2's own semantic codes first — once,
kept under `output/yue2/tok_<sha12>/` by the file's bytes; on the CPU while the
card has a render in flight (about 30 s of song in 16 s), on the card otherwise —
and the driver replays them with no score (`--extend-codes`), the join keeping
the original up to the seam. `caption` is **required** (a recording carries no
style), `lyrics` optional (none = instrumental), `abc` optional (then `cot`
melody). The answer adds `tokenized: { frames, seconds, device, cached, timing }`.
Without the tokenizer: `reason: "tokenizer-missing"` with the files that are
missing; with another music model chosen: `reason: "engine"`. The codes are the
tokenizer's reading of the track (16 % exact by its author's measure, round trips
near 95 % by ear), so the kept part comes back as YuE2's rendering of that
reading, not the recording itself.

### Covering a real song

A cover is a **Create**, not an edit: `POST /api/generate` with the engine on
YuE2's Python kit, the song's score in `abc`, and

```jsonc
"coverOf": { "file": "<library file>", "seconds": 8 }
```

The recording is read into YuE2's own semantic codes (once, kept by its decoded
audio; on the processor while the card has a render in flight), the first
`seconds` of those codes prime the render, and the model performs the **score**
in `caption`'s style. The answer adds
`cover: { file, seconds, tokenized: { frames, seconds, device, cached } }`, and
the take is filed with `coverOf` beside its rights — lineage only. **No audio
from the original reaches the result**: the acoustic model re-solves every frame
from noise, and nothing is spliced. This is why it is not `/api/extend`, whose
finish keeps the source's own samples up to the seam.

`seconds` is 1–30, default 8, and longer is worse rather than better: measured
on real takes, the tokenizer's codes carry 0.43–0.53 distinct codes per frame
against the model's own 0.68–0.73 and hold one code for up to 8 frames, so a
long prime walks the sampler off its own distribution and re-performs the
original's arrangement under a caption asking for a different one.

`coverOf.stem` primes the cover from one layer of the original instead of its mix — its
drums for the groove, its voice for the phrasing — while the score in `abc` still carries
the tune.

Refused, each by name: `cover-source` (not a library file), `cover-score` (no
`abc` — run `song_to_score` on the same file first), `cover-open-score`
(`abcOpen` with a cover: the score is performed, not continued), `cover-words`
(neither `lyrics` nor `instrumental`, which would silently render an
instrumental), `cover-seconds` (outside 1 to the track's length),
`tokenizer-missing` (with the files), `engine` (a music model other than YuE2's
Python kit). MCP: `make_song` with `cover_of` and `cover_seconds`.

⚠ The rights in the song you cover are yours to clear; nothing here does that
for you, and the render itself carries YuE2's CC BY-NC 4.0.

### `POST /api/sounds_like`
`{ "file": "<library file>", "limit": 10, "tokenize": true }` — ranks everything on this
machine against one track, over YuE2's own semantic codes. Every take keeps the codes
it was written from and every read recording keeps the tokenizer's; the signature is how
often each of the 32,768 codes is used, weighted sub-linearly and L2-normalised, compared
by cosine. Answers `{ ok, file, kind, compared, querySeconds, matches: [{ file, from, title,
seconds, similarity }] }` where `from` is `take` or `recording`. A track whose codes are not
kept yet is read first (on the processor while the card is busy); `"tokenize": false` refuses
instead, with `reason: "not-read"`.

⚠ **It answers "the same kind of sound", not "the same tune."** The order of the codes is
thrown away, so it compares instrumentation, texture, register and production. A cover in
another arrangement scores low; two songs from one session score high. Measured on this
machine: a 40-second clip of a song ranked that song's own continuation first at 0.56 and
another clip of the same song second at 0.25, with unrelated takes at 0.11 and below.
No card is used unless a recording must be read. MCP: `sounds_like`.

### `POST /api/tokenize`
`{ "file": "<library file>", "device": "cpu", "force": false }` — reads a library track
into YuE2's semantic codes with the real-audio tokenizer and stops there: answers
`{ ok, file, dir, frames, seconds, framesPerSecond: 25, device, cached, timing, distinctCodes }`.
The codes land where `/api/extend` looks, so an Extend that follows is instant.
`device` omitted: the card, or the CPU while a render is in flight; `"cpu"` forces
the CPU. `force` reads it again. `"stem": "vocals" | "drums" | "bass" | "other"` reads ONE
separated layer instead of the mix — the Studio separates it first (demucs writes all four
at once, so a second layer later is free) — and those codes get their own cache entry,
because the cache is keyed on the decoded audio. `/api/extend` takes the same `stem`, and so
does `coverOf`. `reason: "tokenizer-missing"` with the files when
the tokenizer is not on disk. MCP: `tokenize_track`; `studio_status` reports
`music.tokenizer`.

### `POST /api/replace`
Works on ANY RECORDING too, not only on a take, once the real-audio tokenizer is installed
and YuE2 3B is the music model: the recording is read into YuE2's codes, the model continues
from `fromSeconds` as an extension would, and the original comes back at `toSeconds`. Takes
the same `stem`. The result is a mix and carries no trajectory, so it cannot itself be
extended.

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

### `POST /api/video` · `{ "action": "check" }` and what `create` says back
`{ "action": "check", "prompt", "width", "height", "seconds", "steps",
"refImages", "refAudios", "persona", "song", "sparse", "fromCover" | "fromUpload" | "toCover" | "toUpload" | "framed",
"sourceVideo" }` — the plan a `create` with the same body would render on this
card (server/video-plain.js `videoPlan`), without staging or queueing
anything: `engine`, `width`, `height`, `seconds`, `steps`, `sparse`, `sampler`,
`fit` (`sentence` "This size needs about X GB free on the graphics card; you
have Y GB…", `needGb`, `haveGb`, `over`, `scope`), `warnings` `[{id, text}]`,
`notes` `[{id, text}]` (caveats that change nothing: `sparse-untried`, sol-attn
at a size the lab never measured it at) and `refusal`. `create` renders that
plan and returns the same `warnings`: `size` (no size named, so an H3 render
on a smaller card starts at the card's tier size, said as "measured to fit" or,
for the 6 GB preview, "not yet seen to fit"), `steps` (Fast with references
runs the 4-step reference build's own count; 6 or 7 steps are left alone),
`tags` (a `<Picture n>` / `<Audio n>` nothing attached answers is taken out of
the description), `frames-untried` (a first or last frame on FastH3, which the
lab ran on text only), `not-offered` (H3 on a card it is not offered on; the
Video screen asks before it sends), `sparse` (sol-attn named for a render that
cannot take it), `fit` and `ram` (under 32 GB of RAM). References on FastH3 or
LTX are refused with `reason: "refs-ignored"` in the sentence `/api/status`
sends per engine as `refsIgnored`. `"sparse": "sol-attn" | "off"` is H3's
sparse attention for that render, applied on the Fast setting's plain path (the
3-step build; no references, continuation or video-to-video) only; absent, the
saved `sparse_attention` (video_settings) applies, and the Video screen sends it
only while its switch differs from the saved value. `/api/status` also sends
per engine `h3Tiers` (whether H3's card tiers apply) and `fastNote` (the Fast
chip's words, which follow the disk and the saved sparse attention). A failed
clip's status row carries the sentence as `error`, the engine's own text as
`detail`, its kind as `errorReason` (`out-of-memory`, `ram-out-of-memory`,
`refused`, `unreachable`, `engine-gone`, `timeout`, …) and both in `fullError`.
The door takes Studio's own page or a local client only, with a 1 MB body, and
so does `POST /api/videolab`. MCP: `make_clip` `check_only` (with `notes`),
`sparse`, and its reply's `warnings`.

**Keeping a character** (the REWIND A/B, 2026-09-24, DIRECTING.md §2). `create`
and `check` take `"persona": "<saved character>"`: it is resolved before the
safety check (so the check sees its pictures and words), up to three of its
pictures ride after `refImages`, each bound in the prompt as "<Picture N> is
Name.", and its description follows as "Name: description.". A name the shelf does
not have is refused with `reason: "persona"`; on FastH3 or LTX a persona is
refused like any reference (`refs-ignored`). A render with references that names
no `steps` runs the reference build's own count, `referenceSteps` (sent per
engine on `/api/status`; 8 where the 8-step reference file is on disk). `check`
takes `"song": true` for a song the page holds (`create` reads `audioTrack`).
Both replies carry `sampler` (res_multistep on the reference path) and
`character`: `{ keeps, pictures, persona, unnamed, steps, measuredSteps,
measuredHere, song, receipt, hint }` on H3 (null elsewhere), where `receipt` is
the Video screen's words ("keeps Mira: 3 pictures + 8 steps + song (lip-sync)";
pictures without a saved character are "2 reference pictures", and pictures the
words never tag are "not named") and `hint` the Keep row's line (name the
pictures, name the character, the song for a singer, then whether the measured
build is on this PC). `measuredSteps` is the measured setup's count, a
constant 8 (video-plain.js `KEEP_MEASURED`: the ref2v 8-step v1.0 build),
apart from what this disk runs; `measuredHere` says whether that build is on
this PC. Every reply also carries `songLine` `{ meta, hint }`: Song under the
clip's words for this engine (lip-sync on H3 with pictures; on LTX mouths were
measured not to follow). Warnings: `persona-pictures` (more than three: a clip
takes the first three) and `persona-missing` (`create` only: a picture among
those that ride could not be found). Notes: `runs` (the build, steps, sampler
and video decoder), `pictures` (more than three reference pictures),
`persona-unnamed` (the words never name the character), `steps-measured`
(fewer steps than, or another build than, the one keeping a character was
measured on), `decoder` (the measured setup used the fp16 decoder) and
`audio-ref` (a sound reference re-sings; lip-sync is the song under the clip).
`/api/status` sends per engine `referenceSteps` and `keepFast` `{ steps, note
}` (the Fast chip while a character is kept). MCP: `make_clip` `persona`, and
its reply's `character` and `character_hint` (`check_only` adds
`keeps_character`, `sampler` and `soundtrack`); `studio_status`
`video.h3_reference_steps`.

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
`persona` (Keep my character; its reply says what it keeps in `character`),
`bridge`, `bridge_alpha`, `sparse`, `check_only`), `video_settings` (every Video Lab knob, including
`turbo3_max_steps`, `turbo_shift_video`, `bridge_adapter`, `bridge_alpha`, `sparse_attention`),
`set_video_engine`, `set_image_engine` (the persistent automatic song-cover
preference, or with `use_for` "pictures" the Images screen's engine that
`make_image` and music-video stills use when they name none; `"auto"` forgets
the choice), `set_music_engine`
(the persistent music model; `"auto"` forgets the choice), `make_song` (every YuE2 dial: `key`, `bpm`, `meter`, `temperature`,
`top_p`, `top_k`, `repetition_penalty`, `plan_temperature`, `plan_top_p`,
`lora`), and `download_model` (a catalogue row, with `accept_region` for the
territory-locked ones — never assumed). On the page the same choices are two
layers: the Video screen's Fast / Standard / Best chips and the Images engine
dropdown for everyone, the step slider, the Video Lab knobs and Advanced
Options for people who want the number. The step counts behind Fast / Standard
/ Best (and make_clip's `quality`) follow the turbo files on disk: Standard,
also the default, is 8 only where both 8-step builds are present, else 4.
`studio_status` shows them as `video.h3_quality_steps`.

When nothing is saved, the music model, the picture model and the cover engine
follow what is on the disk (YuE2 through ComfyUI, then YuE2 GGUF; the
recommended picture model that is present), worked out on every read and never
written into settings.json. A saved choice always wins; a settings file an
older Studio wrote keeps its values (and the Images engine keeps Qwen Image
2.1, the old default), reported as `kept`. `studio_status` `defaults` lists each
one as `{key, value, chosenBy: "machine" | "you", why}`, plus `kept`,
`savedValue` (this session runs something else than the saved choice: the
music-only launch, or a saved GGUF that is not installed; nothing is
rewritten) and `paid` (API mode on: songs are billed to the person's own key).
With no picture model on the disk no cover is queued and the cover row says
"Add a picture model to get covers." Settings → *Picked for this PC* shows the
same rows, with Change and, on a saved one, *Let Studio pick*.

### The cover, on the page
Melody & score → *Hum a melody, or cover a song* → transcriber *Whole song*:
pick a **Library song**, choose what to **Read the tune from** (*its separated
voice*, which needs stem separation set up — it starts unticked until it is —
or the whole mix), press **Transcribe**. The status line names the step and its
clock ("Separating the voice… 0:42", "Reading the notes (SheetSage2)… 0:12"),
and ■ Stop ends it (for a whole song through `POST /api/cancel`). The
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
lookWithPictures, hires, hiresDenoise, smooth, hitsOn, hitGap, sourceHold, sourceHoldEnd,
hintLift, motionScale, iris,
motionModel, motionLora, motionLoraStrength, modelLora, modelLoraStrength, sampler,
scheduler }` are its dials
(server/animatediff.js). Pictures named in
`pictures` beside the clip are the LOOK: through our own IP-Adapter node
(Apache-2.0 weights) they take turns on the drum-stem beats, cross-fading over
`transition` frames ending on each hit — the reference workflow's way. Dials
left out default to the holds with pictures (depth 0.4 until 0.6 of each pass,
line 0.5 until 0.7, cfg 7; `depthEnd` / `lineartEnd` are the hold lengths) and
to the painted look's with prompts (0.2, 0.25, 8). `hires` (default
true) is the reference workflow's second pass: the first runs small (512x288
landscape) and a second at twice the size repaints `hiresDenoise` (0.55) of it;
`smooth` (default true) doubles the 12 fps render to 24 with RIFE 4.26 through
the engine (the clip enhancer's model, MIT) before the compositor takes it, and
falls back to ffmpeg's motion compensation when the interpolation pack is not
there — the reply's `smoothedBy` says which. `hitsOn` (beats | bars) and `hitGap` (frames, default 5)
decide which drum hits the pictures switch on. `sourceHold` (0-2, default 0)
anchors the render to the SOURCE frame on every hit through our own SparseCtrl
node (Apache-2.0 weights, catalogued), until `sourceHoldEnd` (0.5) of each
pass — the reference workflow's punch on the hits, at its 1.0; off by default
because on the first piece measured (2026-09-20) it flattened the paint to one
wash and defined the dancer less. `hintLift` (1-4; 2.2 with pictures, 1 with prompts) opens the bottom of the
range BEFORE the depth and line-art preprocessors see the frames, and only them
— what the sampler paints keeps its own blacks. A figure on a black stage sits
in the bottom five per cent of an eight-bit range (measured on one real dance
frame: 83.5% under luminance 0.05, the figure's own column averaging 0.068), so
the estimator is not weak, it is blind; 2.2 multiplies the edge energy inside the
figure by 2.2, and above about 2.4 the compression blocking comes up with it.
`motionScale` (0.1-3, default 1) is AnimateDiff's own `scale_multival`: how hard
the picture moves between frames. `iris` (0-1, default 0) is the reference's
black circle opening on the bass — a compositor shape over the finished frames,
not something the diffusion knows about. All three are off at 1 / 1 / 0, and the
graph at those values is the graph every piece before 2026-09-20 rendered. The
`motionModel`, `motionLora`,
`modelLora` and `sampler` / `scheduler` fields are BRING YOUR OWN: file names
from the engine's own folders, listed by `GET /api/reactive/status` → `motion`;
nothing is shipped or catalogued for them (the reference workflow's AnimateLCM
and LiquidAF have no licence text), and the path is unverified on the rig that
built it. About 3.5 s a frame in one pass, about twice that with the detail
pass; the call blocks.
`GET /api/reactive/status` lists the styles and the hit sources. MCP:
`reactive_render` (advanced: the `vfx_*` tools on the comp).

### `POST /api/collab`
`{ "action": "me" | "roster" | "resources" | "set_resources" | "add_peer" |
"verify_peer" | "set_role" | "set_lend_minutes" | "remove_peer" | "pack" |
"open" | "free" | "orders" | "inbox" | "accept" | "send_back" | "receive" |
"adopt" | "drop" | "credit", … }` — sharing a project,
and lending a card. **Phase one opens no socket**: `pack` writes one sealed file
addressed to one friend and `open` reads one, and the transport between them is
whichever one you already use. `me` answers this Studio's fingerprint, the twelve
words it reads as and the one-line key card to give a friend, creating the
keypairs on the FIRST call rather than at boot. `add_peer` takes their card and
files them with **no role and no minutes** — adding is not trusting. `verify_peer`
records that a HUMAN read twelve words aloud and heard the same twelve back; it
verifies nothing itself, which is why no MCP tool calls it. `set_role` makes a
verified friend a `lender` or a `collaborator`, and the roster refuses a role on
an unverified row. `credit` takes `{ slug }` and answers who did what on that project, folded out
of its provenance ledger rather than its document: one row per hand with what it
did and how many files it touched, the totals by kind, and ready-made lines. The
actor on every event is stamped at the door it came through and cannot be claimed
by its own caller — `user` for a browser, `agent:<name>` for an MCP client,
`script:<name>` for a harness, and `peer:<fingerprint>:<their own actor>` for work
that came back from a friend. It counts acts and not merit, and the `note` it
returns says so; quote it beside the lines. `resources` answers what THIS Studio can do — the card's model name and memory,
the system memory, and the ids of catalogue capabilities that are fully
downloaded. It names no path, no folder, no library entry and nothing that was
made here; the one free-text field is a line the owner types. `set_resources`
files the card a friend sent onto their roster row, and it is a separate call
because `open` reads and changes nothing. A stored card carries the moment it was
made: it is a message, not a reading, and every surface that shows one shows its
age. `pack` takes `{ slug, to, kind: "shot" | "project" | "resources",
segmentId?, note? }` and the ROLE decides what may leave: a collaborator receives the
project, a lender receives one finished prompt with the pictures it needs and
never the script, the song, the plan or the other scenes. `resources` is the one
kind a verified friend may have with **no role at all**, because saying what your
machine can do is how two people decide whether to lend to each other; it still
requires verification, since you do not advertise to a stranger. `open` takes
`{ file }`, checks the signature against the key held for the fingerprint the
envelope names — a bundle from somebody not on your roster is refused
`unknown-sender` rather than believed — then that it was sealed here, then
decrypts, and **stops**: nothing is rendered, because a bundle is a stranger's
sentence until a person has read it. This is the one door in `server/index.js`
that checks who is knocking (`Origin`, or `Sec-Fetch-Site: same-origin`, or an
`x-aiplay-actor` header), because add-verify-promote-pack is four posts that need
no reply to be useful. Every refusal carries a `reason` to branch on. **The lending loop.** `pack` with `kind: "order"` asks a friend to render one
scene on their card: it takes `{ slug, to, segmentId, seed?, steps?, engineMode?
}` and seals the four-word order beside the finished prompt and the pictures that
prompt names. Nothing else travels — no graph, no tool name, no model, no path —
because the engine validates a graph's SHAPE and not its intent, and a graph on
the wire reaches node classes that read files and install packages. `free` says
whether this machine can take somebody else's render, asking the ENGINE as well
as this app's own queues, since most GPU work here never enters those queues.
`accept` turns an arrived order into a one-scene project with a **proposed**
plan; nothing renders until a person approves it, and the same order accepted
twice is refused rather than rendered again. `send_back` seals the finished take
home with the lender's own model and output rights on it. `receive` puts an
arriving take into quarantine, measured here against the order it answers — the
seed, the steps, the size, the length, and the lender's own probe against ours.
`adopt` is the press that files it as a take **nobody has picked**, under the
actor `peer:<fingerprint>:<their own actor>`; `drop` throws it away. `orders`
reads the book and `inbox` lists the folder. MCP:
`collab_me`, `collab_roster`, `collab_resources`, `collab_credit`, `collab_free`,
`collab_orders`, `collab_add_peer`, `collab_set_role`, `collab_pack`,
`collab_open` — ten, and the five that are missing are decisions rather than
gaps: an agent may not verify a friend, may not lend the card, may not render
what arrives, may not ACCEPT an order (that is an hour of somebody's
electricity), and may not ADOPT a take (that is another machine's pixels becoming
part of your film). Design and the owner's answers: `docs/COLLAB.md`.

### `POST /api/batch`
`{ "action": "start", "items": [...], "takes": 4, "cap": 50 }` — also `pause`,
`resume`, `stop`, `clear`. Same-origin JSON only. With the hosted engine on, a music
run is refused with the whole night's estimate (`reason: "confirm-spend"`) until `start`
carries `"confirmSpend": true` (MCP `overnight_start`: `confirm_spend`).

Round-robin by design: take 1 of every idea, then take 2. A run that only gets
60% through overnight leaves you covered on every idea rather than twenty takes
of the first and none of the rest.

### `POST /api/cancel`
The Stop button: cancels the song in flight and the queued songs, drops the
queued pictures, stems and timed lyrics, and stops the one of those that is
running — including a demucs or lyrics process, whose whole process tree is
ended. Other engine work (a chat turn, a friend's render) keeps its place. Answers
the song queue plus `artStopped`: `{ dropped, wasRunning, kind, killed, stopping,
interrupted, engineCancelled }`; `stopping` stays true until the process is gone.
MCP: `stop_generation`.

### `POST /api/stems`
```jsonc
{ "action": "run", "file": "aiplay_00021.flac" }   // same-origin local JSON only
{ "action": "python" }                              // report
{ "action": "python", "value": "C:\\…\\python.exe" } // choose; "" or null = default
{ "action": "when", "value": "off|all|starred|liked" }
```
`run` separates one song into vocals, drums, bass and other (demucs htdemucs_ft,
behind music on the art queue). It answers `200 { ok, jobId }`, or
`200 { ok, joined: true, jobId }` when that song is already being separated, or
`409`, before anything is queued, when the stem separation python lacks demucs
or PyTorch (a missing python is refused within a second; the import check takes a
few seconds at most, and counts as missing after ten) (`reason` `stems-python-missing` |
`stems-demucs-missing` | `stems-torch-missing`, `python`, `pip`, and
`setup: "stems"` unless `AIPLAY_SYS_PYTHON` names the python), or `409` with
`reason: "refused"` when the queue said no. `python` is Settings > Songs >
"stem separation python": `{ ok, stems: { python, chosen, source, defaultPython,
modules: { demucs, torch }, ready, note } }`. MCP: `separate_stems`,
`stems_python`, `setup_feature {"id":"stems"}`.

### Refusals: `409` and `setup`
`409` means this machine is not ready (a python, a module or a model is
missing). The body is `{ error, setup?, python?, pip?, module?, needsModel?,
reason? }`: the sentence's first line says what is missing and where; `setup`,
when present, is the id `POST /api/setup {"action":"run","id":…}` takes to fix
it (`stems`, `studio-packages`, `lyrics`). The page offers that as an Install
button; MCP tools append the id to the error for the agent to ask about.

---

## Managing the library

### `POST /api/track`
```jsonc
{ "action": "flag",  "file": "…", "flag": "starred|pinned|rating", "value": true }
{ "action": "trash", "file": "…" }        // MOVES to output/trash, reversible
{ "action": "restore", "file": "…" }
{ "action": "batch", "op": "flag|trash|restore", "files": ["…"], "flag": "starred|pinned|archived", "value": true }
```
`batch` acts on up to 2,000 files, each on its own (the reply lists any that
failed), and lists the library once at the end. `archived` takes a song out of the
everyday list without touching the file. `POST /api/playlist {"action":"add","id":…,"files":[…]}`
adds several songs without taking any out.

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

## No strong graphics card? (`/api/cloud`)

Friend first, then your own key. One answer for the Settings card and `cloud_status`:
`ways` in order (asking a friend on Collab, then a paid service on the person's own key),
the hosted engine's switch, cap and spend, and the Comfy API key's status. Keys are never
returned; a key's status says when it was saved and whether another copy of Studio on this
Windows account saved it (`savedHere: false`, and the sentence in `said`). Studio reads no
key from an environment variable or another program. Implemented in `server/cloud-switch.js`.

| Route | What it does |
|---|---|
| `GET /api/cloud` | `order`, `ways`, `friend` {available, note}, `hosted` {on, runsHere, note, provider, capUsd, spend, key, keySaid}, `comfy` {key, keySaid, note}; this machine's own host only |
| `POST /api/cloud {action:"set", on?, monthlyCapUsd?, provider?}` | the hosted engine's switch, cap (0–1000) and provider; the same writer as `POST /api/apimode {action:"config"}` |
| `POST /api/cloud {action:"comfyKey", key}` | check the Comfy API key with Comfy's free model list, then save it |
| `POST /api/cloud {action:"forgetComfyKey"}` | delete the saved Comfy API key |

Every POST is same-origin JSON. MCP: `cloud_status` (a read the in-app chat may use) and
`set_cloud` (withheld from the chat: it decides whether songs bill). A Comfy API run
(`POST /api/router/run`, Use Comfy API mode only) likewise needs `"confirmSpend": true`.

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

### Music workflows

`GET /api/music-auditions` lists saved sessions and source eligibility. Use
`?id=SESSION`, `?source=FILENAME`, or `?jobId=JOB` for one record. POST actions
`create`, `status`, `keep`, `cancel`, `discard` use the same persistent store.
Creation takes `source`, `fromSeconds`, `toSeconds`, `count` (2 or 3), optional
distinct `seeds`, prompt/lyric/score overrides and `contextSeconds`. Keep requires
`id`, current `revision`, `takeId`, and `acknowledgeShort:true` when measured
generation is short. Ready means a composed file is on disk; raw completion is
not ready. Cancellation affects only that session's exact job IDs.

`GET /api/music-kits` lists kits; `?id=KIT` reads one. POST actions are `create`,
`get`, `list`, `update`, `preview_variant`, `save_variant`, `prepare`, `render`,
`refresh_job`. Create freezes either `abc` or `sourceScore:{slug,version}`, plus
style/lyrics/seed/backend/precision. Variants have `keep_melody`, `keep_score` or
`revise` mode and opening/tension/closing role. Prepare persists the exact render
request without queueing it. Render requires `id`, `expectedRevision`,
`preparedId` and `idempotencyKey`; repeated keys never resubmit. A lost queue
acknowledgement is reported as uncertain rather than automatically retried.
`collab_plan` action `set_music_cue` links `{kitId,variantId,variantHash}` to an
episode or scene using the plan's `expectedRevision`. This is a local plan link.

`POST /api/music-references` actions `capabilities`, `list`, `prepare`, `get`,
`analyze_visual`, `transcribe`, `update_brief`, `update_score`, `prepare_request`
produce a reviewed music draft. Prepare takes a local library `file`, `kind`
(`audio` or `video`), `startSeconds`, `seconds` (up to 120), and `maxFrames`
(up to six). Sources are bounded to 512 MiB; remote URLs are not accepted.
Subsequent edits require `referenceId` and `expectedRevision`. Poll `get` after
asynchronous preparation or model analysis. `preview:true` includes the contact
sheet. `prepare_request` requires `reviewed:true`; returns an HTTP generation
request and its equivalent typed `make_song` arguments, but submits neither.
Vision analysis uses an installed Qwen3-VL through the engine door; transcription
uses SheetSage2. A score works on all three YuE2 builds (Python, ComfyUI and native
GGUF). Native GGUF currently requires lyrics.

Source evidence, suggestions and edited briefs remain separate. This is not
native YuE2 multimodal input or guaranteed audiovisual synchronization. See
[workflow status and limits](docs/YUE2_NEXT_WORKFLOWS.md).

`server/mcp.js` exposes typed tools over these same handlers. See the
[MCP workflow map](docs/MCP_WORKFLOWS.md) for editor candidate review, Qwen
references/alpha, Reactive profiles and source timing, training regions, and
revision-checked collaboration planning. `studio_api_reference` searches this
file, while `studio_api_request` covers other existing JSON API operations using
local `/api/` paths, GET/POST/PUT/DELETE and a body of at most 2 MiB. It cannot set
custom headers or request an external URL. The actor always remains `agent:*`.
`import_local_media` sends bounded local media bytes through `/api/frame`,
`/api/refaudio` or `/api/studio/import` with the appropriate MIME and filename.
It never fetches a remote URL. Existing permissions, signature and role checks
are enforced by the server for both the UI and MCP.

Collab tools now record explicit user intents for verification, roles, lending
allowances, acceptance and adoption. `collab_verify` requires an actual completed
word check to be recorded; accepting an order only creates a proposed plan.
Browser playback, OS dialogs and legacy canvas capture remain browser operations.

The real prize is captions. MiniMax's Structured Caption — Global Metadata,
Vocal Details, Arrangement — is the biggest quality lever on this model and is
tedious to write by hand. An agent writing them is a better experience than a
textarea, and going through MCP means the user's own subscription does the work:
no API key ships with Studio and the local-and-free claim survives.
