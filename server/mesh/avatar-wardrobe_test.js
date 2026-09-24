import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createAvatarWardrobe,inspectWardrobePart,createAvatarWardrobeRoutes} from './avatar-wardrobe.js';
import {avatarWardrobeTools} from '../mcp-avatar-wardrobe.js';
import {glbDoc,fixtureBin,packGlb} from './fixtures.js';
import {append,read as readLedger} from '../provenance.js';
import {Readable} from 'node:stream';

const ID='av_12345678-1234-4321-8765-123456789abc',LOOK='look_12345678-1234-4321-8765-123456789abc';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function model(edit=()=>{}){const j=glbDoc({skinned:true});j.materials=[{pbrMetallicRoughness:{baseColorFactor:[.4,.5,.6,1]}}];j.meshes[0].primitives[0].material=0;const bin=Buffer.from(fixtureBin(j));edit(j,bin);return packGlb(j,bin);}
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'wardrobe-')),ledger=path.join(directory,'ledger');t.after(()=>rm(directory,{recursive:true,force:true}));let bytes=model();const events=[];
  const inspectAsset=async id=>{assert.equal(id,ID);return {row:{id,inspection:{sha256:hash(bytes)}},bytes};};
  const service=createAvatarWardrobe({directory,inspectAsset,inspectLook:async(id,look)=>{assert.equal(id,ID);assert.equal(look,LOOK);},record:async event=>{await append({dir:ledger},event);events.push(event);}});
  return {directory,ledger,events,service,inspectAsset,bytes,sha256:hash(bytes),replace(value){bytes=value;},import:(extra={})=>service.importPart({id:ID,sha256:hash(bytes),name:'Fitted coat',slot:'outfit',source:'Local test fixture',license:'CC0',bytes:model(),...extra},'user:wardrobe-test')};}

test('real weighted GLB import, reload, named/default selections and deletion use pinned identity and valid provenance',async t=>{
  const f=await fixture(t),part=await f.import();assert.equal(part.inspection.triangles,12);assert.equal(part.sha256,hash(model()));assert.match(part.files.glb,/^\/api\/avatars\/wardrobe\/file\//);
  assert.equal((await f.service.inventory({id:ID})).joints.length,3);assert.equal((await f.service.list({id:ID})).parts.length,1);
  assert.deepEqual((await f.service.selection({id:ID})).part_ids,[]);
  const select={id:ID,sha256:f.sha256,expected_revision:0,part_ids:[part.id]};
  const selected=await f.service.select(select,'user:wardrobe-test');assert.equal(selected.revision,1);assert.equal(selected.parts[0].id,part.id);
  const named=await f.service.select({...select,look_id:LOOK},'user:wardrobe-test');assert.equal(named.look_id,LOOK);
  await assert.rejects(f.service.remove({id:ID,sha256:f.sha256,part_id:part.id}),/saved outfits/);
  await f.service.select({...select,expected_revision:1,part_ids:[]});await f.service.select({...select,look_id:LOOK,expected_revision:1,part_ids:[]});
  assert.deepEqual((await f.service.file({id:ID,part_id:part.id})).bytes,model());
  await f.service.remove({id:ID,sha256:f.sha256,part_id:part.id});assert.equal((await f.service.list({id:ID})).parts.length,0);
  assert.ok(f.events.every(e=>['import','preset_apply','edit'].includes(e.type)));assert.equal(f.events[0].actor,'user:wardrobe-test');
  assert.ok((await readLedger({dir:f.ledger})).events.length>0);
});

test('nonidentity part placement accepts recomputed inverse binds and rejects incorrect binds',async t=>{
  const f=await fixture(t),translated=model((j,bin)=>{j.nodes[0].translation=[2,0,0];for(let i=0;i<3;i++)bin.writeFloatLE(2,96+i*64+48);});
  const report=await inspectWardrobePart(translated,f.bytes,f.sha256);assert.equal(report.bindings[0].meshMatrix[12],2);
  await assert.rejects(inspectWardrobePart(model(j=>{j.nodes[0].translation=[2,0,0];}),f.bytes,f.sha256),/inverse bind/);
});

test('mismatched names, ancestry, rest matrices, provenance and independent state are rejected',async t=>{
  const f=await fixture(t);
  for(const edit of [j=>{j.nodes[2].name='other';},j=>{j.nodes[2].translation=[0,1,0];},j=>{j.nodes[1].children=[2,3];delete j.nodes[2].children;},j=>{j.extras={aiplayWeightTransfer:{referenceSha256:'f'.repeat(64)}};},j=>{j.extras={aiplayWeightTransfer:{baseJointNodes:[1,3,2]}};},j=>{j.extensionsUsed=['VRMC_vrm'];j.extensions={VRMC_vrm:{}};},j=>{j.buffers[0].uri='https://example.test/body.bin';}])await assert.rejects(inspectWardrobePart(model(edit),f.bytes,f.sha256));
  assert.equal(f.events.length,0);
});

test('multiple base skins bind against their shared original raw joint nodes',async t=>{
  const f=await fixture(t),base=model(j=>{j.skins.push({...j.skins[0],joints:[1,2,3]});j.nodes.push({name:'second mesh',mesh:0,skin:1});j.scenes[0].nodes.push(4);});
  const report=await inspectWardrobePart(model(),base,hash(base));assert.deepEqual(report.bindings[0].baseJointNodes,[1,2,3]);
});

test('stale concurrent selections, duplicate slots and caller mutation do not overwrite saved state',async t=>{
  const f=await fixture(t),a=await f.import(),b=await f.import({name:'Other coat'}),input={id:ID,sha256:f.sha256,expected_revision:0,part_ids:[a.id]};
  const save=f.service.select(input);input.part_ids.push(b.id);await save;
  const attempts=await Promise.allSettled([f.service.select({...input,part_ids:[],expected_revision:1}),f.service.select({...input,part_ids:[a.id],expected_revision:1})]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  const current=await f.service.selection({id:ID});await assert.rejects(f.service.select({...input,expected_revision:current.revision}),/one part per slot/);
  const returned=await f.service.list({id:ID});returned.parts.find(p=>p.id===a.id).name='Changed';assert.equal((await f.service.list({id:ID})).parts.find(p=>p.id===a.id).name,'Fitted coat');
});

test('source/part tampering and traversal fail before a selection or deletion can mutate storage',async t=>{
  const f=await fixture(t),part=await f.import(),file=path.join(f.directory,ID,`${part.id}.glb`),bytes=await readFile(file);bytes[bytes.length-1]^=1;await writeFile(file,bytes);
  await assert.rejects(f.service.file({id:ID,part_id:part.id}),/bytes changed/);
  await assert.rejects(f.service.select({id:ID,sha256:f.sha256,expected_revision:0,part_ids:[part.id]}),/bytes changed/);
  for(const bad of ['../escape','part_../../escape',''])await assert.rejects(f.service.file({id:ID,part_id:bad}),/Invalid part/);
  f.replace(model(j=>{j.asset.generator='changed';}));await assert.rejects(f.service.list({id:ID}),/identity changed/);
  await assert.rejects(f.service.remove({id:ID,sha256:f.sha256,part_id:part.id}),/Base avatar changed/);
});

test('MCP payloads use the real route and provenance writer with optional fields omitted',async t=>{
  const f=await fixture(t),handler=createAvatarWardrobeRoutes({directory:path.join(f.directory,'route'),inspectAsset:f.inspectAsset,inspectLook:async()=>{},json:(res,status,value)=>{res.status=status;res.value=value;},provenance:{append:(_,event)=>append({dir:f.ledger},event),actorFrom:()=> 'user:mcp-test'}});
  const api=async(method,url,body)=>{const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={'content-type':'application/json'};const res={};assert.equal(await handler(req,res,new URL(url,'http://127.0.0.1')),true);return res.value;};
  const tools=avatarWardrobeTools(api),run=(name,args)=>tools.find(tool=>tool.name===name).run(args);
  const inventory=await run('avatar_wardrobe_inventory',{id:ID});assert.equal(inventory.sha256,f.sha256);
  const imported=await run('avatar_wardrobe_import',{id:ID,sha256:f.sha256,name:'Coat',slot:'outfit',source:'Local',license:'CC0',data_base64:model().toString('base64')});
  assert.equal((await run('avatar_wardrobe_list',{id:ID})).parts[0].id,imported.id);
  await run('avatar_wardrobe_select',{id:ID,sha256:f.sha256,expected_revision:0,part_ids:[imported.id]});
  const selected=await run('avatar_wardrobe_selection',{id:ID});assert.deepEqual(selected.part_ids,[imported.id]);assert.equal(selected.look_id,null);
  await run('avatar_wardrobe_select',{id:ID,sha256:f.sha256,expected_revision:1,part_ids:[]});assert.deepEqual(await run('avatar_wardrobe_delete',{id:ID,sha256:f.sha256,part_id:imported.id}),{deleted:imported.id});
});
