import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PassThrough} from 'node:stream';
import {config} from '../config.js';
import * as daw from '../daw/store.js';
import * as vfx from '../vfx/store.js';
import {createDawRoutes,validateCueAccentJob} from '../daw/routes.js';
import {sharedCueRecipe,sharedCuePlan,createSharedCueService,createSharedCueRoutes} from './shared-cues.js';
import {cueOverlayOpacity,cuePreviewAlignment} from '../../web/music-shared-cues.js';

const copy=value=>JSON.parse(JSON.stringify(value));
async function fixture(t,options={}) {
  const folder=await mkdtemp(path.join(os.tmpdir(),'aiplay-cues-')),prior=config.outputDir;
  config.outputDir=folder;t.after(async()=>{config.outputDir=prior;await rm(folder,{recursive:true,force:true});});
  const project=await daw.createProject('Cue test',{bpm:120,lengthBars:16}),comp=await vfx.createComp('Cue visuals',{duration:40,width:320,height:180});
  const settings={project:project.slug,comp:comp.slug,bar:3,beat:1,name:'Drop'};
  return {folder,project,comp,settings,service:createSharedCueService({root:()=>path.join(folder,'cues'),...options})};
}

test('recipe rejects dead targets, nonfinite values, fractional positions and paths',()=>{
  const r={project:'song',comp:'stage',bar:1};
  for(const mutation of [{camera:'zoom'},{project:'../song'},{comp:'C:/outside'},{bar:1.5},{beat:2.2},{tick:960},{gainDb:Infinity},{compOffsetSeconds:NaN},{flashStrength:80},{accent:'glitch'}])assert.throws(()=>sharedCueRecipe({...r,...mutation}));
});

test('mixed meter and tempo use the DAW authority and explicit VFX offset',()=>{
  const p=daw.blankProject('song',{lengthBars:12,bpm:120});p.meterMap=[{atBar:1,num:4,den:4},{atBar:3,num:7,den:8}];p.tempoMap=[{atBar:1,bpm:120},{atBar:3,bpm:60}];
  const c=vfx.blankComp('visuals',{duration:40});
  const cue={id:'a'.repeat(32),by:'user',recipe:{project:p.slug,comp:c.slug,bar:3,beat:3,tick:480,compOffsetSeconds:-1,durationBeats:1}};
  const plan=sharedCuePlan(cue,p,c);assert.equal(plan.musicSeconds,5.25);assert.equal(plan.visualSeconds,4.25);assert.equal(plan.durationSeconds,.5);
  assert.equal(plan.audioJob.notes[0].dur_samples,24000);assert.match(cuePreviewAlignment(plan),/DAW 5.250 s · VFX 4.250 s/);
  assert.throws(()=>sharedCuePlan({...cue,recipe:{...cue.recipe,beat:8}},p,c),/does not exist/);
});

test('apply roundtrips real stores and idempotent undo preserves authored content',async t=>{
  const f=await fixture(t);let authoredTrack,authoredLayer;
  await daw.updateProject(f.project.slug,d=>{authoredTrack=daw.blankTrack('Melody','pluck');d.tracks.push(authoredTrack);});
  await vfx.updateComp(f.comp.slug,c=>{authoredLayer=vfx.blankLayer(c,'solid',{name:'Original',color:[20,40,80,255]});c.layers.push(authoredLayer);c.markers.push({t:1,label:'Original marker'});});
  const beforeP=await daw.readProject(f.project.slug),beforeC=await vfx.readComp(f.comp.slug);
  const saved=await f.service.save(f.settings,'agent:test');assert.equal(saved.cue.state,'draft');assert.equal((await daw.readProject(f.project.slug)).updatedAt,beforeP.updatedAt);
  const applied=await f.service.apply(saved.cue.id,saved.plan.previewToken,'user');assert.equal(applied.cue.state,'applied');
  const p=await daw.readProject(f.project.slug),c=await vfx.readComp(f.comp.slug);
  assert.equal(p.tracks.length,2);assert.equal(c.layers.length,2);assert.equal(c.markers.length,2);assert.deepEqual(p.tracks[0],beforeP.tracks[0]);assert.deepEqual(c.layers[1],beforeC.layers[0]);
  const e=daw.noteEvents(p).find(n=>n.trackId===saved.plan.track.id);assert.ok(e);assert.equal(e.seed,saved.plan.audioJob.notes[0].seed);
  assert.equal(vfx.evalProp(c.layers[0].transform.opacity,saved.plan.visualSeconds),20);
  assert.equal(vfx.evalProp(c.layers[0].transform.opacity,saved.plan.visualSeconds+saved.plan.durationSeconds),0);
  assert.equal((await f.service.apply(saved.cue.id,saved.plan.previewToken)).alreadyApplied,true);
  const undone=await f.service.undo(saved.cue.id);assert.equal(undone.cue.state,'undone');
  assert.deepEqual((await daw.readProject(f.project.slug)).tracks,beforeP.tracks);assert.deepEqual((await vfx.readComp(f.comp.slug)).layers,beforeC.layers);assert.deepEqual((await vfx.readComp(f.comp.slug)).markers,beforeC.markers);
  assert.equal((await f.service.undo(saved.cue.id)).alreadyUndone,true);
});

test('stale preview and concurrent apply never add a second cue',async t=>{
  const f=await fixture(t),saved=await f.service.save(f.settings);
  await daw.updateProject(f.project.slug,d=>{d.tempoMap=[{atBar:1,bpm:100}];});
  await assert.rejects(f.service.apply(saved.cue.id,saved.plan.previewToken),/changed/);assert.equal((await vfx.readComp(f.comp.slug)).layers.length,0);
  const latest=await f.service.preview(saved.cue.id);
  const results=await Promise.all([f.service.apply(saved.cue.id,latest.plan.previewToken),f.service.apply(saved.cue.id,latest.plan.previewToken)]);
  assert.equal(results.filter(r=>r.alreadyApplied).length,1);assert.equal((await daw.readProject(f.project.slug)).tracks.length,1);
});

test('an intervening VFX writer under the DAW lock refuses without partial content',async t=>{
  const f=await fixture(t),wrapped={...daw,updateProject:async(slug,fn)=>daw.updateProject(slug,async d=>{await vfx.updateComp(f.comp.slug,c=>{c.bg=[10,20,30,255];});return fn(d);})};
  const service=createSharedCueService({root:()=>path.join(f.folder,'cues'),daw:wrapped}),saved=await service.save(f.settings);
  await assert.rejects(service.apply(saved.cue.id,saved.plan.previewToken),/composition changed/);
  assert.equal((await daw.readProject(f.project.slug)).tracks.length,0);assert.equal((await vfx.readComp(f.comp.slug)).layers.length,0);assert.equal((await service.read(saved.cue.id)).cue.state,'draft');
});

test('partial apply survives service restart and Undo recovers only owned objects',async t=>{
  const f=await fixture(t),broken={...daw,updateProject:async(slug,fn)=>{const d=await daw.readProject(slug);await fn(d);throw new Error('Simulated DAW write failure');}};
  const service=createSharedCueService({root:()=>path.join(f.folder,'cues'),daw:broken}),saved=await service.save(f.settings);
  await assert.rejects(service.apply(saved.cue.id,saved.plan.previewToken),/use Undo/);
  assert.equal((await vfx.readComp(f.comp.slug)).layers.length,1);assert.equal((await daw.readProject(f.project.slug)).tracks.length,0);
  const restarted=createSharedCueService({root:()=>path.join(f.folder,'cues')});assert.equal((await restarted.status()).cues[0].state,'partial');
  await restarted.undo(saved.cue.id);assert.equal((await vfx.readComp(f.comp.slug)).layers.length,0);assert.equal((await restarted.read(saved.cue.id)).cue.state,'undone');
});

test('Undo rejects edits and dependencies on cue-owned content',async t=>{
  const f=await fixture(t),saved=await f.service.save(f.settings);await f.service.apply(saved.cue.id,saved.plan.previewToken);
  await daw.updateProject(f.project.slug,d=>{d.tracks[0].gainDb=-12;});await assert.rejects(f.service.undo(saved.cue.id),/accent was edited/);
  assert.equal((await vfx.readComp(f.comp.slug)).layers.length,1);
  await daw.updateProject(f.project.slug,d=>{d.tracks[0].gainDb=-6;});
  await vfx.updateComp(f.comp.slug,c=>{c.layers.push(vfx.blankLayer(c,'null',{parent:saved.plan.layer.id}));});await assert.rejects(f.service.undo(saved.cue.id),/uses this flash/);
});

test('cue audition validates the exact CPU job and is served through the real DAW preview door',async t=>{
  let calls=0,job;
  const f=await fixture(t,{renderAccent:async(value,out)=>{calls++;job=value;validateCueAccentJob(value);const buffer=Buffer.alloc(100);buffer.write('RIFF');buffer.write('WAVE',8);await writeFile(out,buffer);}});
  const saved=await f.service.save(f.settings),beforeP=await daw.readProject(f.project.slug),beforeC=await vfx.readComp(f.comp.slug);
  const [a,b]=await Promise.all([f.service.audition(saved.cue.id,saved.plan.previewToken),f.service.audition(saved.cue.id,saved.plan.previewToken)]);
  assert.equal(calls,1);assert.equal(a.audioUrl,b.audioUrl);assert.equal(job.notes[0].seed,saved.plan.audioJob.notes[0].seed);assert.equal(a.frameUrl,saved.plan.frameUrl);
  assert.equal((await daw.readProject(f.project.slug)).updatedAt,beforeP.updatedAt);assert.equal((await vfx.readComp(f.comp.slug)).updatedAt,beforeC.updatedAt);
  for(const mutate of [j=>j.notes[0].inst='pluck',j=>j.notes[0].midi=60,j=>j.notes[0].gain_db=12,j=>j.notes[0].params={drive:1},j=>j.n_samples=480001,j=>j.instruments_dir='C:/outside']) {const bad=copy(job);mutate(bad);assert.throws(()=>validateCueAccentJob(bad));}
  const routes=createDawRoutes({json:(res,code,value)=>{res.writeHead(code);res.end(JSON.stringify(value));},readBody:async()=>({}),config});
  const response=new PassThrough(),parts=[];response.writeHead=(code,headers)=>{response.statusCode=code;response.headers=headers;return response;};response.on('data',part=>parts.push(part));
  const finished=new Promise(resolve=>response.on('end',resolve));await routes({method:'GET',headers:{}},response,new URL(a.audioUrl,'http://localhost'));await finished;
  assert.equal(response.statusCode,200);assert.equal(response.headers['Content-Type'],'audio/wav');assert.equal(Buffer.concat(parts).subarray(0,4).toString(),'RIFF');
  await assert.rejects(routes.renderCueAccent(job,path.join(f.folder,'outside.wav')),/owned temporary/);
});

test('HTTP door rejects forged attribution and unknown fields',async t=>{
  const f=await fixture(t),routes=createSharedCueRoutes({root:()=>path.join(f.folder,'cues'),json:(res,code,data)=>{res.code=code;res.data=data;},readBody:async req=>req.body});
  const response={};await routes({method:'POST',headers:{'x-aiplay-actor':'user'},body:{action:'save',...f.settings}},response,new URL('http://localhost/api/music-cues'));
  assert.equal(response.code,200);assert.equal(response.data.cue.actor,'system');assert.equal(response.data.cue.by,'agent');
  const refused={};await routes({method:'POST',headers:{},body:{action:'save',...f.settings,by:'user'}},refused,new URL('http://localhost/api/music-cues'));assert.equal(refused.code,400);
});

test('UI flash envelope reaches the applied key values and remains bounded',()=>{
  assert.equal(cueOverlayOpacity(-1,.25,20),0);assert.equal(cueOverlayOpacity(0,.25,20),.2);assert.equal(cueOverlayOpacity(.125,.25,20),.1);assert.equal(cueOverlayOpacity(.25,.25,20),0);
});
