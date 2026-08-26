"""Workspace geometry for the VFX viewer — gizmos, unprojection, pixel probes.

    python server/vfx/viewport.py <job.json>       one JSON line to stdout

The job names a "mode":

  overlay       comp+t (+view, +layerId) -> screen-space overlay geometry:
                the selected layer's axis tripod and bounding outline, camera
                frustum polylines, light wireframes. Everything is computed
                with ENGINE functions — world_matrix4, camera_from,
                view_camera, Camera.project — never a reimplementation, so the
                overlay cannot disagree with the rendered frame. That is the
                entire reason this file imports engine instead of doing its
                own trigonometry.
  unproject     a screen-space drag -> the world-space (and position-property-
                space) delta it means, against the same camera. The inverse
                lives beside the projection so the two cannot drift.
  layer_bounds  comp+t+layerIds -> each layer's world-XY bounding box, its
                current position value and the inverse of its parent chain's
                linear part — everything an align operation needs to write new
                positions through the ordinary store path.
  probe_pixel   png+x+y -> RGBA at that pixel, 0-255 and float. Deliberately
                the lightest mode: it imports PIL only, never the engine, so
                an Info readout under a moving cursor is not paying numpy/cv2
                import time per sample.

Like audiokeys.py and tracker.py this is a standalone tool the routes spawn
with one job file; sources inside the comp are ABSOLUTE paths because the
route resolved them, exactly as it does before handing a comp to engine.py.

All coordinates in and out are COMP pixels at scale 1 (the route and the UI
scale). Colours are 0-255 in the reply, as everywhere in this API.
"""
from __future__ import annotations

import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

AXIS_PX = 70.0          # how long a tripod arm is on screen, in comp px
POINT_RAY = 40.0        # a point light's star, world px
AMBIENT_RAY = 22.0      # an ambient light's marker, world px
SPOT_REACH = 150.0      # how far a spot cone is drawn, world px
PARALLEL_LEN = 140.0    # a parallel light's arrow, world px


def _r(v):
    """Round for the wire — geometry to 1/100 px, nobody draws finer."""
    return round(float(v), 2)


# ── probe_pixel: PIL only, engine never imported ─────────────────────────────

def cmd_probe_pixel(job):
    from PIL import Image
    path = str(job.get("png") or "")
    if not path or not os.path.isfile(path):
        raise ValueError("probe_pixel needs `png`, the rendered frame's path.")
    x = int(job.get("x", 0))
    y = int(job.get("y", 0))
    with Image.open(path) as im:
        im = im.convert("RGBA")
        w, h = im.size
        cx = max(0, min(w - 1, x))
        cy = max(0, min(h - 1, y))
        r, g, b, a = im.getpixel((cx, cy))
    return {"ok": True, "x": cx, "y": cy, "width": w, "height": h,
            "clamped": (cx != x or cy != y),
            "rgba": [int(r), int(g), int(b), int(a)],
            "float": [round(r / 255.0, 6), round(g / 255.0, 6),
                      round(b / 255.0, 6), round(a / 255.0, 6)]}


# ── the engine-backed modes ──────────────────────────────────────────────────

def _load_engine():
    """engine.py, imported the way it imports its own neighbours."""
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    import engine  # noqa: PLC0415
    return engine


class Scene:
    """One comp at one instant, seen exactly as render_frame sees it.

    The visibility rule, the time window, the camera pick and the view
    override are all either engine functions or line-for-line the closures
    render_frame builds — pinned by the overlay-matches-render probe test in
    scripts/e2e_vfx.mjs, which renders a frame and asserts the tripod origin
    lands on the layer's pixels.
    """

    def __init__(self, comp, t, view=None):
        eng = _load_engine()
        import numpy as np
        self.eng = eng
        self.np = np
        self.comp = comp
        self.t = float(t)
        self.cw = max(1, int(comp.get("width") or 1920))
        self.ch = max(1, int(comp.get("height") or 1080))
        self.layers = [l for l in (comp.get("layers") or []) if isinstance(l, dict)]
        self.by_id = {l.get("id"): l for l in self.layers if l.get("id")}
        self.cctx = eng.CompCtx(library=eng._comp_library(comp),
                                chain=(eng._comp_identity(comp),),
                                env=eng._new_env(comp))
        self.defaults = eng._comp_defaults(comp, self.cctx)
        self.duration = eng._f(comp.get("duration"), 0.0)
        self.solo_on = any(l.get("solo") for l in self.layers)
        self.any3d = any(l.get("threeD") for l in self.layers)
        # The same rule as render_frame: no 3D layer, no camera — in ANY view.
        # A view override on a flat comp changes nothing there, so it changes
        # nothing here either.
        if not self.any3d:
            self.camera = None
        elif view:
            self.camera = eng.view_camera(comp, view)
        else:
            self.camera = eng.active_camera(comp, self.layers, self.by_id, self.t,
                                            self.cctx, self.visible, self.in_window)

    # render_frame's own visibility closures, verbatim.
    def visible(self, lay):
        if self.solo_on:
            return bool(lay.get("solo"))
        return lay.get("enabled", True) is not False

    def in_window(self, lay):
        eng = self.eng
        start = eng._f(lay.get("start"), 0.0)
        end = eng._f(lay.get("end"), self.duration)
        return (self.t >= start - eng.EPS) and (self.t < end - eng.EPS)

    def bind(self, lay, path):
        return self.eng._bind(self.cctx, lay, path)

    def binder(self, path):
        return self.eng._binder(self.cctx, path)

    def parent_matrix(self, lay):
        """The parent CHAIN's 4x4, identity when unparented."""
        parent = self.by_id.get(lay.get("parent")) if lay.get("parent") else None
        if isinstance(parent, dict):
            return self.eng.world_matrix4(parent, self.by_id, self.t,
                                          self.defaults, self.binder("transform"))
        return self.np.eye(4, dtype=self.np.float64)

    def world4(self, lay):
        return self.eng.world_matrix4(lay, self.by_id, self.t,
                                      self.defaults, self.binder("transform"))

    def anchor_of(self, lay):
        """The layer's anchor in LAYER pixels, defaulted like matrix4 defaults it."""
        eng = self.eng
        tr = lay.get("transform") or {}
        at = eng._at_of(self.bind(lay, "transform"))
        (ad, _pd) = self.defaults(lay)
        return eng._triple(eng.interp.eval_prop(tr.get("anchor"), self.t, None,
                                                at("anchor")),
                           (ad[0], ad[1], 0.0))

    def position_of(self, lay):
        """The concrete position at t, in PARENT space, plus its stored arity."""
        eng = self.eng
        tr = lay.get("transform") or {}
        at = eng._at_of(self.bind(lay, "transform"))
        (_ad, pd) = self.defaults(lay)
        raw = eng.interp.eval_prop(tr.get("position"), self.t, None, at("position"))
        arity = len(raw) if isinstance(raw, (list, tuple)) and len(raw) in (2, 3) else 2
        return eng._triple(raw, (pd[0], pd[1], 0.0)), arity

    def uses_camera(self, lay):
        return bool(lay.get("threeD")) and self.camera is not None

    def project(self, pts, through_camera):
        """World points -> (screen comp px (N,2), finite mask (N,)).

        A 2D layer's world IS the screen — render_frame never sends one through
        a lens — so `through_camera` is per LAYER, exactly as it is there.
        """
        np = self.np
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 3)
        if through_camera and self.camera is not None:
            s, _z = self.camera.project(pts)
            return s, np.isfinite(s).all(axis=1)
        return pts[:, :2].copy(), np.isfinite(pts[:, :2]).all(axis=1)


def _polyline(scene, pts, through_camera):
    """World points -> screen polylines, split wherever a point cannot project."""
    s, fin = scene.project(pts, through_camera)
    out, run = [], []
    for i in range(s.shape[0]):
        if fin[i]:
            run.append([_r(s[i, 0]), _r(s[i, 1])])
        elif len(run) > 1:
            out.append(run)
            run = []
        else:
            run = []
    if len(run) > 1:
        out.append(run)
    return out


def _axes_of(scene, lay, m4, origin_world):
    """The tripod: local X/Y/Z as screen segments of ~AXIS_PX, exactly projected."""
    np = scene.np
    through = scene.uses_camera(lay)
    o = origin_world
    po, fin = scene.project(o, through)
    if not fin[0]:
        return [], None
    po = po[0]
    names = ["x", "y", "z"] if lay.get("threeD") else ["x", "y"]
    axes = []
    for i, name in enumerate(names):
        d = np.asarray(m4[:3, i], dtype=np.float64)
        n = float(np.linalg.norm(d))
        if n < 1e-9:
            continue                      # scale 0 on this axis — nothing to draw
        d = d / n
        p1, f1 = scene.project(o + d, through)
        step = float(np.hypot(p1[0, 0] - po[0], p1[0, 1] - po[1])) if f1[0] else 0.0
        if step < 1e-9:
            # The axis points into the lens; there is no direction to draw and
            # no drag along it either. Say so instead of inventing one.
            axes.append({"axis": name, "from": [_r(po[0]), _r(po[1])],
                         "to": [_r(po[0]), _r(po[1])], "world": [_r(v) for v in d],
                         "degenerate": True})
            continue
        s = AXIS_PX / step
        pt, ft = scene.project(o + s * d, through)
        if not ft[0]:
            continue
        axes.append({"axis": name,
                     "from": [_r(po[0]), _r(po[1])],
                     "to": [_r(pt[0, 0]), _r(pt[0, 1])],
                     "world": [round(float(v), 6) for v in d],
                     "worldPerPixel": round(s / AXIS_PX, 6)})
    return axes, [_r(po[0]), _r(po[1])]


def _selected_geometry(scene, lay):
    eng, np = scene.eng, scene.np
    m4 = scene.world4(lay)
    lw, lh = eng._layer_native_size(scene.comp, lay, scene.cctx)
    ax, ay, az = scene.anchor_of(lay)
    origin = (m4 @ np.array([ax, ay, az, 1.0]))[:3]
    through = scene.uses_camera(lay)

    corners = np.array([[0.0, 0.0, 0.0, 1.0], [lw, 0.0, 0.0, 1.0],
                        [lw, lh, 0.0, 1.0], [0.0, lh, 0.0, 1.0]], dtype=np.float64)
    world = (m4 @ corners.T).T[:, :3]
    s, fin = scene.project(world, through)
    outline = ([[_r(s[i, 0]), _r(s[i, 1])] for i in range(4)]
               if bool(fin.all()) else None)

    axes, anchor_screen = _axes_of(scene, lay, m4, origin)
    return {
        "id": lay.get("id"), "name": lay.get("name"), "type": lay.get("type"),
        "threeD": bool(lay.get("threeD")),
        "outline": outline,
        "anchor": anchor_screen,
        "axes": axes,
        "size": [int(lw), int(lh)],
    }


def _camera_wires(scene):
    """Frustum polylines for every live camera layer, seen from the current view."""
    eng, np = scene.eng, scene.np
    out = []
    if scene.camera is None:
        return out
    for lay in scene.layers:
        if str(lay.get("type") or "") != "camera":
            continue
        if not (scene.visible(lay) and scene.in_window(lay)):
            continue
        cam = eng.camera_from(lay, scene.comp, scene.by_id, scene.t,
                              scene.defaults, scene.cctx)
        d = cam.focus if cam.focus > eng.NEAR else cam.zoom
        # The rectangle the lens sees at its focus distance, camera space ->
        # world through the CAMERA LAYER's own axes (P = pos + rot @ c).
        rect_cam = [((x - cam.cx) * d / cam.zoom, (y - cam.cy) * d / cam.zoom, d)
                    for (x, y) in ((0, 0), (scene.cw, 0), (scene.cw, scene.ch), (0, scene.ch))]
        rect = [cam.pos + cam.rot @ np.asarray(c, dtype=np.float64) for c in rect_cam]
        polys = []
        ring = np.array(rect + [rect[0]])
        polys += _polyline(scene, ring, True)
        for c in rect:
            polys += _polyline(scene, np.array([cam.pos, c]), True)
        ps, pf = scene.project(cam.pos, True)
        out.append({"id": lay.get("id"), "name": lay.get("name"),
                    "pos": [_r(ps[0, 0]), _r(ps[0, 1])] if pf[0] else None,
                    "polylines": polys})
    return out


def _basis_perp(np, a):
    ref = np.array([0.0, 1.0, 0.0]) if abs(float(a[1])) < 0.99 else np.array([1.0, 0.0, 0.0])
    u = np.cross(a, ref)
    u = u / (np.linalg.norm(u) or 1.0)
    v = np.cross(a, u)
    return u, v


def _light_wires(scene):
    eng, np = scene.eng, scene.np
    out = []
    if eng.lights is None or scene.camera is None:
        return out
    for lay in scene.layers:
        if str(lay.get("type") or "") != "light":
            continue
        if not (scene.visible(lay) and scene.in_window(lay)):
            continue
        try:
            li = eng.lights._one_light(
                lay, scene.t, (scene.cw, scene.ch),
                parent_of=lambda l: (scene.parent_matrix(l)
                                     if l.get("parent") else None),
                bind=lambda l, path: scene.bind(l, path))
        except Exception:                              # noqa: BLE001
            continue                                   # unmarked beats a failed overlay
        pos = np.asarray(li.pos, dtype=np.float64)
        a = np.asarray(li.axis, dtype=np.float64)
        polys = []
        if li.kind == "spot":
            half = math.radians(max(1.0, li.cone_angle) / 2.0)
            r = SPOT_REACH * math.tan(half)
            u, v = _basis_perp(np, a)
            centre = pos + SPOT_REACH * a
            ring = [centre + r * (math.cos(p) * u + math.sin(p) * v)
                    for p in [i * math.tau / 16 for i in range(17)]]
            polys += _polyline(scene, np.array(ring), True)
            for p in (0, 4, 8, 12):
                polys += _polyline(scene, np.array([pos, ring[p]]), True)
        elif li.kind == "parallel":
            tip = pos + PARALLEL_LEN * a
            u, _v = _basis_perp(np, a)
            polys += _polyline(scene, np.array([pos, tip]), True)
            polys += _polyline(scene, np.array([tip - 18 * a + 10 * u, tip,
                                                tip - 18 * a - 10 * u]), True)
        else:
            ray = AMBIENT_RAY if li.kind == "ambient" else POINT_RAY
            for d in ([1, 0, 0], [0, 1, 0], [0, 0, 1]):
                d = np.asarray(d, dtype=np.float64) * ray
                polys += _polyline(scene, np.array([pos - d, pos + d]), True)
        ps, pf = scene.project(pos, True)
        out.append({"id": lay.get("id"), "name": lay.get("name"), "kind": li.kind,
                    "pos": [_r(ps[0, 0]), _r(ps[0, 1])] if pf[0] else None,
                    "polylines": polys})
    return out


def cmd_overlay(job):
    comp = job.get("comp") or {}
    scene = Scene(comp, job.get("t") or 0.0, job.get("view") or None)
    sel_id = job.get("layerId")
    selected = None
    if sel_id:
        lay = scene.by_id.get(sel_id)
        if lay is None:
            raise ValueError(f"No such layer: {sel_id}")
        selected = _selected_geometry(scene, lay)
    return {"ok": True,
            "width": scene.cw, "height": scene.ch, "t": scene.t,
            "hasCamera": scene.camera is not None,
            "selected": selected,
            "cameras": _camera_wires(scene),
            "lights": _light_wires(scene)}


def _pinv_linear(np, pm):
    lin = np.asarray(pm, dtype=np.float64)[:3, :3]
    try:
        inv = np.linalg.inv(lin)
        if not np.isfinite(inv).all():
            raise ValueError
        return inv
    except Exception:                                  # noqa: BLE001
        return np.eye(3, dtype=np.float64)             # a degenerate parent: move 1:1


def cmd_unproject(job):
    """A screen drag -> the position delta that reproduces it, exactly inverted.

    job.drag (not "mode" — that word dispatches this file):
      plane  move in the plane through the layer's anchor parallel to the view
             plane — the body drag. Without a camera the screen IS that plane.
      axis   move along ONE local axis (x|y|z): the world step whose projection
             best matches the screen delta (least squares along the axis's own
             projected direction — re-linearised every call, which is why the
             UI unprojects incrementally during a drag rather than once).
    """
    import numpy as np
    comp = job.get("comp") or {}
    scene = Scene(comp, job.get("t") or 0.0, job.get("view") or None)
    lay = scene.by_id.get(job.get("layerId"))
    if lay is None:
        raise ValueError(f"No such layer: {job.get('layerId')}")

    p_from = [float(v) for v in (job.get("from") or [0, 0])[:2]]
    p_to = [float(v) for v in (job.get("to") or p_from)[:2]]
    mode = str(job.get("drag") or "plane")

    m4 = scene.world4(lay)
    ax, ay, az = scene.anchor_of(lay)
    o = (m4 @ np.array([ax, ay, az, 1.0]))[:3]
    through = scene.uses_camera(lay)

    if not through:
        world_delta = np.array([p_to[0] - p_from[0], p_to[1] - p_from[1], 0.0])
        if mode == "axis":
            axis = {"x": 0, "y": 1, "z": 2}.get(str(job.get("axis") or "x"), 0)
            d = np.asarray(m4[:3, axis], dtype=np.float64)
            n = float(np.linalg.norm(d))
            if n < 1e-9:
                raise ValueError("That axis has zero length here (scale 0) — drag the body instead.")
            d = d / n
            j = d[:2]
            g = float(j @ j)
            if g < 1e-12:
                raise ValueError("That axis is perpendicular to the screen — drag the body instead.")
            lam = float(np.array([world_delta[0], world_delta[1]]) @ j) / g
            world_delta = lam * d
    else:
        cam = scene.camera

        def on_view_plane(sp):
            # The ray through screen point sp, intersected with the plane
            # through the anchor perpendicular to the camera's forward axis.
            dcam = np.array([(sp[0] - cam.cx) / cam.zoom,
                             (sp[1] - cam.cy) / cam.zoom, 1.0])
            dw = cam.rot @ dcam
            f = cam.rot[:, 2]
            denom = float(f @ dw)
            if abs(denom) < 1e-12:
                raise ValueError("That drag is edge-on to the view — it has no world meaning.")
            lam = float(f @ (o - cam.pos)) / denom
            return cam.pos + lam * dw

        if mode == "axis":
            axis = {"x": 0, "y": 1, "z": 2}.get(str(job.get("axis") or "x"), 0)
            d = np.asarray(m4[:3, axis], dtype=np.float64)
            n = float(np.linalg.norm(d))
            if n < 1e-9:
                raise ValueError("That axis has zero length here (scale 0) — drag the body instead.")
            d = d / n
            s0, f0 = scene.project(o, True)
            s1, f1 = scene.project(o + d, True)
            if not (f0[0] and f1[0]):
                raise ValueError("The layer's anchor does not project in this view.")
            j = np.array([s1[0, 0] - s0[0, 0], s1[0, 1] - s0[0, 1]])
            g = float(j @ j)
            if g < 1e-12:
                raise ValueError("That axis points straight into the lens here — drag the body, or switch views.")
            screen_delta = np.array([p_to[0] - p_from[0], p_to[1] - p_from[1]])
            lam = float(screen_delta @ j) / g
            world_delta = lam * d
        else:
            world_delta = on_view_plane(p_to) - on_view_plane(p_from)

    pm = scene.parent_matrix(lay)
    pinv = _pinv_linear(np, pm)
    pos_delta = pinv @ world_delta

    pos, arity = scene.position_of(lay)
    keep3 = arity == 3 or (bool(lay.get("threeD")) and abs(float(pos_delta[2])) > 1e-6)
    new_pos = [pos[0] + float(pos_delta[0]), pos[1] + float(pos_delta[1])]
    if keep3:
        new_pos.append(pos[2] + float(pos_delta[2]))
    return {"ok": True,
            "worldDelta": [round(float(v), 4) for v in world_delta],
            "positionDelta": [round(float(v), 4) for v in pos_delta[:3]],
            "position": [round(float(v), 4) for v in pos[:len(new_pos)]],
            "newPosition": [round(v, 4) for v in new_pos]}


def cmd_layer_bounds(job):
    import numpy as np
    comp = job.get("comp") or {}
    scene = Scene(comp, job.get("t") or 0.0, None)
    ids = job.get("layerIds") or [l.get("id") for l in scene.layers]
    eng = scene.eng
    rows = []
    for lid in ids:
        lay = scene.by_id.get(lid)
        if lay is None:
            raise ValueError(f"No such layer: {lid}")
        m4 = scene.world4(lay)
        lw, lh = eng._layer_native_size(comp, lay, scene.cctx)
        corners = np.array([[0.0, 0.0, 0.0, 1.0], [lw, 0.0, 0.0, 1.0],
                            [lw, lh, 0.0, 1.0], [0.0, lh, 0.0, 1.0]], dtype=np.float64)
        world = (m4 @ corners.T).T[:, :2]
        pos, arity = scene.position_of(lay)
        pinv = _pinv_linear(np, scene.parent_matrix(lay))
        rows.append({
            "id": lid, "name": lay.get("name"),
            "bbox": [_r(world[:, 0].min()), _r(world[:, 1].min()),
                     _r(world[:, 0].max()), _r(world[:, 1].max())],
            "position": [round(float(v), 4) for v in pos[:max(2, arity)]],
            "arity": arity, "threeD": bool(lay.get("threeD")),
            "pinv": [[round(float(v), 8) for v in row] for row in pinv],
        })
    return {"ok": True, "width": scene.cw, "height": scene.ch, "layers": rows}


MODES = {"overlay": cmd_overlay, "unproject": cmd_unproject,
         "layer_bounds": cmd_layer_bounds, "probe_pixel": cmd_probe_pixel}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) < 1:
            raise ValueError("usage: viewport.py <job.json> — the job carries a `mode`")
        with open(argv[0], encoding="utf-8") as fh:
            job = json.load(fh)
        mode = str(job.get("mode") or "")
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r} — one of {', '.join(MODES)}")
        result = MODES[mode](job)
    except Exception as exc:                           # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
