/** CPU-only data-level skin validation, independent corruptions of JSON and BIN. */
import test from "node:test";
import assert from "node:assert/strict";
import { readGlb, assertSkinned } from "./glb.js";
import { glbDoc, fixtureBin, packGlb } from "./fixtures.js";

function fixture() {
  const doc = glbDoc({ skinned: true });
  return { doc, bin: Buffer.from(fixtureBin(doc)) };
}
function verdict({ doc, bin }) {
  const g = readGlb(packGlb(doc, bin));
  assert.equal(g.ok, true, g.why.join("; "));
  return assertSkinned(g.json);
}
function append(f, data, view = {}) {
  const padding = Buffer.alloc((4 - f.bin.length % 4) % 4);
  const byteOffset = f.bin.length + padding.length;
  f.bin = Buffer.concat([f.bin, padding, data]);
  const index = f.doc.bufferViews.length;
  f.doc.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, ...view });
  f.doc.buffers[0].byteLength = f.bin.length;
  return index;
}
function quantized(f, bits = 8) {
  const bytes = bits / 8, b = Buffer.alloc(8 * 4 * bytes);
  for (let v = 0; v < 8; v++) {
    if (bits === 8) b.writeUInt8(255, v * 4); else b.writeUInt16LE(65535, v * 8);
  }
  f.doc.accessors[3] = { bufferView: append(f, b), componentType: bits === 8 ? 5121 : 5123,
    type: "VEC4", count: 8, normalized: true };
}
function sparseWeights(f) {
  const indices = append(f, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  const values = append(f, f.bin.subarray(320, 448));
  f.doc.accessors[3] = { componentType: 5126, type: "VEC4", count: 8,
    sparse: { count: 8, indices: { bufferView: indices, componentType: 5121 }, values: { bufferView: values } } };
}

test("real binary skin passes and preserves the caller API", () => {
  const f = fixture(), g = readGlb(packGlb(f.doc, f.bin));
  const s = assertSkinned(g.json);
  assert.deepEqual({ ok: s.ok, joints: s.joints, skins: s.skins, vertices: s.vertices,
    primitives: s.primitives, verifiedSkins: s.verifiedSkins },
  { ok: true, joints: 3, skins: 1, vertices: 8, primitives: 1, verifiedSkins: 1 });
  assert.equal(g.bin, g.binData.length);
  assert.equal(JSON.stringify(g.json), JSON.stringify(f.doc), "no binary fields attached to the document");
  assert.equal(assertSkinned(structuredClone(g.json), g.binData).ok, true);
  assert.equal(assertSkinned(structuredClone(g.json)).ok, false, "JSON alone cannot prove skin bytes");
});

for (const bits of [8, 16]) test(`normalized uint${bits} weights are decoded`, () => {
  const f = fixture(); quantized(f, bits);
  assert.equal(verdict(f).ok, true);
  const a = f.doc.accessors[3], offset = f.doc.bufferViews[a.bufferView].byteOffset;
  if (bits === 8) f.bin.writeUInt8(254, offset); else f.bin.writeUInt16LE(65534, offset);
  const s = verdict(f);
  assert.equal(s.ok, false); assert.match(s.why.join(" "), /weights sum/);
});

test("uint16 joint attributes are decoded", () => {
  const f = fixture(), b = Buffer.alloc(8 * 8);
  for (let v = 0; v < 8; v++) b.writeUInt16LE(v % 3, v * 8);
  f.doc.accessors[2] = { bufferView: append(f, b), type: "VEC4", count: 8, componentType: 5123 };
  assert.equal(verdict(f).ok, true);
  b.writeUInt16LE(65535, 0);
  f.bin.writeUInt16LE(65535, f.doc.bufferViews[f.doc.accessors[2].bufferView].byteOffset);
  assert.equal(verdict(f).ok, false);
});

test("interleaved POSITION/JOINTS/WEIGHTS with accessor offsets passes", () => {
  const f = fixture(), data = Buffer.alloc(8 * 32);
  for (let v = 0; v < 8; v++) {
    f.bin.copy(data, v * 32, v * 12, v * 12 + 12);
    f.bin.copy(data, v * 32 + 12, 288 + v * 4, 288 + v * 4 + 4);
    f.bin.copy(data, v * 32 + 16, 320 + v * 16, 320 + v * 16 + 16);
  }
  const view = append(f, data, { byteStride: 32 });
  for (const [index, byteOffset] of [[0, 0], [2, 12], [3, 16]]) {
    Object.assign(f.doc.accessors[index], { bufferView: view, byteOffset });
  }
  assert.equal(verdict(f).ok, true);
  f.doc.bufferViews[view].byteLength--;
  assert.match(verdict(f).why.join(" "), /accessor byte range/);
});

test("additional joint/weight sets normalize together", () => {
  const f = fixture(), weights = Buffer.alloc(8 * 16), joints = Buffer.alloc(8 * 4);
  for (let v = 0; v < 8; v++) {
    f.bin.writeFloatLE(0.75, 320 + v * 16);
    weights.writeFloatLE(0.25, v * 16); joints[v * 4] = (v + 1) % 3;
  }
  const ji = f.doc.accessors.push({ bufferView: append(f, joints), count: 8, type: "VEC4", componentType: 5121 }) - 1;
  const wi = f.doc.accessors.push({ bufferView: append(f, weights), count: 8, type: "VEC4", componentType: 5126 }) - 1;
  Object.assign(f.doc.meshes[0].primitives[0].attributes, { JOINTS_1: ji, WEIGHTS_1: wi });
  assert.equal(verdict(f).ok, true);
  f.bin[f.doc.bufferViews[f.doc.accessors[ji].bufferView].byteOffset] = 0;
  assert.match(verdict(f).why.join(" "), /more than one non-zero weight/);
});

test("sparse weights with implicit zero base are applied", () => {
  const f = fixture(); sparseWeights(f);
  assert.equal(verdict(f).ok, true);
  const indices = f.doc.accessors[3].sparse.indices;
  f.bin[f.doc.bufferViews[indices.bufferView].byteOffset + 1] = 0;
  assert.match(verdict(f).why.join(" "), /strictly increasing/);
});

test("sparse override on a real base accessor is applied", () => {
  const f = fixture(), value = Buffer.alloc(16); value.writeFloatLE(1, 0);
  f.bin.writeFloatLE(0, 320);
  f.doc.accessors[3].sparse = { count: 1,
    indices: { bufferView: append(f, Buffer.from([0])), componentType: 5121 },
    values: { bufferView: append(f, value) } };
  assert.equal(verdict(f).ok, true);
});

const negatives = [
  ["skeleton marker without vertex bindings", f => { delete f.doc.meshes[0].primitives[0].attributes.JOINTS_0; }, /JOINTS_0 and WEIGHTS_0/],
  ["missing weights", f => { delete f.doc.meshes[0].primitives[0].attributes.WEIGHTS_0; }, /JOINTS_0 and WEIGHTS_0/],
  ["second primitive unweighted", f => f.doc.meshes[0].primitives.push({ attributes: { POSITION: 0 } }), /primitive 1.*JOINTS/],
  ["bad mesh reference", f => { f.doc.nodes[0].mesh = 90; }, /mesh reference/],
  ["negative mesh reference", f => { f.doc.nodes[0].mesh = -1; }, /mesh reference/],
  ["missing skin reference", f => { f.doc.nodes[0].skin = 99; }, /skin that does not exist/],
  ["fractional skin reference", f => { f.doc.nodes[0].skin = 0.5; }, /skin that does not exist/],
  ["empty mesh primitives", f => { f.doc.meshes[0].primitives = []; }, /no primitives/],
  ["null joint node", f => { f.doc.nodes[3] = null; }, /not a node/],
  ["duplicate joint nodes", f => { f.doc.skins[0].joints[2] = 2; }, /duplicate joint/],
  ["bad skeleton reference", f => { f.doc.skins[0].skeleton = 99; }, /skeleton references/],
  ["wrong skeleton ancestor", f => { f.doc.skins[0].skeleton = 3; }, /not an ancestor/],
  ["disconnected joints", f => { delete f.doc.nodes[1].children; }, /no common root/],
  ["cyclic hierarchy", f => { f.doc.nodes[3].children = [1]; }, /cycle/],
  ["multiple parents", f => { f.doc.nodes[0].children = [3]; }, /multiple parents/],
  ["IBM integer data", f => { f.doc.accessors[1].componentType = 5123; }, /componentType/],
  ["IBM count omitted", f => { delete f.doc.accessors[1].count; }, /bind matrices/],
  ["IBM contains NaN", f => f.bin.writeFloatLE(NaN, 96), /non-finite/],
  ["IBM contains infinity", f => f.bin.writeFloatLE(Infinity, 100), /non-finite/],
  ["IBM zero matrix", f => f.bin.fill(0, 96, 160), /not affine/],
  ["IBM singular matrix", f => f.bin.writeFloatLE(0, 96), /singular/],
  ["IBM wrong fourth row", f => f.bin.writeFloatLE(1, 108), /not affine/],
  ["POSITION contains NaN", f => f.bin.writeFloatLE(NaN, 0), /POSITION.*non-finite/],
  ["JOINTS wrong type", f => { f.doc.accessors[2].type = "VEC3"; }, /not VEC4/],
  ["JOINTS normalized", f => { f.doc.accessors[2].normalized = true; }, /normalized is not allowed/],
  ["JOINTS outside skin range", f => { f.bin[288] = 3; }, /outside skin.joints/],
  ["unused JOINTS outside skin range", f => { f.bin[289] = 3; }, /outside skin.joints/],
  ["all weights zero", f => f.bin.fill(0, 320, 336), /weights sum to 0/],
  ["weights under-normalized", f => f.bin.writeFloatLE(0.99, 320), /weights sum/],
  ["weight negative", f => f.bin.writeFloatLE(-1, 320), /out-of-range weight/],
  ["weight above one", f => f.bin.writeFloatLE(2, 320), /out-of-range weight/],
  ["weight NaN", f => f.bin.writeFloatLE(NaN, 320), /non-finite/],
  ["weight infinity", f => f.bin.writeFloatLE(Infinity, 320), /non-finite/],
  ["float weights marked normalized", f => { f.doc.accessors[3].normalized = true; }, /normalized is not allowed/],
  ["integer weights not normalized", f => { quantized(f); delete f.doc.accessors[3].normalized; }, /must be normalized/],
  ["duplicate non-zero joint weights", f => { f.bin.writeFloatLE(0.5, 320); f.bin.writeFloatLE(0.5, 324); }, /more than one non-zero weight/],
  ["unpaired extra set", f => { f.doc.meshes[0].primitives[0].attributes.JOINTS_1 = 2; }, /must be paired/],
  ["missing middle set", f => Object.assign(f.doc.meshes[0].primitives[0].attributes, { JOINTS_2: 2, WEIGHTS_2: 3 }), /contiguous/],
  ["skin vertex counts differ", f => { f.doc.accessors[3].count = 7; }, /vertex counts differ/],
  ["fractional accessor count", f => { f.doc.accessors[3].count = 7.5; }, /count must/],
  ["huge implicit sparse count", f => { sparseWeights(f); f.doc.accessors[3].count = 4294967295; }, /count must/],
  ["accessor negative offset", f => { f.doc.accessors[2].byteOffset = -4; }, /byteOffset/],
  ["accessor alignment", f => { f.doc.accessors[2].byteOffset = 1; }, /byteOffset/],
  ["accessor range beyond view", f => { f.doc.bufferViews[3].byteLength--; }, /accessor byte range/],
  ["buffer view beyond buffer", f => { f.doc.bufferViews[3].byteLength = 9999; }, /bufferView byte range/],
  ["buffer declaration beyond BIN", f => { f.doc.buffers[0].byteLength++; }, /byteLength disagrees/],
  ["buffer declaration excludes data", f => { f.doc.buffers[0].byteLength -= 4; }, /byteLength disagrees/],
  ["external binary data", f => { f.doc.buffers[0].uri = "file:///private.bin"; }, /external\/data-URI/],
  ["nonembedded buffer", f => { f.doc.bufferViews[3].buffer = 1; }, /embedded buffer 0/],
  ["bad bufferView reference", f => { f.doc.accessors[3].bufferView = 99; }, /bufferView 99/],
  ["vertex stride too small", f => { f.doc.bufferViews[3].byteStride = 12; }, /byteStride/],
  ["vertex stride misaligned", f => { f.doc.bufferViews[3].byteStride = 17; }, /byteStride/],
  ["IBM may not use vertex stride", f => { f.doc.bufferViews[1].byteStride = 64; }, /byteStride/],
  ["meshopt compression unsupported", f => { f.doc.bufferViews[3].extensions = { EXT_meshopt_compression: {} }; }, /compressed bufferView/],
  ["Draco compression unsupported", f => { f.doc.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} }; }, /Draco/],
  ["sparse index beyond accessor", f => { sparseWeights(f); f.bin[f.doc.bufferViews[f.doc.accessors[3].sparse.indices.bufferView].byteOffset + 7] = 8; }, /strictly increasing/],
  ["sparse values short", f => { sparseWeights(f); f.doc.bufferViews[f.doc.accessors[3].sparse.values.bufferView].byteLength--; }, /sparse value byte range/],
  ["sparse stride forbidden", f => { sparseWeights(f); f.doc.bufferViews[f.doc.accessors[3].sparse.values.bufferView].byteStride = 16; }, /sparse bufferViews/],
  ["triangle index outside vertices", f => f.bin.writeUInt16LE(8, 448), /outside the POSITION/],
  ["second referenced broken skin", f => { f.doc.skins.push({ joints: [] }); f.doc.nodes.push({ mesh: 0, skin: 1 }); }, /skin 1 has no joints/],
];
for (const [name, corrupt, reason] of negatives) test(`reject: ${name}`, () => {
  const f = fixture(); corrupt(f);
  const s = verdict(f);
  assert.equal(s.ok, false, name); assert.match(s.why.join(" "), reason);
});

test("BIN padding up to three bytes is not treated as missing data", () => {
  const f = fixture(); append(f, Buffer.from([42]));
  assert.equal(verdict(f).ok, true);
});

test("unused broken skin is tolerated; referenced broken skins are not", () => {
  const f = fixture(); f.doc.skins.push({ joints: [] });
  assert.equal(verdict(f).ok, true);
});

test("wrong GLB version is refused even with valid chunks", () => {
  const f = fixture(), b = packGlb(f.doc, f.bin); b.writeUInt32LE(1, 4);
  assert.match(readGlb(b).why.join(" "), /version 1/); assert.equal(readGlb(b).ok, false);
});

test("trailing incomplete chunk is refused", () => {
  const f = fixture(), b = Buffer.concat([packGlb(f.doc, f.bin), Buffer.alloc(4)]);
  b.writeUInt32LE(b.length, 8);
  assert.equal(readGlb(b).ok, false); assert.match(readGlb(b).why.join(" "), /incomplete chunk/);
});

test("unaligned declared chunk length is refused", () => {
  const f = fixture(), b = packGlb(f.doc, f.bin); b.writeUInt32LE(b.readUInt32LE(12) - 1, 12);
  assert.equal(readGlb(b).ok, false); assert.match(readGlb(b).why.join(" "), /alignment/);
});

test("BIN-first and duplicate JSON/BIN containers are refused", () => {
  const f = fixture(), b = packGlb(f.doc, f.bin), jsonEnd = 20 + b.readUInt32LE(12);
  for (const chunk of [b.subarray(12, jsonEnd), b.subarray(jsonEnd)]) {
    const dup = Buffer.concat([b, chunk]); dup.writeUInt32LE(dup.length, 8);
    assert.equal(readGlb(dup).ok, false);
  }
  const swapped = Buffer.concat([b.subarray(0, 12), b.subarray(jsonEnd), b.subarray(12, jsonEnd)]);
  assert.equal(readGlb(swapped).ok, false);
});

test("unknown trailing chunks remain forward compatible", () => {
  const f = fixture(), extra = Buffer.from([4, 0, 0, 0, 88, 89, 90, 0, 0, 0, 0, 0]);
  const b = Buffer.concat([packGlb(f.doc, f.bin), extra]); b.writeUInt32LE(b.length, 8);
  const g = readGlb(b); assert.equal(g.ok, true); assert.equal(assertSkinned(g.json).ok, true);
});

test("JSON arrays are not glTF documents", () => {
  assert.equal(readGlb(packGlb([])).ok, false);
  assert.equal(assertSkinned([]).ok, false);
});
