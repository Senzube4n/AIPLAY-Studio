"""The VFX effect library - every filter a layer can stack, one pure function
each.

The engine hands a layer's pixels in and takes new pixels back; nothing here
knows about comps, keyframes, files or time beyond the `t` it is told. That is
deliberate: an effect you can run on an 8x8 array is an effect you can prove.

The contract, in full:

    apply(name, rgba, params, ctx) -> np.ndarray

    rgba    float32 (H, W, 4), 0..1, STRAIGHT (un-premultiplied) alpha
    return  the same shape and dtype; the input is never written to
    ctx     { "t", "fps", "width", "height", "draft", "layer", "history"? }
    an unknown name, an unusable array or an effect that raises -> rgba back

`CATALOG` describes every effect and EVERY parameter - type, default, range,
whether it can be keyframed, and one line on what it is for - because MCP
serves it verbatim. An agent reads the catalog instead of guessing, so a
parameter that is not in the catalog does not exist: `apply` drops unknown keys
and clamps known ones before an effect body ever sees them.

Two conventions the rest of the system depends on:

  * ALPHA DISCIPLINE. Every entry carries `touchesAlpha`. Colour work is false
    and is tested to be bit-exact on the alpha channel; keying, mattes and the
    effects that spread light past an edge (glow, drop shadow, stroke) are true
    and say so. Nothing changes transparency quietly.
  * PREMULTIPLIED INTERNALS. Blurs, warps and resamples run on premultiplied
    pixels and un-premultiply on the way out. Filtering straight alpha drags
    the colour of undefined transparent pixels into every edge - the black
    halo everyone recognises and nobody can explain.

Two catalog flags are messages to the engine rather than to a person:
`needsHistory` asks for `ctx["history"]`, this layer's previously rendered
frames. TWO SHAPES ARRIVE THERE and only one of them was ever written down: a
plain list, oldest first, which is what the tests and this docstring promised,
and a CALLABLE taking how many frames are wanted and returning them newest
first, which is what the engine actually passes so that nothing decodes frames
no effect asked for. `_past(ctx, n)` reads both and hands back newest-first;
nothing below should touch ctx["history"] directly. Missing or short history is
normal - it is what the first second of a comp looks like - and those effects
fall back to a no-op. `snapsTime` says the layer should be EVALUATED at a
quantised time - posterizeTime asks for that, and holds the last sampled frame
itself when it is handed history instead.

SECOND-LAYER INPUTS. Five effects read ANOTHER layer - Displacement Map,
Compound Blur, Set Matte, Difference Matte and Gradient Wipe - and how they do
it is a contract between this module and the engine, so it is written down once
here instead of five times below.

  * THE PARAMETER. A param of `"type": "layer"` holds a REFERENCE to a layer in
    the same comp: its `id`, or its `name` when exactly one layer carries that
    name - the two things `findLayer` in store.js already accepts, so a layer is
    named here the way it is named everywhere else in the product. The default
    is `""`, meaning "no second layer", and `_coerce` turns anything that is not
    a string into exactly that. The reference is never resolved in this module;
    nothing here has a comp to resolve it against.

  * THE PIXELS. The engine resolves the reference and leaves the result at

        ctx["layerPixels"]

    which is read ONLY through `_layer_in(ctx, ref)`, and which arrives in one
    of two shapes for the same reason `ctx["history"]` does:

        callable   ctx["layerPixels"](ref) -> pixels or None
        mapping    ctx["layerPixels"][ref] -> pixels

    The callable is what the engine passes, because producing a map layer costs
    a whole layer render and no comp should pay for one that no effect asked
    for. The mapping is what a test hands over. Both are read in `_layer_in`, so
    no effect body has to know which it got. The key is the REFERENCE STRING and
    not the parameter name, which is what makes two params naming one layer
    share one render.

    Pixels are float32 (H, W, 4), 0..1, STRAIGHT alpha - the same shape and the
    same promises as `rgba` itself, so an effect can read a map the way it reads
    its own plate. They are the layer AS THE COMPOSITOR WOULD DRAW IT: its own
    effects, masks and TRANSFORM applied, in comp space. That is this engine's
    existing track-matte behaviour rather than AE's, and the difference is
    deliberate - in AE a layer input ignores the map layer's transform, so
    moving the map does nothing and the manual tells you to precomp. A transform
    somebody set being silently ignored is the bug that costs an afternoon.

    COMP SPACE IS NOT THIS LAYER'S SPACE. The effect stack runs on a layer at
    its OWN resolution, before its transform - that is what makes a blur radius
    mean the same thing whatever the layer is scaled to. So the map arrives on
    a different grid from the layer being effected whenever that layer is not
    comp-sized, which is the common case for an image or a precomp, and the
    SIZE note below is what reconciles them. The map must also be produced at
    the SAME RENDER SCALE as the layer it feeds: a half-scale preview handed a
    full-resolution map costs four times what it should and shows something the
    full render will not.

  * WHEN IT IS NOT THERE. `_layer_in` hands back None for every one of: no
    reference given; no `ctx["layerPixels"]` at all, which is the engine side
    missing entirely and is what every test below runs under; a reference naming
    no layer; a layer with no pixels at this instant, outside its in/out window;
    a resolver that raised; an array that is not a float (H, W, 4); and - the
    one only the engine can enforce - a reference to THE EFFECT'S OWN LAYER,
    directly or round a cycle. A layer that fed itself would recurse until the
    render died, and refusing it turns out to be exactly right: "read yourself"
    is what the self-channel path does anyway.

    A layer whose own VISIBILITY IS OFF must still resolve. That is not an edge
    case, it is the whole workflow - the displacement map is switched off so it
    does not composite - and an engine that read the eyeball as consent would
    break all five on their first honest use.

  * WHAT NONE MEANS. Self-channel: the effect reads its own pixels, which is
    bit-for-bit what these effects did before this contract existed. Difference
    Matte is the one exception and says so in its `why`: a layer differenced
    against itself matches everywhere, so its no-input path is a declared no-op
    rather than an empty frame.

  * SAYING SO. A degrade is not a failure, so it does not go to stderr; it must
    not be silent either. `_note(ctx, msg)` appends to `ctx["notes"]` WHEN THE
    ENGINE PUT A LIST THERE, and does nothing at all when it did not. That is
    how "you named a layer and did not get it" reaches a person without an
    effect having to lie about what it did.

  * SIZE. A 500x500 map on a 1920x1080 layer is the normal case, not an edge
    case, and no single answer is right - so `mapFit` is a parameter on all
    five. `stretch`, the default, resamples the map onto this layer's grid,
    aspect ratio and all: the only mode that always covers the frame, and what
    AE's own "stretch to fit" switches do. `center` pins the map 1:1 in the
    middle and repeats its BORDER outward. `tile` pins it identically and
    repeats the MAP outward, which is what a seamless noise plate wants. center
    and tile are one placement with two border rules, so switching between them
    changes only what happens outside the map, never what happens inside it.
    Equal sizes cost nothing: `_fit_map` returns the array it was handed.

`_fractal_field` is the other thing worth knowing about before reading on: one
multi-octave value-noise generator that Fractal Noise, Turbulent Displace,
Roughen Edges and the noise Gradient Wipe all share, so "the same seed and
scale" means the same field in all four.

Randomness is seeded from the parameter plus the frame number, never from the
clock: two renders of the same comp must be the same file.

    python effects.py catalog        # the catalog as one JSON line

numpy / cv2 / scipy, plus the blend maths from server/imagetools.py - the same
`_blend` the image compositor uses, so a VFX "screen" and an Images "screen"
are the same arithmetic.
"""
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from imagetools import _blend as _blend_rgb  # noqa: E402  the one blend implementation


# ---------------------------------------------------------------------------
# the registry
# ---------------------------------------------------------------------------

CATALOG = {}
_REGISTRY = {}

GROUP_ORDER = ["Blur & Sharpen", "Color", "Keying", "Stylize", "Distort",
               "Generate", "Time", "Matte", "Transition"]
# ^ "Transition" is a NINTH group, past the eight the spec names. A wipe is not
#   a stylize and not a matte: it hides a layer progressively and the whole
#   group is driven by one `completion` a person keyframes from 0 to 100. The
#   UI builds its group list from the catalog it is served, so a new group
#   costs nothing there - but anything that hard-codes the eight will not show
#   these six, which is why it is called out here rather than slipped in.

# what a generator can do to the layer under it. "stencil" is the one people
# reach for without knowing its name: paint inside the shape that is already
# there, leave its edges alone.
COMPOSITE_MODES = ["normal", "stencil", "behind", "multiply", "screen", "overlay",
                   "softlight", "add", "subtract", "difference", "darken", "lighten"]

EDGE_MODES = ["transparent", "clamp", "wrap", "mirror"]

# How a map layer that is not this layer's size is placed on it. See the
# docstring's SIZE note; `_fit_map` is the implementation.
MAP_FITS = ["stretch", "center", "tile"]


def num(default, lo, hi, desc, animatable=True, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": animatable, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "animatable": False, "desc": desc}


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default,
            "animatable": False, "desc": desc}


def col(default, desc, animatable=True):
    """Colours are 0-255 RGB, the same units the comp document stores."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": animatable, "desc": desc}


def pts(default, desc):
    """A curve: [[x, y], ...] over 0..255, the domain imagetools' curves use."""
    return {"type": "points", "default": [list(p) for p in default], "min": 0, "max": 255,
            "animatable": False, "desc": desc}


def lay(desc):
    """A reference to ANOTHER LAYER - id, or an unambiguous name. The engine
    resolves it and leaves the pixels at ctx["layerPixels"]; the module
    docstring is the whole contract. Empty is "no second layer" and is always
    the default, because an effect you have just added must not reach for
    somebody else's pixels before you have said which."""
    return {"type": "layer", "default": "", "animatable": False, "desc": desc}


def mapfit(what="map"):
    return pick(MAP_FITS, "stretch",
                f"how a {what} of a different size is placed: stretch resamples it "
                f"onto this layer, center pins it 1:1 in the middle and repeats its "
                f"border, tile repeats the {what} itself")


def effect(name, label, group, why, params, touches_alpha=False, **extra):
    def deco(fn):
        entry = {"label": label, "group": group, "why": why,
                 "touchesAlpha": bool(touches_alpha), "params": params}
        entry.update(extra)
        CATALOG[name] = entry
        _REGISTRY[name] = fn
        return fn
    return deco


# ---------------------------------------------------------------------------
# shared plumbing
# ---------------------------------------------------------------------------

LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)   # Rec.601, as imagetools uses
_EPS = np.float32(1e-6)


def _rgb(rgba):
    """A contiguous copy of the colour. cv2 cannot take a strided 3-of-4 slice,
    and a copy is what "never mutate the input" wants anyway."""
    return np.ascontiguousarray(rgba[..., :3])


def _alpha(rgba):
    return np.ascontiguousarray(rgba[..., 3])


def _pack(rgb, a):
    out = np.empty(rgb.shape[:2] + (4,), np.float32)
    out[..., :3] = rgb
    out[..., 3] = a
    return out


def _premul4(rgba):
    """4-channel premultiplied copy - what warps and resamples must work on."""
    out = np.array(rgba, dtype=np.float32, copy=True)
    out[..., :3] *= out[..., 3:4]
    return out


def _unpremul(pm, a):
    a = np.clip(a, 0.0, 1.0).astype(np.float32)
    rgb = np.clip(pm / np.maximum(a, _EPS)[..., None], 0.0, 1.0)
    return _pack(rgb, a)


def _luma(rgb):
    return rgb @ LUMA


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(float(e1) - float(e0), 1e-6), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _rgb01(c):
    a = np.zeros(3, np.float32)
    seq = list(c)[:3]
    for i, v in enumerate(seq):
        a[i] = float(v) / 255.0
    return np.clip(a, 0.0, 1.0)


def _frame(ctx):
    fps = float(ctx.get("fps") or 30.0) or 30.0
    return int(round(float(ctx.get("t") or 0.0) * fps))


def _ks(sigma):
    """Kernel width for a sigma. 1 means "do not filter this axis at all" -
    getGaussianKernel(1, s) is [1.0] whatever s is, which is how a single-axis
    blur stays single-axis even though cv2 copies sigmaX into a zero sigmaY."""
    if sigma < 0.05:
        return 1
    return max(3, int(sigma * 3.0) * 2 + 1)


def _at_scale(img, factor, fn):
    """Run a kernel-bound filter on a shrunken copy and scale the result back.
    A blur is scale-free - halving the picture and the radius gives the same
    picture - so the only thing lost is detail the blur was erasing, while the
    cost falls with the square of the factor. This is what makes a 200px radius
    on a 4K plate a tenth of a second instead of a minute."""
    if factor <= 1.05:
        return fn(img, 1.0)
    h, w = img.shape[:2]
    sw, sh = max(2, int(round(w / factor))), max(2, int(round(h / factor)))
    small = cv2.resize(img, (sw, sh), interpolation=cv2.INTER_AREA)
    small = fn(small, factor)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def _blur2(img, sx, sy, border=cv2.BORDER_REPLICATE, draft=False):
    sx, sy = max(0.0, float(sx)), max(0.0, float(sy))
    if sx < 0.05 and sy < 0.05:
        return img
    lim = 3.0 if draft else 8.0
    factor = min(max(sx, sy) / lim, 24.0)

    def run(a, f):
        ux, uy = sx / f, sy / f
        return cv2.GaussianBlur(a, (_ks(ux), _ks(uy)),
                                sigmaX=max(ux, 1e-3), sigmaY=max(uy, 1e-3),
                                borderType=border)

    return _at_scale(img, factor, run)


def _border_of(edge):
    return cv2.BORDER_CONSTANT if edge == "transparent" else cv2.BORDER_REPLICATE


def _blur_rgba(rgba, sx, sy, edge="clamp", draft=False):
    border = _border_of(edge)
    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    return _unpremul(_blur2(pm, sx, sy, border, draft), _blur2(a, sx, sy, border, draft))


def _blur_a(a, sigma, draft=False):
    return _blur2(np.ascontiguousarray(a), sigma, sigma, cv2.BORDER_CONSTANT, draft)


def _kernel(radius):
    r = max(1, int(round(radius)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r * 2 + 1, r * 2 + 1))


def _grid(h, w):
    """Pixel coordinates as READ-ONLY broadcast views.

    mgrid materialises two int64 planes and then two float32 ones - 48MB and
    about 35ms at 1080p, paid by twenty effects that only ever read them. A
    broadcast view is free. Nothing may write to these in place; everything
    here builds a new array out of them anyway, and the sweep in the tests
    would catch an effect that tried (the write raises, and a raise is the one
    thing that shows up on stderr).
    """
    return (np.broadcast_to(np.arange(w, dtype=np.float32), (h, w)),
            np.broadcast_to(np.arange(h, dtype=np.float32)[:, None], (h, w)))


def _remap(rgba, mapx, mapy, edge="transparent", draft=False):
    """Resample through an explicit source-coordinate map - the one road every
    distort takes, so they all share the same edge behaviour and the same
    premultiplied handling."""
    h, w = rgba.shape[:2]
    mapx = np.ascontiguousarray(mapx, dtype=np.float32)
    mapy = np.ascontiguousarray(mapy, dtype=np.float32)
    if edge == "wrap":
        # cv2's BORDER_WRAP is not honoured by every remap path; doing it on the
        # coordinates is unambiguous and costs one modulo.
        mapx = np.mod(mapx, w)
        mapy = np.mod(mapy, h)
        border = cv2.BORDER_REPLICATE
    elif edge == "mirror":
        border = cv2.BORDER_REFLECT_101
    else:
        border = _border_of(edge)
    interp = cv2.INTER_NEAREST if draft else cv2.INTER_LINEAR
    warped = cv2.remap(_premul4(rgba), mapx, mapy, interp,
                       borderMode=border, borderValue=(0, 0, 0, 0))
    return _unpremul(warped[..., :3], warped[..., 3])


def _blend_over(rgba, gen_rgb, cov, mode):
    """Composite a generated image onto the layer.

    `normal` covers whatever is there and grows alpha; `stencil` paints only
    inside the alpha that already exists (a Fill, in AE's sense); `behind`
    slides underneath; anything else is a blend mode, and a blend mode against
    nothing is nothing - so those are restricted to the existing shape and
    leave alpha exactly as they found it.
    """
    a = _alpha(rgba)
    rgb = _rgb(rgba)
    cov = np.clip(cov, 0.0, 1.0).astype(np.float32)
    if gen_rgb.ndim == 1:
        gen_rgb = np.broadcast_to(gen_rgb, rgb.shape).astype(np.float32)
    if mode == "stencil":
        c = (cov * a)[..., None]
        return _pack(rgb * (1 - c) + gen_rgb * c, a)
    if mode == "behind":
        out_a = np.clip(a + cov * (1 - a), 0, 1)
        pm = rgb * a[..., None] + gen_rgb * (cov * (1 - a))[..., None]
        return _unpremul(pm, out_a)
    if mode == "normal":
        c = cov[..., None]
        pm = rgb * a[..., None] * (1 - c) + gen_rgb * c
        return _unpremul(pm, np.clip(a * (1 - cov) + cov, 0, 1))
    c = (cov * a)[..., None]
    blended = np.clip(_blend_rgb(rgb, gen_rgb, mode), 0, 1).astype(np.float32)
    return _pack(rgb * (1 - c) + blended * c, a)


def _pchip_lut(points, size=256):
    """The curve LUT from imagetools.apply_edit, ported: dedupe on x, sort,
    extend flat to both ends, PCHIP through the lot (monotone cubic - a spline
    would ring and put a highlight where the artist drew none). Returned in
    0..1 because the compositor is float, not 8-bit."""
    from scipy.interpolate import PchipInterpolator
    clean = {}
    for p in points or []:
        if len(p) != 2:
            continue
        clean[int(max(0, min(255, float(p[0]))))] = max(0.0, min(255.0, float(p[1])))
    items = sorted(clean.items())
    if len(items) < 2:
        return None
    xs = [p[0] for p in items]
    ys = [p[1] for p in items]
    if xs[0] > 0:
        xs.insert(0, 0)
        ys.insert(0, ys[0])
    if xs[-1] < 255:
        xs.append(255)
        ys.append(ys[-1])
    f = PchipInterpolator(xs, ys)
    lut = (np.clip(f(np.linspace(0, 255, size)), 0, 255) / 255.0).astype(np.float32)
    return np.append(lut, lut[-1])      # the spare entry _apply_lut leans on


def _apply_lut(channel, lut):
    """Look the channel up in a uniformly-sampled table, interpolating between
    entries so a smooth gradient does not band. Hand-rolled rather than
    np.interp because the table is uniform: skipping the binary search halves
    the cost, and a curve pass runs on three channels of a 2Mpx frame."""
    pos = np.clip(channel, 0, 1) * (len(lut) - 2)   # the table carries a spare
    lo = pos.astype(np.int32)                       # last entry, so lo+1 is
    frac = pos - lo                                 # always in bounds
    return (lut[lo] + (lut[lo + 1] - lut[lo]) * frac).astype(np.float32)


def _is_identity_curve(points):
    return len(points or []) == 2 and list(points[0]) == [0, 0] and list(points[1]) == [255, 255]


def _past(ctx, count):
    """This layer's previous frames, NEWEST FIRST, at most `count` of them.

    Two shapes reach here and only one of them was in the docstring. The engine
    hands `ctx["history"]` as a CALLABLE taking how many frames are wanted -
    decoding N extra frames per layer per frame whether or not anything asked
    would be indefensible - and it returns them newest first. A plain list is
    the module's own contract and is oldest first. Both are read here, once, so
    no effect has to know which one it got; `history` being a function is
    truthy, so the obvious `ctx.get("history") or []` swallowed the callable and
    every history effect died on len() of a function.
    """
    h = ctx.get("history")
    n = max(1, int(count))
    if callable(h):
        try:
            frames = list(h(n) or [])
        except Exception:                       # noqa: BLE001 - a missing past is normal
            return []
    else:
        frames = list(h or [])[::-1][:n]        # list contract: oldest first
    return [f for f in frames if isinstance(f, np.ndarray)]


# ---------------------------------------------------------------------------
# second-layer inputs - the whole contract is in the module docstring
# ---------------------------------------------------------------------------

def _note(ctx, msg):
    """Record that the effect did something other than what was asked.

    Never stderr: stderr is where a FAILURE goes, and running the self-channel
    version because a named layer was not available is a degrade, not a
    failure - printing it would make every frame of a legitimate render noisy.
    Never silent either, which is the actual danger: an effect that quietly
    substitutes a lesser version of itself is the bug nobody ever finds. So the
    engine opts in by putting a list at ctx["notes"] (apply's shallow copy of
    ctx shares the list object, so an append here reaches the caller) and gets
    nothing at all when it does not.
    """
    notes = ctx.get("notes")
    if isinstance(notes, list) and msg not in notes:
        notes.append(str(msg))


def _layer_in(ctx, ref):
    """Another layer's pixels for this frame, or None. THE ONLY WAY IN.

    Two shapes arrive at ctx["layerPixels"] and both are read here so no effect
    body has to know which it got - a callable keyed by the reference (what the
    engine passes, so nothing renders a map layer that nobody asked for) and a
    plain mapping (what a test hands over). Everything that can go wrong -
    absent, unresolvable, out of its time window, self-referential, raised, or
    simply not an RGBA float array - comes back the same way, as None, because
    every caller has the same answer for all of them: read your own pixels.
    """
    ref = str(ref or "").strip()
    src = ctx.get("layerPixels")
    if not ref or src is None:
        return None
    try:
        px = src(ref) if callable(src) else src.get(ref)
    except Exception:                       # noqa: BLE001 - a missing layer is normal
        return None
    if (not isinstance(px, np.ndarray) or px.ndim != 3 or px.shape[2] != 4
            or px.shape[0] < 1 or px.shape[1] < 1
            or not np.issubdtype(px.dtype, np.floating)):
        return None
    return np.asarray(px, dtype=np.float32)


def _map_channel(rgba, name):
    """One control plane out of a map, UNCLIPPED - callers clip after they have
    fitted and blurred, which is the order the self-channel versions of these
    effects already used and the only order that keeps them bit-identical."""
    if name == "alpha":
        return _alpha(rgba)
    if name == "luminance":
        return _luma(_rgb(rgba))
    return rgba[..., {"red": 0, "green": 1, "blue": 2}[name]]


def _fit_map(src, h, w, mode):
    """Put a map onto this layer's grid. 2D plane or (H, W, C), same rules.

    Same size is the common case and costs nothing - the array comes straight
    back, which is what keeps the no-second-layer path bit-identical to what it
    was. `center` and `tile` are ONE placement with two border rules, done with
    integer index arrays rather than warpAffine: no interpolation at all, so
    "1:1 pixels" is literally true, cv2's patchy BORDER_WRAP support never
    comes into it, and the result is exactly reproducible.
    """
    sh, sw = src.shape[:2]
    if (sh, sw) == (h, w):
        return src
    if mode == "stretch":
        # AREA when BOTH axes shrink: it is the difference between a resampled
        # map and an aliased one, and a map that aliases displaces in visible
        # stair-steps. Only when both, because cv2 falls back to something very
        # like NEAREST for an axis AREA is asked to enlarge, so a map that
        # shrinks one way and grows the other would come out blocky.
        both_down = sw > w and sh > h
        return cv2.resize(src, (w, h),
                          interpolation=cv2.INTER_AREA if both_down else cv2.INTER_LINEAR)
    dx, dy = (w - sw) // 2, (h - sh) // 2
    ix = np.arange(w, dtype=np.int64) - dx
    iy = np.arange(h, dtype=np.int64) - dy
    if mode == "tile":
        ix, iy = np.mod(ix, sw), np.mod(iy, sh)
    else:
        np.clip(ix, 0, sw - 1, out=ix)
        np.clip(iy, 0, sh - 1, out=iy)
    return src[iy[:, None], ix[None, :]]


def _map_source(ctx, p, key, rgba, who):
    """(pixels to read the map from, whether they came from another layer).

    The one place the fallback is decided, so all five effects degrade the same
    way and all five say the same thing about it.
    """
    ref = str(p.get(key) or "").strip()
    if not ref:
        return rgba, False
    px = _layer_in(ctx, ref)
    if px is None:
        _note(ctx, f'{who}: layer "{ref}" was not available - '
                   f'read this layer\'s own channels instead')
        return rgba, False
    return px, True


# ---------------------------------------------------------------------------
# fractal noise - the engine under Fractal Noise, both displacers, Roughen
# Edges and the noise Gradient Wipe
# ---------------------------------------------------------------------------
#
# Value noise on a wrapping lattice, resampled by warpAffine rather than an
# explicit coordinate map: the 2x3 matrix carries scale, stretch, rotation and
# offset for free, BORDER_WRAP tiles the lattice EXACTLY (proven in the tests),
# and no 8MB map array is built per octave. The two z-slices that evolution
# interpolates between are packed as two channels of one lattice, so an octave
# costs one warp instead of two.
#
# Cell count comes off the frame's LONG EDGE, never off its pixel count, which
# is what makes a 0.5-scale preview show the same clouds as the full render. A
# noise that reseeds itself when the render scale changes is a noise that
# strobes, and the preview would be lying about the shot.

_LATTICE_MAX = 512          # past this an octave is finer than the screen anyway
_NOISE_INTERP = {"block": cv2.INTER_NEAREST, "linear": cv2.INTER_LINEAR,
                 "soft": cv2.INTER_CUBIC}
NOISE_TYPES = ["block", "linear", "soft"]
FRACTAL_TYPES = ["basic", "turbulent", "ridged"]


def _lattice(n, seed):
    return np.random.default_rng(int(seed) & 0x7FFFFFFF).random((n, n), dtype=np.float32)


def _fractal_field(h, w, scale=100.0, stretchW=100.0, stretchH=100.0, rotation=0.0,
                   offsetX=0.0, offsetY=0.0, complexity=6, influence=70.0,
                   subScaling=50.0, subRotation=0.0, fractalType="basic",
                   noiseType="soft", z=0.0, seed=1, channel=0, draft=False):
    """One (h, w) float32 plane of multi-octave value noise, ~0..1.

    `channel` decorrelates a second field from the same seed - which is what a
    displacement needs for its two axes, and what a person means by "the same
    noise settings" when they expect x and y to be different fields.
    """
    gh, gw = (max(8, h // 2), max(8, w // 2)) if (draft and min(h, w) > 96) else (h, w)
    cells = 400.0 / max(1e-3, float(scale))          # base cells across the long edge
    lac = 100.0 / max(1e-3, float(subScaling))
    long_edge = float(max(gw, gh))
    zi = int(math.floor(z))
    zf = float(z - zi)
    zf = zf * zf * (3.0 - 2.0 * zf)   # smoothstep, so evolution has no kink at a slice
    interp = _NOISE_INTERP.get(noiseType, cv2.INTER_LINEAR) | cv2.WARP_INVERSE_MAP
    base = (int(seed) & 0xFFFFF) * 2654435761 + int(channel) * 0x9E3779B1
    ox, oy = gw * 0.5, gh * 0.5
    total = np.zeros((gh, gw), np.float32)
    amp, norm, energy = 1.0, 0.0, 0.0
    for k in range(max(1, int(complexity))):
        n = int(min(_LATTICE_MAX, max(16, int(math.ceil(cells)) * 2)))
        lat = np.empty((n, n, 2), np.float32)
        for i in (0, 1):
            lat[..., i] = _lattice(n, base + k * 0x85EBCA6B + (zi + i) * 0xC2B2AE35)
        th = math.radians(rotation + subRotation * k)
        c, s = math.cos(th), math.sin(th)
        kx = cells / long_edge * (100.0 / max(1e-3, float(stretchW)))
        ky = cells / long_edge * (100.0 / max(1e-3, float(stretchH)))
        m = np.array([[kx * c, kx * s, 0.0], [-ky * s, ky * c, 0.0]], np.float32)
        # offset is subtracted BEFORE the rotation, so a pattern drifts across
        # the screen rather than along its own axes - which is what someone
        # animating Offset while Rotation is non-zero is asking for
        m[0, 2] = -(m[0, 0] * (ox + offsetX) + m[0, 1] * (oy + offsetY))
        m[1, 2] = -(m[1, 0] * (ox + offsetX) + m[1, 1] * (oy + offsetY))
        o = cv2.warpAffine(lat, m, (gw, gh), flags=interp, borderMode=cv2.BORDER_WRAP)
        v = o[..., 0] + (o[..., 1] - o[..., 0]) * zf
        if fractalType == "turbulent":
            v = np.abs(v * 2.0 - 1.0)            # the fold is what makes smoke wispy
        elif fractalType == "ridged":
            v = 1.0 - np.abs(v * 2.0 - 1.0)      # and inverting the fold makes veins
        else:
            v = v * 2.0 - 1.0                    # signed: octaves cancel, not pile up
        total += v * amp
        norm += amp
        energy += amp * amp
        amp *= max(0.0, float(influence) / 100.0)
        cells *= lac
        if amp < 1e-3 or cells > long_edge:      # sub-pixel or silent: nothing left
            break
    if fractalType == "basic":
        # Sum-of-signed-octaves is divided by the ROOT of the summed energy, not
        # by the summed amplitude: independent octaves add in quadrature, so
        # dividing by the sum washes the field out as complexity rises and the
        # same settings look different at 2 octaves and at 8. This way contrast
        # holds, at the cost of the odd excursion past 0..1 - which is what the
        # overflow control is for.
        total = total * (0.5 / max(math.sqrt(energy), 1e-6)) + 0.5
    else:
        total = total / max(norm, 1e-6)
    if (gh, gw) != (h, w):
        total = cv2.resize(total, (w, h), interpolation=cv2.INTER_LINEAR)
    return np.ascontiguousarray(total, dtype=np.float32)


def _noise_params(p, ctx, prefix="", channel=0, complexity=None):
    """Pull a fractal field out of the six-or-so noise params an effect exposes,
    filling in the ones it chose not to. Keeps five effects honest about what
    the same seed means."""
    def g(key, default):
        return p.get(prefix + key if prefix else key, default)

    speed = float(g("evolutionSpeed", 0.0))
    z = float(g("evolution", 0.0)) / 360.0 + speed * float(ctx.get("t") or 0.0)
    return dict(scale=float(g("scale", 100.0)),
                stretchW=float(g("stretchWidth", 100.0)),
                stretchH=float(g("stretchHeight", 100.0)),
                rotation=float(g("rotation", 0.0)),
                offsetX=float(g("offsetX", 0.0)), offsetY=float(g("offsetY", 0.0)),
                complexity=int(complexity if complexity is not None else g("complexity", 3)),
                influence=float(g("subInfluence", 70.0)),
                subScaling=float(g("subScaling", 50.0)),
                subRotation=float(g("subRotation", 0.0)),
                fractalType=str(g("fractalType", "turbulent")),
                noiseType=str(g("noiseType", "soft")),
                z=z, seed=int(g("seed", 1)), channel=channel,
                draft=bool(ctx.get("draft")))


# ---------------------------------------------------------------------------
# Blur & Sharpen
# ---------------------------------------------------------------------------

@effect("gaussianBlur", "Gaussian Blur", "Blur & Sharpen",
        "Soften. The default blur - radius is the gaussian sigma, the same "
        "number the Images screen uses, so 8 here looks like 8 there.",
        {"radius": num(8, 0, 200, "blur sigma in pixels; past ~200 the frame is flat", unit="px"),
         "dimensions": pick(["both", "horizontal", "vertical"], "both",
                            "blur one axis only for a smear rather than a soften"),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp",
                              "clamp repeats the frame edge; transparent lets it fade off")},
        touches_alpha=True)      # a blur softens the matte too, or the edge stays razor sharp
def _gaussian_blur(rgba, p, ctx):
    r = p["radius"]
    if r < 0.05:
        return rgba
    sx = r if p["dimensions"] in ("both", "horizontal") else 0.0
    sy = r if p["dimensions"] in ("both", "vertical") else 0.0
    return _blur_rgba(rgba, sx, sy, p["edgeBehavior"], ctx.get("draft"))


@effect("boxBlur", "Box Blur", "Blur & Sharpen",
        "A cheap blur with a square kernel. Two or three iterations converge on "
        "a gaussian for a fraction of the cost, and one iteration is the boxy "
        "look on purpose.",
        {"radius": num(6, 0, 200, "half the box width, in pixels", unit="px"),
         "iterations": num(1, 1, 4, "repeats; 3 is visually a gaussian", integer=True),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp", "how the frame edge is fed")},
        touches_alpha=True)
def _box_blur(rgba, p, ctx):
    r = int(round(p["radius"]))
    if r < 1:
        return rgba
    border = _border_of(p["edgeBehavior"])
    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    k = (r * 2 + 1, r * 2 + 1)
    ab = a
    for _ in range(int(p["iterations"])):
        pm = cv2.boxFilter(pm, -1, k, borderType=border)
        ab = cv2.boxFilter(ab, -1, k, borderType=border)
    return _unpremul(pm, ab)


@effect("directionalBlur", "Directional Blur", "Blur & Sharpen",
        "A straight-line smear - motion that did not happen, or the tail on a "
        "fast title. Length is the whole smear, not a radius.",
        {"length": num(20, 0, 200, "smear length in pixels", unit="px"),
         "angle": num(0, -360, 360, "degrees, 0 = horizontal, clockwise on screen", unit="deg"),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp", "how the frame edge is fed")},
        touches_alpha=True)
def _directional_blur(rgba, p, ctx):
    length = p["length"]
    if length < 1.5:
        return rgba
    border = _border_of(p["edgeBehavior"])
    lim = 12.0 if ctx.get("draft") else 24.0
    factor = min(max(1.0, length / lim), 8.0)

    def run(img, f):
        k = _line_kernel(length / f, p["angle"])
        return img if k is None else cv2.filter2D(img, -1, k, borderType=border)

    warped = _at_scale(_premul4(rgba), factor, run)
    return _unpremul(warped[..., :3], warped[..., 3])


def _line_kernel(length, angle_deg):
    n = int(round(length))
    if n < 2:
        return None
    size = n if n % 2 == 1 else n + 1
    k = np.zeros((size, size), np.float32)
    th = math.radians(angle_deg)
    dx, dy = math.cos(th), math.sin(th)
    c = (size - 1) / 2.0
    steps = size * 3
    for i in range(steps + 1):
        u = (i / steps - 0.5) * (n - 1)
        x, y = c + dx * u, c + dy * u
        x0, y0 = int(math.floor(x)), int(math.floor(y))
        fx, fy = x - x0, y - y0
        # bilinear splat: a shallow angle drawn with integer steps comes out as
        # a dotted line, and a dotted kernel is a ghost, not a blur
        for xx, yy, wgt in ((x0, y0, (1 - fx) * (1 - fy)), (x0 + 1, y0, fx * (1 - fy)),
                            (x0, y0 + 1, (1 - fx) * fy), (x0 + 1, y0 + 1, fx * fy)):
            if 0 <= xx < size and 0 <= yy < size:
                k[yy, xx] += wgt
    s = float(k.sum())
    return k / s if s > 0 else None


@effect("radialBlur", "Radial Blur", "Blur & Sharpen",
        "Zoom or spin around a point - the hyperspace streak, or a wheel that "
        "will not hold still.",
        {"type": pick(["zoom", "spin"], "zoom", "streak outward from the centre, or around it"),
         "amount": num(10, 0, 100, "zoom: percent of extra scale across the sweep. "
                                   "spin: degrees swept", unit="%"),
         "centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "samples": num(12, 2, 48, "steps in the sweep; more is smoother and slower",
                        integer=True, animatable=False)},
        touches_alpha=True)
def _radial_blur(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    n = int(p["samples"])
    if ctx.get("draft"):
        n = max(2, min(n, 5))
    pm = _premul4(rgba)
    acc = np.zeros_like(pm)
    for i in range(n):
        f = i / (n - 1) if n > 1 else 0.0
        if p["type"] == "zoom":
            m = cv2.getRotationMatrix2D((cx, cy), 0.0, 1.0 + p["amount"] / 100.0 * f)
        else:
            m = cv2.getRotationMatrix2D((cx, cy), p["amount"] * (f - 0.5), 1.0)
        acc += cv2.warpAffine(pm, m, (w, h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    acc /= float(n)
    return _unpremul(acc[..., :3], acc[..., 3])


@effect("unsharpMask", "Unsharp Mask", "Blur & Sharpen",
        "Sharpen by adding back what a blur removed. The threshold is the whole "
        "point: below it nothing happens, so grain and skin stay smooth while "
        "edges get their bite.",
        {"amount": num(80, 0, 500, "percent of the detail layer added back", unit="%"),
         "radius": num(2, 0.2, 50, "size of the detail it looks for, in pixels", unit="px"),
         "threshold": num(2, 0, 100, "ignore differences smaller than this "
                                     "(percent of full range)", unit="%")})
def _unsharp_mask(rgba, p, ctx):
    if p["amount"] < 0.5:
        return rgba
    rgb = _rgb(rgba)
    blurred = _blur2(rgb, p["radius"], p["radius"], cv2.BORDER_REPLICATE, ctx.get("draft"))
    diff = rgb - blurred
    thr = p["threshold"] / 100.0
    if thr > 0.0005:
        mag = np.abs(diff).max(axis=-1)
        diff = diff * _smoothstep(thr, thr * 2.0 + 0.004, mag)[..., None]
    return _pack(rgb + diff * (p["amount"] / 100.0), _alpha(rgba))


@effect("bilateralSmooth", "Bilateral Smooth", "Blur & Sharpen",
        "Smooths flat areas but refuses to cross an edge - the skin-and-sky "
        "cleanup, and the first step of a cel-shaded look. Genuinely expensive; "
        "draft renders skip it.",
        {"radius": num(5, 1, 15, "pixel neighbourhood; cost grows with its square",
                       integer=True, unit="px"),
         "colorSigma": num(25, 1, 100, "how different a colour may be and still be "
                                       "averaged in", unit="%"),
         "spaceSigma": num(25, 1, 100, "how far away a pixel may be and still count", unit="%")},
        expensive=True)
def _bilateral(rgba, p, ctx):
    if ctx.get("draft"):
        return rgba
    rgb = _rgb(rgba)
    out = cv2.bilateralFilter(rgb, int(p["radius"]) * 2 + 1,
                              p["colorSigma"] / 100.0, p["spaceSigma"] / 100.0 * 40.0)
    return _pack(out, _alpha(rgba))


@effect("channelBlur", "Channel Blur", "Blur & Sharpen",
        "A separate radius per channel. Blurring chroma while leaving luma "
        "sharp is how a compressed source stops looking compressed, and an "
        "alpha-only blur is a feather you can key off a colour blur.",
        {"redBlur": num(0, 0, 200, "blur sigma on red, in pixels", unit="px"),
         "greenBlur": num(0, 0, 200, "blur sigma on green, in pixels", unit="px"),
         "blueBlur": num(0, 0, 200, "blur sigma on blue, in pixels", unit="px"),
         "alphaBlur": num(0, 0, 200, "blur sigma on the matte, in pixels", unit="px"),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp", "how the frame edge is fed")},
        touches_alpha=True)      # only when alphaBlur is up, but the flag is static
def _channel_blur(rgba, p, ctx):
    sig = [p["redBlur"], p["greenBlur"], p["blueBlur"]]
    if max(sig + [p["alphaBlur"]]) < 0.05:
        return rgba
    border = _border_of(p["edgeBehavior"])
    draft = ctx.get("draft")
    a = _alpha(rgba)
    rgb = _rgb(rgba)
    out = rgb.copy()
    # Each colour channel is an alpha-WEIGHTED average - premultiplied numerator
    # over a matte blurred by the SAME sigma - not a premultiplied blur divided
    # by the alpha this effect happens to be blurring too. Couple them and an
    # alpha-only blur paints a black halo out of nothing, because it divides
    # untouched colour by a matte that just grew past it.
    dens = {}
    for i, s in enumerate(sig):
        if s < 0.05:
            continue
        key = round(float(s), 4)
        if key not in dens:
            dens[key] = _blur2(a, s, s, border, draft)
        num = _blur2(np.ascontiguousarray(rgb[..., i] * a), s, s, border, draft)
        out[..., i] = num / np.maximum(dens[key], _EPS)
    ab = _blur2(a, p["alphaBlur"], p["alphaBlur"], border, draft) if p["alphaBlur"] >= 0.05 else a
    return _pack(np.clip(out, 0, 1), np.clip(ab, 0, 1))


@effect("compoundBlur", "Compound Blur", "Blur & Sharpen",
        "Blur by a map instead of by a number: bright parts of the map blur "
        "hard, dark parts stay sharp. Name a `blurLayer` and that layer's "
        "luminance is the depth - a real defocus off a depth pass, a rack "
        "focus driven by a ramp somebody keyframed, a background softened "
        "where it is far and left alone where it is near. Empty reads THIS "
        "layer, which is the fake depth of field off its own brightness. One "
        "blur per level and the levels are the whole cost: measured at 1080p, "
        "240ms at two, 500ms at five, 620ms at eight. Fitting a map layer "
        "disappears into that.",
        {"blurLayer": lay("layer whose channel decides the local radius; empty "
                          "reads this layer's own"),
         "mapFit": mapfit("blur map"),
         "maxRadius": num(20, 0, 200, "blur at the top of the map, in pixels", unit="px"),
         "map": pick(["luminance", "alpha", "red", "green", "blue"], "luminance",
                     "which channel of the map decides the local radius"),
         "levels": num(5, 2, 8, "blurred versions built and interpolated between; "
                                "more is smoother and costs one blur each",
                       integer=True, animatable=False),
         "invert": flag(False, "blur the dark end instead"),
         "edgeBehavior": pick(["clamp", "transparent"], "clamp", "how the frame edge is fed")},
        touches_alpha=True, expensive=True)
def _compound_blur(rgba, p, ctx):
    if p["maxRadius"] < 0.5:
        return rgba
    h, w = rgba.shape[:2]
    map_src, _other = _map_source(ctx, p, "blurLayer", rgba, "compoundBlur")
    m = _fit_map(_map_channel(map_src, p["map"]), h, w, p["mapFit"])
    m = np.clip(m, 0.0, 1.0)
    if p["invert"]:
        m = 1.0 - m
    n = max(2, min(int(p["levels"]), 4 if ctx.get("draft") else 8))
    border = _border_of(p["edgeBehavior"])
    pos = m * (n - 1)
    src = _premul4(rgba)
    acc = np.zeros_like(src)
    # One level at a time, weighted straight into the accumulator: holding all
    # five blurred copies of a 1080p RGBA frame at once is 165MB for no reason.
    for i in range(n):
        wgt = np.clip(1.0 - np.abs(pos - i), 0.0, 1.0)
        if not wgt.any():
            continue
        r = p["maxRadius"] * i / (n - 1.0)
        lvl = src if r < 0.05 else _blur2(src, r, r, border, ctx.get("draft"))
        acc += lvl * wgt[..., None]
    return _unpremul(acc[..., :3], acc[..., 3])


# ---------------------------------------------------------------------------
# Color
# ---------------------------------------------------------------------------

@effect("brightnessContrast", "Brightness & Contrast", "Color",
        "The two knobs everyone reaches for first. Contrast pivots on mid grey "
        "so it opens and closes the image instead of sliding it.",
        {"brightness": num(0, -100, 100, "added light; 100 pushes everything white", unit="%"),
         "contrast": num(0, -100, 100, "spread around mid grey; -100 is flat grey", unit="%")})
def _brightness_contrast(rgba, p, ctx):
    b, c = p["brightness"] / 100.0, p["contrast"] / 100.0
    if abs(b) < 1e-4 and abs(c) < 1e-4:
        return rgba
    k = 1.0 + c if c >= 0 else 1.0 / (1.0 - c)
    rgb = (_rgb(rgba) - 0.5) * k + 0.5 + b
    return _pack(rgb, _alpha(rgba))


@effect("curves", "Curves", "Color",
        "Tone by hand. Same PCHIP through the control points as the Images "
        "screen, so a curve copied from there lands identically here.",
        {"master": pts([[0, 0], [255, 255]], "points on 0..255, applied to all three channels"),
         "red": pts([[0, 0], [255, 255]], "points on 0..255, red only"),
         "green": pts([[0, 0], [255, 255]], "points on 0..255, green only"),
         "blue": pts([[0, 0], [255, 255]], "points on 0..255, blue only"),
         "alpha": pts([[0, 0], [255, 255]], "points on 0..255, the matte itself"),
         "amount": num(100, 0, 100, "blend against the untouched image", unit="%")},
        touches_alpha=True)      # the alpha curve is why this one may move the matte
def _curves(rgba, p, ctx):
    todo = [k for k in ("master", "red", "green", "blue", "alpha")
            if not _is_identity_curve(p[k])]
    if not todo or p["amount"] < 0.05:
        return rgba
    rgb = _rgb(rgba)
    a = _alpha(rgba)
    lut = _pchip_lut(p["master"])
    if lut is not None and "master" in todo:
        rgb = _apply_lut(rgb, lut)          # all three channels in one pass
    for i, key in enumerate(("red", "green", "blue")):
        if key in todo:
            lut = _pchip_lut(p[key])
            if lut is not None:
                rgb[..., i] = _apply_lut(rgb[..., i], lut)
    if "alpha" in todo:
        lut = _pchip_lut(p["alpha"])
        if lut is not None:
            a = _apply_lut(a, lut)
    w = p["amount"] / 100.0
    if w < 0.999:
        rgb = _rgb(rgba) * (1 - w) + rgb * w
        a = _alpha(rgba) * (1 - w) + a * w
    return _pack(rgb, a)


@effect("levels", "Levels", "Color",
        "Where black starts, where white clips, and where the midtone sits "
        "between them. Curves can express this; nobody reaches for a curve to "
        "fix a flat scan - they drag the black point.",
        {"channel": pick(["rgb", "red", "green", "blue"], "rgb",
                         "which channel the numbers apply to"),
         "inBlack": num(0, 0, 254, "input value that becomes black, 0..255"),
         "inWhite": num(255, 1, 255, "input value that becomes white, 0..255"),
         "gamma": num(1.0, 0.1, 9.99, "midtone bend; above 1 lifts the mids"),
         "outBlack": num(0, 0, 255, "black is remapped to this, 0..255"),
         "outWhite": num(255, 0, 255, "white is remapped to this, 0..255")})
def _levels(rgba, p, ctx):
    lo, hi = p["inBlack"] / 255.0, p["inWhite"] / 255.0
    if hi - lo < 1e-4:
        return rgba
    olo, ohi = p["outBlack"] / 255.0, p["outWhite"] / 255.0
    rgb = _rgb(rgba)
    sl = {"rgb": slice(None), "red": 0, "green": 1, "blue": 2}[p["channel"]]
    v = np.clip((rgb[..., sl] - lo) / (hi - lo), 0, 1)
    if abs(p["gamma"] - 1.0) > 1e-3:
        v = np.power(v, 1.0 / p["gamma"])
    rgb[..., sl] = olo + v * (ohi - olo)
    return _pack(rgb, _alpha(rgba))


@effect("hueSaturation", "Hue & Saturation", "Color",
        "Rotate the whole colour wheel, or drain it. Colorize throws the "
        "original hues away and paints everything one colour by brightness.",
        {"hue": num(0, -180, 180, "rotation of the colour wheel in degrees", unit="deg"),
         "saturation": num(0, -100, 100, "-100 is greyscale, +100 doubles the chroma", unit="%"),
         "lightness": num(0, -100, 100, "lift or crush the value channel", unit="%"),
         "colorize": flag(False, "discard the source hues and tint by brightness instead"),
         "colorizeHue": num(200, 0, 360, "hue used when colorize is on", unit="deg"),
         "colorizeSaturation": num(35, 0, 100, "chroma of the colorize tint", unit="%")})
def _hue_saturation(rgba, p, ctx):
    if (not p["colorize"] and abs(p["hue"]) < 1e-3
            and abs(p["saturation"]) < 1e-3 and abs(p["lightness"]) < 1e-3):
        return rgba
    hsv = cv2.cvtColor(_rgb(rgba), cv2.COLOR_RGB2HSV)
    if p["colorize"]:
        hsv[..., 0] = p["colorizeHue"] % 360.0
        hsv[..., 1] = p["colorizeSaturation"] / 100.0
    else:
        hsv[..., 0] = np.mod(hsv[..., 0] + p["hue"], 360.0)
        s = p["saturation"] / 100.0
        hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 + s), 0, 1) if s >= 0 else hsv[..., 1] * (1.0 + s)
    lg = p["lightness"] / 100.0
    if abs(lg) > 1e-3:
        hsv[..., 2] = hsv[..., 2] + (1.0 - hsv[..., 2]) * lg if lg > 0 else hsv[..., 2] * (1.0 + lg)
    rgb = cv2.cvtColor(np.clip(hsv, [0, 0, 0], [360, 1, 1]).astype(np.float32), cv2.COLOR_HSV2RGB)
    return _pack(rgb, _alpha(rgba))


@effect("exposure", "Exposure", "Color",
        "Stops, the way a camera means them: +1 is twice the light. Offset "
        "lifts the black point after, gamma bends what is left.",
        {"exposure": num(0, -8, 8, "stops; each one doubles or halves the light", unit="stops"),
         "offset": num(0, -0.5, 0.5, "flat lift added after the exposure"),
         "gamma": num(1.0, 0.1, 4.0, "gamma correction applied last")})
def _exposure(rgba, p, ctx):
    if abs(p["exposure"]) < 1e-4 and abs(p["offset"]) < 1e-5 and abs(p["gamma"] - 1) < 1e-4:
        return rgba
    rgb = _rgb(rgba) * (2.0 ** p["exposure"]) + p["offset"]
    if abs(p["gamma"] - 1.0) > 1e-4:
        rgb = np.power(np.clip(rgb, 0, None), 1.0 / p["gamma"])
    return _pack(rgb, _alpha(rgba))


@effect("tint", "Tint", "Color",
        "Remap the whole image between two colours by brightness - the duotone, "
        "and the honest way to bed a shot into a palette.",
        {"blackColor": col([0, 20, 60], "what the darkest pixels become"),
         "whiteColor": col([255, 235, 200], "what the brightest pixels become"),
         "amount": num(100, 0, 100, "blend against the untouched image", unit="%")})
def _tint(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    lum = _luma(rgb)[..., None]
    mapped = _rgb01(p["blackColor"]) + lum * (_rgb01(p["whiteColor"]) - _rgb01(p["blackColor"]))
    return _pack(rgb * (1 - w) + mapped * w, _alpha(rgba))


@effect("colorBalance", "Color Balance", "Color",
        "Push colour into the shadows, mids and highlights separately - warm "
        "the faces without warming the sky. Masks are luminance-weighted, the "
        "same shape the Images screen uses for shadow/highlight recovery.",
        {"shadowRed": num(0, -100, 100, "red in the darks", unit="%"),
         "shadowGreen": num(0, -100, 100, "green in the darks", unit="%"),
         "shadowBlue": num(0, -100, 100, "blue in the darks", unit="%"),
         "midRed": num(0, -100, 100, "red in the midtones", unit="%"),
         "midGreen": num(0, -100, 100, "green in the midtones", unit="%"),
         "midBlue": num(0, -100, 100, "blue in the midtones", unit="%"),
         "highRed": num(0, -100, 100, "red in the highlights", unit="%"),
         "highGreen": num(0, -100, 100, "green in the highlights", unit="%"),
         "highBlue": num(0, -100, 100, "blue in the highlights", unit="%"),
         "preserveLuminosity": flag(True, "put the original brightness back afterwards, so "
                                          "the grade moves colour and not exposure")})
def _color_balance(rgba, p, ctx):
    shifts = np.array([[p["shadowRed"], p["shadowGreen"], p["shadowBlue"]],
                       [p["midRed"], p["midGreen"], p["midBlue"]],
                       [p["highRed"], p["highGreen"], p["highBlue"]]], np.float32) / 100.0 * 0.5
    if not np.abs(shifts).any():
        return rgba
    rgb = _rgb(rgba)
    lum = _luma(rgb)
    m_lo = np.clip(1.0 - lum / 0.5, 0, 1) ** 2
    m_hi = np.clip((lum - 0.5) / 0.5, 0, 1) ** 2
    m_mid = np.clip(1.0 - m_lo - m_hi, 0, 1)
    out = rgb + (m_lo[..., None] * shifts[0] + m_mid[..., None] * shifts[1]
                 + m_hi[..., None] * shifts[2])
    if p["preserveLuminosity"]:
        out = out + (lum - _luma(np.clip(out, 0, 1)))[..., None]
    return _pack(out, _alpha(rgba))


@effect("vibrance", "Vibrance", "Color",
        "Saturation that leaves the already-loud alone. Weighted by how "
        "colourful a pixel already is, which is why it does not turn faces "
        "orange the way a saturation slider does.",
        {"vibrance": num(30, -100, 100, "boost weighted against existing chroma", unit="%"),
         "saturation": num(0, -100, 100, "a flat saturation on top, for when you do "
                                         "want the blunt one", unit="%")})
def _vibrance(rgba, p, ctx):
    vib, sat = p["vibrance"] / 100.0, p["saturation"] / 100.0
    if abs(vib) < 1e-4 and abs(sat) < 1e-4:
        return rgba
    rgb = _rgb(rgba)
    mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
    chroma = np.clip(mx - mn, 0, 1)
    grey = _luma(rgb)[..., None]
    k = 1.0 + sat + vib * (1.0 - chroma)[..., None]
    return _pack(grey + (rgb - grey) * k, _alpha(rgba))


@effect("channelMixer", "Channel Mixer", "Color",
        "Build each output channel from all three inputs. The knob behind every "
        "convincing black and white and every deliberate colour break.",
        {"redFromRed": num(100, -200, 200, "percent of red in the new red", unit="%"),
         "redFromGreen": num(0, -200, 200, "percent of green in the new red", unit="%"),
         "redFromBlue": num(0, -200, 200, "percent of blue in the new red", unit="%"),
         "greenFromRed": num(0, -200, 200, "percent of red in the new green", unit="%"),
         "greenFromGreen": num(100, -200, 200, "percent of green in the new green", unit="%"),
         "greenFromBlue": num(0, -200, 200, "percent of blue in the new green", unit="%"),
         "blueFromRed": num(0, -200, 200, "percent of red in the new blue", unit="%"),
         "blueFromGreen": num(0, -200, 200, "percent of green in the new blue", unit="%"),
         "blueFromBlue": num(100, -200, 200, "percent of blue in the new blue", unit="%"),
         "monochrome": flag(False, "copy the red row into all three outputs")})
def _channel_mixer(rgba, p, ctx):
    m = np.array([[p["redFromRed"], p["redFromGreen"], p["redFromBlue"]],
                  [p["greenFromRed"], p["greenFromGreen"], p["greenFromBlue"]],
                  [p["blueFromRed"], p["blueFromGreen"], p["blueFromBlue"]]], np.float32) / 100.0
    if p["monochrome"]:
        m[1] = m[0]
        m[2] = m[0]
    elif np.allclose(m, np.eye(3, dtype=np.float32)):
        return rgba
    return _pack(_rgb(rgba) @ m.T, _alpha(rgba))


@effect("invert", "Invert", "Color",
        "Flip the channel. Amount exists so a half invert can be keyframed "
        "through - and so a full one is exactly its own undo.",
        {"channel": pick(["rgb", "red", "green", "blue", "luminance"], "rgb",
                         "what gets flipped"),
         "amount": num(100, 0, 100, "100 is a full inversion; two of those is identity", unit="%")})
def _invert(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    ch = p["channel"]
    if ch == "rgb":
        rgb = rgb + (1.0 - 2.0 * rgb) * w
    elif ch == "luminance":
        lum = _luma(rgb)[..., None]
        rgb = rgb + (1.0 - 2.0 * lum) * w
    else:
        i = {"red": 0, "green": 1, "blue": 2}[ch]
        rgb[..., i] = rgb[..., i] + (1.0 - 2.0 * rgb[..., i]) * w
    return _pack(rgb, _alpha(rgba))


@effect("blackAndWhite", "Black & White", "Color",
        "Greyscale with a say in it: how bright each hue family lands. Defaults "
        "are Photoshop's, so a red at 40 and a yellow at 60 read the way a "
        "photographer expects.",
        {"reds": num(40, -200, 300, "how bright reds become", unit="%"),
         "yellows": num(60, -200, 300, "how bright yellows become", unit="%"),
         "greens": num(40, -200, 300, "how bright greens become", unit="%"),
         "cyans": num(60, -200, 300, "how bright cyans become", unit="%"),
         "blues": num(20, -200, 300, "how bright blues become", unit="%"),
         "magentas": num(80, -200, 300, "how bright magentas become", unit="%"),
         "tint": flag(False, "tone the result instead of leaving it neutral"),
         "tintColor": col([230, 200, 160], "the tone applied when tint is on"),
         "amount": num(100, 0, 100, "blend against the colour original", unit="%")})
def _black_and_white(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hue = hsv[..., 0]
    weights = [p["reds"], p["yellows"], p["greens"], p["cyans"], p["blues"], p["magentas"]]
    # Triangular 60-degree bands: memberships of the two neighbouring families
    # always sum to one, which makes this exactly Photoshop's model - pure red
    # at 40% lands on 0.40 grey, pure blue at 20% on 0.20.
    mix = np.zeros(hue.shape, np.float32)
    for i, wt in enumerate(weights):
        d = np.abs(((hue - i * 60.0 + 180.0) % 360.0) - 180.0)
        mix += np.clip(1.0 - d / 60.0, 0, 1) * (wt / 100.0)
    mn = rgb.min(axis=-1)
    grey = np.clip(mn + (rgb.max(axis=-1) - mn) * mix, 0, 1)
    out = np.repeat(grey[..., None], 3, axis=-1)
    if p["tint"]:
        out = out * _rgb01(p["tintColor"])[None, None, :] * 1.15
    return _pack(rgb * (1 - w) + out * w, _alpha(rgba))


@effect("tritone", "Tritone", "Color",
        "Three colours instead of Tint's two: the shadows, the midtone and the "
        "highlight each get their own. The midtone is what stops a duotone "
        "looking like a photocopy - it is where every face in the shot lives.",
        {"shadowColor": col([12, 14, 40], "what the darkest pixels become"),
         "midColor": col([150, 100, 120], "what mid grey becomes"),
         "highColor": col([255, 240, 210], "what the brightest pixels become"),
         "midPoint": num(50, 5, 95, "where the midtone colour sits on the luma scale", unit="%"),
         "amount": num(100, 0, 100, "blend against the untouched image", unit="%")})
def _tritone(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    lum = _luma(rgb)
    mid = p["midPoint"] / 100.0
    lo = _rgb01(p["shadowColor"])
    md = _rgb01(p["midColor"])
    hi = _rgb01(p["highColor"])
    tl = np.clip(lum / max(mid, 1e-3), 0, 1)[..., None]
    th = np.clip((lum - mid) / max(1.0 - mid, 1e-3), 0, 1)[..., None]
    mapped = np.where(lum[..., None] <= mid, lo + (md - lo) * tl, md + (hi - md) * th)
    return _pack(rgb * (1 - w) + mapped.astype(np.float32) * w, _alpha(rgba))


@effect("colorama", "Colorama", "Color",
        "Push the picture through a colour wheel and then TURN the wheel. Four "
        "stops, cycled as many times as you like, with a phase that animates - "
        "which is the heat map, the oil slick, the plasma, and every energy "
        "effect anyone has ever built out of a gradient.",
        {"input": pick(["luminance", "red", "green", "blue", "alpha", "hue"], "luminance",
                       "what is looked up in the palette"),
         "colorA": col([10, 10, 60], "first stop"),
         "colorB": col([220, 40, 90], "second stop"),
         "colorC": col([255, 200, 60], "third stop"),
         "colorD": col([40, 200, 220], "fourth stop; it wraps back into the first"),
         "phase": num(0, -3600, 3600, "rotate the palette, in degrees", unit="deg"),
         "phaseSpeed": num(0, -10, 10, "full turns of the palette per second", unit="Hz"),
         "cycles": num(1, 0.1, 12, "how many times the palette repeats over the range"),
         "smooth": flag(True, "off gives four hard bands instead of a gradient"),
         "amount": num(100, 0, 100, "blend against the untouched image", unit="%")})
def _colorama(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    a = _alpha(rgba)
    src = p["input"]
    if src == "luminance":
        v = _luma(rgb)
    elif src == "alpha":
        v = a
    elif src == "hue":
        v = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)[..., 0] / 360.0
    else:
        v = rgb[..., {"red": 0, "green": 1, "blue": 2}[src]]
    phase = p["phase"] / 360.0 + p["phaseSpeed"] * float(ctx.get("t") or 0.0)
    u = np.mod(np.clip(v, 0, 1) * p["cycles"] + phase, 1.0) * 4.0
    stops = np.stack([_rgb01(p[k]) for k in ("colorA", "colorB", "colorC", "colorD")])
    i = np.floor(u).astype(np.int32) % 4
    f = (u - np.floor(u))[..., None].astype(np.float32)
    if not p["smooth"]:
        f = np.zeros_like(f)
    mapped = stops[i] + (stops[(i + 1) % 4] - stops[i]) * f
    return _pack(rgb * (1 - w) + mapped.astype(np.float32) * w, a)


@effect("shadowHighlight", "Shadow / Highlight", "Color",
        "Open the shadows and pull the highlights back, LOCALLY - the gain is "
        "decided by a blurred copy of the picture, so a face in a doorway lifts "
        "without the doorway lifting with it. Radius is the whole difference "
        "between this and a curve.",
        {"shadowAmount": num(35, 0, 100, "how far the darks are lifted", unit="%"),
         "highlightAmount": num(20, 0, 100, "how far the brights are pulled down", unit="%"),
         "radius": num(40, 1, 300, "size of the neighbourhood each pixel is judged "
                                   "against, in pixels", unit="px"),
         "midtoneContrast": num(0, -100, 100, "s-curve put back afterwards, because "
                                              "recovery always flattens", unit="%"),
         "amount": num(100, 0, 100, "blend against the untouched image", unit="%")})
def _shadow_highlight(rgba, p, ctx):
    w = p["amount"] / 100.0
    ks, kh = p["shadowAmount"] / 100.0 * 1.6, p["highlightAmount"] / 100.0 * 1.6
    mc = p["midtoneContrast"] / 100.0
    if w < 0.0005 or (ks < 1e-4 and kh < 1e-4 and abs(mc) < 1e-4):
        return rgba
    rgb = _rgb(rgba)
    lum = np.clip(_luma(rgb), 0, 1)
    soft = np.clip(_blur2(lum, p["radius"], p["radius"], cv2.BORDER_REPLICATE,
                          ctx.get("draft")), 0, 1)
    # A local gamma, not a local add: an exponent below 1 lifts the darks
    # without ever pushing a pixel past white, which is why recovery done this
    # way does not posterise the sky it was not aiming at.
    g = (1.0 + kh * (soft * soft)) / (1.0 + ks * ((1.0 - soft) ** 2))
    out = np.power(np.clip(rgb, 0, 1), g[..., None])
    if abs(mc) > 1e-4:
        out = np.clip(out, 0, 1)
        out = out + mc * (out * out * (3.0 - 2.0 * out) - out)
    return _pack(rgb * (1 - w) + out.astype(np.float32) * w, _alpha(rgba))


# ---------------------------------------------------------------------------
# Keying
# ---------------------------------------------------------------------------

@effect("chromaKey", "Chroma Key", "Keying",
        "The greenscreen. Distance to the key colour, a tolerance that goes "
        "fully transparent and a softness band that feathers the rest - ported "
        "from the Images screen so a key set there survives the move.",
        {"color": col([0, 255, 0], "the screen colour being removed"),
         "tolerance": num(25, 0, 100, "everything this close to the key goes fully out", unit="%"),
         "softness": num(10, 0, 100, "width of the feathered band past the tolerance", unit="%"),
         "despill": flag(True, "pull the key hue out of half-transparent edge pixels, so "
                               "hair does not keep a green rim")},
        touches_alpha=True)
def _chroma_key(rgba, p, ctx):
    rgb = _rgb(rgba)
    a = _alpha(rgba)
    key = _rgb01(p["color"])
    tol = max(0.01, p["tolerance"] / 100.0) * 0.75
    soft = max(0.001, p["softness"] / 100.0) * 0.5
    dist = np.sqrt(((rgb - key) ** 2).sum(axis=-1))
    keyed = np.clip((dist - tol) / soft, 0.0, 1.0)
    out_a = a * keyed
    if p["despill"]:
        edge = (keyed > 0) & (keyed < 1)
        if edge.any():
            dom = int(np.argmax(key))
            others = [i for i in range(3) if i != dom]
            cap = np.maximum(rgb[..., others[0]], rgb[..., others[1]])
            rgb[..., dom] = np.where(edge, np.minimum(rgb[..., dom], cap), rgb[..., dom])
    return _pack(rgb, out_a)


@effect("lumaKey", "Luma Key", "Keying",
        "Key on brightness instead of colour - the only thing that works on a "
        "white-card logo, smoke plate or a stock explosion on black.",
        {"keyOut": pick(["darker", "brighter"], "darker", "which end of the range disappears"),
         "threshold": num(20, 0, 100, "where the cut sits on the luminance scale", unit="%"),
         "softness": num(10, 0, 100, "feather width past the threshold", unit="%"),
         "invert": flag(False, "swap what survives")},
        touches_alpha=True)
def _luma_key(rgba, p, ctx):
    lum = _luma(_rgb(rgba))
    thr = p["threshold"] / 100.0
    soft = max(0.002, p["softness"] / 100.0)
    keep = (_smoothstep(thr, thr + soft, lum) if p["keyOut"] == "darker"
            else 1.0 - _smoothstep(thr - soft, thr, lum))
    if p["invert"]:
        keep = 1.0 - keep
    return _pack(_rgb(rgba), _alpha(rgba) * keep)


@effect("colorRangeKey", "Color Range Key", "Keying",
        "Key a range of colour in a space that separates chroma from "
        "brightness. Lab or YCbCr hold a key through a lighting change that "
        "plain RGB distance loses.",
        {"color": col([0, 255, 0], "the colour at the centre of the range"),
         "space": pick(["lab", "ycbcr", "rgb"], "lab", "the space the distance is measured in"),
         "tolerance": num(20, 0, 100, "radius of the range that goes out", unit="%"),
         "softness": num(12, 0, 100, "feather past the tolerance", unit="%"),
         "invert": flag(False, "keep the range and drop everything else")},
        touches_alpha=True)
def _color_range_key(rgba, p, ctx):
    rgb = _rgb(rgba)
    key = _rgb01(p["color"]).reshape(1, 1, 3)
    space = p["space"]
    if space == "lab":
        conv, norm = cv2.COLOR_RGB2Lab, np.array([100.0, 128.0, 128.0], np.float32)
    elif space == "ycbcr":
        conv, norm = cv2.COLOR_RGB2YCrCb, np.array([1.0, 1.0, 1.0], np.float32)
    else:
        conv, norm = None, np.array([1.0, 1.0, 1.0], np.float32)
    if conv is None:
        a_img, a_key = rgb, key
    else:
        a_img = cv2.cvtColor(rgb, conv) / norm
        a_key = cv2.cvtColor(np.ascontiguousarray(key), conv) / norm
    dist = np.sqrt(((a_img - a_key) ** 2).sum(axis=-1))
    tol = max(0.005, p["tolerance"] / 100.0)
    soft = max(0.002, p["softness"] / 100.0)
    keep = np.clip((dist - tol) / soft, 0.0, 1.0)
    if p["invert"]:
        keep = 1.0 - keep
    return _pack(rgb, _alpha(rgba) * keep)


@effect("differenceMatte", "Difference Matte", "Keying",
        "Key out what did not change. Name the clean plate as "
        "`differenceLayer` and everything matching it goes transparent, "
        "leaving only what moved - the key for a locked-off shot that has no "
        "green screen anywhere in it, and the only key some footage will ever "
        "allow. Tolerance is the distance that still counts as a match and "
        "softness feathers the rest; `view: matte` shows the key itself, which "
        "is the only way to see a tolerance that is nearly right. There is no "
        "self version: a layer differenced against itself matches everywhere "
        "and would key the whole frame out, so with no layer named this is a "
        "declared no-op rather than a blank frame. 160ms at 1080p, and nothing "
        "at all with no plate named.",
        {"differenceLayer": lay("the clean plate this layer is compared against; "
                                "without one the effect does nothing"),
         "mapFit": mapfit("plate"),
         "tolerance": num(10, 0, 100, "colour distance that still counts as a match",
                          unit="%"),
         "softness": num(10, 0, 100, "feather band past the tolerance", unit="%"),
         "matchOn": pick(["rgb", "luminance"], "rgb",
                         "compare all three channels, or brightness only - luminance "
                         "survives a plate that drifted in colour but not in level"),
         "invert": flag(False, "keep what matches and drop what moved"),
         "view": pick(["final", "matte"], "final",
                      "matte shows the key as grey instead of applying it")},
        touches_alpha=True)
def _difference_matte(rgba, p, ctx):
    plate = _layer_in(ctx, p["differenceLayer"])
    if plate is None:
        if p["differenceLayer"]:
            _note(ctx, 'differenceMatte: layer "%s" was not available - nothing was '
                       'keyed' % p["differenceLayer"])
        return rgba
    h, w = rgba.shape[:2]
    plate = _fit_map(plate, h, w, p["mapFit"])
    a = _alpha(rgba)
    pa = np.clip(plate[..., 3], 0.0, 1.0)
    # PREMULTIPLIED comparison, with the alpha difference folded in. Colour
    # under a transparent pixel is undefined, so comparing straight values
    # there measures whatever the encoder left behind rather than the picture.
    # On the opaque plates this is actually used on, premultiplied IS straight
    # and the alpha term is zero, so the common case costs nothing for it.
    prgb = np.ascontiguousarray(plate[..., :3])
    if p["matchOn"] == "luminance":
        d = np.abs(_luma(_rgb(rgba)) * a - _luma(prgb) * pa)
    else:
        diff = _rgb(rgba) * a[..., None] - prgb * pa[..., None]
        d = np.sqrt((diff * diff).sum(axis=-1) / 3.0)   # /3 so black-vs-white is 1.0
    d = np.maximum(d, np.abs(a - pa))
    tol = p["tolerance"] / 100.0
    soft = max(p["softness"] / 100.0, 1e-4)
    keep = np.clip((d - tol) / soft, 0.0, 1.0)
    if p["invert"]:
        keep = 1.0 - keep
    if p["view"] == "matte":
        return _pack(np.repeat(keep[..., None], 3, axis=2), np.ones_like(keep))
    return _pack(_rgb(rgba), a * keep)


@effect("spillSuppress", "Spill Suppress", "Keying",
        "Take the screen's bounce out of everything, not just the edge a key "
        "feathered. This is the pass that stops a keyed actor glowing green "
        "down one shoulder - it moves colour only, never the matte.",
        {"color": col([0, 255, 0], "the screen colour whose bounce is being removed"),
         "amount": num(80, 0, 100, "how far the offending channel is pulled back", unit="%"),
         "preserveLuminance": flag(True, "put the brightness back after, so suppression "
                                         "does not darken the subject")})
def _spill_suppress(rgba, p, ctx):
    amt = p["amount"] / 100.0
    if amt < 0.005:
        return rgba
    rgb = _rgb(rgba)
    key = _rgb01(p["color"])
    dom = int(np.argmax(key))
    others = [i for i in range(3) if i != dom]
    before = _luma(rgb)
    cap = (rgb[..., others[0]] + rgb[..., others[1]]) * 0.5
    over = np.maximum(rgb[..., dom] - cap, 0.0)
    rgb[..., dom] = rgb[..., dom] - over * amt
    if p["preserveLuminance"]:
        rgb = rgb + (before - _luma(np.clip(rgb, 0, 1)))[..., None]
    return _pack(rgb, _alpha(rgba))


@effect("matteChoke", "Matte Choke", "Keying",
        "Grow, shrink and firm up a matte after a key. Every key leaves a soft "
        "grey fringe; clipping the black and white ends is what turns it back "
        "into an edge.",
        {"amount": num(-1, -50, 50, "pixels; positive grows the matte, negative eats it",
                       unit="px"),
         "feather": num(1, 0, 100, "blur applied to the matte afterwards", unit="px"),
         "blackClip": num(0, 0, 99, "matte below this becomes fully transparent", unit="%"),
         "whiteClip": num(100, 1, 100, "matte above this becomes fully opaque", unit="%")},
        touches_alpha=True)
def _matte_choke(rgba, p, ctx):
    a = _alpha(rgba)
    r = int(round(abs(p["amount"])))
    if r >= 1:
        k = _kernel(r)
        a = cv2.dilate(a, k) if p["amount"] > 0 else cv2.erode(a, k)
    if p["feather"] > 0.05:
        a = _blur_a(a, p["feather"], ctx.get("draft"))
    lo, hi = p["blackClip"] / 100.0, p["whiteClip"] / 100.0
    if hi - lo > 1e-3 and (lo > 1e-4 or hi < 0.9999):
        a = np.clip((a - lo) / (hi - lo), 0, 1)
    return _pack(_rgb(rgba), a)


# ---------------------------------------------------------------------------
# Stylize
# ---------------------------------------------------------------------------

@effect("glow", "Glow", "Stylize",
        "Bloom off the bright parts. Light spreads past the layer's edge, so "
        "this GROWS alpha unless expandAlpha is off - that is what makes it "
        "read as light instead of as a painted halo.",
        {"threshold": num(60, 0, 100, "only pixels brighter than this glow", unit="%"),
         "radius": num(24, 1, 200, "how far the light carries, in pixels", unit="px"),
         "intensity": num(120, 0, 400, "brightness of the halo", unit="%"),
         "softness": num(15, 0, 100, "how gradually the threshold engages", unit="%"),
         "colorize": flag(False, "one colour for the whole glow instead of the source colours"),
         "glowColor": col([255, 220, 150], "the colour used when colorize is on"),
         "mode": pick(["add", "screen"], "add", "add blows out, screen stays inside white"),
         "expandAlpha": flag(True, "let the halo carry alpha past the layer edge")},
        touches_alpha=True)
def _glow(rgba, p, ctx):
    if p["intensity"] < 0.5:
        return rgba
    rgb = _rgb(rgba)
    a = _alpha(rgba)
    thr = p["threshold"] / 100.0
    soft = max(0.002, p["softness"] / 100.0)
    mask = _smoothstep(thr, thr + soft, _luma(rgb)) * a
    src = (_rgb01(p["glowColor"])[None, None, :] * mask[..., None] if p["colorize"]
           else rgb * mask[..., None])
    gain = p["intensity"] / 100.0
    halo = _blur2(src, p["radius"], p["radius"], cv2.BORDER_CONSTANT, ctx.get("draft")) * gain
    halo_a = _blur2(mask, p["radius"], p["radius"], cv2.BORDER_CONSTANT, ctx.get("draft")) * gain
    pm = rgb * a[..., None]
    if p["mode"] == "add":
        out_pm = pm + halo
    else:
        out_pm = 1.0 - (1.0 - np.clip(pm, 0, 1)) * (1.0 - np.clip(halo, 0, 1))
    out_a = np.clip(a + np.clip(halo_a, 0, 1) * (1 - a), 0, 1) if p["expandAlpha"] else a
    return _unpremul(out_pm, out_a)


@effect("dropShadow", "Drop Shadow", "Stylize",
        "The layer's own matte, offset, blurred and darkened behind it. Grows "
        "alpha, because a shadow that stops at the layer edge is not a shadow.",
        {"color": col([0, 0, 0], "shadow colour"),
         "opacity": num(55, 0, 100, "how dark the shadow lands", unit="%"),
         "distance": num(12, 0, 500, "how far it is thrown, in pixels", unit="px"),
         "angle": num(45, -360, 360, "degrees; 0 throws right, 90 throws straight down",
                      unit="deg"),
         "softness": num(10, 0, 200, "blur on the shadow, in pixels", unit="px"),
         "spread": num(0, 0, 50, "grow the matte before blurring, for a fatter shadow",
                       unit="px"),
         "shadowOnly": flag(False, "drop the layer and keep only its shadow")},
        touches_alpha=True)
def _drop_shadow(rgba, p, ctx):
    if p["opacity"] < 0.5:
        return rgba
    h, w = rgba.shape[:2]
    a = _alpha(rgba)
    sa = a
    if p["spread"] >= 1:
        sa = cv2.dilate(sa, _kernel(p["spread"]))
    th = math.radians(p["angle"])
    dx, dy = p["distance"] * math.cos(th), p["distance"] * math.sin(th)
    if abs(dx) > 0.01 or abs(dy) > 0.01:
        m = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
        sa = cv2.warpAffine(sa, m, (w, h), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    if p["softness"] > 0.05:
        sa = _blur_a(sa, p["softness"], ctx.get("draft"))
    sa = np.clip(sa, 0, 1) * (p["opacity"] / 100.0)
    shade = _rgb01(p["color"])[None, None, :]
    if p["shadowOnly"]:
        return _unpremul(shade * sa[..., None], sa)
    rgb = _rgb(rgba)
    out_a = np.clip(a + sa * (1 - a), 0, 1)
    out_pm = rgb * a[..., None] + shade * (sa * (1 - a))[..., None]
    return _unpremul(out_pm, out_a)


@effect("stroke", "Stroke", "Stylize",
        "An outline drawn from the layer's own matte. Outside and centre "
        "strokes paint where there was nothing, so they grow alpha; an inside "
        "stroke stays within the shape.",
        {"color": col([255, 255, 255], "line colour"),
         "width": num(4, 1, 100, "line thickness in pixels", unit="px"),
         "position": pick(["outside", "center", "inside"], "outside",
                          "which side of the matte edge the line sits on"),
         "opacity": num(100, 0, 100, "line opacity", unit="%"),
         "feather": num(0, 0, 50, "soften the line", unit="px")},
        touches_alpha=True)
def _stroke(rgba, p, ctx):
    a = _alpha(rgba)
    w = max(1, int(round(p["width"])))
    pos = p["position"]
    if pos == "outside":
        ring = np.clip(cv2.dilate(a, _kernel(w)) - a, 0, 1)
    elif pos == "inside":
        ring = np.clip(a - cv2.erode(a, _kernel(w)), 0, 1)
    else:
        half = max(1, w // 2)
        ring = np.clip(cv2.dilate(a, _kernel(half)) - cv2.erode(a, _kernel(half)), 0, 1)
    if p["feather"] > 0.05:
        ring = np.clip(_blur_a(ring, p["feather"], ctx.get("draft")), 0, 1)
    cov = ring * (p["opacity"] / 100.0)
    line = _rgb01(p["color"])[None, None, :]
    out_pm = _rgb(rgba) * a[..., None] * (1 - cov[..., None]) + line * cov[..., None]
    return _unpremul(out_pm, np.clip(a * (1 - cov) + cov, 0, 1))


@effect("posterize", "Posterize", "Stylize",
        "Quantise each channel to N steps. Levels, not bits - 4 means four "
        "values, the mistake the Images screen already paid for once.",
        {"levels": num(6, 2, 64, "distinct values per channel", integer=True),
         "amount": num(100, 0, 100, "blend against the smooth original", unit="%")})
def _posterize(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    n = int(p["levels"])
    rgb = _rgb(rgba)
    q = np.round(np.clip(rgb, 0, 1) * (n - 1)) / (n - 1)
    return _pack(rgb * (1 - w) + q * w, _alpha(rgba))


@effect("findEdges", "Find Edges", "Stylize",
        "Sobel gradient - where the picture changes. Inverted by default, "
        "because pencil lines on white is what people mean by find edges.",
        {"intensity": num(100, 0, 500, "gain on the gradient", unit="%"),
         "invert": flag(True, "dark lines on white instead of light lines on black"),
         "mono": flag(False, "one grey edge map instead of per-channel colour edges"),
         "amount": num(100, 0, 100, "blend against the original", unit="%")})
def _find_edges(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    rgb = _rgb(rgba)
    src = np.repeat(_luma(rgb)[..., None], 3, axis=-1) if p["mono"] else rgb
    gx = cv2.Sobel(src, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(src, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.clip(np.sqrt(gx * gx + gy * gy) * (p["intensity"] / 100.0), 0, 1)
    if p["invert"]:
        mag = 1.0 - mag
    return _pack(rgb * (1 - w) + mag * w, _alpha(rgba))


@effect("mosaic", "Mosaic", "Stylize",
        "Average the frame into blocks - the censor bar, or a deliberate "
        "low-res beat. Alpha blocks up with the colour, so a cutout's edge goes "
        "square too.",
        {"size": num(16, 2, 512, "block width in pixels", integer=True, unit="px"),
         "sizeY": num(0, 0, 512, "block height; 0 keeps the blocks square",
                      integer=True, unit="px")},
        touches_alpha=True)
def _mosaic(rgba, p, ctx):
    h, w = rgba.shape[:2]
    bx = max(1, int(p["size"]))
    by = max(1, int(p["sizeY"]) or bx)
    if bx <= 1 and by <= 1:
        return rgba
    sw, sh = max(1, int(math.ceil(w / bx))), max(1, int(math.ceil(h / by)))
    pm = _premul4(rgba)
    small = cv2.resize(pm, (sw, sh), interpolation=cv2.INTER_AREA)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    return _unpremul(big[..., :3], big[..., 3])


@effect("halftone", "Halftone", "Stylize",
        "A print screen: dots that grow as the picture darkens, on a rotated "
        "grid. The angle is what stops it looking like a bug.",
        {"size": num(8, 2, 64, "cell size in pixels - the dot pitch", unit="px"),
         "angle": num(45, -180, 180, "screen rotation in degrees", unit="deg"),
         "colored": flag(False, "keep the source colour in the dots"),
         "inkColor": col([15, 15, 20], "dot colour when colored is off"),
         "paperColor": col([245, 245, 240], "background between the dots"),
         "amount": num(100, 0, 100, "blend against the original", unit="%")})
def _halftone(rgba, p, ctx):
    w8 = p["amount"] / 100.0
    if w8 < 0.0005:
        return rgba
    h, w = rgba.shape[:2]
    rgb = _rgb(rgba)
    size = max(2.0, p["size"])
    th = math.radians(p["angle"])
    xx, yy = _grid(h, w)
    u = (xx * math.cos(th) + yy * math.sin(th)) / size
    v = (-xx * math.sin(th) + yy * math.cos(th)) / size
    du, dv = u - np.floor(u) - 0.5, v - np.floor(v) - 0.5
    d = np.sqrt(du * du + dv * dv) * 2.0
    lum = _luma(rgb)
    radius = np.sqrt(np.clip(1.0 - lum, 0, 1)) * 1.18
    aa = 2.0 / size                      # one screen pixel, in cell units
    ink = 1.0 - np.clip((d - (radius - aa)) / (2 * aa), 0, 1)
    ink = ink[..., None]
    ink_rgb = rgb if p["colored"] else _rgb01(p["inkColor"])[None, None, :]
    dots = _rgb01(p["paperColor"])[None, None, :] * (1 - ink) + ink_rgb * ink
    return _pack(rgb * (1 - w8) + dots * w8, _alpha(rgba))


@effect("noise", "Noise", "Stylize",
        "Grain. Seeded from the seed and the frame number, never the clock - "
        "re-render the comp and you get the same grain in the same places.",
        {"amount": num(12, 0, 100, "noise strength as a percent of full range", unit="%"),
         "type": pick(["gaussian", "uniform"], "gaussian", "the distribution sampled"),
         "mono": flag(True, "one value per pixel instead of per channel"),
         "seed": num(7, 0, 100000, "change it for a different grain", integer=True,
                     animatable=False),
         "animate": flag(True, "advance the grain every frame; off freezes one pattern"),
         "size": num(1, 1, 32, "grain scale in pixels; above 1 the noise is generated "
                               "small and scaled up", integer=True, unit="px")})
def _noise(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    frame = _frame(ctx) if p["animate"] else 0
    rng = np.random.default_rng((int(p["seed"]) & 0xFFFFFFF) * 1000003 + frame)
    step = max(1, int(p["size"]))
    gh, gw = max(1, h // step), max(1, w // step)
    ch = 1 if p["mono"] else 3
    if p["type"] == "gaussian":
        n = rng.normal(0.0, 1.0, (gh, gw, ch)).astype(np.float32)
    else:
        n = (rng.random((gh, gw, ch), dtype=np.float32) - 0.5) * 2.0
    if (gh, gw) != (h, w):
        n = cv2.resize(n, (w, h), interpolation=cv2.INTER_NEAREST)
        n = n.reshape(h, w, ch)
    return _pack(_rgb(rgba) + n * (p["amount"] / 100.0 * 0.35), _alpha(rgba))


@effect("scanlines", "Scanlines", "Stylize",
        "CRT lines. Roll makes them drift, which is the difference between a "
        "still texture and a monitor that is on.",
        {"spacing": num(4, 2, 200, "distance between line centres, in pixels",
                        unit="px"),
         "thickness": num(50, 1, 99, "percent of the spacing the dark band fills", unit="%"),
         "darkness": num(45, 0, 100, "how far the lines pull the picture down", unit="%"),
         "offset": num(0, -500, 500, "shift the pattern, in pixels", unit="px"),
         "rollSpeed": num(0, -200, 200, "pixels per second the pattern drifts", unit="px/s"),
         "softness": num(30, 0, 100, "soften the band edges", unit="%"),
         "vertical": flag(False, "run the lines vertically instead"),
         "affectAlpha": flag(False, "cut the lines out of the matte as well as darkening")},
        touches_alpha=True)
def _scanlines(rgba, p, ctx):
    if p["darkness"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    coord = xx if p["vertical"] else yy
    span = max(2.0, p["spacing"])
    shift = p["offset"] + p["rollSpeed"] * float(ctx.get("t") or 0.0)
    m = np.mod(coord + shift, span) / span
    dist = np.minimum(m, 1.0 - m)                # 0 on a line centre, 0.5 between lines
    half = p["thickness"] / 100.0 * 0.5
    soft = max(0.001, p["softness"] / 100.0 * 0.5)
    dark = (1.0 - _smoothstep(half, half + soft, dist)) * (p["darkness"] / 100.0)
    rgb = _rgb(rgba) * (1.0 - dark)[..., None]
    a = _alpha(rgba) * (1.0 - dark) if p["affectAlpha"] else _alpha(rgba)
    return _pack(rgb, a)


@effect("chromaticAberration", "Chromatic Aberration", "Stylize",
        "Split the channels the way a cheap lens does - red and blue pulled "
        "apart, green left alone. Radial grows toward the corners, which is "
        "what real glass does; linear is the glitch look.",
        {"amount": num(3, 0, 60, "channel separation in pixels at the frame edge",
                       unit="px"),
         "type": pick(["radial", "linear"], "radial", "spread from the centre, or one direction"),
         "angle": num(0, -360, 360, "direction for linear separation", unit="deg"),
         "centerX": num(50, -100, 200, "centre for radial, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre for radial, percent of height", unit="%")})
def _chromatic_aberration(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    out = pm.copy()
    if p["type"] == "radial":
        cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
        rmax = max(1.0, math.hypot(max(cx, w - cx), max(cy, h - cy)))
        for ch, sign in ((0, 1.0), (2, -1.0)):
            m = cv2.getRotationMatrix2D((cx, cy), 0.0, 1.0 + sign * p["amount"] / rmax)
            out[..., ch] = cv2.warpAffine(np.ascontiguousarray(pm[..., ch]), m, (w, h),
                                          flags=cv2.INTER_LINEAR,
                                          borderMode=cv2.BORDER_REPLICATE)
    else:
        th = math.radians(p["angle"])
        dx, dy = p["amount"] * math.cos(th), p["amount"] * math.sin(th)
        for ch, sign in ((0, 1.0), (2, -1.0)):
            m = np.array([[1, 0, sign * dx], [0, 1, sign * dy]], np.float32)
            out[..., ch] = cv2.warpAffine(np.ascontiguousarray(pm[..., ch]), m, (w, h),
                                          flags=cv2.INTER_LINEAR,
                                          borderMode=cv2.BORDER_REPLICATE)
    return _unpremul(out, a)


@effect("roughenEdges", "Roughen Edges", "Stylize",
        "Eat the matte's edge with fractal noise: torn paper, burnt film, "
        "corrosion, a title that was stencilled rather than typeset. Evolution "
        "makes the edge crawl, which is the difference between a texture and a "
        "thing that is decaying.",
        {"edgeType": pick(["roughen", "cut", "spiky", "roughenColor"], "roughen",
                          "roughen frays it, cut takes bites out, spiky grows "
                          "thorns, roughenColor paints the frayed band"),
         "border": num(12, 0, 200, "how far in from the edge the damage reaches, "
                                   "in pixels", unit="px"),
         "edgeSharpness": num(50, 1, 100, "1 is a soft dissolve, 100 is a clean tear", unit="%"),
         "fractalInfluence": num(70, 0, 200, "how hard the noise pushes the edge", unit="%"),
         "scale": num(60, 1, 800, "noise size; 100 is a blob about a quarter of the "
                                  "frame's long edge", unit="%"),
         "stretchWidth": num(100, 5, 1000, "stretch the noise horizontally", unit="%"),
         "complexity": num(3, 1, 8, "octaves of noise; each one is another pass",
                           integer=True, animatable=False),
         "offsetX": num(0, -8192, 8192, "slide the noise, in pixels", unit="px"),
         "offsetY": num(0, -8192, 8192, "slide the noise, in pixels", unit="px"),
         "evolution": num(0, -36000, 36000, "walk through the noise field, in degrees",
                          unit="deg"),
         "evolutionSpeed": num(0, -10, 10, "turns of evolution per second, for a crawl "
                                           "with no keyframes", unit="Hz"),
         "seed": num(2, 0, 100000, "a different edge from the same settings",
                     integer=True, animatable=False),
         "edgeColor": col([200, 90, 30], "colour painted into the frayed band when "
                                         "edgeType is roughenColor")},
        touches_alpha=True)
def _roughen_edges(rgba, p, ctx):
    if p["border"] < 0.5 or p["fractalInfluence"] < 0.5:
        return rgba
    h, w = rgba.shape[:2]
    a = _alpha(rgba)
    kind = p["edgeType"]
    ftype = "ridged" if kind == "spiky" else "turbulent"
    opts = _noise_params(p, ctx, complexity=int(p["complexity"]))
    opts["fractalType"] = ftype
    field = _fractal_field(h, w, **opts)
    # The band is a BLUR of the matte, not a distance transform: a blur's ramp
    # is exactly `border` wide, costs one pass, and already carries the shape's
    # curvature, so corners fray more than straights - which is what erosion
    # does in the world.
    band = np.clip(_blur_a(a, max(1.0, p["border"] * 0.5), ctx.get("draft")), 0, 1)
    push = (field - 0.5) * (p["fractalInfluence"] / 100.0)
    if kind == "cut":
        push = np.minimum(push, 0.0) * 2.0        # only ever takes away
    elif kind == "spiky":
        push = push * 1.5
    gain = 0.5 + max(0.01, p["edgeSharpness"] / 100.0) * 8.0
    out_a = np.clip(0.5 + (band + push - 0.5) * gain, 0, 1)
    if kind == "roughenColor":
        # paint what the noise CHANGED - the band it chewed away and the band it
        # grew - and leave the untouched interior alone
        cov = np.clip(np.abs(out_a - a) * 2.0, 0, 1) * out_a
        line = _rgb01(p["edgeColor"])[None, None, :]
        rgb = _rgb(rgba) * (1 - cov[..., None]) + line * cov[..., None]
        return _pack(rgb, out_a)
    return _pack(_rgb(rgba), out_a)


@effect("bevelAlpha", "Bevel Alpha", "Stylize",
        "Light the matte's own edge as if it were a chamfer: text and logos get "
        "thickness without a 3D renderer. Reads the gradient of a softened "
        "alpha, so it follows any shape, and it never moves the matte.",
        {"thickness": num(6, 1, 100, "width of the chamfer, in pixels", unit="px"),
         "lightAngle": num(-60, -360, 360, "where the light comes from, degrees; "
                                           "0 is from the right", unit="deg"),
         "intensity": num(70, 0, 300, "strength of the highlight and the shade", unit="%"),
         "lightColor": col([255, 250, 235], "colour of the lit face"),
         "shadowColor": col([0, 0, 0], "colour of the face turned away"),
         "shininess": num(0, 0, 100, "add a tight specular along the lit edge", unit="%")})
def _bevel_alpha(rgba, p, ctx):
    if p["intensity"] < 0.5:
        return rgba
    a = _alpha(rgba)
    soft = _blur_a(a, max(0.6, p["thickness"] * 0.5), ctx.get("draft"))
    gx = cv2.Sobel(soft, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(soft, cv2.CV_32F, 0, 1, ksize=3)
    th = math.radians(p["lightAngle"])
    # a chamfer's normal points OUT of the shape, and the alpha gradient points
    # IN, hence the minus - get this backwards and every bevel is lit from the
    # wrong side while looking perfectly plausible
    lam = -(gx * math.cos(th) + gy * math.sin(th)) * (4.0 / max(1.0, p["thickness"] * 0.5))
    lam = np.clip(lam, -1.0, 1.0) * (p["intensity"] / 100.0)
    lit = np.clip(lam, 0, 1)[..., None]
    dark = np.clip(-lam, 0, 1)[..., None]
    inside = np.clip(a, 0, 1)[..., None]
    rgb = _rgb(rgba)
    out = rgb + (_rgb01(p["lightColor"])[None, None, :] - rgb) * lit * inside
    out = out + (_rgb01(p["shadowColor"])[None, None, :] - out) * dark * inside
    if p["shininess"] > 0.5:
        spec = np.power(np.clip(lam, 0, 1), 3.0)[..., None] * (p["shininess"] / 100.0)
        out = out + spec * inside
    return _pack(out, a)


@effect("emboss", "Emboss", "Stylize",
        "Flatten the picture to grey relief lit from one side - the stamped "
        "metal, the pressed paper, the map. Cheap, and unlike Find Edges it "
        "keeps a sense of which way a surface faces.",
        {"direction": num(45, -360, 360, "where the light comes from, degrees", unit="deg"),
         "relief": num(2, 0.2, 50, "how far the two copies are offset, in pixels", unit="px"),
         "contrast": num(120, 0, 800, "gain on the difference", unit="%"),
         "amount": num(100, 0, 100, "blend against the original", unit="%")})
def _emboss(rgba, p, ctx):
    w8 = p["amount"] / 100.0
    if w8 < 0.0005 or p["contrast"] < 0.5:
        return rgba
    h, w = rgba.shape[:2]
    th = math.radians(p["direction"])
    dx, dy = p["relief"] * math.cos(th), p["relief"] * math.sin(th)
    rgb = _rgb(rgba)
    grey = _luma(rgb)
    m = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
    shifted = cv2.warpAffine(grey, m, (w, h), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_REPLICATE)
    relief = (grey - shifted) * (p["contrast"] / 100.0) + 0.5
    out = np.repeat(np.clip(relief, 0, 1)[..., None], 3, axis=-1)
    return _pack(rgb * (1 - w8) + out * w8, _alpha(rgba))


# ---------------------------------------------------------------------------
# Distort
# ---------------------------------------------------------------------------

@effect("transform", "Transform", "Distort",
        "A second free transform, inside the stack - so you can blur, THEN "
        "scale, which the layer's own transform can never do. Anchor and "
        "position are percentages so a preset survives a resize.",
        {"anchorX": num(50, -200, 300, "pivot, percent of layer width", unit="%"),
         "anchorY": num(50, -200, 300, "pivot, percent of layer height", unit="%"),
         "positionX": num(0, -4096, 4096, "move right, in pixels", unit="px"),
         "positionY": num(0, -4096, 4096, "move down, in pixels", unit="px"),
         "scaleX": num(100, -1000, 1000, "horizontal scale; negative mirrors", unit="%"),
         "scaleY": num(100, -1000, 1000, "vertical scale; negative flips", unit="%"),
         "rotation": num(0, -3600, 3600, "degrees, clockwise on screen", unit="deg"),
         "skew": num(0, -80, 80, "shear in degrees", unit="deg"),
         "opacity": num(100, 0, 100, "fade the transformed result", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "transparent", "what fills the area it leaves behind")},
        touches_alpha=True)
def _transform(rgba, p, ctx):
    h, w = rgba.shape[:2]
    ident = (abs(p["positionX"]) < 1e-3 and abs(p["positionY"]) < 1e-3
             and abs(p["scaleX"] - 100) < 1e-3 and abs(p["scaleY"] - 100) < 1e-3
             and abs(p["rotation"]) < 1e-3 and abs(p["skew"]) < 1e-3)
    if ident and p["opacity"] >= 99.995:
        return rgba
    ax, ay = p["anchorX"] / 100.0 * w, p["anchorY"] / 100.0 * h
    th = math.radians(p["rotation"])
    rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]], np.float32)
    shear = np.array([[1.0, math.tan(math.radians(p["skew"]))], [0.0, 1.0]], np.float32)
    scale = np.array([[p["scaleX"] / 100.0, 0.0], [0.0, p["scaleY"] / 100.0]], np.float32)
    a2 = rot @ shear @ scale
    tx = ax + p["positionX"] - (a2[0, 0] * ax + a2[0, 1] * ay)
    ty = ay + p["positionY"] - (a2[1, 0] * ax + a2[1, 1] * ay)
    if ident:
        return _fade(rgba, p["opacity"])     # nothing moved; do not resample for nothing
    # An affine is invertible, so build the source map and go through the one
    # resampler - that keeps wrap and mirror edges honest, which warpAffine's
    # border flags cannot express for a wrap.
    m = np.array([[a2[0, 0], a2[0, 1], tx], [a2[1, 0], a2[1, 1], ty]], np.float32)
    inv = cv2.invertAffineTransform(m)
    xx, yy = _grid(h, w)
    mapx = inv[0, 0] * xx + inv[0, 1] * yy + inv[0, 2]
    mapy = inv[1, 0] * xx + inv[1, 1] * yy + inv[1, 2]
    return _fade(_remap(rgba, mapx, mapy, p["edgeBehavior"], ctx.get("draft")), p["opacity"])


def _fade(rgba, opacity):
    if opacity >= 99.995:
        return rgba
    out = rgba.copy()
    out[..., 3] *= opacity / 100.0
    return out


@effect("cornerPin", "Corner Pin", "Distort",
        "Drag the four corners anywhere - the screen replacement, the wall "
        "poster, the fake monitor. Corners are percentages of the layer, so "
        "0/0/100/100 is untouched at any resolution.",
        {"topLeftX": num(0, -300, 400, "top-left corner, percent of width", unit="%"),
         "topLeftY": num(0, -300, 400, "top-left corner, percent of height", unit="%"),
         "topRightX": num(100, -300, 400, "top-right corner, percent of width", unit="%"),
         "topRightY": num(0, -300, 400, "top-right corner, percent of height", unit="%"),
         "bottomRightX": num(100, -300, 400, "bottom-right corner, percent of width", unit="%"),
         "bottomRightY": num(100, -300, 400, "bottom-right corner, percent of height", unit="%"),
         "bottomLeftX": num(0, -300, 400, "bottom-left corner, percent of width", unit="%"),
         "bottomLeftY": num(100, -300, 400, "bottom-left corner, percent of height", unit="%"),
         "edgeBehavior": pick(["transparent", "clamp"], "transparent",
                              "what fills outside the pinned quad")},
        touches_alpha=True)
def _corner_pin(rgba, p, ctx):
    h, w = rgba.shape[:2]
    dst = np.array([[p["topLeftX"], p["topLeftY"]], [p["topRightX"], p["topRightY"]],
                    [p["bottomRightX"], p["bottomRightY"]],
                    [p["bottomLeftX"], p["bottomLeftY"]]], np.float32)
    if np.allclose(dst, [[0, 0], [100, 0], [100, 100], [0, 100]]):
        return rgba
    dst = dst / 100.0 * np.array([w, h], np.float32)
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(_premul4(rgba), m, (w, h), flags=cv2.INTER_LINEAR,
                                 borderMode=_border_of(p["edgeBehavior"]),
                                 borderValue=(0, 0, 0, 0))
    return _unpremul(warped[..., :3], warped[..., 3])


@effect("wave", "Wave", "Distort",
        "Push pixels along a sine. Speed makes it a flag, water or a bad "
        "signal without a single keyframe.",
        {"direction": pick(["horizontal", "vertical", "both"], "horizontal",
                           "which axis the pixels move along"),
         "amplitude": num(12, 0, 500, "how far pixels travel, in pixels", unit="px"),
         "wavelength": num(60, 2, 2000, "distance between crests, in pixels", unit="px"),
         "phase": num(0, -3600, 3600, "starting offset in degrees", unit="deg"),
         "speed": num(0, -20, 20, "cycles per second; 0 holds still", unit="Hz"),
         "waveType": pick(["sine", "triangle", "square"], "sine", "the shape of the wave"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from off-frame")},
        touches_alpha=True)
def _wave(rgba, p, ctx):
    if p["amplitude"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    phase = math.radians(p["phase"]) + 2 * math.pi * p["speed"] * float(ctx.get("t") or 0.0)

    def shape(coord):
        u = 2 * math.pi * coord / max(2.0, p["wavelength"]) + phase
        if p["waveType"] == "sine":
            return np.sin(u)
        frac = np.mod(u / (2 * math.pi), 1.0)
        if p["waveType"] == "square":
            return np.where(frac < 0.5, 1.0, -1.0).astype(np.float32)
        return (4.0 * np.abs(frac - 0.5) - 1.0).astype(np.float32)

    amp = p["amplitude"]
    mapx, mapy = xx, yy
    if p["direction"] in ("horizontal", "both"):
        mapx = xx + shape(yy) * amp
    if p["direction"] in ("vertical", "both"):
        mapy = yy + shape(xx) * amp
    return _remap(rgba, mapx, mapy, p["edgeBehavior"], ctx.get("draft"))


@effect("ripple", "Ripple", "Distort",
        "Rings spreading from a point. Decay is what keeps it from looking like "
        "a test pattern - real water runs out of energy.",
        {"centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "amplitude": num(10, 0, 300, "displacement at the centre, in pixels", unit="px"),
         "wavelength": num(40, 2, 1000, "distance between rings, in pixels", unit="px"),
         "phase": num(0, -3600, 3600, "starting offset in degrees", unit="deg"),
         "speed": num(1, -20, 20, "rings per second travelling outward", unit="Hz"),
         "decay": num(60, 0, 100, "how fast the rings die with distance", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from off-frame")},
        touches_alpha=True)
def _ripple(rgba, p, ctx):
    if p["amplitude"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    xx, yy = _grid(h, w)
    dx, dy = xx - cx, yy - cy
    r = np.sqrt(dx * dx + dy * dy)
    rmax = max(1.0, math.hypot(w, h) * 0.5)
    phase = math.radians(p["phase"]) + 2 * math.pi * p["speed"] * float(ctx.get("t") or 0.0)
    fall = np.exp(-(p["decay"] / 100.0) * 3.0 * (r / rmax))
    disp = p["amplitude"] * np.sin(2 * math.pi * r / max(2.0, p["wavelength"]) - phase) * fall
    inv = 1.0 / np.maximum(r, 1e-3)
    return _remap(rgba, xx + disp * dx * inv, yy + disp * dy * inv,
                  p["edgeBehavior"], ctx.get("draft"))


@effect("bulge", "Bulge", "Distort",
        "A lens pressed against the frame. Positive swells, negative pinches, "
        "and the falloff is smooth at the rim so the edge of the effect does "
        "not become a visible circle.",
        {"centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "radius": num(35, 1, 200, "size of the lens, percent of the smaller side", unit="%"),
         "strength": num(50, -100, 100, "positive bulges out, negative pinches in", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from off-frame")},
        touches_alpha=True)
def _bulge(rgba, p, ctx):
    if abs(p["strength"]) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    rad = max(1.0, p["radius"] / 100.0 * min(w, h))
    xx, yy = _grid(h, w)
    dx, dy = xx - cx, yy - cy
    rn = np.clip(np.sqrt(dx * dx + dy * dy) / rad, 0, 1)
    f = 1.0 + (p["strength"] / 100.0) * (1.0 - rn * rn) ** 2
    inv = 1.0 / np.maximum(f, 1e-3)
    return _remap(rgba, cx + dx * inv, cy + dy * inv, p["edgeBehavior"], ctx.get("draft"))


@effect("lensDistortion", "Lens Distortion", "Distort",
        "Barrel and pincushion, the Brown model. Positive is barrel - the "
        "fisheye. Zoom is there because undistorting always exposes the corners.",
        {"amount": num(0, -100, 100, "positive barrels outward, negative pincushions", unit="%"),
         "secondary": num(0, -100, 100, "fourth-order term; bends the corners "
                                        "without touching the middle", unit="%"),
         "zoom": num(100, 25, 400, "scale applied after, to hide exposed corners", unit="%"),
         "centerX": num(50, -100, 200, "optical centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "optical centre, percent of height", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "transparent", "what fills the corners")},
        touches_alpha=True)
def _lens_distortion(rgba, p, ctx):
    if abs(p["amount"]) < 0.05 and abs(p["secondary"]) < 0.05 and abs(p["zoom"] - 100) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    rmax = max(1.0, math.hypot(w, h) * 0.5)
    xx, yy = _grid(h, w)
    dx, dy = (xx - cx) / rmax, (yy - cy) / rmax
    r2 = dx * dx + dy * dy
    k1, k2 = -p["amount"] / 100.0 * 0.5, -p["secondary"] / 100.0 * 0.25
    f = (1.0 + k1 * r2 + k2 * r2 * r2) / max(0.01, p["zoom"] / 100.0)
    return _remap(rgba, cx + dx * f * rmax, cy + dy * f * rmax,
                  p["edgeBehavior"], ctx.get("draft"))


@effect("mirror", "Mirror", "Distort",
        "Fold the frame across a line. Two of these at right angles is a "
        "kaleidoscope, and one is how a half-built set becomes a whole one.",
        {"centerX": num(50, -100, 200, "a point on the mirror line, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "a point on the mirror line, percent of height", unit="%"),
         "angle": num(90, -360, 360, "direction of the mirror line in degrees", unit="deg"),
         "flip": flag(False, "keep the other half instead")},
        touches_alpha=True)
def _mirror(rgba, p, ctx):
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    th = math.radians(p["angle"])
    nx, ny = -math.sin(th), math.cos(th)         # normal to the mirror line
    xx, yy = _grid(h, w)
    s = (xx - cx) * nx + (yy - cy) * ny
    keep = s < 0 if p["flip"] else s > 0
    k = np.where(keep, 2.0 * s, 0.0).astype(np.float32)
    return _remap(rgba, xx - k * nx, yy - k * ny, "clamp", ctx.get("draft"))


@effect("polarCoords", "Polar Coordinates", "Distort",
        "Wrap the frame around a circle, or unroll a circle into a strip. A "
        "straight line of text becomes a ring; a lens flare becomes a wall.",
        {"type": pick(["rectToPolar", "polarToRect"], "rectToPolar",
                      "wrap a strip into a disc, or unroll a disc into a strip"),
         "amount": num(100, 0, 100, "blend between untouched and fully wrapped", unit="%"),
         "centerX": num(50, -100, 200, "centre of the disc, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre of the disc, percent of height", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "transparent", "what fills outside the disc")},
        touches_alpha=True)
def _polar_coords(rgba, p, ctx):
    amt = p["amount"] / 100.0
    if amt < 0.0005:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    rmax = max(1.0, math.hypot(max(cx, w - cx), max(cy, h - cy)))
    xx, yy = _grid(h, w)
    if p["type"] == "rectToPolar":
        ang = np.mod(np.arctan2(yy - cy, xx - cx) + math.pi * 2.5, math.pi * 2)
        rad = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        mapx = ang / (2 * math.pi) * w
        mapy = rad / rmax * h
    else:
        ang = xx / max(1.0, w) * 2 * math.pi - math.pi * 0.5
        rad = yy / max(1.0, h) * rmax
        mapx = cx + np.cos(ang) * rad
        mapy = cy + np.sin(ang) * rad
    return _remap(rgba, xx + (mapx - xx) * amt, yy + (mapy - yy) * amt,
                  p["edgeBehavior"], ctx.get("draft"))


@effect("turbulentDisplace", "Turbulent Displace", "Distort",
        "Push the picture around with fractal noise. Heat haze, flag ripple, "
        "flame, ink in water, a logo dissolving into smoke - all of them are "
        "this with different numbers. Evolution boils the field instead of "
        "sliding it, which is the difference between fire and a moving texture. "
        "It builds a noise field per axis and then resamples the frame: "
        "measured at 1080p, about 305ms a frame at the default complexity of "
        "three, 405ms at five, 585ms at eight.",
        {"displacement": pick(["turbulent", "smooth", "horizontal", "vertical",
                               "cross", "bulge", "twist"], "turbulent",
                              "turbulent folds the noise for wisps, smooth leaves "
                              "it rolling; bulge pushes out from the centre and "
                              "twist pushes around it"),
         "amount": num(30, -1000, 1000, "how far a pixel can travel, in pixels", unit="px"),
         "scale": num(100, 1, 800, "noise size; 100 is a blob about a quarter of the "
                                   "frame's long edge (AE calls this Size)", unit="%"),
         "stretchWidth": num(100, 5, 1000, "stretch the noise horizontally", unit="%"),
         "stretchHeight": num(100, 5, 1000, "stretch the noise vertically", unit="%"),
         "complexity": num(3, 1, 8, "octaves of noise; each one is another pass",
                           integer=True, animatable=False),
         "subInfluence": num(70, 0, 100, "how much each finer octave contributes", unit="%"),
         "offsetX": num(0, -8192, 8192, "slide the noise, in pixels", unit="px"),
         "offsetY": num(0, -8192, 8192, "slide the noise, in pixels", unit="px"),
         "evolution": num(0, -36000, 36000, "walk through the noise field, in degrees",
                          unit="deg"),
         "evolutionSpeed": num(0, -10, 10, "turns of evolution per second, so it boils "
                                           "without a single keyframe", unit="Hz"),
         "seed": num(1, 0, 100000, "a different field from the same settings",
                     integer=True, animatable=False),
         "pinning": flag(False, "hold the frame edges still, so the displacement "
                                "cannot drag transparency in from off-frame"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from "
                                                  "off-frame")},
        touches_alpha=True, expensive=True)
def _turbulent_displace(rgba, p, ctx):
    amt = p["amount"]
    if abs(amt) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    kind = p["displacement"]
    opts = _noise_params(p, ctx, complexity=int(p["complexity"]))
    opts["fractalType"] = "basic" if kind == "smooth" else "turbulent"
    fa = (_fractal_field(h, w, **opts) - 0.5) * 2.0
    xx, yy = _grid(h, w)
    if kind in ("bulge", "twist"):
        cx, cy = w * 0.5, h * 0.5
        dx, dy = xx - cx, yy - cy
        inv = 1.0 / np.maximum(np.sqrt(dx * dx + dy * dy), 1e-3)
        ux, uy = (dx * inv, dy * inv) if kind == "bulge" else (-dy * inv, dx * inv)
        offx, offy = fa * amt * ux, fa * amt * uy
    elif kind == "horizontal":
        offx, offy = fa * amt, None
    elif kind == "vertical":
        offx, offy = None, fa * amt
    elif kind == "cross":
        offx = offy = fa * amt                # one field on both axes: it shears
    else:
        opts["channel"] = 1                   # a second, decorrelated field for y
        offx, offy = fa * amt, (_fractal_field(h, w, **opts) - 0.5) * 2.0 * amt
    if p["pinning"]:
        reach = max(1.0, abs(amt))
        px = np.minimum(np.arange(w, dtype=np.float32), w - 1 - np.arange(w, dtype=np.float32))
        py = np.minimum(np.arange(h, dtype=np.float32), h - 1 - np.arange(h, dtype=np.float32))
        pin = np.minimum(px[None, :], py[:, None]) / reach
        pin = np.clip(pin, 0, 1)
        pin = (pin * pin * (3.0 - 2.0 * pin)).astype(np.float32)
        if offx is not None:
            offx = offx * pin
        if offy is not None:
            offy = offy * pin
    mapx = xx if offx is None else xx + offx
    mapy = yy if offy is None else yy + offy
    return _remap(rgba, mapx, mapy, p["edgeBehavior"], ctx.get("draft"))


@effect("displacementMap", "Displacement Map", "Distort",
        "Move every pixel by what a CHANNEL says: mid grey stays put, black "
        "pulls one way, white the other. The glitch, the water refraction, the "
        "heat haze, the chromatic smear. Name a `mapLayer` and it reads that "
        "layer, the way AE does - a ramp, a noise plate, a render of anything "
        "at all, and the two axes read different channels of it with their own "
        "amounts, so one map can drive both. Leave it empty and it reads THIS "
        "layer, which is the self-displace people use for glitch work. A map "
        "carrying its own field instead is Turbulent Displace. Measured at "
        "1080p: 140ms, and 155ms when a map layer has to be fitted.",
        {"mapLayer": lay("layer whose channels drive the movement; empty reads "
                         "this layer's own"),
         "mapFit": mapfit("map"),
         "horizontalChannel": pick(["red", "green", "blue", "alpha", "luminance", "off"],
                                   "red", "channel that decides sideways movement"),
         "verticalChannel": pick(["red", "green", "blue", "alpha", "luminance", "off"],
                                 "green", "channel that decides vertical movement"),
         "maxHorizontal": num(20, -500, 500, "travel at full channel value, in pixels. "
                                             "0.5 in the channel is no movement", unit="px"),
         "maxVertical": num(20, -500, 500, "travel at full channel value, in pixels", unit="px"),
         "blurMap": num(0, 0, 100, "soften the map first; a noisy map tears the "
                                   "picture into confetti", unit="px"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from "
                                                  "off-frame")},
        touches_alpha=True)
def _displacement_map(rgba, p, ctx):
    if ((p["horizontalChannel"] == "off" or abs(p["maxHorizontal"]) < 0.05)
            and (p["verticalChannel"] == "off" or abs(p["maxVertical"]) < 0.05)):
        return rgba
    h, w = rgba.shape[:2]
    src, other = _map_source(ctx, p, "mapLayer", rgba, "displacementMap")

    def chan(name):
        if name == "off":
            return None
        # Fit BEFORE the blur. blurMap is in pixels OF THE FRAME BEING MOVED,
        # so softening a 500px map and then stretching it to 1920 would be a
        # four times wider blur than the number on the slider claims.
        v = _fit_map(_map_channel(src, name), h, w, p["mapFit"])
        if p["blurMap"] > 0.05:
            v = _blur2(np.ascontiguousarray(v), p["blurMap"], p["blurMap"],
                       cv2.BORDER_REPLICATE, ctx.get("draft"))
        return (np.clip(v, 0, 1) - 0.5) * 2.0

    xx, yy = _grid(h, w)
    cx, cy = chan(p["horizontalChannel"]), chan(p["verticalChannel"])
    mapx = xx if cx is None else xx + cx * p["maxHorizontal"]
    mapy = yy if cy is None else yy + cy * p["maxVertical"]
    if other:
        # apply() guarantees THIS layer's pixels are finite; a map that came in
        # from the engine has not been through that gate, and a non-finite
        # SOURCE COORDINATE is a whole resampled neighbourhood of undefined
        # rather than one bad pixel. A broken map pixel stays where it was.
        if cx is not None:
            mapx = np.where(np.isfinite(mapx), mapx, xx)
        if cy is not None:
            mapy = np.where(np.isfinite(mapy), mapy, yy)
    return _remap(rgba, mapx, mapy, p["edgeBehavior"], ctx.get("draft"))


@effect("motionTile", "Motion Tile", "Distort",
        "Repeat the layer across the frame. The infinite background, the "
        "seamless scroll, the wall of the same thing - and mirrored edges make "
        "any plate tile without a visible join. Phase offsets alternate rows, "
        "which is what stops a tile reading as a grid.",
        {"tileWidth": num(100, 5, 500, "width of one tile, percent of the frame", unit="%"),
         "tileHeight": num(100, 5, 500, "height of one tile, percent of the frame", unit="%"),
         "centerX": num(50, -200, 300, "where the source frame's centre lands, "
                                       "percent of width", unit="%"),
         "centerY": num(50, -200, 300, "where the source frame's centre lands, "
                                       "percent of height", unit="%"),
         "phase": num(0, -3600, 3600, "offset every other row (or column) by this "
                                      "much of a tile; 180 is a brick bond", unit="deg"),
         "horizontalPhaseShift": flag(False, "shift columns instead of rows"),
         "mirrorEdges": flag(False, "flip alternate tiles so the seams vanish")},
        touches_alpha=True)
def _motion_tile(rgba, p, ctx):
    h, w = rgba.shape[:2]
    tw = max(1.0, p["tileWidth"] / 100.0 * w)
    th = max(1.0, p["tileHeight"] / 100.0 * h)
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    xx, yy = _grid(h, w)
    u = (xx - cx) / tw + 0.5
    v = (yy - cy) / th + 0.5
    ph = p["phase"] / 360.0
    if abs(ph) > 1e-6:
        if p["horizontalPhaseShift"]:
            u = u + np.floor(v) * ph
        else:
            v = v + np.floor(u) * ph
    iu, iv = np.floor(u), np.floor(v)
    fu, fv = u - iu, v - iv
    if p["mirrorEdges"]:
        fu = np.where(np.mod(iu, 2) != 0, 1.0 - fu, fu)
        fv = np.where(np.mod(iv, 2) != 0, 1.0 - fv, fv)
    # the tile is the WHOLE frame squeezed into tw x th, which is what makes
    # tileWidth 50% show the layer twice rather than showing half of it twice.
    # Scaling by w (not w-1) is what keeps the default settings an exact
    # identity - map a tile onto w-1 and every untiled comp is quietly resized.
    return _remap(rgba, fu * w, fv * h, "clamp", ctx.get("draft"))


@effect("offset", "Offset", "Distort",
        "Slide the layer and wrap what falls off the edge back on the other "
        "side. Two lines of maths, and the only way to scroll a seamless "
        "texture forever without a second copy of it.",
        {"shiftX": num(0, -8192, 8192, "pixels right; what leaves comes back left",
                       unit="px"),
         "shiftY": num(0, -8192, 8192, "pixels down", unit="px"),
         "speedX": num(0, -4000, 4000, "pixels per second, for a scroll with no "
                                       "keyframes", unit="px/s"),
         "speedY": num(0, -4000, 4000, "pixels per second", unit="px/s")},
        touches_alpha=True)
def _offset(rgba, p, ctx):
    t = float(ctx.get("t") or 0.0)
    dx = p["shiftX"] + p["speedX"] * t
    dy = p["shiftY"] + p["speedY"] * t
    if abs(dx) < 1e-4 and abs(dy) < 1e-4:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    return _remap(rgba, xx - dx, yy - dy, "wrap", ctx.get("draft"))


@effect("twirl", "Twirl", "Distort",
        "Rotate the middle and leave the rim where it is. A whirlpool, a "
        "portal, or the transition that eats a title. Falloff is squared at the "
        "rim so the edge of the effect is not a visible circle.",
        {"angle": num(90, -3600, 3600, "how far the centre is turned, degrees "
                                       "clockwise", unit="deg"),
         "radius": num(40, 1, 200, "size of the whirl, percent of the smaller side",
                       unit="%"),
         "centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "edgeBehavior": pick(EDGE_MODES, "clamp", "what feeds pixels pulled in from "
                                                  "off-frame")},
        touches_alpha=True)
def _twirl(rgba, p, ctx):
    if abs(p["angle"]) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    rad = max(1.0, p["radius"] / 100.0 * min(w, h))
    xx, yy = _grid(h, w)
    dx, dy = xx - cx, yy - cy
    rn = np.clip(np.sqrt(dx * dx + dy * dy) / rad, 0, 1)
    fall = (1.0 - rn) ** 2
    th = math.radians(-p["angle"]) * fall     # inverse map: sample where it came FROM
    c, s = np.cos(th), np.sin(th)
    return _remap(rgba, cx + dx * c - dy * s, cy + dx * s + dy * c,
                  p["edgeBehavior"], ctx.get("draft"))


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------

@effect("fill", "Fill", "Generate",
        "Flood a colour. The default mode is stencil - paint inside the matte "
        "that is already there, which is how you recolour a logo without "
        "touching its edges.",
        {"color": col([255, 60, 90], "the colour poured in"),
         "opacity": num(100, 0, 100, "how much of it lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "stencil", "how the fill meets the layer under it")},
        touches_alpha=True)
def _fill(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, _rgb01(p["color"]), cov, p["mode"])


@effect("ramp", "Ramp", "Generate",
        "A gradient between two points. Half the grades in the world are a "
        "ramp on multiply; scatter breaks the banding that a smooth 8-bit "
        "gradient always shows on a projector.",
        {"type": pick(["linear", "radial"], "linear", "straight run, or out from a centre"),
         "startX": num(0, -100, 200, "start point, percent of width", unit="%"),
         "startY": num(0, -100, 200, "start point, percent of height", unit="%"),
         "endX": num(100, -100, 200, "end point, percent of width", unit="%"),
         "endY": num(100, -100, 200, "end point, percent of height", unit="%"),
         "startColor": col([255, 255, 255], "colour at the start point"),
         "endColor": col([0, 0, 0], "colour at the end point"),
         "scatter": num(0, 0, 100, "seeded dither, to kill banding", unit="%"),
         "seed": num(3, 0, 100000, "dither seed", integer=True, animatable=False),
         "opacity": num(100, 0, 100, "how much of the ramp lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how the ramp meets the layer under it")},
        touches_alpha=True)
def _ramp(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    x0, y0 = p["startX"] / 100.0 * w, p["startY"] / 100.0 * h
    x1, y1 = p["endX"] / 100.0 * w, p["endY"] / 100.0 * h
    xx, yy = _grid(h, w)
    if p["type"] == "radial":
        span = max(1e-3, math.hypot(x1 - x0, y1 - y0))
        t = np.sqrt((xx - x0) ** 2 + (yy - y0) ** 2) / span
    else:
        vx, vy = x1 - x0, y1 - y0
        span = max(1e-6, vx * vx + vy * vy)
        t = ((xx - x0) * vx + (yy - y0) * vy) / span
    if p["scatter"] > 0.05:
        rng = np.random.default_rng(int(p["seed"]) & 0xFFFFFFF)
        t = t + (rng.random((h, w), dtype=np.float32) - 0.5) * (p["scatter"] / 100.0 * 0.15)
    t = np.clip(t, 0, 1)[..., None]
    grad = _rgb01(p["startColor"]) * (1 - t) + _rgb01(p["endColor"]) * t
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, grad.astype(np.float32), cov, p["mode"])


@effect("checkerboard", "Checkerboard", "Generate",
        "Squares. A transparency backdrop, an alignment grid, or a floor to "
        "corner-pin into perspective.",
        {"size": num(32, 2, 1024, "square size in pixels", unit="px"),
         "colorA": col([40, 40, 46], "one square"),
         "colorB": col([70, 70, 78], "the other square"),
         "offsetX": num(0, -4096, 4096, "shift the pattern, in pixels", unit="px"),
         "offsetY": num(0, -4096, 4096, "shift the pattern, in pixels", unit="px"),
         "opacity": num(100, 0, 100, "how much of it lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how it meets the layer under it")},
        touches_alpha=True)
def _checkerboard(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    size = max(2.0, p["size"])
    cell = (np.floor((xx - p["offsetX"]) / size) + np.floor((yy - p["offsetY"]) / size)) % 2
    pat = (_rgb01(p["colorA"])[None, None, :] * (1 - cell[..., None])
           + _rgb01(p["colorB"])[None, None, :] * cell[..., None])
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, pat.astype(np.float32), cov, p["mode"])


@effect("vignette", "Vignette", "Generate",
        "Darken toward the corners so the eye stays in the middle. Multiplies "
        "colour only - a vignette that ate the matte would be a mask, not a "
        "vignette.",
        {"amount": num(40, -100, 100, "positive darkens the corners, negative lifts them",
                       unit="%"),
         "size": num(70, 5, 200, "where the falloff starts, percent of the frame radius",
                     unit="%"),
         "softness": num(50, 1, 100, "how gradual the falloff is", unit="%"),
         "roundness": num(50, 0, 100, "0 follows the frame shape, 100 is a circle", unit="%"),
         "centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "color": col([0, 0, 0], "what the corners are pulled toward")})
def _vignette(rgba, p, ctx):
    if abs(p["amount"]) < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    xx, yy = _grid(h, w)
    rr = p["roundness"] / 100.0
    sx = max(1.0, w * 0.5 * (1 - rr) + min(w, h) * 0.5 * rr)
    sy = max(1.0, h * 0.5 * (1 - rr) + min(w, h) * 0.5 * rr)
    d = np.sqrt(((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2)
    start = p["size"] / 100.0
    soft = max(0.02, p["softness"] / 100.0)
    k = (_smoothstep(start, start + soft, d) * (abs(p["amount"]) / 100.0))[..., None]
    rgb = _rgb(rgba)
    # positive pulls the corners toward the vignette colour; negative lifts them
    # toward white, which is the "the corners are too dark" fix nobody names
    out = rgb * (1 - k) + _rgb01(p["color"])[None, None, :] * k if p["amount"] > 0 \
        else rgb + (1.0 - rgb) * k
    return _pack(out, _alpha(rgba))


@effect("lensFlare", "Lens Flare", "Generate",
        "A procedural flare: core, halo, starburst and a line of ghosts down "
        "the optical axis. Additive light, so it carries its own alpha and can "
        "sit on an empty layer.",
        {"centerX": num(30, -100, 200, "flare position, percent of width", unit="%"),
         "centerY": num(30, -100, 200, "flare position, percent of height", unit="%"),
         "brightness": num(100, 0, 400, "overall intensity", unit="%"),
         "size": num(25, 1, 200, "core size, percent of the smaller side", unit="%"),
         "color": col([255, 235, 190], "colour of the core and streaks"),
         "streaks": num(6, 0, 24, "number of starburst spikes", integer=True),
         "streakLength": num(60, 0, 200, "how far the spikes run", unit="%"),
         "ghosts": num(4, 0, 12, "reflections down the optical axis; each one is "
                                 "another full-frame pass", integer=True),
         "ghostColor": col([120, 190, 255], "tint of the ghosts")},
        touches_alpha=True)
def _lens_flare(rgba, p, ctx):
    if p["brightness"] < 0.5:
        return rgba
    h, w = rgba.shape[:2]
    # A flare is nothing but smooth falloffs, so a draft builds it at half
    # resolution and scales up - indistinguishable, and four times cheaper on
    # the pass that has twelve ghosts in it.
    step = 2.0 if ctx.get("draft") else 1.0
    gh, gw = max(8, int(h / step)), max(8, int(w / step))
    sx, sy = gw / float(w), gh / float(h)
    cx, cy = p["centerX"] / 100.0 * w * sx, p["centerY"] / 100.0 * h * sy
    size = max(2.0, p["size"] / 100.0 * min(gw, gh))
    xx, yy = _grid(gh, gw)
    dx, dy = xx - cx, yy - cy
    r = np.sqrt(dx * dx + dy * dy)

    core = np.exp(-(r / (size * 0.28)) ** 2)
    halo = np.exp(-((r - size * 0.75) / (size * 0.30)) ** 2) * 0.35
    light = core + halo
    n = int(p["streaks"])
    if n > 0 and p["streakLength"] > 0.5:
        ang = np.arctan2(dy, dx)
        spike = np.abs(np.cos(ang * (n / 2.0))) ** 24
        light = light + spike * np.exp(-r / (size * p["streakLength"] / 100.0 * 2.0)) * 0.6
    tint = _rgb01(p["color"])[None, None, :]
    add = light[..., None] * tint

    ghosts = int(p["ghosts"])
    if ghosts > 0:
        gtint = _rgb01(p["ghostColor"])[None, None, :]
        fcx, fcy = gw * 0.5, gh * 0.5
        for i in range(1, ghosts + 1):
            k = (i / (ghosts + 1.0)) * 2.4 - 0.4
            gx, gy = cx + (fcx - cx) * k * 2.0, cy + (fcy - cy) * k * 2.0
            gr = np.sqrt((xx - gx) ** 2 + (yy - gy) ** 2)
            rad = size * (0.10 + 0.05 * (i % 3))
            ring = np.exp(-((gr - rad) / (rad * 0.55)) ** 2) * (0.16 / (1 + i * 0.35))
            add = add + ring[..., None] * gtint
    add = (add * (p["brightness"] / 100.0)).astype(np.float32)
    if (gh, gw) != (h, w):
        add = cv2.resize(add, (w, h), interpolation=cv2.INTER_LINEAR)

    a = _alpha(rgba)
    lit = np.clip(add.max(axis=-1), 0, 1)
    out_a = np.clip(a + lit * (1 - a), 0, 1)
    return _unpremul(_rgb(rgba) * a[..., None] + add, out_a)


@effect("gridLines", "Grid Lines", "Generate",
        "A ruled grid. Layout guides, a HUD, or graph paper to warp - and the "
        "lines are drawn by distance, so they stay one pixel wide instead of "
        "aliasing into dashes.",
        {"spacing": num(64, 2, 1024, "distance between lines, in pixels", unit="px"),
         "lineWidth": num(2, 1, 64, "line thickness in pixels", unit="px"),
         "color": col([200, 210, 230], "line colour"),
         "axis": pick(["both", "horizontal", "vertical"], "both", "which lines are drawn"),
         "offsetX": num(0, -4096, 4096, "shift the grid, in pixels", unit="px"),
         "offsetY": num(0, -4096, 4096, "shift the grid, in pixels", unit="px"),
         "opacity": num(100, 0, 100, "line opacity", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how the grid meets the layer under it")},
        touches_alpha=True)
def _grid_lines(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    span = max(2.0, p["spacing"])
    half = p["lineWidth"] / 2.0

    def band(coord, off):
        m = np.mod(coord - off, span)
        return np.clip(half + 0.5 - np.minimum(m, span - m), 0, 1)

    cov = np.zeros((h, w), np.float32)
    if p["axis"] in ("both", "vertical"):
        cov = np.maximum(cov, band(xx, p["offsetX"]))
    if p["axis"] in ("both", "horizontal"):
        cov = np.maximum(cov, band(yy, p["offsetY"]))
    return _blend_over(rgba, _rgb01(p["color"]), cov * (p["opacity"] / 100.0), p["mode"])


@effect("fractalNoise", "Fractal Noise", "Generate",
        "Multi-octave value noise - the single most useful thing in a "
        "compositor. Smoke, cloud, fog, dust, energy, dissolve maps, "
        "displacement fields, organic mattes and every texture that must not "
        "look drawn. Evolution walks a THIRD axis through the field, so the "
        "pattern boils in place instead of sliding past. Measured at 1080p: "
        "about 250ms a frame at one octave and 375ms at six, so complexity "
        "costs roughly 30ms an octave on top of a fixed 220ms; draft builds "
        "the field at half size and lands near 230ms whatever the complexity.",
        {"fractalType": pick(FRACTAL_TYPES, "basic",
                             "basic is cloud, turbulent folds it into wisps and "
                             "smoke, ridged inverts the fold into veins and lightning"),
         "noiseType": pick(NOISE_TYPES, "soft",
                           "block is hard cells, linear is faceted, soft is rounded"),
         "invert": flag(False, "flip the field"),
         "contrast": num(100, 0, 400, "spread around mid grey; this is the dial that "
                                      "turns cloud into smoke", unit="%"),
         "brightness": num(0, -100, 100, "lift or drop the whole field", unit="%"),
         "overflow": pick(["clip", "soft", "wrap"], "clip",
                          "what happens past black and white: clip flattens, soft "
                          "rolls off, wrap folds back for hard contour bands"),
         "scale": num(100, 1, 800, "feature size; 100 is a blob about a quarter of "
                                   "the frame's long edge, and it is measured off "
                                   "that edge so a half-scale preview matches the "
                                   "render", unit="%"),
         "stretchWidth": num(100, 5, 1000, "stretch the field horizontally", unit="%"),
         "stretchHeight": num(100, 5, 1000, "stretch the field vertically", unit="%"),
         "rotation": num(0, -3600, 3600, "turn the whole field, degrees", unit="deg"),
         "offsetX": num(0, -8192, 8192, "slide the field, in pixels", unit="px"),
         "offsetY": num(0, -8192, 8192, "slide the field, in pixels", unit="px"),
         "complexity": num(6, 1, 10, "octaves; each one adds detail at half the size "
                                     "and costs another pass",
                           integer=True, animatable=False),
         "subInfluence": num(70, 0, 100, "how much of the previous octave each finer "
                                         "one keeps", unit="%"),
         "subScaling": num(50, 10, 200, "each octave's feature size as a percent of "
                                        "the one before; 50 is the usual doubling", unit="%"),
         "subRotation": num(0, -360, 360, "turn each octave a little further, which "
                                          "breaks up the grain that lines up on the "
                                          "axes", unit="deg"),
         "evolution": num(0, -36000, 36000, "walk through the field; 360 degrees is "
                                            "one whole new pattern", unit="deg"),
         "evolutionSpeed": num(0, -10, 10, "turns of evolution per second, so it boils "
                                           "with no keyframes", unit="Hz"),
         "seed": num(1, 0, 100000, "a different field from the same settings",
                     integer=True, animatable=False),
         "opacity": num(100, 0, 100, "how much of it lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how the noise meets the layer under it")},
        touches_alpha=True, expensive=True)
def _fractal_noise(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    v = _fractal_field(h, w, **_noise_params(p, ctx, complexity=int(p["complexity"])))
    if p["invert"]:
        v = 1.0 - v
    v = (v - 0.5) * (p["contrast"] / 100.0) + 0.5 + p["brightness"] / 100.0
    over = p["overflow"]
    if over == "wrap":
        v = np.mod(v, 1.0)                    # the hard contour-band look, on purpose
    elif over == "soft":
        v = 0.5 + 0.5 * np.tanh(2.0 * (2.0 * v - 1.0))
    grey = np.repeat(np.clip(v, 0, 1)[..., None], 3, axis=-1).astype(np.float32)
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, grey, cov, p["mode"])


@effect("fourColorGradient", "4-Colour Gradient", "Generate",
        "Four coloured lights at four points, blended. Every warm-to-cool "
        "background anyone has ever animated behind a title, and unlike Ramp it "
        "bends - the points can be keyframed and the colour field follows.",
        {"point1X": num(25, -100, 200, "first point, percent of width", unit="%"),
         "point1Y": num(25, -100, 200, "first point, percent of height", unit="%"),
         "color1": col([255, 90, 60], "colour at the first point"),
         "point2X": num(75, -100, 200, "second point, percent of width", unit="%"),
         "point2Y": num(25, -100, 200, "second point, percent of height", unit="%"),
         "color2": col([255, 210, 80], "colour at the second point"),
         "point3X": num(25, -100, 200, "third point, percent of width", unit="%"),
         "point3Y": num(75, -100, 200, "third point, percent of height", unit="%"),
         "color3": col([60, 90, 220], "colour at the third point"),
         "point4X": num(75, -100, 200, "fourth point, percent of width", unit="%"),
         "point4Y": num(75, -100, 200, "fourth point, percent of height", unit="%"),
         "color4": col([120, 230, 190], "colour at the fourth point"),
         "blend": num(100, 1, 500, "how far each colour reaches; low is four hard "
                                   "territories, high is one soft wash", unit="%"),
         "jitter": num(0, 0, 100, "seeded dither, because a smooth gradient bands on "
                                  "anything but a good screen", unit="%"),
         "seed": num(4, 0, 100000, "dither seed", integer=True, animatable=False),
         "opacity": num(100, 0, 100, "how much of it lands", unit="%"),
         "mode": pick(COMPOSITE_MODES, "normal", "how it meets the layer under it")},
        touches_alpha=True)
def _four_color_gradient(rgba, p, ctx):
    if p["opacity"] < 0.005:
        return rgba
    h, w = rgba.shape[:2]
    xx, yy = _grid(h, w)
    diag2 = max(1.0, float(w) * w + float(h) * h)
    reach = max(0.02, p["blend"] / 100.0) * 0.5
    acc = np.zeros((h, w, 3), np.float32)
    tot = np.zeros((h, w), np.float32)
    for i in range(1, 5):
        px = p[f"point{i}X"] / 100.0 * w
        py = p[f"point{i}Y"] / 100.0 * h
        # a gaussian rather than inverse distance: inverse distance spikes to
        # the pure colour at the point and washes to the average everywhere
        # else, which is the look nobody wants and everybody gets. The gaussian
        # wants the SQUARE of the distance, so there is no square root here at
        # all - four of those over a 2Mpx frame is 40ms of nothing.
        d2 = ((xx - px) ** 2 + (yy - py) ** 2) / (diag2 * reach * reach)
        wgt = np.exp(-d2) + 1e-4
        acc += wgt[..., None] * _rgb01(p[f"color{i}"])
        tot += wgt
    grad = acc / tot[..., None]
    if p["jitter"] > 0.05:
        rng = np.random.default_rng(int(p["seed"]) & 0xFFFFFFF)
        grad = grad + (rng.random((h, w, 3), dtype=np.float32) - 0.5) * (p["jitter"] / 100.0 * 0.06)
    cov = np.full((h, w), p["opacity"] / 100.0, np.float32)
    return _blend_over(rgba, np.clip(grad, 0, 1).astype(np.float32), cov, p["mode"])


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------
#
# These two are the only effects that need more than the frame in front of
# them. The engine supplies `ctx["history"]`: a list of this layer's PREVIOUS
# rendered frames, same shape and dtype, OLDEST FIRST, so history[-1] is the
# frame before this one. Missing or short history is not an error - it is what
# the first second of a comp looks like - so both degrade to a no-op.

@effect("echo", "Echo", "Time",
        "Trails: this frame plus its own past, fading. Add for light trails, "
        "behind for a ghost that stays under the subject, maximum for a "
        "long-exposure smear that never blows out.",
        {"echoes": num(5, 1, 32, "how many past frames are stacked; each one is "
                                 "another full-frame composite", integer=True),
         "frameDelay": num(2, 1, 60, "frames between one echo and the next. The engine "
                                     "caps how far back it will decode, so echoes times "
                                     "delay past that quietly yields fewer echoes than "
                                     "were asked for",
                           integer=True, animatable=False),
         "decay": num(60, 0, 100, "each echo keeps this much of the one before", unit="%"),
         "startingIntensity": num(100, 0, 100, "strength of the first echo", unit="%"),
         "mode": pick(["add", "behind", "maximum", "blend"], "behind",
                      "how an echo meets the frames in front of it")},
        touches_alpha=True, needsHistory=True)
def _echo(rgba, p, ctx):
    step = max(1, int(p["frameDelay"]))
    count = int(p["echoes"])
    history = _past(ctx, count * step)   # newest first
    if not history:
        return rgba                      # first frames of a comp have no past
    decay = p["decay"] / 100.0
    start = p["startingIntensity"] / 100.0
    picks = []
    for i in range(1, count + 1):
        idx = i * step - 1
        if idx >= len(history):
            break
        past = history[idx]
        if past.shape != rgba.shape:
            continue
        picks.append((past.astype(np.float32, copy=False), start * (decay ** (i - 1))))
    if not picks:
        return rgba

    mode = p["mode"]
    if mode == "behind":
        # oldest first, each newer one composited over it, this frame last
        acc_pm = np.zeros(rgba.shape[:2] + (3,), np.float32)
        acc_a = np.zeros(rgba.shape[:2], np.float32)
        for past, wgt in reversed(picks):
            pa = past[..., 3] * wgt
            acc_pm = acc_pm * (1 - pa[..., None]) + past[..., :3] * pa[..., None]
            acc_a = acc_a * (1 - pa) + pa
        a = _alpha(rgba)
        acc_pm = acc_pm * (1 - a[..., None]) + _rgb(rgba) * a[..., None]
        return _unpremul(acc_pm, np.clip(acc_a * (1 - a) + a, 0, 1))

    a = _alpha(rgba)
    pm = _rgb(rgba) * a[..., None]
    acc_a = a.copy()
    for past, wgt in picks:
        pa = past[..., 3] * wgt
        ppm = past[..., :3] * pa[..., None]
        if mode == "add":
            pm = pm + ppm
            acc_a = acc_a + pa * (1 - acc_a)
        elif mode == "maximum":
            pm = np.maximum(pm, ppm)
            acc_a = np.maximum(acc_a, pa)
        else:                             # blend - a running average
            pm = pm + ppm
            acc_a = acc_a + pa
    if mode == "blend":
        n = len(picks) + 1.0
        pm, acc_a = pm / n, acc_a / n
    return _unpremul(pm, np.clip(acc_a, 0, 1))


@effect("posterizeTime", "Posterize Time", "Time",
        "Hold the picture on twos, or on sixes - the animation-on-twos look, "
        "and the cheapest way to make 30fps footage read as film. The engine "
        "reads snapsTime and evaluates the layer at the quantised time; if it "
        "instead hands over history, this holds the last sampled frame itself.",
        {"rate": num(12, 1, 120, "how many new pictures per second survive", unit="fps")},
        touches_alpha=True, needsHistory=True, snapsTime=True)
def _posterize_time(rgba, p, ctx):
    fps = float(ctx.get("fps") or 30.0) or 30.0
    step = max(1, int(round(fps / max(1.0, p["rate"]))))
    if step == 1:
        return rgba
    back = _frame(ctx) % step
    if back == 0:
        return rgba                       # this IS a sample frame
    history = _past(ctx, back)
    if len(history) < back:
        return rgba
    held = history[back - 1]
    if held.shape != rgba.shape:
        return rgba
    return held.astype(np.float32, copy=True)


@effect("timeDifference", "Time Difference", "Time",
        "What CHANGED since a previous frame. Everything that held still goes "
        "black, so this is the motion detector, the ghost pass, the "
        "did-the-render-actually-change check, and the cheapest way to pull a "
        "matte off a locked-off plate.",
        {"frameOffset": num(1, 1, 60, "how many frames back the comparison is made",
                            integer=True, animatable=False),
         "contrast": num(200, 0, 800, "gain on the difference; a real change is small", unit="%"),
         "absolute": flag(True, "off keeps the sign, centred on mid grey"),
         "alphaMode": pick(["original", "difference", "maximum"], "original",
                           "keep this frame's matte, use the difference as the "
                           "matte, or take whichever was more opaque")},
        touches_alpha=True, needsHistory=True)
def _time_difference(rgba, p, ctx):
    back = max(1, int(p["frameOffset"]))
    history = _past(ctx, back)
    if len(history) < back:
        return rgba                       # nothing to compare against yet
    prev = history[back - 1]
    if prev.shape != rgba.shape:
        return rgba
    prev = prev.astype(np.float32, copy=False)
    gain = p["contrast"] / 100.0
    d = (_rgb(rgba) - prev[..., :3]) * gain
    rgb = np.abs(d) if p["absolute"] else d + 0.5
    a = _alpha(rgba)
    if p["alphaMode"] == "difference":
        a = np.clip(np.abs(a - prev[..., 3]) * gain, 0, 1)
    elif p["alphaMode"] == "maximum":
        a = np.maximum(a, prev[..., 3])
    return _pack(rgb, a)


# ---------------------------------------------------------------------------
# Matte
# ---------------------------------------------------------------------------

@effect("minimax", "Minimax", "Matte",
        "Take the brightest or darkest value in a neighbourhood. On alpha it "
        "grows or shrinks a matte by an exact number of pixels; max-then-min "
        "closes pinholes without moving the edge, and min-then-max deletes "
        "specks the same way. One axis at a time is how you close a horizontal "
        "tear without fattening everything else.",
        {"operation": pick(["max", "min", "maxThenMin", "minThenMax"], "max",
                           "max grows the bright, min grows the dark; the pairs "
                           "close holes and remove specks without a net move"),
         "radius": num(2, 1, 50, "neighbourhood half-width, in pixels",
                       integer=True, unit="px"),
         "channel": pick(["alpha", "rgb", "rgba", "red", "green", "blue"], "alpha",
                         "what the filter runs on"),
         "direction": pick(["both", "horizontal", "vertical"], "both",
                           "restrict the neighbourhood to one axis")},
        touches_alpha=True)
def _minimax(rgba, p, ctx):
    r = max(1, int(p["radius"]))
    size = {"both": (r * 2 + 1, r * 2 + 1), "horizontal": (r * 2 + 1, 1),
            "vertical": (1, r * 2 + 1)}[p["direction"]]
    k = cv2.getStructuringElement(cv2.MORPH_RECT, size)
    ops = {"max": (cv2.dilate,), "min": (cv2.erode,),
           "maxThenMin": (cv2.dilate, cv2.erode),
           "minThenMax": (cv2.erode, cv2.dilate)}[p["operation"]]

    def run(plane):
        out = plane
        for fn in ops:
            out = fn(out, k)
        return out

    rgb, a = _rgb(rgba), _alpha(rgba)
    ch = p["channel"]
    if ch in ("alpha", "rgba"):
        a = run(a)
    if ch in ("rgb", "rgba"):
        rgb = run(rgb)
    elif ch in ("red", "green", "blue"):
        i = {"red": 0, "green": 1, "blue": 2}[ch]
        rgb[..., i] = run(np.ascontiguousarray(rgb[..., i]))
    return _pack(rgb, a)


@effect("feather", "Feather", "Matte",
        "Soften the matte and nothing else. Bias exists because a symmetric "
        "feather always eats into the subject; push it out and the softness "
        "lands outside the silhouette where it belongs.",
        {"amount": num(6, 0, 200, "blur applied to alpha, in pixels", unit="px"),
         "bias": num(0, -100, 100, "positive pushes the soft edge outward, negative inward",
                     unit="%")},
        touches_alpha=True)
def _feather(rgba, p, ctx):
    if p["amount"] < 0.05:
        return rgba
    a = np.clip(_blur_a(_alpha(rgba), p["amount"], ctx.get("draft")), 0, 1)
    if abs(p["bias"]) > 0.05:
        a = np.power(a, 2.0 ** (-p["bias"] / 50.0))
    return _pack(_rgb(rgba), a)


@effect("invertAlpha", "Invert Alpha", "Matte",
        "Swap what is solid for what is not. Two full inversions are exactly "
        "the identity, which is the property that makes it safe to keyframe.",
        {"amount": num(100, 0, 100, "100 is a full swap", unit="%")},
        touches_alpha=True)
def _invert_alpha(rgba, p, ctx):
    w = p["amount"] / 100.0
    if w < 0.0005:
        return rgba
    a = _alpha(rgba)
    return _pack(_rgb(rgba), a + (1.0 - 2.0 * a) * w)


@effect("setMatte", "Set Matte", "Matte",
        "Wear another layer's shape. Point `matteLayer` at anything in the comp "
        "and this layer is cut by ITS alpha - or by its luminance, which is how "
        "a painted grey ramp becomes transparency without a key going anywhere "
        "near it. The one effect that lets a finished render be shaped by a "
        "plate it was never composited with. With no layer named it reads a "
        "channel of THIS one, so `use: luminance` alone is "
        "brightness-as-matte. `combine` decides whether the new matte replaces "
        "the old or folds into it, because a layer that has already been keyed "
        "should not silently lose that work. 50ms at 1080p.",
        {"matteLayer": lay("layer the matte is taken from; empty reads this layer"),
         "mapFit": mapfit("matte"),
         "use": pick(["alpha", "luminance", "red", "green", "blue"], "alpha",
                     "which channel of that layer becomes the matte"),
         "invertMatte": flag(False, "solid where it was clear"),
         "combine": pick(["replace", "multiply", "min", "max"], "replace",
                         "replace throws this layer's own matte away; multiply and "
                         "min keep only what both cover; max unions them"),
         "amount": num(100, 0, 100, "blend back towards the matte this layer arrived "
                                    "with, so the swap can be keyframed on", unit="%")},
        touches_alpha=True)
def _set_matte(rgba, p, ctx):
    # Defaults are the identity on purpose: alpha, replace, 100% off this very
    # layer is the matte it already had. An effect you have just dropped on a
    # layer must not change it before you have told it anything.
    h, w = rgba.shape[:2]
    src, _other = _map_source(ctx, p, "matteLayer", rgba, "setMatte")
    m = np.clip(_fit_map(_map_channel(src, p["use"]), h, w, p["mapFit"]), 0.0, 1.0)
    if p["invertMatte"]:
        m = 1.0 - m
    a = _alpha(rgba)
    mode = p["combine"]
    if mode == "multiply":
        out = a * m
    elif mode == "min":
        out = np.minimum(a, m)
    elif mode == "max":
        out = np.maximum(a, m)
    else:
        out = m
    k = p["amount"] / 100.0
    if k < 1.0:
        out = a + (out - a) * k
    return _pack(_rgb(rgba), np.asarray(out, dtype=np.float32))


@effect("premultiply", "Premultiply", "Matte",
        "Bake the matte into the colour against a background colour. What you "
        "reach for when a source arrived straight and the thing downstream "
        "expects it flattened.",
        {"matteColor": col([0, 0, 0], "the colour the edge is flattened against")})
def _premultiply(rgba, p, ctx):
    a = _alpha(rgba)
    matte = _rgb01(p["matteColor"])[None, None, :]
    return _pack(_rgb(rgba) * a[..., None] + matte * (1 - a)[..., None], a)


@effect("unpremultiply", "Unpremultiply", "Matte",
        "Remove a colour matte - the black fringe on a badly exported PNG, or "
        "the white halo on a logo cut against paper. Divide the colour back "
        "out and the edge stops glowing.",
        {"matteColor": col([0, 0, 0], "the colour that was baked in")})
def _unpremultiply(rgba, p, ctx):
    a = _alpha(rgba)
    matte = _rgb01(p["matteColor"])[None, None, :]
    rgb = (_rgb(rgba) - matte * (1 - a)[..., None]) / np.maximum(a, _EPS)[..., None]
    return _pack(np.clip(rgb, 0, 1), a)


# ---------------------------------------------------------------------------
# Transition
# ---------------------------------------------------------------------------
#
# A wipe is not a look, it is a schedule: ONE `completion` goes 0 to 100 and the
# layer leaves. So every effect here takes its coverage out of some geometry,
# multiplies the matte by it and touches nothing else - colour is left exactly
# alone, which is what lets a wipe sit on top of a finished grade.
#
# All six no-op at completion 0. That is not tidiness: a coverage built from a
# hard threshold has a seam exactly where the threshold sits, so a blinds wipe
# at 0% would otherwise draw a hairline on every slat before it had started.

def _wipe(rgba, cov):
    return _pack(_rgb(rgba), _alpha(rgba) * np.clip(cov, 0.0, 1.0).astype(np.float32))


def _axis(h, w, angle_deg):
    """Signed distance in pixels along a wipe direction, from the frame centre,
    with the frame's extent along it. Angle 0 points UP the screen, so a wipe
    that removes the high end starts at the top - which is what everyone means
    by "wipe down"."""
    th = math.radians(angle_deg)
    sn, cs = math.sin(th), math.cos(th)
    xx, yy = _grid(h, w)
    return ((xx - w * 0.5) * sn - (yy - h * 0.5) * cs,
            max(abs(w * sn) + abs(h * cs), 1e-3))


def _dissolve_cov(m, completion, softness):
    """Coverage for a threshold wipe over a 0..1 map.

    The threshold is swept over a range WIDENED by the softness rather than
    over 0..1. Sweep it over 0..1 and a soft dissolve is already half gone at
    completion zero and still half there at a hundred - the bug every hand-
    rolled dissolve has, visible only at the two moments that matter.
    """
    soft = max(float(softness) / 100.0, 1e-4)
    thr = float(completion) / 100.0 * (1.0 + soft) - soft
    return np.clip((m - thr) / soft, 0.0, 1.0)


@effect("linearWipe", "Linear Wipe", "Transition",
        "A straight edge crossing the frame. The transition every cut in the "
        "world falls back on, and with a big feather it is a soft light sweep "
        "rather than a wipe at all.",
        {"completion": num(0, 0, 100, "0 is untouched, 100 is gone", unit="%"),
         "angle": num(0, -360, 360, "0 wipes from the top down, 90 from the right",
                      unit="deg"),
         "feather": num(0, 0, 500, "width of the soft edge, in pixels", unit="px")},
        touches_alpha=True)
def _linear_wipe(rgba, p, ctx):
    if p["completion"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    pos, span = _axis(h, w, p["angle"])
    f = max(p["feather"], 1e-3)
    # the edge is swept over the frame's extent PLUS the feather, at both ends,
    # so 0% really is untouched and 100% really is gone. Sweep it over the bare
    # extent and the far corner is still half-visible at a hundred percent
    thr = (span + 2.0 * f) * (0.5 - p["completion"] / 100.0)
    return _wipe(rgba, 1.0 - _smoothstep(thr - f * 0.5, thr + f * 0.5, pos))


@effect("radialWipe", "Radial Wipe", "Transition",
        "A clock hand sweeping the layer away. The countdown, the loading ring, "
        "the sword swipe - and 'both' opens it from two sides at once, which is "
        "the one that reads as a shutter.",
        {"completion": num(0, 0, 100, "0 is untouched, 100 is gone", unit="%"),
         "startAngle": num(0, -360, 360, "where the hand starts; 0 is 12 o'clock",
                           unit="deg"),
         "wipe": pick(["clockwise", "counterclockwise", "both"], "clockwise",
                      "which way the hand sweeps"),
         "centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "feather": num(0, 0, 500, "width of the soft edge, in pixels", unit="px")},
        touches_alpha=True)
def _radial_wipe(rgba, p, ctx):
    if p["completion"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    xx, yy = _grid(h, w)
    dx, dy = xx - cx, yy - cy
    r = np.sqrt(dx * dx + dy * dy)
    ang = np.mod(np.arctan2(dy, dx) + math.pi * 0.5 - math.radians(p["startAngle"]),
                 math.pi * 2.0)
    c = p["completion"] / 100.0
    if p["wipe"] == "clockwise":
        d = ang - c * 2.0 * math.pi
    elif p["wipe"] == "counterclockwise":
        d = (2.0 - c * 2.0) * math.pi - ang
    else:
        d = np.minimum(ang - c * math.pi, (2.0 - c) * math.pi - ang)
    # angle times radius is ARC LENGTH, so the feather is the same width in
    # pixels near the centre and out at the corner instead of fanning out. The
    # (1-2c) term walks the whole band past both ends, so the start ray is not
    # already half-wiped at zero.
    f = max(p["feather"], 1e-3)
    return _wipe(rgba, _smoothstep(-f * 0.5, f * 0.5, d * r + (1.0 - 2.0 * c) * f * 0.5))


@effect("venetianBlinds", "Venetian Blinds", "Transition",
        "Slats closing. Reads as a physical object moving rather than a "
        "graphic, which is why it survives on title cards long after the other "
        "wipes stopped being usable.",
        {"completion": num(0, 0, 100, "0 is untouched, 100 is gone", unit="%"),
         "direction": num(0, -360, 360, "angle of the slats; 0 makes horizontal bands",
                          unit="deg"),
         "width": num(48, 2, 1000, "slat spacing, in pixels", unit="px"),
         "feather": num(0, 0, 200, "soften each slat edge, in pixels", unit="px")},
        touches_alpha=True)
def _venetian_blinds(rgba, p, ctx):
    if p["completion"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    pos, _ = _axis(h, w, p["direction"])
    span = max(2.0, p["width"])
    m = np.mod(pos, span) / span
    f = max(p["feather"], 1e-3) / span
    thr = p["completion"] / 100.0 * (1.0 + f) - f * 0.5     # widened by the feather
    return _wipe(rgba, _smoothstep(-f * 0.5, f * 0.5, m - thr))


@effect("blockDissolve", "Block Dissolve", "Transition",
        "Squares leaving in a random but REPEATABLE order - seeded, so the same "
        "render twice is the same file and a motion-blurred pass does not "
        "strobe. One-pixel blocks is a plain dither dissolve.",
        {"completion": num(0, 0, 100, "0 is untouched, 100 is gone", unit="%"),
         "blockWidth": num(32, 1, 512, "block width in pixels", integer=True, unit="px"),
         "blockHeight": num(32, 1, 512, "block height in pixels", integer=True, unit="px"),
         "softness": num(0, 0, 100, "how gradually each block fades rather than "
                                    "vanishing", unit="%"),
         "seed": num(9, 0, 100000, "a different order from the same settings",
                     integer=True, animatable=False)},
        touches_alpha=True)
def _block_dissolve(rgba, p, ctx):
    if p["completion"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    bw, bh = max(1, int(p["blockWidth"])), max(1, int(p["blockHeight"]))
    gw, gh = max(1, int(math.ceil(w / bw))), max(1, int(math.ceil(h / bh)))
    r = np.random.default_rng(int(p["seed"]) & 0xFFFFFFF).random((gh, gw), dtype=np.float32)
    if (gh, gw) != (h, w):
        r = cv2.resize(r, (w, h), interpolation=cv2.INTER_NEAREST)
    return _wipe(rgba, _dissolve_cov(r, p["completion"], p["softness"]))


@effect("gradientWipe", "Gradient Wipe", "Transition",
        "Dissolve in the order a map says: dark leaves first. Name a "
        "`gradientLayer` and that layer IS the order - hand-painted, a render, "
        "a text layer, anything, which is the wipe you cannot get any other "
        "way. Empty, it falls to the fractal noise it carries (the organic "
        "dissolve: fire, rust, cloud) or to this layer's own luminance, which "
        "burns away from the shadows. With a layer named, `source` picks the "
        "channel of IT to read, and \"noise\" means its luminance - the layer "
        "replaces the field rather than being ignored beside it. 65ms at 1080p.",
        {"completion": num(0, 0, 100, "0 is untouched, 100 is gone", unit="%"),
         "gradientLayer": lay("layer whose luminance orders the dissolve; empty "
                              "uses the noise or this layer, per `source`"),
         "mapFit": mapfit("gradient"),
         "source": pick(["noise", "luminance", "red", "alpha"], "noise",
                        "what decides the order things leave in - a channel of the "
                        "gradient layer when one is named, otherwise of this one"),
         "softness": num(25, 0, 100, "width of the band that is halfway gone", unit="%"),
         "invert": flag(False, "bright leaves first instead"),
         "noiseScale": num(120, 1, 800, "size of the noise blobs, when source is "
                                        "noise", unit="%"),
         "noiseComplexity": num(3, 1, 8, "octaves of noise, when source is noise",
                                integer=True, animatable=False),
         "noiseSeed": num(5, 0, 100000, "a different dissolve from the same settings",
                          integer=True, animatable=False)},
        touches_alpha=True)
def _gradient_wipe(rgba, p, ctx):
    if p["completion"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    src = p["source"]
    grad = _layer_in(ctx, p["gradientLayer"])
    if grad is not None:
        # A named layer always wins over the built-in field. The alternative -
        # source "noise" quietly outranking the layer somebody just picked -
        # is a wipe that ignores its own map and says nothing about it.
        if src == "noise":
            _note(ctx, "gradientWipe: the gradient layer replaced the noise field; "
                       "its luminance orders the dissolve")
            src = "luminance"
        m = _fit_map(_map_channel(grad, src), h, w, p["mapFit"])
    elif p["gradientLayer"]:
        _note(ctx, 'gradientWipe: layer "%s" was not available - fell back to '
                   '`source` on this layer' % p["gradientLayer"])
        grad = None
    if grad is None:
        if src == "noise":
            m = _fractal_field(h, w, scale=p["noiseScale"],
                               complexity=int(p["noiseComplexity"]),
                               fractalType="basic", noiseType="soft",
                               seed=int(p["noiseSeed"]), draft=bool(ctx.get("draft")))
        elif src == "alpha":
            m = _alpha(rgba)
        elif src == "red":
            m = _rgb(rgba)[..., 0]
        else:
            m = _luma(_rgb(rgba))
    m = np.clip(m, 0, 1)
    if p["invert"]:
        m = 1.0 - m
    return _wipe(rgba, _dissolve_cov(m, p["completion"], p["softness"]))


@effect("irisWipe", "Iris Wipe", "Transition",
        "A shape closing on the middle - the camera iris, the keyhole, the "
        "cartoon iris-out. Inverted it opens instead, which is how a shot "
        "arrives through a porthole.",
        {"completion": num(0, 0, 100, "0 is untouched, 100 is gone", unit="%"),
         "shape": pick(["circle", "square", "diamond", "star"], "circle",
                       "the outline that closes"),
         "points": num(6, 3, 20, "spikes, when the shape is a star",
                       integer=True, animatable=False),
         "centerX": num(50, -100, 200, "centre, percent of width", unit="%"),
         "centerY": num(50, -100, 200, "centre, percent of height", unit="%"),
         "feather": num(0, 0, 500, "width of the soft edge, in pixels", unit="px"),
         "invert": flag(False, "eat outward from the centre instead of inward from "
                               "the edge; either way completion 0 is untouched")},
        touches_alpha=True)
def _iris_wipe(rgba, p, ctx):
    if p["completion"] < 0.05:
        return rgba
    h, w = rgba.shape[:2]
    cx, cy = p["centerX"] / 100.0 * w, p["centerY"] / 100.0 * h
    xx, yy = _grid(h, w)
    dx, dy = xx - cx, yy - cy
    shape = p["shape"]
    if shape == "square":
        d = np.maximum(np.abs(dx), np.abs(dy))
    elif shape == "diamond":
        d = np.abs(dx) + np.abs(dy)
    elif shape == "star":
        r = np.sqrt(dx * dx + dy * dy)
        d = r / (1.0 + 0.35 * np.cos(int(p["points"]) * np.arctan2(dy, dx)))
    else:
        d = np.sqrt(dx * dx + dy * dy)
    # the reach is measured, not assumed: an off-centre iris has to travel
    # further to clear the far corner, and a guessed radius leaves a sliver
    reach = float(d.max())
    f = max(p["feather"], 1e-3)
    c = p["completion"] / 100.0
    # both directions are untouched at 0 and gone at 100; the invert swaps WHERE
    # the hole starts, not what completion means
    edge = (d - reach * c) if p["invert"] else (reach * (1.0 - c) - d)
    return _wipe(rgba, _smoothstep(-f * 0.5, f * 0.5, edge + (0.5 - c) * f))


# ---------------------------------------------------------------------------
# the entry point
# ---------------------------------------------------------------------------

def _coerce(spec, params):
    """Every value an effect body sees has been through here: unknown keys are
    dropped, missing ones take the catalog default, and everything else is
    clamped to the range the catalog advertises. An effect can therefore assume
    its parameters are sane, which is the only reason the bodies read as maths
    instead of validation."""
    out = {}
    src = params if isinstance(params, dict) else {}
    for key, p in spec.items():
        v = src.get(key, p["default"])
        kind = p["type"]
        if kind == "number":
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = float(p["default"])
            if not math.isfinite(v):
                v = float(p["default"])
            v = min(max(v, float(p["min"])), float(p["max"]))
            if p.get("integer"):
                v = int(round(v))
        elif kind == "bool":
            v = bool(v)
        elif kind == "enum":
            if v not in p["options"]:
                v = p["default"]
        elif kind == "layer":
            # A reference is a name. Anything that is not a string names
            # nothing, and naming nothing is precisely the empty default - so
            # a number, a dict or a None here lands on "no second layer"
            # rather than on str(None) naming a layer called "None".
            v = v.strip() if isinstance(v, str) else str(p["default"])
        elif kind == "color":
            try:
                chan = [min(255.0, max(0.0, float(c))) for c in list(v)[:4]]
            except (TypeError, ValueError):
                chan = []
            v = chan if len(chan) >= 3 else list(p["default"])
        elif kind == "points":
            clean = []
            for pt in (v if isinstance(v, (list, tuple)) else []):
                try:
                    if len(pt) == 2:
                        clean.append([min(255.0, max(0.0, float(pt[0]))),
                                      min(255.0, max(0.0, float(pt[1])))])
                except (TypeError, ValueError):
                    continue
            v = clean if len(clean) >= 2 else [list(q) for q in p["default"]]
        out[key] = v
    return out


def apply(name, rgba, params=None, ctx=None):
    """Run one effect. See the module docstring for the contract."""
    fn = _REGISTRY.get(str(name))
    if fn is None:
        return rgba
    if not isinstance(rgba, np.ndarray) or rgba.ndim != 3 or rgba.shape[2] != 4:
        return rgba
    if not np.issubdtype(rgba.dtype, np.floating):
        # An integer array is 0..255, not 0..1. Casting it would run every
        # effect on numbers a hundred times too big and return a white frame;
        # refusing it makes the mistake visible at the seam where it happened.
        return rgba
    arr = rgba if rgba.dtype == np.float32 else rgba.astype(np.float32)
    h, w = arr.shape[:2]
    c = dict(ctx or {})
    c.setdefault("t", 0.0)
    c.setdefault("fps", 30.0)
    c.setdefault("width", w)
    c.setdefault("height", h)
    c.setdefault("draft", False)
    c.setdefault("layer", {})
    try:
        out = fn(arr, _coerce(CATALOG[name]["params"], params), c)
    except Exception as exc:
        # One bad parameter must not lose an eight-second render. Loud on
        # stderr, though - an effect that quietly does nothing is the failure
        # nobody ever finds.
        print(f"[effects] {name} failed: {exc}", file=sys.stderr)
        return rgba
    if not isinstance(out, np.ndarray) or out.shape != arr.shape:
        return rgba
    if out is arr or out is rgba:
        return arr                        # a declared no-op, not a result
    if out.dtype != np.float32:
        out = out.astype(np.float32)
    # The 0..1 promise is enforced here rather than trusted from 52 places.
    # clip already folds the infinities in; NaN survives it, so it gets its own
    # pass - together about 7ms on a 1080p frame, where nan_to_num alone is 23.
    np.clip(out, 0.0, 1.0, out=out)
    np.copyto(out, 0.0, where=np.isnan(out))
    return out


def catalog():
    """What MCP and /api/vfx/catalog serve."""
    return {"effects": CATALOG, "groups": GROUP_ORDER, "names": sorted(_REGISTRY)}


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
