# VFX — the contract

An After Effects-class compositor inside Studio: compositions, layers,
keyframed properties, an effects stack, masks, track mattes, parenting, motion
blur — rendered by ONE server-side engine that both the UI and MCP drive, the
same rule the image editor follows. The browser never renders the final pixels;
it asks the engine for a frame.

This file is the contract four builders implement against. **Nothing here is
advisory** — the pieces only interlock if the shapes match exactly.

---

## 1. The composition document

Stored one JSON per comp under `<outputDir>/vfx/<slug>/comp.json`, written
atomically (temp file + rename), same discipline as the mv store.

```jsonc
{
  "v": 1,
  "id": "cmp_ab12cd",
  "slug": "opening-titles",
  "name": "Opening titles",
  "width": 1920, "height": 1080, "fps": 30,
  "duration": 8.0,                      // seconds
  "bg": [0, 0, 0, 0],                   // rgba 0-255, alpha 0 = transparent comp
  "motionBlur": { "enabled": false, "shutter": 180, "samples": 8 },
  "layers": [ /* TOP of the stack is layers[0] — AE order, painted last */ ],
  "markers": [ { "t": 1.5, "label": "hit" } ],
  "guides": [ { "axis": "x", "position": 640 } ],  // ruler guides — DOCUMENT state,
                                        // comp px; "x" = a vertical line. View
                                        // furniture (grid, safe zones) never lands here.
  "hideShy": false,                     // whether the TIMELINE hides shy layers; never pixels
  "seed": 0,                            // every expression wiggle()/random() derives from it
  "createdAt": 0, "updatedAt": 0,
  "runs": []                            // breadcrumb log, same shape as mv docs
}
```

### Layer

```jsonc
{
  "id": "ly_7f3a",
  "name": "raven",
  "type": "image" | "video" | "solid" | "text" | "shape"
        | "adjustment" | "null" | "camera" | "comp" | "light" | "audio",
  // ^ THIS LIST IS LOAD-BEARING. store.js keeps its own copy in LAYER_TYPES and
  //   migrateLayer coerces anything not on it to "solid" — on every read, with
  //   no error. A kind the engine can draw but the store has not been told
  //   about renders correctly once and comes back from disk as a white
  //   rectangle. Add the kind to BOTH in the same commit.
  //   `light` (an AE light: `light.*` / `material.*`, /api/vfx/lights is the
  //   catalog) and `audio` (a sound-only source the movie mix reads) both
  //   paint nothing. docs/VFX.md is the usage truth for both.

  // sources — LIBRARY NAMES, never paths. The route resolves them.
  "src": "imt8vljo4.png",               // image: images dir; video: clips dir
  "color": [255, 255, 255, 255],        // solid
  "text": { "content": "GLASS AND NEON", "font": "georgia.ttf", "size": 96,
            "color": [240,240,245,255], "align": "center",
            "stroke": 0, "strokeColor": [0,0,0,255], "lineHeight": 1.15,
            "tracking": 0 },

  "start": 0.0, "end": 8.0,             // visibility window on the comp timeline
  "inPoint": 0.0,                       // source time at layer start (video)
  "timeScale": 1.0,                     // 2 = twice as fast; negative = reversed
  "blend": "normal",                    // see BLEND_MODES
  "parent": null,                       // layer id — transform inherits
  "motionBlur": false,                  // per-layer opt-in, comp switch gates it
  "enabled": true, "solo": false, "locked": false,

  "transform": {
    "anchor":   [960, 540],             // in LAYER pixels; rotation/scale pivot
    "position": [960, 540],             // in COMP pixels
    "scale":    [100, 100],             // percent
    "rotation": 0,                      // degrees, clockwise
    "opacity":  100                     // percent
  },
  // On a 3D layer every one of anchor/position/scale takes an optional THIRD
  // component: [x, y, z]. Both arities are valid everywhere and the engine
  // defaults a missing z (0 for anchor/position, 100 for scale). Any validator
  // that insists on exactly two silently replaces the whole vector with its
  // default — which does not merely drop z, it moves the layer.

  // ── 3D, opt-in per layer. A 2D layer is untouched by any of it. ──
  "threeD": false,
  // The three axes live INSIDE "transform", beside rotation — the engine reads
  // transform.rotationX. There is NO separate orientation triple: AE's split
  // exists to animate a spin on top of a fixed pose, which a keyframed axis
  // does on its own.  "transform": { …, "rotationX": 0, "rotationY": 0, "rotationZ": 0 }

  // camera layers only; the TOPMOST camera in the comp is the one used.
  // ALL SEVEN ANIMATE — the engine binds each under camera.<name> and pushes it
  // through the interpolator, so set_property / add_key reach them and an
  // expression on "pointOfInterest" aims the lens at another layer.
  //   pointOfInterest  [x, y, z] — the spot the lens looks at. ABSENT means the
  //                    camera is free and aimed by its own rotationX/Y/Z; there
  //                    is no default, and writing one changes the meaning.
  //   focusDistance    the distance that comes out sharp — keyframe it for a
  //                    rack focus. blurLevel is how hard the blur bites, %.
  //   depthOfField     a switch that KEYFRAMES: one hold key cuts focus.
  // ONE LENS, ONE SPELLING: "zoom" is the focal length in PIXELS and
  // "focalLength" is the same lens in mm on 36mm film (zoom = width·mm/36).
  // The engine reads focalLength ONLY when zoom is unset, so exactly one of the
  // two lives in a document: set_layer refuses both in one call, setting either
  // retires the other, and a load drops whichever one the render was ignoring.
  // Setting either WORKS FROM ANY STATE — a camera in millimetres, a camera
  // with no lens field at all, a camera with no "camera" object — because the
  // target spelling is decided from the call and the document together before
  // anything is written, never by retiring first and asking afterwards.
  // "zoom": null (or "focalLength": null) is the explicit retire: it hands the
  // lens to the OTHER spelling, CONVERTED by zoom = width·mm/36 so the shot is
  // unchanged, keyframe for keyframe. Retiring both at once is refused — a
  // camera with no live spelling is not a state this document has a reading
  // for — and so is retiring a lens that carries an expression, which cannot
  // be rescaled without changing what it computes.
  // A lens value must be POSITIVE (the engine hands the lens away at <= 0) and
  // every camera value sits inside the range CAMERA_PROP_SPEC declares; both
  // are enforced on every write door — set_layer, set_prop, add_key,
  // audio_keys — rather than only where the value happens to arrive.
  "camera": { "zoom": 1778, "depthOfField": false,
              "aperture": 25, "focusDistance": 1778,
              "blurLevel": 100, "pointOfInterest": [960, 540, 0] },

  // comp layers only — the child is named in "src", like any other source,
  // and it is a comp SLUG rather than a file name.
  "src": "child-comp",
  "collapse": false,                    // continuous rasterisation

  // shape layers only. Drawn IN ORDER, and the order is the whole game:
  // paths first, then operations, then paint. A stroke listed before a trim
  // consumes the path and the trim then has nothing left to shorten — it
  // renders, it just ignores the trim silently. vfx_shape_catalog has all 16
  // item types, 78 parameters and which 55 of them animate.
  "shapes": [
    { "type": "ellipse", "size": [160,160], "position": [0,0] },
    { "type": "trim", "start": 0, "end": 100 },
    { "type": "stroke", "color": [1,0,0], "width": 12 }
  ],

  // text layers: per-character animation
  "animators": [ { "selector": { "start": 0, "end": 100, "shape": "square" },
                   "props": { "position": [0,-40], "opacity": 0 } } ],

  // retiming. timeRemap is a curve whose VALUE is a time in the SOURCE, so it
  // keyframes, eases, roves and takes an expression like anything else.
  "timeRemap": { "keys": [ {"t":0,"v":0}, {"t":4,"v":2} ] },
  "frameBlend": "off",                  // off | mix — crossfade between source frames

  "effects": [
    { "id": "fx_1", "type": "gaussianBlur", "enabled": true,
      "params": { "radius": 12 } }
  ],

  "masks": [
    { "id": "mk_1", "mode": "add",      // add | subtract | none
      "points": [[100,100],[400,100],[400,400],[100,400]],   // comp px, closed
      "feather": 8, "opacity": 100, "invert": false, "expand": 0 }
  ],

  "trackMatte": null                    // { "type": "alpha"|"luma"|"alphaInv"|"lumaInv" }
                                        // uses the layer DIRECTLY ABOVE, AE rule
}
```

### Analysis: sound and motion become keyframes

`audiokeys.py` and `tracker.py` are separate programs that take a job file and
print one JSON line. Both emit `{"keys":[…]}` in exactly the form above, so a
result can be assigned straight to a property — which is what the `apply`
argument on `audio_keys` / `track_motion` does.

```jsonc
// audiokeys result — tracks are 0..1; apply's min/max map them onto the
// property's real units.
{ "ok": true,
  "tracks": { "amplitude": {"keys":[…]}, "bass": …, "lowMid": …, "highMid": …,
              "treble": …, "onset": …, "beat": {"keys":[…]} },
  "beats": [0.512, …], "bars": […], "bpm": 120.4,
  "seconds": 157.1, "fps": 30, "frames": 4713,
  "bandDb": {…}, "silentBands": [] }         // bands bleed at the crossovers;
                                             // these two let the caller judge

// tracker result — note the nesting, and note what minConfidence is NOT
{ "ok": true,
  "keys":      { "position": {"keys":[…]} },       // following the feature
  "stabilize": { "position": {"keys":[…]}, "anchor": [x,y] },  // cancelling it
  "confidence": [0.98, …],                   // PER FRAME, measured
  "margin": [0.71, …],                       // winning peak vs best rival
  "lostAt": 3.75,                            // seconds, or null
  "minConfidence": 0.55,                     // ← the THRESHOLD THE JOB RAN WITH,
                                             //   not a measurement. Do not
                                             //   report it as "the confidence".
  "frames": 90, "fps": 24, "dips": […] }
```

The tracker **stops rather than inventing positions**. A short key list with a
`lostAt` is it being honest, not failing quietly. High confidence on repetitive
texture is the one failure confidence cannot see, which is why `margin` is
reported separately.

### Animatable values — the heart of it

Any of these may be a **constant** (number or array, exactly as written above)
**or** a keyframed object. Animatable: `transform.*` (all five, plus
`rotationX/Y/Z` on a 3D layer), `opacity`, every numeric effect param, mask
`feather`/`opacity`/`expand`, `timeRemap`, every layer-style value, the 55 shape
item params the catalog marks, a text animator's properties and selector, and a
camera's lens. Not animatable, and worth knowing before writing an expression on
one: a text layer's own `size`/`tracking`/`color`, a solid's `color`, mask
`points`, and a layer's `start`/`end`/`inPoint`/`timeScale` — those are read
straight off the document.

```jsonc
{ "keys": [
    { "t": 0.0, "v": [0, 540],   "ease": "easeOut" },
    { "t": 1.2, "v": [960, 540], "ease": "easeInOut" },
    { "t": 3.0, "v": [1920, 540] }
] }
```

- `t` seconds, **sorted ascending**; the evaluator must tolerate unsorted input by sorting.
- `v` matches the property's arity (number, or array of the same length).
- `ease` one of `linear` (default), `hold`, `easeIn`, `easeOut`, `easeInOut`,
  or `{ "bezier": [x1, y1, x2, y2] }` (CSS cubic-bezier semantics).
  Easing describes the segment **leaving** that key.
- Before the first key: the first value. After the last: the last value.
- One key = constant.

**`evalProp(prop, t)`** returns the value; a constant returns itself.

A property may also carry **`"expr"`**, a line of AE-flavoured JavaScript that
computes it, with `value` bound to whatever the keys or the `"value"` field say:

```jsonc
{ "value": 65, "expr": "value * 2" }
{ "value": [960, 540], "expr": "value + wiggle(6, 40)" }
{ "value": [0, 0], "expr": "thisComp.layer(\"raven\").position + [40, 0]" }
```

`expressions.py` is the sandbox; the engine builds one `ExprEnv` per rendered
frame and passes `evalProp` a binding as its fourth argument. The binding's PATH
is the property's identity — `transform.position`, `effects.fx_1.radius` — and it
is what the cycle guard keys on and what `wiggle` seeds from, so it has to match
the spelling a link to that property resolves to. A refused or broken expression
is one line on stderr and the property falls back to its keys; it never costs the
frame.

---

## 2. Blend modes

`BLEND_MODES = normal, multiply, screen, overlay, softlight, hardlight, add,
subtract, difference, darken, lighten, colordodge, colorburn, hue, saturation,
color, luminosity` — plus AE's four transfer modes `stencilAlpha,
stencilLuma, silhouetteAlpha, silhouetteLuma`, which are not blends at all:
the engine branches on them **before** compositing and uses the layer to cut
everything beneath it in the same group. They ride the same field because
that is where AE puts them.

The first ten already exist in `server/imagetools.py::_blend` — **import and
extend that**, do not fork the maths.

---

## 3. Files and ownership

| File | Owner | Contents |
|---|---|---|
| `server/vfx/interp.py` | Engine | keyframe evaluation, easing, transform maths |
| `server/vfx/engine.py` | Engine | comp evaluation, layer render, masks, mattes, parenting, motion blur, frame + movie output |
| `server/vfx/effects.py` | Effects | the effect registry + `CATALOG` |
| `server/vfx/effects_test.py` | Effects | pure-function tests |
| `server/vfx/engine_test.py` | Engine | interp + render tests |
| `server/vfx/expressions.py` | Engine | the expression sandbox (`wiggle`, `linear`, property links) |
| `server/vfx/expressions_engine_test.py` | Engine | that the sandbox reaches the PIXELS — the wiring, asserted through `render_frame` |
| `server/vfx/shapes.py` | Shapes | vector geometry: 16 item types + `CATALOG` |
| `server/vfx/audiokeys.py` | Data | audio → seven keyframe tracks, beats, BPM |
| `server/vfx/tracker.py` | Data | NCC point tracking → position keys, stabilisation |
| `server/vfx/notes.py` | Data | audio → notes (Basic Pitch) + guitar fingering |
| `server/vfx/particles.py` | Effects | the closed-form particle model behind particleSystem |
| `server/vfx/lights.py` | Engine | lights, materials, plane-onto-plane shadows + their catalog |
| `server/vfx/viewport.py` | Engine | workspace geometry: overlay, unproject, layer bounds, pixel probe |
| `server/vfx/templates.js` | Server | the template library — pure comp-document builders |
| `server/vfx/rigs.js` | Server | instrument rigs: notes → fretboard/piano comps |
| `server/vfx/store.js` | Server | comp CRUD, atomic writes, migrate |
| `server/vfx/store_test.js` | Server | round-trip tests — the only way the migrate bugs were visible |
| `server/vfx/camera_test.js` | Server | the camera write path through the real dispatch — the only way the set_layer camera rebuild was visible |
| `server/vfx/routes.js` | Server | `createVfxRoutes(deps)` — every REST route |
| `server/mcp-vfx.js` | Server | `vfxTools(api, safeName)` → tool array |
| `web/vfx.js` | UI | the whole tab: viewer, layer stack, timeline, panels |
| `web/vfx.css` | UI | its styles (a separate sheet, linked from index.html) |

**Nobody edits files outside their column.** Registration into `index.html`,
`web/app.js`, `server/index.js` and `server/mcp.js` is done by the integrator.

That split is what makes this work parallelisable, and it has one recurring
cost worth naming: **a module in one column is invisible to the column that
should call it.** Every integration fault found so far was of that shape and
none of them raised anything —

- `engine.py` probed `interp.eval_time_remap`; the name exported was
  `time_remap`, with a different signature. `getattr` returned `None`, the
  fallback gave a plausible answer, and every ease on a remap curve was
  discarded.
- the UI wrote `effects.<id>.params.<k>`; the route resolved
  `effects.<id>.<k>`.
- `shapes.py` rendered 16 item types that nothing dispatched to.
- `audiokeys.py` and `tracker.py` were programs no route ran.
- `store.js` coerced every layer kind it had not been told about to `"solid"`,
  on read, so three of those columns' work was erased on the way back from
  disk.

So: when you finish a module, the job is not done until something in another
column calls it and a test asserts the result **through that path**.

---

## 4. The engine CLI

`python server/vfx/engine.py <mode> <job.json>` — one JSON line to stdout.

### `frame`
```jsonc
{ "comp": { /* the full comp document, sources already resolved to ABSOLUTE paths */ },
  "t": 2.5, "out": "C:/…/preview.png",
  "scale": 0.5,            // render at half size — the preview lane
  "draft": true }          // skip motion blur and expensive effect paths
```
→ `{ "ok": true, "out": "…", "width": 960, "height": 540, "ms": 412 }`

### `render`
```jsonc
{ "comp": { … }, "out": "C:/…/clip.mp4",
  "from": 0.0, "to": 8.0,          // optional range, default whole comp
  "format": "mp4" | "png" | "mov", // mov = qtrle, keeps alpha
  "crf": 18, "codec": "auto",      // auto → h264_nvenc if present, else libx264
  "scale": 1.0, "draft": false,
  "progressEvery": 10 }            // emit a progress line every N frames
```
Progress lines (stdout, before the final line): `{"progress": 0.42, "frame": 51}`
→ `{ "ok": true, "out": "…", "frames": 240, "seconds": 8.0, "ms": 91234 }`

### `probe`
```jsonc
{ "sources": ["C:/…/a.mp4", "C:/…/b.png"] }
```
→ `{ "ok": true, "sources": [ { "path": "…", "kind": "video", "width": 864,
     "height": 480, "duration": 14.4, "fps": 24.0 }, … ] }`

### `peaks`
```jsonc
{ "src": "C:/…/song.flac", "bins": 1000 }   // bins clamped 16..8192
```
→ `{ "ok": true, "bins": 1000, "rate": …, "seconds": …,
     "peaks": [lo, hi, lo, hi, …] }` — min/max pairs over the WHOLE source,
decoded by the same PyAV path the render mix reads. A source with no audio
stream is an error, never a flat line. Layer timing is deliberately absent:
the envelope is a property of the file, and the caller maps comp time onto it.

### `serve`
`python server/vfx/engine.py serve` — one long-lived process:
`{"id", "cmd", "job"}` a line on stdin, one JSON line back, strictly in
order. `cmd` is any of the modes above plus `stats` and `release`;
`shutdown` ends it. It exists because interpreter + numpy/cv2/PyAV startup
costs ~400 ms **per spawned frame**; the routes keep one serve child for
`frame` and `probe` (render stays per-call — a job that runs for minutes must
not wedge the serial queue) and fall back to per-call spawning whenever the
child cannot run. `AIPLAY_VFX_NO_SERVE=1` pins everything to the per-call
path. Cached sources are re-statted between jobs, so an edited file is never
rendered stale.

**Failure on any file-driven mode:** `{ "ok": false, "error": "…" }` and exit 1.

---

## 5. The effects contract

```python
# server/vfx/effects.py
def apply(name: str, rgba: np.ndarray, params: dict, ctx: dict) -> np.ndarray
```

- `rgba` is **float32, shape (H, W, 4), values 0..1, straight (un-premultiplied) alpha.**
- Return the same shape/dtype. Never mutate the input in place.
- `ctx` = `{ "t": float, "fps": float, "width": int, "height": int, "draft": bool, "layer": {…} }`
- Unknown effect name → return `rgba` unchanged (never raise).

```python
CATALOG = {
  "gaussianBlur": {
    "label": "Gaussian Blur",
    "group": "Blur & Sharpen",
    "why": "one line on what it is for",
    "params": {
      "radius": { "type": "number", "default": 8, "min": 0, "max": 200, "animatable": True },
      "edgeBehavior": { "type": "enum", "options": ["clamp", "transparent"], "default": "clamp" }
    }
  },
  …
}
```

`CATALOG` is what MCP serves for discovery, so **every param a human could set
must be described there** — an agent reads it instead of guessing.

### The effect set to build (grouped, all feasible with numpy/cv2/PIL)

- **Blur & Sharpen** — gaussianBlur, directionalBlur, radialBlur (zoom/spin), boxBlur, unsharpMask, bilateralSmooth
- **Color** — brightnessContrast, curves (reuse imagetools' PCHIP), levels, hueSaturation, exposure, tint, colorBalance (shadows/mids/highs), vibrance, channelMixer, invert, blackAndWhite
- **Keying** — chromaKey (port from imagetools, keep despill), lumaKey, colorRangeKey, spillSuppress, matteChoke (erode/dilate + feather)
- **Stylize** — glow, dropShadow, stroke, posterize, findEdges, mosaic, halftone, noise (seeded), scanlines, chromaticAberration
- **Distort** — transform (a second free transform inside the stack), cornerPin (cv2 warpPerspective), wave, ripple, bulge, lensDistortion, mirror, polarCoords
- **Generate** — fill, ramp (linear/radial), checkerboard, vignette, lensFlare (procedural), gridLines
- **Time** — echo, posterizeTime, timeDifference. `needsHistory: True` asks the
  engine for this layer's previous frames; it supplies them as a CALLABLE taking
  how many are wanted and returning them newest-first, so nothing decodes frames
  no effect asked for. `snapsTime: True` asks for the layer's CONTENT to be
  sampled at a quantised instant — its transform still uses the true time, so a
  posterized layer travels smoothly while its content steps.
- **Transition** — linearWipe, radialWipe, venetianBlinds, blockDissolve,
  gradientWipe, irisWipe. Its own group: a wipe is neither a stylize nor a matte,
  and all six are driven by one keyframed `completion`. Anything that hard-codes
  a fixed group list drops these six silently — the group list has grown four
  times since the original eight, and `GET /api/vfx/catalog` serves `groups`
  derived from the catalog itself for exactly this reason.
- **Noise & Grain** — noise (moved here from Stylize, same name, same params,
  same pixels), addGrain (film grain, a fresh pattern every frame seeded from
  (seed, frame) and nothing else), median, dustScratches (the classic
  median-under-threshold repair), reduceNoise (an edge-preserving luma/chroma
  bilateral — honest about not being AE's grain-sampling Remove Grain). Its own
  group, with the Transition warning again: anything that hard-codes a fixed
  group list drops these five silently. matchGrain is deliberately NOT here —
  sampling grain off another layer is its own build.
- **Matte** — feather, invertAlpha, premultiply/unpremultiply
- **Simulation** — particleSystem, the closed-form particle emitter
  (docs/VFX.md — Particles — owns the design and the refusals). Its own group,
  same hard-coded-list warning.
- **Expression Controls** — sliderControl, pointControl, point3DControl,
  angleControl, checkboxControl, colorControl. Its own group, and the strangest:
  every one is a pixel no-op (`return rgba`, by identity — `apply` skips even
  its clip pass). They exist to be keyframed and READ by expressions as
  `thisComp.layer("x").effect("<fxId>")("<param>")`; the effect **id** is the
  handle, because effect instances carry no user-facing name. dropdownControl
  is deliberately absent: the catalog carries one option list per TYPE, so a
  per-instance menu cannot be described to MCP, and a fixed menu is dead
  weight. The same warning as Transition applies: anything hard-coding a
  fixed group list drops these six silently.

Aim for correctness and honest parameter ranges over count. Every effect gets
at least one assertion in `effects_test.py`.

---

## 6. REST routes (`server/vfx/routes.js`, mounted at `/api/vfx`)

`createVfxRoutes(deps)` returns `async (req, res, url) => handled:boolean`, the
same shape as `createMvRoutes`. deps: `{ json, readBody, config, IMAGE_DIR,
CLIP_DIR, art, spawnPython }`.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/vfx/comps` | `{ comps: [{slug,name,width,height,fps,duration,layers}] }` |
| GET | `/api/vfx/comp/:slug` | `{ comp, renders, prewarms }` — the comp plus its jobs |
| POST | `/api/vfx` | one action per call, `{ action, … }` — see below |
| GET | `/api/vfx/frame/:slug?t=2.5&scale=0.5` | **image/png** of that frame (this is the viewer). `&meta=1` answers JSON with the URL; `&view=` renders through a workspace view (VFX.md) |
| GET | `/api/vfx/catalog` | `{ effects: CATALOG, groups }` (read from the python once, cached; `groups` derived, never hard-coded) |
| GET | `/api/vfx/shapes` | `{ shapes }` — shapes.py's catalog |
| GET | `/api/vfx/lights` | lights.py's catalog, verbatim — the one authority on light/material params |
| GET | `/api/vfx/templates` | `{ templates }` — the template shelf |
| GET | `/api/vfx/camera-moves` | `{ moves }` — CAMERA_MOVES verbatim (`id`, `label`, `why`, `needsTarget`, `takes`). The camera panel's "moves…" shelf reads it, and it is the same table the `camera_move` action validates against, so the moves a person can click are the moves an agent can name |
| GET | `/api/vfx/renders` | every render/prewarm job across all comps, newest first. In memory; a restart clears it |
| GET | `/api/vfx/cache/:slug` | which frames are already rendered at a scale — the prewarm's coverage manifest |

POST actions: `create` (name,width,height,fps,duration), `delete`, `rename`,
`set_comp` (partial comp fields), `add_layer`, `remove_layer`, `duplicate_layer`,
`reorder_layer` (id,toIndex), `set_layer` (partial layer fields — deep-merged),
`set_prop` (layerId, path e.g. `transform.position`, value OR keys OR expr),
`add_key` (layerId, path, t, v, ease), `remove_key` (layerId, path, t),
`add_effect` (layerId, type, params?), `remove_effect`, `set_effect`
(layerId, fxId, params partial), `reorder_effect`, `add_mask`, `set_mask`,
`remove_mask`, `set_matte`, `precompose` (layerIds → a new comp used as a layer),
`import_studio` (studio project name → layers from its video/audio items),
`export_studio` (render, then place the clip on a Studio timeline),
`render` (options as in the CLI; runs through `art` so music keeps priority,
returns a job id; the clip lands in the clips library).

Grown since that first list, each documented in docs/VFX.md: `from_template`,
`prewarm` / `prewarm_cancel` (the RAM preview), `add_shape_preset`, the
preset shelf (`save_fx_preset`, `list_fx_presets`, `apply_fx_preset`,
`delete_fx_preset`, `rename_fx_preset`), `layer_properties` (the animatable
enumerator), the analysis actions (`audio_keys`, `audio_peaks`,
`audio_notes`, `instrument_rig`, `track_motion`) and the workspace
(`view_overlay`, `view_unproject`, `probe_pixel`, `align_layers`,
`set_guides`). `routes.js` is the authority on the current set.

Validation rules that MUST hold: sources are library **names** resolved
server-side (never client paths); width/height 16..4096; fps 1..120; duration
0.1..600; layer count ≤ 64; effects per layer ≤ 24.

---

## 7. MCP tools (`server/mcp-vfx.js`)

`vfxTools(api, safeName)` → array of tool objects `{ name, description,
inputSchema, run }`, exactly the shape `mcp-mv.js` uses.

Required tools — one per capability, named for what a person would ask for:

`vfx_list_comps`, `vfx_create_comp`, `vfx_get_comp`, `vfx_delete_comp`,
`vfx_add_layer`, `vfx_remove_layer`, `vfx_duplicate_layer`, `vfx_reorder_layer`,
`vfx_set_layer`, `vfx_set_property` (constant **or** keyframes),
`vfx_add_keyframe`, `vfx_remove_keyframe`, `vfx_add_effect`,
`vfx_set_effect`, `vfx_remove_effect`, `vfx_effects_catalog` (the discovery
tool — an agent reads this before guessing param names), `vfx_add_mask`,
`vfx_set_matte`, `vfx_precompose`, `vfx_preview_frame` (renders one frame,
returns its URL — how an agent SEES its work), `vfx_render`,
`vfx_import_studio`, `vfx_export_studio`.

The surface has grown well past that list, one tool per later capability:
`vfx_set_comp`, `vfx_set_mask`, `vfx_remove_mask`, `vfx_reorder_effect`,
discovery (`vfx_shape_catalog`, `vfx_shape_preset`, `vfx_templates`,
`vfx_layer_properties`), analysis (`vfx_audio_keys`, `vfx_audio_peaks`,
`vfx_audio_notes`, `vfx_instrument_rig`, `vfx_track_motion`), the workspace
(`vfx_probe_pixel`, `vfx_view_overlay`, `vfx_align_layers`,
`vfx_set_guides`), jobs (`vfx_prewarm`, `vfx_render_status`) and the preset
shelf (`vfx_effect_presets`, five ops in one tool). `server/mcp-vfx.js` is
the authority on the current list; docs/VFX.md is the usage truth.

Descriptions must state units and ranges (position in comp pixels, scale in
percent, rotation in degrees clockwise, opacity 0-100) and say plainly when a
property is animatable.

---

## 8. The UI (`web/vfx.js`, `web/vfx.css`)

A tab called **VFX**, laid out like a compositor:

- **Top bar** — comp picker, new/duplicate/delete, size/fps/duration fields, Render.
- **Viewer** (centre) — the server-rendered frame at the playhead, `<img>` from
  `/api/vfx/frame/:slug?t=…&scale=…`, debounced ~120 ms while scrubbing, half
  scale while dragging and full scale when it settles. A transport under it:
  play (steps frames at fps, best-effort), step, in/out, current time.
- **Layer stack** (left) — AE order (top = front), name, type glyph, visibility,
  solo, lock, blend mode, matte badge, parent picker; drag to reorder; click to
  select. **Ctrl-click multi-selects** — what align, distribute and Precompose
  act on.
- **Workspace gestures** — rulers along the viewer's top and left edges:
  **drag out of a ruler** to drop a guide (double-click a ruler for an exact
  position); a layer drag snaps to guides, grid, comp centre and edges, and
  **holding Ctrl during the drag bypasses the snap**. Guides are document
  state (`set_guides`); rulers, grid, safe zones and guide visibility/lock
  are view state.
- **Properties** (right) — the selected layer's transform (five rows), its
  effects (each collapsible with its params from the catalog), masks, matte.
  Every animatable row has a **stopwatch** toggle: on = write a keyframe at the
  playhead whenever the value changes.
- **Timeline** (bottom) — a row per layer showing its `start..end` bar; expanded
  layers show one row per animated property with its keyframe diamonds; drag a
  diamond to move it in time, double-click to delete, right-click for easing.
  Playhead scrubs the viewer.

Rules: no final pixels in the browser (the viewer is engine output); every
action goes through `/api/vfx` so an agent doing the same thing produces the
same document; the tab must survive an empty state (no comps) without throwing.

---

## 9. Performance expectations (measured targets, not wishes)

- Preview frame at 0.5 scale, 3 layers, 2 effects: **under 400 ms**.
- Full render 1920×1080 @30fps: this is Python — plan for **1-4 s per frame**
  with effects. `draft` and `scale` exist for this reason; nvenc handles encode.
- The engine must **cache decoded video frames** by (path, frame index) with a
  bounded LRU — scrubbing the same second repeatedly must not re-decode.
- Region-of-interest: composite a layer only over its bounding box (this is how
  `imagetools.composite` already works — keep that).
