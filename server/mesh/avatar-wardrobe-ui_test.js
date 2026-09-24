import test from 'node:test';
import assert from 'node:assert/strict';
import {createWardrobePreview,mountAvatarWardrobeUI} from '../../web/avatar-wardrobe-ui.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const part=id=>({id,files:{glb:id}});
function setup(){const waiting=new Map(),disposed=[],replaced=[];let ended=0;const runtime={replace:v=>replaced.push(v.map(p=>p.manifest.id)),update(){},dispose(){ended++;}};
 return {waiting,disposed,replaced,runtime,get ended(){return ended;},preview:createWardrobePreview({runtime,load:id=>{const d=deferred();waiting.set(id,d);return d.promise;},dispose:v=>disposed.push(v)})};}
test('a late outfit cannot overwrite a newer selection and releases its loaded meshes',async()=>{
 const f=setup(),old=f.preview.apply([part('old')]),next=f.preview.apply([part('new')]);
 f.waiting.get('new').resolve('new-mesh');assert.equal(await next,true);
 f.waiting.get('old').resolve('old-mesh');assert.equal(await old,false);
 assert.deepEqual(f.replaced,[['new']]);assert.deepEqual(f.disposed,['old-mesh']);
});
test('partial load failure preserves last complete outfit and disposes successful siblings',async()=>{
 const f=setup(),first=f.preview.apply([part('good')]);f.waiting.get('good').resolve('kept');await first;
 const failed=f.preview.apply([part('a'),part('b')]);f.waiting.get('a').resolve('a-mesh');f.waiting.get('b').reject(Error('gone'));
 await assert.rejects(failed,/gone/);assert.deepEqual(f.replaced,[['good']]);assert.deepEqual(f.disposed,['a-mesh']);
});
test('rejected skeleton attachment releases all candidates',async()=>{
 const f=setup();f.runtime.replace=()=>{throw Error('skeleton mismatch');};const p=f.preview.apply([part('a')]);f.waiting.get('a').resolve('mesh');
 await assert.rejects(p,/skeleton mismatch/);assert.deepEqual(f.disposed,['mesh']);
});
test('disposing a model while loading cannot reattach its outfit',async()=>{
 const f=setup(),p=f.preview.apply([part('a')]);f.preview.dispose();f.preview.dispose();f.waiting.get('a').resolve('mesh');
 assert.equal(await p,false);assert.equal(f.ended,1);assert.deepEqual(f.replaced,[]);assert.deepEqual(f.disposed,['mesh']);assert.equal(await f.preview.apply([]),false);
});

test('cancelling a pending preview keeps the current outfit even when no replacement can be loaded',async()=>{
 const f=setup(),p=f.preview.apply([part('old')]);f.preview.cancelPending();f.waiting.get('old').resolve('unused');
 assert.equal(await p,false);assert.deepEqual(f.replaced,[]);assert.deepEqual(f.disposed,['unused']);
});

const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function node(){return {children:[],textContent:'',hidden:false,disabled:false,value:'',files:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=[...items];}};}
function uiFixture({load=async()=>({scene:{traverse(){}}}),respond}={}){
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const documentRef={hidden:false,getElementById:get,createElement:()=>node()};
 get('wardrobe-form').elements=Object.fromEntries(['name','slot','source','license','file'].map(name=>[name,node()]));
 const row={id:'base',inspection:{sha256:'hash'}},parts=[{...part('coat-a'),name:'Coat A',slot:'outfit',source:'local',license:'CC0'},
 {...part('coat-b'),name:'Coat B',slot:'outfit',source:'local',license:'CC0'}],calls=[],replaced=[];let poll;
 const selection=(look_id=null)=>({id:'base',sha256:'hash',look_id,revision:0,part_ids:[],parts:[]});
 const api=async body=>{calls.push(structuredClone(body));const override=await respond?.(body);if(override!==undefined)return override;
 if(body.action==='inventory')return {slots:['outfit']};if(body.action==='list')return {sha256:'hash',parts};if(body.action==='selection')return selection(body.look_id);if(body.action==='select')return {...selection(body.look_id),revision:body.expected_revision+1,part_ids:body.part_ids};};
 const runtime={replace:entries=>replaced.push(entries.map(e=>e.manifest.id)),update(){},dispose(){}};
 const ui=mountAvatarWardrobeUI({row,load,api,documentRef,runtime,setTimer:fn=>{poll=fn;return 1;},clearTimer(){}});
 const checkbox=index=>get('wardrobe-list').children[index].children[0].children[0];
 return {ui,get,calls,replaced,selection,parts,checkbox,poll:()=>poll()};
}

test('failed saved outfit preview is labelled unavailable and Reset retries the same revision',async()=>{
 let failed=true;
 const f=uiFixture({load:async()=>{if(failed)throw Error('Network failed');return {scene:{traverse(){}}};},respond:body=>body.action==='selection'?{id:'base',sha256:'hash',look_id:null,revision:2,part_ids:['coat-a'],parts:[]}:undefined});
 await f.ui.setLook(null);assert.equal(f.get('wardrobe-state').textContent,'Preview unavailable');assert.equal(f.get('wardrobe-reset').disabled,false);assert.equal(f.get('wardrobe-save').disabled,true);
 failed=false;await f.get('wardrobe-reset').onclick();assert.equal(f.get('wardrobe-state').textContent,'1 equipped');assert.equal(f.get('wardrobe-note').hidden,true);assert.equal(f.get('wardrobe-reset').disabled,true);f.ui.dispose();
});

test('selecting a replacement in the same slot previews one part and cannot delete the equipped draft',async()=>{
 const f=uiFixture();await f.ui.setLook(null);
 f.checkbox(0).checked=true;f.checkbox(0).onchange();await flush();assert.deepEqual(f.replaced.at(-1),['coat-a']);
 assert.equal(f.get('wardrobe-list').children[0].children[2].disabled,true);
 f.checkbox(1).checked=true;f.checkbox(1).onchange();await flush();assert.deepEqual(f.replaced.at(-1),['coat-b']);assert.equal(f.checkbox(0).checked,false);
 await f.get('wardrobe-save').onclick();assert.deepEqual(f.calls.find(call=>call.action==='select').part_ids,['coat-b']);f.ui.dispose();
});

test('late named-look selection cannot overwrite a new base outfit context',async()=>{
 const old=deferred(),f=uiFixture({respond:body=>body.action==='selection'&&body.look_id==='look-old'?old.promise:undefined});
 const loading=f.ui.setLook({id:'look-old',name:'Old look'});await flush();await f.ui.setLook(null);
 old.resolve({...f.selection('look-old'),part_ids:['coat-a']});await loading;assert.equal(f.get('wardrobe-context').textContent,'Base outfit');assert.deepEqual(f.replaced.at(-1),[]);f.ui.dispose();
});

test('MCP selection polling does not replace an unsaved local draft',async()=>{
 const f=uiFixture();await f.ui.setLook(null);f.checkbox(0).checked=true;f.checkbox(0).onchange();await flush();
 const before=f.calls.length;await f.poll();assert.equal(f.calls.length,before);assert.equal(f.get('wardrobe-state').textContent,'Unsaved outfit');f.ui.dispose();
});
