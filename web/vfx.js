/**
 * VFX — the compositor tab.
 *
 * A compositor's four rooms, laid out the way every compositor lays them out:
 * a comp bar across the top, the layer stack on the left, the picture in the
 * middle, the selected layer's properties on the right, and time across the
 * bottom. Nothing here is invented — the point of copying After Effects's
 * arrangement is that someone who has used one already knows where to look.
 *
 * THE BROWSER NEVER RENDERS THE PICTURE. The viewer is an <img> pointed at
 * `/api/vfx/frame/:slug` — server pixels, the same pixels a render produces.
 * A canvas compositor here would preview one thing and export another, which is
 * the exact defect the Studio tab was built to avoid, and doing it twice would
 * be a choice rather than an accident.
 *
 * EVERY MUTATION GOES THROUGH `/api/vfx`. Not one field is written into the
 * document locally and saved later. That is what makes an agent and a person
 * interchangeable: the same action, typed here or called over MCP, produces
 * byte-identical documents. Drags are the one nuance — a drag paints from a
 * local copy while the pointer is down because a round trip per pointermove is
 * not a UI, and commits through the route on release.
 *
 * ── INTEGRATION ────────────────────────────────────────────────────────────
 * This module owns its whole interior, so index.html needs exactly ONE element:
 *
 *     <div id="vfx" hidden></div>          inside <section class="stage">
 *
 * plus the sheet in <head>:   <link rel="stylesheet" href="vfx.css">
 * and a rail entry:           <a href="#" data-view="vfx"><i>◈</i> VFX</a>
 *
 * Two exports, both safe to call more than once:
 *
 *     export function initVfx()        — once at boot; builds the DOM, wires
 *                                        listeners, fetches NOTHING.
 *     export async function vfxOpen()  — every time the tab is shown; loads the
 *                                        comp list, catalog and libraries.
 *
 * In `setView`, alongside the other views:
 *     $("vfx").hidden = name !== "vfx";
 *     if (name === "vfx") { initVfx(); vfxOpen(); }
 *
 * ── PATH CONVENTION (server owner: this is the one thing we have to agree on)
 * §6 gives `set_prop`/`add_key`/`remove_key` a `path` and one example,
 * `transform.position`. Effect params and mask params are animatable too (§1),
 * so they need paths as well. This UI sends DOTTED DOCUMENT PATHS RELATIVE TO
 * THE LAYER, where a segment landing on an array is matched BY `id`:
 *
 *     transform.position                 → layer.transform.position
 *     effects.fx_1.params.radius         → the effect with id "fx_1"
 *     masks.mk_1.feather                 → the mask with id "mk_1"
 *
 * Ids rather than indices, because reordering an effect must not silently
 * re-point a keyframed property at its neighbour.
 *
 * ── DEGRADING ──────────────────────────────────────────────────────────────
 * The engine is built by other people on other branches and may simply not be
 * there. Every fetch is caught; a failure paints one plain sentence saying the
 * engine is not responding, with a Retry, rather than a stack trace and a blank
 * tab. Empty states — no comps, a comp with no layers, a layer with no effects
 * — are first-class screens, not accidents.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

/** §2. The order is the server's order — the select must not re-sort it. */
const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "softlight", "hardlight", "add",
  "subtract", "difference", "darken", "lighten", "colordodge", "colorburn",
  "hue", "saturation", "color", "luminosity",
];

const LAYER_KINDS = [
  ["image", "▣", "Image", "A still from the images library."],
  ["video", "▷", "Video", "A clip from the clips library."],
  ["solid", "■", "Solid", "A flat rectangle the size of the comp."],
  ["text", "T", "Text", "Type, laid out by the engine."],
  ["shape", "◇", "Shape", "Vector geometry — paths, operations and paint, run in order."],
  ["adjustment", "◐", "Adjustment", "Its effects apply to everything beneath it."],
  ["null", "⊹", "Null", "Renders nothing; exists to be a parent."],
  ["camera", "⌖", "Camera", "A viewpoint. Only 3D layers respond to it; the topmost camera wins."],
  ["comp", "⧉", "Comp", "Another composition, nested as a layer."],
];
/* `audio` gets a glyph but NOT a LAYER_KINDS row: the add-layer picker builds
 * from that list and has no music-library browser to feed an audio src into —
 * offering the kind there would be a dead control that 400s. Audio layers are
 * authored over MCP/REST (v1); the timeline still has to READ them properly. */
const GLYPH = { ...Object.fromEntries(LAYER_KINDS.map(([k, g]) => [k, g])), audio: "♪" };

/**
 * The phases of a shape stack, and the whole reason this panel is not a list.
 *
 * A shape layer is a little program: a PATH pushes geometry onto the current
 * set, an OPERATION rewrites that set, and a PAINT draws whatever the set holds
 * AT THAT MOMENT. So a stroke listed before a trim draws the untrimmed path and
 * the trim then has nothing left to shorten — it renders, it just does nothing,
 * and nothing anywhere says so. Measured, on this engine: ellipse+trim+stroke
 * is a 3.2 KB quarter arc, ellipse+stroke+trim is a 7.9 KB whole circle.
 *
 * The phase of an item is read from the catalog's `group`, never from a list
 * here, so an item type added to shapes.py sorts itself correctly with no UI
 * change. A GROUP draws and carries its own path set, so it ranks with paint:
 * its position decides only what is in front of what.
 */
const PHASE_RANK = { "Path": 0, "Path Operation": 1, "Paint": 2, "Group": 2 };
const PHASE_TAG = { "Path": "path", "Path Operation": "op", "Paint": "paint", "Group": "group" };

/** The expression vocabulary the sandbox accepts (§1), as chips to paste. */
const EXPR_VOCAB = [
  ["value", "what the property is worth underneath — the constant or the keyframes"],
  ["time", "seconds on the comp timeline"],
  ["wiggle(2, 30)", "jitter twice a second by 30"],
  ["random()", "0..1, fresh every frame"],
  ["linear(time, 0, 3, 0, 100)", "0 to 100 over the first three seconds"],
  ["ease(time, 0, 3, 0, 100)", "the same, eased at both ends"],
  ["loopIn()", "repeat the keyframes before the first one"],
  ["loopOut()", "repeat the keyframes after the last one"],
  ["valueAtTime(time - 0.2)", "this property, a fifth of a second ago"],
  ["velocity()", "how fast it is changing"],
];

/**
 * ⚠ DELETE THIS THE DAY engine.py PASSES THE SANDBOX IN, and delete the line in
 * the expression editor that prints it. Measured on this build: `expressions.py`
 * exists and works, `interp.eval_prop` takes a `ctx` and evaluates an `expr`
 * when it is given one — and `engine.py` never imports the module or passes the
 * argument, so every render reads the value underneath. interp.py names the
 * distinction itself: "That is the difference between wiring expressions in and
 * turning them on."
 *
 * Two frames of one comp, same moment, opacity 100, with and without
 * `expr: "value * 0.2"`: byte-identical, sha1 88e244b720 both times.
 *
 * Storing, reading, clearing and reporting an expression all work, so the panel
 * does its half properly. Saying the render honours it would be the one thing
 * this file must not do.
 */
const EXPR_STATE =
  "On this build the renderer does not run expressions yet — engine.py evaluates properties "
  + "without passing the sandbox in, so one is stored, kept and given back intact, and the picture "
  + "stays at the value underneath.";

/** The seven tracks audiokeys.py cuts a sound into, §1. */
const AUDIO_TRACKS = [
  ["amplitude", "the whole signal"],
  ["bass", "the low end"],
  ["lowMid", "body"],
  ["highMid", "presence"],
  ["treble", "air"],
  ["onset", "attacks"],
  ["beat", "a pulse on each beat, decaying"],
];

const MATTES = [
  ["", "No matte"],
  ["alpha", "Alpha"],
  ["alphaInv", "Alpha inverted"],
  ["luma", "Luma"],
  ["lumaInv", "Luma inverted"],
];

const EASES = ["linear", "hold", "easeIn", "easeOut", "easeInOut"];

/** The five transform rows, in AE's order. `arity` decides how many boxes. */
/* `z` is what a MISSING third component is worth on a 3D layer. The engine
 * defaults it (§1) and the two answers differ — 0 for anchor and position, 100
 * for scale — so a Z box that showed 0 for a scale would say the layer had been
 * flattened when it had not. Both arities are legal in the document, and the
 * panel has to read the shorter one the way the renderer reads it. */
const XFORM = [
  ["transform.anchor", "Anchor", 2, { step: 1, unit: "px", z: 0 }],
  ["transform.position", "Position", 2, { step: 1, unit: "px", z: 0 }],
  ["transform.scale", "Scale", 2, { step: 1, unit: "%", z: 100 }],
  ["transform.rotation", "Rotation", 1, { step: 1, unit: "°" }],
  ["transform.opacity", "Opacity", 1, { step: 1, min: 0, max: 100, unit: "%" }],
];

/* ─────────────────────────────────────────────────────────────────── state */

/* `comp` is the SERVER's document, never edited in place except during a drag
 * (see `drag`, which owns the exception and hands the document back at the end
 * by reloading it). `rev` busts the frame cache: the URL only carries t and
 * scale, so without it a mutation at a stationary playhead shows the old pixels. */
const V = {
  comps: [],          // the picker rows
  slug: null,
  comp: null,         // the whole document, §1
  catalog: null,      // { type: { label, group, why, params } }, §5
  shapeCat: null,     // the same table for the 16 shape item types
  images: [], clips: [], songs: [],
  sel: null,          // selected layer id
  /* [precomp-multisel] Ctrl-click multi-selection over the layer rows —
   * SELECTION STATE ONLY. Every panel still reads `V.sel`; the one gesture
   * that reads this set is Pre-compose, which is exactly the scope it was
   * added for. Invariant: empty, or two-plus ids (a single survivor collapses
   * back into `sel`), and it never names a layer the document lost. */
  msel: new Set(),
  itemOpen: new Set(), // "layerId:index" — shape items expanded in Properties

  /* The enumerator's answer, per layer, stamped with the `rev` it was asked
   * at. Never derived here — see loadProps. */
  props: new Map(),   // layerId -> { rev, rows, why }
  propsPending: new Set(),
  gopen: new Set(),   // groups twirled open: "lid::Transform", "lid::Effects::fx_9"
  tlH: 0,             // the time area's height in pixels; 0 = not chosen yet
  t: 0,               // playhead, seconds
  inT: 0, outT: null, // work area; outT null = the comp's end
  playing: false, playTimer: null,
  scrubbing: false,
  pps: 90,            // timeline zoom, pixels per second
  open: new Set(),    // layer ids expanded in the timeline
  fxOpen: new Set(),  // effect ids expanded in Properties
  rev: 0,
  job: null,          // { label, pct } while a render runs
  jobTimer: null,
  down: false,        // the engine did not answer

  /* What a PREVIEW costs, chosen rather than assumed. Measured on the seeded
   * comp: 3.8 fps at full quality, 15 at half in draft, 55 at quarter. A player
   * that silently picks one of those and stutters is worse than one that says
   * which it picked, so the choice is a control and the badge over the picture
   * names it. Idle always settles at full — reduced quality is for motion. */
  preview: { scale: 0.5, draft: true },
  fpsSeen: [],        // round-trip ms of the last few preview frames

  /* The workspace: which 3D view the frame renders from (null = the active
   * camera), the gizmo overlay, and the Info readout. The gizmo's GEOMETRY is
   * the server's — /api/vfx view_overlay, engine projection — cached here per
   * (rev, sel, t, view) so a repaint is not a python spawn. */
  view: null,         // null | { name, yaw?, pitch? }
  gizmo: true,        // draw the tripod/outline/wireframes over the picture
  info: false,        // the RGBA readout under the cursor
  ovl: null,          // { key, data } — the last view_overlay answer
  ovlBusy: false,
  infoBusy: false,

  /* Workspace furniture — rulers, guides, grid, title/action safe, snapping.
   *
   * THE STATE SPLIT, decided rather than drifted into: the GUIDES THEMSELVES
   * are document state (V.comp.guides, written through the set_guides action)
   * because a guide marks a place in the composition — it must survive reload,
   * travel with the comp, and be visible to MCP agents, exactly as AE saves
   * guides in the project. EVERYTHING in V.ws is view state (persisted per
   * browser in localStorage): whether rulers/guides/grid/safe are DRAWN, the
   * grid's spacing, whether snapping is on, and the guide lock are all about
   * how this person is looking at the comp right now — two people on the same
   * comp may want opposite answers, and none of it changes a rendered pixel.
   * The lock is deliberately view-state too: it protects against YOUR stray
   * drag; it is not an authorisation bit on the document. */
  ws: { rulers: true, guides: true, lock: false, grid: false, gridSize: 100, gridDivs: 4, safe: false, snap: true },
  guideDraft: null,   // { axis, position, hideIndex? } — a guide mid-drag, not yet written
  snapHit: null,      // { key, x?, y? } — the snap flash while a gizmo drag holds a target

  /* The graph editor: which property it is on, and which of a vector's
   * components carries the handles. `null` closes it. */
  graph: null,        // { layerId, path, mode: "value" | "speed" }
  gcomp: 0,
  ksel: new Set(),    // selected keyframes, "layerId|path|t.toFixed(4)"
  motionPath: false,  // the position track drawn over the picture

  /* Undo. `stack` holds whole documents — see the note above histPush. */
  hist: { slug: null, stack: [], at: -1, restoring: false },
};

/* ────────────────────────────────────────────────────────────────────── api */

/** One POST per action, §6. Any failure here means the engine is not there. */
async function api(body) {
  const r = await fetch("/api/vfx", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

async function getJson(path) {
  const r = await fetch(path);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

/** Every mutation lands here: run it, take the server's document back, repaint.
 *  The server is the truth — a route that rewrites what you asked for (clamping
 *  a duration, renaming a slug) must be visible immediately, not next reload. */
async function mutate(body, { reloadList = false, context = null, label = null, coalesce = null } = {}) {
  /* Stamped BEFORE the round trip, and this is not a detail.
   *
   * Measured: holding an arrow key on a number box fires ~40 `change` events in
   * half a second, each one a POST. The server serialises writes to a comp, so
   * the REPLIES came back spread over four seconds — and a merge window
   * measured from the reply saw four seconds of gaps and wrote seven history
   * entries for one gesture. The gesture happened in half a second; the time
   * that describes it is when it was asked for. */
  const asked = Date.now();
  try {
    const d = await api(body);
    V.rev++;
    if (reloadList) await loadList();
    if (d.comp) V.comp = d.comp;
    else await loadComp();
    /* One place, so nothing can mutate the document without the history
     * hearing about it — including an action added to this file next year that
     * nobody remembers to register. That is the whole reason `mutate` exists as
     * a funnel, and it is why the history hangs off it rather than off buttons. */
    histPush(label || histLabel(body), V.comp, coalesce, asked);
    paint();
    return d;
  } catch (e) {
    /* `context` widens a true-but-terse refusal into one that says what to do.
     * It never replaces the server's words — the message it was given is still
     * in there, because that is the string somebody will search for. */
    note(context ? context(e.message || "") : (e.message || "That did not go through."));
    /* Re-read rather than trusting the screen: a rejected action may still have
     * changed something before it failed, and a stale panel lies about it. */
    await loadComp();
    paint();
    return null;
  }
}

/**
 * A layer write, READ BACK.
 *
 * `set_layer` answers `{ ok: true }` for every field it was given, including the
 * ones it does not implement — it merges the handful it knows and drops the
 * rest without a word (they no longer are — the server accepts all four; the guard
 * below stays as the check that keeps it honest). Four fields the engine renders correctly reach the
 * document through nothing else — `shapes`, `threeD`, `camera`, `collapse` —
 * and measured against this build every one of them is dropped, so a panel that
 * trusted `ok` would let you edit a shape for an hour and show you the same
 * picture throughout. The neighbouring gaps at least fail out loud: a 3D
 * rotation and a comp layer's source are both REFUSED, with a message, and go
 * through `mutate`'s `context` instead of through here.
 *
 * So: ask, take the server's document back, and compare what came back against
 * what was sent. A field that did not land is named out loud. Nothing here
 * works around the gap — when the route learns these fields this function keeps
 * quiet and the panels above it do not change.
 */
async function setLayerField(l, patch, coalesce = null) {
  const d = await mutate({ action: "set_layer", slug: V.slug, layerId: l.id, ...patch }, { coalesce });
  if (!d) return null;                          // it was refused; mutate said so
  const after = layerOf(l.id);
  const missed = Object.keys(patch).filter((k) =>
    JSON.stringify(after?.[k] ?? null) !== JSON.stringify(patch[k] ?? null));
  if (missed.length) {
    note(`The engine draws ${missed.join(" and ")}, but /api/vfx does not write ${missed.length === 1 ? "it" : "them"} yet — `
      + `set_layer answered ok and handed back a document in which nothing changed.`);
  }
  return missed;
}

/* ───────────────────────────────────────────────────────────────── history
 *
 * WHOLE-DOCUMENT SNAPSHOTS, RESTORED THROUGH `set_comp`. Not inverse operations.
 *
 * The choice is nearly made for us by the shape of this tab. Every mutation
 * already round-trips the entire document — `mutate` takes `d.comp` back and
 * throws the local copy away — so the state before and after each action is
 * already in this file's hands, and a snapshot costs one deep copy of something
 * we were handed anyway. There is no separate model to keep in sync,
 * which is the failure mode a per-action undo eventually finds: `set_layer`
 * grows a field, nobody writes its inverse, and undo starts quietly losing it.
 *
 * The 28 actions in §6 would need 28 inverses. Three of them have none worth
 * writing: `precompose` creates a second comp, `audio_keys` and `track_motion`
 * replace an entire track from an analysis. Snapshots handle all three without
 * knowing they exist.
 *
 * Restoring is ONE existing action — `set_comp` takes the whole layer stack
 * plus every comp-level field — so undo travels the same route as everything
 * else, is subject to the same validation, and needs nothing added to the
 * server. `migrate` passes an animated property through untouched, so a key's
 * `ease`, `to`, `ti` and `roving` survive the round trip byte for byte.
 *
 * WHAT IT DOES NOT COVER, said plainly rather than discovered later:
 *   · comp lifecycle — new, duplicate, delete. Those are files on disk, and a
 *     history that offers to un-delete a folder it did not keep is a lie.
 *   · undoing a `precompose` restores this comp's layers; the child comp it
 *     made stays on disk. [precomp-multisel] The panel HAS the button now —
 *     right-click a layer row → Pre-compose — and the whole gesture is one
 *     entry here because it travels through `mutate` like everything else;
 *     `histTo` says out loud that the child comp survives the undo.
 *
 * Cost, measured rather than assumed: the two comps on this machine are 4.3 KB
 * and 7.4 KB of JSON, so fifty steps is well under a megabyte. The case that
 * would not be is a track written by `audio_keys` — a three-minute song at 30
 * keys a second is 5400 keys on one property, six figures of JSON — and fifty
 * of those is tens of megabytes. That is survivable on a desktop and it is the
 * number to look at first if this tab ever starts feeling heavy.
 *
 * `runs` is dropped from the snapshot: it is the server's append-only audit
 * log, `set_comp` cannot write it, and it is the one field that only grows.
 */

const HIST_CAP = 50;
/**
 * The TAIL of a gesture, not the gesture.
 *
 * A window alone was tried first and it does not hold, which is worth writing
 * down because the reason is not obvious: measured on this build, one property
 * write costs about 700 ms end to end — the round trip, the repaint, and the
 * engine rendering a fresh preview frame for the new document, all competing
 * for the same box. Forty `change` events from one held arrow key therefore
 * arrive spread over half a minute, and a stopwatch measuring the gaps between
 * them wrote THIRTY history entries for one gesture.
 *
 * So the gesture bounds itself: while a key or a pointer is down, same-key
 * writes merge however long they take (`V.hist.holding` below). The window is
 * only what catches the last one or two replies still in flight after the key
 * comes up, and what keeps two deliberate edits a beat apart as two entries.
 */
const HIST_MERGE_MS = 700;

/** The fields `set_comp` writes — the exact and only definition of a snapshot. */
const HIST_FIELDS = ["name", "width", "height", "fps", "duration", "bg", "markers", "motionBlur", "seed", "layers"];

function histSnap(doc) {
  if (!doc) return null;
  const out = {};
  for (const k of HIST_FIELDS) if (doc[k] !== undefined) out[k] = doc[k];
  return JSON.parse(JSON.stringify(out));
}

/** A label a person can read back. The action name is the fallback, never the
 *  goal: "opacity" is a history entry, "set_prop" is a route. */
function histLabel(b) {
  const a = String(b.action || "edit");
  const lname = () => layerOf(b.layerId ?? b.id)?.name || "layer";
  const leaf = (p) => String(p || "").split(".").pop();
  switch (a) {
    case "set_prop": return b.keys ? `${leaf(b.path)} keyframes` : b.expr !== undefined ? `${leaf(b.path)} expression` : leaf(b.path);
    case "add_key": return `key on ${leaf(b.path)}`;
    case "remove_key": return `remove key on ${leaf(b.path)}`;
    case "set_effect": return b.params ? `${Object.keys(b.params)[0]}` : "effect on/off";
    case "add_effect": return `add ${b.type}`;
    case "remove_effect": return "remove effect";
    case "reorder_effect": return "reorder effects";
    case "add_layer": return `add ${b.type} layer`;
    case "remove_layer": return `remove ${lname()}`;
    case "reorder_layer": return "reorder layers";
    case "set_layer": return `${Object.keys(b).filter((k) => !["action", "slug", "layerId", "id"].includes(k)).join(", ") || "layer"}`;
    case "set_comp": return `comp ${Object.keys(b).filter((k) => !["action", "slug"].includes(k)).join(", ")}`;
    case "audio_keys": return "keyframes from sound";
    case "track_motion": return "keyframes from motion";
    default: return a.replace(/_/g, " ");
  }
}

function histReset(doc) {
  V.hist = {
    slug: V.slug, restoring: false, at: doc ? 0 : -1, holding: false,
    stack: doc ? [{ label: "opened", snap: histSnap(doc), stamp: 0, coalesce: null }] : [],
  };
  paintHist();
}

/**
 * Is the user still mid-gesture? A key or a pointer down anywhere in the tab.
 *
 * On the WINDOW, in the capture phase, because that is the only place that sees
 * every one of them: a drag released outside the panel delivers its pointerup
 * to whatever is under the cursor, and a hold ended by tabbing away delivers no
 * keyup at all. A gesture that never closes would merge the NEXT edit of the
 * same control into it however much later, which is a worse failure than the
 * one this exists to fix — so `blur` closes it too.
 *
 * Opening on any key or pointer anywhere is safe: merging still requires a
 * matching coalesce key, and only this tab's own writes carry one.
 */
function wireGestureBounds() {
  const open = () => { V.hist.holding = true; };
  const shut = () => { V.hist.holding = false; };
  for (const [type, fn] of [["keydown", open], ["pointerdown", open], ["keyup", shut],
    ["pointerup", shut], ["pointercancel", shut], ["blur", shut]]) {
    window.addEventListener(type, fn, true);
  }
}

/**
 * A step. `coalesce` is a key that says "this is the same gesture as the last
 * one": consecutive pushes carrying it, within the merge window, REPLACE the
 * top of the stack instead of growing it. Holding an arrow key on the Opacity
 * box fires a `change` per repeat, and forty entries from one gesture is worse
 * than no history at all — the list stops being scannable, and the cap throws
 * away the step you actually wanted.
 */
function histPush(label, doc, coalesce = null, stamp = Date.now()) {
  const h = V.hist;
  if (h.restoring || !doc || h.slug !== V.slug || h.at < 0) return;
  const top = h.stack[h.at];
  const sameGesture = coalesce && top && top.coalesce === coalesce
    && (h.holding || Math.abs(stamp - top.stamp) < HIST_MERGE_MS);
  if (sameGesture) {
    top.snap = histSnap(doc);
    top.label = label;
    // The LATEST request in the run, so a gesture that outlasts one window
    // keeps merging as long as it keeps going.
    top.stamp = Math.max(top.stamp, stamp);
    return paintHist();
  }
  // Everything after the current step is a future that just stopped happening.
  h.stack.length = h.at + 1;
  h.stack.push({ label, snap: histSnap(doc), stamp, coalesce });
  if (h.stack.length > HIST_CAP) h.stack.shift();
  h.at = h.stack.length - 1;
  paintHist();
}

const canUndo = () => V.hist.at > 0;
const canRedo = () => V.hist.at >= 0 && V.hist.at < V.hist.stack.length - 1;

/**
 * Travel to step `i` by writing its document back.
 *
 * `restoring` is what stops the write from being recorded as a new step —
 * without it, undo would push the state it just restored and redo would be
 * unreachable forever.
 */
async function histTo(i) {
  const h = V.hist;
  if (h.restoring || i < 0 || i >= h.stack.length || i === h.at) return;
  const step = h.stack[i];
  const back = i < h.at;
  h.restoring = true;
  try {
    const d = await api({ action: "set_comp", slug: V.slug, ...step.snap });
    V.rev++;
    if (d.comp) V.comp = d.comp; else await loadComp();
    h.at = i;
    /* Break the merge window across a jump: an edit made right after an undo is
     * a new step, however fast it followed and whatever it touched. */
    if (h.stack[h.at]) h.stack[h.at].coalesce = null;
    /* The selection may name a layer this document does not have — undoing an
     * "add layer" is the ordinary case — and every panel reads `V.sel`. */
    if (!layers().some((l) => l.id === V.sel)) V.sel = layers()[0]?.id || null;
    if (V.graph && !layerOf(V.graph.layerId)) V.graph = null;
    V.ksel.clear();
    paint();
    /* Undoing a precompose puts this comp's layers back and leaves the comp it
     * made sitting on disk. That is not a bug this history can fix — it never
     * held that comp — but it is exactly the kind of thing a person discovers
     * three days later in the picker, so it is said at the moment it happens. */
    const orphan = back && V.hist.stack[i + 1]?.label === "precompose";
    note(`${back ? "Undone" : "Redone"} — the comp is at "${step.label}".`
      + (orphan ? " The comp that precompose made is still in the picker — this history never held it, so undo cannot take it back." : ""));
  } catch (e) {
    /* A refused restore leaves the document where it was, which is safe but
     * silent, so it is said out loud. The one shape this takes in practice: a
     * comp shortened since the snapshot, whose layers no longer fit. */
    note(`That step could not be restored: ${e.message || e}`);
    await loadComp();
    paint();
  } finally {
    h.restoring = false;
  }
  paintHist();
}

const undo = () => (canUndo() ? histTo(V.hist.at - 1) : note("Nothing to undo — this is where the comp opened."));
const redo = () => (canRedo() ? histTo(V.hist.at + 1) : note("Nothing to redo."));

/** The two buttons, re-stated rather than repainted: the bar around them is
 *  expensive to rebuild and this runs after every single mutation. */
function paintHist() {
  const u = $("vfxUndo"), r = $("vfxRedo");
  if (!u || !r) return;
  const h = V.hist;
  u.disabled = !canUndo();
  r.disabled = !canRedo();
  u.title = canUndo()
    ? `Undo "${h.stack[h.at].label}" (Ctrl+Z) — ${h.at} step${h.at === 1 ? "" : "s"} back to where this comp opened`
    : "Nothing to undo — this is where the comp opened";
  r.title = canRedo() ? `Redo "${h.stack[h.at + 1].label}" (Ctrl+Shift+Z)` : "Nothing to redo";
}

/* ────────────────────────────────────────────────────────────────── loading */

export async function vfxOpen() {
  initVfx();
  V.down = false;
  try {
    await loadList();
  } catch {
    V.down = true;
    paint();
    return;
  }
  /* The catalog is what makes the effects panel build itself, so a new effect
   * on the python side appears here with no UI change. Fetched once per boot;
   * it is a static table behind a cache on the server. */
  if (!V.catalog) {
    try { V.catalog = (await getJson("/api/vfx/catalog")).effects || {}; }
    catch { V.catalog = {}; }
  }
  /* The shape catalog is the same idea one table over: 16 item types, their
   * parameters and — the part this panel is built on — which PHASE each one
   * belongs to. Fetched beside the effects catalog because the shape section
   * cannot draw a single row without it. */
  if (!V.shapeCat) {
    try { V.shapeCat = (await getJson("/api/vfx/shapes")).shapes || {}; }
    catch { V.shapeCat = {}; }
  }
  if (!V.slug && V.comps.length) V.slug = V.comps[0].slug;
  await loadComp();
  paint();
  /* The library pickers are only needed if you press "add layer", but fetching
   * them then means a spinner in a menu. Two cheap listings on tab-open, in the
   * background, and the menu is instant. Failure is fine — the picker says so. */
  loadLibraries();
}

async function loadList() {
  const d = await getJson("/api/vfx/comps");
  V.comps = d.comps || [];
  V.down = false;
  if (V.slug && !V.comps.some((c) => c.slug === V.slug)) V.slug = null;
}

async function loadComp() {
  if (!V.slug) { V.comp = null; return; }
  try {
    const d = await getJson(`/api/vfx/comp/${encodeURIComponent(V.slug)}`);
    V.comp = d.comp || null;
  } catch {
    V.comp = null;
  }
  if (V.comp) {
    V.t = clamp(V.t, 0, V.comp.duration || 0);
    if (V.outT == null || V.outT > V.comp.duration) V.outT = V.comp.duration;
    if (!layers().some((l) => l.id === V.sel)) V.sel = layers()[0]?.id || null;
  }
  /* A different comp is a different document, so it gets a different history —
   * anything else offers to undo an edit into a comp that is no longer open.
   * Re-reading the SAME comp (which every failed mutation does) must not wipe
   * the stack, which is why this is keyed on the slug and not on the call. */
  if (V.hist.slug !== V.slug) histReset(V.comp);
}

async function loadLibraries() {
  try { V.images = (await getJson("/api/images")).images || []; } catch { /* offline */ }
  try { V.clips = (await getJson("/api/clips")).clips || []; } catch { /* offline */ }
}

/* ────────────────────────────────────── what a layer can animate: ONE list
 *
 * `layer_properties` is the SERVER's enumerator, and `vfx_layer_properties`
 * reads the same function. So a row this tree draws and a path an agent can
 * name are the same sentence by construction, rather than by two people
 * remembering to keep two lists in step — which is the failure this codebase
 * has shipped repeatedly, most recently as a shape parameter the engine
 * animated and no path could reach.
 *
 * Every `path` it answers with is one `set_prop`, `add_key` and `remove_key`
 * take VERBATIM, so nothing between here and the wire rewrites one. The tree
 * used to build its own list off the catalog; that function is gone rather
 * than kept beside this one, because two lists is the whole problem.
 *
 * Cached per layer and stamped with `V.rev`: adding an effect or a mask
 * changes what a layer can animate, and every mutation bumps rev, so the next
 * paint of an OPEN layer re-asks and a closed one is never asked about at all.
 */
async function loadProps(layerId) {
  const rev = V.rev, slug = V.slug;
  try {
    const d = await api({ action: "layer_properties", slug, layerId });
    if (V.slug !== slug) return;
    V.props.set(layerId, { rev, rows: d.properties || [] });
  } catch (e) {
    /* Cached as a failure, stamped the same way. Retrying every paint would be
     * a request per frame against a route that is answering an error. */
    V.props.set(layerId, { rev, rows: [], why: e.message || String(e) });
  } finally {
    V.propsPending.delete(layerId);
  }
  if (V.slug !== slug) return;
  paintTimeline();
  // The chip strip down the side of the plot is this same list.
  if (V.graph?.layerId === layerId) paintGraph();
}

/** The rows for a layer, or null while the first answer is in flight. Stale
 *  rows are handed back rather than nothing: one frame of last-rev labels
 *  beats a tree that empties itself on every keystroke. */
function propsOf(layerId) {
  const hit = V.props.get(layerId);
  if (hit && hit.rev === V.rev) return hit;
  if (!V.propsPending.has(layerId)) { V.propsPending.add(layerId); loadProps(layerId); }
  return hit || null;
}

/** The same list, awaited — for the handful of callers that cannot paint a
 *  placeholder and come back (the graph toggle, the analysis pickers). */
async function propRowsFor(layerId) {
  const hit = V.props.get(layerId);
  if (hit && hit.rev === V.rev) return hit.rows;
  V.propsPending.add(layerId);
  await loadProps(layerId);
  return V.props.get(layerId)?.rows || [];
}

/* ────────────────────────────────────────────── keyframes: reading a value
 *
 * A CLIENT-SIDE COPY OF §1'S EVALUATOR, FOR DISPLAY ONLY. It decides what
 * number shows in a box and where a diamond sits — never a pixel. The engine's
 * `interp.py` is the real one, and if the two ever disagree the python wins.
 * Keeping this honest matters anyway: a Position box that reads 0 while the
 * frame shows the layer at 960 is worse than no box at all.
 */

const isAnim = (p) => !!p && typeof p === "object" && !Array.isArray(p) && Array.isArray(p.keys);
const keysOf = (p) => (isAnim(p) ? [...p.keys].sort((a, b) => a.t - b.t) : []);

/**
 * An expression LAYERS OVER the property (§1): the constant or the keyframes
 * stay underneath and the expression reads them as `value`. So a property may
 * be `{expr, value}`, `{expr, keys}`, or plain — and all three have to read.
 *
 * THIS EVALUATOR CANNOT RUN THE EXPRESSION and must never look as though it
 * has. The sandbox is python, in the engine; this file is a mirror kept for
 * deciding what a number box says and where a diamond sits. So it returns the
 * value UNDERNEATH an expression, and every row that carries one says out loud
 * that the picture above is the only place the real value exists.
 */
const hasExpr = (p) =>
  !!p && typeof p === "object" && !Array.isArray(p) && typeof p.expr === "string" && !!p.expr.trim();
const exprOf = (p) => (hasExpr(p) ? p.expr : null);

const NAMED_BEZIER = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** CSS cubic-bezier semantics: solve x(s)=u for s, return y(s). Bisection —
 *  twenty halvings is a thousandth of a frame and needs no derivative. */
function bezierAt([x1, y1, x2, y2], u) {
  const bez = (a, b, s) => {
    const m = 1 - s;
    return 3 * m * m * s * a + 3 * m * s * s * b + s * s * s;
  };
  let lo = 0, hi = 1, s = u;
  for (let i = 0; i < 20; i++) {
    s = (lo + hi) / 2;
    if (bez(x1, x2, s) < u) lo = s; else hi = s;
  }
  return bez(y1, y2, s);
}

function easeAt(ease, u) {
  if (!ease || ease === "linear") return u;
  if (ease === "hold") return 0;              // the segment holds until the next key
  if (typeof ease === "object" && Array.isArray(ease.bezier)) return bezierAt(ease.bezier, u);
  const b = NAMED_BEZIER[ease];
  return b ? bezierAt(b, u) : u;
}

function evalProp(p, t) {
  if (!isAnim(p)) {
    // `{expr, value}` — an expression with no keyframes under it. Unwrapping is
    // what stops a number box reading "[object Object]" the moment an agent
    // sets one over MCP.
    return (p && typeof p === "object" && !Array.isArray(p) && "value" in p) ? p.value : p;
  }
  const ks = keysOf(p);
  if (!ks.length) return 0;
  if (t <= ks[0].t) return ks[0].v;
  if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1].t <= t) i++;
  const a = ks[i], b = ks[i + 1];
  const u = easeAt(a.ease, (t - a.t) / ((b.t - a.t) || 1));
  const mix = (x, y) => x + (y - x) * u;
  return Array.isArray(a.v)
    ? a.v.map((x, j) => mix(num(x), num(Array.isArray(b.v) ? b.v[j] : b.v, x)))
    : mix(num(a.v), num(b.v));
}

/**
 * WHERE a path points, in the local copy of the document.
 *
 * A read, and only a read — the mirror of `store.js:resolvePropPath` the same
 * way `evalProp` is the mirror of `interp.py`. It exists because the enumerator
 * answers with `value` at t=0 and `animated`, and a timeline row needs the
 * KEYFRAMES and the value AT THE PLAYHEAD, neither of which travels in that
 * reply. Nothing here invents a path: it is handed one the server produced and
 * finds it in the document the server just sent back.
 *
 * Both effect spellings resolve, exactly as the server accepts both:
 * `effects.fx_1.radius` is what the enumerator answers with, and
 * `effects.fx_1.params.radius` is what the JSON reads like.
 */
function propAt(layer, path) {
  if (!layer) return undefined;
  const p = String(path ?? "").split(".");
  if (!p[0]) return undefined;
  if (p.length === 1) return p[0] === "opacity" ? layer.transform?.opacity : layer[p[0]];
  if (p[0] === "transform" && p.length === 2) return layer.transform?.[p[1]];
  if (p[0] === "effects" && p.length >= 3) {
    const e = (layer.effects || []).find((x) => x && x.id === p[1]);
    return e?.params?.[p[2] === "params" ? p[3] : p[2]];
  }
  if (p[0] === "masks" && p.length === 3) {
    return (layer.masks || []).find((m) => m && m.id === p[1])?.[p[2]];
  }
  /* The shape tree: a numeric segment indexes a list, anything else is a key,
   * which is all `shapes.1.items.0.width` ever is. */
  if (p[0] === "shapes" && p.length >= 3) {
    let node = layer.shapes;
    for (let i = 1; i < p.length - 1; i++) {
      if (node == null) return undefined;
      node = Array.isArray(node) ? node[/^\d+$/.test(p[i]) ? Number(p[i]) : p[i]] : node[p[i]];
    }
    return node?.[p[p.length - 1]];
  }
  return undefined;
}

/**
 * The same read, but falling back to the CATALOG DEFAULT for an effect param
 * that has never been set.
 *
 * A document only stores the params somebody changed — `{ "params": {} }` is a
 * perfectly ordinary effect. Reading straight through `readPath` there gives
 * `undefined`, which showed a Drop Shadow's distance as 0 when the effect was
 * actually rendering at its default of 10: a panel disagreeing with the picture.
 * Every read that feeds a control or a keyframe goes through here.
 */
function resolveProp(l, path) {
  const v = propAt(l, path);
  if (v !== undefined) return v;
  const p = String(path).split(".");
  if (p[0] === "effects" && p.length >= 3) {
    const e = (l.effects || []).find((x) => x.id === p[1]);
    return V.catalog?.[e?.type]?.params?.[p[2] === "params" ? p[3] : p[2]]?.default;
  }
  return undefined;
}

/* ─────────────────────────────────────────────────────────────── small reads */

const layers = () => V.comp?.layers || [];
const layerOf = (id) => layers().find((l) => l.id === id) || null;
const selected = () => layerOf(V.sel);
const fps = () => V.comp?.fps || 30;
const dur = () => Math.max(0.1, V.comp?.duration || 1);
const frameOf = (t) => Math.round(t * fps());
const soloing = () => layers().some((l) => l.solo);

const fmtT = (t) => `${(t || 0).toFixed(2)}s`;

/** The layer directly above is the matte donor, AE's rule (§1). */
const indexOf = (id) => layers().findIndex((l) => l.id === id);

function note(msg) {
  const el = $("vfxNote");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
  clearTimeout(note._t);
  if (msg) note._t = setTimeout(() => { el.hidden = true; }, 6000);
}

/* ──────────────────────────────────────────────────────────────── the shell */

export function initVfx() {
  const root = $("vfx");
  if (!root || root.dataset.wired) return;
  root.dataset.wired = "1";
  root.innerHTML = `
    <div class="vfxbar" id="vfxBar"></div>
    <p class="hint vfxnote" id="vfxNote" hidden></p>
    <div class="vfxbody" id="vfxBody">
      <section class="vfxpanel vfxcentre">
        <div class="vfxwell" id="vfxWell">
          <div class="vfxcheck" id="vfxCheck">
            <img id="vfxFrame" alt="">
            <svg class="vfxguides" id="vfxGuides" hidden></svg>
            <svg class="vfxmp" id="vfxMotionPath" hidden></svg>
            <svg class="vfxgz" id="vfxGizmo" hidden></svg>
            <canvas class="vfxruler top" id="vfxRulerTop" hidden
              title="Comp pixels. Drag into the picture to drop a horizontal guide — double-click for an exact position."></canvas>
            <canvas class="vfxruler left" id="vfxRulerLeft" hidden
              title="Comp pixels. Drag into the picture to drop a vertical guide — double-click for an exact position."></canvas>
            <span class="vfxrulercorner" id="vfxRulerCorner" hidden></span>
            <span class="vfxqual" id="vfxQual" hidden></span>
            <span class="vfxinfo" id="vfxInfo" hidden></span>
          </div>
          <p class="vfxviewnote" id="vfxViewNote"></p>
        </div>
        <div class="vfxtransport" id="vfxTransport"></div>
      </section>

      <section class="vfxpanel vfxprops">
        <header class="vfxhead"><h3 id="vfxPropsTitle">Properties</h3></header>
        <div class="vfxpropsbody" id="vfxPropsBody"></div>
      </section>
    </div>
    <div class="vfxsplit" id="vfxSplit" role="separator" aria-orientation="horizontal"
         title="Drag to give the timeline more or less of the window — double-click to reset"><i></i></div>
    <div class="vfxtimearea" id="vfxTime">
      <div class="vfxtl" id="vfxTl"></div>
      <div class="vfxgraph" id="vfxGraph" hidden></div>
    </div>
    <div class="vfxblank" id="vfxDown" hidden>
      <h3>The VFX engine is not responding.</h3>
      <p class="hint">Nothing was lost — comps live on disk under <code>vfx/&lt;slug&gt;/comp.json</code>
        and this tab only reads and writes them through <code>/api/vfx</code>. Either the server
        has not mounted those routes yet, or it is restarting.</p>
      <button class="btn sm" type="button" id="vfxRetry">Try again</button>
    </div>
    <div class="vfxoverlay" id="vfxOverlay" hidden></div>`;

  $("vfxRetry").onclick = () => vfxOpen();
  loadWs();
  wireViewer();
  wireRulers();
  wireInfo();
  wireDelegates();
  wireGestureBounds();
  wireKeys();
  wireSplit();
}

/* ────────────────────────────────────────── how tall the time area is
 *
 * In After Effects the timeline is roughly two fifths of the window and it is
 * where the work happens; here it was eighty pixels, eleven percent, holding
 * two layer bars. So: TALL BY DEFAULT AND DRAGGABLE. Not a hardcoded 40% —
 * a fixed fraction is wrong on a 4K panel and wrong again on a laptop, and the
 * one number that is always right is the one the person editing chose.
 *
 * The floor is not decoration: the viewer needs enough height to still be a
 * picture, and a splitter that can hide either side is a splitter that gets
 * dragged into a corner once and then fought with.
 */
const TL_FRACTION = 0.42;
const TL_MIN = 132;         // the ruler, a layer, and two property rows
const VIEW_MIN = 120;       // the picture is still a picture at this height
const TL_KEY = "vfx.tlH";

const tlDefault = (total) => clamp(Math.round(total * TL_FRACTION), TL_MIN, Math.max(TL_MIN, total - VIEW_MIN * 2));

/**
 * The ceiling, MEASURED rather than derived.
 *
 * `total - <a floor>` is the obvious formula and it is wrong twice over: the
 * tab is a flex column, so the comp bar, the note line, the splitter and three
 * gaps all come out of `total` before the picture sees any of it — and inside
 * the body, the transport takes another thirty. Measured, that let the splitter
 * squeeze the frame to one pixel square, then to 78×44.
 *
 * So ask the layout, and ask it about THE THING BEING PROTECTED: the box the
 * picture is drawn in. The time area may grow by exactly what that box has to
 * spare above its floor, whatever the chrome around it costs. This function is
 * the only writer of the height, so what the DOM currently reports IS the base
 * to add the spare room to.
 */
function tlCap(time, view) {
  const room = (view.clientHeight || 0) - VIEW_MIN;
  return Math.max(TL_MIN, (time.clientHeight || V.tlH || TL_MIN) + room);
}

/** Push `V.tlH` into the layout. The viewer is measured off its own box by
 *  `fitViewer`, so it has to be re-fitted the moment this changes. */
function applyTlHeight() {
  const root = $("vfx"), time = $("vfxTime");
  if (!root || !time || root.hidden) return;
  const total = root.clientHeight || 0;
  /* Nothing has been laid out yet — the tab was unhidden this tick, or the
   * window is mid-restore. Come back rather than give up: this used to be a
   * bare return, and a first paint that measured zero left the time area at
   * whatever CSS said forever, which is exactly the eighty-pixel timeline this
   * whole change exists to remove. */
  if (!total) { clearTimeout(applyTlHeight._t); applyTlHeight._t = setTimeout(applyTlHeight, 60); return; }
  if (!V.tlH) {
    const saved = Number(localStorage.getItem(TL_KEY));
    V.tlH = Number.isFinite(saved) && saved > 0 ? saved : tlDefault(total);
  }
  V.tlH = clamp(V.tlH, TL_MIN, tlCap(time, $("vfxCheck")));
  time.style.height = `${V.tlH}px`;
  fitViewer();
}

function wireSplit() {
  const bar = $("vfxSplit");
  if (!bar) return;
  let from = 0, at = 0;
  const move = (e) => {
    /* Upwards is taller: the handle is ABOVE the timeline, so the delta is
     * subtracted rather than added, and getting that backwards is the one bug
     * a splitter always has. */
    V.tlH = at + (from - e.clientY);
    applyTlHeight();
    paintGraph();          // the plot is sized in pixels, not in percentages
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("vfxrowresize");
    try { localStorage.setItem(TL_KEY, String(Math.round(V.tlH))); } catch { /* private mode */ }
  };
  bar.addEventListener("pointerdown", (e) => {
    from = e.clientY; at = V.tlH || 0;
    document.body.classList.add("vfxrowresize");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  bar.addEventListener("dblclick", () => {
    V.tlH = tlDefault($("vfx")?.clientHeight || 0);
    applyTlHeight(); paintGraph();
    try { localStorage.setItem(TL_KEY, String(Math.round(V.tlH))); } catch { /* private mode */ }
  });
  /* BOTH, not one or the other. The observer catches a neighbouring panel
   * changing width; `resize` catches the window. A browser that has one has the
   * other, so the try is only about the observer's own absence. */
  window.addEventListener("resize", applyTlHeight);
  try { new ResizeObserver(() => applyTlHeight()).observe($("vfx")); } catch { /* older engine */ }
}

/* ──────────────────────────────────────────────────────────────── painting */

/**
 * The three screens this tab can be on, and it is always exactly one of them:
 * the engine is not there, there is no comp open, or there is. The skeleton
 * built by initVfx is never thrown away — a failure hides it and shows one
 * sentence, so recovering is a repaint rather than a reboot.
 */
function paint() {
  if (!$("vfx")) return;
  $("vfxDown").hidden = !V.down;
  $("vfxBody").hidden = V.down;
  $("vfxTime").hidden = V.down || !V.comp;
  $("vfxSplit").hidden = V.down || !V.comp;
  if (V.down) { $("vfxBar").innerHTML = `<h2 class="vfxtitle">VFX</h2>`; return; }
  paintBar();
  if (!V.comp) return paintEmpty();
  paintProps();
  paintTimeline();
  paintTransport();
  paintGraph();
  paintMotionPath();
  applyTlHeight();
  queueFrame();
}

/** No comps, or a comp that would not load. Both are ordinary places to be. */
function paintEmpty() {
  $("vfxTl").innerHTML = "";
  $("vfxTransport").innerHTML = "";
  $("vfxGraph").hidden = true;
  $("vfxMotionPath").toggleAttribute("hidden", true);
  $("vfxQual").hidden = true;
  $("vfxFrame").hidden = true;
  $("vfxFrame").removeAttribute("src");
  // The workspace furniture measures the frame; no frame, nothing to measure.
  $("vfxGuides").toggleAttribute("hidden", true);
  for (const id of ["vfxRulerTop", "vfxRulerLeft", "vfxRulerCorner"]) $(id).hidden = true;
  $("vfxViewNote").textContent = V.comps.length
    ? "That comp could not be read."
    : "No compositions yet.";
  $("vfxPropsBody").innerHTML = `<p class="hint">${V.comps.length
    ? "Pick another comp above."
    : "Press <b>new</b> in the bar above. A comp is a size, a frame rate and a length — layers go in afterwards."}</p>`;
  $("vfxPropsTitle").textContent = "Properties";
}

/* ── top bar ─────────────────────────────────────────────────────────────── */

function paintBar() {
  const c = V.comp;
  const opts = V.comps.length
    ? V.comps.map((x) => `<option value="${esc(x.slug)}"${x.slug === V.slug ? " selected" : ""}>${esc(x.name || x.slug)} · ${x.width}×${x.height} · ${x.layers ?? 0}L</option>`).join("")
    : `<option value="">No comps yet</option>`;

  const fields = c ? `
    <span class="vfxfields">
      <label class="vfxfield">w<input type="number" id="vfxW" value="${num(c.width, 1920)}" min="16" max="4096" step="2"></label>
      <label class="vfxfield">h<input type="number" id="vfxH" value="${num(c.height, 1080)}" min="16" max="4096" step="2"></label>
      <label class="vfxfield">fps<input type="number" id="vfxFps" value="${num(c.fps, 30)}" min="1" max="120" step="1"></label>
      <label class="vfxfield">sec<input type="number" id="vfxDur" value="${num(c.duration, 8)}" min="0.1" max="600" step="0.1"></label>
      <label class="vfxfield vfxmb" title="Motion blur is opt-in per layer; this is the master switch (§1)">
        <input type="checkbox" id="vfxMB"${c.motionBlur?.enabled ? " checked" : ""}>blur</label>
    </span>` : "";

  const render = c ? `
    <span class="vfxrender">
      <select class="sel2 sm" id="vfxFmt" title="mov keeps the alpha channel; png writes a numbered sequence">
        <option value="mp4">mp4</option><option value="mov">mov · alpha</option><option value="png">png seq</option>
      </select>
      <select class="sel2 sm" id="vfxScale" title="Render scale">
        <option value="1">100%</option><option value="0.5">50%</option><option value="0.25">25%</option>
      </select>
      <label class="edtool tog sm" title="Skip motion blur and the expensive effect paths"><input type="checkbox" id="vfxDraft">draft</label>
      <button class="btn sm" type="button" id="vfxRender"${V.job ? " disabled" : ""}>${V.job ? "Rendering…" : "Render"}</button>
      <button class="edtool sm" type="button" id="vfxQueue" title="The render queue — every render and prewarm job the server remembers, across all comps, with progress and output paths">≡ queue</button>
    </span>` : "";

  const bar = V.job ? `<div class="vfxjob">
      <div class="vfxjobbar"><i style="width:${Math.round((V.job.pct ?? 0) * 100)}%"></i></div>
      <span class="vfxjoblab">${esc(V.job.label)}</span>
    </div>` : "";

  /* Beside the comp picker rather than out at the end, because undo belongs to
   * the document — and because it is the most-pressed control in any editor,
   * which is a reason to put it where the hand already is. */
  const history = c ? `
    <span class="vfxhist">
      <button class="edtool sm" type="button" id="vfxUndo">↶ undo</button>
      <button class="edtool sm" type="button" id="vfxRedo">↷ redo</button>
    </span>` : "";

  $("vfxBar").innerHTML = `
    <h2 class="vfxtitle">VFX</h2>
    <select class="sel2" id="vfxPick">${opts}</select>
    <button class="edtool sm" type="button" id="vfxNew">new</button>
    <button class="edtool sm" type="button" id="vfxDup"${c ? "" : " disabled"}>duplicate</button>
    <button class="edtool sm warn" type="button" id="vfxDel"${c ? "" : " disabled"}>delete</button>
    ${history}${fields}${render}${bar}`;

  if (c) {
    $("vfxUndo").onclick = undo;
    $("vfxRedo").onclick = redo;
    paintHist();
  }

  $("vfxPick").onchange = async () => {
    V.slug = $("vfxPick").value || null;
    V.t = 0; V.inT = 0; V.outT = null; V.sel = null; V.msel.clear();
    /* A different comp is a different document, and twirl state is keyed on
     * layer ids that no longer exist there. `props` goes with it for the same
     * reason — a cached property list belongs to one layer of one comp. */
    V.open.clear(); V.gopen.clear(); V.fxOpen.clear(); V.itemOpen.clear();
    V.props.clear(); V.propsPending.clear();
    await loadComp();
    paint();
  };
  $("vfxNew").onclick = newComp;
  $("vfxDup").onclick = duplicateComp;
  $("vfxDel").onclick = deleteComp;
  if (c) {
    /* `change`, not `input` — a POST per keystroke while someone types 1920
     * would create a comp 1 pixel wide, then 19, then 192. */
    const setC = (id, key, cast = num) => {
      const el = $(id);
      if (el) el.onchange = () => mutate({ action: "set_comp", slug: V.slug, [key]: cast(el.value) },
        { reloadList: true, coalesce: `comp:${key}` });
    };
    setC("vfxW", "width"); setC("vfxH", "height");
    setC("vfxFps", "fps"); setC("vfxDur", "duration");
    $("vfxMB").onchange = () => mutate({
      action: "set_comp", slug: V.slug,
      motionBlur: { ...(c.motionBlur || {}), enabled: $("vfxMB").checked },
    });
    $("vfxRender").onclick = startRender;
    $("vfxQueue").onclick = queuePanel;
  }
}

/* ── the render queue panel ──────────────────────────────────────────────────
 *
 * A list, not a mechanism: the jobs live server-side in the same in-memory
 * store the render/prewarm actions already report through, read here via
 * GET /api/vfx/renders (the same rows vfx_render_status reads over MCP).
 * Refreshed while open; a restart clears the server's list and the panel
 * says so rather than showing an empty table with no explanation.
 */
async function queuePanel() {
  const paintRows = async () => {
    const el = document.getElementById("vfxQRows");
    if (!el) return false;                    // panel closed — stop refreshing
    let d;
    try { d = await getJson("/api/vfx/renders"); }
    catch { el.innerHTML = `<tr><td colspan="6" class="hint">The server did not answer.</td></tr>`; return true; }
    const jobs = d.jobs || [];
    el.innerHTML = jobs.length ? jobs.map((j) => {
      const pct = Math.round((j.progress ?? 0) * 100);
      const out = j.clip || (j.out ? j.out.split(/[\\/]/).pop() : "");
      const state = j.status === "running" ? `${pct}%` : j.status;
      return `<tr class="vfxq ${esc(j.status)}">
        <td>${esc(j.slug)}</td>
        <td>${esc(j.kind)}</td>
        <td title="${esc(j.error || "")}"><span class="vfxqbar"><i style="width:${pct}%"></i></span> ${esc(state)}</td>
        <td>${j.frames ?? (j.frame || "")}</td>
        <td>${esc(j.format || "")}</td>
        <td class="vfxqout" title="${esc(j.out || "")}">${esc(out || (j.error ? String(j.error).slice(0, 60) : ""))}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="6" class="hint">No jobs. Renders and prewarms appear here the moment they are queued —
      and only until the server restarts: the queue is in memory, so a job a restart interrupted did not finish.</td></tr>`;
    return true;
  };
  overlay(`
    <h3>Render queue</h3>
    <p class="hint">Every render and RAM-preview job this server remembers, newest first, across all comps.
      In memory only — a restart clears it.</p>
    <table class="vfxqtab">
      <thead><tr><th>comp</th><th>kind</th><th>status</th><th>frames</th><th>format</th><th>output</th></tr></thead>
      <tbody id="vfxQRows"></tbody>
    </table>`, () => {
    const tick = async () => { if (await paintRows()) setTimeout(tick, 2000); };
    tick();
  });
}

async function newComp() {
  const name = prompt("Name the composition", "Untitled comp");
  if (!name) return;
  try {
    const d = await api({ action: "create", name, width: 1920, height: 1080, fps: 30, duration: 8 });
    V.slug = d.comp?.slug || d.slug || null;
    V.sel = null; V.msel.clear(); V.t = 0; V.outT = null;
    await loadList();
    await loadComp();
    paint();
  } catch (e) { V.down = true; paint(); note(e.message); }
}

/**
 * §6 has `duplicate_layer` but no comp-level duplicate, and §8's bar asks for
 * one. So: ask for the action, and if the route does not know it, do the same
 * thing out of two actions it does define. Either way one comp comes back.
 */
async function duplicateComp() {
  if (!V.comp) return;
  const name = `${V.comp.name || V.slug} copy`;
  try {
    const d = await api({ action: "duplicate", slug: V.slug, name });
    V.slug = d.comp?.slug || d.slug || V.slug;
  } catch {
    try {
      const c = V.comp;
      const d = await api({
        action: "create", name,
        width: c.width, height: c.height, fps: c.fps, duration: c.duration,
      });
      const slug = d.comp?.slug || d.slug;
      if (slug) {
        await api({
          action: "set_comp", slug,
          layers: c.layers, bg: c.bg, markers: c.markers, motionBlur: c.motionBlur,
        });
        V.slug = slug;
      }
    } catch (e) { note(e.message || "Could not duplicate that comp."); }
  }
  await loadList(); await loadComp(); paint();
}

async function deleteComp() {
  if (!V.comp) return;
  if (!confirm(`Delete "${V.comp.name || V.slug}"? The comp document is removed from disk.`)) return;
  try { await api({ action: "delete", slug: V.slug }); } catch (e) { note(e.message); }
  V.slug = null; V.comp = null; V.sel = null; V.msel.clear();
  await loadList();
  if (V.comps.length) V.slug = V.comps[0].slug;
  await loadComp();
  paint();
}

/* ── render ──────────────────────────────────────────────────────────────── */

/**
 * Renders run through `art` so a song in flight keeps the GPU (§6), which means
 * this can queue behind music and take minutes. §6 defines no progress route,
 * so progress is READ FROM THE DOCUMENT: the comp's `runs` breadcrumb log (§1)
 * is where the server records what it did. If it carries a `progress` the bar
 * is real; if it does not, the bar stays indeterminate and says so rather than
 * animating a lie. Either way the finished clip lands in the clips library, and
 * that is the completion signal we can always see.
 */
async function startRender() {
  if (!V.comp || V.job) return;
  const before = new Set(V.clips.map((c) => c.name));
  V.job = { label: "queued — music keeps priority", pct: 0 };
  paintBar();
  try {
    const d = await api({
      action: "render", slug: V.slug,
      format: $("vfxFmt")?.value || "mp4",
      scale: num($("vfxScale")?.value, 1),
      draft: !!$("vfxDraft")?.checked,
      from: V.inT, to: V.outT ?? dur(),
    });
    /* NOT a completion test. The render action always queues and returns a
     * jobId — its own `note` says to poll — and the `out` it carries is the
     * path chosen at queue time, before a frame exists. Reading that as
     * "finished" cleared the bar and toasted a render that had not started.
     * The job id is what the poll needs; keep it and let pollRender decide. */
    V.job = { label: "queued — music keeps priority", pct: 0, id: d.jobId ?? null, polls: 0 };
    paintBar();
  } catch (e) {
    V.job = null; paintBar(); note(e.message || "The render was refused.");
    return;
  }
  clearInterval(V.jobTimer);
  V.job.polls = 0;
  V.jobTimer = setInterval(() => pollRender(before), 1500);
}

async function pollRender(before) {
  if (!V.job) { clearInterval(V.jobTimer); return; }
  /* Watching, not owning. If a quarter of an hour goes by with no breadcrumb and
   * no new clip, stop holding the Render button hostage and say what is true:
   * the job is the server's now, and it will land in the library when it lands. */
  if (++V.job.polls > 600) {
    V.job = null; clearInterval(V.jobTimer); paintBar();
    return note("Still rendering after 15 minutes — it will appear in the clips library when it finishes.");
  }
  try {
    const d = await getJson(`/api/vfx/comp/${encodeURIComponent(V.slug)}`);
    /* renders[], not runs[]. runs[] is the audit trail — what was done to this
     * comp — and carries no progress at all, so the percentage branch that read
     * it was dead and the bar could only ever show its indeterminate label. */
    const rows = d.renders || [];
    const job = (V.job?.id && rows.find((r) => r.id === V.job.id)) || rows[0];

    if (job && (job.status === "done" || job.finishedAt)) {
      V.job = null; clearInterval(V.jobTimer); paintBar();
      note(job.clip ? `Rendered ${job.frames ?? "?"} frames — ${job.clip}` : "Render finished.");
      loadLibraries();
      return;
    }
    if (job && job.error) {
      V.job = null; clearInterval(V.jobTimer); paintBar();
      note(String(job.error).slice(0, 160));
      return;
    }
    if (job && typeof job.progress === "number" && job.progress > 0 && job.progress < 1) {
      V.job = { ...V.job, label: `${Math.round(job.progress * 100)}%`, pct: job.progress };
      paintBar();
    } else if (!V.job.pct) {
      V.job = { label: "rendering — the engine reports when it lands", pct: 0 };
      paintBar();
    }
  } catch { /* one missed poll is not a failure */ }
  try {
    const clips = (await getJson("/api/clips")).clips || [];
    const fresh = clips.find((c) => !before.has(c.name));
    if (fresh) {
      V.clips = clips;
      V.job = null; clearInterval(V.jobTimer); paintBar();
      note(`Rendered — ${fresh.name} is in the clips library.`);
    }
  } catch { /* server busy */ }
}

/* ── properties ──────────────────────────────────────────────────────────── */

function paintProps() {
  const l = selected();
  $("vfxPropsTitle").textContent = l ? (l.name || l.id) : "Properties";
  const body = $("vfxPropsBody");
  if (!l) {
    body.innerHTML = `<p class="hint">Nothing selected. Click a layer on the left.</p>`;
    return;
  }
  body.innerHTML = [
    sourceSection(l),
    alignSection(l),
    layerSection(l),
    nestedSection(l),
    shapeSection(l),
    cameraSection(l),
    effectsSection(l),
    masksSection(l),
    matteSection(l),
    driveSection(),
  ].join("");
  wireProps();
}

function section(title, inner, extra = "") {
  return `<section class="vfxsec"><header class="vfxsechead"><h4>${esc(title)}</h4>${extra}</header>${inner}</section>`;
}

/** Timing and source: not animatable, so plain fields, but they belong here. */
function sourceSection(l) {
  const src = l.src ? `<div class="vfxrow static"><span class="vfxlab">Source</span>
      <span class="vfxvals"><code class="vfxsrc" title="Library name — the route resolves it to a path">${esc(l.src)}</code></span></div>` : "";
  const vid = l.type === "video" ? `
    <div class="vfxrow static"><span class="vfxlab">In point</span><span class="vfxvals">
      <input type="number" data-lset="inPoint" value="${num(l.inPoint, 0)}" step="0.1" title="Source time at the layer's start"></span></div>
    <div class="vfxrow static"><span class="vfxlab">Speed</span><span class="vfxvals">
      <input type="number" data-lset="timeScale" value="${num(l.timeScale, 1)}" step="0.1" title="2 = twice as fast; negative plays it backwards"></span></div>` : "";
  const txt = l.type === "text" ? `
    <div class="vfxrow static"><span class="vfxlab">Text</span><span class="vfxvals">
      <textarea data-tset="content" rows="2" spellcheck="false">${esc(l.text?.content || "")}</textarea></span></div>
    <div class="vfxrow static"><span class="vfxlab">Size</span><span class="vfxvals">
      <input type="number" data-tset="size" value="${num(l.text?.size, 96)}" step="1" min="1"></span></div>
    <div class="vfxrow static"><span class="vfxlab">Align</span><span class="vfxvals">
      <select class="sel2 sm" data-tset="align">${["left", "center", "right"].map((a) =>
        `<option value="${a}"${(l.text?.align || "center") === a ? " selected" : ""}>${a}</option>`).join("")}</select></span></div>` : "";
  const col = l.type === "solid" ? `<div class="vfxrow static"><span class="vfxlab">Colour</span>
      <span class="vfxvals">${rgbaBoxes("lcolor", l.color || [255, 255, 255, 255])}</span></div>` : "";
  return section("Layer", `${src}
    <div class="vfxrow static"><span class="vfxlab">In / out</span><span class="vfxvals">
      <input type="number" data-lset="start" value="${num(l.start, 0)}" step="0.1" title="When the layer appears, in comp seconds">
      <input type="number" data-lset="end" value="${num(l.end, dur())}" step="0.1" title="When it disappears">
    </span></div>
    ${vid}${txt}${col}
    <div class="vfxrow static"><span class="vfxlab">Motion blur</span><span class="vfxvals">
      <label class="edtool tog sm"><input type="checkbox" data-lset="motionBlur"${l.motionBlur ? " checked" : ""}>
        ${V.comp?.motionBlur?.enabled ? "on for this layer" : "on — but the comp switch is off"}</label></span></div>`);
}

/**
 * The Align strip. This panel has single selection, so the GUI aligns the
 * selected layer AGAINST THE COMP — centre it, pin it to an edge — through the
 * same align_layers action MCP uses, where multi-layer align and distribute
 * are fully available (vfx_align_layers takes any number of layer ids). The
 * server measures bounds with the engine's transforms, so a rotated or
 * parented layer aligns by where it actually sits.
 */
function alignSection(l) {
  const btn = (op, glyph, title) =>
    `<button class="edtool sm" type="button" data-align="${op}" title="${esc(title)}">${glyph}</button>`;
  return section("Align", `
    <div class="vfxrow static"><span class="vfxlab" title="Aligns this layer against the comp's edges, by its rendered bounds. Multi-layer align and distribute: vfx_align_layers over MCP.">To comp</span>
      <span class="vfxvals vfxalign">
        ${btn("left", "⇤", "Align the layer's left edge to the comp's left edge")}
        ${btn("centerH", "⇹", `Centre "${l.name || l.id}" horizontally`)}
        ${btn("right", "⇥", "Align the right edge to the comp's right edge")}
        ${btn("top", "⤒", "Align the top edge to the comp's top")}
        ${btn("centerV", "⇳", "Centre vertically")}
        ${btn("bottom", "⤓", "Align the bottom edge to the comp's bottom")}
      </span></div>`);
}

function rgbaBoxes(kind, v) {
  const a = Array.isArray(v) ? v : [255, 255, 255, 255];
  return `<span class="vfxrgba" data-rgba="${esc(kind)}">${
    ["r", "g", "b", "a"].map((ch, i) =>
      `<input type="number" min="0" max="255" step="1" data-ch="${i}" value="${num(a[i], 255)}" title="${ch}">`).join("")
    }<i class="vfxswatch" style="background:rgba(${num(a[0])},${num(a[1])},${num(a[2])},${num(a[3], 255) / 255})"></i></span>`;
}

/* ── shape layers ────────────────────────────────────────────────────────── */

const shapeSpec = (type) => V.shapeCat?.[type] || null;
const shapeItemType = (it) => String(it?.type || (it && it.items ? "group" : "")) || "";
const shapeRank = (it) => PHASE_RANK[shapeSpec(shapeItemType(it))?.group] ?? 0;
const shapeItems = (l) => (Array.isArray(l.shapes) ? l.shapes : []);

/** Pipeline order is simply "the ranks never go backwards" — nothing more. */
function firstOutOfOrder(items) {
  for (let i = 1; i < items.length; i++) if (shapeRank(items[i]) < shapeRank(items[i - 1])) return i;
  return -1;
}

/**
 * Where a new item belongs.
 *
 * Land it after the last item it may legally follow, which puts a path before
 * the operations, an operation between the paths and the paint, and paint on
 * the end. That is the whole defence: the ordinary way of building a shape —
 * add a shape, add a trim, add a stroke, in whatever sequence you think of them
 * — cannot produce a stack in the wrong order, so the warning below it is for
 * documents built elsewhere and for deliberate reordering, not for daily use.
 */
function insertionIndex(items, type) {
  const r = PHASE_RANK[shapeSpec(type)?.group] ?? 0;
  let i = items.length;
  while (i > 0 && shapeRank(items[i - 1]) > r) i--;
  return i;
}

function shapeSection(l) {
  if (l.type !== "shape") return "";
  const items = shapeItems(l);
  const add = `<button class="edtool sm" type="button" id="vfxAddShape">＋ item</button>`;
  if (!Object.keys(V.shapeCat || {}).length) {
    return section("Shape", `<p class="hint">The shape catalog did not load, so there is nothing to
      build the controls from. <code>/api/vfx/shapes</code> serves it.</p>`, add);
  }
  if (!items.length) {
    return section("Shape", `<p class="hint">This shape layer has no items. A shape is a small program:
      a <b>path</b> makes geometry, an <b>operation</b> rewrites it, and <b>paint</b> draws whatever the
      path set holds at that moment. Press <b>＋ item</b>.</p>`, add);
  }
  const bad = firstOutOfOrder(items);
  return section("Shape", `${pipelineStrip(items, bad)}
    ${items.map((it, i) => shapeItemHtml(l, it, i, items.length, bad)).join("")}
    <p class="hint">This is the pipeline — what the items are and what order they run in. Every
      parameter the engine animates is a row under <b>Shape</b> in the timeline, with a stopwatch,
      its value at the playhead and its keyframes: <code>set_prop</code> walks the item tree, so
      <code>shapes.2.end</code> and <code>shapes.1.items.0.size</code> both take keys.</p>`, add);
}

/**
 * The stack read as a sentence, above the stack itself.
 *
 * A list of rows shows what the items ARE; this shows what the ENGINE DOES with
 * them, which is the thing that goes wrong. When the phases run backwards it
 * names the exact pair and what will silently happen, because "trim is ignored"
 * is a fact about two specific rows, not a property of the layer.
 */
function pipelineStrip(items, bad) {
  const chips = items.map((it, i) => {
    const t = shapeItemType(it);
    const tag = PHASE_TAG[shapeSpec(t)?.group] || "path";
    return `<i class="vfxphase ${tag}${i === bad ? " bad" : ""}">${esc(shapeSpec(t)?.label || t)}</i>`;
  }).join(`<u>▸</u>`);
  if (bad < 0) {
    return `<div class="vfxpipe">${chips}<b class="ok">in order</b></div>`;
  }
  const before = shapeSpec(shapeItemType(items[bad - 1]));
  const after = shapeSpec(shapeItemType(items[bad]));
  return `<div class="vfxpipe out">${chips}</div>
    <p class="hint vfxwarnline"><b>${esc(before?.label || "")}</b> runs before <b>${esc(after?.label || "")}</b>,
      so it draws the path set as it stands and <b>${esc(after?.label || "")}</b> then has nothing left to
      change. It renders — it just silently does nothing.
      <button class="edtool sm" type="button" id="vfxShapeSort">put in order</button></p>`;
}

function shapeItemHtml(l, it, i, count, bad) {
  const type = shapeItemType(it);
  const spec = shapeSpec(type);
  const key = `${l.id}:${i}`;
  const open = V.itemOpen.has(key);
  const tag = PHASE_TAG[spec?.group] || "path";
  const params = spec?.params || {};
  const rows = Object.keys(params).length
    ? Object.entries(params).map(([name, ps]) => shapeParamRow(it, i, name, ps)).join("")
    : `<p class="hint">This item takes no parameters.</p>`;
  return `<div class="vfxfx vfxshape${open ? " open" : ""}${i === bad ? " outoforder" : ""}" data-si="${i}">
    <header class="vfxfxhead">
      <button class="vfxcaret" data-siopen="${i}" aria-expanded="${open}">${open ? "▾" : "▸"}</button>
      <i class="vfxphase ${tag}" title="${esc(spec?.group || "")}">${esc(tag)}</i>
      <label class="vfxfxon" title="Off skips this item; the ones after it still run">
        <input type="checkbox" data-sien="${i}"${it.enabled !== false ? " checked" : ""}></label>
      <b>${esc(spec?.label || type || "unknown")}</b>
      <span class="vfxfxgrp">${esc(it.name || "")}</span>
      <button class="sttog" data-siup="${i}"${i === 0 ? " disabled" : ""} title="Earlier — it runs sooner">▲</button>
      <button class="sttog" data-sidn="${i}"${i === count - 1 ? " disabled" : ""} title="Later — it runs after">▼</button>
      <button class="sttog warn" data-sidel="${i}" title="Remove this item">✕</button>
    </header>
    ${open ? `<div class="vfxfxbody">${spec?.why ? `<p class="hint">${esc(spec.why)}</p>` : ""}${rows}</div>` : ""}
  </div>`;
}

/**
 * A shape parameter — the ones that are NOT a value over time.
 *
 * The note that used to live here said `set_prop` resolved no path reaching
 * inside `shapes`, so an animatable shape parameter drew a dot instead of a
 * stopwatch. That is no longer true: `resolvePropPath` walks the item tree —
 * `shapes.2.end`, `shapes.1.items.0.size` — the enumerator reports every one,
 * and they are rows under Shape in the timeline with real stopwatches. So the
 * numeric ones are gone from here rather than drawn twice, and what stays is
 * the pipeline itself plus the parameters a keyframe has no reading for: a cap
 * style, a fill rule, a vertex list.
 */
function shapeParamRow(it, i, name, ps) {
  const value = it[name] === undefined ? ps.default : it[name];
  const label = ps.label || name;
  const type = ps.type || (Array.isArray(ps.default) ? "vec2" : typeof ps.default === "boolean" ? "bool" : "number");
  if (ps.animatable && ["number", "vec2", "color", "array"].includes(type)) return "";
  const range = ps.min != null && ps.max != null ? ` (${ps.min}–${ps.max})` : "";
  return `<div class="vfxrow static">
    <span class="vfxgutter"></span>
    <span class="vfxlab" title="${esc(`${ps.desc || ""}${range}`)}">${esc(label)}${ps.unit ? `<i>${esc(ps.unit)}</i>` : ""}</span>
    <span class="vfxvals">${shapeControl(i, name, ps, value, type)}</span>
  </div>`;
}

function shapeControl(i, name, ps, value, type) {
  const at = `data-siset="${i}" data-pname="${esc(name)}"`;
  switch (type) {
    case "enum":
      return `<select class="sel2 sm" ${at}>${(ps.options || []).map((o) =>
        `<option value="${esc(o)}"${String(value) === String(o) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    case "bool":
      return `<label class="edtool tog sm"><input type="checkbox" ${at}${value ? " checked" : ""}>${value ? "on" : "off"}</label>`;
    case "color": {
      /* Shape colours are RGB 0-255, the units shapes.py documents and the
       * comp document already stores — NOT the 0..1 triples a couple of the
       * seeded layers carry, which render as very nearly black. */
      const a = Array.isArray(value) ? value : [255, 255, 255];
      return `<span class="vfxrgba" data-sirgba="${i}" data-pname="${esc(name)}">${
        a.slice(0, 3).map((v, k) => `<input type="number" min="0" max="255" step="1" data-ch="${k}" value="${num(v, 255)}">`).join("")
      }<i class="vfxswatch" style="background:rgb(${num(a[0])},${num(a[1])},${num(a[2])})"></i></span>`;
    }
    case "vec2": {
      const a = Array.isArray(value) ? value : [0, 0];
      return [0, 1].map((k) => `<input type="number" ${at} data-ch="${k}" value="${num(a[k])}" step="1">`).join("");
    }
    case "number":
      return `<input type="number" ${at} value="${num(value, 0)}" step="${ps.step ?? 1}"
        ${ps.min != null ? `min="${ps.min}"` : ""} ${ps.max != null ? `max="${ps.max}"` : ""}>`;
    case "string":
      return `<input type="text" ${at} value="${esc(value ?? "")}" spellcheck="false">`;
    default:
      /* stops, vertex lists, a nested group's items — structures with no honest
       * small control. JSON round-trips exactly what the python wrote, which is
       * the one thing that cannot be wrong. */
      return `<input type="text" class="vfxjson" ${at} data-json="1" value="${esc(JSON.stringify(value ?? null))}"
        title="${esc(String(ps.type))} — edited as JSON">`;
  }
}

/* ── 3D, cameras and nested comps ────────────────────────────────────────── */

/**
 * What a layer IS, as opposed to what it is worth at a moment.
 *
 * Everything per-property-over-time — anchor, position, scale, rotation,
 * opacity, time remap, every effect and mask and shape parameter — is a row in
 * the timeline now, on the same line as its own keyframes. What is left here is
 * the layer itself: how it composites, what it hangs off, what cuts it out.
 *
 * The 3D switch stays because it changes what the transform rows MEAN rather
 * than being one of them: on a 3D layer anchor, position and scale each take a
 * third component, and the engine defaults a missing one (0 for anchor and
 * position, 100 for scale). rotationX/Y/Z compose Rx·Ry·Rz and are rows in the
 * tree the moment this is on — through `set_prop`, which stores them, unlike
 * the `set_layer` route the static boxes here used to write through and which
 * dropped them on every read.
 */
function layerSection(l) {
  const isCam = l.type === "camera";
  const three = !!l.threeD;
  const ls = layers();
  const toggle = isCam
    ? `<span class="vfxfxgrp">3D — a camera always is</span>`
    : `<label class="edtool tog sm" title="Give this layer a Z, so a camera moves it">
         <input type="checkbox" id="vfxThreeD"${three ? " checked" : ""}>3D</label>`;
  return section("Compositing", `
    <div class="vfxrow static"><span class="vfxgutter"></span>
      <span class="vfxlab" title="How this layer combines with everything under it">Blend</span>
      <span class="vfxvals"><select class="sel2 sm" data-blend="${esc(l.id)}">
        ${BLEND_MODES.map((b) => `<option value="${b}"${(l.blend || "normal") === b ? " selected" : ""}>${b}</option>`).join("")}
      </select></span></div>
    <div class="vfxrow static"><span class="vfxgutter"></span>
      <span class="vfxlab" title="This layer's transform is inherited from its parent's">Parent</span>
      <span class="vfxvals"><select class="sel2 sm" data-parent="${esc(l.id)}">
        <option value="">no parent</option>
        ${ls.filter((o) => o.id !== l.id).map((o) =>
          `<option value="${esc(o.id)}"${l.parent === o.id ? " selected" : ""}>${esc(o.name || o.id)}</option>`).join("")}
      </select></span></div>
    ${["camera", "light", "audio"].includes(l.type) ? "" : `
    <div class="vfxrow static"><span class="vfxgutter"></span>
      <span class="vfxlab" title="Along path turns the layer to face along its position track's motion; its own rotation composes on top as an offset">Auto-orient</span>
      <span class="vfxvals"><select class="sel2 sm" id="vfxAutoOrient">
        <option value="off"${(l.autoOrient || "off") === "off" ? " selected" : ""}>off</option>
        <option value="alongPath"${l.autoOrient === "alongPath" ? " selected" : ""}>along path</option>
      </select></span></div>`}
    ${three ? `<p class="hint">X, Y and Z rotation are rows under Transform in the timeline —
      ${esc(cameraNote())}</p>` : ""}
    <p class="hint">Anchor, position, scale, rotation and opacity are rows in the timeline: twirl
      <b>${esc(l.name || l.id)}</b> open.</p>`, toggle);
}

/** Which camera is actually looking, said plainly — it is the TOPMOST one. */
function cameraNote() {
  const cams = layers().filter((x) => x.type === "camera");
  if (!cams.length) return "No camera in this comp, so 3D layers are seen from straight on.";
  return cams.length === 1
    ? `Seen through "${cams[0].name || cams[0].id}".`
    : `Seen through "${cams[0].name || cams[0].id}" — the topmost of ${cams.length} cameras is the one used.`;
}

function cameraSection(l) {
  if (l.type !== "camera") return "";
  const c = l.camera || {};
  const i = indexOf(l.id);
  const above = layers().slice(0, i).some((x) => x.type === "camera");
  const row = (k, label, tip, extra = "") => `<div class="vfxrow static">
    <span class="vfxgutter"></span><span class="vfxlab" title="${esc(tip)}">${esc(label)}${extra}</span>
    <span class="vfxvals"><input type="number" data-cam="${k}" value="${num(c[k], 0)}" step="1"></span></div>`;
  return section("Camera", `
    ${row("zoom", "Zoom", "Distance from the film plane in pixels — larger is a longer lens.", "<i>px</i>")}
    <div class="vfxrow static"><span class="vfxgutter"></span>
      <span class="vfxlab" title="Off, everything is sharp whatever its Z">Depth of field</span>
      <span class="vfxvals"><label class="edtool tog sm"><input type="checkbox" data-cam="depthOfField"${c.depthOfField ? " checked" : ""}>${c.depthOfField ? "on" : "off"}</label></span></div>
    ${row("aperture", "Aperture", "Bigger blurs harder either side of the focus distance.")}
    ${row("focusDistance", "Focus at", "The distance that comes out sharp.", "<i>px</i>")}
    <p class="hint">${above
      ? "There is another camera above this one in the stack, and the topmost camera is the one a comp uses — so this one is not looking at anything. Move it up to use it."
      : "The topmost camera in the stack is the one the comp uses, and this is it. Only layers with 3D on respond to it."}</p>`);
}

/**
 * A comp inside a comp.
 *
 * The child's slug lives in the layer's `src`, the same field an image or a
 * video names its source with — which is the engine's shape and reads well:
 * this layer's source is that comp. (VFX_SPEC §1 calls it `compSlug`; the
 * engine does not know that name, so a document written to the spec renders a
 * blank layer. The engine is what makes pixels, so the engine wins here.)
 *
 * `collapse` is continuous rasterisation: build the child at the size this
 * layer will actually display it at, rather than rendering it at its own size
 * and scaling that up. It costs — measured at 1080p, a precomp scaled 250% went
 * from 181 ms to 1002 ms — and the engine ignores it in draft and on any layer
 * carrying effects, masks or a matte, which force a raster at comp size anyway.
 */
function nestedSection(l) {
  if (l.type !== "comp") return "";
  const others = V.comps.filter((c) => c.slug !== V.slug);
  const child = V.comps.find((c) => c.slug === l.src);
  const heavy = (l.effects || []).length || (l.masks || []).length || l.trackMatte;
  return section("Nested comp", `
    <div class="vfxrow static"><span class="vfxgutter"></span><span class="vfxlab">Composition</span>
      <span class="vfxvals"><select class="sel2 sm" id="vfxNested">
        <option value="">— none —</option>
        ${others.map((c) => `<option value="${esc(c.slug)}"${c.slug === l.src ? " selected" : ""}>${esc(c.name || c.slug)} · ${c.width}×${c.height}</option>`).join("")}
      </select></span></div>
    <div class="vfxrow static"><span class="vfxgutter"></span>
      <span class="vfxlab" title="Rasterise the child at the size it is displayed at, rather than at its own size">Collapse</span>
      <span class="vfxvals"><label class="edtool tog sm"><input type="checkbox" id="vfxCollapse"${l.collapse ? " checked" : ""}>${l.collapse ? "continuous" : "at its own size"}</label></span></div>
    ${l.collapse && heavy ? `<p class="hint vfxwarnline">This layer has an effect, a mask or a matte on it,
      and each of those forces a raster at comp size — so collapse is ignored here, exactly as it is
      in After Effects.</p>` : ""}
    ${child ? `<p class="hint">Nesting <b>${esc(child.name || child.slug)}</b> —
      ${child.width}×${child.height}, ${child.duration}s, ${child.layers ?? 0} layers.
      <button class="edtool sm" type="button" id="vfxOpenNested">open it</button></p>`
      : `<p class="hint">${others.length
        ? "This layer names no child comp, so it draws nothing. Pick one above."
        : "There is no other comp to nest. Make one first."}</p>`}`);
}

/* ── driving a property from sound or from motion ────────────────────────── */

function driveSection() {
  return section("Sound & motion", `<p class="hint">Turn a sound or a movement in a clip into
    keyframes on one of this layer's properties. Both analyse first and show you what they found —
    nothing is written until you say so.</p>
    <div class="vfxdrive">
      <button class="edtool sm" type="button" id="vfxAudioKeys">from sound…</button>
      <button class="edtool sm" type="button" id="vfxTrackMotion">from motion…</button>
    </div>`);
}

/**
 * The expression editor, as a SHEET rather than a strip inside one panel.
 *
 * It used to unfold under the row it belonged to, which worked while every
 * animatable property lived in one scrolling panel. Now they are rows in the
 * timeline — twenty pixels tall, in a region a person deliberately sized — and
 * a textarea that pushes six rows out of view is worse than a sheet. One
 * editor, opened from the ƒx on any row, wherever that row is.
 */
function exprSheet(layerId, path) {
  const l = layerOf(layerId);
  if (!l) return;
  const ex = exprOf(propAt(l, path));
  overlay(`<h3>Expression</h3>
    <p class="hint vfxexprpath"><code>${esc(path)}</code> on <b>${esc(l.name || l.id)}</b></p>
    <div class="vfxexpred">
      <textarea id="vfxExprText" rows="3" spellcheck="false" placeholder="wiggle(2, 30)">${esc(ex || "")}</textarea>
      <div class="vfxchips">${EXPR_VOCAB.map(([c, why]) =>
        `<button type="button" class="vfxchip" data-chip="${esc(c)}" title="${esc(why)}">${esc(c)}</button>`).join("")}</div>
      <p class="hint vfxwarnline">${esc(EXPR_STATE)}</p>
      <div class="vfxexprbtns">
        <button class="btn sm" type="button" id="vfxExprOk">apply</button>
        <button class="edtool sm" type="button" id="vfxExprCancel">cancel</button>
        ${ex ? `<button class="edtool sm warn" type="button" id="vfxExprOff">remove</button>` : ""}
        <span class="hint">Removing one leaves the value underneath exactly as it was.</span>
      </div>
    </div>`, (close) => wireExprSheet(l, path, ex, close));
}

/* ── effects ─────────────────────────────────────────────────────────────── */

/**
 * BUILT FROM THE CATALOG, NOT FROM A TABLE IN THIS FILE. Every control comes
 * from `/api/vfx/catalog`, so an effect added in `effects.py` gets a working
 * panel here the moment the server restarts — no UI change, no release. An
 * unknown param type falls through to a text box rather than disappearing,
 * because a control nobody planned for beats a param nobody can set.
 */
function effectsSection(l) {
  /* FXPRESETS: the shelf button lives beside "add effect" — a preset IS a way
   * of adding effects, and the sheet it opens reads the same server-side shelf
   * MCP's vfx_effect_presets does, so the two surfaces cannot drift. */
  const add = `<button class="edtool sm" type="button" id="vfxFxPresets"
      title="Save this layer's effect stack (and optionally its keyframed move) as a preset, or apply one">presets</button>
    <button class="edtool sm" type="button" id="vfxAddFx">＋ effect</button>`;
  const fx = l.effects || [];
  if (!fx.length) {
    return section("Effects", `<p class="hint">No effects on this layer.</p>`, add);
  }
  return section("Effects", fx.map((e, i) => {
    const spec = V.catalog?.[e.type];
    const open = V.fxOpen.has(e.id);
    const params = spec?.params || {};
    const rows = Object.keys(params).length
      ? Object.entries(params).map(([name, ps]) => fxParamRow(l, e, name, ps)).join("")
      : `<p class="hint">${spec ? "This effect takes no parameters." :
          `<b>${esc(e.type)}</b> is not in the catalog this tab loaded. Its stored parameters are kept untouched.`}</p>`;
    /* Everything the keyframe evaluator can read left this panel for the tree.
     * Saying where it went beats leaving somebody hunting for a radius among
     * three checkboxes — and on an effect whose parameters are ALL animatable
     * this line is the entire body. */
    const animN = Object.values(params).filter((ps) => ps.animatable).length;
    const moved = animN
      ? `<p class="hint">${animN} animatable parameter${animN === 1 ? "" : "s"} — ${animN === 1 ? "it is a row" : "they are rows"}
         under <b>Effects › ${esc(spec?.label || e.type)}</b> in the timeline, with ${animN === 1 ? "its" : "their"}
         stopwatch and keyframes.</p>`
      : "";
    return `<div class="vfxfx${open ? " open" : ""}" data-fx="${esc(e.id)}">
      <header class="vfxfxhead">
        <button class="vfxcaret" data-fxopen="${esc(e.id)}" aria-expanded="${open}">${open ? "▾" : "▸"}</button>
        <label class="vfxfxon" title="Bypass without losing the settings">
          <input type="checkbox" data-fxen="${esc(e.id)}"${e.enabled !== false ? " checked" : ""}></label>
        <b>${esc(spec?.label || e.type)}</b>
        <span class="vfxfxgrp">${esc(spec?.group || "")}</span>
        <button class="sttog" data-fxup="${esc(e.id)}"${i === 0 ? " disabled" : ""} title="Earlier in the stack">▲</button>
        <button class="sttog" data-fxdn="${esc(e.id)}"${i === fx.length - 1 ? " disabled" : ""} title="Later in the stack">▼</button>
        <button class="sttog warn" data-fxdel="${esc(e.id)}" title="Remove">✕</button>
      </header>
      ${open ? `<div class="vfxfxbody">${spec?.why ? `<p class="hint">${esc(spec.why)}</p>` : ""}${rows}${moved}</div>` : ""}
    </div>`;
  }).join(""), add);
}

function fxParamRow(l, e, name, ps) {
  const path = `effects.${e.id}.params.${name}`;
  const stored = e.params?.[name];
  const value = stored === undefined ? ps.default : stored;
  const label = ps.label || name;
  const type = ps.type || (Array.isArray(ps.default) ? "point" : typeof ps.default === "boolean" ? "bool" : "number");

  /* An animatable parameter is a ROW IN THE TIMELINE, on the same line as its
   * own keyframes — which is the whole point of the tree and the reason it is
   * not also drawn here. What is left in this panel is the effect AS A STACK
   * (order, bypass, remove) plus the switches and menus the keyframe evaluator
   * has no reading for: a mode, a flag, a layer name. */
  if (ps.animatable && (type === "number" || type === "point" || type === "vec2" || type === "color")) return "";

  const range = ps.min != null && ps.max != null ? ` (${ps.min}–${ps.max})` : "";
  return `<div class="vfxrow static" data-path="${esc(path)}">
    <span class="vfxlab" title="${esc((ps.why || "") + range)}">${esc(label)}</span>
    <span class="vfxvals">${fxControl(e.id, name, ps, value, type)}</span>
  </div>`;
}

function fxControl(fxId, name, ps, value, type) {
  const at = `data-fxset="${esc(fxId)}" data-pname="${esc(name)}"`;
  switch (type) {
    case "enum":
      return `<select class="sel2 sm" ${at}>${(ps.options || []).map((o) =>
        `<option value="${esc(o)}"${String(value) === String(o) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    case "bool": case "boolean":
      return `<label class="edtool tog sm"><input type="checkbox" ${at}${value ? " checked" : ""}>${value ? "on" : "off"}</label>`;
    case "color": case "rgba": {
      const a = Array.isArray(value) ? value : [255, 255, 255, 255];
      return `<span class="vfxrgba" data-fxrgba="${esc(fxId)}" data-pname="${esc(name)}">${
        a.slice(0, 4).map((v, i) => `<input type="number" min="0" max="255" step="1" data-ch="${i}" value="${num(v, 255)}">`).join("")
      }<i class="vfxswatch" style="background:rgba(${num(a[0])},${num(a[1])},${num(a[2])},${num(a[3], 255) / 255})"></i></span>`;
    }
    case "point": case "vec2": case "array": {
      const a = Array.isArray(value) ? value : [0, 0];
      return a.map((v, i) => `<input type="number" ${at} data-ch="${i}" value="${num(v)}" step="${ps.step ?? 1}">`).join("");
    }
    case "number":
      return `<input type="number" ${at} value="${num(value, 0)}" step="${ps.step ?? 0.1}"
        ${ps.min != null ? `min="${ps.min}"` : ""} ${ps.max != null ? `max="${ps.max}"` : ""}>`;
    case "string": case "text":
      return `<input type="text" ${at} value="${esc(value ?? "")}" spellcheck="false">`;
    default:
      /* An effect the catalog describes with a type this build has never heard
       * of. JSON in a box is ugly and it is also the only thing that cannot be
       * wrong — the value round-trips exactly as the python wrote it. */
      return `<input type="text" class="vfxjson" ${at} data-json="1" value="${esc(JSON.stringify(value ?? null))}"
        title="Unknown parameter type &quot;${esc(String(ps.type))}&quot; — edited as JSON">`;
  }
}

/* ── masks and matte ─────────────────────────────────────────────────────── */

function masksSection(l) {
  const add = `<button class="edtool sm" type="button" id="vfxAddMask">＋ mask</button>`;
  const ms = l.masks || [];
  if (!ms.length) {
    return section("Masks", `<p class="hint">No masks. A new one starts as a rectangle inset from
      the comp; feather, opacity and expand are rows under Masks in the timeline. Point editing on
      the viewer is not built yet.</p>`, add);
  }
  return section("Masks", ms.map((m) => `<div class="vfxmask" data-mask="${esc(m.id)}">
      <header class="vfxfxhead">
        <b>${esc(m.id)}</b>
        <select class="sel2 sm" data-maskmode="${esc(m.id)}" title="How this mask combines with the ones above it">
          ${["add", "subtract", "none"].map((x) => `<option value="${x}"${(m.mode || "add") === x ? " selected" : ""}>${x}</option>`).join("")}
        </select>
        <label class="edtool tog sm"><input type="checkbox" data-maskinv="${esc(m.id)}"${m.invert ? " checked" : ""}>invert</label>
        <span class="vfxfxgrp">${(m.points || []).length} points</span>
        <button class="sttog warn" data-maskdel="${esc(m.id)}" title="Remove">✕</button>
      </header>
    </div>`).join(""), add);
}

function matteSection(l) {
  const i = indexOf(l.id);
  const donor = layers()[i - 1];
  const body = donor
    ? `<div class="vfxrow static"><span class="vfxlab">Matte</span><span class="vfxvals">
        <select class="sel2 sm" id="vfxMatte">${MATTES.map(([v, lab]) =>
          `<option value="${v}"${(l.trackMatte?.type || "") === v ? " selected" : ""}>${esc(lab)}</option>`).join("")}
        </select></span></div>
      <p class="hint">Taken from <b>${esc(donor.name || donor.id)}</b> — the layer directly above,
        which is how After Effects decides it. Reorder the stack and the donor changes.</p>`
    : `<p class="hint">This layer is at the top of the stack, so there is nothing above it to
        cut it out with. Move it down and a matte becomes available.</p>`;
  return section("Track matte", body);
}

/* ── transport ───────────────────────────────────────────────────────────── */

/**
 * Preview quality, as a choice rather than a hardcoded 0.5.
 *
 * These are MEASURED on this engine, on the seeded comp, and they are printed
 * because the gap between them is the whole decision: full quality is a
 * slideshow, quarter is faster than real time. Which one is in force is written
 * over the picture the moment it is not full — a preview that silently renders
 * at half and calls itself the render is the defect this tab exists to avoid.
 */
const PREVIEW_SCALES = [
  ["1", "full", "every pixel the render makes — measured at 3.8 fps"],
  ["0.5", "half", "half scale — measured at 15 fps in draft"],
  ["0.25", "quarter", "quarter scale — measured at 55 fps in draft, faster than real time"],
];

/* The workspace views the frame route understands. The comp's own camera is
 * null; everything else renders through engine.view_camera and rides the
 * frame-cache key server-side, so switching views can never serve stale
 * pixels. Only 3D layers change between views — 2D holds its place, like AE. */
const VIEWS = [
  ["", "Active camera"], ["front", "Front"], ["top", "Top"], ["right", "Right"],
  ["left", "Left"], ["back", "Back"], ["bottom", "Bottom"], ["orbit", "Custom orbit"],
];

/** The current view as frame-URL query params. "" for the active camera. */
function viewQS() {
  const v = V.view;
  if (!v) return "";
  let q = `&view=${encodeURIComponent(v.name)}`;
  if (v.name === "orbit") q += `&yaw=${num(v.yaw, 30)}&pitch=${num(v.pitch, -25)}`;
  return q;
}

const viewKey = () => (V.view ? `${V.view.name}:${num(V.view.yaw, 30)}:${num(V.view.pitch, -25)}` : "");

/** The rolling rate the last few preview frames actually arrived at. Wall clock
 *  from request to decode, which is the number a person is watching. */
function previewFps() {
  if (V.fpsSeen.length < 2) return null;
  const mean = V.fpsSeen.reduce((a, b) => a + b, 0) / V.fpsSeen.length;
  return mean > 0 ? 1000 / mean : null;
}

function paintTransport() {
  const f = frameOf(V.t), total = frameOf(dur());
  const seen = previewFps();
  const p = V.preview;
  $("vfxTransport").innerHTML = `
    <button class="edtool" type="button" id="vfxPrev" title="One frame back (←)">◀|</button>
    <button class="btn sm" type="button" id="vfxPlay" title="Play — steps frames at ${fps()} fps as fast as the engine answers (space)">${V.playing ? "❚❚" : "▶"}</button>
    <button class="edtool" type="button" id="vfxNext" title="One frame on (→)">|▶</button>
    <span class="vfxtime">${fmtT(V.t)} <i>·</i> f${f}<span class="vfxof"> / ${fmtT(dur())} · ${total}f @ ${fps()}fps</span></span>
    <span class="vfxsp"></span>
    <label class="edtool sl sm" title="What a preview renders at while playing or scrubbing. Releasing the playhead settles back to full quality.">preview
      <select class="sel2 sm" id="vfxPvScale">${PREVIEW_SCALES.map(([v, lab, why]) =>
        `<option value="${v}"${String(p.scale) === v ? " selected" : ""} title="${esc(why)}">${lab}</option>`).join("")}</select></label>
    <label class="edtool tog sm" title="Skip motion blur and the expensive effect paths while previewing — the single biggest saving, and the one that changes the picture most">
      <input type="checkbox" id="vfxPvDraft"${p.draft ? " checked" : ""}>draft</label>
    <span class="vfxrate" title="${seen ? "Measured: wall clock from request to decoded frame, averaged over the last few." : "Play or scrub and this reports the rate the engine actually delivered."}">${
      seen ? `${seen.toFixed(1)} fps` : "— fps"}</span>
    <label class="edtool sl sm" title="Look at the scene from a workspace view instead of the comp's camera. Only 3D layers change — 2D layers hold their place in every view, as in AE. The render always uses the active camera.">3D view
      <select class="sel2 sm" id="vfxView">${VIEWS.map(([v, lab]) =>
        `<option value="${v}"${(V.view?.name || "") === v ? " selected" : ""}>${lab}</option>`).join("")}</select></label>
    ${V.view?.name === "orbit" ? `
      <label class="edtool sl sm" title="Orbit yaw — degrees around the vertical axis">y<input type="number" class="vfxorbit" id="vfxYaw" value="${num(V.view.yaw, 30)}" step="5"></label>
      <label class="edtool sl sm" title="Orbit pitch — negative looks from above">p<input type="number" class="vfxorbit" id="vfxPitch" value="${num(V.view.pitch, -25)}" step="5"></label>` : ""}
    <button class="edtool sm${V.gizmo ? " on" : ""}" type="button" id="vfxGizTog"
      title="The transform gizmo and wireframes — the selected layer's axes and outline, camera frustums, light cones. Drag the axes or the anchor to move the layer; the geometry comes from the engine's own projection.">⌖ gizmo</button>
    <button class="edtool sm${V.info ? " on" : ""}" type="button" id="vfxInfoTog"
      title="Info — the RGBA under the cursor, read off the server-rendered frame">ⓘ info</button>
    <button class="edtool sm${V.graph ? " on" : ""}" type="button" id="vfxGraphTog"
      title="The graph editor — keyframe values and the curve between them, with handles you can shape">◠ graph</button>
    <button class="edtool sm${V.motionPath ? " on" : ""}" type="button" id="vfxPathTog"
      title="Draw the selected layer's position track over the picture, with its spatial handles">⌒ path</button>
    <button class="edtool sm${V.ws.rulers ? " on" : ""}" type="button" id="vfxRulTog"
      title="Rulers along the viewer's top and left edges, in comp pixels. Drag one into the picture to drop a guide; double-click for an exact position. Rulers measure the COMP RASTER — the rendered image — which is view-independent, so they stay correct in orbit views too.">⊾ rulers</button>
    <button class="edtool sm${V.ws.guides ? " on" : ""}" type="button" id="vfxGuideTog"
      title="Show or hide the guides. The guides themselves live in the comp document — they survive reload and travel with the comp — and this switch is only whether YOU see them.">▤ guides</button>
    ${V.ws.guides ? `<button class="edtool sm${V.ws.lock ? " on" : ""}" type="button" id="vfxGuideLock"
      title="Lock the guides so a drag cannot move or delete them. New guides can still be pulled from the rulers, as in AE. Locked guides also stop catching the pointer, so nothing under one becomes unclickable.">⚿ ${V.ws.lock ? "locked" : "lock"}</button>` : ""}
    <button class="edtool sm${V.ws.grid ? " on" : ""}" type="button" id="vfxGridTog"
      title="A comp-space grid over the picture. Spacing and subdivisions appear beside this button while it is on. View furniture only — never rendered, never saved in the comp.">⊞ grid</button>
    ${V.ws.grid ? `
      <label class="edtool sl sm" title="Grid spacing, comp pixels">px<input type="number" class="vfxgridin" id="vfxGridSize" value="${num(V.ws.gridSize, 100)}" min="4" max="4096" step="10"></label>
      <label class="edtool sl sm" title="Subdivisions per grid square">÷<input type="number" class="vfxgridin" id="vfxGridDivs" value="${num(V.ws.gridDivs, 4)}" min="1" max="12" step="1"></label>` : ""}
    <button class="edtool sm${V.ws.safe ? " on" : ""}" type="button" id="vfxSafeTog"
      title="Title/action safe — the broadcast 90% action-safe and 80% title-safe rectangles plus the centre cross, drawn from the comp's own dimensions.">▣ safe</button>
    <button class="edtool sm${V.ws.snap ? " on" : ""}" type="button" id="vfxSnapTog"
      title="Snap a layer drag to guides, the grid, the comp centre and the comp edges, within about 6 screen pixels. Hold Ctrl while dragging to pass through without snapping.">⌁ snap</button>
    <button class="edtool sm" type="button" id="vfxIn" title="Set the work area start to the playhead">in ${fmtT(V.inT)}</button>
    <button class="edtool sm" type="button" id="vfxOut" title="Set the work area end to the playhead">out ${fmtT(V.outT ?? dur())}</button>`;

  $("vfxPlay").onclick = () => (V.playing ? stop() : play());
  $("vfxPrev").onclick = () => seek(V.t - 1 / fps());
  $("vfxNext").onclick = () => seek(V.t + 1 / fps());
  $("vfxIn").onclick = () => { V.inT = Math.min(V.t, V.outT ?? dur()); paintTransport(); paintTimeline(); };
  $("vfxOut").onclick = () => { V.outT = Math.max(V.t, V.inT); paintTransport(); paintTimeline(); };
  $("vfxPvScale").onchange = () => { V.preview.scale = num($("vfxPvScale").value, 0.5); V.fpsSeen.length = 0; paintTransport(); };
  $("vfxPvDraft").onchange = () => { V.preview.draft = $("vfxPvDraft").checked; V.fpsSeen.length = 0; paintTransport(); };
  $("vfxGraphTog").onclick = () => toggleGraph();
  $("vfxPathTog").onclick = () => { V.motionPath = !V.motionPath; paintTransport(); paintMotionPath(); };
  $("vfxView").onchange = () => {
    const name = $("vfxView").value;
    V.view = name ? { name, yaw: V.view?.yaw ?? 30, pitch: V.view?.pitch ?? -25 } : null;
    V.ovl = null;
    paintTransport(); queueFrame(); paintGizmo();
  };
  for (const [id, key] of [["vfxYaw", "yaw"], ["vfxPitch", "pitch"]]) {
    const el = $(id);
    if (el) el.onchange = () => {
      if (!V.view) return;
      V.view[key] = num(el.value, key === "yaw" ? 30 : -25);
      V.ovl = null;
      queueFrame(); paintGizmo();
    };
  }
  $("vfxGizTog").onclick = () => { V.gizmo = !V.gizmo; paintTransport(); paintGizmo(); };
  $("vfxInfoTog").onclick = () => {
    V.info = !V.info;
    $("vfxInfo").hidden = true;
    paintTransport();
  };
  /* The workspace toggles — all view state, so they write V.ws + localStorage
   * and never touch the document. Flipping rulers changes the gutter, so it
   * re-fits; everything else only re-lays the overlay. */
  const wsTog = (key, after) => () => { V.ws[key] = !V.ws[key]; saveWs(); paintTransport(); (after || paintGuides)(); };
  $("vfxRulTog").onclick = wsTog("rulers", fitViewer);
  $("vfxGuideTog").onclick = wsTog("guides");
  const guideLockBtn = $("vfxGuideLock");
  if (guideLockBtn) guideLockBtn.onclick = wsTog("lock");
  $("vfxGridTog").onclick = wsTog("grid");
  $("vfxSafeTog").onclick = wsTog("safe");
  $("vfxSnapTog").onclick = wsTog("snap", () => {});
  for (const [id, key, lo, hi] of [["vfxGridSize", "gridSize", 4, 4096], ["vfxGridDivs", "gridDivs", 1, 12]]) {
    const el = $(id);
    if (el) el.onchange = () => { V.ws[key] = clamp(num(el.value, V.ws[key]), lo, hi); saveWs(); paintGuides(); };
  }
}

function seek(t) {
  V.t = clamp(t, 0, dur());
  paintTransport();
  /* The value boxes read the property AT the playhead, so moving time changes
   * what they say — that is the whole reason a compositor's panels feel alive.
   * `paintPlayhead` restates them in place; the right-hand panel holds nothing
   * that depends on the time, which is why rebuilding it here (as this used to)
   * was thirty rebuilds a second of a panel that could not have changed. */
  paintPlayhead();
  queueFrame();
}

/**
 * "Best effort" is not a hedge, it is the design. A real player needs decoded
 * frames ahead of time; this asks a python engine for a PNG and gets it when it
 * gets it. So the next frame is requested only once the previous one has
 * ARRIVED, capped at the comp's frame duration. On a light comp that is real
 * time; on a heavy one it is a slow crawl that never queues up a backlog of
 * requests the server is still working through after you pressed stop.
 */
function play() {
  if (!V.comp) return;
  V.playing = true;
  V.fpsSeen.length = 0;
  paintTransport();
  const step = () => {
    if (!V.playing) return;
    const end = V.outT ?? dur();
    let next = V.t + 1 / fps();
    if (next > end + 1e-6) next = V.inT;
    V.t = clamp(next, 0, dur());
    paintTransport(); paintPlayhead();
    requestFrame(null, () => { V.playTimer = setTimeout(step, Math.max(0, 1000 / fps())); });
  };
  step();
}

function stop() {
  V.playing = false;
  clearTimeout(V.playTimer);
  paintTransport();
  queueFrame();   // settle at full scale
}

/* ── the viewer ──────────────────────────────────────────────────────────── */

/**
 * Debounced at 120 ms, half scale while the pointer is down, full scale once it
 * settles. The half-scale pass is the whole reason scrubbing is usable: §9 puts
 * a 0.5-scale preview under 400 ms and a full frame at seconds.
 */
function queueFrame() {
  clearTimeout(queueFrame._t);
  const moving = V.scrubbing || V.playing;
  queueFrame._t = setTimeout(() => requestFrame(moving ? null : { scale: 1, draft: false }), 120);
}

/**
 * `q` is the quality to render at, or null for "whatever the preview control
 * says". Splitting it that way is what lets one loop serve a scrub, a playback
 * and a settle without any of them guessing what the others meant.
 *
 * ⚠ WHERE A RAM PREVIEW PLUGS IN. Every frame this tab shows is fetched here,
 * one URL, one instant, and the loop below asks for the NEXT frame only once
 * this one has arrived. A prewarm route that caches a range changes nothing
 * about that shape — it makes these requests hit warm frames instead of cold
 * ones. If the range endpoint lands, `play()` calls it once at the top and this
 * function is untouched.
 */
function requestFrame(q, done) {
  const img = $("vfxFrame");
  if (!img || !V.comp) return;
  const { scale, draft } = q || V.preview;
  const url = `/api/vfx/frame/${encodeURIComponent(V.slug)}`
    + `?t=${V.t.toFixed(4)}&scale=${scale}&draft=${draft ? 1 : 0}${viewQS()}&r=${V.rev}`;
  paintQualityBadge(scale, draft);
  /* Decoded off-screen first, then swapped in. Assigning straight to the visible
   * <img> blanks it while the request is in flight, which makes a scrub flicker
   * black between every frame. */
  const probe = new Image();
  const t0 = performance.now();
  probe.onload = () => {
    /* Only the reduced-quality lane is timed. A full-quality settle is one
     * frame nobody is watching the rate of, and folding it into the average
     * would make the number say a preview is slower than it is. */
    if (scale < 1 || draft) {
      V.fpsSeen.push(performance.now() - t0);
      if (V.fpsSeen.length > 8) V.fpsSeen.shift();
    }
    img.src = url;
    img.hidden = false;
    $("vfxViewNote").textContent = "";
    fitViewer();
    paintMotionPath();
    paintGizmo();
    done?.();
  };
  probe.onerror = () => {
    img.hidden = true;
    $("vfxViewNote").textContent = "The engine did not return a frame for this time.";
    /* A failed frame answers JSON, and an <img> cannot read a body — so a real
     * reason ("that comp layer points at a comp which is not in this document's
     * comps library") arrived at the browser and was thrown away, leaving one
     * sentence that fits every possible cause and helps with none of them.
     * Fetch the same URL again and print what it actually said. The second
     * request costs nothing: the failure happened before any pixels. */
    fetch(url).then((r) => r.json()).then((d) => {
      if (d?.error && $("vfxViewNote")) $("vfxViewNote").textContent = d.error;
    }).catch(() => { /* the first message stands */ });
    done?.();
  };
  probe.src = url;
}

/**
 * How big the picture may be — measured, not left to CSS.
 *
 * The size is derived from the COMP, never from the PNG that came back: a scrub
 * renders at half scale, and letting the returned bitmap decide would shrink the
 * viewer on every drag and grow it again on every settle. `max-width` and
 * `max-height` with an aspect-ratio cannot do this either — they fit a landscape
 * comp and stretch a portrait one, which is the same trap `fitMonitor` in the
 * Studio tab exists to avoid.
 */
function fitViewer() {
  const box = $("vfxCheck"), img = $("vfxFrame");
  if (!box || !img || !V.comp) return;
  /* The rulers take an 18px strip off the top and the left (CSS padding on the
   * box), so the picture is fitted to what remains — getBoundingClientRect
   * reports the padded box, and fitting to it uncorrected let the frame slide
   * under the rulers. */
  box.classList.toggle("withrulers", !!V.ws.rulers);
  const b = box.getBoundingClientRect();
  const gutter = V.ws.rulers ? RULER_W : 0;
  const ar = (V.comp.width || 16) / (V.comp.height || 9);
  const w = Math.max(1, Math.floor(Math.min(b.width - gutter, (b.height - gutter) * ar)));
  img.style.width = `${w}px`;
  img.style.height = `${Math.max(1, Math.round(w / ar))}px`;
  // The motion path, the gizmo, the rulers and the guides are all drawn in
  // comp coordinates over this exact rectangle, so they have to be re-laid
  // the moment it changes.
  paintMotionPath();
  paintGizmo();
  paintWorkspace();
}

function wireViewer() {
  const well = $("vfxWell");
  if (!well) return;
  /* The well changes size when the window does AND when a panel beside it does,
   * so watch the box rather than the window. */
  try { new ResizeObserver(fitViewer).observe($("vfxCheck")); }
  catch { window.addEventListener("resize", fitViewer); }
  /* Scrub on the picture itself — every compositor lets you, and it is the one
   * place your eye already is. Horizontal position maps to the work area. */
  let scrub = false;
  const to = (e) => {
    // Across the PICTURE, not the well — the letterbox on either side is not time.
    const b = $("vfxFrame").getBoundingClientRect();
    const a = V.inT, z = V.outT ?? dur();
    seek(a + clamp((e.clientX - b.left) / (b.width || 1), 0, 1) * (z - a));
  };
  well.addEventListener("pointerdown", (e) => {
    if (!V.comp || !e.shiftKey) return;   // shift-drag, so a plain click is not a scrub
    scrub = true; V.scrubbing = true; well.setPointerCapture(e.pointerId); to(e);
  });
  well.addEventListener("pointermove", (e) => { if (scrub) to(e); });
  const end = () => { if (scrub) { scrub = false; V.scrubbing = false; queueFrame(); } };
  well.addEventListener("pointerup", end);
  well.addEventListener("pointercancel", end);
}

/* ── the timeline ────────────────────────────────────────────────────────────
 *
 * THE TIMELINE IS THE APPLICATION. That is the one structural thing After
 * Effects does that this tab did not: you twirl a layer open and its Anchor
 * Point / Position / Scale / Rotation / Opacity are ROWS, each carrying its own
 * stopwatch, its own value at the playhead, and its own keyframes on the same
 * line. One place. Measured against the real thing before this was written,
 * ours gave the timeline eighty pixels and two layer bars, and every piece of
 * motion work was a three-panel journey: pick the layer on the left, find the
 * property on the right, then squint at a strip along the bottom to see whether
 * a diamond appeared.
 *
 * So the left column of the timeline IS the layer stack now — the separate
 * Layers panel is gone rather than duplicated, because a layer listed in two
 * places is two places to click and two places to disagree. What stays in the
 * right-hand panel is everything that is NOT a value over time: what a layer
 * is, what its effect stack is, what the comp is.
 *
 * The rows come from `layer_properties`, never from a table here. See loadProps.
 */

/** Head and lane are laid out side by side and MUST agree to the pixel, so the
 *  height of a row is one number read by both rather than two CSS rules that
 *  drift the day someone adds a control. */
const ROW_H = { layer: 26, group: 19, sub: 19, prop: 21, wait: 19 };

/** Which groups open when a layer is first twirled. Transform, because it is
 *  the answer four times out of five and an empty twirl teaches nothing. */
const GROUP_OPEN_BY_DEFAULT = new Set(["Transform"]);

const gkey = (lid, group, sub) => `${lid}::${group}${sub ? `::${sub}` : ""}`;

/**
 * A property's place in the tree, derived from the contract rather than from a
 * second table: a row belongs under its effect, its mask or its shape item, and
 * the enumerator already says which by carrying `effectId` / `maskId`, or — for
 * shapes — by nesting the path.
 *
 * The label follows the same seam. "Glow · radius", "grp · Rectangle · size"
 * and "mk_dd72 · feather" all put the container first and the leaf last, so the
 * subgroup header takes everything before the final "·" and the row takes what
 * is after it. That is presentation, not re-derivation: the string is the
 * server's, it is only being split where the server already put a separator.
 */
function subOf(p) {
  if (p.effectId) return p.effectId;
  if (p.maskId) return p.maskId;
  if (p.group === "Shape") return String(p.path).slice(0, String(p.path).lastIndexOf("."));
  return null;
}
const leafLabel = (label) => {
  const i = String(label).lastIndexOf(" · ");
  return i < 0 ? String(label) : String(label).slice(i + 3);
};
const subLabel = (label) => {
  const i = String(label).lastIndexOf(" · ");
  return i < 0 ? String(label) : String(label).slice(0, i);
};

/**
 * Every row the timeline draws, in document order, layers and their properties
 * together — which is what makes the tree and the stack the same object rather
 * than two objects that have to be kept agreeing.
 */
function tlRows() {
  const out = [];
  for (const l of layers()) {
    /* Shy is a TIMELINE filter, nothing else: the layer still renders, still
     * counts, still answers over MCP. Exactly AE's switch. */
    if (l.shy && V.comp?.hideShy) continue;
    out.push({ kind: "layer", l });
    if (!V.open.has(l.id)) continue;
    const hit = propsOf(l.id);
    if (!hit) { out.push({ kind: "wait", l, why: null }); continue; }
    if (hit.why) { out.push({ kind: "wait", l, why: hit.why }); continue; }

    /* Group order is the ORDER THE SERVER ANSWERED IN, first appearance wins.
     * Sorting it here would be this file having an opinion about a list it
     * asked for, and the next group added to the enumerator would land in the
     * wrong place until somebody noticed. */
    const groups = [];
    const byGroup = new Map();
    for (const p of hit.rows) {
      if (!byGroup.has(p.group)) { byGroup.set(p.group, []); groups.push(p.group); }
      byGroup.get(p.group).push(p);
    }
    for (const g of groups) {
      const rows = byGroup.get(g);
      const gk = gkey(l.id, g);
      out.push({ kind: "group", l, group: g, key: gk, count: rows.length });
      if (!V.gopen.has(gk)) continue;
      let lastSub = null;
      for (const p of rows) {
        const sub = subOf(p);
        if (sub !== lastSub) {
          lastSub = sub;
          if (sub) {
            const sk = gkey(l.id, g, sub);
            out.push({ kind: "sub", l, group: g, key: sk, label: subLabel(p.label), sub });
          }
        }
        if (sub && !V.gopen.has(gkey(l.id, g, sub))) continue;
        out.push({ kind: "prop", l, p, depth: sub ? 3 : 2, label: sub ? leafLabel(p.label) : p.label });
      }
    }
  }
  return out;
}

/**
 * How many boxes a property gets.
 *
 * `arity` null means the server will take either — a 3D vector — so the
 * document decides. On a 3D layer the third box is OFFERED even when the stored
 * value is two long, because that is the only way to type a Z in; the number it
 * starts at is what the engine defaults a missing component to, and the two
 * answers differ (0 for anchor and position, 100 for scale), so a Z box showing
 * 0 for a scale would say the layer had been flattened when it had not.
 */
const XFORM_Z = Object.fromEntries(XFORM.map(([path, , , opt]) => [path, opt.z]));

function arityFor(l, p, val) {
  if (p.arity) return p.arity;
  if (l.threeD && XFORM_Z[p.path] !== undefined) return 3;
  if (Array.isArray(val)) return val.length;
  if (Array.isArray(p.value)) return p.value.length;
  if (Array.isArray(p.fallback)) return p.fallback.length;
  return 1;
}

/** What a row shows: the live document at the playhead, falling back to the
 *  enumerator's value at t=0, falling back to the registry default. A row that
 *  reads 0 while the picture renders 10 is worse than no row at all. */
function rowValue(l, p) {
  const prop = propAt(l, p.path);
  if (prop !== undefined) return evalProp(prop, V.t);
  if (p.value !== null && p.value !== undefined) return p.value;
  return p.fallback ?? 0;
}

function valueBoxes(l, p) {
  const val = rowValue(l, p);
  const n = arityFor(l, p, val);
  /* An array of unknown length — a dash pattern, a vertex list. Boxes would
   * have to guess how many, and guessing wrong silently drops elements, so it
   * is one field holding the numbers it actually has. */
  if (p.kind === "array") {
    return `<input type="text" class="vfxtvarr" data-tvarr="${esc(p.path)}" spellcheck="false"
      value="${esc(Array.isArray(val) ? val.join(", ") : String(val ?? ""))}"
      title="A list of numbers, comma separated — set_prop refuses an empty one.">`;
  }
  const lo = p.range ? p.range[0] : null, hi = p.range ? p.range[1] : null;
  return Array.from({ length: n }, (_, i) => {
    const miss = i === 2 ? (XFORM_Z[p.path] ?? 0) : 0;
    const v = n > 1 ? num(Array.isArray(val) ? val[i] : miss, miss) : num(val);
    return `<input type="number" data-tv="${esc(p.path)}" data-i="${i}"
      value="${Math.round(v * 1000) / 1000}" step="${p.kind === "color" ? 1 : 0.5}"
      ${lo != null ? `min="${lo}"` : ""} ${hi != null ? `max="${hi}"` : ""}>`;
  }).join("");
}

const caret = (open, title) =>
  `<span class="vfxcaret" title="${esc(title)}">${open ? "▾" : "▸"}</span>`;

/* AE's sixteen label colours plus none. The NAME is what the document stores
 * (store.js LABEL_COLORS — the server refuses anything else); the hex is this
 * UI's rendering of it. Purely organisational: the engine never reads labels. */
const LABEL_HEX = {
  none: "transparent", red: "#b53838", yellow: "#d9c53a", aqua: "#29a6b8",
  pink: "#e57fb1", lavender: "#9d7fd4", peach: "#e0a878", seafoam: "#7fceaf",
  blue: "#3f6fd4", green: "#4faf4f", purple: "#7f52c4", orange: "#e08c3c",
  brown: "#8c6a4f", fuchsia: "#c94fc9", cyan: "#4fc4e0", sandstone: "#c4b08c",
  darkgreen: "#3c6b3c",
};

/** The label swatch menu — pick a colour, written through set_layer. */
function labelMenu(e, lid) {
  const l = layerOf(lid);
  if (!l) return;
  const menu = document.createElement("div");
  menu.className = "vfxmenu vfxlblmenu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.innerHTML = `<b>Label colour</b><div class="vfxlblgrid">${Object.entries(LABEL_HEX).map(([name, hex]) =>
    `<button type="button" data-lbl="${name}" class="vfxlblopt${(l.label || "none") === name ? " on" : ""}"
       style="background:${hex}" title="${name}">${name === "none" ? "∅" : ""}</button>`).join("")}</div>`;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", close, true); };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  menu.onclick = (ev) => {
    const b = ev.target.closest("[data-lbl]");
    if (!b) return;
    close();
    mutate({ action: "set_layer", slug: V.slug, layerId: lid, label: b.dataset.lbl },
      { label: `label ${b.dataset.lbl}` });
  };
}

/**
 * A layer's row in the head column — the whole layer stack, in the timeline.
 *
 * The class stays `vfxlayer` because reordering, renaming, the three switches
 * and delete are all delegated off it and off `.vfxlayer`'s drag events; moving
 * the markup without moving the wiring is the cheap half of this change.
 */
function layerHeadHtml(l, solo) {
  const dimmed = !l.enabled || (solo && !l.solo);
  const open = V.open.has(l.id);
  return `<div class="vfxtlhead vfxlayer${l.id === V.sel ? " sel" : ""}${V.msel.has(l.id) ? " msel" : ""}${dimmed ? " off" : ""}"
       style="height:${ROW_H.layer}px" data-lid="${esc(l.id)}" draggable="true">
    <button class="vfxcaret" data-expand="${esc(l.id)}"
      title="${open ? "Hide this layer's properties" : "Show every property this layer can animate"}">${open ? "▾" : "▸"}</button>
    <button class="vfxlblsw${(l.label || "none") === "none" ? " empty" : ""}" data-labelpick="${esc(l.id)}"
      style="--lbl:${LABEL_HEX[l.label] || "transparent"}"
      title="Label colour${l.label && l.label !== "none" ? `: ${esc(l.label)}` : ""} — organisation only, never rendered"></button>
    <button class="sttog${l.enabled ? " on" : ""}" data-tog="enabled" data-lid="${esc(l.id)}" title="Visible">👁</button>
    <button class="sttog solo${l.solo ? " on solo" : ""}" data-tog="solo" data-lid="${esc(l.id)}" title="Solo — hides every layer that is not soloed">S</button>
    <button class="sttog${l.locked ? " on" : ""}" data-tog="locked" data-lid="${esc(l.id)}" title="Locked — no edits, no selection changes">🔒</button>
    <button class="sttog shy${l.shy ? " on" : ""}" data-tog="shy" data-lid="${esc(l.id)}"
      title="Shy — hidden from the timeline while the comp's hide-shy switch (top corner) is on. Still renders.">🙈</button>
    <span class="vfxglyph" title="${esc(l.type)}">${GLYPH[l.type] || "?"}</span>
    <span class="vfxlname" data-rename="${esc(l.id)}" title="Double-click to rename">${esc(l.name || l.id)}</span>
    ${l.parent ? `<i class="vfxptag" title="Parented to &quot;${esc(layerOf(l.parent)?.name || l.parent)}&quot;">⇱</i>` : ""}
    ${l.trackMatte?.type ? `<i class="vfxptag" title="Track matte: ${esc(l.trackMatte.type)}">◧</i>` : ""}
    <button class="sttog warn" data-dellayer="${esc(l.id)}" title="Remove this layer">✕</button>
  </div>`;
}

function groupHeadHtml(r) {
  const open = V.gopen.has(r.key);
  return `<div class="vfxtlhead grp" style="height:${ROW_H.group}px" data-gtwirl="${esc(r.key)}">
    ${caret(open, open ? "Collapse" : "Expand")}
    <span class="vfxlabel">${esc(r.group)}</span>
    <span class="vfxgcount">${r.count}</span>
  </div>`;
}

function subHeadHtml(r) {
  const open = V.gopen.has(r.key);
  /* Two Glows on one layer are two subgroups reading "Glow", and which is which
   * decides which one you are keyframing. The id is what the document, the
   * effect stack in the panel and every MCP call all name it by, so it is what
   * is shown — quietly, because it is a disambiguator and not a title. */
  const tag = r.group === "Effects" ? r.sub : "";
  return `<div class="vfxtlhead sub" style="height:${ROW_H.sub}px" data-gtwirl="${esc(r.key)}">
    ${caret(open, open ? "Collapse" : "Expand")}
    <span class="vfxlabel">${esc(r.label)}</span>
    ${tag ? `<span class="vfxgcount">${esc(tag)}</span>` : ""}
  </div>`;
}

/**
 * A property, as a row: stopwatch, expression toggle, the value at the playhead
 * and — on the lane beside it — its keyframes.
 *
 * The stopwatch is NOT a UI flag. It is read straight off the document: a
 * property that is a `{keys:[…]}` object is animated and one that is a bare
 * number or array is not. An agent that adds a key over MCP lights it here
 * without this file knowing anything about it, and there is no third state to
 * get out of sync.
 */
function propHeadHtml(r) {
  const { l, p } = r;
  const prop = propAt(l, p.path);
  const anim = isAnim(prop);
  const ex = exprOf(prop) || p.expr;
  const at = anim && keysOf(prop).some((k) => Math.abs(k.t - V.t) < 1e-4);
  const graphed = V.graph?.layerId === l.id && V.graph?.path === p.path;
  const id = `${l.id}|${p.path}`;
  return `<div class="vfxtlhead prop${anim ? " anim" : ""}${ex ? " expr" : ""}${graphed ? " graphed" : ""}"
       style="height:${ROW_H.prop}px;padding-left:${8 + r.depth * 11}px" data-prop="${esc(id)}" title="${esc(p.path)}">
    <button class="vfxwatch${anim ? " on" : ""}" data-watch="${esc(id)}"
      title="${anim
        ? "Animated — changing a value writes a keyframe at the playhead. Click to freeze it at what it is worth here."
        : "Constant. Click to animate: a keyframe is written at the playhead and every later change adds another."}">⏱</button>
    <button class="vfxfxbtn${ex ? " on" : ""}" data-exprbtn="${esc(id)}"
      title="${ex ? `ƒ ${esc(ex)} — click to edit or remove it` : "Add an expression — it runs every frame, on top of whatever this property already is"}">ƒx</button>
    <span class="vfxlabel">${esc(r.label)}</span>
    <span class="vfxtvals">${valueBoxes(l, p)}</span>
    <button class="vfxkeyat${at ? " on" : ""}${anim ? "" : " off"}" data-keyat="${esc(id)}"
      title="${!anim ? "Not animated yet — the stopwatch to the left starts it"
        : at ? "There is a keyframe here — click to remove it" : "No keyframe at the playhead — click to add one"}">◆</button>
    <button class="vfxgopen${anim ? "" : " off"}" data-gopen="${esc(id)}"
      title="${anim ? "Shape this property's curve in the graph editor, without leaving the row it is on"
        : "Nothing to shape yet — a curve needs keyframes"}">◠</button>
  </div>`;
}

function paintTimeline() {
  /* [precomp-multisel] the multi-selection must never name a layer the
   * document no longer has (undo, remove, precompose itself). Pruned here
   * because every mutation ends in a repaint, so this is the one funnel. */
  if (V.msel.size) {
    const have = new Set(layers().map((l) => l.id));
    for (const id of [...V.msel]) if (!have.has(id)) V.msel.delete(id);
    if (V.msel.size === 1) { V.sel = [...V.msel][0]; V.msel.clear(); }
  }
  const rows = tlRows();
  const solo = soloing();
  const width = Math.max(240, dur() * V.pps + 40);
  const ls = layers();
  $("vfxTl").innerHTML = `
    <div class="vfxtlbody">
      <div class="vfxtlheads">
        <div class="vfxtlcorner">
          <button class="edtool sm" type="button" id="vfxAddLayer" title="Add a layer to the top of the stack">＋ layer</button>
          <span>${ls.length ? `${ls.length}L` : ""}</span>
          <button class="edtool sm${V.comp?.hideShy ? " on" : ""}" type="button" id="vfxHideShy"
            title="${V.comp?.hideShy
              ? `Showing everything again — ${ls.filter((x) => x.shy).length} layer(s) are marked shy`
              : "Hide the shy layers from the timeline (they still render). Mark a layer shy with its 🙈 switch."}">🙈${
              V.comp?.hideShy && ls.some((x) => x.shy) ? ` ${ls.filter((x) => x.shy).length}` : ""}</button>
          <label class="vfxzoom" title="Timeline zoom — how many pixels a second is worth">
            <input type="range" id="vfxZoom" min="20" max="400" step="10" value="${V.pps}"></label>
        </div>
        ${rows.map((r) => headHtml(r, solo)).join("")}
        ${ls.length ? "" : `<div class="vfxtlempty"><p class="hint">No layers. Press <b>＋ layer</b> — an image
          or a video comes from the library, a solid or a text layer is made here, an adjustment layer
          applies its effects to everything beneath it, and a null exists only to be a parent.</p></div>`}
      </div>
      <div class="vfxtlscroll" id="vfxTlScroll">
        <div class="vfxtlinner" style="width:${width}px">
          <div class="vfxruler" id="vfxRuler">${rulerTicks()}</div>
          <div class="vfxlanes" id="vfxLanes">${rows.map(laneFor).join("")}</div>
          <div class="vfxwork" style="left:${V.inT * V.pps}px;width:${Math.max(0, ((V.outT ?? dur()) - V.inT)) * V.pps}px"></div>
          <div class="vfxhead2" id="vfxPlayhead" style="left:${V.t * V.pps}px"></div>
        </div>
      </div>
    </div>`;
  /* The zoom is the timeline's own control and now sits on it, so it is wired
   * here rather than in the transport. `input`, not `change`: a zoom you cannot
   * see until you let go is a zoom you overshoot. */
  $("vfxZoom").oninput = () => { V.pps = num($("vfxZoom").value, 90); paintTimeline(); paintGraph(); };
  $("vfxHideShy").onclick = () => mutate(
    { action: "set_comp", slug: V.slug, hideShy: !V.comp?.hideShy },
    { label: V.comp?.hideShy ? "show shy layers" : "hide shy layers" });
  /* After the innerHTML lands: the wave canvases exist now and are blank.
   * Cached sources draw synchronously — a bar drag repaints its wave in the
   * same frame — and cold ones fetch, then draw. */
  paintWaves();
}

function headHtml(r, solo) {
  if (r.kind === "layer") return layerHeadHtml(r.l, solo);
  if (r.kind === "group") return groupHeadHtml(r);
  if (r.kind === "sub") return subHeadHtml(r);
  if (r.kind === "prop") return propHeadHtml(r);
  return `<div class="vfxtlhead wait" style="height:${ROW_H.wait}px">
    <span class="vfxlabel">${r.why ? esc(r.why) : "reading this layer's properties…"}</span></div>`;
}

function laneFor(r) {
  if (r.kind === "layer") return laneHtml(r.l);
  if (r.kind === "prop") return propLaneHtml(r.l, r.p.path);
  /* A group's lane is empty on purpose. AE draws a summary of the keyframes
   * underneath a collapsed twirl; a summary you cannot drag is a picture of
   * keyframes rather than keyframes, and the row exists to be opened. */
  return `<div class="vfxlane none" style="height:${ROW_H[r.kind]}px"></div>`;
}

function rulerTicks() {
  /* One label per second up to 20 s, then every 2, 5, 10 — the same rule the
   * Studio ruler uses, so the two read alike at the same zoom. */
  const d = dur();
  const step = V.pps > 120 ? 0.5 : V.pps > 60 ? 1 : V.pps > 30 ? 2 : 5;
  const out = [];
  for (let t = 0; t <= d + 1e-6; t += step) {
    const maj = Math.abs(t % (step * 2)) < 1e-6;
    out.push(`<div class="vfxtick${maj ? " maj" : ""}" style="left:${t * V.pps}px">${maj ? `<b>${t.toFixed(step < 1 ? 1 : 0)}s</b>` : ""}</div>`);
  }
  for (const m of V.comp?.markers || []) {
    out.push(`<div class="vfxmarker" style="left:${num(m.t) * V.pps}px" title="${esc(m.label || "")}"></div>`);
  }
  return out.join("");
}

function laneHtml(l) {
  const a = num(l.start, 0), b = num(l.end, dur());
  const lbl = l.label && l.label !== "none" ? `;box-shadow:inset 3px 0 0 ${LABEL_HEX[l.label] || "transparent"}` : "";
  /* The waveform rides IN the bar, so everything that moves the bar moves the
   * wave for free; paintWaves() fills it in after the innerHTML lands. Muted
   * (`audio:false`) keeps the wave but dims it — the sound is still there to
   * un-mute, and AE greys the wave rather than hiding it. The backing store is
   * capped: past ~3000 px the canvas CSS-stretches, and the x→time map in
   * drawWaveBar uses cv.width so alignment survives the stretch. */
  const wave = waveWorthy(l)
    ? `<canvas class="vfxwave${l.audio === false ? " mut" : ""}" data-wave="${esc(l.id)}"
         width="${Math.min(3000, Math.max(4, Math.round((b - a) * V.pps)))}" height="20"></canvas>`
    : "";
  return `<div class="vfxlane" style="height:${ROW_H.layer}px" data-lane="${esc(l.id)}">
    <div class="vfxbar2${l.id === V.sel ? " sel" : ""}${V.msel.has(l.id) ? " msel" : ""}${l.enabled ? "" : " off"}${l.locked ? " locked" : ""}"
         data-bar="${esc(l.id)}" style="left:${a * V.pps}px;width:${Math.max(4, (b - a) * V.pps)}px${lbl}">
      ${wave}<i class="vfxgrip l" data-trim="${esc(l.id)}" data-edge="l"></i>
      <span class="vfxbarname">${esc(l.name || l.id)}</span>
      <i class="vfxgrip r" data-trim="${esc(l.id)}" data-edge="r"></i>
    </div>
  </div>`;
}

function propLaneHtml(l, path) {
  const prop = propAt(l, path);
  const ks = keysOf(prop);
  const expr = exprOf(prop);
  const graphed = V.graph?.layerId === l.id && V.graph?.path === path;
  return `<div class="vfxlane prop${expr ? " expr" : ""}${graphed ? " graphed" : ""}"
       style="height:${ROW_H.prop}px" data-lane="${esc(l.id)}" data-proplane="${esc(l.id)}|${esc(path)}"
       ${expr ? `title="Driven by ${esc(expr)} — an expression has no keyframes to draw"` : ""}>
    ${ks.map((k, i) => `<i class="vfxkey${Math.abs(k.t - V.t) < 1e-4 ? " at" : ""}${k.ease === "hold" ? " hold" : ""}${
        V.ksel.has(keyId(l.id, path, k.t)) ? " sel" : ""}${k.roving ? " roving" : ""}${(k.to || k.ti) ? " spatial" : ""}"
        data-key="${esc(l.id)}" data-kpath="${esc(path)}" data-ki="${i}"
        style="left:${num(k.t) * V.pps}px"
        title="${fmtT(num(k.t))} · ${esc(typeof k.ease === "object" ? "bezier" : (k.ease || "linear"))}${
          k.roving ? " · roving" : ""}${(k.to || k.ti) ? " · spatial handle" : ""} — drag to retime, click to select, double-click to delete, right-click for easing"></i>`).join("")}
  </div>`;
}

/* ─────────────────────────────────────────── waveforms under the layer bars
 *
 * The same approach as studio.js's drawWave, deliberately: the SERVER decodes
 * (PyAV through the engine's own audio path — Chrome's decodeAudioData is the
 * reason peaks.py exists) and the client draws min/max columns, mapping each
 * pixel through the clip's timing into the source. What differs here is the
 * timing rule: a VFX layer maps comp time to source time exactly as the mix
 * does — source = inPoint + (t − start) × timeScale — so trims, stretches and
 * reversed layers show the slice they will actually sound like.
 *
 * Peaks are cached per source+resolution and NEVER per comp: the server keys
 * its sidecar on (file, mtime, bins), so a comp edit re-DRAWS but never
 * re-decodes. Zoom picks a power-of-two bin count (one pair ≈ one pixel of
 * source at the current pps), so a zoom drag settles onto a handful of
 * resolutions instead of one per pixel value, and each is fetched once.
 */
const wavePeaks = new Map();     // "src|bins" -> {peaks, seconds, bins}
const waveBest = new Map();      // src -> the sharpest data yet, for draw-now
const waveDead = new Set();      // sources that refused — no audio stream; never re-ask
const waveBusy = new Set();      // "src|bins" fetches in flight or settling

/** Audio layers always; video layers only when the probe advisory saw a track.
 *  A comp layer's sound is a mix, not a source — no wave, same as the route. */
const waveWorthy = (l) =>
  l.type === "audio" || (l.type === "video" && l.srcHasAudio === true);

function waveBins(l) {
  const ts = Math.abs(num(l.timeScale, 1) || 1);
  const secs = num(l.srcDuration, 0) || waveBest.get(l.src)?.seconds || dur();
  const want = Math.ceil((secs * V.pps) / ts);
  let bins = 64;
  while (bins < want && bins < 4096) bins *= 2;
  return bins;
}

function paintWaves() {
  for (const cv of document.querySelectorAll("#vfxLanes canvas[data-wave]")) {
    const l = layerOf(cv.dataset.wave);
    if (!l || !l.src || waveDead.has(l.src)) continue;
    const bins = waveBins(l);
    const hit = wavePeaks.get(`${l.src}|${bins}`) || waveBest.get(l.src);
    if (hit) drawWaveBar(cv, l, hit);          // the best we have, immediately
    if (!wavePeaks.has(`${l.src}|${bins}`)) waveFetch(l, bins);
  }
}

function waveFetch(l, bins) {
  const key = `${l.src}|${bins}`;
  if (waveBusy.has(key)) return;
  waveBusy.add(key);
  const src = l.src, slug = V.slug, layerId = l.id;
  (async () => {
    /* Throttle, not debounce-everything: a zoom drag fires paintTimeline per
     * input event, and this beat folds the burst into the resolution it
     * settles on — the coarser levels it passed through simply never fetch
     * once the settled one is cached. */
    await new Promise((r) => setTimeout(r, 150));
    try {
      const d = await api({ action: "audio_peaks", slug, layerId, bins });
      const data = { peaks: d.peaks, seconds: d.seconds || 1, bins: d.bins };
      wavePeaks.set(`${src}|${d.bins}`, data);
      const best = waveBest.get(src);
      if (!best || d.bins >= best.bins) waveBest.set(src, data);
      for (const cv of document.querySelectorAll("#vfxLanes canvas[data-wave]")) {
        const ll = layerOf(cv.dataset.wave);
        if (ll?.src !== src) continue;
        drawWaveBar(cv, ll, wavePeaks.get(`${src}|${waveBins(ll)}`) || data);
      }
    } catch {
      /* A refusal is an answer — the file has no audio stream, or it left the
       * library. Either way, asking again per repaint would be a request loop. */
      waveDead.add(src);
    } finally { waveBusy.delete(key); }
  })();
}

function drawWaveBar(cv, l, data) {
  if (!cv.isConnected || !data?.peaks?.length) return;
  const g = cv.getContext("2d");
  const w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  const pairs = data.peaks.length / 2;
  const a = num(l.start, 0), b = num(l.end, dur());
  const span = Math.max(1e-6, b - a);
  const inP = num(l.inPoint, 0), ts = num(l.timeScale, 1) || 1;
  const mid = h / 2;
  /* The canvas reads its colors off its own computed style, so the theme owns
   * them: `color` is the band, `border-top-color` (a 0-width border, never
   * drawn by CSS) carries the envelope's hue. */
  const style = getComputedStyle(cv);
  g.fillStyle = style.color;
  for (let x = 0; x < w; x++) {
    /* canvas x → comp time → SOURCE time, the engine's own retiming rule
     * (source = inPoint + (t − start) × timeScale) → peak column. Negative
     * timeScale walks the columns backwards; past either end of the source
     * the column is out of range and the lane stays silent-blank, exactly
     * where the mix goes silent. */
    const tSrc = inP + ((x + 0.5) / w) * span * ts;
    const col = Math.floor((tSrc / data.seconds) * pairs);
    if (col < 0 || col >= pairs) continue;
    const lo = data.peaks[col * 2], hi = data.peaks[col * 2 + 1];
    const y0 = mid - hi * mid, y1 = mid - lo * mid;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  drawLevelCurve(g, style, l, w, h, a, span);
}

/** The audioLevels envelope, over the wave: [-48, +12] dB (the mixer's own
 *  rail, engine.py AUDIO_DB_MIN/MAX) mapped to the lane height. Sampled every
 *  2 px through evalProp — the SAME evaluator the property row and the graph
 *  editor read — so the line here IS the fade the mix performs, easing
 *  included; no second keyframe interpreter. Constant levels draw nothing:
 *  a flat line at unity is ink with no information. */
function drawLevelCurve(g, style, l, w, h, a, span) {
  if (!isAnim(l.audioLevels)) return;
  g.strokeStyle = style.borderTopColor;
  g.lineWidth = 1;
  g.beginPath();
  const yOf = (t) => {
    const db = Math.max(-48, Math.min(12, num(evalProp(l.audioLevels, t), 0)));
    return ((12 - db) / 60) * (h - 2) + 1;
  };
  g.moveTo(0, yOf(a));
  for (let x = 2; x < w; x += 2) g.lineTo(x, yOf(a + (x / w) * span));
  g.lineTo(w, yOf(a + span));
  g.stroke();
}

/** The playhead moves far more often than the rest of the timeline changes, so
 *  it is nudged rather than repainted. The diamonds re-mark themselves the same
 *  way: the position they already carry IS their time, so no lookup is needed. */
function paintPlayhead() {
  const el = $("vfxPlayhead");
  if (el) el.style.left = `${V.t * V.pps}px`;
  for (const d of document.querySelectorAll("#vfxLanes .vfxkey")) {
    d.classList.toggle("at", Math.abs(parseFloat(d.style.left) / V.pps - V.t) < 1 / (2 * fps()));
  }
  paintTreeValues();
}

/**
 * The numbers on the property rows, re-stated at the new time.
 *
 * NUDGED, NOT REPAINTED — the same bargain the playhead and the diamonds make
 * one function up, and for a stronger reason: this runs once per frame during
 * playback, and rebuilding the whole tree there would rebuild every twirl,
 * every caret and every lane thirty times a second to change a handful of
 * digits. Only the rows currently on screen are touched, because only they
 * exist in the DOM.
 *
 * The box under the cursor is left alone. A repaint that overwrites what
 * somebody is halfway through typing is the classic way a live panel becomes
 * unusable, and stepping a frame while a box has focus is an ordinary thing to
 * do — that is what the arrow keys are for.
 */
function paintTreeValues() {
  const focused = document.activeElement;
  for (const head of document.querySelectorAll("#vfxTl [data-prop]")) {
    const r = treeRef(head.dataset.prop);
    if (!r) continue;
    const { l, path } = r;
    const prop = propAt(l, path);
    const rows = V.props.get(l.id)?.rows || [];
    const p = rows.find((x) => x.path === path);
    if (!p) continue;
    const val = rowValue(l, p);
    for (const inp of head.querySelectorAll("[data-tv]")) {
      if (inp === focused) continue;
      const i = +inp.dataset.i;
      const miss = i === 2 ? (XFORM_Z[path] ?? 0) : 0;
      const v = Array.isArray(val) ? num(val[i], miss) : (i ? miss : num(val));
      inp.value = String(Math.round(v * 1000) / 1000);
    }
    const at = isAnim(prop) && keysOf(prop).some((k) => Math.abs(k.t - V.t) < 1e-4);
    head.querySelector("[data-keyat]")?.classList.toggle("on", at);
  }
}

/* ── the graph editor ─────────────────────────────────────────────────────
 *
 * The single largest gap between this tab and After Effects, measured against
 * the real thing: you could put keyframes down and retime them, and there was
 * no curve to shape. "Ease" as a dropdown of five names is not the same object
 * as a curve with handles — the dropdown can say easeInOut and cannot say
 * "leave slowly, arrive hard, overshoot by six percent", which is most of what
 * motion design consists of.
 *
 * THE CURVE DRAWN IS EVALUATED, NOT DESCRIBED. Every point on it comes from
 * `evalProp` — this file's mirror of `interp.py` — sampled across the comp. So
 * hold reads as a step, a bezier reads as its bezier, and an expression's
 * underlying keys read as themselves. Nothing here re-derives a shape from the
 * ease name, which is how a graph editor ends up drawing a curve the renderer
 * does not produce.
 *
 * WHAT IT WRITES, and why the shapes are copied off the server rather than
 * invented here (`store.js:normalizeKeys` is the authority, and this codebase
 * has been bitten repeatedly by a UI sending a spelling the server does not
 * read):
 *
 *   ease   `{ bezier: [x1, y1, x2, y2] }` — x1 and x2 pinned to 0..1 because
 *          normalizeEase refuses anything else (time cannot run backwards); y
 *          is free, which is exactly what makes overshoot expressible.
 *   to/ti  AE's spatial tangents, as OFFSETS from the key's own value and
 *          carrying the property's arity. Authored on the motion path below,
 *          not here — a spatial handle is a shape in the picture.
 *   roving `true` on an INTERIOR key only; the ends are the anchors it roves
 *          between, and normalizeKeys refuses a roving end.
 *
 * All three were already honoured by the interpolator and reachable from
 * nothing. That is the difference between machinery and a feature.
 */

const GRAPH_H = 168;        // the plot, in pixels
const GRAPH_PAD = 14;       // top and bottom, so a key at the extreme is not clipped
/* Past this many segments the handles are drawn only around a selected key.
 * Twelve pairs of handles on one lane is not a graph, it is a hedge. */
const GRAPH_ALL_HANDLES = 12;

/** A keyframe's identity across a repaint: its TIME. Indices re-sort, times do
 *  not — and the server's own `remove_key` addresses a key the same way. */
const keyId = (layerId, path, t) => `${layerId}|${path}|${num(t).toFixed(4)}`;

const compAt = (v, i) => (Array.isArray(v) ? num(v[i], 0) : num(v, 0));
const keyArity = (ks) => Math.max(1, ...ks.map((k) => (Array.isArray(k.v) ? k.v.length : 1)));

/**
 * The four control numbers behind whatever spelling a key carries.
 *
 * `hold` returns null rather than a straight line: it is a step, not a curve,
 * and offering handles that shape it would offer to change something that does
 * not bend. Converting it silently on the first drag would change the render.
 */
function easeBezier(ease) {
  if (ease === "hold") return null;
  if (!ease || ease === "linear") return [0, 0, 1, 1];
  if (typeof ease === "object" && Array.isArray(ease.bezier)) return ease.bezier.map(Number);
  return NAMED_BEZIER[ease] ? [...NAMED_BEZIER[ease]] : [0, 0, 1, 1];
}

/** What the y axis shows at time t: the active component, or — in speed mode —
 *  the magnitude of the whole vector's derivative, which is what `speed_at` in
 *  interp.py means by speed and the only reading that is the same for a
 *  position as for a rotation. */
function graphSampleAt(prop, t, mode, ci) {
  if (mode !== "speed") return compAt(evalProp(prop, t), ci);
  const h = 1 / (fps() * 8);
  const a = evalProp(prop, t - h), b = evalProp(prop, t + h);
  const av = Array.isArray(a) ? a : [num(a)], bv = Array.isArray(b) ? b : [num(b)];
  let sq = 0;
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (num(bv[i], 0) - num(av[i], 0)) / (2 * h);
    sq += d * d;
  }
  return Math.sqrt(sq);
}

/** Which of this layer's properties the graph can be put on — the keyed ones.
 *  A property carrying only an expression has no keys to shape. */
/**
 * Which of a layer's properties the graph can be put on — the keyed ones. A
 * property carrying only an expression has no keys to shape. The list is the
 * ENUMERATOR'S, so the chip strip cannot offer a path set_prop would not take.
 *
 * Synchronous, off the cache, because `paintGraph` is a painter and a painter
 * that awaits is a painter that half-draws: this returned a promise for one
 * build and the plot came up empty with no error anywhere near it.
 */
function graphablePaths(l) {
  return (propsOf(l.id)?.rows || []).filter((p) => isAnim(propAt(l, p.path)));
}

/**
 * The transport's ◠ button is the SECOND way in and should stay that way: the
 * first is the ◠ on the property row you are already looking at, which is the
 * whole reason the tree exists. This one just picks the first keyed property on
 * the selected layer so the button is never a dead end.
 */
async function toggleGraph() {
  if (V.graph) { V.graph = null; V.ksel.clear(); return void (paintTransport(), paintGraph()); }
  const l = selected();
  if (!l) return note("Select a layer first; the graph editor works on one property at a time.");
  await propRowsFor(l.id);
  const rows = graphablePaths(l);
  if (!rows.length) {
    return note(`"${l.name || l.id}" has no keyframed property yet — twirl it open in the timeline `
      + `and press a stopwatch; the ◠ on that row opens the graph on it.`);
  }
  openGraph(l.id, rows[0].path);
}

function openGraph(layerId, path) {
  V.graph = { layerId, path, mode: V.graph?.mode || "value" };
  V.gcomp = 0;
  /* Twirl the layer AND the group the property sits in, so closing the graph
   * leaves you looking at the row you opened it from rather than at a collapsed
   * layer with no clue where you were. */
  V.open.add(layerId);
  for (const p of V.props.get(layerId)?.rows || []) {
    if (p.path !== path) continue;
    V.gopen.add(gkey(layerId, p.group));
    const sub = subOf(p);
    if (sub) V.gopen.add(gkey(layerId, p.group, sub));
  }
  paintTransport(); paintTimeline(); paintGraph();
}

/* The mapping from value to pixels is stored rather than recomputed, because a
 * drag that inverts a DIFFERENT mapping than the one it was drawn with is the
 * bug this whole panel is most likely to have: it looks right until the range
 * shifts under the pointer. One object, written by the painter, read by the
 * handlers. */
let GY = { lo: 0, hi: 1, top: GRAPH_PAD, h: GRAPH_H - 2 * GRAPH_PAD };
const yOf = (v) => GY.top + (GY.hi - v) / ((GY.hi - GY.lo) || 1) * GY.h;
const vOf = (y) => GY.hi - (y - GY.top) / (GY.h || 1) * (GY.hi - GY.lo);

function paintGraph() {
  const box = $("vfxGraph");
  if (!box) return;
  const g = V.graph;
  const l = g && layerOf(g.layerId);
  const prop = l && propAt(l, g.path);
  if (!g || !l || !isAnim(prop)) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;

  const ks = keysOf(prop).map((k) => JSON.parse(JSON.stringify(k)));
  const arity = keyArity(ks);
  const ci = clamp(V.gcomp, 0, arity - 1);
  const speed = g.mode === "speed";
  const width = Math.max(240, dur() * V.pps + 40);

  /* Range over the SAMPLED curve, the keys and the handles together. Sampling
   * alone misses a handle parked outside the curve it shapes; the keys alone
   * miss every overshoot. */
  const pts = [];
  const N = 320;
  for (let i = 0; i <= N; i++) pts.push(graphSampleAt(prop, (i / N) * dur(), g.mode, ci));
  const segs = speed ? [] : easeSegments(ks, ci);
  const marks = speed ? [] : ks.map((k) => compAt(k.v, ci));
  let lo = Math.min(...pts, ...marks, ...segs.flatMap((s) => [s.p1.v, s.p2.v]));
  let hi = Math.max(...pts, ...marks, ...segs.flatMap((s) => [s.p1.v, s.p2.v]));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  GY = { lo: lo - pad, hi: hi + pad, top: GRAPH_PAD, h: GRAPH_H - 2 * GRAPH_PAD };

  const rows = graphablePaths(l);
  const chips = rows.map((r) => `<button type="button" class="vfxgchip${r.path === g.path ? " on" : ""}"
      data-gpath="${esc(r.path)}" title="${esc(r.path)}">${esc(r.label)}</button>`).join("");
  const axes = arity > 1 && !speed
    ? `<span class="vfxgaxes">${["x", "y", "z"].slice(0, arity).map((a, i) =>
        `<button type="button" class="vfxgchip sm${i === ci ? " on" : ""}" data-gcomp="${i}"
          title="Which component the keys and handles are drawn for. The easing is ONE curve shared by every component — shaping it here shapes all of them.">${a}</button>`).join("")}</span>`
    : "";

  box.innerHTML = `
    <div class="vfxgraphbody">
      <div class="vfxgraphside">
        <div class="vfxgtabs">
          <button type="button" class="vfxgchip${speed ? "" : " on"}" data-gmode="value"
            title="Value against time — the curve the renderer produces">value</button>
          <button type="button" class="vfxgchip${speed ? " on" : ""}" data-gmode="speed"
            title="How fast the value is changing. Read-only: speed is a consequence of the curve, and the document stores the curve.">speed</button>
          <button type="button" class="vfxgclose" id="vfxGraphX" title="Close the graph editor">✕</button>
        </div>
        ${axes}
        <div class="vfxgchips">${chips}</div>
        <div class="vfxgscale">
          <span>${fmtV(GY.hi)}</span><span>${fmtV((GY.hi + GY.lo) / 2)}</span><span>${fmtV(GY.lo)}</span>
        </div>
      </div>
      <div class="vfxgraphscroll" id="vfxGraphScroll">
        <svg class="vfxgraphsvg" id="vfxGraphSvg" width="${width}" height="${GRAPH_H}">
          ${graphGrid(width)}
          ${graphCurves(prop, l, g, arity, ci, width)}
          ${speed ? "" : segs.map((s, i) => graphHandles(s, i, ks, l, g)).join("")}
          ${speed ? graphSpeedKeys(prop, ks, l, g) : ks.map((k, i) => graphKey(k, i, ci, l, g)).join("")}
          <line class="vfxgplay" x1="${V.t * V.pps}" x2="${V.t * V.pps}" y1="0" y2="${GRAPH_H}"></line>
        </svg>
      </div>
    </div>
    ${graphInspector(l, g, ks, arity, ci)}`;

  wireGraph(l, g, ks, arity, ci);
}

/** A value on the axis: short enough to fit, precise enough to be a value. */
const fmtV = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function graphGrid(width) {
  const mid = GY.top + GY.h / 2;
  const lines = [GY.top, mid, GY.top + GY.h].map((y) =>
    `<line class="vfxggrid" x1="0" x2="${width}" y1="${y}" y2="${y}"></line>`).join("");
  /* A zero line, but only when zero is on screen — a graph of an opacity that
   * never leaves 40..60 should not spend a third of its height reaching it. */
  const zero = GY.lo < 0 && GY.hi > 0
    ? `<line class="vfxgzero" x1="0" x2="${width}" y1="${yOf(0)}" y2="${yOf(0)}"></line>` : "";
  const ticks = [];
  const step = V.pps > 120 ? 0.5 : V.pps > 60 ? 1 : V.pps > 30 ? 2 : 5;
  for (let t = 0; t <= dur() + 1e-6; t += step) {
    ticks.push(`<line class="vfxgtick" x1="${t * V.pps}" x2="${t * V.pps}" y1="0" y2="${GRAPH_H}"></line>`);
  }
  return ticks.join("") + lines + zero;
}

/** One polyline per component, the active one bright. Sampled from the same
 *  evaluator the number boxes read, at roughly one point per pixel. */
function graphCurves(prop, l, g, arity, ci, width) {
  const speed = g.mode === "speed";
  const n = Math.max(64, Math.min(1200, Math.round(width)));
  const draw = (which, cls) => {
    const pt = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * dur();
      pt.push(`${(t * V.pps).toFixed(1)},${yOf(graphSampleAt(prop, t, g.mode, which)).toFixed(1)}`);
    }
    return `<polyline class="${cls}" points="${pt.join(" ")}"></polyline>`;
  };
  if (speed) return draw(0, "vfxgcurve on");
  const out = [];
  for (let i = 0; i < arity; i++) if (i !== ci) out.push(draw(i, "vfxgcurve"));
  out.push(draw(ci, "vfxgcurve on"));
  return out.join("");
}

/**
 * The bezier handles of one segment, in the segment's own coordinates.
 *
 * CSS cubic-bezier semantics, which is what both `easeAt` here and
 * `bezier_ease` in interp.py implement: the control points live in the unit box
 * spanned by the segment, so P1 sits at (t0 + x1·span, v0 + y1·Δv). A segment
 * whose endpoints hold the SAME value has Δv = 0 and the handle collapses onto
 * the line — it can still be dragged in time, and its y is genuinely
 * meaningless there rather than merely hidden.
 */
function easeSegments(ks, ci) {
  const out = [];
  for (let i = 0; i < ks.length - 1; i++) {
    const b = easeBezier(ks[i].ease);
    if (!b) continue;                       // hold: a step has no handles
    const t0 = num(ks[i].t), t1 = num(ks[i + 1].t), span = t1 - t0;
    const v0 = compAt(ks[i].v, ci), v1 = compAt(ks[i + 1].v, ci), dv = v1 - v0;
    out.push({
      i, t0, t1, span, v0, dv, b,
      p1: { t: t0 + b[0] * span, v: v0 + b[1] * dv },
      p2: { t: t0 + b[2] * span, v: v0 + b[3] * dv },
    });
  }
  return out;
}

function graphHandles(s, _n, ks, l, g) {
  const many = ks.length - 1 > GRAPH_ALL_HANDLES;
  const near = V.ksel.has(keyId(l.id, g.path, ks[s.i].t)) || V.ksel.has(keyId(l.id, g.path, ks[s.i + 1].t));
  if (many && !near) return "";
  const flat = Math.abs(s.dv) < 1e-9;
  const tip = flat
    ? "This segment ends where it began, so the handle only means timing — there is no value for its height to describe."
    : "Drag to shape the curve. Time is pinned inside the segment (the server refuses a bezier that runs backwards); height is free, and past the ends it overshoots.";
  const h = (p, kind, cls) => `
    <line class="vfxghline" x1="${(kind === "out" ? s.t0 : s.t1) * V.pps}" y1="${yOf(kind === "out" ? s.v0 : s.v0 + s.dv)}"
          x2="${p.t * V.pps}" y2="${yOf(p.v)}"></line>
    <circle class="vfxgh ${cls}${flat ? " flat" : ""}" data-gh="${s.i}:${kind}" r="4.5"
            cx="${p.t * V.pps}" cy="${yOf(p.v)}"><title>${esc(tip)}</title></circle>`;
  return h(s.p1, "out", "out") + h(s.p2, "in", "in");
}

function graphKey(k, i, ci, l, g) {
  const on = V.ksel.has(keyId(l.id, g.path, k.t));
  const x = num(k.t) * V.pps, y = yOf(compAt(k.v, ci));
  const rove = k.roving ? " roving" : "";
  const tip = `${fmtT(num(k.t))} · ${fmtV(compAt(k.v, ci))}`
    + `${k.roving ? " · roving — the engine chooses this time to keep the speed even" : ""}`
    + `${(k.to || k.ti) ? " · has a spatial handle" : ""}`
    + ` — drag to retime and revalue, click to select, double-click to remove`;
  return `<rect class="vfxgkey${on ? " on" : ""}${rove}" data-gk="${i}" x="${x - 4.5}" y="${y - 4.5}"
      width="9" height="9" transform="rotate(45 ${x} ${y})"><title>${esc(tip)}</title></rect>`;
}

/** In speed mode a key is a marker on a curve it does not own a height on —
 *  drawn at the speed it sits at, and not draggable, because dragging it would
 *  be authoring a quantity the document does not store. */
function graphSpeedKeys(prop, ks, l, g) {
  return ks.map((k) => {
    const s = graphSampleAt(prop, num(k.t), "speed", 0);
    return `<circle class="vfxgkey speed${V.ksel.has(keyId(l.id, g.path, k.t)) ? " on" : ""}"
      cx="${num(k.t) * V.pps}" cy="${yOf(s)}" r="3.5"><title>${fmtT(num(k.t))} · ${fmtV(s)} per second</title></circle>`;
  }).join("");
}

/* ── the key inspector ───────────────────────────────────────────────────── */

function selIndices(l, g, ks) {
  return ks.map((_, i) => i).filter((i) => V.ksel.has(keyId(l.id, g.path, ks[i].t)));
}

function graphInspector(l, g, ks, arity, ci) {
  const sel = selIndices(l, g, ks);
  if (!sel.length) {
    return `<div class="vfxgraphfoot"><p class="hint">Click a keyframe to shape it. Drag one to retime and revalue it;
      drag a round handle to bend the segment leaving it. ${g.mode === "speed"
        ? "The speed graph is drawn, not authored — it is what the value curve implies."
        : "Shift while dragging keeps the time and moves only the value."}</p></div>`;
  }
  if (sel.length > 1) {
    return `<div class="vfxgraphfoot">
      <span class="vfxglab">${sel.length} keyframes</span>
      ${easeButtons("")}
      <button class="edtool sm" type="button" data-gsmooth="1"
        title="Give each one a spatial tangent computed from its neighbours — the smooth default AE calls auto-bezier. Visible on the motion path over the picture.">smooth</button>
      <button class="edtool sm" type="button" data-grove="1"
        title="Let the engine choose these keys' times so the speed between the anchors is even. Interior keys only.">rove</button>
      <button class="edtool sm warn" type="button" data-gdel="1">remove</button>
    </div>`;
  }
  const i = sel[0], k = ks[i];
  const interior = i > 0 && i < ks.length - 1;
  const ease = k.ease;
  const bez = easeBezier(ease);
  const isBez = typeof ease === "object" && Array.isArray(ease?.bezier);
  const last = i === ks.length - 1;
  const vals = Array.from({ length: arity }, (_, c) =>
    `<input type="number" class="vfxgnum" data-gkv="${c}" value="${Math.round(compAt(k.v, c) * 1000) / 1000}" step="1">`).join("");
  return `<div class="vfxgraphfoot">
    <span class="vfxglab">key ${i + 1}/${ks.length}</span>
    <label class="vfxfield">t<input type="number" class="vfxgnum" id="vfxGkT" value="${num(k.t).toFixed(3)}" step="${(1 / fps()).toFixed(4)}"></label>
    <label class="vfxfield">v${vals}</label>
    ${last
      ? `<span class="hint vfxgnote">The last key has nothing after it, so it has no easing — easing describes the segment LEAVING a key.</span>`
      : `${easeButtons(typeof ease === "string" ? ease : isBez ? "bezier" : "linear")}
         ${bez ? `<label class="vfxfield" title="x1 y1 x2 y2 — the CSS control points. x is pinned to 0..1 by the server; y is free, and outside 0..1 the segment overshoots.">bez${
           bez.map((n, c) => `<input type="number" class="vfxgnum" data-gbez="${c}" value="${Math.round(n * 1000) / 1000}" step="0.05"
             ${c % 2 === 0 ? `min="0" max="1"` : ""}>`).join("")}</label>`
           : `<span class="hint vfxgnote">A hold has no curve to shape — it steps.</span>`}`}
    <label class="edtool tog sm" title="${interior
      ? "The engine picks this key's time so the distance covered per second is even between the anchors either side. Its VALUE is untouched."
      : "The first and last keyframes are the anchors a roving key moves between, so they cannot rove — the server refuses it."}">
      <input type="checkbox" id="vfxGkRove"${k.roving ? " checked" : ""}${interior ? "" : " disabled"}>rove</label>
    ${arity > 1 ? `<button class="edtool sm" type="button" data-gsmooth="1"
      title="Compute this key's spatial tangents from its neighbours. Drag them on the motion path over the picture.">smooth</button>` : ""}
    ${(k.to || k.ti) ? `<span class="vfxgtan" title="Spatial tangents — offsets from this key's own value. The picture is where they are shaped.">
      to ${k.to ? k.to.map((n) => fmtV(n)).join(",") : "—"} · ti ${k.ti ? k.ti.map((n) => fmtV(n)).join(",") : "—"}</span>` : ""}
    <button class="edtool sm warn" type="button" data-gdel="1">remove</button>
  </div>`;
}

function easeButtons(cur) {
  return `<span class="vfxgeases">${EASES.map((e) =>
    `<button type="button" class="vfxgchip sm${e === cur ? " on" : ""}" data-gease="${e}"
      title="${e === "hold" ? "Step: this key holds its value until the next one." : `Apply ${e} to the segment leaving the selected key${cur === "bezier" ? " — this replaces the shaped curve" : ""}.`}">${e}</button>`).join("")
    }${cur === "bezier" ? `<i class="vfxgchip on sm" title="This segment carries its own four control points.">bezier</i>` : ""}</span>`;
}

/* ── graph wiring ────────────────────────────────────────────────────────── */

/** The one write the whole panel goes through. `keys` is an array in exactly
 *  the shape normalizeKeys accepts — t, v, and any of ease, to, ti, roving. */
function writeKeys(l, path, keys, coalesce = null, label = null) {
  return mutate(
    { action: "set_prop", slug: V.slug, layerId: l.id, path, keys: [...keys].sort((a, b) => a.t - b.t) },
    { coalesce, label },
  );
}

function wireGraph(l, g, ks, arity, ci) {
  const box = $("vfxGraph");
  const q = (s) => box.querySelectorAll(s);
  for (const b of q("[data-gpath]")) b.onclick = () => { V.graph = { ...g, path: b.dataset.gpath }; V.gcomp = 0; V.ksel.clear(); paintGraph(); };
  for (const b of q("[data-gmode]")) b.onclick = () => { V.graph = { ...g, mode: b.dataset.gmode }; paintGraph(); };
  for (const b of q("[data-gcomp]")) b.onclick = () => { V.gcomp = +b.dataset.gcomp; paintGraph(); };
  $("vfxGraphX").onclick = () => toggleGraph();

  /* Both scrollers show the same seconds, so they move together. Without this
   * the graph and the lanes disagree about which key is under the pointer the
   * moment either is scrolled, which is worse than having no graph. */
  const gs = $("vfxGraphScroll"), tls = $("vfxTlScroll");
  if (gs && tls) {
    gs.scrollLeft = tls.scrollLeft;
    let echo = false;
    gs.onscroll = () => { if (echo) return; echo = true; tls.scrollLeft = gs.scrollLeft; echo = false; };
    tls.onscroll = () => { if (echo) return; echo = true; gs.scrollLeft = tls.scrollLeft; echo = false; };
  }

  const sel = selIndices(l, g, ks);
  const apply = (fn, coalesce, label) =>
    writeKeys(l, g.path, ks.map((k, i) => (sel.includes(i) ? fn({ ...k }, i) : k)), coalesce, label);

  for (const b of q("[data-gease]")) b.onclick = () => {
    const e = b.dataset.gease;
    apply((k, i) => (i === ks.length - 1 ? k : { ...k, ease: e }), null, `${e} easing`);
  };
  for (const b of q("[data-gdel]")) b.onclick = () => deleteSelectedKeys();
  for (const b of q("[data-gsmooth]")) b.onclick = () => smoothKeys(l, g.path, ks, sel);
  for (const b of q("[data-grove]")) b.onclick = () => {
    const rove = !sel.every((i) => ks[i].roving);
    apply((k, i) => {
      // The ends cannot rove and the server says so; skipping them here means
      // "rove the ones that can" rather than a refusal for the whole selection.
      if (i === 0 || i === ks.length - 1) return k;
      if (rove) return { ...k, roving: true };
      const { roving, ...rest } = k;
      return rest;
    }, null, rove ? "rove keys" : "anchor keys");
  };

  const t = $("vfxGkT");
  if (t) t.onchange = () => {
    const i = sel[0];
    const lo = i > 0 ? ks[i - 1].t + 1 / fps() : 0;
    const hi = i < ks.length - 1 ? ks[i + 1].t - 1 / fps() : dur();
    apply((k) => ({ ...k, t: clamp(num(t.value), lo, Math.max(lo, hi)) }), `gkt:${g.path}:${i}`, "retime key");
  };
  for (const inp of q("[data-gkv]")) inp.onchange = () => {
    const c = +inp.dataset.gkv;
    apply((k) => {
      if (arity === 1) return { ...k, v: num(inp.value) };
      const v = Array.isArray(k.v) ? [...k.v] : new Array(arity).fill(num(k.v));
      v[c] = num(inp.value);
      return { ...k, v };
    }, `gkv:${g.path}:${sel[0]}:${c}`, "key value");
  };
  for (const inp of q("[data-gbez]")) inp.onchange = () => {
    const i = sel[0];
    const b = easeBezier(ks[i].ease) || [0, 0, 1, 1];
    b[+inp.dataset.gbez] = num(inp.value);
    b[0] = clamp(b[0], 0, 1); b[2] = clamp(b[2], 0, 1);
    apply((k) => ({ ...k, ease: { bezier: b } }), `gbez:${g.path}:${i}`, "shape the curve");
  };
  const rove = $("vfxGkRove");
  if (rove) rove.onchange = () => apply((k) => {
    if (rove.checked) return { ...k, roving: true };
    const { roving, ...rest } = k;
    return rest;
  }, null, rove.checked ? "rove key" : "anchor key");

  wireGraphDrags(l, g, ks, arity, ci);
}

/**
 * Dragging in the plot. Same contract as the timeline: paint from a local copy
 * while the pointer is down, commit ONE `set_prop` on release — so one gesture
 * is one request and, because the commit carries a gesture token, one history
 * entry however many times it fires.
 */
function wireGraphDrags(l, g, ks, arity, ci) {
  const svg = $("vfxGraphSvg");
  if (!svg) return;
  const work = ks.map((k) => JSON.parse(JSON.stringify(k)));
  let drag = null;

  const at = (e) => {
    const b = svg.getBoundingClientRect();
    return { t: clamp((e.clientX - b.left) / V.pps, 0, dur()), v: vOf(e.clientY - b.top) };
  };
  const repaint = () => {
    /* Redraw the plot from the working copy without touching the document or
     * the server. Cheap enough at 320 samples that a drag stays at frame rate. */
    const segs = easeSegments(work, ci);
    svg.innerHTML = graphGrid(+svg.getAttribute("width"))
      + graphCurvesLocal(work, arity, ci, +svg.getAttribute("width"))
      + segs.map((s, i) => graphHandles(s, i, work, l, g)).join("")
      + work.map((k, i) => graphKey(k, i, ci, l, g)).join("")
      + `<line class="vfxgplay" x1="${V.t * V.pps}" x2="${V.t * V.pps}" y1="0" y2="${GRAPH_H}"></line>`;
  };

  svg.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;
    const kel = e.target.closest("[data-gk]");
    const hel = e.target.closest("[data-gh]");
    if (!kel && !hel) {
      if (!e.shiftKey) { V.ksel.clear(); paintGraph(); }
      return;
    }
    if (g.mode === "speed") return note("The speed graph is drawn from the value curve — shape the value curve and the speed follows.");
    if (kel) {
      const i = +kel.dataset.gk;
      const id = keyId(l.id, g.path, ks[i].t);
      if (e.shiftKey) V.ksel.has(id) ? V.ksel.delete(id) : V.ksel.add(id);
      else if (!V.ksel.has(id)) { V.ksel.clear(); V.ksel.add(id); }
      const group = selIndices(l, g, ks);
      drag = { kind: "key", i, group: group.length ? group : [i], from: at(e), moved: false, lockT: e.shiftKey };
      /* Redraw the PLOT, not the panel: a full repaint replaces the <svg> the
       * pointer went down on, and the drag would then be painting into a node
       * that is no longer in the document. The inspector catches up on release. */
      repaint();
      return armGraph();
    }
    const [si, which] = hel.dataset.gh.split(":");
    drag = { kind: "handle", i: +si, which, moved: false };
    return armGraph();
  });

  const onMove = (e) => {
    if (!drag) return;
    const p = at(e);
    if (drag.kind === "key") {
      const dt = drag.lockT || e.shiftKey ? 0 : p.t - drag.from.t;
      const dv = p.v - drag.from.v;
      /* The group may not cross the keys outside it. Two keys at one instant is
       * a coin toss about which the interpolator picks, and normalizeKeys
       * refuses it — so the clamp is here rather than in an error message. */
      let loD = -Infinity, hiD = Infinity;
      for (const i of drag.group) {
        const below = i > 0 && !drag.group.includes(i - 1) ? ks[i - 1].t + 1 / fps() : 0;
        const above = i < ks.length - 1 && !drag.group.includes(i + 1) ? ks[i + 1].t - 1 / fps() : dur();
        loD = Math.max(loD, below - ks[i].t);
        hiD = Math.min(hiD, above - ks[i].t);
      }
      const d = clamp(Math.round(dt * fps()) / fps(), loD, hiD);
      for (const i of drag.group) {
        work[i].t = Math.round((ks[i].t + d) * fps()) / fps();
        if (arity === 1) work[i].v = compAt(ks[i].v, 0) + dv;
        else {
          const v = Array.isArray(ks[i].v) ? [...ks[i].v] : new Array(arity).fill(num(ks[i].v));
          v[ci] = compAt(ks[i].v, ci) + dv;
          work[i].v = v;
        }
      }
      drag.moved = true;
      return repaint();
    }
    const seg = easeSegments(work, ci).find((x) => x.i === drag.i);
    if (!seg || !seg.span) return;
    const b = [...seg.b];
    const x = clamp((p.t - seg.t0) / seg.span, 0, 1);
    // A flat segment has no Δv to divide by, so its handle keeps the height it
    // had and only its timing moves. That is not a limitation being hidden —
    // any y produces the same values when the endpoints are equal.
    const y = Math.abs(seg.dv) < 1e-9 ? null : (p.v - seg.v0) / seg.dv;
    if (drag.which === "out") { b[0] = x; if (y != null) b[1] = y; }
    else { b[2] = x; if (y != null) b[3] = y; }
    work[drag.i].ease = { bezier: b.map((n) => Math.round(n * 1e4) / 1e4) };
    drag.moved = true;
    repaint();
  };

  const onUp = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!d.moved) {
      // A click that never moved is a selection, and the inspector below the
      // plot is the thing that has to catch up with it.
      paintGraph(); paintTimeline(); paintMotionPath();
      return;
    }
    /* One token per gesture: two separate drags never merge into one history
     * entry, and a drag that committed forty times would. */
    writeKeys(l, g.path, work, `gdrag:${g.path}:${Date.now()}`,
      d.kind === "key" ? "move keyframe" : "shape the curve");
  };

  function armGraph() {
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  svg.addEventListener("dblclick", (e) => {
    const kel = e.target.closest("[data-gk]");
    if (!kel) return;
    const k = ks[+kel.dataset.gk];
    if (k) mutate({ action: "remove_key", slug: V.slug, layerId: l.id, path: g.path, t: k.t });
  });
}

/** The same curve as `graphCurves`, drawn from a working copy mid-drag rather
 *  than from the document. */
function graphCurvesLocal(work, arity, ci, width) {
  const prop = { keys: work };
  const n = Math.max(64, Math.min(1200, Math.round(width)));
  const draw = (which, cls) => {
    const pt = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * dur();
      pt.push(`${(t * V.pps).toFixed(1)},${yOf(compAt(evalProp(prop, t), which)).toFixed(1)}`);
    }
    return `<polyline class="${cls}" points="${pt.join(" ")}"></polyline>`;
  };
  const out = [];
  for (let i = 0; i < arity; i++) if (i !== ci) out.push(draw(i, "vfxgcurve"));
  out.push(draw(ci, "vfxgcurve on"));
  return out.join("");
}

/* ── keyframe selection, wherever it is shown ────────────────────────────── */

/**
 * Removing every selected key.
 *
 * A property cannot hold an EMPTY key list — §1 has no reading for a property
 * with no value at all, and normalizeKeys refuses it — so emptying a track
 * collapses it back to a constant holding what you can see at the playhead,
 * which is what the server's own `remove_key` does on the way out.
 */
async function deleteSelectedKeys() {
  const groups = new Map();
  for (const id of V.ksel) {
    const [layerId, path, t] = id.split("|");
    const k = `${layerId}|${path}`;
    if (!groups.has(k)) groups.set(k, { layerId, path, times: [] });
    groups.get(k).times.push(+t);
  }
  if (!groups.size) return false;
  for (const { layerId, path, times } of groups.values()) {
    const l = layerOf(layerId);
    if (!l) continue;
    const prop = propAt(l, path);
    const keep = keysOf(prop).filter((k) => !times.some((t) => Math.abs(k.t - t) < 1e-3));
    if (keep.length) await writeKeys(l, path, keep, null, `remove ${times.length} keyframe${times.length === 1 ? "" : "s"}`);
    else {
      await mutate({ action: "set_prop", slug: V.slug, layerId, path, value: evalProp(prop, V.t) },
        { label: "remove the animation" });
    }
  }
  V.ksel.clear();
  paint();
  return true;
}

/**
 * Auto-bezier: give each key a spatial tangent computed from its neighbours.
 *
 * The Catmull-Rom construction AE calls auto-bezier — the handle points along
 * the line between the keys either side, a sixth of that distance out — which
 * is the shape that makes a path through several points read as one smooth
 * curve rather than a sequence of arcs. Endpoints take a third of their single
 * neighbour's offset, which is the standard degenerate case.
 *
 * `to` and `ti` are OFFSETS from the key's own value (interp.py's header says
 * so, and normalizeKeys refuses one whose arity does not match the value), so
 * these are differences, never positions.
 */
function autoTangents(ks) {
  const n = ks.length;
  const arity = keyArity(ks);
  const vec = (k) => (Array.isArray(k.v) ? k.v.map((x) => num(x)) : new Array(arity).fill(num(k.v)));
  return ks.map((k, i) => {
    const cur = vec(k);
    const prev = vec(ks[Math.max(0, i - 1)]);
    const next = vec(ks[Math.min(n - 1, i + 1)]);
    const scale = (i === 0 || i === n - 1) ? 1 / 3 : 1 / 6;
    const d = cur.map((_, c) => (next[c] - prev[c]) * scale);
    return { to: d.map((x) => x), ti: d.map((x) => -x) };
  });
}

function smoothKeys(l, path, ks, sel) {
  if (keyArity(ks) < 2) {
    return note("A spatial tangent is a direction in the picture, so it only means something on a property with at least two components — a position or a scale, not an opacity.");
  }
  const tan = autoTangents(ks);
  const want = new Set(sel.length ? sel : ks.map((_, i) => i));
  const next = ks.map((k, i) => (want.has(i) ? { ...k, to: tan[i].to, ti: tan[i].ti } : k));
  writeKeys(l, path, next, null, "smooth the path");
}

/* ── the motion path, over the picture ───────────────────────────────────────
 *
 * Where a spatial tangent is actually shaped. `to` and `ti` describe a curve
 * through space, and no pair of number boxes makes that authorable — the handle
 * has to be on the picture, at the place the layer will be.
 *
 * Drawn in COMP COORDINATES: the SVG's viewBox is the comp's own size, so
 * every number here is the number in the document and there is no second
 * coordinate system to get wrong. Only the handle radii are converted, because
 * a dot has to stay the same size on screen whatever the comp is.
 */

const MP_PROP = "transform.position";

function paintMotionPath() {
  const svg = $("vfxMotionPath");
  if (!svg) return;
  const l = selected();
  const prop = l && propAt(l, MP_PROP);
  const ks = isAnim(prop) ? keysOf(prop) : [];
  const img = $("vfxFrame");
  /* `toggleAttribute`, NOT `.hidden`. That IDL property lives on HTMLElement and
   * an <svg> is an SVGElement, so `svg.hidden = false` sets a plain JS property
   * and leaves the attribute — and the UA's `[hidden] { display: none }` — right
   * where they were. Measured: the overlay reported hidden === false and
   * measured 0×0 at 0,0. */
  if (!V.motionPath || !V.comp || ks.length < 2 || keyArity(ks) < 2 || !img || img.hidden) {
    svg.toggleAttribute("hidden", true);
    return;
  }
  svg.toggleAttribute("hidden", false);
  const W = V.comp.width, H = V.comp.height;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  /* Laid over the picture's MEASURED rectangle rather than over the box that
   * contains it: the picture is letterboxed inside that box, and a comp
   * coordinate that lands a handle in the letterbox is a handle in the wrong
   * place. Measuring also absorbs the image's own border, whatever box-sizing
   * the base sheet happens to use. */
  const ir = img.getBoundingClientRect(), br = $("vfxCheck").getBoundingClientRect();
  svg.style.left = `${ir.left - br.left}px`;
  svg.style.top = `${ir.top - br.top}px`;
  svg.style.width = `${ir.width}px`;
  svg.style.height = `${ir.height}px`;
  // One screen pixel, in comp units — so a 5 px dot is 5 px at any comp size.
  const k = W / Math.max(1, ir.width);
  const P = (v) => [compAt(v, 0), compAt(v, 1)];

  let d = "";
  for (let i = 0; i < ks.length - 1; i++) {
    const a = P(ks[i].v), b = P(ks[i + 1].v);
    const to = ks[i].to, ti = ks[i + 1].ti;
    if (i === 0) d += `M ${a[0]} ${a[1]} `;
    if (to || ti) {
      const c1 = [a[0] + num(to?.[0]), a[1] + num(to?.[1])];
      const c2 = [b[0] + num(ti?.[0]), b[1] + num(ti?.[1])];
      d += `C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${b[0]} ${b[1]} `;
    } else d += `L ${b[0]} ${b[1]} `;
  }

  /* Where the layer is at every frame, as AE draws it: the dots crowd where the
   * motion is slow and spread where it is fast, which is the one picture that
   * shows an ease without a graph. */
  const dots = [];
  const step = 1 / fps();
  for (let t = ks[0].t; t <= ks[ks.length - 1].t + 1e-6; t += step) {
    const p = P(evalProp(prop, t));
    dots.push(`<circle class="vfxmpdot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${1.4 * k}"></circle>`);
  }

  const tan = autoTangents(ks);
  const handles = ks.map((key, i) => {
    const p = P(key.v);
    const out = [];
    for (const [which, mine] of [["to", key.to], ["ti", key.ti]]) {
      /* A key with no tangent yet still shows a grab point, at the offset
       * auto-bezier WOULD give it, drawn hollow. Otherwise the only way to make
       * a first tangent is to know the feature is there. */
      const off = mine || tan[i][which];
      const has = !!mine;
      if ((which === "to" && i === ks.length - 1) || (which === "ti" && i === 0)) continue;
      const h = [p[0] + num(off[0]), p[1] + num(off[1])];
      out.push(`<line class="vfxmpline" x1="${p[0]}" y1="${p[1]}" x2="${h[0]}" y2="${h[1]}"></line>
        <circle class="vfxmph${has ? "" : " ghost"}" data-mp="h:${i}:${which}" cx="${h[0]}" cy="${h[1]}" r="${5 * k}">
          <title>${which === "to" ? "Leaving" : "Arriving at"} keyframe ${i + 1} — drag to bend the path${has ? "" : " (this key has no tangent yet; dragging makes one)"}. Hold Alt to move this handle alone.</title></circle>`);
    }
    return out.join("") + `<circle class="vfxmpkey${V.ksel.has(keyId(l.id, MP_PROP, key.t)) ? " on" : ""}"
      data-mp="k:${i}" cx="${p[0]}" cy="${p[1]}" r="${4.5 * k}">
      <title>Keyframe ${i + 1} at ${fmtT(num(key.t))} — drag to move it in space.</title></circle>`;
  }).join("");

  svg.innerHTML = `<path class="vfxmppath" d="${d}"></path>${dots.join("")}${handles}`;
  wireMotionPath(l, ks);
}

function wireMotionPath(l, ks) {
  const svg = $("vfxMotionPath");
  const work = ks.map((k) => JSON.parse(JSON.stringify(k)));
  let drag = null;
  const at = (e) => {
    const b = $("vfxFrame").getBoundingClientRect();
    return [
      (e.clientX - b.left) / (b.width || 1) * V.comp.width,
      (e.clientY - b.top) / (b.height || 1) * V.comp.height,
    ];
  };

  svg.onpointerdown = (e) => {
    const el = e.target.closest("[data-mp]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();                   // not a scrub on the well underneath
    const [kind, i, which] = el.dataset.mp.split(":");
    const p = at(e);
    drag = { kind, i: +i, which, from: p, alt: e.altKey };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onMove = (e) => {
    if (!drag) return;
    const p = at(e);
    const k = work[drag.i];
    const base = [compAt(ks[drag.i].v, 0), compAt(ks[drag.i].v, 1)];
    if (drag.kind === "k") {
      const d = [p[0] - drag.from[0], p[1] - drag.from[1]];
      const v = Array.isArray(ks[drag.i].v) ? [...ks[drag.i].v] : [0, 0];
      v[0] = base[0] + d[0]; v[1] = base[1] + d[1];
      k.v = v;
    } else {
      const off = [p[0] - base[0], p[1] - base[1]];
      const arity = keyArity(ks);
      const pad = (a) => (arity > 2 ? [...a, ...new Array(arity - 2).fill(0)] : a);
      k[drag.which] = pad(off.map((x) => Math.round(x * 100) / 100));
      /* Mirrored by default, broken with Alt — AE's rule, and the reason a path
       * through a key looks smooth rather than kinked without anyone asking
       * for it. The opposite handle keeps its own LENGTH; only its direction
       * follows, which is what "mirror" means in a curve editor and not what a
       * plain negation gives you. */
      if (!drag.alt && !e.altKey) {
        const other = drag.which === "to" ? "ti" : "to";
        const cur = k[other] || (drag.which === "to" ? [-off[0], -off[1]] : [-off[0], -off[1]]);
        const len = Math.hypot(num(cur[0]), num(cur[1])) || Math.hypot(off[0], off[1]);
        const m = Math.hypot(off[0], off[1]) || 1;
        k[other] = pad([-off[0] / m * len, -off[1] / m * len].map((x) => Math.round(x * 100) / 100));
      }
    }
    drag.moved = true;
    paintMotionPathLocal(work);
  };

  const onUp = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!d.moved) {
      if (d.kind === "k") {
        const id = keyId(l.id, MP_PROP, ks[d.i].t);
        V.ksel.has(id) ? V.ksel.delete(id) : (V.ksel.clear(), V.ksel.add(id));
        paintMotionPath(); paintGraph(); paintTimeline();
      }
      return;
    }
    writeKeys(l, MP_PROP, work, `mp:${d.kind}:${d.i}:${Date.now()}`,
      d.kind === "k" ? "move the key in space" : "bend the motion path");
  };
}

/** Redraw the path from a working copy mid-drag. Same geometry as the painter,
 *  reached by handing it a property object that is not in the document. */
function paintMotionPathLocal(work) {
  const svg = $("vfxMotionPath"), img = $("vfxFrame");
  if (!svg || !img) return;
  const prop = { keys: work };
  const P = (v) => [compAt(v, 0), compAt(v, 1)];
  let d = "";
  for (let i = 0; i < work.length - 1; i++) {
    const a = P(work[i].v), b = P(work[i + 1].v);
    const to = work[i].to, ti = work[i + 1].ti;
    if (i === 0) d += `M ${a[0]} ${a[1]} `;
    if (to || ti) {
      d += `C ${a[0] + num(to?.[0])} ${a[1] + num(to?.[1])} ${b[0] + num(ti?.[0])} ${b[1] + num(ti?.[1])} ${b[0]} ${b[1]} `;
    } else d += `L ${b[0]} ${b[1]} `;
  }
  const k = V.comp.width / Math.max(1, img.getBoundingClientRect().width);
  const dots = [];
  for (let t = work[0].t; t <= work[work.length - 1].t + 1e-6; t += 1 / fps()) {
    const p = P(evalProp(prop, t));
    dots.push(`<circle class="vfxmpdot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${1.4 * k}"></circle>`);
  }
  const handles = work.map((key, i) => {
    const p = P(key.v);
    let out = "";
    for (const which of ["to", "ti"]) {
      if ((which === "to" && i === work.length - 1) || (which === "ti" && i === 0)) continue;
      if (!key[which]) continue;
      const h = [p[0] + num(key[which][0]), p[1] + num(key[which][1])];
      out += `<line class="vfxmpline" x1="${p[0]}" y1="${p[1]}" x2="${h[0]}" y2="${h[1]}"></line>
        <circle class="vfxmph" data-mp="h:${i}:${which}" cx="${h[0]}" cy="${h[1]}" r="${5 * k}"></circle>`;
    }
    return `${out}<circle class="vfxmpkey" data-mp="k:${i}" cx="${p[0]}" cy="${p[1]}" r="${4.5 * k}"></circle>`;
  }).join("");
  svg.innerHTML = `<path class="vfxmppath" d="${d}"></path>${dots.join("")}${handles}`;
}

/* ── the transform gizmo and wireframes, over the picture ────────────────────
 *
 * Every number drawn here came from the SERVER — /api/vfx view_overlay, which
 * computes the geometry with the engine's own matrices and camera. This file
 * adds no projection maths of its own, because the viewer shows server-rendered
 * pixels and a client-side reprojection would put the tripod where the client
 * thinks the layer is rather than where the render put it. Drags go back
 * through view_unproject (the exact inverse, same camera) and land as ordinary
 * set_prop / add_key writes — which is what makes a gizmo drag identical to an
 * MCP call, undo included.
 */

const AXIS_COLOR = { x: "#e05555", y: "#4fae4f", z: "#4f7fe0" };

const gizmoKey = () => `${V.rev}|${V.sel || ""}|${V.t.toFixed(4)}|${viewKey()}`;

async function loadOverlay() {
  if (V.ovlBusy) return;
  const key = gizmoKey();
  V.ovlBusy = true;
  try {
    const d = await api({
      action: "view_overlay", slug: V.slug, t: V.t,
      layerId: V.sel || undefined, view: V.view || undefined,
    });
    V.ovl = { key, data: d };
  } catch {
    V.ovl = { key, data: null };   // a failed overlay hides quietly; the frame told the real story
  } finally {
    V.ovlBusy = false;
  }
  paintGizmo();                    // fresh, or stale — a repaint kicks the next fetch
}

/** Whether this comp has anything the overlay can say something about. */
function gizmoWorthIt() {
  return !!V.sel || layers().some((l) => l.threeD || l.type === "camera" || l.type === "light");
}

function paintGizmo() {
  const svg = $("vfxGizmo"), img = $("vfxFrame");
  if (!svg) return;
  const off = !V.gizmo || !V.comp || !img || img.hidden || V.playing || V.scrubbing
    || !gizmoWorthIt();
  if (off) { svg.toggleAttribute("hidden", true); return; }
  const key = gizmoKey();
  if (!V.ovl || V.ovl.key !== key) {
    // Keep the last picture up while the fresh one is fetched — a gizmo that
    // blinks on every playhead move is a gizmo nobody can grab.
    loadOverlay();
    if (!V.ovl?.data) { svg.toggleAttribute("hidden", true); return; }
  }
  const d = V.ovl.data;
  if (!d) { svg.toggleAttribute("hidden", true); return; }

  svg.toggleAttribute("hidden", false);
  const W = V.comp.width, H = V.comp.height;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const ir = img.getBoundingClientRect(), br = $("vfxCheck").getBoundingClientRect();
  svg.style.left = `${ir.left - br.left}px`;
  svg.style.top = `${ir.top - br.top}px`;
  svg.style.width = `${ir.width}px`;
  svg.style.height = `${ir.height}px`;
  const k = W / Math.max(1, ir.width);        // one screen px, in comp units

  const polys = (rows, cls) => rows.map((w) => (w.polylines || []).map((pl) =>
    `<polyline class="${cls}" points="${pl.map((p) => `${p[0]},${p[1]}`).join(" ")}"></polyline>`).join("")
    + (w.pos ? `<circle class="${cls} dot" cx="${w.pos[0]}" cy="${w.pos[1]}" r="${3 * k}"><title>${esc(w.name || w.id)}</title></circle>` : ""))
    .join("");

  let sel = "";
  const s = d.selected;
  if (s) {
    const parts = [];
    if (s.outline) {
      parts.push(`<polygon class="vfxgzoutline" data-gz="body"
        points="${s.outline.map((p) => `${p[0]},${p[1]}`).join(" ")}"><title>${esc(s.name)} — drag to move in the view plane</title></polygon>`);
    }
    for (const a of s.axes || []) {
      if (a.degenerate) continue;
      parts.push(`<line class="vfxgzaxis" stroke="${AXIS_COLOR[a.axis]}"
          x1="${a.from[0]}" y1="${a.from[1]}" x2="${a.to[0]}" y2="${a.to[1]}"></line>
        <circle class="vfxgzhandle" data-gz="axis:${a.axis}" fill="${AXIS_COLOR[a.axis]}"
          cx="${a.to[0]}" cy="${a.to[1]}" r="${5 * k}">
          <title>Move along ${a.axis.toUpperCase()} — the layer's own axis, unprojected by the server</title></circle>`);
    }
    if (s.anchor) {
      /* The rotation ring is offered on 2D layers only: there the screen angle
       * IS transform.rotation (the affine the server drew this overlay with),
       * while a 3D layer's three axes need three rings and a camera-relative
       * mapping this build refuses to fake. Rotate 3D layers on the timeline
       * rows or over MCP. */
      if (!s.threeD) {
        parts.push(`<circle class="vfxgzring" data-gz="rot" cx="${s.anchor[0]}" cy="${s.anchor[1]}" r="${34 * k}">
          <title>Rotate — drag around the anchor</title></circle>`);
      }
      parts.push(`<circle class="vfxgzanchor" data-gz="body" cx="${s.anchor[0]}" cy="${s.anchor[1]}" r="${4.5 * k}">
        <title>${esc(s.name)} — drag to move${s.threeD && d.hasCamera ? " in the view plane" : ""}</title></circle>`);
    }
    sel = `<g id="vfxGzSel">${parts.join("")}</g>`;
  }

  svg.innerHTML = `${polys(d.cameras || [], "vfxgzcam")}${polys(d.lights || [], "vfxgzlight")}${sel}`;
  wireGizmo(s);
}

function wireGizmo(s) {
  const svg = $("vfxGizmo");
  if (!svg) return;
  const at = (e) => {
    const b = $("vfxFrame").getBoundingClientRect();
    return [
      (e.clientX - b.left) / (b.width || 1) * V.comp.width,
      (e.clientY - b.top) / (b.height || 1) * V.comp.height,
    ];
  };
  let drag = null;

  /** One throttled write: unproject what has accumulated, write it through the
   *  same actions the timeline uses, re-anchor the accumulator. */
  const commit = async (final = false) => {
    if (!drag || drag.busy) return;
    const dx = drag.cur[0] - drag.base[0], dy = drag.cur[1] - drag.base[1];
    if (!final && Math.hypot(dx, dy) < 0.5 * (V.comp.width / Math.max(1, $("vfxFrame").getBoundingClientRect().width))) return;
    drag.busy = true;
    try {
      const l = layerOf(drag.lid);
      if (!l) return;
      if (drag.kind === "rot") {
        const a0 = Math.atan2(drag.base[1] - drag.anchor[1], drag.base[0] - drag.anchor[0]);
        const a1 = Math.atan2(drag.cur[1] - drag.anchor[1], drag.cur[0] - drag.anchor[0]);
        const deg = (a1 - a0) * 180 / Math.PI;
        if (Math.abs(deg) < 0.05) return;
        const prop = propAt(l, "transform.rotation");
        const now = num(evalProp(prop, V.t), 0) + deg;
        await writeGizmoValue(l, "transform.rotation", Math.round(now * 100) / 100, isAnim(prop));
        drag.base = drag.cur;
      } else {
        const r = await api({
          action: "view_unproject", slug: V.slug, t: V.t,
          layerId: drag.lid, view: V.view || undefined,
          drag: drag.kind === "body" ? "plane" : "axis",
          axis: drag.axis, from: drag.base, to: drag.cur,
        });
        const prop = propAt(l, "transform.position");
        await writeGizmoValue(l, "transform.position", r.newPosition, isAnim(prop));
        drag.base = drag.cur;
      }
    } catch (e) {
      note(e.message || "That drag could not be unprojected.");
      drag.dead = true;
    } finally {
      if (drag) drag.busy = false;
    }
  };

  svg.onpointerdown = (e) => {
    const el = e.target.closest("[data-gz]");
    if (!el || !s) return;
    const l = layerOf(s.id);
    if (!l) return;
    if (l.locked) return note("That layer is locked.");
    e.preventDefault();
    e.stopPropagation();                    // not a scrub on the well underneath
    const kind = el.dataset.gz.startsWith("axis:") ? "axis" : el.dataset.gz;
    drag = {
      lid: s.id, kind,
      axis: kind === "axis" ? el.dataset.gz.slice(5) : undefined,
      base: at(e), cur: at(e), anchor: s.anchor || [0, 0],
      /* Snap bookkeeping. `base`/`cur` re-anchor on every throttled commit, so
       * they cannot say where the gesture STARTED — these two can: the pointer
       * at pointerdown and the anchor's server-projected position then. The
       * accumulated writes always equal (cur - origin), so snapping `cur`
       * against them lands the anchor's projection exactly on the target. */
      origin: at(e), anchor0: s.anchor || null,
      timer: setInterval(() => commit(false), 250),
    };
    const onMove = (ev) => { if (drag && !drag.dead) drag.cur = gizmoSnap(drag, at(ev), ev); };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!drag) return;
      clearInterval(drag.timer);
      // Flush whatever the throttle had not written yet, then let go.
      const d = drag;
      while (d.busy) await new Promise((r) => setTimeout(r, 30));
      if (!d.dead) { await commit(true); while (d.busy) await new Promise((r) => setTimeout(r, 30)); }
      drag = null;
      if (V.snapHit) { V.snapHit = null; paintGuides(); }   // the flash ends with the gesture
      queueFrame();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
}

/** A gizmo write is an ordinary property write: a constant moves, an animated
 *  property gets a key at the playhead — exactly what the stopwatch rules say,
 *  so undo, history labels and MCP all see the same edit. */
function writeGizmoValue(l, path, v, animated) {
  return mutate(
    animated
      ? { action: "add_key", slug: V.slug, layerId: l.id, path, t: V.t, v }
      : { action: "set_prop", slug: V.slug, layerId: l.id, path, value: v },
    { coalesce: `gz:${l.id}:${path}`, label: `drag ${l.name || l.id}` },
  );
}

/* ── rulers, guides, grid, safe zones — the workspace furniture ──────────────
 *
 * All of it is drawn CLIENT-SIDE in comp-raster coordinates, deliberately: the
 * frame the viewer shows is a W×H comp raster whatever view rendered it, so a
 * ruler tick at x=960 is the raster's own column 960 in the Front view and in
 * a 35° orbit alike. That is what makes the rulers honest in custom 3D views —
 * they measure the IMAGE, which is view-independent — and it is why none of
 * this needs viewport.py: there is no projection to ask the engine about.
 *
 * The guides ARRAY is document state (see V.ws's comment for the whole split);
 * every switch here is view state. Guides write through the set_guides action
 * via mutate(), so a ruler drag is an ordinary history entry and identical to
 * the MCP tool's write.
 */

const RULER_W = 18;          // the gutter the rulers live in, CSS px
const SNAP_TOL_PX = 6;       // how close a drag must come, SCREEN px
const WS_KEY = "vfx.workspace";

function loadWs() {
  try {
    const saved = JSON.parse(localStorage.getItem(WS_KEY));
    if (saved && typeof saved === "object") Object.assign(V.ws, saved);
  } catch { /* private mode, or nothing saved yet */ }
}
function saveWs() {
  try { localStorage.setItem(WS_KEY, JSON.stringify(V.ws)); } catch { /* private mode */ }
}

/** Pointer event -> comp-raster pixels, off the frame's measured rectangle. */
function compPointOf(ev) {
  const b = $("vfxFrame").getBoundingClientRect();
  return [
    (ev.clientX - b.left) / (b.width || 1) * V.comp.width,
    (ev.clientY - b.top) / (b.height || 1) * V.comp.height,
  ];
}

const round2 = (v) => Math.round(v * 100) / 100;

function paintWorkspace() {
  paintRulers();
  paintGuides();
}

/* ── the rulers ── */

function sizeCanvas(cv, wCss, hCss, dpr) {
  cv.style.width = `${wCss}px`;
  cv.style.height = `${hCss}px`;
  const w = Math.max(1, Math.round(wCss * dpr)), h = Math.max(1, Math.round(hCss * dpr));
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
}

function paintRulers() {
  const top = $("vfxRulerTop"), left = $("vfxRulerLeft"), corner = $("vfxRulerCorner");
  const box = $("vfxCheck"), img = $("vfxFrame");
  if (!top || !left || !corner) return;
  const on = !!(V.ws.rulers && V.comp && img && !img.hidden);
  top.hidden = left.hidden = corner.hidden = !on;
  if (!on) return;
  const br = box.getBoundingClientRect(), ir = img.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  sizeCanvas(top, br.width, RULER_W, dpr);
  sizeCanvas(left, RULER_W, br.height, dpr);
  drawRuler(top, "x", ir.left - br.left, ir.width / V.comp.width, V.comp.width, dpr);
  drawRuler(left, "y", ir.top - br.top, ir.height / V.comp.height, V.comp.height, dpr);
}

/**
 * One ruler. `origin` is where comp 0 sits along the canvas in CSS px,
 * `pxPerUnit` how long one comp pixel is on screen — both measured off the
 * frame's own rectangle, so the ticks agree with the picture at any letterbox
 * and any panel size the viewer can reach. Values run past the picture into
 * the letterbox (negative to the left/top), which is what makes the ruler a
 * measuring tool rather than a decoration.
 */
function drawRuler(cv, axis, origin, pxPerUnit, span, dpr) {
  const ctx = cv.getContext("2d");
  if (!ctx || !(pxPerUnit > 0)) return;
  const L = (axis === "x" ? cv.width : cv.height) / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
  ctx.fillStyle = "hsl(0, 0%, 13%)";
  ctx.fillRect(0, 0, cv.width / dpr, cv.height / dpr);
  // The comp's own extent, shaded, so the raster reads against the letterbox.
  ctx.fillStyle = "hsla(0, 0%, 100%, .06)";
  if (axis === "x") ctx.fillRect(origin, 0, span * pxPerUnit, RULER_W);
  else ctx.fillRect(0, origin, RULER_W, span * pxPerUnit);

  // Tick spacing: the smallest round comp-pixel step that keeps labels apart.
  const STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const step = STEPS.find((s) => s * pxPerUnit >= 46) || 5000;
  const minor = step / 5;
  const vMin = -origin / pxPerUnit, vMax = (L - origin) / pxPerUnit;
  ctx.strokeStyle = "hsla(0, 0%, 100%, .35)";
  ctx.fillStyle = "hsla(0, 0%, 100%, .6)";
  ctx.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let v = Math.ceil(vMin / minor) * minor; v <= vMax; v += minor) {
    const t = Math.round(origin + v * pxPerUnit) + 0.5;
    const isMajor = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    const len = isMajor ? 7 : 4;
    if (axis === "x") { ctx.moveTo(t, RULER_W); ctx.lineTo(t, RULER_W - len); }
    else { ctx.moveTo(RULER_W, t); ctx.lineTo(RULER_W - len, t); }
    if (isMajor) {
      if (axis === "x") ctx.fillText(String(Math.round(v)), t + 3, 9);
      else {
        // Rotated so the left ruler's labels read along the ruler, as in AE.
        ctx.save(); ctx.translate(9, t - 3); ctx.rotate(-Math.PI / 2);
        ctx.fillText(String(Math.round(v)), 0, 0); ctx.restore();
      }
    }
  }
  ctx.stroke();
}

/* ── the guides / grid / safe-zone overlay ── */

function paintGuides() {
  const svg = $("vfxGuides"), img = $("vfxFrame");
  if (!svg) return;
  const anything = V.ws.guides || V.ws.grid || V.ws.safe || V.guideDraft || V.snapHit;
  if (!V.comp || !img || img.hidden || !anything) { svg.toggleAttribute("hidden", true); return; }
  svg.toggleAttribute("hidden", false);
  svg.classList.toggle("locked", !!V.ws.lock);
  const W = V.comp.width, H = V.comp.height;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const ir = img.getBoundingClientRect(), br = $("vfxCheck").getBoundingClientRect();
  svg.style.left = `${ir.left - br.left}px`;
  svg.style.top = `${ir.top - br.top}px`;
  svg.style.width = `${ir.width}px`;
  svg.style.height = `${ir.height}px`;
  const k = W / Math.max(1, ir.width);        // one screen px, in comp units

  let out = "";
  if (V.ws.grid) out += gridMarkup(W, H, k);
  if (V.ws.safe) out += safeMarkup(W, H);
  if (V.ws.guides) {
    out += (V.comp.guides || []).map((g, i) =>
      (V.guideDraft && V.guideDraft.hideIndex === i) ? "" : guideMarkup(g, i, W, H, k)).join("");
  }
  if (V.guideDraft) {
    const d = V.guideDraft;
    out += d.axis === "x"
      ? `<line class="vfxguide draft" x1="${d.position}" y1="0" x2="${d.position}" y2="${H}"></line>`
      : `<line class="vfxguide draft" x1="0" y1="${d.position}" x2="${W}" y2="${d.position}"></line>`;
  }
  if (V.snapHit) {
    if (V.snapHit.x != null) out += `<line class="vfxsnapflash" x1="${V.snapHit.x}" y1="0" x2="${V.snapHit.x}" y2="${H}"></line>`;
    if (V.snapHit.y != null) out += `<line class="vfxsnapflash" x1="0" y1="${V.snapHit.y}" x2="${W}" y2="${V.snapHit.y}"></line>`;
  }
  svg.innerHTML = out;
  svg.onpointerdown = guidePointerDown;
}

function gridMarkup(W, H, k) {
  const size = clamp(num(V.ws.gridSize, 100), 4, 4096);
  const divs = clamp(Math.round(num(V.ws.gridDivs, 4)), 1, 12);
  const sub = size / divs;
  let majors = "", minors = "";
  // Below ~5 screen px a line set is solid ink, not a grid — leave that tier out.
  const drawMinor = divs > 1 && sub / k >= 5;
  const drawMajor = size / k >= 5;
  const stepAxis = (span, line) => {
    for (let v = 0; v <= span + 1e-6; v += sub) {
      const isMajor = Math.abs(v / size - Math.round(v / size)) < 1e-6;
      if (isMajor ? !drawMajor : !drawMinor) continue;
      if (isMajor) majors += line(v); else minors += line(v);
    }
  };
  stepAxis(W, (x) => `M ${x} 0 L ${x} ${H} `);
  stepAxis(H, (y) => `M 0 ${y} L ${W} ${y} `);
  return `<path class="vfxgridminor" d="${minors}"></path><path class="vfxgridmajor" d="${majors}"></path>`;
}

/** The broadcast 90% action-safe and 80% title-safe rectangles + centre cross.
 *  Pure comp arithmetic — no server round-trip, nothing to fetch. */
function safeMarkup(W, H) {
  const rect = (f) =>
    `<rect class="vfxsafe" x="${W * (1 - f) / 2}" y="${H * (1 - f) / 2}" width="${W * f}" height="${H * f}"></rect>`;
  const arm = Math.min(W, H) * 0.03;
  const cross = `<line class="vfxsafe" x1="${W / 2 - arm}" y1="${H / 2}" x2="${W / 2 + arm}" y2="${H / 2}"></line>`
    + `<line class="vfxsafe" x1="${W / 2}" y1="${H / 2 - arm}" x2="${W / 2}" y2="${H / 2 + arm}"></line>`;
  return rect(0.9) + rect(0.8) + cross;
}

function guideMarkup(g, i, W, H, k) {
  const p = g.position;
  const line = g.axis === "x"
    ? (cls, w) => `<line class="${cls}"${w ? ` stroke-width="${w}"` : ""} x1="${p}" y1="0" x2="${p}" y2="${H}"></line>`
    : (cls, w) => `<line class="${cls}"${w ? ` stroke-width="${w}"` : ""} x1="0" y1="${p}" x2="${W}" y2="${p}"></line>`;
  /* The visible hairline plus a fat transparent twin to grab — a 1px target is
   * not a target. The group carries the cursor and the hit test. */
  return `<g data-guide="${i}" class="${g.axis === "x" ? "gx" : "gy"}">
    ${line("vfxguide")}${line("vfxguidehit", 9 * k)}
    <title>Guide ${g.axis} = ${p} — drag to move, drop on the ruler to delete${V.ws.lock ? " (locked)" : ""}</title></g>`;
}

/* ── ruler and guide gestures ── */

function wireRulers() {
  for (const [id, axis] of [["vfxRulerTop", "y"], ["vfxRulerLeft", "x"]]) {
    const el = $(id);
    if (!el) continue;
    // Top ruler pulls DOWN a horizontal guide, left ruler pulls a vertical one
    // — the Photoshop/AE gesture, and the axis names follow the guide drawn.
    el.addEventListener("pointerdown", (e) => beginGuideCreate(e, axis));
    el.addEventListener("dblclick", () => exactGuideDialog(axis));
  }
}

function beginGuideCreate(e, axis) {
  if (!V.comp) return;
  e.preventDefault();
  const posOf = (ev) => { const p = compPointOf(ev); return axis === "x" ? p[0] : p[1]; };
  const max = () => (axis === "x" ? V.comp.width : V.comp.height);
  const move = (ev) => {
    V.guideDraft = { axis, position: round2(posOf(ev)) };
    paintGuides();
  };
  const up = async (ev) => {
    window.removeEventListener("pointermove", move);
    const pos = posOf(ev);
    V.guideDraft = null;
    /* Released back over the ruler or outside the raster: no guide. This also
     * makes a plain CLICK on the ruler a no-op — at pointerdown the pointer is
     * still outside the picture, so pos is out of range. */
    if (!(pos >= 0 && pos <= max())) return void paintGuides();
    await saveGuides([...(V.comp.guides || []), { axis, position: round2(pos) }], "add a guide");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

function exactGuideDialog(axis) {
  if (!V.comp) return;
  const max = axis === "x" ? V.comp.width : V.comp.height;
  const raw = prompt(
    `New ${axis === "x" ? "vertical" : "horizontal"} guide — ${axis} in comp pixels (0-${max})`,
    String(Math.round(max / 2)));
  if (raw == null || !raw.trim()) return;
  const pos = Number(raw);
  if (!Number.isFinite(pos) || pos < 0 || pos > max) {
    return note(`A guide sits on the comp raster: 0-${max}.`);
  }
  saveGuides([...(V.comp.guides || []), { axis, position: round2(pos) }], "add a guide");
}

function guidePointerDown(e) {
  const el = e.target.closest("[data-guide]");
  if (!el || !V.comp) return;
  e.preventDefault();
  e.stopPropagation();                       // not a scrub on the well underneath
  const i = +el.dataset.guide;
  const g = (V.comp.guides || [])[i];
  if (!g) return;
  const posOf = (ev) => { const p = compPointOf(ev); return g.axis === "x" ? p[0] : p[1]; };
  const max = g.axis === "x" ? V.comp.width : V.comp.height;
  const move = (ev) => {
    V.guideDraft = { axis: g.axis, position: round2(posOf(ev)), hideIndex: i };
    paintGuides();
  };
  const up = async (ev) => {
    window.removeEventListener("pointermove", move);
    const pos = posOf(ev);
    const moved = !!V.guideDraft;
    V.guideDraft = null;
    if (!moved || Math.abs(pos - g.position) < 0.005) return void paintGuides();  // a click, not a move
    const next = (V.comp.guides || []).map((x) => ({ ...x }));
    if (pos >= 0 && pos <= max) {
      next[i] = { axis: g.axis, position: round2(pos) };
      await saveGuides(next, "move a guide");
    } else {
      next.splice(i, 1);                     // dragged back onto the ruler — the delete gesture
      await saveGuides(next, "delete a guide");
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

/** One write, through the same funnel as every other edit — so a ruler drag
 *  is a history entry, an undo target and exactly the MCP tool's write. */
function saveGuides(guides, label) {
  return mutate({ action: "set_guides", slug: V.slug, guides }, { label });
}

/* ── snapping, on the gizmo's body drag ──
 *
 * Screen-space against the overlay geometry, deliberately: the anchor position
 * the server projected (s.anchor, comp-raster px) is offset by the raw pointer
 * delta and compared against guides/grid/centre/edges in the same raster
 * coordinates. In a 3D view that means the snap lands the anchor's PROJECTION
 * on the guide — the layer's world position is then whatever view_unproject
 * says reproduces that screen point, which is the honest behaviour: a guide is
 * a line on the image, so "on the guide" can only mean "projects onto it".
 * Axis drags are left unsnapped — they are constrained to one projected axis,
 * and pulling their 2D anchor onto a guide would fight the constraint.
 */

function nearestSnap(v, axis, tol) {
  const max = axis === "x" ? V.comp.width : V.comp.height;
  const targets = [0, max / 2, max];                          // comp edges + centre, always
  if (V.ws.guides) {
    for (const g of V.comp.guides || []) if (g.axis === axis) targets.push(g.position);
  }
  if (V.ws.grid) {
    const size = clamp(num(V.ws.gridSize, 100), 4, 4096);
    const sub = size / clamp(Math.round(num(V.ws.gridDivs, 4)), 1, 12);
    targets.push(Math.round(v / sub) * sub);                  // the nearest grid line
  }
  let best = null, bestD = tol;
  for (const t of targets) {
    const d = Math.abs(v - t);
    if (d <= bestD) { best = t; bestD = d; }
  }
  return best;
}

/** Adjust a body drag's `cur` so the anchor's projection lands on the nearest
 *  snap target within ~6 SCREEN px. Ctrl passes through unsnapped, as in AE. */
function gizmoSnap(drag, raw, ev) {
  const img = $("vfxFrame");
  if (drag.kind !== "body" || !V.ws.snap || ev.ctrlKey || !drag.anchor0 || !img) {
    if (V.snapHit) { V.snapHit = null; paintGuides(); }
    return raw;
  }
  const tol = SNAP_TOL_PX * (V.comp.width / Math.max(1, img.getBoundingClientRect().width));
  const ax = drag.anchor0[0] + (raw[0] - drag.origin[0]);
  const ay = drag.anchor0[1] + (raw[1] - drag.origin[1]);
  const sx = nearestSnap(ax, "x", tol);
  const sy = nearestSnap(ay, "y", tol);
  const key = `${sx ?? ""}|${sy ?? ""}`;
  if ((V.snapHit?.key ?? "|") !== key) {
    V.snapHit = (sx == null && sy == null) ? null : { key, x: sx, y: sy };
    paintGuides();                                            // the snap flash
  }
  return [raw[0] + (sx == null ? 0 : sx - ax), raw[1] + (sy == null ? 0 : sy - ay)];
}

/* ── the Info readout — RGBA under the cursor, off the server's frame ─────── */

function wireInfo() {
  const well = $("vfxWell"), box = $("vfxInfo");
  if (!well || !box || well.dataset.info) return;
  well.dataset.info = "1";
  let last = 0, busy = false;
  well.addEventListener("pointermove", async (e) => {
    if (!V.info || !V.comp || V.playing || V.scrubbing) { box.hidden = true; return; }
    const img = $("vfxFrame");
    if (!img || img.hidden) return;
    const b = img.getBoundingClientRect();
    const x = (e.clientX - b.left) / (b.width || 1) * V.comp.width;
    const y = (e.clientY - b.top) / (b.height || 1) * V.comp.height;
    if (x < 0 || y < 0 || x > V.comp.width || y > V.comp.height) { box.hidden = true; return; }
    const now = performance.now();
    if (busy || now - last < 200) return;
    busy = true; last = now;
    try {
      /* Probed at the SETTLED quality — full scale, no draft — which is the
       * frame the idle viewer is showing, so this is a cache hit, not a render. */
      const r = await api({
        action: "probe_pixel", slug: V.slug, t: V.t,
        x: Math.round(x), y: Math.round(y), scale: 1, draft: false,
        view: V.view || undefined,
      });
      const [rr, g, bb, a] = r.rgba;
      const hex = `#${[rr, g, bb].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      box.innerHTML = `<i style="background:rgba(${rr},${g},${bb},${a / 255})"></i>`
        + `${Math.round(x)}, ${Math.round(y)} · R ${rr} G ${g} B ${bb} A ${a} · ${hex}`;
      box.hidden = false;
    } catch { /* a mid-edit probe can miss; the next move asks again */ }
    finally { busy = false; }
  });
  well.addEventListener("pointerleave", () => { box.hidden = true; });
}

/** The badge over the picture. Only ever shown when the preview is NOT the
 *  render — a badge that is always there is a badge nobody reads. */
function paintQualityBadge(scale, draft) {
  const el = $("vfxQual");
  if (!el) return;
  if (scale >= 1 && !draft) { el.hidden = true; return; }
  const seen = previewFps();
  el.hidden = false;
  el.textContent = `preview ${Math.round(scale * 100)}%${draft ? " · draft" : ""}${seen ? ` · ${seen.toFixed(1)} fps` : ""}`;
  el.title = "This is not what a render makes. Draft skips motion blur and the expensive effect paths; "
    + "a reduced scale renders fewer pixels. Stop and the viewer settles back to full quality.";
}

/* ─────────────────────────────────────────────────────────── wiring: panels */

function wireProps() {
  const l = selected();
  if (!l) return;

  for (const el of $("vfxPropsBody").querySelectorAll("[data-lset]")) {
    el.onchange = () => {
      const k = el.dataset.lset;
      const v = el.type === "checkbox" ? el.checked : num(el.value);
      mutate({ action: "set_layer", slug: V.slug, layerId: l.id, [k]: v }, { coalesce: `lset:${l.id}:${k}` });
    };
  }
  for (const el of $("vfxPropsBody").querySelectorAll("[data-tset]")) {
    el.onchange = () => mutate({
      action: "set_layer", slug: V.slug, layerId: l.id,
      text: { [el.dataset.tset]: el.type === "number" ? num(el.value) : el.value },
    });
  }
  const solidRgba = $("vfxPropsBody").querySelector('[data-rgba="lcolor"]');
  if (solidRgba) {
    for (const inp of solidRgba.querySelectorAll("input")) {
      inp.onchange = () => mutate({
        action: "set_layer", slug: V.slug, layerId: l.id,
        color: [...solidRgba.querySelectorAll("input")].map((x) => clamp(num(x.value), 0, 255)),
      });
    }
  }

  /* Effects. */
  const q = (sel) => $("vfxPropsBody").querySelectorAll(sel);
  for (const b of q("[data-fxopen]")) b.onclick = () => {
    const id = b.dataset.fxopen;
    V.fxOpen.has(id) ? V.fxOpen.delete(id) : V.fxOpen.add(id);
    paintProps();
  };
  for (const b of q("[data-fxen]")) b.onchange = () =>
    mutate({ action: "set_effect", slug: V.slug, layerId: l.id, fxId: b.dataset.fxen, enabled: b.checked });
  for (const b of q("[data-fxdel]")) b.onclick = () =>
    mutate({ action: "remove_effect", slug: V.slug, layerId: l.id, fxId: b.dataset.fxdel });
  for (const b of q("[data-fxup]")) b.onclick = () => reorderFx(l, b.dataset.fxup, -1);
  for (const b of q("[data-fxdn]")) b.onclick = () => reorderFx(l, b.dataset.fxdn, +1);
  for (const el of q("[data-fxset]")) {
    el.onchange = () => {
      const fxId = el.dataset.fxset, name = el.dataset.pname;
      let v;
      if (el.type === "checkbox") v = el.checked;
      else if (el.dataset.json) { try { v = JSON.parse(el.value); } catch { note("That is not valid JSON."); return; } }
      else if (el.dataset.ch != null) {
        v = [...q(`[data-fxset="${CSS.escape(fxId)}"][data-pname="${CSS.escape(name)}"]`)].map((x) => num(x.value));
      } else v = el.type === "number" ? num(el.value) : el.value;
      mutate({ action: "set_effect", slug: V.slug, layerId: l.id, fxId, params: { [name]: v } },
        { coalesce: `fx:${l.id}:${fxId}:${name}` });
    };
  }
  for (const box of q("[data-fxrgba]")) {
    for (const inp of box.querySelectorAll("input")) {
      inp.onchange = () => mutate({
        action: "set_effect", slug: V.slug, layerId: l.id, fxId: box.dataset.fxrgba,
        params: { [box.dataset.pname]: [...box.querySelectorAll("input")].map((x) => clamp(num(x.value), 0, 255)) },
      });
    }
  }
  const addFx = $("vfxAddFx");
  if (addFx) addFx.onclick = () => effectPicker(l);
  const fxPresets = $("vfxFxPresets");
  if (fxPresets) fxPresets.onclick = () => fxPresetSheet(l);

  /* Masks and matte. */
  for (const s of q("[data-maskmode]")) s.onchange = () =>
    mutate({ action: "set_mask", slug: V.slug, layerId: l.id, maskId: s.dataset.maskmode, mode: s.value });
  for (const c of q("[data-maskinv]")) c.onchange = () =>
    mutate({ action: "set_mask", slug: V.slug, layerId: l.id, maskId: c.dataset.maskinv, invert: c.checked });
  for (const b of q("[data-maskdel]")) b.onclick = () =>
    mutate({ action: "remove_mask", slug: V.slug, layerId: l.id, maskId: b.dataset.maskdel });
  const addMask = $("vfxAddMask");
  if (addMask) addMask.onclick = () => {
    const w = V.comp.width, h = V.comp.height, ix = w * 0.2, iy = h * 0.2;
    mutate({
      action: "add_mask", slug: V.slug, layerId: l.id, mode: "add", feather: 8, opacity: 100,
      points: [[ix, iy], [w - ix, iy], [w - ix, h - iy], [ix, h - iy]],
    });
  };
  const matte = $("vfxMatte");
  if (matte) matte.onchange = () => mutate({
    action: "set_matte", slug: V.slug, layerId: l.id,
    trackMatte: matte.value ? { type: matte.value } : null,
  });

  wireShapes(l, q);
  wireSpatial(l, q);
  wireDrive(l);
}

/* ── expressions ─────────────────────────────────────────────────────────── */

function wireExprSheet(l, path, ex, close) {
  const box = $("vfxExprText");
  if (!box) return;
  box.focus();
  for (const c of $("vfxOverlay").querySelectorAll("[data-chip]")) c.onclick = () => {
    /* Paste at the cursor rather than replacing: an expression is usually built
     * out of two or three of these with arithmetic between them. */
    const s = box.selectionStart ?? box.value.length, e = box.selectionEnd ?? s;
    box.value = box.value.slice(0, s) + c.dataset.chip + box.value.slice(e);
    box.focus();
    box.selectionStart = box.selectionEnd = s + c.dataset.chip.length;
  };
  const send = (expr) => {
    close();
    mutate({ action: "set_prop", slug: V.slug, layerId: l.id, path, expr });
  };
  const cancel = () => close();
  $("vfxExprOk").onclick = () => send(box.value.trim());
  $("vfxExprCancel").onclick = cancel;
  const off = $("vfxExprOff");
  // null, not "" — both clear it, and null is what §7 documents.
  if (off) off.onclick = () => send(null);
  box.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(box.value.trim()); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
}

/* ── shape items ─────────────────────────────────────────────────────────── */

/** Every shape edit is a whole-array write, because `shapes` has no finer
 *  action — and the array IS the program, so replacing it is the honest unit. */
function writeShapes(l, items, coalesce = null) {
  return setLayerField(l, { shapes: items }, coalesce);
}

function wireShapes(l, q) {
  const items = shapeItems(l);
  for (const b of q("[data-siopen]")) b.onclick = () => {
    const key = `${l.id}:${b.dataset.siopen}`;
    V.itemOpen.has(key) ? V.itemOpen.delete(key) : V.itemOpen.add(key);
    paintProps();
  };
  for (const b of q("[data-siup]")) b.onclick = () => moveShape(l, +b.dataset.siup, -1);
  for (const b of q("[data-sidn]")) b.onclick = () => moveShape(l, +b.dataset.sidn, +1);
  for (const b of q("[data-sidel]")) b.onclick = () => {
    const next = items.filter((_, i) => i !== +b.dataset.sidel);
    V.itemOpen.clear();
    writeShapes(l, next);
  };
  for (const c of q("[data-sien]")) c.onchange = () =>
    writeShapes(l, items.map((it, i) => (i === +c.dataset.sien ? { ...it, enabled: c.checked } : it)));

  const set = (i, name, v) =>
    writeShapes(l, items.map((it, k) => (k === i ? { ...it, [name]: v } : it)), `si:${l.id}:${i}:${name}`);
  for (const el of q("[data-siset]")) {
    el.onchange = () => {
      const i = +el.dataset.siset, name = el.dataset.pname;
      let v;
      if (el.type === "checkbox") v = el.checked;
      else if (el.dataset.json) { try { v = JSON.parse(el.value); } catch { return note("That is not valid JSON."); } }
      else if (el.dataset.ch != null) {
        v = [...q(`[data-siset="${i}"][data-pname="${CSS.escape(name)}"]`)].map((x) => num(x.value));
      } else v = el.type === "number" ? num(el.value) : el.value;
      set(i, name, v);
    };
  }
  for (const box of q("[data-sirgba]")) {
    for (const inp of box.querySelectorAll("input")) {
      inp.onchange = () => set(+box.dataset.sirgba, box.dataset.pname,
        [...box.querySelectorAll("input")].map((x) => clamp(num(x.value), 0, 255)));
    }
  }
  const sort = $("vfxShapeSort");
  /* A STABLE sort by phase: items already in the right order keep the order
   * they had, so putting a stack right never also reshuffles two paths or two
   * paints, where the order is a real choice about what covers what. */
  if (sort) sort.onclick = () => writeShapes(l, items
    .map((it, i) => [it, i])
    .sort((a, b2) => (shapeRank(a[0]) - shapeRank(b2[0])) || (a[1] - b2[1]))
    .map(([it]) => it));
  const add = $("vfxAddShape");
  if (add) add.onclick = () => shapePicker(l);
}

function moveShape(l, i, delta) {
  const items = shapeItems(l).slice();
  const to = clamp(i + delta, 0, items.length - 1);
  if (to === i) return;
  const [it] = items.splice(i, 1);
  items.splice(to, 0, it);
  V.itemOpen.clear();
  writeShapes(l, items);
}

/* ── 3D, camera, nested comp ─────────────────────────────────────────────── */

function wireSpatial(l, q) {
  const three = $("vfxThreeD");
  if (three) three.onchange = () => setLayerField(l, { threeD: three.checked });
  const autoOr = $("vfxAutoOrient");
  if (autoOr) autoOr.onchange = () => setLayerField(l, { autoOrient: autoOr.value });
  for (const el of q("[data-l3]")) {
    el.onchange = () => mutate({
      action: "set_layer", slug: V.slug, layerId: l.id,
      transform: { [el.dataset.l3]: num(el.value) },
    }, {
      context: (msg) => (/No transform property/.test(msg)
        ? `${msg} The engine composes Rx·Ry·Rz out of exactly those three, and the store drops any `
          + `transform key not on that list on every read — so a 3D turn cannot be stored yet.`
        : msg),
    });
  }
  for (const el of q("[data-cam]")) {
    el.onchange = () => setLayerField(l, {
      camera: { ...(l.camera || {}), [el.dataset.cam]: el.type === "checkbox" ? el.checked : num(el.value) },
    });
  }
  const nested = $("vfxNested");
  if (nested) nested.onchange = () => mutate({
    action: "set_layer", slug: V.slug, layerId: l.id, src: nested.value || null,
  }, {
    context: (msg) => (/no source file/i.test(msg)
      ? `${msg} A comp layer's source IS the child comp's slug — that is how the engine finds it — `
        + `but set_layer only lets an image or a video carry one.`
      : msg),
  });
  const collapse = $("vfxCollapse");
  if (collapse) collapse.onchange = () => setLayerField(l, { collapse: collapse.checked });
  const open = $("vfxOpenNested");
  if (open) open.onclick = async () => {
    V.slug = l.src; V.sel = null; V.msel.clear(); V.t = 0; V.outT = null;
    /* A different comp is a different document, and twirl state is keyed on
     * layer ids that no longer exist there. `props` goes with it for the same
     * reason — a cached property list belongs to one layer of one comp. */
    V.open.clear(); V.gopen.clear(); V.fxOpen.clear(); V.itemOpen.clear();
    V.props.clear(); V.propsPending.clear();
    await loadComp();
    paint();
  };
}

function wireDrive(l) {
  const a = $("vfxAudioKeys");
  if (a) a.onclick = async () => { await propRowsFor(l.id); audioPanel(l); };
  const m = $("vfxTrackMotion");
  if (m) m.onclick = async () => { await propRowsFor(l.id); trackPanel(l); };
}

function reorderFx(l, fxId, delta) {
  const i = (l.effects || []).findIndex((e) => e.id === fxId);
  const to = clamp(i + delta, 0, (l.effects || []).length - 1);
  if (i < 0 || to === i) return;
  mutate({ action: "reorder_effect", slug: V.slug, layerId: l.id, fxId, toIndex: to });
}

/* ────────────────────────────────────── wiring: the property tree writes
 *
 * FOUR ACTIONS, EVERY PATH VERBATIM. A transform, an effect parameter, a mask
 * feather and a shape item's trim end all leave this file as the same three
 * calls — `set_prop`, `add_key`, `remove_key` — carrying the path the
 * enumerator answered with and nothing else. There is no per-kind routing here
 * on purpose: the moment one property kind gets its own spelling on the way
 * out, the tree and MCP are writing two different documents.
 */

/** The layer and path behind a `layerId|path` handle, or null if the document
 *  has moved on under it — which an undo does routinely. */
function treeRef(handle) {
  const [lid, ...rest] = String(handle).split("|");
  const l = layerOf(lid);
  return l ? { l, path: rest.join("|") } : null;
}

/** What a row is worth right now, for a write that has to preserve it: the
 *  document at the playhead, then the enumerator's t=0, then the registry. */
function treeValue(l, path) {
  const rows = V.props.get(l.id)?.rows || [];
  const p = rows.find((r) => r.path === path);
  return p ? rowValue(l, p) : evalProp(propAt(l, path), V.t);
}

/**
 * The stopwatch. Off → on writes a key at the playhead holding what the
 * property is worth THERE, so the picture does not jump the instant it becomes
 * animated. On → off pins it at the same value, which is what you can see
 * rather than what the first key happens to hold.
 *
 * `v` is always sent. The route can fall back to the constant or to the
 * catalog default, but `transform.rotationX` on a fresh 3D layer has neither —
 * it is undefined in the document and the registry does not name it — and a
 * stopwatch that refuses on one row and works on the next is worse than one
 * that is simply explicit.
 */
function treeStopwatch(handle) {
  const r = treeRef(handle);
  if (!r) return;
  const { l, path } = r;
  const prop = propAt(l, path);
  if (isAnim(prop)) return void mutate({ action: "set_prop", slug: V.slug, layerId: l.id, path, value: evalProp(prop, V.t) });
  return void mutate({ action: "add_key", slug: V.slug, layerId: l.id, path, t: V.t, v: treeValue(l, path), ease: "linear" });
}

/** The ◆ at the right of an animated row: a key here, or no key here. */
function treeKeyAt(handle) {
  const r = treeRef(handle);
  if (!r) return;
  const { l, path } = r;
  const prop = propAt(l, path);
  if (!isAnim(prop)) return note("This property is a constant — press the stopwatch to animate it.");
  const here = keysOf(prop).find((k) => Math.abs(k.t - V.t) < 1e-4);
  if (here) return void mutate({ action: "remove_key", slug: V.slug, layerId: l.id, path, t: here.t });
  return void mutate({ action: "add_key", slug: V.slug, layerId: l.id, path, t: V.t, v: evalProp(prop, V.t), ease: "linear" });
}

/**
 * A number typed into a row.
 *
 * Which action fires is decided by the DOCUMENT, not by a flag here: an
 * animated property takes a keyframe at the playhead, a constant one takes a
 * value. That is the stopwatch, and it has exactly one source.
 *
 * The coalesce key is not decoration. Holding an arrow key on a box fires a
 * `change` per repeat — roughly thirty a second, each one a real write — and
 * forty history entries from one gesture is a history nobody can scan, after
 * which the cap throws away the step somebody actually wanted.
 */
function treeSetValue(inp) {
  const r = treeRef(inp.closest("[data-prop]")?.dataset.prop || "");
  if (!r) return;
  const { l, path } = r;
  const boxes = [...inp.parentElement.querySelectorAll("[data-tv]")];
  const v = boxes.length > 1 ? boxes.map((b) => num(b.value)) : num(boxes[0].value);
  const coalesce = `tv:${l.id}:${path}`;
  if (isAnim(propAt(l, path))) {
    mutate({ action: "add_key", slug: V.slug, layerId: l.id, path, t: V.t, v, ease: "linear" }, { coalesce });
  } else {
    mutate({ action: "set_prop", slug: V.slug, layerId: l.id, path, value: v }, { coalesce, context: xformCtx(v) });
  }
}

/** A list of numbers — a dash pattern, a vertex run. `set_prop` refuses an
 *  empty array outright, so that is said here rather than sent and bounced. */
function treeSetArray(inp) {
  const r = treeRef(inp.closest("[data-prop]")?.dataset.prop || "");
  if (!r) return;
  const { l, path } = r;
  const v = String(inp.value).split(/[,\s]+/).filter(Boolean).map(Number);
  if (!v.length) return note(`${path} takes a list of numbers, and set_prop has no reading for an empty one.`);
  if (v.some((n) => !Number.isFinite(n))) return note("Every entry has to be a number.");
  mutate({ action: "set_prop", slug: V.slug, layerId: l.id, path, value: v }, { coalesce: `tv:${l.id}:${path}` });
}

/** The one refusal worth widening, because the message is true and useless on
 *  its own: a 3D layer's third component is legal in the document and the
 *  engine renders it, and set_prop's arity table is fixed at two. */
const xformCtx = (v) => (msg) => (Array.isArray(v) && v.length === 3 && /takes 2 number/.test(msg)
  ? `${msg} A 3D layer's anchor, position and scale each take a third component and the engine `
    + `renders one, but set_prop's arity table is fixed at two — so a z already in the document `
    + `reads and animates here, and a new one cannot be typed in yet.`
  : msg);

/* ─────────────────────────────────────────── wiring: stack, timeline, keys */

function wireDelegates() {
  const root = $("vfx");

  /* One click handler for the whole tab. Rows are rebuilt on every paint, so
   * per-element listeners would have to be re-attached constantly; delegation
   * survives every repaint and there is only ever one of it. */
  root.addEventListener("click", (e) => {
    const t = e.target;
    const lbl = t.closest("[data-labelpick]");
    if (lbl) return labelMenu(e, lbl.dataset.labelpick);
    const tog = t.closest("[data-tog]");
    if (tog) {
      const l = layerOf(tog.dataset.lid);
      if (!l) return;
      const k = tog.dataset.tog;
      if (k !== "locked" && l.locked) return note("That layer is locked.");
      return void mutate({ action: "set_layer", slug: V.slug, layerId: l.id, [k]: !l[k] });
    }
    const del = t.closest("[data-dellayer]");
    if (del) {
      const l = layerOf(del.dataset.dellayer);
      if (!l) return;
      if (!confirm(`Remove "${l.name || l.id}" from the comp?`)) return;
      return void mutate({ action: "remove_layer", slug: V.slug, layerId: l.id });
    }
    const exp = t.closest("[data-expand]");
    if (exp) {
      const id = exp.dataset.expand;
      if (V.open.has(id)) V.open.delete(id);
      else {
        V.open.add(id);
        /* Twirling a layer open onto nothing teaches nothing, so the group that
         * is the answer four times out of five opens with it. Only on the FIRST
         * twirl — after that the state is whatever was left, per the layer, for
         * as long as the comp is open. */
        const gk = [...V.gopen].some((k) => k.startsWith(`${id}::`));
        if (!gk) for (const g of GROUP_OPEN_BY_DEFAULT) V.gopen.add(gkey(id, g));
      }
      return paintTimeline();
    }
    const gtw = t.closest("[data-gtwirl]");
    if (gtw) {
      const k = gtw.dataset.gtwirl;
      V.gopen.has(k) ? V.gopen.delete(k) : V.gopen.add(k);
      return paintTimeline();
    }
    const al = t.closest("[data-align]");
    if (al) {
      const l = selected();
      if (!l) return;
      if (l.locked) return note("That layer is locked.");
      return void mutate(
        { action: "align_layers", slug: V.slug, layerIds: [l.id], op: al.dataset.align, to: "comp", t: V.t },
        { label: `align ${al.dataset.align}` },
      );
    }
    const watch = t.closest("[data-watch]");
    if (watch) return void treeStopwatch(watch.dataset.watch);
    const keyat = t.closest("[data-keyat]");
    if (keyat) return void treeKeyAt(keyat.dataset.keyat);
    const fxb = t.closest("[data-exprbtn]");
    if (fxb) {
      const [lid, ...rest] = fxb.dataset.exprbtn.split("|");
      return exprSheet(lid, rest.join("|"));
    }
    const gop = t.closest("[data-gopen]");
    if (gop) {
      const [lid, ...rest] = gop.dataset.gopen.split("|");
      const path = rest.join("|");
      if (!isAnim(propAt(layerOf(lid), path))) {
        return note("A curve needs keyframes — press the stopwatch on this row first.");
      }
      V.sel = lid;
      V.ksel.clear();
      openGraph(lid, path);
      paintProps();
      return;
    }
    const row = t.closest("[data-lid]");
    if (row && !t.closest("select")) {
      const lid = row.dataset.lid;
      /* [precomp-multisel] Ctrl-click (⌘ on a Mac) toggles the row in and out
       * of the multi-selection; a plain click is exactly what it always was.
       * The anchor `V.sel` is folded in on the first Ctrl-click so "click A,
       * Ctrl-click B" selects two, the way it does in AE. */
      if (e.ctrlKey || e.metaKey) {
        if (V.sel && !V.msel.size && V.sel !== lid) V.msel.add(V.sel);
        if (V.msel.has(lid)) {
          V.msel.delete(lid);
          if (V.sel === lid) V.sel = [...V.msel][0] ?? null;
        } else {
          V.msel.add(lid);
          V.sel = lid;
        }
        if (V.msel.size === 1) { V.sel = [...V.msel][0]; V.msel.clear(); }
      } else {
        V.msel.clear();
        V.sel = lid;
      }
      /* The motion path and the gizmo belong to the SELECTED layer, so they
       * repaint with the selection and not only when a new frame arrives —
       * selecting a layer does not change the picture, so nothing else would
       * have redrawn them and the previous layer's overlays stayed up. */
      paintTimeline(); paintProps(); paintMotionPath(); paintGizmo();
      return;
    }
    if (t.id === "vfxAddLayer") return addLayerMenu();
  });

  root.addEventListener("dblclick", (e) => {
    const n = e.target.closest("[data-rename]");
    if (n) return renameInline(n);
  });

  root.addEventListener("change", (e) => {
    const tv = e.target.closest("[data-tv]");
    if (tv) return void treeSetValue(tv);
    const ta = e.target.closest("[data-tvarr]");
    if (ta) return void treeSetArray(ta);
    const b = e.target.closest("[data-blend]");
    if (b) return void mutate({ action: "set_layer", slug: V.slug, layerId: b.dataset.blend, blend: b.value });
    const p = e.target.closest("[data-parent]");
    if (p) return void mutate({ action: "set_layer", slug: V.slug, layerId: p.dataset.parent, parent: p.value || null });
  });

  /* Reordering the stack. HTML5 drag gives the row a drag image for free, and a
   * list is the one place that API is pleasant. The index sent is the index in
   * the array AFTER the dragged layer is taken out, which is what `toIndex`
   * means and the only definition that survives dropping below yourself. */
  let dragId = null;
  root.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".vfxlayer");
    if (!row) return;
    dragId = row.dataset.lid;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragId); } catch { /* firefox needs the call, not the value */ }
    row.classList.add("dragging");
  });
  root.addEventListener("dragend", () => {
    dragId = null;
    for (const r of root.querySelectorAll(".vfxlayer")) r.classList.remove("dragging", "over");
  });
  root.addEventListener("dragover", (e) => {
    if (!dragId) return;
    const row = e.target.closest(".vfxlayer");
    if (!row) return;
    e.preventDefault();
    for (const r of root.querySelectorAll(".vfxlayer")) r.classList.remove("over");
    row.classList.add("over");
  });
  root.addEventListener("drop", (e) => {
    if (!dragId) return;
    e.preventDefault();
    const rows = [...root.querySelectorAll(".vfxlayer")];
    let to = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i].getBoundingClientRect();
      if (e.clientY < b.top + b.height / 2) { to = i; break; }
    }
    const from = indexOf(dragId);
    if (to > from) to--;
    const id = dragId;
    dragId = null;
    if (to !== from && from >= 0) mutate({ action: "reorder_layer", slug: V.slug, id, toIndex: to });
  });

  wireTimelineDrags(root);
}

function renameInline(span) {
  const l = layerOf(span.dataset.rename);
  if (!l) return;
  const inp = document.createElement("input");
  inp.className = "vfxrename";
  inp.value = l.name || "";
  span.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save && inp.value.trim() && inp.value !== l.name) {
      mutate({ action: "set_layer", slug: V.slug, layerId: l.id, name: inp.value.trim() });
    } else paintTimeline();
  };
  inp.onblur = () => commit(true);
  inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    if (e.key === "Escape") { e.preventDefault(); commit(false); }
  };
}

/**
 * Timeline dragging. Bars move and trim, diamonds retime, the ruler scrubs.
 *
 * The drag paints from a LOCAL edit of the document and commits through
 * `/api/vfx` on release — a POST per pointermove would be a request storm and
 * the document is re-read from the server the moment the pointer comes up, so
 * the local copy is never authoritative for longer than one gesture.
 */
function wireTimelineDrags(root) {
  let drag = null;

  const timeAt = (clientX) => {
    const lanes = $("vfxLanes");
    if (!lanes) return 0;
    const b = lanes.getBoundingClientRect();
    return clamp((clientX - b.left) / V.pps, 0, dur());
  };

  root.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return;                       // right-click has its own menu
    const ruler = e.target.closest("#vfxRuler");
    if (ruler) {
      drag = { kind: "scrub" };
      V.scrubbing = true;
      seek(timeAt(e.clientX));
      return arm();
    }
    const key = e.target.closest("[data-key]");
    if (key) {
      const l = layerOf(key.dataset.key);
      const path = key.dataset.kpath;
      const ks = keysOf(propAt(l, path));
      const id = keyId(l.id, path, ks[+key.dataset.ki]?.t);
      /* One selection, shared by the lane, the plot and the motion path — they
       * are three views of the same keyframes and disagreeing about which one
       * is selected would be three answers to one question. */
      if (e.shiftKey) V.ksel.has(id) ? V.ksel.delete(id) : V.ksel.add(id);
      else if (!V.ksel.has(id)) { V.ksel.clear(); V.ksel.add(id); }
      drag = { kind: "key", l, path, i: +key.dataset.ki, keys: ks, el: key, token: `tlkey:${Date.now()}` };
      key.classList.add("sel");
      return arm();
    }
    const grip = e.target.closest("[data-trim]");
    if (grip) {
      const l = layerOf(grip.dataset.trim);
      if (!l || l.locked) return;
      drag = { kind: "trim", l, edge: grip.dataset.edge, token: `tltrim:${Date.now()}` };
      return arm();
    }
    const bar = e.target.closest("[data-bar]");
    if (bar) {
      const l = layerOf(bar.dataset.bar);
      if (!l) return;
      /* [precomp-multisel] a bar press is a single-select-and-drag gesture;
       * the multi-selection lives on the head rows and would otherwise sit
       * stale under a drag that moved one layer. */
      V.msel.clear();
      V.sel = l.id;
      paintTimeline(); paintProps(); paintMotionPath();
      if (l.locked) return void paintTimeline();
      drag = { kind: "move", l, grab: timeAt(e.clientX) - num(l.start), token: `tlbar:${Date.now()}` };
      paintTimeline();
      return arm();
    }
    const lane = e.target.closest(".vfxlane");
    if (lane) { drag = { kind: "scrub" }; V.scrubbing = true; seek(timeAt(e.clientX)); return arm(); }
  });

  /* Listening on `window` rather than capturing the element: every paint
   * replaces the node under the pointer, and a captured element that no longer
   * exists stops delivering moves halfway through a drag. */
  const onMove = (e) => {
    if (!drag) return;
    const t = timeAt(e.clientX);
    if (drag.kind === "scrub") return seek(t);
    if (drag.kind === "move") {
      const len = num(drag.l.end, dur()) - num(drag.l.start);
      drag.l.start = clamp(t - drag.grab, 0, Math.max(0, dur() - len));
      drag.l.end = drag.l.start + len;
      return paintTimeline();
    }
    if (drag.kind === "trim") {
      if (drag.edge === "l") drag.l.start = clamp(t, 0, num(drag.l.end, dur()) - 1 / fps());
      else drag.l.end = clamp(t, num(drag.l.start) + 1 / fps(), dur());
      return paintTimeline();
    }
    if (drag.kind === "key") {
      drag.keys[drag.i] = { ...drag.keys[drag.i], t: Math.round(t * fps()) / fps() };
      drag.moved = true;
      // Paint the diamond straight rather than repainting: it is one element.
      drag.el.style.left = `${drag.keys[drag.i].t * V.pps}px`;
    }
  };

  const onUp = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (d.kind === "scrub") { V.scrubbing = false; return queueFrame(); }
    if (d.kind === "move" || d.kind === "trim") {
      return void mutate({
        action: "set_layer", slug: V.slug, layerId: d.l.id,
        start: Math.round(d.l.start * 1000) / 1000, end: Math.round(d.l.end * 1000) / 1000,
      }, { coalesce: d.token, label: d.kind === "trim" ? "trim layer" : "move layer" });
    }
    if (d.kind === "key") {
      if (!d.moved) { paintGraph(); paintMotionPath(); return void paintTimeline(); }
      /* Whole array in one call. Two calls (remove then add) can lose the key if
       * the second one fails, and a half-applied retime is not something undo
       * can help with — it would restore a document that never made sense. */
      V.ksel.clear();
      V.ksel.add(keyId(d.l.id, d.path, d.keys[d.i].t));
      return void mutate({
        action: "set_prop", slug: V.slug, layerId: d.l.id, path: d.path,
        keys: [...d.keys].sort((a, b) => a.t - b.t),
      }, { coalesce: d.token, label: "move keyframe" });
    }
  };

  function arm() {
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  root.addEventListener("dblclick", (e) => {
    const key = e.target.closest("[data-key]");
    if (!key) return;
    const l = layerOf(key.dataset.key);
    const ks = keysOf(propAt(l, key.dataset.kpath));
    const k = ks[+key.dataset.ki];
    if (k) mutate({ action: "remove_key", slug: V.slug, layerId: l.id, path: key.dataset.kpath, t: k.t });
  });

  root.addEventListener("contextmenu", (e) => {
    const key = e.target.closest("[data-key]");
    if (key) {
      e.preventDefault();
      return easingMenu(e, key);
    }
    /* [precomp-multisel] right-click on a layer row or its bar: the layer
     * menu. One entry today — Pre-compose — which is the gesture this menu
     * exists for; anything else keeps the browser's own menu. */
    const row = e.target.closest("[data-lid], [data-bar]");
    if (!row) return;
    const lid = row.dataset.lid || row.dataset.bar;
    if (!layerOf(lid)) return;
    e.preventDefault();
    precomposeMenu(e, lid);
  });
}

/* ── precompose, the timeline gesture ──────────────────────────────────────
 * [precomp-multisel] AE's gesture, AE's semantics: the selected layers move
 * — verbatim — into a new comp of the same size/fps/duration, and one comp
 * layer replaces them at the topmost one's slot. The server does the whole
 * move in the `precompose` action; this side contributes the selection, one
 * name prompt, and ONE history entry — `mutate` snapshots the parent document
 * around the call, so Ctrl+Z restores the parent's layers in a single step
 * (the child comp stays on disk; histTo already says so when that happens). */

/** The ids the gesture acts on, in COMP STACKING ORDER — the multi-selection
 *  when there is one, else the row that was clicked. */
function precompSelection(lid) {
  const chosen = V.msel.size ? V.msel : new Set([lid || V.sel].filter(Boolean));
  return layers().filter((l) => chosen.has(l.id)).map((l) => l.id);
}

function precomposeMenu(e, lid) {
  /* Right-clicking outside the multi-selection re-anchors onto that row,
   * exactly as AE does; inside it, the selection is what the menu is about. */
  if (!V.msel.has(lid)) { V.msel.clear(); V.sel = lid; paintTimeline(); paintProps(); }
  const ids = precompSelection(lid);
  if (!ids.length) return;
  const menu = document.createElement("div");
  menu.className = "vfxmenu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  const locked = ids.map((id) => layerOf(id)).filter((l) => l?.locked);
  menu.innerHTML = `<b>${ids.length} layer${ids.length === 1 ? "" : "s"} — Ctrl-click rows to select more</b>
    <button type="button" data-pcp="1"${locked.length ? ` disabled title="${esc(locked.map((l) => l.name).join(", "))} ${locked.length === 1 ? "is" : "are"} locked."` : ""}>Pre-compose…</button>`;
  document.body.appendChild(menu);
  /* Unlike the sibling menus, the press that lands INSIDE this one must not
   * race the close: the pointerdown-capture close runs before the button's
   * click can, and a menu that vanishes under a press is a button that works
   * only sometimes. Presses inside the menu are the menu's business. */
  const close = (ev) => {
    if (ev && menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener("pointerdown", close, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  menu.onclick = (ev) => {
    if (!ev.target.closest("[data-pcp]")) return;
    close();
    precomposeSelected(ids);
  };
}

async function precomposeSelected(ids) {
  const name = prompt(
    `Move ${ids.length === 1 ? "this layer" : `these ${ids.length} layers`} into a new composition.\nName it (blank = "Pre-comp N"):`, "");
  if (name === null) return;                     // cancelled
  const d = await mutate(
    { action: "precompose", slug: V.slug, layerIds: ids, name: name.trim() || undefined },
    { label: "precompose", reloadList: true },   // the picker gains a comp
  );
  if (!d) return;                                // refused; mutate said why
  V.msel.clear();
  V.sel = d.layerId || null;                     // the comp layer that took their place
  paintTimeline(); paintProps(); paintMotionPath(); paintGizmo();
  /* The boundary breaks, if any, are the one thing worth saying out loud —
   * a matte or a parent link quietly gone is three days of "why does this
   * render differently". No warnings = say where the layers went instead. */
  note(d.warnings?.length
    ? d.warnings.join("\n")
    : `${ids.length} layer${ids.length === 1 ? "" : "s"} moved into "${d.precompSlug}". The picture is unchanged; one undo step brings them back (the new comp stays).`);
}

/** Easing, on the key it LEAVES (§1). A menu because there are five of them. */
function easingMenu(e, key) {
  const l = layerOf(key.dataset.key);
  const path = key.dataset.kpath;
  const ks = keysOf(propAt(l, path));
  const i = +key.dataset.ki;
  const cur = ks[i]?.ease || "linear";
  const menu = document.createElement("div");
  menu.className = "vfxmenu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  const shaped = typeof cur === "object";
  menu.innerHTML = `<b>Easing out of ${fmtT(num(ks[i]?.t))}</b>${EASES.map((x) =>
    `<button type="button" data-ease="${x}"${x === cur ? ' class="on"' : ""}>${x}</button>`).join("")}
    ${shaped ? `<button type="button" class="on" disabled title="Four control points of its own — shape it in the graph editor.">bezier</button>` : ""}
    <button type="button" data-shape="1" title="A named ease is one of five shapes; the graph editor is all of them.">shape it…</button>`;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", close, true); };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  menu.onclick = (ev) => {
    if (ev.target.closest("[data-shape]")) {
      close();
      V.ksel.clear();
      V.ksel.add(keyId(l.id, path, ks[i].t));
      return openGraph(l.id, path);
    }
    const b = ev.target.closest("[data-ease]");
    if (!b) return;
    ks[i] = { ...ks[i], ease: b.dataset.ease };
    close();
    mutate({ action: "set_prop", slug: V.slug, layerId: l.id, path, keys: ks }, { label: `${b.dataset.ease} easing` });
  };
}

/* ── keyboard ────────────────────────────────────────────────────────────── */

function wireKeys() {
  document.addEventListener("keydown", (e) => {
    const root = $("vfx");
    if (!root || root.hidden) return;
    const tag = e.target.tagName;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target.isContentEditable;

    /* Undo is checked BEFORE the typing guard, because it is the one shortcut a
     * person expects to work with the cursor still in a box. The exception is a
     * box holding text a browser has its own undo for — taking Ctrl+Z away
     * there would lose a half-typed expression to gain a step nobody asked for. */
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^(KeyZ|KeyY)$/.test(e.code)) {
      const texty = tag === "TEXTAREA" || (tag === "INPUT" && /^(text|search|)$/.test(e.target.type || ""));
      if (texty) return;
      if (!V.comp) return;
      e.preventDefault();
      return (e.code === "KeyY" || e.shiftKey) ? redo() : undo();
    }

    if (inField) return;
    if (!V.comp) return;
    if (e.code === "Space") { e.preventDefault(); return V.playing ? stop() : play(); }
    if (e.code === "ArrowLeft") { e.preventDefault(); return seek(V.t - (e.shiftKey ? 1 : 1 / fps())); }
    if (e.code === "ArrowRight") { e.preventDefault(); return seek(V.t + (e.shiftKey ? 1 : 1 / fps())); }
    if (e.code === "Home") { e.preventDefault(); return seek(0); }
    if (e.code === "End") { e.preventDefault(); return seek(dur()); }
    if (e.code === "Escape" && V.ksel.size) {
      e.preventDefault();
      V.ksel.clear();
      return void (paintTimeline(), paintGraph(), paintMotionPath());
    }
    if (e.code === "Delete" || e.code === "Backspace") {
      /* Selected keyframes first. Delete means "the thing that is selected", and
       * a keyframe selection is narrower and more recent than a layer selection
       * — removing the whole layer because a key was highlighted would be the
       * most expensive misread in the tab. */
      if (V.ksel.size) { e.preventDefault(); return void deleteSelectedKeys(); }
      if (!V.sel) return;
      e.preventDefault();
      const l = selected();
      if (l && confirm(`Remove "${l.name || l.id}" from the comp?`)) {
        mutate({ action: "remove_layer", slug: V.slug, layerId: l.id });
      }
    }
  });
}

/* ── pickers ─────────────────────────────────────────────────────────────── */

function overlay(html, wire) {
  const ov = $("vfxOverlay");
  ov.innerHTML = `<div class="vfxsheet">${html}<button class="vfxclose" type="button" id="vfxOvX">✕</button></div>`;
  ov.hidden = false;
  const close = () => { ov.hidden = true; ov.innerHTML = ""; };
  $("vfxOvX").onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  wire?.(close);
}

/** What kind of layer. Image and video then pick a source from the library. */
function addLayerMenu() {
  if (!V.comp) return;
  overlay(`<h3>Add a layer</h3>
    <div class="vfxkinds">${LAYER_KINDS.map(([k, g, label, why]) => `
      <button class="vfxkind" type="button" data-kind="${k}" title="${esc(why)}"><b>${g}</b><span>${label}</span></button>`).join("")}</div>
    <p class="hint">Image and video pick a file from the library — a comp stores the
      library NAME, never a path, so the same document renders on another machine.
      A shape layer starts as one rounded rectangle you then edit; a camera only moves
      layers with 3D turned on; a comp layer nests another composition.</p>`, (close) => {
    for (const b of $("vfxOverlay").querySelectorAll("[data-kind]")) {
      b.onclick = () => {
        const kind = b.dataset.kind;
        close();
        if (kind === "image" || kind === "video") sourcePicker(kind);
        else if (kind === "comp") compPicker();
        else addLayer(kind, null);
      };
    }
  });
}

/**
 * The shape item browser, and the one place the phase order is taught.
 *
 * The groups are listed IN THE ORDER THE ENGINE RUNS THEM rather than
 * alphabetically, with what each phase does written above it, because reading
 * this list top to bottom is reading a shape stack. Picking from it inserts at
 * the right index, so the list is also the reason the order rarely goes wrong.
 */
function shapePicker(l) {
  const cat = V.shapeCat || {};
  const names = Object.keys(cat);
  if (!names.length) {
    return overlay(`<h3>Shape items</h3><p class="hint">The catalog is empty or did not load.
      <code>/api/vfx/shapes</code> serves it and this panel builds itself from it.</p>`);
  }
  const phases = [
    ["Path", "makes geometry and adds it to the path set"],
    ["Path Operation", "rewrites every path made so far"],
    ["Paint", "draws what the path set holds at that moment — and later paint covers earlier paint"],
    ["Group", "a stack of its own, with its own transform"],
  ];
  overlay(`<h3>Add a shape item</h3>
    <p class="hint">A shape layer runs its items in order. Whatever you pick lands where it belongs
      in that order, so a trim goes in after the paths and before the paint on its own.</p>
    <div class="vfxfxlist" id="vfxShapeList"></div>`, (close) => {
    $("vfxShapeList").innerHTML = phases.map(([g, why]) => {
      const hits = names.filter((n) => cat[n].group === g);
      return hits.length ? `<section><h4><i class="vfxphase ${PHASE_TAG[g]}">${PHASE_TAG[g]}</i> ${esc(g)}</h4>
        <p class="hint">${esc(why)}</p>
        ${hits.map((n) => `<button class="vfxfxpick" type="button" data-shadd="${esc(n)}">
          <b>${esc(cat[n].label || n)}</b><span>${esc(String(cat[n].why || "").split(". ")[0])}</span></button>`).join("")}</section>` : "";
    }).join("");
    for (const b of $("vfxShapeList").querySelectorAll("[data-shadd]")) {
      b.onclick = () => {
        const type = b.dataset.shadd;
        close();
        const items = shapeItems(l).slice();
        items.splice(insertionIndex(items, type), 0, blankShapeItem(type));
        V.itemOpen.clear();
        writeShapes(l, items);
      };
    }
  });
}

/** A new item carrying only what the catalog says it is — the engine fills in
 *  every default it is not given, so writing them all down would just be a
 *  second copy of the catalog going stale. */
function blankShapeItem(type) {
  const it = { type };
  if (type === "group") it.items = [];
  return it;
}

/* ── sound and motion ────────────────────────────────────────────────────── */

/** The property this analysis will be written onto. Shared by both panels. */
/**
 * Where an analysis writes. THE ENUMERATOR'S LIST, not a second one built here
 * from the catalog — that older copy offered effect params the registry marked
 * animatable and nothing else, missed every shape parameter, and spelled effect
 * paths its own way. The picker cannot offer a path the writer would refuse
 * when both read the same answer.
 *
 * The list is read from cache: `wireDrive` warms it before either panel opens,
 * because a picker that appears empty and fills in a moment later is a picker
 * somebody has already clicked past.
 */
function pathPicker(l, id) {
  const rows = V.props.get(l.id)?.rows || [];
  return `<label class="vfxfield wide">property
    <select class="sel2 sm" id="${id}">${rows.map((r) =>
      `<option value="${esc(r.path)}" data-arity="${arityFor(l, r, r.value)}"${r.path === "transform.position" ? " selected" : ""}>${esc(r.label)}</option>`).join("")}
    </select></label>`;
}

/** An axis only means something on a property that HAS axes. */
function wireAxis(pathId, axisId) {
  const path = $(pathId), axis = $(axisId);
  if (!path || !axis) return;
  const sync = () => {
    const n = +(path.selectedOptions[0]?.dataset.arity || 1);
    axis.disabled = n < 2;
    axis.title = n < 2 ? "This property is a single number — there is no axis to choose." : "";
    if (axis.disabled) axis.value = "";
  };
  path.addEventListener("change", sync);
  sync();
}

const fieldNum = (id, label, value, step = 1, title = "") =>
  `<label class="vfxfield" title="${esc(title)}">${esc(label)}
    <input type="number" id="${id}" value="${value}" step="${step}"></label>`;

/**
 * Sound → keyframes.
 *
 * Two steps, because the tool itself says so: analyse, look at what came back,
 * and only then commit. The bands bleed at the crossovers — a strong bass note
 * shows a little in lowMid — which is why the analysis reports `bandDb` and
 * `silentBands` and why they are printed here rather than summarised away. A
 * band this song does not have is worth knowing before you drive a scale from
 * it and wonder why nothing moves.
 */
async function audioPanel(l) {
  if (!V.songs.length) {
    try { V.songs = (await getJson("/api/status")).library || []; } catch { /* offline */ }
  }
  const sources = [
    ...V.songs.map((s) => ({ name: s.file, label: s.title || s.file })),
    ...V.clips.map((c) => ({ name: c.name, label: `${c.title || c.name} · clip` })),
  ];
  overlay(`<h3>Drive a property from sound</h3>
    <p class="hint">The file is analysed into seven 0..1 tracks. <b>min</b> and <b>max</b> map that
      onto what the property actually wants — a scale between 100 and 140, a rotation between -8 and 8.</p>
    <div class="vfxform">
      <label class="vfxfield wide">audio
        <select class="sel2 sm" id="vfxAkSrc">${sources.map((s) =>
          `<option value="${esc(s.name)}">${esc(String(s.label).slice(0, 60))}</option>`).join("")
          || `<option value="">nothing in the library</option>`}</select></label>
      ${fieldNum("vfxAkFps", "keys/s", 30, 1, "A 3-minute song at 30 is about 5400 keys per track")}
      ${fieldNum("vfxAkFrom", "from s", 0, 0.1)}
      ${fieldNum("vfxAkTo", "to s", Math.round(dur() * 100) / 100, 0.1, "Analyse only this much of it")}
      ${fieldNum("vfxAkOffset", "shift s", 0, 0.1, "Move every key, for audio that does not start at the comp's zero")}
    </div>
    <div class="vfxform"><button class="btn sm" type="button" id="vfxAkGo">analyse</button>
      <span class="hint" id="vfxAkNote"></span></div>
    <div id="vfxAkOut"></div>`, () => {
    const out = $("vfxAkOut");
    $("vfxAkGo").onclick = async () => {
      const src = $("vfxAkSrc").value;
      if (!src) return;
      $("vfxAkNote").textContent = "analysing…";
      out.innerHTML = "";
      try {
        const d = await api({
          action: "audio_keys", audio: src, fps: num($("vfxAkFps").value, 30),
          from: num($("vfxAkFrom").value, 0), to: num($("vfxAkTo").value, dur()),
          offset: num($("vfxAkOffset").value, 0),
        });
        $("vfxAkNote").textContent = "";
        out.innerHTML = audioResult(l, d);
        wireAudioApply(l, src);
      } catch (e) {
        $("vfxAkNote").textContent = "";
        out.innerHTML = `<p class="hint vfxwarnline">${esc(e.message || "That did not analyse.")}</p>`;
      }
    };
  });
}

function audioResult(l, d) {
  const silent = new Set(d.silentBands || []);
  const rows = AUDIO_TRACKS.map(([k, why]) => {
    const n = d.tracks?.[k] ?? 0;
    const db = d.bandDb?.[k];
    return `<option value="${k}" title="${esc(why)}"${k === "amplitude" ? " selected" : ""}>${k} · ${n} keys${
      db != null ? ` · ${db > 0 ? "+" : ""}${db} dB` : ""}${silent.has(k) ? " · SILENT" : ""}</option>`;
  }).join("");
  const quiet = [...silent];
  return `<div class="vfxresult">
    <p><b>${d.bpm ? `${d.bpm} BPM` : "no tempo found"}</b> · ${d.beats ?? 0} beats · ${d.bars ?? 0} bars
      · ${d.seconds ?? 0}s analysed at ${d.fps ?? 0} keys/s</p>
    ${quiet.length ? `<p class="vfxwarnline">Nothing in ${quiet.join(", ")} — driving a property from
      ${quiet.length === 1 ? "that band" : "one of those"} would hold still. The bands bleed at the
      crossovers, so a reading near a neighbour's is not proof of content.</p>` : ""}
    <div class="vfxform">
      <label class="vfxfield wide">track<select class="sel2 sm" id="vfxAkTrack">${rows}</select></label>
      ${pathPicker(l, "vfxAkPath")}
      ${fieldNum("vfxAkMin", "at 0", 0, 1, "What the property is worth when the track reads zero")}
      ${fieldNum("vfxAkMax", "at 1", 100, 1, "And when it reads one")}
      <label class="vfxfield" title="Vector properties only — drive one component and leave the others alone">axis
        <select class="sel2 sm" id="vfxAkAxis"><option value="">both</option><option value="0">x</option><option value="1">y</option></select></label>
    </div>
    <div class="vfxform"><button class="btn sm" type="button" id="vfxAkApply">write the keyframes</button>
      <span class="hint" id="vfxAkDone">This replaces whatever animation the property has.</span></div>
  </div>`;
}

function wireAudioApply(l, src) {
  wireAxis("vfxAkPath", "vfxAkAxis");
  $("vfxAkApply").onclick = async () => {
    const axis = $("vfxAkAxis").value;
    $("vfxAkDone").textContent = "writing…";
    const d = await mutate({
      action: "audio_keys", audio: src, fps: num($("vfxAkFps").value, 30),
      from: num($("vfxAkFrom").value, 0), to: num($("vfxAkTo").value, dur()),
      offset: num($("vfxAkOffset").value, 0),
      apply: {
        slug: V.slug, layerId: l.id, path: $("vfxAkPath").value,
        track: $("vfxAkTrack").value, min: num($("vfxAkMin").value, 0), max: num($("vfxAkMax").value, 100),
        ...(axis === "" ? {} : { axis: +axis }),
      },
    });
    if (!d) return void ($("vfxAkDone").textContent = "");
    V.open.add(l.id);
    $("vfxOverlay").hidden = true; $("vfxOverlay").innerHTML = "";
    note(`${d.applied?.keys ?? 0} keyframes on ${d.applied?.path} from ${d.track}.`);
    paint();
  };
}

/**
 * Motion → keyframes.
 *
 * The tracker STOPS rather than inventing positions, and that is the whole
 * reason this panel exists in two steps: a short result with a `lostAt` is not
 * an error and must not be dressed as one. It is the tracker telling you where
 * it stopped being sure, which is worth more than a full-length track quietly
 * padded with guesses.
 */
function trackPanel(l) {
  const clips = V.clips.filter((c) => /\.(mp4|webm|mov)$/i.test(c.name));
  const own = l.type === "video" ? l.src : null;
  const w = num(l.srcWidth, V.comp?.width || 1920), h = num(l.srcHeight, V.comp?.height || 1080);
  overlay(`<h3>Drive a property from motion</h3>
    <p class="hint">Pick a patch with contrast and a corner in it — the tracker follows that patch
      through the clip. <b>follow</b> writes where it went, so a layer rides along with it;
      <b>stabilize</b> writes the inverse, so the shot holds still. Coordinates are the CLIP's own pixels.</p>
    <div class="vfxform">
      <label class="vfxfield wide">clip
        <select class="sel2 sm" id="vfxTkClip">${clips.map((c) =>
          `<option value="${esc(c.name)}"${c.name === own ? " selected" : ""}>${esc(c.title || c.name)}</option>`).join("")
          || `<option value="">no clips in the library</option>`}</select></label>
    </div>
    <div class="vfxform">
      ${fieldNum("vfxTkX", "x", Math.round(w / 2 - 40))}
      ${fieldNum("vfxTkY", "y", Math.round(h / 2 - 40))}
      ${fieldNum("vfxTkW", "w", 80)}
      ${fieldNum("vfxTkH", "h", 80)}
      ${fieldNum("vfxTkSearch", "search", 40, 5, "How many pixels each way to look per frame — raise it for fast motion")}
      ${fieldNum("vfxTkConf", "min conf", 0.55, 0.05, "Below this a frame counts as bad. It is a SETTING, not a measurement.")}
    </div>
    <div class="vfxform">
      ${fieldNum("vfxTkFrom", "from s", 0, 0.1)}
      ${fieldNum("vfxTkTo", "to s", Math.round(dur() * 100) / 100, 0.1)}
      <button class="btn sm" type="button" id="vfxTkGo">track</button>
      <span class="hint" id="vfxTkNote"></span>
    </div>
    <div id="vfxTkOut"></div>`, () => {
    $("vfxTkGo").onclick = async () => {
      const clip = $("vfxTkClip").value;
      if (!clip) return;
      $("vfxTkNote").textContent = "tracking — this reads every frame…";
      $("vfxTkOut").innerHTML = "";
      try {
        const d = await api({
          action: "track_motion", clip,
          rect: ["vfxTkX", "vfxTkY", "vfxTkW", "vfxTkH"].map((id) => num($(id).value)),
          search: num($("vfxTkSearch").value, 40), minConfidence: num($("vfxTkConf").value, 0.55),
          fromTime: num($("vfxTkFrom").value, 0), toTime: num($("vfxTkTo").value, dur()),
        });
        $("vfxTkNote").textContent = "";
        $("vfxTkOut").innerHTML = trackResult(l, d);
        wireTrackApply(l, clip);
      } catch (e) {
        $("vfxTkNote").textContent = "";
        $("vfxTkOut").innerHTML = `<p class="hint vfxwarnline">${esc(e.message || "That did not track.")}</p>`;
      }
    };
  });
}

function trackResult(l, d) {
  const c = d.confidence || {};
  const lost = d.lostAt != null;
  const secs = d.fps ? (d.frames / d.fps) : 0;
  /* Deliberately NOT the warn colour. Losing the feature is the tracker doing
   * its job; the failure worth a warning is the opposite one — a full-length
   * track through repetitive texture that was never sure of anything. */
  const head = lost
    ? `<p><b>Tracked ${d.frames} frames, then stopped at ${d.lostAt.toFixed(3)}s.</b>
        The patch was occluded or left the frame there. Nothing past that point was invented —
        the keys end where the certainty ended.</p>
       <p class="hint">Try a larger <b>search</b> if the motion is fast, a patch that stays in shot,
        or track the part before the loss and the part after it separately.</p>`
    : `<p><b>Tracked all ${d.frames} frames</b> — ${secs.toFixed(2)}s at ${d.fps} fps, no loss.</p>`;
  const conf = c.min != null ? `<p class="hint">Confidence ${c.min.toFixed(3)} at its worst,
      ${c.mean.toFixed(3)} on average, against a threshold of ${c.threshold} — and the threshold is the
      setting this run used, not something that was measured.
      ${d.dips ? `${d.dips} dip${d.dips === 1 ? "" : "s"} below it.` : ""}
      Confidence cannot see the one failure that matters most: repetitive texture, where the patch
      matches many places equally well and the tracker picks one of them.</p>` : "";
  return `<div class="vfxresult">${head}${conf}
    <div class="vfxform">
      <label class="vfxfield">mode<select class="sel2 sm" id="vfxTkMode">
        <option value="follow">follow — ride with it</option>
        <option value="stabilize">stabilize — cancel it</option></select></label>
      ${pathPicker(l, "vfxTkPath")}
      <button class="btn sm" type="button" id="vfxTkApply">write ${d.frames} keyframes</button>
    </div>
    <span class="hint" id="vfxTkDone">This replaces whatever animation the property has.</span>
  </div>`;
}

function wireTrackApply(l, clip) {
  $("vfxTkApply").onclick = async () => {
    $("vfxTkDone").textContent = "writing…";
    const d = await mutate({
      action: "track_motion", clip,
      rect: ["vfxTkX", "vfxTkY", "vfxTkW", "vfxTkH"].map((id) => num($(id).value)),
      search: num($("vfxTkSearch").value, 40), minConfidence: num($("vfxTkConf").value, 0.55),
      fromTime: num($("vfxTkFrom").value, 0), toTime: num($("vfxTkTo").value, dur()),
      apply: { slug: V.slug, layerId: l.id, path: $("vfxTkPath").value, mode: $("vfxTkMode").value },
    });
    if (!d) return void ($("vfxTkDone").textContent = "");
    V.open.add(l.id);
    $("vfxOverlay").hidden = true; $("vfxOverlay").innerHTML = "";
    note(`${d.applied?.keys ?? 0} keyframes on ${d.applied?.path} (${d.mode})`
      + `${d.lostAt != null ? ` — they stop at ${d.lostAt.toFixed(2)}s, where the track was lost.` : "."}`);
    paint();
  };
}

function sourcePicker(kind) {
  const isImg = kind === "image";
  const rows = isImg
    ? V.images.map((im) => ({ name: im.name, label: im.meta?.prompt || im.name, thumb: `/api/image/${encodeURIComponent(im.name)}` }))
    : V.clips.filter((c) => /\.(mp4|webm|mov)$/i.test(c.name))
        .map((c) => ({ name: c.name, label: c.title || c.name, thumb: null }));
  overlay(`<h3>${isImg ? "Pick an image" : "Pick a clip"}</h3>
    <input class="stsearch" id="vfxSrcQ" type="search" placeholder="Search…" autocomplete="off" spellcheck="false">
    <div class="vfxpickgrid" id="vfxSrcGrid"></div>
    ${rows.length ? "" : `<p class="hint">The ${isImg ? "images" : "clips"} library is empty, or it did not answer.
      Make something on the ${isImg ? "Images" : "Video"} tab first.</p>`}`, (close) => {
    const grid = $("vfxSrcGrid");
    const draw = () => {
      const q = ($("vfxSrcQ").value || "").toLowerCase().trim();
      const list = q ? rows.filter((r) => `${r.label} ${r.name}`.toLowerCase().includes(q)) : rows;
      grid.innerHTML = list.slice(0, 240).map((r) => `
        <button class="vfxpick" type="button" data-src="${esc(r.name)}" title="${esc(r.name)}">
          ${r.thumb ? `<img src="${r.thumb}" alt="" loading="lazy">` : `<span class="vfxpickglyph">${GLYPH[kind]}</span>`}
          <span>${esc(String(r.label).slice(0, 48))}</span></button>`).join("")
        || `<p class="hint">Nothing matches that.</p>`;
      for (const b of grid.querySelectorAll("[data-src]")) {
        b.onclick = () => { close(); addLayer(kind, b.dataset.src); };
      }
    };
    $("vfxSrcQ").oninput = draw;
    draw();
  });
}

/** Which comp to nest. A comp cannot hold itself, so this one is not offered. */
function compPicker() {
  const others = V.comps.filter((c) => c.slug !== V.slug);
  if (!others.length) {
    return overlay(`<h3>Nest a comp</h3><p class="hint">There is no other composition to nest.
      A comp layer draws another comp inside this one, so there has to be another one first.</p>`);
  }
  overlay(`<h3>Nest a comp</h3>
    <div class="vfxpickgrid">${others.map((c) => `
      <button class="vfxpick" type="button" data-nest="${esc(c.slug)}">
        <span class="vfxpickglyph">⧉</span>
        <span>${esc(c.name || c.slug)}</span></button>`).join("")}</div>
    <p class="hint">This comp is not on the list — a composition cannot contain itself.</p>`, (close) => {
    for (const b of $("vfxOverlay").querySelectorAll("[data-nest]")) {
      b.onclick = () => {
        close();
        const c = V.comps.find((x) => x.slug === b.dataset.nest);
        addLayer("comp", c.slug, { name: c.name || c.slug });
      };
    }
  });
}

function addLayer(type, src, extra = {}) {
  const body = { action: "add_layer", slug: V.slug, type, start: 0, end: dur(), ...extra };
  if (src) { body.src = src; body.name ||= src.replace(/\.[a-z0-9]+$/i, ""); }
  else body.name ||= type === "null" ? "Null" : type[0].toUpperCase() + type.slice(1);
  if (type === "solid") body.color = [255, 255, 255, 255];
  if (type === "text") body.text = { content: "TEXT", size: 96, align: "center", color: [240, 240, 245, 255] };
  /* A new layer goes to the TOP of the stack (§1), so `layers[0]` is it — but
   * take the id the server hands back if it hands one back, because a route
   * that inserts somewhere else is entitled to and this must follow it. */
  mutate(body).then(async (d) => {
    const id = d?.layer?.id || V.comp?.layers?.[0]?.id;
    if (id) { V.sel = id; paintTimeline(); paintProps(); }
    /* add_layer only takes a `src` for an image or a video, so a comp layer
     * arrives naming nothing. Say so once, here, rather than leaving a layer
     * that renders an empty rectangle for no visible reason. */
    if (type === "comp" && src && layerOf(id)?.src !== src) {
      note(`The layer was made, but /api/vfx would not let it name "${src}": add_layer takes a src `
        + `only for an image or a video, and a comp layer's src is the child comp's slug.`);
    }
  });
}

/**
 * The effect browser IS the catalog. Groups, labels and the one-line "why" all
 * come from `/api/vfx/catalog`, which is the same table MCP serves — so a person
 * browsing here and an agent calling `vfx_effects_catalog` are reading one list.
 */
function effectPicker(l) {
  const cat = V.catalog || {};
  const names = Object.keys(cat);
  if (!names.length) {
    return overlay(`<h3>Effects</h3><p class="hint">The catalog is empty or did not load.
      <code>/api/vfx/catalog</code> serves it and the effects panel builds itself from it,
      so nothing here is hard-coded — once the route answers, every effect appears.</p>`);
  }
  const groups = new Map();
  for (const n of names) {
    const g = cat[n].group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }
  overlay(`<h3>Add an effect</h3>
    <input class="stsearch" id="vfxFxQ" type="search" placeholder="Search effects…" autocomplete="off" spellcheck="false">
    <div class="vfxfxlist" id="vfxFxList"></div>`, (close) => {
    const draw = () => {
      const q = ($("vfxFxQ").value || "").toLowerCase().trim();
      $("vfxFxList").innerHTML = [...groups.entries()].map(([g, ns]) => {
        const hits = ns.filter((n) => !q || `${n} ${cat[n].label || ""} ${cat[n].why || ""}`.toLowerCase().includes(q));
        return hits.length ? `<section><h4>${esc(g)}</h4>${hits.map((n) => `
          <button class="vfxfxpick" type="button" data-fxadd="${esc(n)}">
            <b>${esc(cat[n].label || n)}</b><span>${esc(cat[n].why || "")}</span></button>`).join("")}</section>` : "";
      }).join("") || `<p class="hint">Nothing matches that.</p>`;
      for (const b of $("vfxFxList").querySelectorAll("[data-fxadd]")) {
        b.onclick = () => {
          close();
          mutate({ action: "add_effect", slug: V.slug, layerId: l.id, type: b.dataset.fxadd })
            .then((d) => { const id = d?.effect?.id; if (id) V.fxOpen.add(id); paintProps(); });
        };
      }
    };
    $("vfxFxQ").oninput = draw;
    draw();
  });
}

/**
 * FXPRESETS: the effect/animation preset shelf.
 *
 * SERVER-SIDE AND APP-LEVEL — the rows here are `list_fx_presets`, the same
 * list `vfx_effect_presets` serves to MCP, which is the point: a preset an
 * agent saves shows up in this sheet, and one saved here is applyable by an
 * agent. Nothing is hard-coded — the built-ins are data the server seeds.
 *
 * Times inside a preset are relative to the source layer's start; Apply lands
 * them at the selected layer's own start. Both rules live in the server
 * (store.js, FXPRESETS) — this sheet only says them out loud.
 */
function fxPresetSheet(l) {
  overlay(`<h3>Effect &amp; animation presets</h3>
    <p class="hint">A preset is a layer's effect stack — parameters, keyframes, expressions — and,
      if you tick the box, its keyframed transform move. Keyframe times are saved relative to the
      layer's start, so a preset lands sensibly on any layer in any comp. Applying appends the
      effects with fresh ids; transform keys paste over the range they cover and leave the rest.</p>
    <div class="vfxrow static">
      <span class="vfxlab">Save</span>
      <span class="vfxvals">
        <input type="text" id="vfxFxpName" placeholder="Preset name…" spellcheck="false" autocomplete="off">
        <label class="edtool tog sm" title="Also capture every keyframed transform property — the saved move">
          <input type="checkbox" id="vfxFxpXf">+ move</label>
        <button class="edtool sm" type="button" id="vfxFxpSave">Save from ${esc(l.name || l.id)}</button>
      </span>
    </div>
    <div class="vfxfxlist" id="vfxFxpList"><p class="hint">Loading the shelf…</p></div>`, (close) => {
    const draw = async () => {
      let rows = [];
      try { rows = (await api({ action: "list_fx_presets" })).presets || []; }
      catch (e) { $("vfxFxpList").innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
      $("vfxFxpList").innerHTML = rows.length ? rows.map((p) => `
        <div class="vfxfx" data-fxp="${esc(p.name)}">
          <header class="vfxfxhead">
            <b>${esc(p.name)}</b>
            <span class="vfxfxgrp">${esc([
              p.effects.length ? p.effects.join(" + ") : "no effects",
              p.keyed ? "keyed" : "",
              p.transform.length ? `move: ${p.transform.join("/")}` : "",
            ].filter(Boolean).join(" · "))}</span>
            <button class="edtool sm" type="button" data-fxpapply="${esc(p.name)}">Apply</button>
            ${p.builtin ? "" : `<button class="sttog warn" type="button" data-fxpdel="${esc(p.name)}" title="Delete this preset">✕</button>`}
          </header>
          ${p.note ? `<p class="hint">${esc(p.note)}</p>` : ""}
        </div>`).join("") : `<p class="hint">The shelf is empty.</p>`;
      for (const btn of $("vfxFxpList").querySelectorAll("[data-fxpapply]")) {
        btn.onclick = async () => {
          close();
          const d = await mutate(
            { action: "apply_fx_preset", slug: V.slug, layerId: l.id, preset: btn.dataset.fxpapply },
            { label: `preset ${btn.dataset.fxpapply}` });
          if (!d) return;                       // refused; mutate already said why
          /* Warnings are the apply SUCCEEDING with something worth reading —
           * an expression naming a layer this comp does not have. */
          if (d.warnings?.length) note(`Applied, with warnings: ${d.warnings.join(" · ")}`);
          for (const id of d.effectIds || []) V.fxOpen.add(id);
          paintProps();
        };
      }
      for (const btn of $("vfxFxpList").querySelectorAll("[data-fxpdel]")) {
        btn.onclick = async () => {
          try { await api({ action: "delete_fx_preset", preset: btn.dataset.fxpdel }); draw(); }
          catch (e) { note(e.message); }
        };
      }
    };
    $("vfxFxpSave").onclick = async () => {
      const nm = ($("vfxFxpName").value || "").trim();
      if (!nm) { note("Name the preset first."); return; }
      try {
        const r = await api({
          action: "save_fx_preset", slug: V.slug, layerId: l.id, name: nm,
          includeTransform: $("vfxFxpXf").checked,
        });
        note(`Saved "${r.preset}" — ${r.effects.length} effect(s)${r.transform.length ? ` + ${r.transform.join("/")}` : ""}.`);
        $("vfxFxpName").value = "";
        draw();
      } catch (e) { note(e.message); }
    };
    draw();
  });
}
