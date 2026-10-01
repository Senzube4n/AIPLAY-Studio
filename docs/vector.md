# Making clean vectors through Studio

Use this guide when a person or an LLM needs an editable SVG from a logo or
flat artwork. The same CPU vectorizer serves the Images screen, the local
HTTP API and the MCP tool `image_vectorize`. A good trace is the starting
point; a clean finished logo also needs deliberate geometry and visual review.

## Start with the right source

Keep the highest-resolution original. Call `image_vector_import` with exactly
one absolute local `path` or base64 `data_url`, plus an optional filename hint
`name`, to copy a supplied PNG, JPEG or WebP into Pictures. It returns the
library filename needed by `image_vectorize` and keeps the original file.
An image already in Pictures can instead be found through `list_images`.

```json
{
  "path": "C:/Artwork/badge.png",
  "name": "badge.png"
}
```

`image_vector_import` does not download a remote URL. `import_local_media`
normally stages an image as a generation reference, which is a different
location from Pictures; its reference name alone cannot be traced. Do not
supply an arbitrary filesystem path to `image_vectorize` itself.
The source stays in the library and each
successful call creates a new SVG with its actual settings and source receipt.

Choose the mode by what the pixels mean:

| Source | Mode | What happens |
|---|---|---|
| Flat colors with useful color boundaries | `logo` | Trace separate palette regions and their holes. |
| Transparent artwork whose shape matters more than its raster gradient | `silhouette` | Trace the alpha mask as one neutral palette color, `#808080`. |
| A photograph wanted as stylized flat regions | `posterize` | Posterize colors, then trace; this does not recover original gradient fills. |

An opaque image in silhouette mode becomes its whole rectangular canvas.
Remove the background first if that is not the intended shape. Alpha is
thresholded; a soft shadow or translucent paint is not preserved as continuous
opacity. RGB hidden beneath transparent pixels does not determine the trace.

For a finished logo, start with `quality:"high"` and retain the full source
size up to the 4096-pixel working limit. Draft is useful for exploring settings,
but it can remove thin details. A higher quality setting preserves source
bumps more closely; it is not a stronger smoothing setting.

```json
{
  "name": "badge.png",
  "mode": "silhouette",
  "quality": "high",
  "maxSize": 4096,
  "minArea": 1
}
```

Read the returned `palette`, `shapes`, `traceFingerprint`, `replay`, `settings`,
`stats` and `warnings` before choosing cleanup. Each shape identifies its
palette `color`, zero-based `contour` index, bounds, area and whether it is a
hole. Selection bounds, allowed cleanup deviation and bidirectional outline
residuals use source-image pixels; areas use source pixels squared. The SVG
retains the source width and height. Primitive coordinates and smoothing
diagnostics are marked `primitiveCoordinateSpace:"tracePixels"`; use the
receipt's working dimensions and `stats.scaleX`/`stats.scaleY` when interpreting
those values for a resized trace.
Keep the source and trace settings fixed: a contour index belongs to that
source, mode, palette and alpha threshold, not to every future trace of the logo.
Any call containing cleanup or composition must set `basis` to that first
receipt's 64-character `traceFingerprint`. A changed trace basis is
refused rather than applying old contour IDs to new shapes. The shape receipt
lists at most 512 contours; `shapesTruncated` warns when the trace is larger.

**Preserve the returned `replay` object.** It is a directly valid
`image_vectorize` request, already containing the original raster name, actual
base settings and matching `basis`. Clone it and add or edit `cleanup` and
`composition` for the next call. Do not forward the entire result or copy
unfiltered `settings`: result metadata and computed effective settings are not
accepted request fields.

After a finishing call, its new `replay` also contains the chosen cleanup and
composition. Clone that latest request for further refinements and retain
previous operations/fills/shadows unless their removal is intentional. Every
call rebuilds from the original raster; it does not modify the previous SVG.
Adding just a new operation in a fresh request would lose earlier finishing
choices. To undo a chosen operation, remove it from the cloned request and
render again.

## Decide which outlines may change

Classify the artwork before editing:

- Reconstruct a circular border as a circle, or its inner and outer outlines
  as concentric circles. This removes accidental uneven thickness.
- Reconstruct a straight divider as a parallelogram when its long sides are
  parallel and its end caps are straight.
- Smooth the long curves of an illustrated cap, headphone or similar shape
  with modest displacement and fewer curve segments.
- Keep lettering, counters inside letters, narrow gaps, waveform peaks and
  intentional sharp tips protected by leaving their contours unselected.

Cleanup is opt-in and applies to explicitly selected complete contours. It
does not infer the logo's meaning. If a waveform and an illustration share one
connected contour, they cannot be protected as separate contours. Use modest
smoothing, check every peak, or prepare separate source layers first. Detected
corners receive protection during smoothing; detection cannot establish the
artist's intent.

Call `image_vectorize` again with a clone of `replay` and a `cleanup`
operation. The following is an expanded example selection, not a reusable contour map
for a different image. Replace the example `basis` with the first receipt's
fingerprint and select IDs from that receipt:

```json
{
  "name": "badge.png",
  "mode": "silhouette",
  "quality": "high",
  "maxSize": 4096,
  "minArea": 1,
  "basis": "0000000000000000000000000000000000000000000000000000000000000000",
  "cleanup": {
    "operations": [
      {
        "type": "concentric",
        "color": "#808080",
        "contours": [0, 1],
        "maxDeviation": 6
      },
      {
        "type": "smooth",
        "color": "#808080",
        "contours": [7],
        "maxDeviation": 4,
        "strength": 0.5
      }
    ]
  }
}
```

Operation types are `smooth`, `circle`, `concentric` and `parallelogram`.
`maxDeviation` is the allowed source-pixel displacement, from 0.5 to 32.
It defaults to 4. Only smoothing takes `strength`, from 0 to 1, default 0.7.
Circle and parallelogram reconstruction each select exactly one contour;
concentric reconstruction selects 2 to 16. Primitive reconstruction needs
complete, near-matching outlines and refuses unsuitable geometry or a result
beyond the allowed deviation. Do not continually increase the limit just to
make a refusal disappear: inspect whether the selected contour is the correct
shape. Unselected outlines retain the faithful trace.

## Add deliberate fills and shadows

Raster gradient bands should not become hundreds of colored vector slivers.
Trace the intended silhouette or prepared flat-color layers, then supply actual
gradient fills. Studio does not infer an exact gradient, isolate text from a
connected shape, or reconstruct a hidden source layer automatically.

The top-level `gradients` option replaces a palette color with an explicit
linear gradient. Those fills share the image-coordinate system. For distinct
fills on selected shapes, use `composition.fills`. A fill selects a palette
color and contour indices and sets either `solid` or `gradient`.

```json
{
  "composition": {
    "fills": [
      {
        "color": "#808080",
        "contours": [7, 8],
        "gradient": {
          "angle": 0,
          "bounds": [500, 1300, 1100, 1100],
          "stops": [
            {"offset": 0, "color": "#e42dce"},
            {"offset": 0.5, "color": "#6251f8"},
            {"offset": 1, "color": "#46ddfb"}
          ]
        }
      }
    ],
    "shadows": [
      {
        "color": "#808080",
        "contours": [10, 11],
        "offset": [12, 14],
        "fill": "#c3c3c3"
      }
    ]
  }
}
```

Merge this example with the complete trace request; it is not a standalone
tool call, and it also requires `basis` from the initial trace. The optional
gradient bounds are `[x,y,width,height]` in source pixels; without them, a
composition gradient uses the selected contours' combined bounds. Explicit
bounds keep a multi-part gradient aligned to the approved
design. Gradient angles use image coordinates: 0 goes left to right, 90 top
to bottom. Supply ordered stops, each with an offset from 0 to 1 and a
`#rrggbb` color. Include every retained counter belonging to a filled or
shadowed shape in the selection so its holes remain empty. A counter explicitly
listed in `composition.omit` need not be repeated in the fill or shadow
selection; leaving it out intentionally makes that selected shape solid.

Shadows are translated copies of the cleaned foreground geometry drawn behind
it. This gives a consistent offset and clean curves instead of tracing the
jagged exposed edge of an existing raster shadow. Rebuild an intended hard
offset shadow this way only when its source geometry is known. A soft painted
shadow needs a different treatment. `composition.omit` can explicitly remove
selected contours such as verified separation-mask fringes; do not use it on
small legitimate dots, letters or details merely because their area is small.
Omitting a counter contour alone deliberately fills that hole. Check the
`parent` fields and omit the whole intended shape with its holes when removing
an artifact. Fills and shadows require complete foreground/counter selections
except for holes deliberately omitted in the same request. Inspect the result
carefully when removing a counter: this can change lettering or the meaning of
a logo.
Each request accepts at most 32 cleanup operations and 32 entries per
composition list; a selector contains 1 to 128 contour indices.

## Review the result before delivery

Call `image_vector_review` with the returned SVG filename. It renders the
actual saved SVG as native PNG image content for a visual LLM, without a browser
or an image generator. For a detail proof, use a source-pixel crop:

```json
{
  "name": "badge_v_example.svg",
  "max_edge": 1536,
  "crop": [500, 1300, 1100, 1100],
  "background": "#ffffff"
}
```

Replace the example filename and rectangle with those of the saved result.
Omit `crop` for the whole artwork. `max_edge` is 256 to 1536, default 768;
`background` accepts `#rrggbb` or `transparent`, default white. Review the full
art and several detail crops rather than shrinking all the details into one
thumbnail. A text-only LLM can prepare and measure vectors, but visual quality
still requires a person or a model that can inspect the returned image.

For a saved Studio trace, review also returns the library's saved `replay`
request so another agent can resume with the same source, settings and edits.
An SVG without that Studio trace record can return `replay:null`; inspect it
normally, but recover its source and make a fresh trace before choosing cleanup.
The returned proof image is for visual review, not a raster replacement for the
SVG deliverable.

The bounded CPU renderer supports Studio's generated path fills, compound
holes, user-space linear gradients and translations. It refuses unsupported
SVG markup, CSS, fonts, embedded rasters and external references instead of
silently omitting them. Elliptical arcs use a cubic approximation for the proof.
For an SVG containing other features, inspect it in a full vector editor or
browser rather than assuming this restricted proof is complete.

Render the actual SVG, not the original image, and check:

1. The whole logo at its expected display size, on both light and dark
   backgrounds when it will be transparent.
2. Crops at high zoom: circular edges, long icon curves, sharp tips, letter
   edges and holes, the thinnest gaps, gradient joins and shadow alignment.
3. An overlay or side-by-side comparison with the source. Confirm that any
   deliberate movement is acceptable and that the identity of the artwork,
   exact lettering, spacing and waveform are retained.
4. The saved SVG itself: readable XML, a correct viewBox, paths and gradients,
   no embedded raster standing in for the artwork, no required external font,
   no script, and no unexpected opaque background.

Geometry measurements catch broken topology and large errors. They do not
prove polished curves: a wobbly outline can have excellent raster overlap.
Do not describe an SVG as finished because tests passed or its IoU is high.
Keep the original, the chosen settings, cleanup selections and a zoom proof
with the final deliverable so a later agent can reproduce and review the work.

The finished AiDIY badge followed this process: a concentric border, a straight
divider, separate treatment of long icon curves and original outlined glyphs,
four explicit gradients and shadows copied from the cleaned shapes. Some
regions needed prepared masks and local decisions. That example demonstrates
the workflow; it does not establish that every arbitrary raster becomes a
finished logo in one call.

## Where Qwen can help

When the original is ambiguous, an installed image-edit model can propose a
local raster repair. Use Studio's existing `image_ai_edit_create` review
workflow, inspect the candidate, and accept it only if it improves the intended
region. A frozen inpaint mask preserves pixels outside the selected region.
Keep original lettering and other protected details outside it, or composite
them back from the approved source.

Then vectorize the reviewed candidate and repeat the geometry and zoom checks.
The image model does not promise exact letterforms, faithful logo geometry or
brand identity. Vector cleanup itself runs on CPU and uses no image model,
automatic model downloads or cloud calls.

## Runtime and practical limits

The image runtime needs Python with Pillow, NumPy, SciPy and OpenCV. Tracing
uses at most a 4096-pixel working dimension; sources are capped at 40 megapixels
and 16384 pixels per side. The server bounds input size, processing time,
diagnostic output and exported SVG size, gives every run a unique output name,
and writes atomically. Complex photographic detail may hit contour or segment
limits. Use an appropriate posterized style or simpler source rather than
promising a lossless conversion.

Further references: [MCP workflows](MCP_WORKFLOWS.md),
[image editing contract](IMAGE_SPEC.md), and [local API](../API.md).
