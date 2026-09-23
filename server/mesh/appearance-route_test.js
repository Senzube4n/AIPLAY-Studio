import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import * as THREE from 'three';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { glbDoc, packGlb } from './fixtures.js';
import { createAvatarRoutes } from './avatar.js';
import { avatarTools } from '../mcp-avatars.js';
import * as provenance from '../provenance.js';

async function setup(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'avatar-appearance-http-'));
  const ledgerScope={dir:path.join(directory,'ledger')};
  const events=[];
  const routes=createAvatarRoutes({directory,
    json:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));},
    provenance:{append:async(scope,event)=>{assert.equal(scope,'library');const written=await provenance.append(ledgerScope,event);events.push(written);return written;},actorFrom:provenance.actorFrom},
  });
  const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost')).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>{res.writeHead(500);res.end(error.message);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(body,headers={})=>{const values={'Content-Type':'application/json',Origin:base,'x-aiplay-actor':'agent:http-appearance',...headers};const response=await fetch(base+'/api/avatars',{method:'POST',headers:Object.fromEntries(Object.entries(values).filter(([,value])=>value!==undefined)),body:JSON.stringify(body)});return {response,body:await response.json()};};
  const call=async body=>{const result=await post(body);assert.equal(result.response.status,200,JSON.stringify(result.body));return result.body;};
  const doc=glbDoc({skinned:true});
  doc.materials=[{name:'Fabric',pbrMetallicRoughness:{baseColorFactor:[.3,.5,.7,1],metallicFactor:0,roughnessFactor:.6}}];
  doc.meshes[0].primitives[0].material=0;
  doc.nodes.push({name:'Accessory',mesh:0,skin:0});doc.scenes[0].nodes.push(4);
  const bytes=packGlb(doc);
  const row=await call({action:'import',data_base64:bytes.toString('base64'),name:'HTTP fixture',source:'Procedural fixture',license:'Test only',skeleton_family:'qa-three-joints',facing:'+Z'});
  const request=(settings={})=>({action:'appearance_save',id:row.id,sha256:row.inspection.sha256,expected_revision:0,name:'First look',settings});
  return {directory,ledgerScope,events,base,post,call,row,bytes,request};
}

test('actual avatar route supports inventory, save, activate, export and deletion without modifying GLB',async t=>{
  const f=await setup(t),id=f.row.id;
  const inventory=await f.call({action:'appearance_inventory',id});
  assert.deepEqual(inventory.nodes.map(node=>node.index),[0,4]);
  assert.equal(inventory.sha256,f.row.inspection.sha256);
  assert.deepEqual(await f.call({action:'appearance_list',id}),[]);
  assert.equal(await f.call({action:'appearance_active',id}),null);
  const saved=await f.call(f.request({hidden_nodes:[4],material_colors:{'0':[.9,.2,.5,1]}}));
  assert.equal(saved.revision,1);
  assert.equal(saved.actor,'agent:http-appearance');
  assert.deepEqual(await f.call({action:'appearance_get',id,look_id:saved.id}),saved);
  assert.deepEqual(await f.call({action:'appearance_list',id}),[saved]);
  assert.equal(await f.call({action:'appearance_active',id}),null);
  assert.deepEqual(await f.call({action:'appearance_activate',id,look_id:saved.id,sha256:inventory.sha256}),saved);
  const exported=await f.call({action:'export',id});
  assert.deepEqual(exported.appearance,saved);
  assert.equal(exported.files.look,`/api/avatars/${id}/appearance.json`);
  const download=await fetch(f.base+exported.files.look);
  assert.equal(download.status,200);
  assert.match(download.headers.get('Cache-Control'),/no-store/);
  assert.deepEqual(await download.json(),saved);
  assert.deepEqual(Buffer.from(await(await fetch(f.base+exported.files.glb)).arrayBuffer()),f.bytes);
  assert.deepEqual(await readFile(path.join(f.directory,id,'avatar.glb')),f.bytes);
  assert.deepEqual(await f.call({action:'appearance_delete',id,look_id:saved.id,sha256:inventory.sha256,expected_revision:1}),{deleted:saved.id,avatarId:id});
  assert.equal(await f.call({action:'appearance_active',id}),null);
  assert.deepEqual(await f.call({action:'appearance_list',id}),[]);
  const noLook=await f.call({action:'export',id});
  assert.equal(noLook.appearance,undefined);assert.equal(noLook.files.look,undefined);
  assert.ok(f.events.some(event=>event.type==='preset_apply'&&event.data.op==='appearance_activate'));
  assert.ok(f.events.some(event=>event.type==='edit'&&event.data.op==='appearance_delete'));
});

test('real provenance writer accepts appearance operations, verifies its chain and preserves HTTP actor honesty',async t=>{
  const f=await setup(t),id=f.row.id;
  const look=await f.call(f.request());
  const activated=await f.post({action:'appearance_activate',id,look_id:look.id,sha256:look.sha256},{'x-aiplay-actor':undefined});
  assert.equal(activated.response.status,200,JSON.stringify(activated.body));
  const edited=await f.post({...f.request({hidden_nodes:[4]}),look_id:look.id,expected_revision:1},{'x-aiplay-actor':'user'});
  assert.equal(edited.response.status,200,JSON.stringify(edited.body));
  const before=(await provenance.read(f.ledgerScope)).total;
  assert.equal((await f.post({...f.request(),look_id:look.id,expected_revision:1})).response.status,409);
  assert.equal((await provenance.read(f.ledgerScope)).total,before);
  await f.call({action:'appearance_delete',id,look_id:look.id,sha256:look.sha256,expected_revision:2});
  const result=await provenance.read(f.ledgerScope),operations=result.events.filter(event=>event.data.op?.startsWith('appearance_'));
  assert.deepEqual(operations.map(event=>[event.type,event.data.op,event.actor]),[
    ['edit','appearance_save','agent:http-appearance'],['preset_apply','appearance_activate','user'],
    ['edit','appearance_save','system'],['edit','appearance_delete','agent:http-appearance'],
  ]);
  for(const event of operations){
    assert.equal(event.data.avatarId,id);assert.equal(event.data.lookId,look.id);assert.equal(event.data.sha256,look.sha256);
    assert.equal(event.asset,event.type==='preset_apply'?`avatar/${id}`:`avatar/${id}/looks/${look.id}`);
  }
  assert.equal(result.corrupt,0);
  const chain=await provenance.verify(f.ledgerScope);assert.equal(chain.ok,true);assert.equal(chain.count,5);
});

test('HTTP and registered MCP tools preserve the same settings and revision conflicts',async t=>{
  const f=await setup(t),id=f.row.id,calls=[];
  const tools=avatarTools(async(method,route,body)=>{calls.push({method,route,body});assert.equal(route,'/api/avatars');return f.call(body);});
  const run=(name,args)=>tools.find(tool=>tool.name===`avatar_appearance_${name}`).run(args);
  const inventory=await run('inventory',{id});
  const {action,...request}=f.request({hidden_nodes:[4],material_colors:{'0':[.8,.6,.4,1]}});
  const saved=await run('save',request);
  assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars',body:{...request,action:'appearance_save'}});
  assert.deepEqual((await f.call({action:'appearance_get',id,look_id:saved.id})).settings,request.settings);
  await run('activate',{id,look_id:saved.id,sha256:inventory.sha256});
  assert.equal((await run('active',{id})).id,saved.id);
  const edit={...request,action:'appearance_save',look_id:saved.id,expected_revision:1,name:'Changed'};
  assert.equal((await f.call(edit)).revision,2);
  assert.equal((await f.post(edit)).response.status,409);
  assert.equal((await f.post({action:'appearance_delete',id,look_id:saved.id,sha256:inventory.sha256,expected_revision:1})).response.status,409);
  assert.equal((await run('active',{id})).revision,2);
  assert.equal((await f.post({...edit,settings:{hidden_nodes:[1]}})).response.status,400);
  assert.equal((await f.post({...edit,path:'C:/not-an-appearance.glb'})).response.status,400);
});

test('all appearance actions and download routes retain loopback origin and Host gating',async t=>{
  const f=await setup(t),id=f.row.id;
  const saved=await f.call(f.request());
  const requests=[
    {action:'appearance_inventory',id},{action:'appearance_list',id},{action:'appearance_get',id,look_id:saved.id},
    f.request(),{action:'appearance_activate',id,look_id:saved.id,sha256:saved.sha256},
    {action:'appearance_active',id},{action:'appearance_delete',id,look_id:saved.id,sha256:saved.sha256,expected_revision:1},
  ];
  for(const request of requests)for(const headers of [{Origin:'https://example.test'},{Origin:'null'},{Origin:'http://127.0.0.1:1'},{'Sec-Fetch-Site':'cross-site'}]){
    assert.equal((await f.post(request,headers)).response.status,403,request.action);
  }
  const response=await fetch(`${f.base}/api/avatars/${id}/appearance.json`,{headers:{Origin:'https://example.test'}});
  assert.equal(response.status,403);
  const hostStatus=await new Promise((resolve,reject)=>http.get(`${f.base}/api/avatars/${id}/appearance.json`,{headers:{Host:'evil.test'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject));
  assert.equal(hostStatus,403);
  assert.deepEqual(await f.call({action:'appearance_get',id,look_id:saved.id}),saved);
});

test('source tampering returns conflicts through every appearance read, mutation and export',async t=>{
  const f=await setup(t),id=f.row.id;
  const saved=await f.call(f.request());
  await f.call({action:'appearance_activate',id,look_id:saved.id,sha256:saved.sha256});
  await writeFile(path.join(f.directory,id,'avatar.glb'),Buffer.concat([f.bytes,Buffer.from('changed')]));
  for(const request of [
    {action:'appearance_inventory',id},{action:'appearance_list',id},{action:'appearance_get',id,look_id:saved.id},
    f.request(),{action:'appearance_activate',id,look_id:saved.id,sha256:saved.sha256},
    {action:'appearance_active',id},{action:'appearance_delete',id,look_id:saved.id,sha256:saved.sha256,expected_revision:1},{action:'export',id},
  ])assert.equal((await f.post(request)).response.status,409,request.action);
  assert.equal((await fetch(`${f.base}/api/avatars/${id}/appearance.json`)).status,409);
});

const uiSource=(await readFile(new URL('../../web/avatar-appearance.js',import.meta.url),'utf8')).replace(/^import .*?;\r?\n/,'').replace('export async function','async function');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function uiFixture(overrides={}) {
  class Element {
    constructor(){this.children=[];this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.textContent='';}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=[...items];}
    add(item){this.children.push(item);}
  }
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  node('appearance-panel').hidden=true;
  const inventory={sha256:'a'.repeat(64),nodes:[{index:0,name:'Body',activeInScene:true}],materials:[],expressions:[],spring:{supported:false,chains:0}};
  let active=null,looks=[],current=true,interval;
  const calls=[],applied=[],errors=[];
  const api=async body=>{
    calls.push(structuredClone(body));
    if(overrides[body.action])return overrides[body.action](body);
    if(body.action==='appearance_inventory')return inventory;
    if(body.action==='appearance_active')return active;
    if(body.action==='appearance_list')return looks;
    if(body.action==='appearance_save'){const saved={id:body.look_id||'look-1',revision:(body.expected_revision||0)+1,name:body.name,settings:body.settings,personaAttribution:{personaId:body.persona_id}};looks=[saved];return saved;}
    if(body.action==='appearance_activate'){active=looks.find(look=>look.id===body.look_id);return active;}
    if(body.action==='appearance_delete'){looks=[];active=null;return {deleted:body.look_id};}
    assert.fail(body.action);
  };
  const context=vm.createContext({THREE,structuredClone,Option:class{constructor(text,value){this.text=text;this.value=value;}},document:{getElementById:node,createElement:()=>new Element(),hidden:false},setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{interval=null;}});
  vm.runInContext(uiSource,context);
  const mounted=context.mountAvatarAppearance({row:{id:'avatar'},runtime:{apply:value=>applied.push(structuredClone(value))},api,status:(message,error)=>errors.push({message,error}),isCurrent:()=>current});
  return {mounted,node,calls,applied,errors,poll:()=>interval?.(),setCurrent:value=>{current=value;},setActive:value=>{active=value;looks=value?[value]:[];}};
}

test('UI does not show springs on a plain GLB and prevents duplicate saves while pending',async()=>{
  const saved={id:'saved',name:'Draft',settings:{},revision:1};
  const save=deferred(),f=uiFixture({appearance_save:()=>save.promise,appearance_activate:()=>saved});await f.mounted;
  assert.equal(f.node('appearance-springs').checked,false);assert.equal(f.node('appearance-springs').disabled,true);
  f.node('appearance-name').value='Draft';f.node('appearance-name').oninput();
  const first=f.node('appearance-save').onclick();await f.node('appearance-save').onclick();
  assert.equal(f.calls.filter(call=>call.action==='appearance_save').length,1);
  assert.equal(f.node('appearance-new').disabled,true);
  save.resolve(saved);await first;
  assert.equal(f.node('appearance-save').disabled,false);
  assert.deepEqual(f.errors,[]);
});

test('a late active poll cannot overwrite a new unsaved draft',async()=>{
  let deferredPoll;
  const f=uiFixture({appearance_active:()=>deferredPoll?.promise||null});await f.mounted;
  deferredPoll=deferred();const pending=f.poll();
  f.node('appearance-new').onclick();f.node('appearance-name').value='Keep my draft';f.node('appearance-name').oninput();
  deferredPoll.resolve({id:'remote',revision:3,name:'Remote update',settings:{}});await pending;
  assert.equal(f.node('appearance-name').value,'Keep my draft');
  assert.equal(f.node('appearance-state').textContent,'Unsaved look');
});

test('a stale mount completion or disposal cannot reveal or hide another avatar panel',async()=>{
  const list=deferred(),f=uiFixture({appearance_list:()=>list.promise});
  await new Promise(resolve=>setImmediate(resolve));f.setCurrent(false);f.node('appearance-panel').hidden=false;
  list.resolve([]);const mounted=await f.mounted;mounted.dispose();
  assert.equal(f.node('appearance-panel').hidden,false);
  assert.equal(f.poll(),undefined);
});

test('a successful save followed by failed activation retries as an edit and restores controls',async()=>{
  const f=uiFixture({appearance_activate:()=>{throw Error('Activation failed');}});await f.mounted;
  f.node('appearance-name').value='Saved draft';f.node('appearance-name').oninput();
  await f.node('appearance-save').onclick();
  assert.equal(f.node('appearance-state').textContent,'Saved, not active');
  assert.equal(f.node('appearance-save').disabled,false);
  assert.equal(f.errors.at(-1).message,'Activation failed');
  await f.node('appearance-save').onclick();
  const saves=f.calls.filter(call=>call.action==='appearance_save');
  assert.equal(saves.length,2);
  assert.equal(saves[1].look_id,'look-1');
  assert.equal(saves[1].expected_revision,1);
});
