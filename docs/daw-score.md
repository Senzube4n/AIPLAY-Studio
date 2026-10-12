# DAW notes to YuE2 notation

`server/music/daw-score.js` exports a DAW project or inclusive bar selection as
the native YuE2 ABC dialect. This operation is pure: it creates a preview, never
changes DAW notes, saves a score or starts GPU work. The caller can review the
preview and use the existing saved-score draft/render APIs.

```js
const preview = dawSelectionToScore(project, {
  fromBar: 5,
  toBar: 8,
  voiceTracks: { Vocal: vocalTrackId, Ins: melodyTrackId },
  sourceAbc: parentScoreAbc,
  quantizeTo32nd: false,
});
```

`trackIds` can replace `voiceTracks`. One track becomes `Ins`, with a silent
`Vocal` voice. Two tracks named exactly `Vocal` and `Ins` keep those assignments;
otherwise the array order is Vocal, then Ins. Both voice declarations are always
present, and missing material is filled with explicit rests.

The result contains `abc`, the existing native `check` result, `warnings`,
`voices`, `noteMetadata` and `selection`. Selection bounds include absolute DAW
`startSeconds`/`endSeconds`, `durationSeconds`, quarter-note bounds, and inclusive
`fromBar`/`toBar`. ABC time starts at zero inside that selection. These times are
DAW notation times; generated YuE2 audio can drift relative to them.

The native dialect has two monophonic melody voices, quoted harmony symbols,
supported note/rest lengths and ties. Overlapping notes, percussion tracks and
three or more selected tracks refuse rather than discard music. Split polyphonic
notes into two melody tracks when that matches the intended arrangement. Chord
symbols are preserved from the optional complete parent `sourceAbc`, including
the active chord at the beginning of a cut, rather than guessed from note stacks.

`sourceAbc` must be a valid native score covering the same absolute bar grid and
meters. It supplies key changes and section labels as well as harmony. Without
it, pitches remain explicit, the key is C, and the preview reports unavailable
harmony. Track transpose is applied; velocity, instrument sound, effects,
articulation and audio clips do not become notation.

DAW timing uses 960 ticks per local denominator beat; YuE2 notation uses
`L:1/32`. Durations walk the DAW meter map through every crossed bar, and notes
continuing across barlines become ties. Boundary notes are trimmed to the
selection with a warning. Changes of meter are represented in both voices.
Changes of tempo inside a selection refuse, because the native score dialect
supports one integer quarter-note tempo. Choose a constant-tempo passage.

Off-grid onsets or note ends refuse by default. Explicit `quantizeTo32nd:true`
snaps only the exported ABC preview, reporting counts of snapped onsets, changed
lengths and notes given a minimum 1/32-note duration. The DAW stays unchanged.
Quantization that creates overlapping notes still refuses.

`sourceFingerprint` identifies the selected source notes, their unsnapped timing,
clip bounds, instrument transpose, maps, parent ABC and export choices.
`projectFingerprint` identifies the full project length, maps and tracks.
Recompute the appropriate fingerprint before rendering to catch edits made
after preview. `noteMetadata` records source and exported times in 1/32-note
units plus exact note, clip and track IDs. `project.updatedAt` is also returned
for the caller's normal project revision handling.

Tests include existing score-to-DAW-to-ABC musical roundtrips, 6/8 off-beat notes,
all MIDI octaves, local-beat durations through a meter change, boundary ties,
source harmony/key preservation, explicit quantization and stale-source checks.
