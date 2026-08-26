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

import { readProject, projectDir, buildTimeline, noteEvents } from "./store.js";
import { mixerJobPayload } from "./mixer.js";
import { rackTools } from "./mcp-rack.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EAR_PY = path.join(__dirname, "ear.py");

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
      const routes = [
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
      ];
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

    /* ── the stereo image ────────────────────────────────────────────── */
    case "width": {
      const t = f.target;
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
        why_not_a_card: m.note
          ? "only one honest route exists — a one-option card is a confirmation "
            + "dialog, and a confirmation dialog is not a creative choice"
          : "no edit would honestly help here, so none is offered",
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
 * ══════════════════════════════════════════════════════════════════════ */

export function choiceEvent({ asset, card, chosen, rejected, freeText, reasoning,
                              decideMs, mode = "individual", loopRun, iteration,
                              reviews, verdict, actor = "user" }) {
  if (actor !== "user") {
    throw new Error(
      "a `choice` event is a HUMAN decision; an agent's decision is a `judge` "
      + "event with actor agent:ear (SPEC D1.0). This is not configurable.");
  }
  if (!["individual", "bulk", "review"].includes(mode)) {
    throw new Error(`unknown choice mode "${mode}" — individual, bulk or review`);
  }
  return {
    actor: "user", type: "choice", asset,
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
 */
export function delegateEvent({ asset, brief, scope, loopRun, iterations, actor = "user" }) {
  if (!brief || !String(brief).trim()) {
    throw new Error(
      "delegation needs the human's brief in their own words — it is the "
      + "direction-setting the dossier records as their contribution.");
  }
  if (actor !== "user" && !String(actor).startsWith("agent:")) {
    throw new Error(`illegal delegate actor "${actor}" — user or agent:*`);
  }
  return {
    actor, type: "delegate", asset,
    data: { surface: "ear", loopRun, brief: String(brief), scope: scope ?? null,
            iterations: Number(iterations) || ITERATION_CAP,
            ...(actor === "user" ? {} : { relayed: true }) },
  };
}

export function approveEvent({ asset, loopRun, subjectHash, sessionSeconds, note }) {
  return {
    actor: "user", type: "approve", asset,
    data: { surface: "ear", loopRun, subjectHash: subjectHash ?? null,
            sessionSeconds: Number(sessionSeconds) || 0, note: note ?? null },
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * THE ROUTES
 * ══════════════════════════════════════════════════════════════════════ */

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
  const TOOLS = Object.fromEntries(
    rackTools({
      daw: (body) => post({ ...body, by: "agent" }),
      get: getJson,
      slugOf: (s) => safe(s),
    }).map((t) => [t.name, t]));

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

  /* ── the analysis job: the SAME payload a render/meters call would build ─ */

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
  function inferRole(track) {
    const hay = `${track.name || ""} ${track.instrument?.patch || ""}`;
    for (const [re, role] of ROLE_HINTS) if (re.test(hay)) return role;
    if (track.instrument?.patch === "drums") return "drums";
    if (track.instrument?.patch === "pad") return "pad";
    return null;
  }

  async function analysisJob(slug, fromBar, toBar, opts = {}) {
    const doc = await readProject(slug);
    if (!doc) throw new Error(`No such project: ${slug}`);
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
        inst: e.inst, midi: e.midi, vel: e.vel,
        start_sample: e.startSample, dur_samples: e.durSamples,
        gain_db: e.gainDb, seed: e.seed, track_id: e.trackId,
      }));
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
    return {
      doc, fromBar: f, toBar: t,
      job: {
        sr: doc.sr, start_sample: startSample, n_samples: nSamples,
        notes, mixer: mixerJobPayload(doc, rows),
        ear: {
          bars, tracks,
          genre: opts.genre || "neutral",
          targets: opts.targetOverrides || {},
          maxMasking: 8,
        },
      },
    };
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
    const { doc, fromBar, toBar, job } = await analysisJob(slug, body.from_bar, body.to_bar, {
      genre, roles: body.roles, targets: body.track_targets,
      targetOverrides: shiftedTargets(profile, genre, { lufs: -14, ...(body.targets || {}) }),
    });
    const r = await earCall("analyse", job);
    const nameOf = (id) => (doc.tracks || []).find((t) => t.id === id)?.name || id;
    const ctx = { doc, slug, measure: r.measure, nameOf };
    /* RANK FIRST, CAP SECOND. Capping the python side's severity order and
     * then ranking would let the cap decide what the human sees before the
     * ranking has had a say — which is how the first live run ended up
     * spending two of three iterations on the alphabetically-first cards. */
    const cap = Math.max(1, Math.min(Number(body.max_cards) || CARD_CAP, 12));
    const built = buildCards(r.findings, ctx, { maxCards: 999 });
    const ranked = rankCards(built.cards, profile, genre, job.ear.targets);
    return { doc, fromBar, toBar, analysis: r,
             cards: ranked.slice(0, cap), notes: built.notes,
             overCap: Math.max(0, ranked.length - cap), genre, profile, job };
  }

  /* ── answering a card ──────────────────────────────────────────────── */

  async function measureScore(slug, run) {
    const { job } = await analysisJob(slug, run.fromBar, run.toBar, {
      genre: run.genre, targetOverrides: run.targetOverrides || {},
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
            stems: c.analysis.stems, master_source: c.analysis.master_source,
            audio_clips_excluded: c.analysis.audio_clips_excluded,
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
              iteration: (run.iterations?.length || 0) + 1,
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
            decideMs: b.decide_ms, mode: "individual", loopRun: run.id,
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
          if (actorOf(req) !== "user") {
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
              loopRun: run.id, decideMs: null,
            });
            const written = await provNote(slug, evt);
            const applied = await applyChoice(slug, run, card, route, { before: run.score });
            if (applied.after) run.score = applied.after;
            await foldAndSave({ metric: card.metric, genre: run.genre,
                                action: "accept", severity: card.severity });
            run.answers.push({ card: id, chosen: route.id, mode: "bulk", actor: "user",
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
          if (actorOf(req) !== "user") {
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
            reviews: j.id, verdict,
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
                             actor: "user", reviews: j.id, event: written?.id ?? null,
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
          if (actorOf(req) !== "user") throw new Error("the review checkpoint is the human's.");
          const done = [];
          for (const j of run.judgements || []) {
            if ((run.answers || []).some((a) => a.card === j.card && a.mode === "review")) continue;
            const card = (run.cards || []).find((c) => c.id === j.card);
            const evt = choiceEvent({
              asset: `daw/${slug}`, card, chosen: j.chosen, mode: "bulk",
              loopRun: run.id, reviews: j.id, verdict: "keep", decideMs: null,
            });
            const written = await provNote(slug, evt);
            run.answers.push({ card: j.card, mode: "bulk", verdict: "keep", actor: "user",
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
          if (actorOf(req) !== "user") {
            throw new Error("approval is the human's act of listening — an agent cannot "
              + "approve on their behalf.");
          }
          const evt = approveEvent({
            asset: `daw/${slug}`, loopRun: run.id,
            subjectHash: b.subject_hash ?? null,
            sessionSeconds: b.listened_seconds,
            note: b.note ? String(b.note).slice(0, 2000) : null,
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
