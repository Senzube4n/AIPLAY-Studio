import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { makeCreativeTemplate as make, validateCreativeTemplate as validate, previewCreativeTemplate as preview, createCreativeTemplates } from './creative-templates.js';
import { MODEL_PROFILES } from '../shared/model-profiles.js';
import { musicTemplateSettings, templateFormFields, assertTemplateFields } from '../web/template-forms.js';
const reference=()=>make({name:'Electronic reference',preferredLocation:'runpod',selection:{music:'ace15-xl-sft'}});
test('portable round trip retains four pinned artifacts and exact workflow; history never establishes current readiness',()=>{
 const t=reference(),r=preview(JSON.parse(JSON.stringify(t)));assert.equal(t.artifacts.length,4);assert.deepEqual(r.template,t);assert.equal(r.canApply,true);
 assert.equal(r.template.settings.music.steps,50);assert.equal(r.template.settings.music.seed,20261019);assert.equal(r.template.settings.music.instrumental,true);
 assert.equal(r.workflows[0].historicalHardwareValidated,true);assert.equal(r.workflows[0].currentWorkerReady,false);assert.equal(r.currentReadinessVerified,false);
 assert.equal(r.workflows[0].minimumRequirementsEstablished,false);assert.equal(r.plan.profiles[0].hardwareAcceptance.tested.gpuId,'NVIDIA A100-SXM4-80GB');
 for(const target of ['local','runpod']){const p=preview(t,{target});assert.equal(p.plan.target,target);assert.equal(p.template.preferredLocation,'runpod');assert.equal(p.requiresInstallApproval,true);}
});
test('planner, lyrics, seed, duration, steps and vocal selection changes cannot inherit A100 history',()=>{
 for(const settings of [{lm:'qwen_1.7b_ace15.safetensors'},{lyrics:'A sung phrase'},{seed:123},{duration:45},{steps:20},{cfg:4},{instrumental:false}]){
  const t=make({name:'Changed',selection:{music:'ace15-xl-sft'},settings:{music:settings}});assert.equal(preview(t).workflows[0].historicalHardwareValidated,false,JSON.stringify(settings));
 }
 for(const id of ['ace15-xl-turbo','ace15-xl-base'])assert.equal(preview(make({name:id,selection:{music:id}})).workflows[0].historicalHardwareValidated,false);
 const otherPlanner=preview(make({name:'Manual companion',selection:{music:'ace15-xl-sft'},settings:{music:{lm:'qwen_1.7b_ace15.safetensors'}}}));assert.equal(otherPlanner.canApply,false);assert.match(otherPlanner.issues.join(' '),/companion outside/);
 const unchanged=reference();unchanged.settings.music={steps:20};assert.equal(preview(unchanged).canApply,false);
});
test('missing companions, injected artifacts and changed workflow identities block applying; install plan remains curated',()=>{
 for(const mutate of [t=>t.artifacts.pop(),t=>t.artifacts[0].sha256='f'.repeat(64),t=>t.workflows.music='0'.repeat(64)]){
  const t=reference();mutate(t);const p=preview(t);assert.equal(p.canApply,false);assert.ok(p.issues.length);assert.equal(p.plan.files.length,4);
 }
});
test('malformed templates, unsupported adapters, scripts, credentials and private paths are rejected without projection',()=>{
 for(const mutate of [t=>t.version=99,t=>t.script='curl bad',t=>t.selection.music='arbitrary-model',t=>t.settings.music={command:'run'},t=>t.name='C:\\Users\\private\\file',t=>t.description='/home/private/files',t=>t.creator='hf_'+'z'.repeat(30),t=>t.settings.music={caption:'Bearer '+'a'.repeat(30)},t=>t.settings.music={lm:'../x.safetensors'},t=>t.settings.music={steps:1.5},t=>t.settings.music={dit:'other.safetensors'},t=>t.settings.music={checkpoint:'wrong.safetensors'}]){const t=reference();mutate(t);assert.throws(()=>validate(t));}
 const t=reference();t.settings.music=JSON.parse('{"__proto__":{"polluted":true}}');assert.throws(()=>validate(t));assert.equal({}.polluted,undefined);
 t.settings.music={};t.workerUrl='https://private.example';assert.throws(()=>validate(t));
});
test('provider references are pinned, hash-verified identities with unknown adapter compatibility',()=>{
 const r={provider:'huggingface',id:'creator/model',revision:'a'.repeat(40),file:'weights.safetensors',folder:'loras',sha256:'b'.repeat(64),bytes:12};
 const t=make({name:'With reference',selection:{pictures:'sdxl-turbo'},references:[r]});assert.equal(preview(t).references[0].compatibility,'unknown');
 for(const change of [{revision:'main'},{file:'../../bad.safetensors'},{url:'https://bad.example'},{id:'creator/hf_'+'z'.repeat(30)},{folder:'custom_nodes'},{file:'code.py'},{sha256:'bad'}])assert.throws(()=>make({name:'Unsafe',selection:{pictures:'sdxl-turbo'},references:[{...r,...change}]}));
});
test('templates persist, duplicate, rename, delete and retain previous data without exporting internal identities',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'aiplay-templates-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=createCreativeTemplates({dir});
 const [a,b]=await Promise.all([store.put(reference()),store.put({...reference(),name:'Duplicate'})]);assert.notEqual(a.id,b.id);assert.equal((await store.list()).length,2);
 await store.put({...a.template,name:'Renamed'},a.id);assert.equal((await createCreativeTemplates({dir}).list())[0].template.name,'Renamed');
 await store.remove(b.id);assert.equal((await store.list()).length,1);const prior=JSON.parse(await readFile(path.join(dir,'creative-templates.previous.json')));assert.equal(prior.items.length,2);
 assert.doesNotMatch(JSON.stringify((await store.list())[0].template),/updatedAt|workerId|podId|apiKey/);
 const tampered=JSON.parse(await readFile(path.join(dir,'creative-templates.json'),'utf8'));tampered.items[0].template.apiKey='SYNTHETIC-NOT-A-SECRET';await writeFile(path.join(dir,'creative-templates.json'),JSON.stringify(tampered));await assert.rejects(store.list(),/Unsupported template field/);
 await writeFile(path.join(dir,'creative-templates.json'),'{broken');await assert.rejects(store.put(reference()));assert.equal(await readFile(path.join(dir,'creative-templates.json'),'utf8'),'{broken');
});
test('Music capture uses effective ACE controls and never MiniMax defaults or private reference handles',()=>{
 const spec={engine:'ace-step15',caption:'Electronic music',lyrics:'',instrumental:true,maxDuration:30,aceDit:MODEL_PROFILES.find(p=>p.id==='ace15-xl-sft').settings.dit,aceLm:'qwen_4b_ace15.safetensors',aceSteps:50,aceCfg:7,steps:8,aceCodes:true};
 const s=musicTemplateSettings(spec);assert.equal(s.steps,50);assert.equal(s.duration,30);assert.equal(s.cfg,7);assert.equal(s.lyrics,'');assert.equal(templateFormFields('music',s).aSteps,50);
 assert.throws(()=>musicTemplateSettings({...spec,lora:'private.safetensors'}));assert.throws(()=>musicTemplateSettings({...spec,aceCover:{song:'private.flac'}}));assert.throws(()=>musicTemplateSettings({engine:'minimax-music3'}));
 assert.equal(templateFormFields('pictures',{cfg:1},'runpod').imgRunPodCfg,1);assert.equal(templateFormFields('pictures',{cfg:1},'local').imgCfg,1);
 assert.equal(templateFormFields('video',{width:1280,height:704},'runpod').vidRunPodSize,'1280x704');
 const doc={getElementById:id=>id==='aLm'?{tagName:'SELECT',options:[{value:'qwen_4b_ace15.safetensors'}]}:{type:'range',min:'1',max:'50'}};
 assert.throws(()=>assertTemplateFields(doc,{aLm:'qwen_1.7b_ace15.safetensors'}));assert.throws(()=>assertTemplateFields(doc,{aSteps:60}));assert.doesNotThrow(()=>assertTemplateFields(doc,{aSteps:50,aLm:'qwen_4b_ace15.safetensors'}));
});
