import test from 'node:test';
import assert from 'node:assert/strict';
import {glbDoc,packGlb,fixtureBin} from './fixtures.js';
import {previewWorldAvatarOutfit,WORLD_OUTFIT_PREVIEW_LIMITS as limits} from './avatar-world-preflight.js';

function model(edit=()=>{}){
  const doc=glbDoc({skinned:true}),binary=Buffer.from(fixtureBin(doc));
  doc.materials=[{name:'Body'}];doc.meshes[0].primitives[0].material=0;
  edit(doc,binary);
  return packGlb(doc,binary);
}
const part={sha256:'a'.repeat(64),name:'Coat',slot:'outfit',source:'Test author',license:'CC0'};
const preview=(bytes,extra={})=>previewWorldAvatarOutfit({baseSha256:limits.baseSha256,modelBytes:bytes,packageBytes:bytes.length*2,parts:[part],...extra});

test('World preview marks an in-budget model only as a candidate',()=>{
  const result=preview(model());
  assert.deepEqual(result,{candidate:true,reasons:[]});
});

test('World preview explains unsupported base, empty outfit and upload limits',()=>{
  const bytes=model(),result=preview(bytes,{baseSha256:'0'.repeat(64),parts:[],packageBytes:limits.packageBytes+1});
  assert.equal(result.candidate,false);
  assert.equal(result.reasons.length,3);
  assert.match(result.reasons.join(' '),/sample VRM/);
  assert.match(result.reasons.join(' '),/at least one/);
  assert.match(result.reasons.join(' '),/24 MiB/);
});

test('World preview catches tighter mesh and triangle budgets',()=>{
  const bytes=model(doc=>{doc.meshes=Array.from({length:limits.meshes+1},()=>structuredClone(doc.meshes[0]));doc.accessors[4].count=(limits.triangles+1)*3;});
  const result=preview(bytes);
  assert.equal(result.candidate,false);
  assert.match(result.reasons.join(' '),/meshes limit/);
  assert.match(result.reasons.join(' '),/triangle limit/);
});

test('World preview catches 4K textures that local Studio permits',()=>{
  const bytes=model((doc,binary)=>{
    const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(4096,16);png.writeUInt32BE(512,20);
    png.copy(binary,0);doc.images=[{bufferView:0,mimeType:'image/png'}];doc.bufferViews[0].byteLength=png.length;
  });
  const result=preview(bytes);
  assert.equal(result.candidate,false);
  assert.match(result.reasons.join(' '),/texture side limit/);
});

test('World preview flags incomplete declared part credits',()=>{
  const result=preview(model(),{parts:[{...part,license:''}]});
  assert.equal(result.candidate,false);
  assert.match(result.reasons.join(' '),/complete credits/);
});
