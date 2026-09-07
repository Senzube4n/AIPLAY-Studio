/**
 * RAM preview, end to end over HTTP, with the numbers.
 *
 * WHY THIS EXISTS. The frame cache is a claim about TIME — "the second fetch is
 * free" — and a claim about CORRECTNESS — "a cached frame is never a stale
 * frame". Neither is visible in a diff, and the second one is the dangerous
 * half: showing yesterday's pixels is worse than being slow, because the user
 * cannot tell. So this drives a real server over real HTTP and asserts on
 * DECODED PIXELS, not on a `cached: true` flag the cache sets about itself.
 *
 * It boots three servers, on purpose:
 *
 *   A (4198)  the suite. Cold vs warm, prewarm, invalidation, cancellation.
 *   B (4197)  a FRESH PROCESS on A's output directory — empty memory, full
 *             disk. The only way to time the disk tier honestly, and it proves
 *             in passing that the disk cache survives a restart.
 *   C (4196)  tiny caps via the env knobs, so eviction actually happens rather
 *             than being argued about.
 *
 * NOT in .githooks/pre-commit, for the reason smoke_api is not: it needs the
 * rig's python and it renders a couple of hundred frames. Minutes, not seconds.
 *
 *   node server/vfx/routes_ram_test.js
 *
 * Ports are deliberately 4196-4198. 4173 is the user's own Studio.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRATCH = path.join(os.tmpdir(), `vfx_ram_${process.pid}`);
const RIG_PYTHON = process.env.AIPLAY_RIG_PYTHON
  || path.join(process.env.AIPLAY_RIG || "D:/AI/aiplay-studio-bench", "venv", "Scripts", "python.exe");

let pass = 0;
const failures = [];
const notes = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const say = (line) => { notes.push(line); console.log(`  ·     ${line}`); };

/* ─────────────────────────────────────────────────────────── the harness */

const servers = [];

async function boot(port, out, extra = {}) {
  mkdirSync(out, { recursive: true });
  const proc = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: {
      ...process.env,
      AIPLAY_UI_PORT: String(port),
      AIPLAY_OUTPUT: out,
      /* A rig path with no ComfyUI under it. The supervisor spawns python on a
       * main.py that is not there, python exits in milliseconds, and index.js
       * logs "engine failed to start" and carries on — which is exactly what we
       * want: the HTTP server is already listening by then, and NOTHING here
       * should start a second ComfyUI beside the user's. */
      AIPLAY_RIG: path.join(SCRATCH, "norig"),
      AIPLAY_PYTHON: RIG_PYTHON,
      AIPLAY_COMFY_PORT: String(8290 + (port % 10)),
      ...extra,
    },
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  servers.push(proc);

  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + 45_000;
  for (;;) {
    try { await fetch(`${base}/api/vfx/comps`); break; } catch { /* not listening yet */ }
    if (Date.now() > until) throw new Error(`server on ${port} never came up:\n${log}`);
    await new Promise((s) => setTimeout(s, 200));
  }
  return {
    base, proc,
    get: async (p) => (await fetch(base + p)).json(),
    post: async (b) => (await fetch(`${base}/api/vfx`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    })).json(),
    /** The PNG, timed, with the tier that answered it. */
    frame: async (slug, t, q = "scale=1&draft=0") => {
      const a = process.hrtime.bigint();
      const r = await fetch(`${base}/api/vfx/frame/${slug}?t=${t}&${q}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const ms = Number(process.hrtime.bigint() - a) / 1e6;
      if (r.status !== 200) throw new Error(`frame ${t}: ${r.status} ${buf.toString().slice(0, 300)}`);
      return { buf, ms, tier: r.headers.get("x-vfx-cache"), engineMs: Number(r.headers.get("x-vfx-ms") || 0) };
    },
    log: () => log,
  };
}

function shutdown() {
  for (const p of servers) { try { p.kill(); } catch { /* already gone */ } }
  setTimeout(() => { for (const p of servers) { try { p.kill("SIGKILL"); } catch { /* gone */ } } }, 2000).unref();
}

/* ────────────────────────────────────────────────────── a PNG, decoded */

/**
 * Enough PNG to compare pixels, using only what ships with node.
 *
 * `cached: true` is the cache's opinion of itself and proves nothing about
 * invalidation. Comparing file hashes is better but still not pixels — PNG is
 * lossless, so two encodings of the same picture can differ byte for byte. So:
 * chunks, inflate, undo the scanline filters, count pixels that differ. Eight
 * bit, non-interlaced, RGB or RGBA, which is what PIL writes; anything else
 * throws rather than quietly comparing nothing.
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
    throw new Error(`unsupported PNG: depth ${depth}, colour ${color}, interlace ${interlace}`);
  }
  const ch = color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, px: out };
}

/** How many pixels of two decoded frames disagree, and by how much at worst. */
function pixelDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h || a.ch !== b.ch) return { differing: a.w * a.h, pct: 100, worst: 255 };
  let differing = 0, worst = 0;
  for (let i = 0; i < a.px.length; i += a.ch) {
    let d = 0;
    for (let k = 0; k < a.ch; k++) d = Math.max(d, Math.abs(a.px[i + k] - b.px[i + k]));
    if (d) { differing++; if (d > worst) worst = d; }
  }
  const total = a.w * a.h;
  return { differing, pct: Number(((differing / total) * 100).toFixed(3)), worst };
}

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/* ─────────────────────────────────────────────────── the comp under test */

/** 1280x720, text with two glows and a mask over a plate — the user's shape. */
async function buildComp(S, name) {
  const c = await S.post({ action: "create", name, width: 1280, height: 720, fps: 30, duration: 4 });
  if (!c.ok) throw new Error(`create: ${c.error}`);
  const slug = c.slug;
  const must = async (b) => { const r = await S.post(b); if (!r.ok) throw new Error(`${b.action}: ${r.error}`); return r; };

  const plate = (await must({ action: "add_layer", slug, type: "solid", name: "plate", color: [30, 40, 60, 255] })).layerId;
  /* A flat solid compresses to nothing and renders in no time — neither is a
   * preview. Fractal noise makes the frame both expensive and BIG, which is
   * what the cache is actually being asked to cope with. */
  await must({ action: "add_effect", slug, layerId: plate, type: "fractalNoise" });

  const text = (await must({
    action: "add_layer", slug, type: "text", name: "title",
    text: { content: "PREVIEW", size: 140, color: [255, 230, 120, 255] },
  })).layerId;
  await must({ action: "add_effect", slug, layerId: text, type: "glow" });
  await must({ action: "add_effect", slug, layerId: text, type: "glow" });
  await must({ action: "add_mask", slug, layerId: text, feather: 20,
    points: [[100, 200], [1180, 200], [1180, 520], [100, 520]] });
  // Keyed, so no two instants are the same picture and a cache that mixed them
  // up would be caught by any of the pixel assertions below.
  await must({ action: "set_prop", slug, layerId: text, path: "transform.position",
    value: { keys: [{ t: 0, v: [300, 360] }, { t: 4, v: [980, 360] }] } });
  return { slug, text };
}

const jobOf = async (S, slug, id) =>
  (await S.get(`/api/vfx/comp/${slug}`)).prewarms.find((r) => r.id === id);

async function waitForJob(S, slug, id, ms = 300_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await jobOf(S, slug, id);
    if (!r) throw new Error(`job ${id} vanished`);
    if (r.status !== "running" && r.status !== "queued") return r;
    if (Date.now() > until) throw new Error(`job ${id} still ${r.status} after ${ms} ms`);
    await new Promise((s) => setTimeout(s, 200));
  }
}

/* ───────────────────────────────────────────────────────────────── run */

const A_OUT = path.join(SCRATCH, "outA");
const C_OUT = path.join(SCRATCH, "outC");
rmSync(SCRATCH, { recursive: true, force: true });

let A;
try {
  console.log(`\n  scratch ${SCRATCH}\n  python  ${RIG_PYTHON}`);

  /* ── A: the frame lane ────────────────────────────────────────────── */

  console.log("\n  -- cold and warm, measured --");
  A = await boot(4198, A_OUT);
  const { slug, text } = await buildComp(A, "RamBench");

  const cold = await A.frame(slug, 3.5);
  ok("a frame nobody has asked for is rendered", cold.tier === "render", `tier ${cold.tier}`);
  const warm = await A.frame(slug, 3.5);
  ok("the same frame again comes from memory", warm.tier === "ram", `tier ${warm.tier}`);
  ok("...and is byte-for-byte the frame that was rendered", sha(warm.buf) === sha(cold.buf));
  say(`cold ${cold.ms.toFixed(0)} ms over HTTP (engine ${cold.engineMs} ms) → warm ${warm.ms.toFixed(1)} ms`
    + `  = ${(cold.ms / warm.ms).toFixed(0)}x, ${(1000 / warm.ms).toFixed(0)} fps of headroom`);
  say(`per-frame overhead outside the engine: ${(cold.ms - cold.engineMs).toFixed(0)} ms — python start-up and imports`);

  /* ── prewarm ──────────────────────────────────────────────────────── */

  console.log("\n  -- prewarming a two-second range --");
  const one = await A.post({ action: "prewarm", slug, from: 0, to: 1, fps: 30, scale: 1, draft: false, concurrency: 1 });
  ok("prewarm answers immediately with a job id", one.ok && !!one.jobId, JSON.stringify(one).slice(0, 200));
  const t1 = Date.now();
  const doneOne = await waitForJob(A, slug, one.jobId);
  const msOne = Date.now() - t1;
  ok("...and finishes", doneOne.status === "done", `${doneOne.status}: ${doneOne.error}`);

  const two = await A.post({ action: "prewarm", slug, from: 1, to: 2, fps: 30, scale: 1, draft: false, concurrency: 2 });
  const t2 = Date.now();
  const doneTwo = await waitForJob(A, slug, two.jobId);
  const msTwo = Date.now() - t2;
  ok("a second range finishes too", doneTwo.status === "done", `${doneTwo.status}: ${doneTwo.error}`);

  /* Three points on the lane curve, because the default is a judgement about
   * how much of a machine that also runs prod a background job may take, and
   * that judgement should be made against numbers. */
  const four = await A.post({ action: "prewarm", slug, from: 2, to: 3, fps: 30, scale: 1, draft: false, concurrency: 4 });
  const t4 = Date.now();
  const doneFour = await waitForJob(A, slug, four.jobId);
  const msFour = Date.now() - t4;
  ok("four lanes finish too", doneFour.status === "done", `${doneFour.status}: ${doneFour.error}`);
  const rate = (d, ms) => `${(d.rendered / (ms / 1000)).toFixed(2)} fps (${d.rendered} in ${(ms / 1000).toFixed(1)}s)`;
  say(`prewarm rate: 1 lane ${rate(doneOne, msOne)} · 2 lanes ${rate(doneTwo, msTwo)} · 4 lanes ${rate(doneFour, msFour)}`);

  const man = await A.get(`/api/vfx/cache/${slug}?scale=1&draft=0&fps=30`);
  ok("the manifest reports the whole range as cached",
    man.grid.cached >= 61, `${man.grid.cached} of ${man.grid.frames}`);
  const run = man.covered.find((c) => c.from === 0);
  ok("...as ONE contiguous run the UI can draw", !!run && run.to >= 2,
    JSON.stringify(man.covered));
  ok("the manifest reports its own ceilings", man.caps.diskFrames > 0 && man.caps.ramBytes > 0,
    JSON.stringify(man.caps));

  /* Every frame the manifest claims, fetched. This is the playback claim. */
  const sample = [];
  for (let i = 0; i <= 60; i += 5) sample.push(i / 30);
  const timed = [];
  let missed = 0;
  for (const t of sample) {
    const r = await A.frame(slug, t);
    if (r.tier === "render") missed++;
    timed.push(r.ms);
  }
  ok("every frame in the prewarmed range comes back cached", missed === 0, `${missed} of ${sample.length} re-rendered`);
  const mean = timed.reduce((a, b) => a + b, 0) / timed.length;
  say(`playback over HTTP: mean ${mean.toFixed(1)} ms/frame, worst ${Math.max(...timed).toFixed(1)} ms `
    + `→ ${(1000 / Math.max(...timed)).toFixed(0)} fps sustained on the worst frame`);

  /* ── B: the same disk, a fresh memory ─────────────────────────────── */

  /* HERE, not at the end. The disk tier can only be timed against an empty
   * memory, and it can only be timed at all while the frames on disk still
   * belong to the comp's current stamp — the invalidation tests below are
   * about to change that on purpose. */
  console.log("\n  -- the disk tier, timed on its own (fresh process, same disk) --");
  const B = await boot(4197, A_OUT);
  /* Twenty frames, each fetched once with an empty memory and once with a full
   * one. One sample of each would not settle whether the disk round trip is
   * itself the bottleneck, which is the question that decides whether the RAM
   * tier earns its budget. */
  const lane = [];
  for (let i = 0; i <= 57; i += 3) lane.push(i / 30);
  const diskMs = [], ramMs = [];
  let notDisk = 0;
  const first = [];
  for (const t of lane) {
    const r = await B.frame(slug, t);
    if (r.tier !== "disk") notDisk++;
    diskMs.push(r.ms); first.push(r.buf);
  }
  ok("frames cached by the previous process are still cached", notDisk === 0,
    `${notDisk} of ${lane.length} were not a disk hit — the disk cache did not survive the restart`);
  let notRam = 0, drifted = 0;
  for (let i = 0; i < lane.length; i++) {
    const r = await B.frame(slug, lane[i]);
    if (r.tier !== "ram") notRam++;
    if (sha(r.buf) !== sha(first[i])) drifted++;
    ramMs.push(r.ms);
  }
  ok("...and are promoted to memory on the way out", notRam === 0, `${notRam} were not a RAM hit`);
  ok("both tiers hand back the same picture", drifted === 0, `${drifted} frames differed between tiers`);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  say(`tiers over ${lane.length} frames of ~${(avg(first.map((b) => b.length)) / 1024).toFixed(0)} KB: `
    + `render ${cold.ms.toFixed(0)} ms · disk ${avg(diskMs).toFixed(1)} ms · ram ${avg(ramMs).toFixed(1)} ms`);
  say(`the disk round trip costs ${(avg(diskMs) - avg(ramMs)).toFixed(1)} ms/frame — real, but `
    + `${(33.3 / avg(diskMs)).toFixed(0)}x under a 30 fps budget on its own. RAM is headroom, not the fix.`);

  /* ── invalidation, on the pixels ──────────────────────────────────── */

  console.log("\n  -- an edit invalidates, proven on pixels --");
  const before = await A.frame(slug, 1);
  const beforeAgain = await A.frame(slug, 1);
  const pxBefore = decodePng(before.buf);
  ok("two reads of one cached frame are the same picture",
    pixelDiff(pxBefore, decodePng(beforeAgain.buf)).differing === 0);

  const edit = await A.post({ action: "set_layer", slug, layerId: text, text: { content: "CHANGED" } });
  ok("the comp edits", edit.ok, edit.error);

  const after = await A.frame(slug, 1);
  const pxAfter = decodePng(after.buf);
  const diff = pixelDiff(pxBefore, pxAfter);
  ok("the frame after the edit is NOT the frame before it", diff.differing > 0,
    "identical pixels — a stale frame was served");
  ok("...and it was genuinely re-rendered, not re-served", after.tier === "render", `tier ${after.tier}`);
  say(`invalidation: ${diff.differing} of ${pxBefore.w * pxBefore.h} pixels changed (${diff.pct}%), worst channel delta ${diff.worst}`);

  const manAfter = await A.get(`/api/vfx/cache/${slug}?scale=1&draft=0&fps=30`);
  ok("the manifest drops the whole pre-edit range", manAfter.grid.cached <= 2,
    `${manAfter.grid.cached} frames still claimed after an edit`);
  ok("...and reports the new stamp", manAfter.updatedAt > man.updatedAt);

  /* ── cancellation, and staying answerable while it runs ───────────── */

  console.log("\n  -- cancellable, and not in the way while it runs --");
  const big = await A.post({ action: "prewarm", slug, from: 0, to: 3, fps: 30, scale: 1, draft: false, concurrency: 2 });
  const untilMoving = Date.now() + 60_000;
  let moving = null;
  for (;;) {
    moving = await jobOf(A, slug, big.jobId);
    if (moving.frame >= 2 || Date.now() > untilMoving) break;
    await new Promise((s) => setTimeout(s, 100));
  }
  ok("a prewarm reports itself moving", moving.frame >= 2, `frame ${moving.frame}`);

  const cheapAt = process.hrtime.bigint();
  const comps = await A.get("/api/vfx/comps");
  const cheapMs = Number(process.hrtime.bigint() - cheapAt) / 1e6;
  ok("the event loop is free while a prewarm runs", Array.isArray(comps.comps) && cheapMs < 250,
    `${cheapMs.toFixed(1)} ms for a listing`);

  /* A t OUTSIDE the prewarmed range, so it cannot cheat by joining a frame the
   * job was already making. This is a genuine cold render, mid-prewarm. */
  const busy = await A.frame(slug, 3.9);
  ok("an ordinary frame request is still served during a prewarm", busy.tier === "render");
  say(`interactive frame during prewarm: ${busy.ms.toFixed(0)} ms vs ${cold.ms.toFixed(0)} ms idle `
    + `(${(busy.ms / cold.ms).toFixed(2)}x), listing ${cheapMs.toFixed(1)} ms`);

  const stopped = await A.post({ action: "prewarm_cancel", slug });
  ok("cancel names the job it stopped", stopped.ok && stopped.cancelled.includes(big.jobId),
    JSON.stringify(stopped));
  const dead = await waitForJob(A, slug, big.jobId, 60_000);
  ok("...and the job ends cancelled, part way", dead.status === "cancelled" && dead.frame < dead.frames,
    `${dead.status} at ${dead.frame}/${dead.frames}`);

  const manPart = await A.get(`/api/vfx/cache/${slug}?scale=1&draft=0&fps=30`);
  ok("frames rendered before the cancel are kept", manPart.grid.cached >= dead.rendered,
    `${manPart.grid.cached} cached, ${dead.rendered} rendered`);
  say(`cancelled at ${dead.frame}/${dead.frames}; ${manPart.grid.cached} frames kept`);

  /* ── an edit mid-flight kills the job rather than filling a dead cache ─ */

  console.log("\n  -- an edit mid-prewarm stops the job --");
  const doomed = await A.post({ action: "prewarm", slug, from: 0, to: 3, fps: 30, scale: 1, draft: false });
  const untilTick = Date.now() + 60_000;
  for (;;) {
    const r = await jobOf(A, slug, doomed.jobId);
    if (r.frame >= 1 || r.status !== "running" || Date.now() > untilTick) break;
    await new Promise((s) => setTimeout(s, 100));
  }
  await A.post({ action: "set_layer", slug, layerId: text, text: { content: "MOVED ON" } });
  const stale = await waitForJob(A, slug, doomed.jobId, 60_000);
  ok("a prewarm that an edit overtook ends stale, not done", stale.status === "stale",
    `${stale.status} — it would have been filling a cache nothing can read`);

  /* ── C: the caps, made to bite ────────────────────────────────────── */

  console.log("\n  -- the caps evict, and the manifest tells the truth --");
  /* 60 frames is the FLOOR the knob clamps to — two seconds at 30 fps, below
   * which a preview cache is not one. So the cap is made to bite by asking for
   * more than sixty frames, not by asking for a smaller cap. */
  const C = await boot(4196, C_OUT, {
    AIPLAY_VFX_DISK_FRAMES: "1",
    AIPLAY_VFX_DISK_MB: "64",
    AIPLAY_VFX_RAM_MB: "1",
  });
  const small = await buildComp(C, "CapBench");
  const cMan0 = await C.get(`/api/vfx/cache/${small.slug}?scale=1&draft=0&fps=30`);
  ok("the knobs are read, and clamped to their floors rather than obeyed blindly",
    cMan0.caps.diskFrames === 60 && cMan0.caps.ramBytes === 16 * 1024 * 1024,
    JSON.stringify(cMan0.caps));

  const over = await C.post({ action: "prewarm", slug: small.slug, from: 0, to: 2, fps: 30, concurrency: 2 });
  ok("a range longer than the cache is CLAMPED, not silently half-rendered",
    over.clamped === true && over.frames === 60,
    `clamped ${over.clamped}, ${over.frames} frames — rendering past the cap only evicts the start`);
  await waitForJob(C, small.slug, over.jobId);

  const second = await C.post({ action: "prewarm", slug: small.slug, from: 2, to: 2.6, fps: 30, concurrency: 2 });
  await waitForJob(C, small.slug, second.jobId);

  const cMan = await C.get(`/api/vfx/cache/${small.slug}?scale=1&draft=0&fps=30`);
  ok("the disk cap held", cMan.caps.diskUsedFrames <= cMan.caps.diskFrames,
    `${cMan.caps.diskUsedFrames} files against a cap of ${cMan.caps.diskFrames}`);
  ok("the memory cap held", cMan.caps.ramUsed <= cMan.caps.ramBytes,
    `${cMan.caps.ramUsed} bytes against a cap of ${cMan.caps.ramBytes}`);
  ok("eviction took the OLDEST first — the newest range is intact",
    cMan.covered.some((c) => c.to >= 2.5),
    JSON.stringify(cMan.covered));
  ok("...and the oldest frame is gone from BOTH tiers",
    !cMan.frames.includes(0) && !cMan.ram.includes(0),
    `frame 0 survived: disk ${cMan.frames.includes(0)}, ram ${cMan.ram.includes(0)}`);
  say(`caps: ${cMan.caps.diskUsedFrames}/${cMan.caps.diskFrames} files on disk `
    + `(${(cMan.caps.diskUsedBytes / 1048576).toFixed(1)} MB), `
    + `${cMan.caps.ramFrames} frames / ${(cMan.caps.ramUsed / 1048576).toFixed(1)} MB of ${(cMan.caps.ramBytes / 1048576).toFixed(0)} MB in RAM; `
    + `coverage now ${JSON.stringify(cMan.covered)}`);

  /* The manifest is only useful if it is honest in BOTH directions. */
  let lied = 0;
  for (const ms of cMan.frames.slice(0, 8)) {
    const r = await C.frame(small.slug, ms / 1000);
    if (r.tier === "render") lied++;
  }
  ok("every frame the manifest claims really is cached", lied === 0, `${lied} were re-rendered`);

  const held = new Set(cMan.frames);
  const gone = [];
  for (let i = 0; i <= 60 && gone.length < 1; i++) if (!held.has(Math.round((i * 1000) / 30))) gone.push(i);
  ok("there is a frame in the range the manifest does NOT claim", gone.length === 1,
    "nothing was evicted, so the negative half cannot be tested");
  if (gone.length === 1) {
    const r = await C.frame(small.slug, gone[0] / 30);
    ok("...and asking for it really does render", r.tier === "render", `tier ${r.tier}`);
  }
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.log(`\n  FAIL  the suite threw\n          ${err.stack}`);
  if (A) console.log(A.log().slice(-2000));
} finally {
  shutdown();
}

console.log("\n  ── measured ──");
for (const n of notes) console.log(`   ${n}`);
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
