import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createAvatarHandoff,createAvatarHandoffRoutes} from './avatar-handoff.js';
import {avatarHandoffTools} from '../mcp-avatar-handoff.js';
import {outfitExportRequest,mountAvatarHandoff} from '../../web/avatar-handoff.js';
const ID='av_12345678-1234-4321-8765-123456789abc',LOOK='look_12345678-1234-4321-8765-123456789abc';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,compose) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'outfit-handoff-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const bytes=Buffer.from('the immutable base'),partBytes=Buffer.from('fitted part');
  const row={id:ID,name:'Base',inspection:{profile:'vrm',sha256:hash(bytes)}};
  let look={id:LOOK,avatarId:ID,sha256:hash(bytes),name:'Coat',revision:2,settings:{hidden_nodes:[],material_colors:{},expressions:{},spring_enabled:true}};
  let selected={id:ID,sha256:hash(bytes),look_id:LOOK,revision:3,part_ids:['part_test']};
  const part={row:{id:'part_test',name:'Fitted coat',slot:'outfit',source:'Test geometry',license:'CC0',sha256:hash(partBytes),inspection:{bytes:partBytes.length}},bytes:partBytes};
  selected.parts=[structuredClone(part.row)];
  const events=[],options={directory,inspectAsset:async id=>{assert.equal(id,ID);return {row,bytes};},appearance:{get:async()=>structuredClone(look)},
    wardrobe:{selection:async()=>structuredClone(selected),file:async()=>structuredClone(part)},record:async e=>events.push(e),
    compose:compose|| (async args=>{assert.equal(args.parts.length,1);const out=Buffer.concat([args.baseBytes,Buffer.from(args.parts[0].bytes)]);return {bytes:out,sha256:hash(out),manifest:{review:'needs_visual_review'}};})};
  // Buffers must stay Buffers at the real service boundary.
  options.wardrobe.file=async()=>({row:structuredClone(part.row),bytes:Buffer.from(part.bytes)});
  return {options,service:createAvatarHandoff(options),events,directory,row,get look(){return look;},get selected(){return selected;},
    request:{id:ID,sha256:hash(bytes),look_id:LOOK,expected_look_revision:2,expected_wardrobe_revision:3},
    changeLook(){look={...look,revision:3};},changePart(){part.row.license='Changed provenance';}};
}
test('saved outfit export packages actual parts, look settings and immutable downloads without changing active state',async t=>{
  const f=await fixture(t),before=JSON.stringify([f.look,f.selected]);
  const a=await f.service.prepare(f.request,'agent:export-test'),b=await f.service.prepare(f.request);
  assert.equal(a.id,b.id);assert.equal(a.worldCandidate,false);assert.equal(f.events[0].actor,'agent:export-test');
  const bundle=JSON.parse((await f.service.file(a.id,'outfit.aiplay-avatar.json')).bytes);
  assert.equal(bundle.schema,'aiplay.avatar-outfit.v1');assert.equal(bundle.parts[0].license,'CC0');assert.deepEqual(bundle.appearance.settings,f.look.settings);
  assert.equal(hash(Buffer.from(bundle.data_base64,'base64')),bundle.sha256);
  assert.equal(hash((await f.service.file(a.id,'outfit.vrm')).bytes),bundle.sha256);
  assert.equal(JSON.stringify([f.look,f.selected]),before);
});
test('stale pins and changed state during composition refuse export before writing a snapshot',async t=>{
  let f;f=await fixture(t,async args=>{f.changeLook();return {bytes:args.baseBytes,sha256:hash(args.baseBytes),manifest:{}};});
  await assert.rejects(f.service.prepare({...f.request,sha256:'0'.repeat(64)}),/Avatar changed/);
  await assert.rejects(f.service.prepare({...f.request,expected_wardrobe_revision:2}),/changed/);
  await assert.rejects(f.service.prepare(f.request),/changed/);assert.equal(f.events.length,0);
});
test('provenance changes during composition cannot silently enter an export',async t=>{
  let f;f=await fixture(t,async args=>{f.changePart();return {bytes:args.baseBytes,sha256:hash(args.baseBytes),manifest:{}};});
  await assert.rejects(f.service.prepare(f.request),/part changed/);
});
test('download corruption, traversal and unsupported snapshot fields fail closed',async t=>{
  const f=await fixture(t),out=await f.service.prepare(f.request);
  await writeFile(path.join(f.directory,out.id,'outfit.vrm'),'changed');
  await assert.rejects(f.service.file(out.id,'outfit.vrm'),/bytes changed/);
  await assert.rejects(f.service.prepare(f.request),/bytes changed/);
  await assert.rejects(f.service.get('../escape'),/Invalid/);
  await assert.rejects(f.service.file(out.id,'../manifest.json'),/Unknown/);
  await assert.rejects(f.service.prepare({...f.request,actor:'user:spoof'}),/Unsupported/);
});

test('reusing an existing export revalidates its package as well as its VRM',async t=>{
  const f=await fixture(t),out=await f.service.prepare(f.request);
  await writeFile(path.join(f.directory,out.id,'outfit.aiplay-avatar.json'),'changed package');
  await assert.rejects(f.service.prepare(f.request),/bytes changed/);
});

test('oversized saved selections are refused before any part is loaded or composed',async t=>{
  const f=await fixture(t);let reads=0,compositions=0;
  const parts=Array.from({length:3},(_,i)=>({id:`part_${i}`,inspection:{bytes:24*1024*1024}}));
  f.options.wardrobe.selection=async()=>({...f.selected,part_ids:parts.map(p=>p.id),parts});
  f.options.wardrobe.file=async()=>{reads++;throw Error('No part should have been loaded');};
  f.options.compose=async()=>{compositions++;throw Error('No composition should have run');};
  await assert.rejects(createAvatarHandoff(f.options).prepare(f.request),error=>error.status===413&&/total exceeds/.test(error.message));
  assert.equal(reads,0);assert.equal(compositions,0);
});

test('underreported part byte sizes stop loading immediately before composition',async t=>{
  const f=await fixture(t);let reads=0,compositions=0;
  const parts=[{id:'part_first',inspection:{bytes:1}},{id:'part_second',inspection:{bytes:1}}];
  f.options.wardrobe.selection=async()=>({...f.selected,part_ids:parts.map(p=>p.id),parts});
  f.options.wardrobe.file=async()=>{reads++;return {row:{id:'part_first'},bytes:Buffer.from('longer')};};
  f.options.compose=async()=>{compositions++;};
  await assert.rejects(createAvatarHandoff(f.options).prepare(f.request),/changed size/);
  assert.equal(reads,1);assert.equal(compositions,0);
});
test('MCP calls execute actual route handlers with the same revisions and actor',async t=>{
  const f=await fixture(t),route=createAvatarHandoffRoutes({...f.options,json:(res,status,value)=>{res.status=status;res.value=value;},provenance:{actorFrom:()=> 'agent:mcp-outfit',append:async(_,e)=>f.events.push(e)}});
  const api=async(method,url,body)=>{const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={'content-type':'application/json'};const res={};assert.equal(await route(req,res,new URL(url,'http://127.0.0.1')),true);return res.value;};
  const tools=avatarHandoffTools(api),out=await tools.find(t=>t.name==='avatar_outfit_export').run(f.request);
  assert.equal((await tools.find(t=>t.name==='avatar_outfit_get').run({export_id:out.id})).sha256,out.sha256);assert.equal(f.events[0].actor,'agent:mcp-outfit');
  const req=Readable.from([Buffer.alloc(4097)]);req.method='POST';req.headers={'content-type':'application/json'};
  await assert.rejects(route(req,{},new URL('http://127.0.0.1/api/avatars/handoff')),/too large/);
});
test('UI exports saved state only and rejects unsaved or mismatched contexts',async t=>{
  const f=await fixture(t),a={look:f.look,dirty:false,busy:false},w={selection:f.selected,dirty:false,busy:false};
  assert.deepEqual(outfitExportRequest(f.row,a,w),{action:'prepare',...f.request});
  assert.throws(()=>outfitExportRequest(f.row,{...a,dirty:true},w),/Save the look/);
  assert.throws(()=>outfitExportRequest(f.row,a,{...w,dirty:true}),/Save the outfit/);
  assert.throws(()=>outfitExportRequest(f.row,a,{...w,selection:{...f.selected,look_id:null}}),/load/);
  assert.throws(()=>outfitExportRequest(f.row,a,{...w,busy:true}),/Wait/);
});
test('late export completion cannot replace another avatar download links',async t=>{
  const f=await fixture(t);let resolve;
  const nodes=Object.fromEntries(['outfit-export','outfit-note','outfit-downloads'].map(id=>[id,{children:[],replaceChildren(){this.children=[];},append(v){this.children.push(v);}}]));
  const mounted=mountAvatarHandoff({row:f.row,getContext:()=>({appearance:{look:f.look},wardrobe:{selection:f.selected}}),
    documentRef:{getElementById:id=>nodes[id],createElement:()=>({})},api:()=>new Promise(r=>{resolve=r;})});
  const pending=nodes['outfit-export'].onclick();mounted.dispose();resolve({files:{}});await pending;
  assert.deepEqual(nodes['outfit-downloads'].children,[]);
});

test('disposing the owning panel clears already prepared links, note and click handler',async t=>{
  const f=await fixture(t),nodes=Object.fromEntries(['outfit-export','outfit-note','outfit-downloads'].map(id=>[id,{children:[],replaceChildren(){this.children=[];},append(v){this.children.push(v);}}]));
  const mounted=mountAvatarHandoff({row:f.row,getContext:()=>({appearance:{look:f.look},wardrobe:{selection:f.selected}}),documentRef:{getElementById:id=>nodes[id],createElement:()=>({})},api:async()=>({worldCandidate:true,files:{bundle:`/api/avatars/handoff/outfit_${'a'.repeat(64)}/outfit.aiplay-avatar.json`,vrm:`/api/avatars/handoff/outfit_${'a'.repeat(64)}/outfit.vrm`}})});
  await nodes['outfit-export'].onclick();assert.equal(nodes['outfit-downloads'].children.length,2);
  mounted.dispose();assert.equal(nodes['outfit-downloads'].children.length,0);assert.equal(nodes['outfit-export'].disabled,true);assert.equal(nodes['outfit-export'].onclick,null);assert.equal(nodes['outfit-note'].hidden,true);
});

test('disposing an old mount cannot clear controls or links owned by its replacement',async t=>{
  const f=await fixture(t),nodes=Object.fromEntries(['outfit-export','outfit-note','outfit-downloads'].map(id=>[id,{children:[],replaceChildren(){this.children=[];},append(v){this.children.push(v);}}]));
  const options={row:f.row,getContext:()=>({appearance:{look:f.look},wardrobe:{selection:f.selected}}),documentRef:{getElementById:id=>nodes[id],createElement:()=>({})}};
  const old=mountAvatarHandoff(options),replacement=mountAvatarHandoff(options),handler=nodes['outfit-export'].onclick;
  nodes['outfit-downloads'].append({textContent:'New avatar download'});nodes['outfit-note'].hidden=false;nodes['outfit-note'].textContent='New avatar ready';
  old.dispose();assert.equal(nodes['outfit-export'].onclick,handler);assert.equal(nodes['outfit-export'].disabled,false);assert.equal(nodes['outfit-downloads'].children.length,1);assert.equal(nodes['outfit-note'].textContent,'New avatar ready');replacement.dispose();
});
