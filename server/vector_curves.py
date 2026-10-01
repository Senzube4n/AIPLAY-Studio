"""Bounded pixel-boundary tracing and cubic fitting. No application imports.

Dependencies: numpy, scipy, OpenCV (already present in the Studio image rig).
`trace_mask(mask, error=0.8, detail=1.0)` returns closed SVG contour strings.
Combine them in one path with fill-rule="evenodd" to retain counters/holes.

Errors and min_area are in input-mask pixels; there is no resolution reduction.
Corners are pinned before a bounded filter and least-squares cubic fitting.
Analytic ellipses are used only if the entire contour passes residual checks.
The pixel-cell outline gives single pixels and one-pixel strokes real area.
Component pruning precedes tracing, so holes of retained components survive.
"""
import math

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree

MAX_CONTOURS = 20000
MAX_POINTS = 500000
MAX_SEGMENTS = 100000


class TraceLimitError(ValueError):
    """A complex raster exceeds the bounded vector output budget."""


def _charge_segments(budget, count):
    if budget is None:
        return
    budget["segments"] = budget.get("segments", 0) + count
    if budget["segments"] > budget.get("max_segments", MAX_SEGMENTS):
        raise TraceLimitError("Trace exceeds the segment limit; lower colors or use Draft quality.")


def _unit(v):
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-12 else np.zeros(2, dtype=np.float64)


def _eval(c, t):
    t = np.asarray(t, dtype=np.float64)
    s = 1.0 - t
    return (s[..., None] ** 3 * c[0] + 3 * (s * s * t)[..., None] * c[1]
            + 3 * (s * t * t)[..., None] * c[2] + t[..., None] ** 3 * c[3])


def _parameters(p):
    d = np.linalg.norm(np.diff(p, axis=0), axis=1)
    u = np.r_[0.0, np.cumsum(d)]
    return u / u[-1] if u[-1] > 1e-12 else np.linspace(0.0, 1.0, len(p))


def _fit_one(p, t, left, right):
    s = 1.0 - t
    b = np.c_[s**3, 3*s*s*t, 3*s*t*t, t**3]
    a0 = b[:, 1, None] * left
    a1 = b[:, 2, None] * right
    residual = p - (b[:, :2].sum(axis=1)[:, None] * p[0]
                    + b[:, 2:].sum(axis=1)[:, None] * p[-1])
    system = np.array([[np.sum(a0*a0), np.sum(a0*a1)],
                       [np.sum(a0*a1), np.sum(a1*a1)]])
    rhs = np.array([np.sum(a0*residual), np.sum(a1*residual)])
    try:
        alpha = np.linalg.solve(system, rhs)
    except np.linalg.LinAlgError:
        alpha = np.zeros(2)
    chord = float(np.linalg.norm(p[-1] - p[0]))
    arc = float(np.linalg.norm(np.diff(p, axis=0), axis=1).sum())
    # Negative/reversed handles and extremely long handles can loop between
    # samples. Bound them independently of the parameter-point error test.
    if np.any(alpha < max(1e-7, chord*1e-6)) or np.any(alpha > arc*1.5):
        alpha[:] = chord / 3.0
    return np.array([p[0], p[0] + left*alpha[0], p[-1] + right*alpha[1], p[-1]])


def _reparameterize(p, c, t):
    q = _eval(c, t)
    s = 1-t
    d = (3*s[:, None]**2 * (c[1]-c[0])
         + 6*(s*t)[:, None]*(c[2]-c[1]) + 3*t[:, None]**2*(c[3]-c[2]))
    dd = 6*s[:, None]*(c[2]-2*c[1]+c[0]) + 6*t[:, None]*(c[3]-2*c[2]+c[1])
    den = np.sum(d*d + (q-p)*dd, axis=1)
    num = np.sum((q-p)*d, axis=1)
    good = np.abs(den) > 1e-10
    result = t.copy()
    result[good] -= num[good] / den[good]
    result[0], result[-1] = 0.0, 1.0
    if np.any(np.diff(result) <= 0) or np.any(result < 0) or np.any(result > 1):
        return t
    return result


def _point_polyline_dist2(q, p):
    # Exact local candidates, not an approximate nearest-point test. If a
    # segment is closer than the nearest midpoint distance, its midpoint is
    # at most that distance plus half the longest segment away. The radius
    # therefore includes every potentially closer segment. Tile queries to
    # bound allocations even when a pathological candidate is far outside.
    a = p[:-1]
    v = p[1:] - a
    vv = np.sum(v*v, axis=1)
    tree = cKDTree(a+v*.5)
    half_longest = float(np.sqrt(vv.max())*.5)
    result = np.full(len(q), np.inf)
    for start in range(0, len(q), 64):
        qs = q[start:start+64]
        nearest, _ = tree.query(qs)
        candidates = tree.query_ball_point(qs, nearest+half_longest+1e-9)
        query_ids = np.repeat(np.arange(len(qs)), [len(items) for items in candidates])
        edge_ids = np.concatenate(candidates).astype(np.intp)
        va, aa = v[edge_ids], a[edge_ids]
        t = np.sum((qs[query_ids]-aa)*va, axis=1)/np.maximum(vv[edge_ids], 1e-20)
        projected = aa+np.clip(t, 0, 1)[:, None]*va
        distances = np.sum((qs[query_ids]-projected)**2, axis=1)
        best = np.full(len(qs), np.inf)
        np.minimum.at(best, query_ids, distances)
        result[start:start+len(qs)] = best
    return result


def _fit_span(p, left, right, error, depth=0, budget=None):
    chord = p[-1]-p[0]
    squared = float(np.dot(chord, chord))
    if squared > 0:
        cross = chord[0]*(p[:, 1]-p[0, 1])-chord[1]*(p[:, 0]-p[0, 0])
        along = (p-p[0]) @ chord
        if np.max(np.abs(cross)) < 1e-8 and along.min() >= 0 and along.max() <= squared:
            _charge_segments(budget, 1)
            return [np.array([p[0], p[0]+chord/3, p[-1]-chord/3, p[-1]])]
    if len(p) == 2:
        d = float(np.linalg.norm(p[1]-p[0])) / 3.0
        _charge_segments(budget, 1)
        return [np.array([p[0], p[0]+left*d, p[1]+right*d, p[1]])]
    if len(p) > 2048:
        split = len(p)//2
        mid = _unit(p[split-1]-p[split+1])
        return (_fit_span(p[:split+1], left, mid, error, depth+1, budget)
                + _fit_span(p[split:], -mid, right, error, depth+1, budget))
    t = _parameters(p)
    best = None
    split = len(p)//2
    for iteration in range(5):
        c = _fit_one(p, t, left, right)
        residual = np.sum((_eval(c, t)-p)**2, axis=1)
        split = int(np.argmax(residual))
        best = float(residual[split])
        if best <= error**2:
            # Checking points alone admits thin-branch bulges between samples.
            # Densify the candidate and check the opposite Hausdorff direction.
            length = np.linalg.norm(np.diff(c, axis=0), axis=1).sum()
            n = min(1024, max(12, int(math.ceil(length / max(.3, error*.5)))))
            qs = _eval(c, np.linspace(0, 1, n))
            reverse = _point_polyline_dist2(qs, p)
            if float(reverse.max()) <= error**2:
                _charge_segments(budget, 1)
                return [c]
            # The reverse error may lie between data points; split near it.
            qbad = qs[int(np.argmax(reverse))]
            split = int(np.argmin(np.sum((p-qbad)**2, axis=1)))
            break
        if iteration == 4 or best > (error*4)**2:
            break
        t = _reparameterize(p, c, t)
    split = max(1, min(len(p)-2, split))
    if depth > 48:
        # Hard bound: a pathological input keeps faithful small line cubics.
        result = []
        _charge_segments(budget, len(p)-1)
        for a, b in zip(p[:-1], p[1:]):
            result.append(np.array([a, a+(b-a)/3, b-(b-a)/3, b]))
        return result
    mid = _unit(p[split-1]-p[split+1])
    return (_fit_span(p[:split+1], left, mid, error, depth+1, budget)
            + _fit_span(p[split:], -mid, right, error, depth+1, budget))


def _corner_indices(p, detail=1.0):
    n = len(p)
    before, after = p-np.roll(p, 1, axis=0), np.roll(p, -1, axis=0)-p
    turns = before[:, 0]*after[:, 1]-before[:, 1]*after[:, 0]
    indices = np.flatnonzero(np.abs(turns) > 1e-12)
    if len(indices) <= 4:
        return [int(i) for i in indices]
    if n < 12:
        return [int(i) for i in indices]
    # A raster staircase has 90-degree *one-pixel* turns. They are not corners.
    # Require a turn to agree over two wider supports before pinning it.
    angles = []
    support = max(2, min(8, int(round(4/math.sqrt(detail)))))
    for step in (support, min(max(support+1, int(round(9/math.sqrt(detail)))), max(support, n//8))):
        before, after = p-np.roll(p, step, axis=0), np.roll(p, -step, axis=0)-p
        den = np.linalg.norm(before, axis=1)*np.linalg.norm(after, axis=1)
        cosine = np.sum(before*after, axis=1) / np.maximum(den, 1e-20)
        angles.append(np.arccos(np.clip(cosine, -1, 1)))
    score = np.minimum(*angles)
    candidates = np.flatnonzero(score > 0.92)
    order = sorted(candidates, key=lambda i: (-score[i], i))
    selected = []
    for i in order:
        if all(min((i-j)%n, (j-i)%n) > max(2, support+2) for j in selected):
            selected.append(int(i))
    return sorted(selected)


def _smooth(p, corners, bound):
    filtered = gaussian_filter1d(p, 1.3, axis=0, mode="wrap")
    move = filtered-p
    length = np.linalg.norm(move, axis=1)
    move *= np.minimum(1.0, bound/np.maximum(length, 1e-20))[:, None]
    # Preserve both each corner and nearby straight runs. This prevents a
    # bounded filter turning a crisp cap brim/slash tip into a rounded tip.
    for i in corners:
        for j in range(-4, 5):
            move[(i+j)%len(p)] = 0
    return p+move


def _ellipse(p, tolerance):
    if len(p) < 30:
        return None
    try:
        (x, y), (diam0, diam1), angle = cv2.fitEllipse(p.astype(np.float32))
    except cv2.error:
        return None
    r = np.array([diam0/2.0, diam1/2.0])
    if r.min() < 3 or r.max()/r.min() > 12:
        return None
    a = math.radians(angle)
    rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    local = (p-np.array([x, y])) @ rot
    # First-order Euclidean distance to the ellipse, not an unscaled unit-
    # ellipse residual. The threshold therefore retains its meaning in px.
    f = (local[:, 0]/r[0])**2 + (local[:, 1]/r[1])**2 - 1
    g = 2*np.sqrt((local[:, 0]/r[0]**2)**2 + (local[:, 1]/r[1]**2)**2)
    residual = np.abs(f) / np.maximum(g, 1e-20)
    rms = float(np.sqrt(np.mean(residual**2)))
    maximum = float(residual.max())
    # Require evenly complete circumference too. A C, rounded rectangle or
    # partial arc cannot qualify just because least squares found an ellipse.
    theta = np.mod(np.arctan2(local[:, 1]/r[1], local[:, 0]/r[0]), 2*math.pi)
    gaps = np.diff(np.r_[np.sort(theta), theta.min()+2*math.pi])
    if rms > min(.45, tolerance*.6) or maximum > min(1.0, tolerance*.95) or gaps.max() > .25:
        return None
    # Eight 45-degree cubic pieces make analytic-ellipse approximation error
    # negligible even on a 4k badge; a four-cubic circle would drift ~0.5px.
    result = []
    center = np.array([x, y])
    step = math.pi/4
    k = 4.0/3.0*math.tan(step/4)
    for i in range(8):
        a0, a1 = i*step, (i+1)*step
        e0 = np.array([math.cos(a0), math.sin(a0)])*r
        e1 = np.array([math.cos(a1), math.sin(a1)])*r
        t0 = np.array([-math.sin(a0), math.cos(a0)])*r
        t1 = np.array([-math.sin(a1), math.cos(a1)])*r
        result.append(np.array([e0, e0+k*t0, e1-k*t1, e1]) @ rot.T + center)
    return result


def _format(v):
    return f"{v:.3f}".rstrip("0").rstrip(".")


def _svg(cubics):
    if not cubics:
        return ""
    p = cubics[0][0]
    commands = [f"M{_format(p[0])},{_format(p[1])}"]
    for c in cubics:
        # Keep true straight segments as lines. All curved pieces remain C.
        chord = c[3]-c[0]
        diff = c[1:3]-c[0]
        cross = chord[0]*diff[:, 1]-chord[1]*diff[:, 0]
        if np.max(np.abs(cross)) < 1e-7:
            commands.append(f"L{_format(c[3,0])},{_format(c[3,1])}")
        else:
            commands.append("C"+" ".join(f"{_format(x)},{_format(y)}" for x, y in c[1:]))
    return "".join(commands)+"Z"


def _pixel_boundaries(binary, max_points=MAX_POINTS, max_contours=MAX_CONTOURS):
    """Directed edges of the union of foreground pixel cells, including holes.

    A right turn at a diagonal contact keeps the two touching cell outlines
    separate rather than producing a self-intersecting figure-eight path.
    """
    h, w = binary.shape
    padded = np.pad(binary.astype(bool), 1)
    inside = padded[1:-1, 1:-1]
    exposed = [inside & ~padded[:-2, 1:-1], inside & ~padded[1:-1, 2:],
               inside & ~padded[2:, 1:-1], inside & ~padded[1:-1, :-2]]
    count = sum(int(np.count_nonzero(a)) for a in exposed)
    if count > max_points:
        raise TraceLimitError("Trace exceeds the boundary-point limit; lower colors or use Draft quality.")
    if not count:
        return []
    starts, ends, directions = [], [], []
    stride = w+1
    for direction, visible in enumerate(exposed):
        y, x = np.nonzero(visible)
        if direction == 0:
            sx, sy, ex, ey = x, y, x+1, y
        elif direction == 1:
            sx, sy, ex, ey = x+1, y, x+1, y+1
        elif direction == 2:
            sx, sy, ex, ey = x+1, y+1, x, y+1
        else:
            sx, sy, ex, ey = x, y+1, x, y
        starts.append(sy*stride+sx)
        ends.append(ey*stride+ex)
        directions.append(np.full(len(x), direction, np.uint8))
    starts, ends, directions = np.concatenate(starts), np.concatenate(ends), np.concatenate(directions)
    outgoing = {}
    for i, key in enumerate(starts):
        outgoing.setdefault(int(key), []).append(i)
    used = np.zeros(count, dtype=bool)
    contours = []
    for first in range(count):
        if used[first]:
            continue
        if len(contours) >= max_contours:
            raise TraceLimitError("Trace exceeds the contour limit; raise Minimum area or use Draft quality.")
        points = []
        edge = first
        while not used[edge]:
            used[edge] = True
            key = int(starts[edge])
            points.append((key % stride, key // stride))
            end = int(ends[edge])
            if end == int(starts[first]):
                break
            candidates = [i for i in outgoing.get(end, []) if not used[i]]
            if not candidates:
                raise ValueError("Cannot close a raster boundary.")
            order = {1: 0, 0: 1, 3: 2, 2: 3}
            edge = min(candidates, key=lambda i: (order[(int(directions[i])-int(directions[edge])) % 4], i))
        contours.append(np.asarray(points, dtype=np.float64))
    return contours


def trace_mask(mask, error=0.8, detail=1.0, min_area=1.0, analytic=True,
               return_info=False, limits=None):
    """Trace a binary mask with an independent error budget and detail control.

    `min_area` is connected-component pixel area, never hole area. Higher
    `detail` reduces filtering and the support used to detect real corners;
    it does not change `error`. Integer 0..255 masks are accepted.
    """
    m = np.asarray(mask)
    if m.ndim != 2 or not m.size:
        raise ValueError("mask must be a nonempty 2-D array")
    tolerance = float(error)
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise ValueError("error must be positive and finite")
    detail = float(detail)
    if not math.isfinite(detail) or detail <= 0:
        raise ValueError("detail must be positive and finite")
    min_area = float(min_area)
    if not math.isfinite(min_area) or min_area < 0:
        raise ValueError("min_area must be nonnegative and finite")
    threshold = 127.5 if m.dtype.kind in "ui" and m.max() > 1 else .5
    binary = np.ascontiguousarray((m > threshold).astype(np.uint8))
    removed = 0
    if min_area > 1 and np.any(binary):
        n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=4)
        keep = np.r_[False, stats[1:, cv2.CC_STAT_AREA] >= min_area]
        removed = int(np.count_nonzero(~keep[1:]))
        binary = keep[labels].astype(np.uint8)
    limits = limits or {}
    contours = _pixel_boundaries(binary, limits.get("points", MAX_POINTS), limits.get("contours", MAX_CONTOURS))
    smoothing_bound = min(.45, tolerance*.35) / math.sqrt(detail)
    smoothing_bound = min(tolerance*.5, smoothing_bound)
    fitting_tolerance = tolerance-smoothing_bound
    output = []
    info = {"width": int(m.shape[1]), "height": int(m.shape[0]),
            "tolerance": tolerance, "fitting_tolerance": fitting_tolerance,
            "smoothing_bound": smoothing_bound, "contours": [], "source_points": 0,
            "segments": 0, "ellipses": 0, "removed_components": removed}
    budget = {"segments": 0, "max_segments": limits.get("segments", MAX_SEGMENTS)}
    for p in contours:
        info["source_points"] += len(p)
        signed_area = float(np.sum(p[:, 0]*np.roll(p[:, 1], -1)-p[:, 1]*np.roll(p[:, 0], -1))*.5)
        curves = _ellipse(p, tolerance) if analytic else None
        is_ellipse = curves is not None
        corner_count = 0
        if curves is not None:
            _charge_segments(budget, len(curves))
        else:
            corners = _corner_indices(p, detail)
            corner_count = len(corners)
            q = _smooth(p, corners, smoothing_bound)
            if not corners:
                first = int(np.argmin(q[:, 0]+q[:, 1]))
                far = int(np.argmax(np.sum((q-q[first])**2, axis=1)))
                corners = sorted({first, far})
                artificial = True
            else:
                artificial = False
            curves = []
            for j, first in enumerate(corners):
                last = corners[(j+1)%len(corners)]
                ids = np.arange(first, last+1 if last > first else last+len(q)+1)%len(q)
                span = q[ids]
                if len(span) < 2:
                    continue
                if artificial:
                    left = _unit(q[(first+2)%len(q)]-q[(first-2)%len(q)])
                    right = _unit(q[(last-2)%len(q)]-q[(last+2)%len(q)])
                else:
                    reach = min(3, len(span)-1)
                    left = _unit(span[reach]-span[0])
                    right = _unit(span[-1-reach]-span[-1])
                curves.extend(_fit_span(span, left, right, fitting_tolerance, budget=budget))
        d = _svg(curves)
        if d:
            output.append(d)
            info["segments"] += len(curves)
            info["ellipses"] += int(is_ellipse)
            lo, hi = p.min(axis=0), p.max(axis=0)
            info["contours"].append({"bounds": [float(lo[0]), float(lo[1]),
                                                float(hi[0]-lo[0]), float(hi[1]-lo[1])],
                                     "area": abs(signed_area), "hole": signed_area < 0,
                                     "source_points": len(p), "segments": len(curves),
                                     "corners": corner_count, "ellipse": is_ellipse})
    if return_info:
        # Keep holes tied to their foreground shape for selected fills/shadows.
        # The local import avoids a module-level cycle with cleanup's fitter.
        from vector_cleanup import parent_indices
        for item, parent in zip(info["contours"], parent_indices(contours)):
            item["parent"] = parent
    return (output, info) if return_info else output

