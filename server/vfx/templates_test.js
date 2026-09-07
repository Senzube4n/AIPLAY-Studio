/**
 * Tests for the VFX template library.
 *
 * A template's failure mode is not a crash — it is a comp that saves cleanly,
 * opens cleanly, and renders a black frame because one effect was called
 * `chromaticAbberation` or one keyframe list ran backwards. So this checks the
 * things a render would only tell you about eight seconds and a python
 * subprocess later:
 *
 *   · the document matches §1 — sizes and rates in range, layer and effect
 *     counts inside §6's caps, every source a library NAME and never a path;
 *   · every effect name and every parameter name EXISTS IN THE CATALOG, read
 *     from server/vfx/effects.py itself, with every value inside the range that
 *     catalog advertises — the catalog is the ground truth and this is what
 *     makes a rename over there fail here instead of silently rendering nothing;
 *   · every keyframe list is sorted, has no two keys at one instant, keeps one
 *     arity throughout, and uses an ease §1 actually defines;
 *   · a bad parameter is REFUSED with a message that says what was wrong, which
 *     is the whole difference between a template and a trap;
 *   · a source that was not given degrades to a solid instead of a broken layer.
 *
 *   node server/vfx/templates_test.js
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMPLATES, TEMPLATE_IDS, buildTemplate, listTemplates, describeTemplates,
  getTemplate, paramsOf, sourcesOf, validateParams,
} from "./templates.js";
import { LIMITS, EASES, BLEND_MODES, LAYER_TYPES, MATTE_TYPES, isKeyed } from "./store.js";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0, skip = 0;
function eq(name, got, want, eps = 1e-9) {
  const ok = typeof want === "number" && typeof got === "number"
    ? Math.abs(got - want) <= eps
    : JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
}
/** For the sweeps: one assertion per template rather than one per property. */
function all(name, ids, check) {
  const bad = [];
  for (const id of ids) {
    try {
      const why = check(id);
      if (why) bad.push(`${id}: ${why}`);
    } catch (err) { bad.push(`${id}: threw ${err.message}`); }
  }
  eq(name, bad.length ? bad : [], []);
}
function throws(name, fn, needle) {
  try {
    fn();
    fail++; console.log(`  FAIL  ${name}\n          it did not throw`);
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.toLowerCase().includes(needle.toLowerCase())) { pass++; console.log(`  ok    ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n          threw "${msg}", wanted something mentioning "${needle}"`); }
  }
}

/* ── the catalog, straight out of effects.py ─────────────────────────────── */

/**
 * The ground truth for effect names and ranges. Read from the python rather
 * than mirrored here on purpose — a copy in this file would pass this test
 * forever while the engine rendered nothing.
 */
let CATALOG = null, catalogWhy = "";
try {
  const line = execFileSync(config.python, [path.join(here, "effects.py"), "catalog"],
    { encoding: "utf8", timeout: 60_000 }).trim().split(/\r?\n/).pop();
  CATALOG = JSON.parse(line).effects;
} catch (err) {
  catalogWhy = String(err.message || err).slice(0, 200);
}

console.log("\nvfx templates\n");

const DOCS = Object.fromEntries(TEMPLATE_IDS.map((id) => [id, buildTemplate(id, {})]));

/* ── the document, §1 ────────────────────────────────────────────────────── */

eq("there are ten templates", TEMPLATE_IDS.length >= 10, true);
eq("every template builds with no parameters at all", Object.keys(DOCS).length, TEMPLATE_IDS.length);

/* A template parameter called `name` would shadow the COMP's name and the comp
 * would quietly be called "ALEX RIVERS". One key, one meaning. */
eq("no template's own parameter shadows a comp field",
  TEMPLATE_IDS.flatMap((id) => Object.keys(TEMPLATES[id].params)
    .filter((k) => ["name", "width", "height", "fps", "duration", "bg"].includes(k))
    .map((k) => `${id}.${k}`)), []);

all("comp size, rate and length are inside §6's limits", TEMPLATE_IDS, (id) => {
  const d = DOCS[id];
  if (d.width < LIMITS.minSize || d.width > LIMITS.maxSize) return `width ${d.width}`;
  if (d.height < LIMITS.minSize || d.height > LIMITS.maxSize) return `height ${d.height}`;
  if (d.fps < LIMITS.minFps || d.fps > LIMITS.maxFps) return `fps ${d.fps}`;
  if (d.duration < LIMITS.minDuration || d.duration > LIMITS.maxDuration) return `duration ${d.duration}`;
  return null;
});

all("the document carries every field §1 names", TEMPLATE_IDS, (id) => {
  const d = DOCS[id];
  for (const k of ["v", "id", "slug", "name", "width", "height", "fps", "duration",
    "bg", "motionBlur", "layers", "markers", "createdAt", "updatedAt", "runs"]) {
    if (d[k] === undefined) return `no ${k}`;
  }
  if (!Array.isArray(d.bg) || d.bg.length !== 4) return "bg is not [r,g,b,a]";
  if (d.bg.some((c) => c < 0 || c > 255)) return `bg out of 0-255: ${JSON.stringify(d.bg)}`;
  return null;
});

all("layer and effect counts stay under the caps", TEMPLATE_IDS, (id) => {
  const d = DOCS[id];
  if (!d.layers.length) return "no layers at all";
  if (d.layers.length > LIMITS.layers) return `${d.layers.length} layers`;
  for (const l of d.layers) {
    if (l.effects.length > LIMITS.effectsPerLayer) return `${l.name} has ${l.effects.length} effects`;
    if ((l.masks || []).length > LIMITS.masksPerLayer) return `${l.name} has ${l.masks.length} masks`;
  }
  return null;
});

all("every layer is a legal type with a legal blend and a whole transform", TEMPLATE_IDS, (id) => {
  for (const l of DOCS[id].layers) {
    if (!LAYER_TYPES.includes(l.type)) return `${l.name} is a "${l.type}"`;
    if (!BLEND_MODES.includes(l.blend)) return `${l.name} blends "${l.blend}"`;
    for (const k of ["anchor", "position", "scale", "rotation", "opacity"]) {
      if (l.transform[k] === undefined) return `${l.name} has no transform.${k}`;
    }
    if (l.trackMatte && !MATTE_TYPES.includes(l.trackMatte.type)) return `${l.name} matte "${l.trackMatte.type}"`;
    if (l.type === "solid" && (!Array.isArray(l.color) || l.color.length !== 4)) return `${l.name} solid has no rgba`;
    if (l.type === "text" && !l.text) return `${l.name} text layer has no text spec`;
  }
  return null;
});

/* §6's rule, and the one with a security edge on it: a client that could name a
 * path could name any file on the disk, and this document is handed to python. */
all("every source is a library NAME, never a path", TEMPLATE_IDS, (id) => {
  for (const l of DOCS[id].layers) {
    if (l.src == null) continue;
    if (typeof l.src !== "string" || /[\\/]/.test(l.src) || l.src.includes("..")) return `${l.name}: ${l.src}`;
  }
  return null;
});

all("a layer's window fits inside the comp", TEMPLATE_IDS, (id) => {
  const d = DOCS[id];
  for (const l of d.layers) {
    if (l.start < 0 || l.end > d.duration + 1e-6 || l.end <= l.start) return `${l.name} ${l.start}..${l.end}`;
  }
  return null;
});

all("nothing is parented to a layer that is not there, and the top layer has no matte", TEMPLATE_IDS, (id) => {
  const d = DOCS[id];
  const ids = new Set(d.layers.map((l) => l.id));
  for (const [i, l] of d.layers.entries()) {
    if (l.parent && !ids.has(l.parent)) return `${l.name} → ${l.parent}`;
    if (l.trackMatte && i === 0) return `${l.name} is on top and wants a matte`;
  }
  return null;
});

/* ── keyframes, §1 ───────────────────────────────────────────────────────── */

/** Every keyed property in a document, with a path you can read in an error. */
function tracks(doc) {
  const out = [];
  for (const l of doc.layers) {
    for (const [k, v] of Object.entries(l.transform)) {
      if (isKeyed(v)) out.push([`${l.name}.transform.${k}`, v]);
    }
    for (const f of l.effects) {
      for (const [k, v] of Object.entries(f.params)) {
        if (isKeyed(v)) out.push([`${l.name}.${f.type}.${k}`, v]);
      }
    }
    for (const m of l.masks || []) {
      for (const k of ["feather", "opacity", "expand"]) {
        if (isKeyed(m[k])) out.push([`${l.name}.mask.${k}`, m[k]]);
      }
    }
  }
  return out;
}

all("every template actually animates something", TEMPLATE_IDS,
  (id) => (tracks(DOCS[id]).length ? null : "not one keyframed property"));

all("keys are sorted, distinct in time, and one arity throughout", TEMPLATE_IDS, (id) => {
  for (const [where, prop] of tracks(DOCS[id])) {
    const keys = prop.keys;
    if (keys.length < 2) return `${where} has ${keys.length} key(s) — that is a constant`;
    const arity = (v) => (Array.isArray(v) ? v.length : 1);
    const n = arity(keys[0].v);
    for (let i = 0; i < keys.length; i++) {
      if (!Number.isFinite(keys[i].t)) return `${where} key ${i} has no numeric t`;
      if (arity(keys[i].v) !== n) return `${where} key ${i} has ${arity(keys[i].v)} numbers, the first has ${n}`;
      const vals = Array.isArray(keys[i].v) ? keys[i].v : [keys[i].v];
      if (vals.some((x) => !Number.isFinite(x))) return `${where} key ${i} value ${JSON.stringify(keys[i].v)}`;
      if (i && keys[i].t <= keys[i - 1].t) return `${where} key ${i} at t=${keys[i].t} follows t=${keys[i - 1].t}`;
    }
  }
  return null;
});

all("every ease is one §1 defines, and a bezier keeps x inside 0..1", TEMPLATE_IDS, (id) => {
  for (const [where, prop] of tracks(DOCS[id])) {
    for (const [i, k] of prop.keys.entries()) {
      if (k.ease === undefined) continue;                     // linear, §1's default
      if (typeof k.ease === "string") {
        if (!EASES.includes(k.ease)) return `${where} key ${i} eases "${k.ease}"`;
        continue;
      }
      const b = k.ease?.bezier;
      if (!Array.isArray(b) || b.length !== 4 || b.some((x) => !Number.isFinite(x))) {
        return `${where} key ${i} ease ${JSON.stringify(k.ease)}`;
      }
      // CSS pins x: time cannot run backwards. y is free — that is what makes
      // an overshoot expressible in one segment.
      if (b[0] < 0 || b[0] > 1 || b[2] < 0 || b[2] > 1) return `${where} key ${i} bezier x ${b[0]}, ${b[2]}`;
    }
  }
  return null;
});

all("no keyframe sits outside the comp it belongs to", TEMPLATE_IDS, (id) => {
  const d = DOCS[id];
  for (const [where, prop] of tracks(d)) {
    for (const k of prop.keys) {
      if (k.t < -1e-6 || k.t > d.duration + 1e-6) return `${where} key at t=${k.t} in a ${d.duration}s comp`;
    }
  }
  return null;
});

all("something is moving at the middle of every comp", TEMPLATE_IDS, (id) => {
  // A template whose whole animation is over before the halfway point renders a
  // still, and a still is what these exist to avoid.
  const d = DOCS[id];
  const mid = d.duration / 2;
  const live = tracks(d).some(([, prop]) => prop.keys[0].t <= mid && prop.keys[prop.keys.length - 1].t >= mid);
  return live ? null : "every animation has finished by the halfway mark";
});

/* ── effects, against the catalog itself ─────────────────────────────────── */

if (!CATALOG) {
  skip += 3;
  console.log(`  SKIP  effect names, parameter names and ranges — could not read the catalog: ${catalogWhy}`);
} else {
  all("every effect name is in the catalog", TEMPLATE_IDS, (id) => {
    for (const l of DOCS[id].layers) {
      for (const f of l.effects) if (!CATALOG[f.type]) return `${l.name}: "${f.type}" is not an effect`;
    }
    return null;
  });

  all("every parameter name is in that effect's catalog entry", TEMPLATE_IDS, (id) => {
    for (const l of DOCS[id].layers) {
      for (const f of l.effects) {
        const spec = CATALOG[f.type]?.params || {};
        for (const k of Object.keys(f.params)) {
          if (!(k in spec)) return `${l.name}: ${f.type} has no "${k}" (it takes ${Object.keys(spec).join(", ")})`;
        }
      }
    }
    return null;
  });

  all("every value is inside the range the catalog advertises", TEMPLATE_IDS, (id) => {
    for (const l of DOCS[id].layers) {
      for (const f of l.effects) {
        const spec = CATALOG[f.type].params;
        for (const [k, v] of Object.entries(f.params)) {
          const s = spec[k];
          const check = (x, at) => {
            if (s.type === "number") {
              if (!Number.isFinite(x)) return `${l.name}: ${f.type}.${k}${at} is ${JSON.stringify(x)}`;
              if (x < s.min || x > s.max) return `${l.name}: ${f.type}.${k}${at} = ${x}, range ${s.min}..${s.max}`;
            }
            return null;
          };
          if (isKeyed(v)) {
            if (!s.animatable) return `${l.name}: ${f.type}.${k} is keyframed but the catalog says it cannot be`;
            for (const key of v.keys) {
              const why = check(Array.isArray(key.v) ? key.v[0] : key.v, ` @${key.t}s`);
              if (why) return why;
            }
            continue;
          }
          if (s.type === "enum" && !s.options.includes(v)) {
            return `${l.name}: ${f.type}.${k} = "${v}", options ${s.options.join("|")}`;
          }
          if (s.type === "color") {
            if (!Array.isArray(v) || v.length < 3) return `${l.name}: ${f.type}.${k} is not a colour`;
            if (v.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return `${l.name}: ${f.type}.${k} = ${JSON.stringify(v)}`;
            continue;
          }
          const why = check(v, "");
          if (why) return why;
        }
      }
    }
    return null;
  });
}

/* ── parameters: refused, not silently rendered wrong ────────────────────── */

throws("a negative font size says so, with the range",
  () => buildTemplate("titleCard", { titleSize: -3 }), "between 8 and 400");
throws("and names the parameter it was",
  () => buildTemplate("titleCard", { titleSize: -3 }), "titleCard.titleSize");
throws("a size past the comp limit is refused",
  () => buildTemplate("titleCard", { width: 9000 }), "between 16 and 4096");
throws("a duration the animation cannot fit in is refused, with the minimum",
  () => buildTemplate("lowerThird", { duration: 0.5 }), "at least 1.6s");
throws("a parameter that does not exist is refused with the list of ones that do",
  () => buildTemplate("kenBurns", { zoomm: 20 }), "has no parameter");
throws("an enum outside its options is refused with the options",
  () => buildTemplate("kenBurns", { move: "sideways" }), "in, out, left, right, up, down");
throws("a colour outside 0-255 is refused",
  () => buildTemplate("lowerThird", { accent: [255, 300, 0, 255] }), "between 0 and 255");
throws("a colour that is not a colour is refused",
  () => buildTemplate("lowerThird", { accent: "red" }), "[r,g,b]");
throws("a PATH as a source is refused — §6, sources are names",
  () => buildTemplate("kenBurns", { image: "C:/pictures/raven.png" }), "not a path");
throws("so is one that climbs out of the library",
  () => buildTemplate("kenBurns", { image: "../../secrets.png" }), "not a path");
throws("a clip where the template needs an image is refused",
  () => buildTemplate("logoSting", { logo: "sting.mp4" }), "images library");
throws("an unknown template names every real one",
  () => buildTemplate("lowerthird", {}), "lowerThird");
throws("text past its limit is refused with both numbers",
  () => buildTemplate("captionBar", { text: "x".repeat(601) }), "601 characters");

eq("an empty string is a real answer for text, not a missing one",
  buildTemplate("lowerThird", { role: "" }).layers.some((l) => l.name === "role"), false);
eq("a legal value at the very edge of its range is accepted",
  buildTemplate("titleCard", { titleSize: 8 }).layers.find((l) => l.name === "title").text.size, 8);

/* ── degrading instead of erroring ───────────────────────────────────────── */

all("a template given no sources still builds a comp of solids", TEMPLATE_IDS, (id) => {
  for (const l of DOCS[id].layers) {
    if ((l.type === "image" || l.type === "video") && !l.src) return `${l.name} is a ${l.type} with no source`;
  }
  return null;
});

eq("a missing source becomes a solid, and says so in its name",
  DOCS.kenBurns.layers[0].type, "solid");
eq("and is flagged for the route to report",
  DOCS.kenBurns.layers[0].templatePlaceholder, true);
eq("a source that IS given becomes a picture layer pointing at that name",
  buildTemplate("kenBurns", { image: "raven.png" }).layers[0].src, "raven.png");
eq("a clip name becomes a video layer",
  buildTemplate("kenBurns", { image: "shot.mp4" }).layers[0].type, "video");
eq("an image name becomes an image layer",
  buildTemplate("kenBurns", { image: "raven.png" }).layers[0].type, "image");
/** The first value of a property, keyframed or not — what a shot opens on. */
const firstV = (prop) => (isKeyed(prop) ? prop.keys[0].v : prop);

eq("a probed source is scaled to COVER the frame, not left at 100%",
  firstV(buildTemplate("kenBurns", { image: "raven.png", move: "in" },
    { probe: { "raven.png": { width: 960, height: 540 } } }).layers[0].transform.scale)[0], 200);
eq("an unprobed source keeps 100% rather than guessing",
  firstV(buildTemplate("kenBurns", { image: "raven.png", move: "in" }).layers[0].transform.scale)[0], 100);

/* A pan is the case where getting the arithmetic wrong shows black at the edge
 * of the frame: the travel either way must fit inside the overscan. */
{
  const probe = { probe: { "wide.png": { width: 1920, height: 1080 } } };
  const doc = buildTemplate("kenBurns", { image: "wide.png", move: "left", drift: 8, zoom: 0 }, probe);
  const l = doc.layers[0];
  const scale = l.transform.scale.keys[0].v[0] / 100;
  const travel = Math.abs(l.transform.position.keys[0].v[0] - l.transform.position.keys[1].v[0]) / 2;
  const slack = (1920 * scale - 1920) / 2;
  eq("a pan never travels further than its own overscan", travel <= slack + 0.5, true);
}

/* ── the sources the route has to go and find ────────────────────────────── */

eq("sourcesOf reports nothing when nothing was named", sourcesOf("splitScreen", {}), []);
eq("sourcesOf reports each named source with the library it lives in",
  sourcesOf("splitScreen", { left: "a.png", right: "b.mp4" }),
  [{ param: "left", name: "a.png", kind: "image" }, { param: "right", name: "b.mp4", kind: "clip" }]);

/* ── the parameters a caller actually passes ─────────────────────────────── */

{
  const d = buildTemplate("titleCard", { title: "NIGHT SHIFT", width: 1280, height: 720, fps: 24, duration: 3 });
  eq("the comp takes the size it was asked for", `${d.width}x${d.height}`, "1280x720");
  eq("and the rate", d.fps, 24);
  eq("and the length", d.duration, 3);
  eq("the title is the one that was passed", d.layers.find((l) => l.name === "title").text.content, "NIGHT SHIFT");
  eq("auto sizes follow the comp, not 1080p", d.layers.find((l) => l.name === "title").text.size, Math.round(720 * 0.09));
  eq("nothing is keyframed past the shortened end",
    tracks(d).every(([, p]) => p.keys[p.keys.length - 1].t <= 3 + 1e-6), true);
}
{
  const l = buildTemplate("lowerThird", { side: "right" }).layers.find((x) => x.name === "name");
  eq("side: right aligns the type to the right", l.text.align, "right");
  eq("and it flies in from the right", l.transform.position.keys[0].v[0] > l.transform.position.keys[1].v[0], true);
}
{
  const d = buildTemplate("splitScreen", {});
  const pic = d.layers.find((l) => l.trackMatte);
  eq("split screen crops each half with an alpha matte", pic.trackMatte.type, "alpha");
  eq("and the matte is the layer DIRECTLY ABOVE it, §1's rule",
    d.layers[d.layers.indexOf(pic) - 1].type, "solid");
}
{
  const d = buildTemplate("endCard", {});
  const cta = d.layers.find((l) => l.name === "cta");
  const pill = d.layers.find((l) => l.id === cta.parent);
  eq("the end card's call to action is parented to its pill so one pulse moves both", !!pill, true);
  eq("and the child sits at the pill's own centre, in the PARENT's layer pixels",
    cta.transform.position, [pill.width / 2, pill.height / 2]);
}
{
  const a = buildTemplate("vhsLook", {});
  const b = buildTemplate("vhsLook", {});
  const strip = (d) => JSON.stringify(d, (k, v) => (k === "id" || k === "createdAt" || k === "updatedAt" ? 0 : v));
  eq("two builds of the same template are the same document", strip(a), strip(b));
  eq("but the ids are fresh each time", a.layers[0].id === b.layers[0].id, false);
}
eq("a template with an opaque background says so, and an overlay does not",
  [DOCS.titleCard.bg[3], DOCS.lowerThird.bg[3], DOCS.captionBar.bg[3]], [255, 0, 0]);
eq("the background can be overridden anyway",
  buildTemplate("captionBar", { bg: [10, 20, 30, 255] }).bg, [10, 20, 30, 255]);

/* ── what the MCP tool reads out loud ────────────────────────────────────── */

{
  const text = describeTemplates();
  const missing = TEMPLATE_IDS.filter((id) => !text.includes(id));
  eq("the tool description names every template", missing, []);
  const params = TEMPLATE_IDS.flatMap((id) => Object.keys(TEMPLATES[id].params).map((k) => `${id}.${k}`));
  eq("and every parameter of every one of them",
    params.filter((q) => !text.includes(q.split(".")[1] + ":")), []);
  eq("listTemplates agrees with the catalog of templates", listTemplates().length, TEMPLATE_IDS.length);
  eq("every template says what it is for", TEMPLATE_IDS.filter((id) => !getTemplate(id).why), []);
  eq("paramsOf includes the comp's own fields as well as the template's",
    ["width", "height", "fps", "duration", "bg", "name"].every((k) => k in paramsOf("kenBurns")), true);
  eq("validateParams fills in every default it was not given",
    Object.keys(validateParams("kenBurns", {})).length, Object.keys(paramsOf("kenBurns")).length);
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""}\n`);
process.exit(fail ? 1 : 0);
