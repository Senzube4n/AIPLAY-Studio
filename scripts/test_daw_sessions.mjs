/** Deferred-response regression checks against the DAW's actual functions.
 * Pass a scratch daw.js path while reviewing a patch. No browser, server,
 * project, audio, filesystem mutation or provider call occurs in this suite. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(process.argv[2] || new URL('../web/daw.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function extract(name){
  if(name==='notePointerUp'){
    const marker='canvas.addEventListener("pointerup", async (e) => {';
    const start=source.indexOf(marker),end=source.indexOf('\n});',start);
    assert(start>=0&&end>start,'Missing actual note pointerup handler');
    return 'async function notePointerUp(e) {'+source.slice(start+marker.length,end)+'\n}';
  }
  const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
  assert(start>=0,`Missing actual source function ${name}`);
  const end=source.indexOf('\n}',start);
  assert(end>start,`No end of ${name}`);
  return source.slice(start,end+2);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
const documentReply=(name)=>({project:{name,tracks:[],lengthBars:8,updatedAt:name},timeline:[],totalSeconds:8});
const regionReply=()=>({regions:[],totalSeconds:8,credits:[],rendered:1,cachedHits:0,ms:5});
function make(names,overrides={}){
  const calls={status:[],get:[],api:[],decode:[],undo:[],storage:[],draw:0};
  const S={slug:'A',projectEpoch:1,docRead:0,renderRequest:0,proj:{tracks:[],lengthBars:8},timeline:[],
    totalSeconds:8,trackId:'t',devTarget:null,lanes:[],loopB:null,rollFit:false,grid:480,sel:new Set(),
    buffers:new Map(),regions:[],sw:[],pending:[],rendering:false,playing:false,peaks:new Map(),
    ahead:{asking:false,busy:false,plan:null},wave:{open:new Set(),stems:new Map(),peaks:new Map(),busy:new Set(),note:''},
    undo:[],redo:[],aud:{seq:0},ana:{curves:new Map()},at:0};
  const nodes=new Map();
  const $=(id)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',value:'100',selectedOptions:[{textContent:'1/8'}],classList:{add(){},remove(){},contains(){return false;}}});return nodes.get(id);};
  const ctx={S,console,Map,Set,Float32Array,Promise,performance:{now:()=>10},encodeURIComponent,TPB:960,audioImportRequest:0,
    WAVE_BUCKETS:200,WAVE_REGION_CAP:16,AHEAD_REGIONS:4,DEFER_OK:new Set(),$,
    localStorage:{setItem:(key,value)=>calls.storage.push([key,value])},canvas:{},releasePointer(){},
    status:m=>calls.status.push(m),pushUndo:e=>calls.undo.push(e),
    api:async body=>{calls.api.push(body);throw new Error('Unexpected API '+body.action);},
    get:async url=>{calls.get.push(url);return documentReply(url);},
    fetch:async()=>{throw new Error('Unexpected fetch');},
    audioCtx:()=>({decodeAudioData:async bytes=>{calls.decode.push(bytes);return {decoded:true};}}),
    setTimeout:()=>0,
    refreshDoc:async()=>true,renderAndSwap:async()=>{},refreshPlan:async()=>{},swapRegion:async()=>false,
    aheadWindow:()=>({from:0,lead:4}),windowRows:r=>r||[],projTime:()=>0,
    planRegionAt:rows=>rows[0],aheadAt:()=>0,waveRegions:()=>[{fromBar:1,toBar:4}],
    loopSecs:()=>({a:0,b:8}),rowSecs:()=>0,regionPixels:()=>100,
    rowOf:()=>({ticksPerBar:3840,qLen:4,den:4}),posToQ:(bar,beat,tick)=>(bar-1)*4+beat-1+tick/960,
    barFloatNow:()=>1.5,qOfBarFloat:bar=>(bar-1)*4,
    durTicksToQ:(bar,beat,tick,dur)=>dur/960,qToPosFine:q=>({bar:Math.floor(q/4)+1,beat:q%4+1,tick:0}),
    targetNotes:()=>[],...overrides};
  for(const name of ['drawSide','drawArr','draw','drawMixer','drawDevices','drawLog','drawHistory','drawKnobs',
    'drawAutoPane','drawCredits','paintClock','paintSelInfo','fitRoll','fitArr','setLoopSilent','paintAhead',
    'paintBadge','cpu','updateHud','hotSwap','refreshWaveLanes','fetchWavePeaks','drawReturnStems','stop','auditionStop',
    'loadColours','paintLoopLabel','automatables',
    /* applyViewFromDoc paints the saved layout -- where the browser, the mixer and the
     * dock are -- onto the shell. refreshDoc calls it, and this harness lifts refreshDoc
     * out of daw.js and runs it with ONLY the names listed here, so a new call inside a
     * lifted function arrives as a bare ReferenceError with no hint that a stub is all it
     * wants. The list stays explicit rather than auto-stubbing every unknown identifier:
     * auto-stubbing would also swallow a genuinely missing dependency, which is the one
     * thing this suite exists to catch. */
    'applyViewFromDoc'])if(!ctx[name])ctx[name]=()=>name==='automatables'?[]:undefined;
  const context=vm.createContext(ctx);
  vm.runInContext('var renderChain=Promise.resolve();var liveChain=Promise.resolve();var peakJobs=new Set();\n'
    +['captureSession','sessionCurrent',...names].map(extract).join('\n'),context);
  const jump=(slug='B')=>{S.projectEpoch++;S.slug=slug;};
  return {ctx:context,S,calls,jump};
}
let count=0;
async function test(name,run){await run();count++;console.log('ok '+name);}

await test('old document cannot replace another project',async()=>{
  const d=deferred(),h=make(['refreshDoc'],{get:()=>d.promise});const p=h.ctx.refreshDoc();h.jump();d.resolve(documentReply('old'));assert.equal(await p,false);assert.equal(h.S.proj.name,undefined);
});
await test('same-slug reload invalidates the old session',async()=>{
  const d=deferred(),h=make(['refreshDoc'],{get:()=>d.promise});const p=h.ctx.refreshDoc();h.jump('A');d.resolve(documentReply('old'));assert.equal(await p,false);
});
await test('out-of-order reads within one session keep the newest request',async()=>{
  const a=deferred(),b=deferred();let n=0;const h=make(['refreshDoc'],{get:()=>++n===1?a.promise:b.promise});const pa=h.ctx.refreshDoc(),pb=h.ctx.refreshDoc();b.resolve(documentReply('new'));assert.equal(await pb,true);a.resolve(documentReply('old'));assert.equal(await pa,false);assert.equal(h.S.proj.name,'new');
});
await test('stale region fetch never starts decoding',async()=>{
  const d=deferred(),h=make(['swapRegion'],{fetch:()=>d.promise});const p=h.ctx.swapRegion({idx:0,url:'a'});h.jump();d.resolve({arrayBuffer:async()=>new ArrayBuffer(0)});assert.equal(await p,false);assert.equal(h.calls.decode.length,0);assert.equal(h.S.buffers.size,0);
});
await test('stale decoded audio never enters the buffer map',async()=>{
  const d=deferred(),h=make(['swapRegion'],{fetch:async()=>({arrayBuffer:async()=>new ArrayBuffer(0)}),audioCtx:()=>({decodeAudioData:()=>d.promise})});const p=h.ctx.swapRegion({idx:0,url:'a'});await flush();h.jump('A');d.resolve({decoded:true});assert.equal(await p,false);assert.equal(h.S.buffers.size,0);
});
await test('current decoded audio still enters the buffer map',async()=>{
  const h=make(['swapRegion'],{fetch:async()=>({arrayBuffer:async()=>new ArrayBuffer(0)})});assert.equal(await h.ctx.swapRegion({idx:3,url:'a',hash:'v1'}),true);assert.equal(h.S.buffers.get(3).hash,'v1');
});
await test('queued render captures the original project before queue execution',async()=>{
  const h=make(['renderAndSwap']);const p=h.ctx.renderAndSwap();h.jump();await p;assert.equal(h.calls.api.length,0);
});
await test('old failed render cannot clear new project pending state or show its error',async()=>{
  const d=deferred(),h=make(['renderAndSwap'],{api:()=>d.promise});const p=h.ctx.renderAndSwap();await flush();h.jump();h.S.pending=['new'];h.S.rendering=true;d.reject(new Error('old failure'));await p;assert.deepEqual(h.S.pending,['new']);assert.equal(h.S.rendering,true);assert.equal(h.calls.status.length,0);
});
await test('older render finally does not clear a newer queued render in the same session',async()=>{
  const a=deferred(),b=deferred();let n=0;const h=make(['renderAndSwap'],{api:()=>++n===1?a.promise:b.promise});const pa=h.ctx.renderAndSwap();await flush();const pb=h.ctx.renderAndSwap(undefined,undefined,['new']);a.resolve(regionReply());await pa;await flush();assert.equal(h.S.rendering,true);assert.deepEqual(h.S.pending,['new']);b.resolve(regionReply());await pb;assert.equal(h.S.rendering,false);
});
await test('old plan failure cannot clear another session asking flag',async()=>{
  const d=deferred(),h=make(['refreshPlan'],{api:()=>d.promise});const p=h.ctx.refreshPlan();h.jump();h.S.ahead={asking:true,plan:{new:true}};d.reject(new Error('old'));await p;assert.equal(h.S.ahead.asking,true);assert.equal(h.S.ahead.plan.new,true);
});
await test('old look-ahead failure cannot clear another session busy flag',async()=>{
  const d=deferred(),h=make(['aheadTick'],{api:()=>d.promise});h.S.playing=true;h.S.ahead.plan={regions:[{idx:0,hash:'a',estimatedMs:1}]};const p=h.ctx.aheadTick();h.jump();h.S.ahead={busy:true};d.reject(new Error('old'));await p;assert.equal(h.S.ahead.busy,true);assert.equal(h.calls.status.length,0);
});
await test('old edit acknowledgement does not add undo or refresh the new project',async()=>{
  const d=deferred(),h=make(['act'],{api:()=>d.promise});const p=h.ctx.act({action:'set_track',slug:'A'},{slug:'A'},'old edit');h.jump();d.resolve({dirty:[]});assert.equal(await p,null);assert.equal(h.calls.undo.length,0);assert.equal(h.calls.status.length,0);
});
await test('queued live edit does not reread the newly selected project',async()=>{
  let reads=0;const h=make(['onRemoteChange'],{refreshDoc:async()=>{reads++;}});h.ctx.onRemoteChange({slug:'A',by:'agent'});h.jump();await h.ctx.liveChain;assert.equal(reads,0);
});
await test('multi-action undo stops issuing requests after a project switch',async()=>{
  const d=deferred(),bodies=[];const h=make(['undoOnce'],{api:body=>{bodies.push(body);return d.promise;}});h.S.undo=[{bodies:[{slug:'A',action:'a'},{slug:'A',action:'b'}]}];const p=h.ctx.undoOnce();h.jump();d.resolve({});await p;assert.equal(bodies.length,1);assert.equal(h.S.redo.length,0);
});
await test('old redo rejection cannot restore an entry into the new history',async()=>{
  const d=deferred(),h=make(['redoOnce'],{api:()=>d.promise});h.S.redo=[{forward:{slug:'A',action:'a'}}];const p=h.ctx.redoOnce();h.jump();h.S.redo=[];d.reject(new Error('old'));await p;assert.equal(h.S.redo.length,0);assert.equal(h.calls.status.length,0);
});
await test('duplicate loop never adds its next note to the newly selected project',async()=>{
  const d=deferred(),bodies=[];const rows=[1,2].map(i=>({n:{id:'n'+i,bar:1,beat:i,tick:0,pitch:60,vel:100,durTicks:480}}));const h=make(['duplicateSelection'],{api:body=>{bodies.push(body);return d.promise;},targetNotes:()=>rows});const p=h.ctx.duplicateSelection();h.jump();d.resolve({note:{id:'new'}});await p;assert.equal(bodies.length,1);assert.equal(bodies[0].slug,'A');assert.equal(h.calls.undo.length,0);
});
await test('duplicate keeps original track for every addition and undo without taking the new selection',async()=>{
  const d=deferred(),bodies=[],rows=[1,2].map(i=>({n:{id:'n'+i,bar:1,beat:i,tick:0,pitch:60,vel:100,durTicks:480}}));const h=make(['duplicateSelection'],{api:body=>{bodies.push(body);return bodies.length===1?d.promise:Promise.resolve({note:{id:'second'}});},targetNotes:()=>rows});const p=h.ctx.duplicateSelection();h.S.trackId='other';h.S.sel=new Set(['other-note']);d.resolve({note:{id:'first'}});await p;assert.deepEqual(bodies.map(b=>b.track),['t','t']);assert.equal(h.calls.undo[0].bodies.every(b=>b.track==='t'&&b.slug==='A'),true);assert.equal(h.S.sel.has('other-note'),true);
});
await test('old quantize acknowledgement does not add history in another session',async()=>{
  const d=deferred(),h=make(['quantizeSelection'],{api:()=>d.promise,targetNotes:()=>[{n:{id:'n',bar:1,beat:1,tick:30}}]});const p=h.ctx.quantizeSelection();h.jump();d.resolve({undo:{}});await p;assert.equal(h.calls.undo.length,0);
});
await test('quantize already captures its one complete body before awaiting and leaves selection alone',async()=>{
  const d=deferred(),bodies=[],h=make(['quantizeSelection'],{api:body=>{bodies.push(body);return d.promise;},targetNotes:()=>[{n:{id:'n',bar:1,beat:1,tick:30}}]});const p=h.ctx.quantizeSelection();h.S.trackId='other';h.S.sel=new Set(['other-note']);d.resolve({undo:{}});await p;assert.equal(bodies.length,1);assert.equal(bodies[0].track,'t');assert.equal(h.calls.undo[0].forward.track,'t');assert.equal(h.S.sel.has('other-note'),true);
});
await test('multi-delete stops before its second request when the project changes',async()=>{
  const d=deferred(),bodies=[],rows=[1,2].map(i=>({n:{id:'n'+i,bar:1,beat:i,tick:0,pitch:60,vel:100,durTicks:480},c:{id:'c'}}));const h=make(['deleteSelection'],{api:body=>{bodies.push(body);return d.promise;},targetNotes:()=>rows});h.S.sel=new Set(['n1','n2']);const p=h.ctx.deleteSelection();h.jump();d.resolve({});await p;assert.equal(bodies.length,1);assert.equal(h.calls.undo.length,0);
});
await test('multi-delete keeps its original target when only the selected track changes',async()=>{
  const d=deferred(),bodies=[],rows=[1,2].map(i=>({n:{id:'n'+i,bar:1,beat:i,tick:0,pitch:60,vel:100,durTicks:480},c:{id:'c'}}));const h=make(['deleteSelection'],{api:body=>{bodies.push(body);return bodies.length===1?d.promise:Promise.resolve({});},targetNotes:()=>rows});h.S.sel=new Set(['n1','n2']);const p=h.ctx.deleteSelection();h.S.trackId='other';h.S.sel=new Set(['other-note']);d.resolve({});await p;assert.deepEqual(bodies.map(b=>b.track),['t','t']);assert.equal(h.S.sel.has('other-note'),true);
});
await test('split stops after the head response if its session changed',async()=>{
  const d=deferred(),bodies=[],row={n:{id:'n',bar:1,beat:1,tick:0,pitch:60,vel:100,durTicks:3840}};const h=make(['splitSelection'],{api:body=>{bodies.push(body);return d.promise;},targetNotes:()=>[row]});const p=h.ctx.splitSelection();h.jump();d.resolve({});await p;assert.equal(bodies.length,1);assert.equal(bodies[0].action,'edit_notes');assert.equal(h.calls.undo.length,0);
});
await test('old velocity response cannot enter the new undo history',async()=>{
  const d=deferred(),h=make(['commitVel'],{api:()=>d.promise,velChanges:()=>[{note:'n',vel:80}]});const p=h.ctx.commitVel({},'velocity');h.jump();d.resolve({undo:{}});await p;assert.equal(h.calls.undo.length,0);assert.equal(h.calls.status.length,0);
});
await test('old note-drag response cannot enter the new undo history',async()=>{
  const d=deferred(),h=make(['notePointerUp'],{api:()=>d.promise});h.S.drag={mode:'move',moved:true,notes:[{id:'n',bar:1,beat:2,tick:0,pitch:60,durTicks:480}],orig:[{id:'n',bar:1,beat:1,tick:0,pitch:60,durTicks:480}]};const p=h.ctx.notePointerUp({pointerId:1});h.jump();d.resolve({undo:{}});await p;assert.equal(h.calls.undo.length,0);
});
await test('old stem error cannot erase new lane state or remove its busy lock',async()=>{
  const d=deferred(),h=make(['refreshWaveLanes'],{api:()=>d.promise});h.S.wave.open.add('t');const p=h.ctx.refreshWaveLanes();h.jump();h.S.wave.note='new';h.S.wave.busy=new Set(['t']);d.reject(new Error('old'));await p;assert.equal(h.S.wave.note,'new');assert.equal(h.S.wave.busy.has('t'),true);
});
await test('old peak success cannot replace new peaks or clear their busy lock',async()=>{
  const d=deferred(),h=make(['fetchWavePeaks'],{api:()=>d.promise});h.S.wave.open.add('t');h.S.wave.stems.set('t',new Map([[0,{file:'stem'}]]));h.S.regions=[{idx:0,nSamples:100}];const p=h.ctx.fetchWavePeaks();h.jump();h.S.wave.peaks.set('stem',{new:true});h.S.wave.busy=new Set(['stem']);d.resolve({old:true});await p;assert.equal(h.S.wave.peaks.get('stem').new,true);assert.equal(h.S.wave.busy.has('stem'),true);
});
await test('same-named take in a new session has an independent peak job',async()=>{
  const a=deferred(),b=deferred();let n=0;const h=make(['loadPeaks'],{fetch:()=>++n===1?a.promise:b.promise});const pa=h.ctx.loadPeaks('take.wav');h.jump();const pb=h.ctx.loadPeaks('take.wav');assert.equal(n,2);a.reject(new Error('old'));await pa;assert.equal(h.S.peaks.size,0);assert.equal(h.ctx.peakJobs.size,1);b.reject(new Error('current'));await pb;assert.equal(h.ctx.peakJobs.size,0);assert.equal(h.S.peaks.size,1);
});
await test('loadProject itself bumps epoch for same-slug reload and discards the first continuation',async()=>{
  const a=deferred(),b=deferred();let n=0;const h=make(['loadProject'],{refreshDoc:()=>++n===1?a.promise:b.promise,api:async()=>({credits:[]})});const pa=h.ctx.loadProject('A'),pb=h.ctx.loadProject('A');assert.equal(h.S.projectEpoch,3);assert.equal(h.S.aud.seq,2);a.resolve(true);assert.equal(await pa,false);assert.equal(h.calls.storage.length,0);b.resolve(true);assert.equal(await pb,true);assert.equal(h.calls.status.length,1);assert.deepEqual(h.calls.storage,[['daw.lastProject','A']]);
});

console.log(`${count} session-race checks passed against extracted DAW source; no live project touched.`);
