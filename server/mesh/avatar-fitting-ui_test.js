import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {mountAvatarFitting} from '../../web/avatar-fitting.js';

const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(respond){
 const nodes=new Map(),make=()=>({children:[],value:'',disabled:false,textContent:'',hidden:false,append(v){this.children.push(v);},replaceChildren(){this.children=[];}}),get=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
 const documentRef={getElementById:get,createElement:make},form=get('fitting-form');form.elements=Object.fromEntries(['file','name','slot','source','license','reference_node','alignment','clearance','max_displacement','max_scale_change'].map(key=>[key,make()]));
 Object.assign(form.elements.file,{files:[new File(['part'],'coat.glb')]});form.elements.name.value='Coat';form.elements.slot.value='outfit';form.elements.source.value='Local';form.elements.license.value='CC0';form.elements.alignment.value='bounds';form.elements.clearance.value='0.006';form.elements.max_displacement.value='0.04';form.elements.max_scale_change.value='0.25';
 const calls=[],timers=new Map(),prepared=[];let timer=0;
 const api=async input=>{calls.push(structuredClone(input));const result=await respond?.(input);if(result!==undefined)return result;if(input.action==='status')return {available:true};if(input.action==='inspect')return {source_sha256:'hash',target_id:'target',target_sha256:'target-hash',skeleton:'skeleton',reference_surfaces:[{name:'Body',mesh_node:0,primitive:0}]};if(input.action==='submit')return {id:'job',state:'running'};};
 const mounted=mountAvatarFitting({row:{id:'base',inspection:{sha256:'hash'}},documentRef,api,onPrepared:async part=>prepared.push(part),setTimer:fn=>{const id=++timer;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
 return {mounted,get,form,calls,timers,prepared,async tick(){const [id,fn]=timers.entries().next().value||[];if(fn){timers.delete(id);fn();await flush();}},async ready(){await flush();await get('fitting-inspect').onclick();},async submit(){await form.onsubmit({preventDefault(){}});}};
}

test('transient job polling failure retries without losing the current job',async()=>{
 let reads=0;const f=fixture(input=>{if(input.action==='get'){reads++;if(reads===1)throw Error('Temporary network issue');return {id:'job',state:'complete',result:{output:'local-part.glb',vertices:717,joints:154}};}});
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
 pending.resolve({id:'job',state:'complete',result:{output:'unused.glb',vertices:10,joints:3}});await flush();assert.equal(f.timers.size,0);assert.notEqual(f.get('fitting-state').textContent,'Ready to review');assert.equal(f.prepared.length,0);
});

test('the submitted part slot is retained for wardrobe admission without leaking into strict fitting input',async()=>{
 const f=fixture(input=>input.action==='get'?{id:'job',state:'complete',result:{output:'hair.glb',vertices:717,joints:154}}:undefined);
 await f.ready();f.form.elements.slot.value='hair';await f.submit();f.form.elements.slot.value='shoes';await f.tick();await f.get('fitting-add').onclick();
 assert.equal(f.prepared[0].slot,'hair');assert.equal(Object.hasOwn(f.calls.find(call=>call.action==='submit'),'slot'),false);f.mounted.dispose();
});
