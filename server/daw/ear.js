/**
 * THE EAR — the loop that closes. §11 of the DAW report, D1.8 of the
 * provenance SPEC, v0.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Three lines in server/index.js, nothing else:                          │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { createEarRoutes } from "./daw/ear.js";                    │
 * │                                                                        │
 * │  2. beside the other runners:                                          │
 * │     const earRoutes = createEarRoutes({ json, readBody, config,        │
 * │                                         provenance: prov });           │
 * │                                                                        │
 * │  3. inside the request handler's `try`, BEFORE the /api/daw mount:     │
 * │     if (p === "/api/daw/ear" || p.startsWith("/api/daw/ear/")) {       │
 * │       if (await earRoutes(req, res, url)) return; }                    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ── WHAT THE LOOP IS ─────────────────────────────────────────────────────
 *   render → measure → critique → CARDS → the human decides → edit →
 *   re-render → re-measure → A/B guard → (≤3 iterations) → review → approve
 *
 * The two halves of the ear:
 *   OBJECTIVE  server/daw/ear.py — measurements of the actual samples. No
 *              model, cannot be fooled, always available.
 *   SUBJECTIVE the aesthetic judges (§11a). Under a VRAM guard, and ABSENT
 *              is reported as absent — never as a number.
 *
 * ── THE THREE INVARIANTS THIS FILE IS BUILT AROUND ───────────────────────
 *
 * 1. A FINDING WITH NO CONCRETE EDIT DOES NOT SHIP. Every card's routes carry
 *    an `op` that is a REAL MCP CALL — and not a description of one: the
 *    applier literally invokes `daw_insert` / `daw_mixer` from
 *    server/daw/mcp-rack.js with those args. There is no translation layer
 *    that could drift from the tool the card promises.
 *
 * 2. THE LEDGER NEVER RECORDS AN AI DECISION AS A HUMAN ONE (SPEC D1.0).
 *    A human answering a card writes `choice` (actor: user). The Ear
 *    answering its own card writes `judge` (actor: agent:ear, delegatedBy
 *    the human's `delegate` event). There is no flag, no config and no code
 *    path that converts one into the other — `answerCard` refuses an
 *    agent-actor `choice` outright, and the test asserts the refusal.
 *
 * 3. A CHANGE THAT MEASURABLY WORSENS THE MIX IS REVERTED. Every applied
 *    route carries its own undo, built from the document as it was BEFORE
 *    the edit. After the re-render the objective penalty is compared; a
 *    regression past the epsilon is undone and reported as reverted, not
 *    swallowed.
 *
 * ── WHAT THIS FILE DOES NOT TOUCH ────────────────────────────────────────
 * engine.py, rack.py, instruments.py, capture.py, mixer.js, store.js and
 * routes.js are CONSUMED (their exported pure helpers, their HTTP actions,
 * their MCP tools) and never modified. The Ear owns ear.py, this file, the
 * ear MCP tools and one self-contained web panel.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  readProject, projectDir, buildTimeline, noteEvents, audioEvents, audioJobClips, PATCHES,
} from "./store.js";
import { mixerJobPayload } from "./mixer.js";
import { rackTools } from "./mcp-rack.js";
/* The whole daw_* family, read for its SCHEMAS: two of the Ear's routes lead
 * to doors outside the rack (the project's stereo switch, the master stage),
 * and a route is only promised when the tool that opens the door is really
 * declared — see stereoSwitchOp / masterStageOp. mcp-daw.js imports mcp-ear.js,
 * never this file, so there is no cycle. */
import { dawTools } from "../mcp-daw.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EAR_PY = path.join(__dirname, "ear.py");

/* ════════════════════════════════════════════════════════════════════════
 * DOORS OUTSIDE THE RACK — resolved against the live tool schemas.
 *
 * The Ear's routes are MCP calls, and ear_test validates every one against
 * the tool's real inputSchema. Two findings point at doors the rack's three
 * tools do not open: the DUAL-MONO finding needs the project's stereo switch
 * (`master.stereo` on the document, `mixer.stereo` in the render job — the
 * rack folds every voice to (L+R)/2 until it is on), and the LOUDNESS-TARGET
 * finding wants the master stage (gain into a true-peak ceiling, aimed at a
 * LUFS number). Both are resolved HERE, by looking for a declared tool that
 * takes the parameter, so the route names the exact call when the door
 * exists and is honest — a note with the switch's name and no op — when it
 * does not yet. Nothing here guesses a tool name into a card.
 * ══════════════════════════════════════════════════════════════════════ */

let _toolSchemas = null;
export function toolSchemas() {
  if (!_toolSchemas) {
    _toolSchemas = Object.fromEntries(
      dawTools(async () => ({}), (s) => s).map((t) => [t.name, t.inputSchema || {}]));
  }
  return _toolSchemas;
}

/** Where the rack's stereo switch lives, by name — quoted on the finding and
 *  in the note even when no tool can flip it yet. */
export const STEREO_SWITCH = { doc: "master.stereo", job: "mixer.stereo" };

/** The MCP call that turns the project's stereo switch on, or null when no
 *  declared tool carries a `stereo` parameter yet. daw_mixer op=set on the
 *  master is the natural door (the switch is a master-strip setting). */
export function stereoSwitchOp(slug) {
  const S = toolSchemas();
  if (S.daw_mixer?.properties?.stereo) {
    return { tool: "daw_mixer", args: { op: "set", slug, target: "master", stereo: true } };
  }
  for (const [name, schema] of Object.entries(S)) {
    const p = schema?.properties || {};
    if (p.stereo && p.slug && /project|master|render|mixer/.test(name)) {
      const args = { slug, stereo: true };
      if ((schema.required || []).every((r) => args[r] !== undefined)) return { tool: name, args };
    }
  }
  return null;
}

/** The MCP call that runs the master (loudness) stage at a LUFS target, or
 *  null when no declared tool takes `target_lufs`. Required fields the Ear
 *  cannot fill mean no route — a call the tool would refuse is worse than
 *  none. */
export function masterStageOp(slug, targetLufs, ceilingDb = -1) {
  const S = toolSchemas();
  const cands = Object.entries(S).filter(([name, s]) => {
    const p = s?.properties || {};
    return /^daw_/.test(name) && p.target_lufs && p.slug
      && !/critique|check_delivery|delivery_targets|analyze|reference/.test(name);
  });
  cands.sort(([a], [b]) => Number(/stage|master|loud/.test(b)) - Number(/stage|master|loud/.test(a)));
  if (!cands.length) return null;
  const [name, s] = cands[0];
  const args = { slug, target_lufs: r2(targetLufs) };
  if (s.properties.ceiling_db) args.ceiling_db = ceilingDb;
  for (const req of s.required || []) if (args[req] === undefined) return null;
  return { tool: name, args };
}

/* ════════════════════════════════════════════════════════════════════════
 * THE BANDS — the mirror of ear.py's BANDS. Two tables, one truth: probe
 * reports the python side's labels and `bandsAgree()` says whether they
 * still match, exactly the way routes.js compares TAILS. A mapping that
 * cut 250-500 Hz because python meant 2-4 kHz would be a silent disaster.
 * ══════════════════════════════════════════════════════════════════════ */
export const BAND_EDGES = [
  [20, 60], [60, 120], [120, 250], [250, 500], [500, 1000],
  [1000, 2000], [2000, 4000], [4000, 8000], [8000, 20000],
];
export const BAND_LABELS = BAND_EDGES.map(([lo, hi]) => `${lo}-${hi}Hz`);

export const bandCenter = (i) => Math.round(Math.sqrt(BAND_EDGES[i][0] * BAND_EDGES[i][1]));
/** Q that makes the bell roughly as wide as the band. */
export const bandQ = (i) => {
  const [lo, hi] = BAND_EDGES[i];
  return Math.round((Math.sqrt(lo * hi) / (hi - lo)) * 100) / 100;
};
export const bandsAgree = (pyLabels) =>
  Array.isArray(pyLabels) && pyLabels.join(",") === BAND_LABELS.join(",");

/* What a person calls each band, so a card reads like a mix note rather than
 * a frequency range. THE SAME NINE WORDS ear.py's BAND_NAMES carries — this
 * side needs them because §7's reference cards are written here, and
 * `bandNamesAgree` is how the two copies are held together: the Ear's status
 * route asks python for its list and compares, exactly as it already does for
 * the labels. A second copy that nothing checks is a second vocabulary. */
export const BAND_NAMES = ["sub", "low", "low-mid", "boxiness", "mid",
                           "upper-mid", "presence", "brilliance", "air"];
export const bandNamesAgree = (pyNames) =>
  Array.isArray(pyNames) && pyNames.join(",") === BAND_NAMES.join(",");

const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const DEVICE_LIMITS = {
  eqGainDb: [-18, 18], eqHz: [20, 20000], eqQ: [0.1, 12],
  faderDb: [-60, 12], hpHz: [10, 1000],
};

/* ════════════════════════════════════════════════════════════════════════
 * THE CRITIQUE → EDIT MAPPING — the core.
 *
 * finding class → the MCP call(s) that would fix it. Every route is a
 * genuinely different OUTCOME, per SPEC D1.8.3 rule 3: "duck the pad" and
 * "thin the pad" are two routes; "-2 dB" and "-3 dB" are one route with a
 * parameter. `routesDistinct()` enforces exactly that and the test runs it
 * over every card the generator can produce.
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * The signature a distinctness check compares: tool + op + target + device +
 * the SET OF PARAMETER NAMES + which BANDS any frequency parameters land in.
 *
 * Magnitudes are deliberately excluded — "cut 2 dB" and "cut 3 dB" are one
 * route with a parameter (SPEC D1.8.3 rule 3). Frequencies are deliberately
 * INCLUDED, bucketed to the band: cutting 85 Hz and cutting 175 Hz are two
 * different-sounding mixes, not two intensities of one idea. Bucketing rather
 * than comparing the numbers keeps 340 Hz and 355 Hz — the same move, rounded
 * differently — as one route.
 */
export function routeSignature(route) {
  const a = route?.op?.args || {};
  const params = a.params || {};
  const names = Object.keys(params).sort().join(",");
  const bands = Object.entries(params)
    .filter(([k, v]) => /_hz$/.test(k) && Number.isFinite(Number(v)))
    .map(([, v]) => BAND_EDGES.findIndex(([lo, hi]) => v >= lo && v < hi))
    .sort((x, y) => x - y).join("/");
  return [route?.op?.tool, a.op, a.target ?? a.track ?? "", a.type ?? "",
          names, bands].join("|");
}

export function routesDistinct(routes) {
  const seen = new Set();
  for (const r of routes || []) {
    const s = routeSignature(r);
    if (seen.has(s)) return false;
    seen.add(s);
  }
  return (routes || []).length >= 2;
}

/** The insert chain of a target, read off the document. */
function chainOf(doc, target) {
  if (target === "master") return doc.master?.inserts || [];
  const t = (doc.tracks || []).find((x) => x.id === target);
  if (t) return t.inserts || [];
  const r = (doc.returns || []).find((x) => x.id === target);
  return r ? (r.inserts || []) : [];
}

const faderOf = (doc, target) => {
  const host = target === "master" ? doc.master
    : (doc.tracks || []).find((x) => x.id === target)
      || (doc.returns || []).find((x) => x.id === target);
  const f = host?.fader;
  return typeof f === "number" ? f : 0;      // an automated fader has no single value
};
const faderIsAutomated = (doc, target) => {
  const host = target === "master" ? doc.master
    : (doc.tracks || []).find((x) => x.id === target)
      || (doc.returns || []).find((x) => x.id === target);
  return !!host?.fader && typeof host.fader === "object";
};

/**
 * An EQ move on a target's band, as ONE insert. If the chain already has an
 * EQ, the move edits it (picking the nearest slot, or an unused one) rather
 * than stacking a second EQ — three iterations of "cut the boxiness" must
 * not leave three EQs on the pad.
 */
function eqOp(doc, slug, target, bandIdx, gainDb, opts = {}) {
  const hz = clamp(opts.hz ?? bandCenter(bandIdx), ...DEVICE_LIMITS.eqHz);
  const q = clamp(opts.q ?? bandQ(bandIdx), ...DEVICE_LIMITS.eqQ);
  const g = r2(clamp(gainDb, ...DEVICE_LIMITS.eqGainDb));
  const eq = chainOf(doc, target).find((i) => i.type === "eq");
  const body = opts.highpass
    ? { hp_on: true, hp_hz: clamp(opts.hpHz ?? BAND_EDGES[bandIdx][1], ...DEVICE_LIMITS.hpHz) }
    : null;
  if (!eq) {
    return {
      tool: "daw_insert",
      args: { op: "add", slug, target, type: "eq",
              params: body || { b2_hz: hz, b2_gain_db: g, b2_q: r2(q) } },
    };
  }
  if (body) {
    return { tool: "daw_insert",
             args: { op: "set", slug, target, insert: eq.id, params: body } };
  }
  const slot = pickEqSlot(eq, hz);
  /* ADDITIVE ON A SLOT ALREADY IN THIS BAND. The finding was measured AFTER
   * whatever that slot is already doing, so the number in it is the error
   * that REMAINS — the correct move is to add to the existing cut, not to
   * restate it. Replacing it produced a genuine failure in the live run: the
   * second iteration re-issued an identical -6 dB and moved the mix by 0.00
   * dB, burning one of only three iterations. The clamp keeps it bounded and
   * the A/B guard adjudicates the result either way. */
  const already = Number(eq.params?.[`${slot}_gain_db`]);
  const sameBand = Math.abs(Math.log2((Number(eq.params?.[`${slot}_hz`]) || hz) / hz)) < 0.5;
  const total = (sameBand && Number.isFinite(already))
    ? r2(clamp(already + g, ...DEVICE_LIMITS.eqGainDb)) : g;
  return {
    tool: "daw_insert",
    args: { op: "set", slug, target, insert: eq.id,
            params: { [`${slot}_hz`]: hz, [`${slot}_gain_db`]: total, [`${slot}_q`]: r2(q) } },
  };
}

/** Nearest slot already parked in this band, else the flattest (unused) one. */
export function pickEqSlot(eq, hz) {
  const slots = ["b1", "b2", "b3", "b4"];
  const p = eq?.params || {};
  const near = slots.filter((s) => {
    const f = Number(p[`${s}_hz`]);
    return Number.isFinite(f) && f > 0 && Math.abs(Math.log2(f / hz)) < 0.5;
  });
  if (near.length) return near[0];
  let best = slots[0], bestG = Infinity;
  for (const s of slots) {
    const g = Math.abs(Number(p[`${s}_gain_db`]) || 0);
    if (g < bestG) { bestG = g; best = s; }
  }
  return best;
}

const faderOp = (slug, target, db) => ({
  tool: "daw_mixer",
  args: { op: "set", slug, target, fader: r2(clamp(db, ...DEVICE_LIMITS.faderDb)) },
});

const insertAdd = (slug, target, type, params, index) => ({
  tool: "daw_insert",
  args: { op: "add", slug, target, type, params, ...(index === undefined ? {} : { index }) },
});

/**
 * finding → 2..4 genuinely different creative routes (or one `note` op when
 * the honest answer is a single move — a card with one option is a
 * confirmation dialog, and R5.4 says a confirmation dialog is worth nothing).
 */
export function mapFinding(finding, ctx) {
  const { doc, slug } = ctx;
  const nameOf = (id) => ctx.nameOf?.(id) ?? id;
  const f = finding;
  const R = (id, text, op, why) => ({ id, text, op, why });

  switch (f.metric) {
    /* ── the pad masks the vocal ─────────────────────────────────────── */
    case "masking": {
      const masker = f.target, maskee = f.against;
      const b = f.band_index;
      const cut = -Math.min(9, Math.max(2, f.observed - f.target_value));
      const routes = [];
      /* THE MUSICAL MOVE FIRST, when the maskee has one. Every route below
       * lands on the MASKER; the first live run's top card asked for a -9 dB
       * EQ on the kick at 173 Hz to rescue a riser — and following it cost
       * 1.7 LUFS and 0.8 dB of kick transient. A producer raises the riser's
       * filter start instead: the riser stops living where the kick lives
       * and the kick is untouched. So when the maskee's patch has a voice
       * knob that moves it out of the band, that is route one, and it says
       * why it is preferred. */
      const voice = voiceOutOfBand(doc, maskee, b);
      if (voice) {
        routes.push(R("voice",
          `Move ${nameOf(maskee)} out of ${BAND_LABELS[b]} from ITS side — ${voice.patch}.${voice.knob} from ${voice.from} to ${voice.to} Hz — and leave ${nameOf(masker)} alone`,
          { tool: "daw_set_track", args: { slug, track: maskee, params: { [voice.knob]: voice.to } } },
          `musical, not corrective: ${nameOf(masker)} keeps its weight and its transient (an EQ on the masker costs both), and ${nameOf(maskee)} simply starts where it can be heard`));
      }
      routes.push(
        R("thin", `Thin ${nameOf(masker)} at ${BAND_LABELS[b]} — carve ${Math.abs(cut).toFixed(0)} dB out of it so ${nameOf(maskee)} has the band to itself`,
          eqOp(doc, slug, masker, b, cut),
          "surgical: the masker keeps its level and its part, and loses only the frequencies it was stealing"),
        R("duck", `Duck ${nameOf(masker)} under ${nameOf(maskee)} — a compressor on ${nameOf(masker)} keyed off ${nameOf(maskee)}, so it steps back only while ${nameOf(maskee)} plays`,
          insertAdd(slug, masker, "compressor", {
            sidechain: maskee, threshold_db: -24, ratio: 4,
            attack_ms: 5, release_ms: 180, knee_db: 6,
          }),
          "dynamic: full body when the maskee is silent, out of the way when it is not"),
        R("lower", `Turn ${nameOf(masker)} down ${Math.abs(cut).toFixed(0)} dB everywhere`,
          faderOp(slug, masker, faderOf(doc, masker) + cut),
          "blunt but honest: the arrangement may simply have it too loud"),
      );
      if (b <= 2) {
        routes.push(R("highpass",
          `High-pass ${nameOf(masker)} at ${BAND_EDGES[b][1]} Hz — take its bottom off entirely and let ${nameOf(maskee)} own the low end`,
          eqOp(doc, slug, masker, b, 0, { highpass: true }),
          "structural: two parts stop competing for the low end at all"));
      }
      return { routes: routes.slice(0, 4) };
    }

    /* ── a track sits away from where its role usually sits ──────────── */
    case "level": {
      const t = f.target, d = f.delta_db;
      const up = d > 0;
      const routes = [
        R("fader", `${up ? "Raise" : "Lower"} ${nameOf(t)} ${Math.abs(d).toFixed(1)} dB on the fader`,
          faderOp(slug, t, faderOf(doc, t) + d),
          "the level move, after its inserts — the mix balance changes, the tone does not"),
        R("trim", `${up ? "Drive" : "Back off"} ${nameOf(t)} into its chain by ${Math.abs(d).toFixed(1)} dB (a Utility at the top of the chain)`,
          insertAdd(slug, t, "utility", { gain_db: r2(clamp(d, -48, 24)) }, 0),
          "gain staging: everything downstream — saturation, compression — hears it differently"),
        up
          ? R("compress", `Make ${nameOf(t)} denser instead of louder — a compressor with makeup, so it sits forward without peaking higher`,
            insertAdd(slug, t, "compressor", {
              threshold_db: -20, ratio: 3, attack_ms: 15, release_ms: 150,
              makeup_db: r2(clamp(Math.abs(d) * 0.7, 0, 24)),
            }),
            "presence without headroom: the part reads louder, the peaks do not move")
          : R("carve", `Leave ${nameOf(t)} where it is and take out its loudest band instead`,
            eqOp(doc, slug, t, dominantBand(ctx, t), -Math.min(6, Math.abs(d))),
            "tonal: it stops crowding without losing its place in the arrangement"),
      ];
      return { routes };
    }

    /* ── the master is off the loudness target ───────────────────────── */
    case "lufs": {
      const d = f.delta_db;
      const loud = loudestTrack(ctx);
      const band = masterDominantBand(ctx);
      const routes = [
        R("master_fader", `${d > 0 ? "Raise" : "Lower"} the master ${Math.abs(d).toFixed(1)} dB`,
          faderOp(slug, "master", faderOf(doc, "master") + d),
          "the whole mix moves together; nothing about the balance changes"),
        d > 0
          ? R("limit", "Limit into the target instead — a limiter at -1 dBTP with the level pushed up to it",
            insertAdd(slug, "master", "limiter", { ceiling_db: -1, release_ms: 80, lookahead_ms: 5 }),
            "loudness by control rather than by gain: denser, and the peaks stay legal")
          : R("trim_band", `Take ${Math.min(6, Math.abs(d)).toFixed(1)} dB out of ${BAND_LABELS[band]}, where most of the energy is`,
            eqOp(doc, slug, "master", band, -Math.min(6, Math.abs(d))),
            "the loudness is coming from one region of the spectrum — take it from there and the mix keeps its dynamics"),
      ];
      if (loud && loud !== "master") {
        routes.push(R("loudest_part",
          `Leave the master alone and ${d > 0 ? "raise" : "lower"} ${nameOf(loud)}, the loudest part, instead`,
          faderOp(slug, loud, faderOf(doc, loud) + d),
          "the mix is off target because one part is — fix it there, not at the end"));
      }
      return { routes };
    }

    /* ── the peaks are over the ceiling / the file is clipping ───────── */
    case "true_peak":
    case "clipping": {
      const over = f.metric === "clipping" ? 3 : (f.observed - f.target_value);
      const routes = [
        R("limiter", `Put a limiter on the master at ${f.metric === "clipping" ? "-1" : f.target_value} dBTP`,
          insertAdd(slug, "master", "limiter",
            { ceiling_db: r2(clamp(f.metric === "clipping" ? -1 : f.target_value, -20, 0)),
              release_ms: 80, lookahead_ms: 5 }),
          "keeps the loudness, catches only the peaks that break the ceiling"),
        R("master_down", `Pull the master ${Math.abs(over).toFixed(1)} dB down and leave the dynamics alone`,
          faderOp(slug, "master", faderOf(doc, "master") - Math.abs(over)),
          "no processing at all — the whole thing simply sits lower"),
        R("saturate", `Soften the peaks with a saturator instead of clamping them`,
          insertAdd(slug, "master", "saturator",
            { drive_db: 4, character: "tape", mix: 0.6, trim_db: r2(-Math.abs(over)) }),
          "the transients round off with harmonic character rather than being cut flat"),
      ];
      return { routes };
    }

    /* ── a band is off the reference curve ───────────────────────────── */
    case "balance": {
      const b = f.band_index;
      /* AN EMPTY BAND IS NOT AN EQ PROBLEM. There is nothing there to lift,
       * and lifting it anyway is the worst advice a mix critic can give — it
       * adds rumble or hiss, eats headroom, and measurably worsens the mix
       * (the A/B guard caught exactly that and reverted it, which is how this
       * branch got written). So it ships as a note about the ARRANGEMENT,
       * with no edit at all, rather than as a card with a fake choice. */
      if (f.boostable === false || f.direction === "absent") {
        return {
          note: null,
          why: `Nothing is playing in ${BAND_LABELS[b]}. No EQ move can fix an empty `
            + "band — if you want energy there, the answer is a part, not a filter. "
            + "Reported so you know, and deliberately carrying no suggested edit.",
        };
      }
      /* Balance moves are capped at 6 dB. A curve error bigger than that is
       * an arrangement problem wearing an EQ costume, and a 12 dB bell is
       * never the honest first move. */
      const d = Math.max(-6, Math.min(6, f.delta_db));
      const dom = dominantTrackFor(ctx, b);
      const routes = [];
      if (d > 0 && Number.isInteger(f.most_over_band)) {
        const ob = f.most_over_band;
        routes.push(R("cut_over",
          `Cut ${BAND_LABELS[ob]} instead — this band only reads low because that one reads high`,
          eqOp(doc, slug, "master", ob, -Math.min(6, Math.abs(d))),
          "same relative balance, no headroom spent, nothing added that was not played"));
      }
      routes.push(R("master_eq",
        `${d < 0 ? "Cut" : "Lift"} ${BAND_LABELS[b]} on the master by ${Math.abs(d).toFixed(1)} dB`,
        eqOp(doc, slug, "master", b, d),
        "one move, whole mix — the most direct way to the reference curve"));
      if (dom) {
        routes.push(R("source_eq",
          `${d < 0 ? "Cut" : "Lift"} ${BAND_LABELS[b]} on ${nameOf(dom)}, the part that owns that band`,
          eqOp(doc, slug, dom, b, d),
          "surgical: everything else keeps its tone"));
        if (routes.length < 4) {
          routes.push(R("source_fader",
            `${d < 0 ? "Turn down" : "Turn up"} ${nameOf(dom)} instead of EQ-ing anything`,
            faderOp(slug, dom, faderOf(doc, dom) + Math.max(-4, Math.min(4, d * 0.7))),
            "arrangement, not tone — the part is simply too present, or not present enough"));
        }
      } else {
        routes.push(R("master_shelf",
          `${d < 0 ? "Roll off" : "Open up"} everything below ${BAND_EDGES[b][1]} Hz with a high-pass instead of a bell`,
          eqOp(doc, slug, "master", b, 0, { highpass: true, hpHz: BAND_EDGES[b][0] }),
          "structural rather than corrective"));
      }
      return { routes: routes.slice(0, 4) };
    }

    /* ── the master is squashed, or spiky ────────────────────────────── */
    case "dynamics": {
      if (f.direction === "too_compressed") {
        const lim = chainOf(doc, "master").find((i) => i.type === "limiter" || i.type === "compressor");
        const routes = [
          R("master_down", `Stop driving the master so hard — pull it ${Math.abs(f.target_value - f.observed).toFixed(1)} dB`,
            faderOp(slug, "master", faderOf(doc, "master") - Math.abs(f.target_value - f.observed)),
            "the squash is the master curve being fed too much; feed it less"),
          lim
            ? R("relax_device", `Relax the ${lim.type} already on the master`,
              { tool: "daw_insert",
                args: { op: "set", slug, target: "master", insert: lim.id,
                        params: lim.type === "limiter"
                          ? { ceiling_db: -3, release_ms: 200 }
                          : { threshold_db: -12, ratio: 2, release_ms: 250 } } },
              "keep the device, give it less to do")
            : R("loudest_down", `Pull the loudest part back instead of the whole mix`,
              faderOp(slug, loudestTrack(ctx) || "master",
                faderOf(doc, loudestTrack(ctx) || "master") - 3),
              "the crush usually comes from one part, not from all of them"),
        ];
        return { routes };
      }
      return {
        routes: [
          R("glue", `Glue the master with a gentle compressor (3:1, slow) so the peaks stop towering`,
            insertAdd(slug, "master", "compressor",
              { threshold_db: -18, ratio: 3, attack_ms: 30, release_ms: 250, knee_db: 9 }),
            "the body comes up towards the peaks"),
          R("ceiling", `Catch only the peaks with a limiter and leave the body untouched`,
            insertAdd(slug, "master", "limiter", { ceiling_db: -1, release_ms: 120, lookahead_ms: 5 }),
            "nothing changes except the very top"),
        ],
      };
    }

    /* ── the master is off the PROJECT's / GENRE's loudness target ───── */
    case "loudness_target": {
      const d = Number(f.delta_db) || 0;            // + = needs to come up
      const tgt = Number(f.target_value);
      const src = f.source === "project" ? "the project's own"
        : `${String(f.source || "").replace(/^genre:/, "")} ${f.delivery || ""}`.trim();
      const routes = [];
      const stage = masterStageOp(slug, tgt, -1);
      if (stage) {
        routes.push(R("master_stage",
          `Run the master stage at ${tgt} LUFS (${src} target): gain into a true-peak ceiling at -1 dBTP, `
          + `the ${Math.abs(d).toFixed(1)} dB coming from control rather than from a fader`,
          stage,
          "the stage measures, sets its own gain and reports how much work the ceiling did; the crest comes down toward the genre's with it"));
      }
      if (d > 0) {
        /* Up. The maximizer IS the loudness-by-control move the rack already
         * has: gain into a ceiling, in one device. It is not "add a limiter"
         * — a -1 dBTP limiter over a -7 dBTP master never engages, which is
         * exactly why the shipped bounce sat 13 dB under target with a
         * limiter on it. */
        routes.push(R("maximize",
          `Drive ${Math.min(24, d).toFixed(1)} dB into a maximizer on the master (ceiling -1 dBTP)`,
          insertAdd(slug, "master", "maximizer",
            { gain_db: r2(clamp(d, 0, 24)), ceiling_db: -1, release_ms: 120, lookahead_ms: 5 }),
          "loudness by control: the body comes up, the peaks meet the ceiling and stop there — denser, and legal"));
        routes.push(R("master_fader",
          `Raise the master fader ${Math.min(12, d).toFixed(1)} dB and let the tanh curve catch the peaks`,
          faderOp(slug, "master", faderOf(doc, "master") + d),
          "no new device: the whole mix comes up together and the master curve rounds whatever crosses it — blunt, and honest about being blunt"));
        const loud = loudestTrack(ctx);
        if (loud && loud !== "master") {
          routes.push(R("loudest_part",
            `Leave the master alone and raise ${nameOf(loud)}, the loudest part, ${Math.min(6, d).toFixed(1)} dB`,
            faderOp(slug, loud, faderOf(doc, loud) + Math.min(6, d)),
            "if the mix is quiet because its centre is, fix it there — the balance changes, the master does not"));
        }
      } else {
        routes.push(R("master_down", `Pull the master ${Math.abs(d).toFixed(1)} dB down`,
          faderOp(slug, "master", faderOf(doc, "master") + d),
          "the whole mix moves together; nothing about the balance changes"));
        const lim = chainOf(doc, "master").find((i) => i.type === "limiter" || i.type === "maximizer");
        if (lim) {
          routes.push(R("relax_device", `Relax the ${lim.type} already on the master instead`,
            { tool: "daw_insert",
              args: { op: "set", slug, target: "master", insert: lim.id,
                      params: lim.type === "maximizer"
                        ? { gain_db: r2(clamp((Number(lim.params?.gain_db) || 0) + d, 0, 24)) }
                        : { ceiling_db: r2(clamp((Number(lim.params?.ceiling_db) || -1) + d, -20, 0)) } } },
            "keep the device, feed it less"));
        } else {
          const band = masterDominantBand(ctx);
          routes.push(R("trim_band",
            `Take ${Math.min(6, Math.abs(d)).toFixed(1)} dB out of ${BAND_LABELS[band]}, where most of the energy is`,
            eqOp(doc, slug, "master", band, -Math.min(6, Math.abs(d))),
            "the loudness is coming from one region of the spectrum — take it from there and keep the dynamics"));
        }
      }
      return { routes: routes.slice(0, 4) };
    }

    /* ── the kick is off the song's root ─────────────────────────────── */
    case "tuning": {
      const t = f.target;
      const knob = f.knob || "tune";
      const cur = Number(f.current_knob) || 0;
      const semis = Number(f.semitones) || 0;
      const fine = r2(clamp(cur + semis, -24, 24));
      const tr = (doc.tracks || []).find((x) => x.id === t);
      const curTr = Number(tr?.instrument?.params?.transpose) || 0;
      const coarse = Math.round(-Number(f.observed) / 100);
      const residual = Math.abs(Number(f.observed) + coarse * 100);
      const routes = [
        R("tune",
          `Tune ${nameOf(t)} ${semis < 0 ? "down" : "up"} ${Math.abs(semis).toFixed(2)} st on its own knob `
          + `(${f.patch || "kick"}.${knob} → ${fine}) so its ${Number(f.f0_hz).toFixed(1)} Hz lands on `
          + `${f.root} (${Number(f.root_hz).toFixed(1)} Hz)`,
          { tool: "daw_set_track", args: { slug, track: t, params: { [knob]: fine } } },
          `exact, in cents: the ${Number(f.beat_hz).toFixed(1)} Hz beat against a sub on the root stops and nothing else about the kick changes`),
      ];
      if (coarse !== 0) {
        routes.push(R("transpose",
          `Transpose ${nameOf(t)} ${coarse > 0 ? "+" : ""}${coarse} semitone${Math.abs(coarse) === 1 ? "" : "s"} instead — the nearest whole step, `
          + `leaving ${residual.toFixed(0)} c of detune as colour`,
          { tool: "daw_set_track", args: { slug, track: t, params: { transpose: clamp(curTr + coarse, -48, 48) } } },
          "coarse and generic (every patch has transpose): the beat slows to under a hertz and the tune knob stays free"));
      }
      return { routes };
    }

    /* ── the stereo image ────────────────────────────────────────────── */
    case "width": {
      const t = f.target;
      if (f.direction === "dual_mono" && f.cause !== "arrangement") {
        /* ONE honest move: the rack's stereo switch. Two identical channels
         * are not "narrow" — widening, chorus and panning all act on a side
         * signal that is exactly zero, and the first live critique offered
         * all three against this very defect. So it is a NOTE naming the
         * switch, carrying the call when a declared tool can flip it. */
        const op = stereoSwitchOp(slug);
        const sw = f.switch || STEREO_SWITCH.doc;
        return {
          note: op,
          why: `L/R correlation ${Number(f.observed).toFixed(3)}: the master is two copies of one `
            + `signal${f.stems_measured ? ` and ${f.stems_dual_mono?.length ?? 0} of ${f.stems_measured} stems read the same` : ""}. `
            + (f.cause === "rack_fold"
              ? `The render job had the rack's stereo switch OFF, so every voice was folded to (L+R)/2 before its first insert — a spread lead's 0.7 correlation cannot survive that. `
              : `Check the rack's stereo switch first — the fold would look exactly like this. `)
            + `Turn on ${sw} (the render job carries it as ${STEREO_SWITCH.job}); it dirties every region, as any master change does. `
            + `Widening, chorus or panning would be processing a side signal that is exactly zero.`,
          why_not_a_card: op
            ? "only one honest route exists — the switch — so this is a note, not a one-option card"
            : `the switch (${sw}) is the only honest route and no declared tool can flip it from here yet; set it on the project`,
        };
      }
      if (f.direction === "out_of_phase") {
        return {
          routes: [
            R("flip", `Flip the phase on ${nameOf(t)}`,
              insertAdd(slug, t, "utility", { phase_invert: true }),
              "if one side was simply inverted, this restores it exactly"),
            R("narrow", `Narrow ${nameOf(t)} to half width — keep some image, lose the cancellation`,
              insertAdd(slug, t, "utility", { width: 0.5 }),
              "a compromise: still wider than mono, safe in mono"),
            R("mono", `Collapse ${nameOf(t)} to mono`,
              insertAdd(slug, t, "utility", { mono: true }),
              "the guaranteed-safe answer — the image goes, the cancellation goes with it"),
          ],
        };
      }
      return {
        routes: [
          R("widen", `Widen the master a little (Utility, width 1.3)`,
            insertAdd(slug, "master", "utility", { width: 1.3 }),
            "cheap and reversible; does nothing for a genuinely mono source"),
          R("chorus", `Give the widest-sounding part a chorus instead — real movement, not a matrix trick`,
            insertAdd(slug, widestCandidate(ctx) || "master", "chorus",
              { rate_hz: 0.6, depth_ms: 3, mix: 0.35, spread: 1 }),
            "the width comes from modulation, so it survives mono better"),
          R("pan", `Pan two parts apart instead of processing anything`,
            faderPanOp(slug, panCandidate(ctx), 0.35),
            "arrangement width: nothing is processed, the parts simply stop sitting on top of each other"),
        ].filter((r) => r.op.args.target || r.op.args.track),
      };
    }

    /* ══ §7 THE REFERENCE MATCH ═════════════════════════════════════════
     * Six cases, and every route lands on a knob or an insert that already
     * exists. Two of them DELEGATE to the critic that already owns the move
     * (a level is a level however the target was arrived at) and add the one
     * thing that is different: whose record this came from. */

    /* ── ref_level: the same move `level` makes, for a different reason ─ */
    case "ref_level": {
      const m = mapFinding({ ...f, metric: "level", delta_db: f.delta_db }, ctx);
      return {
        routes: (m.routes || []).map((r) => ({
          ...r,
          why: `${r.why} — and it is what puts the ${f.stem} where they sit in ${f.profile_name}`,
        })),
      };
    }

    /* ── ref_bands: a share difference, so an EQ move ──────────────────── */
    case "ref_bands": {
      const b = f.band_index;
      const cut = -clamp(f.delta_db, -9, 9);
      const owner = dominantTrackFor(ctx, b);
      const routes = [
        R("master_eq",
          `${cut < 0 ? "Take" : "Add"} ${Math.abs(cut).toFixed(1)} dB `
          + `${cut < 0 ? "out of" : "to"} ${BAND_LABELS[b]} on the master`,
          eqOp(doc, slug, "master", b, cut),
          `the whole mix moves toward ${f.profile_name}'s balance in that band, and no part's `
          + "place in the arrangement changes"),
      ];
      if (owner) {
        routes.push(R("owner_eq",
          `${cut < 0 ? "Thin" : "Lift"} ${nameOf(owner)} at ${BAND_LABELS[b]} instead — it is `
          + "the part that owns that band here",
          eqOp(doc, slug, owner, b, cut),
          "surgical: the band comes into line at its source, and everything else keeps its tone"));
        routes.push(R("owner_fader",
          `${cut < 0 ? "Turn" : "Bring"} ${nameOf(owner)} ${Math.abs(cut).toFixed(1)} dB `
          + `${cut < 0 ? "down" : "up"} everywhere`,
          faderOp(slug, owner, faderOf(doc, owner) + cut),
          "blunt, and sometimes right: the band may be loud because the part is"));
      }
      if (b <= 1 && cut < 0) {
        routes.push(R("highpass",
          `High-pass the master at ${BAND_EDGES[b][1]} Hz — take the bottom off entirely`,
          eqOp(doc, slug, "master", b, 0, { highpass: true }),
          `structural, and only worth it if ${f.profile_name} genuinely has nothing down there`));
      }
      return { routes: routes.slice(0, 4) };
    }

    /* ── ref_kick_tune: the tuning critic's move, against a record ────── */
    case "ref_kick_tune": {
      const t = f.target;
      const knob = f.knob || "tune";
      const cur = Number(f.current_knob) || 0;
      const semis = Number(f.semitones) || 0;          // a whole number of octaves x 12
      const fine = r2(clamp(cur + semis, -24, 24));
      const tr = (doc.tracks || []).find((x) => x.id === t);
      const curTr = Number(tr?.instrument?.params?.transpose) || 0;
      const dir = semis < 0 ? "down" : "up";
      const oct = Math.abs(Number(f.register) || Math.round(semis / 12));
      return {
        routes: [
          R("tune",
            `Take ${nameOf(t)} ${dir} ${oct} octave${oct === 1 ? "" : "s"} on its own knob `
            + `(${f.patch || "kick"}.${knob} → ${fine}), from ${Number(f.f0_hz).toFixed(1)} Hz `
            + `into ${f.profile_name}'s register at ${Number(f.ref_f0_hz).toFixed(1)} Hz`,
            { tool: "daw_set_track", args: { slug, track: t, params: { [knob]: fine } } },
            "a whole octave, so the kick stays on the same NOTE and only changes register — "
            + `the ${Math.abs(Number(f.residual_cents) || 0).toFixed(0)} c between the two songs' `
            + "keys is left exactly where it is"),
          R("transpose",
            `Transpose ${nameOf(t)} ${semis > 0 ? "+" : ""}${semis} instead — the same octave, `
            + "on the generic control every patch has",
            { tool: "daw_set_track",
              args: { slug, track: t, params: { transpose: clamp(curTr + semis, -48, 48) } } },
            "identical in pitch and different in bookkeeping: the tune knob stays free for the "
            + "`tuning` critic, which is the one that answers to this song's root"),
          R("layer",
            `Leave the kick alone and add the missing register underneath — a sub-heavy `
            + `saturator on ${nameOf(t)} rather than a retune`,
            insertAdd(slug, t, "saturator",
              { drive_db: 6, character: semis < 0 ? "tape" : "tube", mix: 0.35, trim_db: 0 }),
            `${f.profile_name}'s kick is an octave ${semis < 0 ? "lower" : "higher"}, which is `
            + "usually two layers rather than one transposed voice; this reaches for the "
            + "harmonics instead of moving the fundamental"),
        ],
      };
    }

    /* ── ref_kick_decay: the instrument's own decay, or the chain's ───── */
    case "ref_kick_decay": {
      const t = f.target;
      const tr = (doc.tracks || []).find((x) => x.id === t);
      const patch = tr?.instrument?.patch || f.patch;
      const knob = KICK_DECAY_KNOBS[patch];
      const spec = knob && PATCHES[patch]?.params?.[knob];
      const shorter = Number(f.ratio) > 1;
      const routes = [];
      if (spec) {
        const cur = Number(tr?.instrument?.params?.[knob] ?? spec.default) || Number(spec.default) || 0;
        /* Proportional, and CAPPED. The knob is a 0..1 control over an
         * exponential decay, so scaling it by the time ratio is a first move
         * and not an answer — which is what the `why` says, and why the step
         * is limited to a third of the knob's range rather than jumping to an
         * end stop on one measurement. */
        const want = cur / Math.max(Number(f.ratio) || 1, 0.05);
        const cap = (Number(spec.max) - Number(spec.min)) / 3;
        const to = r2(clamp(clamp(want, cur - cap, cur + cap), Number(spec.min), Number(spec.max)));
        routes.push(R("decay_knob",
          `${shorter ? "Shorten" : "Lengthen"} the kick at the source — ${patch}.${knob} `
          + `from ${r2(cur)} to ${to}`,
          { tool: "daw_set_track", args: { slug, track: t, params: { [knob]: to } } },
          `the instrument's own decay, which is what a ${shorter ? "shorter" : "longer"} kick `
          + "actually is. The knob is not calibrated in milliseconds, so this is a step in the "
          + "right direction — daw_voice_lab with params_override renders it and measures "
          + "t10/t30/t60 without writing anything"));
      }
      routes.push(shorter
        ? R("gate",
          `Cut the tail in the chain instead — a gate on ${nameOf(t)} that closes by `
          + `${Number(f.target_value).toFixed(0)} ms`,
          insertAdd(slug, t, "gate", {
            threshold_db: -32, range_db: -24, attack_ms: 0.5,
            hold_ms: r2(clamp(Number(f.target_value) * 0.6, 1, 500)),
            release_ms: r2(clamp(Number(f.target_value) * 0.4, 1, 500)),
          }),
          "the patch keeps its character and the tail is shaped after it — reversible in one "
          + "click, and it works on a kick you did not synthesise")
        : R("sustain",
          `Hold the tail up in the chain instead — a compressor on ${nameOf(t)} with a slow `
          + "attack and a long release, so the body survives the transient",
          insertAdd(slug, t, "compressor", {
            threshold_db: -24, ratio: 4, attack_ms: 20,
            release_ms: r2(clamp(Number(f.target_value) * 1.2, 20, 1000)),
            knee_db: 6, makeup_db: 2,
          }),
          "the attack is untouched and the decay is pushed up under it — a longer kick without "
          + "retuning the instrument"));
      return { routes };
    }

    /* ── ref_pump: the sidechain's depth and recovery ──────────────────── */
    case "ref_pump": {
      const t = f.target;
      const sc = chainOf(doc, t).find((i) => i.type === "compressor" && i.params?.sidechain);
      const deeper = Number(f.depth_delta_db) > 0;      // ours ducks LESS than theirs
      const wantRel = Number(f.ref_recovery_ms);
      if (!sc) {
        /* One honest move: there is nothing to adjust, so this is a note with
         * the call on it rather than a one-option card. */
        return {
          note: insertAdd(slug, t, "compressor", {
            sidechain: f.against || undefined,
            threshold_db: -24, ratio: r2(clamp(2 + Math.abs(Number(f.target_value)) / 4, 1.5, 12)),
            attack_ms: 3, release_ms: r2(clamp(wantRel || 120, 5, 1000)), knee_db: 6,
          }),
          why: `${f.profile_name} ducks its bass ${Math.abs(Number(f.target_value)).toFixed(1)} dB `
            + `under the kick and recovers in ${wantRel ? `${wantRel.toFixed(0)} ms` : "under a beat"}; `
            + `${nameOf(t)} has no sidechain compressor at all, so there is no knob to turn — `
            + "the only move is to put one there, keyed off "
            + `${f.against ? nameOf(f.against) : "the kick"}.`,
          why_not_a_card: "there is exactly one honest route (add the device), and a one-option "
            + "card is a confirmation dialog",
        };
      }
      const p = sc.params || {};
      const routes = [
        R("ratio",
          `${deeper ? "Deepen" : "Ease"} the duck — ${sc.type} ratio `
          + `${r2(Number(p.ratio) || 4)} → `
          + `${r2(clamp((Number(p.ratio) || 4) * (deeper ? 1.6 : 0.65), 1.2, 20))}`,
          { tool: "daw_insert",
            args: { op: "set", slug, target: t, insert: sc.id,
                    params: { ratio: r2(clamp((Number(p.ratio) || 4) * (deeper ? 1.6 : 0.65), 1.2, 20)) } } },
          `depth without changing when it happens: ${Math.abs(Number(f.observed)).toFixed(1)} dB `
          + `here against ${Math.abs(Number(f.target_value)).toFixed(1)} dB in ${f.profile_name}`),
        R("threshold",
          `${deeper ? "Lower" : "Raise"} the threshold instead — `
          + `${r2(Number(p.threshold_db) ?? -24)} dB → `
          + `${r2(clamp((Number(p.threshold_db) ?? -24) + (deeper ? -6 : 6), -60, 0))} dB`,
          { tool: "daw_insert",
            args: { op: "set", slug, target: t, insert: sc.id,
                    params: { threshold_db: r2(clamp((Number(p.threshold_db) ?? -24) + (deeper ? -6 : 6), -60, 0)) } } },
          "the same depth arrived at by feeding it more, which changes the quieter hits too — "
          + "a different feel from a steeper ratio"),
      ];
      if (Number.isFinite(wantRel)) {
        routes.push(R("release",
          `Match the RECOVERY rather than the depth — release `
          + `${r2(Number(p.release_ms) ?? 120)} ms → ${r2(clamp(wantRel, 5, 1000))} ms`,
          { tool: "daw_insert",
            args: { op: "set", slug, target: t, insert: sc.id,
                    params: { release_ms: r2(clamp(wantRel, 5, 1000)) } } },
          `${f.profile_name} comes back over `
          + `${((Number(f.ref_recovery_frac) || 0) * 100).toFixed(0)} % of a beat and this mix over `
          + `${((Number(f.recovery_frac) || 0) * 100).toFixed(0)} % — the recovery is the half of a `
          + "pump people actually hear as groove"));
      }
      return { routes };
    }

    /* ── ref_width: the image, per band ────────────────────────────────── */
    case "ref_width": {
      const b = f.band_index;
      if (f.direction === "dual_mono") {
        /* The same honest refusal the `width` critic makes: two identical
         * channels have a side signal that is exactly zero, and every widener
         * would be processing nothing. */
        const op = stereoSwitchOp(slug);
        return {
          note: op,
          why: `this mix is two copies of one signal (side energy exactly zero), so it is not `
            + `"narrower than ${f.profile_name}" — it has no image at all. Turn on `
            + `${STEREO_SWITCH.doc} (the render job carries it as ${STEREO_SWITCH.job}); it `
            + "dirties every region, as any master change does.",
          why_not_a_card: op
            ? "only one honest route exists — the switch — so this is a note, not a one-option card"
            : `the switch (${STEREO_SWITCH.doc}) is the only honest route and no declared tool `
              + "can flip it from here yet",
        };
      }
      const wider = f.delta_db < 0;          // we are NARROWER than the reference
      const [lo, hi] = BAND_EDGES[b] || [0, 0];
      /* ── THE LOW END IS NEVER WIDENED ─────────────────────────────────
       * The first live run of this critic offered "widen the sub 2.5x",
       * because a demucs-separated reference reads -18 dB of side energy
       * below 60 Hz against our -51. Two reasons that is not a card. The
       * measurement is mostly separation bleed: four stems summed back are
       * not a mixdown, and the sub band is where that shows first. And even
       * where it is real, a wide low end is the first thing a club system
       * cancels and the first thing a cutting engineer removes — so the one
       * move on offer would be the one move that reliably fails. It is
       * reported, with the number, and nothing is offered. */
      if (wider && b <= 1) {
        return {
          note: null,
          why: `${f.profile_name} carries ${Math.abs(f.delta_db).toFixed(1)} dB more side `
            + `energy than this mix in ${BAND_LABELS[b]} (${Number(f.target_value).toFixed(1)} dB `
            + `against ${Number(f.observed).toFixed(1)}). No widening is offered down there: a `
            + "wide low end is what a club system cancels first and what a cutting engineer "
            + "takes out, and a reference measured from four separated stems reads side energy "
            + "in the sub that its own mixdown does not have. If the reference genuinely has a "
            + "stereo sub, it was made by two LAYERS panned apart, which is an arrangement "
            + "decision and not a width knob.",
          why_not_a_card: "the only routes here are ones that would measurably make the mix "
            + "worse in mono, so none is offered",
        };
      }
      const ratio = r2(clamp(10 ** (Number(f.delta_db) / -20), 0.2, 2.5));
      const routes = [
        R("imager",
          `Set the image in ${BAND_LABELS[b]} on its own — a stereo imager on the master with `
          + `that band at ${ratio}x`,
          insertAdd(slug, "master", "stereoImager",
            b <= 1 ? { x1_hz: Math.round(hi), x2_hz: 2000, w1_width: ratio, w2_width: 1, w3_width: 1 }
              : (b <= 5 ? { x1_hz: Math.round(lo), x2_hz: Math.round(hi), w1_width: 1, w2_width: ratio, w3_width: 1 }
                : { x1_hz: 250, x2_hz: Math.round(lo), w1_width: 1, w2_width: 1, w3_width: ratio })),
          `the band that is off comes into line and the other eight are untouched — which is the `
          + `whole reason this is measured per band rather than as one number`),
        R("utility",
          `${wider ? "Widen" : "Narrow"} the WHOLE image instead — a utility on the master at `
          + `width ${ratio}`,
          insertAdd(slug, "master", "utility", { width: ratio }),
          "cheap and reversible, and it moves every band together — right when the mix is "
          + "uniformly narrower or wider, wrong when one band is the problem"),
      ];
      if (!wider && b <= 1) {
        routes.push(R("mono_below",
          `Put the bottom in mono outright — mono below ${Math.round(hi)} Hz`,
          insertAdd(slug, "master", "stereoImager", { mono_below_hz: Math.round(hi) }),
          `${f.profile_name} is narrow down here because almost every record is: a wide low end `
          + "is what a club system cancels first"));
      }
      return { routes };
    }

    /* ── DC offset: one honest move, so it is a NOTE, not a card ─────── */
    case "dc":
      return {
        note: eqOp(doc, slug, "master", 0, 0, { highpass: true, hpHz: 20 }),
        why: "a 20 Hz high-pass on the master removes DC; there is no second "
          + "creative route here, so this is reported as a note rather than "
          + "dressed up as a choice",
      };

    default:
      return { routes: [] };
  }
}

const faderPanOp = (slug, target, pan) => ({
  tool: "daw_mixer",
  args: { op: "set", slug, target: target || "", pan: r2(clamp(pan, -1, 1)) },
});

/* The voice knobs that move a part OUT of a band from its own side — the
 * musical alternative to EQ-ing the masker. Only patches whose knob is a
 * filter START (Hz) qualify: raising it past the masked band's top edge
 * takes the part's low end away at the source. Ranges are read from the
 * patch table at call time, never assumed. */
const VOICE_KNOBS = {
  riser: "cutoff_start",        // where the riser's sweep begins
  bigroom_lead: "cutoff",       // the lead's filter floor
};

/* §7 — the knob a kick's tail is actually on, per patch. The names are the
 * patches' own (patches.json), and the range and default are read from there
 * at call time rather than assumed here, exactly as VOICE_KNOBS does. Not a
 * copy of KICK_TUNE_KNOBS: that table is about pitch and this one is about
 * time, and tr808_bass is a kick this one can shape and that one does not
 * name because it is not what the tuning critic measures. */
export const KICK_DECAY_KNOBS = {
  hybrid_kick: "decay",
  tr808: "kick_decay",
  tr909: "kick_decay",
  tr808_bass: "decay",
};
/** { patch, knob, from, to } when the maskee's filter starts below the band
 *  it is masked in and can be raised past it; else null. */
function voiceOutOfBand(doc, maskee, bandIdx) {
  const tr = (doc?.tracks || []).find((x) => x.id === maskee);
  const patch = tr?.instrument?.patch;
  const knob = VOICE_KNOBS[patch];
  const spec = knob && PATCHES[patch]?.params?.[knob];
  if (!spec) return null;
  const from = Number(tr.instrument?.params?.[knob] ?? spec.default) || Number(spec.default) || 0;
  const [lo, hi] = BAND_EDGES[bandIdx] || [0, 0];
  if (!(from < hi)) return null;                       // already starts above the band
  /* Only when the band is the part's FLOOR — within two octaves of where its
   * filter starts. A band far above the start is the part's body; moving
   * the floor up there would not free the band, it would remove the part. */
  if (hi > from * 4) return null;
  const to = Math.round(clamp(Math.max(from * 2, hi * 1.5), Number(spec.min), Number(spec.max)));
  if (!(to > from) || to <= lo) return null;
  return { patch, knob, from: Math.round(from), to };
}

/* Helpers the mapping leans on — all derived from the MEASUREMENT, never
 * from an instrument name. */
function dominantBand(ctx, tid) {
  const b = ctx.measure?.tracks?.[tid]?.band_levels_db;
  if (!Array.isArray(b)) return 4;
  let best = 0;
  for (let i = 1; i < b.length; i++) if (b[i] > b[best]) best = i;
  return best;
}
function dominantTrackFor(ctx, bandIdx) {
  const tr = ctx.measure?.tracks || {};
  let best = null, bestV = -Infinity;
  for (const [tid, row] of Object.entries(tr)) {
    const v = row.band_levels_db?.[bandIdx];
    if (Number.isFinite(v) && v > bestV) { bestV = v; best = tid; }
  }
  return bestV > -70 ? best : null;
}
/** Where the master's own energy actually is — from the spectral measurement
 *  when there is one, otherwise from the loudest track's spectrum. Never from
 *  an assumption about the genre. */
function masterDominantBand(ctx) {
  const rows = ctx.measure?.spectral?.bands;
  if (Array.isArray(rows) && rows.length) {
    let best = rows[0];
    for (const r of rows) if ((r.level_db ?? -999) > (best.level_db ?? -999)) best = r;
    if (Number.isInteger(best.band_index)) return best.band_index;
  }
  const t = loudestTrack(ctx);
  return t ? dominantBand(ctx, t) : 4;
}
function loudestTrack(ctx) {
  const tr = ctx.measure?.tracks || {};
  let best = null, bestV = -Infinity;
  for (const [tid, row] of Object.entries(tr)) {
    if (row.lufs != null && row.lufs > bestV) { bestV = row.lufs; best = tid; }
  }
  return best;
}
const widestCandidate = (ctx) => {
  const tr = ctx.measure?.tracks || {};
  const ids = Object.keys(tr).filter((t) => (tr[t].lufs ?? -99) > -60);
  return ids.sort((a, b) => (tr[b].lufs ?? -99) - (tr[a].lufs ?? -99))[1] || ids[0] || null;
};
const panCandidate = (ctx) => widestCandidate(ctx);

/* ════════════════════════════════════════════════════════════════════════
 * §7 THE REFERENCE MATCH — a critic that reads a SHAPE, never a track
 *
 * `profile_build` measures a track somebody owns into dB, milliseconds and
 * counts (server/daw/refprofile.py, whose whitelist is what keeps a profile
 * from ever being a copy). This is the half that turns the DIFFERENCE between
 * that shape and ours into the same kind of card every other critic emits.
 *
 * It is a critic, not a subsystem: `mapFinding` gains six cases below,
 * `buildCards` and `rankCards` are untouched, the one-honest-route rule
 * applies unchanged, and every route it offers lands on a knob or an insert
 * that already exists.
 *
 * ── THE FOUR RULES IT HOLDS ITSELF TO ────────────────────────────────────
 *  1. EVERY COMPARISON IS GAIN-INVARIANT. A share against a share, a level
 *     against the sum of the same four levels, a width as side-over-mid, a
 *     decay as a ratio. So a reference mastered 8 dB louder than our bounce
 *     produces no finding at all about loudness — which is right, because
 *     `daw_reference` and the loudness critic already own that question, and
 *     answering it twice in two voices is how a stack of cards stops being
 *     read.
 *  2. IT REFUSES AN UNGATED PROFILE'S BEAT. refprofile's grid gate declines
 *     when it cannot find one, and everything downstream of the onsets — the
 *     kick's fundamental, its decay, the pump — is then measured on raw flux
 *     peaks. No ref_kick_* and no ref_pump finding is built from a profile
 *     whose `kick.grid.gated` is false, and the reason travels in `skipped`.
 *  3. IT NEVER MATCHES A STEM TO NOTHING. demucs always answers four stems;
 *     an instrumental project has no vocal, and that is an arrangement, not a
 *     fader eight dB out. A stem with no track in its role produces no
 *     finding and one line saying so.
 *  4. A SHAPE IS NOT A TARGET. The reference is what somebody else did, not
 *     what is correct, so every card names the reference it came from.
 *     `findingPenalty` weights these BELOW the objective critics for the same
 *     reason: 3 dB off pink is a fact, 3 dB off somebody's record is a taste.
 * ══════════════════════════════════════════════════════════════════════ */

/** How far off the reference is worth a card. Wider than the objective
 *  critics' tolerances on purpose: two records that sound alike differ by
 *  more than this in every band, and a card that fires on 1 dB of share is a
 *  card nobody reads twice. */
export const REF_TOL = {
  band_db: 2.5,        // a nine-band share difference
  level_db: 3.0,       // a stem group's level within the four
  width_db: 4.0,       // side-over-mid, per band
  kick_octaves: 0.7,   // the kick's REGISTER, in octaves — see ref_kick_tune
  decay_ratio: 0.35,   // |log2(ours/theirs)| on t30 — about 1.27x
  pump_db: 3.0,        // sidechain depth
  pump_frac: 0.10,     // recovery, as a fraction of a beat
};
/** At most this many band findings, worst first — nine cards about nine bands
 *  is the wall of cards CARD_CAP already exists to prevent. */
export const REF_MAX_BANDS = 3;

/** Which of our roles answer to which of demucs's four stems.
 *  `lead` is deliberately in `other` and not in `vocals`: inferRole maps both
 *  "vox" and "lead synth" to `lead`, and calling a big-room lead the vocal
 *  stem would land a fader move on the wrong track with total confidence. */
export const STEM_ROLES = {
  drums: ["drums"],
  bass: ["bass"],
  vocals: ["vocal"],
  other: ["lead", "guitar", "keys", "pad", "fx"],
};

const log2 = (x) => Math.log(x) / Math.LN2;
/** Fold a frequency ratio into the nearest octave, in cents: a kick at 33 Hz
 *  and one at 66 Hz are the same note. What is left after the fold is the
 *  difference between two songs' KEYS — see `ref_kick_tune`, which reports the
 *  octave and deliberately refuses the remainder. */
export function foldCents(ours, theirs) {
  let c = 1200 * log2(theirs / ours);
  while (c > 600) c -= 1200;
  while (c <= -600) c += 1200;
  return c;
}
const dbSum = (arr) => (arr.length
  ? 10 * Math.log10(arr.reduce((s, v) => s + 10 ** (v / 10), 0)) : null);

/** Our per-role group levels, each as a dB share of the four groups' sum —
 *  which is what makes this comparable to a profile's `level_rel_mix_db`
 *  without either side's master gain entering into it. */
export function groupLevels(doc, measure, roles = {}) {
  const tracks = measure?.tracks || {};
  const out = {};
  for (const [stem, want] of Object.entries(STEM_ROLES)) {
    const ids = (doc.tracks || [])
      .filter((t) => want.includes(roles[t.id] ?? inferRole(t) ?? ""))
      .map((t) => t.id)
      .filter((id) => Number.isFinite(Number(tracks[id]?.rms_db)));
    out[stem] = { tracks: ids, db: ids.length ? dbSum(ids.map((id) => tracks[id].rms_db)) : null };
  }
  const present = Object.values(out).filter((g) => g.db !== null).map((g) => g.db);
  const total = present.length ? dbSum(present) : null;
  for (const g of Object.values(out)) {
    g.share_db = (g.db === null || total === null) ? null : g.db - total;
  }
  return out;
}

/** The reference's own four levels, put on exactly the same footing. */
export function profileGroupShares(profile) {
  const st = profile?.stems || {};
  const rows = Object.keys(STEM_ROLES)
    .filter((s) => Number.isFinite(Number(st[s]?.level_rel_mix_db)))
    .map((s) => [s, Number(st[s].level_rel_mix_db)]);
  const total = rows.length ? dbSum(rows.map(([, v]) => v)) : null;
  return Object.fromEntries(rows.map(([s, v]) => [s, total === null ? null : v - total]));
}

/**
 * The findings. `measure` is ear.py's, with its §7 `shape` block; `profile` is
 * a whole reference profile as refprofile.py built it.
 *
 * Returns `{ findings, skipped }` — `skipped` is every comparison that was NOT
 * made and why, because a reference match that quietly measures four of six
 * things reads exactly like one that found nothing wrong with the other two.
 */
export function referenceFindings(profile, measure, ctx = {}) {
  const doc = ctx.doc || { tracks: [] };
  const nameOf = (id) => ctx.nameOf?.(id) ?? id;
  const ref = profile?.name || profile?.id || "the reference";
  const findings = [];
  const skipped = [];
  const F = (metric, what, where, how_much, severity, extra = {}) => ({
    metric, what, where, how_much, severity, confidence: 1.0,
    profile_id: profile?.id ?? null, profile_name: ref, ...extra,
  });
  const sev = (excess, thr) => {
    const r = Math.abs(excess) / Math.max(Math.abs(thr), 1e-9);
    return r >= 2 ? "high" : r >= 1 ? "medium" : "low";
  };
  const shape = measure?.shape || null;
  const gated = profile?.kick?.grid?.gated === true;
  const ourBands = measure?.spectral?.bands || [];

  /* ── ref_bands: the nine-band share, ours against theirs ───────────── */
  const refBands = profile?.master?.bands?.bands || [];
  if (ourBands.length === refBands.length && refBands.length) {
    const rows = [];
    for (let b = 0; b < refBands.length; b++) {
      if (ourBands[b].absent) continue;        // an empty band is arrangement, not EQ
      const d = Number(ourBands[b].observed_db) - Number(refBands[b].observed_db);
      if (Number.isFinite(d) && Math.abs(d) > REF_TOL.band_db) rows.push({ b, d });
    }
    rows.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    for (const { b, d } of rows.slice(0, REF_MAX_BANDS)) {
      findings.push(F("ref_bands",
        `${BAND_LABELS[b]} (${BAND_NAMES[b]}) holds ${Math.abs(d).toFixed(1)} dB `
        + `${d > 0 ? "more" : "less"} of this mix than it holds of ${ref}`,
        `master, ${BAND_LABELS[b]}`,
        `${d > 0 ? "+" : ""}${d.toFixed(1)} dB of share against ${ref} `
        + `(tolerance ±${REF_TOL.band_db} dB)`,
        sev(Math.abs(d) - REF_TOL.band_db, REF_TOL.band_db),
        { band: BAND_LABELS[b], band_index: b, target: "master",
          observed: r2(Number(ourBands[b].observed_db)),
          target_value: r2(Number(refBands[b].observed_db)),
          delta_db: r2(d) }));
    }
    if (!rows.length) {
      skipped.push(`ref_bands: every band is within ${REF_TOL.band_db} dB of ${ref}`);
    }
  } else {
    skipped.push("ref_bands: the profile and this critique do not agree on the band table");
  }

  /* ── ref_level: each stem group's place among the four ─────────────── */
  const ours = groupLevels(doc, measure, ctx.roles || {});
  const theirs = profileGroupShares(profile);
  for (const [stem, their] of Object.entries(theirs)) {
    const g = ours[stem];
    if (!g || !g.tracks.length) {
      skipped.push(`ref_level(${stem}): ${ref} has a ${stem} stem and no track here plays `
        + `that role (${STEM_ROLES[stem].join("/")}) — an absent part is an arrangement `
        + "decision, not a fader that is eight dB out");
      continue;
    }
    if (g.share_db === null || their === null) continue;
    const d = g.share_db - their;
    if (Math.abs(d) <= REF_TOL.level_db) continue;
    /* A fader move lands on the loudest track in the group: it is the one
     * carrying the level the comparison is about. */
    const t = g.tracks.slice().sort((a, b) =>
      (measure.tracks[b]?.rms_db ?? -99) - (measure.tracks[a]?.rms_db ?? -99))[0];
    findings.push(F("ref_level",
      `the ${stem} sit ${Math.abs(d).toFixed(1)} dB ${d > 0 ? "louder" : "quieter"} `
      + `in this mix than in ${ref}`,
      `${nameOf(t)}${g.tracks.length > 1 ? ` (+${g.tracks.length - 1} more in the ${stem} role)` : ""}`,
      `${d > 0 ? "+" : ""}${d.toFixed(1)} dB against ${ref} (tolerance ±${REF_TOL.level_db} dB)`,
      sev(Math.abs(d) - REF_TOL.level_db, REF_TOL.level_db),
      { target: t, stem, group: g.tracks, delta_db: r2(-d),
        observed: r2(g.share_db), target_value: r2(their) }));
  }

  /* ── the three that depend on the profile's ONSETS ─────────────────── */
  const rk = profile?.kick || {};
  if (!gated) {
    skipped.push("ref_kick_tune / ref_kick_decay / ref_pump: this profile's beat-grid gate "
      + `DECLINED (${rk.grid?.why || "no reason recorded"}), so its onsets are raw flux `
      + "peaks — a fundamental, a decay and a pump measured on those are measurements of "
      + "whatever the detector caught, and no card is built from them");
  } else {
    const ourF0 = Number(measure?.tuning?.f0_hz);
    const theirF0 = Number(rk.f0_hz);
    if (Number.isFinite(ourF0) && Number.isFinite(theirF0) && ourF0 > 0 && theirF0 > 0) {
      /* ── THE OCTAVE IS SHAPE. THE NOTE IS KEY, AND KEY IS NOT SHAPE. ───
       * The first live run of this critic asked to tune a 43.7 Hz kick down
       * 515 cents to meet a reference's 32.4 Hz one. That is very nearly a
       * tritone, and it is not a production difference at all — it is the
       * distance between two songs' KEYS. A profile carries no key, on
       * purpose; the Ear's own `tuning` critic already owns the kick's note,
       * measured against THIS song's root, and the two would have contradicted
       * each other on that mix with equal confidence.
       *
       * What IS comparable across two keys is the REGISTER: a 33 Hz kick and a
       * 48 Hz kick a fifth apart are the same instrument in the same octave,
       * while a 33 Hz kick against a 66 Hz one is a sub-kick against a punchy
       * one — a decision somebody made, and one a tune knob can act on. So the
       * finding is the OCTAVE, rounded, and the leftover cents travel as
       * `residual_cents` explicitly labelled as the part we are NOT asking
       * anyone to change. */
      const octaves = log2(theirF0 / ourF0);
      const register = Math.round(octaves);
      const cents = foldCents(ourF0, theirF0);
      if (Math.abs(octaves) >= REF_TOL.kick_octaves && register !== 0) {
        const semis = register * 12;
        findings.push(F("ref_kick_tune",
          `the kick is ${Math.abs(register)} octave${Math.abs(register) === 1 ? "" : "s"} `
          + `${register < 0 ? "below" : "above"} ${ref}'s — ${ourF0.toFixed(1)} Hz against `
          + `${theirF0.toFixed(1)} Hz, which is a different KIND of kick rather than a `
          + "different note",
          `${nameOf(measure.tuning.track_id)}, the kick's register`,
          `${octaves > 0 ? "+" : ""}${octaves.toFixed(2)} octaves to ${ref} `
          + `(tolerance ±${REF_TOL.kick_octaves}); the ${Math.abs(cents).toFixed(0)} c left `
          + "over is the two songs' keys and is not part of this",
          sev(Math.abs(octaves) - REF_TOL.kick_octaves, REF_TOL.kick_octaves),
          { target: measure.tuning.track_id, patch: measure.tuning.patch,
            knob: measure.tuning.knob, current_knob: measure.tuning.current_knob ?? 0,
            observed: r2(octaves * 1200), target_value: 0,
            octaves: r2(octaves), register, semitones: semis,
            residual_cents: r2(cents), f0_hz: r2(ourF0), ref_f0_hz: r2(theirF0) }));
      } else {
        skipped.push(
          `ref_kick_tune: both kicks are in the same octave (${ourF0.toFixed(1)} Hz here, `
          + `${theirF0.toFixed(1)} Hz in ${ref}). The ${Math.abs(cents).toFixed(0)} cents `
          + "between them is the distance between two songs' KEYS, not a production "
          + "decision — a profile carries no key, and the `tuning` critic already measures "
          + "this kick against THIS song's root.");
      }
    } else {
      skipped.push(`ref_kick_tune: ${Number.isFinite(theirF0)
        ? "no kick could be measured in this window (the tuning critic is what names the track)"
        : `${ref} carries no kick fundamental`}`);
    }

    const ourT = Number(shape?.kick?.t30_ms ?? shape?.kick?.t10_ms);
    const theirT = Number(rk.shape?.t30_ms ?? rk.shape?.t10_ms);
    const which = (shape?.kick?.t30_ms != null && rk.shape?.t30_ms != null) ? "t30" : "t10";
    if (Number.isFinite(ourT) && Number.isFinite(theirT) && ourT > 0 && theirT > 0) {
      const lr = log2(ourT / theirT);
      if (Math.abs(lr) > REF_TOL.decay_ratio) {
        findings.push(F("ref_kick_decay",
          `the kick's tail is ${(ourT / theirT).toFixed(2)}x ${ref}'s — ${ourT.toFixed(0)} ms `
          + `to ${which === "t30" ? "-30" : "-10"} dB against ${theirT.toFixed(0)} ms`,
          `${nameOf(shape.kick_track)}, the kick's decay`,
          `${ourT.toFixed(0)} ms against ${theirT.toFixed(0)} ms (${which}); a ratio past `
          + `${(2 ** REF_TOL.decay_ratio).toFixed(2)}x is worth a move`,
          sev(Math.abs(lr) - REF_TOL.decay_ratio, REF_TOL.decay_ratio),
          { target: shape.kick_track, patch: measure?.tuning?.patch,
            observed: r2(ourT), target_value: r2(theirT), metric_used: which,
            ratio: r2(ourT / theirT) }));
      }
    } else {
      skipped.push("ref_kick_decay: one of the two decays could not be measured "
        + `(ours ${Number.isFinite(ourT) ? `${ourT} ms` : "absent"}, `
        + `${ref} ${Number.isFinite(theirT) ? `${theirT} ms` : "absent"})`);
    }

    const op = shape?.pump, tp = profile?.pump;
    if (op && tp && Number.isFinite(Number(op.depth_db)) && Number.isFinite(Number(tp.depth_db))) {
      const dd = Number(op.depth_db) - Number(tp.depth_db);          // both negative
      const orf = Number(op.recovery_frac_of_beat);
      const trf = Number(tp.recovery_frac_of_beat);
      const df = (Number.isFinite(orf) && Number.isFinite(trf)) ? orf - trf : null;
      if (Math.abs(dd) > REF_TOL.pump_db || (df !== null && Math.abs(df) > REF_TOL.pump_frac)) {
        findings.push(F("ref_pump",
          `the sidechain ducks ${Math.abs(Number(op.depth_db)).toFixed(1)} dB here and `
          + `${Math.abs(Number(tp.depth_db)).toFixed(1)} dB in ${ref}`
          + (df === null ? "" : `, and recovers over ${(orf * 100).toFixed(0)} % of a beat `
            + `against ${(trf * 100).toFixed(0)} %`),
          `${nameOf(shape.pump_track)}, the bass under the kick`,
          `${dd > 0 ? "+" : ""}${dd.toFixed(1)} dB of depth`
          + (df === null ? "" : ` and ${df > 0 ? "+" : ""}${(df * 100).toFixed(0)} % of a beat `
            + "of recovery") + ` against ${ref}`,
          sev(Math.max(Math.abs(dd) - REF_TOL.pump_db,
            df === null ? 0
              : (Math.abs(df) - REF_TOL.pump_frac) * (REF_TOL.pump_db / REF_TOL.pump_frac)),
          REF_TOL.pump_db),
          { target: shape.pump_track, against: measure?.tuning?.track_id ?? null,
            observed: r2(Number(op.depth_db)), target_value: r2(Number(tp.depth_db)),
            depth_delta_db: r2(dd),
            recovery_ms: op.recovery_ms ?? null, ref_recovery_ms: tp.recovery_ms ?? null,
            recovery_frac: Number.isFinite(orf) ? r2(orf) : null,
            ref_recovery_frac: Number.isFinite(trf) ? r2(trf) : null,
            beat_s: op.beat_s ?? null }));
      }
    } else if (!shape?.available) {
      skipped.push("ref_pump / ref_kick_decay: this critique ran without `ear.shape`, so our "
        + "own decay and pump were never measured — naming a profile switches it on");
    } else {
      skipped.push(`ref_pump: ${tp ? "no pump could be measured here" : `${ref} has no pump measurement`}`
        + (shape?.pump_absent_because ? ` (${shape.pump_absent_because})` : ""));
    }
  }

  /* ── ref_width: side over mid, per band, worst band only ───────────── */
  const ourW = shape?.width_per_band || [];
  const refW = profile?.master?.width_per_band || [];
  if (ourW.length === refW.length && refW.length) {
    let worst = null;
    for (let b = 0; b < refW.length; b++) {
      const o = Number(ourW[b].side_over_mid_db);
      const t = Number(refW[b].side_over_mid_db);
      if (!Number.isFinite(o) || !Number.isFinite(t)) continue;
      if (ourBands[b]?.absent) continue;
      const d = o - t;
      if (Math.abs(d) > REF_TOL.width_db && (!worst || Math.abs(d) > Math.abs(worst.d))) {
        worst = { b, d, o, t };
      }
    }
    if (worst) {
      const dual = measure?.stereo?.width === 0;
      findings.push(F("ref_width",
        `the image in ${BAND_LABELS[worst.b]} (${BAND_NAMES[worst.b]}) is `
        + `${Math.abs(worst.d).toFixed(1)} dB ${worst.d > 0 ? "wider" : "narrower"} than ${ref}'s`,
        `master, ${BAND_LABELS[worst.b]}`,
        `side-over-mid ${worst.o.toFixed(1)} dB against ${worst.t.toFixed(1)} dB in ${ref}`,
        sev(Math.abs(worst.d) - REF_TOL.width_db, REF_TOL.width_db),
        { target: "master", band: BAND_LABELS[worst.b], band_index: worst.b,
          observed: r2(worst.o), target_value: r2(worst.t), delta_db: r2(worst.d),
          direction: dual ? "dual_mono" : (worst.d > 0 ? "too_wide" : "too_narrow"),
          dual_mono: dual }));
    } else {
      skipped.push(`ref_width: every band's image is within ${REF_TOL.width_db} dB of ${ref}`);
    }
  } else if (!shape?.available) {
    skipped.push("ref_width: this critique ran without `ear.shape`, so no per-band width "
      + "was measured on our side");
  }

  /* The same content-derived id every other finding carries, so the A/B guard
   * and the taste profile recognise one finding across two iterations. */
  for (const f of findings) {
    f.id = [f.metric, f.target ?? "-", f.stem ?? "-", f.band ?? "-", "-", "-"].join(":");
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, skipped };
}

/* ════════════════════════════════════════════════════════════════════════
 * THE QUESTION CARDS (SPEC D1.8.1)
 * ══════════════════════════════════════════════════════════════════════ */

export const CARD_CAP = 5;   // D1.8.3 rule 2 — a wall of cards is rubber-stamping

export function buildCards(findings, ctx, opts = {}) {
  const cards = [];
  const notes = [];
  const cap = Math.max(1, Math.min(Number(opts.maxCards) || CARD_CAP, 12));
  for (const f of findings) {
    const m = mapFinding(f, ctx);
    /* `note` present (even as null) means the mapping DELIBERATELY declined to
     * build a card: either there is exactly one honest move, or — the null
     * case — there is no edit that would honestly help at all. Both are
     * reported; neither is dressed up as a choice. */
    if ("note" in m) {
      notes.push({
        id: f.id, metric: f.metric, observation: f.what, where: f.where,
        how_much: f.how_much, severity: f.severity, op: m.note ?? null, why: m.why,
        why_not_a_card: m.why_not_a_card ?? (m.note
          ? "only one honest route exists — a one-option card is a confirmation "
            + "dialog, and a confirmation dialog is not a creative choice"
          : "no edit would honestly help here, so none is offered"),
      });
      continue;
    }
    const routes = (m.routes || []).filter((r) => r?.op?.tool && r.op.args);
    if (routes.length < 2) {
      // The rule from the brief, applied without exception.
      notes.push({
        id: f.id, metric: f.metric, observation: f.what, where: f.where,
        how_much: f.how_much, severity: f.severity,
        op: routes[0]?.op ?? null,
        why_not_a_card: routes.length
          ? "only one route could be built for this finding"
          : "no concrete edit could be named for this finding, so it is not shipped as a card",
      });
      continue;
    }
    cards.push({
      id: f.id,
      metric: f.metric,
      severity: f.severity,
      confidence: f.confidence,
      observation: f.what,
      where: f.where,
      how_much: f.how_much,
      measured: { observed: f.observed, target: f.target_value },
      routes: routes.map((r) => ({ id: r.id, text: r.text, why: r.why, op: r.op })),
      free_text: {
        allowed: true,
        prompt: "your own direction…",
        note: "written in your words, recorded verbatim — it ranks above any menu pick",
      },
      skip: { allowed: true, note: "declining to decide is not logged as a decision" },
      finding: f,
    });
  }
  return { cards: cards.slice(0, cap), notes, over_cap: Math.max(0, cards.length - cap) };
}

/* ════════════════════════════════════════════════════════════════════════
 * THE A/B GUARD (§11d convergence guard)
 * ══════════════════════════════════════════════════════════════════════ */

export const AB_EPSILON = 0.05;    // dB of penalty; below this it is noise
export const ITERATION_CAP = 3;

/**
 * Did that edit help? Compares the objective penalty (lower is better) and,
 * where the finding maps onto one of its parts, that part specifically.
 *
 * Three verdicts, and the middle one is the honest one nobody writes:
 *   keep     the penalty fell
 *   revert   the penalty rose past the epsilon — the edit made it worse
 *   traded   the targeted metric improved but something else got worse by
 *            more; kept ONLY when the total still improved, otherwise revert
 */
export function abVerdict(before, after, finding, opts = {}) {
  const eps = Number(opts.epsilon ?? AB_EPSILON);
  const b = Number(before?.penalty_db ?? 0);
  const a = Number(after?.penalty_db ?? 0);
  const part = { masking: "masking", balance: "balance", lufs: "lufs",
                 true_peak: "true_peak", clipping: "clipping",
                 dynamics: "crest" }[finding?.metric] || null;
  const pb = part ? Number(before?.parts?.[part] ?? 0) : null;
  const pa = part ? Number(after?.parts?.[part] ?? 0) : null;
  const total = r2(b - a);                       // positive = improvement
  const targeted = part ? r2(pb - pa) : null;

  /* ── §7: A REFERENCE MOVE IS ALLOWED TO COST OBJECTIVE PENALTY ──────
   * The guard's premise is that the objective score is what "better" means.
   * For a reference match it is not: the human asked for a mix that sits like
   * a named record, and that record is not pink. So a ref_* edit that raises
   * the penalty is KEPT and reported as a trade, naming both sides —
   * reverting it would silently undo the thing that was asked for and report
   * it as a safety net.
   *
   * With ONE exception, and it is not about taste: a card may never make the
   * file clip or break the true-peak ceiling. Those two still revert, because
   * a reference is a target for the balance and never a licence to ship a
   * damaged file. */
  if (String(finding?.metric || "").startsWith("ref_")) {
    const dmg = ["clipping", "true_peak"]
      .map((k) => [k, Number(before?.parts?.[k] ?? 0), Number(after?.parts?.[k] ?? 0)])
      .filter(([, pb0, pa0]) => pa0 > pb0 + eps);
    if (dmg.length) {
      return { verdict: "revert", total_improvement_db: total,
               targeted_improvement_db: targeted, part: dmg[0][0], reference: true,
               reason: `${dmg[0][0]} got worse (${r2(dmg[0][1])} → ${r2(dmg[0][2])} dB of `
                 + "penalty). A reference is a target for the balance, never a licence to "
                 + "ship a file that clips — so this is reverted whatever it did for the "
                 + "match" };
    }
    if (a > b + eps) {
      return { verdict: "traded", total_improvement_db: total,
               targeted_improvement_db: targeted, part, reference: true,
               reason: `the objective penalty rose from ${r2(b)} to ${r2(a)} dB — kept, `
                 + "because this edit was asked for against a REFERENCE, and a reference is "
                 + "not the pink curve the objective score is measured against. Moving "
                 + "toward one and away from the other is the trade, not a regression" };
    }
  }

  if (a > b + eps) {
    return { verdict: "revert", total_improvement_db: total,
             targeted_improvement_db: targeted, part,
             reason: `the objective penalty rose from ${r2(b)} to ${r2(a)} dB — `
               + "this edit made the mix measurably worse" };
  }
  if (part && targeted !== null && targeted < -eps) {
    return { verdict: "traded", total_improvement_db: total,
             targeted_improvement_db: targeted, part,
             reason: `${part} got worse by ${Math.abs(targeted)} dB but the mix as a `
               + `whole improved by ${total} dB — kept, and reported as a trade` };
  }
  if (Math.abs(total) <= eps) {
    return { verdict: "keep", total_improvement_db: total,
             targeted_improvement_db: targeted, part, neutral: true,
             reason: "no measurable change either way — kept, because the human asked for it" };
  }
  return { verdict: "keep", total_improvement_db: total,
           targeted_improvement_db: targeted, part,
           reason: `the objective penalty fell from ${r2(b)} to ${r2(a)} dB` };
}

/**
 * Apply one route, measure, and undo it if it made things worse.
 *
 * `io` is injected so the whole guard — including the revert — is testable
 * without a server: { applyOp(op) -> result, undoFor(op, result) -> op|null,
 * measure() -> score }.
 */
export async function applyWithGuard(route, finding, io, opts = {}) {
  const before = opts.before ?? await io.measure();
  const result = await io.applyOp(route.op);
  const undo = await io.undoFor(route.op, result);
  let after = null, verdict = null, reverted = false;
  try {
    after = await io.measure();
    verdict = abVerdict(before, after, finding, opts);
  } catch (err) {
    verdict = { verdict: "revert", reason: `could not re-measure: ${err.message}` };
  }
  if (verdict.verdict === "revert" && undo) {
    await io.applyOp(undo);
    reverted = true;
    after = await io.measure().catch(() => after);
  } else if (verdict.verdict === "revert" && !undo) {
    verdict = { ...verdict, verdict: "kept_unrevertable",
                reason: `${verdict.reason} — but no undo could be built for this op, `
                  + "so it stands and is reported" };
  }
  return { op: route.op, result, undo, before, after, ...verdict, reverted };
}

/* ════════════════════════════════════════════════════════════════════════
 * THE TASTE PROFILE (§11e)
 *
 * A fold over the human's own decisions. The ledger stays the truth (SPEC
 * D1.8.5); this JSON is a DERIVED CACHE, rebuildable from the `choice` and
 * `judge` events, readable and resettable by the human, and it never leaves
 * the machine. It biases ORDER and auto-apply permission. It never invents a
 * finding, never suppresses a measurement, and never changes what was
 * measured — a metric the human always rejects still gets measured, still
 * gets shown, and simply stops being ranked first or auto-applied.
 * ══════════════════════════════════════════════════════════════════════ */

export const TASTE_PRIOR = 5;        // Beta(5,5): neutral until ~10 observations
export const AUTO_BLOCK_REJECTS = 3; // rejected this often with no accepts → no auto-apply

export const neutralProfile = () => ({
  v: 1, createdAt: new Date().toISOString(), updatedAt: null,
  observations: 0, metrics: {}, overrides: {},
  note: "Derived from your own accept/reject/override decisions. Neutral until "
    + "about ten of them. Rebuildable from the provenance ledger; resettable; "
    + "never transmitted anywhere.",
});

const key = (metric, genre) => `${genre || "neutral"}|${metric}`;

/** One decision in. `action` is accept | reject | override | skip. */
export function foldFeedback(profile, { metric, genre, action, deltaDb, severity }) {
  const p = { ...profile, metrics: { ...profile.metrics }, overrides: { ...profile.overrides } };
  const k = key(metric, genre);
  const row = { accepted: 0, rejected: 0, overridden: 0, skipped: 0, ...(p.metrics[k] || {}) };
  if (action === "accept") row.accepted++;
  else if (action === "reject") row.rejected++;
  else if (action === "override") { row.overridden++; row.rejected++; }
  else if (action === "skip") row.skipped++;
  else throw new Error(`unknown taste action "${action}" — accept, reject, override or skip`);
  row.lastSeverity = severity ?? row.lastSeverity ?? null;
  p.metrics[k] = row;
  if (action === "override" && Number.isFinite(Number(deltaDb))) {
    const o = { sum: 0, n: 0, ...(p.overrides[k] || {}) };
    o.sum += Number(deltaDb); o.n += 1;
    o.mean = r2(o.sum / o.n);
    p.overrides[k] = o;
  }
  if (action !== "skip") p.observations = (p.observations || 0) + 1;
  p.updatedAt = new Date().toISOString();
  return p;
}

/** Acceptance rate, shrunk to 0.5 by a Beta(5,5) prior. */
export function profileWeight(profile, metric, genre) {
  const row = profile?.metrics?.[key(metric, genre)];
  const a = row?.accepted || 0, b = row?.rejected || 0;
  return (TASTE_PRIOR + a) / (2 * TASTE_PRIOR + a + b);
}

/** Never auto-applied after three rejections with nothing accepted — still
 *  measured, still shown, per §11e. */
export function autoAllowed(profile, metric, genre) {
  const row = profile?.metrics?.[key(metric, genre)];
  if (!row) return true;
  return !(row.rejected >= AUTO_BLOCK_REJECTS && (row.accepted || 0) === 0);
}

/** The human's own consistent override, once there is enough of it to mean
 *  something. Reported always; APPLIED only where the target is a scalar we
 *  can honestly shift (loudness). */
export function targetShift(profile, metric, genre, minN = 3) {
  const o = profile?.overrides?.[key(metric, genre)];
  return o && o.n >= minN ? o.mean : null;
}

export function shiftedTargets(profile, genre, base = {}) {
  const out = { ...base };
  const s = targetShift(profile, "lufs", genre);
  if (s !== null) out.lufs = r2((base.lufs ?? -14) + s);
  return out;
}

const SEV_RANK = { high: 3, medium: 2, low: 1 };
/** What a finding is worth in the objective penalty when it has no direct
 *  term there (width, level, dc) — the severity, in the penalty's units. */
const SEV_PENALTY = { high: 6, medium: 3, low: 1 };

/**
 * What fixing this finding is WORTH, in the same dB-of-penalty units the A/B
 * guard measures in. The mirror of ear.py's objective_score, per finding.
 *
 * Ranking by this rather than by severity alone is what stops the stack being
 * ordered alphabetically inside a severity tier — which is what happened in
 * the first live run: five `high` cards, and the loop spent two of its three
 * iterations on the two whose ids sorted first rather than the two that were
 * worth the most.
 */
export function findingPenalty(finding, targets = {}) {
  const T = { lufs: -14, lufs_tolerance: 1, true_peak_db: -1, band_tolerance: 3,
              masking_margin_db: 6, crest_low_db: 6, ...targets };
  const o = Number(finding?.observed);
  switch (finding?.metric) {
    case "lufs":
      return Number.isFinite(o) ? Math.max(0, Math.abs(o - T.lufs) - T.lufs_tolerance) : 0;
    case "loudness_target": {
      /* Against the target the CARD quotes (project / genre), not T.lufs. */
      const tgt = Number(finding.target_value);
      return Number.isFinite(o) && Number.isFinite(tgt)
        ? Math.max(0, Math.abs(o - tgt) - T.lufs_tolerance) : 0;
    }
    case "tuning":
      /* Cents over the tolerance, in the penalty's dB-ish units: 166 c off
       * the root (the shipped kick) weighs about like a 6 dB level error. */
      return Number.isFinite(o) ? Math.max(0, (Math.abs(o) - 30) / 25) : 0;
    case "true_peak":
      return Number.isFinite(o) ? Math.max(0, o - T.true_peak_db) * 2 : 0;
    case "clipping":
      return Number.isFinite(o) ? 0.4 * Math.min(o, 100) : 0;
    case "dynamics":
      return finding.direction === "too_compressed" && Number.isFinite(o)
        ? Math.max(0, T.crest_low_db - o) : SEV_PENALTY[finding.severity] ?? 1;
    case "balance":
      return finding.boostable === false ? 0
        : (Number.isFinite(o) ? Math.max(0, Math.abs(o) - T.band_tolerance) : 0);
    case "masking":
      return Number.isFinite(o) ? Math.max(0, o - T.masking_margin_db) : 0;

    /* ── §7 — and DELIBERATELY LIGHTER THAN THE OBJECTIVE CRITICS ──────
     * Every one of these is scaled below the metric it resembles, because
     * being 3 dB off pink is a measurement and being 3 dB off somebody's
     * record is a preference. Without the weights a reference match would
     * out-rank clipping, and a stack of cards whose top item is a taste
     * question is a stack people stop reading. */
    case "ref_bands":
      return 0.6 * Math.max(0, Math.abs(Number(finding.delta_db) || 0) - REF_TOL.band_db);
    case "ref_level":
      return 0.6 * Math.max(0, Math.abs(Number(finding.delta_db) || 0) - REF_TOL.level_db);
    case "ref_width":
      return 0.4 * Math.max(0, Math.abs(Number(finding.delta_db) || 0) - REF_TOL.width_db);
    case "ref_kick_tune":
      /* `observed` is cents of REGISTER (a whole octave is 1200), so an octave
       * out weighs about like a 12 dB level error — which is roughly what it
       * sounds like. */
      return Number.isFinite(o)
        ? 0.6 * Math.max(0, (Math.abs(o) / 1200 - REF_TOL.kick_octaves) * 20) : 0;
    case "ref_kick_decay": {
      const rr = Number(finding.ratio);
      return rr > 0
        ? 0.6 * Math.max(0, (Math.abs(Math.log(rr) / Math.LN2) - REF_TOL.decay_ratio) * 6) : 0;
    }
    case "ref_pump":
      return 0.6 * Math.max(0, Math.abs(Number(finding.depth_delta_db) || 0) - REF_TOL.pump_db);

    default:
      return SEV_PENALTY[finding?.severity] ?? 1;
  }
}

/**
 * Order the stack: what the fix is WORTH objectively, weighted by how much
 * this human has historically cared about that metric, and by how sure the
 * critic is. Stable and explainable — every card carries the `rank_reason`
 * that produced its place, so nobody has to trust the sort.
 */
export function rankCards(cards, profile, genre, targets = {}) {
  return cards
    .map((c) => {
      const w = profileWeight(profile, c.metric, genre);
      const worth = Math.max(findingPenalty(c.finding ?? c, targets),
                             SEV_PENALTY[c.severity] ?? 1);
      const score = worth * (0.5 + w) * (0.5 + (c.confidence ?? 1) / 2);
      return { ...c, taste_weight: r2(w), worth_db: r2(worth),
               rank_score: Math.round(score * 1000) / 1000,
               auto_allowed: autoAllowed(profile, c.metric, genre),
               rank_reason: `worth about ${r2(worth)} dB of the mix's objective penalty; `
                 + `severity ${c.severity}; you have accepted ${Math.round(w * 100)}% `
                 + `of ${c.metric} notes so far` };
    })
    .sort((a, b) => b.rank_score - a.rank_score
      || SEV_RANK[b.severity] - SEV_RANK[a.severity]
      || a.id.localeCompare(b.id));
}

/* ════════════════════════════════════════════════════════════════════════
 * PROVENANCE (SPEC D1.2 / D1.8.2 / D1.8.4)
 *
 * Four event builders, and the actor rule is enforced HERE rather than
 * trusted at the call site: `choice` refuses a non-user actor, `judge`
 * refuses a user actor. There is no argument you can pass that makes an
 * agent decision look like a human one.
 *
 * ⚠ AND NO ARGUMENT YOU CAN *OMIT*, EITHER — which is the half that was
 * missing. `choice`, `delegate` and `approve` each used to fall back to
 * `user` when the caller said nothing, so the guards above only ever fired
 * for a caller honest enough to name itself. A caller that names nobody is
 * the textbook unattributable case, and D1.0 sends that to `system` and
 * NEVER to a person. Every builder here now defaults to `system` and refuses
 * it, so the stamp has to come from the door — `actorOf(req)`, which is
 * prov.actorFrom — and an omission is a thrown error rather than a fabricated
 * human act. (On the `edit` type the same fabrication is what promotes
 * ai-generated to ai-assisted-human-edited in foldOrigin; these four types
 * fold to nothing, but they are what the dossier reads to say a person
 * deliberated, chose, and listened.)
 * ══════════════════════════════════════════════════════════════════════ */

export function choiceEvent({ asset, card, chosen, rejected, freeText, reasoning,
                              decideMs, mode = "individual", loopRun, iteration,
                              reviews, verdict, actor = "system" }) {
  /* ⚠ `system`, not `user` — see the note above. Must not go back. */
  if (actor !== "user") {
    throw new Error(
      "a `choice` event is a HUMAN decision; an agent's decision is a `judge` "
      + "event with actor agent:ear (SPEC D1.0). This is not configurable. "
      + `(Got "${actor}". Stamp the actor from the request — a caller that `
      + "names nobody is `system`, and `system` did not deliberate.)");
  }
  if (!["individual", "bulk", "review"].includes(mode)) {
    throw new Error(`unknown choice mode "${mode}" — individual, bulk or review`);
  }
  return {
    // Provably "user": the guard above is the only way to reach this line.
    actor, type: "choice", asset,
    data: {
      surface: "ear", loopRun, iteration,
      card: { observation: card.observation, where: card.where,
              how_much: card.how_much, metric: card.metric,
              options: (card.routes || []).map((r) => ({ id: r.id, text: r.text })) },
      chosen: chosen ?? null,
      rejected: rejected ?? (card.routes || [])
        .map((r) => r.id).filter((id) => id !== chosen),
      freeText: freeText ?? null,
      reasoning: reasoning ?? null,
      decideMs: Number.isFinite(Number(decideMs)) ? Number(decideMs) : null,
      mode,
      ...(reviews ? { reviews } : {}),
      ...(verdict ? { verdict } : {}),
    },
  };
}

export function judgeEvent({ asset, card, chosen, rejected, loopRun, iteration,
                             delegatedBy, why, actor = "agent:ear" }) {
  if (!String(actor).startsWith("agent:")) {
    throw new Error("a `judge` event is the machine's own verdict — its actor must be agent:*");
  }
  if (!delegatedBy) {
    throw new Error(
      "an auto-progressed decision must name the `delegate` event that authorised "
      + "it — an unattributed machine decision has no place in the ledger.");
  }
  return {
    actor, type: "judge", asset,
    data: {
      surface: "ear", loopRun, iteration, delegatedBy,
      subject: card.id, criteria: card.metric,
      card: { observation: card.observation, where: card.where,
              how_much: card.how_much, metric: card.metric,
              options: (card.routes || []).map((r) => ({ id: r.id, text: r.text })) },
      verdict: chosen ?? null,
      chosen: chosen ?? null,
      rejected: rejected ?? (card.routes || [])
        .map((r) => r.id).filter((id) => id !== chosen),
      why: why ?? null,
    },
  };
}

/**
 * The human's decision to hand the wheel over — direction-setting, and real
 * contribution (R5.4's conception stage).
 *
 * The actor is stamped from the API boundary, NOT assumed: a delegation typed
 * into the browser is `user`; a delegation arriving over MCP is the calling
 * agent RELAYING the human's brief, and is recorded as that agent with
 * `relayed: true`. Recording an MCP-relayed delegation as a direct human act
 * would be exactly the fabrication D1.0 forbids — and the honest version still
 * carries the human's words verbatim, which is the part that has weight.
 *
 * ⚠ THE DEFAULT IS `system`, AND MUST NOT GO BACK TO `user`. "Stamped from the
 * API boundary, NOT assumed" is what the paragraph above promises, and a
 * fallback to `user` was the assumption — it let a caller with no `req` in
 * reach mint the one event that AUTHORISES a whole auto run. Every `judge`
 * event in that run then points back at a delegation no human gave.
 */
export function delegateEvent({ asset, brief, scope, loopRun, iterations, actor = "system" }) {
  if (!brief || !String(brief).trim()) {
    throw new Error(
      "delegation needs the human's brief in their own words — it is the "
      + "direction-setting the dossier records as their contribution.");
  }
  if (actor !== "user" && !String(actor).startsWith("agent:")) {
    throw new Error(
      `illegal delegate actor "${actor}" — user or agent:*. A delegation is a `
      + "human handing the wheel over; stamp the actor from the request rather "
      + "than letting an unattributable caller become the person (SPEC D1.0).");
  }
  return {
    actor, type: "delegate", asset,
    data: { surface: "ear", loopRun, brief: String(brief), scope: scope ?? null,
            iterations: Number(iterations) || ITERATION_CAP,
            ...(actor === "user" ? {} : { relayed: true }) },
  };
}

/**
 * The final approval, after listening.
 *
 * ⚠ THE ACTOR IS A PARAMETER NOW, DEFAULTING TO `system`, AND MUST NOT GO BACK
 * TO A HARDCODED `user`. This builder used to stamp `user` with no way to say
 * anything else, so it was the one of the four whose honesty rested ENTIRELY on
 * its single call site checking the door first — precisely the "trusted at the
 * call site" arrangement the note at the top of this section says this module
 * refuses. It is also the strongest human claim the ledger carries: somebody
 * sat and listened to the whole thing. Nothing should be able to write that
 * down on a person's behalf.
 */
export function approveEvent({ asset, loopRun, subjectHash, sessionSeconds, note,
                               actor = "system" }) {
  if (actor !== "user") {
    throw new Error(
      `an \`approve\` event is the human's act of LISTENING (SPEC D1.0); "${actor}" `
      + "cannot approve on their behalf, and a caller that names nobody is "
      + "`system`, which has no ears. Stamp the actor from the request.");
  }
  return {
    // Provably "user": the guard above is the only way to reach this line.
    actor, type: "approve", asset,
    data: { surface: "ear", loopRun, subjectHash: subjectHash ?? null,
            sessionSeconds: Number(sessionSeconds) || 0, note: note ?? null },
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * THE ROUTES
 * ══════════════════════════════════════════════════════════════════════ */

/* §7 THE REFERENCE PROFILE, read (never written) from here: a critique that
 * names a profile matches against it. Optional exactly as routes.js mounts it
 * — a tree without the module answers "this tree has no refprofile.js" if a
 * profile is named, and is otherwise unaffected. */
const refprofile = await import("./refprofile.js").catch((err) => {
  if (err?.code !== "ERR_MODULE_NOT_FOUND" || !/refprofile\.js/.test(String(err.message))) {
    console.error(`  [ear] server/daw/refprofile.js is present but failed to load: ${err?.message}`);
  }
  return null;
});

export function createEarRoutes(deps) {
  const { json, readBody, config } = deps;
  const prov = deps.provenance ?? null;
  const spawnPython = deps.spawnPython
    ?? ((args, opts = {}) => spawn(config.python, args, { windowsHide: true, ...opts }));
  /* A judge may live in its OWN venv — installing an aesthetic model into the
   * shared ComfyUI venv is a production side effect this feature must not
   * have (the same rule that kept pyloudnorm out of rack.py). */
  const judgePython = process.env.AIPLAY_EAR_PY || config.python;

  const provScope = (slug) => ({ dir: projectDir(slug) });
  const earDir = (slug) => path.join(projectDir(slug), "ear");
  const tastePath = () => path.join(config.paths.appData, "daw", "ear_taste.json");
  const actorOf = (req) => (prov ? prov.actorFrom(req) : "system");
  const safe = (v) => {
    const s = path.basename(String(v ?? ""));
    return s && !s.includes("..") ? s : null;
  };
  const provNote = async (slug, evt) => {
    if (!prov) return null;
    try { return await prov.append(provScope(slug), evt); } catch (err) {
      // Loud, never silent: a compliance layer that fails quietly is not one.
      console.error(`  [ear] provenance event LOST (${evt?.type}): ${err.message}`);
      return null;
    }
  };

  /* ── the MCP tools, used as tools ─────────────────────────────────────
   * The mapping promises "daw_insert with these args". The applier does not
   * translate that into a route call — it CALLS daw_insert. Same code path
   * an agent takes, so the card cannot promise a call the tool would refuse. */
  const BASE = `http://127.0.0.1:${config.uiPort}`;
  const post = async (body) => {
    const r = await fetch(`${BASE}/api/daw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "agent:ear" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
    if (j.error) throw new Error(j.error);
    return j;
  };
  const getJson = async (p) => {
    const r = await fetch(`${BASE}${p}`, { headers: { "x-aiplay-actor": "agent:ear" } });
    const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
    if (j.error) throw new Error(j.error);
    return j;
  };
  /* daw_set_track joins the rack's three: the tuning card's routes turn a
   * kick's own knob (hybrid_kick.tune) — an instrument edit, not a mixer
   * one. Built from the same dawTools() the MCP server exposes, over the
   * same HTTP door, so the card cannot promise a call the tool would refuse. */
  const SET_TRACK = dawTools(
    (method, p, body) => (method === "POST" && p === "/api/daw" ? post(body) : getJson(p)),
    (s) => safe(s),
  ).find((t) => t.name === "daw_set_track");
  const TOOLS = Object.fromEntries([
    ...rackTools({
      daw: (body) => post({ ...body, by: "agent" }),
      get: getJson,
      slugOf: (s) => safe(s),
    }),
    ...(SET_TRACK ? [SET_TRACK] : []),
  ].map((t) => [t.name, t]));

  const applyOp = async (op) => {
    const tool = TOOLS[op.tool];
    if (!tool) {
      throw new Error(`the Ear proposed "${op.tool}", which is not a tool it can call. `
        + `It can call: ${Object.keys(TOOLS).join(", ")}.`);
    }
    return tool.run(op.args);
  };

  /** The inverse of an op, built from the document BEFORE it was applied. */
  async function undoBuilder(slug) {
    const before = await readProject(slug);
    return (op, result) => {
      const a = op.args || {};
      if (op.tool === "daw_insert" && a.op === "add" && result?.insert_id) {
        return { tool: "daw_insert",
                 args: { op: "remove", slug: a.slug, target: a.target, insert: result.insert_id } };
      }
      if (op.tool === "daw_insert" && a.op === "set") {
        const ins = chainOf(before, a.target).find((i) => i.id === a.insert);
        if (!ins) return null;
        const params = {};
        for (const k of Object.keys(a.params || {})) params[k] = ins.params?.[k];
        return { tool: "daw_insert",
                 args: { op: "set", slug: a.slug, target: a.target, insert: a.insert, params } };
      }
      if (op.tool === "daw_set_track" && a.params) {
        /* Restore each knob to what the track held, or to the patch's own
         * default when it held nothing (normParams drops defaults on write,
         * so "absent" and "default" are the same value). A knob with no
         * default we can name is unrevertable — reported, never faked. */
        const tr = (before.tracks || []).find((x) => x.id === a.track || x.name === a.track);
        if (!tr) return null;
        const params = {};
        for (const k of Object.keys(a.params)) {
          const prev = tr.instrument?.params?.[k];
          const def = PATCHES[tr.instrument?.patch]?.params?.[k]?.default
            ?? (k === "transpose" || k === "gain_db" ? 0 : undefined);
          if (prev === undefined && def === undefined) return null;
          params[k] = prev !== undefined ? prev : def;
        }
        return { tool: "daw_set_track", args: { slug: a.slug, track: a.track, params } };
      }
      if (op.tool === "daw_mixer" && a.op === "set") {
        const args = { op: "set", slug: a.slug, target: a.target };
        if (a.fader !== undefined) {
          if (faderIsAutomated(before, a.target)) return null;   // never flatten a curve
          args.fader = faderOf(before, a.target);
        }
        if (a.pan !== undefined) {
          const host = (before.tracks || []).find((x) => x.id === a.target)
            || (before.returns || []).find((x) => x.id === a.target);
          if (host && typeof host.pan === "object") return null;
          args.pan = typeof host?.pan === "number" ? host.pan : 0;
        }
        return { tool: "daw_mixer", args };
      }
      return null;
    };
  }

  /* ── the python side ─────────────────────────────────────────────────── */

  /** One-shot: `ear.py serve`, one request, one reply, child exits. Simple
   *  and robust — the Ear runs seconds-to-minutes per call, not per keystroke,
   *  so a persistent lane would buy nothing and cost a process to babysit. */
  function earCall(cmd, job, timeoutMs = 600_000, pythonPath = null) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = pythonPath
          ? spawn(pythonPath, [EAR_PY, "serve"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
          : spawnPython([EAR_PY, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) { return reject(err); }
      let out = "", errTail = "", done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } fn(v); };
      const timer = setTimeout(() => finish(reject,
        new Error(`the Ear did not answer in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      child.stdout.on("data", (d) => {
        out += d.toString();
        const lines = out.split(/\r?\n/);
        out = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          let m; try { m = JSON.parse(l); } catch { continue; }
          if (m.ready) { child.stdin.write(JSON.stringify({ id: 1, cmd, job }) + "\n"); continue; }
          if (m.ok === false) return finish(reject, new Error(m.error || "ear failed"));
          return finish(resolve, m);
        }
      });
      child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-2000); });
      child.on("error", (err) => finish(reject, err));
      child.on("exit", (code) => finish(reject, new Error(
        `the Ear's python exited (${code}). ${errTail.trim().split("\n").slice(-3).join(" ") || ""}`.trim())));
    });
  }

  /* ── the analysis job: the SAME payload a render/meters call would build ─
   * buildAnalysisJob lives at module level (exported, pure: document in,
   * job out) so ear_test.js can pin what it carries without a disk.
   *
   * [DAWREC] The slug rides in `opts` because the clips' paths are built
   * under the project's audio directory — it is the one thing the document
   * alone cannot supply, and buildAnalysisJob REFUSES rather than quietly
   * dropping the takes when a clip needs it and it is not there. */

  async function analysisJob(slug, fromBar, toBar, opts = {}) {
    const doc = await readProject(slug);
    if (!doc) throw new Error(`No such project: ${slug}`);
    return buildAnalysisJob(doc, fromBar, toBar, { ...opts, slug });
  }

  /* ── run persistence ───────────────────────────────────────────────── */

  const runPath = (slug, id) => path.join(earDir(slug), `run-${id}.json`);
  async function saveRun(slug, run) {
    await mkdir(earDir(slug), { recursive: true });
    await writeFile(runPath(slug, run.id), JSON.stringify(run, null, 2), "utf8");
    return run;
  }
  async function loadRun(slug, id) {
    try { return JSON.parse(await readFile(runPath(slug, safe(id)), "utf8")); }
    catch { throw new Error(`No such Ear run "${id}" on ${slug}. Start one with action "critique".`); }
  }
  async function listRuns(slug) {
    try {
      const files = await readdir(earDir(slug));
      const out = [];
      for (const f of files.filter((x) => /^run-.+\.json$/.test(x))) {
        try {
          const r = JSON.parse(await readFile(path.join(earDir(slug), f), "utf8"));
          out.push({ id: r.id, at: r.startedAt, mode: r.mode, iterations: r.iterations?.length || 0,
                     cards: r.cards?.length || 0, answered: (r.answers || []).length,
                     approved: !!r.approvedAt });
        } catch { /* a half-written run is not worth a 500 */ }
      }
      return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    } catch { return []; }
  }

  /* ── the taste profile on disk ─────────────────────────────────────── */

  async function readTaste() {
    try {
      const p = JSON.parse(await readFile(tastePath(), "utf8"));
      return { ...neutralProfile(), ...p, metrics: p.metrics || {}, overrides: p.overrides || {} };
    } catch { return neutralProfile(); }
  }
  async function writeTaste(p) {
    await mkdir(path.dirname(tastePath()), { recursive: true });
    await writeFile(tastePath(), JSON.stringify(p, null, 2), "utf8");
    return p;
  }

  /* ── the critique pass ─────────────────────────────────────────────── */

  async function critique(slug, body) {
    const profile = await readTaste();
    const genre = body.genre || "neutral";
    /* §7 — the reference, when one was named. It is loaded BEFORE the render,
     * because it decides whether the analysis measures our own shape at all:
     * `ear.shape` is off by default and a critique with no profile should not
     * pay for a measurement nothing will read. A name that is not on this
     * machine is refused here rather than silently critiquing without it. */
    const refName = body.profile ?? body.reference_profile ?? null;
    let ref = null;
    if (refName) {
      if (!refprofile?.readProfile) {
        throw new Error(
          "This tree has no server/daw/refprofile.js, so a reference profile cannot be "
          + "read. Drop the `profile` argument to critique without one.");
      }
      ref = await refprofile.readProfile(refName);
      if (!ref) {
        const have = (await refprofile.listProfiles().catch(() => [])).map((p) => p.id);
        throw new Error(
          `No reference profile "${refName}" on this machine.`
          + (have.length ? ` There ${have.length === 1 ? "is" : "are"}: ${have.join(", ")}.`
            : " There are none yet — build one with action \"profile_build\"."));
      }
    }
    const { doc, fromBar, toBar, job, earOpts } = await analysisJob(slug, body.from_bar, body.to_bar, {
      genre, roles: body.roles, targets: body.track_targets,
      targetOverrides: shiftedTargets(profile, genre, { lufs: -14, ...(body.targets || {}) }),
      root: body.key ?? body.root, targetLufs: body.target_lufs, delivery: body.delivery,
      shape: !!ref,
    });
    const r = await earCall("analyse", job);
    const nameOf = (id) => (doc.tracks || []).find((t) => t.id === id)?.name || id;
    const ctx = { doc, slug, measure: r.measure, nameOf };
    /* The reference's findings join the objective ones and are then ranked
     * and capped with them — one stack, one order, one cap. They are NOT a
     * second list with its own cap, because two stacks is how the second one
     * stops being read. */
    let reference = null;
    if (ref) {
      const rf = referenceFindings(ref, r.measure, { doc, nameOf, roles: body.roles });
      r.findings = [...r.findings, ...rf.findings];
      reference = {
        id: ref.id, name: ref.name,
        seconds: ref.seconds, sr: ref.sr, resampled_from: ref.resampled_from ?? null,
        grid_gated: ref.kick?.grid?.gated === true,
        findings: rf.findings.length,
        skipped: rf.skipped,
        shape_measured: r.measure?.shape?.available === true,
        shape_note: r.measure?.shape?.onsets_source ?? r.measure?.shape?.why ?? null,
        what_it_is: "a SHAPE — dB, milliseconds and counts measured off a track you own. "
          + "Matching it makes this mix SIT like that one; it cannot make it sound like its "
          + "parts, and none of its audio is here.",
      };
    }
    /* RANK FIRST, CAP SECOND. Capping the python side's severity order and
     * then ranking would let the cap decide what the human sees before the
     * ranking has had a say — which is how the first live run ended up
     * spending two of three iterations on the alphabetically-first cards. */
    const cap = Math.max(1, Math.min(Number(body.max_cards) || CARD_CAP, 12));
    const built = buildCards(r.findings, ctx, { maxCards: 999 });
    const ranked = rankCards(built.cards, profile, genre, job.ear.targets);
    return { doc, fromBar, toBar, analysis: r,
             cards: ranked.slice(0, cap), notes: built.notes,
             overCap: Math.max(0, ranked.length - cap), genre, profile, job, earOpts,
             reference };
  }

  /* ── answering a card ──────────────────────────────────────────────── */

  async function measureScore(slug, run) {
    /* The same root / target / delivery the critique measured with, so the
     * A/B guard compares like with like (a run's earOpts; older runs have
     * none and measure as they always did). */
    const { job } = await analysisJob(slug, run.fromBar, run.toBar, {
      genre: run.genre, targetOverrides: run.targetOverrides || {},
      ...(run.earOpts || {}),
    });
    const r = await earCall("analyse", job);
    return { score: r.score, measure: r.measure, findings: r.findings };
  }

  async function applyChoice(slug, run, card, route, opts) {
    const undoFor = await undoBuilder(slug);
    const io = {
      applyOp,
      undoFor: (op, result) => undoFor(op, result),
      measure: async () => (await measureScore(slug, run)).score,
    };
    return applyWithGuard(route, card.finding, io,
      { before: opts?.before ?? run.score, epsilon: AB_EPSILON });
  }

  /* ══════════════════════════════════════════════════════════════════ */

  async function handle(req, res, url) {
    const p = url.pathname;

    if (p === "/api/daw/ear/status" && req.method === "GET") {
      let probe = null;
      try { probe = await earCall("probe", {}, 120_000); }
      catch (err) { probe = { error: String(err.message || err) }; }
      let judge = null;
      try {
        judge = await earCall("judge_status", {}, 120_000,
          judgePython === config.python ? null : judgePython);
      } catch (err) { judge = { error: String(err.message || err) }; }
      const profile = await readTaste();
      json(res, 200, {
        ok: true,
        objective: probe?.error ? { error: probe.error } : {
          critics: probe.critics, bands: probe.bands, genres: probe.genres,
          targets: probe.targets, roles: probe.roles,
          bands_agree: bandsAgree(probe.bands),
          /* §7 — the nine human band words exist on both sides now (the
           * reference cards are written in JavaScript), so they are checked
           * the same way the labels have always been. */
          band_names: probe.band_names,
          band_names_agree: bandNamesAgree(probe.band_names),
          shape: probe.shape ?? null,
        },
        subjective: judge?.error ? { available: false, error: judge.error } : judge,
        judge_python: judgePython,
        taste: tasteSummary(profile),
        loop: { iteration_cap: ITERATION_CAP, card_cap: CARD_CAP, ab_epsilon: AB_EPSILON },
        tools: Object.keys(TOOLS),
      });
      return true;
    }

    if (p === "/api/daw/ear/taste" && req.method === "GET") {
      const profile = await readTaste();
      json(res, 200, { ok: true, path: tastePath(), profile, summary: tasteSummary(profile) });
      return true;
    }

    /* The choice chain itself. The DAW project ledger lives beside the
     * project (SPEC D1.1) and nothing else exposes it over HTTP yet, so the
     * Ear serves its own scope — read-only, chain-verified, so the panel and
     * the e2e can both see WHO decided WHAT rather than take it on trust. */
    if (p.startsWith("/api/daw/ear/ledger/") && req.method === "GET") {
      if (!prov) { json(res, 200, { ok: true, events: [], note: "no ledger wired" }); return true; }
      const slug = safe(p.slice("/api/daw/ear/ledger/".length));
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 1000);
      const type = url.searchParams.get("type") || undefined;
      const { events, total, head: chainHead } = await prov.read(provScope(slug), { type, limit });
      json(res, 200, {
        ok: true, scope: `daw/${slug}`, events, total, chainHead,
        chain: await prov.verify(provScope(slug)),
        actors: events.reduce((m, e) => ({ ...m, [e.actor]: (m[e.actor] || 0) + 1 }), {}),
      });
      return true;
    }

    if (p.startsWith("/api/daw/ear/runs/") && req.method === "GET") {
      const slug = safe(p.slice("/api/daw/ear/runs/".length));
      json(res, 200, { ok: true, runs: await listRuns(slug) });
      return true;
    }

    if (p !== "/api/daw/ear" || req.method !== "POST") return false;

    let b, action;
    try {
      b = await readBody(req);
      action = String(b.action || "");
    } catch (err) {
      return json(res, 400, { error: `The request body is not JSON: ${err.message}` }), true;
    }

    try {
      const slug = safe(b.slug);
      switch (action) {
        /* ── measure + critique + cards ─────────────────────────────── */
        case "critique": {
          const t0 = Date.now();
          const c = await critique(slug, b);
          const run = {
            id: randomUUID().slice(0, 8),
            slug, startedAt: new Date().toISOString(),
            mode: "interactive",
            fromBar: c.fromBar, toBar: c.toBar, genre: c.genre,
            targetOverrides: shiftedTargets(c.profile, c.genre, { lufs: -14 }),
            earOpts: c.earOpts,
            score: c.analysis.score,
            baseline: { score: c.analysis.score, measure: c.analysis.measure },
            cards: c.cards, notes: c.notes,
            answers: [], iterations: [], delegate: null, approvedAt: null,
          };
          await saveRun(slug, run);
          return json(res, 200, {
            ok: true, run: run.id, from_bar: c.fromBar, to_bar: c.toBar,
            genre: c.genre,
            measure: c.analysis.measure, score: c.analysis.score,
            findings: c.analysis.findings,
            cards: c.cards, notes: c.notes, over_cap: c.overCap,
            ...(c.reference ? { reference: c.reference } : {}),
            stems: c.analysis.stems, master_source: c.analysis.master_source,
            /* [DAWREC] What the measured mix CONTAINED, not what it lacked:
             * `stems_cover` says whether the stems are notes alone or
             * notes+clips, and `audio_clips` counts the takes that were IN
             * it. The old pair said `audio_clips_excluded: 0` about a mix
             * from which every clip had been excluded. */
            stems_cover: c.analysis.stems_cover,
            audio_clips: c.analysis.audio_clips,
            taste: tasteSummary(c.profile),
            ms: Date.now() - t0,
          }), true;
        }

        /* ── the human answers a card (SPEC D1.8.2) ─────────────────── */
        case "answer": {
          const run = await loadRun(slug, b.run);
          const card = (run.cards || []).find((c) => c.id === b.card);
          if (!card) throw new Error(`No card "${b.card}" in run ${run.id}.`);
          const actor = actorOf(req);
          const mode = b.mode === "bulk" ? "bulk" : "individual";
          if (b.choice === "skip" || b.skip) {
            // D1.8.3 rule 5: a skip is logged as NOTHING.
            run.answers.push({ card: card.id, skipped: true, at: new Date().toISOString() });
            await saveRun(slug, run);
            return json(res, 200, { ok: true, skipped: true, logged: false,
              note: "a skip is not a decision and is not written to the ledger" }), true;
          }
          const freeText = b.free_text ? String(b.free_text).slice(0, 4000) : null;
          const route = (card.routes || []).find((r) => r.id === b.choice) || null;
          if (!route && !freeText) {
            throw new Error(`Pick one of ${(card.routes || []).map((r) => r.id).join(", ")}, `
              + "write your own direction in free_text, or skip.");
          }
          /* THE INVARIANT, enforced at the seam: an agent-driven call cannot
           * produce a `choice`. It produces a `judge` under a delegation, or
           * it is refused. (SPEC D1.0 / D1.4.) */
          let evt = null;
          if (actor === "user") {
            evt = choiceEvent({
              asset: `daw/${slug}`, card, chosen: route?.id ?? null,
              freeText, reasoning: b.reasoning ? String(b.reasoning).slice(0, 2000) : null,
              decideMs: b.decide_ms, mode, loopRun: run.id,
              iteration: (run.iterations?.length || 0) + 1, actor,
            });
          } else {
            if (!run.delegate) {
              throw new Error(
                "This call is not from the browser, so it cannot record a human choice "
                + "(SPEC D1.0). Start an auto run first (action \"auto\"), which records "
                + "the human's delegation, and the Ear's own answers then land honestly "
                + "as `judge` events.");
            }
            evt = judgeEvent({
              asset: `daw/${slug}`, card, chosen: route?.id ?? null,
              loopRun: run.id, iteration: (run.iterations?.length || 0) + 1,
              delegatedBy: run.delegate, why: b.reasoning ?? null, actor,
            });
          }
          const written = await provNote(slug, evt);

          let applied = null;
          if (route) {
            applied = await applyChoice(slug, run, card, route, { before: run.score });
            if (applied.after) run.score = applied.after;
          }
          const profile = await foldAndSave({
            metric: card.metric, genre: run.genre,
            action: freeText && !route ? "override" : "accept",
            severity: card.severity,
            deltaDb: card.finding?.delta_db,
          });
          run.answers.push({
            card: card.id, chosen: route?.id ?? null, freeText, mode,
            actor, event: written?.id ?? null,
            applied: applied ? { op: applied.op, verdict: applied.verdict,
                                 reverted: applied.reverted, reason: applied.reason,
                                 improvement_db: applied.total_improvement_db } : null,
            at: new Date().toISOString(),
          });
          run.iterations.push({ n: run.iterations.length + 1, card: card.id,
                                verdict: applied?.verdict ?? "no_edit" });
          await saveRun(slug, run);
          return json(res, 200, {
            ok: true, run: run.id, logged_as: evt.type, actor: evt.actor,
            event: written?.id ?? null,
            applied: applied && {
              op: applied.op, verdict: applied.verdict, reverted: applied.reverted,
              reason: applied.reason, improvement_db: applied.total_improvement_db,
              targeted_improvement_db: applied.targeted_improvement_db,
              before: applied.before, after: applied.after,
            },
            free_text_recorded: !!freeText,
            taste: tasteSummary(profile),
          }), true;
        }

        /* ── the human rejects a card outright ──────────────────────── */
        case "reject": {
          const run = await loadRun(slug, b.run);
          const card = (run.cards || []).find((c) => c.id === b.card);
          if (!card) throw new Error(`No card "${b.card}" in run ${run.id}.`);
          const actor = actorOf(req);
          if (actor !== "user") {
            throw new Error("only the human rejects a card; an agent's verdict is a judge event.");
          }
          const evt = choiceEvent({
            asset: `daw/${slug}`, card, chosen: null,
            rejected: (card.routes || []).map((r) => r.id),
            freeText: b.free_text ? String(b.free_text).slice(0, 4000) : null,
            reasoning: b.reasoning ? String(b.reasoning).slice(0, 2000) : null,
            decideMs: b.decide_ms, mode: "individual", loopRun: run.id, actor,
          });
          const written = await provNote(slug, evt);
          const profile = await foldAndSave({
            metric: card.metric, genre: run.genre, action: "reject", severity: card.severity,
          });
          run.answers.push({ card: card.id, rejected: true, actor,
                             event: written?.id ?? null, at: new Date().toISOString() });
          await saveRun(slug, run);
          return json(res, 200, { ok: true, logged_as: "choice", rejected_all_routes: true,
                                  event: written?.id ?? null, taste: tasteSummary(profile) }), true;
        }

        /* ── bulk accept — a separate control, logged AS BULK ────────── */
        case "bulk_accept": {
          const run = await loadRun(slug, b.run);
          const actor = actorOf(req);
          if (actor !== "user") {
            throw new Error("bulk accept is a human control; an agent uses action \"auto\".");
          }
          const ids = Array.isArray(b.cards) && b.cards.length
            ? b.cards : (run.cards || []).map((c) => c.id);
          const done = [];
          for (const id of ids) {
            const card = (run.cards || []).find((c) => c.id === id);
            if (!card || (run.answers || []).some((a) => a.card === id)) continue;
            const route = card.routes[0];
            const evt = choiceEvent({
              asset: `daw/${slug}`, card, chosen: route.id, mode: "bulk",
              loopRun: run.id, decideMs: null, actor,
            });
            const written = await provNote(slug, evt);
            const applied = await applyChoice(slug, run, card, route, { before: run.score });
            if (applied.after) run.score = applied.after;
            await foldAndSave({ metric: card.metric, genre: run.genre,
                                action: "accept", severity: card.severity });
            run.answers.push({ card: id, chosen: route.id, mode: "bulk", actor,
                               event: written?.id ?? null,
                               applied: { verdict: applied.verdict, reverted: applied.reverted },
                               at: new Date().toISOString() });
            done.push({ card: id, route: route.id, verdict: applied.verdict,
                        reverted: applied.reverted });
          }
          await saveRun(slug, run);
          return json(res, 200, {
            ok: true, mode: "bulk", accepted: done.length, results: done,
            honesty: `Accepted in ONE action and recorded as bulk — never as ${done.length} `
              + `individual deliberation${done.length === 1 ? "" : "s"} (SPEC D1.8.3). The `
              + "dossier will report it as what it was: one action.",
          }), true;
        }

        /* ── auto-progression: the Ear answers its own cards ─────────── */
        case "auto": {
          const t0 = Date.now();
          const actor = actorOf(req);
          const brief = b.brief ? String(b.brief) : "";
          const iterations = Math.max(1, Math.min(Number(b.iterations) || ITERATION_CAP,
                                                  ITERATION_CAP));
          if (!brief.trim() && !b.delegated_by) {
            throw new Error(
              "Auto-progression needs the human's brief in their own words (`brief`) — "
              + "it is the direction-setting the dossier records as their contribution, "
              + "and it is what every auto decision will be recorded as delegated BY.");
          }
          const c0 = await critique(slug, b);
          const run = {
            id: randomUUID().slice(0, 8), slug, startedAt: new Date().toISOString(),
            mode: "auto", fromBar: c0.fromBar, toBar: c0.toBar, genre: c0.genre,
            targetOverrides: shiftedTargets(c0.profile, c0.genre, { lufs: -14 }),
            earOpts: c0.earOpts,
            score: c0.analysis.score,
            baseline: { score: c0.analysis.score, measure: c0.analysis.measure },
            brief, cards: c0.cards, notes: c0.notes,
            answers: [], iterations: [], judgements: [], delegate: null, approvedAt: null,
          };
          const del = b.delegated_by
            ? { id: b.delegated_by }
            : await provNote(slug, delegateEvent({
              asset: `daw/${slug}`, brief, loopRun: run.id, iterations,
              scope: `bars ${c0.fromBar}-${c0.toBar}`, actor,
            }));
          if (!del?.id) throw new Error("the delegation could not be recorded; refusing to run.");
          run.delegate = del.id;

          const profile0 = await readTaste();
          let cards = run.cards;
          for (let it = 1; it <= iterations; it++) {
            const pending = cards.filter((c) => !run.answers.some((a) => a.card === c.id));
            if (!pending.length) break;
            const card = pending[0];
            if (!autoAllowed(profile0, card.metric, run.genre)) {
              run.answers.push({ card: card.id, skipped: true, actor: "agent:ear",
                                 why: "you have rejected this class three times — the Ear "
                                   + "still measures it and still shows it, but will not "
                                   + "apply it on its own",
                                 at: new Date().toISOString() });
              continue;
            }
            const route = card.routes[0];
            const jev = judgeEvent({
              asset: `daw/${slug}`, card, chosen: route.id, loopRun: run.id,
              iteration: it, delegatedBy: run.delegate,
              why: `${card.metric}: ${card.how_much}`,
            });
            const written = await provNote(slug, jev);
            const applied = await applyChoice(slug, run, card, route, { before: run.score });
            if (applied.after) run.score = applied.after;
            run.judgements.push({
              id: written?.id ?? null, card: card.id, chosen: route.id,
              options: card.routes.map((r) => ({ id: r.id, text: r.text })),
              observation: card.observation, metric: card.metric,
              verdict: applied.verdict, reverted: applied.reverted,
              improvement_db: applied.total_improvement_db,
            });
            run.answers.push({ card: card.id, chosen: route.id, actor: "agent:ear",
                               event: written?.id ?? null,
                               applied: { op: applied.op, verdict: applied.verdict,
                                          reverted: applied.reverted },
                               at: new Date().toISOString() });
            run.iterations.push({ n: it, card: card.id, verdict: applied.verdict,
                                  reverted: applied.reverted });
            // re-critique so the next iteration sees the mix it just changed
            if (it < iterations) {
              const c = await critique(slug, { ...b, from_bar: run.fromBar, to_bar: run.toBar });
              cards = c.cards.filter((x) => !run.answers.some((a) => a.card === x.id));
              run.cards = [...run.cards, ...cards.filter(
                (x) => !run.cards.some((y) => y.id === x.id))];
            }
          }
          const final = await measureScore(slug, run);
          run.finalScore = final.score;
          await saveRun(slug, run);
          return json(res, 200, {
            ok: true, run: run.id, mode: "auto", delegate: run.delegate,
            iterations: run.iterations,
            judgements: run.judgements,
            before: run.baseline.score, after: final.score,
            review_required: true,
            honesty: "every decision above was made by the Ear under your delegation and is "
              + "recorded as `judge` (actor agent:ear), never as your own deliberation. "
              + "Run the review checkpoint to turn any of them into a real, informed "
              + "selection (SPEC D1.8.4).",
            ms: Date.now() - t0,
          }), true;
        }

        /* ── the review checkpoint ──────────────────────────────────── */
        case "review_cards": {
          const run = await loadRun(slug, b.run);
          const rows = (run.judgements || []).map((j) => {
            const card = (run.cards || []).find((c) => c.id === j.card);
            const reviewed = (run.answers || []).find(
              (a) => a.card === j.card && a.mode === "review");
            return {
              judge_event: j.id, card: j.card, metric: j.metric,
              observation: j.observation,
              the_ear_chose: j.chosen,
              alternatives: j.options,
              outcome: { verdict: j.verdict, reverted: j.reverted,
                         improvement_db: j.improvement_db },
              routes: card?.routes ?? [],
              already_reviewed: !!reviewed,
              verdicts: ["keep", "override"],
              free_text: { allowed: true, prompt: "your own direction…" },
            };
          });
          return json(res, 200, {
            ok: true, run: run.id, delegate: run.delegate, brief: run.brief,
            cards: rows,
            note: "keep = you saw the alternatives and ratified that specific choice; "
              + "override = you changed it. Both are recorded as YOUR decision "
              + "(`choice`, mode review). Unreviewed rows stay recorded as the "
              + "machine's, which is what they are.",
          }), true;
        }

        case "review": {
          const run = await loadRun(slug, b.run);
          const actor = actorOf(req);
          if (actor !== "user") {
            throw new Error("the review checkpoint is the human's; an agent cannot ratify "
              + "its own decisions (SPEC D1.0).");
          }
          const j = (run.judgements || []).find((x) => x.card === b.card || x.id === b.judge_event);
          if (!j) throw new Error(`No auto-decision to review for "${b.card ?? b.judge_event}".`);
          const card = (run.cards || []).find((c) => c.id === j.card);
          const verdict = b.verdict === "override" ? "override" : "keep";
          const freeText = b.free_text ? String(b.free_text).slice(0, 4000) : null;
          const chosen = verdict === "keep" ? j.chosen : (b.choice ?? null);
          const evt = choiceEvent({
            asset: `daw/${slug}`, card, chosen, freeText,
            reasoning: b.reasoning ? String(b.reasoning).slice(0, 2000) : null,
            decideMs: b.decide_ms, mode: "review", loopRun: run.id,
            reviews: j.id, verdict, actor,
          });
          const written = await provNote(slug, evt);
          let applied = null;
          if (verdict === "override" && chosen) {
            const route = (card?.routes || []).find((r) => r.id === chosen);
            if (!route) throw new Error(`No route "${chosen}" on card ${j.card}.`);
            applied = await applyChoice(slug, run, card, route, { before: run.score });
            if (applied.after) run.score = applied.after;
          }
          const profile = await foldAndSave({
            metric: j.metric, genre: run.genre,
            action: verdict === "keep" ? "accept" : "override",
            severity: card?.severity, deltaDb: card?.finding?.delta_db,
          });
          run.answers.push({ card: j.card, mode: "review", verdict, chosen, freeText,
                             actor, reviews: j.id, event: written?.id ?? null,
                             at: new Date().toISOString() });
          await saveRun(slug, run);
          return json(res, 200, {
            ok: true, logged_as: "choice", mode: "review", verdict,
            reviews: j.id, event: written?.id ?? null,
            applied: applied && { op: applied.op, verdict: applied.verdict,
                                  reverted: applied.reverted },
            taste: tasteSummary(profile),
          }), true;
        }

        case "review_keep_all": {
          const run = await loadRun(slug, b.run);
          const actor = actorOf(req);
          if (actor !== "user") throw new Error("the review checkpoint is the human's.");
          const done = [];
          for (const j of run.judgements || []) {
            if ((run.answers || []).some((a) => a.card === j.card && a.mode === "review")) continue;
            const card = (run.cards || []).find((c) => c.id === j.card);
            const evt = choiceEvent({
              asset: `daw/${slug}`, card, chosen: j.chosen, mode: "bulk",
              loopRun: run.id, reviews: j.id, verdict: "keep", decideMs: null, actor,
            });
            const written = await provNote(slug, evt);
            run.answers.push({ card: j.card, mode: "bulk", verdict: "keep", actor,
                               reviews: j.id, event: written?.id ?? null,
                               at: new Date().toISOString() });
            done.push(j.card);
          }
          await saveRun(slug, run);
          return json(res, 200, {
            ok: true, mode: "bulk", kept: done.length, cards: done,
            honesty: `Recorded as ONE bulk ratification — never as ${done.length} `
              + `individual review${done.length === 1 ? "" : "s"} (SPEC D1.8.3). The `
              + "dossier will report it as what it was: one action.",
          }), true;
        }

        /* ── the final approval, after listening ────────────────────── */
        case "approve": {
          const run = await loadRun(slug, b.run);
          const actor = actorOf(req);
          if (actor !== "user") {
            throw new Error("approval is the human's act of listening — an agent cannot "
              + "approve on their behalf.");
          }
          const evt = approveEvent({
            asset: `daw/${slug}`, loopRun: run.id,
            subjectHash: b.subject_hash ?? null,
            sessionSeconds: b.listened_seconds,
            note: b.note ? String(b.note).slice(0, 2000) : null, actor,
          });
          const written = await provNote(slug, evt);
          run.approvedAt = new Date().toISOString();
          await saveRun(slug, run);
          return json(res, 200, { ok: true, logged_as: "approve", event: written?.id ?? null,
                                  run: run.id }), true;
        }

        /* ── measure a file that already exists (a bounce) ──────────── */
        case "analyse_file": {
          const r = await earCall("file", {
            path: String(b.path || ""), sr: b.sr,
            ear: { bars: [], genre: b.genre || "neutral", targets: b.targets || {} },
          });
          return json(res, 200, { ok: true, ...r }), true;
        }

        /* ── the subjective stage, on demand ────────────────────────── */
        case "judge": {
          const r = await earCall("judge", { path: String(b.path || ""), brief: b.brief,
                                             gpu: !!b.gpu }, 900_000,
            judgePython === config.python ? null : judgePython);
          return json(res, 200, { ok: true, ...r }), true;
        }

        /* ── the taste profile ──────────────────────────────────────── */
        case "taste_reset": {
          const p = await writeTaste(neutralProfile());
          return json(res, 200, {
            ok: true, profile: p, summary: tasteSummary(p),
            note: "the profile is a derived cache; resetting it changes nothing in the "
              + "provenance ledger, which stays the record of what you actually decided",
          }), true;
        }

        case "state": {
          const run = await loadRun(slug, b.run);
          return json(res, 200, { ok: true, run }), true;
        }

        default:
          return json(res, 400, {
            error: `Unknown action "${action}". Actions: critique, answer, reject, `
              + "bulk_accept, auto, review_cards, review, review_keep_all, approve, "
              + "analyse_file, judge, taste_reset, state.",
          }), true;
      }
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) }), true;
    }
  }

  async function foldAndSave(row) {
    const p = foldFeedback(await readTaste(), row);
    return writeTaste(p);
  }

  handle.critique = critique;
  handle.readTaste = readTaste;
  handle.tastePath = tastePath;
  return handle;
}

/** A summary a human can read without JSON: what the Ear has learned so far. */
export function tasteSummary(profile) {
  const rows = Object.entries(profile?.metrics || {}).map(([k, v]) => {
    const [genre, metric] = k.split("|");
    const w = profileWeight(profile, metric, genre);
    return {
      genre, metric, accepted: v.accepted || 0, rejected: v.rejected || 0,
      overridden: v.overridden || 0, skipped: v.skipped || 0,
      weight: r2(w),
      auto_allowed: autoAllowed(profile, metric, genre),
      override_mean_db: profile?.overrides?.[k]?.n >= 3 ? profile.overrides[k].mean : null,
    };
  }).sort((a, b) => b.weight - a.weight);
  return {
    observations: profile?.observations || 0,
    cold_start: (profile?.observations || 0) < 10,
    prior: `Beta(${TASTE_PRIOR},${TASTE_PRIOR}) — neutral until about ten decisions`,
    metrics: rows,
  };
}

export const _internals = { chainOf, faderOf, eqOp, inferRoleHints: null };

/* ════════════════════════════════════════════════════════════════════════
 * THE SONG'S ROOT, for the tuning critic. Told beats read beats inferred,
 * and the source rides on the job so the finding can say which.
 * ══════════════════════════════════════════════════════════════════════ */

const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "F", "Db", "C#", "f minor", 41, 5 -> pitch class 0..11, else null. */
export function parseRoot(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number" && Number.isFinite(v)) return ((Math.round(v) % 12) + 12) % 12;
  const s = String(v).trim();
  const base = NOTE_PC[s[0]?.toUpperCase()];
  if (base === undefined) return null;
  const acc = s[1] === "#" ? 1 : (s[1] === "b" || s[1] === "♭") ? -1 : 0;
  return (((base + acc) % 12) + 12) % 12;
}

/**
 * The root, inferred from the bass line over the WHOLE document: the pitch
 * class of the line's lowest note when it carries >= 15 % of the duration
 * (a sub sits on the tonic at its floor and climbs to the other chord roots
 * from there), else the class with the most duration. A progression defeats
 * either cue alone — i-VI-III-VII gives every root a quarter of the bars —
 * which is why there are two. Kits are never read as pitch.
 */
export function inferRootFromDoc(doc, tracks = {}) {
  const KITS = new Set(["tr808", "tr909", "drums"]);
  const pool = (doc.tracks || []).filter((t) => tracks[t.id]?.role === "bass"
    && !KITS.has(t.instrument?.patch));
  const src = pool.length ? pool : (() => {
    const pitched = (doc.tracks || []).filter((t) => !KITS.has(t.instrument?.patch)
      && (t.clips || []).some((c) => c.notes?.length));
    if (!pitched.length) return [];
    const med = (t) => {
      const ps = t.clips.flatMap((c) => c.notes.map((n) => n.pitch)).sort((a, b) => a - b);
      return ps[Math.floor(ps.length / 2)];
    };
    return [pitched.sort((a, b) => med(a) - med(b))[0]];
  })();
  const hist = new Array(12).fill(0);
  let low = Infinity, total = 0;
  for (const t of src) for (const c of t.clips || []) for (const n of c.notes || []) {
    const w = Math.max(1, Number(n.durTicks) || 1);
    hist[((n.pitch % 12) + 12) % 12] += w; total += w;
    if (n.pitch < low) low = n.pitch;
  }
  if (!total) return null;
  const lowPc = ((low % 12) + 12) % 12;
  if (hist[lowPc] >= 0.15 * total) return lowPc;
  return hist.indexOf(Math.max(...hist));
}

/** { pc, source, inferred } or null. */
export function songRoot(doc, opts = {}, tracks = {}) {
  const told = parseRoot(opts.root);
  if (told !== null) return { pc: told, source: "told", inferred: false };
  const onDoc = parseRoot(doc.key ?? doc.meta?.key ?? doc.arrangement?.key);
  if (onDoc !== null) return { pc: onDoc, source: "project", inferred: false };
  const m = /\b([A-G](?:#|b)?)\s+(?:minor|major|min|maj)\b/i.exec(String(doc.name || ""));
  if (m) return { pc: parseRoot(m[1]), source: "project name", inferred: true };
  const pc = inferRootFromDoc(doc, tracks);
  return pc === null ? null : { pc, source: "bass line", inferred: true };
}

/* ════════════════════════════════════════════════════════════════════════
 * THE ANALYSIS JOB — the SAME payload a render/meters call would build.
 * Pure: document in, job out, no disk, no python. ear_test.js pins that
 * every note carries its instrument params exactly as noteEvents() (and so
 * ensureRegions, and so the bounce) sends them.
 * ══════════════════════════════════════════════════════════════════════ */

const ROLE_HINTS = [
  [/\b(vox|vocal|voc|lead|sing)\b/i, "lead"],
  [/\b(bass|sub|808)\b/i, "bass"],
  [/\b(drum|kick|snare|hat|perc|kit|beat)\b/i, "drums"],
  [/\b(pad|strings|atmos|texture)\b/i, "pad"],
  [/\b(gtr|guitar|pluck)\b/i, "guitar"],
  [/\b(key|piano|rhodes|organ)\b/i, "keys"],
  [/\b(fx|riser|sweep|impact)\b/i, "fx"],
];
/** A role, or null. Inferred roles ride at lower confidence and SAY they
 *  were inferred — the difference between measuring and guessing is the
 *  whole point of this column. */
export function inferRole(track) {
  const hay = `${track.name || ""} ${track.instrument?.patch || ""}`;
  for (const [re, role] of ROLE_HINTS) if (re.test(hay)) return role;
  if (track.instrument?.patch === "drums") return "drums";
  if (track.instrument?.patch === "pad") return "pad";
  return null;
}

export function buildAnalysisJob(doc, fromBar, toBar, opts = {}) {
  const rows = buildTimeline(doc);
  const f = Math.max(1, Math.min(Number(fromBar) || 1, doc.lengthBars));
  const t = Math.max(f, Math.min(Number(toBar) || doc.lengthBars, doc.lengthBars));
  const t0 = rows[f - 1].sec;
  const last = rows[t - 1];
  const t1 = last.sec + last.secLen;
  const startSample = Math.round(t0 * doc.sr);
  const nSamples = Math.round(t1 * doc.sr) - startSample;
  const events = noteEvents(doc);
  const notes = events
    .filter((e) => e.reach0 < t1 && e.reach1 > t0)
    .map((e) => ({
      /* `params` rides along exactly as ensureRegions sends it: the
       * track's instrument knobs (a kick preset, a sub's sub_mix). Without
       * it the Ear measured a kick with default knobs while the bounce
       * held the preset — found on the first big-room render, where the
       * kick bus read 2.9 dB RMS louder here than in the file. */
      inst: e.inst, params: e.params, midi: e.midi, vel: e.vel,
      start_sample: e.startSample, dur_samples: e.durSamples,
      gain_db: e.gainDb, seed: e.seed, track_id: e.trackId,
    }));
  /* [DAWREC] THE CLIPS, filtered by the SAME reach test the notes above use
   * and mapped by store.js's one clip-to-job mapping — because this job's
   * whole claim is that it measures the render the bounce makes. Without
   * them the Ear critiqued a mix from which every recorded take had been
   * removed: a project whose vocal is a comp got a master AND per-track stems
   * with no vocal in either (rack.chain_graph mixes clips into the owning
   * track's dry buffer, so both halves move together), and then reported
   * `audio_clips_excluded: 0` about it — vacuously true, because the job it
   * counted carried none.
   *
   * THE SLUG IS REQUIRED THE MOMENT A CLIP REACHES THIS WINDOW. A clip's
   * `path` is built under the project's audio directory and there is no
   * honest guess for a missing slug; falling back to `[]` would be the very
   * defect this closes, one layer up — silent exclusion, reported as
   * nothing excluded. A document with no clip in reach has no silence to
   * hide, so it needs no slug and every slug-less caller keeps working. */
  const audio = audioEvents(doc);
  const reaching = audio.filter((a) => a.reach0 < t1 && a.reach1 > t0);
  if (reaching.length && !opts.slug) {
    throw new Error(
      `buildAnalysisJob needs the project's slug: bars ${f}-${t} are reached by `
      + `${reaching.length} audio clip${reaching.length === 1 ? "" : "s"} whose file path `
      + "cannot be built without it, and measuring this window without them would "
      + "critique a master and stems the bounce never makes. Pass opts.slug.");
  }
  const clips = opts.slug ? audioJobClips(doc, opts.slug, t0, t1, audio) : [];
  const tracks = {};
  for (const tr of doc.tracks || []) {
    const role = opts.roles?.[tr.id] ?? inferRole(tr);
    tracks[tr.id] = {
      name: tr.name || tr.id, role,
      role_inferred: !opts.roles?.[tr.id] && !!role,
      ...(opts.targets?.[tr.id] !== undefined ? { target_lufs: opts.targets[tr.id] } : {}),
    };
  }
  const bars = [];
  for (let bar = f; bar <= t; bar++) {
    bars.push({ bar, t0: rows[bar - 1].sec - t0, t1: rows[bar - 1].sec + rows[bar - 1].secLen - t0 });
  }
  const root = songRoot(doc, opts, tracks);
  const targetLufs = [opts.targetLufs, doc.master?.target_lufs, doc.target_lufs]
    .map((v) => Number(v)).find((v) => Number.isFinite(v));
  return {
    doc, fromBar: f, toBar: t,
    earOpts: { root: opts.root ?? null, targetLufs: targetLufs ?? null, delivery: opts.delivery ?? null },
    job: {
      sr: doc.sr, start_sample: startSample, n_samples: nSamples,
      /* `audio` rides ALWAYS, empty list and all — unlike the render job,
       * which omits it when there is nothing to send. The Ear REPORTS this
       * count back to the human (`audio_clips`), so the key that carries it
       * must be one that cannot go missing without a test noticing. */
      notes, audio: clips, mixer: mixerJobPayload(doc, rows),
      ear: {
        bars, tracks,
        genre: opts.genre || "neutral",
        targets: opts.targetOverrides || {},
        maxMasking: 8,
        /* §7 — measure OUR third-octave, per-band width, kick decay and pump
         * as well. Off unless a reference profile is being matched, because
         * it is a few hundred milliseconds of FFTs a critique that reads none
         * of them should not pay for. */
        ...(opts.shape ? { shape: true } : {}),
        /* The song's root for the tuning critic: told (body.key, or a key
         * the document carries), read off the project's name ("Big room
         * F minor #1"), or inferred from the bass line — and SAID which. */
        ...(root ? { root: root.pc, root_source: root.source, root_inferred: root.inferred } : {}),
        /* The loudness target: the project's own beats the genre table. */
        ...(targetLufs !== undefined ? { target_lufs: targetLufs } : {}),
        ...(opts.delivery ? { delivery: String(opts.delivery) } : {}),
      },
    },
  };
}
