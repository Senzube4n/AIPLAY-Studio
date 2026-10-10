import test from 'node:test';
import assert from 'node:assert/strict';
import {glbDoc, packGlb} from './fixtures.js';
import {readGlb} from './glb.js';
import {inspectAvatarSpringMotion} from './avatar-motion-audit.js';

function audit(setup = () => {}) {
  const doc = glbDoc({skinned: true});
  doc.extensionsUsed = ['VRMC_springBone'];
  doc.extensions = {VRMC_springBone: {specVersion: '1.0', springs: [{name: 'Hair', joints: [{node: 3}]}]}};
  setup(doc);
  const parsed = readGlb(packGlb(doc));
  assert.equal(parsed.ok, true);
  return inspectAvatarSpringMotion(parsed.json, parsed.binData);
}

test('counts actual skinned vertices influenced by a declared spring joint', () => {
  const result = audit();
  assert.equal(result.status, 'linked');
  assert.equal(result.linkedChains, 1);
  assert.equal(result.meshes[0].weightedVertices, 2);
  assert.equal(result.meshes[0].vertices, 8);
  assert.deepEqual(result.meshes[0].chainIndices, [0]);
  assert.equal(result.chains[0].weightedVertices, 2);
  assert.deepEqual(result.chains[0].meshNodes, [0]);
});

test('counts weights on a spring joint descendant, without claiming visual quality', () => {
  const result = audit(doc => { doc.extensions.VRMC_springBone.springs[0].joints[0].node = 2; });
  assert.equal(result.meshes[0].weightedVertices, 5);
  assert.equal(result.chains[0].weightedVertices, 5);
});

test('declared chain without weighted geometry is distinguished from a rigid child mesh', () => {
  const empty = audit(doc => {
    doc.nodes[3].children = [4]; doc.nodes.push({name: 'Hair tip'});
    doc.extensions.VRMC_springBone.springs[0].joints[0].node = 4;
  });
  assert.equal(empty.status, 'unlinked');
  assert.equal(empty.linkedChains, 0);
  const rigid = audit(doc => {
    doc.nodes[3].children = [4]; doc.nodes.push({name: 'Rigid hair tuft', mesh: 0});
    doc.extensions.VRMC_springBone.springs[0].joints[0].node = 4;
  });
  assert.equal(rigid.status, 'linked');
  assert.equal(rigid.chains[0].weightedVertices, 0);
  assert.equal(rigid.chains[0].rigidMeshes, 1);
  assert.equal(rigid.meshes[1].kind, 'rigid');
});

test('a missing or undeclared spring extension never reports motion as verified', () => {
  const none = audit(doc => { delete doc.extensions; delete doc.extensionsUsed; });
  assert.equal(none.status, 'no_springs');
  const undeclared = audit(doc => { delete doc.extensionsUsed; });
  assert.equal(undeclared.status, 'unverified');
  const invalidWeights = audit(doc => { delete doc.meshes[0].primitives[0].attributes.WEIGHTS_0; });
  assert.equal(invalidWeights.status, 'unverified');
});
