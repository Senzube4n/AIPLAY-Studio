# Shared music and visual cues

Open **Music Lab → Shared cues**. Choose an existing DAW project and VFX
composition, place a cue at a bar/beat/tick, and choose an **impact** or **909
kick** plus a white **flash**. Preview, listen, then Apply explicitly.

This is a complete, deliberately small binding: one builtin musical accent and
one rendered visual target. Camera moves, light envelopes and avatar cues are
not shared-cue targets yet. Existing camera/light/avatar tools remain separate.

## One clock and an explicit alignment

The DAW's meter and tempo event maps resolve the musical position. Bar and beat
are 1-based; tick is 0–959. A beat uses the current meter denominator, so a beat
in 7/8 is an eighth note. `durationBeats` follows this same local musical clock,
including changes crossed by the cue.

**Composition time = DAW time + `compOffsetSeconds`.** A composition showing
the DAW from its beginning uses zero. If composition time zero corresponds to
DAW time 20 seconds, use **−20**. If the DAW begins after a five-second visual
intro, use **+5**. Check the displayed DAW and VFX times before applying; choosing
two projects does not establish that their soundtracks contain the same song.

The cue must fit both documents. Studio refuses out-of-range positions,
insufficient accent tail room, full track/layer slots and active solo states.
Extend the project or change the offset explicitly. A dry accent preview is
bounded to ten seconds, including the instrument tail.

## What Preview and Apply do

Preview saves a draft cue and returns its exact note, deterministic seed,
opacity keys, resolved time and both document revisions. It auditions the dry
builtin note through the existing DAW CPU preview lane. The sound is not the
whole project mix: the project mixer, inserts and master can change the result.

Before Apply, the visual preview is the actual existing composition still at
the cue time with a **simulated flash overlay**. Playback uses the returned
envelope against that still; it does not claim to preview moving footage. After
Apply, the preview requests an **actual rendered composition frame** containing
the saved flash layer. Reduced-motion mode shows a still flash preview.

Apply adds ordinary editable objects:

- A dedicated DAW track, with one clip and one note using builtin `impact` or
  `tr909`, MIDI key 36, the requested velocity and accent gain.
- A dedicated full-frame white solid layer, with opacity fading from the
  requested strength to zero over the musical cue length.
- A labeled marker in that VFX composition.

The accent is part of the DAW project. It does not rewrite a previously bounced
song or the composition's existing audio file. Render/bounce the DAW mix and
use that mix in the composition when delivering a video with the new accent.

The `previewToken` binds the exact recipe to both current revisions. A changed
recipe, tempo, meter, mixer or composition requires a fresh preview. Applied
objects do not automatically retime when later musical edits change the clock;
Undo and preview/apply again to retime them explicitly.

## Undo, interruptions and edits

Cue receipts are saved under Studio's application-data `music-cues` directory.
An applying receipt is written before either project edit. Store writes keep
their existing single-writer and atomic-file discipline; the two documents are
not one filesystem transaction. A failure or interruption can leave a partial
change. Status/read reconcile cue-owned object presence and report `partial`;
Undo recovers the remaining objects. Retrying a completed Apply does not add a
duplicate track or flash.

Undo removes only the cue's unchanged track, layer and marker. It preserves
other content and refuses when the cue-owned content was edited, or another
VFX layer depends on the flash. Restore the saved object or remove the related
content in its editor, then retry. No force option overwrites later edits.

## Typed MCP workflow

All tools use the same `/api/music-cues` handler as the UI. Direct tool calls
validate their input rather than relying on a client's schema enforcement.

| Tool | Purpose |
|---|---|
| `music_cue_status` | Projects, compositions, saved cues and supported bindings |
| `music_cue_save` | Create/edit a draft and inspect its exact plan |
| `music_cue_read` | Saved state and recovery receipt |
| `music_cue_preview` | Fresh timing/revision plan and `previewToken` |
| `music_cue_audition` | Dry CPU accent WAV and composition-still URL |
| `music_cue_apply` | Apply the currently reviewed plan |
| `music_cue_undo` | Undo unchanged cue-owned objects or recover partial state |

```json
{
  "name": "Drop",
  "project": "song-project",
  "comp": "song-visuals",
  "bar": 9,
  "beat": 1,
  "tick": 0,
  "accent": "impact",
  "durationBeats": 0.5,
  "velocity": 100,
  "gainDb": -6,
  "flashStrength": 20,
  "compOffsetSeconds": 0
}
```

Call `music_cue_save` with that recipe, retain the returned cue id and plan
token, then call `music_cue_audition` with `id` and `previewToken`. Inspect the
alignment, listen and review the flash. Only then call `music_cue_apply` with
the same id/token. After interruption, use `music_cue_read` before retrying;
use `music_cue_undo` when a partial change needs recovery.
