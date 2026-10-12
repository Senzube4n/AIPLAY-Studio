# Saved take comparison

Open **Music Lab → Takes**. Select **2, 4 or 8** saved recordings, name the
group, and press **Compare selected**. **Latest 2/4/8** fills the selection
with the newest library recordings; inspect the selection before comparing.
No generation job is started.

Each saved group captures the audio filename, SHA-256, measured duration,
the exact metadata and provenance events available when it was created, and
integrated loudness/true peak from Studio's existing DAW analyser. Receipts
preserve lyric whitespace, seed zero, recorded ABC and stored settings.
An older recording's absent settings remain absent. A receipt is evidence of
what Studio stored, not a promise that every earlier generator parameter was
recorded or that a performance can be reproduced bit for bit.

Press **Play**, then switch between the A–H take buttons. Switching preserves
the position in seconds and uses a single audio element; a shorter recording
seeks to its own ending. Each take displays its actual duration. Different
performances may have different arrangements, so the same time does not imply
the same bar or lyric. Pause, seek and switch to compare a particular passage.

Matching uses attenuation only. The common target gives every recording
headroom below **−1 dBTP**, with 0.1 dB extra margin for rounded meter values.
Every take uses a gain from **−24 to 0 dB**; the listening volume can reduce
it further. Silent/unmeasurable recordings or groups needing more attenuation
are refused. This is loudness matching for listening, not mastering, limiting,
normalised export, subjective quality scoring or sample-aligned switching.
The original recordings are never rewritten.

Choose **Keep this take** to save the choice. **Favourite** explicitly controls
the selected song's library star. Every previous choice stays in the group
history, and later choices require the current revision. **Refresh** retrieves
the latest revision if another UI or MCP caller changed it. **Save receipts**
downloads the complete comparison record as JSON.

Playback verifies all recordings before it starts. Fingerprinted audio URLs
also verify the requested take on every range request and are served with
`Cache-Control: no-store`. A deleted or replaced recording refuses playback
and a new choice. The saved history is retained; create a fresh group to
compare the new file. This verifies the file at the request boundary, rather
than locking an external editor out for the entire listening session.

## MCP

The UI and MCP use the same validated `/api/music-take-comparison` actions.

| Tool | Purpose |
| --- | --- |
| `music_takes_list` | List saved groups and available library recordings. |
| `music_takes_create` | Save and measure exactly 2, 4 or 8 selected files. |
| `music_takes_get` | Read receipts, playback gains, durations and history. |
| `music_takes_verify` | Verify every source before auditioning or deciding. |
| `music_takes_choose` | Save the requested choice and set its favourite flag. |

Example creation:

```json
{
  "idempotencyKey": "chorus-comparison-20261001",
  "name": "Chorus alternatives",
  "files": ["aiplay_first.flac", "aiplay_second.flac"]
}
```

Reuse the same creation key and exactly the same inputs to retry safely.
Different inputs with that key are refused. The response contains
`comparison.id`, `comparison.revision`, immutable take IDs and audio receipts.

Example explicit choice:

```json
{
  "id": "takes-0123456789abcdef01234567",
  "expectedRevision": 1,
  "takeId": "B",
  "favourite": true
}
```

An LLM can read and verify receipts, organise a comparison and record a choice
the user requested. LUFS, peak and settings do not establish which take sounds
better. Do not claim listening or infer a preference from those measurements.
This workspace compares already saved songs; Music's generation queue creates
new takes, and this feature does not offer simultaneous GPU batches.

## Integration

`createTakeComparisonRoutes` in `server/music/take-comparison.js` receives
Studio's `json`, `readBody`, `actorFrom`, `appData`, `listSongs`, `inspectSource`,
`sourceReceipt`, `measureSource`, `setFavourite`, `recordEvent` and `serveAudio`
helpers. The analyser receives only a validated library filename resolved by
the host to its absolute library path. `serveAudio` uses the existing range
server after the store verifies the filename, comparison membership and hash.

Comparisons are atomic JSON records under
`<appData>/music-take-comparisons/`. Changes are serialised per group and
require a revision. Malformed records and altered receipts are retained and
reported, rather than silently overwritten. A failed favourite write does
not invent a successful comparison choice. Library-star, provenance-ledger
and group writes use their existing stores; an I/O failure between stores can
leave a star or ledger event saved before the final group write, so refresh
and inspect the existing state before retrying.

Focused validation:

```text
node --test server/music/take-comparison_test.js server/mcp-take-comparison_test.js
```

The tests cover real persisted groups, exact receipts, matching bounds, source
changes during measurement, stale and concurrent choices, validated audio
serving, the mounted UI's single-player seek/switch behavior, and MCP calls
through the production store.
