# AIPLAY Studio — local HTTP API

Everything the app's own UI does goes through this. It is plain JSON on
`http://127.0.0.1:4173`, bound to loopback only, no auth.

Any agent with a shell or a fetch tool can already drive Studio — Claude Code can
POST `/api/generate` today with no extra code on our side. The MCP server that
was once a plan here now exists: `server/mcp.js`, a thin typed face over these
endpoints. The in-app **Agent** screen has the config block and the live tool
list.

> **Not a public API.** Loopback-only and unauthenticated is fine for a desktop
> app talking to itself. Do not expose the port.

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
The audio itself, **with HTTP range support** (206). Seeking depends on it.

---

## Making things

### `POST /api/generate`
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
