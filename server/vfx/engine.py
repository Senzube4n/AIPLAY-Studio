"""The VFX compositor — the one place comp.json becomes pixels.

The browser never renders the final frame; it asks for one. So does MCP, so does
the render queue. Everything below is reachable from a single CLI so there is
exactly one implementation of "what does this comp look like at t":

  python server/vfx/engine.py frame  <job.json>    one PNG at a time
  python server/vfx/engine.py render <job.json>    a movie or a frame sequence
  python server/vfx/engine.py probe  <job.json>    what a source actually is
  python server/vfx/engine.py serve                the same three, over stdin

One JSON line to stdout per invocation (render also emits progress lines first);
any failure is {"ok": false, "error": "..."} and exit 1, so the node side can
treat a crash and a refusal identically.

`serve` exists because the first three pay ~400 ms of interpreter startup and
numpy/PIL/cv2/PyAV imports PER INVOCATION, which on a scrub is more time spent
starting python than compositing — and because every cache in this file dies
with the process, so a one-frame invocation fills them and throws them away. It
reads {"id":…, "cmd":…, "job":{…}} a line at a time and answers a line at a
time; see serve() for what a process that outlives a frame has to be careful
about.

Sources arriving here are ABSOLUTE paths — the route resolves library names, and
this process never gets to pick a file off disk on its own.

Pixel contract, everywhere inside: float32, (H, W, 4), 0..1, STRAIGHT
(un-premultiplied) alpha. Premultiplying happens only where the maths demands it
— resampling and averaging — and is undone immediately after, because effects
and the blend formulas below are all written against straight alpha.

Layer order is AE's: layers[0] is the TOP of the stack, so the paint loop walks
the list backwards.

────────────────────────────────────────────────────────────────────────────────
BEYOND docs/VFX_SPEC.md — the spec is behind the code from here down. Everything
in this section is ADDITIVE: a document that uses none of it renders exactly as
it did before, byte for byte.

NESTED PRECOMPS  layer type "comp".
    { "type": "comp", "src": "<slug of another comp>", "collapse": false }
  The child document is looked up in the ROOT comp's library and rendered at the
  mapped source time; the result is the layer's pixels, so effects, masks, styles,
  mattes, blending, 3D and motion blur all apply to it exactly as they do to a
  video. The library rides on the document:
    { …comp…, "comps": { "<slug>": { …a full comp document… }, … } }
  (a list of documents is accepted too, keyed by their own slug), or a layer may
  carry the whole child inline as "comp": { … }. Resolving slugs to documents is
  the route's job, the same way it resolves library names to absolute paths.
  A comp that reaches itself raises — by name and with the path that closed the
  loop — and nesting deeper than MAX_COMP_DEPTH raises too, so a bad document
  fails on frame one instead of eating the machine.
  "collapse": true is AE's collapse-transformations, in the only sense that falls
  out cheaply here: CONTINUOUS RASTERISATION. The child is rendered at the
  resolution the layer's own transform will actually display it at, so a precomp
  blown up 300% stays sharp instead of showing the 100% raster's pixels. What it
  is NOT: the child's blend modes and 3D layers do not propagate into this comp's
  stack — that needs the child's layers spliced into the parent's paint loop with
  the parent's transform folded in, which reaches into mattes, ROI and the 3D
  depth sort all at once, and is a rewrite rather than a flag. Matching AE, the
  switch is ignored on a layer that carries effects, masks or a track matte
  (those force a raster at comp size), and in draft.
  It is not free and the bill is quadratic: the child is rendered at MAX_COLLAPSE
  times its own size at worst, which is 16x the pixels. Measured at 1080p, a
  precomp scaled 250% went from 181 ms to 1002 ms. That is the trade the flag
  exists to offer, not a regression — but it is why draft turns it off.

3D LAYERS       "threeD": true, per layer, opt-in. A 2D layer never touches any
  of this code and is bit-identical to before.
    "transform": { "anchor": [x, y, z], "position": [x, y, z],
                   "scale": [x, y, z],  "rotation": deg,          // = rotationZ
                   "rotationX": deg, "rotationY": deg, "rotationZ": deg }
  Third components are optional (anchor/position z default 0, scale z 100), so a
  2D transform promoted with one flag keeps its geometry. ROTATION ONLY — there
  is no separate orientation triple: AE's split exists to let you animate a spin
  on top of a fixed pose, and one set of three angles says everything two sets
  say. `rotation` stays the Z alias so an existing spin survives the promotion.
  Composition order is Rx·Ry·Rz — Z turns first, then Y, then X.
  A planar layer stays planar under perspective, so the projection is exact: the
  four corners go through the camera and cv2.warpPerspective does the rest.

AUTO-ORIENT     "autoOrient": "alongPath", per layer, opt-in — AE's switch, and
  like AE's it is NOT animatable. The layer turns to face along its position
  track's motion: the derivative of the ACTUAL interpolated path (central
  difference, interp.auto_orient_velocity — bezier tangents, roving keys and
  expressions all included), with the layer's own rotation composed ON TOP as
  an offset. Moving along +x is upright at 0; moving down is +90 (y-down,
  clockwise, the convention rotation already turns in). A hold segment keeps
  the orientation of the layer's last motion; before the first key the layer
  already faces the way it will leave. 2D adds the angle to `rotation`; 3D
  multiplies a right-handed basis (local +x along the 3D tangent, roll fixed
  by the comp plane's normal) outside Rx·Ry·Rz, so a planar 3D move matches
  the 2D result exactly. "towardCamera" is NOT implemented: these matrices are
  built before a frame has picked its camera (a camera's own parent chain, the
  light rig), and a billboard under a rotated parent needs that parent's
  rotation inverted back out — the routes refuse the value instead of
  rendering a wrong orientation silently.

CAMERA          layer type "camera", never painted, gone from the stack:
    { "type": "camera",
      "transform": { "position": [x, y, z], "rotationX/Y/Z": deg },
      "camera": { "pointOfInterest": [x, y, z],   // look-at; omit for free rotation
                  "zoom": px,                     // OR
                  "focalLength": 50,              // mm on 36mm film -> zoom
                  "depthOfField": false, "focusDistance": px,
                  "aperture": 25, "blurLevel": 100 } }
  The TOPMOST enabled camera whose time window covers t is the active one. With
  no camera layer the default is AE's: a 50mm lens (zoom = width·50/36) parked at
  the comp centre, z = -zoom, looking down +z — which makes the plane z = 0 land
  1:1, so turning a layer 3D and touching nothing moves nothing.
  Depth of field is a per-layer blur from the thin-lens circle of confusion at
  that layer's depth (a plane at one depth blurs uniformly, which is exactly
  right for a layer and only approximate for a layer tilted away from the
  sensor). It is EXPENSIVE and `draft` skips it.
  Painting order: 2D layers hold their place in the stack; each contiguous run of
  3D layers is sorted among itself, farthest from the camera painted first. That
  is AE's rule, and it is why a 2D layer between two 3D ones still divides them.

TEXT ANIMATORS  a text layer may carry per-character animation:
    "animators": [ { "properties": { "position": [x, y], "scale": [x, y],
                                     "rotation": deg, "opacity": 0-100,
                                     "tracking": px, "fillColor": [r,g,b,a],
                                     "blur": px | [x, y] },
                     "selector": { "type": "range", "start": 0, "end": 100,
                                   "offset": 0, "shape": "square|rampUp|rampDown|
                                   triangle|round|smooth",
                                   "easeHigh": 0, "easeLow": 0 } } ]
  start/end/offset are PERCENT of the character count, the unit AE defaults to.
  Every one of those numbers is a normal animatable property, so keyframing
  `selector.offset` from -100 to 100 is the typewriter, the cascade and the
  per-letter bounce — that is the whole point of the feature.
  Several animators stack: their weighted contributions ADD.
  Characters are indexed in reading order across the whole string, newlines
  excluded. Each character transforms about the centre of its own advance box,
  half an ex above the baseline. `tracking` shifts every later character in the
  line and the line re-centres on its alignment.
  A text layer with no animators takes the old whole-line path and its cached
  raster, unchanged.

STENCILS        four AE transfer modes that reach through the WHOLE stack below,
  set on `blend` (they are blend modes in AE too):
    "stencilAlpha" | "stencilLuma" | "silhouetteAlpha" | "silhouetteLuma"
  A stencil keeps everything beneath only where the layer is; a silhouette cuts
  it there. The layer itself is never drawn. Unlike a track matte this is not
  one layer deep — it re-shapes the accumulated frame, so it is the last word for
  everything under it. They are NOT added to BLEND_MODES: that tuple is the set
  of colour-mixing modes and the UI drives a different control from it.
    "preserveTransparency": true   the T switch — the layer shows only where the
  accumulated frame beneath it already has alpha, and adds none of its own.

LAYER STYLES    first-class, not effects, and ordered the way AE orders them:
  after the effect stack and BEFORE the transform. Before the transform is what
  makes them read as part of the artwork rather than as a screen-space garnish:
  the style is drawn from the layer's own matte in the layer's own pixels, so it
  scales, rotates and skews WITH the layer — a drop shadow on a turning card
  turns with the card instead of staying pinned at 45 degrees on screen. Sizes
  are therefore layer pixels, and preview scale is applied to them so a half-size
  preview is a faithful half-size picture of the render.
    "styles": { "dropShadow":   { "enabled": true, "color": [0,0,0,255],
                                  "opacity": 55, "distance": 12, "angle": 45,
                                  "size": 10, "spread": 0 },
                "innerShadow":  { …same, plus "choke": 0 },
                "outerGlow":    { "color": …, "opacity": 60, "size": 16, "spread": 0 },
                "innerGlow":    { "color": …, "opacity": 60, "size": 16, "choke": 0 },
                "stroke":       { "color": …, "size": 4,
                                  "position": "outside|center|inside",
                                  "opacity": 100, "feather": 0 },
                "colorOverlay": { "color": …, "opacity": 100 } }
  Every value is animatable. Sizes are in COMP pixels and scale with the preview.
  dropShadow, outerGlow and stroke are effects.py's own maths (a PS outer glow is
  a drop shadow thrown zero distance, which is what it delegates to); the three
  inside-the-matte styles have no equivalent there and are implemented below.
  Composite order, bottom of the visual stack up, is Photoshop's:
  colorOverlay, innerGlow, innerShadow, stroke, outerGlow, dropShadow.
  Styles draw on the layer's OWN bitmap, so an outside style is clipped at the
  layer's bounds the same way effects.py's dropShadow is — AE grows the bounds
  and this does not. It shows on a small image layer with a long shadow and
  nowhere else, and fixing it means every layer carrying a margin through the
  whole effect stack, which costs every layer to help a few.

TIME REMAPPING  "timeRemap": { "keys": [ {"t": 0, "v": 0}, … ] } — the value is
  SOURCE time in seconds. When present it replaces the inPoint/timeScale rule
  outright, for video and for nested comps. It reads through interp's dedicated
  evaluator, eval_time_remap, so it eases, roves and takes an expression like any
  other property — including an expression with no keys under it at all.

EXPRESSIONS     any property may carry "expr", a line of AE-flavoured JavaScript
  that computes it: { "value": 65, "expr": "value * 2" }. expressions.py owns the
  sandbox; this file owns the WIRING, which is one ExprEnv per rendered frame
  hung on the CompCtx and a binding threaded to every property read. See the
  "expressions" section below for why the PATH each property binds under is load-
  bearing rather than cosmetic. A comp with no "expr" anywhere renders exactly as
  it did before, and so does one whose expressions are all broken: a refusal is a
  line on stderr and the property falls back to its keyframes.

FRAME BLENDING  "frameBlend": "off" | "mix" on a video layer. Retimed footage
  lands between two source frames; frame mix crossfades them by the fraction
  instead of snapping. Costs a second decode per frame, so `draft` skips it.

LINEAR LIGHT    "linearLight": true, on the COMP, INHERITED BY ITS PRECOMPS.
  The field has three states and the third one matters: absent (or null) means
  INHERIT — take the parent comp's answer, and OFF at the top of the tree, which
  is every document written before the field existed. true and false are
  EXPLICIT and a parent cannot overrule them, so a precomp tuned in gamma keeps
  rendering in gamma inside a linear parent. Default false on a new comp.
  Every number in this file is 0..1 and, without this, none of them says what
  it means: they are sRGB CODE values, so 0.5 is 21.4% of the light rather than
  half of it. Curves,
  levels and hue want it that way — their controls are drawn against codes. The
  operations that AVERAGE OR ADD light do not, and get the mid-tones wrong when
  they run on codes: a 50/50 mix of black and white is code 128 in gamma and 188
  in linear, and 188 is what a defocused photograph of that edge produces.
  With the switch on, sRGB is decoded to linear (colour.py, the piecewise
  IEC 61966-2-1 curve) around exactly three things, each chosen by measurement
  and each listed with its numbers where it happens:
    * the blur and glow family — effects.LINEAR_LIGHT, and _apply_effects hoists
      one conversion out of each contiguous RUN of them so a stack pays once.
      Their CODE-SPACE PARAMETERS convert with them (effects.LINEAR_PARAMS —
      glow's picked colour and its threshold/softness), or the switch would
      change what a person chose rather than only how light is summed;
    * the `add` and `screen` blend modes — LINEAR_BLENDS, in _blend_rgb. NOT
      lighten or darken, which are provably identical in both spaces (max and
      min commute with a monotone transfer), and not the code-space operators
      (overlay, softlight, difference);
    * lights.py's diffuse multiply and specular add, which is the one place the
      arithmetic was plainly wrong rather than a different look.
  ALPHA NEVER GOES THROUGH THE CURVE, and neither does premultiplied colour.
  Alpha is coverage, an area, and decode(C·a) would put a display curve through
  the product of a colour and an area. So STRAIGHT colour is what converts,
  which leaves the premultiply/unpremultiply the effects already do INSIDE the
  linear pass — where C·a is a light value weighted by the fraction of the pixel
  it covers, which is exactly what a kernel should be averaging. No effect body
  changed.
  WHAT IT DOES NOT REACH: the OVER composite and the opacity lerp. Those are the
  compositor, they are in every render this product has ever made, and moving
  them is a different change. So an additive layer at PARTIAL opacity is PARTLY
  corrected: it moves half as far at 50% opacity, while the error against a
  fully linear pipeline falls from 21.62 codes to 13.58 over the eight colour
  pairs engine_test measures — a third of it for that sample, not a constant —
  and on 6 of their 24 channels it grows. See _mix_blend, and engine_test,
  which prints all of it. It also has nothing to do with HDR, wide gamut,
  ACES, LUTs or display transforms, and reads no colour profile off any source.
  It costs 110 ms on a 1080p frame per converted run — about 1.2 glows, since
  the conversion runs over four channels and a glow does not.
  `draft` does NOT turn it off, and that is deliberate: everything draft drops
  today (depth of field, shadows, frame blending, continuous rasterisation) is
  something a person can SEE is missing, so the preview reads as a preview. A
  colour space is invisible and everywhere. A draft that quietly reverted it
  would show a picture indistinguishable from the real one and not be it, which
  is the failure this whole tab's "the browser never renders the frame" rule
  exists to prevent.
  A comp without the field renders byte for byte as it did before — at the top
  of the tree, and inside any parent that has not turned the switch on.

COLOUR TAGS     unconditional, and not part of the switch above. Rendered movies
  carry color_primaries / color_trc / colorspace (_tag_colour) because the
  pixels have always been sRGB/Rec.709 and an untagged file is not neutral — it
  is a guess made by whichever player opens it.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from collections import OrderedDict, namedtuple
from fractions import Fraction

import av
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVER = os.path.dirname(_HERE)
if _SERVER not in sys.path:
    sys.path.insert(0, _SERVER)

import imagetools  # noqa: E402  — the blend maths lives there; do not fork it

try:
    from . import interp
except ImportError:                                   # run as a bare script
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    import interp  # type: ignore  # noqa: F401

# colour.py is NOT optional the way effects/lights/shapes are. It is numpy and
# cv2 and eighty lines of arithmetic — the same dependencies this file already
# has — and the container tags below name its constants, so a comp with the
# switch off still reads from it.
try:
    from . import colour
except ImportError:                                   # run as a bare script
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    import colour  # type: ignore  # noqa: F401

# effects.py is a separate deliverable and may legitimately not be here yet (or
# may fail to import on a half-written edit). A comp still has to render — a
# missing registry means "no effects", not "no frame".
try:
    from . import effects
except Exception:                                     # noqa: BLE001
    try:
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        import effects  # type: ignore
    except Exception:                                 # noqa: BLE001
        effects = None

# lights.py is optional in the same way: a missing module must cost the
# LIGHTING, never the frame. rig() returns None when a comp has no light
# layers, so a 2D comp pays nothing for this beyond the import.
try:
    from . import lights
except Exception:                                     # noqa: BLE001
    try:
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        import lights  # type: ignore
    except Exception:                                 # noqa: BLE001
        lights = None

# shapes.py is the same kind of separate deliverable as effects.py, and gets
# the same treatment: if it is absent or mid-edit, shape layers draw nothing
# and every other layer in the comp still renders.
try:
    from . import shapes
except Exception:                                     # noqa: BLE001
    try:
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        import shapes  # type: ignore
    except Exception:                                 # noqa: BLE001
        shapes = None

# expressions.py gets the same treatment again, and for a stronger reason than
# either of the two above: a missing registry costs you effects, a missing
# evaluator must cost you nothing at all. Every property here reads through
# interp.eval_prop's optional ctx, and no ctx is exactly the behaviour this file
# had before any of this — so `expressions = None` means every "expr" field goes
# back to being decoration and the frame still comes out.
try:
    from . import expressions
except Exception:                                     # noqa: BLE001
    try:
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        import expressions  # type: ignore
    except Exception:                                 # noqa: BLE001
        expressions = None

EPS = 1e-6
Tile = namedtuple("Tile", "rgba x y")     # a layer's pixels plus where they land

MAX_HISTORY = 16                          # frames an echo-style effect may ask for
MAX_COMP_DEPTH = 8                        # a precomp inside a precomp inside...
MAX_COLLAPSE = 4.0                        # continuous rasterisation stops here

# The default camera, and the units a focal length is quoted in. AE measures a
# comp's film back by its WIDTH, so a 50mm lens on 36mm film is the same angle of
# view whatever the comp's aspect — which is why zoom falls straight out of the
# width and there is no height term anywhere in the projection.
FILM_MM = 36.0
DEFAULT_FOCAL_MM = 50.0
NEAR = 1e-3                               # camera-space z a layer must be beyond

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
FONT_DIRS = [r"C:\Windows\Fonts",
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")]


# ── expressions ───────────────────────────────────────────────────────────────
#
# One ExprEnv per rendered frame, carried on the CompCtx because that is already
# the thing scoped to "one comp document, one render pass" — and a nested comp
# needs its OWN env, since `thisComp` in a child must mean the child.
#
# Every property read below turns into `_bind(cctx, layer, "<path>")` as
# eval_prop's fourth argument. The path is not a label. expressions.py keys the
# cycle guard on (layer id, path) and draws wiggle's seed from it, and a link
# from another layer arrives spelled the way TransformRef/EffectRef spell it —
# "transform.position", "effects.fx_1.radius". Bind a property under a different
# name and nothing errors: the render is just quietly wrong, with a cycle that no
# longer closes and a wiggle that no longer matches the property it belongs to.


def _new_env(comp):
    """The expression environment for one frame of one comp, or None."""
    if expressions is None:
        return None
    # `seed` is a document-level salt so a wiggle can be re-rolled without
    # editing forty expressions; absent, it is 0 and the render is reproducible.
    return expressions.ExprEnv(comp, seed=(comp.get("seed") if isinstance(comp, dict) else 0) or 0)


def _env(cctx):
    return getattr(cctx, "env", None) if cctx is not None else None


def _bind(cctx, layer, path):
    """The binding for one property, or None — which means "no expressions"."""
    env = _env(cctx)
    return env.bind(layer, path) if env is not None else None


def _at_of(ctx):
    """`ctx.at`, or a function that yields None — so a caller reading six rows off
    one binding does not need six `if ctx is not None` of its own."""
    return ctx.at if ctx is not None else (lambda _name: None)


def _binder(cctx, path):
    """A per-LAYER binder for the walkers that climb a parent chain.

    Callable rather than a binding for the same reason `defaults` is: each
    ancestor needs its own, or a parent's wiggle inherits the child's seed.
    """
    env = _env(cctx)
    if env is None:
        return None
    return lambda lay: env.bind(lay, path)


def _expr_props(node, path, out):
    """Index every property in a subtree that actually carries an expression, by
    the identity of the dict, against the path a reader would name it by."""
    if isinstance(node, dict):
        if "keys" in node or "expr" in node:
            if "expr" in node:
                out[id(node)] = (node, path)
            return                                     # a property is a leaf
        for k, v in node.items():
            _expr_props(v, path + "." + str(k), out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _expr_props(v, "%s.%d" % (path, i), out)


def _shape_evaluator(cctx, layer):
    """The `eval_prop` shapes.py is handed, with expressions turned on.

    shapes.py takes a two-argument f(prop, t) and hands it raw property objects
    with no idea which item they came from, so the path cannot be threaded down
    the way it is everywhere else — and it should not have to be: the callable is
    the seam that keeps shapes.py from importing the interpolator at all.
    So the tree is indexed by dict IDENTITY once per layer per frame and the
    lookup happens on the way past. Two properties in one shape layer therefore
    get two seeds, which is the whole reason not to bind them all as "shapes".
    Identity is safe here because the document outlives the render that reads it.
    """
    env = _env(cctx)
    if env is None:
        return interp.eval_prop
    found = {}
    _expr_props(layer.get("shapes"), "shapes", found)
    if not found:
        # Nothing to turn on: hand back the plain evaluator so a shape layer
        # without expressions is the same call it always was.
        return interp.eval_prop

    def ev(prop, t):
        hit = found.get(id(prop))
        ctx = env.bind(layer, hit[1]) if hit is not None and hit[0] is prop else None
        return interp.eval_prop(prop, t, None, ctx)
    return ev


def _f(v, fallback=0.0):
    """A scalar out of anything a document might hold, including a stray pair."""
    if isinstance(v, (list, tuple)):
        v = v[0] if v else fallback
    try:
        f = float(v)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


def _rgba01(color, fallback=(0.0, 0.0, 0.0, 0.0)):
    """A [r,g,b,a] 0-255 document colour as float 0..1, alpha optional."""
    if not isinstance(color, (list, tuple)) or not color:
        return fallback
    vals = [_f(c) / 255.0 for c in list(color)[:4]]
    while len(vals) < 4:
        vals.append(1.0)
    return tuple(min(1.0, max(0.0, v)) for v in vals)


def _triple(v, fallback=(0.0, 0.0, 0.0)):
    """An [x, y, z] out of a document value that may only have written [x, y].

    Every 3D property in the document is the 2D one with a third number added, so
    a short value takes its missing components from the fallback — which is how a
    2D transform reads as a 3D transform with z = 0 and scale z = 100 without the
    document being rewritten.
    """
    if isinstance(v, (list, tuple)):
        out = [_f(x, fallback[i] if i < 3 else 0.0) for i, x in enumerate(list(v)[:3])]
        while len(out) < 3:
            out.append(fallback[len(out)])
        return tuple(out)
    if isinstance(v, (int, float)):
        return (_f(v, fallback[0]), fallback[1], fallback[2])
    return tuple(fallback)


# ── linear light ──────────────────────────────────────────────────────────────
#
# `"linearLight": true` on the comp document. Off is the whole of this file's
# previous behaviour, bit for bit; see the LINEAR LIGHT section in the header
# for what it does and what it deliberately does not.


def _linear_light(comp, cctx=None):
    """The comp's resolved linear-light setting — its own, or its parent's.

    THREE STATES IN ONE FIELD, and the third one is the fix for a real hole: a
    parent with the switch ON containing a precomp rendered identically to the
    child alone with it off, because the flag was read off whichever document
    was in hand. The spec and the setting's description both said "every frame
    of this comp", and a precomp's frames are every bit as much this comp's.

        absent / null   INHERIT. Take the parent's answer; at the top of the
                        tree there is no parent and the answer is OFF, which is
                        every document written before the field existed and
                        every render this product has ever made.
        true / false    EXPLICIT. This comp says so, and a parent cannot
                        overrule it — a precomp built and tuned in gamma keeps
                        rendering in gamma inside a linear parent, which is the
                        only way to nest artwork somebody has already approved.

    So the flag is not "per document" (the hole) and not "the root wins" (which
    would silently re-render approved artwork). It is CSS's rule and AE's rule
    for the same kind of setting: inherit unless you said otherwise.
    """
    if isinstance(comp, dict):
        own = comp.get("linearLight")
        if own is not None:
            return bool(own)
    return bool(getattr(cctx, "linear", None))


# The blend modes the switch moves, and the ONLY ones. Two lists, both short,
# both measured — see the header. `add` and `screen` are two sources of light
# arriving at one place, so they belong in linear; nothing else on the menu is.
LINEAR_BLENDS = frozenset({"add", "screen"})


# ── blending ──────────────────────────────────────────────────────────────────

# imagetools._blend owns normal/multiply/screen/overlay/softlight/add/subtract/
# difference/darken/lighten. The rest of the spec's list is not there and adding
# it would mean editing a file this engine does not own, so the remainder lives
# here — same maths, W3C compositing-1, just a different house.
_EXTRA_MODES = ("hardlight", "colordodge", "colorburn",
                "hue", "saturation", "color", "luminosity")

_LUMA_W = np.array([0.30, 0.59, 0.11], dtype=np.float32)


# ── planar arithmetic ─────────────────────────────────────────────────────────
#
# Everything below works on separate contiguous (H, W) planes rather than on
# `rgba[..., :3]`, and that is not a style preference. An interleaved RGBA array
# sliced to its colour channels is a three-element inner loop with stride 4, and
# the alpha it is nearly always paired with is that same loop with stride 0:
# numpy can collapse neither, so the ufunc walks the frame one scalar at a time.
# Measured at 1280x720, float32:
#
#   rgba[..., :3] *= rgba[..., 3:4]        15.8 ms      <- ONE multiply
#   the same arithmetic on planes           0.07 ms
#   c.min(axis=-1, keepdims=True)          25.2 ms      <- reductions are worse
#   np.minimum(np.minimum(r, g), b)         1.15 ms
#
# De-interleaving costs about 3.5 ms a frame and interleaving 3 ms, so the split
# repays itself the moment a formula has more than about a dozen terms — and the
# blend modes have thirty. Allocation is the other half of the bill: a fresh
# 1280x720 plane costs 0.47 ms to first-touch against 0.07 ms to compute into,
# so temporaries are borrowed from a pool and written through `out=`.
#
# NOTHING here changes a pixel. Each plane's expression is the same sequence of
# float32 operations on the same operands the interleaved form performed, so the
# results are bit-identical rather than merely close — which is what lets this
# rewrite be checked by hashing frames instead of by eyeballing them.

_SCRATCH = OrderedDict()                  # (h, w) -> list of idle float32 planes
_SCRATCH_BYTES = 0
_SCRATCH_LIMIT = int(os.environ.get("VFX_SCRATCH_MB", "128")) * 1024 * 1024


class _Planes:
    """Borrowed (H, W) float32 planes, handed back when the `with` block ends.

    A compositing pass wants its temporaries in exactly the same shapes on every
    frame of a render, so making and dropping them is pure waste: the first
    touch of a 3.7 MB plane costs seven times what the arithmetic written into
    it costs. Borrowed planes hold GARBAGE — they are only ever safe as an
    `out=` target or a `copyto` destination, never as something to accumulate
    into unseeded.
    """

    __slots__ = ("_held",)

    def __init__(self):
        self._held = []

    def plane(self, shape):
        global _SCRATCH_BYTES
        free = _SCRATCH.get(shape)
        if free:
            buf = free.pop()
            _SCRATCH_BYTES -= buf.nbytes
        else:
            buf = np.empty(shape, dtype=np.float32)
        self._held.append(buf)
        return buf

    def like(self, plane):
        return self.plane(plane.shape)

    def split(self, rgba, n=4):
        """An interleaved (H, W, 4) as `n` contiguous planes."""
        shape = rgba.shape[:2]
        out = []
        for c in range(n):
            p = self.plane(shape)
            np.copyto(p, rgba[..., c])
            out.append(p)
        return out

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        global _SCRATCH_BYTES
        for buf in self._held:
            _SCRATCH.setdefault(buf.shape, []).append(buf)
            _SCRATCH.move_to_end(buf.shape)
            _SCRATCH_BYTES += buf.nbytes
        del self._held[:]
        # A render walks many tile shapes and each would otherwise keep its
        # bucket forever. Evict whole least-recently-used shapes: whatever the
        # next frame is about to reuse is by definition the most recent one.
        while _SCRATCH_BYTES > _SCRATCH_LIMIT and _SCRATCH:
            _shape, bucket = _SCRATCH.popitem(last=False)
            _SCRATCH_BYTES -= sum(b.nbytes for b in bucket)
        return False


def _lum(c, sc=None, out=None):
    """(c * _LUMA_W).sum(axis=-1) — the weighted grey of three planes.

    An interleaved (H, W, 3) is accepted too and answered in kind. That is the
    shape anything outside this file naturally holds, and the shape the
    integration suite pins the gamut clip on; it is not the fast path and is not
    meant to be.
    """
    if isinstance(c, np.ndarray):
        with _Planes() as s2:
            return _lum(s2.split(c, 3), s2)[..., None].copy()
    out = sc.like(c[0]) if out is None else out
    np.multiply(c[0], _LUMA_W[0], out=out)
    # numpy seeds a reduction at +0.0, so a pixel whose three weighted channels
    # are all -0.0 comes back +0.0 from sum() where a bare chain of adds gives
    # -0.0. Nobody will ever see the difference; it is here so that "the frames
    # hash identically" stays a true statement rather than an almost-true one.
    out += 0.0
    t = sc.like(out)
    np.multiply(c[1], _LUMA_W[1], out=t)
    out += t
    np.multiply(c[2], _LUMA_W[2], out=t)
    out += t
    return out


def _cmin(c, sc):
    out = sc.like(c[0])
    np.minimum(c[0], c[1], out=out)
    return np.minimum(out, c[2], out=out)


def _cmax(c, sc):
    out = sc.like(c[0])
    np.maximum(c[0], c[1], out=out)
    return np.maximum(out, c[2], out=out)


def _clip_color(c, sc=None):
    """Pull a colour back inside the cube WITHOUT moving its luminance.

    Naive clipping after a luminance transfer shifts hue on anything saturated;
    scaling toward the luma grey keeps the tone the operation just set.

    Takes planes, or an interleaved (H, W, 3) — see _lum.
    """
    if isinstance(c, np.ndarray):
        with _Planes() as s2:
            return np.stack(_clip_color(s2.split(c, 3), s2), axis=-1)
    l = _lum(c, sc)
    n = _cmin(c, sc)
    x = _cmax(c, sc)
    # maximum, not minimum: l is a weighted MEAN of the channels, so l >= n
    # always and minimum(l - n, -EPS) was therefore always exactly -EPS.
    # Every out-of-gamut colour divided by -1e-6 — [-0.058,0.542,0.242]
    # came back as [127323,-70077,28623] instead of [0,0.510,0.255]. The
    # x > 1 branch below always had it right, which is what makes this a
    # sign slip rather than a misunderstanding.
    keep_lo = np.logical_not(n < 0)
    keep_hi = np.logical_not(x > 1)
    np.subtract(l, n, out=n)
    np.maximum(n, EPS, out=n)                        # n: the shadow-side divisor
    np.subtract(x, l, out=x)
    np.maximum(x, EPS, out=x)                        # x: the highlight divisor
    one_l = sc.like(l)
    np.subtract(1, l, out=one_l)
    out = []
    for k in range(3):
        p = sc.like(l)
        np.subtract(c[k], l, out=p)
        np.multiply(p, l, out=p)
        np.divide(p, n, out=p)
        np.add(l, p, out=p)
        np.copyto(p, c[k], where=keep_lo)
        q = sc.like(l)
        np.subtract(p, l, out=q)
        np.multiply(q, one_l, out=q)
        np.divide(q, x, out=q)
        np.add(l, q, out=q)
        np.copyto(q, p, where=keep_hi)
        out.append(q)
    return out


def _set_lum(c, l, sc):
    d = _lum(c, sc)
    np.subtract(l, d, out=d)
    out = []
    for k in range(3):
        p = sc.like(d)
        np.add(c[k], d, out=p)
        out.append(p)
    return _clip_color(out, sc)


def _set_sat(c, s, sc):
    mn = _cmin(c, sc)
    rng = _cmax(c, sc)
    np.subtract(rng, mn, out=rng)
    flat = np.logical_not(rng > EPS)
    np.maximum(rng, EPS, out=rng)
    out = []
    for k in range(3):
        p = sc.like(rng)
        np.subtract(c[k], mn, out=p)
        np.multiply(p, s, out=p)
        np.divide(p, rng, out=p)
        np.copyto(p, 0.0, where=flat)
        out.append(p)
    return out


def _sat(c, sc):
    out = _cmax(c, sc)
    return np.subtract(out, _cmin(c, sc), out=out)


def _blend_extra(base, top, mode):
    """The three per-channel modes imagetools does not own."""
    if mode == "hardlight":
        return np.where(top <= 0.5, 2 * base * top, 1 - 2 * (1 - base) * (1 - top))
    if mode == "colordodge":
        return np.where(base <= EPS, 0.0,
                        np.where(top >= 1 - EPS, 1.0,
                                 np.minimum(1.0, base / np.maximum(1 - top, EPS))))
    return np.where(base >= 1 - EPS, 1.0,                        # colorburn
                    np.where(top <= EPS, 0.0,
                             1 - np.minimum(1.0, (1 - base) / np.maximum(top, EPS))))


def _blend_rgb(base, top, mode, sc, linear=False):
    """B(Cb, Cs) for every mode in the spec, on three float 0..1 planes.

    `linear` is the comp's switch, and it reaches exactly the two modes in
    LINEAR_BLENDS. add and screen are two sources of light landing on one pixel,
    which is an operation on light, so they are computed on decoded values and
    the ANSWER is encoded back.

    THE MEASUREMENT BELOW IS THE SWEEP, and it is not the one docs/VFX_SPEC.md
    §2.1 tabulates. Here: |B_gamma - B_linear| in codes over ALL 256x256 code
    pairs, one channel against one channel, which describes the OPERATOR. There:
    how far a rendered frame moves, on one named stimulus, which describes what
    a person would see. For add they read 25.91 / 80 and 38.2 / 49.5 — the
    second is one colour pair inside the first's distribution, above its mean,
    and neither is a summary of the other. mean/max codes:

        add       25.91 / 80      and 48.80 through the mid-tones alone
        screen    11.25 / 27      19.57 through the mid-tones
        multiply   2.46 /  8      left in gamma: it is the shadow-layer LOOK,
                                  its whole use is "darken by this much", and
                                  2.5 codes is not worth redefining the control
        lighten    0.00 /  0      EXACTLY zero, and darken too — max and min
        darken     0.00 /  0      COMMUTE with any monotone transfer, so a
                                  linear lighten is a gamma lighten at every
                                  pixel. In the set they would cost 100 ms to
                                  change nothing.
        overlay   28.19 / 119     gamma-domain BY DEFINITION: the pivot is code
        softlight                 0.5 and the curve is drawn against codes.
        difference 52.12 / 120    a difference of codes is what it says it is.

    So: nothing here is left in gamma out of caution. Each one is either a
    measured no-op or an operator whose definition lives in code space.
    """
    if linear and mode in LINEAR_BLENDS:
        lb = [colour.srgb_to_linear(base[k]) for k in range(3)]
        lt = [colour.srgb_to_linear(top[k]) for k in range(3)]
        # imagetools._blend, on light rather than on codes — the same one
        # implementation, which is the point of importing it at all.
        return [colour.linear_to_srgb(imagetools._blend(lb[k], lt[k], mode))
                for k in range(3)]
    if mode in _EXTRA_MODES:
        if mode == "hue":
            return _set_lum(_set_sat(top, _sat(base, sc), sc), _lum(base, sc), sc)
        if mode == "saturation":
            return _set_lum(_set_sat(base, _sat(top, sc), sc), _lum(base, sc), sc)
        if mode == "color":
            return _set_lum(top, _lum(base, sc), sc)
        if mode == "luminosity":
            return _set_lum(base, _lum(top, sc), sc)
        return [_blend_extra(base[k], top[k], mode) for k in range(3)]
    # imagetools._blend is elementwise in every mode it owns, so handing it one
    # plane at a time is the same arithmetic on a shape numpy can vectorise.
    return [imagetools._blend(base[k], top[k], mode) for k in range(3)]


BLEND_MODES = tuple(imagetools.BLEND_MODES) + _EXTRA_MODES

# Deliberately NOT folded into BLEND_MODES. AE lists these in the same dropdown,
# but they mix no colour at all — they re-shape the alpha of everything already
# painted beneath, which is a different operation reaching a different distance,
# and BLEND_MODES is what the UI's colour-mode picker and the blend maths above
# are built from.
STENCIL_MODES = ("stencilAlpha", "stencilLuma", "silhouetteAlpha", "silhouetteLuma")


def _opaque(alpha):
    """Whether every pixel is fully covered — worth one min() to find out.

    Most footage is: a decoded video frame, a JPEG plate, a full-bleed solid. The
    general straight-alpha maths below costs several full-frame temporaries and a
    divide that all collapse to nothing in that case, and a 1080p frame is half a
    million pixels of collapsing.
    """
    return float(alpha.min()) >= 1.0 - EPS


def _is_opaque(rgba):
    return _opaque(rgba[..., 3])


def _mix_blend(cs, cb, ab, mode, sc, linear=False):
    """`cs + ab * (clip(B(cb, cs)) - cs)` — the blend, weighted by the backdrop.

    A blend mode only applies where there IS something under it, which is the
    whole reason a comp's transparent background does not turn every multiply
    layer black. Written into fresh planes rather than over the blend's own,
    because an unrecognised mode name makes imagetools._blend hand `top` STRAIGHT
    back and clipping in place would then quietly rewrite the source.

    THE LERP STAYS IN GAMMA even when `linear` is on, and that is a limitation
    rather than an oversight. `ab` weights how much of the blend applies, and
    the same weighting by `a_s` in `_over` below is the OVER composite itself —
    the operation every layer in every comp goes through. Moving it moves every
    render there has ever been, which is a different and much larger change than
    this one. Measured, that lerp is itself wrong by 12.34 codes mean / 60 max
    at a 50% mix, so an ADDITIVE LAYER AT PARTIAL OPACITY is only PARTLY
    corrected by the switch — and partly is not half, which is what this
    docstring and the setting's description both used to imply. The picture
    MOVES half as far at 50% opacity.

    HOW MUCH OF THE ERROR THAT REMOVES IS PER-CHANNEL, and the figures below
    belong to one sample rather than to the operation. Over the eight colour
    pairs engine_test uses, measured against a fully linear pipeline, the mean
    error across their 24 channels falls from 21.62 codes to 13.58 — 37% of it
    FOR THAT SET, which is all "about a third, not a half" can mean; and 6 of
    those 24 channels land FURTHER out than leaving the switch off did, because
    two errors that were cancelling stop cancelling. Another eight pairs would
    give another fraction. What the test asserts, rather than prints, is the
    shape those numbers have: the fall is between a quarter and a half, and the
    count that gets worse is not zero. At full opacity there is no sample
    dependence left — every channel of every pair goes from 30.70 codes of
    error to 0.00 — and that is how an add or a screen is normally used.
    engine_test prints all of it on every run.
    """
    bl = _blend_rgb(cb, cs, mode, sc, linear)
    out = []
    for k in range(3):
        p = sc.like(cs[k])
        np.clip(bl[k], 0.0, 1.0, out=p)
        np.subtract(p, cs[k], out=p)
        np.multiply(p, ab, out=p)
        np.add(cs[k], p, out=p)
        out.append(p)
    return out


def _over(acc, tile, mode="normal", linear=False):
    """Composite one tile into the accumulator, W3C source-over with a blend.

    Not the simplified `dst*(1-a) + blend*a` the image compositor uses: that one
    assumes an opaque backdrop, and a comp's backdrop is transparent by default.
    Blending against nothing must yield the source itself, which is what the
    (1 - ab) term buys.
    """
    h, w = tile.rgba.shape[:2]
    src = tile.rgba
    dst = acc[tile.y:tile.y + h, tile.x:tile.x + w]
    plain = (not mode) or mode == "normal"

    if plain and _is_opaque(src):
        dst[...] = src                       # nothing of the backdrop survives
        return

    if plain and _is_opaque(dst):
        # dst[..., :3] = cb + (cs - cb) * a_s, and the output alpha is already 1.
        # Three terms per channel is under the split's break-even, so only the
        # alpha — the one operand that would otherwise broadcast with stride 0 —
        # is de-interleaved here.
        with _Planes() as sc:
            a_s = sc.plane((h, w))
            np.copyto(a_s, src[..., 3])
            t = sc.plane((h, w))
            for k in range(3):
                np.subtract(src[..., k], dst[..., k], out=t)
                np.multiply(t, a_s, out=t)
                np.add(dst[..., k], t, out=t)
                dst[..., k] = t
            dst[..., 3] = 1.0
        return

    with _Planes() as sc:
        sp = sc.split(src)
        dp = sc.split(dst)
        a_s, ab = sp[3], dp[3]
        cs, cb = sp[:3], dp[:3]
        if not plain:
            cs = _mix_blend(cs, cb, ab, mode, sc, linear)
        if _opaque(ab):
            # output alpha is 1, so the un-premultiplying divide has nothing to do
            for k in range(3):
                t = sc.like(cb[k])
                np.subtract(cs[k], cb[k], out=t)
                np.multiply(t, a_s, out=t)
                np.add(cb[k], t, out=t)
                dst[..., k] = t
            dst[..., 3] = 1.0
            return
        inv = sc.like(a_s)
        np.subtract(1, a_s, out=inv)
        ao = sc.like(a_s)
        np.multiply(ab, inv, out=ao)
        np.add(a_s, ao, out=ao)
        div = sc.like(ao)
        np.maximum(ao, EPS, out=div)
        # the complement of the predicate rather than `<=`, so that a NaN alpha
        # falls on the zero side of both halves the way one np.where did
        dark = np.logical_not(ao > EPS)
        num = sc.like(ao)
        t = sc.like(ao)
        for k in range(3):
            np.multiply(cs[k], a_s, out=num)
            np.multiply(cb[k], ab, out=t)
            np.multiply(t, inv, out=t)
            np.add(num, t, out=num)
            np.divide(num, div, out=num)
            np.copyto(num, 0.0, where=dark)
            dst[..., k] = num
        np.clip(ao, 0.0, 1.0, out=ao)
        dst[..., 3] = ao


# ── sources ───────────────────────────────────────────────────────────────────

_IMAGES = OrderedDict()                   # path -> float32 RGBA at native size
_IMAGE_BYTES = 0
_IMAGE_LIMIT = int(os.environ.get("VFX_IMAGE_CACHE_MB", "384")) * 1024 * 1024

_FRAMES = OrderedDict()                   # (path, index) -> uint8 RGB(A)
_FRAME_BYTES = 0
_FRAME_LIMIT = int(os.environ.get("VFX_FRAME_CACHE_MB", "512")) * 1024 * 1024

_READERS = OrderedDict()                  # path -> _VideoSource, containers held open
_READER_LIMIT = 8

_SCALED = OrderedDict()                   # (path, scale) -> float32 RGBA, preview-sized
_SCALED_BYTES = 0
_SCALED_LIMIT = int(os.environ.get("VFX_SCALED_CACHE_MB", "256")) * 1024 * 1024

_TEXT = OrderedDict()                     # (spec, w, h, scale) -> float32 RGBA
_TEXT_LIMIT = 24

_MASKS = OrderedDict()                    # (resolved mask spec, w, h) -> float32
_MASK_BYTES = 0
_MASK_LIMIT = int(os.environ.get("VFX_MASK_CACHE_MB", "128")) * 1024 * 1024


def _trim(store, current, limit):
    """Drop least-recently-used entries until the store fits its budget."""
    while store and current > limit:
        _, arr = store.popitem(last=False)
        current -= arr.nbytes
    return current


_STAMPS = {}                              # path -> (mtime_ns, size) when cached


def _source_stamp(path):
    try:
        st = os.stat(path)
        return [st.st_mtime_ns, st.st_size]
    except OSError:
        return None


def _drop_source(path):
    """Forget every cached form of one file — decoded, scaled and per-frame."""
    global _IMAGE_BYTES, _FRAME_BYTES, _SCALED_BYTES
    reader = _READERS.pop(path, None)
    if reader is not None:
        reader.close()
    img = _IMAGES.pop(path, None)
    if img is not None:
        _IMAGE_BYTES -= img.nbytes
    for key in [k for k in _SCALED if k[0] == path]:
        _SCALED_BYTES -= _SCALED.pop(key).nbytes
    for key in [k for k in _FRAMES if k[0] == path]:
        _FRAME_BYTES -= _FRAMES.pop(key).nbytes
    _STAMPS.pop(path, None)


def _refresh_sources():
    """Drop anything whose file changed on disk since it was cached.

    A process that lives for one frame re-reads every source by construction and
    can never be stale. A process that lives for a session cannot, and "I
    replaced the plate and the preview still shows the old one" is the bug that
    would follow it around. Called at REQUEST boundaries, never inside a render:
    within one job the sources stay frozen, which is exactly what they do today.
    """
    for path in set(_STAMPS):
        if _STAMPS.get(path) != _source_stamp(path):
            _drop_source(path)


def load_image(path):
    """A still as float32 straight-alpha RGBA, cached by path.

    Scrubbing a timeline re-asks for the same PNG thirty times a second; decoding
    it thirty times a second is the difference between a usable viewer and a
    slideshow.
    """
    global _IMAGE_BYTES
    hit = _IMAGES.get(path)
    if hit is not None:
        _IMAGES.move_to_end(path)
        return hit
    _STAMPS[path] = _source_stamp(path)
    with Image.open(path) as im:
        arr = np.asarray(im.convert("RGBA"), dtype=np.uint8)
    rgba = arr.astype(np.float32) / 255.0
    _IMAGES[path] = rgba
    _IMAGE_BYTES = _trim(_IMAGES, _IMAGE_BYTES + rgba.nbytes, _IMAGE_LIMIT)
    return rgba


# Every pixel format ffmpeg can hand a decoder that carries a real alpha
# plane. Membership of the decoded frame's format NAME in this set is the
# alpha test — PyAV's VideoFormat object exposes no has_alpha flag, and
# probing a phantom attribute with getattr defaults answers False forever
# without a sound, which is exactly how this file shipped a dead rgba branch.
_ALPHA_PIX_FMTS = frozenset([
    "rgba", "bgra", "argb", "abgr", "rgba64le", "rgba64be", "bgra64le",
    "bgra64be", "yuva420p", "yuva422p", "yuva444p", "yuva420p9le",
    "yuva420p10le", "yuva422p10le", "yuva444p10le", "yuva420p16le",
    "yuva422p16le", "yuva444p16le", "gbrap", "gbrap10le", "gbrap12le",
    "gbrap16le", "ya8", "ya16le", "ya16be", "pal8",
])


class _VideoSource:
    """One open container plus the bookkeeping to reach an arbitrary frame.

    Two access patterns matter and they pull in opposite directions: a render
    walks forward one frame at a time, and a scrub jumps anywhere. Decoding
    forward is nearly free; seeking costs a keyframe re-decode. So this keeps the
    decoder running and only seeks when the target is behind the playhead or far
    enough ahead that decoding through would cost more than a seek.

    Everything decoded on the way to the target is cached, which is why dragging
    back and forth across the same second stops touching the file at all.
    """

    FORWARD_WINDOW = 30                   # frames worth decoding through rather than seeking

    def __init__(self, path):
        self.path = path
        self.container = av.open(path)
        self.stream = self.container.streams.video[0]
        self.stream.thread_type = "AUTO"
        rate = self.stream.average_rate or self.stream.guessed_rate
        self.fps = float(rate) if rate else 30.0
        if not math.isfinite(self.fps) or self.fps <= 0:
            self.fps = 30.0
        self.width = int(self.stream.codec_context.width or 0)
        self.height = int(self.stream.codec_context.height or 0)
        dur = None
        if self.stream.duration is not None and self.stream.time_base:
            dur = float(self.stream.duration * self.stream.time_base)
        elif self.container.duration is not None:
            dur = float(self.container.duration) / av.time_base
        self.duration = dur if dur and dur > 0 else 0.0
        self.count = int(self.stream.frames or 0) or (
            int(round(self.duration * self.fps)) if self.duration else 0)
        self._gen = None
        self._next = None                 # index the running decoder will yield next

    def close(self):
        try:
            self.container.close()
        except Exception:                 # noqa: BLE001 — closing a dead container is not news
            pass

    def _index_of(self, frame, fallback):
        if frame.pts is not None and self.stream.time_base:
            start = self.stream.start_time or 0
            secs = float((frame.pts - start) * self.stream.time_base)
            return max(0, int(round(secs * self.fps)))
        return fallback

    def _seek(self, index):
        target = index / self.fps
        if self.stream.time_base:
            start = self.stream.start_time or 0
            pts = int(target / float(self.stream.time_base)) + start
        else:
            pts = int(target * av.time_base)
        self.container.seek(pts, stream=self.stream, backward=True, any_frame=False)
        self._gen = self.container.decode(video=0)
        self._next = None

    def frame(self, index):
        """uint8 RGB or RGBA at the given frame index, decoding as little as possible."""
        global _FRAME_BYTES
        if self.count:
            index = max(0, min(self.count - 1, int(index)))
        else:
            index = max(0, int(index))
        key = (self.path, index)
        hit = _FRAMES.get(key)
        if hit is not None:
            _FRAMES.move_to_end(key)
            return hit

        if (self._gen is None or self._next is None
                or index < self._next or index > self._next + self.FORWARD_WINDOW):
            self._seek(index)

        counter = self._next if self._next is not None else 0
        last = None
        for frame in self._gen:
            idx = self._index_of(frame, counter)
            counter = idx + 1
            self._next = counter
            # PyAV's VideoFormat has NO has_alpha attribute — the old
            # getattr(..., False) here was always False, so every alpha-carrying
            # clip (PNG/ProRes 4444/qtrle .mov) silently decoded opaque, showing
            # the black its encoder stored under the transparency. The format
            # NAME is the real signal.
            fmt = "rgba" if frame.format.name in _ALPHA_PIX_FMTS else "rgb24"
            arr = frame.to_ndarray(format=fmt)
            _FRAMES[(self.path, idx)] = arr
            _FRAME_BYTES = _trim(_FRAMES, _FRAME_BYTES + arr.nbytes, _FRAME_LIMIT)
            last = arr
            if idx >= index:
                return arr
        # ran off the end: the last decodable frame is the honest answer, and it
        # is what a clamped out-point should show anyway
        self._gen = None
        self._next = None
        if last is not None:
            return last
        raise ValueError(f"no decodable frame at index {index} in {os.path.basename(self.path)}")


def video_source(path):
    src = _READERS.get(path)
    if src is not None:
        _READERS.move_to_end(path)
        return src
    _STAMPS[path] = _source_stamp(path)
    src = _VideoSource(path)
    _READERS[path] = src
    while len(_READERS) > _READER_LIMIT:
        _, dead = _READERS.popitem(last=False)
        dead.close()
    return src


def close_sources():
    """Let go of every open container and cached bitmap.

    The server holds this process open across comps, and Windows will not let a
    clip be replaced or deleted while a decoder still has it mapped — so there has
    to be a way to say "done with that footage" that is not "exit".
    """
    global _IMAGE_BYTES, _FRAME_BYTES, _SCALED_BYTES, _MASK_BYTES, _SCRATCH_BYTES
    while _READERS:
        _, src = _READERS.popitem()
        src.close()
    _FRAMES.clear()
    _IMAGES.clear()
    _SCALED.clear()
    _TEXT.clear()
    _MASKS.clear()
    _GLYPHS.clear()
    _FONTS.clear()
    _STAMPS.clear()
    _SCRATCH.clear()
    _FRAME_BYTES = _IMAGE_BYTES = _SCALED_BYTES = 0
    _MASK_BYTES = _SCRATCH_BYTES = 0


_FONTS = OrderedDict()                    # (basename, px) -> ImageFont
_FONT_LIMIT = 32


def _resolve_font(name, size):
    """A font by BASENAME only, out of the system font folders.

    Same rule imagetools follows and for the same reason: comp documents reach
    this process unvalidated, and handing an arbitrary string to FreeType means
    any file on disk gets opened and parsed.

    Cached: the whole-line raster is cached above this, but an animated text layer
    asks again on every frame, and opening a TTF is a file open plus a parse.
    """
    want = os.path.basename(str(name or "arial.ttf"))
    key = (want, int(size))
    hit = _FONTS.get(key)
    if hit is not None:
        _FONTS.move_to_end(key)
        return hit
    font = None
    for d in FONT_DIRS:
        if not d:
            continue
        try:
            font = ImageFont.truetype(os.path.join(d, want), size)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default(size)
    _FONTS[key] = font
    while len(_FONTS) > _FONT_LIMIT:
        _FONTS.popitem(last=False)
    return font


def _render_text(layer, w, h, scale):
    """Type on a transparent layer-sized canvas, centred on the canvas.

    Centred because the default anchor and position are both the comp centre, so
    a text layer with an untouched transform reads as "in the middle" — which is
    what someone who just typed into an empty comp expects to see.

    Nothing a text layer draws is animatable (the transform moves it, the glyphs
    do not change), so the raster is a pure function of the spec and the canvas —
    cached, because rasterising a static title thirty times a second is thirty
    times more FreeType than the frame needs.
    """
    spec = layer.get("text") or {}
    key = (json.dumps(spec, sort_keys=True, default=str), w, h, round(scale, 5))
    hit = _TEXT.get(key)
    if hit is not None:
        _TEXT.move_to_end(key)
        return hit
    rgba = _rasterize_text(spec, w, h, scale)
    _TEXT[key] = rgba
    while len(_TEXT) > _TEXT_LIMIT:
        _TEXT.popitem(last=False)
    return rgba


def _rasterize_text(spec, w, h, scale):
    content = str(spec.get("content") or "")
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if not content.strip():
        return np.asarray(im, dtype=np.float32) / 255.0

    size = max(1, int(round(_f(spec.get("size"), 64.0) * scale)))
    font = _resolve_font(spec.get("font"), size)
    draw = ImageDraw.Draw(im)
    fill = tuple(int(round(c * 255)) for c in _rgba01(spec.get("color"), (1.0, 1.0, 1.0, 1.0)))
    stroke_w = int(round(_f(spec.get("stroke"), 0.0) * scale))
    stroke_fill = tuple(int(round(c * 255)) for c in _rgba01(spec.get("strokeColor"), (0.0, 0.0, 0.0, 1.0)))
    align = str(spec.get("align") or "center").lower()
    line_h = _f(spec.get("lineHeight"), 1.15) * size
    # AE measures tracking in 1/1000 em, which is the number a designer will
    # copy off a type panel — turn it into pixels at this size.
    track = _f(spec.get("tracking"), 0.0) / 1000.0 * size

    lines = content.split("\n")
    top = h / 2.0 - (line_h * len(lines)) / 2.0 + line_h / 2.0
    anchor = {"left": "lm", "center": "mm", "right": "rm"}.get(align, "mm")
    for i, line in enumerate(lines):
        y = top + i * line_h
        if abs(track) < 0.01:
            draw.text((w / 2.0, y), line, font=font, fill=fill, anchor=anchor,
                      stroke_width=stroke_w, stroke_fill=stroke_fill if stroke_w else None)
            continue
        # Tracking has to be drawn glyph by glyph; PIL has no letter-spacing.
        widths = [draw.textlength(ch, font=font) for ch in line]
        total = sum(widths) + track * max(0, len(line) - 1)
        x = {"left": w / 2.0, "right": w / 2.0 - total}.get(align, w / 2.0 - total / 2.0)
        for ch, adv in zip(line, widths):
            draw.text((x, y), ch, font=font, fill=fill, anchor="lm",
                      stroke_width=stroke_w, stroke_fill=stroke_fill if stroke_w else None)
            x += adv + track
    return np.asarray(im, dtype=np.float32) / 255.0


# ── text animators ────────────────────────────────────────────────────────────

_GLYPHS = OrderedDict()                   # (font, char, fill, stroke) -> (rgba, ox, oy)
_GLYPH_LIMIT = 512

_SELECTOR_SHAPES = ("square", "rampup", "rampdown", "triangle", "round", "smooth")


def _glyph_tile(font, font_key, ch, fill, stroke_w, stroke_fill):
    """One character on its own transparent tile, plus where that tile sits.

    (ox, oy) is the tile's top-left relative to the PEN POINT — the baseline-left
    origin the character would be drawn from. Everything downstream works in pen
    points, so a glyph can be moved, turned and scaled without anyone having to
    know how much ink hangs above or below the line.
    """
    key = (font_key, ch, fill, int(stroke_w), stroke_fill if stroke_w else None)
    hit = _GLYPHS.get(key)
    if hit is not None:
        _GLYPHS.move_to_end(key)
        return hit
    try:
        box = font.getbbox(ch, anchor="ls", stroke_width=int(stroke_w))
    except (TypeError, ValueError):                    # default bitmap font
        box = None
    if not box or box[2] <= box[0] or box[3] <= box[1]:
        out = (None, 0.0, 0.0)                         # a space: advance, no ink
    else:
        pad = 2
        ox, oy = box[0] - pad, box[1] - pad
        w = int(math.ceil(box[2] - box[0])) + pad * 2
        h = int(math.ceil(box[3] - box[1])) + pad * 2
        im = Image.new("RGBA", (max(1, w), max(1, h)), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((-ox, -oy), ch, font=font, fill=fill, anchor="ls",
                                stroke_width=int(stroke_w),
                                stroke_fill=stroke_fill if stroke_w else None)
        out = (np.asarray(im, dtype=np.float32) / 255.0, float(ox), float(oy))
    _GLYPHS[key] = out
    while len(_GLYPHS) > _GLYPH_LIMIT:
        _GLYPHS.popitem(last=False)
    return out


def _selector_weight(sel, index, count, t, ctx=None):
    """How much of an animator this character gets, 0..1.

    AE's range selector, in the unit AE defaults to: start/end/offset are PERCENT
    of the character count, so the same document reads the same on a three-word
    title and a paragraph. A character occupies the slice from i/N to (i+1)/N and
    is sampled at its middle, which is what keeps a square selector landing on
    whole characters instead of half of one.

    `ctx` is the animator's "animators.<i>.selector" binding. One binding for the
    whole selector and a child per row, not one per CHARACTER: a selector is one
    property whatever it is being asked about, and keying it per character would
    give `wiggle` on an offset a different seed for every letter.
    """
    if not isinstance(sel, dict) or count <= 0:
        return 1.0
    at = _at_of(ctx)
    start = _f(interp.eval_prop(sel.get("start"), t, 0.0, at("start")), 0.0)
    end = _f(interp.eval_prop(sel.get("end"), t, 100.0, at("end")), 100.0)
    offset = _f(interp.eval_prop(sel.get("offset"), t, 0.0, at("offset")), 0.0)
    lo, hi = (start, end) if start <= end else (end, start)
    lo += offset
    hi += offset
    p = (index + 0.5) / float(count) * 100.0

    shape = str(interp.eval_prop(sel.get("shape"), t, "square", at("shape")) or "square").lower()
    span = hi - lo
    if span <= 1e-9:
        w = 0.0
    elif shape == "rampup":
        # ramps are the only shapes that keep going outside the range: before the
        # start nothing has happened, after the end everything has
        w = min(1.0, max(0.0, (p - lo) / span))
    elif shape == "rampdown":
        w = 1.0 - min(1.0, max(0.0, (p - lo) / span))
    elif p < lo or p > hi:
        w = 0.0
    else:
        u = (p - lo) / span
        if shape == "triangle":
            w = 1.0 - abs(2.0 * u - 1.0)
        elif shape == "round":
            w = math.sqrt(max(0.0, 1.0 - (2.0 * u - 1.0) ** 2))
        elif shape == "smooth":
            w = 0.5 - 0.5 * math.cos(2.0 * math.pi * u)
        else:                                          # square
            w = 1.0

    lowe = _f(interp.eval_prop(sel.get("easeLow"), t, 0.0, at("easeLow")), 0.0) / 100.0
    highe = _f(interp.eval_prop(sel.get("easeHigh"), t, 0.0, at("easeHigh")), 0.0) / 100.0
    if abs(lowe) > 1e-6 or abs(highe) > 1e-6:
        lowe = min(1.0, max(-1.0, lowe))
        highe = min(1.0, max(-1.0, highe))
        # Ease High/Low reshape the 0..1 ramp itself, so they read as a cubic
        # bezier over it: +100 flattens that end (the transition lingers there),
        # -100 sharpens it. Both zero is the straight line, which is why this is
        # skipped entirely above.
        w = interp.bezier_ease((1.0 + lowe) / 2.0, (1.0 - lowe) / 2.0,
                               (1.0 - highe) / 2.0, (1.0 + highe) / 2.0, w)
    return min(1.0, max(0.0, w))


def _animator_bindings(cctx, layer, animators):
    """One (selector, properties) binding pair per animator, built ONCE.

    Animators are addressed by POSITION: unlike an effect they carry no id, and a
    name is optional and not unique. Hoisted out of _char_animation because that
    runs per CHARACTER — a paragraph with three animators would otherwise build
    the same six paths several hundred times a frame to look up six cached
    objects.
    """
    if _env(cctx) is None:
        return [(None, _at_of(None))] * len(animators)
    return [(_bind(cctx, layer, "animators.%d.selector" % i),
             _at_of(_bind(cctx, layer, "animators.%d.properties" % i)))
            for i in range(len(animators))]


def _char_animation(animators, index, count, t, base_color, binds=None):
    """Every animator's contribution to one character, folded together.

    Additive is the rule for the offsets (position, rotation, tracking, blur —
    two animators nudging a letter right both get their nudge) and multiplicative
    for the two that are ratios (scale, opacity), because two animators each
    halving a letter must leave a quarter, not nothing.
    """
    if binds is None:
        binds = [(None, _at_of(None))] * len(animators)
    off = [0.0, 0.0]
    sc = [1.0, 1.0]
    rot = 0.0
    opacity = 1.0
    track = 0.0
    blur = [0.0, 0.0]
    color = base_color
    moved = False
    for ai, an in enumerate(animators):
        if not isinstance(an, dict):
            continue
        sel_ctx, at = binds[ai]
        w = _selector_weight(an.get("selector"), index, count, t, sel_ctx)
        if w <= 1e-4:
            continue
        props = an.get("properties") if isinstance(an.get("properties"), dict) else {}
        moved = True
        if "position" in props:
            p = interp.eval_prop(props["position"], t, [0.0, 0.0], at("position"))
            px_, py_ = _triple(p, (0.0, 0.0, 0.0))[:2]
            off[0] += w * px_
            off[1] += w * py_
        if "scale" in props:
            s = interp.eval_prop(props["scale"], t, [100.0, 100.0], at("scale"))
            sx_, sy_ = _triple(s, (100.0, 100.0, 100.0))[:2]
            sc[0] *= (100.0 + w * (sx_ - 100.0)) / 100.0
            sc[1] *= (100.0 + w * (sy_ - 100.0)) / 100.0
        if "rotation" in props:
            rot += w * _f(interp.eval_prop(props["rotation"], t, 0.0, at("rotation")), 0.0)
        if "opacity" in props:
            o = _f(interp.eval_prop(props["opacity"], t, 100.0, at("opacity")), 100.0)
            opacity *= (100.0 + w * (o - 100.0)) / 100.0
        if "tracking" in props:
            track += w * _f(interp.eval_prop(props["tracking"], t, 0.0, at("tracking")), 0.0)
        if "blur" in props:
            b = interp.eval_prop(props["blur"], t, 0.0, at("blur"))
            bx, by = _triple(b if isinstance(b, (list, tuple)) else [b, b],
                             (0.0, 0.0, 0.0))[:2]
            blur[0] += w * bx
            blur[1] += w * by
        if "fillColor" in props:
            c = _rgba01(interp.eval_prop(props["fillColor"], t, None, at("fillColor")), color)
            color = tuple(color[i] + (c[i] - color[i]) * w for i in range(4))
    return off, sc, rot, min(1.0, max(0.0, opacity)), track, blur, color, moved


def _blit(acc, rgba, x, y):
    """Composite a loose bitmap into a canvas, clipped to it."""
    H, W = acc.shape[:2]
    h, w = rgba.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    sub = rgba[y0 - y:y1 - y, x0 - x:x1 - x]
    _over(acc, Tile(np.ascontiguousarray(sub), x0, y0))


def _render_text_animated(layer, W, H, scale, t, cctx=None):
    """A text layer drawn character by character, each with its own transform.

    This is what a typewriter, a cascade and a per-letter bounce all are: not one
    raster moved around, but N rasters each carrying its own share of the
    animator, decided by where the selector's window is sitting this frame.

    Laid out to agree with the whole-line path above — same centring, same
    line height, same tracking-in-1/1000-em — so switching a layer between the two
    does not move the type.
    """
    spec = layer.get("text") or {}
    animators = [a for a in (layer.get("animators") or []) if isinstance(a, dict)]
    binds = _animator_bindings(cctx, layer, animators)
    canvas = np.zeros((H, W, 4), dtype=np.float32)
    content = str(spec.get("content") or "")
    if not content.strip():
        return canvas

    size = max(1, int(round(_f(spec.get("size"), 64.0) * scale)))
    font_name = os.path.basename(str(spec.get("font") or "arial.ttf"))
    font = _resolve_font(font_name, size)
    font_key = (font_name, size)
    base_color = _rgba01(spec.get("color"), (1.0, 1.0, 1.0, 1.0))
    stroke_w = int(round(_f(spec.get("stroke"), 0.0) * scale))
    stroke_fill = tuple(int(round(c * 255))
                        for c in _rgba01(spec.get("strokeColor"), (0.0, 0.0, 0.0, 1.0)))
    align = str(spec.get("align") or "center").lower()
    line_h = _f(spec.get("lineHeight"), 1.15) * size
    base_track = _f(spec.get("tracking"), 0.0) / 1000.0 * size
    try:
        ascent, descent = font.getmetrics()
    except AttributeError:
        ascent, descent = size, 0

    lines = content.split("\n")
    count = sum(len(ln) for ln in lines)
    if count <= 0:
        return canvas

    top = H / 2.0 - (line_h * len(lines)) / 2.0 + line_h / 2.0
    index = 0
    for li, line in enumerate(lines):
        if not line:
            continue
        # baseline from the vertical MIDDLE the cached path anchors on ("mm"),
        # so the two rasters sit on the same line
        baseline = top + li * line_h + (ascent - descent) / 2.0
        try:
            advances = [float(font.getlength(ch)) for ch in line]
        except AttributeError:
            advances = [float(size) for _ in line]

        per_char = [_char_animation(animators, index + i, count, t, base_color, binds)
                    for i in range(len(line))]
        extra = [c[4] * scale for c in per_char]
        total = sum(advances) + sum(base_track + extra[i] for i in range(len(line) - 1))
        pen = {"left": W / 2.0, "right": W / 2.0 - total}.get(align, W / 2.0 - total / 2.0)

        for i, ch in enumerate(line):
            off, sc, rot, opacity, _track, blur, color, moved = per_char[i]
            adv = advances[i]
            if ch.strip() and opacity > 1e-3:
                fill = tuple(int(round(c * 255)) for c in color)
                tile, ox, oy = _glyph_tile(font, font_key, ch, fill, stroke_w, stroke_fill)
                if tile is not None:
                    _draw_char(canvas, tile, ox, oy, pen, baseline, adv, size,
                               off, sc, rot, opacity, blur, scale, moved)
            pen += adv + base_track + extra[i]
            index += 1
    return canvas


def _draw_char(canvas, tile, ox, oy, pen, baseline, adv, size,
               off, sc, rot, opacity, blur, scale, moved):
    """Place one glyph tile under its per-character transform.

    The character turns and scales about the centre of its own advance box, half
    an ex above the baseline — the point a designer means by "the letter", not the
    pen point, which sits on the baseline at its left edge and swings a rotating
    letter out of the line.
    """
    H, W = canvas.shape[:2]
    src = tile
    px_, py_ = off[0] * scale, off[1] * scale
    bx, by = blur[0] * scale, blur[1] * scale
    if bx > 0.05 or by > 0.05:
        pad = int(math.ceil(3.0 * max(bx, by))) + 1
        src = cv2.copyMakeBorder(src, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0.0)
        pm = _premul(src).copy()
        pm = cv2.GaussianBlur(pm, (0, 0), sigmaX=max(0.05, bx / 2.0),
                              sigmaY=max(0.05, by / 2.0), borderType=cv2.BORDER_CONSTANT)
        src = _unpremul(np.asarray(pm, dtype=np.float32), inplace=True)
        ox -= pad
        oy -= pad

    ax = pen + adv / 2.0
    ay = baseline - 0.35 * size
    rad = math.radians(rot)
    c, s = math.cos(rad), math.sin(rad)
    lin = np.array([[c * sc[0], -s * sc[1]],
                    [s * sc[0], c * sc[1]]], dtype=np.float64)
    origin = np.array([pen + ox, baseline + oy], dtype=np.float64)
    anchor = np.array([ax, ay], dtype=np.float64)
    tvec = anchor + np.array([px_, py_]) + lin @ (origin - anchor)

    h, w = src.shape[:2]
    corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float64) @ lin.T + tvec
    x0 = max(0, int(math.floor(corners[:, 0].min())) - 1)
    y0 = max(0, int(math.floor(corners[:, 1].min())) - 1)
    x1 = min(W, int(math.ceil(corners[:, 0].max())) + 1)
    y1 = min(H, int(math.ceil(corners[:, 1].max())) + 1)
    if x1 <= x0 or y1 <= y0:
        return
    m = np.array([[lin[0, 0], lin[0, 1], tvec[0] - x0],
                  [lin[1, 0], lin[1, 1], tvec[1] - y0]], dtype=np.float64)
    warped = cv2.warpAffine(_premul(src), m, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=(0.0, 0.0, 0.0, 0.0))
    out = _unpremul(np.asarray(warped, dtype=np.float32), inplace=True)
    if opacity < 1.0 - 1e-6:
        out[..., 3] *= opacity
    _blit(canvas, out, x0, y0)


def _is_track(prop):
    """Whether a property is a keyframe track rather than a constant."""
    return (isinstance(prop, dict) and isinstance(prop.get("keys"), list)
            and any(isinstance(k, dict) and "v" in k for k in prop["keys"]))


def _remap_time(prop, t, ctx=None):
    """Source time straight off a timeRemap curve.

    interp.py grew the dedicated helper this used to wait for — eval_time_remap,
    which is the property-shaped door onto time_remap() and takes the expression
    ctx. The getattr probe stays because that is what made the seam work in the
    first place, and it costs one dict lookup a frame.
    """
    fn = getattr(interp, "eval_time_remap", None)
    if callable(fn):
        try:
            return _f(fn(prop, t, ctx), 0.0)
        except Exception:                              # noqa: BLE001 — ours is fine
            pass
    return _f(interp.eval_prop(prop, t, 0.0, ctx), 0.0)


def _source_time(layer, t, cctx=None):
    """Where in the source we are, for a layer sitting at comp time t.

    Negative timeScale walks the source backwards from its in point; the clamp is
    the out-point behaviour AE calls holding the last frame.

    A timeRemap curve replaces the whole rule: its value IS source time, which is
    the only way to hold a frame, run a clip backwards mid-shot, or loop.
    """
    remap = layer.get("timeRemap")
    # A remap that is nothing BUT an expression has no keys for _is_track to find,
    # and would otherwise fall through to the inPoint rule — the layer would play
    # straight and the expression would look like it had simply done nothing.
    if _is_track(remap) or (isinstance(remap, dict) and remap.get("expr")):
        return _remap_time(remap, t, _bind(cctx, layer, "timeRemap"))
    start = _f(layer.get("start"), 0.0)
    in_point = _f(layer.get("inPoint"), 0.0)
    ts = _f(layer.get("timeScale"), 1.0)
    return in_point + (t - start) * ts


# ── nested comps ──────────────────────────────────────────────────────────────

# What a nested render carries down: every comp document reachable from the root,
# the chain of comps already being rendered so a loop can be named rather than
# discovered as a RecursionError at frame 900, this frame's expression
# environment (None when expressions.py is absent), and THE PARENT'S RESOLVED
# LINEAR-LIGHT SETTING — see _linear_light. None at the root, which is what
# makes "the child said nothing" resolve to off when there is nobody to ask.
CompCtx = namedtuple("CompCtx", "library chain env linear")
CompCtx.__new__.__defaults__ = (None, None)           # a caller from before either existed


def _comp_identity(doc):
    return str(doc.get("slug") or doc.get("id") or "")


def _comp_library(doc, base=None):
    """Every child comp this document can reach, by slug.

    The document itself goes in too: a comp that names itself then RESOLVES and
    is refused by name, instead of failing as "no comp called opening-titles"
    when opening-titles is the very thing being rendered.
    """
    lib = dict(base or {})
    kids = doc.get("comps")
    if isinstance(kids, dict):
        for key, child in kids.items():
            if isinstance(child, dict):
                lib[str(key)] = child
                ident = _comp_identity(child)
                if ident:
                    lib.setdefault(ident, child)
    elif isinstance(kids, list):
        for child in kids:
            if isinstance(child, dict) and _comp_identity(child):
                lib.setdefault(_comp_identity(child), child)
    ident = _comp_identity(doc)
    if ident:
        lib.setdefault(ident, doc)
    return lib


def _child_comp(layer, cctx):
    """The document a comp layer points at, or a refusal that says which one."""
    inline = layer.get("comp")
    if isinstance(inline, dict) and inline.get("layers") is not None:
        return inline
    slug = str(layer.get("src") or "")
    child = (cctx.library if cctx else {}).get(slug)
    if not isinstance(child, dict):
        raise ValueError(
            f"comp layer {layer.get('name') or layer.get('id')!r} points at comp "
            f"{slug!r}, which is not in this document's comps library")
    return child


def _descend(child, layer, cctx, linear=None):
    """The context for rendering `child` inside the comp `cctx` describes.

    `linear` is the PARENT's resolved linear-light setting, which the child
    inherits unless its own document says otherwise (_linear_light). The audio
    walkers below call this without it: a sound has no colour space, and
    passing None there says so rather than guessing.
    """
    ident = _comp_identity(child) or str(layer.get("src") or "")
    chain = (cctx.chain if cctx else ())
    if ident and ident in chain:
        path = " -> ".join(list(chain) + [ident])
        raise ValueError(f"comp {ident!r} contains itself: {path}")
    if len(chain) >= MAX_COMP_DEPTH:
        raise ValueError(
            f"nested comps go deeper than {MAX_COMP_DEPTH}: "
            + " -> ".join(list(chain) + [ident or "?"]))
    return CompCtx(library=_comp_library(child, cctx.library if cctx else None),
                   chain=chain + ((ident,) if ident else ("",)),
                   # its own env: `thisComp` inside a precomp means the precomp,
                   # and the cycle guard must not confuse two layers that share
                   # an id across documents
                   env=_new_env(child),
                   linear=linear)


def _layer_native_size(comp, layer, cctx=None):
    """The layer's own pixel dimensions — what its anchor is measured in."""
    cw, ch = int(comp.get("width") or 1920), int(comp.get("height") or 1080)
    kind = str(layer.get("type") or "image")
    if kind == "comp":
        try:
            child = _child_comp(layer, cctx)
        except ValueError:
            return cw, ch
        return (max(1, int(child.get("width") or cw)),
                max(1, int(child.get("height") or ch)))
    if kind == "image":
        src = layer.get("src")
        if src:
            try:
                a = load_image(src)
                return a.shape[1], a.shape[0]
            except Exception:                          # noqa: BLE001
                return cw, ch
    elif kind == "video":
        src = layer.get("src")
        if src:
            try:
                v = video_source(src)
                if v.width and v.height:
                    return v.width, v.height
            except Exception:                          # noqa: BLE001
                return cw, ch
    elif kind == "solid":
        return int(_f(layer.get("width"), cw)) or cw, int(_f(layer.get("height"), ch)) or ch
    return cw, ch


def _video_rgba(v, index):
    """One decoded frame as float32 RGBA at the source's own size."""
    arr = v.frame(index)
    # one allocation, not the three that convert-then-concatenate costs: at
    # 1080p each of those is 33 MB touched on every frame of a render
    a = np.empty(arr.shape[:2] + (4,), dtype=np.float32)
    np.divide(arr, 255.0, out=a[..., :arr.shape[2]])
    if arr.shape[2] == 3:
        a[..., 3] = 1.0
    return a


def _layer_pixels(comp, layer, t, scale, size, draft=False, cctx=None, extra=1.0):
    """The layer's own bitmap at render resolution, before anything is done to it.

    Returns None for the types that have no pixels of their own — a null exists to
    be a parent, a camera exists to be looked through, and an adjustment layer's
    pixels are whatever is already beneath it, which is not this function's
    business.

    `extra` is the continuous-rasterisation multiplier: 1.0 everywhere except a
    collapsed comp layer, which asks for the resolution its transform will
    actually show rather than the one its document declares.
    """
    kind = str(layer.get("type") or "image")
    W, H = size
    # A light has no pixels, exactly like a null or a camera. Without it here
    # a light layer paints as a white rectangle over the comp. An audio layer
    # is the same story: it is a SOUND source (mixed by _mix_comp_audio at
    # render time) and left off this line its .flac src would be handed to
    # load_image and fail the frame.
    if kind in ("null", "camera", "light", "audio"):
        return None
    if kind == "solid":
        nw, nh = _layer_native_size(comp, layer, cctx)
        w = max(1, int(round(nw * scale)))
        h = max(1, int(round(nh * scale)))
        rgba = np.empty((h, w, 4), dtype=np.float32)
        rgba[:] = _rgba01(layer.get("color"), (1.0, 1.0, 1.0, 1.0))
        return rgba
    if kind == "text":
        # Per-character animation depends on t, so it cannot go through the raster
        # cache — and it has to draw glyph by glyph anyway.
        if layer.get("animators"):
            return _render_text_animated(layer, W, H, scale, t, cctx)
        return _render_text(layer, W, H, scale)
    if kind == "shape":
        # Every value in a shape item is animatable, so this is a function of t
        # and cannot be cached on scale alone — the same reason animated text
        # is drawn per frame just above. eval_prop goes in as a parameter so
        # shapes.py never has to import the interpolator itself.
        if shapes is None:
            return None
        return shapes.render_shape(layer, t, W, H, _shape_evaluator(cctx, layer),
                                   scale=scale, draft=draft)
    if kind == "adjustment":
        # an opaque plate: only its ALPHA is used, as the region the adjustment
        # reaches, so it goes through the identical mask/transform path as a solid
        rgba = np.ones((H, W, 4), dtype=np.float32)
        return rgba
    if kind == "comp":
        child = _child_comp(layer, cctx)
        # The colour space travels DOWN the tree with the pixels: this comp's
        # resolved answer becomes what the child inherits when it has not said.
        sub = _descend(child, layer, cctx, _linear_light(comp, cctx))
        cw = max(1, int(child.get("width") or comp.get("width") or 1920))
        chh = max(1, int(child.get("height") or comp.get("height") or 1080))
        s = max(0.01, min(4.0, scale * max(1.0, float(extra))))
        cs = (max(1, int(round(cw * s))), max(1, int(round(chh * s))))
        # Out-of-range source time is NOT clamped: the child's own layers carry
        # start/end, so running past its duration yields its background, which is
        # what a precomp trimmed shorter than its parent should show.
        return render_frame(child, _source_time(layer, t, cctx), scale=s, draft=draft,
                            size=cs, _cctx=sub)
    src = layer.get("src")
    if not src:
        return None
    if kind == "video":
        v = video_source(src)
        st = _source_time(layer, t, cctx)
        if v.duration:
            st = min(max(0.0, st), max(0.0, v.duration - 0.5 / v.fps))
        else:
            st = max(0.0, st)
        pos = st * v.fps
        a = None
        if not draft and str(layer.get("frameBlend") or "off").lower() in ("mix", "on", "frameMix"):
            # Retimed footage lands BETWEEN two source frames. Snapping to the
            # nearest is the judder; crossfading them is what AE calls frame mix.
            i0 = int(math.floor(pos))
            frac = pos - i0
            if frac > 1e-3 and (not v.count or i0 + 1 < v.count):
                lo = _video_rgba(v, i0)
                hi = _video_rgba(v, i0 + 1)
                if lo.shape == hi.shape:
                    a = lo + (hi - lo) * np.float32(frac)
        if a is None:
            a = _video_rgba(v, int(round(pos)))
    else:
        # A still does not change between frames, so neither does its preview-
        # sized copy: resizing 1080p to half every frame of a scrub is the single
        # most wasteful thing this function could do.
        return _scaled_image(src, scale)
    return _resample(a, scale)


def _resample(a, scale):
    if abs(scale - 1.0) <= 1e-4:
        return np.ascontiguousarray(a, dtype=np.float32)
    w = max(1, int(round(a.shape[1] * scale)))
    h = max(1, int(round(a.shape[0] * scale)))
    # premultiplied resample: interpolating straight alpha across a cutout's edge
    # drags whatever colour sits in the fully-transparent pixels into the visible
    # fringe, which is the classic black halo
    out = cv2.resize(_premul(a), (w, h),
                     interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    return np.ascontiguousarray(_unpremul(np.asarray(out, dtype=np.float32), inplace=True))


def _scaled_image(path, scale):
    global _SCALED_BYTES
    key = (path, round(float(scale), 5))
    hit = _SCALED.get(key)
    if hit is not None:
        _SCALED.move_to_end(key)
        return hit
    out = _resample(load_image(path), scale)
    _SCALED[key] = out
    _SCALED_BYTES = _trim(_SCALED, _SCALED_BYTES + out.nbytes, _SCALED_LIMIT)
    return out


def _premul(rgba):
    """Straight -> premultiplied. Returns the input itself when it is opaque.

    Premultiplying by 1 is the identity, so a fully-covered frame needs no copy
    at all — and callers here only ever READ the result (it goes into resize or
    warpAffine as the source), so handing back the original is safe.
    """
    if _is_opaque(rgba):
        return rgba
    out = rgba.copy()
    a = out[..., 3]
    for c in range(3):
        out[..., c] *= a                     # per channel: see the planar note
    return out


def _unpremul(rgba, inplace=False):
    """Premultiplied -> straight. inplace only for arrays the caller just made."""
    if _is_opaque(rgba):
        return rgba if inplace else rgba.copy()
    out = rgba if inplace else rgba.copy()
    a = out[..., 3]
    dark = np.logical_not(a > EPS)           # complement, so NaN alpha zeroes
    div = np.maximum(a, EPS)
    for c in range(3):
        ch = out[..., c]
        np.divide(ch, div, out=ch)
        np.copyto(ch, 0.0, where=dark)
    return np.clip(out, 0.0, 1.0, out=out)


# ── effects, masks, transform ─────────────────────────────────────────────────

def _effect_ctx(comp, layer, t, scale, draft, size, cctx=None):
    ctx = {
        "t": float(t),
        "fps": _f(comp.get("fps"), 30.0),
        "width": int(size[0]),
        "height": int(size[1]),
        "draft": bool(draft),
        "layer": layer,
        # not in the spec's ctx list, but a radius in pixels means nothing without
        # it: at 0.5 preview scale a 12px blur must become a 6px blur or the
        # preview lies about the render
        "scale": float(scale),
        # echo and friends declare needsHistory; a LIST would decode N extra
        # frames for every layer on every frame whether or not anything asked.
        # A callable costs nothing until it is called.
        "history": lambda n=1: _history(comp, layer, t, scale, size, n, draft, cctx),
        # Displacement Map, Compound Blur, Set Matte, Difference Matte and
        # Gradient Wipe read ANOTHER layer. Callable for the same reason
        # history is: resolving one costs a full layer render.
        "layerPixels": lambda ref: _layer_input(comp, layer, ref, t, scale,
                                                draft, size, cctx),
        # Where an effect says what it could not do. It appends only when this
        # list exists, so a degrade is reported rather than logged as a failure.
        "notes": [],
        # The comp's linearLight switch, RESOLVED — its own if it set one, its
        # parent's if it did not. effects.apply answers it; nothing in an
        # effect body ever sees it. See the `linear light` section at the top.
        "linear": _linear_light(comp, cctx),
    }
    return ctx


def _layer_input(comp, requester, ref, t, scale, draft, size, cctx=None):
    """Another layer's pixels, for an effect that reads one. None if it cannot.

    None is a real answer here and never an exception: the effects all fall
    back to reading their own channels, which is the behaviour they had before
    they could see a second layer at all. A missing map should cost a
    less-clever picture, not a dead render.
    """
    if not isinstance(ref, str) or not ref.strip():
        return None
    layers = [l for l in (comp.get("layers") or []) if isinstance(l, dict)]
    want = ref.strip()

    hit = None
    for lay in layers:
        if str(lay.get("id") or "") == want:
            hit = lay
            break
    if hit is None:
        # A name only resolves when exactly one layer carries it — the same
        # rule findLayer() applies on the JS side. Two "glow" layers is an
        # ambiguity to refuse, not a coin toss to win.
        named = [l for l in layers if str(l.get("name") or "") == want]
        if len(named) != 1:
            return None
        hit = named[0]

    # The requester itself, directly or round a cycle. Recursion here would run
    # until the render died, and refusing is also semantically right: reading
    # yourself is what the self-channel fallback already does.
    if hit is requester or str(hit.get("id") or "") == str(requester.get("id") or ""):
        return None
    seen = getattr(_layer_input, "_seen", None)
    if seen is None:
        seen = _layer_input._seen = set()
    key = (id(comp), str(hit.get("id") or ""))
    if key in seen:
        return None

    by_id = {l.get("id"): l for l in layers if l.get("id")}
    camera = None
    if any(l.get("threeD") for l in layers):
        for lay in layers:
            if str(lay.get("type") or "") == "camera" and visible(lay) and in_window(lay):
                camera = camera_from(lay, comp, by_id, t, _comp_defaults(comp, cctx), cctx)
                break
        if camera is None:
            camera = default_camera(comp)

    seen.add(key)
    try:
        # visible() is deliberately NOT consulted: turning the map layer's
        # eyeball off so it does not composite is the whole workflow.
        tile = _layer_tile_blurred(comp, hit, t, scale, draft, size, by_id,
                                   cctx=cctx, camera=camera)
    except Exception:                                  # noqa: BLE001
        return None
    finally:
        seen.discard(key)

    if tile is None:
        return None
    out = _tile_region(tile, 0, 0, int(size[0]), int(size[1]))
    if not isinstance(out, np.ndarray) or out.ndim != 3 or out.shape[2] != 4:
        return None
    return np.ascontiguousarray(out, dtype=np.float32)


def _snap_time(layer, t):
    """The time this layer's CONTENT should be sampled at.

    Normally t. An effect that declares `snapsTime` in the catalog — today only
    posterizeTime — asks for it quantised. (The flag was once declared and read
    by nobody, and then read against a param name the catalog never had — `fps`
    instead of `rate` — so the effect could only approximate a hold from
    whatever discrete history it was handed, and previews/draft renders, which
    have no history, held nothing.) Two instants inside one step must render
    identically, which is the one thing posterizing time exists to stop.

    The layer's TRANSFORM is deliberately left on the true t: a posterized layer
    still travels smoothly along its motion path while its content steps, which
    is both what AE does and the only version that costs nothing.
    """
    if effects is None:
        return t
    for fx in (layer.get("effects") or []):
        if fx.get("enabled") is False:
            continue
        spec = effects.CATALOG.get(str(fx.get("type") or ""))
        if not spec or not spec.get("snapsTime"):
            continue
        # The catalog names the parameter `rate` (there has never been an
        # `fps` param — reading one made this whole path dead code: sequential
        # renders still held via the history fallback, previews and draft
        # renders did not hold at all). Evaluated through interp so a keyed
        # rate works, and an UNSET rate falls back to the catalog default the
        # effect itself would be coerced to — the two must quantise to the
        # same grid or the snap and the effect fight each other.
        raw = (fx.get("params") or {}).get("rate")
        default = _f(((spec.get("params") or {}).get("rate") or {}).get("default"), 0.0)
        rate = _f(interp.eval_prop(raw, t, None), default)
        if rate <= 0:
            continue
        # floor, not round: a frame is held from its own instant forward, so
        # rounding would show the NEXT step half a step early.
        return math.floor(t * rate) / rate
    return t


def _history(comp, layer, t, scale, size, n, draft, cctx=None):
    """The layer's own source for up to n preceding frames, newest first."""
    if draft:
        return []
    fps = _f(comp.get("fps"), 30.0) or 30.0
    out = []
    for k in range(1, min(int(n), MAX_HISTORY) + 1):
        try:
            px = _layer_pixels(comp, layer, t - k / fps, scale, size,
                               draft=draft, cctx=cctx)
        except Exception:                              # noqa: BLE001
            break
        if px is None:
            break
        out.append(px)
    return out


def _linear_run(stack):
    """For each entry in the effect stack, whether it is the FIRST of a run of
    adjacent light-like effects and whether it is the LAST.

    The conversion costs 110 ms on a 1080p frame — MORE than the glow it wraps
    (87 ms), so paying it per effect would multiply it by the depth of the
    stack and cost more than the effects themselves. A run of
    adjacent light-like effects can share one: decode before the first, run all
    of them on linear pixels, encode after the last. blur + glow + blur is one
    pair rather than three.

    ADJACENT is the operative word, and it is not a simplification. A `curves`
    between two blurs is a code-space operation, so it has to see code values;
    the run genuinely breaks there and the pixels genuinely go back and forth.
    Reordering the stack to group the light-like effects would be cheaper and
    would render a different frame, so it is not done.

    A DISABLED entry does not break a run. It is skipped here exactly as the
    loop below skips it, so [gaussianBlur, invert(disabled), boxBlur] is
    first={0} last={2}: one pair, and the disabled entry is not between them in
    any sense that costs anything.

    AN UNKNOWN TYPE DOES break a run, and this docstring used to claim it did
    not. `effects.linearises` answers False for a name it has never heard of —
    it cannot answer anything else — so the entry lands in `live` with
    is_lin=False and closes the run in front of it exactly as a `curves` would.
    Measured: [gaussianBlur, nosuchEffect, boxBlur] gives first={0, 2},
    last={0, 2}, which is TWO conversion pairs where a stack of two blurs would
    have paid for one.

    That extra pair costs TIME AND NOT PIXELS, which is why it is left alone.
    Its price is the 110 ms above, once more. Its effect on the picture,
    measured by engine_test over gaussianBlur+boxBlur on a solid against the
    same two with the unknown type between them: 0.0000 codes mean, 0.0001 max
    — the decode/encode round trip is its own inverse to float32, and
    `effects.apply` hands the frame straight back for a name that is not in its
    registry, so the milliseconds buy nothing at all. They are spent on a
    document this build cannot render as written.

    Not "fixed" here, because the fix would be a SECOND opinion about names.
    `effects.linearises` exists to be the one place that answers "would apply
    run this in linear light", and for a name it has never heard of the answer
    is honestly no. Teaching engine.py that an unrecognised name is not really
    in the stack would put a rule about the effect registry in the file that
    does not own it, to save five milliseconds on a stack that is already
    wrong. engine_test pins both behaviours.
    """
    live = []
    for i, fx in enumerate(stack):
        if not isinstance(fx, dict) or not fx.get("enabled", True):
            continue
        live.append((i, effects.linearises(str(fx.get("type") or ""))))
    first, last = set(), set()
    for k, (i, is_lin) in enumerate(live):
        if not is_lin:
            continue
        if k == 0 or not live[k - 1][1]:
            first.add(i)
        if k == len(live) - 1 or not live[k + 1][1]:
            last.add(i)
    return first, last


def _apply_effects(rgba, comp, layer, t, scale, draft, size, cctx=None):
    stack = layer.get("effects") or []
    if effects is None or not stack:
        return rgba
    ctx = _effect_ctx(comp, layer, t, scale, draft, size, cctx)
    _fx_notes = ctx["notes"]
    # Only when the comp asked for it: with the switch off this is two empty
    # sets and every line below reads exactly as it did before linear light
    # existed, which is what makes an unchanged document render byte for byte.
    run_first, run_last = _linear_run(stack) if ctx["linear"] else (set(), set())
    in_linear = False
    for ix, fx in enumerate(stack):
        if not isinstance(fx, dict) or not fx.get("enabled", True):
            continue
        name = str(fx.get("type") or "")
        if ix in run_first:
            rgba = colour.decode_rgb(rgba)
            in_linear = True
        # "the pixels are ALREADY linear" — effects.apply must not convert them
        # a second time. Set every pass, not only inside a run, because ctx is
        # one dict reused down the whole stack.
        ctx["linearIn"] = in_linear
        # "effects.<id>", NOT "effects.<id>.params": eval_params derives one child
        # per param, and expressions.py's EffectRef spells a link to a radius
        # "effects.fx_1.radius". The document's `params` nesting is not in that
        # name and putting it there would make a linked effect param a stranger.
        raw_params = fx.get("params")
        bound = _bind(cctx, layer, "effects.%s" % (fx.get("id"),))
        params = interp.eval_params(raw_params, t, bound)
        # particleSystem (and any future effect that re-times its own inputs)
        # samples parameters at each particle's BIRTH time, so closed-form
        # scrubbing needs the curves, not one instant. A callable for the same
        # reason history is one - it costs nothing until called - and the raw
        # dict beside it so the effect can see WHICH params are animated and
        # skip the curve sampling entirely when none are.
        ctx["paramsAt"] = (lambda tt, _raw=raw_params, _b=bound:
                           interp.eval_params(_raw, float(tt), _b))
        ctx["fxParams"] = raw_params
        try:
            out = effects.apply(name, rgba, params, ctx)
        except Exception as exc:                       # noqa: BLE001
            # One bad param must not cost 900 frames. Say so on stderr (stdout is
            # the protocol) and carry the layer through unchanged.
            print(f"vfx: effect {name!r} failed: {exc}", file=sys.stderr)
            out = None
        if isinstance(out, np.ndarray) and out.shape == rgba.shape:
            rgba = np.ascontiguousarray(out, dtype=np.float32)
        # AFTER the failure path, deliberately: an effect that raised in the
        # middle of a linear run leaves the pixels linear, and returning them
        # that way would hand the compositor decoded light to composite as if it
        # were sRGB — a blown-out frame from a broken parameter. The run closes
        # whatever happened inside it.
        if ix in run_last:
            rgba = colour.encode_rgb(rgba)
            in_linear = False
    if in_linear:
        # Unreachable through _linear_run, which always closes a run it opened.
        # Cheap insurance against a future edit that makes it reachable, since
        # the failure mode is a whole render silently in the wrong space.
        rgba = colour.encode_rgb(rgba)
    return rgba


def _mask_alpha(layer, t, w, h, scale, cctx=None):
    """The combined mask coverage for a layer, or None when it has no masks.

    Mask points are applied here — BEFORE the transform — so they are read in the
    layer's own pixel space. For the layers masks are actually drawn on (solids,
    adjustment layers, text: everything comp-sized with an untouched transform)
    layer space and comp space are the same grid, which is what the spec's
    "comp px" annotation describes.
    """
    # The document index is carried alongside, not the filtered one: a mask set to
    # "none" earlier in the stack must not renumber the masks after it, or every
    # expression on them changes seed the moment someone switches one off.
    global _MASK_BYTES
    masks = [(i, m) for i, m in enumerate(layer.get("masks") or [])
             if isinstance(m, dict) and str(m.get("mode") or "add") != "none"]
    if not masks:
        return None

    # Resolve every input the raster depends on BEFORE drawing any of it, and key
    # the cache on those VALUES rather than on a guess about whether the mask is
    # animated. A mask that moves gets a new key and is redrawn; a mask that does
    # not is drawn once for the whole render. That distinction is worth having:
    # fillPoly plus a feather gaussian is 17 ms at 720p, and a static title mask
    # paid it on every frame of every scrub.
    spec = []
    for mi, mk in masks:
        # by id where the document gives one, by position where it does not — a
        # mask has no other stable handle, and the UI numbers them the same way
        at = _at_of(_bind(cctx, layer, "masks.%s" % (mk.get("id") or mi,)))
        spec.append([
            str(mk.get("mode") or "add"),
            mk.get("points") or [],
            _f(interp.eval_prop(mk.get("expand"), t, 0.0, at("expand"))) * scale,
            _f(interp.eval_prop(mk.get("feather"), t, 0.0, at("feather"))) * scale,
            bool(mk.get("invert")),
            max(0.0, min(1.0, _f(interp.eval_prop(mk.get("opacity"), t, 100.0,
                                                  at("opacity")), 100.0) / 100.0)),
        ])
    key = (json.dumps(spec, sort_keys=True, default=str), w, h, round(float(scale), 6))
    hit = _MASKS.get(key)
    if hit is not None:
        _MASKS.move_to_end(key)
        return hit

    has_add = any(str(m.get("mode") or "add") == "add" for _i, m in masks)
    # Only subtract masks means "everything, minus these holes"; the first add
    # mask is what turns the layer off everywhere it does not cover.
    acc = np.zeros((h, w), np.float32) if has_add else np.ones((h, w), np.float32)

    for mode, pts, expand, feather, invert, opacity in spec:
        if len(pts) < 3:
            continue
        poly = np.zeros((h, w), np.uint8)
        arr = np.round(np.asarray(pts, dtype=np.float64)[:, :2] * scale).astype(np.int32)
        cv2.fillPoly(poly, [arr], 255, lineType=cv2.LINE_AA)
        m = poly.astype(np.float32) / 255.0

        if abs(expand) >= 0.5:
            r = int(round(abs(expand)))
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r * 2 + 1, r * 2 + 1))
            m = cv2.dilate(m, k) if expand > 0 else cv2.erode(m, k)
        if feather > 0.1:
            # feather is the full soft band; a gaussian's visible reach is about
            # two sigma either side, so half of it is the sigma to ask for
            m = cv2.GaussianBlur(m, (0, 0), sigmaX=max(0.1, feather / 2.0))
        if invert:
            m = 1.0 - m
        m *= opacity

        if mode == "add":
            acc = np.clip(acc + m, 0.0, 1.0)
        else:
            acc = np.clip(acc - m, 0.0, 1.0)

    _MASKS[key] = acc
    _MASK_BYTES = _trim(_MASKS, _MASK_BYTES + acc.nbytes, _MASK_LIMIT)
    return acc


def _warp(rgba, m, W, H):
    """Place a layer bitmap into comp space, over its bounding box only.

    Region of interest is not an optimisation detail here, it is the difference
    between a 200px badge costing 200px of work and costing a 4K frame of work on
    every one of 240 frames. warpAffine writes into the clipped box and the box
    remembers where it came from.

    Premultiply/unpremultiply around the resample for the same halo reason as
    everywhere else.
    """
    h, w = rgba.shape[:2]
    if interp.is_identity(m) and (w, h) == (W, H):
        return Tile(rgba, 0, 0)
    corners = interp.apply_matrix(m, [[0, 0], [w, 0], [w, h], [0, h]])
    x0 = max(0, int(math.floor(corners[:, 0].min())) - 1)
    y0 = max(0, int(math.floor(corners[:, 1].min())) - 1)
    x1 = min(W, int(math.ceil(corners[:, 0].max())) + 1)
    y1 = min(H, int(math.ceil(corners[:, 1].max())) + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    local = np.array(m, dtype=np.float64, copy=True)
    local[0, 2] -= x0
    local[1, 2] -= y0
    warped = cv2.warpAffine(_premul(rgba), local[:2], (x1 - x0, y1 - y0),
                            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                            borderValue=(0.0, 0.0, 0.0, 0.0))
    return Tile(_unpremul(np.asarray(warped, dtype=np.float32), inplace=True), x0, y0)


# ── 3D: layer matrices, the camera, and the perspective warp ──────────────────

def _rot3(rx, ry, rz):
    """Rx·Ry·Rz from degrees — Z turns first, then Y, then X.

    Y points DOWN the screen and Z points INTO it, which is the coordinate system
    the 2D half of this engine already uses (rotation there turns clockwise as
    seen). So Rz here is exactly interp's 2D rotation and a layer promoted to 3D
    with only `rotation` set does not move a pixel.
    """
    cx, sx = math.cos(math.radians(rx)), math.sin(math.radians(rx))
    cy, sy = math.cos(math.radians(ry)), math.sin(math.radians(ry))
    cz, sz = math.cos(math.radians(rz)), math.sin(math.radians(rz))
    mx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    return mx @ my @ mz


def _auto_orient_basis(v):
    """The 3x3 rotation "orient along path" asks for: local +x onto the tangent.

    The roll freedom is fixed by the comp plane's normal (+z, into the screen):
    y_axis = z_ref x x_axis. For a tangent lying IN the plane that reduces
    exactly to _rot3(0, 0, atan2(vy, vx)) — the same turn the 2D path adds to
    `rotation` — so a planar 3D move matches the 2D layer pixel for pixel,
    including moving LEFT (a 180 degree turn about z, never a mirror: the basis
    is right-handed with det +1, so no composition of it can flip a layer).
    A tangent diving along +-z has no in-plane heading to follow; the world's y
    takes over as the reference and the layer turns edge-on — the same fallback
    rule _look_at uses at its poles.
    """
    f = np.array([_f(v[0]), _f(v[1]), _f(v[2]) if len(v) > 2 else 0.0],
                 dtype=np.float64)
    n = np.linalg.norm(f)
    if n < EPS:
        return np.eye(3)
    f = f / n
    ref = np.array([0.0, 0.0, 1.0])
    if abs(float(f @ ref)) > 0.999:
        ref = np.array([0.0, 1.0, 0.0])
    y = np.cross(ref, f)
    yn = np.linalg.norm(y)
    if yn < EPS:
        return np.eye(3)
    y = y / yn
    z = np.cross(f, y)
    return np.column_stack([f, y, z])


def _layer_angles(transform, t, ctx=None):
    """The three rotation angles, with `rotation` standing in for Z.

    One set of angles, not AE's orientation-plus-rotation pair: the split exists
    so a fixed pose and an animated spin can be keyed separately, and a keyframe
    track on each of three numbers says the same thing with half the schema.

    `rotation` keeps its own name in the binding even where it is standing in for
    Z: it is a different property in the document, and an expression that links
    to a layer's `rotation` has to find the one the author wrote.
    """
    at = _at_of(ctx)
    rz = _f(interp.eval_prop(transform.get("rotationZ"), t,
                             interp.eval_prop(transform.get("rotation"), t, 0.0,
                                              at("rotation")),
                             at("rotationZ")), 0.0)
    return (_f(interp.eval_prop(transform.get("rotationX"), t, 0.0, at("rotationX")), 0.0),
            _f(interp.eval_prop(transform.get("rotationY"), t, 0.0, at("rotationY")), 0.0),
            rz)


def matrix4(layer, t, anchor_default=(0.0, 0.0), position_default=(0.0, 0.0), three_d=False,
            ctx=None):
    """One layer's transform as a 4x4 mapping LAYER px -> COMP/world px.

    For a 2D layer this is the exact embedding of interp.transform_matrix with z
    left alone — which is what makes a 2D layer usable as the PARENT of a 3D one
    without a second code path.

    `ctx` is the layer's "transform" binding, and the row names below are the ones
    interp.transform_matrix uses on the 2D path — the same layer must not answer
    to two different property names depending on whether its 3D switch is on.
    """
    transform = layer.get("transform") or {}
    at = _at_of(ctx)
    ax, ay, az = _triple(interp.eval_prop(transform.get("anchor"), t, None, at("anchor")),
                         (anchor_default[0], anchor_default[1], 0.0))
    px_, py_, pz = _triple(interp.eval_prop(transform.get("position"), t, None, at("position")),
                           (position_default[0], position_default[1], 0.0))
    sx, sy, sz = _triple(interp.eval_prop(transform.get("scale"), t, None, at("scale")),
                         (100.0, 100.0, 100.0))
    rx, ry, rz = _layer_angles(transform, t, ctx)
    if not three_d:
        az, pz, sz, rx, ry = 0.0, 0.0, 100.0, 0.0, 0.0
    lin = _rot3(rx, ry, rz) @ np.diag([sx / 100.0, sy / 100.0, sz / 100.0])
    # Auto-orient composes OUTSIDE the layer's own rotation — AE's order: the
    # path sets the heading, the keyframed rotation is an offset on top of it.
    # It multiplies `lin` before the translation row is derived, so the layer
    # still pivots about its anchor and the anchor still lands exactly on the
    # position. A layer without the switch never reaches this code, and one
    # whose position never moves takes the None and is bit-identical to off.
    # The derivative reads through the SAME position binding the row above just
    # read, so an expression-driven position orients along what it renders.
    if str(layer.get("autoOrient") or "") == "alongPath":
        v = interp.auto_orient_velocity(transform.get("position"), t, at("position"))
        if v is not None and len(v) >= 2:
            if not three_d:
                # the 2D embedding ignores a position track's z, so the
                # heading must too — this is exactly interp's atan2(vy, vx)
                v = [v[0], v[1], 0.0]
            lin = _auto_orient_basis(v) @ lin
    pos = np.array([px_, py_, pz], dtype=np.float64)
    out = np.eye(4, dtype=np.float64)
    out[:3, :3] = lin
    out[:3, 3] = pos - lin @ np.array([ax, ay, az], dtype=np.float64)
    return out


def world_matrix4(layer, by_id, t, defaults=None, bindings=None):
    """A layer's 4x4 with its parent chain applied, outermost ancestor first."""
    chain = interp.parent_chain(layer, by_id)
    m = np.eye(4, dtype=np.float64)
    for lay in reversed(chain):
        anchor_default, position_default = (defaults(lay) if defaults
                                            else ((0.0, 0.0), (0.0, 0.0)))
        m = m @ matrix4(lay, t, anchor_default, position_default,
                        bool(lay.get("threeD")),
                        ctx=bindings(lay) if bindings else None)
    return m


class Camera:
    """Where the comp is being watched from, and through what lens.

    `rot` holds the camera's axes as COLUMNS in world space, so camera-space
    coordinates are (P - pos) @ rot — the transpose falls out of the dot product
    and never has to be formed.
    """

    __slots__ = ("pos", "rot", "zoom", "cx", "cy", "dof", "focus", "aperture", "blur")

    def __init__(self, pos, rot, zoom, cx, cy,
                 dof=False, focus=None, aperture=25.0, blur=100.0):
        self.pos = np.asarray(pos, dtype=np.float64)
        self.rot = np.asarray(rot, dtype=np.float64)
        self.zoom = float(zoom)
        self.cx, self.cy = float(cx), float(cy)
        self.dof = bool(dof)
        self.focus = float(focus if focus else zoom)
        self.aperture = float(aperture)
        self.blur = float(blur)

    def view(self, pts):
        """World points (N,3) into camera space (N,3): x right, y down, z forward."""
        return (np.asarray(pts, dtype=np.float64).reshape(-1, 3) - self.pos) @ self.rot

    def project(self, pts):
        """World points (N,3) -> (screen (N,2) in comp px, camera-space z (N,)).

        Points at or behind the lens come back as NaN rather than as a divide by
        something tiny that lands a corner four million pixels away and takes
        warpPerspective with it.
        """
        v = self.view(pts)
        z = v[:, 2]
        safe = np.where(z > NEAR, z, np.nan)
        out = np.empty((v.shape[0], 2), dtype=np.float64)
        out[:, 0] = self.cx + self.zoom * v[:, 0] / safe
        out[:, 1] = self.cy + self.zoom * v[:, 1] / safe
        return out, z

    def coc(self, z):
        """Circle-of-confusion diameter in comp px for a plane at camera depth z.

        Thin lens, with the focal length in pixels (which is what zoom is) and the
        aperture in the same pixel units AE quotes it in. A layer is a plane, so
        one number describes the whole of it — exact for a layer facing the
        camera, an approximation for one tilted away from it.
        """
        if not self.dof or z <= NEAR or self.focus <= NEAR or self.aperture <= 0.01:
            return 0.0
        return (self.aperture * (self.zoom / self.focus)
                * abs(self.focus - z) / z * (self.blur / 100.0))


def default_camera(comp):
    """AE's camera when the comp has none: 50mm, dead centre, plane z=0 at 1:1.

    zoom = width · 50/36 because AE measures the film back by the comp's WIDTH, so
    the angle of view is the same on any aspect. Parking it at z = -zoom is what
    makes an untouched 3D layer land exactly where the 2D one did — the whole
    reason "make this layer 3D" is not a visible edit until you move it.
    """
    cw = max(1, int(comp.get("width") or 1920))
    ch = max(1, int(comp.get("height") or 1080))
    zoom = cw * DEFAULT_FOCAL_MM / FILM_MM
    return Camera((cw / 2.0, ch / 2.0, -zoom), np.eye(3), zoom, cw / 2.0, ch / 2.0)


def _look_at(forward):
    """Camera axes as columns from a forward vector, with the comp's down as up.

    World y points down the screen, so "down" is the reference the horizon is
    levelled against. Straight up or straight down there is no horizon to level
    against, and z takes over as the reference — which keeps a top-down camera
    from collapsing instead of merely choosing a roll.
    """
    f = np.asarray(forward, dtype=np.float64)
    n = np.linalg.norm(f)
    if n < EPS:
        return np.eye(3)
    f = f / n
    ref = np.array([0.0, 1.0, 0.0])
    if abs(float(f @ ref)) > 0.999:
        ref = np.array([0.0, 0.0, 1.0])
    right = np.cross(ref, f)
    rn = np.linalg.norm(right)
    if rn < EPS:
        return np.eye(3)
    right = right / rn
    down = np.cross(f, right)
    return np.column_stack([right, down, f])


def view_camera(comp, view):
    """A synthetic Camera for a workspace view — Front/Top/Right/…/Custom orbit.

    This is the ONE place a "custom 3D view" is defined, and it is defined in
    terms of the same Camera the renderer projects through — the overlay
    endpoint and the frame renderer both call this, which is what makes a gizmo
    drawn in the Top view land on the pixels the Top view actually renders.

    The views are perspective with a long-ish default lens rather than true
    orthographic, because Camera.project IS the projection this engine has;
    adding a parallel-projection branch would fork the maths the overlay is
    required to share. The default distance is the default camera's own
    (width·50/36) with zoom equal to it, so the plane through the orbit target
    renders 1:1 — Front view of an untouched comp is the comp.

    view: {"name": front|back|top|bottom|left|right|orbit,
           "yaw": deg, "pitch": deg (orbit only),
           "distance": px, "zoom": px, "target": [x,y,z]} — all optional but
    the name. Unknown names fall back to "front" rather than raising: a stale
    URL must cost the viewpoint, never the frame.
    """
    cw = max(1, int(comp.get("width") or 1920))
    ch = max(1, int(comp.get("height") or 1080))
    spec = view if isinstance(view, dict) else {"name": str(view or "front")}
    name = str(spec.get("name") or "front").lower()

    d = _f(spec.get("distance"), 0.0)
    if d <= 0:
        d = cw * DEFAULT_FOCAL_MM / FILM_MM
    zoom = _f(spec.get("zoom"), 0.0)
    if zoom <= 0:
        zoom = d

    target = np.array(_triple(spec.get("target"), (cw / 2.0, ch / 2.0, 0.0)),
                      dtype=np.float64)

    # Forward vectors in the engine's frame: x right, y DOWN, z into the screen.
    FORWARDS = {
        "front": (0.0, 0.0, 1.0),   "back": (0.0, 0.0, -1.0),
        "top": (0.0, 1.0, 0.0),     "bottom": (0.0, -1.0, 0.0),
        "left": (1.0, 0.0, 0.0),    "right": (-1.0, 0.0, 0.0),
    }
    if name == "orbit":
        yaw = math.radians(_f(spec.get("yaw"), 30.0))
        pitch = math.radians(_f(spec.get("pitch"), -25.0))
        # Start from Front's forward and swing it: yaw about the vertical axis,
        # pitch above (negative, since y points down) or below the horizon.
        f = np.array([math.cos(pitch) * math.sin(yaw),
                      math.sin(pitch),
                      math.cos(pitch) * math.cos(yaw)], dtype=np.float64)
    else:
        f = np.array(FORWARDS.get(name, FORWARDS["front"]), dtype=np.float64)

    rot = _look_at(f)
    return Camera(target - d * f, rot, zoom, cw / 2.0, ch / 2.0)


VIEW_NAMES = ("front", "back", "top", "bottom", "left", "right", "orbit")


def active_camera(comp, layers, by_id, t, cctx, visible, in_window):
    """The camera a frame renders through: topmost live camera layer, else AE's
    default. Factored out so the overlay endpoint picks the SAME one."""
    for lay in layers:
        if (str(lay.get("type") or "") == "camera"
                and visible(lay) and in_window(lay)):
            return camera_from(lay, comp, by_id, t, _comp_defaults(comp, cctx), cctx)
    return default_camera(comp)


def camera_from(layer, comp, by_id, t, defaults=None, cctx=None):
    """A Camera out of a camera layer, falling back field by field.

    A camera IS a layer, so its transform binds under the ordinary transform.*
    names and another layer can link to `thisComp.layer("cam").position` and get
    the answer the lens actually used. The lens itself lives under "camera.*",
    which nothing in the expression language can reach yet — but the path is what
    the cycle guard and wiggle's seed key on, so it has to be a real name now.
    """
    cw = max(1, int(comp.get("width") or 1920))
    ch = max(1, int(comp.get("height") or 1080))
    spec = layer.get("camera") if isinstance(layer.get("camera"), dict) else {}
    transform = layer.get("transform") or {}
    cam = _at_of(_bind(cctx, layer, "camera"))
    tr = _bind(cctx, layer, "transform")
    at = _at_of(tr)

    zoom = _f(interp.eval_prop(spec.get("zoom"), t, 0.0, cam("zoom")), 0.0)
    if zoom <= 0.0:
        focal = _f(interp.eval_prop(spec.get("focalLength"), t, 0.0, cam("focalLength")), 0.0)
        zoom = cw * (focal if focal > 0 else DEFAULT_FOCAL_MM) / FILM_MM

    pos = np.array(_triple(interp.eval_prop(transform.get("position"), t, None, at("position")),
                           (cw / 2.0, ch / 2.0, -zoom)), dtype=np.float64)
    poi_raw = spec.get("pointOfInterest")
    poi = (np.array(_triple(interp.eval_prop(poi_raw, t, None, cam("pointOfInterest")),
                            (cw / 2.0, ch / 2.0, 0.0)),
                    dtype=np.float64) if poi_raw is not None else None)

    # A camera can be parented (rigged to a null is how anyone flies one), so its
    # position and its target both have to go through the chain.
    parent = by_id.get(layer.get("parent")) if layer.get("parent") else None
    if isinstance(parent, dict):
        pm = world_matrix4(parent, by_id, t, defaults, _binder(cctx, "transform"))
        pos = (pm @ np.append(pos, 1.0))[:3]
        if poi is not None:
            poi = (pm @ np.append(poi, 1.0))[:3]

    rot = _look_at(poi - pos) if poi is not None else np.eye(3)
    rx, ry, rz = _layer_angles(transform, t, tr)
    if abs(rx) + abs(ry) + abs(rz) > 1e-9:
        rot = rot @ _rot3(rx, ry, rz)

    return Camera(pos, rot, zoom, cw / 2.0, ch / 2.0,
                  dof=bool(interp.eval_prop(spec.get("depthOfField"), t, False,
                                            cam("depthOfField"))),
                  focus=_f(interp.eval_prop(spec.get("focusDistance"), t, 0.0,
                                            cam("focusDistance")), 0.0) or zoom,
                  aperture=_f(interp.eval_prop(spec.get("aperture"), t, 25.0,
                                               cam("aperture")), 25.0),
                  blur=_f(interp.eval_prop(spec.get("blurLevel"), t, 100.0,
                                           cam("blurLevel")), 100.0))


def _quad_area(q):
    x, y = q[:, 0], q[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _warp3(rgba, m4, camera, scale, W, H, draft=False):
    """Place a layer through the camera, over its bounding box only.

    A layer is a PLANE, so its four corners determine the whole mapping exactly —
    which is the one piece of luck in 3D compositing: no per-pixel ray, no depth
    buffer, just a homography from the corners cv2 already knows how to build.

    Returns None when the layer is behind the lens or edge-on, because there is
    no projection of either and a homography fitted to those corners is garbage
    that would be warped into the frame at full brightness.
    """
    h, w = rgba.shape[:2]
    src = np.array([[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]], dtype=np.float64)
    # bitmap px -> comp px -> world -> screen px -> bitmap px again
    layer_pts = src / max(scale, EPS)
    world = (m4 @ np.column_stack(
        [layer_pts, np.zeros(4), np.ones(4)]).T).T[:, :3]
    screen, z = camera.project(world)
    if not np.isfinite(screen).all():
        return None
    dst = screen * scale
    if _quad_area(dst) < 0.5:
        return None

    sigma = 0.0
    if camera.dof and not draft:
        sigma = camera.coc(float(np.mean(z))) * 0.5 * scale
        sigma = min(64.0, sigma)
    pad = int(math.ceil(3.0 * sigma)) + 1 if sigma > 0.05 else 1

    x0 = max(0, int(math.floor(dst[:, 0].min())) - pad)
    y0 = max(0, int(math.floor(dst[:, 1].min())) - pad)
    x1 = min(W, int(math.ceil(dst[:, 0].max())) + pad)
    y1 = min(H, int(math.ceil(dst[:, 1].max())) + pad)
    if x1 <= x0 or y1 <= y0:
        return None
    local = dst - np.array([x0, y0], dtype=np.float64)
    try:
        hm = cv2.getPerspectiveTransform(src.astype(np.float32), local.astype(np.float32))
    except cv2.error:
        return None
    warped = cv2.warpPerspective(_premul(rgba), hm, (x1 - x0, y1 - y0),
                                 flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                                 borderValue=(0.0, 0.0, 0.0, 0.0))
    warped = np.asarray(warped, dtype=np.float32)
    if sigma > 0.05:
        warped = cv2.GaussianBlur(warped, (0, 0), sigmaX=sigma,
                                  borderType=cv2.BORDER_CONSTANT)
        warped = np.asarray(warped, dtype=np.float32)
    return Tile(_unpremul(warped, inplace=True), x0, y0)


def _tile_region(tile, x0, y0, x1, y1):
    """A tile's pixels over an arbitrary box, zero (= transparent) outside it."""
    out = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.float32)
    if tile is None:
        return out
    th, tw = tile.rgba.shape[:2]
    sx0, sy0 = max(x0, tile.x), max(y0, tile.y)
    sx1, sy1 = min(x1, tile.x + tw), min(y1, tile.y + th)
    if sx1 <= sx0 or sy1 <= sy0:
        return out
    out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = \
        tile.rgba[sy0 - tile.y:sy1 - tile.y, sx0 - tile.x:sx1 - tile.x]
    return out


def _average_tiles(tiles):
    """Mean of several sub-time renders of one layer — the motion blur itself.

    Averaged PREMULTIPLIED: a straight-alpha mean of an opaque red pixel and a
    fully transparent one whose colour happens to be black gives half-alpha dark
    red, when the answer is half-alpha red.
    """
    tiles = [t for t in tiles if t is not None]
    if not tiles:
        return None
    if len(tiles) == 1:
        return tiles[0]
    x0 = min(t.x for t in tiles)
    y0 = min(t.y for t in tiles)
    x1 = max(t.x + t.rgba.shape[1] for t in tiles)
    y1 = max(t.y + t.rgba.shape[0] for t in tiles)
    acc = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.float32)
    for t in tiles:
        h, w = t.rgba.shape[:2]
        acc[t.y - y0:t.y - y0 + h, t.x - x0:t.x - x0 + w] += _premul(t.rgba)
    acc /= float(len(tiles))
    return Tile(_unpremul(acc, inplace=True), x0, y0)


def _blur_times(comp, layer, t, draft):
    """Sub-times to sample for motion blur, or just [t] when it is off.

    The shutter angle is degrees of a 360-degree rotary shutter, so 180 means the
    frame is exposed for half its duration. Midpoint sampling rather than
    endpoint: N samples spread evenly INSIDE the window, so no sample sits on the
    boundary and gets double-weighted by the neighbouring frame.
    """
    mb = comp.get("motionBlur") or {}
    if draft or not mb.get("enabled") or not layer.get("motionBlur"):
        return [t]
    samples = int(_f(mb.get("samples"), 8.0))
    samples = max(1, min(64, samples))
    if samples == 1:
        return [t]
    fps = _f(comp.get("fps"), 30.0) or 30.0
    window = (_f(mb.get("shutter"), 180.0) / 360.0) / fps
    if window <= 0:
        return [t]
    return [t - window / 2.0 + window * (i + 0.5) / samples for i in range(samples)]


def _comp_defaults(comp, cctx):
    """The (anchor, position) fallbacks every layer in this comp gets."""
    cw, ch = int(comp.get("width") or 1920), int(comp.get("height") or 1080)

    def defaults(lay):
        lw, lh = _layer_native_size(comp, lay, cctx)
        return (lw / 2.0, lh / 2.0), (cw / 2.0, ch / 2.0)
    return defaults


def _collapse_scale(layer, m, draft):
    """How much bigger than nominal a collapsed precomp should be rasterised.

    Continuous rasterisation, and the whole of what "collapse transformations"
    means here: render the child at the size it will actually be SEEN at, so
    blowing a precomp up shows the child's own detail instead of the 100%
    raster's pixels. Matching AE, an effect, a mask or a matte on the layer
    forces a raster at comp size — those all need a fixed grid to work on.
    """
    if not layer.get("collapse") or str(layer.get("type") or "") != "comp":
        return 1.0
    if draft or layer.get("effects") or layer.get("masks") or layer.get("trackMatte"):
        return 1.0
    if layer.get("threeD"):
        return 1.0                                     # perspective has no one scale
    lin = np.asarray(m, dtype=np.float64)[:, :2]
    try:
        largest = float(np.linalg.svd(lin, compute_uv=False)[0])
    except np.linalg.LinAlgError:
        return 1.0
    if not math.isfinite(largest):
        return 1.0
    return max(1.0, min(MAX_COLLAPSE, largest))


def _layer_tile(comp, layer, t, scale, draft, size, by_id, apply_fx=True, cctx=None,
                camera=None, rig=None):
    """One layer at one instant, in comp space: effects, masks, styles, transform.

    That order is the contract and it is also AE's: the effect stack sees the
    layer at its own resolution before any transform has resampled it, which is
    why a blur radius means the same thing whatever the layer is scaled to. Layer
    styles sit at the end of that queue and still before the transform, so a
    shadow is carried through it rather than stamped on afterwards.

    The transform is computed FIRST now, before a single pixel exists: a collapsed
    precomp has to know how big it will be drawn before it decides what size to
    render itself at.
    """
    W, H = size
    defaults = _comp_defaults(comp, cctx)
    # One binder for the whole parent chain, both paths: the 2D and 3D walkers
    # have to name a layer's rows identically or a link to a parent's position
    # would resolve to a different property depending on the child's 3D switch.
    bindings = _binder(cctx, "transform")
    three_d = bool(layer.get("threeD")) and camera is not None
    m4 = m = None
    if three_d:
        m4 = world_matrix4(layer, by_id, t, defaults, bindings)
    else:
        m = interp.world_matrix(layer, by_id, t, defaults=defaults, bindings=bindings)

    extra = _collapse_scale(layer, m, draft) if m is not None else 1.0
    # The transform above already used the true t; only the CONTENT is snapped,
    # and its EFFECTS share that instant — otherwise posterizeTime's own
    # history-based hold runs at the true t and puts back the variation the
    # snap just took out.
    ct = _snap_time(layer, t)
    px = _layer_pixels(comp, layer, ct, scale, size,
                       draft=draft, cctx=cctx, extra=extra)
    if px is None:
        return None
    # _layer_pixels can hand back a CACHED array — a still, a text raster — so
    # nothing below may write into `px` until some step has replaced it with a
    # buffer this call made. Every step that does says so, and the last one
    # (opacity) is then free to scale alpha where it lies instead of copying a
    # whole tile to do it.
    owned = False
    if apply_fx and effects is not None and (layer.get("effects") or []):
        # _layer_pixels can hand back a CACHED array (a still, a text raster).
        # The effects contract says not to mutate its input, but one effect that
        # does would poison that cache for every later frame — a copy here is far
        # cheaper than debugging that.
        px = _apply_effects(px.copy(), comp, layer, ct, scale, draft,
                            (px.shape[1], px.shape[0]), cctx)
        owned = True

    mask = _mask_alpha(layer, t, px.shape[1], px.shape[0], scale * extra, cctx)
    if mask is not None:
        px = px.copy()
        px[..., 3] *= mask
        owned = True

    if apply_fx and layer.get("styles"):
        styled = _apply_styles(px, layer, t, scale * extra, draft, cctx)
        # a styles dict whose every entry is disabled (or throws) hands the same
        # array straight back, so identity is the only honest test here
        owned = owned or styled is not px
        px = styled

    if three_d:
        # Shading happens in the layer's OWN space, before the warp resamples
        # it: a plane's normal is constant, so the lighting is exact here and
        # would only be interpolated afterwards. Returns the input array itself
        # when there is nothing to do, which is what makes this safe to call
        # unconditionally.
        if lights is not None and rig is not None:
            px = lights.shade(px, m4, camera, rig, layer, scale=scale, draft=draft,
                              linear=_linear_light(comp, cctx))
        tile = _warp3(px, m4, camera, scale, W, H, draft)
    else:
        mm = interp.scale_matrix(m, scale)
        if extra != 1.0:
            # the bitmap came back `extra` times bigger than the document says, so
            # the mapping out of it has to be that much smaller
            mm = np.array(mm, dtype=np.float64, copy=True)
            mm[:, :2] /= extra
        tile = _warp(px, mm, W, H)
    if tile is None:
        return None

    transform = layer.get("transform") or {}
    # The bare `layer.opacity` fallback binds under its own name, not under
    # transform.opacity: they are two places a document can put the number and
    # the seed must follow whichever one the author actually wrote in.
    op = interp.eval_prop(transform.get("opacity"), t,
                          interp.eval_prop(layer.get("opacity"), t, 100.0,
                                           _bind(cctx, layer, "opacity")),
                          _bind(cctx, layer, "transform.opacity"))
    op = max(0.0, min(1.0, _f(op, 100.0) / 100.0))
    if op < 1.0 - 1e-6:
        if op <= 0.0:
            return None
        if not (owned or tile.rgba is not px):
            # _warp hands its input back untouched when the matrix is identity
            # and the sizes already match, and that input may be the raster
            # cache. Only then is the copy real work rather than superstition.
            tile = Tile(tile.rgba.copy(), tile.x, tile.y)
        tile.rgba[..., 3] *= op
    return tile


def _layer_tile_blurred(comp, layer, t, scale, draft, size, by_id, apply_fx=True,
                        cctx=None, camera=None, rig=None):
    times = _blur_times(comp, layer, t, draft)
    if len(times) == 1:
        return _layer_tile(comp, layer, times[0], scale, draft, size, by_id, apply_fx,
                           cctx=cctx, camera=camera, rig=rig)
    return _average_tiles([_layer_tile(comp, layer, st, scale, draft, size, by_id,
                                       apply_fx, cctx=cctx, camera=camera, rig=rig)
                           for st in times])


def _layer_depth(comp, layer, by_id, t, camera, cctx):
    """How far the layer's centre is from the camera, for the back-to-front sort."""
    lw, lh = _layer_native_size(comp, layer, cctx)
    m4 = world_matrix4(layer, by_id, t, _comp_defaults(comp, cctx), _binder(cctx, "transform"))
    world = m4 @ np.array([lw / 2.0, lh / 2.0, 0.0, 1.0], dtype=np.float64)
    return float(camera.view(world[:3])[0, 2])


def _over_preserve(acc, tile, mode="normal", linear=False):
    """AE's T switch: colour what is already there, add no coverage at all.

    Capping the source alpha at the backdrop's is NOT this — source-over still
    grows alpha from anything under 1, so a layer over a half-covered backdrop
    would come out at three quarters. The switch says the backdrop's alpha is the
    answer, full stop: the colour mixes by the layer's own alpha and the coverage
    never moves. Where the backdrop is empty that alpha is zero, which is what
    makes the layer vanish there without a second test.
    """
    h, w = tile.rgba.shape[:2]
    dst = acc[tile.y:tile.y + h, tile.x:tile.x + w]
    with _Planes() as sc:
        sp = sc.split(tile.rgba)
        a_s, cs = sp[3], sp[:3]
        cb = sc.split(dst, 3)
        if mode and mode != "normal":
            bl = _blend_rgb(cb, cs, mode, sc, linear)
            cs = [np.clip(bl[k], 0.0, 1.0, out=sc.like(a_s)) for k in range(3)]
        for k in range(3):
            t = sc.like(a_s)
            np.subtract(cs[k], cb[k], out=t)
            np.multiply(t, a_s, out=t)
            np.add(cb[k], t, out=t)
            dst[..., k] = t


def _stencil_alpha(acc, tile, mode, W, H):
    """Re-shape everything already painted, the way AE's four stencil modes do.

    A track matte reaches ONE layer down; these reach the whole accumulated frame,
    which is why they are applied to `acc` itself and the layer is never drawn.
    Outside the layer's tile a stencil is zero (nothing survives where the stencil
    is not) and a silhouette is one (nothing is cut where the layer is not), so
    only the stencils have to touch the whole frame.
    """
    region = _tile_region(tile, 0, 0, W, H) if tile is not None else None
    with _Planes() as sc:
        if region is None:
            cover = np.zeros((H, W), dtype=np.float32)
        elif mode.endswith("Luma"):
            cover = _lum(sc.split(region, 3), sc)
            np.multiply(cover, region[..., 3], out=cover)
        else:
            cover = region[..., 3]
        if not mode.startswith("stencil"):
            inv = sc.plane((H, W))
            np.subtract(1.0, cover, out=inv)
            cover = inv
        acc[..., 3] *= cover


# ── layer styles ──────────────────────────────────────────────────────────────

# Photoshop's composite order, bottom of the visual stack first: an overlay
# recolours the fill, the two inside styles sit on top of that, the stroke rides
# the edge, and the two outside styles land behind everything. AE inherited it
# whole, and getting it wrong shows the instant two styles are on at once.
STYLE_ORDER = ("colorOverlay", "innerGlow", "innerShadow", "stroke",
               "outerGlow", "dropShadow")


def _style_blur(a, size, sigma_floor=0.05):
    if size <= sigma_floor:
        return a
    return cv2.GaussianBlur(a, (0, 0), sigmaX=max(0.05, size / 2.0),
                            borderType=cv2.BORDER_CONSTANT)


def _morph(a, radius, grow):
    r = int(round(abs(radius)))
    if r < 1:
        return a
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r * 2 + 1, r * 2 + 1))
    return cv2.dilate(a, k) if grow else cv2.erode(a, k)


def _tint_inside(rgba, cov, color):
    """Paint `color` over the layer's own colour by coverage, alpha untouched.

    Straight alpha is what makes the three inside-the-matte styles one line: they
    never change what the layer covers, only what colour is there, so there is no
    premultiplied round trip and no compositing to do.
    """
    out = rgba.copy()
    c = np.asarray(color[:3], dtype=np.float32)
    w = np.clip(cov, 0.0, 1.0).astype(np.float32)
    inv = 1.0 - w
    for k in range(3):                       # per channel: see the planar note
        ch = out[..., k]
        np.multiply(ch, inv, out=ch)
        ch += c[k] * w
    return out


def _style_inner_shadow(rgba, p, scale, draft):
    a = np.ascontiguousarray(rgba[..., 3])
    opacity = _f(p.get("opacity"), 55.0) / 100.0
    if opacity <= 0.005:
        return rgba
    h, w = a.shape[:2]
    hole = 1.0 - _morph(a, _f(p.get("choke"), 0.0) * scale, grow=True)
    th = math.radians(_f(p.get("angle"), 45.0))
    dist = _f(p.get("distance"), 8.0) * scale
    dx, dy = dist * math.cos(th), dist * math.sin(th)
    if abs(dx) > 0.01 or abs(dy) > 0.01:
        m = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
        hole = cv2.warpAffine(hole, m, (w, h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=1.0)
    hole = _style_blur(np.ascontiguousarray(hole), _f(p.get("size"), 10.0) * scale)
    cov = np.clip(hole, 0.0, 1.0) * a * opacity
    return _tint_inside(rgba, cov, _rgba01(p.get("color"), (0.0, 0.0, 0.0, 1.0)))


def _style_inner_glow(rgba, p, scale, draft):
    a = np.ascontiguousarray(rgba[..., 3])
    opacity = _f(p.get("opacity"), 60.0) / 100.0
    if opacity <= 0.005:
        return rgba
    core = _morph(a, _f(p.get("choke"), 0.0) * scale, grow=False)
    soft = _style_blur(np.ascontiguousarray(core), _f(p.get("size"), 16.0) * scale)
    cov = np.clip(a - soft, 0.0, 1.0) * a * opacity
    return _tint_inside(rgba, cov, _rgba01(p.get("color"), (1.0, 1.0, 0.8, 1.0)))


def _style_color_overlay(rgba, p, scale, draft):
    opacity = _f(p.get("opacity"), 100.0) / 100.0
    if opacity <= 0.005:
        return rgba
    cov = np.full(rgba.shape[:2], opacity, dtype=np.float32)
    return _tint_inside(rgba, cov, _rgba01(p.get("color"), (1.0, 0.0, 0.0, 1.0)))


def _fx_style(name, rgba, params, draft):
    """A style that effects.py already computes exactly — do not fork the maths.

    NO `linear` IN THIS CTX, deliberately. The three styles that come through
    here are dropShadow, stroke and outerGlow (a drop shadow thrown zero
    distance), and all three blur an ALPHA and composite ONE flat colour through
    it. A premultiplied blur of a single colour is exactly space-independent, so
    they measure 0.00 codes either way — effects_test pins that — and none of
    them is in effects.LINEAR_LIGHT. Passing the switch here would buy nothing
    and cost a transfer pair per style.
    """
    if effects is None:
        return rgba
    out = effects.apply(name, rgba, params, {"draft": bool(draft)})
    return np.ascontiguousarray(out, dtype=np.float32) if isinstance(out, np.ndarray) else rgba


def _style_drop_shadow(rgba, p, scale, draft):
    return _fx_style("dropShadow", rgba, {
        "color": [c * 255.0 for c in _rgba01(p.get("color"), (0.0, 0.0, 0.0, 1.0))[:3]],
        "opacity": _f(p.get("opacity"), 55.0),
        "distance": _f(p.get("distance"), 12.0) * scale,
        "angle": _f(p.get("angle"), 45.0),
        "softness": _f(p.get("size"), 10.0) * scale,
        "spread": _f(p.get("spread"), 0.0) * scale,
        "shadowOnly": bool(p.get("shadowOnly")),
    }, draft)


def _style_outer_glow(rgba, p, scale, draft):
    # A Photoshop outer glow IS a drop shadow thrown zero distance in a bright
    # colour. effects.py's `glow` is a threshold bloom off the layer's own
    # brightness, which is a different look and does not follow the matte.
    return _fx_style("dropShadow", rgba, {
        "color": [c * 255.0 for c in _rgba01(p.get("color"), (1.0, 0.9, 0.6, 1.0))[:3]],
        "opacity": _f(p.get("opacity"), 60.0),
        "distance": 0.0, "angle": 0.0,
        "softness": _f(p.get("size"), 16.0) * scale,
        "spread": _f(p.get("spread"), 0.0) * scale,
        "shadowOnly": False,
    }, draft)


def _style_stroke(rgba, p, scale, draft):
    return _fx_style("stroke", rgba, {
        "color": [c * 255.0 for c in _rgba01(p.get("color"), (1.0, 1.0, 1.0, 1.0))[:3]],
        "width": max(1.0, _f(p.get("size"), 4.0) * scale),
        "position": str(p.get("position") or "outside"),
        "opacity": _f(p.get("opacity"), 100.0),
        "feather": _f(p.get("feather"), 0.0) * scale,
    }, draft)


STYLES = {
    "colorOverlay": _style_color_overlay,
    "innerGlow": _style_inner_glow,
    "innerShadow": _style_inner_shadow,
    "stroke": _style_stroke,
    "outerGlow": _style_outer_glow,
    "dropShadow": _style_drop_shadow,
}


def _apply_styles(rgba, layer, t, scale, draft, cctx=None):
    """The layer's styles, after its effects and before its transform.

    That is AE's order, and before the transform is the half that matters: the
    style comes off the layer's own matte in the layer's own pixels, so it is
    carried through the transform with everything else. A shadow on a rotating
    card rotates with the card. Run these after the transform instead and every
    style becomes a screen-space decal that ignores what the layer is doing.
    """
    styles = layer.get("styles")
    if not isinstance(styles, dict) or not styles:
        return rgba
    for name in STYLE_ORDER:
        spec = styles.get(name)
        if not isinstance(spec, dict) or spec.get("enabled") is False:
            continue
        # a style has no id — its NAME is its identity, and it is unique by
        # construction because `styles` is a dict keyed by exactly these names
        params = interp.eval_params(spec, t, _bind(cctx, layer, "styles." + name))
        try:
            out = STYLES[name](rgba, params, scale, draft)
        except Exception as exc:                       # noqa: BLE001
            # Same rule as the effect stack: one bad number must not cost the
            # render, and stdout is the protocol.
            print(f"vfx: layer style {name!r} failed: {exc}", file=sys.stderr)
            continue
        if isinstance(out, np.ndarray) and out.shape == rgba.shape:
            rgba = np.ascontiguousarray(out, dtype=np.float32)
    return rgba


def _matte_factor(matte_rgba, kind):
    """AE's four matte flavours, as a 0..1 multiplier on the layer's alpha."""
    kind = str(kind or "alpha").lower()
    a = matte_rgba[..., 3:4]
    if kind.startswith("luma"):
        # transparent parts of a luma matte read as black, which is what makes a
        # white shape on nothing behave the way everyone expects
        v = np.empty(matte_rgba.shape[:2] + (1,), dtype=np.float32)
        with _Planes() as sc:
            np.multiply(_lum(sc.split(matte_rgba, 3), sc), matte_rgba[..., 3],
                        out=v[..., 0])
    else:
        v = a
    return 1.0 - v if kind.endswith("inv") else v


def _depth_sorted(paint, layers, comp, by_id, t, camera, cctx):
    """The paint order with each run of adjacent 3D layers sorted back to front.

    AE's rule, and the reason it is a RUN and not the whole stack: a 2D layer has
    no depth to sort by, so it holds its place and divides the 3D layers either
    side of it into groups that sort among themselves. `paint` arrives bottom-up,
    so within a run the farthest layer has to come first.
    """
    out = []
    run = []

    def flush():
        if run:
            out.extend(sorted(run, key=lambda i: -_layer_depth(
                comp, layers[i], by_id, t, camera, cctx)))
            run.clear()

    for i in paint:
        if layers[i].get("threeD"):
            run.append(i)
        else:
            flush()
            out.append(i)
    flush()
    return out


def render_frame(comp, t, scale=1.0, draft=False, size=None, _cctx=None, view=None):
    """The comp at time t as float32 (H, W, 4) straight-alpha RGBA.

    `view` overrides the ACTIVE CAMERA with a workspace view (see view_camera):
    3D layers are projected from Front/Top/Right/an orbit instead of through the
    comp's own camera. 2D layers keep their place — they never go through a
    camera, in any view, which is AE's rule too. A comp with no 3D layers
    renders identically under every view. Nested comps keep their OWN cameras:
    the override applies to the comp being viewed, not to documents inside it.
    """
    cw = max(1, int(comp.get("width") or 1920))
    ch = max(1, int(comp.get("height") or 1080))
    scale = max(0.01, min(4.0, float(scale)))
    if size:
        W, H = max(1, int(size[0])), max(1, int(size[1]))
        scale = W / float(cw)
    else:
        W, H = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    size = (W, H)
    # ONE env per frame, not per property: it carries the cycle set, the depth
    # counter, the work budget and the error log, and every one of those is only
    # meaningful across the whole frame. A nested comp gets its own, built in
    # _descend, which is why this is the `or` branch and not an unconditional.
    cctx = _cctx or CompCtx(library=_comp_library(comp),
                            chain=(_comp_identity(comp),),
                            env=_new_env(comp))

    bg = _rgba01(comp.get("bg"), (0.0, 0.0, 0.0, 0.0))
    if any(bg):
        acc = np.empty((H, W, 4), dtype=np.float32)
        acc[:] = bg
    else:
        # Broadcasting a 4-tuple across (H, W, 4) is a stride-0 inner loop and
        # costs 4 ms at 720p; calloc hands back zeroed pages for nothing. The
        # default comp background IS transparent, so this is the usual path.
        acc = np.zeros((H, W, 4), dtype=np.float32)

    layers = [l for l in (comp.get("layers") or []) if isinstance(l, dict)]
    by_id = {l.get("id"): l for l in layers if l.get("id")}
    solo_on = any(l.get("solo") for l in layers)
    # Read once and carried, not asked per layer: it is a document field and a
    # frame cannot change its mind halfway down the stack. RESOLVED against the
    # parent, so a precomp that never said anything blends the way the document
    # containing it does.
    linear = _linear_light(comp, cctx)

    # A matte layer is consumed by the layer below it and never painted itself —
    # and that holds whatever its own visibility switch says, because AE turns
    # that switch off for you the moment you assign a matte.
    consumed = set()
    for i, lay in enumerate(layers):
        if isinstance(lay.get("trackMatte"), dict) and i > 0:
            consumed.add(i - 1)

    def visible(lay):
        if solo_on:
            return bool(lay.get("solo"))
        return lay.get("enabled", True) is not False

    def in_window(lay):
        start = _f(lay.get("start"), 0.0)
        end = _f(lay.get("end"), _f(comp.get("duration"), 0.0))
        return (t >= start - EPS) and (t < end - EPS)

    # layers[0] paints LAST — walk the stack from the bottom up. Audio layers
    # are skipped with the other pixel-less kinds: their contribution is the
    # soundtrack, mixed once per render rather than once per frame.
    paint = [i for i in range(len(layers) - 1, -1, -1)
             if i not in consumed
             and str(layers[i].get("type") or "image") not in ("null", "camera", "light", "audio")
             and visible(layers[i]) and in_window(layers[i])]

    # The light rig, on the same terms as the camera: once per frame, only if
    # the comp has lights, and threaded down rather than rebuilt per layer.
    rig = None
    if lights is not None:
        try:
            rig = lights.rig(
                layers, t, comp=comp, visible=visible,
                # The light's PARENT chain, not its own transform — lights.py
                # applies the light's own position itself.
                parent_of=lambda lay: (
                    world_matrix4(by_id[lay["parent"]], by_id, t,
                                  _comp_defaults(comp, cctx),
                                  _binder(cctx, "transform"))
                    if by_id.get(lay.get("parent")) else None),
                bind=lambda lay, path: _bind(cctx, lay, path))
        except Exception:                              # noqa: BLE001
            rig = None                                 # unlit beats unrendered

    camera = None
    if any(lay.get("threeD") for lay in layers):
        # Built only when something asks: a comp of 2D layers must not pay for a
        # camera, and must not be able to be changed by one either. Every layer
        # rather than every PAINTED layer, because a track matte is rendered
        # without ever being painted and a 3D one still needs the lens.
        # A `view` override replaces the active camera outright — the workspace
        # views exist to look at the SCENE from elsewhere, cameras included.
        camera = (view_camera(comp, view) if view
                  else active_camera(comp, layers, by_id, t, cctx, visible, in_window))
        paint = _depth_sorted(paint, layers, comp, by_id, t, camera, cctx)

    for i in paint:
        lay = layers[i]
        kind = str(lay.get("type") or "image")

        matte_spec = lay.get("trackMatte") if isinstance(lay.get("trackMatte"), dict) else None
        matte_tile = None
        if matte_spec and i > 0:
            matte_tile = _layer_tile_blurred(comp, layers[i - 1], t, scale, draft, size,
                                             by_id, cctx=cctx, camera=camera, rig=rig)

        if kind == "adjustment":
            # An adjustment layer's own pixels are only a region; the effects run
            # on everything already accumulated beneath it. Full-frame rather than
            # ROI-only so a blur inside the region still samples what surrounds it.
            region = _layer_tile_blurred(comp, lay, t, scale, draft, size, by_id,
                                         apply_fx=False, cctx=cctx, camera=camera, rig=rig)
            if region is None:
                continue
            cover = _tile_region(region, 0, 0, W, H)[..., 3]
            if matte_tile is not None:
                cover = cover * _matte_factor(
                    _tile_region(matte_tile, 0, 0, W, H),
                    str(matte_spec.get("type") or "alpha"))[..., 0]
            processed = _apply_effects(acc.copy(), comp, lay, t, scale, draft, size, cctx)
            # `acc *= (1 - cover)` with a (H, W, 1) cover is the stride-0
            # broadcast the planar note opens with, twice, over the whole frame —
            # 70 ms a frame at 1080p for an adjustment layer that draws nothing
            inv = 1.0 - cover
            for k in range(4):
                ch = acc[..., k]
                np.multiply(ch, inv, out=ch)
                ch += processed[..., k] * cover
            continue

        tile = _layer_tile_blurred(comp, lay, t, scale, draft, size, by_id,
                                   cctx=cctx, camera=camera, rig=rig)
        if tile is None:
            continue
        if matte_tile is not None:
            h, w = tile.rgba.shape[:2]
            factor = _matte_factor(
                _tile_region(matte_tile, tile.x, tile.y, tile.x + w, tile.y + h),
                str(matte_spec.get("type") or "alpha"))
            rgba = tile.rgba.copy()
            rgba[..., 3:4] *= factor
            tile = Tile(rgba, tile.x, tile.y)
        elif matte_spec:
            # a matte was asked for and there is no layer above to be one; AE
            # shows nothing rather than quietly ignoring the switch
            continue

        blend = str(lay.get("blend") or "normal")
        if blend in STENCIL_MODES:
            _stencil_alpha(acc, tile, blend, W, H)
            continue
        if lay.get("preserveTransparency"):
            _over_preserve(acc, tile, blend, linear)
            continue
        _over(acc, tile, blend, linear)

    # A refused or broken expression is a warning, never a failed frame — but a
    # silent one would leave "my expression does nothing" indistinguishable from
    # "expressions are not wired in", which is the exact bug this whole seam
    # exists to have fixed. Deduped by the env, so a 240-frame render of one typo
    # is 240 lines and not 240 x however many properties read it.
    env = _env(cctx)
    if env is not None:
        for msg in env.take_errors():
            print("vfx: " + msg, file=sys.stderr)

    # in place: acc is ours and a spare 1080p float32 copy per frame is 33 MB of
    # nothing
    return np.clip(acc, 0.0, 1.0, out=acc)


def to_uint8(rgba):
    return (np.clip(rgba, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


# ── audio ─────────────────────────────────────────────────────────────────────
#
# A movie render carries the comp's SOUND as well as its pictures. The mix is
# built once per render — not once per frame — from the same document the paint
# loop reads: an `audio` layer contributes its file, a `video` layer its own
# audio track, and a `comp` layer the mix of its child comp, with the parent
# layer's trim, timeScale and audioLevels applied on top, recursively to the
# same MAX_COMP_DEPTH the pictures allow.
#
# The idiom is server/timelinemix.py's, deliberately: PyAV decodes, an
# AudioResampler normalises rate/layout/format, numpy applies the gain envelope
# and sums, PyAV encodes. That is the atrim/adelay/volume/amix chain an ffmpeg
# CLI would run — done with the libraries this engine already ships, because
# this app promises never to need a binary on the PATH (see workflow.js).
#
# Per-layer timing follows _source_time's rule exactly: source position is
# inPoint + (t - start) * timeScale. timeScale != 1 resamples the sound — a
# speed change WITH the pitch shift, which is what AE's time-stretch does to
# audio — and a negative timeScale plays it backwards, like the picture.
# Past either end of the source the audio is SILENT: the picture holds its
# last frame there, but a held audio sample is a buzz nobody asked for.
#
# What refuses, and why, all loudly:
#   * timeRemap on a layer whose audio is live — a remapped picture over
#     unremapped audio is a lie, and scrubbing sound through the curve is out
#     of v1. The error names the way out: set the layer's "audio" switch to
#     false (the picture then remaps, silent) or remove the curve.
#   * an `audio` layer whose file has no audio stream — a broken source, not
#     a silent choice.
# A VIDEO layer whose file has no audio track contributes nothing and says
# nothing: most generated clips are silent and that is the normal case.
#
# Expressions on audioLevels are NOT run — the sandbox is per-frame machinery
# and the mix is per-render — so eval_prop falls back to the keys or value
# underneath, exactly what the UI's JS mirror shows.
#
# No audio EFFECTS (reverb, EQ, ...) in v1 — levels only, and it says so in
# docs/VFX.md rather than pretending the effect stack reaches the sound.

AUDIO_RATE = 48000
AUDIO_DB_MIN, AUDIO_DB_MAX = -48.0, 12.0

_REMAP_AUDIO_MSG = (
    "{name!r} is time-remapped and carries audio. v1 renders the remapped "
    "PICTURE but does not scrub audio through a remap curve, and a remapped "
    "picture over straight audio would be a lie. Set the layer's \"audio\" "
    "switch to false to render it silent, or remove the timeRemap.")


def _decode_audio(path, rate):
    """(2, N) float32 stereo at `rate`, or None when the file has no audio
    stream.

    None rather than a refusal because for a VIDEO layer a soundless file is
    the normal case; the caller knows which kind it is holding and an `audio`
    layer turns the None into a loud error. One resampler does rate, layout
    and format at once — timelinemix.decode's argument: summing a 44.1 kHz
    FLAC against the 48 kHz track of an MP4 without it is the chipmunk bug.
    """
    container = av.open(path)
    try:
        if not container.streams.audio:
            return None
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
        parts = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                parts.append(out.to_ndarray())
        for out in resampler.resample(None):
            parts.append(out.to_ndarray())
    finally:
        container.close()
    if not parts:
        return np.zeros((2, 0), dtype=np.float32)
    return np.concatenate(parts, axis=1).astype(np.float32, copy=False)


def _has_audio_stream(path, probe):
    """Stream presence only — no decoding. Cheap enough to answer a refusal."""
    if path not in probe:
        try:
            c = av.open(path)
            try:
                probe[path] = bool(c.streams.audio)
            finally:
                c.close()
        except Exception:                              # noqa: BLE001
            probe[path] = False
    return probe[path]


def _audio_on(layer):
    """The layer's audio switch. Absent means on, the same shape as enabled."""
    return layer.get("audio", True) is not False


def _audible_layers(comp):
    """The audio-capable layers the mix reads, under the paint loop's own
    visibility rule: solo beats enabled, per comp."""
    layers = [l for l in (comp.get("layers") or []) if isinstance(l, dict)]
    solo_on = any(l.get("solo") for l in layers)
    out = []
    for layer in layers:
        if str(layer.get("type") or "image") not in ("audio", "video", "comp"):
            continue
        if solo_on:
            if not layer.get("solo"):
                continue
        elif layer.get("enabled", True) is False:
            continue
        if not _audio_on(layer):
            continue
        out.append(layer)
    return out


def _subtree_has_audio(comp, cctx, probe):
    """Whether this comp can reach any audio-bearing source at all.

    Answers two questions the mixer needs before doing any work: whether a
    time-remapped comp layer must be refused (only when there is sound to
    lie about), and — through render_audio — whether the movie should carry
    an audio track at all.
    """
    for layer in _audible_layers(comp):
        kind = str(layer.get("type") or "image")
        if kind == "audio":
            return True
        if kind == "video":
            src = str(layer.get("src") or "")
            if src and _has_audio_stream(src, probe):
                return True
        else:
            try:
                child = _child_comp(layer, cctx)
                sub = _descend(child, layer, cctx)
            except ValueError:
                # a cycle or a missing child fails the mix on its own terms;
                # here it simply cannot prove there is sound
                continue
            if _subtree_has_audio(child, sub, probe):
                return True
    return False


def _audio_gain_env(levels, a, n, rate):
    """Linear gain per output sample from audioLevels in dB, starting at comp
    time `a`.

    The curve is read through interp.eval_prop — the SAME evaluator every
    pictured property uses, so an ease on a fade sounds the way it looks —
    sampled every 64 samples (1.3 ms at 48 kHz) and linearly interpolated
    between. Per-sample eval_prop would be 48 000 python calls a second; a
    64-sample staircase would zipper. This is neither.
    """
    if levels is None:
        return np.float32(1.0)
    if not isinstance(levels, dict):
        db = min(max(_f(levels, 0.0), AUDIO_DB_MIN), AUDIO_DB_MAX)
        return np.float32(10.0 ** (db / 20.0))
    step = 64
    edges = np.arange(0.0, n + step, step)
    dbs = np.array([min(max(_f(interp.eval_prop(levels, a + min(e, n) / rate, 0.0), 0.0),
                            AUDIO_DB_MIN), AUDIO_DB_MAX) for e in edges])
    env = np.interp(np.arange(n, dtype=np.float64), edges, dbs)
    return (10.0 ** (env / 20.0)).astype(np.float32)


def _mix_comp_audio(comp, t0, t1, rate, cctx, pcm, probe, found):
    """The comp's sound over [t0, t1) as (2, n) float32. amix with
    normalize=0: the layers simply sum, and the top-level clip is the rail.

    `found` is a one-element counter of audio-bearing sources actually
    reached — the difference between "this comp genuinely has no sound"
    (the movie muxes exactly as it did before audio existed) and "it has
    sound that happens to be silent" (a real, silent track).
    """
    n = max(0, int(round((t1 - t0) * rate)))
    bus = np.zeros((2, n), dtype=np.float32)
    dur = _f(comp.get("duration"), 0.0)

    for layer in _audible_layers(comp):
        kind = str(layer.get("type") or "image")
        start = _f(layer.get("start"), 0.0)
        end = _f(layer.get("end"), dur)
        a, b = max(start, t0), min(end, t1)
        if b - a < 1.0 / rate:
            continue

        remap = layer.get("timeRemap")
        has_remap = _is_track(remap) or (isinstance(remap, dict) and remap.get("expr"))
        in_point = _f(layer.get("inPoint"), 0.0)
        ts = _f(layer.get("timeScale"), 1.0) or 1.0
        name = layer.get("name") or layer.get("id")

        if kind == "comp":
            child = _child_comp(layer, cctx)
            sub = _descend(child, layer, cctx)
            if has_remap:
                if _subtree_has_audio(child, sub, probe):
                    raise ValueError(_REMAP_AUDIO_MSG.format(name=name))
                continue
            child_dur = _f(child.get("duration"), 0.0)
            c0 = in_point + (a - start) * ts
            c1 = in_point + (b - start) * ts
            lo, hi = (c0, c1) if c0 <= c1 else (c1, c0)
            lo, hi = max(0.0, lo), min(child_dur, hi)
            if hi - lo < 1.0 / rate:
                continue
            src_buf = _mix_comp_audio(child, lo, hi, rate, sub, pcm, probe, found)
            origin = lo
        else:
            src = str(layer.get("src") or "")
            if not src:
                continue
            if has_remap:
                # decided on stream PRESENCE, not on decode: the refusal must
                # not cost reading a four-minute file it then refuses to use
                if kind == "audio" or _has_audio_stream(src, probe):
                    raise ValueError(_REMAP_AUDIO_MSG.format(name=name))
                continue
            if src not in pcm:
                pcm[src] = _decode_audio(src, rate)
            src_buf = pcm[src]
            if src_buf is None:
                if kind == "audio":
                    raise ValueError(
                        f"audio layer {name!r}: {os.path.basename(src)} has no "
                        f"audio stream — that is a broken source, not a silent one")
                continue                     # a soundless clip is the normal case
            origin = 0.0
            found[0] += 1

        n_out = int(round((b - a) * rate))
        at = int(round((a - t0) * rate))
        n_out = min(n_out, n - at)
        if n_out <= 0 or not src_buf.shape[1]:
            continue

        N = src_buf.shape[1]
        first = (in_point + (a - start) * ts - origin) * rate
        if abs(ts - 1.0) < 1e-9 and abs(first - round(first)) < 1e-6:
            # the common case, sample-exact: a straight slice (atrim), placed
            # at the layer's offset (adelay), silence past either end
            off = int(round(first))
            lead = max(0, -off)
            src_lo = off + lead
            take = min(n_out - lead, N - src_lo)
            chunk = np.zeros((2, n_out), dtype=np.float32)
            if take > 0 and 0 <= src_lo < N:
                chunk[:, lead:lead + take] = src_buf[:, src_lo:src_lo + take]
        else:
            # retimed (or fractionally offset): linear-resample the source at
            # each output sample's mapped position — the speed change carries
            # the pitch with it, as AE's time-stretch does
            pos = first + ts * np.arange(n_out, dtype=np.float64)
            chunk = np.zeros((2, n_out), dtype=np.float32)
            inside = (pos >= 0.0) & (pos <= N - 1)
            if inside.any():
                idx = np.arange(N, dtype=np.float64)
                sel = pos[inside]
                for ch in range(2):
                    chunk[ch, inside] = np.interp(sel, idx, src_buf[ch]).astype(np.float32)

        bus[:, at:at + n_out] += chunk * _audio_gain_env(layer.get("audioLevels"), a, n_out, rate)
    return bus


def render_audio(comp, t0, t1, rate=AUDIO_RATE, clip_note=None):
    """The comp's soundtrack over [t0, t1), or None when the comp reaches no
    audio-bearing source at all — the movie then muxes exactly as it did
    before this feature existed, byte for byte.
    """
    cctx = CompCtx(library=_comp_library(comp), chain=(_comp_identity(comp),), env=None)
    found = [0]
    bus = _mix_comp_audio(comp, t0, t1, rate, cctx, {}, {}, found)
    if not found[0]:
        return None
    over = int(np.count_nonzero(np.abs(bus) > 1.0))
    if clip_note is not None:
        clip_note[0] = over
    if over:
        # summed float can pass the rail; the file must not. Said out loud
        # because a clipped mix sounds like a bug and reads like nothing.
        print(f"vfx: audio mix clipped at {over} samples — pull audioLevels down",
              file=sys.stderr)
        np.clip(bus, -1.0, 1.0, out=bus)
    return bus


def _add_audio_stream(container, fmt, rate):
    """The soundtrack stream: AAC in mp4 (what the container is for), 16-bit
    PCM in mov — the render's mov is the lossless lane (qtrle), so the sound
    stays lossless beside it."""
    codec = "aac" if fmt == "mp4" else "pcm_s16le"
    stream = container.add_stream(codec, rate=rate)
    stream.layout = "stereo"
    if codec == "aac":
        stream.bit_rate = 192_000
    return stream


def _encode_audio_block(container, stream, fmt, block, pts, rate):
    """One block of the bus into the container, in the stream's own format."""
    if fmt == "mp4":
        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(block),
                                           format="fltp", layout="stereo")
    else:
        # timelinemix.encode's scale, deliberately: 32768 with rounding,
        # clipped AFTER scaling because 1.0 * 32768 is one past int16.
        i16 = np.clip(np.round(block.T.reshape(1, -1) * 32768.0),
                      -32768, 32767).astype(np.int16)
        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(i16),
                                           format="s16", layout="stereo")
    frame.sample_rate = rate
    frame.pts = pts
    for pkt in stream.encode(frame):
        container.mux(pkt)


# ── CLI modes ─────────────────────────────────────────────────────────────────

_NVENC = None

# NVENC refuses frames below roughly 145x49 — it is a hardware limit, not a
# setting. A 128px comp picking "auto" would otherwise open the encoder, fail on
# frame one, and lose the render. Ask for a little more than the documented floor.
NVENC_MIN = (160, 64)


def _nvenc_available():
    """Whether h264_nvenc actually encodes here, not merely whether ffmpeg lists it.

    A build can carry the encoder with no driver or no GPU behind it, and the
    failure only surfaces on the first frame — by which time a render has already
    reported success in starting. One throwaway frame settles it up front, at a
    size NVENC will accept (see NVENC_MIN: probe too small and this answers "no"
    on a machine that is perfectly capable).
    """
    global _NVENC
    if _NVENC is not None:
        return _NVENC
    _NVENC = False
    try:
        import io as _io
        c = av.open(_io.BytesIO(), "w", format="mp4")
        s = c.add_stream("h264_nvenc", rate=30)
        s.width, s.height, s.pix_fmt = 256, 256, "yuv420p"
        frame = av.VideoFrame.from_ndarray(np.zeros((256, 256, 3), np.uint8), format="rgb24")
        frame.pts = 0
        for pkt in s.encode(frame):
            c.mux(pkt)
        for pkt in s.encode(None):
            c.mux(pkt)
        c.close()
        _NVENC = True
    except Exception:                                  # noqa: BLE001
        _NVENC = False
    return _NVENC


def cmd_frame(job):
    comp = job.get("comp") or {}
    t = _f(job.get("t"), 0.0)
    out = job["out"]
    began = time.time()
    rgba = render_frame(comp, t, scale=_f(job.get("scale"), 1.0) or 1.0,
                        draft=bool(job.get("draft")),
                        # A workspace view (Front/Top/Right/orbit) — absent for
                        # the active camera. The route keys its frame cache on
                        # this, so two views can never collide on one file.
                        view=job.get("view") or None)
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    # compress_level=1, measured: the default costs 125 ms at 720p — MORE than
    # the render does now — against 72 ms here, for identical pixels, because
    # PNG is lossless at every level. This is the preview lane: a cache file the
    # browser fetches and discards. The image-sequence writer below produces
    # files people keep and keeps the default.
    Image.fromarray(to_uint8(rgba), "RGBA").save(out, compress_level=1)
    return {"ok": True, "out": out, "width": int(rgba.shape[1]), "height": int(rgba.shape[0]),
            "ms": int((time.time() - began) * 1000)}


# What a rendered movie is told it contains. FFmpeg's enum values, not strings:
# PyAV 17 refuses a name on these fields with "an integer is required", and a
# TypeError swallowed by a try/except is how a file goes out untagged while the
# code that meant to tag it reads as if it worked.
AVCOL_PRI_BT709 = 1
AVCOL_TRC_IEC61966_2_1 = 13            # sRGB's own curve; AVCOL_TRC_BT709 is 1
AVCOL_SPC_BT709 = 1
AVCOL_RANGE_MPEG = 1                   # "tv", 16-235 — what libx264 writes here


def _tag_colour(stream, fmt):
    """Say what the pixels ARE. Every render, whatever `linearLight` is set to.

    UNTAGGED IS NOT NEUTRAL, it is a guess made downstream. An h264 file with no
    VUI gets bt709 from one player and bt601 from another (the SD default some
    still fall back to below 720p), and the two disagree: the same samples,
    encoded 709 and read as 601, are off by 7.85 codes mean / 43.9 max over the
    RGB cube, and 11.6 mean once the colour is saturated. Grey survives it,
    which is why nobody notices until the one shot that is not grey.

    IT IS NOT QUITE FREE, and the cost is worth writing down because it looks
    alarming and is not: the VUI adds 23 bytes to the SPS, libx264's decisions
    shift by a hair at the same CRF, and 0.03% of pixels land 1-3 codes from
    where the untagged encode put them (measured, 480x270, titleCard, 15
    frames: mean 0.0003, max 3). Lossy-encoder noise, in exchange for a file
    that says what it is. The PNG and frame lanes are untouched and stay bit
    identical.

    The transfer is IEC 61966-2-1 — sRGB's own curve — rather than bt709,
    because that is literally the curve these numbers went through. Every text
    raster, solid, shape, gradient and PNG this engine composites is sRGB; so is
    the browser canvas the preview lands in; and colour.py's transfer pair, when
    a comp turns it on, is that exact function. bt709 would be a near-miss
    quoted as a fact. The two differ only in the toe, so a decoder that does not
    recognise value 13 falls back to bt709 and lands on today's behaviour — the
    tag can only improve on nothing.

    This is a LABEL, not a conversion: no pixel is touched, no display transform
    is applied, and nothing here reads a colour profile off an incoming source.

    Verified with ffprobe on both lanes (render_test / the notes in VFX_SPEC):
      mp4  color_range=tv color_space=bt709 color_transfer=iec61966-2-1
           color_primaries=bt709
      mov  the same three; color_range stays unknown, correctly — qtrle is RGB
           and a studio/full range is a YCbCr idea. `colorspace` on an RGB
           stream is inert for the same reason and is set anyway, because
           QuickTime's `colr` atom carries the three as one triple.
    """
    cc = stream.codec_context
    cc.color_primaries = AVCOL_PRI_BT709
    cc.color_trc = AVCOL_TRC_IEC61966_2_1
    cc.colorspace = AVCOL_SPC_BT709
    if fmt != "mov":
        cc.color_range = AVCOL_RANGE_MPEG


def _open_movie(path, fmt, W, H, fps, crf, codec):
    """Container + video stream, told plainly what it is being asked to hold."""
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    rate = Fraction(fps).limit_denominator(60000)
    container = av.open(path, "w")
    if fmt == "mov":
        # qtrle is lossless RLE with an alpha channel — the reason "mov" exists in
        # this list at all is to hand back a comp with its transparency intact
        stream = container.add_stream("qtrle", rate=rate)
        stream.pix_fmt = "argb"
    else:
        name = codec
        if name in ("auto", "", None):
            big_enough = W >= NVENC_MIN[0] and H >= NVENC_MIN[1]
            name = "h264_nvenc" if (big_enough and _nvenc_available()) else "libx264"
        stream = container.add_stream(name, rate=rate)
        stream.pix_fmt = "yuv420p"
        if "nvenc" in name:
            # nvenc has no CRF; cq is its constant-quality dial and reads on the
            # same 0-51 scale, so the number in the job means the same thing
            stream.options = {"rc": "vbr", "cq": str(int(crf)), "preset": "p5", "b": "0"}
        else:
            stream.options = {"crf": str(int(crf)), "preset": "medium"}
    stream.width, stream.height = W, H
    stream.time_base = Fraction(1, 1) / rate
    _tag_colour(stream, fmt)
    return container, stream


def cmd_render(job):
    comp = job.get("comp") or {}
    out = job["out"]
    fmt = str(job.get("format") or "mp4").lower()
    fps = _f(comp.get("fps"), 30.0) or 30.0
    duration = _f(comp.get("duration"), 0.0)
    t0 = _f(job.get("from"), 0.0)
    t1 = _f(job.get("to"), duration) if job.get("to") is not None else duration
    if t1 <= t0:
        raise ValueError(f"empty range: from {t0} to {t1}")
    scale = _f(job.get("scale"), 1.0) or 1.0
    draft = bool(job.get("draft"))
    every = int(_f(job.get("progressEvery"), 10.0))

    cw = max(1, int(comp.get("width") or 1920))
    ch = max(1, int(comp.get("height") or 1080))
    W = max(2, int(round(cw * scale)))
    H = max(2, int(round(ch * scale)))
    if fmt == "mp4":
        # yuv420p subsamples chroma by two; an odd dimension has nowhere to put
        # the last row and h264 refuses the stream outright
        W -= W % 2
        H -= H % 2

    n_frames = max(1, int(round((t1 - t0) * fps)))
    began = time.time()

    container = stream = None
    seq_dir = None
    audio = astream = None
    if fmt == "png":
        # a sequence is a directory of numbered frames; if the job named a .png
        # the directory it sits in is what was meant. A frame sequence has no
        # container to put sound in, so the mix is never built for one.
        seq_dir = out if not out.lower().endswith(".png") else os.path.dirname(os.path.abspath(out))
        os.makedirs(seq_dir, exist_ok=True)
    else:
        # The mix is built BEFORE the container opens: every stream must exist
        # before the first packet, and a refusal (a time-remapped layer with
        # live audio) must not leave a half-written movie on disk. None means
        # the comp reaches no audio-bearing source, and everything from here
        # down then runs exactly as it did before audio existed.
        audio_clip_note = [0]
        audio = render_audio(comp, t0, t1, clip_note=audio_clip_note)
        container, stream = _open_movie(out, fmt, W, H, fps, _f(job.get("crf"), 18.0),
                                        job.get("codec") or "auto")
        if audio is not None:
            astream = _add_audio_stream(container, fmt, AUDIO_RATE)

    # aac takes 1024-sample frames; pcm takes anything, 4096 is just a stride
    a_fs = 1024 if fmt == "mp4" else 4096
    a_cursor = 0
    a_total = audio.shape[1] if audio is not None else 0

    def _pump_audio(upto):
        """Whole blocks of the bus up to sample `upto`, interleaved with the
        pictures so the muxer never sits on more than a frame of either."""
        nonlocal a_cursor
        upto = min(upto, a_total)
        while a_cursor + a_fs <= upto:
            _encode_audio_block(container, astream, fmt,
                                audio[:, a_cursor:a_cursor + a_fs], a_cursor, AUDIO_RATE)
            a_cursor += a_fs

    for n in range(n_frames):
        t = t0 + n / fps
        rgba = render_frame(comp, t, scale=scale, draft=draft, size=(W, H))
        if seq_dir is not None:
            Image.fromarray(to_uint8(rgba), "RGBA").save(os.path.join(seq_dir, f"{n:05d}.png"))
        else:
            u8 = to_uint8(rgba)
            if fmt == "mov":
                frame = av.VideoFrame.from_ndarray(u8, format="rgba")
            else:
                # flatten onto the comp's own background: straight alpha times its
                # coverage, which for the default transparent bg is black
                flat = np.empty(rgba.shape[:2] + (3,), dtype=np.float32)
                for k in range(3):           # per channel: see the planar note
                    np.multiply(rgba[..., k], rgba[..., 3], out=flat[..., k])
                frame = av.VideoFrame.from_ndarray(to_uint8(flat), format="rgb24")
            # pts only: setting a frame's own time_base makes the mp4 muxer
            # reject the packet outright (EINVAL), and the stream's is enough
            frame.pts = n
            for pkt in stream.encode(frame):
                container.mux(pkt)
            if astream is not None:
                _pump_audio(int((n + 1) / fps * AUDIO_RATE))
        if every > 0 and (n % every == 0) and n:
            print(json.dumps({"progress": round(n / n_frames, 4), "frame": n}), flush=True)

    if container is not None:
        if astream is not None:
            _pump_audio(a_total)
            if a_cursor < a_total:                    # the tail block under a_fs
                _encode_audio_block(container, astream, fmt,
                                    audio[:, a_cursor:a_total], a_cursor, AUDIO_RATE)
                a_cursor = a_total
            for pkt in astream.encode(None):
                container.mux(pkt)
        for pkt in stream.encode(None):
            container.mux(pkt)
        container.close()

    result = {"ok": True, "out": seq_dir or out, "frames": n_frames,
              "seconds": round(n_frames / fps, 4), "ms": int((time.time() - began) * 1000)}
    if astream is not None:
        # what actually landed in the file, so a caller can hear a mistake in
        # numbers before playing anything: a mix at -80 dB is a wiring bug
        peak = float(np.abs(audio).max()) if audio.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if audio.size else 0.0
        _db = lambda x: round(20.0 * math.log10(x), 2) if x > 0 else None  # noqa: E731
        result["audio"] = {"seconds": round(a_total / AUDIO_RATE, 3),
                           "peakDb": _db(peak), "rmsDb": _db(rms),
                           # samples the summed mix pushed past the rail before
                           # the hard clip. peakDb reads 0 either way, so
                           # without this a slammed mix and a perfectly-riding
                           # one were the same number.
                           "clippedSamples": audio_clip_note[0]}
    return result


def _probe_one(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        with Image.open(path) as im:
            return {"path": path, "kind": "image", "width": im.width, "height": im.height,
                    "duration": None, "fps": None}
    c = av.open(path)
    try:
        if c.streams.video:
            st = c.streams.video[0]
            rate = st.average_rate or st.guessed_rate
            dur = None
            if st.duration is not None and st.time_base:
                dur = float(st.duration * st.time_base)
            elif c.duration is not None:
                dur = float(c.duration) / av.time_base
            return {"path": path, "kind": "video",
                    "width": int(st.codec_context.width or 0),
                    "height": int(st.codec_context.height or 0),
                    "duration": round(dur, 4) if dur else None,
                    "fps": round(float(rate), 4) if rate else None,
                    # whether a movie render of a layer over this file will
                    # have anything to mix — most generated clips do not
                    "audio": bool(c.streams.audio)}
        if c.streams.audio:
            dur = float(c.duration) / av.time_base if c.duration is not None else None
            return {"path": path, "kind": "audio", "width": None, "height": None,
                    "duration": round(dur, 4) if dur else None, "fps": None,
                    "audio": True}
    finally:
        c.close()
    raise ValueError("no video or audio stream")


def cmd_probe(job):
    out = []
    for path in job.get("sources") or []:
        try:
            out.append(_probe_one(path))
        except Exception as exc:                       # noqa: BLE001
            # One unreadable source must not hide the answer for the other nine —
            # the caller is usually asking "which of these can I use".
            out.append({"path": path, "kind": "unknown", "error": str(exc)})
    return {"ok": True, "sources": out}


def cmd_peaks(job):
    """Min/max peak pairs over one source's audio — the timeline's waveform.

    Decodes through _decode_audio, the SAME PyAV path the render mix reads, so
    the picture under a layer bar and the sound in the exported movie can never
    disagree about what the file contains. The envelope is derived from the
    SOURCE FILE ALONE — no comp, no layer timing, no audioLevels — which is
    what lets the route cache it keyed on (file, mtime, bins) and have it
    survive every comp edit; the layer's trim/stretch is applied at DRAW time
    by whoever asked.

    Always exactly `bins` (lo, hi) pairs, each covering seconds/bins of the
    source — a caller sizing a canvas needs the count it asked for, not one
    that depends on the sample count's divisibility.

    A source with NO audio stream is refused rather than answered flat: the
    caller asked to see this file's sound, and a straight line would claim the
    file is silent when the truth is there is nothing to listen to. (A video
    layer without a track never gets here — the probe advisory says audio:false
    and the UI does not ask.)
    """
    src = str(job.get("src") or "")
    if not src:
        raise ValueError("peaks: job.src names the audio-bearing file")
    bins = min(max(int(job.get("bins") or 1000), 16), 8192)
    pcm = _decode_audio(src, AUDIO_RATE)
    if pcm is None:
        raise ValueError(f"{os.path.basename(src)} has no audio stream — nothing to draw")
    mono = pcm.mean(axis=0)
    n = int(mono.shape[0])
    seconds = n / float(AUDIO_RATE)
    if n == 0:
        lo = hi = np.zeros(bins, dtype=np.float32)
    else:
        step = -(-n // bins)                     # ceil: every sample lands in one bin
        pad = step * bins - n
        if pad:
            mono = np.pad(mono, (0, pad), mode="edge")
        blocks = mono.reshape(bins, step)
        lo = np.clip(blocks.min(axis=1), -1.0, 1.0)
        hi = np.clip(blocks.max(axis=1), -1.0, 1.0)
    out = np.empty(bins * 2, dtype=np.float32)
    out[0::2] = lo
    out[1::2] = hi
    # Interleaved [lo, hi, lo, hi, …], 3 dp — the same shape and rounding as
    # server/peaks.py, so the two waveform surfaces read alike; a 26 px lane
    # cannot show a fourth decimal.
    return {"ok": True, "bins": bins, "rate": AUDIO_RATE,
            "seconds": round(seconds, 3),
            "peaks": [round(float(v), 3) for v in out]}


MODES = {"frame": cmd_frame, "render": cmd_render, "probe": cmd_probe,
         "peaks": cmd_peaks}


def cmd_stats(_job=None):
    """What the caches are holding, so a supervisor can decide to recycle us."""
    return {"ok": True, "bytes": {
        "images": _IMAGE_BYTES, "frames": _FRAME_BYTES, "scaled": _SCALED_BYTES,
        "masks": _MASK_BYTES, "scratch": _SCRATCH_BYTES},
        "counts": {"images": len(_IMAGES), "frames": len(_FRAMES),
                   "scaled": len(_SCALED), "text": len(_TEXT),
                   "masks": len(_MASKS), "readers": len(_READERS)}}


def cmd_release(_job=None):
    close_sources()
    return {"ok": True, "released": True}


SERVE_MODES = dict(MODES, stats=cmd_stats, release=cmd_release)


def serve(stdin=None, stdout=None):
    """One process, many jobs: `{"id":…, "cmd":"frame", "job":{…}}` a line in,
    one JSON line out, until stdin closes or a `shutdown` arrives.

    The reason this mode exists is not elegance. Spawning python and importing
    numpy, PIL, cv2 and PyAV costs about half a second, and the file-driven modes
    pay it PER FRAME — so a scrub spends more time starting interpreters than
    compositing. It is also what finally pays for the caches in this file: the
    image, scaled-image, text-raster and mask-raster caches all live and die with
    the process, so today a one-frame invocation fills them and throws them away.
    A `render` already amortises them across its own frames; this extends that to
    a session.

    The hazards are real and are answered here rather than assumed away:

      STALE SOURCES  a long-lived process caches decoded footage by path, so a
        file replaced on disk would otherwise render as its old self forever.
        _refresh_sources() re-stats every cached path between jobs. Between, not
        during: within one job the sources are frozen exactly as they are today.
      A WEDGE  one bad job must not end the session, so every failure answers on
        its own line and the loop continues — but a MemoryError does not, because
        carrying on after one is how a process becomes a zombie that answers
        slowly forever. It reports, then exits, and the supervisor respawns.
      GROWTH  the caches are byte-capped, but the caps (roughly 1.3 GB with the
        defaults) were written for a process that dies after one frame and
        therefore never reached them. `stats` reports the real numbers so a
        supervisor can recycle on its own terms, and `release` is close_sources.

    Requests are served strictly one at a time and answers come back in order, so
    `render`'s existing untagged progress lines still belong to the one job in
    flight and are left exactly as they are.
    """
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout

    def reply(obj):
        stdout.write(json.dumps(obj) + "\n")
        stdout.flush()

    reply({"ok": True, "ready": True, "pid": os.getpid()})
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("a request must be a JSON object")
            rid = req.get("id")
            cmd = str(req.get("cmd") or "")
            if cmd == "shutdown":
                reply({"id": rid, "ok": True, "bye": True})
                break
            if cmd not in SERVE_MODES:
                raise ValueError(f"unknown cmd {cmd}")
            _refresh_sources()
            result = SERVE_MODES[cmd](req.get("job") or {})
            result = dict(result, id=rid) if rid is not None else result
            reply(result)
        except MemoryError:
            reply({"id": rid, "ok": False, "fatal": True, "error": "MemoryError"})
            close_sources()
            return 1
        except Exception as exc:                       # noqa: BLE001
            reply({"id": rid, "ok": False,
                   "error": f"{type(exc).__name__}: {exc}"})
    close_sources()
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "serve":
        return serve()
    try:
        if len(argv) < 2:
            raise ValueError("usage: engine.py <frame|render|probe|peaks> <job.json>"
                             "  |  engine.py serve")
        mode, job_path = argv[0], argv[1]
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode}")
        with open(job_path, encoding="utf-8") as fh:
            job = json.load(fh)
        result = MODES[mode](job)
    except Exception as exc:                           # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
