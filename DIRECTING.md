# Directing notes — read this before starting a video

Everything here was paid for with GPU time. Each rule is followed by the failure
that produced it, because a rule without its failure gets argued away by the
next person who has not seen it happen.

The one sentence that covers most of this file:

> **Most failures were a prompt underspecifying geometry, count, contrast or
> scope.** Asked something ambiguous, the model resolves it by moving whatever
> is cheapest to move.

It used to say *every* failure, and *never* the model being incapable. Six
entries below disprove that: one cause is still unknown, re-rolling fixed six
clips that no rewrite touched (seed noise), H3 runs out of memory on a long
1080p scene (a card limit), detail that was never sampled cannot be upscaled
back (a sampling limit), a grey-box figure handed to VACE comes back as a dark
slab at every strength in the usable window (a limit of what a control clip
carries — §5), and the pose estimator finds no person in 43 of 121 anime frames
or in any grey capsule (an instrument limit — §5). A file whose opening sentence
its own contents contradict teaches the reader to discount the rest.

⚠ This count was four until the blocking work of 2026-09-03/05 added two. The
file's own rule applies to the file: count before you write a count.

---

## 1. Shot design

**One subject, one motion, one camera idea per shot.**
Eight shots in *Salt and Static* failed twice each because they asked for two —
a camera whip-panning *with* a moving car, a silhouette crossing a window *while*
the camera pulled back. Re-rolling never fixed one of them; rewriting fixed all
of them.

**The geometry has to be possible.**
- A camera cannot orbit someone standing **behind a counter** without passing
  through it. Asked anyway, the model span *her* instead and clipped her through
  the table. Orbits need the subject in clear floor.
- Nobody can reach **through glass**. "Wren reaches over and switches the
  headlights off" put her outside on the bonnet, because headlights are outside.
- An **unplaced control is placed at the part**. Say "the dashboard switch by her
  knee", not "the headlight switch". A button with no established position was
  invented *inside the waffle iron*.

**Camera moves are fine — the earlier "lock it off" rule was too broad.**
What fails is a camera *chasing* a moving subject. A camera *orbiting* someone
dancing in place is tractable: the subject stays centred by construction. Say
explicitly that the camera moves and **the subject does not turn**.

**A camera move no longer has to be carried by words alone.** Block it in
Blender, render the blockout at the control contract, and put it on WAN 2.1
VACE's `control_video`: the render follows the move. One arm of a ten-arm gate,
2026-09-02/03, shipped on those numbers: camera-motion agreement **0.924**
against a 0.50 floor and that arm's own time-shift null of 0.402, motion ratio
0.82 inside its 0.4–2.5 band, and a similarity to the blockout of 0.524, *under*
the 0.736 bar that would mean the boxes came back. Three seeds landed at
0.916/0.924/0.942, and every figure quoted here is the median of those three.

⚠ That gate's control was a synthetic grey corridor rendered at the contract,
not a Blender blockout. A blockout is the same kind of picture at the same
contract, which is why the number is quoted here at all — but the substitution
is an argument, not a measurement, and §5 makes it again at length.

So *camera moves are fine* now splits in two: a **blocked** move is drawn by
the blockout and the prompt need not describe it; a **prompt-only** move still
has to be told that the subject does not turn. What the control does
NOT carry — surface, colour, light, the set, hands — is the prompt's job, and §5
has the contract, the ladder and the traps.

**A grey box is a camera and a placement. It is not an actor.** Three VACE
renders of a two-figure blockout on 2026-09-03 carried both figures to their
projected positions and rendered them as **dark slabs**; the pose estimator
found a person in 1 frame of 363, and that one was a 1106x641 px skeleton fitted
to the corridor. Lowering the strength to 0.75 and 0.50 on 2026-09-04 gave the
same slabs, darker (§5, *The performer*). If the shot exists to show a face, a
grey box cannot be where the face comes from.

**Not everything should move.** If the camera never stops, nothing reads as fast
and the cuts stop landing. Keep some shots locked off on purpose.

**A hybrid character's face can break, and after four takes the cause is still
unknown.** Kaelith is a fox-EARED woman. One shot went dark, then grew a glowing
orb on her nose, then a full black muzzle with whiskers, then came out clean.

Two things were settled by looking rather than reasoning, and both are useful:
her reference sheet has a **plainly human nose**, so the references were never
the cause; and the background plate holds a skull whose black nasal aperture,
candle flame and glossy red crown are the muzzle, the streak and the orb, in
order — the shapes had a donor sitting in the set.

The trigger is NOT settled. The clean take kept the references and the push-in,
and its face is ~1.5x LARGER than the take that broke, so framing is ruled out.
Eight things changed at once, the seed included.

So the takeaway is procedural: **when a shot has failed three times, change ONE
thing on the fourth.** Change four and you buy a fix you cannot reuse — which is
what happened here, and why the next shot that does this starts from scratch.
The strength sweep of 2026-09-04 kept that rule by construction: the only fields
that differed between its arms were `WanVaceToVideo.strength` and the output
prefix, verified by diffing the built graphs and again against the graphs the
ledger stored. That is what made its answer reusable (§5).

**Frame the face big enough, because an upscaler cannot invent detail that was
never sampled.** Watching the finished 4-step H3 cuts, the faces of characters
standing well back from the lens are mushy — and upscaling those shots
afterwards does not repair them. It cannot: the detail was never in the render
to begin with. Measured elsewhere in this repo, on the same point: a 4K render
"resolves individual railing balusters where 1280x704 has a suggestion of a
railing — an upscaler cannot recover that, it invents something plausible
instead."

What decides face quality is **how many pixels land on the face**, which is
framing, not output resolution. A character at the back of a 1920-wide frame
gets a face maybe 80px across whatever you render at; the same character at
mid-distance gets three or four times that from the identical settings and the
identical cost.

So: if a shot exists to show a character, put them close enough that their face
occupies real estate. Wide establishing shots are fine — just do not expect a
face to survive one, and do not schedule the emotional beat there.

⚠ This sits directly against the entry above it, and the resolution matters.
The retracted rule said push in and the model loses the plot; that turned out
to be false — the clean take had the BIGGER face. Nothing measured discourages
closer framing, and detail actively rewards it. **Bias toward closer.**

**Check the framing on the blockout, because the blockout costs four seconds and
the render costs half an hour.** A blockout writes, beside the clip, where every
figure's neck and hip land on every frame, and that table agrees with Blender's
own projector to 0.000561 px. So "is the subject on screen, and how big" is a
number before anything is spent. The four PRISM stage shots, as first authored
on 2026-09-05: the crane held the idol on screen for **42 of 121** frames and its
last frame was 80.8% venue shell; the floor rise, **33 of 121**; the push-in
ended dead centre and cut the idol off at 0.42 of its height, mid-thigh; the
orbit swept 60° when 75° was meant. Two of four shots lost their subject and
none of the four had rendered a frame of VACE. The fix is in §5.

**Name the beat.** A 5-second clip at 133 BPM is ~11 beats. "She dances" gets a
pose that drifts; "hips drop to alternate sides on every beat, repeating" gets a
loop.

**State the count of anything held or present.**
"A bone … in both hands" was read as *one bone per hand* by three different
checkpoints. Rewritten as "ONE bone — exactly one, not two — both hands gripped
around that same one bone": 4 of 4 correct on the model that had just failed.
The same applies to props already in the set: the plate had an open waffle iron,
the shot asked her to slam one shut, and the frame ended up with two.

**An object has to READ as itself, or the model adds a second one that does.**
A shot opened tight on a *closed* waffle iron. A closed waffle iron is a
featureless metal box — nothing about it says waffle iron. So the render
supplied the missing signal the only way it could: a **second** iron, standing
open behind the first, grid plates to camera, because an open clamshell is what
reads as a waffle iron. Three attempts, same doubling.

The fix is not to forbid the second one, it is to make the first one legible:
hinge at the back, handle at the front, two plates clamped and latched, steam
out of the seam. Once the object explains itself, nothing needs to be added to
explain it. Ask the same question of any object in an unusual state — closed,
folded, switched off, face down: **would a stranger know what this is?** If not,
describe it until they would.

**Props against skin need contrast.** An "off-white" bone held at the chest
blended into her décolletage. Name the value: "bright chalk white with grey
shadow", and hold it clear of the body.

---

## 2. Reference images

### What keeps a character from clip to clip (measured 2026-09-24)

Four REWIND shots were rendered at the same seeds with the same anime scene words, and only the
configuration changed. Two blind judges ranked three unlabelled versions of each.

**From words alone** (text-to-video, the 3-step build) the lead changed from clip to clip: auburn
spiky hair for dark curls, a full-face horned mask for the half-mask, a red coat lining, the wrong
back emblem. The fight did not land (the shadows stood still and dissolved). A sung line barely moved
the mouth and then opened it where nothing was sung. That configuration placed last in 7 of 8
rankings and never first.

**With Hex Appeal's setup** the lead matched his reference in all four shots, the fight read as a
fight, and the sung line followed the words: the mouth opens on "I", narrows on "miss", opens wide on
"her". The setup:
- **1–3 tight pictures** of the character, one panel each, native aspect, on a near-black card, each
  named: "<Picture 1> is Senzu. <Picture 2> is Senzu profile." Close-up: the face. Head turn: face +
  profile. Medium: the body view nearest the camera angle + face. Action: body + side + face. **Never
  four.** Black held for every scene, sunset and sea included.
- **The reference build's own count:** the ref2v 8-step build at 8 steps.
- **res_multistep** (simple scheduler, no CFG, shift 12/3).
- **The song under the clip** (`audioTrack`: frozen as the soundtrack and read by the model from frame
  0). That is lip-sync. `<Audio 1>` is a different input: the clip re-sings it in its own time.

What it did not fix: **detail**. The text takes were the sharpest pictures in the test, 2–3.5x on the
edge measure in the two wides (partly because the reference arms drew them back-lit), and where the
framing matched the two were equal.

**Comfy Kitchen attention costs nothing:** frame sharpness within 4%, the sampler about 2x faster,
37–47% off the clip. A reference clip at 1344×768 took 304–390 s for 141–175 frames on a 16 GB card,
about 2.1–2.6x a 3-step text take. Every one of those clips carried the song, so the song's own
render-time cost has never been measured alone.

**Not isolated:** the sampler (the winning arm ran res_multistep; euler had been the default since
2026-09-21 without a measurement) and the video decoder (fp16 in the winning arm; int8, measured 12%
faster on 2026-09-23, is the default). Studio now runs res_multistep on the reference path. The
decoder stays int8 until one clip compares them.

Traps from the same test:
- White trousers appeared in 4 of 12 takes because no prompt named the trousers. Name the costume
  pieces the pictures do not show.
- "No wake" asked for a wake (a negation is a request, §3). Describe the water instead.
- One clip carries one song window, so only its first slot is in sync.
- Over a vocal, a close face that is not singing can open its mouth (one of two arms did). Keep
  "mouth closed" in its words and check it.

Where it lives: the Video screen's **Keep my character** and **Song under the clip** (lip-sync on H3); new
Music video projects put the song under every scene, and the lint ticks cast named in a board's
words; make_clip `persona` / `ref_images` + `soundtrack_song`.

### What a reference picture must be

**A reference must contain the subject and NOTHING else.**
Twice a reference taught the render something nobody meant:
- a boat with its name burned into the transom → garbled text on every hull
- a character sheet with its own title down the side → a caption reading
  `KAEITH` painted into the video

No captions, no labels, no panel furniture, no lettering of any kind.

**Single panels only.** A character sheet is a contact strip. Handed over whole,
the model draws a contact strip — measured, twice. Crop one panel.

**A character reference should carry as little ENVIRONMENT as possible.**
Tested directly, and it refuted the obvious hypothesis. Two CGI sheets of the
same character, same scene, same seed:

| reference | what bled in |
|---|---|
| daylight, mountain vista | warm light, a strip of grass |
| cathedral interior | **the entire cathedral**, replacing the set |

What bleeds is not *lighting quality*, it is **identifiable environment**. A
cathedral is architecturally specific and survives wholesale; a vista is vague
and mostly does not. Crop tight to the figure, on a neutral card.

**On VACE the same rule bites harder, because a single reference leaks its whole
CONTENT.** The first pose-steered render, 2026-09-03 — a DWPose skeleton on
`control_video`, the Kaya sheet as `reference_image`, strength 1.00 — put the
sheet's **night sky behind the character as the entire set**, because the prompt
named no environment and the reference was the only picture of one in the graph.
Identity did carry: on the central band of the frame Kaya's palette scored 0.239
against six other sheets at 0.139 ± 0.039 (max 0.199), z 2.57, and the man in the
source footage scored z −1.40 on the same window. Two whole-frame measures had
already failed to answer (NCC z 0.58, palette z −0.59) because the background
dominated them — the sky, again. So on VACE: **name the environment separately
from the character in every prompt**, or the reference will name it for you.

Two traps on that path, both silent. `WanVaceToVideo` takes the **first**
reference only and **centre-crops** it to the output aspect with no warning, so a
sheet that is not 1280x704-shaped loses its edges before anyone sees it. And the
pose estimator is photo-trained: it found nobody in the anime sheet and nobody in
**43 of the 121** output frames — the closest ones — so an anime source can lend
its identity to a render but cannot lend it a skeleton. Whether a reference
changes how well the *camera* is carried has never been measured: camera mode
with a reference attached has not been run.

**A background plate is not a reference for a close-up — it double-exposes.**
Hex Appeal, 2026-09-19: the boudoir plate (candles, a cracked mirror, a cat)
rode as a named reference on H3 close-ups of a face, and came back painted
THROUGH the face — the mirror over the eye, the candles across the lips, on
three clips out of three. The set belongs in words on the board (the grade line
names the room); the plate stays declared for the storyboard and the record,
and no board references it. Taking the plates off every board fixed it in one
render each.

**The card the crop sits on is a set too.** The same night, with no plate to
say otherwise, four character crops on a light neutral card produced a
washed-white boudoir with candles floating in it: the model read the card as
the room. For a dark set, crop onto a near-black card. And an identity sheet
cannot drive a shot of an eye or a mouth alone — the extreme close-ups came
back generic until the board framed her face.

**The crop's edges are cast too.** The lead crop of the Hex Appeal sheet, a
tight face, carried the neighbouring panel's tail tip and a stranger's ringed
hand in its bottom-left corner. Forty-two scenes sent it, and H3 copied what
it saw: a red tail tip at the frame's edge in the close-ups, and two tails on
every full figure — found by the owner, not the lint, after a night of
rendering. A sheet packs its panels close, so a crop's four edges hold
pieces of the panels around it. Look at every edge before casting a crop, and
paint the strays with the card's own ground; the render cannot tell a
character's tail from the next panel's.

**Each reference does ONE job.** A background reference must contain no people;
a character reference no set. `MainRef` was a picture *of the character at the
counter* — used as a "background" it conveyed mostly her, and the set never
carried. A people-free plate fixed it in one 20-second render.

**H3 renders in the STYLE of its reference.** Hand it an anime sheet and you get
anime, whatever the prompt says. The medium is chosen by the picture, not the
words. To change medium, change the reference. That sentence is about H3, whose
reference path is built for identity. VACE's reference path took the content as
well as the style — see the night sky above — so on VACE a reference is not a
medium switch, it is a second set description.

**Props are cast — and this is the most ignored rule in the file.** Anything that
recurs and must be the *same* object — a car, a boat, a train, a banner, an
appliance, a hand prop — needs a declared entry in `props[]` and a rendered
sheet, referenced from every board it appears in.

- An undeclared car appeared in 8 of 22 scenes, was re-invented every time, and
  one frame had two of it. (This said 13 for a while — in the file's own
  self-declared most-ignored rule. The lint reports 8. An inflated number is the
  easiest thing for the next reader to check and disbelieve.)
- Across both Bone Waffle cuts, **3 and 4 boards out of 19** carry a `propRefs`
  entry. The rest name no object at all, so the waffle iron, the waffles and the
  bone were re-imagined per scene: the iron doubled in frame three takes running
  and came back as a different appliance on the fourth, and the bone changed
  colour against her skin.
- Worse, and easy to miss: the CGI cut declares a `BoneWaffle` prop **with no
  sheet** — `imageFile: null` — and three boards reference it. A declared prop
  with no rendered sheet is dropped in silence. The board looks correctly
  configured, the render gets nothing, and no warning is raised anywhere.

⚠ An earlier version of this entry claimed both cuts shipped with `propRefs: []`
on *every* board. That was false when it was written, and checkable in one API
call. Count before you write a count.

The rule was already written here when that happened, which is the point — prose
did not save it. Treat it as a startup step instead:

> **Before the first clip renders, list every object that appears in more than
> one shot, and give each one a declared prop and a sheet.** For a jingle about
> waffles that is three entries: the waffle iron, the bone-waffle itself, the
> bone. Sheets cost seconds; clips cost hours.

**Text in an image only survives if it is large, flat and high-contrast.** The
`AIPLAY` banner rendered identically across three scenes. Small hand-painted
lettering on a flag garbled to `TIFFEAY` and changed colour. Do not ask for
small text.

---

## 3. Prompt craft

**You cannot negate a description; you can only withhold or REPLACE it.**
Appending "no people" to a 1000-character description of a woman leaves the
woman in. Stop sending the description instead.

⚠ SCOPE — and the earlier version of this paragraph got both halves wrong. It
said "13 of the 19 anime clips carry a negation and rendered correctly". The
anime count is **12**; 13 is the CGI cut's number. And "rendered correctly" was
never measured: there is no quality field on a clip. What the record does show
is that **9 of 19 anime clips needed more than one take**.

It also narrowed the rule to faces and body parts, which lets through the very
clause this file calls its cleanest evidence — a waffle iron is neither. So the
honest scope is: a negation is not free, it is just not always fatal. Prefer the
positive statement every time, and when you must guard against duplication,
guard it by naming what IS in frame ("one single iron, and the counter holds
nothing else") rather than what is not.

And when there is nothing to withhold — when the model is inventing the thing
rather than reading it from a prompt — give the space something to BE. "This
kitchen has NO WINDOWS" left the windows in and merely darkened them, and grew
a bright one in the next shot. "The wall behind her is solid floor-to-ceiling
timber shelving packed with jars and copper pots" leaves no room for a window
to appear in. Describe the wall, not the absence of a hole in it.

⚠ This rule was written down and then broken within the hour, by its author,
on the very shot it was written for — and then broken a **third** time on that
same shot. The third break is the cleanest evidence in this file, because both
halves shipped in one patch and only one worked:

| appended to the same prompt | what rendered |
|---|---|
| "solid dark timber shelving packed with jars and copper pots" | shelving, jars, copper pots — every frame |
| "nothing resembling a second iron standing open behind it" | **a second iron, standing open, behind it** |

Same model, same seed, same shot. The positive clause built what it described;
the negative clause built what it described. Negation is the intuitive move;
that is exactly why it needs to be a rule.

**With a control clip on the render, the prompt's job narrows — and what the
control does not carry, the prompt decides.** VACE reads the control as literal
pixels: silhouettes, occlusion order, where mass sits, how far it moves per
frame. It carries nothing about surface, colour or light, and it carries no set
unless the blockout drew one. So the prompt's work is surface, colour, light and
the environment, stated as positively as anything else in this section. The
pose render of 2026-09-03 shows the boundary exactly: head and torso followed the
skeleton (mean joint error 33.7 px against a frozen-skeleton null of 119.9 and a
reversed one of 157.3; nose 6.8 px), and the character's **raised gloved fists
came from the prompt**, because the source footage had a wrist on 10 and 41 of
121 frames and the skeleton had nothing there to follow. Handed grey boxes and
"two figures in dark coats", the cheapest resolution the model found was dark
slabs at the boxes (§5). The rule two paragraphs up extends without changing:
describe the set, or the reference will supply one (§2), or the model will
supply the cheapest thing that fits the silhouette.

**A grade describes the BACKGROUND unless you say otherwise.** "Warm key,
everything else falling dark" was applied to the subject, and her face went to
silhouette. Name what stays lit.

**A count is not a population cap.** "Exactly one person in this frame" is right
for a woman at a piano and wrong for a festival. Crowd shots need a flag that
keeps the anti-duplication intent without capping the extras.

**Say it more than once, and put it early.** A single mention at the start of a
long description gets buried — a character described as "a man" once rendered
female in a third of his shots; restating it at both ends fixed it.

**A song caption is a prompt too, and it has a shape.** Three parts, not a tag
list; and the lyrics decide the length, not the slider. §6.

---

## 4. What things cost

**Pick the engine first, because it decides whether your references exist at
all.** This is the highest-consequence setting in a project and the file never
mentioned it. `brief.videoEngine` takes three values:

| value | what it does |
|---|---|
| `h3` | every scene on H3. Uses your reference sheets. ~10x the cost |
| `ltx` | every scene on LTX. **References are not used at all** |
| `hybrid` | H3 only where a named character appears, LTX elsewhere |

The trap is `ltx`: the code reads `useRefs = hasRefs && mode !== "ltx"`, so
choosing it silently discards every character sheet you built. You do not get a
warning, you get a stranger with the right hair colour. And the trap in
`hybrid` is the mirror image — import one character and every scene qualifies
for the expensive path, turning a twenty-minute render into an overnight one.

**Those three values are no longer the whole choice.** A fourth door opens per
*shot*, not per project: the Control card (`POST /api/mv` with action
`control_render`, or `mv_control_render` over MCP; the free catalogue is
`GET /api/mv/control`) puts a clip on WAN 2.1 VACE 1.3B's `control_video` in one
of four modes — `check`, which is free; `camera`; `pose`; `extract`. It is not a
`videoEngine` value and it does not read `useRefs`. H3 has no structural input
of any kind, so it stays for shots that need none; LTX's appearance-guide path
was measured against the same blockout and hands the grey boxes back (§5). A
storyboard can therefore be mostly H3 with one or two blocked shots on VACE, and
the cost of those two is the next table.

Measured on a 16 GB card, same 13.7 s scene at 1920×1088:

| path | time |
|---|---|
| LTX two-pass (half base, ×2 upscale) | **519 s** |
| LTX guided (full size, single pass) | 965 s |
| H3 guided at 1344×768 | 2259 s |
| H3 at 1920×1088 | **out of memory** |

**The control path is a constant, not a curve — and the two ends of it are two
orders of magnitude apart on purpose.** VACE builds exactly one size, one step
count and one frame count, so there is nothing to scale by. Measured on the
same 16 GB card, 1280x704, 121 frames, 20 steps, cfg 6, uni_pc/simple, 2026-09-03
to 05, engine clock from start to success:

| thing | time | condition |
|---|---|---|
| control check | **free** | the same ffprobe validation the render runs, stopped before a byte is staged |
| blockout, 121 frames | **3.3–4.1 s** of render, ~7 s wall | flat-grey workbench, through the route, Blender launch included; the older `mv_previz_shot` figure of 23 s included a 512 px reference panel |
| DWPose skeleton, 121 frames | 26.4 s (gate) · 12.1–15.1 s (consistency passes) · 4.1 s for 24 frames | a per-frame forward pass, not a sampler |
| VACE clip, camera mode | **31.99 min** (proof render) · 32.17 and 32.22 (two of the three consistency renders) · 32.7–32.8 (two sweep arms) | "~32 min" holds; the plan estimate carries `unmeasuredHere: true` until this install's own ledger has a run |
| VACE clip, pose mode | **33.87 min** (gate) · 35.0 (adversarial reference render) · 35.05 (through the route) | never cap it at 30; 45-minute deadlines abandoned renders that then finished, so the door's is 90 |
| song, MiniMax Music 3 | **255.8 s** running for a 180.7 s track (4.26 min) | `mcp.js` says "about 4.5 minutes" and `INSTALL.md` "about five" cold — both are claims; one track family has been measured twice, 258.8 and 258.9 s elapsed |
| chat, Qwen3-4B | 1.05 s for a short step · 12.37 s for a long one · 11.61 s for the first cold call | one card, one queue. That a chat behind a VACE pass would wait half an hour and look hung is *reasoning*, not a measured event — but the queue is measured: one consistency render sat 27 minutes behind another |
| FLUX.2 cover | 15.958 s | `mcp-engine.js` says "~3 s"; it did not hold for this cover |

Two of those rows sit behind one queue on one card, and the queue used to hide
a trap: a job's 30-minute deadline was counted from the moment it was *queued*,
so a one-minute skeleton extraction queued behind a render was recorded as a
timeout at 1800 s and wrote its files anyway. The clock now starts when the
engine starts the job (§7). The same trap is why the third consistency render's
ledger row reads **59.12 min**: it sat 27 minutes behind its predecessor, and
its own GPU time — 32.05 min — is a subtraction between two completions, not a
number the ledger holds. Read `runningSec`, not `elapsedSec`.

**The step count picks the MODEL, not a quality dial — and one band has no good
answer.** There is no on/off switch for the turbo distillation: the number of
steps selects which file loads. Measured at native size, 124 frames, same prompt
and seed:

| steps | what loads | time | result |
|---|---|---|---|
| **4** | the 4-step distillation | ~2 m 37 s | the fast path, and matched |
| 8 | the 8-step distillation | 5 m 08 s | clean but flat |
| **20** | no LoRA, the bare model | 11 m 00 s | visibly the best — face, knit and lamp all resolve |

*Scope of the 20 row (2026-09-23):* the render behind its time and its verdict
had the turbo LoRA loaded at 20 steps (`server/config.js`, the `steps` note).
The time carries over, since 20 steps cost the same on either path; "visibly
the best" belongs to that LoRA-at-20 render. The one A/B of the bare model
against a turbo build is `docs/H3_REFERENCE_BLEED.md` arm H vs C: about equal
to the ref2v 8-step, at 2.4x the time.

⚠ With REFERENCE IMAGES attached, the honest step counts are the ones a file
was distilled for. Four turbo files ship — a ref2v 4-step (v0.1), a ref2v
8-step (v1.0 768p, on disk since 2026-09-12), an fl2v 4-step and an fl2v
8-step — and the graph loads the reference build that matches the count
(`h3TurboLoraFor`). Anything between the two counts, or above 8 and below 13,
loads the nearest file and runs it past its design point; the plan flags that
as a floor. Use 4, use 8 where the 8-step reference build is on disk, or use
13+. (Before that date the reference path had no 8-step build and 8 loaded the
4-step file — which is why 8 was missing from the steps dropdown.)

And on a 5-second scene, H3 at 1920×1088:

| | time |
|---|---|
| bare model, 20 steps | **50 min** |
| 4-step turbo LoRA | **11 min** |

The 4-step is 4.5× faster and visually near-indistinguishable — same motion
(0.338 vs 0.345 mean flow), same identity. Use it.

**Know each engine's NATIVE size, and that above it is untrained territory.**

| engine | native | notes |
|---|---|---|
| H3 | **1344 x 768** | 1920x1080 is "above native, slow"; there is no H3 upscaler node in ComfyUI 0.33 |
| LTX 2.5 | 1280 x 704 | renders at half and doubles; 4K measured genuinely sharper, not smeared |
| WAN 2.1 VACE 1.3B | trained at 832 x 480; **run at exactly 1280 x 704, 24.000 fps, ≥121 frames** | that is a contract, not a preference — every number in this file was taken at 1280x704x121 and the run's own notes say they do not transfer to another size; `vaceSizeFor()` refuses everything else and says so |

Rendering BELOW native is the clearly bad move: 40% of native pixels measured
**2.7x worse**. Above native is not bad so much as unproven and expensive — for
H3 the cost curve puts 1080p near half an hour for five seconds against LTX's
three minutes. VACE is the exception that proves nothing either way: it has
only ever been run above its native size, and it passed there.

Both Bone Waffle films were rendered at 1920x1088 on H3, i.e. above its native
size, at 4 steps, ~11 minutes per 5-second scene on a 16 GB card. That works
and it shipped. What has NOT been tested is whether it beats rendering at H3's
native 1344x768 and upscaling to the same finish — same shot, same seed, two
arms, compare the faces. That is a cheap experiment and it would settle where
the base resolution should sit.

**Scene length is the lever that decides everything.** H3 cannot render a long
scene at 1080p at all; short scenes fit comfortably. And short scenes are better
anyway — 5 s suits a jingle, whereas a 12 s average cut twice as slow as the
video people preferred. On VACE the lever is welded: 121 frames at 24 fps is
5.04 s and that is the clip.

**Match the upscaler to the medium before the delivery pass.** The installed
Real-ESRGAN x2 is trained on **photographs**, and it ran over all 19 clips of
the anime cut. On flat cel-shaded art a photo-trained upscaler looks for texture
that the drawing does not have. Anime-trained Real-ESRGAN weights exist, load in
the same stock node, and are a 17 MB download — decide which one you want before
spending three hours, not after.

Two hard constraints for that pass, both measured:

- **Upscale the clips, never the finished film.** Every frame is held at output
  size at once. One 5 s clip at 2x needs ~12 GB; a 95 s film needs ~57 GB and
  cannot run. Upscale first, assemble second.
- **The ceiling is system RAM, not the GPU** — `max(4e9, totalmem * 0.55)`, so
  18.9 GB on a 32 GB box. That is what caps clip length, not the graphics card.

**Clips are ~95% of the cost.** Sheets are seconds, boards are minutes, clips
are hours. Iterate on boards freely; they are almost free. The ladder has grown
two rungs at the bottom and kept its top: blockouts are seconds, skeletons are
seconds, a control check is free, and a VACE clip is half an hour. Iterate on
the blockout until the framing table says the subject is on screen, and only
then spend the half hour.

---

## 5. Blocking and control

A storyboard has two doors onto camera movement and they are opposites, which
is worth getting right before you spend anything. *Previz* blocks the move in
Blender and hands you a grey-box clip. *Control* puts a clip on WAN 2.1 VACE's
`control_video` and the render follows it. What changed on 2026-09-03/04 is
that the blockout can now be rendered *at the control contract* and walk
through the second door — so "for your eyes only", which this repo's README
still says of previz, is no longer the whole truth, though the first toolkit
blockout has still to make the walk. The README's other sentence stands exactly
as written: feed a blockout to LTX's appearance-guide path and it hands the
grey boxes back (its calibrator arm scored CMA 0.918 with SSIM 0.914, well above
**that run's own 0.664 reconstruction bar** — 0.736 is the VACE run's, and each
gate derives its bar from its own calibrator — and every generating arm scored
CMA at or below −0.06, at motion ratios of 0.03–0.16). VACE is the door that
carries the camera. Everything here is about that door, and every number in it
was taken at 1280x704, 24 fps, 121 frames.

**What a blockout provably gives: the camera, and where things stand.** One
arm of a ten-arm gate, 2026-09-02/03, WAN 2.1 VACE 1.3B fp16, `control_video`
wired, strength 1.00, no `control_masks` — passed all five criteria:

| number | measured | bar | reads as |
|---|---|---|---|
| CMA, camera-motion agreement | **0.924** | floor 0.50; the arm's own time-shift null 0.402 | the blocked move is being carried |
| MR, motion ratio | 0.82 | inside [0.4, 2.5] | it moves about as much as the blockout |
| SSIM against the blockout | **0.524** | bar 0.736; reconstruction anchor 0.982 | **generated, not reconstructed** — the one that matters |

Three seeds: 0.916 / 0.924 / 0.942, and every cell of that table is their
**median** — per seed the SSIM was 0.661 / 0.524 / 0.519, all three under the
bar, so the verdict does not rest on the median alone. The app's own graph
builder was then posted
to the live engine on 2026-09-03 with seed 424242 and rendered to completion in
**31.99 minutes**; its output passes the clip gate back. Three conditions travel
with those numbers and are part of the record. The gate's control was a
numpy-and-OpenCV corridor with ONE walking box, not a toolkit render, and the
two-figure experiment below used the same generator with two boxes — so **no
Blender blockout has yet been SCORED through VACE**; whether the stage set's
placement reproduces the way the corridor's did is unmeasured. The first one has now made the walk, and it moved the question rather than
closing it. PRISM shot 1, `blockout_s1_stage_crane.mp4` through the control
route on 2026-09-05, run `mtodzqqp19f223`, strength 1.00, seed 20260905:
completed in **34.99 minutes** and came back 1280x704 / 24 / 121, a legal clip
in its own right. It was WATCHED, not scored — no CMA, no MR, no SSIM was
computed on it, and by this file's own standard that means it proves nothing
about agreement (see *the adversarial reference render*, below). What watching
it does support is the division of labour: the crane, the riser, the towers,
the truss and the pedestal all arrive where the blockout put them, and the
model supplied the haze, the deep blue key, the strip lights and the glow —
none of which the grey boxes contained.

⚠ **The lesson was framing, not fidelity, and it is a staging fact you can
read off the blockout before you spend.** In shots 1, 2 and 4 the figure
stands 125–148 px tall in a 704 px frame and covers 0.46–0.59% of it
(4,176 / 5,354 / 5,355 px of 901,120, measured by hide-and-diff on the
blockouts); shot 3's push-in at `framing=full` covers 3.37% and 50.1% of frame
height. At half a percent the model is not painting a performer, it is painting
a bright sliver on a column, and thirty-five minutes buys a beautiful empty
stage. Those three are architecture shots that happen to contain a person.
**Read the projected figure height off the sidecar before the render, not
after** — the number is already there, and it is the cheapest shot note in
this document. The numbers were
taken at 1280x704, off the 1.3B's trained 832x480, and
the run's own notes say they do not transfer to another size. And the mechanism
reads *pixels*: the control is VAE-encoded as it is and added into the model's
hidden state as a residual, so what crosses is silhouette, occlusion order, mass
placement and per-frame displacement — nothing about surface, colour or light.

⚠ 0.402 is the arm's OWN null — its motion agreement recomputed with its
estimated flow shifted circularly in time, the worst of 20 shifts of at least
12 frames — not a zero-strength arm. The arms that really turn the control off
scored −0.056 (strength 0.00) and −0.019 (no wire at all). "0.924 against a null
of 0.402" reads as if switching the control off still buys 0.4 of agreement; it
buys nothing. The app's own README and the code carried the wrong label for a
day and were corrected in place.

**The contract has three numbers and all three fail silently.** A control clip
must be **exactly 1280x704**, **exactly 24.000 fps** (compared as a rational, so
24000/1001 fails), and **at least 121 frames** (5.04 s). Each failure produces a
finished mp4 that is not the shot you asked for, after the render time is spent:

| wrong | what actually happens | where |
|---|---|---|
| size | bilinear resample, then **centre crop**, no warning — your framing is gone | `nodes_wan.py:319` |
| frame count | `ImageFromBatch` **clamps** to what exists, `WanVaceToVideo` **pads with flat mid-grey**, so the end of the shot conditions on nothing | `nodes_images.py:157`, `nodes_wan.py:321` |
| frame rate | nothing in the path reads fps — frames are counted and replayed at 24, so a 30 fps move is silently retimed | by construction |

`validateControlClip()` measures all three with ffprobe, counts frames rather
than trusting the container, and refuses by name and by number. A minute of GPU
was lost to a 96-frame clip once; the refusal is the feature. The render's
deadline is 90 minutes because 45-minute deadlines abandoned renders that then
finished.

**Strength is a gain on a residual, not a "how much Blender" dial.** The code
reads `x += c_skip * strength`; the model was trained at 1.0. The ladder,
all rendered on the same blockout, same seed, 2026-09-02/03:

| strength | CMA | SSIM to blockout | verdict |
|---|---|---|---|
| 0.00 | −0.056 | — | nothing (barred by construction) |
| 0.25 | 0.022 | — | nothing — the layout is lost |
| **0.50** | 0.646 | 0.235 | passes, softly (MR 0.531) |
| **1.00** | **0.924** | 0.524 | passes — shipped default |
| 2.00 | 0.662 | **0.889** | tracks the move and **hands the boxes back** |
| 4.00 | 0.376 | — | collapses (MR 0.166) |

The usable window is **0.5–1.0**. "Minimal that works" means minimal
*geometry* in the blockout, not a low number on this dial — and on the two-figure
experiment (below) neither 0.75 nor 0.50 bought anything but a darker frame.

**The spec stages; the camera stays on the move.** A blocking spec is plain
JSON: `{set, figures: [{id, at, to?, height?}], props: [{id, kind, at, size}]}`,
up to 24 figures and 64 box-or-cylinder props. `at` is where the thing STANDS,
base on the floor. **The camera is not in the spec** — it stays on `--move`,
`--take`, `--frames` — because two places naming the camera can disagree
silently. `to` is a straight path walked on a smoothstep clock, so frame 1 is
`at` and the figure eases in and out; read it as linear and you are wrong by up
to 9.62% of the path, which is 0.674 m on a 7 m walk. The sidecar's neck and hip
are 0.87 and 0.53 of the figure's *measured* rendered height. And one trap: a
spec with a `props` key **replaces the whole props group**, which is why the
PRISM stage's architecture is filed under the set and not as props.

`previz blocking --blockout [--spec f.json]` renders it at the contract in
flat-grey workbench, default 121 frames. A blockout asked for below 121 frames
is **refused before the spend**, with a sentence naming the number; a plain
previz is clamped instead. Render 3.34–4.10 s per 121-frame clip; 7.1–7.5 s wall
through the route with Blender's launch. The projected pixels in the sidecar use
per-frame intrinsics, because `push_in` ramps the lens from 28 to 58 mm: a
single-lens projection was 122.5 px wrong, the per-frame one disagrees with
Blender's own `world_to_camera_view` by 0.000561 px at worst.

**Four of the moves lose their subject on default arguments, and the fix landed
on 2026-09-05 — use it.** The vocabulary is `orbit`, `push_in`, `offset_follow`,
`crane`, `floor_rise`, `robo_arm`, `handheld`, `speed_ramp`, plus the legacy
names (`static`, `pull_out`, `orbit_left/right`, `crane_up/down`,
`dolly_left/right`, `arc_reveal`). Each is a continuous function of normalised
time with zero velocity at both ends, baked one key per frame. On the PRISM
stage, whose idol stands 2.7 m up on a holotank, the defaults aimed and climbed
as they had on a corridor floor:

| shot | default | steered with `--move-arg` |
|---|---|---|
| S1 `crane` | neck on screen **42/121**; last frame 80.8% floor, idol 0 px | `aim_at=neck rise=6.0` → **121/121**, every piece present |
| S2 `orbit` | swept 60.0° | `degrees=75` → 75.0° measured |
| S3 `push_in` | cut at 0.42 of body height, mid-thigh; riser and holotank 0 px | `framing=full` → 100% of the body |
| S4 `floor_rise` | neck on screen **33/121**; last frame 78.6% venue shell | `aim_at=neck climb=6.0` → **121/121** |

`aim_at` takes `foot/hip/centre/chest/neck/head` and re-aims every frame at that
fraction of the figure's measured height; `framing` takes `full/medium/close`
and derives the distance from the band of the world it must hold and the
sensor height read off the camera (19.8 mm at 1280x704), not from a fraction
somebody liked. A malformed pair is refused before Blender launches, an unknown
key or value comes back naming what is legal, and every default is proven
unchanged over 136 set × move pairs and four clips decoded pixel-identical. The
four PRISM invocations live in `examples/prism/shots.json`.

⚠ The app refused the stage set for a day. Five hand-typed seven-set lists
(`previz.js`, `blender.js`, `mcp-mv.js`, `chat/tools.js`, `web/mv.js`) said
`No previz set called "stage"` while the toolkit rendered it happily, and the
drift check only looked one way. The set list is now derived from the toolkit.
A hand-typed copy of a list is a count waiting to be wrong.

**The blockout is never adopted into the clips library.** It is a legal control
clip, so it needed a door, and the obvious door was wrong: `<output>/clips` is
shared with the Studio timeline, the compositor, the video lab and `/api/clips`,
and `import_clip` offers everything on that shelf as a scene's TAKE. A grey box
there is one mis-click from the finished film. So the control route resolves it
as `source: "blockout"` from *this shot's* own previz rows under the project's
assets, the same way it already resolves a reference. Two refusals guard it:
`pose` and `extract` on a blockout are refused by name, because DWPose would find
no person on grey capsules, write a skeleton of empty frames that **passes the
clip gate**, and steer the render with a blank; and a refused re-render used to
delete the good blockout before it — that is fixed, and the refusal now happens
before anything is touched.

**Run the free check first.** `mv_control_check` runs the same validation the
render runs and stops before it stages a byte; the expensive button stays
disabled until it passes. Asking is never the expensive option. This is the
same rule as "lint before rendering" in §7 with the cost made visible.

### The performer

**A grey-box figure renders as a dark slab, at every strength in the window.**
Three renders on 2026-09-03 of a two-figure blockout — one figure standing, one
walking the centreline at 1.2 m/s, prompt "two figures in dark coats, one
standing and one walking away", strength 1.00, two cameras, two seeds — put
something dark at both figures' projected positions on every frame and nothing
that reads as a person. DWPose, which finds a person on 121 of 121 frames of
real footage on this machine, found: 1 of 121 (a false positive the size of the
corridor), 0 of 121, 0 of 121. The strength sweep of 2026-09-04, camera 1, same
seed, only `strength` changed:

| strength | people found, of 121 | figure A stands out by | figure B stands out by | whole-frame luma |
|---|---|---|---|---|
| **1.00** | 1 (the false positive above) | 13.9 grey levels | 13.9 | 45.3 |
| 0.75 | 0 | 9.7 | **15.6** | 25.0 |
| 0.50 | 0 | 4.2 | 7.1 | 17.4 |

Darker, and no more human at any rung. Figure B's column is in the table because
it is the one number that does not fall: the walking figure localises *better* at
0.75 than at 1.00, and it still contains nobody, which is the point — the dial
moves contrast around and never buys a person. The third arm (camera 2 at the
better strength) was not run because there was no better strength.
**Strength is the wrong knob.** A grey capsule is not an actor rig for VACE
anywhere in the window this file endorses.

Two consequences, one creative and one procedural. The PRISM hologram idol is a
dark volumetric silhouette **by design**, because a silhouette is what this path
delivers with certainty and the shot was written to want one; "on-concept as a
silhouette" is a director's judgement, not a number, and the file should not
pretend otherwise. And **a recognisable person needs the pose path**: a real
clip → DWPose skeleton → `control_video`, with a single-panel sheet as
`reference_image`. That path is proven for the **upper body** only — one render,
one seed, one source, one reference, 2026-09-03: mean joint error 33.7 px over
803 joint pairs on the 78 frames the estimator could score, per-joint
correlation 0.893 mean and 0.962 median, nose within 6.8 px; against nulls of
119.9 px (frozen skeleton) and 157.3 px (reversed). It is NOT proven for legs
(the source had none in frame), for hands (left wrist 149.9 px — the fists came
from the prompt), for the closest frames (43 of 121 unscored), or at any
strength but 1.00. A second reference render of 35.0 minutes completed and was
never scored, which means it proved nothing.

**A spec gives placement, not choreography.** The sidecar states neck and hip
per frame — position, scale and axis — because that is what a projection of a
capsule can state. A skeleton synthesised from it would carry those two joints
and no limbs. So the honest division is: the blockout for where the performer
is and how the camera finds them; the pose path, from footage of a real
performer, for what they do; and the sheet for who they are. No shot has yet
combined all three, and the combination is the next thing to measure, not a
thing to assume.

### Consistency across clips

**One Blender scene gives geometry across cameras. It has not yet given a
character.** The 2026-09-03 experiment staged two figures once and rendered them
from two cameras (an orbit that tips over into plan; a locked-off three-quarter
at eye height) and from two seeds. Two of the three ledger rows read 32.17 and
32.22 minutes; the third reads 59.12 because it counted 27 minutes of queue, and
its GPU time of 32.05 is a subtraction between completions (§4). The ground truth
is analytic: the toolkit's projected neck and hip per frame, re-derived
independently to 0.000 px. What could be measured, since no person was ever
detected, was detector-free — how much darker the frame is inside each figure's
projected box than in a ring around it:

| clip | actor A, real | actor B, real | nulls (frozen frame 0 / other camera's boxes) |
|---|---|---|---|
| cam 1, seed 70117 | +13.9 | +13.9 | −2.8 / −4.2 · −9.6 / −1.0 |
| cam 1, seed 31337 | +12.4 | +14.0 | +1.1 / +0.1 · −10.2 / +1.3 |
| cam 2, seed 70117 | +26.6 | +28.6 | (degenerate) / +0.3 · +4.3 / −0.6 |

Grey levels. The adversarial audit that re-derived every number then narrowed
the reading, and its narrowing is the record: counted frame by frame, the
walking figure beats both nulls on 74–108 of 111–121 frames on every clip, and
the standing figure wins 84 of 84 frames on the locked-off camera — against the
cross-camera null, which is the only one that is not degenerate there — but the
standing figure on the *orbit* camera is at or below chance (37 of 84 frames
against both nulls on one seed; 50 of 84 against the frozen null on the other).
The contrast peak sits 20–57 px from the projection, with a resolution of about
one box width. So the honest scope is:
**the blocking transferred as geometry, at tens of pixels, for the walking
figure on both cameras and for the standing one only on the static camera; and
nothing transferred as a person.** The measure cannot tell "VACE reproduced the
boxes" from "VACE put dark objects where the boxes were", because the control's
own boxes have the same contrast.

**The cross-camera null must fail, or the metric is not seeing the camera.**
That is the discipline every number above obeys: a render scored against the
*other* camera's projection has to come out near zero, and it did in all six
cells (−4.2 to +1.3). The frozen-frame null is the one with a degenerate cell:
a standing figure on a camera that does not move is in the same place in frame
0 as in every other, so that null cannot fail there and is marked, not
counted. Two more nulls — the boxes shifted 200 px,
and the frames shuffled in time — also failed cleanly. Where a pose-based number
could not be computed it is reported EMPTY, not substituted: a cell that says NaN
is telling you the detector saw nobody, which is a finding. One trap for
whoever reads the files: an all-empty 121-frame DWPose dump is byte-identical
whatever produced it, so three keypoint JSONs share one hash. Trust the ledger's
stored graph for which render a skeleton came from, not the skeleton.

**Identity across shots is unmeasured.** Not "measured and failed" — unmeasured,
because there was no character to measure. The seven character sheets used as
foils are a different visual world from a dark corridor (palette similarity
0.000–0.116), so any z-score against them is an artefact: a same-shaped patch of
empty corridor 320 px to the right scored 0.70 against figure A's own
cross-camera palette of 0.55. No performer has ever been carried across two
clips in this stack. The pose render carried one sheet, once, in one clip.

**A single reference leaks its whole content.** §2 has the night sky. It means
the environment must be named in the prompt of every clip separately from the
character, or each clip inherits the reference's set and the clips agree with
the sheet rather than with each other.

**Seeds fix noise, not content.** Two seeds on the same camera, control and
prompt differ by 16.2 grey levels per pixel whole-frame, 3.5× the clip's own
frame-to-frame change; inside the figures' boxes 2.3× and 3.9×. Placement is
seed-stable; pixels are not. Identity has to be pinned by a reference, never by
a seed — and re-rolling a control render buys a different slab in the same
place.

⚠ One render defect is unexplained and stays on the record. The camera-2 render
blacks out the left third of every frame: column luma 7.9 / 53.6 / 45.1 against
an evenly lit control at 116.3 / 117.5 / 116.2, 35.6% of pixels below 16, a hard
step of 32.6 grey levels at the boundary of column bin 10 of 32 — column 440,
give or take the 40 px the bin is wide. It is why that file is 244,662 bytes
against 1,280,760 for its camera-1 sibling, and why camera 2's larger contrast
numbers above are not directly comparable. No camera-2 render exists at another
strength or seed to say whether it recurs.

> **What Higgsfield's Blender plugin does, and does not, claim.** The add-on is
> real and generally available — a `.zip` for Blender 4.2–5.1, cloud inference
> on their credits, announced 2026-08-20 to 25. Its Scene Builder makes an
> editable blockout in the open `.blend`; its Video step is Seedance 2.5 "fed
> straight from your viewport", about a minute per generation, up to 30 s at
> 480p to 1080p, up to 50 reference images per generation. The blockout has been
> wired to the render since launch. That is a shorter clip time, more references
> and a longer clip than anything in this file, and it should be said plainly.
>
> What leaves Blender for their model is undocumented — no page names a depth
> pass, a camera track, a playblast or any export format, and the add-on was not
> inspected. Neither Blender page makes any cross-clip consistency claim; their
> own July 2026 blog says consistency "doesn't automatically carry into the next
> one" and recommends feeding a frame back as a reference, and their identity
> product's stated ceiling is "clearly the same person". No demonstration of two
> shots of one scene with matching layout was found. Nothing was measured: these
> are claims verified as claims, on 2026-09-02. What this stack has that theirs
> does not describe is a measured gate, an analytic camera track and a ledger.

---

## 6. The song

**The song under the clip is the lip-sync door on H3** (§2, 2026-09-24): frozen under the render
and read by the model from frame 0, so a singing mouth follows the words. A sound reference
(`<Audio 1>`) re-sings instead, in the clip's own time.

**MiniMax Music 3 is the only thing in the stack that sings.** The DAW is
instrumental — its synths render and its choir row refuses to — and the two TTS
voices speak and never sing. So a song with a vocal is `POST /api/generate` on
the music model, and nothing else will do it.

**The caption has three parts, and a tag list works much worse.** *Global
Metadata* — BPM, key, genre, how the feeling moves, production style. *Vocal
Details* — who sings and how, or say plainly that it is instrumental.
*Arrangement* — main and secondary instruments, the groove, how much space. The
lyrics carry `[Verse]`, `[Chorus]`, `[Bridge]` on their own lines.

**Output length tracks lyric length, not the slider.** Short lyrics made 21–29 s
songs; a moderate lyric made 129 s; the seconds setting is a ceiling. The PRISM
track came out at 180.7 s from its lyric. If you want a longer
song, write more verses.

**A mix re-roll costs about 60%.** The text encode is roughly 40% of the render
and is cached, so changing only the arrangement re-spends the rest; an identical
request is a 0.3 s cache hit. Measured: 255.8 s of GPU for the 180.7 s PRISM
track — that is `runningSec` on run `mtnkhkup320f67`, whose `elapsedSec` was
258.8; the other completed take ran 258.9 s elapsed, a tenth of a second apart.
The finished file is
−13.0 LUFS integrated, 4.3 LU of range, true peak +0.3 dBFS — over full scale,
so leave headroom in the master rather than trusting the model's.

⚠ The ledger holds **two** completed PRISM song renders (`aiplay_00083.flac`
and `aiplay_00084.flac`, 258.9 s and 258.8 s), while the working notes say the
first take was killed by an app restart. Reconcile before quoting "one take".
The notes also attribute the second take's run id to the song; it belongs to
the **cover** (FLUX.2, 15.958 s). Read the ledger, not the memory.

**The rights line, in three clauses that do not speak for each other.** The
music model's licence has **no territory clause**; its outputs are yours with
conditions (show "MiniMax-Music3" in the product, written authorisation above
USD 20M a year), sellable, and carries no territory clause at all. **H3 is the video
model and it is the one that is region-blocked** — the excluded territories are
the catalogue's to state, and the Models page prints them from it; the ban
extends to its outputs, and the download refuses without an acknowledgement.
WAN 2.1 VACE's weights are verified Apache-2.0 with no territory clause, but the
files on disk are a repackage that ships no LICENSE file, so that chain rests
on the repackager's declaration; and the DWPose estimator's licence is
**unread** (a 28-byte model card), which is the half of the pose path that can
bite legally. A song is the safest thing this stack makes; a pose clip is the
least settled.

---

## 7. Process

**Review as a SET, not one at a time.** Six boards painted the lead twice and
nobody saw it, because each was looked at alone as it was made. Side by side it
takes a second.

**Count limbs, not just fingers.** A render was called "clean hands" after
checking finger counts; it had three arms, one with its own cuff.

**The flow gate measures MOTION, not quality.** It cannot see a doubled subject
or a wrong set. Read it beside the picture, never instead of it. (It used to
miss a small mover in a big static frame too — a car receding to a dot read as
100% still. That one is fixed: the gate reads flow twice now and calls a frame
still only when both the mean and the 99th-percentile peak are low.)

The control gate is the same kind of instrument. CMA, MR and SSIM measure
camera agreement and generated-versus-reconstructed; they do not measure quality
and they cannot see identity. A pose score of EMPTY means the detector found
nobody, which on a grey box is expected and on a finished render of a person is
the headline. And every cell needs its null beside it: the cross-camera null
must fail, or the number is not seeing the camera (§5).

**Fix at the source — but know which chain your engine actually uses.** Fixing a
prop description and re-rolling only the clip changes nothing; go back to the
sheet. Where the older advice was wrong is the middle link:

| engine | chain |
|---|---|
| LTX | sheet → **board** → clip (the board is pinned as frame 0) |
| H3 with cast refs | sheet → clip (**the board never reaches the render**) |
| VACE, camera mode | spec → **blockout** → `control_video` → clip, with an optional sheet as `reference_image` (the board never reaches this render either; the blockout does) |
| VACE, pose mode | footage → **DWPose skeleton** → `control_video` → clip, sheet as `reference_image` |

On H3 the board image is passed only when `brief.boardRef === true`, and it
defaults to false. Both Bone Waffle cuts ran H3 with cast references, so every
storyboard in them was a human preview and nothing more. Re-rolling a board to
fix an H3 clip changes nothing at all. On VACE the equivalent mistake is fixing
the framing in the prompt: the framing is in the blockout, so re-block, re-check
the sidecar, then render.

**Every finished film is graded on the way out.** `render_video` always applies
`eq=contrast=1.09:saturation=1.15:gamma=1.015` — a little more contrast, a
little more colour. The renderer has a `--nograde` flag, but nothing in the app
passes it, so there is no way to turn it off from the tool. Judge a clip knowing
the delivered film will be slightly punchier than the clip you are looking at,
and do not grade a second time on top.

**Read what the analysis actually found before designing an edit around the
music.** Both Bone Waffle cuts carry `lyricLines: 0` and a flat grid of
5-second scenes. So nothing in either film was cut to the song: the 5 s scene
length was the DEFAULT, not a decision, and every cut lands on a metronome
rather than on the track.

What *was* music-driven is the zoom pulse, which reads the bass envelope and is
gated on beat confidence (0.491 here, against a 0.40 floor). That is worth
knowing precisely, because "we edited it to the music" was true of the pulse and
false of the cuts, and nobody noticed for two films. If you want cuts on the
song, time the lyrics first and check `lyricLines` is not zero before you build
the scene list.

**Lint before rendering, and act on it.** The mirror lint correctly predicted a
scene's failure and was ignored; the scene failed exactly as described. A
warning nobody acts on is worse than no warning.

**Plan, approve, run — and a tool that spends is never called in the turn it is
proposed.** The loop stops, shows the exact arguments and what they cost, and
waits; when you say yes it runs *those* arguments with no second model call, so
nothing can change between the plan and the approval. The chat obeys the same
gate: its written tools are marked *spends* or free, a proposal followed by "yes"
reached a job id in 0.54 s on 2026-09-05, and the rule earned its keep the same
day. The 4-billion-parameter model emitted argument names with **leading
spaces** — `" lyrics"`, `" instrumental"` — byte-for-byte the same on two runs,
so the tool read `undefined` for both and a *confirmed* song rendered with no
lyrics, not instrumental, titled "Global Metadata" from the caption's first
words. The approval showed the right arguments; the call sent the wrong keys.
Names are now trimmed, unknown names refused and required ones required, and
the identical model output yields "Rain Falls, Rain Falls". Approve the
arguments *as the tool will read them*, and read back what ran.

**A cost you cannot derive has to be declared, and the convenient derivation is
usually wrong in the expensive direction.** Letting that chat reach the studio's
other 233 tools needed one fact per tool — does this spend? — and not one of the
241 carries it. The obvious shortcut is to read each tool's own source for a
mutating call, and it was tried on 2026-09-07: 206 of 241 came back "read-only",
including `avatar_import`, which imports. The helper it writes through is one
call deeper than the pattern could see. A classifier that says a render is free
does not degrade the feature, it removes the consent gate, so the costs are typed
out by hand and a tool nobody listed is unreachable — absence is refusal, never
permission. The test that guards this runs the discredited derivation and asserts
it *still* gets `avatar_import` wrong, so the day the shortcut becomes sound is a
red lane and not a rumour.

**And never volunteer a destructive tool to someone who did not ask to destroy
anything.** The first working router answered "what songs do i have?" with
`daw_remove_track` in the list, and put `image_trash` *above* `image_upscale` for
"upscale that picture and remove its background", because "remove" and "trash"
are the same word to a matcher. The confirm card would have caught both, and that
is not a defence: a person asked to approve destruction they never mentioned is
being trained to stop reading the card. Removal words are now required before a
removal tool is even a candidate. Consent survives on the assumption that being
asked means something, and every needless ask spends that down.

**Every render goes through one door, and the door refuses what it cannot
attribute.** On 2026-09-02 the output folder held 426 files written since the
previous noon and **424 had no ledger entry**; 245 of them came from harnesses
posting straight at the engine's port, which two Studios on one machine shared
along with one output folder. The engine port is now picked fresh at every
start and never published; every render writes the graph, the prompts verbatim,
the seed, steps, size, every model file and every reference's SHA-256 to the
ledger **before** the GPU spends, and a failed render is recorded too. A
request without an actor (`x-aiplay-actor: script:<name>` or `agent:<name>`, or
a browser's Origin) is refused. The refusal is the feature: a render you cannot
attribute is a file you cannot explain, and 424 of those is how this section
came to exist.

Three traps at the door, all found by the blocking work and all fixed — they
are here because each looked like something else:

- **A long render behind a single HTTP request dies at five minutes and the GPU
  does not.** Node abandons a response whose headers have not arrived in 300 s,
  so a 32-minute pass reported "start AIPLAY Studio first" at 306.0 s while the
  render kept going and finished. Long renders poll now. If a dispatcher says
  the engine is down at exactly five minutes, the engine is not down.
- **The deadline used to start at queueing.** A one-minute skeleton extraction
  queued behind a render was recorded as `timeout` at 1800.456 s, having queued
  for 3.685 s, and wrote its files anyway. The clock now starts when the engine
  starts the job.
- **One press of Stop destroyed a queued turn.** Cancel was engine-wide, so
  stopping a song took the chat turn queued behind it with it — no output, no
  history, recorded as *vanished*. Cancel is now per prompt and has its own
  status.

**Read the change back before believing you made it.** Scene 19 was "fixed"
three times without its framing ever changing: a throwaway patch script set
`shotType` at the top level of its object while the helper only spread the
nested `shot` key. The field was dropped in silence, every call returned 200 ok,
and each attempt looked like evidence that the wording needed another pass —
when the design had never been touched. Three clips and half an hour of GPU,
spent proving nothing.

The live version of this hazard is in the API itself, and it bites the opposite
way: `set_board` REPLACES rather than merges. It rebuilds the record from the
payload alone, so any array you omit — `characterRefs`, `propRefs`, `shots` —
comes back as `[]` rather than keeping what was there. Send a complete board,
then read it back and assert on the field you meant to change.

**Re-rolling fixes noise. Rewriting fixes design.** Re-rolling 14 bad clips fixed
6. The other 8 failed identically twice, because each was asking for something
no seed provides. On the control path the same sentence reads: re-rolling moves
the pixels and leaves the slab where it was (§5); re-blocking moves the slab.
