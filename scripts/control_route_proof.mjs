/**
 * THE ROUTE PROOF — one control render over real HTTP, with the wire stubbed
 * and nothing else.
 *
 * WHAT IS BEING PROVEN, and why reading the source would not do it:
 *
 *   1. A control render posted to `POST /api/mv` leaves an `engine/<runId>`
 *      record in the provenance ledger, written BEFORE anything was sent.
 *   2. That record's `references` carry the SOURCE CLIP'S OWN SHA-256 — so
 *      "which clip steered this render" is answerable from the ledger rather
 *      than from somebody's memory of what they picked.
 *   3. The record's `via` says which part of the app spent the time
 *      (`mv.control`), and its actor is the CALLER's — the header a real MCP
 *      client sends — never one the route invented.
 *   4. A clip that fails the three numbers is refused with validateControlClip's
 *      own sentence, VERBATIM, and leaves NO engine record at all: nothing was
 *      staged, nothing was dispatched, no GPU was spent.
 *
 * ⚠ WHAT IS STUBBED, AND WHAT IS EMPHATICALLY NOT. Only the socket: a fake
 * `fetch` stands in for ComfyUI and answers /prompt and /history. Everything
 * else is the real thing — the real route, the real controlRender, the real
 * validateControlClip shelling out to ffprobe, the real graph builders, the
 * real `engine.dispatch()` with its real ledger-before-POST ordering, the real
 * provenance chain, and the real adoption into a clip library. A proof that
 * stubbed dispatch would be a proof about a stub.
 *
 * ⚠ AND IT TOUCHES NOTHING OF THE OWNER'S. Scratch AIPLAY_APPDATA, scratch
 * AIPLAY_RIG, scratch AIPLAY_OUTPUT, UI port 4199. It never speaks to the real
 * engine, never spawns a process, and never writes outside its own temp tree.
 *
 * Run: node scripts/control_route_proof.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";

/* ── the scratch world, set BEFORE anything imports config ────────────────── */
const ROOT = await mkdtemp(path.join(tmpdir(), "aiplay-ctlproof-"));
process.env.AIPLAY_APPDATA = path.join(ROOT, "appdata");
process.env.AIPLAY_RIG = path.join(ROOT, "rig");
process.env.AIPLAY_OUTPUT = path.join(ROOT, "rig", "ComfyUI", "output");
process.env.AIPLAY_UI_PORT = "4199";
process.env.AIPLAY_MV_DIR = path.join(ROOT, "mv");
const INPUT_DIR = path.join(ROOT, "rig", "ComfyUI", "input");
const OUT_DIR = process.env.AIPLAY_OUTPUT;
const CLIP_DIR = path.join(OUT_DIR, "clips");
for (const d of [INPUT_DIR, CLIP_DIR, process.env.AIPLAY_APPDATA]) await mkdir(d, { recursive: true });

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const run = (bin, args) => new Promise((res) =>
  execFile(bin, args, { maxBuffer: 1 << 24 }, (err, so, se) => res({ err, so: String(so), se: String(se) })));

/* ── the clips: one legal, one 96 frames, made with ffmpeg ────────────────── */
const FFMPEG = process.env.AIPLAY_FFMPEG || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
async function make(name, { w = 1280, h = 704, fps = 24, frames = 121 }) {
  const out = path.join(CLIP_DIR, name);
  const r = await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi",
    "-i", `testsrc=size=${w}x${h}:rate=${fps}:duration=${(frames / fps).toFixed(4)}`,
    "-frames:v", String(frames), "-pix_fmt", "yuv420p", out]);
  return r.err ? null : out;
}
const GOOD = await make("proof_good.mp4", {});
const SHORT = await make("proof_short.mp4", { frames: 96 });
const FAST = await make("proof_30fps.mp4", { fps: 30 });
const BIG = await make("proof_1080p.mp4", { w: 1920, h: 1080 });
if (!GOOD || !SHORT || !FAST || !BIG) {
  console.log("\n  --    no ffmpeg on this machine, so the route proof could not build its four");
  console.log("        clips and NOTHING below ran. That is a skip, not a pass: install ffmpeg");
  console.log("        (or set AIPLAY_FFMPEG) and run this again.\n");
  await rm(ROOT, { recursive: true, force: true });
  process.exit(0);
}
const GOOD_SHA = createHash("sha256").update(await readFile(GOOD)).digest("hex");

/* ── the modules, imported only now that the world is scratch ─────────────── */
const { createEngineClient, engine } = await import("../server/engine/client.js");
const prov = await import("../server/provenance.js");
const { createProject } = await import("../server/mv/store.js");
const { createMvRoutes } = await import("../server/mv/routes.js");

/* ── the stub: a fake ComfyUI on the far side of one fetch ─────────────────
 *
 * It validates nothing, which is the point — everything this proof is about
 * happens on THIS side of the socket. It answers /prompt with a prompt_id and
 * /history with a completed job whose SaveVideo wrote one file, and it writes
 * that file so the door's own hash-the-output step has something real to read.
 */
const graphs = [];
let posted = null;
let nth = 0;
const promptId = () => `proof-prompt-${nth}`;
const rendered = () => `mv_proof_${nth}_00001_.mp4`;
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  if (u.endsWith("/prompt")) {
    nth++;
    posted = JSON.parse(opts.body).prompt;
    graphs.push(posted);
    const dir = path.join(OUT_DIR, "control");
    await mkdir(dir, { recursive: true });
    /* ⚠ A REAL, LEGAL CLIP AND NOT A PLACEHOLDER. The pose path feeds its own
     * output back through validateControlClip before steering with it — that
     * composition is README.md's own claim — so a stub that wrote forty bytes of
     * text would make the second half of this proof unreachable, and the check
     * that matters most would be the one that never ran. */
    await writeFile(path.join(dir, rendered()), await readFile(GOOD));
    return { ok: true, status: 200, json: async () => ({ prompt_id: promptId() }), text: async () => "" };
  }
  if (u.includes("/history/")) {
    const id = u.split("/history/")[1];
    const n = Number(String(id).split("-").pop());
    return { ok: true, status: 200, text: async () => "", json: async () => ({
      [id]: {
        status: { status_str: "success", completed: true },
        outputs: { 12: { images: [{ filename: `mv_proof_${n}_00001_.mp4`, subfolder: "control", type: "output" }], animated: [true] } },
      },
    }) };
  }
  if (u.endsWith("/queue")) return { ok: true, status: 200, json: async () => ({ queue_running: [], queue_pending: [] }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
}

/* A client whose only difference from the app's is that one fetch. Its methods
 * are put onto the module singleton, because server/mv/control.js imports that
 * singleton — exactly as it does in production. */
const stub = createEngineClient({ fetch: fakeFetch, poll: { POLL_MS: 20 } });
stub.pinPort(45999, "control_route_proof");
stub.attachChild({ exitCode: null, signalCode: null });
stub.setAdopter(async ({ output }) => {
  /* The real adopter's contract in miniature: a video moves into the clip
   * library and reports the shelf it landed on. */
  const src = path.join(OUT_DIR, output.subfolder || "", output.file);
  const dst = path.join(CLIP_DIR, output.file);
  await writeFile(dst, await readFile(src));
  return `clips/${output.file}`;
});
for (const k of ["dispatch", "run", "submit", "runRecord", "activity", "status"]) engine[k] = stub[k];

/* ── the scratch instance on 4199 ─────────────────────────────────────────── */
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
const routes = createMvRoutes({
  json, readBody, provenance: prov, CLIP_DIR,
  library: { meta: new Map(), remember() {} },
  art: null, beatsFor: null, LRC_DIR: ROOT,
  outputDir: () => OUT_DIR,
});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4199");
  try { if (!(await routes.handle(url.pathname, req, res, url))) json(res, 404, { error: "no route" }); }
  catch (e) { json(res, 500, { error: e.message }); }
});
await new Promise((r) => server.listen(4199, "127.0.0.1", r));

const post = async (body, actor = "agent:proof") => {
  const r = await fetch("http://127.0.0.1:4199/api/mv", {
    method: "POST",
    headers: { "content-type": "application/json", "x-aiplay-actor": actor },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const doc = await createProject("Control Proof", "mv");
const SLUG = doc.slug;

console.log("\n  -- the catalogue, before any button exists --");
{
  const r = await fetch("http://127.0.0.1:4199/api/mv/control");
  const c = await r.json();
  ok("GET /api/mv/control answers with the contract, the ladder and both licences",
    r.status === 200 && c.spec.width === 1280 && c.spec.minFrames === 121
    && c.ladder.length === 4 && c.licence.vace.verified === true
    && c.licence.pose.class === "unknown",
    JSON.stringify({ spec: c.spec, pose: c.licence?.pose?.class }));
  ok("...and it carries the pose gate's caveats, not just its numbers",
    Array.isArray(c.poseGate.caveats) && c.poseGate.caveats.length === 4
    && /43 of 121/.test(c.poseGate.caveats.join(" ")));
}

console.log("\n  -- the gate runs FIRST, and a refusal costs nothing --");
{
  const fs = await import("node:fs");
  /* THREE CLIPS, THREE MECHANISMS, and each refusal checked the same four ways:
   * the status, the sentence VERBATIM, the LEDGER did not grow, and — the one
   * the ledger cannot prove by itself — THE WIRE SAW NOTHING. `nth` is the
   * stub's own count of POSTs to /prompt. Counting ledger rows catches a route
   * that dispatched and then failed; only the stub's counter tells "the engine
   * rejected it" apart from "the engine was never asked", and the second is the
   * entire claim this gate makes.
   *
   * One clip per mechanism on purpose. The three numbers fail three DIFFERENT
   * silent ways — a centre-crop, a retime, a mid-gray pad — and a proof that
   * only ever showed the frame count leaves the other two resting on a unit
   * test of judgeClip() rather than on the route. */
  const REFUSALS = [
    { clip: "proof_short.mp4", what: "a 96-frame clip",
      says: [/frame count is 96, must be at least 121/, /ImageFromBatch clamps/] },
    { clip: "proof_30fps.mp4", what: "a 30 fps clip",
      says: [/frame rate is 30\.000 fps, must be exactly 24\.000/, /silently retimes the move/] },
    { clip: "proof_1080p.mp4", what: "a 1920x1080 clip",
      says: [/width is 1920, must be exactly 1280/, /height is 1080, must be exactly 704/,
             /CENTRE-CROPS anything else, silently/] },
  ];
  for (const { clip, what, says } of REFUSALS) {
    const before = (await prov.read("library", { assetPrefix: "engine/" })).events.length;
    const wireBefore = nth;
    const r = await post({ action: "control_render", slug: SLUG, clip,
                           mode: "camera", prompt: "a shot" });
    ok(`${what} is refused with a 400`, r.status === 400, JSON.stringify(r.body).slice(0, 200));
    ok("...and the refusal is validateControlClip's own sentence, verbatim",
      /CONTROL CLIP OUT OF SPEC/.test(r.body.error || "")
      && says.every((re) => re.test(r.body.error || "")), r.body.error);
    const after = (await prov.read("library", { assetPrefix: "engine/" })).events.length;
    ok("...and NO engine record was written: nothing was staged and no GPU was asked for",
      after === before, `${before} -> ${after}`);
    ok("...and THE WIRE SAW NOTHING - dispatch() was never reached",
      nth === wireBefore, `${wireBefore} -> ${nth} POSTs to /prompt`);
    ok("...and nothing was left in the engine's input directory",
      fs.readdirSync(INPUT_DIR).length === 0, fs.readdirSync(INPUT_DIR).join(", "));
  }
  /* The pose path is a SECOND door into the same gate — it validates, extracts,
   * then validates the SKELETON — so the refusal has to land before the FIRST
   * of its two renders rather than between them. */
  {
    const wireBefore = nth;
    const r = await post({ action: "control_render", slug: SLUG, clip: "proof_1080p.mp4",
                           mode: "pose", prompt: "a shot" });
    ok("mode pose refuses at the same gate, before the DWPose half is dispatched",
      r.status === 400 && /width is 1920, must be exactly 1280/.test(r.body.error || "")
      && nth === wireBefore, `${wireBefore} -> ${nth}: ${String(r.body.error).slice(0, 140)}`);
  }
}

console.log("\n  -- ...and so is every argument the gate can judge without a machine --");
{
  /* ⚠ THE MODE THAT MADE THIS NECESSARY IS `pose`, and it is the only one that
   * could have shown it. A camera render builds its VACE graph before it
   * dispatches anything, so an argument checked inside vaceGraph() is still
   * checked before the wire. A POSE render cannot: the skeleton IS the control
   * clip, so the graph cannot exist until DWPose has already run. Measured
   * 2026-09-03, before the fix: three 400s, each with one POST to /prompt in
   * front of it. Every case below is therefore run on `mode: "pose"` — on
   * `camera` they would all pass whether the checks were hoisted or not, which
   * is the definition of a test that cannot fail. */
  const CASES = [
    ["an out-of-range strength", { strength: 5000 },
      /strength 5000 is outside WanVaceToVideo's declared 0\.\.1000/],
    ["a strength that is not a number at all", { strength: "loud" },
      /strength loud is outside WanVaceToVideo's declared 0\.\.1000/],
    ["a reference that is not an image", { reference: "not_a_sheet.txt" },
      /is not an image\. reference_image is an IMAGE input/],
    ["a reference this project does not have", { reference: "ghost_sheet.png" },
      /is not one of this project's assets/],
    ["an empty prompt", { prompt: "   " }, /WAN renders a gray field from an empty one/],
  ];
  for (const [what, extra, says] of CASES) {
    const wireBefore = nth;
    const r = await post({ action: "control_render", slug: SLUG, clip: "proof_good.mp4",
                           mode: "pose", prompt: "a shot", ...extra });
    ok(`${what} is refused, and THE WIRE SAW NOTHING`,
      r.status === 400 && says.test(r.body.error || "") && nth === wireBefore,
      `${r.status} | ${wireBefore} -> ${nth} POSTs | ${String(r.body.error).slice(0, 140)}`);
  }
  /* A reference named on a mode that renders no image is REFUSED, not ignored.
   * Silently dropping an argument somebody typed is how a person concludes the
   * reference "did nothing". */
  {
    const wireBefore = nth;
    const r = await post({ action: "control_render", slug: SLUG, clip: "proof_good.mp4",
                           mode: "extract", reference: "sheet.png" });
    ok("a reference on a mode that renders no image is refused rather than dropped",
      r.status === 400 && /renders no image, so it has nowhere to put/.test(r.body.error || "")
      && nth === wireBefore, `${r.status} | ${String(r.body.error).slice(0, 140)}`);
  }
}

console.log("\n  -- and the render itself, through the one door --");
{
  const r = await post({ action: "control_render", slug: SLUG, clip: "proof_good.mp4",
                         mode: "camera", prompt: "a night train, rain on glass", seed: 424242 });
  ok("a legal clip renders and answers 200", r.status === 200 && r.body.ok === true,
    JSON.stringify(r.body).slice(0, 300));
  const out = r.body.render;
  ok("...reporting the runId the door minted", !!out?.runId, JSON.stringify(out));
  ok("...and the operating point, seed included, so it can be repeated",
    r.body.operatingPoint?.seed === 424242 && r.body.operatingPoint?.strength === 1
    && r.body.operatingPoint?.masks === "ones", JSON.stringify(r.body.operatingPoint));

  const rec = await stub.runRecord(out.runId);
  ok("THE RECORD EXISTS on engine/<runId>, with both events",
    !!rec?.request && !!rec?.result, JSON.stringify(Object.keys(rec || {})));
  ok("...and it says which part of the app spent the time",
    rec.request.via === "mv.control", String(rec.request.via));
  ok("...under the CALLER's actor, not one the route invented",
    rec.request.actor_echo === "agent:proof", String(rec.request.actor_echo));
  ok("...naming the project and the seed the graph really carried",
    rec.request.project === SLUG && rec.request.seed === 424242,
    JSON.stringify({ project: rec.request.project, seed: rec.request.seed }));

  /* ⚠ THE ONE THAT MATTERS. The record has to point at a FILE, not at a name in
   * a folder — that is the whole difference between this and the 424 unledgered
   * renders the door was built for. */
  const refs = rec.request.references || [];
  /* The ledger writes a digest as `sha256:<hex>` — the algorithm travels with
   * the number, so a future change of hash cannot be read as the same value. */
  const hit = refs.find((x) => String(x.sha256 || "").replace(/^sha256:/, "") === GOOD_SHA);
  ok("THE SOURCE CLIP'S SHA-256 IS IN THE RECORD's references",
    !!hit, `${GOOD_SHA} not among ${refs.map((x) => `${x.file}:${x.sha256}`).join(", ")}`);
  ok("...on the LoadVideo node, which is where the control video enters the graph",
    hit?.class === "LoadVideo" && hit?.input === "file", JSON.stringify(hit));

  ok("the result event carries the output's own digest too",
    (rec.result.outputs || []).some((o) => o.file === rendered() && o.sha256),
    JSON.stringify(rec.result.outputs));
  ok("...and the output was adopted into the clip library",
    (rec.result.outputs || []).some((o) => o.adoptedAs === `clips/${rendered()}`),
    JSON.stringify((rec.result.outputs || []).map((o) => o.adoptedAs)));

  /* The graph really is the gate's graph, not a shape that happens to post. */
  ok("the graph that went to the engine is the VACE graph, at the measured point",
    posted?.["7"]?.class_type === "WanVaceToVideo" && posted["7"].inputs.strength === 1
    && posted["7"].inputs.width === 1280 && posted["7"].inputs.height === 704
    && posted["7"].inputs.length === 121 && !("control_masks" in posted["7"].inputs),
    JSON.stringify(posted?.["7"]?.inputs));
  ok("...and the staged clip was passed by BASENAME, because LoadVideo is a combo",
    typeof posted?.["20"]?.inputs?.file === "string"
    && !posted["20"].inputs.file.includes(path.sep)
    && posted["20"].inputs.file.startsWith("aiplay_ctl_src_"),
    JSON.stringify(posted?.["20"]?.inputs));
  ok("...and the staging copy was cleaned up afterwards",
    (await import("node:fs")).readdirSync(INPUT_DIR).length === 0,
    (await import("node:fs")).readdirSync(INPUT_DIR).join(", "));

  const { readProject } = await import("../server/mv/store.js");
  const d2 = await readProject(SLUG);
  const row = (d2.control || [])[0];
  ok("the project keeps the row, with the operating point as its evidence",
    row && row.runId === out.runId && row.seed === 424242 && row.strength === 1
    && row.masks === "ones" && row.source === "proof_good.mp4",
    JSON.stringify(row));
}

console.log("\n  -- the pose path: two renders, and the skeleton faces the same gate --");
{
  const n0 = nth;
  const r = await post({ action: "control_render", slug: SLUG, clip: "proof_good.mp4",
                         mode: "pose", prompt: "a dancer under sodium light", seed: 20260903 });
  ok("mode pose answers 200 and reports BOTH halves",
    r.status === 200 && !!r.body.pose?.runId && !!r.body.render?.runId,
    JSON.stringify(r.body).slice(0, 260));
  ok("...and it really was two dispatches, not one",
    nth === n0 + 2, `${n0} -> ${nth}`);
  ok("...the first graph is DWPose, at the two settings that are not preferences",
    graphs[n0]?.["23"]?.class_type === "DWPreprocessor"
    && graphs[n0]["23"].inputs.bbox_detector === "yolox_l.torchscript.pt"
    && graphs[n0]["23"].inputs.resolution === 704,
    JSON.stringify(graphs[n0]?.["23"]?.inputs));
  ok("...the second is VACE, steered by the SKELETON rather than by the source",
    graphs[n0 + 1]?.["7"]?.class_type === "WanVaceToVideo"
    && graphs[n0 + 1]["20"].inputs.file.startsWith("aiplay_ctl_pose_"),
    JSON.stringify(graphs[n0 + 1]?.["20"]?.inputs));
  ok("...and the skeleton was measured against the three numbers before it steered anything",
    r.body.pose.frames === 121 && r.body.pose.width === 1280 && r.body.pose.fps === 24,
    JSON.stringify(r.body.pose));
  ok("...both runs are in the ledger, under vias that tell the two halves apart",
    (await stub.runRecord(r.body.pose.runId))?.request?.via === "mv.control.pose"
    && (await stub.runRecord(r.body.render.runId))?.request?.via === "mv.control");
  ok("...and neither staging copy was left behind",
    (await import("node:fs")).readdirSync(INPUT_DIR).length === 0,
    (await import("node:fs")).readdirSync(INPUT_DIR).join(", "));

  /* ── AND THE COST MODEL CATCHES UP. Two real runs are now in this scratch
   * ledger, so the plan's estimate must stop quoting the README's constant and
   * start quoting this install — which is the whole point of reading the
   * ledger rather than only the document. */
  const { estimateOne } = await import("../server/mv/plan.js");
  const cost = await import("../server/mv/plancost.js");
  const { runs } = await stub.activity({ limit: 200 });
  const measured = {
    [cost.CONTROL_VIA.vace]: cost.controlMeasuredFrom(runs, cost.CONTROL_VIA.vace),
    [cost.CONTROL_VIA.pose]: cost.controlMeasuredFrom(runs, cost.CONTROL_VIA.pose),
  };
  const { readProject } = await import("../server/mv/store.js");
  const d3 = await readProject(SLUG);
  const before = estimateOne(d3, { tool: "mv_control_render", args: { mode: "camera" } });
  const after = estimateOne(d3, { tool: "mv_control_render", args: { mode: "camera" } },
    { controlRuns: measured });
  ok("with no ledger read the estimate is the stated constant and admits it",
    before.unmeasuredHere === true && before.basis === "flat", JSON.stringify(before.measuredFrom));
  ok("...and with this install's own runs it is MEASURED, from the engine's own clock",
    after.basis === "measured" && after.unmeasuredHere === false
    && /in this install/.test(after.measuredFrom), JSON.stringify(after));
}

console.log("\n  -- the free check, which is the same measurement --");
{
  const before = (await prov.read("library", { assetPrefix: "engine/" })).events.length;
  const good = await post({ action: "control_render", slug: SLUG, clip: "proof_good.mp4", mode: "check" });
  ok("check on a legal clip passes and reports the three numbers",
    good.status === 200 && good.body.ok === true && good.body.validation.width === 1280
    && good.body.validation.frames === 121 && good.body.validation.fps === 24,
    JSON.stringify(good.body.validation));
  const bad = await post({ action: "control_render", slug: SLUG, clip: "proof_short.mp4", mode: "check" });
  ok("...and on a short one it REPORTS rather than throws, so a card can paint it",
    bad.status === 200 && bad.body.ok === false && /must be at least 121/.test(bad.body.why),
    JSON.stringify({ status: bad.status, ok: bad.body.ok }).slice(0, 200));
  const after = (await prov.read("library", { assetPrefix: "engine/" })).events.length;
  ok("...and neither check went near the engine", after === before, `${before} -> ${after}`);
}

server.close();
await rm(ROOT, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
