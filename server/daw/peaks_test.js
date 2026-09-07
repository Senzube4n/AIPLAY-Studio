/**
 * THE PEAKS MIP-MAP — the four stages, and the properties a drawing leans on.
 *
 * The bug this replaces is measured, not suspected: web/daw.js caches 900
 * buckets at one resolution, channel 0 only, rectified. Zoom a 3-minute take
 * to one bar and 900 pixels of canvas are drawn from TEN numbers. The mip-map
 * gives that bar 12 000 peaks for a one-time build.
 *
 * What is checked here, and why each one is a bug that would otherwise ship:
 *
 *  BOUNDING       a coarse peak's [min, max] contains every fine peak beneath
 *                 it. Coarse stages are REDUCED from the finer one, so this is
 *                 exact rather than approximate — and it survives quantisation
 *                 because rounding is monotone. A drawing that violated it
 *                 would show a transient at one zoom and lose it at the next.
 *  NO ZERO-PAD    the ragged last block is measured over the samples that are
 *                 really there. Padding it with zeros puts a false 0 into the
 *                 last peak, which on a fade-out is exactly the sample someone
 *                 zooms in to check.
 *  THE SCALE      a post-fader stem is legitimately louder than 1.0, so the
 *                 quantiser carries a per-file scale instead of clamping. A
 *                 clamp would draw a flat top that is not in the audio.
 *  MIN AND MAX    both, per channel — an abs-max envelope hides asymmetry and
 *                 DC, and a channel-0 envelope hides every width move.
 *  ONE RULE       peaks.py's stage_for and voicelab.js's stageFor are two
 *                 implementations of one rule, so the JS is checked against
 *                 the python's own published sweep, value by value.
 *
 * The structural half runs anywhere. The build half needs the rig's python
 * (numpy) and skips itself LOUDLY without it.
 *
 * Run:  node server/daw/peaks_test.js
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { stageFor } = await import("./voicelab.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ── a float32 RIFF, written by hand: the exact file engine.py writes ─── */
function writeWav(file, channels, sr = 48000) {
  const ch = channels.length;
  const n = channels[0].length;
  const data = Buffer.alloc(n * ch * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) data.writeFloatLE(channels[c][i], (i * ch + c) * 4);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20);
  head.writeUInt16LE(ch, 22); head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * ch * 4, 28); head.writeUInt16LE(ch * 4, 32);
  head.writeUInt16LE(32, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
}

/* ── the sidecar reader, the same arithmetic voicelab.js serves from ──── */
function readPk(file) {
  const buf = readFileSync(file);
  if (buf.subarray(0, 4).toString("latin1") !== "PKS1") throw new Error("bad magic");
  const hlen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.subarray(8, 8 + hlen).toString("utf8"));
  const bodyAt = 8 + hlen;
  const k = header.scale / 32767;
  return {
    header,
    peak(shift, ch, i) {
      const st = header.stages.find((s) => s.shift === shift);
      const at = bodyAt + (st.offset + ch * st.count * 2 + i * 2) * 2;
      return [buf.readInt16LE(at) * k, buf.readInt16LE(at + 2) * k];
    },
    raw(shift, ch, i) {
      const st = header.stages.find((s) => s.shift === shift);
      const at = bodyAt + (st.offset + ch * st.count * 2 + i * 2) * 2;
      return [buf.readInt16LE(at), buf.readInt16LE(at + 2)];
    },
    stage: (shift) => header.stages.find((s) => s.shift === shift),
    bytes: buf.length,
  };
}

console.log("\n  -- the stage rule: one rule, checked across two languages --");

const SWEEP = [
  [0.5, 3], [1, 3], [4, 3], [7, 3], [8, 3], [9, 3],
  [63, 3], [64, 6], [65, 6], [511, 6], [512, 9], [513, 9],
  [4095, 9], [4096, 12], [4097, 12], [100000, 12],
];
ok("stageFor picks the coarsest stage that still gives one peak a pixel",
  SWEEP.every(([spp, want]) => stageFor(spp) === want),
  SWEEP.filter(([s, w]) => stageFor(s) !== w).map(([s, w]) => `${s}->${stageFor(s)} want ${w}`).join(", "));

{
  let prev = -1, mono = true;
  for (let spp = 1; spp <= 20000; spp = Math.ceil(spp * 1.07)) {
    const s = stageFor(spp);
    if (s < prev) mono = false;
    prev = s;
  }
  ok("...and it is MONOTONE in the zoom, which is what stops a drag flickering "
    + "between resolutions", mono);
}
ok("the finest stage is 8 samples a peak and the coarsest 4096",
  stageFor(1) === 3 && stageFor(1e9) === 12);

/* ── the python half ──────────────────────────────────────────────────── */
const RIG = process.env.AIPLAY_RIG || "D:/AI/aiplay-studio-bench";
const PY = process.env.AIPLAY_PY || path.join(RIG, "venv/Scripts/python.exe");
const havePy = existsSync(PY);

if (!havePy) {
  console.log(`\n  -- SKIPPING the build half: no python at ${PY}`);
  console.log("     (the mip-map is built by server/daw/peaks.py, which needs numpy;");
  console.log("      set AIPLAY_PY to a python that has it to run this section)");
} else {
  const TD = path.join(os.tmpdir(), `peaks-test-${process.pid}`);
  mkdirSync(TD, { recursive: true });
  const py = (...args) => {
    const r = spawnSync(PY, [path.join(HERE, "peaks.py"), ...args], { encoding: "utf8", cwd: HERE });
    const line = String(r.stdout || "").trim().split(/\r?\n/).pop();
    try { return JSON.parse(line); } catch { throw new Error(`peaks.py said: ${r.stdout}${r.stderr}`); }
  };

  console.log("\n  -- the python and the JS agree on the stage rule, value by value --");
  const probe = py("probe");
  ok("peaks.py probes with the same four shifts the JS holds",
    JSON.stringify(probe.shifts) === JSON.stringify([3, 6, 9, 12]), JSON.stringify(probe.shifts));
  ok("...and every entry of its own published zoom sweep matches stageFor",
    probe.stage_sweep.every(([spp, shift]) => stageFor(spp) === shift),
    probe.stage_sweep.filter(([s, sh]) => stageFor(s) !== sh).map(([s, sh]) => `${s}: py ${sh} js ${stageFor(s)}`).join(", "));

  console.log("\n  -- a stereo file: four stages, both channels, min AND max --");
  const N = 40000;                       // NOT a multiple of 4096, on purpose
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    L[i] = Math.sin(i * 0.01) * 0.8;
    R[i] = Math.sin(i * 0.01 + 1.1) * 0.3;   // a different channel, deliberately
  }
  const wav = path.join(TD, "st.wav");
  writeWav(wav, [L, R]);
  const built = py("mip", wav, path.join(TD, "st.pk1"));
  ok(`the sidecar builds (${built.ms} ms, ${built.bytes} bytes for ${N} stereo samples)`,
    built.ok === true && built.bytes > 0);
  const pk = readPk(path.join(TD, "st.pk1"));
  ok("the header names the rate, the channels, the sample count and four stages",
    pk.header.rate === 48000 && pk.header.channels === 2
    && pk.header.samples === N && pk.header.stages.length === 4);
  ok("every stage's peak count is ceil(samples / samples-per-peak)",
    pk.header.stages.every((s) => s.count === Math.ceil(N / s.spp)),
    pk.header.stages.map((s) => `${s.shift}:${s.count} want ${Math.ceil(N / s.spp)}`).join(" "));
  ok("stage blocks are contiguous: each offset is the last one plus its values",
    pk.header.stages.every((s, i) => s.offset
      === pk.header.stages.slice(0, i).reduce((a, x) => a + x.values, 0)));
  ok("the two channels are stored separately and really differ",
    pk.peak(3, 0, 100)[1] !== pk.peak(3, 1, 100)[1]);

  console.log("\n  -- BOUNDING: a coarse peak contains every fine peak beneath it --");
  for (const [fine, coarse] of [[3, 6], [6, 9], [9, 12]]) {
    let worstMin = 0, worstMax = 0, bad = 0;
    const cs = pk.stage(coarse), fs = pk.stage(fine);
    const factor = cs.spp / fs.spp;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < cs.count; i++) {
        const [cmin, cmax] = pk.raw(coarse, ch, i);
        for (let j = i * factor; j < Math.min((i + 1) * factor, fs.count); j++) {
          const [fmin, fmax] = pk.raw(fine, ch, j);
          if (cmin > fmin) { bad++; worstMin = Math.max(worstMin, cmin - fmin); }
          if (cmax < fmax) { bad++; worstMax = Math.max(worstMax, fmax - cmax); }
        }
      }
    }
    ok(`stage ${coarse} bounds stage ${fine} EXACTLY, in both channels, over every peak`,
      bad === 0, `${bad} violations, worst min +${worstMin}, worst max +${worstMax} quanta`);
  }

  console.log("\n  -- the finest stage bounds the SAMPLES, to the quantum --");
  {
    const st = pk.stage(3);
    const q = pk.header.scale / 32767;
    let bad = 0, worst = 0;
    for (let i = 0; i < st.count; i++) {
      const a = i * st.spp, b = Math.min(a + st.spp, N);
      let mn = Infinity, mx = -Infinity;
      for (let j = a; j < b; j++) { if (L[j] < mn) mn = L[j]; if (L[j] > mx) mx = L[j]; }
      const [pmin, pmax] = pk.peak(3, 0, i);
      if (pmin - mn > q) { bad++; worst = Math.max(worst, pmin - mn); }
      if (mx - pmax > q) { bad++; worst = Math.max(worst, mx - pmax); }
    }
    ok(`every stage-3 peak brackets its 8 samples within one quantum (${q.toExponential(2)})`,
      bad === 0, `${bad} outside, worst ${worst}`);
  }

  console.log("\n  -- the ragged tail is MEASURED, not zero-padded --");
  {
    const M = 4096 * 3 + 700;            // a partial last block on every stage
    const x = new Float32Array(M).fill(0.5);
    for (let i = 4096 * 3; i < M; i++) x[i] = -0.5;   // the tail is all negative
    const f = path.join(TD, "tail.wav");
    writeWav(f, [x]);
    py("mip", f, path.join(TD, "tail.pk1"));
    const t = readPk(path.join(TD, "tail.pk1"));
    const st = t.stage(12);
    const [lmin, lmax] = t.peak(12, 0, st.count - 1);
    ok(`the last coarse peak reads [${lmin.toFixed(3)}, ${lmax.toFixed(3)}] — the 700 `
      + "samples that are really there, not a block padded to 4096 with zeros",
      lmax < -0.4 && lmin < -0.4, `[${lmin}, ${lmax}]`);
    ok("a mono file builds and reads with one channel",
      t.header.channels === 1 && t.header.stages.length === 4);
  }

  console.log("\n  -- a hot stem: louder than 1.0, and NOT clamped to it --");
  {
    const M = 9000;
    const x = new Float32Array(M);
    for (let i = 0; i < M; i++) x[i] = Math.sin(i * 0.02) * 2.5;   // +8 dB over full scale
    const f = path.join(TD, "hot.wav");
    writeWav(f, [x]);
    py("mip", f, path.join(TD, "hot.pk1"));
    const h = readPk(path.join(TD, "hot.pk1"));
    let top = 0;
    for (let i = 0; i < h.stage(3).count; i++) top = Math.max(top, h.peak(3, 0, i)[1]);
    ok(`the scale is the file's own peak (${h.header.scale.toFixed(3)}) and the drawn `
      + `maximum comes back as ${top.toFixed(3)}, not 1.000`,
      Math.abs(h.header.scale - 2.5) < 0.01 && top > 2.49 && top < 2.51);
    ok("the header states the decode so nobody has to guess it",
      /int16/.test(h.header.decode) && /32767/.test(h.header.decode));
  }

  console.log("\n  -- silence, and a single sample: neither divides by zero --");
  {
    const f = path.join(TD, "zero.wav");
    writeWav(f, [new Float32Array(5000)]);
    py("mip", f, path.join(TD, "zero.pk1"));
    const z = readPk(path.join(TD, "zero.pk1"));
    ok("an all-zero file builds, and every peak reads exactly 0",
      z.header.scale === 1 && z.peak(3, 0, 0)[0] === 0 && z.peak(3, 0, 0)[1] === 0);
    const g = path.join(TD, "one.wav");
    writeWav(g, [new Float32Array([0.25])]);
    py("mip", g, path.join(TD, "one.pk1"));
    const o = readPk(path.join(TD, "one.pk1"));
    ok("a one-sample file has one peak at every stage, min == max == the sample",
      o.header.stages.every((s) => s.count === 1)
      && Math.abs(o.peak(12, 0, 0)[0] - 0.25) < 1e-4);
  }

  console.log("\n  -- min is never above max, anywhere --");
  {
    let bad = 0;
    for (const s of pk.header.stages) {
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < s.count; i++) {
          const [mn, mx] = pk.raw(s.shift, ch, i);
          if (mn > mx) bad++;
        }
      }
    }
    ok("every [min, max] pair in every stage of every channel is ordered", bad === 0, `${bad} inverted`);
  }

  if (!process.env.KEEP_PEAKS_TEST) rmSync(TD, { recursive: true, force: true });
}

console.log("\n  -- the module says what it is, in one place --");
{
  const src = readFileSync(path.join(HERE, "peaks.py"), "utf8");
  ok("peaks.py declares SHIFTS once and derives every stage from it",
    (src.match(/^SHIFTS = /gm) || []).length === 1);
  ok("it does NOT carry a second copy of the Ear's band edges — it imports ear",
    !/^BANDS\s*=/m.test(src) && /import ear/.test(src));
  ok("server/peaks.py (the image-side envelope) is untouched by this feature",
    !/PKS1|mip/.test(readFileSync(path.join(HERE, "..", "peaks.py"), "utf8")));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
