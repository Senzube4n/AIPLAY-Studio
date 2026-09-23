import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVrmDocument} from './vrm-profile.js';
import {inspectAvatar} from './avatar.js';
import {glbDoc,packGlb} from './fixtures.js';
const names=['hips','spine','head','leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot'];
const doc=()=>({nodes:names.map(name=>({name})),extensions:{VRMC_vrm:{specVersion:'1.0',humanoid:{humanBones:Object.fromEntries(names.map((n,node)=>[n,{node}]))},expressions:{preset:{happy:{}}}}}});
test('VRM profile reports authored capabilities without claiming world admission',()=>{const r=inspectVrmDocument(doc());assert.equal(r.worldReady,false);assert.equal(r.expressions[0].name,'happy');assert.equal(r.spring.chains,0);});
test('VRM version, humanoid identity, missing targets and cyclic constraints fail before runtime loading',()=>{
 const d=doc();d.extensions.VRMC_vrm.specVersion='0.0';assert.throws(()=>inspectVrmDocument(d),/1.0/);
 const duplicate=doc();duplicate.extensions.VRMC_vrm.humanoid.humanBones.head.node=0;assert.throws(()=>inspectVrmDocument(duplicate),/distinct/);
 const missing=doc();missing.extensions.VRMC_vrm.expressions.preset.happy.morphTargetBinds=[{node:2,index:99,weight:1}];assert.throws(()=>inspectVrmDocument(missing),/missing morph/);
 const cycle=doc();cycle.nodes[0].extensions={VRMC_node_constraint:{specVersion:'1.0',constraint:{rotation:{source:1}}}};cycle.nodes[1].extensions={VRMC_node_constraint:{specVersion:'1.0',constraint:{rotation:{source:0}}}};assert.throws(()=>inspectVrmDocument(cycle),/Cyclic/);
});
test('spring references and nonfinite dynamics are refused',()=>{
 for(const joint of [{node:99},{node:2,stiffness:Infinity},{node:2,dragForce:2},{node:2,gravityDir:[0,NaN,0]}]){const d=doc();d.extensions.VRMC_springBone={specVersion:'1.0',springs:[{joints:[joint]}]};assert.throws(()=>inspectVrmDocument(d),/VRM|drag|stiffness/);}
});
test('VRM extensions do not silently enter the existing strict world GLB profile',async()=>{
 const d=glbDoc({skinned:true});d.extensionsUsed=['VRMC_vrm'];d.extensions=doc().extensions;
 await assert.rejects(inspectAvatar(packGlb(d)),/unsupported extensions/);
 await assert.rejects(inspectAvatar(packGlb(d),'unbounded'),/Unknown avatar profile/);
});

const expressionDoc=()=>{const d=doc();d.materials=[{}];return d;};
const refuses=(d,pattern)=>assert.throws(()=>inspectVrmDocument(d),e=>e.status===422&&pattern.test(e.message));

test('material color binds require a typed finite RGBA target before the loader reads it',()=>{
 for(const targetValue of [undefined,null,[],[1,1,1],[1,1,1,1,1],['1',0,0,1],[NaN,0,0,1],[0,Infinity,0,1],{0:1,1:1,2:1,3:1,length:4}]){
  const d=expressionDoc();d.extensions.VRMC_vrm.expressions.custom={tint:{materialColorBinds:[{material:0,type:'color',targetValue}]}};
  refuses(d,/material target value/);
 }
 for(const type of [undefined,null,'colour',{},4]){
  const d=expressionDoc();d.extensions.VRMC_vrm.expressions.preset.happy.materialColorBinds=[{material:0,type,targetValue:[1,1,1,1]}];
  refuses(d,/material color type/);
 }
 const valid=expressionDoc();valid.extensions.VRMC_vrm.expressions.preset.happy.materialColorBinds=[{material:0,type:'emissionColor',targetValue:[4,2,1,1]}];
 assert.equal(inspectVrmDocument(valid).expressions[0].name,'happy');
});

test('texture transforms permit defaults but refuse short, nonnumeric and nonfinite vectors',()=>{
 for(const field of ['offset','scale'])for(const value of [null,[],[1],[1,2,3],['1',0],[0,NaN],[Infinity,0],{0:0,1:0,length:2}]){
  const d=expressionDoc();d.extensions.VRMC_vrm.expressions.preset.happy.textureTransformBinds=[{material:0,[field]:value}];
  refuses(d,/texture offset|texture scale/);
 }
 const valid=expressionDoc();valid.extensions.VRMC_vrm.expressions.preset.happy.textureTransformBinds=[{material:0},{material:0,scale:[2,.5],offset:[-.1,.2]}];
 assert.doesNotThrow(()=>inspectVrmDocument(valid));
});

test('malformed expression bind collections and records fail with an admission error',()=>{
 for(const field of ['morphTargetBinds','materialColorBinds','textureTransformBinds'])for(const value of [null,{},'bad',[null],[false]]){
  const d=expressionDoc();d.extensions.VRMC_vrm.expressions.preset.happy[field]=value;
  refuses(d,/VRM/);
 }
 const binary=doc();binary.extensions.VRMC_vrm.expressions.preset.happy.isBinary='false';refuses(binary,/binary/);
 const override=doc();override.extensions.VRMC_vrm.expressions.preset.happy.overrideMouth='invalid';refuses(override,/override/);
});

test('collider offsets and capsule tails must have exactly three finite numeric coordinates',()=>{
 for(const kind of ['sphere','capsule'])for(const field of kind==='sphere'?['offset']:['offset','tail'])for(const value of [null,[],[0,0],[0,0,0,0],[0,'0',0],[0,NaN,0],[0,Infinity,0],new Array(3)]){
  const d=doc();d.extensions.VRMC_springBone={specVersion:'1.0',colliders:[{node:2,shape:{[kind]:{[field]:value}}}]};
  refuses(d,/collider offset|collider tail/);
 }
 for(const shape of [null,{},[],{sphere:null},{sphere:{},capsule:{}}]){
  const d=doc();d.extensions.VRMC_springBone={specVersion:'1.0',colliders:[{node:2,shape}]};refuses(d,/collider shape/);
 }
 const valid=doc();valid.extensions.VRMC_springBone={specVersion:'1.0',colliders:[{node:2,shape:{sphere:{}}},{node:3,shape:{capsule:{offset:[0,0,0],tail:[0,1,0],radius:.1}}}]};
 assert.equal(inspectVrmDocument(valid).spring.colliders,2);
});

test('constraint axes only accept the enums implemented by the pinned VRM runtime',()=>{
 for(const [kind,field,allowed] of [['roll','rollAxis',['X','Y','Z']],['aim','aimAxis',['PositiveX','NegativeX','PositiveY','NegativeY','PositiveZ','NegativeZ']]]){
  for(const value of [null,0,{},'x','up']){
   const d=doc();d.nodes[0].extensions={VRMC_node_constraint:{specVersion:'1.0',constraint:{[kind]:{source:1,[field]:value}}}};
   refuses(d,/axis/);
  }
  for(const value of [undefined,...allowed]){
   const d=doc();d.nodes[0].extensions={VRMC_node_constraint:{specVersion:'1.0',constraint:{[kind]:{source:1,[field]:value}}}};
   assert.doesNotThrow(()=>inspectVrmDocument(d));
  }
 }
 for(const value of [null,[],false]){
  const d=doc();d.nodes[0].extensions={VRMC_node_constraint:{specVersion:'1.0',constraint:{rotation:value}}};refuses(d,/constraint/);
 }
});
