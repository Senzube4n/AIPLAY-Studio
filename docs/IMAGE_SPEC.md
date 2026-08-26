# The image editor — the contract

`server/imagetools.py` is the one place a committed pixel is decided. The
browser previews with CSS approximations; MCP and the UI both post the same job
here, so an agent and a person produce identical output. Nothing may fork that.

This document is what the pieces below agree on. It is binding.

---

## 1. The job

```jsonc
{
  "in": "<abs path>", "out": "<abs path>",
  "thumbOut": "<abs path>|null", "thumbSize": 256,
  "ops": { ... }                       // everything below lives in here
}
```

One JSON line back: `{ ok, out, width, height, ... }`, or
`{ ok: false, error }` and exit 1.

## 2. Pipeline order — FIXED

An op is skipped when absent. The order is not negotiable, because two of these
are destructive to coordinates and everything after them would land in the
wrong place:

1. **`canvas`** — canvasSize / trim (changes the frame, not the content)
2. **`crop`**
3. **`geometry`** — rotate / flipH / flipV / perspective / smartResize
4. **`selection`** is RESOLVED here, in post-geometry pixel coordinates
5. **`adjust`** — the 25 existing tone/colour ops
6. **`effects`** — the shared effect registry
7. **`strokes`** — brush-class tools, in the order given
8. **`shapes`** — vector primitives drawn on top
9. **`text`**
10. **`resize`** (output scaling, last so nothing is resampled twice)

## 3. Selection — the multiplier

A selection is a float32 (H, W) mask, 0..1. **Every op in stages 5-8 honours
it**: the op computes its full result, then blends
`result * m + original * (1 - m)`. That is the whole rule, and it is why one
implementation makes all 25 adjustments and all 87 effects local.

```jsonc
"selection": {
  "shapes": [                          // combined in order
    { "kind": "rect",    "x": 0, "y": 0, "w": 100, "h": 100 },
    { "kind": "ellipse", "cx": 0, "cy": 0, "rx": 50, "ry": 30 },
    { "kind": "polygon", "points": [[x, y]] },            // lasso, closed
    { "kind": "wand",    "x": 10, "y": 20, "tolerance": 32, "contiguous": true },
    { "kind": "colorRange", "color": [r, g, b], "tolerance": 32, "softness": 8 }
  ],
  "mode": "add",                       // per shape: add | subtract | intersect
  "feather": 0,                        // px, gaussian
  "invert": false,
  "expand": 0,                         // px; negative contracts
  "antialias": true
}
```

`wand` and `colorRange` sample the image AS IT IS AT STAGE 4 — after geometry,
before any adjustment. Say so in the error if a wand seed lands out of bounds.

**No selection means a mask of all ones.** Implement it that way rather than
branching, so the "no selection" path is the same code and cannot drift.

## 4. Effects — the shared registry

`server/vfx/effects.py` holds 87 effects in eleven groups, already operating on
float32 (H, W, 4) 0..1 straight-alpha RGBA. That is exactly what a PIL RGBA
image becomes under `np.asarray(im).astype(np.float32) / 255.0`.

```jsonc
"effects": [ { "type": "fractalNoise", "params": { "scale": 40 } } ]
```

Applied in order, each honouring the selection. **Do not reimplement or fork a
single effect.** Import the registry. If it is unavailable, effects are a no-op
and every other stage still renders — the rule the compositor already uses.

An image has no timeline, so an effect that reads frame history (echo,
timeDifference) or declares `snapsTime` has nothing to work with. Pass a ctx
whose history is empty and let those return their input; do NOT hide them from
the catalog, because a caller asking for one deserves an honest no-op rather
than "no such effect".

## 5. Strokes — the brush class

The one genuinely new contract. A stroke arrives as a path in image pixels and
the server rasterises it. The client never sends pixels.

```jsonc
"strokes": [{
  "tool": "brush",                     // brush | eraser | clone | heal | smudge
                                       // blur | sharpen | dodge | burn | sponge
                                       // bucket | gradient
  "points": [[x, y, pressure]],        // pressure 0..1, optional, default 1
  "size": 24, "hardness": 0.5, "opacity": 1.0, "flow": 1.0,
  "color": [r, g, b, a],               // brush / bucket / gradient — 0-255
  "source": [x, y],                    // clone / heal: where the sample comes from
  "amount": 0.5,                       // smudge / dodge / burn / sponge strength
  "spacing": 0.25                      // of size, between stamps along the path
}]
```

Rules that decide whether this reads as a real brush:

- **Stamp along the path at `spacing * size`, interpolating between points.** A
  polyline drawn as line segments looks like a pen, not a brush.
- **Hardness is the falloff curve of the stamp**, not a binary edge.
- **Flow accumulates within one stroke; opacity caps it.** Two passes of a 50%
  flow brush are darker than one; two passes at 50% opacity are not.
- Clone/heal offset is fixed at stroke start: `source - points[0]`.
- Heal matches the destination's low-frequency content and keeps the source's
  detail. A clone that merely blends is not a heal and must not claim to be.

## 6. Shapes

```jsonc
"shapes": [{
  "kind": "rect",                      // rect | ellipse | line | polygon | arrow
  "points": [[x, y]], "radius": 0,
  "fill": [r, g, b, a], "stroke": [r, g, b, a], "strokeWidth": 2,
  "blend": "normal"
}]
```

Antialiased. A shape with neither fill nor stroke is an error, not a no-op.

## 7. Canvas and geometry

```jsonc
"canvas": {
  "width": 1920, "height": 1080,       // canvas size — CHANGES THE FRAME
  "anchor": "center",                  // center | topleft | top | ... | bottomright
  "background": [r, g, b, a],          // default transparent
  "trim": "transparent"                // transparent | borders | null
},
"geometry": {
  "rotate": 12.5,                      // ARBITRARY degrees, not just multiples of 90
  "expand": true,                      // grow the frame to fit the rotation
  "flipH": false, "flipV": false,
  "perspective": [[x, y]],             // destination quad (4 points), free transform
  "smartResize": { "width": 800, "height": 600 }   // seam carving
}
```

`rotate` today accepts only 0/90/180/270. Arbitrary angles with a clean
antialiased edge are the requirement.

## 8. Files and ownership

| File | Owner | Contents |
|---|---|---|
| `server/imagetools.py` | Engine | the pipeline, and stages 1-4, 9-10 |
| `server/imgselect.py` | Select | selection masks — §3 |
| `server/imgstroke.py` | Stroke | the brush class — §5 |
| `server/imgshape.py` | Shape | shapes and geometry — §6, §7 |
| `server/index.js` | Integrator | routes |
| `server/mcp.js` | Integrator | MCP tools |
| `web/app.js`, `web/styles.css` | UI | the console |

**Nobody edits outside their column.** Each module exposes pure functions
taking and returning float32 (H, W, 4) 0..1 RGBA, plus a `CATALOG` describing
its parameters the way `effects.py` does — that catalog generates both the UI
and the MCP schema, so a sloppy entry is a sloppy tool.

## 9. What this codebase gets wrong, every time

Read this before writing anything. Every one of these SHIPPED, and not one of
them raised an error:

- **A module nobody calls.** Finishing is not "the function works"; it is
  "something in another column calls it, and a test asserts the result through
  that path".
- **Rebuilding an object from a key list**, silently dropping whatever is not on
  the list. It has cost this codebase five separate features.
- **A schema that accepts a parameter the code then ignores.** Worse than a
  refusal, because a schema is exactly what a caller trusts.
- **Colours are 0-255 everywhere.** A 0-1 triple is a legal near-black colour,
  so it draws perfectly, the alpha is identical, every pixel-counting test
  passes, and only the picture is wrong.
- **A test only locks in what its author already believed.** Assert against the
  other side's source, never your memory of it.
