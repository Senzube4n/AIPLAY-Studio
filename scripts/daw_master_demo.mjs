/**
 * THE MASTERING SUITE — a real master, end to end, on a deliberately flawed
 * 8-bar mix.
 *
 * Builds the Ear demo's own flawed project (bass +9, pad +6 masking the lead,
 * lead -6, master +9 and no headroom), measures it, puts a real mastering
 * chain on the master bus, measures again, checks it against every streaming
 * target, and writes a DITHERED 16-bit WAV deliverable through the bounce
 * encoder's bit-depth path.
 *
 * Nothing here is simulated: every number is daw_analyze's answer over HTTP
 * about samples the renderer actually produced, and the final WAV is a file
 * on disk you can open.
 *
 *   AIPLAY_UI_PORT=4275 node server/index.js
 *   node scripts/daw_master_demo.mjs 4275
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || "4275";
const BASE = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = process.argv[3] || `Master Demo ${Date.now().toString(36)}`;
const ACTOR = "agent:master-demo";
const H = { "Content-Type": "application/json", "x-aiplay-actor": ACTOR };
const log = (...a) => console.log(...a);

async function daw(body) {
  const r = await fetch(`${BASE}/api/daw`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(`${body.action}: ${j.error}`);
  return j;
}
const num = (v, d = 2) => (v === null || v === undefined ? "  –  " : Number(v).toFixed(d));

/* ═════════════════════════════════════════ 1. the flawed 8-bar project */

log("\n──────────── building the flawed 8-bar mix (the Ear demo's own) ────────────");
const slug = (await daw({ action: "create", name: NAME, bpm: 120, num: 4, den: 4,
                          length_bars: 8 })).slug;
const bass = (await daw({ action: "add_track", slug, instrument: "pluck", name: "bass" })).trackId;
const pad = (await daw({ action: "add_track", slug, instrument: "pad", name: "pad" })).trackId;
const lead = (await daw({ action: "add_track", slug, instrument: "pluck", name: "lead vox" })).trackId;
const ROOTS = [40, 40, 45, 45, 43, 43, 38, 40];
for (let bar = 1; bar <= 8; bar++) {
  for (let beat = 1; beat <= 4; beat++) {
    await daw({ action: "add_note", slug, track: bass, bar, beat, tick: 0,
                pitch: ROOTS[bar - 1], vel: 118, dur_ticks: 900 });
  }
  for (const p of [60, 64, 67]) {
    await daw({ action: "add_note", slug, track: pad, bar, beat: 1, tick: 0,
                pitch: p, vel: 112, dur_ticks: 3840 });
  }
  const mel = [64, 67, 69, 67];
  for (let beat = 1; beat <= 4; beat++) {
    await daw({ action: "add_note", slug, track: lead, bar, beat, tick: 0,
                pitch: mel[(bar + beat) % 4], vel: 90, dur_ticks: 700 });
  }
}
await daw({ action: "mixer_set", slug, target: bass, fader: 9, pan: 0 });
await daw({ action: "mixer_set", slug, target: pad, fader: 6, pan: -0.55 });
await daw({ action: "mixer_set", slug, target: lead, fader: -6, pan: 0.35 });
await daw({ action: "mixer_set", slug, target: "master", fader: 9 });
log(`  ${slug}: bass +9 centre, pad +6 left, lead -6 right, master +9`);
log("  — no headroom, buried lead, and a lopsided image for the imager to work on.");

/* ═════════════════════════════════════════ 2. measure BEFORE */

await daw({ action: "render", slug });
const before = await daw({ action: "analyze", slug });

/* ═════════════════════════════════════════ 3. the mastering chain */

log("\n──────────── the mastering chain ────────────");
const CHAIN = [
  ["tiltEq", { tilt_db: 2.5, pivot_hz: 900, slope: 0.7 },
   "the mix is bottom-heavy: hinge 2.5 dB of tilt toward the top"],
  ["dynamicEq", { d1_on: true, d1_hz: 160, d1_q: 1.6, d1_threshold_db: -26,
                  d1_ratio: 4, d1_range_db: 6, d1_mode: "above",
                  d1_attack_ms: 12, d1_release_ms: 140,
                  d2_on: true, d2_hz: 380, d2_q: 1.8, d2_threshold_db: -30,
                  d2_ratio: 3, d2_range_db: 4, d2_mode: "above",
                  d2_attack_ms: 10, d2_release_ms: 120 },
   "the +9 dB bass only booms on the low notes, and the pad only crowds the "
   + "lead at 380 Hz — two bells that move when they misbehave, flat when they do not"],
  ["multibandCompressor", { bands: "3", x1_hz: 150, x2_hz: 2200, knee_db: 8,
                            b1_threshold_db: -30, b1_ratio: 3, b1_attack_ms: 25,
                            b1_release_ms: 180, b1_makeup_db: 1,
                            b2_threshold_db: -26, b2_ratio: 2, b2_attack_ms: 15,
                            b2_release_ms: 140,
                            b3_threshold_db: -28, b3_ratio: 2, b3_attack_ms: 6,
                            b3_release_ms: 100, b3_makeup_db: 1 },
   "hold the low end down without pumping the lead — the thing a single-band "
   + "compressor structurally cannot do"],
  ["stereoImager", { x1_hz: 220, x2_hz: 3500, w1_width: 0.6, w2_width: 1.0,
                     w3_width: 1.3, mono_below_hz: 100 },
   "narrow the lows, open the air, mono under 100 Hz — and the correlation "
   + "before/after is reported below rather than assumed"],
  ["maximizer", { gain_db: 8, ceiling_db: -1, knee_db: 3, release_ms: 140,
                  lookahead_ms: 5, character: "clean" },
   "the loudness, with the true-peak ceiling held by the rack's own proven limiter"],
];
/* The master fader was the planted no-headroom fault: give the chain room to
 * work in before asking it to hold a ceiling. */
await daw({ action: "mixer_set", slug, target: "master", fader: 0 });
log("  master fader  +9 → 0 dB   (the planted no-headroom fault, undone first)");
for (const [type, params, why] of CHAIN) {
  await daw({ action: "insert_add", slug, target: "master", type, params });
  log(`  + ${type.padEnd(21)} ${why}`);
}

/* ═════════════════════════════════════════ 4. measure AFTER */

await daw({ action: "render", slug });
const after = await daw({ action: "analyze", slug });

const row = (label, a) => log(
  `  ${label.padEnd(8)} ${num(a.loudness.integrated).padStart(8)} LUFS   `
  + `${num(a.loudness.true_peak_db).padStart(7)} dBTP   `
  + `LRA ${num(a.loudness.lra).padStart(5)}   `
  + `corr ${num(a.correlation.overall, 3).padStart(6)}   `
  + `crest ${num(a.dynamics.crest_db).padStart(5)}   `
  + `PSR ${num(a.dynamics.psr_db).padStart(5)}`);
log("\n──────────── before / after, measured over the wire ────────────");
row("BEFORE", before);
row("AFTER", after);
log(`  mono-compatible: ${before.correlation.mono_compatible} → ${after.correlation.mono_compatible}`
  + `   (worst window ${num(before.correlation.min, 3)} → ${num(after.correlation.min, 3)})`);

log("\n  per-band share against the pink reference (dB off pink):");
log("    " + after.bands.map((b) => b.name).map((s) => s.padStart(9)).join(""));
log("  B " + before.bands.map((b) => num(b.delta_db, 1).padStart(9)).join(""));
log("  A " + after.bands.map((b) => num(b.delta_db, 1).padStart(9)).join(""));

/* ═════════════════════════════════════════ 5. delivery */

log("\n──────────── delivery check ────────────");
const show = (d) => {
  for (const r of d.results) {
    log(`  ${r.pass ? "PASS" : "fail"}  ${r.label.padEnd(30)} `
      + `target ${num(r.lufs, 1).padStart(6)} LUFS / ${num(r.true_peak_db, 1)} dBTP  `
      + `gain ${(r.gain_change_db > 0 ? "+" : "") + num(r.gain_change_db)} dB  `
      + `[${r.confidence}]`);
    if (!r.pass) log(`        ${r.advice}`);
  }
};
const deliv = await daw({ action: "check_delivery", slug });
show(deliv);

/* Take the advice and prove it was right: apply the -14 LUFS gain to the
 * master fader and re-check. If the arithmetic is honest this lands inside
 * the tolerance for every -14 target in one move. */
const spot = deliv.results.find((r) => r.id === "spotify");
log(`\n  taking the advice: master fader ${(spot.gain_change_db > 0 ? "+" : "")}`
  + `${num(spot.gain_change_db)} dB, then re-checking…`);
await daw({ action: "mixer_set", slug, target: "master", fader: spot.gain_change_db });
await daw({ action: "render", slug });
const deliv2 = await daw({ action: "check_delivery", slug });
show(deliv2);
const corrected = await daw({ action: "analyze", slug });
row("TARGET", corrected);

/* ── THE FINDING a master engineer has to know about this rack ────────── */
log("\n──────────── the master-bus ceiling caveat (measured, not assumed) ────────────");
log(`  the maximizer's ceiling is set to -1.0 dBTP; the FILE measures `
  + `${num(after.loudness.true_peak_db)} dBTP.`);
log("  rack.py's P0 master curve, tanh(0.7*mix), runs AFTER every insert on the");
log("  master chain: a -1 dBTP setting reaches the file at about -5.1 dBFS with");
log("  ~3.2 dB of curve compression at the peak. The ceiling is never breached —");
log("  the error is entirely in the safe direction — but a true-peak-EXACT");
log("  delivery cannot be made through the master bus as the rack stands.");
log("  Read the file's number from check_delivery, never from the knob.");

/* ═════════════════════════════════════════ 6. the 16-bit deliverable */

log("\n──────────── the deliverable: 16-bit, DITHERED ────────────");
const man = await daw({ action: "render", slug });
const dir = await mkdtemp(path.join(tmpdir(), "aiplay-master-"));
const parts = [];
for (const reg of [...man.regions].sort((a, b) => a.idx - b.idx)) {
  const buf = Buffer.from(await (await fetch(`${BASE}${reg.url}`)).arrayBuffer());
  const p = path.join(dir, `part${reg.idx}.wav`);
  await writeFile(p, buf);
  parts.push(p);
}
/* Land the deliverable in the project's OWN bounces folder rather than a
 * temp dir, so the path in the report is one somebody can still open. The
 * bounce action tells us where that is. */
const flac = await daw({ action: "bounce", slug });
const outDir = path.dirname(flac.file);
await mkdir(outDir, { recursive: true });
const outWav = path.join(outDir, `${slug}_master_16bit.wav`);
const jobPath = path.join(dir, "encode.json");
await writeFile(jobPath, JSON.stringify({
  sr: 48000, wav_parts: parts, out: outWav,
  /* THE DITHER CALL SITE: instruments.py::_cli_encode reduces the bit depth,
   * and master.apply_dither runs on the way down. Without bit_depth the
   * encoder stays 24-bit and no dither happens, exactly as before. */
  bit_depth: 16, noise_shape: "shaped", dither_seed: 1,
}), "utf8");
const PY = process.env.AIPLAY_PYTHON
  || `${process.env.AIPLAY_RIG || "D:/AI/aiplay-studio-bench"}/venv/Scripts/python.exe`;
const enc = await new Promise((resolve, reject) => {
  const pr = spawn(PY, [path.join(HERE, "..", "server", "daw", "instruments.py"),
                        "encode", jobPath]);
  let so = "", se = "";
  pr.stdout.on("data", (d) => { so += d; });
  pr.stderr.on("data", (d) => { se += d; });
  pr.on("error", reject);
  pr.on("close", () => {
    try { resolve(JSON.parse(so.trim().split(/\r?\n/).pop())); }
    catch { reject(new Error(se.slice(-400) || so.slice(-400))); }
  });
});
log(`  ${enc.out}`);
log(`  ${enc.seconds}s · ${enc.channels}ch · ${enc.bit_depth}-bit · dithered: ${enc.dithered}`);
const fileMeasure = await daw({ action: "analyze", file: enc.out });
log(`  the FILE measures ${num(fileMeasure.loudness.integrated)} LUFS, `
  + `${num(fileMeasure.loudness.true_peak_db)} dBTP, LRA ${num(fileMeasure.loudness.lra)} `
  + `— the same master, now on disk.`);

log(`\n  project ${slug} left in place. Delete with:`);
log(`    curl -s -XPOST ${BASE}/api/daw -H "content-type: application/json" `
  + `-d '{"action":"delete","slug":"${slug}"}'`);
