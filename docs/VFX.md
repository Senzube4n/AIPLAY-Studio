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

Ten kinds of layer:

| kind | what it is |
|---|---|
| `image` / `video` | a still or clip from the library, by **name** — never a path |
| `solid` | a flat rectangle of colour, with its own width and height |
| `text` | type, optionally animated per character |
| `shape` | vector geometry — see below, it is the deepest of them |
| `adjustment` | applies its effects to everything beneath it |
| `null` | renders nothing; a handle to parent other layers to |
| `camera` | a viewpoint. Only `threeD` layers respond to it |
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
`timeRemap`, `rotationX/Y/Z`.

### Expressions

Any property also takes an expression, which **layers over** it rather than
replacing it — whatever is underneath stays, and the expression reads it as
`value`:

```jsonc
{ "expr": "wiggle(2, 30)", "value": [960, 540] }
```

`value`, `time`, `wiggle(freq, amp)`, `random()`, `linear(t,a,b,c,d)`,
`ease(t,a,b,c,d)`, `loopIn()`, `loopOut()`, `valueAtTime(t)`, `velocity()`,
and links to other layers' properties by path. Clearing the expression gives
back exactly what was underneath.

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
or remove the curve. An `audio` layer refuses the curve at authoring time.

**What does not change.** A comp with no audio-bearing source renders
**byte-identically** to how it always did — no audio stream is added. `png`
frame sequences never carry sound. There are **no audio effects** in v1
(no reverb, no EQ — levels only), and the browser preview does not play
audio: the mix ships in exported movies. The finished render job reports
what it muxed under `audio` (`seconds`, `peakDb`, `rmsDb`).

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
library a person then applies, and vice versa.

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

## Getting pixels out

- `GET /api/vfx/frame/<slug>?t=1.5` — a PNG of one instant. Add `&meta=1` to
  get JSON with the URL instead, which is the path a tool should take: a
  400 KB PNG in a transcript helps nobody.
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
