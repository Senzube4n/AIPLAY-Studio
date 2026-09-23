/**
 * DOES THE MESH ACTUALLY MOVE? — the question `assertSkinned` cannot ask.
 *
 * ── THE FINDING THIS FILE EXISTS FOR ──────────────────────────────────────
 *
 * Two GLB files were built that are identical in every structural respect a
 * glTF reader can name: the same `skins[]`, the same `joints` array, MAT4
 * `inverseBindMatrices` with one matrix per joint, `JOINTS_0` and `WEIGHTS_0`
 * on the primitive, every vertex weighted, every weight row summing to exactly
 * one. Same generator, same vertex count, same file size to the byte. One of
 * them deforms when a bone is rotated and the other does not. `assertSkinned`
 * passes both, the Khronos validator passes both, and it is not a defect in
 * either of them: no amount of parsing separates a rig from a bind, because
 * the difference is not in the structure. It is in the arithmetic the
 * structure describes.
 *
 * So this file does the arithmetic. It poses the skeleton and measures.
 *
 * ── WHAT "IT DEFORMS" IS DEFINED AS, AND WHY NOT SOMETHING SIMPLER ────────
 *
 * The obvious test — "rotate a bone, see whether vertices move" — is wrong in
 * a way that passes the exact file it is meant to catch. Put every weight on
 * the root joint: rotating the root moves every vertex, beautifully, and the
 * mesh has not deformed at all. It has been carried. A rigid motion is what a
 * parent transform already does for free; nobody needs a skin for it.
 *
 * The honest definition is the one that distinguishes a skeleton from a
 * handle: **a skin deforms when posing it changes the mesh's own shape.** A
 * rigid motion preserves every distance between every pair of points; that is
 * its definition. So the measurement is the change in pairwise distance —
 * STRAIN — under a probe rotation of one joint at a time:
 *
 *     strain = max over sampled pairs (a,b) of  | |p1a-p1b| - |p0a-p0b| |
 *              ────────────────────────────────────────────────────────
 *                        the mesh's own bounding-box diagonal
 *
 * Rigid gives exactly zero in exact arithmetic and around 1e-7 in float32
 * positions. A real limb bend gives tenths. `MIN_STRAIN` sits at 1e-3, four
 * orders of magnitude above the noise and two below the signal, so the gap it
 * has to judge is not a close call. No bone names are read, no anatomy is
 * assumed, and the answer does not change if the skeleton is a spider's.
 *
 * ── HOW IT POSES ──────────────────────────────────────────────────────────
 *
 * Linear blend skinning, from the specification, on this side of every
 * subprocess boundary:
 *
 *     p' = Σ_k  w_k · ( global(joints[j_k]) · inverseBind[j_k] ) · p
 *
 * `global()` is the product of node local transforms from the scene root down,
 * and a skinned mesh ignores its own node's transform — the joints carry it.
 * That is the whole of it. It needs no python, no venv, no GPU and no Blender,
 * for the same reason `glb.js` reads the container by hand: a check that can
 * only run where a 3 GB runtime is installed is a check that does not run.
 *
 * WHICH vertices it poses, and which joints it turns, is the other half of
 * whether that arithmetic answers correctly — a cap chosen badly reports a rig
 * as rigid without ever being wrong about a matrix. See chooseSamples().
 *
 * ── AND THE SECOND OPINION, WHICH IS NOT THIS FILE ────────────────────────
 *
 * `bpyDeform()` below spawns the rig interpreter to ask Blender the same
 * question about the same file. That is a genuinely independent reader — its
 * own importer, its own evaluation, its own idea of what a bone is — and it is
 * the only part of this subsystem that is. It is also the part that cannot
 * always run: `import bpy` is a GPL boundary this Apache-2.0 tree does not
 * cross (see `config.blender` and vendor/previz-blender/LICENSE-NOTE.md), so
 * the script lives in the toolkit and the interpreter is optional.
 *
 * ⚠ WHEN IT CANNOT RUN, IT REPORTS `unrun`. Never `deforms`. This is the same
 * distinction `meshStatus()` draws between `blocked` and `unchecked`: an
 * unasked question is not a yes, and a gate that treats a missing tool as a
 * pass is a gate that opens itself on every machine that lacks the tool —
 * which is every machine, eventually.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { config } from "../config.js";
import { binaryOfDocument, nodeHierarchy, skinAccessor } from "./glb.js";

/**
 * The strain floor, as a fraction of the mesh's own bounding-box diagonal.
 *
 * Not a tuned number and this file will not pretend it is one. Float32
 * positions put rigid-motion noise around 1e-7 of the diagonal; a bent elbow
 * moves a hand a tenth of a body. 1e-3 is the middle of four empty orders of
 * magnitude, chosen so that nothing this gate ever sees is near it. If a file
 * ever lands within a factor of ten of this number, the right response is to
 * look at the file, not to move the constant.
 */
export const MIN_STRAIN = 1e-3;

/**
 * How far to turn a joint, in degrees, and about which axes.
 *
 * TWO axes, not one, and that is not caution — it is correctness. A rotation
 * about a bone's own long axis is a twist, and a cylinder skinned around that
 * axis is very nearly invariant under it; a single X probe would report a
 * genuine limb rig as rigid whenever the file happened to be authored with the
 * bone pointing along X. The two probes are orthogonal, so no bone direction
 * is degenerate under both, and the best of them is the answer.
 */
export const PROBE_DEGREES = 40;

/** Sampled vertices per primitive. See chooseSamples() for why this is capped. */
export const MAX_SAMPLES = 2048;
/**
 * Vertices guaranteed from EVERY joint that owns any, before the rest of the
 * budget is spread over the mesh. This is the number that makes a false
 * "rigid" impossible by unlucky selection rather than merely unlikely: a joint
 * cannot be judged on vertices it does not own if it is judged on vertices it
 * does. More than one because a single vertex on a bone's rotation axis moves
 * hardly at all, and four is still nothing against MAX_SAMPLES.
 */
const PER_JOINT_SAMPLES = 4;
/** Joints probed per skin, worst case 2 x MAX_SAMPLES vertex poses each. */
const MAX_PROBED_JOINTS = 256;

const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ref = (list, i) => Array.isArray(list) && Number.isSafeInteger(i) && i >= 0
  && i < list.length && record(list[i]);

/* ── 4x4 column-major matrices, the glTF convention ─────────────────────── */

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** C = A·B, both column-major, both 16 numbers. */
function multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

/** The point p (a 3-vector) through a column-major affine matrix. */
function transform(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** A unit quaternion (glTF order: x, y, z, w) as a column-major rotation. */
function fromQuaternion(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
}

/** A rotation of `radians` about a unit axis, column-major. */
function axisRotation(axis, radians) {
  const [x, y, z] = axis;
  const c = Math.cos(radians), s = Math.sin(radians), t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

const num3 = (v, fallback) => (Array.isArray(v) && v.length >= 3
  && v.slice(0, 3).every(Number.isFinite) ? v.slice(0, 3) : fallback);

/**
 * A node's own transform: `matrix` if it declares one, else T·R·S.
 *
 * Anything malformed falls back to identity rather than throwing, because this
 * module is downstream of assertSkinned — a document that reaches here has had
 * its skin bytes verified, and a node with a nonsense rotation is a question
 * about the scene, not about whether the skin binds.
 */
function localMatrix(node) {
  if (!record(node)) return IDENTITY.slice();
  if (Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every(Number.isFinite)) {
    return node.matrix.slice();
  }
  const t = num3(node.translation, [0, 0, 0]);
  const s = num3(node.scale, [1, 1, 1]);
  const q = Array.isArray(node.rotation) && node.rotation.length === 4
    && node.rotation.every(Number.isFinite) ? node.rotation : [0, 0, 0, 1];
  const r = fromQuaternion(q);
  return [
    r[0] * s[0], r[1] * s[0], r[2] * s[0], 0,
    r[4] * s[1], r[5] * s[1], r[6] * s[1], 0,
    r[8] * s[2], r[9] * s[2], r[10] * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/**
 * Global transforms for every node, with one node's local matrix optionally
 * post-multiplied by a probe rotation.
 *
 * Post-multiplied, not pre-: `parent · local · probe` turns the joint about
 * its OWN origin in its own frame, which is what a bone does, and it carries
 * the joint's whole subtree with it, which is also what a bone does.
 */
function globalTransforms(nodes, hierarchy, probeAt = -1, probe = null) {
  const locals = nodes.map((n, i) => (i === probeAt && probe ? multiply(localMatrix(n), probe) : localMatrix(n)));
  const globals = new Array(nodes.length).fill(null);
  const resolve = (i, guard) => {
    if (globals[i]) return globals[i];
    if (guard.has(i)) return (globals[i] = locals[i]); // a cycle; hierarchy already refuses these
    guard.add(i);
    const p = hierarchy.parent.get(i);
    globals[i] = p === undefined ? locals[i] : multiply(resolve(p, guard), locals[i]);
    return globals[i];
  };
  for (let i = 0; i < nodes.length; i++) resolve(i, new Set());
  return globals;
}

/**
 * A deterministic 32-bit PRNG (mulberry32). Seeded from the mesh's own shape,
 * never from the clock: the same GLB must give the same verdict and the same
 * number on every machine and every run, or `deform.js` becomes a flake in a
 * pre-commit hook. "Pseudo-random" here means *unaligned with the vertex
 * order*, which is the only property the sampling needs; it does not mean
 * unpredictable, and it must not.
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * WHICH VERTICES GET POSED — and why a fixed stride was the wrong answer.
 *
 * ⚠ THE DEFECT THIS REPLACES. This used to be `floor(i * count / MAX_SAMPLES)`:
 * an even stride across the vertex buffer. That is fast, deterministic, and
 * WRONG in the one direction a gate must never be wrong in — it can report a
 * genuine rig as `rigid`. Two ways, both reachable by real files:
 *
 *   1. A JOINT IT NEVER SEES. Only joints that some SAMPLED vertex depends on
 *      are probed at all (see `matters` below). A stride of 195 across a
 *      200,000-vertex mesh steps over any articulated region shorter than 195
 *      vertices — an eyelid, a fingertip, a jaw — and that joint is then never
 *      turned. The mesh is called rigid because the check never asked.
 *   2. A STRIDE THAT RESONATES. `floor(i · 200000/1024)` is `floor(i · 3125/16)`:
 *      every index it visits is one of just 16 residues modulo 3125. A mesh
 *      whose vertex order has any period sharing that factor — and ring-major
 *      exporters produce periodic orders as a matter of course — is sampled on
 *      a systematically unrepresentative slice of itself.
 *
 * None of this is academic. The meshes this repository actually produces are
 * 353,606 vertices (Mika) and 985,072 (Lumi), so EVERY real rig goes down this
 * path; the stride only ever looked safe because the only rigs measured were
 * the constructed fixtures, whose articulation is spread over every vertex.
 *
 * ── WHAT IT DOES INSTEAD ──────────────────────────────────────────────────
 *
 * Two halves, and the first is the one that closes the hole:
 *
 *   PER JOINT. One pass over the whole JOINTS_n/WEIGHTS_n buffer — every
 *   vertex, not a sample of them — builds a reservoir of up to
 *   PER_JOINT_SAMPLES vertices for EVERY joint that owns any. A joint that owns
 *   one vertex in a million is therefore posed with a vertex it really owns,
 *   and turned. This is the property that makes the false "rigid" impossible
 *   rather than unlikely — for up to MAX_PROBED_JOINTS joints, which is the one
 *   qualifier on it and is spelled out at the bound below.
 *
 *   THEN THE MESH. The remaining budget is spread by STRATIFIED sampling: the
 *   buffer is cut into as many equal strata as there is budget left and one
 *   vertex is drawn pseudo-randomly inside each. That keeps the even coverage
 *   the stride was for — a proof of articulation is a MAXIMUM over pairs, so
 *   reach matters — while the per-stratum jitter means no vertex ordering,
 *   periodic or otherwise, has a fixed blind spot.
 *
 * The draw is seeded from the mesh's own counts, so it is fully deterministic:
 * the same file gives the same samples, the same strain and the same verdict,
 * every time. `sampled`, `vertices` and `probedJoints` are all in the verdict.
 *
 * ⚠ WHAT IS STILL CAPPED, HONESTLY. The number of vertices POSED is capped
 * (MAX_SAMPLES) and so is the number of joints TURNED (MAX_PROBED_JOINTS) —
 * every probed joint is posed against every sample twice, so an uncapped
 * million-vertex character is billions of vertex poses. A skin with more than
 * MAX_PROBED_JOINTS joints that own vertices therefore still has joints nobody
 * turns, and the guarantee above is a guarantee for the 256 that are chosen
 * (stratified across the owner list, not its first 256). Nothing in this
 * repository comes near that: UniRig's skeletons are tens of bones, and a
 * humanoid rig is under 100.
 *
 * What is NOT capped is the ownership SCAN — every vertex, every influence —
 * which is why the choice of those 256 and of their vertices is made from the
 * whole mesh rather than from a sample of it. That scan is most of the cost on
 * a large mesh: 985,072 vertices measure at about 200 ms end to end, against
 * roughly 560 ms for the assertSkinned() call that runs beside it.
 */
function chooseSamples(count, bind, jointCount) {
  if (count <= MAX_SAMPLES) {
    return { samples: Array.from({ length: count }, (_, i) => i), owners: null };
  }
  const rand = rng((count * 2654435761 + jointCount * 40503 + 0x5eed) >>> 0);

  /* Half one: a reservoir per joint, over EVERY vertex. Reservoir sampling so
   * that the vertices kept for a joint are spread over everything it owns
   * rather than being its first four — a bone's first vertices are as
   * unrepresentative a slice as a stride's. */
  const keep = new Array(jointCount);
  const seen = new Int32Array(jointCount);
  for (let v = 0; v < count; v++) {
    for (const [j, w] of bind) {
      for (let k = 0; k < 4; k++) {
        if (!(w.at(v, k) > 0)) continue;
        const joint = j.at(v, k);
        if (!(joint >= 0 && joint < jointCount)) continue;
        const n = seen[joint]++;
        if (n < PER_JOINT_SAMPLES) (keep[joint] ??= []).push(v);
        else {
          const r = Math.floor(rand() * (n + 1));
          if (r < PER_JOINT_SAMPLES) keep[joint][r] = v;
        }
      }
    }
  }
  const ownerJoints = [];
  for (let j = 0; j < jointCount; j++) if (keep[j]) ownerJoints.push(j);

  /* ⚠ AND THE BOUND ON THE GUARANTEE, which is what keeps it from becoming its
   * own cost defect. Only MAX_PROBED_JOINTS joints are ever TURNED, so promising
   * vertices to more than that buys nothing and spends the whole sample budget:
   * JOINTS_n is 16-bit, so a skin can legally name tens of thousands of joints,
   * and one vertex each would put the sample count an order of magnitude past
   * the cap. When there are more owners than probes, the probed set is chosen
   * stratified across the owner list rather than as its first 256 — glTF joint
   * order is usually root-first, so a prefix is the torso and the tail is the
   * fingers. With this, `chosen.size` can never exceed MAX_SAMPLES: at most
   * 256 joints times at most 4 vertices is 1,024, and the per-joint half is
   * capped at three quarters of the budget besides. */
  const probeJoints = chooseProbes(ownerJoints, rand);
  const perJoint = probeJoints.length === 0 ? 0
    : Math.max(1, Math.min(PER_JOINT_SAMPLES, Math.floor((MAX_SAMPLES * 3 / 4) / probeJoints.length)));
  const chosen = new Set();
  for (const j of probeJoints) for (const v of keep[j].slice(0, perJoint)) chosen.add(v);

  /* Half two: the rest of the budget, stratified over the whole buffer. */
  const strata = MAX_SAMPLES - chosen.size;
  for (let s = 0; s < strata; s++) {
    const v = Math.min(count - 1, Math.floor(((s + rand()) * count) / strata));
    chosen.add(v);
  }
  /* Ascending, because pairsFor() pairs sample i with sample i + n/2 and wants
   * those to be far apart in the mesh. */
  return { samples: [...chosen].sort((a, b) => a - b), owners: probeJoints };
}

/**
 * Which joints get turned, when there are more than MAX_PROBED_JOINTS of them.
 *
 * Stratified over the candidates rather than "the first 256", for the same
 * reason the vertex sampling is: a fixed prefix of a joint list is a
 * systematically unrepresentative slice of a skeleton, and glTF joint order is
 * usually root-first, so a prefix is the torso and the tail is the fingers.
 */
function chooseProbes(candidates, rand) {
  if (candidates.length <= MAX_PROBED_JOINTS) return candidates;
  const out = new Set();
  for (let s = 0; s < MAX_PROBED_JOINTS; s++) {
    out.add(candidates[Math.min(candidates.length - 1,
      Math.floor(((s + rand()) * candidates.length) / MAX_PROBED_JOINTS))]);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The pairs whose lengths are measured.
 *
 * Long-range first — sample i against sample i + n/2 — because a bend at the
 * middle of a body changes the head-to-foot distance by the most and the
 * neighbour-to-neighbour distance by the least. The adjacent pairs are there
 * as well so that a purely local deformation (one finger) is not invisible.
 * O(n) pairs, not O(n²): this is a proof of existence, not a survey.
 */
function pairsFor(n) {
  const out = [];
  const half = n >> 1;
  for (let i = 0; i < n; i++) {
    if (half > 0) out.push([i, (i + half) % n]);
    out.push([i, (i + 1) % n]);
  }
  return out;
}

/* ── the measurement ────────────────────────────────────────────────────── */

/**
 * Pose one primitive's skin and report the largest strain any single joint
 * rotation produces.
 *
 * Returns `{ strain, joint, movedFraction, sampled, vertices, probes }`.
 * `joint` is an index into `skin.joints`, or -1 when nothing moved anything.
 */
function strainOfPrimitive(json, bin, skin, prim, label) {
  const joints = skin.joints;
  const pos = skinAccessor(json, bin, prim.attributes.POSITION,
    { label: `${label} POSITION`, type: "VEC3", types: [5126], vertex: true });
  const ibm = skinAccessor(json, bin, skin.inverseBindMatrices,
    { label: `${label} inverseBindMatrices`, type: "MAT4", types: [5126] });
  const sets = Object.keys(prim.attributes)
    .filter((k) => /^JOINTS_\d+$/.test(k))
    .map((k) => Number(k.split("_")[1]))
    .sort((a, b) => a - b);
  const bind = sets.map((s) => [
    skinAccessor(json, bin, prim.attributes[`JOINTS_${s}`],
      { label: `${label} JOINTS_${s}`, type: "VEC4", types: [5121, 5123], vertex: true }),
    skinAccessor(json, bin, prim.attributes[`WEIGHTS_${s}`],
      { label: `${label} WEIGHTS_${s}`, type: "VEC4", types: [5121, 5123, 5126], normalized: true, vertex: true }),
  ]);

  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const hierarchy = nodeHierarchy(nodes);
  const inverseBind = joints.map((_, j) => Array.from({ length: 16 }, (_, k) => ibm.at(j, k)));

  const { samples, owners } = chooseSamples(pos.count, bind, joints.length);
  /* Rest positions and each sample's influences, read once. */
  const rest = [];
  const influence = [];
  for (const v of samples) {
    rest.push([pos.at(v, 0), pos.at(v, 1), pos.at(v, 2)]);
    const inf = [];
    for (const [j, w] of bind) {
      for (let k = 0; k < 4; k++) {
        const weight = w.at(v, k);
        if (weight > 0) inf.push([j.at(v, k), weight]);
      }
    }
    influence.push(inf);
  }

  /* The mesh's own size, from the sampled rest positions. The scale every
   * displacement below is divided by, so "moved a lot" means something on a
   * figurine and on a cathedral. */
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of rest) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

  /**
   * ⚠ A MESH WITH NO SIZE IS UNREADABLE, NOT RIGID. Every displacement below is
   * divided by this diagonal, and a mesh whose sampled vertices are all at one
   * point — or carry a non-finite coordinate — has a diagonal of zero or NaN.
   * The old code divided anyway, guarded the division with `diagonal > 0 ? … :
   * 0`, and handed back a strain of exactly zero: a verdict of "rigid", phrased
   * as measured fact, about a mesh nothing was measured on. That is the same
   * lie as calling an unposeable file rigid, which the header of this module
   * spends a paragraph refusing. So it says so instead.
   */
  if (!(diagonal > 0)) {
    return { strain: 0, joint: -1, movedFraction: 0, sampled: rest.length,
             vertices: pos.count, probedJoints: 0, diagonal, degenerate: true };
  }

  /* The joint matrices are built ONCE per pose, not once per vertex. Sixty
   * joints against a thousand sampled vertices is sixty 4x4 products either
   * way or sixty thousand of them, and this function runs twice per joint. */
  const skinned = (globals) => {
    const mats = joints.map((node, j) => multiply(globals[node], inverseBind[j]));
    return rest.map((p, i) => {
      let x = 0, y = 0, z = 0;
      for (const [j, w] of influence[i]) {
        const q = transform(mats[j], p[0], p[1], p[2]);
        x += w * q[0]; y += w * q[1]; z += w * q[2];
      }
      return [x, y, z];
    });
  };

  const pairs = pairsFor(rest.length);
  const restGlobals = globalTransforms(nodes, hierarchy);
  const p0 = skinned(restGlobals);
  const d0 = pairs.map(([a, b]) => Math.hypot(p0[a][0] - p0[b][0], p0[a][1] - p0[b][1], p0[a][2] - p0[b][2]));

  const radians = (PROBE_DEGREES * Math.PI) / 180;
  const probes = [axisRotation([1, 0, 0], radians), axisRotation([0, 0, 1], radians)];
  /* Only joints some sampled vertex actually depends on, directly or through
   * a descendant, can move anything — probing the rest is arithmetic with a
   * known answer. */
  const weighted = new Set();
  for (const inf of influence) for (const [j] of inf) weighted.add(joints[j]);
  const matters = joints.map((node) => {
    const subtree = hierarchy.descendantsOf(node);
    for (const n of weighted) if (subtree.has(n)) return true;
    return false;
  });
  const candidates = [];
  for (let j = 0; j < joints.length; j++) if (matters[j]) candidates.push(j);
  /* ⚠ THE JOINTS THE SAMPLER PROMISED VERTICES TO ARE PROBED FIRST AND
   * UNCONDITIONALLY. That promise is the whole point of chooseSamples(), and it
   * would be worth nothing if the probe budget then went to 256 other joints
   * and left the one that owns the eyelid unturned. Whatever budget is left
   * goes to the rest of the joints that matter — ancestors of weighted joints,
   * which move a subtree — stratified rather than taken as a prefix. */
  const probeRand = rng((joints.length * 2654435761 + rest.length + 0x51ed) >>> 0);
  let toProbe;
  if (owners === null) {
    toProbe = chooseProbes(candidates, probeRand);
  } else {
    const set = new Set(owners.filter((j) => matters[j]));
    for (const j of chooseProbes(candidates.filter((j) => !set.has(j)), probeRand)) {
      if (set.size >= MAX_PROBED_JOINTS) break;
      set.add(j);
    }
    toProbe = [...set].sort((a, b) => a - b);
  }

  let best = { strain: 0, joint: -1, movedFraction: 0 };
  let probed = 0;
  for (const j of toProbe) {
    probed++;
    for (const probe of probes) {
      const p1 = skinned(globalTransforms(nodes, hierarchy, joints[j], probe));
      let strain = 0;
      for (let i = 0; i < pairs.length; i++) {
        const [a, b] = pairs[i];
        const d = Math.hypot(p1[a][0] - p1[b][0], p1[a][1] - p1[b][1], p1[a][2] - p1[b][2]);
        strain = Math.max(strain, Math.abs(d - d0[i]));
      }
      strain /= diagonal;      // diagonal > 0: the degenerate case returned above
      if (strain > best.strain) {
        const eps = Math.max(diagonal, 1) * 1e-6;
        let moved = 0;
        for (let i = 0; i < p1.length; i++) {
          if (Math.hypot(p1[i][0] - p0[i][0], p1[i][1] - p0[i][1], p1[i][2] - p0[i][2]) > eps) moved++;
        }
        best = { strain, joint: j, movedFraction: moved / p1.length };
      }
    }
  }
  return { ...best, sampled: rest.length, vertices: pos.count, probedJoints: probed,
           diagonal, degenerate: false };
}

/**
 * DOES THIS SKIN DEFORM ITS MESH? The gate, beside `assertSkinned`.
 *
 * `binData` may be omitted for the original JSON from readGlb/readGlbFile,
 * exactly as assertSkinned takes it, and for the same reason.
 *
 * Returns a verdict, never a throw:
 *
 *   { state: "deforms",     ok: true,  strain, joint, jointName, ... }
 *   { state: "rigid",       ok: false, why: [...] }   posed and it did not
 *   { state: "unreadable",  ok: false, why: [...] }   could not be posed
 *
 * ⚠ THREE STATES, NOT TWO, and `unreadable` is the one that matters. A file
 * this cannot pose — a compressed buffer, a document that never reached
 * assertSkinned — has not been shown to be rigid. Reporting "it does not
 * deform" for a file nobody measured is the same lie in the other direction
 * as reporting "it deforms" for one nobody could measure. Same rule as
 * glb.js's ⚠ note about malformed files: a crash is not a verdict.
 */
export function assertDeforms(json, binData = undefined) {
  const out = { state: "unreadable", ok: false, why: [], strain: 0, joint: -1,
                jointName: null, sampled: 0, vertices: 0, primitives: 0 };
  if (!record(json)) return { ...out, why: ["no glTF document"] };
  const skins = Array.isArray(json.skins) ? json.skins : [];
  if (!skins.length) return { ...out, why: ["the GLB has no `skins` — there is nothing to pose"] };
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const bin = binData === undefined ? binaryOfDocument(json) : binData;
  if (!Buffer.isBuffer(bin) || !bin.length) {
    return { ...out, why: ["skin binary data is unavailable; use readGlb/readGlbFile or pass the BIN Buffer to assertDeforms(json, binData)"] };
  }
  let best = null, primitives = 0, degenerate = 0;
  try {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!record(n) || n.skin === undefined) continue;
      if (!ref(skins, n.skin) || !ref(json.meshes, n.mesh)) continue;
      const skin = skins[n.skin];
      if (!Array.isArray(skin.joints) || !skin.joints.length) continue;
      if (!ref(json.accessors, skin.inverseBindMatrices)) continue;
      for (const [p, prim] of (json.meshes[n.mesh].primitives || []).entries()) {
        if (!record(prim) || !record(prim.attributes)) continue;
        if (prim.attributes.JOINTS_0 === undefined || prim.attributes.WEIGHTS_0 === undefined) continue;
        primitives++;
        const r = strainOfPrimitive(json, bin, skin, prim, `node ${i} skin ${n.skin} primitive ${p}`);
        /* A primitive with no size was not measured, so it cannot be the best
         * of anything — it is counted and set aside. If every primitive is one
         * of these, the answer below is `unreadable`, not `rigid`. */
        if (r.degenerate) { degenerate++; continue; }
        if (!best || r.strain > best.strain) best = { ...r, skin: n.skin, joints: skin.joints };
      }
    }
  } catch (e) {
    return { ...out, primitives, why: [`the skin could not be posed: ${e.message}`] };
  }
  if (!best && degenerate) {
    return { ...out, primitives, why: [
      `every one of the ${degenerate} skinned primitive(s) has a bounding-box diagonal of zero — the `
      + `sampled vertices are all at one point, or a coordinate is not finite. Strain is a fraction of `
      + `the mesh's own size, and a mesh with no size has none to report: this file was NOT shown to be `
      + `rigid, it could not be measured at all. Look at its POSITION accessor.`,
    ] };
  }
  if (!best) return { ...out, why: ["no node with a mesh uses a skin with joints, bind matrices and JOINTS_0/WEIGHTS_0"] };

  const jointName = best.joint >= 0 ? (nodes[best.joints[best.joint]]?.name ?? `node ${best.joints[best.joint]}`) : null;
  const shared = { strain: best.strain, joint: best.joint, jointName, sampled: best.sampled,
                   vertices: best.vertices, primitives, probedJoints: best.probedJoints,
                   movedFraction: best.movedFraction, minStrain: MIN_STRAIN, probeDegrees: PROBE_DEGREES };
  if (best.strain > MIN_STRAIN) {
    return { ...shared, state: "deforms", ok: true, why: [] };
  }
  return { ...shared, state: "rigid", ok: false, why: [
    `turning each of the ${best.probedJoints} joints that own vertices by ${PROBE_DEGREES}° changed the `
    + `distance between the mesh's own points by at most ${best.strain.toExponential(2)} of its size `
    + `(the floor is ${MIN_STRAIN}). The skin binds and it does not deform: every vertex it moves, it `
    + `moves rigidly, which is what a parent transform already does. This is not a rig.`,
  ] };
}

/* ── the second opinion, on the far side of the licence boundary ─────────── */

/** The toolkit's marker, matching server/mv/blender.js's PREVIZ_RESULT_JSON. */
const RESULT_MARKER = "DEFORM_RESULT_JSON:";

/**
 * Where the bpy script lives, and why it is not in this directory.
 *
 * `import bpy` is a derivative work of Blender by the Foundation's stated
 * position, and this tree is Apache-2.0 and public. The same boundary
 * `config.blender.previz` already draws: the script sits in the GPL-3.0
 * toolkit, this side spawns it and reads JSON off stdout, and a file on disk
 * is data. See vendor/previz-blender/LICENSE-NOTE.md.
 */
export function deformScriptPath() {
  return process.env.AIPLAY_DEFORM_SCRIPT
    || path.join(path.dirname(config.blender.previz), "deform.py");
}

/**
 * Ask Blender the same question about the same file.
 *
 * The interpreter is `config.mesh.unirigPython` — the rig venv, which is where
 * bpy 4.2.0 already is, and which the rig path already requires. Not a fifth
 * python.
 *
 * Returns `{ state: "deforms" | "rigid" | "unrun", why: [...], report }`.
 *
 * ⚠ EVERY FAILURE IS `unrun`, INCLUDING A CRASH. Missing interpreter, missing
 * script, an import error, a timeout, unparseable output: none of those are
 * evidence about the file. The only two things that produce a verdict are the
 * script saying it measured movement and the script saying it measured none.
 */
export async function bpyDeform(file, { python, script, timeoutMs = 120000, degrees = PROBE_DEGREES } = {}) {
  const exe = python || config.mesh.unirigPython;
  const py = script || deformScriptPath();
  const unrun = (why) => ({ state: "unrun", ok: false, why: [why], report: null });

  try { await stat(exe); } catch {
    return unrun(`The rig python is not at ${exe}, so the Blender cross-check did not run. `
      + `Set AIPLAY_UNIRIG_PYTHON to an interpreter with bpy 4.2 installed. This is UNRUN, not a pass.`);
  }
  try { await stat(py); } catch {
    return unrun(`The deformation script is not at ${py}. It lives in the GPL previz toolkit because it `
      + `imports bpy, and this Apache-2.0 tree ships no copy of it. Clone the toolkit and point AIPLAY_DEFORM_SCRIPT at its script. This is UNRUN, not a pass.`);
  }

  const args = [py, "--glb", String(file), "--degrees", String(degrees)];
  const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += b; });
  child.stderr.on("data", (b) => { err += b; });
  /* kill(), not runner.js's killMeshProcessTree(): this process spawns nothing —
   * it imports bpy, reads one file and prints one line, with no card and no
   * child — and reaching for that helper would make deform.js import runner.js,
   * which imports deform.js. A cycle to kill a process that has no children. */
  const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
  const code = await new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (c) => resolve(c));
  });
  clearTimeout(timer);

  const line = out.split(/\r?\n/).find((l) => l.startsWith(RESULT_MARKER));
  if (!line) {
    return unrun(`${path.basename(py)} exited ${code} without a ${RESULT_MARKER} line. `
      + `${(err.trim().split(/\r?\n/).pop() || "no stderr").slice(0, 300)}. This is UNRUN, not a pass.`);
  }
  let report;
  try { report = JSON.parse(line.slice(RESULT_MARKER.length)); }
  catch (e) { return unrun(`${path.basename(py)} wrote a result line that is not JSON: ${e.message}. This is UNRUN, not a pass.`); }
  if (report?.deforms === true) return { state: "deforms", ok: true, why: [], report };
  if (report?.deforms === false) return { state: "rigid", ok: false, why: [String(report.why || "Blender measured no deformation")], report };
  return unrun(`${path.basename(py)} answered without a boolean verdict. This is UNRUN, not a pass.`);
}

/**
 * THE WHOLE ANSWER: the closed-form gate, plus Blender's opinion when it can
 * be had, plus the one thing worth knowing when both ran — whether they agree.
 *
 * `bpy: false` skips the subprocess entirely and leaves `cross.state` as
 * `unrun` with the reason, which is what a hot path (a route, a page load)
 * should pass. The rig path passes `true` once, after a rig, when a second
 * of somebody else's arithmetic is cheap against the minutes just spent.
 */
export async function deformReport(file, json, binData, { bpy = false, ...opts } = {}) {
  const gate = assertDeforms(json, binData);
  const cross = bpy
    ? await bpyDeform(file, opts)
    : { state: "unrun", ok: false, report: null,
        why: ["the Blender cross-check was not requested; this is UNRUN, not a pass"] };
  const agree = gate.state === "unreadable" || cross.state === "unrun" ? null : gate.state === cross.state;
  return { ...gate, cross, agree };
}
