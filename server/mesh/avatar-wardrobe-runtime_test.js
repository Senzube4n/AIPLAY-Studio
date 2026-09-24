import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createAvatarWardrobeRuntime,disposeWardrobeGltf,captureAvatarRestPose} from '../../web/avatar-wardrobe.js';
import {inspectWardrobePart} from './avatar-wardrobe.js';
import {glbDoc,packGlb,fixtureBin} from './fixtures.js';

const avatarId='av_12345678-1234-4321-8765-123456789abc';
const partId='part_12345678-1234-4321-8765-123456789abc';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const close=(actual,expected)=>assert.ok(actual.distanceTo(expected)<1e-5,`${actual.toArray()} differs from ${expected.toArray()}`);
function model({offset=0,multi=false}={}){const j=glbDoc({skinned:true}),bin=Buffer.from(fixtureBin(j));j.materials=[{pbrMetallicRoughness:{baseColorFactor:[.4,.5,.6,1]}}];j.meshes[0].primitives[0].material=0;
  if(offset){j.nodes[0].translation=[offset,0,0];for(let i=0;i<3;i++)bin.writeFloatLE(offset,96+i*64+48);}
  if(multi){j.skins.push({...j.skins[0],joints:[1,2,3]});j.nodes.push({mesh:0,skin:1,name:'second mesh'});j.scenes[0].nodes.push(4);}
  return packGlb(j,bin);
}
const parse=bytes=>new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
const meshes=gltf=>{const result=[];gltf.scene.traverse(o=>{if(o.isSkinnedMesh)result.push(o);});return result;};
const worldVertex=(mesh,index)=>{mesh.updateMatrixWorld(true);mesh.skeleton.update();return mesh.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);};
async function fixture(options={}){const bytes=model({multi:options.multi}),partBytes=model({offset:options.offset||0}),gltf=await parse(bytes),part=await parse(partBytes),sha256=hash(bytes),manifest={id:partId,avatarId,baseSha256:sha256,inspection:await inspectWardrobePart(partBytes,bytes,sha256)};
  return {gltf,part,manifest,runtime:createAvatarWardrobeRuntime({gltf,avatarId,sha256})};}

test('real GLTFLoader weighted part follows original base joints and adds no duplicate bones',async()=>{
  const f=await fixture({multi:true}),baseMeshes=meshes(f.gltf),baseBones=new Set(baseMeshes.flatMap(m=>m.skeleton.bones));
  const count=()=>{let n=0;f.gltf.scene.traverse(o=>{if(o.isBone)n++;});return n;};const before=count();
  f.runtime.attach(f.part,f.manifest);assert.equal(count(),before);
  const added=meshes(f.gltf).find(m=>m.name.startsWith('wardrobe_'));assert.ok(added);
  assert.ok(added.skeleton.bones.every(b=>baseBones.has(b)));assert.notEqual(added.skeleton,baseMeshes[0].skeleton);
  const original=worldVertex(added,1);baseMeshes[0].skeleton.bones[1].rotation.z=.75;f.runtime.update();
  const moved=worldVertex(added,1);assert.ok(moved.distanceTo(original)>.05);close(moved,worldVertex(baseMeshes[0],1));
  assert.equal(f.part.scene.parent,null);assert.equal(f.gltf.userData.vrm,undefined);
  f.runtime.dispose();assert.equal(count(),before);assert.equal(meshes(f.gltf).length,2);disposeWardrobeGltf(f.gltf);
});

test('nonidentity mesh placement and transformed base scene preserve correct world deformation',async()=>{
  const f=await fixture({offset:2}),source=meshes(f.part)[0],expected=worldVertex(source,1);
  f.runtime.attach(f.part,f.manifest);const added=meshes(f.gltf).find(m=>m.name.startsWith('wardrobe_'));close(worldVertex(added,1),expected);
  f.gltf.scene.position.set(3,1,-2);f.gltf.scene.scale.setScalar(2);f.runtime.update();
  close(worldVertex(added,1),expected.clone().multiplyScalar(2).add(new THREE.Vector3(3,1,-2)));
  const bone=meshes(f.gltf)[0].skeleton.bones[1];bone.rotation.z=Math.PI/2;f.runtime.update();
  const posed=expected.clone().applyAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2).multiplyScalar(2).add(new THREE.Vector3(3,1,-2));close(worldVertex(added,1),posed);
  f.runtime.dispose();disposeWardrobeGltf(f.gltf);
});

test('replace validates the whole batch before changing current visible parts or taking candidate ownership',async()=>{
  const f=await fixture();f.runtime.replace([{gltf:f.part,manifest:f.manifest}]);const old=meshes(f.gltf).find(m=>m.name.startsWith('wardrobe_'));
  const first=await parse(model()),second=await parse(model()),other={...f.manifest,id:'part_abcdefab-abcd-4abc-8abc-abcdefabcdef'},wrong={...f.manifest,id:'part_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',baseSha256:'0'.repeat(64)};
  let disposed=0;meshes(first)[0].geometry.addEventListener('dispose',()=>disposed++);
  assert.throws(()=>f.runtime.replace([{gltf:first,manifest:other},{gltf:second,manifest:wrong}]),/different avatar/);
  assert.deepEqual(f.runtime.partIds,[partId]);assert.equal(old.parent.parent,f.gltf.scene);assert.equal(disposed,0);
  disposeWardrobeGltf(first);disposeWardrobeGltf(second);assert.equal(disposed,1);
  const next=await parse(model());f.runtime.replace([{gltf:next,manifest:other}]);assert.deepEqual(f.runtime.partIds,[other.id]);assert.equal(old.parent.parent,null);
  f.runtime.dispose();disposeWardrobeGltf(f.gltf);
});

test('removal/disposal release only owned part geometry, material, textures and skeleton buffers once',async()=>{
  const f=await fixture(),base=meshes(f.gltf)[0],part=meshes(f.part)[0],texture=new THREE.Texture();part.material.map=texture;
  const events={baseGeometry:0,baseMaterial:0,geometry:0,material:0,texture:0};
  base.geometry.addEventListener('dispose',()=>events.baseGeometry++);base.material.addEventListener('dispose',()=>events.baseMaterial++);
  part.geometry.addEventListener('dispose',()=>events.geometry++);part.material.addEventListener('dispose',()=>events.material++);texture.addEventListener('dispose',()=>events.texture++);
  f.runtime.attach(f.part,f.manifest);const added=meshes(f.gltf).find(m=>m.name.startsWith('wardrobe_'));added.skeleton.computeBoneTexture();let skeletonTexture=0;added.skeleton.boneTexture.addEventListener('dispose',()=>skeletonTexture++);
  assert.equal(f.runtime.remove(partId),true);assert.equal(f.runtime.remove(partId),false);f.runtime.dispose();disposeWardrobeGltf(f.part);
  assert.deepEqual(events,{baseGeometry:0,baseMaterial:0,geometry:1,material:1,texture:1});assert.equal(skeletonTexture,1);assert.ok(base.skeleton.bones.every(b=>b.parent));
  assert.throws(()=>f.runtime.attach(f.part,f.manifest),/disposed/);disposeWardrobeGltf(f.gltf);
});

test('loaded joint mismatches and foreign identity refuse attachment before base mutation',async()=>{
  const f=await fixture();
  const wrong=structuredClone(f.manifest);wrong.inspection.bindings[0].baseJointNodes=[1,3,2];assert.throws(()=>f.runtime.attach(f.part,wrong),/joints do not match/);
  assert.throws(()=>f.runtime.attach(f.part,{...f.manifest,avatarId:'av_foreign'}),/different avatar/);
  assert.deepEqual(f.runtime.partIds,[]);assert.equal(meshes(f.gltf).length,1);
  f.runtime.dispose();disposeWardrobeGltf(f.part);disposeWardrobeGltf(f.gltf);
});

test('restoring the captured base pose ignores attachment inverse binds and keeps the outfit aligned',async()=>{
  const f=await fixture({offset:2}),restore=captureAvatarRestPose(f.gltf.scene),base=meshes(f.gltf)[0];
  const bone=base.skeleton.bones[1],original=bone.position.clone();f.runtime.attach(f.part,f.manifest);
  const added=meshes(f.gltf).find(m=>m.name.startsWith('wardrobe_')),before=worldVertex(added,1);
  bone.position.set(5,4,3);bone.rotation.z=.8;f.runtime.update();assert.ok(worldVertex(added,1).distanceTo(before)>1);
  restore();f.runtime.update();close(bone.position,original);close(worldVertex(added,1),before);
  assert.deepEqual(added.matrix.elements,f.manifest.inspection.bindings[0].meshMatrix);
  f.runtime.dispose();disposeWardrobeGltf(f.gltf);
});
