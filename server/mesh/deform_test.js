/**
 * "RIGGED" MEANS THE VERTICES MOVE, AS A TEST.
 *
 * ── THE FINDING ───────────────────────────────────────────────────────────
 *
 * An audit built two GLB files that are identical in every structural respect
 * a glTF reader can name — the same `skins[]`, the same `joints`, MAT4
 * `inverseBindMatrices` one per joint, `JOINTS_0` and `WEIGHTS_0` on the
 * primitive, every vertex weighted, every weight row summing to exactly one,
 * the same generator, the same vertex count, the same file size to the byte.
 * One deforms and the other does not. `assertSkinned` passes both. The Khronos
 * validator passes both. No amount of parsing separates them, because the
 * difference is not in the structure.
 *
 * So this suite does not parse. It POSES, and measures.
 *
 * ── THE TWO HALVES, AND WHY THE SECOND ONE IS ALLOWED TO BE ABSENT ────────
 *
 * §1-§6, §8 and §9 are closed-form linear blend skinning in this process. No
 * python, no venv, no GPU, no Blender, nothing to install: `deform.js` reads
 * the file's own POSITION / JOINTS_n / WEIGHTS_n / bind matrices and does the
 * arithmetic the specification describes. They always run. They are the gate.
 * §8 is the cost, printed every run, because this check now sits inside the rig
 * path and there is no rigged character on this machine to time it against. §9 is
 * the sampler: a genuine rig that the old fixed-stride sampling reported RIGID,
 * and a mesh with no size that it reported rigid rather than unreadable.
 *
 * §7 asks Blender the same question about the same file through a genuinely
 * independent reader — its own importer, its own armature model, its own
 * dependency graph. That needs bpy, which is a GPL boundary this Apache-2.0
 * tree does not cross, so the script lives in the previz toolkit and the
 * interpreter is optional. When either is missing this section SKIPS LOUDLY,
 * naming the file and the setting that moves it, and reports UNRUN — never a
 * pass. A gate that treats a missing tool as a pass opens itself on every
 * machine that lacks the tool, which is every machine eventually.
 *
 * ⚠ THE STRAY MESH. `bpy.ops.object.armature_add()` leaves a small extra mesh
 * object behind, so a generated fixture imports as TWO meshes and the small one
 * carries no armature modifier. The original audit harness worked around it by
 * taking the mesh with the most vertices; the toolkit script keeps that rule
 * and §7 asserts it, so the workaround is a checked fact rather than folklore.
 *
 * Runs standalone (`node server/mesh/deform_test.js`) and in the pre-commit
 * hook. No GPU in either half.
 */
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { readGlb, readGlbFile, assertSkinned } from "./glb.js";
import { inspectRig, rigEvidence } from "./asset.js";
import { packGlb, glbDoc, glb, bigRigDoc, hiddenJointRigDoc, degenerateRigDoc,
         legacyStrideIndices } from "./fixtures.js";
import { assertDeforms, bpyDeform, deformReport, deformScriptPath,
         MIN_STRAIN, PROBE_DEGREES, MAX_SAMPLES } from "./deform.js";
import { config } from "../config.js";

let pass = 0;
const failures = [];
const skips = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
function skip(label, why) {
  skips.push(label);
  console.log(`  SKIP  ${label}\n          ${why}`);
}

/* ── §1 THE PAIR ─────────────────────────────────────────────────────────── */
console.log("\n§1  two files nothing structural can tell apart");
const rigged = glb({ skinned: true });
const bound = glb({ skinned: true, rigid: true });
const riggedDoc = readGlb(rigged), boundDoc = readGlb(bound);
{
  ok("both containers parse", riggedDoc.ok && boundDoc.ok,
    [...riggedDoc.why, ...boundDoc.why].join("; "));
  ok("...and they are the same size to the byte",
    rigged.length === bound.length, `${rigged.length} vs ${bound.length}`);
  const a = riggedDoc.json, b = boundDoc.json;
  ok("...the same skins[], joints and inverseBindMatrices accessor",
    JSON.stringify(a.skins) === JSON.stringify(b.skins), JSON.stringify(b.skins));
  ok("...the same node hierarchy",
    JSON.stringify(a.nodes) === JSON.stringify(b.nodes));
  ok("...the same JOINTS_0/WEIGHTS_0 attributes on the same primitive",
    JSON.stringify(a.meshes[0].primitives[0].attributes)
    === JSON.stringify(b.meshes[0].primitives[0].attributes));
  ok("...and the same accessors describing them",
    JSON.stringify(a.accessors) === JSON.stringify(b.accessors));

  /* THE WHOLE POINT: the check this repo already had cannot separate them. */
  const sa = assertSkinned(riggedDoc.json), sb = assertSkinned(boundDoc.json);
  ok("assertSkinned PASSES the rig", sa.ok === true, sa.why.join("; "));
  ok("assertSkinned ALSO PASSES the one that does not deform", sb.ok === true, sb.why.join("; "));
  ok("...with the same joint count and the same vertex count",
    sa.joints === sb.joints && sa.vertices === sb.vertices);
}

/* ── §2 THE MEASUREMENT SEPARATES THEM ───────────────────────────────────── */
console.log("\n§2  posing the skeleton, which is the only thing that does");
const dRig = assertDeforms(riggedDoc.json);
const dBound = assertDeforms(boundDoc.json);
{
  ok("the rig is accepted: it deforms", dRig.state === "deforms" && dRig.ok === true,
    `${dRig.state} strain=${dRig.strain}`);
  ok("THE FAILING FILE IS REFUSED: it binds and does not deform",
    dBound.state === "rigid" && dBound.ok === false, `${dBound.state} strain=${dBound.strain}`);
  ok("...and the refusal says why in words somebody can act on",
    /binds and it does not deform/.test(dBound.why.join(" ")), dBound.why.join(" "));
  ok("...naming the joint it turned and how far",
    dRig.jointName === "spine" && dRig.probeDegrees === PROBE_DEGREES,
    `${dRig.jointName} @ ${dRig.probeDegrees}`);
}
{
  /* ⚠ THE NAIVE TEST WOULD HAVE PASSED THE FAILING FILE, and this is the
   * assertion that keeps anybody from replacing the strain measurement with
   * it. "Rotate a bone, did vertices move" is satisfied by putting all the
   * weight on the root: every vertex moves, and the mesh has not deformed.
   * It has been carried. */
  ok("every vertex of the non-deforming file DOES move when its root is turned",
    dBound.movedFraction === 1, String(dBound.movedFraction));
  ok("...so \"did any vertex move\" would have passed it, and strain does not",
    dBound.movedFraction === 1 && dBound.state === "rigid");
}
{
  const gap = dRig.strain / MIN_STRAIN, floor = MIN_STRAIN / Math.max(dBound.strain, Number.MIN_VALUE);
  ok(`the rig clears the floor by more than 100x (${gap.toExponential(1)}x)`, gap > 100);
  ok(`the bind sits more than 1000x below it (${floor.toExponential(1)}x)`, floor > 1000);
  ok("...so the verdict is not a close call in either direction", gap > 100 && floor > 1000);
}

/* ── §3 CANNOT-TELL IS ITS OWN ANSWER ────────────────────────────────────── */
console.log("\n§3  unreadable is not \"rigid\" — a crash is not a verdict");
{
  ok("no document at all is a refusal, not a throw", assertDeforms(null).state === "unreadable");
  ok("a document with no skins says there is nothing to pose",
    assertDeforms({ skins: [] }).state === "unreadable");
  const un = assertDeforms(readGlb(glb({ skinned: false })).json);
  ok("an unrigged mesh is \"unreadable\", NOT \"rigid\"", un.state === "unreadable", un.why.join("; "));
  ok("...because it was never posed and so was never shown to be anything",
    /no `skins`/.test(un.why.join(" ")), un.why.join(" "));
}
{
  const noIbm = readGlb(packGlb(glbDoc({ skinned: true, breaks: "ibm" })));
  const r = assertDeforms(noIbm.json);
  ok("a skin with no bind matrices cannot be posed and says so",
    r.state === "unreadable", `${r.state}: ${r.why.join("; ")}`);
}
{
  const doc = glbDoc({ skinned: true });
  doc.bufferViews[0].extensions = { EXT_meshopt_compression: {} };
  const g = readGlb(packGlb(doc));
  const r = assertDeforms(g.json);
  ok("a compressed bufferView is \"unreadable\", not a failed rig", r.state === "unreadable");
  ok("...and the reason names what could not be done",
    /could not be posed/.test(r.why.join(" ")), r.why.join(" "));
}
{
  const g = readGlb(glb({ skinned: true }));
  const copy = structuredClone(g.json);
  ok("a copied document with no BIN handed in is unreadable, not rigid",
    assertDeforms(copy).state === "unreadable");
  ok("...and passing the BIN explicitly poses it",
    assertDeforms(copy, g.binData).state === "deforms");
}

/* ── §4 THE ARITHMETIC ───────────────────────────────────────────────────── */
console.log("\n§4  the properties strain must have if the maths is right");
{
  /* STRAIN IS INVARIANT UNDER RIGID PLACEMENT. Move and turn the whole
   * skeleton in the scene: the mesh's internal shape change under a bone
   * rotation cannot depend on where the scene put it. If this drifts, the
   * measurement is picking up the placement rather than the deformation. */
  const doc = glbDoc({ skinned: true });
  doc.nodes[1].translation = [3.5, -2, 11];
  // 30 degrees about X, as a unit quaternion in glTF's (x, y, z, w) order.
  doc.nodes[1].rotation = [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)];
  const moved = assertDeforms(readGlb(packGlb(doc)).json);
  ok("strain is unchanged when the whole skeleton is moved in the scene",
    Math.abs(moved.strain - dRig.strain) < 1e-9, `${moved.strain} vs ${dRig.strain}`);
}
{
  /* AND UNDER SCALE, because it is normalised by the mesh's own diagonal.
   * A figurine and a cathedral with the same rig give the same number. */
  const big = assertDeforms(readGlb(glb({ skinned: true, size: [50, 180, 30] })).json);
  ok("strain is unchanged when the mesh is 100x larger",
    Math.abs(big.strain - dRig.strain) < 1e-6, `${big.strain} vs ${dRig.strain}`);
}
{
  const flat = assertDeforms(readGlb(glb({ skinned: true, size: [0.5, 1.8, 0.3] })).json);
  ok("the same document measured twice gives the same number (deterministic)",
    flat.strain === dRig.strain, `${flat.strain} vs ${dRig.strain}`);
}
{
  ok("the verdict carries the constants it judged by, so a reader can check them",
    dRig.minStrain === MIN_STRAIN && dRig.probeDegrees === PROBE_DEGREES);
  ok("...and how much of the mesh it actually looked at",
    dRig.sampled > 0 && dRig.vertices >= dRig.sampled, `${dRig.sampled}/${dRig.vertices}`);
  ok("...and how many joints it turned", dRig.probedJoints === 3, String(dRig.probedJoints));
  ok("only joints that own vertices are probed on the bound file",
    dBound.probedJoints === 1, String(dBound.probedJoints));
}

/* ── §5 UNRUN IS NEVER A PASS ────────────────────────────────────────────── */
console.log("\n§5  the second opinion, when it cannot be had");
{
  const r = await bpyDeform("nowhere.glb", { python: "no-such-python-for-this-test.exe" });
  ok("a missing rig interpreter reports UNRUN", r.state === "unrun" && r.ok === false, r.state);
  ok("...naming the interpreter and the setting that moves it",
    /no-such-python-for-this-test\.exe/.test(r.why.join(" "))
    && /AIPLAY_UNIRIG_PYTHON/.test(r.why.join(" ")), r.why.join(" "));
  ok("...and saying in as many words that this is not a pass",
    /UNRUN, not a pass/.test(r.why.join(" ")));
}
{
  const r = await bpyDeform("nowhere.glb",
    { python: process.execPath, script: "no-such-deform-script-for-this-test.py" });
  ok("a missing toolkit script reports UNRUN", r.state === "unrun", r.state);
  /* ⚠ IT USED TO ASSERT THE WORD "submodule", AND THE WORD WAS WRONG. This tree
   * has no .gitmodules and no vendor/ directory, so the reason it was checking for
   * told the reader to run `git submodule update --init` - a command that succeeds,
   * fetches nothing, and leaves them exactly where they started with no idea why.
   * The reason must still say what is missing, where it comes from and how to point
   * at it; that is three clauses where the old form checked two. */
  ok("...naming the script, the toolkit that carries it, and the setting that points at it",
    /no-such-deform-script-for-this-test\.py/.test(r.why.join(" "))
    && /previz toolkit/.test(r.why.join(" "))
    && /AIPLAY_DEFORM_SCRIPT/.test(r.why.join(" ")), r.why.join(" "));
}
{
  /* A REAL SPAWN THAT ANSWERS NOTHING. node runs, exits 0, prints no marker:
   * the one shape of failure a "did it exit cleanly" check would call a pass. */
  const quiet = path.join(os.tmpdir(), "aiplay-deform-quiet-test.js");
  await writeFile(quiet, "process.exit(0);\n");
  try {
    const r = await bpyDeform("nowhere.glb", { python: process.execPath, script: quiet });
    ok("a subprocess that exits 0 with no verdict is UNRUN, not a pass",
      r.state === "unrun" && r.ok === false, r.state);
    ok("...and the reason names the missing marker",
      /DEFORM_RESULT_JSON/.test(r.why.join(" ")), r.why.join(" "));
  } finally { await rm(quiet, { force: true }); }
}
{
  const r = await deformReport("nowhere.glb", riggedDoc.json, undefined, { bpy: false });
  ok("deformReport without the cross-check still gates on the closed form",
    r.state === "deforms" && r.ok === true);
  ok("...and reports the cross-check as UNRUN with agreement unknown",
    r.cross.state === "unrun" && r.agree === null);
}

/* ── §6 THE ADMISSION RULE, DRIVEN ───────────────────────────────────────── */
console.log("\n§6  the rig path's own admission rule");
{
  /* A gate is only worth having if the app consults it, so this drives
   * inspectRig() — the function BOTH rig verbs in asset.js call before they
   * write `rigFile` — against the two files on disk. `bpy: false` because §7
   * covers the cross-check and this section is about the rule. */
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-rigpath-"));
  try {
    const good = path.join(dir, "rigged.glb"), bad = path.join(dir, "bound.glb");
    const plain = path.join(dir, "plain.glb");
    await writeFile(good, rigged);
    await writeFile(bad, bound);
    await writeFile(plain, glb({ skinned: false }));

    const a = await inspectRig(good, { bpy: false });
    const b = await inspectRig(bad, { bpy: false });
    const c = await inspectRig(plain, { bpy: false });
    ok("the rig path ACCEPTS a file whose vertices move", a.rigged === true,
      JSON.stringify(rigEvidence(a)));
    ok("THE RIG PATH REFUSES A FILE THAT BINDS AND DOES NOT DEFORM",
      b.rigged === false, JSON.stringify(rigEvidence(b)));
    ok("...even though its skin verifies exactly as well as the accepted one's",
      b.skin.ok === true && b.skin.joints === a.skin.joints,
      `${b.skin.joints} joints, ok=${b.skin.ok}`);
    ok("an unrigged mesh is refused as unreadable, not as a failed rig",
      c.rigged === false && c.deform.state === "unreadable", c.deform.state);

    const ea = rigEvidence(a), eb = rigEvidence(b);
    ok("the accepted file's evidence carries the measurement, not just a boolean",
      ea.deforms === "deforms" && ea.strain > MIN_STRAIN && ea.deformJoint === "spine",
      JSON.stringify(ea));
    ok("the refused file's evidence says why in a sentence somebody can act on",
      eb.deforms === "rigid" && eb.why.length > 0, JSON.stringify(eb));
    ok("...and records the un-run cross-check as unrun, with agreement unknown",
      eb.deformCrossCheck === "unrun" && eb.deformCrossAgreed === null,
      `${eb.deformCrossCheck}/${eb.deformCrossAgreed}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
{
  /* ⚠ AND THE WIRING, READ OUT OF THE SOURCE, the way ui_test.js reads the
   * page's action names. Everything above calls inspectRig() directly, so an
   * edit that put `skin.ok` back in front of `rigFile` would pass all of it.
   * These four assertions are the ones that would not. */
  const src = await readFile(new URL("./asset.js", import.meta.url), "utf8");
  const writes = [...src.matchAll(/row\.rigFile = staged;/g)];
  ok("asset.js writes row.rigFile in exactly the two rig verbs", writes.length === 2, String(writes.length));
  ok("...and every one of them is guarded by the combined verdict",
    writes.length === 2 && writes.every((m) => /check\.rigged/.test(src.slice(Math.max(0, m.index - 120), m.index))),
    "a row.rigFile assignment is not behind check.rigged");
  ok("...and none is guarded by the skin assertion alone",
    !/if \(skin\.ok\)\s*row\.rigFile/.test(src));

  const run = await readFile(new URL("./runner.js", import.meta.url), "utf8");
  ok("runner.js decides rig-failed on the combined verdict in both verbs",
    /const rigOk = rig \? \(skin\.ok && deform\.ok\) : null;/.test(run)
    && /const rigOk = skin\.ok && deform\.ok;/.test(run),
    "runner.js still gates a rig on skin.ok alone");
  ok("...and its refusal names the case no structural check can see",
    /BINDS BUT DOES NOT DEFORM/.test(run));
}

/* ── §7 BLENDER, THE INDEPENDENT READER ──────────────────────────────────── */
console.log("\n§7  Blender's own answer about the same two files");
const rigPython = config.mesh.unirigPython;
const script = deformScriptPath();
let interpreterReason = null;
try { await stat(rigPython); } catch {
  interpreterReason = `The rig interpreter is not at ${rigPython}. It is the venv with bpy 4.2 in it; `
    + `set AIPLAY_UNIRIG_PYTHON to yours. Blender's half of this suite did not run — UNRUN, not a pass.`;
}
if (!interpreterReason) {
  try { await stat(script); } catch {
    interpreterReason = `The deformation script is not at ${script}. It imports bpy, so it lives in the `
      + `GPL previz toolkit, and this Apache-2.0 tree ships no copy of it. Clone the toolkit and set `
      + `AIPLAY_DEFORM_SCRIPT at its script. Blender's half of this suite did not run — UNRUN, not a pass.`;
  }
}

if (interpreterReason) {
  skip("Blender builds the two fixtures", interpreterReason);
  skip("Blender refuses the non-deforming one", interpreterReason);
  skip("Blender and the closed form agree", interpreterReason);
} else {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-deform-"));
  try {
    const built = await new Promise((resolve) => {
      const c = spawn(rigPython, [script, "--make-fixtures", dir], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      c.stdout.on("data", (b) => { out += b; });
      c.stderr.on("data", (b) => { err += b; });
      c.once("error", (e) => resolve({ error: e.message }));
      c.once("close", () => {
        const line = out.split(/\r?\n/).find((l) => l.startsWith("DEFORM_RESULT_JSON:"));
        if (!line) return resolve({ error: (err.trim().split(/\r?\n/).pop() || out.slice(0, 200)) });
        try { resolve(JSON.parse(line.slice("DEFORM_RESULT_JSON:".length))); }
        catch (e) { resolve({ error: e.message }); }
      });
    });
    ok("Blender builds the two fixtures rather than this repo committing them",
      Array.isArray(built.wrote) && built.wrote.length === 2, built.error || JSON.stringify(built));

    if (Array.isArray(built.wrote) && built.wrote.length === 2) {
      const deformsGlb = path.join(dir, "deforms.glb");
      const rigidGlb = path.join(dir, "rigid.glb");
      const sizes = await Promise.all([deformsGlb, rigidGlb].map(async (f) => (await stat(f)).size));
      ok("...and the two come out the same size to the byte", sizes[0] === sizes[1], sizes.join(" vs "));
      ok("...and they are not the same file", !(await readFile(deformsGlb)).equals(await readFile(rigidGlb)));

      const gd = await readGlbFile(deformsGlb), gr = await readGlbFile(rigidGlb);
      const sd = assertSkinned(gd.json), sr = assertSkinned(gr.json);
      ok("assertSkinned passes BOTH real Blender-authored files",
        sd.ok === true && sr.ok === true, [...sd.why, ...sr.why].join("; "));
      ok("...with the same joint count and the same vertex count",
        sd.joints === sr.joints && sd.vertices === sr.vertices,
        `${sd.joints}/${sd.vertices} vs ${sr.joints}/${sr.vertices}`);

      const bd = await bpyDeform(deformsGlb, { python: rigPython, script });
      const br = await bpyDeform(rigidGlb, { python: rigPython, script });
      ok("Blender says the rig deforms", bd.state === "deforms", `${bd.state}: ${bd.why.join("; ")}`);
      ok("BLENDER REFUSES THE NON-DEFORMING FILE", br.state === "rigid", `${br.state}: ${br.why.join("; ")}`);
      ok("...and it too would have been fooled by \"did any vertex move\"",
        br.report.movedFraction > 0.9, String(br.report?.movedFraction));

      /* ⚠ THE STRAY MESH, AS A CHECKED FACT. armature_add() leaves a small
       * extra mesh with no armature modifier; the script takes the largest and
       * says so. If Blender ever stops doing this the assertion below tells
       * somebody, rather than the workaround quietly selecting the only mesh. */
      ok("the generated fixture really does carry bpy's stray extra mesh",
        bd.report.meshes.length === 2, JSON.stringify(bd.report?.meshes));
      ok("...and the check took the largest one, which is the one with the armature",
        bd.report.meshChosen.name === bd.report.meshes
          .reduce((m, x) => (x.vertices > m.vertices ? x : m)).name
        && bd.report.meshes.find((m) => m.name === bd.report.meshChosen.name).armatureModifier === true,
        JSON.stringify(bd.report?.meshChosen));

      /* THE CROSS-LANGUAGE NUMBER. Two implementations, two languages, two
       * decoders, one file. They are not allowed to disagree about the ANSWER,
       * and if they drift apart in the value one of them is wrong about the
       * specification.
       *
       * ⚠ HOW CLOSE THEY ARE ENTITLED TO BE, AND WHY THIS LOOSENED. This used
       * to demand agreement to 1e-6 and got it: js 0.13723382082163116 against
       * bpy 0.137233842 — the same to SEVEN significant figures, not the eight
       * the toolkit README claimed until this was recounted. It was also a
       * weaker fact than it looked. Both sides sampled the mesh with the same
       * fixed stride, `floor(i · count / 1024)`, so on a 7,104-vertex fixture
       * they were posing the identical 1,024 vertices and pairing them
       * identically; the match was partly the shared arithmetic of the SAMPLER
       * rather than only the shared arithmetic of skinning.
       *
       * The stride is gone from this side — §9 shows what it was costing — so
       * the gate now samples per joint and stratified while the toolkit's
       * second opinion still strides. The two therefore pose DIFFERENT subsets
       * of the same mesh, on purpose. Strain is a maximum over sampled pairs,
       * so two subsets give two estimates of one quantity, and demanding they
       * be bit-identical would be demanding that the two readers stop being
       * independent.
       *
       * What is demanded is what matters: the same verdict, the same bone, and
       * numbers within 1%. Measured here: js 0.1374732632798222 against bpy
       * 0.137233842, 0.17% apart. */
      const jd = assertDeforms(gd.json), jr = assertDeforms(gr.json);
      ok("the closed form agrees with Blender that the rig deforms", jd.state === "deforms");
      ok("the closed form agrees with Blender that the bind does not", jr.state === "rigid");
      const rel = Math.abs(jd.strain - bd.report.strain) / bd.report.strain;
      ok(`...and the two measure the same strain to within 1% (js ${jd.strain.toExponential(6)} vs bpy `
        + `${Number(bd.report.strain).toExponential(6)}, ${(rel * 100).toFixed(2)}% apart on different samples)`,
        rel < 0.01, `relative difference ${rel}`);
      ok("...and the same fraction of the mesh moved, to within half a percent",
        Math.abs(jd.movedFraction - bd.report.movedFraction) < 5e-3,
        `${jd.movedFraction} vs ${bd.report.movedFraction}`);
      ok("...and they name the same bone", jd.jointName === bd.report.bone,
        `${jd.jointName} vs ${bd.report.bone}`);

      const full = await deformReport(deformsGlb, gd.json, gd.binData, { bpy: true, python: rigPython, script });
      ok("deformReport with the cross-check records that the two agree", full.agree === true, JSON.stringify(full.cross?.state));
      const failed = await deformReport(rigidGlb, gr.json, gr.binData, { bpy: true, python: rigPython, script });
      ok("...and records agreement on the refusal too",
        failed.agree === true && failed.ok === false, `${failed.state}/${failed.cross.state}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/* ── §8 WHAT IT COSTS ────────────────────────────────────────────────────── */
console.log("\n§8  the cost, because this now runs inside the rig path");
{
  /* ⚠ THERE IS NO RIGGED CHARACTER ON THIS MACHINE TO MEASURE AGAINST — every
   * real GLB here is an unrigged TripoSG output or a UniRig example input — so
   * the worst case is CONSTRUCTED. A check that is fast on a cube and slow on a
   * character is a check nobody measured, and this one is called from a route's
   * path as well as from a rig. The caps in deform.js (MAX_SAMPLES posed
   * vertices, 256 probed joints) are what make the top end flat; these rows are
   * the evidence that they do.
   *
   * ⚠ THE TWO LARGE ROWS ARE THIS REPOSITORY'S OWN MESHES, BY VERTEX COUNT.
   * Mika is 353,606 vertices and Lumi 985,072, both from the provenance ledger,
   * and both are far past the cap — so the sampling path is not the exotic case
   * here, it is the ONLY case a real character takes. Since §9, the sampler
   * scans every vertex's joint ownership before it chooses, which is the work
   * these rows are mostly measuring. */
  const budgetMs = 2000;
  for (const o of [{ joints: 64, vertices: 60000 }, { joints: 256, vertices: 200000 },
                   { joints: 64, vertices: 353606 }, { joints: 64, vertices: 985072 }]) {
    const buf = packGlb(bigRigDoc(o));
    const g = readGlb(buf);
    const t0 = Date.now(); const skin = assertSkinned(g.json); const skinMs = Date.now() - t0;
    const t1 = Date.now(); const d = assertDeforms(g.json); const ms = Date.now() - t1;
    ok(`${o.joints} joints / ${o.vertices} vertices (${(buf.length / 1048576).toFixed(1)} MB): `
      + `deforms, in ${ms} ms (the skin assertion beside it takes ${skinMs} ms)`,
      skin.ok === true && d.state === "deforms" && ms < budgetMs,
      `${d.state} in ${ms} ms against a ${budgetMs} ms budget`);
  }
  const capped = assertDeforms(readGlb(packGlb(bigRigDoc({ joints: 256, vertices: 200000 }))).json);
  ok(`...and the sampling cap is what flattens that, not luck (${capped.sampled} of 200000 posed)`,
    capped.sampled <= MAX_SAMPLES && capped.sampled > MAX_SAMPLES * 0.95,
    `${capped.sampled} against a cap of ${MAX_SAMPLES}`);
}

/* ── §9 THE SAMPLER'S OWN BLIND SPOTS ────────────────────────────────────── */
console.log("\n§9  a rig the old sampler called rigid, and a mesh with no size");
{
  /* ⚠ THE DEFECT THIS SECTION EXISTS FOR — a FALSE NEGATIVE, which is the one
   * direction a gate must never fail in. `deform.js` used to choose the
   * vertices it posed with an even stride, `floor(i · count / 1024)`, and it
   * only turns joints that some POSED vertex depends on. On a 200,000-vertex
   * mesh that stride is 195.31 wide, so any articulated region shorter than it
   * can fall entirely between two sampled indices; the joint that owns it is
   * then never turned, nothing moves, and the file is reported `rigid` — a
   * genuine rig refused, in the confident language of a measurement.
   *
   * This was never hypothetical. The meshes this repository has actually
   * produced are 353,606 vertices (Mika) and 985,072 (Lumi), both far past the
   * cap, so EVERY real character goes down the sampled path. The stride only
   * ever looked safe because the fixtures it was tested on articulate every
   * vertex they have. */
  const control = readGlb(packGlb(hiddenJointRigDoc({ vertices: 800, block: 40 })));
  const c = assertDeforms(control.json);
  ok("THE CONTROL: the same shape small enough that every vertex is posed IS a rig",
    c.state === "deforms" && c.jointName === "hinge" && c.sampled === 800,
    `${c.state} strain=${c.strain} joint=${c.jointName} sampled=${c.sampled}/${c.vertices}`);

  const doc = hiddenJointRigDoc();                    // 200,000 vertices, 160 articulated
  const big = readGlb(packGlb(doc));
  const { start, end } = doc.articulated;
  const stride = new Set(legacyStrideIndices(doc.accessors[0].count));
  let hit = 0;
  for (let v = start; v < end; v++) if (stride.has(v)) hit++;
  ok(`the old stride samples NONE of the ${end - start} articulated vertices `
    + `(the block is [${start}, ${end}) and the stride steps 195.31)`,
    hit === 0, `${hit} of ${end - start} were sampled`);

  const d = assertDeforms(big.json, big.binData);
  /* WHAT THE OLD CODE DID WITH THIS FILE, measured before the fix and recorded
   * here because a deleted function cannot be run: state `rigid`, strain
   * 1.934e-16, sampled 1024, probedJoints 1 — it turned only `root`, which can
   * only ever carry the mesh rigidly, and never turned `hinge` at all. */
  ok("A GENUINE RIG THE OLD SAMPLER CALLED RIGID IS NOW ACCEPTED",
    d.state === "deforms" && d.ok === true,
    `${d.state} strain=${d.strain} probedJoints=${d.probedJoints}`);
  ok("...because every joint that owns vertices is probed with vertices it owns",
    d.probedJoints === 2 && d.jointName === "hinge",
    `probed ${d.probedJoints}, best joint ${d.jointName}`);
  ok(`...and the strain it finds is not marginal (${d.strain.toExponential(2)}, `
    + `${(d.strain / MIN_STRAIN).toExponential(1)}x the floor)`,
    d.strain > 50 * MIN_STRAIN, String(d.strain));
  ok("...on a sample no larger than the cap", d.sampled <= MAX_SAMPLES,
    `${d.sampled} of ${d.vertices}`);

  /* THE SAMPLING IS PSEUDO-RANDOM, NOT RANDOM. A gate whose verdict moves
   * between runs is a flake in a pre-commit hook, so the draw is seeded from
   * the mesh's own counts and nothing else. */
  const again = assertDeforms(readGlb(packGlb(hiddenJointRigDoc())).json);
  ok("...and the same file measured again gives the same number, exactly",
    again.strain === d.strain && again.sampled === d.sampled,
    `${again.strain} vs ${d.strain}`);
}
{
  /* ⚠ AND THE GUARANTEE MUST NOT BECOME ITS OWN COST DEFECT. "Every joint that
   * owns vertices gets vertices of its own" is unbounded on its face: JOINTS_n
   * is 16-bit, so a skin may legally name tens of thousands of joints, and one
   * vertex each would put the sample count an order of magnitude past the cap
   * and the pose cost with it. The sampler therefore promises vertices only to
   * the joints it will actually TURN — MAX_PROBED_JOINTS of them, chosen
   * stratified across the owner list rather than as its first 256, because
   * glTF joint order is root-first and a prefix is the torso. */
  const many = assertDeforms(readGlb(packGlb(bigRigDoc({ joints: 1024, vertices: 200000 }))).json);
  ok(`a 1024-joint skin still poses no more than the cap (${many.sampled} vertices, `
    + `${many.probedJoints} joints turned)`,
    many.state === "deforms" && many.sampled <= MAX_SAMPLES && many.probedJoints === 256,
    `${many.state} sampled=${many.sampled} probed=${many.probedJoints}`);
}
{
  /* ⚠ A VERDICT ABOUT A MESH WITH NO SIZE. Strain is a fraction of the mesh's
   * own bounding-box diagonal. A mesh whose vertices are all at one point has a
   * diagonal of zero, the division was guarded with `diagonal > 0 ? … : 0`, and
   * the guard's answer — a clean 0.0 — read as `rigid`: a verdict phrased as
   * measured fact about a file on which nothing was measured. Same rule as the
   * unrigged mesh in §3 and the same rule as UNRUN in §5. */
  const flat = assertDeforms(readGlb(packGlb(degenerateRigDoc())).json);
  ok("a mesh with a zero bounding box is UNREADABLE, not \"rigid\"",
    flat.state === "unreadable" && flat.ok === false, `${flat.state}: ${flat.why.join("; ")}`);
  ok("...and the reason says it could not be measured, not that it did not deform",
    /could not be measured|no size/.test(flat.why.join(" ")) && !/does not deform/.test(flat.why.join(" ")),
    flat.why.join(" "));
}

console.log(`\n  ${pass} passed, ${failures.length} failed, ${skips.length} skipped`);
if (skips.length) console.log(skips.map((s) => `  - skipped: ${s}`).join("\n"));
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
