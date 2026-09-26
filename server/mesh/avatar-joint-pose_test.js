import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createAvatarJointPose} from '../../web/avatar-joint-pose.js';
import {glbDoc,packGlb} from './fixtures.js';

const parse=async()=>{
  const bytes=packGlb(glbDoc({skinned:true}));
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
};
const vertex=(mesh,index)=>{
  mesh.updateMatrixWorld(true);mesh.skeleton.update();
  return mesh.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
};

test('a named imported joint bends weighted vertices and reset restores the original pose',async()=>{
  const gltf=await parse(),pose=createAvatarJointPose(gltf,[{index:1,name:'root'},{index:2,name:'spine'},{index:3,name:'head'}]);
  const mesh=gltf.scene.getObjectByProperty('isSkinnedMesh',true);
  assert.deepEqual(pose.joints.map(joint=>joint.index),[1,2,3]);
  const before=vertex(mesh,1),rest=gltf.parser.associations;
  pose.apply({node_index:2,axis:'z',degrees:30});
  assert.ok(vertex(mesh,1).distanceTo(before)>.01,'the actual skinned vertex must move');
  assert.equal(pose.current,2);
  pose.apply({node_index:3,axis:'x',degrees:-15});
  assert.equal(pose.current,3);
  assert.ok(vertex(mesh,1).distanceTo(before)<1e-5,'switching joints restores the previous joint first');
  pose.reset();assert.ok(vertex(mesh,1).distanceTo(before)<1e-5);
  assert.equal(pose.current,null);assert.ok(rest);
  assert.throws(()=>pose.apply({node_index:99,axis:'z',degrees:20}),/imported joint/);
  assert.throws(()=>pose.apply({node_index:2,axis:'z',degrees:46}),/-45° to 45°/);
});
