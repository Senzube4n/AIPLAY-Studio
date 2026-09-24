import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {glbDoc,packGlb} from './fixtures.js';
import {createAvatarFittingService,createAvatarFittingRoutes,runFittingPython,FITTING_DEFAULTS} from './avatar-fitting.js';
import {config,attachmentFitScriptPath,weightTransferScriptPath} from '../config.js';
import {avatarFittingTools} from '../mcp-avatar-fitting.js';
import {PREVIZ_TOOLKIT_REPO,PREVIZ_TOOLKIT_PUBLIC} from './previz-toolkit.js';

// Where the toolkit keeps a script, told honestly: "publishes" only once the
// repository is public, "not public yet" until then, never the old "does not
// publish it yet".
const toolkitSentence=(text,file)=>text.includes(PREVIZ_TOOLKIT_REPO)&&text.includes('previz/'+file)&&!/not publish/.test(text)
  &&(PREVIZ_TOOLKIT_PUBLIC?/publishes it/.test(text)&&!/not public/.test(text):/not public yet/.test(text)&&!/publishes it/.test(text));

const temp=await mkdtemp(path.join(os.tmpdir(),'studio-fitting-')),digest=b=>createHash('sha256').update(b).digest('hex');
const base=packGlb(glbDoc({skinned:true})),part=packGlb(glbDoc()),avatarId='av_'+randomUUID(),signature='c'.repeat(64),events=[];
let source=base,tests=0,server;
const test=async(name,fn)=>{await fn();console.log('ok '+name);tests++;};
// attachment_fit.py and weight_transfer.py import bpy and live outside this
// Apache-2.0 tree, so the suite points the resolvers at stand-in files. Nothing
// below executes them: the service checks inject a runner, the process checks
// inject spawnImpl.
const meshDir=path.dirname(fileURLToPath(import.meta.url)),outside=path.join(temp,'outside the tree');
const fitScript=path.join(outside,'attachment_fit.py'),transferScript=path.join(outside,'weight_transfer.py');
await mkdir(outside);await writeFile(fitScript,'# stand-in\n');await writeFile(transferScript,'# stand-in\n');
const priorEnv={fit:process.env.AIPLAY_ATTACHMENT_FIT_SCRIPT,transfer:process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT};
const useScripts=(fit,transfer)=>{process.env.AIPLAY_ATTACHMENT_FIT_SCRIPT=fit;process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=transfer;};
useScripts(fitScript,transferScript);
const fakeChild=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
  setImmediate(()=>{c.stdout.write('AVATAR_FITTING_RESULT_JSON:'+JSON.stringify({ok:true})+'\n');c.stdout.end();c.stderr.end();setImmediate(()=>c.emit('close',0));});return c;};
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
  await test('the fitter is resolved outside this tree and spawned with both script folders on PYTHONPATH',async()=>{
    assert.equal(attachmentFitScriptPath(),fitScript);
    delete process.env.AIPLAY_ATTACHMENT_FIT_SCRIPT;
    try{assert.equal(attachmentFitScriptPath(),path.join(path.dirname(weightTransferScriptPath()),'attachment_fit.py'));assert.equal(attachmentFitScriptPath(),fitScript);}
    finally{useScripts(fitScript,transferScript);}
    const prior=process.env.PYTHONPATH;process.env.PYTHONPATH=path.join(temp,'caller path');let invocation;
    try{await runFittingPython('python',['--inspect'],{spawnImpl:(exe,args,options)=>{invocation={args,options};return fakeChild();}});}
    finally{if(prior===undefined)delete process.env.PYTHONPATH;else process.env.PYTHONPATH=prior;}
    assert.deepEqual(invocation.args.slice(0,2),['-u',fitScript]);assert.notEqual(path.dirname(invocation.args[1]),meshDir);
    assert.deepEqual(invocation.options.env.PYTHONPATH.split(path.delimiter),[outside,meshDir,path.join(temp,'caller path')]);
    assert.equal(invocation.options.shell,false);
  });
  await test('a missing fitter or weight-transfer script is a 503 before anything is written or recorded',async()=>{
    const absent=path.join(temp,'no toolkit here'),clone=path.join(temp,'a clone'),priorRig=config.rig,priorPreviz=config.blender.previz;
    const setEnv=(key,value)=>{if(value===undefined)delete process.env[key];else process.env[key]=value;};
    // Every sentence names where the toolkit keeps the missing script, and
    // offers only a remedy that takes effect: a set variable wins (config.js),
    // and unset the fitter follows weight_transfer.py, so a clone or
    // AIPLAY_PREVIZ is offered only when no variable is set.
    const staleTransfer=path.join(absent,'weight_transfer.py');
    const cases=[
      {name:'a stale fitter variable',fit:path.join(absent,'attachment_fit.py'),transfer:transferScript,missing:'attachment_fit.py',at:absent,variable:'AIPLAY_ATTACHMENT_FIT_SCRIPT',
        says:[/AIPLAY_ATTACHMENT_FIT_SCRIPT names that path, and a set variable wins/],never:/AIPLAY_PREVIZ|Clone that/},
      {name:'a stale transfer variable',fit:fitScript,transfer:staleTransfer,missing:'weight_transfer.py',at:absent,variable:'AIPLAY_WEIGHT_TRANSFER_SCRIPT',
        says:[/AIPLAY_WEIGHT_TRANSFER_SCRIPT names that path, and a set variable wins/],never:/AIPLAY_PREVIZ|Clone that/},
      {name:'an unset fitter beside a stale transfer variable',fit:undefined,transfer:staleTransfer,missing:'attachment_fit.py',at:absent,variable:'AIPLAY_WEIGHT_TRANSFER_SCRIPT',
        says:[/With AIPLAY_ATTACHMENT_FIT_SCRIPT unset, attachment_fit\.py is looked for beside the file AIPLAY_WEIGHT_TRANSFER_SCRIPT names/,`(${staleTransfer})`,
          /point AIPLAY_WEIGHT_TRANSFER_SCRIPT at the same script/,/set AIPLAY_ATTACHMENT_FIT_SCRIPT to attachment_fit\.py itself/],never:/AIPLAY_PREVIZ|Clone that/},
      {name:'nothing set',fit:undefined,transfer:undefined,missing:'attachment_fit.py',at:path.join(clone,'previz','attachment_fit.py'),variable:'AIPLAY_ATTACHMENT_FIT_SCRIPT',
        says:[`Clone that repository to ${clone} `,/set AIPLAY_PREVIZ to the previz\/cli\.py of a clone elsewhere/,/set AIPLAY_ATTACHMENT_FIT_SCRIPT to the script itself/],never:/names that path/},
    ];
    for(const c of cases){
      setEnv('AIPLAY_ATTACHMENT_FIT_SCRIPT',c.fit);setEnv('AIPLAY_WEIGHT_TRANSFER_SCRIPT',c.transfer);
      config.rig=path.join(temp,'an empty rig');config.blender.previz=path.join(clone,'previz','cli.py');
      try{
        const said=text=>{
          assert.ok(text.includes(c.at)&&/imports bpy/.test(text)&&/Apache-2\.0 tree ships no copy/.test(text),`${c.name}: ${text}`);
          assert.ok(toolkitSentence(text,c.missing),`${c.name}: where the toolkit keeps it: ${text}`);
          for(const part of c.says)assert.ok(typeof part==='string'?text.includes(part):part.test(text),`${c.name}: ${part}: ${text}`);
          assert.doesNotMatch(text,c.never,`${c.name}: a remedy that would not take effect`);return true;};
        const sentence=e=>e.status===503&&said(e.message);
        let spawned=0;await assert.rejects(runFittingPython('python',[],{spawnImpl:()=>{spawned++;return fakeChild();}}),sentence);assert.equal(spawned,0);
        const jobs='no-script-'+cases.indexOf(c),before=events.length,refused=make(jobs,{run:async()=>{throw Error('must not run');}});
        // The panel and avatar_fitting_status show this same sentence.
        const status=await refused.status();assert.equal(status.available,false);assert.ok(status.reason.includes(c.variable),status.reason);
        assert.ok(status.reason.includes(PREVIZ_TOOLKIT_REPO),'the panel and the status tool say where the toolkit is');said(status.reason);
        await assert.rejects(refused.inspect({avatar_id:avatarId,target_data_base64:part.toString('base64')}),sentence);
        await assert.rejects(refused.submit(request()),sentence);
        const left=await readdir(path.join(temp,jobs)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
        assert.deepEqual(left,[],'a refused call left files behind');assert.equal(events.length,before,'a refused call wrote provenance');
        useScripts(fitScript,transferScript);assert.equal((await refused.status()).available,true,'the refusal kept the job reservation');
      }finally{useScripts(fitScript,transferScript);config.rig=priorRig;config.blender.previz=priorPreviz;}
    }
  });
  console.log(`${tests} fitting service checks passed`);
}finally{for(const [key,value] of [['AIPLAY_ATTACHMENT_FIT_SCRIPT',priorEnv.fit],['AIPLAY_WEIGHT_TRANSFER_SCRIPT',priorEnv.transfer]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
