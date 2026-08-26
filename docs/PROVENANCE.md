# Provenance — what the studio records, what it embeds, and what that proves

AIPLAY Studio labels AI content honestly and documents human creative work as
evidence. Nothing here disguises AI output as human; the system's job is to
make the AI parts unambiguous and the human parts undeniable. This page is the
user-facing truth of the v1 system; the design document behind it is the
Provenance Ledger SPEC.

## What is recorded

Every project keeps an **append-only event ledger** — one JSONL file per
project, beside the project it describes:

    ~/.aiplay-studio/provenance/library.jsonl     songs, images, clips, covers
    <output>/vfx/<comp>/provenance.jsonl          each VFX comp

Events land where the work actually happens, automatically:

| when | event | origin effect |
|---|---|---|
| a song renders | `generate` (model, version, prompt hash, seed, settings) | ai-generated |
| you typed the lyrics | `author_text` (length + text hash) | human-authored contribution |
| an image is generated | `generate` (engine, prompt hash, seed) | ai-generated |
| you edit an image (adjust/effects, document render, cutout, upscale) | `edit` (ops + params hash) | your edits promote ai-generated → **ai-assisted-human-edited** |
| a layer document carries typed text layers | `author_layer` | human-authored contribution |
| a VFX comp renders | `export` in the comp's ledger (model-free composite + layer census) | ai-assisted composite |
| audio is transcribed to notes | `generate` (analysis, model) | ai-generated analysis |
| a file is exported/converted/bounced | `export` (format + what was embedded) | seals the origin map |

Each event carries **who acted**: `user` (a click in this app), `agent:<name>`
(an action driven over MCP), or `system` (an internal job — overnight batches,
auto covers, watchdogs). This is stamped at the API boundary and **cannot be
configured**: the MCP layer always identifies itself as an agent, an absent
attribution records as `system`, and nothing — no header, no environment
variable, no setting — records an AI-made action as a human one. An agent's
edit never counts as your edit. That rule is the entire evidentiary value of
the record: a tool that could fabricate human deliberation would make every
honest record worthless too.

**Capture is not a toggle.** The ledger always records, locally. There is no
transmission anywhere — deleting a project deletes its ledger, and that is the
whole of the control surface, because a gap in your own record only ever costs
you (evidence not captured now cannot be exported later).

## What is embedded in exported files

Two tiers, written wherever a file leaves the studio (song landing, format
conversion, timeline bounce, image export):

**Tier 1 — the AI marker. Always written; no off switch.**
A small machine-readable disclosure on AI-generated material: the IPTC
`DigitalSourceType` URI (`trainedAlgorithmicMedia` for AI output,
`compositeWithTrainedAlgorithmicMedia` for AI you edited,
`compositeSynthetic` for mixes, `digitalCreation`/`digitalCapture` for human
work), a plain sentence naming the model, the generator and the tool version.

Where it lives: FLAC/Opus — Vorbis comments (`DIGITALSOURCETYPE`,
`AI_DISCLOSURE`, `GENERATOR`, `TOOL`); MP3 — the same as ID3v2 `TXXX` frames;
PNG/JPEG — an XMP packet (`Iptc4xmpExt:DigitalSourceType`, the disclosure as
`dc:description`). `exiftool` and `ffprobe` read all of it with no special
convention, and Google and Meta read the image form.

Why there is no switch: the MiniMax-Music3 licence requires machine-generated
content to be disclosed, and the **EU AI Act (Article 50(2))** puts the
machine-readable marking duty on the *tool's provider* — the studio marks so
you never have to think about it. A marker-free build would be AIPLAY shipping
a non-compliant AI system under its own name. (The source is Apache-2.0; a
user who modifies it has made their own system, under their own name — that is
the honest boundary.)

**Tier 2 — the detailed record. Yours; a real toggle.**
Prompts, lyrics, seeds, sampling settings, the per-part origin map, and the
ledger chain head. Settings → *Embed detailed provenance in exports* governs
it (default **on**). Kept in, it strengthens your authorship evidence
everywhere the file travels; turned off, it stays on your machine. Turning it
off never touches the marker, the ledger, or files already written.

Containers that cannot carry a payload get a **`<file>.provenance.json`
sidecar** instead (Opus's C2PA story, WebP/AVIF/TIFF image exports), and the
result always says which of embed/sidecar actually happened — the studio never
claims an embed that fell back.

Honesty about survival: embedded metadata is strippable, and most social
platforms strip it on upload today. The marker is the studio's duty discharged
at the point the file is minted; survival downstream is the ecosystem's
current weakness, not a promise this tool can make.

## What is displayed

The song panel carries a **Provenance** section — human contributions first
(your lyrics lead), each AI part named with its model, edits split honestly
between you, agents and the system. The image editor shows a per-image origin
line. Settings → *Show provenance badges* hides all of it (default on) —
display only; it never stops capture or embedding. Tracks made before the
ledger existed say "no record" rather than guessing.

## The integrity chain — and its honest ceiling

Every event carries the SHA-256 of the previous event's line. What that
**proves**: internal consistency — nothing was silently inserted, deleted or
reordered without recomputing everything after it (`provenance_read` with
`verify`, or `GET /api/provenance?verify=1`, walks it).

What it **does not prove**: authenticity. This is unsigned, local data on your
own machine; a determined person can rewrite the whole chain. What makes it
evidence anyway is contemporaneity and texture — a ledger grown over weeks,
interleaved with file timestamps, kept takes and embedded workflow data, is a
studio notebook, and that is the kind of corroborating record rights offices
weigh. It is not a certificate, and this tool does not pretend otherwise.
(Cryptographic anchoring and C2PA signing are the planned v2 layer.)

## For agents

The MCP tool `provenance_read` returns any item's origin summary, event trail
and chain head. Actions driven over MCP are recorded as `agent:*` — read the
ledger before making any claim about who made what.
