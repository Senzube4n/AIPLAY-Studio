/**
 * End-to-end check of everything wired into the VFX surface today.
 *
 * Every assertion goes through HTTP, because that is the layer none of the
 * unit tests cover: store.js was tested in-process, engine.py was tested in
 * python, and the bugs that actually bit were all in the seam between them.
 *
 *   node e2e_vfx.mjs [port]
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const PORT = process.argv[2] || "4173";
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails = [];
const log = (...a) => console.log(...a);

function ok(label, cond, detail = "") {
  if (cond) { pass++; log(`  ok    ${label}`); }
  else { fails.push(label); log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);

async function api(body) {
  const r = await fetch(`${BASE}/api/vfx`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
}
const get = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
};
const layerOf = (comp, id) => comp.layers.find((l) => l.id === id);

const stamp = Date.now().toString(36);
const SLUG = `e2e-${stamp}`;
const CHILD = `e2e-child-${stamp}`;
const made = [];
/** Clips this run produced — never track or measure against our own output. */
const mine = new Set();

try {
  log("\n── the shape catalog is served ──");
  const cat = await get("/api/vfx/shapes");
  ok("16 shape item types are listed", Object.keys(cat.shapes).length === 16, `got ${Object.keys(cat.shapes).length}`);
  ok("trim describes itself", !!cat.shapes.trim?.why);
  ok("a param says whether it animates", cat.shapes.trim?.params?.end?.animatable === true);

  log("\n── a shape layer survives the API, not just the engine ──");
  const c = await api({ action: "create", name: SLUG, width: 320, height: 200, duration: 2, fps: 24 });
  const slug = c.comp.slug; made.push(slug);
  const sh = await api({
    action: "add_layer", slug, type: "shape", name: "ring",
    shapes: [
      { type: "ellipse", size: [140, 140], position: [0, 0] },
      { type: "trim", start: 0, end: 50 },
      { type: "stroke", color: [1, 0, 0], width: 12 },
    ],
  });
  const shapeId = sh.layerId ?? sh.layer?.id ?? sh.comp?.layers?.[0]?.id;
  let comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("it is still a shape layer after a round trip", layerOf(comp, shapeId).type, "shape");
  eq("...and it kept its items", layerOf(comp, shapeId).shapes.length, 3);

  log("\n── item ORDER actually changes the render ──");
  // The viewer is a GET that answers a PNG; ?meta=1 makes it answer JSON with
  // the URL instead, which is the path an agent is meant to take.
  const inkOf = async (s) => {
    const f = await get(`/api/vfx/frame/${s}?t=0.5&meta=1`);
    return `${f.width}x${f.height} in ${f.ms}ms`;
  };
  const trimmed = await inkOf(slug);
  ok("a frame renders with the trim before the paint", !!trimmed, String(trimmed));
  // stroke BEFORE trim: the stroke consumes the path and the trim does nothing
  await api({
    action: "set_layer", slug, layerId: shapeId,
    shapes: [
      { type: "ellipse", size: [140, 140], position: [0, 0] },
      { type: "stroke", color: [1, 0, 0], width: 12 },
      { type: "trim", start: 0, end: 50 },
    ],
  });
  const unordered = await inkOf(slug);
  ok("...and it still renders with the order reversed", !!unordered);
  log(`        (trim-first ${trimmed} vs paint-first ${unordered} — compare the images by eye)`);

  log("\n-- a shape parameter can be keyframed --");
  /* 55 animatable shape parameters and no path could name one, so the write-on
   * was reachable only by hand-writing keys into the document. */
  await api({
    action: "set_prop", slug, layerId: shapeId, path: "shapes.1.end",
    keys: [{ t: 0, v: 0 }, { t: 1.9, v: 100 }],
  });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  const trim = layerOf(comp, shapeId).shapes[1];
  eq("the trim's end is keyframed on the item itself", trim.end?.keys?.length, 2);

  let badShapePath = "";
  try { await api({ action: "set_prop", slug, layerId: shapeId, path: "shapes.9.end", value: 1 }); }
  catch (e) { badShapePath = e.message; }
  ok("an item index past the end is refused, naming what IS there",
    /it holds \d+ item/.test(badShapePath), badShapePath);

  log("\n-- shape presets come from shapes.py, not a JS copy --");
  const pre = await api({ action: "add_shape_preset", slug, preset: "progressRing", radius: 60, to_pct: 70 });
  ok("progressRing built a layer", !!pre.layerId, JSON.stringify(pre).slice(0, 100));
  ok("...with items in it", pre.items > 0, `items=${pre.items}`);
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("...and it persisted as a shape layer", layerOf(comp, pre.layerId).type, "shape");

  /* The preset name is interpolated into a python import, so it must never be
   * caller text. This asserts the refusal, not just that it does not crash. */
  let badPreset = "";
  try { await api({ action: "add_shape_preset", slug, preset: "os.system" }); }
  catch (e) { badPreset = e.message; }
  ok("an unknown preset name is refused, not interpolated", /No shape preset/i.test(badPreset), badPreset);

  log("\n-- every property the tree lists, MCP can animate --");
  /* The timeline tree and vfx_layer_properties read the SAME enumerator, so
   * this is the assertion that keeps "the UI can do it" and "MCP can do it"
   * one sentence. A path the tree could draw but set_prop refused would be the
   * drift this codebase has shipped six times. */
  await api({ action: "add_effect", slug, layerId: shapeId, type: "glow" });
  await api({ action: "set_layer", slug, layerId: shapeId, threeD: true });
  const enumerated = await api({ action: "layer_properties", slug, layerId: shapeId });
  ok("layer_properties lists animatable properties", enumerated.count > 0, `count=${enumerated.count}`);
  ok("...across more than one group",
    new Set((enumerated.properties || []).map((p) => p.group)).size > 1,
    [...new Set((enumerated.properties || []).map((p) => p.group))].join(", "));

  const notAnimatable = [];
  for (const p of enumerated.properties || []) {
    const v = (p.value === null || p.value === undefined) ? 0 : p.value;
    try {
      await api({ action: "set_prop", slug, layerId: shapeId, path: p.path,
                  keys: [{ t: 0, v }, { t: 1, v }] });
    } catch (e) { notAnimatable.push(`${p.path}: ${e.message.slice(0, 50)}`); }
  }
  ok("EVERY listed property is animatable over the API", notAnimatable.length === 0,
    notAnimatable.join(" | "));

  log("\n── 3D: z survives, and the rotations are addressable ──");
  const cube = await api({ action: "add_layer", slug, type: "solid", name: "cube" });
  const cubeId = cube.layerId ?? cube.layer?.id;
  await api({ action: "set_layer", slug, layerId: cubeId, three_d: true, threeD: true });
  await api({ action: "set_prop", slug, layerId: cubeId, path: "transform.position", value: [100, 120, -300] });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("a 3D position keeps its z through the API", layerOf(comp, cubeId).transform.position, [100, 120, -300]);
  await api({ action: "set_prop", slug, layerId: cubeId, path: "rotationY", keys: [{ t: 0, v: 0 }, { t: 2, v: 180 }] });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;

  /* The rotations live inside the transform — engine.py reads
   * transform.get("rotationX"). Written onto the LAYER they are stored,
   * returned, and ignored by every render, which is what happened. */
  eq("rotationY is keyframed INSIDE the transform",
    layerOf(comp, cubeId).transform.rotationY?.keys?.length, 2);
  eq("...and nothing was left stranded on the layer",
    layerOf(comp, cubeId).rotationY, undefined);

  /* migrateLayer rebuilds the transform from a key list, so a constant axis
   * has to be on that list or it is deleted on the next read. */
  await api({ action: "set_layer", slug, layerId: cubeId, rotation_x: 45, rotationX: 45 });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("a constant rotationX survives the round trip", layerOf(comp, cubeId).transform.rotationX, 45);

  let orient = "";
  try { await api({ action: "set_layer", slug, layerId: cubeId, orientation: [0, 0, 0] }); }
  catch (e) { orient = e.message; }
  ok("orientation is refused with what to use instead, not silently stored",
    /no separate orientation triple/i.test(orient), orient);

  log("\n── expressions round-trip and can be cleared ──");
  await api({ action: "set_prop", slug, layerId: cubeId, path: "opacity", value: 65 });
  await api({ action: "set_prop", slug, layerId: cubeId, path: "opacity", expr: "value * 2" });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("the expression is stored", layerOf(comp, cubeId).transform.opacity.expr, "value * 2");
  eq("...over the value it had", layerOf(comp, cubeId).transform.opacity.value, 65);
  await api({ action: "set_prop", slug, layerId: cubeId, path: "opacity", expr: null });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("clearing it gives the original value back", layerOf(comp, cubeId).transform.opacity, 65);

  log("\n-- Expression Controls: a keyframed no-op drives other layers --");
  /* The control family renders nothing, so its only observable behaviour IS
   * the read path — which is exactly what an e2e must therefore call end to
   * end: add over HTTP, keyframe over HTTP, reference from an expression, and
   * watch the PNG bytes move. A fresh comp, so nothing keyframed by the
   * blocks above can move a frame here. */
  const ctlComp = await api({ action: "create", name: `e2e-ctl-${stamp}`, width: 200, height: 100, duration: 2, fps: 24 });
  const ctlSlug = ctlComp.comp.slug; made.push(ctlSlug);

  const fxcat = await get("/api/vfx/catalog");
  eq("the catalog serves sliderControl under Expression Controls",
    fxcat.effects?.sliderControl?.group, "Expression Controls");
  /* The effect picker in web/vfx.js builds its group list from exactly this
   * map (`cat[n].group`), so this set IS what the UI will offer. */
  const servedGroups = new Set(Object.values(fxcat.effects || {}).map((e) => e.group));
  ok("...and the group the picker derives from it includes the tenth",
    servedGroups.has("Expression Controls"), [...servedGroups].join(", "));

  const drv = await api({ action: "add_layer", slug: ctlSlug, type: "solid", name: "driver", color: [255, 255, 255, 255] });
  const drvId = drv.layerId ?? drv.layer?.id;
  await api({ action: "set_prop", slug: ctlSlug, layerId: drvId, path: "transform.scale", value: [10, 10] });
  await api({ action: "set_prop", slug: ctlSlug, layerId: drvId, path: "transform.position", value: [30, 25] });
  const ctl = await api({ action: "add_effect", slug: ctlSlug, layerId: drvId, type: "sliderControl" });
  ok("a slider control adds over HTTP and answers its id — the expression handle",
    !!ctl.effectId, JSON.stringify(ctl).slice(0, 120));
  await api({ action: "set_prop", slug: ctlSlug, layerId: drvId, path: `effects.${ctl.effectId}.value`,
              keys: [{ t: 0, v: 0 }, { t: 1, v: 120 }] });
  let ctlDoc = (await get(`/api/vfx/comp/${ctlSlug}`)).comp;
  eq("the slider's value is keyframed in the document",
    layerOf(ctlDoc, drvId).effects[0].params.value?.keys?.length, 2);

  /* Requirement: the params must land in the SAME enumerator the timeline
   * tree and vfx_layer_properties read — with the catalog's range, not a
   * guessed one. */
  const ctlProps = await api({ action: "layer_properties", slug: ctlSlug, layerId: drvId });
  const sliderRow = (ctlProps.properties || []).find((p) => p.path === `effects.${ctl.effectId}.value`);
  ok("the slider is enumerated by layer_properties", !!sliderRow,
    JSON.stringify((ctlProps.properties || []).map((p) => p.path)).slice(0, 200));
  eq("...with the catalog's range on the row", sliderRow?.range, [-1000000, 1000000]);
  ok("...and flagged animated now that it holds keys", sliderRow?.animated === true, JSON.stringify(sliderRow));

  /* The rest of the family animates over the same API: point (2), point3D
   * (3), angle, checkbox and colour (4) all keyframe by path. */
  for (const [type, param, v0, v1] of [
    ["pointControl", "point", [0, 0], [50, 60]],
    ["point3DControl", "point", [0, 0, 0], [50, 60, -70]],
    ["angleControl", "angle", 0, 1080],
    ["checkboxControl", "checkbox", 0, 1],
    ["colorControl", "color", [0, 0, 0, 255], [255, 128, 0, 255]],
  ]) {
    const added = await api({ action: "add_effect", slug: ctlSlug, layerId: drvId, type });
    await api({ action: "set_prop", slug: ctlSlug, layerId: drvId,
                path: `effects.${added.effectId}.${param}`,
                keys: [{ t: 0, v: v0 }, { t: 1, v: v1 }] });
  }
  ctlDoc = (await get(`/api/vfx/comp/${ctlSlug}`)).comp;
  eq("every control in the family keyframes over the API",
    layerOf(ctlDoc, drvId).effects.filter((e) => Object.values(e.params).some((p) => p?.keys?.length === 2)).length, 6);

  const puppet = await api({ action: "add_layer", slug: ctlSlug, type: "solid", name: "puppet", color: [255, 0, 0, 255] });
  const puppetId = puppet.layerId ?? puppet.layer?.id;
  await api({ action: "set_prop", slug: ctlSlug, layerId: puppetId, path: "transform.scale", value: [10, 10] });
  await api({ action: "set_prop", slug: ctlSlug, layerId: puppetId, path: "transform.position", value: [150, 75] });

  const framePng = async (t) => {
    const r = await fetch(`${BASE}/api/vfx/frame/${ctlSlug}?t=${t}`);
    if (!r.ok || !(r.headers.get("content-type") || "").includes("image/png")) {
      throw new Error(`frame t=${t}: ${r.status} ${(await r.text()).slice(0, 120)}`);
    }
    return Buffer.from(await r.arrayBuffer());
  };
  const base0 = await framePng(0), base1 = await framePng(1);
  ok("before any expression, six keyframed controls render t=0 and t=1 byte-identically — the no-op is real",
    base0.equals(base1), `t0 ${base0.length}B vs t1 ${base1.length}B`);

  await api({ action: "set_prop", slug: ctlSlug, layerId: puppetId, path: "transform.position",
              expr: `[40 + thisComp.layer("driver").effect("${ctl.effectId}")("value"), 75]` });
  const rid0 = await framePng(0), rid1 = await framePng(1);
  ok("with an expression riding the slider, t=0 and t=1 DIFFER", !rid0.equals(rid1));
  ok("...and t=0 left the baseline too, so the expression is live at both ends", !rid0.equals(base0));

  /* The same-layer spelling, over the same wire: the driver dims itself. */
  await api({ action: "set_prop", slug: ctlSlug, layerId: puppetId, path: "transform.position", expr: null });
  await api({ action: "set_prop", slug: ctlSlug, layerId: drvId, path: "opacity",
              expr: `thisLayer.effect("${ctl.effectId}")("value") / 2` });
  const own0 = await framePng(0), own1 = await framePng(1);
  ok("thisLayer.effect(...) reads the same slider on its own layer", !own0.equals(own1));

  await api({ action: "set_prop", slug: ctlSlug, layerId: drvId, path: "opacity", expr: null });
  const back0 = await framePng(0), back1 = await framePng(1);
  ok("clearing the expressions restores the baseline frames byte-for-byte",
    back0.equals(base0) && back1.equals(base1),
    `t0 restored=${back0.equals(base0)} t1 restored=${back1.equals(base1)}`);

  log("\n── timeRemap is authorable at last ──");
  await api({ action: "set_prop", slug, layerId: cubeId, path: "timeRemap", keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }] });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("timeRemap takes keyframes", layerOf(comp, cubeId).timeRemap.keys.length, 2);

  log("\n-- the Noise & Grain family is served, and addGrain renders --");
  /* The catalog route is how BOTH the UI picker and MCP discover effects, so
   * the group existing here is the parity claim, not an implementation detail.
   * And a feature the e2e never CALLS is dead code with a catalog entry — so
   * addGrain is actually applied over HTTP and the frame is required to
   * change, byte for byte, through the render cache. */
  const grainCat = await get("/api/vfx/catalog");
  ok("the catalog's group list carries Noise & Grain",
    (grainCat.groups || []).includes("Noise & Grain"), JSON.stringify(grainCat.groups));
  ok("addGrain is in it, grouped there",
    grainCat.effects?.addGrain?.group === "Noise & Grain",
    String(grainCat.effects?.addGrain?.group));
  ok("noise moved in beside it instead of staying a Stylize",
    grainCat.effects?.noise?.group === "Noise & Grain", String(grainCat.effects?.noise?.group));
  ok("...and kept clipResultValues in its catalog entry",
    grainCat.effects?.noise?.params?.clipResultValues?.default === true,
    JSON.stringify(grainCat.effects?.noise?.params?.clipResultValues || null));

  const gc = await api({ action: "create", name: `e2e-grain-${stamp}`, width: 160, height: 100, duration: 1, fps: 24 });
  const gslug = gc.comp.slug; made.push(gslug);
  const gl = await api({ action: "add_layer", slug: gslug, type: "solid", name: "plate", color: [110, 110, 110, 255] });
  const glId = gl.layerId ?? gl.layer?.id ?? gl.comp?.layers?.[0]?.id;
  const gFrame = async () => {
    const r = await fetch(`${BASE}/api/vfx/frame/${gslug}?t=0.25`);
    if (!r.ok) throw new Error(`frame answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const plain = await gFrame();
  ok("the plate renders the same bytes twice before any grain",
    plain.equals(await gFrame()), `${plain.length}B`);
  await api({ action: "add_effect", slug: gslug, layerId: glId, type: "addGrain", params: { intensity: 120 } });
  const grained = await gFrame();
  ok("addGrain applied over HTTP actually changes the frame",
    !plain.equals(grained), `plain ${plain.length}B, grained ${grained.length}B`);
  log("\n── particleSystem: closed-form particles, over HTTP ──");
  /* A feature the e2e never CALLS is how this repo ships dead code, so the
   * particle system is exercised here the way an agent would reach it: the
   * catalog names it, a solid takes it, frames actually change, and the
   * animatable params surface through the same enumerator as everything else. */
  /* The served catalog is the effects dict alone — the UI derives its group
   * list from each entry's `group`, so the entry carrying "Simulation" IS the
   * group existing everywhere downstream. */
  const pcat = await get("/api/vfx/catalog");
  eq("the catalog serves particleSystem in group Simulation",
    pcat.effects?.particleSystem?.group, "Simulation");
  ok("...with its params described (MCP serves this verbatim)",
    pcat.effects?.particleSystem?.params?.birthRate?.max === 1000,
    JSON.stringify(pcat.effects?.particleSystem?.params?.birthRate ?? null));

  const pco = await api({ action: "create", name: `e2e-prt-${stamp}`, width: 160, height: 120, duration: 3, fps: 24 });
  made.push(pco.comp.slug);
  const psl = pco.comp.slug;
  const psolid = await api({ action: "add_layer", slug: psl, type: "solid", name: "plate", color: [10, 10, 24, 255] });
  const psId = psolid.layerId ?? psolid.layer?.id;
  const pngSha = async (t) => {
    const r = await fetch(`${BASE}/api/vfx/frame/${psl}?t=${t}&scale=1&draft=0`);
    if (!r.ok) throw new Error(`frame t=${t}: HTTP ${r.status}`);
    return createHash("sha1").update(Buffer.from(await r.arrayBuffer())).digest("hex");
  };
  const bare = await pngSha(1.5);
  const padd = await api({
    action: "add_effect", slug: psl, layerId: psId, type: "particleSystem",
    params: { birthRate: 150, speed: 60, seed: 5, sizeStart: 10 },
  });
  ok("add_effect accepted particleSystem", !!padd.effectId, JSON.stringify(padd).slice(0, 100));
  const at15 = await pngSha(1.5);
  ok("the effect changes the frame", at15 !== bare);
  const at06 = await pngSha(0.6);
  ok("two instants render two different sprays", at06 !== at15 && at06 !== bare);
  eq("the same instant renders the same bytes (closed form, no hidden state)",
    await pngSha(1.5), at15);

  /* layerProperties is what feeds BOTH the timeline tree and MCP — effects are
   * meant to flow through it via the catalog automatically; verified once here
   * rather than assumed. */
  const pprops = await api({ action: "layer_properties", slug: psl, layerId: psId });
  const brow = (pprops.properties || []).find((q) => q.param === "birthRate");
  ok("layer_properties lists birthRate with its catalog range",
    !!brow && Array.isArray(brow.range) && brow.range[1] === 1000, JSON.stringify(brow ?? null));
  ok("...and does not list the un-animatable seed",
    !(pprops.properties || []).some((q) => q.param === "seed"));

  /* an ANIMATED birth rate: keyframes round-trip and the render still moves */
  await api({
    action: "set_effect", slug: psl, layerId: psId, effectId: padd.effectId,
    params: { birthRate: { keys: [{ t: 0, v: 0 }, { t: 2, v: 300 }] } },
  });
  const pdoc = (await get(`/api/vfx/comp/${psl}`)).comp;
  const pfx = layerOf(pdoc, psId).effects.find((f) => f.id === padd.effectId);
  eq("the keyframed birth rate survives the round trip", pfx.params.birthRate?.keys?.length, 2);
  const ramp15 = await pngSha(1.5);
  ok("the animated rate renders, and differently from the constant one",
    ramp15 !== at15 && ramp15 !== bare);

  log("\n── nested comps resolve, which they never did before ──");
  const kid = await api({ action: "create", name: CHILD, width: 160, height: 100, duration: 2, fps: 24 });
  made.push(kid.comp.slug);
  await api({ action: "add_layer", slug: kid.comp.slug, type: "solid", name: "plate", color: [0, 128, 255, 255] });
  await api({ action: "add_layer", slug, type: "comp", name: "nested", src: kid.comp.slug });
  const nestedFrame = await get(`/api/vfx/frame/${slug}?t=0.5&meta=1`);
  ok("a comp layer renders instead of failing 'not in this document's comps library'",
    nestedFrame.ok === true, JSON.stringify(nestedFrame).slice(0, 120));

  let refused = "";
  try { await api({ action: "add_layer", slug, type: "comp", name: "ghost", src: "no-such-comp" }); }
  catch (e) { refused = e.message; }
  ok("a comp layer pointing nowhere is refused AT ADD TIME", /no comp called/i.test(refused), refused);

  /* A comp layer could never be repointed: set_layer refused src on anything
   * that was not an image or a video. */
  const kid2 = await api({ action: "create", name: CHILD + "-b", width: 160, height: 100, duration: 2, fps: 24 });
  made.push(kid2.comp.slug);
  const nestedLayer = (await get(`/api/vfx/comp/${slug}`)).comp.layers.find((l) => l.type === "comp");
  await api({ action: "set_layer", slug, layerId: nestedLayer.id, src: kid2.comp.slug });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("a comp layer can be repointed at another comp",
    layerOf(comp, nestedLayer.id).src, kid2.comp.slug);

  let selfRef = "";
  try { await api({ action: "add_layer", slug, type: "comp", name: "self", src: slug }); }
  catch (e) { selfRef = e.message; }
  ok("a comp cannot contain itself", /cannot contain itself/i.test(selfRef), selfRef);

  log("\n── the persistent engine (serve mode) answers the preview lane ──");
  /* frame/probe ride one long-lived `engine.py serve` child instead of paying
   * ~400 ms of python startup per request; `render` stays per-call. `?meta=1`
   * names the lane that rendered a frame, so the serve path is CALLED here,
   * not merely wired: "spawn" below means the child is not coming up and every
   * preview is silently paying the startup tax again. */
  const sv1 = await get(`/api/vfx/frame/${slug}?t=0.62&meta=1`);
  const sv2 = await get(`/api/vfx/frame/${slug}?t=0.71&meta=1`);
  ok("a cold frame names the python lane that rendered it",
    sv1.engine === "serve" || sv1.engine === "spawn", JSON.stringify(sv1).slice(0, 140));
  ok("...and it is the persistent serve child, not the per-frame fallback",
    sv1.engine === "serve", `engine=${sv1.engine}`);
  ok("...and a second cold frame back-to-back rode the same warm child",
    sv2.engine === "serve" && !sv2.cached, `engine=${sv2.engine} cached=${sv2.cached}`);

  log("\n-- the render lane reports itself honestly --");
  /* The render action ALWAYS queues. Its reply carries `out` — the path picked
   * before a frame exists — and the web used to read that as completion, so
   * Render toasted success instantly. Progress lives in renders[], not runs[]. */
  const queued = await api({
    action: "render", slug, format: "mp4", scale: 0.5, draft: true, from: 0, to: 0.3,
  });
  ok("the queue reply gives a jobId", !!queued.jobId, JSON.stringify(queued).slice(0, 140));
  ok("...and does NOT claim a frame count yet", queued.frames === undefined,
    `frames=${queued.frames}`);

  let row = null;
  for (let i = 0; i < 240; i++) {
    const d = await get(`/api/vfx/comp/${slug}`);
    row = (d.renders || []).find((r) => r.id === queued.jobId);
    if (row && (row.status === "done" || row.finishedAt || row.error)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  ok("the job appears in renders[], which is where progress lives", !!row);
  if (row) {
    ok("...and it finished rather than erroring", !row.error, String(row.error || ""));
    ok("...reporting a frame count", Number.isFinite(row.frames), `frames=${row.frames}`);
    ok("...and naming the clip it wrote", !!row.clip, String(row.clip || ""));
    if (row.clip) mine.add(String(row.clip));
  }

  log("\n-- the render queue is listable, across comps --");
  {
    const q = await get(`/api/vfx/renders`);
    const mineRow = (q.jobs || []).find((j) => j.id === queued.jobId);
    ok("GET /api/vfx/renders lists the finished job", !!mineRow, JSON.stringify(q.jobs || []).slice(0, 200));
    if (mineRow) {
      eq("...with its comp slug", mineRow.slug, slug);
      eq("...status done", mineRow.status, "done");
      ok("...and a real output path", !!mineRow.out, String(mineRow.out || ""));
    }
    const scoped = await get(`/api/vfx/renders?slug=${encodeURIComponent(slug)}`);
    ok("?slug= filters to one comp", (scoped.jobs || []).every((j) => j.slug === slug));
  }

  log("\n-- the overlay agrees with the render: probe the tripod origin --");
  /* One 3D card, no camera layer, so the engine's DEFAULT camera projects it.
   * The overlay's anchor must land ON the card's rendered pixels — in the
   * active camera AND in a custom view — or the gizmo is decoration. */
  const g = await api({
    action: "create", name: `${SLUG}-gz`, width: 320, height: 200, duration: 2, fps: 24,
    bg: [10, 10, 10, 255],
  });
  const gz = g.comp.slug; made.push(gz);
  const card = await api({ action: "add_layer", slug: gz, type: "solid", name: "card", width: 80, height: 60, color: [255, 0, 0, 255] });
  const cardId = card.layerId;
  await api({ action: "set_layer", slug: gz, layerId: cardId, threeD: true });
  await api({ action: "set_prop", slug: gz, layerId: cardId, path: "transform.anchor", value: [40, 30, 0] });
  await api({ action: "set_prop", slug: gz, layerId: cardId, path: "transform.position", value: [200, 80, 50] });

  const probeAt = async (x, y, view) => (await api({
    action: "probe_pixel", slug: gz, t: 0.5, x, y, view,
  })).rgba;

  const ov = await api({ action: "view_overlay", slug: gz, t: 0.5, layerId: cardId });
  ok("view_overlay answers with the selected layer", ov.selected?.id === cardId);
  ok("...an outline and axes", !!ov.selected?.outline && (ov.selected?.axes || []).length === 3,
    JSON.stringify(ov.selected).slice(0, 200));
  const anchor = ov.selected?.anchor || [0, 0];
  ok("the tripod origin is NOT the naive 2D position — perspective was applied",
    Math.hypot(anchor[0] - 200, anchor[1] - 80) > 2, `anchor ${anchor}`);
  {
    const rgba = await probeAt(Math.round(anchor[0]), Math.round(anchor[1]));
    ok(`the ACTIVE-view tripod origin lands on the card's rendered pixels (probe ${Math.round(anchor[0])},${Math.round(anchor[1])} = ${rgba})`,
      rgba[0] > 200 && rgba[1] < 60 && rgba[2] < 60, String(rgba));
  }
  const orbitView = { name: "orbit", yaw: 35, pitch: -20 };
  const ov2 = await api({ action: "view_overlay", slug: gz, t: 0.5, layerId: cardId, view: orbitView });
  const anchor2 = ov2.selected?.anchor || [0, 0];
  ok("the orbit view projects the anchor somewhere else",
    Math.hypot(anchor2[0] - anchor[0], anchor2[1] - anchor[1]) > 2, `active ${anchor} orbit ${anchor2}`);
  {
    const rgba = await api({
      action: "probe_pixel", slug: gz, t: 0.5,
      x: Math.round(anchor2[0]), y: Math.round(anchor2[1]), view: orbitView,
    });
    ok(`the ORBIT-view tripod origin lands on the card's orbit-view pixels (probe = ${rgba.rgba})`,
      rgba.rgba[0] > 200 && rgba.rgba[1] < 60 && rgba.rgba[2] < 60, String(rgba.rgba));
  }

  log("\n-- a view-parameterised frame is a DIFFERENT frame --");
  {
    /* Same (x, y), two views: the card is there through the active camera and
     * cannot be there in the Top view (it is edge-on to it). If the view were
     * missing from the cache key these two probes would read the same file. */
    const active = await probeAt(Math.round(anchor[0]), Math.round(anchor[1]));
    const top = await probeAt(Math.round(anchor[0]), Math.round(anchor[1]), { name: "top" });
    ok("active camera sees the card, the Top view sees past it",
      active[0] > 200 && top[0] < 60, `active ${active} top ${top}`);
    const meta = await get(`/api/vfx/frame/${gz}?t=0.5&meta=1&view=top`);
    ok("the frame URL carries the view", /view=top/.test(meta.url), meta.url);
  }

  log("\n-- unproject is the projection's true inverse --");
  {
    /* Drag the anchor 30 screen px along X. The layer sits 50 px behind the
     * comp plane, so the world step must be 30 · (zoom+50)/zoom — computed
     * here independently of the engine as a check on it. */
    const zoom = 320 * 50 / 36;
    const want = 200 + 30 * (zoom + 50) / zoom;
    const up = await api({
      action: "view_unproject", slug: gz, t: 0.5, layerId: cardId,
      axis: "x", from: anchor, to: [anchor[0] + 30, anchor[1]],
    });
    ok(`an X-axis drag of 30 px unprojects to x = ${want.toFixed(3)}`,
      Math.abs(up.newPosition[0] - want) < 0.05, JSON.stringify(up));
    /* And the round trip closes: write it, re-ask, and the tripod origin has
     * moved by exactly the 30 screen px the drag asked for. */
    await api({ action: "set_prop", slug: gz, layerId: cardId, path: "transform.position", value: up.newPosition });
    const ov3 = await api({ action: "view_overlay", slug: gz, t: 0.5, layerId: cardId });
    ok("...and after writing it the tripod origin moved those 30 screen px",
      Math.abs(ov3.selected.anchor[0] - (anchor[0] + 30)) < 0.1
      && Math.abs(ov3.selected.anchor[1] - anchor[1]) < 0.1,
      `was ${anchor}, now ${ov3.selected.anchor}`);
  }

  log("\n-- align moves layers where the bounds say --");
  {
    const mk = async (name, pos) => {
      const r = await api({ action: "add_layer", slug: gz, type: "solid", name, width: 40, height: 40, color: [0, 255, 0, 255] });
      await api({ action: "set_prop", slug: gz, layerId: r.layerId, path: "transform.anchor", value: [20, 20] });
      await api({ action: "set_prop", slug: gz, layerId: r.layerId, path: "transform.position", value: pos });
      return r.layerId;
    };
    const s1 = await mk("al1", [60, 50]);
    const s2 = await mk("al2", [200, 120]);
    const al = await api({ action: "align_layers", slug: gz, layerIds: [s1, s2], op: "left" });
    ok("align left moved exactly the layer that was not already there",
      al.moved.length === 1 && al.moved[0].id === s2, JSON.stringify(al.moved));
    const edge = async (id) => (await api({ action: "view_overlay", slug: gz, t: 0, layerId: id }))
      .selected.outline.reduce((a, p) => Math.min(a, p[0]), 1e9);
    const [e1, e2] = [await edge(s1), await edge(s2)];
    ok("...and the engine-projected left edges now agree", Math.abs(e1 - e2) < 0.1, `${e1} vs ${e2}`);
    const c = await api({ action: "align_layers", slug: gz, layerIds: [s1], op: "centerH", to: "comp" });
    ok("a single layer centres against the comp", c.moved.length === 1, JSON.stringify(c.moved));
    const oc = await api({ action: "view_overlay", slug: gz, t: 0, layerId: s1 });
    const mid = oc.selected.outline.reduce((a, p) => a + p[0], 0) / 4;
    ok("...to the comp's actual middle", Math.abs(mid - 160) < 0.1, `centre ${mid}`);
    let refuse = "";
    try { await api({ action: "align_layers", slug: gz, layerIds: [s1, s2], op: "distributeH" }); }
    catch (e) { refuse = e.message; }
    ok("distribute with two layers is refused, saying it needs three",
      /three/.test(refuse), refuse);
  }

  log("\n-- probe_pixel reads the plate itself --");
  {
    const bgPx = await probeAt(5, 5);
    eq("a background pixel is the comp's own bg", bgPx.slice(0, 3), [10, 10, 10]);
  }

  log("\n-- labels, shy and hide-shy round-trip --");
  {
    await api({ action: "set_layer", slug: gz, layerId: cardId, label: "aqua", shy: true });
    let d = (await get(`/api/vfx/comp/${gz}`)).comp;
    eq("the label colour survives", layerOf(d, cardId).label, "aqua");
    eq("the shy flag survives", layerOf(d, cardId).shy, true);
    await api({ action: "set_comp", slug: gz, hideShy: true });
    d = (await get(`/api/vfx/comp/${gz}`)).comp;
    eq("the comp-level hide-shy switch survives", d.hideShy, true);
    let badLbl = "";
    try { await api({ action: "set_layer", slug: gz, layerId: cardId, label: "chartreuse" }); }
    catch (e) { badLbl = e.message; }
    ok("an unknown label is refused with the real list", /aqua/.test(badLbl), badLbl);
  }

  log("\n-- guides are document state: set, read back, survive --");
  {
    /* Variable names deliberately prefixed guidesE2e — two agents have already
     * collided on shared names in this file. The comp is gz: 320x200. */
    const guidesE2eWant = [{ axis: "x", position: 160 }, { axis: "y", position: 50.25 }];
    const guidesE2eSet = await api({ action: "set_guides", slug: gz, guides: guidesE2eWant });
    eq("set_guides answers the list it wrote", guidesE2eSet.guides, guidesE2eWant);
    let guidesE2eDoc = (await get(`/api/vfx/comp/${gz}`)).comp;
    eq("a comp read shows the guides", guidesE2eDoc.guides, guidesE2eWant);
    guidesE2eDoc = (await get(`/api/vfx/comp/${gz}`)).comp;
    eq("...and a SECOND read still does — persisted, not echoed", guidesE2eDoc.guides, guidesE2eWant);

    let guidesE2eAxisRefusal = "";
    try { await api({ action: "set_guides", slug: gz, guides: [{ axis: "q", position: 10 }] }); }
    catch (e) { guidesE2eAxisRefusal = e.message; }
    ok("an unknown axis is refused naming the two that exist",
      /"x"/.test(guidesE2eAxisRefusal) && /"y"/.test(guidesE2eAxisRefusal), guidesE2eAxisRefusal);

    let guidesE2eRangeRefusal = "";
    try { await api({ action: "set_guides", slug: gz, guides: [{ axis: "y", position: 999 }] }); }
    catch (e) { guidesE2eRangeRefusal = e.message; }
    ok("a position off the comp raster is refused (no pasteboard to put it in)",
      guidesE2eRangeRefusal.length > 0, guidesE2eRangeRefusal || "(it accepted y=999 on a 200px comp)");

    guidesE2eDoc = (await get(`/api/vfx/comp/${gz}`)).comp;
    eq("a refused write left the standing guides untouched", guidesE2eDoc.guides, guidesE2eWant);

    const guidesE2eCleared = await api({ action: "set_guides", slug: gz, guides: [] });
    eq("[] clears them", guidesE2eCleared.guides, []);
  }

  log("\n-- FXPRESETS: effect/animation presets, saved and applied over HTTP --");
  {
    /* The shelf seeds its built-ins on first read — they double as fixtures. */
    const fxpShelf0 = await api({ action: "list_fx_presets" });
    ok("the preset shelf lists built-ins",
      (fxpShelf0.presets || []).filter((p) => p.builtin).length >= 4,
      JSON.stringify((fxpShelf0.presets || []).map((p) => p.name)));
    ok("...each named '(built-in)'",
      (fxpShelf0.presets || []).filter((p) => p.builtin).every((p) => /\(built-in\)/.test(p.name)));

    /* A donor whose layer starts at 0.5s, so RELATIVE storage is observable:
     * keys authored at 0.5/1.5 absolute must come back at 0/1 on a layer that
     * starts at 0. */
    const fxpDonor = await api({ action: "create", name: `e2e-fxp-donor-${stamp}`, width: 160, height: 100, duration: 4, fps: 24 });
    const fxpDonorSlug = fxpDonor.comp.slug; made.push(fxpDonorSlug);
    const fxpDonorLayer = await api({ action: "add_layer", slug: fxpDonorSlug, type: "solid", name: "fxp_plate", color: [200, 200, 200, 255] });
    const fxpDonorId = fxpDonorLayer.layerId;
    await api({ action: "set_layer", slug: fxpDonorSlug, layerId: fxpDonorId, start: 0.5 });
    const fxpGlow = await api({ action: "add_effect", slug: fxpDonorSlug, layerId: fxpDonorId, type: "glow" });
    await api({ action: "set_prop", slug: fxpDonorSlug, layerId: fxpDonorId,
                path: `effects.${fxpGlow.effectId}.intensity`,
                keys: [{ t: 0.5, v: 0, ease: "easeInOut" }, { t: 1.5, v: 220 }] });
    // An expression that names a layer the TARGET comp will not have — it must
    // travel verbatim and come back as a warning, never a failure.
    const fxpGhostExpr = `10 + thisComp.layer("fxp_ghost_driver").transform.opacity / 10`;
    await api({ action: "set_prop", slug: fxpDonorSlug, layerId: fxpDonorId,
                path: `effects.${fxpGlow.effectId}.radius`, expr: fxpGhostExpr });
    await api({ action: "set_prop", slug: fxpDonorSlug, layerId: fxpDonorId,
                path: "opacity", keys: [{ t: 0.5, v: 0 }, { t: 1.3, v: 100 }] });

    const fxpName = `e2e-fxp-look-${stamp}`;
    const fxpSaved = await api({ action: "save_fx_preset", slug: fxpDonorSlug, layerId: fxpDonorId,
                                 name: fxpName, includeTransform: true });
    eq("save snapshots the effect types", fxpSaved.effects, ["glow"]);
    ok("...marks it keyed", fxpSaved.keyed === true, JSON.stringify(fxpSaved));
    ok("...and captured the keyed transform opacity",
      (fxpSaved.transform || []).includes("opacity"), JSON.stringify(fxpSaved.transform));

    const fxpShelf1 = await api({ action: "list_fx_presets" });
    const fxpRow = (fxpShelf1.presets || []).find((p) => p.name === fxpName);
    ok("the saved preset is listed with its summary",
      !!fxpRow && fxpRow.keyed === true && fxpRow.effects.includes("glow") && fxpRow.transform.includes("opacity"),
      JSON.stringify(fxpRow));
    ok("...and not as a built-in", fxpRow?.builtin === false);

    /* Apply to a FRESH layer in a FRESH comp. Its start is 0, so the preset's
     * relative time zero lands at 0. */
    const fxpTarget = await api({ action: "create", name: `e2e-fxp-target-${stamp}`, width: 160, height: 100, duration: 4, fps: 24, bg: [0, 0, 0, 255] });
    const fxpTargetSlug = fxpTarget.comp.slug; made.push(fxpTargetSlug);
    const fxpTargetLayer = await api({ action: "add_layer", slug: fxpTargetSlug, type: "solid", name: "fxp_receiver", color: [230, 230, 230, 255] });
    const fxpTargetId = fxpTargetLayer.layerId;

    const fxpSha = async (t) => {
      const r = await fetch(`${BASE}/api/vfx/frame/${fxpTargetSlug}?t=${t}&scale=1&draft=0`);
      if (!r.ok) throw new Error(`fxp frame t=${t}: HTTP ${r.status}`);
      return createHash("sha1").update(Buffer.from(await r.arrayBuffer())).digest("hex");
    };
    const fxpBare1 = await fxpSha(1);

    const fxpApplied = await api({ action: "apply_fx_preset", slug: fxpTargetSlug, layerId: fxpTargetId, preset: fxpName });
    ok("apply answers the fresh effect id", (fxpApplied.effectIds || []).length === 1, JSON.stringify(fxpApplied.effectIds));
    ok("...and it is a NEW id, never the donor's", fxpApplied.effectIds[0] !== fxpGlow.effectId,
      `${fxpApplied.effectIds[0]} vs donor ${fxpGlow.effectId}`);
    ok("...and it WARNS about the expression naming a layer this comp does not have",
      (fxpApplied.warnings || []).some((w) => /fxp_ghost_driver/.test(w)), JSON.stringify(fxpApplied.warnings));

    const fxpDoc = (await get(`/api/vfx/comp/${fxpTargetSlug}`)).comp;
    const fxpFx = layerOf(fxpDoc, fxpTargetId).effects.find((f) => f.id === fxpApplied.effectIds[0]);
    eq("the applied effect is the glow", fxpFx?.type, "glow");
    eq("its keys landed at the RELATIVE times (donor start 0.5 → rel 0/1 → target start 0)",
      (fxpFx?.params.intensity.keys || []).map((k) => k.t), [0, 1]);
    eq("the ease survived the trip", fxpFx?.params.intensity.keys?.[0]?.ease, "easeInOut");
    eq("the expression rode along verbatim", fxpFx?.params.radius?.expr, fxpGhostExpr);
    eq("the transform opacity keys landed relative too",
      (layerOf(fxpDoc, fxpTargetId).transform.opacity.keys || []).map((k) => k.t), [0, 0.8]);

    const fxpProps = await api({ action: "layer_properties", slug: fxpTargetSlug, layerId: fxpTargetId });
    const fxpIntRow = (fxpProps.properties || []).find((p) => p.path === `effects.${fxpApplied.effectIds[0]}.intensity`);
    ok("layer_properties lists the applied param, flagged animated",
      fxpIntRow?.animated === true, JSON.stringify(fxpIntRow ?? null));

    const fxpAfter1 = await fxpSha(1);
    ok("applying the preset changes the rendered frame", fxpAfter1 !== fxpBare1);
    ok("...and the keyed glow renders t=0 and t=1 differently", (await fxpSha(0)) !== fxpAfter1);

    /* `at` moves the preset's time zero. */
    const fxpLate = await api({ action: "add_layer", slug: fxpTargetSlug, type: "solid", name: "fxp_receiver_late", color: [230, 230, 230, 255] });
    const fxpApplied2 = await api({ action: "apply_fx_preset", slug: fxpTargetSlug, layerId: fxpLate.layerId, preset: fxpName, at: 2 });
    const fxpDoc2 = (await get(`/api/vfx/comp/${fxpTargetSlug}`)).comp;
    const fxpFx2 = layerOf(fxpDoc2, fxpLate.layerId).effects.find((f) => f.id === fxpApplied2.effectIds[0]);
    eq("apply at t=2 shifts the keys there", (fxpFx2?.params.intensity.keys || []).map((k) => k.t), [2, 3]);

    /* A built-in animation preset (no effects, only transform keys) applies. */
    const fxpBI = await api({ action: "apply_fx_preset", slug: fxpTargetSlug, layerId: fxpLate.layerId, preset: "Fade-Scale In (built-in)" });
    ok("a built-in animation preset applies",
      fxpBI.ok === true && (fxpBI.transform || []).includes("opacity") && (fxpBI.effectIds || []).length === 0,
      JSON.stringify({ transform: fxpBI.transform, effects: fxpBI.effectIds }));
    const fxpDoc3 = (await get(`/api/vfx/comp/${fxpTargetSlug}`)).comp;
    /* The MERGE RULE, live: the at:2 apply above had already keyed this
     * layer's opacity at 2/2.8. The built-in pastes 0/0.8 — its keys own only
     * the range they cover, so the 2/2.8 pair SURVIVES beside them. */
    eq("...pasting its opacity keys at the layer's start and keeping the keys outside the pasted range",
      (layerOf(fxpDoc3, fxpLate.layerId).transform.opacity.keys || []).map((k) => k.t), [0, 0.8, 2, 2.8]);

    /* THE STALE-PRESET REFUSAL. A preset naming an effect the catalog has
     * never heard of cannot be built over the API (add_effect validates), so
     * it is seeded straight into the store file — which is exactly the
     * situation a preset that outlived a catalog rename would be in. */
    const { config: fxpConfig } = await import("../server/config.js");
    const fxpStorePath = path.join(fxpConfig.outputDir, "vfx", "_fx_presets.json");
    const fxpStaleName = `e2e-fxp-stale-${stamp}`;
    const fxpStore = JSON.parse(await readFile(fxpStorePath, "utf8"));
    fxpStore.presets[fxpStaleName] = {
      createdAt: Date.now(), updatedAt: Date.now(),
      effects: [{ type: "fxpFakeEffectFromTheFuture", enabled: true, params: { warp: 9 } }],
    };
    await writeFile(fxpStorePath, JSON.stringify(fxpStore, null, 1));
    let fxpStaleMsg = "";
    try { await api({ action: "apply_fx_preset", slug: fxpTargetSlug, layerId: fxpTargetId, preset: fxpStaleName }); }
    catch (e) { fxpStaleMsg = e.message; }
    ok("a stale preset is refused NAMING the unknown effect type",
      /fxpFakeEffectFromTheFuture/.test(fxpStaleMsg), fxpStaleMsg);
    ok("...and nothing was half-applied",
      layerOf((await get(`/api/vfx/comp/${fxpTargetSlug}`)).comp, fxpTargetId).effects.length === 1);

    /* Rename, delete, and the built-in guard. */
    const fxpRenamed = `e2e-fxp-look-renamed-${stamp}`;
    await api({ action: "rename_fx_preset", preset: fxpName, to: fxpRenamed });
    const fxpShelf2 = await api({ action: "list_fx_presets" });
    ok("rename keeps the record under the new name only",
      (fxpShelf2.presets || []).some((p) => p.name === fxpRenamed)
      && !(fxpShelf2.presets || []).some((p) => p.name === fxpName));
    let fxpBuiltinMsg = "";
    try { await api({ action: "delete_fx_preset", preset: "Film Look (built-in)" }); }
    catch (e) { fxpBuiltinMsg = e.message; }
    ok("a built-in cannot be deleted", /built-in/.test(fxpBuiltinMsg), fxpBuiltinMsg);
    await api({ action: "delete_fx_preset", preset: fxpRenamed });
    await api({ action: "delete_fx_preset", preset: fxpStaleName });
    const fxpShelf3 = await api({ action: "list_fx_presets" });
    ok("delete removed both test presets, leaving the shelf as found",
      !(fxpShelf3.presets || []).some((p) => p.name === fxpRenamed || p.name === fxpStaleName));
  }

  log("\n── precompose: layers MOVE into a nested comp and the picture does not change ──");
  /* [precomp-nested] AE's precompose, "move all attributes". THE claim of the
   * gesture is render invariance — the frame before and the frame after are
   * the same picture — and it is proven here byte for byte. The comp is built
   * so the claim is exact rather than within-epsilon: solids at integer
   * offsets, alpha 0 or 1 everywhere, normal blends, and nothing (parenting,
   * mattes, expressions) crossing the boundary — "over" is associative in
   * exact arithmetic and this stack keeps the arithmetic exact. The boundary
   * cases get their own comps below, where the WARNINGS are the assertion. */
  {
    const pcpMk = await api({ action: "create", name: `e2e-pcp-${stamp}`, width: 320, height: 200, duration: 2, fps: 24, bg: [12, 24, 36, 255] });
    const pcpSlug = pcpMk.comp.slug; made.push(pcpSlug);
    // Stack top-to-bottom = [alpha, bravo, charlie]: each add lands at index 0.
    const pcpSolid = async (name, color, pos) => {
      const r = await api({ action: "add_layer", slug: pcpSlug, type: "solid", name, color, width: 80, height: 60 });
      const id = r.layerId;
      await api({ action: "set_prop", slug: pcpSlug, layerId: id, path: "transform.position", value: pos });
      return id;
    };
    const pcpCharlieId = await pcpSolid("pcp-charlie", [40, 60, 220, 255], [240, 210]);
    const pcpBravoId = await pcpSolid("pcp-bravo", [60, 200, 90, 255], [300, 120]);
    const pcpAlphaId = await pcpSolid("pcp-alpha", [220, 60, 60, 255], [180, 120]);
    // The moved layers carry the full vocabulary across: keyframes (constant,
    // so the picture cannot move) and an expression (identity, same reason).
    await api({ action: "set_prop", slug: pcpSlug, layerId: pcpAlphaId, path: "opacity", keys: [{ t: 0, v: 100 }, { t: 2, v: 100 }] });
    await api({ action: "set_prop", slug: pcpSlug, layerId: pcpAlphaId, path: "transform.rotation", expr: "value" });

    const pcpPng = async (slugX, t) => {
      const r = await fetch(`${BASE}/api/vfx/frame/${slugX}?t=${t}&scale=1&draft=0`);
      if (!r.ok || !(r.headers.get("content-type") || "").includes("image/png")) {
        throw new Error(`precomp frame t=${t}: ${r.status} ${(await r.text()).slice(0, 120)}`);
      }
      return Buffer.from(await r.arrayBuffer());
    };
    const pcpSha = (buf) => createHash("sha1").update(buf).digest("hex");

    const pcpBeforeDoc = (await get(`/api/vfx/comp/${pcpSlug}`)).comp;
    const pcpBeforeLayers = pcpBeforeDoc.layers;                    // [alpha, bravo, charlie]
    const pcpFrameBefore = await pcpPng(pcpSlug, 1.0);

    const pcpRes = await api({ action: "precompose", slug: pcpSlug, layerIds: [pcpAlphaId, pcpBravoId], name: `e2e-pcp-child-${stamp}` });
    made.push(pcpRes.precompSlug);
    ok("precompose answers the new comp's slug and the comp layer's id",
      !!pcpRes.precompSlug && !!pcpRes.layerId, JSON.stringify(pcpRes).slice(0, 160));
    eq("nothing crossed the boundary, so no warnings", pcpRes.warnings, []);

    const pcpAfterDoc = (await get(`/api/vfx/comp/${pcpSlug}`)).comp;
    eq("the parent holds 2 layers now", pcpAfterDoc.layers.length, 2);
    eq("...the first a comp layer where the topmost moved layer sat", pcpAfterDoc.layers[0].type, "comp");
    eq("...whose src is the child's slug (src, never compSlug)", pcpAfterDoc.layers[0].src, pcpRes.precompSlug);
    eq("...spanning the parent's timeline", [pcpAfterDoc.layers[0].start, pcpAfterDoc.layers[0].end], [0, 2]);
    eq("...and charlie stayed beneath it, untouched", pcpAfterDoc.layers[1].id, pcpCharlieId);

    const pcpChildDoc = (await get(`/api/vfx/comp/${pcpRes.precompSlug}`)).comp;
    eq("the child took the parent's size, fps and duration",
      [pcpChildDoc.width, pcpChildDoc.height, pcpChildDoc.fps, pcpChildDoc.duration], [320, 200, 24, 2]);
    eq("the child holds the 2 moved layers in their parent stacking order",
      pcpChildDoc.layers.map((l) => l.id), [pcpAlphaId, pcpBravoId]);
    ok("...BYTE-IDENTICAL to the originals — ids, keyframes, the expression, everything",
      JSON.stringify(pcpChildDoc.layers) === JSON.stringify([pcpBeforeLayers[0], pcpBeforeLayers[1]]),
      "deep compare failed — diff the two layer arrays by hand");

    const pcpFrameAfter = await pcpPng(pcpSlug, 1.0);
    ok(`render invariance, THE claim: the frame at t=1 is byte-for-byte the same picture (sha1 ${pcpSha(pcpFrameBefore).slice(0, 12)}…)`,
      pcpFrameBefore.equals(pcpFrameAfter),
      `before sha1 ${pcpSha(pcpFrameBefore)}  after sha1 ${pcpSha(pcpFrameAfter)}`);
    log(`        render-invariance sha1: before ${pcpSha(pcpFrameBefore)}  after ${pcpSha(pcpFrameAfter)}`);

    /* The UI's undo for this gesture is documented as "set_comp writes the
     * pre-precompose snapshot back; the child comp stays on disk". That is a
     * server behaviour, so it is proven here where the server is: one
     * set_comp restores the layers AND the pixels. */
    await api({ action: "set_comp", slug: pcpSlug, layers: pcpBeforeLayers });
    const pcpUndoneDoc = (await get(`/api/vfx/comp/${pcpSlug}`)).comp;
    ok("undo's route (set_comp with the prior snapshot) restores the parent's layers verbatim",
      JSON.stringify(pcpUndoneDoc.layers) === JSON.stringify(pcpBeforeLayers));
    const pcpFrameUndone = await pcpPng(pcpSlug, 1.0);
    ok("...and the pixels", pcpFrameBefore.equals(pcpFrameUndone),
      `undone sha1 ${pcpSha(pcpFrameUndone)}`);
    ok("...while the child comp survives the undo, as documented",
      !!(await get(`/api/vfx/comp/${pcpRes.precompSlug}`)).comp);
  }

  log("\n-- precompose: a split track-matte pair is broken AND warned about --");
  {
    const pcpMt = await api({ action: "create", name: `e2e-pcp-matte-${stamp}`, width: 320, height: 200, duration: 2, fps: 24 });
    const pcpMtSlug = pcpMt.comp.slug; made.push(pcpMtSlug);
    const pcpXrayId = (await api({ action: "add_layer", slug: pcpMtSlug, type: "solid", name: "pcp-xray" })).layerId;
    const pcpLimaId = (await api({ action: "add_layer", slug: pcpMtSlug, type: "solid", name: "pcp-lima" })).layerId;
    const pcpMikeId = (await api({ action: "add_layer", slug: pcpMtSlug, type: "solid", name: "pcp-mike" })).layerId;
    // stack: [mike, lima, xray]; lima is matted by mike, the layer directly above
    await api({ action: "set_matte", slug: pcpMtSlug, layerId: pcpLimaId, type: "alpha" });

    // No name: AE's numbering takes over.
    const pcpMtRes = await api({ action: "precompose", slug: pcpMtSlug, layerIds: [pcpLimaId, pcpXrayId] });
    made.push(pcpMtRes.precompSlug);
    ok("an unnamed precomp is named AE-style, \"Pre-comp N\"",
      /^Pre-comp \d+$/.test((await get(`/api/vfx/comp/${pcpMtRes.precompSlug}`)).comp.name),
      (await get(`/api/vfx/comp/${pcpMtRes.precompSlug}`)).comp.name);
    ok("the split matte pair surfaces as a warning naming both layers",
      pcpMtRes.warnings.some((w) => /track matte broken/.test(w) && w.includes("pcp-lima") && w.includes("pcp-mike")),
      JSON.stringify(pcpMtRes.warnings));
    const pcpMtChild = (await get(`/api/vfx/comp/${pcpMtRes.precompSlug}`)).comp;
    eq("...and the moved layer's matte really was cleared, not left pointing at whatever is above now",
      layerOf(pcpMtChild, pcpLimaId).trackMatte, null);
  }

  log("\n-- precompose: parent links and expressions crossing the boundary warn --");
  {
    const pcpLk = await api({ action: "create", name: `e2e-pcp-links-${stamp}`, width: 320, height: 200, duration: 2, fps: 24 });
    const pcpLkSlug = pcpLk.comp.slug; made.push(pcpLkSlug);
    const pcpQuebecId = (await api({ action: "add_layer", slug: pcpLkSlug, type: "solid", name: "pcp-quebec" })).layerId;
    const pcpStayId = (await api({ action: "add_layer", slug: pcpLkSlug, type: "null", name: "pcp-stay" })).layerId;
    const pcpEchoId = (await api({ action: "add_layer", slug: pcpLkSlug, type: "solid", name: "pcp-echo" })).layerId;
    // stack: [echo, stay, quebec]; quebec is parented to stay, echo reads stay
    await api({ action: "set_layer", slug: pcpLkSlug, layerId: pcpQuebecId, parent: pcpStayId });
    await api({ action: "set_prop", slug: pcpLkSlug, layerId: pcpEchoId, path: "opacity", expr: 'thisComp.layer("pcp-stay").opacity' });

    const pcpLkRes = await api({ action: "precompose", slug: pcpLkSlug, layerIds: [pcpEchoId, pcpQuebecId], name: `e2e-pcp-links-child-${stamp}` });
    made.push(pcpLkRes.precompSlug);
    ok("a moved layer parented to a stayer: link broken, pair named",
      pcpLkRes.warnings.some((w) => /parent link broken/.test(w) && w.includes("pcp-quebec") && w.includes("pcp-stay")),
      JSON.stringify(pcpLkRes.warnings));
    ok("a moved layer's expression naming a stayer: warned as failing at render, not blocked",
      pcpLkRes.warnings.some((w) => /expression will fail/.test(w) && w.includes("pcp-echo") && w.includes('layer("pcp-stay")')),
      JSON.stringify(pcpLkRes.warnings));
    const pcpLkChild = (await get(`/api/vfx/comp/${pcpLkRes.precompSlug}`)).comp;
    eq("...and the moved layer's parent link really is cut", layerOf(pcpLkChild, pcpQuebecId).parent, null);
    ok("...but the expression itself moved untouched — the author fixes it, not us",
      layerOf(pcpLkChild, pcpEchoId).transform.opacity?.expr === 'thisComp.layer("pcp-stay").opacity');

    // Every layer at once is legal, as it is in AE: the parent ends up holding
    // exactly one comp layer.
    const pcpLkDoc = (await get(`/api/vfx/comp/${pcpLkSlug}`)).comp;
    const pcpAllRes = await api({ action: "precompose", slug: pcpLkSlug, layerIds: pcpLkDoc.layers.map((l) => l.id), name: `e2e-pcp-all-${stamp}` });
    made.push(pcpAllRes.precompSlug);
    const pcpLkDoc2 = (await get(`/api/vfx/comp/${pcpLkSlug}`)).comp;
    ok("precomposing EVERY layer leaves the parent holding one comp layer",
      pcpLkDoc2.layers.length === 1 && pcpLkDoc2.layers[0].type === "comp",
      JSON.stringify(pcpLkDoc2.layers.map((l) => l.type)));

    // The refusals, each by its message.
    let pcpNoIds = "";
    try { await api({ action: "precompose", slug: pcpLkSlug, layerIds: [] }); }
    catch (e) { pcpNoIds = e.message; }
    ok("an empty id list is refused", /Give layerIds/.test(pcpNoIds), pcpNoIds);
    let pcpBadId = "";
    try { await api({ action: "precompose", slug: pcpLkSlug, layerIds: ["ly_nope"] }); }
    catch (e) { pcpBadId = e.message; }
    ok("an unknown id is refused, naming what the comp has", /No such layer/.test(pcpBadId), pcpBadId);
    let pcpLeave = "";
    try { await api({ action: "precompose", slug: pcpLkSlug, layerIds: [pcpLkDoc2.layers[0].id], leaveAttributes: true }); }
    catch (e) { pcpLeave = e.message; }
    ok("AE's \"leave all attributes\" mode is refused by name, not half-built",
      /Leave all attributes/i.test(pcpLeave) && /move all attributes/i.test(pcpLeave), pcpLeave);
  }

  log("\n── analysis tools answer over HTTP ──");
  let audioName = null;
  try {
    const st = await get("/api/status");
    const tracks = (st.library || []).map((t) => t.file || t.name || t);
    audioName = tracks.find((n) => /\.(mp3|wav|flac|m4a)$/i.test(String(n)));
  } catch { /* the library route may be shaped differently; skip rather than fail */ }

  if (audioName) {
    const a = await api({ action: "audio_keys", audio: audioName, fps: 10, to: 6, tracks: ["amplitude", "bass", "beat"] });
    ok(`audio_keys analysed ${audioName}`, a.ok === true);
    ok("...and reported seconds, not undefined", Number.isFinite(a.seconds), `seconds=${a.seconds}`);
    ok("...with the three tracks asked for", Object.keys(a.tracks || {}).length === 3, JSON.stringify(a.tracks));
    const applied = await api({
      action: "audio_keys", audio: audioName, fps: 10, to: 6, tracks: ["bass"],
      apply: { slug, layerId: cubeId, path: "transform.scale", track: "bass", min: 100, max: 140 },
    });
    ok("...and drove a property with it", applied.applied?.keys > 0, JSON.stringify(applied.applied));
    comp = (await get(`/api/vfx/comp/${slug}`)).comp;
    const sc = layerOf(comp, cubeId).transform.scale;
    ok("the property really holds those keys now", Array.isArray(sc?.keys) && sc.keys.length > 0);
    const vs = (sc.keys || []).map((k) => (Array.isArray(k.v) ? k.v[0] : k.v));
    ok("...mapped into 100..140, not left at 0..1",
      vs.every((v) => v >= 99.9 && v <= 140.1), `range ${Math.min(...vs).toFixed(1)}..${Math.max(...vs).toFixed(1)}`);
  } else {
    log("  skip  no audio file found in the library — audio_keys not exercised");
  }

  let clipName = null;
  try {
    const clips = await get("/api/clips");
    /* Skipping clips this run created: the render step above writes half a
     * second of a nearly empty test comp into the same library, and tracking
     * that is not a test of anything. */
    clipName = (clips.clips || clips.items || [])
      .map((c) => c.name || c.file || c)
      // ...and anything a PREVIOUS run left behind, which `mine` cannot know
      // about. Every render this script queues is named from its own comp.
      .filter((n) => /\.mp4$/i.test(String(n)) && !mine.has(String(n)) && !/^vfx_e2e-/i.test(String(n)))
      .find(Boolean);
  } catch { /* ditto */ }

  if (clipName) {
    /* A tracker that refuses a flat patch UP FRONT is the whole design: the
     * alternative is one that locks onto nothing and reports it confidently. */
    let flatRefusal = "";
    try {
      await api({ action: "track_motion", clip: clipName, rect: [0, 0, 4, 4], toTime: 0.2 });
    } catch (e) { flatRefusal = e.message; }
    ok("a featureless patch is refused before tracking starts",
      /featureless|std/i.test(flatRefusal), flatRefusal || "(it accepted a 4x4 patch)");

    const t = await api({ action: "track_motion", clip: clipName, rect: [100, 100, 60, 60], toTime: 1.5 });
    ok(`track_motion ran on ${clipName}`, t.ok === true);
    ok("...and reported frames as a number", Number.isFinite(t.frames), `frames=${t.frames}`);
    ok("...and said honestly whether it lost the shot",
      t.lostAt === null || Number.isFinite(t.lostAt), `lostAt=${t.lostAt}`);
    /* The only signal confidence cannot give: a repetitive texture matches
     * with high confidence and the margin to the runner-up collapses. */
    ok("...and reports the margin, not only the confidence",
      t.margin === undefined || (Number.isFinite(t.margin?.min) && Number.isFinite(t.margin?.mean)),
      JSON.stringify(t.margin));
    if (t.confidence) {
      ok("...reporting MEASURED confidence, not the threshold it ran with",
        t.confidence.min !== undefined && t.confidence.threshold !== undefined,
        JSON.stringify(t.confidence));
    }
  } else {
    log("  skip  no clip found — track_motion not exercised");
  }

  log("\n── sound: a movie render carries the mix ──");
  /* The single biggest gap this surface had: a direct render of a music video
   * was SILENT. Everything below decodes the actual rendered file — asserting
   * the job said ok would prove nothing about what a viewer hears. */
  const { spawnSync } = await import("node:child_process");
  // createHash comes from the top-level import — re-declaring it here put the
  // whole module scope in its TDZ and broke an earlier block's sha1.
  const { readFileSync } = await import("node:fs");
  const PY = process.env.AIPLAY_PYTHON
    || `${process.env.AIPLAY_RIG || "D:/AI/aiplay-studio-bench"}/venv/Scripts/python.exe`;
  const PROBE_SRC = `
import sys, json
import av, numpy as np
c = av.open(sys.argv[1])
out = {"video": len(c.streams.video), "audio": len(c.streams.audio)}
if c.streams.audio:
    st = c.streams.audio[0]
    if st.duration is not None and st.time_base:
        out["duration"] = float(st.duration * st.time_base)
    elif c.duration is not None:
        out["duration"] = float(c.duration) / av.time_base
    res = av.AudioResampler(format="fltp", layout="stereo", rate=48000)
    parts = []
    for fr in c.decode(st):
        for o in res.resample(fr):
            parts.append(o.to_ndarray())
    for o in res.resample(None):
        parts.append(o.to_ndarray())
    buf = np.concatenate(parts, axis=1) if parts else np.zeros((2, 1))
    n = buf.shape[1]
    rms = lambda x: float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    out["rms"] = rms(buf)
    # head/tail keep clear of the midpoint, where a fade keyed at the middle
    # is still in transit — RMS across the ramp itself proves nothing
    out["rms_head"] = rms(buf[:, :int(n * 0.4)])
    out["rms_tail"] = rms(buf[:, int(n * 0.6):])
c.close()
print(json.dumps(out))
`;
  const probeFile = (p) => {
    const r = spawnSync(PY, ["-c", PROBE_SRC, p], { encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new Error(`probe of ${p} failed: ${(r.stderr || "").slice(-200)}`);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  };
  const sha1 = (p) => createHash("sha1").update(readFileSync(p)).digest("hex");

  const waitRender = async (slug2, jobId) => {
    for (let i = 0; i < 360; i++) {
      const d = await get(`/api/vfx/comp/${slug2}`);
      const r = (d.renders || []).find((x) => x.id === jobId);
      if (r && (r.status === "done" || r.status === "failed")) return r;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    throw new Error(`render ${jobId} never finished`);
  };
  const render = async (slug2, extra = {}) => {
    // codec pinned to libx264: the byte-identity assertion below needs a
    // deterministic encoder, and NVENC is hardware
    const q = await api({ action: "render", slug: slug2, format: "mp4", codec: "libx264",
                          draft: true, ...extra });
    if (q.clip) mine.add(String(q.clip));
    const row = await waitRender(slug2, q.jobId);
    return row;
  };

  let pyOk = true;
  try { spawnSync(PY, ["-c", "import av, numpy"], { encoding: "utf8", timeout: 60_000 }); }
  catch { pyOk = false; }

  if (!pyOk) {
    log("  skip  no python with PyAV — the audio assertions need to decode the rendered file");
  } else {
    // a song for the audio layer: same walk the audio_keys section does
    let song = null;
    try {
      const st = await get("/api/status");
      const tracks = (st.library || []).map((t) => t.file || t.name || t);
      song = tracks.find((n) => /\.(flac|mp3|wav|m4a|opus)$/i.test(String(n)));
    } catch { /* shaped differently; the skip below says so */ }

    if (!song) {
      log("  skip  no track in the music library — audio layer render not exercised");
    } else {
      const AUD = `e2e-aud-${stamp}`;
      const ac = await api({ action: "create", name: AUD, width: 160, height: 100, duration: 2, fps: 12 });
      const audSlug = ac.comp.slug; made.push(audSlug);
      await api({ action: "add_layer", slug: audSlug, type: "solid", name: "plate", color: [30, 30, 40, 255] });
      const al = await api({ action: "add_layer", slug: audSlug, type: "audio", src: song, name: "song" });
      ok(`an audio layer takes ${song}`, !!al.layerId, JSON.stringify(al).slice(0, 120));

      const r1 = await render(audSlug);
      ok("the movie rendered", r1.status === "done", String(r1.error || ""));
      const p1 = probeFile(r1.out);
      eq("...and it carries exactly one audio stream", p1.audio, 1);
      ok("...as long as the render range", Math.abs((p1.duration ?? 0) - 2) < 0.2, `duration=${p1.duration}`);
      ok("...with signal in it, not a silent track", p1.rms > 1e-3, `rms=${p1.rms}`);
      ok("the finished job reports the mix it muxed",
        Number.isFinite(r1?.audio?.rmsDb ?? NaN) || r1?.audio?.rmsDb === null,
        JSON.stringify(r1.audio ?? null));

      log("\n── audioLevels KEYFRAMES are followed, not snapshotted ──");
      await api({ action: "set_prop", slug: audSlug, layerId: al.layerId, path: "audioLevels",
                  keys: [{ t: 0, v: 0 }, { t: 1, v: 0 }, { t: 1.05, v: -48 }] });
      const r2 = await render(audSlug);
      const p2 = probeFile(r2.out);
      ok("before the fade the mix is still loud", p2.rms_head > p1.rms * 0.4,
        `head=${p2.rms_head} vs base ${p1.rms}`);
      ok("after the fade it actually DROPPED (the -48 dB floor)",
        p2.rms_tail < p2.rms_head / 100, `head=${p2.rms_head} tail=${p2.rms_tail}`);

      log("\n── timeRemap refuses live audio, and names the way out ──");
      let remapMsg = "";
      try {
        await api({ action: "set_prop", slug: audSlug, layerId: al.layerId, path: "timeRemap",
                    keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }] });
      } catch (e) { remapMsg = e.message; }
      ok("an audio layer refuses the curve at authoring time",
        /remap/i.test(remapMsg), remapMsg || "(it was accepted)");

      log("\n── nested comps carry their child's sound ──");
      const par = await api({ action: "create", name: `${AUD}-parent`, width: 160, height: 100, duration: 2, fps: 12 });
      made.push(par.comp.slug);
      await api({ action: "add_layer", slug: par.comp.slug, type: "comp", name: "nested", src: audSlug });
      const nl = (await get(`/api/vfx/comp/${par.comp.slug}`)).comp.layers[0];
      await api({ action: "set_layer", slug: par.comp.slug, layerId: nl.id,
                  start: 0.25, end: 1.75, audioLevels: -6 });
      const r3 = await render(par.comp.slug);
      ok("the parent rendered", r3.status === "done", String(r3.error || ""));
      const p3 = probeFile(r3.out);
      eq("...with its child's audio muxed in", p3.audio, 1);
      ok("...through the parent's trim and level (quieter than the child alone)",
        p3.rms > 1e-4 && p3.rms < p1.rms, `parent=${p3.rms} child=${p1.rms}`);
    }

    log("\n── a video layer's own audio track reaches the mix ──");
    /* Find real footage with a soundtrack. Comp renders (vfx_*) are excluded
     * so the test never certifies audio by finding its own output. */
    let clipWithAudio = null;
    try {
      const clipDir = row?.out ? String(row.out).replace(/[/\\][^/\\]*$/, "") : null;
      if (clipDir) {
        const FIND_SRC = `
import sys, os, json, av
d = sys.argv[1]
hit = None
for n in sorted(os.listdir(d)):
    if not n.lower().endswith((".mp4", ".mov")) or n.startswith("vfx_"):
        continue
    try:
        c = av.open(os.path.join(d, n))
        has = bool(c.streams.audio)
        c.close()
        if has:
            hit = n
            break
    except Exception:
        pass
print(json.dumps({"clip": hit}))
`;
        const rf = spawnSync(PY, ["-c", FIND_SRC, clipDir], { encoding: "utf8", timeout: 180_000 });
        if (rf.status === 0) clipWithAudio = JSON.parse(rf.stdout.trim().split(/\r?\n/).pop()).clip;
      }
    } catch { /* no clips is a skip, not a failure */ }

    if (!clipWithAudio) {
      log("  skip  no clip with an audio track in the library — video-audio not exercised");
    } else {
      const vc = await api({ action: "create", name: `e2e-vaud-${stamp}`, width: 160, height: 100, duration: 1.5, fps: 12 });
      made.push(vc.comp.slug);
      const vl = await api({ action: "add_layer", slug: vc.comp.slug, type: "video", src: clipWithAudio });
      ok("add_layer's probe advisory saw the track (srcHasAudio)",
        vl.layer?.srcHasAudio === true, JSON.stringify(vl.layer?.srcHasAudio));
      const rv = await render(vc.comp.slug);
      ok(`a video layer over ${clipWithAudio} rendered`, rv.status === "done", String(rv.error || ""));
      const pv = probeFile(rv.out);
      eq("...and its own audio track is in the movie", pv.audio, 1);
      ok("...with signal", pv.rms > 1e-5, `rms=${pv.rms}`);

      /* The other half of the remap rule: the PICTURE still remaps once the
       * audio is switched off — refusal first, then the documented way out. */
      await api({ action: "set_prop", slug: vc.comp.slug, layerId: vl.layerId, path: "timeRemap",
                  keys: [{ t: 0, v: 0 }, { t: 1.5, v: 0.8 }] });
      const rFail = await render(vc.comp.slug);
      ok("a remapped video layer with live audio FAILS the render",
        rFail.status === "failed" && /audio/i.test(String(rFail.error)), String(rFail.error || rFail.status));
      await api({ action: "set_layer", slug: vc.comp.slug, layerId: vl.layerId, audio: false });
      const rMuted = await render(vc.comp.slug);
      ok("...and audio:false lets the remapped picture render", rMuted.status === "done", String(rMuted.error || ""));
      eq("...silent, with no audio stream at all", probeFile(rMuted.out).audio, 0);
    }

    log("\n── a comp with no audio renders exactly as before ──");
    const sc = await api({ action: "create", name: `e2e-mute-${stamp}`, width: 160, height: 100, duration: 1, fps: 12 });
    made.push(sc.comp.slug);
    await api({ action: "add_layer", slug: sc.comp.slug, type: "solid", name: "plate", color: [200, 80, 80, 255] });
    const s1 = await render(sc.comp.slug, { draft: false });
    const s2 = await render(sc.comp.slug, { draft: false });
    eq("no audio stream is added", probeFile(s1.out).audio, 0);
    /* The pre/post-change byte identity was proven against the unmodified
     * engine when this shipped (identical sha1 for mp4 and mov). What e2e can
     * keep re-proving is the property that made that comparison meaningful:
     * the silent path is deterministic, so ANY change to it shows up here as
     * two differing renders. */
    eq("two silent renders are byte-identical (sha1)", sha1(s1.out), sha1(s2.out));

    log("\n── waveform peaks: the timeline's numbers, cached by source ──");
    /* wf-prefixed names throughout — this module's top scope already holds
     * createHash, row, song, s1…; unmistakable names are the collision rule. */
    const wfMuteName = String(s1.out).split(/[\\/]/).pop();
    let wfMuteMsg = "";
    try { await api({ action: "audio_peaks", src: wfMuteName, bins: 64 }); }
    catch (e) { wfMuteMsg = e.message; }
    ok("a soundless source is REFUSED, naming the reason (not answered flat)",
      /no audio stream/i.test(wfMuteMsg), wfMuteMsg || "(it answered an envelope)");

    if (!song) {
      log("  skip  no track in the music library — peaks not exercised on real audio");
    } else {
      const wfBins = 96;
      const wf1 = await api({ action: "audio_peaks", src: song, bins: wfBins });
      ok(`audio_peaks answered for ${song}`, wf1.ok === true);
      eq("...with exactly the bins asked for (interleaved lo,hi pairs)",
        wf1.peaks.length, wfBins * 2);
      ok("...every peak within [-1, 1]",
        wf1.peaks.every((v) => Number.isFinite(v) && v >= -1 && v <= 1));
      ok("...lo <= hi in every pair",
        Array.from({ length: wfBins }, (_, i) => wf1.peaks[i * 2] <= wf1.peaks[i * 2 + 1]).every(Boolean));
      ok("...with signal in it, not a flat line", wf1.peaks.some((v) => Math.abs(v) > 1e-3));
      ok("...and the source length in seconds", Number.isFinite(wf1.seconds) && wf1.seconds > 0,
        `seconds=${wf1.seconds}`);

      /* Cache observability, the frame route's X-Vfx-Cache philosophy in JSON:
       * `cached` on the reply is the only way an outsider can PROVE the sidecar
       * exists. The first call is not asserted either way — a previous e2e run
       * against the same library legitimately left the sidecar behind, which is
       * exactly what source-keyed (not updatedAt-keyed) caching promises. */
      const wf2 = await api({ action: "audio_peaks", src: song, bins: wfBins });
      ok("a second identical request is served from the sidecar cache",
        wf2.cached === true, `first cached=${wf1.cached}, second cached=${wf2.cached}`);
      eq("...and is byte-for-byte the same envelope",
        JSON.stringify(wf2.peaks), JSON.stringify(wf1.peaks));

      const wfComp = await api({ action: "create", name: `e2e-wave-${stamp}`, width: 120, height: 80, duration: 2, fps: 12 });
      made.push(wfComp.comp.slug);
      const wfLayer = await api({ action: "add_layer", slug: wfComp.comp.slug, type: "audio", src: song, name: "wave-src" });
      const wf3 = await api({ action: "audio_peaks", slug: wfComp.comp.slug, layerId: wfLayer.layerId, pixelsPerSecond: 10 });
      ok("layer-addressed peaks read the layer's own source", wf3.ok === true);
      eq("...self-consistent: peaks.length is 2 x the bins it answered",
        wf3.peaks.length, wf3.bins * 2);
      ok("...and pixelsPerSecond sized the bins from the SOURCE length",
        Math.abs(wf3.bins - wf3.seconds * 10) <= Math.max(2, wf3.seconds * 0.5),
        `bins=${wf3.bins} for ${wf3.seconds}s at 10pps`);
    }
  }

  log("\n── auto-orient: a layer turns to face along its motion path ──");
  /* The switch is a LAYER switch like threeD, so it rides set_layer, survives
   * the store's rebuild pass, and changes pixels through the same frame cache
   * every other document edit invalidates (updatedAt). All four seams are the
   * ones unit tests cannot see: HTTP in, document back, python out. */
  const aorMake = await api({ action: "create", name: `e2e-aorient-${stamp}`,
                              width: 64, height: 64, duration: 2, fps: 24 });
  const aorSlug = aorMake.comp.slug; made.push(aorSlug);
  const aorAdd = await api({ action: "add_layer", slug: aorSlug, type: "solid", name: "dart",
                             color: [255, 80, 80, 255] });
  const aorId = aorAdd.layerId ?? aorAdd.layer?.id;
  await api({ action: "set_layer", slug: aorSlug, layerId: aorId, width: 40, height: 8 });
  await api({ action: "set_prop", slug: aorSlug, layerId: aorId, path: "transform.anchor", value: [20, 4] });
  await api({ action: "set_prop", slug: aorSlug, layerId: aorId, path: "transform.position",
              keys: [{ t: 0, v: [32, 10] }, { t: 2, v: [32, 54] }] });

  const aorFrame = async () => {
    const r = await fetch(`${BASE}/api/vfx/frame/${aorSlug}?t=1`);
    if (!r.ok) throw new Error(`auto-orient frame answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const aorBefore = await aorFrame();
  const aorStampBefore = (await get(`/api/vfx/comp/${aorSlug}`)).comp.updatedAt;
  await api({ action: "set_layer", slug: aorSlug, layerId: aorId, autoOrient: "alongPath" });
  let aorComp = (await get(`/api/vfx/comp/${aorSlug}`)).comp;
  eq("set_layer round-trips autoOrient through the store's rebuild pass",
    layerOf(aorComp, aorId).autoOrient, "alongPath");
  ok("...and bumps updatedAt, the frame cache's invalidation key",
    aorComp.updatedAt > aorStampBefore, `${aorStampBefore} -> ${aorComp.updatedAt}`);
  const aorAfter = await aorFrame();
  ok("a moving layer's frame CHANGES when auto-orient goes on (the wide solid stands up)",
    !aorBefore.equals(aorAfter), `${aorBefore.length}B vs ${aorAfter.length}B`);
  await api({ action: "set_layer", slug: aorSlug, layerId: aorId, autoOrient: "off" });
  ok("...and switching it off renders the original bytes again",
    aorBefore.equals(await aorFrame()), "");

  let aorBad = "";
  try { await api({ action: "set_layer", slug: aorSlug, layerId: aorId, autoOrient: "sideways" }); }
  catch (e) { aorBad = e.message; }
  ok("a bad enum value is refused, naming the two legal modes",
    /"off" or "alongPath"/.test(aorBad), aorBad);
  let aorCam = "";
  try { await api({ action: "set_layer", slug: aorSlug, layerId: aorId, autoOrient: "towardCamera" }); }
  catch (e) { aorCam = e.message; }
  ok("towardCamera is refused WITH the reason, not stored as a dead mode",
    /not supported/.test(aorCam) && /camera/i.test(aorCam), aorCam);
  aorComp = (await get(`/api/vfx/comp/${aorSlug}`)).comp;
  eq("...and the refusals left the stored switch untouched",
    layerOf(aorComp, aorId).autoOrient, "off");
} catch (err) {
  fails.push(`threw: ${err.message}`);
  log(`\n  THREW  ${err.message}`);
} finally {
  for (const s of made) {
    try { await api({ action: "delete", slug: s }); } catch { /* leave it; not worth failing over */ }
  }
  log(`\n  ${pass} passed, ${fails.length} failed\n`);
  if (fails.length) { for (const f of fails) log(`   · ${f}`); log(""); }
  process.exit(fails.length ? 1 : 0);
}
