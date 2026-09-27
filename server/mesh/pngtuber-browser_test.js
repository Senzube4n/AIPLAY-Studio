import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {createPngtuberSessions} from './pngtuber.js';

const png = bytes => new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0,...bytes])], 'frame.png', {type:'image/png'});
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
let instance=0;

async function browser(t,{micDenied=false,audioDenied=false}={}) {
  let clock=0;
  const service=createPngtuberSessions({now:()=>clock}),nodes=new Map(),intervals=new Map(),timeouts=new Map(),requests=[],revoked=[];
  const pageListeners=new Map(),windowListeners=new Map(),tracks=[],contexts=[];
  let nextUrl=0,nextTimer=0,micRequests=0;
  const node=id=>{
    if(!nodes.has(id)) nodes.set(id,{hidden:id.includes('frame')||id==='pn-edit',disabled:false,
      value:id==='pn-trigger'?'0.045':'',textContent:'',className:'',title:'',src:'',dataset:id==='pn-canvas'?{talking:'false'}:{},
      listeners:new Map(),addEventListener(name,fn){this.listeners.set(name,fn);}});
    return nodes.get(id);
  };
  const media=node('pn-audio');
  Object.assign(media,{paused:true,ended:false,currentTime:0,playCalls:0,
    play(){this.playCalls++;if(audioDenied)return Promise.reject(Object.assign(new Error('Activation required'),{name:'NotAllowedError'}));this.paused=false;return Promise.resolve();},
    pause(){this.paused=true;}});
  const classes=new Set();
  const document={hidden:false,getElementById:node,body:{classList:{add:n=>classes.add(n),remove:n=>classes.delete(n),contains:n=>classes.has(n)}},
    addEventListener(name,fn){pageListeners.set(name,fn);}};
  class FakeImage {
    set src(value){this.url=value;this.naturalWidth=256;this.naturalHeight=256;}
    decode(){return Promise.resolve();}
  }
  class FakeContext {
    constructor(){this.state='suspended';this.destination={};this.closed=false;contexts.push(this);}
    createAnalyser(){return {fftSize:1024,connect(){},getFloatTimeDomainData(samples){samples.fill(0);}};}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createMediaElementSource(){return {connect(){},disconnect(){}};}
    resume(){this.state='running';return Promise.resolve();}
    suspend(){this.state='suspended';return Promise.resolve();}
    close(){this.closed=true;this.state='closed';return Promise.resolve();}
  }
  const globals={
    document,Image:FakeImage,URL:{createObjectURL(){return `blob:local-${++nextUrl}`;},revokeObjectURL:url=>revoked.push(url)},
    window:{AudioContext:FakeContext,addEventListener(name,fn){windowListeners.set(name,fn);}},
    navigator:{mediaDevices:{async getUserMedia(){micRequests++;if(micDenied)throw Object.assign(new Error('Denied'),{name:'NotAllowedError'});
      const track={stopped:false,stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track]};}}},
    fetch:async(url,init)=>{
      assert.equal(url,'/api/avatars/pngtuber');
      const body=JSON.parse(init.body);requests.push(body);
      try { const {action,...args}=body;const result=service[action](args);return {ok:true,status:200,json:async()=>result}; }
      catch(error){return {ok:false,status:error.status||500,json:async()=>({error:error.message})};}
    },
    setInterval(fn,ms){assert.equal(ms,1000);const id=++nextTimer;intervals.set(id,fn);return id;},
    clearInterval:id=>intervals.delete(id),
    setTimeout(fn,ms){const id=++nextTimer;timeouts.set(id,{fn,ms});return id;},
    clearTimeout:id=>timeouts.delete(id),
    requestAnimationFrame(fn){const id=++nextTimer;timeouts.set(id,{fn,raf:true});return id;},
    cancelAnimationFrame:id=>timeouts.delete(id),
  };
  const saved=new Map(Object.keys(globals).map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries(globals))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  t.after(()=>{
    windowListeners.get('pagehide')?.({persisted:false});
    for(const [name,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
  });
  await import(`../../web/pngtuber.js?browser=${++instance}`);
  return {node,media,service,document,classes,requests,revoked,tracks,contexts,intervals,timeouts,
    advance(ms){clock+=ms;},
    micRequests:()=>micRequests,
    async choose(id,file){await node(id).listeners.get('change')({target:{files:[file]}});await flush();},
    async click(id){await node(id).listeners.get('click')();await flush();},
    async tick(){await [...intervals.values()][0]?.();await flush();},
    fireTimeout(ms){const found=[...timeouts].find(([,row])=>row.ms===ms);assert.ok(found,`timer ${ms} exists`);timeouts.delete(found[0]);found[1].fn();},
    close(persisted=false){windowListeners.get('pagehide')?.({persisted});},
    show(persisted=false){windowListeners.get('pageshow')?.({persisted});},
  };
}

test('browser registers only with two local frames, then applies and acknowledges a preview MCP cue',async t=>{
  const f=await browser(t);
  assert.equal(f.requests.length,0);
  assert.equal(f.micRequests(),0);
  assert.equal(f.node('pn-mic').disabled,true,'capture waits for both frames');
  await f.choose('pn-idle',new File([Uint8Array.from([1,2,3,4,5,6,7,8,9,10,11,12])],'bad.png',{type:'image/png'}));
  assert.equal(f.node('pn-state').textContent,'Frame unavailable');
  assert.match(f.node('pn-detail').textContent,/Choose a PNG or WebP/);
  assert.equal(f.node('pn-detail').hidden,false);
  assert.equal(f.requests.length,0);
  await f.choose('pn-idle',png([1]));
  assert.equal(f.requests.length,0);
  await f.choose('pn-talking',png([2]));
  assert.deepEqual(f.requests.map(r=>r.action),['register','heartbeat']);
  const session_id=f.requests[0].session_id;
  assert.equal(f.node('pn-stage').disabled,false);
  assert.equal(f.node('pn-mic').disabled,false);
  assert.equal(f.service.sessions().sessions[0].status.visible,true);
  f.service.command({session_id,op:'talk',duration_ms:500});
  f.document.hidden=true;
  await f.tick();
  assert.equal(f.node('pn-canvas').dataset.talking,'false','hidden browser does not acknowledge unseen cue');
  assert.equal(f.requests.at(-1).applied_revision,0);
  f.document.hidden=false;
  await f.tick();
  assert.equal(f.node('pn-canvas').dataset.talking,'true');
  await f.click('pn-stage');
  await f.tick();
  assert.equal(f.service.sessions().sessions[0].status.staged,true);
  await f.tick();
  assert.equal(f.service.sessions().sessions[0].applied_revision,1);
  f.fireTimeout(500);
  assert.equal(f.node('pn-canvas').dataset.talking,'false');
  await f.tick();
  assert.equal(f.node('pn-canvas').dataset.talking,'false','the same cue revision does not replay');
});

test('microphone denial stays idle and releases its audio context',async t=>{
  const denied=await browser(t,{micDenied:true});
  await denied.choose('pn-idle',png([1]));await denied.choose('pn-talking',png([2]));
  await denied.click('pn-mic');
  assert.equal(denied.node('pn-state').textContent,'Mic blocked');
  assert.match(denied.node('pn-detail').textContent,/Allow microphone access/);
  assert.equal(denied.node('pn-detail').hidden,false);
  await denied.tick();
  assert.equal(denied.node('pn-state').textContent,'Mic blocked','heartbeat does not erase actionable error');
  assert.equal(denied.node('pn-canvas').dataset.talking,'false');
  assert.equal(denied.node('pn-stop').disabled,true);
  denied.close();
  assert.ok(denied.contexts[0].closed);
});

test('source swap and tab close release local resources',async t=>{
  const f=await browser(t);
  await f.choose('pn-idle',png([1]));await f.choose('pn-talking',png([2]));
  await f.click('pn-mic');
  assert.equal(f.micRequests(),1);
  assert.equal(f.tracks[0].stopped,false);
  await f.tick();
  assert.equal(f.service.sessions().sessions[0].status.source,'mic');
  await f.choose('pn-idle',png([3]));
  assert.ok(f.revoked.includes('blob:local-1'),'replaced frame URL revoked');
  await f.choose('pn-audio-file',new File([Uint8Array.from([1,2,3])],'song.wav',{type:'audio/wav'}));
  assert.equal(f.tracks[0].stopped,true,'switching to audio stops mic capture');
  assert.equal(f.media.playCalls,0,'choosing an audio file never autoplays it');
  await f.click('pn-play');
  assert.equal(f.media.playCalls,1);
  assert.equal(f.service.sessions().sessions[0].status.source,'mic','status changes only on next heartbeat');
  await f.tick();
  assert.equal(f.service.sessions().sessions[0].status.source,'audio');
  f.close();
  assert.equal(f.intervals.size,0);
  assert.ok(f.contexts[0].closed);
  assert.ok(f.revoked.includes('blob:local-2') && f.revoked.includes('blob:local-3') && f.revoked.includes('blob:local-4'));
});

test('blocked local audio requires another user click and never starts automatically',async t=>{
  const f=await browser(t,{audioDenied:true});
  await f.choose('pn-idle',png([1]));await f.choose('pn-talking',png([2]));
  await f.choose('pn-audio-file',new File([Uint8Array.from([1,2,3])],'song.wav',{type:'audio/wav'}));
  assert.equal(f.media.playCalls,0);
  await f.click('pn-play');
  assert.equal(f.media.playCalls,1);
  assert.equal(f.node('pn-state').textContent,'Audio blocked');
  assert.equal(f.node('pn-detail').hidden,false);
  await f.tick();
  assert.equal(f.media.playCalls,1,'heartbeat does not retry blocked playback');
});

test('BFCache return keeps chosen frames, stops capture and recovers an expired MCP lease',async t=>{
  const f=await browser(t);
  await f.choose('pn-idle',png([1]));await f.choose('pn-talking',png([2]));
  const session_id=f.requests[0].session_id;
  await f.click('pn-mic');
  await f.tick();
  f.service.command({session_id,op:'talk',duration_ms:500});
  await f.tick();await f.tick();
  assert.equal(f.node('pn-canvas').dataset.talking,'true');
  assert.equal(f.service.sessions().sessions[0].applied_revision,1);
  f.close(true);
  assert.equal(f.intervals.size,0);
  assert.equal(f.tracks[0].stopped,true);
  assert.equal(f.contexts[0].closed,false,'BFCache keeps the audio context reusable after another click');
  assert.equal(f.contexts[0].state,'suspended','cached pages do not keep analyzing audio');
  assert.deepEqual(f.revoked,[],'BFCache retains local frame object URLs');
  assert.equal(f.node('pn-idle-frame').src,'blob:local-1');
  assert.equal(f.node('pn-canvas').dataset.talking,'false');
  f.advance(30001);
  f.show(true);
  assert.equal(f.intervals.size,1);
  await f.tick(); // Existing browser lease expired; reset revisions after 410.
  await f.tick(); // Register a fresh lease with the same browser session ID.
  assert.deepEqual(f.requests.slice(-3).map(row=>row.action),['heartbeat','register','heartbeat']);
  assert.equal(f.service.sessions().sessions[0].revision,0);
  assert.equal(f.service.sessions().sessions[0].applied_revision,0);
  assert.equal(f.service.sessions().sessions[0].status.source,'none','mic never auto-restarts');
  assert.equal(f.node('pn-canvas').dataset.talking,'false','old cue does not replay');
  f.service.command({session_id,op:'talk',duration_ms:500});
  await f.tick();
  assert.equal(f.node('pn-canvas').dataset.talking,'true','fresh cue still works after restore');
  f.close();
  assert.ok(f.contexts[0].closed);
  assert.ok(f.revoked.includes('blob:local-1') && f.revoked.includes('blob:local-2'));
});
