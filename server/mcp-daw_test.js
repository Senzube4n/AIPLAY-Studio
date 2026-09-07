/**
 * Every parameter a DAW tool ADVERTISES actually reaches the route.
 *
 * The mcp-vfx_test guard, applied to the daw_* family: a schema that grows a
 * property whose run() never forwards it validates, returns 200, and silently
 * does nothing — worse than a refusal, because additionalProperties: false
 * tells the client to trust the schema. The check reads each run()'s source
 * and asks whether every declared parameter is named in it (snake_case or its
 * camelCase twin); "declared and dropped" is the class that has actually
 * shipped here.
 *
 * ── AND THE PARITY GATE, the other way round (agent/dawparity) ───────────
 *
 * server/daw/ui_test.js proves every action the PAGE posts is one the server
 * really dispatches. This file now proves the mirror image: every action the
 * server dispatches is one some daw_* tool can reach. That is the owner's
 * standing constraint — everything a human can do, an agent can do — in
 * executable form. It was not, and six capabilities (set_length, remove_track,
 * remove_clip, remove_meter, remove_tempo, preview_note) plus three more the
 * first sweep missed (record_notes, set_audio_clip, remove_audio_clip) were
 * reachable from the window and from nowhere else. An exemption is allowed,
 * but it has to be written down with a reason.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dawTools } from "./mcp-daw.js";
import { MIXER_ACTIONS } from "./daw/mixer.js";
import { PATCHES, normParams } from "./daw/store.js";

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const tools = dawTools(async () => ({}), (s) => s);

/* Parameters a tool takes but does not name in run(), on purpose — with the
 * reason, so it stays a decision someone wrote down. (None yet.) */
const IGNORED = {};

console.log("\n  -- the tool list is well formed --");

ok("every tool has a name, a description, a schema and a run",
  tools.every((t) => t.name && t.description && t.inputSchema && typeof t.run === "function"));

const names = tools.map((t) => t.name);
ok("no duplicate tool names", new Set(names).size === names.length,
  names.filter((n, i) => names.indexOf(n) !== i).join(", "));

ok("every tool is in the daw_ family", names.every((n) => n.startsWith("daw_")), names.join(", "));

ok("every schema refuses undeclared properties",
  tools.every((t) => t.inputSchema.additionalProperties === false),
  tools.filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name).join(", "));

ok("every required parameter is also declared",
  tools.every((t) => (t.inputSchema.required || []).every((r) => t.inputSchema.properties?.[r])),
  tools.filter((t) => (t.inputSchema.required || []).some((r) => !t.inputSchema.properties?.[r]))
    .map((t) => t.name).join(", "));

console.log("\n  -- nothing is advertised and then dropped --");

const dropped = [];
for (const t of tools) {
  if (IGNORED[t.name] === "*") continue;
  const src = String(t.run);
  const ignored = new Set(IGNORED[t.name] || []);
  for (const p of Object.keys(t.inputSchema.properties || {})) {
    if (ignored.has(p)) continue;
    const camel = p.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!src.includes(p) && !src.includes(camel)) dropped.push(`${t.name}.${p}`);
  }
}

ok("every declared parameter is named in its run()", dropped.length === 0,
  dropped.length
    ? `${dropped.join(", ")}\n          Either forward it, or add it to IGNORED with a reason.`
    : "");

console.log("\n  -- THE PARITY GATE: no capability is reachable from one hand only --");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(path.join(HERE, p), "utf8");

/* Route-level case labels only: both files also switch on card kinds and
 * device types further in, at four spaces. Eight is the dispatch. */
const routeCases = (s) => [...s.matchAll(/^ {8}case "([a-z0-9_]+)": \{/gm)].map((m) => m[1]);
/* THE THIRD DISPATCHER, and the reason three capabilities got past this gate.
 * routes.js mounts voicelab.js the way it mounts mixer.js — one call before
 * the switch — so `voice_lab`, `render_stems` and `peaks` have no `case` in
 * any file this scrape read, and MIXER_ACTIONS covered only the mixer's. They
 * were dispatched, surfaced in the page and reachable by no tool, and this
 * suite reported 0 failed. Imported optionally, exactly as routes.js and
 * ui_test.js treat the module: on a tree without it there is one dispatcher
 * fewer, not a broken census. */
const voicelab = await import("./daw/voicelab.js").catch(() => null);
/* THE FOURTH DISPATCHER, mounted the same way, for the same reason. */
const refprofile = await import("./daw/refprofile.js").catch(() => null);
const serverActions = [...new Set([
  ...routeCases(rd("daw/routes.js")),
  ...routeCases(rd("daw/ear.js")),
  ...MIXER_ACTIONS,
  ...(voicelab?.VOICELAB_ACTIONS || []),
  ...(refprofile?.REFPROFILE_ACTIONS || []),
])].sort();

/* What the tool family posts, read out of the run() sources themselves —
 * the same evidence the declared-and-dropped check uses. */
const reached = new Map();
for (const t of tools) {
  for (const m of String(t.run).matchAll(/action:\s*"([a-z0-9_]+)"/g)) {
    if (!reached.has(m[1])) reached.set(m[1], []);
    reached.get(m[1]).push(t.name);
  }
}

/* Actions deliberately left off the MCP surface, WITH the reason. */
const NO_TOOL = {
  analyse_file: "THE EAR's file measurement — server/daw/ear.js and mcp-ear.js are the "
    + "Ear lane's files, not this one's. Reachable over HTTP; reported as an open gap.",
  judge: "THE EAR's subjective stage — same lane, same reason. Reported as an open gap.",
};

const unreachable = serverActions.filter((a) => !reached.has(a) && !NO_TOOL[a]);
ok(`every action the server dispatches is reachable from a tool (${serverActions.length} actions)`,
  unreachable.length === 0,
  unreachable.length
    ? `${unreachable.join(", ")}\n          A human can do these and an agent cannot. `
      + "Add a tool, or add the action to NO_TOOL with a reason."
    : "");

ok("every exemption names an action that really exists",
  Object.keys(NO_TOOL).every((a) => serverActions.includes(a)),
  Object.keys(NO_TOOL).filter((a) => !serverActions.includes(a)).join(", "));
ok("...and no exemption is stale (a covered action must not stay exempt)",
  Object.keys(NO_TOOL).every((a) => !reached.has(a)),
  Object.keys(NO_TOOL).filter((a) => reached.has(a)).join(", "));

/* The mirror of the mirror: a tool must not post an action the server has
 * no case for — the same orphan check ui_test.js runs over the page. */
const orphans = [...reached.keys()].filter((a) => !serverActions.includes(a));
ok("no tool posts an action the server does not dispatch", orphans.length === 0,
  orphans.map((a) => `${a} (${reached.get(a).join(", ")})`).join(", "));

console.log(`        (exempt, by name: ${Object.keys(NO_TOOL).join(", ") || "none"})`);

/* ═══════ THE PARITY GATE, ONE LEVEL DOWN: EVERY KNOB, FROM THE AGENT'S HAND ═══
 *
 * server/daw/ui_test.js holds the HUMAN hand to patches.json's knob table (a
 * panel drawn from the served row, writing set_track). This is the agent's
 * half, and it is EXECUTED rather than read: every knob every builtin patch
 * declares is sent through daw_set_track.run() and daw_add_track.run() into
 * a capturing api, the body is checked to carry it verbatim, and the store's
 * own normParams is asked whether it keeps it. A schema that quietly closed
 * `params`, a run() that renamed it, or a knob the store would drop all fail
 * here — the "declared and dropped" class, at the parameter level. */

console.log("\n  -- every knob a patch declares reaches the store from daw_set_track / daw_add_track --");
{
  const knobbed = Object.entries(PATCHES)
    .filter(([, r]) => r.kind === "builtin" && r.params && Object.keys(r.params).length);
  ok(`patches.json declares knobs on ${knobbed.length} builtin patches`, knobbed.length >= 8,
    knobbed.map(([id]) => id).join(", "));

  const calls = [];
  const FAKE_ROW = {
    id: "bigroom_lead", family: "synth", label: "L", kind: "builtin", installed: true, quality: "q",
    params: { cutoff: { min: 80, max: 6000, default: 320, unit: "Hz", doc: "Resting cutoff." } },
    presets: { open: { doc: "measured", params: { cutoff: 1000 } } }, pack: null,
  };
  const cap = dawTools(async (method, p, body) => {
    calls.push({ method, p, body });
    if (p === "/api/daw/patches") return { patches: [FAKE_ROW], instrumentsDir: "x" };
    return { ok: true, trackId: "trk_1", track: { instrument: { patch: "x", params: body?.params || {} } }, dirty: [] };
  }, (s) => s);
  const byName = (n) => cap.find((t) => t.name === n);
  const setTrack = byName("daw_set_track");
  const addTrack = byName("daw_add_track");
  const patches = byName("daw_patches");
  const arrange = byName("daw_arrange_bigroom");

  ok("daw_set_track and daw_add_track take an OPEN params object — the schema refuses no knob",
    setTrack?.inputSchema.properties.params.type === "object"
    && setTrack.inputSchema.properties.params.additionalProperties === true
    && addTrack?.inputSchema.properties.params.additionalProperties === true);

  const probeFor = (row) => Object.fromEntries(Object.entries(row.params)
    .map(([k, s]) => [k, s.min === s.default ? s.max : s.min]));     // in range, never the default
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [pid, row] of knobbed) {
    const probe = probeFor(row);
    calls.length = 0;
    await setTrack.run({ slug: "s", track: "t", params: probe });
    const b = calls[0]?.body;
    calls.length = 0;
    await addTrack.run({ slug: "s", instrument: pid, params: probe });
    const a = calls[0]?.body;
    ok(`${pid}: all ${Object.keys(probe).length} knobs go out verbatim on set_track AND add_track, `
       + "stamped by:\"agent\", and the store keeps every one",
      b?.action === "set_track" && b.by === "agent" && same(b.params, probe) && same(normParams(b.params, pid), probe)
      && a?.action === "add_track" && a.by === "agent" && a.instrument === pid && same(a.params, probe)
      && same(normParams(a.params, pid), probe),
      JSON.stringify({ sent: probe, set_track: b?.params, kept: normParams(b?.params, pid) }));
  }

  ok("daw_set_track's description TEACHES the knobs: it names every patch that declares any",
    knobbed.every(([pid]) => setTrack.description.includes(pid)),
    knobbed.filter(([pid]) => !setTrack.description.includes(pid)).map(([pid]) => pid).join(", "));
  ok("...and points at daw_patches for min/max/default/doc and the presets",
    /daw_patches lists every patch's params with min\/max\/default\/doc/.test(setTrack.description)
    && /presets/.test(setTrack.description));

  calls.length = 0;
  const listed = await patches.run({});
  const row = listed.patches[0];
  ok("daw_patches publishes each knob as one readable line: name, range, default, unit, doc",
    Array.isArray(row?.params) && row.params[0] === "cutoff 80..6000 (320) Hz — Resting cutoff.",
    JSON.stringify(row?.params));
  ok("...and each preset as {params, doc} — data an agent sends straight back as params",
    row?.presets?.open?.params?.cutoff === 1000 && row.presets.open.doc === "measured");

  ok("the arranger is an agent's tool too: daw_arrange_bigroom posts arrange_bigroom with seed, key, tempo, structure",
    !!arrange && /action: "arrange_bigroom"/.test(String(arrange.run))
    && ["slug", "name", "seed", "key", "tempo", "structure"].every((p) => arrange.inputSchema.properties[p]));
  ok("...and quotes the sidechain's release rule (one eighth: 60000/bpm/2) so an agent can reason about the pump",
    /60000\/bpm\/2/.test(arrange?.description || ""));

  /* EXECUTED, not read: the arranger's run() forwards every declared parameter
   * to the route body verbatim, stamped by:"agent". The fake route answers
   * with the shape the tool reshapes, so the call goes all the way through. */
  const arrCalls = [];
  const arrCap = dawTools(async (method, p, body) => {
    arrCalls.push({ method, p, body });
    return { slug: body.slug || "made", created: !body.slug, key: "Ab", mode: "minor", tempo: body.tempo,
             bars: 24, seconds: 44.3, structure: [], progression: [], tracks: [], master: { inserts: [] },
             roles: {}, notes: 0, steps: 0, ms: 1, note: "n" };
  }, (x) => x).find((t) => t.name === "daw_arrange_bigroom");
  const form = [{ type: "build", bars: 8 }, { type: "drop", bars: 16 }];
  const arrOut = await arrCap.run({ slug: "empty-one", name: "N", seed: 7, key: "Ab", tempo: 130, structure: form });
  const ab = arrCalls[0]?.body;
  ok("daw_arrange_bigroom.run() forwards slug, name, seed, key, tempo and structure verbatim, by:\"agent\", as arrange_bigroom",
    ab?.action === "arrange_bigroom" && ab.by === "agent" && ab.slug === "empty-one" && ab.name === "N"
    && ab.seed === 7 && ab.key === "Ab" && ab.tempo === 130 && same(ab.structure, form),
    JSON.stringify(ab));
  ok("...every declared property reached the body (none dropped on the way)",
    Object.keys(arrCap.inputSchema.properties).every((q) => ab && ab[q] !== undefined));
  ok("...and the reply keeps the Ear's handle: roles, plus key/tempo/bars",
    arrOut && "roles" in arrOut && arrOut.key === "Ab minor" && arrOut.tempo === 130 && arrOut.bars === 24);

  /* Every REAL preset a row carries goes through daw_set_track, and the store
   * keeps exactly its non-default knobs. The page's preset button sends the
   * same object through the same action, so both hands land on the same
   * params — and a preset that named a knob its row does not declare would
   * be silently dropped on both, which is what this refuses. */
  const sameSet = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
  const withPresets = Object.entries(PATCHES).filter(([, r]) => r.presets && Object.keys(r.presets).length);
  ok(`patches.json carries presets on ${withPresets.length} row(s), hybrid_kick's measured bigroom among them`,
    withPresets.some(([id, r]) => id === "hybrid_kick" && r.presets.bigroom));
  for (const [pid, row] of withPresets) {
    for (const [pname, pre] of Object.entries(row.presets)) {
      calls.length = 0;
      await setTrack.run({ slug: "s", track: "t", params: pre.params });
      const sent = calls[0]?.body?.params;
      const kept = normParams(sent, pid);
      const expect = Object.fromEntries(Object.entries(pre.params)
        .filter(([k, v]) => row.params?.[k] && v !== row.params[k].default));
      const undeclared = Object.keys(pre.params).filter((k) => !row.params?.[k]);
      ok(`${pid}.${pname}: sent verbatim through daw_set_track, every key declared on the row, the store keeps `
         + `${Object.keys(expect).length}/${Object.keys(pre.params).length} (the rest ARE the defaults)`,
        same(sent, pre.params) && undeclared.length === 0 && sameSet(kept, expect) && typeof pre.doc === "string" && pre.doc.length > 20,
        JSON.stringify({ sent, kept, expect, undeclared }));
    }
  }
}

console.log("\n  -- the dual-control seam --");

const src = String(dawTools);
ok("every mutation goes out stamped by: \"agent\"", src.includes(`by: "agent"`));
ok("the time model is stated once and quoted",
  tools.filter((t) => t.description.includes("960 ticks per beat")).length >= 3);

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
