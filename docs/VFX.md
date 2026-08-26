# The VFX tab

An After Effects–class compositor that lives inside Studio. Everything it can
do is reachable three ways — the tab, the REST API, and MCP — because they are
the same routes underneath. There is no capability that only the UI has.

`VFX_SPEC.md` is the builder's contract: schemas, file ownership, the engine
CLI. This is the other document — how to actually get something on screen.

---

## The shape of it

A **comp** is a document: a size, a duration, a frame rate, and a stack of
**layers**. Layers are painted bottom-up, so index 0 is the front.

Every layer has a transform (anchor, position, scale, rotation, opacity), and
may carry effects, masks, a track matte, and a parent. Any numeric property is
**animatable**: give it keyframes instead of a number and it moves.

Eleven kinds of layer:

| kind | what it is |
|---|---|
| `image` / `video` | a still or clip from the library, by **name** — never a path |
| `solid` | a flat rectangle of colour, with its own width and height |
| `text` | type, optionally animated per character |
| `shape` | vector geometry — see below, it is the deepest of them |
| `adjustment` | applies its effects to everything beneath it |
| `null` | renders nothing; a handle to parent other layers to |
| `camera` | a viewpoint. Only `threeD` layers respond to it |
| `light` | a light source. Paints nothing itself; it shades every `threeD` layer. See **Lights and materials** |
| `comp` | another comp, nested as a layer |
| `audio` | a sound-only source — a song from the music library, or a clip used for its sound. Paints nothing; movie renders mix it in. See **Sound** |

---

## Animating anything

A property is either a constant or a curve:

```jsonc
{ "keys": [
    { "t": 0.0, "v": [0, 540],   "ease": "easeOut" },
    { "t": 1.2, "v": [960, 540], "ease": "easeInOut" },
    { "t": 3.0, "v": [1920, 540] } ] }
```

`ease` describes the segment **leaving** that key: `linear` (the default),
`hold`, `easeIn`, `easeOut`, `easeInOut`, or explicit bezier control points.

Properties are named by path — `transform.position`, `transform.opacity` (or
just `opacity`), `effects.<fxId>.<param>`, `masks.<maskId>.feather`,
`timeRemap`, `audioLevels`, `rotationX/Y/Z`, `shapes.<i>.<param>` (a group
descends as `shapes.<i>.items.<j>.<param>`), `light.<param>` on a light layer
and `material.<param>` on a 3D pixel layer.

You never have to guess a path: `layer_properties` (`vfx_layer_properties`)
enumerates **every animatable property on a layer, keyed or not** — the exact
spelling `set_prop` accepts, its label, its group (Transform / Time / Audio /
Light / Material / Effects / Masks / Shape), its arity, its value at t=0,
whether it is keyed, any expression on it, and the range and options the
registries advertise for effect, shape and light parameters. It is the same
function the timeline's property tree draws from, so what the UI can show and
what an agent can name are one list by construction. Call it before animating
something you did not put there yourself — a guessed range is accepted and
renders wrong.

`timeRemap` is the one property with a **clear**: `set_prop` with
`value: null` deletes the curve and the layer plays straight — absence is its
off state. A **bare constant** remap is refused rather than stored, because
the engine only honours a keyed curve or an expression
(`interp.has_time_remap`); a constant would be kept, returned, and rendered
by nothing. A freeze-frame is one `hold` key
(`keys: [{ t: <layer start>, v: <source second>, ease: "hold" }]`), and
removing the last keyframe deletes the field rather than leaving a dead
constant behind.

### Expressions

Any property also takes an expression, which **layers over** it rather than
replacing it — whatever is underneath stays, and the expression reads it as
`value`. It is **written** through `set_prop` / `vfx_set_property` with
`expr` as a sibling field beside `value` or `keys`:

```jsonc
// the call
{ "action": "set_prop", "slug": "opening-titles", "layerId": "ly_7f3a",
  "path": "transform.position", "expr": "wiggle(2, 30)" }
```

What the document then **stores** — and what `get_comp` answers — is the
wrapper below. Do not post the wrapper as the `value`: an object is not a
value, and that call is refused.

```jsonc
// what is stored
{ "expr": "wiggle(2, 30)", "value": [960, 540] }
```

`value`, `time`, `wiggle(freq, amp)`, `random()`, `linear(t,a,b,c,d)`,
`ease(t,a,b,c,d)`, `loopIn()`, `loopOut()`, `valueAtTime(t)`, `velocity()`,
and links to other layers' properties by path. Clearing the expression
(`expr: null`, or an empty string) gives back exactly what was underneath.
Every `wiggle()` and `random()` in the comp derives from the comp's `seed`
(`set_comp`) — change it to re-roll all of them at once, each still
reproducible, which is why the same frame rendered twice is identical pixels.

It is a sandbox, not Python — imports, attribute access and dunder names are
refused. An expression that fails at render time leaves the property at its
underlying value and the frame still renders, so **if a render looks
un-expressed, suspect the expression before the wiring.**

### Expression Controls

Effects that render **nothing** — the whole family costs zero pixel work — and
exist purely to be keyframed and read. One slider can drive ten properties;
retime the slider and all ten follow.

| effect | param | reads as |
|---|---|---|
| `sliderControl` | `value` | a number, ±1,000,000 |
| `pointControl` | `point` | `[x, y]` |
| `point3DControl` | `point` | `[x, y, z]` |
| `angleControl` | `angle` | degrees, **not** wrapped — 1080 stays three turns |
| `checkboxControl` | `checkbox` | 1 or 0 (it interpolates between keys; use `"ease": "hold"` to snap) |
| `colorControl` | `color` | `[r, g, b, a]`, each 0–255 like every other colour |

An expression reaches a control **by the effect's id** — effects here have no
user-facing name, so the `effectId` that `add_effect` answers with is the
handle. The effect's *type* also resolves when the layer carries only one of
that type, and a 1-based stack index always works:

```
thisComp.layer("driver").effect("fx_3")("value")      by id, from anywhere
thisLayer.effect("fx_3")("value")                      on the control's own layer
thisComp.layer("driver").effect("sliderControl")("value")   by type, if unique
thisComp.layer("driver").effect(1)("value")            first in the stack
```

Two of the same control on one layer therefore **must** be addressed by id or
index — by type silently reads the first one.

**Worked example — one slider drives two layers.** Put a slider on a null,
keyframe it once, and point both layers at it:

```jsonc
// 1. the control: add_effect { layerId: "driver", type: "sliderControl" }
//    → answers { effectId: "fx_3" }
// 2. keyframe it: set_prop { layerId: "driver", path: "effects.fx_3.value",
//    keys: [ { "t": 0, "v": 0 }, { "t": 2, "v": 300 } ] }
// 3. read it from both layers:
//    title  position  { "expr": "[40 + thisComp.layer(\"driver\").effect(\"fx_3\")(\"value\"), 540]" }
//    badge  rotation  { "expr": "thisComp.layer(\"driver\").effect(\"fx_3\")(\"value\") / 2" }
```

Scrub once and both move together; re-ease the two keyframes on the slider and
the title's slide and the badge's turn re-ease as one.

There is deliberately **no `dropdownControl`**: the effect catalog describes
one option list per effect *type*, so every instance of a menu would carry the
same fixed entries — useless as a control. A `sliderControl` holding an
integer does the honest version of that job.

---

## Shape layers

The deepest corner, and the one with a trap in it. A shape layer holds a list
of items drawn **in order**:

1. **paths** — `rect`, `ellipse`, `polystar`, `path`
2. **operations** — `trim`, `repeater`, `offsetPath`, `roundCorners`,
   `zigzag`, `wiggle`, `merge`
3. **paint** — `fill`, `stroke`, `gradientFill`, `gradientStroke`

**Order matters and fails quietly.** A stroke listed before a trim consumes
the path, and the trim then has nothing left to shorten — it renders, it just
ignores the trim. Path, then operation, then paint.

```jsonc
"shapes": [
  { "type": "ellipse", "size": [160, 160], "position": [0, 0] },
  { "type": "trim", "start": 0, "end": { "keys": [{"t":0,"v":0},{"t":2,"v":100}] } },
  { "type": "stroke", "color": [1, 0, 0], "width": 12 }
]
```

That is the write-on: a ring that draws itself over two seconds.

Sixteen item types, 78 parameters, 55 of them animatable — `vfx_shape_catalog`
lists all of it with ranges and descriptions. Keyframe one by naming it:
`shapes.1.end` is the trim above, and a group descends as
`shapes.<i>.items.<j>.<param>`. Three ready-made layers
(`lineDraw`, `progressRing`, `burst`) come from `vfx_shape_preset`, and reading
what they produce is the fastest way to learn the grammar.

---

## 3D and cameras

`threeD: true` opts a layer in; a 2D layer is untouched by every camera in the
comp. Then `anchor`, `position` and `scale` each take an optional third
component, and `rotationX/Y/Z` turn it. Rotations compose Rx·Ry·Rz.

A `camera` layer carries `zoom` (focal length in pixels), and with
`depthOfField` on, `aperture` and `focusDistance` begin to matter. **The
topmost camera in the comp is the one that renders.**

### Workspace views

Any frame can be rendered through a **workspace view** instead of the comp's
own camera — the way to see where 3D layers, cameras and lights actually sit
in space: `?view=front|back|top|bottom|left|right|orbit` on the frame route,
and the same `view` on `vfx_preview_frame`, `vfx_probe_pixel` and
`vfx_view_overlay`. `orbit` takes `yaw` (default 30) and `pitch` (default
−25); every view takes `distance` (default the camera home, width·50/36 px)
and a view zoom — spelled `vzoom` in the query string — that defaults to the
distance, which renders the comp plane 1:1. Only 3D layers change: a 2D layer
holds its comp position in every view, as in AE. The view rides the frame
cache key, so a Top frame can never come back as last week's Front frame.

---

## Lights and materials

A light is a **layer**, for the same reasons a camera is one: it wants a
position that keyframes, a parent it can be rigged to, and a time window. Its
spec lives under `light`, the way a camera's lives under `camera`:

```jsonc
{ "type": "light", "name": "key",
  "transform": { "position": [960, 300, -700] },
  "light": { "kind": "point",              // ambient | point | spot | parallel
             "color": [255, 244, 214], "intensity": 100,
             "falloff": "none",            // none | smooth | inverseSquare
             "radius": 500, "falloffDistance": 500,
             "castsShadows": false } }
```

**Lights only touch layers with `threeD: true`.** A 2D layer, an adjustment
layer and the comp background are untouched — there is no surface there to
have a normal. Every lit layer is a flat plane (no bump or normal maps), and
shading is two-sided: a layer turned 180° stays lit rather than going black,
which is AE's rule too.

**The z trap.** A light added through the API lands at the comp centre pulled
back to the default camera's home (z = −width·50/36 — −2667 on a 1920 comp),
so it lights an untouched 3D layer without anyone typing a z. A light you
place by hand with a two-component position sits at **z = 0 — the exact plane
every untouched 3D layer sits in** — and at grazing incidence it lights
nothing, which reads as a broken feature. Give it a z.

Each kind reads its own parameters, and **a parameter the current kind does
not read is refused rather than stored dead** — `coneAngle` on a point light
is an error naming the fix (`set_layer { light: { kind } }` first):

| kind | what it reads beyond `color` + `intensity` |
|---|---|
| `ambient` | nothing — no position, no falloff, no shadow. The only thing that lifts the side no other light reaches |
| `point` | `radius`, `falloffDistance`, shadows |
| `spot` | those plus `pointOfInterest` (the aim, [x,y,z] comp px), `coneAngle` (the FULL angle, 0–180) and `coneFeather` (eats inward, so the edge lands where the angle says) |
| `parallel` | `pointOfInterest` (direction only — the sun) and shadows; falloff is ignored by definition |

`intensity` is percent and **negative subtracts light** — AE's hand-placed
shadow. The numeric parameters keyframe like anything else (`set_prop`, path
`light.<param>`); `kind`, `falloff` and `castsShadows` are switches, set
through `set_layer { light: {...} }`, merged per key so keyframes survive.

**Materials** are the other half — what a 3D pixel layer does with the light
that reaches it, AE's material options with AE's defaults: `ambient` 100,
`diffuse` 50, `specular` 50, `shininess` 5 (mapped linearly to a Blinn-Phong
exponent of 2–128). `diffuse: 50` is why one point light at 100 does **not**
make a white layer white — half the surface answers to directional light and
the other half is waiting for an ambient. The numeric four keyframe (path
`material.<param>`); `acceptsLights`, `castsShadows` and `acceptsShadows` are
switches (`set_layer { material: {...} }`, `null` clears back to defaults).
`acceptsLights: false` is bit-exact: the layer comes back untouched, so a
title card can sit in a lit scene at its authored brightness. `material.*` is
refused on kinds with no surface to shade — light, camera, null, audio — and
on a 2D layer until `threeD` is on.

**Shadows are plane-onto-plane, and real within that.** A caster's alpha is
projected onto the receiver as an exact homography — shape, position,
perspective stretch, translucency, several casters compounding, all computed,
not faked. What is not real: nothing casts onto the comp background, a 2D
layer, or itself; `shadowDiffusion` is a uniform blur, a look control spelled
like a physical one (a true penumbra widens with distance); a red translucent
caster throws a grey shadow, as in AE. Shadows are off by default (each one
costs a projective warp per light), capped at 8 casters and 16 lights, and
**draft skips shadows entirely**.

`GET /api/vfx/lights` serves lights.py's own catalog — labels, ranges,
defaults, per-kind limits — the same table the UI's Light section reads, so
neither can drift from what the shader computes. `layer_properties` lists the
Light group on a light layer (only the params its current kind reads) and the
Material group on a 3D pixel layer.

---

## Auto-orient

`autoOrient: "alongPath"` on a layer (a switch like `threeD` — **not
animatable**, exactly as in AE) turns it to face along its position track's
motion. The compose rule is AE's: **the path sets the heading and the layer's
own rotation is an offset added on top** — a fish PNG drawn facing right needs
`rotation: 0`, one drawn facing up needs `rotation: 90`. Moving along +x is
upright at 0°; moving straight down is +90° (y points down and rotation is
clockwise, the convention everything else here already turns in).

The heading is the derivative of the **actual interpolated path** — bezier
spatial tangents, roving keys and expressions on position all steer it, not the
straight lines between keys. Through a hold segment (zero motion between
jumps) the layer keeps the orientation of its last motion, and the jump
instant itself turns along the jump; before the first key it already faces the
way it is about to leave. A position that never moves orients nothing — the
switch alone changes no pixel, and `"off"` (or absence) renders byte-identical
to before the switch existed.

In 3D the layer's local +x follows the 3D tangent, with roll fixed against the
comp plane's normal — so planar 3D motion matches the 2D result exactly, and a
path diving along z turns the layer edge-on. A parented layer orients along
its motion **in its parent's space**, and an auto-orienting parent carries its
children around the turn, both AE's behaviour.

**There is no `"towardCamera"`** — set_layer refuses it with the reason: layer
matrices are needed before a frame has picked its camera (a camera's own
parent chain, the light rig), and a billboard under a rotated parent needs
that parent's rotation inverted back out, so a faithful implementation is not
cheap and a wrong orientation rendered silently would be worse than the
refusal. Aim with `rotationX/Y/Z` instead. Camera, light and audio layers
refuse the switch entirely (a camera aims with `pointOfInterest`, an audio
layer paints nothing).

---

## Nesting

A `comp` layer points at another comp by slug in its `src`. The child renders
first and the result becomes the layer's pixels, so effects, masks, mattes,
blending, 3D and motion blur all apply to it exactly as they would to a video.

`collapse: true` is continuous rasterisation: the child is rendered at the
resolution the layer's transform will actually display it at, so a precomp
blown up 300% stays sharp instead of showing the 100% raster's pixels.

A comp that reaches itself is refused **by name, with the path that closed the
loop**, and nesting deeper than eight levels is refused too — so a bad document
fails on frame one instead of eating the machine.

`precompose` builds the nest for you: the selected layers move — verbatim, in
their stacking order — into a new comp sized and timed like the parent, and
one comp layer replaces them at the topmost index they held, AE's placement
under AE's default name ("Pre-comp N", next free N). Only AE's *move all
attributes* exists; `leaveAttributes` is refused with the reason rather than
half-implemented. The boundary casualties are AE's too, and they come back as
`warnings` instead of happening silently: a parent link that crosses the
boundary is cut, a matte pair that splits is cleared, and an expression whose
`layer("name")` now resolves to nothing on its own side is named — a
best-effort grep, honestly labelled, because a reference built from strings
at runtime cannot be seen from outside the sandbox.

---

## Sound

A movie render (`mp4` or `mov`) carries the comp's **audio mix** as well as its
pictures. Three kinds of layer contribute:

- an `audio` layer — its file (`src` is a library name: a song from the music
  library, or a clip whose sound you want without its picture);
- a `video` layer — its file's own audio track, when it has one (most
  generated clips are silent, and that is fine);
- a `comp` layer — the mix of its child comp, recursively, with the parent
  layer's trim and level applied on top. Works to the same eight-level depth
  the pictures do.

**Timing is the picture's timing.** `start`/`end` window the sound exactly as
they window the picture; `inPoint` trims into the source; `timeScale`
retimes it — a speed change *with* the pitch shift, the way AE's time-stretch
treats audio, and a negative value plays it backwards. Past either end of the
source the audio is silent (the picture holds its last frame there; a held
audio sample would be a buzz).

**Levels.** Every audio-capable layer has `audioLevels` — gain in dB, `-48`
to `+12`, `0` = unity — and it **keyframes like any other property**
(`vfx_set_property`, path `audioLevels`), so a fade is two keys and an ease
sounds the way it looks. Layers sum; the mix clips at the rail and says so on
stderr. Each layer also has an `audio` switch (`vfx_set_layer { audio:
false }`) to mute its sound without touching its picture. `solo` and
`enabled` govern sound exactly as they govern paint.

**timeRemap refuses audio, loudly.** A remapped picture over unremapped audio
is a lie, and v1 does not scrub sound through a remap curve — so a
time-remapped layer whose audio is live refuses to render, naming the fix:
set the layer's `audio` switch to `false` (the picture then remaps, silent)
or clear the curve (`set_prop`, path `timeRemap`, `value: null`). An `audio`
layer refuses the curve at authoring time.

**What does not change.** A comp with no audio-bearing source renders
**byte-identically** to how it always did — no audio stream is added. `png`
frame sequences never carry sound. There are **no audio effects** in v1
(no reverb, no EQ — levels only), and the browser preview does not play
audio: the mix ships in exported movies. The finished render job reports
what it muxed under `audio` (`seconds`, `peakDb`, `rmsDb`,
`clippedSamples`). `clippedSamples` counts the samples the summed mix pushed
past the rail before the hard clip — `peakDb` reads `0` either way, so this
is the number that tells a slammed mix from one riding the rail exactly;
non-zero means pull `audioLevels` down and re-render.

**The timeline shows the wave.** Every audio-carrying layer bar draws its
waveform, AE-style — `audio` layers always, `video` layers when the file has
a track — as a min/max band that follows the layer's real timing: trim it,
slide it, `timeScale`-stretch or reverse it and the wave moves with the clip,
because it is mapped through the same `inPoint + (t − start) × timeScale`
rule the mix uses. A muted layer (`audio: false`) dims its wave rather than
hiding it, and keyframed `audioLevels` draw their dB envelope (−48..+12 over
the lane height) as a line over the wave, easing included. The numbers come
from `vfx_audio_peaks` / the `audio_peaks` action — min/max pairs at the
resolution you ask for: `bins` pairs over the whole source, clamped 16..8192
(or `pixelsPerSecond` and the count is derived from the source's length;
1000 when neither is given) — decoded by the engine's own audio path and
cached against the **source file** (name + mtime + resolution), never against
the comp, so no comp edit ever recomputes a waveform; zoom just asks at a
finer resolution.
A source with no audio stream is refused with the reason rather than drawn
flat. Agents get the same numbers: `vfx_audio_peaks` is the way to assert
"there is signal at 12 s" without rendering anything.

**How this squares with the Studio timeline.** The Studio round trip predates
comp audio and still holds: `vfx_import_studio` records audio items as
**markers** by default and the Studio timeline keeps owning the song —
because Studio plays *video* tracks muted, a song baked into an exported clip
is a song the timeline cannot hear. `vfx_export_studio` therefore still wants
the music on a Studio *audio* track, and warns when the comp it rendered
carried audio. For the direct path — the music video rendered straight out of
the comp — import with `audio_as: "layers"` (or build `audio` layers by hand)
and `vfx_render`; the movie then carries the whole mix.

---

## Driving things from sound

`vfx_audio_keys` analyses an audio file into seven tracks — `amplitude`,
`bass`, `lowMid`, `highMid`, `treble`, `onset`, and `beat` (a decaying pulse on
each detected beat) — plus beats, bars and BPM.

Tracks run 0..1. `apply` writes one onto a property, mapping that range onto
`min`..`max`:

> make the logo pulse between 100% and 140% with the bass

```jsonc
{ "audio": "track.mp3", "apply": {
    "slug": "titles", "layerId": "ly_7f3a", "path": "transform.scale",
    "track": "bass", "min": 100, "max": 140 } }
```

On a vector property the value drives every component unless you name an
`axis`; the others keep what they had.

Bands bleed at the crossovers — a strong bass note shows a little in lowMid —
so the reply carries `bandDb` and `silentBands` and leaves the judgement to
you.

---

## Note-accurate instrument rigs

`vfx_audio_keys` hears *how loud*; `vfx_audio_notes` hears *which notes*. It
transcribes audio into `[{t, dur, midi, vel}]` and — with `fingering: true` —
onto guitar strings and frets, and `vfx_instrument_rig` builds a comp that
plays them: a neck-cam fretboard whose finger dots land on the frets actually
played, with a string flash on every pluck, bends sliding the dot along the
string, and an optional scrolling tab lane — or a piano whose keys light on
their own pitches under a falling note roll.

The pipeline, in order, each stage feeding the next:

    stems (the existing separation job — transcribe a STEM, not the mix)
      → transcribe   Basic Pitch, tuned per stem: the `guitar` profile hears
                     60–2000 Hz with a 40 ms minimum note (the model's default
                     minimum silently deletes 16th-notes at 140 BPM); `bass`
                     hears 30–400 Hz — a bass stem under the guitar profile
                     reads an octave high and too sparse
      → filter       drop low-confidence notes (the model's harmonic ghosts
                     ride +12/+19/+24 semitones at low confidence) and merge
                     same-pitch re-onsets within 90 ms
      → bends        a string bend arrives as a chromatic staircase; it leaves
                     as ONE note with `bend`/`bendTime`, which is what lets
                     the rig animate it as a slide instead of three phantoms
      → fingering    a travel-minimising assigner over chord events (standard
                     tuning by default, span ≤ 4 frets) — the filter is what
                     keeps its hand honest: unfiltered ghosts drag it from
                     position 1.6 to 2.9 and force unplayables
      → rig          ordinary shape/text layers with ordinary keyframes —
                     retime, recolour, glow, precompose like anything else.
                     Deterministic: the same notes render byte-identical
                     frames.

Transcriptions are cached on (file, mtime, profile) like the waveform peaks —
no comp edit ever invalidates one, and re-fingering under a different tuning
never re-runs the model.

**Honesty, before any of this reaches marketing copy**: every threshold above
was validated on clean synthetic guitar tones (note-level F1 0.81–0.93,
12/12 chord shapes, 3/3 bends, 100% playable fingering) and MUST be re-swept
on real recorded guitar before an accuracy claim is made about it. Distorted
or palm-muted material is entirely unvalidated — distortion compresses
harmonics into exactly the ghosts the filter hunts, so expect to lean harder
on the confidence gate. Real-world stems were checked for plausibility only
(density, key fit, register), not against ground truth.

Transcription needs the `basic-pitch` package (Apache-2.0, ~2 MB, the model
ships inside the wheel) in the same python the other VFX tools use. Without
it, `vfx_audio_notes` refuses with the exact install command; everything else
keeps working.

---

## Tracking

`vfx_track_motion` follows a rectangle through a clip. `mode: "follow"` writes
the feature's path onto a property so a layer rides along; `mode: "stabilize"`
writes the inverse so the shot holds still.

**It reports losing the shot rather than guessing.** If the feature is occluded
or leaves frame, tracking stops there, `lostAt` names the second, and no
invented positions are ever written. A short key list with a `lostAt` is the
tracker being honest, not failing quietly — widen `search` or pick a different
patch and run it again.

High confidence on repetitive texture (a striped shirt, a brick wall) is the
one failure confidence cannot see, so `margin` is reported per frame as well:
when it collapses, the tracker had rivals it could not tell apart.

A track is 2D. Applied to a 3D layer it writes `[x, y]` and the z falls back to
the default.

---

## Particles

`particleSystem` (group **Simulation**) is one effect: an emitter (point /
line / box / ring, position animatable) sprays soft round sprites that fly
under gravity, wind and exponential drag, changing size, opacity and colour
(0-255, like everything here) over their life. Birth rate, lifetime, speed,
spread and the rest are keyframable; blend is `add` for light (fire, sparks),
`normal` for matter (snow), `screen` in between. Drop it on a solid and
scrub.

**The design, in one paragraph — do not bolt stepped state onto it.** A
particle's position at time t is CLOSED-FORM from its birth state:
`p = p0 + v0·F(age) + a·G(age)` with `F = (1−e^(−k·age))/k`, `G = (age−F)/k`
(k → 0 gives the plain ballistic limit). Nothing steps frame to frame, so
scrubbing to any instant is O(particles) not O(frames), the frame cache can
hold any subset, and two renders are byte-identical (per-particle randomness
is a splitmix64 hash of (seed, particle index) — never a clock, never
np.random). Animated params are handled without breaking that: the birth-rate
curve is integrated (on a grid anchored at the layer start) and inverted to
give each particle its birth time; emitter position/direction and the physics
are sampled at that birth time and frozen per particle. Any feature that
would make position depend on the whole path — collisions, flocking — belongs
in a different effect with a different design, not in this one.

**Refused in v1, deliberately:** collisions and floor bounce (breaks the
closed form); real fluid turbulence (the `turbulence` param is a labelled
procedural wander — seeded sines over age, honest but not a solve); 3D
particles; textured or layer-as-sprite particles; per-particle motion blur;
sub-frame emission jitter beyond the birth-time model.

**Caps:** at most 6000 live particles a frame and 4M splatted kernel pixels;
past either, a seeded per-particle lottery thins the spray (stable per
particle, age distribution preserved) and says so in the render notes. Draft
renders keep a quarter of the particles — deterministically.

---

## Effect and animation presets

A preset is a named snapshot of a layer's effect stack — parameters,
keyframes, expressions, exactly as configured — and optionally the layer's
keyframed transform move (that is the "animation preset" half: a saved
entrance, a saved shake). The shelf is **app-level and server-side**
(`<outputDir>/vfx/_fx_presets.json`), so the VFX tab's Presets sheet and the
`vfx_effect_presets` MCP tool read the SAME list; an agent can curate a
library a person then applies, and vice versa. One tool, five ops — `list`,
`save`, `apply`, `delete`, `rename` (the REST spellings are
`list_fx_presets`, `save_fx_preset`, `apply_fx_preset`, `delete_fx_preset`,
`rename_fx_preset`).

The two rules worth knowing (both documented at their code, `store.js`
FXPRESETS):

- **Times are relative.** Keyframe times in a stored preset are seconds from
  the SOURCE layer's start. Apply writes them at `at` + relative time, and
  `at` defaults to the TARGET layer's own start — so a move authored to hit
  0.4s after a layer cuts in still hits 0.4s after the new layer does.
- **Merging is paste semantics.** The preset's keys replace existing keys
  only inside the time range they cover; keys outside survive, and an
  expression already on the property stays on top. Applied effects are always
  NEW instances with fresh ids.

Every effect type and parameter is validated against the **current** catalog
on apply — a preset that outlived a catalog rename is refused naming exactly
what is unknown, never half-applied. Expressions apply verbatim; one that
references a layer name the target comp does not have comes back as a
`warnings` entry, not a failure.

Built-ins ship on the shelf, named "(built-in)" — a film look, a keyed glow,
a greenscreen starter, a keyframed fade-scale entrance. They cannot be
deleted or renamed, and they double as worked examples of the stored format.

---

## The workspace

The viewer grew workspace furniture, and the rule that sorts it: what marks a
place in the **composition** is document state, visible to MCP and saved with
the comp; what describes how one person is **looking** stays in the browser,
per person, deliberately toolless.

**Guides are document state.** `set_guides` (`vfx_set_guides`) replaces the
list wholesale, exactly like markers: each guide is `{ axis, position }` —
`"x"` a vertical line at x=position, `"y"` a horizontal one at y=position,
comp pixels, fractions legal, at most 100 of them, and only on the comp
raster (there is no pasteboard, so an out-of-range position is refused rather
than invented). They survive reload, travel with the comp, and `vfx_get_comp`
shows them. In the GUI they come from **dragging out of the rulers** along
the viewer's top and left edges (double-click a ruler for an exact position);
a layer drag snaps to guides, the grid, the comp centre and the comp edges
within about 6 screen pixels, and **holding Ctrl during the drag passes
through without snapping**. The rulers themselves, the grid, the safe-zone
overlay, and whether guides are currently shown or locked are view state —
they never reach the document, and there is deliberately no tool for them.

**Ctrl-click multi-selects layers** in the stack — what align, distribute and
Precompose act on.

**`align_layers`** (`vfx_align_layers`) is AE's Align panel: `op` is one of
`left` / `centerH` / `right` / `top` / `centerV` / `bottom`, or `distributeH`
/ `distributeV` (three or more layers; the first and last stay). `to` is
`"selection"` (the group's own bounds — two or more layers) or `"comp"` (the
comp edges — works on a single layer; centerH+centerV with `to: "comp"` is
"centre this layer"). Bounds come from the engine's own transforms, so a
rotated, scaled or parented layer aligns by where it actually **is** — and a
text layer measures by its **glyph ink**, not its layer plane, so a title
aligns by the type. A layer whose rendered bounds are the whole comp plane (a
full-frame solid, an adjustment plate) cannot be moved by an align, and that
comes back as a warning instead of a silent no-op. The moves are written
through `transform.position` exactly as `set_prop` would write them: a
constant moves, a keyframed position gets a key at `t`, an expression keeps
running over the moved value. Locked layers refuse; 3D layers align in world
XY and z is untouched.

**`view_overlay`** (`vfx_view_overlay`) answers where things are **on
screen**, in comp pixels: the named layer's axis tripod and projected
bounding outline, every camera's frustum polylines, every light's wireframe —
computed with the engine's own projection functions, never a reimplementation,
so the overlay cannot disagree with the rendered frame. It takes the same
`view` as the preview, which is the main use: in a Top or orbit view this is
how an agent reads the 3D arrangement without guessing from pixels. An
`outline: null` means the layer does not project in that view (behind the
lens).

**`view_unproject`** is the inverse, and it is what the GUI's gizmo drag
calls instead of doing camera maths client-side: a screen-space drag (plane,
or constrained to one axis) in, the world-space delta it means and the new
`transform.position` **in the parent's space** out — because that is the
space the property is written in. The answer is meant to be written back
through the ordinary `set_prop` / `add_key`, which is what keeps undo and MCP
parity free. It is a REST action (`POST /api/vfx`, action `view_unproject`);
agents placing layers outright use `set_prop` and `align_layers` instead.

**`probe_pixel`** (`vfx_probe_pixel`) reads the RGBA under one comp-space
point off the **server-rendered** frame — the same PNG the viewer shows and a
render would produce, so what it reports is what ships. Both 0-255 and float
come back, and it takes `t`, `scale`, `draft` and `view` exactly as the
preview does. This is the tool an agent verifies its own edit with: "is the
pixel at (400, 300) actually red now" is an assertion, not a squint.

**Labels and shy are timeline housekeeping, not pixels.** `label` is a colour
**name** from AE's sixteen (`red`, `aqua`, `lavender`, … plus `"none"`) — a
name rather than a hex so the document reads as intent and the UI owns the
swatch; the engine never reads it. `shy: true` hides a layer from the
timeline **while the comp's `hideShy` is on** (`set_comp`) — it still
renders, exactly as in AE. Both write through `set_layer` like everything
else.

---

## Getting pixels out

- `GET /api/vfx/frame/<slug>?t=1.5` — a PNG of one instant. Add `&meta=1` to
  get JSON with the URL instead, which is the path a tool should take: a
  400 KB PNG in a transcript helps nobody. Two headers say what happened:
  `X-Vfx-Cache` names the tier that answered (`ram`, `disk`, or `render`),
  and `X-Vfx-Engine` names which python rendered a miss — `serve` is the
  persistent engine child that pays the ~400 ms of interpreter and
  numpy/cv2/PyAV startup **once per session** and keeps its decode caches
  warm between frames; `spawn` is the per-call fallback it degrades to when
  the child cannot run. `AIPLAY_VFX_NO_SERVE=1` pins everything to the
  per-call path — the A/B switch the speedup was measured with. Movie renders
  always take the per-call lane: a job that runs for minutes must not wedge
  the serial child.
- `prewarm` (`vfx_prewarm`) fills the frame cache over a range so playback
  can be playback instead of three hundred round trips — the GUI's play
  button fires it. It answers a job id immediately; one prewarm per comp (an
  identical request rejoins the running job, a different range supersedes
  it); the range is clamped to what the disk cache can actually hold, and the
  reply says when it was. It always yields to interactive requests, so firing
  one never makes scrubbing worse. `prewarm_cancel` stops filling — frames
  already made are kept. `GET /api/vfx/cache/<slug>` reports which frames are
  already there at a given scale.
- `GET /api/vfx/renders` (`vfx_render_status`) — every render and prewarm job
  the server remembers, across every comp, newest first; filter with `?slug=`
  and `?kind=`. In memory only: a restart clears the list, and a job a
  restart interrupted did not finish rather than being lied about as still
  running. A finished movie render's row carries the `audio` mix report —
  `seconds`, `peakDb`, `rmsDb`, `clippedSamples` — from **Sound**.
- `vfx_render` — the movie. `mov` keeps alpha; `mp4` does not. Both carry the
  comp's audio mix when it has one — see **Sound**.
- `vfx_export_studio` / `vfx_import_studio` — across to and from the Studio
  timeline.

---

## The three things that will bite you

**Sources are library names, not paths.** `raven.png`, not
`C:/.../raven.png`. A path is refused.

**Shape item order.** Path, operation, paint. Getting it wrong renders
successfully and silently does less than you asked.

**Colours are 0-255 everywhere** — layers, effects and shape items alike. This
one is nastier than it sounds: `[0.3, 0.9, 1.0]` is not rejected, because it is
a perfectly legal colour that happens to be almost black. The shape draws, the
alpha is identical, every test that counts painted pixels still passes, and
only the picture is wrong. If something renders in the right place looking far
too dark, this is why.
