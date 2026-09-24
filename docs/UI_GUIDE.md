# UI guide: read this before touching `web/`

This is for anyone, person or AI agent, adding or changing a screen in AIPLAY
Studio. The app has one look. A new feature should fit into it without anyone
having to tidy up after it.

The short version:

- **Say less.** Labels of a few words. At most one short sentence of help.
  Anything longer goes behind "More" or into a tooltip.
- **Use the page kit.** Use `web/ui.css` and `web/ui.js` for full pages, and
  the existing classes for everything else. Don't invent new buttons, inputs
  or colours.
- **Put things where they belong.** Use the placement table below. Don't add
  floating buttons that open a whole feature in a modal.
- **Show status as a chip, not a paragraph.** Explain only when something is
  wrong.

The code rules (tests, CRLF, generic across NVIDIA/AMD/Intel/CPU) still apply.
This file is only about what the user sees.

---

## 1. Text budget

The app had paragraphs under almost every control. People don't read them.
They make the screen look broken and hide the one line that matters.

| Where | Budget | Example |
|---|---|---|
| Field label | 1 to 4 words, lower case | `stop after`, `covers engine` |
| Option text | A few words, detail in brackets | `FLAC (lossless, ~30 MB)` |
| Section subtitle (`.pcard-sub`) | One sentence, about 120 characters max | "Where songs are saved and where ComfyUI lives." |
| Hint (`.hint`) | One sentence | "Takes effect after a restart." |
| Status | A chip of 2 to 5 words | `Qwen Image 2.1 ready` |
| Anything longer | Behind `<details class="more">` or a `title=""` tooltip | "Why the small AI marker has no switch" |

Rules:

1. **No rationale in the UI.** "Why this is built this way", history, bug
   stories, measurements and licence essays belong in code comments, `docs/`
   or the Welcome catalogue (`server/welcome/catalogue.js`). They don't belong
   on screen.
2. **Don't repeat the control.** If the label says "Transparent", the hint
   must not say "Tick this to request a transparent PNG".
3. **Don't tell people what didn't happen.** "Ready to queue" is enough. Leave
   out lines like "nothing was sent, nothing was uploaded, nothing changed".
4. **No em dashes (—) in user-facing text.** Use a full stop, a comma, a colon
   or brackets.
5. **Numbers and paths go in the value, not in a sentence.** Write
   `9.8 GB needed`, not "This recipe will require approximately 9.8 GB of
   graphics memory to run".
6. **A caveat is not an exemption.** "People need to know what this does not
   do before they rely on it" is true and is still not three lines under a
   tick. Put the shortest honest version in the **label** and the rest in the
   `title=""`: `Don't record the prompt` says what it drops without promising
   what it cannot, so the paragraph explaining that it is not the same as
   untraceable is not needed on screen.
7. **Long hints are cut to two lines automatically** (`web/ui.js`) with a
   "more" link. That is a safety net, not permission to write long ones.
   Warnings (`.warnhint`), live status (`role="status"` / `aria-live`) and
   `.noclamp` are never cut. So keep those short too.

## 2. Status: a light or a chip, never a paragraph

**When the status belongs to a choice in a dropdown** (is this model ready?),
put a light inside that dropdown, where its arrow is. The Qwen Image 2.1
light on the Images engine dropdown is the reference (`imgQwenPaint()` in
`web/app.js`, `.qwenpv` / `.qdot` / `.qpop` in `web/ui.css`):

| State | Looks like | Behaviour |
|---|---|---|
| checking | orange spinning ring in place of the arrow | dropdown still usable |
| ready | slow green pulse; after 2 s it slides left and the arrow returns | nothing else shown |
| not ready | red light | details pop out **beside** the field: one line of what is wrong, "↻ Check again", and a fix button only when it applies ("Open Models" when files are missing); ✕ closes it, clicking the light reopens it |

- Hovering the light says what it is doing (`data-tip`, drawn by CSS).
- Clicking the light opens the dropdown (`showPicker()`), except when red,
  where it opens the details. **A status light must never block its control.**
- The spinning/pulsing is on an inner `<i>`, so the hover pop-up does not
  spin with it.
- The pop-out is `position: fixed` and **follows its field** while open (one
  `requestAnimationFrame` per frame, writing only on change, and a 500 ms
  timer instead while the field is off screen). A position measured once goes
  stale as soon as the column scrolls or the screen switches.

**A light costs a request, so do not light it on every repaint.** Three rules,
all learned from the Qwen one flickering on every drag and drop:

- **Key the answer on what actually changes it, not on what is on screen.**
  The readiness key sent `refs: <count>`, so adding or removing any reference
  changed it and fired a fresh check; the answer depends only on whether
  there are references at all (`server/qwen-status_test.js` holds that to be
  true, and fails if a future graph breaks it). Send a bucket.
- **Form painters must not reach for the network.** `imgRefsPaint()` runs
  once per dropped picture. Route a check called from a painter through a
  short debounce (`imgQwenCheckSoon()`, 400 ms); anything the user clicks
  calls the check directly, because a control that waits feels broken.
- **Painting the same state twice is not painting.** `imgQwenPaint()` returns
  early when the tone, chip and note are unchanged, and the busy state waits
  350 ms before it shows. A local check answers in milliseconds, and a light
  that flicks orange and back reads as a fault; one that spins only when the
  answer is genuinely slow reads as work.

**Everywhere else**, use a chip (in `web/ui.css`):

```html
<span class="chip ok">Qwen Image 2.1 ready</span>
<span class="chip warn">Model files missing</span>
<span class="chip err">Could not check</span>
<span class="chip busy">Checking…</span>
```

- When all is well: **the chip and nothing else.** No note, no extra buttons.
- When something is wrong: the chip names the problem, and **one** short
  `.hint` says what to do. Show only the button that fixes it (for example
  "Open Models" only when files are missing).
**Before (Qwen box):** a bold heading, three sentences of status, two buttons
that were always visible, two options and a three-sentence note about them.
**After:** a light in the engine dropdown and two option rows. Details appear
only when there is a problem.

## 3. Full pages: the page kit

Settings, About, Engine and Music Lab all use this. Any new full page must
use it too.

```html
<div id="mypage" hidden class="page">
  <header class="page-head">
    <h2>My page</h2>
    <p>One short line about what this page is for.</p>
  </header>
  <nav class="pnav" aria-label="My page sections"></nav>   <!-- filled by ui.js -->

  <section class="pcard" id="mypage-first" data-nav="First">
    <h3>First</h3>
    <p class="pcard-sub">What this section does, in one sentence.</p>
    <div class="params">
      <label for="myThing">my thing</label>
      <span class="pv"><select id="myThing" class="sel2">…</select></span>
    </div>
    <details class="more"><summary>How it works</summary>
      <p>The longer explanation, for the few who want it.</p>
    </details>
  </section>
</div>
```

- **The pills are automatic.** Every `.pcard` with an `id` and a `data-nav`
  gets a pill in the page's `.pnav`, which scrolls to it and lights up while
  it is in view. Don't hand-write pills.
- **One card per topic.** Cards are the separation. Don't stack loose
  headings and grids between cards.
- **Write `hidden` before `class`**: `<div id="engine" hidden class="page">`.
  Some tests match `id="x"\s+hidden`.
- Use `class="page page-wide"` for wide tools (Music Lab); plain `page` is
  940px.
- Inside a card, use `.cta` for a row of buttons, `hr.sub-rule` plus `h4` for
  a sub-group, and `.params` for label/value rows.

## 4. Where new things go

| You are adding… | Put it… |
|---|---|
| An option for one generation (a sampler, a LoRA, a size) | In that screen's form, in its `.params` grid, next to similar controls. Advanced or rare options go in the existing "More controls" / "Lab" disclosures. |
| A property of the **run itself** (don't record the prompt, don't keep the intermediates) | Under the panel's main button, in its `.ctawrap`, as a one-line `.tog.ctatog`. It belongs with the control that starts the run, and `.ctawrap` is one of the few things Simple mode keeps. **Not** inside whichever `.field` happened to be open: dropped into the Images reference block, "don't record the prompt" read as a property of the references and pushed the drop box further down a column that already scrolls. |
| A set-once preference | In **Settings**, in the matching card (Songs, Cover art, Video, Enhance, Battery Safe, Provenance, No strong graphics card? (a friend first, then the Hosted engine and the Comfy API key), Workflows, Folders). Only add a new `pcard` with `data-nav` if nothing fits. Persist it through `PREF_PATHS` in `server/config.js`. |
| A new tool or workflow for an existing area (more music workflows) | A **tab** in that area's page (Music Lab has five). Not a new button in the form. |
| A whole new area with several tools | Its own **rail page**, registered in all four places below. |
| The cost or caveat of the main button ("about 4:00 on your card") | A `.ctanote` inside the `.ctawrap`, in the flow under the button and always visible (UI_PLAN C2 undid the hover drop-up: the estimate is needed before pressing). The **receipt** above it (web/receipt.js, `RECEIPTS`) says what the button will do, `engine · steps · length · estimate · Change`, each field naming the control that owns it; while the receipt carries the estimate the note steps aside (`.rc-took`). An empty note draws nothing. **A warning or failure is `.stick` and stays in place** ("⚠ 'X' failed", "⚠ no build for 7 steps on this disk", "That render failed."): a failure shown only under the pointer is a failure nobody sees. The next estimate takes `.stick` off again. |
| A second way to run the same thing (Preview beside Create) | In a drawer behind an arrow welded to the main button's right end (`.ctasplit` / `.ctadrawer`), opening upward. Not a second button of the same size: that reads as an equal choice. When an engine has no second way, the arrow is absent and the button is plain again. |
| A confirmation ("delete this?", "run on battery?") | `appConfirm()` from `web/dialog.js`. Modals are for questions, not for features. |
| Something about the machine or the engine | The **Engine** page, or a chip in the corner. |
| Background explanation of a screen | The Welcome catalogue (`server/welcome/catalogue.js`), which feeds the ⓘ panel and the tour. Not the screen itself. |

**Never** add a full-width ghost button above a form that opens a whole
feature in a `<dialog>`. That is how "Music workflows" ended up hidden. It is
now **Music Lab** in the rail.

### Adding a rail page: all four, or the tests fail

1. The rail link in `web/index.html`: `<a href="#" data-view="mypage" …>`.
   **Where in the rail:** the Make group holds only what a newcomer comes for
   (Home, Music, Pictures, Video, Music video). Everything else goes inside the
   "More tools" fold (`<details id="navMore">`), and housekeeping in
   `.navbottom` (Models and Settings stay there, never below the fold).
   `server/welcome/level_test.js` pins all three lists.
2. The toggle in `setView()` in `web/app.js`: `$("mypage").hidden = name !== "mypage";`.
3. The ⓘ mount: a line in `INFO_HOSTS` in `web/app.js`.
4. A paragraph in `server/welcome/catalogue.js`, and bump the count in its
   "…paragraphs in a row" comment (`server/welcome/catalogue_test.js` checks
   it).

## 5. Components: use these, don't invent

| Need | Class |
|---|---|
| The one main action of a panel (Create, Render, Make image) | `.btn` (plus `.primary` / `.wide` where the panel already uses them). One per panel. |
| Secondary action | `.btn2` |
| Destructive secondary (Interrupt, Clear) | `.btn2.danger` |
| Highlighted secondary (Run, Adopt) | `.btn2.go` |
| Small tool button inside a form | `.edtool` |
| Select | `.sel2` |
| Short text/number field | `.in2` (`.in2.num` for numbers) |
| Full-width text field | `input.line` |
| Label/value grid | `.params` with `label` + `span.pv` pairs |
| Status | `.chip` + `ok` / `warn` / `err` / `busy` |
| Help text | `.hint` (one sentence) |
| Warning | `.hint.warnhint` (one sentence, never cut) |
| Long explanation | `details.more` |
| A picture input (reference, frame) | `mountPicDrop()` from `web/picdrop.js`: drop from the gallery or desktop, "Library ▾", "Upload…". Never a bare select plus file button. |
| A gallery tile the user may drag into a picture input | `draggable="true"` plus `data-picdrag='{"name","url"}'` |

- **Colours come from tokens only:** `--ink --dim --faint --ghost` for text,
  `--primary --ok --warn --err` for state, `--panel --raise` for surfaces and
  `--hair --edge` for borders. No hex colours in new CSS.
- **New CSS goes in the feature's own file**, scoped under its root id
  (`#musicWorkflows …`, `.eng-…`). Don't grow `web/styles.css`. Shared
  patterns go in `web/ui.css`.
- If a class you want doesn't exist, check `web/ui.css` and `web/styles.css`
  first. `.btn2` was used on the Engine page for months without a style, and
  rendered as a raw browser button.

## 6. Picture inputs: the drop box (`web/picdrop.js`)

Every place that takes a picture (Images references, Video starting and
closing frame, pass-through frames, H3 reference pictures) uses
`mountPicDrop()`. It copies the Music screen's "Drop a song here" box
exactly, and so should anything new:

- **The dashed zone is hidden until a picture is dragged**, then slides open
  (the same grid-rows animation, 18px dashed border and blue glow as Music's
  `.songref`). It is not a permanent box.
- **A dragged gallery picture travels as a small card** (thumbnail, prompt,
  model), Music's `.srghost`. The thumbnail is drawn on a canvas from the
  tile's already-loaded image, so it is never blank.
- **A single slot that holds a picture is a card**: thumbnail, name, one line
  (size and shape), ▾ to choose another, ✕ to remove. Music's `.srfull`.
- **"Library ▾" and "Upload…" are always there.** The library menu is a
  thumbnail grid (gallery and song covers) with "Upload from this computer…"
  at the top; it opens upward when the box sits low on the screen.
- **Multi-picture slots show their pictures inside the zone** (`strip` option):
  square tiles in a grid that fills across and then down, number badge,
  ✕ in the picture's top-right corner, the clickable "image 1" tag and ◀ ▶
  under it, "Clear all" in the zone's corner. The zone stays open while it
  holds any pictures and glows when more are dragged over it.
- **Toolbar placement** (`bar` option): Library / Upload can join an existing
  row. Images puts them beside the character picker: one row of
  `Character… · Save · Library ▾ · Upload…`, labels kept short enough to fit.
- **Drop anywhere** (`dropAnywhere()`): a picture dropped anywhere on the
  Images panel becomes a reference; on the Video panel, the starting frame.
  A box of its own still wins. The boxes sit low in scrolling columns, so a
  small target alone is not enough.
- **A blocked box still takes the drop** and says why (full, or an engine
  without references). Otherwise the browser opens the picture instead.
- The box never owns the data. It calls the screen's `onPick` (a library
  picture) or `onFiles` (anything else, fetched into a `File`), and the
  screen's existing upload and preview code does the rest. When the old
  select or upload button holds state, **hide it, don't delete it**.
- Gallery tiles that can be dragged carry
  `draggable="true" data-picdrag='{"name","url"}'`.

**⚠ The strip's `hidden` is the drop box's input, not decoration.** With the
`strip` option the box opens its zone on
`!strip.hidden && strip.children.length`. A screen that paints its own strip
**must** keep setting `strip.hidden = !count` (Images does it in
`imgRefsPaint()`). Replacing that line with a class — even a well-meaning
"always on screen" one — leaves `hidden` set from the markup for ever: every
dropped picture is accepted and added, the zone never opens, nothing appears,
and the report is "drag and drop is broken". The target is not invisible in
the meantime: the zone slides open while anything is being dragged, and
`dropAnywhere()` covers the whole panel.

**A hover preview must hide on repaint, not only on `mouseout`.** The strip is
rebuilt with `innerHTML` on every add, remove and reorder, so the figure the
pointer is over is destroyed and **no `mouseout` is ever delivered** — remove
a reference while looking at its enlarged preview and the preview hangs there
over nothing. `imgRefHoverHide()` is a named function for that reason and the
painter calls it. Four exits: the repaint, a `mouseover` that is not a
thumbnail, scrolling, and the pointer leaving the window.

## 7. Galleries (`web/galleries.css`)

Songs, pictures and clips share one look: rounded tiles on a quiet surface,
a lift on hover (not a hard outline), the title and **one** line of detail.
Badges (engine, loop, size) are small pills.

- No "Tick … to act on several at once" style instructions. The checkbox
  explains itself.
- A clip poster that fails to load falls back to the browser's own frame of
  the clip, then to a ▷ placeholder. **Never show a broken-image icon.**
  Posters come from OpenCV (`scripts/clipthumb.py`), which a portable Python
  may lack and which cannot read every codec.

## 7b. The transport bar

- **It is not a fixture.** It appears when something plays and goes when there
  is nothing left to control: the end of the queue, or the ✕ at its far left.
  A pause keeps it, because the next thing you do is press play. It was added
  on the first `play` and never removed, so one song left it across the bottom
  of every screen for the rest of the session.
- **It stops at the rail.** The shell's grid areas are
  `"rail create stage" "rail player player"`: the rail spans both rows, so the
  bar starts at the rail's wall. Spanning every column (`"player player
  player"`) put it under the quick-access menu, cut off the bottom of it, and
  pushed everything in it up.
- **Its height is `--playerh`, set on `.shell`, and it is `0px` while the bar
  is closed.** Anything that stops above the bar (the full player, the song
  panel) uses that variable. Both used to hard-code 64px, which was wrong
  whenever the bar changed size and wrong the whole time it was shut.
- The two controls that resize it sit at the two ends: ✕ at the far left,
  the full-player arrow at the far right, transport in the middle.

## 7c. The rail's foot

- **One box for what is being made.** There were two, eight inches apart,
  counting the same queue in different words. `#workBox` is a one-line strip
  (what is being made, how long it has left, a dot that pulses while it runs)
  with a panel that opens **upward** on hover, click or focus: the state, the
  ETA and the clock time, what is waiting behind it by kind, the day's tally,
  Stop and "all jobs". **The panel's own line is a link to the jobs page**:
  when idle the Stop button is hidden, so without it the panel was a dead end. It sits above the Ko-fi button, and the panel is
  absolutely positioned so opening it moves nothing.
- **It says "idle" when nothing is rendering**, with the day's count, and no
  Stop button.
- **"Done today" is counted from the files' own timestamps** (songs'
  `createdAt`, pictures' and clips' `at`), not from a session counter that
  resets when the app does.
- **The rail's width is `--railw`, 248px, and there is a grip on its right
  edge** (`.railgrip`, drag / arrow keys / double-click to reset, remembered
  per browser, clamped 200–420px). It is not 220px because the meters pair two
  to a row: at 220 each cell was 93px and the disk and CPU figures were cut off
  on a 1080p screen. **A figure that has to fit half a rail is written to fit
  it** — the long halves (free space, drive fullness, core count) go in the
  tooltip, never into an ellipsis.
- **Four meters, two to a row** (`.meters`), each answering a different "why
  is this slow": VRAM, system RAM, disk (what the models cost, with how full
  the drive is in the tooltip) and CPU. Each keeps its own fill bar: the
  number is exact, the bar is the glance. A meter with no reading yet shows an
  empty bar and says so rather than a made-up 0%.
- **⚠ No divider between them.** Every meter used to carry its own
  `border-top`, and `--edge` is a translucent **blue** — so four meters drew
  four blue rules across the foot of the rail in among their four fill bars,
  and a separator could not be told from a reading. One hairline above the
  whole block, none between.
- **⚠ The drop-up is `position: fixed`, and app.js places it.** `.rail` is
  `overflow: hidden`, so an absolutely positioned panel is clipped by it —
  invisible at full width, and sliced in half once the rail is collapsed to
  64px. Anything that has to escape the rail needs the same treatment.

## 7d. Licence credits in the interface

Some model licences ask for the model's name **in the interface**, not on a
credits page: MiniMax-Music3 §3.1 and MiniMax H3 §IV.2 both do. In this app
that is the `.poweredby` button at the very top of the rail, above the mark.

- **It is conditional.** It appears when the engine whose licence asks for it
  is the selected one, and names that one. ACE-Step is MIT and YuE2 is
  CC BY-NC; neither asks, so neither is named there.
- **It explains itself.** Pressing it says which clause it serves and that
  choosing another engine removes it. A name with no explanation invites "why
  is this here", and the answer belongs where the question is asked.
- **It is the name and a `?`, nothing else.** The clause asks for the NAME
  shown prominently; "Powered by" was two thirds of the line and served
  nothing. One 21px row.
- **It is not the only place.** The Models screen names the model against
  every capability and quotes the clause before anything is downloaded, and
  `examples/README.md` carries it; `server/docs_test.js` pins both. Do not
  remove it from those.
- Do not add a general "running locally" or "powered by <whatever>" line
  beside it. The work box says what is happening.

## 8. Motion and the visualiser

Only three things move with the music: the player bar's line, the playing
song's row (artwork pulse, equaliser bars) and the player's artwork. Do not
add more reactive surfaces. The rail foot, the Advanced box, the Create bar
and every scrollbar used to pulse too, and it was too much. Everything
animated respects `prefers-reduced-motion`.

## 8b. Load and unload

- **One button: Unload.** Load is hidden (not deleted — the route and handler
  stay wired), because the first song loads the model anyway.
- **It is shown for every engine and disabled rather than absent** when there
  is nothing on the card. A control that comes and goes teaches nobody where
  it lives, and it was the main reason it "worked sometimes".
- **⚠ "Is anything loaded" is two questions.** `loadedModel` is the MUSIC
  model. Rendering a cover or a clip unloads it and puts a picture model on
  the card, so `loadedModel` goes null while ComfyUI is holding several GB —
  `artResident` is the other half (`server/jobs.js` snapshot). Unload frees
  whatever is there, so it is enabled on either.

## 9. Simple mode and the model bar

- **Which one a screen opens on is the saved level** (`web/level.js`,
  `server/welcome/level.js`): Simple on a new install, Advanced on one already
  in use, and a Home card opens its screen Simple either way. The per-screen
  switch is a choice for one visit; "Show every setting" (Settings, the foot of
  the rail, `studio_welcome {action:"level"}`) is the one that is saved. The
  Advanced switch is always visible in Simple, and its tooltip is the server's
  "Advanced adds ..." line. **A new Simple screen subscribes with `onLevel()`**
  and its row goes in `ADVANCED_ADDS`, naming the control ids it promises.
- **In Simple the one button says what it makes** ("Make song", "Make picture",
  "Make clip"), never a bare arrow, and **pressing it is the go-ahead**. With a
  writing model it asks the assistant, and a reply that set the form up without
  starting it is followed by the real button (the log says "You pressed Make
  …"). With none (the server answered, and has none), Pictures and Video put
  the words in the real prompt and press the real Make button; Music makes the
  song already in the form when nothing was typed, and when words were typed it
  says they cannot become a song yet and offers the form's song, never making
  it in their place. While the engine is still starting, whether there is a
  writing model is NOT KNOWN (`web/writer.js`): nothing is sent, the log says
  so, and the next press asks again. The real buttons (#btnCreate, #imgGo,
  #vidCreate) stay hidden in Simple on purpose: the labelled button presses
  them, and two Make buttons on one screen is one too many. So #vidCreate is
  NOT added to the exception rule below, and adding it would change nothing
  anyway: #imgGo and #vidCreate sit inside `.ctawrap > .cta`, which Simple
  hides in its own rule (the `:not(#imgGo)` in the exception list is a leftover
  from before the button moved there). `server/welcome/level_test.js` §9 pins
  the Make buttons.
- **The Music screen has one "Advanced"**: the level switch (#modeAdv). The
  fold under the form is **More Options**, and YuE2's melody box is **Melody &
  score** (#yMusicPlan), named for what it holds. There used to be a second box
  called "Advanced Options", and a tester looking for the melody never found
  it. On engines without that box, #melodyPointer at the top of More Options
  says where it is. Do not name a new box "Advanced …".
- **A row an engine cannot take is absent, and a row that is shown is sent.**
  YuE2's rows carry their rule in the markup: `data-python-yue` (the Python
  kit's alone: key, tempo, meter, "let the planner continue", the cover prime,
  its precision), `data-no-comfy-yue` (not the ComfyUI build: Guidance),
  `data-native-gguf` / `data-no-gguf`. `musicEnginePaint()` hides by them and
  `yueSpec()` / the GGUF branch of `currentSpec()` send by the same rule.
  `server/music-engine-rows_test.js` runs that code over the real markup for
  each build and fails if a visible row is dropped, a hidden one is sent, or a
  build's door would refuse the spec. A row the build takes only sometimes is
  shown **disabled, with the reason beside it**, and is not sent: Planner
  temperature on GGUF and ComfyUI while a score is sung as written or Thinking
  is off (`planDialOff()`, `#yPlanTempNote`).
- **A Stop stops its own work.** The transcription's Stop (#humCancel) goes to
  the narrowest door for the step it is on (`humStopPlan()`): this song's
  separation through `/api/artqueue` (`stop_current` running, `drop` waiting),
  and SheetSage2 through `/api/cancel` only after a question that names the
  song, clip or picture jobs that would stop with it. What it says afterwards
  is read from the door's reply.
- **Rights words are the catalogue's.** A song, a Models card, the queue line
  and the receipt under Create read `outputRights` (`chip`, `short`) or a
  library row's `rights`; the page types no rights word of its own beyond
  `RIGHTS_WORDS`, the fallback for a row without a chip.
- **Simple mode** (`.assist-on`, `web/assist.js`) hides every child of the
  form except a short list of exceptions in **one** rule in
  `web/styles.css`. Something the person dropped must stay visible, which
  is why `#imgRefWrap` and `#vidFromField` are in that list. Add exceptions
  **before** `:not(.ctawrap):not(.infopanel)`: a test pins that ending.
  Video's Simple shows *Keep my character* and *Song under the clip* besides
  the size chips and starting frame, because a person's identity and lip-sync
  are the two things a newcomer cannot recover afterwards (REWIND A/B,
  DIRECTING.md §2).
- **The Music model bar**: the About button sits absolutely over the row's
  left edge, so the row reserves that space and the model name ends in an
  ellipsis. Load / Unload show for every ComfyUI model, greyed out with the
  reason rather than hidden.

## 10. Restructuring without breaking things

- **Keep every `id`.** `app.js` and the tests find controls by id; moving
  them between containers is safe, renaming is not.
- **Hidden beats deleted** for any control whose value `app.js` still reads
  or writes.
- **Class names are global.** A new `.side` class collided with the song
  panel's `.side` (fixed, full height) and stretched a pop-out down the
  screen. Prefix new classes with the component (`.qpop`, `.pd…`, `.eng-…`).
- **Anything that sets `display` must also handle `[hidden]`**, e.g.
  `.pdrow[hidden] { display: none; }`, or the element ignores `hidden`.
- **`let` / `const` used by a function that can run at boot** throws before
  its line is reached. Use `var`, or declare it above the first caller.
- **Two scripts may not fight over one element.** A picture box that opens a
  menu must close it on outside clicks through its own record of where the
  menu lives, not `querySelector` from the box.
- **The boot test runs `app.js` in a fake DOM** (`scripts/trace_load.mjs`).
  Guard browser-only APIs (`MutationObserver`, `DataTransfer`, layout
  measurements) and never assume a list is non-empty at load.
- **Checking visually:** serve `web/` from a small static server that answers
  the `/api/*` routes with fake data, rather than starting Studio and
  ComfyUI (which would load models). Screenshots can time out when the window is
  hidden; measure with `getBoundingClientRect()` instead. CSS transitions
  pause while the pane is not drawing, so a measurement mid-transition lies.
  Set `transition: none` before measuring.

## 11. Tests that read the UI

Changing layout or copy can trip these; update them in the same change, with
a comment saying why:

| Test | Pins |
|---|---|
| `server/ui-kit_test.js` | the page kit, Music Lab, the drop boxes, the Qwen light, visualiser scope, poster fallback, Simple-mode exceptions |
| `server/simple-remix_test.js` | Images / Video / Music column layout and order, the Simple-mode rule's ending, frame rows |
| `server/welcome/ui_test.js`, `catalogue_test.js` | every rail entry has an ⓘ and a catalogue paragraph; counts written in comments; the About page's "N kinds of layer" |
| `server/engine/ui_test.js` | `id="engine" hidden`, engine.js actions |
| `server/mcp-image_test.js` | the Images reference ids |
| `server/models-screen_test.js` | Unload is always offered |
| `scripts/trace_load.mjs` | `app.js` evaluates with no top-level throw |
| `server/music-engine-rows_test.js` | every YuE2 row shown on a build is sent and taken by its door, none hidden is sent; Melody & score, the stem-python row, Jobs "stopping…" / "stopped", the rights chip words |
| `server/welcome/level_test.js` | the level (fresh Simple, in use Advanced, an unparseable settings.json never written over, Home cards Simple), the rail's Make / More / bottom lists, the phone media rule in `web/shell.css`, the first-run lines, the "Advanced adds" ids (present, and hidden by Simple), the Make buttons |

New web scripts get a `node --check` line in `.githooks/pre-commit`.

## 12. Checklist before you commit a UI change

- [ ] Every label is 4 words or fewer, and every hint is one sentence.
- [ ] No explanations of design decisions on screen (they go in comments or
      docs).
- [ ] No em dashes in anything the user can read.
- [ ] Status is a light (in a dropdown) or a chip; details show only when
      something is wrong, and never block the control.
- [ ] It sits where section 4 says, not in a new modal or a new floating
      button.
- [ ] A new full page uses the page kit, and its sections have `data-nav`.
- [ ] A new rail page is registered in all four places.
- [ ] A picture input uses `mountPicDrop()` and looks like Music's song box.
- [ ] Only existing component classes and colour tokens are used; new class
      names are prefixed and checked for collisions.
- [ ] Every `id` survived; controls holding state were hidden, not deleted.
- [ ] A picture input's painter still sets `strip.hidden`, and any hover
      preview hides when the strip repaints.
- [ ] No painter reaches for the network on every repaint; a readiness key
      is keyed on what changes the answer, not on what is on screen.
- [ ] A seed, or anything else that decides what comes out, is random by
      default. A fixed one in the markup means every machine makes the
      same thing from the same words.
- [ ] Nothing on screen claims something cannot be measured that the app
      already measures (render times, VRAM, RAM, disk, CPU).
- [ ] A two-way control is a switch showing both sides, not one button naming
      the side you are not on.
- [ ] Works in Simple mode as well as Advanced.
- [ ] Looked at it at a normal window size and at 700px wide.
- [ ] `.githooks/pre-commit` passes (UI tests read `web/index.html`).
