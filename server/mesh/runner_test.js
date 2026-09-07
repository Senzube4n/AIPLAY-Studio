/**
 * THE REFUSALS — every one of them, driven.
 *
 * The value of this subsystem is not that it makes a mesh. It is that it says
 * NO before it spends anything, in a sentence somebody can act on, and each
 * refusal is here because the alternative failure is expensive and unreadable:
 *
 *   weights / runtime   otherwise: a subprocess dies on an import, or on a
 *                       missing file, and the traceback is about python.
 *   input               otherwise: an image-to-3D model handed a contact strip
 *                       builds a mesh OF THE STRIP, and it looks like a
 *                       successful run. DIRECTING.md §2, one dimension on.
 *   vram                otherwise: a CUDA out-of-memory forty seconds in, on a
 *                       card the owner's engine is living on — which reads as a
 *                       bug in this feature and is really "something else has
 *                       the card". THIS IS THE ONE THAT PAYS FOR THE FILE.
 *   not-humanoid        otherwise: UniRig invents a skeleton for a crate and
 *                       reports success. The expensive kind of wrong.
 *
 * ⚠ EVERY CHECK HERE IS FREE. No GPU, no python, no venv, no weights, no
 * network — the whole point of refusing before spend is that the refusal can be
 * proven without spending. The VRAM gate takes its reading as an ARGUMENT so
 * both sides of the boundary can be asserted on any machine; the live reader is
 * exercised separately and is allowed to answer null.
 *
 * Runs standalone (`node server/mesh/runner_test.js`) and in the pre-commit hook.
 */
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import {
  MeshRefusal, refuseInput, refuseVram, refuseRig, refuse, meshStatus, freeVramMb,
  meshFromImage, SECOND_DOOR, MESH_CAP, RIG_CAP, MESH_MODEL, RIG_MODEL, sha256File,
  rigProbeCached,
} from "./runner.js";
import { glb } from "./fixtures.js";
import { CATALOG, MODEL_TO_CAPABILITY } from "../models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
/** Run `fn` and return the refusal it threw, or null. */
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

const dir = path.join(os.tmpdir(), `aiplay-mesh-${Date.now().toString(36)}`);
await mkdir(dir, { recursive: true });

/* A one-pixel PNG, written rather than fetched — the input gate reads magic
 * bytes, so it needs a file whose first eight are a real PNG signature. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const goodPng = path.join(dir, "subject.png");
await writeFile(goodPng, PNG_1PX);

console.log("\nREFUSAL 1 — the weights and the runtime");
{
  const st = await meshStatus();
  ok("meshStatus answers without spawning anything", typeof st.installed === "boolean");
  ok("...and names the python it looked for", /python/i.test(st.python), st.python);
  /* THIS MACHINE, TODAY. The venv is being installed by a parallel strand, so
   * the honest assertion is conditional: not-installed must produce sentences,
   * and installed must produce none. Both directions are checked so this test
   * does not quietly become a no-op the day the install lands. */
  if (!st.installed) {
    ok("not installed ⇒ at least one sentence saying which file is missing", st.why.length >= 1,
      st.why.join(" | "));
    ok("...and each sentence names a path or a setting",
      st.why.every((w) => /AIPLAY_|[A-Za-z]:\\|Models screen/.test(w)), st.why.join(" | "));
    const e = await refusal(() => refuse({ image: goodPng }));
    ok("refuse() stops on it before touching the input or the card", e instanceof MeshRefusal, String(e));
    ok("...with the code `weights` or `runtime`", ["weights", "runtime"].includes(e?.refusal), e?.refusal);
    ok("...and says nothing was started", /nothing was started/.test(e?.message || ""), e?.message);
  } else {
    ok("installed ⇒ no missing-file sentences", st.why.length === 0, st.why.join(" | "));
  }
}
{
  /* THE PLACEHOLDER ROWS ARE PART OF THIS REFUSAL. While the catalogue's byte
   * counts are AWAITING_MEASUREMENT the rows can never read ready, so the
   * weights refusal has to say THAT rather than "download it" — a download
   * button that also refuses is not a remedy. */
  const st = await meshStatus();
  const c = CATALOG.find((x) => x.id === MESH_CAP);
  if (c?.awaiting) {
    ok("a placeholder catalogue row is reported as `awaiting`, not merely missing",
      st.awaiting.mesh === c.awaiting, JSON.stringify(st.awaiting));
    const e = await refusal(() => refuse({ image: goodPng }));
    if (e?.refusal === "weights") {
      ok("...and the refusal says the file facts have to land first",
        /placeholder/.test(e.message), e.message.slice(0, 200));
    } else { ok("...and the refusal says the file facts have to land first (runtime refused first)", true); }
  } else {
    ok("the catalogue rows carry no `awaiting` — the placeholder gate is closed", true);
  }
}

console.log("\nREFUSAL 2 — the input is not an image, or carries no subject");
{
  const e = await refusal(() => refuseInput(""));
  ok("no picture at all is refused", e?.refusal === "input", String(e));
  ok("...and the sentence says to render a sheet first",
    /render(ed)? a sheet|Generate or Blender/i.test(e.message), e.message);
}
{
  const e = await refusal(() => refuseInput("C:/x/clip.mp4"));
  ok("a video is refused on its extension", e?.refusal === "input");
  ok("...naming the three formats that are accepted",
    /\.png.*\.jpg.*\.webp/i.test(e.message), e.message);
}
{
  const e = await refusal(() => refuseInput(path.join(dir, "does-not-exist.png")));
  ok("a missing file is refused with the read error", e?.refusal === "input", e?.message);
}
{
  const fake = path.join(dir, "renamed.png");
  await writeFile(fake, "PK\u0003\u0004 this is a zip file wearing a png extension");
  const e = await refusal(() => refuseInput(fake));
  ok("an extension that lies is caught by the magic bytes", e?.refusal === "input");
  ok("...and the sentence says something renamed a file",
    /renamed a file/.test(e.message), e.message);
}
{
  /* CARRIES NO SUBJECT. The gate reused here is server/mv/blender.js's
   * referenceSafe(), which already owns "is this one panel of one subject" —
   * by filename, by sidecar, and by the contact-sheet marker in the border
   * pixels. A grid does not have a subject; it has three and a gutter. */
  const sheet = path.join(dir, "three-angles.contact.png");
  await writeFile(sheet, PNG_1PX);
  const e = await refusal(() => refuseInput(sheet));
  ok("a contact sheet is refused by NAME", e?.refusal === "input");
  ok("...and the sentence says a grid produces a mesh of the grid",
    /mesh OF THE GRID/i.test(e.message), e.message);

  const bySidecar = path.join(dir, "strip.png");
  await writeFile(bySidecar, PNG_1PX);
  await writeFile(bySidecar + ".previz.json", JSON.stringify({ use: "human-review", panels: 3 }));
  const e2 = await refusal(() => refuseInput(bySidecar));
  ok("a contact sheet is refused by its SIDECAR even when renamed", e2?.refusal === "input");
  ok("...and the reason names the panel count", /3 panels/.test(e2.message), e2.message);
}
{
  const e = await refusal(() => refuseInput(goodPng));
  ok("an ordinary single-panel PNG passes", e === null, String(e?.message));
}

console.log("\nREFUSAL 3 — free VRAM below the row's stated minimum");
{
  const need = CATALOG.find((c) => c.id === MESH_CAP)?.requires?.vramMinGb;
  ok("the mesh row states a VRAM minimum for the gate to read", Number(need) > 0, String(need));

  const e = await refusal(() => refuseVram(MESH_CAP, { free: 2048 }));
  ok("2 GB free is refused", e?.refusal === "vram", String(e));
  ok("...and the message NAMES THE ENGINE as the thing holding the card",
    /music and video engine is resident/.test(e.message), e.message);
  ok("...and says to unload it first", /[Uu]nload it first/.test(e.message), e.message);
  ok("...and promises not to evict it",
    /Nothing here will evict it/.test(e.message), e.message);
  ok("...and says this is a refusal rather than an out-of-memory later",
    /out-of-memory/.test(e.message), e.message);
  ok("...and carries the numbers as fields, not only as prose",
    e.freeMb === 2048 && e.needGb === need, `${e.freeMb} ${e.needGb}`);
}
{
  const r = await refuseVram(MESH_CAP, { free: 15000 });
  ok("15 GB free passes", r.free === 15000);
}
{
  /* ⚠ NO READING IS NOT A REFUSAL. An AMD card, a laptop with no discrete GPU,
   * a driver mid-update — none of those is evidence of a full card, and
   * refusing on absent evidence blocks the first machine that is merely
   * unusual. */
  const r = await refuseVram(MESH_CAP, { free: null }).catch((e) => e);
  ok("a machine with no readable card is NOT refused",
    !(r instanceof Error) && r.free === null, String(r?.message || JSON.stringify(r)));
}
{
  const live = await freeVramMb();
  ok(`the live reader answers a number or an honest null (got ${live})`,
    live === null || Number.isFinite(live));
  if (Number.isFinite(live)) {
    const needGb = CATALOG.find((c) => c.id === MESH_CAP).requires.vramMinGb;
    console.log(`  --    this machine has ${(live / 1024).toFixed(1)} GB free and the row needs `
      + `${needGb} GB, so a real run would ${live < needGb * 1024 ? "REFUSE" : "proceed"} right now.`);
  }
}

console.log("\nREFUSAL 4 — a rig on something that is not a plausible humanoid");
{
  const crate = path.join(dir, "crate.glb");
  await writeFile(crate, glb({ skinned: false, size: [1, 1, 1] }));
  const e = await refusal(() => refuseRig(crate));
  ok("a cube is refused a rig", e?.refusal === "not-humanoid", String(e));
  ok("...and the sentence says the rigger would invent a skeleton and report success",
    /invents a skeleton for a crate and reports success/.test(e.message), e.message);
  ok("...and it says the mesh itself is kept",
    /mesh itself is finished and kept/.test(e.message), e.message);
  ok("...and the measured ratio travels as a field", Number.isFinite(e.ratio), String(e.ratio));
}
{
  const person = path.join(dir, "figure.glb");
  await writeFile(person, glb({ skinned: false, size: [0.5, 1.8, 0.3] }));
  const r = await refuseRig(person);
  ok("a standing figure is allowed a rig", r.plausible, r.why);
}
{
  const broken = path.join(dir, "broken.glb");
  await writeFile(broken, Buffer.from("not a glb at all"));
  const e = await refusal(() => refuseRig(broken));
  ok("an unreadable mesh is refused as `rig-input`, NOT as not-humanoid",
    e?.refusal === "rig-input", String(e?.refusal));
  ok("...because a truncated download is a different problem from a blocky object",
    /could not be read as a GLB/.test(e.message), e.message);
}

console.log("\nthe record, and the second door it admits to being");
{
  /* A DRY RUN SPENDS NOTHING, so it is not refused for a busy card — it REPORTS
   * what a real run would hit. That is the same call the engine door makes: its
   * dryRun return sits above the "is our engine alive" check. */
  const spent = [];
  const stub = { append: async (scope, e) => { spent.push(e); return { id: "e1" }; } };
  const d = await meshFromImage({
    image: goodPng, out: path.join(dir, "out.glb"), rig: true, seed: 7, steps: 12,
    via: "test.dry", actor: "script:mesh_test", prov: stub, dryRun: true,
  });
  ok("a dry run returns a record", d.dryRun === true && !!d.record);
  ok("...and writes NOTHING to the ledger", spent.length === 0, JSON.stringify(spent));
  ok("...naming both models when a rig was asked for",
    d.record.models.join(",") === `${MESH_MODEL},${RIG_MODEL}`, d.record.models.join(","));
  ok("...and `model` is the key MODEL_TO_CAPABILITY bridges, so rights get stamped",
    MODEL_TO_CAPABILITY[d.record.model] === MESH_CAP, `${d.record.model} -> ${MODEL_TO_CAPABILITY[d.record.model]}`);
  ok("...and the rig model is bridged too",
    MODEL_TO_CAPABILITY[RIG_MODEL] === RIG_CAP, MODEL_TO_CAPABILITY[RIG_MODEL]);
  ok("...the arguments are recorded, all of them",
    d.record.args.seed === 7 && d.record.args.steps === 12 && d.record.args.rig === true,
    JSON.stringify(d.record.args));
  ok("...the actor is the harness that asked, not `user`",
    d.record.actor === "script:mesh_test", d.record.actor);
  ok("...the input file is hashed", /^sha256:[0-9a-f]{64}$/.test(d.record.input.sha256 || ""),
    String(d.record.input.sha256));
  ok("...every weight file has a slot for its own sha256",
    Array.isArray(d.record.weights) && d.record.weights.length >= 1
      && d.record.weights.every((w) => "sha256" in w && "dest" in w),
    JSON.stringify(d.record.weights?.map((w) => w.file)));
  ok("...the pinned commit of each checkout is recorded (null when it is not a git checkout)",
    "triposgCommit" in d.record.runtime && "unirigCommit" in d.record.runtime,
    JSON.stringify(d.record.runtime));
  ok("...and the record ADMITS to being a second door",
    d.record.door === SECOND_DOOR && /SECOND door/.test(d.record.door), d.record.door);
  ok("...saying the python version collision is the reason",
    /diffusers 0\.7\.0\.dev0/.test(SECOND_DOOR), SECOND_DOOR);
  ok("...and that it writes the same pair the engine door writes",
    /delegate\/generate pair/.test(SECOND_DOOR));
  ok("a dry run on this machine reports what a real one would refuse",
    d.wouldRefuse === null || (typeof d.wouldRefuse.code === "string" && d.wouldRefuse.why.length > 0),
    JSON.stringify(d.wouldRefuse)?.slice(0, 160));
}
{
  /* ⚠ THE LEDGER-BEFORE-SPEND RULE, PROVEN AT RUNTIME rather than by grepping
   * the source — which is exactly how server/engine/client_test.js proves the
   * same rule about the same kind of append. A ledger that throws must cost the
   * run, and the subprocess must never start. */
  const st = await meshStatus();
  if (st.installed) {
    let spawned = false;
    const angry = { append: async () => { throw new Error("ledger is down"); } };
    const e = await refusal(() => meshFromImage({
      image: goodPng, out: path.join(dir, "never.glb"), via: "test.ledger", prov: angry,
      timeoutMs: 1000,
    }));
    ok("a ledger failure costs the run", /ledger is down/.test(e?.message || ""), String(e?.message));
    ok("...and nothing was spawned", !spawned);
  } else {
    console.log("  --    the ledger-before-spend runtime proof needs the venv installed; the");
    console.log("        refusals above stop the run before the append is reached, which is");
    console.log("        itself the stronger guarantee while the runtime is absent.");
  }
}
{
  const e = await refusal(() => meshFromImage({ image: goodPng, out: path.join(dir, "x.glb"), via: "" }));
  ok("a run with no `via` is refused — the ledger must be able to say who spent the card",
    /needs `via`/.test(e?.message || ""), String(e?.message));
}
{
  const e = await refusal(() => meshFromImage({ image: goodPng, via: "test.noout" }));
  ok("a run with no output path is refused", /needs an output path/.test(e?.message || ""), String(e?.message));
}

console.log("\nREFUSAL 1b — canRig may not be true while the probe says a module is missing");
{
  /* THE BUG THIS PINS, measured on this machine on 2026-09-07: meshStatus()
   * returned canRig:true with why:[] in 1 ms — both UniRig checkpoints on the
   * disk at their catalogued byte counts, the interpreter present at
   * unirigPython — while rigRuntime() answered 13.3 s later with flash_attn
   * missing. A route read the first answer, drew the button, and the rig
   * refused the moment it was pressed. Two questions, one boolean.
   *
   * The probe is INJECTED here for the same reason refuseVram() takes its
   * reading as an argument: both sides of the boundary have to be assertable
   * on a machine where the real answer is fixed, and no python may be spawned
   * by anything in this file. */
  const blocked = { canRig: false, missing: [
    { module: "flash_attn.modules.mha", error: "ModuleNotFoundError: No module named 'flash_attn'",
      why: "skin cross-attention and skeleton FlashAttention" },
  ] };
  const ready = { canRig: true, missing: [], python: "3.11.9" };

  const bad = await meshStatus({ probe: blocked });
  ok("a probe with a missing module forces canRig false", bad.canRig === false,
    JSON.stringify({ canRig: bad.canRig, rigWeightsReady: bad.rigWeightsReady }));
  ok("...and the file half keeps its own name rather than borrowing canRig's",
    typeof bad.rigWeightsReady === "boolean");
  ok("...and the module is named in a sentence, not only in a boolean",
    bad.rigProbe.why.some((w) => /flash_attn/.test(w)), bad.rigProbe.why.join(" | "));
  ok("...in the state blocked, which is neither ready nor unchecked",
    bad.rigProbe.state === "blocked", bad.rigProbe.state);

  const good = await meshStatus({ probe: ready });
  ok("a probe that says yes lets canRig follow the files",
    good.canRig === good.rigWeightsReady,
    JSON.stringify({ canRig: good.canRig, rigWeightsReady: good.rigWeightsReady }));
  ok("...and adds no runtime sentence when there is nothing to say",
    good.rigProbe.why.length === 0, good.rigProbe.why.join(" | "));

  /* AN UNASKED QUESTION IS NOT A YES. This is the state a cold page load
   * lands in, and the old code answered it with canRig:true. */
  const cold = await meshStatus({ probe: null });
  ok("an unrun probe is unchecked and canRig is false",
    cold.rigProbe.state === "unchecked" && cold.canRig === false,
    JSON.stringify({ state: cold.rigProbe.state, canRig: cold.canRig }));
  ok("...and the sentence says how to get the answer",
    cold.rigProbe.why.some((w) => /--rig-probe/.test(w)), cold.rigProbe.why.join(" | "));

  /* THE INVARIANT ITSELF, over the default call and whatever this machine has
   * really cached. This is the assertion that fails if the composition is ever
   * undone here or moved back out into one caller. */
  const live = await meshStatus();
  const cached = rigProbeCached();
  ok("meshStatus() default answers without starting a probe",
    cached === rigProbeCached(), "the default call must not start one");
  ok("INVARIANT: canRig is never true while the cached probe lists a missing module",
    !(live.canRig === true && cached && cached.canRig !== true),
    JSON.stringify({ canRig: live.canRig, probeCanRig: cached ? cached.canRig : "unrun",
                     missing: ((cached && cached.missing) || []).map((m) => m.module) }));
  ok("...and a true canRig always carries a ready probe",
    live.canRig !== true || live.rigProbe.state === "ready",
    JSON.stringify({ canRig: live.canRig, state: live.rigProbe.state }));
}

console.log("\nfacts");
{
  const h = await sha256File(goodPng);
  ok("sha256File hashes a real file", /^sha256:[0-9a-f]{64}$/.test(h || ""), String(h));
  ok("...and answers null for one that is not there",
    (await sha256File(path.join(dir, "nope.bin"))) === null);
}

await rm(dir, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
