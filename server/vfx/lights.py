"""Lights and materials — the half of 3D this compositor never had.

The engine can already put a layer in space and look at it through a lens. It
could not LIGHT it. Everything below is that: AE's four light types, AE's
material options, and plane-onto-plane shadows, computed on a layer's own bitmap
before the perspective warp carries it to the screen.

    rig   = lights.rig(layers, t, comp=comp, visible=…, parent_of=…, bind=…)
    px    = lights.shade(px, m4, camera, rig, layer, scale=scale, draft=draft)

`rig` is once per frame per comp and costs nothing; `shade` is once per 3D layer
and is where the arithmetic is. A comp with no light layers gets `rig() -> None`,
and `shade` with a None rig hands back the array it was given — the SAME object,
not a copy — so wiring this in changes nothing about a document that does not
use it. That is the whole safety story: opt-in at the document level, identity at
the code level.

WHY THE LAYER'S OWN BITMAP AND NOT THE SCREEN. Shading is a property of the
surface, not of the frame. Doing it in layer space means the shading is carried
through the same homography as the pixels, so a lit card that turns keeps its
highlight glued to the card. It also means the geometry is a PLANE and every
quantity below is separable — see _Basis.

WHAT COMES BACK: pixels, not a multiplier field. A multiplier cannot express a
specular highlight, which is additive and takes the LIGHT's colour rather than
the surface's — expressing it as a multiply means dividing by the surface colour,
which is unbounded at black and undefined at zero. The field would also cost the
same memory as the shaded copy plus a multiply at the call site. So: float32
(H, W, 4), 0..1, straight alpha in, the same out, alpha bit-identical. Lighting
never touches transparency, and that is tested rather than asserted.

TWO-SIDED, DELIBERATELY. A layer's normal is flipped to face the camera. AE does
this and it is not a cheat: a plane can only be seen from one side at a time, and
because N·P is constant over a plane the test is one sign for the whole layer,
not a per-pixel guess. Without it, turning a layer 180° would make it black,
which is a bug report, not a feature.

────────────────────────────────────────────────────────────────────────────────
SHADOWS — what is real here and what is not.

A flat plane casting onto another flat plane, from a point at a known position,
is a PROJECTIVE MAP of the caster's alpha. Not an approximation of one: for a
receiver point P, the ray from the light through P meets the caster's plane at a
point whose caster-local coordinates are a ratio of two affine functions of P.
That is a homography, cv2 warps it exactly, and the "is the hit actually between
the light and the surface" test is a second affine field with a sign. So the
shadow of a plane on a plane is computed, not faked, and shadow_test proves the
umbra lands where similar triangles say it does.

What that buys, and what it does not:

  * REAL — the shape, the position, the perspective stretch, the caster's own
    translucency, several casters compounding, hard edges, and the case where
    the caster is not between the light and the surface at all (no shadow, from
    the sign, not from a fudge).
  * NOT REAL — anything that is not a plane shadowing a plane. Nothing casts onto
    the comp background, onto a 2D layer, or onto itself. There is no shadow map,
    no depth buffer and no volumetrics, and adding one would mean rasterising
    depth per light per frame, which is a renderer, not a module.
  * NOT REAL — the penumbra. `shadowDiffusion` blurs the projected alpha by a
    uniform sigma. A true penumbra widens with the caster-to-receiver distance;
    this one does not, because a plane's distance to a plane is not one number
    once either is tilted. It is a look control that happens to be spelled like a
    physical one, and it is labelled that way in the catalog.
  * NOT REAL — colour. A red translucent caster throws a grey shadow, because the
    transmittance is one channel. AE does the same.
  * COARSE — the caster is sampled bilinearly out of its own bitmap. A caster
    seen almost edge-on from the light stretches a handful of its pixels across
    the whole receiver, and there is no mip chain to fix that.

The cost is one warp per (light, caster) pair per receiving layer, which is why
MAX_CASTERS exists and why `draft` skips shadows outright.

─────────────────────────────────────────────────────────────────────────────────
WHAT IT COSTS. 1080p, one full-frame layer, measured by lights_test.py — which
prints the whole table on every run, so a regression is one line in a hook rather
than a bug report six weeks later:

    ambient                 0.1 ms     no geometry at all; it is a 3-vector
    parallel               44   ms     N·L is ONE NUMBER, so this is the floor:
                                       the cost of touching a 1080p RGBA and
                                       clamping it, and nothing else
    point                  60   ms
    spot, hard edge        91   ms
    spot, feathered       124   ms     arccos, over the feather band only
    specular              +60-80 ms    an exp/log pass and a second (3,H,W) buffer
    each EXTRA point light +14 ms
    each (light, caster)   +12-25 ms

The shape of that is the thing to budget against: the FIRST light pays for the
frame and the tenth pays for a few (H, W) arrays. It is 40 ms plus 15 per light,
not 60 ms times lights. Three lights on a layer is ~90 ms, which sits beside the
181 ms engine.py already quotes for a 1080p precomp — real, affordable, and worth
turning off in draft, which is why `draft` drops the shadows.

Every number above is memory traffic rather than arithmetic, and the file is
shaped around that: see _Basis.toward, _accum and _assemble, each of which
carries the measurement that made it look the way it does.

────────────────────────────────────────────────────────────────────────────────
THE DOCUMENT

A light is a LAYER, for the same reasons a camera is one: it wants a position
that keyframes, a parent it can be rigged to, and a time window.

    { "id": "ly_key", "type": "light", "name": "key",
      "start": 0, "end": 8, "enabled": true,
      "transform": { "position": [960, 300, -700] },
      "light": { "kind": "point",          // ambient | point | spot | parallel
                 "color": [255, 244, 214], "intensity": 100,
                 "falloff": "none",        // none | smooth | inverseSquare
                 "radius": 500, "falloffDistance": 500,
                 "coneAngle": 90, "coneFeather": 50,
                 "pointOfInterest": [960, 540, 0],
                 "castsShadows": false, "shadowDarkness": 100,
                 "shadowDiffusion": 0 } }

`kind`, not `type`: `type` is already spoken for by the layer. The lens-shaped
fields live under "light" for the same reason a camera's live under "camera".

A layer answers with AE's material options, and the defaults are AE's:

    "material": { "acceptsLights": true, "ambient": 100, "diffuse": 50,
                  "specular": 50, "shininess": 5,
                  "castsShadows": false, "acceptsShadows": true }

`diffuse: 50` is AE's default and it is why one point light at 100 does not make
a white layer white — half the surface answers to directional light and the other
half is waiting for an ambient. Raising the default would be friendlier and
wrong; someone matching an AE comp would find every layer twice as bright.

    python lights.py catalog     # what MCP and the UI are served

numpy / cv2. interp.py when it is there, for keyframes and expressions; without
it every property reads as a constant and a frame still comes out.
"""
from __future__ import annotations

import json
import math
import os
import sys

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))

try:
    from . import interp
except ImportError:                                    # run as a bare script
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    try:
        import interp  # type: ignore
    except Exception:                                  # noqa: BLE001
        interp = None                                  # type: ignore


EPS = 1e-9
_EPS32 = np.float32(1e-6)

MAX_LIGHTS = 16          # a runaway document must not be able to eat the box
MAX_CASTERS = 8          # every extra caster is one warpPerspective per light

# Shininess 0..100 -> a Blinn-Phong exponent. Linear, because the control is a
# look dial and a person turning it wants the highlight to tighten evenly, not
# to do nothing for sixty units and then snap. Exported so the test can predict
# a highlight instead of eyeballing one.
SPEC_EXP_MIN, SPEC_EXP_MAX = 2.0, 128.0

KINDS = ["ambient", "point", "spot", "parallel"]
FALLOFFS = ["none", "smooth", "inverseSquare"]


def spec_exponent(shininess):
    s = min(100.0, max(0.0, _f(shininess, 5.0)))
    return SPEC_EXP_MIN + (SPEC_EXP_MAX - SPEC_EXP_MIN) * (s / 100.0)


# ---------------------------------------------------------------------------
# the catalog — one dict, the shape effects.py uses, because MCP and the UI are
# both built from it verbatim and a second shape would mean a second reader
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Light", "Material"]


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
    """Colours are 0-255 RGB, the units the comp document already stores."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": animatable, "desc": desc}


def vec3(default, desc, lo=-1000000, hi=1000000, unit="px"):
    return {"type": "vec3", "default": list(default), "min": lo, "max": hi,
            "animatable": True, "unit": unit, "desc": desc}


def entry(name, label, group, why, params, limits=(), **extra):
    e = {"label": label, "group": group, "why": why, "params": params,
         "limits": list(limits)}
    e.update(extra)
    CATALOG[name] = e
    return e


_COLOUR = {
    "color": col([255, 255, 255], "the light's colour; multiplies the surface"),
    "intensity": num(100, -1000, 1000, "percent; 100 is full. Negative SUBTRACTS "
                                       "light, which is how AE does a shadow you "
                                       "place by hand", unit="%"),
}

_SHADOW = {
    "castsShadows": flag(False, "off by default, as in AE — a shadow costs one "
                                "projective warp per casting layer"),
    "shadowDarkness": num(100, 0, 100, "how much light the umbra loses; 0 is no "
                                       "shadow at all", unit="%"),
    "shadowDiffusion": num(0, 0, 200, "blur on the shadow, in comp px. A LOOK "
                                      "control: the blur is uniform, where a real "
                                      "penumbra widens with distance from the "
                                      "caster", unit="px"),
}

_FALLOFF = {
    "falloff": pick(FALLOFFS, "none", "none holds its intensity forever; smooth "
                                      "ramps to nothing across falloffDistance; "
                                      "inverseSquare is the physical law, clamped "
                                      "to 1 inside radius"),
    "radius": num(500, 0, 1000000, "where falloff starts. Under inverseSquare the "
                                   "intensity is exact at this distance and halves "
                                   "at radius*sqrt(2)", unit="px"),
    "falloffDistance": num(500, 0, 1000000, "smooth falloff only: how far it takes "
                                            "to reach zero past radius", unit="px"),
}


def _p(*dicts):
    out = {}
    for d in dicts:
        out.update(d)
    return out


entry("ambient", "Ambient Light", "Light",
      "A flat term with no position and no direction — the light that is simply "
      "there. It is the only thing that lifts the side of a layer no other light "
      "reaches, which is why a comp lit by one point light looks like a crime "
      "scene until you add one.",
      _p(_COLOUR),
      limits=["casts no shadow and receives no falloff — it has no position to "
              "measure either from",
              "scales by the layer's `ambient` material option, not `diffuse`"])

entry("point", "Point Light", "Light",
      "A bare bulb: light in every direction from one place. Position and falloff "
      "are the whole of it, and falloff is what stops a point light reading as a "
      "flat wash — with `none` it is the same brightness a mile away.",
      _p(_COLOUR, _FALLOFF, _SHADOW),
      limits=["the source is a POINT, so its shadows are hard-edged; "
              "shadowDiffusion softens them but does not simulate a bulb's size"])

entry("spot", "Spot Light", "Light",
      "A cone aimed at a point of interest — the stage light, the torch, the "
      "shaft through a window. coneAngle is the FULL angle and coneFeather eats "
      "inward from its edge, so the edge itself lands exactly where the angle "
      "says however soft you make it.",
      _p(_COLOUR, _FALLOFF, _SHADOW,
         {"pointOfInterest": vec3([0, 0, 0], "where the cone is aimed, in comp px. "
                                             "Defaults to the comp centre at z=0"),
          "coneAngle": num(90, 0, 180, "the FULL cone, degrees. 0 emits nothing; "
                                       "180 is a hemisphere", unit="deg"),
          "coneFeather": num(50, 0, 100, "percent of the half-angle the edge fades "
                                         "across, measured inward", unit="%")}),
      limits=["the cone is a hard geometric test on the angle; there is no "
              "projected gobo, no barn doors and no volumetric beam in the air",
              "coneAngle 0 is black rather than a pinpoint — a zero cone has zero "
              "solid angle and that is the arithmetic, not a guard"])

entry("parallel", "Parallel Light", "Light",
      "The sun: one direction everywhere, no falloff and no position that matters "
      "to the shading. Aim it by moving its point of interest. It is also the "
      "cheapest light here by a wide margin — N·L is one number for a whole "
      "layer, so it costs a multiply rather than a field.",
      _p(_COLOUR, _SHADOW,
         {"pointOfInterest": vec3([0, 0, 0], "the light travels from its position "
                                             "toward this point; only the "
                                             "DIRECTION is used")}),
      limits=["no falloff, by definition — moving it twice as far away changes "
              "nothing, and `radius` is ignored",
              "its shadows never converge or spread; a caster's shadow is the "
              "caster's own size, offset"])

entry("material", "Material Options", "Material",
      "What a 3D layer does with the light that reaches it — AE's material "
      "options, on the layer rather than on the light. `acceptsLights: false` is "
      "the escape hatch and it is bit-exact: the layer comes back untouched, the "
      "same array object, so a title card can sit in a lit scene at the "
      "brightness it was authored at.",
      {"acceptsLights": flag(True, "off returns the layer's own pixels, unchanged"),
       "ambient": num(100, 0, 100, "how much of the ambient lights this surface "
                                   "answers to", unit="%"),
       "diffuse": num(50, 0, 100, "how much of the directional light it answers "
                                  "to. AE's default is 50 and this matches it — "
                                  "one point light at 100 will NOT make a white "
                                  "layer white", unit="%"),
       "specular": num(50, 0, 100, "strength of the highlight, which takes the "
                                   "LIGHT's colour and adds rather than "
                                   "multiplies", unit="%"),
       "shininess": num(5, 0, 100, "tightness of that highlight; maps linearly to "
                                   "a Blinn-Phong exponent of 2..128", unit="%"),
       "castsShadows": flag(False, "this layer's alpha is projected onto the "
                                   "layers that accept shadows"),
       "acceptsShadows": flag(True, "shadows may be drawn onto this layer")},
      limits=["no `metal` — AE mixes the highlight's colour toward the surface's "
              "and this does not; the highlight is always the light's colour",
              "no environment or reflection term of any kind",
              "materials only mean anything on a layer with threeD: true"])


LIMITS = [
    "Lights only affect layers with threeD: true. A 2D layer, an adjustment "
    "layer and the comp background are untouched — there is no surface there to "
    "have a normal.",
    "Every layer is a flat plane, so its normal is constant across it. There is "
    "no bump, normal or displacement input, and none of the material options "
    "vary per pixel.",
    "Shading is computed at the frame's time even under motion blur, so a light "
    "that moves fast does not smear; the layer under it does.",
    "Shadows are plane-onto-plane only, and are skipped entirely in draft.",
    "The result is clipped to 0..1 at the layer, which is the engine's pixel "
    "contract. A deliberately over-driven light clips here rather than carrying "
    "highlights into the composite.",
]


def catalog():
    """What MCP and /api/vfx/catalog serve."""
    return {"lights": CATALOG, "groups": GROUP_ORDER, "names": sorted(CATALOG),
            "kinds": list(KINDS), "falloffs": list(FALLOFFS), "limits": list(LIMITS)}


# ---------------------------------------------------------------------------
# reading the document
# ---------------------------------------------------------------------------

def _f(v, fallback=0.0):
    """A finite scalar out of anything a document might hold."""
    if isinstance(v, (list, tuple)):
        v = v[0] if v else fallback
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float(fallback)
    return f if math.isfinite(f) else float(fallback)


def _triple(v, fallback=(0.0, 0.0, 0.0)):
    """An [x, y, z] out of a value that may only have written [x, y]."""
    if isinstance(v, (list, tuple)):
        out = [_f(x, fallback[i] if i < 3 else 0.0) for i, x in enumerate(list(v)[:3])]
        while len(out) < 3:
            out.append(float(fallback[len(out)]))
        return np.array(out, dtype=np.float64)
    if isinstance(v, (int, float)):
        return np.array([_f(v, fallback[0]), fallback[1], fallback[2]], dtype=np.float64)
    return np.array(fallback, dtype=np.float64)


def _rgb01(color, fallback=(1.0, 1.0, 1.0)):
    """A [r,g,b] 0-255 document colour as float 0..1. Alpha, if present, ignored:
    a light has no coverage."""
    if not isinstance(color, (list, tuple)) or len(color) < 3:
        return np.array(fallback, dtype=np.float32)
    vals = [min(1.0, max(0.0, _f(c, 255.0) / 255.0)) for c in list(color)[:3]]
    return np.array(vals, dtype=np.float32)


def _eval(prop, t, default=None, ctx=None):
    """interp's evaluator when there is one, with one guard of our own in front.

    A NaN constant comes back out of interp as 0. That is a fine answer for a
    position and a terrible one for an intensity: the light silently goes out and
    the frame renders black with nothing to look at. A number nobody could have
    meant reads as UNSET here, not as zero. Without interp every property is its
    own constant — a comp still renders, it just stops animating, which is the
    same bargain engine.py strikes with effects.py and shapes.py."""
    if isinstance(prop, (int, float)) and not isinstance(prop, bool) \
            and not math.isfinite(prop):
        return default
    if interp is not None:
        return interp.eval_prop(prop, t, default, ctx)
    if isinstance(prop, dict):
        if "value" in prop:
            return prop["value"]
        keys = prop.get("keys")
        if isinstance(keys, list) and keys:
            return keys[0].get("v", default)
        return default
    return default if prop is None else prop


def _norm(v):
    n = float(np.linalg.norm(v))
    return (v / n) if n > EPS else None


class Light:
    """One resolved light at one instant. Everything is world space and finite.

    Resolved rather than a live view of the document because a rig is read once
    per frame and then read again by every layer in it: forty layers must not
    mean forty evaluations of the same keyframe track.
    """

    __slots__ = ("kind", "color", "intensity", "pos", "axis",
                 "falloff", "radius", "falloff_distance",
                 "cone_angle", "cone_feather",
                 "casts", "darkness", "diffusion", "name")

    def __init__(self, kind, color, intensity, pos, axis, falloff, radius,
                 falloff_distance, cone_angle, cone_feather, casts, darkness,
                 diffusion, name=""):
        self.kind = kind
        self.color = color
        self.intensity = intensity
        self.pos = pos
        self.axis = axis
        self.falloff = falloff
        self.radius = radius
        self.falloff_distance = falloff_distance
        self.cone_angle = cone_angle
        self.cone_feather = cone_feather
        self.casts = casts
        self.darkness = darkness
        self.diffusion = diffusion
        self.name = name

    @property
    def rgb(self):
        """Colour times intensity — the number that actually multiplies pixels."""
        return self.color * np.float32(self.intensity / 100.0)


class Rig:
    """Every light in one comp at one instant, plus what the shadows need.

    `casters` is assignable after the fact on purpose: collecting them means
    rendering other layers' bitmaps, which only the engine can do, and lighting
    has to be shippable before shadows are wired.
    """

    __slots__ = ("lights", "t", "bind", "casters", "comp_size")

    def __init__(self, lights, t=0.0, bind=None, comp_size=(1920, 1080)):
        self.lights = lights
        self.t = float(t)
        self.bind = bind
        self.casters = []
        self.comp_size = comp_size

    def __len__(self):
        return len(self.lights)

    @property
    def directional(self):
        return [l for l in self.lights if l.kind != "ambient"]


class Caster:
    """A layer that throws a shadow: its alpha, its plane, and who it is.

    Alpha only — a shadow has no colour here, so carrying the RGB would be three
    quarters of a 1080p float32 buffer per casting layer for nothing.
    """

    __slots__ = ("alpha", "m4", "scale", "key")

    def __init__(self, alpha, m4, scale=1.0, key=None):
        self.alpha = alpha
        self.m4 = np.asarray(m4, dtype=np.float64)
        self.scale = float(scale)
        self.key = key


def material(layer, t=0.0, bind=None):
    """A layer's material options, defaulted and clamped. Public because the
    engine needs `castsShadows` to decide what to rasterise, and because a test
    that has to guess at defaults is testing its own guess."""
    src = layer.get("material") if isinstance(layer, dict) else None
    src = src if isinstance(src, dict) else {}

    def b(name):
        return bind(layer, "material." + name) if bind is not None else None

    def n(name, default):
        return min(100.0, max(0.0, _f(_eval(src.get(name), t, default, b(name)), default)))

    return {
        "acceptsLights": src.get("acceptsLights", True) is not False,
        "ambient": n("ambient", 100.0),
        "diffuse": n("diffuse", 50.0),
        "specular": n("specular", 50.0),
        "shininess": n("shininess", 5.0),
        "castsShadows": bool(src.get("castsShadows", False)),
        "acceptsShadows": src.get("acceptsShadows", True) is not False,
    }


def _one_light(layer, t, comp_size, parent_of=None, bind=None):
    cw, ch = comp_size
    spec = layer.get("light") if isinstance(layer.get("light"), dict) else {}
    transform = layer.get("transform") if isinstance(layer.get("transform"), dict) else {}

    def b(path):
        return bind(layer, path) if bind is not None else None

    kind = str(_eval(spec.get("kind"), t, "point", b("light.kind")) or "point")
    if kind not in KINDS:
        kind = "point"

    # A light with no position of its own sits where the default camera does, so
    # "add a light, see something" holds without anyone typing a z. A light at
    # z=0 would be IN the plane of an untouched 3D layer and light nothing.
    home = (cw / 2.0, ch / 2.0, -cw * 50.0 / 36.0)
    pos = _triple(_eval(transform.get("position"), t, None, b("transform.position")), home)
    poi = _triple(_eval(spec.get("pointOfInterest"), t, None, b("light.pointOfInterest")),
                  (cw / 2.0, ch / 2.0, 0.0))

    # Parented exactly the way camera_from parents a camera — a light rigged to a
    # null is how anyone animates one, and its target has to ride the same chain
    # or aiming the rig would swing the beam off the subject.
    pm = parent_of(layer) if parent_of is not None else None
    if pm is not None:
        pm = np.asarray(pm, dtype=np.float64)
        if pm.shape == (4, 4) and np.isfinite(pm).all():
            pos = (pm @ np.append(pos, 1.0))[:3]
            poi = (pm @ np.append(poi, 1.0))[:3]

    axis = _norm(poi - pos)
    if axis is None:
        # Aimed at itself. Down +z is the one direction that lights an untouched
        # 3D layer, so it is the least surprising answer to a degenerate aim.
        axis = np.array([0.0, 0.0, 1.0])

    falloff = str(_eval(spec.get("falloff"), t, "none", b("light.falloff")) or "none")
    if falloff not in FALLOFFS:
        falloff = "none"

    return Light(
        kind=kind,
        color=_rgb01(_eval(spec.get("color"), t, None, b("light.color")), (1.0, 1.0, 1.0)),
        intensity=_f(_eval(spec.get("intensity"), t, 100.0, b("light.intensity")), 100.0),
        pos=pos, axis=axis,
        falloff=falloff,
        radius=max(0.0, _f(_eval(spec.get("radius"), t, 500.0, b("light.radius")), 500.0)),
        falloff_distance=max(0.0, _f(_eval(spec.get("falloffDistance"), t, 500.0,
                                           b("light.falloffDistance")), 500.0)),
        cone_angle=min(180.0, max(0.0, _f(_eval(spec.get("coneAngle"), t, 90.0,
                                                b("light.coneAngle")), 90.0))),
        cone_feather=min(100.0, max(0.0, _f(_eval(spec.get("coneFeather"), t, 50.0,
                                                  b("light.coneFeather")), 50.0))),
        casts=bool(spec.get("castsShadows", False)) and kind != "ambient",
        darkness=min(100.0, max(0.0, _f(_eval(spec.get("shadowDarkness"), t, 100.0,
                                              b("light.shadowDarkness")), 100.0))),
        diffusion=min(200.0, max(0.0, _f(_eval(spec.get("shadowDiffusion"), t, 0.0,
                                               b("light.shadowDiffusion")), 0.0))),
        name=str(layer.get("name") or ""),
    )


def rig(layers, t, comp=None, visible=None, parent_of=None, bind=None):
    """Every light layer in a comp, resolved at t. None when there are none.

    None rather than an empty Rig because None is what the call site tests, and a
    comp of 2D layers must not pay for an object it will hand straight back.

    `visible(layer) -> bool` is the engine's own switch/solo rule; without it a
    light is on unless `enabled` is false. Solo is deliberately not guessed at
    here — whether soloing a card should black out the scene is the engine's
    ruling, not this module's.
    """
    if not isinstance(layers, (list, tuple)):
        return None
    comp = comp if isinstance(comp, dict) else {}
    cw = max(1, int(_f(comp.get("width"), 1920)))
    ch = max(1, int(_f(comp.get("height"), 1080)))
    duration = _f(comp.get("duration"), 0.0)
    t = _f(t, 0.0)

    out = []
    for lay in layers:
        if not isinstance(lay, dict) or str(lay.get("type") or "") != "light":
            continue
        if visible is not None:
            if not visible(lay):
                continue
        elif lay.get("enabled", True) is False:
            continue
        start = _f(lay.get("start"), 0.0)
        end = _f(lay.get("end"), duration)
        if end > start and not (start - 1e-6 <= t < end - 1e-6):
            continue
        out.append(_one_light(lay, t, (cw, ch), parent_of, bind))
        if len(out) >= MAX_LIGHTS:
            break
    if not out:
        return None
    return Rig(out, t=t, bind=bind, comp_size=(cw, ch))


def collect_casters(layers, bitmap_of, t=0.0, bind=None, limit=MAX_CASTERS):
    """The shadow casters in a comp, as Casters.

    `bitmap_of(layer) -> (rgba_or_alpha, m4, scale) | None` is the engine's, and
    it has to be: getting a layer's own bitmap means the source, the effects and
    the masks, and none of that is this module's business. Anything falsy is
    skipped, so a caster that fails to rasterise costs a shadow and not a frame.
    """
    out = []
    for lay in (layers or []):
        if not isinstance(lay, dict) or not lay.get("threeD"):
            continue
        if not material(lay, t, bind)["castsShadows"]:
            continue
        try:
            got = bitmap_of(lay)
        except Exception:                              # noqa: BLE001
            got = None
        if not got:
            continue
        px, m4, scale = (list(got) + [1.0])[:3]
        c = caster(px, m4, scale, key=lay.get("id") or id(lay))
        if c is not None:
            out.append(c)
        if len(out) >= limit:
            break
    return out


def caster(rgba, m4, scale=1.0, key=None):
    """A Caster from a layer's bitmap — (H,W,4) rgba or a bare (H,W) alpha."""
    a = np.asarray(rgba)
    if a.ndim == 3 and a.shape[2] == 4:
        a = a[..., 3]
    elif a.ndim != 2:
        return None
    a = np.ascontiguousarray(a, dtype=np.float32)
    if a.size == 0:
        return None
    m = np.asarray(m4, dtype=np.float64)
    if m.shape != (4, 4) or not np.isfinite(m).all():
        return None
    s = _f(scale, 1.0)
    if s <= 0.0:
        return None
    return Caster(a, m, s, key)


# ---------------------------------------------------------------------------
# the plane, and why none of this needs an (H, W, 3) array
# ---------------------------------------------------------------------------

class _Basis:
    """One layer's plane, plus the separable algebra the whole model rides on.

    A layer's world point is P(u, v) = C + u·Ex + v·Ey with u, v in LAYER pixels
    measured from the layer's centre. That is AFFINE, and the consequence is the
    reason this file is fast: for any fixed vector a,

        a·(P − C) = u(a·Ex) + v(a·Ey)

    is an outer SUM of two 1-D arrays — one (H, W) allocation and one pass, never
    a vector field. Everything Blinn-Phong wants is built out of that and one
    other fact: N is perpendicular to Ex and Ey by construction, so N·(P − C) is
    identically ZERO and every N·(something) collapses to a scalar.

        EVERYTHING IS RELATIVE TO THE LAYER'S CENTRE, and that is not tidiness. A
    1080p comp puts its layers around (960, 540), so |P|² is about 1.2e6 while a
    light 200px away contributes 4e4 — and |D|² = |L|² − 2L·P + |P|² then computes
    a small number by cancelling two large ones. float32 spacing at 1.2e6 is 0.12,
    which lands in the third digit of the answer. Shifting the origin onto the
    plane's own centre makes both terms the same size as the distances actually
    being measured, and takes the error from ~1e-4 to ~1e-6 — the difference
    between a test that can assert Lambert's law and one that can only nod at it.

    The cross term Ex·Ey is zero for every layer this engine can build (Ex and Ey
    are a rotation applied to two axis-aligned vectors), but it is carried anyway
    — a sheared matrix arriving from somewhere would otherwise be wrong in a way
    nothing would ever catch.
    """

    __slots__ = ("C", "Ex", "Ey", "N", "u", "v", "h", "w", "cross", "ex2", "ey2", "ok")

    def __init__(self, m4, h, w, scale, camera=None):
        m = np.asarray(m4, dtype=np.float64)
        self.ok = m.shape == (4, 4) and bool(np.isfinite(m).all())
        self.h, self.w = int(h), int(w)
        if not self.ok:
            return
        self.Ex = m[:3, 0].astype(np.float64)
        self.Ey = m[:3, 1].astype(np.float64)
        n = np.cross(self.Ex, self.Ey)
        nn = float(np.linalg.norm(n))
        if nn < 1e-12:
            # An edge-on or collapsed layer has no normal to speak of. _warp3
            # refuses to draw it at all, so anything here is arbitrary; -z at
            # least keeps the arithmetic finite instead of dividing by nothing.
            self.N = np.array([0.0, 0.0, -1.0])
            self.ok = False
        else:
            self.N = n / nn
        s = max(float(scale), 1e-6)
        uc, vc = 0.5 * self.w / s, 0.5 * self.h / s
        self.C = m[:3, 3].astype(np.float64) + uc * self.Ex + vc * self.Ey
        if camera is not None and self.ok:
            cp = np.asarray(getattr(camera, "pos", (0.0, 0.0, -1000.0)), dtype=np.float64)
            # C is ON the plane, so N·(cam − C) is the whole test — and because
            # N·P is constant over a plane it is one sign for every pixel, not a
            # per-pixel guess. That is what makes two-sidedness exact here.
            if cp.size == 3 and np.isfinite(cp).all() and float(self.N @ (cp - self.C)) < 0.0:
                self.N = -self.N
        self.u = (np.arange(self.w, dtype=np.float64) + 0.5) / s - uc
        self.v = (np.arange(self.h, dtype=np.float64) + 0.5) / s - vc
        self.cross = float(self.Ex @ self.Ey)
        self.ex2, self.ey2 = float(self.Ex @ self.Ex), float(self.Ey @ self.Ey)

    def rel(self, world_pt):
        """A world point in the plane-centred frame everything below works in."""
        return np.asarray(world_pt, dtype=np.float64) - self.C

    def dot(self, a):
        """a·(P − C) over the grid, (H, W) float32 — two broadcasts, no field."""
        a = np.asarray(a, dtype=np.float64)
        row = (self.u * float(a @ self.Ex)).astype(np.float32)
        colv = (self.v * float(a @ self.Ey)).astype(np.float32)
        return row[None, :] + colv[:, None]

    def toward(self, q):
        """(N·D as a SCALAR, |D| as (H, W)) for D = q − (P − C), q already relative.

        N·D is a scalar and not a field, and that is not a micro-optimisation — it
        is the same fact that makes two-sidedness exact. N is perpendicular to Ex
        and Ey by construction, so N·(P − C) is identically zero over the whole
        plane and N·D collapses to N·q. A 1080p (H, W) array disappears with it,
        and so do the two passes that would have built it.

        |D|² is ONE broadcast add rather than three fields composed together:

            |D|² = [|q|² − 2u(q·Ex) + u²|Ex|²] + [−2v(q·Ey) + v²|Ey|²] + 2uv(Ex·Ey)

        which is the whole reason a point light here costs what it does. Writing
        it as |q|² − 2 q·P + |P|² and evaluating each term is the same arithmetic
        and four times the memory traffic.
        """
        q = np.asarray(q, dtype=np.float64)
        fu = float(q @ q) - 2.0 * self.u * float(q @ self.Ex) + self.u * self.u * self.ex2
        gv = -2.0 * self.v * float(q @ self.Ey) + self.v * self.v * self.ey2
        d2 = fu.astype(np.float32)[None, :] + gv.astype(np.float32)[:, None]
        if abs(self.cross) > 1e-12:
            d2 += (2.0 * self.cross * np.outer(self.v, self.u)).astype(np.float32)
        np.maximum(d2, _EPS32, out=d2)
        return float(self.N @ q), np.sqrt(d2, out=d2)


# ---------------------------------------------------------------------------
# falloff, cone
# ---------------------------------------------------------------------------

def _falloff(dist, light):
    """Attenuation over the grid. `None` means "one, everywhere" — the caller
    skips the multiply entirely rather than allocating a field of ones."""
    if light.falloff == "none":
        return None
    if light.falloff == "inverseSquare":
        # Clamped at 1 inside the radius: the unclamped law goes to infinity at
        # the source and one pixel of a layer touching a light would blow the
        # whole frame out. Exactly 1 at radius, exactly 1/2 at radius*sqrt(2).
        r2 = np.float32(light.radius * light.radius)
        out = r2 / np.maximum(dist * dist, _EPS32)
        return np.minimum(out, np.float32(1.0), out=out)
    fd = light.falloff_distance
    if fd <= 0.0:
        # No distance to ramp across is a hard cut at the radius, which is what
        # "reach zero in zero pixels" has to mean.
        return (dist <= np.float32(light.radius)).astype(np.float32)
    x = np.clip((dist - np.float32(light.radius)) / np.float32(fd), 0.0, 1.0)
    return (1.0 - x * x * (3.0 - 2.0 * x)).astype(np.float32)


def _cone(basis, light, lpos, dist):
    """A spot's cone over the grid, 1 inside and 0 outside. `lpos` is the light in
    the plane-relative frame.

    cos of the angle off the axis is (A·P − A·L)/|P − L| — separable again, so
    the hard-edged case never calls a trig function at all. The feathered case
    calls arccos only on the pixels actually IN the band, which on a real spot is
    a thin ring rather than a frame: measuring the feather in ANGLE rather than in
    cosine is what makes "50% feather" mean half the half-angle, which is what the
    control says and what a person setting it expects.
    """
    if light.cone_angle <= 0.0:
        # A zero cone has zero solid angle. Falling through would light exactly
        # the one pixel dead on the axis, where cos is 1 and the >= test passes —
        # a single bright dot that reads as a bug and disagrees with the catalog.
        return np.zeros((basis.h, basis.w), dtype=np.float32)
    half = math.radians(light.cone_angle * 0.5)
    cos_t = (basis.dot(light.axis) - np.float32(float(light.axis @ lpos))) / dist
    np.clip(cos_t, -1.0, 1.0, out=cos_t)
    outer = math.cos(half)
    inner_a = half * (1.0 - light.cone_feather / 100.0)
    if light.cone_feather <= 0.0 or half - inner_a < 1e-9:
        return (cos_t >= np.float32(outer)).astype(np.float32)
    inner = math.cos(inner_a)
    out = (cos_t >= np.float32(inner)).astype(np.float32)
    band = (cos_t < np.float32(inner)) & (cos_t > np.float32(outer))
    if band.any():
        th = np.arccos(cos_t[band].astype(np.float64))
        x = np.clip((half - th) / (half - inner_a), 0.0, 1.0)
        out[band] = (x * x * (3.0 - 2.0 * x)).astype(np.float32)
    return out


# ---------------------------------------------------------------------------
# shadows: a plane onto a plane is a homography, and that is the whole trick
# ---------------------------------------------------------------------------

def _shadow_maps(basis, light, cast, scale):
    """(H, W) occlusion for one (light, caster) pair on the receiver's grid, or
    None when the pair cannot cast. 1 means fully blocked.

    The derivation, because it is not obvious and a sign wrong here produces a
    shadow that looks plausible from exactly one angle. Everything is in the
    receiver plane's frame, so P below means P − C:

      receiver point   P(u,v) = u·Exr + v·Eyr
      caster plane     n·X = d,  n = Exc × Eyc,  d = n·Oc
      point light      X = L + s(P − L),  s = (d − n·L) / (n·P − n·L)
      parallel light   X = P − s·Â,       s = (n·P − d) / (n·Â)

    In both, the denominator is affine in (u,v), so s is a ratio of affine
    functions — and the caster-local coordinates of X, got by hitting X − Oc with
    the pseudo-inverse of [Exc | Eyc], are ratios of affine functions too. Affine
    over affine IS a homography, which is why cv2 can then do the rest exactly
    rather than approximately.

    The `s` field is not thrown away: 0 < s < 1 for a point light is precisely
    "the caster is BETWEEN the light and this pixel", and s > 0 for a parallel one
    is "the caster is on the light's side". Without it a caster would shadow the
    things in FRONT of it as cheerfully as the things behind.
    """
    n = np.cross(cast.m4[:3, 0], cast.m4[:3, 1])
    nn = float(np.linalg.norm(n))
    if nn < 1e-12:
        return None                                    # a collapsed caster casts nothing
    n = n / nn
    Oc = basis.rel(cast.m4[:3, 3])
    d = float(n @ Oc)
    try:
        pinv = np.linalg.pinv(np.column_stack([cast.m4[:3, 0], cast.m4[:3, 1]]))
    except np.linalg.LinAlgError:
        return None                                    # 2x3: X − Oc -> caster layer px
    if not np.isfinite(pinv).all():
        return None

    def aff(a):
        """The row R with R·[u, v, 1] = a·P. The constant is zero because the
        frame is centred on the plane — one more thing the rebase buys."""
        return np.array([float(a @ basis.Ex), float(a @ basis.Ey), 0.0], dtype=np.float64)

    if light.kind == "parallel":
        A = light.axis                                 # travels FROM the light along A
        den = float(n @ A)
        if abs(den) < 1e-9:
            return None                                # caster plane parallel to the ray
        srow = (aff(n) - np.array([0.0, 0.0, d])) / den
        rows = []
        for i in range(2):
            base = aff(pinv[i]) - np.array([0.0, 0.0, float(pinv[i] @ Oc)])
            rows.append(base - float(pinv[i] @ A) * srow)
        H = np.array([rows[0], rows[1], [0.0, 0.0, 1.0]], dtype=np.float64)
        s_field = _affine_field(basis, srow)
        valid = s_field > np.float32(0.0)
    else:
        L = basis.rel(light.pos)
        k = d - float(n @ L)
        if abs(k) < 1e-9:
            return None                                # the light lies in the caster's plane
        grow = aff(n) - np.array([0.0, 0.0, float(n @ L)])
        rows = []
        for i in range(2):
            rows.append(float(pinv[i] @ (L - Oc)) * grow
                        + k * (aff(pinv[i]) - np.array([0.0, 0.0, float(pinv[i] @ L)])))
        H = np.array([rows[0], rows[1], grow], dtype=np.float64)
        g = _affine_field(basis, grow)
        with np.errstate(divide="ignore", invalid="ignore"):
            s_field = np.float32(k) / np.where(np.abs(g) < _EPS32, np.float32(np.nan), g)
        valid = (s_field > np.float32(0.0)) & (s_field < np.float32(1.0))

    if not valid.any():
        return None

    # [u,v,1] <- receiver bitmap px, and caster layer px -> caster bitmap px.
    # The receiver's u is centre-relative, so the offset carries the half-size.
    s_r = max(float(scale), 1e-6)
    S = np.array([[1.0 / s_r, 0.0, (0.5 - 0.5 * basis.w) / s_r],
                  [0.0, 1.0 / s_r, (0.5 - 0.5 * basis.h) / s_r],
                  [0.0, 0.0, 1.0]])
    Kc = np.array([[cast.scale, 0.0, -0.5], [0.0, cast.scale, -0.5], [0.0, 0.0, 1.0]])
    Hpix = Kc @ H @ S
    if not np.isfinite(Hpix).all() or abs(float(np.linalg.det(Hpix))) < 1e-18:
        return None

    occ = cv2.warpPerspective(cast.alpha, Hpix, (basis.w, basis.h),
                              flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)
    occ = np.asarray(occ, dtype=np.float32)
    # A pixel whose ray misses, or whose homography went to infinity, contributes
    # nothing. Both in one sweep, because nan * False is still nan.
    np.copyto(occ, 0.0, where=~(valid & np.isfinite(occ)))
    if light.diffusion > 0.05:
        sigma = float(light.diffusion) * s_r
        if sigma > 0.05:
            occ = cv2.GaussianBlur(occ, (0, 0), sigmaX=min(120.0, sigma),
                                   borderType=cv2.BORDER_REPLICATE)
            occ = np.asarray(occ, dtype=np.float32)
    np.clip(occ, 0.0, 1.0, out=occ)
    return occ


def _affine_field(basis, row):
    """row·[u, v, 1] over the grid — the same outer sum _Basis.dot does, for the
    rows that are not a world vector dotted with P."""
    return ((row[0] * basis.u).astype(np.float32)[None, :]
            + (row[1] * basis.v).astype(np.float32)[:, None] + np.float32(row[2]))


def _transmittance(basis, light, casters, scale, self_key):
    """What fraction of this light reaches each pixel, or None for "all of it".

    Several casters COMPOUND rather than max: transmittances multiply, which is
    what a stack of translucent things actually does, and which agrees with max at
    the only place anyone ever checks — alpha = 1.
    """
    if not light.casts or not casters or light.darkness <= 0.0:
        return None
    dark = np.float32(light.darkness / 100.0)
    out = None
    for cast in casters:
        if cast is None or (self_key is not None and cast.key == self_key):
            continue                                   # a plane cannot shadow itself
        occ = _shadow_maps(basis, light, cast, scale)
        if occ is None:
            continue
        occ *= dark
        np.subtract(1.0, occ, out=occ)
        out = occ if out is None else out * occ
    return out


# ---------------------------------------------------------------------------
# the shading itself
# ---------------------------------------------------------------------------

def shade(rgba, m4, camera, rig, layer=None, scale=1.0, casters=None, draft=False):
    """Light one 3D layer's own bitmap. THE call the engine makes.

    Takes the layer's pixels after effects, masks and styles and BEFORE the
    perspective warp — the same place AE lights a layer, and the only place where
    the geometry is still a plane with a constant normal.

        rgba     float32 (H, W, 4), 0..1, straight alpha. Never written to.
        m4       the layer's 4x4, LAYER px -> world/comp px (world_matrix4)
        camera   anything with a `.pos` — used to face the normal and to place the
                 specular highlight. None means no highlight and no flip.
        rig      lights.rig(...) or None
        layer    the layer dict; only `material` is read from it
        scale    render scale — bitmap px per layer px
        casters  overrides rig.casters for this layer
        draft    skips shadows, which are the only expensive part

    Returns float32 (H, W, 4) with the alpha channel bit-identical, or the INPUT
    ARRAY ITSELF when there is nothing to do: no rig, no lights, acceptsLights
    off, or a matrix that is not a usable plane. That identity is the contract
    that makes wiring this in safe.
    """
    if rig is None or not isinstance(rgba, np.ndarray) or rgba.ndim != 3 \
            or rgba.shape[2] != 4 or rgba.size == 0:
        return rgba
    lights_ = getattr(rig, "lights", None)
    if not lights_:
        return rgba
    if rgba.dtype != np.float32:
        # 0..255 integers would run the whole model a hundred times too bright.
        # Refusing at the seam makes the mistake visible where it was made.
        if not np.issubdtype(rgba.dtype, np.floating):
            return rgba
        rgba = rgba.astype(np.float32)

    mat = material(layer if isinstance(layer, dict) else {},
                   getattr(rig, "t", 0.0), getattr(rig, "bind", None))
    if not mat["acceptsLights"]:
        return rgba

    h, w = rgba.shape[:2]
    basis = _Basis(m4, h, w, scale, camera)

    amb = np.zeros(3, dtype=np.float32)
    for l in lights_:
        if l.kind == "ambient":
            amb += l.rgb
    amb *= np.float32(mat["ambient"] / 100.0)

    directional = [l for l in lights_ if l.kind != "ambient"] if basis.ok else []
    kd = np.float32(mat["diffuse"] / 100.0)
    ks = np.float32(mat["specular"] / 100.0)
    want_spec = bool(ks > 0.0 and camera is not None)
    exp_n = spec_exponent(mat["shininess"])

    if not directional or (kd <= 0.0 and not want_spec):
        # Ambient only. A flat multiply — and when it lands on exactly 1.0, an
        # ambient light at 100 on a material at 100, the answer is the input
        # untouched. That is the property the tests pin, and it is why the
        # comparison is against 1.0 rather than against "close enough".
        if float(np.abs(amb - 1.0).max()) < 1e-12:
            return rgba
        return _assemble(rgba, amb, None, None)

    shade_casters = getattr(rig, "casters", ()) if casters is None else casters
    if draft:
        shade_casters = ()

    cam_rel = None
    if want_spec:
        cp = np.asarray(getattr(camera, "pos", None), dtype=np.float64)
        if cp.size == 3 and np.isfinite(cp).all():
            cam_rel = basis.rel(cp)
        else:
            want_spec = False

    ndotv = distv = None
    if want_spec:
        # toward() hands N·D back unnormalised on purpose — the diffuse term wants
        # to divide by a distance it needs anyway. The view side needs the same
        # divide and nothing else does it: forget it and N·H saturates at 1
        # everywhere, which reads as a perfectly plausible glossy layer.
        ndv, distv = basis.toward(cam_rel)
        ndotv = np.float32(ndv) / distv
        np.maximum(ndotv, 0.0, out=ndotv)

    self_key = (layer.get("id") or id(layer)) if isinstance(layer, dict) else None

    # `flat` is the part of the answer that is the same at every pixel — ambient,
    # and any parallel light with no shadow on it. It stays a 3-vector, and a comp
    # lit entirely by those never allocates a field at all. `field` appears the
    # moment one light actually varies across the layer, and not before.
    flat = amb.copy()
    field = None
    spec = None

    for l in directional:
        if abs(l.intensity) < 1e-9:
            continue                                   # a dead light must not cost a field
        rgb = l.rgb

        if l.kind == "parallel":
            # One direction everywhere, so N·L is ONE NUMBER for the whole layer.
            # Unshadowed, this light costs three floating-point adds total.
            ndl = float(-(basis.N @ l.axis))
            if ndl <= 0.0:
                continue                               # face turned away: no term at all
            lam = np.float32(ndl)
            trans = _shadowing(basis, l, shade_casters, scale, self_key)
            if kd > 0.0:
                add = rgb * (kd * lam)
                if trans is None:
                    flat += add
                else:
                    field = _accum(field, trans, add, h, w)
            if want_spec:
                # H = normalise(L̂ + V̂); N·H = (N·L̂ + N·V̂)/|L̂ + V̂| and
                # |L̂ + V̂| = sqrt(2 + 2 L̂·V̂) — still no vector field. L̂ = −Â.
                ldotv = (basis.dot(l.axis) - np.float32(float(l.axis @ cam_rel))) \
                    / np.maximum(distv, _EPS32)
                np.clip(ldotv, -1.0, 1.0, out=ldotv)
                ndoth = (lam + ndotv) / np.sqrt(np.maximum(2.0 + 2.0 * ldotv, _EPS32))
                spec = _add_spec(spec, ndoth, exp_n, rgb * ks, trans, h, w)
            continue

        trans = _shadowing(basis, l, shade_casters, scale, self_key)
        lpos = basis.rel(l.pos)
        ndl, dist = basis.toward(lpos)
        ndotl = np.float32(ndl) / dist
        np.maximum(ndotl, 0.0, out=ndotl)
        atten = _falloff(dist, l)
        if l.kind == "spot":
            cone = _cone(basis, l, lpos, dist)
            atten = cone if atten is None else atten * cone
        gate = atten
        if trans is not None:
            gate = trans if gate is None else gate * trans
        if kd > 0.0:
            field = _accum(field, ndotl if gate is None else ndotl * gate, rgb * kd, h, w)
        if want_spec:
            # (L−P)·(V−P) = (|L−P|² + |V−P|² − |L−V|²)/2, the law of cosines —
            # which turns a four-term separable expansion into three multiplies on
            # two fields that are already in hand.
            lv2 = float(np.sum((lpos - cam_rel) ** 2))
            ldotv = dist * dist
            ldotv += distv * distv
            ldotv -= np.float32(lv2)
            ldotv /= np.maximum(2.0 * dist * distv, _EPS32)
            np.clip(ldotv, -1.0, 1.0, out=ldotv)
            ndoth = (ndotl + ndotv) / np.sqrt(np.maximum(2.0 + 2.0 * ldotv, _EPS32))
            # Gated by the same attenuation the diffuse term paid, so a spot's
            # edge cuts the highlight too instead of leaving a bright ghost
            # hanging outside the cone; and by the raw cosine, so a face turned
            # away has no highlight however the maths of H works out.
            spec = _add_spec(spec, ndoth * (ndotl > 0.0), exp_n, rgb * ks,
                             gate, h, w)

    return _assemble(rgba, flat, field, spec)


def _shadowing(basis, light, casters, scale, self_key):
    return None if not casters else _transmittance(basis, light, casters, scale, self_key)


def _accum(field, lam, weight, h, w):
    """field += lam * weight, creating it on first use.

    The buffer is (3, H, W) and NOT (H, W, 3), which is worth four milliseconds a
    light and is the single largest thing measured in this file. `lam[..., None] *
    weight` builds a (H, W, 3) by broadcasting and costs 30 ms at 1080p; three
    contiguous (H, W) planes accumulated one at a time cost 6. numpy is very fast
    on a packed plane and very slow on a three-of-four stride, and every array
    here is shaped for that fact rather than for how the pixels will eventually
    be spelled.

    First use ASSIGNS rather than adding into zeros: one light is the common case,
    and it is worth not zeroing 24 MB we are about to overwrite.
    """
    if field is None:
        field = np.empty((3, h, w), dtype=np.float32)
        for c in range(3):
            np.multiply(lam, weight[c], out=field[c])
        return field
    for c in range(3):
        field[c] += lam * weight[c]
    return field


def _add_spec(spec, ndoth, exp_n, weight, gate, h, w):
    """One light's highlight, accumulated into the same (3, H, W) shape."""
    np.clip(ndoth, 0.0, 1.0, out=ndoth)
    # x**n as exp(n log x): half the cost of np.power at 1080p, and the one edge
    # it introduces lands right - log(0) is -inf and exp(-inf) is 0, which is the
    # answer a zero cosine wanted anyway.
    with np.errstate(divide="ignore"):
        np.log(ndoth, out=ndoth)
    ndoth *= np.float32(exp_n)
    np.exp(ndoth, out=ndoth)
    if gate is not None:
        ndoth *= gate
    if spec is None:
        spec = np.empty((3, h, w), dtype=np.float32)
        for c in range(3):
            np.multiply(ndoth, weight[c], out=spec[c])
        return spec
    for c in range(3):
        spec[c] += ndoth * weight[c]
    return spec


def _assemble(rgba, flat, field, spec):
    """Put the shaded colour back beside the untouched alpha.

    Per CHANNEL, on the layer's own buffer. A three-of-four slice (`out[..., :3]`)
    is the obvious way to write this and it is three times slower than four
    single-column passes - numpy strides a whole plane happily and a packed
    triple badly. Copying the RGBA first and never touching column 3 is also what
    makes "alpha comes back bit-identical" true by construction rather than by
    care.

    fmax/fmin rather than clip, because fmax(nan, 0) is 0: one pair of passes
    clamps to the engine's 0..1 contract AND sweeps the NaN clip would leave
    behind, where clip + isnan + copyto is four passes and a bool array. It runs
    on the colour only - a NaN that arrived in the alpha is not this module's to
    invent a value for.
    """
    out = rgba.copy()
    for c in range(3):
        v = out[..., c]
        if field is None:
            if flat[c] != 1.0:
                v *= flat[c]
        else:
            plane = field[c]
            if flat[c] != 0.0:
                plane += flat[c]
            v *= plane
        if spec is not None:
            v += spec[c]
        np.fmax(v, np.float32(0.0), out=v)
        np.fmin(v, np.float32(1.0), out=v)
    return out


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    else:
        print(json.dumps({"ok": False, "error": "unknown mode %s" % mode}))
        sys.exit(1)
