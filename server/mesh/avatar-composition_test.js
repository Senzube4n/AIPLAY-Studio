import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VRMLoaderPlugin} from '@pixiv/three-vrm';
import {composeAvatarVrm} from './avatar-composition.js';
import {inspectWardrobePart} from './avatar-wardrobe.js';
import {createAvatarWardrobeRuntime} from '../../web/avatar-wardrobe.js';
import {readGlb,skinAccessor} from './glb.js';
import {glbDoc,packGlb,fixtureBin} from './fixtures.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const partId='part_12345678-1234-4321-8765-123456789abc',avatarId='av_12345678-1234-4321-8765-123456789abc';
const human=['hips','spine','head','leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot'];
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2r9sAAAAASUVORK5CYII=','base64');
function model({vrm=false,offset=0,texture=false,sparse=false,multi=false,materials=1}={}){
  const doc=glbDoc({skinned:true});let bin=Buffer.from(fixtureBin(doc));
  doc.materials=Array.from({length:materials},()=>({pbrMetallicRoughness:{baseColorFactor:[.4,.5,.6,1]}}));doc.meshes[0].primitives[0].material=0;
  if(offset){doc.nodes[0].translation=[offset,0,0];for(let i=0;i<3;i++)bin.writeFloatLE(offset,96+i*64+48);}
  const add=bytes=>{const padded=Buffer.alloc((-bin.length)&3);const index=doc.bufferViews.length;doc.bufferViews.push({buffer:0,byteOffset:bin.length+padded.length,byteLength:bytes.length});bin=Buffer.concat([bin,padded,bytes]);return index;};
  if(texture){
    const view=add(image);doc.images=[{bufferView:view,mimeType:'image/png',name:'one pixel'}];doc.samplers=[{magFilter:9729,minFilter:9729}];doc.textures=[{source:0,sampler:0}];
    const uv=new Float32Array(16);const uvView=add(Buffer.from(uv.buffer));doc.bufferViews[uvView].target=34962;doc.accessors.push({bufferView:uvView,componentType:5126,count:8,type:'VEC2'});doc.meshes[0].primitives[0].attributes.TEXCOORD_0=doc.accessors.length-1;
    doc.extensionsUsed=['KHR_texture_transform','KHR_materials_unlit'];doc.materials[0].extensions={KHR_materials_unlit:{}};
    doc.materials[0].pbrMetallicRoughness.baseColorTexture={index:0,extensions:{KHR_texture_transform:{offset:[.1,.2],scale:[.8,.9]}}};
    doc.materials[0].emissiveTexture={index:0};doc.materials[0].emissiveFactor=[.1,.1,.1];
  }
  if(sparse){const indices=add(Buffer.from([0])),values=add(Buffer.from(new Float32Array([1,.25,.5,1]).buffer));doc.accessors.push({componentType:5126,count:8,type:'VEC4',sparse:{count:1,indices:{bufferView:indices,componentType:5121},values:{bufferView:values}}});doc.meshes[0].primitives[0].attributes.COLOR_0=doc.accessors.length-1;}
  if(multi){doc.skins.push({...structuredClone(doc.skins[0])});doc.nodes.push({name:'second mesh',mesh:0,skin:1});doc.scenes[0].nodes.push(doc.nodes.length-1);}
  if(vrm){
    const assigned=[1,2,3];while(assigned.length<human.length){assigned.push(doc.nodes.length);doc.nodes.push({name:'human_'+human[assigned.length-1]});doc.nodes[1].children.push(doc.nodes.length-1);}
    doc.extensionsUsed=[...(doc.extensionsUsed||[]),'VRMC_vrm','VRMC_springBone','VRMC_node_constraint'];
    doc.extensions={VRMC_vrm:{specVersion:'1.0',meta:{name:'Test base',authors:['Test'],licenseUrl:'https://vrm.dev/licenses/1.0/'},humanoid:{humanBones:Object.fromEntries(human.map((name,i)=>[name,{node:assigned[i]}]))},expressions:{preset:{happy:{materialColorBinds:[{material:0,type:'color',targetValue:[1,0,0,1]}]}}}},VRMC_springBone:{specVersion:'1.0',springs:[{name:'authored spring',joints:[{node:3,stiffness:1,dragForce:.4}]}]}};
    doc.nodes[assigned.at(-1)].extensions={VRMC_node_constraint:{specVersion:'1.0',constraint:{rotation:{source:assigned.at(-2),weight:1}}}};
    doc.extras={sentinel:{unchanged:true}};doc.asset.extras={provenance:'base author'};
  }
  doc.buffers[0].byteLength=bin.length;return packGlb(doc,bin);
}
const entry=bytes=>({id:partId,bytes,sha256:hash(bytes),name:'Fixture shirt',source:'Original test fixture',license:'Test data'});
const compose=(base,part)=>composeAvatarVrm({baseBytes:base,baseSha256:hash(base),parts:part?[entry(part)]:[]});
const rewrite=(bytes,fn)=>{const data=readGlb(bytes);fn(data.json);return packGlb(data.json,data.binData);};
async function parse(bytes,vrm=false){const loader=new GLTFLoader();if(vrm)loader.register(parser=>new VRMLoaderPlugin(parser));
  // The test exercises geometry/rig loading in Node; GPU image decoding is not
  // available here. Exact original image bytes are checked independently below.
  loader.register(()=>({name:'node-test-textures',loadTexture:()=>Promise.resolve(new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1))}));
  return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');}
const meshes=g=>{const found=[];g.scene.traverse(o=>{if(o.isSkinnedMesh)found.push(o);});return found;};
const vertex=(mesh,index)=>{mesh.updateMatrixWorld(true);mesh.skeleton.update();return mesh.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);};
const near=(a,b)=>assert.ok(a.distanceTo(b)<1e-5,`${a.toArray()} vs ${b.toArray()}`);

test('composition preserves every base resource and padded BIN prefix, remapping textures and sparse data',async()=>{
  const padded=readGlb(model({vrm:true,texture:true}));padded.json.buffers[0].byteLength=padded.binData.length+1;
  const base=packGlb(padded.json,Buffer.concat([padded.binData,Buffer.from([123])])),part=model({texture:true,sparse:true}),before=Buffer.from(base),partBefore=Buffer.from(part),result=await compose(base,part),source=readGlb(base),added=readGlb(part),out=readGlb(result.bytes);
  assert.deepEqual(base,before);assert.deepEqual(part,partBefore);assert.deepEqual(out.binData.subarray(0,source.binData.length),source.binData);
  for(const key of ['asset','extensions','extras','scene'])assert.deepEqual(out.json[key],source.json[key]);
  for(const [key,count] of Object.entries(result.manifest.baseCounts))assert.deepEqual((out.json[key]||[]).slice(0,count),source.json[key]||[]);
  assert.deepEqual(out.json.scenes[0].nodes.slice(0,source.json.scenes[0].nodes.length),source.json.scenes[0].nodes);
  assert.equal(result.manifest.binaryLength,source.binData.length);assert.equal(result.manifest.bufferByteLength,source.json.buffers[0].byteLength);
  const material=out.json.materials[source.json.materials.length];assert.equal(material.pbrMetallicRoughness.baseColorTexture.index,1);assert.equal(material.emissiveTexture.index,1);assert.deepEqual(material.pbrMetallicRoughness.baseColorTexture.extensions,added.json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions);
  const imageView=out.json.bufferViews[out.json.images[1].bufferView];assert.deepEqual(out.binData.subarray(imageView.byteOffset,imageView.byteOffset+imageView.byteLength),image);
  assert.deepEqual(out.json.textures[1],{source:1,sampler:1});
  const gltf=await parse(result.bytes),newMesh=meshes(gltf).at(-1);assert.deepEqual(Array.from(newMesh.geometry.attributes.color.array.slice(0,4)),[1,.25,.5,1]);
  assert.equal(result.manifest.validation.errors,0);assert.equal(result.sha256,hash(result.bytes));
});

test('reloaded composed geometry matches live wardrobe at rest and when original bones animate',async()=>{
  const base=model({vrm:true,multi:true}),part=model({offset:2}),result=await compose(base,part),sha=hash(base),inspection=await inspectWardrobePart(part,base,sha);
  const dynamic=await parse(base),partGltf=await parse(part),composed=await parse(result.bytes),runtime=createAvatarWardrobeRuntime({gltf:dynamic,avatarId,sha256:sha});
  runtime.attach(partGltf,{id:partId,avatarId,baseSha256:sha,inspection});
  const liveMesh=meshes(dynamic).at(-1),mergedMesh=meshes(composed).at(-1),baseMeshes=meshes(composed).slice(0,-1),baseBones=new Set(baseMeshes.flatMap(m=>m.skeleton.bones));
  assert.ok(mergedMesh.skeleton.bones.every(bone=>baseBones.has(bone)));
  const counts=g=>{let count=0;g.scene.traverse(o=>{if(o.isBone)count++;});return count;};assert.equal(counts(dynamic),counts(composed));
  for(let i=0;i<8;i++)near(vertex(liveMesh,i),vertex(mergedMesh,i));
  const original=vertex(mergedMesh,1);for(const g of [dynamic,composed]){meshes(g)[0].skeleton.bones[1].rotation.z=.7;g.scene.position.set(3,1,-2);g.scene.scale.setScalar(2);g.scene.updateMatrixWorld(true);}runtime.update();
  for(let i=0;i<8;i++)near(vertex(liveMesh,i),vertex(mergedMesh,i));assert.ok(vertex(mergedMesh,1).distanceTo(original)>.1);
  const partParsed=readGlb(part),composedParsed=readGlb(result.bytes),originalSkin=partParsed.json.skins[0],newSkin=composedParsed.json.skins.at(-1);
  assert.deepEqual(newSkin.joints,inspection.bindings[0].baseJointNodes);assert.equal(newSkin.skeleton,undefined);
  const a=skinAccessor(partParsed.json,partParsed.binData,originalSkin.inverseBindMatrices,{type:'MAT4',types:[5126]}),b=skinAccessor(composedParsed.json,composedParsed.binData,newSkin.inverseBindMatrices,{type:'MAT4',types:[5126]});
  for(let i=0;i<3;i++)for(let k=0;k<16;k++)assert.equal(a.at(i,k),b.at(i,k));runtime.dispose();
});

test('hash pins, duplicate IDs, unsupported extensions and incompatible joint poses are refused',async()=>{
  const base=model({vrm:true}),part=model();await assert.rejects(composeAvatarVrm({baseBytes:base,baseSha256:'0'.repeat(64),parts:[entry(part)]}),/changed since inspection/);
  await assert.rejects(composeAvatarVrm({baseBytes:base,baseSha256:hash(base),parts:[{...entry(part),sha256:'f'.repeat(64)}]}),/changed since inspection/);
  await assert.rejects(composeAvatarVrm({baseBytes:base,baseSha256:hash(base),parts:[entry(part),entry(part)]}),/Duplicate/);
  await assert.rejects(compose(rewrite(base,j=>{j.nodes[0].extensions={EXT_unknown:{node:1}};}),part),/unsupported embedded extension/);
  await assert.rejects(compose(base,rewrite(part,j=>{j.extensionsUsed=['KHR_draco_mesh_compression'];})),/Unsupported part extension/);
  await assert.rejects(compose(base,rewrite(part,j=>{j.extensionsUsed=['KHR_texture_transform'];j.nodes[0].extensions={KHR_texture_transform:{offset:[0,0]}};})),/outside a supported material|failed glTF validation/);
  await assert.rejects(compose(base,rewrite(part,j=>{j.nodes[2].translation=[1,0,0];})),/rest pose differs/);
});

test('two parts remap independently and share only the original joints after reload',async()=>{
  const base=model({vrm:true,texture:true}),part=model({texture:true}),first=entry(part),second={...entry(part),id:'part_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},result=await composeAvatarVrm({baseBytes:base,baseSha256:hash(base),parts:[first,second]}),parsed=readGlb(result.bytes);
  assert.equal(result.manifest.parts.length,2);assert.deepEqual(parsed.json.textures.map(t=>t.source),[0,1,2]);assert.deepEqual(parsed.json.textures.map(t=>t.sampler),[0,1,2]);
  assert.deepEqual(result.manifest.parts.map(p=>p.nodeIndices.length),[1,1]);
  const gltf=await parse(result.bytes),loaded=meshes(gltf);assert.equal(loaded.length,3);
  for(const mesh of loaded.slice(1))for(let i=0;i<mesh.skeleton.bones.length;i++)assert.equal(mesh.skeleton.bones[i],loaded[0].skeleton.bones[i]);
  assert.equal(result.manifest.parts[1].binaryOffset,result.manifest.parts[0].binaryOffset+result.manifest.parts[0].binaryLength);
});

test('aggregate budgets reject individually valid parts before producing an oversized composition',async()=>{
  await assert.rejects(compose(model({vrm:true,materials:32}),model()),/materials budget/);
  const base=model({vrm:true}),part=model();await assert.rejects(composeAvatarVrm({baseBytes:base,baseSha256:hash(base),parts:Array.from({length:9},()=>entry(part))}),/up to eight/);
  const result=await compose(base);assert.deepEqual(readGlb(result.bytes).json.extensions,readGlb(base).json.extensions);assert.equal(result.manifest.parts.length,0);
});

test('aggregate byte refusal occurs before copying any base or part Buffer',async()=>{
  const base=model({vrm:true}),bulk=Buffer.alloc(24*1024*1024),parts=Array.from({length:3},(_,i)=>({id:`part_${String(i).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,bytes:bulk,sha256:'a'.repeat(64)}));
  const original=Buffer.from;let copies=0;
  Buffer.from=function(value,...args){if(value===base||value===bulk){copies++;throw Error('Copied an oversized selection before checking its budget');}return original.call(Buffer,value,...args);};
  try{await assert.rejects(composeAvatarVrm({baseBytes:base,baseSha256:hash(base),parts}),error=>error.status===413&&/input total exceeds/.test(error.message));assert.equal(copies,0);}
  finally{Buffer.from=original;}
});

test('optional real sample VRM and fitted shirt roundtrip preserves authored managers and actual deformation',{
  skip:!process.env.AIPLAY_COMPOSITION_BASE||!process.env.AIPLAY_COMPOSITION_PART?'Set AIPLAY_COMPOSITION_BASE and AIPLAY_COMPOSITION_PART for local sample acceptance.':false,
},async()=>{
  const base=await readFile(process.env.AIPLAY_COMPOSITION_BASE),part=await readFile(process.env.AIPLAY_COMPOSITION_PART),result=await composeAvatarVrm({baseBytes:base,baseSha256:hash(base),parts:[{...entry(part),name:'Sample shirt fitted locally',source:'Derived fitting fixture from official VRM1_Constraint_Twist_Sample shirt.',license:'Original VRM Public License 1.0 and embedded usage settings; copyright 2022 pixiv Inc.'}]}),source=readGlb(base),out=readGlb(result.bytes);
  assert.deepEqual(out.json.extensions,source.json.extensions);assert.deepEqual(out.binData.subarray(0,source.binData.length),source.binData);
  const gltf=await parse(result.bytes,true),vrm=gltf.userData.vrm;assert.ok(vrm);assert.ok(vrm.expressionManager);assert.ok(vrm.springBoneManager);assert.ok(vrm.nodeConstraintManager);
  const node=result.manifest.parts[0].nodeIndices[0];let mesh;gltf.scene.traverse(o=>{if(o.isSkinnedMesh&&gltf.parser.associations.get(o)?.nodes===node)mesh=o;});assert.ok(mesh);
  vrm.update(0);gltf.scene.updateMatrixWorld(true);
  const original=Array.from({length:mesh.geometry.attributes.position.count},(_,i)=>vertex(mesh,i));
  const shoulder=vrm.humanoid.getNormalizedBoneNode('leftUpperArm');assert.ok(shoulder);shoulder.rotation.z=.55;vrm.expressionManager.setValue('happy',.6);vrm.update(1/60);gltf.scene.updateMatrixWorld(true);mesh.skeleton.update();
  const distances=original.map((position,index)=>position.distanceTo(vertex(mesh,index)));assert.ok(Math.max(...distances)>.03);assert.ok(distances.filter(distance=>distance>.001).length>20);
  assert.equal(vrm.expressionManager.getValue('happy'),.6);let changedMorphs=0;gltf.scene.traverse(object=>{changedMorphs+=(object.morphTargetInfluences||[]).filter(value=>value>0).length;});assert.ok(changedMorphs>0);
  const evidence={sha256:result.sha256,bytes:result.bytes.length,manifest:result.manifest,vertices:original.length,movedOver1mm:distances.filter(d=>d>.001).length,maxMovement:Math.max(...distances),posedBone:'normalized:leftUpperArm',radians:.55,changedMorphs,vrmManagers:{expressions:true,springs:true,constraints:true},baseNodes:source.json.nodes.length,composedNodes:out.json.nodes.length};
  if(process.env.AIPLAY_COMPOSITION_OUTPUT){await writeFile(process.env.AIPLAY_COMPOSITION_OUTPUT,result.bytes);await writeFile(process.env.AIPLAY_COMPOSITION_OUTPUT+'.json',JSON.stringify(evidence,null,2));}
  console.log('COMPOSITION_REAL_EVIDENCE',JSON.stringify(evidence));
});
