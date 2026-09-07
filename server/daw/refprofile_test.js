/**
 * §7 THE REFERENCE MATCH — the route half and the critic half.
 *
 * server/daw/refprofile_test.py proves the MEASUREMENT (the grid gate against
 * the 442 BPM failure, the gain-invariant shares, the whitelist, the 44.1 kHz
 * decision). This file proves the two things that live in JavaScript and that
 * no python assertion can reach:
 *
 *   1. THE DOOR. profile_build / list / get / delete through the REAL
 *      dispatcher into a scratch directory — including the refusals, which
 *      are the half a caller actually meets first.
 *   2. THE CRITIC. `referenceFindings` turning a profile and a measurement
 *      into findings, `mapFinding` turning those into routes, and above all
 *      THE THREE REFUSALS that keep a reference honest:
 *        · a profile whose beat-grid gate DECLINED builds no kick and no pump
 *          card at all — its onsets are raw flux peaks and everything read
 *          off them is a measurement of whatever the detector caught;
 *        · a stem with no track in its role is an ARRANGEMENT, not a fader
 *          eight dB out, and produces a line in `skipped` rather than a card;
 *        · a finding with one honest route comes back as a NOTE, because a
 *          one-option card is a confirmation dialog.
 *
 * AND ONE PROPERTY EVERYTHING ELSE RESTS ON, asserted rather than asserted-to:
 * every comparison is GAIN-INVARIANT. The same project measured 9 dB louder
 * must produce the same ref_* findings, to the last decimal — otherwise a
 * reference match is a loudness match wearing a costume, and `daw_reference`
 * already owns loudness.
 *
 * No python and no engine: every fixture here is a measurement object built
 * by hand, so this runs in a fraction of a second on a machine that has never
 * installed numpy.
 */
import os from "node:os";
import path from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";

/* The output dir MUST be decided before config.js is first imported, and
 * static imports hoist — so every import below is dynamic. */
const OUT = path.join(os.tmpdir(), `daw-refprofile-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;

const store = await import("./store.js");
const refp = await import("./refprofile.js");
const ear = await import("./ear.js");
const { createDawRoutes } = await import("./routes.js");
const { dawTools } = await import("../mcp-daw.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

/* ════════════════════════════════════════════════════ THE MODULE'S SHAPE ══ */

console.log("\n  -- the mount answers only its own actions --");
{
  ok("four actions, named",
    JSON.stringify(refp.REFPROFILE_ACTIONS)
      === JSON.stringify(["profile_build", "profile_list", "profile_get", "profile_delete"]),
    refp.REFPROFILE_ACTIONS.join(", "));
  ok("an action it does not own answers null, so routes.js falls through to its switch",
    await refp.handleProfileAction("render", {}, {}) === null);
  ok("profiles live beside the projects, not inside one",
    refp.profilesDir() === path.join(store.DAW_DIR(), "_profiles"), refp.profilesDir());
  ok("...and the reference folder is the DAW's own",
    refp.referenceDir() === path.join(store.DAW_DIR(), "reference"), refp.referenceDir());
}

console.log("\n  -- an id is a slug, and a bad one is refused rather than mangled --");
{
  ok("a name becomes a slug", refp.profileId("Aiplay 00077!") === "aiplay-00077");
  ok("...case is folded", refp.profileId("BigRoom_Ref") === "bigroom_ref");
  ok("...and a path separator cannot survive it",
    refp.profileId("../../etc/passwd") === "etc-passwd");
  for (const bad of ["", "   ", "..", "///", "!!!"]) {
    ok(`"${bad}" is refused (null), not turned into something else`,
      refp.profileId(bad) === null, String(refp.profileId(bad)));
  }
  ok("a 200-character name is cut to 64 and still a legal id",
    (refp.profileId("a".repeat(200)) || "").length === 64);
}

/* ═════════════════════════ THE WHITELIST, ON THE JAVASCRIPT SIDE TOO ═════ */

console.log("\n  -- a profile is a shape on BOTH sides of the pipe --");
{
  const allowed = new Set(["name", "master", "loudness", "lufs", "third_octave", "share_db"]);
  ok("a shape passes", refp.checkShapeOnly(
    { name: "x", master: { loudness: { lufs: -9 } } }, allowed) === true);

  const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  let m = threw(() => refp.checkShapeOnly({ name: "x", samples: [1, 2] }, allowed));
  ok("an UNDECLARED key is refused", m !== null && /samples/.test(m), String(m).slice(0, 140));
  ok("...and the refusal names the file that would have to declare it",
    m !== null && /ALLOWED_KEYS/.test(m));

  m = threw(() => refp.checkShapeOnly({ name: new Array(refp.MAX_ARRAY + 1).fill(0) }, allowed));
  ok(`an array over the ${refp.MAX_ARRAY} cap is refused whatever it is called`,
    m !== null && m.includes(String(refp.MAX_ARRAY)), String(m).slice(0, 140));
  ok("...and exactly at the cap is allowed",
    refp.checkShapeOnly({ name: new Array(refp.MAX_ARRAY).fill(0) }, allowed) === true);

  m = threw(() => refp.checkShapeOnly({ name: [[1, 2], [3, 4]] }, allowed));
  ok("a NESTED array — how a spectrogram gets out — is refused by shape",
    m !== null && /nested/.test(m), String(m).slice(0, 140));

  ok("with no whitelist the structural half still runs (a narrower check, not none)",
    refp.checkShapeOnly({ anything: 1 }) === true
    && threw(() => refp.checkShapeOnly({ a: new Array(9999).fill(0) })) !== null);
}

/* ═══════════════════════════════════════════════════════ FIXTURES ═══════ */

/** A profile with every field the critic reads, and known numbers. */
function profileFixture(over = {}) {
  const bands = ear.BAND_LABELS.map((label, i) => ({
    band: label, band_index: i, name: ear.BAND_NAMES[i],
    observed_db: -9.5, reference_db: -9.5, deviation_db: 0, level_db: -20,
    absent: false,
  }));
  const width = ear.BAND_LABELS.map((label, i) => ({
    band: label, name: ear.BAND_NAMES[i], width: 0.3, side_over_mid_db: -10.5,
  }));
  return {
    id: "the-ref", name: "The Reference", sr: 48000, seconds: 200,
    master: { loudness: { lufs: -8.2 }, stereo: { width: 0.3 },
              bands: { bands }, width_per_band: width },
    stems: {
      drums: { level_rel_mix_db: -8.0 }, bass: { level_rel_mix_db: -6.0 },
      other: { level_rel_mix_db: -9.0 }, vocals: { level_rel_mix_db: -4.0 },
    },
    kick: {
      onsets: 60, f0_hz: 48.0, f0_hits: 60,
      grid: { gated: true, period_s: 0.469, implied_bpm: 128, salience: 2.4,
              raw_peaks: 200, kept: 60, why: "fitted" },
      shape: { attack_ms: 1, t10_ms: 40, t30_ms: 120, t60_ms: null, hits: 60 },
      click: { click_over_body_db: -20 }, sub_over_kick_db: 2.2,
    },
    pump: { hits: 60, depth_db: -12.0, depth_mad_db: 1.0, recovery_ms: 120,
            recovery_frac_of_beat: 0.256, beat_s: 0.469 },
    sections: [],
    ...over,
  };
}

/** A measurement in ear.py's shape, with known numbers. `gain` shifts every
 *  level by the same dB — which every comparison must ignore. */
function measureFixture(over = {}, gain = 0) {
  const bands = ear.BAND_LABELS.map((label, i) => ({
    band: label, band_index: i, name: ear.BAND_NAMES[i],
    observed_db: -9.5, reference_db: -9.5, deviation_db: 0,
    level_db: -20 + gain, absent: false,
  }));
  const width = ear.BAND_LABELS.map((label, i) => ({
    band: label, name: ear.BAND_NAMES[i], width: 0.3, side_over_mid_db: -10.5,
  }));
  return {
    master: { lufs: -10 + gain, rms_db: -14 + gain },
    stereo: { width: 0.3, correlation: 0.8 },
    spectral: { bands },
    tracks: {
      kk: { rms_db: -18 + gain, lufs: -20 + gain },
      bs: { rms_db: -16 + gain, lufs: -18 + gain },
      ld: { rms_db: -19 + gain, lufs: -21 + gain },
      vx: { rms_db: -14 + gain, lufs: -16 + gain },
    },
    tuning: { f0_hz: 48.0, track_id: "kk", patch: "hybrid_kick", knob: "tune",
              current_knob: 0 },
    shape: {
      available: true, width_per_band: width,
      kick: { attack_ms: 1, t10_ms: 40, t30_ms: 120, t60_ms: null },
      kick_track: "kk", pump_track: "bs",
      pump: { depth_db: -12.0, recovery_ms: 120, recovery_frac_of_beat: 0.256,
              beat_s: 0.469, hits: 60 },
      onsets_source: "the job's own notes",
    },
    ...over,
  };
}

const DOC = {
  slug: "proj", tracks: [
    { id: "kk", name: "Kick", instrument: { patch: "hybrid_kick", params: {} }, inserts: [] },
    { id: "bs", name: "Sub", instrument: { patch: "sub_bass", params: {} }, inserts: [] },
    { id: "ld", name: "Lead", instrument: { patch: "bigroom_lead", params: {} }, inserts: [] },
    { id: "vx", name: "Vocal", instrument: { patch: "pad", params: {} }, inserts: [] },
  ],
  master: { inserts: [], fader: 0 }, returns: [],
};
const nameOf = (id) => DOC.tracks.find((t) => t.id === id)?.name || id;
const CTX = { doc: DOC, slug: "proj", nameOf, roles: { vx: "vocal" } };

/* ══════════════════════════════════ THE CRITIC: WHAT IT REFUSES TO SAY ══ */

console.log("\n  -- a matched mix produces NO cards, and says what it checked --");
{
  const { findings, skipped } = ear.referenceFindings(profileFixture(), measureFixture(), CTX);
  ok("an identical shape produces no findings at all", findings.length === 0,
    findings.map((f) => f.metric).join(", "));
  ok("...and every comparison it made is named in `skipped`, so silence is legible",
    skipped.some((s) => s.startsWith("ref_bands"))
    && skipped.some((s) => s.startsWith("ref_width")), skipped.join(" | "));
}

console.log("\n  -- EVERY COMPARISON IS GAIN-INVARIANT --");
{
  const p = profileFixture();
  const a = ear.referenceFindings(p, measureFixture({}, 0), CTX).findings;
  const b = ear.referenceFindings(p, measureFixture({}, +9), CTX).findings;
  ok("the same mix nine dB louder produces the same findings, to the decimal",
    JSON.stringify(a) === JSON.stringify(b),
    `${a.length} vs ${b.length}`);

  /* And the level comparison specifically: it is a SHARE of the four groups,
   * so it cannot be moved by the master fader — which is what stops this
   * critic from re-answering the question daw_reference already answers. */
  const g0 = ear.groupLevels(DOC, measureFixture({}, 0), CTX.roles);
  const g9 = ear.groupLevels(DOC, measureFixture({}, +9), CTX.roles);
  ok("...and groupLevels' shares are identical either way (to the float epsilon)",
    Object.keys(g0).every((k) => near(g0[k].share_db, g9[k].share_db, 1e-9)),
    Object.keys(g0).map((k) => `${k}:${g0[k].share_db}/${g9[k].share_db}`).join(" "));
  ok("...while the raw dB it starts from did move (the check has teeth)",
    Math.abs(g0.drums.db - g9.drums.db - -9) < 1e-9, `${g0.drums.db} / ${g9.drums.db}`);
}

console.log("\n  -- AN UNGATED PROFILE BUILDS NO KICK AND NO PUMP CARD --");
{
  const p = profileFixture();
  p.kick.grid = { gated: false, period_s: null, implied_bpm: null, salience: 1.31,
                  raw_peaks: 166, kept: 166,
                  why: "NO GRID: the best comb scores 0.31 against a typical 0.24 — "
                    + "a salience of 1.31, under the 1.60 bar" };
  p.kick.f0_hz = 96.0;            // a whole octave out — would be a loud card
  p.kick.shape.t30_ms = 400;      // 3.3x ours — would be a loud card
  p.pump.depth_db = -2.0;         // 10 dB off ours — would be a loud card
  const { findings, skipped } = ear.referenceFindings(p, measureFixture(), CTX);
  const kinds = findings.map((f) => f.metric);
  ok("no ref_kick_tune, no ref_kick_decay, no ref_pump — from three deltas that would "
    + "each have been a card",
  !kinds.includes("ref_kick_tune") && !kinds.includes("ref_kick_decay")
    && !kinds.includes("ref_pump"), kinds.join(", "));
  ok("...and the reason travels, carrying the gate's own sentence",
    skipped.some((s) => s.includes("DECLINED") && s.includes("salience")),
    skipped.join(" | ").slice(0, 200));
  /* The half that does not depend on a beat is unaffected — a declined grid
   * must not silently cost the bands and the levels too. */
  const p2 = profileFixture();
  p2.kick.grid.gated = false;
  p2.master.bands.bands[4].observed_db = -3.0;
  ok("...but the BANDS still fire: they never depended on a beat",
    ear.referenceFindings(p2, measureFixture(), CTX).findings
      .some((f) => f.metric === "ref_bands"));
}

console.log("\n  -- a stem with no track in its role is an ARRANGEMENT, not a fader --");
{
  const instrumental = { ...DOC, tracks: DOC.tracks.filter((t) => t.id !== "vx") };
  const m = measureFixture();
  delete m.tracks.vx;
  const { findings, skipped } = ear.referenceFindings(
    profileFixture(), m, { doc: instrumental, nameOf, roles: {} });
  ok("no ref_level finding is built for the vocals this project does not have",
    !findings.some((f) => f.metric === "ref_level" && f.stem === "vocals"),
    findings.filter((f) => f.metric === "ref_level").map((f) => f.stem).join(", "));
  ok("...and the absence is stated in words, naming the roles it looked for",
    skipped.some((s) => s.startsWith("ref_level(vocals)") && /arrangement/.test(s)),
    skipped.join(" | ").slice(0, 200));
}

/* ══════════════════════════════════ THE CRITIC: WHAT IT DOES SAY ═══════ */

console.log("\n  -- ref_bands: the delta is the arithmetic, and the worst three win --");
{
  const p = profileFixture();
  p.master.bands.bands[2].observed_db = -13.5;   // we are +4.0 dB in 120-250
  p.master.bands.bands[6].observed_db = -6.5;    // we are -3.0 dB in 2-4k
  p.master.bands.bands[8].observed_db = -12.5;   // we are +3.0 dB in the air
  p.master.bands.bands[0].observed_db = -11.0;   // +1.5 dB — inside tolerance
  const { findings } = ear.referenceFindings(p, measureFixture(), CTX);
  const bandF = findings.filter((f) => f.metric === "ref_bands");
  ok(`three bands are past ±${ear.REF_TOL.band_db} dB and three findings come back`,
    bandF.length === 3, bandF.map((f) => `${f.band}=${f.delta_db}`).join(", "));
  const low = bandF.find((f) => f.band_index === 2);
  ok("...the delta is exactly ours minus theirs", near(low.delta_db, 4.0, 1e-9), String(low?.delta_db));
  ok("...the band inside tolerance produced nothing",
    !bandF.some((f) => f.band_index === 0));
  ok("...and the WORST band comes first, so a cap of three keeps the three that matter",
    Math.abs(bandF[0].delta_db) >= Math.abs(bandF[1].delta_db)
    && Math.abs(bandF[1].delta_db) >= Math.abs(bandF[2].delta_db),
    bandF.map((f) => f.delta_db).join(", "));

  /* The absent-band rule: an EMPTY band is an arrangement note and an EQ boost
   * there is the single worst advice a mix critic can give. */
  const m = measureFixture();
  m.spectral.bands[2].absent = true;
  ok("an ABSENT band is never a reference finding — that is an arrangement, not EQ",
    !ear.referenceFindings(p, m, CTX).findings.some((f) => f.band_index === 2));

  ok(`no more than ${ear.REF_MAX_BANDS} band findings, whatever the mix does`,
    (() => {
      const wild = profileFixture();
      wild.master.bands.bands.forEach((b, i) => { b.observed_db = -9.5 - (i + 4); });
      return ear.referenceFindings(wild, measureFixture(), CTX).findings
        .filter((f) => f.metric === "ref_bands").length === ear.REF_MAX_BANDS;
    })());
}

console.log("\n  -- ref_kick_tune: THE OCTAVE IS SHAPE, THE NOTE IS KEY --");
{
  /* This is the fault the first live run of this critic produced: it asked to
   * tune a 43.7 Hz kick DOWN 515 cents to meet a reference at 32.4 Hz. That is
   * a tritone. It is not a production difference at all — it is the distance
   * between two songs' keys — and the Ear's own `tuning` critic was at the
   * same moment measuring that kick against THIS song's root. Two critics,
   * total confidence, opposite advice. */
  ok("foldCents: an octave apart is zero cents", near(ear.foldCents(48, 96), 0, 1e-9));
  ok("...two octaves too", near(ear.foldCents(48, 192), 0, 1e-9));
  ok("...and it never leaves (-600, 600]",
    [33, 41, 55, 66, 80, 96, 120].every((hz) => {
      const c = ear.foldCents(48, hz);
      return c > -600 && c <= 600;
    }));

  const p = profileFixture();
  p.kick.f0_hz = 32.4;                        // ours is 48: a fifth apart, same octave
  const same = ear.referenceFindings(p, measureFixture(), CTX);
  ok("A FIFTH APART IN THE SAME OCTAVE IS NOT A FINDING — the live failure, pinned shut",
    !same.findings.some((f) => f.metric === "ref_kick_tune"),
    JSON.stringify(same.findings.filter((f) => f.metric === "ref_kick_tune")).slice(0, 200));
  ok("...and it says why in words: that is the songs' KEYS, and a profile has none",
    same.skipped.some((x) => x.startsWith("ref_kick_tune") && /KEYS/.test(x)
      && /tuning/.test(x)),
    same.skipped.filter((x) => x.startsWith("ref_kick_tune")).join(" | "));

  p.kick.f0_hz = 96.0;                        // a clean octave up
  const f = ear.referenceFindings(p, measureFixture(), CTX).findings
    .find((x) => x.metric === "ref_kick_tune");
  ok("A WHOLE OCTAVE IS a finding — that is a sub-kick against a punchy one",
    f !== undefined && f.register === 1 && f.semitones === 12, JSON.stringify(f && {
      register: f.register, semitones: f.semitones, octaves: f.octaves,
    }));
  ok("...the leftover cents travel, labelled as the part it is NOT asking to change",
    near(f.residual_cents, 0, 1e-6), String(f?.residual_cents));
  ok("...and it carries the knob the tuning critic named, not a guessed one",
    f.knob === "tune" && f.patch === "hybrid_kick" && f.target === "kk");

  p.kick.f0_hz = 48.0 * 2 ** (-1 + 2 / 12);   // an octave down AND a tone off
  const f2 = ear.referenceFindings(p, measureFixture(), CTX).findings
    .find((x) => x.metric === "ref_kick_tune");
  ok("an octave down with a key difference on top asks for the OCTAVE only",
    f2 !== undefined && f2.semitones === -12 && Math.abs(f2.residual_cents) > 150,
    JSON.stringify(f2 && { semitones: f2.semitones, residual: f2.residual_cents }));
  /* And the threshold is a threshold: two thirds of an octave is not one. */
  const p3 = profileFixture();
  p3.kick.f0_hz = 48.0 * 2 ** -0.58;
  ok(`0.58 octaves is under the ${ear.REF_TOL.kick_octaves}-octave bar and produces nothing`,
    !ear.referenceFindings(p3, measureFixture(), CTX).findings
      .some((x) => x.metric === "ref_kick_tune"));

  const built = ear.buildCards([f], { ...CTX, measure: measureFixture() });
  ok("...and its card offers a whole octave, a transpose, and a layer instead",
    built.cards.length === 1 && built.cards[0].routes.length === 3
    && built.cards[0].routes.map((r) => r.id).join(",") === "tune,transpose,layer",
    JSON.stringify(built.cards[0]?.routes.map((r) => r.id)));
  ok("...every one of which is a whole number of semitones",
    built.cards[0].routes.every((r) => r.op.tool !== "daw_set_track"
      || Object.values(r.op.args.params).every((v) => Number.isInteger(v))),
    JSON.stringify(built.cards[0].routes.map((r) => r.op.args.params)));
}

console.log("\n  -- ref_kick_decay and ref_pump: ratios and depths --");
{
  const p = profileFixture();
  p.kick.shape.t30_ms = 60;                    // ours is 120 — exactly 2x theirs
  const f = ear.referenceFindings(p, measureFixture(), CTX).findings
    .find((x) => x.metric === "ref_kick_decay");
  ok("a 2x tail is a finding and the ratio is exact",
    f !== undefined && near(f.ratio, 2.0, 1e-9), String(f?.ratio));
  ok("...and it says WHICH decay number it compared", f.metric_used === "t30");

  const p2 = profileFixture();
  p2.kick.shape.t30_ms = 110;                  // 1.09x — inside tolerance
  ok(`a ${(2 ** ear.REF_TOL.decay_ratio).toFixed(2)}x tolerance means 1.09x is not a card`,
    !ear.referenceFindings(p2, measureFixture(), CTX).findings
      .some((x) => x.metric === "ref_kick_decay"));

  const p3 = profileFixture();
  p3.pump.depth_db = -18.0;                    // ours is -12: 6 dB shallower here
  const pf = ear.referenceFindings(p3, measureFixture(), CTX).findings
    .find((x) => x.metric === "ref_pump");
  ok("a 6 dB shallower duck is a finding", pf !== undefined && near(pf.depth_delta_db, 6, 1e-9));
  ok("...and it names the bass track it was read off, and the kick it is keyed to",
    pf.target === "bs" && pf.against === "kk");
}

console.log("\n  -- ref_width: per band, and the dual-mono refusal --");
{
  const p = profileFixture();
  p.master.width_per_band[7].side_over_mid_db = -18.0;   // we are +7.5 dB wider up there
  const f = ear.referenceFindings(p, measureFixture(), CTX).findings
    .find((x) => x.metric === "ref_width");
  ok("the widest disagreement is the finding", f !== undefined && f.band_index === 7,
    JSON.stringify(f && { b: f.band_index, d: f.delta_db }));
  ok("...and it is called too_wide, not 'wrong'", f.direction === "too_wide");

  const m = measureFixture();
  m.stereo.width = 0;
  ok("a dual-mono mix is NOT called narrow — it has no image at all",
    ear.referenceFindings(p, m, CTX).findings
      .find((x) => x.metric === "ref_width").direction === "dual_mono");

  /* THE SECOND FAULT THE FIRST LIVE RUN PRODUCED: "widen the sub 2.5x",
   * because a demucs-separated reference reads -18 dB of side energy below
   * 60 Hz against our -51. Reported, never offered. */
  const wideSub = profileFixture();
  wideSub.master.width_per_band[0].side_over_mid_db = -18.0;
  const ourNarrowSub = measureFixture();
  ourNarrowSub.shape.width_per_band[0].side_over_mid_db = -51.4;
  const wf = ear.referenceFindings(wideSub, ourNarrowSub, CTX).findings
    .find((x) => x.metric === "ref_width");
  ok("a narrower-than-the-reference SUB is still measured and reported",
    wf !== undefined && wf.band_index === 0 && near(wf.delta_db, -33.4, 0.2),
    JSON.stringify(wf && { b: wf.band_index, d: wf.delta_db }));
  const wb = ear.buildCards([wf], { ...CTX, measure: ourNarrowSub });
  ok("...but NOTHING is offered: no card, and a note with no op at all",
    wb.cards.length === 0 && wb.notes.length === 1 && wb.notes[0].op === null,
    JSON.stringify(wb.notes[0]).slice(0, 160));
  ok("...and the note gives both reasons — mono cancellation, and separation bleed",
    /cancels first/.test(wb.notes[0].why) && /separated stems/.test(wb.notes[0].why),
    String(wb.notes[0].why).slice(0, 200));
  ok("...while the same disagreement in the AIR band is still a card",
    (() => {
      const airP = profileFixture();
      airP.master.width_per_band[8].side_over_mid_db = -30.0;
      const airF = ear.referenceFindings(airP, measureFixture(), CTX).findings
        .find((x) => x.metric === "ref_width");
      return ear.buildCards([airF], { ...CTX, measure: measureFixture() }).cards.length === 1;
    })());
}

/* ═══════════════════════════════════ THE CARDS, AND THE ONE-ROUTE RULE ══ */

console.log("\n  -- every ref_* finding maps to routes the Ear can actually call --");
{
  const TOOLS = new Set(["daw_insert", "daw_mixer", "daw_set_track"]);
  const p = profileFixture();
  p.master.bands.bands[2].observed_db = -13.5;
  p.master.width_per_band[7].side_over_mid_db = -18.0;
  p.kick.f0_hz = 96.0;                        // a whole octave — a register, not a key
  p.kick.shape.t30_ms = 60;
  p.pump.depth_db = -18.0;
  p.stems.drums.level_rel_mix_db = -2.0;      // the drums sit far louder there
  const { findings } = ear.referenceFindings(p, measureFixture(), CTX);
  const kinds = [...new Set(findings.map((f) => f.metric))].sort();
  ok(`all six reference metrics fire on one fixture (${kinds.join(", ")})`,
    kinds.length === 6, kinds.join(", "));

  /* A sidechain compressor on the bass, so ref_pump has knobs to turn. Without
   * it the honest answer is a note, which the next block pins. */
  const docWithSc = {
    ...DOC,
    tracks: DOC.tracks.map((t) => (t.id === "bs"
      ? { ...t, inserts: [{ id: "ins1", type: "compressor",
                            params: { sidechain: "kk", threshold_db: -24, ratio: 4,
                                      release_ms: 120 } }] }
      : t)),
  };
  const ctx2 = { ...CTX, doc: docWithSc, measure: measureFixture() };
  const built = ear.buildCards(findings, ctx2, { maxCards: 99 });
  ok(`every finding became a card or a note (${built.cards.length} + ${built.notes.length})`,
    built.cards.length + built.notes.length === findings.length);
  for (const c of built.cards) {
    ok(`  ${c.metric}: ${c.routes.length} routes, all real tools`,
      c.routes.length >= 2 && c.routes.every((r) => TOOLS.has(r.op.tool)),
      c.routes.map((r) => r.op.tool).join(", "));
    ok(`  ${c.metric}: its routes are distinct outcomes`,
      ear.routesDistinct(c.routes), c.routes.map((r) => r.id).join(", "));
    ok(`  ${c.metric}: every route names the reference or the knob it moves`,
      c.routes.every((r) => r.text.length > 20 && r.why.length > 20));
  }
  ok("the cards name the reference by name, so nobody mistakes it for a rule",
    built.cards.every((c) => c.finding.profile_name === "The Reference"));
}

console.log("\n  -- ref_pump with NO sidechain is a NOTE, not a one-option card --");
{
  const p = profileFixture();
  p.pump.depth_db = -18.0;
  const { findings } = ear.referenceFindings(p, measureFixture(), CTX);
  const pump = findings.find((f) => f.metric === "ref_pump");
  const built = ear.buildCards([pump], { ...CTX, measure: measureFixture() });
  ok("no card", built.cards.length === 0);
  ok("one note, carrying the call that would add the device",
    built.notes.length === 1 && built.notes[0].op?.tool === "daw_insert"
    && built.notes[0].op.args.type === "compressor",
    JSON.stringify(built.notes[0]?.op).slice(0, 160));
  ok("...keyed off the kick, not off nothing",
    built.notes[0].op.args.params.sidechain === "kk");
  ok("...and it says why it is a note rather than a choice",
    /confirmation dialog/.test(built.notes[0].why_not_a_card),
    built.notes[0].why_not_a_card);
}

console.log("\n  -- a reference is a TASTE, so it is ranked below the measurements --");
{
  const refBand = { metric: "ref_bands", delta_db: 6.0, severity: "medium", observed: -3.5 };
  const objBand = { metric: "balance", observed: 6.0, severity: "medium" };
  const rp2 = ear.findingPenalty(refBand);
  const op2 = ear.findingPenalty(objBand);
  ok(`the same 6 dB weighs less as a reference note than as a pink one `
    + `(${rp2.toFixed(2)} vs ${op2.toFixed(2)})`,
  rp2 < op2 && rp2 > 0, `${rp2} / ${op2}`);
  for (const m of ["ref_bands", "ref_level", "ref_width", "ref_kick_tune",
                   "ref_kick_decay", "ref_pump"]) {
    ok(`  ${m} has its own penalty rather than falling to the severity default`,
      ear.findingPenalty({ metric: m, delta_db: 20, observed: 400, ratio: 4,
                           depth_delta_db: 20, severity: "high" })
      !== ear.findingPenalty({ metric: "not_a_metric", severity: "high" }));
  }
}

console.log("\n  -- the A/B guard lets a reference move cost objective penalty --");
{
  const before = { penalty_db: 4, parts: { balance: 2, clipping: 0, true_peak: 0 } };
  const worse = { penalty_db: 6, parts: { balance: 4, clipping: 0, true_peak: 0 } };
  const v = ear.abVerdict(before, worse, { metric: "ref_bands" });
  ok("it is kept and reported as a TRADE, not reverted",
    v.verdict === "traded" && v.reference === true, `${v.verdict}: ${v.reason}`);
  ok("...and the reason says the reference is not the pink curve",
    /pink curve/.test(v.reason));
  const clipped = { penalty_db: 6, parts: { balance: 2, clipping: 2, true_peak: 0 } };
  const v2 = ear.abVerdict(before, clipped, { metric: "ref_bands" });
  ok("BUT a move that makes the file clip is still reverted, reference or not",
    v2.verdict === "revert" && v2.part === "clipping", `${v2.verdict}: ${v2.reason}`);
  const v3 = ear.abVerdict(before, worse, { metric: "balance" });
  ok("...and an objective finding is unaffected — it still reverts",
    v3.verdict === "revert", v3.verdict);
}

/* ═════════════════════════════════════════ THE DOOR, THROUGH THE REAL ONE ═ */

console.log("\n  -- the routes, through the REAL dispatcher, into a scratch dir --");
ok(`the store writes under the scratch dir (${OUT})`, store.DAW_DIR().startsWith(OUT));

if (!store.DAW_DIR().startsWith(OUT)) {
  console.log("  refusing to run the disk half anywhere but the scratch dir");
} else {
  const json = (res, code, body) => { res.writeHead(code, {}); res.end(JSON.stringify(body)); };
  const handle = createDawRoutes({
    json, readBody: async (req) => req.body,
    config: { outputDir: OUT, python: "python", uiPort: 1, stems: { model: "htdemucs_ft" } },
  });
  async function post(body) {
    const cap = { code: 0, out: "" };
    const res = {
      writeHead(c) { cap.code = c; return res; }, setHeader() { return res; },
      write(s) { cap.out += s; return true; }, end(s) { if (s != null) cap.out += s; },
    };
    await handle({ method: "POST", body, headers: {} }, res, new URL("http://daw.test/api/daw"));
    return { code: cap.code, body: JSON.parse(cap.out || "{}") };
  }

  let r = await post({ action: "profile_list" });
  ok("profile_list on an empty machine is an empty list, not an error",
    r.code === 200 && Array.isArray(r.body.profiles) && r.body.profiles.length === 0);
  ok("...and it says where they would live", r.body.dir === refp.profilesDir());

  /* Write one by hand — the python half is refprofile_test.py's job; what is
   * being proved here is the STORE and the summary the list and the tools
   * answer with. */
  await mkdir(refp.profilesDir(), { recursive: true });
  const fixture = { ...profileFixture(), id: "the-ref", built_at: "2026-09-03T00:00:00" };
  await writeFile(path.join(refp.profilesDir(), "the-ref.json"),
    JSON.stringify(fixture), "utf8");

  r = await post({ action: "profile_list" });
  ok("...and it finds one after it is written", r.body.profiles.length === 1);
  const s = r.body.profiles[0];
  ok("the summary carries the numbers a card is built from",
    s.id === "the-ref" && s.lufs === -8.2 && s.kick.f0_hz === 48
    && s.kick.t30_ms === 120 && s.pump.depth_db === -12,
    JSON.stringify(s).slice(0, 200));
  ok("...and it carries the GATE'S VERDICT beside them, because every kick number "
    + "depends on it",
  s.kick.grid_gated === true && s.kick.grid_bpm === 128 && s.kick.grid_salience === 2.4);
  ok("...the four stems' levels come through",
    s.stems.drums.level_rel_mix_db === -8 && s.stems.vocals.level_rel_mix_db === -4);

  r = await post({ action: "profile_get", profile: "the-ref" });
  ok("profile_get answers the WHOLE profile and its summary",
    r.code === 200 && r.body.profile.master.bands.bands.length === 9
    && r.body.summary.id === "the-ref");

  r = await post({ action: "profile_get", profile: "nope" });
  ok("...an unknown id is a 400 that names the ones that exist",
    r.code === 400 && /No such profile "nope"/.test(r.body.error)
    && /profile_list/.test(r.body.error), r.body.error);

  r = await post({ action: "profile_build", file: "not-a-file.wav", separate: false });
  ok("profile_build refuses a file that is in neither folder, naming both",
    r.code === 400 && /reference/.test(r.body.error) && /output root/.test(r.body.error),
    String(r.body.error).slice(0, 200));
  ok("...and it says it never downloads one",
    /never downloads/.test(r.body.error), String(r.body.error).slice(0, 240));

  r = await post({ action: "profile_build", file: "../../etc/passwd" });
  ok("a path is not a filename here", r.code === 400 && /bare|name of an audio file/.test(r.body.error),
    String(r.body.error).slice(0, 160));

  r = await post({ action: "profile_delete", profile: "nope" });
  ok("deleting what is not there is a 400, not a silent ok", r.code === 400);
  r = await post({ action: "profile_delete", profile: "the-ref" });
  ok("deleting what is there works, and says the stems are not its to delete",
    r.code === 200 && r.body.deleted === "the-ref" && /stems/.test(r.body.note));
  ok("...and it is gone", (await post({ action: "profile_list" })).body.profiles.length === 0);

  /* THE UNKNOWN-ACTION SENTENCE. Two of the four dispatchers are mounts, so a
   * scrape of routes.js sees `${...}` where their names should be — this is
   * fetched from the real dispatcher and read. */
  r = await post({ action: "no_such_action_at_all" });
  const msg = String(r.body.error || "");
  ok("the unknown-action message names all four profile actions",
    refp.REFPROFILE_ACTIONS.every((a) => msg.includes(a)),
    refp.REFPROFILE_ACTIONS.filter((a) => !msg.includes(a)).join(", "));
}

/* ══════════════════════════════════════════════════ THE AGENT'S HAND ═══ */

console.log("\n  -- and an agent can reach every one of them --");
{
  const tools = dawTools(async () => ({}), (x) => x);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const posts = new Map();
  for (const t of tools) {
    for (const m of String(t.run).matchAll(/action:\s*"([a-z0-9_]+)"/g)) {
      posts.set(m[1], t.name);
    }
  }
  for (const a of refp.REFPROFILE_ACTIONS) {
    ok(`${a} has a tool (${posts.get(a) || "NONE"})`, posts.has(a));
  }
  const build = byName.daw_profile_build;
  ok("daw_profile_build states the shape rule in its own description",
    /SHAPE, NEVER A SAMPLE/.test(build.description)
    && /No audio/.test(build.description));
  ok("...and the 44.1 kHz decision, with the reason",
    /44\.1/.test(build.description) && /k_weight/.test(build.description));
  ok("...and it warns about the grid gate, by field name",
    /grid_gated/.test(build.description) && /442 BPM/.test(build.description));
  const critDesc = byName.daw_critique.inputSchema.properties.profile.description;
  ok("daw_critique takes a profile and explains what one is, and is not",
    /dB numbers/.test(critDesc) && /NO audio/.test(critDesc)
    && /ref_bands/.test(critDesc) && /ref_pump/.test(critDesc),
    critDesc.slice(0, 160));
  ok("...and warns that a match is a preference, not a measurement",
    /preference/.test(byName.daw_critique.inputSchema.properties.profile.description));
  ok("every profile tool refuses unknown arguments",
    refp.REFPROFILE_ACTIONS.map((a) => byName[`daw_${a.replace("profile_", "profile_")}`])
      .filter(Boolean)
      .every((t) => t.inputSchema.additionalProperties === false));
}

await rm(OUT, { recursive: true, force: true }).catch(() => {});

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
