"""Animatable values and the transform maths — the arithmetic under every
other part of the compositor.

Two jobs, and they are here together because they are the two things that turn
a JSON document into pixels at a given instant:

  evalProp(prop, t)   a property is EITHER a constant (number or array, written
                      literally) OR { "keys": [...] }. Callers should never
                      have to ask which — they pass whatever the document holds
                      and get a value back.

  transform_matrix / world_matrix
                      anchor/position/scale/rotation folded into one 2x3 affine,
                      and the parent chain folded on top of that.

The engine calls these once per layer per frame (and once per motion-blur
sub-sample), so they stay pure and allocation-light: no numpy for the keyframe
path, plain floats and lists out, which is also what the REST layer wants to
hand back as JSON.

Three things AE has that a straight lerp does not, all of them ADDITIVE — a key
without the new fields behaves bit-for-bit as it did before:

  SPATIAL TANGENTS   a key may carry "to"/"ti" (AE's own names for the out and
                     in tangent, stored as offsets from the key's own value), and
                     position then travels a bezier instead of a straight line,
                     parameterised by ARC LENGTH so the temporal ease still means
                     speed. See eval_prop / motion_path.
  ROVING KEYS        {"roving": true} on an interior key means "you pick my
                     time" — the times get redistributed so speed is constant
                     between the anchors either side. See resolve_roving.
  EXPRESSIONS        eval_prop takes an OPTIONAL fourth argument, a binding from
                     expressions.py. Without it a property with an "expr" field
                     falls back to its keys exactly as before, so nothing that
                     does not opt in can change behaviour.

Nothing here touches disk or PIL — engine_test.py exercises it directly.
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

# CSS's named timing functions, as their cubic-bezier control points. AE's
# easy-ease is not literally these, but the spec asks for CSS semantics and a
# reader who types "easeOut" means "starts fast, settles" — which is what these
# describe.
_EASE_PRESETS = {
    "linear": None,
    "hold": "hold",
    "easein": (0.42, 0.0, 1.0, 1.0),
    "easeout": (0.0, 0.0, 0.58, 1.0),
    "easeinout": (0.42, 0.0, 0.58, 1.0),
}


def _cubic(a, b, u):
    """One axis of a cubic bezier whose endpoints are pinned at 0 and 1."""
    v = 1.0 - u
    return 3.0 * v * v * u * a + 3.0 * v * u * u * b + u * u * u


def _cubic_slope(a, b, u):
    v = 1.0 - u
    return 3.0 * v * v * a + 6.0 * v * u * (b - a) + 3.0 * u * u * (1.0 - b)


def bezier_ease(x1, y1, x2, y2, x):
    """CSS cubic-bezier: given progress x along the segment, return eased y.

    x is not the curve's parameter — the control points bend time as well as
    value, so the parameter u has to be solved for first. Newton converges in
    two or three steps on anything a human would draw; bisection catches the
    pathological control points (a flat or backwards x axis) where Newton's
    slope goes to zero and it would otherwise wander off.
    """
    x = min(1.0, max(0.0, float(x)))
    # CSS pins the x control points into 0..1; outside that the curve is not a
    # function of time and there is no single answer to solve for.
    x1 = min(1.0, max(0.0, float(x1)))
    x2 = min(1.0, max(0.0, float(x2)))
    y1, y2 = float(y1), float(y2)
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0

    u = x
    for _ in range(8):
        err = _cubic(x1, x2, u) - x
        if abs(err) < 1e-7:
            return _cubic(y1, y2, u)
        slope = _cubic_slope(x1, x2, u)
        if abs(slope) < 1e-6:
            break
        u -= err / slope
        if u < 0.0 or u > 1.0:
            break

    lo, hi = 0.0, 1.0
    u = x
    for _ in range(40):
        if _cubic(x1, x2, u) < x:
            lo = u
        else:
            hi = u
        u = (lo + hi) * 0.5
    return _cubic(y1, y2, u)


def _ease_fraction(ease, u):
    """Map a raw 0..1 segment position to an eased one."""
    if isinstance(ease, dict):
        b = ease.get("bezier")
        if isinstance(b, (list, tuple)) and len(b) >= 4:
            return bezier_ease(b[0], b[1], b[2], b[3], u)
        return u
    if isinstance(ease, (list, tuple)) and len(ease) >= 4:
        # tolerated shorthand: the four control numbers with no wrapper
        return bezier_ease(ease[0], ease[1], ease[2], ease[3], u)
    preset = _EASE_PRESETS.get(str(ease or "linear").strip().lower(), None)
    if preset == "hold":
        return 0.0
    if preset is None:
        return u
    return bezier_ease(preset[0], preset[1], preset[2], preset[3], u)


def _num(v, fallback=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


def _mix(a, b, u):
    """Interpolate two key values of whatever arity the property has.

    Arity is meant to match, but a document edited by hand (or by an agent that
    read the wrong catalog entry) can hold a scalar next to a pair. Widening the
    shorter side by repeating its last component keeps that a visual glitch
    instead of a traceback mid-render.
    """
    a_is_seq = isinstance(a, (list, tuple))
    b_is_seq = isinstance(b, (list, tuple))
    if not a_is_seq and not b_is_seq:
        af, bf = _num(a), _num(b)
        return af + (bf - af) * u
    av = [_num(x) for x in a] if a_is_seq else [_num(a)]
    bv = [_num(x) for x in b] if b_is_seq else [_num(b)]
    n = max(len(av), len(bv), 1)
    av = (av or [0.0]) + [(av or [0.0])[-1]] * (n - len(av))
    bv = (bv or [0.0]) + [(bv or [0.0])[-1]] * (n - len(bv))
    return [av[i] + (bv[i] - av[i]) * u for i in range(n)]


def _plain(v):
    """A key value, copied out so callers cannot mutate the document."""
    if isinstance(v, (list, tuple)):
        return [_num(x) for x in v]
    if isinstance(v, bool) or isinstance(v, (int, float)):
        return _num(v)
    return v


def key_time(k):
    """One keyframe's time, however carelessly it was written."""
    return _num(k.get("t")) if isinstance(k, dict) else 0.0


def sorted_keys(prop):
    """A property's keyframes, sorted, roving resolved, or [] if it has none.

    Sorting on read rather than on write: the document is edited from three
    places (UI, MCP, hand) and only one of them is careful.
    """
    keys = prop.get("keys") if isinstance(prop, dict) else None
    if not isinstance(keys, list):
        return []
    keys = [k for k in keys if isinstance(k, dict) and "v" in k]
    if not keys:
        return []
    keys = sorted(keys, key=key_time)
    if len(keys) > 2 and any(k.get("roving") for k in keys[1:-1]):
        keys = resolve_roving(keys)
    return keys


def eval_prop(prop, t, default=None, ctx=None):
    """The value of an animatable property at comp time t.

    A constant returns itself. A { "keys": [...] } object is sampled: before the
    first key it holds the first value, after the last it holds the last, and
    between two keys the easing on the LEFT key shapes the segment (easing
    describes the segment leaving a key, which is why "hold" reads as "this key
    holds until the next one").

    Non-numeric values (an enum string, a colour name, a nested dict that is not
    a keyframe track) pass straight through — effect params carry those too and
    the engine should not have to sort them out first.

    `ctx` is the expression binding from expressions.py, and it is optional on
    purpose: a caller that does not pass one gets precisely the behaviour this
    function has always had, including on a property that carries an "expr".
    That is the difference between wiring expressions in and turning them on.
    """
    if not isinstance(prop, dict):
        return _plain(prop) if prop is not None else default
    if ctx is not None and prop.get("expr"):
        # The binding is responsible for its own failures — it returns the
        # keyframed value rather than raising. Belt and braces anyway: a render
        # is 240 frames deep by the time anyone reads the traceback.
        try:
            return ctx.eval_expression(prop, t, default)
        except Exception:                              # noqa: BLE001
            pass
    keys = prop.get("keys")
    if not isinstance(keys, list):
        # An expression-only property still needs a `value` to fall back to and
        # for the expression to read as `value`.
        if prop.get("expr"):
            return _plain(prop["value"]) if "value" in prop else default
        return prop
    keys = sorted_keys(prop)
    if not keys:
        return default
    if len(keys) == 1:
        return _plain(keys[0]["v"])

    tf = _num(t)
    if tf <= key_time(keys[0]):
        return _plain(keys[0]["v"])
    if tf >= key_time(keys[-1]):
        return _plain(keys[-1]["v"])

    i = 0
    for j in range(len(keys) - 1):
        if key_time(keys[j]) <= tf:
            i = j
    a, b = keys[i], keys[i + 1]
    t0, t1 = key_time(a), key_time(b)
    span = t1 - t0
    if span <= 1e-9:
        return _plain(b["v"])
    u = _ease_fraction(a.get("ease"), (tf - t0) / span)
    curved = _spatial_point(a, b, u)
    return _mix(a["v"], b["v"], u) if curved is None else curved


# The spec names this evalProp; the repo writes python snake_case. Both work so
# neither side of the contract has to translate.
evalProp = eval_prop


def eval_params(params, t, ctx=None):
    """Every value in an effect's param dict, sampled at t.

    Enums and booleans fall through untouched — only the tracks resolve.

    `ctx` is one binding for the whole effect; each param gets its own child of
    it, so an expression on a radius reports itself as "effects.fx_1.radius"
    rather than as the effect.
    """
    if not isinstance(params, dict):
        return {}
    if ctx is None or not hasattr(ctx, "at"):
        return {k: eval_prop(v, t, None, ctx) for k, v in params.items()}
    return {k: eval_prop(v, t, None, ctx.at(k)) for k, v in params.items()}


# ── spatial motion paths ──────────────────────────────────────────────────────
#
# AE stores a spatial tangent as an OFFSET from the key's own value: "to" is the
# handle leaving a key, "ti" the handle arriving at it. So the cubic between key
# A and key B is
#
#     P0 = A.v            P1 = A.v + A.to
#     P3 = B.v            P2 = B.v + B.ti
#
# and the temporal ease chooses how far ALONG that curve we are — as arc length,
# not as the bezier parameter. Those are not the same thing: feed the parameter
# straight in and a curve with uneven handles speeds up and slows down on its
# own, which is exactly the artefact roving keyframes exist to remove.

_ARC_STEPS = 24


def _tangent(v, n):
    """A tangent as n components, missing ones zero — no tangent at all is None."""
    if not isinstance(v, (list, tuple)) or not v:
        return None
    out = [_num(x) for x in v[:n]]
    out += [0.0] * (n - len(out))
    return out if any(abs(x) > 1e-9 for x in out) else None


def _control_points(a, b):
    """The four bezier points for the segment a→b, or None when it is a line."""
    av, bv = a.get("v"), b.get("v")
    if not (isinstance(av, (list, tuple)) and isinstance(bv, (list, tuple))):
        return None
    n = len(av)
    if n < 2 or len(bv) != n:
        return None
    to = _tangent(a.get("to"), n)
    ti = _tangent(b.get("ti"), n)
    if to is None and ti is None:
        # THE additive guarantee: no tangents means we never reach the bezier
        # code at all, so a document written before this existed evaluates to
        # the same floats it always did.
        return None
    p0 = tuple(_num(x) for x in av)
    p3 = tuple(_num(x) for x in bv)
    p1 = tuple(p0[i] + (to[i] if to else 0.0) for i in range(n))
    p2 = tuple(p3[i] + (ti[i] if ti else 0.0) for i in range(n))
    return p0, p1, p2, p3


def bezier_point(p0, p1, p2, p3, s):
    """A point on the cubic at parameter s."""
    v = 1.0 - s
    c0, c1, c2, c3 = v * v * v, 3.0 * v * v * s, 3.0 * v * s * s, s * s * s
    return [p0[i] * c0 + p1[i] * c1 + p2[i] * c2 + p3[i] * c3 for i in range(len(p0))]


@lru_cache(maxsize=512)
def _arc_table(p0, p1, p2, p3):
    """Cumulative chord length along the cubic, normalised to 0..1.

    Cached on the control points themselves: a motion path is static for the
    whole render, so this table is built once and read 240 times, and the cost
    of the arc-length reparameterisation stops being a per-frame cost.
    """
    prev = bezier_point(p0, p1, p2, p3, 0.0)
    acc = [0.0]
    total = 0.0
    for i in range(1, _ARC_STEPS + 1):
        pt = bezier_point(p0, p1, p2, p3, i / _ARC_STEPS)
        total += math.sqrt(sum((pt[k] - prev[k]) ** 2 for k in range(len(pt))))
        acc.append(total)
        prev = pt
    if total <= 1e-12:
        return tuple(i / _ARC_STEPS for i in range(_ARC_STEPS + 1)), 0.0
    return tuple(x / total for x in acc), total


def _arc_param(table, s):
    """The bezier parameter whose arc fraction is s, linearly between samples."""
    if s <= 0.0:
        return 0.0
    if s >= 1.0:
        return 1.0
    lo, hi = 0, len(table) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if table[mid] <= s:
            lo = mid
        else:
            hi = mid
    a, b = table[lo], table[hi]
    frac = 0.0 if b - a <= 1e-12 else (s - a) / (b - a)
    return (lo + frac) / (len(table) - 1)


def _spatial_point(a, b, u):
    """The curved value at eased fraction u, or None when the segment is a line."""
    cps = _control_points(a, b)
    if cps is None:
        return None
    p0, p1, p2, p3 = cps
    table, total = _arc_table(p0, p1, p2, p3)
    if total <= 1e-12:
        return None
    return bezier_point(p0, p1, p2, p3, _arc_param(table, u))


def motion_path(prop, samples=64):
    """A property's path in space, as points — what a viewer draws on top of the
    frame. Returns [] for anything that is not a multi-component track.
    """
    keys = sorted_keys(prop)
    if len(keys) < 2:
        return []
    t0, t1 = key_time(keys[0]), key_time(keys[-1])
    if t1 - t0 <= 1e-9:
        return []
    n = max(2, int(samples))
    out = []
    for i in range(n + 1):
        v = eval_prop(prop, t0 + (t1 - t0) * i / n)
        if not isinstance(v, list):
            return []
        out.append(v)
    return out


# ── roving keyframes ──────────────────────────────────────────────────────────

def segment_length(a, b):
    """How far the value travels between two keys — the curve's arc length when
    the segment carries tangents, the straight distance when it does not."""
    cps = _control_points(a, b)
    if cps is not None:
        _table, total = _arc_table(*cps)
        if total > 1e-12:
            return total
    av, bv = a.get("v"), b.get("v")
    if isinstance(av, (list, tuple)) or isinstance(bv, (list, tuple)):
        x = _mix(av, bv, 0.0)
        y = _mix(av, bv, 1.0)
        if isinstance(x, list):
            return math.sqrt(sum((y[i] - x[i]) ** 2 for i in range(len(x))))
    return abs(_num(bv) - _num(av))


def resolve_roving(keys):
    """Interior keys marked {"roving": true} get their TIME chosen for them.

    A roving key keeps its value and gives up its time: the run between the two
    anchored keys either side is retimed so distance-per-second is the same
    across every sub-segment, which is what makes a hand-drawn motion path move
    at an even speed instead of lurching between handles. The first and last key
    can never rove — there would be nothing to interpolate the time from, which
    is also AE's rule.

    Returns a NEW list; the roving keys are shallow-copied so the document keeps
    the times the author actually wrote.
    """
    out = list(keys)
    n = len(out)
    anchors = [0] + [i for i in range(1, n - 1) if not out[i].get("roving")] + [n - 1]
    for a, b in zip(anchors, anchors[1:]):
        if b - a < 2:
            continue
        lengths = [segment_length(out[i], out[i + 1]) for i in range(a, b)]
        total = sum(lengths)
        t0, t1 = key_time(out[a]), key_time(out[b])
        span = t1 - t0
        if span <= 1e-9:
            continue
        run = 0.0
        for j, i in enumerate(range(a + 1, b)):
            run += lengths[j]
            # Zero total distance means every key sits on the same value; even
            # spacing is the only thing "constant speed" can mean there.
            frac = (j + 1) / float(b - a) if total <= 1e-12 else run / total
            k = dict(out[i])
            k["t"] = t0 + span * frac
            out[i] = k
    return out


# ── the speed graph ───────────────────────────────────────────────────────────

def velocity_at(prop, t, ctx=None, h=None, fps=30.0):
    """d(value)/dt at t, componentwise — a number for a scalar track, a list for
    a vector one. Central difference: the eased segments have no closed form
    once a spatial bezier is in play, and a symmetric sample is the cheapest
    estimate that does not lag the curve.
    """
    step = h if h else 1.0 / (max(1.0, float(fps)) * 8.0)
    a = eval_prop(prop, t - step, 0.0, ctx)
    b = eval_prop(prop, t + step, 0.0, ctx)
    if isinstance(a, list) or isinstance(b, list):
        av = a if isinstance(a, list) else [_num(a)]
        bv = b if isinstance(b, list) else [_num(b)]
        n = max(len(av), len(bv))
        av += [av[-1]] * (n - len(av))
        bv += [bv[-1]] * (n - len(bv))
        return [(bv[i] - av[i]) / (2.0 * step) for i in range(n)]
    return (_num(b) - _num(a)) / (2.0 * step)


def speed_at(prop, t, ctx=None, h=None, fps=30.0):
    """The magnitude of the velocity — the curve a graph editor actually draws."""
    v = velocity_at(prop, t, ctx, h, fps)
    if isinstance(v, list):
        return math.sqrt(sum(x * x for x in v))
    return abs(v)


def speed_graph(prop, t0=None, t1=None, samples=64, ctx=None, fps=30.0):
    """A property's speed sampled over time, plus the numbers a UI puts on the
    axis. Defaults to the property's own keyframed range, which is the only part
    where the speed is anything but zero.

    Returns { t: [...], speed: [...], max: float, mean: float, keys: [t...] }.
    """
    keys = sorted_keys(prop)
    if t0 is None:
        t0 = key_time(keys[0]) if keys else 0.0
    if t1 is None:
        t1 = key_time(keys[-1]) if keys else 1.0
    t0, t1 = _num(t0), _num(t1)
    if t1 <= t0:
        t1 = t0 + 1.0
    n = max(2, int(samples))
    ts = [t0 + (t1 - t0) * i / n for i in range(n + 1)]
    sp = [speed_at(prop, x, ctx, None, fps) for x in ts]
    return {"t": ts, "speed": sp, "max": max(sp) if sp else 0.0,
            "mean": (sum(sp) / len(sp)) if sp else 0.0,
            "keys": [key_time(k) for k in keys]}


# ── time remapping ────────────────────────────────────────────────────────────

def has_time_remap(layer):
    """True when the layer carries a timeRemap track the engine should honour."""
    if not isinstance(layer, dict):
        return False
    tr = layer.get("timeRemap")
    return isinstance(tr, dict) and (isinstance(tr.get("keys"), list) or bool(tr.get("expr")))


def time_remap(layer, t, ctx=None, duration=None):
    """Source time for a layer at comp time t, or None when it does not remap.

    timeRemap is a property like any other — a curve whose VALUE happens to be a
    time in the source rather than a position or an opacity. Which means it
    keyframes, eases, roves and takes an expression for free; the only thing
    this adds is the clamp, because asking a decoder for a negative second or
    for one past the end of the file is how a render dies at frame 900.
    """
    if not has_time_remap(layer):
        return None
    st = _num(eval_prop(layer.get("timeRemap"), t, 0.0, ctx), 0.0)
    if st < 0.0:
        st = 0.0
    limit = duration if duration is not None else layer.get("srcDuration")
    if limit is not None:
        lim = _num(limit, 0.0)
        if lim > 0.0 and st > lim:
            st = lim
    return st


def eval_time_remap(prop, t, ctx=None, duration=None):
    """The PROPERTY-shaped door onto the same idea as time_remap().

    Two builders named this independently: the compositor holds the property
    (it has already found it on the layer) while time_remap() above takes the
    layer and looks it up. The engine probes for THIS name, so without the
    adapter its getattr quietly returned None and the richer path — eases,
    roving, expressions — was never reached, while a plain keyframe read gave
    the same answer and hid it. An alias could not do the job; the signatures
    genuinely differ.
    """
    st = _num(eval_prop(prop, t, 0.0, ctx), 0.0)
    if st < 0.0:
        st = 0.0
    if duration is not None:
        lim = _num(duration, 0.0)
        if lim > 0.0 and st > lim:
            st = lim
    return st


# ── transforms ────────────────────────────────────────────────────────────────

IDENTITY = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64)


def _pair(v, fallback):
    if isinstance(v, (list, tuple)):
        if len(v) >= 2:
            return _num(v[0], fallback[0]), _num(v[1], fallback[1])
        if len(v) == 1:
            # a uniform scale typed as a single number is the common shorthand
            return _num(v[0], fallback[0]), _num(v[0], fallback[1])
        return fallback
    if isinstance(v, (int, float)):
        return _num(v, fallback[0]), _num(v, fallback[1])
    return fallback


def _row(ctx, name):
    """The binding for one row of a transform, or None when expressions are off.

    The name is the SPELLING expressions.py's TransformRef uses, because that is
    the string the cycle guard keys on and the string wiggle's seed is drawn
    from: bind `transform.pos` here and a link from another layer that resolves
    to `transform.position` is a different property as far as both are concerned.
    """
    return ctx.at(name) if ctx is not None else None


def transform_matrix(transform, t, anchor_default=(0.0, 0.0), position_default=(0.0, 0.0),
                     ctx=None):
    """One layer's own transform as a 2x3 affine mapping LAYER px -> COMP px.

    Composed anchor-last: translate(position) . rotate . scale . translate(-anchor),
    so the anchor is what rotation and scale pivot around and it lands exactly on
    the position. Rotation is degrees CLOCKWISE — with y pointing down the screen
    the textbook matrix already turns that way, so there is no sign flip here.

    `ctx` is the binding for this layer's "transform", from which each row takes
    its own child — same opt-in rule as eval_prop's fourth argument, so a caller
    that passes nothing gets the geometry it has always got.
    """
    transform = transform if isinstance(transform, dict) else {}
    ax, ay = _pair(eval_prop(transform.get("anchor"), t, None, _row(ctx, "anchor")),
                   anchor_default)
    px, py = _pair(eval_prop(transform.get("position"), t, None, _row(ctx, "position")),
                   position_default)
    sx, sy = _pair(eval_prop(transform.get("scale"), t, None, _row(ctx, "scale")),
                   (100.0, 100.0))
    rot = _num(eval_prop(transform.get("rotation"), t, None, _row(ctx, "rotation")), 0.0)

    sx, sy = sx / 100.0, sy / 100.0
    rad = math.radians(rot)
    c, s = math.cos(rad), math.sin(rad)
    a00, a01 = c * sx, -s * sy
    a10, a11 = s * sx, c * sy
    return np.array([
        [a00, a01, px - (a00 * ax + a01 * ay)],
        [a10, a11, py - (a10 * ax + a11 * ay)],
    ], dtype=np.float64)


def mat_mul(a, b):
    """a . b for 2x3 affines — apply b first, then a."""
    a3 = np.vstack([a, [0.0, 0.0, 1.0]])
    b3 = np.vstack([b, [0.0, 0.0, 1.0]])
    return (a3 @ b3)[:2]


def apply_matrix(m, points):
    """Map points (N,2) through a 2x3 affine."""
    m = np.asarray(m, dtype=np.float64)
    p = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    return p @ m[:, :2].T + m[:, 2]


def parent_chain(layer, by_id):
    """The layer and its ancestors, child first, cycle broken.

    A parent loop is not hypothetical — two clicks in the parent picker make one,
    and every route that writes `parent` would need the same guard. Cheaper to
    refuse to climb a layer twice: the chain stops there and the frame still
    renders, which beats a RecursionError killing a render at frame 900.
    """
    chain = []
    seen = set()
    cur = layer
    while isinstance(cur, dict):
        lid = cur.get("id")
        if lid in seen:
            break
        seen.add(lid)
        chain.append(cur)
        pid = cur.get("parent")
        cur = by_id.get(pid) if pid else None
    return chain


def world_matrix(layer, by_id, t, defaults=None, bindings=None):
    """A layer's transform with its parent chain applied — LAYER px -> COMP px.

    Outermost ancestor first, so a child's position/rotation are expressed in its
    parent's space exactly the way AE's parent switch behaves. Opacity is NOT in
    here: parenting inherits geometry only, and a child of a 0% layer still shows.

    `defaults` maps a layer to its (anchor, position) fallbacks — those depend on
    the layer's own pixel size, which only the engine knows, and each ancestor
    needs its own rather than the child's.

    `bindings` maps a layer to its "transform" expression binding, and is a
    callable for the same reason `defaults` is: every ancestor in the chain needs
    its OWN, and handing one binding down would make a parent's wiggle share the
    child's seed and the child's cycle key.
    """
    chain = parent_chain(layer, by_id)
    m = IDENTITY.copy()
    for lay in reversed(chain):
        anchor_default, position_default = defaults(lay) if defaults else ((0.0, 0.0), (0.0, 0.0))
        m = mat_mul(m, transform_matrix(lay.get("transform"), t,
                                        anchor_default=anchor_default,
                                        position_default=position_default,
                                        ctx=bindings(lay) if bindings else None))
    return m


def scale_matrix(m, s):
    """The same mapping expressed in render pixels rather than comp pixels.

    Preview renders at half size by shrinking every bitmap; the linear part of an
    affine is scale-invariant under that, only the translation moves.
    """
    out = np.array(m, dtype=np.float64, copy=True)
    out[0, 2] *= s
    out[1, 2] *= s
    return out


def is_identity(m, tol=1e-6):
    return bool(np.abs(np.asarray(m, dtype=np.float64) - IDENTITY).max() <= tol)
