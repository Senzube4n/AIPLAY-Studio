import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {mountAvatarFitting} from '../../web/avatar-fitting.js';

const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const jobId='fit_11111111-1111-4111-8111-111111111111';
const memory=()=>{const values=new Map();return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
function fixture(respond,{storage=memory(),row={id:'base',inspection:{sha256:'hash'}}}={}){
 const nodes=new Map(),make=()=>({children:[],value:'',disabled:false,textContent:'',hidden:false,append(v){this.children.push(v);},replaceChildren(){this.children=[];}}),get=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
 const documentRef={getElementById:get,createElement:make},form=get('fitting-form');form.elements=Object.fromEntries(['file','name','slot','source','license','reference_node','alignment','clearance','max_displacement','max_scale_change'].map(key=>[key,make()]));
 Object.assign(form.elements.file,{files:[new File(['part'],'coat.glb')]});form.elements.name.value='Coat';form.elements.slot.value='outfit';form.elements.source.value='Local';form.elements.license.value='CC0';form.elements.alignment.value='bounds';form.elements.clearance.value='0.006';form.elements.max_displacement.value='0.04';form.elements.max_scale_change.value='0.25';
 const calls=[],timers=new Map(),prepared=[];let timer=0;
 const api=async input=>{calls.push(structuredClone(input));const result=await respond?.(input);if(result!==undefined)return ['submit','get'].includes(input.action)?{avatar_id:row.id,source_sha256:row.inspection.sha256,name:'Coat',source:'Local',license:'CC0',...result}:result;if(input.action==='status')return {available:true};if(input.action==='inspect')return {source_sha256:row.inspection.sha256,target_id:'target',target_sha256:'target-hash',skeleton:'skeleton',reference_surfaces:[{name:'Body',mesh_node:0,primitive:0}]};if(input.action==='submit')return {id:jobId,state:'running',avatar_id:row.id,source_sha256:row.inspection.sha256,name:'Coat',source:'Local',license:'CC0'};};
 const mounted=mountAvatarFitting({row,documentRef,api,storage,onPrepared:async part=>prepared.push(part),setTimer:fn=>{const id=++timer;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
 return {mounted,get,form,calls,timers,prepared,storage,row,async tick(){const [id,fn]=timers.entries().next().value||[];if(fn){timers.delete(id);fn();await flush();}},async ready(){await flush();await get('fitting-inspect').onclick();},async submit(){await form.onsubmit({preventDefault(){}});}};
}

test('transient job polling failure retries without losing the current job',async()=>{
 let reads=0;const f=fixture(input=>{if(input.action==='get'){reads++;if(reads===1)throw Error('Temporary network issue');return {id:jobId,state:'complete',result:{output:'local-part.glb',vertices:717,joints:154}};}});
 await f.ready();await f.submit();assert.equal(f.get('fitting-submit').disabled,true);await f.tick();assert.equal(f.timers.size,1);await f.tick();assert.equal(f.get('fitting-state').textContent,'Ready to review');
 await f.get('fitting-add').onclick();assert.equal(f.prepared[0].name,'Coat');assert.equal(f.get('fitting-state').textContent,'Added to wardrobe');f.mounted.dispose();
});

test('changing the target invalidates an in-flight inspection and its available reference surfaces',async()=>{
 const pending=deferred(),f=fixture(input=>input.action==='inspect'?pending.promise:undefined);await flush();const work=f.get('fitting-inspect').onclick();await flush();
 f.form.elements.file.files=[new File(['other'],'other.glb')];f.form.elements.file.onchange();pending.resolve({source_sha256:'hash',reference_surfaces:[{name:'Stale',mesh_node:0,primitive:0}]});await work;
 assert.equal(f.get('fitting-submit').disabled,true);assert.equal(f.get('fitting-state').textContent,'Choose a part');f.mounted.dispose();
});

test('fitting rejects names wardrobe cannot accept before submitting an expensive job',async()=>{
 const f=fixture();await f.ready();f.form.elements.name.value='x'.repeat(81);await f.submit();assert.equal(f.calls.some(call=>call.action==='submit'),false);assert.match(f.get('fitting-note').textContent,/80 characters/);f.mounted.dispose();
});

test('disposing a pending fitting poll prevents status writes and rescheduling',async()=>{
 const pending=deferred(),f=fixture(input=>input.action==='get'?pending.promise:undefined);await f.ready();await f.submit();await f.tick();f.mounted.dispose();
 pending.resolve({id:jobId,state:'complete',result:{output:'unused.glb',vertices:10,joints:3}});await flush();assert.equal(f.timers.size,0);assert.notEqual(f.get('fitting-state').textContent,'Ready to review');assert.equal(f.prepared.length,0);
});

test('the submitted part slot is retained for wardrobe admission without leaking into strict fitting input',async()=>{
 const f=fixture(input=>input.action==='get'?{id:jobId,state:'complete',result:{output:'hair.glb',vertices:717,joints:154}}:undefined);
 await f.ready();f.form.elements.slot.value='hair';await f.submit();f.form.elements.slot.value='shoes';await f.tick();await f.get('fitting-add').onclick();
 assert.equal(f.prepared[0].slot,'hair');assert.equal(Object.hasOwn(f.calls.find(call=>call.action==='submit'),'slot'),false);f.mounted.dispose();
});

test('a fitting job resumes for the same avatar file after remount and keeps its submitted slot',async()=>{
 const storage=memory(),first=fixture(undefined,{storage});await first.ready();first.form.elements.slot.value='hair';await first.submit();first.mounted.dispose();
 let reads=0;const resumed=fixture(input=>input.action==='get'?(++reads===1
  ?{id:jobId,state:'running'}
  :{id:jobId,state:'complete',result:{output:'fitted-hair.glb',vertices:717,joints:154}}):undefined,{storage});
 await flush();assert.equal(resumed.get('fitting-state').textContent,'Preparing fit');assert.equal(resumed.timers.size,1);
 resumed.form.elements.slot.value='shoes';await resumed.tick();assert.equal(resumed.get('fitting-state').textContent,'Ready to review');
 await resumed.get('fitting-add').onclick();assert.deepEqual(resumed.prepared,[{path:'fitted-hair.glb',name:'Coat',slot:'hair',source:'Local',license:'CC0'}]);
 assert.equal(storage.values.size,0);resumed.mounted.dispose();
});

test('a saved fit cannot cross avatar identity or source hash, including a mismatched server reply',async()=>{
 const storage=memory(),first=fixture(undefined,{storage});await first.ready();await first.submit();first.mounted.dispose();
 const changed=fixture(input=>{if(input.action==='get')throw Error('Wrong avatar fetched');},{storage,row:{id:'base',inspection:{sha256:'changed'}}});
 await flush();assert.equal(changed.calls.some(call=>call.action==='get'),false);changed.mounted.dispose();
 const wrong=fixture(input=>input.action==='get'?{id:jobId,state:'complete',source_sha256:'other-hash',result:{output:'wrong.glb',vertices:2,joints:2}}:undefined,{storage});
 await flush();assert.equal(wrong.get('fitting-add').disabled,true);assert.equal(wrong.prepared.length,0);
 assert.match(wrong.get('fitting-note').textContent,/another avatar|older avatar/i);assert.equal(storage.values.size,0);wrong.mounted.dispose();
});

test('terminal fitting jobs clear recovery while temporary lookup errors preserve it',async()=>{
 for(const state of ['failed','interrupted']){
  const storage=memory(),first=fixture(undefined,{storage});await first.ready();await first.submit();first.mounted.dispose();
  const resumed=fixture(input=>input.action==='get'?{id:jobId,state,error:'Fit stopped.'}:undefined,{storage});
  await flush();assert.equal(resumed.get('fitting-state').textContent,'Fit stopped');assert.equal(resumed.get('fitting-add').disabled,true);assert.equal(storage.values.size,0);resumed.mounted.dispose();
 }
 const storage=memory(),first=fixture(undefined,{storage});await first.ready();await first.submit();first.mounted.dispose();
 const temporary=fixture(input=>{if(input.action==='get')throw Error('Network unavailable');},{storage});
 await flush();assert.equal(storage.values.size,1);assert.equal(temporary.get('fitting-state').textContent,'Check job');temporary.mounted.dispose();
});

test('Find job reopens a persisted result without local storage and uses the chosen slot',async()=>{
 const storage={getItem(){throw Error('Storage blocked');},setItem(){throw Error('Storage blocked');},removeItem(){throw Error('Storage blocked');}};
 const f=fixture(input=>input.action==='get'?{id:jobId,state:'complete',name:'Saved part',source:'Artist',license:'CC0',result:{output:'saved.glb',vertices:12,joints:4}}:undefined,{storage});
 await flush();f.form.elements.slot.value='accessory';f.get('fitting-find-id').value=jobId;await f.get('fitting-find').onclick();
 assert.equal(f.get('fitting-state').textContent,'Ready to review');await f.get('fitting-add').onclick();
 assert.deepEqual(f.prepared,[{path:'saved.glb',name:'Saved part',slot:'accessory',source:'Artist',license:'CC0'}]);f.mounted.dispose();
});

test('a late recovery response after disposal never changes the next avatar view',async()=>{
 const storage=memory(),first=fixture(undefined,{storage});await first.ready();await first.submit();first.mounted.dispose();
 const pending=deferred(),resumed=fixture(input=>input.action==='get'?pending.promise:undefined,{storage});await flush();
 resumed.mounted.dispose();pending.resolve({id:jobId,state:'complete',result:{output:'unused.glb',vertices:2,joints:2}});await flush();
 assert.equal(resumed.get('fitting-add').disabled,true);assert.equal(resumed.timers.size,0);assert.equal(resumed.prepared.length,0);
});

test('a submitted job is still recoverable if its response arrives after navigating away',async()=>{
 const storage=memory(),pending=deferred(),first=fixture(input=>input.action==='submit'?pending.promise:undefined,{storage});await first.ready();
 const submitting=first.submit();await flush();first.mounted.dispose();pending.resolve({id:jobId,state:'running'});await submitting;
 assert.equal(storage.values.size,1);assert.equal(first.get('fitting-job').textContent,'');
 const resumed=fixture(input=>input.action==='get'?{id:jobId,state:'complete',result:{output:'part.glb',vertices:12,joints:4}}:undefined,{storage});
 await flush();assert.equal(resumed.get('fitting-state').textContent,'Ready to review');resumed.mounted.dispose();
});

test('a missing fitting job is discarded while leaving a usable lookup error',async()=>{
 const storage=memory(),first=fixture(undefined,{storage});await first.ready();await first.submit();first.mounted.dispose();
 const resumed=fixture(input=>{if(input.action==='get')throw Object.assign(Error('Fitting job not found.'),{status:404});},{storage});
 await flush();assert.equal(storage.values.size,0);assert.match(resumed.get('fitting-note').textContent,/not found/);resumed.mounted.dispose();
});
