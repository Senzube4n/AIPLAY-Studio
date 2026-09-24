import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { MToonMaterial, VRMExpression, VRMExpressionManager, VRMExpressionMaterialColorBind,
  VRMExpressionMorphTargetBind, VRMSpringBoneManager, VRMSpringBoneJoint, VRMHumanoid } from '@pixiv/three-vrm';

// Browser import-map URLs resolve to the same pinned modules in this Node test.
const source = (await readFile(new URL('../../web/avatar-runtime.js', import.meta.url), 'utf8'))
  .replace("from 'three'", `from '${import.meta.resolve('three')}'`)
  .replace("from '/api/avatars/vendor/three-vrm.module.js'", `from '${import.meta.resolve('@pixiv/three-vrm')}'`);
const { createAvatarRuntime, createAvatarLoaderPlugin, disposeAvatarScene } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('viewer disposal releases real MToon sampler textures and shared images once', () => {
  const scene = new THREE.Group(), material = new MToonMaterial(), map = new THREE.Texture(), shade = new THREE.Texture();
  let closed = 0, mapDisposed = 0, shadeDisposed = 0;
  const image = { close() { closed++; } }; map.source.data = image; shade.source.data = image;
  material.map = map; material.normalMap = map; material.shadeMultiplyTexture = shade;
  assert.equal(Object.values(material).includes(map), false);
  map.addEventListener('dispose', () => mapDisposed++); shade.addEventListener('dispose', () => shadeDisposed++);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [material, material.clone()]));
  disposeAvatarScene(scene); disposeAvatarScene(scene);
  assert.equal(mapDisposed, 1); assert.equal(shadeDisposed, 1); assert.equal(closed, 1);
});

const close = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
function fixture() {
  const scene = new THREE.Group(), group = new THREE.Group(), joint = new THREE.Bone();
  const first = new THREE.MeshBasicMaterial({ color: new THREE.Color(.8, .7, .6) });
  const outline = first.clone(); outline.isOutline = true;
  const duplicate = first.clone();
  const a = new THREE.Mesh(new THREE.BoxGeometry(), [first, outline]);
  const b = new THREE.Mesh(new THREE.BoxGeometry(), duplicate);
  const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  a.name = 'Drawable'; a.layers.enable(2);
  scene.add(group); group.add(a, b); a.add(joint, child);
  const associations = new Map([
    [group, { nodes: 4 }], [a, { meshes: 0, primitives: 0 }], [b, { meshes: 0, primitives: 1 }],
    [joint, { nodes: 7 }], [child, { nodes: 5, meshes: 1, primitives: 0 }],
    [first, { materials: 0 }], [duplicate, { materials: 0 }], [child.material, { materials: 1 }],
  ]);
  const nodes = []; nodes[4] = { mesh: 0 }; nodes[5] = { mesh: 1 }; nodes[7] = {};
  const gltf = { scene, parser: { associations, json: { nodes, meshes: [
    { primitives: [{ material: 0 }, { material: 0 }] }, { primitives: [{ material: 1 }] },
  ] } }, userData: {} };
  return { gltf, scene, group, joint, a, b, child, first, outline, duplicate };
}

test('node visibility uses actual indices, includes every primitive and leaves descendants and bones visible', () => {
  const f = fixture(), runtime = createAvatarRuntime(f.gltf);
  runtime.apply({ hidden_nodes: [4] });
  assert.equal(f.a.layers.mask, 0); assert.equal(f.b.layers.mask, 0);
  assert.equal(f.child.layers.mask, 1); assert.equal(f.joint.visible, true);
  assert.equal(f.group.visible, true); assert.equal(f.a.visible, true);
  runtime.apply({ hidden_nodes: [5] });
  assert.equal(f.a.layers.mask, 5); assert.equal(f.b.layers.mask, 1); assert.equal(f.child.layers.mask, 0);
  runtime.reset(); assert.equal(f.child.layers.mask, 1);
});

test('colors reach primitive variants and MToon outline instances and restore embedded defaults', () => {
  const f = fixture(), runtime = createAvatarRuntime(f.gltf);
  runtime.apply({ material_colors: { 0: [.2, .3, .4, .5] } });
  for (const m of [f.first, f.outline, f.duplicate]) {
    close(m.color.r, .2); close(m.color.g, .3); close(m.color.b, .4);
    close(m.opacity, .5); assert.equal(m.transparent, true);
  }
  assert.equal(f.a.material[0], f.first);
  runtime.apply({});
  for (const m of [f.first, f.outline, f.duplicate]) {
    close(m.color.r, .8); close(m.opacity, 1); assert.equal(m.transparent, false);
  }
});

test('real expression bindings remain connected to the material and respect a changed base color', () => {
  const f = fixture(), manager = new VRMExpressionManager();
  f.a.morphTargetInfluences = [0];
  const happy = new VRMExpression('happy');
  const colorBind = new VRMExpressionMaterialColorBind({ material: f.first, type: 'color', targetValue: new THREE.Color(1, 0, 0), targetAlpha: 1 });
  happy.addBind(colorBind);
  const aa = new VRMExpression('aa'); aa.addBind(new VRMExpressionMorphTargetBind({ primitives: [f.a], index: 0, weight: 1 }));
  manager.registerExpression(happy); manager.registerExpression(aa);
  f.gltf.userData.vrm = { expressionManager: manager };
  const runtime = createAvatarRuntime(f.gltf);
  runtime.apply({ material_colors: { 0: [.2, .4, .6, 1] }, expressions: { happy: .5, aa: .7 } });
  for (let i = 0; i < 3; i++) runtime.update(1 / 60);
  close(f.first.color.r, .6); close(f.first.color.g, .2); close(f.first.color.b, .3);
  close(f.a.morphTargetInfluences[0], .7);
  runtime.apply({}); runtime.update(1 / 60);
  close(f.first.color.r, .8); close(f.a.morphTargetInfluences[0], 0);
  assert.equal(happy.binds[0], colorBind);
});

test('invalid settings do not partially mutate the current look', () => {
  const f = fixture(), runtime = createAvatarRuntime(f.gltf);
  runtime.apply({ material_colors: { 0: [.2, .3, .4, 1] } });
  for (const settings of [
    { hidden_nodes: [7] }, { hidden_nodes: [4], material_colors: { 0: [NaN, 0, 0, 1] } },
    { material_colors: { 0: [1, 2, 1, 1] } }, { expressions: { invented: 1 } },
    { spring_enabled: 'yes' },
  ]) assert.throws(() => runtime.apply(settings));
  close(f.first.color.r, .2); assert.equal(f.a.layers.mask, 5);
});

test('generic GLB clips and raw VRM bone motion are not overwritten by normalized pose transfer', () => {
  const f = fixture(), runtime = createAvatarRuntime(f.gltf);
  const mixer = new THREE.AnimationMixer(f.scene);
  const clip = new THREE.AnimationClip('embedded', 1, [new THREE.VectorKeyframeTrack('Drawable.position', [0, 1], [0, 0, 0, 2, 0, 0])]);
  mixer.clipAction(clip).play(); mixer.update(.25); runtime.update(.02);
  close(f.a.position.x, .5); assert.equal(runtime.setPreviewMotion(true), false);
  const humanoid = { autoUpdateHumanBones: true, update() { if (this.autoUpdateHumanBones) f.a.position.x = 99; } };
  f.gltf.userData.vrm = { humanoid };
  const vrmRuntime = createAvatarRuntime(f.gltf);
  mixer.update(.1); vrmRuntime.update(.02);
  close(f.a.position.x, .7); assert.equal(humanoid.autoUpdateHumanBones, false);
  vrmRuntime.dispose(); assert.equal(humanoid.autoUpdateHumanBones, true);
});

test('spring-off resets actual spring bones, freezes simulation and resumes without stale state', () => {
  const f = fixture(), bone = new THREE.Bone(), tip = new THREE.Bone();
  f.scene.add(bone); bone.add(tip); tip.position.set(0, .3, 0); f.scene.updateMatrixWorld(true);
  const springs = new VRMSpringBoneManager();
  springs.addJoint(new VRMSpringBoneJoint(bone, tip, { gravityDir: new THREE.Vector3(1, 0, 0), gravityPower: 1 }));
  springs.setInitState();
  f.gltf.userData.vrm = { springBoneManager: springs };
  const runtime = createAvatarRuntime(f.gltf);
  for (let i = 0; i < 30; i++) runtime.update(1 / 60);
  assert.ok(Math.abs(bone.quaternion.z) > .01);
  runtime.apply({ spring_enabled: false });
  close(bone.quaternion.z, 0); close(bone.quaternion.w, 1);
  for (let i = 0; i < 30; i++) runtime.update(1 / 60);
  close(bone.quaternion.z, 0);
  runtime.apply({ spring_enabled: true }); runtime.update(1 / 60);
  assert.ok(Math.abs(bone.quaternion.z) > 0 && Math.abs(bone.quaternion.z) < .2);
  runtime.reset(); close(bone.quaternion.z, 0);
});

test('preview motion restores the exact entry transforms and component updates keep their required order', () => {
  const f = fixture(), calls = [];
  f.joint.rotation.y = .33;
  let normalized = { head: { rotation: [0, 0, 0, 1] } };
  const humanoid = {
    autoUpdateHumanBones: false,
    getNormalizedPose: () => structuredClone(normalized),
    setNormalizedPose: value => { normalized = structuredClone(value); },
    resetNormalizedPose: () => { normalized = {}; },
    update() { calls.push('humanoid'); if (this.autoUpdateHumanBones) f.joint.quaternion.fromArray(normalized.head.rotation); },
  };
  f.gltf.userData.vrm = {
    humanoid, lookAt: { update: () => calls.push('lookAt') },
    expressionManager: { expressions: [], update: () => calls.push('expressions') },
    nodeConstraintManager: { update: () => calls.push('constraints') },
    springBoneManager: { reset: () => calls.push('resetSprings'), update: () => calls.push('springs') },
    materials: [{ update: () => calls.push('materials') }],
  };
  const runtime = createAvatarRuntime(f.gltf), entry = f.joint.quaternion.clone();
  assert.equal(runtime.setPreviewMotion(true), true);
  runtime.update(.05);
  assert.deepEqual(calls, ['humanoid', 'lookAt', 'expressions', 'constraints', 'springs', 'materials']);
  assert.ok(f.joint.quaternion.angleTo(entry) > .1);
  runtime.setPreviewMotion(false);
  close(f.joint.quaternion.angleTo(entry), 0);
  assert.deepEqual(normalized, { head: { rotation: [0, 0, 0, 1] } });
  assert.equal(humanoid.autoUpdateHumanBones, false);
  runtime.dispose(); runtime.update(.02); assert.equal(runtime.previewMotion, false);
});

test('loader plugin disables normalized pose overwrite for ordinary imported clips', () => {
  const plugin = createAvatarLoaderPlugin({ json: {} });
  assert.equal(plugin.humanoidPlugin.autoUpdateHumanBones, false);
});

test('real normalized humanoid preview moves raw bones and restores an existing pose', () => {
  const f = fixture(), hips = new THREE.Bone(), spine = new THREE.Bone(), head = new THREE.Bone();
  hips.name = 'RigHips'; spine.name = 'RigSpine'; head.name = 'RigHead';
  f.scene.add(hips); hips.add(spine); spine.add(head);
  hips.position.y = 1; spine.position.y = .2; head.position.y = .4;
  f.scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid({ hips: { node: hips }, spine: { node: spine }, head: { node: head } }, { autoUpdateHumanBones: false });
  f.scene.add(humanoid.normalizedHumanBonesRoot);
  head.rotation.y = .4;
  f.gltf.userData.vrm = { humanoid };
  const runtime = createAvatarRuntime(f.gltf), before = head.quaternion.clone();
  runtime.update(.02); close(head.quaternion.angleTo(before), 0);
  runtime.setPreviewMotion(true);
  for (let i = 0; i < 20; i++) runtime.update(.02);
  assert.ok(head.quaternion.angleTo(before) > .1);
  assert.ok(Math.abs(spine.quaternion.z) > .001);
  runtime.setPreviewMotion(false);
  close(head.quaternion.angleTo(before), 0); close(spine.quaternion.z, 0);
  head.rotation.y = .6; runtime.update(.02); close(head.rotation.y, .6);
});
