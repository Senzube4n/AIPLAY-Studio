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

  /* ─────────── THE ONE THAT WOULD HAVE CAUGHT THE SECOND BUG ───────────
   *
   * ⚠ EVERY ASSERTION ABOVE PASSES ON THE BROKEN RENDERER. They count crushed
   * codes, and the defect the owner kept reporting after the first repair was
   * not clipping — it was QUANTISATION. `curves` is a 256-entry LUT and `eq` is
   * a gamma pass; handed 8-bit frames they round TWICE, and in a candle-lit
   * shadow the whole signal lives in a handful of codes. The region keeps its
   * brightness and loses its texture, which at normal exposure looks identical
   * and on a real screen reads as a flat black section.
   *
   * ⚠ AND A RAMP CANNOT SHOW IT. Every step of a ramp is already one code from
   * its neighbour and survives as something; counting distinct levels on one
   * actually favours the 8-bit path, because its rounding SCATTERS values and
   * inflates the count. More distinct values is not more faithful. So the test
   * image here is a dark field WITH TEXTURE in it — codes 8..20, the range a
   * night interior occupies — and the question is how much texture comes back.
   *
   * Confirmed by eye on a real frame before this was written: lifted 3.2 gamma,
   * the 8-bit chain returns flat voids where the 16-bit chain returns the room. */
  const DARK = path.join(dir, "dark.pgm");
  {
    const n = 192;
    const px = Buffer.alloc(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        /* A smooth base across the shadow range with a fine ripple on top:
         * the base is what a LUT moves, the ripple is what it merges. */
        const base = 8 + (x / n) * 12;
        const ripple = 1.5 * Math.sin(x / 3.0) * Math.cos(y / 3.0);
        px[y * n + x] = Math.max(0, Math.min(255, Math.round(base + ripple)));
      }
    }
    writeFileSync(DARK, Buffer.concat([Buffer.from(`P5\n${n} ${n}\n255\n`), px]));
  }

  /* Grade it, then LIFT it the way the eye does when it looks into a shadow —
   * the same 3.2 gamma the film survey uses. Texture that survived comes back;
   * texture that was merged cannot. */
  const surviving = async (depth) => {
    const f = path.join(dir, `dark${depth}.pgm`);
    const chain = (depth === 16 ? "format=gray16le," : "") + vf + ",format=gray,lutyuv=y='255*pow(val/255,1/3.2)'";
    await new Promise((res, rej) => execFile(ffmpeg,
      ["-v", "error", "-y", "-i", DARK, "-vf", chain, "-pix_fmt", "gray", f],
      (e) => (e ? rej(e) : res())));
    const b = readFileSync(f);
    let j = 2, seen2 = 0;
    while (seen2 < 3 && j < b.length) { if (/\s/.test(String.fromCharCode(b[j]))) { seen2++; while (/\s/.test(String.fromCharCode(b[j + 1]))) j++; } j++; }
    const row = b.subarray(j);
    /* Local spread, not global: the ripple is what a LUT eats, and a global
     * standard deviation is dominated by the base gradient either way. */
    let acc = 0, cnt = 0;
    for (let y = 1; y < 190; y++) {
      for (let x = 1; x < 190; x++) {
        const c0 = row[y * 192 + x];
        acc += Math.abs(c0 - row[y * 192 + x + 1]) + Math.abs(c0 - row[(y + 1) * 192 + x]);
        cnt += 2;
      }
    }
    return acc / cnt;
  };
  const t8 = await surviving(8);
  const t16 = await surviving(16);

  ok(`the two depths genuinely differ (8-bit texture ${t8.toFixed(3)}, 16-bit ${t16.toFixed(3)})`,
    Math.abs(t8 - t16) > 1e-6,
    "if these are equal the comparison below proves nothing — either ffmpeg is "
    + "promoting internally now, or the format filter is not being applied, and "
    + "this lane would go quiet while meaning nothing");
  ok(`...and 16-bit is the one that keeps the shadow texture`,
    t16 > t8,
    `8-bit ${t8.toFixed(3)}, 16-bit ${t16.toFixed(3)} — the depth is not buying what it is here for`);

  /* And the renderer must actually ASK for it. The pins above prove the filter
   * behaves; this proves the film is built with it. */
  const src = readFileSync(new URL("./timeline_render.py", import.meta.url), "utf8");
  ok("the renderer runs its grade at 16-bit, not just this test",
    /format=yuv444p16le,curves=all=/.test(src),
    "the grade chain in timeline_render.py is back at 8 bits, which merges "
    + "shadow codes into flat slabs — measured at 5.40% dead mass against 0.62%");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
