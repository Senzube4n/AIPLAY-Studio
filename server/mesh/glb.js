/**
 * GLB, read as a container — enough to answer two questions and nothing more.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * The downstream contract is not "a 3D file". It is **a GLB with a skin** —
 * glTF `skins[]` carrying `joints` and `inverseBindMatrices`, with a node that
 * actually uses one. A rigged mesh and an unrigged mesh have the same
 * extension, the same magic number and very similar sizes, so "the rig
 * succeeded" is a claim that cannot be made from an exit code. UniRig writing a
 * file is not UniRig writing a rig.
 *
 * That is the same lesson as `server/mv/blender.js`'s contact-sheet gate, one
 * format along: the toolkit's own sidecar said "model reference" and a renamed
 * grid still got through, so the check went into the PIXELS. Here the check
 * goes into the CONTAINER. Reading a GLB header and its JSON chunk needs no
 * python, no venv and no GPU — it is a length-prefixed chunk list and a JSON
 * blob, so the assertion can be made on this side of the subprocess boundary,
 * by anything, later, with no memory of the run that produced the file.
 *
 * This checks the container AND the bytes used by each referenced skin. A
 * skins[] marker alone does not bind any vertices: POSITION, JOINTS_n,
 * WEIGHTS_n and inverse bind matrices must be readable and usable together.
 * It has no opinion about anatomical or visual deformation quality.
 * Every public validation function returns a verdict object with a `why` list
 * rather than throwing, because the caller has to be able to tell a refusal
 * ("this has no skin") from a crash ("this is not a file"), and an exception
 * flattens the two.
 *
 * ⚠ A malformed file is NOT a verdict of "unrigged". It returns `ok: false`
 * with the reason, and the caller says so. Reporting "no skin" for a truncated
 * download sends somebody to re-run a rig that was never the problem.
 */
import { readFile } from "node:fs/promises";

/**
 * The four-byte tags, DERIVED FROM THE ASCII rather than hand-encoded.
 *
 * ⚠ THIS IS WHERE THIS FILE WAS WRONG, and how it was wrong is worth keeping.
 * MAGIC was typed as the literal `0x46546c47` — the bytes "GlTF", with a
 * capital G. Every real GLB begins "glTF", 0x67, so readGlb() rejected every
 * genuine container ever handed to it with "the first four bytes are not
 * glTF" — including the one TripoSG had just spent a minute of card time
 * producing, which reached this function through the app's own route and was
 * thrown away one byte short of being believed.
 *
 * It survived a 40-assertion suite because `fixtures.js` built its containers
 * from a COPY of the same constant. The test and the code agreed with each
 * other and neither had ever met a file — the same failure this module's own
 * header warns about one layer up, where it says a checker living in the same
 * process as the thing it checks is a checker that agrees with it.
 *
 * So the tags are no longer typed as numbers. tag() reads them off the ASCII
 * the specification actually names, which cannot disagree with the spec by one
 * bit, and fixtures.js imports these rather than keeping its own copy.
 */
const tag = (s) => Buffer.from(s, "latin1").readUInt32LE(0);
/** "glTF" as a little-endian uint32 — the first four bytes of every GLB. */
export const MAGIC = tag("glTF");
/** Chunk types, same encoding. "JSON" and "BIN\0". */
export const CHUNK_JSON = tag("JSON");
export const CHUNK_BIN = tag("BIN\0");

/** A container is a header plus at least one chunk header: 12 + 8. */
const MIN_GLB = 20;

/**
 * ⚠ A CEILING ON THE JSON CHUNK, because this reads untrusted files.
 *
 * A GLB's chunk length is a uint32 the file declares about itself, so a hostile
 * or corrupt header can claim 4 GB and this would try to slice it. The real
 * limit is that a glTF scene description is text: 64 MB of JSON is already an
 * absurd scene, and anything above it is a header that is lying.
 */
const MAX_JSON_BYTES = 64 * 1024 * 1024;
// Preserve assertSkinned(readGlb(...).json) without adding private data to JSON.
const binaryByDocument = new WeakMap();

/**
 * Parse a GLB buffer into `{ ok, json, bin, why }`.
 *
 * `bin` retains its historical numeric byte length. `binData` is the embedded
 * Buffer, also retained privately for assertSkinned(json). Treat it as read-only.
 */
export function readGlb(buf) {
  const why = [];
  if (!Buffer.isBuffer(buf) || buf.length < MIN_GLB) {
    return { ok: false, json: null, bin: 0, why: ["not a GLB: shorter than a GLB header"] };
  }
  if (buf.readUInt32LE(0) !== MAGIC) {
    return { ok: false, json: null, bin: 0, why: ["not a GLB: the first four bytes are not \"glTF\""] };
  }
  const version = buf.readUInt32LE(4);
  const declared = buf.readUInt32LE(8);
  /* The declared total is checked rather than trusted, and a mismatch is a
   * refusal rather than a shrug: a truncated write is exactly what an
   * interrupted subprocess leaves behind, and it is the failure most likely to
   * be read as "the rig did not take". */
  if (declared !== buf.length) {
    why.push(`the container declares ${declared} bytes and the file is ${buf.length}`);
    return { ok: false, json: null, bin: 0, why };
  }
  if (version !== 2) return { ok: false, json: null, bin: 0,
    why: [`glTF container version ${version}, expected 2`] };

  let off = 12, json = null, bin = 0, binData = null, chunkIndex = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (off + 8 + len > buf.length) {
      why.push("a chunk claims more bytes than the file holds");
      return { ok: false, json: null, bin: 0, why };
    }
    if (len % 4 || (chunkIndex === 0 && type !== CHUNK_JSON)
        || (type === CHUNK_JSON && chunkIndex !== 0)
        || (type === CHUNK_BIN && (chunkIndex !== 1 || binData !== null))) {
      return { ok: false, json: null, bin: 0,
        why: ["invalid GLB chunk order or alignment: JSON must be first, BIN second, each at most once and 4-byte aligned"] };
    }
    if (type === CHUNK_JSON) {
      if (len > MAX_JSON_BYTES) {
        why.push(`the JSON chunk claims ${len} bytes, which is past this reader's ceiling`);
        return { ok: false, json: null, bin: 0, why };
      }
      try {
        json = JSON.parse(buf.toString("utf8", off + 8, off + 8 + len));
      } catch (e) {
        why.push(`the JSON chunk is not JSON: ${e.message}`);
        return { ok: false, json: null, bin: 0, why };
      }
    } else if (type === CHUNK_BIN) {
      bin = len;
      binData = buf.subarray(off + 8, off + 8 + len);
    }
    // The declared chunk length includes its padding.
    off += 8 + len;
    chunkIndex++;
  }
  if (off !== buf.length) return { ok: false, json: null, bin: 0,
    why: ["the GLB ends with an incomplete chunk header"] };
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, json: null, bin, why: [...why, "the GLB carries no JSON chunk"] };
  }
  binaryByDocument.set(json, binData);
  return { ok: true, json, bin, binData, why };
}

/** Read a .glb off disk. A missing or unreadable file is a verdict, not a throw. */
export async function readGlbFile(file) {
  let buf;
  try { buf = await readFile(file); }
  catch (e) { return { ok: false, json: null, bin: 0, why: [`could not read ${file}: ${e.message}`] }; }
  return readGlb(buf);
}

/**
 * The BIN chunk readGlb kept beside a document, for the modules that also have
 * to read those bytes.
 *
 * The WeakMap itself stays private — it is how assertSkinned(readGlb(...).json)
 * works without hanging a Buffer off the JSON, and publishing it would let a
 * caller ATTACH one, which is a way to have a document validated against bytes
 * it did not come with. This is read-only and returns undefined for anything
 * this module did not parse, which is the same answer as "pass the Buffer".
 */
export const binaryOfDocument = (json) => binaryByDocument.get(json);

const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v) => Number.isSafeInteger(v) && v >= 0;
const ref = (list, i) => Array.isArray(list) && uint(i) && i < list.length && record(list[i]);
const requireValid = (condition, why) => { if (!condition) throw new Error(why); };
const COMPONENTS = {
  5121: { bytes: 1, max: 255, read: (b, o) => b.readUInt8(o) },
  5123: { bytes: 2, max: 65535, read: (b, o) => b.readUInt16LE(o) },
  5125: { bytes: 4, max: 4294967295, read: (b, o) => b.readUInt32LE(o) },
  5126: { bytes: 4, max: 1, read: (b, o) => b.readFloatLE(o) },
};
const WIDTHS = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
// A corrupt sparse accessor may claim billions of implicit zero vertices.
// Bound synchronous work as well as byte ranges; refuse, never partially verify.
const MAX_ACCESSOR_COUNT = 5_000_000;
const MAX_VALIDATION_COMPONENTS = 100_000_000;

/**
 * Skin transforms need an acyclic, unambiguous node hierarchy.
 *
 * Exported for `deform.js`, which has to walk the same parents to build a
 * joint's global transform. Deliberately NOT re-implemented there: an
 * articulation measurement that disagreed with the skin validator about who
 * a node's parent is would be measuring a different file.
 */
export function nodeHierarchy(nodes) {
  const parent = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const children = nodes[i]?.children;
    if (children === undefined) continue;
    requireValid(Array.isArray(children), `node ${i} children is not an array`);
    for (const child of children) {
      requireValid(ref(nodes, child), `node ${i} has a child reference that is not a node`);
      requireValid(!parent.has(child), `node ${child} has duplicate or multiple parents`);
      parent.set(child, i);
    }
  }
  const roots = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const path = new Set(); let n = i;
    while (parent.has(n) && !roots.has(n)) {
      requireValid(!path.has(n), `node hierarchy contains a cycle at node ${n}`);
      path.add(n); n = parent.get(n);
    }
    const root = roots.get(n) ?? n;
    roots.set(i, root);
    for (const child of path) roots.set(child, root);
  }
  const descendants = new Map();
  return { parent, roots, descendantsOf(root) {
    if (!descendants.has(root)) {
      const seen = new Set(), stack = [root];
      while (stack.length) {
        const n = stack.pop(); seen.add(n);
        for (const child of nodes[n]?.children || []) stack.push(child);
      }
      descendants.set(root, seen);
    }
    return descendants.get(root);
  } };
}

/** Only the uncompressed embedded buffer is supported; no external file reads. */
function bufferView(json, bin, index, label) {
  requireValid(ref(json.bufferViews, index), `${label}: bufferView ${index} does not exist`);
  const v = json.bufferViews[index];
  requireValid(v.buffer === 0 && ref(json.buffers, v.buffer), `${label}: buffer must reference embedded buffer 0`);
  requireValid(json.buffers[0].uri === undefined, `${label}: external/data-URI buffers are not verified; embed the skin data in the GLB BIN chunk`);
  requireValid(!v.extensions?.EXT_meshopt_compression, `${label}: compressed bufferView is not supported by the skin validator`);
  const length = json.buffers[0].byteLength, offset = v.byteOffset ?? 0;
  requireValid(uint(length) && length > 0 && length <= bin.length && bin.length - length <= 3,
    `${label}: embedded buffer byteLength disagrees with the BIN chunk`);
  requireValid(uint(offset) && uint(v.byteLength) && v.byteLength > 0
    && offset <= length && v.byteLength <= length - offset, `${label}: bufferView byte range exceeds the embedded buffer`);
  return { ...v, byteOffset: offset };
}

/**
 * Decode only the accessor formats used below, including interleaved and
 * sparse data.
 *
 * Exported for the same reason as nodeHierarchy above: `deform.js` reads
 * POSITION, JOINTS_n, WEIGHTS_n and the bind matrices to pose the mesh, and
 * it must read the bytes THIS function validated, through this function.
 * A second decoder would be a second opinion about what the file says, when
 * the only second opinion worth having is the one on the far side of the
 * process boundary (bpy), reading the file as a whole.
 */
export function skinAccessor(json, bin, index, { label, type, types, normalized = false, vertex = false }) {
  requireValid(ref(json.accessors, index), `${label}: accessor ${index} does not exist`);
  const a = json.accessors[index];
  requireValid(a.type === type, `${label}: accessor is ${a.type || "untyped"}, not ${type}`);
  requireValid(types.includes(a.componentType), `${label}: unsupported componentType ${a.componentType}`);
  requireValid(a.normalized === undefined || typeof a.normalized === "boolean", `${label}: normalized must be boolean`);
  const needsNormalization = normalized && a.componentType !== 5126;
  requireValid(Boolean(a.normalized) === needsNormalization, `${label}: ${needsNormalization ? "integer weights must be normalized" : "normalized is not allowed for this accessor"}`);
  requireValid(uint(a.count) && a.count > 0 && a.count <= MAX_ACCESSOR_COUNT,
    `${label}: accessor count must be a positive integer no greater than ${MAX_ACCESSOR_COUNT}`);
  const c = COMPONENTS[a.componentType], width = WIDTHS[type], size = c.bytes * width;
  const offset = a.byteOffset ?? 0;
  requireValid(uint(offset) && offset % c.bytes === 0 && (!vertex || offset % 4 === 0), `${label}: misaligned or invalid accessor byteOffset`);
  let base = null, stride = size;
  if (a.bufferView !== undefined) {
    const v = bufferView(json, bin, a.bufferView, label);
    requireValid((v.byteOffset + offset) % c.bytes === 0, `${label}: bufferView/accessor component alignment is invalid`);
    if (v.byteStride !== undefined) {
      requireValid(vertex && uint(v.byteStride) && v.byteStride >= size && v.byteStride <= 252 && v.byteStride % 4 === 0,
        `${label}: invalid byteStride (only vertex attributes may be interleaved)`);
      stride = v.byteStride;
    }
    requireValid(offset <= v.byteLength && size <= v.byteLength - offset
      && (a.count - 1) * stride <= v.byteLength - offset - size, `${label}: accessor byte range exceeds its bufferView`);
    base = v.byteOffset + offset;
  } else {
    requireValid(offset === 0, `${label}: byteOffset requires a bufferView`);
    requireValid(record(a.sparse), `${label}: accessor has neither binary data nor sparse values`);
  }
  let sparse = null, sparseBase = 0;
  if (a.sparse !== undefined) {
    const s = a.sparse;
    requireValid(record(s) && uint(s.count) && s.count > 0 && s.count <= a.count, `${label}: invalid sparse count`);
    requireValid(record(s.indices) && record(s.values) && [5121, 5123, 5125].includes(s.indices.componentType), `${label}: invalid sparse indices/values`);
    const ic = COMPONENTS[s.indices.componentType];
    const iv = bufferView(json, bin, s.indices.bufferView, `${label} sparse indices`);
    const vv = bufferView(json, bin, s.values.bufferView, `${label} sparse values`);
    const io = s.indices.byteOffset ?? 0, vo = s.values.byteOffset ?? 0;
    requireValid(iv.byteStride === undefined && vv.byteStride === undefined && iv.target === undefined && vv.target === undefined,
      `${label}: sparse bufferViews must not have target or byteStride`);
    requireValid(uint(io) && io % ic.bytes === 0 && (iv.byteOffset + io) % ic.bytes === 0
      && io <= iv.byteLength && s.count * ic.bytes <= iv.byteLength - io, `${label}: sparse index byte range/alignment is invalid`);
    requireValid(uint(vo) && vo % c.bytes === 0 && (vv.byteOffset + vo) % c.bytes === 0
      && vo <= vv.byteLength && s.count * size <= vv.byteLength - vo, `${label}: sparse value byte range/alignment is invalid`);
    sparse = new Map(); sparseBase = vv.byteOffset + vo;
    let last = -1;
    for (let i = 0; i < s.count; i++) {
      const j = ic.read(bin, iv.byteOffset + io + i * ic.bytes);
      requireValid(j > last && j < a.count, `${label}: sparse indices must be strictly increasing and within accessor count`);
      sparse.set(j, i); last = j;
    }
  }
  return { count: a.count, componentType: a.componentType, at(i, k) {
    const si = sparse?.get(i);
    const address = si !== undefined ? sparseBase + si * size : base === null ? null : base + i * stride;
    const value = address === null ? 0 : c.read(bin, address + k * c.bytes);
    return needsNormalization ? value / c.max : value;
  } };
}

function validateBindMatrices(json, bin, s, i, spend) {
  requireValid(ref(json.accessors, s.inverseBindMatrices), `skin ${i} has no inverseBindMatrices accessor — glTF permits that and the downstream requires an explicit bind pose`);
  const count = json.accessors[s.inverseBindMatrices].count;
  requireValid(count === s.joints.length, `skin ${i} has ${s.joints.length} joints and ${count} bind matrices`);
  const a = skinAccessor(json, bin, s.inverseBindMatrices,
    { label: `skin ${i} inverseBindMatrices`, type: "MAT4", types: [5126] });
  // Preserve the downstream's exact one-matrix-per-joint contract.
  requireValid(a.count === s.joints.length, `skin ${i} has ${s.joints.length} joints and ${a.count} bind matrices`);
  spend(a.count * 16);
  for (let j = 0; j < a.count; j++) {
    const m = Array.from({ length: 16 }, (_, k) => a.at(j, k));
    requireValid(m.every(Number.isFinite), `skin ${i} bind matrix ${j} contains a non-finite component`);
    requireValid(m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1,
      `skin ${i} bind matrix ${j} is not affine (fourth row must be 0, 0, 0, 1)`);
    const det = m[0] * (m[5] * m[10] - m[9] * m[6])
      - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    requireValid(Number.isFinite(det) && det !== 0, `skin ${i} bind matrix ${j} is singular and cannot bind a usable pose`);
  }
}

function validatePrimitive(json, bin, p, label, jointCount, spend) {
  requireValid(record(p) && record(p.attributes), `${label}: missing primitive attributes`);
  requireValid(!p.extensions?.KHR_draco_mesh_compression, `${label}: Draco-compressed skin data is not supported by the validator`);
  const attrs = p.attributes;
  requireValid(attrs.JOINTS_0 !== undefined && attrs.WEIGHTS_0 !== undefined, `${label}: JOINTS_0 and WEIGHTS_0 are required to bind vertices`);
  const pos = skinAccessor(json, bin, attrs.POSITION, { label: `${label} POSITION`, type: "VEC3", types: [5126], vertex: true });
  const setNames = Object.keys(attrs).filter(k => /^(JOINTS|WEIGHTS)_/.test(k));
  requireValid(setNames.every(k => /^(JOINTS|WEIGHTS)_(0|[1-9]\d*)$/.test(k)), `${label}: invalid skin attribute set name`);
  const sets = [...new Set(setNames.map(k => Number(k.split("_")[1])))].sort((a, b) => a - b);
  requireValid(sets.every((s, i) => s === i), `${label}: skin attribute sets must be contiguous from 0`);
  spend(pos.count * (3 + sets.length * 8));
  const pairs = sets.map(s => {
    requireValid(attrs[`JOINTS_${s}`] !== undefined && attrs[`WEIGHTS_${s}`] !== undefined, `${label}: JOINTS_${s} and WEIGHTS_${s} must be paired`);
    const j = skinAccessor(json, bin, attrs[`JOINTS_${s}`], { label: `${label} JOINTS_${s}`, type: "VEC4", types: [5121, 5123], vertex: true });
    const w = skinAccessor(json, bin, attrs[`WEIGHTS_${s}`], { label: `${label} WEIGHTS_${s}`, type: "VEC4", types: [5121, 5123, 5126], normalized: true, vertex: true });
    requireValid(j.count === pos.count && w.count === pos.count, `${label}: POSITION/JOINTS_${s}/WEIGHTS_${s} vertex counts differ`);
    return [j, w];
  });
  for (let v = 0; v < pos.count; v++) {
    requireValid([0, 1, 2].every(k => Number.isFinite(pos.at(v, k))), `${label}: POSITION vertex ${v} contains a non-finite component`);
    let sum = 0, nonzero = 0;
    const used = new Set();
    for (const [j, w] of pairs) for (let k = 0; k < 4; k++) {
      const joint = j.at(v, k), weight = w.at(v, k);
      requireValid(joint < jointCount, `${label}: vertex ${v} references joint ${joint}, outside skin.joints (${jointCount})`);
      requireValid(Number.isFinite(weight) && weight >= 0 && weight <= 1, `${label}: vertex ${v} has a non-finite or out-of-range weight`);
      if (weight > 0) {
        requireValid(!used.has(joint), `${label}: vertex ${v} assigns more than one non-zero weight to joint ${joint}`);
        used.add(joint); nonzero++;
      }
      sum += weight;
    }
    // Same float tolerance as the Khronos validator. Quantized sums must also
    // total one; a missing integer quantum is far larger than this tolerance.
    const tolerance = pairs.every(([, w]) => w.componentType !== 5126) ? 1e-12 : 2e-7 * nonzero;
    requireValid(nonzero > 0 && Math.abs(sum - 1) <= tolerance,
      `${label}: vertex ${v} weights sum to ${sum}, expected 1 (no unweighted vertices)`);
  }
  if (p.indices !== undefined) {
    const idx = skinAccessor(json, bin, p.indices, { label: `${label} indices`, type: "SCALAR", types: [5121, 5123, 5125] });
    spend(idx.count);
    for (let i = 0; i < idx.count; i++) requireValid(idx.at(i, 0) < pos.count, `${label}: index ${i} is outside the POSITION vertex count`);
  }
  return pos.count;
}

/**
 * Verify the bytes of every mesh-bound skin, not just the skins[] marker.
 * Explicit inverse bind matrices and an exact joint/matrix count remain the
 * downstream contract, stricter than optional glTF identity defaults.
 * Unreferenced leftover skins are ignored; an invalid referenced skin is not.
 *
 * `binData` may be omitted for the original JSON from readGlb/readGlbFile.
 * Copied/plain documents require it explicitly. No external/compressed buffers
 * are fetched or decoded. This verifies binding data, not anatomy, materials,
 * animation quality, or every rule in the complete glTF specification.
 */
export function assertSkinned(json, binData = undefined) {
  if (!record(json)) return { ok: false, joints: 0, skins: 0, why: ["no glTF document"] };
  const skins = Array.isArray(json.skins) ? json.skins : [];
  const result = { ok: false, joints: 0, skins: skins.length, why: [] };
  if (!skins.length) return { ...result, why: ["the GLB has no `skins` — this is an unrigged mesh"] };
  const bin = binData === undefined ? binaryByDocument.get(json) : binData;
  try {
    const nodes = Array.isArray(json.nodes) ? json.nodes : [];
    const hierarchy = nodeHierarchy(nodes);
    const uses = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!record(n) || n.skin === undefined) continue;
      requireValid(ref(skins, n.skin), `node ${i} references a skin that does not exist`);
      requireValid(ref(json.meshes, n.mesh), `node ${i} uses skin ${n.skin} but its mesh reference does not exist`);
      if (!uses.has(n.skin)) uses.set(n.skin, new Set());
      uses.get(n.skin).add(n.mesh);
    }
    requireValid(uses.size > 0, "no node with a mesh uses any skin");
    requireValid(Buffer.isBuffer(bin) && bin.length > 0, "skin binary data is unavailable; use readGlb/readGlbFile or pass the BIN Buffer to assertSkinned(json, binData)");
    let components = 0, vertices = 0, primitives = 0;
    const spend = (n) => { components += n; requireValid(components <= MAX_VALIDATION_COMPONENTS, `skin validation exceeds the ${MAX_VALIDATION_COMPONENTS}-component work limit`); };
    for (const [i, meshes] of uses) {
      const s = skins[i], joints = s.joints;
      requireValid(Array.isArray(joints) && joints.length > 0, `skin ${i} has no joints`);
      result.joints = Math.max(result.joints, joints.length);
      requireValid(joints.every(j => ref(nodes, j)), `skin ${i} has a joint index that is not a node`);
      requireValid(new Set(joints).size === joints.length, `skin ${i} has duplicate joint nodes`);
      requireValid(s.skeleton === undefined || ref(nodes, s.skeleton), `skin ${i} skeleton references a node that does not exist`);
      requireValid(joints.every(j => hierarchy.roots.get(j) === hierarchy.roots.get(joints[0])), `skin ${i} joints have no common root in the node hierarchy`);
      if (s.skeleton !== undefined) {
        const descendants = hierarchy.descendantsOf(s.skeleton);
        spend(descendants.size);
        requireValid(joints.every(j => descendants.has(j)), `skin ${i} skeleton is not an ancestor of every joint`);
      }
      validateBindMatrices(json, bin, s, i, spend);
      for (const m of meshes) {
        const ps = json.meshes[m].primitives;
        requireValid(Array.isArray(ps) && ps.length > 0, `skin ${i} mesh ${m} has no primitives`);
        for (let p = 0; p < ps.length; p++) {
          vertices += validatePrimitive(json, bin, ps[p], `skin ${i} mesh ${m} primitive ${p}`, joints.length, spend);
          primitives++;
        }
      }
    }
    return { ...result, ok: true, vertices, primitives, verifiedSkins: uses.size };
  } catch (e) { return { ...result, why: [e.message] }; }
}

/**
 * The bounding box of every POSITION accessor, from the accessor MIN/MAX the
 * glTF document already carries.
 *
 * Free, because glTF REQUIRES min and max on a POSITION accessor — so the
 * extent of a mesh is readable without decoding one byte of geometry. Returns
 * null when no primitive declares one (legal for other attributes, and a
 * document that omits it for POSITION is out of spec; either way the answer is
 * "cannot tell", never a guess).
 */
export function boundsOf(json) {
  const acc = Array.isArray(json?.accessors) ? json.accessors : [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let seen = 0;
  for (const mesh of json?.meshes || []) {
    for (const prim of mesh?.primitives || []) {
      const i = prim?.attributes?.POSITION;
      if (!Number.isInteger(i) || i < 0 || i >= acc.length) continue;
      const a = acc[i];
      if (!Array.isArray(a?.min) || !Array.isArray(a?.max) || a.min.length < 3 || a.max.length < 3) continue;
      for (let k = 0; k < 3; k++) {
        if (Number.isFinite(a.min[k])) lo[k] = Math.min(lo[k], a.min[k]);
        if (Number.isFinite(a.max[k])) hi[k] = Math.max(hi[k], a.max[k]);
      }
      seen++;
    }
  }
  if (!seen || lo.some((v) => !Number.isFinite(v)) || hi.some((v) => !Number.isFinite(v))) return null;
  return { min: lo, max: hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/**
 * ⚠ THE HUMANOID RATIO, AND WHAT IT IS AND IS NOT.
 *
 * A cheap, honest test that a mesh is PLAUSIBLY something a skeleton model was
 * trained on: its longest axis is meaningfully longer than the other two. A
 * person, an animal on its legs, a figure — all tall and thin relative to their
 * footprint. A crate, a plinth, a wheel, a coin are not.
 *
 * `1.6` is not a measurement of anything and this file will not pretend it is.
 * It is a deliberately LOOSE floor chosen so the test can only catch the case it
 * is for: a blocky object. A standing human is around 3-4 by this ratio, so
 * everything humanoid clears it with room to spare, and a cube (1.0) does not.
 * The cost of it being wrong in one direction is a refused rig somebody can
 * override; in the other, a confident skeleton inside a crate.
 *
 * Returns `{ plausible, ratio, why }` — `plausible: true` with `ratio: null`
 * when the mesh declares no bounds, because "cannot tell" must not read as
 * "refuse". A gate that blocks on missing evidence blocks on the first file
 * whose exporter was slightly unusual.
 */
export const HUMANOID_MIN_RATIO = 1.6;

export function plausiblyHumanoid(json) {
  const b = boundsOf(json);
  if (!b) {
    return { plausible: true, ratio: null,
             why: "the mesh declares no POSITION bounds, so its proportions could not be read — "
                + "not a reason to refuse" };
  }
  const s = b.size.map((v) => Math.abs(v)).sort((a, c) => c - a);
  /* A degenerate mesh (a plane, a point) divides by zero. Say so rather than
   * returning Infinity and calling a flat sheet an excellent humanoid. */
  if (!(s[1] > 0) || !(s[2] > 0)) {
    return { plausible: false, ratio: null,
             why: `the mesh is flat or degenerate (extent ${b.size.map((v) => v.toFixed(3)).join(" x ")})` };
  }
  const ratio = s[0] / Math.max(s[1], s[2]);
  return {
    plausible: ratio >= HUMANOID_MIN_RATIO,
    ratio,
    why: `longest axis is ${ratio.toFixed(2)}x the larger of the other two `
       + `(extent ${b.size.map((v) => v.toFixed(3)).join(" x ")})`,
  };
}
