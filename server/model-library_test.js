import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createModelLibraryRoutes } from './model-library.js';
import { makeCreativeTemplate } from './creative-templates.js';
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'aiplay-model-library-'));t.after(()=>rm(dir,{recursive:true,force:true}));let managerCalls=0,network=0,secrets=0,installs=0;
 const f={config:{uiPort:4457,modelsDir:path.join(dir,'models'),paths:{appData:dir}},busy:false};
 const route=createModelLibraryRoutes({config:f.config,json:(res,status,data)=>Object.assign(res,{status,data}),readBody:async req=>req.body,sameOriginLocalJson:req=>req.headers['content-type']==='application/json',getSecret:async()=>{secrets++;return null;},localFiles:async()=>[{folder:'loras',name:'custom.safetensors',bytes:12}],localObjects:async()=>({}),busy:async()=>f.busy,fetchFn:async()=>{network++;throw Error('Offline');},managerFactory:async()=>{managerCalls++;return {status:()=>({catalogVersion:1,bundles:[],active:null}),installCatalog:async()=>{installs++;return {active:'fixture'};},cancel:()=>({active:null})};}});
 f.call=async(method,endpoint,body,headers={})=>{const res={};assert.equal(await route({method,body,headers:{host:'127.0.0.1:4457','content-type':'application/json',...headers}},res,new URL('http://127.0.0.1:4457/api/model-library/'+endpoint)),true);return res;};
 f.counts=()=>({managerCalls,network,secrets,installs});return f;
}
test('template import/preview/save/list/deletion have zero provider, credential and installer calls',async t=>{
 const f=await fixture(t),template=makeCreativeTemplate({name:'Shared',selection:{music:'ace15-xl-sft'},preferredLocation:'runpod'});
 const p=await f.call('POST','templates',{action:'preview',template,target:'runpod'});assert.equal(p.status,200);assert.equal(p.data.currentReadinessVerified,false);
 const saved=await f.call('POST','templates',{action:'save',template});assert.equal(saved.status,200);
 assert.equal((await f.call('GET','templates')).data.items.length,1);
 assert.equal((await f.call('POST','templates',{action:'delete',id:saved.data.id,confirm:'DELETE TEMPLATE'})).status,200);
 assert.deepEqual(f.counts(),{managerCalls:0,network:0,secrets:0,installs:0});
});
test('local inventory and transfer status use existing local managers; launch boundaries and approval remain enforced',async t=>{
 const f=await fixture(t);assert.equal((await f.call('GET','disk')).data.files[0].relative,'loras/custom.safetensors');
 assert.equal((await f.call('GET','setup')).data.downloadable,true);
 const body={selection:{provider:'huggingface'},expected:{sha256:'a'.repeat(64),bytes:12},acceptLicense:true};
 f.config.remoteOnly=true;assert.equal((await f.call('POST','install',body)).status,400);f.config.remoteOnly=false;f.busy=true;assert.equal((await f.call('POST','install',body)).status,400);f.busy=false;
 assert.equal((await f.call('POST','install',{...body,acceptLicense:false})).status,400);assert.equal(f.counts().installs,0);
 assert.equal((await f.call('POST','install',body)).status,202);assert.equal(f.counts().installs,1);
});
test('curated discovery reuses shared profiles for both locations without provider calls',async t=>{
 const f=await fixture(t);for(const target of ['local','runpod']){const r=await f.call('GET','profiles?target='+target);assert.equal(r.status,200);assert.equal(r.data.target,target);assert.ok(r.data.profiles.some(p=>p.id==='ace15-xl-sft'));assert.ok(r.data.profiles.some(p=>p.category==='pictures'));assert.ok(r.data.profiles.some(p=>p.category==='video'));}
 assert.deepEqual(f.counts(),{managerCalls:0,network:0,secrets:0,installs:0});
});
test('library and template requests reject DNS rebinding, foreign origins and non-JSON mutations',async t=>{
 const f=await fixture(t);for(const headers of [{host:'evil.example'},{origin:'https://evil.example'},{'content-type':'text/plain'}])assert.equal((await f.call('POST','templates',{action:'capture'},headers)).status,403);
 assert.equal((await f.call('POST','disk/delete',{})).status,405);assert.equal(f.counts().managerCalls,0);
});
