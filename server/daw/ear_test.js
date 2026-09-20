/**
 * THE EAR — the loop machinery, proven without a server.
 *
 * The four things that would silently rot if nobody pinned them:
 *
 *  THE MAPPING PRODUCES REAL CALLS. Every route's `op` is validated against
 *  the ACTUAL inputSchema of the ACTUAL MCP tool (`dawTools()` is constructed
 *  here and its schemas read), and every device `params` block is pushed
 *  through mixer.js's own `normParams` — which refuses unknown names and
 *  clamps out-of-range numbers, so a proposal that had to be clamped fails
 *  here. A card that promises an edit the tool would reject is worse than no
 *  card at all.
 *
 *  ROUTES GENUINELY DIFFER. SPEC D1.8.3 rule 3: "2 dB vs 3 dB is one route
 *  with a parameter". The signature deliberately excludes numbers, so a
 *  generator that quietly degrades into intensity variants fails.
 *
 *  THE A/B GUARD ACTUALLY REVERTS. Exercised end to end through injected io,
 *  including the undo call itself — not merely the verdict function.
 *
 *  ACTOR HONESTY. `choice` refuses a non-user actor and `judge` refuses a
 *  user one, at the constructor, so there is no argument anyone can pass that
 *  records an AI decision as a human one (SPEC D1.0).
 *
 *   node server/daw/ear_test.js
 */
import {
  BAND_LABELS, BAND_EDGES, bandCenter, bandQ, bandsAgree, pickEqSlot,
  mapFinding, buildCards, routesDistinct, routeSignature, CARD_CAP,
  abVerdict, applyWithGuard, AB_EPSILON, ITERATION_CAP, findingPenalty,
  neutralProfile, foldFeedback, profileWeight, autoAllowed, targetShift,
  shiftedTargets, rankCards, tasteSummary, TASTE_PRIOR,
  choiceEvent, judgeEvent, delegateEvent, approveEvent,
  buildAnalysisJob, stereoSwitchOp, masterStageOp, STEREO_SWITCH,
  songRoot, parseRoot, inferRootFromDoc,
  referenceFindings, BAND_NAMES, bandNamesAgree,
} from "./ear.js";
import { dawTools } from "../mcp-daw.js";
import { normParams, MIXER_CATALOG, handleMixerAction } from "./mixer.js";
import {
  blankProject, blankTrack, blankClip, blankAudioClip,
  noteEvents, buildTimeline, audioJobClips,
} from "./store.js";
import { EVENT_TYPES, normalizeActor } from "../provenance.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

/* ───────────────────────────────────── the real tool schemas, read live */

const TOOLS = Object.fromEntries(
  dawTools(async () => ({}), (s) => s).map((t) => [t.name, t]));

/** Validate an op against the tool's own advertised schema. */
function validateOp(op) {
  const problems = [];
  const tool = TOOLS[op?.tool];
  if (!tool) return [`no such MCP tool: ${op?.tool}`];
  const S = tool.inputSchema;
  const args = op.args || {};
  for (const r of S.required || []) {
    if (args[r] === undefined) problems.push(`${op.tool}: missing required "${r}"`);
  }
  for (const [k, v] of Object.entries(args)) {
    const spec = S.properties?.[k];
    if (!spec) { problems.push(`${op.tool}: undeclared property "${k}" (additionalProperties:false)`); continue; }
    if (spec.enum && !spec.enum.includes(v)) {
      problems.push(`${op.tool}.${k}: "${v}" not in ${spec.enum.join("|")}`);
    }
    if (spec.type === "string" && typeof v !== "string") problems.push(`${op.tool}.${k} must be a string`);
    if (spec.type === "integer" && !Number.isInteger(v)) problems.push(`${op.tool}.${k} must be an integer`);
    if (spec.type === "boolean" && typeof v !== "boolean") problems.push(`${op.tool}.${k} must be a boolean`);
    if (spec.type === "object" && (typeof v !== "object" || v === null)) problems.push(`${op.tool}.${k} must be an object`);
  }
  /* And the device params, against the rack's OWN catalog: unknown names
   * throw, out-of-range numbers come back clamped. Either is a defect. */
  if (op.tool === "daw_insert" && args.params) {
    const type = args.type || null;
    if (type) {
      let normed;
      try { normed = normParams(type, args.params); }
      catch (e) { problems.push(`${op.tool}: ${e.message}`); }
      if (normed) {
        for (const [k, v] of Object.entries(args.params)) {
          if (typeof v === "number" && Math.abs(normed[k] - v) > 1e-9) {
            problems.push(`${op.tool}.params.${k}: ${v} was clamped to ${normed[k]} — `
              + "the mapping proposed a value outside the catalog range");
          }
        }
      }
    }
  }
  if (op.tool === "daw_mixer" && args.fader !== undefined) {
    if (!(args.fader >= -60 && args.fader <= 12)) {
      problems.push(`daw_mixer.fader ${args.fader} is outside -60..+12`);
    }
  }
  if (op.tool === "daw_mixer" && args.pan !== undefined) {
    if (!(args.pan >= -1 && args.pan <= 1)) problems.push(`daw_mixer.pan ${args.pan} outside -1..1`);
  }
  return problems;
}

/* ─────────────────────────────────────────────── a document and a measure */

const mkDoc = (over = {}) => ({
  slug: "flawed", sr: 48000, lengthBars: 8,
  tracks: [
    { id: "trk_bass", name: "bass", instrument: { patch: "pluck" }, inserts: [], fader: 0, pan: 0, clips: [] },
    { id: "trk_pad", name: "pad", instrument: { patch: "pad" }, inserts: [], fader: 0, pan: 0, clips: [] },
    { id: "trk_lead", name: "lead", instrument: { patch: "pluck" }, inserts: [], fader: -2, pan: 0, clips: [] },
    { id: "trk_kick", name: "kick", instrument: { patch: "hybrid_kick", params: { decay: 0.06 } },
      inserts: [], fader: 0, pan: 0, clips: [] },
  ],
  returns: [], master: { inserts: [], fader: 0 },
  ...over,
});

const MEASURE = {
  master: { lufs: -8.2, true_peak_db: 0.4, peak_db: -0.1, rms_db: -11, crest_db: 4.2 },
  stereo: { width: 0.004, correlation: 0.999, mid_rms_db: -11, side_rms_db: -60 },
  clipping: { clipped_samples: 900, longest_run: 40, first_clip_sec: 1.2, dc: [] },
  spectral: { bands: [] },
  tracks: {
    trk_bass: { lufs: -10.0, band_levels_db: [-20, -14, -22, -34, -44, -50, -58, -66, -74],
                stereo: { width: 0, correlation: 1 } },
    trk_pad: { lufs: -14.0, band_levels_db: [-40, -34, -26, -18, -24, -30, -40, -50, -60],
               stereo: { width: 0.3, correlation: 0.6 } },
    trk_lead: { lufs: -19.0, band_levels_db: [-60, -50, -34, -26, -22, -20, -24, -34, -48],
                stereo: { width: 0.1, correlation: 0.9 } },
  },
};
const CTX = () => ({
  doc: mkDoc(), slug: "flawed", measure: MEASURE,
  nameOf: (id) => mkDoc().tracks.find((t) => t.id === id)?.name || id,
});

/** One finding of every class the critic can emit. */
const FINDINGS = [
  { id: "masking:trk_pad:trk_lead:250-500Hz:9:16", metric: "masking", severity: "high",
    confidence: 1, target: "trk_pad", against: "trk_lead", track_name: "pad",
    against_name: "lead", band: "250-500Hz", band_index: 3, from_bar: 9, to_bar: 16,
    observed: 11.4, target_value: 6, delta_db: -5.4,
    what: "pad masks lead in the boxiness (250-500Hz)",
    where: "pad over lead, 250-500Hz, bars 9-16", how_much: "+11.4 dB" },
  { id: "masking-low", metric: "masking", severity: "medium", confidence: 1,
    target: "trk_pad", against: "trk_bass", track_name: "pad", against_name: "bass",
    band: "60-120Hz", band_index: 1, from_bar: 1, to_bar: 8,
    observed: 9, target_value: 6, delta_db: -3,
    what: "pad masks bass in the low", where: "…", how_much: "+9 dB" },
  { id: "level:trk_lead", metric: "level", severity: "high", confidence: 0.5,
    target: "trk_lead", track_name: "lead", role: "lead", role_inferred: true,
    observed: -19, target_value: -14, delta_db: 5,
    what: "lead sits 5 dB below where a lead usually sits",
    where: "lead, whole range", how_much: "-19 vs -14 LUFS" },
  { id: "level:trk_bass", metric: "level", severity: "high", confidence: 0.8,
    target: "trk_bass", track_name: "bass", role: "bass", role_inferred: false,
    observed: -10, target_value: -17, delta_db: -7,
    what: "bass sits 7 dB above where a bass usually sits",
    where: "bass, whole range", how_much: "-10 vs -17 LUFS" },
  { id: "lufs:master", metric: "lufs", severity: "high", confidence: 1, target: "master",
    observed: -8.2, target_value: -14, delta_db: -5.8,
    what: "the master is 5.8 dB over target", where: "master", how_much: "-8.2 LUFS" },
  { id: "true_peak:master", metric: "true_peak", severity: "high", confidence: 1,
    target: "master", observed: 0.4, target_value: -1, delta_db: -1.4,
    what: "true peak over the ceiling", where: "master", how_much: "0.4 dBTP" },
  { id: "clipping:master", metric: "clipping", severity: "high", confidence: 1,
    target: "master", observed: 900, target_value: 0,
    what: "900 samples pinned at full scale", where: "master", how_much: "900" },
  { id: "balance:2000-4000Hz", metric: "balance", severity: "medium", confidence: 1,
    target: "master", band: "2000-4000Hz", band_index: 6, observed: 6.2,
    target_value: 0, delta_db: -6.2,
    what: "presence is 6.2 dB over the reference", where: "master, 2000-4000Hz",
    how_much: "+6.2 dB" },
  { id: "dynamics:master", metric: "dynamics", severity: "high", confidence: 1,
    target: "master", direction: "too_compressed", observed: 4.2, target_value: 6,
    what: "crest 4.2 dB", where: "master", how_much: "4.2 dB" },
  { id: "dynamics:peaky", metric: "dynamics", severity: "low", confidence: 1,
    target: "master", direction: "too_peaky", observed: 26, target_value: 24,
    what: "crest 26 dB", where: "master", how_much: "26 dB" },
  { id: "width:master", metric: "width", severity: "medium", confidence: 1,
    target: "master", direction: "too_narrow", observed: 0.004, target_value: 0.02,
    what: "the master is effectively mono", where: "master", how_much: "0.004" },
  { id: "width:trk_pad", metric: "width", severity: "high", confidence: 1,
    target: "trk_pad", direction: "out_of_phase", observed: -0.8, target_value: -0.2,
    what: "pad is out of phase", where: "pad", how_much: "-0.8" },
  { id: "dc:master", metric: "dc", severity: "medium", confidence: 1, target: "master",
    observed: -34, target_value: -60, what: "DC offset", where: "master ch0",
    how_much: "-34 dB" },
  /* The shipped big-room drop, as the three new critics read it. */
  { id: "loudness_target:master", metric: "loudness_target", severity: "high", confidence: 1,
    target: "master", observed: -21.3, target_value: -8, delta_db: 13.3, shortfall_db: 13.3,
    source: "genre:edm", delivery: "club", true_peak_db: -7.2, crest_db: 13.8, headroom_db: 6.2,
    what: "the master is 13.3 dB under the -8 LUFS edm club target",
    where: "master, whole range", how_much: "-21.3 LUFS vs -8 LUFS (genre:edm): +13.3 dB" },
  { id: "loudness_target:over", metric: "loudness_target", severity: "medium", confidence: 1,
    target: "master", observed: -5.2, target_value: -8, delta_db: -2.8, shortfall_db: -2.8,
    source: "project", delivery: null, true_peak_db: -0.9, crest_db: 7.1, headroom_db: -0.1,
    what: "the master is 2.8 dB over the project's -8 LUFS target",
    where: "master, whole range", how_much: "-5.2 LUFS vs -8 LUFS (project): -2.8 dB" },
  { id: "tuning:trk_kick", metric: "tuning", severity: "high", confidence: 1,
    target: "trk_kick", track_name: "kick", observed: 165.7, target_value: 0,
    f0_hz: 48.039, root: "F", root_hz: 43.654, root_pc: 5, root_inferred: false, beat_hz: 4.39,
    patch: "hybrid_kick", knob: "tune", current_knob: 0, semitones: -1.66,
    what: "kick's fundamental is 48.0 Hz, 166 cents above F (43.7 Hz)",
    where: "kick, dry bus, 32 hits", how_much: "+166 c vs +-30 c" },
];

/* The dual-mono finding rides in FINDINGS only when a declared tool can flip
 * the switch — until then it is a note with the switch's NAME and no op, and
 * the "every finding names an edit" rule below is proven for it separately,
 * the way the absent-band note is. */
const DUAL_MONO = {
  id: "width:master:dual", metric: "width", severity: "high", confidence: 1,
  target: "master", direction: "dual_mono", cause: "rack_fold", observed: 1.0, target_value: 0.99,
  stems_dual_mono: ["trk_bass", "trk_pad", "trk_lead"], stems_measured: 3, width: 0,
  switch: "master.stereo",
  what: "the master is dual mono — L/R correlation 1.000, and all 3 stems read the same",
  where: "master, whole range", how_much: "correlation 1.000 vs < 0.99",
};
if (stereoSwitchOp("flawed")) FINDINGS.push(DUAL_MONO);

console.log("\n  -- the two band tables are one table --");
ok("the JS band labels match ear.py's, edge for edge",
   bandsAgree(BAND_LABELS) && BAND_LABELS.length === 9, BAND_LABELS.join(","));
ok("band centres are the geometric mean of the edges",
   bandCenter(3) === Math.round(Math.sqrt(250 * 500)), String(bandCenter(3)));
ok("band Q makes the bell about as wide as the band",
   bandQ(3) > 1 && bandQ(3) < 3, String(bandQ(3)));
ok("every band centre is inside its own band",
   BAND_EDGES.every((e, i) => bandCenter(i) > e[0] && bandCenter(i) < e[1]));

console.log("\n  -- every finding names a CONCRETE edit, and it is a real MCP call --");

const allOps = [];
for (const f of FINDINGS) {
  const m = mapFinding(f, CTX());
  const ops = [...(m.routes || []).map((r) => r.op), ...(m.note ? [m.note] : [])];
  ok(`${f.metric}/${f.direction ?? f.id.split(":")[0]} names at least one edit`, ops.length >= 1,
     JSON.stringify(m).slice(0, 200));
  allOps.push(...ops.map((op) => [f, op]));
}
const badOps = [];
for (const [f, op] of allOps) {
  const problems = validateOp(op);
  if (problems.length) badOps.push(`${f.id} -> ${problems.join("; ")}`);
}
ok("every proposed call validates against the REAL tool schema and the rack catalog",
   badOps.length === 0, badOps.join("\n          "));
/* The Ear's vocabulary: the rack's two writers, plus daw_set_track for the
 * one finding that is an INSTRUMENT edit (a kick's tune knob), plus whatever
 * declared door the stereo switch and the master stage resolve to. */
const DOORS = new Set(["daw_insert", "daw_mixer", "daw_set_track",
                       stereoSwitchOp("flawed")?.tool, masterStageOp("flawed", -8)?.tool].filter(Boolean));
ok("every proposed call is daw_insert, daw_mixer, daw_set_track or a resolved door",
   allOps.every(([, op]) => DOORS.has(op.tool)),
   [...new Set(allOps.map(([, op]) => op.tool))].join(","));
ok("daw_set_track is only ever used to turn instrument knobs (params), never to rename or re-patch",
   allOps.filter(([, op]) => op.tool === "daw_set_track")
     .every(([, op]) => op.args.params && Object.keys(op.args).sort().join(",") === "params,slug,track"));
ok("no finding class produces zero edits",
   FINDINGS.every((f) => {
     const m = mapFinding(f, CTX());
     return (m.routes || []).length > 0 || !!m.note;
   }));

console.log("\n  -- the routes on a card genuinely differ --");

const { cards, notes } = buildCards(FINDINGS, CTX(), { maxCards: 12 });
ok("cards were produced", cards.length >= 6, String(cards.length));
const sameish = cards.filter((c) => !routesDistinct(c.routes));
ok("every card's routes are distinct OUTCOMES, not intensity variants",
   sameish.length === 0,
   sameish.map((c) => `${c.id}: ${c.routes.map(routeSignature).join(" | ")}`).join("\n          "));
ok("every card offers 2-4 routes", cards.every((c) => c.routes.length >= 2 && c.routes.length <= 4),
   cards.map((c) => `${c.id}:${c.routes.length}`).join(" "));
ok("the distinctness rule REJECTS two routes that differ only by a number",
   !routesDistinct([
     { op: { tool: "daw_mixer", args: { op: "set", slug: "s", target: "t", fader: -2 } } },
     { op: { tool: "daw_mixer", args: { op: "set", slug: "s", target: "t", fader: -3 } } },
   ]));
ok("the distinctness rule REJECTS two EQ moves at the same frequency, different gain",
   !routesDistinct([
     { op: { tool: "daw_insert", args: { op: "add", slug: "s", target: "t", type: "eq",
                                         params: { b2_hz: 340, b2_gain_db: -2, b2_q: 1.4 } } } },
     { op: { tool: "daw_insert", args: { op: "add", slug: "s", target: "t", type: "eq",
                                         params: { b2_hz: 355, b2_gain_db: -5, b2_q: 1.4 } } } },
   ]));
ok("...and ACCEPTS two EQ moves in different BANDS - different mixes, not intensities",
   routesDistinct([
     { op: { tool: "daw_insert", args: { op: "add", slug: "s", target: "t", type: "eq",
                                         params: { b2_hz: 85, b2_gain_db: -3, b2_q: 1.4 } } } },
     { op: { tool: "daw_insert", args: { op: "add", slug: "s", target: "t", type: "eq",
                                         params: { b2_hz: 3000, b2_gain_db: -3, b2_q: 1.4 } } } },
   ]));
ok("...and ACCEPTS an EQ move beside a fader move",
   routesDistinct([
     { op: { tool: "daw_insert", args: { op: "add", slug: "s", target: "t", type: "eq", params: {} } } },
     { op: { tool: "daw_mixer", args: { op: "set", slug: "s", target: "t", fader: -3 } } },
   ]));
ok("every card offers free text, always, with no extra tier",
   cards.every((c) => c.free_text?.allowed === true && c.free_text.prompt));
ok("every card offers a skip, and says a skip is not a decision",
   cards.every((c) => c.skip?.allowed === true));
ok("the masking card's three routes are thin / duck / lower — three different mixes",
   (() => {
     const c = cards.find((x) => x.metric === "masking");
     const ids = c.routes.map((r) => r.id);
     return ids.includes("thin") && ids.includes("duck") && ids.includes("lower");
   })(), JSON.stringify(cards.find((x) => x.metric === "masking")?.routes.map((r) => r.id)));
ok("the duck route is a sidechain compressor keyed off the MASKEE",
   (() => {
     const c = cards.find((x) => x.metric === "masking");
     const d = c.routes.find((r) => r.id === "duck");
     return d.op.args.type === "compressor" && d.op.args.params.sidechain === c.finding.against;
   })());

console.log("\n  -- a finding with only one honest move is a NOTE, never a one-option card --");
ok("the DC finding lands in notes, not cards",
   notes.some((n) => n.metric === "dc") && !cards.some((c) => c.metric === "dc"),
   notes.map((n) => n.metric).join(","));
ok("that note still carries its concrete edit",
   validateOp(notes.find((n) => n.metric === "dc").op).length === 0);
ok("and says WHY it is not a card",
   /confirmation dialog|only one/.test(notes.find((n) => n.metric === "dc").why_not_a_card));

console.log("\n  -- an EMPTY band gets NO edit at all, not a plausible-looking one --");

const absentFinding = {
  id: "balance:20-60Hz", metric: "balance", severity: "low", confidence: 1,
  target: "master", band: "20-60Hz", band_index: 0, direction: "absent",
  boostable: false, observed: -23.4, target_value: 0, delta_db: 23.4,
  what: "there is essentially nothing in the sub (20-60Hz)",
  where: "master, 20-60Hz", how_much: "-23.4 dB",
};
const mAbsent = mapFinding(absentFinding, CTX());
ok("an absent band produces no routes and no op",
   (mAbsent.routes || []).length === 0 && mAbsent.note === null, JSON.stringify(mAbsent));
ok("...and says why an EQ move cannot help", /empty band|not a filter/.test(mAbsent.why || ""),
   String(mAbsent.why));
const bAbsent = buildCards([absentFinding], CTX(), {});
ok("it lands in notes with a null op, never as a card",
   bAbsent.cards.length === 0 && bAbsent.notes.length === 1 && bAbsent.notes[0].op === null);
ok("the note explains that no edit would honestly help",
   /no edit would honestly help/.test(bAbsent.notes[0].why_not_a_card));

const underFinding = {
  id: "balance:60-120Hz", metric: "balance", severity: "medium", confidence: 1,
  target: "master", band: "60-120Hz", band_index: 1, direction: "under",
  boostable: true, most_over_band: 2, observed: -10.7, target_value: 0, delta_db: 10.7,
  what: "low (60-120Hz) is 10.7 dB under the reference curve",
  where: "master, 60-120Hz", how_much: "-10.7 dB",
};
const mUnder = mapFinding(underFinding, CTX());
ok("an under-reference band offers CUTTING the over band as its first route",
   mUnder.routes[0].id === "cut_over", mUnder.routes.map((r) => r.id).join(","));
ok("that route cuts band 2, not band 1 - the one that is actually over",
   mUnder.routes[0].op.args.params.b2_hz === Math.round(Math.sqrt(120 * 250)),
   JSON.stringify(mUnder.routes[0].op.args.params));
ok("no balance route ever proposes more than 6 dB of EQ",
   mUnder.routes.every((r) => Object.entries(r.op.args.params || {})
     .every(([k, v]) => !k.endsWith("gain_db") || Math.abs(v) <= 6)),
   JSON.stringify(mUnder.routes.map((r) => r.op.args.params)));
ok("...nor more than 4 dB of fader on a balance finding",
   mUnder.routes.every((r) => r.op.args.fader === undefined || Math.abs(r.op.args.fader) <= 4),
   JSON.stringify(mUnder.routes.map((r) => r.op.args.fader)));
ok("the under-reference card's routes are still distinct", routesDistinct(mUnder.routes),
   mUnder.routes.map(routeSignature).join(" | "));
ok("every one of them is still a valid MCP call",
   mUnder.routes.every((r) => validateOp(r.op).length === 0),
   mUnder.routes.flatMap((r) => validateOp(r.op)).join("; "));

console.log("\n  -- the card stack is capped, because a wall of cards is rubber-stamping --");
const capped = buildCards(FINDINGS, CTX(), {});
ok(`the default cap is ${CARD_CAP}`, capped.cards.length === CARD_CAP, String(capped.cards.length));
ok("the ones that did not fit are reported, not silently dropped", capped.over_cap > 0,
   String(capped.over_cap));

console.log("\n  -- an EQ move edits the EQ already on the chain, it does not stack --");
const withEq = mkDoc({
  tracks: mkDoc().tracks.map((t) => (t.id === "trk_pad"
    ? { ...t, inserts: [{ id: "ins_1", type: "eq",
                          params: normParams("eq", { b2_hz: 340, b2_gain_db: -2, b2_q: 1.5 }) }] }
    : t)),
});
const m2 = mapFinding(FINDINGS[0], { doc: withEq, slug: "flawed", measure: MEASURE,
                                     nameOf: (i) => i });
const thin = m2.routes.find((r) => r.id === "thin");
ok("with an EQ already present the route SETS it rather than adding a second",
   thin.op.args.op === "set" && thin.op.args.insert === "ins_1", JSON.stringify(thin.op.args));
ok("it reuses the slot already parked in that band",
   Object.keys(thin.op.args.params).every((k) => k.startsWith("b2_")),
   Object.keys(thin.op.args.params).join(","));
ok("pickEqSlot falls back to the flattest slot when nothing is nearby",
   pickEqSlot({ params: normParams("eq", { b1_hz: 100, b1_gain_db: 6, b2_gain_db: 0 }) }, 9000) === "b2");

console.log("\n  -- the A/B guard reverts a change that measurably worsens the mix --");

const score = (p, parts = {}) => ({ penalty_db: p, parts, lower_is_better: true });

ok("a worsening penalty is a revert",
   abVerdict(score(4), score(9), { metric: "masking" }).verdict === "revert");
ok("an improving penalty is a keep",
   abVerdict(score(9), score(4), { metric: "masking" }).verdict === "keep");
ok("a change under the epsilon is neutral and kept, because the human asked for it",
   (() => {
     const v = abVerdict(score(4), score(4 + AB_EPSILON / 2), { metric: "masking" });
     return v.verdict === "keep" && v.neutral === true;
   })());
ok("a targeted metric that got worse while the total improved is reported as a TRADE",
   abVerdict(score(10, { masking: 2 }), score(6, { masking: 5 }),
             { metric: "masking" }).verdict === "traded");

/* The whole guard, including the undo, through injected io. */
async function guardRun({ penalties, undo }) {
  const applied = [];
  let i = 0;
  const io = {
    applyOp: async (op) => { applied.push(op); return { insert_id: "ins_new" }; },
    undoFor: () => undo,
    measure: async () => score(penalties[Math.min(i++, penalties.length - 1)]),
  };
  const out = await applyWithGuard(
    { id: "thin", op: { tool: "daw_insert", args: { op: "add", slug: "s", target: "t", type: "eq", params: {} } } },
    { metric: "masking" }, io, {});
  return { out, applied };
}

const worse = await guardRun({
  penalties: [4, 12, 4],
  undo: { tool: "daw_insert", args: { op: "remove", slug: "s", target: "t", insert: "ins_new" } },
});
ok("a worsening edit is REVERTED", worse.out.reverted === true && worse.out.verdict === "revert",
   JSON.stringify(worse.out.verdict));
ok("the revert is an actual undo call, not a flag",
   worse.applied.length === 2 && worse.applied[1].args.op === "remove",
   JSON.stringify(worse.applied.map((o) => o.args.op)));
ok("the revert says why, with both numbers", /4.*12|12/.test(worse.out.reason), worse.out.reason);

const better = await guardRun({
  penalties: [12, 4],
  undo: { tool: "daw_insert", args: { op: "remove", slug: "s", target: "t", insert: "ins_new" } },
});
ok("an improving edit is kept and NOT undone",
   better.out.reverted === false && better.applied.length === 1);

const unrevertable = await guardRun({ penalties: [4, 12], undo: null });
ok("a worsening edit with no possible undo is reported as unrevertable, never hidden",
   unrevertable.out.verdict === "kept_unrevertable"
   && /no undo/.test(unrevertable.out.reason), JSON.stringify(unrevertable.out.verdict));

ok(`the iteration cap is stated (${ITERATION_CAP})`, ITERATION_CAP === 3);

console.log("\n  -- provenance: an AI decision can never be recorded as a human one --");

const CARD = cards[0];
/* Every call here NAMES its actor, which is the contract now: the builders
 * default to `system` and refuse it, so a test that omitted the actor would be
 * asserting the fabrication these pins exist to forbid. */
const asHuman = choiceEvent({
  asset: "daw/flawed", card: CARD, chosen: CARD.routes[0].id,
  reasoning: "the lead needs those low-mids more than the pad does",
  decideMs: 14200, loopRun: "run1", iteration: 1, actor: "user",
});
ok("a browser answer is a `choice` with actor user",
   asHuman.type === "choice" && asHuman.actor === "user");
ok("the card is stored AS PRESENTED — every option's text, verbatim",
   asHuman.data.card.options.length === CARD.routes.length
   && asHuman.data.card.options[0].text === CARD.routes[0].text);
ok("the rejected routes are recorded explicitly — rejection is evidence of control",
   asHuman.data.rejected.length === CARD.routes.length - 1
   && !asHuman.data.rejected.includes(asHuman.data.chosen));
ok("free text and reasoning ride verbatim",
   choiceEvent({ asset: "a", card: CARD, actor: "user", freeText: "keep the air, thin the mud" })
     .data.freeText === "keep the air, thin the mud");
ok("decideMs is captured as texture", asHuman.data.decideMs === 14200);

ok("a `choice` REFUSES an agent actor",
   /judge|D1\.0/.test(threw(() => choiceEvent({ asset: "a", card: CARD, actor: "agent:ear" })) || ""),
   String(threw(() => choiceEvent({ asset: "a", card: CARD, actor: "agent:ear" }))));
ok("a `choice` refuses an unknown mode",
   !!threw(() => choiceEvent({ asset: "a", card: CARD, actor: "user", mode: "sneaky" })));

/* ⚠ THE OMISSION CASE, which is the one that was open. The default used to be
 * `user`, so every guard above was only ever reached by a caller honest enough
 * to name itself; a caller that named NOBODY was handed a human stamp. D1.0
 * sends the unattributable to `system`, so the builders now default there and
 * refuse it — the stamp has to come from the door. */
ok("a `choice` REFUSES an omitted actor — a caller that names nobody is not a person",
   /system|D1\.0/.test(threw(() => choiceEvent({ asset: "a", card: CARD })) || ""),
   String(threw(() => choiceEvent({ asset: "a", card: CARD }))));
ok("...and refuses the `system` actor said out loud, for the same reason",
   !!threw(() => choiceEvent({ asset: "a", card: CARD, actor: "system" })));
ok("...and a script harness cannot deliberate either",
   !!threw(() => choiceEvent({ asset: "a", card: CARD, actor: "script:gate_run" })));

const asAgent = judgeEvent({
  asset: "daw/flawed", card: CARD, chosen: CARD.routes[0].id,
  loopRun: "run1", iteration: 1, delegatedBy: "evt_delegate_1",
});
ok("an auto decision is a `judge` with actor agent:ear",
   asAgent.type === "judge" && asAgent.actor === "agent:ear");
ok("an auto decision names the delegation it acted under",
   asAgent.data.delegatedBy === "evt_delegate_1");
ok("an auto decision carries the SAME full card record — observation, options, rejected",
   asAgent.data.card.options.length === CARD.routes.length && asAgent.data.rejected.length >= 1);
ok("a `judge` REFUSES a user actor",
   !!threw(() => judgeEvent({ asset: "a", card: CARD, delegatedBy: "x", actor: "user" })));
ok("a `judge` refuses to exist without a delegation",
   /delegate|authorised/.test(threw(() => judgeEvent({ asset: "a", card: CARD })) || ""),
   String(threw(() => judgeEvent({ asset: "a", card: CARD }))));

const del = delegateEvent({ asset: "daw/flawed", brief: "make it hit like a club record",
                            loopRun: "run1", scope: "bars 1-8", actor: "user" });
ok("delegation is a first-class human event carrying the brief VERBATIM",
   del.type === "delegate" && del.actor === "user"
   && del.data.brief === "make it hit like a club record");
ok("delegation refuses to be recorded without a brief",
   !!threw(() => delegateEvent({ asset: "a" })));
ok("an MCP-relayed delegation records the AGENT as actor and marks itself relayed",
   (() => {
     const d = delegateEvent({ asset: "a", brief: "b", actor: "agent:claude" });
     return d.actor === "agent:claude" && d.data.relayed === true;
   })());
ok("delegation refuses an illegal actor",
   !!threw(() => delegateEvent({ asset: "a", brief: "b", actor: "definitely-a-human" })));
/* A delegation is what AUTHORISES every `judge` event in an auto run. Minted by
 * omission, it manufactures the human brief the whole run then points back at. */
ok("delegation REFUSES an omitted actor — it cannot be minted by a caller with no name",
   !!threw(() => delegateEvent({ asset: "a", brief: "b" })));

const rev = choiceEvent({ asset: "a", card: CARD, chosen: CARD.routes[1].id, mode: "review",
                          reviews: "evt_judge_1", verdict: "override", actor: "user" });
ok("a review verdict is the human's `choice`, pointing at the judge event it reviews",
   rev.data.mode === "review" && rev.data.reviews === "evt_judge_1"
   && rev.data.verdict === "override" && rev.actor === "user");
const bulk = choiceEvent({ asset: "a", card: CARD, chosen: "thin", mode: "bulk", actor: "user" });
ok("a bulk accept is recorded AS BULK, never disguised as individual deliberation",
   bulk.data.mode === "bulk");

const app = approveEvent({ asset: "daw/flawed", loopRun: "run1", subjectHash: "sha1:abc",
                           sessionSeconds: 212, actor: "user" });
ok("final approval after listening is its own first-class human event",
   app.type === "approve" && app.actor === "user" && app.data.sessionSeconds === 212);
/* `approve` used to have NO actor parameter at all — it stamped `user` and its
 * honesty rested entirely on its one call site checking the door first. It is
 * the strongest human claim in the ledger: somebody sat and listened. */
ok("`approve` REFUSES an omitted actor — nothing listens on a person's behalf",
   /system|D1\.0|ears/.test(threw(() => approveEvent({ asset: "a", loopRun: "r" })) || ""),
   String(threw(() => approveEvent({ asset: "a", loopRun: "r" }))));
ok("...and refuses an agent that claims to have listened",
   !!threw(() => approveEvent({ asset: "a", loopRun: "r", actor: "agent:ear" })));

ok("every event type the Ear writes is in the ledger's vocabulary",
   ["choice", "judge", "delegate", "approve"].every((t) => EVENT_TYPES.has(t)));
ok("the ledger would coerce a forged actor to system, never to user",
   normalizeActor("user ") === "system" || normalizeActor("nonsense") === "system");

console.log("\n  -- the taste profile learns, reorders, and resets clean --");

let P = neutralProfile();
ok("a cold profile is exactly neutral", profileWeight(P, "masking", "pop") === 0.5);
ok("a cold profile says it is cold", tasteSummary(P).cold_start === true);
ok("a cold profile auto-allows everything", autoAllowed(P, "masking", "pop"));

/* Ids chosen so the COLD order (alphabetical tiebreak) is the opposite of the
 * order the feedback should produce — otherwise the assertion could pass on a
 * profile that learned nothing. */
const cardsForRank = [
  { id: "a-masking", metric: "masking", severity: "medium", confidence: 1, routes: [] },
  { id: "z-balance", metric: "balance", severity: "medium", confidence: 1, routes: [] },
];
const order0 = rankCards(cardsForRank, P, "pop").map((c) => c.id);
for (let i = 0; i < 6; i++) P = foldFeedback(P, { metric: "masking", genre: "pop", action: "reject" });
for (let i = 0; i < 6; i++) P = foldFeedback(P, { metric: "balance", genre: "pop", action: "accept" });
const order1 = rankCards(cardsForRank, P, "pop").map((c) => c.id);
ok("six rejections push a metric's weight below neutral",
   profileWeight(P, "masking", "pop") < 0.5, String(profileWeight(P, "masking", "pop")));
ok("six acceptances push another above neutral",
   profileWeight(P, "balance", "pop") > 0.5, String(profileWeight(P, "balance", "pop")));
ok("card ORDER changes after that feedback — and flips, it does not merely tie",
   order0[0] === "a-masking" && order1[0] === "z-balance",
   `${order0.join()} -> ${order1.join()}`);
ok("the ranking explains itself in words the human can check",
   /accepted \d+%/.test(rankCards(cardsForRank, P, "pop")[0].rank_reason),
   rankCards(cardsForRank, P, "pop")[0].rank_reason);
ok("the genre is part of the key — pop feedback does not move rock",
   profileWeight(P, "masking", "rock") === 0.5);
ok("the profile still SHOWS the down-weighted card — it is demoted, never hidden",
   rankCards(cardsForRank, P, "pop").length === 2);

let Q = neutralProfile();
for (let i = 0; i < 3; i++) Q = foldFeedback(Q, { metric: "lufs", genre: "edm", action: "reject" });
ok("three rejections with nothing accepted stop AUTO-apply for that class",
   autoAllowed(Q, "lufs", "edm") === false);
ok("...but the class is still measured and still ranked",
   rankCards([{ id: "l", metric: "lufs", severity: "high", confidence: 1, routes: [] }], Q, "edm")
     .length === 1);
Q = foldFeedback(Q, { metric: "lufs", genre: "edm", action: "accept" });
ok("one acceptance re-opens it", autoAllowed(Q, "lufs", "edm") === true);

let R = neutralProfile();
ok("a lone override does not move a target yet", targetShift(R, "lufs", "pop") === null);
for (let i = 0; i < 3; i++) R = foldFeedback(R, { metric: "lufs", genre: "pop", action: "override", deltaDb: 2 });
ok("three consistent overrides shift that target", targetShift(R, "lufs", "pop") === 2,
   String(targetShift(R, "lufs", "pop")));
ok("the shift reaches the targets the critic is given",
   shiftedTargets(R, "pop", { lufs: -14 }).lufs === -12,
   JSON.stringify(shiftedTargets(R, "pop", { lufs: -14 })));
ok("an override counts as a rejection of the machine's route too",
   profileWeight(R, "lufs", "pop") < 0.5);
ok("a skip is NOT an observation — declining to decide teaches nothing",
   foldFeedback(neutralProfile(), { metric: "lufs", genre: "pop", action: "skip" })
     .observations === 0);
ok("an unknown feedback action is refused",
   !!threw(() => foldFeedback(neutralProfile(), { metric: "x", genre: "y", action: "shrug" })));

const fresh = neutralProfile();
ok("a reset profile is byte-identical in substance to a cold one",
   Object.keys(fresh.metrics).length === 0 && fresh.observations === 0
   && profileWeight(fresh, "masking", "pop") === 0.5);
ok("...and its ordering is the cold ordering again",
   rankCards(cardsForRank, fresh, "pop").map((c) => c.id).join() === order0.join());
ok(`the prior is stated, not hidden (Beta(${TASTE_PRIOR},${TASTE_PRIOR}))`,
   tasteSummary(P).prior.includes(String(TASTE_PRIOR)));

console.log("\n  -- the stack is ordered by what the fix is WORTH, not alphabetically --");

{
  /* The live run's failure: five `high` cards, and the loop spent two of its
   * three iterations on the two whose ids happened to sort first. Ranking by
   * the penalty each finding actually contributes fixes it, in the same units
   * the A/B guard measures in. */
  const worthy = FINDINGS.filter((f) => ["clipping", "lufs", "balance"].includes(f.metric));
  const pen = Object.fromEntries(worthy.map((f) => [f.id, findingPenalty(f)]));
  ok("a 900-sample clip is worth more than a 6 dB curve error",
     pen["clipping:master"] > pen["balance:2000-4000Hz"], JSON.stringify(pen));
  ok("a master 13 dB off target is worth more than a 6 dB curve error",
     pen["lufs:master"] > pen["balance:2000-4000Hz"], JSON.stringify(pen));
  ok("an ABSENT band is worth nothing — there is no penalty to collect",
     findingPenalty({ metric: "balance", boostable: false, observed: -23, severity: "low" }) === 0);
  ok("a metric with no penalty term still gets a severity-shaped worth",
     findingPenalty({ metric: "width", severity: "high" }) > findingPenalty({ metric: "width", severity: "low" }));

  const stack = buildCards(FINDINGS, CTX(), { maxCards: 999 });
  const ordered = rankCards(stack.cards, neutralProfile(), "pop");
  const idx = (m) => ordered.findIndex((c) => c.metric === m);
  ok("clipping and loudness outrank a mid-band curve error on a cold profile",
     idx("clipping") < idx("balance") && idx("lufs") < idx("balance"),
     ordered.map((c) => `${c.metric}:${c.worth_db}`).join(" "));
  ok("every card explains its place with the number that produced it",
     ordered.every((c) => /worth about [-0-9.]+ dB/.test(c.rank_reason)),
     ordered[0].rank_reason);
  ok("the ranking is stable across two identical calls",
     rankCards(stack.cards, neutralProfile(), "pop").map((c) => c.id).join()
     === ordered.map((c) => c.id).join());
}

console.log("\n  -- an EQ move on a slot already in that band ADDS to it --");

{
  /* The live run's other failure: iteration 2 re-issued an identical -6 dB
   * cut on the slot iteration 1 had already set, and moved the mix by 0.00
   * dB. The measurement the second finding came from was taken AFTER the
   * first cut, so the remaining error is what the second move must correct. */
  const withCut = mkDoc({
    tracks: mkDoc().tracks.map((t) => (t.id === "trk_pad"
      ? { ...t, inserts: [{ id: "ins_1", type: "eq",
                            params: normParams("eq", { b2_hz: 354, b2_gain_db: -6, b2_q: 1.4 }) }] }
      : t)),
  });
  const again = mapFinding(FINDINGS[0], { doc: withCut, slug: "flawed", measure: MEASURE,
                                          nameOf: (i) => i });
  const thin2 = again.routes.find((r) => r.id === "thin");
  ok("a second cut in the same band adds to the first, it does not restate it",
     thin2.op.args.params.b2_gain_db < -6, JSON.stringify(thin2.op.args.params));
  ok("...and stays inside the catalog range", validateOp(thin2.op).length === 0,
     validateOp(thin2.op).join("; "));
  const farAway = mapFinding({ ...FINDINGS[0], band_index: 7, band: "4000-8000Hz" },
                             { doc: withCut, slug: "flawed", measure: MEASURE, nameOf: (i) => i });
  const thin3 = farAway.routes.find((r) => r.id === "thin");
  ok("a cut in a DIFFERENT band uses a different slot and does not inherit the old gain",
     !Object.keys(thin3.op.args.params).some((k) => k.startsWith("b2_")),
     JSON.stringify(thin3.op.args.params));
}

/* ═══════════════════════════════════════════════════════════════════════
 * THE THREE CRITICS THE FIRST 4:00 BOUNCE NEEDED
 * ═══════════════════════════════════════════════════════════════════════ */

console.log("\n  -- dual mono: a NOTE naming the rack's stereo switch, never a widen/chorus/pan card --");
{
  const m = mapFinding(DUAL_MONO, CTX());
  ok("the dual-mono (rack fold) finding is a note, not a card", "note" in m, JSON.stringify(m).slice(0, 200));
  ok("the note names the document switch and the job switch by name",
     /master\.stereo/.test(m.why || "") && /mixer\.stereo/.test(m.why || ""), m.why);
  ok("...and says the fold is (L+R)/2 before the first insert", /\(L\+R\)\/2/.test(m.why || ""), m.why);
  ok("...and says why widening would be pointless (a side signal that is exactly zero)",
     /exactly zero/.test(m.why || ""), m.why);
  ok("STEREO_SWITCH names master.stereo / mixer.stereo",
     STEREO_SWITCH.doc === "master.stereo" && STEREO_SWITCH.job === "mixer.stereo");
  const sw = stereoSwitchOp("flawed");
  ok("the switch op is either not yet declared (null, and the note says so) or a REAL call that validates",
     sw === null ? /no declared tool/.test(m.why_not_a_card || "") : validateOp(sw).length === 0,
     sw ? validateOp(sw).join("; ") : m.why_not_a_card);
  ok("the note's op IS the switch op", JSON.stringify(m.note) === JSON.stringify(sw));
  const built = buildCards([DUAL_MONO], CTX());
  ok("through buildCards it lands in notes with its why", built.cards.length === 0
     && built.notes.length === 1 && /stereo switch|master\.stereo/.test(built.notes[0].why_not_a_card + built.notes[0].why));
  /* With the switch ON the same correlation is an ARRANGEMENT note: the old
   * width routes (widen / chorus / pan) are the honest ones there. */
  const arr = mapFinding({ ...DUAL_MONO, cause: "arrangement" }, CTX());
  ok("dual mono with the switch ON keeps the arrangement routes (widen / chorus / pan)",
     (arr.routes || []).length >= 2 && arr.routes.every((r) => validateOp(r.op).length === 0),
     JSON.stringify(arr).slice(0, 200));
}

console.log("\n  -- loudness target: the shortfall to the project's / genre's number, and the way up --");
{
  const f = FINDINGS.find((x) => x.id === "loudness_target:master");
  const m = mapFinding(f, CTX());
  const ids = m.routes.map((r) => r.id);
  ok("an under-target master offers the maximizer (gain INTO a ceiling), the fader, and the loudest part",
     ids.includes("maximize") && ids.includes("master_fader") && ids.includes("loudest_part"), ids.join(","));
  const mx = m.routes.find((r) => r.id === "maximize");
  ok("the maximizer route drives the SHORTFALL in (13.3 dB) at a -1 dBTP ceiling",
     mx.op.args.type === "maximizer" && Math.abs(mx.op.args.params.gain_db - 13.3) < 0.01
     && mx.op.args.params.ceiling_db === -1, JSON.stringify(mx.op.args));
  ok("...never more than the maximizer's 24 dB of gain",
     mapFinding({ ...f, delta_db: 30 }, CTX()).routes.find((r) => r.id === "maximize").op.args.params.gain_db === 24);
  ok("the routes are distinct outcomes and every one validates",
     routesDistinct(m.routes) && m.routes.every((r) => validateOp(r.op).length === 0),
     m.routes.map((r) => validateOp(r.op).join(";")).join(" | "));
  const stage = masterStageOp("flawed", -8);
  ok("the master-stage route is offered exactly when a declared tool takes target_lufs",
     ids.includes("master_stage") === !!stage, `stage=${JSON.stringify(stage)} ids=${ids}`);
  if (stage) ok("...and that call validates against its tool's schema", validateOp(stage).length === 0, validateOp(stage).join(";"));
  ok("the master-stage resolver never names daw_critique or daw_check_delivery",
     !stage || !/critique|check_delivery/.test(stage.tool));
  const over = mapFinding(FINDINGS.find((x) => x.id === "loudness_target:over"), CTX());
  ok("an OVER-target master pulls the master down and takes energy from the loudest band",
     over.routes.map((r) => r.id).includes("master_down") && over.routes.length >= 2
     && over.routes.every((r) => validateOp(r.op).length === 0), over.routes.map((r) => r.id).join(","));
  const withMax = mkDoc({ master: { inserts: [{ id: "ins_mx", type: "maximizer", enabled: true,
                                                params: normParams("maximizer", { gain_db: 10, ceiling_db: -1 }) }], fader: 0 } });
  const overMx = mapFinding(FINDINGS.find((x) => x.id === "loudness_target:over"), { ...CTX(), doc: withMax });
  ok("...and relaxes a maximizer already on the master instead of stacking a cut",
     overMx.routes.some((r) => r.id === "relax_device" && r.op.args.insert === "ins_mx"
                                && Math.abs(r.op.args.params.gain_db - 7.2) < 0.01),
     JSON.stringify(overMx.routes.map((r) => r.op.args)));
  ok("the penalty weighs the finding against the target the CARD quotes, not the streaming default",
     Math.abs(findingPenalty(f) - 12.3) < 0.01, String(findingPenalty(f)));
  ok("...so the same LUFS against -14 would weigh less", findingPenalty({ ...f, target_value: -14 }) < findingPenalty(f));
}

console.log("\n  -- tuning: the kick's knob, in cents, or the nearest whole step --");
{
  const f = FINDINGS.find((x) => x.id === "tuning:trk_kick");
  const m = mapFinding(f, CTX());
  const tune = m.routes.find((r) => r.id === "tune");
  ok("the tuning card's first route turns hybrid_kick.tune by -1.66 st on the KICK track",
     tune && tune.op.tool === "daw_set_track" && tune.op.args.track === "trk_kick"
     && Math.abs(tune.op.args.params.tune + 1.66) < 0.001, JSON.stringify(tune?.op));
  ok("...its text names the knob, the Hz and the root", /hybrid_kick\.tune/.test(tune.text) && /48\.0 Hz/.test(tune.text) && /43\.7 Hz/.test(tune.text), tune.text);
  const tr = m.routes.find((r) => r.id === "transpose");
  ok("the second route is the nearest WHOLE step (transpose -2), a different outcome (34 c of colour left)",
     tr && tr.op.args.params.transpose === -2 && /34 c/.test(tr.text), JSON.stringify(tr));
  ok("the two routes are distinct and both validate",
     routesDistinct(m.routes) && m.routes.every((r) => validateOp(r.op).length === 0),
     m.routes.map((r) => validateOp(r.op).join(";")).join(" | "));
  ok("through buildCards it is a CARD (two honest routes), not a note",
     buildCards([f], CTX()).cards.length === 1);
  const already = mapFinding({ ...f, current_knob: -1.0 }, CTX());
  ok("a knob already at -1 st gets -2.66, additive on what it holds",
     Math.abs(already.routes.find((r) => r.id === "tune").op.args.params.tune + 2.66) < 0.001);
  const tiny = mapFinding({ ...f, observed: 40, semitones: -0.4 }, CTX());
  ok("a 40 c error has no whole-step route (rounds to 0), only the knob",
     tiny.routes.length === 1 && tiny.routes[0].id === "tune");
  ok("the penalty scales with the cents over the 30 c tolerance",
     findingPenalty(f) > 5 && findingPenalty({ ...f, observed: 35 }) < 0.3, String(findingPenalty(f)));
}

console.log("\n  -- masking: when the maskee has a voice knob, the MUSICAL move comes first --");
{
  /* The first live run: kick masks riser at 120-250 Hz; the top card asked
   * for -9 dB on the kick at 173 Hz, and following it cost 1.7 LUFS and 0.8
   * dB of kick transient. A producer raises the riser's cutoff_start. */
  const docR = mkDoc({ tracks: [
    ...mkDoc().tracks,
    { id: "trk_riser", name: "riser", instrument: { patch: "riser", params: {} }, inserts: [], fader: -10, pan: 0, clips: [] },
  ] });
  const fR = { ...FINDINGS[0], id: "masking:kick:riser", target: "trk_kick", against: "trk_riser",
               band: "120-250Hz", band_index: 2, observed: 12.4, target_value: 6, delta_db: -6.4 };
  const m = mapFinding(fR, { ...CTX(), doc: docR });
  ok("the riser gets a `voice` route FIRST: raise riser.cutoff_start out of the band",
     m.routes[0]?.id === "voice" && m.routes[0].op.tool === "daw_set_track"
     && m.routes[0].op.args.track === "trk_riser" && m.routes[0].op.args.params.cutoff_start === 400,
     JSON.stringify(m.routes[0]));
  ok("...from the patch default (200 Hz) to 400 Hz, past the band's 250 Hz top edge", /200 to 400 Hz/.test(m.routes[0].text), m.routes[0].text);
  ok("...and says why it beats the EQ on the masker (weight, transient)", /transient/.test(m.routes[0].why), m.routes[0].why);
  ok("the masker-side routes are still there (thin / duck / lower) behind it",
     ["thin", "duck", "lower"].every((id) => m.routes.some((r) => r.id === id)), m.routes.map((r) => r.id).join(","));
  ok("still at most four routes, all distinct, all valid",
     m.routes.length <= 4 && routesDistinct(m.routes) && m.routes.every((r) => validateOp(r.op).length === 0),
     m.routes.map((r) => validateOp(r.op).join(";")).join(" | "));
  const high = mapFinding({ ...fR, band: "4000-8000Hz", band_index: 7 }, { ...CTX(), doc: docR });
  ok("a riser masked ABOVE its filter start keeps the masker routes only (no voice move helps there)",
     !high.routes.some((r) => r.id === "voice"));
  const already = { ...docR, tracks: docR.tracks.map((t) => t.id === "trk_riser"
    ? { ...t, instrument: { patch: "riser", params: { cutoff_start: 1000 } } } : t) };
  ok("a riser that already starts above the band gets no voice route",
     !mapFinding(fR, { ...CTX(), doc: already }).routes.some((r) => r.id === "voice"));
  ok("a pluck maskee (no voice knob) is unchanged: thin / duck / lower",
     mapFinding(FINDINGS[0], CTX()).routes.map((r) => r.id).slice(0, 3).join(",") === "thin,duck,lower");
}

console.log("\n  -- the analysis job carries every note's instrument params, as the render does --");
{
  /* The bug this pins: the Ear's job (and the meters/analyze/check_delivery
   * job) left `params` out, so a kick rendered with default knobs while the
   * bounce held the bigroom preset — 2.9 dB RMS apart. */
  const docP = blankProject("params pin", { bpm: 128, lengthBars: 4 });
  const kick = blankTrack("kick", { patch: "hybrid_kick", params: { tune: -1.65, decay: 0.06, punch: 1 } });
  const kc = blankClip(1, 4);
  kc.notes.push({ id: "n1", bar: 1, beat: 1, tick: 0, durTicks: 480, pitch: 36, vel: 112 },
                { id: "n2", bar: 2, beat: 1, tick: 0, durTicks: 480, pitch: 36, vel: 100 });
  kick.clips.push(kc);
  const sub = blankTrack("sub", { patch: "sub_bass", params: { sub_mix: 0.2 } });
  const sc = blankClip(1, 4);
  sc.notes.push({ id: "n3", bar: 1, beat: 1, tick: 480, durTicks: 480, pitch: 29, vel: 100 });
  sub.clips.push(sc);
  docP.tracks.push(kick, sub);
  const ev = noteEvents(docP);
  const sameAsEvent = (n) => JSON.stringify(n.params) === JSON.stringify(
    ev.find((e) => e.startSample === n.start_sample && e.midi === n.midi && e.trackId === n.track_id)?.params);
  ok("the fixture stores the kick's knobs (normParams kept tune/decay/punch)",
     kick.instrument.params.tune === -1.65 && kick.instrument.params.decay === 0.06 && kick.instrument.params.punch === 1,
     JSON.stringify(kick.instrument.params));
  const { job, earOpts } = buildAnalysisJob(docP, 1, 4, { genre: "edm" });
  ok("the Ear's job carries one note per sounding event", job.notes.length === ev.length && ev.length === 3,
     `${job.notes.length} vs ${ev.length}`);
  ok("EVERY note carries `params` equal to what noteEvents (and so ensureRegions, and so the bounce) sends",
     job.notes.every((n) => n.params && sameAsEvent(n)), JSON.stringify(job.notes.map((n) => n.params)));
  ok("the kick's notes carry the preset knobs, the sub's its sub_mix",
     job.notes.filter((n) => n.inst === "hybrid_kick").every((n) => n.params.tune === -1.65 && n.params.punch === 1)
     && job.notes.find((n) => n.inst === "sub_bass")?.params?.sub_mix === 0.2);
  ok("the job carries the mixer payload and the bar map", job.mixer && job.ear.bars.length === 4);
  /* metersJob — the job meters / analyze / check_delivery build — through the
   * mixer dispatcher with the engine stubbed: no disk, no python. */
  let captured = null;
  const ctx = {
    readProject: async () => docP, safe: (s) => s, noteEvents, buildTimeline,
    mutate: async () => { throw new Error("meters must not mutate"); },
    runEngineFast: async (mode, j) => { captured = { mode, job: j }; return { engine: "stub", master: {}, tracks: {}, returns: {}, ms: 0 }; },
  };
  const r = await handleMixerAction("meters", { slug: "params-pin" }, ctx);
  ok("the meters job is built by the same rule (one note per event)",
     r?.ok === true && captured?.mode === "meters" && captured.job.notes.length === ev.length,
     JSON.stringify(captured?.job?.notes?.length));
  ok("...and every one of ITS notes carries params too", captured.job.notes.every((n) => n.params && sameAsEvent(n)),
     JSON.stringify(captured.job.notes.map((n) => n.params)));
  ok("the Ear's notes and the meters' notes are identical, field for field",
     JSON.stringify(captured.job.notes) === JSON.stringify(job.notes));
  ok("the Ear's job carries the song root inferred from the bass line (F, and says inferred)",
     job.ear.root === 5 && job.ear.root_inferred === true && job.ear.root_source === "bass line",
     JSON.stringify([job.ear.root, job.ear.root_source, job.ear.root_inferred]));
  const told = buildAnalysisJob(docP, 1, 4, { genre: "edm", root: "Db", targetLufs: -9, delivery: "streaming" }).job.ear;
  ok("a told key, a project target and a delivery ride on the job as given",
     told.root === 1 && told.root_inferred === false && told.target_lufs === -9 && told.delivery === "streaming",
     JSON.stringify([told.root, told.root_inferred, told.target_lufs, told.delivery]));
  ok("earOpts records what the run measured with, so the A/B guard measures the same way",
     earOpts.root === null && earOpts.targetLufs === null && earOpts.delivery === null);
  const named = buildAnalysisJob({ ...docP, name: "Big room Eb minor #3" }, 1, 4, {}).job.ear;
  ok("a project named 'Big room Eb minor #3' yields Eb from its name, marked inferred",
     named.root === 3 && named.root_source === "project name" && named.root_inferred === true);
  const onDoc = buildAnalysisJob({ ...docP, key: "G" }, 1, 4, {}).job.ear;
  ok("a key the document carries beats the name and the bass line", onDoc.root === 7 && onDoc.root_inferred === false);
}

console.log("\n  -- ...and the FILE-BACKED CLIPS, or it refuses to build the job at all --");
{
  /* THE HOLE THIS CLOSES. rack.chain_graph mixes each clip into its own
   * track's dry buffer (rack._mix_audio, above `keys`), so a job carrying no
   * `audio` is measured — master AND per-track stems alike — with every
   * recorded take removed from it. The Ear then reported
   * `audio_clips_excluded: 0` about exactly that mix: vacuously true, because
   * the job it counted carried none. A project whose vocal is a comp was
   * critiqued as an instrumental, and nothing in the reply said so. */
  const docA = blankProject("clip pin", { bpm: 120, lengthBars: 4 });
  const vox = blankTrack("vox", { patch: "pluck" });
  vox.audioClips.push(blankAudioClip("take_1.wav", {
    bar: 2, beat: 1, tick: 0, durSamples: docA.sr, gainDb: -3,
  }));
  docA.tracks.push(vox);
  const rowsA = buildTimeline(docA);
  const [aT0, aT1] = [rowsA[0].sec, rowsA[3].sec + rowsA[3].secLen];

  const withSlug = buildAnalysisJob(docA, 1, 4, { slug: "clip-pin" }).job;
  ok("a document with one file-backed clip yields a job whose `audio` carries it",
     Array.isArray(withSlug.audio) && withSlug.audio.length === 1, JSON.stringify(withSlug.audio));
  ok("...on the clip's OWN track_id — the bus rack.chain_graph mixes it into, so the "
    + "stem the Ear measures is the track's real sound",
  withSlug.audio[0]?.track_id === vox.id, JSON.stringify(withSlug.audio[0]));
  ok("...with the file's path built under THAT project's audio directory",
     withSlug.audio[0]?.path?.includes("clip-pin") && withSlug.audio[0]?.path?.endsWith("take_1.wav"),
     String(withSlug.audio[0]?.path));
  ok("...field for field the clip store.js hands every other lane (one mapping, not four)",
     JSON.stringify(withSlug.audio) === JSON.stringify(audioJobClips(docA, "clip-pin", aT0, aT1)));

  const noClips = buildAnalysisJob(
    blankProject("silent", { bpm: 120, lengthBars: 4 }), 1, 4, { slug: "silent" }).job;
  ok("a document with no clips yields `audio: []` — the key always rides, so it cannot "
    + "go missing again without a test noticing",
  Array.isArray(noClips.audio) && noClips.audio.length === 0, JSON.stringify(noClips.audio));

  /* THE REACH TEST IS THE NOTES', character for character: a window the clip
   * cannot reach carries none of it, and on a default mixer that is the
   * clip's own span. */
  const early = buildAnalysisJob(docA, 1, 1, { slug: "clip-pin" }).job;
  ok("a window the clip does not reach carries none of it (the same reach test the notes use)",
     early.audio.length === 0, JSON.stringify(early.audio));

  /* AND THE LOUD HALF. A missing slug cannot mean `[]`: that is the defect
   * one layer up — silent exclusion, then reported as nothing excluded. */
  const msg = threw(() => buildAnalysisJob(docA, 1, 4, {}));
  ok("WITHOUT a slug, a document whose clip reaches the window REFUSES, and says how many",
     !!msg && /slug/.test(msg) && /1 audio clip\b/.test(msg), String(msg));
  ok("...but a window with no clip in reach still needs no slug (nothing to exclude)",
     threw(() => buildAnalysisJob(docA, 1, 1, {})) === null);
  ok("...and neither does a clip-less document, so every old caller still builds",
     threw(() => buildAnalysisJob(blankProject("q", { bpm: 120, lengthBars: 4 }), 1, 4, {})) === null);
}

console.log("\n  -- the song's root: told, read, or inferred with two cues --");
{
  ok("parseRoot reads names, numbers and pitch classes",
     [parseRoot("F"), parseRoot("f minor"), parseRoot("Db"), parseRoot("C#"), parseRoot(41), parseRoot(5),
      parseRoot(""), parseRoot(null), parseRoot("x"), parseRoot(true)].join() === "5,5,1,1,5,5,,,,");
  /* An F-minor sub over i-VI-III-VII: every root a quarter of the bars, so
   * duration alone is a coin toss; the line's floor (F1) breaks it. */
  const d = blankProject("root", { bpm: 128, lengthBars: 16 });
  const s = blankTrack("sub", { patch: "sub_bass" });
  const c = blankClip(1, 16);
  [0, 8, 3, 10, 0, 8, 3, 10, 0, 8, 3, 10, 0, 8, 3, 10].forEach((off, bar) => {
    for (let k = 0; k < 4; k++) c.notes.push({ id: `r${bar}_${k}`, bar: bar + 1, beat: k + 1, tick: 480, durTicks: 480, pitch: 29 + off, vel: 100 });
  });
  s.clips.push(c); d.tracks.push(s);
  ok("the root of an F-minor bass line over i-VI-III-VII is inferred as F",
     inferRootFromDoc(d, { [s.id]: { role: "bass" } }) === 5, String(inferRootFromDoc(d, { [s.id]: { role: "bass" } })));
  ok("without a bass role the lowest-register pitched track is read the same way",
     inferRootFromDoc(d, {}) === 5);
  const kit = blankTrack("kit", { patch: "tr909" }); const kc2 = blankClip(1, 16);
  kc2.notes.push({ id: "k1", bar: 1, beat: 1, tick: 0, durTicks: 240, pitch: 36, vel: 100 }); kit.clips.push(kc2);
  ok("a kit is never read as pitch", inferRootFromDoc({ ...d, tracks: [kit] }, {}) === null);
  ok("songRoot: told beats everything", songRoot(d, { root: "A" }, {}).pc === 9);
  ok("songRoot: nothing to read yields null, never a guess",
     songRoot({ ...d, tracks: [] }, {}, {}) === null);
}

console.log("\n  -- the rack catalog is the only device vocabulary the Ear speaks --");
const usedTypes = [...new Set(allOps.map(([, op]) => op.args.type).filter(Boolean))];
ok("every device the mapping reaches for exists in the rack",
   usedTypes.every((t) => MIXER_CATALOG[t]), usedTypes.join(","));
ok("the mapping uses more than one device class",
   usedTypes.length >= 4, usedTypes.join(","));

/* ═══ §7 THE REFERENCE MATCH, where it touches THIS file's invariants ═════
 *
 * server/daw/refprofile_test.js is the reference critic's own suite. What
 * belongs HERE are the two rules that are the EAR's and not the reference's,
 * because a new critic is exactly how they get quietly broken:
 *   · a critique with no profile emits no ref_* finding at all — the six new
 *     metrics must be unreachable except by asking for them;
 *   · a reference finding with one honest route is a NOTE, not a one-option
 *     card. That rule has no exceptions, and a new metric does not get one.
 */
console.log("\n  -- §7: a reference critic obeys this file's two rules --");
{
  ok("the nine band words exist on this side and are checkable against python's",
     BAND_NAMES.length === BAND_LABELS.length && bandNamesAgree(BAND_NAMES)
     && !bandNamesAgree(["a", "b"]));

  /* A PROFILE-LESS CRITIQUE. referenceFindings is the ONLY producer of ref_*
   * findings, and nothing calls it without a profile — so what matters here
   * is that the objective critic never emits one on its own, and that a ref_*
   * finding arriving with no mapping would be a note rather than a bad card. */
  const refMetrics = FINDINGS.filter((f) => String(f.metric).startsWith("ref_"));
  ok("the objective critic emits no ref_* finding of its own",
     refMetrics.length === 0, refMetrics.map((f) => f.metric).join(", "));
  ok("...and the reference critic itself, asked with no profile, finds nothing",
     referenceFindings(null, {}, CTX()).findings.length === 0
     && referenceFindings(undefined, { spectral: { bands: [] } }, CTX()).findings.length === 0);
  ok("...and an unmapped ref_* metric yields zero routes, so it could only ever "
     + "be a note",
  (mapFinding({ metric: "ref_not_a_thing", severity: "low" }, CTX()).routes || []).length === 0);

  /* ONE ROUTE => A NOTE, built through the real mapping: ref_pump on a track
   * with no sidechain compressor to turn has exactly one honest move. */
  const ctx = CTX();
  const bass = ctx.doc.tracks[0];
  const pumpFinding = {
    id: "ref_pump:x", metric: "ref_pump", severity: "medium", confidence: 1,
    what: "the sidechain ducks less here than in the reference",
    where: bass.name + ", the bass under the kick",
    how_much: "+6.0 dB of depth", target: bass.id, against: null,
    observed: -6, target_value: -12, depth_delta_db: 6,
    ref_recovery_ms: 120, recovery_frac: 0.1, ref_recovery_frac: 0.26,
    profile_name: "The Reference",
  };
  const built = buildCards([pumpFinding], ctx);
  ok("ref_pump with nothing to adjust is a NOTE, not a one-option card",
     built.cards.length === 0 && built.notes.length === 1,
     built.cards.length + " cards, " + built.notes.length + " notes");
  ok("...the note still carries the call that WOULD do it",
     built.notes[0].op?.tool === "daw_insert" && built.notes[0].op.args.type === "compressor",
     JSON.stringify(built.notes[0].op).slice(0, 140));
  ok("...and it says why it is not a choice",
     /confirmation dialog/.test(built.notes[0].why_not_a_card), built.notes[0].why_not_a_card);
  ok("...and the device it names is one the rack really has",
     MIXER_CATALOG[built.notes[0].op.args.type] !== undefined);

  /* And a several-route one IS a card, so the note above is a decision rather
   * than a mapping that simply does not work. */
  const bandFinding = {
    id: "ref_bands:master", metric: "ref_bands", severity: "medium", confidence: 1,
    what: "120-250Hz holds 4.0 dB more of this mix than of the reference",
    where: "master, 120-250Hz", how_much: "+4.0 dB", target: "master",
    band: "120-250Hz", band_index: 2, delta_db: 4, observed: -5.5, target_value: -9.5,
    profile_name: "The Reference",
  };
  const b2 = buildCards([bandFinding], ctx);
  ok("...while ref_bands, which has several, IS a card", b2.cards.length === 1,
     b2.cards.length + " cards, " + b2.notes.length + " notes");
  ok("...with distinct routes", routesDistinct(b2.cards[0].routes));

  /* A reference is a taste. It must never out-rank a measurement of the same
   * size, or the stack stops being read. */
  ok("a 6 dB reference note weighs less than a 6 dB pink one",
     findingPenalty({ metric: "ref_bands", delta_db: 6, severity: "medium" })
     < findingPenalty({ metric: "balance", observed: 6, severity: "medium" }));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
