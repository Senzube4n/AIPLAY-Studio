/**
 * A cast row's MESH — recorded exactly the way its sheet is.
 *
 * That sentence is the specification, and it is the same one
 * `server/mv/blender.js` opens with, deliberately. This is not a parallel asset
 * system: it finds the row with generate.js's own findRow, stages the file into
 * the project's own `assets/` folder with stageAsset, writes one field on the
 * row, and files a run in the same `runs[]` the rail reads. Nothing downstream
 * has to learn a second shape.
 *
 * ── WHAT A MESH IS FOR, AND WHAT IT IS NOT FOR ────────────────────────────
 *
 * DIRECTING.md's most repeated rule is that PROPS ARE CAST: an object in
 * thirteen of twenty-two scenes, declared nowhere, is re-invented from text on
 * every render — a different car each time. A rendered sheet is the existing
 * answer and it is a good one. A MESH is a stronger one by the same argument
 * blender.js already makes: the second render is the same geometry from a
 * different camera, not a second guess at a sentence. The difference between
 * this and blender.js is where the geometry comes from — Blender cannot model a
 * noun, and this can, from the one panel the row already carries.
 *
 * ⚠ AND IT IS NOT A REFERENCE. The clip engines take PICTURES. `control.js`'s
 * IMAGE_RE is the list of what may be a VACE reference and a mesh is not on it
 * and must not be added to it. So a mesh does NOT replace the sheet: it is a
 * second artefact on the same row, and `store.js`'s assetComplete() counts it
 * as a body while `bible.js` still says, quietly, that a row with a mesh and no
 * sheet needs a panel rendered before a clip can carry it.
 *
 * ⚠ meshFile AND rigFile ARE TWO FIELDS, not one that gets overwritten. A rig
 * that comes out wrong must be discardable without losing the mesh that cost
 * the GPU time — and the mesh is the expensive half.
 */
import path from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { readProject, updateProject, assetsDir, projectDir, stageAsset, noteRun } from "../mv/store.js";
import { findRow } from "../mv/generate.js";
import { meshFromImage, rigMesh, meshStatus, MeshRefusal, writeSidecarJson } from "./runner.js";
import { readGlbFile, assertSkinned } from "./glb.js";
import { deformReport } from "./deform.js";

/** The three row kinds a mesh can belong to. A board is a composed SHOT — it
 *  has no object in it to be, so it is refused the same way blenderAsset does. */
const CAST = ["character", "background", "prop"];

/** Written beside a staged mesh, so the claim is re-checkable with no memory of
 *  this call — the same bargain blender.js makes with its previz sidecars. */
const SIDECAR_SUFFIX = ".mesh.json";

/**
 * IS THIS FILE A RIG? — the two questions, asked together, on the staged file.
 *
 * ⚠ THE SECOND QUESTION IS THE ONE THAT WAS MISSING, and the gap was not
 * theoretical. Two GLBs were built that `assertSkinned` cannot tell apart:
 * same skins[], same joints, same MAT4 bind matrices, same JOINTS_0/WEIGHTS_0,
 * every weight row summing to one, the same size to the byte. One deforms and
 * one does not. A rigger that binds every vertex to the root produces the
 * second, passes every structural check ever written about the format, and
 * hands the project a `rigFile` that can never be posed. So `skin.ok` alone
 * was never the admission rule; it was half of it.
 *
 * `rigged` is BOTH — the container binds, AND turning a joint changes the
 * mesh's own shape. See server/mesh/deform.js.
 *
 * The Blender cross-check is asked for (`bpy: true`) because it costs about a
 * second against a rig that costs minutes, and because it is the only reader in
 * this subsystem that did not also validate the file. It does NOT decide: the
 * closed form is the gate, and Blender's answer is recorded beside it along
 * with whether the two agreed. When the rig interpreter or the GPL toolkit
 * script is absent it reports `unrun`, which is written down as unrun and is
 * never read as a pass.
 *
 * Exported so the ADMISSION RULE itself can be driven by a test rather than
 * inferred from the fact that the two functions below call it. A gate nothing
 * exercises is a gate nobody notices the removal of.
 */
export async function inspectRig(file, { bpy = true, timeoutMs = 60000 } = {}) {
  const g = await readGlbFile(file);
  const skin = g.ok ? assertSkinned(g.json) : { ok: false, joints: 0, why: g.why };
  /* Not asked when the skin did not verify: there is nothing to pose, and
   * "it does not deform" would be a second, misleading sentence about one
   * problem. `unreadable` is the honest state for a question not put. */
  const deform = skin.ok
    ? await deformReport(file, g.json, g.binData, { bpy, timeoutMs })
    : { state: "unreadable", ok: false, strain: 0, cross: { state: "unrun", why: [] }, agree: null,
        why: ["the skin did not verify, so the mesh was never posed"] };
  return { g, skin, deform, rigged: skin.ok && deform.ok };
}

/** The sidecar's record of the above — a flat, re-checkable shape. */
export const rigEvidence = ({ skin, deform, rigged }) => ({
  skinned: skin.ok, joints: skin.joints || 0,
  rigged,
  deforms: deform.state, strain: deform.strain ?? 0,
  deformJoint: deform.jointName ?? null,
  /* ⚠ RECORDED AS ITS OWN FIELD rather than folded into `deforms`, because
   * "Blender was not installed" and "Blender said no" must never read alike. */
  deformCrossCheck: deform.cross?.state ?? "unrun",
  deformCrossAgreed: deform.agree,
  why: rigged ? [] : [...(skin.ok ? [] : skin.why || []), ...(deform.why || [])],
});

/**
 * Build a mesh for one declared row from the picture that row already carries.
 *
 * @param slug      the project
 * @param target    character | background | prop
 * @param id        the row's id or exact name
 * @param image     OPTIONAL absolute path to use instead of the row's sheet.
 *                  The row's own `imageFile` is the normal path and the one the
 *                  page uses; this exists because a person may have a better
 *                  single panel than the take that happens to be selected.
 * @param rig       also put a skeleton in it
 * @param seed/steps  sampling knobs, recorded on the run
 */
export async function meshAsset(slug, {
  target = "prop", id, image = null, rig = false, seed = 42, steps = 50,
  actor = "system", via = "mv.mesh_asset", timeoutMs,
} = {}) {
  if (!CAST.includes(target)) {
    throw new Error(`A mesh belongs to a character, background or prop — not a "${target}". `
      + `A board is a composed shot, not an object.`);
  }

  /* ⚠ FIND THE ROW FIRST, and this is blender.js's measured lesson borrowed
   * rather than re-learned: looking the row up only inside the write at the
   * bottom meant a misspelt name spent the whole render and THEN said "No such
   * prop", leaving orphan files in assets/ that nothing pointed at. Read then
   * write is not atomic and does not need to be — the lookup inside the
   * transaction is still the authority. This one exists to fail before
   * spending. */
  const doc0 = await readProject(slug);
  if (!doc0) throw new Error(`No such project: ${slug}`);
  const row0 = findRow(doc0, target, id);

  /* THE INPUT PANEL. The row's selected take, unless one was named. An absent
   * one is refused by the runner with the sentence that says what to do — it is
   * not this function's job to write a second copy of that sentence. */
  const src = image
    ? path.resolve(image)
    : row0.imageFile ? path.join(assetsDir(slug), row0.imageFile) : "";

  const scratch = path.join(projectDir(slug), "mesh");
  await mkdir(scratch, { recursive: true });
  const stamp = Date.now().toString(36);
  const outGlb = path.join(scratch, `${target}_${stamp}.glb`);

  let result;
  try {
    result = await meshFromImage({
      image: src, out: outGlb, rig, seed, steps,
      actor, via, project: slug, subject: row0.name || row0.id, timeoutMs,
    });

    const prefix = target === "character" ? "char" : target === "background" ? "bg" : "prop";
    const staged = await stageAsset(slug, outGlb, `${prefix}mesh`);
    /* The container is re-read AFTER staging, off the file the project will
     * actually keep. Asserting the copy that was written and then filing a
     * different one is the shape of every "it worked on my machine" bug. */
    /* THE TWO QUESTIONS. `rig` is what the caller asked for, so the Blender
     * cross-check is only spawned when a rig was actually attempted — a plain
     * mesh has no skin to pose and nothing to corroborate. */
    const check = await inspectRig(path.join(assetsDir(slug), staged), { bpy: Boolean(rig) });
    const { g, skin } = check;

    await writeSidecarJson(path.join(assetsDir(slug), staged + SIDECAR_SUFFIX), {
      runId: result.runId,
      model: result.record?.model || null,
      models: result.record?.models || [],
      from: image ? path.basename(src) : row0.imageFile,
      seed: result.record?.seed ?? null,
      ...rigEvidence(check),
      sha256: result.record?.output?.sha256 || null,
      /* The rights the ledger stamped, carried beside the file. A mesh that
       * leaves this project still says what made it and under what terms. */
      door: result.record?.door || null,
    }).catch(() => { /* provenance is a bonus; the mesh is the artefact */ });

    const outDoc = await updateProject(slug, (doc) => {
      const row = findRow(doc, target, id);
      /* ⚠ TWO FIELDS. A rigged result fills both — the file IS the mesh and it
       * IS the rig — so a later rig-only pass can replace rigFile alone and a
       * discarded rig leaves meshFile standing. */
      row.meshFile = staged;
      /* ⚠ `check.rigged`, NOT `skin.ok`. A file whose vertices do not move
       * when its joints turn is not a rig, however well it parses, and filing
       * it as one is how a project ends up with a rigFile nothing can pose. */
      if (check.rigged) row.rigFile = staged;
      /* NOT touched: imageFile. The sheet is what the clip engine takes and a
       * mesh is not one; overwriting it here would silently remove the row's
       * only usable reference. */
      const label = row.name || row.id;
      noteRun(doc, {
        tool: "mesh_asset",
        outcome: `${target} ${label}: mesh${check.rigged ? " + rig" : ""} in ${result.elapsedSec}s`
          + (rig && !check.rigged
            ? (skin.ok ? " (the skin binds but the mesh does not deform — not filed as a rig)"
                       : " (the rig produced no usable skin)")
            : ""),
      });
      return doc;
    });

    return {
      doc: outDoc, staged,
      ...rigEvidence(check),
      /* A rig that did not take is SAID OUT LOUD, the way blender.js reports a
       * refused panel. A silent drop is the failure the assertion exists to
       * prevent, one layer further down. */
      rigRefused: rig && !check.rigged ? rigEvidence(check).why : null,
      runId: result.runId, elapsedSec: result.elapsedSec,
      bytes: await stat(path.join(assetsDir(slug), staged)).then((s) => s.size, () => null),
    };
  } finally {
    /* Whatever survived is in assets/ with its sidecar. Leaving the scratch
     * would grow a second copy of every mesh in the project — and it must be
     * cleaned on a REFUSAL too, which is why this is `finally` and not the end
     * of a successful path. */
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Rig a mesh a row already has.
 *
 * A separate verb because it is the one that can be refused ON EVIDENCE: there
 * is a GLB to measure by now, so the proportions decide rather than a guess
 * from a picture. See refuseRig() in runner.js.
 */
export async function rigAsset(slug, {
  target = "prop", id, actor = "system", via = "mv.mesh_rig", timeoutMs,
} = {}) {
  if (!CAST.includes(target)) throw new Error(`A rig belongs to a character, background or prop — not a "${target}".`);
  const doc0 = await readProject(slug);
  if (!doc0) throw new Error(`No such project: ${slug}`);
  const row0 = findRow(doc0, target, id);
  if (!row0.meshFile) {
    throw new MeshRefusal("rig-input",
      `"${row0.name || row0.id}" has no mesh to rig. Build one first — a rig is joints put INTO a `
      + `mesh, so there is nothing for it to act on.`);
  }

  const scratch = path.join(projectDir(slug), "mesh");
  await mkdir(scratch, { recursive: true });
  const out = path.join(scratch, `${target}_${Date.now().toString(36)}_rigged.glb`);
  try {
    const r = await rigMesh({
      glb: path.join(assetsDir(slug), row0.meshFile), out,
      actor, via, project: slug, subject: row0.name || row0.id, timeoutMs,
    });
    const prefix = target === "character" ? "char" : target === "background" ? "bg" : "prop";
    const staged = await stageAsset(slug, out, `${prefix}rig`);
    /* ⚠ THIS PATH USED TO FILE `rigFile` ON THE STRENGTH OF THE SUBPROCESS
     * EXITING, and that is a weaker claim than the mesh path's — which at
     * least read the container. `rigMesh` reporting a joint count is UniRig
     * saying what it wrote, not this app reading what arrived. So the same two
     * questions are asked here, off the staged file, and the field is written
     * only when both answer yes. The verb whose entire purpose is a rig is the
     * last place the word should be taken on trust. */
    const check = await inspectRig(path.join(assetsDir(slug), staged));
    const evidence = rigEvidence(check);
    await writeSidecarJson(path.join(assetsDir(slug), staged + SIDECAR_SUFFIX), {
      runId: r.runId, from: row0.meshFile, ...evidence,
    }).catch(() => { /* provenance is a bonus; the file is the artefact */ });

    const doc = await updateProject(slug, (d) => {
      const row = findRow(d, target, id);
      if (check.rigged) row.rigFile = staged;
      noteRun(d, { tool: "mesh_rig",
                   outcome: check.rigged
                     ? `${target} ${row.name || row.id}: rigged, ${check.skin.joints} joints in ${r.elapsedSec}s`
                     : `${target} ${row.name || row.id}: NOT filed as a rig after ${r.elapsedSec}s — `
                       + (check.skin.ok
                         ? "the skin binds but turning its joints does not change the mesh's shape"
                         : "the file carries no usable skin") });
      return d;
    });
    /* The staged file is LEFT IN PLACE on a refusal, deliberately. It cost the
     * card minutes and somebody may want to look at it; what it is not is a
     * rig, and the row does not say it is. */
    return { doc, staged, ...evidence, joints: check.skin.joints || r.joints,
             runId: r.runId, elapsedSec: r.elapsedSec,
             rigRefused: check.rigged ? null : evidence.why };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** What a surface may say about this path, from the data rather than from prose
 *  typed into a page — the same contract `GET /api/mv/blender` honours. */
export async function meshCatalogue() {
  /* awaitProbe, and it is the reason this call is not free — see below. */
  const st = await meshStatus({ awaitProbe: true }).catch(() => meshStatus());
  /* ⚠ THE FILES BEING PRESENT IS NOT THE RUNTIME BEING PRESENT, and a screen
   * that offers a ⬗ Rig button on the strength of two checkpoints existing is
   * offering a button that spends a mesh and then fails. On this machine both
   * UniRig checkpoints are on disk and hash-verified against the publisher's
   * own oids, and the rig STILL cannot run: bpy and flash_attn have no wheel
   * for this venv's python and both are imported at module scope on UniRig's
   * only entry path. So the status a surface reads carries both answers
   * separately, because they have different remedies — fetch a file, or
   * install a runtime.
   *
   * This is the one call in this module that spawns anything, and rigRuntime()
   * caches it for the life of the process.
   *
   * ⚠ IT USED TO BE COMPOSED HERE, over a meshStatus() that answered only the
   * file half — which meant this one surface told the truth and every other
   * caller of meshStatus (the route, rigMesh's own first gate) did not. The
   * composition now lives in meshStatus itself, where `canRig` already promised
   * it; `awaitProbe` is this module deciding to PAY for the answer, which is
   * the part that was genuinely local to a catalogue call. */
  const runtime = st.rigProbe?.probe || { canRig: false, missing: [] };
  return {
    ...st,
    /* WEIGHTS ready AND RUNTIME able — st.canRig now means exactly that, and
     * st.rigWeightsReady is the file half under its own name. Both are passed
     * through unchanged so this shape stays what web/mv.js and the route read. */
    rigRuntime: runtime,
    why: [...(st.why || []), ...(st.rigProbe?.state === "ready" ? [] : st.rigProbe?.why || [])],
    /* The format contract, ONCE, so the MCP tool description, the page and the
     * docs cannot drift apart about what comes out of here. */
    format: "GLB. A rigged result carries glTF skins[] with joints and inverseBindMatrices, AND "
      + "its vertices move when a joint is turned. Both, because a mesh and a rigged mesh have the "
      + "same extension and very similar sizes so a file being written proves nothing — and because "
      + "two GLBs can carry identical skins, joints, bind matrices and weights, come out the same "
      + "size to the byte, and only one of them deform. The container is parsed and then the "
      + "skeleton is posed; a result that binds without deforming is not filed as a rig.",
    inputs: ["png", "jpg", "jpeg", "webp"],
    /* Not a reference — said here so a page cannot imply otherwise. */
    notAReference: "A mesh is never a clip reference. The clip engines take pictures; render a "
      + "single panel from the mesh if a scene needs one.",
  };
}
