# AI takes from the DAW

Open a DAW project, select a melody track and set a loop on the ruler. Open the
**AI takes** dock and press **Use loop** to copy the current bar range and track.
The instrument melody defaults to that track; the vocal melody is silent until
you assign a second pitched melody track.

1. Press **Review score**. Inspect the validated ABC and export warnings. The
   review does not change notes, save a draft or start GPU work.
2. Press **Save draft**. The snapshot stores exact notation, style and lyrics,
   project and recording fingerprints, bar bounds and the recording offset.
   A fresh random seed is saved for Music handoff and retained on retries.
3. Press **Load in Music** to review the selected score in the normal Music form.
   It does not generate until you press that form's Create button.
   An empty lyric sheet defaults to instrumental mode; supplied lyrics default
   to song mode. Both remain adjustable in Music before generation.
4. For alternatives inside an existing song, choose its original recording and
   review the offset before saving. A positive offset means DAW bar 1 occurs
   later in the recording. Press **Make 2 takes**, or choose 3 takes, to queue
   different saved seeds through the ordinary GPU queue.
5. Compare each ready take against **Original** with **Passage**, **Start seam**,
   **End seam** and **Full song**. **Keep take** records the library choice; it
   does not import into the DAW. A short replacement requires listening and
   explicit acceptance of the earlier ending.

The saved draft shelf is shared by the UI and MCP. Refresh shows changes made
through either surface. The preview is invalidated after a known project edit;
the server also checks full project and source fingerprints immediately before
handoff or generation. Editing a project or replacing its recording requires
reviewing and saving a new draft.

Submitted drafts keep their exact audition session. Repeating a submission never
queues a second session. An interrupted submission with an uncertain receipt
cannot resubmit: inspect the ordinary queue and saved auditions before creating
another draft. The dock polls only while visible and takes are active, and its
comparison audio pauses when the dock or browser tab is hidden.

## Supported notation and recordings

The native YuE2 dialect accepts two monophonic pitched voices. Overlapping notes,
percussion and unsupported timing refuse rather than discard music. The exporter
handles rests, ties, pitch accidentals, selection boundaries and changing meters.
It reports omitted velocity, instrument sound, effects and articulation. See
[DAW score export](daw-score.md) for the pure export contract.

Off-grid notes refuse by default. **Quantize preview** explicitly snaps only the
exported ABC to 1/32 notes and reports changed onsets and lengths. DAW notes stay
unchanged. Quantization that produces overlapping notes still refuses.

The source score's editable notation is conditioning, not a guarantee of exact
model performance. Score time and generated audio time can drift, so listen to
the passage and both seams. This workflow does not provide instantaneous YuE2
audio inpainting. The existing piano-roll instrument audition remains the quick
preview while an AI alternative renders.

Protected alternatives in this first workflow require a saved **YuE2 Python**
recording with replay data and full/melody planning. They use the entire edited
fixed-tempo project score as conditioning and the reviewed bar range as the
replacement window. The compositor retains the rest of the recording, with
80 ms blends at the seams, including just before the selected start, and saves
a composed full-song candidate. A complete conditioning score that cannot be
exported disables the takes command; the selected score can still load in Music.
Quantized/ComfyUI routes can use their supported score controls in Music but do
not use this protected passage replay route yet.

## MCP workflow

Every action calls the same `/api/music-daw-passages` backend as the dock.

| Tool | Action |
|---|---|
| `music_daw_passages` | List project drafts and recordings. |
| `music_daw_preview` | Review selected bars as native ABC without saving. |
| `music_daw_draft` | Save the exact reviewed score and request. |
| `music_daw_draft_get` | Read a saved draft and its exact audition receipt. |
| `music_daw_request` | Return the selected-score request after freshness checks. |
| `music_daw_takes` | Explicitly queue 2 or 3 protected alternatives. |
| `music_daw_audition` | Verify an original/candidate hash and return guarded playback bounds. |

Example preview and draft arguments:

```json
{
  "slug": "my-project",
  "fromBar": 5,
  "toBar": 8,
  "voiceTracks": { "Vocal": null, "Ins": "trk_exact_id" },
  "source": "my-original.flac",
  "sourceOffsetSeconds": 0,
  "quantizeTo32nd": false
}
```

Use the returned draft ID and revision with `music_daw_takes`. Optional seeds
must be distinct unsigned 32-bit integers, one per take. The returned audition
uses the existing `music_audition_keep` and cancellation tools; use that
audition's exact ID/revision, not the passage draft's.

Playback requires actual auditioning before an agent claims musical quality or
a clean seam. `music_daw_audition` verifies the stored file fingerprint and
returns a guarded URL whose media request checks it again. Checking a score,
reading a successful job receipt or seeing matching durations does not establish
that the result sounds right.
