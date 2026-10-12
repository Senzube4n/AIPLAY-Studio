import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingRecipe,nativeTrainingArgs} from './community-recipes.js';
import {plannerRequest,plannerArgs} from './community-planner.js';
import {datasetFingerprint,nativePreparationStages,createCommunityRoutes} from './community-tools.js';
import {installationFiles} from './community-install.js';
import {externalMusicWork} from './exclusive.js';
import {runTool} from './community-process.js';
import {midiDawPlan} from './community-midi-daw.js';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {config} from '../config.js';
import {actorFrom} from '../provenance.js';

test('dataset receipts detect lyric whitespace and source or style changes',()=>{
 const original={items:[{sha256:'abc',style:'pop',lyrics:'hello ',instrumental:false,prepared:false}]};
 const copy=structuredClone(original);copy.items[0].prepared=true;
 assert.equal(datasetFingerprint(copy),datasetFingerprint(original));
 for(const key of ['lyrics','style','sha256']){const changed=structuredClone(original);changed.items[0][key]+=' ';assert.notEqual(datasetFingerprint(changed),datasetFingerprint(original));}
});
test('MIDI import preserves elapsed note times on the DAW tick grid',()=>{
 const plan=midiDawPlan([{pitch:60,start:.5,end:.75,instrument:'piano'},{pitch:62,start:2.125,end:2.625,instrument:'piano'}],120);
 assert.deepEqual(plan.tracks[0].notes.map(n=>[n.bar,n.beat,n.tick,n.dur_ticks]),[[1,2,0,480],[2,1,240,960]]);
 assert.equal(plan.bars,2);assert.throws(()=>midiDawPlan([],120));assert.throws(()=>midiDawPlan([{pitch:60,start:0,end:1}],0));
});
test('native MIDI imports preserve human or automation attribution on every DAW write and retries do not duplicate a project',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aiplay-native-midi-')),original=config.paths.appData;
 config.paths.appData=dir;
 try{
  for(const [index,headers,actor,by] of [
   [0,{},'user','user'],
   [1,{'x-aiplay-actor':'agent:codex'},'agent:codex','agent'],
   [2,{'x-aiplay-actor':'script:gate'},'script:gate','agent'],
   [3,{'x-aiplay-actor':'user'},'system','agent'],
  ]){
   const id='midi_attribution_'+index,runDir=path.join(dir,'music-tools','runs',id),writes=[];
   await mkdir(runDir,{recursive:true});
   await writeFile(path.join(runDir,'run.json'),JSON.stringify({id,kind:'midi',state:'done',body:{file:'take.wav'}}));
   await writeFile(path.join(runDir,'notes.json'),JSON.stringify([{pitch:60,start:.5,end:.75,instrument:'piano'}]));
   let result;
   const route=createCommunityRoutes({json:(_res,status,body)=>{result={status,body};},readBody:async req=>req.body,
    provenance:{actorFrom},daw:async(body,passedActor)=>{
     writes.push({body,actor:passedActor});
     return body.action==='create'?{slug:'predicted_'+index}:{trackId:'piano'};
    }});
   const req={method:'POST',headers,body:{action:'toDaw',run:id,bpm:128,by:'user'}},url=new URL('http://localhost/api/music-tools');
   assert.equal(await route(req,{},url),true);assert.equal(result.status,200);
   assert.deepEqual(writes.map(write=>write.body.action),['create','add_track','record_notes']);
   for(const write of writes){assert.equal(write.body.by,by);assert.equal(write.actor,actor);}
   assert.equal(writes[0].body.bpm,128);
   const receipt=JSON.parse(await readFile(path.join(runDir,'run.json'),'utf8'));
   assert.equal(receipt.daw,result.body.slug);assert.equal(receipt.dawReady,true);
   await route(req,{},url);assert.equal(result.status,200);assert.equal(result.body.ready,true);assert.equal(writes.length,3);
  }
 }finally{config.paths.appData=original;await rm(dir,{recursive:true,force:true});}
});
test('native planning preserves exact text and replay forces the complete token stream',()=>{
 const r=plannerRequest({style:'pop',lyrics:'[Verse]\nhello  \n',seed:123,stage:'semantic',maxTokens:32});
 assert.equal(r.lyrics,'[Verse]\nhello  \n');
 const args=plannerArgs(r,{modelDir:'models',dir:'out',semanticFile:'tokens.json',semanticFrames:21});
 assert.ok(args.includes('semantic_min_tokens=21'));assert.ok(args.includes('semantic_max_tokens=21'));assert.ok(args.includes('semantic_prefix_file=tokens.json'));
 assert.throws(()=>plannerRequest({style:'pop',lyrics:'hi',stage:'abc',abc:'X:1\nK:C\nC'}));
 assert.throws(()=>plannerRequest({style:'pop',lyrics:'hi',maxTokens:9001}));
});
test('recipes validate settings and use the requested optimizer and resume record',()=>{
 assert.equal(trainingRecipe({preset:'fast'}).steps,200);
 assert.throws(()=>trainingRecipe({preset:'custom',steps:0}));
 assert.throws(()=>trainingRecipe({preset:'custom',optimizer:'anything'}));
 const r=trainingRecipe({preset:'custom',optimizer:'prodigy',adapter:'lokr',steps:10});
 const args=nativeTrainingArgs({models:'models',companion:'nar',dataset:'songs.json',output:'out',recipe:r,resume:'checkpoint'});
 assert.equal(args[args.indexOf('--lr')+1],'1');assert.equal(args[args.indexOf('--resume')+1],'checkpoint');
 assert.ok(args.includes('--lokr-factor'));
});
test('batch preparation has one process per stage rather than per song',()=>{
 const stages=nativePreparationStages({audio:'songs',models:'models',tokenizer:'q4',dir:'dataset',trigger:'artist'});
 assert.deepEqual(stages.map(s=>s.id),['latents','codes','scores','prepare']);
 assert.ok(stages[0].args.includes('songs'));
});
test('download manifests pin all model revisions and checksums',()=>{
 for(const kind of ['train','midi'])for(const size of ['small','medium','large'])for(const spec of installationFiles(kind,size)){
  assert.match(spec.url,/\/resolve\/[a-f0-9]{40}\//);assert.ok(spec.bytes>0);assert.match(spec.sha256||spec.gitBlob,/^[a-f0-9]{40,64}$/);
 }
 assert.throws(()=>installationFiles('midi','unknown'));
});
test('external tools hold an exclusive reservation until release',()=>{
 const release=externalMusicWork.acquire('test');assert.throws(()=>externalMusicWork.acquire('other'));assert.throws(()=>externalMusicWork.assertFree());release();release();externalMusicWork.assertFree();
});
test('tool log lines keep stdout and stderr independent, including partial lines',async()=>{
 const lines=[];await runTool(process.execPath,['-e',"process.stdout.write('out');process.stderr.write('err\\n');setTimeout(()=>process.stdout.write('put\\n'),20)"],{onLine:line=>lines.push(line)});
 assert.deepEqual(lines.sort(),['err','output']);
});
test('process exit and callback errors are reported after close',async()=>{
 await assert.rejects(runTool(process.execPath,['-e','process.exit(7)']),/exited \(7\)/);
 await assert.rejects(runTool(process.execPath,['-e',"console.log('line')"],{onLine:()=>{throw new Error('bad callback')}}),/bad callback/);
});
