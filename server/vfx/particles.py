"""Closed-form particles - the compute behind the `particleSystem` effect.

THE DESIGN RULE, AND WHY IT IS NOT NEGOTIABLE. A particle's position at time t
is a CLOSED-FORM function of its birth state - nothing here steps a simulation
forward, nothing carries state from one frame to the next, and rendering frame
900 costs the same as rendering frame 2. That is what makes random access
O(particles) instead of O(frames): the scrub bar can land anywhere, the frame
cache can hold any subset, and two renders of the same comp are byte-identical
because there is no accumulated float drift to differ by. With drag k and a
constant acceleration a (gravity + wind), the ballistic form is

    p(age) = p0 + v0 * F(age) + a * G(age)
    F = (1 - e^(-k*age)) / k          G = (age - F) / k
    F -> age, G -> age^2 / 2 as k -> 0   (the plain ballistic limit)

Anyone tempted to bolt stepped state (collisions, flocking, history-dependent
anything) onto this module is tearing that property out; add a separate effect
instead and let it own its own cost.

WHAT FOLLOWS FROM IT - the refusals, each deliberate, all in docs/VFX.md too:

  * COLLISIONS / floor bounce: refused. A bounce makes position depend on the
    whole path, which is exactly the stepped state this design forbids.
  * TURBULENCE is procedural, not simulated: a per-particle sum of three
    sines over age (seeded phases, zeroed at birth so particles spawn on the
    emitter, not displaced off it). Honest wander, labelled
    "turbulence (procedural)" - it is NOT a fluid solve.
  * 3D particles, textured / layer-as-sprite particles, per-particle motion
    blur, sub-frame emission jitter beyond the birth-time model: out of v1.

DETERMINISM. Per-particle randomness is a counter-based splitmix64 hash of
(effect seed, particle index, channel salt) on uint64 arrays - never
np.random global state, never the clock. The particle index is the particle's
GLOBAL birth number since the layer's start, so particle 913 is the same
particle with the same fate at every t, in every process.

BIRTH TIMES. For a CONSTANT rate r the n-th particle is born at
t0 + (n + 0.5)/r - uniform spacing. For an ANIMATED rate the rate curve is
integrated: sampled on a grid ANCHORED at the layer start (t0 + k*step with a
fixed step - anchoring matters: a grid derived from the current t would give
every frame a slightly different integral and the births would shimmer),
trapezoid-cumsummed, and inverted with np.interp so birth n is where the
cumulative count crosses n + 0.5. Emitter position, direction, physics and
the per-particle look are all sampled AT BIRTH TIME from the same grid -
which is why the engine hands `ctx["paramsAt"]` (this effect's params,
evaluable at any time, expressions included) and `ctx["fxParams"]` (the raw
document dict, so the no-keyframes case can skip curve sampling entirely).
Physics params (gravity, wind, drag) are frozen per particle at birth -
that is what keeps the form closed while still letting them be keyframed.

CAPS. MAX_PARTICLES live particles per frame, and MAX_SPLAT total splatted
kernel pixels. Over either cap, particles are thinned by a seeded
per-particle lottery (stable per particle; preserves the age distribution,
unlike dropping the oldest). Draft renders keep DRAFT_KEEP of the particles -
that is what draft is for - and stay deterministic. Every thinning is
reported through ctx["notes"].

RENDERING. Soft round sprites, (1 - d^2/r^2)^2 falloff (gaussian-ish, compact
support - no clipped-tail seam), splatted premultiplied and planar: particles
are bucketed by integer kernel extent, each bucket evaluates its kernels in
one (N, k, k) vectorised block against the TRUE float radius (so size still
varies continuously inside a bucket), and everything lands in four
np.bincount accumulations - never a per-pixel python loop, never np.add.at.
Sub-pixel positions go into the kernel evaluation itself, so slow motion
does not snap to the pixel grid. Colours are 0-255 in the document, as
everywhere in this codebase, and become 0..1 only here.

Compositing is straight-alpha float32 (H, W, 4) 0..1, the effects.py
contract: `add` is additive light and grows alpha the way Lens Flare does,
`screen` likewise, `normal` puts the particle buffer OVER the layer (within
the buffer, overlapping particles average rather than stack in draw order -
one aggregated buffer is the price of the vectorised splat, and for soft
round sprites the difference is invisible).

This module deliberately imports nothing from effects.py (which imports THIS
module to register the effect - a circular import would make registration
order load-bearing). The three planar helpers it needs are a dozen lines,
copied, and say so.
"""
import math

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# caps
# ---------------------------------------------------------------------------

MAX_PARTICLES = 6000        # live particles per frame, before draft thinning
MAX_SPLAT = 4_000_000       # total kernel pixels splatted per frame
DRAFT_KEEP = 0.25           # draft renders keep this fraction of particles
MAX_RADIUS = 255.0          # sprite radius cap, px at render scale
_GRID_HZ = 60.0             # birth-grid base resolution, steps per second
_GRID_MAX = 4096            # grid points cap; past it the step doubles

# ---------------------------------------------------------------------------
# the catalog entry (effects.py registers it verbatim)
# ---------------------------------------------------------------------------

WHY = ("A particle system in the CC Particle World spirit: an emitter sprays "
       "soft round sprites that fly ballistically under gravity, wind and "
       "drag, changing size, colour and opacity over their life. Closed-form "
       "under the hood, so scrubbing to any frame is instant and two renders "
       "are identical. Additive by default - fire, sparks, snow, rain, dust, "
       "magic. No collisions, no textured particles in v1 (see docs/VFX.md).")


def _num(default, lo, hi, desc, animatable=True, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": animatable, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def _pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default,
            "animatable": False, "desc": desc}


def _col(default, desc):
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": True, "desc": desc}


PARAMS = {
    # ── emitter ───────────────────────────────────────────────────────────
    "emitter": _pick(["point", "line", "box", "ring"], "point",
                     "where particles are born: a point, a line across the "
                     "emitter's width/height diagonal, anywhere in a box, or "
                     "on the rim of an ellipse"),
    "positionX": _num(50, -100, 200, "emitter centre, percent of width", unit="%"),
    "positionY": _num(50, -100, 200, "emitter centre, percent of height", unit="%"),
    "emitterWidth": _num(0, 0, 4096, "emitter extent in x, pixels; 0 collapses "
                                     "line/box/ring to the centre", unit="px"),
    "emitterHeight": _num(0, 0, 4096, "emitter extent in y, pixels", unit="px"),
    "direction": _num(0, -360, 360, "launch direction in degrees; 0 is straight "
                                    "up, 90 is right, clockwise", unit="deg"),
    "spread": _num(60, 0, 360, "cone width around the direction; 360 sprays "
                               "every way", unit="deg"),
    # ── physics (sampled at each particle's BIRTH; frozen for its life) ───
    "speed": _num(150, 0, 2000, "launch speed, pixels per second", unit="px/s"),
    "speedVariance": _num(30, 0, 100, "per-particle speed spread, percent of "
                                      "speed", unit="%"),
    "gravityX": _num(0, -2000, 2000, "constant acceleration in x", unit="px/s²"),
    "gravityY": _num(250, -2000, 2000, "constant acceleration in y; positive "
                                       "falls down the frame", unit="px/s²"),
    "windX": _num(0, -2000, 2000, "steady push in x, added to gravity", unit="px/s²"),
    "windY": _num(0, -2000, 2000, "steady push in y", unit="px/s²"),
    "drag": _num(0, 0, 10, "exponential air resistance; velocity decays toward "
                           "the wind+gravity terminal at this rate", unit="1/s"),
    "turbulence": _num(0, 0, 500, "turbulence (procedural): how far a particle "
                                  "wanders off its ballistic path", unit="px"),
    "turbulenceFreq": _num(1, 0.05, 8, "how fast the wander wiggles", unit="Hz"),
    # ── particles ─────────────────────────────────────────────────────────
    "birthRate": _num(60, 0, 1000, "particles born per second; keyframe it for "
                                   "bursts", unit="/s"),
    "lifetime": _num(2, 0.05, 10, "how long a particle lives", unit="s"),
    "lifetimeVariance": _num(20, 0, 100, "per-particle lifetime spread, percent "
                                         "of lifetime", unit="%"),
    "sizeStart": _num(12, 0, 200, "sprite diameter at birth", unit="px"),
    "sizeEnd": _num(4, 0, 200, "sprite diameter at death", unit="px"),
    "sizeVariance": _num(30, 0, 100, "per-particle size spread, percent", unit="%"),
    "opacityStart": _num(100, 0, 100, "opacity at birth", unit="%"),
    "opacityEnd": _num(0, 0, 100, "opacity at death; 0 fades particles out "
                                  "instead of popping", unit="%"),
    "colorStart": _col([255, 220, 120], "colour at birth (0-255)"),
    "colorEnd": _col([255, 60, 8], "colour at death (0-255)"),
    "seed": _num(1, 0, 100000, "a different spray from the same settings",
                 integer=True, animatable=False),
    # ── rendering ─────────────────────────────────────────────────────────
    "mode": _pick(["add", "normal", "screen"], "add",
                  "add and screen are light (fire, sparks); normal is opaque "
                  "matter (snow, debris) drawn over the layer"),
}

# Params sampled at each particle's birth time when they are keyframed.
# birthRate is integrated instead; emitter/mode/seed are not per-particle.
_BIRTH_NUM = ["positionX", "positionY", "emitterWidth", "emitterHeight",
              "direction", "spread", "speed", "speedVariance",
              "gravityX", "gravityY", "windX", "windY", "drag",
              "turbulence", "turbulenceFreq", "lifetime", "lifetimeVariance",
              "sizeStart", "sizeEnd", "sizeVariance",
              "opacityStart", "opacityEnd"]
_BIRTH_COL = ["colorStart", "colorEnd"]


# ---------------------------------------------------------------------------
# counter-based randomness - splitmix64 on uint64 arrays
# ---------------------------------------------------------------------------

_MASK = 0xFFFFFFFFFFFFFFFF

# channel salts: one stream per random quantity, all from one seed
_S_CULL, _S_CULL2, _S_EMIT_U, _S_EMIT_V = 1, 2, 3, 4
_S_DIR, _S_SPEED, _S_LIFE, _S_SIZE = 5, 6, 7, 8
_S_TURB = 100                      # 100..105: three sines x two axes


def _mix_scalar(x):
    """splitmix64 finalise on a python int - masked python arithmetic, immune
    to numpy scalar overflow warnings."""
    x = (x + 0x9E3779B97F4A7C15) & _MASK
    x = ((x ^ (x >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
    x = ((x ^ (x >> 27)) * 0x94D049BB133111EB) & _MASK
    return x ^ (x >> 31)


def _u01(seed, idx, salt):
    """One uniform in [0, 1) per particle index. idx is a uint64 array; the
    same (seed, idx, salt) is the same number in every process forever."""
    key = np.uint64(_mix_scalar((int(seed) & _MASK) * 0x9E3779B9 + salt * 0xC2B2AE3D + 1))
    with np.errstate(over="ignore"):
        x = (idx ^ key) + np.uint64(0x9E3779B97F4A7C15)
        x = (x ^ (x >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        x = (x ^ (x >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        x = x ^ (x >> np.uint64(31))
    return (x >> np.uint64(11)).astype(np.float64) * (1.0 / 9007199254740992.0)


# ---------------------------------------------------------------------------
# planar helpers - copied from effects.py (see module docstring: importing
# effects here would be circular, effects.py imports this module to register)
# ---------------------------------------------------------------------------

def _rgb(rgba):
    out = np.empty(rgba.shape[:2] + (3,), np.float32)
    cv2.mixChannels([rgba], [out], [0, 0, 1, 1, 2, 2])
    return out


def _alpha(rgba):
    return np.ascontiguousarray(rgba[..., 3])


def _pack(rgb, a):
    out = np.empty(rgb.shape[:2] + (4,), np.float32)
    cv2.mixChannels([rgb, a], [out], [0, 0, 1, 1, 2, 2, 3, 3])
    return out


def _note(ctx, msg):
    notes = ctx.get("notes")
    if isinstance(notes, list) and msg not in notes:
        notes.append(str(msg))


# ---------------------------------------------------------------------------
# parameter sampling
# ---------------------------------------------------------------------------

def _f(v, d=0.0):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return d
    return v if math.isfinite(v) else d


def _clamp_num(name, arr):
    """Sampled values arrive UNCOERCED (paramsAt is raw curve evaluation), so
    they get the same treatment _coerce gives the frame's own params."""
    spec = PARAMS[name]
    d = float(spec["default"])
    a = np.array([_f(v, d) for v in arr], dtype=np.float64)
    return np.clip(a, float(spec["min"]), float(spec["max"]))


def _clamp_col(name, rows):
    d = [float(c) for c in PARAMS[name]["default"]]
    out = np.empty((len(rows), 3), np.float64)
    for i, v in enumerate(rows):
        try:
            trip = [float(c) for c in list(v)[:3]]
            out[i] = trip if len(trip) == 3 else d
        except (TypeError, ValueError):
            out[i] = d
    out[~np.isfinite(out)] = 0.0
    return np.clip(out, 0.0, 255.0)


def _trip(v, name):
    """One colour param as a clamped float triple, 0-255."""
    try:
        trip = [_f(c) for c in list(v)[:3]]
    except (TypeError, ValueError):
        trip = []
    if len(trip) != 3:
        trip = [float(c) for c in PARAMS[name]["default"]]
    return np.clip(np.asarray(trip, np.float64), 0.0, 255.0)


def _animated_names(ctx):
    """Which of OUR params carry keyframes or an expression, read off the raw
    document dict the engine leaves at ctx["fxParams"]. A paramsAt callable
    with no raw dict means an engine older than this contract: assume
    animated, which is only ever slower, never wrong."""
    raw = ctx.get("fxParams")
    if not isinstance(raw, dict):
        return {"*"} if callable(ctx.get("paramsAt")) else set()
    out = set()
    for k, v in raw.items():
        if k in PARAMS and isinstance(v, dict) and ("keys" in v or "expr" in v):
            out.add(k)
    return out


def _grid_times(t0, t1):
    """Sample times t0 + k*step, ANCHORED at t0 with a fixed step, plus t1
    itself. Anchoring is the temporal-coherence guarantee: every frame's
    integral shares the same prefix, so births do not re-time as t advances.
    The step doubles when the span would need more than _GRID_MAX points; at
    a doubling boundary births may shift by O(step^2) once - documented, and
    only reachable past ~68s of emission at the base 60Hz."""
    span = max(0.0, t1 - t0)
    step = 1.0 / _GRID_HZ
    while span / step > _GRID_MAX:
        step *= 2.0
    k = int(math.floor(span / step + 1e-9))
    taus = t0 + step * np.arange(k + 1, dtype=np.float64)
    if t1 - taus[-1] > 1e-9:
        taus = np.append(taus, t1)
    return taus


# ---------------------------------------------------------------------------
# the effect body
# ---------------------------------------------------------------------------

def render(rgba, p, ctx):
    h, w = rgba.shape[:2]
    t1 = _f(ctx.get("t"), 0.0)
    lay = ctx.get("layer") if isinstance(ctx.get("layer"), dict) else {}
    t0 = _f(lay.get("start"), 0.0)
    if t1 <= t0:
        return rgba
    s = max(0.05, _f(ctx.get("scale"), 1.0))
    seed = int(p["seed"])
    draft = bool(ctx.get("draft"))

    animated = bool(_animated_names(ctx)) and callable(ctx.get("paramsAt"))

    # ── birth times, and birth-state sampling functions ───────────────────
    if animated:
        taus = _grid_times(t0, t1)
        at = ctx["paramsAt"]
        dicts = [at(float(tt)) or {} for tt in taus]
        num = {n: _clamp_num(n, [d.get(n, PARAMS[n]["default"]) for d in dicts])
               for n in _BIRTH_NUM + ["birthRate"]}
        colv = {n: _clamp_col(n, [d.get(n, PARAMS[n]["default"]) for d in dicts])
                for n in _BIRTH_COL}
        # Trapezoid cumulative births. C is non-decreasing rather than strictly
        # increasing (a zero-rate stretch is flat); np.interp's inverse is
        # ambiguous only for a target landing EXACTLY on a flat plateau's
        # value, where it may yield nan - that particle simply fails the
        # age>=0 filter below. One dropped particle on a measure-zero float
        # coincidence, deterministically, is the right price for keeping a
        # FLAT keyframed rate bit-identical to the constant path (which a
        # strictly-increasing epsilon ramp here would quietly break).
        rate = num["birthRate"]
        dt = np.diff(taus)
        C = np.concatenate(([0.0], np.cumsum(0.5 * (rate[:-1] + rate[1:]) * dt)))
        n_total = int(max(0.0, math.floor(C[-1] + 0.5)))
        if n_total <= 0:
            return rgba
        lmax = float(np.max(num["lifetime"] * (1.0 + num["lifetimeVariance"] / 100.0)))
        n_lo = max(0, int(math.ceil(float(np.interp(t1 - lmax, taus, C)) - 0.5)))

        def births_of(ids):
            return np.interp(ids.astype(np.float64) + 0.5, C, taus)

        def sample(name, bt):
            return np.interp(bt, taus, num[name])

        def sample_col(name, bt):
            v = colv[name]
            return np.stack([np.interp(bt, taus, v[:, c]) for c in range(3)], axis=1)
    else:
        rate = float(p["birthRate"])
        if rate <= 0.0:
            return rgba
        span = t1 - t0
        n_total = int(max(0.0, math.floor(rate * span + 0.5)))
        if n_total <= 0:
            return rgba
        lmax = p["lifetime"] * (1.0 + p["lifetimeVariance"] / 100.0)
        n_lo = max(0, int(math.ceil(rate * (span - lmax) - 0.5)))

        def births_of(ids):
            return t0 + (ids.astype(np.float64) + 0.5) / rate

        def sample(name, bt):
            return np.full(len(bt), float(p[name]), np.float64)

        def sample_col(name, bt):
            return np.broadcast_to(_trip(p[name], name), (len(bt), 3))

    idx = np.arange(n_lo, n_total, dtype=np.uint64)
    if len(idx) == 0:
        return rgba
    births = births_of(idx)

    # ── lifetime, and who is alive at t1 ──────────────────────────────────
    age = t1 - births
    life = sample("lifetime", births) * (
        1.0 + sample("lifetimeVariance", births) / 100.0
        * (2.0 * _u01(seed, idx, _S_LIFE) - 1.0))
    life = np.maximum(life, 1e-3)
    m = (age >= 0.0) & (age < life)
    idx, births, age, life = idx[m], births[m], age[m], life[m]
    if len(idx) == 0:
        return rgba

    # ── caps: seeded lottery, stable per particle ─────────────────────────
    keep = 1.0
    if len(idx) > MAX_PARTICLES:
        keep = MAX_PARTICLES / float(len(idx))
        _note(ctx, f"particleSystem: {len(idx)} live particles thinned to "
                   f"~{MAX_PARTICLES} (MAX_PARTICLES)")
    if draft:
        keep *= DRAFT_KEEP
    if keep < 1.0:
        m = _u01(seed, idx, _S_CULL) < keep
        idx, births, age, life = idx[m], births[m], age[m], life[m]
    if len(idx) == 0:
        return rgba

    ba = {n: sample(n, births) for n in _BIRTH_NUM
          if n not in ("lifetime", "lifetimeVariance")}
    cstart = sample_col("colorStart", births)
    cend = sample_col("colorEnd", births)

    # ── birth state ───────────────────────────────────────────────────────
    px0 = ba["positionX"] / 100.0 * w
    py0 = ba["positionY"] / 100.0 * h
    ew = ba["emitterWidth"] * s
    eh = ba["emitterHeight"] * s
    shape = p["emitter"]
    if shape == "line":
        u = _u01(seed, idx, _S_EMIT_U) - 0.5
        px0 = px0 + u * ew
        py0 = py0 + u * eh
    elif shape == "box":
        px0 = px0 + (_u01(seed, idx, _S_EMIT_U) - 0.5) * ew
        py0 = py0 + (_u01(seed, idx, _S_EMIT_V) - 0.5) * eh
    elif shape == "ring":
        ang = _u01(seed, idx, _S_EMIT_U) * (2.0 * np.pi)
        px0 = px0 + np.cos(ang) * ew * 0.5
        py0 = py0 + np.sin(ang) * eh * 0.5

    theta = np.deg2rad(ba["direction"]
                       + (_u01(seed, idx, _S_DIR) - 0.5) * ba["spread"])
    speed = np.maximum(0.0, ba["speed"] * (
        1.0 + ba["speedVariance"] / 100.0
        * (2.0 * _u01(seed, idx, _S_SPEED) - 1.0))) * s
    v0x = np.sin(theta) * speed                # 0 deg is up, clockwise
    v0y = -np.cos(theta) * speed

    # ── the closed form ───────────────────────────────────────────────────
    ax = (ba["gravityX"] + ba["windX"]) * s
    ay = (ba["gravityY"] + ba["windY"]) * s
    k = ba["drag"]
    kk = np.maximum(k, 1e-12)
    f_exact = -np.expm1(-kk * age) / kk
    small = k < 1e-6
    F = np.where(small, age, f_exact)
    G = np.where(small, 0.5 * age * age, (age - f_exact) / kk)
    x = px0 + v0x * F + ax * G
    y = py0 + v0y * F + ay * G

    # turbulence (procedural): three seeded sines per axis over age, zeroed
    # at birth. Closed-form wander, not a fluid solve - module docstring.
    amp = ba["turbulence"] * s
    if float(np.max(amp)) > 1e-6:
        freq = ba["turbulenceFreq"]
        for j, (fmul, wgt) in enumerate(((1.0, 0.60), (2.7, 0.28), (6.1, 0.12))):
            om = 2.0 * np.pi * freq * fmul
            phx = _u01(seed, idx, _S_TURB + 2 * j) * (2.0 * np.pi)
            phy = _u01(seed, idx, _S_TURB + 2 * j + 1) * (2.0 * np.pi)
            x = x + amp * wgt * (np.sin(om * age + phx) - np.sin(phx))
            y = y + amp * wgt * (np.sin(om * age + phy) - np.sin(phy))

    # ── the look at this age ──────────────────────────────────────────────
    ulife = age / life
    sizemul = 1.0 + ba["sizeVariance"] / 100.0 * (2.0 * _u01(seed, idx, _S_SIZE) - 1.0)
    diam = (ba["sizeStart"] + (ba["sizeEnd"] - ba["sizeStart"]) * ulife) * sizemul * s
    radius = np.clip(diam * 0.5, 0.0, MAX_RADIUS)
    opacity = (ba["opacityStart"]
               + (ba["opacityEnd"] - ba["opacityStart"]) * ulife) / 100.0
    # sub-pixel particles dim by area instead of popping to a one-pixel dot
    opacity = np.clip(opacity, 0.0, 1.0) * np.clip(radius * radius, 0.0, 1.0)
    colour = (cstart + (cend - cstart) * ulife[:, None]) / 255.0

    # drop what cannot land a pixel
    ri = np.maximum(np.int64(1), np.ceil(radius).astype(np.int64))
    vis = ((opacity > 1e-4) & (radius > 0.05)
           & (x + ri >= 0) & (x - ri < w) & (y + ri >= 0) & (y - ri < h))
    x, y, radius, ri = x[vis], y[vis], radius[vis], ri[vis]
    opacity, colour = opacity[vis], colour[vis]
    if len(x) == 0:
        return rgba

    # splat-work cap: same lottery mechanism, second salt. The key is the
    # particle's position in the drawn set rather than its global index -
    # acceptable because this cap only trips on pathological size*count
    # combinations, and it stays deterministic.
    work = float(np.sum((2 * ri + 1) ** 2, dtype=np.float64))
    if work > MAX_SPLAT:
        m = _u01(seed, np.arange(len(x), dtype=np.uint64), _S_CULL2) < MAX_SPLAT / work
        x, y, radius, ri = x[m], y[m], radius[m], ri[m]
        opacity, colour = opacity[m], colour[m]
        _note(ctx, f"particleSystem: sprite area over MAX_SPLAT, thinned to "
                   f"{len(x)} particles")
        if len(x) == 0:
            return rgba

    # ── the splat: bucket by kernel extent, bincount everything ───────────
    # Each bucket contributes flat indices + weights; the four bincounts run
    # ONCE over the concatenation, not once per bucket - a full-frame
    # accumulator per bucket would swamp everything else at 720p.
    lin_parts, wa, wr, wg, wb = [], [], [], [], []
    cxi = np.floor(x).astype(np.int64)
    cyi = np.floor(y).astype(np.int64)
    fx = x - cxi
    fy = y - cyi
    for R in np.unique(ri):
        sel = np.nonzero(ri == R)[0]
        off = np.arange(-int(R), int(R) + 1, dtype=np.float64)
        dx = off[None, :] - fx[sel][:, None]                     # (N, k)
        dy = off[None, :] - fy[sel][:, None]
        r2 = (radius[sel] ** 2)[:, None, None]
        q = 1.0 - (dy[:, :, None] ** 2 + dx[:, None, :] ** 2) / r2
        np.maximum(q, 0.0, out=q)
        np.multiply(q, q, out=q)                                 # (1-d²/r²)²
        q *= opacity[sel][:, None, None]
        rows = cyi[sel][:, None] + off.astype(np.int64)[None, :]  # (N, k)
        cols = cxi[sel][:, None] + off.astype(np.int64)[None, :]
        valid = ((rows >= 0) & (rows < h))[:, :, None] \
            & ((cols >= 0) & (cols < w))[:, None, :]
        q[~valid] = 0.0
        lin_parts.append((np.clip(rows, 0, h - 1)[:, :, None] * w
                          + np.clip(cols, 0, w - 1)[:, None, :]).ravel())
        wa.append(q.ravel())
        for c, dst in ((0, wr), (1, wg), (2, wb)):
            dst.append((q * colour[sel, c][:, None, None]).ravel())

    lin = np.concatenate(lin_parts)
    A = np.bincount(lin, weights=np.concatenate(wa),
                    minlength=h * w).reshape(h, w).astype(np.float32)
    P = [np.bincount(lin, weights=np.concatenate(ws),
                     minlength=h * w).reshape(h, w).astype(np.float32)
         for ws in (wr, wg, wb)]

    # ── composite, straight alpha in and out ──────────────────────────────
    # cv2.split hands back copies, so the channel planes are mutated freely -
    # in-place ops here are a real chunk of the fixed 720p cost.
    a = _alpha(rgba)
    chans = cv2.split(_rgb(rgba))
    Ac = np.clip(A, 0.0, 1.0)
    out_a = np.clip(a + Ac * (1.0 - a), 0.0, 1.0)
    if p["mode"] == "normal":
        # over: the aggregated particle buffer, renormalised where it
        # over-accumulated, on top of the layer
        scale_pm = (Ac / np.maximum(A, np.float32(1e-6))).astype(np.float32)
        hold = a * (1.0 - Ac)
        for c in range(3):
            ch = chans[c]
            np.multiply(ch, hold, out=ch)
            ch += np.clip(P[c] * scale_pm, 0.0, 1.0)
    elif p["mode"] == "screen":
        for c in range(3):
            ch = chans[c]
            np.multiply(ch, a, out=ch)                     # premultiply
            pp = np.clip(P[c], 0.0, 1.0)
            pp -= ch * pp
            ch += pp
    else:                                                  # add - light on top
        for c in range(3):
            ch = chans[c]
            np.multiply(ch, a, out=ch)
            ch += P[c]
    den = np.maximum(out_a, np.float32(1e-6))
    for c in range(3):
        ch = chans[c]
        np.divide(ch, den, out=ch)
        np.clip(ch, 0.0, 1.0, out=ch)
    return _pack(cv2.merge(chans), out_a.astype(np.float32))
