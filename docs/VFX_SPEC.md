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
  "createdAt": 0, "updatedAt": 0,
  "runs": []                            // breadcrumb log, same shape as mv docs
}
```

### Layer

```jsonc
{
  "id": "ly_7f3a",
  "name": "raven",
  "type": "image" | "video" | "solid" | "text" | "adjustment" | "null",

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

### Animatable values — the heart of it

Any of these may be a **constant** (number or array, exactly as written above)
**or** a keyframed object. Animatable: `transform.*` (all five),
`opacity`, every numeric effect param, and mask `feather`/`opacity`/`expand`.

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

---

## 2. Blend modes

`BLEND_MODES = normal, multiply, screen, overlay, softlight, hardlight, add,
subtract, difference, darken, lighten, colordodge, colorburn, hue, saturation,
color, luminosity`

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
| `server/vfx/store.js` | Server | comp CRUD, atomic writes, migrate |
| `server/vfx/routes.js` | Server | `createVfxRoutes(deps)` — every REST route |
| `server/mcp-vfx.js` | Server | `vfxTools(api, safeName)` → tool array |
| `web/vfx.js` | UI | the whole tab: viewer, layer stack, timeline, panels |
| `web/vfx.css` | UI | its styles (a separate sheet, linked from index.html) |

**Nobody edits files outside their column.** Registration into `index.html`,
`web/app.js`, `server/index.js` and `server/mcp.js` is done by the integrator.

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

**Failure on any mode:** `{ "ok": false, "error": "…" }` and exit 1.

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
- **Time** — echo (trails over previous frames; engine supplies history via ctx if `needsHistory: True` in the catalog entry), posterizeTime
- **Matte** — feather, invertAlpha, premultiply/unpremultiply

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
| GET | `/api/vfx/comp/:slug` | `{ comp }` |
| POST | `/api/vfx` | one action per call, `{ action, … }` — see below |
| GET | `/api/vfx/frame/:slug?t=2.5&scale=0.5` | **image/png** of that frame (this is the viewer) |
| GET | `/api/vfx/catalog` | `{ effects: CATALOG }` (read from the python once, cached) |

POST actions: `create` (name,width,height,fps,duration), `delete`, `rename`,
`set_comp` (partial comp fields), `add_layer`, `remove_layer`, `duplicate_layer`,
`reorder_layer` (id,toIndex), `set_layer` (partial layer fields — deep-merged),
`set_prop` (layerId, path e.g. `transform.position`, value OR keys),
`add_key` (layerId, path, t, v, ease), `remove_key` (layerId, path, t),
`add_effect` (layerId, type, params?), `remove_effect`, `set_effect`
(layerId, fxId, params partial), `reorder_effect`, `add_mask`, `set_mask`,
`remove_mask`, `set_matte`, `precompose` (layerIds → a new comp used as a layer),
`import_studio` (studio project name → layers from its video/audio items),
`export_studio` (render, then place the clip on a Studio timeline),
`render` (options as in the CLI; runs through `art` so music keeps priority,
returns a job id; the clip lands in the clips library).

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
  solo, lock, blend mode, matte badge, parent picker; drag to reorder; click to select.
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
