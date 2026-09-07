/**
 * VFX — camera moves: the RIG, built.
 *
 * Cameras only became animatable in this compositor a change ago: until then
 * `camera.*` resolved to nothing, `layerProperties` returned zero rows for a
 * camera while a spot light returned nine, and the panel's four scalars were
 * rebuilt (not merged) on every write, so touching it destroyed a rigged
 * camera's aim. That is fixed underneath. This file is the answer to the
 * question that immediately follows it: WHO IS GOING TO KEYFRAME ALL THAT.
 *
 * The person pointing the camera is a director, not a keyframer. A feature that
 * costs an hour of hand-keyframing gets used once, in a demo. So each move here
 * builds the whole rig in one action — the camera AND the aim null it looks at,
 * already wired to the subject — and hands back something made entirely of
 * ordinary layers, ordinary keyframes and ordinary expressions, which every
 * tool that already exists (the graph editor, the timeline, set_prop, the
 * expression sheet, undo) can then take apart and re-time. Nothing here is a
 * special object the rest of the app has to be taught about. That is the same
 * bet rigs.js makes, and it is why an orbit can be slowed down by dragging two
 * keyframes rather than by re-running the preset.
 *
 * WHY AN AIM NULL RATHER THAN AIMING AT THE SUBJECT. It is the sharpest note in
 * the brief this file comes from, and it is a real one: a lens locked to the
 * subject's own position reads as machinery — the subject is pinned to the
 * exact centre of frame no matter what either of them does. An operator does
 * not do that. They aim a little to one side, they lag a fraction of a second
 * behind a move, they leave the subject lead room. So every move that follows
 * something aims the camera at a NULL, and it is the null that carries the
 * offset and the lag. Two consequences, both wanted: the offset is a layer you
 * can drag rather than a number buried in an expression, and the note survives
 * every later edit — re-time the subject and the aim still trails it.
 *
 * PURE, on templates.js's rule: no disk, no engine, no catalog lookups. The
 * route persists what comes back, which is what lets camera_moves_test.js check
 * the built document field by field without a server.
 *
 * TWO OUTPUTS, because a move can land on a camera that already exists:
 *   create[]  whole layers, front-first (layers[0] paints last — on top), for
 *             the route to splice at index 0. A camera goes first because the
 *             TOPMOST camera is the one a comp renders through.
 *   edit[]    { id, camera?, transform? } patches for layers already in the
 *             document. The route applies these through set_layer's own
 *             mergeCamera and its transform merge, so a preset lands on an
 *             existing camera by exactly the write path a human's click uses —
 *             it cannot drop a keyframe the panel would have kept.
 */
import { blankLayer, evalProp, CAMERA_PROP_SPEC } from "./store.js";

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi);

/* A focus distance in pixels, held inside the band CAMERA_PROP_SPEC declares —
 * the same band the write path now enforces on every door. A preset asked for
 * `from: 0.4` would otherwise build a document the route then refuses, which is
 * a 400 nobody can act on: the number the caller gave was not the number the
 * rig wrote. Clamped here, where the rig is choosing it, rather than refused
 * there, where it is derived. */
const depthPx = (v) => Math.round(clamp(v, ...CAMERA_PROP_SPEC.focusDistance.range));

/** One keyframe. `ease` describes the segment LEAVING this key (§1). */
const K = (t, v, ease) => (ease === undefined ? { t: r3(t), v } : { t: r3(t), v, ease });

/** An expression sitting ON TOP of a value — §1's shape. The value is what the
 *  engine falls back to if the expression fails and what the expression itself
 *  reads as `value`. */
const withExpr = (value, expr) => ({ value, expr });

const round3 = (v) => v.map((n) => Math.round(Number(n) * 1000) / 1000);

/**
 * A layer's position as a real [x, y, z], at time t.
 *
 * The document stores 2D positions as [x, y] and the engine pads the missing
 * component (engine.py::_triple), so a rig that read two numbers and wrote two
 * numbers would quietly flatten a 3D layer the moment it touched it.
 */
function posAt(layer, t, fallbackZ = 0) {
  const v = evalProp(layer?.transform?.position, t);
  const a = Array.isArray(v) ? v : [0, 0];
  return [num(a[0], 0), num(a[1], 0), num(a[2], fallbackZ)];
}

/**
 * How an expression should NAME a layer.
 *
 * expressions.py::_layer matches on the layer's name first and falls back to
 * its id, so a name is what a person wants to read in the expression editor —
 * right up until two layers share one, at which point the expression silently
 * binds to whichever is higher in the stack. Same for a name carrying a quote
 * or a backslash, which would end the string early and turn the expression into
 * a syntax error at render time. Both cases fall back to the id and SAY so,
 * because a rig aimed at the wrong layer looks exactly like a rig.
 */
function exprRef(comp, layer, warnings) {
  const name = String(layer.name || "");
  const dupes = (comp.layers || []).filter((l) => String(l.name || "") === name).length;
  if (!name) return layer.id;
  if (/["\\]/.test(name)) {
    warnings.push(`"${name}" carries a quote or a backslash, which cannot go inside an expression `
      + `string — the rig names that layer by its id (${layer.id}) instead. Rename it and the `
      + `expressions read better.`);
    return layer.id;
  }
  if (dupes > 1) {
    warnings.push(`${dupes} layers are called "${name}", and an expression that names one binds to `
      + `whichever sits highest — so the rig names this one by its id (${layer.id}). Give it a `
      + `unique name to get a readable expression.`);
    return layer.id;
  }
  return name;
}

/** A name nothing else in the comp already has, so `thisComp.layer("…")` in the
 *  rig's own expressions cannot bind to somebody else's layer. */
function freeName(comp, base) {
  const taken = new Set((comp.layers || []).map((l) => String(l.name || "")));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  return `${base} ${Date.now().toString(36)}`;
}

/**
 * The distance a camera sits back by when nobody says otherwise.
 *
 * A camera at distance D with zoom Z renders the z = 0 plane 1:1 when D == Z,
 * and a 50mm on this comp's width IS width·50/36 px (engine.py's FILM_MM and
 * DEFAULT_FOCAL_MM). So this is the distance at which a new camera changes
 * nothing about how the comp already looks — the honest starting point for a
 * move, and the same number blankLayer parks a new LIGHT at.
 */
const homeDistance = (comp) => Math.round((num(comp.width, 1920) * 50) / 36);

/* ── the moves ──────────────────────────────────────────────────────────────
 *
 * `takes` is the whole parameter list, and the route refuses anything outside
 * it NAMING which moves do take it — add_shape_preset's rule, and the reason a
 * `radius` sent to a push-in is an error rather than a silence. */
export const CAMERA_MOVES = {
  offsetFollow: {
    label: "Offset follow",
    why: "The camera follows the subject and aims at a null that sits BESIDE and slightly behind "
      + "them, trailing by a fraction of a second. The subject rides off-centre with lead room "
      + "instead of being pinned to the middle of frame, which is the whole difference between a "
      + "shot that was operated and a shot that was computed.",
    needsTarget: true,
    takes: ["target", "camera", "name", "start", "duration", "distance", "side", "rise",
            "depth", "lag", "camLag"],
  },
  orbit: {
    label: "Orbit around target",
    why: "The camera circles the subject on keyframes — one key every few degrees, so the arc can "
      + "be re-timed, eased or cut in the graph editor — while the aim null stays parked on the "
      + "subject, so the lens keeps looking at them even if they move.",
    needsTarget: true,
    takes: ["target", "camera", "name", "start", "duration", "radius", "degrees", "from",
            "height", "steps"],
  },
  pushIn: {
    label: "Push in",
    why: "A move toward the subject WITH the lens lengthening as it goes. A dolly alone changes "
      + "only how close you are; lengthening the lens on the way in compresses the background "
      + "behind them at the same time, which is what a push actually looks like.",
    needsTarget: true,
    takes: ["target", "camera", "name", "start", "duration", "from", "to", "fromFocal",
            "toFocal", "height"],
  },
  rackFocus: {
    label: "Rack focus",
    why: "Depth of field on, and the focus distance keyed from one depth to another so focus "
      + "travels between two subjects mid-shot. Takes numbers, or the NAMES of two layers, in "
      + "which case the depths are measured from the camera to each of them.",
    needsTarget: false,
    takes: ["camera", "target", "name", "start", "duration", "from", "to", "aperture",
            "blurLevel", "ease"],
  },
  handheld: {
    label: "Handheld",
    why: "A wiggle on the camera's position, and a SMALLER counter-move on the aim: as the body "
      + "drifts one way the lens corrects back, the way a shoulder-mounted operator does. "
      + "Amplitude in pixels and frequency in Hz are the two numbers.",
    needsTarget: false,
    takes: ["camera", "target", "name", "start", "duration", "amplitude", "frequency",
            "counter", "distance"],
  },
};

export const CAMERA_MOVE_NAMES = Object.keys(CAMERA_MOVES);

/**
 * Build one move.
 *
 * `comp` is the live document (read only). `opts.target` and `opts.camera` are
 * already-resolved LAYER OBJECTS from it, or null — resolving a name to a layer
 * is the route's job, because the route is what owns the error message.
 */
export function buildCameraMove(comp, move, opts = {}) {
  const spec = CAMERA_MOVES[move];
  if (!spec) throw new Error(`No camera move "${move}". They are: ${CAMERA_MOVE_NAMES.join(", ")}.`);

  const W = num(comp.width, 1920), H = num(comp.height, 1080);
  const cx = W / 2, cy = H / 2;
  const dur0 = num(comp.duration, 5);
  const warnings = [];

  const start = clamp(num(opts.start, 0), 0, Math.max(0, dur0));
  const duration = clamp(num(opts.duration, Math.max(0.5, dur0 - start)), 0.1, 600);
  const end = r3(start + duration);
  const D = homeDistance(comp);

  const target = opts.target || null;
  if (spec.needsTarget && !target) {
    throw new Error(`"${move}" is a move around something — name the subject with \`target\` `
      + `(a layer id or name). Without it there is nothing to follow.`);
  }

  const create = [];
  const edit = [];
  /* An existing camera is EDITED through the route's own merge; a new one is
   * built here and spliced. Either way everything below writes into one place. */
  const existing = opts.camera || null;
  const baseName = String(opts.name || spec.label).slice(0, 60);

  let camLayer, camName, camIsNew;
  if (existing) {
    if (existing.type !== "camera") {
      throw new Error(`${existing.name || existing.id} is a ${existing.type} layer, not a camera.`);
    }
    camLayer = existing; camIsNew = false;
    camName = exprRef(comp, existing, warnings);
  } else {
    camIsNew = true;
    const nm = freeName(comp, baseName);
    camLayer = blankLayer(comp, "camera", { name: nm, label: "aqua" });
    camName = nm;
    /* A fresh camera sits at the distance that renders the comp plane 1:1 — the
     * one starting point that changes nothing about how the comp already
     * looks. blankLayer writes a 2D [x, y] here; a move needs the z. */
    camLayer.transform.position = [cx, cy, -D];
    create.push(camLayer);
  }

  /* The camera's own position at the start of the move — the number a rig
   * measures its offsets from, and (for a camera already in the document) the
   * one the operator put it at rather than one this file assumed. */
  const camPos0 = posAt(camLayer, start, -D);

  /** Everything this move writes onto the camera. */
  const camSpec = {};
  const camXform = {};

  /* The aim null, where the move calls for one. It is a NULL because a null is
   * the layer type that renders nothing and carries a transform — exactly what
   * a target is — and because it can then be dragged, parented, keyframed and
   * wiggled by every tool that already exists. */
  let aimLayer = null, aimName = null;
  const makeAim = (offset, lag) => {
    const nm = freeName(comp, `${baseName} aim`);
    aimLayer = blankLayer(comp, "null", { name: nm, label: "aqua" });
    aimLayer.threeD = true;
    aimName = nm;
    const tRef = exprRef(comp, target, warnings);
    const tPos = posAt(target, start);
    const off = round3(offset);
    const src = lag > 0
      ? `thisComp.layer("${tRef}").position.valueAtTime(time - ${r3(lag)}) + [${off.join(", ")}]`
      : `thisComp.layer("${tRef}").position + [${off.join(", ")}]`;
    /* The value UNDER the expression is where the null actually is at the start
     * of the move. It is what the engine falls back to if the expression ever
     * fails (a renamed subject, a deleted layer), and what the timeline draws —
     * so a rig whose subject went missing points somewhere sensible instead of
     * at the comp's top-left corner. */
    const here = round3([tPos[0] + offset[0], tPos[1] + offset[1], tPos[2] + offset[2]]);
    aimLayer.transform.position = withExpr(here, src);
    create.push(aimLayer);
    camSpec.pointOfInterest = withExpr(here, `thisComp.layer("${aimName}").position`);
    return aimLayer;
  };

  let note = "";

  switch (move) {
    /* ── the note this whole feature exists for ─────────────────────────── */
    case "offsetFollow": {
      const distance = Math.abs(num(opts.distance, D)) || D;
      const side = num(opts.side, Math.round(W * 0.12));
      const rise = num(opts.rise, -Math.round(H * 0.06));
      const depth = num(opts.depth, Math.round(W * 0.08));
      const lag = clamp(num(opts.lag, 0.15), 0, 5);
      const camLag = clamp(num(opts.camLag, 0.35), 0, 5);

      makeAim([side, rise, depth], lag);

      /* The camera trails the subject too, and by MORE than the aim does. Two
       * different lags is the whole trick: a single lag on both would be the
       * locked rig moved half a beat late, which still reads as machinery. */
      const tRef = exprRef(comp, target, warnings);
      const tPos = posAt(target, start);
      const camOff = round3([0, Math.round(rise / 2), -distance]);
      camXform.position = withExpr(
        round3([tPos[0] + camOff[0], tPos[1] + camOff[1], tPos[2] + camOff[2]]),
        camLag > 0
          ? `thisComp.layer("${tRef}").position.valueAtTime(time - ${r3(camLag)}) + [${camOff.join(", ")}]`
          : `thisComp.layer("${tRef}").position + [${camOff.join(", ")}]`);
      camSpec.focusDistance = depthPx(distance + depth);
      note = `The lens is aimed at "${aimName}", not at the subject: drag that null and the framing `
        + `changes without touching the camera. The aim trails by ${r3(lag)}s and the body by `
        + `${r3(camLag)}s.`;
      break;
    }

    case "orbit": {
      const radius = Math.abs(num(opts.radius, D)) || D;
      const degrees = clamp(num(opts.degrees, 360), -3600, 3600);
      const from = num(opts.from, 0);
      const height = num(opts.height, -Math.round(H * 0.1));
      /* One key every ~15°, which is close enough that linear segments read as
       * a circle rather than a polygon, and few enough that the graph editor is
       * still a place a person can work. */
      const steps = clamp(Math.round(num(opts.steps, Math.max(4, Math.abs(degrees) / 15))), 4, 96);

      makeAim([0, 0, 0], 0);

      const c = posAt(target, start);
      const keys = [];
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const a = ((from + degrees * f) * Math.PI) / 180;
        keys.push(K(r3(start + duration * f),
          round3([c[0] + radius * Math.sin(a), c[1] + height, c[2] - radius * Math.cos(a)]),
          /* Linear between samples: constant angular speed IS the move, and an
           * ease on every key would make the camera stutter around the circle.
           * Ease the ends by hand afterwards if the shot wants a ramp. */
          "linear"));
      }
      camXform.position = { keys };
      camSpec.focusDistance = depthPx(radius);
      if (isMoving(target)) {
        warnings.push(`"${target.name || target.id}" is animated, and the orbit's CENTRE is its `
          + `position at ${r3(start)}s — the camera circles that point. The aim null tracks the `
          + `subject live, so the lens keeps looking at them either way.`);
      }
      note = `${Math.round(Math.abs(degrees))}° over ${r3(duration)}s on ${keys.length} keys — `
        + `re-time it by dragging the last one.`;
      break;
    }

    case "pushIn": {
      const fromD = Math.abs(num(opts.from, Math.round(D * 1.6))) || Math.round(D * 1.6);
      const toD = Math.abs(num(opts.to, Math.round(D * 0.75))) || Math.round(D * 0.75);
      const fromFocal = clamp(num(opts.fromFocal, 32), 1, 5000);
      const toFocal = clamp(num(opts.toFocal, 58), 1, 5000);
      const height = num(opts.height, 0);

      makeAim([0, 0, 0], 0);

      const c = posAt(target, start);
      camXform.position = { keys: [
        K(start, round3([c[0], c[1] + height, c[2] - fromD]), "easeInOut"),
        K(end, round3([c[0], c[1] + height, c[2] - toD])),
      ] };
      /* The lens, in MILLIMETRES. zoom and focalLength are one number said two
       * ways and engine.py reads focalLength only when zoom is unset, so a
       * camera carrying both has one of them dead — see CAMERA_LENS_PARAMS in
       * store.js. A new camera arrives with a zoom, so switching this rig to
       * millimetres has to retire it; on an existing camera the route's
       * mergeCamera does that retirement itself.
       *
       * MILLIMETRES ON PURPOSE, and the reason it is safe to insist on them:
       * "28mm to 62mm" is the sentence the shot is described in, and the move
       * back is now open — set_layer { camera: { zoom } } converts a pushed
       * camera straight back to pixels, and { focalLength: null } hands the
       * KEYED lens over key for key. Until that was true this preset was a
       * one-way door: a pixel camera put through it could not be returned to
       * pixels by any call in the API. */
      camSpec.focalLength = { keys: [
        K(start, fromFocal, "easeInOut"),
        K(end, toFocal),
      ] };
      camSpec.focusDistance = { keys: [
        K(start, depthPx(fromD), "easeInOut"),
        K(end, depthPx(toD)),
      ] };
      if (camIsNew) delete camLayer.camera.zoom;
      note = `In from ${Math.round(fromD)}px to ${Math.round(toD)}px while the lens goes `
        + `${Math.round(fromFocal)}mm → ${Math.round(toFocal)}mm. Focus follows the move, so the `
        + `subject stays sharp the whole way in.`;
      break;
    }

    case "rackFocus": {
      /* A depth is a number of pixels, or the NAME of a layer to measure to —
       * "rack from the guitar to the singer" is the sentence a director says,
       * and it is one the rig can answer without them working out a distance. */
      const depthOf = (v, which, dflt) => {
        if (v === undefined || v === null || v === "") return dflt;
        if (Number.isFinite(Number(v))) return Math.abs(Number(v));
        const lay = findByRef(comp, String(v));
        if (!lay) {
          throw new Error(`\`${which}\` is a depth in pixels, or the name of a layer to measure `
            + `to — there is no layer "${v}" in this comp.`);
        }
        const p = posAt(lay, start);
        return Math.round(Math.hypot(p[0] - camPos0[0], p[1] - camPos0[1], p[2] - camPos0[2]));
      };
      const fromD = Math.max(1, depthOf(opts.from, "from", Math.round(D * 1.5)));
      const toD = Math.max(1, depthOf(opts.to, "to", Math.round(D * 0.6)));
      const ease = ["linear", "easeIn", "easeOut", "easeInOut"].includes(String(opts.ease))
        ? String(opts.ease) : "easeInOut";

      /* Depth of field is what makes a rack focus visible at all: with it off
       * every depth is sharp and the focus keys render nothing. It stays a
       * plain boolean — the document has always held one, and mergeCamera only
       * churns it into 0/1 when somebody actually keyframes it. */
      camSpec.depthOfField = true;
      camSpec.aperture = clamp(num(opts.aperture, 60), 0, 1000);
      camSpec.blurLevel = clamp(num(opts.blurLevel, 100), 0, 1000);
      camSpec.focusDistance = { keys: [K(start, depthPx(fromD), ease), K(end, depthPx(toD))] };
      if (target) makeAim([0, 0, 0], 0);
      note = `Focus travels ${fromD}px → ${toD}px over ${r3(duration)}s at f/${camSpec.aperture}. `
        + `Depth of field is on, which is what makes the rack visible — it costs render time.`;
      break;
    }

    case "handheld": {
      const amplitude = Math.abs(num(opts.amplitude, Math.max(4, Math.round(W * 0.008))));
      const frequency = clamp(num(opts.frequency, 2.2), 0.01, 60);
      const counter = clamp(num(opts.counter, 0.35), 0, 2);
      /* Vertical shake reads as heavier than lateral on the same number, and
       * depth shake reads as a lurch, so the three axes are not equal. These
       * ratios are the difference between "handheld" and "an earthquake". */
      const amp = round3([amplitude, amplitude * 0.7, amplitude * 0.45]);

      if (target && !hasAim(camLayer)) makeAim([0, 0, 0], 0);

      /* Composing rather than replacing. If the camera's position already
       * carries an expression — it does the moment this lands on an
       * offsetFollow rig — the shake is ADDED to it: `wiggle(f, a)` is
       * `value + noise`, so `(P) + wiggle(f, a) - value` is exactly `(P) +
       * noise`, the follow path with a hand on it. On a plain camera the same
       * thing is written the short way, because a person opening the
       * expression editor should see `wiggle(2.2, [15, 10, 7])` and not
       * algebra. */
      const prevPos = camLayer.transform?.position;
      const prevPosExpr = exprOf(prevPos);
      const shake = `wiggle(${r3(frequency)}, [${amp.join(", ")}])`;
      camXform.position = prevPosExpr
        ? withExpr(valueUnder(prevPos, round3(camPos0)), `(${prevPosExpr}) + ${shake} - value`)
        : withExpr(round3(camPos0), shake);

      /* THE COUNTER-MOVE, and why it reads the camera's position rather than
       * wiggling on its own. wiggle's noise is seeded from the layer id AND the
       * property path (expressions.py::wiggle), so a second wiggle on the aim
       * is a different random walk — smaller, but not opposite, and two
       * unrelated drifts read as a loose tripod rather than as an operator. So
       * the aim subtracts the body's ACTUAL displacement: whatever the position
       * expression puts out, minus where it would have been without the shake,
       * scaled down. When the body drifts left the aim swings right, and the
       * framing settles instead of swimming. */
      const settled = prevPosExpr ? `(${prevPosExpr})` : `[${round3(camPos0).join(", ")}]`;
      const poiNow = camSpec.pointOfInterest ?? camLayer.camera?.pointOfInterest;
      const aimExpr = exprOf(poiNow);
      /* `value` is the property's OWN value at this instant — its keyframes if
       * it has any. Holding the aim with `value` rather than with the literal
       * it happens to be worth right now is what lets this land on a camera
       * whose aim was already animated: the pan it already had survives and
       * gains the correction on top, instead of being frozen at its first key. */
      const held = aimExpr ? `(${aimExpr})` : "value";
      const counterExpr =
        `${held} - (thisComp.layer("${camName}").position - ${settled}) * ${r3(counter)}`;
      if (counter > 0) {
        /* Whatever was under the aim stays under it — a key track stays a key
         * track (§1's { keys, expr }), a constant stays a constant. */
        camSpec.pointOfInterest = isKeyedLike(poiNow)
          ? { keys: poiNow.keys, expr: counterExpr }
          : withExpr(round3(aimVector(poiNow, [cx, cy, 0])), counterExpr);
      } else if (camSpec.pointOfInterest === undefined && poiNow === undefined) {
        /* counter 0 and no aim at all: leave the camera free rather than
         * inventing a point of interest it never had — an ABSENT aim is a real
         * state (engine.py leaves the rotation at identity) and writing one
         * here would silently turn the lens toward the middle of the comp. */
      }
      note = `${Math.round(amplitude)}px at ${r3(frequency)}Hz on the body, with the aim `
        + `correcting ${Math.round(counter * 100)}% of it back. Both are expressions — open the ƒx `
        + `on either row and change the numbers.`;
      break;
    }

    default:
      throw new Error(`No camera move "${move}".`);
  }

  if (Object.keys(camSpec).length || Object.keys(camXform).length) {
    if (camIsNew) {
      /* A layer being created here is written directly, exactly as add_layer
       * and rigs.js write theirs; an EXISTING one goes back as a patch so the
       * route can put it through set_layer's merge and cannot clobber what the
       * operator already keyframed on it. */
      camLayer.camera = { ...(camLayer.camera || {}), ...camSpec };
      Object.assign(camLayer.transform, camXform);
    } else {
      edit.push({ id: camLayer.id,
                  ...(Object.keys(camSpec).length ? { camera: camSpec } : {}),
                  ...(Object.keys(camXform).length ? { transform: camXform } : {}) });
    }
  }

  return {
    create, edit, move,
    cameraId: camLayer.id, cameraName: camLayer.name,
    cameraCreated: camIsNew,
    aimId: aimLayer ? aimLayer.id : null,
    aimName: aimLayer ? aimLayer.name : null,
    start, duration, warnings, note,
  };
}

/* ── small readers ──────────────────────────────────────────────────────── */

const exprOf = (p) =>
  (p && typeof p === "object" && !Array.isArray(p) && typeof p.expr === "string" && p.expr.trim())
    ? String(p.expr) : null;

/** What sits UNDER an expression or a key track — the fallback the engine uses
 *  when the expression fails, and what a rig should preserve rather than
 *  overwrite when it wraps a property somebody else already wrote. */
function valueUnder(p, dflt) {
  if (p && typeof p === "object" && !Array.isArray(p)) {
    if (Array.isArray(p.keys) && p.keys.length) return p.keys[0].v;
    if (p.value !== undefined) return p.value;
    return dflt;
  }
  return p === undefined ? dflt : p;
}

const hasAim = (cam) => cam?.camera?.pointOfInterest !== undefined;

const isKeyedLike = (p) =>
  !!p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.keys) && p.keys.length > 0;

/** An [x, y, z] out of whatever an aim is stored as, for the value that has to
 *  sit under a new expression. */
function aimVector(p, dflt) {
  const v = valueUnder(p, null);
  return Array.isArray(v) ? [num(v[0], 0), num(v[1], 0), num(v[2], 0)] : dflt;
}

/** Is this layer's position animated at all — keys or an expression? Used only
 *  to WARN, never to refuse: a fixed orbit centre around a moving subject is a
 *  legitimate shot, it is just not what most people mean by "orbit them". */
function isMoving(layer) {
  const p = layer?.transform?.position;
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  return Array.isArray(p.keys) ? p.keys.length > 1 : !!exprOf(p);
}

/** A layer by id, then by name — the same order expressions.py::_layer uses, so
 *  what this file resolves and what a rendered expression resolves agree. */
export function findByRef(comp, ref) {
  const want = String(ref);
  const ls = comp.layers || [];
  return ls.find((l) => String(l.id) === want) || ls.find((l) => String(l.name || "") === want) || null;
}
