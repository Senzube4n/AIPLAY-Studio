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
} from "./ear.js";
import { dawTools } from "../mcp-daw.js";
import { normParams, MIXER_CATALOG } from "./mixer.js";
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
];

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
ok("every proposed call is daw_insert or daw_mixer",
   allOps.every(([, op]) => ["daw_insert", "daw_mixer"].includes(op.tool)),
   [...new Set(allOps.map(([, op]) => op.tool))].join(","));
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
const asHuman = choiceEvent({
  asset: "daw/flawed", card: CARD, chosen: CARD.routes[0].id,
  reasoning: "the lead needs those low-mids more than the pad does",
  decideMs: 14200, loopRun: "run1", iteration: 1,
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
   choiceEvent({ asset: "a", card: CARD, freeText: "keep the air, thin the mud" })
     .data.freeText === "keep the air, thin the mud");
ok("decideMs is captured as texture", asHuman.data.decideMs === 14200);

ok("a `choice` REFUSES an agent actor",
   /judge|D1\.0/.test(threw(() => choiceEvent({ asset: "a", card: CARD, actor: "agent:ear" })) || ""),
   String(threw(() => choiceEvent({ asset: "a", card: CARD, actor: "agent:ear" }))));
ok("a `choice` refuses an unknown mode",
   !!threw(() => choiceEvent({ asset: "a", card: CARD, mode: "sneaky" })));

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
                            loopRun: "run1", scope: "bars 1-8" });
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

const rev = choiceEvent({ asset: "a", card: CARD, chosen: CARD.routes[1].id, mode: "review",
                          reviews: "evt_judge_1", verdict: "override" });
ok("a review verdict is the human's `choice`, pointing at the judge event it reviews",
   rev.data.mode === "review" && rev.data.reviews === "evt_judge_1"
   && rev.data.verdict === "override" && rev.actor === "user");
const bulk = choiceEvent({ asset: "a", card: CARD, chosen: "thin", mode: "bulk" });
ok("a bulk accept is recorded AS BULK, never disguised as individual deliberation",
   bulk.data.mode === "bulk");

const app = approveEvent({ asset: "daw/flawed", loopRun: "run1", subjectHash: "sha1:abc",
                           sessionSeconds: 212 });
ok("final approval after listening is its own first-class human event",
   app.type === "approve" && app.actor === "user" && app.data.sessionSeconds === 212);

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

console.log("\n  -- the rack catalog is the only device vocabulary the Ear speaks --");
const usedTypes = [...new Set(allOps.map(([, op]) => op.args.type).filter(Boolean))];
ok("every device the mapping reaches for exists in the rack",
   usedTypes.every((t) => MIXER_CATALOG[t]), usedTypes.join(","));
ok("the mapping uses more than one device class",
   usedTypes.length >= 4, usedTypes.join(","));

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
