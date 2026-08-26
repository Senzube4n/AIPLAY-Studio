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
const GLYPH = Object.fromEntries(LAYER_KINDS.map(([k, g]) => [k, g]));

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
  itemOpen: new Set(), // "layerId:index" — shape items expanded in Properties
  expr: null,         // the property path whose expression editor is open
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
 *     made stays on disk. No button in this tab calls `precompose` today — it
 *     is an MCP action — so the note `histTo` prints about it is latent, put
 *     there for the day the panel grows the button rather than for now.
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

/** Dotted path into a layer; a segment that lands on an array matches by id. */
function readPath(layer, path) {
  let cur = layer;
  for (const k of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur.find((x) => x && x.id === k) : cur[k];
  }
  return cur;
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
  const v = readPath(l, path);
  if (v !== undefined) return v;
  const p = String(path).split(".");
  if (p[0] === "effects" && p[2] === "params") {
    const e = (l.effects || []).find((x) => x.id === p[1]);
    return V.catalog?.[e?.type]?.params?.[p[3]]?.default;
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
      <section class="vfxpanel vfxstack">
        <header class="vfxhead"><h3>Layers</h3>
          <button class="edtool sm" type="button" id="vfxAddLayer" title="Add a layer to the top of the stack">＋ layer</button>
        </header>
        <div class="vfxstacklist" id="vfxStack"></div>
      </section>

      <section class="vfxpanel vfxcentre">
        <div class="vfxwell" id="vfxWell">
          <div class="vfxcheck" id="vfxCheck">
            <img id="vfxFrame" alt="">
            <svg class="vfxmp" id="vfxMotionPath" hidden></svg>
            <span class="vfxqual" id="vfxQual" hidden></span>
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
    <div class="vfxtl" id="vfxTl"></div>
    <div class="vfxgraph" id="vfxGraph" hidden></div>
    <div class="vfxblank" id="vfxDown" hidden>
      <h3>The VFX engine is not responding.</h3>
      <p class="hint">Nothing was lost — comps live on disk under <code>vfx/&lt;slug&gt;/comp.json</code>
        and this tab only reads and writes them through <code>/api/vfx</code>. Either the server
        has not mounted those routes yet, or it is restarting.</p>
      <button class="btn sm" type="button" id="vfxRetry">Try again</button>
    </div>
    <div class="vfxoverlay" id="vfxOverlay" hidden></div>`;

  $("vfxRetry").onclick = () => vfxOpen();
  wireViewer();
  wireDelegates();
  wireGestureBounds();
  wireKeys();
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
  $("vfxTl").hidden = V.down || !V.comp;
  if (V.down) { $("vfxBar").innerHTML = `<h2 class="vfxtitle">VFX</h2>`; return; }
  paintBar();
  if (!V.comp) return paintEmpty();
  paintStack();
  paintProps();
  paintTimeline();
  paintTransport();
  paintGraph();
  paintMotionPath();
  queueFrame();
}

/** No comps, or a comp that would not load. Both are ordinary places to be. */
function paintEmpty() {
  $("vfxStack").innerHTML = `<p class="hint vfxpad">A comp holds the layers.</p>`;
  $("vfxTl").innerHTML = "";
  $("vfxTransport").innerHTML = "";
  $("vfxGraph").hidden = true;
  $("vfxMotionPath").toggleAttribute("hidden", true);
  $("vfxQual").hidden = true;
  $("vfxFrame").hidden = true;
  $("vfxFrame").removeAttribute("src");
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
    V.t = 0; V.inT = 0; V.outT = null; V.sel = null; V.expr = null;
    V.open.clear(); V.fxOpen.clear(); V.itemOpen.clear();
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
  }
}

async function newComp() {
  const name = prompt("Name the composition", "Untitled comp");
  if (!name) return;
  try {
    const d = await api({ action: "create", name, width: 1920, height: 1080, fps: 30, duration: 8 });
    V.slug = d.comp?.slug || d.slug || null;
    V.sel = null; V.t = 0; V.outT = null;
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
  V.slug = null; V.comp = null; V.sel = null;
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

/* ── the layer stack ─────────────────────────────────────────────────────── */

/**
 * AE order: layers[0] is the TOP of the stack and the last thing painted, and
 * it is drawn first here so the list reads the way the picture stacks. Getting
 * that backwards is the single most confusing thing a compositor can do.
 */
function paintStack() {
  const ls = layers();
  const solo = soloing();
  $("vfxStack").innerHTML = ls.length ? ls.map((l, i) => {
    const parent = l.parent ? layerOf(l.parent) : null;
    const dimmed = !l.enabled || (solo && !l.solo);
    return `<div class="vfxlayer${l.id === V.sel ? " sel" : ""}${dimmed ? " off" : ""}"
                 data-lid="${esc(l.id)}" draggable="true">
      <button class="sttog${l.enabled ? " on" : ""}" data-tog="enabled" data-lid="${esc(l.id)}" title="Visible">👁</button>
      <button class="sttog solo${l.solo ? " on solo" : ""}" data-tog="solo" data-lid="${esc(l.id)}" title="Solo — hides every layer that is not soloed">S</button>
      <button class="sttog${l.locked ? " on" : ""}" data-tog="locked" data-lid="${esc(l.id)}" title="Locked — no edits, no selection changes">🔒</button>
      <span class="vfxglyph" title="${esc(l.type)}">${GLYPH[l.type] || "?"}</span>
      <span class="vfxlname" data-rename="${esc(l.id)}" title="Double-click to rename">${esc(l.name || l.id)}</span>
      <select class="sel2 sm vfxblend" data-blend="${esc(l.id)}" title="Blend mode">
        ${BLEND_MODES.map((b) => `<option value="${b}"${(l.blend || "normal") === b ? " selected" : ""}>${b}</option>`).join("")}
      </select>
      <select class="sel2 sm vfxparent" data-parent="${esc(l.id)}" title="Parent — this layer's transform is inherited from it">
        <option value="">no parent</option>
        ${ls.filter((o) => o.id !== l.id).map((o) =>
          `<option value="${esc(o.id)}"${l.parent === o.id ? " selected" : ""}>${esc(o.name || o.id)}</option>`).join("")}
      </select>
      ${l.trackMatte?.type ? `<span class="badge vfxmatte" title="Track matte from &quot;${esc(ls[i - 1]?.name || "the layer above")}&quot;">${esc(l.trackMatte.type)}</span>` : ""}
      <button class="sttog warn" data-dellayer="${esc(l.id)}" title="Remove this layer">✕</button>
    </div>`;
  }).join("") : `<p class="hint vfxpad">No layers. Press <b>＋ layer</b> — an image or a video comes
    from the library, a solid or a text layer is made here, an adjustment layer
    applies its effects to everything beneath it, and a null exists only to be
    a parent.</p>`;
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
    nestedSection(l),
    shapeSection(l),
    transformSection(l),
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
    <p class="hint">A dot beside a parameter means the engine will animate it — 55 of the 78 take
      keyframes. None of them can be keyframed from here yet: <code>set_prop</code> resolves no path
      that reaches inside <code>shapes</code>, so there is nowhere to send one.</p>`, add);
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
 * A shape parameter.
 *
 * The catalog marks 55 of the 78 animatable and the engine evaluates every one
 * of them through the same keyframe evaluator a transform uses — but `set_prop`
 * resolves no path that reaches inside `shapes`, so there is nowhere to send a
 * keyframe. Rather than draw a stopwatch that cannot work, an animatable
 * parameter says so in its tooltip and takes a constant. One sentence at the
 * foot of the section carries the rest.
 */
function shapeParamRow(it, i, name, ps) {
  const value = it[name] === undefined ? ps.default : it[name];
  const label = ps.label || name;
  const type = ps.type || (Array.isArray(ps.default) ? "vec2" : typeof ps.default === "boolean" ? "bool" : "number");
  const range = ps.min != null && ps.max != null ? ` (${ps.min}–${ps.max})` : "";
  const tip = `${ps.desc || ""}${range}${ps.animatable ? " · animatable in the engine" : ""}`;
  return `<div class="vfxrow static">
    <span class="vfxgutter">${ps.animatable ? `<i class="vfxanimdot" title="The engine animates this one — there is no property path to keyframe it through yet.">·</i>` : ""}</span>
    <span class="vfxlab" title="${esc(tip)}">${esc(label)}${ps.unit ? `<i>${esc(ps.unit)}</i>` : ""}</span>
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
 * Transform, plus the 3D rows when the layer is in 3D.
 *
 * The toggle sits in the section header rather than in a settings list because
 * it changes what the five rows below it MEAN: on a 3D layer anchor, position
 * and scale each take a third component, and the engine defaults a missing one
 * (0 for anchor and position, 100 for scale). rotationX/Y/Z compose Rx·Ry·Rz.
 */
function transformSection(l) {
  const three = !!l.threeD;
  const isCam = l.type === "camera";
  const toggle = isCam
    ? `<span class="vfxfxgrp">3D — a camera always is</span>`
    : `<label class="edtool tog sm" title="Give this layer a Z, so a camera moves it">
         <input type="checkbox" id="vfxThreeD"${three ? " checked" : ""}>3D</label>`;
  const rows = XFORM.map(([path, label, arity, opt]) =>
    propRow(l, path, label, three && arity > 1 ? 3 : arity, opt)).join("");
  /* rotationX/Y/Z live INSIDE `transform` — that is where the engine reads them
   * from, whatever the spec's layer-level listing says, and the engine is the
   * only opinion that changes a pixel. There is deliberately no `orientation`:
   * "AE's split exists to let you animate a spin on top of a fixed pose, and one
   * set of three angles says everything two sets say". `rotation` IS rotationZ,
   * so the Z row above is the same number and is not repeated here. */
  const spatial = three ? `
    ${[["rotationX", "X rotation"], ["rotationY", "Y rotation"]].map(([k, lab]) => `
      <div class="vfxrow static"><span class="vfxgutter"></span>
        <span class="vfxlab" title="Composed Rx·Ry·Rz — Z turns first, then Y, then X">${lab}<i>°</i></span>
        <span class="vfxvals"><input type="number" data-l3="${k}" step="1" value="${num(l.transform?.[k], 0)}"></span></div>`).join("")}
    <p class="hint">Rotation above is the Z turn. ${esc(cameraNote())}</p>` : "";
  return section("Transform", rows + spatial, toggle);
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

/** Every property on this layer an analysis can be written onto. */
function drivablePaths(l) {
  const out = XFORM.map(([path, label, arity]) => ({ path, label, arity }));
  for (const e of l.effects || []) {
    const spec = V.catalog?.[e.type];
    for (const [name, ps] of Object.entries(spec?.params || {})) {
      if (!ps.animatable) continue;
      out.push({
        path: `effects.${e.id}.params.${name}`,
        label: `${spec?.label || e.type} · ${ps.label || name}`,
        arity: Array.isArray(ps.default) ? ps.default.length : 1,
      });
    }
  }
  for (const m of l.masks || []) {
    for (const k of ["feather", "opacity", "expand"]) out.push({ path: `masks.${m.id}.${k}`, label: `${m.id} · ${k}`, arity: 1 });
  }
  return out;
}

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
 * One animatable row. The stopwatch is NOT a UI flag — it is read straight off
 * the document: a property that is a `{keys:[…]}` object is animated, and one
 * that is a bare number or array is not. That means an agent that adds a key
 * over MCP lights the stopwatch here without this file knowing anything about
 * it, and there is no third state to get out of sync.
 */
function propRow(l, path, label, arity, opt = {}) {
  const prop = resolveProp(l, path);
  const anim = isAnim(prop);
  const ex = exprOf(prop);
  const val = evalProp(prop, V.t);
  const at = anim && keysOf(prop).some((k) => Math.abs(k.t - V.t) < 1e-4);
  const box = (i) => {
    const miss = i === 2 ? (opt.z ?? 0) : 0;
    const v = arity > 1 ? num(Array.isArray(val) ? val[i] : miss, miss) : num(val);
    return `<input type="number" data-pv="${esc(path)}" data-i="${i}"
      value="${Math.round(v * 1000) / 1000}" step="${opt.step ?? 1}"
      ${opt.min != null ? `min="${opt.min}"` : ""} ${opt.max != null ? `max="${opt.max}"` : ""}>`;
  };
  return `<div class="vfxrow${anim ? " anim" : ""}${ex ? " expr" : ""}" data-path="${esc(path)}">
    <span class="vfxgutter">
      <button class="vfxwatch${anim ? " on" : ""}" data-watch="${esc(path)}"
        title="${anim ? "Animated — changing a value writes a keyframe at the playhead. Click to freeze it at the current value." : "Constant. Click to animate: a keyframe is written at the playhead and every later change adds another."}">⏱</button>
      <button class="vfxfxbtn${ex ? " on" : ""}" data-exprbtn="${esc(path)}"
        title="${ex ? "Expression-driven. Click to edit or remove it." : "Add an expression — it runs every frame, on top of whatever this property already is."}">ƒx</button>
    </span>
    <span class="vfxlab">${esc(label)}${opt.unit ? `<i>${esc(opt.unit)}</i>` : ""}</span>
    <span class="vfxvals">${Array.from({ length: arity }, (_, i) => box(i)).join("")}</span>
    ${anim ? `<button class="vfxkeyat${at ? " on" : ""}" data-keyat="${esc(path)}"
        title="${at ? "There is a keyframe here — click to remove it" : "No keyframe at the playhead — click to add one"}">◆</button>` : ""}
  </div>${ex ? exprLine(ex) : ""}${V.expr === path ? exprEditor(path, ex) : ""}`;
}

/**
 * What an expression-driven property says about itself.
 *
 * The boxes above still show the value UNDERNEATH — the constant or the
 * keyframes the expression reads as `value` — because that is the only number
 * this browser can honestly produce: the sandbox is python and it runs when a
 * frame is rendered. Saying so on the row is the difference between a panel
 * that is partly true and a panel that is lying quietly.
 */
function exprLine(ex) {
  return `<p class="vfxexprline"><code>${esc(ex)}</code>
    <span>the boxes show the value underneath — an expression is evaluated when a frame is rendered, never here</span></p>`;
}

function exprEditor(path, ex) {
  return `<div class="vfxexpred" data-expred="${esc(path)}">
    <textarea id="vfxExprText" rows="2" spellcheck="false" placeholder="wiggle(2, 30)">${esc(ex || "")}</textarea>
    <div class="vfxchips">${EXPR_VOCAB.map(([c, why]) =>
      `<button type="button" class="vfxchip" data-chip="${esc(c)}" title="${esc(why)}">${esc(c)}</button>`).join("")}</div>
    <p class="hint vfxwarnline">${esc(EXPR_STATE)}</p>
    <div class="vfxexprbtns">
      <button class="btn sm" type="button" id="vfxExprOk">apply</button>
      <button class="edtool sm" type="button" id="vfxExprCancel">cancel</button>
      ${ex ? `<button class="edtool sm warn" type="button" id="vfxExprOff">remove</button>` : ""}
      <span class="hint">Removing one leaves the value underneath exactly as it was.</span>
    </div>
  </div>`;
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
  const add = `<button class="edtool sm" type="button" id="vfxAddFx">＋ effect</button>`;
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
      ${open ? `<div class="vfxfxbody">${spec?.why ? `<p class="hint">${esc(spec.why)}</p>` : ""}${rows}</div>` : ""}
    </div>`;
  }).join(""), add);
}

function fxParamRow(l, e, name, ps) {
  const path = `effects.${e.id}.params.${name}`;
  const stored = e.params?.[name];
  const value = stored === undefined ? ps.default : stored;
  const label = ps.label || name;
  const type = ps.type || (Array.isArray(ps.default) ? "point" : typeof ps.default === "boolean" ? "bool" : "number");

  if (type === "number" && ps.animatable) return propRow(l, path, label, 1, { step: ps.step ?? 0.1, min: ps.min, max: ps.max, unit: ps.unit });
  if (type === "point" && ps.animatable) return propRow(l, path, label, (Array.isArray(ps.default) ? ps.default.length : 2), { step: ps.step ?? 1, unit: ps.unit });

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
    return section("Masks", `<p class="hint">No masks. A new one starts as a rectangle inset
      from the comp — drag its numbers here; point editing on the viewer is not built yet.</p>`, add);
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
      ${propRow(l, `masks.${m.id}.feather`, "Feather", 1, { step: 1, min: 0, unit: "px" })}
      ${propRow(l, `masks.${m.id}.opacity`, "Opacity", 1, { step: 1, min: 0, max: 100, unit: "%" })}
      ${propRow(l, `masks.${m.id}.expand`, "Expand", 1, { step: 1, unit: "px" })}
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
    <button class="edtool sm${V.graph ? " on" : ""}" type="button" id="vfxGraphTog"
      title="The graph editor — keyframe values and the curve between them, with handles you can shape">◠ graph</button>
    <button class="edtool sm${V.motionPath ? " on" : ""}" type="button" id="vfxPathTog"
      title="Draw the selected layer's position track over the picture, with its spatial handles">⌒ path</button>
    <button class="edtool sm" type="button" id="vfxIn" title="Set the work area start to the playhead">in ${fmtT(V.inT)}</button>
    <button class="edtool sm" type="button" id="vfxOut" title="Set the work area end to the playhead">out ${fmtT(V.outT ?? dur())}</button>
    <label class="edtool sl sm" title="Timeline zoom">zoom
      <input type="range" id="vfxZoom" min="20" max="400" step="10" value="${V.pps}"></label>`;

  $("vfxPlay").onclick = () => (V.playing ? stop() : play());
  $("vfxPrev").onclick = () => seek(V.t - 1 / fps());
  $("vfxNext").onclick = () => seek(V.t + 1 / fps());
  $("vfxIn").onclick = () => { V.inT = Math.min(V.t, V.outT ?? dur()); paintTransport(); paintTimeline(); };
  $("vfxOut").onclick = () => { V.outT = Math.max(V.t, V.inT); paintTransport(); paintTimeline(); };
  $("vfxZoom").oninput = () => { V.pps = num($("vfxZoom").value, 90); paintTimeline(); paintGraph(); };
  $("vfxPvScale").onchange = () => { V.preview.scale = num($("vfxPvScale").value, 0.5); V.fpsSeen.length = 0; paintTransport(); };
  $("vfxPvDraft").onchange = () => { V.preview.draft = $("vfxPvDraft").checked; V.fpsSeen.length = 0; paintTransport(); };
  $("vfxGraphTog").onclick = () => toggleGraph();
  $("vfxPathTog").onclick = () => { V.motionPath = !V.motionPath; paintTransport(); paintMotionPath(); };
}

function seek(t) {
  V.t = clamp(t, 0, dur());
  paintTransport();
  paintPlayhead();
  /* The value boxes read the property AT the playhead, so moving time changes
   * what they say — that is the whole reason a compositor's panels feel alive. */
  paintProps();
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
    + `?t=${V.t.toFixed(4)}&scale=${scale}&draft=${draft ? 1 : 0}&r=${V.rev}`;
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
  const b = box.getBoundingClientRect();
  const ar = (V.comp.width || 16) / (V.comp.height || 9);
  const w = Math.max(1, Math.floor(Math.min(b.width, b.height * ar)));
  img.style.width = `${w}px`;
  img.style.height = `${Math.max(1, Math.round(w / ar))}px`;
  // The motion path is drawn in comp coordinates over this exact rectangle, so
  // it has to be re-laid the moment the rectangle changes.
  paintMotionPath();
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

/* ── the timeline ────────────────────────────────────────────────────────── */

/** Rows in document order, so the timeline and the stack always agree. */
function tlRows() {
  const out = [];
  for (const l of layers()) {
    out.push({ kind: "layer", l });
    if (V.open.has(l.id)) {
      for (const p of animatedPaths(l)) out.push({ kind: "prop", l, path: p.path, label: p.label, expr: p.expr });
    }
  }
  return out;
}

/**
 * Only MOVING properties get a timeline row — a constant has nothing to draw.
 *
 * An expression is moving whether or not there are keyframes under it, so a
 * property carrying one earns a row even when the lane will be empty of
 * diamonds: it is how you can tell, from the timeline alone, that a layer moves
 * for a reason the timeline cannot show you.
 */
function animatedPaths(l) {
  const out = [];
  const add = (path, label, v) => {
    if (isAnim(v) || hasExpr(v)) out.push({ path, label, expr: exprOf(v) });
  };
  for (const [path, label] of XFORM) add(path, label, readPath(l, path));
  for (const e of l.effects || []) {
    for (const [name, v] of Object.entries(e.params || {})) {
      add(`effects.${e.id}.params.${name}`, `${V.catalog?.[e.type]?.label || e.type} · ${name}`, v);
    }
  }
  for (const m of l.masks || []) {
    for (const k of ["feather", "opacity", "expand"]) add(`masks.${m.id}.${k}`, `${m.id} · ${k}`, m[k]);
  }
  return out;
}

function paintTimeline() {
  const rows = tlRows();
  const width = Math.max(240, dur() * V.pps + 40);
  $("vfxTl").innerHTML = `
    <div class="vfxtlbody">
      <div class="vfxtlheads">
        <div class="vfxtlcorner">${rows.length ? `${layers().length} layer${layers().length === 1 ? "" : "s"}` : ""}</div>
        ${rows.map((r) => r.kind === "layer" ? `
          <div class="vfxtlhead${r.l.id === V.sel ? " sel" : ""}" data-lid="${esc(r.l.id)}">
            <button class="vfxcaret" data-expand="${esc(r.l.id)}" title="Show this layer's animated properties">${V.open.has(r.l.id) ? "▾" : "▸"}</button>
            <span class="vfxglyph">${GLYPH[r.l.type] || "?"}</span>
            <span class="vfxlabel">${esc(r.l.name || r.l.id)}</span>
          </div>` : `
          <div class="vfxtlhead prop${V.graph?.layerId === r.l.id && V.graph?.path === r.path ? " graphed" : ""}">
            <span class="vfxlabel">${esc(r.label)}</span>${
            r.expr ? `<i class="vfxfxtag" title="${esc(r.expr)}">ƒx</i>` : ""}
            ${isAnim(readPath(r.l, r.path)) ? `<button class="vfxgopen" data-gopen="${esc(r.l.id)}|${esc(r.path)}"
              title="Open this property in the graph editor — its curve, with handles">◠</button>` : ""}</div>`).join("")}
      </div>
      <div class="vfxtlscroll" id="vfxTlScroll">
        <div class="vfxtlinner" style="width:${width}px">
          <div class="vfxruler" id="vfxRuler">${rulerTicks()}</div>
          <div class="vfxlanes" id="vfxLanes">
            ${rows.map((r) => r.kind === "layer" ? laneHtml(r.l) : propLaneHtml(r.l, r.path, r.expr)).join("")}
            ${rows.length ? "" : `<div class="vfxlane empty"><span class="hint">Nothing on the timeline yet.</span></div>`}
          </div>
          <div class="vfxwork" style="left:${V.inT * V.pps}px;width:${Math.max(0, ((V.outT ?? dur()) - V.inT)) * V.pps}px"></div>
          <div class="vfxhead2" id="vfxPlayhead" style="left:${V.t * V.pps}px"></div>
        </div>
      </div>
    </div>`;
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
  return `<div class="vfxlane" data-lane="${esc(l.id)}">
    <div class="vfxbar2${l.id === V.sel ? " sel" : ""}${l.enabled ? "" : " off"}${l.locked ? " locked" : ""}"
         data-bar="${esc(l.id)}" style="left:${a * V.pps}px;width:${Math.max(4, (b - a) * V.pps)}px">
      <i class="vfxgrip l" data-trim="${esc(l.id)}" data-edge="l"></i>
      <span class="vfxbarname">${esc(l.name || l.id)}</span>
      <i class="vfxgrip r" data-trim="${esc(l.id)}" data-edge="r"></i>
    </div>
  </div>`;
}

function propLaneHtml(l, path, expr) {
  const ks = keysOf(readPath(l, path));
  const graphed = V.graph?.layerId === l.id && V.graph?.path === path;
  return `<div class="vfxlane prop${expr ? " expr" : ""}${graphed ? " graphed" : ""}" data-lane="${esc(l.id)}"
       data-proplane="${esc(l.id)}|${esc(path)}"
       ${expr ? `title="Driven by ${esc(expr)} — an expression has no keyframes to draw"` : ""}>
    ${ks.map((k, i) => `<i class="vfxkey${Math.abs(k.t - V.t) < 1e-4 ? " at" : ""}${k.ease === "hold" ? " hold" : ""}${
        V.ksel.has(keyId(l.id, path, k.t)) ? " sel" : ""}${k.roving ? " roving" : ""}${(k.to || k.ti) ? " spatial" : ""}"
        data-key="${esc(l.id)}" data-kpath="${esc(path)}" data-ki="${i}"
        style="left:${num(k.t) * V.pps}px"
        title="${fmtT(num(k.t))} · ${esc(typeof k.ease === "object" ? "bezier" : (k.ease || "linear"))}${
          k.roving ? " · roving" : ""}${(k.to || k.ti) ? " · spatial handle" : ""} — drag to retime, click to select, double-click to delete, right-click for easing"></i>`).join("")}
  </div>`;
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
function graphablePaths(l) {
  return animatedPaths(l).filter((p) => isAnim(readPath(l, p.path)));
}

function toggleGraph() {
  if (V.graph) { V.graph = null; V.ksel.clear(); return void (paintTransport(), paintGraph()); }
  const l = selected();
  const rows = l ? graphablePaths(l) : [];
  if (!rows.length) {
    return note(l
      ? `"${l.name || l.id}" has no keyframed property yet — press a stopwatch in Properties and the graph opens on it.`
      : "Select a layer first; the graph editor works on one property at a time.");
  }
  openGraph(l.id, rows[0].path);
}

function openGraph(layerId, path) {
  V.graph = { layerId, path, mode: V.graph?.mode || "value" };
  V.gcomp = 0;
  V.open.add(layerId);
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
  const prop = l && readPath(l, g.path);
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
    const prop = readPath(l, path);
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
  const prop = l && readPath(l, MP_PROP);
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

/**
 * Writing ONE constant value, whatever it hangs off.
 *
 * §6 gives three setters and they do not overlap: `set_effect` owns an effect's
 * params, `set_mask` owns a mask's, `set_prop` owns everything else. Routing
 * here rather than at each call site means the panel code only ever knows the
 * path, and an effect param and a transform behave identically from the outside.
 */
function setValue(l, path, v, opt = {}) {
  const p = String(path).split(".");
  if (p[0] === "effects" && p[2] === "params") {
    return mutate({ action: "set_effect", slug: V.slug, layerId: l.id, fxId: p[1], params: { [p[3]]: v } }, opt);
  }
  if (p[0] === "masks") {
    return mutate({ action: "set_mask", slug: V.slug, layerId: l.id, maskId: p[1], [p[2]]: v }, opt);
  }
  return mutate({ action: "set_prop", slug: V.slug, layerId: l.id, path, value: v }, {
    ...opt,
    context: (msg) => (Array.isArray(v) && v.length === 3 && /takes 2 number/.test(msg)
      ? `${msg} A 3D layer's anchor, position and scale each take a third component and the engine `
        + `renders one, but set_prop's arity table is fixed at two — so a z already in the document `
        + `reads and animates here, and a new one cannot be typed in yet.`
      : msg),
  });
}

function wireProps() {
  const l = selected();
  if (!l) return;

  /* Animatable rows. Which action fires is decided by the document, not by a
   * flag in this file: an animated property takes a keyframe, a constant one
   * takes a value. That is the stopwatch, and it has exactly one source. */
  for (const inp of $("vfxPropsBody").querySelectorAll("[data-pv]")) {
    inp.onchange = () => {
      const path = inp.dataset.pv;
      const boxes = [...$("vfxPropsBody").querySelectorAll(`[data-pv="${CSS.escape(path)}"]`)];
      const v = boxes.length > 1 ? boxes.map((b) => num(b.value)) : num(boxes[0].value);
      /* Holding an arrow key on a number box fires a `change` per repeat —
       * roughly thirty a second — and each one is a real write. The coalesce
       * key makes the run of them ONE history entry: forty steps from one
       * gesture is a history nobody can scan, and the cap then throws away the
       * step somebody actually wanted. */
      const coalesce = `pv:${l.id}:${path}`;
      if (isAnim(resolveProp(l, path))) {
        mutate({ action: "add_key", slug: V.slug, layerId: l.id, path, t: V.t, v, ease: "linear" }, { coalesce });
      } else setValue(l, path, v, { coalesce });
    };
  }

  for (const b of $("vfxPropsBody").querySelectorAll("[data-watch]")) {
    b.onclick = () => {
      const path = b.dataset.watch;
      const prop = resolveProp(l, path);
      // Freezing keeps what you can SEE right now, not the first key's value.
      if (isAnim(prop)) setValue(l, path, evalProp(prop, V.t));
      else {
        V.open.add(l.id);
        mutate({ action: "add_key", slug: V.slug, layerId: l.id, path, t: V.t, v: prop, ease: "linear" });
      }
    };
  }

  for (const b of $("vfxPropsBody").querySelectorAll("[data-keyat]")) {
    b.onclick = () => {
      const path = b.dataset.keyat;
      const prop = resolveProp(l, path);
      const here = keysOf(prop).find((k) => Math.abs(k.t - V.t) < 1e-4);
      if (here) mutate({ action: "remove_key", slug: V.slug, layerId: l.id, path, t: here.t });
      else mutate({ action: "add_key", slug: V.slug, layerId: l.id, path, t: V.t, v: evalProp(prop, V.t), ease: "linear" });
    };
  }

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

  wireExpressions(l, q);
  wireShapes(l, q);
  wireSpatial(l, q);
  wireDrive(l);
}

/* ── expressions ─────────────────────────────────────────────────────────── */

function wireExpressions(l, q) {
  for (const b of q("[data-exprbtn]")) b.onclick = () => {
    V.expr = V.expr === b.dataset.exprbtn ? null : b.dataset.exprbtn;
    paintProps();
    $("vfxExprText")?.focus();
  };
  const box = $("vfxExprText");
  if (!box) return;
  const path = $("vfxPropsBody").querySelector("[data-expred]").dataset.expred;
  for (const c of q("[data-chip]")) c.onclick = () => {
    /* Paste at the cursor rather than replacing: an expression is usually built
     * out of two or three of these with arithmetic between them. */
    const s = box.selectionStart ?? box.value.length, e = box.selectionEnd ?? s;
    box.value = box.value.slice(0, s) + c.dataset.chip + box.value.slice(e);
    box.focus();
    box.selectionStart = box.selectionEnd = s + c.dataset.chip.length;
  };
  const send = (expr) => {
    V.expr = null;
    mutate({ action: "set_prop", slug: V.slug, layerId: l.id, path, expr });
  };
  $("vfxExprOk").onclick = () => send(box.value.trim());
  $("vfxExprCancel").onclick = () => { V.expr = null; paintProps(); };
  const off = $("vfxExprOff");
  // null, not "" — both clear it, and null is what §7 documents.
  if (off) off.onclick = () => send(null);
  box.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(box.value.trim()); }
    if (e.key === "Escape") { e.preventDefault(); V.expr = null; paintProps(); }
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
    V.slug = l.src; V.sel = null; V.t = 0; V.outT = null;
    V.open.clear(); V.fxOpen.clear(); V.itemOpen.clear();
    await loadComp();
    paint();
  };
}

function wireDrive(l) {
  const a = $("vfxAudioKeys");
  if (a) a.onclick = () => audioPanel(l);
  const m = $("vfxTrackMotion");
  if (m) m.onclick = () => trackPanel(l);
}

function reorderFx(l, fxId, delta) {
  const i = (l.effects || []).findIndex((e) => e.id === fxId);
  const to = clamp(i + delta, 0, (l.effects || []).length - 1);
  if (i < 0 || to === i) return;
  mutate({ action: "reorder_effect", slug: V.slug, layerId: l.id, fxId, toIndex: to });
}

/* ─────────────────────────────────────────── wiring: stack, timeline, keys */

function wireDelegates() {
  const root = $("vfx");

  /* One click handler for the whole tab. Rows are rebuilt on every paint, so
   * per-element listeners would have to be re-attached constantly; delegation
   * survives every repaint and there is only ever one of it. */
  root.addEventListener("click", (e) => {
    const t = e.target;
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
      V.open.has(id) ? V.open.delete(id) : V.open.add(id);
      return paintTimeline();
    }
    const gop = t.closest("[data-gopen]");
    if (gop) {
      const [lid, ...rest] = gop.dataset.gopen.split("|");
      V.sel = lid;
      V.ksel.clear();
      openGraph(lid, rest.join("|"));
      paintStack(); paintProps();
      return;
    }
    const row = t.closest("[data-lid]");
    if (row && !t.closest("select")) {
      // An open expression editor belongs to the row it was opened on, and a
      // path like transform.opacity exists on every layer — so leaving it open
      // would move it silently onto the layer you just selected.
      if (V.sel !== row.dataset.lid) V.expr = null;
      V.sel = row.dataset.lid;
      /* The motion path belongs to the SELECTED layer, so it repaints with the
       * selection and not only when a new frame arrives — selecting a layer
       * does not change the picture, so nothing else would have redrawn it and
       * the previous layer's track stayed over the viewer. */
      paintStack(); paintProps(); paintTimeline(); paintMotionPath();
      return;
    }
    if (t.id === "vfxAddLayer") return addLayerMenu();
  });

  root.addEventListener("dblclick", (e) => {
    const n = e.target.closest("[data-rename]");
    if (n) return renameInline(n);
  });

  root.addEventListener("change", (e) => {
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
    } else paintStack();
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
      const ks = keysOf(readPath(l, path));
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
      if (V.sel !== l.id) V.expr = null;
      V.sel = l.id;
      paintStack(); paintProps(); paintMotionPath();
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
    const ks = keysOf(readPath(l, key.dataset.kpath));
    const k = ks[+key.dataset.ki];
    if (k) mutate({ action: "remove_key", slug: V.slug, layerId: l.id, path: key.dataset.kpath, t: k.t });
  });

  root.addEventListener("contextmenu", (e) => {
    const key = e.target.closest("[data-key]");
    if (!key) return;
    e.preventDefault();
    easingMenu(e, key);
  });
}

/** Easing, on the key it LEAVES (§1). A menu because there are five of them. */
function easingMenu(e, key) {
  const l = layerOf(key.dataset.key);
  const path = key.dataset.kpath;
  const ks = keysOf(readPath(l, path));
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
function pathPicker(l, id) {
  const rows = drivablePaths(l);
  return `<label class="vfxfield wide">property
    <select class="sel2 sm" id="${id}">${rows.map((r) =>
      `<option value="${esc(r.path)}" data-arity="${r.arity}"${r.path === "transform.position" ? " selected" : ""}>${esc(r.label)}</option>`).join("")}
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
    if (id) { V.sel = id; paintStack(); paintProps(); paintTimeline(); }
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
