/**
 * THE EAR — the loop, run for real on a deliberately flawed 8-bar project.
 *
 * Builds a mix with three planted faults — the bass too loud, a pad masking
 * the lead in the low-mids, and no headroom on the master — bounces it,
 * listens, prints the cards and the exact MCP calls their routes would make,
 * runs the delegated auto pass, bounces again, and prints the before/after
 * measurements side by side.
 *
 * ACTOR HONESTY, live: every call this script makes carries
 * `x-aiplay-actor: agent:ear-demo`, because a script is not a browser. So the
 * delegation records as a RELAYED agent delegation, every auto decision
 * records as `judge` (actor agent:ear-demo), and the human-only controls —
 * review, bulk accept, approve — are REFUSED. The refusals are printed: they
 * are the invariant working, not a bug.
 *
 *   AIPLAY_UI_PORT=4274 node server/index.js
 *   node scripts/ear_loop_demo.mjs 4274
 */
const PORT = process.argv[2] || "4274";
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG_NAME = process.argv[3] || "Ear Demo Flawed";
const ACTOR = "agent:ear-demo";

const log = (...a) => console.log(...a);
const H = { "Content-Type": "application/json", "x-aiplay-actor": ACTOR };

async function daw(body) {
  const r = await fetch(`${BASE}/api/daw`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(`${body.action}: ${j.error}`);
  return j;
}
async function ear(body) {
  const r = await fetch(`${BASE}/api/daw/ear`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(`${body.action}: ${j.error}`);
  return j;
}
const earTry = async (body) => {
  try { return { ok: true, r: await ear(body) }; }
  catch (e) { return { ok: false, why: e.message }; }
};
async function get(p) {
  const r = await fetch(`${BASE}${p}`, { headers: { "x-aiplay-actor": ACTOR } });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
}

const dB = (v, u = "", d = 2) => (v === null || v === undefined ? "  –    " : `${Number(v).toFixed(d)}${u}`);

/* ══════════════════════════════════════════════════ 1. the flawed project */

log("\n──────────── building a deliberately flawed 8-bar mix ────────────");

const proj = await daw({ action: "create", name: SLUG_NAME, bpm: 120, num: 4, den: 4,
                         length_bars: 8 });
const slug = proj.slug;

/* add_track lands a clip spanning the project, so the notes have somewhere to go. */
const bass = (await daw({ action: "add_track", slug, instrument: "pluck", name: "bass" })).trackId;
const pad = (await daw({ action: "add_track", slug, instrument: "pad", name: "pad" })).trackId;
const lead = (await daw({ action: "add_track", slug, instrument: "pluck", name: "lead vox" })).trackId;

/* A root-movement bass on every beat, a sustained pad chord per bar, and a
 * lead line sitting right where the pad's body is. */
const ROOTS = [40, 40, 45, 45, 43, 43, 38, 40];         // E1..D1-ish
for (let bar = 1; bar <= 8; bar++) {
  for (let beat = 1; beat <= 4; beat++) {
    await daw({ action: "add_note", slug, track: bass, bar, beat, tick: 0,
                pitch: ROOTS[bar - 1], vel: 118, dur_ticks: 900 });
  }
  // the pad: a triad in the 250-500 Hz region, held the whole bar
  for (const p of [60, 64, 67]) {
    await daw({ action: "add_note", slug, track: pad, bar, beat: 1, tick: 0,
                pitch: p, vel: 112, dur_ticks: 3840 });
  }
  // the lead: a melody in the SAME region, so the pad has something to bury
  const mel = [64, 67, 69, 67];
  for (let beat = 1; beat <= 4; beat++) {
    await daw({ action: "add_note", slug, track: lead, bar, beat, tick: 0,
                pitch: mel[(bar + beat) % 4], vel: 90, dur_ticks: 700 });
  }
}

/* THE THREE PLANTED FAULTS */
await daw({ action: "mixer_set", slug, target: bass, fader: 9 });     // bass too loud
await daw({ action: "mixer_set", slug, target: pad, fader: 6 });      // pad masking
await daw({ action: "mixer_set", slug, target: lead, fader: -6 });    // lead buried
await daw({ action: "mixer_set", slug, target: "master", fader: 9 }); // no headroom

log(`  project ${slug}: bass ${bass} (+9 dB), pad ${pad} (+6 dB), lead ${lead} (-6 dB), master +9 dB`);

/* ══════════════════════════════════════════════════ 2. bounce BEFORE */

log("\n──────────── bounce BEFORE ────────────");
await daw({ action: "render", slug });
const bBefore = await daw({ action: "bounce", slug });
log(`  ${bBefore.file}  (${bBefore.seconds}s)`);
const mBefore = await ear({ action: "analyse_file", path: bBefore.file });

/* ══════════════════════════════════════════════════ 3. what the Ear is */

const status = await get("/api/daw/ear/status");
log("\n──────────── the ear, on this machine ────────────");
log(`  objective critics : ${status.objective.critics.map((c) => c.metric).join(", ")}`);
log(`  band tables agree : ${status.objective.bands_agree}`);
log(`  subjective judge  : ${status.subjective.available ? "AVAILABLE" : "ABSENT"}`
  + `${status.subjective.available ? "" : " — " + Object.entries(status.subjective.judges || {})
    .map(([k, v]) => `${k} (${v.licence}) not installed`).join("; ")}`);
if (!status.subjective.available) log(`  degrades to       : ${status.subjective.degrades_to}`);

/* ══════════════════════════════════════════════════ 4. LISTEN */

log("\n──────────── the critique pass ────────────");
const c = await ear({ action: "critique", slug, genre: "pop" });
log(`  run ${c.run} · ${c.ms} ms · stems: ${c.stems.join(", ")}`);
log(`  master: ${dB(c.measure.master.lufs, " LUFS")}  tp ${dB(c.measure.master.true_peak_db, " dBTP")}`
  + `  crest ${dB(c.measure.master.crest_db, " dB")}  width ${dB(c.measure.stereo.width, "", 3)}`
  + `  penalty ${dB(c.score.penalty_db, " dB")}`);
for (const [tid, t] of Object.entries(c.measure.tracks)) {
  log(`    ${tid.padEnd(10)} ${dB(t.lufs, " LUFS")}`);
}
log(`\n  ${c.cards.length} card(s), ${c.notes.length} note(s)`
  + `${c.over_cap ? `, ${c.over_cap} held back by the cap` : ""}`);
for (const card of c.cards) {
  log(`\n  ── [${card.severity}] ${card.observation}`);
  log(`     ${card.where} · ${card.how_much}`);
  for (const r of card.routes) {
    log(`      (${r.id}) ${r.text}`);
    log(`           ${r.op.tool} ${JSON.stringify(r.op.args)}`);
  }
  log("      (free text) your own direction… — always offered");
}
for (const n of c.notes) log(`\n  ── note: ${n.observation} — ${n.why_not_a_card}`);

/* ═══════════════════════════════ 5. the invariant, over the wire */

log("\n──────────── what a machine is NOT allowed to record ────────────");
for (const [what, body] of [
  ["review (ratify its own decision)", { action: "review", slug, run: c.run, card: c.cards[0]?.id, verdict: "keep" }],
  ["bulk_accept (a human convenience)", { action: "bulk_accept", slug, run: c.run }],
  ["approve (the act of listening)", { action: "approve", slug, run: c.run, listened_seconds: 200 }],
]) {
  const t = await earTry(body);
  log(`  ${t.ok ? "!! ALLOWED (BUG)" : "refused"} — ${what}`);
  if (!t.ok) log(`      "${t.why}"`);
}
const noDel = await earTry({ action: "answer", slug, run: c.run, card: c.cards[0]?.id,
                             choice: c.cards[0]?.routes[0]?.id });
log(`  ${noDel.ok ? "!! ALLOWED (BUG)" : "refused"} — answering a card with no delegation on record`);
if (!noDel.ok) log(`      "${noDel.why}"`);

/* ══════════════════════════════════════════════════ 6. the delegated run */

log("\n──────────── auto-progression, under a recorded delegation ────────────");
const brief = "Bass is swamping everything and the lead has vanished. "
  + "Open it up, get the lead back, and leave me some headroom.";
const auto = await ear({ action: "auto", slug, brief, genre: "pop", iterations: 3 });
log(`  run ${auto.run} · delegate event ${auto.delegate}`);
for (const j of auto.judgements) {
  log(`\n  ── ${j.observation}`);
  log(`     chose "${j.chosen}" from {${j.options.map((o) => o.id).join(", ")}}`);
  log(`     verdict ${j.verdict}${j.reverted ? " → REVERTED" : ""}`
    + `  (penalty ${j.improvement_db >= 0 ? "-" : "+"}${Math.abs(j.improvement_db)} dB)`);
}
log(`\n  penalty ${dB(auto.before.penalty_db, " dB")} → ${dB(auto.after.penalty_db, " dB")}`);

/* THE CAP IS REAL: three iterations and it stops, whatever is left. That is
 * the loop terminating honestly, not the mix being finished — so here is what
 * a human does next, which is run it again. Each pass is its own delegation. */
log("\n──────────── a second pass — the cap stopped it, not the mix ────────────");
const auto2 = await ear({ action: "auto", slug, genre: "pop", iterations: 3,
                          brief: "still too loud and the lead is still buried — keep going" });
log(`  run ${auto2.run} · delegate event ${auto2.delegate}`);
for (const j of auto2.judgements) {
  log(`\n  ── ${j.observation}`);
  log(`     chose "${j.chosen}" from {${j.options.map((o) => o.id).join(", ")}}`);
  log(`     verdict ${j.verdict}${j.reverted ? " → REVERTED" : ""}`
    + `  (penalty ${j.improvement_db >= 0 ? "-" : "+"}${Math.abs(j.improvement_db)} dB)`);
}
log(`\n  penalty ${dB(auto2.before.penalty_db, " dB")} → ${dB(auto2.after.penalty_db, " dB")}`);

const rc = await ear({ action: "review_cards", slug, run: auto2.run });
log(`  review checkpoint: ${rc.cards.length} decision(s) waiting for a human`);

/* ══════════════════════════════════════════════════ 7. bounce AFTER */

log("\n──────────── bounce AFTER ────────────");
await daw({ action: "render", slug });
const bAfter = await daw({ action: "bounce", slug });
log(`  ${bAfter.file}  (${bAfter.seconds}s)`);
const mAfter = await ear({ action: "analyse_file", path: bAfter.file });

const row = (label, a, b, unit = "", dp = 2) =>
  log(`  ${label.padEnd(22)} ${dB(a, unit, dp).padStart(10)}  →  ${dB(b, unit, dp).padStart(10)}`);
log("\n──────────── before → after, measured on the two bounce files ────────────");
row("integrated LUFS", mBefore.measure.master.lufs, mAfter.measure.master.lufs);
row("true peak dBTP", mBefore.measure.master.true_peak_db, mAfter.measure.master.true_peak_db);
row("peak dBFS", mBefore.measure.master.peak_db, mAfter.measure.master.peak_db);
row("crest dB", mBefore.measure.master.crest_db, mAfter.measure.master.crest_db);
row("LUFS range", mBefore.measure.master.lufs_range, mAfter.measure.master.lufs_range);
row("stereo width", mBefore.measure.stereo.width, mAfter.measure.stereo.width, "", 4);
row("clipped samples", mBefore.measure.clipping.clipped_samples,
    mAfter.measure.clipping.clipped_samples, "", 0);
row("objective penalty", mBefore.score.penalty_db, mAfter.score.penalty_db);
log("\n  per band (dB off the pop reference curve):");
for (let i = 0; i < mBefore.measure.spectral.bands.length; i++) {
  const a = mBefore.measure.spectral.bands[i], b = mAfter.measure.spectral.bands[i];
  log(`    ${a.band.padEnd(12)} ${String(a.deviation_db).padStart(7)}  →  ${String(b.deviation_db).padStart(7)}`);
}

/* ══════════════════════════════════════════════════ 8. the ledger */

const led = await get(`/api/daw/ear/ledger/${slug}`);
log("\n──────────── the provenance ledger ────────────");
log(`  chain ${led.chain.ok ? "intact" : "BROKEN"} · ${led.total} event(s)`);
log(`  actors: ${JSON.stringify(led.actors)}`);
const byType = {};
for (const e of led.events) byType[e.type] = (byType[e.type] || 0) + 1;
log(`  types : ${JSON.stringify(byType)}`);
for (const e of led.events.filter((x) => ["delegate", "judge", "choice", "approve"].includes(x.type))) {
  log(`   ${e.t} ${String(e.actor).padEnd(14)} ${e.type.padEnd(9)} `
    + `${e.data.chosen ?? e.data.brief?.slice(0, 40) ?? ""}`);
}

log("\n──────────── files ────────────");
log(`  BEFORE  ${bBefore.file}`);
log(`  AFTER   ${bAfter.file}`);
log(`  project ${slug} (kept on purpose — delete it with daw action "delete")\n`);
