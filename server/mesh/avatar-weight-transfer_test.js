import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {glbDoc,packGlb} from './fixtures.js';
import {createWeightTransferService,createWeightTransferRoutes,runWeightPython} from './avatar-weight-transfer.js';
import {config,weightTransferScriptPath} from '../config.js';
import {avatarWeightTransferTools} from '../mcp-avatar-weight-transfer.js';
import {PREVIZ_TOOLKIT_REPO,PREVIZ_TOOLKIT_PUBLIC,toolkitScriptHelp} from './previz-toolkit.js';

// Where the toolkit keeps a script, told honestly: "publishes" only once the
// repository is public, "not public yet" until then, never the old "does not
// publish it yet".
const toolkitSentence=(text,file)=>text.includes(PREVIZ_TOOLKIT_REPO)&&text.includes('previz/'+file)&&!/not publish/.test(text)
  &&(PREVIZ_TOOLKIT_PUBLIC?/publishes it/.test(text)&&!/not public/.test(text):/not public yet/.test(text)&&!/publishes it/.test(text));
let count=0;async function test(name,fn){await fn();console.log('ok '+name);count++;}
const directory=await mkdtemp(path.join(os.tmpdir(),'aiplay weight transfer '));
const reference=path.join(directory,'weighted reference.glb'),target=path.join(directory,'unrigged target.glb');
const referenceBytes=packGlb(glbDoc({skinned:true})),targetBytes=packGlb(glbDoc({skinned:false}));
const hash=b=>createHash('sha256').update(b).digest('hex');
await writeFile(reference,referenceBytes);await writeFile(target,targetBytes);
// weight_transfer.py imports bpy and lives outside this Apache-2.0 tree, so the
// suite points the resolver at a stand-in file. Nothing below executes it: the
// service checks inject a runner and the process checks inject spawnImpl.
const meshDir=path.dirname(fileURLToPath(import.meta.url));
const priorScript=process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT,stubScript=path.join(directory,'outside the tree','weight_transfer.py');
await mkdir(path.dirname(stubScript));await writeFile(stubScript,'# stand-in for the toolkit script\n');
process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=stubScript;
const fakeChild=(result={ok:true})=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
  setImmediate(()=>{c.stdout.write('WEIGHT_TRANSFER_RESULT_JSON:'+JSON.stringify(result)+'\n');c.emit('close',0);});return c;};
const transform=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],skeleton='a'.repeat(64);
const input={reference_path:reference,target_path:target,reference_sha256:hash(referenceBytes),target_sha256:hash(targetBytes),expected_skeleton:skeleton,
  transform,max_distance:.02,name:'Attachment test',source:'Generated test fixture',license:'Test fixture only'};
const calls=[],events=[];
async function runner(py,args){
  calls.push({py,args});
  if(args[0]==='--inspect-reference')return {ok:true,mode:'inspect-reference',skeleton,joints:3,jointNames:['root','spine','head']};
  const arg=name=>args[args.indexOf(name)+1];
  assert.deepEqual(await readFile(arg('--reference')),referenceBytes);assert.deepEqual(await readFile(arg('--target')),targetBytes);
  await writeFile(arg('--output'),referenceBytes);
  return {ok:true,mode:'nearest-surface',skeleton,referenceSha256:input.reference_sha256,targetSha256:input.target_sha256,coverage:1,
    requiresVisualReview:true,vertices:8,joints:3,maxDistance:.01,meanDistance:.005,minRetainedWeight:1,distanceLimit:.02,transform,output:arg('--output')};
}
function service(name,options={}){return createWeightTransferService({directory:path.join(directory,name),python:process.execPath,run:runner,record:async event=>events.push(event),...options});}
async function finished(instance,id){for(let i=0;i<100;i++){const row=await instance.get(id);if(row.state!=='running')return row;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Job did not finish');}
let server;
try{
  const main=service('jobs');let job;
  await test('inspection snapshots source and returns exact input hashes',async()=>{
    const result=await main.inspect({reference_path:reference,target_path:target});assert.equal(result.reference_sha256,input.reference_sha256);assert.equal(result.target_sha256,input.target_sha256);
    assert.notEqual(calls[0].args[1],reference);assert.equal(result.skeleton,skeleton);
  });
  await test('async transfer verifies output, preserves source files and records actual actor',async()=>{
    const pending=await main.submit(input,'agent:parts');assert.equal(pending.state,'running');job=await finished(main,pending.id);assert.equal(job.state,'complete',job.error);
    assert.equal(job.result.sha256,hash(referenceBytes));assert.equal(job.result.validation.errors,0);assert.equal(job.requiresVisualReview,true);
    assert.deepEqual(await readFile(reference),referenceBytes);assert.deepEqual(await readFile(target),targetBytes);
    assert.deepEqual(events.map(e=>[e.type,e.actor]),[['delegate','agent:parts'],['edit','agent:parts']]);
    assert.ok(calls.at(-1).args.includes(JSON.stringify(transform)));assert.equal(calls.at(-1).py,process.execPath);
  });
  await test('completed jobs survive restart and their byte hash is rechecked',async()=>{
    assert.equal((await service('jobs').get(job.id)).state,'complete');await writeFile(job.result.output,targetBytes);
    await assert.rejects(main.get(job.id),/invalid weights|changed on disk/);
  });
  await test('changed source bytes are refused before delegate or launch',async()=>{
    const before=calls.length;await assert.rejects(main.submit({...input,target_sha256:'b'.repeat(64)}),/changed since inspection/);assert.equal(calls.length,before);
  });
  await test('explicit transform, distance, hashes, provenance and local paths are required',async()=>{
    for(const bad of [{transform:undefined},{max_distance:0},{expected_skeleton:'bad'},{license:''},{target_path:'https://example.org/a.glb'},{surprise:true}])await assert.rejects(main.submit({...input,...bad}));
    await assert.rejects(main.get('../escape'),/Invalid/);
  });
  await test('malformed result cannot mark a job complete',async()=>{
    const s=service('bad-report',{run:async(...args)=>({...await runner(...args),coverage:.99})});const row=await finished(s,(await s.submit(input)).id);
    assert.equal(row.state,'failed');assert.match(row.error,/does not match/);
  });
  await test('geometry counts are independently checked against actual output',async()=>{
    const s=service('bad-count',{run:async(...args)=>({...await runner(...args),vertices:9})});const row=await finished(s,(await s.submit(input)).id);
    assert.equal(row.state,'failed');assert.match(row.error,/geometry counts/);
  });
  await test('concurrency is bounded and incomplete jobs are interrupted after restart',async()=>{
    let unblock;const gate=new Promise(resolve=>{unblock=resolve;});const s=service('busy',{run:async(...args)=>{await gate;return runner(...args);}});
    const row=await s.submit(input,'not-a-supported-actor');await assert.rejects(s.submit(input),/already running/);
    assert.equal((await service('busy').get(row.id)).state,'interrupted');unblock();assert.equal((await finished(s,row.id)).actor,'system');
  });
  await test('polls use detached running snapshots until final journal replacement completes',async()=>{
    for(const finalState of ['complete','failed']){
      let saveStarted,finishSave;
      const saving=new Promise(resolve=>{saveStarted=resolve;}),saveGate=new Promise(resolve=>{finishSave=resolve;});let reads=0,s;
      s=service(`read-race-${finalState}`,{
        run:async(...args)=>{const result=await runner(...args);return finalState==='failed'?{...result,coverage:.99}:result;},
        readJob:async file=>{reads++;return JSON.parse(await readFile(file,'utf8'));},
        renameJob:async(from,to)=>{
          const next=JSON.parse(await readFile(from,'utf8'));
          if(next.state!=='running'){saveStarted();await saveGate;}
          await rename(from,to);
        },
      });
      const pending=await s.submit(input);
      await saving;
      // Completion has already been computed, but the durable final journal is
      // deliberately blocked. Polls must neither open it nor expose completion.
      const first=await s.get(pending.id);assert.equal(first.state,'running');
      first.state='caller mutation';first.transform[0]=99;
      const second=await s.get(pending.id);assert.equal(second.state,'running');assert.equal(second.transform[0],1);assert.equal(reads,0);
      finishSave();const result=await finished(s,pending.id);
      assert.equal(result.state,finalState);assert.equal(reads,1);
      if(finalState==='failed')assert.match(result.error,/does not match/);
      else assert.equal(result.result.validation.errors,0);
    }
  });
  await test('transient Windows journal locks retry atomic replacement without losing completion',async()=>{
    let replacements=0,locks=0;
    const s=service('locked-journal',{renameJob:async(from,to)=>{
      const next=JSON.parse(await readFile(from,'utf8'));replacements++;
      if(next.state!=='running'&&locks<2){const code=locks++===0?'EPERM':'EBUSY';throw Object.assign(Error('Simulated open journal handle'),{code});}
      await rename(from,to);
    }});
    const row=await finished(s,(await s.submit(input)).id);
    assert.equal(row.state,'complete');assert.equal(locks,2);assert.equal(replacements,4);
    assert.equal((await service('locked-journal').get(row.id)).state,'complete');
  });
  await test('optional runtime fails helpfully without attempting an install',async()=>{
    const s=service('missing',{python:path.join(directory,'absent-python.exe')});const status=await s.status();assert.equal(status.available,false);assert.match(status.reason,/AIPLAY_AVATAR_PYTHON/);
  });
  await test('MCP uses the common HTTP contract and submit cannot be changed to another action',async()=>{
    const requests=[],tools=avatarWeightTransferTools(async(...a)=>{requests.push(a);return {};});assert.equal(tools.length,4);
    await tools.find(t=>t.name.endsWith('_submit')).run({...input,action:'status'});assert.equal(requests[0][1],'/api/avatar-weight-transfer');assert.equal(requests[0][2].action,'submit');
    assert.equal(tools.find(t=>t.name.endsWith('_submit')).inputSchema.additionalProperties,false);
  });
  await test('runner uses argv without shell and rejects missing result and timeout',async()=>{
    let invocation,killed=false;
    const spawnImpl=(exe,args,options)=>{invocation={exe,args,options};const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{killed=true;};setImmediate(()=>{c.stdout.write('WEIGHT_TRANSFER_RESULT_JSON:'+JSON.stringify({ok:true,proof:3})+'\n');c.emit('close',0);});return c;};
    assert.equal((await runWeightPython('python',['--target','file with & characters.glb'],{spawnImpl})).proof,3);assert.equal(invocation.options.shell,false);assert.equal(invocation.options.windowsHide,true);assert.equal(invocation.args.at(-1),'file with & characters.glb');
    const bad=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{killed=true;};setImmediate(()=>c.emit('close',0));return c;};
    await assert.rejects(runWeightPython('python',[],{spawnImpl:bad}),/unambiguous/);
    const hanging=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{killed=true;};return c;};
    await assert.rejects(runWeightPython('python',[],{spawnImpl:hanging,timeoutMs:10}),/timed out/);assert.equal(killed,true);
  });
  await test('the bpy script is resolved from AIPLAY_WEIGHT_TRANSFER_SCRIPT, never from this tree',async()=>{
    assert.equal(weightTransferScriptPath(),stubScript);
    let invocation;await runWeightPython('python',['--inspect-reference','a.glb'],{spawnImpl:(exe,args,options)=>{invocation={exe,args,options};return fakeChild();}});
    assert.deepEqual(invocation.args.slice(0,2),['-u',stubScript]);
    // Unset, the resolver tries beside the toolkit's cli.py, then
    // <rig>/blender-toolkit/. A rig holding a copy is found; a rig without one
    // gets the toolkit path back, so the sentence names where to put it. Never
    // a path inside server/mesh.
    const priorRig=config.rig,rig=path.join(directory,'a rig');delete process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT;
    try{
      config.rig=rig;const toolkit=path.join(path.dirname(config.blender.previz),'weight_transfer.py');
      assert.equal(weightTransferScriptPath(),toolkit);assert.notEqual(path.dirname(toolkit),meshDir);
      const bench=path.join(rig,'blender-toolkit','weight_transfer.py');await mkdir(path.dirname(bench),{recursive:true});await writeFile(bench,'# a local copy\n');
      assert.equal(weightTransferScriptPath(),bench);
    }
    finally{config.rig=priorRig;process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=stubScript;}
  });
  await test('a missing script is a 503 setup sentence and nothing is spawned',async()=>{
    const absent=path.join(directory,'no toolkit here','weight_transfer.py');process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=absent;
    // ...and it says where the toolkit keeps the script, and the one remedy
    // that works here: the variable is set and wins, so a clone or
    // AIPLAY_PREVIZ would change nothing and is not offered.
    const sentence=e=>e.status===503&&e.message.includes(absent)&&/imports bpy/.test(e.message)&&/Apache-2\.0 tree ships no copy/.test(e.message)
      &&/AIPLAY_WEIGHT_TRANSFER_SCRIPT names that path, and a set variable wins/.test(e.message)&&/or unset it/.test(e.message)
      &&toolkitSentence(e.message,'weight_transfer.py')&&!/AIPLAY_PREVIZ|Clone that/.test(e.message);
    try{
      let spawned=0;await assert.rejects(runWeightPython('python',[],{spawnImpl:()=>{spawned++;return fakeChild();}}),sentence);assert.equal(spawned,0);
      // Refused BEFORE any write: no snapshot folder from inspect (a leaked
      // copy of the base per click), no job and no delegate event from submit.
      const jobs=path.join(directory,'no-script'),recorded=[];
      const s=createWeightTransferService({directory:jobs,python:process.execPath,run:()=>{throw Error('must not run');},record:async e=>recorded.push(e)});
      const status=await s.status();assert.equal(status.available,false);assert.match(status.reason,/AIPLAY_WEIGHT_TRANSFER_SCRIPT/);
      assert.ok(status.reason.includes(PREVIZ_TOOLKIT_REPO),'the panel and the status tool say where to get the script');
      await assert.rejects(s.inspect({reference_path:reference}),sentence);
      await assert.rejects(s.submit(input,'agent:parts'),sentence);
      const left=await readdir(jobs).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
      assert.deepEqual(left,[],'a refused call left files behind');assert.deepEqual(recorded,[],'a refused call wrote provenance');
      // and the refusal released the one-job reservation
      process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=stubScript;assert.equal((await s.status()).available,true);
    }finally{process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=stubScript;}
  });
  await test('unset, the 503 sends the clone to where Studio looks, or to AIPLAY_PREVIZ',async()=>{
    const priorRig=config.rig,priorPreviz=config.blender.previz,clone=path.join(directory,'a clone');
    delete process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT;config.rig=path.join(directory,'an empty rig');config.blender.previz=path.join(clone,'previz','cli.py');
    try{
      const expected=path.join(clone,'previz','weight_transfer.py');assert.equal(weightTransferScriptPath(),expected);
      const sentence=e=>e.status===503&&e.message.includes(expected)&&toolkitSentence(e.message,'weight_transfer.py')
        &&e.message.includes(`Clone that repository to ${clone} `)&&e.message.includes(`so that ${path.join('previz','cli.py')} sits directly in that folder`)
        &&/set AIPLAY_PREVIZ to the previz\/cli\.py of a clone elsewhere/.test(e.message)&&/set AIPLAY_WEIGHT_TRANSFER_SCRIPT to the script itself/.test(e.message);
      await assert.rejects(runWeightPython('python',[],{spawnImpl:()=>{throw Error('must not spawn');}}),sentence);
      const s=createWeightTransferService({directory:path.join(directory,'unset'),python:process.execPath,run:()=>{throw Error('must not run');},record:async()=>{}});
      const status=await s.status();assert.equal(status.available,false);assert.ok(status.reason.includes(`Clone that repository to ${clone} `),status.reason);
    }finally{config.rig=priorRig;config.blender.previz=priorPreviz;process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=stubScript;}
  });
  await test('the sentence and the guide say the same about whether the toolkit is public',async()=>{
    for(const published of [true,false]){
      const text=toolkitScriptHelp('weight_transfer.py',['AIPLAY_WEIGHT_TRANSFER_SCRIPT'],{published});
      assert.ok(text.includes(PREVIZ_TOOLKIT_REPO)&&text.includes('previz/weight_transfer.py'),text);
      assert.equal(/not public yet/.test(text),!published,text);assert.equal(/publishes it/.test(text),published,text);
    }
    const guide=await readFile(new URL('../../docs/AVATAR_PARTS.md',import.meta.url),'utf8');
    assert.ok(guide.includes(PREVIZ_TOOLKIT_REPO),'the guide names the toolkit');
    assert.equal(/not public yet/.test(guide),!PREVIZ_TOOLKIT_PUBLIC,'docs/AVATAR_PARTS.md and PREVIZ_TOOLKIT_PUBLIC disagree about whether the link opens for everyone');
  });
  await test('PYTHONPATH carries server/mesh so the outside script still finds unirig_adapter',async()=>{
    const prior=process.env.PYTHONPATH;process.env.PYTHONPATH=path.join(directory,'caller path');let options;
    try{await runWeightPython('python',[],{spawnImpl:(exe,args,o)=>{options=o;return fakeChild();}});}
    finally{if(prior===undefined)delete process.env.PYTHONPATH;else process.env.PYTHONPATH=prior;}
    assert.deepEqual(options.env.PYTHONPATH.split(path.delimiter),[meshDir,path.join(directory,'caller path')]);
    assert.equal(options.env.PYTHONDONTWRITEBYTECODE,'1');assert.equal(options.env.HF_HUB_OFFLINE,'1');assert.equal(options.env.TRANSFORMERS_OFFLINE,'1');
  });
  await test('HTTP rejects cross-origin local-file requests and accepts same-window status',async()=>{
    const handler=createWeightTransferRoutes({service:main,json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));},provenance:{actorFrom:()=> 'agent:http'}});
    server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost')).catch(e=>{res.writeHead(500);res.end(e.message);}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${server.address().port}/api/avatar-weight-transfer`;
    let response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:'https://hostile.example'},body:JSON.stringify({action:'inspect',reference_path:reference})});assert.equal(response.status,403);
    response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'status'})});assert.equal(response.status,200);assert.equal((await response.json()).available,true);
    response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'status',reference_path:reference})});assert.equal(response.status,400);
  });
  console.log(`${count} weight-transfer service checks passed`);
}finally{if(priorScript===undefined)delete process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT;else process.env.AIPLAY_WEIGHT_TRANSFER_SCRIPT=priorScript;
  if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
