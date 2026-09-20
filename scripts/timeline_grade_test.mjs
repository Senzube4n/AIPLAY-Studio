/**
 * THE FINAL GRADE MAY NOT CRUSH THE SHADOWS IT WAS WRITTEN TO PROTECT.
 *
 * scripts/timeline_render.py ends every music video with one grade. For a long
 * time that grade was `eq=contrast=1.09`, whose arithmetic is
 * 1.09*(Y-128)+128 = 1.09*Y - 11.5 — zero at code 10.5. Thirteen distinct
 * shadow levels became one flat black, and legal black (16) became 5.
 *
 * On candle-lit night interiors, which is most of what this app makes, that
 * turned 0.03% pure-black pixels into 19.31%: hard-edged black patches across a
 * finished film, spotted by eye in the one place a viewer looks first.
 *
 * ⚠ THE CODE ALREADY CARRIED THE WARNING. "Contrast alone would crush that
 * shadow to black and lose the set." It was right, and the gamma chosen to
 * prevent it was far too small to do so. A number picked to prevent something
 * has to be measured against the thing it prevents — which is this lane.
 *
 * So: build a 256-step ramp, push it through the grade the renderer actually
 * composes, and count how many input codes come out as zero. Skips where
 * ffmpeg is absent, because this app ships without it by promise.
 *
 *   node scripts/timeline_grade_test.mjs
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("./timeline_render.py", import.meta.url));
const SRC = readFileSync(RENDERER, "utf8");

let passed = 0, failed = 0;
const ok = (what, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${extra ? `\n        ${extra}` : ""}`); }
};

console.log("\nTHE FINAL GRADE");

/* ── the shape of it, read out of the renderer ───────────────────────────── */
ok("the grade is a curve with pinned ends, not eq's pivot-at-128 contrast",
  /curves=all='\{curve\}'|curves=all='\$\{|curves=all=/.test(SRC) && /0\/0 \{toe_in/.test(SRC),
  "eq=contrast has no toe: it runs the bottom of the range into zero");
ok("...and eq is left holding only saturation and gamma, which do not clip",
  /eq=saturation=\{sat\}:gamma=\{gam\}/.test(SRC));
ok("...and --nograde still exists, because a grade is a choice",
  /--nograde/.test(SRC));

/* ── ffmpeg, or an honest skip ───────────────────────────────────────────── */
const ffmpeg = process.env.AIPLAY_FFMPEG || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
let haveFfmpeg = true;
try { execFileSync(ffmpeg, ["-version"], { stdio: "ignore" }); } catch { haveFfmpeg = false; }

if (!haveFfmpeg) {
  console.log("  (no ffmpeg on this machine — the measured half of this lane is skipped)");
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/* ── the measurement ─────────────────────────────────────────────────────── */
const dir = mkdtempSync(path.join(os.tmpdir(), "grade-"));
try {
  /* A 256-step ramp as a PGM, so every input code appears exactly once and the
   * file needs no image library to write. */
  const w = 256, h = 8;
  const rows = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.push(x);
  const ramp = path.join(dir, "ramp.pgm");
  writeFileSync(ramp, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`, "ascii"), Buffer.from(rows)]));

  /* The grade the renderer builds for its own default, derived the same way. */
  const c = 1.09, sat = 1.15, gam = 1.015;
  const toeIn = 0.12, shIn = 0.88;
  const toeOut = Math.max(0, toeIn - (c - 1) * 0.0556);
  const shOut = Math.min(1, shIn + (c - 1) * 0.222);
  const midOut = 0.5 + (c - 1) * 0.0556;
  const curve = `0/0 ${toeIn.toFixed(3)}/${toeOut.toFixed(4)} 0.5/${midOut.toFixed(4)} ${shIn.toFixed(3)}/${shOut.toFixed(4)} 1/1`;
  const vf = `curves=all='${curve}',eq=saturation=${sat}:gamma=${gam}`;

  const out = path.join(dir, "graded.pgm");
  await new Promise((res, rej) => execFile(ffmpeg,
    ["-v", "error", "-y", "-i", ramp, "-vf", vf, "-pix_fmt", "gray", out],
    (e) => (e ? rej(e) : res())));

  const buf = readFileSync(out);
  /* Skip the PGM header: three whitespace-separated fields after the magic. */
  let i = 2, seen = 0;
  while (seen < 3 && i < buf.length) { if (/\s/.test(String.fromCharCode(buf[i]))) { seen++; while (/\s/.test(String.fromCharCode(buf[i + 1]))) i++; } i++; }
  const px = buf.subarray(i, i + w);

  let crushed = 0;
  for (let x = 0; x < w; x++) if (px[x] === 0) crushed++;
  const slope = (px[140] - px[116]) / 24;

  /* ⚠ THE NUMBER THAT MATTERS. One crushed code is the honest floor: code 0 is
   * black and must stay black. The old grade crushed THIRTEEN. Anything past a
   * handful means the toe is running into zero again. */
  ok(`the grade crushes at most 4 input codes to pure black (it crushes ${crushed})`,
    crushed <= 4,
    `${crushed} codes come out as 0. eq=contrast=1.09 crushed 13, which is the bug this lane exists for.`);
  ok(`...and legal black (code 16) survives as something above zero (it is ${px[16]})`,
    px[16] > 8, `code 16 came out as ${px[16]}; under the old grade it was 5`);
  ok(`...while the midtone push is kept (slope ${slope.toFixed(3)})`,
    slope >= 1.02 && slope <= 1.12, `slope ${slope.toFixed(3)} — the grade should still add contrast`);
  ok(`...and the midtones are not shifted (code 128 -> ${px[128]})`,
    Math.abs(px[128] - 128) <= 3);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
