/**
 * End-to-end check of the 2026-08-27 palette additions, over HTTP and MCP.
 *
 * scripts/e2e_daw.mjs proves the P0 surface. This one proves the things that
 * are only true if the NEW rows are wired through every layer:
 *
 *   THE FRONT PANEL   a drum machine declares its knobs in patches.json;
 *                     daw_patches publishes them; store.js's normParams lets
 *                     exactly those through and drops the rest; and turning
 *                     one over the wire CHANGES THE RENDERED BYTES. A knob
 *                     that survives all four layers is a knob; one that dies
 *                     on any of them is a lie in a JSON file.
 *   THE LICENCE GATE  the two new CC-BY packs (Greg Sullivan's e-pianos,
 *                     Lars Muldjord's kit) show their licence before a byte
 *                     moves, and a render that uses one appends the credit
 *                     line to the provenance ledger. A missing credit is a
 *                     FAILURE here, not a warning.
 *   THE BEAT          eight bars of 808 kit + a sampled bass + a CC-BY
 *                     electric piano, bounced to a real file, measured.
 *
 * Needs the server running:  AIPLAY_UI_PORT=4278 node server/index.js
 * Then:                      node scripts/e2e_dawkits.mjs 4278
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || "4278";
const BASE = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
const log = (...a) => console.log(...a);
function ok(label, cond, detail = "") {
  if (cond) { pass++; log(`  ok    ${label}`); }
  else { fails.push(label); log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

async function api(body) {
  const r = await fetch(`${BASE}/api/daw`, {
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

function parseWav(buf) {
  const dv = new DataView(buf);
  let pos = 12, sr = 0, samples = null;
  while (pos + 8 <= buf.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1),
      dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") sr = dv.getUint32(pos + 12, true);
    if (id === "data") samples = new Float32Array(buf.slice(pos + 8, pos + 8 + size));
    pos += 8 + size + (size & 1);
  }
  if (!sr || !samples) throw new Error("wav missing fmt/data");
  return { sr, samples };
}
const bytesOfRegion = async (g) => parseWav(await (await fetch(`${BASE}${g.url}`)).arrayBuffer());
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const peak = (s) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (s) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / Math.max(s.length, 1));

const stamp = Date.now().toString(36);
const made = [];
let mcp = null;
let BEAT = null;

try {
  /* ─────────────────────────────────────────── the registry, over HTTP ── */
  log("\n-- the new rows exist on the wire, licence first --");
  const reg = await get("/api/daw/patches");
  const byId = Object.fromEntries(reg.patches.map((p) => [p.id, p]));

  const MACHINES = ["tr808", "tr909", "tr808_bass", "hybrid_kick"];
  ok("the four drum machines are listed, installed, and carry no pack at all",
    MACHINES.every((m) => byId[m] && byId[m].installed === true
      && byId[m].kind === "builtin" && byId[m].pack === null),
    JSON.stringify(MACHINES.map((m) => [m, byId[m]?.installed, byId[m]?.pack])));
  ok("...and each publishes its front panel with min/max/default/doc",
    MACHINES.every((m) => byId[m].params
      && Object.values(byId[m].params).every((s) =>
        Number.isFinite(s.min) && Number.isFinite(s.max)
        && Number.isFinite(s.default) && typeof s.doc === "string")),
    JSON.stringify(Object.keys(byId.tr808.params || {})));
  ok(`the 808 kit exposes ${Object.keys(byId.tr808.params).length} knobs and the `
    + `909 ${Object.keys(byId.tr909.params).length} — they are different circuits, `
    + "not one with two names",
    Object.keys(byId.tr808.params).includes("kick_click")
    && Object.keys(byId.tr909.params).includes("kick_attack")
    && !Object.keys(byId.tr808.params).includes("kick_attack"));

  const NEW_PACKS = ["eguitar_clean", "eguitar_jazz", "growlybass", "epianos",
    "organ_drawbar", "organ_percussive", "organ_rock", "muldjord", "harp"];
  const packs = Object.fromEntries(reg.packs.map((p) => [p.id, p]));
  ok("all nine new sampled packs are in the registry with a licence and a size",
    NEW_PACKS.every((p) => packs[p] && packs[p].licence?.spdx && packs[p].bytes > 0),
    NEW_PACKS.filter((p) => !packs[p]?.licence?.spdx).join(", "));
  ok("the two CC-BY packs declare attribution REQUIRED and name their authors "
    + "BEFORE any download",
    packs.epianos.attribution_required === true
    && /Greg Sullivan/.test(packs.epianos.attribution || "")
    && packs.muldjord.attribution_required === true
    && /Lars Muldjord/.test(packs.muldjord.attribution || ""));
  const budget = reg.packs.reduce((a, p) => a + (p.bytes || 0), 0);
  log(`        download budget across the whole palette: ${(budget / 1e6).toFixed(0)} MB `
    + `over ${reg.packs.length} packs (nothing is fetched until a licence is accepted)`);

  ok("acoustic guitar is an honest refusal, not a weak pack",
    byId.acoustic_guitar?.kind === "generate"
    && /GPL-3/.test(byId.acoustic_guitar.refusal || "")
    && byId.acoustic_guitar.installed === false);
  ok("...and the original four refusals still refuse",
    ["sax", "sitar", "choir", "solo_cello"].every((p) =>
      byId[p]?.kind === "generate" && (byId[p].refusal || "").length > 40));

  /* ─────────────────────────── the front panel reaches the samples ────── */
  log("\n-- THE FRONT PANEL: a knob on the wire moves the rendered bytes --");
  const c = await api({ action: "create", name: `kits-${stamp}`, bpm: 90, num: 4, den: 4, length_bars: 8 });
  const slug = c.slug; made.push(slug);
  const kit = await api({ action: "add_track", slug, instrument: "tr808", name: "808" });
  for (let b = 1; b <= 4; b++) {
    await api({ action: "add_note", slug, track: kit.trackId, bar: b, beat: 1, pitch: 36, vel: 120, dur_ticks: 240 });
    await api({ action: "add_note", slug, track: kit.trackId, bar: b, beat: 3, pitch: 38, vel: 110, dur_ticks: 240 });
  }
  const r0 = await api({ action: "render", slug });
  const base = await bytesOfRegion(r0.regions.find((g) => g.fromBar === 1));

  const t1 = await api({ action: "set_track", slug, track: kit.trackId, params: { kick_tune: -7, kick_decay: 0.95 } });
  ok("set_track keeps the knobs the machine declares",
    t1.track?.instrument?.params?.kick_tune === -7
    && t1.track.instrument.params.kick_decay === 0.95,
    JSON.stringify(t1.track?.instrument?.params));
  const t2 = await api({ action: "set_track", slug, track: kit.trackId,
    params: { kick_tune: -7, kick_decay: 0.95, kick_attack: 0.9, nonsense: 4 } });
  ok("...and drops one that belongs to ANOTHER machine, plus outright nonsense",
    t2.track.instrument.params.kick_attack === undefined
    && t2.track.instrument.params.nonsense === undefined,
    JSON.stringify(t2.track.instrument.params));
  const r1 = await api({ action: "render", slug });
  ok("a knob change dirties the regions that patch sounds in", r1.rendered >= 1,
    JSON.stringify({ rendered: r1.rendered, cached: r1.cachedHits }));
  const tuned = await bytesOfRegion(r1.regions.find((g) => g.fromBar === 1));
  ok("...and the rendered AUDIO really changed — the knob is not decorative",
    !same(base.samples, tuned.samples));

  await api({ action: "set_track", slug, track: kit.trackId, params: {} });
  const r2 = await api({ action: "render", slug });
  const back = await bytesOfRegion(r2.regions.find((g) => g.fromBar === 1));
  ok("clearing the knobs returns the EXACT original bytes (a default is dropped "
    + "on write, so an untouched track hashes as it always did)",
    same(base.samples, back.samples));

  /* ──────────────────────────────── credits: the CC-BY packs ──────────── */
  log("\n-- THE LICENCE GATE: CC-BY packs pay their credit line --");
  const need = await api({ action: "install_patch", patch: "epiano_wurlitzer" });
  ok("an already-installed patch says so rather than re-downloading",
    need.installed === true || need.needsAccept === true,
    JSON.stringify(need).slice(0, 160));
  const gateOnly = await api({ action: "install_patch", patch: "tr808" });
  ok("a drum machine needs no download at all and says why",
    gateOnly.installed === true && /built-in/i.test(gateOnly.note || ""),
    JSON.stringify(gateOnly));

  const ep = await api({ action: "add_track", slug, instrument: "epiano_wurlitzer", name: "wurli" });
  const md = await api({ action: "add_track", slug, instrument: "muldjord", name: "kit2" });
  for (let b = 1; b <= 4; b++) {
    for (const p of [48, 55, 60]) {
      await api({ action: "add_note", slug, track: ep.trackId, bar: b, beat: 1, pitch: p, vel: 90, dur_ticks: 1920 });
    }
    await api({ action: "add_note", slug, track: md.trackId, bar: b, beat: 2, pitch: 42, vel: 100, dur_ticks: 120 });
  }
  const rc = await api({ action: "render", slug });
  ok("the render answers with the licences it just attached",
    (rc.licencesAttached || []).includes("epianos")
    || (rc.credits || []).some((x) => x.pack === "epianos"),
    JSON.stringify({ attached: rc.licencesAttached, credits: (rc.credits || []).map((x) => x.pack) }));
  const cr = await api({ action: "credits", slug });
  const packsCredited = cr.credits.map((x) => x.pack);
  ok("both CC-BY packs are in the project's credits, with their authors",
    cr.credits.some((x) => x.pack === "epianos" && /Greg Sullivan/.test(x.attribution || ""))
    && cr.credits.some((x) => x.pack === "muldjord" && /Lars Muldjord/.test(x.attribution || "")),
    JSON.stringify(cr.credits.map((x) => [x.pack, x.spdx])));
  ok("...and the CC0 drum machines add NOTHING to the ledger, because a "
    + "synthesised circuit owes nobody a line",
    !packsCredited.includes("tr808") && !packsCredited.includes("tr909"));
  const cr2 = await api({ action: "credits", slug });
  ok("a re-read does not duplicate a credit", cr2.credits.length === cr.credits.length);

  /* ───────────────────────────────── muldjord plays on GM keys ────────── */
  log("\n-- key_map: a kit laid out on keys 48-66, played on the GM ones --");
  const gm = await api({ action: "create", name: `gm-${stamp}`, bpm: 100, num: 4, den: 4, length_bars: 4 });
  made.push(gm.slug);
  const gk = await api({ action: "add_track", slug: gm.slug, instrument: "muldjord", name: "gm" });
  await api({ action: "add_note", slug: gm.slug, track: gk.trackId, bar: 1, beat: 1, pitch: 36, vel: 110, dur_ticks: 240 });
  await api({ action: "add_note", slug: gm.slug, track: gk.trackId, bar: 1, beat: 2, pitch: 38, vel: 110, dur_ticks: 240 });
  await api({ action: "add_note", slug: gm.slug, track: gk.trackId, bar: 1, beat: 3, pitch: 42, vel: 100, dur_ticks: 120 });
  const rg = await api({ action: "render", slug: gm.slug });
  const gw = await bytesOfRegion(rg.regions.find((g) => g.fromBar === 1));
  ok(`a GM beat on 36/38/42 makes real sound through MuldjordKit `
    + `(peak ${peak(gw.samples).toFixed(3)}) — without the key map every one of `
    + "those keys is below the pack's range and renders silence",
    peak(gw.samples) > 0.05);

  /* ─────────────────────────────────────────── the palette over MCP ───── */
  log("\n-- the palette over MCP --");
  mcp = spawn(process.execPath, [path.join(HERE, "..", "server", "mcp.js")],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AIPLAY_URL: BASE } });
  let buf = "";
  const pending = new Map();
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* not ours */ }
    }
  });
  let mid = 1;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = mid++;
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out`)); } }, 120_000);
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = (r.content || []).map((x) => x.text).join("");
    try { return JSON.parse(text); } catch { return { text }; }
  };
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "e2e_dawkits", version: "1" } });

  const drums = await call("daw_patches", { family: "drums" });
  const kitRow = drums.patches.find((p) => p.id === "tr808");
  ok("daw_patches lists the 808 with its knobs written out for an agent to set",
    Array.isArray(kitRow?.params) && kitRow.params.length === 15
    && kitRow.params.every((s) => /^\w+ -?[\d.]+\.\.-?[\d.]+ \(-?[\d.]+\)/.test(s))
    && kitRow.params.some((s) => s.startsWith("kick_decay ")),
    JSON.stringify(kitRow?.params?.slice(0, 2)));
  const keys = await call("daw_patches", { family: "keys" });
  ok("the new keys family answers over MCP with its licence and size",
    keys.patches.length >= 6
    && keys.patches.some((p) => p.id === "epiano_wurlitzer" && p.pack?.spdx === "CC-BY-3.0"),
    JSON.stringify(keys.patches.map((p) => p.id)));
  const gtr = await call("daw_patches", { family: "guitar" });
  ok("...and so does the guitar family, refusal included",
    gtr.patches.some((p) => p.id === "eguitar_clean" && p.installed)
    && gtr.patches.some((p) => p.id === "acoustic_guitar" && p.refusal),
    JSON.stringify(gtr.patches.map((p) => p.id)));
  const mcpCredits = await call("daw_credits", { slug });
  ok("daw_credits reads back both CC-BY lines",
    mcpCredits.attribution_lines.length >= 2
    && mcpCredits.attribution_lines.some((l) => /Lars Muldjord/.test(l)));

  /* ═══════════════════════════════════ THE BEAT ═════════════════════════ */
  log("\n-- THE BEAT: 8 bars, 808 kit + sampled bass + CC-BY electric piano --");
  const bt = await api({ action: "create", name: `beat-808-${stamp}`, bpm: 84, num: 4, den: 4, length_bars: 8 });
  /* NOT pushed onto `made`: the beat is the deliverable, not a fixture. The
   * whole point of this section is that a person opens the file afterwards and
   * listens to it, so the cleanup at the bottom must not eat it. */
  const bslug = bt.slug;
  const T = {};
  T.kit = (await api({ action: "add_track", slug: bslug, instrument: "tr808", name: "808 kit" })).trackId;
  T.bass = (await api({ action: "add_track", slug: bslug, instrument: "growlybass", name: "bass" })).trackId;
  T.keys = (await api({ action: "add_track", slug: bslug, instrument: "epiano_wurlitzer", name: "wurli" })).trackId;

  /* Open the kick up and drive it: this is the pattern the knobs exist for. */
  await api({ action: "set_track", slug: bslug, track: T.kit,
    params: { kick_decay: 0.82, kick_drive: 0.30, kick_click: 0.45, snare_snappy: 0.62, spread: 0.5 } });
  await api({ action: "set_track", slug: bslug, track: T.bass, gain_db: -3 });

  const N = (track, bar, beat, tick, pitch, vel, dur) =>
    api({ action: "add_note", slug: bslug, track, bar, beat, tick, pitch, vel, dur_ticks: dur });
  const Q = 480;
  for (let bar = 1; bar <= 8; bar++) {
    /* kick on 1 and the "and" of 3, snare on 2 and 4, clap doubling the snare */
    await N(T.kit, bar, 1, 0, 36, 122, 240);
    await N(T.kit, bar, 3, Q / 2, 36, 104, 240);
    if (bar % 4 !== 0) await N(T.kit, bar, 4, Q / 2, 36, 88, 240);
    for (const beat of [2, 4]) {
      await N(T.kit, bar, beat, 0, 38, 118, 240);
      await N(T.kit, bar, beat, 0, 39, 96, 240);          // 808 clap on the snare
    }
    /* sixteenth hats, open hat on the last off-beat of every second bar */
    for (let s = 0; s < 16; s++) {
      const beat = 1 + Math.floor(s / 4);
      const tick = (s % 4) * (Q / 4);
      const open = (bar % 2 === 0 && s === 14);
      await N(T.kit, bar, beat, tick, open ? 46 : 42, s % 4 === 0 ? 104 : 74, 120);
    }
    /* a two-bar bass figure in A minor, and the Wurlitzer holding the chord */
    const root = [45, 45, 41, 41, 48, 48, 43, 43][bar - 1];   // A F C G
    await N(T.bass, bar, 1, 0, root, 108, Q);
    await N(T.bass, bar, 2, Q / 2, root + 12, 84, Q / 2);
    await N(T.bass, bar, 3, Q / 2, root + 7, 96, Q);
    for (const iv of [0, 3, 7, 10]) await N(T.keys, bar, 1, 0, root + 12 + iv, 74, Q * 4);
  }
  const rb = await api({ action: "render", slug: bslug });
  ok("the beat renders every region", rb.regions.length >= 2 && rb.rendered >= 1,
    JSON.stringify({ regions: rb.regions.length, rendered: rb.rendered }));
  const bounce = await api({ action: "bounce", slug: bslug });
  ok("the beat bounces to a real file", bounce.ok && bounce.seconds > 20,
    JSON.stringify({ seconds: bounce.seconds, file: bounce.file }));
  ok("...carrying the Wurlitzer's CC-BY credit line, embedded in the file",
    bounce.attribution.some((a) => /Greg Sullivan/.test(a)) && bounce.tagged?.ok === true,
    JSON.stringify(bounce.attribution));

  /* Measure what the owner is about to hear, region by region. */
  let pk = 0, sum = 0, n = 0;
  for (const g of rb.regions.sort((a, b) => a.idx - b.idx)) {
    const w = await bytesOfRegion(g);
    pk = Math.max(pk, peak(w.samples));
    sum += w.samples.reduce((a, v) => a + v * v, 0); n += w.samples.length;
  }
  const beatRms = Math.sqrt(sum / n);
  BEAT = { file: bounce.file, seconds: bounce.seconds, peak: pk, rms: beatRms,
           dbfs: 20 * Math.log10(pk), rmsDb: 20 * Math.log10(beatRms),
           credits: bounce.attribution };
  ok(`the mix peaks at ${(20 * Math.log10(pk)).toFixed(2)} dBFS — loud but not clipped`,
    pk > 0.2 && pk <= 1.0, `peak ${pk}`);
  /* ...and a WAV beside the FLAC, because "double-click it" should not need a
   * codec argument. Written through the same soundfile the encoder used, so
   * this is a container change and nothing else. */
  const wavOut = bounce.file.replace(/\.flac$/i, ".wav");
  await new Promise((res) => {
    const py = spawn(process.env.AIPLAY_PY || "python",
      ["-c", "import sys,soundfile as sf;d,r=sf.read(sys.argv[1],dtype='float32',always_2d=True);"
           + "sf.write(sys.argv[2],d,r,subtype='PCM_24')", bounce.file, wavOut],
      { stdio: "ignore" });
    py.on("close", res); py.on("error", res);
  });
  BEAT.wav = wavOut;
  log(`\n        BOUNCE: ${bounce.file}`);
  log(`        WAV:    ${wavOut}`);
  log(`        ${bounce.seconds.toFixed(2)} s at 84 bpm, 8 bars of 4/4`);
  log(`        peak ${(20 * Math.log10(pk)).toFixed(2)} dBFS   RMS ${(20 * Math.log10(beatRms)).toFixed(2)} dBFS`);
  log(`        credits: ${bounce.attribution.join(" | ")}`);
} catch (err) {
  fails.push(`THREW: ${err.message}`);
  log(`\n  FAIL  threw: ${err.stack || err.message}`);
} finally {
  if (mcp) mcp.kill();
  for (const s of made) {
    try { await api({ action: "delete", slug: s, confirm: s }); } catch { /* leave it */ }
  }
}

log(`\n  ${pass} passed, ${fails.length} failed`);
if (BEAT) log(`  beat: ${BEAT.file}`);
if (fails.length) { log(`  failed:\n   ${fails.join("\n   ")}\n`); process.exit(1); }
