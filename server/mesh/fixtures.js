/**
 * GLB fixtures — built here rather than checked in as binaries.
 *
 * The assertion this subsystem stands on is "a GLB with a skin", and a test for
 * it needs both a rigged file and an unrigged one that are otherwise identical.
 * Two committed .glb blobs would prove that on two files nobody can read in a
 * diff; a builder proves it on a document whose every field is visible in the
 * source of the test that uses it — including the field being removed.
 *
 * This writes real containers: the 12-byte header, a length-prefixed JSON chunk
 * and a BIN chunk, 4-byte aligned and padded the way the spec requires. It is
 * the only writer in this tree, and it exists so `glb.js` is read by something
 * that did not also write it.
 */

/* ⚠ DERIVED HERE FROM THE ASCII, AND DELIBERATELY NOT IMPORTED FROM glb.js.
 *
 * These three were hand-typed hex, copied across from that file, and one of
 * them was wrong: MAGIC read `0x46546c47` — the bytes "GlTF", capital G — so
 * this writer produced containers no other program would accept and glb.js
 * accepted them, because it held the identical mistake. Forty assertions
 * passed; the first real GLB was rejected.
 *
 * Importing the constant would fix the disagreement by deleting it, which is
 * the wrong repair for a file whose stated purpose (see the header above) is to
 * be a writer glb.js did not also write. So both sides derive the tags from the
 * ASCII the specification names. They now agree only when both are right, and
 * glb_test.js pins the bytes against a literal besides. */
const tag = (s) => Buffer.from(s, "latin1").readUInt32LE(0);
const MAGIC = tag("glTF");
const CHUNK_JSON = tag("JSON");
const CHUNK_BIN = tag("BIN\0");
const binaryByFixture = new WeakMap();
/** Actual vertex/bind bytes, separate from JSON so tests can corrupt either. */
export const fixtureBin = (doc) => binaryByFixture.get(doc);

/** Pad to the next multiple of 4 with `fill` — JSON pads with spaces, BIN with zeros. */
function pad(buf, fill) {
  const n = (4 - (buf.length % 4)) % 4;
  return n ? Buffer.concat([buf, Buffer.alloc(n, fill)]) : buf;
}

/** Wrap a glTF document and a binary blob into a GLB container. */
export function packGlb(doc, bin = fixtureBin(doc) ?? Buffer.alloc(4)) {
  const json = pad(Buffer.from(JSON.stringify(doc), "utf8"), 0x20);
  const b = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + b.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(CHUNK_JSON, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(CHUNK_BIN, 4);
  return Buffer.concat([head, jh, json, bh, b]);
}

/**
 * A glTF document for one mesh, optionally skinned.
 *
 * @param skinned  give it 3 joints and an inverseBindMatrices accessor
 * @param size     [x, y, z] extent, which is what plausiblyHumanoid() reads.
 *                 The default is a standing figure: tall, narrow, shallow.
 * @param breaks   one thing to leave out, to prove the assertion catches it:
 *                 "ibm" | "joints" | "unused" | "count" | "type"
 * @param rigid    ⚠ THE PAIR THE DEFORMATION CHECK EXISTS FOR. With `skinned`,
 *                 this builds a document that is structurally IDENTICAL to the
 *                 rigged one — the same three joints, the same MAT4 inverse
 *                 bind matrices, the same JOINTS_0 naming all three, the same
 *                 WEIGHTS_0 summing to exactly one per vertex, the same node
 *                 hierarchy, the same accessors, the same byte count — and
 *                 differing in one thing only: every gram of weight sits on
 *                 joints[0], the root. `assertSkinned` passes it. The Khronos
 *                 validator passes it. It is not a rig: rotating the root
 *                 carries the whole mesh rigidly and rotating anything else
 *                 moves nothing, so no pose it can reach changes its shape.
 *                 See server/mesh/deform.js — it is the only thing in this
 *                 tree that can tell the two apart, and this is what proves it.
 */
export function glbDoc({ skinned = false, size = [0.5, 1.8, 0.3], breaks = null, rigid = false } = {}) {
  const half = size.map((v) => v / 2);
  // Eight cube corners, three identity bind matrices, one joint per vertex,
  // unit weights and twelve indexed triangles. Unlike the former 4-byte stub,
  // these accessors describe the bytes that a GLB consumer actually reads.
  const bin = Buffer.alloc(520);
  for (let v = 0; v < 8; v++) for (let k = 0; k < 3; k++) {
    bin.writeFloatLE((v & (1 << k) ? 1 : -1) * half[k], v * 12 + k * 4);
  }
  for (let j = 0; j < 3; j++) for (let k = 0; k < 4; k++) bin.writeFloatLE(1, 96 + j * 64 + k * 20);
  for (let v = 0; v < 8; v++) {
    /* THE ONE DIFFERENCE. Rigged: slot 0 carries joint v%3 and all the weight,
     * so the three joints own three different parts of the cube. Rigid: slot 0
     * carries joint 0 and all the weight, and v%3 moves to slot 1 where its
     * weight is zero — so JOINTS_0 still names every joint, the row still sums
     * to one, no vertex is unweighted, and nothing but joint 0 can move a
     * single vertex. Every structural check reads the two the same. */
    bin.writeUInt8(rigid ? 0 : v % 3, 288 + v * 4);
    if (rigid) bin.writeUInt8(v % 3, 288 + v * 4 + 1);
    bin.writeFloatLE(1, 320 + v * 16);
  }
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4,
    2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  indices.forEach((v, i) => bin.writeUInt16LE(v, 448 + i * 2));
  const doc = {
    asset: { version: "2.0", generator: "aiplay-studio mesh fixtures" },
    scene: 0,
    scenes: [{ nodes: skinned ? [0, 1] : [0] }],
    nodes: [{ mesh: 0, name: "body" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: skinned ? 4 : 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3",
        min: [-half[0], -half[1], -half[2]], max: [half[0], half[1], half[2]] },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 96 },
      { buffer: 0, byteOffset: 96, byteLength: 192 },
      { buffer: 0, byteOffset: 288, byteLength: 32 },
      { buffer: 0, byteOffset: 320, byteLength: 128 },
      { buffer: 0, byteOffset: 448, byteLength: 72 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  binaryByFixture.set(doc, bin);
  const indexAccessor = { bufferView: 4, componentType: 5123, count: indices.length, type: "SCALAR" };
  if (!skinned) { doc.accessors.push(indexAccessor); return doc; }

  // Three joints, and the bind-pose accessor that turns them into a skeleton.
  doc.nodes.push({ name: "root", children: [2] }, { name: "spine", children: [3] }, { name: "head" });
  const joints = [1, 2, 3];
  doc.accessors.push(
    { bufferView: 1, componentType: 5126, count: joints.length, type: "MAT4" },
    { bufferView: 2, componentType: 5121, count: 8, type: "VEC4" },
    { bufferView: 3, componentType: 5126, count: 8, type: "VEC4" },
    indexAccessor,
  );
  Object.assign(doc.meshes[0].primitives[0].attributes, { JOINTS_0: 2, WEIGHTS_0: 3 });
  doc.skins = [{ joints, inverseBindMatrices: 1, skeleton: 1 }];
  doc.nodes[0].skin = 0;

  if (breaks === "ibm") delete doc.skins[0].inverseBindMatrices;
  if (breaks === "joints") doc.skins[0].joints = [];
  if (breaks === "unused") delete doc.nodes[0].skin;
  if (breaks === "count") doc.accessors[1].count = 7;
  if (breaks === "type") doc.accessors[1].type = "VEC3";
  return doc;
}

/** The whole file, in one call. */
export const glb = (opts) => packGlb(glbDoc(opts));

/**
 * A BIG rig — many joints, many vertices — for bounding what a check COSTS.
 *
 * ⚠ WHY A SECOND BUILDER RATHER THAN AN OPTION ON THE FIRST. glbDoc() is eight
 * hand-placed corners whose every byte is visible in the source of the test
 * that reads it, and that legibility is its whole value. This one is a loop; it
 * is not for asserting behaviour and no correctness test should use it. It
 * exists because `server/mesh/deform.js` now runs inside the rig path, and a
 * check that is fast on a cube and slow on a character is a check nobody
 * measured. There is no rigged character on this machine to measure against —
 * every real GLB here is an unrigged TripoSG output or a UniRig example input —
 * so the worst case is CONSTRUCTED rather than waited for.
 *
 * A column of vertices along Y, each weighted entirely to one joint of a chain,
 * with bind matrices that are the exact inverse of each joint's global bind
 * transform — so the rest pose is the mesh, unmoved, and assertSkinned passes.
 * Rotating any joint but the last bends everything above it: it deforms.
 *
 * @param joints    bones in the chain (they are 16-bit joint indices here)
 * @param vertices  points in the column
 */
export function bigRigDoc({ joints = 64, vertices = 60000 } = {}) {
  const L = 1.8, radius = 0.2;
  const posBytes = vertices * 12, jntBytes = vertices * 8, wgtBytes = vertices * 16;
  const ibmBytes = joints * 64;
  const bin = Buffer.alloc(posBytes + jntBytes + wgtBytes + ibmBytes);
  const jOff = posBytes, wOff = posBytes + jntBytes, iOff = posBytes + jntBytes + wgtBytes;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertices; v++) {
    const t = v / vertices, a2 = v * 0.7;
    const xyz = [radius * Math.cos(a2), t * L, radius * Math.sin(a2)];
    for (let k = 0; k < 3; k++) {
      bin.writeFloatLE(xyz[k], v * 12 + k * 4);
      lo[k] = Math.min(lo[k], xyz[k]); hi[k] = Math.max(hi[k], xyz[k]);
    }
    bin.writeUInt16LE(Math.min(joints - 1, Math.floor(t * joints)), jOff + v * 8);
    bin.writeFloatLE(1, wOff + v * 16);
  }
  /* IBM_j is the inverse of joint j's global bind transform, which is a
   * translation of j*(L/joints) up the Y axis — so the bind pose is the mesh
   * exactly where it already is, and any drift here would show as a rest-pose
   * displacement rather than as strain. */
  for (let j = 0; j < joints; j++) {
    const m = iOff + j * 64;
    for (let k = 0; k < 4; k++) bin.writeFloatLE(1, m + k * 20);
    bin.writeFloatLE(-j * (L / joints), m + 52);
  }
  const nodes = [{ mesh: 0, skin: 0, name: "column" }];
  for (let j = 0; j < joints; j++) {
    nodes.push({
      name: `j${j}`,
      translation: [0, j === 0 ? 0 : L / joints, 0],
      ...(j < joints - 1 ? { children: [j + 2] } : {}),
    });
  }
  const doc = {
    asset: { version: "2.0", generator: "aiplay-studio mesh fixtures (cost pin)" },
    scene: 0, scenes: [{ nodes: [0, 1] }], nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: "VEC3", min: lo, max: hi },
      { bufferView: 1, componentType: 5123, count: vertices, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: vertices, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: joints, type: "MAT4" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes },
      { buffer: 0, byteOffset: jOff, byteLength: jntBytes },
      { buffer: 0, byteOffset: wOff, byteLength: wgtBytes },
      { buffer: 0, byteOffset: iOff, byteLength: ibmBytes },
    ],
    buffers: [{ byteLength: bin.length }],
    skins: [{ joints: Array.from({ length: joints }, (_, j) => j + 1),
              inverseBindMatrices: 3, skeleton: 1 }],
  };
  binaryByFixture.set(doc, bin);
  return doc;
}

/**
 * The vertex indices `deform.js` used to sample: an even stride across the
 * buffer, `floor(i · count / samples)`. It is here, in the fixture builder,
 * because the fixture below is defined in terms of it — the whole point is a
 * rig this stride cannot see — and because a test that pins a defect should
 * carry the defect's own arithmetic where a reader can check it, rather than
 * asserting a magic index.
 */
export function legacyStrideIndices(count, samples = 1024) {
  if (count <= samples) return Array.from({ length: count }, (_, i) => i);
  const stride = count / samples;
  const out = [];
  for (let i = 0; i < samples; i++) out.push(Math.min(count - 1, Math.floor(i * stride)));
  return out;
}

/**
 * A GENUINE RIG THAT A FIXED STRIDE CALLS RIGID.
 *
 * ⚠ WHAT THIS IS EVIDENCE OF. `deform.js` poses at most a couple of thousand
 * vertices, and it only turns joints that some SAMPLED vertex depends on. When
 * the sample was a fixed stride — 195.31 apart on a 200,000-vertex mesh — any
 * articulated region shorter than the stride could fall entirely between two
 * sampled indices. The joint that owns it is then never turned, nothing moves,
 * and the verdict is `rigid`: a false negative on a file that really does
 * deform, delivered in the confident language of a measurement.
 *
 * That is not a hypothetical shape. This repository's own meshes are 353,606
 * and 985,072 vertices, so every real rig goes down the sampled path, and a
 * region of a few hundred vertices is an eyelid, a fingertip, a jaw.
 *
 * So: a long column of vertices weighted entirely to a root joint — which can
 * only ever move them rigidly — plus one short contiguous BLOCK weighted to a
 * child joint, placed in a gap of `legacyStrideIndices()` so the old sampler
 * provably never looked at it. Turning that child bends the block away from the
 * column, which is deformation by any definition; the file is a rig. A stride
 * sampler reports `rigid`. A sampler that gives every joint that owns vertices
 * a vertex it actually owns reports `deforms`.
 *
 * @param vertices  points in the column (the default is a size at which the
 *                  legacy stride was 195 wide)
 * @param block     vertices owned by the articulated joint; must fit in a gap
 */
export function hiddenJointRigDoc({ vertices = 200000, block = 160 } = {}) {
  const L = 1.0, radius = 0.2, hinge = L;      // the child joint sits at the top
  const seen = new Set(legacyStrideIndices(vertices));
  let start = -1;
  for (let s = Math.floor(vertices / 2); s + block < vertices; s++) {
    let clear = true;
    for (let v = s; v < s + block; v++) if (seen.has(v)) { clear = false; s = v; break; }
    if (clear) { start = s; break; }
  }
  /* A mesh small enough to be sampled ENTIRELY has no gap to hide in, and that
   * is the control case, not a failure: the same shape with every vertex posed
   * is a rig no sampler can miss, which is how a test shows the 200,000-vertex
   * one is a genuine rig rather than an artefact of the new sampling. */
  if (start < 0) {
    if (block * 4 > vertices) throw new Error(`a block of ${block} does not fit in ${vertices} vertices`);
    start = Math.floor(vertices / 2);
  }
  const end = start + block;

  const posBytes = vertices * 12, jntBytes = vertices * 8, wgtBytes = vertices * 16;
  const ibmBytes = 2 * 64;
  const bin = Buffer.alloc(posBytes + jntBytes + wgtBytes + ibmBytes);
  const jOff = posBytes, wOff = posBytes + jntBytes, iOff = posBytes + jntBytes + wgtBytes;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertices; v++) {
    const inBlock = v >= start && v < end;
    /* The column runs 0 → L around the Y axis; the block is a short spur above
     * the hinge, so turning the hinge swings it away from everything else. */
    const t = inBlock ? (v - start) / block : v / vertices;
    const a = v * 0.7;
    const xyz = inBlock
      ? [radius * Math.cos(a), hinge + 0.2 * t, radius * Math.sin(a)]
      : [radius * Math.cos(a), t * L, radius * Math.sin(a)];
    for (let k = 0; k < 3; k++) {
      bin.writeFloatLE(xyz[k], v * 12 + k * 4);
      lo[k] = Math.min(lo[k], xyz[k]); hi[k] = Math.max(hi[k], xyz[k]);
    }
    bin.writeUInt16LE(inBlock ? 1 : 0, jOff + v * 8);
    bin.writeFloatLE(1, wOff + v * 16);
  }
  /* IBM_0 = identity (the root's bind transform is identity); IBM_1 undoes the
   * hinge's translation, so the bind pose is the mesh exactly where it is. */
  for (let j = 0; j < 2; j++) {
    const m = iOff + j * 64;
    for (let k = 0; k < 4; k++) bin.writeFloatLE(1, m + k * 20);
    if (j === 1) bin.writeFloatLE(-hinge, m + 52);
  }
  const doc = {
    asset: { version: "2.0", generator: "aiplay-studio mesh fixtures (stride blind spot)" },
    scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [
      { mesh: 0, skin: 0, name: "column" },
      { name: "root", children: [2] },
      { name: "hinge", translation: [0, hinge, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: "VEC3", min: lo, max: hi },
      { bufferView: 1, componentType: 5123, count: vertices, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: vertices, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 2, type: "MAT4" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes },
      { buffer: 0, byteOffset: jOff, byteLength: jntBytes },
      { buffer: 0, byteOffset: wOff, byteLength: wgtBytes },
      { buffer: 0, byteOffset: iOff, byteLength: ibmBytes },
    ],
    buffers: [{ byteLength: bin.length }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 3, skeleton: 1 }],
  };
  binaryByFixture.set(doc, bin);
  /* The test needs to say which vertices articulate, and a fixture that makes
   * the reader recompute that is a fixture that gets asserted against wrongly.
   * `articulated` is not glTF and no reader looks at it; it rides along. */
  doc.articulated = { start, end, joint: 1, jointNode: 2 };
  return doc;
}

/**
 * A SKINNED MESH WITH NO SIZE: every vertex at one point.
 *
 * There is no strain to measure on it — strain is a fraction of the mesh's own
 * bounding-box diagonal and this one's is zero — so the only honest verdict is
 * "could not be measured". It exists because the arithmetic's natural answer is
 * a clean 0.0, which reads as `rigid`, which is a verdict phrased as fact about
 * a file nothing was measured on.
 */
export function degenerateRigDoc({ vertices = 32 } = {}) {
  const posBytes = vertices * 12, jntBytes = vertices * 8, wgtBytes = vertices * 16;
  const bin = Buffer.alloc(posBytes + jntBytes + wgtBytes + 128);
  const jOff = posBytes, wOff = posBytes + jntBytes, iOff = wOff + wgtBytes;
  for (let v = 0; v < vertices; v++) {
    for (let k = 0; k < 3; k++) bin.writeFloatLE(0.25, v * 12 + k * 4);   // all coincident
    bin.writeUInt16LE(v % 2, jOff + v * 8);
    bin.writeFloatLE(1, wOff + v * 16);
  }
  for (let j = 0; j < 2; j++) {
    const m = iOff + j * 64;
    for (let k = 0; k < 4; k++) bin.writeFloatLE(1, m + k * 20);
    if (j === 1) bin.writeFloatLE(-1, m + 52);
  }
  const doc = {
    asset: { version: "2.0", generator: "aiplay-studio mesh fixtures (degenerate)" },
    scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [
      { mesh: 0, skin: 0, name: "point" },
      { name: "root", children: [2] },
      { name: "hinge", translation: [0, 1, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: "VEC3",
        min: [0.25, 0.25, 0.25], max: [0.25, 0.25, 0.25] },
      { bufferView: 1, componentType: 5123, count: vertices, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: vertices, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 2, type: "MAT4" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes },
      { buffer: 0, byteOffset: jOff, byteLength: jntBytes },
      { buffer: 0, byteOffset: wOff, byteLength: wgtBytes },
      { buffer: 0, byteOffset: iOff, byteLength: 128 },
    ],
    buffers: [{ byteLength: bin.length }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 3, skeleton: 1 }],
  };
  binaryByFixture.set(doc, bin);
  return doc;
}
