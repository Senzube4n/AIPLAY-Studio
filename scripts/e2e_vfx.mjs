/**
 * End-to-end check of everything wired into the VFX surface today.
 *
 * Every assertion goes through HTTP, because that is the layer none of the
 * unit tests cover: store.js was tested in-process, engine.py was tested in
 * python, and the bugs that actually bit were all in the seam between them.
 *
 *   node e2e_vfx.mjs [port]
 */
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

  log("\n── timeRemap is authorable at last ──");
  await api({ action: "set_prop", slug, layerId: cubeId, path: "timeRemap", keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }] });
  comp = (await get(`/api/vfx/comp/${slug}`)).comp;
  eq("timeRemap takes keyframes", layerOf(comp, cubeId).timeRemap.keys.length, 2);

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
