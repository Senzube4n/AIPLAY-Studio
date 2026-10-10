"""Opt-in, selected-contour cleanup for the CPU vectorizer.

This is reconstruction, not another faithful trace profile. The caller first
traces a raster, inspects its per-palette contour inventory, then selects exact
contour indexes. Unselected paths keep the original tracer's output. Primitive
fits must stay inside the requested deviation and every operation must retain
the baseline SVG objects' component and hole counts. Lettering is never replaced
with fonts, holes are never discarded, and shape types are never guessed.

All library coordinates and tolerances are in input-mask pixels. The image
adapter scales source-pixel controls before calling ``cleanup_mask``.
"""
import math
import re

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.optimize import least_squares
from scipy.spatial import cKDTree

import vector_curves as vc

MAX_OPERATIONS = 32
MAX_SELECTED_CONTOURS = 128
MAX_VALIDATION_CROSSINGS = 8_000_000
SAMPLE_SPACING = .5
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _number(value, name, default, low, high):
    if value is None:
        value = default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    number = float(value)
    if not math.isfinite(number) or not low <= number <= high:
        raise ValueError(f"{name} must be a number from {low} to {high}")
    return number


def normalize_cleanup(value):
    """Validate the public JSON contract; bounds use source pixels here."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"operations"}:
        raise ValueError("cleanup must contain only operations")
    operations = value["operations"]
    if not isinstance(operations, list) or not 0 <= len(operations) <= MAX_OPERATIONS:
        raise ValueError(f"cleanup.operations needs 0 to {MAX_OPERATIONS} operations")
    result, selected = [], set()
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("Each cleanup operation must be an object")
        kind = operation.get("type")
        if kind not in ("smooth", "circle", "concentric", "parallelogram"):
            raise ValueError("Cleanup type must be smooth, circle, concentric or parallelogram")
        allowed = {"type", "color", "contours", "maxDeviation"}
        if kind == "smooth":
            allowed.add("strength")
        if set(operation)-allowed:
            raise ValueError("Unknown cleanup operation field: "+", ".join(sorted(set(operation)-allowed)))
        color = operation.get("color")
        if not isinstance(color, str) or not _HEX.fullmatch(color):
            raise ValueError("Cleanup color must use #rrggbb")
        color = color.lower()
        indexes = operation.get("contours")
        if not isinstance(indexes, list) or not 1 <= len(indexes) <= MAX_SELECTED_CONTOURS:
            raise ValueError(f"Cleanup contours needs 1 to {MAX_SELECTED_CONTOURS} indexes")
        if any(isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < vc.MAX_CONTOURS for i in indexes):
            raise ValueError("Cleanup contour indexes must be nonnegative integers")
        if len(set(indexes)) != len(indexes):
            raise ValueError("Cleanup contour indexes must be unique")
        if any((color, i) in selected for i in indexes):
            raise ValueError("A contour can be selected by only one cleanup operation")
        selected.update((color, i) for i in indexes)
        if kind in ("circle", "parallelogram") and len(indexes) != 1:
            raise ValueError(f"{kind} cleanup selects exactly one contour")
        if kind == "concentric" and not 2 <= len(indexes) <= 16:
            raise ValueError("Concentric cleanup selects 2 to 16 complete circular contours")
        parsed = {"type": kind, "color": color, "contours": indexes.copy(),
                  "maxDeviation": _number(operation.get("maxDeviation"), "maxDeviation", 4, .5, 32)}
        if kind == "smooth":
            parsed["strength"] = _number(operation.get("strength"), "strength", .7, 0, 1)
        result.append(parsed)
    return {"operations": result}


def _binary(mask, min_area):
    raw = np.asarray(mask)
    threshold = 127.5 if raw.dtype.kind in "ui" and raw.max() > 1 else .5
    binary = np.ascontiguousarray((raw > threshold).astype(np.uint8))
    if min_area > 1 and np.any(binary):
        _, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=4)
        binary = np.r_[False, stats[1:, cv2.CC_STAT_AREA] >= min_area][labels].astype(np.uint8)
    return binary


def _corners(points, support):
    n = len(points)
    if n < 12:
        return vc._corner_indices(points)
    angles = []
    for reach in (support, min(support*2, max(support, n//6))):
        before = points-np.roll(points, reach, axis=0)
        after = np.roll(points, -reach, axis=0)-points
        norm = np.linalg.norm(before, axis=1)*np.linalg.norm(after, axis=1)
        angles.append(np.arccos(np.clip(np.sum(before*after, axis=1)/np.maximum(norm, 1e-20), -1, 1)))
    scores = np.minimum(*angles)
    candidates = np.flatnonzero(scores > .82)
    selected = []
    for index in sorted(candidates, key=lambda i: (-scores[i], i)):
        if all(min((index-j)%n, (j-index)%n) > support for j in selected):
            selected.append(int(index))
    return sorted(selected)


def _clamp(candidate, original, bound):
    move = candidate-original
    lengths = np.linalg.norm(move, axis=1)
    return original+move*np.minimum(1., bound/np.maximum(lengths, 1e-20))[:, None]


def _nearby_clearance(points, support, context=None, contour_index=None):
    if context is None:
        tree, owners, starts = cKDTree(points), np.zeros(len(points), dtype=int), [0]
        contour_index = 0
    else:
        tree, owners, starts = context
    distance, ids = tree.query(points, k=min(64, tree.n))
    if distance.ndim == 1:
        distance, ids = distance[:, None], ids[:, None]
    local = ids-starts[contour_index]
    delta = np.abs(local-np.arange(len(points))[:, None])
    arc_distance = np.minimum(delta, np.abs(len(points)-delta))
    adjacent = (owners[ids] == contour_index) & (arc_distance <= max(8, support*2))
    distance[adjacent] = np.inf
    return distance.min(axis=1)


def _smooth(points, maximum, strength, detail, budget, spacing=SAMPLE_SPACING,
            clearance_context=None, contour_index=None):
    small_side = float(np.ptp(points, axis=0).min())
    support = max(2, min(len(points)//6, int(round(np.clip(min(small_side*.07, maximum*3), 3, 24)))))
    corners = _corners(points, support)
    # Keep small features and sharp waveform/counter junctions pinned. Stronger
    # filtering applies between them and uses shape-scale tangent supports.
    sigma = max(.8, min(support*.55, maximum*1.2))*strength/math.sqrt(detail)
    smoothing_bound = maximum*.65*strength
    candidate = _clamp(gaussian_filter1d(points, sigma, axis=0, mode="wrap"), points, smoothing_bound)
    clearance = _nearby_clearance(points, support, clearance_context, contour_index)
    move = candidate-points
    lengths = np.linalg.norm(move, axis=1)
    candidate = points+move*np.minimum(1., clearance*.12/np.maximum(lengths, 1e-20))[:, None]
    weights = np.ones(len(points))
    protected = min(support, max(3, int(math.ceil(sigma*2))))
    for corner in corners:
        for offset in range(-protected, protected+1):
            weight = 0. if abs(offset) <= 2 else (abs(offset)-2)/max(1, protected-2)
            index = (corner+offset)%len(points)
            weights[index] = min(weights[index], weight)
    candidate = points+(candidate-points)*weights[:, None]
    artificial = not corners
    if artificial:
        first = int(np.argmin(candidate[:, 0]+candidate[:, 1]))
        far = int(np.argmax(np.sum((candidate-candidate[first])**2, axis=1)))
        corners = sorted({first, far})
    curves, straight_segments = [], 0
    perimeter = float(np.linalg.norm(points-np.roll(points, 1, axis=0), axis=1).sum())
    # Reducing strength also tightens fitting around fragile narrow features;
    # otherwise a low-strength request could still invent a tiny cubic loop.
    tolerance = max(1e-4, maximum*.25*strength)
    for first, last in zip(corners, corners[1:]+corners[:1]):
        ids = np.arange(first, last+1 if last > first else last+len(points)+1)%len(points)
        span = candidate[ids]
        if len(span) < 2:
            continue
        chord = span[-1]-span[0]
        length = float(np.linalg.norm(chord))
        span_clearance = float(clearance[ids].min())
        if not artificial and length > max(12, maximum*3, perimeter*.05) and span_clearance > maximum*1.5:
            distance = np.abs(chord[0]*(span[:, 1]-span[0, 1])-chord[1]*(span[:, 0]-span[0, 0]))/length
            along = (span-span[0]) @ chord/length
            if (distance.max() <= maximum*.55*strength and np.sqrt(np.mean(distance**2)) <= maximum*.3*strength
                    and along.min() >= -maximum*.1 and along.max() <= length+maximum*.1):
                vc._charge_segments(budget, 1)
                curves.append(np.array([span[0], span[0]+chord/3, span[-1]-chord/3, span[-1]]))
                straight_segments += 1
                continue
        if artificial:
            reach = min(support, max(1, len(points)//8))
            left = vc._unit(candidate[(first+reach)%len(points)]-candidate[(first-reach)%len(points)])
            right = vc._unit(candidate[(last-reach)%len(points)]-candidate[(last+reach)%len(points)])
        else:
            reach = min(support, len(span)-1)
            left = vc._unit(span[reach]-span[0])
            right = vc._unit(span[-1-reach]-span[-1])
        safe_tolerance = min(tolerance, max(.015, span_clearance*.12))
        curves.extend(vc._fit_span(span, left, right, safe_tolerance, budget=budget))
    return vc._svg(curves), _sample_curves(curves, spacing), {
        "protectedCorners": len(corners) if not artificial else 0,
        "maxFilteredPointMove": float(np.linalg.norm(candidate-points, axis=1).max()),
        "smoothingSigma": sigma, "segments": len(curves), "straightSegments": straight_segments,
        "protectedThinFeaturePoints": int(np.count_nonzero(clearance < maximum*1.5))}


def _sample_curves(curves, spacing=SAMPLE_SPACING):
    points = []
    for curve in curves:
        length = float(np.linalg.norm(np.diff(curve, axis=0), axis=1).sum())
        count = max(4, int(math.ceil(length/spacing))+1)
        if count > vc.MAX_POINTS:
            raise vc.TraceLimitError("Cleanup curve sampling exceeds the point limit")
        points.append(vc._eval(curve, np.linspace(0, 1, count)))
    if sum(len(p) for p in points) > vc.MAX_POINTS:
        raise vc.TraceLimitError("Cleanup curve sampling exceeds the point limit")
    return np.concatenate(points) if points else np.empty((0, 2))


def _sample_path(path):
    """Sample the base tracer's M/L/C/Z grammar for topology comparison."""
    curves, position, start = [], None, None
    for command, raw in re.findall(r"([MLCZ])([^MLCZ]*)", path):
        if command == "Z":
            if np.linalg.norm(position-start) > 1e-9:
                delta = start-position
                curves.append(np.array([position, position+delta/3, start-delta/3, start]))
            position = start
            continue
        xy = np.asarray([float(v) for v in re.findall(r"[-+]?\d*\.?\d+", raw)]).reshape(-1, 2)
        if command == "M":
            position, start = xy[0], xy[0].copy()
        elif command == "L":
            delta = xy[0]-position
            curves.append(np.array([position, position+delta/3, xy[0]-delta/3, xy[0]]))
            position = xy[0]
        else:
            curves.append(np.r_[position[None, :], xy])
            position = xy[-1]
    return _sample_curves(curves)


def _circle_path(center, radius):
    x, y = center
    f = vc._format
    return (f"M{f(x-radius)},{f(y)}A{f(radius)},{f(radius)} 0 1 0 {f(x+radius)},{f(y)}"
            f"A{f(radius)},{f(radius)} 0 1 0 {f(x-radius)},{f(y)}Z")


def _fit_circles(contours, spacing=SAMPLE_SPACING):
    # Subsampling caps the optimizer's allocation without affecting the final
    # residual check, which always uses every original boundary point.
    samples = [p[::max(1, int(math.ceil(len(p)/4096)))] for p in contours]
    centers, radii = [], []
    for p in samples:
        if len(p) < 8:
            raise ValueError("Circular cleanup requires a complete circular outline")
        try:
            (x, y), (a, b), _ = cv2.fitEllipse(p.astype(np.float32))
        except cv2.error:
            raise ValueError("Circular cleanup could not fit the selected outline") from None
        if min(a, b) < 2 or max(a, b)/min(a, b) > 1.25:
            raise ValueError("Selected contour is not close to a circle")
        centers.append([x, y])
        radii.append((a+b)/4)
    initial = np.r_[np.mean(centers, axis=0), radii]
    def residual(parameters):
        return np.concatenate([np.linalg.norm(p-parameters[:2], axis=1)-r
                               for p, r in zip(samples, parameters[2:])])
    fit = least_squares(residual, initial, loss="soft_l1", f_scale=1., max_nfev=100)
    center, radii = fit.x[:2], fit.x[2:]
    if not fit.success or np.any(radii <= 1):
        raise ValueError("Circular cleanup could not find a stable fit")
    result = []
    for points, radius in zip(contours, radii):
        angles = np.mod(np.arctan2(points[:, 1]-center[1], points[:, 0]-center[0]), 2*math.pi)
        sorted_angles = np.sort(angles)
        if np.diff(np.r_[sorted_angles, sorted_angles[0]+2*math.pi]).max() > .25:
            raise ValueError("Circular cleanup requires a complete circumference")
        count = max(48, int(math.ceil(2*math.pi*radius/spacing)))
        if count > vc.MAX_POINTS:
            raise vc.TraceLimitError("Circular cleanup sampling exceeds the point limit")
        theta = np.linspace(0, 2*math.pi, count, endpoint=False)
        sample = center+radius*np.c_[np.cos(theta), np.sin(theta)]
        result.append((_circle_path(center, radius), sample,
                       {"center": center.tolist(), "radius": float(radius), "segments": 2}))
    return result


def _quad_vertices(parameters):
    center, u, v = parameters[:2], parameters[2:4], parameters[4:6]
    return np.array([center-u-v, center+u-v, center+u+v, center-u+v])


def _fit_parallelogram(points, maximum, spacing=SAMPLE_SPACING):
    poly = None
    for epsilon in sorted({1., 2., maximum*.25, maximum*.5, maximum, maximum*1.5}):
        candidate = cv2.approxPolyDP(points.astype(np.float32), epsilon, True).reshape(-1, 2)
        if len(candidate) == 4 and cv2.isContourConvex(candidate):
            poly = candidate.astype(float)
            break
    if poly is None:
        raise ValueError("Parallelogram cleanup requires one complete four-sided contour")
    center = poly.mean(axis=0)
    u = ((poly[1]-poly[0])+(poly[2]-poly[3]))/4
    v = ((poly[3]-poly[0])+(poly[2]-poly[1]))/4
    initial = np.r_[center, u, v]
    vertices = _quad_vertices(initial)
    sample = points[::max(1, int(math.ceil(len(points)/8000)))]
    edge_start = vertices
    edge_vector = np.roll(vertices, -1, axis=0)-vertices
    delta = sample[:, None, :]-edge_start[None, :, :]
    along = np.sum(delta*edge_vector[None, :, :], axis=2)/np.sum(edge_vector**2, axis=1)[None, :]
    projected = edge_start[None, :, :]+np.clip(along, 0, 1)[..., None]*edge_vector[None, :, :]
    assignment = np.argmin(np.sum((sample[:, None, :]-projected)**2, axis=2), axis=1)
    def residual(parameters):
        q = _quad_vertices(parameters)
        edges = np.roll(q, -1, axis=0)-q
        origins, vectors = q[assignment], edges[assignment]
        difference = sample-origins
        return (vectors[:, 0]*difference[:, 1]-vectors[:, 1]*difference[:, 0])/np.maximum(np.linalg.norm(vectors, axis=1), 1e-20)
    fit = least_squares(residual, initial, loss="soft_l1", f_scale=1., max_nfev=100)
    vertices = _quad_vertices(fit.x)
    edges = np.roll(vertices, -1, axis=0)-vertices
    lengths = np.linalg.norm(edges, axis=1)
    sine = abs(float(edges[0, 0]*edges[1, 1]-edges[0, 1]*edges[1, 0]))/max(1e-20, lengths[0]*lengths[1])
    if not fit.success or lengths.min() < 2 or sine < .03:
        raise ValueError("Parallelogram cleanup could not find a stable nondegenerate fit")
    samples = []
    for start, edge, length in zip(vertices, edges, lengths):
        samples.append(start+np.linspace(0, 1, max(2, int(math.ceil(length/spacing))+1))[:, None]*edge)
    f = vc._format
    path = "M"+"L".join(f"{f(x)},{f(y)}" for x, y in vertices)+"Z"
    return path, np.concatenate(samples), {"corners": vertices.tolist(), "segments": 4, "protectedCorners": 4}


def _distances(original, candidate):
    closed_original = np.r_[original, original[:1]]
    closed_candidate = np.r_[candidate, candidate[:1]]
    source_to_curve = float(np.sqrt(vc._point_polyline_dist2(original, closed_candidate).max()))
    curve_to_source = float(np.sqrt(vc._point_polyline_dist2(candidate, closed_original).max()))
    return source_to_curve, curve_to_source


def _crossings(points, shape, origin, scale, remaining=None):
    if len(points) < 3:
        return np.empty(0, dtype=int), np.empty(0)
    points = (points-np.asarray(origin))*scale
    ends = np.roll(points, -1, axis=0)
    dy = ends[:, 1]-points[:, 1]
    selected = np.abs(dy) > 1e-12
    starts, ends, dy = points[selected], ends[selected], dy[selected]
    # Evaluate pixel centers with an exact polygon scanline. OpenCV's
    # inclusive-edge painter can invent pinholes around one-pixel diagonal
    # gaps, even when given an unchanged pixel-cell source boundary.
    low = np.maximum(0, np.ceil(np.minimum(starts[:, 1], ends[:, 1])-.5)).astype(int)
    high = np.minimum(shape[0]-1, np.ceil(np.maximum(starts[:, 1], ends[:, 1])-.5)-1).astype(int)
    counts = np.maximum(0, high-low+1)
    total = int(counts.sum())
    if total > (MAX_VALIDATION_CROSSINGS if remaining is None else remaining):
        raise vc.TraceLimitError("Cleanup topology validation exceeds the crossing limit; select fewer or simpler contours")
    if not total:
        return np.empty(0, dtype=int), np.empty(0)
    edges = np.repeat(np.arange(len(starts)), counts)
    offsets = np.repeat(np.cumsum(counts)-counts, counts)
    rows = np.repeat(low, counts)+np.arange(total)-offsets
    crossing = starts[edges, 0]+((rows+.5)-starts[edges, 1])*(ends[edges, 0]-starts[edges, 0])/dy[edges]
    return rows, crossing


def _rasterize(samples, shape, origin=(0, 0), scale=1, groups=None):
    """Even-odd within each object's compound outline; union across objects."""
    mask = np.zeros(shape, np.uint8)
    groups = [list(range(len(samples)))] if groups is None else groups
    crossings_used = 0
    for group in groups:
        pairs = []
        for index in group:
            pair = _crossings(samples[index], shape, origin, scale, MAX_VALIDATION_CROSSINGS-crossings_used)
            crossings_used += len(pair[0])
            pairs.append(pair)
        if not pairs:
            continue
        rows = np.concatenate([pair[0] for pair in pairs])
        crossing = np.concatenate([pair[1] for pair in pairs])
        if not len(rows):
            continue
        order = np.lexsort((crossing, rows))
        rows, crossing = rows[order], crossing[order]
        row_counts = np.bincount(rows, minlength=shape[0])
        row_start = np.r_[0, np.cumsum(row_counts)[:-1]]
        for row in np.flatnonzero(row_counts):
            xs = crossing[row_start[row]:row_start[row]+row_counts[row]]
            if len(xs)%2:
                raise ValueError("Cannot validate cleanup polygon crossings")
            for left, right in zip(xs[::2], xs[1::2]):
                first = max(0, int(math.ceil(left-.5)))
                last = min(shape[1], int(math.ceil(right-.5)))
                if last > first:
                    mask[row, first:last] = 1
    return mask


def _topology(mask):
    components = cv2.connectedComponents(mask, connectivity=4)[0]-1
    _, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    holes = 0 if hierarchy is None else int(np.count_nonzero(hierarchy[0, :, 3] >= 0))
    return int(components), holes


def parent_indices(contours):
    """Find each hole's smallest containing foreground contour.

    Only nesting metadata is returned; point order/indexes are unchanged. A
    child hole must share its parent's fill in an even-odd path. Foreground
    islands inside a hole are independent foreground contours.
    """
    result = [None]*len(contours)
    if not contours:
        return result
    areas = np.array([float(np.sum(p[:, 0]*np.roll(p[:, 1], -1)-p[:, 1]*np.roll(p[:, 0], -1))*.5)
                      for p in contours])
    low = np.array([p.min(axis=0) for p in contours])
    high = np.array([p.max(axis=0) for p in contours])
    foreground = areas > 0
    for index in np.flatnonzero(areas < 0):
        p = contours[index][0]
        candidates = np.flatnonzero(foreground & np.all(low <= p, axis=1) & np.all(high >= p, axis=1)
                                    & (areas > abs(areas[index])))
        for candidate in sorted(candidates, key=lambda i: areas[i]):
            if cv2.pointPolygonTest(contours[candidate].astype(np.float32), tuple(p.astype(float)), False) >= 0:
                result[index] = int(candidate)
                break
    return result


def cleanup_mask(mask, operations, error=.8, detail=1., min_area=1., limits=None,
                 return_info=True):
    """Return selected cleanup paths with the ordinary trace_mask inventory.

    ``operations`` have been validated and filtered to one palette color.
    Their ``maxDeviation`` values are already scaled into working pixels.
    Contour indexes are stable for the same source, palette and trace settings.
    Bounds and deviation receipts describe geometry, not visual perfection.
    """
    parts, info = vc.trace_mask(mask, error=error, detail=detail, min_area=min_area,
                                limits=limits, return_info=True)
    if not operations:
        info["cleanup"] = []
        return (parts, info) if return_info else parts
    binary = _binary(mask, min_area)
    contours = vc._pixel_boundaries(binary, (limits or {}).get("points", vc.MAX_POINTS),
                                   (limits or {}).get("contours", vc.MAX_CONTOURS))
    if len(contours) != len(parts):
        raise ValueError("Cleanup contour inventory differs from the baseline trace")
    baseline_parts = parts.copy()
    parents = parent_indices(contours)
    for contour, parent in zip(info["contours"], parents):
        contour["parent"] = parent
    groups = [[i]+[j for j, parent in enumerate(parents) if parent == i]
              for i, contour in enumerate(info["contours"]) if not contour["hole"]]
    indexes = [i for operation in operations for i in operation["contours"]]
    if len(set(indexes)) != len(indexes):
        raise ValueError("A contour can be selected by only one cleanup operation")
    if any(isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < len(parts) for i in indexes):
        raise ValueError("Cleanup contour index was not found; trace the same source and settings first")
    replacement_samples, receipts = {}, []
    clearance_context = None
    if any(operation["type"] == "smooth" and operation.get("strength", .7) > 0 for operation in operations):
        starts = np.r_[0, np.cumsum([len(p) for p in contours])[:-1]]
        all_points = np.concatenate(contours)
        owners = np.repeat(np.arange(len(contours)), [len(p) for p in contours])
        clearance_context = (cKDTree(all_points), owners, starts)
    budget = {"segments": 0, "max_segments": (limits or {}).get("segments", vc.MAX_SEGMENTS)}
    for operation in operations:
        kind, chosen = operation["type"], operation["contours"]
        maximum = float(operation["maxDeviation"])
        if not math.isfinite(maximum) or maximum <= 0:
            raise ValueError("Cleanup deviation must be positive and finite in working pixels")
        spacing = min(SAMPLE_SPACING, maximum*.2)
        receipt = {"type": kind, "contours": chosen.copy(), "maxDeviation": maximum,
                   "samplingSpacing": spacing, "measurements": []}
        if kind == "smooth":
            strength = _number(operation.get("strength"), "strength", .7, 0, 1)
            receipt["strength"] = strength
            if strength == 0:
                receipt["unchanged"] = True
                receipts.append(receipt)
                continue
            candidates = [_smooth(contours[i], maximum, strength, detail, budget, spacing,
                                  clearance_context, i) for i in chosen]
        elif kind in ("circle", "concentric"):
            if kind == "circle" and len(chosen) != 1 or kind == "concentric" and not 2 <= len(chosen) <= 16:
                raise ValueError("Select one circle or 2 to 16 concentric circular contours")
            candidates = _fit_circles([contours[i] for i in chosen], spacing)
        elif kind == "parallelogram":
            if len(chosen) != 1:
                raise ValueError("Parallelogram cleanup selects exactly one contour")
            candidates = [_fit_parallelogram(contours[chosen[0]], maximum, spacing)]
        else:
            raise ValueError("Unknown cleanup type")
        for index, (path, sample, metrics) in zip(chosen, candidates):
            source_distance, curve_distance = _distances(contours[index], sample)
            # A sample-based measurement has a finite resolution. Reserve the
            # half-step allowance rather than claiming an exact Hausdorff bound.
            if max(source_distance, curve_distance)+spacing*.5+.002 > maximum:
                raise ValueError(f"{kind} cleanup contour {index} exceeds maxDeviation "
                                 f"({max(source_distance, curve_distance):.3f} measured pixels; "
                                 f"increase the bound or keep the original shape)")
            replacement_samples[index] = sample
            parts[index] = path
            old = info["contours"][index]
            old["segments"] = metrics["segments"]
            old["cleanup"] = kind
            receipt["measurements"].append({"contour": index, "sourceToCurve": source_distance,
                                              "curveToSource": curve_distance, **metrics})
        receipts.append(receipt)
    samples = [_sample_path(path) if i not in replacement_samples else replacement_samples[i]
               for i, path in enumerate(parts)]
    # Protected/unselected glyphs remain byte-identical in the comparison.
    baseline_samples = [_sample_path(path) for path in baseline_parts]
    # Cleanup compares against the actual SVG the user inspected. Pixel-cell
    # source boundaries can have zero-width diagonal contacts whose topology
    # is ambiguous at subpixel scale. Deviation still uses every source edge.
    reference_samples = baseline_samples
    object_receipts = []
    for group in groups:
        if not any(i in replacement_samples for i in group):
            continue
        margin = max(float(op["maxDeviation"]) for op in operations)+4
        low = np.maximum(0, np.floor(np.min([contours[i].min(axis=0) for i in group], axis=0)-margin)).astype(int)
        high = np.minimum([binary.shape[1], binary.shape[0]],
                          np.ceil(np.max([contours[i].max(axis=0) for i in group], axis=0)+margin)).astype(int)
        width, height = high-low
        local_shape = (int(height), int(width))
        object_before = _topology(_rasterize(reference_samples, local_shape, low, groups=[group]))
        object_after = _topology(_rasterize(samples, local_shape, low, groups=[group]))
        validation_scale = 1
        if object_before != object_after:
            validation_scale = min(4, int(math.sqrt(16_000_000/max(1, width*height))))
            if validation_scale >= 2:
                local_shape = (int(height*validation_scale), int(width*validation_scale))
                object_before = _topology(_rasterize(reference_samples, local_shape, low, validation_scale, [group]))
                object_after = _topology(_rasterize(samples, local_shape, low, validation_scale, [group]))
        if object_before != object_after:
            raise ValueError(f"Cleanup would change connected shapes or holes in contour object {group[0]} "
                             f"({object_before[0]} shapes/{object_before[1]} holes to "
                             f"{object_after[0]} shapes/{object_after[1]} holes); reduce the deviation or strength")
        object_receipts.append({"contours": group, "components": object_before[0], "holes": object_before[1],
                                "validationScale": validation_scale})
    before = _topology(_rasterize(reference_samples, binary.shape, groups=groups))
    after = _topology(_rasterize(samples, binary.shape, groups=groups))
    topology_receipt = {"components": before[0], "holes": before[1],
                        "resolution": [binary.shape[1], binary.shape[0]], "validationScale": 1,
                        "reference": "baseline-svg-compounds", "objects": object_receipts}
    if before != after:
        # A one-pixel diagonal gap can become several pinholes merely by
        # shifting its subpixel coverage. Validate the selected region at a
        # higher resolution before mistaking this raster alias for a vector
        # topology change. Keep the high-resolution allocation below 16 MP.
        chosen_indexes = list(replacement_samples)
        fine_baseline = reference_samples
        smooth_indexes = [i for i in chosen_indexes if info["contours"][i]["cleanup"] == "smooth"]
        if smooth_indexes:
            # Large reconstructed rings need not make an icon's local alias
            # check allocate a 4x full canvas. First validate all primitive
            # replacements globally, then compare smoothing to that accepted
            # intermediate geometry inside the smooth selections' bounds.
            intermediate = [reference_samples[i] if i in smooth_indexes else samples[i] for i in range(len(samples))]
            if _topology(_rasterize(intermediate, binary.shape, groups=groups)) == before:
                chosen_indexes = smooth_indexes
                fine_baseline = intermediate
        chosen_points = [contours[i] for i in chosen_indexes]
        if chosen_points:
            margin = max(float(op["maxDeviation"]) for op in operations)+4
            low = np.maximum(0, np.floor(np.min([p.min(axis=0) for p in chosen_points], axis=0)-margin)).astype(int)
            high = np.minimum([binary.shape[1], binary.shape[0]],
                              np.ceil(np.max([p.max(axis=0) for p in chosen_points], axis=0)+margin)).astype(int)
            width, height = high-low
            scale = min(4, int(math.sqrt(16_000_000/max(1, width*height))))
            if scale >= 2:
                shape = (int(height*scale), int(width*scale))
                before_fine = _topology(_rasterize(fine_baseline, shape, low, scale, groups))
                after_fine = _topology(_rasterize(samples, shape, low, scale, groups))
                if before_fine == after_fine:
                    before, after = before_fine, after_fine
                    topology_receipt = {"components": before[0], "holes": before[1],
                                        "resolution": [shape[1], shape[0]], "validationScale": scale,
                                        "bounds": [int(low[0]), int(low[1]), int(width), int(height)],
                                        "basis": "selected-region", "rasterAliasFallback": True,
                                        "reference": "baseline-svg-compounds", "objects": object_receipts}
    if before != after:
        raise ValueError("Cleanup would change connected shapes or holes "
                         f"({before[0]} shapes/{before[1]} holes to {after[0]} shapes/{after[1]} holes); "
                         "reduce the deviation or select fewer contours")
    info["segments"] = sum(contour["segments"] for contour in info["contours"])
    if info["segments"] > (limits or {}).get("segments", vc.MAX_SEGMENTS):
        raise vc.TraceLimitError("Cleanup exceeds the segment limit")
    info["ellipses"] = sum(bool(contour.get("ellipse")) and "cleanup" not in contour for contour in info["contours"])
    info["cleanup"] = receipts
    info["cleanupTopology"] = topology_receipt
    return (parts, info) if return_info else parts
