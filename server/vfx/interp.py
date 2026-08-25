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

Nothing here touches disk or PIL — engine_test.py exercises it directly.
"""
from __future__ import annotations

import math

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


def eval_prop(prop, t, default=None):
    """The value of an animatable property at comp time t.

    A constant returns itself. A { "keys": [...] } object is sampled: before the
    first key it holds the first value, after the last it holds the last, and
    between two keys the easing on the LEFT key shapes the segment (easing
    describes the segment leaving a key, which is why "hold" reads as "this key
    holds until the next one").

    Non-numeric values (an enum string, a colour name, a nested dict that is not
    a keyframe track) pass straight through — effect params carry those too and
    the engine should not have to sort them out first.
    """
    if not isinstance(prop, dict):
        return _plain(prop) if prop is not None else default
    keys = prop.get("keys")
    if not isinstance(keys, list):
        return prop
    keys = [k for k in keys if isinstance(k, dict) and "v" in k]
    if not keys:
        return default
    # Sorting on read rather than on write: the document is edited from three
    # places (UI, MCP, hand) and only one of them is careful.
    keys = sorted(keys, key=lambda k: _num(k.get("t")))
    if len(keys) == 1:
        return _plain(keys[0]["v"])

    tf = _num(t)
    if tf <= _num(keys[0].get("t")):
        return _plain(keys[0]["v"])
    if tf >= _num(keys[-1].get("t")):
        return _plain(keys[-1]["v"])

    i = 0
    for j in range(len(keys) - 1):
        if _num(keys[j].get("t")) <= tf:
            i = j
    a, b = keys[i], keys[i + 1]
    t0, t1 = _num(a.get("t")), _num(b.get("t"))
    span = t1 - t0
    if span <= 1e-9:
        return _plain(b["v"])
    u = _ease_fraction(a.get("ease"), (tf - t0) / span)
    return _mix(a["v"], b["v"], u)


# The spec names this evalProp; the repo writes python snake_case. Both work so
# neither side of the contract has to translate.
evalProp = eval_prop


def eval_params(params, t):
    """Every value in an effect's param dict, sampled at t.

    Enums and booleans fall through untouched — only the tracks resolve.
    """
    if not isinstance(params, dict):
        return {}
    return {k: eval_prop(v, t) for k, v in params.items()}


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


def transform_matrix(transform, t, anchor_default=(0.0, 0.0), position_default=(0.0, 0.0)):
    """One layer's own transform as a 2x3 affine mapping LAYER px -> COMP px.

    Composed anchor-last: translate(position) . rotate . scale . translate(-anchor),
    so the anchor is what rotation and scale pivot around and it lands exactly on
    the position. Rotation is degrees CLOCKWISE — with y pointing down the screen
    the textbook matrix already turns that way, so there is no sign flip here.
    """
    transform = transform if isinstance(transform, dict) else {}
    ax, ay = _pair(eval_prop(transform.get("anchor"), t), anchor_default)
    px, py = _pair(eval_prop(transform.get("position"), t), position_default)
    sx, sy = _pair(eval_prop(transform.get("scale"), t), (100.0, 100.0))
    rot = _num(eval_prop(transform.get("rotation"), t), 0.0)

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


def world_matrix(layer, by_id, t, defaults=None):
    """A layer's transform with its parent chain applied — LAYER px -> COMP px.

    Outermost ancestor first, so a child's position/rotation are expressed in its
    parent's space exactly the way AE's parent switch behaves. Opacity is NOT in
    here: parenting inherits geometry only, and a child of a 0% layer still shows.

    `defaults` maps a layer to its (anchor, position) fallbacks — those depend on
    the layer's own pixel size, which only the engine knows, and each ancestor
    needs its own rather than the child's.
    """
    chain = parent_chain(layer, by_id)
    m = IDENTITY.copy()
    for lay in reversed(chain):
        anchor_default, position_default = defaults(lay) if defaults else ((0.0, 0.0), (0.0, 0.0))
        m = mat_mul(m, transform_matrix(lay.get("transform"), t,
                                        anchor_default=anchor_default,
                                        position_default=position_default))
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
