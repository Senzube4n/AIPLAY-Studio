import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createAvatarJointPose} from '../../web/avatar-joint-pose.js';
import {mountAvatarFootReview} from '../../web/avatar-foot-review.js';
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

test('VRM foot buttons target mapped skinned joints one at a time and keep pressed state in sync',async()=>{
  const gltf=await parse(),pose=createAvatarJointPose(gltf,[{index:1,name:'root'},{index:2,name:'leftFoot'},{index:3,name:'rightFoot'}]);
  const elements=new Map(),element=id=>{
    if(!elements.has(id))elements.set(id,{hidden:true,onclick:null,attributes:{},
      setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name];}});
    return elements.get(id);
  };
  const commands=[],ui=mountAvatarFootReview({inspection:{profile:'vrm',footControls:{leftFootNode:2,rightFootNode:3}},
    joints:pose.joints,documentRef:{getElementById:element},onPose:command=>{commands.push(command);pose.apply(command);ui.paint(command);}});
  assert.equal(element('foot-review-controls').hidden,false);
  element('foot-review-left').onclick();
  assert.deepEqual(commands.at(-1),{node_index:2,axis:'x',degrees:25});
  assert.equal(pose.current,2);
  assert.equal(element('foot-review-left').getAttribute('aria-pressed'),'true');
  element('foot-review-right').onclick();
  assert.deepEqual(commands.at(-1),{node_index:3,axis:'x',degrees:25});
  assert.equal(pose.current,3);
  assert.equal(element('foot-review-left').getAttribute('aria-pressed'),'false');
  assert.equal(element('foot-review-right').getAttribute('aria-pressed'),'true');
  assert.ok(pose.worldPosition(2)?.isVector3);
  element('foot-review-right').onclick();
  assert.deepEqual(commands.at(-1),{node_index:3,axis:'x',degrees:0});
  assert.equal(element('foot-review-right').getAttribute('aria-pressed'),'false');
  ui.paint(null);assert.equal(element('foot-review-right').getAttribute('aria-pressed'),'false');
  ui.dispose();assert.equal(element('foot-review-controls').hidden,true);
  assert.equal(element('foot-review-left').onclick,null);
});

test('foot review stays hidden without both mapped skinned joints',()=>{
  const elements=new Map(),element=id=>{
    if(!elements.has(id))elements.set(id,{hidden:true,onclick:null,setAttribute(){}});
    return elements.get(id);
  };
  for(const footControls of [{leftFootNode:2,rightFootNode:2},{leftFootNode:2,rightFootNode:3},{}]){
    const ui=mountAvatarFootReview({inspection:{profile:'vrm',footControls},joints:[{index:2}],
      documentRef:{getElementById:element},onPose:()=>assert.fail('unavailable foot was posed')});
    assert.equal(element('foot-review-controls').hidden,true);
    assert.equal(element('foot-review-left').onclick,null);
    ui.dispose();
  }
});
