/**
 * Assemble the demo media the landing page and the blog post embed.
 *
 * WHY IN THE REPO RATHER THAN ON A CDN. These are a handful of files totalling a
 * few megabytes, and GitHub Pages serves them from the same commit as the page
 * that references them — so the demo can never be a dead link or a version
 * behind. If they ever grow past that being reasonable, swapping in a CDN is a
 * one-line base URL change on the page; that is a smaller problem than a broken
 * embed, and a much smaller one than handing a build script a storage password.
 *
 * Everything is transcoded down to web sizes. A 30 MB FLAC is the right format
 * for the library and the wrong one for a landing page.
 *
 * ffmpeg is used here and ONLY here — this is a build-time script for the docs,
 * not something Studio needs at runtime. Nothing in the app shells out to it.
 */
import { mkdir, copyFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "../server/config.js";

const OUT = path.join(process.cwd(), "docs", "demo");
const SRC = config.outputDir;
const FFMPEG = ["C:/ffmpeg/bin/ffmpeg.exe", "/usr/bin/ffmpeg", "ffmpeg"].find(
  (p) => p === "ffmpeg" || existsSync(p));

/** What goes on the page, and why each one is there. */
const ITEMS = [
  { out: "demo-song.mp3", from: "aiplay_00011.flac", kind: "audio",
    why: "A full local render. This is also the track the karaoke screenshot is driving." },
  { out: "demo-clip-ltx.mp4", from: "clips/ltx_00001_.mp4", kind: "copy",
    why: "LTX 2.5, the default engine — 5 s at 1280x704 in about two minutes." },
  { out: "demo-clip-h3.mp4", from: "clips/vmsxt0osq.mp4", kind: "copy",
    why: "MiniMax H3, for comparison against the same idea." },
  /* The audio-reference dial, which is the demo worth having: the SAME reference
   * at three settings, so the cliff is audible rather than asserted.
   *
   * ⚠ An earlier version of this list used arefstock/arefrt as an
   * "original vs round trip" pair. They measure r = 1.0000 and SI-SDR 159.8 dB
   * against each other — they are the same audio, not a pair — so publishing
   * them as evidence of the round trip would have been evidence of nothing.
   * Measure the files you are about to call proof. */
  { out: "aref-denoise-060.mp3", from: "aref_d06_00001.flac", kind: "audio",
    why: "Denoise 0.60 — still a copy. r = 0.94 against the near-copy end of the dial." },
  { out: "aref-denoise-085.mp3", from: "aref_d085_00001.flac", kind: "audio",
    why: "Denoise 0.85 — the shipped default. Waveform correlation has collapsed to 0.004: a new performance." },
  { out: "aref-denoise-095.mp3", from: "aref_d095_00001.flac", kind: "audio",
    why: "Denoise 0.95 — past the useful range; the reference stops steering it." },
];

const run = (args) => new Promise((res, rej) => {
  const p = spawn(FFMPEG, args, { stdio: "ignore" });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`))));
  p.on("error", rej);
});

await mkdir(OUT, { recursive: true });
const made = [];
for (const it of ITEMS) {
  const src = path.join(SRC, it.from);
  if (!existsSync(src)) { console.log(`  ⚠ missing, skipped: ${it.from}`); continue; }
  const dst = path.join(OUT, it.out);
  try {
    if (it.kind === "audio") {
      // 160k VBR stereo: transparent enough that nobody is judging the model on
      // the codec, small enough to sit in a git repo without apology.
      await run(["-y", "-loglevel", "error", "-i", src, "-vn", "-c:a", "libmp3lame", "-q:a", "4", dst]);
    } else {
      await copyFile(src, dst);
    }
    const kb = Math.round((await stat(dst)).size / 1024);
    console.log(`  ${it.out.padEnd(22)} ${String(kb).padStart(5)} KB`);
    made.push({ ...it, bytes: kb * 1024 });
  } catch (e) {
    console.log(`  ⚠ ${it.out}: ${e.message}`);
  }
}

// A manifest, so the page and the blog post reference the same list and a
// missing file is visible rather than a silent broken embed.
await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(made, null, 2));
const total = made.reduce((n, m) => n + m.bytes, 0);
console.log(`\n${made.length} files, ${(total / 1048576).toFixed(1)} MB total → ${OUT}`);
