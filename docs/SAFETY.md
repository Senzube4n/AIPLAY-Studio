# What Studio will not make

AIPLAY Studio refuses any request whose words pair a child or teenager with
nudity or sexual content. The answer always starts with the same sentence:

> This can't be made: it pairs a child or teenager with sexual content.

The rule applies to every model (built-in, your own checkpoints and LoRAs,
uncensored ones and cloud models), every screen, every MCP agent, the chat,
Simple mode, overnight runs, music-video projects, friends' render orders and
private renders. There is no override: no setting, no flag, no "private" or
"dry run" exemption, and nothing an agent can pass to switch it off. The
"Don't load custom node packs" engine setting does not switch it off either:
the Studio's own safety node always loads.

Adult content is still your choice. The rule covers minors only.

## What is checked

- **The words that will actually be rendered.** This means the prompt after
  wildcards are expanded, the persona is folded in, a cover prompt is written
  from a song's caption, and an MV clip prompt is built from the bibles and
  boards. A graph that computes its prompt while it runs (a string node, a text
  generator, captions read from a folder) cannot be checked, so a picture graph
  like that is refused with its own sentence: type the finished words into the
  text node instead.
- **What the pictures a request uses were made from.** A reference picture, the
  opening frame, the image or document being edited, a Reactive look's source
  clip and style pictures, an MV control render's driving clip, and the clip
  being extended or restyled all count by the prompt they were made from, and
  by the prompt of everything they were derived from, however many edits,
  contact sheets, composites or documents back. Every picture and clip Studio
  makes also carries two yes/no flags (made as a minor, made as sexual) that
  are kept even for private renders and copied onto everything derived from it.
  An MV cast member counts by its description AND by what its chosen sheet was
  actually drawn as, so editing the description afterwards changes nothing.
  A friend's order carries those two flags for each of its pictures, and both
  Studios read them.
- **Disguised spellings**, including leetspeak (`k1d`), letters spaced or
  punctuated apart (`n u d e`, `n.u.d.e`), doubled letters (`chilld`), two
  words glued into one (`kidnude`), zero-width characters, fullwidth letters,
  small capitals, accents, and Cyrillic, Greek, Armenian and Cherokee
  look-alikes. The emoji for a baby, a child, a girl or a boy, and the ones
  used for sex, count too.
- **Languages:** English, Dutch, German, Spanish, French, Italian, Portuguese,
  Polish, Russian, Chinese, Japanese (written and romanised) and Korean.
- **Stated ages under 18** count as a minor: `12 year old`, `12yo`, `age 12`,
  `girl, 12`, `girl (12)`, `grade 5`, `year 7 pupil`, `6 months old`. The age
  of a thing does not (`a 12 year old scotch`).

The **negative prompt is not intent.** Putting `child, teen` in the negative
prompt of an adult render is how you keep minors out of it, and that is never
refused, as long as the sampler really uses it as a negative: at a CFG below 1
a sampler blends its negative INTO the picture, so there it counts. A negation
inside the positive prompt, like "no children" or "no nudity", still counts,
because distilled models read it as a request. The refusal then says to move it
to the negative prompt.

The word "teen" always counts, even when an adult age is stated beside it.

**Deliberately not read**, because in this app's own songs and pictures they
are ordinary far more often than sexual: "hardcore" (a music genre),
"sensual" (a style tag), bare "fingering" (a guitar word), "sucking" and
"licking" (a baby's thumb, an ice cream), "on all fours" and "bent over" (a
crawling baby, a child over a book), bare "explicit" (the Parental Advisory
label on covers), bare "erect", "streaking", "flashing", and the tongue emoji.
Each still counts where it cannot mean anything else ("explicit content",
"fingering her", "streakers").

## What happens on a refusal

- The request is answered **HTTP 422** with
  `{ "error": "<the sentence>[ <what to do>]", "code": "minor-sexual", "hint"?, "found"? }`.
  `error` always starts with the sentence; when there is something to do about
  it (move "no children" to the negative prompt; part of it came from a picture
  or cast member the request uses) that follows in `error` itself, so every
  screen and MCP agent shows it. `found` says where each half came from
  (`"prompt"` or `"context"`), never what the words were.
- A graph whose words are written while it runs answers 422 with code
  `unverifiable-text` and its own sentence.
- **Nothing is queued, staged or sent to the engine**, and a friend's order is
  refused when it is opened, before its prompt is shown.
- The provenance ledger records a `refused` event with the code, the door
  that refused it and the caller. It **stores no prompt, label or hash of
  them**, and a refusal at the engine door leaves no words in the queue's
  status or log.

## Where it is enforced

| Where | Covers |
|---|---|
| The engine door (`server/engine/client.js`, every local render) | Every picture, clip, cover, restyle, MV render, reactive render, chat tool and raw `/api/engine` graph, checked on the final graph before anything is recorded or sent |
| Studio's own ComfyUI node (`server/comfy_nodes/aiplay_safety_gate.py`) | Graphs posted straight to ComfyUI: a revealed or pinned port, and ComfyUI's own page. It asks the Studio. If the Studio does not answer, it refuses everything. The Studio does not reveal the engine's port unless this node reports it is armed |
| The Comfy Router queue (`server/router/jobs.js`) | Every cloud model except a sound model that asks for no picture, checked when a run is added and again just before it is sent. A provider's own safety settings are not read as the prompt |
| The routes, early | `/api/image`, the image editor, `/api/video` (create, extend, run), `/api/restyle`, `/api/art`, `/api/reactive/run` (and the Paint look before a frame is painted), overnight plans at start (each wildcard expansion), MV control renders, the art queue, friends' orders and shots (sending, opening and accepting), video recipes (packing and opening), and the prompt enhancer's style and description fields (what it is asked and what it writes) |

The rule is in `server/safety/minors.js`, what pictures were made from is in
`server/safety/lineage.js`, the graph reading is in `server/safety/graph.js`,
and the tests are `server/safety/minors_test.js`,
`server/safety/doors_test.js` and `server/safety_gate_test.py`.

## What it cannot see

A text check reads words, not pixels. These gaps remain:

- **Uploaded pictures** have no history to read. Catching those would need an
  image classifier.
- **Songs are not checked.** A song's lyrics are not read, and neither are the
  enhancer's lyrics. A caption, a lyric hook or a lip-sync line is checked when
  it becomes a cover or a clip.
- **A custom node that makes its own words** from something that is not text
  (a captioner feeding its own encoder, say) is not seen, unless it is one of
  the string and caption nodes the graph check knows.
- **A ComfyUI you start by hand**, without the Studio, is not governed by it.
- **Other languages and new slang** are not covered beyond the list above.
