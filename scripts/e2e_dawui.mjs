/**
 * End-to-end check of the DAW's ARRANGEMENT WINDOW — over the wire.
 *
 * scripts/e2e_daw.mjs proves the engine and the routes. server/daw/ui_test.js
 * proves the page's structure without a browser. This script proves the two
 * things that only exist BETWEEN them:
 *
 *   THE PARITY JOURNEYS  every gesture the window offers is replayed as the
 *                        exact action sequence the page posts, and the result
 *                        is asserted in BYTES (a render that is not silent, a
 *                        knob that changes the samples, a fader ride that
 *                        makes bars 5-8 quieter) — not in "the POST answered
 *                        200".
 *   THE LIVE SYNC        a real websocket to the studio's /live socket, an
 *                        edit made by the MCP server in a SECOND PROCESS, and
 *                        the assertion that the frame arrives naming the
 *                        agent — which is the whole of §13a's "AI edits are
 *                        visibly live" reduced to something that can fail.
 *
 * Needs the server running:  AIPLAY_UI_PORT=4273 node server/index.js
 * Then:                      node scripts/e2e_dawui.mjs 4273
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || "4273";
const BASE = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
const log = (...a) => console.log(...a);
function ok(label, cond, detail = "") {
  if (cond) { pass++; log(`  ok    ${label}`); }
  else { fails.push(label); log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function api(body) {
  const r = await fetch(`${BASE}/api/daw`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "user", ...body }),
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
const text = async (p) => (await fetch(`${BASE}${p}`)).text();

function parseWav(buf) {
  const dv = new DataView(buf);
  let pos = 12, sr = 0, ch = 1, samples = null;
  while (pos + 8 <= buf.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") { ch = dv.getUint16(pos + 10, true); sr = dv.getUint32(pos + 12, true); }
    if (id === "data") samples = new Float32Array(buf.slice(pos + 8, pos + 8 + size));
    pos += 8 + size + (size & 1);
  }
  return { sr, ch, samples };
}
const rms = (s) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / Math.max(1, s.length));
const regionBytes = async (r, i) => parseWav(await (await fetch(`${BASE}${r.regions[i].url}`)).arrayBuffer());

const stamp = Date.now().toString(36);
const made = [];
let mcp = null;

try {

/* ═════════════════ the page and its assets are actually served ══════════ */

log("\n-- the window is served, whole --");
{
  const html = await text("/daw.html");
  const js = await text("/daw.js");
  const css = await text("/daw.css");
  ok("daw.html is served and is the arrangement window", html.includes("d-shell") && html.includes("arrCanvas"));
  ok("it links styles.css before daw.css (one palette)",
    html.indexOf("styles.css") > 0 && html.indexOf("styles.css") < html.indexOf("daw.css"));
  ok("daw.js is served as a module and is the UI, not the P0 prototype",
    js.includes("THE BINDING PRINCIPLE") && js.includes("function drawArr()") && js.includes("function laneRef("));
  ok("daw.css is served", css.includes(".d-fader"));
  ok("the page pulls no external asset (no framework, no CDN)",
    !/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/<!--[\s\S]*?-->/g, "")));
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  ok(`the served pair agrees on all ${wanted.length} ids (a broken pair is a blank page)`,
    wanted.every((i) => ids.has(i)), wanted.filter((i) => !ids.has(i)).join(", "));
}

/* ═════════════════ the browser panel's own reads ════════════════════════ */

log("\n-- the browser panel: palette, licences, install state, refusals --");
{
  const p = await get("/api/daw/patches");
  ok("the palette serves every patch with a family and an install state",
    p.patches.length >= 19 && p.patches.every((r) => r.family && "installed" in r));
  const gen = p.patches.filter((r) => r.kind === "generate");
  ok("the four generate-this-part rows are there, each carrying its refusal",
    gen.length === 4 && gen.every((r) => r.refusal && r.installed === false),
    gen.map((r) => r.id).join(", "));
  const sal = p.patches.find((r) => r.id === "salamander");
  ok("Salamander declares CC-BY and that attribution is REQUIRED",
    sal.pack.licence.spdx === "CC-BY-3.0" && sal.pack.attribution_required === true
    && !!sal.pack.attribution, JSON.stringify(sal.pack.licence));
  ok("the licence is on the row BEFORE anything is installed (the palette's gate)",
    p.packs.every((k) => !!k.licence?.spdx));

  const rack = await get("/api/daw/rack");
  ok("the rack catalog the device strip is built from agrees with the store",
    rack.tables_agree === true, JSON.stringify(rack.problems ?? ""));
  const devs = rack.catalog.devices;
  ok("every device carries a label, a why and typed params (the panel needs all three)",
    Object.values(devs).every((d) => d.label && d.why && Object.values(d.params)
      .every((s) => s.type && s.desc)));
  const nums = Object.values(devs).flatMap((d) => Object.values(d.params)).filter((s) => s.type === "number");
  ok(`every numeric parameter declares min/max/animatable (${nums.length} of them)`,
    nums.every((s) => Number.isFinite(s.min) && Number.isFinite(s.max) && "animatable" in s));
}

/* ═════════════════ THE JOURNEY: a project, built by the gestures ════════ */

log("\n-- the browser → arrangement → piano roll journey, in bytes --");
const c = await api({ action: "create", name: `dawui-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 8 });
const slug = c.slug; made.push(slug);

/* gesture: click Salamander in the browser, press ＋ in the track column */
const tr = await api({ action: "add_track", slug, instrument: "salamander", name: "grand" });
ok("＋ with Salamander picked adds a track on the sampled grand",
  (await get(`/api/daw/project/${slug}`)).project.tracks[0].instrument.patch === "salamander");

/* gesture: draw four notes in the piano roll (draw mode, grid 1/8) */
const drawn = [];
for (const [bar, beat, pitch] of [[1, 1, 60], [1, 3, 64], [2, 1, 67], [2, 3, 72]]) {
  const r = await api({ action: "add_note", slug, track: tr.trackId, bar, beat, tick: 0,
                        pitch, vel: 100, dur_ticks: 480 });
  drawn.push(r.note.id);
  ok(`drawn note ${pitch} is attributed to the human hand`, r.note.by === "user");
}

const r1 = await api({ action: "render", slug });
const w1 = await regionBytes(r1, 0);
ok("the grand actually sounds — the region is not silent (bytes, not trust)",
  rms(w1.samples) > 1e-3, `rms ${rms(w1.samples).toExponential(2)}`);
ok("rendering a licensed patch attaches its credit",
  r1.credits.some((k) => k.pack === "salamander" && k.required === true),
  JSON.stringify(r1.credits.map((k) => k.pack)));
const cred = await api({ action: "credits", slug });
ok("the credits panel's own read shows the CC-BY line a human must see",
  cred.credits.some((k) => (k.attribution || "").length > 10));

/* gesture: drag a note (multi-note drag posts one move_note per note) */
const before = rms(w1.samples);
const mv = await api({ action: "move_note", slug, track: tr.trackId, note: drawn[3],
                       bar: 2, beat: 4, tick: 0, pitch: 76, dur_ticks: 960 });
ok("a note drag names exactly the region it dirtied", mv.dirty.length === 1 && mv.dirty[0].fromBar === 1);
const r2 = await api({ action: "render", slug });
ok("only the dirty region re-rendered", r2.rendered === 1 && r2.cachedHits === 1,
  JSON.stringify({ rendered: r2.rendered, cached: r2.cachedHits }));
const w2 = await regionBytes(r2, 0);
ok("the drag changed the audio", Math.abs(rms(w2.samples) - before) > 1e-5);

/* gesture: velocity lane drag = move_note with only vel */
const vel = await api({ action: "move_note", slug, track: tr.trackId, note: drawn[0], vel: 20 });
ok("the velocity lane writes through move_note", vel.note.vel === 20);

/* gesture: quantize — the UI's own arithmetic, replayed */
const off = await api({ action: "add_note", slug, track: tr.trackId, bar: 3, beat: 1, tick: 137,
                        pitch: 62, vel: 90, dur_ticks: 240 });
{
  const GRID = 480;                       // the 1/8 the grid selector defaults to
  const inBar = (off.note.beat - 1) * 960 + off.note.tick;
  const target = Math.round(inBar / GRID) * GRID;
  const q = await api({ action: "move_note", slug, track: tr.trackId, note: off.note.id,
                        bar: 3, beat: Math.floor(target / 960) + 1, tick: target % 960 });
  ok("quantize lands the note exactly on the grid it was told to",
    (q.note.beat - 1) * 960 + q.note.tick === target, `${q.note.beat}.${q.note.tick} vs ${target}`);
}

/* ═════════════════ A PINNED GAP, NOT A HIDDEN ONE ══════════════════
 * Found while driving the device strip on a Salamander track: THE CHAIN
 * STAGE CANNOT RENDER ANY SAMPLED PATCH. rack.py's `_synth_notes` resolves
 * a note through engine.py's builtin SYNTHS table instead of through
 * instruments.py's `synth_note_mono`, so the moment a track carrying a
 * sampled patch gets an insert, a pan, a send or a non-unity fader - or the
 * master gets one device - the render raises "unknown instrument". All 12
 * sampled patches are affected; only pluck / pad / drums survive.
 *
 * The fix is one call inside a file this stage was told not to touch, so it
 * is REPORTED rather than patched, and pinned here. When it is fixed this
 * assertion fails, which is the point: somebody must delete the pin. */

log("\n-- PINNED GAP: a sampled patch cannot go through the rack (rack.py) --");
{
  const eq = await api({ action: "insert_add", slug, target: tr.trackId, type: "eq" });
  let msg = "";
  try { await api({ action: "render", slug }); } catch (err) { msg = err.message; }
  ok("a Salamander track with ONE insert refuses to render - rack.py only knows the builtin synths",
    /unknown instrument 'salamander'/.test(msg), msg || "(it rendered - the gap is fixed; delete this pin)");
  await api({ action: "insert_remove", slug, target: tr.trackId, insert: eq.insertId });
  const back = await api({ action: "render", slug });
  ok("removing it makes the project default-mixer again and it renders", back.regions.length > 0);
}

/* ═════════════════ THE DEVICE STRIP: catalog-driven, and audible ════════ */

log("\n-- the device strip: add an EQ, turn a knob, hear the difference --");
const c2 = await api({ action: "create", name: `dawui-rack-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 8 });
const slug2 = c2.slug; made.push(slug2);
const tr2 = await api({ action: "add_track", slug: slug2, instrument: "pluck", name: "keys" });
for (let bar = 1; bar <= 8; bar++) {
  await api({ action: "add_note", slug: slug2, track: tr2.trackId, bar, beat: 1, tick: 0,
              pitch: 55 + bar, vel: 110, dur_ticks: 1920 });
}
{
  const ins = await api({ action: "insert_add", slug: slug2, target: tr2.trackId, type: "eq" });
  ok("＋insert adds an EQ and answers the chain", ins.chain.length === 1 && ins.chain[0].type === "eq");
  const rEq = await api({ action: "render", slug: slug2 });
  const wEq = await regionBytes(rEq, 0);
  ok("a chained track renders through the rack (stereo — 2× the manifest samples)",
    wEq.samples.length === rEq.regions[0].nSamples * 2,
    `${wEq.samples.length} vs 2x${rEq.regions[0].nSamples}`);
  const flat = rms(wEq.samples);

  /* gesture: drag the b1_gain_db knob to +15 dB and drop it */
  const set = await api({ action: "insert_set", slug: slug2, target: tr2.trackId, insert: ins.insertId,
                          params: { b1_hz: 120, b1_gain_db: 15, b1_q: 1 } });
  ok("the knob posts insert_set and the edit names its dirt", set.dirty.length >= 1);
  const rBoost = await api({ action: "render", slug: slug2 });
  const boosted = rms((await regionBytes(rBoost, 0)).samples);
  ok(`+15 dB at 120 Hz is in the bytes (${flat.toExponential(2)} → ${boosted.toExponential(2)})`,
    boosted > flat * 1.02, `${boosted.toExponential(4)} vs ${flat.toExponential(4)}`);

  /* gesture: the bypass button */
  await api({ action: "insert_set", slug: slug2, target: tr2.trackId, insert: ins.insertId, enabled: false });
  const rBy = await api({ action: "render", slug: slug2 });
  const bypassed = rms((await regionBytes(rBy, 0)).samples);
  ok("bypass really bypasses (back within 0.5 % of the flat chain)",
    Math.abs(bypassed - flat) / flat < 0.005, `${bypassed.toExponential(4)} vs ${flat.toExponential(4)}`);
  await api({ action: "insert_set", slug: slug2, target: tr2.trackId, insert: ins.insertId, enabled: true });
  await api({ action: "insert_remove", slug: slug2, target: tr2.trackId, insert: ins.insertId });
  ok("✕ removes it again",
    (await get(`/api/daw/project/${slug2}`)).project.tracks[0].inserts.length === 0);
}

/* ═════════════════ AUTOMATION: a fader ride becomes keyframes ═══════════ */

log("\n-- riding a fader into an automation lane --");
{
  const rPre = await api({ action: "render", slug: slug2 });
  const pre = rms((await regionBytes(rPre, 1)).samples);      // bars 5-8

  /* This is exactly what wireFader → writeRide → writeLane posts: the
   * parameter's OWN action, carrying the store's own keyframe shape with
   * t in FLOAT BARS. */
  const ride = await api({ action: "mixer_set", slug: slug2, target: tr2.trackId,
                           fader: { keys: [{ t: 1, v: 0 }, { t: 5, v: -6 }, { t: 8, v: -40 }] } });
  ok("the ride names its dirt", ride.dirty.length >= 1);
  const doc = await get(`/api/daw/project/${slug2}`);
  const f = doc.project.tracks[0].fader;
  ok("the document now holds { keys: [{t, v}] } — the shape the lane draws",
    Array.isArray(f?.keys) && f.keys.length === 3 && near(f.keys[2].t, 8) && near(f.keys[2].v, -40),
    JSON.stringify(f));
  const rPost = await api({ action: "render", slug: slug2 });
  const post = rms((await regionBytes(rPost, 1)).samples);
  ok(`bars 5-8 are quieter through the ride (${pre.toExponential(2)} → ${post.toExponential(2)})`,
    post < pre * 0.7);

  /* gesture: "flatten" — the lane's own button, the same action, a number */
  await api({ action: "mixer_set", slug: slug2, target: tr2.trackId, fader: -6 });
  ok("flatten writes a plain number back through the identical action",
    typeof (await get(`/api/daw/project/${slug2}`)).project.tracks[0].fader === "number");

  /* an insert parameter lane rides the same way */
  const ins = await api({ action: "insert_add", slug: slug2, target: tr2.trackId, type: "utility" });
  await api({ action: "insert_set", slug: slug2, target: tr2.trackId, insert: ins.insertId,
              params: { gain_db: { keys: [{ t: 1, v: 0 }, { t: 8, v: -18 }] } } });
  const u = (await get(`/api/daw/project/${slug2}`)).project.tracks[0].inserts[0];
  ok("an insert parameter carries keyframes too — the lane list is not a lie",
    Array.isArray(u.params.gain_db?.keys) && u.params.gain_db.keys.length === 2);
  await api({ action: "insert_remove", slug: slug2, target: tr2.trackId, insert: ins.insertId });
}

/* ═════════════════ THE MIXER: sends, returns, solo, and the meters ══════ */

log("\n-- the mixer strip: a return, a send, and MEASURED levels --");
{
  const ret = await api({ action: "return_add", slug: slug2, name: "Verb" });
  await api({ action: "insert_add", slug: slug2, target: ret.returnId, type: "reverb", params: { mix: 1.0 } });
  await api({ action: "send_set", slug: slug2, track: tr2.trackId, to: ret.returnId, level: -6 });
  const doc = await get(`/api/daw/project/${slug2}`);
  ok("the send row the strip draws is on the document",
    doc.project.tracks[0].sends[0].to === ret.returnId && doc.project.tracks[0].sends[0].level === -6);
  await api({ action: "mixer_set", slug: slug2, target: tr2.trackId, pan: -0.6 });
  const rSt = await api({ action: "render", slug: slug2 });
  const wSt = await regionBytes(rSt, 0);
  let eL = 0, eR = 0;
  for (let i = 0; i + 1 < wSt.samples.length; i += 2) { eL += wSt.samples[i] ** 2; eR += wSt.samples[i + 1] ** 2; }
  ok("the pan the strip drew is in the bytes (L > R)", eL > eR * 1.15, `L ${eL.toFixed(1)} R ${eR.toFixed(1)}`);

  const met = await api({ action: "meters", slug: slug2, from_bar: 1, to_bar: 8 });
  ok("‘measure’ answers per bus with the numbers the strips print",
    typeof met.master.peak_db === "number" && typeof met.master.lufs === "number"
    && typeof met.master.true_peak_db === "number" && !!met.tracks[tr2.trackId]
    && !!met.returns[ret.returnId], JSON.stringify(met.master));
  ok("a measured track row carries peak and rms — what paintMeter draws",
    typeof met.tracks[tr2.trackId].peak_db === "number"
    && typeof met.tracks[tr2.trackId].rms_db === "number");
}

/* ═════════════════ 7/8: the grid the canvas is drawn from ═══════════════ */

log("\n-- 7/8, and a meter change mid-song, drawn from the server's own bars --");
{
  const o = await api({ action: "create", name: `dawui-odd-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 12 });
  made.push(o.slug);
  await api({ action: "set_meter", slug: o.slug, at_bar: 5, num: 7, den: 8 });
  await api({ action: "set_tempo", slug: o.slug, at_bar: 9, bpm: 90 });
  const { timeline } = await get(`/api/daw/project/${o.slug}`);

  const b4 = timeline[3], b5 = timeline[4], b9 = timeline[8];
  ok("bars 1-4 stay 4/4 and 4 quarters wide", b4.num === 4 && b4.den === 4 && near(b4.qLen, 4));
  ok("bar 5 is 7/8 and 3.5 quarters wide — NARROWER, which is the feature",
    b5.num === 7 && b5.den === 8 && near(b5.qLen, 3.5));
  ok("a 7/8 bar's beat grid has 7 columns, not 8",
    b5.num === 7 && near(4 / b5.den * b5.num, b5.qLen));
  ok("bar 5 lasts 1.75 s at 120 quarter-bpm (closed form)", near(b5.secLen, 1.75, 1e-9));
  ok("the tempo change at bar 9 stretches the same 7/8 bar to 2.333 s",
    b9.bpm === 90 && near(b9.secLen, 3.5 * 60 / 90, 1e-9), `${b9.secLen}`);
  ok("a bar's x is its own qStart — bar 9 does NOT sit at 8 × 4 quarters",
    near(b9.qStart, 4 * 4 + 4 * 3.5) && !near(b9.qStart, 32), `${b9.qStart}`);
  ok("ticksPerBar follows the numerator (7 × 960 in 7/8)", b5.ticksPerBar === 7 * 960);

  /* the piano roll's quantize clamp: a note late in a 7/8 bar may not spill */
  const t = await api({ action: "add_track", slug: o.slug, instrument: "pluck" });
  const n = await api({ action: "add_note", slug: o.slug, track: t.trackId, bar: 5, beat: 7,
                        tick: 900, pitch: 60, dur_ticks: 240 });
  ok("beat 7 exists in a 7/8 bar and the note stays in bar 5",
    n.note.bar === 5 && n.note.beat === 7, JSON.stringify(n.note));
  let refused = false;
  try { await api({ action: "add_note", slug: o.slug, track: t.trackId, bar: 5, beat: 8, pitch: 60 }); }
  catch { refused = true; }
  ok("beat 8 does NOT exist in a 7/8 bar, and the server says so", refused);
}

/* ═════════════════ LIVE SYNC: an agent in another process ═══════════════ */

log("\n-- live sync: an MCP edit in a SECOND PROCESS reaches an open page --");
{
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("the /live socket refused the page's connection"));
    setTimeout(() => rej(new Error("/live did not open in 5 s")), 5000);
  });
  ws.onmessage = (ev) => { try { frames.push(JSON.parse(ev.data)); } catch { /* not ours */ } };
  ok("the page's websocket connects to the studio's existing /live socket", ws.readyState === 1);
  await new Promise((r) => setTimeout(r, 200));
  ok("the socket still serves job state — the DAW rides it, it does not take it over",
    frames.some((f) => f.type === "state"));

  /* THE SECOND PROCESS. Not a second fetch from this script: the real MCP
   * server, talking HTTP to the studio, exactly as an agent does. */
  mcp = spawn(process.execPath, [path.join(HERE, "..", "server", "mcp.js")], {
    env: { ...process.env, AIPLAY_URL: BASE }, stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  mcp.stdout.on("data", (d) => {
    buf += d;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }
      catch { /* not protocol */ }
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`MCP ${method} timed out`)); }, 60_000);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const m = await rpc("tools/call", { name, arguments: args });
    const t = m.result?.content?.[0]?.text ?? "";
    if (m.result?.isError) throw new Error(t);
    return JSON.parse(t);
  };
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  const waitFrame = (pred, ms = 4000) => new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = frames.find(pred);
      if (hit) return res(hit);
      if (Date.now() - t0 > ms) return res(null);
      setTimeout(tick, 25);
    };
    tick();
  });

  const mark = frames.length;
  const added = await call("daw_add_note", { slug, track: tr.trackId, bar: 4, beat: 2, pitch: 81 });
  const f = await waitFrame((x) => x.type === "daw" && x.slug === slug && x.action === "add_note");
  ok("the agent's note pushes a daw frame onto the open page's socket", !!f, JSON.stringify(frames.slice(mark)));
  ok("the frame says the AGENT did it, and what", f?.by === "agent" && f?.detail?.includes("81"),
    JSON.stringify(f));
  const docNow = await get(`/api/daw/project/${slug}`);
  ok("the frame's revision is the document's own — the page can skip what it holds",
    f?.updatedAt === docNow.project.updatedAt);
  ok("the note itself is attributed to the agent (the ledger cannot lie)",
    docNow.project.tracks[0].clips.flatMap((cl) => cl.notes)
      .find((n) => n.id === added.note_id)?.by === "agent");
  ok("the newest ledger row is the agent's, so the session log names it",
    docNow.project.ledger[0].by === "agent" && docNow.project.ledger[0].action === "add_note");

  /* And the negative: a RENDER writes region files under the same tree and
   * must NOT wake the page — otherwise the live channel becomes noise. */
  const mark2 = frames.length;
  await api({ action: "render", slug });
  await new Promise((r) => setTimeout(r, 400));
  ok("a render (region files, no document write) pushes no daw frame",
    !frames.slice(mark2).some((x) => x.type === "daw"),
    JSON.stringify(frames.slice(mark2).filter((x) => x.type === "daw")));

  /* A burst of edits collapses to one frame per revision, not one per write. */
  const mark3 = frames.length;
  await call("daw_mixer", { op: "set", slug: slug2, target: tr2.trackId, fader: -4 });
  const f2 = await waitFrame((x) => x.type === "daw" && x.action === "mixer_set");
  ok("a mixer edit over MCP reaches the page too (not just notes)", !!f2 && f2.by === "agent");
  const dupes = frames.slice(mark3).filter((x) => x.type === "daw" && x.updatedAt === f2?.updatedAt);
  ok("one frame per document revision, not one per filesystem event", dupes.length === 1, `${dupes.length}`);

  ws.close();
}

/* ═════════════════ BOUNCE: the credit a human can read ══════════════════ */

log("\n-- the bounce dialog's promise: attribution visible, not only embedded --");
{
  const b = await api({ action: "bounce", slug });
  ok("the bounce writes a file and reports its seconds", !!b.file && b.seconds > 0);
  ok("it hands back the attribution lines the dialog prints",
    Array.isArray(b.attribution) && b.attribution.some((a) => /salamander|Salamander/i.test(a)),
    JSON.stringify(b.attribution));
  ok("and the credits rows the panel renders", b.credits.some((k) => k.required === true));
  log(`        (bounced to ${b.file})`);
}

} catch (err) {
  fails.push(`unhandled: ${err.message}`);
  log(`\n  UNHANDLED: ${err.stack}`);
} finally {
  if (mcp) { try { mcp.stdin.end(); mcp.kill(); } catch { /* gone */ } }
  for (const s of made) {
    try { await api({ action: "delete", slug: s }); log(`  (cleaned up ${s})`); } catch { /* gone */ }
  }
}

log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  log("  failed:\n   " + fails.join("\n   ") + "\n");
  process.exit(1);
}
