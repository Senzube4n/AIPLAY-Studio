import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {glbDoc,packGlb} from './fixtures.js';
import {createAvatarFittingService,createAvatarFittingRoutes,FITTING_DEFAULTS} from './avatar-fitting.js';
import {avatarFittingTools} from '../mcp-avatar-fitting.js';

const temp=await mkdtemp(path.join(os.tmpdir(),'studio-fitting-')),digest=b=>createHash('sha256').update(b).digest('hex');
const base=packGlb(glbDoc({skinned:true})),part=packGlb(glbDoc()),avatarId='av_'+randomUUID(),signature='c'.repeat(64),events=[];
let source=base,tests=0,server;
const test=async(name,fn)=>{await fn();console.log('ok '+name);tests++;};
async function fakeRun(py,args){
  if(args.includes('--inspect'))return {ok:true,mode:'inspect',skeleton:signature,joints:3,reference_surfaces:[{mesh_node:0,primitive:0,name:'Body'}]};
  const value=key=>args[args.indexOf(key)+1],options=JSON.parse(value('--options'));
  const doc=glbDoc({skinned:true});doc.extras={aiplayAttachmentFit:{sourceSha256:digest(base),targetSha256:digest(part)},aiplayWeightTransfer:{referenceSha256:digest(base)}};
  await writeFile(value('--output'),packGlb(doc));
  return {ok:true,mode:'fit-and-bind',output:value('--output'),skeleton:signature,sourceSha256:digest(base),targetSha256:digest(part),referenceMeshNode:0,referencePrimitive:0,vertices:8,joints:3,
    fit:{requiresVisualReview:true,scale:1,maxDisplacement:.006,clearance:options.clearance}};
}
const make=(name,overrides={})=>createAvatarFittingService({directory:path.join(temp,name),inspectAsset:async id=>{assert.equal(id,avatarId);return {row:{id},bytes:source};},python:process.execPath,run:fakeRun,record:async event=>events.push(event),...overrides});
async function complete(s,id){const deadline=Date.now()+5000;while(Date.now()<deadline){const r=await s.get(id);if(r.state!=='running')return r;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Fitting did not settle');}
try{
  const s=make('jobs');let inspected,row;
  await test('selected avatar and uploaded part are hashed into immutable fitting inputs',async()=>{
    inspected=await s.inspect({avatar_id:avatarId,target_data_base64:part.toString('base64')});assert.equal(inspected.source_sha256,digest(base));assert.equal(inspected.target_sha256,digest(part));assert.match(inspected.target_id,/^ft_/);assert.equal(inspected.reference_surfaces[0].name,'Body');
  });
  const request=()=>({avatar_id:avatarId,source_sha256:inspected.source_sha256,target_id:inspected.target_id,target_sha256:inspected.target_sha256,expected_skeleton:signature,reference_mesh_node:0,reference_primitive:0,...FITTING_DEFAULTS,name:'Test outfit',source:'Synthetic fixture',license:'Original test data'});
  await test('async output is validated and preview URL is separate from wardrobe import',async()=>{
    row=await complete(s,(await s.submit(request(),'agent:fit-test')).id);assert.equal(row.state,'complete',row.error);assert.equal(row.result.validation.errors,0);assert.match(row.result.files.glb,new RegExp(row.id));assert.equal(row.result.vertices,8);
    assert.deepEqual(events.map(e=>[e.type,e.actor]),[['delegate','agent:fit-test'],['edit','agent:fit-test']]);assert.equal((await s.file(row.id)).bytes.length,(await readFile(row.result.output)).length);
  });
  await test('source replacement cannot reuse an old inspection or completed preview',async()=>{
    source=packGlb(glbDoc({skinned:true,size:[1,2,1]}));await assert.rejects(s.submit(request()),/changed since inspection/);await assert.rejects(s.get(row.id),/changed since inspection/);source=base;
  });
  await test('target mutation and unsafe ids are rejected',async()=>{
    await assert.rejects(s.submit({...request(),target_sha256:'a'.repeat(64)}),/part changed/);await assert.rejects(s.get('../outside'),/Invalid/);
    await assert.rejects(s.inspect({avatar_id:avatarId,target_data_base64:'not a file'}),/base64/);
    await assert.rejects(s.inspect({avatar_id:avatarId,target_path:'https://bad.example/part.glb'}),/absolute local/);
  });
  await test('explicit bounded fitting options and provenance are required',async()=>{
    for(const change of [{max_scale_change:4},{max_displacement:1},{clearance:-.01},{alignment:'automatic-anything'},{license:''},{expected_skeleton:'bad'},{reference_primitive:-1},{other:true}])await assert.rejects(s.submit({...request(),...change}));
  });
  await test('invalid fitter receipts cannot admit a part',async()=>{
    const bad=make('bad',{run:async(...a)=>({...await fakeRun(...a),sourceSha256:'f'.repeat(64)})});const i=await bad.inspect({avatar_id:avatarId,target_data_base64:part.toString('base64')});
    const r=await complete(bad,(await bad.submit({...request(),target_id:i.target_id})).id);assert.equal(r.state,'failed');assert.match(r.error,/does not match/);
  });
  await test('artifact tampering is detected on poll',async()=>{await writeFile(row.result.output,part);await assert.rejects(s.get(row.id),/invalid weights|changed/);});
  await test('MCP tools preserve the same explicit actions',async()=>{const calls=[],tools=avatarFittingTools(async(...args)=>calls.push(args));assert.equal(tools.length,4);await tools.find(t=>t.name==='avatar_fitting_submit').run({...request(),action:'status'});assert.equal(calls[0][2].action,'submit');assert.equal(calls[0][1],'/api/avatar-fitting');});
  await test('preview API enforces loopback and origin before reading local data',async()=>{
    const handler=createAvatarFittingRoutes({service:s,json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));},provenance:{actorFrom:()=> 'agent:test'}});
    server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost')));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/api/avatar-fitting`;
    const bad=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:'https://elsewhere.example'},body:JSON.stringify({action:'status'})});assert.equal(bad.status,403);
    const good=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'status'})});assert.equal(good.status,200);assert.equal((await good.json()).available,true);
  });
  console.log(`${tests} fitting service checks passed`);
}finally{if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
