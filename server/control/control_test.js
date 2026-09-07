/**
 * THE THREE NUMBERS, tested against real files.
 *
 * Every claim control.js makes is about a clip somebody else rendered, so the
 * only honest test is one that renders clips that are WRONG in each of the four
 * ways and checks that each is refused, by name, with the number that is wrong
 * in the sentence. A test that hand-builds a `{width:1920}` object and asks
 * judgeClip about it proves the sentence-writer works; it does not prove that
 * ffprobe was asked the right question, that r_frame_rate was parsed as a
 * rational, or that -count_frames counts. So this suite does both halves:
 *
 *   1. the pure judge, which runs everywhere and pins the exact sentences;
 *   2. FIVE SYNTHETIC MP4s written by ffmpeg into a temp directory — right,
 *      wrong width, wrong height, wrong rate, too short — measured through the
 *      real probe.
 *
 * Half 2 SKIPS ITSELF LOUDLY when ffmpeg is not on this machine, and says so
 * with a count, because this app ships without ffmpeg by promise and a hook
 * that fails on a machine without it is a hook people delete. Half 1 always
 * runs. If you see "synthetic clips: skipped" in the hook output, the sentences
 * were checked and the probe was not.
 *
 * ⚠ THE 23.976 CASE IS THE ONE THAT MATTERS. 24000/1001 is the frame rate a
 * clip acquires by passing through almost any NLE, it is 0.1% away from 24, it
 * looks identical, and it silently retimes the camera move. If this suite is
 * ever thinned, that case stays.
 *
 * Runs standalone (`node server/control/control_test.js`) and in the hook.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateControlClip, judgeClip, CONTROL_SPEC, ffprobePath,
} from "./control.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

console.log("\ncontrol clips — the three numbers\n");

/* ── the spec is the spec ──────────────────────────────────────────────────
 * These four numbers are not this file's to choose: the Blender toolkit writes
 * and verifies 1280x704 at 24 fps on the far side of a licence boundary, and
 * 121 is its CONTROL_MIN_FRAMES. Pinned here so a well-meaning "let's allow
 * 720p" is a failing test rather than a wasted render. */
ok("the spec is 1280x704, 24 fps, at least 121 frames",
  CONTROL_SPEC.width === 1280 && CONTROL_SPEC.height === 704
  && CONTROL_SPEC.fps === 24 && CONTROL_SPEC.minFrames === 121);

/* ── the pure judge, and the exact sentences ─────────────────────────────── */
const RIGHT = { file: "good.mp4", width: 1280, height: 704, fps: 24, frames: 121 };

ok("a clip at all three numbers passes, and `why` is null",
  judgeClip(RIGHT).ok === true && judgeClip(RIGHT).why === null);

ok("more frames than the floor is fine — 121 is a floor, not an equality",
  judgeClip({ ...RIGHT, frames: 144 }).ok === true);

{
  const v = judgeClip({ ...RIGHT, width: 1920, height: 1080 });
  ok("1920x1080 is refused", v.ok === false);
  ok("...and the refusal names BOTH wrong numbers, with what they must be",
    /width is 1920, must be exactly 1280/.test(v.why) && /height is 1080, must be exactly 704/.test(v.why),
    v.why);
  ok("...and says what silently happens instead (centre crop, not an error)",
    /CENTRE-CROP/.test(v.why) && /nodes_wan\.py:319/.test(v.why), v.why);
  ok("...under the toolkit's own headline, so both sides of the boundary read alike",
    v.why.startsWith("CONTROL CLIP OUT OF SPEC: good.mp4"), v.why);
}

{
  const v = judgeClip({ ...RIGHT, fps: 30 });
  ok("30 fps is refused", v.ok === false);
  ok("...naming the rate to three decimals, both got and wanted",
    /frame rate is 30\.000 fps, must be exactly 24\.000/.test(v.why), v.why);
}

{
  /* THE CASE THAT LOOKS FINE. 24000/1001 = 23.976023976..., which is what a
   * clip becomes after a round trip through most editors. */
  const v = judgeClip({ ...RIGHT, fps: 24000 / 1001 });
  ok("23.976 is refused — 0.1% off 24 is off 24", v.ok === false);
  ok("...and the sentence prints 23.976 rather than rounding it to 24",
    /frame rate is 23\.976 fps/.test(v.why), v.why);
}

{
  const v = judgeClip({ ...RIGHT, frames: 96 });
  ok("96 frames is refused", v.ok === false);
  ok("...with the number, the floor, and the clamp-then-gray behaviour named",
    /frame count is 96, must be at least 121/.test(v.why)
    && /ImageFromBatch clamps/.test(v.why) && /mid-gray/.test(v.why), v.why);
}

{
  const v = judgeClip({ ...RIGHT, width: 1920, fps: 30, frames: 60 });
  const lines = v.why.split("\n").filter((l) => l.trim().startsWith("- "));
  ok("three wrong numbers produce three lines, not one vague verdict",
    lines.length === 3, v.why);
}

ok("an unreadable number is called unreadable rather than printed as NaN",
  /width is unreadable/.test(judgeClip({ ...RIGHT, width: undefined }).why));

/* ── the probe, on files that do not exist or are not clips ──────────────── */
{
  const v = await validateControlClip(path.join(tmpdir(), "definitely-not-here-9f3a.mp4"));
  ok("a missing file is refused as missing, not as out of spec",
    v.ok === false && /CONTROL CLIP MISSING/.test(v.why), v.why);
}
{
  const v = await validateControlClip("");
  ok("no path at all is refused", v.ok === false && /needs a path/.test(v.why), v.why);
}
{
  /* The promise this app ships on: no ffmpeg. A machine without it must get an
   * answer, not a stack trace — and must NEVER get ok:true. */
  const v = await validateControlClip(path.resolve("package.json"),
    { ffprobe: path.join(tmpdir(), "no-such-ffprobe-a71c") });
  ok("no ffprobe is an ANSWER, not a crash — and never a pass",
    v.ok === false && /CONTROL CLIP NOT MEASURED/.test(v.why) && /AIPLAY_FFPROBE/.test(v.why), v.why);
}

/* ── firstOutputFile is GONE, and so is everything it served ────────────
 *
 * Three assertions stood here, about a helper that pulled the first saved file
 * out of a ComfyUI /history outputs blob under `images`, `videos` or `gifs`. It
 * was part of this directory's temporary engine client and it went with it.
 *
 * Nothing was lost. server/engine/client.js's collectOutputs() reads the same
 * four keys and returns strictly more — {node, kind, file, subfolder, bytes,
 * sha256, adoptedAs} — and its sha256 is the field that makes a ledger entry
 * point at a FILE rather than at a name in a folder, which is the whole
 * difference the engine door exists for. server/engine/client_test.js owns that
 * behaviour now, and it is the only copy. */
/* ── the synthetic clips ─────────────────────────────────────────────────── */
function run(bin, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}
const FFMPEG = process.env.AIPLAY_FFMPEG || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const haveFfmpeg = !(await run(FFMPEG, ["-version"], 15_000)).err;
const haveFfprobe = !(await run(ffprobePath(), ["-version"], 15_000)).err;

if (!haveFfmpeg || !haveFfprobe) {
  console.log(`\n  --  synthetic clips: SKIPPED  --`);
  console.log(`      ffmpeg ${haveFfmpeg ? "found" : "NOT found"}, ffprobe ${haveFfprobe ? "found" : "NOT found"}.`);
  console.log(`      The sentences above were checked; the probe was not. This app ships`);
  console.log(`      without ffmpeg by promise, so this is a normal machine, not a broken one.`);
  console.log(`      To run the other half: install ffmpeg, or set AIPLAY_FFMPEG/AIPLAY_FFPROBE.\n`);
} else {
  const scratch = await mkdtemp(path.join(tmpdir(), "aiplay-control-"));
  /* testsrc2 rather than a colour block: it moves, so a frame counter has real
   * frames to count and a bad decode cannot pass by looking uniform. */
  async function make(name, { w, h, fps, frames }) {
    const out = path.join(scratch, name);
    const r = await run(FFMPEG, [
      "-y", "-f", "lavfi",
      "-i", `testsrc2=size=${w}x${h}:rate=${fps}:duration=${(frames / fps).toFixed(6)}`,
      "-frames:v", String(frames),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
      out,
    ]);
    if (r.err) throw new Error(`ffmpeg could not write ${name}: ${r.stderr.split("\n").slice(-3).join(" ")}`);
    return out;
  }

  const good = await make("good.mp4", { w: 1280, h: 704, fps: 24, frames: 121 });
  const v = await validateControlClip(good);
  ok("a real 1280x704 / 24 fps / 121-frame mp4 passes the probe",
    v.ok === true && v.why === null, JSON.stringify(v));
  ok("...and the measured numbers come back, so a caller can print them",
    v.width === 1280 && v.height === 704 && v.frames === 121 && Math.abs(v.fps - 24) < 1e-9,
    JSON.stringify(v));

  /* -count_frames, not the container's nb_frames claim: this clip really has
   * 121 frames and the probe really counted them. */
  const long = await make("long.mp4", { w: 1280, h: 704, fps: 24, frames: 144 });
  const lv = await validateControlClip(long);
  ok("144 frames passes and is REPORTED as 144 — the count is measured, not assumed",
    lv.ok === true && lv.frames === 144, JSON.stringify(lv));

  const cases = [
    ["wrong width", { w: 1920, h: 704, fps: 24, frames: 121 }, /width is 1920, must be exactly 1280/],
    ["wrong height", { w: 1280, h: 720, fps: 24, frames: 121 }, /height is 720, must be exactly 704/],
    ["wrong frame rate", { w: 1280, h: 704, fps: 30, frames: 121 }, /frame rate is 30\.000 fps/],
    ["too few frames", { w: 1280, h: 704, fps: 24, frames: 96 }, /frame count is 96, must be at least 121/],
  ];
  for (const [label, spec, rx] of cases) {
    const f = await make(`${label.replace(/\s+/g, "_")}.mp4`, spec);
    const r = await validateControlClip(f);
    ok(`a synthetic mp4 with the ${label} is refused`, r.ok === false, JSON.stringify(r));
    ok(`...and the refusal says WHICH number is wrong`, rx.test(r.why || ""), r.why || "(no why)");
  }

  /* 23.976 through the real probe. ffmpeg writes r_frame_rate 24000/1001 for
   * rate=24000/1001, and the whole point is that the rational is compared as a
   * rational — a Number(fps).toFixed(2) comparison would pass this clip. */
  {
    const f = path.join(scratch, "ntsc.mp4");
    const r = await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x704:rate=24000/1001:duration=5.1",
      "-frames:v", "121", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", f,
    ]);
    if (r.err) {
      ok("23.976 clip written", false, r.stderr.split("\n").slice(-2).join(" "));
    } else {
      const rv = await validateControlClip(f);
      ok("a real 23.976 fps clip is refused — the rational is compared as a rational",
        rv.ok === false && /frame rate is 23\.976 fps/.test(rv.why || ""), JSON.stringify(rv));
    }
  }

  /* A file that is not a video at all. */
  {
    const rv = await validateControlClip(path.resolve("package.json"));
    ok("package.json is not a control clip and is refused rather than measured",
      rv.ok === false, JSON.stringify(rv));
  }

  await rm(scratch, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
