/** Offline Music acceptance: real adapters, queue, authenticated worker and
 * verified adoption, with a synthetic ComfyUI and a generated 1 s test tone.
 * No model weights, cloud account or hardware inference are used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { mountAceMusic, aceReadinessLabel } from '../web/ace-music.js';
const temp = await fs.mkdtemp(path.join(os.tmpdir(),'ace-music-'));
process.env.AIPLAY_APPDATA = path.join(temp,'appdata');process.env.AIPLAY_RIG=path.join(temp,'rig');
process.env.AIPLAY_OUTPUT = path.join(temp,'library');
const {config} = await import('./config.js');
const {MODEL_PROFILES} = await import('../shared/model-profiles.js');
const {prepareAceMusicInput, selectAceMusicModels, checkAceMusic} = await import('./music/ace-comfy-input.js');
const {preserveSelectedAce} = await import('./engine/remote-models.js');
const {setupPlan,selectedModelReadiness} = await import('./setup-plan.js');
const {workflowEvidenceKey} = await import('./engine/workflow-evidence.js');
const {createWorker} = await import('../worker/runpod-worker.js');
const {createRemoteClient} = await import('./engine/remote-client.js');
const {awaitRemoteMusicJob} = await import('./engine/remote-music.js');
const {JobRunner} = await import('./jobs.js');
const {sendJSON,readBody} = await import('./engine/remote-common.js');
const profile=MODEL_PROFILES.find(p=>p.id==='ace15-xl-sft'), reference=profile.hardwareAcceptance;
const dit=profile.settings.dit, lm=profile.settings.lm;
const shelf={dits:[dit,'acestep_v1.5_turbo.safetensors'],lms:[lm,'qwen_1.7b_ace15.safetensors'],lm,ready:true};
const form=(patch={})=>({caption:reference.workload.caption,lyrics:'',instrumental:true,seed:20261019,maxDuration:30,
 aceDit:dit,aceLm:lm,aceSteps:50,aceCfg:7,aceCodes:true,acePlanTemp:.85,bpm:120,keyscale:'C major',timesignature:'4',language:'en',...patch});
const prepare=(body,extra={})=>prepareAceMusicInput(body,{shelf,...extra});
const hash=b=>createHash('sha256').update(b).digest('hex');
const FLAC=Buffer.from('ZkxhQwAAACIQABAAAATgAAUXAfQA8AAAH0D5K0eULz8VjoB27ekiz1CHhAAAKCAAAAByZWZlcmVuY2UgbGliRkxBQyAxLjQuMyAyMDIzMDYyMwAAAAD/+MQIAARCAAABGrU/DgCAEylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyFrp//h0CAEPP4BC+xL6cbU/DgCABCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhhMylPUuaGGEgYQwkMMy7ciUyySYEkCSEhk/3XTyZCZCSEkkpPL3mmcJIGEkJhlKdulMpJhDAkMMMk5fIlKWZhhkkIYSZClLEqWlMwkhISYGGYT5HHackkkhJCEkMk5s3fhyTCSQkmQzJcS7KYYZISEkMMw8qRpSnkwkkwMMMJmUp6lzQwwkDCGEhhmXbkSmWSTAkgSQkMn+66eTITISQkklJ5e80zhJAwkhMMpTt0plJMIYEhhhknL5EpSzMMMkhDCTIUpYlS0pmEkJCTAwzCfI47TkkkkJIQkhknNm78OSYSSEkyGZLiXZTDDJCQkhhmHlSNKU8mEkmBhhgAgy','base64');
const TOKEN='synthetic-only-ace-worker-token-32-chars';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));

test('explicit model/planner identities survive saved preference races and never substitute',()=>{
 assert.deepEqual(selectAceMusicModels(shelf,{dit,lm}),{dit,lm});
 assert.throws(()=>selectAceMusicModels({...shelf,dits:['acestep_v1.5_turbo.safetensors']},{dit,lm}),/selected ACE/);
 assert.throws(()=>selectAceMusicModels({...shelf,lms:['qwen_1.7b_ace15.safetensors']},{dit,lm}),/selected planner/);
 assert.equal(prepare(form(),{savedDit:'acestep_v1.5_turbo.safetensors',savedLm:'qwen_1.7b_ace15.safetensors'}).job.aceDit,dit);
 const rows=preserveSelectedAce([{engine:'ace-step15',value:'ace-step15',available:false}],dit);
 assert.equal(rows.length,1);assert.equal(rows[0].dit,dit);assert.equal(rows[0].available,false);
});
test('the explicit Music reference form compiles to the accepted workflow and effective settings',()=>{
 const p=prepare(form());assert.equal(workflowEvidenceKey(p.graph),reference.workflowKey);assert.equal(p.lyrics,'');
 assert.equal(p.historicalHardwareValidated,true);assert.equal(p.job.aceHardwareEvidenceId,reference.id);
 assert.deepEqual([p.job.aceSteps,p.job.aceCfg,p.job.acePlanTemp,p.job.maxDuration],[50,7,.85,30]);
 const standard=prepare(form({aceDit:'acestep_v1.5_turbo.safetensors',aceSteps:undefined,aceCfg:undefined}));
 assert.equal(standard.lyrics,'[Instrumental]');assert.equal(standard.job.aceSteps,8);assert.equal(standard.job.aceCfg,1);
 const text='[Verse]\nOriginal words & punctuation: <sing>\n[Chorus]\nKeep these words';
 const vocal=prepare(form({instrumental:false,lyrics:text}));assert.equal(vocal.graph['4'].inputs.lyrics,text);
 assert.equal(vocal.historicalHardwareValidated,false);
 for(const patch of [{maxDuration:60},{aceSteps:8},{aceCfg:1},{acePlanTemp:1},{aceLm:'qwen_1.7b_ace15.safetensors'},
 {aceCodes:false},{caption:'Different styles, no lyric substitution'},{instrumental:false},{seed:20261020},{mixSeed:20261020}])
  assert.equal(prepare(form(patch)).historicalHardwareValidated,false,JSON.stringify(patch));
 assert.equal(prepare(form(),{lora:'fixture.safetensors'}).historicalHardwareValidated,false);
 assert.equal(prepare(form(),{cover:'fixture.wav'}).job.aceCodes,false);
});
test('readiness checks the current form and computer, not a historical hardware success',async()=>{
 const cfg={remoteOnly:true,music:{aceModel:dit,aceLm:lm,engines:{'ace-step15':{maxDuration:600}}}};
 let bundles=[],connected=false,received;
 const check=body=>checkAceMusic(body,{config:cfg,getShelf:async()=>shelf,remoteReadiness:async(plan,{graphFor})=>{
  const graph=graphFor(plan.profiles[0]);received=graph;
  const objects=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{input:{required:{}}}]));
  return {readiness:selectedModelReadiness(plan,{connected,bundles,objects,graphFor})};
 }});
 let row=await check(form());assert.equal(row.ready,false);assert.equal(row.historicalHardwareValidated,true);assert.equal(row.filesVerified,false);
 connected=true;row=await check(form());assert.equal(row.ready,false);assert.equal(row.workerConnected,true);
 bundles=[{id:'ace15-xl-sft',state:'ready'}];row=await check(form());assert.equal(row.ready,true);assert.equal(row.inferenceValidated,false);
 row=await check(form({maxDuration:60}));assert.equal(row.historicalHardwareValidated,false);assert.equal(received['10'].inputs.seconds,60);
 row=await check(form({instrumental:false,lyrics:'Actual words'}));assert.equal(received['4'].inputs.lyrics,'Actual words');assert.equal(row.historicalHardwareValidated,false);
 row=await check(form({aceLm:'qwen_1.7b_ace15.safetensors'}));assert.equal(row.ready,false);assert.equal(row.filesVerified,false);assert.match(row.error,/4B planner/);
 await assert.rejects(check(form({lora:'local-only.safetensors'})),/upload workflow/);
});
test('local readiness uses existing checksum receipts and the actual selected workflow',async()=>{
 const cfg={remoteOnly:false,music:{aceModel:dit,aceLm:lm,engines:{'ace-step15':{maxDuration:600}}}};
 let hashes=0;
 const localFiles=async()=>profile.files; // profile files are obtained through the real bundle below
 const {MODEL_BUNDLES}=await import('../shared/model-bundles.js');const files=MODEL_BUNDLES[profile.id].files;
 const objects=Object.fromEntries(Object.values(prepare(form()).graph).map(n=>[n.class_type,{input:{required:{}}}]));
 const engine={objectInfo:async n=>({[n]:objects[n]}),status:async()=>({version:'synthetic'}),activity:async()=>({runs:[]}),store:{resolveRecordFiles:async(record,{hashModels})=>{
  if(hashModels)hashes++;record.engineFiles=files.map(f=>({file:f.relative.split('/').pop(),bytes:f.bytes,sha256:hashModels?'sha256:'+f.sha256:null}));
 }}};
 const deps={config:cfg,getShelf:async()=>shelf,localFiles:async()=>files.map(f=>({folder:f.relative.split('/')[0],name:f.relative.split('/')[1],bytes:f.bytes})),engine};
 assert.equal((await checkAceMusic(form(),deps)).filesVerified,false);assert.equal(hashes,0);
 const row=await checkAceMusic(form({verify:true}),deps);assert.equal(row.ready,true);assert.equal(row.inferenceValidated,false);assert.equal(hashes,1);
});

async function rig(t){
 const root=await fs.mkdtemp(path.join(temp,'worker-')), inputDir=path.join(root,'input'),outputDir=path.join(root,'out'),modelsDir=path.join(root,'models');
 const fixtureBundle={label:'Synthetic ACE files (not weights)',files:[]};
 for(const [i,relative] of ['diffusion_models/'+dit,'vae/ace_1.5_vae.safetensors','text_encoders/qwen_0.6b_ace15.safetensors','text_encoders/'+lm].entries()){
  const bytes=Buffer.from('NOT MODEL WEIGHTS '+i);await fs.mkdir(path.dirname(path.join(modelsDir,relative)),{recursive:true});await fs.writeFile(path.join(modelsDir,relative),bytes);
  fixtureBundle.files.push({relative,bytes:bytes.length,sha256:hash(bytes),url:'https://invalid.example/never-download'});
 }
 fixtureBundle.totalBytes=fixtureBundle.files.reduce((n,f)=>n+f.bytes,0);
 const objects=Object.fromEntries(Object.values(prepare(form()).graph).map(n=>[n.class_type,{input:{required:{}}}]));
 objects.UNETLoader.input.required.unet_name=[[dit]];objects.DualCLIPLoader.input.required={clip_name1:[['qwen_0.6b_ace15.safetensors']],clip_name2:[[lm]]};
 let submissions=0,cancellations=0;const queue=[],history={};
 const comfy=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://fixture');
  if(u.pathname==='/system_stats')return sendJSON(res,200,{system:{comfyui_version:'SYNTHETIC'},devices:[]});
  if(u.pathname==='/health')return sendJSON(res,200,{data:{status:'offline'}});
  if(u.pathname==='/object_info')return sendJSON(res,200,objects);
  if(u.pathname==='/prompt'){const b=JSON.parse((await readBody(req)).toString());const id=randomUUID();submissions++;queue.push([0,id,b.prompt,b.extra_data]);return sendJSON(res,200,{prompt_id:id});}
  if(u.pathname==='/queue')return sendJSON(res,200,{queue_running:queue.slice(0,1),queue_pending:queue.slice(1)});
  if(u.pathname.startsWith('/history')){const id=u.pathname.split('/')[2];return sendJSON(res,200,id?history[id]?{[id]:history[id]}:{}:history);}
  if(/^\/api\/jobs\/.+\/cancel$/.test(u.pathname)){cancellations++;const id=u.pathname.split('/')[3],i=queue.findIndex(q=>q[1]===id);if(i>=0){const[q]=queue.splice(i,1);history[id]={prompt:q,status:{status_str:'error'}};}return sendJSON(res,200,{});}
  sendJSON(res,404,{});
 });
 const comfyURL=await listen(comfy);
 const worker=await createWorker({token:TOKEN,comfyURL,aceURL:comfyURL,inputDir,outputDir,modelsDir,stateDir:path.join(root,'state'),modelBundles:{'ace15-xl-sft':fixtureBundle},pollMs:3600000,installCommit:'a'.repeat(40)});
 const workerURL=await listen(worker.server);let token;const events=[];let adoptions=0;
 const local=path.join(root,'desktop-out');await fs.mkdir(local,{recursive:true});
 const client=await createRemoteClient({dataDir:path.join(root,'desktop'),outputDir:local,getToken:async()=>token,setToken:async v=>token=v,
  pollMs:3600000,append:async(_scope,event)=>events.push(event),adopt:async({output})=>{
   adoptions++;const name='aiplay_runpod_'+output.file;await fs.rename(path.join(local,output.localFile),path.join(local,name));return name;
  }});
 await client.connect({url:workerURL,token:TOKEN});
 t.after(async()=>{client.close();await worker.close();await new Promise(r=>comfy.close(r));});
 async function complete(fail=false){const q=queue.shift();assert.ok(q);const prefix=q[2]['9'].inputs.filename_prefix;const rel=prefix+'_00001.flac';
  await fs.mkdir(path.dirname(path.join(outputDir,rel)),{recursive:true});await fs.writeFile(path.join(outputDir,rel),FLAC);
  history[q[1]]={prompt:q,status:{status_str:fail?'error':'success',completed:!fail},outputs:fail?{}:{'9':{audio:[{filename:path.basename(rel),subfolder:path.dirname(rel).replaceAll('\\','/'),type:'output'}]}}};return path.join(outputDir,rel);
 }
 return {client,worker,local,events,complete,get submissions(){return submissions;},get cancellations(){return cancellations;},get adoptions(){return adoptions;}};
}

test('real Music queue → authenticated synthetic worker → checksum adoption → playable/exportable audio',{timeout:15000},async t=>{
 const r=await rig(t);config.api.enabled=false;
 const runner=new JobRunner({ready:true,on(){}});const notes=[];
 runner.setRemote(async ({graph,isCancelled,onState})=>{
  const sent=await r.client.submit({graph,label:'Synthetic Music test',actor:'agent:test',fromQueue:true});
  await r.client.tick();await r.worker.tick();await r.complete();await r.worker.tick();await r.client.tick();
  return awaitRemoteMusicJob({client:r.client,sent,isCancelled,onState:s=>{notes.push(s);onState(s);},wait:async()=>new Promise(setImmediate)});
 });
 const prepared=prepare(form());const done=new Promise(resolve=>runner.on('update',s=>{if(s.history?.length)resolve(s.history[0]);}));
 runner.enqueue({...prepared.job,caption:form().caption,lyrics:prepared.lyrics,seed:20261019,instrumental:true,postprocess:false,stages:{cover:false,video:false,lrc:false,stems:false}});
 const result=await done;assert.equal(result.state,'done');assert.match(result.file,/^aiplay_runpod_/);assert.ok(runner.history[0].runId);
 assert.equal(result.aceSteps,50);assert.equal(result.aceCfg,7);assert.equal(result.aceDit,dit);
 const bytes=await fs.readFile(path.join(r.local,result.file));assert.equal(hash(bytes),hash(FLAC));assert.equal(bytes.subarray(0,4).toString(),'fLaC');
 const saved=r.client.status().jobs[0];assert.equal(saved.outputs[0].sha256,hash(FLAC));assert.equal(r.adoptions,1);assert.equal(r.submissions,1);
 assert.ok(r.events.some(e=>e.type==='generate'));assert.ok(notes.includes('completed'));
});

test('Music form pins models, hides unsupported remote inputs and applies the exact preset',async()=>{
 const app=await fs.readFile(new URL('../web/app.js',import.meta.url),'utf8');
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,dispatchEvent(){},classList:{toggle(){}}});return elements.get(id);};
 const state={musicEngine:'ace-step15',musicAceModel:dit,musicAceLm:lm,remoteOnly:true};
 const context={state,$,aceCover:{song:'local.flac'},setGuided(){},setMode(mode){state.mode=mode;},aceCoverPaint(){},paintSeed(){},Event:class{},document:{querySelectorAll:()=>[]}};
 const specCode=app.slice(app.indexOf('function aceSpec()'),app.indexOf('function yueSpec()'));
 const presetCode=app.slice(app.lastIndexOf('  applyPreset: reference => {')+'  applyPreset: '.length).replace(/\}\s*\}\);\s*$/,'}');
 $('maxDur').oninput=()=>{};
 runInNewContext(`(${presetCode})(reference)`,{...context,reference});
 assert.equal(state.mode,'instrumental');assert.equal(state.takes,1);assert.equal(state.seedLocked,true);
 assert.equal($('caption').value,reference.workload.caption);assert.equal($('maxDur').value,'30');
 assert.equal($('aSteps').value,'50');assert.equal($('aCfg').value,'7');assert.equal($('aLm').value,lm);
 const spec=runInNewContext(specCode+'; aceSpec()',context);
 assert.equal(spec.aceDit,dit);assert.equal(spec.aceLm,lm);assert.equal(spec.lora,'');assert.equal(spec.aceCover,undefined);
 assert.equal(spec.aceSteps,50);assert.equal(spec.aceCfg,7);
 state.remoteOnly=false;$('aLora').value='local.safetensors';
 const local=runInNewContext(specCode+'; aceSpec()',context);assert.equal(local.lora,'local.safetensors');assert.equal(local.aceCover.song,'local.flac');
 const menuCode=app.slice(app.indexOf('function rowMenuHtml('),app.indexOf('function closeRowMenu()'));
 const menu=remoteOnly=>runInNewContext(menuCode+'; rowMenuHtml(track)',{state:{remoteOnly,library:[]},track:{file:'song name.flac'},esc:String,familyOf:()=>[]});
 assert.match(menu(true),/song%20name.flac\?download=1/);assert.match(menu(true),/Save original audio/);assert.doesNotMatch(menu(true),/Save as MP3/);
 assert.match(menu(false),/Save as MP3/);
 // Missing saved planners must stay explicit rather than selecting a lighter model.
 assert.match(app,/Selected planner missing/);assert.match(app,/lm.value = state.musicAceLm \|\|/);
});

test('readiness UI ignores stale responses and does not move focused duration controls on every poll',async()=>{
 const nodes=new Map(),listeners={};let moves=0;
 const el=id=>{if(!nodes.has(id))nodes.set(id,{id,hidden:false,children:[],addEventListener(type,fn){this[type]=fn;},replaceChildren(){this.children=[];},append(...items){moves++;for(const n of items)n.parentNode=this;this.children.push(...items);}});return nodes.get(id);};
 const home=el('home'),label=el('durationLabel'),value=el('value'),anchor={parentNode:home,after(...items){moves++;for(const n of items)n.parentNode=home;}};
 label.parentNode=home;value.parentNode=home;label.before=()=>{};el('maxDur').closest=()=>value;
 const doc={getElementById:el,createComment:()=>anchor,querySelector:()=>label,createElement:()=>({}),addEventListener(type,fn){listeners[type]=fn;}};
 const state={musicEngine:'ace-step15',musicAceModel:dit,remoteOnly:true,musicModels:[{engine:'ace-step15',dit,lms:[lm],hardwareAcceptance:reference}]};
 const pending=[];const ui=mountAceMusic({doc,getState:()=>state,readSpec:()=>form(),fetchFn:()=>new Promise(resolve=>pending.push(resolve))});
 ui.dispose();const a=ui.check(),b=ui.check();
 pending[1]({ok:true,json:async()=>({ready:false,workerConnected:true,filesDownloaded:false,filesVerified:false})});await b;
 pending[0]({ok:true,json:async()=>({ready:true,inferenceValidated:true,historicalHardwareValidated:true})});await a;
 assert.equal(el('aceMusicChip').textContent,'Model files needed');assert.equal(el('aceMusicHistory').hidden,true);
 const prior=moves;ui.paint();ui.paint();assert.equal(moves,prior);assert.equal(el('aceLocalInputs').hidden,true);
 assert.equal(aceReadinessLabel({ready:true,inferenceValidated:false}),'Ready for a test');
 state.musicEngine='yue2-gguf';ui.paint();assert.equal(label.parentNode,home);assert.equal(el('aceMusicPanel').hidden,true);ui.dispose();
});

test('library exposes exact ACE settings and execution identity without claiming older files are local',async()=>{
 const {Library}=await import('./library.js');await fs.mkdir(config.outputDir,{recursive:true});
 const library=new Library({saveMetadata:async()=>{}}),file='aiplay_synthetic_music.flac';await fs.writeFile(path.join(config.outputDir,file),FLAC);
 library.remember(file,{engine:'ace-step15',executionTarget:'runpod',aceDit:dit,aceLm:lm,steps:50,cfg:7,
  acePlanTemp:.85,aceCodes:true,maxDuration:30,aceHardwareEvidenceId:reference.id});
 const [row]=await library.list();assert.equal(row.aceDit,dit);assert.equal(row.aceLm,lm);assert.equal(row.executionTarget,'runpod');
 assert.equal(row.steps,50);assert.equal(row.cfg,7);assert.equal(row.maxDuration,30);assert.equal(row.aceHardwareEvidenceId,reference.id);
 library.meta.delete(file);assert.equal((await library.list())[0].executionTarget,undefined);
});

test('reusing ACE music restores ACE controls instead of MiniMax controls',async()=>{
 const app=await fs.readFile(new URL('../web/app.js',import.meta.url),'utf8');
 const code=app.slice(app.indexOf('async function reusePrompt(file)'),app.indexOf('/* ── extend, in the input panel'));
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',oninput(){},scrollIntoView(){}});return nodes.get(id);};
 const track={file:'fixture.flac',engine:'ace-step15',aceDit:dit,aceLm:lm,steps:50,cfg:7,aceCodes:true,acePlanTemp:.85,
  bpm:120,keyscale:'C major',timesignature:'4',language:'en',maxDuration:30,caption:'Saved style',lyrics:'',instrumental:true};
 const state={musicEngine:'minimax-music3',library:[track]};let chosen;
 const context={state,$,chooseMusicModel:async value=>{chosen=value;state.musicEngine='ace-step15';state.musicAceModel=dit;},
  fetch:async()=>({json:async()=>({})}),stopExtend(){},setView(){},setMode(){},setGuided(){},paintSeed(){},countChars(){},aceMusicUi:{invalidate(){}}};
 await runInNewContext(code+';reusePrompt("fixture.flac")',context);
 assert.equal(chosen,'ace-step15:'+dit);assert.equal($('aLm').value,lm);assert.equal($('aSteps').value,'50');
 assert.equal($('aCfg').value,'7');assert.equal($('maxDur').value,'30');assert.equal($('caption').value,'Saved style');
 assert.equal($('qModel').value,'');assert.equal($('qSteps').value,'');
});
test('schema failures reject the selected missing planner before any synthetic inference',{timeout:15000},async t=>{
 const r=await rig(t);const bad=prepare(form()).graph;bad['3'].inputs.clip_name2='missing.safetensors';
 const sent=await r.client.submit({graph:bad});await r.client.tick();await r.worker.tick();await r.client.tick();
 const row=r.client.status().jobs.find(j=>j.id===sent.id);assert.equal(row.state,'failed');assert.equal(r.submissions,0);assert.equal(r.adoptions,0);
});
test('Music cancellation targets the current worker job and waits for confirmed cancellation',{timeout:15000},async t=>{
 const r=await rig(t),sent=await r.client.submit({graph:prepare(form()).graph});await r.client.tick();await r.worker.tick();
 await r.client.cancel(sent.id);await r.worker.tick();await r.client.tick();
 await assert.rejects(awaitRemoteMusicJob({client:r.client,sent,isCancelled:()=>true,onState(){},wait:async()=>{await r.worker.tick();await r.client.tick();}}),e=>e.remoteState==='cancelled');
 assert.equal(r.adoptions,0);assert.ok(r.cancellations>0);
});
test('failed inference stays failed and never adopts an unrelated earlier audio result',{timeout:15000},async t=>{
 const r=await rig(t),sent=await r.client.submit({graph:prepare(form()).graph});await r.client.tick();await r.worker.tick();await r.complete(true);await r.worker.tick();await r.client.tick();
 await assert.rejects(awaitRemoteMusicJob({client:r.client,sent,isCancelled:()=>false,onState(){},wait:async()=>new Promise(setImmediate)}),e=>e.remoteState==='failed');assert.equal(r.adoptions,0);
});
test('corrupt output is not adopted and can be reconciled without a second generation',{timeout:15000},async t=>{
 const r=await rig(t),sent=await r.client.submit({graph:prepare(form()).graph});await r.client.tick();await r.worker.tick();const file=await r.complete();await r.worker.tick();
 await fs.writeFile(file,Buffer.from('corrupt'));await r.client.tick();assert.equal(r.adoptions,0);assert.notEqual(r.client.status().jobs[0].state,'completed');
 await fs.writeFile(file,FLAC);await r.client.tick();assert.equal(r.adoptions,1);assert.equal(r.submissions,1);
});

test('Music check endpoint guards before reading input and delegates the actual form',async()=>{
 const source=await fs.readFile(new URL('./index.js',import.meta.url),'utf8');const a=source.indexOf("    if (p === '/api/music/ace-check'"),b=source.indexOf('    if (p === "/api/generate"',a);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const run=new AsyncFunction('p','req','res','sameOriginLocalJson','json','readBody','checkAceMusic','config','aceShelf','scanBases','modelBases','engineDoor','remoteRoutes',source.slice(a,b));
 let reads=0,seen;
 const call=allowed=>run('/api/music/ace-check',{method:'POST'},{},()=>allowed,(_r,status,body)=>({status,body}),async()=>{reads++;return form({maxDuration:60});},async body=>{seen=body;return {ready:false};},{},()=>{},()=>{},()=>{},{},{});
 assert.equal((await call(false)).status,403);assert.equal(reads,0);assert.equal((await call(true)).status,200);assert.equal(seen.maxDuration,60);
 const branch=source.slice(source.indexOf('let aceJob = null;'),source.indexOf('/* YuE2 through ComfyUI: the refusals'));
 assert.match(branch,/body\.aceDit \?\? config\.music\.aceModel/);assert.match(branch,/body\.aceLm \?\? config\.music\.aceLm/);
 assert.match(branch,/if \(!checked.ready\)/);assert.match(branch,/aceJob = prepared.job/);
});
