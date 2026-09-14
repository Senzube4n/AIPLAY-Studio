# AIPLAY Studio — local HTTP API

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

Available through the standalone `npm run start:music` / `Start YuE2 Music.cmd`
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

MCP `make_song` uses `engine: "yue2-gguf"`, `precision: "q4_0"`, `cot`,
`nar_steps`, `cfg_scale` and optional `abc`; it otherwise shares the style/lyrics
inputs with the tool schema. Omit `max_seconds`, references and instrumental
mode. `wait_for_song` reports `engine`, `file`, **`seconds` for measured audio
duration**, and **`render_seconds` for elapsed rendering**, not interchangeable
values. Native progress has no measured overall percentage or ETA.

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
